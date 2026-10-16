"use strict";
// ===========================================================================
// THE DAILY INTEGRITY CHECK — read-only watchers over Job Tracking and app.db,
// run by server.js every day at 8:00 AM on the business clock (APP_TIMEZONE,
// US Eastern) and by scripts/integrity-check.js --print by hand.
//
//   1. a load whose Pickup Appointment became blank after having a value;
//   2. a load whose Assigned Date changed after it was first set;
//   3. a NEW Assigned Date written by n8n (a new load, or a changed value since
//      the previous run) that is not in Eastern time;
//   4. an approved receipt on no invoice, submitted more than 7 days ago;
//   5. a load whose Job Tracking Payment changed after its invoice was drafted
//      (2026-10-13; see invoicedPaymentChanges()).
//   6. a re-issued rate con alert that was given up undelivered: a
//      ratecon_reissue_holds row whose email or in-app notification was still
//      owed when its retry window ran out (email_skipped / notify_skipped
//      "gave_up"; see givenUpReissueAlerts()). Read only; each row is named
//      once (integrity_check_reissue_gave_up).
//   7. only while the ledger day-once rule is on (LEDGER_DAY_ONCE_ENABLED and a
//      FROM month): a driver-day the rule decides against a closed month's
//      settled record, when that month's live figures have moved since it
//      closed (lib/ledger-day-once.js unsettledDays()): a day left out of an
//      open month that the closed month never paid, or a day an open month pays
//      that the closed month already paid. Report only: no figure changes. Each
//      driver-day is named once (integrity_check_day_once, created the first
//      time one is named); with the rule off the check does not run.
//   8. a driver's weekly invoice billed at a daily rate that differs from that
//      driver's daily rate in the drivers directory (2026-10-14: "until the
//      owner answers, any invoice whose daily rate differs from the driver's
//      directory rate is flagged"; see invoiceRateMismatches()). Report only:
//      no invoice or rate changes. Each invoice is named once for the two
//      rates it was named with (integrity_check_invoice_rates). Under the
//      daily-rate rule (DRIVER_RATE_ONLY, lib/driver-rate-only.js), a week
//      reaching its FROM month is compared day by day: each grid day the rule
//      prices against the driver's own rate, else the $250 default.
//
// Checks 1 and 2 need memory: the job keeps a table of its own,
// integrity_check_loads (load id, the Pickup Appointment and Assigned Date it
// last saw, first and last seen), and check 4 its reported list,
// integrity_check_receipts. Those two tables are the ONLY things it writes, in
// one transaction after a completed run: never the sheet, an invoice, a payout
// or any other row. The first run records every
// load and reports nothing for checks 1-3 (a baseline, said in its log line).
// Each change is reported once: the state then holds the new value. Job
// Tracking is read through the caller's reader (getJobTrackingCached() in
// server.js, whose object is shared and is never mutated here).
//
// CHECK 3, AND WHY IT USES THE EMAIL'S OWN DATE HEADER. n8n's JOB DETAILS ENTRY
// node writes Assigned Date as
//   new Date($('Email Input').item.json.date).toLocaleString('en-US', { timeZone: 'America/New_York' })
// ("10/6/2026, 9:21:43 AM"), the rate-con email's Date header on a wall clock
// with no zone; until 2026-10-09 the zone was America/Chicago. The wall clock
// alone cannot say which zone wrote it. The Drive archive's createdTime is when
// n8n RAN, not when the email was sent: measured on 95 executions it trails the
// Date header by 23-312 s, but an n8n outage or a replay delays it by any
// amount, and a delay of about an hour reads exactly like Central time. The
// Date header is what n8n formatted, so a stamp is compared with each inbound
// rate-con email's Date header, TO THE SECOND: equal to its Eastern wall clock
// is fine; equal to it at another US or UTC offset (CANDIDATE_OFFSETS_MIN) is
// reported, with the offset and how far from Eastern it is; neither, or both
// (one email's Eastern time and another's offset time), is "unmatched" (counted
// in the log line, never reported). The mailbox is read like
// reconcileRateCons() reads it (EXAMINE and BODY.PEEK, inbound mail only), back
// to the previous run. Only stamps of n8n's shape are checked: the app's own
// stamp (appStamp(), "10/09/2026 9:21:43") and date-only values are not n8n's.
//
// CHECK 4 leaves out receipts booked (EXPENSE_PERIOD_EXPR, passed in by the
// caller) to a closed month (period_locks 'locked'): closed months are final as
// recorded and their data problems are not raised (product decision,
// 2026-10-02). A reopened month is open. "On an invoice" is any invoice row not
// soft-deleted, whatever its status. There is no approval stamp on a receipt, so
// its age is from when it was submitted (created_at). Each receipt is named
// once: a completed run adds the receipts it named to integrity_check_receipts
// (a dedupe ledger like the app's *_alerts tables), and later runs count those
// still open in one line (no ids). A receipt that comes to qualify later (a late
// approval, an invoice deleted later, a month reopened) is named on the next
// run. The count alone sends no email.
//
// Email: one per run with findings, through the caller's sendEmail, to the one
// inbox the caller names (ADMIN_NOTIFY_EMAIL); unset, nothing is sent and the
// log line says so. A failed send records nothing, so the run is repeated
// (dailyTicker() retries after 15 minutes, at most 3 times a day) and nothing
// is lost. A clean run logs exactly one line.
// ===========================================================================

const appTime = require("./app-time");
// The amount reading the re-issue hold in server.js uses too (one rule, not a copy).
const { moneyCents } = require("./cell-compare");
const ledgerDayOnce = require("./ledger-day-once");
// The daily-rate rule's default (check 8 under DRIVER_RATE_ONLY).
const { DEFAULT_DAILY_RATE } = require("./driver-rate-only");

const STATE_TABLE = "integrity_check_loads";
// Check 4's reported list, a dedupe ledger like the app's *_alerts tables: every
// receipt a recorded run named. Clearing it names them all again.
const RECEIPTS_TABLE = "integrity_check_receipts";
// Check 5's reported list, the same kind of ledger: each load, invoice and
// Payment (its cents, as text) a recorded run named. A further change to the
// amount is a new row, so it is named again; the same amount written another
// way is not.
const PAYMENTS_TABLE = "integrity_check_invoiced_payments";
// Check 6's reported list, the same kind of ledger: each given-up re-issue
// alert row (load, column, sent value: ratecon_reissue_holds's key) a recorded
// run named.
const REISSUE_GAVE_UP_TABLE = "integrity_check_reissue_gave_up";
// Check 7's reported list, the same kind of ledger: each driver-day (owner,
// driver, day, kind) a recorded run named. Created only when the first one is
// named, so with the day-once rule off the database gains no table.
const DAY_ONCE_TABLE = "integrity_check_day_once";
// Check 8's reported list, the same kind of ledger: each weekly invoice with the
// invoice rate and the directory rate (cents) a recorded run named it with. A
// new rate on either side is a new row, so it is named again.
const INVOICE_RATES_TABLE = "integrity_check_invoice_rates";
// server.js's re-issue alert ledger, read only.
const REISSUE_HOLDS_TABLE = "ratecon_reissue_holds";
const RUN_HOUR = 8;
const RECEIPT_DAYS = 7;
const RETRY_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const LIST_MAX = 50;
const DAY_MS = 86400000;

// The UTC offsets (minutes) a non-Eastern n8n stamp could have been written at:
// UTC (n8n's server clock when no timeZone is given) and the US zones' standard
// and daylight offsets, -5 h (Central daylight, n8n's zone until 2026-10-09) to
// -10 h. Offsets, not zone names: nothing in lib/ names a zone but the business
// one (scripts/test-app-timezone-switch.js), and an offset is what a wall clock
// and an instant together can prove.
const CANDIDATE_OFFSETS_MIN = [0, -300, -360, -420, -480, -540, -600];

// --- the state table ---------------------------------------------------------

