#!/usr/bin/env node
// sweepLoadEldMiles() (server.js): every closed-out load's driven miles,
// measured in the background instead of only when someone opens its haul modal.
//
// WHY THIS EXISTS. load_eld_miles held 32 of 345 production loads: the ones a
// person happened to open. Every other load became unmeasurable once its pings
// aged past the 90-day purge. The sweep closes that gap, and this suite pins
// which loads it measures and which it must leave alone:
//   • a load already measured to a final row is never recomputed (its pings age
//     out, and a recompute could only make it worse);
//   • a running load, a load whose window is older than the retained telemetry,
//     and a cancelled or deleted load are skipped;
//   • "513987502" and "#513987502" are one load;
//   • the flag and the re-entry guard hold.
//
// It also pins, from the source, the rule that makes the sweep affordable: the
// shared measurement function never calls Google Routes (getRoute is a billed
// request, and this runs over every recent load four times a day), and the
// modal and the sweep measure through that one function.
//
// The sweep is lifted verbatim, with the real normLoadKey, findCol and
// haulWindowFromPhases. The measurement itself is stubbed: it is the haul
// route's own code, covered by scripts/test-load-haul-window.js.
//
// No network, no sheet, no database, no server.
//
//   node scripts/test-load-eld-miles-sweep.js      # exits 1 on any failure

const fs = require("fs");
const path = require("path");

const SHIPPED = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}
function liftOnce(re, label) {
	const all = [...SHIPPED.matchAll(re)];
	if (all.length !== 1) throw new Error(`${label}: expected exactly one match, found ${all.length}`);
	return all[0][0];
}

const measureSrc = liftOnce(/\nfunction measureLoadEldMiles\([\s\S]*?\n}\n/g, "measureLoadEldMiles");
const sweepSrc = liftOnce(/\nasync function sweepLoadEldMiles\([\s\S]*?\n}\n/g, "sweepLoadEldMiles");
const routeSrc = liftOnce(/\napp\.get\("\/api\/loads\/:loadId\/haul"[\s\S]*?\n}\);\n/g, "haul route");

