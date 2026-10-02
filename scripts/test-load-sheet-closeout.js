#!/usr/bin/env node
// The sheet's completion signal for the per-load ELD miles sweep:
// lib/load-haul.js parseSheetInstant() / sheetCloseOut() / closeOutWindow(), and
// sweepLoadEldMiles() + haulLoadWindow() in server.js.
//
// WHY THIS EXISTS. The sweep measured only loads with a terminal entry in
// load_status_history, which the app's own status buttons write. A load typed
// into the sheet, or marked Delivered on Job Tracking, has none, so 217
// production loads were skipped as "not closed out" forever and never got a
// per-load ELD figure. Pinned here:
//   1. a completed Job Status (Delivered / Completed / POD Received) with a
//      readable delivered date closes a load the history left open: Completion
//      Date, then Status Update Date, then the Drop-off Appointment's day;
//   2. no date, a future date, or a status that is not completed: still open;
//   3. a window the history closed is never moved by the sheet;
//   4. the sweep measures the newly closed loads, keeps its other rules (final
//      rows, the 90-day telemetry window), and tallies them closed_out_by_sheet;
//   5. the modal and the sweep read a load's window through one function.
// The haul legs themselves are still replayed from pings (lib/load-haul.js);
// only "is it closed out, and when" comes from the sheet.
//
// The sweep is lifted verbatim (SERVER_JS=<path> runs another copy of
// server.js); the measurement itself is stubbed, as in
// scripts/test-load-eld-miles-sweep.js.
//
// No network, no sheet, no database, no server.
//
//   node scripts/test-load-sheet-closeout.js      # exits 1 on any failure

const fs = require("fs");
const path = require("path");
const loadHaul = require("../lib/load-haul");

const SHIPPED = fs.readFileSync(process.env.SERVER_JS || path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}
function lift(re, label) {
	const all = [...SHIPPED.matchAll(re)];
	if (all.length !== 1) {
		fail++;
		console.error(`FAIL  ${label}: expected exactly one definition in server.js, found ${all.length}`);
		return "";
	}
	return all[0][0];
}

const NOW = Date.parse("2026-10-02T17:00:00Z"); // noon in Houston
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

// ===========================================================================
// §1 parseSheetInstant(): the delivered-date cells as the sheet holds them
// ===========================================================================
console.log("§1 parseSheetInstant()");
{
	const p = (v, o) => { const r = loadHaul.parseSheetInstant(v, o); return r && [iso(r.ms), r.day, r.dateOnly]; };
	check("§1.1 houstonStamp() output is Houston wall-clock time (CDT, UTC-5)",
		p("9/15/2026 14:23:05"), ["2026-09-15T19:23:05.000Z", "2026-09-15", false]);
	check("§1.2 ...and in winter (CST, UTC-6)", p("12/15/2026 9:05:00"), ["2026-12-15T15:05:00.000Z", "2026-12-15", false]);
	check("§1.3 a bare date is the END of that Houston day", p("2026-09-15"), ["2026-09-16T04:59:59.999Z", "2026-09-15", true]);
	check("§1.4 two-digit years, as parseSheetDate reads them", p("9/15/26"), ["2026-09-16T04:59:59.999Z", "2026-09-15", true]);
	check("§1.5 AM/PM", [p("9/15/2026 2:30 PM")[0], p("9/15/2026 12:10 AM")[0]], ["2026-09-15T19:30:00.000Z", "2026-09-15T05:10:00.000Z"]);
	check("§1.6 an ISO instant with its zone is that instant", p("2026-09-15T19:23:05Z"), ["2026-09-15T19:23:05.000Z", "2026-09-15", false]);
	check("§1.7 the copied-email-header shape, read literally", p("Date: Tue, 15 Sep 2026"), ["2026-09-16T04:59:59.999Z", "2026-09-15", true]);
	check("§1.8 dayOnly ignores a time that is there (an appointment's opening hour)",
		p("09/15/2026 08:00 - 14:00", { dayOnly: true }), ["2026-09-16T04:59:59.999Z", "2026-09-15", true]);
	check("§1.9 not dates", [p(""), p(null), p("TBD"), p("2/31/2026"), p("13/01/2026"), p("9/15/1999"), p("9/15/2026 25:00"), p("x".repeat(200))],
		[null, null, null, null, null, null, null, null]);
}

