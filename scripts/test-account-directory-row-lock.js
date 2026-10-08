#!/usr/bin/env node
/**
 * The drivers_directory row an account flow creates is held to the month-end
 * lock (2026-10-04).
 *
 * THE BUG. POST /api/users (a Driver account), onboarding completion (the last
 * document signed) and drug-test completion each add the driver's
 * drivers_directory row through syncDriverToCarrierSheet(action "add"), with the
 * account's company name as the carrier. Nothing checked that carrier. When it
 * matches an investor's company, getInvestorDriverSet() hands that investor the
 * driver's revenue, expenses and pay in every month they worked, finalized
 * months included. POST /api/drivers-directory refuses exactly that row since
 * #427 (directoryCreateLockBlockers()); these three paths did not ask.
 *
 * THE FIX. Each path judges the row it is about to add with
 * directoryCreateLockBlockers(), the driver's exposure sized off
 * driverHistoryFloorMonth() (Job Tracking read first, only when there is a
 * carrier to judge and no row yet):
 *   • POST /api/users refuses the whole create: 409 PERIOD_FINALIZED, no account,
 *     no row, audited as create_driver_pay_blocked;
 *   • onboarding and drug-test completion still add the row (the driver's
 *     signature and the admin's upload are not refused) but without the carrier,
 *     and record the withheld carrier as create_driver_pay_blocked.
 * A carrier no investor's company matches, a driver with no history in a
 * finalized month, and a driver who already has a row are unchanged.
 *
 * WHAT RUNS. POST /api/users, checkAndCompleteOnboarding() and
 * syncDriverToCarrierSheet() lifted whole out of server.js over an in-memory
 * SQLite, with server.js's own name checks, investorsHoldingDriver() and month-end
 * lock. Stubbed: bcrypt, e-mail, notifications, Job Tracking (a counter), the
 * history floor (a per-driver answer), and the refusal recorders, which keep
 * what they are handed.
 *   §1 POST /api/users
 *   §2 onboarding completion (all documents signed)
 *   §3 drug-test completion (fully onboarded, no row yet)
 *   §4 onboarding completion while Job Tracking cannot be read
 *
 * Pure: no server, no app.db, no network.
 *   node scripts/test-account-directory-row-lock.js
 *   SERVER_JS=/tmp/base.js node scripts/test-account-directory-row-lock.js   # a base commit: fails
 */
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function check(label, cond) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.log(`  FAIL  ${label}`);
}

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run it under the .nvmrc Node`);
}

function findOnce(needle, what) {
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 ${what}, found ${hits}`);
	return SRC.indexOf(needle) + 1;
}
function liftFunction(name, prefix = "function") {
	const a = findOnce(`\n${prefix} ${name}(`, `definition of ${name}()`);
	return SRC.slice(a, SRC.indexOf("\n}\n", a) + 2);
}
function liftNew(name) {
	return SRC.includes(`\nfunction ${name}(`) ? liftFunction(name) : "";
}
function liftConst(head, close = null) {
	const a = findOnce(`\n${head}`, `statement starting ${JSON.stringify(head)}`);
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	return SRC.slice(a, end + (close ? close.length : 1));
}
const USERS_ROUTE = (() => {
	const head = 'app.post("/api/users", requireRole("Super Admin"), async (req, res) => {';
	const a = findOnce(`\n${head}`, "registration of POST /api/users");
	return SRC.slice(a, SRC.indexOf("\n});", a) + "\n});".length);
})();

