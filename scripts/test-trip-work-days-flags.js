#!/usr/bin/env node
/**
 * B12 runner G: the trip work-day rule's flags and edges the plan's cases do not
 * reach. Written before the fix, which they failed: on main the flag is ignored and
 * the notices, the settings, the paid-days table and the scripts do not exist,
 * so every case fails there.
 *   - G1: the two money flags compose. TRIP_WORK_DAYS reuses the ledger
 *     day-once rule (LEDGER_DAY_ONCE_*, #511) from its own FROM; the payout
 *     ledger and GET /api/investor drop a repeated driver-day from the earlier
 *     of the two FROMs, and each flag keeps its own shape (day-once: exactly
 *     "true"; trip: true/1/yes/on). Every on/off combination, ledger = investor view;
 *   - G2: start-up: FROM at or before the latest closed month logs one notice;
 *     the flag on without a month leaves the rule off with one warning naming
 *     TRIP_WORK_DAYS_FROM, never its value; nothing with the flag off;
 *   - G3: .env.example documents both settings, off;
 *   - G4: the pickup geofence radius lib/trip-work-days.js reads is server.js's;
 *   - G5: with the rule off, POST /api/invoices/manual ignores `days` (no claim,
 *     the stored render data exactly as without it);
 *   - G6: scripts/work-days-dry-run.js refuses (exit 2) a FROM at or before the
 *     latest closed month, labels drivers "driver N" unless --names;
 *   - G7: with the rule off, generating, deleting and restoring invoices writes
 *     no paid-day row and no floor marker;
 *   - G8: a trip with no At Shipper starts at the truck's ELD fix inside the
 *     pickup geofence after its dispatch (the resolver's database path), on the
 *     invoice, the ledger and the investor view alike.
 * Paths lifted from server.js (lib/work-days-world.js beside this runner).
 * Made-up data only. Pure: no server, no app.db, no network.
 * Run: node scripts/test-trip-work-days-flags.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const fs = require("fs");
const path = require("path");
const W = require("./lib/work-days-world");
const { loadRow, etMs } = W;

const W39 = "2026-10-02";
const norm = (x) => x.trim().toLowerCase().replace(/\s+/g, " ");
const s = (lid, status, at, source = "manual", actor = "") => [lid, status, source, at, actor];
const uniq = (a) => [...new Set(a)].sort();

async function monthViews(world, driver) {
	const led = await W.ledger(world);
	const inv = await W.investorDays(world);
	return { ledger: W.monthDays(led.pay, norm(driver)), investor: W.monthDays(inv.days, norm(driver)) };
}

// A Sep-assigned load paying 9/28-9/29, and an Oct-assigned load whose
// appointments say 9/29-9/30 but whose trip ran Tue 9/29 18:00 ET to Thu 10/1.
const X = "Gia Holt";
const flagsWorld = (env) => W.startWorld({
	env,
	drivers: [{ name: X }],
	rows: [
		loadRow({ id: "G101", driver: X, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
		loadRow({ id: "G102", driver: X, pickup: "2026-09-29 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-10-01", done: "2026-10-01", truck: "T1" }),
	],
	status: [
		s("G101", "At Shipper", "2026-09-28 13:00:00"), s("G101", "Delivered", "2026-09-29 20:00:00"),
		s("G102", "At Shipper", "2026-09-29 22:00:00"), s("G102", "Delivered", "2026-10-01 20:00:00"),
	],
});

const R = W.createRunner("B12 G: the trip work-day flags and edges");

(async () => {
	await R.test("G1 Flag combinations (ledger = investor view): both off pays 9/29 in Sep and Oct; day-once alone (FROM Oct) drops Oct's 9/29; the trip rule alone (FROM Oct) pays the Oct load's trip 9/29-10/1 and drops its 9/29 (day-once from the trip's FROM); both on, either FROM earlier, or day-once on with no FROM: the earlier FROM decides; day-once's own flag shape stays exactly \"true\"", async ({ eq }) => {
		const today = ["2026-09 2026-09-28", "2026-09 2026-09-29", "2026-10 2026-09-29", "2026-10 2026-09-30"];
		const dayOnceOnly = ["2026-09 2026-09-28", "2026-09 2026-09-29", "2026-10 2026-09-30"];
		const tripRule = ["2026-09 2026-09-28", "2026-09 2026-09-29", "2026-10 2026-09-30", "2026-10 2026-10-01"];
		const D1 = { LEDGER_DAY_ONCE_ENABLED: "true", LEDGER_DAY_ONCE_FROM: "2026-10" };
		const T = (from) => ({ TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: from });
		const combos = [
			["both off", {}, today],
			["day-once on (Oct), trip off", D1, dayOnceOnly],
			["trip on (Oct), day-once off", T("2026-10"), tripRule],
			["both on (Oct, Oct)", { ...D1, ...T("2026-10") }, tripRule],
			["day-once Nov, trip Oct: Oct decides", { LEDGER_DAY_ONCE_ENABLED: "true", LEDGER_DAY_ONCE_FROM: "2026-11", ...T("2026-10") }, tripRule],
			["day-once Oct, trip Nov: the trip skips the Oct load, day-once drops 9/29", { ...D1, ...T("2026-11") }, dayOnceOnly],
			["day-once on with no FROM, trip Oct", { LEDGER_DAY_ONCE_ENABLED: "true", ...T("2026-10") }, tripRule],
			["day-once flag \"1\" (not exactly \"true\"), trip off: both off", { LEDGER_DAY_ONCE_ENABLED: "1", LEDGER_DAY_ONCE_FROM: "2026-10" }, today],
			["trip flag \"yes\" turns the trip rule on", { TRIP_WORK_DAYS_ENABLED: "yes", TRIP_WORK_DAYS_FROM: "2026-10" }, tripRule],
		];
		for (const [label, env, want] of combos) {
			const v = await monthViews(flagsWorld(env), X);
			eq(`${label}: ledger`, v.ledger, want);
			eq(`${label}: investor view`, v.investor, want);
		}
		const g = await W.generate(flagsWorld(T("2026-10")), X, W39);
		eq("trip on: W39 pays each day once (9/28-10/1)", W.dayList(W.gridDays(g.data, W39)), ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
	});

	await R.test("G2 Start-up: FROM at or before the latest closed month logs one notice; the flag on without a month leaves the rule off with one warning naming TRIP_WORK_DAYS_FROM, never its value; nothing when FROM is after it or the flag is off", async ({ eq, ok }) => {
		const said = (env, locks) => W.startWorld({ env, locks, drivers: [{ name: X }] }).warnings.filter((x) => /TRIP_WORK_DAYS|trip-work-days/.test(x));
		const closed = said({ TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-09" }, ["2026-08", "2026-09"]);
		eq("FROM 2026-09, September closed: one notice", closed.length, 1);
		ok("…naming the latest closed month", /at or before 2026-09/.test(closed[0] || ""), JSON.stringify(closed));
		eq("FROM 2026-10, September closed: none", said({ TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-10" }, ["2026-09"]).length, 0);
		const noMonth = said({ TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "Sept-ish" }, []);
		ok("flag on, FROM not a month: one warning naming the setting, not its value", noMonth.length === 1 && /TRIP_WORK_DAYS_FROM/.test(noMonth[0]) && !/Sept-ish/.test(noMonth[0]), JSON.stringify(noMonth));
		eq("flag off: nothing", said({ TRIP_WORK_DAYS_FROM: "2026-09" }, ["2026-09"]).length, 0);
	});

	await R.test("G3 .env.example documents TRIP_WORK_DAYS_ENABLED=false and TRIP_WORK_DAYS_FROM commented with no value", async ({ ok }) => {
		const example = fs.readFileSync(path.join(W.ROOT, ".env.example"), "utf8");
		ok("the flag, off", /\nTRIP_WORK_DAYS_ENABLED=false\n/.test(example));
		ok("FROM, commented with no value", /\n# TRIP_WORK_DAYS_FROM=\n/.test(example));
	});

	await R.test("G4 The pickup geofence radius the rule reads is server.js's GEOFENCE_RADIUS (GEOFENCE_RADIUS_M, else its default); its driving speed (rule d) is the travel-day test's and GEOFENCE_DEPART_SPEED_MPS", async ({ eq }) => {
		const lib = W.requireLib("trip-work-days");
		const m = W.SRC.match(/\nconst GEOFENCE_RADIUS = Number\(process\.env\.GEOFENCE_RADIUS_M\) > 0\s*\?\s*Number\(process\.env\.GEOFENCE_RADIUS_M\)\s*:\s*([\d.]+);/);
		eq("the default", m && Number(m[1]), lib.DEFAULT_GEOFENCE_RADIUS_M);
		eq("a set radius, an unset one, a bad one", [lib.geofenceRadiusFromEnv({ GEOFENCE_RADIUS_M: "500" }), lib.geofenceRadiusFromEnv({}), lib.geofenceRadiusFromEnv({ GEOFENCE_RADIUS_M: "-3" })],
			[500, lib.DEFAULT_GEOFENCE_RADIUS_M, lib.DEFAULT_GEOFENCE_RADIUS_M]);
		const depart = W.SRC.match(/\nconst GEOFENCE_DEPART_SPEED_MPS = ([\d.]+);/);
		const travel = W.SRC.match(/if \(\(r\.speed \|\| 0\) > ([\d.]+)\) e\.travel\.add\(day\);/);
		eq("driving speed = GEOFENCE_DEPART_SPEED_MPS = the travel-day test", [lib.DRIVING_MPS, depart && Number(depart[1]), travel && Number(travel[1])], [2.235, 2.235, 2.235]);
	});

	await R.test("G5 With the rule off, a manual invoice ignores `days`: 200, no paid-day row, and the stored render data exactly as without `days`", async ({ eq }) => {
		const w = flagsWorld({});
		const body = (days) => ({ payee: X, periodStart: "2026-10-05", periodEnd: "2026-10-06", lineItems: [{ description: "Layover", amount: 260 }], ...(days ? { days } : {}) });
		const a = await W.route(w, "POST /api/invoices/manual", { body: body(["2026-10-05"]) });
		const b = await W.route(w, "POST /api/invoices/manual", { body: body(null) });
		eq("both 200", [a.status, b.status], [200, 200]);
		eq("no paid-day row", w.db.prepare("SELECT COUNT(*) AS n FROM invoice_paid_days").get().n, 0);
		const strip = (inv) => { const d = JSON.parse(inv.render_data); delete d.invoiceNumberSuffix; return d; };
		eq("the same render data", strip(a.body.invoice), strip(b.body.invoice));
	});

	await R.test("G6 scripts/work-days-dry-run.js refuses (exit 2) a FROM at or before the latest closed month; drivers are numbered labels unless --names", async ({ eq, ok }) => {
		const w = flagsWorld({});
		w.lock(["2026-09"]);
		const copy = W.saveCopy(w, {});
		const args = (from, ...more) => [`--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, `--from=${from}`, "--json", ...more];
		const closed = W.runScript("scripts/work-days-dry-run.js", args("2026-09"));
		eq("FROM in a closed month: exit 2", closed.code, 2);
		const open = W.runScript("scripts/work-days-dry-run.js", args("2026-10"));
		eq("FROM open: exit 0 with JSON", [open.code, !!open.json], [0, true]);
		ok("without --names no driver is named", !/gia holt/i.test(open.stdout) && /driver 1/.test(open.stdout), open.stdout.slice(0, 300));
		const named = W.runScript("scripts/work-days-dry-run.js", args("2026-10", "--names"));
		ok("with --names the driver is named", named.code === 0 && /gia holt/i.test(named.stdout), named.stdout.slice(0, 300));
		eq("closed months unchanged", open.json && open.json.closedMonthsUnchanged, true);
	});

	await R.test("G7 With the rule off, generating, regenerating, deleting and restoring invoices writes no paid-day row and no floor marker", async ({ eq }) => {
		const w = flagsWorld({});
		const g = await W.generate(w, X, W39);
		await W.generate(w, X, W39);
		const id = String(w.db.prepare("SELECT id FROM invoices WHERE deleted_at = '' AND is_manual = 0").get().id);
		await W.route(w, "DELETE /api/invoices/:id", { params: { id }, query: { reason: "test" } });
		await W.route(w, "PUT /api/invoices/:id/restore", { params: { id } });
		eq("invoice made", g.status, 200);
		eq("no paid-day row, no marker", [w.db.prepare("SELECT COUNT(*) AS n FROM invoice_paid_days").get().n,
			w.db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'trip_work_days_started_at'").get().n], [0, 0]);
	});

	await R.test("G8 No At Shipper: the trip starts at the truck's ELD fix inside the pickup geofence after the Sat dispatch (Sun), not at the first In Transit (Mon); a fix before dispatch does not count; invoice, ledger and investor view alike", async ({ eq }) => {
		const D = "Hu Ives";
		const pings = W.feed(300000).drive("2026-09-25", { miles: 50, visit: W.PICKUP }).park("2026-09-26").drive("2026-09-27", { miles: 5, visit: W.PICKUP })
			.drive("2026-09-28", { miles: 200 }).drive("2026-09-29", { miles: 150 }).park("2026-09-30").pings;
		const w = W.startWorld({
			env: { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-09" },
			drivers: [{ name: D }],
			trucks: [{ unit: "T1", driver: D, vid: "V8" }],
			pings: { V8: pings },
			coords: { G801: W.PICKUP },
			rows: [loadRow({ id: "G801", driver: D, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-26", done: "2026-09-29", truck: "T1" })],
			status: [
				s("G801", "Dispatched", "2026-09-26 18:00:00", "dispatch", "super_admin"),
				s("G801", "In Transit", "2026-09-28 22:44:00"), s("G801", "Delivered", "2026-09-29 20:00:00"),
			],
		});
		const want = ["2026-09-27", "2026-09-28", "2026-09-29"];
		const g = await W.generate(w, D, W39);
		eq("invoice", W.dayList(W.gridDays(g.data, W39)), want);
		const v = await monthViews(w, D);
		eq("ledger and investor view", [uniq(v.ledger.map((x) => x.split(" ")[1])), uniq(v.investor.map((x) => x.split(" ")[1]))], [want, want]);
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
