#!/usr/bin/env node
/**
 * scripts/test-driver-docs-current-holder.js — a load's documents follow the
 * driver they are filed under (2026-10-22).
 *
 * A Driver sees a load document only when the load is his today
 * (loadBelongsToDriver(), unchanged) AND the row is filed under him
 * (documentFiledUnder(): documents.driver against his name, case and spacing
 * folded). After a reassignment the earlier driver's documents are office-only,
 * and so is a row filed under no one. Super Admin and Dispatcher are not
 * narrowed; the investor side is not changed here.
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 GET /api/documents/:loadId — the shipped registration, lifted whole, over
 *      the real requireRole, loadBelongsToDriver and sentIfLoadOwnershipUnverified,
 *      an in-memory documents table built from server.js's own CREATE TABLE and
 *      ALTER TABLE statements, and a canned Job Tracking.
 *   §2 guardRootLoadDocument (the /uploads root files), lifted with the real
 *      driverOwnsAnyLoad: a Driver opens a file only through a row that is BOTH
 *      filed under him AND on a load he holds — the same row, not one of each.
 *   §3 list/open parity: for each driver, every file his panels list opens, and
 *      no other file does.
 *   §4 GET /api/driver/:driverName per-load counts: _podCount stays per load
 *      (every live POD, any letter case — the server's Delivered rule); the
 *      other four count only what his Documents panel lists.
 *   §5 POST /api/documents/upload records the uploader's user id and role on
 *      each new row; neither the load panel nor the investor portal sends them.
 *   §6 documentFiledUnder() itself.
 *   §7 DISCRIMINATION: each surface with its filed-driver clause removed (and the
 *      helper's own clauses) must flip an assertion; source pins.
 *
 * Pure: no server, no port, no app.db, no network, no files on disk. Made-up
 * names only.
 *
 * Run: node scripts/test-driver-docs-current-holder.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
}
function fatal(msg) { console.error(`FAIL  ${msg}`); process.exit(1); }

// --- lifting ---------------------------------------------------------------
// A top-level `function name(` (or `async function name(`) up to the first line
// that is exactly "}".
function hasFn(name) {
	return SRC.includes(`\nfunction ${name}(`) || SRC.includes(`\nasync function ${name}(`);
}
function liftFn(name, src = SRC) {
	let a = src.indexOf(`\nfunction ${name}(`);
	if (a < 0) a = src.indexOf(`\nasync function ${name}(`);
	if (a < 0) fatal(`could not locate function ${name} in server.js`);
	const b = src.indexOf("\n}\n", a);
	if (b < 0) fatal(`could not locate the end of function ${name} in server.js`);
	return src.slice(a + 1, b + 2);
}
// Anchored at a line start: comments quote these registrations.
function routeSource(verb, routePath) {
	const nl = SRC.indexOf(`\napp.${verb}("${routePath}"`);
	if (nl < 0) fatal(`route not found: ${verb.toUpperCase()} ${routePath}`);
	let depth = 0;
	for (let j = SRC.indexOf("(", nl + 1); j < SRC.length; j++) {
		if (SRC[j] === "(") depth++;
		else if (SRC[j] === ")") { depth--; if (depth === 0) return SRC.slice(nl + 1, j + 1); }
	}
	throw new Error(`unbalanced parens extracting ${routePath}`);
}
// Replace exactly one occurrence, or fail loudly: a mutant whose target is gone
// would run the ORIGINAL code and "pass", proving nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) fatal(`mutant target found ${n}x (expected 1): ${from.slice(0, 70)}`);
	return src.replace(from, to);
}
const constLine = (name) => {
	const m = SRC.match(new RegExp(`\\nconst ${name} = [^\\n]*;\\n`));
	if (!m) fatal(`${name} not found in server.js`);
	return m[0];
};

const requireRole = new Function(`${liftFn("requireRole")}\nreturn requireRole;`)();
const requireAuth = new Function(`${liftFn("requireAuth")}\nreturn requireAuth;`)();
const normalizeDriverName = new Function(`${liftFn("normalizeDriverName")}\nreturn normalizeDriverName;`)();
const findCol = new Function(`${liftFn("findCol")}\nreturn findCol;`)();
const sentIfLoadOwnershipUnverified = new Function(`${liftFn("sentIfLoadOwnershipUnverified")}\nreturn sentIfLoadOwnershipUnverified;`)();
const resolveDriverActor = new Function("normalizeDriverName",
	`${liftFn("resolveDriverActor")}\nreturn resolveDriverActor;`)(normalizeDriverName);
const isRateConDocType = new Function(`${liftFn("isRateConDocType")}\nreturn isRateConDocType;`)();
const uploadDocTypeFor = new Function(`${liftFn("uploadDocTypeFor")}\nreturn uploadDocTypeFor;`)();
const { RATECON_DOCUMENT_SQL, LOAD_PANEL_DOCUMENT_FILTER } = new Function(
	`${constLine("RATECON_DOCUMENT_SQL")}${constLine("LOAD_PANEL_DOCUMENT_FILTER")}return { RATECON_DOCUMENT_SQL, LOAD_PANEL_DOCUMENT_FILTER };`)();

// The helper. Before this change server.js has none (and its routes call none),
// so its absence is one failure here and every route runs as shipped.
const HELPER_SRC = hasFn("documentFiledUnder") ? liftFn("documentFiledUnder") : null;
const buildHelper = (src = HELPER_SRC, norm = normalizeDriverName) => (src
	? new Function("normalizeDriverName", `${src}\nreturn documentFiledUnder;`)(norm)
	: () => true);
const documentFiledUnder = buildHelper();

const quiet = { log() {}, warn() {}, error() {} };

// --- fixtures --------------------------------------------------------------
// L-300 was Driver A's and is Driver B's now (reassigned). L-301 has two Job
// Tracking rows, one per driver: both hold it today. L-302 is Driver A's alone.
// L-303 is Driver B's, spelled differently in the sheet.
const JT = {
	headers: ["Load ID", "Driver", "Job Status"],
	data: [
		{ _rowIndex: 2, "Load ID": "L-300", Driver: "Driver B", "Job Status": "Delivered" },
		{ _rowIndex: 3, "Load ID": "L-301", Driver: "Driver A", "Job Status": "In Transit" },
		{ _rowIndex: 4, "Load ID": "L-301", Driver: "Driver B", "Job Status": "In Transit" },
		{ _rowIndex: 5, "Load ID": "L-302", Driver: "Driver A", "Job Status": "Assigned" },
		{ _rowIndex: 6, "Load ID": "L-303", Driver: "driver  B", "Job Status": "In Transit" },
	],
};
const sheet = { fail: false, reads: 0 };

const F = {
	A_POD: "L-300_POD_A.pdf",          // the earlier driver's POD, with OCR text
	B_BOL: "L-300_BOL_B.pdf",          // the current driver's own
	B_RCPT: "L-300_Receipt_b.pdf",     // his own, filed in another case and spacing
	BLANK: "L-300_Other_blank.pdf",    // filed under no one
	RC: "L-300.pdf",                   // the rate-con archive (Super Admin only)
	RC_B: "L-300_RateCon_B.pdf",       // a rate con filed under the current driver
	B_GONE: "L-300_BOL_gone.pdf",      // his own, soft-deleted
	A_301: "L-301_Other_A.pdf",        // two holders: each sees his own
	B_301: "L-301_Other_B.pdf",
	B_302: "L-302_BOL_B.pdf",          // filed under B on a load B does not hold
	A_303_POD: "L-303_POD_a.pdf",      // a POD typed in lower case, filed under A, on B's load
	SHARED: "SHARED_BOL.pdf",          // one name: an A row on L-300 and a B row on L-303
	CROSS: "CROSS_Other.pdf",          // one name: an A row on B's load and a B row on A's load
};
const OCR_A = "MADE-UP OCR TEXT OF THE EARLIER DRIVER";
const OCR_B = "MADE-UP OCR TEXT OF THE CURRENT DRIVER";

// The documents table exactly as server.js builds it: its CREATE TABLE, then
// every ALTER TABLE documents ADD COLUMN it runs, in file order.
function makeDocDb() {
	const db = new Database(":memory:");
	const create = SRC.match(/CREATE TABLE IF NOT EXISTS documents \([\s\S]*?\n\t\)/);
	if (!create) fatal("CREATE TABLE documents not found in server.js");
	db.exec(create[0]);
	for (const m of SRC.matchAll(/ALTER TABLE documents ADD COLUMN [^"`\n]+/g)) {
		try { db.exec(m[0]); } catch { /* a column added twice, as the boot's try/catch allows */ }
	}
	const add = db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_url, ocr_text, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
	const row = (load, driver, type, name, { ocr = "", deleted = null, url = `/uploads/${name}` } = {}) => add.run(load, driver, type, name, url, ocr, deleted);
	row("L-300", "Driver A", "POD", F.A_POD, { ocr: OCR_A });
	row("L-300", "Driver B", "BOL", F.B_BOL);
	row("L-300", "driver  b", "Receipt", F.B_RCPT, { ocr: OCR_B });
	row("L-300", "", "Other", F.BLANK);
	row("L-300", "", "RATECON", F.RC, { url: `/uploads/rate-cons/${F.RC}` });
	row("L-300", "Driver B", "Rate Con", F.RC_B);
	row("L-300", "Driver B", "BOL", F.B_GONE, { deleted: "2026-10-01 12:00:00" });
	row("L-301", "Driver A", "Other", F.A_301);
	row("L-301", "Driver B", "Other", F.B_301);
	row("L-302", "Driver B", "BOL", F.B_302);
	row("L-303", "Driver A", "pod", F.A_303_POD);
	row("L-300", "Driver A", "BOL", F.SHARED);
	row("L-303", "Driver B", "BOL", F.SHARED);
	row("L-300", "Driver A", "Other", F.CROSS);
	row("L-302", "Driver B", "Other", F.CROSS);
	return db;
}
const docDb = makeDocDb();
const counters = { prepared: [] };
const docDbRecorded = { prepare(sql) { counters.prepared.push(sql); return docDb.prepare(sql); } };
const lastDoc = () => docDb.prepare("SELECT * FROM documents ORDER BY id DESC LIMIT 1").get();
const FILE_NAMES = docDb.prepare("SELECT DISTINCT file_name FROM documents ORDER BY file_name").all().map((r) => r.file_name);

