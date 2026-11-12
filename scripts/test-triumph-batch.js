#!/usr/bin/env node
// A factored load's invoice and its Triumph batch.
//
//   §1 the assignment block (lib/triumph-invoice.js): in place of the bank block, word
//      for word, or refused; never both, and never a factored page with the bank block
//   §2 an invoice that isn't factored renders byte-identical, and the hashed statement
//      templates are as they were
//   §3 the batch (lib/triumph-batch.js): parts in the guide's order, page counts, names,
//      hashes, the CSV, and the merged PDF's text showing what the CSV says
//   §4 every refusal, each leaving no partial batch
//   §5 the made-up sample: fixed values, the stamp on each page, refused without the lines
//   §6 scripts/triumph-batch-sample.js --out: what it writes and where it refuses;
//      no database, connection or number for the sample
//   §7 --load, on a made-up replica's copies: read-only, and the batch's own rules
//   §8 scripts/triumph-batch-size-report.js and scripts/triumph-what-would-change.js:
//      counts only, on made-up copies
//
// The invoice page goes through a stand-in renderer that writes a PDF of the page's
// words the way Chromium writes one (scripts/lib/made-up-pdf.js): no browser here. Made-up
// loads, lines and documents only. Temporary folders only; no port and no network.
//   node scripts/test-triumph-batch.js      # exits 1 on any failure
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const optional = (p) => {
	try {
		return require(p);
	} catch {
		return null;
	}
};
const triumphInvoice = optional(path.join(ROOT, "lib", "triumph-invoice.js"));
const batchLib = optional(path.join(ROOT, "lib", "triumph-batch.js"));
const rules = optional(path.join(ROOT, "lib", "triumph-rules.js"));
if (!triumphInvoice || !batchLib || !rules) {
	console.log("FAIL  lib/triumph-invoice.js, lib/triumph-batch.js or lib/triumph-rules.js is missing: a factored invoice can't print the assignment lines and no batch can be built");
	process.exit(1);
}
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
const { shownText } = require(path.join(ROOT, "lib", "pdf-shown-text.js"));
const { textPdf } = require(path.join(ROOT, "scripts", "lib", "made-up-pdf.js"));
const { PDFDocument, StandardFonts } = require(path.join(ROOT, "node_modules", "pdf-lib"));
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const { createRedactor } = require(path.join(ROOT, "lib", "chr-events.js"));
const { effectiveStatementTemplateHash, STATEMENT_TEMPLATE_FILES } = require(path.join(ROOT, "lib", "statement-template-hash.js"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
const ok = (cond, label) => eq(Boolean(cond), true, label);
const section = (t) => console.log(`\n${t}`);
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const tempDirs = [];
process.on("exit", () => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "triumph-batch-")));
	tempDirs.push(d);
	return d;
};

// Made up: never Triumph's words.
const LINES = Object.freeze(["MADE-UP NOTICE LINE ONE", "THIS INVOICE IS MADE UP AND PAYABLE TO, A MADE-UP FACTOR,", "EXAMPLE FACTOR LLC", "PO DRAWER 000, NOWHERE, ZZ  00000-0000"]);
const NOA_SETTING = LINES.join("\n");
const ROUTING = "000000000";
const ACCOUNT = "0000000000";
process.env.INVOICE_BANK_ROUTING = ROUTING;
process.env.INVOICE_BANK_ACCOUNT = ACCOUNT;
process.env.DEFAULT_INVOICE_EMAIL = "billing@example-broker.test";
delete process.env.BISON_INVOICE_EMAIL;
delete process.env.TRIUMPH_NOA_LINES;

const FIELDS = Object.freeze({
	invoiceId: "11022026-7", invoiceDate: "11/02/2026", brokerName: "Example Broker", orderNumber: "LD-TEST-0001", poNumber: "PO-77", deliveryDate: "11/01/2026",
	invoiceTo: Object.freeze({ name: "Example Broker", email: "billing@example-broker.test" }), total: "$2,150.00",
});
const page = (over = {}) => brokerInvoice.buildInvoiceHtml({ ...FIELDS, ...over });
// lib/broker-invoice.js's page for these fields and the made-up bank settings above, at the
// base this module was built on: an invoice that isn't factored must stay these bytes.
const GOLDEN = Object.freeze({
	plain: "a2851c02c0f480d818875a435697e15262802b677cffe46be10858896fe99f76",
	noted: "52c48bd789e9251147580942cda1ad7d125042c41f22848bb0390c669559cb7d",
});

// The words a page shows: what the stand-in renderer prints, with its tags gone. It keeps
// spaces, so a run of them can be checked.
const shownWords = (html) => html
	.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<head[\s\S]*?<\/head>/g, " ").replace(/<[^>]+>/g, "\n")
	.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
	.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
const renderSpy = () => {
	const fn = async (html) => {
		fn.pages.push(html);
		return textPdf(shownWords(html));
	};
	fn.pages = [];
	return fn;
};

