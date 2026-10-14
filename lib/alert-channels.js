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
//                                  "no_recipient" (the email), "gave_up" (still
//                                  undelivered RETRY_WINDOW_MS after the first
//                                  try), "weekly_summary" (invoice_undated_alerts:
//                                  the weekly invoice summary printed the load),
//                                  "before_tracking" (alerted before these
//                                  columns existed: which channel told a person
//                                  wasn't recorded, so both are done);
//   claimed_at                     the call sending a row holds it, so two
//                                  overlapping calls never both send (a claim
//                                  older than CLAIM_STALE_MS, from a call that
//                                  died, can be retaken);
//   attempts / first_try / last_try the row's tries: the retry window runs from
//                                  first_try, the backoff from last_try.
//
// alerted_at keeps its meaning: when a person was first told, by either
// channel. Each alert still stamps it itself. A row still owes a channel when
// that channel was neither sent nor skipped (OWES_SQL). A row alerted with
// neither channel stamped was told before the channels were tracked and owes
// nothing (TRACKED_SQL); ensureColumns() marks those rows "before_tracking",
// so adding the columns re-arms no historical alert.
//
// It never sends anything itself: the caller hands sendOwed() its own email and
// notification functions. It writes only the ledger table it is given. Table
// and column names are the caller's constants, checked against IDENT_RE.
// ===========================================================================

const RETRY_WINDOW_MS = 48 * 60 * 60 * 1000;
// A row tried by the shared retry sweep waits 15 min after its first try, then
// 30 min, 1 h and 2 h after each later one, then every 4 h (about 15 tries in
// 48 h). Alerts that ride their own sweep (hourly, six-hourly) retry on it.
const RETRY_BACKOFF_MS = [15, 30, 60, 120, 240].map((min) => min * 60 * 1000);
const CLAIM_STALE_MS = 15 * 60 * 1000;
const SWEEP_MS = 15 * 60 * 1000;

const COLUMNS = [
	["emailed_at", "TEXT"], ["notified_at", "TEXT"], ["email_skipped", "TEXT"], ["notify_skipped", "TEXT"],
	["claimed_at", "TEXT"], ["attempts", "INTEGER"], ["first_try", "TEXT"], ["last_try", "TEXT"],
];
const OWES_SQL = "((notified_at IS NULL AND notify_skipped IS NULL) OR (emailed_at IS NULL AND email_skipped IS NULL))";
const TRACKED_SQL = "NOT (alerted_at IS NOT NULL AND emailed_at IS NULL AND notified_at IS NULL)";
// A new episode of a standing condition (a resolved row that re-opens) owes
// both channels again.
const RESET_SQL = COLUMNS.map(([c]) => `${c} = NULL`).join(", ");
const CHANNEL = {
	email: { sent: "emailed_at", skipped: "email_skipped" },
	inApp: { sent: "notified_at", skipped: "notify_skipped" },
};
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function ident(name) {
	if (!IDENT_RE.test(String(name))) throw new Error(`alert-channels: not a table or column name: ${JSON.stringify(name)}`);
	return name;
}

// The SET clause that resets every channel column when `cond` (SQL on the row
// as it was) holds, for an UPSERT that re-opens a resolved row.
function resetWhenSql(cond) {
	return COLUMNS.map(([c]) => `${c} = CASE WHEN ${cond} THEN NULL ELSE ${c} END`).join(",\n\t\t\t\t\t");
}

