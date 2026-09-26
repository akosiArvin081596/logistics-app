#!/usr/bin/env node
/**
 * A driver's own pay rate can be cleared to 0 (2026-09-26).
 *
 * THE BUG. PUT /api/drivers-directory/:id reads its body with
 * `values[i] || ""`, so a NUMBER 0 arrives as "", which means "not sent", and
 * the stored value is kept. The Drivers Database Edit dialog sent the active
 * pay type's amount as `Number(...) || 0` and the other type's as a numeric 0.
 * So a Super Admin who set a driver's daily rate to 0, or blanked it (the form
 * says "Leave blank/0 to use the assigned truck's rate"), saved nothing: the
 * driver kept their own rate instead of the truck's.
 *
 * THE CONTRACT. The forms now send the active type's amount as TEXT, "0"
 * allowed, and the other type's as "" (client/src/lib/driverPay.js). The server
 * mapping is unchanged, so a page loaded before the fix, whose numeric 0s mean
 * "not sent", never wipes stored terms. A sent "0" clears the rate, and
 * resolveDailyRate() falls back to the truck's rate, else $250. Every change
 * still goes through the Super Admin check and the month-end lock, which judge
 * only real changes.
 *
 * WHAT RUNS. Both directory routes, lifted whole out of server.js, over an
 * in-memory SQLite, with server.js's own pay helpers, name check, audit writers
 * and the REAL month-end lock: directoryEditLockBlockers() with the locked-month
 * and truck-rate helpers it calls. Only the 409 formatter, the carrier history
 * sync and the socket notification are stubbed. The Edit dialog's and the Add
 * form's pay cells come from directoryPayCells(), imported from the client, so
 * both halves of the contract run together.
 *   §1 "0", or a blank field, clears the driver's rate; the pay paths then read
 *      the truck's rate, or $250 with no truck
 *   §2 a numeric 0 (a page from before the fix) is not sent: nothing changes
 *   §3 the pay type not in use is never touched, on a save or a type switch
 *   §4 the month-end lock: a clear that would reprice a closed month is refused
 *      (409, nothing written, audited); one that reprices nothing goes through
 *   §5 POST: the Add Driver form's cells create the terms they show
 *   §6 MUTANT: the PUT's mapping honouring a numeric 0. It must fail §2 and §3.
 *
 * Pure: no server, no app.db, no network.
 *   node scripts/test-driver-pay-clear.js     # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function record(results) {
	for (const r of results) {
		if (r.ok) pass++;
		else { failures.push(r.name); console.log(`  FAIL  ${r.name}`); }
	}
	console.log(`  ${results.filter((r) => r.ok).length}/${results.length} checks`);
}

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run it under the .nvmrc Node`);
}

// ── lift the shipped code ───────────────────────────────────────────────────
function liftFunction(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${name}()`);
	return SRC.slice(a, end + 2);
}
function liftRoute(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return SRC.slice(a, end + "\n});".length);
}
function liftConst(head, close = null) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 statement starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	if (end < 0) die(`no end found after ${head}`);
	return SRC.slice(a, end + (close ? close.length : 1));
}
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) die(`mutant target found ${n}x (expected 1): ${from.slice(0, 70)}`);
	return src.replace(from, () => to);
}

const HEADS = {
	dirGet: 'app.get("/api/drivers-directory", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	dirPost: 'app.post("/api/drivers-directory", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	dirPut: 'app.put("/api/drivers-directory/:id", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
};
const ROUTES = Object.fromEntries(Object.entries(HEADS).map(([k, h]) => [k, liftRoute(h)]));
// The eighteen columns the forms send, off the GET route, whose last three are
// the pay cells directoryPayCells() builds.
const DIR_HEADERS = (() => {
	const m = ROUTES.dirGet.match(/const headers = (\[[^\]]*\]);/);
	if (!m) die("could not read the header list of GET /api/drivers-directory");
	return JSON.parse(m[1]);
})();
if (JSON.stringify(DIR_HEADERS.slice(-3)) !== JSON.stringify(["PayType", "PayPercentage", "PayDaily"])) {
	die("the directory headers no longer end with PayType, PayPercentage, PayDaily, the order the forms send the pay cells in");
}

const MODULE_SRC = [
	// audit writers
	liftConst("const REFUSAL_AUDIT_WINDOW_MS = "),
	liftConst("const refusalAuditWindows = "),
	liftConst("const UNCOALESCED_REFUSAL_CODES = new Set([", "\n]);"),
	liftFunction("logAudit"),
	liftFunction("logAuditRefusal"),
	liftFunction("scrubPurgeMarker"),
	liftFunction("auditText"),
	// the pay rule and the fields
	liftConst("const PAY_EDIT_ADMIN_ONLY = "),
	liftFunction("directoryPayStruct"),
	liftFunction("directoryPayChanges"),
	liftFunction("refusePayEdit"),
	liftFunction("parsePlainDecimal"),
	liftConst("const DRIVER_PAY_DAILY_MAX = "),
	liftFunction("directoryPayValue"),
	liftConst("const DIRECTORY_PERIOD_COLUMNS = "),
	liftFunction("directoryChangedColumns"),
	// names
	liftFunction("normalizeDriverName"),
	liftFunction("findDriverNameClashes"),
	liftFunction("findDriverNameClash"),
	// the month-end lock, for real
	liftConst("const DIRECTORY_DEFAULT_STRUCT = "),
	liftConst("const DIRECTORY_LOCK_REMEDY =", "\";\n"),
	liftFunction("lockedPeriodsDesc"),
	liftFunction("driverPayLockedMonths"),
	liftFunction("truckDailyRateCandidates"),
	liftFunction("resolveDailyRate"),
	liftFunction("directoryEditLockBlockers"),
	// what the pay paths read
	liftConst("let lastPayStructShadowWarnMs = "),
	liftFunction("getDriverPayStructures"),
].join("\n");
const MODULE_EXPORTS = [
	"logAudit", "logAuditRefusal", "auditText", "PAY_EDIT_ADMIN_ONLY", "directoryPayStruct", "directoryPayChanges",
	"refusePayEdit", "directoryPayValue", "DRIVER_PAY_DAILY_MAX", "directoryChangedColumns", "normalizeDriverName",
	"findDriverNameClashes", "findDriverNameClash", "DIRECTORY_LOCK_REMEDY", "directoryEditLockBlockers",
	"resolveDailyRate", "getDriverPayStructures",
];
function buildModule(db) {
	return new Function("db", "todayKeyCT", "periodLocksReadable", "investorsHoldingDriver",
		`"use strict";\n${MODULE_SRC}\nreturn { ${MODULE_EXPORTS.join(", ")} };`)(
		db, () => "2026-09-26",
		// The lock table's positive control is its own runner's subject; the
		// carrier check is not reached, because no save below moves the carrier.
		() => true,
		() => { throw new Error("investorsHoldingDriver reached: a save below moved the name or the carrier"); });
}

// ── fixtures ────────────────────────────────────────────────────────────────
function auditDdl() {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS audit_trail \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE audit_trail");
	return `CREATE TABLE audit_trail (${m[1]}\n)`;
}
const DDL = [
	auditDdl(),
	`CREATE TABLE drivers_directory (
		id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
		carrier_name TEXT DEFAULT '', state TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', address TEXT DEFAULT '',
		phone TEXT DEFAULT '', cell TEXT DEFAULT '', email TEXT DEFAULT '', dot TEXT DEFAULT '', mc TEXT DEFAULT '',
		trucks TEXT DEFAULT '', hazmat TEXT DEFAULT '', rating TEXT DEFAULT '', status TEXT DEFAULT 'active',
		pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0)`,
	"CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, assigned_driver TEXT DEFAULT '', driver_pay_daily REAL DEFAULT 0)",
	"CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '')",
	"CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked')",
];
const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const DISPATCHER = { id: 2, username: "kevin", role: "Dispatcher" };

function makeDb({ lockedMonths = [] } = {}) {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	const dir = db.prepare(`INSERT INTO drivers_directory (id, driver_name, city, state, phone, status, pay_type, pay_percentage, pay_daily)
		VALUES (?, ?, 'Houston', 'TX', ?, 'active', ?, ?, ?)`);
	// A day rate of his own, and a share stored from when he drove as an
	// owner-operator (the type not in use).
	dir.run(1, "Shorn King", "555-0100", "fixed", 20, 300);
	// An owner-operator share, and a day rate stored for the type not in use.
	dir.run(2, "Rodney Brown", "555-0200", "percentage", 20, 275);
	// A day rate of her own and no truck: the $250 fallback is under it.
	dir.run(3, "Nora Solo", "555-0300", "fixed", 0, 300);
	// A day rate equal to his truck's: clearing it prices him the same.
	dir.run(4, "Even Steven", "555-0400", "fixed", 0, 250);
	const truck = db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver, driver_pay_daily) VALUES (?, ?, ?, ?)");
	truck.run(1, "33", "Shorn King", 275);
	truck.run(2, "302", "Rodney Brown", 260);
	truck.run(3, "91", "Even Steven", 250);
	const asg = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (?, ?, '2026-05-01T12:00:00.000Z')");
	asg.run(1, "Shorn King");
	asg.run(2, "Rodney Brown");
	asg.run(3, "Even Steven");
	for (const p of lockedMonths) db.prepare("INSERT INTO period_locks (period, status) VALUES (?, 'locked')").run(p);
	return db;
}
const row = (db, id) => db.prepare("SELECT * FROM drivers_directory WHERE id = ?").get(id);
const terms = (r) => [r.pay_type, r.pay_percentage, r.pay_daily];
const audits = (db, action) => db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(action);
const snapshot = (db) => JSON.stringify(db.prepare("SELECT * FROM drivers_directory ORDER BY id").all());
// The daily rate the pay paths would price a fixed-pay driver at: their own
// terms (getDriverPayStructures()) through resolveDailyRate(), with the rate of
// the truck naming them, as the P&L's trucksByDriver reads it.
function effectiveDailyRate(db, m, name) {
	const s = m.getDriverPayStructures()[m.normalizeDriverName(name)] || {};
	const t = db.prepare("SELECT driver_pay_daily FROM trucks WHERE LOWER(assigned_driver) = LOWER(?)").get(name);
	return m.resolveDailyRate(s.payDaily, t ? (t.driver_pay_daily || 250) : undefined);
}

// What the Edit dialog holds when it opens on a row (DriverTable.vue openEdit()).
const dialogOpen = (r) => ({ payType: r.pay_type || "fixed", payPercentage: Number(r.pay_percentage) || 0, payDaily: Number(r.pay_daily) || 0 });
// The pay cells a page built before the fix sent, verbatim: the oracle for §2.
const oldPageCells = (f) => [
	f.payType,
	f.payType === "percentage" ? (Number(f.payPercentage) || 0) : 0,
	f.payType === "fixed" ? (Number(f.payDaily) || 0) : 0,
];
// The whole body the dialog's Save sends: every column from the row, the pay
// cells last. `over` replaces non-pay columns by header name.
function formBody(r, payCells, over = {}) {
	const v = {
		Driver: r.driver_name, "Carrier Name": "", State: r.state, City: r.city, ZIP: r.zip, Address: r.address,
		Trucks: r.trucks, Hazmat: r.hazmat || "NO", PhoneNumber: r.phone, CellNumber: r.cell, Email: r.email,
		DOT: r.dot, MC: r.mc, Rating: r.rating || "Not Rated", Status: r.status || "active", ...over,
	};
	return { headers: DIR_HEADERS, values: [...DIR_HEADERS.slice(0, -3).map((h) => v[h]), ...payCells] };
}

function mountRoute(routeSrc, env) {
	let handler = null;
	const grab = (p, ...rest) => { handler = rest[rest.length - 1]; };
	const all = { app: { get: grab, post: grab, put: grab }, requireRole: () => (req, res, next) => next(), ...env };
	const names = Object.keys(all);
	new Function(...names, routeSrc)(...names.map((k) => all[k]));
	if (typeof handler !== "function") die("a lifted route did not register a handler");
	return (req) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
		handler({ params: {}, query: {}, body: {}, ...req }, res);
		return out;
	};
}
function mountAll(db, routes = {}) {
	const m = buildModule(db);
	const r = { ...ROUTES, ...routes };
	const lockRefusals = [];
	const env = {
		db, ...m,
		// The 409's wording is its own runner's subject; the refusal and the audit
		// line it is handed are recorded here.
		periodBlockedResponse: (req, res, what, blockers, remedy, audit) => {
			lockRefusals.push({ what, blockers, audit });
			return res.status(409).json({ code: "PERIOD_FINALIZED", periods: [...new Set(blockers.flatMap((b) => b.periods))].sort(), blockers });
		},
		periodLockUnreadableResponse: (req, res) => res.status(409).json({ code: "PERIOD_LOCK_UNREADABLE" }),
		syncCarrierDriverHistory: () => {},
		notifyChange: () => {},
		console: { error() {}, log() {}, warn() {} },
	};
	const post = mountRoute(r.dirPost, env);
	const put = mountRoute(r.dirPut, env);
	return {
		m, lockRefusals,
		dirPost: (user, body) => post({ session: { user }, body }),
		dirPut: (user, id, body) => put({ session: { user }, params: { id: String(id) }, body }),
	};
}

// ── the sections ────────────────────────────────────────────────────────────
function sections(directoryPayCells, routes = {}) {
	const out = { s1: [], s2: [], s3: [], s4: [], s5: [] };
	const t = (s, name, cond) => out[s].push({ name, ok: !!cond });
	// The Edit dialog's Save after `edit` changes the form, as a Super Admin.
	const dialogCells = (r, edit = {}) => directoryPayCells({ canEditPay: true, ...dialogOpen(r), ...edit });

	// §1 "0" clears.
	for (const [label, id, edit, want] of [
		["Shorn King's $300 set to 0 (his truck's $275 applies)", 1, { payDaily: 0 }, 275],
		["Shorn King's $300 blanked (the form: blank means the truck's rate)", 1, { payDaily: "" }, 275],
		["Nora Solo's $300 set to 0 (no truck: the $250 fallback applies)", 3, { payDaily: 0 }, 250],
	]) {
		const db = makeDb();
		const app = mountAll(db, routes);
		const before = row(db, id);
		t("s1", `§1 ${label}: the dialog sends ["fixed", "", "0"]`, JSON.stringify(dialogCells(before, edit)) === JSON.stringify(["fixed", "", "0"]));
		const rateBefore = effectiveDailyRate(db, app.m, before.driver_name);
		const r = app.dirPut(SUPER, id, formBody(before, dialogCells(before, edit)));
		const after = row(db, id);
		t("s1", `§1 ${label}: saved (got ${r.status} ${(r.body || {}).code || ""})`, r.status === 200);
		t("s1", `§1 ${label}: pay_daily is 0, the type and the stored share as they were (${JSON.stringify(terms(after))})`,
			after.pay_daily === 0 && after.pay_type === before.pay_type && after.pay_percentage === before.pay_percentage);
		t("s1", `§1 ${label}: the pay paths price the driver at $${want}/day, not the $${rateBefore} of their own rate`,
			rateBefore === 300 && effectiveDailyRate(db, app.m, before.driver_name) === want);
		const lines = audits(db, "update_driver_pay");
		t("s1", `§1 ${label}: one update_driver_pay line, naming pay_daily only`,
			lines.length === 1 && /pay_daily 300 → 0/.test(lines[0].details) && !/pay_percentage|pay_type/.test(lines[0].details));
	}
	{
		// A share of "0" is honoured too: 0 %, the day rate stored for the type
		// not in use kept.
		const db = makeDb();
		const app = mountAll(db, routes);
		const before = row(db, 2);
		const cells = dialogCells(before, { payPercentage: 0 });
		const r = app.dirPut(SUPER, 2, formBody(before, cells));
		t("s1", `§1 Rodney Brown's 20 % share set to 0: ["percentage", "0", ""] saved as 0 %, his stored $275 day rate kept (got ${r.status}, ${JSON.stringify(terms(row(db, 2)))})`,
			JSON.stringify(cells) === JSON.stringify(["percentage", "0", ""]) && r.status === 200 &&
			JSON.stringify(terms(row(db, 2))) === JSON.stringify(["percentage", 0, 275]));
	}
	{
		// Clearing is a pay change like any other: anyone but a Super Admin is
		// refused (the form does not even send pay for them).
		const db = makeDb();
		const app = mountAll(db, routes);
		const before = row(db, 1);
		const r = app.dirPut(DISPATCHER, 1, formBody(before, ["fixed", "", "0"]));
		t("s1", `§1 a Dispatcher's "0": 403 PAY_EDIT_ADMIN_ONLY, $300 kept (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 403 && r.body.code === "PAY_EDIT_ADMIN_ONLY" && row(db, 1).pay_daily === 300);
		t("s1", "§1 ...and the Dispatcher's dialog sends no pay at all",
			JSON.stringify(directoryPayCells({ canEditPay: false, ...dialogOpen(before), payDaily: 0 })) === JSON.stringify(["", "", ""]));
	}

	// §2 a numeric 0 is not sent.
	{
		const db = makeDb();
		const app = mountAll(db, routes);
		const before = row(db, 1);
		const cells = oldPageCells({ ...dialogOpen(before), payDaily: 0 });
		const r = app.dirPut(SUPER, 1, formBody(before, cells, { PhoneNumber: "555-0199" }));
		t("s2", `§2 a page from before the fix: "set to 0" arrives as ${JSON.stringify(cells)}, saved, the $300 kept, the phone edit written (got ${r.status}, ${JSON.stringify(terms(row(db, 1)))})`,
			JSON.stringify(cells) === JSON.stringify(["fixed", 0, 0]) && r.status === 200 &&
			JSON.stringify(terms(row(db, 1))) === JSON.stringify(terms(before)) && row(db, 1).phone === "555-0199");
		t("s2", "§2 ...no update_driver_pay line", audits(db, "update_driver_pay").length === 0);
	}
	for (const [label, value] of [["the number 0", 0], ["null", null], ["false", false]]) {
		const db = makeDb();
		const app = mountAll(db, routes);
		const r = app.dirPut(SUPER, 1, { headers: ["Driver", "PayDaily", "PayPercentage"], values: ["Shorn King", value, value] });
		t("s2", `§2 ${label} sent for both amounts directly: saved, the stored terms kept (got ${r.status}, ${JSON.stringify(terms(row(db, 1)))})`,
			r.status === 200 && JSON.stringify(terms(row(db, 1))) === JSON.stringify(["fixed", 20, 300]) && audits(db, "update_driver_pay").length === 0);
	}

	// §3 the pay type not in use is never touched.
	for (const [label, id, cellsOf] of [
		["the dialog saving a fixed driver (the share stored for the other type)", 1, (r) => dialogCells(r)],
		["the dialog saving an owner-operator (the day rate stored for the other type)", 2, (r) => dialogCells(r)],
		["a page from before the fix saving a fixed driver (the share sent as the number 0)", 1, (r) => oldPageCells(dialogOpen(r))],
		["a page from before the fix saving an owner-operator (the day rate sent as the number 0)", 2, (r) => oldPageCells(dialogOpen(r))],
	]) {
		const db = makeDb();
		const app = mountAll(db, routes);
		const before = row(db, id);
		const cells = cellsOf(before);
		const r = app.dirPut(SUPER, id, formBody(before, cells, { City: "Katy" }));
		t("s3", `§3 ${label}: ${JSON.stringify(cells)}, saved with the city edit, every stored term kept (got ${r.status}, ${JSON.stringify(terms(row(db, id)))})`,
			r.status === 200 && row(db, id).city === "Katy" && JSON.stringify(terms(row(db, id))) === JSON.stringify(terms(before)));
		t("s3", `§3 ${label}: no update_driver_pay line`, audits(db, "update_driver_pay").length === 0);
	}
	{
		// Switching the type sends the new type's amount and leaves the other's
		// stored value alone, so switching back finds it.
		const db = makeDb();
		const app = mountAll(db, routes);
		const before = row(db, 1);
		const cells = dialogCells(before, { payType: "percentage", payPercentage: 25 });
		const r = app.dirPut(SUPER, 1, formBody(before, cells));
		t("s3", `§3 Shorn King switched to a 25 % share: ["percentage", "25", ""], his $300 day rate kept (got ${r.status}, ${JSON.stringify(terms(row(db, 1)))})`,
			JSON.stringify(cells) === JSON.stringify(["percentage", "25", ""]) && r.status === 200 &&
			JSON.stringify(terms(row(db, 1))) === JSON.stringify(["percentage", 25, 300]));
	}

	// §4 the month-end lock judges the clear, and only a real change.
	{
		const db = makeDb({ lockedMonths: ["2026-08"] });
		const app = mountAll(db, routes);
		const before = row(db, 1);
		const snap = snapshot(db);
		const r = app.dirPut(SUPER, 1, formBody(before, dialogCells(before, { payDaily: 0 })));
		const refusal = app.lockRefusals[0] || {};
		t("s4", `§4 August locked, Shorn King's $300 cleared (his truck's $275 would reprice August): 409 PERIOD_FINALIZED on pay_daily (got ${r.status} ${(r.body || {}).code || ""} ${JSON.stringify((r.body || {}).periods || null)})`,
			r.status === 409 && r.body.code === "PERIOD_FINALIZED" && JSON.stringify(r.body.periods) === JSON.stringify(["2026-08"]) &&
			(refusal.blockers || []).map((b) => b.field).join() === "pay_daily");
		t("s4", "§4 ...nothing written, no update_driver_pay line", snapshot(db) === snap && audits(db, "update_driver_pay").length === 0);
		t("s4", "§4 ...the refusal is recorded as update_driver_pay_blocked, naming pay_daily 300 -> 0",
			(refusal.audit || {}).action === "update_driver_pay_blocked" && /pay_daily 300 -> 0/.test((refusal.audit || {}).subject || ""));
	}
	for (const [label, id, cellsOf] of [
		["the dialog saving Shorn King's terms as they are", 1, (r) => dialogCells(r)],
		["a page from before the fix \"setting 0\" (a numeric 0: not sent)", 1, (r) => oldPageCells({ ...dialogOpen(r), payDaily: 0 })],
		["the dialog saving Rodney Brown (the day rate not in use, not sent)", 2, (r) => dialogCells(r)],
	]) {
		const db = makeDb({ lockedMonths: ["2026-08"] });
		const app = mountAll(db, routes);
		const before = row(db, id);
		const r = app.dirPut(SUPER, id, formBody(before, cellsOf(before), { PhoneNumber: "555-0777" }));
		t("s4", `§4 August locked, ${label}: no change to judge, saved (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && app.lockRefusals.length === 0 && row(db, id).phone === "555-0777" &&
			JSON.stringify(terms(row(db, id))) === JSON.stringify(terms(before)));
	}
	{
		const db = makeDb({ lockedMonths: ["2026-08"] });
		const app = mountAll(db, routes);
		const before = row(db, 4);
		const r = app.dirPut(SUPER, 4, formBody(before, dialogCells(before, { payDaily: 0 })));
		t("s4", `§4 August locked, Even Steven's $250 cleared onto his truck's $250 (reprices nothing): saved (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && row(db, 4).pay_daily === 0 && effectiveDailyRate(db, app.m, "Even Steven") === 250);
	}

	// §5 POST: the Add Driver form's cells.
	for (const [label, user, canEditPay, form, want] of [
		["a Super Admin, $300 a day", SUPER, true, { payType: "fixed", payPercentage: 0, payDaily: 300 }, ["fixed", 0, 300]],
		["a Super Admin, the day rate left blank", SUPER, true, { payType: "fixed", payPercentage: 0, payDaily: "" }, ["fixed", 0, 0]],
		["a Super Admin, a 20 % share (the day rate field not in use)", SUPER, true, { payType: "percentage", payPercentage: 20, payDaily: 0 }, ["percentage", 20, 0]],
		["a Dispatcher (no pay sent: the default terms)", DISPATCHER, false, { payType: "fixed", payPercentage: 0, payDaily: 0 }, ["fixed", 0, 0]],
	]) {
		const db = makeDb();
		const app = mountAll(db, routes);
		const cells = directoryPayCells({ canEditPay, ...form });
		const v = { Driver: "NEW DRIVER", State: "TX", City: "WACO", PhoneNumber: "555-0400", Hazmat: "NO", Rating: "Not Rated" };
		const body = { headers: DIR_HEADERS, values: [...DIR_HEADERS.slice(0, -3).map((h) => (v[h] === undefined ? "" : v[h])), ...cells] };
		const r = app.dirPost(user, body);
		const made = db.prepare("SELECT * FROM drivers_directory WHERE driver_name = 'NEW DRIVER'").get();
		t("s5", `§5 Add Driver, ${label}: ${JSON.stringify(cells)} creates ${JSON.stringify(want)} (got ${r.status} ${(r.body || {}).code || ""}, ${made ? JSON.stringify(terms(made)) : "no row"})`,
			r.status === 200 && made && JSON.stringify(terms(made)) === JSON.stringify(want));
	}
	return out;
}

(async () => {
	const { directoryPayCells } = await import(pathToFileURL(path.join(__dirname, "..", "client", "src", "lib", "driverPay.js")).href);
	const res = sections(directoryPayCells);
	for (const [key, title] of [["s1", "§1 \"0\" clears"], ["s2", "§2 a numeric 0 is not sent"], ["s3", "§3 the type not in use is untouched"],
		["s4", "§4 the month-end lock"], ["s5", "§5 POST"]]) {
		console.log(title);
		record(res[key]);
	}

	// §6 MUTANT: the PUT's mapping honouring a numeric 0, the "fix" on the
	// wrong side. Built outside the probe, so a vanished target fails the run.
	console.log("§6 mutant");
	const HONOUR_ZERO = mutate(ROUTES.dirPut, 'headers.forEach((h, i) => { obj[h] = values[i] || ""; });',
		'headers.forEach((h, i) => { obj[h] = values[i] ?? ""; });');
	const m = sections(directoryPayCells, { dirPut: HONOUR_ZERO });
	const s2 = m.s2.filter((r) => !r.ok), s3 = m.s3.filter((r) => !r.ok);
	const caught = s2.length > 0 && s3.length > 0;
	if (caught) pass++;
	else failures.push(`mutant not caught: the mapping honouring a numeric 0 (§2 failed ${s2.length}, §3 failed ${s3.length})`);
	console.log(`  ${caught ? "caught " : "MISSED "} M1 the PUT's mapping honouring a numeric 0 — §2 failed ${s2.length} check(s), §3 failed ${s3.length}` +
		`${s3[0] ? `, e.g. ✗ ${s3[0].name}` : ""}`.slice(0, 300));

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) {
		console.log("\nFailures:");
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
