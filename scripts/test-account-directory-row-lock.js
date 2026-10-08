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
 *   §5 PUT /api/users/:id: the carrier its directory sync writes (the account's
 *      company name) is held the same way, with the same 409 as POST /api/users
 *      (accountDirectorySync() / accountDirectorySyncLock(), 2026-10-08)
 *   §6 PUT /api/users/:id: only a company name that is sent and differs from the
 *      stored one moves the carrier (accountCompanyChange(), 2026-10-08). A
 *      Users-page save of other fields on a driver whose carrier was held back,
 *      or whose row alone names an investor, saves with the carrier and the
 *      ledger untouched; a conflicting company name is still a 409.
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
function liftRoute(head, what) {
	const a = findOnce(`\n${head}`, `registration of ${what}`);
	return SRC.slice(a, SRC.indexOf("\n});", a) + "\n});".length);
}
const USERS_ROUTE = liftRoute('app.post("/api/users", requireRole("Super Admin"), async (req, res) => {', "POST /api/users");
const USER_PUT_ROUTE = liftRoute('app.put("/api/users/:id", requireRole("Super Admin"), async (req, res) => {', "PUT /api/users/:id");

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
	liftNew("accountCompanyChange"),
	liftNew("accountDirectorySync"),
	liftNew("accountDirectorySyncLock"),
	// The investor ledgers' company-name lock the same two routes now judge
	// (scripts/test-investor-company-lock.js); a Driver account moves nobody.
	liftNew("investorAccountState"),
	liftNew("investorCompanyMoves"),
	liftNew("investorCompanyLockBlockers"),
	liftFunction("syncDriverToCarrierSheet"),
	liftFunction("checkAndCompleteOnboarding", "async function"),
].join("\n");
const MODULE_EXPORTS = ["logAudit", "auditText", "normalizeDriverName", "findDriverNameClash", "findDriverNameClashes", "findDirectoryRowForDriver", "syncDriverToCarrierSheet", "checkAndCompleteOnboarding",
	...["accountDirectoryRowJudged", "accountDirectoryRowLock", "accountCompanyChange", "accountDirectorySync", "accountDirectorySyncLock",
		"investorCompanyMoves", "investorCompanyLockBlockers"].filter((n) => SRC.includes(`\nfunction ${n}(`))];

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
	// PUT /api/users/:id with the same month-end lock and directory sync. Its
	// rename machinery (the sheet count, the cascade, the merge scan) and its own
	// lock guard are stubbed to "nothing blocks": §5 edits no driver name.
	let putHandler = null;
	const putEnv = {
		...env,
		app: { put: (p, guard, h) => { putHandler = h; } },
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: [["Load ID", "Driver"]] } }) } } }),
		SPREADSHEET_ID: "not-a-sheet",
		getJobTrackingCached: async () => { S.jtReads++; if (S.jtFails) throw new Error("Job Tracking could not be read"); return JT; },
		recordPeriodRefusal: (audit, code) => S.recorded.push({ audit, code }),
		userUpdateLockBlockers: () => ({ unreadable: false, blockers: [] }),
		periodLabel: (p) => p,
		driverRenameMergeScan: () => ({ mergeTargets: {}, mergeRows: 0 }),
		applyDriverRenameSqlite: () => ({ counts: {} }),
		purgeUserSessions: () => 0,
		refreshOwnSession: () => true,
	};
	const putNames = Object.keys(putEnv);
	new Function(...putNames, USER_PUT_ROUTE)(...putNames.map((k) => putEnv[k]));
	if (typeof putHandler !== "function") die("the lifted PUT /api/users/:id did not register a handler");
	const updateUser = async (id, body) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
		await putHandler({ session: { user: SUPER }, sessionID: "sid", params: { id: String(id) }, query: {}, body }, res);
		return out;
	};
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
	return { db, m, createUser, updateUser, onboarding, complete };
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

	console.log("§5 PUT /api/users/:id: the carrier its directory sync writes");
	{
		// A Driver account, and its drivers_directory row unless `rowCarrier` is null.
		const driverAccount = (db, id, name, company, rowCarrier) => {
			db.prepare("INSERT INTO users (id, username, role, driver_name, email, company_name) VALUES (?, ?, 'Driver', ?, 'd@example.com', ?)").run(id, `u${id}`, name, company);
			if (rowCarrier !== null) db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, status) VALUES (?, ?, 'active')").run(name, rowCarrier);
		};
		const account = (db, id) => db.prepare("SELECT company_name, email, full_name FROM users WHERE id = ?").get(id);
		const refusedLikePost = (r) => r.status === 409 && r.body.code === "PERIOD_FINALIZED" && JSON.stringify(r.body.periods) === JSON.stringify(LOCKED);
		const got = (r) => `got ${r.status} ${(r.body || {}).code || ""}`.trim();
		{
			const { db, updateUser } = reset();
			driverAccount(db, 50, "Cara Carrier", "", "");
			const r = await updateUser(50, { companyName: "Acme Leasing" });
			check(`§5 company → an investor's company, the driver's loads reach June: 409 PERIOD_FINALIZED over ${LOCKED.join(", ")}, as POST /api/users answers (${got(r)})`,
				refusedLikePost(r));
			check("§5 …nothing written: the account keeps no company, the row no carrier",
				account(db, 50).company_name === "" && dirRow(db, "Cara Carrier").carrier_name === "");
			const ref = S.refusals[0] || {};
			check("§5 …refused through POST /api/users's response, naming the account and the carrier",
				/^Cannot update the account for Cara Carrier/.test(ref.what || "") && (ref.blockers || []).some((b) => b.field === "carrier_name"));
			check("§5 …audited as update_user_blocked, naming the carrier", !!ref.audit && ref.audit.action === "update_user_blocked" && /Acme Leasing/.test(ref.audit.subject || ""));
			check(`§5 …the history was read once (reads ${S.jtReads})`, S.jtReads === 1);
		}
		{
			// No directory row yet: the sync would add it with the company as its
			// carrier, the row POST /api/users judges (accountDirectoryRowLock()).
			const { db, updateUser } = reset();
			driverAccount(db, 51, "Cara Carrier", "", null);
			const r = await updateUser(51, { companyName: "Acme Leasing" });
			check(`§5 no directory row yet, company → an investor's company: 409 PERIOD_FINALIZED (${got(r)})`, refusedLikePost(r));
			check("§5 …no row added, the account keeps no company", !dirRow(db, "Cara Carrier") && account(db, 51).company_name === "");
		}
		{
			// The account already names an investor's company and the row does not
			// (a carrier held back at onboarding): an e-mail edit sends no company
			// name, so its sync leaves the carrier alone and nothing is judged (§6).
			const { db, updateUser } = reset();
			driverAccount(db, 52, "Cara Carrier", "Acme Leasing", "");
			const r = await updateUser(52, { email: "new@example.com" });
			check(`§5 an e-mail edit on a driver whose carrier was held back: 200, the row keeps no carrier (${got(r)})`,
				r.status === 200 && account(db, 52).email === "new@example.com" && dirRow(db, "Cara Carrier").carrier_name === "");
		}
		{
			// Off a ledger is a move too: the row carries the investor's company.
			const { db, updateUser } = reset();
			driverAccount(db, 53, "Cara Carrier", "Acme Leasing", "Acme Leasing");
			const r = await updateUser(53, { companyName: "" });
			check(`§5 company cleared while the row puts the driver on an investor's ledger: 409 PERIOD_FINALIZED (${got(r)})`, refusedLikePost(r));
			check("§5 …nothing written", account(db, 53).company_name === "Acme Leasing" && dirRow(db, "Cara Carrier").carrier_name === "Acme Leasing");
		}
		for (const [label, name, company] of [
			["a new hire (no history), an investor's company", "New Hire", "Acme Leasing"],
			["a driver with June loads, a company no investor has", "Cara Carrier", "Cara Trucking LLC"],
		]) {
			const { db, updateUser } = reset();
			driverAccount(db, 54, name, "", "");
			const r = await updateUser(54, { companyName: company });
			check(`§5 ${label}: 200, the account and the row carry ${JSON.stringify(company)} (${got(r)}, row ${JSON.stringify(dirRow(db, name).carrier_name)})`,
				r.status === 200 && account(db, 54).company_name === company && dirRow(db, name).carrier_name === company);
		}
		{
			const { db, updateUser } = reset();
			driverAccount(db, 55, "Cara Carrier", "", "");
			const r = await updateUser(55, { fullName: "Cara C. Carrier" });
			check(`§5 a name-only edit: 200, no Job Tracking read (${got(r)}, reads ${S.jtReads})`,
				r.status === 200 && account(db, 55).full_name === "Cara C. Carrier" && S.jtReads === 0);
		}
		{
			// Job Tracking unreadable: the history cannot be dated, so every finalized
			// month is held, as the create and the directory edit hold it.
			const { db, updateUser } = reset();
			S.jtFails = true;
			driverAccount(db, 56, "New Hire", "", "");
			const r = await updateUser(56, { companyName: "Acme Leasing" });
			check(`§5 Job Tracking unreadable, a new hire → an investor's company: 409 PERIOD_FINALIZED over every finalized month, nothing written (${got(r)})`,
				refusedLikePost(r) && account(db, 56).company_name === "" && dirRow(db, "New Hire").carrier_name === "");
		}
	}

	console.log("§6 PUT /api/users/:id: only a company name that is sent and differs moves the carrier");
	{
		const driverAccount = (db, id, name, company, rowCarrier) => {
			db.prepare("INSERT INTO users (id, username, role, driver_name, email, company_name) VALUES (?, ?, 'Driver', ?, 'd@example.com', ?)").run(id, `u${id}`, name, company);
			if (rowCarrier !== null) db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, status) VALUES (?, ?, 'active')").run(name, rowCarrier);
		};
		const account = (db, id) => db.prepare("SELECT company_name, email, full_name FROM users WHERE id = ?").get(id);
		const history = (db) => db.prepare("SELECT COUNT(*) AS n FROM carrier_driver_history").get().n;
		const blocked = () => S.refusals.length + S.recorded.filter((x) => x.audit && x.audit.action === "update_user_blocked").length;
		const got = (r) => `got ${r.status} ${(r.body || {}).code || ""}`.trim();
		// What the Users page sends on Save (UserTable.vue handleSaveEdit): every
		// field it shows, never a company name.
		const usersPageSave = (name, extra = {}) => ({ role: "Driver", driverName: name, email: "d@example.com", fullName: "Cara C. Carrier", ...extra });
		for (const [label, company, rowCarrier] of [
			["a driver whose carrier was held back at onboarding (account: an investor's company, row: none)", "Acme Leasing", ""],
			["a driver on an investor's ledger through the row only (account: no company, row: the investor's company)", "", "Acme Leasing"],
		]) {
			const { db, updateUser } = reset();
			driverAccount(db, 60, "Cara Carrier", company, rowCarrier);
			const r = await updateUser(60, usersPageSave("Cara Carrier"));
			check(`§6 ${label}: a Users-page save of other fields → 200 (${got(r)})`, r.status === 200);
			check(`§6 …the row's carrier stays ${JSON.stringify(rowCarrier)} and the account's company ${JSON.stringify(company)} (row ${JSON.stringify(dirRow(db, "Cara Carrier").carrier_name)})`,
				dirRow(db, "Cara Carrier").carrier_name === rowCarrier && account(db, 60).company_name === company);
			check("§6 …the other fields are saved", account(db, 60).full_name === "Cara C. Carrier");
			check(`§6 …no ledger write and no lock judged (history rows ${history(db)}, refusals ${blocked()}, reads ${S.jtReads})`,
				history(db) === 0 && blocked() === 0 && S.jtReads === 0);
		}
		{
			// The same company name sent back is not a change.
			const { db, updateUser } = reset();
			driverAccount(db, 61, "Cara Carrier", "Acme Leasing", "");
			const r = await updateUser(61, usersPageSave("Cara Carrier", { companyName: "Acme Leasing" }));
			check(`§6 a held-back driver, the unchanged company name sent back: 200, the row keeps no carrier, no lock read (${got(r)}, row ${JSON.stringify(dirRow(db, "Cara Carrier").carrier_name)}, reads ${S.jtReads})`,
				r.status === 200 && dirRow(db, "Cara Carrier").carrier_name === "" && blocked() === 0 && S.jtReads === 0);
		}
		{
			// Padded with spaces it is still the stored name.
			const { db, updateUser } = reset();
			driverAccount(db, 64, "Cara Carrier", "Acme Leasing", "");
			const r = await updateUser(64, usersPageSave("Cara Carrier", { companyName: "  Acme Leasing " }));
			check(`§6 the stored company name sent back with spaces: 200, the row keeps no carrier, no lock read (${got(r)}, reads ${S.jtReads})`,
				r.status === 200 && dirRow(db, "Cara Carrier").carrier_name === "" && blocked() === 0 && S.jtReads === 0);
		}
		{
			// A case-only change is a change, and is judged; ledger membership
			// compares names case-insensitively, so it moves nothing and is saved.
			const { db, updateUser } = reset();
			driverAccount(db, 65, "Cara Carrier", "Acme Leasing", "Acme Leasing");
			const r = await updateUser(65, usersPageSave("Cara Carrier", { companyName: "acme leasing" }));
			check(`§6 a case-only company change on a driver already on that ledger: judged (reads ${S.jtReads}) and saved, 200, the row re-spelt (${got(r)}, row ${JSON.stringify(dirRow(db, "Cara Carrier").carrier_name)})`,
				r.status === 200 && S.jtReads === 1 && dirRow(db, "Cara Carrier").carrier_name === "acme leasing" && account(db, 65).company_name === "acme leasing");
		}
		{
			// An account with no driver name gets one that has a directory row (the
			// Users page's Linked Driver list offers only those): the save still
			// refreshes that row's e-mail, and judges nothing.
			const { db, updateUser } = reset();
			db.prepare("INSERT INTO users (id, username, role, driver_name, email, company_name) VALUES (67, 'u67', 'Driver', '', 'new@example.com', '')").run();
			db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, email, status) VALUES ('Cara Carrier', 'Acme Leasing', 'old@example.com', 'active')").run();
			const r = await updateUser(67, usersPageSave("Cara Carrier", { email: "new@example.com" }));
			const row = dirRow(db, "Cara Carrier");
			check(`§6 an account given its first driver name, the row exists: 200, the row's e-mail refreshed, its carrier kept, no lock read (${got(r)}, row email ${JSON.stringify(row.email)}, reads ${S.jtReads})`,
				r.status === 200 && row.email === "new@example.com" && row.carrier_name === "Acme Leasing" && S.jtReads === 0);
		}
		{
			// No directory row and no company change: the save adds no row, so
			// onboarding can still add the driver's first row with its carrier judged.
			const { db, updateUser } = reset();
			driverAccount(db, 66, "Cara Carrier", "Acme Leasing", null);
			const r = await updateUser(66, usersPageSave("Cara Carrier"));
			check(`§6 a driver with no directory row, a Users-page save: 200, no row added, no lock read (${got(r)}, row ${dirRow(db, "Cara Carrier") ? "added" : "none"}, reads ${S.jtReads})`,
				r.status === 200 && !dirRow(db, "Cara Carrier") && account(db, 66).full_name === "Cara C. Carrier" && S.jtReads === 0);
		}
		{
			// A company name that differs and would move the driver onto another
			// investor's ledger, for a driver whose loads reach a finalized month.
			const { db, updateUser } = reset();
			db.prepare("INSERT INTO users (id, username, role, company_name) VALUES (8, 'beta', 'Investor', 'Beta Leasing')").run();
			driverAccount(db, 62, "Cara Carrier", "Acme Leasing", "");
			const r = await updateUser(62, usersPageSave("Cara Carrier", { companyName: "Beta Leasing" }));
			check(`§6 a held-back driver with finalized-month history, a conflicting company name: 409 PERIOD_FINALIZED over ${LOCKED.join(", ")} (${got(r)})`,
				r.status === 409 && r.body.code === "PERIOD_FINALIZED" && JSON.stringify(r.body.periods) === JSON.stringify(LOCKED));
			check("§6 …nothing written: company, carrier, other fields and history as they were",
				account(db, 62).company_name === "Acme Leasing" && account(db, 62).full_name === "" && dirRow(db, "Cara Carrier").carrier_name === "" && history(db) === 0);
			check("§6 …audited as update_user_blocked", (S.refusals[0] || {}).audit && S.refusals[0].audit.action === "update_user_blocked");
		}
		{
			// A normal company change for a driver with no finalized-month history.
			const { db, updateUser } = reset();
			driverAccount(db, 63, "New Hire", "", "");
			const r = await updateUser(63, usersPageSave("New Hire", { companyName: "Acme Leasing" }));
			check(`§6 a driver with no finalized-month history, company → an investor's company: 200, the account and the row carry it (${got(r)}, row ${JSON.stringify(dirRow(db, "New Hire").carrier_name)})`,
				r.status === 200 && account(db, 63).company_name === "Acme Leasing" && dirRow(db, "New Hire").carrier_name === "Acme Leasing");
		}
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
