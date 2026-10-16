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
 * there (and, with the flag off, it does report one).
 * G5: a month close records whether the rule priced the month, and that record
 * answers for the closed month from then on (a month closed while the flag was
 * off keeps the old rule when the flag goes on again).
 *
 * R1: that record answers even after the flag goes off or FROM moves later
 * (the ledger, the investor view and the guards keep October as it closed).
 * R2: check 8's day rule counts a load with no Assigned Date as the day's own
 * month before taking the earliest. R3: a close whose record cannot be
 * written does not close the month.
 *
 * Written before the fix: G1-G5 fail on the base, R1-R3 on the first build
 * (before the money review); C1 is the control (flag off: the guards answer as
 * today) and passes before and after.
 *
 * The guards and the dry run are lifted out of server.js (scripts/lib/server-lift.js)
 * onto the same in-memory database, sheet and clock as money-plans-world's
 * world. The rule first runs on 10/16 (boot, and a ledger read), then October
 * closes on 11/15 and the guards are asked on 11/20.
 *
 * Made-up data only: investor 5's T1 ($150 a day on the truck) carries Cal Burke
 * (no rate of his own, on T1 since August); T4 ($150) carries Ned Fair (no
 * rate, hired October 1). September and October are closed. Pure: no server,
 * no app.db, no network.
 *
 * Run: node scripts/test-driver-rate-only-guards.js    # exits 1 on failure
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

const CAL = "Cal Burke";
const NED = "Ned Fair";
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
const ON = { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" };
const BOOT = Date.parse("2026-10-16T17:00:00Z");
const ASKED = Date.parse("2026-11-20T17:00:00Z");

// The guards and the payout-rules dry run, lifted once.
// The rule's three functions are lifted when server.js has them (the fix
// adds them; G5 fails without them, and the other cases still run).
// R1-R3 read the same database through this lift with the flag as they set it:
// the payout ledger, the investor view (GET /api/investor), the month close and
// check 8's day rule.
const ROOTS = ["truckEditLockBlockers", "truckDeleteLockBlockers", "truckCreateLockBlockers", "directoryEditLockBlockers", "payoutRulesDryRun",
	...["recordDriverRateOnlyAtClose", "driverRateOnlyApplies", "driverRateOnlyDayRule"].filter((n) => M.SRC.includes(`\nfunction ${n}(`)),
	"computeInvestorMonthlyEarnings", "getCarrierDBFromSQLite", "getInvestorDriverSet", "findCol", "finalizePeriods",
	"parseSheet", "deduplicateLoads"];
const INVESTOR_HEAD = M.SRC.split("\n").find((l) => l.startsWith('app.get("/api/investor",'));
const PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "requireRole", "requireAuth", "refuseCrossOrigin",
	"notifyChange", "getJobTrackingCached", "getSheets", "SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "renderPolicy", "fs", "DATA_DIR", "fetch", "io", "sendEmail"];
let LIFTED = null;
function liftOnto(world, env) {
	if (!LIFTED) LIFTED = closure(M.SRC, { roots: ROOTS, routes: [INVESTOR_HEAD], provided: PROVIDED, denied: ["server", "transporter", "getDrive", "KEY_FILE"] });
	const routes = {};
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
		app: { get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; }, put() {}, post() {}, delete() {}, use() {} }, requireRole: pass, requireAuth: pass(), refuseCrossOrigin: pass(),
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
	const api = new Function(...Object.keys(deps), "__sheet", body)(...Object.values(deps), () => M.sheetValues(world.rows));
	return { ...api, routes };
}

// Through one lift `x`: a driver's payout-ledger October pay (investor 5's
// scope), and the investor view's October row for him.
async function octoberThrough(x, w, driver) {
	const carrierDB = x.getCarrierDBFromSQLite();
	const driverCol = x.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
	const carrierCol = x.findCol(carrierDB.headers, /carrier/i);
	const config = {};
	w.db.prepare("SELECT key, value FROM investor_config WHERE owner_id IN (0, 5) ORDER BY owner_id").all().forEach((r) => { config[r.key] = r.value; });
	const led = await x.computeInvestorMonthlyEarnings({
		user: { id: 5, role: "Investor", username: "inv5" }, isSuperAdmin: false,
		investorDriverSet: x.getInvestorDriverSet(5, carrierDB.data, driverCol, carrierCol), investorOwnerId: 5, config,
	});
	const ledgerCents = led.items.filter((i) => i.kind === "driver_pay" && i.driver === norm(driver) && i.month === "2026-10").reduce((c, i) => c + i.cents, 0);
	const inv = await M.call(x.routes["GET /api/investor"], { session: { user: { id: 5, role: "Investor", username: "inv5" } }, query: {}, params: {}, headers: {} });
	const find = (o, seen = new Set()) => {
		if (!o || typeof o !== "object" || seen.has(o)) return null;
		seen.add(o);
		if (Array.isArray(o.monthlyEarnings)) return o.monthlyEarnings;
		for (const v of Object.values(o)) { const hit = find(v, seen); if (hit) return hit; }
		return null;
	};
	const oct = (find(inv.body) || []).find((m) => m.month === "2026-10");
	const det = oct && oct.driverDetails ? oct.driverDetails[norm(driver)] : null;
	return { ledger: ledgerCents / 100, investor: det ? { dailyRate: det.dailyRate, totalPay: det.totalPay } : null };
}

