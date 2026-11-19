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
//   §9 advance lines (TRIUMPH_ADVANCE_LINES_ENABLED, PR B1): a factored invoice with a
//      made-up $500.00 advance prints Triumph's block, the advance, LESS ADVANCES and the
//      balance due; its batch's INVAMT is that balance, in the merged PDF's text; --load on
//      a load with a line stops (ADVANCE_LINES) with the switches off, and with them on
//      prints the line and bills the balance, under the automatic invoice's own checks
//   §10 each identical BOL or POD once (TRIUMPH_BATCH_DEDUPE_ENABLED, way 2): on, a BOL or
//      POD identical byte for byte to one before it in the batch goes in once, the first
//      kept and each copy left out recorded; a file a byte apart, a lumper, scale or pallet
//      row and the rate con always go; off, every row goes as before; the missing and
//      unreadable checks and the size limit answer as they did
//   §11 way 1 (TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED): on, a batch over the limit re-compresses
//      the whitelisted JPEG photos on its BOL and POD pages at the same pixel size, 70, 60, then 50,
//      and takes the first step that fits, with its record; at the floor it stops at
//      BATCH_TOO_LARGE with the floor's record; every other image, part and page goes byte for
//      byte; a copy that isn't smaller, a child error or a child past its deadline leaves its
//      image; the skip rule, the 40-photo cap and the 5-minute budget stop it as today; off, or
//      under the limit, the batch is byte for byte the base's (221ff323)
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
	.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
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

	// --dry-run and --upload (PR T2) send the made-up batch alone: a load, a folder or a file of
	// one is refused before anything is read (scripts/test-triumph-job.js runs both).
	for (const flag of ["--dry-run", "--upload"]) {
		ok(/sends only the made-up batch, so --out is refused/.test(await refused([flag, `--out=${none}`])), `§6 ${flag} with --out: refused: it writes no file here`);
		ok(/sends only the made-up batch, so --load is refused/.test(await refused([flag, "--load=LD-TEST-0001", "--debtor=x", `--out=${none}`])), `§6 ${flag} with --load: refused before anything is read`);
	}
	ok(/takes no value/.test(await refused(["--dry-run=1"])), "§6 --dry-run=1: refused");
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

