#!/usr/bin/env node
/**
 * The official pickup date (lib/arrival-pickup.js) and its pay window
 * (lib/load-pay-days.js payWindow(), the `arrival` answer), on their own: the
 * decision from one load's status history rows, the delivery that ends the
 * window, the per-request resolver and the two settings. No server is lifted.
 *
 *   §A the moment and the day: the geofence's moment is the ping's time
 *      (fix_ms), not the processing time; the day is the row's stored local_tz
 *      day (a Central or a Pacific evening is the day before the Eastern one),
 *      across the fall-back and spring-forward nights and either side of local
 *      midnight; never the app zone, a setting or the process zone
 *   §B taps: inside counts, outside never (far_tap), no position counts unless
 *      an At Receiver or Delivered follows within 15 minutes (batch_tap: 14:59
 *      and 15:00 are batches, 15:01 is not); staff rows and overrides never count
 *   §C the queued-load guard: other_load_hauling 1 never counts; unknown is
 *      unrecorded
 *   §D cuts: a staff reset, a re-dispatch, a staff Accept or Decline undo the
 *      arrival; the driver's own stale step, Accept or Decline do not; a move
 *      back only an old_status shows undoes, and that row itself can be the
 *      official pickup (the cut is inclusive); multi-stop keeps the first;
 *      arrivals before the last Cancelled are ignored; a row with no actor_role
 *      never counts, and its pre-arrival row undoes
 *   §E the same rows always give the same answer (any order, any clock or
 *      setting); the module reads no clock, radius, setting or lock
 *   §F the geofence moment is bounded: never before its predecessor or the
 *      latest dispatch (a repeated stale fix), never after the row
 *   §G the delivery: the first completed row of the current delivered run, in
 *      the stored zone (a later Completed does not move it, a re-delivery does);
 *      none in the history (completed in the sheet, or moved off Delivered) is a
 *      named fallback
 *   §H the resolver: scope (completed, the Assigned Date on or after FROM, as a
 *      Date or a day key, in every process zone), one history read per request,
 *      an unreadable history (an older copy without the columns) is an error,
 *      logged once
 *   §I the settings: on only when exactly "true"; FROM a real calendar date, a
 *      bad one warned by name, never by value; the start-up texts
 *   §J the window: from the arrival day to the later of the drop-off and the
 *      delivery (a late-at-both-ends load keeps its last day); after the drop-off
 *      it runs to the delivery; a blank drop-off ends at the delivery; neither on
 *      or after the arrival is the arrival day alone; local-midnight Dates; no
 *      answer leaves payWindow() exactly as it was
 *   §K the invoice's notes: the 2-day extension and the warning lines
 *   §M mutants of the two modules, each caught by the case it names
 *   §Z every case above again under TZ America/New_York, America/Chicago, UTC
 *      and Asia/Manila (child processes)
 *
 * Every case fails on a base without lib/arrival-pickup.js. Made-up loads and
 * times. Pure: an in-memory SQLite with server.js's own DDL for the table, no
 * server, no network.
 *   node scripts/test-arrival-pickup.js       # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const LIB_FILE = path.join(ROOT, "lib", "arrival-pickup.js");
const PAY_FILE = path.join(ROOT, "lib", "load-pay-days.js");
const CHILD = process.env.ARRIVAL_PICKUP_TZ_CHILD === "1";
const ZONES = ["America/New_York", "America/Chicago", "UTC", "Asia/Manila"];

let lib = null;
let libError = null;
try { lib = require(LIB_FILE); } catch (err) { libError = err; }
const pay = require(PAY_FILE);
const financialsCalc = require(path.join(ROOT, "lib", "financials-calc.js"));
let Database = null;
try { Database = require("better-sqlite3"); } catch (err) { console.error(`better-sqlite3 did not load (${err.message}); run it under the .nvmrc Node`); process.exit(1); }
const SRC = require("./lib/server-source").serverSource();

// ── the harness ───────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
async function test(name, fn) {
	const checks = [];
	const eq = (label, actual, expected) => checks.push({ ok: JSON.stringify(actual) === JSON.stringify(expected), label, detail: `expected ${JSON.stringify(expected)}\n             actual   ${JSON.stringify(actual)}` });
	const ok = (label, cond, detail = "") => checks.push({ ok: !!cond, label, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
	try {
		if (!lib) throw new Error(`lib/arrival-pickup.js did not load (${libError && libError.message})`);
		await fn({ eq, ok });
	} catch (err) {
		checks.push({ ok: false, label: "threw", detail: String((err && err.message) || err).split("\n")[0] });
	}
	const good = checks.length > 0 && checks.every((c) => c.ok);
	if (good) passed++; else failures.push(name);
	if (!good || !CHILD) console.log(`  ${good ? "ok  " : "FAIL"}  ${name}`);
	if (!good) {
		for (const c of checks.filter((x) => !x.ok).slice(0, 4)) console.log(`        - ${c.label}${c.detail ? `\n             ${c.detail}` : ""}`);
		if (!checks.length) console.log("        - no check ran");
	}
}
const section = (title) => { if (!CHILD) console.log(`\n${title}`); };

// ── made-up history rows ──────────────────────────────────────────────────────
const CHI = "America/Chicago";
const U = (s) => Date.parse(`${s.replace(" ", "T")}Z`);
let nextId = 1;
function H(at, status, o = {}) {
	return {
		id: o.id !== undefined ? o.id : nextId++, load_id: o.load || "l-1001", old_status: o.old !== undefined ? o.old : "", new_status: status,
		source: o.source || "manual", actor_role: o.role !== undefined ? o.role : "", fix_ms: o.fixMs !== undefined ? o.fixMs : null,
		pickup_zone: o.zone !== undefined ? o.zone : "", local_tz: o.tz !== undefined ? o.tz : "",
		other_load_hauling: o.hauling !== undefined ? o.hauling : null, changed_at: at,
	};
}
const dispatchRow = (at, o = {}) => H(at, "Dispatched", { source: "dispatch", role: "Dispatcher", ...o });
const acceptRow = (at, role = "Driver") => H(at, "Assigned", { source: "accept", role, old: "Dispatched" });
const declineRow = (at, role = "Driver") => H(at, "Unassigned", { source: "decline", role });
const stepRow = (at, status, o = {}) => H(at, status, { source: "manual", role: "Driver", ...o });
const geo = (at, o = {}) => H(at, "At Shipper", { source: "geofence", role: "system", zone: "inside", tz: CHI, hauling: 0, old: "Heading to Shipper", ...o });
const tapAt = (at, o = {}) => H(at, "At Shipper", { source: "manual", role: "Driver", zone: "inside", tz: CHI, old: "Heading to Shipper", ...o });
const overrideRow = (at, status, o = {}) => H(at, status, { source: "override", role: "Dispatcher", ...o });
const cancelRow = (at) => H(at, "Cancelled", { source: "cancel", role: "Super Admin" });
const delivered = (at, o = {}) => stepRow(at, "Delivered", { old: "At Receiver", ...o });
const pick = (r) => (r && r.none ? { none: r.none } : r && { day: r.day, ms: r.ms, zone: r.zone, source: r.source, rowId: r.rowId });
const decide = (rows) => pick(lib.officialPickup(rows));

// The shipped table: server.js's own CREATE TABLE and every ALTER on it.
function historyDb({ withRecorder = true } = {}) {
	const db = new Database(":memory:");
	const create = SRC.match(/CREATE TABLE IF NOT EXISTS load_status_history \([\s\S]*?\n\t\)/);
	if (!create) throw new Error("server.js has no load_status_history table");
	db.exec(create[0]);
	for (const sql of SRC.match(/ALTER TABLE load_status_history ADD COLUMN [^"`\n]*/g) || []) {
		if (!withRecorder && /ADD COLUMN (actor_role|fix_ms|pickup_distance_m|pickup_zone|local_tz|other_load_hauling)\b/.test(sql)) continue;
		try { db.exec(sql); } catch { /* the column exists */ }
	}
	return db;
}
function insertRows(db, rows) {
	const cols = db.prepare("PRAGMA table_info(load_status_history)").all().map((c) => c.name);
	for (const r of rows) {
		const use = Object.keys(r).filter((k) => cols.includes(k));
		db.prepare(`INSERT INTO load_status_history (${use.join(", ")}) VALUES (${use.map(() => "?").join(", ")})`).run(...use.map((k) => r[k]));
	}
}
// A load's usual history: dispatched Fri, accepted, heading Mon morning.
const lead = (load = "l-1001") => [
	dispatchRow("2026-12-04 15:00:00", { load }), { ...acceptRow("2026-12-04 15:10:00"), load_id: load },
	{ ...stepRow("2026-12-07 12:00:00", "Heading to Shipper", { old: "Assigned" }), load_id: load },
];

