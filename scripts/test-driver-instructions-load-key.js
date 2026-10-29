#!/usr/bin/env node
/**
 * A Dispatcher opens a withheld load's driver instructions by its key (the Dispatcher raw
 * Load ID plan, PR 2 follow-up; WITHHELD_LOAD_REFS_ENABLED, off by default).
 *
 * server.js withheldLoadKeyGate() leaves the path as sent and puts the load a key names on
 * req.withheldLoad; server.js handlers read their load ID through loadIdFor(). The routes
 * lib/driver-instructions-runtime.js mounts read req.params.loadId through routeLoadId(),
 * the same rule, so a request that names a load by its key acts on the load's stored ID.
 *
 * Written before the change: on main §1, §2 and §3 fail (no routeLoadId(); every staff route
 * answered a key 404 LOAD_NOT_FOUND; a locked Dispatcher's refusal was audited under the key).
 * §4 holds pins that pass on main too: an unknown key, the flag off, a Super Admin, the
 * driver route.
 *
 *   §1 routeLoadId() reads a path as server.js loadIdFor() (lifted) reads it, over a table of
 *      requests with and without a key
 *   §2 by key, through the shipped gate: a Dispatcher's GET, PUT, review, accept-pending and
 *      re-extract act on the stored load and audit it under its stored ID; the refusals answer
 *      their own codes; no answer or error holds the stored ID, and the reply guard counts no hit
 *   §3 the edit lock: a locked Dispatcher's write by key answers 423 and is audited under the
 *      stored ID, never the key
 *   §4 pins: an unknown key answers the gate's 404 LOAD_KEY_UNKNOWN before any route; with the
 *      flag off a path reads as sent; a Super Admin reads by the stored ID and a key he names is
 *      never read; the driver route refuses a Dispatcher 403 and serves a Driver his own load
 *
 * withheldLoadKeyGate(), requireRole, logAudit and logAuditRefusal are lifted from server.js
 * (scripts/lib/server-lift.js closure()) and run in front of the runtime's own create() over
 * an in-memory database, behind a real express app. Gemini is a stub; Drive is never read.
 * Every value is made up: QA- and 7712 load numbers, 555-010-01xx phones, example.test
 * addresses, the deny value.
 *
 *   node scripts/test-driver-instructions-load-key.js     # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function findRoot(start) {
	for (let d = start; ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "server.js")) && fs.existsSync(path.join(d, "package.json"))) return d;
		if (path.dirname(d) === d) throw new Error(`no repo root above ${start}`);
	}
}
const ROOT = findRoot(__dirname);
const SRC = require("./lib/server-source").serverSource();
const RUNTIME = path.join(ROOT, "lib", "driver-instructions-runtime.js");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const express = require(path.join(ROOT, "node_modules", "express"));
const lift = require(path.join(ROOT, "scripts", "lib", "server-lift.js"));
const { withheldLoadKeyHelpers } = require(path.join(ROOT, "scripts", "lib", "withheld-load-key-lift.js"));
const keyLib = require(path.join(ROOT, "lib", "withheld-load-key.js"));
const di = require(path.join(ROOT, "lib", "driver-instructions.js"));

// ── harness ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const queue = [];
const openWorlds = [];
function test(name, fn) { queue.push([name, fn]); }
async function runAll() {
	for (const [name, fn] of queue) {
		const checks = [];
		const eq = (label, actual, expected) => {
			const a = JSON.stringify(actual);
			const e = JSON.stringify(expected);
			checks.push({ ok: a === e, label, detail: `expected ${e}\n             actual   ${a}`.slice(0, 1200) });
		};
		try {
			await fn({ eq });
		} catch (err) {
			checks.push({ ok: false, label: "threw", detail: String((err && err.stack) || err).split("\n").slice(0, 3).join(" | ") });
		} finally {
			for (const w of openWorlds.splice(0)) await w.close();
		}
		const good = checks.length > 0 && checks.every((c) => c.ok);
		if (good) passed++; else failed++;
		console.log(`  ${good ? "ok  " : "FAIL"}  ${name}`);
		if (!good) {
			for (const c of checks.filter((x) => !x.ok).slice(0, 6)) console.log(`        - ${c.label}${c.detail ? `\n             ${c.detail}` : ""}`);
			if (!checks.length) console.log("        - no check ran");
		}
	}
	console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
	process.exit(failed ? 1 : 0);
}

// ── made-up values ────────────────────────────────────────────────────────────
const DENY = "T8273641";
// A Load ID holding a phone: withheld from a Dispatcher, who names the load by its key.
const HID = "QA-555-010-0161";
const HKEY = HID.toLowerCase();
const NID = "771200345";
const PU = "4820193746";
const ON = Object.freeze({
	RATECON_DRIVER_INSTRUCTIONS_ENABLED: "true", CARRIER_ACCOUNT_NUMBERS_DENY_SECRET: DENY,
	DRIVER_LOAD_INSTRUCTIONS_SCREEN_ENABLED: "true", WITHHELD_LOAD_REFS_ENABLED: "true",
});
const SA = { id: 1, username: "admin_test", role: "Super Admin" };
const DISP = { id: 2, username: "disp_test", role: "Dispatcher" };
const DRIVER = { id: 4, username: "driver_test", role: "Driver", driverName: "Test Driver A" };
const HEADERS = ["Load ID", "Status", "Driver", "Pickup Info", "Pickup Address", "Drop-off Address", "  Payment  ", "Phone Number", "Email", "Broker Contact Name"];
const ROWS = [
	[HID, "Dispatched", "Test Driver A", `Test Mill North REF/PU#: ${PU}`, "100 Test Park Dr, Springfield, IL 62701", "55 Depot Ln, Riverton, WY 82501", "$1,200.00", "(555) 010-0199", "opsdesk.north@broker-example.test", "Pat Broker"],
	[NID, "Assigned", "Test Driver C", "Test Yard REF/PU#: 6660002222", "9 Gamma St, Dover, DE 19901", "8 Delta St, Akron, OH 44301", "$1,500.00", "", "", ""],
];
// Production's Payments Table and Job Details headers, no rows.
const SIDE = Object.freeze({
	payments: [["Contract ID", " Job ID", "Invoice Number", "Payment Amount"]],
	jobDetails: [["", "Distance", "Rate Per Mile", "Details", "Driver", "Pickup Address", "Drop-off Address", "Payment", "Job Status", "Carrier Stage", "Driver Name",
		"Phone Number", "Email", "Location Link", "Documents", "Assigned Date", "Completion Date", " Notes", "Notes to Driver", "output (retired)"]],
});
// Whether a reply holds the stored ID: as text in any letter case, or its phone with any separators.
function holdsStoredId(text) {
	const s = String(text == null ? "" : text);
	return s.toLowerCase().includes(HKEY) || /555\D{0,4}010\D{0,4}0161/.test(s);
}
function extraction() {
	return {
		loadNumber: "771200999",
		documentKind: "carrier_load_confirmation",
		contacts: [],
		loadRequirements: [{ category: "same_driver", text: "The same driver must stay with the load from pickup to delivery." }],
		stops: [
			{
				kind: "pickup", facility: "Test Mill North", place: "Springfield, IL", address: "100 Test Park Dr, Springfield, IL 62701",
				references: [{ type: "pickup_number", label: "Pickup#", value: PU }],
				requirements: [], instructions: [{ kind: "hours", text: "Receiving hours 0700-1500, first come first served." }],
			},
			{ kind: "delivery", facility: "Test Foods DC", place: "Riverton, WY", address: "55 Depot Ln, Riverton, WY 82501", references: [], requirements: [], instructions: [] },
		],
	};
}
function editBody(text) {
	return {
		payload: {
			loadRequirements: [{ category: "check_in", text }],
			stops: [{ kind: "pickup", facility: "Test Mill North", place: "Springfield, IL", references: [{ type: "pickup_number", label: "Pickup#", value: PU }], requirements: [], instructions: [] }],
		},
	};
}
// A minimal PDF whose only text object prints `text`.
function pdfWith(text) {
	const page = Buffer.from(`BT /F1 10 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET`, "latin1");
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${page.length} >>\nstream\n`, "latin1"),
		page,
		Buffer.from("\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n", "latin1"),
	]);
}
const READABLE = pdfWith(`Rate Confirmation Carrier Load Confirmation Load 771200999 Shipper Test Mill North Springfield, IL Pickup Number ${PU} ` +
	"Consignee Test Foods DC Riverton, WY Total Rate $1,200.00 Trailer Dry Van Equipment Freight");

// ── the world ─────────────────────────────────────────────────────────────────
// What server.js runs in front of the runtime: the gate (with the reply guard it installs),
// requireRole, logAudit and logAuditRefusal, and what the runner reads keys and indexes by.
const LIFTED = ["withheldLoadKeyGate", "requireRole", "logAudit", "logAuditRefusal", "BROKER_WITHHELD_RE", "WITHHELD_LOAD_KEYS", "WITHHELD_LOAD_KEY_STATE", "loadKeyFor", "shownLoadIdIndex"];
let CLOSURE = null;
function serverPieces() {
	if (!CLOSURE) CLOSURE = lift.closure(SRC, { roots: LIFTED, provided: ["db", "process", "console", "require", "getJobTrackingCached"], denied: ["app", "io", "server"] });
	return CLOSURE;
}
const liftRequire = (p) => require(/^\.\/lib\//.test(p) ? path.join(ROOT, p) : p);
const jobTracking = () => ({ headers: [...HEADERS], data: ROWS.map((r, i) => Object.assign(Object.fromEntries(HEADERS.map((h, j) => [h, r[j]])), { _rowIndex: i + 2 })) });

async function world({ env = ON } = {}) {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER, username TEXT, role TEXT, action TEXT NOT NULL,
		entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
	db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, driver TEXT NOT NULL, type TEXT NOT NULL, file_name TEXT NOT NULL, drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_at DATETIME DEFAULT NULL)");
	db.exec("CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_by TEXT DEFAULT '')");
	db.exec("CREATE TABLE ratecon_load_aliases (alias TEXT PRIMARY KEY, load_id TEXT NOT NULL, source TEXT DEFAULT '', drive_file_id TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
	const w = { db, logs: [], sockets: [], gemini: 0, uploads: fs.mkdtempSync(path.join(os.tmpdir(), "dikey-uploads-")) };
	const cap = (kind) => (...a) => w.logs.push(`${kind} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`);
	const quiet = { log: cap("log"), info: cap("info"), warn: cap("warn"), error: cap("error") };
	const c = serverPieces();
	const S = new Function("db", "process", "console", "require", "getJobTrackingCached", `${c.text}\nreturn { ${LIFTED.join(", ")} };`)(
		db, { env: { ...env } }, quiet, liftRequire, async () => jobTracking());
	w.S = S;
	w.state = S.WITHHELD_LOAD_KEY_STATE;
	w.key = (id) => S.WITHHELD_LOAD_KEYS.keyFor(id);
	w.index = () => S.shownLoadIdIndex(jobTracking());
	const geminiBody = () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(extraction()) }] }, finishReason: "STOP" }] });
	w.service = require(RUNTIME).create({
		db,
		env: { ...env },
		log: quiet,
		fetch: async () => {
			w.gemini++;
			const body = geminiBody();
			return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
		},
		geminiApiKey: "gemini-key-under-test",
		geminiModel: "gemini-model-under-test",
		getDrive: async () => { throw new Error("Drive is not read in this runner"); },
		getJobTracking: async () => jobTracking(),
		getSideSheets: async () => SIDE,
		brokerWithheldRe: S.BROKER_WITHHELD_RE,
		ingestionGeminiUnavailableAt: () => 0,
		logAudit: S.logAudit,
		logAuditRefusal: S.logAuditRefusal,
		notifySuperAdmins: (notice) => w.sockets.push({ room: "super-admin", notice }),
		sendAdminEmail: () => null,
		uploadsDir: w.uploads,
		loadBelongsToDriver: async (loadId, driverName) => ROWS.some((r) => r[0].toLowerCase() === String(loadId).trim().toLowerCase() && r[2] === driverName),
		emitToDriver: (name, event, payload) => w.sockets.push({ room: `driver:${name}`, event, payload }),
	});
	const app = express();
	app.use(express.json({ limit: "2mb" }));
	app.use((req, res, next) => {
		const u = req.headers["x-test-user"];
		req.session = { user: u ? JSON.parse(u) : null };
		next();
	});
	app.use(S.withheldLoadKeyGate);
	w.service.mount(app, { requireRole: S.requireRole });
	w.server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
	w.base = `http://127.0.0.1:${w.server.address().port}`;
	w.close = async () => {
		await new Promise((r) => w.server.close(() => r()));
		fs.rmSync(w.uploads, { recursive: true, force: true });
		db.close();
	};
	w.call = async (method, url, user, body) => {
		const headers = { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" };
		if (user) headers["x-test-user"] = JSON.stringify(user);
		const resp = await fetch(`${w.base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await resp.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* not JSON */ }
		return { status: resp.status, body: json, text };
	};
	w.row = () => db.prepare("SELECT * FROM load_driver_instructions WHERE load_key = ?").get(HKEY);
	w.rows = () => db.prepare("SELECT load_key, load_id FROM load_driver_instructions ORDER BY load_key").all();
	w.audits = () => db.prepare("SELECT action, entity_id FROM audit_trail ORDER BY id").all();
	openWorlds.push(w);
	return w;
}
// The withheld load's stored instructions, as the sweep would have left them.
function storeRow(w, { status = "auto", published = true } = {}) {
	const t = "2026-10-22T14:00:00Z";
	w.db.prepare(`INSERT INTO load_driver_instructions (load_key, load_id, payload, status, review_reasons, source, published_at, driver_shown_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, '[]', 'drive_sweep', ?, '', ?, ?)`).run(HKEY, HID, JSON.stringify(extraction()), status, published ? t : "", t, t);
}
// A drag-and-drop rate con on file for the withheld load.
function putRateCon(w) {
	const dir = path.join(w.uploads, "rate-cons");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "qa-load-h.pdf"), READABLE);
	w.db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_url) VALUES (?, '', 'RATECON', ?, ?)").run(HID, "qa-load-h.pdf", "/uploads/rate-cons/qa-load-h.pdf");
}
const staffApi = (id) => `/api/loads/${encodeURIComponent(id)}/driver-instructions`;

