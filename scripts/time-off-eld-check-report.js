#!/usr/bin/env node
// scripts/time-off-eld-check-report.js — the time-off ELD check's read-only "what
// would change" report, run before DRIVER_TIME_OFF_ELD_CHECK_ENABLED goes on:
//   1. flag states: not read here (the start-up line and the bugs.md record say)
//   2. live time-off rows and their days to check
//   3. what the first run would write: day results by state and reason, and the
//      notices (the server's own timeOffEldRunPlan(), lifted)
//   4. --shadow: every driver-day of the last --days finished days judged as if
//      requested, each day as its own one-day row: counts by state and reason,
//      split by whether a load of his covers the day and whether the day has
//      fixes or lies in a dark spell; "Confirmed (no ELD data)" on its own line;
//      the measures behind stop points S2 (the position distance across dark
//      stretches with a 0 mi odometer step and on return days, the share of days
//      the 1 h engine rule keeps Requested), S4 and S4b (closed-month days left
//      out of S4b's share)
//   5. continuity breaks and engine-hours advances across dark stretches over
//      the retained telemetry, per device; closed-month ones counted for
//      calibration only, never raised as a pay issue
//   6. drivers whose current truck has no ELD link
//   7. a fingerprint of invoices, excluded_driver_days and invoice_paid_days for
//      the after-check (the switch-on must move none of them)
// Read-only: the database is opened with a read-only handle (checked), Job
// Tracking comes only from a saved values.get (--values-json; without it the
// load explanations read "not checked"), the lifted server code may reach no
// writer and its fetch() refuses, and nothing is written anywhere. Counts only;
// --names adds initials and truck units (on the local copy only: keep that
// output outside the repo).
//
// Usage:
//   node scripts/time-off-eld-check-report.js --db=<app.db> [--values-json=<file>] [--shadow] [--days=N] [--names] [--json] [--now=<instant>]
//   --days=N   the shadow's finished days, 1-90, default 35
//   --now      an ISO instant with its zone to judge as of (default: now)
// Exit codes: 0 done, 1 error, 2 refused (a missing or unreadable input).

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { parseArgs, openDb } = require("./lib/ledger-world");
const { closure } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");
const eldCheck = require("../lib/time-off-eld-check");
const eldMiles = require("../lib/eld-miles");
const driverAvailability = require("../lib/driver-availability");

const ROOT = path.join(__dirname, "..");
const DAY_MS = 24 * 60 * 60 * 1000;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TABLES = ["driver_availability", "drivers_directory", "driver_time_off_days", "truck_assignments", "eld_device_assignments", "routemate_telemetry", "trucks", "audit_trail", "users"];
const LIFT_ROOTS = ["timeOffEldRunPlan", "timeOffDayEvidence", "availabilityLoadIndexOf", "getJobTrackingCached", "normalizeDriverName", "normLoadKey", "periodWriteLocked", "appDay"];
// The run's writers, and everything that sends: the lift must never reach one.
const LIFT_DENIED = ["app", "io", "server", "sheets", "sendEmail", "transporter", "getDrive", "KEY_FILE", "jtCacheInvalidate",
	"applyTimeOffEldPlan", "runTimeOffEldCheck", "timeOffEldCheckTick", "purgeTimeOffEldResults", "logAudit", "insertDispatchNotification", "emitDispatchNotice", "notifyChange"];

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

const refuseFetch = () => { throw new Error("lifted code called fetch(); this report makes no network calls"); };