// The real ownership check over the canned sheet; `sheet.fail` makes the read throw.
const loadBelongsToDriver = new Function(
	"getDeletedLoadIds", "getJobTrackingCached", "findCol", "normalizeDriverName", "ownershipUnverified",
	`${liftFn("loadBelongsToDriver")}\nreturn loadBelongsToDriver;`,
)(
	() => new Set(),
	async () => { sheet.reads++; if (sheet.fail) throw new Error("Job Tracking read failed (test)"); return JT; },
	findCol,
	normalizeDriverName,
	() => null,
);
const driverOwnsAnyLoad = new Function("loadBelongsToDriver",
	`${liftFn("driverOwnsAnyLoad")}\nreturn driverOwnsAnyLoad;`)(loadBelongsToDriver);

// Execute a registration against a capturing `app`, returning its chain.
function buildRoute(verb, routePath, deps, routeSrc = routeSource(verb, routePath)) {
	const names = Object.keys(deps);
	let captured = null;
	const app = { [verb]: (p, ...chain) => { captured = { path: p, chain }; } };
	new Function("app", ...names, `${routeSrc};`)(app, ...names.map((n) => deps[n]));
	if (!captured || captured.path !== routePath) fatal(`the lifted registration did not register ${routePath}`);
	return { path: routePath, chain: captured.chain };
}
async function call(route, { user, method = "GET", params = {}, body = {} }) {
	const req = {
		method, url: route.path, originalUrl: route.path, path: route.path, params, body, query: {},
		headers: { "x-requested-with": "XMLHttpRequest" },
		route: { path: route.path },
		session: user ? { user: { ...user } } : {},
	};
	const res = {
		statusCode: 200, body: undefined,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
		setHeader() {},
		end() { return this; },
	};
	for (const mw of route.chain) {
		let next = false;
		await mw(req, res, () => { next = true; });
		if (!next) break;
	}
	return { status: res.statusCode, body: res.body };
}

