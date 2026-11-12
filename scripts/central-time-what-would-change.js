#!/usr/bin/env node
// Read-only report for the switch of the business clock to another zone (the
// Central time plan, §2.6; hard rule 3): what the switch would change on a given
// database and sheet, run before the switch-on, by Arvin's brief only.
//
//   node scripts/central-time-what-would-change.js --dry-run --db=app.db --sheet-id=<id> \
//     --zone=America/Chicago --from=2026-11-18T02:00:00Z [--json]
//   node scripts/central-time-what-would-change.js --dry-run --db=<copy> --env-file=<file> \
//     --values-json=<file> --zone=America/Chicago --from=2026-11-18T02:00:00Z [--json]
//
// For the open months (from 2026-10, the Eastern era's first month, to the
// current business month, less every month period_locks holds locked) it lists:
//   1. what a bare flip would move: each stored instant a reader of the plan's
//      §2.2 turns into a business day, week or month whose day under APP_TIMEZONE
//      alone (every instant re-read on --zone) differs from today's reading; the
//      days the truck held at noon would change; each sheet stamp dated from
//      2026-10-09 that a bare flip would re-read an hour late (its date is kept);
//   2. what the switch moves (both settings, this code): expected none;
//   3. the switch itself: the next Friday's cutoff and batch in UTC on each clock,
//      the close of the switch's month on each clock, and the app's own
//      APP_TIMEZONE and APP_TIMEZONE_FROM (their values only).
// It prints ids, days and counts: no name, amount or address.
//
// It writes nothing. The database is opened read-only through
// scripts/lib/ledger-world.js (the app directory's own app.db, or a copy under the
// temp directory; the handle is refused unless read-only) and read with SELECT
// only; the sheet is read with the spreadsheets.readonly scope, or taken from a
// saved values.get. There is no default database, sheet, zone or moment.
// Like the server, it runs on the UTC clock: it sets its own process zone first.
//
// Exit 0 when the switch moves nothing, 1 when it would, 2 on a refused argument.

"use strict";

const MACHINE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
process.env.TZ = "UTC";

const path = require("path");
const { envFor, dbScope, openDb, parseArgs, sheetFor } = require("./lib/ledger-world");
const appTime = require("../lib/app-time");

const ROOT = path.join(__dirname, "..");
const OPTIONS = ["dry-run", "db", "sheet-id", "values-json", "env-file", "key", "zone", "from", "json"];
const FIRST_MONTH = appTime.SHEET_STAMP_APP_ZONE_FROM.slice(0, 7);
const LIST_MAX = 50;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SQLITE_UTC_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const ISO_ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const APP_STAMP_RE = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/;
const STAMP_HEADERS = [/^status update date$/i, /^completion date$/i];
const ZONED_HEADERS = [/^status update date$/i, /^completion date$/i, /^assigned date$/i];

class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };

// A stored instant as epoch ms, or NaN: an ISO string with a zone, or SQLite's
// zone-less CURRENT_TIMESTAMP text (UTC). A bare day is no instant.
function storedMs(v) {
	const s = String(v == null ? "" : v).trim();
	if (!s || DAY_RE.test(s)) return NaN;
	const m = SQLITE_UTC_RE.exec(s);
	if (m) return Date.parse(`${m[1]}T${m[2]}Z`);
	return ISO_ZONED_RE.test(s) ? Date.parse(s) : NaN;
}

// The Saturday-to-Friday week of a day, by its Saturday.
function weekOf(day) {
	const [y, m, d] = day.split("-").map(Number);
	const t = Date.UTC(y, m - 1, d);
	return new Date(t - ((new Date(t).getUTCDay() + 1) % 7) * 86400000).toISOString().slice(0, 10);
}