// The server's own planner and reader, lifted from this checkout's server.js
// over the read-only handle; getSheets() answers the one values.get with the
// saved tab, or throws (Job Tracking not read) without one.
function liftFromServer(db, sheetData) {
	const SRC = serverSource({ root: ROOT });
	const lifted = closure(SRC, { roots: LIFT_ROOTS, provided: ["db", "getDeletedLoadIds", "getSheets", "SPREADSHEET_ID"], denied: LIFT_DENIED });
	const deletedReader = closure(SRC, { roots: ["getDeletedLoadIds"], provided: ["db"] });
	const getDeletedLoadIds = new Function("db", "fetch", `"use strict";\n${deletedReader.text}\nreturn getDeletedLoadIds;`)(db, refuseFetch);
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const scope = {
		db,
		getDeletedLoadIds,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => {
			if (!sheetData) throw new Error("no saved Job Tracking values (--values-json)");
			return { data: sheetData };
		} } } }),
		SPREADSHEET_ID: "",
		console,
		process: { env: {} },
		require: (m) => {
			if (!/^\.\/lib\/[\w.-]+$/.test(m)) throw new Error(`lifted code required ${m}, which this report does not load`);
			return appRequire(m);
		},
		fetch: refuseFetch,
	};
	return new Function(...Object.keys(scope), `"use strict";\n${lifted.text}\nreturn { ${LIFT_ROOTS.join(", ")} };`)(...Object.values(scope));
}

const initials = (name) => String(name || "").trim().split(/\s+/).filter(Boolean).map((p) => `${p[0].toUpperCase()}.`).join("");
const inc = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };
const km = (m) => Math.round(m / 100) / 10;
function spread(list) {
	const s = list.filter(Number.isFinite).sort((a, b) => a - b);
	if (!s.length) return { count: 0 };
	const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
	return { count: s.length, medianKm: km(at(0.5)), p90Km: km(at(0.9)), maxKm: km(s[s.length - 1]), over1Km: s.filter((m) => m > 1000).length, overFloor: s.filter((m) => m > eldCheck.TIME_OFF_ELD_RULE.moveFloorMeters).length };
}
const verdictKey = (v) => (v.noEldData ? `confirmed_no_eld_data:${v.reason}` : `${v.state}:${v.reason}`);