// ---------------------------------------------------------------- §1
section("§1 the assignment block");
{
	const base = page();
	const html = triumphInvoice.withAssignment(base, { lines: LINES });
	ok(base.includes("Payment Method") && base.includes(ROUTING), "§1 (fixture) the page has the bank block to replace");
	for (const word of ["Payment Method", "Bank Name", "Bank Routing", "Bank Account", brokerInvoice.PAYMENT_METHOD.bankName, ROUTING, ACCOUNT]) {
		ok(!html.includes(word), `§1 no ${word === ROUTING ? "routing number" : word === ACCOUNT ? "account number" : `"${word}"`} on a factored invoice`);
	}
	for (const line of LINES) ok(html.includes(`>${line}</div>`), `§1 the line prints as written: ${line}`);
	ok(html.includes("ZZ  00000-0000"), "§1 ...the two spaces before the ZIP are in the page");
	eq((html.match(/white-space: pre-wrap/g) || []).length, LINES.length, "§1 ...and each line keeps its spaces when it prints");
	eq(LINES.map((l) => html.indexOf(`>${l}<`)).every((at, i, all) => at > 0 && (i === 0 || at > all[i - 1])), true, "§1 the lines print in their order");
	eq((html.match(/<div class="payment"/g) || []).length, 1, "§1 one block");
	ok(html.indexOf('<div class="payment"') > html.indexOf('class="totals') && html.indexOf('<div class="payment"') < html.indexOf('<div class="thanks">'), "§1 it sits where the bank block sat, after the totals");
	// All of the page but the block is what the page was.
	const at = base.indexOf('<div class="payment">');
	const end = base.indexOf('<div class="thanks">');
	ok(html.startsWith(base.slice(0, at)), "§1 everything before the block is byte for byte the page");
	ok(html.endsWith(base.slice(end)), "§1 everything after it is too");
	const unset = (() => {
		const saved = [process.env.INVOICE_BANK_ROUTING, process.env.INVOICE_BANK_ACCOUNT];
		delete process.env.INVOICE_BANK_ROUTING;
		delete process.env.INVOICE_BANK_ACCOUNT;
		const out = triumphInvoice.withAssignment(page(), { lines: LINES });
		[process.env.INVOICE_BANK_ROUTING, process.env.INVOICE_BANK_ACCOUNT] = saved;
		return out;
	})();
	ok(!unset.includes(brokerInvoice.BANK_DETAILS_NOT_SET) && !unset.includes("Payment Method"), "§1 with the bank settings unset, no \"Bank details not set\" either");
	const esc = triumphInvoice.withAssignment(base, { lines: ["A & B <C> \"D\" 'E'"] });
	ok(esc.includes("A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39;") && !esc.includes("<C>"), "§1 a line is escaped: it's text, never markup");

	const refused = (fn) => {
		try {
			fn();
			return "no throw";
		} catch (e) {
			return e.code;
		}
	};
	for (const [label, a] of [["{}", {}], ["false", false], ["0", 0], ["an empty string", ""], ["no lines", { lines: [] }], ["a blank line", { lines: ["A", "  "] }], ["a line that isn't text", { lines: ["A", 1] }], ["lines that aren't a list", { lines: "A" }]]) {
		eq(refused(() => triumphInvoice.withAssignment(base, a)), triumphInvoice.NOT_PRINTABLE, `§1 an assignment of ${label}: refused, never the bank block`);
	}
	const noted = page({ notes: `Routing ${ROUTING} as usual` });
	eq(refused(() => triumphInvoice.withAssignment(noted, { lines: LINES })), triumphInvoice.NOT_PRINTABLE, "§1 a note holding the routing number: refused");
	ok(triumphInvoice.withAssignment(page({ notes: "Unload at door 4" }), { lines: LINES }).includes("Unload at door 4"), "§1 any other note prints");

	// Bank details as a person types them, not as the block prints them.
	const BANK = brokerInvoice.PAYMENT_METHOD;
	const titleCase = (s) => s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
	const withNumbers = (fn) => {
		const saved = [process.env.INVOICE_BANK_ROUTING, process.env.INVOICE_BANK_ACCOUNT];
		process.env.INVOICE_BANK_ROUTING = "000111222";
		process.env.INVOICE_BANK_ACCOUNT = "3334445556";
		try {
			return fn();
		} finally {
			[process.env.INVOICE_BANK_ROUTING, process.env.INVOICE_BANK_ACCOUNT] = saved;
		}
	};
	const onPage = (fields) => withNumbers(() => refused(() => triumphInvoice.withAssignment(page(fields), { lines: LINES })));
	// The two numbers are refused however they're spaced or punctuated.
	for (const [label, notes] of [
		["the routing number with hyphens", "routing 000-111-222"],
		["the routing number with spaces", "routing 000 111 222"],
		["the routing number with stops", "000.111.222"],
		["the routing number spaced around its hyphens", "000 - 111 - 222"],
		["the routing number in full-width digits", "０００１１１２２２"],
		["only the account number, with spaces", "333 444 5556"],
		["only the account number, with hyphens", "acct 333-444-5556"],
		["both numbers in one run", "Routing/Account: 000111222/3334445556"],
		["a number beside words", `Remit to ${titleCase(BANK.bankName)}, routing 000-111-222, account 333 444 5556`],
	]) {
		eq(onPage({ notes }), triumphInvoice.NOT_PRINTABLE, `§1 a note holding ${label}: refused`);
	}
	eq(onPage({ poNumber: "000 111 222" }), triumphInvoice.NOT_PRINTABLE, "§1 the routing number typed in another field: refused");
	// Nothing else is read: words print as typed, the block's own words and a bank's name too.
	for (const [label, fields] of [
		["the bank block's label", { notes: "Payment Method: see below" }],
		["the bank's name in the block's spelling", { notes: `Pay ${BANK.bankName}` }],
		["the bank's name in ordinary case", { notes: `Remit to ${titleCase(BANK.bankName)}` }],
		["the block's address", { notes: `Mail to ${BANK.address.toUpperCase()}` }],
		["\"bank name:\"", { notes: "bank name: see below" }],
		["\"BANK ACCOUNT:\"", { notes: "BANK ACCOUNT: see below" }],
		["a sentence about the bank account", { notes: "Pay to the bank account named on the factor's notice" }],
		["a sentence about the payment method", { notes: "Payment method: ACH per the notice above" }],
		["another sentence about it", { notes: "Please update your payment method" }],
		["a sentence that names the account", { notes: "Do not send payment to our bank account" }],
		["a change of account", { notes: "Bank account changed: see the notice" }],
		["a made-up consignee's name", { notes: "Made-Up Riverbank Account Services" }],
		["the bank's name in another field", { brokerName: titleCase(BANK.bankName) }],
	]) {
		eq(onPage(fields), "no throw", `§1 FAILS ON THE OLD CODE: ${label}: it prints, since only the two numbers are refused`);
	}
	for (const [label, fields] of [
		["a number that's neither", { notes: "ref 000-111-223" }],
		["part of the account number", { notes: "ref 333 444" }],
		["a number split across two fields", { poNumber: "000111", orderNumber: "222" }],
		["a number split across two cells side by side", { deliveryDate: "000-111", total: "$222.00" }],
		["the word bank alone", { notes: "Closed for the bank holiday" }],
		["the word account alone", { notes: "Bill to the account on file with the broker" }],
		["the seller's own name and mail", { notes: `${BANK.name} ${BANK.email}` }],
	]) {
		eq(onPage(fields), "no throw", `§1 ${label}: it prints`);
	}
	eq(onPage({}), "no throw", "§1 the plain page: its stylesheet's words and its own numbers aren't read as a note's");
	{
		// Only what the page shows is read: a short number the stylesheet holds ("#0f2847") isn't a note's.
		const saved = [process.env.INVOICE_BANK_ROUTING, process.env.INVOICE_BANK_ACCOUNT];
		process.env.INVOICE_BANK_ROUTING = "000111222";
		process.env.INVOICE_BANK_ACCOUNT = "2847";
		try {
			ok(page().includes("#0f2847"), "§1 (fixture) the stylesheet holds those digits");
			eq(refused(() => triumphInvoice.withAssignment(page(), { lines: LINES })), "no throw", "§1 the stylesheet isn't read for the numbers");
		} finally {
			[process.env.INVOICE_BANK_ROUTING, process.env.INVOICE_BANK_ACCOUNT] = saved;
		}
	}
	eq(refused(() => triumphInvoice.withAssignment("<html>no block here</html>", { lines: LINES })), triumphInvoice.NOT_PRINTABLE, "§1 a page with no block to replace: refused");
	eq(refused(() => triumphInvoice.withAssignment(base.replace('<div class="thanks">', ""), { lines: LINES })), triumphInvoice.NOT_PRINTABLE, "§1 a page where the block's end moved: refused");
	eq(refused(() => triumphInvoice.withAssignment(base.replace('<div class="payment">', '<div class="payment"></div><div class="payment">'), { lines: LINES })), triumphInvoice.NOT_PRINTABLE, "§1 a page with two blocks: refused");
	eq(refused(() => triumphInvoice.withAssignment(base.replace(/<strong>Bank Routing #:<\/strong>/, "<strong>Routing:</strong>"), { lines: LINES })), triumphInvoice.NOT_PRINTABLE, "§1 a block whose bank slots moved: refused, since nothing can say they're gone");
	eq(triumphInvoice.printRefusal(base, { lines: LINES }), null, "§1 printRefusal(): nothing when it prints");
	eq(triumphInvoice.printRefusal(noted, { lines: LINES }), { code: triumphInvoice.NOT_PRINTABLE, http: 409, error: triumphInvoice.NOT_PRINTABLE_WORDS }, "§1 ...its code, status and words when it can't");
	ok(/the digits of LogisX's own bank routing or account number/.test(triumphInvoice.NOT_PRINTABLE_WORDS) && !/notes or names|bank details/.test(triumphInvoice.NOT_PRINTABLE_WORDS),
		"§1 FAILS ON THE OLD CODE: the words say exactly what's refused: the routing or account number's digits");
	// A page the block can't go on: words that don't blame a field.
	for (const [label, html, a] of [["no block to replace", "<html>no block here</html>", { lines: LINES }], ["an assignment with no lines", base, { lines: [] }],
		["a block whose bank slots moved", base.replace(/<strong>Bank Routing #:<\/strong>/, "<strong>Routing:</strong>"), { lines: LINES }]]) {
		const r = triumphInvoice.printRefusal(html, a);
		eq([r && r.code, r && r.error], [triumphInvoice.NOT_PRINTABLE, triumphInvoice.NOT_PLACED_WORDS], `§1 FAILS ON THE OLD CODE: ${label}: refused in words of its own`);
	}
	ok(/couldn't be placed on this invoice/.test(String(triumphInvoice.NOT_PLACED_WORDS)) && !/routing|account|note/.test(String(triumphInvoice.NOT_PLACED_WORDS)), "§1 FAILS ON THE OLD CODE: ...which say it couldn't be placed and name no field");
}

// ---------------------------------------------------------------- §2
section("§2 an invoice that isn't factored renders byte-identical");
{
	const base = page();
	ok(triumphInvoice.withAssignment(base, null) === base, "§2 no assignment (null): the same string");
	ok(triumphInvoice.withAssignment(base, undefined) === base, "§2 no assignment (undefined): the same string");
	eq(sha256(base), GOLDEN.plain, "§2 the plain page, byte for byte as the base printed it");
	eq(sha256(page({ notes: "Unload at door 4" })), GOLDEN.noted, "§2 ...and with a note");
	eq(effectiveStatementTemplateHash(), "cba159821377", "§2 the stored statements' template hash hasn't moved");
	eq(STATEMENT_TEMPLATE_FILES.includes("./lib/broker-invoice.js"), true, "§2 (fixture) the invoice page is one of the hashed files");
	ok(!/assignment/i.test(fs.readFileSync(path.join(ROOT, "lib", "broker-invoice.js"), "utf8")), "§2 the hashed invoice page knows nothing of the assignment");
	for (const f of STATEMENT_TEMPLATE_FILES) ok(!/triumph-invoice|triumph-rules|triumph-batch/.test(fs.readFileSync(path.join(ROOT, f), "utf8")), `§2 ${f} doesn't load these modules`);
}

// ---------------------------------------------------------------- §3
const LOAD = "LD-TEST-0001";
const DEBTOR = "Example Broker LLC";
const RATECON_TEXT = `RATE CON (MADE UP) Load Number ${LOAD} Bill to ${DEBTOR} Total $2,150.00`;
const noHits = () => false;
const pdfOf = (text) => textPdf(text);
const docRow = (id, type, text, uploaded_at = "2026-11-02 10:00:00") => ({ id, type, uploaded_at, buffer: pdfOf(text) });
const INVOICE_TEXT = "INVOICE Invoice ID # : 11022026-7 Date: 11/02/2026 Example Broker Order: #LD-TEST-0001 Total $2,150.00";
const args = (over = {}) => ({
	invoicePdf: pdfOf(INVOICE_TEXT),
	rateCon: { buffer: pdfOf(RATECON_TEXT), source: "documents" },
	rateConNumber: LOAD,
	documents: [docRow(1, "POD", "POD PAGE ONE", "2026-11-02 10:00:00"), docRow(2, "POD", "POD PAGE TWO", "2026-11-02 11:00:00"), docRow(3, "BOL", "BOL PAGE", "2026-11-02 12:00:00")],
	loadId: LOAD,
	debtorName: DEBTOR,
	invoiceId: "11022026-7",
	invoiceDate: "11/02/2026",
	po: LOAD,
	billedTotal: "$2,150.00",
	at: new Date("2026-11-02T15:04:05Z"),
	denyHits: noHits,
	...over,
});
// Each page of a merged PDF on its own, as text.
async function pageTexts(pdf) {
	const doc = await PDFDocument.load(pdf);
	const out = [];
	for (const i of doc.getPageIndices()) {
		const one = await PDFDocument.create();
		const [p] = await one.copyPages(doc, [i]);
		one.addPage(p);
		out.push(shownText(Buffer.from(await one.save(batchLib.SAVE_OPTIONS))));
	}
	return out;
}

async function s3() {
	section("§3 the batch");
	const b = await batchLib.buildBatch(args());
	ok(b.ok, "§3 it builds");
	eq(b.pdfName, "11022026-7.pdf", "§3 the PDF is named for INVOICE#");
	eq(b.csvName, "logisx_20261102T150405Z_11022026-7.csv", "§3 the CSV's name");
	eq(b.csv.toString("utf8"), `DTR_NAME,INVOICE#,INV_DATE,PO,INVAMT\r\n${DEBTOR},11022026-7,11/02/2026,${LOAD},2150.00\r\n`, "§3 the CSV's bytes");
	const texts = await pageTexts(b.pdf);
	eq(texts.map((t) => t.slice(0, 7)), ["INVOICE", "RATE CO", "BOL PAG", "POD PAG", "POD PAG"], "§3 the pages: the invoice, the rate con, the BOL, then the PODs");
	ok(texts[3].includes("ONE") && texts[4].includes("TWO"), "§3 ...the PODs in page order");
	eq(b.parts.map((p) => [p.kind, p.pages]), [["invoice", 1], ["ratecon", 1], ["bol", 1], ["pod", 1], ["pod", 1]], "§3 each part's kind and page count");
	eq((await PDFDocument.load(b.pdf)).getPageCount(), 5, "§3 five pages in all");
	ok(b.parts.every((p) => /^[0-9a-f]{64}$/.test(p.sha256) && p.bytes > 0), "§3 each part's hash and size");
	eq(b.parts[1].sha256, sha256(args().rateCon.buffer), "§3 ...of the bytes it was given");
	eq(b.batchBytes, b.pdf.length + b.csv.length, "§3 the batch's bytes are the PDF's and the CSV's");
	eq([b.pdfSha256, b.csvSha256], [sha256(b.pdf), sha256(b.csv)], "§3 the two files' hashes");
	eq(batchLib.unprintedFields(b.pdf, b.row), [], "§3 parity: INVOICE#, INV_DATE, PO and INVAMT all appear in the merged PDF's text");
	eq(batchLib.unprintedFields(b.pdf, { ...b.row, INVAMT: "2150.01" }), ["INVAMT"], "§3 ...an amount it doesn't print is named");
	eq(batchLib.unprintedFields(b.pdf, { ...b.row, PO: "LD-TEST-0002" }), ["PO"], "§3 ...and a PO");
	ok(!b.pdf.includes("/ObjStm"), "§3 the merged PDF is written plain, so its own text can be read back");

	const lumper = await batchLib.buildBatch(args({ documents: [docRow(1, "POD", "POD PAGE"), docRow(2, "Lumper", "LUMPER RECEIPT"), docRow(3, "Scale Ticket", "SCALE TICKET", "2026-11-02 09:00:00"), docRow(4, "Receipt", "A FUEL RECEIPT"), docRow(5, "Other", "SOMETHING ELSE")] }));
	eq((await pageTexts(lumper.pdf)).map((t) => t.slice(0, 5)), ["INVOI", "RATE ", "POD P", "SCALE", "LUMPE"], "§3 a lumper or scale document on file goes last, in upload order; a receipt or \"Other\" doesn't go");

	// A comma in the debtor's name stops the batch before any PDF is made, even when its rate
	// con prints the name so: Triumph's CSV takes no quotes. PDFs are counted at the library.
	const counted = async (a) => {
		const create = PDFDocument.create;
		let made = 0;
		PDFDocument.create = function (...x) {
			made++;
			return create.apply(this, x);
		};
		try {
			return { r: await batchLib.buildBatch(a), made };
		} finally {
			PDFDocument.create = create;
		}
	};
	const control = await counted(args());
	ok(control.r.ok && control.made > 0, "§3 (fixture) a batch that builds makes its PDF where it's counted");
	const comma = await counted(args({ debtorName: "Example Broker, LLC", rateCon: { buffer: pdfOf(`Load Number ${LOAD} Bill to Example Broker, LLC`), source: "documents" } }));
	eq([comma.r.ok, comma.r.code, comma.r.field], [false, "DEBTOR_NAME_COMMA", "DTR_NAME"], "§3 FAILS ON THE OLD CODE: a comma in the debtor's name, printed so on its rate con: DEBTOR_NAME_COMMA");
	eq(comma.made, 0, "§3 FAILS ON THE OLD CODE: ...and no PDF was made");
	eq(Object.keys(comma.r).filter((k) => ["pdf", "csv", "pdfName", "csvName"].includes(k)), [], "§3 FAILS ON THE OLD CODE: ...and the answer holds no part of a batch");
	const literal = await batchLib.buildBatch(args({ rateCon: { buffer: textPdf(RATECON_TEXT, { mode: "literal" }), source: "documents" } }));
	ok(literal.ok, "§3 a rate con written plainly reads too");
	const onDrive = await batchLib.buildBatch(args({ rateCon: { buffer: pdfOf(RATECON_TEXT), source: "drive", driveFileName: `${LOAD} rate con.pdf` } }));
	ok(onDrive.ok, "§3 a Drive file carrying the load's whole number in its name");

	// A document of several pages, from the PDF library the app writes receipts with.
	const threePages = await new Promise((resolve, reject) => {
		const PDFKit = require(path.join(ROOT, "node_modules", "pdfkit"));
		const doc = new PDFKit({ autoFirstPage: false });
		const chunks = [];
		doc.on("data", (c) => chunks.push(c));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);
		for (let i = 0; i < 3; i++) doc.addPage().text(`A MADE-UP POD PAGE ${i + 1}`);
		doc.end();
	});
	const many = await batchLib.buildBatch(args({ documents: [{ id: 1, type: "POD", buffer: threePages }, docRow(2, "POD", "THE LAST POD PAGE", "2026-11-03 10:00:00")] }));
	eq(many.parts.map((p) => [p.kind, p.pages]), [["invoice", 1], ["ratecon", 1], ["pod", 3], ["pod", 1]], "§3 a part's pages all go, and are counted");
	eq((await PDFDocument.load(many.pdf)).getPageCount(), 6, "§3 ...six pages in all");
}

// ---------------------------------------------------------------- §4
async function s4() {
	section("§4 every refusal, and never a partial batch");
	const code = async (over) => {
		const r = await batchLib.buildBatch(args(over));
		return r.ok ? "ok" : [r.code, ...[].concat(r.kinds || r.kind || r.field || [])].join(":");
	};
	const garbage = Buffer.from("this is not a PDF");
	const empty = async () => Buffer.from(await (await PDFDocument.create()).save({ addDefaultPage: false }));
	eq(await code({ invoicePdf: null }), "DOCUMENT_MISSING:invoice", "§4 no invoice");
	eq(await code({ invoicePdf: Buffer.alloc(0) }), "DOCUMENT_MISSING:invoice", "§4 an empty invoice");
	eq(await code({ rateCon: null }), "DOCUMENT_MISSING:ratecon", "§4 a missing document: no rate con");
	eq(await code({ rateCon: { buffer: Buffer.alloc(0), source: "documents" } }), "DOCUMENT_MISSING:ratecon", "§4 a rate con with no bytes");
	eq(await code({ documents: [] }), "DOCUMENT_MISSING:pod", "§4 a missing document: no POD or BOL");
	eq(await code({ documents: [docRow(1, "Lumper", "LUMPER RECEIPT")] }), "DOCUMENT_MISSING:pod", "§4 a lumper receipt alone is no POD");
	eq(await code({ invoicePdf: null, rateCon: null, documents: [] }), "DOCUMENT_MISSING:invoice:ratecon:pod", "§4 each missing one is named");
	eq(await code({ documents: [docRow(1, "POD", "POD"), { id: 2, type: "POD", buffer: null }] }), "DOCUMENT_UNREADABLE:pod", "§4 a POD on file that can't be read stops the batch: never a page left out");
	eq(await code({ documents: [docRow(1, "POD", "POD"), { id: 2, type: "Lumper", buffer: Buffer.alloc(0) }] }), "DOCUMENT_UNREADABLE:other", "§4 so does a lumper receipt on file");
	eq(await code({ documents: [docRow(1, "POD", "POD"), { id: 2, type: "Receipt", buffer: null }] }), "ok", "§4 a document that doesn't go can't stop it");

	eq(await code({ invoicePdf: garbage }), "MERGE_FAILED:invoice", "§4 an invoice that won't merge");
	eq(await code({ documents: [{ id: 1, type: "POD", buffer: garbage }] }), "MERGE_FAILED:pod", "§4 a POD that won't merge names its kind");
	eq(await code({ documents: [{ id: 1, type: "POD", buffer: await empty() }] }), "MERGE_FAILED:pod", "§4 a POD with no pages");

	eq(await code({ debtorName: "Another Broker LLC" }), "DEBTOR_NAME_NOT_ON_DOC", "§4 the rate con doesn't print the debtor's name");
	eq(await code({ debtorName: "EXAMPLE BROKER LLC" }), "DEBTOR_NAME_NOT_ON_DOC", "§4 ...in that form");
	eq(await code({ rateCon: { buffer: await emptyTextPdf(), source: "documents" }, rateConNumber: LOAD }), "RATECON_NUMBER_MISMATCH", "§4 a rate con with no text can't say it's this load's");
	// It prints the name, and the reader can't see inside it: stopped all the same, for the true reason.
	const unread = Buffer.from(await (await PDFDocument.load(textPdf(RATECON_TEXT, { mode: "literal" }))).save({ useObjectStreams: true }));
	eq(shownText(unread), "", "§4 (fixture) the name's reader sees nothing in this rate con");
	ok(brokerInvoice.extractPdfText(unread).includes(DEBTOR), "§4 (fixture) ...though it prints the name");
	eq(await code({ rateCon: { buffer: unread, source: "documents" } }), "DEBTOR_NAME_UNREADABLE", "§4 FAILS ON THE OLD CODE: a rate con that prints the name and reads as nothing: stopped, and not for a missing name");

	eq(await code({ rateCon: { buffer: pdfOf(RATECON_TEXT), source: "drive", driveFileName: "LD-TEST-00011 rate con.pdf" } }), "RATECON_NAME_MISMATCH", "§4 the whole-number test: another load's file");
	eq(await code({ rateConNumber: "LD-TEST-0002" }), "RATECON_NUMBER_MISMATCH", "§4 ...its read gives another number");
	eq(await code({ rateCon: { buffer: pdfOf("Load Number LD-TEST-00011 Bill to Example Broker LLC"), source: "documents" } }), "RATECON_NUMBER_MISMATCH", "§4 ...its text holds only a longer number");
	eq(await code({ rateCon: { buffer: pdfOf(`Bill to ${DEBTOR}`), source: "documents" } }), "RATECON_NUMBER_MISMATCH", "§4 ...its text gives no number");
	// Each line its own show, as a rate con places its fields: the page prints the number whole,
	// and the reader runs it into the next line's first word.
	const linesPdf = async (lines) => {
		const doc = await PDFDocument.create();
		const font = await doc.embedFont(StandardFonts.Helvetica);
		const p = doc.addPage([612, 792]);
		lines.forEach((t, i) => p.drawText(t, { x: 54, y: 720 - i * 20, size: 12, font }));
		return Buffer.from(await doc.save(batchLib.SAVE_OPTIONS));
	};
	const runTogether = await linesPdf([`Bill to ${DEBTOR}`, `Load Number: ${LOAD}`, "Pickup: a made-up shipper"]);
	ok(batchLib.rateConTextOf(runTogether).includes(`${LOAD}Pickup`), "§4 (fixture) the app's readers run the number into the next line's word");
	const stopped = await batchLib.buildBatch(args({ rateCon: { buffer: runTogether, source: "documents" } }));
	eq(stopped.code, "RATECON_NUMBER_MISMATCH", "§4 a rate con that prints the number where the app can't read it whole: stopped");
	ok(/couldn't be read for this load's whole number, so nothing was sent/.test(String(stopped.error)), "§4 FAILS ON THE OLD CODE: ...for the reason that's true: the file couldn't be read for the number");
	ok((await batchLib.buildBatch(args({ rateCon: { buffer: await linesPdf([`Bill to ${DEBTOR} `, `Load Number: ${LOAD} `, "Pickup: a made-up shipper "]), source: "documents" } }))).ok,
		"§4 the same page with a space after each line builds: the stop is the reading, not the page");

	eq(await code({ debtorName: 'Example "Broker"' }), "FIELD_UNUSABLE:DTR_NAME", "§4 a field the CSV can't hold");
	eq(await code({ po: "LD 1" }), "PO_UNUSABLE:PO", "§4 a PO it can't hold");
	eq(await code({ invoiceId: "../x" }), "FIELD_UNUSABLE:INVOICE#", "§4 a number that can't name a file");
	eq(await code({ billedTotal: "$0.00" }), "FIELD_UNUSABLE:INVAMT", "§4 no amount");
	eq(await code({ denyHits: undefined }), "PROTECTED_VALUE", "§4 no deny list reader");
	eq(await code({ denyHits: createRedactor({ denyList: "99887766" }).hits, po: "LD-99887766", loadId: "LD-99887766", rateConNumber: "LD-99887766", rateCon: { buffer: pdfOf(`Load Number LD-99887766 Bill to ${DEBTOR}`), source: "documents" } }), "PROTECTED_VALUE", "§4 a deny-list hit");
	eq(await code({ debtorName: "Bad 99887766 Name", denyHits: createRedactor({ denyList: "99887766" }).hits }), "PROTECTED_VALUE", "§4 a hit in the debtor's name");

	// The 921,600 limit, at the byte.
	const built = await batchLib.buildBatch(args());
	eq(await code({ maxBytes: built.batchBytes }), "ok", "§4 a batch at its limit passes");
	const over = await batchLib.buildBatch(args({ maxBytes: built.batchBytes - 1 }));
	eq([over.ok, over.code, over.pdfBytes + over.csvBytes, over.maxBytes], [false, "BATCH_TOO_LARGE", built.batchBytes, built.batchBytes - 1], "§4 a byte over it: BATCH_TOO_LARGE, with the sizes");
	const big = textPdf("X".repeat(60000), { compress: false });
	ok(big.length > rules.BATCH_MAX_BYTES, "§4 (fixture) the made-up POD is past the limit");
	const tooBig = await batchLib.buildBatch(args({ documents: [{ id: 1, type: "POD", buffer: big }] }));
	eq([tooBig.ok, tooBig.code, tooBig.maxBytes], [false, "BATCH_TOO_LARGE", rules.BATCH_MAX_BYTES], "§4 a batch past Triumph's own limit, with no limit given");
	eq(Object.keys(over).filter((k) => ["pdf", "csv", "pdfName", "csvName"].includes(k)), [], "§4 a refusal holds no part of a batch");
}
const emptyTextPdf = async () => {
	const doc = await PDFDocument.create();
	doc.addPage([612, 792]);
	return Buffer.from(await doc.save(batchLib.SAVE_OPTIONS));
};

// ---------------------------------------------------------------- §5
async function s5() {
	section("§5 the made-up sample");
	eq(batchLib.SAMPLE.debtorName, "Example Broker LLC (SAMPLE - DO NOT FUND)", "§5 DTR_NAME");
	eq(batchLib.SAMPLE.invoiceId, "SAMPLE-0001", "§5 INVOICE#");
	eq(batchLib.SAMPLE.po, "LD-TEST-0001", "§5 PO");
	eq(batchLib.SAMPLE.stamp, "SAMPLE - NOT A REAL INVOICE - DO NOT PAY", "§5 the stamp");
	ok(Object.isFrozen(batchLib.SAMPLE), "§5 fixed");
	const at = new Date("2026-11-06T15:04:05Z");
	const render = renderSpy();
	const b = await batchLib.buildSampleBatch({ lines: LINES, day: "2026-11-06", render, at });
	ok(b.ok, "§5 it builds");
	eq(b.pdfName, "SAMPLE-0001.pdf", "§5 the PDF's name");
	eq(b.csvName, "logisx_20261106T150405Z_SAMPLE-0001.csv", "§5 the CSV's name");
	eq(b.csv.toString("utf8"), "DTR_NAME,INVOICE#,INV_DATE,PO,INVAMT\r\nExample Broker LLC (SAMPLE - DO NOT FUND),SAMPLE-0001,11/06/2026,LD-TEST-0001,1.00\r\n", "§5 the CSV: made-up values, the run's date, 1.00");
	eq(b.parts.map((p) => p.kind), ["invoice", "ratecon", "pod"], "§5 a made-up rate con page and POD page");
	eq(batchLib.unprintedFields(b.pdf, b.row), [], "§5 parity with its own PDF");
	const html = render.pages[0];
	for (const line of LINES) ok(html.includes(`>${line}<`), `§5 the real block's line prints: ${line}`);
	ok(html.includes(`>${batchLib.SAMPLE.stamp}<`), "§5 the stamp prints beside the block, in its lines");
	ok(!html.includes("Payment Method") && !html.includes(ROUTING) && !html.includes(ACCOUNT), "§5 no bank block on it");
	const texts = await pageTexts(b.pdf);
	eq(texts.length, 3, "§5 three pages");
	eq(texts.filter((t) => t.includes(batchLib.SAMPLE.stamp)).length, 3, "§5 the stamp is on each page");
	eq(texts[0].split(batchLib.SAMPLE.stamp).length - 1, 2, "§5 ...and twice on the invoice page: on the page, and beside the block");
	ok(texts[0].includes(LINES[3]), "§5 the block reaches the invoice page, its spaces kept");
	const once = await batchLib.buildBatch(args());
	ok(!shownText(once.pdf).includes(batchLib.SAMPLE.stamp), "§5 a real batch carries no stamp");

	for (const [label, lines] of [["no lines", undefined], ["three lines", LINES.slice(0, 3)], ["five lines", [...LINES, "ONE MORE"]], ["a string", NOA_SETTING]]) {
		const spy = renderSpy();
		const r = await batchLib.buildSampleBatch({ lines, day: "2026-11-06", render: spy, at });
		eq([r.ok, r.code, spy.pages.length], [false, "NOA_UNCONFIGURED", 0], `§5 ${label}: NOA_UNCONFIGURED, nothing rendered`);
	}
	// Its builder holds no load's data and reaches for nothing but the renderer.
	const src = fs.readFileSync(path.join(ROOT, "lib", "triumph-batch.js"), "utf8");
	ok(!/better-sqlite3|getSheets|googleapis|gemini|nextInvoiceNumber|ssh2|require\("(net|http|https|tls|dns)"\)/i.test(src), "§5 the builder opens no database, Drive, Gemini or connection, and mints no number");
}

// ---------------------------------------------------------------- §6
async function s6() {
	section("§6 scripts/triumph-batch-sample.js --out");
	const script = require(path.join(ROOT, "scripts", "triumph-batch-sample.js"));
	const NOW = new Date("2026-11-06T15:04:05Z");
	const refused = async (argv, opts = {}) => {
		const render = renderSpy();
		try {
			await script.run(argv, { render, env: {}, now: () => NOW, ...opts });
			return `no refusal (${render.pages.length} rendered)`;
		} catch (e) {
			if (!(e instanceof script.Refusal)) return `threw: ${e.message}`;
			return e.message;
		}
	};
	const base = tmp();
	const out = path.join(base, "out", "sample");
	const render = renderSpy();
	const r = await script.run([`--out=${out}`], { render, env: { TRIUMPH_NOA_LINES: NOA_SETTING }, now: () => NOW });
	eq(fs.readdirSync(out).sort(), ["SAMPLE-0001.pdf", "logisx_20261106T150405Z_SAMPLE-0001.csv"], "§6 by default the made-up batch: its two files and nothing else");
	eq(fs.readFileSync(path.join(out, r.csvName), "utf8"), "DTR_NAME,INVOICE#,INV_DATE,PO,INVAMT\r\nExample Broker LLC (SAMPLE - DO NOT FUND),SAMPLE-0001,11/06/2026,LD-TEST-0001,1.00\r\n", "§6 the CSV on disk");
	ok(fs.readFileSync(path.join(out, r.pdfName)).subarray(0, 5).toString() === "%PDF-", "§6 the PDF on disk");
	eq(fs.statSync(path.join(out, r.pdfName)).mode & 0o777, 0o600, "§6 files only the owner reads");
	eq(fs.statSync(out).mode & 0o777, 0o700, "§6 the folder too");
	eq(r.parts.map((p) => p.kind), ["invoice", "ratecon", "pod"], "§6 its answer names the parts");
	ok(!JSON.stringify(r).includes(LINES[0]) && !JSON.stringify(r).includes(batchLib.SAMPLE.debtorName), "§6 ...and carries no line or debtor");
	const before = fs.readFileSync(path.join(out, r.pdfName));
	ok(/already in --out/.test(await refused([`--out=${out}`], { env: { TRIUMPH_NOA_LINES: NOA_SETTING } })), "§6 a second run into the same folder refuses");
	ok(fs.readFileSync(path.join(out, r.pdfName)).equals(before), "§6 ...and overwrites nothing");

	const file = path.join(base, "noa.txt");
	fs.writeFileSync(file, `${NOA_SETTING}\n`);
	const fromFile = path.join(base, "from-file");
	const fr = await script.run([`--out=${fromFile}`, `--noa-lines-file=${file}`], { render: renderSpy(), env: {}, now: () => NOW });
	eq(fr.pdfName, "SAMPLE-0001.pdf", "§6 --noa-lines-file gives the lines");

	const none = path.join(base, "none");
	ok(/^NOA_UNCONFIGURED/.test(await refused([`--out=${none}`])), "§6 no lines: NOA_UNCONFIGURED");
	ok(!fs.existsSync(none), "§6 ...and nothing written");
	ok(/^NOA_UNCONFIGURED/.test(await refused([`--out=${none}`], { env: { TRIUMPH_NOA_LINES: LINES.slice(0, 3).join("\n") } })), "§6 three lines: refused");
	const short = path.join(base, "short.txt");
	fs.writeFileSync(short, LINES[0]);
	ok(/^NOA_UNCONFIGURED/.test(await refused([`--out=${none}`, `--noa-lines-file=${short}`])), "§6 a file of one line: refused");
	ok(/can't be read/.test(await refused([`--out=${none}`, `--noa-lines-file=${path.join(base, "missing.txt")}`])), "§6 a file that isn't there: refused");

	const repoOut = path.join(ROOT, "made-up-sample-out");
	ok(/outside this repository/.test(await refused([`--out=${repoOut}`], { env: { TRIUMPH_NOA_LINES: NOA_SETTING } })), "§6 --out inside the repo: refused");
	ok(/outside this repository/.test(await refused([`--out=${ROOT}`], { env: { TRIUMPH_NOA_LINES: NOA_SETTING } })), "§6 --out at the repo itself: refused");
	ok(!fs.existsSync(repoOut), "§6 ...and nothing made there");
	const link = path.join(base, "into-repo");
	fs.symlinkSync(ROOT, link);
	ok(/outside this repository/.test(await refused([`--out=${path.join(link, "x")}`], { env: { TRIUMPH_NOA_LINES: NOA_SETTING } })), "§6 --out through a link into the repo: refused");
	ok(/outside this repository/.test(await refused([`--out=${none}`, `--noa-lines-file=${path.join(ROOT, "package.json")}`])), "§6 --noa-lines-file in the repo: refused");

	for (const flag of ["--dry-run", "--upload", "--dry-run=1"]) {
		ok(/comes with the transport/.test(await refused([flag, `--out=${none}`])), `§6 ${flag}: refused: there is no transport here`);
		ok(/comes with the transport/.test(await refused([flag, "--load=LD-TEST-0001", "--debtor=x", `--out=${none}`])), `§6 ${flag} with --load: refused before anything is read`);
	}
	ok(/--out=<folder> is required/.test(await refused([])), "§6 no --out");
	ok(/unknown/.test(await refused(["--host=made-up.example.test", `--out=${none}`])), "§6 an argument it doesn't know");
	ok(/unknown/.test(await refused(["plain", `--out=${none}`])), "§6 a word that isn't an argument");
	for (const k of ["debtor=x", "db=/x", "sheets-json=/x", "values-json=/x", "uploads=/x", "ratecon-file=/x"]) {
		ok(/goes with --load/.test(await refused([`--${k}`, `--out=${none}`], { env: { TRIUMPH_NOA_LINES: NOA_SETTING } })), `§6 --${k.split("=")[0]} without --load: refused`);
	}
	for (const [label, argv, why] of [["no --debtor", [`--out=${none}`, "--load=LD-TEST-0001", "--db=/x", "--values-json=/x", "--uploads=/x"], /--load needs --debtor/],
		["no --db", [`--out=${none}`, "--load=LD-TEST-0001", "--debtor=x", "--values-json=/x", "--uploads=/x"], /--load needs --db/],
		["no --uploads", [`--out=${none}`, "--load=LD-TEST-0001", "--debtor=x", "--db=/x", "--values-json=/x"], /--load needs --uploads/],
		["no sheet", [`--out=${none}`, "--load=LD-TEST-0001", "--debtor=x", "--db=/x", "--uploads=/x"], /one of --sheets-json and --values-json/],
		["both sheets", [`--out=${none}`, "--load=LD-TEST-0001", "--debtor=x", "--db=/x", "--uploads=/x", "--values-json=/x", "--sheets-json=/x"], /one of --sheets-json and --values-json/]]) {
		ok(why.test(await refused(argv)), `§6 --load with ${label}: refused`);
	}

	// The whole script as it runs, in a process of its own: refusals exit 2, and the sample
	// builds with every connection refused and the database module unavailable.
	const cli = spawnSync(process.execPath, [path.join(ROOT, "scripts", "triumph-batch-sample.js"), "--upload", `--out=${none}`], { encoding: "utf8", env: { PATH: process.env.PATH } });
	eq([cli.status, /REFUSED/.test(cli.stderr)], [2, true], "§6 a refusal on the command line exits 2");
	const childFile = path.join(base, "child.js");
	const childOut = path.join(base, "child-out");
	fs.writeFileSync(childFile, `
		const Module = require("module");
		const load = Module._load;
		const asked = [];
		Module._load = function (request, parent, isMain) {
			asked.push(request);
			if (/better-sqlite3|googleapis|ssh2|nodemailer|imap/.test(request)) throw new Error("the sample reached for " + request);
			return load.call(this, request, parent, isMain);
		};
		const net = require("net");
		net.Socket.prototype.connect = function () { throw new Error("the sample tried to connect"); };
		process.env.TRIUMPH_NOA_LINES = ${JSON.stringify(NOA_SETTING)};
		const { textPdf } = require(${JSON.stringify(path.join(ROOT, "scripts", "lib", "made-up-pdf.js"))});
		const script = require(${JSON.stringify(path.join(ROOT, "scripts", "triumph-batch-sample.js"))});
		script.run([${JSON.stringify(`--out=${childOut}`)}], { render: async (html) => textPdf(html.replace(/<[^>]+>/g, " ")) }).then((r) => {
			console.log(JSON.stringify({ pdf: r.pdfName, asked: asked.filter((a) => /sqlite|googleapis|gemini/i.test(a)) }));
		}).catch((e) => { console.error(e.message); process.exit(3); });
	`);
	const child = spawnSync(process.execPath, [childFile], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: base } });
	eq([child.status, child.stderr.trim()], [0, ""], "§6 with no database module and no connection, the sample still builds");
	eq(child.status === 0 ? JSON.parse(child.stdout) : null, { pdf: "SAMPLE-0001.pdf", asked: [] }, "§6 ...it never asked for a database, Google or Gemini module");
}

// ---------------------------------------------------------------- §7
const HEADERS = ["Load ID", "Status", "Email", "Broker Contact Name", "Driver", "Delivery Date", "Completion Date", "  Payment  "];
const made = (id, status, email, day, payment = "2150") => [id, status, email, "Made-up Agent", "Made-up Driver", day, day, payment];

function replicaCopies(base) {
	const dbFile = path.join(base, "app.db");
	const uploads = path.join(base, "uploads");
	fs.mkdirSync(uploads, { recursive: true });
	const db = new Database(dbFile);
	db.exec(`
		CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, driver TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, file_name TEXT NOT NULL,
			drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_at DATETIME DEFAULT NULL);
		CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, recipient_source TEXT,
			total TEXT, broker_name TEXT, order_number TEXT, via TEXT, created_at TEXT, created_by TEXT, edited INTEGER DEFAULT 0, edited_fields TEXT DEFAULT '');
		CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME, deleted_by TEXT DEFAULT '');
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
		CREATE TABLE kpi_load_ratecon_miles (load_id TEXT PRIMARY KEY, file_size INTEGER);
	`);
	require(path.join(ROOT, "lib", "factoring-store.js")).ensureSchema(db);
	const addDoc = db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)");
	const putFile = (name, bytes) => fs.writeFileSync(path.join(uploads, name), bytes);
	const doc = (loadId, type, name, bytes, uploadedAt = "2026-10-20 10:00:00", deletedAt = null) => {
		if (bytes) putFile(name, bytes);
		addDoc.run(loadId, type, name, `/uploads/${name}`, uploadedAt, deletedAt);
	};
	return { dbFile, uploads, db, doc };
}

async function s7() {
	section("§7 --load, on a made-up replica's copies");
	const script = require(path.join(ROOT, "scripts", "triumph-batch-sample.js"));
	const base = tmp();
	const { dbFile, uploads, db, doc } = replicaCopies(base);
	const RC = (id, name = DEBTOR) => textPdf(`RATE CON (MADE UP) Load Number ${id} Bill to ${name} Total Rate: $2,150.00`, { mode: "literal" });
	doc("LD-TEST-0001", "RATECON", "rc-1.pdf", RC("LD-TEST-0001"));
	doc("LD-TEST-0001", "POD", "pod-1.pdf", textPdf("POD PAGE ONE"));
	doc("LD-TEST-0001", "BOL", "bol-1.pdf", textPdf("BOL PAGE ONE"), "2026-10-19 10:00:00");
	doc("LD-TEST-0001", "Receipt", "fuel-1.pdf", textPdf("A FUEL RECEIPT"));
	doc("LD-TEST-0001", "POD", "pod-gone.pdf", textPdf("A DELETED POD"), "2026-10-18 10:00:00", "2026-10-18 11:00:00");
	doc("#LD-TEST-0002", "RATECON", "rc-2.pdf", RC("LD-TEST-0002"));
	doc("LD-TEST-0002", "POD", "pod-2.pdf", null);
	doc("LD-TEST-0003", "RATECON", "rc-3.pdf", RC("LD-TEST-00031"));
	doc("LD-TEST-0003", "POD", "pod-3.pdf", textPdf("POD THREE"));
	doc("LD-TEST-0004", "POD", "pod-4.pdf", textPdf("POD FOUR"));
	doc("LD-TEST-0005", "RATECON", "rc-5.pdf", RC("LD-TEST-0005", "Another Broker LLC"));
	doc("LD-TEST-0005", "POD", "pod-5.pdf", textPdf("POD FIVE"));
	db.close();
	const values = path.join(base, "values.json");
	const BROKER = "ap@example-broker.test";
	fs.writeFileSync(values, JSON.stringify({ values: [HEADERS, ...[1, 2, 3, 4, 5].map((n) => made(`LD-TEST-000${n}`, "Delivered", BROKER, "10/20/2026"))] }));
	const lines = path.join(base, "noa.txt");
	fs.writeFileSync(lines, NOA_SETTING);
	const dbBefore = sha256(fs.readFileSync(dbFile));
	const NOW = new Date("2026-11-06T15:04:05Z");
	const look = async (id, name) => {
		const out = path.join(base, "looks", name);
		const render = renderSpy();
		const argv = [`--out=${out}`, `--load=${id}`, `--debtor=${DEBTOR}`, `--noa-lines-file=${lines}`, `--db=${dbFile}`, `--values-json=${values}`, `--uploads=${uploads}`];
		try {
			const r = await script.run(argv, { render, env: {}, now: () => NOW });
			return { r, out, render };
		} catch (e) {
			return { refused: e instanceof script.Refusal ? e.message : `threw: ${e.message}`, out, render };
		}
	};
	const first = await look("LD-TEST-0001", "one");
	ok(first.r, `§7 a load on the copies builds (${first.refused || ""})`);
	eq(first.r && first.r.parts.map((p) => p.kind), ["invoice", "ratecon", "bol", "pod"], "§7 its real parts, in order: no receipt, no deleted POD");
	const pdf = first.r ? fs.readFileSync(path.join(first.out, first.r.pdfName)) : Buffer.alloc(0);
	const texts = first.r ? await pageTexts(pdf) : [];
	eq(texts.filter((t) => t.includes(batchLib.SAMPLE.stamp)).length, 4, "§7 the stamp is on each page, so it can't pass for a real invoice");
	eq(first.r && first.r.pdfName, "SAMPLE-0001.pdf", "§7 and it carries the sample's number: none was minted");
	const csv = first.r ? fs.readFileSync(path.join(first.out, first.r.csvName), "utf8") : "";
	eq(csv.split("\r\n")[1], `${DEBTOR},SAMPLE-0001,11/06/2026,LD-TEST-0001,2150.00`, "§7 the CSV: --debtor, the load and the rate con's total");
	ok(first.render.pages[0] && first.render.pages[0].includes(`>${LINES[0]}<`) && !first.render.pages[0].includes("Payment Method"), "§7 the block on the invoice page");
	eq((await look("LD-TEST-0002", "two")).refused, "DOCUMENT_UNREADABLE (pod)", "§7 a POD on file with no bytes; either spelling of the load's ID finds its rows");
	ok(/^RATECON_NUMBER_MISMATCH: .*couldn't be read for this load's whole number/.test(String((await look("LD-TEST-0003", "three")).refused)), "§7 FAILS ON THE OLD CODE: the whole-number test on the rate con's text: the code, and the true reason");
	eq((await look("LD-TEST-0004", "four")).refused, "DOCUMENT_MISSING (ratecon)", "§7 no rate con");
	ok(/^DEBTOR_NAME_NOT_ON_DOC: .*the text the app can read/.test(String((await look("LD-TEST-0005", "five")).refused)), "§7 FAILS ON THE OLD CODE: the rate con prints another name: the code, and what it means");
	eq((await look("LD-TEST-0099", "nine")).refused, "LOAD_NOT_ON_SHEET", "§7 a load the sheet doesn't hold");
	eq(sha256(fs.readFileSync(dbFile)), dbBefore, "§7 the database file is byte for byte as it was");
	const withFile = path.join(base, "looks", "file");
	const rcFile = path.join(base, "1234 unrelated.pdf");
	fs.writeFileSync(rcFile, RC("LD-TEST-0004"));
	const named = async (file) => {
		try {
			const r = await script.run([`--out=${withFile}`, "--load=LD-TEST-0004", `--debtor=${DEBTOR}`, `--noa-lines-file=${lines}`, `--db=${dbFile}`, `--values-json=${values}`, `--uploads=${uploads}`, `--ratecon-file=${file}`],
				{ render: renderSpy(), env: {}, now: () => NOW });
			return r.pdfName;
		} catch (e) {
			return e.message;
		}
	};
	eq(await named(rcFile), "RATECON_NAME_MISMATCH", "§7 --ratecon-file must carry the load's number in its name");
	const rcNamed = path.join(base, "LD-TEST-0004 rate con.pdf");
	fs.writeFileSync(rcNamed, RC("LD-TEST-0004"));
	eq(await named(rcNamed), "SAMPLE-0001.pdf", "§7 ...and then it stands in for a rate con held on Drive");
}

// ---------------------------------------------------------------- §8
async function s8() {
	section("§8 the two reports");
	const sizeReport = require(path.join(ROOT, "scripts", "triumph-batch-size-report.js"));
	const change = require(path.join(ROOT, "scripts", "triumph-what-would-change.js"));
	const base = tmp();
	const { dbFile, uploads, db, doc } = replicaCopies(base);
	const bytes = (n) => Buffer.alloc(n, 0x20);
	doc("LD-TEST-0001", "POD", "pod-1a.pdf", bytes(100000));
	doc("LD-TEST-0001", "POD", "pod-1b.pdf", bytes(50000));
	doc("LD-TEST-0001", "Lumper", "lumper-1.pdf", bytes(25000));
	doc("LD-TEST-0002", "BOL", "bol-2.pdf", bytes(800000));
	doc("LD-TEST-0003", "POD", "pod-3-missing.pdf", null);
	doc("LD-TEST-0004", "Receipt", "receipt-4.pdf", bytes(5000));
	doc("LD-TEST-0005", "Lumper", "lumper-5.pdf", bytes(5000));
	doc("LD-TEST-0006", "POD", "pod-6.pdf", bytes(10000), "2026-10-20 10:00:00", "2026-10-21 10:00:00");
	doc("LD-TEST-0007", "POD", "pod-7.pdf", bytes(1000));
	doc("LD-TEST-0008", "POD", "pod-8.pdf", bytes(1000));
	doc("LD-TEST-0009", "POD", "pod-9.pdf", bytes(1000));
	db.prepare("INSERT INTO kpi_load_ratecon_miles (load_id, file_size) VALUES (?, ?)").run("ld-test-0001", 80000);
	db.prepare("INSERT INTO kpi_load_ratecon_miles (load_id, file_size) VALUES (?, ?)").run("ld-test-0002", 90000);
	const draft = db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via, created_at) VALUES (?, ?, ?, ?)");
	draft.run("LD-TEST-0001", "10202026-1", "imap", "2026-10-20T15:00:00Z");
	draft.run("LD-TEST-0007", "10202026-2", "auto-smtp", "2026-10-20T15:00:00Z");
	db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?)").run(JSON.stringify({ optOutDomains: [], confirmedBrokerDomains: ["example-broker.test"] }));
	db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES (?, ?, 1, 'script', ?, ?)").run("ld-test-0008", "LD-TEST-0008", "2026-10-20T15:00:00Z", "2026-10-20T15:00:00Z");
	db.close();
	const dbBefore = sha256(fs.readFileSync(dbFile));

	const size = sizeReport.run([`--db=${dbFile}`, `--uploads=${uploads}`]).out;
	const I = 150000 + 300;
	eq(size.loads, 6, "§8 size: the loads with a live POD or BOL");
	eq(size.max, 800000 + 90000 + I, "§8 size: the largest: its BOL, its rate con and the estimates");
	eq(size.atOrOverLimit, 1, "§8 size: one at or over the limit");
	eq(size.atOrOverNearLimit, 1, "§8 size: one at or over 800,000");
	eq(size.missingFiles, 1, "§8 size: a file missing on disk is counted");
	eq(size.rateConsStoodIn, 4, "§8 size: rate cons stood in are counted");
	const firstLoad = 100000 + 50000 + 25000 + 80000 + I;
	const standIn = 89242 + I;
	const expected = [standIn, standIn + 1000, standIn + 1000, standIn + 1000, firstLoad, 800000 + 90000 + I];
	eq([size.p50, size.p90, size.p95], [expected[3], expected[5], expected[5]], "§8 size: the percentiles, by nearest rank");
	eq(sizeReport.distribution([]), { loads: 0, p50: null, p90: null, p95: null, max: null, atOrOverLimit: 0, atOrOverNearLimit: 0 }, "§8 size: no loads");
	const sizeJson = JSON.stringify(size);
	ok(!/LD-TEST|\.pdf|Made-up/.test(sizeJson), "§8 size: no load ID, file name or person in its answer");

	const HEAD = [HEADERS, made("LD-TEST-0001", "Delivered", "ap@example-broker.test", "10/20/2026"), made("LD-TEST-0002", "Delivered", "ap@example-broker.test", "10/21/2026"),
		made("LD-TEST-0003", "Delivered", "ap@example-broker.test", "10/22/2026"), made("LD-TEST-0005", "Delivered", "ap@other-broker.test", "10/23/2026"),
		made("LD-TEST-0007", "Delivered", "ap@example-broker.test", "10/24/2026"), made("LD-TEST-0008", "Delivered", "ap@other-broker.test", "10/25/2026"),
		made("LD-TEST-0009", "In Transit", "ap@example-broker.test", ""), made("LD-TEST-0011", "Delivered", "ap@example-broker.test", "07/01/2026"),
		made("LD-TEST-0012", "Delivered", "ap@example-broker.test", "")];
	const values = path.join(base, "values.json");
	fs.writeFileSync(values, JSON.stringify({ values: HEAD }));
	const report = (extra) => change.run([`--db=${dbFile}`, `--values-json=${values}`, `--uploads=${uploads}`, "--since=2026-10-01", "--until=2026-10-31", ...extra]).out;
	const byDomain = report(["--domains=example-broker.test"]);
	const tidy = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
	eq(byDomain.covered, 4, "§8 change: the loads on the domain, delivered in the window");
	eq(byDomain.dateUnknown, 1, "§8 change: a load with no delivered day is counted on its own");
	eq(byDomain.drafted, { button: 1, job: 1, none: 2 }, "§8 change: what the button and the job drafted, which would stop being emailed");
	eq(byDomain.perDomain, { "example-broker.test": 4 }, "§8 change: per domain");
	eq(tidy(byDomain.asItStands), tidy({ "needs_attention ALREADY_INVOICED": 2, "needs_attention POD_UNREADABLE": 1, "waiting WAITING_POD": 1 }), "§8 change: the free checks as things stand");
	eq(tidy(byDomain.ifSetUp), tidy({ queued: 2, "needs_attention POD_UNREADABLE": 1, "waiting WAITING_POD": 1 }), "§8 change: as if factored from the start and set up");
	eq([byDomain.sizes.loads, byDomain.sizes.atOrOverLimit], [4, 1], "§8 change: the sizes of the loads covered");
	const marked = report(["--marked"]);
	eq([marked.covered, marked.perDomain], [1, { "other-broker.test": 1 }], "§8 change: --marked covers the loads marked factored");
	const noUploads = change.run([`--db=${dbFile}`, `--values-json=${values}`, "--domains=example-broker.test", "--since=2026-10-01", "--until=2026-10-31"]).out;
	eq(noUploads.sizes, null, "§8 change: no --uploads: no sizes");
	ok(/not measured/.test(noUploads.text), "§8 change: ...and it says so");
	const text = JSON.stringify(byDomain);
	ok(!/LD-TEST|ld-test|\.pdf|Made-up|ap@|2150/.test(text), "§8 change: no load ID, file, person, address or amount in its answer");
	for (const [label, argv, why] of [["neither", [`--db=${dbFile}`, `--values-json=${values}`], /exactly one of --domains and --marked/],
		["both", [`--db=${dbFile}`, `--values-json=${values}`, "--marked", "--domains=example-broker.test"], /exactly one of --domains and --marked/],
		["a bad domain", [`--db=${dbFile}`, `--values-json=${values}`, "--domains=not a domain"], /--domains takes/],
		["no database", [`--values-json=${values}`, "--marked"], /--db=<app.db> is required/],
		["a database that isn't there", [`--db=${path.join(base, "none.db")}`, `--values-json=${values}`, "--marked"], /cannot open the database read-only/]]) {
		let msg = "no refusal";
		try {
			change.run(argv);
		} catch (e) {
			msg = e.refused ? e.message : `threw: ${e.message}`;
		}
		ok(why.test(msg), `§8 change: ${label}: refused (${msg})`);
	}
	ok(!fs.existsSync(path.join(base, "none.db")), "§8 a missing database isn't created");
	for (const [label, argv, why] of [["no database", [`--uploads=${uploads}`], /--db=<app.db> is required/], ["no uploads", [`--db=${dbFile}`], /--uploads=<uploads folder> is required/], ["an unknown argument", ["--load=x"], /unknown argument/]]) {
		let msg = "no refusal";
		try {
			sizeReport.run(argv);
		} catch (e) {
			msg = e.refused ? e.message : `threw: ${e.message}`;
		}
		ok(why.test(msg), `§8 size: ${label}: refused (${msg})`);
	}
	eq(sha256(fs.readFileSync(dbFile)), dbBefore, "§8 both reports leave the database byte for byte as it was");
}

(async () => {
	for (const s of [s3, s4, s5, s6, s7, s8]) await s();
})().catch((e) => failures.push(`the run threw: ${e && e.stack}`)).then(() => {
	console.log(`\n${pass} passed, ${failures.length} failed`);
	for (const f of failures) console.log(`FAIL  ${f}`);
	process.exit(failures.length ? 1 : 0);
});
