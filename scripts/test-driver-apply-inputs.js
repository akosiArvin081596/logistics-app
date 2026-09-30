#!/usr/bin/env node
/**
 * The driver application (/apply, POST /api/public/apply) checks its SSN and
 * its required answers before anything is stored.
 *
 * SSN. The route stored an SSN of any length (200). A driver's W-9 is
 * filled as an individual's, so the number goes in Part I's SSN boxes, 3-2-4:
 * ten digits made that driver's own W-9 preview answer 500 (the last box holds
 * four), and eight printed 123-45-678 on a tax form. Neither the server nor the
 * step component checked the length. The route now runs checkW9Ssn()
 * (lib/w9-input.js): checkW9Tin(), the investor rule (nine digits, the length
 * cap, one bounded class), restricted to the SSN's own shapes, 123-45-6789 or
 * 123456789, with spaces around it allowed (/apply has stored "123-45-6789 ").
 * Anything else is refused before anything is stored:
 * 400 { error: "Enter a 9-digit Social Security number.",
 * code: "INVALID_SSN", field: "ssn" }. An SSN that passes is stored and printed
 * exactly as before. Step 1 of /apply shows the same message under the SSN
 * field and will not continue (client copy: client/src/lib/taxId.js).
 *
 * The driver's W-9 preview (GET /api/onboarding/documents/w9/pdf) takes no SSN
 * from its request: it prints the one stored by this route.
 *
 * REQUIRED ANSWERS. A request that left out `skills` answered 500: the column
 * is NOT NULL, and the route's required-field check did not include it. Every
 * NOT NULL column the route binds is now checked first, and a missing one is
 * refused the way the route refuses its other missing fields, naming it:
 * 400 { error: "Please fill in all required fields.", code: "FIELD_REQUIRED",
 * field }. `skills` only has to be present: the form sends "" when it is left
 * blank, and that is still stored.
 *
 * WHAT IS ASSERTED.
 *   §1 checkW9Ssn(): the accepted and refused shapes, the code and message, the
 *      value passed through unchanged, and the TIN check run first.
 *   §2 the client's copy (checkSsn) gives the same verdict and message on
 *      every row of §1's table, and the shipped ES module agrees.
 *   §3 POST /api/public/apply, lifted from server.js and executed against a
 *      real SQLite job_applications table built from server.js's own DDL: the
 *      400s, nothing stored on a refusal, an accepted SSN stored unchanged, and
 *      the real form's payload (ApplyView.vue's defaultForm and submit payload)
 *      stored as before; every NOT NULL column (read off the DDL) left out,
 *      null or empty answers FIELD_REQUIRED naming it, and blank skills pass.
 *   §4 the shipped fillW9Form(), called as the driver's W-9 is: every accepted
 *      shape prints 3-2-4 in the SSN boxes; the two refused examples are the
 *      500 and the short number.
 *   §5 /apply step 1: ApplyView's validate(0) and StepPersonalInfo's inline
 *      message, lifted and executed.
 *   §6 MUTANTS, one per new guard, each caught.
 *
 * Test SSNs (123-45-6789) and QA-TEST names only. Pure: no server, no app.db
 * (an in-memory database), no network.
 *
 * Run: node scripts/test-driver-apply-inputs.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const LIB_PATH = path.join(ROOT, "lib", "w9-input.js");
const LIB_SRC = fs.readFileSync(LIB_PATH, "utf8");
const CLIENT_PATH = path.join(ROOT, "client", "src", "lib", "taxId.js");
const CLIENT_SRC = fs.readFileSync(CLIENT_PATH, "utf8");
const EMAIL_PATH = path.join(ROOT, "client", "src", "lib", "emailAddress.js");
const APPLY_VIEW_SRC = fs.readFileSync(path.join(ROOT, "client", "src", "views", "ApplyView.vue"), "utf8");
const STEP_SRC = fs.readFileSync(path.join(ROOT, "client", "src", "components", "apply", "StepPersonalInfo.vue"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }
const cp = (...points) => String.fromCodePoint(...points);

let Database, pdfLib;
try {
	Database = require("better-sqlite3");
	pdfLib = require("pdf-lib");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
const imageLimits = require(path.join(ROOT, "lib", "image-size"));
const publicFormInput = require(path.join(ROOT, "lib", "public-form-input"));

// A (possibly mutated) copy of the lib, loaded without touching the real module.
function loadLib(src) {
	const mod = { exports: {} };
	new Function("module", "exports", "require", src)(mod, mod.exports, require);
	return mod.exports;
}
const LIB = loadLib(LIB_SRC);
// A (possibly mutated) copy of the client file: its exports become returns.
function loadClient(src) {
	const body = src.replace(/^export (const|function) /gm, "$1 ");
	const names = [...src.matchAll(/^export (?:const|function) ([A-Za-z_]\w*)/gm)].map((m) => m[1]);
	return new Function(`"use strict";\n${body}\nreturn { ${names.join(", ")} };`)();
}
const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };
const codeOnly = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const failed = (rs) => rs.some((x) => !x.ok);
function rows() {
	const r = [];
	r.t = (cond, name) => { r.push({ ok: !!cond, name }); return !!cond; };
	return r;
}

// ===========================================================================
// §1 / §2 the SSN rule
// ===========================================================================
const SSN_MESSAGE = "Enter a 9-digit Social Security number.";
const SSN_TABLE = [
	// [label, value, accepted]
	["the placeholder's shape, 123-45-6789", "123-45-6789", true],
	["nine bare digits", "123456789", true],
	["a trailing space, as /apply has stored", "123-45-6789 ", true],
	["a leading space", " 123-45-6789", true],
	["spaces around nine bare digits", "  123456789  ", true],
	["a test SSN with zeros", "000-00-0001", true],
	["ten digits (the 500)", "123-45-67890", false],
	["ten bare digits", "1234567890", false],
	["eight digits (the short number)", "123-45-678", false],
	["eight bare digits", "12345678", false],
	["an EIN's shape", "12-3456789", false],
	["other hyphen places", "1234-56789", false],
	["spaces between the groups", "123 45 6789", false],
	["a doubled hyphen", "123--45-6789", false],
	["separators only", "- - -", false],
	["a letter after nine digits", "123-45-6789a", false],
	["nine characters, one a letter", "12345678a", false],
	["slashes", "123/45/6789", false],
	["full stops", "123.45.6789", false],
	["a tab", "123-45-6789\t", false],
	["a newline", "123-45-6789\n", false],
	["en dashes", `123${cp(0x2013)}45${cp(0x2013)}6789`, false],
	["full-width digits", cp(0xff11, 0xff12, 0xff13, 0xff14, 0xff15, 0xff16, 0xff17, 0xff18, 0xff19), false],
	["over the length cap", `${" ".repeat(30)}123-45-6789`, false],
	["a very long value", "1".repeat(1 << 20), false],
	["a number", 123456789, false],
	["a list", ["123456789"], false],
	["an object", { ssn: "123456789" }, false],
	["true", true, false],
];

function ssnRows(check, verdictOf) {
	const r = rows();
	for (const [label, value, accepted] of SSN_TABLE) {
		let v;
		try { v = verdictOf(check(value)); } catch (e) { v = { threw: e.message }; }
		const right = accepted ? v.ok === true : v.ok === false && v.message === SSN_MESSAGE;
		r.t(right, `${label}: ${accepted ? "accepted" : "refused with the message"} (got ${JSON.stringify(v).slice(0, 200)})`);
	}
	return r;
}

function ssnSection(lib = LIB) {
	const r = ssnRows(lib.checkW9Ssn, (x) => ({ ok: x.ok, message: x.message, code: x.code }));
	for (const [label, value, accepted] of SSN_TABLE) {
		let v;
		try { v = lib.checkW9Ssn(value); } catch { v = {}; }
		if (accepted) r.t(v.value === value, `${label}: passed through unchanged, so it is stored and printed as before`);
		else r.t(v.code === "INVALID_SSN", `${label}: code INVALID_SSN`);
	}
	for (const absent of [undefined, null, ""]) {
		const v = lib.checkW9Ssn(absent);
		r.t(v.ok === true && v.absent === true, `absent (${JSON.stringify(absent)}) passes as absent; required-ness is the route's`);
	}
	r.t(lib.INVALID_SSN_MESSAGE === SSN_MESSAGE, "the message is the agreed words, exactly");
	const fn = codeOnly(LIB_SRC.slice(LIB_SRC.indexOf("function checkW9Ssn("), LIB_SRC.indexOf("\n}\n", LIB_SRC.indexOf("function checkW9Ssn("))));
	r.t(/const tin = checkW9Tin\(raw\);/.test(fn) && fn.indexOf("checkW9Tin(raw)") < fn.indexOf("SSN_SHAPE_RE.test(raw)"),
		"checkW9Tin() runs first, so the shape pattern only ever sees a string of at most 32 characters");
	r.t(String(lib.SSN_SHAPE_RE) === "/^ {0,32}(?:\\d{3}-\\d{2}-\\d{4}|\\d{9}) {0,32}$/",
		"the shape pattern is anchored and every quantifier is bounded");
	return r;
}

async function clientSsnSection(src = CLIENT_SRC) {
	const client = loadClient(src);
	const r = ssnRows(client.checkSsn, (x) => ({ ok: x.ok, message: x.message }));
	r.t(client.INVALID_SSN_MESSAGE === LIB.INVALID_SSN_MESSAGE, "the client and the server say the same words");
	r.t(String(client.SSN_SHAPE_RE) === String(LIB.SSN_SHAPE_RE), "the client and the server use the same shape pattern");
	r.t(client.checkSsn("").ok === true && client.checkSsn(undefined).ok === true, "the client lets an empty field be (required-ness is the form's)");
	if (src === CLIENT_SRC) {
		const real = await import(pathToFileURL(CLIENT_PATH).href);
		r.t(real.checkSsn("123-45-67890").ok === false && real.checkSsn("123-45-6789").ok === true,
			"the shipped ES module loads and agrees (the copy above is not a different file)");
	}
	return r;
}

// ===========================================================================
// §3 POST /api/public/apply, executed on a real job_applications table
// ===========================================================================
function routeSource(verb, routePath, src = SRC) {
	const needle = `app.${verb}("${routePath}"`;
	const at = src.indexOf(needle);
	if (at < 0) die(`route not found: ${verb.toUpperCase()} ${routePath}`);
	let depth = 0;
	for (let j = src.indexOf("(", at); j < src.length; j++) {
		if (src[j] === "(") depth++;
		else if (src[j] === ")") { depth--; if (depth === 0) return src.slice(at, j + 1); }
	}
	return die(`unbalanced parens extracting ${routePath}`);
}
// A column-0 `function name(` … `\n}\n`, exactly one definition.
function liftFunction(head, src = SRC) {
	const needle = `\n${head}`;
	if (src.split(needle).length - 1 !== 1) die(`expected exactly 1 definition starting ${JSON.stringify(head)}`);
	const a = src.indexOf(needle) + 1;
	const end = src.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${head}`);
	return src.slice(a, end + 2);
}
// The whole `const NAME = [ … ];` statement.
function liftConst(name, src = SRC) {
	const m = src.match(new RegExp(`\\nconst ${name} = \\[[^\\]]*\\];`));
	if (!m) die(`const ${name} not found in server.js`);
	return m[0].slice(1);
}
// The job_applications table exactly as server.js creates and migrates it.
function tableDdl(src = SRC) {
	const head = "CREATE TABLE IF NOT EXISTS job_applications (";
	const a = src.indexOf(head);
	if (a < 0) die("job_applications DDL not found");
	const create = src.slice(a, src.indexOf("`);", a));
	const alters = [...src.matchAll(/db\.exec\("(ALTER TABLE job_applications ADD COLUMN [^"]+)"\)/g)].map((m) => m[1]);
	if (alters.length < 5) die("job_applications migrations not found");
	return { create, alters };
}
function freshDb(src = SRC) {
	const db = new Database(":memory:");
	const { create, alters } = tableDdl(src);
	db.exec(create);
	for (const s of alters) db.exec(s);
	return db;
}

const LIMITER = () => {};
const QUIET = { error() {}, warn() {}, log() {} };
// The handler as server.js registers it, with the route's own helpers and
// lists lifted beside it. Only the outbound effects are stubbed.
function applyRoute(src = SRC, lib = LIB) {
	const db = freshDb(src);
	const mail = [];
	const audits = [];
	const handlers = {};
	const app = { post: (p, ...h) => { handlers[p] = h; } };
	const lifted = [
		liftConst("PUBLIC_APPLY_SCALAR_FIELDS", src),
		liftConst("PUBLIC_APPLY_REQUIRED_FIELDS", src),
		liftConst("PUBLIC_APPLY_PRESENT_FIELDS", src),
		liftFunction("function publicApplyMissingField(", src),
		liftConst("PUBLIC_APPLY_ATTACHMENT_FIELDS", src),
		liftFunction("function applicantAttachmentRefusal(", src),
		liftFunction("function escapeHtml(", src),
		`${routeSource("post", "/api/public/apply", src)};`,
	].join("\n");
	new Function("app", "publicFormLimiter", "publicFormInput", "w9Input", "imageLimits", "db", "logAudit", "sendEmail", "console",
		`"use strict";\n${lifted}`)(app, LIMITER, publicFormInput, lib, imageLimits, db,
		(...a) => audits.push(a), (...a) => mail.push(a), QUIET);
	const mounted = handlers["/api/public/apply"];
	if (!mounted || mounted.length !== 2 || mounted[0] !== LIMITER) die("POST /api/public/apply is not mounted behind publicFormLimiter");
	const call = (body) => {
		const out = { status: 200, body: undefined };
		const res = {
			headersSent: false,
			status(c) { out.status = c; return this; },
			json(b) { out.body = b; this.headersSent = true; return this; },
		};
		// What express.json() hands the route: undefined properties do not survive JSON.
		mounted[1]({ body: body === undefined ? {} : JSON.parse(JSON.stringify(body)) }, res);
		return out;
	};
	const count = () => db.prepare("SELECT COUNT(*) AS n FROM job_applications").get().n;
	return { call, db, mail, audits, count };
}

// A tiny PDF data URL: the route checks an attachment's %PDF- magic only.
const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n%QA-TEST\n").toString("base64")}`;

// The real form: ApplyView.vue's defaultForm() and its submit payload, lifted.
function realFormPayload(fill, view = APPLY_VIEW_SRC) {
	const a = view.indexOf("const defaultForm = () => ({");
	if (a < 0) die("ApplyView.vue: defaultForm not found");
	const end = view.indexOf("\n})\n", a);
	const form = new Function(`return (${view.slice(view.indexOf("() => ({", a), end + 3)})();`)();
	Object.assign(form, fill);
	const p = view.indexOf("const payload = { ...form,");
	if (p < 0) die("ApplyView.vue: the submit payload not found");
	const expr = view.slice(p + "const payload = ".length, view.indexOf("\n", p));
	return new Function("form", `return (${expr});`)(form);
}
let stamp = 0;
function realForm(over = {}) {
	stamp++;
	return realFormPayload({
		first_name: "QA-TEST", last_name: `Driver ${stamp}`, email: `qa-test-${stamp}@example.com`,
		phone: "(555) 555-0100", dob: "1990-01-01", address: "1 QA Test Way, Testville, TX 77001",
		city: "Testville", state: "TX", zip: "77001", ssn: "123-45-6789", drivers_license: "QA-TEST-DL",
		position: "Company Driver", hazmat: "No", cdl_front: PDF, cdl_back: PDF, medical_card: PDF,
		experience: "5", has_cdl: "Yes", work_authorized: "Yes", felony_convicted: "No", accident_history: "No",
		availability: ["Full-time"],
		references: [0, 1, 2].map((i) => ({ name: `QA-TEST Ref ${i}`, phone: "555-555-0000", relationship: "", contactPerson: "" })),
		signature: "QA-TEST Driver", ...over,
	});
}
const SSN_400 = JSON.stringify({ error: SSN_MESSAGE, code: "INVALID_SSN", field: "ssn" });

function routeSsnRows(src = SRC, lib = LIB) {
	const r = rows();
	const route = applyRoute(src, lib);
	for (const [label, value, accepted] of SSN_TABLE) {
		if (typeof value !== "string" || value.length > 1000) continue;
		const before = route.count();
		const got = route.call(realForm({ ssn: value }));
		if (accepted) {
			const stored = route.db.prepare("SELECT ssn FROM job_applications WHERE id = ?").get(got.body && got.body.id);
			r.t(got.status === 200 && got.body.success === true && stored && stored.ssn === value,
				`${label}: 200, stored exactly as sent (got ${got.status} ${JSON.stringify(got.body)})`);
		} else {
			r.t(got.status === 400 && JSON.stringify(got.body) === SSN_400 && route.count() === before,
				`${label}: 400 ${SSN_400}, nothing stored (got ${got.status} ${JSON.stringify(got.body)})`);
		}
	}
	const big = route.call(realForm({ ssn: "1".repeat(1 << 20) }));
	r.t(big.status === 400 && JSON.stringify(big.body) === SSN_400, "a very long SSN is refused as INVALID_SSN");
	const list = route.call(realForm({ ssn: ["123-45-6789"] }));
	r.t(list.status === 400 && list.body.code === "INVALID_FIELD" && list.body.field === "ssn", "a list is refused as not one scalar first (INVALID_FIELD)");
	const [mailBefore, auditsBefore] = [route.mail.length, route.audits.length];
	route.call(realForm({ ssn: "123-45-67890" }));
	r.t(route.mail.length === mailBefore && route.audits.length === auditsBefore, "a refused SSN sends no email and writes no audit row");
	const code = codeOnly(routeSource("post", "/api/public/apply", src));
	const at = code.indexOf("const ssnCheck = w9Input.checkW9Ssn(ssn);");
	r.t(at > code.indexOf("publicFormInput.checkPublicScalars(req.body, PUBLIC_APPLY_SCALAR_FIELDS)") &&
		at < code.indexOf("db.prepare(") && at < code.indexOf("sendEmail(") && at < code.indexOf("logAudit("),
	"the SSN is checked after the scalar check and before the first query, audit row or email");
	return r;
}

function realFormRows(src = SRC) {
	const r = rows();
	const route = applyRoute(src);
	const payload = realForm();
	const got = route.call(payload);
	r.t(got.status === 200 && got.body.success === true && Number.isInteger(Number(got.body.id)),
		`the real form's payload is stored: 200 { success: true, id } (got ${got.status} ${JSON.stringify(got.body)})`);
	const row = route.db.prepare("SELECT * FROM job_applications WHERE id = ?").get(got.body.id) || {};
	r.t(row.ssn === "123-45-6789" && row.skills === "" && row.availability === JSON.stringify(["Full-time"]) &&
		row.full_name === payload.full_name && row.cdl_front === PDF,
	"…with the SSN, the blank skills answer, the availability and the attachments as sent");
	r.t(route.mail.length === 2 && route.audits.length === 1, "…and the two emails and the audit row, as before");
	return r;
}

// The NOT NULL columns with no default, read off the DDL: each one the INSERT
// binds as sent. (`status` has a default; `id` is the key.)
function notNullColumns(src = SRC) {
	const { create } = tableDdl(src);
	return [...create.matchAll(/^\s*([a-z_]+) [A-Z]+ NOT NULL,?$/gm)].map((m) => m[1]);
}
const listIn = (name, src = SRC) => [...liftConst(name, src).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const MISSING_400 = (field) => JSON.stringify({ error: "Please fill in all required fields.", code: "FIELD_REQUIRED", field });

function requiredRows(src = SRC) {
	const r = rows();
	const required = listIn("PUBLIC_APPLY_REQUIRED_FIELDS", src);
	const present = listIn("PUBLIC_APPLY_PRESENT_FIELDS", src);
	const columns = notNullColumns(src);
	r.t(columns.length >= 15 && columns.includes("skills"), `the DDL's NOT NULL columns were read (${columns.join(", ")})`);
	r.t([...required, ...present].sort().join() === [...columns].sort().join() && !required.some((f) => present.includes(f)),
		"every NOT NULL column is in exactly one list: non-empty, or present (skills)");
	r.t(JSON.stringify(present) === JSON.stringify(["skills"]), "only skills may be empty (the form sends \"\" when it is left blank)");

	const route = applyRoute(src);
	for (const field of columns) {
		const cases = [["left out", undefined], ["null", null]];
		if (required.includes(field)) cases.push(["empty", ""]);
		for (const [how, value] of cases) {
			const body = realForm();
			if (value === undefined) delete body[field];
			else body[field] = value;
			const before = route.count();
			const got = route.call(body);
			r.t(got.status === 400 && JSON.stringify(got.body) === MISSING_400(field) && route.count() === before,
				`${field} ${how}: 400 ${MISSING_400(field)}, nothing stored (got ${got.status} ${JSON.stringify(got.body)})`);
		}
	}
	for (const [how, skills] of [["blank, as the form sends it", ""], ["answered", "QA-TEST forklift"]]) {
		const got = route.call(realForm({ skills }));
		const row = got.body && route.db.prepare("SELECT skills FROM job_applications WHERE id = ?").get(got.body.id);
		r.t(got.status === 200 && row && row.skills === skills, `skills ${how}: 200, stored as sent (got ${got.status} ${JSON.stringify(got.body)})`);
	}
	const nothing = route.call({});
	r.t(nothing.status === 400 && JSON.stringify(nothing.body) === MISSING_400("full_name"), "nothing sent: the first field in the list is named");
	const code = codeOnly(routeSource("post", "/api/public/apply", src));
	const at = code.indexOf("const missingField = publicApplyMissingField(req.body);");
	r.t(at >= 0 && at < code.indexOf("publicFormInput.checkPublicScalars(") && at < code.indexOf("db.prepare(") &&
		at < code.indexOf("sendEmail(") && at < code.indexOf("logAudit("),
	"the required fields are checked first, before the first query, audit row or email");
	return r;
}

// ===========================================================================
// §4 what the driver's W-9 prints, from the shipped fillW9Form()
// ===========================================================================
const FILL_SRC = liftFunction("async function fillW9Form(");
const SSN_BOXES = ["topmostSubform[0].Page1[0].f1_11[0]", "topmostSubform[0].Page1[0].f1_12[0]", "topmostSubform[0].Page1[0].f1_13[0]"];
const EIN_BOXES = ["topmostSubform[0].Page1[0].f1_14[0]", "topmostSubform[0].Page1[0].f1_15[0]"];

// The real pdf-lib on the real template, recording what each field is given.
async function driverW9(einSsn) {
	const set = {};
	const PdfLibDocument = {
		load: async (bytes) => {
			const doc = await pdfLib.PDFDocument.load(bytes);
			const form = doc.getForm();
			const real = form.getTextField.bind(form);
			form.getTextField = (name) => {
				const f = real(name);
				const setText = f.setText.bind(f);
				f.setText = (v) => { set[name] = v; return setText(v); };
				return f;
			};
			return doc;
		},
	};
	const fill = new Function("path", "fs", "__dirname", "PdfLibDocument", "StandardFonts", "rgb", "imageLimits", "console",
		`"use strict";\n${FILL_SRC}\nreturn fillW9Form;`)(path, fs, ROOT, PdfLibDocument, pdfLib.StandardFonts, pdfLib.rgb, imageLimits, QUIET);
	// pdf-lib's own notice about the template's XFA data, on every load.
	const warn = console.warn;
	console.warn = () => {};
	try {
		// As GET /api/onboarding/documents/w9/pdf calls it (asserted below).
		const bytes = await fill({ legalName: "QA-TEST Driver", entityType: "Sole Prop", address: "1 QA Test Way, Testville, TX 77001", einSsn, effectiveDate: "September 30, 2026" });
		return { bytes: bytes ? bytes.length : 0, set };
	} catch (e) {
		return { code: e.code, message: e.message, set };
	} finally {
		console.warn = warn;
	}
}

async function printRows() {
	const r = rows();
	const driverCalls = SRC.split('entityType: "Sole Prop",').length - 1;
	const previewRoute = codeOnly(routeSource("get", "/api/onboarding/documents/:docKey/pdf"));
	r.t(driverCalls === 2 && /entityType: "Sole Prop",\n\s*address: application\?\.address \|\| "",\n\s*einSsn: application\?\.ssn \|\| "",/.test(previewRoute),
		"the driver's W-9 (preview and signed) is filled as Sole Prop from the SSN this route stored");
	for (const [label, value, accepted] of SSN_TABLE) {
		if (!accepted) continue;
		const o = await driverW9(value);
		const d = value.replace(/\D/g, "");
		r.t(o.bytes > 1000 && SSN_BOXES.map((n) => o.set[n]).join("|") === [d.slice(0, 3), d.slice(3, 5), d.slice(5)].join("|") &&
			EIN_BOXES.every((n) => o.set[n] === undefined),
		`${label}: the W-9 renders with 3-2-4 in the SSN boxes and nothing in the EIN boxes (got ${JSON.stringify(o).slice(0, 200)})`);
	}
	const ten = await driverW9("123-45-67890");
	r.t(ten.code === "DOCUMENT_VALUE_TOO_LONG", `ten digits: the fill refuses (the preview's 500), so the route must (got ${ten.code})`);
	const eight = await driverW9("123-45-678");
	r.t(eight.bytes > 1000 && SSN_BOXES.map((n) => eight.set[n]).join("|") === "123|45|678",
		"eight digits: the fill prints 123-45-678, so the route must refuse it");
	return r;
}

// ===========================================================================
// §5 /apply step 1, lifted from the SFCs and executed
// ===========================================================================
function liftFn(src, head) {
	const a = src.indexOf(head);
	if (a < 0) die(`function not found: ${head}`);
	return src.slice(a, src.indexOf("\n}\n", a) + 2);
}
const STEP0 = {
	first_name: "QA-TEST", last_name: "Driver", email: "qa-test@example.com", phone: "(555) 555-0100", dob: "1990-01-01",
	address: "1 QA Test Way", city: "Testville", state: "TX", zip: "77001", ssn: "123-45-6789", drivers_license: "QA-TEST-DL",
	position: "Company Driver", hazmat: "No", cdl_front: PDF, cdl_back: PDF, medical_card: PDF,
};

async function stepRows({ view = APPLY_VIEW_SRC, step = STEP_SRC, client = CLIENT_SRC } = {}) {
	const r = rows();
	const { checkEmail } = await import(pathToFileURL(EMAIL_PATH).href);
	const { checkSsn } = loadClient(client);
	r.t(/\nimport \{ checkSsn \} from '\.\.\/lib\/taxId'\n/.test(view), "ApplyView imports the client's copy of the rule");
	const validate = new Function("form", "checkEmail", "checkSsn", `"use strict";\n${liftFn(view, "function validate(s) {")}\nreturn validate;`);
	for (const [label, value, accepted] of SSN_TABLE) {
		if (typeof value !== "string" || value.length > 1000) continue;
		const got = validate({ ...STEP0, ssn: value }, checkEmail, checkSsn)(0);
		r.t(accepted ? got === "" : got === SSN_MESSAGE, `step 1, ${label}: ${accepted ? "continues" : "stops with the message"} (got ${JSON.stringify(got)})`);
	}
	r.t(validate({ ...STEP0, ssn: "" }, checkEmail, checkSsn)(0) === "Please fill in all required fields in this section.",
		"step 1 with no SSN still asks for the required fields first");

	r.t(/\nimport \{ checkSsn \} from '\.\.\/\.\.\/lib\/taxId'\n/.test(step), "StepPersonalInfo imports the client's copy of the rule");
	const a = step.indexOf("const ssnCheck = computed(");
	const b = step.indexOf("\n", step.indexOf("const showSsnError = computed("));
	if (a < 0 || b < 0) die("StepPersonalInfo: the SSN check not found");
	const computed = (fn) => ({ get value() { return fn(); } });
	const ref = (v) => ({ value: v });
	const inline = (ssn) => new Function("props", "computed", "ref", "checkSsn",
		`"use strict";\n${step.slice(a, b)}\nreturn { ssnCheck, ssnFocused, showSsnError };`)({ form: { ssn } }, computed, ref, checkSsn);
	const ten = inline("123-45-67890");
	ten.ssnFocused.value = true;
	r.t(ten.showSsnError.value === false, "a ten-digit SSN: no message while the applicant is still typing");
	ten.ssnFocused.value = false;
	r.t(ten.showSsnError.value === true && ten.ssnCheck.value.message === SSN_MESSAGE, "…the message once they leave the field");
	r.t(inline("123-45-6789").showSsnError.value === false && inline("").showSsnError.value === false,
		"a valid SSN, or none yet, shows no message");
	r.t(step.includes(":aria-invalid=\"showSsnError ? 'true' : 'false'\"") &&
		step.includes(":aria-describedby=\"showSsnError ? 'apply-ssn-error' : undefined\"") &&
		step.includes('@focus="ssnFocused = true" @blur="ssnFocused = false"') &&
		step.includes('<p v-if="showSsnError" id="apply-ssn-error" class="field-error" role="alert">{{ ssnCheck.message }}</p>'),
	"the SSN input names its message, and the message renders under it");
	return r;
}

// ===========================================================================
// §6 mutants
// ===========================================================================
async function mutantRows() {
	const r = rows();
	const shapeDropped = loadLib(swap(LIB_SRC, "if (!tin.ok || !SSN_SHAPE_RE.test(raw)) return", "if (!tin.ok) return"));
	r.t(failed(ssnSection(shapeDropped)), "MUTANT checkW9Ssn() without the SSN shape (an EIN's shape accepted): caught by §1");
	r.t(failed(await clientSsnSection(swap(CLIENT_SRC, "if (!checkTin(raw).ok || !SSN_SHAPE_RE.test(raw)) return", "if (!checkTin(raw).ok) return"))),
		"MUTANT the client's copy drifts to any TIN (an EIN's shape accepted): caught by §2");
	const noRouteCheck = swap(SRC, "const ssnCheck = w9Input.checkW9Ssn(ssn);", "const ssnCheck = { ok: true };");
	r.t(failed(routeSsnRows(noRouteCheck)), "MUTANT the route's SSN check removed (ten digits stored, the old form): caught by §3");
	r.t(failed(await stepRows({ view: swap(APPLY_VIEW_SRC, "    if (!ssn.ok) return ssn.message\n", "") })),
		"MUTANT step 1 continues past an invalid SSN: caught by §5");
	r.t(failed(await stepRows({ step: swap(STEP_SRC, "!!props.form.ssn && !ssnCheck.value.ok && !ssnFocused.value", "false") })),
		"MUTANT the message under the SSN field never shows: caught by §5");
	const skillsUnchecked = swap(SRC, 'const PUBLIC_APPLY_PRESENT_FIELDS = ["skills"];', "const PUBLIC_APPLY_PRESENT_FIELDS = [];");
	r.t(failed(requiredRows(skillsUnchecked)), "MUTANT skills left to the INSERT (the old 500): caught by §3");
	const shortList = swap(SRC, '"accident_history", "signature",\n];', '"accident_history",\n];');
	r.t(failed(requiredRows(shortList)), "MUTANT a NOT NULL column missing from the lists: caught by §3");
	return r;
}

function record(r) {
	for (const x of r) ok(x.ok, x.name);
	console.log(`  ${r.filter((x) => x.ok).length}/${r.length} checks`);
}

(async () => {
	section("§1 checkW9Ssn(): nine digits, written as an SSN");
	record(ssnSection());
	section("§2 the client's copy of the SSN rule says the same");
	record(await clientSsnSection());
	section("§3 POST /api/public/apply, executed on a real job_applications table");
	record(routeSsnRows());
	record(realFormRows());
	record(requiredRows());
	section("§4 the driver's W-9, from the shipped fillW9Form()");
	record(await printRows());
	section("§5 /apply step 1, executed");
	record(await stepRows());
	section("§6 mutants");
	record(await mutantRows());
	if (failures.length) {
		console.error(`\nFAILURES (${failures.length}):`);
		for (const f of failures) console.error(`  x ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\nall ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