function addDays(day, n) {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

function monthsFrom(first, last) {
	const out = [];
	let [y, m] = first.split("-").map(Number);
	for (let i = 0; i < 240; i++) {
		const key = `${y}-${String(m).padStart(2, "0")}`;
		if (key > last) break;
		out.push(key);
		m += 1;
		if (m > 12) { m = 1; y += 1; }
	}
	return out;
}

function tableNames(db) {
	return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
}

function columnsOf(db, table) {
	return new Set(db.prepare(`SELECT * FROM "${table.replace(/"/g, "")}" LIMIT 0`).columns().map((c) => c.name));
}

// The three readings of the business clock the report compares.
function clocksFor({ env, zone, from, nowMs }) {
	const quiet = () => {};
	const current = appTime.resolveAppTimeZoneSwitch(env, quiet);
	const currentZone = current ? (nowMs >= current.fromMs ? current.zone : current.before) : appTime.DEFAULT_APP_TIMEZONE;
	const planned = appTime.resolveAppTimeZoneSwitch({ APP_TIMEZONE: zone, APP_TIMEZONE_FROM: from }, quiet);
	if (!planned) refuse(`--zone=${JSON.stringify(zone)} with --from=${JSON.stringify(from)} makes no switch: --zone names an IANA zone other than ${appTime.EASTERN_ERA_ZONE}, --from an ISO instant in UTC from 2026-10-09T04:00:00Z on`);
	const zoneToday = (ms) => appTime.zoneAtSwitch(current, ms, currentZone);
	const zoneSwitch = (ms) => appTime.zoneAtSwitch(planned, ms, currentZone);
	return {
		current, currentZone, planned,
		day: (ms) => ({
			today: appTime.dayInZone(new Date(ms), zoneToday(ms)),
			flip: appTime.dayInZone(new Date(ms), planned.zone),
			switched: appTime.dayInZone(new Date(ms), zoneSwitch(ms)),
		}),
		wall: (y, mo, d, h, mi, s) => ({
			today: appTime.wallClockToMsAtSwitch(current, currentZone, y, mo, d, h, mi, s),
			flip: appTime.wallClockToMs(planned.zone, y, mo, d, h, mi, s),
			switched: appTime.wallClockToMsAtSwitch(planned, currentZone, y, mo, d, h, mi, s),
		}),
	};
}

// What the report finds: { flip, switched } lists per reader, each item
// { ref, at, today, flip | switched, week, month }.
function buildReport({ db, values, env, zone, from, nowMs = Date.now(), dbLabel = "" }) {
	const clock = clocksFor({ env: env || {}, zone, from, nowMs });
	const tables = tableNames(db);
	const thisMonth = appTime.dayInZone(new Date(nowMs), clock.currentZone).slice(0, 7);
	const locked = tables.has("period_locks")
		? new Set(db.prepare("SELECT period FROM period_locks WHERE status = 'locked'").all().map((r) => r.period))
		: new Set();
	const openMonths = monthsFrom(FIRST_MONTH, thisMonth).filter((m) => !locked.has(m));
	const isOpen = (month) => openMonths.includes(month);
	const readers = [];
	const reader = (id, what) => { const r = { id, what, flip: [], switched: [], counts: null }; readers.push(r); return r; };
	// One stored instant of reader `r`: listed under each reading whose day (or
	// month, `by`) differs from today's, when either day is in an open month.
	// `extra(todayDay, otherDay)` adds fields to an item.
	const note = (r, ref, ms, { by = "day", extra = null } = {}) => {
		const d = clock.day(ms);
		if (!isOpen(d.today.slice(0, 7)) && !isOpen(d.flip.slice(0, 7))) return;
		const key = (day) => (by === "month" ? day.slice(0, 7) : day);
		const item = (other, field) => ({
			ref, at: new Date(ms).toISOString(), today: key(d.today), [field]: key(other),
			week: weekOf(d.today) !== weekOf(other), month: d.today.slice(0, 7) !== other.slice(0, 7),
			...(extra ? extra(d.today, other) : {}),
		});
		if (key(d.flip) !== key(d.today)) r.flip.push(item(d.flip, "flip"));
		if (key(d.switched) !== key(d.today)) r.switched.push(item(d.switched, "switched"));
	};
	const has = (t, ...cols) => tables.has(t) && cols.every((c) => columnsOf(db, t).has(c));

	// P8: the month of a truck assignment or carrier history instant (assignmentMonthKey()).
	const p8 = reader("P8", "truck-assignment and carrier-history months (assignmentMonthKey())");
	if (has("truck_assignments", "id", "start_date", "end_date")) {
		for (const a of db.prepare("SELECT id, start_date, end_date FROM truck_assignments ORDER BY id").all()) {
			for (const col of ["start_date", "end_date"]) {
				const s = String(a[col] || "").trim();
				if (!s || DAY_RE.test(s)) continue;
				const ms = new Date(s).getTime();
				if (Number.isFinite(ms)) note(p8, `truck_assignments #${a.id} ${col}`, ms, { by: "month" });
			}
		}
	}
	if (has("carrier_driver_history", "id", "started_at", "ended_at")) {
		for (const a of db.prepare("SELECT id, started_at, ended_at FROM carrier_driver_history ORDER BY id").all()) {
			for (const col of ["started_at", "ended_at"]) {
				const s = String(a[col] || "").trim();
				if (!s || DAY_RE.test(s)) continue;
				const ms = new Date(s).getTime();
				if (Number.isFinite(ms)) note(p8, `carrier_driver_history #${a.id} ${col}`, ms, { by: "month" });
			}
		}
	}

	// P9: the truck a driver held "on a day" is read at noon (appNoonMs()): a
	// handover between the two clocks' noons changes that day's holder.
	const p9 = reader("P9", "the truck held at noon (appNoonMs())");
	if (has("truck_assignments", "id", "start_date", "end_date")) {
		for (const a of db.prepare("SELECT id, start_date, end_date FROM truck_assignments ORDER BY id").all()) {
			for (const col of ["start_date", "end_date"]) {
				const ms = new Date(String(a[col] || "").trim()).getTime();
				if (!Number.isFinite(ms) || DAY_RE.test(String(a[col] || "").trim())) continue;
				const day = clock.day(ms).today;
				if (day < appTime.SHEET_STAMP_APP_ZONE_FROM || !isOpen(day.slice(0, 7))) continue;
				const [y, mo, d] = day.split("-").map(Number);
				const noon = clock.wall(y, mo, d, 12, 0, 0);
				const between = (x, y2) => Math.min(x, y2) <= ms && ms < Math.max(x, y2);
				const item = { ref: `truck_assignments #${a.id} ${col}`, at: new Date(ms).toISOString(), today: day, week: false, month: false };
				if (between(noon.today, noon.flip)) p9.flip.push({ ...item, flip: `holder at ${new Date(noon.flip).toISOString()}` });
				if (between(noon.today, noon.switched)) p9.switched.push({ ...item, switched: `holder at ${new Date(noon.switched).toISOString()}` });
			}
		}
	}

	// P5: the day a pay rate starts (loadPayRateIndex()).
	const p5 = reader("P5", "pay-rate days (loadPayRateIndex())");
	if (has("pay_rate_history", "id", "effective_from")) {
		for (const r of db.prepare("SELECT id, effective_from FROM pay_rate_history ORDER BY id").all()) {
			const ms = new Date(String(r.effective_from || "")).getTime();
			if (Number.isFinite(ms)) note(p5, `pay_rate_history #${r.id}`, ms);
		}
	}

	// C6, C9: the day a receipt was submitted (receiptSubmittedDaySql(), and
	// auto-approval's future check); `future` marks a receipt whose date would
	// then fall after its submission day, or no longer.
	const c6 = reader("C6/C9", "receipt submission days (receiptSubmittedDaySql(); auto-approval's future check)");
	if (has("expenses", "id", "date", "timestamp", "created_at")) {
		for (const e of db.prepare("SELECT id, date, CAST(strftime('%s', COALESCE(NULLIF(timestamp, ''), created_at)) AS INTEGER) AS secs FROM expenses ORDER BY id").all()) {
			if (!Number.isFinite(e.secs)) continue;
			const date = String(e.date || "").slice(0, 10);
			const future = (day) => DAY_RE.test(date) && date > day;
			note(c6, `expenses #${e.id}`, e.secs * 1000, { extra: (today, other) => ({ futureCheckFlips: future(today) !== future(other) }) });
		}
	}

	// F5, F6: a refuel episode's day, which a re-scan rewrites (fuel_events.local_day).
	const f5 = reader("F5/F6", "fuel-event days and their receipt match (fuel_events.local_day)");
	if (has("fuel_events", "id", "start_ms")) {
		for (const f of db.prepare("SELECT id, start_ms FROM fuel_events ORDER BY id").all()) {
			if (Number.isFinite(Number(f.start_ms))) note(f5, `fuel_events #${f.id}`, Number(f.start_ms));
		}
	}

	// D10: the payment report's day of each payment.
	const d10 = reader("D10", "payment report days (invoices.paid_at)");
	if (has("invoices", "id", "paid_at")) {
		for (const i of db.prepare("SELECT id, paid_at FROM invoices WHERE COALESCE(paid_at, '') <> '' ORDER BY id").all()) {
			const ms = Date.parse(String(i.paid_at));
			if (Number.isFinite(ms)) note(d10, `invoices #${i.id}`, ms);
		}
	}

	// F9: IFTA's day of each ELD ping, counted per vehicle and day (no list).
	const f9 = reader("F9", "IFTA days (routemate_telemetry pings, counted)");
	f9.counts = { flip: {}, switched: {} };
	if (has("routemate_telemetry", "routemate_vehicle_id", "location_date_ms", "dropped_reason") && openMonths.length) {
		const [y, m] = openMonths[0].split("-").map(Number);
		const sinceMs = appTime.wallClockToMs(clock.currentZone, y, m, 1, 0, 0, 0) - 86400000;
		const stmt = db.prepare("SELECT routemate_vehicle_id AS vid, location_date_ms AS ms FROM routemate_telemetry WHERE location_date_ms >= ? AND dropped_reason = ''");
		for (const p of stmt.iterate(sinceMs)) {
			const ms = Number(p.ms);
			if (!Number.isFinite(ms)) continue;
			const d = clock.day(ms);
			if (!isOpen(d.today.slice(0, 7)) && !isOpen(d.flip.slice(0, 7))) continue;
			const key = `${p.vid} ${d.today}`;
			if (d.flip !== d.today) f9.counts.flip[key] = (f9.counts.flip[key] || 0) + 1;
			if (d.switched !== d.today) f9.counts.switched[key] = (f9.counts.switched[key] || 0) + 1;
		}
	}

	// P14: the day a truck with no in-service date starts its fixed costs.
	const p14 = reader("P14", "truck charge days (trucks with no in-service date, created_at)");
	if (has("trucks", "id", "created_at", "in_service_date")) {
		for (const t of db.prepare("SELECT id, created_at, in_service_date FROM trucks ORDER BY id").all()) {
			if (String(t.in_service_date || "").trim()) continue;
			const ms = storedMs(t.created_at);
			if (Number.isFinite(ms)) note(p14, `trucks #${t.id}`, ms);
		}
	}

	// P4: trip work days from the status taps (load_status_history.changed_at).
	const p4 = reader("P4", "trip work days (load_status_history.changed_at)");
	if (has("load_status_history", "id", "changed_at")) {
		for (const h of db.prepare("SELECT id, changed_at FROM load_status_history ORDER BY id").all()) {
			const ms = storedMs(h.changed_at);
			if (Number.isFinite(ms)) note(p4, `load_status_history #${h.id}`, ms);
		}
	}

	// P13: an owner-operator's acceptance day (his first settlement week).
	const p13 = reader("P13", "owner-operator stamp days (owner_operators.created_at)");
	if (has("owner_operators", "id", "created_at")) {
		for (const o of db.prepare("SELECT id, created_at FROM owner_operators ORDER BY id").all()) {
			const ms = storedMs(o.created_at);
			if (Number.isFinite(ms)) note(p13, `owner_operators #${o.id}`, ms);
		}
	}

	// S20: the KPI series' days of the instants it counts (kpiInstantDay(), the
	// sources kpiGatherDbInputs() reads), counted.
	const s20 = reader("S20", "KPI series days (counted per source)");
	s20.counts = { flip: {}, switched: {} };
	const kpiSources = [
		["expenses", "created_at", "expenses.created_at", "COALESCE(receipt_details, '') != ''", ["receipt_details"]],
		["audit_trail", "timestamp", "audit_trail.timestamp", "action IN ('expense_ai_insights', 'expense_ai_query')", ["action"]],
		["load_status_history", "changed_at", "load_status_history.changed_at", "source = 'geofence' OR LOWER(new_status) = 'at receiver'", ["source", "new_status"]],
		["invoice_autogen_runs", "ran_at", "invoice_autogen_runs.ran_at", "COALESCE(summary, '') NOT LIKE 'baseline%'", ["summary"]],
		["trucks", "created_at", "trucks.created_at", "1 = 1", []],
	];
	for (const [table, col, label, where, cols] of kpiSources) {
		if (!has(table, col, ...cols)) continue;
		for (const r of db.prepare(`SELECT "${col}" AS v FROM "${table}" WHERE ${where}`).iterate()) {
			const ms = storedMs(r.v);
			if (!Number.isFinite(ms)) continue;
			const d = clock.day(ms);
			if (!isOpen(d.today.slice(0, 7)) && !isOpen(d.flip.slice(0, 7))) continue;
			if (d.flip !== d.today) s20.counts.flip[label] = (s20.counts.flip[label] || 0) + 1;
			if (d.switched !== d.today) s20.counts.switched[label] = (s20.counts.switched[label] || 0) + 1;
		}
	}

	// M4: the sheet's own stamps keep their date; a bare flip re-reads an
	// Eastern-era stamp's instant an hour late. A zoned cell is an instant.
	const m4 = reader("M4", "sheet stamps (Status Update Date, Completion Date) re-read on another clock; their date is kept");
	const zoned = reader("M4z", "zoned sheet cells whose business day would move (sheetDayKey())");
	const rows = Array.isArray(values && values.values) ? values.values : [];
	const headers = (rows[0] || []).map((h) => String(h || "").trim());
	const colsFor = (res) => headers.map((h, i) => (res.some((re) => re.test(h)) ? i : -1)).filter((i) => i >= 0);
	const stampCols = colsFor(STAMP_HEADERS);
	const zonedCols = colsFor(ZONED_HEADERS);
	for (let r = 1; r < rows.length; r++) {
		const row = rows[r] || [];
		for (const c of stampCols) {
			const m = APP_STAMP_RE.exec(String(row[c] == null ? "" : row[c]).trim());
			if (!m) continue;
			const day = `${m[3]}-${m[1]}-${m[2]}`;
			if (day < appTime.SHEET_STAMP_APP_ZONE_FROM || !isOpen(day.slice(0, 7))) continue;
			const w = clock.wall(+m[3], +m[1], +m[2], +m[4], +m[5], +m[6]);
			if (!Number.isFinite(w.today)) continue;
			const item = { ref: `sheet row ${r + 1} ${headers[c]}`, at: new Date(w.today).toISOString(), today: day, week: false, month: false };
			if (w.flip !== w.today) m4.flip.push({ ...item, flip: new Date(w.flip).toISOString() });
			if (w.switched !== w.today) m4.switched.push({ ...item, switched: new Date(w.switched).toISOString() });
		}
		for (const c of zonedCols) {
			const s = String(row[c] == null ? "" : row[c]).trim();
			if (!ISO_ZONED_RE.test(s)) continue;
			const ms = Date.parse(s);
			if (Number.isFinite(ms)) note(zoned, `sheet row ${r + 1} ${headers[c]}`, ms);
		}
	}

	// The switch itself.
	const planned = clock.planned;
	const switchDay = appTime.dayInZone(new Date(planned.fromMs), planned.zone);
	let friday = switchDay;
	while (new Date(`${friday}T12:00:00Z`).getUTCDay() !== 5) friday = addDays(friday, 1);
	const [fy, fm, fd] = friday.split("-").map(Number);
	const onClock = (zone2, y, mo, d, h, mi) => new Date(appTime.wallClockToMs(zone2, y, mo, d, h, mi, 0)).toISOString();
	const graceRow = tables.has("investor_config") && columnsOf(db, "investor_config").has("value")
		? db.prepare("SELECT value FROM investor_config WHERE owner_id = 0 AND key = 'settlement_grace_days'").get()
		: null;
	const graceRaw = parseInt(graceRow && graceRow.value, 10);
	const graceDays = Number.isFinite(graceRaw) ? Math.min(28, Math.max(0, graceRaw)) : 7;
	const switchMonth = switchDay.slice(0, 7);
	const [sy, sm] = switchMonth.split("-").map(Number);
	const lastOpenDay = addDays(new Date(Date.UTC(sy, sm, 0, 12)).toISOString().slice(0, 10), graceDays);
	const closeDay = addDays(lastOpenDay, 1);
	const [cy, cm, cd] = closeDay.split("-").map(Number);
	const theSwitch = {
		moment: planned.from,
		zone: planned.zone,
		before: planned.before,
		friday,
		cutoff: { before: onClock(planned.before, fy, fm, fd, 18, 30), after: onClock(planned.zone, fy, fm, fd, 18, 30) },
		batch: { before: onClock(planned.before, fy, fm, fd, 19, 0), after: onClock(planned.zone, fy, fm, fd, 19, 0) },
		close: { month: switchMonth, graceDays, lastOpenDay, before: onClock(planned.before, cy, cm, cd, 0, 0), after: onClock(planned.zone, cy, cm, cd, 0, 0) },
		appSettings: {
			APP_TIMEZONE: env && String(env.APP_TIMEZONE || "").trim() ? String(env.APP_TIMEZONE).trim() : "(unset)",
			APP_TIMEZONE_FROM: env && String(env.APP_TIMEZONE_FROM || "").trim() ? String(env.APP_TIMEZONE_FROM).trim() : "(unset)",
			zoneInForce: clock.currentZone,
		},
	};

	const countOf = (r, kind) => (r.counts ? Object.values(r.counts[kind]).reduce((a, b) => a + b, 0) : r[kind].length);
	const switchedTotal = readers.reduce((n, r) => n + countOf(r, "switched"), 0);
	return {
		generatedAt: new Date(nowMs).toISOString(),
		database: dbLabel,
		machineZone: MACHINE_ZONE,
		openMonths,
		lockedMonths: [...locked].sort(),
		readers: readers.map((r) => ({
			id: r.id, what: r.what,
			flipCount: countOf(r, "flip"), switchedCount: countOf(r, "switched"),
			flip: r.counts ? r.counts.flip : r.flip.slice(0, LIST_MAX),
			switched: r.counts ? r.counts.switched : r.switched.slice(0, LIST_MAX),
		})),
		switchedTotal,
		theSwitch,
	};
}

function printText(report) {
	const lines = [];
	const say = (s = "") => lines.push(s);
	const t = report.theSwitch;
	say(`Central time: what the switch would change (read-only; ${report.database || "database"})`);
	say(`Planned: APP_TIMEZONE=${t.zone} from APP_TIMEZONE_FROM=${t.moment} (the clock before it: ${t.before}).`);
	say(`The app's own settings: APP_TIMEZONE ${t.appSettings.APP_TIMEZONE}, APP_TIMEZONE_FROM ${t.appSettings.APP_TIMEZONE_FROM}; the zone in force: ${t.appSettings.zoneInForce}.`);
	say(`Open months: ${report.openMonths.join(", ") || "none"}${report.lockedMonths.length ? `; locked (left out): ${report.lockedMonths.join(", ")}` : ""}. This machine runs ${report.machineZone}; the report runs on UTC.`);
	const section = (title, kind) => {
		say("");
		say(title);
		for (const r of report.readers) {
			const n = kind === "flip" ? r.flipCount : r.switchedCount;
			say(`  ${r.id} ${r.what}: ${n}`);
			const list = r[kind];
			if (Array.isArray(list)) {
				for (const x of list) say(`    ${x.ref} at ${x.at}: ${x.today} -> ${x[kind]}${x.week ? " (another week)" : ""}${x.month ? " (another month)" : ""}${x.futureCheckFlips ? " (auto-approval's future check flips)" : ""}`);
				if (n > list.length) say(`    and ${n - list.length} more`);
			} else {
				for (const [k, v] of Object.entries(list)) say(`    ${k}: ${v}`);
			}
		}
	};
	section("1. What a bare flip would move (APP_TIMEZONE alone: every instant re-read on the new clock)", "flip");
	section(`2. What the switch moves (both settings, this code): ${report.switchedTotal ? `${report.switchedTotal} item(s): look before switching on` : "none"}`, "switched");
	say("");
	say("3. The switch itself (UTC)");
	say(`  Friday ${t.friday}: cutoff 6:30 PM ${t.cutoff.before} on ${t.before}, ${t.cutoff.after} on ${t.zone}; batch 7:00 PM ${t.batch.before} -> ${t.batch.after}`);
	say(`  ${t.close.month} closes after ${t.close.lastOpenDay} (${t.close.graceDays} grace days): 00:00 ${t.close.before} on ${t.before}, ${t.close.after} on ${t.zone}`);
	return lines.join("\n");
}

async function main(argv) {
	const args = parseArgs(argv);
	const unknown = Object.keys(args).filter((k) => !OPTIONS.includes(k));
	if (unknown.length) refuse(`unknown option${unknown.length === 1 ? "" : "s"}: ${unknown.map((k) => `--${k}`).join(", ")}`);
	if (args["dry-run"] !== true) refuse("--dry-run is required: this report only reads, and writes nothing");
	if (typeof args.db !== "string" || !args.db) refuse("--db=<app.db> is required; there is no default database");
	const sheets = ["sheet-id", "values-json"].filter((k) => args[k] !== undefined);
	if (sheets.length !== 1) refuse("exactly one of --sheet-id=<id> or --values-json=<file> is required; there is no default sheet");
	if (typeof args.zone !== "string" || !args.zone) refuse("--zone=<IANA zone> is required (the zone from the switch on); there is no default");
	if (typeof args.from !== "string" || !args.from) refuse("--from=<ISO instant in UTC> is required (the switch moment); there is no default");
	let env;
	let dbFile;
	let scope;
	try {
		({ env, file: dbFile } = envFor({ root: ROOT, dbPath: args.db, envFile: typeof args["env-file"] === "string" ? args["env-file"] : null }));
		scope = dbScope(args.db, ROOT).scope === "app" ? "the app's own database" : "a copy";
	} catch (err) {
		refuse(err.message);
	}
	clocksFor({ env, zone: args.zone, from: args.from, nowMs: Date.now() });
	let db;
	try {
		db = openDb({ root: ROOT, dbFile, readonly: true });
	} catch (err) {
		refuse(`--db=${args.db}: ${err.message}`);
	}
	try {
		let values;
		try {
			values = await sheetFor(args, ROOT);
		} catch (err) {
			refuse(err.message);
		}
		const report = buildReport({ db, values, env, zone: args.zone, from: args.from, dbLabel: `${scope}, read-only handle` });
		console.log(args.json ? JSON.stringify(report, null, 1) : printText(report));
		return report.switchedTotal ? 1 : 0;
	} finally {
		db.close();
	}
}

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
		if (err instanceof Refusal) { console.error(`REFUSED: ${err.message}`); process.exit(2); }
		console.error(`FAILED: ${err && err.message}`);
		process.exit(2);
	});
}

module.exports = { buildReport, printText, main, Refusal };