// ===========================================================================
// §2 sheetCloseOut() and closeOutWindow()
// ===========================================================================
console.log("§2 sheetCloseOut() / closeOutWindow()");
{
	const co = (status, cells, nowMs = NOW) => loadHaul.sheetCloseOut({ status, dateCells: cells, nowMs });
	check("§2.1 Delivered + Completion Date", co("Delivered", ["9/20/2026 10:00:00", "9/21/2026 9:00:00", ""]),
		{ closed: true, endMs: Date.parse("2026-09-20T15:00:00Z"), cell: 0 });
	check("§2.2 the three completed statuses, case and spacing as typed",
		["Delivered", " completed ", "POD Received", "pod received"].map((s) => co(s, ["9/20/2026"]).closed), [true, true, true, true]);
	check("§2.3 any other status is not closed out", ["In Transit", "At Receiver", "Cancelled", "Dispatched", ""].map((s) => co(s, ["9/20/2026"]).reason),
		["not_completed", "not_completed", "not_completed", "not_completed", "not_completed"]);
	check("§2.4 no Completion Date: Status Update Date", co("Delivered", ["", "9/21/2026 9:00:00", ""]).cell, 1);
	check("§2.5 neither: the Drop-off Appointment's day", co("Delivered", ["", "", { value: "09/22/2026 08:00", dayOnly: true }]),
		{ closed: true, endMs: Date.parse("2026-09-23T04:59:59.999Z"), cell: 2 });
	check("§2.6 completed with no readable date stays open", co("Delivered", ["", "soon", { value: "", dayOnly: true }]), { closed: false, reason: "no_date" });
	check("§2.7 a future date is skipped for the next cell", co("Delivered", ["10/30/2026 10:00:00", "9/21/2026 9:00:00"]).cell, 1);
	check("§2.8 ...and alone it leaves the load open", co("Delivered", ["10/30/2026 10:00:00"]), { closed: false, reason: "future_date" });
	check("§2.9 a bare date that is TODAY means now", co("Delivered", ["2026-10-02"]), { closed: true, endMs: NOW, cell: 0 });

	const closed = { closed: true, endMs: Date.parse("2026-09-20T15:00:00Z") };
	const open = { dispatchMs: null, terminal: false, endMs: NOW };
	check("§2.10 the sheet closes a window the history left open",
		loadHaul.closeOutWindow(open, closed, null), { dispatchMs: null, terminal: true, endMs: closed.endMs, closedBy: "sheet" });
	const historyClosed = { dispatchMs: 1, terminal: true, endMs: Date.parse("2026-09-19T12:00:00Z") };
	check("§2.11 a window the history closed is never moved", loadHaul.closeOutWindow(historyClosed, closed, null), historyClosed);
	check("§2.12 never earlier than the last status change on record",
		loadHaul.closeOutWindow({ dispatchMs: 5, terminal: false, endMs: NOW }, closed, Date.parse("2026-09-21T00:00:00Z")).endMs,
		Date.parse("2026-09-21T00:00:00Z"));
	check("§2.13 no signal, no change", [loadHaul.closeOutWindow(open, { closed: false, reason: "no_date" }, null), loadHaul.closeOutWindow(open, null, null)], [open, open]);
}

// ===========================================================================
// §3 sweepLoadEldMiles(), as shipped
// ===========================================================================
console.log("§3 sweepLoadEldMiles()");
const measureSrc = lift(/\nfunction measureLoadEldMiles\([\s\S]*?\n}\n/g, "measureLoadEldMiles");
const routeSrc = lift(/\napp\.get\("\/api\/loads\/:loadId\/haul"[\s\S]*?\n}\);\n/g, "haul route");
const sweepSrc = lift(/\nasync function sweepLoadEldMiles\([\s\S]*?\n}\n/g, "sweepLoadEldMiles");
check("§3.1 the modal and the sweep read a load's window through one function",
	[/haulLoadWindow\(rawId, row, headers, nowMs\)/.test(measureSrc), /haulLoadWindow\(rawId, r, live\.headers, nowMs\)/.test(sweepSrc)], [true, true]);
check("§3.2 the modal and the sweep both hand the measurement the device history",
	[/deviceResolver: buildEldDeviceResolver\(\)/.test(routeSrc), /deviceResolver,\s*\n?\s*}\);/.test(sweepSrc)], [true, true]);
const helpers = [
	lift(/\nconst normLoadKey = [^\n]*\n/g, "normLoadKey"),
	lift(/\nfunction findCol\([\s\S]*?\n}\n/g, "findCol"),
	lift(/\nfunction haulWindowFromPhases\([\s\S]*?\n}\n/g, "haulWindowFromPhases"),
	// Absent from a server.js that predates the sheet signal; the sweep then
	// reads the window the old way, which is what §3 shows failing.
	(SHIPPED.match(/\nfunction haulSheetCloseOut\([\s\S]*?\n}\n/g) || [""])[0],
	(SHIPPED.match(/\nfunction haulLoadWindow\([\s\S]*?\n}\n/g) || [""])[0],
	lift(/\nconst LOAD_ELD_MILES_SWEEP_MAX_AGE_MS = [^\n]*\n/g, "max age"),
	lift(/\nlet loadEldMilesSweepRunning = [^\n]*\n/g, "running flag"),
	lift(/\nlet loadEldMilesSweepLogged = [^\n]*\n/g, "logged flag"),
	sweepSrc,
].join("");

