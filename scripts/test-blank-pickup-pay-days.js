#!/usr/bin/env node
/**
 * Money plan D (2026-10-15, B12 review finding F2): a completed load with a
 * blank Pickup Appointment is paid differently by the three pay paths that
 * must move together (.claude/rules/path-backend.md, "Driver pay active
 * days"):
 *   - the weekly invoice (POST /api/invoices/generate) skips the load: no day
 *     is paid (`if (!pickup) continue;` in generateInvoiceHandler());
 *   - the payout ledger (lib/financials-calc.js computeLedgerScope()) and the
 *     investor view (GET /api/investor) start the load's window at its
 *     Assigned Date and pay Assigned Date .. Drop-off Appointment.
 * A pickup cell that is not a date ("TBD") does the same. The mirror case: a
 * blank Drop-off Appointment, where the invoice runs the window to the
 * completion date and the ledger and the investor view pay the pickup day only.
 *
 * Two flags, so driver pay and investor payouts are approved separately; each
 * applies to loads whose Assigned month (the month their days settle in) is
 * its FROM or later:
 *   INVOICE_BLANK_PICKUP_FALLBACK_ENABLED / _FROM   driver pay (D-D1 a): the
 *     invoice starts a blank or non-date pickup's window at the Assigned Date,
 *     as the ledger does; ELD check and pre-dispatch rule as today;
 *   LEDGER_BLANK_DROPOFF_FALLBACK_ENABLED / _FROM   investor payouts (D-D4 i):
 *     the ledger and the investor view end a blank drop-off's window at the
 *     completion date, as the invoice does.
 *
 * Written before the fix. Failed before it: D1-D4 (invoice flag on,
 * FROM=2026-10) and D8 (ledger flag on): D8 checks the direction, so a fix that
 * cut the invoice back to the pickup day would fail it. Passed before it and pin
 * what must not move: D5 a pickup on file; D6 both flags off, exactly today; D7
 * a week before FROM; D9 and D10 each flag moves only its own side; D11 the
 * ledger flag before FROM. Added with the fix (both failed before it): D12 the
 * generate response's warning line (D-D3), D13 the start-up warnings. Added
 * after review: D14 the warning names only a load that gains the invoice a day,
 * and D17/D18 the month-end lock covers the same days the ledger pays (the
 * driver-day override routes, flag on and off); each failed before its fix. D15
 * and D16 pin the ledger flag beside the ledger day-once rule and beside the
 * pre-dispatch rule.
 *
 * The three paths run lifted from server.js (scripts/lib/money-plans-world.js
 * on scripts/lib/work-days-world.js). Made-up data only: one driver at $300 a
 * day on investor 5's truck. Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-blank-pickup-pay-days.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC"; // production's clock zone

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
const M = require(path.join(findRoot(__dirname), "scripts", "lib", "money-plans-world.js"));
const { closure } = require(path.join(findRoot(__dirname), "scripts", "lib", "server-lift.js"));
const { loadRow } = M;

// The driver-day override routes (POST /api/admin/excluded-days, DELETE
// /api/admin/excluded-days/:id), lifted onto a world's database, sheet, clock
// and settings, for the month-end lock cases. Returns (key, req) -> response.
const OVERRIDE_HEADS = ['app.post("/api/admin/excluded-days",', 'app.delete("/api/admin/excluded-days/:id",'].map((p) => {
	const heads = M.SRC.split("\n").filter((l) => l.startsWith(p));
	if (heads.length !== 1) throw new Error(`expected one registration starting ${p}, found ${heads.length}`);
	return heads[0];
});
const OVERRIDE_PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "requireRole", "requireAuth", "refuseCrossOrigin",
	"notifyChange", "logAudit", "getJobTrackingCached", "jtCacheInvalidate", "getSheets", "SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "fs", "fetch", "io", "sendEmail"];
let OVERRIDE_LIFT = null;
function overrideRoutes(w, env) {
	if (!OVERRIDE_LIFT) OVERRIDE_LIFT = closure(M.SRC, { roots: ["parseSheet", "deduplicateLoads"], routes: OVERRIDE_HEADS, provided: OVERRIDE_PROVIDED, denied: ["server", "transporter", "getDrive", "KEY_FILE"] });
	const routes = {};
	const register = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [w.clock.ms])); }
		static now() { return w.clock.ms; }
	}
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const deps = {
		db: w.db, require: createRequire(path.join(M.ROOT, "server.js")), console: { log() {}, info() {}, error() {}, warn() {} },
		process: { env: { ...env }, argv: [], cwd: () => M.ROOT, pid: 4244 }, __dirname: M.ROOT, Date: FixedDate,
		app: { get: register("GET"), put: register("PUT"), post: register("POST"), delete: register("DELETE"), use() {} },
		requireRole: pass, requireAuth: pass(), refuseCrossOrigin: pass(), notifyChange: () => {}, logAudit: () => {},
		getJobTrackingCached: null, jtCacheInvalidate: () => {}, getSheets: null, SPREADSHEET_ID: "test-sheet", REPLICA: null, SHEET_TARGET: null,
		fs: null, fetch: () => { throw new Error("no network in a test"); }, io: null, sendEmail: async () => undefined,
	};
	const body = ['"use strict";', OVERRIDE_LIFT.text,
		"getJobTrackingCached = async () => { const p = parseSheet({ values: __sheet() }); p.data = deduplicateLoads(p.data, p.headers); return p; };",
		"return null;"].join("\n");
	new Function(...Object.keys(deps), "__sheet", body)(...Object.values(deps), () => M.sheetValues(w.rows));
	return (key, req) => M.call(routes[key], { ...M.ADMIN, query: {}, params: {}, body: {}, ...req });
}

const INVOICE_ON = { INVOICE_BLANK_PICKUP_FALLBACK_ENABLED: "true", INVOICE_BLANK_PICKUP_FALLBACK_FROM: "2026-10" };
const LEDGER_ON = { LEDGER_BLANK_DROPOFF_FALLBACK_ENABLED: "true", LEDGER_BLANK_DROPOFF_FALLBACK_FROM: "2026-10" };
const OFF = {};
const AMY = "Amy Birch";
const NOW = Date.parse("2026-10-12T16:00:00Z");
const OCT_WEEK = "2026-10-09"; // Sat 10/3 - Fri 10/9
const SEP_WEEK = "2026-09-25"; // Sat 9/19 - Fri 9/25

// The days each path pays the driver: the weekly invoice's day grid, the
// ledger's driver_pay items and the investor view's day rows.
async function paths(w, weekEnd = OCT_WEEK) {
	const g = await M.generate(w, AMY, weekEnd);
	if (g.status !== 200) throw new Error(`invoice: ${g.status} ${JSON.stringify(g.body).slice(0, 160)}`);
	const led = await M.ledger(w);
	const inv = await M.investorDays(w);
	return {
		invoice: M.dayList(M.gridDays(g.data, weekEnd)),
		invoiceTotal: g.invoice ? g.invoice.total_earnings : null,
		ledger: [...new Set(led.pay.map((p) => p.day))].sort(),
		investor: [...new Set(inv.days.map((d) => d.day))].sort(),
	};
}
function world(env, row, opts = {}) {
	return M.startWorld({ env, drivers: [{ name: AMY, payDaily: 300 }], rows: [row], now: NOW, ...opts });
}
// Assigned Mon 10/5, delivered Wed 10/7 18:00, completed 10/7; pickup blank.
const blankPickup = (extra = {}) => loadRow({ id: "D101", driver: AMY, pickup: "", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1", ...extra });
// Pickup 10/5, drop-off blank, completed 10/7.
const blankDropoff = (extra = {}) => blankPickup({ pickup: "2026-10-05 8:00", dropoff: "", ...extra });
const OCT_DAYS = ["2026-10-05", "2026-10-06", "2026-10-07"];

const R = M.createRunner("Money plan D: a blank Pickup (or Drop-off) Appointment pays the same days on the invoice, the ledger and the investor view");

(async () => {
	await R.test("D1 Invoice flag on (FROM 2026-10): blank pickup, no ELD: invoice, ledger and investor view pay the same days. Base: invoice none", async ({ eq }) => {
		const p = await paths(world(INVOICE_ON, blankPickup()));
		eq("invoice = ledger", p.invoice, p.ledger);
		eq("investor view = ledger", p.investor, p.ledger);
	});

	await R.test("D2 (D-D1 a) Invoice flag on: all three pay Assigned 10/5 .. Drop-off 10/7, $900 on the invoice. Base: invoice $0", async ({ eq }) => {
		const p = await paths(world(INVOICE_ON, blankPickup()));
		eq("days", [p.invoice, p.ledger, p.investor], [OCT_DAYS, OCT_DAYS, OCT_DAYS]);
		eq("invoice total", p.invoiceTotal, 900);
	});

	await R.test("D3 Invoice flag on: blank pickup on an ELD truck parked on the Assigned day: the ELD check drops 10/5 on every path; all three pay 10/6, 10/7. Base: invoice none", async ({ eq }) => {
		const f = M.feed(1000).park("2026-10-05").drive("2026-10-06", { miles: 320 }).drive("2026-10-07", { miles: 280 });
		const p = await paths(world(INVOICE_ON, blankPickup(), { trucks: [{ unit: "T1", driver: AMY, vid: "V1" }], pings: { V1: f.pings } }));
		const want = ["2026-10-06", "2026-10-07"];
		eq("days", [p.invoice, p.ledger, p.investor], [want, want, want]);
	});

	await R.test("D4 Invoice flag on: a pickup cell that is not a date (\"TBD\") pays as a blank one: all three 10/5-10/7. Base: invoice none", async ({ eq }) => {
		const row = blankPickup();
		row["Pickup Appointment"] = "TBD";
		const p = await paths(world(INVOICE_ON, row));
		eq("days", [p.invoice, p.ledger, p.investor], [OCT_DAYS, OCT_DAYS, OCT_DAYS]);
	});

	await R.test("D5 Control, both flags on: pickup 10/5 and drop-off 10/7 on file: all three pay 10/5-10/7", async ({ eq }) => {
		const p = await paths(world({ ...INVOICE_ON, ...LEDGER_ON }, blankPickup({ pickup: "2026-10-05 8:00" })));
		eq("days", [p.invoice, p.ledger, p.investor], [OCT_DAYS, OCT_DAYS, OCT_DAYS]);
	});

	await R.test("D6 Both flags off: nothing changes: blank pickup pays no invoice day ($0), ledger and investor view 10/5-10/7; blank drop-off pays the invoice 10/5-10/7, ledger and investor view 10/5", async ({ eq }) => {
		const a = await paths(world(OFF, blankPickup()));
		eq("blank pickup [invoice, ledger, investor, invoice total]", [a.invoice, a.ledger, a.investor, a.invoiceTotal], [[], OCT_DAYS, OCT_DAYS, 0]);
		const b = await paths(world(OFF, blankDropoff()));
		eq("blank drop-off [invoice, ledger, investor]", [b.invoice, b.ledger, b.investor], [OCT_DAYS, ["2026-10-05"], ["2026-10-05"]]);
	});

	await R.test("D7 Invoice flag on, FROM 2026-10: a September-assigned blank-pickup load (Assigned 9/21, drop-off 9/23, week ending 9/25) is paid exactly as today: no invoice day, ledger and investor view 9/21-9/23", async ({ eq }) => {
		const row = loadRow({ id: "D701", driver: AMY, pickup: "", dropoff: "2026-09-23 18:00", assigned: "2026-09-21", done: "2026-09-23", truck: "T1" });
		const p = await paths(world(INVOICE_ON, row), SEP_WEEK);
		const sep = ["2026-09-21", "2026-09-22", "2026-09-23"];
		eq("[invoice, ledger, investor]", [p.invoice, p.ledger, p.investor], [[], sep, sep]);
	});

	await R.test("D8 (D-D4 i) Ledger flag on (FROM 2026-10): blank drop-off, pickup 10/5, completed 10/7: the ledger and the investor view extend to the completion date like the invoice; all three pay 10/5-10/7 (a fix cutting the invoice back fails this). Base: ledger and investor view 10/5 only", async ({ eq }) => {
		const p = await paths(world(LEDGER_ON, blankDropoff()));
		eq("days", [p.invoice, p.ledger, p.investor], [OCT_DAYS, OCT_DAYS, OCT_DAYS]);
	});

	await R.test("D9 Invoice flag on alone: the payout side does not move: blank drop-off still pays the ledger and the investor view 10/5 only", async ({ eq }) => {
		const p = await paths(world(INVOICE_ON, blankDropoff()));
		eq("[ledger, investor]", [p.ledger, p.investor], [["2026-10-05"], ["2026-10-05"]]);
	});

	await R.test("D10 Ledger flag on alone: driver pay does not move: a blank-pickup load still pays no invoice day", async ({ eq }) => {
		const p = await paths(world(LEDGER_ON, blankPickup()));
		eq("[invoice, invoice total]", [p.invoice, p.invoiceTotal], [[], 0]);
	});

	await R.test("D11 Ledger flag on, FROM 2026-10: a September-assigned blank-drop-off load (pickup 9/21, completed 9/23) keeps the ledger and investor view at 9/21 only", async ({ eq }) => {
		const row = loadRow({ id: "D1101", driver: AMY, pickup: "2026-09-21 8:00", dropoff: "", assigned: "2026-09-21", done: "2026-09-23", truck: "T1" });
		const p = await paths(world(LEDGER_ON, row), SEP_WEEK);
		eq("[ledger, investor]", [p.ledger, p.investor], [["2026-09-21"], ["2026-09-21"]]);
	});

	await R.test("D12 (D-D3) Invoice flag on: the generate response's warnings name the load paid from its Assigned Date; the PDF's data carries no such line; flag off, no such warning", async ({ eq, ok }) => {
		const LINE = "Pickup Appointment blank; days counted from the Assigned Date: D101.";
		const on = await M.generate(world(INVOICE_ON, blankPickup()), AMY, OCT_WEEK);
		const off = await M.generate(world(OFF, blankPickup()), AMY, OCT_WEEK);
		eq("[on: status, has the line]", [on.status, on.warnings.includes(LINE)], [200, true]);
		ok("on: the PDF's render data does not say it", !JSON.stringify(on.data || {}).includes("Assigned Date"), JSON.stringify(on.data || {}).slice(0, 200));
		eq("off: no blank-pickup line", off.warnings.filter((w) => /Pickup Appointment blank/.test(w)), []);
	});

	await R.test("D13 Start-up: a FROM at or before the latest closed month logs one notice per flag; a flag on without a month stays off with one warning naming the setting, never its value", async ({ eq, ok }) => {
		const closed = world({ ...INVOICE_ON, LEDGER_BLANK_DROPOFF_FALLBACK_ENABLED: "true", LEDGER_BLANK_DROPOFF_FALLBACK_FROM: "2026-09" }, blankPickup(), { locks: ["2026-09"] });
		const notices = closed.warnings.filter((w) => /latest closed month/.test(w));
		eq("one notice, for the drop-off FROM only (the invoice FROM 2026-10 is open)", notices.length, 1);
		ok("…naming LEDGER_BLANK_DROPOFF_FALLBACK_FROM", /LEDGER_BLANK_DROPOFF_FALLBACK_FROM/.test(notices[0] || ""), notices.join(" | "));
		const bad = world({ INVOICE_BLANK_PICKUP_FALLBACK_ENABLED: "true", INVOICE_BLANK_PICKUP_FALLBACK_FROM: "Oct-2026" }, blankPickup());
		const said = bad.warnings.filter((w) => /INVOICE_BLANK_PICKUP_FALLBACK_FROM/.test(w));
		eq("one warning naming the setting", said.length, 1);
		ok("…never its value", !said.some((w) => w.includes("Oct-2026")), said.join(" | "));
		const p = await paths(bad);
		eq("…and the flag stays off: the invoice pays no day", p.invoice, []);
	});

	await R.test("D14 (L3) Invoice flag on: the warning names only a load that gains the invoice a day: none when another load with a pickup on file pays the same days, none when the ELD drops every window day", async ({ eq }) => {
		const covered = await M.generate(world(INVOICE_ON, blankPickup(), {
			rows: [blankPickup(), loadRow({ id: "D102", driver: AMY, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" })],
		}), AMY, OCT_WEEK);
		eq("covered by D102: [days, blank-pickup warnings]", [M.dayList(M.gridDays(covered.data, OCT_WEEK)), covered.warnings.filter((x) => /Pickup Appointment blank/.test(x))], [OCT_DAYS, []]);
		const f = M.feed(1000).park("2026-10-04").park("2026-10-05").park("2026-10-06").park("2026-10-07").park("2026-10-08");
		const parked = await M.generate(world(INVOICE_ON, blankPickup(), { trucks: [{ unit: "T1", driver: AMY, vid: "V1" }], pings: { V1: f.pings } }), AMY, OCT_WEEK);
		eq("parked every day: [days, blank-pickup warnings]", [M.dayList(M.gridDays(parked.data, OCT_WEEK)), parked.warnings.filter((x) => /Pickup Appointment blank/.test(x))], [[], []]);
	});

	await R.test("D15 (L1) Ledger flag and the ledger day-once rule both on (FROM 2026-10): a blank drop-off load Assigned 10/30, completed 11/2, and a November load 11/2-11/3: the ledger and the investor view pay 10/30-11/2 in October and only 11/3 in November (11/2 counted once, in the earlier month). Day-once alone: October 10/30, November 11/2-11/3", async ({ eq }) => {
		const rows = [
			loadRow({ id: "D151", driver: AMY, pickup: "2026-10-30 8:00", dropoff: "", assigned: "2026-10-30", done: "2026-11-02", truck: "T1" }),
			loadRow({ id: "D152", driver: AMY, pickup: "2026-11-02 8:00", dropoff: "2026-11-03 18:00", assigned: "2026-11-02", done: "2026-11-03", truck: "T1" }),
		];
		const DAY_ONCE = { LEDGER_DAY_ONCE_ENABLED: "true", LEDGER_DAY_ONCE_FROM: "2026-10" };
		const both = async (env) => {
			const w = world(env, rows[0], { rows, now: Date.parse("2026-11-05T16:00:00Z") });
			return [M.monthDays((await M.ledger(w)).pay), M.monthDays((await M.investorDays(w)).days)];
		};
		const on = ["2026-10 2026-10-30", "2026-10 2026-10-31", "2026-10 2026-11-01", "2026-10 2026-11-02", "2026-11 2026-11-03"];
		eq("ledger flag + day-once: [ledger, investor view]", await both({ ...LEDGER_ON, ...DAY_ONCE }), [on, on]);
		const off = ["2026-10 2026-10-30", "2026-11 2026-11-02", "2026-11 2026-11-03"];
		eq("day-once alone: [ledger, investor view]", await both(DAY_ONCE), [off, off]);
	});

	await R.test("D16 (L1) Ledger flag and the pre-dispatch rule both on (FROM 2026-10): blank drop-off, pickup 10/5, dispatched 10/6, completed 10/7, 12 km and away from the pickup on 10/5: the window ends at the completion day on all three paths, so all three drop 10/5 and pay 10/6, 10/7. Pre-dispatch alone: the ledger and the investor view pay 10/5, the invoice 10/5-10/7", async ({ eq }) => {
		const PRE = { PRE_DISPATCH_PAY_DAY_RULE_ENABLED: "true", PRE_DISPATCH_PAY_DAY_RULE_FROM: "2026-10" };
		const f = M.feed(1000).park("2026-10-02").drive("2026-10-05", { miles: 7.5 }).drive("2026-10-06", { miles: 200, visit: M.PICKUP }).drive("2026-10-07", { miles: 300 }).park("2026-10-09");
		const opts = {
			trucks: [{ unit: "T1", driver: AMY, vid: "V1" }], pings: { V1: f.pings }, coords: { D101: M.PICKUP },
			status: [["D101", "Dispatched", "dispatch", "2026-10-06 14:00:00", "super_admin"]],
		};
		const on = await paths(world({ ...PRE, ...LEDGER_ON }, blankDropoff(), opts));
		const want = ["2026-10-06", "2026-10-07"];
		eq("both on: [invoice, ledger, investor]", [on.invoice, on.ledger, on.investor], [want, want, want]);
		const off = await paths(world(PRE, blankDropoff(), opts));
		eq("pre-dispatch alone: [invoice, ledger, investor]", [off.invoice, off.ledger, off.investor], [OCT_DAYS, ["2026-10-05"], ["2026-10-05"]]);
	});

	// M1: the month-end lock covers the same days the ledger pays. October is
	// closed; a blank drop-off load Assigned 10/30 completed 11/2 (November open).
	const lockWorld = (env) => world(env, loadRow({ id: "D171", driver: AMY, pickup: "2026-10-30 8:00", dropoff: "", assigned: "2026-10-30", done: "2026-11-02", truck: "T1" }),
		{ locks: ["2026-10"], now: Date.parse("2026-11-16T16:00:00Z") });
	const overrideCase = async (env) => {
		const w = lockWorld(env);
		const ledgerPays = (await M.ledger(w)).pay.some((p) => p.month === "2026-10" && p.day === "2026-11-01");
		const call = overrideRoutes(w, env);
		const post = await call("POST /api/admin/excluded-days", { body: { driverName: AMY, date: "2026-11-01", action: "remove", reason: "test" } });
		const w2 = lockWorld(env);
		w2.addOverrides([{ driver: AMY, day: "2026-11-01" }]);
		const id = w2.db.prepare("SELECT id FROM excluded_driver_days").get().id;
		const del = await overrideRoutes(w2, env)("DELETE /api/admin/excluded-days/:id", { params: { id: String(id) } });
		return { post, del, ledgerPays, rows: [w.db.prepare("SELECT COUNT(*) AS n FROM excluded_driver_days").get().n, w2.db.prepare("SELECT COUNT(*) AS n FROM excluded_driver_days").get().n] };
	};

	await R.test("D17 (M1) Ledger flag on: October closed, the blank drop-off load Assigned 10/30 completes 11/2 and the ledger pays 11/1 in October: removing 11/1 (POST) and restoring it (DELETE) answer 409 PERIOD_FINALIZED naming October, as the lock answers for any October day, and nothing is written", async ({ eq }) => {
		const o = await overrideCase(LEDGER_ON);
		eq("the ledger pays 11/1 in October", o.ledgerPays, true);
		eq("POST: [status, code, periods]", [o.post.status, o.post.body && o.post.body.code, o.post.body && o.post.body.periods], [409, "PERIOD_FINALIZED", ["2026-10"]]);
		eq("DELETE: [status, code, periods]", [o.del.status, o.del.body && o.del.body.code, o.del.body && o.del.body.periods], [409, "PERIOD_FINALIZED", ["2026-10"]]);
		eq("[rows after POST, rows after DELETE]", o.rows, [0, 1]);
	});

	await R.test("D18 (M1) Ledger flag off: the same load pays October 10/30 only, and removing or restoring 11/1 (November, open) goes through as today", async ({ eq }) => {
		const o = await overrideCase(OFF);
		eq("the ledger does not pay 11/1", o.ledgerPays, false);
		eq("[POST status, DELETE status]", [o.post.status, o.del.status], [200, 200]);
		eq("[rows after POST, rows after DELETE]", o.rows, [1, 0]);
	});

	R.finish();
})();
