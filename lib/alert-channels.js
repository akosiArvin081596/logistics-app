"use strict";
// ===========================================================================
// PER-CHANNEL DELIVERY FOR THE *_alerts DEDUPE LEDGERS
//
// An alert goes out by two channels: an email and an in-app dispatch
// notification. The ledgers used to stamp alerted_at as soon as EITHER went
// out, so an email that failed was never retried once the in-app notice went
// in. This is the shape ratecon_reissue_holds took in #505, shared by
// eld_feed_alerts, invoice_undated_alerts, ratecon_extract_alerts and
// expense_duplicate_alerts:
//
//   emailed_at / notified_at       when that channel went out;
//   email_skipped / notify_skipped why that channel is owed nothing more:
//                                  "no_recipient" (the email: no mailbox is
//                                  configured, mailbox()), "gave_up" (the other
//                                  channel went out and this one was still
//                                  undelivered RETRY_WINDOW_MS later),
//                                  "weekly_summary" (invoice_undated_alerts: the
//                                  weekly invoice summary printed the load),
//                                  "before_tracking" (alerted before these
//                                  columns existed: which channel told a person
//                                  wasn't recorded, so both are done);
//   claimed_at                     the call sending a row holds it, so two
//                                  overlapping calls never both send (a claim
//                                  older than CLAIM_STALE_MS, from a call that
//                                  died, can be retaken);
//   attempts / first_try / last_try the row's tries, for the backoff.
//
// alerted_at keeps its meaning: when a person was first told, by either
// channel. Each alert still stamps it itself. A row still owes a channel when
// that channel was neither sent nor skipped (OWES_SQL). A row alerted with
// neither channel stamped was told before the channels were tracked and owes
// nothing (TRACKED_SQL); ensureColumns() marks those rows "before_tracking",
// so adding the columns re-arms no historical alert.
//
// GIVING UP (the owner's decision, 2026-10-14): only the second channel of an
// alert a person was already told about (alerted_at set) is given up, once
// RETRY_WINDOW_MS has passed since then. A row nothing was ever delivered for
// is never given up: it keeps retrying, on its alert's schedule or the backoff
// below, for as long as its condition lasts, as these alerts always did.
//
// The columns are added at boot (prepareLedger()). The ledger is tracked once
// every column exists, even if marking the earlier rows fails (they owe nothing
// either way). If a column can't be added, that is logged once and the ledger
// keeps its old rule (alerted once either channel goes out): every function
// here, owesRow() included, then answers as if nothing were tracked, so an
// alert that worked before still goes out, once.
//
// It never sends anything itself: the caller hands sendOwed() its own email and
// notification functions. It writes only the ledger table it is given. Table
// and column names are the caller's constants, checked against IDENT_RE.
// ===========================================================================

const RETRY_WINDOW_MS = 48 * 60 * 60 * 1000;
// A row tried by the shared retry sweep waits 15 min after its first try, then
// 30 min, 1 h and 2 h after each later one, then every 4 h. Alerts that ride
// their own sweep (hourly, six-hourly) retry on it.
const RETRY_BACKOFF_MS = [15, 30, 60, 120, 240].map((min) => min * 60 * 1000);
const CLAIM_STALE_MS = 15 * 60 * 1000;
const SWEEP_MS = 15 * 60 * 1000;

const COLUMNS = [
	["emailed_at", "TEXT"], ["notified_at", "TEXT"], ["email_skipped", "TEXT"], ["notify_skipped", "TEXT"],
	["claimed_at", "TEXT"], ["attempts", "INTEGER"], ["first_try", "TEXT"], ["last_try", "TEXT"],
];
const OWES_SQL = "((notified_at IS NULL AND notify_skipped IS NULL) OR (emailed_at IS NULL AND email_skipped IS NULL))";
const TRACKED_SQL = "NOT (alerted_at IS NOT NULL AND emailed_at IS NULL AND notified_at IS NULL)";
const CHANNEL = {
	email: { sent: "emailed_at", skipped: "email_skipped" },
	inApp: { sent: "notified_at", skipped: "notify_skipped" },
};
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function ident(name) {
	if (!IDENT_RE.test(String(name))) throw new Error(`alert-channels: not a table or column name: ${JSON.stringify(name)}`);
	return name;
}

