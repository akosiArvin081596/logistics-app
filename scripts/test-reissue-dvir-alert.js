#!/usr/bin/env node
/**
 * The re-issue hold alert says what the rate con deducted for DVIR (the owner's option c,
 * 2026-10-14). C.H. Robinson's post-delivery "Booked Load #" rate con can carry a charge line
 * per missed inspection ("Missing Pre-Trip DVIR Inspection 1.00 -$35.00 -$35.00"), and the
 * re-issue hold keeps Payment as stored; a person decides whether to dispute. The app reads the
 * DVIR lines from the rate-con PDF that POST /api/n8n/extract-pdf-via-gemini already receives
 * (that route only forwarded the bytes to Gemini, so once its response is sent it reads their
 * text with lib/ratecon-dvir.js pdfText()), keeps the reading in memory by load number for a
 * few minutes, and alertRateConReissueHold() adds one line to the email and the in-app notice.
 * Every value in this file is made up: load numbers, amounts, names and rate-con text. None is
 * copied from production or from a real rate con.
 *
 *   §1 lib/ratecon-dvir.js: pdfText() reads the strings the built-in reader
 *      (brokerInvoice.extractPdfText()) reads from a page's streams, each stream once (an
 *      uncompressed page too), with the same string rule and escapes; 3 MB of ordinary text in
 *      one compressed stream and 3 MB of tiny streams are read within a second, at most
 *      MAX_STREAMS streams and MAX_TEXT_CHARS of text. A readable rate con's DVIR deductions
 *      (one line, two lines, two identical lines, another amount, an accounting negative), and
 *      what is not one (a positive amount, a sentence naming DVIR, no DVIR); unreadable text
 *      and an over-size PDF; the alert line for each: the owner's sentence for a readable
 *      deduction ("$35", the actual amount, "(2 deductions)" with the total), "Payment dropped
 *      by $X. This may be a DVIR deduction; check the rate con." when there is no readable text
 *      and the held Payment (the first Payment column holding amounts, "Payment Terms" skipped)
 *      dropped by a positive multiple of $35, and no line otherwise; long whitespace runs and
 *      many DVIR mentions stay fast.
 *   §2 the extract route, lifted (Gemini stubbed): the text is read after the response is sent;
 *      a readable rate con's reading is kept under the extracted load number (any spelling
 *      normLoadKey() folds), an unreadable one as not readable; the response is unchanged; a
 *      failed extraction keeps nothing; a reading older than RATECON_DVIR_TTL_MS is gone; at
 *      most RATECON_DVIR_MAX_LOADS loads are kept, the oldest dropped first; the
 *      keep-stored-values route's own code never reads it.
 *   §3 alertRateConReissueHold(), lifted with the extract route's reading: the DVIR line in the
 *      email and in the in-app notice for each case of §1; no line when there is nothing to
 *      say; the held list it was given is untouched, and the ledger's rows (the dedupe key) are
 *      the same with or without a reading; the same change is not alerted twice; a retry from
 *      the sweep carries the line after the reading has expired (ledger column `note`), the
 *      newest alert's line when two are owed; a ledger made before `note` gets it.
 *
 * SERVER_JS=<file> runs against another copy of server.js (the base, to show a case fails).
 * Pure: no server, no network; in-memory databases. Run:
 *   node scripts/test-reissue-dvir-alert.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");
// server.js's own require, so a lifted `require("./lib/...")` finds this checkout's lib/.
const rootRequire = createRequire(path.join(ROOT, "server.js"));
const dvir = require(path.join(ROOT, "lib", "ratecon-dvir"));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
	if (cond) { pass++; console.log(`ok   ${name}`); return; }
	fail++;
	console.log(`FAIL ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function eq(actual, expected, name) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; console.log(`ok   ${name}`); return; }
	fail++;
	console.log(`FAIL ${name}: got ${a}, want ${e}`);
}
function fatal(msg) { console.log(`FAIL ${msg}`); process.exit(1); }

let Database;
try {
	Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
} catch (e) {
	fatal(`better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
}

// --- made-up rate cons ------------------------------------------------------------
const OWNER_35 = "C.H. Robinson deducted $35 for DVIR. If the driver did the pre-trip inspection, dispute it with C.H. Robinson.";
const OWNER_70_TWO = "C.H. Robinson deducted $70 for DVIR (2 deductions). If the driver did the pre-trip inspection, dispute it with C.H. Robinson.";
const DROP = (x) => `Payment dropped by ${x}. This may be a DVIR deduction; check the rate con.`;
const INTRO = "Carrier Rate Confirmation for a test load. Pickup at Test Shipper, delivery appointment at Test Consignee. Equipment: van; trailer as booked; weight 20,000 lbs.";
// Text as pdfText() gives it (its Tj strings, space-joined).
const TJ_ONE = `${INTRO} Line Haul 300.00 $1.80 $540.00 Missing Pre-Trip DVIR Inspection 1.00 -$35.00 -$35.00 Total: $505.00`;
// Text with its line breaks kept.
const LINES_TWO = `${INTRO}\nLine Haul      300.00     $1.80     $540.00\nMissing Post-Trip DVIR Inspection    1.00    -$35.00    -$35.00\nMissing Pre-Trip DVIR Inspection     1.00    -$35.00    -$35.00\nTotal:     $470.00`;

// A minimal PDF whose page shows `lines` as literal Tj strings (readable by the built-in reader).
function pdfWith(lines, { flate = true } = {}) {
	const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
	const content = `BT /F1 10 Tf 72 720 Td ${lines.map((l) => `(${esc(l)}) Tj 0 -14 Td`).join(" ")} ET`;
	const data = flate ? zlib.deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${data.length}${flate ? " /Filter /FlateDecode" : ""} >>\nstream\n`, "latin1"),
		data,
		Buffer.from("\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n", "latin1"),
	]);
}
// A PDF whose page draws glyph codes only (hex strings): the built-in reader finds no text.
function pdfGlyphsOnly() {
	const content = `BT /F1 10 Tf 72 720 Td ${"<0012003400560078> Tj ".repeat(40)}ET`;
	const data = zlib.deflateSync(Buffer.from(content, "latin1"));
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
		data,
		Buffer.from("\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n", "latin1"),
	]);
}
const INTRO_LINES = ["Carrier Rate Confirmation for a test load.", "Pickup at Test Shipper, delivery appointment at Test Consignee.", "Equipment: van; trailer as booked; weight 20,000 lbs."];
const PDF_ONE = pdfWith([...INTRO_LINES, "Line Haul", "300.00", "$1.80", "$540.00", "Missing Pre-Trip DVIR Inspection", "1.00", "-$35.00", "-$35.00", "Total:", "$505.00"]);
const PDF_ONE_PLAIN = pdfWith([...INTRO_LINES, "Missing Pre-Trip DVIR Inspection", "1.00", "-$35.00", "-$35.00", "Total:", "$505.00"], { flate: false });
const PDF_TWO = pdfWith([...INTRO_LINES, "Missing Post-Trip DVIR Inspection", "1.00", "-$35.00", "-$35.00", "Missing Pre-Trip DVIR Inspection", "1.00", "-$35.00", "-$35.00", "Total:", "$470.00"]);
const PDF_NO_DVIR = pdfWith([...INTRO_LINES, "Line Haul", "300.00", "$1.80", "$540.00", "Total:", "$540.00"]);
const PDF_UNREADABLE = pdfGlyphsOnly();
const PDF_TWO_SAME = pdfWith([...INTRO_LINES, "Missing Pre-Trip DVIR Inspection", "1.00", "-$35.00", "-$35.00", "Missing Pre-Trip DVIR Inspection", "1.00", "-$35.00", "-$35.00", "Total:", "$470.00"]);
const b64 = (buf) => buf.toString("base64");
// A PDF whose streams hold these contents as written (each deflated when flate).
function pdfOf(contents, { flate = false } = {}) {
	const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
	contents.forEach((c, i) => {
		const data = flate ? zlib.deflateSync(Buffer.from(c, "latin1")) : Buffer.from(c, "latin1");
		parts.push(Buffer.from(`${i + 1} 0 obj\n<< /Length ${data.length}${flate ? " /Filter /FlateDecode" : ""} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1"));
	});
	parts.push(Buffer.from("trailer\n<< >>\n%%EOF\n", "latin1"));
	return Buffer.concat(parts);
}
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice"));

// --- §1 the pure reading -------------------------------------------------------------
function section1() {
	// pdfText(): the strings the built-in reader finds in a page's streams, each stream once.
	const want = [...INTRO_LINES, "Line Haul", "300.00", "$1.80", "$540.00", "Missing Pre-Trip DVIR Inspection", "1.00", "-$35.00", "-$35.00", "Total:", "$505.00"].join(" ");
	eq(dvir.pdfText(PDF_ONE), want, "§1 pdfText(): a compressed page's strings, joined with spaces");
	for (const [what, pdf] of [["a compressed page", PDF_ONE], ["an uncompressed page", PDF_ONE_PLAIN], ["two DVIR lines", PDF_TWO]]) {
		ok(`§1 pdfText() reads the same strings as the built-in reader (${what})`, brokerInvoice.extractPdfText(pdf).startsWith(dvir.pdfText(pdf)));
	}
	eq((dvir.pdfText(PDF_ONE_PLAIN).match(/DVIR/g) || []).length, 1, "§1 pdfText() reads an uncompressed page once");
	const rules = pdfOf(["BT (a\\)b) Tj (x(y)z) Tj (\\101\\102) Tj (p\\nq) Tj (end\\\n(next) Tj ET"]);
	eq(dvir.pdfText(rules), "a)b y AB p\nq next", "§1 pdfText(): the string rule and escapes (an escaped \")\", a nested \"(\", octal, \\n, a backslash before a line break)");
	ok("§1 pdfText(): the same strings as the built-in reader for those rules", brokerInvoice.extractPdfText(rules).startsWith(dvir.pdfText(rules)), brokerInvoice.extractPdfText(rules).slice(0, 60));
	eq(dvir.pdfText(PDF_UNREADABLE), "", "§1 pdfText(): a page of glyph codes has no strings");
	eq(dvir.readRateConDvir(dvir.pdfText(PDF_TWO_SAME), PDF_TWO_SAME.length), { readable: true, cents: 7000, count: 2 }, "§1 a PDF with two identical DVIR lines: $70, two deductions");

	// Volume: ordinary content, read within its caps.
	const timed = (buf) => { const t = Date.now(); const text = dvir.pdfText(buf, { maxInflatedBytes: 4 * 1024 * 1024 }); return { ms: Date.now() - t, text }; };
	const big = timed(pdfOf(["BT (Line Haul 300.00 $1.80 $540.00) Tj ET ".repeat(70000)], { flate: true }));
	ok(`§1 pdfText(): 3 MB of ordinary text in one compressed stream is read within a second, cut to MAX_TEXT_CHARS (${big.ms} ms)`,
		big.ms < 1000 && big.text.length <= 200000 && big.text.startsWith("Line Haul 300.00 $1.80 $540.00 Line Haul"), { ms: big.ms, length: big.text.length });
	const tiny = timed(Buffer.from("stream\nx\nendstream\n".repeat(160000), "latin1"));
	ok(`§1 pdfText(): 3 MB of tiny streams is read within a second (${tiny.ms} ms)`, tiny.ms < 1000, tiny.ms);
	const many = dvir.pdfText(pdfOf(Array.from({ length: dvir.MAX_STREAMS + 200 }, (_v, i) => `BT (s${i}) Tj ET`)));
	eq([many.includes(`s${dvir.MAX_STREAMS - 1}`), many.includes(`s${dvir.MAX_STREAMS}`)], [true, false], `§1 pdfText(): at most MAX_STREAMS (${dvir.MAX_STREAMS}) streams are read`);

	const read = (t, size = 1000) => dvir.readRateConDvir(t, size);
	eq(read(TJ_ONE), { readable: true, cents: 3500, count: 1 }, "§1 one DVIR line (the readers' space-joined form): $35, one deduction");
	eq(read(LINES_TWO), { readable: true, cents: 7000, count: 2 }, "§1 a pre-trip and a post-trip line, line breaks kept: $70, two deductions");
	eq(read(TJ_ONE.replace(/-\$35\.00/g, "-$50.00")), { readable: true, cents: 5000, count: 1 }, "§1 another amount ($50) is read as printed");
	eq(read(`${INTRO} DVIR Fee ($35.00) Total: $505.00`), { readable: true, cents: 3500, count: 1 }, "§1 an accounting negative \"($35.00)\" is a deduction");
	eq(read(TJ_ONE.replace("Total:", "Missing Pre-Trip DVIR Inspection 1.00 -$35.00 -$35.00 Total:")), { readable: true, cents: 7000, count: 2 },
		"§1 two identical DVIR lines are two deductions: $70");
	eq(read(`${INTRO} DVIR Reimbursement 1.00 $35.00 $35.00 Total: $575.00`), { readable: true, cents: 0, count: 0 }, "§1 a positive DVIR amount is no deduction");
	eq(read(`${INTRO} The driver must complete a DVIR before departure.`), { readable: true, cents: 0, count: 0 }, "§1 a sentence naming DVIR is no deduction");
	eq(read(`${INTRO} Line Haul 300.00 $1.80 $540.00 Total: $540.00`), { readable: true, cents: 0, count: 0 }, "§1 no DVIR line: nothing deducted");
	eq(read("%PDF-1.4 1 0 obj << >> stream x endstream endobj DVIR -$35.00"), { readable: false, cents: 0, count: 0 }, "§1 the raw file (no text the reader could decode) is not readable");
	eq(read(TJ_ONE, 4 * 1024 * 1024), { readable: false, cents: 0, count: 0 }, "§1 a PDF over the size limit is not readable");

	const line = (reading, held = []) => dvir.dvirAlertLine(reading, held);
	const pay = (stored, sent, column = "  Payment  ") => [{ column, stored, sent }];
	eq(line(read(TJ_ONE)), OWNER_35, "§1 a readable $35 deduction: the owner's sentence, word for word");
	eq(line(read(LINES_TWO)), OWNER_70_TWO, "§1 two deductions: the total, the count, the same sentence shape");
	eq(line(read(TJ_ONE.replace(/-\$35\.00/g, "-$37.50"))), "C.H. Robinson deducted $37.50 for DVIR. If the driver did the pre-trip inspection, dispute it with C.H. Robinson.", "§1 an amount with cents is shown with its cents");
	eq(line(read(TJ_ONE), pay(" $ 1,234.56 ", "$1,234.56")), OWNER_35, "§1 a readable deduction is said whatever Payment did");
	eq(line(null, pay(" $ 1,234.56 ", "$1,199.56")), DROP("$35.00"), "§1 no reading, Payment held $35 lower: the drop line");
	eq(line({ readable: false, cents: 0, count: 0 }, pay("$1,516.00", "$1,446.00")), DROP("$70.00"), "§1 unreadable text, Payment held $70 lower: the drop line, $70.00");
	eq(line(null, pay("$2,100.00", "$1,050.00")), DROP("$1,050.00"), "§1 a drop of $1,050 (30 x $35) is shown with its thousands separator");
	eq(line(null, pay("$100.00", "$60.00")), "", "§1 a drop of $40 (not a multiple of $35): no line");
	eq(line(null, pay("$100.00", "$135.00")), "", "§1 Payment held $35 higher: no line");
	eq(line(null, pay("$100.00", "$65.00", "Rate Per Mile")), "", "§1 a held column not named Payment: no line");
	eq(line(null, [{ column: "Payment Terms", stored: "Net 30", sent: "Quick Pay" }, ...pay("$100.00", "$65.00")]), DROP("$35.00"),
		"§1 a held \"Payment Terms\" (not amounts) is skipped for the Payment column after it");
	eq(line(null, pay("$100.00", "TBD")), "", "§1 a held Payment that is not an amount: no line");
	eq(line(read(`${INTRO} Line Haul 300.00 $1.80 $540.00 Total: $540.00`), pay("$540.00", "$505.00")), "", "§1 readable text with no DVIR line, Payment held $35 lower: no line");
	eq(line(null, []), "", "§1 nothing held, no reading: no line");

	// Bounded on text anyone can email in.
	let t0 = Date.now();
	read(`${INTRO} DVIR${" ".repeat(1_000_000)}-$35.00`, 1000);
	read(`${INTRO} ${"DVIR ".repeat(200_000)}`, 1000);
	read(`${INTRO} ${"Missing DVIR 1.00 -$35.00 ".repeat(20_000)}`, 1000);
	ok("§1 a 1 MB whitespace run, 200,000 DVIR mentions and 20,000 DVIR lines read in under 1000 ms", Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
	t0 = Date.now();
	line(null, [{ column: `Payment${" ".repeat(1_000_000)}`, stored: "$70.00", sent: "$35.00" }]);
	ok("§1 a 1 MB column name is read in under 1000 ms", Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
}

// --- §2 the extract route ------------------------------------------------------------
const XHEAD = 'app.post("/api/n8n/extract-pdf-via-gemini"';
const KHEAD = 'app.post("/api/n8n/keep-stored-values"';
const XPROVIDED = ["app", "pdfOcrLimiter", "GEMINI_API_KEY", "runRateConGemini", "alertUnusableRateConExtraction", "console", "process", "require"];
const has = (fn) => new RegExp(`\\n(async )?function ${fn}\\(`).test(SRC);

// A server.js without the reading (the base) runs every case with stand-ins that keep nothing.
const KEEPS = has("rateConDvirReading") && has("noteRateConDvir");
const STAND_INS = "const rateConDvirReading = () => null; const noteRateConDvir = () => {}; const RATECON_DVIR_TTL_MS = 600000; const RATECON_DVIR_MAX_LOADS = 200;";

function liftExtract(gemini) {
	const lifted = closure(SRC, { roots: KEEPS ? ["rateConDvirReading", "noteRateConDvir"] : [], routes: [XHEAD], provided: XPROVIDED, denied: ["sendEmail", "transporter", "io", "server", "db"] });
	const routes = {};
	const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
	const quiet = { ...console, log: () => {}, error: () => {}, warn: () => {} };
	const api = new Function(...XPROVIDED, `"use strict";\n${lifted.text}\n${KEEPS ? "" : STAND_INS}\nreturn { rateConDvirReading, noteRateConDvir, RATECON_DVIR_TTL_MS, RATECON_DVIR_MAX_LOADS };`)(
		app, (q, r, next) => next(), "test-key", gemini, async () => {}, quiet, { env: { N8N_EXTRACT_SECRET: "test-secret" } }, rootRequire,
	);
	// settle: also wait for the reading after the response (the next setImmediate turn).
	const post = async (pdf, { settle = true } = {}) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		await routes["/api/n8n/extract-pdf-via-gemini"]({ headers: { "x-webhook-secret": "test-secret" }, body: { pdf_base64: b64(pdf) } }, res);
		if (settle) await new Promise((r) => setImmediate(r));
		return out;
	};
	return { post, ...api };
}

async function section2() {
	ok("§2 server.js keeps a DVIR reading per load (rateConDvirReading(), noteRateConDvir())", KEEPS);
	let loadNumber = "#900000301";
	let geminiFails = false;
	const fields = () => ({ "Load Number": loadNumber, Rate: "$505.00", "Pickup Address": "1 Test Way, Testville, OK 70000", "Drop-off Address": "2 Test Road, Testtown, TX 70001", "Pickup Appointment Time": "10/20/2026 08:00", "Delivery Appointment Time": "10/21/2026 08:00" });
	const x = liftExtract(async () => { if (geminiFails) throw new Error("Gemini 500: test"); return fields(); });

	const r = await x.post(PDF_ONE);
	eq([r.status, Object.keys(r.body || {}).sort()], [200, ["output", "unusableFields", "warnings"]], "§2 the route still answers 200 with the same shape");
	eq((r.body.output || {})["Load Number"], "#900000301", "§2 the route's output is Gemini's, unchanged");
	const kept = x.rateConDvirReading("900000301");
	eq(kept && { readable: kept.readable, cents: kept.cents, count: kept.count }, { readable: true, cents: 3500, count: 1 }, "§2 a readable rate con's DVIR line is kept under its load number (\"#900000301\" asked as \"900000301\")");

	loadNumber = "900000302";
	await x.post(PDF_ONE_PLAIN);
	const plain = x.rateConDvirReading("900000302");
	eq(plain && [plain.cents, plain.count], [3500, 1], "§2 an uncompressed page is read once: one deduction");

	loadNumber = "900000308";
	const early = await x.post(PDF_ONE, { settle: false });
	const atAnswer = x.rateConDvirReading("900000308");
	await new Promise((r) => setImmediate(r));
	eq([early.status, atAnswer, (x.rateConDvirReading("900000308") || {}).count], [200, null, 1], "§2 the text is read after the response is sent (nothing kept when it answers, kept a turn later)");

	loadNumber = "900000309";
	await x.post(PDF_TWO_SAME);
	const same = x.rateConDvirReading("900000309");
	eq(same && [same.cents, same.count], [7000, 2], "§2 two identical DVIR lines: $70, two deductions");

	// The response depends on Gemini's fields only, never on what the text reading finds.
	loadNumber = "900000307";
	const withDvir = await x.post(PDF_TWO);
	const unreadable = await x.post(PDF_UNREADABLE);
	eq([unreadable.status, JSON.stringify(unreadable.body)], [200, JSON.stringify(withDvir.body)], "§2 the response is the same for a readable DVIR rate con and an unreadable one with the same fields");
	eq((x.rateConDvirReading("900000307") || {}).readable, false, "§2 and the later one's reading is kept (not readable)");

	loadNumber = "900000303";
	await x.post(PDF_TWO);
	const two = x.rateConDvirReading("900000303");
	eq(two && [two.readable, two.cents, two.count], [true, 7000, 2], "§2 two DVIR lines: $70, two deductions");

	loadNumber = "900000304";
	await x.post(PDF_UNREADABLE);
	const un = x.rateConDvirReading("900000304");
	eq(un && un.readable, false, "§2 a rate con the built-in reader can't decode is kept as not readable");

	loadNumber = "900000305";
	await x.post(PDF_NO_DVIR);
	const nd = x.rateConDvirReading("900000305");
	eq(nd && [nd.readable, nd.count], [true, 0], "§2 a readable rate con with no DVIR line is kept as readable, nothing deducted");

	loadNumber = "900000306";
	geminiFails = true;
	const failed = await x.post(PDF_ONE);
	geminiFails = false;
	eq([failed.status, x.rateConDvirReading("900000306")], [502, null], "§2 a failed extraction answers as before and keeps nothing");

	eq(x.rateConDvirReading("900000399"), null, "§2 a load with no rate con read: no reading");
	const later = Date.now() + x.RATECON_DVIR_TTL_MS + 1000;
	eq(x.rateConDvirReading("900000301", later), null, "§2 a reading older than RATECON_DVIR_TTL_MS is gone");
	ok("§2 RATECON_DVIR_TTL_MS is a few minutes (1 to 30)", x.RATECON_DVIR_TTL_MS >= 60000 && x.RATECON_DVIR_TTL_MS <= 30 * 60000, x.RATECON_DVIR_TTL_MS);

	// Bounded: the oldest is dropped first.
	const y = liftExtract(async () => fields());
	const base64 = b64(PDF_ONE);
	const t = Date.now();
	for (let i = 0; i <= y.RATECON_DVIR_MAX_LOADS; i++) y.noteRateConDvir(`9000010${String(i).padStart(2, "0")}`, base64, t + i);
	eq([y.rateConDvirReading("900001000", t + 500), !!y.rateConDvirReading(`9000010${String(y.RATECON_DVIR_MAX_LOADS).padStart(2, "0")}`, t + 500)],
		[null, true], `§2 at most RATECON_DVIR_MAX_LOADS (${y.RATECON_DVIR_MAX_LOADS}) loads are kept: the oldest is dropped`);
	y.noteRateConDvir("900001001", "not base64 of a pdf", t + 600);
	eq((y.rateConDvirReading("900001001", t + 700) || {}).readable, false, "§2 bytes that are no PDF are kept as not readable, without an error");

	// The re-issue hold's own decision never reads it.
	const route = closure(SRC, { routes: [KHEAD], provided: ["getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "console", "process", "app", "require", "db", "alertRateConReissueHold"], denied: ["sendEmail", "transporter", "io", "server"] }).text;
	ok("§2 the keep-stored-values route's own code never reads the DVIR reading (only the alert does)", !/rateConDvirRead|noteRateConDvir|ratecon-dvir/.test(route));
}

// --- §3 the alert ----------------------------------------------------------------------
function liftAlert(db, { send = async () => true } = {}) {
	const lifted = closure(SRC, { roots: ["alertRateConReissueHold", "sweepRateConReissueHolds", ...(KEEPS ? ["noteRateConDvir"] : [])], provided: ["db", "sendEmail", "insertDispatchNotification", "io", "console", "process", "require"] });
	const sends = [];
	const notes = [];
	const quiet = { ...console, log: () => {}, error: () => {}, warn: () => {} };
	const api = new Function("db", "sendEmail", "insertDispatchNotification", "io", "console", "process", "require",
		`"use strict";\n${lifted.text}\n${KEEPS ? "" : "const noteRateConDvir = () => {};"}\nreturn { alert: alertRateConReissueHold, sweep: sweepRateConReissueHolds, noteRateConDvir };`)(
		db, async (to, subject, html) => { sends.push({ to, subject, html }); return send(to, subject, html); },
		{ run: (...a) => { notes.push({ type: a[0], title: a[1], body: a[2] }); } }, { to: () => ({ emit: () => {} }) },
		quiet, { env: { ADMIN_NOTIFY_EMAIL: "admin@example.test" } }, rootRequire,
	);
	return { ...api, sends, notes };
}
const heldPay = (stored, sent) => [{ column: "  Payment  ", stored, sent }];
const emailHas = (s, text) => !!s && s.html.includes(`<p>${text}</p>`);
const noteHas = (n, text) => !!n && n.body.endsWith(`. ${text}`);

async function section3() {
	const db = new Database(":memory:");
	const a = liftAlert(db);
	const cases = [
		["a readable $35 deduction", "900000311", PDF_ONE, heldPay(" $ 1,234.56 ", "$1,199.56"), OWNER_35],
		["two deductions", "900000312", PDF_TWO, heldPay("$1,516.00", "$1,446.00"), OWNER_70_TWO],
		["unreadable text, Payment $70 lower", "900000313", PDF_UNREADABLE, heldPay("$1,516.00", "$1,446.00"), DROP("$70.00")],
		["no reading, Payment $35 lower", "900000314", null, heldPay("$800.00", "$765.00"), DROP("$35.00")],
	];
	for (const [what, id, pdf, held, want] of cases) {
		if (pdf) a.noteRateConDvir(id, b64(pdf));
		const before = JSON.stringify(held);
		const res = await a.alert({ loadId: id, reason: "delivered", held });
		const s = a.sends.find((m) => m.subject.includes(id));
		const n = a.notes.find((m) => m.title.includes(id));
		ok(`§3 ${what}: the email carries the line`, res && res.alerted === true && emailHas(s, want), s && s.html);
		ok(`§3 ${what}: the in-app notice carries the line`, noteHas(n, want), n && n.body);
		eq(JSON.stringify(held), before, `§3 ${what}: the held list it was given is untouched`);
	}
	const silent = [
		["no reading, Payment $40 lower", "900000315", null, heldPay("$800.00", "$760.00")],
		["readable text with no DVIR line, Payment $35 lower", "900000316", PDF_NO_DVIR, heldPay("$540.00", "$505.00")],
		["no reading, only a changed field", "900000317", null, []],
	];
	for (const [what, id, pdf, held] of silent) {
		if (pdf) a.noteRateConDvir(id, b64(pdf));
		await a.alert({ loadId: id, reason: "delivered", held, changed: [{ column: "Details", stored: "Boxes", sent: "Boxes, 3 pallets" }] });
		const s = a.sends.find((m) => m.subject.includes(id));
		const n = a.notes.find((m) => m.title.includes(id));
		// (The email's standing paragraph already says a "Booked Load #" can carry DVIR deductions.)
		ok(`§3 ${what}: no DVIR line in the email or the in-app notice`, !!s && !!n && !/deducted \$|for DVIR|This may be a DVIR deduction/.test(s.html) && !/DVIR/.test(n.body), { html: s && s.html, body: n && n.body });
	}

	// Once per change, whatever the reading.
	const sent = a.sends.length;
	a.noteRateConDvir("900000311", b64(PDF_TWO));
	await a.alert({ loadId: "900000311", reason: "delivered", held: heldPay(" $ 1,234.56 ", "$1,199.56") });
	eq(a.sends.length, sent, "§3 the same change again, with another reading: not alerted twice");

	// The ledger's rows (its dedupe key and values) are the same with or without a reading.
	const dbA = new Database(":memory:");
	const dbB = new Database(":memory:");
	const withReading = liftAlert(dbA);
	const without = liftAlert(dbB);
	withReading.noteRateConDvir("900000318", b64(PDF_ONE));
	const change = { loadId: "900000318", reason: "delivered", held: heldPay("$900.00", "$865.00"), changed: [{ column: "Details", stored: "Tiles", sent: "Tiles, 2 crates" }] };
	await withReading.alert(change);
	await without.alert(change);
	const rowsOf = (d) => d.prepare("SELECT load_id, column_name, sent_value, stored_value, kind, reason FROM ratecon_reissue_holds ORDER BY column_name").all();
	eq(rowsOf(dbA), rowsOf(dbB), "§3 the ledger's rows are the same with or without a reading (only the note differs)");
	const hasNote = dbA.prepare("PRAGMA table_info(ratecon_reissue_holds)").all().some((c) => c.name === "note");
	eq(hasNote ? dbA.prepare("SELECT DISTINCT note FROM ratecon_reissue_holds").all().map((x) => x.note) : "no note column", [OWNER_35], "§3 the line is kept on the ledger rows (note)");

	// A failed email is retried by the sweep, after the reading has expired, with the line.
	const rdb = new Database(":memory:");
	let up = false;
	const r = liftAlert(rdb, { send: async () => up });
	r.noteRateConDvir("900000319", b64(PDF_ONE), Date.now() - 9 * 60 * 1000);
	const first = await r.alert({ loadId: "900000319", reason: "delivered", held: heldPay("$700.00", "$665.00") });
	ok("§3 retry: the first email fails (the in-app notice goes in with the line)", first && first.emailed === false && noteHas(r.notes[0], OWNER_35), first);
	up = true;
	const at = new Date(Date.now() + 16 * 60 * 1000);
	await r.sweep({ now: at, clock: () => at });
	const retried = r.sends.filter((m) => m.subject.includes("900000319"));
	ok("§3 retry: the sweep's email, sent after the reading expired, carries the line", retried.length === 2 && emailHas(retried[1], OWNER_35) && /This is a retry/.test(retried[1].html), retried.map((m) => m.html));

	// Two alerts for one load still owed an email: the sweep's retry carries the newest line.
	const ndb = new Database(":memory:");
	let up2 = false;
	const nn = liftAlert(ndb, { send: async () => up2 });
	nn.noteRateConDvir("900000321", b64(PDF_ONE));
	await nn.alert({ loadId: "900000321", reason: "delivered", held: heldPay("$700.00", "$665.00") });
	ndb.prepare("UPDATE ratecon_reissue_holds SET first_seen = ? WHERE load_id = '900000321'").run(new Date(Date.now() - 60 * 60 * 1000).toISOString());
	nn.noteRateConDvir("900000321", b64(PDF_TWO));
	await nn.alert({ loadId: "900000321", reason: "delivered", held: heldPay("$700.00", "$630.00") });
	up2 = true;
	const at2 = new Date(Date.now() + 16 * 60 * 1000);
	await nn.sweep({ now: at2, clock: () => at2 });
	const newest = nn.sends.filter((m) => m.subject.includes("900000321")).pop();
	ok("§3 retry of two owed alerts: the sweep's email carries the newest alert's line, not the older one",
		emailHas(newest, OWNER_70_TWO) && !newest.html.includes(OWNER_35) && /This is a retry/.test(newest.html), newest && newest.html);

	// A ledger made before `note` gets the column.
	const odb = new Database(":memory:");
	odb.exec(`CREATE TABLE ratecon_reissue_holds (load_id TEXT NOT NULL, column_name TEXT NOT NULL, sent_value TEXT NOT NULL,
		stored_value TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'held', reason TEXT NOT NULL DEFAULT '',
		first_seen TEXT, alerted_at TEXT, claimed_at TEXT, emailed_at TEXT, notified_at TEXT, email_skipped TEXT,
		notify_skipped TEXT, load_label TEXT, attempts INTEGER, last_try TEXT, PRIMARY KEY (load_id, column_name, sent_value))`);
	const o = liftAlert(odb);
	o.noteRateConDvir("900000320", b64(PDF_ONE));
	const oa = await o.alert({ loadId: "900000320", reason: "delivered", held: heldPay("$600.00", "$565.00") });
	ok("§3 a ledger made before `note`: the column is added and the alert goes out with the line",
		oa && oa.alerted === true && odb.prepare("PRAGMA table_info(ratecon_reissue_holds)").all().some((c) => c.name === "note") && emailHas(o.sends[0], OWNER_35), oa);
}

(async () => {
	console.log("§1 lib/ratecon-dvir.js: reading a rate con's DVIR lines, and the alert line");
	section1();
	console.log("§2 the extract route keeps the reading by load number, for a few minutes");
	await section2();
	console.log("§3 the re-issue alert carries the line, in the email and the in-app notice");
	await section3();
	console.log(`test-reissue-dvir-alert: ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`FAIL ${e.stack || e}`); process.exit(1); });
