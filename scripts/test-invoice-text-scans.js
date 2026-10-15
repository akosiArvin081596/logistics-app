#!/usr/bin/env node
/**
 * The text scans of the built-in rate-con reader (lib/broker-invoice.js):
 * scanBillingBlock(), extractDocumentsEmail() and extractPdfText()'s budget.
 * Their reads are bounded; their output is unchanged. The functions as they
 * were are kept below as the reference (referenceScanBillingBlock(),
 * referenceDocumentsEmail()).
 *
 * §1 scanBillingBlock(): the same five fields as the reference on hand-picked
 *    billing blocks (every kind of whitespace, NUL bytes, "#", ":", "$", ids
 *    with letters and hyphens, words that only look like labels) and on a
 *    seeded fuzz of label, whitespace, punctuation and number tokens (ids up
 *    to 40 characters).
 * §2 extractDocumentsEmail(): the same address as the reference on hand-picked
 *    notes and on a seeded fuzz of addresses (standard lengths), keywords and
 *    separators, with and without excludeEmail.
 * §3 extractPdfText(): with no maxInflatedBytes the budget is
 *    PDF_TEXT_MAX_BYTES (8 MB); a caller's own value is kept; a normal rate-con
 *    reads the same either way; extractRateConFields() reads within the budget;
 *    a stream whose zlib header names a smaller window than its data uses reads
 *    the same with any budget.
 * §4 size: each label followed by each filler repeated to 256 KB is read by
 *    each scan under TIMING_BUDGET_MS (one child process per scan, with a time
 *    limit, so a slow read fails instead of stalling the run).
 *
 * Fixtures are fake ("Zed Sentinel" names, example domains). Pure: no server,
 * no network, no files.
 *
 * Run: node scripts/test-invoice-text-scans.js    # exits 1 on failure
 */
"use strict";

const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const BI = require(path.join(__dirname, "..", "lib", "broker-invoice.js"));
const { scanBillingBlock, extractDocumentsEmail, extractPdfText, extractRateConFields, formatMoney, PDF_TEXT_MAX_BYTES } = BI;

// Generous for a shared 2-core CI runner; each read takes a few ms.
const TIMING_BUDGET_MS = 1500;
const SIZE_CHILD_LIMIT_MS = 20000;
const SIZE_CHARS = 256 * 1024;
const FUZZ_CASES = 6000;

// §4 runs in a child: `node test-invoice-text-scans.js --size` prints JSON.
const LABELS = ["", "Order", "PO", "Move", "Trailer", "Total Rate", "Order #:", "Trailer # :", "Total Rate: $", "billing@", "@", "x@y", "documents to "];
const FILLERS = [" ", "\t", "\n", "\r\n", "\u00a0", " #", " :", " $", "a", "Z", "7", "-", ".", "_", "+", "%", "a.", "@a", "a@", ",", "1,"];
const SIZE_FUNCTIONS = { scanBillingBlock: (s) => scanBillingBlock(s), extractDocumentsEmail: (s) => extractDocumentsEmail(s) };
if (process.argv[2] === "--size") {
	const fname = process.argv[3];
	const fn = SIZE_FUNCTIONS[fname];
	const over = [];
	let slowest = { ms: 0, name: "" };
	for (const label of LABELS) {
		for (const filler of FILLERS) {
			const input = label + filler.repeat(Math.ceil(SIZE_CHARS / filler.length));
			const t0 = process.hrtime.bigint();
			fn(input);
			const ms = Number(process.hrtime.bigint() - t0) / 1e6;
			const name = `${fname}(${JSON.stringify(label)} + ${JSON.stringify(filler)}...)`;
			if (ms > slowest.ms) slowest = { ms, name };
			if (ms >= TIMING_BUDGET_MS) over.push(`${name} ${ms.toFixed(0)} ms`);
		}
	}
	process.stdout.write(JSON.stringify({ count: LABELS.length * FILLERS.length, over, slowest }));
	process.exit(0);
}

