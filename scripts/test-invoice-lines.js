#!/usr/bin/env node
/**
 * scripts/test-invoice-lines.js — B20 Phase 1: advance lines on a broker
 * invoice (lib/broker-invoice-lines.js and the invoice/email render in
 * lib/broker-invoice.js).
 *
 * A Super Admin adds an advance line to a load's broker invoice ("Fuel
 * advance" by default, plus an editable footnote). The invoice prints the line
 * haul, the advance and the balance due; the line is INVOICE-ONLY: nothing that
 * settles money (Job Tracking, revenue, driver pay, investor payouts, the P&L)
 * reads it. Everything ships behind BROKER_INVOICE_LINES_ENABLED, off by
 * default.
 *
 *   §1  the flag: off unless set to true/1/yes/on
 *   §2  money in integer cents: the format gate runs first, no float ever
 *   §3  a new line's input: defaults, every refusal code, nothing inherited
 *   §4  the draft's selection: line ids only (never an amount), the footnote
 *   §5  the table: idempotent schema, append-only (no delete, no edit of a
 *       figure, a void is final, a printed line keeps its invoice #)
 *   §6  add and void: audited once, after the write, never on a refusal
 *   §7  the balance: line haul from the route's own base, every 422
 *   §8  the invoice PDF: no line → byte-identical (golden hash from main);
 *       with lines → line haul, the advance, the balance due, the footnote
 *   §9  the cover email: no line → byte-identical; with lines → one sentence
 *   §10 the same-amount receipt warning (a receipt filed for the advance)
 *   §11 the draft record, the audit line, the n8n fields, the echoes
 *   §12 isolation: no settlement module in lib/ names the table or the module
 *
 * Every fixture is made up. Pure: an in-memory SQLite, no server, no network.
 * Run: node scripts/test-invoice-lines.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const LIB_FILE = path.join(ROOT, "lib", "broker-invoice-lines.js");

let Database;
try { Database = require("better-sqlite3"); } catch (e) {
	console.error(`SETUP FAILED: better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`);
	process.exit(1);
}

// ── the per-case harness: one line per case, failures listed under it ────────
let passed = 0;
let failed = 0;
function test(name, fn) {
	const checks = [];
	const eq = (label, actual, expected) => {
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		checks.push({ ok: a === e, label, detail: `expected ${e}\n             actual   ${a}` });
	};
	const ok = (label, cond, detail = "") => checks.push({ ok: !!cond, label, detail });
	try {
		fn({ eq, ok });
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
function section(t) { console.log(`\n${t}`); }

// The module under test, or a clear error naming it (it is what the build adds).
function L() {
	if (!fs.existsSync(LIB_FILE)) throw new Error("lib/broker-invoice-lines.js does not exist yet (the B20 build adds it)");
	return require(LIB_FILE);
}
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));

// A database with the two tables the module meets in the server: the drafts
// table (as server.js creates it, before the module's columns) and expenses.
function freshDb({ drafts = true, expenses = true } = {}) {
	const db = new Database(":memory:");
	if (drafts) {
		db.exec(`CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT,
			recipient TEXT, recipient_source TEXT, total TEXT, broker_name TEXT, order_number TEXT, via TEXT,
			created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), created_by TEXT,
			edited INTEGER DEFAULT 0, edited_fields TEXT DEFAULT '', overrides_json TEXT DEFAULT '', total_source TEXT DEFAULT '',
			sheet_total TEXT DEFAULT '', ratecon_total TEXT DEFAULT '', invoice_id_minted TEXT DEFAULT '', notes TEXT DEFAULT '')`);
	}
	if (expenses) {
		db.exec(`CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, driver TEXT NOT NULL,
			load_id TEXT DEFAULT '', type TEXT NOT NULL, amount REAL NOT NULL, description TEXT DEFAULT '', date TEXT NOT NULL,
			photo_data TEXT DEFAULT '', status TEXT DEFAULT 'Pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
	}
	return db;
}
function schemaDb(opts) {
	const db = freshDb(opts);
	L().ensureSchema(db);
	return db;
}
const ADVANCE = Object.freeze({ kind: "advance", label: "Fuel advance", amountCents: 65000, receivedOn: "2026-10-12", reference: "EFS-55501", note: "" });
function add(db, loadId, values = {}, extra = {}) {
	const audits = [];
	const r = L().addLine(db, { loadId, values: { ...ADVANCE, ...values }, actor: "super_admin", closedMonths: [], ...extra },
		{ audit: (action, detail) => audits.push({ action, detail }) });
	return { ...r, audits };
}
const rowCount = (db) => db.prepare("SELECT COUNT(*) AS n FROM broker_invoice_lines").get().n;
const throwsCode = (fn) => { try { fn(); return ""; } catch (e) { return String(e.message || e); } };

// ════════════════════════════════════════════════════════════════════════════
section("§1 the flag: BROKER_INVOICE_LINES_ENABLED, off unless switched on");
test("off by default, and for every value that is not true/1/yes/on", ({ eq }) => {
	const { linesEnabled, FLAG } = L();
	eq("the flag's name", FLAG, "BROKER_INVOICE_LINES_ENABLED");
	for (const v of [undefined, "", "false", "0", "no", "off", "enabled", "truthy", "2"]) {
		eq(`value ${JSON.stringify(v)} → off`, linesEnabled(v === undefined ? {} : { BROKER_INVOICE_LINES_ENABLED: v }), false);
	}
	eq("no env object at all → off", linesEnabled(null), false);
});
test("on for true/1/yes/on in any case, spaces trimmed", ({ eq }) => {
	const { linesEnabled } = L();
	for (const v of ["true", "TRUE", "1", "yes", "On", " true "]) {
		eq(`value ${JSON.stringify(v)} → on`, linesEnabled({ BROKER_INVOICE_LINES_ENABLED: v }), true);
	}
});
test("the flag is read from the env the caller passes (the route passes its own process.env)", ({ eq }) => {
	const { linesEnabled } = L();
	const saved = process.env.BROKER_INVOICE_LINES_ENABLED;
	process.env.BROKER_INVOICE_LINES_ENABLED = "true";
	try {
		eq("an explicit env without the flag → off, whatever this process holds", linesEnabled({}), false);
		eq("no argument → this process's env", linesEnabled(), true);
	} finally {
		if (saved === undefined) delete process.env.BROKER_INVOICE_LINES_ENABLED; else process.env.BROKER_INVOICE_LINES_ENABLED = saved;
	}
});

// ════════════════════════════════════════════════════════════════════════════
section("§2 money in integer cents");
test("toCents reads a dollar string by string surgery, never through a float", ({ eq }) => {
	const { toCents } = L();
	for (const [v, c] of [["650", 65000], ["650.5", 65050], ["650.05", 65005], ["$2,400.00", 240000], [" $ 1,234.56", 123456],
		["0.29", 29], ["0.01", 1], ["1000000", 100000000], [650, 65000], [1234.56, 123456], [0.29, 29]]) {
		eq(`toCents(${JSON.stringify(v)})`, toCents(v), c);
	}
});
test("toCents refuses every shape parseMoney would mangle (null, not 0)", ({ eq }) => {
	const { toCents } = L();
	for (const v of ["12abc34", "-500", "1e9", "0.001", "1,00", "12,3456", "$", "", " ", "1.", ".5", null, undefined, true, [650], { a: 1 }, NaN, Infinity, -5, 1e21]) {
		eq(`toCents(${JSON.stringify(v)}) → null`, toCents(v), null);
	}
});
test("formatCents prints dollars with commas, a minus for a deduction", ({ eq }) => {
	const { formatCents } = L();
	for (const [c, s] of [[0, "$0.00"], [1, "$0.01"], [65000, "$650.00"], [175000, "$1,750.00"], [-65000, "-$650.00"], [123456789, "$1,234,567.89"]]) {
		eq(`formatCents(${c})`, formatCents(c), s);
	}
});

// The server's own text clean-up, lifted from server.js: the module keeps a
// copy (it requires nothing), and a copy that drifts is how two fields of one
// invoice come to be cleaned two ways.
function liftServerCleaners() {
	const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	const fnText = (name) => {
		const at = src.indexOf(`\nfunction ${name}(`);
		if (at < 0) throw new Error(`no ${name}() in server.js`);
		let depth = 0;
		for (let j = src.indexOf("{", at); j < src.length; j++) {
			if (src[j] === "{") depth++;
			else if (src[j] === "}" && --depth === 0) return src.slice(at + 1, j + 1);
		}
		throw new Error(`unbalanced ${name}()`);
	};
	const strip = src.slice(src.indexOf("\nconst EVIDENCE_TEXT_STRIP = ") + 1).split("\n")[0];
	return new Function(`${strip}\n${fnText("sanitizeEvidenceText")}\n${fnText("sanitizeInvoiceNotes")}\nreturn { EVIDENCE_TEXT_STRIP, sanitizeEvidenceText, sanitizeInvoiceNotes };`)();
}
test("the module's text clean-up is server.js's: same strip, same results on a corpus", ({ eq }) => {
	const S = liftServerCleaners();
	const { cleanLine, cleanText } = L();
	const cp = (...c) => String.fromCodePoint(...c);
	const corpus = ["", "  Fuel advance  ", "Fuel" + cp(9) + "advance", "a" + cp(0x200b) + "b", "x" + cp(0x2028) + "y", "e" + cp(0x301), cp(0x958),
		cp(0x1f69a) + " truck", "Line one" + cp(13, 10) + "Line two", "soft" + cp(0xad) + "hyphen", cp(0xfeff) + "bom", "r" + cp(0x202e) + "lo", "a".repeat(900)];
	for (const v of corpus) {
		for (const max of [40, 80, 200]) {
			eq(`cleanLine(${JSON.stringify(v).slice(0, 24)}, ${max})`, cleanLine(v, max), S.sanitizeEvidenceText(v, max));
		}
		eq(`cleanText(${JSON.stringify(v).slice(0, 24)})`, cleanText(v, 2000), S.sanitizeInvoiceNotes(v, 2000));
	}
	const mod = fs.readFileSync(LIB_FILE, "utf8");
	const mine = mod.slice(mod.indexOf("\nconst TEXT_STRIP = ") + 1).split("\n")[0];
	eq("the strip pattern is EVIDENCE_TEXT_STRIP's, character for character", mine, `const TEXT_STRIP = ${S.EVIDENCE_TEXT_STRIP.toString()};`);
});

// ════════════════════════════════════════════════════════════════════════════
section("§3 a new line's input (POST …/invoice-lines)");
test("defaults: kind advance, label \"Fuel advance\", blank date, reference and note", ({ eq }) => {
	const r = L().parseNewLine({ amount: "650" });
	eq("accepted", r.ok, true);
	eq("values", { ...r.values }, { kind: "advance", label: "Fuel advance", amountCents: 65000, receivedOn: "", reference: "", note: "" });
	eq("the default label is the owner's \"Fuel advance\"", L().DEFAULT_ADVANCE_LABEL, "Fuel advance");
});
test("a full line is cleaned, not rewritten", ({ eq }) => {
	const r = L().parseNewLine({ kind: "advance", label: "  Comdata advance ", amount: "$1,200.50", receivedOn: "2026-10-12", reference: "EFS-55501", note: "Line one\r\nLine two  " });
	eq("accepted", r.ok, true);
	eq("values", { ...r.values }, { kind: "advance", label: "Comdata advance", amountCents: 120050, receivedOn: "2026-10-12", reference: "EFS-55501", note: "Line one\nLine two" });
});
test("every refusal names its code and its field (400)", ({ eq }) => {
	const { parseNewLine } = L();
	const cases = [
		[null, "INVOICE_LINE_BODY_INVALID", ""],
		[[1], "INVOICE_LINE_BODY_INVALID", ""],
		[{ amount: "650", kind: "deduction" }, "INVOICE_LINE_KIND_INVALID", "kind"],
		[{ amount: "650", kind: "Advance" }, "INVOICE_LINE_KIND_INVALID", "kind"],
		[{}, "INVOICE_LINE_AMOUNT_INVALID", "amount"],
		[{ amount: "12abc34" }, "INVOICE_LINE_AMOUNT_INVALID", "amount"],
		[{ amount: "-650" }, "INVOICE_LINE_AMOUNT_INVALID", "amount"],
		[{ amount: [650] }, "INVOICE_LINE_AMOUNT_INVALID", "amount"],
		[{ amount: "0" }, "INVOICE_LINE_AMOUNT_OUT_OF_RANGE", "amount"],
		[{ amount: "0.00" }, "INVOICE_LINE_AMOUNT_OUT_OF_RANGE", "amount"],
		[{ amount: "1,000,000.01" }, "INVOICE_LINE_AMOUNT_OUT_OF_RANGE", "amount"],
		[{ amount: "650", label: 7 }, "INVOICE_LINE_LABEL_INVALID", "label"],
		[{ amount: "650", label: "#advance" }, "INVOICE_LINE_LABEL_INVALID", "label"],
		[{ amount: "650", label: "Fuel <b>advance</b>" }, "INVOICE_LINE_LABEL_INVALID", "label"],
		[{ amount: "650", label: "x".repeat(81) }, "INVOICE_LINE_LABEL_INVALID", "label"],
		[{ amount: "650", receivedOn: "10/12/2026" }, "INVOICE_LINE_DATE_INVALID", "receivedOn"],
		[{ amount: "650", receivedOn: "2026-02-30" }, "INVOICE_LINE_DATE_INVALID", "receivedOn"],
		[{ amount: "650", receivedOn: "0000-01-14" }, "INVOICE_LINE_DATE_INVALID", "receivedOn"],
		[{ amount: "650", receivedOn: 20261012 }, "INVOICE_LINE_DATE_INVALID", "receivedOn"],
		[{ amount: "650", reference: "-EFS" }, "INVOICE_LINE_REFERENCE_INVALID", "reference"],
		[{ amount: "650", reference: "EFS$1" }, "INVOICE_LINE_REFERENCE_INVALID", "reference"],
		[{ amount: "650", reference: "E".repeat(41) }, "INVOICE_LINE_REFERENCE_INVALID", "reference"],
		[{ amount: "650", note: ["a"] }, "INVOICE_LINE_NOTE_INVALID", "note"],
		[{ amount: "650", note: "x".repeat(501) }, "INVOICE_LINE_NOTE_TOO_LONG", "note"],
		[{ amount: "650", note: "x".repeat(2001) }, "INVOICE_LINE_NOTE_TOO_LONG", "note"],
	];
	for (const [body, code, field] of cases) {
		const r = parseNewLine(body);
		eq(`${JSON.stringify(body).slice(0, 60)} → ${code}`, { ok: r.ok, status: r.status, code: r.code, field: r.field }, { ok: false, status: 400, code, field });
		eq(`${code}: a refusal carries a sentence for the editor`, typeof r.error === "string" && r.error.length > 10, true);
	}
});
test("a blank label is the default label; a cleaned-away label too", ({ eq }) => {
	const { parseNewLine } = L();
	eq("\"\" → Fuel advance", parseNewLine({ amount: "650", label: "" }).values.label, "Fuel advance");
	eq("spaces and a tab → Fuel advance", parseNewLine({ amount: "650", label: " \t " }).values.label, "Fuel advance");
});
test("an over-long label is refused, never cut (the scan bound is wider than the rule)", ({ eq }) => {
	const { parseNewLine } = L();
	eq("80 characters accepted", parseNewLine({ amount: "650", label: "A".repeat(80) }).ok, true);
	eq("81 refused", parseNewLine({ amount: "650", label: "A".repeat(81) }).ok, false);
});
test("nothing is read from Object.prototype (a polluted prototype is not an input)", ({ eq }) => {
	const { parseNewLine } = L();
	// Planted for this case only, and removed in the finally below.
	Object.prototype.amount = "999999";
	try {
		const r = parseNewLine({});
		eq("an empty body is still refused for its missing amount", [r.ok, r.code], [false, "INVOICE_LINE_AMOUNT_INVALID"]);
		const okr = parseNewLine({ amount: "650" });
		eq("…and the values object inherits nothing", Object.getPrototypeOf(okr.values), null);
	} finally {
		delete Object.prototype.amount;
	}
});
test("a client-sent amountCents or id is ignored: only `amount` is read", ({ eq }) => {
	const r = L().parseNewLine({ amount: "650", amountCents: 1, id: 99, invoiceId: "X-1", createdBy: "someone" });
	eq("accepted at the typed amount", [r.ok, r.values.amountCents], [true, 65000]);
	eq("no other key reaches the values", Object.keys(r.values).sort(), ["amountCents", "kind", "label", "note", "receivedOn", "reference"]);
});
test("the void reason: required, one line, 200 at most", ({ eq }) => {
	const { parseVoid } = L();
	eq("accepted, cleaned", { ...parseVoid({ reason: "  Entered twice\n" }) }, { ok: true, reason: "Entered twice" });
	for (const [body, code] of [[{}, "INVOICE_LINE_VOID_REASON_REQUIRED"], [{ reason: "  " }, "INVOICE_LINE_VOID_REASON_REQUIRED"],
		[{ reason: 3 }, "INVOICE_LINE_VOID_REASON_INVALID"], [{ reason: "x".repeat(201) }, "INVOICE_LINE_VOID_REASON_TOO_LONG"], [null, "INVOICE_LINE_VOID_REASON_REQUIRED"]]) {
		const r = parseVoid(body);
		eq(`${JSON.stringify(body).slice(0, 40)} → ${code}`, [r.ok, r.status, r.code, r.field], [false, 400, code, "reason"]);
	}
});
test("a line id from the URL: a positive whole number, else nothing", ({ eq }) => {
	const { parseLineId } = L();
	for (const [v, out] of [["1", 1], ["42", 42], ["0", null], ["-1", null], ["1.5", null], ["01", null], ["abc", null], ["", null], [undefined, null], ["9".repeat(17), null]]) {
		eq(`parseLineId(${JSON.stringify(v)})`, parseLineId(v), out);
	}
});

// ════════════════════════════════════════════════════════════════════════════
section("§4 the draft's selection (draft-invoice and invoice-preview bodies)");
test("omitted lineIds means every active line; [] means none; ids are de-duplicated in order", ({ eq }) => {
	const { parseLineSelection } = L();
	const none = parseLineSelection({});
	eq("omitted", [none.ok, none.has.lineIds, none.has.footnote], [true, false, false]);
	const nul = parseLineSelection({ lineIds: null, footnote: null });
	eq("null is omitted", [nul.ok, nul.has.lineIds, nul.has.footnote], [true, false, false]);
	const empty = parseLineSelection({ lineIds: [] });
	eq("[]", [empty.ok, empty.has.lineIds, empty.values.lineIds], [true, true, []]);
	const dup = parseLineSelection({ lineIds: [3, 1, 3] });
	eq("de-duplicated", dup.values.lineIds, [3, 1]);
});
test("ids must be positive whole numbers, at most 20", ({ eq }) => {
	const { parseLineSelection } = L();
	for (const v of [[0], [-1], [1.5], ["3"], ["abc"], [2 ** 53], [null], "1,2", 7, { 0: 1 }, Array.from({ length: 21 }, (_, i) => i + 1)]) {
		const r = parseLineSelection({ lineIds: v });
		eq(`lineIds ${JSON.stringify(v).slice(0, 40)} → 400`, [r.ok, r.status, r.code, r.field], [false, 400, "INVOICE_LINE_IDS_INVALID", "lineIds"]);
	}
	eq("20 ids accepted", parseLineSelection({ lineIds: Array.from({ length: 20 }, (_, i) => i + 1) }).ok, true);
});
test("the footnote: omitted → the default; \"\" → none; text cleaned per line; refused over 500", ({ eq }) => {
	const { parseLineSelection } = L();
	const cleared = parseLineSelection({ footnote: "" });
	eq("\"\" is honoured", [cleared.ok, cleared.has.footnote, cleared.values.footnote], [true, true, ""]);
	const typed = parseLineSelection({ footnote: "*$650 for fuel advance\r\n(EFS-55501)  " });
	eq("CRLF to LF, trimmed", typed.values.footnote, "*$650 for fuel advance\n(EFS-55501)");
	for (const [v, code] of [[7, "INVOICE_FOOTNOTE_INVALID"], [["a"], "INVOICE_FOOTNOTE_INVALID"], ["x".repeat(501), "INVOICE_FOOTNOTE_TOO_LONG"], ["x".repeat(2001), "INVOICE_FOOTNOTE_TOO_LONG"]]) {
		const r = parseLineSelection({ footnote: v });
		eq(`footnote ${JSON.stringify(v).slice(0, 30)} → ${code}`, [r.ok, r.status, r.code, r.field], [false, 400, code, "footnote"]);
	}
});
test("the selection never carries an amount: a `lines` key with figures is ignored", ({ eq }) => {
	const r = L().parseLineSelection({ lineIds: [1], lines: [{ id: 1, amountCents: 1 }], balanceDue: "$1.00" });
	eq("only lineIds and footnote are read", [r.ok, Object.keys(r.values).sort()], [true, ["footnote", "lineIds"]]);
});

// ════════════════════════════════════════════════════════════════════════════
section("§5 the table: broker_invoice_lines, append-only");
test("ensureSchema is idempotent and adds the drafts table's two columns", ({ eq, ok }) => {
	const db = freshDb();
	L().ensureSchema(db);
	L().ensureSchema(db);
	const cols = db.prepare("PRAGMA table_info(broker_invoice_lines)").all().map((c) => c.name);
	eq("the line columns", cols, ["id", "load_id", "load_key", "invoice_id", "kind", "label", "amount_cents", "received_on", "reference", "note",
		"created_by", "created_at", "voided_at", "voided_by", "void_reason"]);
	const drafts = db.prepare("PRAGMA table_info(load_invoice_drafts)").all().map((c) => c.name);
	ok("load_invoice_drafts gains lines_json and gross_total", drafts.includes("lines_json") && drafts.includes("gross_total"));
	eq("both default to ''", db.prepare("SELECT dflt_value FROM pragma_table_info('load_invoice_drafts') WHERE name IN ('lines_json','gross_total') ORDER BY name").all().map((r) => r.dflt_value), ["''", "''"]);
	eq("the table name", L().TABLE, "broker_invoice_lines");
});
test("ensureSchema without a drafts table still builds the lines table (no throw)", ({ ok }) => {
	const db = freshDb({ drafts: false });
	L().ensureSchema(db);
	ok("table exists", db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'broker_invoice_lines'").get());
});
test("the database refuses a delete, a change of figure, an un-void, a second void and a re-printed invoice #", ({ eq, ok }) => {
	const db = schemaDb();
	const { line } = add(db, "41000017");
	const id = line.id;
	ok("DELETE aborts", /INVOICE_LINE_APPEND_ONLY/.test(throwsCode(() => db.prepare("DELETE FROM broker_invoice_lines WHERE id = ?").run(id))));
	for (const [col, v] of [["amount_cents", 1], ["label", "Other"], ["kind", "advance"], ["load_key", "x"], ["load_id", "x"], ["received_on", "2026-01-01"],
		["reference", "R"], ["note", "n"], ["created_by", "x"], ["created_at", "x"]]) {
		const before = db.prepare(`SELECT ${col} AS v FROM broker_invoice_lines WHERE id = ?`).get(id).v;
		if (before === v) continue;
		ok(`UPDATE ${col} aborts`, /INVOICE_LINE_APPEND_ONLY/.test(throwsCode(() => db.prepare(`UPDATE broker_invoice_lines SET ${col} = ? WHERE id = ?`).run(v, id))));
	}
	eq("a first print stamps the invoice #", db.prepare("UPDATE broker_invoice_lines SET invoice_id = '10162026-1' WHERE id = ?").run(id).changes, 1);
	ok("…which never changes after", /INVOICE_LINE_APPEND_ONLY/.test(throwsCode(() => db.prepare("UPDATE broker_invoice_lines SET invoice_id = '10162026-2' WHERE id = ?").run(id))));
	ok("a reason without a void aborts", /INVOICE_LINE_APPEND_ONLY/.test(throwsCode(() => db.prepare("UPDATE broker_invoice_lines SET void_reason = 'x' WHERE id = ?").run(id))));
	eq("a void is one write", db.prepare("UPDATE broker_invoice_lines SET voided_at = '2026-10-16T12:00:00Z', voided_by = 'super_admin', void_reason = 'dup' WHERE id = ?").run(id).changes, 1);
	ok("an un-void aborts", /INVOICE_LINE_APPEND_ONLY/.test(throwsCode(() => db.prepare("UPDATE broker_invoice_lines SET voided_at = NULL WHERE id = ?").run(id))));
	ok("a second void aborts", /INVOICE_LINE_APPEND_ONLY/.test(throwsCode(() => db.prepare("UPDATE broker_invoice_lines SET void_reason = 'other' WHERE id = ?").run(id))));
	eq("the row is as written", rowCount(db), 1);
});
test("the table refuses a kind other than advance and an amount that is not a positive whole number of cents", ({ ok }) => {
	const db = schemaDb();
	const ins = (kind, cents) => throwsCode(() => db.prepare("INSERT INTO broker_invoice_lines (load_id, load_key, kind, label, amount_cents) VALUES ('X', 'x', ?, 'L', ?)").run(kind, cents));
	ok("kind deduction refused", /CHECK/.test(ins("deduction", 100)));
	ok("0 cents refused", /CHECK/.test(ins("advance", 0)));
	ok("a REAL amount refused", /CHECK/.test(ins("advance", 650.5)));
	ok("over $1,000,000 refused", /CHECK/.test(ins("advance", 100000001)));
	ok("a whole number of cents accepted", ins("advance", 65050) === "");
});
test("the triggers are this connection's own (TEMP): another connection to the file is not covered", ({ eq }) => {
	const db = schemaDb();
	const t = db.prepare("SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND tbl_name = 'broker_invoice_lines' ORDER BY name").all().map((r) => r.name);
	eq("the two TEMP triggers", t, ["broker_invoice_lines_append_only", "broker_invoice_lines_no_delete"]);
	eq("none stored in the database file", db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'broker_invoice_lines'").get().n, 0);
});

// ════════════════════════════════════════════════════════════════════════════
section("§6 add and void: audited once, after the write");
test("addLine stores the line under the load's key and audits it once, after the insert", ({ eq }) => {
	const db = schemaDb();
	const audits = [];
	let rowsAtAudit = -1;
	const r = L().addLine(db, { loadId: "#41000017", values: { ...ADVANCE }, actor: "super_admin", closedMonths: [] },
		{ audit: (action, detail) => { rowsAtAudit = rowCount(db); audits.push({ action, detail }); } });
	eq("ok", r.ok, true);
	eq("the wire line", { ...r.line, createdAt: typeof r.line.createdAt }, {
		id: 1, loadId: "#41000017", kind: "advance", label: "Fuel advance", amountCents: 65000, amount: "$650.00", receivedOn: "2026-10-12",
		reference: "EFS-55501", note: "", invoiceId: "", createdBy: "super_admin", createdAt: "string", voided: false, voidedAt: "", voidedBy: "", voidReason: "",
	});
	eq("load_key is the route's normalization (trimmed, lower case, one leading # dropped)", db.prepare("SELECT load_key FROM broker_invoice_lines").get().load_key, "41000017");
	eq("one audit row, after the insert", [audits.length, rowsAtAudit], [1, 1]);
	eq("its action and detail", audits[0], { action: "invoice_line_added", detail: "#1 advance $650.00 \"Fuel advance\" received 2026-10-12 ref EFS-55501 — invoice-only, no settlement change" });
});
test("a load in a closed month is accepted, and the audit says so", ({ eq }) => {
	const db = schemaDb();
	const one = add(db, "41000017", {}, { closedMonths: ["2026-09"] });
	eq("accepted", one.ok, true);
	eq("one closed month", one.audits[0].detail.endsWith("— load in closed month 2026-09, invoice-only, no settlement change"), true);
	const two = add(db, "41000017", {}, { closedMonths: ["2026-08", "2026-09"] });
	eq("two closed months", two.audits[0].detail.endsWith("— load in closed months 2026-08, 2026-09, invoice-only, no settlement change"), true);
	const unknown = add(db, "41000017", {}, { closedMonths: null });
	eq("months that can't be told", unknown.audits[0].detail.endsWith("— the load's month could not be told, invoice-only, no settlement change"), true);
	eq("a line with no date or reference reads plainly", add(db, "41000017", { receivedOn: "", reference: "" }).audits[0].detail,
		"#4 advance $650.00 \"Fuel advance\" — invoice-only, no settlement change");
});
test("a failed insert answers 500 and audits nothing", ({ eq }) => {
	const real = schemaDb();
	const db = {
		prepare: (sql) => (/INSERT INTO broker_invoice_lines/.test(sql) ? { run() { throw new Error("disk I/O error"); } } : real.prepare(sql)),
		transaction: (fn) => real.transaction(fn),
	};
	const audits = [];
	const r = L().addLine(db, { loadId: "41000017", values: { ...ADVANCE }, actor: "super_admin", closedMonths: [] }, { audit: (a, d) => audits.push(d) });
	eq("refused", [r.ok, r.status, r.code], [false, 500, "INVOICE_LINE_WRITE_FAILED"]);
	eq("no audit, no row", [audits.length, rowCount(real)], [0, 0]);
});
test("at most 20 active lines on a load (409); a voided line frees its place", ({ eq }) => {
	const db = schemaDb();
	for (let i = 0; i < 20; i++) add(db, "41000017");
	const over = add(db, "41000017");
	eq("the 21st is refused, unaudited", [over.ok, over.status, over.code, over.audits.length], [false, 409, "INVOICE_LINE_LIMIT", 0]);
	eq("another load is not counted", add(db, "41000018").ok, true);
	L().voidLine(db, { loadId: "41000017", lineId: 1, reason: "dup", actor: "super_admin" }, { audit: () => {} });
	eq("after a void there is room", add(db, "41000017").ok, true);
});
test("voidLine: once, on this load only, audited after the write; a printed line says which draft keeps its copy", ({ eq }) => {
	const db = schemaDb();
	add(db, "41000017");
	add(db, "41000018");
	const audits = [];
	const audit = { audit: (action, detail) => audits.push({ action, detail }) };
	const other = L().voidLine(db, { loadId: "41000017", lineId: 2, reason: "dup", actor: "super_admin" }, audit);
	eq("another load's line: 404, unaudited", [other.ok, other.status, other.code, audits.length], [false, 404, "INVOICE_LINE_NOT_FOUND", 0]);
	const missing = L().voidLine(db, { loadId: "41000017", lineId: 99, reason: "dup", actor: "super_admin" }, audit);
	eq("no such line: 404", [missing.status, missing.code], [404, "INVOICE_LINE_NOT_FOUND"]);
	db.prepare("UPDATE broker_invoice_lines SET invoice_id = '10162026-1' WHERE id = 1").run();
	const r = L().voidLine(db, { loadId: "#41000017", lineId: 1, reason: "Broker paid it back", actor: "super_admin" }, audit);
	eq("voided", [r.ok, r.line.voided, r.line.voidedBy, r.line.voidReason, typeof r.line.voidedAt], [true, true, "super_admin", "Broker paid it back", "string"]);
	eq("audited once", audits, [{ action: "invoice_line_voided", detail: "#1 advance $650.00 \"Fuel advance\" voided: Broker paid it back (printed on 10162026-1; that draft keeps its copy)" }]);
	const again = L().voidLine(db, { loadId: "41000017", lineId: 1, reason: "again", actor: "super_admin" }, audit);
	eq("a second void: 409, unaudited", [again.ok, again.status, again.code, audits.length], [false, 409, "INVOICE_LINE_ALREADY_VOIDED", 1]);
	const unprinted = L().voidLine(db, { loadId: "41000018", lineId: 2, reason: "Entered twice", actor: "super_admin" }, audit);
	eq("an unprinted line's detail has no draft note", [unprinted.ok, audits[1].detail], [true, "#2 advance $650.00 \"Fuel advance\" voided: Entered twice"]);
});
test("listLines: this load's lines, oldest first, voided ones included and marked", ({ eq }) => {
	const db = schemaDb();
	add(db, "41000017", { amountCents: 10000 });
	add(db, "41000018");
	add(db, "41000017", { amountCents: 20000, label: "Cash advance" });
	L().voidLine(db, { loadId: "41000017", lineId: 1, reason: "dup", actor: "super_admin" }, { audit: () => {} });
	const lines = L().listLines(db, "41000017");
	eq("ids, voided flags, amounts", lines.map((l) => [l.id, l.voided, l.amount, l.label]), [[1, true, "$100.00", "Fuel advance"], [3, false, "$200.00", "Cash advance"]]);
	eq("\"#41000017\" is the same load", L().listLines(db, "#41000017").length, 2);
	eq("an unknown load has none", L().listLines(db, "41000099"), []);
});

// ════════════════════════════════════════════════════════════════════════════
section("§7 the balance: line haul − advances, computed in cents on the server");
const resolve = (db, loadId, over = {}) => L().resolveInvoiceLines(db, {
	loadId, selection: L().parseLineSelection(over.body || {}), derivedLineHaul: 2400, lineHaulSource: "ratecon", typedTotal: null, ...over.args,
});
test("every active line, by default; the balance and the footnote", ({ eq }) => {
	const db = schemaDb();
	add(db, "41000017");
	const r = resolve(db, "41000017");
	eq("ok", r.ok, true);
	eq("summary", r.summary, {
		lineHaulCents: 240000, advancesCents: 65000, balanceCents: 175000, lineHaulSource: "ratecon",
		items: [{ id: 1, kind: "advance", label: "Fuel advance", amountCents: 65000, receivedOn: "2026-10-12", reference: "EFS-55501" }],
		footnote: "*$650 for fuel advance", footnoteDefault: "*$650 for fuel advance",
	});
});
test("no line (none on the load, or lineIds []) → no summary: the invoice prints as today", ({ eq }) => {
	const db = schemaDb();
	eq("none on the load", resolve(db, "41000017"), { ok: true, summary: null, selectedIds: [] });
	add(db, "41000017");
	eq("lineIds []", resolve(db, "41000017", { body: { lineIds: [] } }), { ok: true, summary: null, selectedIds: [] });
});
test("an explicit selection prints exactly those lines, in the order asked", ({ eq }) => {
	const db = schemaDb();
	add(db, "41000017", { amountCents: 10000 });
	add(db, "41000017", { amountCents: 20000, label: "Cash advance", reference: "", receivedOn: "" });
	const r = resolve(db, "41000017", { body: { lineIds: [2] } });
	eq("one of two", [r.summary.items.map((i) => i.id), r.summary.advancesCents, r.summary.balanceCents], [[2], 20000, 220000]);
	eq("its footnote", r.summary.footnote, "*$200 for cash advance");
	const both = resolve(db, "41000017", { body: { lineIds: [2, 1] } });
	eq("two lines, two footnote lines", [both.summary.items.map((i) => i.id), both.summary.footnoteDefault], [[2, 1], "*$200 for cash advance\n*$100 for fuel advance"]);
});
test("a voided line, another load's line or an unknown id → 422 INVOICE_LINE_INVALID (never printed)", ({ eq }) => {
	const db = schemaDb();
	add(db, "41000017");
	add(db, "41000018");
	add(db, "41000017");
	L().voidLine(db, { loadId: "41000017", lineId: 3, reason: "dup", actor: "super_admin" }, { audit: () => {} });
	for (const id of [2, 3, 99]) {
		const r = resolve(db, "41000017", { body: { lineIds: [1, id] } });
		eq(`line ${id}`, [r.ok, r.status, r.code, r.lineId, r.selectedIds], [false, 422, "INVOICE_LINE_INVALID", id, [1, id]]);
	}
	eq("by default a voided line is simply not active", resolve(db, "41000017").summary.items.map((i) => i.id), [1]);
});
test("a typed total that differs from the line haul → 422 INVOICE_LINE_HAUL_CONFLICT; the same figure is fine", ({ eq, ok }) => {
	const db = schemaDb();
	add(db, "41000017");
	const typed = resolve(db, "41000017", { args: { typedTotal: 1750 } });
	eq("typed net total + a line", [typed.ok, typed.status, typed.code], [false, 422, "INVOICE_LINE_HAUL_CONFLICT"]);
	ok("…the message names the line haul to put back", typed.error.includes("$2,400.00"));
	eq("the editor's echo of the derived figure is not a typed total", resolve(db, "41000017", { args: { typedTotal: 2400 } }).ok, true);
	eq("…to the cent", resolve(db, "41000017", { args: { typedTotal: 2400.01 } }).code, "INVOICE_LINE_HAUL_CONFLICT");
	const noBase = resolve(db, "41000017", { args: { derivedLineHaul: 0, typedTotal: 2400 } });
	eq("no rate con or sheet figure: a typed total can't carry lines", [noBase.ok, noBase.code], [false, "INVOICE_LINE_HAUL_CONFLICT"]);
	eq("…nor no total at all", resolve(db, "41000017", { args: { derivedLineHaul: 0 } }).code, "INVOICE_LINE_HAUL_CONFLICT");
	eq("without a line a typed total is not this module's business", resolve(db, "41000017", { body: { lineIds: [] }, args: { typedTotal: 1750 } }).ok, true);
});
test("the balance must stay above $0.00 (422 INVOICE_BALANCE_INVALID)", ({ eq }) => {
	const db = schemaDb();
	add(db, "41000017", { amountCents: 240000 });
	const equal = resolve(db, "41000017");
	eq("advances = line haul", [equal.ok, equal.status, equal.code], [false, 422, "INVOICE_BALANCE_INVALID"]);
	const db2 = schemaDb();
	add(db2, "41000017", { amountCents: 239999 });
	eq("one cent left is a balance", resolve(db2, "41000017").summary.balanceCents, 1);
});
test("cents, not floats: a line haul of $1,234.56 less $0.29 is exactly $1,234.27", ({ eq }) => {
	const db = schemaDb();
	add(db, "41000017", { amountCents: 29 });
	const r = resolve(db, "41000017", { args: { derivedLineHaul: 1234.56 } });
	eq("balance", [r.summary.lineHaulCents, r.summary.balanceCents], [123456, 123427]);
	eq("footnote with cents", r.summary.footnote, "*$0.29 for fuel advance");
});
test("the footnote: edited text is kept; \"\" prints none; the default follows the lines", ({ eq }) => {
	const db = schemaDb();
	add(db, "41000017");
	eq("edited", resolve(db, "41000017", { body: { footnote: "*Advance paid by EFS check" } }).summary.footnote, "*Advance paid by EFS check");
	const cleared = resolve(db, "41000017", { body: { footnote: "" } }).summary;
	eq("cleared", [cleared.footnote, cleared.footnoteDefault], ["", "*$650 for fuel advance"]);
});
test("labelInSentence lower-cases a sentence-case label, never an acronym", ({ eq }) => {
	const { labelInSentence } = L();
	for (const [a, b] of [["Fuel advance", "fuel advance"], ["EFS advance", "EFS advance"], ["fuel advance", "fuel advance"], ["X", "X"], ["7 day advance", "7 day advance"]]) {
		eq(a, labelInSentence(a), b);
	}
});

// ════════════════════════════════════════════════════════════════════════════
section("§8 the invoice PDF (buildInvoiceHtml)");
const GOLDEN_BANK = Object.freeze({ INVOICE_BANK_ROUTING: "000000000", INVOICE_BANK_ACCOUNT: "0000000000" });
const INVOICE = Object.freeze({
	invoiceId: "10162026-1", invoiceDate: "10/16/2026", brokerName: "Bison Transport",
	invoiceTo: Object.freeze({ name: "Bison Transport", email: "ap@bison.example.test" }),
	orderNumber: "7000002", poNumber: "2700011", deliveryDate: "10/14/2026", total: "$2,400.00",
});
// Captured from lib/broker-invoice.js on main (c36a1ab), before advance lines,
// with GOLDEN_BANK set: the invoice without a line must stay these bytes.
const GOLDEN_INVOICE = "ec871198cad996f9f5d0a7572428326f3082bc1806f44f58a9e5b7681aaf12f8";
const GOLDEN_INVOICE_NOTES = "7f3fad058e5adb7526c14493f9a20d4898a92f78ea73050853125c1fc8afec81";
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
function withBank(fn) {
	const saved = Object.keys(GOLDEN_BANK).map((k) => [k, process.env[k]]);
	Object.assign(process.env, GOLDEN_BANK);
	try { return fn(); } finally {
		for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
	}
}
const SUMMARY = Object.freeze({
	lineHaulCents: 240000, advancesCents: 65000, balanceCents: 175000, lineHaulSource: "ratecon",
	items: [{ id: 1, kind: "advance", label: "Fuel advance", amountCents: 65000, receivedOn: "2026-10-12", reference: "EFS-55501" }],
	footnote: "*$650 for fuel advance", footnoteDefault: "*$650 for fuel advance",
});
test("GOLDEN: no line renders main's invoice, byte for byte (null, undefined, absent)", ({ eq }) => {
	withBank(() => {
		eq("absent", sha256(brokerInvoice.buildInvoiceHtml(INVOICE)), GOLDEN_INVOICE);
		eq("invoiceLines null", sha256(brokerInvoice.buildInvoiceHtml({ ...INVOICE, invoiceLines: null })), GOLDEN_INVOICE);
		eq("invoiceLines undefined", sha256(brokerInvoice.buildInvoiceHtml({ ...INVOICE, invoiceLines: undefined })), GOLDEN_INVOICE);
		eq("with a note, still main's bytes", sha256(brokerInvoice.buildInvoiceHtml({ ...INVOICE, notes: "Unload at door 4", invoiceLines: null })), GOLDEN_INVOICE_NOTES);
	});
});
test("with a line: the line haul row, the advance as a deduction, LINE HAUL / LESS ADVANCES / Balance due, the footnote", ({ ok, eq }) => {
	const html = withBank(() => brokerInvoice.buildInvoiceHtml({ ...INVOICE, total: "$9,999.00", invoiceLines: SUMMARY }));
	ok("the item row prints the line haul (from the summary, not `total`)", /<td class="num">\$2,400\.00<\/td>/.test(html) && !html.includes("$9,999.00"));
	ok("an advance row with its label", html.includes('<tr class="advance">') && html.includes('<div class="item-title">Fuel advance</div>'));
	ok("…its date and reference under it", html.includes('<div class="item-sub">Received 10/12/2026 · Ref EFS-55501</div>'));
	ok("…and the amount as a deduction", /<td class="num">-\$650\.00<\/td>/.test(html));
	ok("LINE HAUL in the totals", html.includes('<div class="subtotal"><span>LINE HAUL</span><span class="amt">$2,400.00</span></div>'));
	ok("LESS ADVANCES", html.includes('<div class="subtotal"><span>LESS ADVANCES</span><span class="amt">-$650.00</span></div>'));
	ok("the pill is the balance due, starred for the footnote", html.includes('<div class="pill"><span class="lbl">Balance due*</span><span class="amt">$1,750.00</span></div>'));
	ok("the footnote, under the pill", html.includes('<div class="footnote">*$650 for fuel advance</div>') && html.indexOf('class="footnote"') > html.indexOf('class="pill"'));
	ok("no SUB-TOTAL / Total pair any more", !html.includes("SUB-TOTAL") && !html.includes('<span class="lbl">Total</span>'));
	eq("the footnote CSS lands inside the one <style> block", html.split("</style>").length - 1, 1);
	ok("the footnote keeps its line breaks (pre-wrap)", /\.footnote \{[^}]*white-space: pre-wrap;/.test(html));
});
test("a footnote not starting with * leaves the pill unstarred; no footnote prints no block", ({ ok }) => {
	const plain = withBank(() => brokerInvoice.buildInvoiceHtml({ ...INVOICE, invoiceLines: { ...SUMMARY, footnote: "Advance paid by EFS check" } }));
	ok("unstarred", plain.includes('<span class="lbl">Balance due</span>') && plain.includes('<div class="footnote">Advance paid by EFS check</div>'));
	const none = withBank(() => brokerInvoice.buildInvoiceHtml({ ...INVOICE, invoiceLines: { ...SUMMARY, footnote: "" } }));
	ok("no footnote block", !none.includes('<div class="footnote">') && none.includes('<span class="lbl">Balance due</span>'));
});
test("typed text is escaped: label, reference and footnote", ({ ok }) => {
	const html = withBank(() => brokerInvoice.buildInvoiceHtml({ ...INVOICE, invoiceLines: {
		...SUMMARY, items: [{ ...SUMMARY.items[0], label: "Fuel & \"cash\"" }], footnote: "*<script>alert('x')</script>",
	} }));
	ok("label escaped", html.includes("Fuel &amp; &quot;cash&quot;"));
	ok("footnote escaped", html.includes("*&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;") && !html.includes("<script>"));
});
test("a summary whose figures do not add up is refused, never printed", ({ ok }) => {
	ok("balance ≠ line haul − advances", /do not add up/.test(throwsCode(() => brokerInvoice.buildInvoiceHtml({ ...INVOICE, invoiceLines: { ...SUMMARY, balanceCents: 1 } }))));
	ok("advances ≠ the lines' sum", /do not add up/.test(throwsCode(() => brokerInvoice.buildInvoiceHtml({ ...INVOICE, invoiceLines: { ...SUMMARY, advancesCents: 1, balanceCents: 239999 } }))));
});
test("notes and lines together: the Notes box still sits left of the totals box", ({ ok }) => {
	const html = withBank(() => brokerInvoice.buildInvoiceHtml({ ...INVOICE, notes: "Unload at door 4", invoiceLines: SUMMARY }));
	ok("both", html.includes('<div class="totals has-notes">') && html.indexOf('<div class="notes">') < html.indexOf('<div class="box">') && html.includes("Balance due*"));
});

// ════════════════════════════════════════════════════════════════════════════
section("§9 the cover email");
const EMAIL_BISON = Object.freeze({ isBison: true, brokerName: "Bison Transport", loadNumber: "41000017", orderNumber: "7000002", moveNumber: "20100003", poNumber: "2700011" });
const EMAIL_OTHER = Object.freeze({ isBison: false, brokerName: "Acme Freight", loadNumber: "41000018", orderNumber: "41000018", moveNumber: "", poNumber: "" });
// Captured from lib/broker-invoice.js on main (c36a1ab).
const GOLDEN_EMAIL = { bison: "709256b2ef59c33f08896de949c197051e55223323c70a0929c35febb4e33c8c", other: "50aa803ae9efa3f03915ef8e2b57bd32c598f497d65159b94e7b3e347144d792" };
test("GOLDEN: no balance line → main's email, byte for byte", ({ eq }) => {
	eq("Bison", sha256(brokerInvoice.buildInvoiceEmailHtml(EMAIL_BISON)), GOLDEN_EMAIL.bison);
	eq("other broker", sha256(brokerInvoice.buildInvoiceEmailHtml(EMAIL_OTHER)), GOLDEN_EMAIL.other);
	eq("balanceLine \"\" is no line", sha256(brokerInvoice.buildInvoiceEmailHtml({ ...EMAIL_BISON, balanceLine: "" })), GOLDEN_EMAIL.bison);
});
test("the balance sentence: one advance, several advances", ({ eq }) => {
	const { emailBalanceLine } = L();
	eq("one", emailBalanceLine(SUMMARY), "Balance due $1,750.00 after the $650.00 fuel advance.");
	eq("two", emailBalanceLine({ ...SUMMARY, advancesCents: 85000, balanceCents: 155000, items: [SUMMARY.items[0], { ...SUMMARY.items[0], id: 2, amountCents: 20000 }] }),
		"Balance due $1,550.00 after $850.00 in advances.");
});
test("with a balance line: its own paragraph before the sign-off, in the text and the HTML", ({ eq, ok }) => {
	const line = "Balance due $1,750.00 after the $650.00 fuel advance.";
	eq("Bison text", brokerInvoice.buildInvoiceEmailBodyText({ ...EMAIL_BISON, balanceLine: line }),
		"Hello,\n\nPlease find the attached invoice and supporting documentation for Bison Transport Order # 7000002. The driver ID number for pickup is 20100003 & PO #2700011\n\n" +
		`${line}\n\nBest regards,`);
	eq("other broker text", brokerInvoice.buildInvoiceEmailBodyText({ ...EMAIL_OTHER, balanceLine: line }),
		"Hello,\n\nPlease see the attached documents for load number 41000018: the rate confirmation, the signed POD, and the invoice.\n\n" +
		`${line}\n\nPlease contact us if there is any issue.\n\nThank you,`);
	ok("HTML paragraph", brokerInvoice.buildInvoiceEmailHtml({ ...EMAIL_BISON, balanceLine: line }).includes(`<p>${line}</p><p>Best regards,</p>`));
	const edited = brokerInvoice.buildInvoiceEmailHtml({ ...EMAIL_BISON, balanceLine: line, bodyText: brokerInvoice.buildInvoiceEmailBodyText({ ...EMAIL_BISON, balanceLine: line }) });
	ok("the generated text sent back is not an edit", edited === brokerInvoice.buildInvoiceEmailHtml({ ...EMAIL_BISON, balanceLine: line }));
});

// ════════════════════════════════════════════════════════════════════════════
section("§10 the same-amount receipt warning");
test("a receipt on the load with an advance's amount is named (any status but Rejected)", ({ eq }) => {
	const db = schemaDb();
	add(db, "41000017");
	const ins = db.prepare("INSERT INTO expenses (timestamp, driver, load_id, type, amount, date, status) VALUES ('2026-10-12T10:00:00Z', 'Test Driver', ?, ?, ?, '2026-10-12', ?)");
	ins.run("#41000017", "Other", 650, "Approved");
	ins.run("41000017", "Fuel", 650, "Rejected");
	ins.run("41000017", "Fuel", 649.99, "Approved");
	ins.run("41000018", "Other", 650, "Approved");
	ins.run(" 41000017 ", "Other", 650.0, "Pending");
	eq("two receipts match", L().sameAmountReceipts(db, "41000017"), [
		{ lineId: 1, expenseId: 1, type: "Other", amount: "$650.00", status: "Approved" },
		{ lineId: 1, expenseId: 5, type: "Other", amount: "$650.00", status: "Pending" },
	]);
	eq("a voided line warns about nothing", (L().voidLine(db, { loadId: "41000017", lineId: 1, reason: "dup", actor: "x" }, { audit: () => {} }), L().sameAmountReceipts(db, "41000017")), []);
});
test("no expenses table → no warning, no throw", ({ eq }) => {
	const db = schemaDb({ expenses: false });
	add(db, "41000017");
	eq("[]", L().sameAmountReceipts(db, "41000017"), []);
});

// ════════════════════════════════════════════════════════════════════════════
section("§11 the draft record, the audit line, the n8n fields, the echoes");
test("recordDraftLines: lines_json and gross_total on the draft row, each line stamped once", ({ eq }) => {
	const db = schemaDb();
	add(db, "41000017");
	const id = db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, total) VALUES ('41000017', '10162026-1', '$1,750.00')").run().lastInsertRowid;
	const summary = resolve(db, "41000017").summary;
	eq("marked", L().recordDraftLines(db, { draftId: id, summary, invoiceId: "10162026-1" }), { marked: 1, voidedIds: [] });
	const row = db.prepare("SELECT total, gross_total, lines_json FROM load_invoice_drafts WHERE id = ?").get(id);
	eq("total stays the balance due, gross_total is the line haul", [row.total, row.gross_total], ["$1,750.00", "$2,400.00"]);
	eq("lines_json", JSON.parse(row.lines_json), {
		lineHaulCents: 240000, advancesCents: 65000, balanceCents: 175000, lineHaulSource: "ratecon", footnote: "*$650 for fuel advance",
		lines: [{ id: 1, kind: "advance", label: "Fuel advance", amountCents: 65000, receivedOn: "2026-10-12", reference: "EFS-55501" }],
	});
	eq("the line carries the first invoice that printed it", L().listLines(db, "41000017")[0].invoiceId, "10162026-1");
	const id2 = db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, total) VALUES ('41000017', '10162026-2', '$1,750.00')").run().lastInsertRowid;
	eq("a re-print stamps nothing new", L().recordDraftLines(db, { draftId: id2, summary, invoiceId: "10162026-2" }), { marked: 0, voidedIds: [] });
	eq("…the first invoice # stays", L().listLines(db, "41000017")[0].invoiceId, "10162026-1");
});
test("a line voided while the draft was being made is not stamped, and is named", ({ eq }) => {
	const db = schemaDb();
	add(db, "41000017");
	add(db, "41000017", { amountCents: 10000, label: "Cash advance" });
	const summary = resolve(db, "41000017").summary;
	// The approve resolved both lines; one is voided before its record is written.
	L().voidLine(db, { loadId: "41000017", lineId: 2, reason: "Entered twice", actor: "super_admin" }, { audit: () => {} });
	const id = db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, total) VALUES ('41000017', '10162026-1', '$1,650.00')").run().lastInsertRowid;
	eq("one stamped, the voided one named", L().recordDraftLines(db, { draftId: id, summary, invoiceId: "10162026-1" }), { marked: 1, voidedIds: [2] });
	eq("the voided line carries no invoice #", L().listLines(db, "41000017").map((l) => [l.id, l.invoiceId, l.voided]), [[1, "10162026-1", false], [2, "", true]]);
});
test("the draft's audit text: the figures first, then the lines, then an edited footnote", ({ eq }) => {
	const { auditDraftDetail } = L();
	eq("default footnote", auditDraftDetail(SUMMARY),
		"lines: line haul $2,400.00, less advances $650.00, balance due $1,750.00 (INVOICE ONLY — Job Tracking Payment unchanged); items: #1 Fuel advance $650.00");
	eq("edited footnote", auditDraftDetail({ ...SUMMARY, footnote: "*Paid by EFS" }),
		"lines: line haul $2,400.00, less advances $650.00, balance due $1,750.00 (INVOICE ONLY — Job Tracking Payment unchanged); items: #1 Fuel advance $650.00; footnote: \"*Paid by EFS\"");
});
test("twenty long lines: the 1000-character audit cap never cuts the balance due", ({ ok }) => {
	const items = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, kind: "advance", label: `Fuel advance ${"x".repeat(60)} ${i + 1}`, amountCents: 1000, receivedOn: "", reference: "" }));
	const detail = L().auditDraftDetail({ ...SUMMARY, items, advancesCents: 20000, balanceCents: 220000, footnote: "f".repeat(500), footnoteDefault: "" });
	// The route prefixes "<invoice #> load <id> — " and caps the whole line at 1000.
	const capped = `10162026-1 load 41000017 — ${detail}`.slice(0, 1000);
	ok("the balance due survives the cap", capped.includes("balance due $2,200.00"));
	ok("…ahead of the first line", detail.indexOf("balance due") < detail.indexOf("#1 "));
});
test("the n8n fallback's fields: the reviewed lines and the balance; nothing a sheet could read as a formula", ({ eq, ok }) => {
	const fields = L().n8nFields(SUMMARY);
	eq("fields", fields, {
		lines: [{ kind: "advance", label: "Fuel advance", amount: "$650.00", receivedOn: "2026-10-12", reference: "EFS-55501" }],
		lineHaul: "$2,400.00", balanceDue: "$1,750.00",
	});
	// The workflow never read a footnote (the PDF carries it), so none is sent;
	// every value sent starts with neither = + - nor @.
	const values = [];
	const walk = (v) => { if (v && typeof v === "object") Object.values(v).forEach(walk); else values.push(String(v)); };
	walk(fields);
	ok("no value starts like a formula", values.every((v) => !/^[=+\-@]/.test(v)));
});
test("summaryWire: the figures the editor shows, formatted on the server", ({ eq }) => {
	eq("wire", L().summaryWire(SUMMARY), {
		lineHaul: "$2,400.00", advances: "-$650.00", balanceDue: "$1,750.00", lineHaulCents: 240000, advancesCents: 65000, balanceCents: 175000,
		lineHaulSource: "ratecon",
		lines: [{ id: 1, kind: "advance", label: "Fuel advance", amountCents: 65000, amount: "-$650.00", receivedOn: "2026-10-12", reference: "EFS-55501" }],
		footnote: "*$650 for fuel advance", footnoteDefault: "*$650 for fuel advance",
	});
	eq("null stays null", L().summaryWire(null), null);
});
test("dryRunEcho: the load's lines, what is selected, the figures or the refusal, the receipt warnings", ({ eq }) => {
	const db = schemaDb();
	add(db, "41000017");
	db.prepare("INSERT INTO expenses (timestamp, driver, load_id, type, amount, date, status) VALUES ('t', 'Test Driver', '41000017', 'Other', 650, '2026-10-12', 'Approved')").run();
	const r = resolve(db, "41000017");
	const echo = L().dryRunEcho(db, { loadId: "41000017", resolved: r });
	eq("keys", Object.keys(echo), ["enabled", "available", "selectedIds", "summary", "error", "receiptWarnings"]);
	eq("values", [echo.enabled, echo.available.map((l) => l.id), echo.selectedIds, echo.summary.balanceDue, echo.error, echo.receiptWarnings.length], [true, [1], [1], "$1,750.00", null, 1]);
	const bad = resolve(db, "41000017", { body: { lineIds: [1, 7] } });
	const e2 = L().dryRunEcho(db, { loadId: "41000017", resolved: bad });
	eq("a refusal is reported, not thrown", [e2.summary, e2.error.code, e2.error.lineId, e2.selectedIds], [null, "INVOICE_LINE_INVALID", 7, [1, 7]]);
	eq("previewEcho", L().previewEcho(r.summary).summary.balanceDue, "$1,750.00");
	eq("previewEcho(null)", L().previewEcho(null), { summary: null });
});

// ════════════════════════════════════════════════════════════════════════════
section("§12 isolation: invoice-only");
test("lib/broker-invoice.js hands the draft routes this module (the one every draft-route harness already provides)", ({ ok }) => {
	ok("brokerInvoice.invoiceLines is lib/broker-invoice-lines.js", brokerInvoice.invoiceLines === L());
});
test("no other module in lib/ names the table or requires the module", ({ eq }) => {
	const libDir = path.join(ROOT, "lib");
	const hits = fs.readdirSync(libDir).filter((f) => /\.(c|m)?js$/.test(f) && f !== "broker-invoice-lines.js")
		.filter((f) => {
			const text = fs.readFileSync(path.join(libDir, f), "utf8");
			return /broker_invoice_lines|broker-invoice-lines|lines_json|gross_total/.test(text);
		});
	eq("only lib/broker-invoice.js (the re-export)", hits, ["broker-invoice.js"]);
	L();
});
test("the module is DB-only: no network, no file system, no Sheets, no process spawn", ({ ok }) => {
	const src = fs.readFileSync(LIB_FILE, "utf8").replace(/\/\/[^\n]*/g, "");
	ok("requires nothing", !/\brequire\(/.test(src));
	ok("no fetch / googleapis / child_process / fs", !/\bfetch\(|googleapis|child_process|\bfs\./.test(src));
});

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
process.exit(failed ? 1 : 0);