function hasTable(db, name) {
	return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function ensureStateTable(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
			load_id TEXT PRIMARY KEY,
			pickup_appointment TEXT NOT NULL DEFAULT '',
			assigned_date TEXT NOT NULL DEFAULT '',
			first_seen_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${RECEIPTS_TABLE} (
			expense_id INTEGER PRIMARY KEY,
			reported_at TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${PAYMENTS_TABLE} (
			load_id TEXT NOT NULL,
			invoice_id TEXT NOT NULL DEFAULT '',
			sheet_payment TEXT NOT NULL,
			reported_at TEXT NOT NULL,
			PRIMARY KEY (load_id, invoice_id, sheet_payment)
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${REISSUE_GAVE_UP_TABLE} (
			load_id TEXT NOT NULL,
			column_name TEXT NOT NULL,
			sent_value TEXT NOT NULL,
			reported_at TEXT NOT NULL,
			PRIMARY KEY (load_id, column_name, sent_value)
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${INVOICE_RATES_TABLE} (
			invoice_id INTEGER NOT NULL,
			invoice_rate_cents INTEGER NOT NULL,
			directory_rate_cents INTEGER NOT NULL,
			reported_at TEXT NOT NULL,
			PRIMARY KEY (invoice_id, invoice_rate_cents, directory_rate_cents)
		)
	`);
}

// Check 8's key for an invoice named with its two rates.
function invoiceRateKey(invoiceId, invoiceCents, directoryCents) {
	return [Number(invoiceId), invoiceCents, directoryCents].join("\u0000");
}

// Check 8's reported keys; empty when the table does not exist yet.
function readReportedInvoiceRates(db) {
	if (!hasTable(db, INVOICE_RATES_TABLE)) return new Set();
	return new Set(db.prepare(`SELECT invoice_id, invoice_rate_cents, directory_rate_cents FROM ${INVOICE_RATES_TABLE}`).all()
		.map((r) => invoiceRateKey(r.invoice_id, r.invoice_rate_cents, r.directory_rate_cents)));
}

// Check 7's key for a driver-day finding.
function dayOnceKey(f) {
	return [Number(f.ownerId) || 0, f.driver, f.day, f.kind].join("\u0000");
}

// Check 7's reported keys; empty when the table does not exist yet.
function readReportedDayOnce(db) {
	if (!hasTable(db, DAY_ONCE_TABLE)) return new Set();
	return new Set(db.prepare(`SELECT owner_id, driver, day, kind FROM ${DAY_ONCE_TABLE}`).all()
		.map((r) => dayOnceKey({ ownerId: r.owner_id, driver: r.driver, day: r.day, kind: r.kind })));
}

// Check 6's reported keys (load key, column, sent value).
function readReportedGaveUp(db) {
	if (!hasTable(db, REISSUE_GAVE_UP_TABLE)) return new Set();
	return new Set(db.prepare(`SELECT load_id, column_name, sent_value FROM ${REISSUE_GAVE_UP_TABLE}`).all()
		.map((r) => [r.load_id, r.column_name, r.sent_value].join("\u0000")));
}

// Check 5's reported keys (load key, invoice id, Payment in cents as text, or a
// cell that is no amount as its text).
function readReportedPayments(db) {
	if (!hasTable(db, PAYMENTS_TABLE)) return new Set();
	return new Set(db.prepare(`SELECT load_id, invoice_id, sheet_payment FROM ${PAYMENTS_TABLE}`).all()
		.map((r) => [r.load_id, r.invoice_id, r.sheet_payment].join("\u0000")));
}

// The receipt ids recorded runs named; empty when the table does not exist yet.
function readReported(db) {
	if (!hasTable(db, RECEIPTS_TABLE)) return new Set();
	return new Set(db.prepare(`SELECT expense_id FROM ${RECEIPTS_TABLE}`).all().map((r) => Number(r.expense_id)));
}

// Map load key -> its state row; empty when the table does not exist yet (the
// CLI never creates it).
function readState(db) {
	const out = new Map();
	if (!hasTable(db, STATE_TABLE)) return out;
	for (const r of db.prepare(`SELECT load_id, pickup_appointment, assigned_date, first_seen_at, last_seen_at FROM ${STATE_TABLE}`).all()) {
		out.set(r.load_id, r);
	}
	return out;
}

// When the last completed run recorded its loads (ISO), or null.
function lastRunAt(db) {
	if (!hasTable(db, STATE_TABLE)) return null;
	const r = db.prepare(`SELECT MAX(last_seen_at) AS t FROM ${STATE_TABLE}`).get();
	return (r && r.t) || null;
}

// A completed run's record, in one transaction: the loads' values, the receipts,
// the invoiced Payments, the given-up re-issue alerts, the day-once
// driver-days and the invoice daily rates it named.
function commitState(db, loads, nowIso, reportedIds = [], reportedPayments = [], reportedGaveUp = [], reportedDayOnce = [], reportedRates = []) {
	const markReported = db.prepare(`INSERT OR IGNORE INTO ${RECEIPTS_TABLE} (expense_id, reported_at) VALUES (?, ?)`);
	const markPayment = db.prepare(`INSERT OR IGNORE INTO ${PAYMENTS_TABLE} (load_id, invoice_id, sheet_payment, reported_at) VALUES (?, ?, ?, ?)`);
	const markGaveUp = db.prepare(`INSERT OR IGNORE INTO ${REISSUE_GAVE_UP_TABLE} (load_id, column_name, sent_value, reported_at) VALUES (?, ?, ?, ?)`);
	const markRate = db.prepare(`INSERT OR IGNORE INTO ${INVOICE_RATES_TABLE} (invoice_id, invoice_rate_cents, directory_rate_cents, reported_at) VALUES (?, ?, ?, ?)`);
	const upsert = db.prepare(`
		INSERT INTO ${STATE_TABLE} (load_id, pickup_appointment, assigned_date, first_seen_at, last_seen_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(load_id) DO UPDATE SET
			pickup_appointment = excluded.pickup_appointment,
			assigned_date = excluded.assigned_date,
			last_seen_at = excluded.last_seen_at
	`);
	db.transaction(() => {
		for (const l of loads) upsert.run(l.key, l.pickup, l.assigned, nowIso, nowIso);
		for (const id of reportedIds) markReported.run(id, nowIso);
		for (const p of reportedPayments) markPayment.run(p.loadKey, p.invoiceId, p.nowKey, nowIso);
		for (const g of reportedGaveUp) markGaveUp.run(g.loadId, g.column, g.sent, nowIso);
		for (const m of reportedRates) markRate.run(m.invoiceId, m.invoiceCents, m.directoryCents, nowIso);
		if (reportedDayOnce.length) {
			db.exec(`
				CREATE TABLE IF NOT EXISTS ${DAY_ONCE_TABLE} (
					owner_id INTEGER NOT NULL,
					driver TEXT NOT NULL,
					day TEXT NOT NULL,
					kind TEXT NOT NULL,
					month TEXT NOT NULL,
					reported_at TEXT NOT NULL,
					PRIMARY KEY (owner_id, driver, day, kind)
				)
			`);
			const markDayOnce = db.prepare(`INSERT OR IGNORE INTO ${DAY_ONCE_TABLE} (owner_id, driver, day, kind, month, reported_at) VALUES (?, ?, ?, ?, ?, ?)`);
			for (const f of reportedDayOnce) markDayOnce.run(Number(f.ownerId) || 0, f.driver, f.day, f.kind, f.month, nowIso);
		}
	})();
}

// --- Job Tracking ------------------------------------------------------------

// A load's key the way deduplicateLoads() keys it.
function loadKey(id) {
	return String(id == null ? "" : id).trim().toLowerCase().replace(/^#/, "");
}

function cellText(v) {
	return String(v == null ? "" : v).trim();
}

function columnOf(headers, exact, loose) {
	return headers.find((h) => exact.test(String(h || "").trim())) || headers.find((h) => loose.test(String(h || "")));
}

// [{ key, id, pickup, assigned }] from { headers, data } (parseSheet() rows),
// the bottom row of a repeated load id winning as in deduplicateLoads(). A read
// without the three columns throws: a renamed header must stop the run, not
// report every load as blanked.
function jobTrackingLoads(jt) {
	const headers = (jt && jt.headers) || [];
	const idCol = headers.find((h) => /load.?id|job.?id/i.test(h));
	const puCol = columnOf(headers, /^pickup appointment$/i, /pick.?up.*appo/i);
	const adCol = columnOf(headers, /^assigned date$/i, /assigned.*date|date.*assigned/i);
	const missing = [[idCol, "Load ID"], [puCol, "Pickup Appointment"], [adCol, "Assigned Date"]].filter(([c]) => !c).map(([, n]) => n);
	if (missing.length) throw new Error(`Job Tracking has no ${missing.join(", ")} column`);
	const byKey = new Map();
	for (const row of (jt && jt.data) || []) {
		const id = cellText(row[idCol]);
		const key = loadKey(id);
		if (!key) continue;
		byKey.set(key, { key, id, pickup: cellText(row[puCol]), assigned: cellText(row[adCol]) });
	}
	return [...byKey.values()];
}

// Checks 1 and 2 against the state; newStamps are the Assigned Dates that are
// new since the previous run (check 3's candidates).
function compareLoads(state, loads) {
	const baseline = state.size === 0;
	const pickupBlanked = [];
	const assignedChanged = [];
	const newStamps = [];
	if (!baseline) {
		for (const l of loads) {
			const prev = state.get(l.key);
			if (!prev) {
				if (l.assigned) newStamps.push(l);
				continue;
			}
			if (prev.pickup_appointment && !l.pickup) pickupBlanked.push({ ...l, was: prev.pickup_appointment, firstSeenAt: prev.first_seen_at });
			if (prev.assigned_date && l.assigned !== prev.assigned_date) assignedChanged.push({ ...l, was: prev.assigned_date, firstSeenAt: prev.first_seen_at });
			if (l.assigned && l.assigned !== prev.assigned_date) newStamps.push(l);
		}
	}
	return { baseline, pickupBlanked, assignedChanged, newStamps };
}

// --- check 3 -----------------------------------------------------------------

// toLocaleString('en-US') with a zone: "10/6/2026, 9:21:43 AM" (newer ICU puts a
// narrow no-break space before AM/PM). Bounded quantifiers: sheet text.
const N8N_STAMP_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s{1,3}(\d{1,2}):(\d{2}):(\d{2})\s{0,3}([AaPp][Mm])$/;

function n8nStampParts(text) {
	const m = N8N_STAMP_RE.exec(String(text == null ? "" : text).slice(0, 40).trim());
	if (!m) return null;
	const h12 = Number(m[4]);
	if (h12 < 1 || h12 > 12) return null;
	const pm = /^p/i.test(m[7]);
	return { year: Number(m[3]), month: Number(m[1]), day: Number(m[2]), hour: (h12 % 12) + (pm ? 12 : 0), minute: Number(m[5]), second: Number(m[6]) };
}

const wallFormatters = new Map();
function wallClock(ms, timeZone) {
	let f = wallFormatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone, year: "numeric", month: "numeric", day: "numeric",
			hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
		});
		wallFormatters.set(timeZone, f);
	}
	const p = {};
	for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
	return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
}

function sameWallClock(a, b) {
	return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

function emailInstant(email) {
	const ms = Date.parse(String((email && email.date) || "").slice(0, 200).replace(/^Date:\s*/i, ""));
	return Number.isFinite(ms) ? ms : null;
}

function wallClockAsUtcMs(p) {
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function offsetText(min) {
	const a = Math.abs(min);
	return `UTC${min < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

// { ok, wrong, unmatched, notN8n }: each stamp ({ id, assigned }) compared with
// each email's Date header, to the second. The stamp read as UTC, minus an
// email's instant, is the offset it was written at: the business zone's own at
// that instant (the email's Eastern wall clock), or one of
// CANDIDATE_OFFSETS_MIN. Only Eastern matches: ok. Only other offsets: wrong.
// Both (two emails exactly that far apart, so which one n8n used is unknown),
// or neither: unmatched.
function classifyStamps(stamps, emails, { appZone = appTime.appTimeZone() } = {}) {
	const instants = [...new Set((emails || []).map(emailInstant).filter((ms) => ms !== null))];
	const out = { ok: [], wrong: [], unmatched: [], notN8n: 0 };
	for (const s of stamps) {
		const parts = n8nStampParts(s.assigned);
		if (!parts) { out.notN8n++; continue; }
		const eastern = instants.some((ms) => sameWallClock(wallClock(ms, appZone), parts));
		const stampMs = wallClockAsUtcMs(parts);
		let hit = null;
		for (const ms of instants) {
			const offsetMin = (stampMs - ms) / 60000;
			if (!CANDIDATE_OFFSETS_MIN.includes(offsetMin)) continue;
			const appOffsetMin = (wallClockAsUtcMs(wallClock(ms, appZone)) - ms) / 60000;
			if (offsetMin === appOffsetMin) continue;
			if (!hit || Math.abs(offsetMin - appOffsetMin) < Math.abs(hit.offsetMin - hit.appOffsetMin)) hit = { ms, offsetMin, appOffsetMin };
		}
		if (eastern && !hit) { out.ok.push(s); continue; }
		if (eastern) { out.unmatched.push({ ...s, ambiguous: true }); continue; }
		if (!hit) { out.unmatched.push(s); continue; }
		const hours = (hit.appOffsetMin - hit.offsetMin) / 60;
		out.wrong.push({
			...s,
			offset: offsetText(hit.offsetMin),
			hoursBehind: hours,
			label: `${offsetText(hit.offsetMin)}, ${Math.abs(hours)} hour${Math.abs(hours) === 1 ? "" : "s"} ${hours > 0 ? "behind" : "ahead of"} Eastern`,
			emailAt: new Date(hit.ms).toISOString(),
			eastern: new Date(hit.ms).toLocaleString("en-US", { timeZone: appZone }),
		});
	}
	return out;
}

// How far back the mailbox is read: since the previous run, plus two days of
// slack (IMAP SINCE is a date), between 2 and 14 days.
function mailboxDays(previousRunAt, now) {
	const last = previousRunAt ? Date.parse(previousRunAt) : NaN;
	const days = Number.isFinite(last) ? Math.ceil((now.getTime() - last) / DAY_MS) + 2 : 2;
	return Math.max(2, Math.min(14, days));
}

async function checkStampZones(newStamps, readRateConEmails, { appZone, sinceDays }) {
	const candidates = newStamps.filter((s) => n8nStampParts(s.assigned));
	const base = { checked: candidates.length, ok: [], wrong: [], unmatched: [], skipped: null };
	if (!candidates.length) return base;
	if (typeof readRateConEmails !== "function") return { ...base, skipped: "no rate-con mailbox to read (GMAIL_USER / GMAIL_APP_PASSWORD not set)" };
	let emails;
	try {
		emails = await readRateConEmails({ sinceDays });
	} catch (e) {
		return { ...base, skipped: `rate-con mailbox unreadable (${String((e && e.message) || e).slice(0, 200)})` };
	}
	const c = classifyStamps(candidates, emails, { appZone });
	return { ...base, ok: c.ok, wrong: c.wrong, unmatched: c.unmatched };
}

// The mailbox reader for check 3: the rate-con label, read-only (EXAMINE and
// BODY.PEEK in lib/ratecon-reconcile.js), inbound mail only. null without an
// account, so check 3 says it was skipped.
function rateConEmailReader({ user, pass, mailbox, timeoutMs = 2 * 60 * 1000 } = {}) {
	if (!user || !pass) return null;
	return async ({ sinceDays }) => {
		const { fetchRateConSubjects, splitSelfSent } = require("./ratecon-reconcile");
		const fetched = await fetchRateConSubjects({ user, pass, ...(mailbox ? { mailbox } : {}), sinceDays, timeoutMs });
		return splitSelfSent(fetched, user).inbound;
	};
}

// --- check 4 -----------------------------------------------------------------

// Approved receipts on no live invoice, submitted more than `days` ago, not
// booked to a closed month. Each is named ONCE: `stale` holds those not on the
// reported list (`reported`, ids a recorded run named), and `reportedOpen` counts
// those on it that still qualify. However a receipt comes to qualify (a late
// approval, an invoice deleted later, a month reopened), it is named on the next
// run.
function staleApprovedReceipts(db, { now, expensePeriodExpr, days = RECEIPT_DAYS, reported = new Set() } = {}) {
	if (!expensePeriodExpr) throw new Error("staleApprovedReceipts needs the expense month rule (EXPENSE_PERIOD_EXPR)");
	const onInvoice = new Set();
	let unreadableInvoices = 0;
	for (const r of db.prepare("SELECT expense_ids FROM invoices WHERE COALESCE(deleted_at, '') = ''").all()) {
		let ids = null;
		try { ids = JSON.parse(r.expense_ids || "[]"); } catch { ids = null; }
		if (!Array.isArray(ids)) { unreadableInvoices++; continue; }
		for (const x of ids) onInvoice.add(Number(x));
	}
	const locked = new Set(hasTable(db, "period_locks")
		? db.prepare("SELECT period FROM period_locks WHERE status = 'locked'").all().map((r) => r.period)
		: []);
	const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
	const rows = db.prepare(`
		SELECT id, type, amount, date, created_at, ${expensePeriodExpr} AS period
		FROM expenses
		WHERE status = 'Approved' AND julianday(created_at) < julianday(?)
		ORDER BY id
	`).all(cutoff);
	const stale = [];
	let reportedOpen = 0;
	for (const r of rows) {
		if (onInvoice.has(Number(r.id)) || locked.has(r.period)) continue;
		if (reported.has(Number(r.id))) { reportedOpen++; continue; }
		stale.push({
			id: r.id, type: r.type, amount: r.amount, date: r.date, createdAt: r.created_at, period: r.period,
			days: Math.floor((now.getTime() - sqliteUtcMs(r.created_at)) / DAY_MS),
		});
	}
	return { stale, reportedOpen, unreadableInvoices };
}

// --- check 5 -----------------------------------------------------------------

// Check 5: a load whose Job Tracking Payment differs from the sheet's own figure
// when its latest invoice was drafted (load_invoice_drafts.sheet_total, the
// highest id). Invoice edits are invoice-only (product decision), so the draft's
// sheet_total, not its total, is what the books read at that moment. A draft
// with no sheet_total can't be compared (counted). A load whose accounting months
// include a closed one is never raised: closed months are final as recorded.
// `closedMonthsOf(headers, row)` is the caller's rule (server.js:
// loadRowAccountingMonths() and the period locks) and answers the row's closed
// months, or null when that can't be told: a date that can't be placed, or a
// lock table that can't be read. Closed and untold loads are counted, not
// raised, and the log line and the notes give both counts. Without that rule or
// the drafts table the check is skipped, and the run says so. Amounts are read
// by moneyCents() (lib/cell-compare.js), as the re-issue hold reads them.
function invoicedPaymentChanges(db, jt, { closedMonthsOf = null, reported = new Set() } = {}) {
	const out = { changes: [], reportedOpen: 0, noSheetTotal: 0, closed: 0, unknownMonth: 0, skipped: "" };
	if (!hasTable(db, "load_invoice_drafts")) { out.skipped = "the database has no invoice drafts table"; return out; }
	const cols = db.prepare("PRAGMA table_info(load_invoice_drafts)").all().map((c) => c.name);
	if (!cols.includes("sheet_total")) { out.skipped = "invoice drafts record no sheet total"; return out; }
	if (typeof closedMonthsOf !== "function") { out.skipped = "no closed-month rule was given"; return out; }
	const headers = (jt && jt.headers) || [];
	const idCol = headers.find((h) => /load.?id|job.?id/i.test(h));
	const payCol = columnOf(headers, /^payment$/i, /^\s*payment\s*$/i);
	if (!idCol || !payCol) { out.skipped = "Job Tracking has no Load ID or Payment column"; return out; }
	const rows = new Map();
	for (const row of (jt && jt.data) || []) {
		const k = loadKey(row[idCol]);
		if (k) rows.set(k, row);
	}
	const latest = new Map();
	for (const d of db.prepare("SELECT id, load_id, invoice_id, sheet_total, created_at FROM load_invoice_drafts ORDER BY id").all()) {
		const k = loadKey(d.load_id);
		if (k) latest.set(k, d);
	}
	for (const [k, d] of latest) {
		const row = rows.get(k);
		if (!row) continue;
		const invoiced = moneyCents(d.sheet_total);
		if (invoiced === null) { out.noSheetTotal++; continue; }
		const nowCents = moneyCents(row[payCol]);
		if (nowCents === invoiced) continue;
		const closed = closedMonthsOf(headers, row);
		if (closed === null) { out.unknownMonth++; continue; }
		if (closed.length) { out.closed++; continue; }
		const now = cellText(row[payCol]);
		// The ledger keys the Payment by its cents, so the same amount written
		// another way is not named again; a cell that is no amount keys by its text.
		const nowKey = nowCents === null ? now : String(nowCents);
		const invoiceId = cellText(d.invoice_id);
		if (reported.has([k, invoiceId, nowKey].join("\u0000"))) { out.reportedOpen++; continue; }
		out.changes.push({ loadKey: k, id: cellText(row[idCol]), invoiceId, invoiced: cellText(d.sheet_total), now, nowKey, draftedAt: cellText(d.created_at) });
	}
	return out;
}

// --- check 6 -----------------------------------------------------------------

// Check 6: re-issued rate con alerts given up undelivered. server.js's
// ratecon_reissue_holds (read only) tracks each channel of an alert; a row whose
// email or in-app notification was still owed when its retry window ran out is
// marked "gave_up" on that channel, so no person may ever have been told. Each
// row (load, column, sent value) is named once: `reported` holds the rows a
// recorded run named. Grouped by load, with its columns and the channels given
// up. A database without that ledger, or with one older than its channel
// columns, has none.
function givenUpReissueAlerts(db, { reported = new Set() } = {}) {
	const out = { loads: [], rows: [] };
	if (!hasTable(db, REISSUE_HOLDS_TABLE)) return out;
	const cols = new Set(db.prepare(`PRAGMA table_info(${REISSUE_HOLDS_TABLE})`).all().map((c) => c.name));
	if (!cols.has("email_skipped") || !cols.has("notify_skipped")) return out;
	const label = cols.has("load_label") ? "load_label" : "NULL AS load_label";
	const byLoad = new Map();
	for (const r of db.prepare(`SELECT load_id, ${label}, column_name, sent_value, first_seen, email_skipped, notify_skipped
		FROM ${REISSUE_HOLDS_TABLE} WHERE email_skipped = 'gave_up' OR notify_skipped = 'gave_up'
		ORDER BY load_id, first_seen, column_name, sent_value`).all()) {
		if (reported.has([r.load_id, r.column_name, r.sent_value].join("\u0000"))) continue;
		out.rows.push({ loadId: r.load_id, column: r.column_name, sent: r.sent_value });
		if (!byLoad.has(r.load_id)) byLoad.set(r.load_id, { id: cellText(r.load_label) || r.load_id, columns: [], email: false, inApp: false, firstSeen: r.first_seen });
		const l = byLoad.get(r.load_id);
		if (!l.columns.includes(r.column_name)) l.columns.push(r.column_name);
		if (r.email_skipped === "gave_up") l.email = true;
		if (r.notify_skipped === "gave_up") l.inApp = true;
	}
	out.loads = [...byLoad.values()];
	return out;
}

// --- check 7 -----------------------------------------------------------------

// Check 7, only while the ledger day-once rule is on (`fromMonth`, the server's
// LEDGER_DAY_ONCE_FROM through lib/ledger-day-once.js ruleFromEnv(); null with
// the rule off, and then nothing runs and nothing is said). It reads the payout
// ledger through the caller's readFleetLedger() (computeFleetLedger() in
// server.js) and the closed months' frozen items, and names each driver-day
// lib/ledger-day-once.js unsettledDays() finds, once: `reported` holds those a
// recorded run named. A ledger that can't be computed or closed months that
// can't be read skip the check, and the run says so; the other checks still run.
async function dayOnceUnsettledDays(db, { fromMonth = null, readFleetLedger = null, reported = new Set() } = {}) {
	const out = { checked: false, days: [], reportedOpen: 0, skipped: "" };
	if (!fromMonth) return out;
	out.checked = true;
	if (typeof readFleetLedger !== "function") { out.skipped = "the payout ledger was not given"; return out; }
	const closed = ledgerDayOnce.closedMonths(db);
	if (!closed) { out.skipped = "the closed months can't be read"; return out; }
	let fleet;
	try {
		fleet = await readFleetLedger();
	} catch (e) {
		out.skipped = `the payout ledger could not be computed (${shown((e && e.message) || e, 120)})`;
		return out;
	}
	for (const f of ledgerDayOnce.unsettledDays({ fromMonth, scopes: fleet && fleet.scopes, frozen: ledgerDayOnce.frozenDriverDays(db), closed })) {
		if (reported.has(dayOnceKey(f))) out.reportedOpen++;
		else out.days.push(f);
	}
	return out;
}

// --- check 8 -----------------------------------------------------------------

// The driver key server.js looks pay structures up by (normalizeDriverName()):
// trimmed, lower case, every whitespace run one space. The caller may pass its
// own; scripts/test-integrity-invoice-rate.js pins this one to server.js's.
function defaultDriverKey(name) {
	return String(name == null ? "" : name).trim().toLowerCase().replace(/\s+/g, " ");
}

// A week date's month, range-checked as invoiceMonthLockBlockers() checks it in
// server.js ("2026-13" is no month); null when it can't be read.
const INVOICE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function invoiceWeekMonth(day) {
	const m = String(day == null ? "" : day).trim().slice(0, 7);
	return INVOICE_MONTH_RE.test(m) ? m : null;
}

function rateCents(v) {
	const n = Number(v);
	return v !== null && v !== "" && Number.isFinite(n) ? Math.round(n * 100) : null;
}

// A daily-rate weekly invoice's snapshot with its day grid, or null (an
// owner-operator's, one that records no pay type, one that can't be read).
function daySnapshot(text) {
	let snap = null;
	try { snap = JSON.parse(text || "{}"); } catch { snap = null; }
	return snap && typeof snap === "object" && snap.__templateName === "service_invoice" && snap.days && typeof snap.days === "object" ? snap : null;
}

// Under the daily-rate rule: the paid grid days of invoice row `r` (its week
// from week_start, Saturday to Friday) whose pay month the rule prices and whose
// amount differs from the rule's rate (the directory's rate, else the $250
// default): { invoiceCents (the first such day's), directoryCents (the rule's),
// days, defaultRate }, or null when none differs.
const GRID_DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
function ruleDayMismatch(r, snap, directoryRate, rule) {
	const startMs = Date.parse(`${String(r.week_start).slice(0, 10)}T12:00:00Z`);
	if (!Number.isFinite(startMs)) return null;
	const ruleCents = rateCents(directoryRate > 0 ? directoryRate : DEFAULT_DAILY_RATE);
	const days = [];
	let invoiceCents = null;
	for (let i = 0; i < 7; i++) {
		const at = new Date(startMs + i * 86400000);
		const day = at.toISOString().slice(0, 10);
		const cell = snap.days[GRID_DAYS[(at.getUTCDay() + 1) % 7]] || {};
		if (!cell.completed) continue;
		const loads = String(cell.loadBol || "").split(",").map((x) => x.trim()).filter(Boolean);
		if (!rule.appliesTo(rule.payMonthOf(day, loads))) continue;
		const c = rateCents(cell.total);
		if (c === null || c === ruleCents) continue;
		if (invoiceCents === null) invoiceCents = c;
		days.push(day);
	}
	return days.length ? { invoiceCents, directoryCents: ruleCents, days, defaultRate: !(directoryRate > 0) } : null;
}

// Check 8: a live weekly invoice (not deleted, not a manual or correction
// invoice) billed at a daily rate (rate_per_load) that differs from the
// driver's daily rate in the drivers directory (pay_daily, the first row by id
// under the driver's key, as getDriverPayStructures() picks it in server.js).
//   - Only daily-rate invoices: an owner-operator's (render_data template
//     service_invoice_owner_op) carries his percentage in rate_per_load and is
//     never compared. One that differs but records no template (older rows)
//     can't be told to be a daily rate: counted, not raised.
//   - A driver with no directory row, or a directory rate not set (0), has no
//     rate to differ from: the invoice was priced from the truck's rate or the
//     default, which is what the directory leaving it blank means.
//   - Closed months are final as recorded: an invoice whose week touches a
//     closed month (period_locks 'locked', week_start or week_end, as
//     invoiceMonthLockBlockers() reads a week) is counted, not raised; so is one
//     whose week date or the lock table can't be read.
// Each invoice is named once for its two rates: `reported` holds those a
// recorded run named. Reads only.
//
// `dailyRateRule` (the server's driverRateOnlyDayRule(), null while the
// daily-rate rule is off): { from, appliesTo(month), payMonthOf(day, loadIds) }.
// A weekly invoice whose week ends in FROM's month or later is compared day by
// day instead of by rate_per_load alone: each paid grid day whose pay month the
// rule prices (payMonthOf(): its loads' Assigned month, else its own) against
// the driver's directory rate, else the $250 default (a driver with no rate of
// his own is compared too). The days the rule does not price are not compared.
// The first differing day's amount is the invoice rate named.
function invoiceRateMismatches(db, { reported = new Set(), driverKey = defaultDriverKey, dailyRateRule = null } = {}) {
	const out = { mismatches: [], reportedOpen: 0, closed: 0, unknownMonth: 0, noPayType: 0, skipped: "" };
	if (!hasTable(db, "invoices")) { out.skipped = "the database has no invoices table"; return out; }
	const cols = new Set(db.prepare("PRAGMA table_info(invoices)").all().map((c) => c.name));
	if (!["driver", "week_start", "week_end", "rate_per_load", "render_data"].every((c) => cols.has(c))) {
		out.skipped = "invoices record no daily rate";
		return out;
	}
	if (!hasTable(db, "drivers_directory")) { out.skipped = "the database has no drivers directory"; return out; }
	const dirCols = new Set(db.prepare("PRAGMA table_info(drivers_directory)").all().map((c) => c.name));
	if (!dirCols.has("driver_name") || !dirCols.has("pay_daily")) { out.skipped = "the drivers directory has no daily rate column"; return out; }
	const directory = new Map();
	for (const r of db.prepare("SELECT driver_name, pay_daily FROM drivers_directory ORDER BY id ASC").all()) {
		const k = driverKey(r.driver_name);
		if (k && !directory.has(k)) directory.set(k, Math.max(0, Number(r.pay_daily) || 0));
	}
	let locked = null;
	try {
		if (hasTable(db, "period_locks")) locked = new Set(db.prepare("SELECT period FROM period_locks WHERE status = 'locked'").all().map((r) => r.period));
	} catch {
		locked = null;
	}
	const live = [
		cols.has("deleted_at") ? "COALESCE(deleted_at, '') = ''" : "",
		cols.has("is_manual") ? "COALESCE(is_manual, 0) = 0" : "",
		cols.has("is_correction") ? "COALESCE(is_correction, 0) = 0" : "",
	].filter(Boolean);
	const rows = db.prepare(`SELECT id, invoice_number, driver, week_start, week_end, status, rate_per_load, render_data FROM invoices
		${live.length ? `WHERE ${live.join(" AND ")}` : ""} ORDER BY id`).all();
	const ruleWeek = (r) => !!dailyRateRule && invoiceWeekMonth(r.week_start) !== null && invoiceWeekMonth(r.week_end) !== null
		&& invoiceWeekMonth(r.week_end) >= String(dailyRateRule.from || "");
	for (const r of rows) {
		const directoryRate = directory.get(driverKey(r.driver)) || 0;
		const ruleSnap = ruleWeek(r) ? daySnapshot(r.render_data) : null;
		if (ruleSnap) {
			const hit = ruleDayMismatch(r, ruleSnap, directoryRate, dailyRateRule);
			if (!hit) continue;
			const months = [invoiceWeekMonth(r.week_start), invoiceWeekMonth(r.week_end)];
			if (locked === null || months.includes(null)) { out.unknownMonth++; continue; }
			if (months.some((m) => locked.has(m))) { out.closed++; continue; }
			if (reported.has(invoiceRateKey(r.id, hit.invoiceCents, hit.directoryCents))) { out.reportedOpen++; continue; }
			out.mismatches.push({
				invoiceId: r.id, invoiceNumber: cellText(r.invoice_number), driver: cellText(r.driver),
				weekStart: cellText(r.week_start), weekEnd: cellText(r.week_end), status: cellText(r.status),
				invoiceCents: hit.invoiceCents, directoryCents: hit.directoryCents, days: hit.days, defaultRate: hit.defaultRate,
			});
			continue;
		}
		if (!(directoryRate > 0)) continue;
		// The rates first: most invoices bill the directory's rate, and those need
		// no snapshot read at all.
		const invoiceCents = rateCents(r.rate_per_load);
		const directoryCents = rateCents(directoryRate);
		if (invoiceCents === null || invoiceCents === directoryCents) continue;
		let snap = null;
		try { snap = JSON.parse(r.render_data || "{}"); } catch { snap = null; }
		const template = snap && typeof snap === "object" ? snap.__templateName : undefined;
		if (template === "service_invoice_owner_op") continue;
		const months = [invoiceWeekMonth(r.week_start), invoiceWeekMonth(r.week_end)];
		if (locked === null || months.includes(null)) { out.unknownMonth++; continue; }
		if (months.some((m) => locked.has(m))) { out.closed++; continue; }
		if (template !== "service_invoice") { out.noPayType++; continue; }
		if (reported.has(invoiceRateKey(r.id, invoiceCents, directoryCents))) { out.reportedOpen++; continue; }
		out.mismatches.push({
			invoiceId: r.id, invoiceNumber: cellText(r.invoice_number), driver: cellText(r.driver),
			weekStart: cellText(r.week_start), weekEnd: cellText(r.week_end), status: cellText(r.status),
			invoiceCents, directoryCents,
		});
	}
	return out;
}

// created_at is CURRENT_TIMESTAMP ("2026-10-08 20:43:33", UTC with no zone) or
// an ISO string; either way an instant.
function sqliteUtcMs(text) {
	const s = String(text || "").trim();
	return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
}

// --- the report --------------------------------------------------------------

function escapeHtml(s) {
	return String(s == null ? "" : s)
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function shown(v, max = 80) {
	const t = String(v == null ? "" : v).slice(0, 400).replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}
function quoted(v) { return v ? `"${shown(v)}"` : "blank"; }
function money(n) { return Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : ""; }

function buildReport({ now, appZone, baseline, loadsSeen, cmp, zone, receipts, payments = { changes: [], reportedOpen: 0, noSheetTotal: 0, closed: 0, unknownMonth: 0, skipped: "" }, reissueGaveUp = { loads: [], rows: [] }, dayOnce = { checked: false, days: [], reportedOpen: 0, skipped: "" }, invoiceRates = { mismatches: [], reportedOpen: 0, closed: 0, unknownMonth: 0, noPayType: 0, skipped: "" } }) {
	const sections = [];
	if (cmp.pickupBlanked.length) {
		sections.push({
			title: "Pickup Appointment became blank",
			lines: cmp.pickupBlanked.map((l) => `Load ${shown(l.id, 40)}: Pickup Appointment was ${quoted(l.was)} and is now blank.`),
		});
	}
	if (cmp.assignedChanged.length) {
		sections.push({
			title: "Assigned Date changed after it was set",
			lines: cmp.assignedChanged.map((l) => `Load ${shown(l.id, 40)}: Assigned Date changed from ${quoted(l.was)} to ${quoted(l.assigned)}.`),
		});
	}
	if (zone.wrong.length) {
		sections.push({
			title: "Assigned Date not in Eastern time",
			lines: zone.wrong.map((w) => `Load ${shown(w.id, 40)}: Assigned Date ${quoted(w.assigned)} is the rate-con email's time at ${w.label}; in Eastern it is "${w.eastern}".`),
		});
	}
	if (receipts.stale.length) {
		sections.push({
			title: `Approved receipts on no invoice for more than ${RECEIPT_DAYS} days`,
			lines: receipts.stale.map((r) => `Receipt #${r.id}: ${shown(r.type, 30) || "receipt"} ${money(r.amount)}, dated ${shown(r.date, 20) || "(no date)"}, submitted ${r.days} days ago, booked to ${shown(r.period, 10)}; on no invoice.`),
		});
	}
	if (payments.changes.length) {
		sections.push({
			title: "Payment changed after invoicing",
			lines: payments.changes.map((c) => `Load ${shown(c.id, 40)}: invoiced at ${shown(c.invoiced, 20)} (invoice ${shown(c.invoiceId, 30) || "with no number"}, drafted ${shown(c.draftedAt, 25)}); its Job Tracking Payment is now ${quoted(c.now)}.`),
		});
	}
	if (reissueGaveUp.loads.length) {
		// first_seen is an instant, ISO or SQLite's UTC "YYYY-MM-DD HH:MM:SS".
		const seenText = (t) => {
			const ms = sqliteUtcMs(t);
			return Number.isFinite(ms) ? `; first seen ${appTime.dateTextInZone(new Date(ms), appZone)}` : "";
		};
		sections.push({
			title: "Re-issued rate con alerts given up undelivered",
			lines: reissueGaveUp.loads.map((l) => `Load ${shown(l.id, 40)}: the alert about its re-issued rate con (${l.columns.map((c) => shown(c, 40)).join(", ")}) ` +
				`was given up with ${[l.email ? "the email" : "", l.inApp ? "the in-app notification" : ""].filter(Boolean).join(" and ")} never delivered${seenText(l.firstSeen)}.`),
		});
	}
	if (dayOnce.days.length) {
		const load = (id) => (id ? `load ${shown(id, 40)}` : "an admin-added day");
		sections.push({
			title: "Driver-days the ledger day-once rule decides against a closed month's settled record",
			lines: dayOnce.days.map((f) => (f.kind === "dropped"
				? `${f.day}, driver ${shown(f.driver, 40)} (owner ${f.ownerId}): left out of ${f.month} (${load(f.loadId)}) because ${f.otherMonth}'s live figures count it (${load(f.otherLoadId)}), but ${f.otherMonth}'s settled record never paid it, so no month pays this day.`
				: `${f.day}, driver ${shown(f.driver, 40)} (owner ${f.ownerId}): paid in ${f.month} (${load(f.loadId)}) although ${f.otherMonth} already settled it (${load(f.otherLoadId)}), so it is paid twice.`)),
		});
	}
	if (invoiceRates.mismatches.length) {
		sections.push({
			title: "Invoice daily rate differs from the drivers directory",
			// A day-by-day comparison (the daily-rate rule) names its days, and a
			// driver with no rate of his own is compared with the $250 default.
			lines: invoiceRates.mismatches.map((m) => `Invoice ${shown(m.invoiceNumber, 40) || `#${m.invoiceId}`} (driver ${shown(m.driver, 40)}, week ${shown(m.weekStart, 10)} to ${shown(m.weekEnd, 10)}, ${shown(m.status, 12)}): ` +
				`billed at ${money(m.invoiceCents / 100)} a day${Array.isArray(m.days) && m.days.length ? ` on ${m.days.map((d) => shown(d, 10)).join(", ")}` : ""}; ` +
				(m.defaultRate
					? `no daily rate is set in the drivers directory, so the daily rate is the ${money(m.directoryCents / 100)} default.`
					: `the drivers directory rate is ${money(m.directoryCents / 100)} a day.`)),
		});
	}
	const findings = sections.reduce((n, s) => n + s.lines.length, 0);
	const dayText = appTime.dateTextInZone(now, appZone);
	const subject = `LogisX integrity check (${dayText}): ${findings} issue${findings === 1 ? "" : "s"}`;
	const heading = "Daily integrity check";
	const notes = [];
	if (baseline) notes.push(`First run: the baseline is the Pickup Appointment and Assigned Date of these ${loadsSeen} loads; changes are reported from the next run.`);
	if (zone.skipped && !baseline) notes.push(`Assigned Date time zones were not checked: ${zone.skipped}.`);
	const unmatchedNote = (list, how) => `${list.length} new Assigned Date${list.length === 1 ? "" : "s"} ${how}, so ${list.length === 1 ? "its" : "their"} zone could not be checked: load ${list.map((s) => shown(s.id, 40)).join(", ")}.`;
	const ambiguous = zone.unmatched.filter((s) => s.ambiguous);
	const noEmail = zone.unmatched.filter((s) => !s.ambiguous);
	if (noEmail.length) notes.push(unmatchedNote(noEmail, "matched no rate-con email"));
	if (ambiguous.length) notes.push(unmatchedNote(ambiguous, "could not be matched to one rate-con email (two emails fit it at different offsets)"));
	if (receipts.reportedOpen) notes.push(`${receipts.reportedOpen} approved receipt${receipts.reportedOpen === 1 ? "" : "s"} reported earlier ${receipts.reportedOpen === 1 ? "is" : "are"} still on no invoice.`);
	if (receipts.unreadableInvoices) notes.push(`${receipts.unreadableInvoices} invoice${receipts.unreadableInvoices === 1 ? " has" : "s have"} an unreadable receipt list.`);
	if (payments.skipped) notes.push(`Payments after invoicing were not checked: ${payments.skipped}.`);
	if (payments.reportedOpen) notes.push(`${payments.reportedOpen} Payment change${payments.reportedOpen === 1 ? "" : "s"} after invoicing reported earlier ${payments.reportedOpen === 1 ? "is" : "are"} still as reported.`);
	if (payments.noSheetTotal) notes.push(`${payments.noSheetTotal} invoice draft${payments.noSheetTotal === 1 ? "" : "s"} recorded no sheet total, so ${payments.noSheetTotal === 1 ? "its load's" : "their loads'"} Payment could not be compared.`);
	if (payments.unknownMonth) notes.push(`${payments.unknownMonth} load${payments.unknownMonth === 1 ? "" : "s"} with a Payment different from the invoice could not be placed in an open or a closed month (a date that can't be placed, or closed months that can't be read), so ${payments.unknownMonth === 1 ? "it was" : "they were"} not raised.`);
	if (payments.closed) notes.push(`${payments.closed} load${payments.closed === 1 ? "" : "s"} with a Payment different from the invoice ${payments.closed === 1 ? "is" : "are"} in a closed month, final as recorded, so ${payments.closed === 1 ? "it was" : "they were"} not raised.`);
	if (dayOnce.skipped) notes.push(`Ledger day-once days were not checked: ${dayOnce.skipped}.`);
	if (dayOnce.reportedOpen) notes.push(`${dayOnce.reportedOpen} driver-day${dayOnce.reportedOpen === 1 ? "" : "s"} the ledger day-once rule decides against a closed month's settled record, reported earlier, ${dayOnce.reportedOpen === 1 ? "is" : "are"} still as reported.`);
	const rateInvoices = (n) => `${n} invoice${n === 1 ? "" : "s"} whose daily rate differs from the drivers directory`;
	const itWas = (n) => (n === 1 ? "it was" : "they were");
	if (invoiceRates.skipped) notes.push(`Invoice daily rates were not checked: ${invoiceRates.skipped}.`);
	if (invoiceRates.reportedOpen) notes.push(`${rateInvoices(invoiceRates.reportedOpen)}, reported earlier, ${invoiceRates.reportedOpen === 1 ? "is" : "are"} still as reported.`);
	if (invoiceRates.closed) notes.push(`${rateInvoices(invoiceRates.closed)} ${invoiceRates.closed === 1 ? "is" : "are"} in a closed month, final as recorded, so ${itWas(invoiceRates.closed)} not raised.`);
	if (invoiceRates.unknownMonth) notes.push(`${rateInvoices(invoiceRates.unknownMonth)} could not be placed in an open or a closed month (a week date that can't be read, or closed months that can't be read), so ${itWas(invoiceRates.unknownMonth)} not raised.`);
	if (invoiceRates.noPayType) notes.push(`${invoiceRates.noPayType} invoice${invoiceRates.noPayType === 1 ? "" : "s"} with a rate different from the drivers directory record${invoiceRates.noPayType === 1 ? "s" : ""} no pay type, so ${itWas(invoiceRates.noPayType)} not compared.`);
	const capped = (lines) => (lines.length > LIST_MAX ? [...lines.slice(0, LIST_MAX), `…and ${lines.length - LIST_MAX} more.`] : lines);
	const text = [
		`${findings} issue${findings === 1 ? "" : "s"} found by the daily integrity check on ${dayText}.`,
		...sections.flatMap((s) => ["", `${s.title} (${s.lines.length}):`, ...capped(s.lines).map((l) => `  - ${l}`)]),
		...(notes.length ? ["", ...notes] : []),
	].join("\n");
	const bodyHtml = [
		`<p style="margin:0 0 12px;line-height:1.6;color:#334155">${findings} issue${findings === 1 ? "" : "s"} found by the daily integrity check on ${escapeHtml(dayText)}. It only reads; nothing was changed.</p>`,
		...sections.map((s) => `<h3 style="margin:16px 0 8px;font-size:15px;color:#0f172a">${escapeHtml(s.title)} (${s.lines.length})</h3>` +
			`<ul style="margin:0 0 12px;padding-left:20px;line-height:1.6;color:#334155">${capped(s.lines).map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`),
		...notes.map((n) => `<p style="margin:0 0 8px;color:#64748b;font-size:13px">${escapeHtml(n)}</p>`),
	].join("\n");
	return {
		findings, subject, heading, text, bodyHtml, notes,
		pickupBlanked: cmp.pickupBlanked, assignedChanged: cmp.assignedChanged, zone, receipts, payments, reissueGaveUp, dayOnce, invoiceRates,
	};
}

function idList(items, max = 20) {
	const ids = items.map((x) => shown(x.id, 40));
	return ids.length > max ? `${ids.slice(0, max).join(", ")} and ${ids.length - max} more` : ids.join(", ");
}

// The one log line a run writes.
function logLine(report, { baseline, loadsSeen, delivery, write }) {
	const z = report.zone;
	const zonePart = z.skipped
		? `Assigned Date zones not checked (${z.skipped})`
		: `${z.checked} new n8n Assigned Date${z.checked === 1 ? "" : "s"} checked (${z.ok.length} Eastern, ${z.wrong.length} not Eastern, ${z.unmatched.length} unmatched)`;
	const receiptPart = `${report.receipts.stale.length} approved receipt${report.receipts.stale.length === 1 ? "" : "s"} on no invoice for more than ${RECEIPT_DAYS} days to report`;
	let baselineHead = `[integrity-check] baseline taken: ${loadsSeen} loads recorded (Pickup Appointment, Assigned Date); changes are reported from the next run`;
	if (!write) baselineHead = `[integrity-check] baseline: no state yet, so the first run would record ${loadsSeen} loads (Pickup Appointment, Assigned Date) and report changes from the next run`;
	else if (delivery === "failed") baselineHead = `[integrity-check] baseline not taken: ${loadsSeen} loads seen, nothing recorded yet`;
	const head = baseline
		? baselineHead
		: report.findings
			? `[integrity-check] ${report.findings} finding${report.findings === 1 ? "" : "s"} over ${loadsSeen} loads`
			: `[integrity-check] clean: ${loadsSeen} loads, no Pickup Appointment blanked, no Assigned Date changed`;
	const parts = [head];
	if (report.pickupBlanked.length) parts.push(`Pickup Appointment blanked: load ${idList(report.pickupBlanked)}`);
	if (report.assignedChanged.length) parts.push(`Assigned Date changed: load ${idList(report.assignedChanged)}`);
	if (z.wrong.length) parts.push(`Assigned Date not Eastern: load ${idList(z.wrong)}`);
	parts.push(zonePart);
	parts.push(report.receipts.stale.length ? `${receiptPart}: receipt ${report.receipts.stale.map((r) => `#${r.id}`).slice(0, 20).join(", ")}${report.receipts.stale.length > 20 ? " and more" : ""}` : receiptPart);
	if (report.receipts.reportedOpen) parts.push(`${report.receipts.reportedOpen} reported earlier still on no invoice`);
	const pay = report.payments;
	if (pay && pay.skipped) parts.push(`Payments after invoicing not checked (${pay.skipped})`);
	else if (pay) parts.push(pay.changes.length ? `Payment changed after invoicing: load ${idList(pay.changes)}` : "no Payment changed after invoicing");
	if (pay && pay.reportedOpen) parts.push(`${pay.reportedOpen} Payment change${pay.reportedOpen === 1 ? "" : "s"} after invoicing reported earlier`);
	const notCompared = pay ? [
		pay.closed ? `${pay.closed} in a closed month` : "",
		pay.unknownMonth ? `${pay.unknownMonth} whose month can't be told (a date that can't be placed, or closed months that can't be read)` : "",
		pay.noSheetTotal ? `${pay.noSheetTotal} with no sheet total on the invoice draft` : "",
	].filter(Boolean) : [];
	if (notCompared.length) parts.push(`Payments after invoicing not raised: ${notCompared.join(", ")}`);
	if (report.reissueGaveUp && report.reissueGaveUp.loads.length) parts.push(`re-issue alerts given up undelivered: load ${idList(report.reissueGaveUp.loads)}`);
	const once = report.dayOnce;
	if (once && once.checked) {
		if (once.skipped) parts.push(`ledger day-once days not checked (${once.skipped})`);
		else parts.push(once.days.length ? `${once.days.length} ledger day-once driver-day${once.days.length === 1 ? "" : "s"} against a closed month's settled record` : "no ledger day-once driver-day against a closed month's settled record");
		if (once.reportedOpen) parts.push(`${once.reportedOpen} such driver-day${once.reportedOpen === 1 ? "" : "s"} reported earlier`);
	}
	const rates = report.invoiceRates;
	if (rates && rates.skipped) parts.push(`invoice daily rates not checked (${rates.skipped})`);
	else if (rates) {
		const listed = rates.mismatches.map((m) => ({ id: m.invoiceNumber || `#${m.invoiceId}` }));
		parts.push(listed.length ? `invoice daily rate differs from the drivers directory: invoice ${idList(listed)}` : "no invoice daily rate differs from the drivers directory");
		if (rates.reportedOpen) parts.push(`${rates.reportedOpen} such invoice${rates.reportedOpen === 1 ? "" : "s"} reported earlier`);
		const rateNotRaised = [
			rates.closed ? `${rates.closed} in a closed month` : "",
			rates.unknownMonth ? `${rates.unknownMonth} whose month can't be told` : "",
			rates.noPayType ? `${rates.noPayType} with no pay type recorded` : "",
		].filter(Boolean);
		if (rateNotRaised.length) parts.push(`invoice daily rates not raised: ${rateNotRaised.join(", ")}`);
	}
	if (delivery === "sent") parts.push("emailed ADMIN_NOTIFY_EMAIL");
	if (delivery === "unset") parts.push("ADMIN_NOTIFY_EMAIL is not set, so no email was sent");
	return parts.join("; ");
}

// --- the run -----------------------------------------------------------------

// One run. `write` records the state (the server); without it nothing is
// written and nothing is sent (the CLI prints `result.mail`).
async function runIntegrityCheck(opts = {}) {
	const {
		db, readJobTracking, readRateConEmails = null, expensePeriodExpr,
		now = new Date(), write = false, sendEmail = null, to = "", emailHtml = null,
		log = console, appZone = appTime.appTimeZone(), closedMonthsOf = null, dayOnceFrom = null, readFleetLedger = null,
		driverKey = defaultDriverKey,
		// (jt) -> check 8's daily-rate rule for this run's Job Tracking snapshot
		// (server.js driverRateOnlyDayRule()), or null while the rule is off.
		dailyRateRuleFor = null,
	} = opts;
	if (write) ensureStateTable(db);
	const previousRunAt = lastRunAt(db);
	const state = readState(db);
	const jt = await readJobTracking();
	const loads = jobTrackingLoads(jt);
	const cmp = compareLoads(state, loads);
	const zone = cmp.baseline
		? { checked: 0, ok: [], wrong: [], unmatched: [], skipped: "baseline run: no Assigned Date is new yet" }
		: await checkStampZones(cmp.newStamps, readRateConEmails, { appZone, sinceDays: mailboxDays(previousRunAt, now) });
	const receipts = staleApprovedReceipts(db, { now, expensePeriodExpr, reported: readReported(db) });
	const payments = invoicedPaymentChanges(db, jt, { closedMonthsOf, reported: readReportedPayments(db) });
	const reissueGaveUp = givenUpReissueAlerts(db, { reported: readReportedGaveUp(db) });
	const dayOnce = await dayOnceUnsettledDays(db, { fromMonth: dayOnceFrom, readFleetLedger, reported: readReportedDayOnce(db) });
	const invoiceRates = invoiceRateMismatches(db, {
		reported: readReportedInvoiceRates(db), driverKey,
		dailyRateRule: typeof dailyRateRuleFor === "function" ? dailyRateRuleFor(jt) : null,
	});
	const report = buildReport({ now, appZone, baseline: cmp.baseline, loadsSeen: loads.length, cmp, zone, receipts, payments, reissueGaveUp, dayOnce, invoiceRates });
	const recipient = String(to || "").trim();
	const html = report.findings
		? (typeof emailHtml === "function" ? emailHtml({ heading: report.heading, bodyHtml: report.bodyHtml }) : `<h2>${escapeHtml(report.heading)}</h2>\n${report.bodyHtml}`)
		: "";
	const mail = report.findings ? { to: recipient, subject: report.subject, text: report.text, html } : null;

	let delivery = "none";
	if (report.findings) {
		if (!recipient) delivery = "unset";
		else if (!write || typeof sendEmail !== "function") delivery = "print";
		else delivery = (await sendEmail(recipient, report.subject, html)) === true ? "sent" : "failed";
	}
	const line = logLine(report, { baseline: cmp.baseline, loadsSeen: loads.length, delivery, write });
	if (delivery === "failed") {
		log.error(`${line}; the email to ADMIN_NOTIFY_EMAIL failed, so this run is not recorded and will be repeated`);
		return { ok: false, retry: true, baseline: cmp.baseline, report, mail, emailed: false, delivery };
	}
	if (write) commitState(db, loads, now.toISOString(), receipts.stale.map((r) => r.id), payments.changes, reissueGaveUp.rows, dayOnce.days, invoiceRates.mismatches);
	log.log(line);
	return { ok: true, baseline: cmp.baseline, report, mail, emailed: delivery === "sent", delivery, logLine: line };
}

// --- the schedule ------------------------------------------------------------

// Today's run time (epoch ms) when a run is due at `now`: past 8:00 AM on the
// business clock today and not yet run since then. Otherwise null. Before 8 AM
// nothing is due, even after a missed day: the next run covers it.
function dueSlot({ now, lastRunAt: last, timeZone = appTime.appTimeZone(), hour = RUN_HOUR }) {
	const [y, m, d] = appTime.dayInZone(now, timeZone).split("-").map(Number);
	const slot = appTime.wallClockToMs(timeZone, y, m, d, hour, 0, 0);
	if (now.getTime() < slot) return null;
	const lastMs = last ? Date.parse(last) : NaN;
	return Number.isFinite(lastMs) && lastMs >= slot ? null : slot;
}

// The function server.js ticks every minute. A run that completes records its
// loads (lastRunAt), so it is not repeated that day, across restarts too. A run
// that fails or throws is retried after `retryMs`, at most `maxAttempts` times
// for that day's slot. Never rejects.
function dailyTicker({ db, run, timeZone = appTime.appTimeZone(), now = () => new Date(), log = console, retryMs = RETRY_MS, maxAttempts = MAX_ATTEMPTS }) {
	let running = false;
	const tries = { slot: 0, count: 0, at: 0, done: 0 };
	return async function tick() {
		if (running) return;
		running = true;
		try {
			const at = now();
			const slot = dueSlot({ now: at, lastRunAt: lastRunAt(db), timeZone });
			if (!slot || tries.done === slot) return;
			if (tries.slot !== slot) Object.assign(tries, { slot, count: 0, at: 0 });
			if (tries.count >= maxAttempts) return;
			if (tries.count && at.getTime() - tries.at < retryMs) return;
			tries.count++;
			tries.at = at.getTime();
			let result = null;
			try {
				result = await run(at);
			} catch (e) {
				log.error(`[integrity-check] run failed (attempt ${tries.count} of ${maxAttempts}):`, (e && e.message) || e);
			}
			if (result && result.ok) tries.done = slot;
			else if (tries.count >= maxAttempts) log.error(`[integrity-check] gave up for today after ${maxAttempts} attempts; the next run is tomorrow at ${RUN_HOUR}:00 AM ${timeZone}`);
		} catch (e) {
			log.error("[integrity-check] tick failed:", (e && e.message) || e);
		} finally {
			running = false;
		}
	};
}

module.exports = {
	STATE_TABLE,
	RECEIPTS_TABLE,
	PAYMENTS_TABLE,
	REISSUE_GAVE_UP_TABLE,
	DAY_ONCE_TABLE,
	INVOICE_RATES_TABLE,
	RUN_HOUR,
	RECEIPT_DAYS,
	CANDIDATE_OFFSETS_MIN,
	ensureStateTable,
	readState,
	readReported,
	lastRunAt,
	loadKey,
	jobTrackingLoads,
	compareLoads,
	n8nStampParts,
	classifyStamps,
	mailboxDays,
	rateConEmailReader,
	staleApprovedReceipts,
	invoicedPaymentChanges,
	givenUpReissueAlerts,
	dayOnceUnsettledDays,
	defaultDriverKey,
	invoiceRateMismatches,
	buildReport,
	runIntegrityCheck,
	dueSlot,
	dailyTicker,
};