// ---------------------------------------------------------------- §9
async function s9() {
	section("§9 advance lines on a factored invoice");
	// The figures the engine resolves for one made-up $500.00 advance on a $2,150.00 load.
	const ADVANCED = Object.freeze({
		lineHaulCents: 215000, advancesCents: 50000, balanceCents: 165000, lineHaulSource: "ratecon",
		items: [{ id: 1, kind: "advance", label: "Fuel advance", amountCents: 50000, receivedOn: "2026-11-02", reference: "" }],
		footnote: "*$500 for fuel advance", footnoteDefault: "*$500 for fuel advance",
	});
	const html = triumphInvoice.withAssignment(page({ invoiceLines: ADVANCED }), { lines: LINES });
	ok(LINES.every((l) => html.includes(`>${l}</div>`)) && !html.includes("Payment Method") && !html.includes(ROUTING) && !html.includes(ACCOUNT),
		"§9 Triumph's block in place of the bank block, with an advance on the invoice too");
	ok(html.includes('<div class="item-title">Fuel advance</div>') && html.includes('<div class="subtotal"><span>LESS ADVANCES</span><span class="amt">-$500.00</span></div>')
		&& html.includes('<div class="pill"><span class="lbl">Balance due*</span><span class="amt">$1,650.00</span></div>'), "§9 ...the advance, LESS ADVANCES and the balance due print");
	const render = renderSpy();
	const b = await batchLib.buildBatch(args({ invoicePdf: await render(html), billedTotal: "$1,650.00" }));
	eq([b.ok, b.row && b.row.INVAMT], [true, "1650.00"], "§9 INVAMT is the balance due the invoice prints");
	eq(b.ok ? batchLib.unprintedFields(b.pdf, b.row) : null, [], "§9 ...and the merged PDF's text shows it, with the invoice number, date and PO");
	eq(b.ok && b.parts.map((p) => p.kind), ["invoice", "ratecon", "bol", "pod", "pod"], "§9 ...the invoice, the rate con, then the BOL and the PODs, as for any batch");

	// --load on a made-up replica copy whose load has an advance line.
	const script = require(path.join(ROOT, "scripts", "triumph-batch-sample.js"));
	const LINES_LIB = brokerInvoice.invoiceLines;
	const base = tmp();
	const { dbFile, uploads, db, doc } = replicaCopies(base);
	LINES_LIB.ensureSchema(db);
	const RC = (id) => textPdf(`RATE CON (MADE UP) Load Number ${id} Bill to ${DEBTOR} Total Rate: $2,150.00`, { mode: "literal" });
	const ids = ["LD-TEST-0901", "LD-TEST-0902", "LD-TEST-0903", "LD-TEST-0904"];
	for (const id of ids) {
		doc(id, "RATECON", `rc-${id}.pdf`, RC(id));
		doc(id, "POD", `pod-${id}.pdf`, textPdf(`POD OF ${id}`));
	}
	const add = (loadId, over = {}) => LINES_LIB.addLine(db, { loadId, values: { kind: "advance", label: "Fuel advance", amountCents: 50000, receivedOn: "2026-11-02", reference: "", note: "", ...over },
		actor: "made-up-admin", closedMonths: [] }, {});
	add("LD-TEST-0901");
	add("LD-TEST-0902", { label: "Fuel advance to Pat Example" });
	add("LD-TEST-0903", { amountCents: 215000 });
	db.close();
	const values = path.join(base, "values.json");
	fs.writeFileSync(values, JSON.stringify({ values: [HEADERS, ...ids.map((id) => made(id, "Delivered", "ap@example-broker.test", "11/02/2026"))] }));
	const noa = path.join(base, "noa.txt");
	fs.writeFileSync(noa, NOA_SETTING);
	const dbBefore = sha256(fs.readFileSync(dbFile));
	const ON = { TRIUMPH_ADVANCE_LINES_ENABLED: "true", AUTO_INVOICE_ADVANCE_LINES_ENABLED: "true" };
	const look = async (id, env, name) => {
		const out = path.join(base, "looks", name);
		const spy = renderSpy();
		try {
			const r = await script.run([`--out=${out}`, `--load=${id}`, `--debtor=${DEBTOR}`, `--noa-lines-file=${noa}`, `--db=${dbFile}`, `--values-json=${values}`, `--uploads=${uploads}`],
				{ render: spy, env, now: () => new Date("2026-11-06T15:04:05Z") });
			return { r, csv: fs.readFileSync(path.join(out, r.csvName), "utf8").split("\r\n")[1], page: spy.pages[0] || "" };
		} catch (e) {
			return { refused: e instanceof script.Refusal ? e.message : `threw: ${e.message}` };
		}
	};
	eq((await look("LD-TEST-0901", {}, "off")).refused, "ADVANCE_LINES", "§9 FAILS ON THE OLD CODE: --load, a load with an advance line, the switches off: stopped as the submit job stops it");
	eq((await look("LD-TEST-0901", { TRIUMPH_ADVANCE_LINES_ENABLED: "true" }, "half")).refused, "ADVANCE_LINES", "§9 FAILS ON THE OLD CODE: ...and with Triumph's switch alone");
	const on = await look("LD-TEST-0901", ON, "on");
	eq(on.csv, `${DEBTOR},SAMPLE-0001,11/06/2026,LD-TEST-0901,1650.00`, `§9 FAILS ON THE OLD CODE: on, INVAMT is the balance due: $2,150.00 less the $500.00 advance (${on.refused || ""})`);
	ok(on.page.includes('<span class="lbl">Balance due*</span><span class="amt">$1,650.00</span>') && on.page.includes("LESS ADVANCES") && on.page.includes(`>${LINES[0]}<`),
		"§9 FAILS ON THE OLD CODE: ...its invoice page prints the advance, the balance due and Triumph's block");
	eq((await look("LD-TEST-0902", ON, "typed")).refused, "ADVANCE_LINE_TEXT", "§9 FAILS ON THE OLD CODE: a line with a typed label: ADVANCE_LINE_TEXT, as the automatic invoice refuses it");
	eq((await look("LD-TEST-0903", ON, "none-left")).refused, "ADVANCE_LINES_INVALID", "§9 FAILS ON THE OLD CODE: advances that leave no balance: ADVANCE_LINES_INVALID");
	const plain = await look("LD-TEST-0904", ON, "plain");
	eq(plain.csv, `${DEBTOR},SAMPLE-0001,11/06/2026,LD-TEST-0904,2150.00`, "§9 a load with no line: the batch as before, whatever the switches say");
	ok(!plain.page.includes("LESS ADVANCES"), "§9 ...and no advance on its page");
	eq(sha256(fs.readFileSync(dbFile)), dbBefore, "§9 the database file is byte for byte as it was");
}