// ── §1 the helper ─────────────────────────────────────────────────────────────
test("§1 routeLoadId() reads a path as server.js loadIdFor() does: the key the gate named reads as the stored ID, anything else as sent", async ({ eq }) => {
	const { routeLoadId } = require(RUNTIME);
	const { loadIdFor } = withheldLoadKeyHelpers(SRC);
	const K = keyLib.createLoadKeys({ secret: Buffer.from("made-up-runner-secret-dikey") }).keyFor(HID);
	const W = { raw: HID, shown: "QA-[contact withheld]", key: K, drivers: new Set() };
	const cases = [
		[{ params: { loadId: NID } }, NID],
		[{ params: { loadId: K }, withheldLoad: W }, HID],
		[{ params: { loadId: ` ${K} ` }, withheldLoad: W }, HID],
		[{ params: { loadId: NID }, withheldLoad: W }, NID],
		[{ params: { loadId: HID }, withheldLoad: W }, HID],
		[{ params: { loadId: K.toUpperCase() }, withheldLoad: W }, K.toUpperCase()],
		[{ params: { loadId: K } }, K],
		[{ params: {}, withheldLoad: W }, ""],
		[{ params: { loadId: "7".repeat(90) } }, "7".repeat(80)],
	];
	eq("each request reads as expected", cases.map(([req]) => routeLoadId(req)), cases.map(([, want]) => want));
	eq("each reads as server.js loadIdFor() reads it (as text, 80 characters at most)",
		cases.map(([req]) => routeLoadId(req)), cases.map(([req]) => String(loadIdFor(req, req.params.loadId) ?? "").slice(0, 80)));
});