async function buildReport(db, { sheetData, nowMs, days, shadow, names }) {
	const server = liftFromServer(db, sheetData);
	let loadIndex = null;
	if (sheetData) loadIndex = server.availabilityLoadIndexOf(await server.getJobTrackingCached());
	const today = server.appDay(new Date(nowMs));
	const yesterday = driverAvailability.shiftAvailabilityDay(today, -1);
	const normalize = server.normalizeDriverName;
	const monthClosed = (day) => server.periodWriteLocked(day.slice(0, 7));

	// 2 and 3: the live rows and what the first run would write.
	const live = db.prepare("SELECT id, from_date, to_date FROM driver_availability WHERE cancelled_at IS NULL").all();
	const plan = server.timeOffEldRunPlan({ nowMs, loadIndex });
	const firstRun = { rows: plan.rows.length, days: 0, byVerdict: {}, notices: 0, noticeLines: 0 };
	const perRow = [];
	for (const row of plan.rows) {
		let lines = 0;
		for (const p of row.days) {
			firstRun.days += 1;
			inc(firstRun.byVerdict, verdictKey(p.next));
			if (p.notice.first || p.notice.followup) lines += 1;
		}
		firstRun.noticeLines += lines;
		if (lines) firstRun.notices += 1;
		if (names) perRow.push({ driver: initials(row.driverName), from: row.from, to: row.to, days: row.days.map((p) => [p.day, verdictKey(p.next)]) });
	}
	const futureDays = live.reduce((n, r) => {
		let c = 0;
		for (let d = r.from_date > today ? r.from_date : today; d && d <= r.to_date; d = driverAvailability.shiftAvailabilityDay(d, 1)) c += 1;
		return n + c;
	}, 0);

	// 4: the shadow.
	let shadowOut = null;
	if (shadow) {
		const first = driverAvailability.shiftAvailabilityDay(yesterday, -(days - 1));
		const window = [];
		for (let d = first; d && d <= yesterday; d = driverAvailability.shiftAvailabilityDay(d, 1)) window.push(d);
		const covers = (key, day) => {
			if (!loadIndex) return null;
			for (const l of loadIndex.values()) {
				if (normalize(l.driver) !== key || (!driverAvailability.isAvailabilityDay(l.pickupKey) && !driverAvailability.isAvailabilityDay(l.dropoffKey))) continue;
				const w = driverAvailability.offDutyLoadWindow(l.pickupKey, l.dropoffKey, day);
				if (w.start <= day && day <= w.end) return true;
			}
			return false;
		};
		const out = {
			days, from: first, to: yesterday, drivers: 0, driversWithNoTruck: 0, driverDays: 0,
			byVerdict: {}, bySplit: {},
			s2: { zeroOdometerStretches: null, returnStretches: null, engineRanDays: 0, engineRanShare: 0 },
			s4: { noLoadDaysWithFixes: 0, notConfirmed: 0 },
			s4b: { noLoadDarkDays: 0, closedMonthLeftOut: 0, confirmed: 0, confirmedNoEldData: 0, notConfirmed: 0, requested: 0, checking: 0, notConfirmedShare: 0 },
			loadsChecked: !!loadIndex, perDriver: [],
		};
		const zeroOdo = [];
		const back = [];
		const seenStretch = new Set();
		for (const dir of db.prepare("SELECT id, driver_name FROM drivers_directory ORDER BY id").all()) {
			const key = normalize(dir.driver_name);
			if (!key) continue;
			const ev = server.timeOffDayEvidence({ driverName: dir.driver_name, fromDay: first, toDay: yesterday, nowMs });
			const held = eldCheck.timeOffDriverContexts({ driverKey: key, normalize, assignments: ev.assignments, deviceRows: ev.deviceRows, deviceStartMs: ev.deviceStartMs, currentLinks: ev.currentLinks, fromMs: ev.fetchFromMs })
				.contexts.some((c) => c.toMs > ev.fetchFromMs && c.fromMs < ev.fetchToMs);
			if (!held) { out.driversWithNoTruck += 1; continue; }
			out.drivers += 1;
			const verdicts = eldCheck.judgeTimeOffDays({ days: window, anchorOf: (d) => d, driverKey: key, normalize, evidence: ev, nowMs });
			const mine = [];
			for (const day of window) {
				const v = verdicts.get(day);
				out.driverDays += 1;
				inc(out.byVerdict, verdictKey(v));
				const load = covers(key, day);
				const split = `${load === null ? "loads_not_checked" : load ? "load" : "no_load"}|${v.darkSpell ? "dark_spell" : v.samples > 0 ? "fixes" : "neither"}`;
				out.bySplit[split] = out.bySplit[split] || {};
				inc(out.bySplit[split], verdictKey(v));
				if (v.reason === "engine_ran_while_dark") out.s2.engineRanDays += 1;
				for (const st of v.stretches) {
					const id = `${v.vehicleIds.join(",")}|${st.fromMs}|${st.toMs}`;
					if (seenStretch.has(id) || !Number.isFinite(st.distanceM)) continue;
					seenStretch.add(id);
					if (st.odoStepMi === 0) zeroOdo.push(st.distanceM);
					if (st.afterMoving) back.push(st.distanceM);
				}
				if (load === false && v.samples > 0) {
					out.s4.noLoadDaysWithFixes += 1;
					if (v.state === "not_confirmed") out.s4.notConfirmed += 1;
				}
				if (load === false && v.darkSpell) {
					if (monthClosed(day)) { out.s4b.closedMonthLeftOut += 1; continue; }
					out.s4b.noLoadDarkDays += 1;
					if (v.noEldData) out.s4b.confirmedNoEldData += 1;
					else if (v.state === "confirmed") out.s4b.confirmed += 1;
					else if (v.state === "not_confirmed") out.s4b.notConfirmed += 1;
					else if (v.state === "no_data") out.s4b.requested += 1;
					else out.s4b.checking += 1;
				}
				if (names) mine.push([day, verdictKey(v)]);
			}
			if (names) out.perDriver.push({ driver: initials(dir.driver_name), days: mine });
		}
		out.s2.zeroOdometerStretches = spread(zeroOdo);
		out.s2.returnStretches = spread(back);
		out.s2.engineRanShare = out.driverDays ? Math.round((out.s2.engineRanDays / out.driverDays) * 1000) / 1000 : 0;
		const notConfirmedB = out.s4b.noLoadDarkDays - out.s4b.confirmed - out.s4b.confirmedNoEldData;
		out.s4b.notConfirmedShare = out.s4b.noLoadDarkDays ? Math.round((notConfirmedB / out.s4b.noLoadDarkDays) * 1000) / 1000 : 0;
		shadowOut = out;
	}

	// 5: continuity breaks and engine-hours advances across dark stretches, per device.
	const devices = buildDeviceScan(db, { nowMs, monthClosed, names });

	// 6: drivers whose current truck has no ELD link.
	const unlinked = db.prepare(`
		SELECT DISTINCT ta.driver_name, t.unit_number FROM truck_assignments ta JOIN trucks t ON t.id = ta.truck_id
		WHERE COALESCE(ta.end_date, '') = '' AND COALESCE(t.routemate_vehicle_id, '') = ''
	`).all();

	// 7: the fingerprint.
	const has = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
	const fingerprint = {
		invoices: has("invoices") ? db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n : null,
		excluded_driver_days: has("excluded_driver_days") ? db.prepare("SELECT COUNT(*) AS n FROM excluded_driver_days").get().n : null,
		invoice_paid_days: has("invoice_paid_days") ? db.prepare("SELECT COUNT(*) AS n FROM invoice_paid_days").get().n : null,
	};
	return {
		generatedAt: new Date().toISOString(), asOf: new Date(nowMs).toISOString(), today, rule: eldCheck.TIME_OFF_ELD_RULE,
		flags: "not read here: the start-up line ([time-off-eld] ELD check ON/OFF) and the bugs.md record say",
		liveRows: { rows: live.length, bySource: { staff: live.length }, daysToCheck: firstRun.days, futureDays },
		firstRun, perRow,
		shadow: shadowOut,
		devices,
		unlinked: { drivers: new Set(unlinked.map((u) => normalize(u.driver_name))).size, ...(names ? { list: unlinked.map((u) => ({ driver: initials(u.driver_name), unit: u.unit_number })) } : {}) },
		fingerprint,
	};
}