// ---------------------------------------------------------------- §10
async function s10() {
	section("§10 each identical BOL or POD once (TRIUMPH_BATCH_DEDUPE_ENABLED)");
	const ON = Object.freeze({ dedupe: true });
	const at = (h) => `2026-11-02 ${String(h).padStart(2, "0")}:00:00`;
	const row = (id, type, buffer, h, file_name = `made-up-${id}.pdf`) => ({ id, type, uploaded_at: at(h), file_name, buffer });
	const kinds = (b) => (b.ok ? b.parts.map((p) => p.kind) : [b.code, ...[].concat(b.kinds || b.kind || [])].join(":"));
	// A throw reads as the job reads one (lib/triumph-job.js: MERGE_FAILED).
	const build = (over) => batchLib.buildBatch(args(over)).catch(() => ({ ok: false, code: "MERGE_FAILED" }));
	const copy = (b) => Buffer.from(b);
	const SAME = pdfOf("PROOF OF DELIVERY (MADE UP), ONE FILE STORED TWICE");

	// These need the new behaviour or its record, so each fails on the old code.
	const twice = await build({ ...ON, documents: [row(1, "POD", SAME, 10), row(2, "POD", copy(SAME), 11), docRow(3, "BOL", "BOL PAGE", at(12))] });
	eq(kinds(twice), ["invoice", "ratecon", "bol", "pod"], "§10 FAILS ON THE OLD CODE: two identical POD rows go in once");
	eq(twice.dropped, [{ kind: "pod", sha256: sha256(SAME), bytes: SAME.length, keptAs: "pod" }],
		"§10 FAILS ON THE OLD CODE: ...and the copy left out is recorded: its kind, hash and bytes, and the kind of the copy kept");
	eq(twice.ok ? (await PDFDocument.load(twice.pdf)).getPageCount() : 0, 4, "§10 FAILS ON THE OLD CODE: ...four pages in all");
	eq(twice.ok ? batchLib.unprintedFields(twice.pdf, twice.row) : null, [], "§10 ...and the merged PDF still prints the CSV's values");
	const thrice = await build({ ...ON, documents: [1, 2, 3].map((i) => row(i, "POD", copy(SAME), 9 + i)) });
	eq([kinds(thrice), (thrice.dropped || []).map((d) => d.keptAs)], [["invoice", "ratecon", "pod"], ["pod", "pod"]],
		"§10 FAILS ON THE OLD CODE: three identical POD rows: one goes, and one entry for each copy left out");
	const both = await build({ ...ON, documents: [row(1, "POD", SAME, 9), row(2, "BOL", copy(SAME), 12)] });
	eq(kinds(both), ["invoice", "ratecon", "bol"], "§10 FAILS ON THE OLD CODE: one file filed as a BOL and as a POD goes in once, as the BOL, which comes first in the batch");
	eq(both.dropped, [{ kind: "pod", sha256: sha256(SAME), bytes: SAME.length, keptAs: "bol" }], "§10 FAILS ON THE OLD CODE: ...the POD's copy recorded, kept as the BOL");
	const BIG = textPdf("X".repeat(24000), { compress: false });
	const bigRows = [row(1, "POD", BIG, 10), row(2, "POD", copy(BIG), 11)];
	eq(kinds(await build({ documents: bigRows })), "BATCH_TOO_LARGE", "§10 (fixture) a made-up POD stored twice: with both copies the batch is past Triumph's limit");
	const fits = await build({ ...ON, documents: bigRows });
	eq([kinds(fits), fits.batchBytes <= rules.BATCH_MAX_BYTES], [["invoice", "ratecon", "pod"], true], "§10 FAILS ON THE OLD CODE: a batch over the limit only because of a duplicate goes, with the switch on");

	// These pass on the old code by design: each pins a mutant.
	const A = textPdf("PROOF OF DELIVERY 1 (MADE UP)", { mode: "literal", compress: false });
	const B = textPdf("PROOF OF DELIVERY 2 (MADE UP)", { mode: "literal", compress: false });
	eq([A.length, A.filter((byte, i) => byte !== B[i]).length], [B.length, 1], "§10 (fixture) two made-up POD files of the same size, one byte apart");
	eq(kinds(await build({ ...ON, documents: [row(1, "POD", A, 10, "pod.pdf"), row(2, "POD", B, 11, "pod.pdf")] })), ["invoice", "ratecon", "pod", "pod"],
		"§10 two POD rows of the same size and name, one byte apart: both go in (mutant: matching by size or name)");
	const LUMPER = pdfOf("LUMPER RECEIPT (MADE UP)");
	eq(kinds(await build({ ...ON, documents: [row(1, "POD", SAME, 9), row(2, "Lumper", LUMPER, 10), row(3, "Lumper", copy(LUMPER), 11), row(4, "Lumper Receipt", copy(SAME), 12)] })),
		["invoice", "ratecon", "pod", "other", "other", "other"], "§10 an identical lumper pair both go in, and so does a lumper row identical to a POD (mutant: \"other\" deduped)");
	eq(kinds(await build({ ...ON, documents: [row(1, "BOL", copy(args().rateCon.buffer), 9), row(2, "POD", SAME, 10)] })), ["invoice", "ratecon", "bol", "pod"],
		"§10 a BOL identical to the rate con still goes in: the invoice and the rate con are never matched (mutant: the rate con deduped)");
	const OLD_KEYS = ["batchBytes", "csv", "csvName", "csvSha256", "ok", "parts", "pdf", "pdfName", "pdfSha256", "row"];
	const offs = [];
	for (const dedupe of [undefined, false, "true", 1]) {
		const r = await build({ dedupe, documents: [row(1, "POD", SAME, 10), row(2, "POD", copy(SAME), 11)] });
		offs.push([kinds(r), Object.keys(r).sort()]);
	}
	eq(offs, Array(4).fill([["invoice", "ratecon", "pod", "pod"], OLD_KEYS]),
		"§10 with the switch off (no option, false, or anything but true), every row goes in and the answer is the one it always was (mutant: the dedupe on with the switch off)");
	eq(kinds(await build({ ...ON, documents: [row(1, "POD", SAME, 9), row(2, "POD", copy(SAME), 10), row(3, "POD", null, 11)] })), "DOCUMENT_UNREADABLE:pod",
		"§10 an unreadable row beside identical copies still stops the batch at DOCUMENT_UNREADABLE (mutant: the dedupe before the unreadable check)");
	eq(kinds(await build({ ...ON, documents: [row(1, "Lumper", null, 9)] })), "DOCUMENT_MISSING:pod",
		"§10 no BOL or POD and an unreadable lumper receipt: DOCUMENT_MISSING (pod) still answers first (mutant: the missing check moved below the dedupe)");
	const lowered = await build({ ...ON, maxBytes: 300000, documents: bigRows });
	eq([lowered.code, lowered.maxBytes], ["BATCH_TOO_LARGE", 300000],
		"§10 with TRIUMPH_BATCH_MAX_BYTES lowered, a deduped batch over the lowered limit stops at BATCH_TOO_LARGE (mutant: the limit skipped after the dedupe)");
	eq((lowered.dropped || []).length, 1, "§10 FAILS ON THE OLD CODE: ...and the stop says how many copies it left out, for the practice run to print");
}