const MODULE_SRC = [
	liftConst("const REFUSAL_AUDIT_WINDOW_MS = "),
	liftConst("const refusalAuditWindows = "),
	liftConst("const UNCOALESCED_REFUSAL_CODES = new Set([", "\n]);"),
	liftFunction("logAudit"),
	liftFunction("logAuditRefusal"),
	liftFunction("scrubPurgeMarker"),
	liftFunction("auditText"),
	liftFunction("escapeHtml"),
	liftConst("const ONBOARDING_DOCS = [", "\n];"),
	liftFunction("directoryPayStruct"),
	liftConst("const DIRECTORY_PERIOD_COLUMNS = "),
	liftFunction("directoryChangedColumns"),
	liftFunction("normalizeDriverName"),
	liftFunction("isBuiltInPropertyName"),
	liftFunction("findDriverNameClashes"),
	liftFunction("findDriverNameClash"),
	liftFunction("driverNameHeldByOtherAccount"),
	liftFunction("findDirectoryRowForDriver"),
	liftFunction("findTruckForDriver"),
	liftFunction("investorsHoldingDriver"),
	liftConst("const DIRECTORY_DEFAULT_STRUCT = "),
	liftFunction("lockedPeriodsDesc"),
	liftFunction("driverPayLockedMonths"),
	liftFunction("truckDailyRateCandidates"),
	liftFunction("resolveDailyRate"),
	liftFunction("directoryEditLockBlockers"),
	liftFunction("directoryDefaultRow"),
	liftFunction("directoryCreateLockBlockers"),
	liftNew("accountDirectoryRowJudged"),
	liftNew("accountDirectoryRowLock"),
	liftNew("accountDirectoryCarrier"),
	liftNew("onboardingAddsJudgedRow"),
	liftFunction("syncDriverToCarrierSheet"),
	liftFunction("checkAndCompleteOnboarding", "async function"),
].join("\n");
const MODULE_EXPORTS = ["logAudit", "auditText", "normalizeDriverName", "findDriverNameClash", "syncDriverToCarrierSheet", "checkAndCompleteOnboarding",
	...["accountDirectoryRowJudged", "accountDirectoryRowLock"].filter((n) => SRC.includes(`\nfunction ${n}(`))];

const LOCKED = ["2026-06", "2026-07", "2026-08"];
const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };

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
	`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT,
		driver_name TEXT DEFAULT '', email TEXT DEFAULT '', full_name TEXT DEFAULT '', company_name TEXT DEFAULT '')`,
	"CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, assigned_driver TEXT DEFAULT '', driver_pay_daily REAL DEFAULT 0, owner_id INTEGER DEFAULT 0, routemate_vehicle_id TEXT DEFAULT '')",
	"CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '')",
	"CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY AUTOINCREMENT, carrier_name TEXT, driver_name TEXT)",
	"CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked')",
	`CREATE TABLE driver_onboarding (user_id INTEGER PRIMARY KEY, application_id INTEGER, status TEXT, drug_test_result TEXT DEFAULT '',
		onboarded_at TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, driver_name TEXT DEFAULT '')`,
	"CREATE TABLE onboarding_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, doc_key TEXT, doc_name TEXT, signed INTEGER DEFAULT 0, signed_pdf_url TEXT DEFAULT '')",
	`CREATE TABLE job_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT DEFAULT '', phone TEXT DEFAULT '', cell TEXT DEFAULT '',
		address TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', zip TEXT DEFAULT '', dot TEXT DEFAULT '', mc TEXT DEFAULT '',
		hazmat TEXT DEFAULT '', position TEXT DEFAULT '')`,
];

const S = { floors: {}, jtReads: 0, refusals: [], recorded: [] };
const JT = { headers: ["Load ID", "Driver", "Assigned Date"], data: [] };

