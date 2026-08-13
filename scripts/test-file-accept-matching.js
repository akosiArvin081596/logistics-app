#!/usr/bin/env node
// Deterministic check on client/src/lib/fileValidation.js — the type/size gate
// that every drag-and-drop upload surface depends on.
//
// WHY THIS EXISTS. The `accept` attribute filters the OS file dialog and nothing
// else; a file arriving by DROP bypasses it entirely. Before drag-and-drop, a
// surface could carry `accept="application/pdf"` and be correct, because the only
// way in was the dialog. The moment that surface accepts drops, `accept` becomes
// decorative and this module is the whole gate — so a bug here is the difference
// between refusing a .docx and shipping it to Gemini for OCR.
//
// The two cases that actually bite are BLANK MIME TYPES, and they are not exotic:
// Windows hands us PDFs with file.type === '', and every non-Safari browser does
// the same for iPhone HEIC. Those are the two formats this app receives most.
// BulkReceiptScan's accept string today is `image/*,.heic,.heif,application/pdf`
// with NO `.pdf` token — under strict matching that refuses a Windows PDF which
// its own isPdfFile() accepts. Case 3 below locks the fix.
//
// A test that only proved "PDFs are accepted" would pass on `() => true`. Every
// case is therefore paired: the file that must be REFUSED is asserted alongside.
//
// No network, no sheet, no database — pure input/output, safe to run anywhere.
//
//   node scripts/test-file-accept-matching.js     # exits 1 on any failure

const path = require("path");
const { pathToFileURL } = require("url");

const MODULE_PATH = path.join(__dirname, "..", "client", "src", "lib", "fileValidation.js");

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		pass++;
	} else {
		fail++;
		console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
	}
}

// Minimal stand-in for the File interface. validateFiles/matchesAccept read only
// name, type and size, so this is the whole contract — no jsdom required.
function f(name, type, size = 1024) {
	return { name, type, size };
}

// Real accept strings, copied from the surfaces they belong to.
const A_RATECON = "application/pdf,.pdf";
const A_RECEIPT = "image/*,.heic,.heif,application/pdf,.pdf";
const A_RECEIPT_TODAY = "image/*,.heic,.heif,application/pdf"; // BulkReceiptScan as shipped — no .pdf
// Kept in sync with CHAT_ATTACH_ACCEPT in client/src/lib/chatAttachment.js.
// It admits .heic/.heif on purpose: the composers CONVERT a HEIC to JPEG (and
// rename it to .jpg, because ALLOWED_FILE_EXTS has no .heic and the server
// checks magic bytes against the extension) rather than refusing it. An earlier
// revision of this file asserted the opposite — that a blank-MIME HEIC was
// refused here — which was true when chat could not handle HEIC at all.
const A_CHAT = "image/*,application/pdf,.pdf,.heic,.heif";
// The pre-conversion chat surface, retained ONLY to keep proving that a bare
// `image/*,.pdf` really does refuse a blank-MIME HEIC. That is the behaviour
// the conversion path exists to replace, so it has to stay demonstrable.
const A_CHAT_LEGACY = "image/*,.pdf";
const A_DRUGTEST = ".pdf,.jpg,.jpeg,.png";
const A_IMAGE = "image/*";
const A_NONE = ""; // LegalDocumentPortal — server is the authority

