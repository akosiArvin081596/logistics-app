#!/usr/bin/env node
/**
 * Driver-name clash — one helper, normalizeDriverName() semantics, on every path
 * that creates a driver identity.
 *
 * A driver's name is the key the ownership checks match on, and they compare
 * through normalizeDriverName() (trim, lowercase, collapse internal whitespace).
 * findDriverNameClash() answers "is this name already a driver's?" through the
 * same function, so the create-time answer and the ownership answer cannot
 * disagree. Accepting a job application creates a Driver account under the
 * applicant's name and asks it first (409 DRIVER_NAME_TAKEN, nothing written);
 * POST /api/users and POST /api/drivers-directory ask it too.
 *
 * WHAT IS ASSERTED:
 *   §1 findDriverNameClash(), lifted with normalizeDriverName() and run against
 *      an in-memory SQLite: exact, case, outer and internal whitespace, non-ASCII
 *      case, substrings, usernames and reserved names on the account side,
 *      exceptUserId, the table options, blank names and blank stored names, the
 *      return shape; it is read-only and synchronous.
 *   §1b findDriverNameClashes(), the plural the rename paths classify with:
 *      every match in a fixed order, exceptUserIds, exceptDirectoryId, and the
 *      singular as its first match. (The rename paths themselves are
 *      scripts/test-driver-rename-clash.js's subject.)
 *   §2 it agrees with the ownership comparison — driverOwnsInvoice(), lifted —
 *      on every pair in a table of spellings, in both tables.
 *   §3 PUT /api/applications/:id/status "Accepted", the shipped handler lifted
 *      and run: a free name creates the account; a name already in use (an
 *      account's driver name or username, a reserved name, a directory row)
 *      answers 409 DRIVER_NAME_TAKEN, writes no user, onboarding, document or
 *      directory row, leaves the status alone, names nothing about the match and
 *      is audited once; a blank name answers 400; re-accepting answers "already
 *      exists"; a double submit and two applicants under one name each end with
 *      exactly one account; a failure part-way through the writes leaves nothing
 *      behind.
 *   §4 POST /api/users and POST /api/drivers-directory, lifted and run: a
 *      spacing variant is refused, and each route consults only its own side.
 *   §5 source pins: every route that inserts a caller-supplied driver name asks
 *      the helper after its last await and before its INSERT; the helper is
 *      synchronous; no create path keeps a TRIM/LOWER clash query of its own.
 *   §6 the client: a 409 from the accept call surfaces the server's message.
 *   §7 MUTANTS, each of which must be caught by the checks above:
 *      M1a the helper compares with trim + lowercase only (no whitespace collapse)
 *      M1b the helper compares the way SQL TRIM(LOWER(driver_name)) does
 *      M2  acceptance without the check
 *      M3  the password hash moved back below the checks
 *      M4  the helper without its account-namespace check (usernames, reserved)
 *      M5  the accept email's subject quoting the applicant's name uncapped
 *      M6  the helper ignoring exceptDirectoryId
 *      M7  the helper ignoring exceptUserId / exceptUserIds
 *
 * Pure: no server, no app.db, no network, no mail (sendEmail is captured).
 *
 * Run: node scripts/test-driver-name-clash.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }
function record(results) {
	for (const r of results) ok(r.ok, r.name);
	console.log(`  ${results.filter((r) => r.ok).length}/${results.length} checks`);
}

let Database, bcrypt;
try {
	Database = require("better-sqlite3");
	bcrypt = require("bcryptjs");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

// ── lift the shipped code ───────────────────────────────────────────────────
// Anchored on a newline and counted, so a mention in a comment cannot be taken
// for the definition and a second copy fails the run instead of lifting either.
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

const NORM_SRC = liftFunction("normalizeDriverName");
// The singular is the first result of the plural, so both are lifted together.
const CLASH_SRC = [liftFunction("findDriverNameClashes"), liftFunction("findDriverNameClash")].join("\n");
const OWNS_SRC = liftFunction("driverOwnsInvoice");
const ESCAPE_SRC = liftFunction("escapeHtml");
const ACCEPT_SRC = liftRoute('app.put("/api/applications/:id/status", requireRole("Super Admin"), async (req, res) => {');
const USERS_SRC = liftRoute('app.post("/api/users", requireRole("Super Admin"), async (req, res) => {');
const DIRECTORY_SRC = liftRoute('app.post("/api/drivers-directory", requireRole("Super Admin", "Dispatcher"), (req, res) => {');
const ONBOARDING_DOCS = (() => {
	const m = SRC.match(/\nconst ONBOARDING_DOCS = (\[[\s\S]*?\n\]);/);
	if (!m) die("could not locate ONBOARDING_DOCS");
	return new Function(`return ${m[1]};`)();
})();

const normalizeDriverName = new Function(`${NORM_SRC}\nreturn normalizeDriverName;`)();
const driverOwnsInvoice = new Function(`${NORM_SRC}\n${OWNS_SRC}\nreturn driverOwnsInvoice;`)();
const escapeHtml = new Function(`${ESCAPE_SRC}\nreturn escapeHtml;`)();
// auditText() caps and flattens caller text in audit rows; it delegates to
// scrubPurgeMarker(), so both are lifted.
const auditText = new Function(`${liftFunction("scrubPurgeMarker")}\n${liftFunction("auditText")}\nreturn auditText;`)();

// The helper, bound to one database. `normSrc` swaps the comparison for M1a.
function buildClash(db, { normSrc = NORM_SRC, clashSrc = CLASH_SRC } = {}) {
	return new Function("db", `"use strict";\n${normSrc}\n${clashSrc}\nreturn findDriverNameClash;`)(db);
}
// The plural, which rename paths use to classify every match.
function buildClashes(db, { normSrc = NORM_SRC, clashSrc = CLASH_SRC } = {}) {
	return new Function("db", `"use strict";\n${normSrc}\n${clashSrc}\nreturn findDriverNameClashes;`)(db);
}

// M1b: a helper that compares the way SQL TRIM(LOWER(...)) does — case folded
// for ASCII only, spaces trimmed only at the ends, internal whitespace kept —
// with the same options and return shape (driver names only on the account side).
function buildSqlModel(db) {
	return function findDriverNameClash(name, opts = {}) {
		const n = typeof name === "string" ? name.trim() : "";
		if (!n) return null;
		const { exceptUserId = null, users = true, directory = true } = opts || {};
		if (users) {
			const r = exceptUserId == null
				? db.prepare("SELECT id, username, driver_name FROM users WHERE TRIM(LOWER(driver_name)) = ?").get(n.toLowerCase())
				: db.prepare("SELECT id, username, driver_name FROM users WHERE id <> ? AND TRIM(LOWER(driver_name)) = ?").get(Number(exceptUserId), n.toLowerCase());
			if (r) return { source: "users", field: "driver_name", ...r };
		}
		if (directory) {
			const r = db.prepare("SELECT id, driver_name FROM drivers_directory WHERE LOWER(TRIM(driver_name)) = LOWER(TRIM(?))").get(n);
			if (r) return { source: "drivers_directory", ...r };
		}
		return null;
	};
}

// ── fixtures: tables built from server.js's own DDL where it matters ─────────
function tableDdl(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${name}`);
	return `CREATE TABLE ${name} (${m[1]}\n)`;
}
function alterDdl(table, col) {
	const m = SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN ${col} [^"]*`));
	if (!m) die(`could not locate the ${table}.${col} migration`);
	return m[0];
}
const DDL = [
	tableDdl("users"),
	...["full_name", "company_name", "must_change_password", "last_login_at"].map((c) => alterDdl("users", c)),
	tableDdl("job_applications"),
	alterDdl("job_applications", "deleted_at"),
	tableDdl("driver_onboarding"),
	tableDdl("onboarding_documents"),
	// The migrated production shape (UNIQUE COLLATE NOCASE) and the columns the
	// directory route writes. Its constraint is not what is under test.
	`CREATE TABLE drivers_directory (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		driver_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
		carrier_name TEXT DEFAULT '', state TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '',
		address TEXT DEFAULT '', phone TEXT DEFAULT '', cell TEXT DEFAULT '', email TEXT DEFAULT '',
		dot TEXT DEFAULT '', mc TEXT DEFAULT '', trucks TEXT DEFAULT '', hazmat TEXT DEFAULT '',
		rating TEXT DEFAULT '', status TEXT DEFAULT 'active', pay_type TEXT DEFAULT 'fixed',
		pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0
	)`,
];
function makeDb() {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	return db;
}
function addUser(db, id, username, driverName, role = "Driver") {
	db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (?, ?, 'x', ?, ?)")
		.run(id, username, role, driverName);
}
function addDirectory(db, name) {
	return Number(db.prepare("INSERT INTO drivers_directory (driver_name) VALUES (?)").run(name).lastInsertRowid);
}
let appSeq = 0;
function addApplication(db, name, phone) {
	appSeq++;
	return Number(db.prepare(`INSERT INTO job_applications
		(full_name, email, phone, dob, address, ssn, drivers_license, position, experience, has_cdl,
		 work_authorized, felony_convicted, accident_history, skills, signature)
		VALUES (?, ?, ?, '1990-01-01', '1 Main St', '000-00-0000', 'D0000000', 'Company Driver', '5 years',
		 'Yes', 'Yes', 'No', 'No', 'Flatbed', 'signed')`)
		.run(name, `applicant${appSeq}@example.test`, phone).lastInsertRowid);
}
const appStatus = (db, id) => (db.prepare("SELECT status FROM job_applications WHERE id = ?").get(id) || {}).status;
const counts = (db) => JSON.stringify(["users", "driver_onboarding", "onboarding_documents", "drivers_directory"]
	.map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n));
const accountsNamed = (db, name) => db.prepare("SELECT driver_name FROM users").all()
	.filter((r) => normalizeDriverName(r.driver_name || "") === normalizeDriverName(name)).length;
const show = (s) => String(JSON.stringify(s)).replace(/\u00a0/g, "\\u00a0");

// The route's catch logs to console.error, which is expected noise when a
// mutant or an injected failure answers 500.
async function quiet(fn) {
	const e = console.error;
	console.error = () => {};
	try { return await fn(); } finally { console.error = e; }
}

// ─────────────────────────────── §1 the helper
function helperBattery(build) {
	const results = [];
	const t = (name, cond) => results.push({ name, ok: !!cond });
	const db = makeDb();
	addUser(db, 1, "super_admin", "", "Super Admin");
	db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (2, 'dispatch1', 'x', 'Dispatcher', NULL)").run();
	addUser(db, 3, "sking", "Shorn King");
	addUser(db, 4, "jsmith", "John Smith");
	addUser(db, 5, "jnunez", "José Núñez");
	addUser(db, 6, "blankish", "   ");
	addDirectory(db, "Shorn King"); // row 1 — that account's own row
	addDirectory(db, "Deshorn King"); // row 2 — in the directory, no account
	addDirectory(db, "Maria Lopez"); // row 3 — in the directory, no account
	const find = build(db);
	const tag = (r) => (!r ? "null" : r.source === "reserved" ? `reserved:${r.name}` : `${r.source}:${r.id}`);
	const expect = (label, name, opts, want) => {
		let got;
		try { got = tag(find(name, opts)); } catch (e) { got = `threw ${e.message}`; }
		t(`${label}: ${show(name)}${opts ? ` ${JSON.stringify(opts)}` : ""} → ${want} (got ${got})`, got === want);
	};

	expect("exact name", "Shorn King", undefined, "users:3");
	expect("case variant", "SHORN KING", undefined, "users:3");
	expect("outer whitespace", "  Shorn King  ", undefined, "users:3");
	expect("internal double space", "Shorn  King", undefined, "users:3");
	expect("internal tab", "Shorn\tKing", undefined, "users:3");
	expect("internal no-break space", "Shorn\u00a0King", undefined, "users:3");
	expect("case and spacing together", "  sHORN   kING ", undefined, "users:3");
	expect("non-ASCII case", "JOSÉ NÚÑEZ", undefined, "users:5");
	expect("a driver in the directory with no account", "Deshorn King", undefined, "drivers_directory:2");
	expect("...spacing and case variant", "deshorn   KING", undefined, "drivers_directory:2");
	expect("a different name", "Shorn Kingston", undefined, "null");
	expect("part of an existing name", "Horn King", undefined, "null");
	expect("an existing name plus more", "Shorn King Jr", undefined, "null");
	expect("whitespace removed is a different name", "ShornKing", undefined, "null");

	// The account side is wider than driver names: every username, and the
	// reserved names.
	expect("an account's username (a Dispatcher with no driver name)", "Dispatch1", undefined, "users:2");
	expect("a driver's own username", "  SKING ", undefined, "users:3");
	expect("reserved name", "Dispatch", undefined, "reserved:dispatch");
	expect("reserved name, case and spacing", "  INVESTOR ", undefined, "reserved:investor");
	expect("a reserved name plus more is a different name", "Dispatch Smith", undefined, "null");
	t("a username match says so: field \"username\"", (find("dispatch1") || {}).field === "username");
	t("a driver-name match says so: field \"driver_name\"", (find("shorn king") || {}).field === "driver_name");

	expect("users:false leaves accounts out", "Shorn King", { users: false }, "drivers_directory:1");
	expect("users:false leaves usernames out", "dispatch1", { users: false }, "null");
	expect("users:false leaves the reserved names out", "Dispatch", { users: false }, "null");
	expect("directory:false leaves the directory out", "Maria Lopez", { directory: false }, "null");
	expect("users:false still finds a directory-only driver", "Maria Lopez", { users: false }, "drivers_directory:3");
	expect("both sides off checks nothing", "Shorn King", { users: false, directory: false }, "null");

	expect("exceptUserId skips that account; the directory is still checked", "Shorn King", { exceptUserId: 3 }, "drivers_directory:1");
	expect("exceptUserId skips that account", "shorn  king", { exceptUserId: 3, directory: false }, "null");
	expect("exceptUserId skips that account's username too", "sking", { exceptUserId: 3, directory: false }, "null");
	expect("exceptUserId never skips a reserved name", "Dispatch", { exceptUserId: 3 }, "reserved:dispatch");
	expect("exceptUserId as a numeric string", "Shorn King", { exceptUserId: "3", directory: false }, "null");
	expect("exceptUserId of another account still reports this one", "Shorn King", { exceptUserId: 4, directory: false }, "users:3");

	for (const [label, v] of [["empty", ""], ["whitespace only", "  \t "], ["null", null], ["undefined", undefined],
		["a number", 42], ["an array", ["Shorn King"]], ["an object", { driverName: "Shorn King" }]]) {
		expect(`a blank or non-string name (${label}) never clashes`, v, undefined, "null");
	}
	expect("blank and NULL stored names (non-driver accounts) never match", "Anyone At All", undefined, "null");

	t("return shape for an account: { source, field, id, username, driver_name }",
		JSON.stringify(find("john smith")) === JSON.stringify({ source: "users", field: "driver_name", id: 4, username: "jsmith", driver_name: "John Smith" }));
	t("return shape for a directory row: { source, id, driver_name }",
		JSON.stringify(find("MARIA LOPEZ")) === JSON.stringify({ source: "drivers_directory", id: 3, driver_name: "Maria Lopez" }));
	t("return shape for a reserved name: { source, name }",
		JSON.stringify(find("dispatch")) === JSON.stringify({ source: "reserved", name: "dispatch" }));

	const before = db.prepare("SELECT total_changes() AS n").get().n;
	const ret = find("Shorn King");
	t("synchronous: the answer is a value, not a promise", ret !== null && typeof ret === "object" && typeof ret.then !== "function");
	find("Nobody Here"); find("Deshorn King", { exceptUserId: 3 });
	t("read-only: asking writes nothing", db.prepare("SELECT total_changes() AS n").get().n === before);

	addUser(db, 9, "jsmith2", "JOHN SMITH");
	expect("two accounts already share a name: the lowest id is reported", "John Smith", undefined, "users:4");
	return results;
}

// ─────────────────────────────── §2 agreement with the ownership comparison
const SPELLINGS = [
	// [stored, candidate]
	["John Smith", "John Smith"],
	["John Smith", "john smith"],
	["John Smith", "JOHN SMITH"],
	["John Smith", "  John Smith "],
	["John Smith", "John  Smith"],
	["John Smith", "John \t Smith"],
	["John Smith", "John\u00a0Smith"],
	["John  Smith", "john smith"],
	["José Núñez", "JOSÉ NÚÑEZ"],
	["Shorn King", "Deshorn King"],
	["Deshorn King", "Shorn King"],
	["John Smith", "Jon Smith"],
	["John Smith", "JohnSmith"],
	["John Smith", "John Smith Jr"],
];
function agreementBattery(build) {
	const results = [];
	for (const table of ["users", "drivers_directory"]) {
		for (const [stored, candidate] of SPELLINGS) {
			const db = makeDb();
			if (table === "users") addUser(db, 7, "u7", stored);
			else addDirectory(db, stored);
			const clash = build(db)(candidate) !== null;
			const owns = driverOwnsInvoice({ role: "Driver", driverName: candidate }, { driver: stored });
			results.push({
				name: `${table}: stored ${show(stored)}, asked ${show(candidate)} — clash ${clash}, ownership match ${owns}`,
				ok: clash === owns,
			});
		}
	}
	return results;
}

// ─────────────────────────────── §3 the acceptance route
function mountAccept(db, { routeSrc = ACCEPT_SRC, docs = ONBOARDING_DOCS, clashSrc = CLASH_SRC } = {}) {
	const log = { audits: [], notified: [], mail: [] };
	let handler = null;
	const env = {
		app: { put: (p, guard, h) => { handler = h; } },
		requireRole: () => (req, res, next) => next(),
		db,
		// The real bcryptjs at cost 4 (the route asks for 10): a real hash, and a
		// real yield — which is what lets two calls interleave like two requests.
		bcrypt: { hash: (pw) => bcrypt.hash(pw, 4) },
		crypto,
		logAudit: (req, action, entity, entityId, details) => log.audits.push({ action, entity, entityId, details }),
		auditText,
		notifyChange: (domain) => log.notified.push(domain),
		ONBOARDING_DOCS: docs,
		escapeHtml,
		sendEmail: (to, subject) => { log.mail.push({ to, subject }); return Promise.resolve(true); },
		findDriverNameClash: buildClash(db, { clashSrc }),
	};
	const names = Object.keys(env);
	new Function(...names, routeSrc)(...names.map((k) => env[k]));
	if (typeof handler !== "function") die("the lifted acceptance route did not register a handler");
	// Synchronous up to the handler call, so two calls started together
	// interleave exactly as two requests do: each runs until its first await.
	const call = (appId, status = "Accepted") => {
		const out = { status: 200, body: null };
		const res = {
			status(c) { out.status = c; return this; },
			json(b) { out.body = b; return this; },
		};
		return handler({
			params: { id: String(appId) }, body: { status },
			session: { user: { id: 1, username: "super_admin", role: "Super Admin" } },
		}, res).then(() => out);
	};
	return { call, log };
}
function acceptFixture() {
	const db = makeDb();
	addUser(db, 1, "super_admin", "", "Super Admin");
	addUser(db, 2, "sking", "Shorn King");
	addUser(db, 3, "kevin", "", "Dispatcher");
	addDirectory(db, "Shorn King"); // that account's own row
	addDirectory(db, "Deshorn King"); // a driver in the directory with no account
	return db;
}

async function acceptBattery({ routeSrc = ACCEPT_SRC, clashSrc = CLASH_SRC } = {}) {
	const results = [];
	const t = (name, cond) => results.push({ name, ok: !!cond });

	// A free name: the account, its onboarding rows, the status, as before.
	{
		const db = acceptFixture();
		const appId = addApplication(db, "Ava Brooks", "713-555-0111");
		const { call, log } = mountAccept(db, { routeSrc, clashSrc });
		const r = await quiet(() => call(appId));
		const creds = (r.body && r.body.credentials) || {};
		const u = db.prepare("SELECT * FROM users WHERE id = ?").get(creds.userId) || {};
		t("a free name is accepted: 200 with a new account", r.status === 200 && r.body && r.body.accountCreated === true);
		t("...a Driver under the applicant's name, forced to change its password",
			u.role === "Driver" && u.driver_name === "Ava Brooks" && u.must_change_password === 1);
		t("...with its onboarding row and every onboarding document",
			db.prepare("SELECT COUNT(*) AS n FROM driver_onboarding WHERE user_id = ? AND application_id = ?").get(creds.userId, appId).n === 1 &&
			db.prepare("SELECT COUNT(*) AS n FROM onboarding_documents WHERE user_id = ?").get(creds.userId).n === ONBOARDING_DOCS.length);
		t("...and the application marked Accepted", appStatus(db, appId) === "Accepted");
		t("...audited, announced and mailed as before, with no refusal",
			log.audits.some((a) => a.action === "accept_application") && !log.audits.some((a) => a.action === "accept_application_blocked") &&
			["applications", "users", "drivers"].every((d) => log.notified.includes(d)) && log.mail.length === 2);
	}

	// The success audit quotes the applicant's name capped and on one line.
	{
		const db = acceptFixture();
		const appId = addApplication(db, `Ava\nBrooks ${"x".repeat(300)}`, "713-555-0112");
		const { call, log } = mountAccept(db, { routeSrc, clashSrc });
		await quiet(() => call(appId));
		const row = log.audits.find((a) => a.action === "accept_application");
		t("the success audit quotes the name capped and on one line",
			!!row && !/[\r\n]/.test(row.details) && row.details.length < 220);
		const adminMail = log.mail.find((m) => m.to === "info@logisx.com");
		t("the admin email's subject quotes the name the same way: capped and on one line",
			!!adminMail && adminMail.subject.startsWith("Driver Accepted: Ava Brooks") && !/[\r\n]/.test(adminMail.subject) &&
			adminMail.subject.length <= "Driver Accepted: ".length + 120);
	}

	// Names that are already in use: an account's driver name or username, a
	// reserved name, or a directory-only row.
	for (const [label, name, matched, forbidden] of [
		["an account's name, exactly", "Shorn King", "the driver name of user 2", /sking|shorn|\d/i],
		["an account's name, case and spacing changed", "  shorn   KING ", "the driver name of user 2", /sking|shorn|\d/i],
		["a directory-only driver's name, case changed", "DESHORN KING", "drivers_directory row 2", /deshorn|\d/i],
		["a directory-only driver's name, tab inside", "Deshorn\tKing", "drivers_directory row 2", /deshorn|\d/i],
		["an account's username", "Kevin", "the username of user 3", /kevin|\d/i],
		["a reserved name", "dispatch", "a reserved name", /\d/],
		["a reserved name, case and spacing", " Investor ", "a reserved name", /\d/],
	]) {
		const db = acceptFixture();
		const appId = addApplication(db, name, "713-555-0122");
		const before = counts(db);
		const { call, log } = mountAccept(db, { routeSrc, clashSrc });
		const r = await quiet(() => call(appId));
		const body = r.body || {};
		const refusals = log.audits.filter((a) => a.action === "accept_application_blocked");
		t(`${label}: 409 DRIVER_NAME_TAKEN`, r.status === 409 && body.code === "DRIVER_NAME_TAKEN");
		t(`${label}: no user, onboarding, document or directory row is written`, counts(db) === before);
		t(`${label}: the application's status is left as it was`, appStatus(db, appId) === "New");
		t(`${label}: the body is { error, code } and names nothing about the match`,
			JSON.stringify(Object.keys(body)) === JSON.stringify(["error", "code"]) &&
			typeof body.error === "string" && !forbidden.test(body.error));
		t(`${label}: the refusal is audited once, under its own action and code, naming the match`,
			refusals.length === 1 && String(refusals[0].entityId) === String(appId) &&
			String(refusals[0].details).includes(matched) && String(refusals[0].details).includes("[DRIVER_NAME_TAKEN]"));
		t(`${label}: no success audit, no change notification, no email`,
			log.audits.length === 1 && log.notified.length === 0 && log.mail.length === 0);
	}

	// A blank name is refused before anything is asked or written.
	{
		const db = acceptFixture();
		const appId = addApplication(db, "   ", "713-555-0133");
		const before = counts(db);
		const { call, log } = mountAccept(db, { routeSrc, clashSrc });
		const r = await quiet(() => call(appId));
		t("a blank applicant name: 400 DRIVER_NAME_REQUIRED", r.status === 400 && r.body && r.body.code === "DRIVER_NAME_REQUIRED");
		t("...nothing written, the status left alone, no email",
			counts(db) === before && appStatus(db, appId) === "New" && log.mail.length === 0);
	}

	// Re-accepting is not a clash with the account this application created.
	{
		const db = acceptFixture();
		const appId = addApplication(db, "Ava Brooks", "713-555-0144");
		const { call } = mountAccept(db, { routeSrc, clashSrc });
		const r1 = await quiet(() => call(appId));
		const r2 = await quiet(() => call(appId));
		t("re-accepting an accepted application answers \"already exists\", not a clash with its own account",
			r1.status === 200 && r2.status === 200 && r2.body && /already exists/.test(r2.body.message || ""));
		t("...and still leaves exactly one account", accountsNamed(db, "Ava Brooks") === 1);
	}

	// A double submit: two accepts of one application, started together.
	{
		const db = acceptFixture();
		const appId = addApplication(db, "Ava Brooks", "713-555-0155");
		const { call } = mountAccept(db, { routeSrc, clashSrc });
		const rs = await quiet(() => Promise.all([call(appId), call(appId)]));
		const created = rs.filter((r) => r.status === 200 && r.body && r.body.accountCreated).length;
		const already = rs.filter((r) => r.status === 200 && r.body && /already exists/.test(r.body.message || "")).length;
		t(`a double-submitted accept: one creates the account, the other answers "already exists" (got ${rs.map((r) => r.status).join("/")})`,
			created === 1 && already === 1);
		t("...one account, one onboarding row",
			accountsNamed(db, "Ava Brooks") === 1 &&
			db.prepare("SELECT COUNT(*) AS n FROM driver_onboarding WHERE application_id = ?").get(appId).n === 1);
	}

	// Two applicants under one name, accepted together.
	{
		const db = acceptFixture();
		const a = addApplication(db, "Ava Brooks", "713-555-0166");
		const b = addApplication(db, "AVA  BROOKS", "713-555-0177");
		const { call } = mountAccept(db, { routeSrc, clashSrc });
		const rs = await quiet(() => Promise.all([call(a), call(b)]));
		t(`two applicants with one name, accepted together: one account and one 409 DRIVER_NAME_TAKEN (got ${rs.map((r) => r.status).join("/")})`,
			rs.filter((r) => r.status === 200 && r.body && r.body.accountCreated).length === 1 &&
			rs.filter((r) => r.status === 409 && r.body && r.body.code === "DRIVER_NAME_TAKEN").length === 1);
		t("...exactly one account under that name", accountsNamed(db, "ava brooks") === 1);
	}

	// Every other status is written as before, whatever the name.
	for (const status of ["Reviewed", "Rejected", "New"]) {
		const db = acceptFixture();
		const appId = addApplication(db, "Shorn King", "713-555-0188");
		if (status === "New") db.prepare("UPDATE job_applications SET status = 'Reviewed' WHERE id = ?").run(appId);
		const before = counts(db);
		const { call, log } = mountAccept(db, { routeSrc, clashSrc });
		const r = await quiet(() => call(appId, status));
		t(`status "${status}" is written and creates nothing (even under a taken name)`,
			r.status === 200 && appStatus(db, appId) === status && counts(db) === before &&
			!log.audits.some((a) => a.action === "accept_application_blocked"));
	}

	// An unknown application.
	{
		const db = acceptFixture();
		const before = counts(db);
		const { call } = mountAccept(db, { routeSrc, clashSrc });
		const r = await quiet(() => call(999));
		t("an unknown application: 404 and nothing written", r.status === 404 && counts(db) === before);
	}

	// A failure part-way through the writes: the onboarding INSERT is made to
	// throw AFTER the account row was written. All of it must roll back — an
	// account left behind would hold the name and refuse the retry.
	{
		const db = acceptFixture();
		const appId = addApplication(db, "Ava Brooks", "713-555-0199");
		const before = counts(db);
		db.exec("CREATE TRIGGER clash_test_fail BEFORE INSERT ON driver_onboarding BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
		const r = await quiet(() => mountAccept(db, { routeSrc, clashSrc }).call(appId));
		db.exec("DROP TRIGGER clash_test_fail");
		t("a failure part-way through the writes: 500, and every write is rolled back",
			r.status === 500 && counts(db) === before && appStatus(db, appId) === "New");
		const retry = await quiet(() => mountAccept(db, { routeSrc, clashSrc }).call(appId));
		t(`...so the retry succeeds (got ${retry.status} ${retry.body && (retry.body.code || retry.body.message || "")})`,
			retry.status === 200 && retry.body && retry.body.accountCreated === true);
	}
	return results;
}

// ─────────────────────────────── §4 the other two create paths
function mountPost(routeSrc, db, clashSrc = CLASH_SRC) {
	const log = { synced: [] };
	let handler = null;
	const env = {
		app: { post: (p, guard, h) => { handler = h; } },
		requireRole: () => (req, res, next) => next(),
		db,
		bcrypt: { hash: (pw) => bcrypt.hash(pw, 4) },
		findDriverNameClash: buildClash(db, { clashSrc }),
		syncDriverToCarrierSheet: (name, opts) => log.synced.push({ name, opts }),
		syncCarrierDriverHistory: () => {},
		logAudit: () => {},
		notifyChange: () => {},
	};
	const names = Object.keys(env);
	new Function(...names, routeSrc)(...names.map((k) => env[k]));
	if (typeof handler !== "function") die("a lifted create route did not register a handler");
	const call = (body) => {
		const out = { status: 200, body: null };
		const res = {
			status(c) { out.status = c; return this; },
			json(b) { out.body = b; return this; },
		};
		return Promise.resolve(handler({ body, session: { user: { id: 1, username: "super_admin", role: "Super Admin" } } }, res))
			.then(() => out);
	};
	return { call, log };
}

async function otherCreatePaths({ clashSrc = CLASH_SRC } = {}) {
	const results = [];
	const t = (name, cond) => results.push({ name, ok: !!cond });

	{
		const db = makeDb();
		addUser(db, 1, "super_admin", "", "Super Admin");
		addUser(db, 2, "sking", "Shorn King");
		addUser(db, 3, "kevin", "", "Dispatcher");
		addDirectory(db, "Deshorn King"); // in the directory, no account
		const { call } = mountPost(USERS_SRC, db, clashSrc);
		const r1 = await call({ username: "sking2", password: "pw-123456", role: "Driver", driverName: "shorn  KING" });
		t("POST /api/users: a case/spacing variant of an account's driver name is 409 DRIVER_NAME_TAKEN",
			r1.status === 409 && r1.body && r1.body.code === "DRIVER_NAME_TAKEN" && r1.body.conflictUserId === 2);
		t("...and creates no account", !db.prepare("SELECT 1 FROM users WHERE username = 'sking2'").get());
		const r5 = await call({ username: "kev2", password: "pw-123456", role: "Driver", driverName: "KEVIN" });
		t("POST /api/users: another account's username is 409 DRIVER_NAME_TAKEN, and the message says it is a username",
			r5.status === 409 && r5.body && r5.body.code === "DRIVER_NAME_TAKEN" && r5.body.conflictUserId === 3 &&
			/username of kevin/.test(r5.body.error || ""));
		const r6 = await call({ username: "desk", password: "pw-123456", role: "Driver", driverName: " Dispatch " });
		t("POST /api/users: a reserved name is 409 DRIVER_NAME_TAKEN, \"that name is reserved\"",
			r6.status === 409 && r6.body && r6.body.code === "DRIVER_NAME_TAKEN" && /reserved/.test(r6.body.error || "") &&
			r6.body.conflictUserId === undefined);
		t("...neither creates an account", !db.prepare("SELECT 1 FROM users WHERE username IN ('kev2', 'desk')").get());
		const r2 = await call({ username: "dking", password: "pw-123456", role: "Driver", driverName: "Deshorn King" });
		t("POST /api/users: a driver already in the directory can be given a login (accounts only)",
			r2.status === 200 && !!db.prepare("SELECT 1 FROM users WHERE username = 'dking' AND driver_name = 'Deshorn King'").get());
		const r3 = await call({ username: "abrooks", password: "pw-123456", role: "Driver", driverName: "Ava Brooks" });
		t("POST /api/users: a free driver name is created", r3.status === 200);
		const r4 = await call({ username: "dispatch2", password: "pw-123456", role: "Dispatcher", driverName: "" });
		t("POST /api/users: a blank driver name (a non-driver account) is no clash", r4.status === 200);
		const r7 = await call({ username: "Lee Park", password: "pw-123456", role: "Driver", driverName: "Lee Park" });
		t("POST /api/users: a driver name equal to the new account's own username is no clash", r7.status === 200);
	}

	{
		const db = makeDb();
		addUser(db, 1, "super_admin", "", "Super Admin");
		addUser(db, 2, "jhill", "Jonas Hill"); // an account whose directory row does not exist yet
		const shornRow = addDirectory(db, "Shorn King");
		const { call } = mountPost(DIRECTORY_SRC, db, clashSrc);
		const post = (name) => call({ headers: ["Driver"], values: [name] });
		const d1 = await post("SHORN  KING");
		t("POST /api/drivers-directory: a case/spacing variant is 409 DRIVER_EXISTS naming the existing row",
			d1.status === 409 && d1.body && d1.body.code === "DRIVER_EXISTS" && d1.body.id === shornRow);
		const d2 = await post("  Shorn King  ");
		t("POST /api/drivers-directory: outer whitespace is refused too", d2.status === 409 && d2.body && d2.body.code === "DRIVER_EXISTS");
		t("...and no second row was written", db.prepare("SELECT COUNT(*) AS n FROM drivers_directory").get().n === 1);
		const d3 = await post("Jonas Hill");
		t("POST /api/drivers-directory: a name only an account holds is created — it is that account's row (directory only)",
			d3.status === 200 && !!db.prepare("SELECT 1 FROM drivers_directory WHERE driver_name = 'Jonas Hill'").get());
		const d4 = await post("Brand New");
		t("POST /api/drivers-directory: a free name is created", d4.status === 200);
		const d5 = await post("   ");
		t("POST /api/drivers-directory: a blank name is still 400 DRIVER_NAME_REQUIRED",
			d5.status === 400 && d5.body && d5.body.code === "DRIVER_NAME_REQUIRED");
	}
	return results;
}

// ─────────────────────────────── §5 source pins
function sourcePins() {
	ok(!/\basync\b|\bawait\b|\.then\(/.test(CLASH_SRC), "§5 findDriverNameClash() must be synchronous: no async, await or .then");
	ok(/normalizeDriverName\(/.test(CLASH_SRC), "§5 findDriverNameClash() must compare through normalizeDriverName()");

	for (const [label, src, insertMarker] of [
		["PUT /api/applications/:id/status", ACCEPT_SRC, '"INSERT INTO users ('],
		["POST /api/users", USERS_SRC, '"INSERT INTO users ('],
		["POST /api/drivers-directory", DIRECTORY_SRC, "INSERT INTO drivers_directory ("],
	]) {
		const askAt = src.indexOf("findDriverNameClash(");
		const insertAt = src.indexOf(insertMarker);
		ok(askAt > 0, `§5 ${label} must ask findDriverNameClash()`);
		ok(askAt > 0 && insertAt > askAt, `§5 ${label} must ask before its INSERT`);
		ok(askAt > 0 && insertAt > askAt && !/\bawait\b/.test(src.slice(askAt, insertAt)),
			`§5 ${label}: no await between asking and the INSERT`);
		ok(!/(TRIM\(LOWER\(|LOWER\(TRIM\()\s*driver_name/.test(src), `§5 ${label} must keep no TRIM/LOWER clash query of its own`);
	}

	// Every INSERT that binds a caller-supplied users.driver_name sits in a route
	// that asks first — so a third such route cannot quietly skip it.
	const sites = [];
	const re = /"INSERT INTO users \(([^)]*)\) VALUES \(([^)]*)\)/g;
	for (let m = re.exec(SRC); m; m = re.exec(SRC)) {
		const cols = m[1].split(",").map((s) => s.trim());
		const vals = m[2].split(",").map((s) => s.trim());
		const i = cols.indexOf("driver_name");
		if (i >= 0 && vals[i] === "?") sites.push(m.index);
	}
	ok(sites.length === 2, `§5 expected the 2 known INSERTs of a caller-supplied users.driver_name (acceptance, POST /api/users), found ${sites.length} — a new one must ask findDriverNameClash(); update this count once it does`);
	for (const at of sites) {
		const start = SRC.lastIndexOf("\napp.", at);
		const head = SRC.slice(start + 1, SRC.indexOf("\n", start + 1));
		const end = SRC.indexOf("\n});", start);
		ok(start >= 0 && end > at && SRC.slice(start, at).includes("findDriverNameClash("),
			`§5 ${head}: inserts a users.driver_name without asking findDriverNameClash() first`);
	}
	console.log(`  source pins checked (${sites.length} users.driver_name INSERT sites)`);
}

// ─────────────────────────────── §6 the client shows the server's message
async function clientSection() {
	const body = { error: "Not accepted: a driver with this name already exists. Nothing was changed.", code: "DRIVER_NAME_TAKEN" };
	const { useApi } = await import(pathToFileURL(path.join(ROOT, "client", "src", "composables", "useApi.js")).href);
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => body });
	let err = null;
	try { await useApi().put("/api/applications/7/status", { status: "Accepted" }); } catch (e) { err = e; } finally { globalThis.fetch = realFetch; }
	ok(!!err && err.message === body.error && err.status === 409 && err.code === "DRIVER_NAME_TAKEN",
		`§6 useApi must reject a 409 with the server's own message and code (got ${err && JSON.stringify({ message: err.message, status: err.status, code: err.code })})`);

	const view = fs.readFileSync(path.join(ROOT, "client", "src", "views", "ApplicationsView.vue"), "utf8");
	const a = view.indexOf("async function updateStatus(");
	const fn = a >= 0 ? view.slice(a, view.indexOf("\n}\n", a) + 2) : "";
	ok(fn.includes("api.put(`/api/applications/${id}/status`"), "§6 the accept call must live in ApplicationsView's updateStatus()");
	ok(/catch \(err\) \{\s*toast\(err\.message, 'error'\)/.test(fn),
		"§6 updateStatus()'s catch must toast err.message — the server's own text — not a fixed string");
	console.log("  client checked");
}

// ─────────────────────────────── §7 mutants
async function mutants() {
	const caught = (label, results) => {
		const bad = results.filter((r) => !r.ok);
		ok(bad.length > 0, `§7 ${label} was NOT caught — the checks above have lost their teeth`);
		console.log(`  ${label}: caught by ${bad.length} check(s), e.g.`);
		for (const r of bad.slice(0, 3)) console.log(`      ✗ ${r.name}`);
	};

	const TRIM_LOWER_NORM = "function normalizeDriverName(s) {\n\treturn (s || \"\").trim().toLowerCase();\n}\n";
	const m1a = (db) => buildClash(db, { normSrc: TRIM_LOWER_NORM });
	caught("M1a helper compares with trim + lowercase only", [...helperBattery(m1a), ...agreementBattery(m1a)]);
	caught("M1b helper compares like SQL TRIM(LOWER(driver_name))", [...helperBattery(buildSqlModel), ...agreementBattery(buildSqlModel)]);

	const ASK = "const clash = findDriverNameClash(fullName);";
	ok(ACCEPT_SRC.includes(ASK), `§7 M2 marker moved: ${ASK}`);
	caught("M2 acceptance without the check", await acceptBattery({ routeSrc: ACCEPT_SRC.replace(ASK, "const clash = null;") }));

	const HASH_RE = /\n\t+const tempPassword = crypto\.randomBytes\(4\)\.toString\("hex"\);[^\n]*\n\t+const hash = await bcrypt\.hash\(tempPassword, 10\);/;
	const TX = "const userId = db.transaction(";
	ok(HASH_RE.test(ACCEPT_SRC) && ACCEPT_SRC.includes(TX), "§7 M3 markers moved (the hash lines or the transaction)");
	const m3 = ACCEPT_SRC.replace(HASH_RE, "").replace(TX,
		"const tempPassword = crypto.randomBytes(4).toString(\"hex\");\n\t\t\tconst hash = await bcrypt.hash(tempPassword, 10);\n\t\t\t" + TX);
	caught("M3 password hash moved below the checks", await acceptBattery({ routeSrc: m3 }));

	const RESERVED_LINES = /\n\t+for \(const r of RESERVED_NAMES\) if \(same\(r\)\) hits\.push\(\{ source: "reserved", name: r \}\);/;
	const USERNAME_ARM = 'same(r.driver_name) ? "driver_name" : same(r.username) ? "username" : ""';
	ok(RESERVED_LINES.test(CLASH_SRC) && CLASH_SRC.includes(USERNAME_ARM), "§7 M4 markers moved (the reserved-name lines or the username arm)");
	const m4 = CLASH_SRC.replace(RESERVED_LINES, "").replace(USERNAME_ARM, 'same(r.driver_name) ? "driver_name" : ""');
	caught("M4 helper without its account-namespace check (usernames, reserved names)", [
		...helperBattery((db) => buildClash(db, { clashSrc: m4 })),
		...await acceptBattery({ clashSrc: m4 }),
		...await otherCreatePaths({ clashSrc: m4 }),
	]);

	const SUBJECT = "`Driver Accepted: ${auditText(fullName, 120)}`";
	ok(ACCEPT_SRC.includes(SUBJECT), `§7 M5 marker moved: ${SUBJECT}`);
	caught("M5 the accept email's subject quotes the name uncapped", await acceptBattery({ routeSrc: ACCEPT_SRC.replace(SUBJECT, "`Driver Accepted: ${fullName}`") }));

	const SKIP_DIRECTORY_ROW = "if (skipDirectoryId !== null && r.id === skipDirectoryId) continue;";
	const SKIP_ACCOUNTS = "if (skipUsers.has(r.id)) continue;";
	ok(CLASH_SRC.includes(SKIP_DIRECTORY_ROW) && CLASH_SRC.includes(SKIP_ACCOUNTS), "§7 M6/M7 markers moved (the two skip lines)");
	caught("M6 helper ignores exceptDirectoryId", pluralBattery((db) => buildClashes(db, { clashSrc: CLASH_SRC.replace(SKIP_DIRECTORY_ROW, "") })));
	caught("M7 helper ignores exceptUserId / exceptUserIds", pluralBattery((db) => buildClashes(db, { clashSrc: CLASH_SRC.replace(SKIP_ACCOUNTS, "") })));
}

// ─────────────────────────────── §1b the plural and the skip options
function pluralBattery(build) {
	const results = [];
	const t = (name, cond) => results.push({ name, ok: !!cond });
	const db = makeDb();
	addUser(db, 1, "super_admin", "", "Super Admin");
	addUser(db, 2, "shorn king", "", "Dispatcher"); // a username that folds onto the name
	addUser(db, 3, "sking", "Shorn King");
	addUser(db, 4, "sking2", "SHORN  KING");
	addDirectory(db, "Shorn King"); // row 1
	addDirectory(db, "Deshorn King"); // row 2
	const all = build(db);
	const tags = (hits) => hits.map((h) => (h.source === "reserved" ? `reserved:${h.name}` : `${h.source}:${h.id}${h.field ? `:${h.field}` : ""}`)).join(",");
	const run = (name, opts) => { try { return tags(all(name, opts)); } catch (e) { return `threw ${e.message}`; } };
	const expect = (label, got, want) => t(`${label} → ${want} (got ${got})`, got === want);
	expect("every match, in a fixed order: accounts by id, then directory rows", run("  shorn   KING"),
		"users:2:username,users:3:driver_name,users:4:driver_name,drivers_directory:1");
	expect("a reserved name comes first", run("Dispatch"), "reserved:dispatch");
	expect("exceptUserIds skips several accounts", run("Shorn King", { exceptUserIds: [3, 4] }), "users:2:username,drivers_directory:1");
	expect("exceptUserIds accepts numeric strings", run("Shorn King", { exceptUserIds: ["2", "3"] }), "users:4:driver_name,drivers_directory:1");
	expect("exceptUserId and exceptUserIds together", run("Shorn King", { exceptUserId: 2, exceptUserIds: [3] }), "users:4:driver_name,drivers_directory:1");
	expect("exceptDirectoryId skips that directory row", run("shorn king", { users: false, exceptDirectoryId: 1 }), "");
	expect("exceptDirectoryId as a numeric string", run("shorn king", { users: false, exceptDirectoryId: "1" }), "");
	expect("exceptDirectoryId of another row still reports this one", run("shorn king", { users: false, exceptDirectoryId: 2 }), "drivers_directory:1");
	expect("a blank name has no matches", run("   "), "");
	const singular = buildClash(db);
	t("the singular is the plural's first match", JSON.stringify(singular("shorn king")) === JSON.stringify(all("shorn king")[0]));
	t("...and null when there is none", singular("Nobody Here") === null);
	return results;
}

(async () => {
	section("§1 findDriverNameClash()");
	record(helperBattery((db) => buildClash(db)));
	section("§1b findDriverNameClashes() and the skip options");
	record(pluralBattery((db) => buildClashes(db)));
	section("§2 agrees with the ownership comparison (driverOwnsInvoice)");
	record(agreementBattery((db) => buildClash(db)));
	section("§3 PUT /api/applications/:id/status — Accepted");
	record(await acceptBattery());
	section("§4 POST /api/users and POST /api/drivers-directory");
	record(await otherCreatePaths());
	section("§5 source pins");
	sourcePins();
	section("§6 client");
	await clientSection();
	section("§7 mutants — each must be caught");
	await mutants();

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
