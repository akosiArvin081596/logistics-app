#!/usr/bin/env node
/**
 * scripts/pending/test-invoice-lines-routes.js — B20 Phase 1, the routes.
 *
 * PENDING: written before the server.js half of B20. It passes once server.js
 * carries the draft-route changes, the three invoice-lines routes and their
 * flag gate; then it moves to scripts/ (scripts/run-unit-tests.js runs the top
 * level only). SERVER_JS=<file> runs it against another copy of server.js.
 *
 * Each route is lifted from server.js and run over an in-memory database, the
 * way scripts/test-invoice-email-body.js runs the draft routes: Sheets, Drive,
 * Gemini, Chromium, Gmail and n8n are stubs that record what they are handed;
 * the validators, the sheet parsing, the draft record, lib/broker-invoice.js
 * and lib/broker-invoice-lines.js are the shipped code.
 *
 *   §1 flag off: the dryRun, the approve, the preview and the n8n payload are
 *      what they are today, even with a line on the load; the three new routes
 *      hand the request on (next("route")) and never run
 *   §2 adding, listing and voiding a line: Super Admin's handlers, audited
 *      after the write, refusals unaudited, a closed-month load accepted
 *   §3 the dryRun: the lines, the figures, a refusal reported (render skipped)
 *   §4 the approve: balance due billed, line haul kept, lines recorded, every
 *      refusal before an invoice number is minted
 *   §5 the preview: the same figures as the approve, nothing written
 *   §6 wiring that no value can prove (order of the guards, the flag reads)
 *
 * Every fixture is made up. Pure: no server, no network.
 * Run: node scripts/pending/test-invoice-lines-routes.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

// The repo root, found from here, so the file runs from scripts/pending/ now and
// from scripts/ once it moves.
function findRoot(start) {
	for (let d = start; ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "server.js")) && fs.existsSync(path.join(d, "package.json"))) return d;
		if (path.dirname(d) === d) throw new Error(`no repo root above ${start}`);
	}
}
const ROOT = findRoot(__dirname);
const SERVER = process.env.SERVER_JS || path.join(ROOT, "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");
const LIB_PATH = path.join(ROOT, "lib", "broker-invoice.js");
const LINES_PATH = path.join(ROOT, "lib", "broker-invoice-lines.js");
const Database = require("better-sqlite3");

const BISON_TO = "bison-ap@example.test";
const DEFAULT_TO = "ap@example.test";
process.env.BISON_INVOICE_EMAIL = BISON_TO;
process.env.DEFAULT_INVOICE_EMAIL = DEFAULT_TO;
delete process.env.BROKER_INVOICE_LINES_ENABLED;
const brokerInvoice = require(LIB_PATH);

// ── the per-case harness ──────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
async function runAll() {
	for (const [name, fn] of queue) {
		const checks = [];
		const eq = (label, actual, expected) => {
			const a = JSON.stringify(actual);
			const e = JSON.stringify(expected);
			checks.push({ ok: a === e, label, detail: `expected ${e}\n             actual   ${a}` });
		};
		const ok = (label, cond, detail = "") => checks.push({ ok: !!cond, label, detail });
		try {
			await fn({ eq, ok });
		} catch (err) {
			checks.push({ ok: false, label: "threw", detail: String((err && err.message) || err).split("\n")[0] });
		}
		const good = checks.length > 0 && checks.every((c) => c.ok);
		if (good) passed++; else failed++;
		console.log(`  ${good ? "ok  " : "FAIL"}  ${name}`);
		if (!good) {
			for (const c of checks.filter((x) => !x.ok).slice(0, 5)) console.log(`        - ${c.label}${c.detail ? `\n             ${c.detail}` : ""}`);
			if (!checks.length) console.log("        - no check ran");
		}
	}
	console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
	process.exit(failed ? 1 : 0);
}

// ── extraction ────────────────────────────────────────────────────────────────
const countOf = (hay, needle) => hay.split(needle).length - 1;
function extractFn(src, name) {
	const needle = `\nfunction ${name}(`;
	const hits = countOf(src, needle);
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1;
	let depth = 0;
	for (let j = src.indexOf("{", start); j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}
function extractConst(src, name) {
	const needle = `\nconst ${name} = `;
	if (countOf(src, needle) !== 1) throw new Error(`expected exactly 1 declaration of ${name} in server.js`);
	const start = src.indexOf(needle) + 1;
	return src.slice(start, src.indexOf("\n", start));
}
// A registration from its `app.<verb>(` line to the `);` / `});` that closes it
// at column 0.
function extractRoute(src, needle, what) {
	const lines = src.split("\n");
	const hits = lines.filter((l) => l.includes(needle)).length;
	if (hits !== 1) throw new Error(`no single registration of ${what} in server.js (found ${hits}; the server.js half of B20 adds it)`);
	let s = lines.findIndex((l) => l.includes(needle));
	while (s > 0 && !/^app\.(post|get|put|delete)\(/.test(lines[s])) s--;
	let e = s;
	while (e < lines.length && lines[e] !== ");" && lines[e] !== "});") e++;
	if (e >= lines.length) throw new Error(`unterminated registration for ${what}`);
	return lines.slice(s, e + 1).join("\n");
}
const APPROVE_NEEDLE = '["/api/loads/:loadId/draft-invoice", "/api/loads/:loadId/draft-bison-invoice"],';
const PREVIEW_NEEDLE = '"/api/loads/:loadId/invoice-preview",';
const GET_LINES = 'app.get("/api/loads/:loadId/invoice-lines",';
const ADD_LINE = 'app.post("/api/loads/:loadId/invoice-lines",';
const VOID_LINE = 'app.post("/api/loads/:loadId/invoice-lines/:id/void",';

const CONSTS = [
	"EVIDENCE_TEXT_STRIP", "INVOICE_TOTAL_FORMAT_RE", "INVOICE_TOTAL_MAX", "INVOICE_TOTAL_MIN", "INVOICE_ID_RE",
	"INVOICE_REF_RE", "INVOICE_ORDER_RE", "INVOICE_FIELD_SCAN_MAX", "INVOICE_NOTES_MAX", "INVOICE_NOTES_SCAN_MAX",
	"INVOICE_EMAIL_BODY_MAX", "INVOICE_EMAIL_BODY_SCAN_MAX", "INVOICE_YEAR_MIN", "INVOICE_YEAR_MAX",
];
const FNS = ["sanitizeEvidenceText", "sanitizeInvoiceNotes", "isoToMdy", "mdyToIso", "isRealCalendarDate", "safeAttachmentName", "parseInvoiceOverrides"];
let LIFTED = null;
function lifted() {
	if (LIFTED) return LIFTED;
	if (!fs.existsSync(LINES_PATH)) throw new Error("lib/broker-invoice-lines.js does not exist yet (the B20 build adds it)");
	const shippedBody = CONSTS.map((c) => extractConst(SRC, c)).join("\n") + "\n" + FNS.map((f) => extractFn(SRC, f)).join("\n") +
		`\nreturn { ${FNS.join(", ")} };`;
	const createAt = SRC.indexOf("CREATE TABLE IF NOT EXISTS load_invoice_drafts (");
	LIFTED = {
		approve: extractRoute(SRC, APPROVE_NEEDLE, "POST /api/loads/:loadId/draft-invoice"),
		preview: extractRoute(SRC, PREVIEW_NEEDLE, "POST /api/loads/:loadId/invoice-preview"),
		getLines: extractRoute(SRC, GET_LINES, "GET /api/loads/:loadId/invoice-lines"),
		addLine: extractRoute(SRC, ADD_LINE, "POST /api/loads/:loadId/invoice-lines"),
		voidLine: extractRoute(SRC, VOID_LINE, "POST /api/loads/:loadId/invoice-lines/:id/void"),
		gate: extractFn(SRC, "brokerInvoiceLinesGate"),
		fns: Object.fromEntries(["parseSheet", "deduplicateLoads", "findCol", "latestDraftNotes", "invoiceIdAlreadyUsed"].map((n) => [n, extractFn(SRC, n)])),
		createSql: SRC.slice(createAt, SRC.indexOf("`", createAt)),
		alters: [...SRC.matchAll(/db\.exec\("(ALTER TABLE load_invoice_drafts ADD COLUMN [^"]+)"\)/g)].map((m) => m[1]),
		shipped: new Function("brokerInvoice", shippedBody)(brokerInvoice),
	};
	return LIFTED;
}

// ── fixtures (made up) ────────────────────────────────────────────────────────
const SHEET = [
	["Load ID", "Status", "Email", "Broker Contact Name", "Driver", "Trailer", "Delivery Date", "Assigned Date", "  Payment  "],
	["41000017", "Delivered", "agent@bisontransport.com", "Pat Agent", "Test Driver A", "", "10/14/2026", "10/10/2026", "2400"],
	["41000018", "Delivered", "dispatch@acme-freight.example.test", "Jane Agent", "Test Driver B", "", "10/14/2026", "10/10/2026", "3000"],
	["41000019", "Delivered", "dispatch@acme-freight.example.test", "Jane Agent", "Test Driver C", "", "10/14/2026", "10/10/2026", ""],
];
const MINTED = "10162026-1";
const GMAIL = Object.freeze({ GMAIL_USER: "invoices@example.test", GMAIL_APP_PASSWORD: "app-password-under-test" });
const N8N = Object.freeze({ N8N_INVOICE_WEBHOOK_URL: "https://n8n.example.invalid/webhook/invoice", N8N_WEBHOOK_SECRET: "test-secret" });
const ON = Object.freeze({ BROKER_INVOICE_LINES_ENABLED: "true" });
const BISON_REFS = Object.freeze({ orderNumber: "7000002", poNumber: "2700011" });
const ADVANCE = Object.freeze({ amount: "650", receivedOn: "2026-10-12", reference: "EFS-55501" });

// The routes over a fresh in-memory database.
function harness(env = {}, { closedMonths = [] } = {}) {
	const Lf = lifted();
	const db = new Database(":memory:");
	db.exec(Lf.createSql);
	for (const a of Lf.alters) db.exec(a);
	db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT, type TEXT, file_name TEXT, uploaded_at TEXT, deleted_at TEXT)");
	db.exec(`CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, driver TEXT NOT NULL, load_id TEXT DEFAULT '',
		type TEXT NOT NULL, amount REAL NOT NULL, description TEXT DEFAULT '', date TEXT NOT NULL, photo_data TEXT DEFAULT '', status TEXT DEFAULT 'Pending')`);
	const addPod = db.prepare("INSERT INTO documents (load_id, type, file_name, uploaded_at) VALUES (?, 'POD', ?, '2026-10-14T15:00:00Z')");
	for (const row of SHEET.slice(1)) addPod.run(row[0], `${row[0]}_POD.pdf`);
	brokerInvoice.invoiceLines.ensureSchema(db);

	const seen = { sheetReads: 0, minted: 0, html: [], drafts: [], posts: [], audits: [], errors: [], nextRoute: 0, handlerRuns: 0 };
	const fn = (name, deps = {}) => new Function(...Object.keys(deps), `${Lf.fns[name]}\nreturn ${name};`)(...Object.values(deps));
	const S = Lf.shipped;
	const parseSheet = fn("parseSheet");
	const deduplicateLoads = fn("deduplicateLoads");
	const processStub = { env: { ...env } };
	const scope = {
		requireRole: () => (req, res, next) => next(),
		refuseCrossSite: (req, res, next) => next(),
		draftInvoiceLimiter: (req, res, next) => next(),
		invoicePreviewLimiter: (req, res, next) => next(),
		brokerInvoiceLinesGate: null,
		parseInvoiceOverrides: S.parseInvoiceOverrides,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => { seen.sheetReads++; return { data: { values: SHEET } }; } } } }),
		getJobTrackingCached: async () => { seen.sheetReads++; const p = parseSheet({ values: SHEET }); p.data = deduplicateLoads(p.data, p.headers); return p; },
		integrityClosedMonthsOf: () => closedMonths,
		SPREADSHEET_ID: "sheet-under-test",
		parseSheet,
		deduplicateLoads,
		findCol: fn("findCol"),
		brokerInvoice,
		db,
		fetchDocumentBytes: async () => Buffer.from("%PDF-1.4 pod"),
		buildRateConLoadCtx: () => ({}),
		getRateConBytes: async () => ({ buffer: null, candidates: [] }),
		GEMINI_API_KEY: "",
		runRateConGemini: async () => null,
		peekInvoiceNumber: () => MINTED,
		nextInvoiceNumber: () => { seen.minted++; return MINTED; },
		mdyToIso: S.mdyToIso,
		latestDraftNotes: fn("latestDraftNotes", { db }),
		invoiceIdAlreadyUsed: fn("invoiceIdAlreadyUsed", { db }),
		renderHtmlToPdf: async (html) => { seen.html.push(String(html)); return Buffer.from("%PDF-1.4 invoice"); },
		safeAttachmentName: S.safeAttachmentName,
		logAudit: (req, action, entity, id, detail) => seen.audits.push({ action, entity, id, detail }),
		sanitizeEvidenceText: S.sanitizeEvidenceText,
		appendGmailDraft: async (msg) => { seen.drafts.push(msg); },
		sentIfRendererBusy: () => false,
		REPLICA: null,
		process: processStub,
		fetch: async (url, init) => {
			seen.posts.push({ url, payload: JSON.parse(init.body) });
			return { ok: true, status: 200, text: async () => '{"draftId":"n8n-1"}' };
		},
		console: { log() {}, warn() {}, error: (...a) => seen.errors.push(a.join(" ")) },
		INVOICE_PREVIEW_MAX_INFLIGHT: 2,
		invoicePreviewInflight: 0,
	};
	scope.brokerInvoiceLinesGate = new Function("brokerInvoice", "process", `${Lf.gate}\nreturn brokerInvoiceLinesGate;`)(brokerInvoice, processStub);
	const register = (text) => {
		const registered = [];
		const app = { post: (...a) => registered.push(a), get: (...a) => registered.push(a) };
		new Function("app", ...Object.keys(scope), text)(app, ...Object.values(scope));
		if (registered.length !== 1) throw new Error(`expected 1 registration, got ${registered.length}`);
		return registered[0].slice(1);
	};
	const res = () => {
		const r = { statusCode: 200, body: undefined, headersSent: false };
		r.status = (c) => { r.statusCode = c; return r; };
		r.json = (b) => { r.body = b; r.headersSent = true; return r; };
		return r;
	};
	const USER = { id: 1, username: "super_admin", role: "Super Admin" };
	// The whole chain, as Express runs it: a middleware that calls next("route")
	// hands the request on, and the handler never runs.
	const run = async (chain, { params = {}, query = {}, body = {} } = {}) => {
		const req = { params, query, body, session: { user: { ...USER } }, ip: "127.0.0.1", headers: { "x-requested-with": "XMLHttpRequest" } };
		const r = res();
		for (const mw of chain.slice(0, -1)) {
			let passedOn = null;
			await mw(req, r, (arg) => { passedOn = arg === undefined ? "next" : arg; });
			if (passedOn === "route") { seen.nextRoute++; return { status: 0, body: undefined, nextRoute: true, errors: seen.errors.slice() }; }
			if (passedOn !== "next") return { status: r.statusCode, body: r.body, errors: seen.errors.slice() };
		}
		seen.handlerRuns++;
		await chain[chain.length - 1](req, r);
		return { status: r.statusCode, body: r.body, errors: seen.errors.slice() };
	};
	const chains = {
		approve: register(Lf.approve), preview: register(Lf.preview),
		getLines: register(Lf.getLines), addLine: register(Lf.addLine), voidLine: register(Lf.voidLine),
	};
	return {
		seen, db,
		approve: (loadId, body = {}) => run(chains.approve, { params: { loadId }, body }),
		dryRun: (loadId, body = {}) => run(chains.approve, { params: { loadId }, query: { dryRun: "1" }, body }),
		preview: (loadId, body = {}) => run(chains.preview, { params: { loadId }, body }),
		getLines: (loadId) => run(chains.getLines, { params: { loadId } }),
		addLine: (loadId, body) => run(chains.addLine, { params: { loadId }, body }),
		voidLine: (loadId, id, body) => run(chains.voidLine, { params: { loadId, id: String(id) }, body }),
		draft: () => db.prepare("SELECT * FROM load_invoice_drafts ORDER BY id DESC LIMIT 1").get(),
		drafts: () => db.prepare("SELECT COUNT(*) AS n FROM load_invoice_drafts").get().n,
		lines: () => db.prepare("SELECT * FROM broker_invoice_lines ORDER BY id").all(),
		// A line written straight through the module, as an earlier session's
		// add would have left it (used where the flag is off).
		plant: (loadId, values = {}) => brokerInvoice.invoiceLines.addLine(db, {
			loadId, values: { kind: "advance", label: "Fuel advance", amountCents: 65000, receivedOn: "2026-10-12", reference: "EFS-55501", note: "", ...values },
			actor: "super_admin", closedMonths: [],
		}, { audit: () => {} }).line,
	};
}
const lastHtml = (h) => h.seen.html[h.seen.html.length - 1] || "";
const withErrors = (label, r) => (r && r.errors && r.errors.length ? `${label}  [server errors: ${r.errors.join(" | ")}]` : label);

// ════════════════════════════════════════════════════════════════════════════
console.log("\n§1 flag off: everything answers as it does today");
test("the dryRun, approve and preview with a line on the load print and record exactly what they do without one", async ({ eq, ok }) => {
	const clean = harness(GMAIL);
	const planted = harness(GMAIL);
	planted.plant("41000018");
	for (const [name, call] of [["dryRun", (h) => h.dryRun("41000018")], ["approve", (h) => h.approve("41000018")], ["preview", (h) => h.preview("41000018", { total: "3000", orderNumber: "41000018", isBison: false })]]) {
		const a = await call(clean);
		const b = await call(planted);
		eq(withErrors(`${name}: the same status`, b), b.status, a.status);
		ok(`${name}: no invoiceLines key in the answer`, b.body && !Object.prototype.hasOwnProperty.call(b.body, "invoiceLines"));
		eq(`${name}: the same answer, key for key`, Object.keys(b.body || {}), Object.keys(a.body || {}));
		eq(`${name}: the same invoice HTML, byte for byte`, lastHtml(planted), lastHtml(clean));
		ok(`${name}: no line printed`, !lastHtml(planted).includes("Balance due") && !lastHtml(planted).includes("LINE HAUL"));
	}
	const row = planted.draft();
	eq("the draft row: the full total, no lines, no gross", [row.total, row.lines_json, row.gross_total], ["$3,000.00", "", ""]);
	eq("the planted line is never stamped", planted.lines()[0].invoice_id, "");
	eq("one audit row, as today", planted.seen.audits.map((a) => a.action), ["invoice_draft_created"]);
	eq("the Gmail draft is the same email", (planted.seen.drafts[0] || {}).html, (clean.seen.drafts[0] || {}).html);
});
test("a lines body is ignored with the flag off (no 400 for keys nobody reads)", async ({ eq }) => {
	const h = harness(GMAIL);
	for (const r of [await h.dryRun("41000018", { lineIds: "garbage", footnote: 7 }), await h.preview("41000018", { total: "3000", lineIds: [-1] })]) {
		eq(withErrors("200", r), r.status, 200);
	}
});
test("the n8n payload carries no lines with the flag off", async ({ ok, eq }) => {
	const h = harness(N8N);
	h.plant("41000018");
	const r = await h.approve("41000018");
	eq(withErrors("via n8n", r), (r.body || {}).via, "n8n");
	const p = (h.seen.posts[0] || {}).payload || {};
	ok("no lines, lineHaul, balanceDue or footnote", !["lines", "lineHaul", "balanceDue", "footnote"].some((k) => Object.prototype.hasOwnProperty.call(p, k)));
});
test("the three invoice-lines routes hand the request on (next(\"route\")): their handlers never run", async ({ eq }) => {
	const h = harness(GMAIL);
	for (const r of [await h.getLines("41000018"), await h.addLine("41000018", ADVANCE), await h.voidLine("41000018", 1, { reason: "x" })]) {
		eq("passed on", r.nextRoute, true);
	}
	eq("no handler ran, nothing written, nothing audited", [h.seen.handlerRuns, h.lines().length, h.seen.audits.length], [0, 0, 0]);
});

// ════════════════════════════════════════════════════════════════════════════
console.log("\n§2 adding, listing and voiding a line");
test("POST …/invoice-lines: 201 with the line, one audit row after the write", async ({ eq }) => {
	const h = harness(ON);
	const r = await h.addLine("41000018", ADVANCE);
	eq(withErrors("201", r), r.status, 201);
	eq("the line", [r.body.line.id, r.body.line.label, r.body.line.amount, r.body.line.loadId, r.body.line.createdBy], [1, "Fuel advance", "$650.00", "41000018", "super_admin"]);
	eq("audited once, on the load", h.seen.audits.map((a) => [a.action, a.entity, a.id]), [["invoice_line_added", "load", "41000018"]]);
	eq("its detail", h.seen.audits[0].detail, "#1 advance $650.00 \"Fuel advance\" received 2026-10-12 ref EFS-55501 — invoice-only, no settlement change");
});
test("the load is the sheet's: \"#41000018\" in the URL is that load; an unknown load is 404", async ({ eq }) => {
	const h = harness(ON);
	const r = await h.addLine("#41000018", ADVANCE);
	eq(withErrors("201", r), [r.status, r.body.line.loadId], [201, "41000018"]);
	const missing = await h.addLine("41000099", ADVANCE);
	eq("404", [missing.status, (missing.body || {}).code, h.lines().length, h.seen.audits.length], [404, "LOAD_NOT_FOUND", 1, 1]);
});
test("a refused body is 400 before the sheet is read; nothing written or audited", async ({ eq }) => {
	const h = harness(ON);
	for (const [body, code] of [[{ amount: "abc" }, "INVOICE_LINE_AMOUNT_INVALID"], [{ amount: "650", kind: "deduction" }, "INVOICE_LINE_KIND_INVALID"], [{ amount: "650", label: "<b>" }, "INVOICE_LINE_LABEL_INVALID"]]) {
		const r = await h.addLine("41000018", body);
		eq(`${code}`, [r.status, (r.body || {}).code], [400, code]);
	}
	eq("no sheet read, no row, no audit", [h.seen.sheetReads, h.lines().length, h.seen.audits.length], [0, 0, 0]);
});
test("a load in a closed month takes a line (invoice-only); the audit says so", async ({ eq }) => {
	const h = harness(ON, { closedMonths: ["2026-09"] });
	const r = await h.addLine("41000018", ADVANCE);
	eq(withErrors("201", r), r.status, 201);
	eq("detail", h.seen.audits[0].detail.endsWith("— load in closed month 2026-09, invoice-only, no settlement change"), true);
});
test("GET …/invoice-lines lists the load's lines; void is once, on this load, audited", async ({ eq }) => {
	const h = harness(ON);
	await h.addLine("41000018", ADVANCE);
	await h.addLine("41000017", ADVANCE);
	const list = await h.getLines("41000018");
	eq(withErrors("200, one line", list), [list.status, (list.body.lines || []).map((l) => l.id)], [200, [1]]);
	eq("no reason → 400", [(await h.voidLine("41000018", 1, {})).status, h.seen.audits.length], [400, 2]);
	eq("another load's line → 404", [(await h.voidLine("41000018", 2, { reason: "dup" })).status, h.seen.audits.length], [404, 2]);
	eq("a bad id → 404", (await h.voidLine("41000018", "abc", { reason: "dup" })).status, 404);
	const v = await h.voidLine("41000018", 1, { reason: "Entered twice" });
	eq("voided", [v.status, v.body.line.voided, h.seen.audits[2].action], [200, true, "invoice_line_voided"]);
	eq("again → 409, unaudited", [(await h.voidLine("41000018", 1, { reason: "again" })).status, h.seen.audits.length], [409, 3]);
});

// ════════════════════════════════════════════════════════════════════════════
console.log("\n§3 the dryRun");
test("no line on the load: invoiceLines says so, and the invoice is today's", async ({ eq }) => {
	const off = harness(GMAIL);
	const on = harness({ ...GMAIL, ...ON });
	await off.dryRun("41000018");
	const r = await on.dryRun("41000018");
	eq(withErrors("echo", r), (r.body || {}).invoiceLines, { enabled: true, available: [], selectedIds: [], summary: null, error: null, receiptWarnings: [] });
	eq("the same invoice HTML as with the flag off", lastHtml(on), lastHtml(off));
});
test("a line on the load: printed, the balance computed on the server, the email says it, nothing minted", async ({ eq, ok }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000018", ADVANCE);
	const r = await h.dryRun("41000018");
	const il = (r.body || {}).invoiceLines || {};
	eq(withErrors("selected by default", r), il.selectedIds, [1]);
	eq("the figures", [il.summary && il.summary.lineHaul, il.summary && il.summary.advances, il.summary && il.summary.balanceDue], ["$3,000.00", "-$650.00", "$2,350.00"]);
	eq("the footnote", [il.summary.footnote, il.summary.footnoteDefault], ["*$650 for fuel advance", "*$650 for fuel advance"]);
	ok("the PDF prints them", lastHtml(h).includes("$2,350.00") && lastHtml(h).includes("-$650.00") && lastHtml(h).includes("*$650 for fuel advance"));
	ok("the email's default message carries the balance sentence", String(r.body.emailBodyDefault).includes("Balance due $2,350.00 after the $650.00 fuel advance."));
	eq("the seed total is still the line haul", r.body.totalAmount, 3000);
	eq("nothing minted, drafted or recorded", [h.seen.minted, h.seen.drafts.length, h.drafts()], [0, 0, 0]);
});
test("a refusal is reported in the echo and the render is skipped (the editor still opens)", async ({ eq }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000018", { amount: "3000" });
	const r = await h.dryRun("41000018");
	eq(withErrors("200", r), r.status, 200);
	eq("the error", [r.body.invoiceLines.error && r.body.invoiceLines.error.code, r.body.invoiceLines.summary, r.body.invoiceLines.selectedIds], ["INVOICE_BALANCE_INVALID", null, [1]]);
	eq("no PDF", [r.body.invoicePdfBase64, h.seen.html.length], ["", 0]);
});
test("a load with no line haul (needsTotal) and a line: the conflict is named", async ({ eq }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000019", ADVANCE);
	const r = await h.dryRun("41000019");
	eq(withErrors("needsTotal + conflict", r), [r.body.needsTotal, r.body.invoiceLines.error && r.body.invoiceLines.error.code], [true, "INVOICE_LINE_HAUL_CONFLICT"]);
});
test("a same-amount receipt on the load is named in the echo", async ({ eq }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000018", ADVANCE);
	h.db.prepare("INSERT INTO expenses (timestamp, driver, load_id, type, amount, date, status) VALUES ('t', 'Test Driver B', '41000018', 'Other', 650, '2026-10-12', 'Approved')").run();
	const r = await h.dryRun("41000018");
	eq(withErrors("warning", r), r.body.invoiceLines.receiptWarnings, [{ lineId: 1, expenseId: 1, type: "Other", amount: "$650.00", status: "Approved" }]);
});

// ════════════════════════════════════════════════════════════════════════════
console.log("\n§4 the approve");
test("bills the balance due, keeps the line haul, records and stamps the lines, audits the rule", async ({ eq, ok }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000018", ADVANCE);
	const r = await h.approve("41000018", { lineIds: [1], total: "3000.00" });
	eq(withErrors("200 via imap", r), [r.status, (r.body || {}).via], [200, "imap"]);
	const row = h.draft();
	eq("total is the balance due; gross_total the line haul; sheet_total untouched", [row.total, row.gross_total, row.sheet_total], ["$2,350.00", "$3,000.00", "$3,000.00"]);
	eq("lines_json", JSON.parse(row.lines_json || "{}").lines, [{ id: 1, kind: "advance", label: "Fuel advance", amountCents: 65000, receivedOn: "2026-10-12", reference: "EFS-55501" }]);
	ok("edited_fields names the lines", String(row.edited_fields).split(",").includes("lines"));
	eq("the line carries this invoice #", h.lines()[0].invoice_id, MINTED);
	const edit = h.seen.audits.find((a) => a.action === "invoice_draft_edited") || {};
	ok("the edit audit names the rule", String(edit.detail).includes("lines: line haul $3,000.00, less advances $650.00 (#1 Fuel advance $650.00) → balance due $2,350.00 (INVOICE ONLY — Job Tracking Payment unchanged)"));
	eq("invoice_draft_created is unchanged", (h.seen.audits.find((a) => a.action === "invoice_draft_created") || {}).detail, `${MINTED} → ${DEFAULT_TO} (imap)`);
	ok("the Gmail draft's message carries the balance", String((h.seen.drafts[0] || {}).html).includes("Balance due $2,350.00 after the $650.00 fuel advance."));
	ok("the PDF prints the balance", lastHtml(h).includes('<span class="lbl">Balance due*</span><span class="amt">$2,350.00</span>'));
	eq("one invoice number, one sheet read (the lookup)", [h.seen.minted, h.seen.sheetReads], [1, 1]);
});
test("a typed net total with a line → 422 INVOICE_LINE_HAUL_CONFLICT, before any number is minted", async ({ eq }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000018", ADVANCE);
	const r = await h.approve("41000018", { lineIds: [1], total: "2350" });
	eq(withErrors("422", r), [r.status, (r.body || {}).code], [422, "INVOICE_LINE_HAUL_CONFLICT"]);
	eq("nothing minted, drafted or recorded", [h.seen.minted, h.seen.drafts.length, h.drafts()], [0, 0, 0]);
	const noBase = harness({ ...GMAIL, ...ON });
	await noBase.addLine("41000019", ADVANCE);
	const nb = await noBase.approve("41000019", { total: "2000" });
	eq("no line haul on the load and a typed total → the same refusal", [nb.status, (nb.body || {}).code, noBase.seen.minted], [422, "INVOICE_LINE_HAUL_CONFLICT", 0]);
});
test("the balance must stay above $0.00; a voided or another load's line is refused; none of it mints", async ({ eq }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000018", { amount: "3000" });
	const bal = await h.approve("41000018");
	eq(withErrors("422 balance", bal), [bal.status, (bal.body || {}).code], [422, "INVOICE_BALANCE_INVALID"]);
	await h.voidLine("41000018", 1, { reason: "too big" });
	await h.addLine("41000017", ADVANCE);
	for (const id of [1, 2, 99]) {
		const r = await h.approve("41000018", { lineIds: [id] });
		eq(`line ${id} → 422 INVOICE_LINE_INVALID`, [r.status, (r.body || {}).code, (r.body || {}).lineId], [422, "INVOICE_LINE_INVALID", id]);
	}
	eq("nothing minted", [h.seen.minted, h.drafts()], [0, 0]);
});
test("amounts are never taken from the client: a body with figures prints the stored line", async ({ eq, ok }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000018", ADVANCE);
	const r = await h.approve("41000018", { lineIds: [1], lines: [{ id: 1, amountCents: 1 }], balanceDue: "$2,999.99" });
	eq(withErrors("200", r), r.status, 200);
	eq("the stored amount billed", h.draft().total, "$2,350.00");
	ok("…and printed", lastHtml(h).includes("-$650.00") && !lastHtml(h).includes("$2,999.99"));
});
test("a Bison load with a line still needs its Order # and PO #; with them the balance is billed", async ({ eq }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000017", ADVANCE);
	const refused = await h.approve("41000017", { lineIds: [1] });
	eq(withErrors("422 refs", refused), [refused.status, (refused.body || {}).code, h.seen.minted], [422, "INVOICE_REFS_REQUIRED", 0]);
	const r = await h.approve("41000017", { ...BISON_REFS, lineIds: [1] });
	eq(withErrors("200", r), [r.status, h.draft().total, h.draft().gross_total, h.draft().order_number], [200, "$1,750.00", "$2,400.00", "7000002"]);
	eq("to the Bison AP inbox", (h.seen.drafts[0] || {}).to, BISON_TO);
});
test("an invoice # override: the printed number goes on the line, the minted one is kept on the row", async ({ eq }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000018", ADVANCE);
	const r = await h.approve("41000018", { lineIds: [1], invoiceId: "10152026-3" });
	eq(withErrors("200", r), r.status, 200);
	eq("row", [h.draft().invoice_id, h.draft().invoice_id_minted], ["10152026-3", MINTED]);
	eq("line", h.lines()[0].invoice_id, "10152026-3");
});
test("an edited footnote prints, is stored and is audited; a cleared one prints none", async ({ eq, ok }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000018", ADVANCE);
	await h.approve("41000018", { lineIds: [1], footnote: "*Advance paid by EFS check" });
	ok("printed", lastHtml(h).includes('<div class="footnote">*Advance paid by EFS check</div>'));
	eq("stored", JSON.parse(h.draft().lines_json).footnote, "*Advance paid by EFS check");
	ok("audited", String((h.seen.audits.find((a) => a.action === "invoice_draft_edited") || {}).detail).includes('footnote: "*Advance paid by EFS check"'));
	const c = harness({ ...GMAIL, ...ON });
	await c.addLine("41000018", ADVANCE);
	await c.approve("41000018", { lineIds: [1], footnote: "" });
	ok("cleared", !lastHtml(c).includes('<div class="footnote">'));
});
test("lineIds [] prints no line: today's invoice and draft row", async ({ eq }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000018", ADVANCE);
	await h.approve("41000018", { lineIds: [] });
	eq("row", [h.draft().total, h.draft().lines_json, h.draft().gross_total], ["$3,000.00", "", ""]);
	eq("the line is not stamped", h.lines()[0].invoice_id, "");
});
test("a bad selection is 400 before anything is read", async ({ eq }) => {
	const h = harness({ ...GMAIL, ...ON });
	const r = await h.approve("41000018", { lineIds: ["1"] });
	eq("400", [r.status, (r.body || {}).code, h.seen.sheetReads], [400, "INVOICE_LINE_IDS_INVALID", 0]);
});
test("the n8n fallback is sent the reviewed lines and the balance", async ({ eq }) => {
	const h = harness({ ...N8N, ...ON });
	await h.addLine("41000018", ADVANCE);
	const r = await h.approve("41000018", { lineIds: [1] });
	eq(withErrors("via n8n", r), (r.body || {}).via, "n8n");
	const p = (h.seen.posts[0] || {}).payload || {};
	eq("lines, line haul, balance, footnote", [p.lines, p.lineHaul, p.balanceDue, p.footnote],
		[[{ label: "Fuel advance", amount: "-$650.00", receivedOn: "2026-10-12", reference: "EFS-55501" }], "$3,000.00", "$2,350.00", "*$650 for fuel advance"]);
	eq("the row", [h.draft().via, h.draft().total], ["n8n", "$2,350.00"]);
});

// ════════════════════════════════════════════════════════════════════════════
console.log("\n§5 the preview");
test("the same figures and the same invoice as the approve; nothing written", async ({ eq, ok }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000018", ADVANCE);
	const p = await h.preview("41000018", { total: "3000.00", orderNumber: "41000018", isBison: false, lineIds: [1], invoiceId: MINTED, invoiceDate: "2026-10-16", deliveryDate: "2026-10-14", recipientEmail: DEFAULT_TO, billToName: "Acme Freight", brokerName: "Acme Freight", notes: "" });
	eq(withErrors("200", p), p.status, 200);
	eq("figures", [p.body.invoiceLines.summary.balanceDue, p.body.invoiceLines.summary.lineHaul], ["$2,350.00", "$3,000.00"]);
	ok("the email default carries the balance", String(p.body.emailBodyDefault).includes("Balance due $2,350.00 after the $650.00 fuel advance."));
	const previewHtml = lastHtml(h);
	eq("nothing written", [h.drafts(), h.lines()[0].invoice_id, h.seen.minted], [0, "", 0]);
	await h.approve("41000018", { lineIds: [1], total: "3000.00", invoiceDate: "2026-10-16", deliveryDate: "2026-10-14", recipientEmail: DEFAULT_TO, billToName: "Acme Freight", brokerName: "Acme Freight", notes: "" });
	eq("the approve prints the invoice the preview showed", lastHtml(h), previewHtml);
});
test("refusals: a bad selection 400, a voided line 422, a balance at zero 422", async ({ eq }) => {
	const h = harness({ ...GMAIL, ...ON });
	await h.addLine("41000018", ADVANCE);
	eq("400", (await h.preview("41000018", { total: "3000", lineIds: "1" })).body.code, "INVOICE_LINE_IDS_INVALID");
	eq("balance", (await h.preview("41000018", { total: "650", lineIds: [1] })).body.code, "INVOICE_BALANCE_INVALID");
	await h.voidLine("41000018", 1, { reason: "dup" });
	eq("voided", (await h.preview("41000018", { total: "3000", lineIds: [1] })).body.code, "INVOICE_LINE_INVALID");
});

// ════════════════════════════════════════════════════════════════════════════
console.log("\n§6 wiring");
test("the approve resolves the lines after the refs guard and before an invoice number is minted", async ({ ok }) => {
	const route = lifted().approve;
	const at = (s) => route.indexOf(s);
	ok("resolveInvoiceLines( is called once", countOf(route, "invoiceLines.resolveInvoiceLines(") === 1);
	ok("after INVOICE_REFS_REQUIRED", at("invoiceLines.resolveInvoiceLines(") > at('code: "INVOICE_REFS_REQUIRED"'));
	ok("before nextInvoiceNumber(", at("invoiceLines.resolveInvoiceLines(") < at("nextInvoiceNumber(today)"));
	ok("the selection is parsed right after the overrides, before the sheet read", at("invoiceLines.parseLineSelection(req.body)") > at("parseInvoiceOverrides(req.body)") && at("invoiceLines.parseLineSelection(req.body)") < at("getSheets()"));
});
test("every flag read is linesEnabled(process.env), and the module comes through brokerInvoice", async ({ ok, eq }) => {
	const L = lifted();
	for (const [name, text] of [["approve", L.approve], ["preview", L.preview], ["gate", L.gate]]) {
		ok(`${name} reads linesEnabled(process.env)`, text.includes("linesEnabled(process.env)"));
	}
	eq("server.js names the flag only in comments (the module is its one reader)",
		SRC.split("\n").filter((l) => l.includes("BROKER_INVOICE_LINES_ENABLED") && !/^\s*\/\//.test(l)), []);
	ok("the routes reach the module as brokerInvoice.invoiceLines", /const invoiceLines = brokerInvoice\.invoiceLines;/.test(L.approve) && /const invoiceLines = brokerInvoice\.invoiceLines;/.test(L.preview));
	ok("the boot builds the schema only with the flag on", /\nif \(brokerInvoice\.invoiceLines\.linesEnabled\(process\.env\)\) brokerInvoice\.invoiceLines\.ensureSchema\(db\);\n/.test(SRC));
});
test("the gate is the second middleware of each new route, after requireRole(\"Super Admin\")", async ({ ok }) => {
	const L = lifted();
	for (const [name, text] of [["GET", L.getLines], ["POST add", L.addLine], ["POST void", L.voidLine]]) {
		ok(`${name}`, /^app\.(get|post)\("[^"]+", requireRole\("Super Admin"\), brokerInvoiceLinesGate, /.test(text));
	}
});

runAll();
