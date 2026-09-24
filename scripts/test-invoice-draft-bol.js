#!/usr/bin/env node
/**
 * Tests for WHICH rate-con candidates POST /api/loads/:loadId/draft-invoice may
 * read, and for what:
 *   • brokerInvoice.rateconSourceTrust() / readRateConCandidates()  (lib)
 *   • the BOL half of getRateConBytes() step 2                      (server.js)
 *   • loadsWithRateConOnFile(), the backfill's "already linked" set (server.js)
 *
 * THE PROPERTY UNDER TEST: a BOL never supplies the invoice's recipient, total,
 * order #, PO #, move # or trailer. When no rate-con exists it may ride along as
 * a supporting document — but it never stands in for a rate-con: it does not
 * outrank one, and it does not stop the by-content search (getRateConBytes()
 * step 4) or the backfill from looking for one.
 *
 * The fixtures are REAL PDFs run through the REAL extractRateConFields() (Gemini
 * off), and §2 first proves the BOL fixture would fill every field, the
 * recipient included, if it were read as a rate-con — so "nothing came out of
 * it" below is evidence, not a dead fixture. A BOL naming a paperwork inbox is
 * ordinary: shippers print their own on it, and that inbox is not the broker's AP.
 *
 * §5b pins the assumption this rests on from the other side: the types
 * POST /api/documents/upload offers a Driver or Dispatcher (uploadDocTypeFor())
 * never include a rate-con type.
 *
 * server.js functions are lifted out of its SOURCE, for the reason given in
 * test-invoice-overrides.js: requiring server.js opens SQLite, reads a service
 * account key and starts listening. Each extraction asserts exactly one
 * definition, so a rename fails loudly instead of testing nothing. In-memory
 * SQLite, stubbed Drive; no network, no app.db, no Gemini, no IMAP.
 *
 * §6 re-runs the core property against two planted mutants and requires both to
 * be caught.
 *
 * Run: node scripts/test-invoice-draft-bol.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Database = require("better-sqlite3");

const SERVER = path.join(__dirname, "..", "server.js");
const LIB = path.join(__dirname, "..", "lib", "broker-invoice.js");
const SRC = fs.readFileSync(SERVER, "utf8");
const LIB_SRC = fs.readFileSync(LIB, "utf8");
const brokerInvoice = require(LIB);
const rcIndexShared = require(path.join(__dirname, "..", "lib", "ratecon-drive-index.js"));

// ---------------------------------------------------------------- extraction
function extractFn(src, name) {
	const needles = [`\nfunction ${name}(`, `\nasync function ${name}(`];
	const hits = needles.reduce((n, nd) => n + (src.split(nd).length - 1), 0);
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const needle = needles.find((nd) => src.includes(nd));
	const start = src.indexOf(needle) + 1;
	// Match from the BODY's brace — getRateConBytes() has `opts = {}` in its
	// parameter list, and that `{}` would otherwise close the match at once.
	const bodyOpen = src.indexOf(") {", start);
	if (bodyOpen < 0) throw new Error(`no body found for ${name}()`);
	let depth = 0;
	for (let j = bodyOpen + 2; j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}
function extractConstLine(src, name) {
	const needle = `\nconst ${name} = `;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 declaration of ${name} in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1;
	return src.slice(start, src.indexOf("\n", start));
}
// A route registration by line range: from its `app.post(` line to the `);`
// that closes it at column 0.
function extractRoute(src, needle) {
	const lines = src.split("\n");
	const hits = lines.filter((l) => l.includes(needle)).length;
	if (hits !== 1) throw new Error(`expected exactly 1 line containing ${needle}, found ${hits}`);
	let s = lines.findIndex((l) => l.includes(needle));
	while (s > 0 && !/^app\.(post|get|put|delete)\(/.test(lines[s])) s--;
	let e = s;
	while (e < lines.length && lines[e] !== ");" && lines[e] !== "});") e++;
	if (e >= lines.length) throw new Error(`unterminated route registration for ${needle}`);
	return lines.slice(s, e + 1).join("\n");
}
// The shipped documents schema, not a hand-written copy of it.
function documentsSchema(src) {
	const m = src.match(/CREATE TABLE IF NOT EXISTS documents \([\s\S]*?\n\t\)/);
	if (!m) throw new Error("documents CREATE TABLE not found in server.js");
	return m[0];
}
// Load lib/broker-invoice.js from (possibly mutated) source text.
function loadLib(text) {
	const mod = { exports: {} };
	new Function("module", "exports", "require", "__dirname", "__filename", text)(mod, mod.exports, require, path.dirname(LIB), LIB);
	return mod.exports;
}
function mutate(src, from, to, label) {
	if (src.split(from).length - 1 !== 1) throw new Error(`mutant ${label}: expected exactly one site to mutate`);
	return src.replace(from, to);
}

// ------------------------------------------------------------------ fixtures
function pdfWith(contentStream) {
	const z = zlib.deflateSync(Buffer.from(contentStream, "latin1"));
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n1 0 obj<</Length ${z.length}/Filter/FlateDecode>>stream\n`, "latin1"),
		z,
		Buffer.from("\nendstream endobj\n%%EOF", "latin1"),
	]);
}
const BROKER_EMAIL = "agent@chrobinson.com"; // a non-Bison load: documentsEmail would become the To:
const PAPERWORK_INBOX = "billing@shipperco.example";
// Everything a rate-con reader looks for, printed on a BOL.
const BOL_PDF = pdfWith(
	"BT (BILL OF LADING  BOL #: 88812345) Tj " +
		"(Billing Information: Order #: 7101850 PO #: 2795482 Move #: 20110086) Tj " +
		"(Trailer: 24045) Tj (Total Rate: $1,800.00) Tj " +
		`(Email the signed BOL and all billing documents to ${PAPERWORK_INBOX}) Tj ET`,
);
// The same content as a rate-con — the control that makes §2 meaningful.
const RATECON_WITH_INBOX_PDF = pdfWith(
	"BT (Billing Information: Order #: 7101850 PO #: 2795482 Move #: 20110086) Tj " +
		"(Trailer: 24045) Tj (Total Rate: $1,800.00) Tj " +
		`(Email the signed BOL and all billing documents to ${PAPERWORK_INBOX}) Tj ET`,
);
// A rate-con that names no paperwork inbox.
const RATECON_PLAIN_PDF = pdfWith(
	"BT (Billing Information: Order #: 6990280 PO #: 2700001 Move #: 19000001) Tj " +
		"(Trailer: 51237) Tj (Total Rate: $2,100.00) Tj ET",
);
const EMPTY = { orderNumber: "", poNumber: "", moveNumber: "", trailerNumber: "", totalRate: "", documentsEmail: "" };

// The route's extract wrapper, minus Gemini, plus a spy on what was read.
function makeExtract(lib, spy) {
	return (buf, { alternate } = {}) => {
		spy.push({ buf, alternate: !!alternate });
		return lib.extractRateConFields(buf, { brokerEmail: BROKER_EMAIL, geminiExtract: null });
	};
}

// ----------------------------------------------------- server.js environment
// Builds getRateConBytes() + loadsWithRateConOnFile() from `serverSrc` against a
// fresh in-memory documents table and a stubbed Drive folder.
function makeEnv(serverSrc, { rows = [], bytes = {}, folder = "", driveFiles = [], driveBytes = {}, acceptId = null } = {}) {
	const db = new Database(":memory:");
	db.exec(documentsSchema(serverSrc));
	db.exec("ALTER TABLE documents ADD COLUMN deleted_at DATETIME DEFAULT NULL");
	const ins = db.prepare("INSERT INTO documents (load_id, driver, type, file_name, uploaded_at, deleted_at) VALUES (?, '', ?, ?, ?, ?)");
	for (const r of rows) ins.run(r.load_id, r.type, r.file_name, r.uploaded_at || "2026-09-01 00:00:00", r.deleted_at || null);

	const calls = { pick: 0, remembered: [], errors: [] };
	const drive = {
		files: {
			list: async () => ({ data: { files: driveFiles.slice(), nextPageToken: null } }),
			get: async ({ fileId }) => ({ data: driveBytes[fileId] }),
		},
	};
	const fakeRcIndex = {
		async pickRateConForLoad(ctx, files, readText) {
			calls.pick++;
			const hit = files.find((f) => f.id === acceptId);
			if (!hit) return { accepted: [], unconfirmed: [], scanned: files.length };
			await readText(hit);
			return { accepted: [{ file: hit, score: 3, reasons: ["id-in-document", "total-matches-sheet"] }], unconfirmed: [], scanned: files.length };
		},
	};
	const deps = {
		db,
		fetchDocumentBytes: async (row) => bytes[row.file_name] || null,
		RATECON_DRIVE_FOLDER_ID: folder,
		getDrive: async () => drive,
		rcIndexShared,
		rateconScanMissedRecently: () => false,
		rememberRateConScanMiss: () => {},
		rememberRateConMatch: (loadKey, file) => calls.remembered.push([loadKey, file.id]),
		require: (p) => {
			if (p === "./lib/ratecon-drive-index.js") return fakeRcIndex;
			throw new Error(`unexpected require(${p})`);
		},
		brokerInvoice,
		RATECON_CONTENT_WINDOW_DAYS: 21,
		RATECON_CONTENT_MAX_FILES: 40,
		RATECON_CONTENT_CONCURRENCY: 6,
		console: { log() {}, warn() {}, error: (...a) => calls.errors.push(a.join(" ")) },
	};
	const body = [
		extractConstLine(serverSrc, "RATECON_DOC_TYPES"),
		extractConstLine(serverSrc, "normLoadKey"),
		extractFn(serverSrc, "getRateConBytes"),
		extractFn(serverSrc, "loadsWithRateConOnFile"),
		"return { getRateConBytes, loadsWithRateConOnFile };",
	].join("\n");
	const names = Object.keys(deps);
	const fns = new Function(...names, body)(...names.map((n) => deps[n]));
	return { ...fns, calls, db };
}

// -------------------------------------------------------------------- runner
let pass = 0;
const failures = [];
function ok(cond, label) {
	if (cond) pass++;
	else failures.push(label);
}
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	ok(a === e, `${label}\n      expected ${e}\n      actual   ${a}`);
}
const sources = (cands) => (cands || []).map((c) => c.source);

// THE CORE PROPERTY, as a function so §6 can run it against mutants. A load
// whose only stored document is a BOL: the BOL is still attached, and the
// invoice goes to the broker DEFAULT with no total/order/PO/move/trailer from it.
// Returns the list of violations (empty = holds).
async function bolOnlyLoadViolations(serverSrc, lib) {
	const v = [];
	const env = makeEnv(serverSrc, {
		rows: [{ load_id: "555001", type: "BOL", file_name: "555001_BOL_1.pdf" }],
		bytes: { "555001_BOL_1.pdf": BOL_PDF },
	});
	const got = await env.getRateConBytes("555001", {}, null, { persist: false });
	if (!got.buffer || !got.buffer.equals(BOL_PDF)) v.push("the BOL is no longer attached as the supporting document");
	if (JSON.stringify(sources(got.candidates)) !== JSON.stringify(["documents-bol"])) v.push(`candidate sources ${JSON.stringify(sources(got.candidates))}, want ["documents-bol"]`);
	const spy = [];
	const read = await lib.readRateConCandidates(got.candidates, makeExtract(lib, spy));
	if (spy.length) v.push(`the BOL was passed to the extractor ${spy.length} time(s)`);
	for (const k of Object.keys(EMPTY)) if (read.fields[k]) v.push(`${k} was taken from the BOL: ${read.fields[k]}`);
	const to = lib.resolveInvoiceTo({ brokerEmail: BROKER_EMAIL, documentsEmail: read.fields.documentsEmail });
	if (to.email !== lib.DEFAULT_INVOICE_EMAIL) v.push(`recipient ${to.email}, want the default ${lib.DEFAULT_INVOICE_EMAIL}`);
	if (env.calls.errors.length) v.push(`getRateConBytes logged errors: ${env.calls.errors.join(" | ")}`);
	return v;
}

(async () => {
	// ------------------------------------------------------ §1 the trust table
	console.log("\n§1 rateconSourceTrust — every source classified, default deny");
	{
		const t = brokerInvoice.rateconSourceTrust;
		eq(t("drive"), { fields: true, recipient: true }, "§1 'drive' (matched by file name) is fully trusted");
		eq(t("documents"), { fields: true, recipient: true }, "§1 'documents' (a RATECON row) is fully trusted");
		eq(t("upload"), { fields: true, recipient: true }, "§1 'upload' (staff request body) is fully trusted");
		eq(t("drive-content"), { fields: true, recipient: false }, "§1 'drive-content' may fill fields but never the recipient");
		eq(t("documents-bol"), { fields: false, recipient: false }, "§1 'documents-bol' may supply nothing");
		for (const s of [undefined, null, "", "DOCUMENTS", "bol", "documents ", "__proto__", "constructor", "toString"]) {
			eq(t(s), { fields: false, recipient: false }, `§1 unknown source ${JSON.stringify(s)} must get no trust`);
		}
	}

	// ---------------------------------------------- §2 readRateConCandidates()
	console.log("§2 readRateConCandidates — real PDFs through the real extractor");
	{
		// CONTROL: the fixture is live. Read as a rate-con, this content fills every
		// field, the recipient included — so the empties below mean something.
		const spy = [];
		const asRatecon = await brokerInvoice.readRateConCandidates([{ buffer: RATECON_WITH_INBOX_PDF, source: "documents" }], makeExtract(brokerInvoice, spy));
		eq(asRatecon.fields.documentsEmail, PAPERWORK_INBOX, "§2 CONTROL: the fixture's paperwork inbox is extractable");
		eq(asRatecon.fields.orderNumber, "7101850", "§2 CONTROL: the fixture's order # is extractable");
		eq(asRatecon.fields.totalRate, "$1,800.00", "§2 CONTROL: the fixture's total is extractable");
		eq(asRatecon.fields.trailerNumber, "24045", "§2 CONTROL: the fixture's trailer is extractable");
		eq(brokerInvoice.resolveInvoiceTo({ brokerEmail: BROKER_EMAIL, documentsEmail: asRatecon.fields.documentsEmail }).email, PAPERWORK_INBOX,
			"§2 CONTROL: a rate-con's paperwork inbox does become the recipient");
		eq(spy.length, 1, "§2 CONTROL: the primary rate-con is read exactly once");

		// The same bytes as a BOL: nothing is read.
		const spy2 = [];
		const asBol = await brokerInvoice.readRateConCandidates([{ buffer: BOL_PDF, source: "documents-bol" }], makeExtract(brokerInvoice, spy2));
		eq(asBol.fields, EMPTY, "§2 a BOL primary supplies no field at all");
		eq(spy2.length, 0, "§2 a BOL primary is never passed to the extractor");
		eq([asBol.primarySource, asBol.primaryRead, asBol.recipientIgnored, asBol.recipientFrom], ["documents-bol", false, false, -1], "§2 BOL primary report");

		// A rate-con with no inbox + a BOL with one: the BOL does not choose the recipient.
		const spy3 = [];
		const rcThenBol = await brokerInvoice.readRateConCandidates(
			[{ buffer: RATECON_PLAIN_PDF, source: "documents" }, { buffer: BOL_PDF, source: "documents-bol" }],
			makeExtract(brokerInvoice, spy3),
		);
		eq(rcThenBol.fields.documentsEmail, "", "§2 an alternate BOL may not supply the recipient");
		eq([rcThenBol.fields.orderNumber, rcThenBol.fields.totalRate, rcThenBol.fields.trailerNumber], ["6990280", "$2,100.00", "51237"],
			"§2 the rate-con's own fields are untouched by a trailing BOL");
		ok(!spy3.some((c) => c.buf === BOL_PDF), "§2 the alternate-recipient loop never reads a BOL");

		// The recovery the loop exists for still works between two RATE-CONS
		// (client 2026-07-30, Steam Logistics load 2214407).
		const spy4 = [];
		const twoRatecons = await brokerInvoice.readRateConCandidates(
			[{ buffer: RATECON_PLAIN_PDF, source: "documents" }, { buffer: RATECON_WITH_INBOX_PDF, source: "drive" }],
			makeExtract(brokerInvoice, spy4),
		);
		eq([twoRatecons.fields.documentsEmail, twoRatecons.recipientFrom], [PAPERWORK_INBOX, 1], "§2 an alternate RATE-CON still supplies the recipient");
		eq(spy4.map((c) => c.alternate), [false, true], "§2 the alternate read is flagged so the route can drop Gemini there");

		// Unchanged: a content-matched primary fills fields but not the recipient.
		const content = await brokerInvoice.readRateConCandidates([{ buffer: RATECON_WITH_INBOX_PDF, source: "drive-content" }], makeExtract(brokerInvoice, []));
		eq([content.fields.documentsEmail, content.recipientIgnored, content.fields.orderNumber], ["", true, "7101850"],
			"§2 'drive-content' keeps its fields and loses its recipient");

		// Default deny, and the empty load.
		const spy5 = [];
		const unknown = await brokerInvoice.readRateConCandidates([{ buffer: RATECON_WITH_INBOX_PDF, source: "somewhere-new" }], makeExtract(brokerInvoice, spy5));
		eq([unknown.fields, spy5.length], [EMPTY, 0], "§2 an unclassified source is read for nothing");
		const none = await brokerInvoice.readRateConCandidates([], makeExtract(brokerInvoice, []));
		eq([none.fields, none.primarySource], [EMPTY, null], "§2 no candidates → empty fields");
		const thrown = [];
		const altThrows = await brokerInvoice.readRateConCandidates(
			[{ buffer: RATECON_PLAIN_PDF, source: "documents" }, { buffer: RATECON_WITH_INBOX_PDF, source: "documents" }],
			(buf) => { if (buf === RATECON_WITH_INBOX_PDF) throw new Error("boom"); return brokerInvoice.extractRateConFields(buf, { geminiExtract: null }); },
			{ onAlternateError: (e) => thrown.push(e.message) },
		);
		eq([altThrows.fields.orderNumber, thrown], ["6990280", ["boom"]], "§2 an alternate that throws is reported and skipped");
	}

	// ------------------------------------------------ §3 getRateConBytes() step 2
	console.log("§3 getRateConBytes — BOL rows are tagged, ranked last, and do not suppress step 4");
	{
		const v = await bolOnlyLoadViolations(SRC, brokerInvoice);
		eq(v, [], "§3 a BOL-only load: BOL attached, default recipient, no total/order/PO/move/trailer");

		// A rate-con outranks a NEWER BOL.
		const e1 = makeEnv(SRC, {
			rows: [
				{ load_id: "555002", type: "RATECON", file_name: "rc.pdf", uploaded_at: "2026-09-01 00:00:00" },
				{ load_id: "555002", type: "BOL", file_name: "bol.pdf", uploaded_at: "2026-09-05 00:00:00" },
			],
			bytes: { "rc.pdf": RATECON_PLAIN_PDF, "bol.pdf": BOL_PDF },
		});
		const g1 = await e1.getRateConBytes("555002", {}, null);
		eq(sources(g1.candidates), ["documents", "documents-bol"], "§3 RATECON first, BOL last");
		ok(g1.buffer && g1.buffer.equals(RATECON_PLAIN_PDF), "§3 the rate-con is the attached primary");

		// A staff-supplied upload outranks a stored BOL.
		const e2 = makeEnv(SRC, { rows: [{ load_id: "555003", type: "BOL", file_name: "bol.pdf" }], bytes: { "bol.pdf": BOL_PDF } });
		const g2 = await e2.getRateConBytes("555003", { rateconPdfBase64: RATECON_PLAIN_PDF.toString("base64") }, null);
		eq(sources(g2.candidates), ["upload", "documents-bol"], "§3 a body upload outranks a BOL");

		// Every stored spelling of the two types.
		const e3 = makeEnv(SRC, {
			rows: [
				{ load_id: "555004", type: "rate con", file_name: "a.pdf", uploaded_at: "2026-09-03 00:00:00" },
				{ load_id: "555004", type: "Rate_Con", file_name: "b.pdf", uploaded_at: "2026-09-02 00:00:00" },
				{ load_id: "555004", type: "bol", file_name: "c.pdf", uploaded_at: "2026-09-04 00:00:00" },
				{ load_id: "555004", type: "POD", file_name: "d.pdf" },
			],
			bytes: { "a.pdf": RATECON_PLAIN_PDF, "b.pdf": RATECON_PLAIN_PDF, "c.pdf": BOL_PDF, "d.pdf": BOL_PDF },
		});
		const g3 = await e3.getRateConBytes("555004", {}, null);
		eq(sources(g3.candidates), ["documents", "documents", "documents-bol"], "§3 'rate con'/'Rate_Con' are rate-cons, 'bol' is a BOL, a POD is neither");

		// ⚠️ A BOL does not stop step 4 from looking for the real rate-con, and a
		// hit outranks it.
		const RC_FILE = { id: "drv-1", name: "Subject: Broker Order #7101850", createdTime: "2026-09-01T00:00:00Z" };
		const e4 = makeEnv(SRC, {
			rows: [{ load_id: "555005", type: "BOL", file_name: "bol.pdf" }],
			bytes: { "bol.pdf": BOL_PDF },
			folder: "folder-1",
			driveFiles: [RC_FILE],
			driveBytes: { "drv-1": RATECON_WITH_INBOX_PDF },
			acceptId: "drv-1",
		});
		const g4 = await e4.getRateConBytes("555005", {}, { totalRate: 1800 }, { persist: false });
		eq(e4.calls.pick, 1, "§3 a BOL-only load still gets the by-content search");
		eq(sources(g4.candidates), ["drive-content", "documents-bol"], "§3 the content-matched rate-con outranks the BOL");
		ok(g4.buffer && g4.buffer.equals(RATECON_WITH_INBOX_PDF), "§3 the found rate-con is the attached primary");

		// Unchanged: a real rate-con on file means no search.
		const e5 = makeEnv(SRC, {
			rows: [{ load_id: "555006", type: "RATECON", file_name: "rc.pdf" }],
			bytes: { "rc.pdf": RATECON_PLAIN_PDF },
			folder: "folder-1",
			driveFiles: [RC_FILE],
			driveBytes: { "drv-1": RATECON_WITH_INBOX_PDF },
			acceptId: "drv-1",
		});
		await e5.getRateConBytes("555006", {}, { totalRate: 1800 });
		eq(e5.calls.pick, 0, "§3 a stored rate-con still skips the by-content search");
		eq([...e1.calls.errors, ...e2.calls.errors, ...e3.calls.errors, ...e4.calls.errors, ...e5.calls.errors], [], "§3 no scenario logged an error");
	}

	// --------------------------------------------- §4 loadsWithRateConOnFile()
	console.log("§4 loadsWithRateConOnFile — the backfill does not count a BOL as linked");
	{
		const env = makeEnv(SRC, {
			rows: [
				{ load_id: "700001", type: "RATECON", file_name: "a.pdf" },
				{ load_id: "700002", type: "BOL", file_name: "b.pdf" },
				{ load_id: "700003", type: "rate con", file_name: "c.pdf" },
				{ load_id: "700004", type: "RATECON", file_name: "d.pdf", deleted_at: "2026-09-02 00:00:00" },
				{ load_id: "#700005", type: "Rate_Con", file_name: "e.pdf" },
				{ load_id: "700006", type: "POD", file_name: "f.pdf" },
			],
		});
		eq([...env.loadsWithRateConOnFile()].sort(), ["700001", "700003", "700005"], "§4 only live rate-con rows count; a BOL-only load is still pending");
	}

	// ------------------------------------------------------ §5 route wiring
	console.log("§5 route wiring — the policy is the only way in");
	{
		// CODE only — the route's comments name these functions too.
		const codeOf = (text) => text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
		const route = codeOf(extractRoute(SRC, '["/api/loads/:loadId/draft-invoice", "/api/loads/:loadId/draft-bison-invoice"],'));
		eq((route.match(/brokerInvoice\.readRateConCandidates\(/g) || []).length, 1, "§5 the route reads rate-con fields through readRateConCandidates() once");
		eq((route.match(/brokerInvoice\.extractRateConFields\(/g) || []).length, 1, "§5 extractRateConFields() appears only as the reader's extract callback");
		ok(route.indexOf("brokerInvoice.readRateConCandidates(") < route.indexOf("brokerInvoice.extractRateConFields("),
			"§5 the extractRateConFields() call sits inside the readRateConCandidates() call");
		ok(!/\.source\s*[!=]==?/.test(route), "§5 no hand-written source comparison in the route — trust lives in rateconSourceTrust()");
		const backfill = codeOf(extractRoute(SRC, 'app.post("/api/admin/ratecon-index"'));
		ok(/const linked = loadsWithRateConOnFile\(\);/.test(backfill), "§5 the backfill takes its linked set from loadsWithRateConOnFile()");
		ok(!/'BOL'/.test(backfill), "§5 the backfill names no BOL type of its own");
	}

	// ------------------------------------- §5b the upload types, from the other side
	console.log("§5b uploadDocTypeFor — a Driver or Dispatcher can never store a rate-con type");
	{
		const RATECON_DOC_TYPES = new Function(`${extractConstLine(SRC, "RATECON_DOC_TYPES")}\nreturn RATECON_DOC_TYPES;`)();
		const fnText = extractFn(SRC, "uploadDocTypeFor");
		const uploadDocTypeFor = new Function(`${fnText}\nreturn uploadDocTypeFor;`)();
		const listMatch = fnText.match(/const UPLOAD_DOC_TYPES = (\[[^\]]*\]);/);
		ok(listMatch, "§5b UPLOAD_DOC_TYPES literal not found inside uploadDocTypeFor() — re-point this check");
		const offered = listMatch ? JSON.parse(listMatch[1]) : [];
		ok(offered.length > 0, "§5b the upload type list is empty");
		eq(offered.filter((t) => RATECON_DOC_TYPES.includes(String(t).toUpperCase())), [], "§5b an upload type a Driver/Dispatcher may pick is a rate-con type");
		const spellings = [...RATECON_DOC_TYPES, "ratecon", "Rate Con", "rate_con", " RATECON ", "RateCon"];
		for (const role of ["Driver", "Dispatcher"]) {
			for (const s of spellings) {
				const stored = uploadDocTypeFor(role, s);
				ok(stored === null || !RATECON_DOC_TYPES.includes(String(stored).toUpperCase()), `§5b ${role} upload typed ${JSON.stringify(s)} is stored as a rate-con (${JSON.stringify(stored)})`);
			}
			// The BOL a Driver/Dispatcher stores must be one step 2 classifies as a BOL.
			const bol = uploadDocTypeFor(role, "bol");
			eq(String(bol).toUpperCase(), "BOL", `§5b ${role}'s BOL is stored in a spelling step 2 reads as a BOL`);
		}
	}

	// --------------------------------------------------------- §6 mutants
	console.log("§6 mutants — the core property must catch each");
	// A mutant whose site is gone is a FAILURE, not a crash: the guarded line
	// was rewritten, so this section no longer proves anything until it is
	// re-pointed — and the other sections' failures must still be printed.
	const runMutant = async (label, build) => {
		let violations;
		try {
			violations = await build();
		} catch (e) {
			ok(false, `§6 ${label}: ${e.message}`);
			return;
		}
		ok(violations.length > 0, `§6 ${label} was NOT caught`);
		if (violations.length) console.log(`   ${label} caught: ${violations.length} violation(s), e.g. "${violations[0]}"`);
	};
	// M1: the trust table lets a BOL be read.
	await runMutant("M1 (BOL marked readable in the trust table)", () =>
		bolOnlyLoadViolations(SRC, loadLib(mutate(LIB_SRC,
			'["documents-bol", Object.freeze({ fields: false, recipient: false })],',
			'["documents-bol", Object.freeze({ fields: true, recipient: true })],', "M1"))));
	// M2: step 2 tags a BOL row as a rate-con again.
	await runMutant("M2 (BOL rows tagged 'documents' in getRateConBytes)", () =>
		bolOnlyLoadViolations(mutate(SRC, 'source: isRateCon ? "documents" : "documents-bol",', 'source: "documents",', "M2"), brokerInvoice));

	console.log("");
	if (failures.length) {
		for (const f of failures) console.log(`  FAIL  ${f}`);
		console.log(`\n${pass} passed, ${failures.length} FAILED`);
		process.exit(1);
	}
	console.log(`${pass} passed, 0 failed`);
})().catch((e) => {
	for (const f of failures) console.log(`  FAIL  ${f}`);
	console.error("runner crashed:", e && e.stack ? e.stack : e);
	process.exit(1);
});
