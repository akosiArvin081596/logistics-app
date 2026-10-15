"use strict";
// A driver-day counted in one month only: the ledger day-once rule.
//
// The payout ledger (computeLedgerScope() in lib/financials-calc.js, behind
// payouts and Financials) and GET /api/investor put each paid day in its load's
// Assigned month (the day's own month for a load without one, and for an
// admin-added day), one day set per driver per month. A day that two loads with
// different Assigned months both pay is therefore counted in both months.
//
// Behind LEDGER_DAY_ONCE_ENABLED (default off) and LEDGER_DAY_ONCE_FROM (the
// first month it applies to; without one the rule stays off),
// dropRepeatedDays() keeps such a day in the earliest month only:
//   - in a month that is FROM or later, a day is dropped when an earlier month
//     of the same driver, in the same scope, also counts it. The earliest month
//     wins;
//   - "counts" means the days a month really pays: what is left of each load's
//     window after the ELD check, the pre-dispatch rule (when on) and the remove
//     overrides, plus the admin-added days. A window day the ELD dropped is not
//     counted, so it claims nothing and stays in the later month;
//   - months before FROM are computed exactly as before, a day counted twice
//     there included (closed months are final as recorded);
//   - it reads no month lock and no frozen item: a month computes the same
//     before and after an earlier month closes.
// A month whose days all go keeps its (empty) day set, so a percentage driver
// is still paid on that month's revenue.
//
// Both paths call dropRepeatedDays() on their day sets, so they drop the same
// days. server.js reaches this module as financialsCalc.ledgerDayOnce, a name
// every lifted copy of those paths already has. scripts/ledger-day-once-dry-run.js
// shows what the rule would change.

// A month the rule can start from: "YYYY-MM", month 01-12.
const FROM_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

// The rule's first month from the process environment `env`:
// LEDGER_DAY_ONCE_FROM when LEDGER_DAY_ONCE_ENABLED is exactly "true" and FROM
// is a month, else null (the rule is off; any other flag value leaves it off).
// The one reading of both settings: the server's start-up check and both pay
// paths call it. With the flag on and no month, `warn` (given at start only) is
// told; the warning names the setting, never its value.
function ruleFromEnv(env, warn = null) {
	if (!env || env.LEDGER_DAY_ONCE_ENABLED !== "true") return null;
	const value = String(env.LEDGER_DAY_ONCE_FROM ?? "").trim();
	if (FROM_MONTH_RE.test(value)) return value;
	if (typeof warn === "function") warn("LEDGER_DAY_ONCE_FROM is not set to a month (YYYY-MM); the ledger day-once rule stays off.");
	return null;
}

// The latest closed month ("YYYY-MM"), or "" when none is closed or the table
// cannot be read. The start-up notice and the dry run's refusal both read it.
function latestClosedMonth(db) {
	try {
		const row = db.prepare("SELECT MAX(period) AS p FROM period_locks WHERE period_locks.status = 'locked' AND period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'").get();
		return (row && row.p) || "";
	} catch {
		return "";
	}
}

// The start-up notice when FROM is at or before `latestClosed`, or null. Built
// like lib/load-pay-days.js fromMonthClosedWarning(): once FROM's own month has
// closed with the rule on, it appears on every start, and that is expected. It
// never asks for FROM to be moved: closed months' live recomputes read the rule
// from FROM, so changing FROM after the rule has run would change them.
function fromMonthClosedWarning(fromMonth, latestClosed) {
	if (!FROM_MONTH_RE.test(String(fromMonth || "")) || !MONTH_KEY_RE.test(String(latestClosed || ""))) return null;
	if (fromMonth > latestClosed) return null;
	return `LEDGER_DAY_ONCE_FROM is at or before ${latestClosed}, the latest closed month: expected once `
		+ "LEDGER_DAY_ONCE_FROM's month has closed with the rule on. Never change LEDGER_DAY_ONCE_FROM once the rule has run.";
}

// The closed months (period_locks 'locked') as a Set, or null when the lock
// table cannot be read.
function closedMonths(db) {
	try {
		return new Set(db.prepare("SELECT period FROM period_locks WHERE period_locks.status = 'locked'").all().map((r) => r.period));
	} catch {
		return null;
	}
}