const SUPER = { id: 1, role: "Super Admin", username: "super_admin", driverName: "" };
const DISPATCH = { id: 4, role: "Dispatcher", username: "dispatch1", driverName: "" };
const INVESTOR = { id: 5, role: "Investor", username: "investor1", driverName: "" };
const DA = { id: 10, role: "Driver", username: "LogisX-2001", driverName: "Driver A" };
const DB = { id: 11, role: "Driver", username: "LogisX-2002", driverName: "Driver B" };
const NAMELESS = { id: 12, role: "Driver", username: "LogisX-2003", driverName: "" };

// --- the three surfaces, buildable with a helper or a source of one's own -----
const listDeps = (over = {}) => ({
	requireRole, requireAuth, loadBelongsToDriver, sentIfLoadOwnershipUnverified, LOAD_PANEL_DOCUMENT_FILTER,
	documentFiledUnder, db: docDbRecorded, console: quiet, ...over,
});
const LIST_SRC = routeSource("get", "/api/documents/:loadId");
const buildList = (over, src = LIST_SRC) => buildRoute("get", "/api/documents/:loadId", listDeps(over), src);

const GUARD_SRC = liftFn("guardRootLoadDocument");
const buildGuard = (over = {}, src = GUARD_SRC) => {
	const deps = {
		db: docDb, RATECON_DOCUMENT_SQL, LOAD_PANEL_DOCUMENT_FILTER, driverOwnsAnyLoad, sentIfLoadOwnershipUnverified,
		investorDocumentScope: () => null, documentFiledUnder, console: quiet, ...over,
	};
	const names = Object.keys(deps);
	return new Function(...names, `${src}\nreturn guardRootLoadDocument;`)(...names.map((n) => deps[n]));
};
async function guardCall(guard, user, file) {
	let status = null, nexted = false, body;
	const res = {
		headersSent: false, statusCode: 200, setHeader() {},
		status(c) { status = c; return this; }, end() { return this; }, json(b) { body = b; return this; },
	};
	await guard({ session: { user } }, res, () => { nexted = true; }, file);
	return { status, nexted, body };
}