// ── §2 by key ─────────────────────────────────────────────────────────────────
test("§2 by key, a Dispatcher's GET, PUT, accept-pending, review and re-extract act on the stored load, audited under its stored ID; no answer holds it; no hit", async ({ eq }) => {
	const w = await world();
	const K = w.key(HID);
	eq("the fixture: the load's ID is withheld from a Dispatcher and served with its key; the normal load's is not",
		[w.S.loadKeyFor("Dispatcher", HID, { index: w.index() }), w.S.loadKeyFor("Dispatcher", NID, { index: w.index() })], [K, ""]);
	storeRow(w, { status: "needs_review", published: false });
	const api = staffApi(K);
	const g = await w.call("GET", api, DISP);
	eq("GET: 200, the stored load's instructions", [g.status, g.body && g.body.status], [200, "needs_review"]);
	const p = await w.call("PUT", api, DISP, editBody("Check in with the guard and show your CDL."));
	eq("PUT: 200, written on the stored load's row", [p.status, w.row().source, w.row().reviewed_by], [200, "staff", "disp_test"]);
	w.db.prepare("UPDATE load_driver_instructions SET pending_payload = ?, pending_reasons = '[\"rate_con_changed\"]' WHERE load_key = ?").run(JSON.stringify(extraction()), HKEY);
	const a = await w.call("POST", `${api}/accept-pending`, DISP, { action: "accept" });
	eq("accept-pending: 200, the pending reading published", [a.status, a.body && a.body.published, a.body && a.body.pending], [200, true, null]);
	const rv = await w.call("POST", `${api}/review`, DISP, {});
	eq("review: 200, reviewed", [rv.status, rv.body && rv.body.status], [200, "reviewed"]);
	putRateCon(w);
	const x = await w.call("POST", `${api}/re-extract`, DISP, {});
	eq("re-extract: 200, the stored load's rate con read (one Gemini call)", [x.status, typeof (x.body && x.body.result), w.gemini], [200, "string", 1]);
	eq("the only instructions row is the stored load's", w.rows(), [{ load_key: HKEY, load_id: HID }]);
	eq("every write audited under the stored ID", [...new Set(w.audits().map((r) => r.entity_id))], [HID]);
	eq("no answer holds the stored ID", [g, p, a, rv, x].filter((r) => holdsStoredId(r.text)).length, 0);
	eq("the reply guard counted no hit", w.state.replyGuardHits, 0);
});