// Every linked device's retained readings, a link at a time (the device history
// resolver), for the continuity breaks and the engine-hours advances across
// silences over 30 minutes with both ends read over 0.
function buildDeviceScan(db, { nowMs, monthClosed, names }) {
	const rule = eldCheck.TIME_OFF_ELD_RULE;
	const units = new Map(db.prepare("SELECT id, unit_number FROM trucks").all().map((t) => [t.id, t.unit_number || ""]));
	const vids = [...new Set([
		...db.prepare("SELECT routemate_vehicle_id AS vid FROM trucks WHERE COALESCE(routemate_vehicle_id, '') <> ''").all().map((r) => r.vid),
		...db.prepare("SELECT routemate_vehicle_id AS vid FROM eld_device_assignments").all().map((r) => r.vid),
	])].sort();
	const assignments = db.prepare("SELECT truck_id, routemate_vehicle_id, assigned_from, assigned_until FROM eld_device_assignments").all();
	const startRow = (() => { try { return db.prepare("SELECT value FROM server_state WHERE key = 'eld_device_history_started'").get(); } catch { return null; } })();
	let startMs = null;
	try { startMs = startRow ? JSON.parse(startRow.value).atMs : null; } catch { startMs = null; }
	const resolver = eldMiles.buildDeviceTruckResolver(assignments, {
		startMs, currentLinks: db.prepare("SELECT id, routemate_vehicle_id FROM trucks WHERE COALESCE(routemate_vehicle_id, '') <> ''").all(),
	});
	const fixes = db.prepare(`
		SELECT location_date_ms AS ms, MAX(odometer) AS odo, MAX(engine_hours) AS eh, MAX(latitude) AS lat, MAX(longitude) AS lng, MAX(speed) AS speed, MAX(source) AS source
		FROM routemate_telemetry WHERE routemate_vehicle_id = ? AND dropped_reason = '' AND location_date_ms >= ?
		GROUP BY location_date_ms ORDER BY location_date_ms ASC
	`);
	const out = { devices: vids.length, devicesWithBreaks: 0, breaks: {}, breaksInClosedMonths: 0, devicesWithEngineRan: 0, engineRanStretches: 0, list: [] };
	for (const vid of vids) {
		const all = fixes.all(vid, nowMs - (rule.lookbackDays * DAY_MS));
		const byTruck = new Map();
		for (const f of all) {
			const t = resolver.truckForVehicleAt(vid, f.ms);
			if (!t) continue;
			if (!byTruck.has(t)) byTruck.set(t, []);
			byTruck.get(t).push(f);
		}
		let breaks = 0;
		let engineRan = 0;
		const episodes = [];
		for (const [truckId, list] of byTruck) {
			for (const b of eldCheck.continuityBreaks(list)) {
				breaks += 1;
				inc(out.breaks, b.kind);
				if (monthClosed(b.day)) out.breaksInClosedMonths += 1;
				if (names) episodes.push({ unit: units.get(truckId) || "", day: b.day, kind: b.kind });
			}
			for (let i = 1; i < list.length; i++) {
				if (list[i].ms - list[i - 1].ms <= rule.darkStretchMs) continue;
				const st = eldCheck.judgeDarkStretch(list[i - 1], list[i]);
				if (!st.engineRan) continue;
				engineRan += 1;
				if (names) episodes.push({ unit: units.get(truckId) || "", from: new Date(st.fromMs).toISOString().slice(0, 10), kind: "engine_ran_while_dark", hours: Math.round(st.engineAdvanceH * 10) / 10 });
			}
		}
		if (breaks) out.devicesWithBreaks += 1;
		if (engineRan) out.devicesWithEngineRan += 1;
		out.engineRanStretches += engineRan;
		if (names && episodes.length) out.list.push(...episodes);
	}
	if (!names) delete out.list;
	return out;
}

