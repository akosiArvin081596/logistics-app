#!/usr/bin/env node
/**
 * scripts/test-documents-role-gates.js — who may list and upload a load's
 * documents, and whose read flags a caller may set.
 *
 *   GET  /api/documents/:loadId    Super Admin, Dispatcher, or the load's Driver.
 *   POST /api/documents/upload     the same gate, mounted before the limiter; a
 *                                  Dispatcher or a Driver uploads only POD, BOL,
 *                                  Receipt or Other (400 DOC_TYPE_NOT_ALLOWED).
 *   PUT  /api/messages/read        Super Admin and Dispatcher mark any message;
 *                                  every other caller only messages addressed to them.
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
 *      The pod-uploaded broadcast to the dispatch room carries a document's link,
 *      but never a rate con's (rate cons are Super Admin only; isRateConDocType()).
 *   §3 the two read-flag routes over an in-memory SQLite: each role marks exactly
 *      the rows it may, and a caller with no name marks nothing.
 *   §4 GET /api/driver/:driverName: a Driver with no loads gets no diagnostic;
 *      Super Admin still does.
 *   §5 the callers the document gates were sized against.
 *   §6 DISCRIMINATION: one mutant per document gate, each required to flip.
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
const UPLOAD_TYPE_SRC = liftFn("uploadDocTypeFor");
const buildUploadDocTypeFor = (src) => new Function(`${src}\nreturn uploadDocTypeFor;`)();

const quiet = { log() {}, warn() {}, error() {} };

// --- fixtures --------------------------------------------------------------
// L-100 is Deshorn King's load, L-200 is Shorn King's.
const JT = {
	headers: ["Load ID", "Driver", "Job Status"],
	data: [
		{ _rowIndex: 2, "Load ID": "L-100", Driver: "Deshorn King", "Job Status": "In Transit" },
		{ _rowIndex: 3, "Load ID": "L-200", Driver: "Shorn King", "Job Status": "Delivered" },
	],
};

// Every Job Tracking read and every statement prepared is counted, so "refused
// before any read" is asserted rather than assumed.
const counters = { sheetReads: 0, prepared: [], limiter: 0, files: [], emits: 0, emitted: [] };
function resetCounters() {
	counters.sheetReads = 0;
	counters.prepared.length = 0;
	counters.limiter = 0;
	counters.files.length = 0;
	counters.emits = 0;
	counters.emitted.length = 0;
}
const readsOf = () => counters.sheetReads + counters.prepared.length;

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
		uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, ocr_text TEXT DEFAULT '', deleted_at DATETIME DEFAULT NULL
	);
	INSERT INTO documents (load_id, driver, type, file_name, drive_url) VALUES
		('L-100', 'Deshorn King', 'POD', 'L-100_POD_1.pdf', '/uploads/L-100_POD_1.pdf'),
		('L-100', 'Deshorn King', 'BOL', 'L-100_BOL_2.pdf', '/uploads/L-100_BOL_2.pdf'),
		('L-100', '', 'RATECON', 'L-100.pdf', '/uploads/rate-cons/L-100.pdf'),
		('L-200', 'Shorn King', 'POD', 'L-200_POD_3.pdf', '/uploads/L-200_POD_3.pdf');
`);
const docDbRecorded = {
	prepare(sql) { counters.prepared.push(sql); return docDb.prepare(sql); },
};
const docRowCount = () => docDb.prepare("SELECT COUNT(*) AS n FROM documents").get().n;
const lastDoc = () => docDb.prepare("SELECT * FROM documents ORDER BY id DESC LIMIT 1").get();

const limiter = (req, res, next) => { counters.limiter++; next(); };

function documentDeps(overrides = {}) {
	return {
		requireRole, requireAuth, driverWriteLimiter: limiter,
		loadBelongsToDriver, sentIfLoadOwnershipUnverified, resolveDriverActor, LOAD_PANEL_DOCUMENT_FILTER, isRateConDocType,
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
		fs: {
			existsSync: () => true,
			mkdirSync: () => {},
			writeFileSync: (p, bytes) => { counters.files.push(p); },
		},
		io: { to: (room) => ({ emit: (event, payload) => { counters.emits++; counters.emitted.push({ room, event, payload }); } }) },
		insertDispatchNotification: { run: () => ({}) },
		setImmediate: () => {},
		getSheets: async () => { throw new Error("not in this runner"); },
		SPREADSHEET_ID: "sheet-under-test",
		colLetter: () => "A",
		queueReceiptOcr: () => {},
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
const DK = { id: 2, role: "Driver", username: "LogisX-1001", driverName: "Deshorn King" };
const SK = { id: 3, role: "Driver", username: "LogisX-1002", driverName: "Shorn King" };
const DISPATCH = { id: 4, role: "Dispatcher", username: "dispatch1", driverName: "" };
const INVESTOR = { id: 5, role: "Investor", username: "investor1", driverName: "" };
const NAMELESS = { id: 6, role: "Driver", username: "LogisX-1003", driverName: "" };
const NOLAN = { id: 7, role: "Driver", username: "LogisX-1004", driverName: "Nolan Loadless" };
// An Investor session that happens to carry a driver's name. The ownership check
// would admit it by name, so only the mount can refuse it — which is what lets a
// mutant of the mount show up at all.
const INVESTOR_NAMED = { ...INVESTOR, driverName: "Deshorn King" };

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
		r = await uploadAs(user, upload("L-100", "POD", { driverName: "Deshorn King" }));
		ok(`${label}: 403 Forbidden at the mount — no limiter budget, no read, no file, no row`,
			r.status === 403 && r.body.error === "Forbidden" && counters.limiter === 0 && readsOf() === 0 && refusedClean(r),
			brief(r));
	}

	r = await uploadAs(DK, upload("L-100", "POD"));
	ok("Driver, own load, POD: 200, one file written and one row stored as POD",
		r.status === 200 && r.body.success === true && r.inserted === 1 && counters.files.length === 1 &&
		lastDoc().type === "POD" && lastDoc().driver === "Deshorn King", brief(r));
	const podUploaded = () => counters.emitted.filter((e) => e.event === "pod-uploaded");
	ok("...and the pod-uploaded broadcast to the dispatch room carries the POD's link",
		podUploaded().length === 1 && podUploaded()[0].room === "dispatch" && podUploaded()[0].payload.driveUrl === r.body.driveUrl,
		JSON.stringify(podUploaded()));
	r = await uploadAs(DK, upload("L-200", "POD"));
	ok("Driver, another driver's load: 403, no file, no row",
		r.status === 403 && r.body.error === "This load is not assigned to you" && refusedClean(r), brief(r));
	r = await uploadAs(DK, upload("L-100", "POD", { driverName: "Shorn King" }));
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

	r = await uploadAs(DISPATCH, upload("L-200", "BOL", { driverName: "Shorn King" }));
	ok("Dispatcher, any load, BOL: 200 with no ownership read, attributed to the named driver",
		r.status === 200 && r.inserted === 1 && counters.sheetReads === 0 &&
		lastDoc().type === "BOL" && lastDoc().driver === "Shorn King", brief(r));
	r = await uploadAs(DISPATCH, upload("L-200", "RATECON", { driverName: "Shorn King" }));
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
			r.status === 200 && ev.length === 1 && ev[0].payload.docType === t && !("driveUrl" in ev[0].payload) &&
			!JSON.stringify(counters.emitted).includes(r.body.driveUrl), JSON.stringify(counters.emitted));
	}

	// =========================================================================
	console.log("\n§3  PUT /api/messages/read and PUT /api/notifications/read");
	// =========================================================================
	const flagDb = new Database(":memory:");
	flagDb.exec(`
		CREATE TABLE messages (id INTEGER PRIMARY KEY, timestamp TEXT, "from" TEXT, "to" TEXT, message TEXT, load_id TEXT DEFAULT '', read INTEGER DEFAULT 0);
		INSERT INTO messages (id, "from", "to", message) VALUES
			(1, 'Deshorn King', 'Dispatch', 'm1'),
			(2, 'Dispatch', 'Deshorn King', 'm2'),
			(3, 'Dispatch', 'Shorn King', 'm3'),
			(4, 'Dispatch', 'investor1', 'm4'),
			(5, 'Dispatch', 'investor2', 'm5'),
			(6, 'Shorn King', 'dispatch1', 'm6');
		CREATE TABLE notifications (id INTEGER PRIMARY KEY, driver_name TEXT NOT NULL, type TEXT, title TEXT, read INTEGER DEFAULT 0);
		INSERT INTO notifications (id, driver_name, type, title) VALUES
			(1, 'deshorn king', 'message', 'n1'),
			(2, 'shorn king', 'message', 'n2'),
			(3, 'investor1', 'message', 'n3'),
			(4, 'dispatch1', 'message', 'n4'),
			(5, '', 'message', 'n5');
	`);
	const flagDeps = { requireAuth, driverWriteLimiter: limiter, db: flagDb, readFlagOwnName, console: quiet };
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
	const driverDeps = {
		requireRole, requireAuth, normalizeDriverName, findCol,
		sanitizeBrokerColumns: (headers, rows) => rows,
		findDirectoryRowForDriver: () => null,
		db: { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({}) }) },
		getJobTrackingCached: async () => JT,
		liveJobTrackingView: (jt) => ({ ...jt, headers: [...jt.headers], data: jt.data.map((x) => ({ ...x })) }),
		getCarrierDBFromSQLite: () => ({ headers: ["Driver"], data: [] }),
		computeDriverQueues: () => ({}),
		withExpenseWindows: (rows) => rows.map((x) => ({ ...x })),
		stripSigningEvidence: (rows) => rows,
		ONBOARDING_DOCS: [],
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
		r.body.diagnostic.sampleDriverNamesInSheet.join() === "Deshorn King,Shorn King",
		`status ${r.status}, diagnostic ${JSON.stringify(r.body && r.body.diagnostic)}`);

	// =========================================================================
	console.log("\n§5  the callers the document gates were sized against");
	// =========================================================================
	const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : walk(p);
		return /\.(vue|js|ts|html)$/.test(e.name) ? [p] : [];
	});
	const files = [...walk(path.join(ROOT, "client", "src")), ...walk(path.join(ROOT, "public"))];
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

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
