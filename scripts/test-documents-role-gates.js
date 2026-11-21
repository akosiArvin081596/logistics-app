#!/usr/bin/env node
/**
 * scripts/test-documents-role-gates.js — who may list and upload a load's
 * documents, and whose read flags a caller may set.
 *
 *   GET  /api/documents/:loadId    Super Admin, Dispatcher, or the load's Driver.
 *   POST /api/documents/upload     the same gate, mounted before the limiter; a
 *                                  Dispatcher or a Driver uploads only POD, BOL,
 *                                  Receipt or Other (400 DOC_TYPE_NOT_ALLOWED).
 *   PUT  /api/messages/read        Super Admin marks any message, a Dispatcher any
 *                                  but one in an investor conversation; every
 *                                  other caller only messages addressed to them.
 *   PUT  /api/notifications/read   Super Admin marks any notification; every
 *                                  other caller only notifications addressed to them.
 *   GET  /api/driver/:driverName   builds its `diagnostic` block for Super Admin only.
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 GET /api/documents/:loadId — the SHIPPED registration, lifted whole and
 *      executed over the real requireRole, loadBelongsToDriver and
 *      sentIfLoadOwnershipUnverified, an in-memory documents table and a canned
 *      Job Tracking: every role, and a refusal reads nothing.
 *   §2 POST /api/documents/upload — the same, plus the real resolveDriverActor
 *      and uploadDocTypeFor: every role, the type list per role, and a refusal
 *      writes no file, inserts no row, reads no sheet and spends no limiter budget.
 *      The pod-uploaded broadcast carries a document's link to Super Admins only
 *      (the rest of the dispatch room gets it without, 2026-10-21), and never a
 *      rate con's (rate cons are Super Admin only; isRateConDocType()).
 *   §3 the two read-flag routes over an in-memory SQLite: each role marks exactly
 *      the rows it may, and a caller with no name marks nothing.
 *   §4 GET /api/driver/:driverName: a Driver with no loads gets no diagnostic;
 *      Super Admin still does.
 *   §5 the callers the document gates were sized against.
 *   §6 DISCRIMINATION: one mutant per document gate, each required to flip.
 *   §7 POD and BOL photos shaped at upload (POD_UPLOAD_NORMALIZE_ENABLED,
 *      lib/pod-upload-shape.js) through the shipped upload route: guards that
 *      pass on the base by design (switch off, the file is byte for byte what
 *      the base's imageToPdf() writes; with it on, a PDF, a Receipt and an Other
 *      image as before, a CMYK or orientation-6 photo as it came, no stored file
 *      rewritten, the withheld list as it was, the session says nothing is on),
 *      the new behaviour (Letter pages under the budget, the row's counts and
 *      "unknown", one audit row, the list's count columns, the session's
 *      features), and one mutant per check.
 *
 * Pure: no server, no port, no app.db, no network, no fixtures on disk.
 *
 * Run: node scripts/test-documents-role-gates.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
}
function fatal(msg) { console.error(`FAIL  ${msg}`); process.exit(1); }

// --- lifting ---------------------------------------------------------------
// A top-level `function name(` (or `async function name(`) up to the first line
// that is exactly "}". Not a brace count: a brace inside a string or a regex
// would throw a naive counter off.
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

// The guards are self-contained by design (see the CSRF note in server.js), so
// each lifts into a bare Function with nothing injected.
const requireRole = new Function(`${liftFn("requireRole")}\nreturn requireRole;`)();
const requireAuth = new Function(`${liftFn("requireAuth")}\nreturn requireAuth;`)();
const normalizeDriverName = new Function(`${liftFn("normalizeDriverName")}\nreturn normalizeDriverName;`)();
const findCol = new Function(`${liftFn("findCol")}\nreturn findCol;`)();
const sentIfLoadOwnershipUnverified = new Function(`${liftFn("sentIfLoadOwnershipUnverified")}\nreturn sentIfLoadOwnershipUnverified;`)();
const resolveDriverActor = new Function("normalizeDriverName",
	`${liftFn("resolveDriverActor")}\nreturn resolveDriverActor;`)(normalizeDriverName);
const readFlagOwnName = new Function(`${liftFn("readFlagOwnName")}\nreturn readFlagOwnName;`)();
// Investor conversations are Super Admin only: the rule and who reads them.
const readsInvestorChats = new Function(`${liftFn("readsInvestorChats")}\nreturn readsInvestorChats;`)();
const INVESTOR_CHAT_SQL = (() => {
	const m = SRC.match(/\nconst INVESTOR_CHAT_SQL = (`[^`]*`);/);
	if (!m) fatal("could not locate INVESTOR_CHAT_SQL in server.js");
	return new Function(`return ${m[1]};`)();
})();
// The Documents-panel filter the list route shares with the /uploads root guard,
// and the rate-con fragment it is built from, evaluated from server.js so the
// lifted route runs with the shipped value.
const LOAD_PANEL_DOCUMENT_FILTER = (() => {
	const line = (name) => {
		const m = SRC.match(new RegExp(`\\nconst ${name} = [^\\n]*;\\n`));
		if (!m) throw new Error(`${name} not found in server.js`);
		return m[0];
	};
	return new Function(`${line("RATECON_DOCUMENT_SQL")}${line("LOAD_PANEL_DOCUMENT_FILTER")}return LOAD_PANEL_DOCUMENT_FILTER;`)();
})();
const isRateConDocType = new Function(`${liftFn("isRateConDocType")}\nreturn isRateConDocType;`)();
// Which rows a Driver's panel keeps: those filed under him (its own runner is
// scripts/test-driver-docs-current-holder.js).
const documentFiledUnder = new Function("normalizeDriverName",
	`${liftFn("documentFiledUnder")}\nreturn documentFiledUnder;`)(normalizeDriverName);
const UPLOAD_TYPE_SRC = liftFn("uploadDocTypeFor");
const buildUploadDocTypeFor = (src) => new Function(`${src}\nreturn uploadDocTypeFor;`)();

const quiet = { log() {}, warn() {}, error() {} };

// --- fixtures --------------------------------------------------------------
// L-100 is Desoren King's load, L-200 is Soren King's.
const JT = {
	headers: ["Load ID", "Driver", "Job Status"],
	data: [
		{ _rowIndex: 2, "Load ID": "L-100", Driver: "Desoren King", "Job Status": "In Transit" },
		{ _rowIndex: 3, "Load ID": "L-200", Driver: "Soren King", "Job Status": "Delivered" },
	],
};

// Every Job Tracking read and every statement prepared is counted, so "refused
// before any read" is asserted rather than assumed.
// `indexReads`: the list route's own Job Tracking read for a Dispatcher, which
// names the load as shown (WITHHELD LOAD KEYS); no ownership read.
const counters = { sheetReads: 0, indexReads: 0, prepared: [], limiter: 0, files: [], emits: 0, emitted: [] };
function resetCounters() {
	counters.sheetReads = 0;
	counters.indexReads = 0;
	counters.prepared.length = 0;
	counters.limiter = 0;
	counters.files.length = 0;
	counters.emits = 0;
	counters.emitted.length = 0;
}
const readsOf = () => counters.sheetReads + counters.prepared.length;

// The dispatch room, as socket.io has it (`except` included), recording each
// emit with its room and the room it leaves out; and the shipped per-role
// helpers the upload route sends through (Super Admins' own room in full, the
// rest of the dispatch room with the load named as shown and no Drive link).
const DOC_IO = {
	to: (room) => ({
		emit: (event, payload) => { counters.emits++; counters.emitted.push({ room, event, payload }); },
		except: (other) => ({ emit: (event, payload) => { counters.emits++; counters.emitted.push({ room, except: other, event, payload }); } }),
	}),
};
// The WITHHELD LOAD KEYS helpers both routes read the load ID through (and the
// per-role send names a key by), as shipped: flag off, no key named, so the ID
// as sent and no key served.
const KEY_HELPERS = require("./lib/withheld-load-key-lift").withheldLoadKeyHelpers(SRC);
const DISPATCH_EMIT_NAMES = ["emitDispatchByRole", "loadIdWithheldFor", "currentShownLoadIdIndex", "shownLoadIdIndex", "routeShownLoadIdIndex",
	"shownLoadId", "staffDispatchNotice", "emitDispatchNotice", "emitLoadEventToDispatch"];
const DISPATCH_EMITS = (() => {
	const re = SRC.match(/\nconst BROKER_WITHHELD_RE = (\/[^\n]*\/i);\n/);
	if (!re) fatal("BROKER_WITHHELD_RE not found in server.js");
	return new Function("io", "brokerContact", "BROKER_CONTACT_VALUE_REDACTION_ENABLED", "loadKeyFor",
		`const BROKER_WITHHELD_RE = ${re[1]};\nconst SHOWN_LOAD_ID_STATE = { latest: null };\n` +
		"const SHOWN_LOAD_ID_INDEX = Symbol(\"shownLoadIdIndex\");\nconst SHOWN_LOAD_ID_INDEXES = new WeakMap();\n" +
		`${DISPATCH_EMIT_NAMES.map((n) => liftFn(n)).join("\n")}\nreturn { ${DISPATCH_EMIT_NAMES.join(", ")} };`,
	)(DOC_IO, require("../lib/broker-contact"), true, KEY_HELPERS.loadKeyFor);
})();

// The real ownership check, over the canned sheet and an empty deleted_loads.
const loadBelongsToDriver = new Function(
	"getDeletedLoadIds", "getJobTrackingCached", "findCol", "normalizeDriverName", "ownershipUnverified",
	`${liftFn("loadBelongsToDriver")}\nreturn loadBelongsToDriver;`,
)(
	() => new Set(),
	async () => { counters.sheetReads++; return JT; },
	findCol,
	normalizeDriverName,
	() => null,
);

// One in-memory database for the document routes; prepare() is wrapped so each
// statement is recorded. The row counts below are read through the raw handle,
// which the wrapper does not see.
const docDb = new Database(":memory:");
docDb.exec(`
	CREATE TABLE documents (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		load_id TEXT NOT NULL, driver TEXT NOT NULL, type TEXT NOT NULL, file_name TEXT NOT NULL,
		drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '',
		uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, ocr_text TEXT DEFAULT '', deleted_at DATETIME DEFAULT NULL,
		uploaded_by_user_id INTEGER DEFAULT NULL, uploaded_by_role TEXT DEFAULT NULL,
		upload_pages INTEGER DEFAULT NULL, upload_page_sources TEXT DEFAULT NULL, upload_pages_scanned INTEGER DEFAULT NULL,
		upload_pages_not_scanned INTEGER DEFAULT NULL, upload_pages_recompressed INTEGER DEFAULT NULL,
		upload_bytes_before INTEGER DEFAULT NULL, upload_bytes_after INTEGER DEFAULT NULL, upload_pages_left_large INTEGER DEFAULT NULL
	);
	INSERT INTO documents (load_id, driver, type, file_name, drive_url) VALUES
		('L-100', 'Desoren King', 'POD', 'L-100_POD_1.pdf', '/uploads/L-100_POD_1.pdf'),
		('L-100', 'Desoren King', 'BOL', 'L-100_BOL_2.pdf', '/uploads/L-100_BOL_2.pdf'),
		('L-100', '', 'RATECON', 'L-100.pdf', '/uploads/rate-cons/L-100.pdf'),
		('L-200', 'Soren King', 'POD', 'L-200_POD_3.pdf', '/uploads/L-200_POD_3.pdf');
`);
const docDbRecorded = {
	prepare(sql) { counters.prepared.push(sql); return docDb.prepare(sql); },
};
const docRowCount = () => docDb.prepare("SELECT COUNT(*) AS n FROM documents").get().n;
const lastDoc = () => docDb.prepare("SELECT * FROM documents ORDER BY id DESC LIMIT 1").get();

const limiter = (req, res, next) => { counters.limiter++; next(); };

function documentDeps(overrides = {}) {
	return {
		...KEY_HELPERS,
		getJobTrackingCached: async () => { counters.indexReads++; return JT; },
		requireRole, requireAuth, driverWriteLimiter: limiter,
		loadBelongsToDriver, sentIfLoadOwnershipUnverified, resolveDriverActor, LOAD_PANEL_DOCUMENT_FILTER, isRateConDocType,
		documentFiledUnder,
		uploadDocTypeFor: buildUploadDocTypeFor(UPLOAD_TYPE_SRC),
		db: docDbRecorded,
		// Upload plumbing. The image branch is never taken (every upload below is a
		// `document`), and the deferred POD / OCR work is captured, never run.
		validateFileExt: () => true,
		verifyInlineServedBytes: () => null,
		isValidImageMagic: () => true,
		imageLimits: { checkImage: () => ({ ok: true }), LIMITS: {}, refusalBody: () => ({}) },
		imageToPdf: async () => Buffer.from("%PDF-"),
		path,
		__dirname: "/srv/logisx",
		DATA_DIR: "/srv/logisx",
		fs: {
			existsSync: () => true,
			mkdirSync: () => {},
			writeFileSync: (p, bytes) => { counters.files.push(p); },
		},
		io: DOC_IO,
		...DISPATCH_EMITS,
		insertDispatchNotification: { run: () => ({}) },
		setImmediate: () => {},
		getSheets: async () => { throw new Error("not in this runner"); },
		SPREADSHEET_ID: "sheet-under-test",
		colLetter: () => "A",
		queueReceiptOcr: () => {},
		autoInvoicePodChanged: () => {},
		console: quiet,
		...overrides,
	};
}

// Execute a registration against a capturing `app`, returning its chain.
function buildRoute(verb, routePath, deps, routeSrc = routeSource(verb, routePath)) {
	const names = Object.keys(deps);
	let captured = null;
	const app = { [verb]: (p, ...chain) => { captured = { path: p, chain }; } };
	new Function("app", ...names, `${routeSrc};`)(app, ...names.map((n) => deps[n]));
	if (!captured || captured.path !== routePath) fatal(`the lifted registration did not register ${routePath}`);
	return { path: routePath, chain: captured.chain };
}

// Run the chain the way Express does: each middleware must call next() to hand on.
async function call(route, { user, method = "GET", params = {}, body = {} }) {
	const req = {
		method,
		url: route.path,
		originalUrl: route.path,
		path: route.path,
		params,
		body,
		query: {},
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
const DK = { id: 2, role: "Driver", username: "LogisX-1001", driverName: "Desoren King" };
const SK = { id: 3, role: "Driver", username: "LogisX-1002", driverName: "Soren King" };
const DISPATCH = { id: 4, role: "Dispatcher", username: "dispatch1", driverName: "" };
const INVESTOR = { id: 5, role: "Investor", username: "investor1", driverName: "" };
const NAMELESS = { id: 6, role: "Driver", username: "LogisX-1003", driverName: "" };
const NOLAN = { id: 7, role: "Driver", username: "LogisX-1004", driverName: "Nolan Loadless" };
// An Investor session that happens to carry a driver's name. The ownership check
// would admit it by name, so only the mount can refuse it — which is what lets a
// mutant of the mount show up at all.
const INVESTOR_NAMED = { ...INVESTOR, driverName: "Desoren King" };

const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 test document").toString("base64")}`;
const upload = (loadId, docType, extra = {}) => ({
	loadId, rowIndex: 2, photoData: PDF, fileType: "document", fileName: "scan.pdf",
	...(docType === undefined ? {} : { docType }),
	...extra,
});
const brief = (r) => `status ${r.status}, body ${JSON.stringify(r.body)}, reads ${readsOf()}, files ${counters.files.length}`;

(async () => {
	// =========================================================================
	console.log("\n§1  GET /api/documents/:loadId — every role");
	// =========================================================================
	const list = buildRoute("get", "/api/documents/:loadId", documentDeps());
	const listAs = async (user, loadId) => { resetCounters(); return call(list, { user, params: { loadId } }); };
	const names = (r) => (r.body && r.body.documents ? r.body.documents.map((d) => d.file_name).sort().join() : "");
	let r;

	r = await listAs(null, "L-100");
	ok("no session: 401 before any read", r.status === 401 && readsOf() === 0, brief(r));
	r = await listAs(SUPER, "L-200");
	ok("Super Admin, any load: 200 with the load's documents, no ownership read",
		r.status === 200 && names(r) === "L-200_POD_3.pdf" && counters.sheetReads === 0, brief(r));
	r = await listAs(DISPATCH, "L-100");
	ok("Dispatcher, any load: 200, rate con still left out of the list",
		r.status === 200 && names(r) === "L-100_BOL_2.pdf,L-100_POD_1.pdf" && counters.sheetReads === 0, brief(r));
	r = await listAs(DK, "L-100");
	ok("Driver, own load: 200", r.status === 200 && names(r) === "L-100_BOL_2.pdf,L-100_POD_1.pdf", brief(r));
	r = await listAs(DK, "L-200");
	ok("Driver, another driver's load: 403, the documents table never read",
		r.status === 403 && r.body.error === "This load is not assigned to you" && counters.prepared.length === 0, brief(r));
	r = await listAs(NAMELESS, "L-100");
	ok("Driver with no session name: 403, the documents table never read",
		r.status === 403 && counters.prepared.length === 0, brief(r));
	for (const [label, user] of [["Investor", INVESTOR], ["Investor carrying a driver's name", INVESTOR_NAMED]]) {
		r = await listAs(user, "L-100");
		ok(`${label}: 403 Forbidden at the mount, before any read`,
			r.status === 403 && r.body.error === "Forbidden" && readsOf() === 0, brief(r));
	}

	// =========================================================================
	console.log("\n§2  POST /api/documents/upload — every role, and the type list");
	// =========================================================================
	const up = buildRoute("post", "/api/documents/upload", documentDeps());
	ok("the role gate is mounted BEFORE the limiter", up.chain.length === 3 && up.chain[1] === limiter,
		`chain length ${up.chain.length}`);
	const uploadAs = async (user, body) => {
		resetCounters();
		const before = docRowCount();
		const res = await call(up, { user, method: "POST", body });
		return { ...res, inserted: docRowCount() - before };
	};
	const refusedClean = (x) => x.inserted === 0 && counters.files.length === 0 && counters.emits === 0;

	r = await uploadAs(null, upload("L-100", "POD"));
	ok("no session: 401, nothing read or written", r.status === 401 && readsOf() === 0 && refusedClean(r), brief(r));
	for (const [label, user] of [["Investor", INVESTOR], ["Investor carrying a driver's name", INVESTOR_NAMED]]) {
		r = await uploadAs(user, upload("L-100", "POD", { driverName: "Desoren King" }));
		ok(`${label}: 403 Forbidden at the mount — no limiter budget, no read, no file, no row`,
			r.status === 403 && r.body.error === "Forbidden" && counters.limiter === 0 && readsOf() === 0 && refusedClean(r),
			brief(r));
	}

	r = await uploadAs(DK, upload("L-100", "POD"));
	ok("Driver, own load, POD: 200, one file written and one row stored as POD",
		r.status === 200 && r.body.success === true && r.inserted === 1 && counters.files.length === 1 &&
		lastDoc().type === "POD" && lastDoc().driver === "Desoren King", brief(r));
	const podUploaded = () => counters.emitted.filter((e) => e.event === "pod-uploaded");
	const toAdmins = () => podUploaded().filter((e) => e.room === "super-admin");
	const toRest = () => podUploaded().filter((e) => e.room === "dispatch" && e.except === "super-admin");
	ok("...and the pod-uploaded broadcast carries the POD's link to Super Admins only, never to the rest of the dispatch room",
		podUploaded().length === 2 && toAdmins().length === 1 && toAdmins()[0].payload.driveUrl === r.body.driveUrl &&
		toRest().length === 1 && !("driveUrl" in toRest()[0].payload) && toRest()[0].payload.loadId === "L-100",
		JSON.stringify(podUploaded()));
	r = await uploadAs(DK, upload("L-200", "POD"));
	ok("Driver, another driver's load: 403, no file, no row",
		r.status === 403 && r.body.error === "This load is not assigned to you" && refusedClean(r), brief(r));
	r = await uploadAs(DK, upload("L-100", "POD", { driverName: "Soren King" }));
	ok("Driver naming another driver in the body: 403, nothing read or written",
		r.status === 403 && readsOf() === 0 && refusedClean(r), brief(r));

	for (const t of ["RATECON", "Rate Con", "rate_con", "RATE CON", "Invoice", "../x", ""]) {
		r = await uploadAs(DK, upload("L-100", t === "" ? undefined : t, t === "" ? { type: "RATECON" } : {}));
		ok(`Driver, own load, type ${JSON.stringify(t || "(docType absent, type: RATECON)")}: 400 DOC_TYPE_NOT_ALLOWED before any read`,
			r.status === 400 && r.body.code === "DOC_TYPE_NOT_ALLOWED" && readsOf() === 0 && refusedClean(r), brief(r));
	}
	r = await uploadAs(DK, upload("L-100", ["POD"]));
	ok("Driver, a non-string type: 400 DOC_TYPE_NOT_ALLOWED", r.status === 400 && r.body.code === "DOC_TYPE_NOT_ALLOWED" && refusedClean(r), brief(r));

	for (const [sent, stored] of [["BOL", "BOL"], ["Receipt", "Receipt"], ["Other", "Other"], ["pod", "POD"], [" receipt ", "Receipt"], [undefined, "POD"]]) {
		r = await uploadAs(DK, upload("L-100", sent));
		ok(`Driver, own load, type ${JSON.stringify(sent === undefined ? "(absent)" : sent)}: stored as ${stored}`,
			r.status === 200 && r.inserted === 1 && lastDoc().type === stored, brief(r));
	}

	r = await uploadAs(DISPATCH, upload("L-200", "BOL", { driverName: "Soren King" }));
	ok("Dispatcher, any load, BOL: 200 with no ownership read, attributed to the named driver",
		r.status === 200 && r.inserted === 1 && counters.sheetReads === 0 &&
		lastDoc().type === "BOL" && lastDoc().driver === "Soren King", brief(r));
	r = await uploadAs(DISPATCH, upload("L-200", "RATECON", { driverName: "Soren King" }));
	ok("Dispatcher, RATECON: 400 DOC_TYPE_NOT_ALLOWED, nothing written",
		r.status === 400 && r.body.code === "DOC_TYPE_NOT_ALLOWED" && refusedClean(r), brief(r));
	r = await uploadAs(SUPER, upload("L-200", "RATECON"));
	ok("Super Admin is not narrowed: RATECON stored as sent",
		r.status === 200 && r.inserted === 1 && lastDoc().type === "RATECON", brief(r));
	// The dispatch room holds Dispatchers, and rate cons are Super Admin only
	// (owner, 2026-09-26): the broadcast names the upload but not where it is.
	for (const t of ["RATECON", "Rate Con", "rate_con"]) {
		r = await uploadAs(SUPER, upload("L-200", t));
		const ev = counters.emitted.filter((e) => e.event === "pod-uploaded");
		ok(`Super Admin, type ${JSON.stringify(t)}: the pod-uploaded broadcast carries no link to the rate con`,
			r.status === 200 && ev.length === 2 && ev.every((e) => e.payload.docType === t && !("driveUrl" in e.payload)) &&
			!JSON.stringify(counters.emitted).includes(r.body.driveUrl), JSON.stringify(counters.emitted));
	}

	// =========================================================================
	console.log("\n§3  PUT /api/messages/read and PUT /api/notifications/read");
	// =========================================================================
	const flagDb = new Database(":memory:");
	flagDb.exec(`
		CREATE TABLE messages (id INTEGER PRIMARY KEY, timestamp TEXT, "from" TEXT, "to" TEXT, message TEXT, load_id TEXT DEFAULT '', read INTEGER DEFAULT 0);
		INSERT INTO messages (id, "from", "to", message) VALUES
			(1, 'Desoren King', 'Dispatch', 'm1'),
			(2, 'Dispatch', 'Desoren King', 'm2'),
			(3, 'Dispatch', 'Soren King', 'm3'),
			(4, 'Dispatch', 'investor1', 'm4'),
			(5, 'Dispatch', 'investor2', 'm5'),
			(6, 'Soren King', 'dispatch1', 'm6');
		CREATE TABLE notifications (id INTEGER PRIMARY KEY, driver_name TEXT NOT NULL, type TEXT, title TEXT, read INTEGER DEFAULT 0);
		INSERT INTO notifications (id, driver_name, type, title) VALUES
			(1, 'desoren king', 'message', 'n1'),
			(2, 'soren king', 'message', 'n2'),
			(3, 'investor1', 'message', 'n3'),
			(4, 'dispatch1', 'message', 'n4'),
			(5, '', 'message', 'n5');
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL);
		INSERT INTO users (id, username, role) VALUES (5, 'investor1', 'Investor'), (6, 'investor2', 'Investor');
	`);
	const flagDeps = { requireAuth, driverWriteLimiter: limiter, db: flagDb, readFlagOwnName, readsInvestorChats, INVESTOR_CHAT_SQL, console: quiet };
	const msgRead = buildRoute("put", "/api/messages/read", flagDeps);
	const notifRead = buildRoute("put", "/api/notifications/read", flagDeps);
	const ALL = [1, 2, 3, 4, 5, 6];
	const readIds = (table) => flagDb.prepare(`SELECT id FROM ${table} WHERE read = 1 ORDER BY id`).all().map((x) => x.id).join();
	async function mark(route, table, user, ids) {
		flagDb.exec(`UPDATE ${table} SET read = 0`);
		const res = await call(route, { user, method: "PUT", body: table === "messages" ? { messageIds: ids } : { ids } });
		return { status: res.status, marked: readIds(table) };
	}

	r = await mark(msgRead, "messages", null, ALL);
	ok("messages: no session: 401, nothing marked", r.status === 401 && r.marked === "", JSON.stringify(r));
	r = await mark(msgRead, "messages", INVESTOR, ALL);
	ok("messages: Investor marks only the message addressed to them", r.status === 200 && r.marked === "4", JSON.stringify(r));
	r = await mark(msgRead, "messages", INVESTOR_NAMED, ALL);
	ok("messages: an Investor is matched by username, never by a driver name on the session",
		r.status === 200 && r.marked === "4", JSON.stringify(r));
	r = await mark(msgRead, "messages", DK, ALL);
	ok("messages: Driver marks only the message addressed to them", r.status === 200 && r.marked === "2", JSON.stringify(r));
	r = await mark(msgRead, "messages", NAMELESS, ALL);
	ok("messages: a Driver with no session name marks nothing", r.status === 200 && r.marked === "", JSON.stringify(r));
	r = await mark(msgRead, "messages", DISPATCH, [1, 3]);
	ok("messages: Dispatcher keeps the inbox-wide form (the Dispatch desk's rows and others)",
		r.status === 200 && r.marked === "1,3", JSON.stringify(r));
	r = await mark(msgRead, "messages", DISPATCH, ALL);
	ok("messages: Dispatcher marks none of an investor conversation's (Super Admin only)",
		r.status === 200 && r.marked === "1,2,3,6", JSON.stringify(r));
	r = await mark(msgRead, "messages", SUPER, [5, 6]);
	ok("messages: Super Admin keeps the inbox-wide form", r.status === 200 && r.marked === "5,6", JSON.stringify(r));

	r = await mark(notifRead, "notifications", INVESTOR, [1, 2, 3, 4, 5]);
	ok("notifications: Investor marks only their own", r.status === 200 && r.marked === "3", JSON.stringify(r));
	r = await mark(notifRead, "notifications", DK, [1, 2, 3, 4, 5]);
	ok("notifications: Driver marks only their own", r.status === 200 && r.marked === "1", JSON.stringify(r));
	r = await mark(notifRead, "notifications", NAMELESS, [1, 2, 3, 4, 5]);
	ok("notifications: a Driver with no session name marks nothing, not the blank-named row",
		r.status === 200 && r.marked === "", JSON.stringify(r));
	r = await mark(notifRead, "notifications", DISPATCH, [1, 2, 3, 4, 5]);
	ok("notifications: Dispatcher marks only their own (no dispatch screen marks these)",
		r.status === 200 && r.marked === "4", JSON.stringify(r));
	r = await mark(notifRead, "notifications", SUPER, [2, 3]);
	ok("notifications: Super Admin marks any", r.status === 200 && r.marked === "2,3", JSON.stringify(r));

	// =========================================================================
	console.log("\n§4  GET /api/driver/:driverName — the diagnostic block");
	// =========================================================================
	// A sheet with loads, none of them Nolan's: the "no_loads_for_driver" case.
	const emptyDb = { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({}) }) };
	const driverDeps = {
		requireRole, requireAuth, normalizeDriverName, findCol,
		sanitizeBrokerColumns: (headers, rows) => rows,
		findDirectoryRowForDriver: () => null,
		findTruckForDriver: () => null,
		db: emptyDb,
		// Each invoice card's pay_basis: the shipped invoicePayBasesOf() over that db.
		invoicePayBasesOf: new Function("db",
			`${liftFn("invoicePayBasis")}\n${liftFn("invoicePayBasesOf")}\nreturn invoicePayBasesOf;`)(emptyDb),
		getJobTrackingCached: async () => JT,
		liveJobTrackingView: (jt) => ({ ...jt, headers: [...jt.headers], data: jt.data.map((x) => ({ ...x })) }),
		voiceNotes: require("../lib/voice-notes"),
		// The payload's alerts: the shipped read (scripts/test-driver-page-role-gate.js §10).
		driverAlertsSent: require("../lib/driver-alerts-sent"),
		getCarrierDBFromSQLite: () => ({ headers: ["Driver"], data: [] }),
		computeDriverQueues: () => ({}),
		withExpenseWindows: (rows) => rows.map((x) => ({ ...x })),
		stripSigningEvidence: (rows) => rows,
		// No receipt or invoice here carries a Personal line
		// (scripts/test-personal-expense-routes.js, test-personal-expense-receipts.js).
		personalSummaryByExpense: () => Object.create(null),
		personalSummaryForRole: () => null,
		personalLinesForInvoices: () => new Map(),
		// Nor a correction line (scripts/test-approved-invoice-lock.js).
		correctionLinesForInvoices: () => new Map(),
		ONBOARDING_DOCS: [],
		// The driver's own time-off screen is off here (its subject is
		// scripts/test-driver-page-role-gate.js §7).
		DRIVER_TIME_OFF_SCREEN_ENABLED: false,
		// So are emergency contacts (scripts/test-emergency-contacts-routes.js §7).
		EMERGENCY_CONTACTS_ENABLED: false,
		// So are the training videos (scripts/test-driver-training-videos.js).
		DRIVER_TRAINING_VIDEOS_ENABLED: false,
		// So are the load-instructions codes (scripts/test-driver-page-role-gate.js §8).
		driverInstructions: { annotateDriverLoads() {} },
		// So is the arrival pickup line (scripts/test-arrival-pickup-pay-paths.js §D).
		annotatePickupArrival: () => 0,
		// So are the stepper's GPS phases (scripts/test-driver-page-role-gate.js §9).
		driverGpsPhases: { annotate: (rows) => rows },
		// The per-load document counts (scripts/test-driver-docs-current-holder.js §4).
		LOAD_PANEL_DOCUMENT_FILTER, documentFiledUnder,
		console: quiet,
	};
	const driverRoute = buildRoute("get", "/api/driver/:driverName", driverDeps);
	r = await call(driverRoute, { user: NOLAN, params: { driverName: "Nolan Loadless" } });
	ok("Driver with no loads: 200 and no diagnostic (no other drivers' names)",
		r.status === 200 && Array.isArray(r.body.loads) && r.body.loads.length === 0 && !("diagnostic" in r.body),
		`status ${r.status}, keys ${r.body ? Object.keys(r.body).join(",") : "none"}`);
	r = await call(driverRoute, { user: SUPER, params: { driverName: "Nolan Loadless" } });
	ok("Super Admin, same driver: the diagnostic is still built",
		r.status === 200 && r.body.diagnostic && r.body.diagnostic.warning === "no_loads_for_driver" &&
		r.body.diagnostic.sampleDriverNamesInSheet.join() === "Desoren King,Soren King",
		`status ${r.status}, diagnostic ${JSON.stringify(r.body && r.body.diagnostic)}`);

	// =========================================================================
	console.log("\n§5  the callers the document gates were sized against");
	// =========================================================================
	const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : walk(p);
		return /\.(vue|js|ts|html)$/.test(e.name) ? [p] : [];
	});
	// The legacy public/ pages are gone; a page put back there is still searched.
	const legacyDir = path.join(ROOT, "public");
	const files = [...walk(path.join(ROOT, "client", "src")), ...(fs.existsSync(legacyDir) ? walk(legacyDir) : [])];
	const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
	const textOf = (f) => fs.readFileSync(f, "utf8");
	const uploadCallers = files.filter((f) => /['"`]\/api\/documents\/upload['"`]/.test(textOf(f))).map(rel).sort();
	ok("the upload's only caller is useUpload.js", uploadCallers.join() === "client/src/composables/useUpload.js", uploadCallers.join() || "none");
	const useUploadUsers = files.filter((f) => /from ['"][./]*composables\/useUpload['"]/.test(textOf(f))).map(rel).sort();
	ok("...which only DocumentUpload.vue uses", useUploadUsers.join() === "client/src/components/driver/DocumentUpload.vue",
		useUploadUsers.join() || "none");
	const du = textOf(path.join(ROOT, "client", "src", "components", "driver", "DocumentUpload.vue"));
	const offered = [...(du.match(/const docTypes = \[([\s\S]*?)\]/) || ["", ""])[1].matchAll(/value: '([^']+)'/g)].map((x) => x[1]).sort();
	const accepts = buildUploadDocTypeFor(UPLOAD_TYPE_SRC);
	ok(`DocumentUpload.vue offers exactly the types a Driver or Dispatcher may upload (${offered.join(", ")})`,
		offered.join() === "BOL,Other,POD,Receipt" && offered.every((t) => accepts("Driver", t) === t && accepts("Dispatcher", t) === t));
	const mounts = files.filter((f) => /<DocumentUpload\b/.test(textOf(f))).map(rel).sort();
	ok("no mount passes its own type (the selector is the whole vocabulary)",
		mounts.length > 0 && mounts.every((f) => !/<DocumentUpload\b[^>]*\b(doc-type|docType)=/.test(textOf(path.join(ROOT, f)))),
		mounts.join());
	const listCallers = files.filter((f) => /\/api\/documents\/\$\{/.test(textOf(f))).map(rel).sort();
	ok("the list is read by the dashboard load panels and the driver app only",
		listCallers.join() === [
			"client/src/components/dashboard/ActiveLoadsTab.vue",
			"client/src/components/dashboard/CompletedLoadsTab.vue",
			"client/src/components/driver/DocumentList.vue",
		].join(), listCallers.join() || "none");
	const router = textOf(path.join(ROOT, "client", "src", "router", "index.js"));
	const rolesOf = (p) => {
		const m = router.match(new RegExp(`path:\\s*'${p}',[\\s\\S]{0,200}?roles:\\s*\\[([^\\]]*)\\]`));
		return m ? m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean).sort().join() : "";
	};
	ok("/dashboard admits Super Admin and Dispatcher; /driver admits Driver and Super Admin",
		rolesOf("/dashboard") === "Dispatcher,Super Admin" && rolesOf("/driver") === "Driver,Super Admin",
		`${rolesOf("/dashboard")} | ${rolesOf("/driver")}`);

	// =========================================================================
	console.log("\n§6  DISCRIMINATION: defang each document gate, require an assertion to flip");
	// =========================================================================
	const LIST_SRC = routeSource("get", "/api/documents/:loadId");
	const m1 = buildRoute("get", "/api/documents/:loadId", documentDeps(),
		mutate(LIST_SRC, 'requireRole("Super Admin", "Dispatcher", "Driver")', "requireAuth"));
	resetCounters();
	r = await call(m1, { user: INVESTOR_NAMED, params: { loadId: "L-100" } });
	// §2 has added rows to L-100 by now, so this asks only that the list arrived.
	ok("MUTANT 1 (list mount is requireAuth): the §1 named-Investor assertion flips",
		r.status === 200 && names(r).includes("L-100_POD_1.pdf"), `status ${r.status}`);

	const m2src = mutate(UPLOAD_TYPE_SRC, 'if (role === "Super Admin") return requested;', "return requested;");
	const m2 = buildRoute("post", "/api/documents/upload", documentDeps({ uploadDocTypeFor: buildUploadDocTypeFor(m2src) }));
	resetCounters();
	const beforeM2 = docRowCount();
	r = await call(m2, { user: DK, method: "POST", body: upload("L-100", "RATECON") });
	ok("MUTANT 2 (type list applied to nobody): the §2 Driver RATECON assertion flips",
		r.status === 200 && docRowCount() - beforeM2 === 1 && lastDoc().type === "RATECON", brief(r));

	// =========================================================================
	console.log("\n§7  POD and BOL photos shaped at upload (POD_UPLOAD_NORMALIZE_ENABLED)");
	// =========================================================================
	await shapedUploads();

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});

// §7: the shipped upload route, list route and session route, run with the real lib/pod-upload-shape.js
// (its child included) and made-up photos (scripts/lib/made-up-jpeg.js). Each check is a function of the
// route it runs, so its mutant runs the same check on a route built from a source with one edit.
async function shapedUploads() {
	const Module = require("module");
	const jpegs = require("./lib/made-up-jpeg");
	const PDFKit = require("pdfkit");
	const { PDFDocument } = require("pdf-lib");
	const imageLimits = require("../lib/image-size");
	const tryRequire = (rel) => { try { return require(rel); } catch { return null; } };
	const shapeLib = tryRequire("../lib/pod-upload-shape");
	const slotsLib = tryRequire("../lib/image-child-slots");
	const BUDGET = 200 * 1024;
	const FIXED = new Date("2026-11-02T15:04:05Z");
	class FixedPDF extends PDFKit {
		constructor(o = {}) { super({ ...o, info: { CreationDate: FIXED } }); }
	}
	// The base's imageToPdf() (c4d54380), word for word: what every photo upload stored before.
	const BASE_IMAGE_TO_PDF = [
		"function imageToPdf(imageBuffers) {",
		"	const buffers = Array.isArray(imageBuffers) ? imageBuffers : [imageBuffers];",
		"	return new Promise((resolve, reject) => {",
		"		for (const buf of buffers) {",
		"			const verdict = imageLimits.checkImage(buf, imageLimits.LIMITS.DOCUMENT_PHOTO);",
		"			if (!verdict.ok) return reject(imageLimits.refusalError(verdict, \"photo\"));",
		"		}",
		"		const doc = new PDFDocument({ autoFirstPage: false });",
		"		const chunks = [];",
		"		doc.on(\"data\", (chunk) => chunks.push(chunk));",
		"		doc.on(\"end\", () => resolve(Buffer.concat(chunks)));",
		"		doc.on(\"error\", reject);",
		"		for (const buf of buffers) {",
		"			const img = doc.openImage(buf);",
		"			doc.addPage({ size: [img.width, img.height] });",
		"			doc.image(img, 0, 0);",
		"		}",
		"		doc.end();",
		"	});",
		"}",
	].join("\n");
	const baseImageToPdf = new Function("PDFDocument", "imageLimits", `${BASE_IMAGE_TO_PDF}\nreturn imageToPdf;`)(FixedPDF, imageLimits);
	const shippedImageToPdf = new Function("PDFDocument", "imageLimits", `${liftFn("imageToPdf")}\nreturn imageToPdf;`)(FixedPDF, imageLimits);
	ok("§7 (fixture) the shipped imageToPdf() is the base's, word for word", liftFn("imageToPdf").trim() === BASE_IMAGE_TO_PDF);

	const P = {
		big: jpegs.jpeg({ width: 1200, height: 900, quality: 100, seed: 3, blank: true }),
		small: jpegs.jpeg({ width: 820, height: 620, quality: 76, seed: 5 }),
		small2: jpegs.jpeg({ width: 820, height: 620, quality: 70, seed: 21 }),
		// Near-blank, so a step would shrink each: only the whitelist keeps them as they came. The CMYK
		// one carries Adobe's segment, as a CMYK photo does, so the decoder can read it.
		cmyk: jpegs.jpeg({ width: 820, height: 620, quality: 100, components: 4, seed: 8, blank: true, adobe: { transform: 0, at: "before" } }),
		turned: jpegs.jpeg({ width: 1280, height: 960, quality: 100, seed: 9, orientation: 6, blank: true }),
	};
	const uri = (b) => `data:image/jpeg;base64,${b.toString("base64")}`;
	const written = [];
	const audits = [];
	const fsRecorder = {
		existsSync: () => true,
		mkdirSync: () => {},
		writeFileSync: (p, bytes) => { counters.files.push(p); written.push({ p, bytes: Buffer.from(bytes) }); },
	};
	const shaperOf = (lib) => (lib && slotsLib ? lib.createShaper({ encode: lib.createEncoder({ slots: slotsLib.createUploadSlots() }), info: { CreationDate: FIXED } }) : null);
	const shapeDeps = (on, lib = shapeLib) => documentDeps({
		imageToPdf: shippedImageToPdf,
		imageLimits,
		isValidImageMagic: (b) => Buffer.isBuffer(b) && b[0] === 0xff && b[1] === 0xd8,
		fs: fsRecorder,
		POD_UPLOAD_NORMALIZE_ENABLED: on,
		podUploadShape: lib,
		podUploadShaper: shaperOf(lib),
		logAudit: (req, action, entity, entityId, details) => audits.push({ action, entity, entityId: String(entityId), details }),
	});
	const UPLOAD = routeSource("post", "/api/documents/upload");
	const LIST = routeSource("get", "/api/documents/:loadId");
	const SESSION = routeSource("get", "/api/auth/session");
	const edit = (src, from, to) => (src.split(from).length - 1 === 1 ? src.replace(from, to) : null);
	const upRoute = (on, src = UPLOAD, lib = shapeLib) => (src ? buildRoute("post", "/api/documents/upload", shapeDeps(on, lib), src) : null);
	// A copy of lib/pod-upload-shape.js with one exact edit, or null.
	const libWith = (from, to) => {
		try {
			const file = path.join(ROOT, "lib", "pod-upload-shape.js");
			const src = fs.readFileSync(file, "utf8");
			if (src.split(from).length - 1 !== 1) return null;
			const m = new Module(file, module);
			m.filename = file;
			m.paths = Module._nodeModulePaths(path.dirname(file));
			m._compile(src.replace(from, to), file);
			return m.exports;
		} catch {
			return null;
		}
	};
	const imageBody = (loadId, docType, photos, extra = {}) => ({
		loadId, rowIndex: 2, docType, photoData: photos.length === 1 ? uri(photos[0]) : photos.map(uri), fileType: "image", ...extra,
	});
	const send = async (rt, user, body) => {
		resetCounters();
		written.length = 0;
		audits.length = 0;
		const res = await call(rt, { user, method: "POST", body });
		return { ...res, file: written.length === 1 ? written[0].bytes : null, writes: written.length, row: lastDoc(), audits: audits.slice() };
	};
	const COUNT_KEYS = ["upload_pages", "upload_page_sources", "upload_pages_scanned", "upload_pages_not_scanned", "upload_pages_recompressed",
		"upload_bytes_before", "upload_bytes_after", "upload_pages_left_large"];
	const counted = (row) => COUNT_KEYS.map((k) => row[k]);
	const noCounts = (row) => counted(row).every((v) => v === null);
	const pagesOf = async (pdf) => (await PDFDocument.load(pdf)).getPages().map((p) => { const s = p.getSize(); return [Math.round(s.width), Math.round(s.height)]; });
	const run = async (check, rt) => { if (!rt) return null; try { return await check(rt); } catch { return null; } };
	const mutants = [];
	const mutant = (label, check, control, build) => mutants.push({ label, check, control, build });

	// ---- guards: each passes on the base by design ----
	const offSame = async (rt) => {
		const r = await send(rt, DK, imageBody("L-100", "POD", [P.small, P.small2]));
		return r.status === 200 && r.file && r.file.equals(await baseImageToPdf([P.small, P.small2])) && noCounts(r.row) && r.audits.length === 0;
	};
	const g1 = await run(offSame, upRoute(false));
	ok("§7 (guard) switch off: a POD of two photos is stored byte for byte as the base's imageToPdf() writes it (a fixed clock), with no counts and no audit row", g1 === true);
	mutant("shaped whatever the switch says: the switch-off guard flips", offSame, g1,
		() => upRoute(false, edit(UPLOAD, "if (POD_UPLOAD_NORMALIZE_ENABLED && podUploadShape.shapedType(docType)) {", "if (podUploadShape.shapedType(docType)) {")));

	const PDF_BYTES = Buffer.from("%PDF-1.4\n% a made-up proof of delivery\n%%EOF\n");
	const pdfSame = async (rt) => {
		const r = await send(rt, DK, { loadId: "L-100", rowIndex: 2, docType: "POD", photoData: `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`, fileType: "document", fileName: "pod.pdf" });
		return r.status === 200 && r.file && r.file.equals(PDF_BYTES) && noCounts(r.row) && r.audits.length === 0;
	};
	const g2 = await run(pdfSame, upRoute(true));
	ok("§7 (guard) switch on: a POD PDF is stored byte for byte as sent, with no counts and no audit row", g2 === true);
	mutant("a PDF sent down the photo path: the PDF guard flips", pdfSame, g2, () => upRoute(true, edit(UPLOAD, "if (fileType === 'document') {", "if (fileType === 'never') {")));

	const othersSame = async (rt) => {
		const out = [];
		for (const t of ["Receipt", "Other"]) {
			const r = await send(rt, DK, imageBody("L-100", t, [P.small]));
			out.push(r.status === 200 && r.row.type === t && r.file && r.file.equals(await baseImageToPdf([P.small])) && noCounts(r.row) && r.audits.length === 0);
		}
		return out.every(Boolean);
	};
	const g3 = await run(othersSame, upRoute(true));
	ok("§7 (guard) switch on: a Receipt image and an Other image are stored as the base's imageToPdf() writes them, with no counts", g3 === true);
	mutant("every type shaped: the Receipt and Other guard flips", othersSame, g3,
		() => upRoute(true, edit(UPLOAD, "if (POD_UPLOAD_NORMALIZE_ENABLED && podUploadShape.shapedType(docType)) {", "if (POD_UPLOAD_NORMALIZE_ENABLED) {")));

	const leftAsCame = async (rt) => {
		const r = await send(rt, DK, imageBody("L-100", "POD", [P.cmyk, P.turned]));
		const ims = r.file ? await jpegs.imagesIn(r.file) : [];
		return r.status === 200 && P.cmyk.length > BUDGET && P.turned.length > BUDGET && ims.length === 2 && ims[0].bytes.equals(P.cmyk) && ims[1].bytes.equals(P.turned);
	};
	const g5 = await run(leftAsCame, upRoute(true));
	ok("§7 (guard) switch on: a CMYK and an orientation-6 photo over the budget go as they came: their streams in the stored PDF are the uploads byte for byte", g5 === true);
	// An orientation-6 photo is kept twice over (the whitelist, then the parent's size check on a copy the
	// decode turned), so the mutant drops the one rule that alone keeps the CMYK photo.
	mutant("the whitelist's component rule dropped: the CMYK guard flips", leftAsCame, g5,
		() => { const lib = libWith('if (n !== 1 && n !== 3) return left("components");', ""); return lib ? upRoute(true, UPLOAD, lib) : null; });

	const neverRewritten = async (rt) => {
		const r = await send(rt, DK, imageBody("L-100", "POD", [P.small]));
		const earlier = docDb.prepare("SELECT file_name FROM documents WHERE id < ?").all(r.row.id).map((x) => x.file_name);
		const name = written[0] ? path.basename(written[0].p) : "";
		return r.status === 200 && r.writes === 1 && name === r.row.file_name && !earlier.includes(name);
	};
	const g6 = await run(neverRewritten, upRoute(true));
	ok("§7 (guard) switch on: a shaped upload writes one new file of its own; no stored file is written again", g6 === true);
	mutant("the shaped file written over a stored one: the guard flips", neverRewritten, g6,
		() => upRoute(true, edit(UPLOAD, "fileName = `${safeLoadId}_${safeDocType}_${timestamp}.pdf`;", "fileName = \"L-100_POD_1.pdf\";")));

	const withheld = async (src) => {
		const rt = buildRoute("get", "/api/documents/:loadId", documentDeps({ loadIdWithheldFor: () => true, shownLoadId: () => "QA-[contact withheld]", routeShownLoadIdIndex: () => null }), src);
		resetCounters();
		const r = await call(rt, { user: DISPATCH, params: { loadId: "L-100" } });
		const docs = (r.body && r.body.documents) || [];
		return r.status === 200 && r.body.documentsWithheld === true && docs.length > 0 && docs.every((d) => JSON.stringify(Object.keys(d).sort()) === '["id","type","uploaded_at"]');
	};
	const gw = await run(withheld, LIST);
	ok("§7 (guard) the withheld list still names each document by type and upload time only: no file, link or count", gw === true);
	mutant("the withheld list sends whole rows: the guard flips", withheld, gw,
		() => edit(LIST, "docs.map((d) => ({ id: d.id, type: d.type, uploaded_at: d.uploaded_at }))", "docs.map((d) => ({ ...d }))"));

	const sessionFeatures = (src, features) => {
		let handler = null;
		new Function("app", "APP_TIMEZONE", "APP_TIMEZONE_ERA", "MESSAGE_VOICE_NOTES_ENABLED", "POD_UPLOAD_FEATURES", `${src};`)(
			{ get: (p, h) => { handler = h; } }, "America/New_York", {}, false, features);
		let body = null;
		handler({ session: { user: { id: 2, role: "Driver", username: "LogisX-1001" } } }, { json: (b) => { body = b; } });
		return body && body.features;
	};
	const featOff = async (src) => {
		const f = sessionFeatures(src, Object.freeze({ podUploadNormalize: false, podUploadScanAll: false }));
		return Boolean(f) && f.voiceNotes === false && f.podUploadNormalize !== true && f.podUploadScanAll !== true;
	};
	const gs = await run(featOff, SESSION);
	ok("§7 (guard) with both switches off, the session tells the card neither is on", gs === true);
	mutant("the session says on whatever the switch: the guard flips", featOff, gs, () => edit(SESSION, "...POD_UPLOAD_FEATURES", "podUploadNormalize: true"));

	// ---- the new behaviour: each fails on the old code ----
	const shapedPod = async (rt) => {
		const r = await send(rt, DK, imageBody("L-100", "POD", [P.big, P.small], { pageSources: ["scanned", "not_routed"] }));
		const ims = r.file ? await jpegs.imagesIn(r.file) : [];
		const f = ims[0] && jpegs.frameOf(ims[0].bytes);
		const after = ims.reduce((n, im) => n + im.bytes.length, 0);
		return {
			letter: r.status === 200 && Boolean(r.file) && JSON.stringify(await pagesOf(r.file)) === "[[792,612],[792,612]]" && ims.length === 2
				&& ims[0].bytes.length <= BUDGET && Boolean(f) && f.width === 1200 && f.height === 900 && ims[1].bytes.equals(P.small),
			counts: JSON.stringify(counted(r.row)) === JSON.stringify([2, "scanned,not_routed", 1, 1, 1, P.big.length + P.small.length, after, 0]),
			audit: Boolean(shapeLib) && r.audits.length === 1 && r.audits[0].action === "document_upload_shaped" && r.audits[0].entity === "documents"
				&& r.audits[0].entityId === String(r.row.id) && r.audits[0].details === shapeLib.auditText("POD", { pages: 2, scanned: 1, notScanned: 1, recompressed: 1, bytesBefore: P.big.length + P.small.length, bytesAfter: after, leftLarge: 0, reasons: {} }),
		};
	};
	const s1 = (await run(shapedPod, upRoute(true))) || {};
	ok("§7 FAILS ON THE OLD CODE: switch on, a Driver's POD of a 469 KB and a 175 KB photo: two landscape Letter pages, the first under 200 KB at its own 1200 x 900, the second as it came", s1.letter === true);
	ok("§7 FAILS ON THE OLD CODE: ...its row keeps the counts: 2 pages, the card's sources, 1 scanned and 1 not, 1 re-compressed, the photos' bytes before and after, none left over", s1.counts === true);
	ok("§7 FAILS ON THE OLD CODE: ...and one audit row, counts and fixed words only, on the new document", s1.audit === true);
	const part = (key) => async (rt) => ((await shapedPod(rt)) || {})[key] === true;
	mutant("never shaped: the Letter pages case flips", part("letter"), s1.letter,
		() => upRoute(true, edit(UPLOAD, "if (POD_UPLOAD_NORMALIZE_ENABLED && podUploadShape.shapedType(docType)) {", "if (false) {")));
	mutant("the counts never stored: the row case flips", part("counts"), s1.counts,
		() => upRoute(true, edit(UPLOAD, ").run(c.pages, c.sources, c.scanned, c.notScanned, c.recompressed, c.bytesBefore, c.bytesAfter, c.leftLarge, documentId);", ").run(null, null, null, null, null, null, null, null, documentId);")));
	mutant("no audit row: the audit case flips", part("audit"), s1.audit,
		() => upRoute(true, edit(UPLOAD, "\t\t\tlogAudit(req, \"document_upload_shaped\"", "\t\t\tif (false) logAudit(req, \"document_upload_shaped\"")));

	const unknownSources = async (rt) => {
		const r = await send(rt, DK, imageBody("L-100", "BOL", [P.small]));
		return r.status === 200 && JSON.stringify(counted(r.row)) === JSON.stringify([1, "unknown", null, null, 0, P.small.length, P.small.length, 0]);
	};
	const s4 = await run(unknownSources, upRoute(true));
	ok("§7 FAILS ON THE OLD CODE: a client that sends no page sources (an old one) is stored as \"unknown\"", s4 === true);
	mutant("the route makes up a page source: the unknown case flips", unknownSources, s4,
		() => upRoute(true, edit(UPLOAD, "{ sources: req.body.pageSources }", "{ sources: [\"scanned\"] }")));

	const lowerCase = async (rt) => {
		const r = await send(rt, SUPER, imageBody("L-200", "bol", [P.small], { driverName: "Soren King" }));
		return r.status === 200 && r.row.type === "bol" && Boolean(r.file) && JSON.stringify(await pagesOf(r.file)) === "[[792,612]]" && r.row.upload_pages === 1;
	};
	const s5 = await run(lowerCase, upRoute(true));
	ok("§7 FAILS ON THE OLD CODE: a Super Admin's \"bol\" (stored as sent) is shaped too: POD and BOL are matched without regard to case", s5 === true);
	mutant("POD and BOL matched by case: the lower-case case flips", lowerCase, s5,
		() => upRoute(true, edit(UPLOAD, "if (POD_UPLOAD_NORMALIZE_ENABLED && podUploadShape.shapedType(docType)) {", "if (POD_UPLOAD_NORMALIZE_ENABLED && (docType === \"POD\" || docType === \"BOL\")) {")));

	const listed = async (src) => {
		const rt = buildRoute("get", "/api/documents/:loadId", documentDeps(), src);
		resetCounters();
		const r = await call(rt, { user: SUPER, params: { loadId: "L-100" } });
		const docs = (r.body && r.body.documents) || [];
		const shaped = docs.find((d) => d.upload_page_sources === "scanned,not_routed");
		const plain = docs.find((d) => d.file_name === "L-100_POD_1.pdf");
		return r.status === 200 && Boolean(shaped) && shaped.upload_pages === 2 && shaped.upload_pages_recompressed === 1 && shaped.upload_pages_left_large === 0
			&& Boolean(plain) && COUNT_KEYS.every((k) => k in plain && plain[k] === null);
	};
	const s6 = await run(listed, LIST);
	ok("§7 FAILS ON THE OLD CODE: GET /api/documents/:loadId lists a shaped upload's counts, and null on every other row", s6 === true);
	mutant("a count left out of the list: the list case flips", listed, s6, () => edit(LIST, "upload_pages_recompressed,", ""));

	const featOn = async (src) => {
		const f = sessionFeatures(src, Object.freeze({ podUploadNormalize: true, podUploadScanAll: false }));
		const g = sessionFeatures(src, Object.freeze({ podUploadNormalize: false, podUploadScanAll: true }));
		return Boolean(f && g) && f.voiceNotes === false && f.podUploadNormalize === true && f.podUploadScanAll === false && g.podUploadNormalize === false && g.podUploadScanAll === true;
	};
	const s7 = await run(featOn, SESSION);
	ok("§7 FAILS ON THE OLD CODE: GET /api/auth/session hands the card each switch in `features`, beside voiceNotes", s7 === true);
	mutant("the switches left out of the session: the features case flips", featOn, s7, () => edit(SESSION, ", ...POD_UPLOAD_FEATURES", ""));

	const wired = (src) => /\nconst POD_UPLOAD_NORMALIZE_ENABLED = podUploadShape\.normalizeEnabled\(process\.env\);\n/.test(src)
		&& /\nconst POD_UPLOAD_SCAN_ALL_ENABLED = podUploadShape\.scanAllEnabled\(process\.env\);\n/.test(src)
		&& /\nconst POD_UPLOAD_FEATURES = Object\.freeze\(\{ podUploadNormalize: POD_UPLOAD_NORMALIZE_ENABLED, podUploadScanAll: POD_UPLOAD_SCAN_ALL_ENABLED \}\);\n/.test(src)
		&& /\nif \(POD_UPLOAD_NORMALIZE_ENABLED\) console\.log\(/.test(src) && /\nif \(POD_UPLOAD_SCAN_ALL_ENABLED\) console\.log\(/.test(src)
		&& /try \{ db\.exec\("ALTER TABLE documents ADD COLUMN upload_page_sources TEXT DEFAULT NULL"\); \} catch \{\}/.test(src);
	const s8 = wired(SRC);
	ok("§7 FAILS ON THE OLD CODE: server.js reads each switch once at start through its lib reader, hands both to the session, says each at start when it is on, and adds the row's columns the try/ALTER way", s8 === true);
	mutant("a switch said nowhere at start: the wiring case flips", async (src) => wired(src), s8, () => edit(SRC, "if (POD_UPLOAD_NORMALIZE_ENABLED) console.log(", "if (false) console.log("));

	// ---- one mutant per check, each against its passing control ----
	for (const m of mutants) {
		let built = null;
		try { built = m.build(); } catch { built = null; }
		const result = built ? await run(m.check, built) : null;
		ok(`§7 MUTANT ${m.label}`, m.control === true && built !== null && result !== true, `control ${m.control}, built ${built !== null}, mutant ${result}`);
	}
}