async function cases() {
	// ══ §A ═══════════════════════════════════════════════════════════════════
	section("§A the moment and the day");
	await test("A1 the geofence's moment is its fix_ms (05:50 UTC = 23:50 CST Dec 8), not changed_at (06:10 UTC, Dec 9)", ({ eq }) => {
		const rows = [...lead(), geo("2026-12-09 06:10:00", { fixMs: U("2026-12-09 05:50:00") })];
		eq("the official pickup", decide(rows), { day: "2026-12-08", ms: U("2026-12-09 05:50:00"), zone: CHI, source: "geofence", rowId: rows[3].id });
	});
	await test("A2 the shipper-local day: 05:20 UTC Dec 9 at a Central shipper is Dec 8; 05:30 UTC Dec 9 at a Pacific one is Dec 8 (Eastern: Dec 9)", ({ eq }) => {
		const central = decide([...lead(), geo("2026-12-09 05:21:00", { fixMs: U("2026-12-09 05:20:00") })]);
		const pacific = decide([...lead(), geo("2026-12-09 05:31:00", { fixMs: U("2026-12-09 05:30:00"), tz: "America/Los_Angeles" })]);
		const eastern = decide([...lead(), geo("2026-12-09 05:31:00", { fixMs: U("2026-12-09 05:30:00"), tz: "America/New_York" })]);
		eq("[central, pacific, eastern]", [central.day, pacific.day, eastern.day], ["2026-12-08", "2026-12-08", "2026-12-09"]);
	});
	// The geofence row 59 s after its fix, dispatched the afternoon before.
	const nightOf = (fix) => decide([dispatchRow(`${new Date(U(fix) - 12 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ")}`),
		geo(fix.replace(/:\d\d$/, ":59"), { fixMs: U(fix), old: "Dispatched" })]).day;
	await test("A3 across the fall-back night (Nov 1 2026): 04:30 UTC Nov 1 is Oct 31 (CDT); 05:30 UTC Nov 2 is Nov 1 (CST); 05:59 is Nov 1, 06:01 is Nov 2", ({ eq }) => {
		eq("days", ["2026-11-01 04:30:00", "2026-11-02 05:30:00", "2026-11-02 05:59:00", "2026-11-02 06:01:00"].map(nightOf),
			["2026-10-31", "2026-11-01", "2026-11-01", "2026-11-02"]);
	});
	await test("A4 across the spring-forward night (Mar 8 2026): 05:30 UTC is Mar 7 23:30 CST; 07:59 UTC is Mar 8 01:59 CST; 08:30 UTC is Mar 8 03:30 CDT", ({ eq }) => {
		eq("days", ["2026-03-08 05:30:00", "2026-03-08 07:59:00", "2026-03-08 08:30:00"].map(nightOf), ["2026-03-07", "2026-03-08", "2026-03-08"]);
	});
	await test("A5 either side of local midnight on a tap: 05:59:59 UTC is Dec 8 23:59:59 CST, 06:00:00 UTC is Dec 9 00:00 CST", ({ eq }) => {
		eq("days", [decide([...lead(), tapAt("2026-12-09 05:59:59")]).day, decide([...lead(), tapAt("2026-12-09 06:00:00")]).day], ["2026-12-08", "2026-12-09"]);
	});
	await test("A6 the zone is always the stored local_tz (Denver, New York, Manila): never the app zone, a setting or the process zone", ({ eq }) => {
		const fix = U("2026-12-08 16:30:00");
		const day = (tz) => decide([...lead(), geo("2026-12-08 16:31:00", { fixMs: fix, tz })]).day;
		const before = ["America/Denver", "America/New_York", "Asia/Manila"].map(day);
		const saved = { app: process.env.APP_TIMEZONE, tz: process.env.TZ };
		process.env.APP_TIMEZONE = "Pacific/Honolulu";
		const after = ["America/Denver", "America/New_York", "Asia/Manila"].map(day);
		if (saved.app === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = saved.app;
		eq("[Denver, New York, Manila]", before, ["2026-12-08", "2026-12-08", "2026-12-09"]);
		eq("the same with APP_TIMEZONE set to another zone", after, before);
	});

	// ══ §B ═══════════════════════════════════════════════════════════════════
	section("§B taps");
	await test("B1 a Driver's tap inside the pickup zone counts, its moment the tap's arrival at the server", ({ eq }) => {
		const rows = [...lead(), tapAt("2026-12-08 14:40:00", { fixMs: U("2026-12-08 14:39:00") })];
		eq("answer", decide(rows), { day: "2026-12-08", ms: U("2026-12-08 14:40:00"), zone: CHI, source: "driver", rowId: rows[3].id });
	});
	await test("B2 a tap outside the zone never counts: far_tap", ({ eq }) => {
		eq("answer", decide([...lead(), tapAt("2026-12-08 14:40:00", { zone: "outside" })]), { none: "far_tap" });
	});
	await test("B3 a tap with no known position and no delivery tap within 15 minutes counts", ({ eq }) => {
		const rows = [...lead(), tapAt("2026-12-08 14:00:00", { zone: "" }), stepRow("2026-12-08 14:05:00", "Loading", { old: "At Shipper" }),
			stepRow("2026-12-08 14:09:00", "In Transit", { old: "Loading" }), stepRow("2026-12-08 20:00:00", "At Receiver", { old: "In Transit" })];
		eq("answer", decide(rows).source, "driver");
	});
	await test("B4 the batch edge: an At Receiver 14:59 or 15:00 after a no-position tap is a batch tap; 15:01 is not; a Delivered 10 minutes after is a batch", ({ eq }) => {
		const after = (gap, status = "At Receiver") => decide([...lead(), tapAt("2026-12-08 14:00:00", { zone: "" }),
			stepRow(`2026-12-08 14:${gap}`, status, { old: "At Shipper" })]);
		eq("[14:59, 15:00, 15:01, Delivered 10:00]", [after("14:59"), after("15:00"), after("15:01").source, after("10:00", "Delivered")],
			[{ none: "batch_tap" }, { none: "batch_tap" }, "driver", { none: "batch_tap" }]);
	});
	await test("B5 the batch test is for a tap with no position only: an inside tap followed by At Receiver 2 minutes later still counts", ({ eq }) => {
		eq("answer", decide([...lead(), tapAt("2026-12-08 14:00:00"), stepRow("2026-12-08 14:02:00", "At Receiver", { old: "At Shipper" })]).source, "driver");
	});
	await test("B6 staff never set the pickup: a Dispatcher's or Super Admin's dropdown tap, inside, and an override: staff_only", ({ eq }) => {
		eq("[dispatcher tap, admin tap, override]", [
			decide([...lead(), tapAt("2026-12-08 14:00:00", { role: "Dispatcher" })]),
			decide([...lead(), tapAt("2026-12-08 14:00:00", { role: "Super Admin" })]),
			decide([...lead(), overrideRow("2026-12-08 14:00:00", "At Shipper", { old: "Heading to Shipper" })]),
		], [{ none: "staff_only" }, { none: "staff_only" }, { none: "staff_only" }]);
	});
	await test("B7 a staff set is passed over for the first qualifying arrival after it", ({ eq }) => {
		const rows = [...lead(), tapAt("2026-12-08 14:00:00", { role: "Dispatcher" }), tapAt("2026-12-08 15:30:00", { old: "At Shipper" })];
		eq("answer", decide(rows).rowId, rows[4].id);
	});

	// ══ §C ═══════════════════════════════════════════════════════════════════
	section("§C the queued-load guard");
	await test("C1 a geofence arrival while another load was under way never counts (hauling_other_load); one with no list is unrecorded", ({ eq }) => {
		eq("[hauling 1, hauling null]", [decide([...lead(), geo("2026-12-08 14:40:00", { hauling: 1 })]), decide([...lead(), geo("2026-12-08 14:40:00", { hauling: null })])],
			[{ none: "hauling_other_load" }, { none: "unrecorded" }]);
	});

	// ══ §D ═══════════════════════════════════════════════════════════════════
	section("§D cuts");
	await test("D1 a staff reset undoes the yard arrival and the geofence's re-fire at the dock is the official pickup (L-1006)", ({ eq }) => {
		const rows = [...lead(), geo("2026-12-07 13:10:00", { fixMs: U("2026-12-07 13:10:00") }),
			stepRow("2026-12-07 13:40:00", "Heading to Shipper", { role: "Super Admin", old: "At Shipper" }), geo("2026-12-07 14:05:00", { fixMs: U("2026-12-07 14:05:00") })];
		eq("answer", decide(rows), { day: "2026-12-07", ms: U("2026-12-07 14:05:00"), zone: CHI, source: "geofence", rowId: rows[5].id });
	});
	await test("D2 a re-dispatch, a staff Accept, a staff Decline and an override back each undo an arrival with nothing after it: undone", ({ eq }) => {
		const base = () => [...lead(), geo("2026-12-08 14:40:00")];
		eq("answers", [
			decide([...base(), dispatchRow("2026-12-08 16:00:00")]),
			decide([...base(), acceptRow("2026-12-08 16:00:00", "Dispatcher")]),
			decide([...base(), declineRow("2026-12-08 16:00:00", "Super Admin")]),
			decide([...base(), overrideRow("2026-12-08 16:00:00", "Heading to Shipper", { old: "At Shipper" })]),
		], Array(4).fill({ none: "undone" }));
	});
	await test("D3 the driver's own stale steps never undo: his backward tap, his Accept (always written Dispatched -> Assigned) and his Decline", ({ eq }) => {
		const base = () => [...lead(), geo("2026-12-08 14:40:00", { fixMs: U("2026-12-08 14:39:00") })];
		const day = (extra) => decide([...base(), extra]).ms;
		eq("each keeps the geofence arrival", [
			day(stepRow("2026-12-08 15:00:00", "Heading to Shipper", { old: "At Shipper" })),
			day(acceptRow("2026-12-08 15:00:00", "Driver")),
			day(declineRow("2026-12-08 15:00:00", "Driver")),
		], Array(3).fill(U("2026-12-08 14:39:00")));
	});
	await test("D4 a move back only the next row's old_status shows (a row editor or the sheet) undoes, and that re-firing row is itself the official pickup", ({ eq }) => {
		const rows = [...lead(), geo("2026-12-08 13:00:00"), stepRow("2026-12-08 13:30:00", "Loading", { old: "At Shipper" }),
			geo("2026-12-08 17:00:00", { old: "Heading to Shipper" })];
		eq("the second geofence row", decide(rows).rowId, rows[5].id);
		const tapBack = [...lead(), geo("2026-12-08 13:00:00"), stepRow("2026-12-08 13:30:00", "In Transit", { old: "At Shipper" }),
			tapAt("2026-12-08 17:00:00", { zone: "outside", old: "Heading to Shipper" })];
		eq("a far tap after such a move back: the first arrival is undone, the far tap does not count", decide(tapBack), { none: "far_tap" });
	});
	await test("D5 multi-stop: a second pickup's At Shipper after In Transit is no move back; the first pickup's arrival stays", ({ eq }) => {
		const rows = [...lead(), geo("2026-12-08 13:00:00"), stepRow("2026-12-08 14:00:00", "Loading", { old: "At Shipper" }),
			stepRow("2026-12-08 15:00:00", "In Transit", { old: "Loading" }), tapAt("2026-12-09 15:00:00", { old: "In Transit" })];
		eq("the first", decide(rows).rowId, rows[3].id);
	});
	await test("D6 arrivals before the last Cancelled are ignored", ({ eq }) => {
		const rows = [...lead(), geo("2026-12-08 13:00:00"), cancelRow("2026-12-08 14:00:00"), dispatchRow("2026-12-09 15:00:00"),
			tapAt("2026-12-10 15:00:00", { old: "Dispatched" })];
		eq("the arrival after the cancel", decide(rows).rowId, rows[6].id);
		eq("only cancelled arrivals: none", decide(rows.slice(0, 5)), { none: "no_at_shipper" });
		eq("reinstated with no row, then a far tap: the far tap's reason", decide([...rows.slice(0, 5), tapAt("2026-12-10 15:00:00", { zone: "outside", old: "Assigned" })]), { none: "far_tap" });
	});
	await test("D7 a row the recorder did not write never counts (unrecorded), and its pre-arrival row undoes", ({ eq }) => {
		eq("an At Shipper with no actor_role", decide([...lead(), tapAt("2026-12-08 14:00:00", { role: "" })]), { none: "unrecorded" });
		eq("a recorded arrival, then an unrecorded Heading to Shipper", decide([...lead(), geo("2026-12-08 14:00:00"), stepRow("2026-12-08 15:00:00", "Heading to Shipper", { role: "", old: "At Shipper" })]), { none: "undone" });
	});
	await test("D8 no At Shipper at all: no_at_shipper; an arrival that never qualified before a cut keeps its own reason", ({ eq }) => {
		eq("[no row, staff set then reset]", [decide([...lead(), delivered("2026-12-10 18:00:00")]),
			decide([...lead(), tapAt("2026-12-08 14:00:00", { role: "Dispatcher" }), dispatchRow("2026-12-08 15:00:00")])],
		[{ none: "no_at_shipper" }, { none: "staff_only" }]);
	});

	// ══ §E ═══════════════════════════════════════════════════════════════════
	section("§E the same rows, the same answer");
	await test("E1 any order of the rows, any clock: the same answer; ties on changed_at go by id", ({ eq }) => {
		const rows = [...lead(), tapAt("2026-12-08 14:00:00", { role: "Dispatcher" }), geo("2026-12-08 14:00:00", { fixMs: U("2026-12-08 13:59:00") }),
			stepRow("2026-12-08 15:00:00", "Loading", { old: "At Shipper" })];
		const a = decide(rows);
		const b = decide([...rows].reverse());
		const realNow = Date.now;
		Date.now = () => Date.parse("2031-01-01T00:00:00Z");
		const c = decide(rows);
		Date.now = realNow;
		eq("[as given, reversed, another clock]", [b, c], [a, a]);
		eq("the geofence row, after the staff row of the same second", a.rowId, rows[4].id);
	});
	await test("E2 the module reads no clock, radius, setting (beyond the env handed to ruleFromEnv()), month lock or file", ({ eq }) => {
		const text = fs.readFileSync(LIB_FILE, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
		eq("[Date.now, new Date(), process., GEOFENCE, period_locks, isLocked, fs]",
			[/Date\.now\(/.test(text), /new Date\(\)/.test(text), /\bprocess\./.test(text), /GEOFENCE/.test(text), /period_locks/.test(text), /isLocked/.test(text), /require\("fs"\)/.test(text)],
			[false, false, false, false, false, false, false]);
		eq("its requires", [...text.matchAll(/require\(([^)]{1,60})\)/g)].map((m) => m[1]).sort(), ["\"./eld-miles\"", "\"./expense-window\""]);
	});

	// ══ §F ═══════════════════════════════════════════════════════════════════
	section("§F the geofence moment, bounded");
	await test("F1 a repeated fix 2 days before the dispatch: the moment is the dispatch (its predecessor), Dec 7, not Dec 5", ({ eq }) => {
		const rows = [dispatchRow("2026-12-07 15:00:00"), geo("2026-12-07 15:01:00", { fixMs: U("2026-12-05 12:00:00"), old: "Dispatched" })];
		eq("answer", decide(rows), { day: "2026-12-07", ms: U("2026-12-07 15:00:00"), zone: CHI, source: "geofence", rowId: rows[1].id });
	});
	await test("F2 the predecessor bounds it with no dispatch row; the latest dispatch bounds it past an earlier predecessor; a fix stamped after the row is capped at the row", ({ eq }) => {
		const a = decide([stepRow("2026-12-07 14:00:00", "Heading to Shipper", { old: "Assigned" }), geo("2026-12-07 15:01:00", { fixMs: U("2026-12-05 12:00:00") })]);
		const b = decide([dispatchRow("2026-12-03 15:00:00"), cancelRow("2026-12-04 09:00:00"), dispatchRow("2026-12-06 15:00:00"),
			acceptRow("2026-12-06 15:00:00"), geo("2026-12-07 15:01:00", { fixMs: U("2026-12-05 12:00:00"), old: "Assigned" })]);
		const c = decide([...lead(), geo("2026-12-08 15:00:00", { fixMs: U("2026-12-08 18:00:00") })]);
		eq("[predecessor, accept after the latest dispatch, capped]", [a.ms, b.ms, c.ms], [U("2026-12-07 14:00:00"), U("2026-12-06 15:00:00"), U("2026-12-08 15:00:00")]);
	});

	// ══ §G ═══════════════════════════════════════════════════════════════════
	section("§G the delivery");
	await test("G1 the first Delivered row of the current delivery, in the stored zone: 05:30 UTC Dec 11 at a Central shipper is Dec 10", ({ eq }) => {
		const rows = [...lead(), geo("2026-12-08 14:40:00"), delivered("2026-12-11 05:30:00")];
		eq("delivery", lib.deliveryOf(rows, CHI), { ms: U("2026-12-11 05:30:00"), day: "2026-12-10" });
	});
	await test("G2 a Completed set 5 days later is the same delivery; a load moved off Delivered and delivered again is the second delivery", ({ eq }) => {
		const later = [...lead(), geo("2026-12-08 14:40:00"), delivered("2026-12-10 18:00:00"), overrideRow("2026-12-15 15:00:00", "Completed", { old: "Delivered", role: "Super Admin" })];
		const again = [...lead(), geo("2026-12-08 14:40:00"), delivered("2026-12-10 18:00:00"), overrideRow("2026-12-11 15:00:00", "In Transit", { old: "Delivered" }),
			delivered("2026-12-12 18:00:00", { old: "In Transit" })];
		eq("[later Completed, delivered again]", [lib.deliveryOf(later, CHI).day, lib.deliveryOf(again, CHI).day], ["2026-12-10", "2026-12-12"]);
	});
	await test("G3 no delivery in the history (completed in the sheet), or Delivered then a later row off it: none", ({ eq }) => {
		const none = [...lead(), geo("2026-12-08 14:40:00"), stepRow("2026-12-09 15:00:00", "In Transit", { old: "Loading" })];
		const off = [...lead(), geo("2026-12-08 14:40:00"), delivered("2026-12-10 18:00:00"), stepRow("2026-12-11 15:00:00", "At Receiver", { old: "In Transit" })];
		eq("[none, moved off]", [lib.deliveryOf(none, CHI), lib.deliveryOf(off, CHI)], [null, null]);
	});

	// ══ §H ═══════════════════════════════════════════════════════════════════
	section("§H the resolver");
	const FROM = "2026-11-20";
	const fullLoad = (load) => [...lead(load), { ...geo("2026-12-08 14:40:00", { fixMs: U("2026-12-08 14:39:00") }), load_id: load }, { ...delivered("2026-12-11 05:30:00"), load_id: load }];
	await test("H1 an in-scope load: the arrival day, the delivery day in the shipper's zone, the arrival and the delivery's instant", ({ eq }) => {
		const db = historyDb();
		insertRows(db, fullLoad("l-1001"));
		const r = lib.createArrivalResolver({ db, fromDay: FROM });
		const a = r.forLoad({ loadId: "#L-1001", assigned: "2026-12-04", completed: true });
		eq("answer", [a.start, a.delivered, a.deliveredMs, a.arrival.source, a.arrival.zone], ["2026-12-08", "2026-12-10", U("2026-12-11 05:30:00"), "geofence", CHI]);
	});
	await test("H2 scope: not completed, an Assigned Date before FROM, none, or one that is no date: null; FROM itself and a local-midnight Date in scope", ({ eq }) => {
		const db = historyDb();
		insertRows(db, fullLoad("l-1001"));
		const r = lib.createArrivalResolver({ db, fromDay: FROM });
		const ans = (assigned, completed = true) => { const a = r.forLoad({ loadId: "L-1001", assigned, completed }); return a && (a.start || a.none || a.error || "?"); };
		eq("answers", [ans("2026-12-04", false), ans("2026-11-19"), ans(null), ans("TBD"), ans("2026-11-20"), ans(new Date(2026, 11, 4)), ans(new Date(2026, 10, 19))],
			[null, null, null, null, "2026-12-08", "2026-12-08", null]);
	});
	await test("H3 the history is read once per request; another load's rows never leak; no load id has no arrival; a load with no delivery is a named fallback", ({ eq }) => {
		const db = historyDb();
		insertRows(db, [...fullLoad("l-1001"), ...lead("l-1002"), { ...geo("2026-12-09 14:00:00"), load_id: "l-1002" }]);
		let reads = 0;
		const counted = new Proxy(db, { get(t, p) { if (p === "prepare") return (sql) => { if (/FROM load_status_history/.test(sql)) reads++; return t.prepare(sql); }; const v = t[p]; return typeof v === "function" ? v.bind(t) : v; } });
		const r = lib.createArrivalResolver({ db: counted, fromDay: FROM });
		const a = r.forLoad({ loadId: "L-1001", assigned: "2026-12-04", completed: true });
		const b = r.forLoad({ loadId: "L-1002", assigned: "2026-12-04", completed: true });
		const c = r.forLoad({ loadId: "", assigned: "2026-12-04", completed: true });
		r.forLoad({ loadId: "L-1001", assigned: "2026-12-04", completed: true });
		eq("[reads, L-1001, L-1002, no id]", [reads, a.start, b.fallback ? "fallback" : b, c], [1, "2026-12-08", "fallback", { none: "no_at_shipper" }]);
		eq("fallbacks()", r.fallbacks().map((f) => f.loadId), ["L-1002"]);
	});
	await test("H4 an older copy without the recorder's columns: every in-scope load answers { error }, logged once; the rule off or FROM no date: no resolver", ({ eq, ok }) => {
		const db = historyDb({ withRecorder: false });
		insertRows(db, fullLoad("l-1001"));
		const logged = [];
		const r = lib.createArrivalResolver({ db, fromDay: FROM, log: (m) => logged.push(m) });
		const a = r.forLoad({ loadId: "L-1001", assigned: "2026-12-04", completed: true });
		const b = r.forLoad({ loadId: "L-1009", assigned: "2026-12-05", completed: true });
		ok("an error naming the missing column", a && /no such column/.test(a.error || ""), a);
		eq("[the second load errors too, one log line, errors()]", [!!(b && b.error), logged.length, r.errors().map((e) => e.loadId)], [true, 1, ["L-1001", "L-1009"]]);
		eq("[no FROM, a FROM that is no date, ledgerResolver() off]", [lib.createArrivalResolver({ db, fromDay: null }), lib.createArrivalResolver({ db, fromDay: "2026-02-30" }),
			lib.ledgerResolver({ db, env: {} })], [null, null, null]);
		ok("ledgerResolver(): a caller's rules.arrivalFrom wins over the environment", !!lib.ledgerResolver({ db, env: {}, rules: { arrivalFrom: FROM } })
			&& lib.ledgerResolver({ db, env: { ARRIVAL_PICKUP_DATE_ENABLED: "true", ARRIVAL_PICKUP_DATE_FROM: FROM }, rules: { arrivalFrom: null } }) === null);
	});

	// ══ §I ═══════════════════════════════════════════════════════════════════
	section("§I the settings");
	await test("I1 on only when exactly \"true\", and only with a real calendar date for FROM; a bad FROM is warned by name, never by value", ({ eq, ok }) => {
		const read = (enabled, from) => { const said = []; return { from: lib.ruleFromEnv({ ARRIVAL_PICKUP_DATE_ENABLED: enabled, ARRIVAL_PICKUP_DATE_FROM: from }, (m) => said.push(m)), said }; };
		eq("ENABLED values", ["true", "TRUE", "True", "1", "yes", "on", " true", "", undefined].map((v) => read(v, "2026-11-20").from),
			["2026-11-20", null, null, null, null, null, null, null, null]);
		eq("FROM values", ["2026-11-20", " 2026-11-20 ", "2026-02-30", "2026-11", "11/20/2026", "", undefined].map((v) => read("true", v).from),
			["2026-11-20", "2026-11-20", null, null, null, null, null]);
		const bad = read("true", "2026-02-30");
		eq("one warning", bad.said.length, 1);
		ok("...naming the setting, never its value", /ARRIVAL_PICKUP_DATE_FROM/.test(bad.said[0]) && !bad.said[0].includes("2026-02-30"), bad.said);
		eq("off: no warning", read("false", "junk").said, []);
	});
	await test("I2 the start-up texts: the state line, the recorder-off warning, the closed-month notice from FROM's month", ({ eq, ok }) => {
		eq("state lines", [lib.stateLine("2026-11-20"), lib.stateLine(null)], ["ARRIVAL_PICKUP_DATE_ENABLED on, from 2026-11-20", "ARRIVAL_PICKUP_DATE_ENABLED off"]);
		ok("the recorder-off warning names both settings", /ARRIVAL_PICKUP_DATE_ENABLED/.test(lib.RECORDER_OFF_WARNING) && /ARRIVAL_PICKUP_RECORDER_ENABLED/.test(lib.RECORDER_OFF_WARNING));
		eq("closed-month notice: [Oct closed, Nov closed, Dec closed, none]", ["2026-10", "2026-11", "2026-12", ""].map((m) => !!lib.fromMonthClosedWarning("2026-11-20", m)), [false, true, true, false]);
		ok("...it never asks to move FROM", /Never change ARRIVAL_PICKUP_DATE_FROM/.test(lib.fromMonthClosedWarning("2026-11-20", "2026-11")));
	});

	// ══ §J ═══════════════════════════════════════════════════════════════════
	section("§J the window (lib/load-pay-days.js payWindow())");
	const d = (key) => { const [y, m, dd] = key.split("-").map(Number); return new Date(y, m - 1, dd); };
	const days = (w) => (w ? financialsCalc.expandDateRange(w.start, w.end || w.start) : null);
	await test("J1 late at both ends (L-1001): arrival Tue Dec 8, drop-off Wed Dec 9, delivered Thu Dec 10: Dec 8-10, the days worked", ({ eq }) => {
		eq("days", days(pay.payWindow({ pickup: d("2026-12-07"), dropoff: d("2026-12-09"), arrival: { start: "2026-12-08", delivered: "2026-12-10" } })), ["2026-12-08", "2026-12-09", "2026-12-10"]);
	});
	await test("J2 an arrival after the drop-off (Dec 10 vs Dec 8) runs to the delivery (Dec 11); a blank drop-off ends at the delivery", ({ eq }) => {
		eq("after the drop-off", days(pay.payWindow({ dropoff: d("2026-12-08"), arrival: { start: "2026-12-10", delivered: "2026-12-11" } })), ["2026-12-10", "2026-12-11"]);
		eq("a blank drop-off", days(pay.payWindow({ dropoff: null, arrival: { start: "2026-12-08", delivered: "2026-12-10" } })), ["2026-12-08", "2026-12-09", "2026-12-10"]);
	});
	await test("J3 neither the drop-off nor the delivery on or after the arrival: the arrival day alone (end null); an early delivery is no end", ({ eq }) => {
		const w = pay.payWindow({ dropoff: d("2026-12-05"), arrival: { start: "2026-12-08", delivered: "2026-12-07" } });
		eq("[end, days]", [w.end, days(w)], [null, ["2026-12-08"]]);
		eq("the drop-off still ends it when the delivery is early", days(pay.payWindow({ dropoff: d("2026-12-09"), arrival: { start: "2026-12-08", delivered: "2026-12-07" } })), ["2026-12-08", "2026-12-09"]);
	});
	await test("J4 the window's Dates are local midnights, so the paths' day expansions read back the same days in any process zone", ({ eq }) => {
		const w = pay.payWindow({ dropoff: d("2026-12-31"), arrival: { start: "2026-12-30", delivered: "2027-01-01" } });
		eq("[start hours, start day, days]", [w.start.getHours(), w.start.getDate(), days(w)], [0, 30, ["2026-12-30", "2026-12-31", "2027-01-01"]]);
		eq("fromArrival", [w.fromArrival, w.pickupFallback, w.dropoffFallback], [true, false, false]);
	});
	await test("J5 no answer, or none with a start, leaves payWindow() exactly as it was (each fallback rule included)", ({ eq }) => {
		const combos = [
			{ pickup: d("2026-12-07"), dropoff: d("2026-12-09") },
			{ pickup: null, dropoff: d("2026-12-09"), assigned: d("2026-12-04"), settleMonth: "2026-12", rules: { pickupFromAssigned: true } },
			{ pickup: d("2026-12-07"), dropoff: null, completion: d("2026-12-10"), completed: true, settleMonth: "2026-12", rules: { dropoffFromCompletion: true } },
			{ pickup: null, dropoff: null },
		];
		const strip = (w) => (w ? days(w).concat([w.pickupFallback, w.dropoffFallback]) : null);
		eq("with { none }, { fallback }, { error } and a start that is no date",
			[{ none: "staff_only" }, { fallback: "x" }, { error: "x" }, { start: "2026-02-30", delivered: "2026-12-10" }].map((arrival) => combos.map((c) => strip(pay.payWindow({ ...c, arrival })))),
			Array(4).fill(combos.map((c) => strip(pay.payWindow(c)))));
	});

	// ══ §K ═══════════════════════════════════════════════════════════════════
	section("§K the invoice's notes");
	await test("K1 extensionDays(): delivered 3 days after the drop-off is 3; on or before it 0; no answer or no drop-off 0", ({ eq }) => {
		eq("days", [lib.extensionDays({ delivered: "2026-12-11" }, "2026-12-08"), lib.extensionDays({ delivered: "2026-12-08" }, "2026-12-08"),
			lib.extensionDays({ delivered: "2026-12-06" }, "2026-12-08"), lib.extensionDays(null, "2026-12-08"), lib.extensionDays({ delivered: "2026-12-11" }, "")], [3, 0, 0, 0, 0]);
		eq("the warning's threshold, a reviewed constant", lib.EXTENDED_DAYS, 2);
	});
	await test("K2 the weekly invoice's lines: not read, not applied, extended", ({ eq }) => {
		eq("lines", lib.invoiceWarnings({ errors: [{ loadId: "L-1", error: "the status history could not be read (x)" }], fallbacks: [{ loadId: "L-2", reason: "why" }],
			extended: [{ loadId: "L-3", dropoff: "2026-12-08", delivered: "2026-12-11", days: 3 }] }), [
			"ARRIVAL NOT READ: load L-1: the status history could not be read (x). This invoice pays its scheduled window instead.",
			"ARRIVAL RULE NOT APPLIED: load L-2: why. This invoice pays its scheduled window instead.",
			"ARRIVAL WINDOW EXTENDED: load L-3 is paid to 2026-12-11, 3 days after its Drop-off Appointment (2026-12-08), the day the status history shows it delivered.",
		]);
		eq("off: none", lib.invoiceWarnings(null), []);
	});
}

// ── §M mutants: each changes one module in one place; the case it names flips ─
function compile(file, text) {
	const m = { exports: {} };
	new Function("require", "module", "exports", "__filename", "__dirname", text)(createRequire(file), m, m.exports, file, path.dirname(file));
	return m.exports;
}
async function mutants() {
	section("§M mutants, each caught");
	const libText = lib ? fs.readFileSync(LIB_FILE, "utf8") : "";
	const payText = fs.readFileSync(PAY_FILE, "utf8");
	const LIB_MUTANTS = [
		{ name: "the geofence moment from changed_at (A1)", from: "\t\treturn { ms: Math.min(Math.max(r.fixMs, floor), r.ms), source: \"geofence\" };", to: "\t\treturn { ms: r.ms, source: \"geofence\" };",
			caught: (m) => m.officialPickup([...lead(), geo("2026-12-09 06:10:00", { fixMs: U("2026-12-09 05:50:00") })]).day !== "2026-12-08" },
		{ name: "the day in the app zone, not the stored one (A2)", from: "return { day: eldMiles.localDayInTz(v.ms, r.tz),", to: "return { day: eldMiles.localDayInTz(v.ms, \"America/New_York\"),",
			caught: (m) => m.officialPickup([...lead(), geo("2026-12-09 05:21:00", { fixMs: U("2026-12-09 05:20:00") })]).day !== "2026-12-08" },
		{ name: "the batch window 30 minutes (B4 15:01)", from: "const BATCH_TAP_MS = 15 * 60 * 1000;", to: "const BATCH_TAP_MS = 30 * 60 * 1000;",
			caught: (m) => !!m.officialPickup([...lead(), tapAt("2026-12-08 14:00:00", { zone: "" }), stepRow("2026-12-08 14:15:01", "At Receiver", { old: "At Shipper" })]).none },
		{ name: "the batch edge exclusive (B4 15:00)", from: "all[k].ms - r.ms <= BATCH_TAP_MS", to: "all[k].ms - r.ms < BATCH_TAP_MS",
			caught: (m) => !m.officialPickup([...lead(), tapAt("2026-12-08 14:00:00", { zone: "" }), stepRow("2026-12-08 14:15:00", "At Receiver", { old: "At Shipper" })]).none },
		{ name: "a far tap counted (B2)", from: "\tif (r.zone === \"outside\") return { reason: \"far_tap\" };\n", to: "",
			caught: (m) => !m.officialPickup([...lead(), tapAt("2026-12-08 14:40:00", { zone: "outside" })]).none },
		{ name: "staff taps counted (B6)", from: "if (r.source !== \"manual\" || r.role !== \"Driver\") return { reason: \"staff_only\" };", to: "if (r.source !== \"manual\") return { reason: \"staff_only\" };",
			caught: (m) => !m.officialPickup([...lead(), tapAt("2026-12-08 14:00:00", { role: "Dispatcher" })]).none },
		{ name: "the queued-load guard dropped (C1)", from: "\t\tif (r.hauling === 1) return { reason: \"hauling_other_load\" };\n\t\tif (r.hauling !== 0 || !zoneOk(r.tz)) return { reason: \"unrecorded\" };", to: "\t\tif (!zoneOk(r.tz)) return { reason: \"unrecorded\" };",
			caught: (m) => !m.officialPickup([...lead(), geo("2026-12-08 14:40:00", { hauling: 1 })]).none },
		{ name: "no staff cut (D1/D2)", from: "\tif (PRE_ARRIVAL_RE.test(r.status)) return !(DRIVER_OWN_SOURCES.has(r.source) && r.role === \"Driver\");", to: "\tif (PRE_ARRIVAL_RE.test(r.status)) return false;",
			caught: (m) => !m.officialPickup([...lead(), geo("2026-12-08 14:40:00"), dispatchRow("2026-12-08 16:00:00")]).none },
		{ name: "the driver's own steps cut too (D3)", from: "\tif (PRE_ARRIVAL_RE.test(r.status)) return !(DRIVER_OWN_SOURCES.has(r.source) && r.role === \"Driver\");", to: "\tif (PRE_ARRIVAL_RE.test(r.status)) return true;",
			caught: (m) => !!m.officialPickup([...lead(), geo("2026-12-08 14:40:00"), acceptRow("2026-12-08 15:00:00", "Driver")]).none },
		{ name: "the cut exclusive (D4)", from: "const from = lastCut >= 0 ? lastCut : first;", to: "const from = lastCut >= 0 ? lastCut + 1 : first;",
			caught: (m) => !!m.officialPickup([...lead(), geo("2026-12-08 13:00:00"), stepRow("2026-12-08 13:30:00", "Loading", { old: "At Shipper" }), geo("2026-12-08 17:00:00", { old: "Heading to Shipper" })]).none },
		{ name: "the old_status move back ignored (D4)", from: "\treturn !!prev && REACHED_RE.test(prev.status) && PRE_ARRIVAL_RE.test(r.old);", to: "\treturn false;",
			caught: (m) => m.officialPickup([...lead(), geo("2026-12-08 13:00:00"), stepRow("2026-12-08 13:30:00", "In Transit", { old: "At Shipper" }), tapAt("2026-12-08 17:00:00", { zone: "outside", old: "Heading to Shipper" })]).none !== "far_tap" },
		{ name: "the last At Shipper, not the first (D5)", from: "\t\tif (k >= from && v.ms !== undefined) {", to: "\t\tif (k >= from && v.ms !== undefined && !all.slice(k + 1).some((x) => x.status === \"at shipper\")) {",
			caught: (m) => { const rows = [...lead(), geo("2026-12-08 13:00:00"), stepRow("2026-12-08 14:00:00", "Loading", { old: "At Shipper" }), stepRow("2026-12-08 15:00:00", "In Transit", { old: "Loading" }), tapAt("2026-12-09 15:00:00", { old: "In Transit" })]; return m.officialPickup(rows).rowId !== rows[3].id; } },
		{ name: "the last Cancelled ignored (D6)", from: "\tall.forEach((r, k) => { if (CANCELLED_RE.test(r.status)) lastCancel = k; });\n", to: "",
			caught: (m) => !m.officialPickup([...lead(), geo("2026-12-08 13:00:00"), cancelRow("2026-12-08 14:00:00")]).none },
		{ name: "a row with no actor_role counted (D7)", from: "\tif (!r.role) return { reason: \"unrecorded\" };\n", to: "",
			caught: (m) => !m.officialPickup([...lead(), geo("2026-12-08 14:00:00", { role: "" })]).none },
		{ name: "the geofence moment unbounded (F1)", from: "Math.min(Math.max(r.fixMs, floor), r.ms)", to: "Math.min(r.fixMs, r.ms)",
			caught: (m) => m.officialPickup([dispatchRow("2026-12-07 15:00:00"), geo("2026-12-07 15:01:00", { fixMs: U("2026-12-05 12:00:00"), old: "Dispatched" })]).day !== "2026-12-07" },
		{ name: "the delivery from the latest completed row (G2)", from: "\tconst at = expenseWindow.deliveredAtFromHistory(events);",
			to: "\tconst done = (events || []).filter((e) => /^(delivered|completed|pod received)$/i.test(String(e.new_status || \"\").trim())).map((e) => e.changed_at).sort().pop();\n\tconst at = done ? `${done.replace(\" \", \"T\")}Z` : null;",
			caught: (m) => m.deliveryOf([...lead(), geo("2026-12-08 14:40:00"), delivered("2026-12-10 18:00:00"), overrideRow("2026-12-15 15:00:00", "Completed", { old: "Delivered" })], CHI).day !== "2026-12-10" },
		{ name: "the delivery's day in the app zone (G1)", from: "return { ms, day: eldMiles.localDayInTz(ms, zone) };", to: "return { ms, day: eldMiles.localDayInTz(ms, \"America/New_York\") };",
			caught: (m) => m.deliveryOf([...lead(), geo("2026-12-08 14:40:00"), delivered("2026-12-11 05:30:00")], CHI).day !== "2026-12-10" },
		{ name: "the Assigned Date's scope check dropped (H2)", from: "\t\tif (!assignedDay || assignedDay < fromDay) return null;", to: "\t\tif (!assignedDay) return null;",
			caught: (m) => { const db = historyDb(); insertRows(db, [...lead(), geo("2026-12-08 14:40:00"), delivered("2026-12-10 18:00:00")]); return m.createArrivalResolver({ db, fromDay: "2026-11-20" }).forLoad({ loadId: "L-1001", assigned: "2026-11-19", completed: true }) !== null; } },
		{ name: "ENABLED read loosely (I1)", from: "if (!env || env.ARRIVAL_PICKUP_DATE_ENABLED !== \"true\") return null;", to: "if (!env || !/^(true|1|yes|on)$/i.test(String(env.ARRIVAL_PICKUP_DATE_ENABLED || \"\"))) return null;",
			caught: (m) => m.ruleFromEnv({ ARRIVAL_PICKUP_DATE_ENABLED: "1", ARRIVAL_PICKUP_DATE_FROM: "2026-11-20" }) !== null },
		{ name: "the extension warning's threshold 3 days (K1)", from: "const EXTENDED_DAYS = 2;", to: "const EXTENDED_DAYS = 3;", caught: (m) => m.EXTENDED_DAYS !== 2 },
	];
	for (const mu of LIB_MUTANTS) {
		await test(`M ${mu.name}`, ({ ok }) => {
			ok("(anchor) the module holds the line", libText.includes(mu.from), mu.from);
			if (libText.includes(mu.from)) ok("MUTANT caught", mu.caught(compile(LIB_FILE, libText.replace(mu.from, mu.to))));
		});
	}
	const PAY_MUTANTS = [
		{ name: "the window ends at the drop-off only, D11b (b) (J1)", from: "const ends = [localDayKey(dropoff), arrivalPickup.dayKeyOf(arrival.delivered)]", to: "const ends = [localDayKey(dropoff)]",
			caught: (m) => JSON.stringify(financialsCalc.expandDateRange(...(() => { const w = m.payWindow({ dropoff: new Date(2026, 11, 9), arrival: { start: "2026-12-08", delivered: "2026-12-10" } }); return [w.start, w.end || w.start]; })())) !== JSON.stringify(["2026-12-08", "2026-12-09", "2026-12-10"]) },
		{ name: "an end before the arrival kept (J3)", from: ".filter((d) => d && d >= start)", to: ".filter((d) => d)",
			caught: (m) => m.payWindow({ dropoff: new Date(2026, 11, 5), arrival: { start: "2026-12-08", delivered: "2026-12-07" } }).end !== null },
		{ name: "the arrival ignored (J1)", from: "\tif (fromArrival) return fromArrival;\n", to: "",
			caught: (m) => { const w = m.payWindow({ pickup: new Date(2026, 11, 7), dropoff: new Date(2026, 11, 9), arrival: { start: "2026-12-08", delivered: "2026-12-10" } }); return w.start.getDate() !== 8; } },
	];
	for (const mu of PAY_MUTANTS) {
		await test(`M ${mu.name}`, ({ ok }) => {
			ok("(anchor) lib/load-pay-days.js holds the line", payText.includes(mu.from), mu.from);
			if (payText.includes(mu.from)) ok("MUTANT caught", mu.caught(compile(PAY_FILE, payText.replace(mu.from, mu.to))));
		});
	}
}

// ── §Z the process zones ─────────────────────────────────────────────────────
function zones() {
	console.log("\n§Z every case above under four process zones (child processes)");
	for (const zone of ZONES) {
		const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, TZ: zone, ARRIVAL_PICKUP_TZ_CHILD: "1" }, encoding: "utf8", timeout: 60000 });
		const last = String(r.stdout || "").trim().split("\n").pop() || "";
		const good = r.status === 0;
		if (good) passed++; else failures.push(`Z TZ=${zone}`);
		console.log(`  ${good ? "ok  " : "FAIL"}  Z TZ=${zone}: ${last}${good ? "" : `\n${String(r.stdout || "").trim()}\n${String(r.stderr || "").trim()}`.slice(0, 3000)}`);
	}
}

(async () => {
	if (!CHILD) console.log("The official pickup date (lib/arrival-pickup.js) and its window (lib/load-pay-days.js)");
	await cases();
	if (!CHILD) {
		await mutants();
		zones();
	}
	console.log(`\n${passed} passed, ${failures.length} failed${CHILD ? ` (TZ=${process.env.TZ})` : ""}`);
	process.exit(failures.length ? 1 : 0);
})();
