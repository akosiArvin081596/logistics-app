#!/usr/bin/env node
/**
 * Applicant and onboarding emails render user-typed values as TEXT.
 *
 * Every value a person typed into the public /apply or /invest form (a name,
 * an address, an email, a vehicle's VIN, a signature) is HTML-escaped with the
 * one existing helper, escapeHtml(), before it is interpolated into an email
 * body, as the driver application and acceptance emails also do. This runner
 * covers these eight templates:
 *
 *   PUT /api/investor-applications/:id/status (Accepted)
 *     welcomeHtml        the investor welcome email (username + temp password)
 *     adminAcceptHtml    the "Investor Accepted" note to info@logisx.com
 *   POST /api/public/investor-apply
 *     vehicleRows, applicantHtml, adminHtml   applicant confirmation + admin note
 *   checkAndCompleteOnboarding()
 *     driverDocsHtml, adminDocsHtml           "Documents Received" to the driver + admin
 *
 * WHAT IS ASSERTED, with a name containing <script> and both quote characters:
 *   §1 the two acceptance emails, captured from the SHIPPED route handler run
 *      end to end against an in-memory SQLite (sendEmail is captured)
 *   §2 the other six templates, each lifted out of server.js as the real
 *      statement and evaluated with hostile values bound to every variable it
 *      reads (unknown fields of an object also come back hostile, so a new
 *      interpolation of one cannot slip past unbound)
 *   §3 each template reuses escapeHtml(), and escapeHtml() is defined once
 *   §4 DISCRIMINATION: the same templates with their escapeHtml() calls
 *      stripped out must fail every check
 *
 * For each rendered body: no raw <script, the raw value never appears, its
 * quotes never appear unescaped, an attribute cannot be broken out of, and the
 * value IS still shown, escaped by an independent reference implementation
 * (so the helper is not grading its own work).
 *
 * Pure: no server, no app.db, no network, no mail.
 *
 * Run: node scripts/test-onboarding-email-escaping.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const piiMask = require(path.join(__dirname, "..", "lib", "pii-mask"));

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }

let Database, bcrypt;
try {
	Database = require("better-sqlite3");
	bcrypt = require("bcryptjs");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

// ── hostile input ────────────────────────────────────────────────────────────
const HOSTILE = `Evil <script>alert("x")</script> O'Hare & "Co"`;
const HOSTILE_EMAIL = `x@evil.example.test" onmouseover="alert(1)`;
const HOSTILE_ADMIN = `boss"<b>`;
// Independent of server.js on purpose.
const refEscape = (s) => String(s)
	.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
	.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// An object whose every unknown string field is hostile.
const hostileRecord = (known = {}) => new Proxy(known, {
	get: (t, k) => (k in t ? t[k] : typeof k === "string" && k !== "then" && k !== "toJSON" ? HOSTILE : undefined),
});

function checkBody(label, html, { name = true, email = false, admin = false } = {}) {
	ok(typeof html === "string" && html.length > 200, `${label}: must render an email body`);
	if (typeof html !== "string") return;
	ok(!/<script/i.test(html), `${label}: must not contain a raw <script> tag`);
	ok(!html.includes(HOSTILE), `${label}: the raw value must never appear verbatim`);
	ok(!html.includes(`alert("x")`) && !html.includes(`O'Hare`), `${label}: the value's quotes must be escaped`);
	if (name) ok(html.includes(refEscape(HOSTILE)), `${label}: the value must still be shown, escaped as text`);
	if (email) {
		ok(!/onmouseover="/i.test(html), `${label}: an email address must not break out of its attribute`);
		ok(html.includes(refEscape(HOSTILE_EMAIL)), `${label}: the email address must still be shown, escaped`);
	}
	if (admin) {
		ok(!html.includes(HOSTILE_ADMIN) && html.includes(refEscape(HOSTILE_ADMIN)), `${label}: the admin's username must be escaped`);
	}
}

// ── lifting ──────────────────────────────────────────────────────────────────
function liftRoute(src, head) {
	const hits = src.split(head).length - 1;
	if (hits !== 1) die(`expected exactly 1 registration starting ${JSON.stringify(head)}, found ${hits}`);
	const a = src.indexOf(head);
	const end = src.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return src.slice(a, end + "\n});".length);
}
function liftFunction(src, head) {
	const needle = `\n${head}`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition starting ${JSON.stringify(head)}, found ${hits}`);
	const a = src.indexOf(needle) + 1;
	const end = src.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${head}`);
	return src.slice(a, end + 2);
}

// A JS scanner just good enough to find where a `const NAME = …;` statement
// ends when its right-hand side is template literals with nested ${…}, strings
// and comments. Regex literals are not handled; none of these statements has one.
function skipString(s, i) {
	const q = s[i];
	for (i++; i < s.length; i++) {
		if (s[i] === "\\") { i++; continue; }
		if (s[i] === q) return i + 1;
	}
	throw new Error("unterminated string");
}
function skipExpr(s, i) { // i is just after "${"
	let depth = 1;
	while (i < s.length) {
		const c = s[i];
		if (c === "`") { i = skipTemplate(s, i); continue; }
		if (c === '"' || c === "'") { i = skipString(s, i); continue; }
		if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return i + 1;
		i++;
	}
	throw new Error("unterminated ${…}");
}
function skipTemplate(s, i) { // i is at the opening backtick
	for (i++; i < s.length; ) {
		const c = s[i];
		if (c === "\\") { i += 2; continue; }
		if (c === "`") return i + 1;
		if (c === "$" && s[i + 1] === "{") { i = skipExpr(s, i + 2); continue; }
		i++;
	}
	throw new Error("unterminated template");
}
function liftConst(src, name) {
	const head = `const ${name} = `;
	const hits = src.split(head).length - 1;
	if (hits !== 1) die(`expected exactly 1 "${head}" in its scope, found ${hits}`);
	const start = src.indexOf(head);
	let depth = 0;
	for (let i = start + head.length; i < src.length; ) {
		const c = src[i];
		if (c === "`") { i = skipTemplate(src, i); continue; }
		if (c === '"' || c === "'") { i = skipString(src, i); continue; }
		if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
		if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 2; continue; }
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === ";" && depth === 0) return src.slice(start, i + 1);
		i++;
	}
	die(`could not find the end of ${head}`);
}
function render(stmt, name, bindings) {
	const names = Object.keys(bindings);
	return new Function(...names, `"use strict";\n${stmt}\nreturn ${name};`)(...names.map((n) => bindings[n]));
}
// §4: remove every escapeHtml(...) wrapper, keeping its argument.
function stripEscapes(src) {
	let out = "";
	let i = 0;
	const CALL = "escapeHtml(";
	while (i < src.length) {
		const at = src.indexOf(CALL, i);
		if (at < 0) { out += src.slice(i); break; }
		out += src.slice(i, at);
		let j = at + CALL.length, depth = 1;
		while (j < src.length && depth > 0) {
			const c = src[j];
			if (c === "`") { j = skipTemplate(src, j); continue; }
			if (c === '"' || c === "'") { j = skipString(src, j); continue; }
			if (c === "(") depth++;
			else if (c === ")") depth--;
			j++;
		}
		out += "(" + src.slice(at + CALL.length, j - 1) + ")";
		i = j;
	}
	return out;
}

// ── the code under test ──────────────────────────────────────────────────────
const ACCEPT_SRC = liftRoute(SRC, 'app.put("/api/investor-applications/:id/status", requireRole("Super Admin"), async (req, res) => {');
const APPLY_SRC = liftRoute(SRC, 'app.post("/api/public/investor-apply", publicFormLimiter, async (req, res) => {');
const ONBOARD_SRC = liftFunction(SRC, "async function checkAndCompleteOnboarding(userId) {");
const ESCAPE_SRC = liftFunction(SRC, "function escapeHtml(s) {");
const COL_LETTER_SRC = liftFunction(SRC, "function colLetter(idx) {");
const escapeHtml = new Function(`${ESCAPE_SRC}\nreturn escapeHtml;`)();
const INVESTOR_ONBOARDING_DOCS = render(liftConst(SRC, "INVESTOR_ONBOARDING_DOCS"), "INVESTOR_ONBOARDING_DOCS", {});
const ONBOARDING_DOCS = render(liftConst(SRC, "ONBOARDING_DOCS"), "ONBOARDING_DOCS", {});

const USERS_CREATE = (() => {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE users");
	return `CREATE TABLE users (${m[1]}\n)`;
})();
const USERS_ALTERS = ["full_name", "company_name", "must_change_password", "last_login_at"].map((col) => {
	const m = SRC.match(new RegExp(`ALTER TABLE users ADD COLUMN ${col} [^"]*`));
	if (!m) die(`could not locate the users.${col} migration`);
	return m[0];
});

// ── §1 the acceptance emails, from the shipped route ─────────────────────────
// `vals` overrides the stored application's fields (§5 gives each its own marker).
async function acceptanceMail(routeSrc, vals = {}) {
	const row = { legal_name: HOSTILE, dba: HOSTILE, entity_type: HOSTILE, email: HOSTILE_EMAIL, ...vals };
	const db = new Database(":memory:");
	db.exec(USERS_CREATE);
	for (const alter of USERS_ALTERS) db.exec(alter);
	db.exec(`
		CREATE TABLE investor_applications (
			id INTEGER PRIMARY KEY AUTOINCREMENT, legal_name TEXT NOT NULL, dba TEXT DEFAULT '',
			entity_type TEXT DEFAULT '', email TEXT DEFAULT '', vehicles_json TEXT DEFAULT '[]',
			address TEXT DEFAULT '', phone TEXT DEFAULT '', ein_ssn TEXT DEFAULT '', tax_classification TEXT DEFAULT '',
			contact_person TEXT DEFAULT '', contact_title TEXT DEFAULT '', status TEXT DEFAULT 'New', deleted_at TEXT DEFAULT NULL
		);
		CREATE TABLE investors (
			id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, full_name TEXT, carrier_name TEXT, status TEXT,
			application_id INTEGER, entity_type TEXT, address TEXT, phone TEXT, email TEXT, ein_ssn TEXT,
			tax_classification TEXT, contact_person TEXT, contact_title TEXT
		);
		CREATE TABLE trucks (
			id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, make TEXT, model TEXT, year INTEGER, vin TEXT,
			license_plate TEXT, status TEXT, owner_id INTEGER, purchase_price REAL, title_status TEXT, title_state TEXT, notes TEXT
		);
	`);
	const appId = Number(db.prepare(
		"INSERT INTO investor_applications (legal_name, dba, entity_type, email, vehicles_json) VALUES (?, ?, ?, ?, ?)",
	).run(row.legal_name, row.dba, row.entity_type, row.email, JSON.stringify([{ year: "2021", make: "Volvo" }])).lastInsertRowid);

	let handler = null;
	const mail = [];
	const colLetter = new Function(`${COL_LETTER_SRC}\nreturn colLetter;`)();
	new Function("app", "requireRole", "db", "bcrypt", "crypto", "logAudit", "notifyChange", "colLetter", "escapeHtml", "sendEmail", routeSrc)(
		{ put: (p, guard, h) => { handler = h; } }, () => (req, res, next) => next(), db,
		{ hash: (pw) => bcrypt.hash(pw, 4) }, crypto, () => {}, () => {}, colLetter, escapeHtml,
		(to, subject, html) => { mail.push({ to, subject, html }); return Promise.resolve(true); });
	const out = {};
	await handler({
		params: { id: String(appId) }, body: { status: "Accepted" },
		session: { user: { id: 99, username: HOSTILE_ADMIN, role: "Super Admin" } },
	}, { status() { return this; }, json(b) { out.body = b; return this; } });
	return {
		body: out.body,
		welcome: (mail.find((m) => m.to === row.email) || {}).html,
		admin: (mail.find((m) => m.to === "info@logisx.com") || {}).html,
	};
}

// ── §2 the other six templates, rendered from their real statements ──────────
function renderApplyTemplates(applySrc) {
	const b = {
		escapeHtml, piiMask, INVESTOR_ONBOARDING_DOCS,
		legal_name: HOSTILE, dba: HOSTILE, entity_type: HOSTILE, address: HOSTILE,
		contact_person: HOSTILE, contact_title: HOSTILE, phone: HOSTILE, email: HOSTILE_EMAIL,
		ein_ssn: `${HOSTILE} 123-45-6789`, tax_classification: HOSTILE, years_in_operation: HOSTILE,
		industry_experience: HOSTILE, bankruptcy_liens: HOSTILE,
		banking: hostileRecord({ routing_number: "021000021", account_number: "000123456789" }),
		vehiclesArr: [hostileRecord({ purchasePrice: "45000" })],
		signatures: Object.fromEntries(INVESTOR_ONBOARDING_DOCS.map((d) => [d.key, { text: HOSTILE }])),
		failedDocs: [], signedDocCount: INVESTOR_ONBOARDING_DOCS.length,
	};
	const vehicleRows = render(liftConst(applySrc, "vehicleRows"), "vehicleRows", b);
	return {
		vehicleRows,
		applicantHtml: render(liftConst(applySrc, "applicantHtml"), "applicantHtml", b),
		adminHtml: render(liftConst(applySrc, "adminHtml"), "adminHtml", { ...b, vehicleRows }),
	};
}
function renderOnboardingTemplates(onboardSrc) {
	const b = { escapeHtml, ONBOARDING_DOCS, driverName: HOSTILE, driverEmail: HOSTILE_EMAIL, application: hostileRecord() };
	return {
		driverDocsHtml: render(liftConst(onboardSrc, "driverDocsHtml"), "driverDocsHtml", b),
		adminDocsHtml: render(liftConst(onboardSrc, "adminDocsHtml"), "adminDocsHtml", b),
	};
}

// ── §5/§6 every applicant field of /invest, one marker per field ─────────────
// §2 binds ONE hostile value to every field. That proves nothing is emitted
// raw, but not WHICH fields were covered. Here every field gets its own marker,
// so each is checked by name — including the fields the emails do not show
// today, which must stay escaped if they are ever added.
const marker = (name) => `<i data-f="${name}">O'Hare "${name}" & co</i>`;
// The names the route destructures from req.body: the list the form sends.
function bodyFieldNames(applySrc) {
	const m = applySrc.match(/const \{([^}]*)\} = req\.body;/);
	if (!m) die("no req.body destructuring in /api/public/investor-apply");
	return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}
// An object that answers every key with that key's own marker, and records
// which keys the template read.
function markedRecord(prefix, read, known = {}) {
	return new Proxy(known, {
		get: (t, k) => {
			if (typeof k !== "string" || k === "then" || k === "toJSON") return undefined;
			read.add(k);
			return k in t ? t[k] : marker(`${prefix}.${k}`);
		},
	});
}
function renderApplyPerField(applySrc) {
	const top = bodyFieldNames(applySrc).filter((f) => !["vehicles", "banking", "signatures"].includes(f));
	const b = { escapeHtml, piiMask, INVESTOR_ONBOARDING_DOCS, failedDocs: [], signedDocCount: INVESTOR_ONBOARDING_DOCS.length };
	for (const f of top) b[f] = f === "email" ? HOSTILE_EMAIL : marker(f);
	const vehicleRead = new Set();
	const bankingRead = new Set();
	b.vehiclesArr = [markedRecord("vehicle", vehicleRead)];
	b.banking = markedRecord("banking", bankingRead);
	b.signatures = Object.fromEntries(INVESTOR_ONBOARDING_DOCS.map((d) => [d.key, { text: marker(`signature.${d.key}`) }]));
	const vehicleRows = render(liftConst(applySrc, "vehicleRows"), "vehicleRows", b);
	const applicantHtml = render(liftConst(applySrc, "applicantHtml"), "applicantHtml", b);
	const adminHtml = render(liftConst(applySrc, "adminHtml"), "adminHtml", { ...b, vehicleRows });
	// The "ACTION NEEDED" banner above the admin email, when a document failed.
	const docWarningHtml = render(liftConst(applySrc, "docWarningHtml"), "docWarningHtml",
		{ ...b, failedDocs: [marker("failedDoc")] });
	return { top, vehicleRead, bankingRead, bodies: { applicantHtml, adminHtml: docWarningHtml + adminHtml } };
}
// What each email is expected to SHOW, escaped. Every other field must simply
// never appear raw (masked numbers, and fields the emails leave out).
const SHOWN_TOP = ["legal_name", "dba", "entity_type", "address", "contact_person", "contact_title", "phone", "email",
	"tax_classification", "years_in_operation", "industry_experience", "bankruptcy_liens"];
const SHOWN_VEHICLE = ["year", "make", "model", "vin", "licensePlate", "titleState"];
const SHOWN_BANKING = ["bank_name", "account_type", "account_name"];

async function main() {
	// §1
	const acc = await acceptanceMail(ACCEPT_SRC);
	ok(acc.body && acc.body.accountCreated === true, "§1 the acceptance must still create the account");
	checkBody("§1 investor welcome email", acc.welcome);
	checkBody("§1 admin 'Investor Accepted' email", acc.admin, { email: true, admin: true });
	ok(!!acc.welcome && acc.welcome.includes(acc.body.credentials.tempPassword) && acc.welcome.includes(acc.body.credentials.username),
		"§1 the welcome email must still carry the username and temporary password");

	// §2
	const apply = renderApplyTemplates(APPLY_SRC);
	checkBody("§2 /invest vehicle rows", apply.vehicleRows);
	ok(apply.vehicleRows.includes("$45,000"), "§2 /invest vehicle rows: the purchase price must still render");
	checkBody("§2 /invest applicant confirmation", apply.applicantHtml);
	checkBody("§2 /invest admin notification", apply.adminHtml, { email: true });
	ok(apply.adminHtml.includes("••••6789") && apply.adminHtml.includes("••••0021") && !apply.adminHtml.includes("123-45-6789"),
		"§2 /invest admin notification: the tax id and bank numbers must stay masked");
	const onboard = renderOnboardingTemplates(ONBOARD_SRC);
	checkBody("§2 driver 'Documents Received' email", onboard.driverDocsHtml);
	checkBody("§2 admin 'Driver Documents Signed' email", onboard.adminDocsHtml, { email: true });

	// §3 one helper, reused
	ok((SRC.match(/\nfunction escapeHtml\(/g) || []).length === 1, "§3 escapeHtml() must be defined exactly once");
	const scopes = [
		["welcomeHtml", ACCEPT_SRC], ["adminAcceptHtml", ACCEPT_SRC], ["vehicleRows", APPLY_SRC], ["applicantHtml", APPLY_SRC],
		["adminHtml", APPLY_SRC], ["driverDocsHtml", ONBOARD_SRC], ["adminDocsHtml", ONBOARD_SRC],
	];
	for (const [name, scope] of scopes) {
		const stmt = liftConst(scope, name);
		ok(/escapeHtml\(/.test(stmt) && !/\besc\w*\(/i.test(stmt.replace(/escapeHtml\(/g, "")),
			`§3 ${name} must escape with escapeHtml() and no other helper`);
	}

	// §4 discrimination: the same templates with the escapes stripped. The
	// checks run against each mutant, but only WHETHER they fired is recorded;
	// the mutant's own passes and failures are rolled back.
	const failedBefore = failures.length;
	const probe = [];
	const collect = (label, html, opts) => {
		const before = failures.length, passBefore = pass;
		checkBody(label, html, opts);
		probe.push({ label, caught: failures.length > before });
		failures.length = before;
		pass = passBefore;
	};
	const accM = await acceptanceMail(stripEscapes(ACCEPT_SRC));
	collect("welcome", accM.welcome);
	collect("admin accept", accM.admin, { email: true, admin: true });
	const applyM = renderApplyTemplates(stripEscapes(APPLY_SRC));
	collect("vehicle rows", applyM.vehicleRows);
	collect("applicant", applyM.applicantHtml);
	collect("apply admin", applyM.adminHtml, { email: true });
	const onboardM = renderOnboardingTemplates(stripEscapes(ONBOARD_SRC));
	collect("driver docs", onboardM.driverDocsHtml);
	collect("admin docs", onboardM.adminDocsHtml, { email: true });
	ok(failures.length === failedBefore, "§4 (bookkeeping) mutant checks must not leak into the real result");
	for (const p of probe) ok(p.caught, `§4 MUTANT NOT CAUGHT — ${p.label} with escapeHtml() stripped must fail the checks`);
	ok(stripEscapes(ACCEPT_SRC) !== ACCEPT_SRC && stripEscapes(APPLY_SRC) !== APPLY_SRC && stripEscapes(ONBOARD_SRC) !== ONBOARD_SRC,
		"§4 the mutants must actually differ from the shipped source");

	// §5 /invest: every field the form sends, one marker each
	const pf = renderApplyPerField(APPLY_SRC);
	const all = Object.values(pf.bodies).join("\n");
	const rawFree = (value) => !all.includes(value);
	const shown = (value) => all.includes(refEscape(value));
	ok(pf.top.length >= 16, `§5 the route's own field list must be read (found ${pf.top.length})`);
	for (const f of pf.top) {
		const value = f === "email" ? HOSTILE_EMAIL : marker(f);
		ok(rawFree(value), `§5 /invest field "${f}" must never appear raw in the emails`);
	}
	for (const f of SHOWN_TOP) {
		ok(pf.top.includes(f), `§5 "${f}" must still be one of the fields the route reads`);
		ok(shown(f === "email" ? HOSTILE_EMAIL : marker(f)), `§5 /invest field "${f}" must be shown, escaped as text`);
	}
	ok(!/onmouseover="/i.test(all), "§5 the email address must not break out of its mailto: attribute");
	for (const k of pf.vehicleRead) ok(rawFree(marker(`vehicle.${k}`)), `§5 vehicle field "${k}" must never appear raw`);
	for (const k of SHOWN_VEHICLE) ok(shown(marker(`vehicle.${k}`)), `§5 vehicle field "${k}" must be shown, escaped as text`);
	for (const k of pf.bankingRead) ok(rawFree(marker(`banking.${k}`)), `§5 banking field "${k}" must never appear raw`);
	for (const k of SHOWN_BANKING) ok(shown(marker(`banking.${k}`)), `§5 banking field "${k}" must be shown, escaped as text`);
	ok(pf.bankingRead.has("routing_number") && pf.bankingRead.has("account_number") &&
		!shown(marker("banking.routing_number")) && !shown(marker("banking.account_number")),
		"§5 the routing and account numbers are read but only ever shown masked");
	for (const d of INVESTOR_ONBOARDING_DOCS) {
		const value = marker(`signature.${d.key}`);
		ok(rawFree(value) && shown(value), `§5 the signature on "${d.key}" must be shown escaped, never raw`);
	}

	// §6 the "ACTION NEEDED" banner names the failed documents, escaped
	ok(rawFree(marker("failedDoc")) && shown(marker("failedDoc")), "§6 a failed document's name must be shown escaped, never raw");

	// §5 the acceptance emails, one marker per stored column
	const accPf = await acceptanceMail(ACCEPT_SRC, { legal_name: marker("legal_name"), dba: marker("dba"), entity_type: marker("entity_type") });
	const accAll = `${accPf.welcome || ""}\n${accPf.admin || ""}`;
	for (const f of ["legal_name", "dba", "entity_type"]) {
		ok(!accAll.includes(marker(f)), `§5 acceptance emails: stored "${f}" must never appear raw`);
	}
	ok((accPf.welcome || "").includes(refEscape(marker("legal_name"))), "§5 acceptance welcome: the legal name must be shown, escaped");
	ok((accPf.admin || "").includes(refEscape(marker("legal_name"))) && (accPf.admin || "").includes(refEscape(marker("entity_type"))),
		"§5 acceptance admin note: the legal name and entity type must be shown, escaped");

	// §5/§6 DISCRIMINATION: with the escapes stripped, every field shown above
	// must come out raw, so each per-field check is one that can fail.
	const pfM = renderApplyPerField(stripEscapes(APPLY_SRC));
	const allM = Object.values(pfM.bodies).join("\n");
	const flipped = [
		...SHOWN_TOP.map((f) => (f === "email" ? HOSTILE_EMAIL : marker(f))),
		...SHOWN_VEHICLE.map((k) => marker(`vehicle.${k}`)),
		...SHOWN_BANKING.map((k) => marker(`banking.${k}`)),
		...INVESTOR_ONBOARDING_DOCS.map((d) => marker(`signature.${d.key}`)),
		marker("failedDoc"),
	].filter((v) => !allM.includes(v));
	ok(flipped.length === 0, `§5/§6 MUTANT NOT CAUGHT — with escapeHtml() stripped these would still pass: ${flipped.join(" | ")}`);
}

main().then(() => {
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
}).catch((e) => {
	console.error(e);
	process.exit(1);
});