// The functions as they were, verbatim (comments trimmed).
function referenceScanBillingBlock(text) {
	const t = String(text || "").replace(/\0/g, " ");
	const grab = (re) => {
		const m = t.match(re);
		return m ? m[1].trim() : "";
	};
	const orderNumber = grab(/\bOrder\b\s*#?\s*:?\s*(\d{4,})/i);
	const poNumber = grab(/\bPO\b\s*#?\s*:?\s*(\d{4,})/i);
	const moveNumber = grab(/\bMove\b\s*#?\s*:?\s*(\d{4,})/i);
	const trailerNumber = grab(/\bTrailer\b\s*#?\s*:?\s*((?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{2,})/i);
	let totalRate = grab(/\bTotal\s*Rate\b\s*:?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
	if (totalRate) totalRate = formatMoney(totalRate);
	return { orderNumber, poNumber, moveNumber, trailerNumber, totalRate };
}
const _DOC_KW = /(document|paperwork|\bpod\b|b\.?\s?o\.?\s?l\.?|bill of lading|invoice|billing|accounts payable|accounting|remit|quick.?pay)/i;
const _SEND_KW = /(e-?mail|send|submit|forward|remit)/i;
const _DOC_LOCALPART = /^(billing|ap|accountspayable|accounts|accounting|invoices?|invoicing|documents?|docs|pod|paperwork|remit|bols?|quickpay)@/i;
const _INVOICE_LOCALPART = /^(quickpay|billing|invoices?|invoicing|remit)@/i;
function referenceDocumentsEmail(text, opts = {}) {
	const src = String(text == null ? "" : text);
	if (!src) return "";
	const exclude = String(opts.excludeEmail == null ? "" : opts.excludeEmail).trim().toLowerCase();
	const brokerDomain = exclude.includes("@") ? exclude.slice(exclude.indexOf("@") + 1) : "";
	const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
	let best = "", bestScore = 0, m;
	while ((m = re.exec(src)) !== null) {
		const email = m[0].replace(/[.,;>)\]]+$/, "");
		const low = email.toLowerCase();
		if (exclude && low === exclude) continue;
		const domain = low.slice(low.indexOf("@") + 1);
		const window = src.slice(Math.max(0, m.index - 90), m.index + email.length + 12);
		let score = 0;
		if (_DOC_KW.test(window)) score += 2;
		if (_SEND_KW.test(window)) score += 1;
		if (_DOC_LOCALPART.test(low)) score += 2;
		if (_INVOICE_LOCALPART.test(low)) score += 1;
		if (brokerDomain && domain === brokerDomain) score += 2;
		if (score > bestScore) { bestScore = score; best = email; }
	}
	return bestScore >= 4 ? best : "";
}

let pass = 0;
const failures = [];
function t(cond, name, detail) {
	if (cond) pass++;
	else failures.push(detail === undefined ? name : `${name}: ${detail}`);
}
const show = (s) => JSON.stringify(String(s).length > 100 ? `${String(s).slice(0, 100)}...` : String(s));
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let x = a;
		x = Math.imul(x ^ (x >>> 15), x | 1);
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const started = Date.now();

// §1 scanBillingBlock()
{
	const CASES = [
		["", "empty"],
		["Billing Information Order #: 7007280 PO #: 4400123 Move #: 9911223 Trailer #: 51237 Total Rate: $2,450.00", "a billing block"],
		["Order\t#\t:\t7007280\nPO\n#\n4400123\r\nMove  #  :  9911223", "tabs and line breaks"],
		["Order\u00a0#:\u00a07007280 Trailer\u00a0TR-4501", "no-break spaces"],
		["Order\x00#:\x007007280 Total\x00Rate\x00$\x00 1,800.00", "NUL bytes"],
		["Order #: 7,007,280 PO: 12 Move 123", "numbers too short or split"],
		["Trailer are required Trailer Required Trailer: 118013", "prose after Trailer, then an id"],
		["trailers 53' or longer Trailer # SHP2607-A3BJ112", "a longer word, then an id with letters"],
		["TotalRate:$1,234 Total  Rate $ 99.5 ", "Total Rate written together, odd cents"],
		["Order #:\n\n\n   \t  \n 7007280", "a whitespace run between label and number"],
		["Orders 1234 Ordering 5555 Order 6666", "labels inside longer words"],
		["PO#4400123 Move#:9911223 Order#7007280", "no spaces at all"],
	];
	for (const [input, name] of CASES) {
		const want = JSON.stringify(referenceScanBillingBlock(input));
		const got = JSON.stringify(scanBillingBlock(input));
		t(got === want, `§1 ${name}`, `input ${show(input)}: want ${want}, got ${got}`);
	}
	const TOKENS = [
		"Order", "order", "ORDER", "PO", "po", "Move", "Trailer", "Total Rate", "TotalRate", "Total", "Rate", "Orders", "trailers", "Billing",
		"#", ":", "$", ",", ".", "-", "'", "are", "Required", "53'",
		" ", " ", " ", "  ", "\t", "\n", "\r\n", "\u00a0", "\f", "\v", "\0", "   \n  ", "\u2028",
		"7007280", "4400123", "12", "123", "1234", "99", "1,234.56", "2,450.00", "1,800", "TR-4501", "SHP2607-A3BJ112", "A1", "x",
	];
	const r = rng(415);
	let mismatches = 0;
	let first = null;
	let ran = 0;
	for (let k = 0; ran < FUZZ_CASES && k < FUZZ_CASES * 3; k++) {
		let s = "";
		const len = Math.floor(r() * 30);
		for (let q = 0; q < len; q++) s += pick(r, TOKENS);
		if (/[A-Za-z0-9-]{41,}/.test(s)) continue;
		ran++;
		if (JSON.stringify(scanBillingBlock(s)) !== JSON.stringify(referenceScanBillingBlock(s))) {
			mismatches++;
			if (first === null) first = s;
		}
	}
	t(ran === FUZZ_CASES && mismatches === 0, `§1 ${FUZZ_CASES} fuzzed texts give the same fields as the reference`, `${ran} ran, ${mismatches} differ, first ${show(first || "")}`);
}

// §2 extractDocumentsEmail()
{
	const CASES = [
		["", "", "empty"],
		["Please email all documents to billing@zedsentinel.example.com within 24 hours.", "", "a documents note"],
		["Send POD and B.O.L. to: ap@zedsentinel.example.com, cc dispatch@zedsentinel.example.com.", "", "a list with trailing punctuation"],
		["Agent: zed.agent@zedsentinel.example.com Email invoices to quickpay@zedsentinel.example.com or ap@zedsentinel.example.com", "zed.agent@zedsentinel.example.com", "the agent's own address excluded"],
		["Email the signed BOL to dock@receiver.example.org at delivery", "zed.agent@zedsentinel.example.com", "a receiver's dock only"],
		["Email:billing@zedsentinel.example.com (documents) <invoices@zedsentinel.example.com>", "", "addresses after a colon and inside brackets"],
		["remit to accounts.payable+loads@zedsentinel.example.co.uk; paperwork too", "", "a sub-addressed local part and a long domain"],
		["billing@zedsentinel.example.comPlease send documents", "", "an address glued to the next word"],
		["no address here, only documents and billing words", "", "no address"],
	];
	for (const [input, exclude, name] of CASES) {
		const want = referenceDocumentsEmail(input, { excludeEmail: exclude });
		const got = extractDocumentsEmail(input, { excludeEmail: exclude });
		t(got === want, `§2 ${name}`, `want ${show(want)}, got ${show(got)}`);
	}
	t(extractDocumentsEmail("Please email all documents to billing@zedsentinel.example.com") === "billing@zedsentinel.example.com", "§2 the documents inbox is found");
	const LOCALS = ["billing", "ap", "accounts.payable", "accountspayable", "quickpay", "pod", "docs", "documents", "invoices", "remit", "zed.agent", "z_doe", "a+b", "x%y", "dispatch", "ops-team", "Invoices", "AP", "bols"];
	const DOMAINS = ["zedsentinel.example.com", "broker-co.example.net", "mail.zed.example.com", "zs.example.io", "sub.zed.example.co.uk", "receiver.example.org"];
	const WORDS = ["email", "e-mail", "send", "submit", "forward", "documents", "paperwork", "POD", "pod", "B.O.L.", "BOL", "bill of lading", "invoice", "billing", "accounts payable", "accounting", "remit", "quick pay", "quickpay", "to:", "at", "the", "load", "Zed", "Sentinel", "1234567", "(555) 010-0000"];
	const TRAIL = ["", "", "", ".", ",", ";", ")", ">", "]", ".)", "Please"];
	const SEPS = [" ", " ", "  ", "\n", ", ", ": ", " (", ") ", " <", "> ", "; ", " - "];
	const r = rng(2026);
	let mismatches = 0;
	let first = null;
	for (let k = 0; k < FUZZ_CASES; k++) {
		const words = [];
		const emails = [];
		const len = 1 + Math.floor(r() * 25);
		for (let q = 0; q < len; q++) {
			if (r() < 0.3) {
				const e = `${pick(r, LOCALS)}@${pick(r, DOMAINS)}`;
				emails.push(e);
				words.push(e + pick(r, TRAIL));
			} else words.push(pick(r, WORDS));
		}
		let s = "";
		for (const w of words) s += w + pick(r, SEPS);
		const exclude = r() < 0.5 && emails.length ? pick(r, emails) : r() < 0.5 ? `zed.agent@${pick(r, DOMAINS)}` : "";
		if (extractDocumentsEmail(s, { excludeEmail: exclude }) !== referenceDocumentsEmail(s, { excludeEmail: exclude })) {
			mismatches++;
			if (first === null) first = s;
		}
	}
	t(mismatches === 0, `§2 ${FUZZ_CASES} fuzzed notes give the same address as the reference`, `${mismatches} differ, first ${show(first || "")}`);
}

// §3 extractPdfText()'s budget
function pdfOf(contents) {
	const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
	contents.forEach((c, i) => {
		const data = zlib.deflateSync(Buffer.from(c, "latin1"));
		parts.push(Buffer.from(`${i + 1} 0 obj\n<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1"));
	});
	parts.push(Buffer.from("trailer\n<< >>\n%%EOF\n", "latin1"));
	return Buffer.concat(parts);
}
(async () => {
	t(PDF_TEXT_MAX_BYTES === 8 * 1024 * 1024, "§3 the default budget is 8 MB");
	const rc = pdfOf(["BT (Order #:) Tj (7007280) Tj (PO #:) Tj (4400123) Tj (Total Rate:) Tj ($2,450.00) Tj ET", "BT (Email documents to billing@zedsentinel.example.com) Tj ET"]);
	t(extractPdfText(rc) === extractPdfText(rc, { maxInflatedBytes: PDF_TEXT_MAX_BYTES }) && extractPdfText(rc) === extractPdfText(rc, { maxInflatedBytes: 64 * 1024 * 1024 }), "§3 a normal rate-con reads the same with any budget");
	const big = pdfOf(["(Order #: 7007280) Tj\n".repeat(420000)]);
	const t0 = Date.now();
	const capped = extractPdfText(big);
	t(Date.now() - t0 < TIMING_BUDGET_MS && capped === extractPdfText(big, { maxInflatedBytes: PDF_TEXT_MAX_BYTES }) && capped.length <= PDF_TEXT_MAX_BYTES && !/7007280/.test(capped), "§3 no maxInflatedBytes: a stream past 8 MB is not inflated");
	t(/7007280/.test(extractPdfText(big, { maxInflatedBytes: 16 * 1024 * 1024 })), "§3 a caller's own budget is kept");
	t(extractPdfText(big, { maxInflatedBytes: 0 }) === capped && extractPdfText(big, { maxInflatedBytes: NaN }) === capped, "§3 a budget that is not a positive number reads as the default");
	const fields = await extractRateConFields(rc);
	t(fields.orderNumber === "7007280" && fields.poNumber === "4400123" && fields.totalRate === formatMoney("2,450.00") && fields.documentsEmail === "billing@zedsentinel.example.com", "§3 extractRateConFields() reads a normal rate-con", JSON.stringify(fields));
	const t1 = Date.now();
	const bigFields = await extractRateConFields(big);
	t(Date.now() - t1 < TIMING_BUDGET_MS && bigFields.orderNumber === "", "§3 extractRateConFields() reads within the budget", JSON.stringify(bigFields));
	// A stream whose zlib header names a smaller window (256 bytes) than its data
	// uses, as some PDF writers produce: zlib's default window reads it. The body
	// repeats at a distance past that window and runs past one 16 KB output chunk.
	const r = rng(3);
	let filler = "";
	while (filler.length < 1500) filler += String.fromCharCode(97 + Math.floor(r() * 26));
	const body = `BT (Order #:) Tj (7007280) Tj ET\n${`${filler}\n`.repeat(24)}`;
	const z = zlib.deflateSync(Buffer.from(body, "latin1"));
	const cmf = 0x08;
	let flg = z[1] & 0xe0;
	flg += (31 - ((cmf * 256 + flg) % 31)) % 31;
	const narrow = Buffer.concat([Buffer.from([cmf, flg]), z.subarray(2)]);
	let headerWindowFails = false;
	try { zlib.inflateSync(narrow, {}); } catch { headerWindowFails = true; }
	t(zlib.inflateSync(narrow).toString("latin1") === body && headerWindowFails, "§3 fixture: the stream reads only with zlib's default window");
	const narrowPdf = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n", "latin1"), narrow, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]);
	const readBy = (opts) => scanBillingBlock(extractPdfText(narrowPdf, opts)).orderNumber;
	t(readBy(undefined) === "7007280" && readBy({ maxInflatedBytes: 1024 * 1024 }) === "7007280" && readBy({ maxInflatedBytes: PDF_TEXT_MAX_BYTES }) === "7007280", "§3 such a stream reads the same with any budget");

	// §4 size, one child process per scan, each with a time limit
	for (const fname of Object.keys(SIZE_FUNCTIONS)) {
		const child = spawnSync(process.execPath, [__filename, "--size", fname], { encoding: "utf8", timeout: SIZE_CHILD_LIMIT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
		if (child.status !== 0 || !child.stdout) {
			t(false, `§4 ${fname}(): large inputs are read within ${SIZE_CHILD_LIMIT_MS / 1000} s in all`, child.error ? child.error.code || child.error.message : `exit ${child.status} ${child.signal || ""} ${(child.stderr || "").slice(0, 200)}`);
		} else {
			const res = JSON.parse(child.stdout);
			t(res.over.length === 0, `§4 ${fname}(): ${res.count} reads of 256 KB inputs each under ${TIMING_BUDGET_MS} ms`, res.over.join(", "));
			console.log(`  slowest 256 KB read: ${res.slowest.name} ${res.slowest.ms.toFixed(1)} ms`);
		}
	}

	const ms = Date.now() - started;
	if (failures.length) {
		console.error(`\nFAILURES (${failures.length}):`);
		for (const f of failures) console.error(`  x ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed (${ms} ms)`);
		process.exit(1);
	}
	console.log(`\n${pass} assertions passed (${ms} ms)`);
})().catch((e) => {
	console.error(`FAILED: ${e && e.stack ? e.stack : e}`);
	process.exit(1);
});