// The mailbox the alerts write to (GMAIL_USER), or "" when mail is not
// configured (no GMAIL_USER or no GMAIL_APP_PASSWORD): then the email is
// skipped as "no_recipient", never owed and retried.
function mailbox(env) {
	const user = String((env && env.GMAIL_USER) || "").trim();
	const pass = String((env && env.GMAIL_APP_PASSWORD) || "").trim();
	return user && pass ? user : "";
}

// The channel columns (and `extra`, [[name, type]]) `table` still lacks.
function missingColumns(db, table, extra = []) {
	ident(table);
	const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
	if (!have.size) throw new Error(`no table ${table}`);
	return [...COLUMNS, ...extra].filter(([col]) => !have.has(col));
}

// Adds the channel columns (and `extra`) to `table` when they are missing.
// Throws on failure. Only db.prepare() is used; a column another process added
// first is not an error.
function addColumns(db, table, extra = []) {
	for (const [col, type] of missingColumns(db, table, extra)) {
		try {
			db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ident(col)} ${type}`).run();
		} catch (e) {
			if (!/duplicate column/i.test(String(e && e.message))) throw e;
		}
	}
}

// Marks rows alerted before the channels were tracked as owing nothing
// ("before_tracking"). Until it runs, owes() and TRACKED_SQL already read such
// a row (alerted, no channel stamped) as done; this makes it explicit.
function markBeforeTracking(db, table) {
	db.prepare(`UPDATE ${ident(table)} SET email_skipped = 'before_tracking', notify_skipped = 'before_tracking'
		WHERE alerted_at IS NOT NULL AND emailed_at IS NULL AND notified_at IS NULL AND email_skipped IS NULL AND notify_skipped IS NULL`).run();
}

// Both, throwing on any failure (prepareLedger() is the caller's form).
function ensureColumns(db, table, extra = []) {
	addColumns(db, table, extra);
	markBeforeTracking(db, table);
}

// Once per database handle and table: adds the columns and marks the earlier
// rows, and answers whether the ledger is tracked. server.js calls it at boot;
// an alert calls it again and gets the answer. The ledger is tracked once every
// column exists, even when the marking fails (it runs again at the next start).
// Columns that can't be added are logged once, and the ledger keeps its old rule.
const state = new WeakMap();
function prepareLedger(db, table, extra = [], log = console) {
	let tables = state.get(db);
	if (!tables) { tables = new Map(); state.set(db, tables); }
	if (tables.has(table)) return tables.get(table);
	let ok = false;
	try {
		addColumns(db, table, extra);
		ok = true;
	} catch (e) {
		try { ok = missingColumns(db, table, extra).length === 0; } catch { ok = false; }
		if (!ok) log.error(`[alert-channels] ${table}: the per-channel columns could not be added (${e && e.message}); it keeps the old rule (alerted once either channel goes out)`);
	}
	if (ok) {
		try {
			markBeforeTracking(db, table);
		} catch (e) {
			log.error(`[alert-channels] ${table}: rows alerted before the channels were tracked were not marked before_tracking (${e && e.message}); they owe nothing all the same, and are marked at the next start`);
		}
	}
	tables.set(table, ok);
	return ok;
}
function ready(db, table) {
	const tables = state.get(db);
	return !!tables && tables.get(table) === true;
}

// The SQL test for "owes a channel" on `table`: the per-channel rule, or the
// old one (never alerted) when the ledger is not tracked.
function owesSql(db, table) {
	return ready(db, table) ? `${OWES_SQL} AND ${TRACKED_SQL}` : "alerted_at IS NULL";
}

// What a ledger row still owes: { email, inApp }, or null when nothing.
function owes(row) {
	if (!row) return null;
	if (row.alerted_at && !row.emailed_at && !row.notified_at) return null;
	const email = !row.emailed_at && !row.email_skipped;
	const inApp = !row.notified_at && !row.notify_skipped;
	return email || inApp ? { email, inApp } : null;
}

// owes() on a tracked ledger; on one that is not, the old rule: a row alerted
// owes nothing, one never alerted owes both channels.
function owesRow(db, table, row) {
	if (!row) return null;
	if (ready(db, table)) return owes(row);
	return row.alerted_at ? null : { email: true, inApp: true };
}

// Whether the channel a row still owes is to be given up at nowMs: a person was
// told by the other channel (alerted_at) at least RETRY_WINDOW_MS ago. A row
// nothing was delivered for never is.
function expired(row, nowMs) {
	const told = Date.parse((row && row.alerted_at) || "");
	return Number.isFinite(told) && told + RETRY_WINDOW_MS <= nowMs;
}

// Whether a row's next retry slot has come at nowMs (a row never tried is due;
// the wait stops growing at the last step).
function retryDue(row, nowMs) {
	if (!row.last_try || !(row.attempts > 0)) return true;
	const wait = RETRY_BACKOFF_MS[Math.min(row.attempts, RETRY_BACKOFF_MS.length) - 1];
	return Date.parse(row.last_try) + wait <= nowMs;
}

// Claims a row for one call when it still owes a channel and no live call holds
// it, and counts the try. Answers { email, inApp, claimedAt }, or null. On a
// ledger that is not tracked, both channels, unclaimed (the old rule).
function claim(db, table, keyCol, key, now = new Date()) {
	if (!ready(db, table)) return { email: true, inApp: true, claimedAt: null };
	const at = now.toISOString();
	const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
	const row = db.prepare(`UPDATE ${ident(table)} SET claimed_at = ?, attempts = COALESCE(attempts, 0) + 1,
		first_try = COALESCE(first_try, ?), last_try = ?
		WHERE ${ident(keyCol)} = ? AND ${OWES_SQL} AND ${TRACKED_SQL} AND (claimed_at IS NULL OR claimed_at < ?)
		RETURNING alerted_at, emailed_at, notified_at, email_skipped, notify_skipped`).get(at, at, at, key, stale);
	const owed = owes(row);
	return owed ? { ...owed, claimedAt: at } : null;
}

// Counts a try of a row a sweep reached but did not send (its load is left out
// for now), so the row follows the backoff instead of being due every tick;
// never a row a live call holds. Answers whether the row was counted.
function noteTry(db, table, keyCol, key, now = new Date()) {
	if (!ready(db, table)) return false;
	const at = now.toISOString();
	const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
	return db.prepare(`UPDATE ${ident(table)} SET attempts = COALESCE(attempts, 0) + 1, first_try = COALESCE(first_try, ?), last_try = ?
		WHERE ${ident(keyCol)} = ? AND (claimed_at IS NULL OR claimed_at < ?)`).run(at, at, key, stale).changes > 0;
}

function release(db, table, keyCol, key, claimedAt) {
	if (!ready(db, table) || !claimedAt) return;
	db.prepare(`UPDATE ${ident(table)} SET claimed_at = NULL WHERE ${ident(keyCol)} = ? AND claimed_at = ?`).run(key, claimedAt);
}

// A re-opened row (a new episode of a standing condition) owes both channels
// again: every channel column is cleared, when `cond` (the caller's constant
// SQL on the row) holds.
function reset(db, table, keyCol, key, cond = "1") {
	if (!ready(db, table)) return;
	db.prepare(`UPDATE ${ident(table)} SET ${COLUMNS.map(([c]) => `${c} = NULL`).join(", ")} WHERE ${ident(keyCol)} = ? AND (${cond})`).run(key);
}

// Records that `channel` ("email" or "inApp") went out for the row.
function stampSent(db, table, keyCol, key, channel, at = new Date().toISOString()) {
	if (!ready(db, table)) return;
	const col = CHANNEL[channel].sent;
	db.prepare(`UPDATE ${ident(table)} SET ${col} = ? WHERE ${ident(keyCol)} = ? AND ${col} IS NULL`).run(at, key);
}

// Records why `channel` is owed nothing more; answers whether it was still owed.
function stampSkipped(db, table, keyCol, key, channel, why) {
	if (!ready(db, table)) return false;
	const c = CHANNEL[channel];
	return db.prepare(`UPDATE ${ident(table)} SET ${c.skipped} = ? WHERE ${ident(keyCol)} = ? AND ${c.sent} IS NULL AND ${c.skipped} IS NULL`)
		.run(why, key).changes > 0;
}

// Gives up what a row a person was already told about still owes, unless a live
// call holds it (its send may still land); answers which channels were given up.
function giveUp(db, table, keyCol, key, now = new Date()) {
	if (!ready(db, table)) return { email: false, inApp: false };
	const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
	const one = (channel) => {
		const c = CHANNEL[channel];
		return db.prepare(`UPDATE ${ident(table)} SET ${c.skipped} = 'gave_up' WHERE ${ident(keyCol)} = ? AND alerted_at IS NOT NULL
			AND ${c.sent} IS NULL AND ${c.skipped} IS NULL AND (claimed_at IS NULL OR claimed_at < ?)`).run(key, stale).changes > 0;
	};
	return { email: one("email"), inApp: one("inApp") };
}

// Rows a retry sweep should look at (`where`: the caller's constant SQL on the
// row): tried before, still owing a channel, held by no live claim; split into
// those to give up and those whose next slot has come. None on a ledger that is
// not tracked.
function retryCandidates(db, table, { now = new Date(), where = "1" } = {}) {
	if (!ready(db, table)) return { expired: [], due: [] };
	const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
	const rows = db.prepare(`SELECT * FROM ${ident(table)} WHERE first_try IS NOT NULL AND ${OWES_SQL} AND ${TRACKED_SQL}
		AND (claimed_at IS NULL OR claimed_at < ?) AND (${where})`).all(stale);
	const nowMs = now.getTime();
	return {
		expired: rows.filter((r) => expired(r, nowMs)),
		due: rows.filter((r) => !expired(r, nowMs) && retryDue(r, nowMs)),
	};
}

// Sends what a claimed row owes, through the caller's own channels: `email`
// (async, true only when the mail was handed over; null when there is no
// mailbox, so the email is skipped as "no_recipient") and `inApp` (throws on
// failure). The email goes first, as these alerts always sent it. Each channel
// is stamped as soon as it went out, and the claim is released however this
// ends. Never throws for a send.
async function sendOwed({ db, table, keyCol, key, owed, email, inApp, log = console, tag = "[alert]" }) {
	let emailed = false;
	let notified = false;
	let skipped = false;
	try {
		if (owed.email && typeof email !== "function") {
			stampSkipped(db, table, keyCol, key, "email", "no_recipient");
			skipped = true;
		} else if (owed.email) {
			try { emailed = (await email()) === true; } catch (e) { log.error(`${tag} alert email failed:`, e && e.message); }
			if (emailed) stampSent(db, table, keyCol, key, "email");
		}
		if (owed.inApp) {
			try { await inApp(); notified = true; } catch (e) { log.error(`${tag} notification failed:`, e && e.message); }
			if (notified) stampSent(db, table, keyCol, key, "inApp");
		}
	} finally {
		release(db, table, keyCol, key, owed.claimedAt);
	}
	const emailFailed = owed.email && !skipped && !emailed;
	const inAppFailed = owed.inApp && !notified;
	return {
		emailed, notified, emailFailed, inAppFailed,
		emailState: channelState(owed.email, emailed, skipped ? "skipped (no mailbox configured)" : ""),
		inAppState: channelState(owed.inApp, notified, ""),
	};
}

// One channel's outcome for a log line.
function channelState(wasOwed, sent, skipped) {
	if (!wasOwed) return "not owed";
	if (sent) return "sent";
	return skipped || "FAILED (retried later)";
}

module.exports = {
	RETRY_WINDOW_MS,
	RETRY_BACKOFF_MS,
	CLAIM_STALE_MS,
	SWEEP_MS,
	COLUMNS,
	OWES_SQL,
	TRACKED_SQL,
	mailbox,
	ensureColumns,
	prepareLedger,
	ready,
	owesSql,
	owes,
	owesRow,
	expired,
	retryDue,
	claim,
	noteTry,
	release,
	reset,
	stampSent,
	stampSkipped,
	giveUp,
	retryCandidates,
	sendOwed,
	channelState,
};
