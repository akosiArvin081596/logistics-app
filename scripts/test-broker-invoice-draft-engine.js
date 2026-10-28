#!/usr/bin/env node
/**
 * Tests for lib/broker-invoice-draft.js, the engine behind
 * POST /api/loads/:loadId/draft-invoice (prepare / render / record).
 *
 *   §1 mode "auto": every refusal the automatic drafts add, each on a load that
 *      has only that problem: POD_PAGE_UNREADABLE, RATECON_MISSING (none, a BOL
 *      only), RATECON_BY_CONTENT, RECIPIENT_UNCONFIGURED, NO_BILLING_EMAIL,
 *      RECIPIENT_DOMAIN_MISMATCH (another domain, a subdomain, a sheet Email
 *      with no domain), TOTAL_MISMATCH, ADVANCE_LINES (lines flag on and off),
 *      NO_DELIVERY_DATE; and a clean load, Bison and not, prepared.
 *   §2 mode "auto" limits: no request body, no load facts (no by-content
 *      scan), persist:false, overrides ignored, alternate rate cons read with
 *      the free scan only, geminiUnavailable reported, the POD found under
 *      either spelling of the load ID.
 *   §3 mode "manual" is the button: on every load above it refuses nothing new,
 *      hands getRateConBytes() the body, the load facts and persist:!dryRun,
 *      reads alternates with Gemini, matches the POD's load ID exactly, and a
 *      busy renderer keeps its PDF_RENDERER_BUSY code.
 *   §4 render() and record() for an automatic draft: the Gmail draft's fields,
 *      RENDERER_BUSY, and the row and audit line written as auto-imap by the
 *      system actor.
 *   §5 autoRecipientRefusal(), the recipient rule on its own.
 *
 * server.js helpers (sheet parsing, the override validator, latestDraftNotes,
 * logAudit, …) are lifted from its text with scripts/lib/server-lift.js;
 * Sheets, Drive, Gemini and Chromium are stubs. In-memory SQLite, made-up
 * loads only. Fails on a tree without the engine (the module is missing).
 *
 * Run: node scripts/test-broker-invoice-draft-engine.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const ENGINE = path.join(ROOT, "lib", "broker-invoice-draft.js");
if (!fs.existsSync(ENGINE)) {
	console.log("FAIL  lib/broker-invoice-draft.js does not exist");
	process.exit(1);
}
const BISON_TO = "bison-ap@example.test";
const DEFAULT_TO = "ap@example.test";
process.env.BISON_INVOICE_EMAIL = BISON_TO;
process.env.DEFAULT_INVOICE_EMAIL = DEFAULT_TO;
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
const engineModule = require(ENGINE);
const { closure } = require(path.join(__dirname, "lib", "server-lift.js"));
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log(`\n${t}`); }

// ── made-up fixtures ─────────────────────────────────────────────────────────
function pdfWith(contentStream) {
	const z = zlib.deflateSync(Buffer.from(contentStream, "latin1"));
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n1 0 obj<</Length ${z.length}/Filter/FlateDecode>>stream\n`, "latin1"),
		z,
		Buffer.from("\nendstream endobj\n%%EOF", "latin1"),
	]);
}
// The free scan reads the block only with a numeric Order # (its anchor).
const rateCon = ({ order = "1001001", total = "$1,500.00", docs = "" } = {}) => pdfWith(
	`BT (Billing Information: Order #: ${order} PO #: PO-77 Move #: 5501) Tj (Total Rate: ${total}) Tj ` +
	(docs ? `(Email the signed POD and all billing documents to ${docs}) Tj ` : "") + "ET",
);
// No "Order #" anchor: the free scan reads only the documents email, so the
// extractor asks Gemini for the rest.
const plainRateCon = (docs) => pdfWith(`BT (Load confirmation for a made-up shipment) Tj ${docs ? `(Send billing documents to ${docs}) Tj ` : ""}ET`);
const BOL = pdfWith("BT (BILL OF LADING BOL #: 88812345) Tj ET");

const HEADERS = ["Load ID", "Job Status", "Email", "Broker Contact Name", "Driver", "Trailer Number", "Completion Date", "  Payment  "];
const BROKER = "ops@example-broker.test";
const BILLING = "billing@example-broker.test";
const load = (id, extra = {}) => ({ id, status: "Delivered", email: BROKER, contact: "QA Desk", trailer: "", done: "10/14/2026", pay: "1500", ...extra });
const LOADS = [
	load("LD-TEST-0001"),
	load("LD-TEST-0002", { email: "qa-desk@bisontransport.com", pay: "2400" }),
	load("LD-TEST-0003"),
	load("LD-TEST-0004"),
	load("LD-TEST-0005"),
	load("LD-TEST-0006", { email: "QA Desk" }),
	load("LD-TEST-0007"),
	load("LD-TEST-0008"),
	load("LD-TEST-0009"),
	load("LD-TEST-0010"),
	load("LD-TEST-0011"),
	load("LD-TEST-0012"),
	load("LD-TEST-0013", { done: "" }),
	load("LD-TEST-0014"),
	load("LD-TEST-0015"),
	load("LD-TEST-0016"),
];
const SHEET = [HEADERS, ...LOADS.map((l) => [l.id, l.status, l.email, l.contact, "QA Driver", l.trailer, l.done, l.pay])];
const cand = (buffer, source) => ({ buffer, source, label: source, fileName: "rc.pdf" });
const RATECONS = {
	"LD-TEST-0001": [cand(rateCon({ docs: BILLING }), "documents")],
	"LD-TEST-0002": [cand(rateCon({ order: "7101852", total: "$2,400.00" }), "drive")],
	"LD-TEST-0003": [cand(rateCon(), "documents")],
	"LD-TEST-0004": [cand(rateCon({ docs: "billing@example-factor.test" }), "documents")],
	"LD-TEST-0005": [cand(rateCon({ docs: "billing@ap.example-broker.test" }), "documents")],
	"LD-TEST-0006": [cand(rateCon({ docs: BILLING }), "documents")],
	"LD-TEST-0008": [cand(BOL, "documents-bol")],
	"LD-TEST-0009": [cand(rateCon({ docs: BILLING }), "drive-content")],
	"LD-TEST-0010": [cand(rateCon({ docs: BILLING, total: "$1,600.00" }), "documents")],
	"LD-TEST-0011": [cand(rateCon({ docs: BILLING }), "documents")],
	"LD-TEST-0012": [cand(rateCon({ docs: BILLING }), "documents")],
	"LD-TEST-0013": [cand(rateCon({ docs: BILLING }), "documents")],
	"LD-TEST-0014": [cand(rateCon({ docs: BILLING }), "documents")],
	"LD-TEST-0015": [cand(rateCon(), "documents"), cand(plainRateCon(BILLING), "drive")],
	"LD-TEST-0016": [cand(plainRateCon(""), "documents")],
};
// POD rows: [load_id as stored, file name]; the 0011 page and 0014's spelling are the cases.
const PODS = [
	...LOADS.filter((l) => !["LD-TEST-0014"].includes(l.id)).map((l) => [l.id, `${l.id}_POD.pdf`]),
	["LD-TEST-0011", "LD-TEST-0011_POD_2.pdf"],
	["#ld-test-0014", "LD-TEST-0014_POD.pdf"],
];
const UNREADABLE = new Set(["LD-TEST-0011_POD_2.pdf"]);

// ── the server.js pieces the engine is given ─────────────────────────────────
const lifted = closure(SRC, {
	roots: ["parseSheet", "deduplicateLoads", "findCol", "parseInvoiceOverrides", "latestDraftNotes", "safeAttachmentName", "sanitizeEvidenceText", "logAudit"],
	provided: ["db", "brokerInvoice", "console"],
	denied: ["app", "server", "io", "getSheets", "getDrive"],
});
const createAt = SRC.indexOf("CREATE TABLE IF NOT EXISTS load_invoice_drafts (");
const DRAFTS_SQL = SRC.slice(createAt, SRC.indexOf("`", createAt));
const DRAFTS_ALTERS = [...SRC.matchAll(/db\.exec\("(ALTER TABLE load_invoice_drafts ADD COLUMN [^"]+)"\)/g)].map((m) => m[1]);
const auditAt = SRC.indexOf("CREATE TABLE IF NOT EXISTS audit_trail (");
const AUDIT_SQL = SRC.slice(auditAt, SRC.indexOf("`", auditAt));
const QUIET = { log() {}, warn() {}, error() {} };

const AUTO_ACTOR = { session: { user: { id: 0, username: "auto-invoice", role: "system" } } };
const ADMIN = { session: { user: { id: 1, username: "super_admin", role: "Super Admin" } } };

function world({ env = {}, gemini = null, rendererBusy = false, linesTable = false } = {}) {
	const db = new Database(":memory:");
	db.exec(DRAFTS_SQL);
	for (const a of DRAFTS_ALTERS) db.exec(a);
	db.exec(AUDIT_SQL);
	db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT, type TEXT, file_name TEXT, uploaded_at TEXT, deleted_at TEXT)");
	const addPod = db.prepare("INSERT INTO documents (load_id, type, file_name, uploaded_at) VALUES (?, 'POD', ?, '2026-10-14T15:00:00Z')");
	for (const [id, file] of PODS) addPod.run(id, file);
	if (linesTable || env.BROKER_INVOICE_LINES_ENABLED) brokerInvoice.invoiceLines.ensureSchema(db);
	const helpers = new Function("db", "brokerInvoice", "console", `${lifted.text}\nreturn { ${lifted.names.join(", ")} };`)(db, brokerInvoice, QUIET);
	const seen = { rateconCalls: [], gemini: 0, renders: 0 };
	const engine = engineModule.create({
		...helpers,
		db,
		brokerInvoice,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: SHEET } }) } } }),
		SPREADSHEET_ID: "made-up-sheet",
		fetchDocumentBytes: async (d) => (UNREADABLE.has(d.file_name) ? null : Buffer.from(`%PDF-1.4 ${d.file_name}`)),
		buildRateConLoadCtx: (row, headers, loadId) => ({ loadId, facts: "made-up" }),
		getRateConBytes: async (loadId, body, loadCtx, opts) => {
			seen.rateconCalls.push({ loadId, body, loadCtx, opts: { ...opts, req: opts && opts.req ? "req" : undefined } });
			const candidates = RATECONS[String(loadId).replace(/^#/, "").toUpperCase()] || [];
			return { buffer: candidates[0] ? candidates[0].buffer : null, candidates };
		},
		GEMINI_API_KEY: "made-up-key",
		runRateConGemini: async () => {
			seen.gemini++;
			if (gemini === "down") throw Object.assign(new Error("made-up outage"), { kind: "unavailable", status: 503 });
			return null;
		},
		renderHtmlToPdf: async () => {
			seen.renders++;
			if (rendererBusy) throw Object.assign(new Error("busy"), { code: "PDF_RENDERER_BUSY" });
			return Buffer.from("%PDF-1.4 invoice");
		},
		env,
		console: QUIET,
	});
	const ov = (body = {}) => helpers.parseInvoiceOverrides(body);
	const auto = (loadId, extra = {}) => engine.prepare({ loadId, mode: "auto", ...extra });
	const manual = (loadId, body = {}, dryRun = false) => engine.prepare({ loadId, body, dryRun, mode: "manual", ov: ov(body), lineSel: null, req: ADMIN });
	return { db, engine, seen, auto, manual, ov };
}
const code = (r) => (r.ok ? "ok" : r.code || `${r.http}`);

(async () => {
	// ===================================================================== §1
	section("1. mode \"auto\" — each refusal on a load with only that problem");
	{
		const w = world();
		const clean = await w.auto("LD-TEST-0001");
		eq([code(clean), clean.ok && clean.ctx.invoiceTo.email, clean.ok && clean.ctx.recipientSource, clean.ok && clean.ctx.mode],
			["ok", BILLING, "ratecon", "auto"], "§1 a clean non-Bison load prepares, to its rate con's documents email on the broker's domain");
		const bison = await w.auto("LD-TEST-0002");
		eq([code(bison), bison.ok && bison.ctx.invoiceTo.email, bison.ok && bison.ctx.orderNumber], ["ok", BISON_TO, "7101852"],
			"§1 a clean Bison load prepares, to the configured Bison inbox, with its rate con's Order #");
		const CASES = [
			["LD-TEST-0011", "POD_PAGE_UNREADABLE", "a POD page that cannot be read"],
			["LD-TEST-0007", "RATECON_MISSING", "no rate con at all"],
			["LD-TEST-0008", "RATECON_MISSING", "only a BOL on file"],
			["LD-TEST-0009", "RATECON_BY_CONTENT", "a rate con found only by reading Drive files"],
			["LD-TEST-0003", "NO_BILLING_EMAIL", "a rate con with no documents email (the default inbox)"],
			["LD-TEST-0004", "RECIPIENT_DOMAIN_MISMATCH", "a documents email on another domain"],
			["LD-TEST-0005", "RECIPIENT_DOMAIN_MISMATCH", "a documents email on a subdomain of the broker's"],
			["LD-TEST-0006", "RECIPIENT_DOMAIN_MISMATCH", "a sheet Email with no domain"],
			["LD-TEST-0010", "TOTAL_MISMATCH", "a rate con total that is not Job Tracking's Payment"],
			["LD-TEST-0013", "NO_DELIVERY_DATE", "no delivery date in Job Tracking"],
		];
		for (const [id, want, what] of CASES) {
			const r = await world().auto(id);
			eq([code(r), r.http, typeof (r.json && r.json.error)], [want, 422, "string"], `§1 ${what} → ${want}`);
		}
		const misMsg = await world().auto("LD-TEST-0004");
		ok(!/@/.test(JSON.stringify(misMsg.json)), "§1 a recipient refusal names no email address");

		const saved = process.env.BISON_INVOICE_EMAIL;
		delete process.env.BISON_INVOICE_EMAIL;
		try {
			eq(code(await world().auto("LD-TEST-0002")), "RECIPIENT_UNCONFIGURED", "§1 Bison with no BISON_INVOICE_EMAIL → RECIPIENT_UNCONFIGURED");
		} finally { process.env.BISON_INVOICE_EMAIL = saved; }

		for (const [label, env] of [["off", {}], ["on", { BROKER_INVOICE_LINES_ENABLED: "true" }]]) {
			const lw = world({ env, linesTable: true });
			brokerInvoice.invoiceLines.addLine(lw.db, {
				loadId: "LD-TEST-0012",
				values: { kind: "advance", label: "Fuel advance", amountCents: 65000, receivedOn: "2026-10-12", reference: "EFS-1", note: "" },
				actor: "super_admin", closedMonths: [],
			}, { audit: () => {} });
			eq(code(await lw.auto("LD-TEST-0012")), "ADVANCE_LINES", `§1 an active advance line, lines flag ${label} → ADVANCE_LINES`);
			lw.db.prepare("UPDATE broker_invoice_lines SET voided_at = '2026-10-15T00:00:00Z', voided_by = 'qa', void_reason = 'test'").run();
			eq(code(await lw.auto("LD-TEST-0012")), "ok", `§1 …and once the line is voided, the load prepares (flag ${label})`);
		}
		eq(code(await world().auto("LD-TEST-0012")), "ok", "§1 no lines table at all (the flag never on) → no ADVANCE_LINES");
		eq([...engineModule.AUTO_REFUSAL_CODES].sort(), [...new Set(CASES.map((c) => c[1]).concat("RECIPIENT_UNCONFIGURED", "ADVANCE_LINES"))].sort(),
			"§1 AUTO_REFUSAL_CODES lists exactly the codes exercised here");
	}

	// ===================================================================== §2
	section("2. mode \"auto\" — what it never does");
	{
		const w = world();
		const r = await w.auto("LD-TEST-0001", {
			body: { rateconPdfBase64: rateCon({ docs: "x@elsewhere.example.test" }).toString("base64") },
			ov: w.ov({ recipientEmail: "someone@example-factor.test", total: "9999", notes: "typed" }),
			lineSel: { ok: true },
			dryRun: false,
			req: ADMIN,
		});
		eq(w.seen.rateconCalls, [{ loadId: "LD-TEST-0001", body: null, loadCtx: null, opts: { persist: false } }],
			"§2 getRateConBytes(): no request body, no load facts (so no by-content scan), persist:false, no request");
		eq([r.ctx.invoiceTo.email, r.ctx.totalAmount, r.ctx.notes, r.ctx.recipientSource], [BILLING, 1500, "", "ratecon"],
			"§2 overrides passed in are ignored: the recipient, total and notes are the load's own");

		const alt = world();
		const ar = await alt.auto("LD-TEST-0015");
		eq([code(ar), ar.ok && ar.ctx.invoiceTo.email, alt.seen.gemini], ["ok", BILLING, 0],
			"§2 an alternate rate con is read with the free scan only (the documents email found, Gemini never asked)");

		const down = world({ gemini: "down" });
		const dr = await down.auto("LD-TEST-0016");
		eq([code(dr), dr.geminiUnavailable, down.seen.gemini], ["NO_BILLING_EMAIL", true, 1],
			"§2 a refusal reached while Gemini was down says so (geminiUnavailable: true)");
		eq((await world().auto("LD-TEST-0016")).geminiUnavailable, false, "§2 …and false when it was up");
		const up = await world({ gemini: "down" }).manual("LD-TEST-0016", {}, true);
		eq([code(up), up.ctx.geminiUnavailable], ["ok", true], "§2 a prepared draft reports geminiUnavailable too");

		const spell = await world().auto("LD-TEST-0014");
		eq([code(spell), spell.ok && spell.ctx.podAttachments.map((a) => a.filename)], ["ok", ["LD-TEST-0014_POD.pdf"]],
			"§2 the POD stored as \"#ld-test-0014\" is found for load LD-TEST-0014 (either spelling, any case)");

		let threw = "";
		try { await world().engine.prepare({ loadId: "LD-TEST-0001", mode: "shadow" }); } catch (e) { threw = e.message; }
		ok(/unknown mode/.test(threw), "§2 an unknown mode throws");
	}

	// ===================================================================== §3
	section("3. mode \"manual\" — the button, unchanged");
	{
		for (const id of ["LD-TEST-0003", "LD-TEST-0004", "LD-TEST-0005", "LD-TEST-0006", "LD-TEST-0007", "LD-TEST-0008", "LD-TEST-0009", "LD-TEST-0010", "LD-TEST-0011", "LD-TEST-0013"]) {
			eq(code(await world().manual(id)), "ok", `§3 ${id}: the approve prepares (no automatic refusal)`);
		}
		const lw = world({ linesTable: true });
		brokerInvoice.invoiceLines.addLine(lw.db, {
			loadId: "LD-TEST-0012",
			values: { kind: "advance", label: "Fuel advance", amountCents: 65000, receivedOn: "2026-10-12", reference: "EFS-1", note: "" },
			actor: "super_admin", closedMonths: [],
		}, { audit: () => {} });
		eq(code(await lw.manual("LD-TEST-0012")), "ok", "§3 an advance line with the lines flag off: the button bills as before");

		const w = world();
		const r = await w.manual("LD-TEST-0010", { notes: "typed" }, true);
		eq(w.seen.rateconCalls, [{ loadId: "LD-TEST-0010", body: { notes: "typed" }, loadCtx: { loadId: "LD-TEST-0010", facts: "made-up" }, opts: { persist: false, req: "req" } }],
			"§3 dryRun: getRateConBytes() gets the body, the load facts, persist:false and the request");
		eq([r.ctx.totalAmount, r.ctx.totalSource, r.ctx.notes, r.ctx.invoiceTo.email], [1600, "ratecon", "typed", BILLING],
			"§3 the rate con's total wins, the typed note prints");
		const w2 = world();
		await w2.manual("LD-TEST-0001");
		eq(w2.seen.rateconCalls[0].opts, { persist: true, req: "req" }, "§3 an approve: persist:true");
		const pod = await world().manual("LD-TEST-0011");
		eq(pod.ctx.podMissing, ["LD-TEST-0011_POD_2.pdf"], "§3 an unreadable POD page is reported, not refused");
		eq([code(await world().manual("LD-TEST-0003")), (await world().manual("LD-TEST-0003")).ctx.invoiceTo.email], ["ok", DEFAULT_TO],
			"§3 no documents email: the default inbox, as today");

		const alt = world();
		await alt.manual("LD-TEST-0015");
		eq(alt.seen.gemini, 1, "§3 an alternate rate con is still read with Gemini on the button");
		eq([code(await world().manual("LD-TEST-0014")), (await world().manual("LD-TEST-0014")).json],
			["400", { error: "POD not found for this load" }], "§3 the POD's load ID still matches exactly on the button");
		eq(code(await world().engine.prepare({ loadId: "LD-TEST-0001", ov: world().ov({}) })), "ok", "§3 mode defaults to manual");
		let threw = "";
		try { await world().engine.prepare({ loadId: "LD-TEST-0001", mode: "manual" }); } catch (e) { threw = e.message; }
		ok(/validates the overrides/.test(threw), "§3 manual without the route's parsed overrides throws");

		const busy = world({ rendererBusy: true });
		const ctx = (await busy.manual("LD-TEST-0001")).ctx;
		let err = null;
		try { await busy.engine.render(ctx, { invoiceId: "10282026-1", invoiceDate: "10/28/2026" }); } catch (e) { err = e; }
		eq(err && err.code, "PDF_RENDERER_BUSY", "§3 a busy renderer keeps PDF_RENDERER_BUSY on the button (the route's 503)");
	}

	// ===================================================================== §4
	section("4. render() and record() for an automatic draft");
	{
		const w = world();
		const { ctx } = await w.auto("LD-TEST-0001");
		const rendered = await w.engine.render(ctx, { invoiceId: "10282026-7", invoiceDate: "10/28/2026" });
		eq([rendered.to, rendered.subject, rendered.attachments.map((a) => a.filename)],
			[BILLING, "Example Broker Order #LD-TEST-0001", ["Example Broker Invoice Order #LD-TEST-0001.pdf", "LD-TEST-0001_POD.pdf", "LD-TEST-0001.pdf"]],
			"§4 the Gmail draft's to, subject and attachments (invoice, POD, rate con)");
		eq(rendered.html, brokerInvoice.buildInvoiceEmailHtml({ brokerName: "Example Broker", isBison: false, loadNumber: "LD-TEST-0001", orderNumber: "LD-TEST-0001", moveNumber: "5501", poNumber: "PO-77" }),
			"§4 …and the generated email, unedited");
		eq(rendered.html, rendered.draftHtml, "§4 html is the route's draftHtml");

		w.engine.record(ctx, rendered, { via: "auto-imap", actor: AUTO_ACTOR, invoiceId: "10282026-7", mintedInvoiceId: "10282026-7", editDiffs: [] });
		const row = w.db.prepare("SELECT load_id, invoice_id, recipient, recipient_source, total, via, created_by, edited, invoice_id_minted FROM load_invoice_drafts").all();
		eq(row, [{ load_id: "LD-TEST-0001", invoice_id: "10282026-7", recipient: BILLING, recipient_source: "ratecon", total: "$1,500.00", via: "auto-imap", created_by: "auto-invoice", edited: 0, invoice_id_minted: "" }],
			"§4 one draft row: auto-imap, the invoice #, created by auto-invoice, unedited");
		const audit = w.db.prepare("SELECT user_id, username, role, action, entity, entity_id, details FROM audit_trail").all();
		eq(audit, [{ user_id: 0, username: "auto-invoice", role: "system", action: "invoice_draft_created", entity: "load", entity_id: "LD-TEST-0001", details: `10282026-7 → ${BILLING} (auto-imap)` }],
			"§4 one audit row, the system actor, in today's invoice_draft_created shape");

		const busy = world({ rendererBusy: true });
		const bctx = (await busy.auto("LD-TEST-0001")).ctx;
		let err = null;
		try { await busy.engine.render(bctx, { invoiceId: "10282026-8", invoiceDate: "10/28/2026" }); } catch (e) { err = e; }
		eq(err && err.code, "RENDERER_BUSY", "§4 a busy renderer is RENDERER_BUSY for an automatic draft");
	}

	// ===================================================================== §5
	section("5. autoRecipientRefusal() — the recipient rule");
	{
		const rule = (args) => (engineModule.autoRecipientRefusal(args, brokerInvoice.normalizeEmail) || { code: null }).code;
		eq(rule({ isBison: true, recipientEmail: BISON_TO, documentsEmail: "x@elsewhere.example.test", brokerEmail: "a@bisontransport.com" }), null,
			"§5 Bison: the configured inbox, whatever the rate con says");
		eq(rule({ isBison: true, recipientEmail: "", documentsEmail: "", brokerEmail: "a@bisontransport.com" }), "RECIPIENT_UNCONFIGURED", "§5 Bison, nothing configured");
		eq(rule({ isBison: false, recipientEmail: DEFAULT_TO, documentsEmail: "", brokerEmail: BROKER }), "NO_BILLING_EMAIL", "§5 no documents email");
		eq(rule({ isBison: false, recipientEmail: DEFAULT_TO, documentsEmail: "not-an-address", brokerEmail: BROKER }), "NO_BILLING_EMAIL", "§5 a documents email that is not an address");
		eq(rule({ isBison: false, recipientEmail: "Billing@Example-Broker.TEST", documentsEmail: "Billing@Example-Broker.TEST", brokerEmail: "OPS@example-broker.test" }), null,
			"§5 the same domain, any case");
		eq(rule({ isBison: false, recipientEmail: "billing@sub.example-broker.test", documentsEmail: "billing@sub.example-broker.test", brokerEmail: BROKER }), "RECIPIENT_DOMAIN_MISMATCH", "§5 a subdomain");
		eq(rule({ isBison: false, recipientEmail: "billing@example-broker.test", documentsEmail: "billing@example-broker.test", brokerEmail: "ops@sub.example-broker.test" }), "RECIPIENT_DOMAIN_MISMATCH", "§5 the broker on a subdomain");
		eq(rule({ isBison: false, recipientEmail: BILLING, documentsEmail: BILLING, brokerEmail: "" }), "RECIPIENT_DOMAIN_MISMATCH", "§5 no broker Email on the sheet");
	}
})().catch((e) => failures.push(`threw: ${e && e.stack}`)).then(() => {
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
});