function printText(r) {
	const L = [];
	const pairs = (obj) => Object.entries(obj || {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join("; ") || "none";
	L.push(`Time-off ELD check: what would change, as of ${r.asOf} (business day ${r.today}). Read-only; nothing was written. Rule version ${r.rule.version}.`);
	L.push(`1. Flags: ${r.flags}.`);
	L.push(`2. Live time-off rows: ${r.liveRows.rows} (by source: staff ${r.liveRows.bySource.staff}); finished days to check ${r.liveRows.daysToCheck}; days still to come ${r.liveRows.futureDays}.`);
	L.push(`3. The first run would write ${r.firstRun.days} day result(s) for ${r.firstRun.rows} row(s): ${pairs(r.firstRun.byVerdict)}. Notices: ${r.firstRun.notices} (${r.firstRun.noticeLines} day line(s)).`);
	for (const row of r.perRow) L.push(`   ${row.driver} ${row.from}..${row.to}: ${row.days.map(([d, v]) => `${d} ${v}`).join(", ")}`);
	if (r.shadow) {
		const s = r.shadow;
		L.push(`4. Shadow, ${s.from}..${s.to} (${s.days} days), each day judged as its own one-day row: ${s.drivers} driver(s) held a truck (${s.driversWithNoTruck} held none), ${s.driverDays} driver-day(s).`);
		L.push(`   By verdict: ${pairs(s.byVerdict)}.`);
		L.push(`   "Confirmed (no ELD data)": ${Object.entries(s.byVerdict).filter(([k]) => k.startsWith("confirmed_no_eld_data:")).reduce((n, [, c]) => n + c, 0)} driver-day(s).`);
		for (const [split, counts] of Object.entries(s.bySplit).sort()) L.push(`   ${split}: ${pairs(counts)}`);
		if (!s.loadsChecked) L.push("   Loads not checked (no --values-json): the load splits, S4 and S4b read \"not checked\".");
		const sp = (x) => (x.count ? `${x.count} (median ${x.medianKm} km, 90th ${x.p90Km} km, max ${x.maxKm} km; over 1 km ${x.over1Km}, over the 5 mi floor ${x.overFloor})` : "0");
		L.push(`   S2: dark stretches with a 0 mi odometer step: ${sp(s.s2.zeroOdometerStretches)}; ending moving (return days): ${sp(s.s2.returnStretches)}; days the 1 h engine rule keeps Requested: ${s.s2.engineRanDays} (${s.s2.engineRanShare} of driver-days).`);
		L.push(`   S4: no-load days with fixes ${s.s4.noLoadDaysWithFixes}, of them Not confirmed ${s.s4.notConfirmed}.`);
		L.push(`   S4b: no-load dark-spell days ${s.s4b.noLoadDarkDays} (closed-month days left out: ${s.s4b.closedMonthLeftOut}): Confirmed ${s.s4b.confirmed}; Confirmed (no ELD data) ${s.s4b.confirmedNoEldData}; Not confirmed ${s.s4b.notConfirmed}; Requested ${s.s4b.requested}; Checking ${s.s4b.checking}. Share not Confirmed: ${s.s4b.notConfirmedShare}.`);
		for (const d of s.perDriver) L.push(`   ${d.driver}: ${d.days.map(([day, v]) => `${day} ${v}`).join(", ")}`);
	} else {
		L.push("4. Shadow: not run (--shadow).");
	}
	const dv = r.devices;
	L.push(`5. Devices scanned ${dv.devices}: continuity breaks ${pairs(dv.breaks)} on ${dv.devicesWithBreaks} device(s), ${dv.breaksInClosedMonths} in closed months (calibration only, never a pay issue); engine-hours advances over 1 h across dark stretches ${dv.engineRanStretches} on ${dv.devicesWithEngineRan} device(s).`);
	for (const e of dv.list || []) L.push(`   ${e.unit} ${e.day || e.from} ${e.kind}${e.hours ? ` +${e.hours} h` : ""}`);
	L.push(`6. Drivers whose current truck has no ELD link: ${r.unlinked.drivers}${r.unlinked.list ? ` (${r.unlinked.list.map((u) => `${u.driver} ${u.unit}`).join(", ")})` : ""}.`);
	L.push(`7. Fingerprint: invoices ${r.fingerprint.invoices}; excluded_driver_days ${r.fingerprint.excluded_driver_days}; invoice_paid_days ${r.fingerprint.invoice_paid_days}.`);
	console.log(L.join("\n"));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (typeof args.db !== "string" || !args.db.trim()) refuse("--db=<app.db> is required: the database to read (opened read-only)");
	const dbFile = path.resolve(args.db);
	if (!fs.existsSync(dbFile) || !fs.statSync(dbFile).isFile()) refuse(`--db=${args.db}: there is no such database file`);
	const days = args.days === undefined ? 35 : Number(args.days);
	if (!Number.isInteger(days) || days < 1 || days > 90) refuse("--days must be a whole number of days from 1 to 90");
	let nowMs = Date.now();
	if (args.now !== undefined) {
		if (typeof args.now !== "string" || !INSTANT_RE.test(args.now) || !Number.isFinite(Date.parse(args.now))) refuse("--now must be an ISO instant with its zone, e.g. 2026-10-15T16:00:00Z");
		nowMs = Date.parse(args.now);
	}
	let sheetData = null;
	if (args["values-json"] !== undefined) {
		if (typeof args["values-json"] !== "string") refuse("--values-json needs a file: a saved values.get of the Job Tracking tab");
		try { sheetData = JSON.parse(fs.readFileSync(path.resolve(args["values-json"]), "utf8")); } catch (err) { refuse(`--values-json: ${err.message}`); }
	}
	const db = openDb({ root: ROOT, dbFile, readonly: true });
	try {
		const missing = TABLES.filter((t) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
		if (missing.length) refuse(`the database has no ${missing.join(", ")} table: it is older than the check, or not this app's`);
		const result = await buildReport(db, { sheetData, nowMs, days, shadow: args.shadow === true, names: args.names === true });
		if (args.json === true) console.log(JSON.stringify(result, null, 1));
		else printText(result);
	} finally {
		db.close();
	}
}

module.exports = { LIFT_ROOTS, LIFT_DENIED };

if (require.main === module) {
	main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
}
