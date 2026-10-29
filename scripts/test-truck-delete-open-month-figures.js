#!/usr/bin/env node
/**
 * scripts/test-truck-delete-open-month-figures.js — deleting a truck never
 * changes an open month's figures (TD8, 2026-10-23; plan Revision 2, TD8-1 to
 * TD8-15).
 *
 * THE GAP. DELETE /api/trucks/:id judged the truck row's own money inputs for
 * CLOSED months only: truckDeleteLockBlockers() returns no blockers when no
 * month is locked, and with months locked its checks name closed months only.
 * A month that is not closed recomputes from the trucks row whenever it is
 * read, so a delete restated it: the truck's fixed costs, the rate and investor
 * ledger of the driver it names, the ELD coverage of the loads naming it, its
 * Financials reserve and depreciation lines, and the lease it keeps in service.
 * Only TRUCK_REFERENCED (assignment history or a trailer) stood in the way, for
 * an unrelated reason.
 *
 * THE RULE ASSERTED:
 *   - the delete is refused with its own 409 OPEN_MONTH_TRUCK_FIGURES while any
 *     of these applies, with counts only in the body, nothing written, and one
 *     delete_truck_blocked audit row under that code whose tail names the items
 *     as fixed words (no amounts):
 *       fixed_cost_months       in the fleet, fixed costs above 0, charged in an
 *                               open month;
 *       driver                  the truck names a driver, whatever its status,
 *                               the pay type or the rate (count 1);
 *       eld_link                an ELD device is linked, with no sheet read
 *                               (TD8-2 (a); count 1);
 *       financials_line_months  in the fleet, a maintenance reserve or purchase
 *                               price above 0, charged in an open month, whatever
 *                               the Financials toggles (TD8-3);
 *       lease_months            a lease basis row governs an open month the truck
 *                               is in service in, whatever the lease flag (TD8-4);
 *       last_truck_receipt_months  the investor's last truck, and an open month
 *                               holds a receipt (not Rejected, no truck named)
 *                               that counts on that investor only through the
 *                               driver windows (review M1); no clear step;
 *   - an open month has no lock and is no later than the current Eastern month
 *     (appDay()): a truck entering service next month is not held (TD8-6);
 *   - the order: PERIOD_LOCK_UNREADABLE, PERIOD_FINALIZED, OPEN_MONTH_TRUCK_FEES,
 *     TRUCK_HAS_DOCUMENTS, OPEN_MONTH_TRUCK_FIGURES, TRUCK_REFERENCED (TD8-7);
 *   - the text names the items that apply and the retirement date; a truck with
 *     no assignment history also gets the audited edits that clear each item,
 *     plus "detach its trailer" when one is attached (TD8-8, TD8-14);
 *   - TRUCK_HAS_DOCUMENTS leaves out "A document filed in error ..." for a truck
 *     with assignment history, which can never be deleted (TD8-9);
 *   - TRUCK_REFERENCED writes a refusal row too, with counts (#594 review, Low 2);
 *   - PUT /api/trucks/:id writes update_truck_driver when it changes the
 *     truck's driver (TD8-13: source pin here; the behaviour is in
 *     test-truck-identity-audit.js §7 and test-truck-edit-audit-coverage.js).
 *
 *   §1  Fixed costs, no month locked.
 *   §2  Fixed costs, a month locked.
 *   §3  The driver the truck names.
 *   §4  The ELD link.
 *   §5  The maintenance reserve and depreciation.
 *   §6  The lease.
 *   §7  What must not be held.
 *   §8  Order, and every item at once.
 *   §9  TD8-9: the documents text.
 *   §10 TRUCK_REFERENCED is audited.
 *   §11 Discrimination (mutants).
 *   §12 Source pins, comments stripped.
 *   §13 No amount, file name or driver name in a refusal's audit row or body.
 *   §14 The investor's last truck and receipts naming no truck (review M1).
 *
 * The route registration is lifted whole from server.js with the real guard,
 * the new truckDeleteOpenMonthHolds(), and real copies of everything they call:
 * appDay() (on an injected clock, APP_TIMEZONE America/New_York),
 * lockedPeriodsDesc(), truckFeeLockedRows(), truckFixedCostLockedMonths(),
 * truckMonthlyFixed(), truckChargeFromMonth(), truckChargeUntilMonth(),
 * truckChargedInMonth(), normalizeDriverName(), getDriverPayStructures(),
 * driverPayLockedMonths(), resolveDailyRate() (driverRateOnlyApplies() off),
 * investorsHoldingDriver(), getInvestorDriverMonthWindows(),
 * investorExpenseScopeSql(), expenseFrom() (no Personal ledger: the plain
 * table), EXPENSE_PNL_FILTER, EXPENSE_PERIOD_EXPR, lib/investor-payout-basis.js
 * and the lease settings at their defaults. The response helpers and the
 * refusal-detail formatter are the real ones. The database is in memory, built
 * from server.js's own CREATE TABLE text for the fee, document, trailer,
 * assignment, lock, directory, carrier-history, lease-basis and expenses tables
 * (with their ALTER TABLE columns); the trucks and users tables are
 * reduced to the columns read here (server.js builds trucks through a chain of
 * migrations). No server, no port, no app.db, no files, no network. Made-up
 * unit numbers and names only.
 *
 * Run: node scripts/test-truck-delete-open-month-figures.js   # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();
const investorPayoutBasis = require(path.join(ROOT, "lib", "investor-payout-basis"));

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
}
function eq(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	ok(name, a === e, `expected ${e}, got ${a}`);
}
function fatal(msg) { console.error(`FAIL  ${msg}`); process.exit(1); }

// --- lifting ---------------------------------------------------------------
function liftFn(name, src = SRC) {
	const needle = `\nfunction ${name}(`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) fatal(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = src.indexOf(needle);
	const b = src.indexOf("\n}\n", a);
	if (b < 0) fatal(`could not locate the end of function ${name} in server.js`);
	return src.slice(a + 1, b + 2);
}
// The registration, from its line to the first `});` in column 0 after it.
function routeSource(verb, routePath) {
	const head = `\napp.${verb}("${routePath}",`;
	const hits = SRC.split(head).length - 1;
	if (hits !== 1) fatal(`expected exactly 1 registration of ${verb.toUpperCase()} ${routePath}, found ${hits}`);
	const a = SRC.indexOf(head) + 1;
	const b = SRC.indexOf("\n});\n", a);
	if (b < 0) fatal(`could not find the end of ${verb.toUpperCase()} ${routePath}`);
	return SRC.slice(a, b + 4);
}
// Code only: full-line and trailing `//` comments and `/* */` blocks removed.
function codeOnly(src) {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((l) => !/^\s*\/\//.test(l))
		.map((l) => l.replace(/\s\/\/\s.*$/, ""))
		.join("\n");
}
function createTable(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\t\\)`));
	if (!m) fatal(`CREATE TABLE ${name} not found in server.js`);
	return m[0];
}

const DELETE_SRC = routeSource("delete", "/api/trucks/:id");
const PUT_SRC = routeSource("put", "/api/trucks/:id");
const GUARD = liftFn("truckDeleteLockBlockers");
// The function this change adds. Missing on a tree without it: that is one
// failure here, and the cases below then run the route as that tree has it.
const HOLDS_HITS = SRC.split("\nfunction truckDeleteOpenMonthHolds(").length - 1;
ok("truckDeleteOpenMonthHolds() is defined exactly once in server.js", HOLDS_HITS === 1, `found ${HOLDS_HITS}`);
const HOLDS = HOLDS_HITS === 1 ? liftFn("truckDeleteOpenMonthHolds") : "";
const MODULE_SRC = [
	"appDay", "lockedPeriodsDesc", "truckFeeLockedRows", "truckFixedCostLockedMonths", "truckMonthlyFixed",
	"truckChargeFromMonth", "truckChargeUntilMonth", "truckChargedInMonth", "normalizeDriverName",
	"getDriverPayStructures", "driverPayLockedMonths", "resolveDailyRate", "investorsHoldingDriver",
	"assignmentMonthKey", "intersectMonthWindow", "getInvestorDriverMonthWindows", "investorExpenseScopeSql",
	"expenseFrom", "personalLedgerPresent",
].map((n) => liftFn(n)).join("\n");
function liftConst(name) {
	const m = SRC.match(new RegExp(`^const ${name} =([\\s\\S]*?);$`, "m"));
	if (!m) fatal(`const ${name} not found in server.js`);
	return `const ${name} = ${m[1].trim()};`;
}
const CONSTS_SRC = ["EXPENSE_PNL_FILTER", "EXPENSE_PERIOD_EXPR"].map(liftConst).join("\n");
const RESPONSES_SRC = ["periodLabel", "periodBlockedResponse", "periodLockUnreadableResponse"].map((n) => liftFn(n)).join("\n");
const auditText = (v, max) => String(v == null ? "" : v).slice(0, max);
const periodRefusalDetail = new Function("auditText", `${liftFn("periodRefusalDetail")}\nreturn periodRefusalDetail;`)(auditText);
const LEASE_SETTINGS = investorPayoutBasis.readLeaseSettings({});
// Every refusal any case records, and every body, for §13.
const ALL_REFUSALS = [];
const ALL_BODIES = [];