function makeApp() {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	for (const p of LOCKED) db.prepare("INSERT INTO period_locks (period, status) VALUES (?, 'locked')").run(p);
	db.prepare("INSERT INTO users (id, username, role, company_name) VALUES (7, 'acme', 'Investor', 'Acme Leasing')").run();
	const m = new Function("db", "todayKeyCT", "periodLocksReadable", "bcrypt", "sendEmail", "insertNotification", "notifyChange",
		"getJobTrackingCached", "driverHistoryFloorMonth", "recordPeriodRefusal", "path", "fs", "__dirname", "console",
		`"use strict";\n${MODULE_SRC}\nreturn { ${MODULE_EXPORTS.join(", ")} };`)(
		db, () => "2026-10-04", () => true,
		{ hash: async () => "hash" }, () => {}, { run() {} }, () => {},
		async () => { S.jtReads++; if (S.jtFails) throw new Error("Job Tracking could not be read"); return JT; },
		// As driverHistoryFloorMonth() answers: with no sheet in hand nothing can be dated.
		(name, jt) => (jt ? S.floors[String(name || "").trim().toLowerCase()] || { floor: "", unbounded: false } : { floor: "", unbounded: true }),
		(audit, code, periods, subject) => { S.recorded.push({ audit, code, periods, subject }); },
		path, { existsSync: () => false }, "/nonexistent", { error() {}, log() {}, warn() {} });
	let handler = null;
	const env = {
		app: { post: (p, guard, h) => { handler = h; } },
		requireRole: () => (req, res, next) => next(),
		db, ...m,
		bcrypt: { hash: async () => "hash" },
		getJobTrackingCached: async () => { S.jtReads++; return JT; },
		driverHistoryFloorMonth: (name, jt) => (jt ? S.floors[String(name || "").trim().toLowerCase()] || { floor: "", unbounded: false } : { floor: "", unbounded: true }),
		periodLocksReadable: () => true,
		periodBlockedResponse: (req, res, what, blockers, remedy, audit) => {
			S.refusals.push({ what, blockers, audit });
			return res.status(409).json({ code: "PERIOD_FINALIZED", periods: [...new Set(blockers.flatMap((b) => b.periods))].sort(), blockers });
		},
		periodLockUnreadableResponse: (req, res, what, audit) => {
			S.refusals.push({ what, audit });
			return res.status(409).json({ code: "PERIOD_LOCK_UNREADABLE" });
		},
		notifyChange: () => {},
		console: { error() {}, log() {}, warn() {} },
	};
	const names = Object.keys(env);
	new Function(...names, USERS_ROUTE)(...names.map((k) => env[k]));
	if (typeof handler !== "function") die("the lifted route did not register a handler");
	const createUser = async (body) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
		await handler({ session: { user: SUPER }, params: {}, query: {}, body }, res);
		return out;
	};
	// A driver account mid-onboarding: every document signed, the given status.
	const onboarding = (id, driverName, company, status, drug = "") => {
		db.prepare("INSERT INTO users (id, username, role, driver_name, company_name) VALUES (?, ?, 'Driver', ?, ?)").run(id, `u${id}`, driverName, company);
		db.prepare("INSERT INTO job_applications (id, phone) VALUES (?, '555-0100')").run(id);
		db.prepare("INSERT INTO driver_onboarding (user_id, application_id, status, drug_test_result) VALUES (?, ?, ?, ?)").run(id, id, status, drug);
		const docs = new Function(`${liftConst("const ONBOARDING_DOCS = [", "\n];")}\nreturn ONBOARDING_DOCS;`)();
		for (const d of docs) db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed) VALUES (?, ?, ?, 1)").run(id, d.key || d.docKey || "k", d.name || "Doc");
	};
	const complete = (id) => m.checkAndCompleteOnboarding(id, { session: { user: SUPER } });
	return { db, m, createUser, onboarding, complete };
}

function reset() {
	Object.assign(S, { floors: { "cara carrier": { floor: "2026-06", unbounded: false } }, jtReads: 0, jtFails: false, refusals: [], recorded: [] });
	return makeApp();
}
const dirRow = (db, name) => db.prepare("SELECT * FROM drivers_directory WHERE driver_name = ?").get(name);
const user = (db, name) => db.prepare("SELECT * FROM users WHERE driver_name = ?").get(name);
const blockedAudit = (a) => a && a.action === "create_driver_pay_blocked" && a.entity === "driver";