// The driver days closed months settled: their frozen line items
// (financials_ledger_items), read once. hasMonth(period, ownerId) says whether a
// month has frozen items for that owner at all; holds(period, ownerId, driver,
// day) whether one of them pays that driver-day; settledIn(ownerId, driver, day)
// lists the months that do, oldest first, with the load each names. A database
// without the table has none. The dry run and the integrity check both read it.
function frozenDriverDays(db) {
	const months = new Set();
	const days = new Map();
	const key = (ownerId, driver, day) => `${Number(ownerId) || 0}\t${String(driver || "").toLowerCase()}\t${day}`;
	try {
		for (const r of db.prepare("SELECT DISTINCT period, owner_id FROM financials_ledger_items").all()) months.add(`${r.period}\t${Number(r.owner_id) || 0}`);
		for (const r of db.prepare("SELECT period, owner_id, driver, day, load_id FROM financials_ledger_items WHERE kind = 'driver_pay' AND day != '' ORDER BY period, id").all()) {
			const k = key(r.owner_id, r.driver, r.day);
			if (!days.has(k)) days.set(k, []);
			const list = days.get(k);
			if (!list.some((x) => x.period === r.period)) list.push({ period: r.period, loadId: r.load_id || "" });
		}
	} catch {
		months.clear();
		days.clear();
	}
	const settledIn = (ownerId, driver, day) => days.get(key(ownerId, driver, day)) || [];
	return {
		hasMonth: (period, ownerId) => months.has(`${period}\t${Number(ownerId) || 0}`),
		holds: (period, ownerId, driver, day) => settledIn(ownerId, driver, day).some((x) => x.period === period),
		settledIn,
	};
}

// The driver-days the rule decides against a closed month's settled record, for
// a person to review (the daily integrity check). Report only: it changes no
// figure. `scopes` are the payout ledger's scopes with the rule on
// ({ ownerId, items, dayOnceDrops }, computeFleetLedger() in server.js);
// `frozen` is frozenDriverDays(); `closed` the closed months (a Set). Two kinds,
// for fixed-rate days in open months only (a closed month is final as recorded;
// a percentage driver's pay does not count days):
//   - "dropped": the rule leaves a day out of an open month because a closed
//     month's live figures count it, but that month's frozen items do not pay
//     it, so no month pays it;
//   - "kept": an open month FROM or later pays a day that a closed earlier
//     month's frozen items already paid, so it is paid twice.
// Either happens when a closed month's live recompute moves after it closed (a
// late status tap, late ELD pings). A closed month with no frozen items for the
// owner cannot be compared and is skipped.
function unsettledDays({ fromMonth, scopes, frozen, closed }) {
	const out = [];
	if (!fromMonth || !closed) return out;
	for (const s of scopes || []) {
		const ownerId = Number(s.ownerId) || 0;
		for (const d of s.dayOnceDrops || []) {
			if (d.payType === "percentage" || closed.has(d.month) || !closed.has(d.keptMonth)) continue;
			if (!frozen.hasMonth(d.keptMonth, ownerId) || frozen.holds(d.keptMonth, ownerId, d.driver, d.day)) continue;
			out.push({ kind: "dropped", ownerId, driver: d.driver, day: d.day, month: d.month, loadId: d.loadId || "", otherMonth: d.keptMonth, otherLoadId: d.keptLoadId || "" });
		}
		for (const it of s.items || []) {
			if (it.kind !== "driver_pay" || !it.day || it.payType === "percentage" || it.month < fromMonth || closed.has(it.month)) continue;
			const settled = frozen.settledIn(ownerId, it.driver, it.day).find((x) => x.period < it.month && closed.has(x.period));
			if (!settled) continue;
			out.push({ kind: "kept", ownerId, driver: it.driver, day: it.day, month: it.month, loadId: it.loadId || "", otherMonth: settled.period, otherLoadId: settled.loadId });
		}
	}
	return out.sort((a, b) => a.ownerId - b.ownerId || a.month.localeCompare(b.month) || a.driver.localeCompare(b.driver) || a.day.localeCompare(b.day));
}

// Drops, in place, each day a month FROM or later shares with an earlier month
// of the same driver (see the top of this file). `monthlyDays` is
// { driver: { "YYYY-MM": Set<"YYYY-MM-DD"> } }; `dayLoads`, when given, is the
// same shape with an entry per day ({ driver: { "YYYY-MM": { day: … } } }) and
// loses the dropped days' entries too. Returns the drops, as
// [{ driver, day, month, keptMonth }]. With no FROM it changes nothing.
function dropRepeatedDays(monthlyDays, fromMonth, dayLoads = null) {
	const drops = [];
	if (!fromMonth || !FROM_MONTH_RE.test(fromMonth)) return drops;
	for (const [driver, months] of Object.entries(monthlyDays)) {
		const keys = Object.keys(months).sort();
		if (keys.length < 2 || keys[keys.length - 1] < fromMonth) continue;
		const firstMonth = new Map();
		for (const mk of keys) {
			for (const d of months[mk]) if (!firstMonth.has(d)) firstMonth.set(d, mk);
		}
		for (const mk of keys) {
			if (mk < fromMonth) continue;
			const set = months[mk];
			for (const d of [...set].sort()) {
				const keptMonth = firstMonth.get(d);
				if (keptMonth >= mk) continue;
				set.delete(d);
				const loads = dayLoads && dayLoads[driver] && dayLoads[driver][mk];
				if (loads) delete loads[d];
				drops.push({ driver, day: d, month: mk, keptMonth });
			}
		}
	}
	return drops;
}

module.exports = {
	FROM_MONTH_RE,
	ruleFromEnv,
	latestClosedMonth,
	fromMonthClosedWarning,
	dropRepeatedDays,
	closedMonths,
	frozenDriverDays,
	unsettledDays,
};