test("§2 by key, the refusals answer their own codes and name no load: nothing to review 409, nothing pending 409, no rate con 404, an invalid edit 400", async ({ eq }) => {
	const w = await world();
	const api = staffApi(w.key(HID));
	const rv = await w.call("POST", `${api}/review`, DISP, {});
	const ac = await w.call("POST", `${api}/accept-pending`, DISP, { action: "accept" });
	const rx = await w.call("POST", `${api}/re-extract`, DISP, {});
	const bad = await w.call("PUT", api, DISP, { payload: { loadRequirements: "not a list" } });
	eq("each refusal's status and code", [rv, ac, rx, bad].map((r) => [r.status, r.body && r.body.code]),
		[[409, "INSTRUCTIONS_NOTHING_TO_REVIEW"], [409, "INSTRUCTIONS_NO_PENDING"], [404, "INSTRUCTIONS_NO_RATE_CON"], [400, di.INVALID_CODE]]);
	eq("no refusal holds the stored ID; the reply guard counted no hit", [[rv, ac, rx, bad].filter((r) => holdsStoredId(r.text)).length, w.state.replyGuardHits], [0, 0]);
	eq("nothing written", w.rows(), []);
});

// ── §3 the edit lock ──────────────────────────────────────────────────────────
// One world per write: logAuditRefusal() keeps one row per person, action and code a window.
test("§3 a locked Dispatcher's write by key: 423 with the code only, each refusal audited under the stored ID, never the key; a read still answers", async ({ eq }) => {
	const writes = [["PUT", "", editBody("Check in with the guard.")], ["POST", "/review", {}], ["POST", "/accept-pending", { action: "keep" }], ["POST", "/re-extract", {}]];
	const out = [];
	let last = null;
	for (const [method, tail, body] of writes) {
		const w = await world();
		storeRow(w, { status: "needs_review", published: false });
		w.db.prepare("INSERT INTO driver_instructions_edit_locks (user_id, username, role, locked_at) VALUES (?, ?, ?, ?)").run(DISP.id, DISP.username, DISP.role, "2026-10-22T15:00:00Z");
		const K = w.key(HID);
		const r = await w.call(method, `${staffApi(K)}${tail}`, DISP, body);
		const refusals = w.audits().filter((a) => a.action === "edit_locked_refused");
		out.push({ r, audited: refusals.map((a) => a.entity_id), keyed: w.audits().filter((a) => String(a.entity_id).includes(K)).length, w, K });
		last = { w, K };
	}
	eq("each answers 423 INSTRUCTIONS_EDIT_LOCKED", out.map((o) => [o.r.status, o.r.body && o.r.body.code]), writes.map(() => [423, "INSTRUCTIONS_EDIT_LOCKED"]));
	eq("each refusal audited once, under the stored ID", out.map((o) => o.audited), writes.map(() => [HID]));
	eq("no audit row names the key", out.map((o) => o.keyed), writes.map(() => 0));
	const g = await last.w.call("GET", staffApi(last.K), DISP);
	eq("a read by key still answers, with editLocked", [g.status, g.body && g.body.editLocked], [200, true]);
	eq("no answer holds the stored ID; the reply guard counted no hit",
		[[...out.map((o) => o.r), g].filter((r) => holdsStoredId(r.text)).length, out.map((o) => o.w.state.replyGuardHits)], [0, writes.map(() => 0)]);
});