// ---------------------------------------------------------------- §11
// The made-up photos are written byte by byte (scripts/lib/made-up-jpeg.js), so the fit cases prove
// the mechanism only: how far jimp's writer shrinks ScanKit's own pages is Part A's to measure (M1).
const recompressLib = optional(path.join(ROOT, "lib", "triumph-batch-recompress.js"));
const jpegs = require(path.join(ROOT, "scripts", "lib", "made-up-jpeg.js"));
// The batch with the clock held still, so the merged PDF's own dates are the same on every run.
async function frozen(fn) {
	const Real = Date;
	const FIXED = Real.parse("2026-11-02T15:04:05Z");
	global.Date = class extends Real {
		constructor(...a) { super(...(a.length ? a : [FIXED])); }
		static now() { return FIXED; }
	};
	try {
		return await fn();
	} finally {
		global.Date = Real;
	}
}
// The base's (221ff323) batch and stop for §11's two camera photos, with the switch off: the PDF's and
// the CSV's sha256 and the batch's bytes, and the stop over a limit 1,000 bytes under it.
const GOLDEN_OFF = Object.freeze({
	batch: ["c716edf0cc60f8b52308efa3b0809da06537a14823a265d798eb97337da4e5e1", "e07c21ed853682b95279dfcc96ef1f7eaaf9c6f2d8a1b20b4683a68ec3a2c94e", 786290],
	stop: JSON.stringify({ ok: false, code: "BATCH_TOO_LARGE", pdfBytes: 786189, csvBytes: 101, maxBytes: 785290 }),
});
async function s11() {
	section("§11 way 1: a batch over the limit re-compresses its POD and BOL photos (TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED)");
	const ON = Object.freeze({ recompress: true });
	const W = 820;
	const H = 620;
	const PHOTO_A = jpegs.jpeg({ seed: 1 });
	const PHOTO_B = jpegs.jpeg({ seed: 2 });
	// A near-blank page: half a megapixel in few bytes, which a step would still shrink (N1).
	const blank = (seed, over = {}) => jpegs.jpeg({ blank: true, quality: 90, seed, ...over });
	const photo = (bytes, over = {}) => ({ bytes, width: W, height: H, ...over });
	const page = (images, text = ["PROOF OF DELIVERY (MADE UP)"]) => ({ text, images });
	const row = async (id, pages, type = "POD") => ({ id, type, uploaded_at: `2026-11-02 1${id}:00:00`, file_name: `made-up-${id}.pdf`, buffer: await jpegs.imagePdf(pages) });
	// Text PDFs written plainly, so no byte of the batch below depends on zlib.
	const plainArgs = { invoicePdf: textPdf(INVOICE_TEXT, { compress: false }), rateCon: { buffer: textPdf(RATECON_TEXT, { compress: false }), source: "documents" } };
	const build = (over) => batchLib.buildBatch(args({ ...plainArgs, ...over })).catch((e) => ({ ok: false, code: "THREW", error: String(e && e.message) }));
	const total = (b) => (b.ok ? b.batchBytes : b.pdfBytes + b.csvBytes);
	const imagesOf = async (b) => (b.ok ? jpegs.imagesIn(b.pdf) : []);
	const sameBytes = (found, bytes) => found.some((f) => f.bytes.equals(bytes));
	const recordOf = (b, kind = "pod") => (b.ok ? ((b.parts || []).find((p) => p.kind === kind) || {}).recompressed : undefined);
	const lib = recompressLib || {};

	// These need the new behaviour or its record, so each fails on the old code.
	const two = [await row(1, [page([photo(PHOTO_A), photo(PHOTO_B)])])];
	const base = await build({ documents: two });
	ok(base.ok && base.batchBytes < rules.BATCH_MAX_BYTES, "§11 (fixture) a made-up POD of two camera photos (820 x 620, quality 95): as built today, under Triumph's own limit");
	const T0 = total(base);
	const uploaded = await jpegs.imagesIn(two[0].buffer);
	const photoBytes = uploaded.reduce((s, im) => s + im.bytes.length, 0);
	const fit = await build({ ...ON, documents: two, maxBytes: T0 - 1000 });
	eq([fit.ok, fit.code], [true, undefined], "§11 FAILS ON THE OLD CODE: a batch over the limit only by its photos fits at a step (the mechanism only; Part A measures the real pages, M1)");
	const rec = recordOf(fit);
	eq(rec && [rec.quality, rec.images, rec.left, rec.bytesBefore, rec.sourceSha256], [70, 2, 0, two[0].buffer.length, sha256(two[0].buffer)],
		"§11 FAILS ON THE OLD CODE: ...at the first step, 70: the POD's record names the step, its two photos, none left, and the part's own bytes and hash as uploaded");
	const sentPod = fit.ok ? fit.parts.find((p) => p.kind === "pod") : null;
	ok(rec && sentPod && rec.bytesAfter === sentPod.bytes && sentPod.sha256 !== rec.sourceSha256 && rec.bytesAfter < rec.bytesBefore, "§11 FAILS ON THE OLD CODE: ...the part sent: its own bytes and hash, smaller than the upload");
	ok(fit.ok && fit.batchBytes <= T0 - 1000 && fit.pdf.length + fit.csv.length === fit.batchBytes, "§11 FAILS ON THE OLD CODE: ...within the lowered limit");
	const fitImages = (await imagesOf(fit)).filter((f) => f.pages.includes(2));
	for (const im of uploaded) {
		const now = fitImages.find((f) => f.name === im.name);
		const frame = now ? jpegs.frameOf(now.bytes) : null;
		eq(now && [now.width, now.height, frame && frame.marker, frame && frame.width, frame && frame.height, frame && frame.components], [W, H, 0xc0, W, H, 3],
			`§11 FAILS ON THE OLD CODE: photo ${uploaded.indexOf(im) + 1}: the same pixel size, in its dictionary and in the new baseline JPEG's frame`);
		ok(now && now.bytes.length < im.bytes.length, `§11 FAILS ON THE OLD CODE: photo ${uploaded.indexOf(im) + 1}: a smaller stream`);
	}
	eq(fit.ok && fit.parts.map((p) => [p.kind, p.pages]), base.parts.map((p) => [p.kind, p.pages]), "§11 FAILS ON THE OLD CODE: the page count of each part is unchanged (L2)");
	eq(fit.ok && fit.parts.filter((p) => p.kind !== "pod").map((p) => [p.kind, p.sha256, "recompressed" in p]), base.parts.filter((p) => p.kind !== "pod").map((p) => [p.kind, p.sha256, false]),
		"§11 FAILS ON THE OLD CODE: ...and the invoice and the rate con go as they came, with no record");

	// At the floor and still over: over by less than the photos' bytes, so the steps run.
	const floorLimit = T0 - photoBytes + 1000;
	const floor = await build({ ...ON, documents: two, maxBytes: floorLimit });
	eq([floor.ok, floor.code, floor.floorReached], [false, "BATCH_TOO_LARGE", true], "§11 FAILS ON THE OLD CODE: a batch still over at 50, the floor, stops at BATCH_TOO_LARGE and says the floor was reached");
	eq((floor.recompressed || []).map((r) => [r.kind, r.quality, r.images, r.left, r.bytesBefore, r.sourceSha256]), [["pod", 50, 2, 0, two[0].buffer.length, sha256(two[0].buffer)]],
		"§11 FAILS ON THE OLD CODE: ...with the floor's record: the POD's two photos at 50");
	ok(floor.pdfBytes + floor.csvBytes > floorLimit && floor.pdfBytes < base.pdf.length, "§11 FAILS ON THE OLD CODE: ...its sizes are the floor's merge, still over the limit");
	eq(Object.keys(floor).filter((k) => ["pdf", "csv", "pdfName", "csvName", "parts"].includes(k)), [], "§11 ...and the stop holds no part of a batch");

	// /DeviceGray goes under /DeviceRGB (P3).
	const GRAY = jpegs.jpeg({ components: 1, seed: 3 });
	const gray = [await row(1, [page([photo(GRAY, { colorSpace: "DeviceGray" })])])];
	const g0 = total(await build({ documents: gray }));
	const g = await build({ ...ON, documents: gray, maxBytes: g0 - 1000 });
	const gi = (await imagesOf(g)).find((f) => f.pages.includes(2));
	const gf = gi ? jpegs.frameOf(gi.bytes) : null;
	eq([g.ok, gi && gi.colorSpace, gf && gf.components, gi && gi.width, gi && gi.height, gi && gi.bytes.length < GRAY.length], [true, "DeviceRGB", 3, W, H, true],
		"§11 FAILS ON THE OLD CODE: a /DeviceGray JPEG is re-compressed under /DeviceRGB: jimp writes three channels, which draw the same grey (P3)");

	// One image drawn on two pages.
	const shared = [await row(1, [page([photo(PHOTO_A, { share: "one" })]), page([photo(PHOTO_A, { share: "one" })], ["PROOF OF DELIVERY, PAGE 2 (MADE UP)"])])];
	const s0 = await build({ documents: shared });
	const s = await build({ ...ON, documents: shared, maxBytes: total(s0) - 1000 });
	const onPod = (await imagesOf(s)).filter((f) => f.pages.some((p) => p >= 2));
	eq([s.ok, onPod.length, onPod[0] && onPod[0].pages, recordOf(s) && recordOf(s).images], [true, 1, [2, 3], 1],
		"§11 FAILS ON THE OLD CODE: an image drawn on two pages is replaced once: one object on both pages, counted once");
	ok(onPod[0] && onPod[0].bytes.length < PHOTO_A.length, "§11 FAILS ON THE OLD CODE: ...and both pages draw the smaller copy");
	eq(s.ok && s.parts.map((p) => p.pages), s0.parts.map((p) => p.pages), "§11 FAILS ON THE OLD CODE: ...the POD still two pages (L2)");

	// The parts case (L2): a whitelisted JPEG in the invoice, the rate con and a lumper receipt.
	const IN_INVOICE = blank(41);
	const IN_RATECON = blank(42);
	const IN_LUMPER = blank(43);
	const invoicePdf = await jpegs.imagePdf([page([photo(IN_INVOICE)], [INVOICE_TEXT])]);
	const rateConPdf = await jpegs.imagePdf([page([photo(IN_RATECON)], ["RATE CON (MADE UP)", `Load Number ${LOAD}`, `Bill to ${DEBTOR}`, "Total $2,150.00"])]);
	const partsDocs = [await row(1, [page([photo(PHOTO_A)])]), await row(7, [page([photo(IN_LUMPER)], ["LUMPER RECEIPT (MADE UP)"])], "Lumper")];
	const partsArgs = { invoicePdf, rateCon: { buffer: rateConPdf, source: "documents" }, documents: partsDocs };
	const p0 = await build(partsArgs);
	ok(p0.ok, "§11 (fixture) the invoice, the rate con, a POD and a lumper receipt, each holding a JPEG, build today");
	const p = await build({ ...ON, ...partsArgs, maxBytes: total(p0) - 1000 });
	eq(p.ok && p.parts.map((x) => [x.kind, x.sha256 === (p0.parts.find((y) => y.kind === x.kind) || {}).sha256, Boolean(x.recompressed)]),
		[["invoice", true, false], ["ratecon", true, false], ["pod", false, true], ["other", true, false]],
		"§11 FAILS ON THE OLD CODE: the parts case (L2): the invoice, the rate con and the lumper receipt go byte for byte; only the POD's photo is re-compressed");
	const pi = await imagesOf(p);
	eq([IN_INVOICE, IN_RATECON, IN_LUMPER].map((b) => sameBytes(pi, b)), [true, true, true], "§11 FAILS ON THE OLD CODE: ...their photos in the batch byte for byte (mutant: every part re-compressed)");

	// The whitelist case: beside an RGB JPEG that is re-compressed, each of these stays byte for byte.
	// Each is half a megapixel or more, decodable, and shrinks at 70 (N1), so only its own rule leaves it.
	const zlib = require("zlib");
	const fixtures = [
		["a CMYK JPEG with a Decode array", photo(blank(61, { components: 4, adobe: { transform: 0, at: "before" } }), { colorSpace: "DeviceCMYK", dict: { Decode: [1, 0, 1, 0, 1, 0, 1, 0] } }), "the colour-space rule, the component count and the Decode rule removed together"],
		["an RGB JPEG with a Decode array", photo(blank(62), { dict: { Decode: [1, 0, 1, 0, 1, 0] } }), "a Decode array taken"],
		["an SMask", photo(blank(63), { dict: { SMask: jpegs.softMask(W, H) } }), "a soft mask taken"],
		["a colour-key Mask", photo(blank(64), { dict: { Mask: [0, 10, 0, 10, 0, 10] } }), "a Mask taken"],
		["a /DecodeParms", photo(blank(65), { dict: { DecodeParms: { ColorTransform: 0 } } }), "DecodeParms taken"],
		["EXIF orientation 6", photo(blank(66, { orientation: 6 })), "the orientation rule skipped (here the size check after decoding leaves it too)"],
		["EXIF orientation 3", photo(blank(67, { orientation: 3 })), "the orientation rule skipped: a 180-degree turn keeps the size"],
		["an Adobe transform-0 segment before the frame header", photo(blank(68, { adobe: { transform: 0, at: "before" } })), "the Adobe rule skipped"],
		["an Adobe transform-0 segment after the frame header", photo(blank(69, { adobe: { transform: 0, at: "after" } })), "a header walk that stops at the frame (N2)"],
		["R, G, B component IDs", photo(blank(70, { ids: [0x52, 0x47, 0x42] })), "the component IDs not read"],
		["a progressive JPEG", photo(blank(71, { progressive: true })), "a frame other than baseline taken"],
		["an ICCBased /N 1 JPEG", photo(blank(72, { components: 1 }), { colorSpace: ["ICCBased", { n: 1 }] }), "ICCBased /N 1 taken (L5)"],
		["a JPEG under 0.5 MP", { bytes: blank(73, { width: 600, height: 400 }), width: 600, height: 400 }, "the 0.5 MP floor skipped (L5)"],
		["a Flate image", { bytes: zlib.deflateSync(Buffer.alloc(W * H * 3, 0xe8)), width: W, height: H, filter: "FlateDecode" }, "the filter rule removed; the header walk leaves it too, so the next case is the rule's own"],
		["a JPEG's bytes under /Filter [/FlateDecode /DCTDecode]", photo(blank(75), { filter: ["FlateDecode", "DCTDecode"] }), "a filter list taken that isn't DCTDecode alone"],
		["a JPEG lib/image-metadata.js can't walk to its end", photo(jpegs.unwalkable(blank(74))), "the original bytes decoded when the strip fails (N2)"],
	];
	for (const [half, eligible] of [[fixtures.slice(0, 7), blank(51)], [fixtures.slice(7), blank(52)]]) {
		const docs = [await row(1, [page([photo(eligible), ...half.map(([, im]) => im)])])];
		const w0 = await build({ documents: docs });
		const w = await build({ ...ON, documents: docs, maxBytes: total(w0) - 1000 });
		const found = await imagesOf(w);
		eq([w.ok, recordOf(w) && recordOf(w).images, recordOf(w) && recordOf(w).left, sameBytes(found, eligible)], [true, 1, half.length, false],
			`§11 FAILS ON THE OLD CODE: the whitelist case: the RGB photo beside ${half.length} others is re-compressed, and they are left`);
		for (const [label, im, mutant] of half) {
			ok(sameBytes(found, im.bytes), `§11 FAILS ON THE OLD CODE: the whitelist case: ${label} stays byte for byte (mutant: ${mutant})`);
		}
	}

	// A copy that isn't smaller is not kept (L2).
	const LOWQ = jpegs.jpeg({ quality: 20, smooth: true, seed: 5 });
	const lowq = [await row(1, [page([photo(LOWQ), photo(PHOTO_A)])])];
	const l0 = total(await build({ documents: lowq }));
	const l = await build({ ...ON, documents: lowq, maxBytes: l0 - 1000 });
	eq([l.ok, recordOf(l) && recordOf(l).images, recordOf(l) && recordOf(l).left, sameBytes(await imagesOf(l), LOWQ)], [true, 1, 1, true],
		"§11 FAILS ON THE OLD CODE: a photo whose copy would be bigger (quality 20) stays as it was, beside one re-compressed (L2; mutant: a bigger copy kept)");

	// The child: an error, and one past its deadline, each leave their image (§4); and the batch's
	// time budget (N8). Each needs a stand-in encoder or clock made by the new module.
	const CHILD_CASES = [
		"§11 FAILS ON THE OLD CODE: a child error leaves its image as it was, and the batch still builds when it fits",
		"§11 FAILS ON THE OLD CODE: a child past its deadline leaves its image as it was, and the batch still builds when it fits",
		"§11 FAILS ON THE OLD CODE: past the batch's 5-minute budget the steps stop, and the batch stops at BATCH_TOO_LARGE as today (N8; mutant: the budget ignored)",
		"§11 FAILS ON THE OLD CODE: a child's copy that fails the parent's check (not the dictionary's size) is never used, so the batch reaches the floor untouched (N5; mutant: the parent's check skipped)",
	];
	if (!recompressLib) {
		for (const label of CHILD_CASES) failures.push(`${label}\n      lib/triumph-batch-recompress.js is missing: no steps, no child, no budget`);
	} else {
		const real = recompressLib.createEncoder();
		let calls = 0;
		const failing = recompressLib.create({ encode: (img, q) => (calls++ === 0 ? Promise.resolve({ error: "a made-up child error" }) : real(img, q)) });
		const e = await build({ ...ON, documents: two, maxBytes: T0 - 1000, recompressor: failing });
		eq([e.ok, recordOf(e) && recordOf(e).images, recordOf(e) && recordOf(e).left, sameBytes(await imagesOf(e), PHOTO_A)], [true, 1, 1, true], CHILD_CASES[0]);
		const dir = tmp();
		const pidFile = path.join(dir, "pid.txt");
		const hangFile = path.join(dir, "made-up-hanging-child.js");
		fs.writeFileSync(hangFile, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.once("message", () => {});\nprocess.on("disconnect", () => process.exit(0));\nsetInterval(() => {}, 1000);\n`);
		const hanging = recompressLib.createEncoder({ childPath: hangFile, timeoutMs: 400 });
		let n2 = 0;
		const timed = recompressLib.create({ encode: (img, q) => (n2++ === 0 ? hanging(img, q) : real(img, q)) });
		const t = await build({ ...ON, documents: two, maxBytes: T0 - 1000, recompressor: timed });
		eq([t.ok, recordOf(t) && recordOf(t).images, recordOf(t) && recordOf(t).left, sameBytes(await imagesOf(t), PHOTO_A)], [true, 1, 1, true], CHILD_CASES[1]);
		let alive = true;
		const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : 0;
		for (let i = 0; i < 40 && alive; i++) {
			try {
				process.kill(pid, 0);
				await new Promise((r) => setTimeout(r, 50));
			} catch {
				alive = false;
			}
		}
		eq([pid > 0, alive], [true, false], "§11 ...the child is killed at its deadline (it was the one this run started)");
		const answer = await hanging(PHOTO_A, 70);
		ok(answer && answer.error && /timed out/.test(answer.error) && !answer.jpeg, "§11 ...and its answer is an error, never a JPEG");
		let ticks = 0;
		const late = recompressLib.create({ now: () => (ticks++ === 0 ? 0 : recompressLib.BATCH_BUDGET_MS + 1) });
		const out = await build({ ...ON, documents: two, maxBytes: T0 - 1000, recompressor: late });
		eq([out.code, out.floorReached, out.recompressSkipped, out.pdfBytes], ["BATCH_TOO_LARGE", undefined, "OUT_OF_TIME", base.pdf.length], CHILD_CASES[2]);
		const wrongSize = jpegs.jpeg({ width: 600, height: 400, quality: 50, seed: 9 });
		const odd = recompressLib.create({ encode: async () => ({ jpeg: wrongSize }) });
		const o = await build({ ...ON, documents: two, maxBytes: T0 - 1000, recompressor: odd });
		eq([o.ok, o.code, o.floorReached, (o.recompressed || []).length, o.pdfBytes], [false, "BATCH_TOO_LARGE", true, 0, base.pdf.length], CHILD_CASES[3]);
	}
	eq(lib.STEPS && [lib.STEPS, lib.MAX_IMAGES, lib.MIN_PIXELS, lib.MAX_PIXELS, lib.IMAGE_TIMEOUT_MS, lib.BATCH_BUDGET_MS], [[70, 60, 50], 40, 500000, 25000000, 20000, 300000],
		"§11 FAILS ON THE OLD CODE: the steps 70, 60 and 50 in one constant (P1), at most 40 photos a batch, 0.5 to 25 MP, 20 s an image and 5 minutes a batch (N8)");

	// These pass on the old code by design: each pins a mutant.
	const under = await build({ ...ON, documents: two });
	const ui = await imagesOf(under);
	eq([under.ok, under.ok && under.parts.some((x) => "recompressed" in x), sameBytes(ui, PHOTO_A), sameBytes(ui, PHOTO_B)], [true, false, true, true],
		"§11 a batch under the limit is untouched: no record, every photo byte for byte (mutant: re-compress always)");
	eq(under.ok && under.parts.map((x) => x.sha256), base.parts.map((x) => x.sha256), "§11 ...each part's hash as built today");
	const offs = [];
	for (const recompress of [undefined, false, "true", 1]) {
		const r = await build({ recompress, documents: two, maxBytes: T0 - 1000 });
		offs.push([r.code, Object.keys(r).sort(), r.pdfBytes]);
	}
	eq(offs, Array(4).fill(["BATCH_TOO_LARGE", ["code", "csvBytes", "maxBytes", "ok", "pdfBytes"], base.pdf.length]),
		"§11 with the switch off (no option, false, or anything but true), a batch over the limit stops as it always did, with the same answer (mutant: on with the switch off)");
	const gold = await frozen(() => build({ documents: two }));
	const goldStop = await build({ recompress: false, documents: two, maxBytes: T0 - 1000 });
	eq({ batch: [gold.pdfSha256, gold.csvSha256, gold.batchBytes], stop: JSON.stringify(goldStop) }, GOLDEN_OFF,
		"§11 with the switch off, the batch of two camera photos is byte for byte the base's (221ff323), and so is its stop over a lowered limit (mutant: any change to the switch-off path)");
	eq([floor.code, floor.maxBytes], ["BATCH_TOO_LARGE", floorLimit],
		"§11 a lowered TRIUMPH_BATCH_MAX_BYTES still applies at each step: under Triumph's own limit at 70, the batch still stops at the lowered one (mutant: the limit skipped at the steps)");
	const unreachable = await build({ ...ON, documents: two, maxBytes: T0 - photoBytes - 1 });
	eq([unreachable.code, unreachable.floorReached, unreachable.pdfBytes], ["BATCH_TOO_LARGE", undefined, base.pdf.length],
		"§11 a batch over by at least its photos' bytes: no step can fit, so it stops as today (mutant: the skip rule removed)");
	eq(unreachable.recompressSkipped, "UNREACHABLE", "§11 FAILS ON THE OLD CODE: ...and the stop says why no step ran");
	const MANY = blank(80);
	const many = [await row(1, [page(Array.from({ length: 41 }, () => photo(MANY)))])];
	const m0 = await build({ documents: many });
	const capped = await build({ ...ON, documents: many });
	eq([m0.code, capped.code, capped.floorReached, capped.pdfBytes], ["BATCH_TOO_LARGE", "BATCH_TOO_LARGE", undefined, m0.pdfBytes],
		"§11 more than 40 photos in a batch: it stops as today, and no step runs (mutant: no cap)");
	eq(capped.recompressSkipped, "TOO_MANY", "§11 FAILS ON THE OLD CODE: ...and the stop says why no step ran");
}

(async () => {
	for (const s of [s3, s4, s5, s6, s7, s8, s9, s10, s11]) await s();
})().catch((e) => failures.push(`the run threw: ${e && e.stack}`)).then(() => {
	console.log(`\n${pass} passed, ${failures.length} failed`);
	for (const f of failures) console.log(`FAIL  ${f}`);
	process.exit(failures.length ? 1 : 0);
});