// Adds the channel columns (and `extra`, [[name, type]]) to `table` when they
// are missing, and marks rows alerted before the columns existed as owing
// nothing ("before_tracking"). Once per database handle and table. Only
// db.prepare() is used; a column another process added first is not an error.
const ready = new WeakMap();
function ensureColumns(db, table, extra = []) {
	let done = ready.get(db);
	if (!done) { done = new Set(); ready.set(db, done); }
	if (done.has(table)) return;
	ident(table);
	const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
	for (const [col, type] of [...COLUMNS, ...extra]) {
		if (have.has(col)) continue;
		try {
			db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ident(col)} ${type}`).run();
		} catch (e) {
			if (!/duplicate column/i.test(String(e && e.message))) throw e;
		}
	}
	db.prepare(`UPDATE ${table} SET email_skipped = 'before_tracking', notify_skipped = 'before_tracking'
		WHERE alerted_at IS NOT NULL AND emailed_at IS NULL AND notified_at IS NULL AND email_skipped IS NULL AND notify_skipped IS NULL`).run();
	done.add(table);
}

// What a ledger row still owes: { email, inApp }, or null when nothing.
function owes(row) {
	if (!row) return null;
	if (row.alerted_at && !row.emailed_at && !row.notified_at) return null;
	const email = !row.emailed_at && !row.email_skipped;
	const inApp = !row.notified_at && !row.notify_skipped;
	return email || inApp ? { email, inApp } : null;
}

// Whether a row tried before is past its retry window at nowMs.
function expired(row, nowMs) {
	const first = Date.parse((row && row.first_try) || "");
	return Number.isFinite(first) && first + RETRY_WINDOW_MS <= nowMs;
}

// Whether a row's next retry slot has come at nowMs (a row never tried is due).
function retryDue(row, nowMs) {
	if (!row.last_try || !(row.attempts > 0)) return true;
	const wait = RETRY_BACKOFF_MS[Math.min(row.attempts, RETRY_BACKOFF_MS.length) - 1];
	return Date.parse(row.last_try) + wait <= nowMs;
}

// Claims a row for one call when it still owes a channel and no live call holds
// it, and counts the try. Answers { email, inApp, claimedAt }, or null.
function claim(db, table, keyCol, key, now = new Date()) {
	const at = now.toISOString();
	const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
	const row = db.prepare(`UPDATE ${ident(table)} SET claimed_at = ?, attempts = COALESCE(attempts, 0) + 1,
		first_try = COALESCE(first_try, ?), last_try = ?
		WHERE ${ident(keyCol)} = ? AND ${OWES_SQL} AND ${TRACKED_SQL} AND (claimed_at IS NULL OR claimed_at < ?)
		RETURNING alerted_at, emailed_at, notified_at, email_skipped, notify_skipped`).get(at, at, at, key, stale);
	const owed = owes(row);
	return owed ? { ...owed, claimedAt: at } : null;
}

function release(db, table, keyCol, key, claimedAt) {
	db.prepare(`UPDATE ${ident(table)} SET claimed_at = NULL WHERE ${ident(keyCol)} = ? AND claimed_at = ?`).run(key, claimedAt);
}

// Records that `channel` ("email" or "inApp") went out for the row.
function stampSent(db, table, keyCol, key, channel, at = new Date().toISOString()) {
	const col = CHANNEL[channel].sent;
	db.prepare(`UPDATE ${ident(table)} SET ${col} = ? WHERE ${ident(keyCol)} = ? AND ${col} IS NULL`).run(at, key);
}

// Records why `channel` is owed nothing more; answers whether it was still owed.
function stampSkipped(db, table, keyCol, key, channel, why) {
	const c = CHANNEL[channel];
	return db.prepare(`UPDATE ${ident(table)} SET ${c.skipped} = ? WHERE ${ident(keyCol)} = ? AND ${c.sent} IS NULL AND ${c.skipped} IS NULL`)
		.run(why, key).changes > 0;
}

// Gives up whatever the row still owes; answers which channels were given up.
function giveUp(db, table, keyCol, key) {
	return {
		email: stampSkipped(db, table, keyCol, key, "email", "gave_up"),
		inApp: stampSkipped(db, table, keyCol, key, "inApp", "gave_up"),
	};
}

// Rows a retry sweep should look at (`where`: the caller's constant SQL on the
// row): tried before, still owing a channel, held by no live claim; split into
// those past the retry window and those whose next slot has come.
function retryCandidates(db, table, { now = new Date(), where = "1" } = {}) {
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
// recipient, so the email is skipped as "no_recipient") and `inApp` (throws on
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
		emailState: channelState(owed.email, emailed, skipped ? "skipped (no recipient)" : ""),
		inAppState: channelState(owed.inApp, notified, ""),
	};
}

// One channel's outcome for a log line.
function channelState(wasOwed, sent, skipped) {
	if (!wasOwed) return "not owed";
	if (sent) return "sent";
	return skipped || `FAILED (retried for ${Math.round(RETRY_WINDOW_MS / 3600000)} h after the first try)`;
}

module.exports = {
	RETRY_WINDOW_MS,
	RETRY_BACKOFF_MS,
	CLAIM_STALE_MS,
	SWEEP_MS,
	COLUMNS,
	OWES_SQL,
	TRACKED_SQL,
	RESET_SQL,
	resetWhenSql,
	ensureColumns,
	owes,
	expired,
	retryDue,
	claim,
	release,
	stampSent,
	stampSkipped,
	giveUp,
	retryCandidates,
	sendOwed,
	channelState,
};