const DRIVER_SRC = routeSource("get", "/api/driver/:driverName");
// The driver route reads many tables; only `documents` matters here, so every
// other statement answers empty.
const driverDb = {
	prepare(sql) {
		if (/\bFROM documents\b/.test(sql)) return docDb.prepare(sql);
		return { all: () => [], get: () => undefined, run: () => ({}) };
	},
};
const driverDeps = (over = {}) => ({
	requireRole, requireAuth, normalizeDriverName, findCol,
	sanitizeBrokerColumns: (headers, rows) => rows,
	findDirectoryRowForDriver: () => null,
	findTruckForDriver: () => null,
	db: driverDb,
	getJobTrackingCached: async () => JT,
	liveJobTrackingView: (jt) => ({ ...jt, headers: [...jt.headers], data: jt.data.map((x) => ({ ...x })) }),
	getCarrierDBFromSQLite: () => ({ headers: ["Driver"], data: [] }),
	computeDriverQueues: () => ({}),
	withExpenseWindows: (rows) => rows.map((x) => ({ ...x })),
	stripSigningEvidence: (rows) => rows,
	personalSummaryByExpense: () => Object.create(null),
	personalSummaryForRole: () => null,
	personalLinesForInvoices: () => new Map(),
	ONBOARDING_DOCS: [],
	DRIVER_TIME_OFF_SCREEN_ENABLED: false,
	driverInstructions: { annotateDriverLoads() {} },
	LOAD_PANEL_DOCUMENT_FILTER,
	documentFiledUnder,
	console: quiet,
	...over,
});
const buildDriver = (over, src = DRIVER_SRC) => buildRoute("get", "/api/driver/:driverName", driverDeps(over), src);

const names = (r) => (r.body && Array.isArray(r.body.documents) ? r.body.documents.map((d) => d.file_name).sort().join() : "");
const brief = (r) => `status ${r.status}, body ${JSON.stringify(r.body).slice(0, 300)}`;
const sorted = (...xs) => [...xs].sort().join();