(async () => {
	const { matchesAccept, describeAccept, validateFiles, summarizeRejections, REJECT_TYPE, REJECT_SIZE, REJECT_EMPTY, REJECT_COUNT } =
		await import(pathToFileURL(MODULE_PATH).href);

	// ── 1. Ordinary MIME matching, both directions ───────────────────────────
	check("jpeg vs image/*", matchesAccept(f("a.jpg", "image/jpeg"), A_IMAGE), true);
	check("pdf vs image/* REFUSED", matchesAccept(f("a.pdf", "application/pdf"), A_IMAGE), false);
	check("docx vs receipt REFUSED", matchesAccept(f("notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), A_RECEIPT), false);
	check("exact MIME application/pdf", matchesAccept(f("rc.pdf", "application/pdf"), A_RATECON), true);

	// ── 2. The wildcard must compare the GROUP, not a string prefix ──────────
	// A prefix test would let "imagex/foo" through on token "image/*".
	check("imagex/foo vs image/* REFUSED", matchesAccept(f("x.bin", "imagex/foo"), A_IMAGE), false);
	check("image/png vs image/*", matchesAccept(f("x.png", "image/png"), A_IMAGE), true);

	// ── 3. BLANK MIME — the Windows PDF case. This is the shipped bug. ───────
	check("blank-MIME pdf vs receipt-with-.pdf", matchesAccept(f("scan.pdf", ""), A_RECEIPT), true);
	check("blank-MIME pdf vs receipt-AS-SHIPPED REFUSED", matchesAccept(f("scan.pdf", ""), A_RECEIPT_TODAY), false);
	check("blank-MIME pdf vs ratecon", matchesAccept(f("rc.PDF", ""), A_RATECON), true);

	// ── 4. BLANK MIME — iPhone HEIC on every non-Safari browser ──────────────
	check("blank-MIME heic vs receipt", matchesAccept(f("IMG_0421.HEIC", ""), A_RECEIPT), true);
	check("safari heic by MIME vs receipt", matchesAccept(f("IMG_0421.heic", "image/heic"), A_RECEIPT), true);
	check("blank-MIME heic vs chat ACCEPTED (converted)", matchesAccept(f("IMG_0421.HEIC", ""), A_CHAT), true);
	check("blank-MIME heic vs LEGACY chat REFUSED", matchesAccept(f("IMG_0421.HEIC", ""), A_CHAT_LEGACY), false);

	// ── 5. Extension tokens are case-insensitive both ways ───────────────────
	check("uppercase name vs lowercase token", matchesAccept(f("RESULT.PDF", ""), A_DRUGTEST), true);
	check("webp vs drug-test REFUSED", matchesAccept(f("x.webp", "image/webp"), A_DRUGTEST), false);

	// ── 6. Empty accept means EVERYTHING — LegalDocumentPortal relies on it ──
	check("empty accept takes docx", matchesAccept(f("policy.docx", ""), A_NONE), true);
	check("empty accept takes anything", matchesAccept(f("weird.xyz", "application/x-weird"), A_NONE), true);

	// ── 7. describeAccept ────────────────────────────────────────────────────
	check("describe empty is blank", describeAccept(A_NONE), "");
	check("describe dedupes pdf", describeAccept(A_RATECON), "PDF");
	check("describe image group", describeAccept(A_IMAGE), "images");
	check("describe two", describeAccept(A_CHAT_LEGACY), "images or PDF");
	check("describe chat dedupes pdf, keeps heic/heif", describeAccept(A_CHAT), "images, PDF, HEIC or HEIF");
	check("describe drug test", describeAccept(A_DRUGTEST), "PDF, JPG, JPEG or PNG");

	// ── 8. Size cap ──────────────────────────────────────────────────────────
	{
		const big = f("huge.pdf", "application/pdf", 20 * 1024 * 1024);
		const ok = f("fine.pdf", "application/pdf", 2 * 1024 * 1024);
		const r = validateFiles([big, ok], { accept: A_RATECON, multiple: true, maxSizeMb: 15 });
		check("size: accepted count", r.accepted.length, 1);
		check("size: accepted is the small one", r.accepted[0].name, "fine.pdf");
		check("size: reason", r.rejections[0].reason, REJECT_SIZE);
		check("size: message names the limit", /20 MB — the limit is 15 MB/.test(r.rejections[0].message), true);
	}

	// ── 9. A dropped FOLDER is a zero-byte File with no type ─────────────────
	// Without this it passes every other check and "uploads" nothing.
	{
		const r = validateFiles([f("Receipts", "", 0)], { accept: A_NONE, multiple: true });
		check("folder: refused", r.accepted.length, 0);
		check("folder: reason", r.rejections[0].reason, REJECT_EMPTY);
		check("folder: message tells them what to do", /open it and drag the files inside/.test(r.rejections[0].message), true);
	}
	// A zero-byte file that DOES carry a type is just empty, not a folder.
	{
		const r = validateFiles([f("blank.pdf", "application/pdf", 0)], { accept: A_RATECON });
		check("empty file: refused", r.accepted.length, 0);
		check("empty file: no folder hint", /folder/.test(r.rejections[0].message), false);
	}

	// ── 10. Single-file surfaces trim, and SAY they trimmed ──────────────────
	{
		const r = validateFiles([f("a.pdf", "application/pdf"), f("b.pdf", "application/pdf")], { accept: A_RATECON, multiple: false });
		check("single: keeps first", r.accepted.map((x) => x.name), ["a.pdf"]);
		check("single: reports the rest", r.rejections.length, 1);
		check("single: reason", r.rejections[0].reason, REJECT_COUNT);
	}

	// ── 11. maxFiles is REMAINING capacity, so the count in the copy is right ─
	{
		const files = [f("1.jpg", "image/jpeg"), f("2.jpg", "image/jpeg"), f("3.jpg", "image/jpeg")];
		const r = validateFiles(files, { accept: A_RECEIPT, multiple: true, maxFiles: 2 });
		check("cap: accepted", r.accepted.length, 2);
		check("cap: rejected", r.rejections.length, 1);
		check("cap: message counts remaining", /only 2 more files fit/.test(r.rejections[0].message), true);
	}
	{
		// Already full — cap 0 must not read as "no limit".
		const r = validateFiles([f("1.jpg", "image/jpeg")], { accept: A_RECEIPT, multiple: true, maxFiles: 0 });
		check("cap 0 is unlimited (matches the option contract)", r.accepted.length, 1);
	}

	// ── 12. A REJECTED file must not consume a slot ──────────────────────────
	// Otherwise dropping [bad, good] with room for one silently drops the good one.
	{
		const r = validateFiles([f("bad.docx", ""), f("good.jpg", "image/jpeg")], { accept: A_RECEIPT, multiple: true, maxFiles: 1 });
		check("rejected file frees its slot", r.accepted.map((x) => x.name), ["good.jpg"]);
		check("rejected file still reported", r.rejections[0].reason, REJECT_TYPE);
	}

	// ── 13. Mixed batch keeps the good ones — never all-or-nothing ───────────
	{
		const r = validateFiles(
			[f("a.jpg", "image/jpeg"), f("b.docx", ""), f("c.pdf", ""), f("d.exe", "application/x-msdownload")],
			{ accept: A_RECEIPT, multiple: true },
		);
		check("mixed: accepted", r.accepted.map((x) => x.name), ["a.jpg", "c.pdf"]);
		check("mixed: rejected", r.rejections.map((x) => x.file.name), ["b.docx", "d.exe"]);
	}

	// ── 14. Degenerate inputs must not throw ─────────────────────────────────
	check("null files", validateFiles(null, { accept: A_RECEIPT }).accepted.length, 0);
	check("empty list", validateFiles([], { accept: A_RECEIPT }).rejections.length, 0);
	check("null file vs accept", matchesAccept(null, A_RECEIPT), false);
	check("null file vs empty accept", matchesAccept(null, A_NONE), true);
	check("accept with stray spaces", matchesAccept(f("a.pdf", ""), "image/*, .pdf "), true);

	// ── 15. summarizeRejections ──────────────────────────────────────────────
	check("summarize none", summarizeRejections([]), "");
	check("summarize one is verbatim", summarizeRejections([{ message: "nope" }]), "nope");
	check("summarize many counts the rest", summarizeRejections([{ message: "nope" }, { message: "x" }, { message: "y" }]), "nope (2 other files also refused.)");

	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail) process.exit(1);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
