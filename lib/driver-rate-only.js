"use strict";
// The owner's daily-rate rule (2026-10-16): a daily rate belongs to the DRIVER,
// not the truck. A daily-rate driver is paid his own rate
// (drivers_directory.pay_daily); $250 is the default only when he has none. A
// truck's driver_pay_daily never prices a day the rule covers.
//
// Behind DRIVER_RATE_ONLY_ENABLED (true/1/yes/on; off by default) and
// DRIVER_RATE_ONLY_FROM=YYYY-MM, the first month it covers, read once at boot
// (server.js). The flag on without a month leaves the rule off, with one
// warning. Off, every pay path prices a day as it always has: the driver's own
// rate, else his truck's, else $250.
//
// Which month a day belongs to: the month it pays in, the Assigned month of its
// load (the earliest when several loads pay the day, the month the ledger's
// day-once rule keeps it in), else the day's own month (an admin-added day, a
// load with no Assigned Date). Every pay path asks server.js's
// resolveDailyRate(own, truck, month) with that month.
//
// Which months it covers: FROM and later, except a month closed outside the
// rule (closedOutsideRule()):
//   - a month close records whether the rule priced the month (the close
//     record, written while the rule has a start record), and that record
//     answers for the month from then on;
//   - a month with no close record that was closed before the rule first ran
//     (the start record, { from, startedAt }, stamped once in app_settings)
//     keeps the old rule, so a FROM set too early never restates a closed
//     month, live or frozen.
// Closed months' frozen rows are never read or written here.

const FROM_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DAILY_RATE = 250;
// app_settings keys: the start record, and one close record per closed month.
const START_KEY = "driver_rate_only.started";
const CLOSE_KEY_PREFIX = "driver_rate_only.closed:";

// The rule's first month from the process environment, or null (the rule is
// off). With the flag on and no month, `warn` (given at start only) is told; the
// warning names the setting, never its value.
function ruleFromEnv(env, warn = null) {
	if (!env || !/^(true|1|yes|on)$/i.test(String(env.DRIVER_RATE_ONLY_ENABLED ?? "").trim())) return null;
	const value = String(env.DRIVER_RATE_ONLY_FROM ?? "").trim();
	if (FROM_MONTH_RE.test(value)) return value;
	if (typeof warn === "function") {
		warn("DRIVER_RATE_ONLY_FROM is not set to a month (YYYY-MM); the daily-rate rule (a driver's own rate, else $250) stays off.");
	}
	return null;
}

// The start-up notice when FROM is at or before the latest closed month, or
// null. Expected on every start once FROM's own month has closed with the rule
// on; a month that was closed before the rule first ran keeps the old rule
// either way.
function fromMonthClosedWarning(fromMonth, latestClosed) {
	if (!FROM_MONTH_RE.test(String(fromMonth || "")) || !MONTH_KEY_RE.test(String(latestClosed || ""))) return null;
	if (fromMonth > latestClosed) return null;
	return `DRIVER_RATE_ONLY_FROM is at or before ${latestClosed}, the latest closed month: expected once `
		+ "DRIVER_RATE_ONLY_FROM's month has closed with the rule on. A month closed before the rule first ran keeps the "
		+ "rate it was paid at. Never change DRIVER_RATE_ONLY_FROM once the rule has run.";
}

// A stored instant as epoch ms, or NaN: only the ISO shape the app writes
// (toISOString()).
function isoMs(value) {
	const s = typeof value === "string" ? value : "";
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s)) return NaN;
	const ms = Date.parse(s);
	return Number.isFinite(ms) ? ms : NaN;
}

function readSetting(db, key) {
	try {
		const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
		if (!row) return null;
		const v = JSON.parse(row.value);
		return v && typeof v === "object" ? v : null;
	} catch {
		return null;
	}
}

// The start record, { from, startedAt }, or null when the rule has never run.
function readStart(db) {
	const v = readSetting(db, START_KEY);
	return v && Number.isFinite(isoMs(v.startedAt)) ? { from: String(v.from || ""), startedAt: v.startedAt } : null;
}

// The start record, stamped once the first time the rule runs (INSERT OR
// IGNORE, so the first one stays). On a handle that cannot write (a read-only
// dry run) the record is this run's own, in memory: the rule starts now.
function ensureStart(db, fromMonth, nowIso) {
	const held = readStart(db);
	if (held) return held;
	try {
		db.prepare("INSERT OR IGNORE INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system')")
			.run(START_KEY, JSON.stringify({ from: fromMonth, startedAt: nowIso }), nowIso);
	} catch {
		return { from: fromMonth, startedAt: nowIso, recorded: false };
	}
	return readStart(db) || { from: fromMonth, startedAt: nowIso, recorded: false };
}

// A closed month's close record, { applied, from, closedAt }, or null.
function closeRecordOf(db, period) {
	const v = readSetting(db, `${CLOSE_KEY_PREFIX}${period}`);
	return v && typeof v.applied === "boolean" ? { applied: v.applied, from: String(v.from || ""), closedAt: String(v.closedAt || "") } : null;
}

// Records, as a month closes, whether the rule priced it. A month closed again
// (after a reopen) records its latest close.
function writeCloseRecord(db, period, { applied, from, closedAt }) {
	db.prepare(`INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system')
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
		.run(`${CLOSE_KEY_PREFIX}${period}`, JSON.stringify({ applied: !!applied, from: from || "", closedAt }), closedAt);
}

// True when `period` is closed and was closed outside the rule: its close
// record says the rule did not price it, or, with no close record, it was
// locked before the rule's start record (a lock time that cannot be read counts
// as before). An open month, or one whose locks cannot be read, is not.
function closedOutsideRule(db, period, start) {
	let row = null;
	try {
		row = db.prepare("SELECT finalized_at FROM period_locks WHERE period = ? AND status = 'locked'").get(period);
	} catch {
		return false;
	}
	if (!row) return false;
	const record = closeRecordOf(db, period);
	if (record) return !record.applied;
	const closedMs = isoMs(row.finalized_at);
	const startMs = isoMs(start && start.startedAt);
	if (!Number.isFinite(closedMs) || !Number.isFinite(startMs)) return true;
	return closedMs < startMs;
}

// The month a day pays in: the earliest of `months` (the Assigned months of the
// loads that pay it), else the day's own month.
function payMonthOf(day, months) {
	let best = "";
	for (const m of months || []) {
		const mk = String(m || "");
		if (MONTH_KEY_RE.test(mk) && (!best || mk < best)) best = mk;
	}
	return best || (DAY_KEY_RE.test(String(day || "")) ? String(day).slice(0, 7) : "");
}

// A driver's days as rate segments, [{ days, rate }] in month order: the days
// of consecutive months paid at one rate form one segment. `dayRates` is
// [{ day, month, rate }], one per paid day (`month` the month it pays in).
function rateSegments(dayRates) {
	const sorted = [...(dayRates || [])].sort((a, b) => String(a.month).localeCompare(String(b.month)) || String(a.day || "").localeCompare(String(b.day || "")));
	const out = [];
	for (const d of sorted) {
		const last = out[out.length - 1];
		if (last && last.rate === d.rate) last.days++;
		else out.push({ days: 1, rate: d.rate });
	}
	return out;
}

module.exports = {
	FROM_MONTH_RE,
	MONTH_KEY_RE,
	DEFAULT_DAILY_RATE,
	START_KEY,
	CLOSE_KEY_PREFIX,
	ruleFromEnv,
	fromMonthClosedWarning,
	readStart,
	ensureStart,
	closeRecordOf,
	writeCloseRecord,
	closedOutsideRule,
	payMonthOf,
	rateSegments,
};