// The guard world: the rule first runs on 10/16; October then closes on 11/15
// and the guards are asked on 11/20.
async function guardWorld(env) {
	const w = M.startWorld({
		env, now: BOOT, locks: ["2026-09"],
		drivers: [{ name: CAL, payDaily: 0 }, { name: NED, payDaily: 0 }],
		trucks: [{ unit: "T1", driver: CAL, payDaily: 150 }, { unit: "T4", driver: NED, payDaily: 150 }],
		rows: [
			loadRow({ id: "H901", driver: CAL, pickup: "2026-09-15 8:00", dropoff: "2026-09-16 18:00", assigned: "2026-09-15", done: "2026-09-16", truck: "T1" }),
			loadRow({ id: "H902", driver: CAL, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" }),
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
	await R.test("G1 Flag on, October closed under the rule at $250: setting Cal's own rate to $150 (his truck's figure) is refused over October; September (truck $150 before and after) is not named. Base: allowed ($150 -> $150 under today's rule)", async ({ eq }) => {
		const { w, x } = await guardWorld(ON);
		eq("pay_daily blocker periods", periodsOf(x.directoryEditLockBlockers(dirRow(w, CAL), { pay_daily: 150 }), (b) => b.field === "pay_daily"), [["2026-10"]]);
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

	await R.test("G4 Flag on with dated rates in the payout-rules dry run: Cal's dated rate is $0 and T1's history says $200 for October; the dated-rates variant pays his October days at $250 like the current variant, so investor 5's October shows no dated-rates change. Base: a dated-rates change (the truck's $200 vs $150)", async ({ eq, ok }) => {
		const w = M.startWorld({
			env: ON, now: BOOT,
			drivers: [{ name: CAL, payDaily: 0 }],
			trucks: [{ unit: "T1", driver: CAL, payDaily: 150 }],
			payRates: [{ subject: "driver", key: norm(CAL), rate: 0, from: "2026-10-01T12:00:00.000Z" }, { subject: "truck", key: "1", rate: 200, from: "2026-10-01T12:00:00.000Z" }],
			rows: [loadRow({ id: "H902", driver: CAL, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" })],
		});
		const out = await liftOnto(w, ON).payoutRulesDryRun();
		const oct = ((out && out.changes) || []).find((c) => c.ownerId === 5 && c.period === "2026-10") || null;
		eq("dated-rates change for investor 5's October", oct && oct.byRule ? oct.byRule.datedRates : undefined, undefined);
		// The positive check: the same dry run with the flag off does see the
		// truck's dated $200 against $150 (3 days, $150 more driver pay, so a lower
		// payable), so the check above can tell a change from none.
		const offOut = await liftOnto(w, {}).payoutRulesDryRun();
		const offOct = ((offOut && offOut.changes) || []).find((c) => c.ownerId === 5 && c.period === "2026-10") || null;
		ok("flag off: a dated-rates change for investor 5's October", !!(offOct && offOct.byRule && offOct.byRule.datedRates < 0), JSON.stringify(offOct));
	});

	await R.test("G5 The close record: October closes while the flag is off after the rule once ran (the start record is there), so its close records that the rule did not price it; with the flag on again, October keeps the old rule (setting Cal's own rate to his truck's $150 moves nothing there and is allowed), and finalizePeriods() records it before the lock. Base: no close record", async ({ eq, ok }) => {
		const w = M.startWorld({
			env: ON, now: BOOT, locks: ["2026-09"],
			drivers: [{ name: CAL, payDaily: 0 }],
			trucks: [{ unit: "T1", driver: CAL, payDaily: 150 }],
			rows: [loadRow({ id: "H902", driver: CAL, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" })],
		});
		w.clock.ms = Date.parse("2026-11-15T05:00:00Z");
		liftOnto(w, {}).recordDriverRateOnlyAtClose("2026-10", "2026-11-15T05:00:00.000Z");
		M.lockMonth(w.db, "2026-10", "2026-11-15T05:00:00.000Z");
		w.clock.ms = ASKED;
		const x = liftOnto(w, ON);
		eq("the rule prices October", x.driverRateOnlyApplies("2026-10"), false);
		eq("pay_daily blocker periods", periodsOf(x.directoryEditLockBlockers(dirRow(w, CAL), { pay_daily: 150 }), (b) => b.field === "pay_daily"), []);
		const close = M.SRC.indexOf("for (const p of toClose) recordDriverRateOnlyAtClose(p, nowIso);");
		ok("finalizePeriods() records it, before the lock", close > 0 && close < M.SRC.indexOf("for (const p of toClose) takeLock.run(p, nowIso, actor || \"system\");", close));
	});

	// One driver, one October load, the rule first running at boot (10/16).
	const oneLoadWorld = (rows) => M.startWorld({
		env: ON, now: BOOT, locks: ["2026-09"],
		drivers: [{ name: CAL, payDaily: 0 }],
		trucks: [{ unit: "T1", driver: CAL, payDaily: 150 }],
		rows: rows || [loadRow({ id: "H902", driver: CAL, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" })],
	});

	await R.test("R1 October closes with the flag on (its close record says the rule priced it), then the flag goes off: October stays at $250 a day on the payout ledger and the investor view ($750), setting Cal's own rate to his truck's $150 is refused over October, and moving FROM to 2026-11 leaves October at $750 too. Before: October back at the truck's $150 ($450) and the edit allowed", async ({ eq }) => {
		const w = oneLoadWorld();
		w.clock.ms = Date.parse("2026-11-15T05:00:00Z");
		liftOnto(w, ON).recordDriverRateOnlyAtClose("2026-10", "2026-11-15T05:00:00.000Z");
		M.lockMonth(w.db, "2026-10", "2026-11-15T05:00:00.000Z");
		w.clock.ms = ASKED;
		const off = liftOnto(w, {});
		eq("October with the flag off", await octoberThrough(off, w, CAL), { ledger: 750, investor: { dailyRate: 250, totalPay: 750 } });
		eq("pay_daily blocker periods with the flag off", periodsOf(off.directoryEditLockBlockers(dirRow(w, CAL), { pay_daily: 150 }), (b) => b.field === "pay_daily"), [["2026-10"]]);
		const later = liftOnto(w, { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-11" });
		eq("October's ledger with FROM moved to 2026-11", (await octoberThrough(later, w, CAL)).ledger, 750);
	});

	await R.test("R2 Check 8's day rule (driverRateOnlyDayRule()): a load with no Assigned Date counts as the day's own month before the earliest is taken, so Sept 30, paid by an undated load and by a load Assigned Oct 1, pays in September; Oct 1 on the dated load alone pays in October. Before: Sept 30 in October (the undated load was skipped)", async ({ eq }) => {
		const w = oneLoadWorld([
			loadRow({ id: "U901", driver: CAL, pickup: "2026-09-30 8:00", dropoff: "2026-09-30 18:00", assigned: "", done: "2026-09-30", truck: "T1" }),
			loadRow({ id: "U902", driver: CAL, pickup: "2026-09-30 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-10-01", done: "2026-10-01", truck: "T1" }),
		]);
		const jt = { headers: M.HEADERS, data: w.rows.map((r, i) => ({ ...r, _rowIndex: i + 2 })) };
		const rule = liftOnto(w, ON).driverRateOnlyDayRule(jt);
		eq("pay months", [rule.payMonthOf("2026-09-30", ["U901", "U902"]), rule.payMonthOf("2026-10-01", ["U902"])], ["2026-09", "2026-10"]);
	});

	await R.test("R3 A month close whose daily-rate close record cannot be written does not close the month: finalizePeriods() fails and October takes no lock (the next pass tries again). Before: the failure was logged and October was locked without its record", async ({ eq, ok }) => {
		const w = oneLoadWorld();
		w.db.exec("CREATE TRIGGER close_record_fails BEFORE INSERT ON app_settings WHEN NEW.key LIKE 'driver_rate_only.closed:%' BEGIN SELECT RAISE(ABORT, 'disk full (test)'); END;");
		w.clock.ms = Date.parse("2026-11-16T05:00:00Z");
		let threw = "";
		try {
			await liftOnto(w, ON).finalizePeriods(["2026-10"], "test");
		} catch (e) {
			threw = e.message;
		}
		ok("the close fails with the write's error", /disk full \(test\)/.test(threw), threw);
		eq("October has no lock", w.db.prepare("SELECT COUNT(*) AS n FROM period_locks WHERE period = '2026-10'").get().n, 0);
	});

	await R.test("C1 Control, flag off: the guards answer as today: Cal's own $150 allowed; T1 refused over Sep and Oct; T4 refused over Oct (change and delete); the $400 truck for Ned refused over Oct", async ({ eq }) => {
		const { w, x } = await guardWorld({});
		eq("directory", periodsOf(x.directoryEditLockBlockers(dirRow(w, CAL), { pay_daily: 150 }), (b) => b.field === "pay_daily"), []);
		eq("T1 rate change", periodsOf(x.truckEditLockBlockers(truckRow(w, "T1"), { driver_pay_daily: 200 }), (b) => b.field === "driver_pay_daily"), [["2026-09", "2026-10"]]);
		eq("T4 rate change", periodsOf(x.truckEditLockBlockers(truckRow(w, "T4"), { driver_pay_daily: 200 }), (b) => b.field === "driver_pay_daily"), [["2026-10"]]);
		eq("T4 delete", periodsOf(x.truckDeleteLockBlockers(truckRow(w, "T4")), (b) => b.table === "trucks.driver_pay_daily"), [["2026-10"]]);
		eq("create", periodsOf(x.truckCreateLockBlockers(NEW_TRUCK, { floor: "2026-10", unbounded: false }), (b) => b.field === "driver_pay_daily"), [["2026-10"]]);
	});

	R.finish();
})();
