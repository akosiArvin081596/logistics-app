#!/usr/bin/env node
/**
 * The owner's daily-rate rule (2026-10-16; DRIVER_RATE_ONLY_ENABLED with
 * DRIVER_RATE_ONLY_FROM, see test-driver-rate-only.js) in the month-end guards
 * and the payout-rules dry run.
 *
 * Once a month at or after FROM closes, its driver pay was settled under the
 * rule (the driver's own rate, else $250), so each guard must judge every closed
 * month with the rule that month was paid under: resolveDailyRate(own, truck,
 * month). Judging every month by today's rule (driver, else truck, else $250)
 * is wrong both ways after FROM's month closes:
 *   - directoryEditLockBlockers(): setting a no-rate driver's own rate to his
 *     truck's figure looks like "no change" ($150 -> $150) but reprices a
 *     closed month that paid $250 (G1: must refuse);
 *   - truckEditLockBlockers(), truckDeleteLockBlockers() and
 *     truckCreateLockBlockers(): a truck rate no longer reaches a closed month
 *     at or after FROM, so it must not be refused over one (G2, G3: must allow
 *     those months, and still refuse the months before FROM it does reprice).
 * G4: the payout-rules dry run's dated-rates variant reads the driver's dated
 * rate, else $250, for the rule's months, so it reports no truck-rate change
 * there.
 *
 * Written before the fix: G1-G4 fail on main; C1 is the control (flag off: the
 * guards answer as today) and passes on main and after.
 *
 * The guards and the dry run are lifted out of server.js (scripts/lib/server-lift.js)
 * onto the same in-memory database, sheet and clock as money-plans-world's
 * world. The rule first runs on 10/16 (boot, and a ledger read), then October
 * closes on 11/15 and the guards are asked on 11/20.
 *
 * Made-up data only: investor 5's T1 ($150 a day on the truck) carries Hal Reed
 * (no rate of his own, on T1 since August); T4 ($150) carries Ned Fair (no
 * rate, hired October 1). September and October are closed. Pure: no server,
 * no app.db, no network.
 *
 * Run: node scripts/pending/test-driver-rate-only-guards.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
function findRoot(dir) {
	while (!fs.existsSync(path.join(dir, "server.js"))) {
		const up = path.dirname(dir);
		if (up === dir) throw new Error("server.js not found above this runner");
		dir = up;
	}
	return dir;
}
const ROOT = findRoot(__dirname);
const M = require(path.join(ROOT, "scripts", "lib", "money-plans-world.js"));
const { closure } = require(path.join(ROOT, "scripts", "lib", "server-lift.js"));
const { loadRow } = M;

const HAL = "Hal Reed";
const NED = "Ned Fair";
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
const ON = { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" };
const BOOT = Date.parse("2026-10-16T17:00:00Z");
const ASKED = Date.parse("2026-11-20T17:00:00Z");

// The guards and the payout-rules dry run, lifted once.
const ROOTS = ["truckEditLockBlockers", "truckDeleteLockBlockers", "truckCreateLockBlockers", "directoryEditLockBlockers", "payoutRulesDryRun", "parseSheet", "deduplicateLoads"];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "requireRole", "requireAuth", "refuseCrossOrigin",
	"notifyChange", "getJobTrackingCached", "getSheets", "SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "renderPolicy", "fs", "DATA_DIR", "fetch", "io", "sendEmail"];
let LIFTED = null;
function liftOnto(world, env) {
	if (!LIFTED) LIFTED = closure(M.SRC, { roots: ROOTS, routes: [], provided: PROVIDED, denied: ["server", "transporter", "getDrive", "KEY_FILE"] });
	const clock = world.clock;
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [clock.ms])); }
		static now() { return clock.ms; }
	}
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const deps = {
		db: world.db, require: createRequire(path.join(ROOT, "server.js")),
		console: { log() {}, info() {}, error() {}, warn: (...a) => world.warnings.push(a.join(" ")) },
		process: { env: { ...env }, argv: [], cwd: () => ROOT, pid: 4244 }, __dirname: ROOT, Date: FixedDate,
		app: { get() {}, put() {}, post() {}, delete() {}, use() {} }, requireRole: pass, requireAuth: pass(), refuseCrossOrigin: pass(),
		notifyChange: () => {}, getJobTrackingCached: null,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: M.sheetValues(world.rows) } }) } } }),
		SPREADSHEET_ID: "test-sheet", REPLICA: null, SHEET_TARGET: null, renderPolicy: async () => Buffer.from("%PDF-stub"),
		fs: { existsSync: () => true, mkdirSync: () => {}, readFileSync: () => "", writeFileSync: () => {}, renameSync: () => {}, unlinkSync: () => {} },
		DATA_DIR: "/nonexistent-rate-guards", fetch: () => { throw new Error("no network in a test"); }, io: null, sendEmail: async () => undefined,
	};
	const body = [
		'"use strict";',
		LIFTED.text,
		"getJobTrackingCached = async () => { const p = parseSheet({ values: __sheet() }); p.data = deduplicateLoads(p.data, p.headers); return p; };",
		`return { ${ROOTS.filter((n) => n !== "parseSheet" && n !== "deduplicateLoads").join(", ")} };`,
	].join("\n");
	return new Function(...Object.keys(deps), "__sheet", body)(...Object.values(deps), () => M.sheetValues(world.rows));
}

// The guard world: the rule first runs on 10/16; October then closes on 11/15
// and the guards are asked on 11/20.
async function guardWorld(env) {
	const w = M.startWorld({
		env, now: BOOT, locks: ["2026-09"],
		drivers: [{ name: HAL, payDaily: 0 }, { name: NED, payDaily: 0 }],
		trucks: [{ unit: "T1", driver: HAL, payDaily: 150 }, { unit: "T4", driver: NED, payDaily: 150 }],
		rows: [
			loadRow({ id: "H901", driver: HAL, pickup: "2026-09-15 8:00", dropoff: "2026-09-16 18:00", assigned: "2026-09-15", done: "2026-09-16", truck: "T1" }),
			loadRow({ id: "H902", driver: HAL, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" }),
			loadRow({ id: "N902", driver: NED, pickup: "2026-10-12 8:00", dropoff: "2026-10-13 18:00", assigned: "2026-10-12", done: "2026-10-13", truck: "T4" }),
		],
	});
	w.db.prepare("UPDATE truck_assignments SET start_date = '2026-10-01T17:00:00.000Z' WHERE driver_name = ?").run(NED);
	const x = liftOnto(w, env);
	await M.ledger(w); // the rule's first use, before October closes
	M.lockMonth(w.db, "2026-10", "2026-11-15T05:00:00.000Z");
	w.clock.ms = ASKED;
	return { w, x };
}
const truckRow = (w, unit) => w.db.prepare("SELECT * FROM trucks WHERE unit_number = ?").get(unit);
const dirRow = (w, name) => w.db.prepare("SELECT * FROM drivers_directory WHERE driver_name = ?").get(name);
const periodsOf = (res, pick) => ((res && res.blockers) || []).filter(pick).map((b) => b.periods);
const NEW_TRUCK = { unit_number: "T9", status: "Active", owner_id: 0, assigned_driver: NED, driver_pay_daily: 400, in_service_date: "2026-11-20" };

const R = M.createRunner("The owner's daily-rate rule in the month-end guards and the payout-rules dry run (DRIVER_RATE_ONLY_ENABLED, DRIVER_RATE_ONLY_FROM)");

(async () => {
	await R.test("G1 Flag on, October closed under the rule at $250: setting Hal's own rate to $150 (his truck's figure) is refused over October; September (truck $150 before and after) is not named. Base: allowed ($150 -> $150 under today's rule)", async ({ eq }) => {
		const { w, x } = await guardWorld(ON);
		eq("pay_daily blocker periods", periodsOf(x.directoryEditLockBlockers(dirRow(w, HAL), { pay_daily: 150 }), (b) => b.field === "pay_daily"), [["2026-10"]]);
	});

	await R.test("G2 Flag on: changing T1's rate $150 -> $200 is refused over September only (before FROM, priced by the truck), not October; changing or deleting Ned's T4 (his closed months are all October) is allowed. Base: T1 refused over Sep and Oct, T4 refused over Oct", async ({ eq }) => {
		const { w, x } = await guardWorld(ON);
		eq("T1 rate change", periodsOf(x.truckEditLockBlockers(truckRow(w, "T1"), { driver_pay_daily: 200 }), (b) => b.field === "driver_pay_daily"), [["2026-09"]]);
		eq("T4 rate change", periodsOf(x.truckEditLockBlockers(truckRow(w, "T4"), { driver_pay_daily: 200 }), (b) => b.field === "driver_pay_daily"), []);
		eq("T4 delete", periodsOf(x.truckDeleteLockBlockers(truckRow(w, "T4")), (b) => b.table === "trucks.driver_pay_daily"), []);
	});

	await R.test("G3 Flag on: creating a $400 truck for Ned (closed months all October, priced at $250 whatever the truck) is not refused for his daily rate. Base: refused over October ($150 -> $400)", async ({ eq }) => {
		const { x } = await guardWorld(ON);
		eq("create", periodsOf(x.truckCreateLockBlockers(NEW_TRUCK, { floor: "2026-10", unbounded: false }), (b) => b.field === "driver_pay_daily"), []);
	});

	await R.test("G4 Flag on with dated rates in the payout-rules dry run: Hal's dated rate is $0 and T1's history says $200 for October; the dated-rates variant pays his October days at $250 like the current variant, so investor 5's October shows no dated-rates change. Base: a dated-rates change (the truck's $200 vs $150)", async ({ eq }) => {
		const w = M.startWorld({
			env: ON, now: BOOT,
			drivers: [{ name: HAL, payDaily: 0 }],
			trucks: [{ unit: "T1", driver: HAL, payDaily: 150 }],
			payRates: [{ subject: "driver", key: norm(HAL), rate: 0, from: "2026-10-01T12:00:00.000Z" }, { subject: "truck", key: "1", rate: 200, from: "2026-10-01T12:00:00.000Z" }],
			rows: [loadRow({ id: "H902", driver: HAL, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" })],
		});
		const out = await liftOnto(w, ON).payoutRulesDryRun();
		const oct = ((out && out.changes) || []).find((c) => c.ownerId === 5 && c.period === "2026-10") || null;
		eq("dated-rates change for investor 5's October", oct && oct.byRule ? oct.byRule.datedRates : undefined, undefined);
	});

	await R.test("C1 Control, flag off: the guards answer as today: Hal's own $150 allowed; T1 refused over Sep and Oct; T4 refused over Oct (change and delete); the $400 truck for Ned refused over Oct", async ({ eq }) => {
		const { w, x } = await guardWorld({});
		eq("directory", periodsOf(x.directoryEditLockBlockers(dirRow(w, HAL), { pay_daily: 150 }), (b) => b.field === "pay_daily"), []);
		eq("T1 rate change", periodsOf(x.truckEditLockBlockers(truckRow(w, "T1"), { driver_pay_daily: 200 }), (b) => b.field === "driver_pay_daily"), [["2026-09", "2026-10"]]);
		eq("T4 rate change", periodsOf(x.truckEditLockBlockers(truckRow(w, "T4"), { driver_pay_daily: 200 }), (b) => b.field === "driver_pay_daily"), [["2026-10"]]);
		eq("T4 delete", periodsOf(x.truckDeleteLockBlockers(truckRow(w, "T4")), (b) => b.table === "trucks.driver_pay_daily"), [["2026-10"]]);
		eq("create", periodsOf(x.truckCreateLockBlockers(NEW_TRUCK, { floor: "2026-10", unbounded: false }), (b) => b.field === "driver_pay_daily"), [["2026-10"]]);
	});

	R.finish();
})();
