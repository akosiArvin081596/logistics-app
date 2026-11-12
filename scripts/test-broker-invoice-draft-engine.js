#!/usr/bin/env node
/**
 * Tests for lib/broker-invoice-draft.js, the engine behind
 * POST /api/loads/:loadId/draft-invoice (prepare / render / record).
 *
 *   §1 mode "auto": every refusal the automatic drafts add, each on a load that
 *      has only that problem: POD_PAGE_UNREADABLE, RATECON_MISSING (none, a BOL
 *      only), RATECON_BY_CONTENT, RECIPIENT_UNCONFIGURED, NO_BILLING_EMAIL,
 *      RECIPIENT_DOMAIN_MISMATCH (another domain, a subdomain), NO_BROKER_EMAIL,
 *      BROKER_EMAIL_FREEMAIL, TOTAL_MISMATCH, RATECON_TOTAL_UNREAD (a Bison rate
 *      con with no Total Rate too), ADVANCE_LINES (lines flag on and off),
 *      NO_DELIVERY_DATE; and a clean load, Bison and not, prepared.
 *   §2 mode "auto" limits: no request body, no load facts (no by-content
 *      scan), persist:false, overrides ignored, alternate rate cons read with
 *      the free scan only, geminiUnavailable reported, the POD found under
 *      either spelling of the load ID; RATECON_TOTAL_UNREAD after a Gemini error,
 *      Gemini down and no Gemini key (the button bills the sheet), while a Bison
 *      load whose free scan reads the total prepares with no key.
 *   §3 mode "manual" is the button: on every load above it refuses nothing new,
 *      hands getRateConBytes() the body, the load facts and persist:!dryRun,
 *      reads alternates with Gemini, matches the POD's load ID exactly, and a
 *      busy renderer keeps its PDF_RENDERER_BUSY code.
 *   §4 render() and record() for an automatic draft: the Gmail draft's fields,
 *      RENDERER_BUSY, and the row and audit line written as auto-imap by the
 *      system actor.
 *   §5 autoRecipientRefusal(), the recipient rule on its own, and the shared
 *      free-mail list (lib/free-mail-domains.js) the engine reads.
 *   §6 the automatic job's calls as it makes them: the bare actor, record()'s
 *      answer, recovery's to/subject/total comparison, the refusal codes.
 *   §7 mode "auto" reads Job Tracking's Payment as one plain amount: a cell
 *      holding two figures, a note or an accounting negative is TOTAL_MISMATCH
 *      (logged without its value); plain amounts prepare, render and record as
 *      before; a load already held stays held; the button is unchanged.
 *   §8 assignmentFor(): null (or no reader) renders the plain page byte for byte;
 *      { lines } prints them in place of the bank block; a throw is a 503 refusal
 *      before any number, never the bank block; a note holding a bank number refuses
 *      in prepare(); record()'s audit target.
 *  §10 mode "auto" with advance lines (AUTO_INVOICE_ADVANCE_LINES_ENABLED, PR A1): off,
 *      or on without the lines, a load with one is ADVANCE_LINES as before, and so it is
 *      on with no yes from the caller's own switch (Triumph's off among them); on, a $500.00
 *      advance on a $2,150.00 load bills $1,650.00, printed as the button prints it (the
 *      page, the email's sentence, the row, the stamp, one invoice_draft_lines audit row);
 *      a label off the closed list or a reference is ADVANCE_LINE_TEXT; no balance left is
 *      ADVANCE_LINES_INVALID; rule 7 on everything it composes (F2): no deny list is
 *      DENY_LIST_UNSET, a deny-list value or the driver's name is PROTECTED_VALUE; an
 *      invoice with no line is the base's, byte for byte, whatever the switches say.
 *  §11 the Triumph package (PR B1): with Triumph's switch on too, a factored load's
 *      automatic invoice with that advance prints Triumph's block, the advance and the
 *      balance due, and the batch built from its render carries INVAMT 1650.00, the
 *      balance it prints.
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
const crypto = require("crypto");
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
// The house redactor over a made-up deny list: the runners' carrier canary.
const { createRedactor } = require(path.join(ROOT, "lib", "chr-events.js"));
// §11: a page's text as a PDF, and the Triumph batch built from it.
const { textPdf } = require(path.join(__dirname, "lib", "made-up-pdf.js"));
const autoRulesLib = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const triumphBatch = require(path.join(ROOT, "lib", "triumph-batch.js"));
const triumphRules = require(path.join(ROOT, "lib", "triumph-rules.js"));
const SRC = require("./lib/server-source").serverSource();

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
	`BT (Billing Information: Order #: ${order} PO #: PO-77 Move #: 5501) Tj ${total ? `(Total Rate: ${total}) Tj ` : ""}` +
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
	load("LD-TEST-0018", { status: "In Transit" }),
	load("LD-TEST-0019"),
	load("LD-TEST-0020", { email: "" }),
	load("LD-TEST-0021", { email: "dispatch.one@gmail.com" }),
	load("LD-TEST-0022", { email: "Ops.Desk@Yahoo.co.uk" }),
	load("LD-TEST-0023", { email: "desk@proton.me" }),
	load("LD-TEST-0024"),
	load("LD-TEST-0025", { email: "qa-desk@bisontransport.com", pay: "2400" }),
	// §10: booked at $2,150.00, for a made-up $500.00 advance.
	load("LD-TEST-0030", { pay: "2150", done: "11/11/2026" }),
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
	// Each names a documents email on the broker's own domain: only the broker
	// Email rule stands between them and a draft.
	"LD-TEST-0020": [cand(rateCon({ docs: BILLING }), "documents")],
	"LD-TEST-0021": [cand(rateCon({ docs: "someone.else@gmail.com" }), "documents")],
	"LD-TEST-0022": [cand(rateCon({ docs: "billing@yahoo.co.uk" }), "documents")],
	"LD-TEST-0023": [cand(rateCon({ docs: "billing@proton.me" }), "documents")],
	// The documents email on the broker's domain, no billing block: the total is Gemini's to read.
	"LD-TEST-0024": [cand(plainRateCon(BILLING), "documents")],
	// A Bison billing block with its Order # and no Total Rate: the free scan
	// stops at the Order #, so Gemini is never asked for the total.
	"LD-TEST-0025": [cand(rateCon({ order: "7101853", total: "" }), "drive")],
	"LD-TEST-0030": [cand(rateCon({ docs: BILLING, total: "$2,150.00" }), "documents")],
};
// POD rows: [load_id as stored, file name]; the 0011 page and 0014's spelling are the cases.
const PODS = [
	...LOADS.filter((l) => !["LD-TEST-0014", "LD-TEST-0019"].includes(l.id)).map((l) => [l.id, `${l.id}_POD.pdf`]),
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
const DOCUMENTS_SQL = (SRC.match(/CREATE TABLE IF NOT EXISTS documents \([\s\S]*?\n\t\)/) || [""])[0];
const QUIET = { log() {}, warn() {}, error() {} };

const AUTO_ACTOR = { session: { user: { id: 0, username: "auto-invoice", role: "system" } } };
const ADMIN = { session: { user: { id: 1, username: "super_admin", role: "Super Admin" } } };

// `sheet` and `ratecons` replace the fixtures for one world (a load that changed);
// `log` is the console the engine writes to.
// `denyHits`: the carrier deny list's check the engine is handed (none: the list is unset).
// `readable`: the renderer writes the page's text into a PDF the way Chromium writes text.
function world({ env = {}, gemini = null, rendererBusy = false, linesTable = false, sheet = SHEET, ratecons = RATECONS, log = QUIET, assignmentFor, denyHits, readable = false } = {}) {
	const db = new Database(":memory:");
	db.exec(DRAFTS_SQL);
	for (const a of DRAFTS_ALTERS) db.exec(a);
	db.exec(AUDIT_SQL);
	db.exec(DOCUMENTS_SQL);
	db.exec("ALTER TABLE documents ADD COLUMN deleted_at DATETIME DEFAULT NULL");
	const addPod = db.prepare("INSERT INTO documents (load_id, driver, type, file_name, uploaded_at) VALUES (?, 'QA Driver', 'POD', ?, '2026-10-14T15:00:00Z')");
	for (const [id, file] of PODS) addPod.run(id, file);
	if (linesTable || env.BROKER_INVOICE_LINES_ENABLED) brokerInvoice.invoiceLines.ensureSchema(db);
	const helpers = new Function("db", "brokerInvoice", "console", `${lifted.text}\nreturn { ${lifted.names.join(", ")} };`)(db, brokerInvoice, QUIET);
	const seen = { rateconCalls: [], gemini: 0, renders: 0, pages: [] };
	const engine = engineModule.create({
		...helpers,
		db,
		brokerInvoice,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: sheet } }) } } }),
		SPREADSHEET_ID: "made-up-sheet",
		fetchDocumentBytes: async (d) => (UNREADABLE.has(d.file_name) ? null : Buffer.from(`%PDF-1.4 ${d.file_name}`)),
		buildRateConLoadCtx: (row, headers, loadId) => ({ loadId, facts: "made-up" }),
		getRateConBytes: async (loadId, body, loadCtx, opts) => {
			seen.rateconCalls.push({ loadId, body, loadCtx, opts: { ...opts, req: opts && opts.req ? "req" : undefined } });
			const candidates = ratecons[String(loadId).replace(/^#/, "").toUpperCase()] || [];
			return { buffer: candidates[0] ? candidates[0].buffer : null, candidates };
		},
		// gemini: null (answers without fields), "down" (unavailable), "transient"
		// (a 5xx or timeout), "nokey" (no key on this server).
		GEMINI_API_KEY: gemini === "nokey" ? "" : "made-up-key",
		runRateConGemini: async () => {
			seen.gemini++;
			if (gemini === "down") throw Object.assign(new Error("made-up outage"), { kind: "unavailable", status: 503 });
			if (gemini === "transient") throw Object.assign(new Error("made-up overload"), { kind: "transient", status: 503 });
			// An answer that found nothing, in runRateConGemini()'s own shape.
			return { "Total Rate": null, Rate: null, "Order Number": null, "PO Number": null, "Documents Email": null };
		},
		renderHtmlToPdf: async (html) => {
			seen.renders++;
			seen.pages.push(html);
			if (rendererBusy) throw Object.assign(new Error("busy"), { code: "PDF_RENDERER_BUSY" });
			return readable ? textPdf(autoRulesLib.htmlToText(html)) : Buffer.from("%PDF-1.4 invoice");
		},
		env,
		console: log,
		...(assignmentFor === undefined ? {} : { assignmentFor }),
		...(denyHits === undefined ? {} : { denyHits }),
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
			["LD-TEST-0020", "NO_BROKER_EMAIL", "no broker Email on the sheet"],
			["LD-TEST-0006", "NO_BROKER_EMAIL", "a sheet Email that is not an address"],
			["LD-TEST-0021", "BROKER_EMAIL_FREEMAIL", "a broker Email on gmail.com (the rate con naming another gmail address)"],
			["LD-TEST-0022", "BROKER_EMAIL_FREEMAIL", "a broker Email on a free-mail provider's country domain (yahoo.co.uk)"],
			["LD-TEST-0023", "BROKER_EMAIL_FREEMAIL", "a broker Email on proton.me"],
			["LD-TEST-0010", "TOTAL_MISMATCH", "a rate con total that is not Job Tracking's Payment"],
			["LD-TEST-0024", "RATECON_TOTAL_UNREAD", "no total read off the rate con (Gemini answered without one)"],
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
		// §10's own: an invoice with advance lines.
		const ADVANCE_CODES = ["ADVANCE_LINES_INVALID", "ADVANCE_LINE_TEXT", "PROTECTED_VALUE", "DENY_LIST_UNSET"];
		eq([...engineModule.AUTO_REFUSAL_CODES].sort(), [...new Set(CASES.map((c) => c[1]).concat("RECIPIENT_UNCONFIGURED", "ADVANCE_LINES", ...ADVANCE_CODES))].sort(),
			"§1 AUTO_REFUSAL_CODES lists exactly the codes exercised here (§10's among them)");
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

		for (const [gem, down, what] of [["transient", false, "a Gemini error or timeout"], ["down", true, "Gemini down"], ["nokey", false, "no Gemini key"]]) {
			const r = await world({ gemini: gem }).auto("LD-TEST-0024");
			eq([code(r), r.geminiUnavailable], ["RATECON_TOTAL_UNREAD", down], `§2 ${what}: RATECON_TOTAL_UNREAD, geminiUnavailable ${down}`);
			const m = await world({ gemini: gem }).manual("LD-TEST-0024");
			eq([code(m), m.ctx.totalSource, m.ctx.total], ["ok", "sheet", "$1,500.00"], `§2 …the button still bills Job Tracking's Payment (${what})`);
		}
		const bw = world();
		eq([code(await bw.auto("LD-TEST-0025")), bw.seen.gemini], ["RATECON_TOTAL_UNREAD", 0],
			"§2 a Bison rate con with its Order # and no Total Rate: RATECON_TOTAL_UNREAD, Gemini never asked");
		const bm = await world().manual("LD-TEST-0025", { orderNumber: "7101853", poNumber: "" });
		eq([code(bm), bm.ctx.totalSource, bm.ctx.total], ["ok", "sheet", "$2,400.00"], "§2 …the button bills that load's Job Tracking Payment, as before");
		const keyless = await world({ gemini: "nokey" }).auto("LD-TEST-0002");
		eq([code(keyless), keyless.ok && keyless.ctx.totalSource, keyless.ok && keyless.ctx.total], ["ok", "ratecon", "$2,400.00"],
			"§2 a Bison load with no Gemini key, its total read by the free scan: prepares");

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
		for (const id of ["LD-TEST-0003", "LD-TEST-0004", "LD-TEST-0005", "LD-TEST-0006", "LD-TEST-0007", "LD-TEST-0008", "LD-TEST-0009", "LD-TEST-0010", "LD-TEST-0011", "LD-TEST-0013",
			"LD-TEST-0020", "LD-TEST-0021", "LD-TEST-0022", "LD-TEST-0023"]) {
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
		const exact = await world().manual("LD-TEST-0014");
		eq([exact.ok, exact.http, exact.json], [false, 400, { error: "POD not found for this load" }], "§3 the POD's load ID still matches exactly on the button");
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

		// The Draft Invoice button's in-flight rows (lib/factoring-store.js): record()
		// touches one only when told to (settleInflight), inside its own write.
		w.db.exec(`CREATE TABLE IF NOT EXISTS invoice_draft_inflight (load_key TEXT NOT NULL, load_id TEXT NOT NULL DEFAULT '', invoice_id TEXT NOT NULL,
			path TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (load_key, invoice_id))`);
		const inflight = () => w.db.prepare("SELECT load_key, invoice_id FROM invoice_draft_inflight ORDER BY invoice_id").all();
		const putInflight = w.db.prepare("INSERT INTO invoice_draft_inflight (load_key, load_id, invoice_id, path, state, started_at, updated_at) VALUES ('ld-test-0001', 'LD-TEST-0001', ?, 'imap', 'in_flight', '2026-10-28T12:00:00Z', '2026-10-28T12:00:00Z')");
		putInflight.run("10282026-7");
		putInflight.run("10282026-6");
		w.engine.record(ctx, rendered, { via: "auto-imap", actor: AUTO_ACTOR, invoiceId: "10282026-7", mintedInvoiceId: "10282026-7", editDiffs: [] });
		eq(inflight().length, 2, "§4 record() without settleInflight leaves the in-flight table untouched (the automatic drafts' calls)");
		const row = w.db.prepare("SELECT load_id, invoice_id, recipient, recipient_source, total, via, created_by, edited, invoice_id_minted FROM load_invoice_drafts").all();
		eq(row, [{ load_id: "LD-TEST-0001", invoice_id: "10282026-7", recipient: BILLING, recipient_source: "ratecon", total: "$1,500.00", via: "auto-imap", created_by: "auto-invoice", edited: 0, invoice_id_minted: "" }],
			"§4 one draft row: auto-imap, the invoice #, created by auto-invoice, unedited");
		const audit = w.db.prepare("SELECT user_id, username, role, action, entity, entity_id, details FROM audit_trail").all();
		eq(audit, [{ user_id: 0, username: "auto-invoice", role: "system", action: "invoice_draft_created", entity: "load", entity_id: "LD-TEST-0001", details: `10282026-7 → ${BILLING} (auto-imap)` }],
			"§4 one audit row, the system actor, in today's invoice_draft_created shape");
		const settled = w.engine.record(ctx, rendered, { via: "imap", actor: AUTO_ACTOR, invoiceId: "10282026-7", mintedInvoiceId: "10282026-7", editDiffs: [],
			settleInflight: { loadKey: "ld-test-0001", invoiceId: "10282026-7" } });
		eq([settled.recorded, inflight()], [true, [{ load_key: "ld-test-0001", invoice_id: "10282026-6" }]],
			"§4 FAILS ON THE OLD CODE: with settleInflight, exactly that in-flight row goes, with the draft row");
		w.db.exec("CREATE TRIGGER made_up_refuse BEFORE INSERT ON load_invoice_drafts BEGIN SELECT RAISE(ABORT, 'made-up refusal'); END;");
		const refused = w.engine.record(ctx, rendered, { via: "imap", actor: AUTO_ACTOR, invoiceId: "10282026-6", mintedInvoiceId: "10282026-6", editDiffs: [], draftWarnings: [],
			settleInflight: { loadKey: "ld-test-0001", invoiceId: "10282026-6" } });
		eq([refused.recorded, inflight().length], [false, 1], "§4 FAILS ON THE OLD CODE: an INSERT that fails takes the delete with it (the row stays; record() answers recorded:false)");

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

		const free = require(path.join(ROOT, "lib", "free-mail-domains.js")).isFreeMailDomain;
		const FREE = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "aol.com",
			"icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com", "yandex.com",
			"yahoo.co.uk", "hotmail.fr", "gmx.de", "mail.yahoo.com", "outlook.com.au"];
		eq(FREE.filter((d) => !free(d)), [], "§5 the shared list: every named provider, its country domains and its subdomains");
		ok(!/\bFREE_MAIL_(DOMAINS|PROVIDERS)\b/.test(fs.readFileSync(ENGINE, "utf8")), "§5 the engine keeps no list of its own");
		const OWN = ["example-broker.test", "bisontransport.com", "acme.me", "mail.acme-freight.example.test", "livestock-freight.example.test", "gmailer.example.test", ""];
		eq(OWN.filter((d) => free(d)), [], "§5 …and not a company's own domain that merely contains a provider's letters");
	}

	// ===================================================================== §6
	// The automatic job's own calls (lib/auto-invoice-job.js): its actor is the
	// bare user, it reads render()'s to/subject/total, it rebuilds a draft to
	// compare with what reached Gmail, and it sorts refusals by code.
	section("6. The automatic job's calls, as it makes them");
	{
		const JOB_ACTOR = Object.freeze({ id: 0, username: "auto-invoice", role: "system" });
		const recipientOf = (ctx, rendered) => String((rendered ? rendered.to : ctx && (ctx.to || (ctx.invoiceTo && ctx.invoiceTo.email))) || "");
		const sentOf = (to, rendered) => ({ to: String(to || "").toLowerCase(), subject: String((rendered && rendered.subject) || ""), total: String((rendered && rendered.total) ?? "") });
		const draftOnce = async (w, loadId, invoiceId) => {
			// advanceLines: the job's own switch, off in these worlds.
			const prep = await w.engine.prepare({ loadId, body: {}, dryRun: false, mode: "auto", advanceLines: false });
			if (!prep.ok) return { prep };
			const rendered = await w.engine.render(prep.ctx, { invoiceId, invoiceDate: "10/28/2026", emailBody: null });
			return { prep, rendered, sent: sentOf(recipientOf(prep.ctx, rendered), rendered) };
		};

		const w = world();
		const first = await draftOnce(w, "LD-TEST-0001", "10282026-9");
		eq([recipientOf(first.prep.ctx, null), first.sent], [BILLING, { to: BILLING, subject: "Example Broker Order #LD-TEST-0001", total: "$1,500.00" }],
			"§6 the recipient before a number is reserved, and the draft's to, subject and billed total");
		const rec = await w.engine.record(first.prep.ctx, first.rendered, { via: "auto-imap", actor: JOB_ACTOR, invoiceId: "10282026-9", mintedInvoiceId: "10282026-9", editDiffs: [] });
		const row = w.db.prepare("SELECT id, invoice_id, via, created_by, total FROM load_invoice_drafts").all();
		eq([rec, row], [{ recorded: true, draftRowId: 1 }, [{ id: 1, invoice_id: "10282026-9", via: "auto-imap", created_by: "auto-invoice", total: "$1,500.00" }]],
			"§6 record() with the bare actor writes the row and answers { recorded, draftRowId }");
		eq(w.db.prepare("SELECT user_id, username, role, action FROM audit_trail").all(), [{ user_id: 0, username: "auto-invoice", role: "system", action: "invoice_draft_created" }],
			"§6 …and its audit row names the system actor (no invoice_draft_record_failed)");

		const again = await draftOnce(world(), "LD-TEST-0001", "10282026-9");
		eq(again.sent, first.sent, "§6 recovery: the load unchanged, the rebuilt draft matches what reached Gmail");
		const moved = SHEET.map((r) => (r[0] === "LD-TEST-0001" ? r.map((c, i) => (HEADERS[i] === "  Payment  " ? "1600" : c)) : r));
		const movedRc = { ...RATECONS, "LD-TEST-0001": [cand(rateCon({ docs: BILLING, total: "$1,600.00" }), "documents")] };
		const changed = await draftOnce(world({ sheet: moved, ratecons: movedRc }), "LD-TEST-0001", "10282026-9");
		eq([changed.prep.ok, changed.sent.total, JSON.stringify(changed.sent) === JSON.stringify(first.sent)], [true, "$1,600.00", false],
			"§6 recovery: a total that moved since the draft no longer matches (the comparison sees the total)");

		const failing = world();
		failing.db.exec("CREATE TEMP TRIGGER test_fail_record BEFORE INSERT ON load_invoice_drafts BEGIN SELECT RAISE(ABORT, 'made-up disk error'); END");
		const ok1 = await draftOnce(failing, "LD-TEST-0001", "10282026-9");
		eq(await failing.engine.record(ok1.prep.ctx, ok1.rendered, { via: "auto-imap", actor: JOB_ACTOR, invoiceId: "10282026-9", mintedInvoiceId: "10282026-9", editDiffs: [] }),
			{ recorded: false, draftRowId: null }, "§6 a row that cannot be written: { recorded: false }, no throw");

		for (const [id, want, http, json] of [
			["LD-TEST-9999", "LOAD_NOT_FOUND", 404, { error: "Load not found" }],
			["LD-TEST-0018", "NOT_COMPLETED", 400, { error: "Load must be delivered/completed to draft an invoice (current status: \"In Transit\")." }],
			["LD-TEST-0019", "POD_NOT_FOUND", 400, { error: "POD not found for this load" }],
		]) {
			const a = await world().engine.prepare({ loadId: id, body: {}, dryRun: false, mode: "auto" });
			eq([a.code, a.http, a.json], [want, http, json], `§6 ${want}: the code the job sorts on, the answer unchanged`);
			const m = await world().manual(id);
			eq([m.code, m.http, m.json], [want, http, json], `§6 ${want} on the button: the same JSON the route answers`);
		}

		const stored = world();
		stored.db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_file_id, drive_url) VALUES ('LD-TEST-0001', '', 'RATECON', 'matched.pdf', 'made-up-drive-id', '')").run();
		eq(code(await stored.auto("LD-TEST-0001")), "RATECON_BY_CONTENT", "§6 a rate con an earlier by-content match linked to the load → RATECON_BY_CONTENT");
		eq(code(await stored.manual("LD-TEST-0001")), "ok", "§6 …while the button reads it as before");
		const local = world();
		local.db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_file_id, drive_url) VALUES ('LD-TEST-0001', '', 'RATECON', 'upload.pdf', 'made-up-drive-id', '/uploads/rate-cons/LD-TEST-0001.pdf')").run();
		eq(code(await local.auto("LD-TEST-0001")), "ok", "§6 a rate con stored with its own file (drag and drop, an upload) is not a content match");

		let threw = "";
		try { await world().engine.prepare({ loadId: "LD-TEST-0001", body: {}, dryRun: true, mode: "auto" }); } catch (e) { threw = e.message; }
		ok(/never dry-runs/.test(threw), "§6 mode \"auto\" refuses a dry run (it would skip the approve's refusals)");
	}

	// ===================================================================== §7
	// The sheet's side of the automatic total check is the raw Payment cell read
	// as one plain amount (lib/cell-compare.js moneyCents()): parseMoney() keeps
	// digits, "." and "-", so it reads "1,800.00 / 1,875.00" as $1,800.00. Every
	// cell is made up; in each red case the rate con prints the cell's first figure.
	section("7. mode \"auto\" — Job Tracking's Payment must be one plain amount");
	{
		const PAY = "  Payment  ";
		const ID = "LD-TEST-0001";
		// `id`'s Payment cell set to `pay`; with `total`, its one rate con prints that
		// Total Rate (read by the free scan, no Gemini).
		const payWorld = (id, pay, total = null, extra = {}) => {
			const sheet = SHEET.map((r) => (r[0] === id ? r.map((c, i) => (HEADERS[i] === PAY ? pay : c)) : r));
			const rc = id === "LD-TEST-0002" ? cand(rateCon({ order: "7101852", total }), "drive") : cand(rateCon({ docs: BILLING, total }), "documents");
			return world({ ...extra, sheet, ratecons: total === null ? RATECONS : { ...RATECONS, [id]: [rc] } });
		};
		const capture = () => {
			const lines = [];
			const put = (...a) => lines.push(a.map(String).join(" "));
			return { lines, log: { log: put, warn: put, error: put } };
		};
		const aboutPayment = (lines) => lines.filter((l) => /one amount/.test(l));
		// No digit and no "$" once the load ID is taken out: no figure is carried.
		const noValue = (text) => !/[\d$]/.test(String(text).split(ID).join(""));
		const NOT_ONE = `Job Tracking's Payment on load ${ID} isn't one amount.`;
		const DIFFER = `The rate con's total and Job Tracking's Payment differ on load ${ID}.`;
		const LOGGED = `Draft invoice ${ID}: Job Tracking's Payment isn't one amount; held for a person.`;

		for (const [pay, total, what] of [
			["1,800.00 / 1,875.00", "$1,800.00", "two figures with a slash"],
			["$1,950.00 - $150.00", "$1,950.00", "a figure less another"],
			["1,800.00 (1,875 w/ det)", "$1,800.00", "a figure and a note holding another"],
			["1800.00 1875.00", "$1,800.00", "two figures side by side"],
			["$1,800.00\n$1,875.00", "$1,800.00", "two figures on two lines of one cell"],
			["$1,800.00 - 35 DVIR", "$1,800.00", "a figure with a deduction noted"],
			["1,800.00 TONU", "$1,800.00", "a figure with a word after it"],
			["$1,800.00*", "$1,800.00", "a figure with a footnote mark"],
		]) {
			const c = capture();
			const r = await payWorld(ID, pay, total, { log: c.log }).auto(ID);
			eq([code(r), r.http, r.json && r.json.error], ["TOTAL_MISMATCH", 422, NOT_ONE],
				`§7 FAILS ON THE OLD CODE: ${what}, ${JSON.stringify(pay)}, its first figure the rate con's total (${total}) → TOTAL_MISMATCH, for a person`);
			eq(aboutPayment(c.lines), [LOGGED], `§7 …one log line says why (${what})`);
			ok(noValue(JSON.stringify(r.json)) && c.lines.every(noValue), `§7 …neither the refusal nor the log carries a figure (${what})`);
		}
		const bison = await payWorld("LD-TEST-0002", "2,400.00 / 2,475.00", "$2,400.00").auto("LD-TEST-0002");
		eq([code(bison), bison.json && bison.json.error], ["TOTAL_MISMATCH", "Job Tracking's Payment on load LD-TEST-0002 isn't one amount."],
			"§7 FAILS ON THE OLD CODE: a Bison load's two-figure Payment, its rate con's total the first figure → TOTAL_MISMATCH");
		const negative = await payWorld(ID, "($1,800.00)", "$1,800.00").auto(ID);
		eq([code(negative), negative.json && negative.json.error], ["TOTAL_MISMATCH", DIFFER],
			"§7 FAILS ON THE OLD CODE: an accounting negative \"($1,800.00)\" is -$1,800.00, never the rate con's $1,800.00 → TOTAL_MISMATCH");

		for (const [pay, total, n] of [
			["$1,950.00", "$1,950.00", 1950],
			["1950", "$1,950.00", 1950],
			[" $ 4,100.00 ", "$4,100.00", 4100],
			["$1,800.00", "$1,800.00", 1800],
			[" $ 1,800.00 ", "$1,800.00", 1800],
			["1800", "$1,800.00", 1800],
			["1,800", "$1,800.00", 1800],
			["$1,234.56", "$1,234.56", 1234.56],
		]) {
			const c = capture();
			const r = await payWorld(ID, pay, total, { log: c.log }).auto(ID);
			eq([code(r), r.ok && [r.ctx.rcTotal, r.ctx.sheetTotal, r.ctx.totalAmount, r.ctx.totalSource, r.ctx.total, r.ctx.billedTotal]],
				["ok", [n, n, n, "ratecon", total, total]], `§7 one plain amount, ${JSON.stringify(pay)}, equal to the rate con's ${total}: prepares exactly as before`);
			eq(aboutPayment(c.lines), [], `§7 …and logs nothing about the Payment (${JSON.stringify(pay)})`);
		}
		const pw = payWorld(ID, " $ 4,100.00 ", "$4,100.00");
		const prep = await pw.auto(ID);
		const rendered = await pw.engine.render(prep.ctx, { invoiceId: "11042026-1", invoiceDate: "11/04/2026" });
		pw.engine.record(prep.ctx, rendered, { via: "auto-imap", actor: AUTO_ACTOR, invoiceId: "11042026-1", mintedInvoiceId: "11042026-1", editDiffs: [] });
		eq([rendered.total, pw.db.prepare("SELECT total, total_source, sheet_total, ratecon_total FROM load_invoice_drafts").all()],
			["$4,100.00", [{ total: "$4,100.00", total_source: "ratecon", sheet_total: "$4,100.00", ratecon_total: "$4,100.00" }]],
			"§7 …the draft for \" $ 4,100.00 \" bills $4,100.00 and its row records it, as before");

		for (const [pay, total, want, what] of [
			["$1,800.00", "$1,800.01", DIFFER, "one cent apart"],
			["1,800.01", "$1,800.00", DIFFER, "one cent apart, the other way"],
			["-$1,800.00", "$1,800.00", DIFFER, "a negative"],
			["1,500 + 75 det", "$1,500.00", null, "a sum written out"],
			["1,800.00 + 75.00 det", "$1,800.00", null, "a sum written out with cents"],
			["", "$1,800.00", null, "an empty cell"],
		]) {
			const r = await payWorld(ID, pay, total).auto(ID);
			eq([code(r), want ? r.json && r.json.error : null], ["TOTAL_MISMATCH", want], `§7 still held: ${what} (${JSON.stringify(pay)} against ${total}) → TOTAL_MISMATCH`);
		}
		const noColumn = await world({ sheet: SHEET.map((r) => r.filter((c, i) => HEADERS[i] !== PAY)) }).auto(ID);
		eq([code(noColumn), noColumn.json && noColumn.json.error], ["TOTAL_MISMATCH", NOT_ONE],
			"§7 still held: a sheet with no Payment column → TOTAL_MISMATCH, there is no figure to check the rate con's against");
		// It only adds holds: a cell the strict reading takes as a positive amount
		// is that amount to parseMoney() too, so nothing the old check held passes.
		const { moneyCents } = require(path.join(ROOT, "lib", "cell-compare.js"));
		const AMOUNTS = ["0", "1800", "1,800", "1800.5", "1,800.00", "$1,800.00", "1,234.56", "1234.560", "-1,800.00", "$-1,800.00"];
		const SHAPES = [(a) => a, (a) => ` ${a} `, (a) => `$ ${a}`, (a) => `(${a})`, (a) => `${a} / 1,875.00`, (a) => `1,875.00 / ${a}`,
			(a) => `${a} - 150`, (a) => `${a}*`, (a) => `${a} USD`, (a) => `${a}\n${a}`, (a) => `${a} ${a}`, (a) => `${a}${a}`];
		const disagree = [];
		let taken = 0;
		for (const a of AMOUNTS) {
			for (const shape of SHAPES) {
				const s = moneyCents(shape(a));
				if (s === null || s <= 0) continue;
				taken++;
				if (Math.round(brokerInvoice.parseMoney(shape(a)) * 100) !== s) disagree.push(shape(a));
			}
		}
		eq([disagree, taken >= 20], [[], true],
			`§7 only adds holds: of ${AMOUNTS.length * SHAPES.length} made-up cells, every one the strict reading takes as a positive amount (${taken}) reads the same under parseMoney()`);

		const mc = capture();
		const m = await payWorld(ID, "1,800.00 / 1,875.00", "$1,800.00", { log: mc.log }).manual(ID);
		eq([code(m), m.ok && [m.ctx.totalSource, m.ctx.total, m.ctx.sheetTotal]], ["ok", ["ratecon", "$1,800.00", brokerInvoice.parseMoney("1,800.00 / 1,875.00")]],
			"§7 the button, the same two-figure cell: nothing refused, the rate con's total billed, the sheet read as before");
		eq(aboutPayment(mc.lines), [], "§7 …and nothing logged about the Payment");
		const unread = payWorld("LD-TEST-0024", "1,800.00 / 1,875.00");
		const m2 = await unread.manual("LD-TEST-0024");
		eq([code(m2), m2.ok && [m2.ctx.totalSource, m2.ctx.total]], ["ok", ["sheet", "$1,800.00"]],
			"§7 the button with no rate-con total read: it bills the sheet's figure as before, for the person to review");
		eq(code(await unread.auto("LD-TEST-0024")), "RATECON_TOTAL_UNREAD",
			"§7 mode \"auto\" on that load: the unread rate-con total is still the refusal it gives (checked first, as before)");
	}

	// ===================================================================== §8
	section("8. who the invoice tells the broker to pay");
	{
		const ID = "LD-TEST-0001";
		const NUMBER = { invoiceId: "10282026-7", invoiceDate: "10/28/2026" };
		const LINES = ["MADE-UP NOTICE LINE ONE", "MADE-UP NOTICE LINE TWO", "EXAMPLE FACTOR LLC", "PO DRAWER 000, NOWHERE, ZZ  00000-0000"];
		const pageOf = (ctx) => brokerInvoice.buildInvoiceHtml({
			...NUMBER, brokerName: ctx.effBrokerName, invoiceTo: ctx.invoiceTo, orderNumber: ctx.orderNumber, poNumber: ctx.poNumber,
			deliveryDate: ctx.deliveryDate, invoiceLines: ctx.lineSummary, total: ctx.total, notes: ctx.notes,
		});
		// An invoice that isn't factored: the renderer gets the page exactly as lib/broker-invoice.js made it.
		for (const [label, opts] of [["no reader", {}], ["a reader answering null", { assignmentFor: () => null }]]) {
			const w = world(opts);
			const p = await w.manual(ID);
			await w.engine.render(p.ctx, NUMBER);
			eq(w.seen.pages[0] === pageOf(p.ctx), true, `§8 ${label}: the renderer gets the plain page, byte for byte`);
			eq([p.ctx.assignment, w.seen.pages[0].includes("Payment Method")], [null, true], `§8 ${label}: no assignment, and the bank block prints`);
		}
		const asked = [];
		const w = world({ assignmentFor: (id) => { asked.push(id); return { lines: LINES }; } });
		const p = await w.manual(ID);
		eq([code(p), asked], ["ok", [ID]], "§8 prepare() asks once, by the load's ID");
		eq(p.ctx.assignment, { lines: LINES }, "§8 ...and hands the lines to render()");
		const rendered = await w.engine.render(p.ctx, NUMBER);
		const printed = w.seen.pages[0];
		ok(LINES.every((l) => printed.includes(`>${l}</div>`)), "§8 FAILS ON THE OLD CODE: a factored invoice prints every assignment line");
		ok(!printed.includes("Payment Method") && !printed.includes("Bank Routing") && !printed.includes("Bank Account"), "§8 FAILS ON THE OLD CODE: ...and no bank block");
		ok(printed.startsWith(pageOf(p.ctx).slice(0, pageOf(p.ctx).indexOf('<div class="payment">'))), "§8 ...and all the rest of the page is the plain page");
		ok(rendered.invoicePdf && rendered.attachments.length > 0, "§8 ...and the draft's attachments carry it");

		// No lines, or a marker that can't be read: refused before any number.
		for (const [label, thrown, want] of [
			["no assignment lines", Object.assign(new Error("made-up"), { code: "NOA_UNCONFIGURED" }), "NOA_UNCONFIGURED"],
			["a marker that can't be read", Object.assign(new Error("made-up"), { code: "FACTORING_UNREADABLE" }), "FACTORING_UNREADABLE"],
			["any other failure", new Error("made-up"), "FACTORING_UNREADABLE"],
			["no error at all", null, "FACTORING_UNREADABLE"],
		]) {
			const t = world({ assignmentFor: () => { throw thrown; } });
			for (const [mode, run] of [["the button", () => t.manual(ID)], ["the preview", () => t.manual(ID, {}, true)], ["mode \"auto\"", () => t.auto(ID)]]) {
				const r = await run();
				eq([r.ok, r.http, r.code, r.json && r.json.code], [false, 503, want, want], `§8 FAILS ON THE OLD CODE: ${label}, ${mode}: a 503 refusal, ${want}`);
				ok(r.json && !/made-up/.test(r.json.error), `§8 ...${label}, ${mode}: in the app's own words`);
			}
			eq(t.seen.renders, 0, `§8 ...${label}: nothing rendered`);
		}
		// The bank numbers' check runs before any number is spent, so a note can't burn one.
		const saved = [process.env.INVOICE_BANK_ROUTING, process.env.INVOICE_BANK_ACCOUNT];
		process.env.INVOICE_BANK_ROUTING = "000111222";
		process.env.INVOICE_BANK_ACCOUNT = "3334445556";
		try {
			const noted = world({ assignmentFor: () => ({ lines: LINES }) });
			const refused = await noted.manual(ID, { notes: "routing 000-111-222" });
			eq([refused.ok, refused.http, refused.code, noted.seen.renders], [false, 409, "ASSIGNMENT_NOT_PRINTABLE", 0], "§8 a note holding the bank's routing number on a factored invoice: refused in prepare(), nothing rendered");
			eq(code(await noted.manual(ID, { notes: "Unload at door 4" })), "ok", "§8 ...any other note is fine");
			eq(code(await noted.manual(ID, { notes: "Payment Method: see below" })), "ok", "§8 FAILS ON THE OLD CODE: ...a note naming the bank block too");
			const plain = world({ assignmentFor: () => null });
			eq(code(await plain.manual(ID, { notes: "routing 000-111-222" })), "ok", "§8 ...and on an invoice that isn't factored the note prints as it always has");
		} finally {
			[process.env.INVOICE_BANK_ROUTING, process.env.INVOICE_BANK_ACCOUNT] = saved;
		}

		// record()'s audit target.
		const audited = async (extra) => {
			const a = world();
			const c = (await a.manual(ID)).ctx;
			a.engine.record(c, { total: c.billedTotal }, { via: "imap", actor: ADMIN, invoiceId: "10282026-7", mintedInvoiceId: "10282026-7", ...extra });
			return a.db.prepare("SELECT details FROM audit_trail WHERE action = 'invoice_draft_created'").get();
		};
		const plainAudit = await audited({});
		eq(plainAudit && plainAudit.details, `10282026-7 → ${BILLING} (imap)`, "§8 record() with no target: the audit line as it always was");
		const named = await audited({ auditTarget: "Triumph", via: "triumph" });
		eq(named && named.details, "10282026-7 → Triumph (triumph)", "§8 FAILS ON THE OLD CODE: with a target, the audit line names it rather than a printed address");
	}

	// ===================================================================== §10
	// AUTO_INVOICE_ADVANCE_LINES_ENABLED (PR A1). Made-up figures only: LD-TEST-0030 booked at
	// $2,150.00, a $500.00 fuel advance, a $1,650.00 balance due; the runners' carrier canary and a
	// made-up driver's name.
	section("10. mode \"auto\" with advance lines — the balance due, the text gate, rule 7");
	{
		const ID = "LD-TEST-0030";
		const ON = Object.freeze({ BROKER_INVOICE_LINES_ENABLED: "true", AUTO_INVOICE_ADVANCE_LINES_ENABLED: "true" });
		const NUMBER = { invoiceId: "11122026-4", invoiceDate: "11/12/2026" };
		const DENY = createRedactor({ denyList: "99887766" }).hits;
		const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
		const addAdvance = (w, over = {}, loadId = ID) => brokerInvoice.invoiceLines.addLine(w.db, {
			loadId, values: { kind: "advance", label: "Fuel advance", amountCents: 50000, receivedOn: "2026-11-02", reference: "", note: "", ...over },
			actor: "super_admin", closedMonths: [],
		}, { audit: () => {} }).line;
		const sheetWithDriver = (name) => SHEET.map((r) => (r[0] === ID ? r.map((c, i) => (HEADERS[i] === "Driver" ? name : c)) : r));
		const actions = (w) => w.db.prepare("SELECT action FROM audit_trail ORDER BY id").all().map((a) => a.action);
		// The automatic job's call with its own switch on: it hands the engine that yes.
		const job = (w, loadId = ID) => w.auto(loadId, { advanceLines: true });

		// Off, or on without the lines themselves: today's refusal, even with the caller's yes.
		for (const [label, env] of [
			["its own switch off (the lines on)", { BROKER_INVOICE_LINES_ENABLED: "true" }],
			["its own switch on, the lines off", { AUTO_INVOICE_ADVANCE_LINES_ENABLED: "true" }],
			["its own switch \"TRUE\" (only exactly \"true\" is on)", { BROKER_INVOICE_LINES_ENABLED: "true", AUTO_INVOICE_ADVANCE_LINES_ENABLED: "TRUE" }],
			["its own switch \"1\"", { BROKER_INVOICE_LINES_ENABLED: "true", AUTO_INVOICE_ADVANCE_LINES_ENABLED: "1" }],
		]) {
			const w = world({ env, linesTable: true, denyHits: DENY });
			addAdvance(w);
			eq([code(await job(w)), w.seen.renders], ["ADVANCE_LINES", 0], `§10 ${label}: a load with an advance line still goes to a person (ADVANCE_LINES)`);
		}

		// Each caller of mode "auto" holds its own switch where the lines are read. With both of A1's
		// settings on and Triumph's off, a line added after Triumph's free checks passed the load (they
		// read none then) reaches only the engine, which must answer ADVANCE_LINES.
		{
			const TRIUMPH_OFF = ON;
			const TRIUMPH_ON = Object.freeze({ ...ON, TRIUMPH_ADVANCE_LINES_ENABLED: "true" });
			const before = { live: true, completed: true, drafts: 0, closedMonths: [], hasDeliveryDate: true, activeAdvanceLines: 0, pods: 1, podsUnreadable: 0,
				brokerDomain: "example-broker.test", isBison: false, brokerEmailFreemail: false, brokerDomainConfirmed: true };
			eq(triumphRules.freeVerdict(before, { debtorName: "Example Broker LLC", hasLines: true }).state, "queued", "§10 Triumph's free checks pass the load while it has no line");
			for (const [label, env, extra] of [
				["Triumph's switch off: the caller hands the engine lib/triumph-rules.js advanceLinesEnabled()", TRIUMPH_OFF, { advanceLines: triumphRules.advanceLinesEnabled(TRIUMPH_OFF) }],
				["no switch handed at all (a caller of mode \"auto\" that names none)", TRIUMPH_ON, {}],
				["the yes handed as the text \"true\"", TRIUMPH_ON, { advanceLines: "true" }],
			]) {
				const w = world({ env, denyHits: DENY });
				addAdvance(w);
				eq([code(await w.auto(ID, extra)), w.seen.renders], ["ADVANCE_LINES", 0], `§10 FAILS ON THE OLD CODE: both of A1's settings on, ${label}: a line added after the free checks is ADVANCE_LINES, nothing rendered`);
			}
			const w = world({ env: TRIUMPH_ON, denyHits: DENY });
			addAdvance(w);
			const p = await w.auto(ID, { advanceLines: triumphRules.advanceLinesEnabled(TRIUMPH_ON) });
			eq([code(p), p.ok && p.ctx.billedTotal], ["ok", "$1,650.00"], "§10 ...Triumph's switch on as well: the engine prints the line and bills the balance due");
		}

		// On: the balance due, printed as the button prints it.
		{
			const w = world({ env: ON, denyHits: DENY });
			addAdvance(w);
			const p = await job(w);
			eq([code(p), p.ok && p.ctx.total, p.ok && p.ctx.billedTotal, p.ok && p.ctx.lineSummary && [p.ctx.lineSummary.lineHaulCents, p.ctx.lineSummary.advancesCents, p.ctx.lineSummary.balanceCents]],
				["ok", "$2,150.00", "$1,650.00", [215000, 50000, 165000]],
				"§10 FAILS ON THE OLD CODE: on, a $500.00 advance on a $2,150.00 load prepares: the line haul $2,150.00, the balance due $1,650.00");
			eq(p.ok && [p.ctx.lineSummary.footnote, p.ctx.lineSummary.footnoteDefault, p.ctx.lineSummary.lineHaulSource], ["*$500 for fuel advance", "*$500 for fuel advance", "ratecon"],
				"§10 ...the default footnote, from the label and the amount; the line haul is the rate con's total");
		}
		{
			// The same load on a tree before PR A1 refuses (above): what follows is the prepared draft.
			const w = world({ env: ON, denyHits: DENY });
			const line = addAdvance(w);
			const p = await job(w);
			if (!p.ok) failures.push(`§10 FAILS ON THE OLD CODE: the render, the row and the audit rows need a prepared draft (got ${code(p)})`);
			const r = p.ok ? await w.engine.render(p.ctx, NUMBER) : { total: "", html: "", attachments: [] };
			const page = w.seen.pages[0] || "";
			eq(r.total, "$1,650.00", "§10 FAILS ON THE OLD CODE: render() answers the balance due as the billed total");
			ok(page.includes('<div class="subtotal"><span>LINE HAUL</span><span class="amt">$2,150.00</span></div>')
				&& page.includes('<div class="subtotal"><span>LESS ADVANCES</span><span class="amt">-$500.00</span></div>')
				&& page.includes('<div class="pill"><span class="lbl">Balance due*</span><span class="amt">$1,650.00</span></div>'),
			"§10 FAILS ON THE OLD CODE: the page reads LINE HAUL $2,150.00, LESS ADVANCES -$500.00, Balance due $1,650.00");
			ok(page.includes('<div class="item-title">Fuel advance</div>') && page.includes('<div class="item-sub">Received 11/02/2026</div>') && page.includes('<div class="footnote">*$500 for fuel advance</div>'),
				"§10 ...the advance's own row, its received date, and the footnote under the totals");
			ok(r.html.includes("<p>Balance due $1,650.00 after the $500.00 fuel advance.</p>"), "§10 FAILS ON THE OLD CODE: the email says the balance in its own sentence");
			eq(r.attachments.map((a) => a.filename), ["Example Broker Invoice Order #LD-TEST-0030.pdf", "LD-TEST-0030_POD.pdf", "LD-TEST-0030.pdf"],
				"§10 ...the invoice, the POD and the rate con, as for any automatic invoice");
			// The Draft Invoice button's page for the same load and line.
			const m = await w.manual(ID);
			await w.engine.render(m.ctx, NUMBER);
			eq(w.seen.pages[1], page, "§10 FAILS ON THE OLD CODE: the page is the Draft Invoice button's own page for the same load and line, byte for byte");

			const rec = p.ok ? w.engine.record(p.ctx, r, { via: "auto-smtp", actor: AUTO_ACTOR, invoiceId: NUMBER.invoiceId, mintedInvoiceId: NUMBER.invoiceId, editDiffs: [] }) : {};
			const row = w.db.prepare("SELECT total, gross_total, lines_json, via, total_source, ratecon_total, sheet_total, edited FROM load_invoice_drafts WHERE load_id = ? AND via = 'auto-smtp'").get(ID);
			eq([rec.recorded, row && [row.total, row.gross_total, row.via, row.total_source, row.ratecon_total, row.sheet_total, row.edited]],
				[true, ["$1,650.00", "$2,150.00", "auto-smtp", "ratecon", "$2,150.00", "$2,150.00", 0]],
				"§10 FAILS ON THE OLD CODE: the draft row bills the balance due and keeps the line haul, as the button's row does; unedited");
			eq(row && JSON.parse(row.lines_json), { lineHaulCents: 215000, advancesCents: 50000, balanceCents: 165000, lineHaulSource: "ratecon", footnote: "*$500 for fuel advance",
				lines: [{ id: line.id, kind: "advance", label: "Fuel advance", amountCents: 50000, receivedOn: "2026-11-02", reference: "" }] },
			"§10 FAILS ON THE OLD CODE: ...and its printed copy of the line");
			eq(brokerInvoice.invoiceLines.listLines(w.db, ID).map((l) => l.invoiceId), [NUMBER.invoiceId], "§10 FAILS ON THE OLD CODE: the line is stamped with the invoice that printed it");
			const audits = w.db.prepare("SELECT username, role, action, details FROM audit_trail ORDER BY id").all();
			eq(audits.map((a) => a.action), ["invoice_draft_created", "invoice_draft_lines"], "§10 FAILS ON THE OLD CODE: two audit rows: the created row, then one for the lines (no edit row)");
			eq(audits[0] && audits[0].details, `${NUMBER.invoiceId} → ${BILLING} (auto-smtp)`, "§10 ...the created row as it always was");
			eq(audits[1] && [audits[1].username, audits[1].role, audits[1].details],
				["auto-invoice", "system", `${NUMBER.invoiceId} load ${ID} — lines: line haul $2,150.00, less advances $500.00, balance due $1,650.00 (INVOICE ONLY — Job Tracking Payment unchanged); items: #${line.id} Fuel advance $500.00`],
				"§10 FAILS ON THE OLD CODE: ...the lines' row, by the system actor, the figures first");
		}

		// Two clean lines: both print, the balance after both.
		{
			const w = world({ env: ON, denyHits: DENY });
			addAdvance(w, { amountCents: 30000 });
			addAdvance(w, { label: "Advance", amountCents: 20000, receivedOn: "" });
			const p = await job(w);
			eq([code(p), p.ok && p.ctx.billedTotal, p.ok && p.ctx.lineSummary.items.map((i) => i.amountCents), p.ok && p.ctx.lineSummary.footnote],
				["ok", "$1,650.00", [30000, 20000], "*$300 for fuel advance\n*$200 for advance"],
				"§10 FAILS ON THE OLD CODE: two clean lines, $300.00 and $200.00: both print, the balance after both, one footnote line each");
		}

		// Rule 7 on the lines: a label from the closed list, case aside, and no reference.
		for (const [label, line, want] of [
			["a label \"Fuel advance to Pat Example\" (a made-up driver's name after the list's words)", { label: "Fuel advance to Pat Example" }, "ADVANCE_LINE_TEXT"],
			["a label \"Fuel advance EFS\"", { label: "Fuel advance EFS" }, "ADVANCE_LINE_TEXT"],
			["a label \"Pat Example advance\"", { label: "Pat Example advance" }, "ADVANCE_LINE_TEXT"],
			["a label \"Cash advance\"", { label: "Cash advance" }, "ADVANCE_LINE_TEXT"],
			["the list's label with a reference", { reference: "EFS-55501" }, "ADVANCE_LINE_TEXT"],
			["the label \"Advance\"", { label: "Advance" }, "ok"],
			["the label \"FUEL ADVANCE\" (the list's, in capitals)", { label: "FUEL ADVANCE" }, "ok"],
		]) {
			const w = world({ env: ON, denyHits: DENY });
			addAdvance(w, line);
			const got = await job(w);
			eq([code(got), w.seen.renders], [want, 0], `§10 FAILS ON THE OLD CODE: ${label}: ${want}, nothing rendered`);
			if (want !== "ok") ok(!/Pat|EFS/.test(JSON.stringify(got.json)), `§10 ...${label}: the refusal carries none of the line's text`);
		}
		{
			const w = world({ env: ON, denyHits: DENY });
			addAdvance(w, { amountCents: 30000 });
			addAdvance(w, { label: "Fuel advance to Pat Example", amountCents: 20000 });
			eq(code(await job(w)), "ADVANCE_LINE_TEXT", "§10 FAILS ON THE OLD CODE: one typed line among clean ones stops the load");
		}
		ok(!brokerInvoice.buildInvoiceHtml({ invoiceLines: { lineHaulCents: 215000, advancesCents: 50000, balanceCents: 165000, footnote: "", items: [{ id: 1, label: "Fuel advance", amountCents: 50000, note: "Pat Example" }] } }).includes("Pat Example"),
			"§10 a line's note prints on no invoice");

		// No balance due left to bill: never the line haul instead.
		for (const [label, lines] of [["an advance equal to the total", [{ amountCents: 215000 }]], ["two advances past it", [{ amountCents: 200000 }, { label: "Advance", amountCents: 20000 }]]]) {
			const w = world({ env: ON, denyHits: DENY });
			for (const l of lines) addAdvance(w, l);
			const got = await job(w);
			eq([code(got), got.http, w.seen.renders], ["ADVANCE_LINES_INVALID", 422, 0], `§10 FAILS ON THE OLD CODE: ${label}: no balance due to bill, ADVANCE_LINES_INVALID, nothing rendered`);
		}

		// F2: rule 7 on everything the invoice composes, before any number.
		{
			const unset = world({ env: ON });
			addAdvance(unset);
			eq([code(await job(unset)), unset.seen.renders], ["DENY_LIST_UNSET", 0], "§10 FAILS ON THE OLD CODE (F2): no carrier deny list set: DENY_LIST_UNSET, nothing rendered");
			eq(code(await job(world({ env: ON }), "LD-TEST-0001")), "ok", "§10 (F2) ...a load with no line is made as before, with no list set");
			const carrier = world({ env: ON, denyHits: DENY, ratecons: { ...RATECONS, [ID]: [cand(rateCon({ docs: "billing99887766@example-broker.test", total: "$2,150.00" }), "documents")] } });
			addAdvance(carrier);
			const cr = await job(carrier);
			eq([code(cr), carrier.seen.renders], ["PROTECTED_VALUE", 0], "§10 FAILS ON THE OLD CODE (F2): the carrier canary in the billing email the rate con gave: PROTECTED_VALUE, nothing rendered");
			ok(cr.json && !/9988/.test(JSON.stringify(cr.json)), "§10 (F2) ...the refusal names no value");
			const split = world({ env: ON, denyHits: DENY, ratecons: { ...RATECONS, [ID]: [cand(rateCon({ docs: "billing9988@example-broker.test", total: "$2,150.00" }), "documents")] } });
			addAdvance(split, { amountCents: 77660 });
			eq(code(await job(split)), "ok", "§10 (F2) each value is read on its own: the canary's halves in two fields are no hit");
			const named = world({ env: ON, denyHits: DENY, sheet: sheetWithDriver("Pat Example") });
			named.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via, notes) VALUES (?, '11112026-1', 'imap', 'Fuel paid to pat example at pickup')").run(ID);
			addAdvance(named);
			const nr = await job(named);
			eq([code(nr), named.seen.renders], ["PROTECTED_VALUE", 0], "§10 FAILS ON THE OLD CODE (F2): the load's own driver's name, any case, in a note it would print: PROTECTED_VALUE");
			ok(nr.json && !/pat|example/i.test(String(nr.json.error).replace(/the driver's name/, "")), "§10 (F2) ...the refusal names no value");
			const team = world({ env: ON, denyHits: DENY, sheet: sheetWithDriver("Sam Sample / Pat Example") });
			team.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via, notes) VALUES (?, '11112026-1', 'imap', 'Fuel paid to Pat Example at pickup')").run(ID);
			addAdvance(team);
			eq(code(await job(team)), "PROTECTED_VALUE", "§10 FAILS ON THE OLD CODE (F2): one name of a team in the driver cell");
			const other = world({ env: ON, denyHits: DENY, sheet: sheetWithDriver("Pat Example") });
			other.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via, notes) VALUES (?, '11112026-1', 'imap', 'Unload at door 4')").run(ID);
			addAdvance(other);
			eq(code(await job(other)), "ok", "§10 (F2) a note without the name or a listed value prints");
		}

		// No line: the base's (62fe51c8) invoice, byte for byte, whatever the switches say. Recorded by
		// running this case on that tree.
		const GOLDEN_NO_LINE = "c30af3c89720e501ce5145fd3b1f32c7300d4c29409e882b5ed684e253ec5277";
		for (const [label, env, voided] of [
			["both off", {}, false], ["the lines on", { BROKER_INVOICE_LINES_ENABLED: "true" }, false], ["both on", ON, false], ["both on, its one line voided", ON, true],
		]) {
			const g = world({ env, linesTable: true, denyHits: DENY });
			if (voided) {
				const l = addAdvance(g, {}, "LD-TEST-0001");
				brokerInvoice.invoiceLines.voidLine(g.db, { loadId: "LD-TEST-0001", lineId: l.id, reason: "made up", actor: "qa" }, {});
			}
			// The job hands the engine its own switch as it reads.
			const gp = await g.auto("LD-TEST-0001", { advanceLines: autoRulesLib.advanceLinesEnabled(env) });
			const gr = await g.engine.render(gp.ctx, NUMBER);
			const digest = sha256([g.seen.pages[0], gr.html, gr.subject, gr.total, gr.attachments.map((a) => a.filename).join("|")].join("\0"));
			eq(digest, GOLDEN_NO_LINE, `§10 no line (${label}): the page, the email, the subject, the billed total and the files are the base's, byte for byte`);
			g.engine.record(gp.ctx, gr, { via: "auto-smtp", actor: AUTO_ACTOR, invoiceId: NUMBER.invoiceId, mintedInvoiceId: NUMBER.invoiceId, editDiffs: [] });
			eq([actions(g), g.db.prepare("SELECT total FROM load_invoice_drafts").get().total], [["invoice_draft_created"], "$1,500.00"], `§10 no line (${label}): one audit row and the total, as before`);
		}
	}

	// ===================================================================== §11
	// The Triumph package (PR B1): the same made-up load and advance, factored.
	section("11. the Triumph package — a factored automatic invoice with an advance line");
	{
		const ID = "LD-TEST-0030";
		const ON = Object.freeze({ BROKER_INVOICE_LINES_ENABLED: "true", AUTO_INVOICE_ADVANCE_LINES_ENABLED: "true", TRIUMPH_ADVANCE_LINES_ENABLED: "true" });
		const NUMBER = { invoiceId: "11122026-5", invoiceDate: "11/12/2026" };
		const DENY = createRedactor({ denyList: "99887766" }).hits;
		const NOA = ["MADE-UP NOTICE LINE ONE", "MADE-UP NOTICE LINE TWO", "EXAMPLE FACTOR LLC", "PO DRAWER 000, NOWHERE, ZZ  00000-0000"];
		const w = world({ env: ON, denyHits: DENY, assignmentFor: () => ({ lines: NOA }), readable: true });
		brokerInvoice.invoiceLines.addLine(w.db, {
			loadId: ID, values: { kind: "advance", label: "Fuel advance", amountCents: 50000, receivedOn: "2026-11-02", reference: "", note: "" }, actor: "super_admin", closedMonths: [],
		}, { audit: () => {} });
		// Triumph's caller hands the engine Triumph's own switch.
		const p = await w.auto(ID, { advanceLines: triumphRules.advanceLinesEnabled(ON) });
		eq([code(p), p.ok && p.ctx.billedTotal, p.ok && Boolean(p.ctx.assignment)], ["ok", "$1,650.00", true], "§11 FAILS ON THE OLD CODE: a factored load's automatic invoice with an advance line prepares, billing the balance due");
		const r = p.ok ? await w.engine.render(p.ctx, NUMBER) : null;
		const page = w.seen.pages[0] || "";
		ok(NOA.every((l) => page.includes(`>${l}</div>`)) && !page.includes("Payment Method"), "§11 FAILS ON THE OLD CODE: its page carries Triumph's block in place of the bank block");
		ok(page.includes('<div class="subtotal"><span>LESS ADVANCES</span><span class="amt">-$500.00</span></div>') && page.includes('<span class="lbl">Balance due*</span><span class="amt">$1,650.00</span>'),
			"§11 FAILS ON THE OLD CODE: ...and the advance and the balance due");
		const batch = r ? await triumphBatch.buildBatch({
			invoicePdf: r.invoicePdf,
			rateCon: { buffer: textPdf(`RATE CON (MADE UP) Load Number ${ID} Bill to Example Broker LLC Total $2,150.00`), source: "documents" },
			rateConNumber: ID,
			documents: [{ id: 1, type: "POD", uploaded_at: "2026-11-11 15:00:00", buffer: textPdf(`POD OF ${ID}`) }],
			loadId: ID,
			debtorName: "Example Broker LLC",
			invoiceId: NUMBER.invoiceId,
			invoiceDate: NUMBER.invoiceDate,
			po: p.ctx.orderNumber,
			billedTotal: r.total,
			at: new Date("2026-11-12T15:04:05Z"),
			denyHits: DENY,
		}) : { ok: false };
		eq([batch.ok, batch.row && batch.row.INVAMT], [true, "1650.00"], "§11 FAILS ON THE OLD CODE: the batch built from its render carries INVAMT 1650.00, the balance due it prints");
		eq(batch.ok ? triumphBatch.unprintedFields(batch.pdf, batch.row) : null, [], "§11 ...which the merged PDF's text shows, with the invoice number, the date and the PO");
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
