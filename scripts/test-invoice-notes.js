#!/usr/bin/env node
/**
 * Tests for INVOICE NOTES and the widened ORDER # on the broker draft invoice —
 * the half of the feature that scripts/test-invoice-overrides.js cannot reach,
 * because that runner stops at the validator.
 *
 *   §1 RENDERING. buildInvoiceHtml() prints a note in a labelled box beside the
 *      totals. The note is dispatcher-typed text inside an HTML document that
 *      Chromium renders, so esc() is the whole guard; its line breaks must
 *      survive as real "\n" characters (shown by `white-space: pre-wrap`), never
 *      be rebuilt as <br> markup. And with NO note the document must be the
 *      exact bytes it was before notes existed, so every invoice already issued
 *      re-renders unchanged.
 *
 *   §2 THE SUBJECT. buildInvoiceSubject() is an email HEADER, not HTML. It must
 *      survive nodemailer's MailComposer — which folds long headers and
 *      RFC 2047-encodes non-ASCII ones — byte for byte, with "&" still "&". The
 *      attachment file name is checked the same way (RFC 2231 when it must be).
 *
 *   §3 PERSISTENCE. The approve stores the note on load_invoice_drafts and the
 *      next dryRun reads the newest one back. This runs the REAL SQL: the
 *      CREATE TABLE and every ALTER for that table, the INSERT inside the
 *      shipped recordDraft() closure, and latestDraftNotes() — all lifted from
 *      server.js text into an in-memory SQLite, never retyped here.
 *
 * WHY server.js IS READ AS TEXT: it opens SQLite, reads a service-account key
 * and starts listening on import. Same approach as test-invoice-overrides.js;
 * every extraction asserts its needle is found exactly once, so a rename fails
 * loudly instead of testing nothing.
 *
 * Plain node, no server, no fixtures, no network, never touches app.db.
 * Run: node scripts/test-invoice-notes.js
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
const { buildMime } = require(path.join(ROOT, "lib", "imap-draft.js"));

// -------------------------------------------------------------------- runner
let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log(`\n${t}`); }

// ---------------------------------------------------------------- extraction
function countOf(hay, needle) { return hay.split(needle).length - 1; }

// From the first `{` at/after `from` to its matching `}` (inclusive).
function braceBlock(src, from) {
	const open = src.indexOf("{", from);
	let depth = 0;
	for (let j = open; j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(from, j + 1); }
	}
	throw new Error("unbalanced braces");
}
function extractFn(src, name) {
	const needle = `\nfunction ${name}(`;
	const hits = countOf(src, needle);
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	return braceBlock(src, src.indexOf(needle) + 1);
}

// ============================================================ §1 RENDERING
function renderingSection() {
	section("1. buildInvoiceHtml — the Notes box");
	const BASE = {
		invoiceId: "08142026-1",
		invoiceDate: "08/14/2026",
		brokerName: "Bison Transport",
		invoiceTo: brokerInvoice.resolveInvoiceTo({ brokerEmail: "ap@bisontransport.com" }),
		orderNumber: "7101850-$700 ADV",
		poNumber: "4471",
		deliveryDate: "08/12/2026",
		total: "$3,000.00",
	};
	const NOTE = "Advance $700\nPaid at dock <b>x</b> & more";
	const withNote = brokerInvoice.buildInvoiceHtml({ ...BASE, notes: NOTE });
	const ESCAPED = "Advance $700\nPaid at dock &lt;b&gt;x&lt;/b&gt; &amp; more";

	ok(withNote.includes('<div class="label">Notes</div>'), "§1 a note prints under the label \"Notes\"");
	ok(withNote.includes("&lt;b&gt;x&lt;/b&gt; &amp; more"), "§1 the note's markup and & are HTML-escaped");
	ok(!withNote.includes("<b>x"), "§1 …and no raw <b> from the note reaches the document");
	ok(withNote.includes(`<div class="body">${ESCAPED}</div>`),
		"§1 the body div holds the escaped note with its literal \\n intact (no <br> built from typed text)");
	ok(!/<br\s*\/?>/i.test(withNote), "§1 no <br> anywhere — line breaks are pre-wrap, not markup");
	ok(withNote.includes('<div class="totals has-notes">'), "§1 the totals row carries class=\"totals has-notes\"");
	ok(withNote.indexOf('<div class="notes">') > withNote.indexOf('<div class="totals has-notes">')
		&& withNote.indexOf('<div class="notes">') < withNote.indexOf('<div class="box">'),
		"§1 the Notes box sits inside the totals row, BEFORE (left of) the totals box");
	ok(/\.notes \.body \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/.test(withNote),
		"§1 the body is pre-wrap and wraps a long unbroken token instead of overflowing the page");
	eq(countOf(withNote, "</style>"), 1, "§1 the extra CSS lands inside the one <style> block");
	// An attribute-breaking note is inert too.
	const quoty = brokerInvoice.buildInvoiceHtml({ ...BASE, notes: `"><script>alert('x')</script>` });
	ok(quoty.includes("&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;") && !quoty.includes("<script>"),
		"§1 quotes and a script tag in a note are escaped");
	// The renderer trims too, so a padded note prints without stray blank lines.
	ok(brokerInvoice.buildInvoiceHtml({ ...BASE, notes: "\n\n  hi  \n" }).includes('<div class="body">hi</div>'),
		"§1 a padded note is trimmed before printing");

	// ⚠️ NO NOTE → BYTE-IDENTICAL. Every "no note" spelling must produce exactly
	// the document a call without the key produces, with no trace of the feature.
	for (const [label, base] of [["Bison", BASE], ["non-Bison, no PO, no broker", { ...BASE, brokerName: "", poNumber: "", invoiceTo: undefined }]]) {
		const plain = brokerInvoice.buildInvoiceHtml(base);
		ok(!plain.includes("has-notes") && !plain.includes('class="notes"') && !plain.includes(".notes"),
			`§1 ${label}: without a note there is no notes class, box or CSS`);
		for (const v of ["", "   \n  ", undefined, null]) {
			eq(brokerInvoice.buildInvoiceHtml({ ...base, notes: v }) === plain, true,
				`§1 ${label}: notes ${JSON.stringify(v)} renders byte-identical to no notes key`);
		}
	}

	// Notes are PDF-only (owner decision): the cover email must not move, even
	// when a note is passed to it by mistake.
	eq(brokerInvoice.buildInvoiceEmailHtml({ ...BASE, isBison: true, notes: NOTE }),
		brokerInvoice.buildInvoiceEmailHtml({ ...BASE, isBison: true }),
		"§1 buildInvoiceEmailHtml ignores notes — the email body is unchanged");
}

// ======================================================= §2 SUBJECT + MIME
// Minimal RFC 5322 / 2047 / 2231 readers — only what MailComposer emits.
function unfold(mime) { return mime.replace(/\r\n([ \t])/g, "$1"); }
function decode2047(s) {
	// Whitespace BETWEEN two encoded words is not part of the text.
	return s
		.replace(/(\?=)[ \t]+(=\?)/g, "$1$2")
		.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_, charset, enc, text) => {
			const bytes = enc.toUpperCase() === "B"
				? Buffer.from(text, "base64")
				: Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
			return bytes.toString(/^utf-?8$/i.test(charset) ? "utf8" : "latin1");
		});
}
function topHeader(mime, name) {
	const head = unfold(mime).split("\r\n\r\n")[0];
	const line = head.split("\r\n").find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));
	return line == null ? null : line.slice(name.length + 1).trim();
}
function splitParams(value) {
	const out = [];
	let cur = "", q = false;
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (c === "\\" && q) { cur += c + value[++i]; continue; }
		if (c === '"') q = !q;
		if (c === ";" && !q) { out.push(cur.trim()); cur = ""; continue; }
		cur += c;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}
function attachmentFilename(mime) {
	const line = unfold(mime).split("\r\n").find((l) => /^Content-Disposition:\s*attachment/i.test(l));
	if (!line) return null;
	const unq = (v) => (v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);
	const parts = [];
	let plain = null;
	for (const p of splitParams(line.replace(/^Content-Disposition:\s*/i, "")).slice(1)) {
		const eqAt = p.indexOf("=");
		const key = p.slice(0, eqAt).trim().toLowerCase();
		const val = unq(p.slice(eqAt + 1).trim());
		let m;
		if (key === "filename") plain = decode2047(val);
		else if (key === "filename*") parts.push({ n: 0, enc: true, val });
		else if ((m = /^filename\*(\d+)(\*)?$/.exec(key))) parts.push({ n: +m[1], enc: !!m[2], val });
	}
	if (!parts.length) return plain;
	parts.sort((a, b) => a.n - b.n);
	let charset = "utf-8";
	const bytes = [];
	for (const part of parts) {
		let v = part.val;
		if (part.enc && part.n === 0) {
			const m = /^([^']*)'[^']*'(.*)$/.exec(v);
			if (m) { charset = m[1] || charset; v = m[2]; }
		}
		if (part.enc) {
			for (let i = 0; i < v.length; i++) {
				if (v[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(v.slice(i + 1, i + 3))) { bytes.push(parseInt(v.slice(i + 1, i + 3), 16)); i += 2; }
				else bytes.push(...Buffer.from(v[i], "utf8"));
			}
		} else bytes.push(...Buffer.from(v, "utf8"));
	}
	return Buffer.from(bytes).toString(/^utf-?8$/i.test(charset) ? "utf8" : "latin1");
}

async function subjectSection() {
	section("2. buildInvoiceSubject — plain text, and it survives the MIME round trip");
	const S = brokerInvoice.buildInvoiceSubject;
	eq(S({ brokerName: "Bison Transport", orderNumber: "7101850-$700 ADV" }), "Bison Transport Order #7101850-$700 ADV",
		"§2 \"<Broker> Order #<n>\" — the exact shape both routes printed inline before");
	eq(S({ orderNumber: "7101850-$700 ADV" }), "Order #7101850-$700 ADV", "§2 no broker name → \"Order #<n>\"");
	eq(S({ brokerName: "", orderNumber: "563367203" }), "Order #563367203", "§2 an empty broker name → \"Order #<n>\"");
	eq(S({ brokerName: "O'Neil & Sons", orderNumber: "1 & 2 <x>" }), "O'Neil & Sons Order #1 & 2 <x>",
		"§2 NOT HTML-escaped: & stays &, ' stays ' (a header, not HTML)");
	ok(!S({ brokerName: "A&B", orderNumber: "1&2" }).includes("&amp;"), "§2 …never &amp;");

	const CASES = [
		{ label: "the $ case", subject: S({ brokerName: "Bison Transport", orderNumber: "7101850-$700 ADV" }),
			filename: "Bison Invoice Order #7101850-$700 ADV.pdf" },
		{ label: "punctuation", subject: S({ brokerName: "Acme Freight", orderNumber: "7101850 (ADV): 50% + fee & 'tax' @ dock" }),
			filename: "Acme Freight Invoice Order #7101850 (ADV) 50% + fee & 'tax' @ dock.pdf" },
		{ label: "non-ASCII (RFC 2047 / 2231)", subject: S({ brokerName: "Café Freight", orderNumber: "Café 12" }),
			filename: "Café Freight Invoice Order #Café 12.pdf" },
		{ label: "an 80-character Order # (folded header)", subject: S({ brokerName: "Bison Transport", orderNumber: "7".repeat(80) }),
			filename: `Bison Invoice Order #${"7".repeat(80)}.pdf` },
	];
	for (const c of CASES) {
		const mime = (await buildMime({
			from: "LogisX Inc. <invoices@example.com>",
			to: "ap@example.com",
			subject: c.subject,
			html: "<p>x</p>",
			attachments: [{ filename: c.filename, content: Buffer.from("x"), contentType: "application/pdf" }],
		})).toString("utf8");
		const raw = topHeader(mime, "Subject");
		ok(raw != null, `§2 ${c.label}: the MIME carries a Subject header`);
		eq(decode2047(raw || ""), c.subject, `§2 ${c.label}: Subject round-trips byte for byte`);
		ok(!/&amp;/.test(raw || ""), `§2 ${c.label}: the raw header carries no &amp;`);
		eq(attachmentFilename(mime), c.filename, `§2 ${c.label}: the attachment file name round-trips`);
	}
}

// ========================================================= §3 PERSISTENCE
function persistenceSection() {
	section("3. load_invoice_drafts.notes — the real SQL, save and reload");
	// The schema, lifted from server.js: the CREATE and every ALTER for the table.
	const CREATE_NEEDLE = "CREATE TABLE IF NOT EXISTS load_invoice_drafts (";
	eq(countOf(SRC, CREATE_NEEDLE), 1, "§3 exactly one CREATE TABLE for load_invoice_drafts");
	const cAt = SRC.indexOf(CREATE_NEEDLE);
	const createSql = SRC.slice(cAt, SRC.indexOf("`", cAt));
	const ALTERS = [...SRC.matchAll(/db\.exec\("(ALTER TABLE load_invoice_drafts ADD COLUMN [^"]+)"\)/g)].map((m) => m[1]);
	ok(ALTERS.length >= 8, `§3 found the table's ALTER migrations (${ALTERS.length})`);
	eq(ALTERS.filter((a) => a === "ALTER TABLE load_invoice_drafts ADD COLUMN notes TEXT DEFAULT ''").length, 1,
		"§3 exactly one migration adds notes TEXT DEFAULT ''");

	// The INSERT, lifted from the shipped recordDraft() — and the closure itself,
	// run with its route-scope names injected, so the ARGUMENT ORDER is tested
	// too (a note bound to the wrong column is a silent, permanent mis-record).
	const INSERT_RE = /"(INSERT INTO load_invoice_drafts \([^"]+\))"/g;
	const inserts = [...SRC.matchAll(INSERT_RE)].map((m) => m[1]);
	eq(inserts.length, 1, "§3 exactly one INSERT INTO load_invoice_drafts in server.js");
	const cols = (/\(([^)]+)\) VALUES/.exec(inserts[0] || "") || [, ""])[1].split(",").map((s) => s.trim());
	ok(cols.includes("notes"), "§3 the INSERT names the notes column");
	eq(((inserts[0] || "").match(/\?/g) || []).length, cols.length, "§3 …with one placeholder per column");

	const RD_NEEDLE = "const recordDraft = (via) => {";
	eq(countOf(SRC, RD_NEEDLE), 1, "§3 exactly one recordDraft() closure");
	const rdArrow = braceBlock(SRC, SRC.indexOf(RD_NEEDLE) + "const recordDraft = ".length);
	ok(rdArrow.includes(inserts[0]), "§3 the closure runs that INSERT");

	const fresh = (withMigrations = true) => {
		const d = new Database(":memory:");
		d.exec(createSql);
		if (withMigrations) for (const a of ALTERS) d.exec(a);
		return d;
	};
	const persistErrors = [];
	function makeRecordDraft(db, scope) {
		const env = {
			db,
			loadId: "30080873",
			invoiceId: "08142026-3",
			mintedInvoiceId: "08142026-2",
			invoiceTo: { name: "Bison Transport", email: "QPinvoicesUSA@bisontransport.com" },
			recipientSource: "default",
			total: "$3,000.00",
			effBrokerName: "Bison Transport",
			orderNumber: "7101850-$700 ADV",
			req: { session: { user: { username: "super_admin" } } },
			editedFields: ["notes"],
			ov: { values: { notes: scope.notes } },
			totalSource: "sheet",
			sheetTotal: 3000,
			rcTotal: 0,
			fmtMoney: (n) => brokerInvoice.formatMoney(n || 0),
			editDetail: "",
			logAudit: () => {},
			sanitizeEvidenceText: (v) => String(v),
			console: { error: (...a) => persistErrors.push(a.join(" ")) },
			...scope,
		};
		const names = Object.keys(env);
		return new Function(...names, `return ${rdArrow};`)(...names.map((k) => env[k]));
	}
	const latestDraftNotesSrc = extractFn(SRC, "latestDraftNotes");
	const latestFor = (db) => new Function("db", `${latestDraftNotesSrc}\nreturn latestDraftNotes;`)(db);

	const db = fresh();
	const latestDraftNotes = latestFor(db);
	eq(latestDraftNotes("30080873"), "", "§3 no draft yet → \"\"");

	const MULTI = "Advance $700 paid at pickup\nBalance due on POD\n\n  indented line & <b>";
	makeRecordDraft(db, { notes: MULTI })("imap");
	eq(persistErrors, [], "§3 the shipped recordDraft() persisted without error");
	eq(latestDraftNotes("30080873"), MULTI, "§3 the multi-line note reads back byte for byte");
	const row = db.prepare("SELECT * FROM load_invoice_drafts ORDER BY id DESC LIMIT 1").get();
	eq([row.notes, row.invoice_id_minted, row.order_number, row.via, row.edited_fields],
		[MULTI, "08142026-2", "7101850-$700 ADV", "imap", "notes"],
		"§3 every neighbouring column landed in its own place (argument order matches the column list)");

	makeRecordDraft(db, { notes: "second approve" })("imap");
	eq(latestDraftNotes("30080873"), "second approve", "§3 the NEWEST approved draft's note wins");
	makeRecordDraft(db, { notes: "" })("n8n");
	eq(latestDraftNotes("30080873"), "", "§3 a cleared note sticks — an older note is not resurrected");
	makeRecordDraft(db, { loadId: "999", notes: "other load" })("imap");
	eq(latestDraftNotes("30080873"), "", "§3 another load's note never leaks across");
	eq(latestDraftNotes("999"), "other load", "§3 …and is kept under its own load");
	eq(latestDraftNotes("unknown-load"), "", "§3 an unknown load → \"\"");
	eq(latestDraftNotes(null), "", "§3 a null load id → \"\"");

	// A row written BEFORE the migration reads as "" (the column's DEFAULT).
	const legacy = fresh(false);
	legacy.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id) VALUES (?, ?)").run("L1", "08012026-1");
	for (const a of ALTERS) legacy.exec(a);
	eq(latestFor(legacy)("L1"), "", "§3 a pre-migration draft row reads back as \"\"");

	// Any failure answers "" — recalling a note must never block an invoice.
	eq(latestFor(fresh(false))("30080873"), "", "§3 a database without the notes column → \"\" (no throw)");
	eq(latestFor({ prepare() { throw new Error("SQLITE_BUSY"); } })("30080873"), "", "§3 a database that throws → \"\"");
}

// -------------------------------------------------------------------- report
(async () => {
	// A throw inside a section is a failure, not a crash that hides the rest.
	for (const [name, run] of [["§1", renderingSection], ["§2", subjectSection], ["§3", persistenceSection]]) {
		try { await run(); } catch (e) { failures.push(`${name} threw: ${e && e.stack}`); }
	}
})()
	.then(() => {
		console.log(`\n${"=".repeat(64)}`);
		if (failures.length) {
			console.log(`FAILURES (${failures.length}):`);
			failures.forEach((f) => console.log(`  ✗ ${f}`));
			console.log(`\n${pass} passed, ${failures.length} failed`);
			process.exit(1);
		}
		console.log(`✓ ${pass} assertions passed`);
	});
