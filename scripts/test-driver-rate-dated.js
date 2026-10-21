#!/usr/bin/env node
/**
 * Dated daily rates under the daily-rate rule (2026-10-21, decision b of the
 * pay plan): a driver's daily rate can change on a date, and the rule pays
 * each day at the rate in effect that day.
 *
 * The rule (DRIVER_RATE_ONLY_ENABLED with DRIVER_RATE_ONLY_FROM, off by
 * default; lib/driver-rate-only.js) already pays a daily-rate driver his own
 * rate, else $250, in the months it prices. With this change, in those months
 * each day reads the driver's own rate in effect that day from
 * pay_rate_history (server.js loadPayRateIndex(): a Drivers Directory save is
 * dated the day it is saved, Eastern; a day before his first row reads that
 * row), his current own rate when the history has no row for him, and $250
 * when that rate is 0 or less. One pricing helper serves every path: the
 * weekly invoice and its late days and correction drafts, the payout ledger
 * (which Financials and the payouts read), the investor view (all-time,
 * monthly, Fleet Breakdown) and check 8 of the daily integrity check. A month
 * closed before the rule first ran and every month before FROM keep the old
 * rule (the driver's current rate, else his truck's, else $250); a month
 * closed under the rule reads dated rates in its live recompute while its
 * frozen rows hold. The trip work-day rule alone (TRIP_WORK_DAYS) no longer
 * reads the history: it prices each day as the ledger does.
 *
 * Written before the change. Every case but the controls (DR2, DR3, DR5,
 * DR11) fails on the base, where the rule prices a month at the driver's
 * current rate and the trip rule alone reads the history.
 *
 * Made-up data only. Investor 5 owns T1 ($180 a day on the truck), T2 ($200)
 * and T3 ($210). Dale Nash drives T2: $280 a day through Thu Oct 1 and $320
 * from Fri Oct 2 (his directory rate now $320). Gus Thorn drives T1 at $175
 * (a $0 history row written before his rate was set). Rae Quinn drives T3 at
 * $260 with no history row. Lena Park drives T4 ($190) at $300, then $340. Weeks: W39 Sat 9/26 - Fri 10/2, W40 10/3 - 10/9.
 * The process runs in UTC, production's zone. Pure: no server, no app.db, no
 * network.
 *
 * Run: node scripts/test-driver-rate-dated.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC"; // production's clock zone

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
const FIELD_MAPS = require(path.join(ROOT, "lib", "policy-field-maps.js"));
const ic = require(path.join(ROOT, "lib", "integrity-check.js"));
const driverRateOnly = require(path.join(ROOT, "lib", "driver-rate-only.js"));
const { loadRow, et } = M;

const DALE = "Dale Nash";
const GUS = "Gus Thorn";
const RAE = "Rae Quinn";
const LENA = "Lena Park";
const norm = (x) => x.trim().toLowerCase().replace(/\s+/g, " ");
const ON = { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" };
const TRIP_OCT = { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-10" };
const W39 = "2026-10-02";
const W40 = "2026-10-09";
const NOW = Date.parse("2026-10-21T17:00:00Z"); // Wed 10/21, 1 PM Eastern
const WEEK = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const s = (lid, status, wall) => [lid, status, "manual", et(wall), ""];

// pay_rate_history rows. The seed instant is the boot that first recorded
// every rate (Fri 10/2, 11 PM Eastern); the dated rows start at Eastern midnight.
const SEED_AT = "2026-10-03T03:00:20.343Z";
const OCT1_ET = "2026-10-01T04:00:00.000Z";
const OCT2_ET = "2026-10-02T04:00:00.000Z";
const row = (driver, rate, from) => ({ subject: "driver", key: norm(driver), rate, from });
// Dale: $280 through Oct 1, $320 from Oct 2 (and the seed's $320).
const DALE_DATED = [row(DALE, 320, SEED_AT), row(DALE, 280, OCT1_ET), row(DALE, 320, OCT2_ET)];

// One world. Dale's two October loads: D101 Assigned Thu 10/1 (Thu-Fri) and
// D102 Assigned Mon 10/5 (Mon-Tue). No ELD on any truck, so each load pays the
// days of its window.
function world({ env = ON, payRates = DALE_DATED, rows = null, extraRows = [], status = [], drivers = [], trucks = [], now = NOW } = {}) {
	return M.startWorld({
		env, payRates, status, now,
		drivers: [{ name: DALE, payDaily: 320 }, { name: GUS, payDaily: 175 }, { name: RAE, payDaily: 260 }, ...drivers],
		trucks: [
			{ unit: "T1", driver: GUS, payDaily: 180 },
			{ unit: "T2", driver: DALE, payDaily: 200 },
			{ unit: "T3", driver: RAE, payDaily: 210 },
			...trucks,
		],
		rows: rows || [
			loadRow({ id: "D101", driver: DALE, pickup: "2026-10-01 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T2" }),
			loadRow({ id: "D102", driver: DALE, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T2" }),
			...extraRows,
		],
	});
}

// The weekly invoice: its paid grid days as [day, total], the Daily Rate
// column the PDF prints, and its row's rate and total.
async function weekly(w, driver, weekEnd) {
	const g = await M.generate(w, driver, weekEnd);
	return {
		status: g.status,
		days: M.gridDays(g.data, weekEnd).map((e) => [e.day, e.total]),
		rateColumn: g.data ? WEEK.map((d) => FIELD_MAPS.service_invoice(g.data).text[`${d} daily rate`]) : null,
		totalDue: g.data && g.data.totalDue,
		row: g.invoice ? { rate: g.invoice.rate_per_load, total: g.invoice.total_earnings } : null,
		g,
	};
}
// A driver's payout-ledger day items (investor 5's scope) as [month, day, cents].
async function ledgerDays(w, driver) {
	const led = await M.ledger(w);
	return led.pay.filter((i) => i.driver === norm(driver)).map((i) => [i.month, i.day, i.cents]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
}
// The investor view (as investor 5): a driver's month row, all-time figure and
// the Fleet Breakdown's pay on a truck.
async function investor(w, driver, month, unit) {
	const inv = await M.investorDays(w);
	const m = inv.months.find((x) => x.month === month);
	const det = m && m.driverDetails ? m.driverDetails[norm(driver)] : null;
	const p = (inv.body && inv.body.production) || {};
	const all = (p.driverPayDetails || {})[norm(driver)] || null;
	const truck = (p.perTruckData && p.perTruckData[unit] && p.perTruckData[unit].driverPay) || null;
	return {
		month: det ? { activeDays: det.activeDays, dailyRate: det.dailyRate, totalPay: det.totalPay, rates: det.rates || null } : null,
		allTime: all ? { activeDays: all.activeDays, dailyRate: all.dailyRate, totalPay: all.totalPay, rates: all.rates || null } : null,
		truckPay: truck ? truck.totalPay : null,
		body: inv.body,
	};
}
// The Financials month detail's row for a driver.
async function financialsRow(w, driver, month) {
	const r = await M.route(w, "GET /api/financials", { query: { month } });
	const rowOf = ((r.body && r.body.monthDetail && r.body.monthDetail.drivers) || []).find((d) => norm(d.name) === norm(driver)) || null;
	return { status: r.status, row: rowOf && { activeDays: rowOf.activeDays, dailyRate: rowOf.dailyRate, pay: rowOf.pay }, body: r.body };
}
const sumCents = (list) => list.reduce((c, x) => c + x[2], 0);
const sha = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const frozenHash = (w) => sha(w.db.prepare("SELECT * FROM financials_ledger_items ORDER BY rowid").all());

// Server functions money-plans-world does not lift (check 8's day rule, the
// directory save's history write, the payout ledger), lifted onto a world's
// database, sheet and clock with the flags `env` (as the server would start
// with them on the same app.db).
const LIFT_ROOTS = ["driverRateOnlyDayRule", "recordPayRateChanges", "computeInvestorMonthlyEarnings", "getCarrierDBFromSQLite",
	"getInvestorDriverSet", "findCol", "parseSheet", "deduplicateLoads"];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "requireRole", "requireAuth", "refuseCrossOrigin",
	"notifyChange", "getJobTrackingCached", "getSheets", "SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "renderPolicy", "fs", "DATA_DIR", "fetch", "io", "sendEmail"];
let LIFTED = null;
function liftOnto(w, env) {
	if (!LIFTED) LIFTED = closure(M.SRC, { roots: LIFT_ROOTS, routes: [], provided: PROVIDED, denied: ["server", "transporter", "getDrive", "KEY_FILE"] });
	const clock = w.clock;
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [clock.ms])); }
		static now() { return clock.ms; }
	}
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const deps = {
		db: w.db, require: createRequire(path.join(ROOT, "server.js")),
		console: { log() {}, info() {}, error() {}, warn: (...a) => w.warnings.push(a.join(" ")) },
		process: { env: { ...env }, argv: [], cwd: () => ROOT, pid: 4245 }, __dirname: ROOT, Date: FixedDate,
		app: { get() {}, put() {}, post() {}, delete() {}, use() {} }, requireRole: pass, requireAuth: pass(), refuseCrossOrigin: pass(),
		notifyChange: () => {}, getJobTrackingCached: null,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: M.sheetValues(w.rows) } }) } } }),
		SPREADSHEET_ID: "test-sheet", REPLICA: null, SHEET_TARGET: null, renderPolicy: async () => Buffer.from("%PDF-stub"),
		fs: { existsSync: () => true, mkdirSync: () => {}, readFileSync: () => "", writeFileSync: () => {}, renameSync: () => {}, unlinkSync: () => {} },
		DATA_DIR: "/nonexistent-rate-dated", fetch: () => { throw new Error("no network in a test"); }, io: null, sendEmail: async () => undefined,
	};
	const body = [
		'"use strict";',
		LIFTED.text,
		"getJobTrackingCached = async () => { const p = parseSheet({ values: __sheet() }); p.data = deduplicateLoads(p.data, p.headers); return p; };",
		`return { ${LIFT_ROOTS.join(", ")}, getJobTrackingCached: () => getJobTrackingCached() };`,
	].join("\n");
	return new Function(...Object.keys(deps), "__sheet", body)(...Object.values(deps), () => M.sheetValues(w.rows));
}

const R = M.createRunner("Dated daily rates: under the daily-rate rule each day pays the driver's own rate in effect that day (pay_rate_history), on every pay path");

(async () => {
	await R.test("DR1 Flag on, FROM 2026-10: Dale ($280 through Oct 1, $320 from Oct 2) is paid the same cents on every path: W39 Thu 10/1 $280 + Fri 10/2 $320 = $600, W40 2 x $320; the ledger $280, $320, $320, $320; the investor view's October and all-time $1,240 in two segments, T2's Fleet Breakdown pay $1,240; the Financials October row $1,240. Base: every day at his current $320 ($1,280)", async ({ eq }) => {
		const w = world();
		const w39 = await weekly(w, DALE, W39);
		eq("W39 status", w39.status, 200);
		eq("W39 grid", w39.days, [["2026-10-01", 280], ["2026-10-02", 320]]);
		eq("W39 Total Due", w39.totalDue, 600);
		eq("W40 grid", (await weekly(w, DALE, W40)).days, [["2026-10-05", 320], ["2026-10-06", 320]]);
		const led = await ledgerDays(w, DALE);
		eq("ledger", led, [["2026-10", "2026-10-01", 28000], ["2026-10", "2026-10-02", 32000], ["2026-10", "2026-10-05", 32000], ["2026-10", "2026-10-06", 32000]]);
		const inv = await investor(w, DALE, "2026-10", "T2");
		eq("investor view October", inv.month, { activeDays: 4, dailyRate: 310, totalPay: 1240, rates: [{ days: 1, rate: 280 }, { days: 3, rate: 320 }] });
		eq("investor view all-time", inv.allTime, { activeDays: 4, dailyRate: 0, totalPay: 1240, rates: [{ days: 1, rate: 280 }, { days: 3, rate: 320 }] });
		eq("Fleet Breakdown T2 pay", inv.truckPay, 1240);
		const fin = await financialsRow(w, DALE, "2026-10");
		eq("Financials October row", fin.row, { activeDays: 4, dailyRate: 310, pay: 1240 });
		eq("one figure: invoice days = ledger cents", (w39.totalDue + 640) * 100, sumCents(led));
	});

	await R.test("DR2 Control, flag off (unset, and FROM set with the flag off): nothing reads the history. Dale is paid his current $320 every day on the invoice, the ledger, the investor view and Financials, exactly as today; every answer is byte-identical with and without his history rows, and with the history table gone", async ({ eq, ok }) => {
		for (const env of [{}, { DRIVER_RATE_ONLY_FROM: "2026-10" }]) {
			const tag = JSON.stringify(env);
			// The invoice row without created_at: the wall clock when it was
			// generated, to the second, so two worlds a second apart differ there
			// and nowhere else (it failed about 1 run in 10).
			const unstamped = (invoice) => invoice && { ...invoice, created_at: undefined };
			const answers = async (w) => {
				const a = await weekly(w, DALE, W39);
				const b = await weekly(w, DALE, W40);
				const led = await M.ledger(w);
				const inv = await investor(w, DALE, "2026-10", "T2");
				const fin = await financialsRow(w, DALE, "2026-10");
				return { a: [a.status, a.g.data, unstamped(a.g.invoice)], b: [b.status, b.g.data, unstamped(b.g.invoice)], items: led.items, months: led.months, inv: inv.body, fin: fin.body };
			};
			const dated = world({ env });
			const plain = world({ env, payRates: [] });
			const gone = world({ env });
			gone.db.exec("DROP TABLE pay_rate_history");
			const x = await answers(dated);
			eq(`${tag} W39 grid at $320`, M.gridDays(x.a[1], W39).map((e) => [e.day, e.total]), [["2026-10-01", 320], ["2026-10-02", 320]]);
			eq(`${tag} ledger at $320`, (await ledgerDays(dated, DALE)).map((i) => i[2]), [32000, 32000, 32000, 32000]);
			eq(`${tag} investor October`, (await investor(dated, DALE, "2026-10", "T2")).month, { activeDays: 4, dailyRate: 320, totalPay: 1280, rates: null });
			eq(`${tag} Financials October`, (await financialsRow(dated, DALE, "2026-10")).row, { activeDays: 4, dailyRate: 320, pay: 1280 });
			ok(`${tag} byte-identical without history rows`, sha(x) === sha(await answers(plain)));
			let y = null;
			try { y = await answers(gone); } catch (e) { y = { error: e.message }; }
			ok(`${tag} byte-identical with no history table (it is never read)`, sha(x) === sha(y), y && y.error);
		}
	});

	await R.test("DR3 Control, flag on: a driver with no history row (Rae, $260) is paid his current rate every day on the invoice and the ledger", async ({ eq }) => {
		const w = world({ extraRows: [loadRow({ id: "R101", driver: RAE, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T3" })] });
		eq("invoice", (await weekly(w, RAE, W40)).days, [["2026-10-05", 260], ["2026-10-06", 260]]);
		eq("ledger", (await ledgerDays(w, RAE)).map((i) => i[2]), [26000, 26000]);
	});

	await R.test("DR4 Flag on: a day whose dated rate is $0 (Gus: a $0 row from Oct 2, his $175 saved Oct 20) is paid the $250 default on the invoice and the ledger, never his truck's $180. Base: $175 (his current rate)", async ({ eq }) => {
		const w = world({
			payRates: [row(GUS, 0, SEED_AT), row(GUS, 175, "2026-10-20T14:00:00.000Z")],
			extraRows: [loadRow({ id: "G101", driver: GUS, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T1" })],
		});
		eq("invoice", (await weekly(w, GUS, W40)).days, [["2026-10-05", 250], ["2026-10-06", 250]]);
		eq("ledger", (await ledgerDays(w, GUS)).map((i) => i[2]), [25000, 25000]);
	});

	await R.test("DR5 Control, FROM 2026-09 with September closed (10/15) before the rule first ran (10/21): September keeps the old rule, Dale's current $320 a day, not his dated $280, on the ledger and the investor view; its frozen rows are unchanged by every read", async ({ eq, ok }) => {
		const w = world({
			env: { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-09" },
			rows: [loadRow({ id: "D091", driver: DALE, pickup: "2026-09-15 8:00", dropoff: "2026-09-16 18:00", assigned: "2026-09-15", done: "2026-09-16", truck: "T2" })],
		});
		M.lockMonth(w.db, "2026-09", "2026-10-15T05:00:00.000Z");
		const books = await w.extra.buildFinancialsLedger();
		w.extra.writeLedgerFreeze("2026-09", books.items.filter((i) => i.month === "2026-09"), { source: "close", actor: "test", frozenAt: "2026-10-15T05:00:00.000Z" });
		const frozen = frozenHash(w);
		eq("frozen September", w.db.prepare("SELECT COUNT(*) AS n FROM financials_ledger_items WHERE period = '2026-09'").get().n > 0, true);
		eq("ledger September", await ledgerDays(w, DALE), [["2026-09", "2026-09-15", 32000], ["2026-09", "2026-09-16", 32000]]);
		eq("investor view September", (await investor(w, DALE, "2026-09", "T2")).month, { activeDays: 2, dailyRate: 320, totalPay: 640, rates: null });
		await financialsRow(w, DALE, "2026-09");
		ok("frozen rows unchanged", frozenHash(w) === frozen);
	});

	await R.test("DR5b Flag on, FROM 2026-10: October closed under the rule (11/15, its close record says the rule priced it) reads Dale's dated rates in its live recompute ($280 on Oct 1), also after the flag is switched off; its frozen rows are unchanged by every read. Base: $320 live", async ({ eq, ok }) => {
		const w = world();
		await M.freezeAndLock(w, "2026-10", "2026-11-15T05:00:00.000Z");
		driverRateOnly.writeCloseRecord(w.db, "2026-10", { applied: true, from: "2026-10", closedAt: "2026-11-15T05:00:00.000Z" });
		w.clock.ms = Date.parse("2026-11-20T17:00:00Z");
		const frozen = frozenHash(w);
		const want = [["2026-10", "2026-10-01", 28000], ["2026-10", "2026-10-02", 32000], ["2026-10", "2026-10-05", 32000], ["2026-10", "2026-10-06", 32000]];
		eq("live ledger, flag on", await ledgerDays(w, DALE), want);
		const off = liftOnto(w, {});
		const led = await M.ledger({ api: off, db: w.db });
		eq("live ledger, flag switched off", led.pay.filter((i) => i.driver === norm(DALE)).map((i) => [i.month, i.day, i.cents]), want);
		await investor(w, DALE, "2026-10", "T2");
		await financialsRow(w, DALE, "2026-10");
		ok("frozen rows unchanged", frozenHash(w) === frozen);
	});

	await R.test("DR6 Flag on: W39, the week straddling Oct 1/2, prints both rates: the Daily Rate column reads $280.00 on Thursday and $320.00 on Friday; the row records the latest paid day's $320 and the $600 total. Base: $320.00 both days, $640", async ({ eq }) => {
		const w39 = await weekly(world(), DALE, W39);
		eq("Daily Rate column", w39.rateColumn, ["", "", "", "", "", "$280.00", "$320.00"]);
		eq("invoice row", w39.row, { rate: 320, total: 600 });
	});

	await R.test("DR7 Flag on: check 8 passes an invoice billed at each day's dated rate (Thu 10/1 $280, Fri 10/2 $320) and flags one billed off it (Thu 10/1 at $320), naming the day and the rate in effect that day. Base: the first flagged ($280 against the directory's $320), the second passed", async ({ eq, ok }) => {
		const w = world();
		const grid = (cells) => JSON.stringify({ __templateName: "service_invoice", days: cells });
		const cell = (load, total) => ({ loadBol: load, total, completed: true });
		M.insertInvoice(w.db, {
			invoice_number: "INV-DN-2026W39-01", driver: DALE, week_start: "2026-09-26", week_end: "2026-10-02", loads_count: 2, rate_per_load: 320,
			total_earnings: 600, status: "Submitted", render_data: grid({ Thursday: cell("D101", 280), Friday: cell("D101", 320) }),
		});
		M.insertInvoice(w.db, {
			invoice_number: "INV-DN-2026W39-02", driver: DALE, week_start: "2026-09-26", week_end: "2026-10-02", loads_count: 2, rate_per_load: 320,
			total_earnings: 640, status: "Submitted", is_manual: 0, render_data: grid({ Thursday: cell("D101", 320), Friday: cell("D101", 320) }),
		});
		const lift = liftOnto(w, ON);
		const jt = await lift.getJobTrackingCached();
		const rule = lift.driverRateOnlyDayRule(jt);
		const out = ic.invoiceRateMismatches(w.db, { dailyRateRule: rule });
		eq("flagged", out.mismatches.map((m) => [m.invoiceNumber, m.days, m.invoiceCents, m.directoryCents]), [["INV-DN-2026W39-02", ["2026-10-01"], 32000, 28000]]);
		const r = await ic.runIntegrityCheck({
			db: w.db, now: new Date("2026-10-21T12:00:30Z"), write: false, sendEmail: async () => undefined, to: "admin@example.test",
			log: { log() {}, info() {}, warn() {}, error() {} }, readJobTracking: async () => jt, expensePeriodExpr: "strftime('%Y-%m', date)",
			appZone: "America/New_York", dailyRateRuleFor: () => rule,
		});
		ok("the email names the day and its dated rate",
			!!r.mail && r.mail.text.includes("Invoice INV-DN-2026W39-02 (driver Dale Nash, week 2026-09-26 to 2026-10-02, Submitted): billed at $320.00 a day on 2026-10-01; the driver's rate in effect that day is $280.00."),
			r.mail && r.mail.text);
	});

	await R.test("DR7b (review L4) Flag on: check 8 names a day whose dated rate is $0 as the $250 default: Gus (a $0 row from Oct 2, his $175 saved Oct 20) billed $175 on Mon 10/5 is flagged against $250, \"no daily rate was in effect for the driver that day, so the daily rate is the $250.00 default\". Before: \"the driver's rate in effect that day is $250.00\"", async ({ eq, ok }) => {
		const w = world({
			payRates: [row(GUS, 0, SEED_AT), row(GUS, 175, "2026-10-20T14:00:00.000Z")],
			extraRows: [loadRow({ id: "G101", driver: GUS, pickup: "2026-10-05 8:00", dropoff: "2026-10-05 18:00", assigned: "2026-10-05", done: "2026-10-05", truck: "T1" })],
		});
		M.insertInvoice(w.db, {
			invoice_number: "INV-GT-2026W40-01", driver: GUS, week_start: "2026-10-03", week_end: "2026-10-09", loads_count: 1, rate_per_load: 175,
			total_earnings: 175, status: "Submitted", render_data: JSON.stringify({ __templateName: "service_invoice", days: { Monday: { loadBol: "G101", total: 175, completed: true } } }),
		});
		const lift = liftOnto(w, ON);
		const jt = await lift.getJobTrackingCached();
		const rule = lift.driverRateOnlyDayRule(jt);
		const out = ic.invoiceRateMismatches(w.db, { dailyRateRule: rule });
		eq("flagged against the $250 default", out.mismatches.map((m) => [m.invoiceNumber, m.days, m.invoiceCents, m.directoryCents, m.defaultRate]), [["INV-GT-2026W40-01", ["2026-10-05"], 17500, 25000, true]]);
		const r = await ic.runIntegrityCheck({
			db: w.db, now: new Date("2026-10-21T12:00:30Z"), write: false, sendEmail: async () => undefined, to: "admin@example.test",
			log: { log() {}, info() {}, warn() {}, error() {} }, readJobTracking: async () => jt, expensePeriodExpr: "strftime('%Y-%m', date)",
			appZone: "America/New_York", dailyRateRuleFor: () => rule,
		});
		ok("the email says the $250 default",
			!!r.mail && r.mail.text.includes("Invoice INV-GT-2026W40-01 (driver Gus Thorn, week 2026-10-03 to 2026-10-09, Submitted): billed at $175.00 a day on 2026-10-05; no daily rate was in effect for the driver that day, so the daily rate is the $250.00 default."),
			r.mail && r.mail.text);
	});

	await R.test("DR14 (review M1) Flag on: the payout ledger's October row for Dale (paid at $280 and $320) carries its segments, and the payout statement prints its basis as \"1 day x $280 + 3 days x $320\" beside $1,240.00; Rae's one-rate row carries none and prints \"2 days × $260.00/day\" as before, the same page with or without a one-segment list. Before: no segments, \"4 days × $310.00/day\"", async ({ eq, ok }) => {
		const w = world({ extraRows: [loadRow({ id: "R101", driver: RAE, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T3" })] });
		const carrierDB = w.api.getCarrierDBFromSQLite();
		const config = {};
		w.db.prepare("SELECT key, value FROM investor_config WHERE owner_id IN (0, 5) ORDER BY owner_id").all().forEach((r) => { config[r.key] = r.value; });
		const out = await w.api.computeInvestorMonthlyEarnings({
			user: { id: 5, role: "Investor", username: "inv5" }, isSuperAdmin: false, config, detailForMonth: "2026-10", investorOwnerId: 5,
			investorDriverSet: w.api.getInvestorDriverSet(5, carrierDB.data, w.api.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0], w.api.findCol(carrierDB.headers, /carrier/i)),
		});
		const rows = (out.detail && out.detail.driverPayRows) || [];
		const dale = rows.find((x) => x.driver === norm(DALE)) || null;
		const rae = rows.find((x) => x.driver === norm(RAE)) || null;
		eq("Dale's row", dale && [dale.activeDays, dale.pay, dale.rates], [4, 1240, [{ days: 1, rate: 280 }, { days: 3, rate: 320 }]]);
		eq("Rae's row: one rate, no segments", rae && [rae.activeDays, rae.dailyRate, rae.pay, "rates" in rae], [2, 260, 520, false]);
		const S = require(path.join(ROOT, "lib", "payout-statement.js"));
		const page = (payRows) => S.buildPayoutStatementHtml({
			investorName: "Test Investor", investorCompany: "Test Holdings LLC", period: "2026-10", periodLabel: "October 2026", statementNo: "202610-5",
			generatedAt: new Date("2026-11-20T17:00:00Z"), status: "paid", paidAt: "2026-11-20T15:00:00.000Z", paidBy: "super_admin", dueDate: "2026-11-30",
			breakdown: { revenue: 8000, driverPay: 1760, fixedCosts: 0, tripExpenses: 0, maintFundCost: 0, complianceCost: 0, netProfit: 6240, splitPct: 50, monthShare: 3120 },
			lossCarriedIn: 0, lossDeferred: 0, adjustment: 0, amount: 3120, effectiveAmount: 3120,
			detail: { revenueLoads: [], driverPayRows: payRows, fixedCostItems: [], tripExpenseItems: [] },
		});
		const html = page([dale, rae].filter(Boolean));
		ok("Dale's basis: each rate", html.includes("<td>1 day x $280 + 3 days x $320</td>"), (html.match(/<td>[^<]*day[^<]*<\/td>/g) || []).join(" | "));
		ok("Rae's basis: as before", html.includes("<td>2 days &times; $260.00/day</td>"), (html.match(/<td>[^<]*day[^<]*<\/td>/g) || []).join(" | "));
		const raeOnly = rae ? { ...rae } : {};
		ok("a one-segment list prints the same page as none", page([raeOnly]) === page([{ ...raeOnly, rates: [{ days: 2, rate: 260 }] }]));
	});

	await R.test("DR8 The trip work-day rule alone (TRIP_WORK_DAYS on, DRIVER_RATE_ONLY off) prices like the ledger: Dale's W39 trip days are $320 each, as the ledger pays them, and the history is not read. Base: Thu 10/1 at the dated $280 while the ledger pays $320", async ({ eq }) => {
		const env = TRIP_OCT;
		const status = [s("D101", "At Shipper", "2026-10-01 09:00"), s("D101", "Delivered", "2026-10-02 17:00")];
		const w = world({ env, status });
		eq("W39 grid", (await weekly(w, DALE, W39)).days, [["2026-10-01", 320], ["2026-10-02", 320]]);
		eq("ledger W39 days", (await ledgerDays(w, DALE)).filter((i) => i[1] <= "2026-10-02").map((i) => i[2]), [32000, 32000]);
		const gone = world({ env, status });
		gone.db.exec("DROP TABLE pay_rate_history");
		const g = await weekly(gone, DALE, W39);
		eq("no history table: the same W39", [g.status, g.days], [200, [["2026-10-01", 320], ["2026-10-02", 320]]]);
	});

	await R.test("DR9 Flag on, after the data fix's rows (a dated $175 from Oct 1 00:00 ET, and a $175 at his $0 seed row's own instant that sorts after it): Gus is paid $175 every day from Oct 1 on the invoice and the ledger. Without the second row, his $0 seed prices Oct 2 to Oct 20 at the $250 default. Base: $175 both ways", async ({ eq }) => {
		const gusRows = [loadRow({ id: "G201", driver: GUS, pickup: "2026-10-01 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T1" }),
			loadRow({ id: "G202", driver: GUS, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T1" })];
		const fixed = world({ rows: gusRows, payRates: [row(GUS, 0, SEED_AT), row(GUS, 175, OCT1_ET), row(GUS, 175, SEED_AT)] });
		eq("W39", (await weekly(fixed, GUS, W39)).days, [["2026-10-01", 175], ["2026-10-02", 175]]);
		eq("W40", (await weekly(fixed, GUS, W40)).days, [["2026-10-05", 175], ["2026-10-06", 175]]);
		eq("ledger", (await ledgerDays(fixed, GUS)).map((i) => i[2]), [17500, 17500, 17500, 17500]);
		const half = world({ rows: gusRows, payRates: [row(GUS, 0, SEED_AT), row(GUS, 175, OCT1_ET)] });
		eq("without the second row: ledger", (await ledgerDays(half, GUS)).map((i) => [i[1], i[2]]), [["2026-10-01", 17500], ["2026-10-02", 25000], ["2026-10-05", 25000], ["2026-10-06", 25000]]);
	});

	await R.test("DR10 Flag on: a directory edit saved Sun Oct 25 ($300 -> $340, recorded by the save) prices days from Oct 25 on; Oct 20-21 stay at $300 on the invoice and the ledger. Base: every day at $340", async ({ eq }) => {
		const w = world({
			drivers: [{ name: LENA, payDaily: 300 }],
			trucks: [{ unit: "T4", driver: LENA, payDaily: 190 }],
			payRates: [row(LENA, 300, SEED_AT)],
			now: Date.parse("2026-10-25T15:00:00Z"),
			rows: [
				loadRow({ id: "L101", driver: LENA, pickup: "2026-10-20 8:00", dropoff: "2026-10-21 18:00", assigned: "2026-10-20", done: "2026-10-21", truck: "T4" }),
				loadRow({ id: "L102", driver: LENA, pickup: "2026-10-26 8:00", dropoff: "2026-10-27 18:00", assigned: "2026-10-26", done: "2026-10-27", truck: "T4" }),
			],
		});
		w.db.prepare("UPDATE drivers_directory SET pay_daily = 340 WHERE driver_name = ?").run(LENA);
		liftOnto(w, ON).recordPayRateChanges();
		w.clock.ms = Date.parse("2026-10-30T23:00:00Z");
		eq("W43", (await weekly(w, LENA, "2026-10-23")).days, [["2026-10-20", 300], ["2026-10-21", 300]]);
		eq("W44", (await weekly(w, LENA, "2026-10-30")).days, [["2026-10-26", 340], ["2026-10-27", 340]]);
		eq("ledger", (await ledgerDays(w, LENA)).map((i) => [i[1], i[2]]), [["2026-10-20", 30000], ["2026-10-21", 30000], ["2026-10-26", 34000], ["2026-10-27", 34000]]);
	});

	await R.test("DR11 Control, flag on, FROM 2026-10: Thu Oct 1 on a load Assigned Sept 29 pays in September at the old rule (Dale's current $320, not his dated $280) on the invoice and the ledger", async ({ eq }) => {
		const w = world({ rows: [loadRow({ id: "D093", driver: DALE, pickup: "2026-09-29 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-09-29", done: "2026-10-01", truck: "T2" })] });
		eq("W39", (await weekly(w, DALE, W39)).days, [["2026-09-29", 320], ["2026-09-30", 320], ["2026-10-01", 320]]);
		eq("ledger", await ledgerDays(w, DALE), [["2026-09", "2026-09-29", 32000], ["2026-09", "2026-09-30", 32000], ["2026-09", "2026-10-01", 32000]]);
	});

	await R.test("DR12 The ledger's per-day driver-pay items carry blankOwner like the per-month ones: a load with a blank Owner ID is marked on each day item with the rule on and with PAYOUT_RULES_V2's dated rates, and every item has the same fields as with the flag off. Base: no blankOwner on the dated-rate items", async ({ eq }) => {
		const rows = [loadRow({ id: "D201", driver: DALE, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", owner: "", truck: "T2" })];
		const shape = async (env) => (await M.ledger(world({ env, rows }))).pay.filter((i) => i.driver === norm(DALE)).map((i) => [i.day, i.blankOwner, Object.keys(i).sort().join(",")]);
		const off = await shape({});
		eq("flag off: blankOwner on each day", off.map((x) => [x[0], x[1]]), [["2026-10-05", true], ["2026-10-06", true]]);
		eq("rule on: the same fields", await shape(ON), off);
		eq("PAYOUT_RULES_V2 on: the same fields", await shape({ PAYOUT_RULES_V2_ENABLED: "true" }), off);
	});

	await R.test("DR13 Both rules on (TRIP_WORK_DAYS and DRIVER_RATE_ONLY from 2026-10): late days found after W39 was approved go on a correction draft at each day's dated rate, as the ledger pays them: Wed 9/30 (an October load, before Dale's first dated row) $280, Thu 10/1 $280, Fri 10/2 $320. Base: Wed 9/30 at $320 on the draft, and the ledger at $320 for 9/30 and 10/1", async ({ eq }) => {
		const w = world({
			env: { ...ON, ...TRIP_OCT }, now: M.etMs("2026-10-02 20:00"),
			rows: [
				loadRow({ id: "D301", driver: DALE, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T2" }),
				loadRow({ id: "D302", driver: DALE, pickup: "2026-09-30 9:00", dropoff: "2026-10-05 14:00", assigned: "2026-10-01", done: "", status: "In Transit", truck: "T2" }),
			],
			status: [
				s("D301", "At Shipper", "2026-09-28 08:00"), s("D301", "Delivered", "2026-09-29 17:00"),
				s("D302", "At Shipper", "2026-09-30 10:00"), s("D302", "In Transit", "2026-10-01 14:00"),
			],
		});
		const g39 = await M.generate(w, DALE, W39);
		eq("W39 made", g39.status, 200);
		w.db.prepare("UPDATE invoices SET status = 'Approved', approved_at = '2026-10-04T00:00:00.000Z', approved_by = 'super_admin' WHERE id = ?").run(g39.invoice.id);
		w.addStatus([s("D302", "At Receiver", "2026-10-05 11:00"), s("D302", "Delivered", "2026-10-05 13:00")]);
		w.setRow("D302", { "Job Status": "Delivered", "Status Update Date": "10/5/2026", "Completion Date": "10/5/2026" });
		w.clock.ms = M.etMs("2026-10-09 20:00");
		await M.generate(w, DALE, W40);
		const drafts = w.db.prepare("SELECT * FROM invoices WHERE is_manual = 1 AND correction_of IS NOT NULL AND deleted_at = '' ORDER BY id").all();
		const lines = drafts.length === 1 ? JSON.parse(drafts[0].render_data || "{}").lineItems || [] : [];
		eq("one correction draft, its lines", [drafts.length, lines.map((l) => [l.date, l.amount])], [1, [["2026-09-30", 280], ["2026-10-01", 280], ["2026-10-02", 320]]]);
		const led = (await ledgerDays(w, DALE)).filter((i) => ["2026-09-30", "2026-10-01", "2026-10-02"].includes(i[1]));
		eq("the ledger pays the same", led, [["2026-10", "2026-09-30", 28000], ["2026-10", "2026-10-01", 28000], ["2026-10", "2026-10-02", 32000]]);
	});

	R.finish();
})();