// ---------------------------------------------------------------------------
// 1. Source pins.
// ---------------------------------------------------------------------------
check("the shared measurement never calls Google Routes", /getRoute\s*\(|googleapis/.test(measureSrc), false);
check("the sweep never calls Google Routes", /getRoute\s*\(|googleapis/.test(sweepSrc), false);
check("the haul modal measures through the shared function", /measureLoadEldMiles\(rawId,/.test(routeSrc), true);
check("the modal no longer carries its own copy of the upsert",
	/loadEldMilesUpsertStmt/.test(routeSrc), false);
const checkToWrite = sweepSrc.slice(sweepSrc.indexOf("loadEldMilesGetStmt.get(key)"), sweepSrc.indexOf("measureLoadEldMiles(rawId"));
check("no await between a load's stored-row check and its measurement", /\bawait\b/.test(checkToWrite), false);

// ---------------------------------------------------------------------------
// 2. Behaviour, with the sweep lifted verbatim.
// ---------------------------------------------------------------------------
const lifted = [
	liftOnce(/\nconst normLoadKey = [^\n]*\n/g, "normLoadKey"),
	liftOnce(/\nfunction findCol\([\s\S]*?\n}\n/g, "findCol"),
	liftOnce(/\nfunction haulWindowFromPhases\([\s\S]*?\n}\n/g, "haulWindowFromPhases"),
	// The sheet's completion signal (scripts/test-load-sheet-closeout.js covers it).
	liftOnce(/\nfunction haulSheetCloseOut\([\s\S]*?\n}\n/g, "haulSheetCloseOut"),
	liftOnce(/\nfunction haulLoadWindow\([\s\S]*?\n}\n/g, "haulLoadWindow"),
	liftOnce(/\nconst LOAD_ELD_MILES_SWEEP_MAX_AGE_MS = [^\n]*\n/g, "max age"),
	liftOnce(/\nlet loadEldMilesSweepRunning = [^\n]*\n/g, "running flag"),
	liftOnce(/\nlet loadEldMilesSweepLogged = [^\n]*\n/g, "logged flag"),
	sweepSrc,
].join("");

const NOW = Date.parse("2026-10-02T12:00:00Z");
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const headers = ["Load ID", "Driver", "Status"];
const row = (id, status = "Delivered") => ({ "Load ID": id, Driver: "Driver A", Status: status });

function world({ enabled = true, rows, stored = {}, phases = {}, results = {} }) {
	const calls = [];
	const logs = [];
	let routeCalls = 0;
	const deps = {
		LOAD_HAUL_ELD_ENABLED: enabled,
		getJobTrackingCached: async () => ({ headers, data: rows }),
		// The real one runs excludeDroppedLoads; Cancelled is enough to stand for it.
		liveJobTrackingView: (jt) => ({ ...jt, data: jt.data.filter((r) => r.Status !== "Cancelled") }),
		buildHaulTruckResolver: () => ({ forDriverAt: () => null }),
		buildEldDeviceResolver: () => ({ vehicleForTruckAt: () => "" }),
		loadHaul: require("../lib/load-haul"),
		loadEldMilesGetStmt: { get: (k) => stored[k] },
		computeStatusPhases: (id) => phases[String(id).replace(/^#/, "")] || [],
		getLoadCoordsFull: () => ({ origin_lat: 1, origin_lng: 2, dest_lat: 3, dest_lng: 4 }),
		measureLoadEldMiles: (rawId) => {
			calls.push(rawId);
			const key = String(rawId).replace(/^#/, "");
			const driven = results[key] || { loadedMiles: null, stored: false, reason: "no_samples" };
			// What the real upsert does: a measured, closed-out load now has a final row.
			if (driven.loadedMiles != null && !driven.stored) stored[key] = { in_progress: 0 };
			return { driven };
		},
		getRoute: () => { routeCalls += 1; throw new Error("Google Routes must never be called"); },
		console: { log: (s) => logs.push(String(s)), error: (s, e) => logs.push(`ERR ${s} ${e || ""}`) },
		Date: class extends Date { static now() { return NOW; } },
	};
	const names = Object.keys(deps);
	const sweep = new Function(...names, `${lifted}\nreturn sweepLoadEldMiles;`)(...names.map((n) => deps[n]));
	return { sweep, calls, logs, routeCalls: () => routeCalls };
}
const closedOut = (endMs) => [
	{ status: "Dispatched", startedAt: iso(endMs - 2 * DAY), terminal: false },
	{ status: "Delivered", startedAt: iso(endMs), terminal: true },
];
const running = [{ status: "In Transit", startedAt: iso(NOW - DAY), terminal: false }];

(async () => {
	const w = world({
		rows: [
			row("100"),            // final row already stored
			row("200"),            // stored, but as in-progress
			row("300", "In Transit"),
			row("400"),            // closed out 120 days ago: pings purged
			row("500"),            // fresh: measure it
			row("#500"),           // the same load again
			row("600"),            // nothing new to read: stored row returned
			row("700"),            // no device on the truck
			row("800", "Cancelled"),
			row(""),               // no id
		],
		stored: { 100: { in_progress: 0 }, 200: { in_progress: 1 } },
		phases: {
			100: closedOut(NOW - 5 * DAY), 200: closedOut(NOW - DAY), 300: running,
			400: closedOut(NOW - 120 * DAY), 500: closedOut(NOW - 3 * DAY), 600: closedOut(NOW - 4 * DAY),
			700: closedOut(NOW - 2 * DAY), 800: closedOut(NOW - 2 * DAY),
		},
		results: {
			200: { loadedMiles: 412.6, stored: false },
			500: { loadedMiles: 233.1, stored: false },
			600: { loadedMiles: 180, stored: true },
			700: { loadedMiles: null, stored: false, reason: "no_eld_device" },
		},
	});
	const counts = await w.sweep();
	check("measures exactly the loads it should, each once", w.calls, ["200", "500", "600", "700"]);
	check("tallies every outcome", counts, {
		already_final: 1, measured: 2, not_closed_out: 1, telemetry_purged: 1, kept_stored: 1, no_eld_device: 1,
	});
	check("a cancelled load is never measured", w.calls.includes("800"), false);
	check("Google Routes was never called", w.routeCalls(), 0);
	check("the run is logged once", w.logs.filter((l) => l.startsWith("[load-eld-miles] sweep:")).length, 1);
	check("nothing went wrong", w.logs.filter((l) => l.startsWith("ERR")), []);

	const again = await w.sweep();
	check("a quiet second run (nothing newly measured) is not logged",
		[again.measured || 0, again.already_final, w.logs.filter((l) => l.startsWith("[load-eld-miles] sweep:")).length], [0, 3, 1]);

	const off = world({ enabled: false, rows: [row("500")], phases: { 500: closedOut(NOW - DAY) } });
	check("the kill switch turns the sweep off", await off.sweep(), { skipped: "disabled" });
	check("...and measures nothing", off.calls, []);

	const busy = world({ rows: [row("500")], phases: { 500: closedOut(NOW - DAY) } });
	const first = busy.sweep();
	check("an overlapping run skips", await busy.sweep(), { skipped: "busy" });
	await first;

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((err) => {
	console.error("crashed:", err);
	process.exit(1);
});