const HEADERS = ["Load ID", "Driver", "Job Status", "Drop-off Appointment", "Assigned Date", "Status Update Date", "Completion Date"];
const row = (id, status, { appt = "", update = "", completion = "" } = {}) => ({
	"Load ID": id, Driver: "Driver A", "Job Status": status, "Drop-off Appointment": appt,
	"Assigned Date": "9/1/2026", "Status Update Date": update, "Completion Date": completion,
});
const closedOut = (endMs) => [
	{ status: "Dispatched", startedAt: iso(endMs - 2 * DAY), terminal: false },
	{ status: "Delivered", startedAt: iso(endMs), terminal: true },
];
const running = (ms) => [{ status: "In Transit", startedAt: iso(ms), terminal: false }];

function world({ rows, phases = {}, stored = {} }) {
	const calls = [];
	const logs = [];
	let routeCalls = 0;
	const deps = {
		LOAD_HAUL_ELD_ENABLED: true,
		loadHaul,
		getJobTrackingCached: async () => ({ headers: [...HEADERS], data: rows }),
		liveJobTrackingView: (jt) => ({ ...jt, data: jt.data.filter((r) => r["Job Status"] !== "Cancelled").map((r) => ({ ...r })) }),
		buildHaulTruckResolver: () => ({ forDriverAt: () => null }),
		buildEldDeviceResolver: () => ({ vehicleForTruckAt: () => "" }),
		loadEldMilesGetStmt: { get: (k) => stored[k] },
		computeStatusPhases: (id) => phases[String(id).replace(/^#/, "")] || [],
		getLoadCoordsFull: () => ({ origin_lat: 1, origin_lng: 2, dest_lat: 3, dest_lng: 4 }),
		measureLoadEldMiles: (rawId) => {
			calls.push(rawId);
			stored[String(rawId).replace(/^#/, "")] = { in_progress: 0 };
			return { driven: { loadedMiles: 300, stored: false } };
		},
		getRoute: () => { routeCalls += 1; throw new Error("Google Routes must never be called"); },
		console: { log: (s) => logs.push(String(s)), error: (s, e) => logs.push(`ERR ${s} ${e || ""}`) },
		Date: class extends Date { static now() { return NOW; } },
	};
	const names = Object.keys(deps);
	const sweep = new Function(...names, `${helpers}\nreturn sweepLoadEldMiles;`)(...names.map((n) => deps[n]));
	return { sweep, calls, logs, routeCalls: () => routeCalls };
}

(async () => {
	const w = world({
		rows: [
			row("1001", "Delivered", { completion: "9/20/2026 10:00:00", update: "9/20/2026 10:00:00" }), // typed into the sheet
			row("#1002", "POD Received", { update: "9/25/2026 16:40:12" }),                              // no Completion Date
			row("1003", "Completed", { appt: "09/28/2026 08:00 - 14:00" }),                              // appointment only
			row("1004", "Delivered"),                                                                      // no date at all
			row("1005", "In Transit", { completion: "9/20/2026 10:00:00" }),                              // not completed
			row("1006", "Delivered", { completion: "6/01/2026 10:00:00" }),                               // pings long purged
			row("1007", "Delivered", { completion: "9/29/2026 10:00:00" }),                               // history says In Transit
			row("1008", "Delivered", { completion: "9/20/2026 10:00:00" }),                               // history closed it already
			row("1009", "Delivered", { completion: "9/18/2026 10:00:00" }),                               // already measured, final
			row("1010", "Delivered", { completion: "11/20/2026 10:00:00" }),                              // a date in the future
			row("1011", "Cancelled", { completion: "9/20/2026 10:00:00" }),
		],
		phases: { 1007: running(NOW - 4 * DAY), 1008: closedOut(NOW - 12 * DAY) },
		stored: { 1009: { in_progress: 0 } },
	});
	const counts = await w.sweep();
	check("§3.3 measures the loads the sheet closes out, and the ones the history closed, each once",
		w.calls, ["1001", "#1002", "1003", "1007", "1008"]);
	check("§3.4 tallies: closed_out_by_sheet beside every outcome", counts, {
		closed_out_by_sheet: 5, measured: 5, not_closed_out: 3, telemetry_purged: 1, already_final: 1,
	});
	check("§3.5 a completed load with no date, a running load and a future date stay unmeasured",
		["1004", "1005", "1010"].filter((id) => w.calls.includes(id)), []);
	check("§3.6 Google Routes was never called", w.routeCalls(), 0);
	check("§3.7 nothing went wrong", w.logs.filter((l) => l.startsWith("ERR")), []);

	const again = await w.sweep();
	check("§3.8 a second run finds them final", [again.measured || 0, again.already_final], [0, 6]);

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((err) => {
	console.error("crashed:", err);
	process.exit(1);
});
