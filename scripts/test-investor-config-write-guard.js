#!/usr/bin/env node
/**
 * Investor configuration writes are Super Admin only, name whose rows they
 * change, write only allowlisted keys, and are audited.
 *
 * PUT /api/investor/config writes investor_config: the split every payout is
 * computed from, and the fleet-wide targets the admin screens read. It is
 * mounted requireRole("Super Admin"), refuseCrossOrigin; ?ownerId= is required
 * ("global" or an investor's users.id); the body is 1..20 keys from
 * INVESTOR_CONFIG_KEYS, every value checked before anything is written; only
 * the keys whose value changes are written, in one transaction, and audited
 * before → after. GET stays readable by an Investor.
 *
 * WHAT IS ASSERTED. The GET and PUT handlers, the allowlist and its three
 * helpers, parsePlainDecimal() and the audit writer are lifted out of server.js
 * and run against an in-memory SQLite built from server.js's own DDL and seed.
 * The role gate is a stub that enforces the roles the route names, so the gate
 * on the registration line is what is tested; the cross-origin guard has its
 * own runner (scripts/test-csrf-guard.js) and is a pass-through here.
 *   §1 the role gate: an Investor (for their own id, as QA sent it) and a
 *      Dispatcher get 403 and nothing is written; an Investor still reads GET.
 *   §2 ?ownerId=: missing → 400 OWNER_ID_REQUIRED; malformed → 400
 *      INVALID_OWNER_ID; not an investor → 404 INVESTOR_NOT_FOUND; "global" and
 *      a real investor (by role, or linked through investors.user_id) pass.
 *   §3 the body: not a 1..20-key object → 400 INVALID_CONFIG_BODY; a key off
 *      the allowlist → 400 UNKNOWN_CONFIG_KEY; a bad value → 400
 *      INVALID_CONFIG_VALUE; a fleet-wide key for one investor → 400
 *      CONFIG_KEY_GLOBAL_ONLY; each with `key`, and nothing written even when
 *      the bad key follows good ones.
 *   §4 the write: InvestorSplitCell's request and Admin Tools' request as the
 *      client sends them; only changed keys written (a no-op save writes no
 *      row, no audit line, no event, and leaves every rowid alone); the audit
 *      row reads "key: before → after"; the reply is { success, ownerId,
 *      changed }.
 *   §5 the allowlist is the seeded keys that something reads (plus the broker
 *      list Admin Tools edits), and its fleet-wide-only keys are the ones read
 *      with owner_id = 0 alone.
 *   §6 fleet-wide readers (B3): GET /api/maintenance-fund reads the global
 *      target, not an investor's row (run); GET /api/expenses/fuel-analytics
 *      reads owner_id = 0 (source); every investor_config read in server.js
 *      names an owner.
 *   §7 the client: the store's updateConfig() sends ?ownerId=global and MERGES
 *      the saved keys into the loaded config (run); InvestorSplitCell sends
 *      ?ownerId=<users.id> with investor_split_pct.
 *   §8 source pins: the PUT is synchronous and the registration line.
 *   §9 MUTANTS: the role gate widened to Investors, the global-only check
 *      dropped, the owner check dropped, the fleet readers unfiltered.
 *
 * Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-investor-config-write-guard.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
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
const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

const HEADS = {
	get: 'app.get("/api/investor/config", requireRole("Super Admin", "Investor"), (req, res) => {',
	put: 'app.put("/api/investor/config", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {',
	fund: 'app.get("/api/maintenance-fund", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	fuel: 'app.get("/api/expenses/fuel-analytics", requireRole("Super Admin", "Dispatcher"), fuelAnalyticsLimiter, (req, res) => {',
};
const ROUTES = Object.fromEntries(Object.entries(HEADS).map(([k, h]) => [k, liftRoute(h)]));
const PIECES = [
	liftConst("const INVESTOR_CONFIG_KEYS = new Map([", "\n]);"),
	liftConst("const INVESTOR_CONFIG_MAX_ENTRIES = "),
	liftFunction("investorConfigOwner"),
	liftFunction("investorConfigValue"),
	liftFunction("investorConfigSame"),
	liftFunction("parsePlainDecimal"),
	liftFunction("logAudit"),
	liftFunction("scrubPurgeMarker"),
	liftFunction("auditText"),
].join("\n");
function buildModule(db, pieces = PIECES) {
	return new Function("db", `"use strict";\n${pieces}\nreturn { INVESTOR_CONFIG_KEYS, INVESTOR_CONFIG_MAX_ENTRIES, investorConfigOwner, investorConfigValue, investorConfigSame, parsePlainDecimal, logAudit, auditText };`)(db);
}

// ── fixtures ────────────────────────────────────────────────────────────────
function usersDdl() {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE users");
	const alters = ["full_name", "company_name"].map((col) => {
		const a = SRC.match(new RegExp(`ALTER TABLE users ADD COLUMN ${col} [^"]*`));
		if (!a) die(`could not locate the users.${col} migration`);
		return a[0];
	});
	return [`CREATE TABLE users (${m[1]}\n)`, ...alters];
}
function auditDdl() {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS audit_trail \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE audit_trail");
	return `CREATE TABLE audit_trail (${m[1]}\n)`;
}
function configDdl() {
	const m = SRC.match(/\n\t\tCREATE TABLE investor_config \(([\s\S]*?)\n\t\t\);/);
	if (!m) die("could not locate the investor_config (owner_id, key) table");
	return `CREATE TABLE investor_config (${m[1]}\n)`;
}
// The seed, as server.js writes it on a fresh database.
const SEED = (() => {
	const m = SRC.match(/seedMany\(\[([\s\S]*?)\n\t\]\);/);
	if (!m) die("could not locate the investor_config seed");
	const rows = new Function(`return [${m[1]}];`)();
	const grace = SRC.match(/VALUES \(0, 'settlement_grace_days', '(\d+)'\)/);
	if (!grace) die("could not locate the settlement_grace_days seed");
	return [...rows, ["settlement_grace_days", grace[1]]];
})();

const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const INV_A = { id: 2, username: "inv_a", role: "Investor" };
const INV_B = { id: 3, username: "inv_b", role: "Investor" };
const DISPATCHER = { id: 4, username: "kevin", role: "Dispatcher" };

function makeDb() {
	const db = new Database(":memory:");
	for (const sql of [...usersDdl(), auditDdl(), configDdl()]) db.exec(sql);
	db.exec(`CREATE TABLE investors (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, full_name TEXT NOT NULL DEFAULT '', carrier_name TEXT NOT NULL DEFAULT '')`);
	db.exec("CREATE TABLE maintenance_fund (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, amount REAL, description TEXT, truck TEXT, date TEXT)");
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (?, ?, 'x', ?, '')");
	user.run(1, "super_admin", "Super Admin");
	user.run(2, "inv_a", "Investor");
	user.run(3, "inv_b", "Investor");
	user.run(4, "kevin", "Dispatcher");
	user.run(5, "linked_driver", "Driver"); // no Investor role, but an investors record links it
	const inv = db.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (?, ?, ?)");
	inv.run(2, "Investor A", "Investor A");
	inv.run(3, "Investor B", "Investor B");
	inv.run(5, "Linked Holdings", "Linked Holdings");
	const seed = db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, ?, ?)");
	for (const [k, v] of SEED) seed.run(k, v);
	db.prepare("INSERT INTO maintenance_fund (type, amount, description, truck, date) VALUES ('contribution', 800, 'x', '33', '2026-09-01')").run();
	return db;
}

// Registers a lifted route and runs its whole middleware chain.
function mountRoute(routeSrc, env) {
	let chain = null;
	const grab = (p, ...fns) => { chain = fns; };
	const requireRole = (...roles) => (req, res, next) => (roles.includes(req.session.user.role) ? next() : res.status(403).json({ error: "Forbidden" }));
	const all = {
		app: { get: grab, put: grab }, requireRole,
		refuseCrossOrigin: (req, res, next) => next(), fuelAnalyticsLimiter: (req, res, next) => next(), ...env,
	};
	const names = Object.keys(all);
	new Function(...names, routeSrc)(...names.map((k) => all[k]));
	if (!Array.isArray(chain) || typeof chain[chain.length - 1] !== "function") die("a lifted route did not register a handler");
	return (req) => {
		const out = { status: 200, body: null, sent: false };
		const res = {
			status(c) { out.status = c; return this; },
			json(b) { out.body = b; out.sent = true; return this; },
			setHeader() {},
		};
		const full = { params: {}, query: {}, body: {}, ...req };
		let i = 0;
		const next = () => { const fn = chain[i++]; if (fn) fn(full, res, next); };
		next();
		return out;
	};
}
function quiet(fn) {
	const e = console.error;
	console.error = () => {};
	try { return fn(); } finally { console.error = e; }
}

function mount(db, { putSrc = ROUTES.put, pieces = PIECES, fundSrc = ROUTES.fund } = {}) {
	const m = buildModule(db, pieces);
	const events = [];
	const env = { db, ...m, notifyChange: (d) => events.push(d) };
	const put = mountRoute(putSrc, env);
	const get = mountRoute(ROUTES.get, env);
	const fund = mountRoute(fundSrc, env);
	return {
		events,
		put: (user, query, body) => quiet(() => put({ session: { user }, query, body })),
		get: (user, query = {}) => quiet(() => get({ session: { user }, query })),
		fund: (user) => quiet(() => fund({ session: { user } })),
	};
}

const cfgRow = (db, owner, key) => db.prepare("SELECT rowid AS rid, value FROM investor_config WHERE owner_id = ? AND key = ?").get(owner, key);
const snapshot = (db) => JSON.stringify(db.prepare("SELECT rowid AS rid, owner_id, key, value FROM investor_config ORDER BY rowid").all());
const audits = (db) => db.prepare("SELECT * FROM audit_trail WHERE action = 'update_investor_config' ORDER BY id").all();

// ─────────────────────────────────────────────────────────── §1 role gate
function roleSection(opts = {}) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const db = makeDb();
	const app = mount(db, opts);
	const before = snapshot(db);
	const a = app.put(INV_A, { ownerId: "2" }, { investor_split_pct: "99" });
	t(a.status === 403, `§1 an Investor's PUT for their own id is 403 (got ${a.status} ${JSON.stringify(a.body)})`);
	t(snapshot(db) === before && !cfgRow(db, 2, "investor_split_pct"), "§1 ...and no per-investor row is written");
	const g = app.get(INV_A);
	t(g.status === 200 && g.body.investor_split_pct === "50", `§1 ...and the Investor's GET still reads the split, unchanged (got ${g.status} ${JSON.stringify(g.body && g.body.investor_split_pct)})`);
	const d = app.put(DISPATCHER, { ownerId: "global" }, { fuel_savings_target_pct: "20" });
	t(d.status === 403 && snapshot(db) === before, `§1 a Dispatcher's PUT is 403, nothing written (got ${d.status})`);
	t(audits(db).length === 0 && app.events.length === 0, "§1 a refused PUT writes no audit row and emits nothing");
	const s = app.put(SUPER, { ownerId: "2" }, { investor_split_pct: "45" });
	t(s.status === 200, `§1 a Super Admin's PUT goes through (got ${s.status} ${JSON.stringify(s.body)})`);
	return r;
}

// ─────────────────────────────────────────────────────────── §2 ownerId
function ownerSection(opts = {}) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const db = makeDb();
	const app = mount(db, opts);
	const before = snapshot(db);
	for (const [label, q] of [["missing", {}], ["empty", { ownerId: "" }]]) {
		const x = app.put(SUPER, q, { investor_split_pct: "50" });
		t(x.status === 400 && x.body.code === "OWNER_ID_REQUIRED", `§2 ownerId ${label}: 400 OWNER_ID_REQUIRED (got ${x.status} ${x.body && x.body.code})`);
	}
	for (const bad of ["abc", "0", "-1", "1.5", "2abc", " 2", "Global", ["2", "3"], "1".repeat(16)]) {
		const x = app.put(SUPER, { ownerId: bad }, { investor_split_pct: "50" });
		t(x.status === 400 && x.body.code === "INVALID_OWNER_ID", `§2 ownerId ${JSON.stringify(bad)}: 400 INVALID_OWNER_ID (got ${x.status} ${x.body && x.body.code})`);
	}
	for (const [label, id] of [["no such user", "999"], ["a Dispatcher", "4"], ["the Super Admin", "1"]]) {
		const x = app.put(SUPER, { ownerId: id }, { investor_split_pct: "50" });
		t(x.status === 404 && x.body.code === "INVESTOR_NOT_FOUND", `§2 ownerId of ${label}: 404 INVESTOR_NOT_FOUND (got ${x.status} ${x.body && x.body.code})`);
	}
	t(snapshot(db) === before && audits(db).length === 0, "§2 every refused owner wrote nothing");
	const linked = app.put(SUPER, { ownerId: "5" }, { investor_split_pct: "30" });
	t(linked.status === 200 && cfgRow(db, 5, "investor_split_pct").value === "30",
		`§2 a user linked through investors.user_id passes (got ${linked.status} ${JSON.stringify(linked.body)})`);
	const glob = app.put(SUPER, { ownerId: "global" }, { investor_split_pct: "55" });
	t(glob.status === 200 && glob.body.ownerId === 0 && cfgRow(db, 0, "investor_split_pct").value === "55",
		`§2 ownerId=global writes the fleet-wide row (got ${glob.status} ${JSON.stringify(glob.body)})`);
	return r;
}

// ─────────────────────────────────────────────────────────── §3 body
function bodySection(opts = {}) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const db = makeDb();
	const app = mount(db, opts);
	const before = snapshot(db);
	const refuse = (label, query, body, code, key) => {
		const x = app.put(SUPER, query, body);
		t(x.status === 400 && x.body.code === code && (key === undefined || x.body.key === key) && snapshot(db) === before,
			`§3 ${label}: 400 ${code}${key !== undefined ? ` (key ${key})` : ""}, nothing written (got ${x.status} ${JSON.stringify(x.body)})`);
	};
	const G = { ownerId: "global" };
	const A = { ownerId: "2" };
	refuse("an empty object", G, {}, "INVALID_CONFIG_BODY");
	refuse("an array", G, [["investor_split_pct", "50"]], "INVALID_CONFIG_BODY");
	refuse("a string", G, "investor_split_pct=50", "INVALID_CONFIG_BODY");
	refuse("null", G, null, "INVALID_CONFIG_BODY");
	refuse("21 keys", G, Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "1"])), "INVALID_CONFIG_BODY");
	refuse("an unknown key", G, { investor_split: "50" }, "UNKNOWN_CONFIG_KEY", "investor_split");
	refuse("a seeded key nothing reads", G, { section_179_deduction: "30000" }, "UNKNOWN_CONFIG_KEY", "section_179_deduction");
	refuse("a __proto__ key off the wire", G, JSON.parse('{"__proto__": "50"}'), "UNKNOWN_CONFIG_KEY", "__proto__");
	refuse("a constructor key", G, { constructor: "50" }, "UNKNOWN_CONFIG_KEY", "constructor");
	for (const v of ["101", "-1", "abc", "0x10", "", "  ", null, true, "50.123", "Infinity", "1e400", [50], "50%"]) {
		refuse(`investor_split_pct ${JSON.stringify(v)}`, A, { investor_split_pct: v }, "INVALID_CONFIG_VALUE", "investor_split_pct");
	}
	for (const v of ["1000000.01", "85,000", "-5", "$800"]) {
		refuse(`truck_purchase_price ${JSON.stringify(v)}`, A, { truck_purchase_price: v }, "INVALID_CONFIG_VALUE", "truck_purchase_price");
	}
	refuse("settlement_grace_days 7.5", G, { settlement_grace_days: "7.5" }, "INVALID_CONFIG_VALUE", "settlement_grace_days");
	refuse("settlement_grace_days 29", G, { settlement_grace_days: 29 }, "INVALID_CONFIG_VALUE", "settlement_grace_days");
	refuse("depreciation_years 0", A, { depreciation_years: "0" }, "INVALID_CONFIG_VALUE", "depreciation_years");
	refuse("truck_title_status with a line break", A, { truck_title_status: "Clean\nLien" }, "INVALID_CONFIG_VALUE", "truck_title_status");
	refuse("truck_title_status of 41 characters", A, { truck_title_status: "x".repeat(41) }, "INVALID_CONFIG_VALUE", "truck_title_status");
	refuse("truck_title_status that is a number", A, { truck_title_status: 5 }, "INVALID_CONFIG_VALUE", "truck_title_status");
	refuse("blue_chip_brokers with a text-direction override", G, { blue_chip_brokers: `Pepsi${String.fromCodePoint(0x202e)},Coke` }, "INVALID_CONFIG_VALUE", "blue_chip_brokers");
	refuse("blue_chip_brokers with a zero-width space", G, { blue_chip_brokers: `Pepsi${String.fromCodePoint(0x200b)}` }, "INVALID_CONFIG_VALUE", "blue_chip_brokers");
	for (const key of ["maintenance_fund_monthly", "fuel_savings_target_pct", "settlement_grace_days", "blue_chip_brokers"]) {
		const v = key === "blue_chip_brokers" ? "Pepsi" : "10";
		refuse(`${key} for one investor`, A, { [key]: v }, "CONFIG_KEY_GLOBAL_ONLY", key);
	}
	refuse("a good key followed by a bad one", A, { investor_split_pct: "40", truck_purchase_price: "abc" }, "INVALID_CONFIG_VALUE", "truck_purchase_price");
	refuse("a good key followed by an unknown one", A, { investor_split_pct: "40", foo: "1" }, "UNKNOWN_CONFIG_KEY", "foo");
	t(audits(db).length === 0 && app.events.length === 0, "§3 no refusal wrote an audit row or emitted an event");
	return r;
}

// ─────────────────────────────────────────────────────────── §4 write
function writeSection(opts = {}) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const db = makeDb();
	const app = mount(db, opts);

	// InvestorSplitCell's save, exactly as the component sends it.
	const s1 = app.put(SUPER, { ownerId: "3" }, { investor_split_pct: String(45) });
	t(s1.status === 200 && JSON.stringify(s1.body) === JSON.stringify({ success: true, ownerId: 3, changed: ["investor_split_pct"] }),
		`§4 InvestorSplitCell's request: 200 { success, ownerId, changed } (got ${s1.status} ${JSON.stringify(s1.body)})`);
	t(cfgRow(db, 3, "investor_split_pct").value === "45", "§4 ...B's own split is stored");
	let a = audits(db);
	t(a.length === 1 && a[0].entity === "investor_config" && a[0].entity_id === "owner:3" && a[0].details === "investor_split_pct: unset → 45" && a[0].username === "super_admin",
		`§4 ...and audited as update_investor_config, owner:3, "investor_split_pct: unset → 45" (got ${JSON.stringify(a)})`);
	t(JSON.stringify(app.events) === JSON.stringify(["investor"]), `§4 ...and one investor:changed event (got ${JSON.stringify(app.events)})`);
	t(app.get(INV_B).body.investor_split_pct === "45" && app.get(INV_A).body.investor_split_pct === "50",
		"§4 B reads 45 through GET; A still reads the global 50");

	const s2 = app.put(SUPER, { ownerId: "3" }, { investor_split_pct: "40" });
	a = audits(db);
	t(s2.status === 200 && a.length === 2 && a[1].details === "investor_split_pct: 45 → 40", `§4 a second change is audited before → after (got ${JSON.stringify(a[1])})`);

	// A save that changes nothing writes nothing.
	const rid = cfgRow(db, 3, "investor_split_pct").rid;
	const before = snapshot(db);
	const nEvents = app.events.length;
	const s3 = app.put(SUPER, { ownerId: "3" }, { investor_split_pct: "40.00" });
	t(s3.status === 200 && JSON.stringify(s3.body.changed) === "[]" && snapshot(db) === before && cfgRow(db, 3, "investor_split_pct").rid === rid,
		`§4 a no-op save ("40.00" over "40"): 200, changed [], no row rewritten (got ${JSON.stringify(s3.body)})`);
	t(audits(db).length === 2 && app.events.length === nEvents, "§4 ...no audit row and no event");

	// Admin Tools' Fleet Configuration save, as ConfigPanel emits it after loading
	// the config: the loaded values, one of them a number.
	const brokers = SEED.find(([k]) => k === "blue_chip_brokers")[1];
	const globalBefore = snapshot(db);
	const t1 = app.put(SUPER, { ownerId: "global" }, { fuel_savings_target_pct: 15, blue_chip_brokers: brokers });
	t(t1.status === 200 && JSON.stringify(t1.body.changed) === "[]" && snapshot(db) === globalBefore,
		`§4 Admin Tools' unchanged save: 200, nothing re-inserted (every rowid kept) (got ${t1.status} ${JSON.stringify(t1.body)})`);
	const t2 = app.put(SUPER, { ownerId: "global" }, { fuel_savings_target_pct: 20, blue_chip_brokers: " Pepsi, Coca-Cola " });
	a = audits(db);
	t(t2.status === 200 && JSON.stringify(t2.body) === JSON.stringify({ success: true, ownerId: 0, changed: ["fuel_savings_target_pct", "blue_chip_brokers"] }),
		`§4 Admin Tools' save with changes: both keys written (got ${JSON.stringify(t2.body)})`);
	t(cfgRow(db, 0, "fuel_savings_target_pct").value === "20" && cfgRow(db, 0, "blue_chip_brokers").value === "Pepsi, Coca-Cola",
		"§4 ...stored as plain text, the broker list trimmed");
	t(a.length === 3 && a[2].entity_id === "global" && a[2].details.startsWith("fuel_savings_target_pct: 15 → 20; blue_chip_brokers: Pepsi,Coca-Cola"),
		`§4 ...one audit row for the save, entity global, naming both (got ${JSON.stringify(a[2])})`);
	t(cfgRow(db, 0, "investor_split_pct").value === "50" && cfgRow(db, 3, "investor_split_pct").value === "40",
		"§4 ...and no other row moved");

	// Canonical text: a number is stored as its plain decimal.
	const t3 = app.put(SUPER, { ownerId: "2" }, { truck_purchase_price: "85000.50", depreciation_years: 7, truck_title_status: "  Salvage " });
	t(t3.status === 200 && cfgRow(db, 2, "truck_purchase_price").value === "85000.5" && cfgRow(db, 2, "depreciation_years").value === "7" && cfgRow(db, 2, "truck_title_status").value === "Salvage",
		`§4 per-investor keys are stored in canonical form (got ${JSON.stringify(t3.body)})`);
	return r;
}

// ─────────────────────────────────────────────────────────── §5 allowlist
function allowlistSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const m = buildModule(makeDb());
	const keys = [...m.INVESTOR_CONFIG_KEYS.keys()];
	const seeded = SEED.map(([k]) => k);
	t(keys.every((k) => seeded.includes(k)), `§5 every allowlisted key is seeded (not: ${keys.filter((k) => !seeded.includes(k)).join(", ") || "none"})`);
	const body = code(SRC);
	const isRead = (k) => new RegExp(`config\\.${k}\\b|key = '${k}'`).test(body);
	const readSeeded = seeded.filter(isRead);
	t(JSON.stringify(readSeeded.slice().sort()) === JSON.stringify(keys.filter((k) => k !== "blue_chip_brokers").sort()),
		`§5 the allowlist is exactly the seeded keys something reads, plus blue_chip_brokers (read: ${readSeeded.join(", ")})`);
	const panel = fs.readFileSync(path.join(ROOT, "client", "src", "components", "investor", "ConfigPanel.vue"), "utf8");
	const formKeys = (panel.match(/const form = reactive\(\{([\s\S]*?)\}\)/) || [])[1] || "";
	const sent = [...formKeys.matchAll(/(\w+):/g)].map((x) => x[1]);
	t(sent.length > 0 && sent.every((k) => m.INVESTOR_CONFIG_KEYS.has(k) && m.INVESTOR_CONFIG_KEYS.get(k).globalOnly),
		`§5 every key Admin Tools' ConfigPanel sends is allowlisted and fleet-wide (sends: ${sent.join(", ")})`);
	const globalOnly = keys.filter((k) => m.INVESTOR_CONFIG_KEYS.get(k).globalOnly).sort();
	t(JSON.stringify(globalOnly) === JSON.stringify(["blue_chip_brokers", "fuel_savings_target_pct", "maintenance_fund_monthly", "settlement_grace_days"]),
		`§5 the fleet-wide-only keys (got ${globalOnly.join(", ")})`);
	return r;
}

// ─────────────────────────────────────────────────────────── §6 fleet readers
function fleetReadersSection(opts = {}) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const db = makeDb();
	const app = mount(db, opts);
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (2, 'maintenance_fund_monthly', '98765')").run();
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (2, 'fuel_savings_target_pct', '87')").run();
	const f = app.fund(SUPER);
	t(f.status === 200 && f.body.monthlyTarget === 800,
		`§6 GET /api/maintenance-fund: the global 800, not investor A's planted 98765 (got ${f.status} ${f.body && f.body.monthlyTarget})`);
	const fuel = code(opts.fuelSrc || ROUTES.fuel);
	t(/db\.prepare\("SELECT key, value FROM investor_config WHERE owner_id = 0"\)/.test(fuel) && !/FROM investor_config"\)/.test(fuel),
		"§6 GET /api/expenses/fuel-analytics reads the fleet-wide row alone (owner_id = 0)");
	const reads = [...code(opts.src || SRC).matchAll(/"[^"\n]*FROM investor_config[^"\n]*"/g)].map((x) => x[0]);
	t(reads.length > 0 && reads.every((s) => /owner_id/.test(s)),
		`§6 every investor_config read in server.js names an owner (unfiltered: ${reads.filter((s) => !/owner_id/.test(s)).join(" | ") || "none"})`);
	return r;
}

// ─────────────────────────────────────────────────────────── §7 the client
async function clientSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const store = fs.readFileSync(path.join(ROOT, "client", "src", "stores", "investor.js"), "utf8");
	const at = store.indexOf("async updateConfig(config) {");
	if (at < 0) die("could not locate updateConfig() in client/src/stores/investor.js");
	let depth = 0;
	let end = -1;
	for (let i = store.indexOf("{", at); i < store.length; i++) {
		if (store[i] === "{") depth++;
		else if (store[i] === "}" && --depth === 0) { end = i; break; }
	}
	const body = store.slice(store.indexOf("{", at) + 1, end);
	const calls = [];
	const api = { put: async (url, payload) => { calls.push({ url, payload }); return { success: true, ownerId: 0, changed: Object.keys(payload) }; } };
	const updateConfig = new Function("api", `return async function updateConfig(config) {${body}};`)(api);
	const loaded = Object.fromEntries(SEED);
	const fake = { _payoutsToken: 0, data: { config: { ...loaded } } };
	await updateConfig.call(fake, { fuel_savings_target_pct: 20, blue_chip_brokers: "Pepsi" });
	t(calls.length === 1 && calls[0].url === "/api/investor/config?ownerId=global",
		`§7 the store's updateConfig() names the fleet-wide config (got ${JSON.stringify(calls.map((c) => c.url))})`);
	t(Object.keys(fake.data.config).length === SEED.length && fake.data.config.fuel_savings_target_pct === 20 && fake.data.config.investor_split_pct === "50",
		`§7 ...and merges the saved keys into the loaded config, keeping all ${SEED.length} (got ${Object.keys(fake.data.config).length} keys)`);

	const cell = fs.readFileSync(path.join(ROOT, "client", "src", "components", "investors", "InvestorSplitCell.vue"), "utf8");
	t(/api\.put\(`\/api\/investor\/config\?ownerId=\$\{props\.ownerId\}`,\s*\{\s*investor_split_pct: String\(pct\),?\s*\}\)/.test(cell),
		"§7 InvestorSplitCell sends ?ownerId=<users.id> with { investor_split_pct: String(pct) } (the shape §4 runs)");
	return r;
}

// ─────────────────────────────────────────────────────────── §8 source pins
function pinSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const put = code(ROUTES.put);
	t(!/\bawait\b/.test(put) && !/async\s*\(/.test(put), "§8 the PUT handler is synchronous: no await between its checks and its write");
	t(put.indexOf("investorConfigOwner(") < put.indexOf("db.transaction(") && put.indexOf("INVESTOR_CONFIG_KEYS.get(") < put.indexOf("db.transaction("),
		"§8 every check runs before the transaction");
	t(!/INSERT OR REPLACE/.test(put), "§8 no INSERT OR REPLACE (it deletes and re-inserts the row)");
	return r;
}

// ─────────────────────────────────────────────────────────── §9 mutants
async function mutantSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const failed = (results) => results.some((x) => !x.ok);
	const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };

	t(failed(roleSection({ putSrc: swap(ROUTES.put, 'requireRole("Super Admin"), refuseCrossOrigin', 'requireRole("Super Admin", "Investor"), refuseCrossOrigin') })),
		"MUTANT the role gate widened to Investors: caught by §1");
	t(failed(roleSection({ putSrc: swap(ROUTES.put, 'requireRole("Super Admin"), refuseCrossOrigin, ', "") })),
		"MUTANT the role gate dropped: caught by §1");
	t(failed(bodySection({ putSrc: swap(ROUTES.put, "if (spec.globalOnly && ownerId !== 0) {", "if (false) {") })),
		"MUTANT the fleet-wide-only check dropped: caught by §3");
	t(failed(ownerSection({ pieces: swap(PIECES, "if (!known) return", "if (false) return") })),
		"MUTANT the investor-exists check dropped: caught by §2");
	t(failed(writeSection({ putSrc: swap(ROUTES.put, "const changes = next.filter((c) => !investorConfigSame(c.spec, stored.get(c.key), c.value));", "const changes = next;") })),
		"MUTANT every sent key written, changed or not: caught by §4");
	const unfiltered = swap(ROUTES.fund, 'FROM investor_config WHERE owner_id = 0"', 'FROM investor_config"');
	t(failed(fleetReadersSection({ fundSrc: unfiltered })), "MUTANT GET /api/maintenance-fund reading every owner's row: caught by §6");
	t(failed(fleetReadersSection({ fuelSrc: swap(ROUTES.fuel, 'FROM investor_config WHERE owner_id = 0"', 'FROM investor_config"'), src: SRC.replace(ROUTES.fuel, swap(ROUTES.fuel, 'FROM investor_config WHERE owner_id = 0"', 'FROM investor_config"')) })),
		"MUTANT GET /api/expenses/fuel-analytics reading every owner's row: caught by §6");
	return r;
}

function record(results) {
	for (const x of results) ok(x.ok, x.name);
	console.log(`  ${results.filter((x) => x.ok).length}/${results.length} checks`);
}

(async () => {
	section("§1 the role gate");
	record(roleSection());
	section("§2 ?ownerId=");
	record(ownerSection());
	section("§3 the body");
	record(bodySection());
	section("§4 the write");
	record(writeSection());
	section("§5 the allowlist");
	record(allowlistSection());
	section("§6 fleet-wide readers");
	record(fleetReadersSection());
	section("§7 the client");
	record(await clientSection());
	section("§8 source pins");
	record(pinSection());
	section("§9 mutants");
	record(await mutantSection());

	if (failures.length) {
		console.error(`\nFAILURES (${failures.length}):`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n✓ ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