// ── §4 pins ───────────────────────────────────────────────────────────────────
test("§4 pin: an unknown key answers the gate's 404 LOAD_KEY_UNKNOWN before any route: nothing read, written or audited", async ({ eq }) => {
	const w = await world();
	storeRow(w);
	const stranger = keyLib.createLoadKeys({ secret: Buffer.from("made-up-other-process") }).keyFor(HID);
	const api = staffApi(stranger);
	const out = [await w.call("GET", api, DISP), await w.call("PUT", api, DISP, editBody("Check in with the guard.")), await w.call("POST", `${api}/re-extract`, DISP, {})];
	eq("404 LOAD_KEY_UNKNOWN", out.map((r) => [r.status, r.body && r.body.code]), out.map(() => [404, "LOAD_KEY_UNKNOWN"]));
	eq("nothing written or audited, no Gemini call", [w.row().source, w.audits().length, w.gemini], ["drive_sweep", 0, 0]);
	eq("no answer holds the stored ID", out.filter((r) => holdsStoredId(r.text)).length, 0);
});

test("§4 pin: with the flag off a path reads as sent: a key names no load (404 LOAD_NOT_FOUND); a normal Load ID reads as before", async ({ eq }) => {
	const w = await world({ env: { ...ON, WITHHELD_LOAD_REFS_ENABLED: "" } });
	storeRow(w);
	const byKey = await w.call("GET", staffApi(w.key(HID)), DISP);
	const normal = await w.call("GET", staffApi(NID), DISP);
	eq("the key 404 LOAD_NOT_FOUND; the normal load 200", [[byKey.status, byKey.body && byKey.body.code], normal.status], [[404, "LOAD_NOT_FOUND"], 200]);
});