// --- the clock -------------------------------------------------------------
// appDay() reads `new Date()`; the lifted code gets this Date, so "now" is the
// case's instant. Called with arguments it is the real Date.
const NOON_OCT_23 = Date.parse("2026-10-23T16:00:00Z"); // 12:00 ET, Friday 2026-10-23
const CLOCK = { ms: NOON_OCT_23 };
class FixedDate extends Date {
	constructor(...a) { super(...(a.length ? a : [CLOCK.ms])); }
	static now() { return CLOCK.ms; }
}

// --- scratch database ------------------------------------------------------
function scratch() {
	const db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	db.exec(`
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, status TEXT DEFAULT 'Active', owner_id INTEGER DEFAULT 0,
			assigned_driver TEXT DEFAULT '', driver_pay_daily REAL DEFAULT 0, in_service_date TEXT DEFAULT '', retired_at TEXT DEFAULT '',
			vin TEXT DEFAULT '', created_at TEXT DEFAULT '2026-10-01 09:00:00', insurance_monthly REAL DEFAULT 0, eld_monthly REAL DEFAULT 0,
			truck_payment_monthly REAL DEFAULT 0, hvut_annual REAL DEFAULT 0, irp_annual REAL DEFAULT 0,
			maintenance_fund_monthly REAL DEFAULT 0, purchase_price REAL DEFAULT 0, routemate_vehicle_id TEXT DEFAULT '');
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, company_name TEXT DEFAULT '');
	`);
	for (const t of ["maintenance_fund", "compliance_fees", "trailers", "truck_assignments", "legal_documents", "period_locks",
		"drivers_directory", "carrier_driver_history", "investor_payout_basis", "expenses"]) db.exec(createTable(t));
	for (const table of ["legal_documents", "drivers_directory", "expenses"]) {
		for (const m of SRC.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN [^"\`\\n]+`, "g"))) {
			try { db.exec(m[0]); } catch { /* a column added twice, as the boot's try/catch allows */ }
		}
	}
	return db;
}

// --- fixtures (made up) ----------------------------------------------------
const T5 = {
	id: 5, unit_number: "MADE-UP-T5", status: "Active", owner_id: 0, assigned_driver: "", driver_pay_daily: 0,
	in_service_date: "2026-10-01", retired_at: "", vin: "", created_at: "2026-10-01 09:00:00",
	insurance_monthly: 0, eld_monthly: 0, truck_payment_monthly: 0, hvut_annual: 0, irp_annual: 0,
	maintenance_fund_monthly: 0, purchase_price: 0, routemate_vehicle_id: "",
};
const INVESTOR_ID = 40;
const CARRIER = "Made Up Holdings";
const DRIVER = "Made Up Driver";

function world(opts = {}) {
	CLOCK.ms = opts.now || NOON_OCT_23;
	const db = scratch();
	const insertTruck = (t) => {
		const cols = Object.keys(t);
		db.prepare(`INSERT INTO trucks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => t[c]));
	};
	insertTruck({ ...T5, ...(opts.truck || {}) });
	// Another truck with nothing on it, plus any the case adds (ids 4 and 7).
	insertTruck({ ...T5, id: 6, unit_number: "MADE-UP-T6" });
	for (const t of opts.others || []) insertTruck({ ...T5, ...t });
	db.prepare("INSERT INTO users (id, username, role, company_name) VALUES (?, 'made-up-investor', 'Investor', ?)").run(INVESTOR_ID, CARRIER);
	for (const p of opts.locked || []) db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, 'locked', '2026-10-15T12:00:00Z')").run(p);
	for (const b of opts.basis || []) {
		db.prepare("INSERT INTO investor_payout_basis (owner_id, effective_month, basis_type, lease_amount_cents, source, created_by, created_at) VALUES (?, ?, ?, ?, 'admin', 'made-up', '2026-10-01T12:00:00Z')")
			.run(b.owner || INVESTOR_ID, b.month, b.type || "lease", b.type === "split" ? null : (b.cents || 200000));
	}
	for (const h of opts.history || []) {
		db.prepare("INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at, ended_at) VALUES (?, ?, ?, ?)").run(h.carrier, h.driver, h.started, h.ended || null);
	}
	for (const d of opts.directory || []) {
		db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_percentage, pay_daily) VALUES (?, ?, ?, ?, ?)")
			.run(d.name, d.carrier || "", d.payType || "fixed", d.pct || 0, d.daily || 0);
	}
	if (opts.assignment) {
		db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (5, ?, '2026-08-03T12:00:00.000Z', ?)")
			.run(DRIVER, opts.assignment === "ended" ? "2026-09-30T12:00:00.000Z" : "");
	}
	if (opts.trailer) db.prepare("INSERT INTO trailers (trailer_number, truck_id) VALUES ('MADE-UP-TR1', 5)").run();
	for (const r of opts.maintenance || []) {
		db.prepare("INSERT INTO maintenance_fund (type, amount, truck, date) VALUES (?, ?, 'MADE-UP-T5', ?)").run(r.type || "service", r.amount || 100, r.date);
	}
	// Receipts filed by DRIVER, naming no truck and stamped with no owner unless
	// the case says so.
	for (const x of opts.receipts || []) {
		db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, status, owner_id, truck_unit, posted_period) VALUES (?, ?, 'Fuel', 50, ?, ?, ?, ?, ?)")
			.run(`${x.date}T15:00:00.000Z`, x.driver || DRIVER, x.date, x.status || "Pending", x.owner || 0, x.truck || "", x.posted || "");
	}
	for (let i = 0; i < (opts.legal || 0); i++) {
		db.prepare("INSERT INTO legal_documents (truck_id, unit_number, doc_type, file_name, file_url) VALUES (5, 'MADE-UP-T5', 'Registration', ?, ?)")
			.run(`t5-reg-${i}.pdf`, `/uploads/legal/t5-reg-${i}.pdf`);
	}
	return { db, readable: opts.readable !== false };
}

// The guard, the holds and their helpers, built over the case's database. The
// truck charge rule (TRUCK_CHARGE_APP_DAY_*) is off.
function buildModule(w, holdsSrc) {
	const holds = holdsSrc || "function truckDeleteOpenMonthHolds() { throw new Error(\"truckDeleteOpenMonthHolds() is not in server.js\"); }";
	return new Function(
		"db", "periodLocksReadable", "investorPayoutBasis", "driverRateOnlyApplies", "Date", "APP_TIMEZONE", "INVESTOR_LEASE_SETTINGS", "console",
		`let lastPayStructShadowWarnMs = 0;\nconst TRUCK_CHARGE_APP_DAY_RULE = null;\n${CONSTS_SRC}\n${MODULE_SRC}\n${GUARD}\n${holds}\nreturn { truckDeleteLockBlockers, truckDeleteOpenMonthHolds };`,
	)(w.db, () => w.readable, investorPayoutBasis, () => false, FixedDate, "America/New_York", LEASE_SETTINGS,
		{ log() {}, warn() {}, error() {} });
}

function deleteRoute(w, rec, { routeSrc = DELETE_SRC, holdsSrc = HOLDS } = {}) {
	const mod = buildModule(w, holdsSrc);
	const AUDITED_UPSTREAM = Symbol("test");
	const recordPeriodRefusal = (audit, code, periods, subjectFallback) => {
		const a = audit || {};
		const subject = a.subject || subjectFallback;
		const row = { action: a.action, code, periods, subject, tail: a.tail, note: a.note, detail: periodRefusalDetail(subject, code, periods, a.note, a.tail) };
		rec.refusals.push(row);
		ALL_REFUSALS.push(row);
	};
	const responses = new Function("recordPeriodRefusal", "AUDITED_UPSTREAM",
		`${RESPONSES_SRC}\nreturn { periodBlockedResponse, periodLockUnreadableResponse };`)(recordPeriodRefusal, AUDITED_UPSTREAM);
	const deps = {
		requireRole: () => (req, res, next) => next(),
		db: w.db,
		truckDeleteLockBlockers: mod.truckDeleteLockBlockers,
		truckDeleteOpenMonthHolds: mod.truckDeleteOpenMonthHolds,
		auditText,
		periodBlockedResponse: responses.periodBlockedResponse,
		periodLockUnreadableResponse: responses.periodLockUnreadableResponse,
		recordPeriodRefusal,
		AUDITED_UPSTREAM,
		logAudit: (req, action, entity, id, details) => rec.audits.push({ action, entity, id, details }),
		notifyChange: () => {},
		console: { log() {}, warn() {}, error: (...a) => rec.errors.push(a.map(String).join(" ")) },
	};
	let captured = null;
	const app = { delete: (p, ...chain) => { captured = { path: p, chain }; } };
	new Function("app", ...Object.keys(deps), `${routeSrc};`)(app, ...Object.values(deps));
	if (!captured || captured.path !== "/api/trucks/:id") fatal("the lifted registration did not register DELETE /api/trucks/:id");
	return captured.chain;
}
function del(w, opts) {
	const rec = { refusals: [], audits: [], errors: [] };
	const chain = deleteRoute(w, rec, opts);
	const req = { method: "DELETE", params: { id: "5" }, body: {}, query: {}, headers: {}, session: { user: { id: 1, username: "super_admin", role: "Super Admin" } } };
	const res = {
		statusCode: 200, body: undefined,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
	};
	let threw = null;
	try {
		for (const mw of chain) {
			let next = false;
			mw(req, res, () => { next = true; });
			if (!next) break;
		}
	} catch (err) { threw = err.message; }
	if (res.body) ALL_BODIES.push(res.body);
	return { status: res.statusCode, body: res.body || {}, threw, ...rec };
}
const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;
const snapshot = (w) => [
	count(w.db, "SELECT COUNT(*) AS n FROM trucks"),
	count(w.db, "SELECT COUNT(*) AS n FROM maintenance_fund"),
	count(w.db, "SELECT COUNT(*) AS n FROM legal_documents"),
	count(w.db, "SELECT COUNT(*) AS n FROM truck_assignments"),
	count(w.db, "SELECT COUNT(*) AS n FROM trailers"),
];
const done = (w) => w.db.close();
const truckGone = (w) => count(w.db, "SELECT COUNT(*) AS n FROM trucks WHERE id = 5") === 0;

// --- the expected text -----------------------------------------------------
const ZERO = { fixed_cost_months: 0, driver: 0, eld_link: 0, financials_line_months: 0, lease_months: 0, last_truck_receipt_months: 0 };
const counts = (o) => ({ ...ZERO, ...o });
const P = {
	fixed: (n) => `its monthly fixed costs are billed in ${n} open month${n === 1 ? "" : "s"}`,
	driver: "it names a driver, so it sets that driver's daily rate and investor ledger",
	eld: "its ELD device sets the paid days of the loads that name it",
	fin: (n) => `its maintenance reserve or depreciation is a Financials line in ${n} open month${n === 1 ? "" : "s"}`,
	lease: (n) => `it keeps its investor's lease in service in ${n} open month${n === 1 ? "" : "s"}`,
	receipts: (n) => `it is its investor's last truck, which keeps receipts that name no truck on that investor's ledger in ${n} open month${n === 1 ? "" : "s"}`,
};
const S = {
	fixed: "set its insurance, ELD fee, truck payment, HVUT and IRP to $0",
	fin: "set its maintenance reserve and purchase price to $0",
	driver: "clear its driver",
	eld: "unlink its ELD device",
	owner: "set its owner to the company",
	trailer: "detach its trailer",
};
const STAYS = "Deleting the truck would change an open month's figures, so it stays in place. To take it out of service, give it a retirement date in an open month.";
const figuresText = (parts, steps) =>
	`Cannot delete MADE-UP-T5: ${parts.join("; ")}. ${STAYS}` +
	(steps.length ? ` If it was added by mistake, do these first, then delete it: ${steps.join("; ")}.` : "") +
	" Nothing was changed.";
const RETIRE = "To take it out of service, give it a retirement date in an open month. Nothing was changed.";
const FILED_IN_ERROR = "A document filed in error can be removed from the truck's documents first.";

// One refusal: the code, the counts, the text, nothing written, one audit row
// under the code with the items named in its tail.
function expectFigures(label, w, r, before, { counts: c, parts, steps, held }) {
	eq(`${label}: 409 OPEN_MONTH_TRUCK_FIGURES`, [r.status, r.body.code], [409, "OPEN_MONTH_TRUCK_FIGURES"]);
	ok(`${label}: the route did not throw`, r.threw === null, r.threw);
	eq(`${label}: the counts`, r.body.counts, c);
	eq(`${label}: the body holds the text, the code and the counts only`, Object.keys(r.body).sort(), ["code", "counts", "error"]);
	eq(`${label}: the text`, r.body.error, figuresText(parts, steps));
	eq(`${label}: nothing written`, snapshot(w), before);
	eq(`${label}: one refusal row, delete_truck_blocked under OPEN_MONTH_TRUCK_FIGURES, the items named in its tail`,
		r.refusals.map((x) => [x.action, x.code, x.periods, x.tail]),
		[["delete_truck_blocked", "OPEN_MONTH_TRUCK_FIGURES", [], `nothing was written — holds: ${held}`]]);
	eq(`${label}: no delete_truck success row`, r.audits.filter((a) => a.action === "delete_truck").length, 0);
}

// ---------------------------------------------------------------------------
// §1 Fixed costs, no month locked (TD8-1).
// ---------------------------------------------------------------------------
{
	const w = world({ truck: { insurance_monthly: 1500 } });
	const before = snapshot(w);
	const r = del(w);
	expectFigures("§1 fixed costs, no month locked", w, r, before,
		{ counts: counts({ fixed_cost_months: 1 }), parts: [P.fixed(1)], steps: [S.fixed], held: "fixed costs" });
	// The plan's wording, spelled out once in full.
	eq("§1 ...the text, in full",
		r.body.error,
		"Cannot delete MADE-UP-T5: its monthly fixed costs are billed in 1 open month. Deleting the truck would change an open month's figures, " +
		"so it stays in place. To take it out of service, give it a retirement date in an open month. If it was added by mistake, do these " +
		"first, then delete it: set its insurance, ELD fee, truck payment, HVUT and IRP to $0. Nothing was changed.");
	ok("§1 ...the stored detail carries the code and the items",
		String((r.refusals[0] || {}).detail).endsWith("WITHHELD [OPEN_MONTH_TRUCK_FIGURES] — nothing was written — holds: fixed costs"),
		(r.refusals[0] || {}).detail);
	done(w);
}
for (const [label, truck] of [
	["the ELD fee", { eld_monthly: 45 }],
	["the truck payment", { truck_payment_monthly: 2100 }],
	["HVUT", { hvut_annual: 550 }],
	["IRP", { irp_annual: 1200 }],
]) {
	const w = world({ truck });
	const r = del(w);
	eq(`§1 ${label} only: refused, fixed_cost_months 1`, [r.status, r.body.code, r.body.counts], [409, "OPEN_MONTH_TRUCK_FIGURES", counts({ fixed_cost_months: 1 })]);
	done(w);
}

// ---------------------------------------------------------------------------
// §2 The same with a month locked: same code, text and audit.
// ---------------------------------------------------------------------------
{
	const w = world({ locked: ["2026-09"], truck: { insurance_monthly: 1500 } });
	const before = snapshot(w);
	const r = del(w);
	expectFigures("§2 fixed costs, September locked", w, r, before,
		{ counts: counts({ fixed_cost_months: 1 }), parts: [P.fixed(1)], steps: [S.fixed], held: "fixed costs" });
	done(w);
}
{
	// In service since August with nothing locked: August, September and October
	// are all open.
	const w = world({ truck: { insurance_monthly: 1500, in_service_date: "2026-08-04" } });
	const r = del(w);
	eq("§2 in service since August, nothing locked: 3 open months", [r.body.code, r.body.counts && r.body.counts.fixed_cost_months], ["OPEN_MONTH_TRUCK_FIGURES", 3]);
	ok("§2 ...plural text", String(r.body.error || "").includes(`${P.fixed(3)}.`), r.body.error);
	done(w);
}

// ---------------------------------------------------------------------------
// §3 The driver the truck names (TD8-1; review M1). No assignment row in any of
// these, so only drift reaches the cascade this way.
// ---------------------------------------------------------------------------
{
	// 3a: Inactive, a fixed-pay driver with no rate of his own, $0 costs. A month
	// is locked, so the guard's closed-month driver checks run, and find nothing.
	const w = world({ locked: ["2026-09"], truck: { status: "Inactive", assigned_driver: DRIVER }, directory: [{ name: DRIVER }] });
	const before = snapshot(w);
	const r = del(w);
	expectFigures("§3a an Inactive truck naming a fixed-pay driver, $0 costs", w, r, before,
		{ counts: counts({ driver: 1 }), parts: [P.driver], steps: [S.driver], held: "driver" });
	done(w);
}
{
	// 3b: the driver is named on two trucks. This one is read last at the $250
	// default; the other has a higher rate.
	const w = world({ truck: { id: 5, assigned_driver: DRIVER }, others: [{ id: 4, unit_number: "MADE-UP-T4", assigned_driver: DRIVER, driver_pay_daily: 300 }] });
	const r = del(w);
	eq("§3b the driver named on two trucks: refused, driver 1", [r.status, r.body.code, r.body.counts], [409, "OPEN_MONTH_TRUCK_FIGURES", counts({ driver: 1 })]);
	eq("§3b ...both trucks kept", count(w.db, "SELECT COUNT(*) AS n FROM trucks WHERE id IN (4, 5)"), 2);
	done(w);
}
{
	// 3c: the investor's truck, no assignment rows; the driver is held on the
	// investor's ledger only through an ended carrier pairing. A month is locked,
	// so the guard's driver-set check runs and finds the pairing still holds him.
	const w = world({
		locked: ["2026-09"],
		truck: { owner_id: INVESTOR_ID, assigned_driver: DRIVER },
		history: [{ carrier: CARRIER, driver: DRIVER, started: "2026-08-01", ended: "2026-09-30" }],
	});
	const r = del(w);
	eq("§3c an investor's truck, the driver held through an ended pairing: refused, driver 1", [r.status, r.body.code, r.body.counts], [409, "OPEN_MONTH_TRUCK_FIGURES", counts({ driver: 1 })]);
	done(w);
}
{
	// 3d: a percentage-paid driver. No figure reads a daily rate for him, but the
	// truck still decides his investor ledger: the item is unconditional.
	const w = world({ truck: { assigned_driver: DRIVER }, directory: [{ name: DRIVER, payType: "percentage", pct: 30 }] });
	const r = del(w);
	eq("§3d a percentage-paid driver: refused, driver 1", [r.status, r.body.code, r.body.counts], [409, "OPEN_MONTH_TRUCK_FIGURES", counts({ driver: 1 })]);
	done(w);
}
{
	// A name of spaces only names no driver.
	const w = world({ truck: { assigned_driver: "   " } });
	const r = del(w);
	eq("§3 a driver name of spaces only: no driver, the delete goes through", [r.status, r.body.success], [200, true]);
	done(w);
}

// ---------------------------------------------------------------------------
// §4 The ELD link (TD8-2 (a): no sheet read).
// ---------------------------------------------------------------------------
{
	const w = world({ truck: { routemate_vehicle_id: "made-up-vid-1" } });
	const before = snapshot(w);
	const r = del(w);
	expectFigures("§4 an ELD-linked truck, $0 costs", w, r, before,
		{ counts: counts({ eld_link: 1 }), parts: [P.eld], steps: [S.eld], held: "ELD link" });
	done(w);
}
{
	// The plan's example: fixed costs and the ELD link together.
	const w = world({ truck: { insurance_monthly: 1500, routemate_vehicle_id: "made-up-vid-1" } });
	const r = del(w);
	eq("§4 fixed costs and the ELD link: the plan's example text",
		r.body.error,
		"Cannot delete MADE-UP-T5: its monthly fixed costs are billed in 1 open month; its ELD device sets the paid days of the loads that name it. " +
		"Deleting the truck would change an open month's figures, so it stays in place. To take it out of service, give it a retirement date in an " +
		"open month. If it was added by mistake, do these first, then delete it: set its insurance, ELD fee, truck payment, HVUT and IRP to $0; " +
		"unlink its ELD device. Nothing was changed.");
	eq("§4 ...audited naming both", r.refusals.map((x) => x.tail), ["nothing was written — holds: fixed costs, ELD link"]);
	done(w);
}

// ---------------------------------------------------------------------------
// §5 The maintenance reserve and depreciation, counted whatever the
// Financials toggles say (TD8-3).
// ---------------------------------------------------------------------------
{
	const w = world({ truck: { maintenance_fund_monthly: 200 } });
	const before = snapshot(w);
	const r = del(w);
	expectFigures("§5a a maintenance reserve only", w, r, before,
		{ counts: counts({ financials_line_months: 1 }), parts: [P.fin(1)], steps: [S.fin], held: "reserve or depreciation" });
	done(w);
}
{
	const w = world({ truck: { purchase_price: 85000 } });
	const r = del(w);
	eq("§5b a purchase price only: refused, financials_line_months 1", [r.status, r.body.code, r.body.counts], [409, "OPEN_MONTH_TRUCK_FIGURES", counts({ financials_line_months: 1 })]);
	done(w);
}
{
	// 6c (review Low 1): in service since a locked month; only October is open.
	// A reserve is no fixed cost, so the closed-month guard has nothing to say.
	const w = world({ locked: ["2026-08", "2026-09"], truck: { maintenance_fund_monthly: 200, in_service_date: "2026-08-04" } });
	const r = del(w);
	eq("§5c a reserve, in service since a locked month: refused, counting 1 open month",
		[r.status, r.body.code, r.body.counts], [409, "OPEN_MONTH_TRUCK_FIGURES", counts({ financials_line_months: 1 })]);
	ok("§5c ...the text says \"in 1 open month\"", String(r.body.error || "").includes(`${P.fin(1)}.`), r.body.error);
	done(w);
}

// ---------------------------------------------------------------------------
// §6 The lease, counted whether or not the lease flag is on (TD8-4, TD8-14).
// ---------------------------------------------------------------------------
{
	const w = world({ truck: { owner_id: INVESTOR_ID }, basis: [{ month: "2026-10" }] });
	const before = snapshot(w);
	const r = del(w);
	expectFigures("§6a a lease row effective this month, $0 costs", w, r, before,
		{ counts: counts({ lease_months: 1 }), parts: [P.lease(1)], steps: [S.owner], held: "lease" });
	ok("§6b the clear step is \"set its owner to the company\"", String(r.body.error || "").includes(`then delete it: ${S.owner}.`), r.body.error);
	done(w);
}
{
	const w = world({ truck: { owner_id: INVESTOR_ID } });
	const r = del(w);
	eq("§6c an investor's truck with no basis row: the delete goes through", [r.status, r.body.success], [200, true]);
	done(w);
}
{
	const w = world({ truck: { owner_id: INVESTOR_ID }, basis: [{ month: "2026-11" }] });
	const r = del(w);
	eq("§6 a lease row effective next month only: the delete goes through", [r.status, r.body.success], [200, true]);
	done(w);
}
{
	const w = world({ truck: { owner_id: INVESTOR_ID }, basis: [{ month: "2026-08" }, { month: "2026-10", type: "split" }] });
	const r = del(w);
	eq("§6 a lease superseded by a split row before this month: the delete goes through", [r.status, r.body.success], [200, true]);
	done(w);
}
{
	// The lease's retirement setting ("stop", the default): a truck retired before
	// this month covers none of it.
	const w = world({ locked: ["2026-08", "2026-09"], truck: { owner_id: INVESTOR_ID, in_service_date: "2026-08-04", retired_at: "2026-09-30" }, basis: [{ month: "2026-08" }] });
	const r = del(w);
	eq("§6 a lease truck retired in a closed month: the open month is not covered, the delete goes through", [r.status, r.body.success], [200, true]);
	done(w);
}

// ---------------------------------------------------------------------------
// §7 What must not be held.
// ---------------------------------------------------------------------------
{
	const w = world();
	const r = del(w);
	eq("§7a everything 0 or blank: 200", [r.status, r.body.success], [200, true]);
	ok("§7a ...the truck is gone", truckGone(w));
	eq("§7a ...removed counts are all 0", r.body.removed, { legal_documents: 0, maintenance_fund: 0, compliance_fees: 0 });
	eq("§7a ...one delete_truck row, no refusal", [r.audits.filter((a) => a.action === "delete_truck").length, r.refusals.length], [1, 0]);
	done(w);
}
{
	const w = world({ truck: { status: "Inactive", insurance_monthly: 1500, maintenance_fund_monthly: 200, purchase_price: 85000 } });
	const r = del(w);
	eq("§7b Inactive, with costs, a reserve and a price, no driver, unlinked: 200", [r.status, r.body.success], [200, true]);
	done(w);
}
{
	const w = world({ truck: { insurance_monthly: 1500, maintenance_fund_monthly: 200, in_service_date: "2026-11-05" } });
	const r = del(w);
	eq("§7c in service next month, with costs: 200 (a later month is no open month's figure yet)", [r.status, r.body.success], [200, true]);
	done(w);
}
{
	const w = world({ locked: ["2026-08", "2026-09"], truck: { insurance_monthly: 1500, in_service_date: "2026-08-04", retired_at: "2026-09-30" } });
	const before = snapshot(w);
	const r = del(w);
	eq("§7d retired in a closed month, every charged month closed: PERIOD_FINALIZED", [r.status, r.body.code], [409, "PERIOD_FINALIZED"]);
	ok("§7d ...the new code appears nowhere", !JSON.stringify(r.body).includes("OPEN_MONTH_TRUCK_FIGURES") && !r.refusals.some((x) => x.code === "OPEN_MONTH_TRUCK_FIGURES"));
	eq("§7d ...nothing written", snapshot(w), before);
	done(w);
}
{
	// 8e (review Low 2): 2026-10-31 23:30 ET is 2026-11-01 03:30 UTC. The business
	// month is still October, so a truck entering service on November 1 is not held.
	const w = world({ now: Date.parse("2026-11-01T03:30:00Z"), truck: { insurance_monthly: 1500, in_service_date: "2026-11-01" } });
	const r = del(w);
	eq("§7e Oct 31 23:30 ET, a truck in service Nov 1 with costs: 200", [r.status, r.body.success], [200, true]);
	done(w);
}
{
	// The same instant, with the truck in service in October: held.
	const w = world({ now: Date.parse("2026-11-01T03:30:00Z"), truck: { insurance_monthly: 1500, in_service_date: "2026-10-31" } });
	const r = del(w);
	eq("§7e ...the same instant, in service Oct 31: refused, 1 open month", [r.body.code, r.body.counts && r.body.counts.fixed_cost_months], ["OPEN_MONTH_TRUCK_FIGURES", 1]);
	done(w);
}
{
	const w = world({ readable: false, truck: { insurance_monthly: 1500 } });
	const r = del(w);
	eq("§7 an unreadable lock table still answers PERIOD_LOCK_UNREADABLE first", [r.status, r.body.code], [409, "PERIOD_LOCK_UNREADABLE"]);
	done(w);
}

// ---------------------------------------------------------------------------
// §8 Order (TD8-7), and every item at once.
// ---------------------------------------------------------------------------
const ALL_ITEMS = {
	owner_id: INVESTOR_ID, assigned_driver: DRIVER, insurance_monthly: 1500, maintenance_fund_monthly: 200, routemate_vehicle_id: "made-up-vid-1",
};
{
	const w = world({ locked: ["2026-09"], truck: { ...ALL_ITEMS, in_service_date: "2026-09-01" }, basis: [{ month: "2026-09" }] });
	const r = del(w);
	eq("§8a a closed-month blocker and every item: PERIOD_FINALIZED", [r.status, r.body.code], [409, "PERIOD_FINALIZED"]);
	eq("§8a ...audited as PERIOD_FINALIZED only", r.refusals.map((x) => x.code), ["PERIOD_FINALIZED"]);
	done(w);
}
{
	const w = world({ truck: ALL_ITEMS, basis: [{ month: "2026-10" }], maintenance: [{ type: "service", date: "2026-10-06" }] });
	const r = del(w);
	eq("§8b a fee row and every item: OPEN_MONTH_TRUCK_FEES", [r.status, r.body.code], [409, "OPEN_MONTH_TRUCK_FEES"]);
	done(w);
}
{
	const w = world({ truck: ALL_ITEMS, basis: [{ month: "2026-10" }], legal: 1 });
	const r = del(w);
	eq("§8c a legal document and every item: TRUCK_HAS_DOCUMENTS", [r.status, r.body.code], [409, "TRUCK_HAS_DOCUMENTS"]);
	done(w);
}
{
	// 9d: items and assignment history: the new code, the retirement date only.
	const w = world({ truck: { insurance_monthly: 1500 }, assignment: "ended" });
	const before = snapshot(w);
	const r = del(w);
	expectFigures("§8d fixed costs and assignment history", w, r, before,
		{ counts: counts({ fixed_cost_months: 1 }), parts: [P.fixed(1)], steps: [], held: "fixed costs" });
	eq("§8d ...the text, in full: no clear steps",
		r.body.error,
		"Cannot delete MADE-UP-T5: its monthly fixed costs are billed in 1 open month. Deleting the truck would change an open month's figures, " +
		"so it stays in place. To take it out of service, give it a retirement date in an open month. Nothing was changed.");
	done(w);
}
{
	const w = world({ truck: { assigned_driver: DRIVER }, assignment: "open", trailer: true });
	const r = del(w);
	eq("§8d a named driver, history and a trailer: the new code, the retirement date only",
		[r.body.code, r.body.error], ["OPEN_MONTH_TRUCK_FIGURES", figuresText([P.driver], [])]);
	done(w);
}
{
	const w = world({ assignment: "ended" });
	const r = del(w);
	eq("§8e history and no item: TRUCK_REFERENCED, as before", [r.status, r.body.code], [409, "TRUCK_REFERENCED"]);
	done(w);
}
{
	// 9f (review Low 3): a trailer and no history: the steps end in "detach its trailer".
	const w = world({ truck: { insurance_monthly: 1500 }, trailer: true });
	const before = snapshot(w);
	const r = del(w);
	expectFigures("§8f fixed costs and a trailer, no history", w, r, before,
		{ counts: counts({ fixed_cost_months: 1 }), parts: [P.fixed(1)], steps: [S.fixed, S.trailer], held: "fixed costs" });
	done(w);
}
{
	// Every item at once, no history, a trailer: the parts in the plan's order,
	// the steps in theirs.
	const w = world({ truck: { ...ALL_ITEMS, purchase_price: 85000 }, basis: [{ month: "2026-10" }], trailer: true });
	const before = snapshot(w);
	const r = del(w);
	expectFigures("§8 every item, no history, a trailer", w, r, before, {
		counts: counts({ fixed_cost_months: 1, driver: 1, eld_link: 1, financials_line_months: 1, lease_months: 1 }),
		parts: [P.fixed(1), P.driver, P.eld, P.fin(1), P.lease(1)],
		steps: [S.fixed, S.fin, S.driver, S.eld, S.owner, S.trailer],
		held: "fixed costs, driver, ELD link, reserve or depreciation, lease",
	});
	ok("§8 ...the remedy never says Inactive", !/inactive/i.test(String(r.body.error || "")), r.body.error);
	done(w);
}

// ---------------------------------------------------------------------------
// §9 TD8-9: the "filed in error" sentence only where it can lead to a delete.
// ---------------------------------------------------------------------------
{
	const w = world({ legal: 2, assignment: "ended" });
	const r = del(w);
	eq("§9a two documents and assignment history: TRUCK_HAS_DOCUMENTS without the \"filed in error\" sentence",
		[r.status, r.body.code, r.body.error],
		[409, "TRUCK_HAS_DOCUMENTS", `Cannot delete MADE-UP-T5: 2 legal documents are filed under this truck. Deleting the truck would permanently delete them, so it stays in place. ${RETIRE}`]);
	eq("§9a ...counts and audit as before", [r.body.counts, r.refusals.map((x) => [x.code, x.tail])],
		[{ legal_documents: 2 }, [["TRUCK_HAS_DOCUMENTS", "nothing was written — legal_documents=2"]]]);
	done(w);
}
for (const [label, opts] of [["no history", { legal: 1 }], ["no history, a trailer", { legal: 1, trailer: true }]]) {
	const w = world(opts);
	const r = del(w);
	eq(`§9b one document, ${label}: the sentence stays`,
		[r.body.code, r.body.error],
		["TRUCK_HAS_DOCUMENTS", `Cannot delete MADE-UP-T5: 1 legal document is filed under this truck. Deleting the truck would permanently delete it, so it stays in place. ${FILED_IN_ERROR} ${RETIRE}`]);
	done(w);
}

// ---------------------------------------------------------------------------
// §10 TRUCK_REFERENCED is audited (#594 review, Low 2), counts only.
// ---------------------------------------------------------------------------
{
	const w = world({ assignment: "ended", trailer: true });
	const before = snapshot(w);
	const r = del(w);
	eq("§10 history and a trailer, no item: TRUCK_REFERENCED with its references", [r.status, r.body.code, r.body.references],
		[409, "TRUCK_REFERENCED", { truck_assignments: 1, trailers: 1 }]);
	eq("§10 ...one refusal row under TRUCK_REFERENCED, its counts in the tail",
		r.refusals.map((x) => [x.action, x.code, x.periods, x.tail]),
		[["delete_truck_blocked", "TRUCK_REFERENCED", [], "nothing was written — truck_assignments=1, trailers=1"]]);
	eq("§10 ...nothing written", snapshot(w), before);
	done(w);
}
{
	const w = world({ trailer: true });
	const r = del(w);
	eq("§10 a trailer only: TRUCK_REFERENCED, audited", [r.body.code, r.refusals.map((x) => x.tail)],
		["TRUCK_REFERENCED", ["nothing was written — truck_assignments=0, trailers=1"]]);
	done(w);
}

// ---------------------------------------------------------------------------
// §11 Discrimination: each mutant flips the case it is aimed at. A mutant whose
// anchor is not found exactly once is a failure, never a pass.
// ---------------------------------------------------------------------------
function mutate(src, from, to, label) {
	const n = src.split(from).length - 1;
	ok(`§11 mutant anchor found exactly once (${label})`, n === 1, `found ${n}`);
	return n === 1 ? src.replace(from, () => to) : null;
}
{
	// 11a: each item removed.
	const legs = [
		["fixed costs", "const fixed_cost_months = inFleet && truckMonthlyFixed(truck).total > 0 ? charged.length : 0;", "const fixed_cost_months = 0;",
			{ truck: { insurance_monthly: 1500 } }],
		["driver (3a)", "const driver = normalizeDriverName(truck.assigned_driver) ? 1 : 0;", "const driver = 0;",
			{ locked: ["2026-09"], truck: { status: "Inactive", assigned_driver: DRIVER }, directory: [{ name: DRIVER }] }],
		["driver (3b)", "const driver = normalizeDriverName(truck.assigned_driver) ? 1 : 0;", "const driver = 0;",
			{ truck: { assigned_driver: DRIVER }, others: [{ id: 4, unit_number: "MADE-UP-T4", assigned_driver: DRIVER, driver_pay_daily: 300 }] }],
		["driver (3c)", "const driver = normalizeDriverName(truck.assigned_driver) ? 1 : 0;", "const driver = 0;",
			{ locked: ["2026-09"], truck: { owner_id: INVESTOR_ID, assigned_driver: DRIVER }, history: [{ carrier: CARRIER, driver: DRIVER, started: "2026-08-01", ended: "2026-09-30" }] }],
		["driver (3d)", "const driver = normalizeDriverName(truck.assigned_driver) ? 1 : 0;", "const driver = 0;",
			{ truck: { assigned_driver: DRIVER }, directory: [{ name: DRIVER, payType: "percentage", pct: 30 }] }],
		["ELD link", "const eld_link = String(truck.routemate_vehicle_id || \"\").trim() ? 1 : 0;", "const eld_link = 0;",
			{ truck: { routemate_vehicle_id: "made-up-vid-1" } }],
		["reserve (6a)", "const financials_line_months = inFleet && financialsLine ? charged.length : 0;", "const financials_line_months = 0;",
			{ truck: { maintenance_fund_monthly: 200 } }],
		["price (6b)", "const financials_line_months = inFleet && financialsLine ? charged.length : 0;", "const financials_line_months = 0;",
			{ truck: { purchase_price: 85000 } }],
		["lease (7a)", "const lease_months = ownerId > 0 ? open.filter(leaseCovers).length : 0;", "const lease_months = 0;",
			{ truck: { owner_id: INVESTOR_ID }, basis: [{ month: "2026-10" }] }],
	];
	for (const [label, from, to, opts] of legs) {
		const holdsSrc = HOLDS ? mutate(HOLDS, from, to, `11a ${label}`) : (ok(`§11 11a ${label}: the function exists to mutate`, false), null);
		if (!holdsSrc) continue;
		const w = world(opts);
		const r = del(w, { holdsSrc });
		eq(`§11 11a without the ${label} item, the case goes through (200)`, [r.status, r.body.success], [200, true]);
		done(w);
	}
}
{
	// 11b: the hold answered only once nothing references the truck, as if it ran
	// after TRUCK_REFERENCED: 9d then answers TRUCK_REFERENCED.
	const routeSrc = mutate(DELETE_SRC, "if (held.length) {", "if (held.length && !assignmentRows && !trailerRows) {", "11b");
	if (routeSrc) {
		const w = world({ truck: { insurance_monthly: 1500 }, assignment: "ended" });
		eq("§11 11b the hold after TRUCK_REFERENCED: 9d answers TRUCK_REFERENCED", del(w, { routeSrc }).body.code, "TRUCK_REFERENCED");
		done(w);
	}
}
{
	// 11c: the hold sent through periodBlockedResponse(): the code becomes PERIOD_FINALIZED.
	const anchor = "recordPeriodRefusal({ req, ...truckDelAudit, tail: `nothing was written — holds: ";
	const routeSrc = mutate(DELETE_SRC, anchor,
		`return periodBlockedResponse(req, res, "Cannot delete", [{ periods: [], detail: "x" }], "x", truckDelAudit);\n\t\t${anchor}`, "11c");
	if (routeSrc) {
		const w = world({ truck: { insurance_monthly: 1500 } });
		const r = del(w, { routeSrc });
		eq("§11 11c through periodBlockedResponse(): case 1 answers and audits PERIOD_FINALIZED", [r.body.code, r.refusals.map((x) => x.code)], ["PERIOD_FINALIZED", ["PERIOD_FINALIZED"]]);
		done(w);
	}
}
{
	// 11d: the newest locked month counted as open: 6c reads 2 open months.
	const holdsSrc = HOLDS
		? mutate(HOLDS, "const locked = new Set(lockedPeriodsDesc());", "const locked = new Set(lockedPeriodsDesc().slice(1));", "11d")
		: (ok("§11 11d: the function exists to mutate", false), null);
	if (holdsSrc) {
		const w = world({ locked: ["2026-08", "2026-09"], truck: { maintenance_fund_monthly: 200, in_service_date: "2026-08-04" } });
		const r = del(w, { holdsSrc });
		eq("§11 11d a locked month counted as open: 6c counts 2", r.body.counts && r.body.counts.financials_line_months, 2);
		done(w);
	}
}
{
	// 11e: the UTC month instead of the business month: 8e is held.
	const holdsSrc = HOLDS
		? mutate(HOLDS, "const current = appDay().slice(0, 7);", "const current = new Date().toISOString().slice(0, 7);", "11e")
		: (ok("§11 11e: the function exists to mutate", false), null);
	if (holdsSrc) {
		const w = world({ now: Date.parse("2026-11-01T03:30:00Z"), truck: { insurance_monthly: 1500, in_service_date: "2026-11-01" } });
		eq("§11 11e the UTC month: 8e is refused", del(w, { holdsSrc }).body.code, "OPEN_MONTH_TRUCK_FIGURES");
		done(w);
	}
}
{
	// 11f: history tested as "history or a trailer": 9f loses its steps.
	const routeSrc = mutate(DELETE_SRC, "const steps = assignmentRows || holds.last_truck_receipt_months ? [] : [",
		"const steps = assignmentRows || trailerRows || holds.last_truck_receipt_months ? [] : [", "11f");
	if (routeSrc) {
		const w = world({ truck: { insurance_monthly: 1500 }, trailer: true });
		eq("§11 11f history or a trailer: 9f has no steps", del(w, { routeSrc }).body.error, figuresText([P.fixed(1)], []));
		done(w);
	}
}
{
	// 11g: the steps printed for a truck with history: 9d gains them.
	const routeSrc = mutate(DELETE_SRC, "const steps = assignmentRows || holds.last_truck_receipt_months ? [] : [", "const steps = false ? [] : [", "11g");
	if (routeSrc) {
		const w = world({ truck: { insurance_monthly: 1500 }, assignment: "ended" });
		eq("§11 11g steps with history: 9d prints them", del(w, { routeSrc }).body.error, figuresText([P.fixed(1)], [S.fixed]));
		done(w);
	}
}
{
	// The documents sentence kept for a truck with history: 10a flips.
	const routeSrc = mutate(DELETE_SRC, "(assignmentRows ? \"\" : ", "(false ? \"\" : ", "TD8-9");
	if (routeSrc) {
		const w = world({ legal: 2, assignment: "ended" });
		ok("§11 the sentence kept for a truck with history: 9a prints it", String(del(w, { routeSrc }).body.error || "").includes(FILED_IN_ERROR));
		done(w);
	}
}
{
	// The TRUCK_REFERENCED refusal row dropped: §10 flips.
	const anchor = "recordPeriodRefusal({ req, ...truckDelAudit, tail: `nothing was written — truck_assignments=";
	const routeSrc = mutate(DELETE_SRC, anchor, anchor.replace("recordPeriodRefusal(", "(() => {})("), "Low 2");
	if (routeSrc) {
		const w = world({ assignment: "ended", trailer: true });
		const r = del(w, { routeSrc });
		eq("§11 without the call, TRUCK_REFERENCED writes no row", [r.body.code, r.refusals.length], ["TRUCK_REFERENCED", 0]);
		done(w);
	}
}

// ---------------------------------------------------------------------------
// §12 Source pins, comments stripped.
// ---------------------------------------------------------------------------
{
	const ROUTE = codeOnly(DELETE_SRC);
	const all = (s) => { const out = []; let i = ROUTE.indexOf(s); while (i >= 0) { out.push(i); i = ROUTE.indexOf(s, i + 1); } return out; };
	const at = (s) => ROUTE.indexOf(s);
	const figures = all("\"OPEN_MONTH_TRUCK_FIGURES\"");
	ok("§12 the new code appears in the route", figures.length >= 1);
	ok("§12 every DELETE FROM comes after the new refusal",
		figures.length >= 1 && all("DELETE FROM").every((i) => i > Math.max(...figures)), JSON.stringify({ figures, deletes: all("DELETE FROM") }));
	ok("§12 the route answers PERIOD_FINALIZED, OPEN_MONTH_TRUCK_FEES, TRUCK_HAS_DOCUMENTS, OPEN_MONTH_TRUCK_FIGURES, then TRUCK_REFERENCED",
		at("periodBlockedResponse(") > 0 && at("periodBlockedResponse(") < at("\"OPEN_MONTH_TRUCK_FEES\"") &&
		at("\"OPEN_MONTH_TRUCK_FEES\"") < at("\"TRUCK_HAS_DOCUMENTS\"") && at("\"TRUCK_HAS_DOCUMENTS\"") < at("\"OPEN_MONTH_TRUCK_FIGURES\"") &&
		at("\"OPEN_MONTH_TRUCK_FIGURES\"") < at("\"TRUCK_REFERENCED\""));
	// TD8-7: "TRUCK_REFERENCED" only in its own refusal, which reads the counts
	// taken above the documents check.
	const refsBlock = at("if (refs.length) {");
	ok("§12 \"TRUCK_REFERENCED\" appears only inside its own refusal",
		refsBlock > 0 && all("\"TRUCK_REFERENCED\"").length === 2 && all("\"TRUCK_REFERENCED\"").every((i) => i > refsBlock), JSON.stringify(all("\"TRUCK_REFERENCED\"")));
	ok("§12 the reference counts are read once, above the documents check",
		all("FROM truck_assignments WHERE truck_id = ?").length === 1 && all("FROM trailers WHERE truck_id = ?").length === 1 &&
		at("FROM truck_assignments WHERE truck_id = ?") < at("if (lock.legalDocuments) {") && at("FROM trailers WHERE truck_id = ?") < at("if (lock.legalDocuments) {"));
	ok("§12 the new refusal never goes through periodBlockedResponse()", !/periodBlockedResponse\([^;]*OPEN_MONTH_TRUCK_FIGURES/.test(ROUTE));
	ok("§12 the route never reads the sheet or awaits", !/getJobTrackingCached|await\s/.test(ROUTE));
	// The holds read no flag and no Financials setting (TD8-3, TD8-4).
	const H = codeOnly(HOLDS);
	ok("§12 the holds read neither the lease flag nor a Financials toggle",
		H.length > 0 && !/INVESTOR_LEASE_PAYOUTS_ENABLED|leaseBasisActive|depreciationYears|which\.reserve|financialsSettings/.test(H));
	ok("§12 the holds charge months through truckChargedInMonth() and the fleet rule through truckInFleet()",
		/truckChargedInMonth\(truck, mk\)/.test(H) && /investorPayoutBasis\.truckInFleet\(truck\)/.test(H));
	ok("§12 the holds count the lease through leaseCoverage() under the retirement setting",
		/investorPayoutBasis\.leaseCoverage\(/.test(H) && /INVESTOR_LEASE_SETTINGS\.retirement/.test(H));
}
// TD8-13: PUT /api/trucks/:id writes update_truck_driver only when the trimmed
// driver changes, naming the driver before and after.
{
	const PUT = codeOnly(PUT_SRC);
	const calls = PUT.split("logAudit(req, \"update_truck_driver\"").length - 1;
	ok("§12 TD8-13: the truck edit writes update_truck_driver once", calls === 1, `found ${calls}`);
	const at = PUT.indexOf("logAudit(req, \"update_truck_driver\"");
	const gate = PUT.lastIndexOf("if (", at);
	ok("§12 TD8-13: ...keyed on a real change of the driver (changed.assigned_driver)",
		at > 0 && PUT.slice(gate, PUT.indexOf("\n", gate)).includes("if (Object.prototype.hasOwnProperty.call(changed, \"assigned_driver\")) {"),
		PUT.slice(gate, PUT.indexOf("\n", gate)));
	ok("§12 TD8-13: ...which changesTo() sets only when the trimmed driver differs",
		PUT.includes("if (driver !== undefined && driver !== String(row.assigned_driver || \"\").trim()) {\n\t\t\t\tchanged.assigned_driver = driver;"));
	const line = at > 0 ? PUT.slice(at, PUT.indexOf(");", at)) : "";
	ok("§12 TD8-13: ...naming the driver before and after",
		/fmtDriver\(truck\.assigned_driver\)/.test(line) && /fmtDriver\(changed\.assigned_driver\)/.test(line) && /→/.test(line), line);
	ok("§12 TD8-13: ...after the UPDATE", at > PUT.indexOf("db.prepare(`UPDATE trucks SET ${updates.join(\", \")} WHERE id = ?`)"));
}

// ---------------------------------------------------------------------------
// §14 The investor's last truck (review M1). DRIVER is in the investor's
// carrier history from August and on no truck; his receipts name no truck and
// carry no owner stamp, so they count on the investor only through the driver
// windows, which getInvestorDriverMonthWindows() builds only while the investor
// owns a truck. Deleting the last one would take them out of an open month.
// ---------------------------------------------------------------------------
const LAST = { truck: { owner_id: INVESTOR_ID }, history: [{ carrier: CARRIER, driver: DRIVER, started: "2026-08-01" }] };
{
	const w = world({ ...LAST, receipts: [{ date: "2026-10-06" }] });
	const before = snapshot(w);
	const r = del(w);
	expectFigures("§14a the investor's only truck, an October receipt naming no truck", w, r, before,
		{ counts: counts({ last_truck_receipt_months: 1 }), parts: [P.receipts(1)], steps: [], held: "investor receipts" });
	done(w);
}
{
	const w = world({ ...LAST, receipts: [{ date: "2026-10-06" }], others: [{ id: 4, unit_number: "MADE-UP-T4", owner_id: INVESTOR_ID }] });
	const r = del(w);
	eq("§14b a second truck owned by the same investor: the delete goes through", [r.status, r.body.success], [200, true]);
	done(w);
}
{
	const w = world({ ...LAST, locked: ["2026-09"], receipts: [{ date: "2026-09-10" }] });
	const r = del(w);
	eq("§14c the receipt only in a locked month: the delete goes through", [r.status, r.body.success], [200, true]);
	done(w);
}
{
	const w = world({ ...LAST, receipts: [{ date: "2026-10-06", truck: "MADE-UP-T9" }] });
	const r = del(w);
	eq("§14d the receipt names a truck: the delete goes through", [r.status, r.body.success], [200, true]);
	done(w);
}
{
	const w = world({ ...LAST, receipts: [{ date: "2026-10-06", status: "Rejected" }] });
	const r = del(w);
	eq("§14e a Rejected receipt: the delete goes through", [r.status, r.body.success], [200, true]);
	done(w);
}
{
	const w = world({ ...LAST, receipts: [{ date: "2026-11-02" }] });
	const r = del(w);
	eq("§14f a receipt dated next month only: the delete goes through", [r.status, r.body.success], [200, true]);
	done(w);
}
{
	// The settlement month decides (EXPENSE_PERIOD_EXPR): dated in a closed
	// September, posted to October.
	const w = world({ ...LAST, locked: ["2026-09"], receipts: [{ date: "2026-09-28", posted: "2026-10" }] });
	const r = del(w);
	eq("§14g dated in a locked month, posted to October: refused, 1 open month",
		[r.status, r.body.code, r.body.counts], [409, "OPEN_MONTH_TRUCK_FIGURES", counts({ last_truck_receipt_months: 1 })]);
	done(w);
}
{
	const w = world({ ...LAST, receipts: [{ date: "2026-09-10" }, { date: "2026-10-06" }, { date: "2026-10-07" }] });
	const r = del(w);
	eq("§14h receipts in September and October, no lock: 2 open months", r.body.counts, counts({ last_truck_receipt_months: 2 }));
	ok("§14h ...the text says \"in 2 open months\"", String(r.body.error || "").includes(`${P.receipts(2)}.`), r.body.error);
	done(w);
}
{
	// With another item and a trailer, no history: the retirement date only, since
	// no clear step removes this item.
	const w = world({ ...LAST, truck: { ...LAST.truck, insurance_monthly: 1500 }, trailer: true, receipts: [{ date: "2026-10-06" }] });
	const before = snapshot(w);
	const r = del(w);
	expectFigures("§14i fixed costs, a trailer and the receipts item", w, r, before, {
		counts: counts({ fixed_cost_months: 1, last_truck_receipt_months: 1 }),
		parts: [P.fixed(1), P.receipts(1)], steps: [], held: "fixed costs, investor receipts",
	});
	done(w);
}
// Mutants: each flips the case it is aimed at.
{
	const LAST_TRUCK_CHECK = "!db.prepare(\"SELECT 1 FROM trucks WHERE owner_id = ? AND id != ? LIMIT 1\").get(ownerId, truck.id)";
	const holdsMutants = [
		["the count removed", "if (ownerId > 0 && " + LAST_TRUCK_CHECK, "if (false && " + LAST_TRUCK_CHECK,
			{ ...LAST, receipts: [{ date: "2026-10-06" }] }, [200, undefined]],
		["counted on any truck, not the last", LAST_TRUCK_CHECK, "true",
			{ ...LAST, receipts: [{ date: "2026-10-06" }], others: [{ id: 4, unit_number: "MADE-UP-T4", owner_id: INVESTOR_ID }] }, [409, "OPEN_MONTH_TRUCK_FIGURES"]],
		["locked months counted", " && !locked.has(r.m)).length", ").length",
			{ ...LAST, locked: ["2026-09"], receipts: [{ date: "2026-09-10" }] }, [409, "OPEN_MONTH_TRUCK_FIGURES"]],
		["Rejected counted", " AND ${EXPENSE_PNL_FILTER}`", "`",
			{ ...LAST, receipts: [{ date: "2026-10-06", status: "Rejected" }] }, [409, "OPEN_MONTH_TRUCK_FIGURES"]],
	];
	for (const [label, from, to, opts, expected] of holdsMutants) {
		const holdsSrc = HOLDS ? mutate(HOLDS, from, to, `14 ${label}`) : (ok(`§14 ${label}: the function exists to mutate`, false), null);
		if (!holdsSrc) continue;
		const w = world(opts);
		const r = del(w, { holdsSrc });
		eq(`§14 mutant, ${label}: the case flips`, [r.status, r.body.code], expected);
		done(w);
	}
	// The clear steps printed with the receipts item: 14i gains them.
	const routeSrc = mutate(DELETE_SRC, "const steps = assignmentRows || holds.last_truck_receipt_months ? [] : [", "const steps = assignmentRows ? [] : [", "14 steps");
	if (routeSrc) {
		const w = world({ ...LAST, truck: { ...LAST.truck, insurance_monthly: 1500 }, trailer: true, receipts: [{ date: "2026-10-06" }] });
		eq("§14 mutant, steps printed with the receipts item: 14i gains them",
			del(w, { routeSrc }).body.error, figuresText([P.fixed(1), P.receipts(1)], [S.fixed, S.trailer]));
		done(w);
	}
}

// ---------------------------------------------------------------------------
// §13 No amount, file name or driver name in any refusal's audit subject or
// tail, and no driver or investor name in any body.
// ---------------------------------------------------------------------------
{
	const figuresRows = ALL_REFUSALS.filter((x) => x.code === "OPEN_MONTH_TRUCK_FIGURES" || x.code === "TRUCK_REFERENCED");
	ok("§13 refusal rows under the new code and TRUCK_REFERENCED were recorded", figuresRows.length >= 10, `${figuresRows.length}`);
	const LEAK = /\$|\d\.\d{2}\b|\.(pdf|jpe?g|png)\b|\/uploads\/|t5-reg|made up driver|made up holdings|made-up-vid/i;
	const leaks = ALL_REFUSALS.filter((x) => LEAK.test(String(x.subject || "")) || LEAK.test(String(x.tail || "")) || LEAK.test(String(x.note || "")));
	eq("§13 no subject, tail or note holds an amount, a file name, a driver, an investor or a device id", leaks.map((x) => [x.code, x.subject, x.tail]), []);
	const named = ALL_BODIES.filter((b) => b.code === "OPEN_MONTH_TRUCK_FIGURES" && /made up driver|made up holdings|made-up-vid/i.test(JSON.stringify(b)));
	eq("§13 no OPEN_MONTH_TRUCK_FIGURES body names the driver, the investor or the device", named.length, 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