(async () => {
	console.log("§1 POST /api/users");
	{
		const { db, createUser } = reset();
		const r = await createUser({ username: "cara", password: "pw-Long-enough-1", role: "Driver", driverName: "Cara Carrier", companyName: "Acme Leasing" });
		check(`§1 a driver with June loads, an investor's company as their company: 409 PERIOD_FINALIZED over ${LOCKED.join(", ")} (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 409 && r.body.code === "PERIOD_FINALIZED" && JSON.stringify(r.body.periods) === JSON.stringify(LOCKED));
		check("§1 …no account and no directory row", !user(db, "Cara Carrier") && !dirRow(db, "Cara Carrier"));
		check("§1 …audited as create_driver_pay_blocked", blockedAudit((S.refusals[0] || {}).audit));
		check(`§1 …the history was read once (reads ${S.jtReads})`, S.jtReads === 1);
	}
	for (const [label, body, carrier, reads] of [
		["a new hire (no history), an investor's company", { driverName: "New Hire", companyName: "Acme Leasing" }, "Acme Leasing", 1],
		["a driver with June loads, a company no investor has", { driverName: "Cara Carrier", companyName: "Cara Trucking LLC" }, "Cara Trucking LLC", 1],
		["a driver with June loads, no company", { driverName: "Cara Carrier", companyName: "" }, "", 0],
	]) {
		const { db, createUser } = reset();
		const r = await createUser({ username: "x", password: "pw-Long-enough-1", role: "Driver", ...body });
		const row = dirRow(db, body.driverName);
		check(`§1 ${label}: 200, the row carries ${JSON.stringify(carrier)} (got ${r.status}, ${row ? JSON.stringify(row.carrier_name) : "no row"})`,
			r.status === 200 && !!user(db, body.driverName) && row && row.carrier_name === carrier);
		check(`§1 ${label}: Job Tracking read ${reads} time${reads === 1 ? "" : "s"} (got ${S.jtReads})`, S.jtReads === reads);
	}
	{
		// The directory already has the driver: the add writes nothing, so there is
		// nothing to judge.
		const { db, createUser } = reset();
		db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name) VALUES ('Cara Carrier', '')").run();
		const r = await createUser({ username: "cara", password: "pw-Long-enough-1", role: "Driver", driverName: "Cara Carrier", companyName: "Acme Leasing" });
		check(`§1 a driver already in the directory: 200, their row untouched, no read (got ${r.status}, reads ${S.jtReads})`,
			r.status === 200 && dirRow(db, "Cara Carrier").carrier_name === "" && S.jtReads === 0);
	}

	console.log("§2 onboarding completion (all documents signed)");
	{
		const { db, onboarding, complete } = reset();
		onboarding(20, "Cara Carrier", "Acme Leasing", "documents_pending");
		await complete(20);
		const row = dirRow(db, "Cara Carrier");
		check("§2 a driver with June loads, an investor's company: the row is added", !!row && row.status === "pending");
		check(`§2 …without the carrier (got ${row ? JSON.stringify(row.carrier_name) : "no row"})`, row && row.carrier_name === "");
		check("§2 …the onboarding still moves on", db.prepare("SELECT status FROM driver_onboarding WHERE user_id = 20").get().status === "documents_signed");
		const rec = S.recorded.find((x) => blockedAudit(x.audit));
		check("§2 …the withheld carrier is recorded as create_driver_pay_blocked, over the finalized months",
			!!rec && rec.code === "PERIOD_FINALIZED" && JSON.stringify(rec.periods) === JSON.stringify(LOCKED) && /Acme Leasing/.test(rec.audit.subject || ""));
	}
	{
		const { db, onboarding, complete } = reset();
		onboarding(21, "New Hire", "Acme Leasing", "documents_pending");
		await complete(21);
		const row = dirRow(db, "New Hire");
		check(`§2 a new hire with an investor's company: added with the carrier (got ${row ? JSON.stringify(row.carrier_name) : "no row"})`,
			row && row.carrier_name === "Acme Leasing" && S.recorded.length === 0);
	}

	console.log("§3 drug-test completion (fully onboarded, no row yet)");
	{
		const { db, onboarding, complete } = reset();
		onboarding(30, "Cara Carrier", "Acme Leasing", "documents_signed", "pass");
		await complete(30);
		const row = dirRow(db, "Cara Carrier");
		check("§3 a driver with June loads, an investor's company: added and activated", !!row && row.status === "active");
		check(`§3 …without the carrier (got ${row ? JSON.stringify(row.carrier_name) : "no row"})`, row && row.carrier_name === "");
		check("§3 …recorded as create_driver_pay_blocked", S.recorded.some((x) => blockedAudit(x.audit)));
		check("§3 …fully onboarded", db.prepare("SELECT status FROM driver_onboarding WHERE user_id = 30").get().status === "fully_onboarded");
	}
	{
		const { db, onboarding, complete } = reset();
		onboarding(31, "New Hire", "Acme Leasing", "documents_signed", "pass");
		await complete(31);
		const row = dirRow(db, "New Hire");
		check(`§3 a new hire: added with the carrier (got ${row ? JSON.stringify(row.carrier_name) : "no row"})`, row && row.carrier_name === "Acme Leasing");
	}

	console.log("§4 onboarding completion while Job Tracking cannot be read");
	{
		// A retried signature answers "already signed" and never comes back here,
		// so the completion must not fail: the history reads as undated (every
		// finalized month), the investor's carrier is withheld, and it is audited.
		const { db, onboarding, complete } = reset();
		S.jtFails = true;
		onboarding(40, "New Hire", "Acme Leasing", "documents_pending");
		let threw = null;
		try { await complete(40); } catch (err) { threw = err.message; }
		const row = dirRow(db, "New Hire");
		check(`§4 the completion does not throw (got ${threw || "no error"})`, threw === null);
		check("§4 …the onboarding moves on", db.prepare("SELECT status FROM driver_onboarding WHERE user_id = 40").get().status === "documents_signed");
		check(`§4 …the row is added without the carrier (got ${row ? JSON.stringify(row.carrier_name) : "no row"})`, row && row.carrier_name === "");
		const rec = S.recorded.find((x) => blockedAudit(x.audit));
		check("§4 …and the withheld carrier is recorded over every finalized month",
			!!rec && JSON.stringify(rec.periods) === JSON.stringify(LOCKED));
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