(async () => {
	ok("server.js defines documentFiledUnder() (the one copy of the filed-driver rule)", !!HELPER_SRC);

	// =========================================================================
	console.log("\n§1  GET /api/documents/:loadId — each driver lists only what is filed under him");
	// =========================================================================
	const list = buildList();
	const listAs = async (user, loadId) => { counters.prepared.length = 0; sheet.reads = 0; return call(list, { user, params: { loadId } }); };
	let r;

	r = await listAs(DB, "L-300");
	ok("Driver B (holds L-300 today): exactly his own two documents, the one filed in another case and spacing included",
		r.status === 200 && names(r) === sorted(F.B_BOL, F.B_RCPT), brief(r));
	ok("...no row, link or OCR text of Driver A's POD, of a row filed under no one, or of a rate con",
		r.status === 200 && ![F.A_POD, F.BLANK, F.RC, F.RC_B, F.SHARED, F.CROSS, OCR_A].some((s) => JSON.stringify(r.body).includes(s)), brief(r));
	ok("...his own OCR text still comes with his own receipt",
		r.status === 200 && (r.body.documents.find((d) => d.file_name === F.B_RCPT) || {}).ocr_text === OCR_B, brief(r));
	r = await listAs(DA, "L-300");
	ok("Driver A (held L-300 earlier): 403, the documents table never read (no access after a reassignment)",
		r.status === 403 && r.body.error === "This load is not assigned to you" && counters.prepared.length === 0, brief(r));
	for (const [label, user] of [["Super Admin", SUPER], ["Dispatcher", DISPATCH]]) {
		r = await listAs(user, "L-300");
		ok(`${label}: every live non-rate-con row on L-300, whoever it is filed under, no ownership read`,
			r.status === 200 && names(r) === sorted(F.A_POD, F.B_BOL, F.B_RCPT, F.BLANK, F.SHARED, F.CROSS) && sheet.reads === 0, brief(r));
	}
	r = await listAs(INVESTOR, "L-300");
	ok("Investor: 403 Forbidden at the mount, nothing read", r.status === 403 && r.body.error === "Forbidden" && counters.prepared.length === 0, brief(r));
	r = await listAs(NAMELESS, "L-300");
	ok("a Driver session with no name: 403, nothing listed", r.status === 403 && counters.prepared.length === 0, brief(r));

	r = await listAs(DA, "L-301");
	ok("L-301 has a Job Tracking row for each driver: Driver A sees only his own", r.status === 200 && names(r) === F.A_301, brief(r));
	r = await listAs(DB, "L-301");
	ok("...and Driver B only his", r.status === 200 && names(r) === F.B_301, brief(r));
	r = await listAs(DB, "L-302");
	ok("Driver B, a load he does not hold (a row there is filed under him): 403, nothing read",
		r.status === 403 && counters.prepared.length === 0, brief(r));
	r = await listAs(DB, "L-303");
	ok("Driver B, L-303: his own row of the shared name only, not Driver A's POD on his load",
		r.status === 200 && names(r) === F.SHARED, brief(r));

	sheet.fail = true;
	r = await listAs(DB, "L-300");
	sheet.fail = false;
	ok("Job Tracking unreadable: 503 LOAD_OWNERSHIP_UNVERIFIED, nothing listed, the documents table never read",
		r.status === 503 && r.body.code === "LOAD_OWNERSHIP_UNVERIFIED" && !("documents" in r.body) && counters.prepared.length === 0, brief(r));

	// =========================================================================
	console.log("\n§2  /uploads root files — the row must be filed under him AND on a load he holds");
	// =========================================================================
	const guard = buildGuard();
	const opens = async (user, file) => (await guardCall(guard, user, file)).nexted;
	const refused404 = async (user, file) => { const g = await guardCall(guard, user, file); return !g.nexted && g.status === 404; };

	ok("Driver B opens his own documents on L-300 (one filed in another case and spacing)",
		(await opens(DB, F.B_BOL)) && (await opens(DB, F.B_RCPT)));
	ok("Driver B is refused Driver A's POD on B's own load (404)", await refused404(DB, F.A_POD));
	ok("Driver B is refused a row filed under him on a load he does not hold (404)", await refused404(DB, F.B_302));
	ok("ONE name with an A row on B's load and a B row on A's load: 404 to B (the same row must satisfy both)",
		await refused404(DB, F.CROSS));
	ok("...and 404 to A (A holds L-302, but its row there is filed under B)", await refused404(DA, F.CROSS));
	ok("MEMBERSHIP kept: a name with an A row and a B row on B's load opens for B", await opens(DB, F.SHARED));
	ok("a file filed under no one: 404 to the current driver (office-only)", await refused404(DB, F.BLANK));
	ok("an A-filed POD typed in lower case on B's load: 404 to B", await refused404(DB, F.A_303_POD));
	ok("a rate con, even filed under him, and his own soft-deleted document: 404",
		(await refused404(DB, F.RC_B)) && (await refused404(DB, F.RC)) && (await refused404(DB, F.B_GONE)));
	ok("Driver A keeps no access to his POD on the reassigned load (404)", await refused404(DA, F.A_POD));
	ok("on L-301 (both hold it), each opens only his own",
		(await opens(DA, F.A_301)) && (await refused404(DA, F.B_301)) && (await opens(DB, F.B_301)) && (await refused404(DB, F.A_301)));
	ok("a Driver session with no name is refused", await refused404(NAMELESS, F.BLANK));
	sheet.fail = true;
	const unk = await guardCall(guard, DB, F.B_BOL);
	sheet.fail = false;
	ok("Job Tracking unreadable: 503 LOAD_OWNERSHIP_UNVERIFIED for a file filed under him, never served",
		!unk.nexted && unk.status === 503 && unk.body && unk.body.code === "LOAD_OWNERSHIP_UNVERIFIED");
	ok("Dispatcher and Super Admin unchanged: any non-rate-con root file opens, whoever it is filed under",
		(await opens(DISPATCH, F.A_POD)) && (await opens(DISPATCH, F.BLANK)) && (await opens(SUPER, F.A_POD)));

	// =========================================================================
	console.log("\n§3  list/open parity — what a driver's panels list is exactly what he opens");
	// =========================================================================
	for (const user of [DA, DB]) {
		const held = [...new Set(JT.data.filter((x) => normalizeDriverName(x.Driver) === normalizeDriverName(user.driverName)).map((x) => x["Load ID"]))];
		const listed = new Set();
		for (const loadId of held) {
			const res = await listAs(user, loadId);
			if (res.status === 200) for (const d of res.body.documents) listed.add(d.file_name);
		}
		const opened = new Set();
		for (const name of FILE_NAMES) if (await opens(user, name)) opened.add(name);
		const onlyListed = [...listed].filter((n) => !opened.has(n));
		const onlyOpened = [...opened].filter((n) => !listed.has(n));
		ok(`${user.driverName} (holds ${held.join(", ")}): lists ${listed.size}, opens the same ${opened.size}`,
			listed.size > 0 && onlyListed.length === 0 && onlyOpened.length === 0,
			`listed only: ${onlyListed.join(",") || "-"}; opened only: ${onlyOpened.join(",") || "-"}`);
	}

	// =========================================================================
	console.log("\n§4  GET /api/driver/:driverName — per-load document counts");
	// =========================================================================
	const driverRoute = buildDriver();
	const countsOf = (res, loadId) => {
		const load = (res.body && res.body.loads || []).find((l) => l["Load ID"] === loadId) || {};
		return { doc: load._docCount, pod: load._podCount, bol: load._bolCount, receipt: load._receiptCount, other: load._otherCount };
	};
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	r = await call(driverRoute, { user: DB, params: { driverName: "Driver B" } });
	ok("Driver B's page loads", r.status === 200 && Array.isArray(r.body.loads) && r.body.loads.length === 3, brief(r));
	let c = countsOf(r, "L-300");
	ok("L-300: _podCount = 1 (Driver A's POD: the Delivered step follows the load, as the server's POD rule does)",
		c.pod === 1, JSON.stringify(c));
	ok("L-300: _docCount, _bolCount, _receiptCount, _otherCount count only his own (2, 1, 1, 0: no A rows, no blank-filed row, no rate con)",
		same(c, { doc: 2, pod: 1, bol: 1, receipt: 1, other: 0 }), JSON.stringify(c));
	c = countsOf(r, "L-301");
	ok("L-301 (two holders): only his own Other counts", same(c, { doc: 1, pod: 0, bol: 0, receipt: 0, other: 1 }), JSON.stringify(c));
	c = countsOf(r, "L-303");
	ok("L-303: a POD typed in lower case counts in _podCount (UPPER, as the server's POD rule reads it)", c.pod === 1, JSON.stringify(c));
	ok("L-303: his own BOL of the shared name is all the other counts see", same(c, { doc: 1, pod: 1, bol: 1, receipt: 0, other: 0 }), JSON.stringify(c));
	const asSuper = await call(driverRoute, { user: SUPER, params: { driverName: "Driver B" } });
	ok("Super Admin opening Driver B's page gets the same counts as Driver B",
		["L-300", "L-301", "L-303"].every((id) => same(countsOf(asSuper, id), countsOf(r, id))), brief(asSuper));
	r = await call(driverRoute, { user: DA, params: { driverName: "Driver A" } });
	ok("Driver A's page: L-301 counts his own Other, L-302 none of B's rows",
		same(countsOf(r, "L-301"), { doc: 1, pod: 0, bol: 0, receipt: 0, other: 1 }) &&
		same(countsOf(r, "L-302"), { doc: 0, pod: 0, bol: 0, receipt: 0, other: 0 }),
		`${JSON.stringify(countsOf(r, "L-301"))} ${JSON.stringify(countsOf(r, "L-302"))}`);

	// =========================================================================
	console.log("\n§5  POST /api/documents/upload — who uploaded, recorded and kept to the office");
	// =========================================================================
	const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 test document").toString("base64")}`;
	const upload = (loadId, docType, extra = {}) => ({ loadId, rowIndex: 2, photoData: PDF, fileType: "document", fileName: "scan.pdf", docType, ...extra });
	const io = { to: () => ({ emit() {}, except: () => ({ emit() {} }) }) };
	const up = buildRoute("post", "/api/documents/upload", {
		requireRole, requireAuth, driverWriteLimiter: (req, res, next) => next(),
		loadBelongsToDriver, sentIfLoadOwnershipUnverified, resolveDriverActor, uploadDocTypeFor, isRateConDocType,
		db: docDb,
		validateFileExt: () => true, verifyInlineServedBytes: () => null, isValidImageMagic: () => true,
		imageLimits: { checkImage: () => ({ ok: true }), LIMITS: {}, refusalBody: () => ({}) },
		imageToPdf: async () => Buffer.from("%PDF-"),
		path, __dirname: "/srv/logisx", DATA_DIR: "/srv/logisx",
		fs: { existsSync: () => true, mkdirSync: () => {}, writeFileSync: () => {} },
		io, emitLoadEventToDispatch: () => {}, emitDispatchNotice: () => {},
		insertDispatchNotification: { run: () => ({}) },
		setImmediate: () => {}, getSheets: async () => { throw new Error("not in this runner"); },
		SPREADSHEET_ID: "sheet-under-test", colLetter: () => "A", queueReceiptOcr: () => {},
		console: quiet,
	});
	const before = docDb.prepare("SELECT * FROM documents WHERE file_name = ?").get(F.A_POD);
	ok("rows written before the change keep no uploader (NULL = not recorded)",
		before && before.uploaded_by_user_id === null && before.uploaded_by_role === null,
		JSON.stringify(before && { id: before.uploaded_by_user_id, role: before.uploaded_by_role }));

	r = await call(up, { user: DB, method: "POST", body: upload("L-300", "BOL") });
	let row = lastDoc();
	ok("a Driver's upload records his user id and role, filed under his session name",
		r.status === 200 && row.uploaded_by_user_id === DB.id && row.uploaded_by_role === "Driver" && row.driver === "Driver B",
		`${brief(r)} row ${JSON.stringify(row && { driver: row.driver, id: row.uploaded_by_user_id, role: row.uploaded_by_role })}`);
	const driverUpload = row.id;

	r = await call(up, { user: DISPATCH, method: "POST", body: upload("L-300", "Other", { driverName: "Driver B" }) });
	row = lastDoc();
	ok("a Dispatcher's upload from the load panel records the Dispatcher, filed under the load's driver",
		r.status === 200 && row.uploaded_by_user_id === DISPATCH.id && row.uploaded_by_role === "Dispatcher" && row.driver === "Driver B",
		`${brief(r)} row ${JSON.stringify(row && { driver: row.driver, id: row.uploaded_by_user_id, role: row.uploaded_by_role })}`);
	const officeUpload = row.id;

	r = await call(up, { user: SUPER, method: "POST", body: upload("L-300", "BOL", { driverName: "" }) });
	row = lastDoc();
	ok("a Super Admin's upload naming no driver records the Super Admin, filed under no one",
		r.status === 200 && row.uploaded_by_user_id === SUPER.id && row.uploaded_by_role === "Super Admin" && row.driver === "",
		`${brief(r)} row ${JSON.stringify(row && { driver: row.driver, id: row.uploaded_by_user_id, role: row.uploaded_by_role })}`);
	const blankUpload = row.id;

	// By row id: two uploads in the same millisecond share a file name.
	const idOf = (name) => docDb.prepare("SELECT id FROM documents WHERE file_name = ?").get(name).id;
	const ids = (res) => (res.body && Array.isArray(res.body.documents) ? res.body.documents.map((d) => d.id).sort((a, b) => a - b).join() : "");
	r = await listAs(DB, "L-300");
	ok("Driver B now lists his own upload and the office's upload filed under him, and still not the blank-filed one",
		r.status === 200 && ids(r) === [idOf(F.B_BOL), idOf(F.B_RCPT), driverUpload, officeUpload].sort((a, b) => a - b).join() &&
		!r.body.documents.some((d) => d.id === blankUpload), brief(r));
	const noUploader = (docs) => Array.isArray(docs) && docs.length > 0 && docs.every((d) => !Object.keys(d).some((k) => /uploaded_by/.test(k)));
	ok("...and no document in the load panel carries who uploaded it (Driver)", noUploader(r.body.documents), brief(r));
	r = await listAs(SUPER, "L-300");
	ok("...nor in the Super Admin's view of the panel", noUploader(r.body.documents), brief(r));

	const scope = { sql: `LOWER(driver) IN (?) AND deleted_at IS NULL AND NOT (${RATECON_DOCUMENT_SQL})`, params: ["driver b"] };
	const inv = buildRoute("get", "/api/investor/documents", {
		requireRole, requireAuth, db: docDb, console: quiet,
		resolvePreviewUser: (req) => ({ sessionUser: req.session.user, effectiveUserId: req.session.user.id, effectiveUsername: req.session.user.username, isPreview: false, targetMissing: false }),
		investorDocumentScope: () => scope,
	});
	r = await call(inv, { user: INVESTOR });
	ok("the investor portal (unchanged scope) carries no uploader column", r.status === 200 && noUploader(r.body.documents), brief(r));
	r = await call(inv, { user: SUPER });
	ok("...nor does the Super Admin's view of it", r.status === 200 && noUploader(r.body.documents), brief(r));

	// =========================================================================
	console.log("\n§6  documentFiledUnder()");
	// =========================================================================
	const H = documentFiledUnder;
	ok("matches across letter case and spacing", H({ driver: "driver  b" }, "Driver B") === true && H({ driver: " DRIVER B " }, "driver b") === true);
	ok("another driver's row is not his", H({ driver: "Driver A" }, "Driver B") === false);
	ok("a blank name on either side matches nothing (blank-filed rows are office-only; a nameless session sees none)",
		H({ driver: "" }, "") === false && H({ driver: "" }, "Driver B") === false && H({ driver: "Driver B" }, "") === false &&
		H({ driver: "   " }, "  ") === false);
	ok("a missing row, driver or name is false, never a throw",
		H(null, "Driver B") === false && H({ driver: null }, "Driver B") === false && H({}, undefined) === false);

	// =========================================================================
	console.log("\n§7  DISCRIMINATION and source pins");
	// =========================================================================
	const always = () => true;
	r = await call(buildList({ documentFiledUnder: always }), { user: DB, params: { loadId: "L-300" } });
	ok("MUTANT the list without the filed-driver clause: Driver B lists Driver A's POD — so §1 is load-bearing",
		r.status === 200 && names(r).includes(F.A_POD), brief(r));
	ok("MUTANT the root guard without the filed-driver clause: Driver B opens Driver A's POD — so §2 is load-bearing",
		(await guardCall(buildGuard({ documentFiledUnder: always }), DB, F.A_POD)).nexted === true);
	r = await call(buildDriver({ documentFiledUnder: always }), { user: DB, params: { driverName: "Driver B" } });
	ok("MUTANT the counts without the filed-driver clause: Driver B's L-300 _docCount grows — so §4 is load-bearing",
		r.status === 200 && countsOf(r, "L-300").doc > 4, JSON.stringify(countsOf(r, "L-300")));
	const base = countsOf(await call(buildDriver(), { user: DB, params: { driverName: "Driver B" } }), "L-300");
	r = await call(buildDriver({ LOAD_PANEL_DOCUMENT_FILTER: "deleted_at IS NULL" }), { user: DB, params: { driverName: "Driver B" } });
	ok("MUTANT the counts without the panel filter: a rate con filed under him counts as Other — so §4's 0 is load-bearing",
		r.status === 200 && countsOf(r, "L-300").other === base.other + 1, `${JSON.stringify(base)} -> ${JSON.stringify(countsOf(r, "L-300"))}`);
	if (DRIVER_SRC.split("UPPER(type) = 'POD'").length === 2) {
		r = await call(buildDriver({}, mutate(DRIVER_SRC, "UPPER(type) = 'POD'", "type = 'POD'")), { user: DB, params: { driverName: "Driver B" } });
		ok("MUTANT _podCount matching the type exactly: L-303's lower-case POD is missed — so §4's UPPER is load-bearing",
			r.status === 200 && countsOf(r, "L-303").pod === 0, JSON.stringify(countsOf(r, "L-303")));
	} else {
		ok("the driver page's _podCount reads UPPER(type) = 'POD' exactly once", false);
	}
	if (HELPER_SRC) {
		const identity = (s) => (s == null ? "" : String(s));
		r = await call(buildList({ documentFiledUnder: buildHelper(HELPER_SRC, identity) }), { user: DB, params: { loadId: "L-300" } });
		ok("MUTANT the helper comparing names as stored: Driver B loses his own receipt — so the folding is load-bearing",
			r.status === 200 && !names(r).includes(F.B_RCPT), brief(r));
		const noBlank = buildHelper(mutate(HELPER_SRC, "if (!want) return false;", ""));
		ok("MUTANT the helper without its blank-name clause: a blank session matches a blank-filed row — so §6 is load-bearing",
			noBlank({ driver: "" }, "") === true);
	}
	const HELPER_CALL = "documentFiledUnder(";
	ok("exactly one definition of documentFiledUnder() in server.js", SRC.split("\nfunction documentFiledUnder(").length === 2);
	ok("the load panel, the root-file guard and the driver page's counts all call documentFiledUnder()",
		LIST_SRC.includes(HELPER_CALL) && GUARD_SRC.includes(HELPER_CALL) && DRIVER_SRC.includes(HELPER_CALL));
	ok("the driver page's counts read LOAD_PANEL_DOCUMENT_FILTER, as the panel and the guard do",
		DRIVER_SRC.includes("${LOAD_PANEL_DOCUMENT_FILTER}") && LIST_SRC.includes("${LOAD_PANEL_DOCUMENT_FILTER}") &&
		GUARD_SRC.includes("${LOAD_PANEL_DOCUMENT_FILTER}"));
	ok("the root guard still asks with .all() (file_name is not unique), never .get()",
		/\.all\(/.test(GUARD_SRC) && !/\.get\(/.test(GUARD_SRC));
	const INV_SRC = routeSource("get", "/api/investor/documents");
	const selects = (src) => src.match(/SELECT [\s\S]*?\bFROM documents\b/g) || [];
	ok("neither the load panel nor the investor portal selects an uploader column (their SELECTs name their columns)",
		selects(LIST_SRC).length === 1 && selects(INV_SRC).length === 2 &&
		[...selects(LIST_SRC), ...selects(INV_SRC)].every((q) => !/uploaded_by/.test(q) && !/SELECT \*/.test(q)));
	ok("the server's Delivered POD rule is unchanged: any live POD on the load, any letter case",
		SRC.includes(`.prepare("SELECT COUNT(*) AS n FROM documents WHERE load_id = ? AND UPPER(type) = 'POD' AND deleted_at IS NULL")`));

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