test("§4 pin: a Super Admin reads by the stored ID as before; a key he names is never read (keys are for Dispatchers)", async ({ eq }) => {
	const w = await world();
	storeRow(w, { status: "needs_review", published: false });
	const stored = await w.call("GET", staffApi(HID), SA);
	const byKey = await w.call("GET", staffApi(w.key(HID)), SA);
	eq("the stored ID 200; the key 404 LOAD_NOT_FOUND", [[stored.status, stored.body && stored.body.status], [byKey.status, byKey.body && byKey.body.code]],
		[[200, "needs_review"], [404, "LOAD_NOT_FOUND"]]);
});

test("§4 pin: the driver route refuses a Dispatcher by key 403, naming nothing; a Driver reads his own load by its stored ID as before", async ({ eq }) => {
	const w = await world();
	storeRow(w);
	const disp = await w.call("GET", `/api/driver/loads/${w.key(HID)}/instructions`, DISP);
	const own = await w.call("GET", `/api/driver/loads/${encodeURIComponent(HID)}/instructions`, DRIVER);
	eq("Dispatcher 403; the Driver's own load published", [[disp.status, disp.body], [own.status, own.body && own.body.state]], [[403, { error: "Forbidden" }], [200, "published"]]);
	eq("the reply guard counted no hit", w.state.replyGuardHits, 0);
});

runAll();
