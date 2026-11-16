#!/usr/bin/env node
/**
 * C.H. Robinson's advance, read from its revised rate con (lib/ratecon-advance-read.js,
 * RATECON_ADVANCE_READ_ENABLED, off). CHR's revised "Booked Load #" rate con prints a Total,
 * an "Advanced Total" (what CHR already paid on the load) and a "New Total". The app fills
 * the load's B20 advance line from it only when Advanced Total + New Total = Total to the
 * cent; otherwise it adds nothing and a person decides. Every value here is made up: load
 * numbers, amounts, names, addresses and rate-con text.
 *
 *   §1 the switch: on only when exactly "true"; server.js reads it once, off in a replica,
 *      and writes only with the advance lines themselves on.
 *   §2 the reader, on made-up shown text: each figure right beside its label, the labels
 *      joined with no spaces, the next item's digits joined straight on, a figure away from
 *      its label, a label twice, a minus sign, one decimal, "Subtotal:" and a commodity
 *      "Total:", no labels, no text, a hostile text read fast; whether the text names
 *      C.H. Robinson.
 *   §3 the same through made-up PDFs and lib/pdf-shown-text.js (glyph codes and literal
 *      strings), and a PDF with no text.
 *   §4 decide(), each path: the sum checks; off by a cent; the advance and the New Total read
 *      the wrong way round; a figure missing; the PDF not naming CHR; no text; lines that
 *      agree (the read's own, a person's); lines that don't (another amount, a voided line, a
 *      second revised rate con with another advance); an invoice already made, or unknown;
 *      Payment not the Total; Payment kept by the DVIR keep.
 *   §5 the reading store: 10 minutes, at most 200 loads, a reading with no advance label
 *      never replaces one with a label.
 *   §6 run() on an in-memory database: one line (kind advance, label "Advance", no
 *      reference), its audit row by the system actor, one decision row in cents and codes;
 *      the same email again adds nothing; a person's line is never touched; after an invoice
 *      nothing is added; off, the row says would_fill and nothing else happens; a notice goes
 *      once per load, reason and amount; a failed insert adds nothing and says so.
 *   §7 the wiring: POST /api/n8n/keep-stored-values, lifted with noteRateConReadings() (what
 *      the extract route runs after its answer), on made-up CHR loads: each path end to end;
 *      the answer to n8n is the same with the read on and off and the sheet is only read; a
 *      closed month, another broker, an 8-digit Load ID and a load not on Job Tracking get
 *      nothing; the switch on in a replica reads off.
 *   §8 the read-only report, scripts/ratecon-advance-read-report.js: what the read would
 *      fill, skip or hand to a person, per load and in counts; --db is required and opened
 *      read-only; a PDF folder replay counts the figure gate only.
 *
 * ADVANCE_READ_LIB=<file> loads another copy of the module (a mutant); SERVER_JS=<file>
 * lifts from another copy of server.js. Pure: in-memory SQLite and temporary folders, no
 * network. Run: node scripts/test-ratecon-advance-read.js  # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { textPdf } = require("./lib/made-up-pdf");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();
const rootRequire = createRequire(path.join(ROOT, "server.js"));
let Database;
try {
	Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const { shownText } = require(path.join(ROOT, "lib", "pdf-shown-text.js"));
const { invoiceLines } = require(path.join(ROOT, "lib", "broker-invoice.js"));
const LIB_FILE = process.env.ADVANCE_READ_LIB ? path.resolve(process.env.ADVANCE_READ_LIB) : path.join(ROOT, "lib", "ratecon-advance-read.js");
const REPORT_FILE = path.join(ROOT, "scripts", "ratecon-advance-read-report.js");
let A = null;
let loadError = "";
try { A = require(LIB_FILE); } catch (e) { loadError = e.message.split("\n")[0]; }

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function eqCheck(name, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	check(name, a === e, `expected ${e}, got ${a}`);
}
// A case that needs the module answers FAIL by name when it is missing.
function needsModule(name) {
	if (A) return true;
	check(name, false, `lib/ratecon-advance-read.js did not load (${loadError})`);
	return false;
}

// ── made-up rate-con text ───────────────────────────────────────────────────
const INTRO = "C.H. Robinson Booked Load # 123456701 Carrier Rate Confirmation for a made-up test load. Pickup at Test Shipper, Testville; delivery at Test Consignee, Sampletown. Equipment: van. Commodity Total: 20,000 lbs.";
const INTRO_OTHER = "Example Broker Load Confirmation for a made-up test load. Pickup at Test Shipper, Testville; delivery at Test Consignee, Sampletown. Equipment: van.";
const DVIR_LINE = "Missing Pre-Trip DVIR Inspection 1.00 -$35.00 -$35.00";
// The revised rate con: Line Haul $2,150.00, one DVIR line, Total $2,115.00, an advance of $500.00.
const REVISED = `${INTRO} Rate Detail Line Haul 1.00 $2,150.00 $2,150.00 ${DVIR_LINE} Total: $2,115.00 Advanced Total: $500.00 New Total: $1,615.00`;
// The contract-addendum layout, no DVIR line: Total $2,150.00, an advance of $500.00.
const REVISED_NO_DVIR = `${INTRO} Rate Details Line Haul 1.00 $2,150.00 $2,150.00 Total: $2,150.00 Advanced Total $500.00 New Total $1,650.00`;
const OFF_BY_A_CENT = `${INTRO} Rate Detail Line Haul 1.00 $2,150.00 $2,150.00 ${DVIR_LINE} Total: $2,115.00 Advanced Total: $500.00 New Total: $1,615.01`;
// The New Total's figure drawn before its label (the count's 10 of 24).
const AWAY = `${INTRO} Rate Detail Line Haul 1.00 $2,150.00 $2,150.00 ${DVIR_LINE} Total: $2,115.00 Advanced Total: $500.00 $1,615.00New Total:`;
const NO_NAME = `${INTRO_OTHER} Rate Detail Line Haul 1.00 $2,150.00 $2,150.00 ${DVIR_LINE} Total: $2,115.00 Advanced Total: $500.00 New Total: $1,615.00`;
const PLAIN = `${INTRO} Rate Detail Line Haul 1.00 $2,150.00 $2,150.00 Total: $2,150.00`;
// A second advance on the same load: Advanced Total $800.00.
const SECOND = `${INTRO} Rate Detail Line Haul 1.00 $2,150.00 $2,150.00 ${DVIR_LINE} Total: $2,115.00 Advanced Total: $800.00 New Total: $1,315.00`;
// The two figures the sum can't tell apart, the wrong way round.
const SWAPPED = `${INTRO} Rate Details Line Haul 1.00 $2,150.00 $2,150.00 Total: $2,150.00 Advanced Total: $1,650.00 New Total: $500.00`;

const CHR_EMAIL = "made-up.agent@chrobinson.com";
const OTHER_EMAIL = "ap@example-broker.test";
const DRIVER = "Pat Example";

// ── §1 the switch ───────────────────────────────────────────────────────────
function section1() {
	if (needsModule("§1 enabled(): on only when exactly \"true\"")) {
		eqCheck("§1 enabled(): on for \"true\" (spaces around), off for anything else",
			["true", " true ", "TRUE", "1", "yes", "on", "false", "", undefined, "enabled"].map((v) => A.enabled(v === undefined ? {} : { RATECON_ADVANCE_READ_ENABLED: v })),
			[true, true, false, false, false, false, false, false, false, false]);
		check("§1 enabled(): no settings at all is off", A.enabled() === false && A.enabled(null) === false);
		eqCheck("§1 linesOn(): the advance lines' own switch, read through their one reader",
			[{ BROKER_INVOICE_LINES_ENABLED: "true" }, { BROKER_INVOICE_LINES_ENABLED: "false" }, {}].map((env) => A.linesOn(env)), [true, false, false]);
	}
	// server.js: read once at boot, never in a replica, writing only with the lines on; one
	// warning at start when the switch is on but nothing can be written.
	let lift = null;
	try { lift = closure(SRC, { roots: ["RATECON_ADVANCE_READ_ENABLED", "RATECON_ADVANCE_READ_ON"], provided: ["require", "process", "console"] }).text; } catch (e) { lift = null; }
	const read = (env, replica = false) => {
		const warned = [];
		const quiet = { log() {}, error() {}, warn: (m) => warned.push(String(m)) };
		const got = new Function("require", "process", "console", `"use strict";\n${lift}\nreturn [RATECON_ADVANCE_READ_ENABLED, RATECON_ADVANCE_READ_ON];`)(
			(p) => (p === "./lib/replica-mode" ? { active: () => replica } : rootRequire(p)), { env }, quiet);
		return [...got, warned.length];
	};
	const both = { RATECON_ADVANCE_READ_ENABLED: "true", BROKER_INVOICE_LINES_ENABLED: "true" };
	eqCheck("§1 server.js: [read on, writes on, warnings] for the switch and the lines, the switch alone, the re-issue hold off, a replica, \"1\", nothing set",
		lift ? [read(both), read({ RATECON_ADVANCE_READ_ENABLED: "true" }), read({ ...both, RATECON_REISSUE_HOLD_ENABLED: "false" }), read(both, true), read({ ...both, RATECON_ADVANCE_READ_ENABLED: "1" }), read({})] : null,
		[[true, true, 0], [true, false, 1], [true, false, 1], [false, false, 0], [false, false, 0], [false, false, 0]]);
	if (A) {
		const w = (o) => { const out = []; const on = A.writesOn({ ...o, warn: (m) => out.push(m) }); return [on, out.join(" | ")]; };
		const [linesOff, linesWarn] = w({ enabled: true, env: {}, holdOn: true });
		const [holdOff, holdWarn] = w({ enabled: true, env: { BROKER_INVOICE_LINES_ENABLED: "true" }, holdOn: false });
		check("§1 writesOn(): off with a warning naming the advance lines' switch, or the re-issue hold",
			linesOff === false && /BROKER_INVOICE_LINES_ENABLED is off/.test(linesWarn) && holdOff === false && /RATECON_REISSUE_HOLD_ENABLED is off/.test(holdWarn), [linesWarn, holdWarn]);
		eqCheck("§1 writesOn(): on with all three, and quiet with the switch off", [w({ enabled: true, env: { BROKER_INVOICE_LINES_ENABLED: "true" }, holdOn: true }), w({ enabled: false, env: {}, holdOn: false })],
			[[true, ""], [false, ""]]);
	}
	const rules = rootRequire("./lib/replica-rules");
	check("§1 replica:start --enable refuses it, saying why", typeof rules.enableRefusal("RATECON_ADVANCE_READ_ENABLED") === "string"
		&& /advance/i.test(rules.enableRefusal("RATECON_ADVANCE_READ_ENABLED")), rules.enableRefusal("RATECON_ADVANCE_READ_ENABLED"));
}

// ── §2 the reader on shown text ─────────────────────────────────────────────
function section2() {
	if (!needsModule("§2 readAdvanceFigures()")) return;
	const R = (t) => A.readAdvanceFigures(t);
	eqCheck("§2 each figure right beside its label: the three figures in cents, and the text names C.H. Robinson", R(REVISED),
		{ state: "labels", namesChr: true, totalCents: 211500, advanceCents: 50000, newTotalCents: 161500, problem: null });
	eqCheck("§2 the no-DVIR layout, no colon after the advance labels", R(REVISED_NO_DVIR),
		{ state: "labels", namesChr: true, totalCents: 215000, advanceCents: 50000, newTotalCents: 165000, problem: null });
	eqCheck("§2 the labels joined with no spaces (one glyph per operator)", R("C.H.Robinson Total:$2,115.00AdvancedTotal:$500.00NewTotal:$1,615.00"),
		{ state: "labels", namesChr: true, totalCents: 211500, advanceCents: 50000, newTotalCents: 161500, problem: null });
	eqCheck("§2 figures without thousands commas", R("C.H. Robinson Total: $2115.00 Advanced Total: $500.00 New Total: $1615.00"),
		{ state: "labels", namesChr: true, totalCents: 211500, advanceCents: 50000, newTotalCents: 161500, problem: null });
	const away = R(AWAY);
	check("§2 the New Total's figure before its label: figure_missing, never a figure taken from elsewhere", away.state === "labels" && away.problem === "figure_missing" && away.newTotalCents === 0, away);
	const missing = R(`${INTRO} Total: $2,115.00 New Total: $1,615.00`);
	check("§2 a New Total with no Advanced Total: figure_missing", missing.problem === "figure_missing" && missing.advanceCents === 0, missing);
	const twice = R(`${REVISED} Advanced Total: $600.00`);
	check("§2 a label twice with two figures: figure_missing", twice.problem === "figure_missing", twice);
	const again = R(`${REVISED} Advanced Total: $500.00`);
	check("§2 a label twice with the same figure: read", again.problem === null && again.advanceCents === 50000, again);
	const bare = R(`${REVISED} The Advanced Total is paid by fuel card.`);
	check("§2 a label once more with no figure beside it: figure_missing", bare.problem === "figure_missing", bare);
	const negative = R(`${INTRO} Total: $2,115.00 Advanced Total: -$500.00 New Total: $1,615.00`);
	check("§2 a minus sign before the advance: figure_missing", negative.problem === "figure_missing", negative);
	const negative2 = R(`${INTRO} Total: $2,115.00 Advanced Total: $-500.00 New Total: $1,615.00`);
	check("§2 a minus sign after the dollar sign: figure_missing", negative2.problem === "figure_missing", negative2);
	const joined = R(`${INTRO} Total: $2,115.001.00 Advanced Total: $500.00Line New Total: $1,615.0011/12/2026`);
	check("§2 a figure with the next item's digits joined straight on (no space between): the figure is read",
		joined.problem === null && joined.totalCents === 211500 && joined.advanceCents === 50000 && joined.newTotalCents === 161500, joined);
	const cents1 = R(`${INTRO} Total: $2,115.00 Advanced Total: $500.5 New Total: $1,614.50`);
	check("§2 one decimal: figure_missing", cents1.problem === "figure_missing", cents1);
	const grouping = R(`${INTRO} Total: $2,1150.00 Advanced Total: $500.00 New Total: $1,615.00`);
	check("§2 a thousands group of four digits: figure_missing", grouping.problem === "figure_missing", grouping);
	const sub = R(`${INTRO} Subtotal: $2,150.00 ${REVISED.slice(INTRO.length)}`);
	check("§2 \"Subtotal:\" is not the Total", sub.problem === null && sub.totalCents === 211500, sub);
	const total2 = R(`${REVISED} Total: $9,999.00`);
	check("§2 a second rate Total with another figure: figure_missing", total2.problem === "figure_missing", total2);
	check("§2 a commodity \"Total:\" with no dollar figure is not the rate Total", R(REVISED).totalCents === 211500);
	eqCheck("§2 an ordinary rate con, no advance label: no_labels", R(PLAIN), { state: "no_labels", namesChr: true });
	eqCheck("§2 no text at all: unreadable", [R(""), R(null), R(undefined)], [{ state: "unreadable" }, { state: "unreadable" }, { state: "unreadable" }]);
	eqCheck("§2 the text doesn't name C.H. Robinson", R(NO_NAME).namesChr, false);
	const many = R(`${INTRO} ${"Advanced Total: $500.00 ".repeat(21)} Total: $2,115.00 New Total: $1,615.00`);
	check("§2 more than 20 of one label: figure_missing", many.problem === "figure_missing", many);
	const t0 = Date.now();
	const hostile = R(`${"Total:".repeat(200000)}${" ".repeat(200000)}${"$9".repeat(100000)} Advanced Total ${"$".repeat(200000)}`);
	check("§2 a hostile 2.2 MB text reads in under 2 s", Date.now() - t0 < 2000 && hostile.state === "labels", { ms: Date.now() - t0, hostile });
}

// ── §3 through made-up PDFs ─────────────────────────────────────────────────
function section3() {
	if (!needsModule("§3 the reader through made-up PDFs")) return;
	const viaPdf = (text, mode) => A.readAdvanceFigures(shownText(textPdf(text, { mode })));
	for (const mode of ["skia", "literal"]) {
		eqCheck(`§3 a revised rate con drawn as ${mode === "skia" ? "glyph codes (Chromium's way)" : "literal strings"}`, viaPdf(REVISED, mode),
			{ state: "labels", namesChr: true, totalCents: 211500, advanceCents: 50000, newTotalCents: 161500, problem: null });
		check(`§3 ...the away-from-label layout, ${mode}: figure_missing`, viaPdf(AWAY, mode).problem === "figure_missing");
	}
	eqCheck("§3 a PDF that shows no text: unreadable", A.readAdvanceFigures(shownText(textPdf("", { mode: "skia" }))), { state: "unreadable" });
	eqCheck("§3 bytes that are no PDF: unreadable", A.readAdvanceFigures(shownText(Buffer.from("not a pdf"))), { state: "unreadable" });
}

// ── §4 decide() ─────────────────────────────────────────────────────────────
const NO_LINES = Object.freeze({ activeCount: 0, activeCents: 0, voidedCount: 0, ownOnly: true });
function section4() {
	if (!needsModule("§4 decide()")) return;
	const reading = A.readAdvanceFigures(REVISED);
	const base = { reading, paymentCents: 211500, dvir: null, invoiced: false, lines: NO_LINES };
	const d = (over) => { const x = A.decide({ ...base, ...over }); return [x.verdict, x.reason]; };
	eqCheck("§4 the sum checks, Payment is the Total, no line, no invoice: fill", d({}), ["fill", "sum_checks"]);
	const full = A.decide(base);
	eqCheck("§4 ...with the figures in cents", [full.totalCents, full.advanceCents, full.newTotalCents, full.paymentCents], [211500, 50000, 161500, 211500]);
	eqCheck("§4 off by a cent: a person (sum_off)", d({ reading: A.readAdvanceFigures(OFF_BY_A_CENT) }), ["person", "sum_off"]);
	eqCheck("§4 the Advanced Total and New Total read the wrong way round (the advance over half the Total): a person (advance_over_half)",
		d({ reading: A.readAdvanceFigures(SWAPPED) }), ["person", "advance_over_half"]);
	eqCheck("§4 an advance of exactly half the Total: fill (the two figures are equal)",
		d({ reading: A.readAdvanceFigures(`${INTRO} Total: $2,000.00 Advanced Total: $1,000.00 New Total: $1,000.00`), paymentCents: 200000 }), ["fill", "sum_checks"]);
	eqCheck("§4 a figure missing: a person (figure_missing)", d({ reading: A.readAdvanceFigures(AWAY) }), ["person", "figure_missing"]);
	eqCheck("§4 the PDF doesn't name C.H. Robinson: a person (not_chr_text)", d({ reading: A.readAdvanceFigures(NO_NAME) }), ["person", "not_chr_text"]);
	eqCheck("§4 no text: unread", d({ reading: { state: "unreadable" } }), ["unread", "unreadable"]);
	eqCheck("§4 no advance label, or no reading: nothing", [d({ reading: A.readAdvanceFigures(PLAIN) }), d({ reading: null })], [["none", ""], ["none", ""]]);
	eqCheck("§4 the read's own line already holds this advance (the same email again, a second revised rate con with the same advance): same",
		d({ lines: { activeCount: 1, activeCents: 50000, voidedCount: 0, ownOnly: true } }), ["same", "own_line"]);
	eqCheck("§4 a person's line with the same amount: same, never touched", d({ lines: { activeCount: 1, activeCents: 50000, voidedCount: 0, ownOnly: false } }), ["same", "line_agrees"]);
	eqCheck("§4 a person's line with another amount: a person (lines_differ)", d({ lines: { activeCount: 1, activeCents: 45000, voidedCount: 0, ownOnly: false } }), ["person", "lines_differ"]);
	eqCheck("§4 a second revised rate con with another advance over the read's own line: a person (lines_differ)",
		d({ reading: A.readAdvanceFigures(SECOND), lines: { activeCount: 1, activeCents: 50000, voidedCount: 0, ownOnly: true } }), ["person", "lines_differ"]);
	eqCheck("§4 a voided line and none active: a person (lines_differ), never added again", d({ lines: { activeCount: 0, activeCents: 0, voidedCount: 1, ownOnly: true } }), ["person", "lines_differ"]);
	eqCheck("§4 the lines can't be read: a person (lines_differ)", d({ lines: null }), ["person", "lines_differ"]);
	eqCheck("§4 an invoice already made: a person (after_invoice), R11", d({ invoiced: true }), ["person", "after_invoice"]);
	eqCheck("§4 the drafts can't be read: as invoiced (after_invoice)", d({ invoiced: null }), ["person", "after_invoice"]);
	eqCheck("§4 an invoice made and the same line already there: same (nothing to tell)", d({ invoiced: true, lines: { activeCount: 1, activeCents: 50000, voidedCount: 0, ownOnly: false } }), ["same", "line_agrees"]);
	eqCheck("§4 Payment is the New Total (the advance already off it): a person (payment_not_total)", d({ paymentCents: 161500 }), ["person", "payment_not_total"]);
	eqCheck("§4 Payment isn't one amount: a person (payment_not_total)", d({ paymentCents: null }), ["person", "payment_not_total"]);
	const kept = { verdict: "kept", storedCents: 215000, sentCents: 211500 };
	eqCheck("§4 Payment kept at the stored figure by the DVIR keep for this email (its sent cents are the Total): fill",
		[d({ paymentCents: 215000, dvir: kept }), d({ paymentCents: 215000, dvir: { ...kept, verdict: "held" } })], [["fill", "sum_checks"], ["fill", "sum_checks"]]);
	eqCheck("§4 ...but not when the DVIR keep's email sent another figure, or kept another figure, or decided nothing",
		[d({ paymentCents: 215000, dvir: { ...kept, sentCents: 161500 } }), d({ paymentCents: 220000, dvir: kept }), d({ paymentCents: 215000, dvir: { ...kept, verdict: "none" } })],
		[["person", "payment_not_total"], ["person", "payment_not_total"], ["person", "payment_not_total"]]);
	eqCheck("§4 recordedVerdict(): the verdict with the switch on, would_* off",
		[["fill", true], ["fill", false], ["person", true], ["person", false], ["same", false], ["unread", true], ["none", true]].map(([v, on]) => A.recordedVerdict(v, on)),
		["filled", "would_fill", "person", "would_person", "same", "unread", null]);
	const values = A.lineValues(full);
	eqCheck("§4 the line: kind advance, label \"Advance\" (on the automatic invoice's closed list), the advance, no date, no reference",
		[values.kind, values.label, values.amountCents, values.receivedOn, values.reference], ["advance", "Advance", 50000, "", ""]);
	check("§4 ...its note names the three figures, which no invoice prints", /Total \$2,115\.00/.test(values.note) && /Advanced Total \$500\.00/.test(values.note) && /New Total \$1,615\.00/.test(values.note), values.note);
	const autoRules = rootRequire("./lib/auto-invoice-rules");
	eqCheck("§4 ...the automatic invoice's text gate passes it", autoRules.advanceLineTextRefusal([{ label: values.label, reference: values.reference }]), null);
}

// ── §5 the reading store ────────────────────────────────────────────────────
function section5() {
	if (!needsModule("§5 createReadingStore()")) return;
	const s = A.createReadingStore({ ttlMs: 10 * 60 * 1000, max: 3 });
	const revised = A.readAdvanceFigures(REVISED);
	const plain = A.readAdvanceFigures(PLAIN);
	const t = 1_800_000_000_000;
	s.note("123456701", revised, t);
	eqCheck("§5 a reading is kept by load", s.get("123456701", t + 1000), revised);
	check("§5 ...for 10 minutes", s.get("123456701", t + 10 * 60 * 1000) === null && s.get("123456701", t + 10 * 60 * 1000 - 1) !== null);
	s.note("123456701", plain, t + 2000);
	eqCheck("§5 a later reading with no advance label (another PDF of the same email) doesn't replace one with a label", s.get("123456701", t + 3000), revised);
	const second = A.readAdvanceFigures(SECOND);
	s.note("123456701", second, t + 4000);
	eqCheck("§5 a later reading with a label replaces it", s.get("123456701", t + 5000), second);
	s.note("123456702", plain, t);
	s.note("123456703", plain, t);
	s.note("123456704", plain, t);
	check("§5 at most `max` loads, the oldest dropped first", s.size() === 3 && s.get("123456701", t + 5000) === null, s.size());
	check("§5 a blank key keeps nothing", (() => { s.note("", revised, t); return s.get("", t) === null; })());
}

// ── the database ────────────────────────────────────────────────────────────
const DRAFTS_DDL = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS load_invoice_drafts \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
const LOCKS_DDL = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS period_locks \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
const AUDIT_DDL = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS audit_trail \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
const NOTICES_DDL = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS dispatch_notifications \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
function freshDb({ lines = true, drafts = true } = {}) {
	const db = new Database(":memory:");
	if (drafts && DRAFTS_DDL) db.exec(DRAFTS_DDL[1]);
	if (LOCKS_DDL) db.exec(LOCKS_DDL[1]);
	if (AUDIT_DDL) db.exec(AUDIT_DDL[1]);
	if (NOTICES_DDL) db.exec(NOTICES_DDL[1]);
	if (lines) invoiceLines.ensureSchema(db);
	return db;
}
const noticesOf = (db) => {
	try { return db.prepare("SELECT type, title, body FROM dispatch_notifications ORDER BY id").all(); } catch { return []; }
};
const linesOf = (db, key) => {
	try { return db.prepare(`SELECT load_id, load_key, kind, label, amount_cents, received_on, reference, note, created_by, voided_at FROM ${invoiceLines.TABLE} WHERE load_key = ? ORDER BY id`).all(key); } catch { return []; }
};
const readsOf = (db, key) => {
	try {
		return db.prepare("SELECT load_key, verdict, reason, total_cents, advance_cents, new_total_cents, payment_cents, line_id, switch_on, notified FROM ratecon_advance_reads WHERE load_key = ? ORDER BY id").all(key);
	} catch { return []; }
};
const auditsOf = (db, id) => {
	try { return db.prepare("SELECT username, role, action, entity, entity_id, details FROM audit_trail WHERE entity_id = ? ORDER BY id").all(id); } catch { return []; }
};
const personLine = (db, loadId, amount, actor = "made-up.admin") => invoiceLines.addLine(db, { loadId, values: { kind: "advance", label: "Fuel advance", amountCents: amount, receivedOn: "", reference: "", note: "" }, actor, closedMonths: [] }).line;
const addDraft = (db, loadId) => db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, total, broker_name) VALUES (?, ?, ?, 'Test Broker')").run(loadId, `INV-${loadId}`, "$2,115.00");

// ── §6 run() ────────────────────────────────────────────────────────────────
function hooksFor(db) {
	const audits = [];
	const notices = [];
	const audit = (action, detail, line) => {
		audits.push({ action, detail, loadId: line.loadId });
		db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, 'ratecon-advance-read', 'system', ?, 'load', ?, ?)")
			.run("2026-11-16T12:00:00.000Z", action, line.loadId, detail);
	};
	return { audits, notices, hooks: { audit, notify: (n) => notices.push(n) } };
}
function section6() {
	if (!needsModule("§6 run()")) return;
	const reading = A.readAdvanceFigures(REVISED);
	const db = freshDb();
	const h = hooksFor(db);
	const go = (loadId, over = {}) => A.run(db, { loadId, reading, paymentCents: 211500, dvir: null, on: true, closedMonths: [], at: "2026-11-16T12:00:00.000Z", ...over }, h.hooks);

	// The sum checks: one line, its audit row, one decision row.
	const r = go("123456701");
	eqCheck("§6 the sum checks: one B20 line, kind advance, label \"Advance\", $500.00, no date or reference, by the read's actor", linesOf(db, "123456701").map((l) => [l.load_id, l.kind, l.label, l.amount_cents, l.received_on, l.reference, l.created_by, l.voided_at]),
		[["123456701", "advance", "Advance", 50000, "", "", "ratecon-advance-read", null]]);
	check("§6 ...run() answers filled with the line's id", r && r.verdict === "filled" && r.lineId === (linesOf(db, "123456701").length ? db.prepare(`SELECT id FROM ${invoiceLines.TABLE} WHERE load_key = '123456701'`).get().id : -1), r);
	check("§6 ...one audit row, invoice_line_added, naming the three figures and \"invoice-only\"", h.audits.length === 1 && h.audits[0].action === "invoice_line_added"
		&& /invoice-only/.test(h.audits[0].detail) && /revised rate con/.test(h.audits[0].detail) && /Total \$2,115\.00/.test(h.audits[0].detail) && /New Total \$1,615\.00/.test(h.audits[0].detail), h.audits);
	eqCheck("§6 ...one decision row, in cents and codes", readsOf(db, "123456701"), [{ load_key: "123456701", verdict: "filled", reason: "sum_checks", total_cents: 211500, advance_cents: 50000, new_total_cents: 161500, payment_cents: 211500, line_id: 1, switch_on: 1, notified: 0 }]);
	check("§6 ...no notice for a line it filled", h.notices.length === 0, h.notices);

	// The same email again, or a second revised rate con with the same advance: nothing more.
	go("123456701");
	check("§6 the same email again: still one line, a \"same\" row, no audit row, no notice", linesOf(db, "123456701").length === 1 && h.audits.length === 1 && h.notices.length === 0
		&& readsOf(db, "123456701").map((x) => x.verdict).join() === "filled,same", readsOf(db, "123456701"));

	// A second revised rate con with another advance: nothing changed, a person is told.
	go("123456701", { reading: A.readAdvanceFigures(SECOND) });
	check("§6 a second revised rate con with another advance: the first line stays, nothing voided or added, one notice", linesOf(db, "123456701").length === 1 && linesOf(db, "123456701")[0].voided_at === null
		&& linesOf(db, "123456701")[0].amount_cents === 50000 && h.notices.length === 1 && /\$800\.00/.test(h.notices[0].body), { lines: linesOf(db, "123456701"), notices: h.notices });

	// A person's line already there: never touched.
	personLine(db, "123456702", 45000);
	go("123456702");
	check("§6 a person's line with another amount: untouched, nothing added, a person told (lines_differ)", linesOf(db, "123456702").length === 1 && linesOf(db, "123456702")[0].created_by === "made-up.admin"
		&& readsOf(db, "123456702")[0].reason === "lines_differ" && h.notices.length === 2, { lines: linesOf(db, "123456702"), reads: readsOf(db, "123456702") });
	personLine(db, "123456703", 50000);
	go("123456703");
	check("§6 a person's line with the same amount: untouched, a \"same\" row, no notice", linesOf(db, "123456703").length === 1 && readsOf(db, "123456703")[0].verdict === "same"
		&& readsOf(db, "123456703")[0].reason === "line_agrees" && h.notices.length === 2, readsOf(db, "123456703"));

	// An invoice already made (R11): nothing added, nothing re-sent, a person told once.
	addDraft(db, "#123456704");
	go("123456704");
	go("123456704");
	check("§6 an invoice already made (any spelling of the load): no line, after_invoice, one notice however often the email comes", linesOf(db, "123456704").length === 0
		&& readsOf(db, "123456704").map((x) => `${x.verdict}:${x.reason}:${x.notified}`).join() === "person:after_invoice:1,person:after_invoice:0" && h.notices.length === 3, { reads: readsOf(db, "123456704"), notices: h.notices.length });
	const r11 = h.notices[2] || { title: "", body: "" };
	check("§6 ...the notice says no line was added and nothing was re-sent", /nothing was re-sent/i.test(r11.body) && /\$500\.00/.test(r11.body) && /123456704/.test(r11.title), r11);

	// Off by a cent, a figure missing: a person, no line.
	go("123456705", { reading: A.readAdvanceFigures(OFF_BY_A_CENT) });
	go("123456706", { reading: A.readAdvanceFigures(AWAY) });
	check("§6 off by a cent: no line, sum_off, one notice", linesOf(db, "123456705").length === 0 && readsOf(db, "123456705")[0].reason === "sum_off" && h.notices.length === 5, readsOf(db, "123456705"));
	check("§6 a figure away from its label: no line, figure_missing", linesOf(db, "123456706").length === 0 && readsOf(db, "123456706")[0].reason === "figure_missing", readsOf(db, "123456706"));
	go("123456707", { paymentCents: 161500 });
	check("§6 Payment already the New Total: no line, payment_not_total", linesOf(db, "123456707").length === 0 && readsOf(db, "123456707")[0].reason === "payment_not_total", readsOf(db, "123456707"));
	go("123456708", { reading: { state: "unreadable" } });
	check("§6 an unreadable PDF: an \"unread\" row, no line, no notice", readsOf(db, "123456708").map((x) => x.verdict).join() === "unread" && h.notices.length === 6, { reads: readsOf(db, "123456708"), notices: h.notices.length });
	const before = db.prepare("SELECT COUNT(*) AS n FROM ratecon_advance_reads").get().n;
	go("123456709", { reading: A.readAdvanceFigures(PLAIN) });
	check("§6 an ordinary rate con (no advance label): no row at all", db.prepare("SELECT COUNT(*) AS n FROM ratecon_advance_reads").get().n === before);

	// The switch off: the decision only, recorded as would_*.
	const off = freshDb();
	const ho = hooksFor(off);
	A.run(off, { loadId: "123456711", reading, paymentCents: 211500, on: false, closedMonths: [], at: "2026-11-16T12:00:00.000Z" }, ho.hooks);
	A.run(off, { loadId: "123456712", reading: A.readAdvanceFigures(OFF_BY_A_CENT), paymentCents: 211500, on: false, closedMonths: [] }, ho.hooks);
	check("§6 off: no line, no audit row, no notice", linesOf(off, "123456711").length === 0 && ho.audits.length === 0 && ho.notices.length === 0);
	eqCheck("§6 off: the decisions recorded as would_fill and would_person, switch_on 0", [...readsOf(off, "123456711"), ...readsOf(off, "123456712")].map((x) => [x.verdict, x.reason, x.switch_on, x.notified]),
		[["would_fill", "sum_checks", 0, 0], ["would_person", "sum_off", 0, 0]]);

	// No lines table (BROKER_INVOICE_LINES_ENABLED off): nothing written, read as no lines.
	const noLines = freshDb({ lines: false });
	const hn = hooksFor(noLines);
	const nl = A.run(noLines, { loadId: "123456713", reading, paymentCents: 211500, on: false, closedMonths: [] }, hn.hooks);
	check("§6 no lines table: recorded as would_fill, no table made", nl && nl.verdict === "would_fill"
		&& !noLines.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(invoiceLines.TABLE), nl);
	// No drafts table: the invoice can't be told, so nothing is added.
	const noDrafts = freshDb({ drafts: false });
	const nd = A.run(noDrafts, { loadId: "123456714", reading, paymentCents: 211500, on: true, closedMonths: [] }, hooksFor(noDrafts).hooks);
	check("§6 no drafts table: after_invoice, no line (fails closed)", nd && nd.decision.reason === "after_invoice" && linesOf(noDrafts, "123456714").length === 0, nd);

	// A lines table the read can't query: as lines it can't tell, so a person decides.
	const odd = freshDb({ lines: false });
	odd.exec(`CREATE TABLE ${invoiceLines.TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, load_key TEXT)`);
	const od = A.run(odd, { loadId: "123456716", reading, paymentCents: 211500, on: true, closedMonths: [] }, hooksFor(odd).hooks);
	check("§6 a lines table that can't be read: lines_differ, nothing added", od && od.decision.reason === "lines_differ" && odd.prepare(`SELECT COUNT(*) AS n FROM ${invoiceLines.TABLE}`).get().n === 0, od);

	// A failed insert: nothing added, and a person is told.
	const broken = freshDb();
	broken.exec(`CREATE TRIGGER no_insert BEFORE INSERT ON ${invoiceLines.TABLE} BEGIN SELECT RAISE(ABORT, 'made-up failure'); END`);
	const hb = hooksFor(broken);
	const br = A.run(broken, { loadId: "123456715", reading, paymentCents: 211500, on: true, closedMonths: [] }, hb.hooks);
	check("§6 a failed insert: no line, write_failed, one notice, no audit row", br && br.decision.reason === "write_failed" && linesOf(broken, "123456715").length === 0
		&& hb.notices.length === 1 && hb.audits.length === 0, { br, notices: hb.notices });

	// The record: cents and codes only.
	const cols = db.prepare("PRAGMA table_info(ratecon_advance_reads)").all().map((c) => `${c.name} ${c.type}`);
	eqCheck("§6 ratecon_advance_reads holds the load key, the time, codes and cents only", cols,
		["id INTEGER", "load_key TEXT", "at TEXT", "verdict TEXT", "reason TEXT", "total_cents INTEGER", "advance_cents INTEGER", "new_total_cents INTEGER", "payment_cents INTEGER", "line_id INTEGER", "switch_on INTEGER", "notified INTEGER"]);
	const refused = ["verdict", "reason"].filter((c) => {
		const row = { verdict: "filled", reason: "sum_checks", [c]: DRIVER };
		try {
			db.prepare("INSERT INTO ratecon_advance_reads (load_key, at, verdict, reason, total_cents, advance_cents, new_total_cents, payment_cents, line_id, switch_on, notified) VALUES ('123456701', '2026-11-16T00:00:00.000Z', ?, ?, 1, 1, 0, NULL, NULL, 1, 0)").run(row.verdict, row.reason);
			return false;
		} catch { return true; }
	});
	eqCheck("§6 ...its code columns refuse free text (a made-up name)", refused, ["verdict", "reason"]);
	const textFree = [...h.notices, ...hb.notices].every((n) => !n.body.includes(DRIVER) && !n.title.includes(DRIVER));
	check("§6 no notice names a driver", textFree);
	// Purge: 400 days.
	A.purge(db, new Date("2028-01-01T00:00:00Z"));
	check("§6 purge() drops decision rows older than 400 days, never a line", db.prepare("SELECT COUNT(*) AS n FROM ratecon_advance_reads").get().n === 0 && linesOf(db, "123456701").length === 1);
}

// ── §7 the wiring ───────────────────────────────────────────────────────────
const KHEAD = 'app.post("/api/n8n/keep-stored-values"';
const SECRET = "test-secret";
const HEADERS = ["Contract ID", "Load ID", "Details", "Pickup Appointment", "Drop-off Appointment", "Job Status", "Driver", "  Payment  ", "Email", "Assigned Date"];
const sheetRow = (o) => HEADERS.map((h) => (o[h] === undefined ? "" : o[h]));
const chrRow = (id, extra = {}) => sheetRow({ "Load ID": id, Details: "Test freight, 20,000 lbs", "Pickup Appointment": "11/10/2026 08:00", "Drop-off Appointment": "11/11/2026 0:00",
	"Job Status": "In Transit", Driver: DRIVER, "  Payment  ": "$2,150.00", Email: CHR_EMAIL, "Assigned Date": "11/9/2026, 9:00:00 AM", ...extra });
const SEPTEMBER = { "Pickup Appointment": "9/28/2026 08:00", "Drop-off Appointment": "9/29/2026 0:00", "Assigned Date": "9/27/2026, 9:00:00 AM" };
const IDS = ["123456721", "123456722", "123456723", "123456724", "123456725", "123456726", "123456727", "123456728", "123456729", "123456730", "123456731", "123456732", "123456733"];
const SHEET = [HEADERS, ...IDS.map((id) => chrRow(id)),
	chrRow("123456740", { "Job Status": "Delivered" }),
	chrRow("123456741", { "Job Status": "Delivered", "  Payment  ": "$1,615.00" }),
	chrRow("123456742", SEPTEMBER),
	chrRow("LD-TEST-0001", { Email: OTHER_EMAIL }),
	chrRow("12345678"),
	chrRow("123456743", { Email: OTHER_EMAIL }),
];
// What n8n sends for a rate-con email of one of those loads.
const chrEmail = (id, payment, extra = {}) => ({ "Load ID": id, Details: "Test freight, 20,000 lbs", "Pickup Appointment": "11/10/2026 08:00", "Drop-off Appointment": "11/11/2026 0:00",
	Email: CHR_EMAIL, "Assigned Date": "11/12/2026, 7:00:00 AM", "  Payment  ": payment, ...extra });
const pdf64 = (text) => textPdf(text, { mode: "skia" }).toString("base64");

function wiringWorld({ env = {}, replica = false } = {}) {
	const db = freshDb();
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-09', 'locked', '2026-10-01T00:00:00Z')").run();
	const alerts = [];
	const calls = [];
	let lifted;
	try {
		// As the other keep-stored-values runners lift it: never the socket server or a mailer.
		lifted = closure(SRC, {
			routes: [KHEAD],
			roots: ["noteRateConReadings"],
			provided: ["getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "console", "process", "app", "require", "db", "alertRateConReissueHold"],
			denied: ["sendEmail", "transporter", "io", "server", "insertDispatchNotification"],
		});
	} catch (e) {
		return { error: e.message };
	}
	const routes = {};
	const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
	const sheets = { spreadsheets: { values: {
		get: async (q) => { calls.push(["get", q.range]); return { data: { values: SHEET } }; },
		update: async () => { calls.push(["update"]); }, append: async () => { calls.push(["append"]); }, batchUpdate: async () => { calls.push(["batchUpdate"]); },
	}, batchUpdate: async () => { calls.push(["batchUpdate"]); } } };
	const logs = [];
	const quiet = { ...console, log: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")) };
	const req = (p) => (p === "./lib/replica-mode" ? { ...rootRequire(p), active: () => replica } : rootRequire(p));
	const fns = new Function("getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "console", "process", "app", "require", "db", "alertRateConReissueHold",
		`"use strict";\n${lifted.text}\nreturn { noteRateConReadings, store: typeof rateConAdvanceReadings === "undefined" ? null : rateConAdvanceReadings };`)(
		async () => sheets, "sheet-under-test", (q, r, next) => next(), quiet, { env: { N8N_EXTRACT_SECRET: SECRET, ...env } }, app, req, db,
		(a) => { alerts.push(a); return Promise.resolve({ alerted: true }); });
	const post = async (body) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		await routes["/api/n8n/keep-stored-values"]({ headers: { "x-webhook-secret": SECRET }, body, ip: "" }, res);
		await new Promise((r) => setImmediate(r));
		return out;
	};
	// What the extract route does once its answer is sent, then n8n's keep-stored-values call.
	const email = async (id, text, payment, extra) => {
		if (text !== null) fns.noteRateConReadings(id, pdf64(text), "");
		return post({ loadId: id, values: chrEmail(id, payment, extra) });
	};
	return { db, post, email, alerts, calls, logs, notices: () => noticesOf(db), ...fns };
}
const ON = { RATECON_ADVANCE_READ_ENABLED: "true", BROKER_INVOICE_LINES_ENABLED: "true" };

async function section7() {
	const on = wiringWorld({ env: ON });
	if (on.error) { check("§7 keep-stored-values and noteRateConReadings lift from server.js", false, on.error); return; }
	const off = wiringWorld({ env: { BROKER_INVOICE_LINES_ENABLED: "true" } });

	// The sum checks: the load's advance line, as the system.
	const a = await on.email("123456721", REVISED_NO_DVIR, "$2,150.00");
	eqCheck("§7 sum checks (no DVIR, Payment the Total): one line of $500.00, label \"Advance\", by the read", linesOf(on.db, "123456721").map((l) => [l.load_id, l.label, l.amount_cents, l.created_by]),
		[["123456721", "Advance", 50000, "ratecon-advance-read"]]);
	const audit = auditsOf(on.db, "123456721");
	check("§7 ...one audit row by the system actor, invoice_line_added, naming the figures", audit.length === 1 && audit[0].username === "ratecon-advance-read" && audit[0].role === "system"
		&& audit[0].action === "invoice_line_added" && audit[0].entity === "load" && /Total \$2,150\.00/.test(audit[0].details), audit);
	eqCheck("§7 ...one decision row, filled", readsOf(on.db, "123456721").map((x) => [x.verdict, x.reason, x.advance_cents, x.payment_cents]), [["filled", "sum_checks", 50000, 215000]]);
	check("§7 ...the line names no driver, nor does its audit row", !JSON.stringify(linesOf(on.db, "123456721")).includes(DRIVER) && !JSON.stringify(audit).includes(DRIVER));
	// With a DVIR line: n8n writes the revised Total (the DVIR keep off), so Payment is that Total.
	await on.email("123456722", REVISED, "$2,115.00");
	eqCheck("§7 sum checks with a DVIR line (Payment written as the revised Total): one line of $500.00", linesOf(on.db, "123456722").map((l) => l.amount_cents), [50000]);

	// The answer to n8n never changes, and the sheet is only read.
	const b = await off.email("123456721", REVISED_NO_DVIR, "$2,150.00");
	eqCheck("§7 the answer to n8n is the same with the read on and off (never Payment, never a Sheets cell)", a.body, b.body);
	check("§7 the route only reads the sheet", [...on.calls, ...off.calls].every(([c]) => c === "get"), on.calls);

	// The switch off: a decision row, nothing else.
	check("§7 off: no line, no audit row, no notice", linesOf(off.db, "123456721").length === 0 && auditsOf(off.db, "123456721").length === 0 && off.notices().length === 0);
	eqCheck("§7 off: the decision recorded as would_fill", readsOf(off.db, "123456721").map((x) => [x.verdict, x.switch_on]), [["would_fill", 0]]);

	// Off by a cent.
	await on.email("123456723", OFF_BY_A_CENT, "$2,115.00");
	const centNotices = on.notices();
	check("§7 off by a cent: no line, sum_off, one notice of the Super Admin-only type, naming the load and the figures", linesOf(on.db, "123456723").length === 0 && readsOf(on.db, "123456723")[0]?.reason === "sum_off"
		&& centNotices.length === 1 && centNotices[0].type === "auto-invoice" && /123456723/.test(centNotices[0].title) && /\$1,615\.01/.test(centNotices[0].body), { reads: readsOf(on.db, "123456723"), notices: centNotices });
	// A figure missing.
	await on.email("123456724", AWAY, "$2,115.00");
	check("§7 a figure away from its label: no line, figure_missing", linesOf(on.db, "123456724").length === 0 && readsOf(on.db, "123456724")[0]?.reason === "figure_missing", readsOf(on.db, "123456724"));
	// The advance and the New Total the wrong way round: the sum checks, the line doesn't go.
	await on.email("123456733", SWAPPED, "$2,150.00");
	check("§7 an advance over half the Total (the two figures swapped): no line, advance_over_half", linesOf(on.db, "123456733").length === 0 && readsOf(on.db, "123456733")[0]?.reason === "advance_over_half", readsOf(on.db, "123456733"));
	// Not CHR: another broker's load, an 8-digit Load ID.
	for (const id of ["LD-TEST-0001", "12345678"]) {
		await on.email(id, REVISED_NO_DVIR, "$2,150.00", id === "LD-TEST-0001" ? { Email: OTHER_EMAIL } : {});
	}
	check("§7 not C.H. Robinson (another broker; an 8-digit Load ID): no line and no row, while a CHR load beside them got its line",
		linesOf(on.db, "123456721").length === 1 && ["ld-test-0001", "12345678"].every((k) => linesOf(on.db, k).length === 0 && readsOf(on.db, k).length === 0));
	await on.email("123456743", REVISED_NO_DVIR, "$2,150.00", { Email: OTHER_EMAIL });
	check("§7 a 9-digit load on another broker's email domain (read, then refused by the row's CHR test): no line and no row",
		linesOf(on.db, "123456743").length === 0 && readsOf(on.db, "123456743").length === 0 && Boolean(on.store) && on.store.get("123456743") !== null);
	// A person's B20 line already there.
	personLine(on.db, "123456725", 45000);
	await on.email("123456725", REVISED_NO_DVIR, "$2,150.00");
	check("§7 a person's B20 line already there: never touched, nothing added, lines_differ", linesOf(on.db, "123456725").map((l) => `${l.created_by}:${l.amount_cents}`).join() === "made-up.admin:45000"
		&& readsOf(on.db, "123456725")[0]?.reason === "lines_differ", { lines: linesOf(on.db, "123456725"), reads: readsOf(on.db, "123456725") });
	// A second revised rate con.
	await on.email("123456726", REVISED_NO_DVIR, "$2,150.00");
	await on.email("123456726", REVISED_NO_DVIR, "$2,150.00");
	check("§7 a second revised rate con with the same advance: still one line", linesOf(on.db, "123456726").length === 1 && readsOf(on.db, "123456726").map((x) => x.verdict).join() === "filled,same", readsOf(on.db, "123456726"));
	await on.email("123456726", SECOND.replace("Total: $2,115.00", "Total: $2,150.00").replace("$1,315.00", "$1,350.00"), "$2,150.00");
	check("§7 a second revised rate con with another advance: the first line stays, nothing added, lines_differ", linesOf(on.db, "123456726").map((l) => l.amount_cents).join() === "50000"
		&& readsOf(on.db, "123456726").slice(-1)[0]?.reason === "lines_differ", readsOf(on.db, "123456726"));
	// After the invoice went (R11).
	addDraft(on.db, "123456727");
	await on.email("123456727", REVISED_NO_DVIR, "$2,150.00");
	check("§7 after the invoice went: no line, after_invoice, a notice; nothing re-sent", linesOf(on.db, "123456727").length === 0 && readsOf(on.db, "123456727")[0]?.reason === "after_invoice"
		&& on.notices().some((n) => /123456727/.test(n.title) && /nothing was re-sent/.test(n.body)), readsOf(on.db, "123456727"));
	check("§7 no notice names the load's driver", on.notices().every((n) => !n.title.includes(DRIVER) && !n.body.includes(DRIVER)));
	// Payment is already the New Total on a delivered load (a person typed it): nothing added.
	await on.email("123456741", REVISED_NO_DVIR, "$2,150.00");
	check("§7 a delivered load whose Payment is already the New Total (the answer keeps it): no line, payment_not_total", linesOf(on.db, "123456741").length === 0
		&& readsOf(on.db, "123456741")[0]?.reason === "payment_not_total", readsOf(on.db, "123456741"));
	// A delivered load not yet invoiced, Payment the Total: its line (the person's hand draft prints it).
	await on.email("123456740", REVISED_NO_DVIR, "$2,150.00");
	eqCheck("§7 a delivered load not yet invoiced: its line", linesOf(on.db, "123456740").map((l) => l.amount_cents), [50000]);
	// A closed month: nothing read or recorded.
	await on.email("123456742", REVISED_NO_DVIR, "$2,150.00", SEPTEMBER);
	check("§7 a closed month: no line and no row", linesOf(on.db, "123456742").length === 0 && readsOf(on.db, "123456742").length === 0);
	// No rate con read for this email (a restart, or an email with no PDF): nothing.
	await on.email("123456728", null, "$2,150.00");
	check("§7 no reading for the load: no line and no row", linesOf(on.db, "123456728").length === 0 && readsOf(on.db, "123456728").length === 0);
	// A load not on Job Tracking yet.
	await on.email("123456799", REVISED_NO_DVIR, "$2,150.00");
	check("§7 a load not on Job Tracking: no line and no row", linesOf(on.db, "123456799").length === 0 && readsOf(on.db, "123456799").length === 0);
	// The DVIR keep on: Payment kept at the stored figure, the line still filled.
	const keep = wiringWorld({ env: { ...ON, RATECON_DVIR_KEEP_ENABLED: "true" } });
	await keep.email("123456729", REVISED, "$2,115.00");
	check("§7 with the DVIR keep on: Payment kept as stored and the line filled beside it", linesOf(keep.db, "123456729").map((l) => l.amount_cents).join() === "50000"
		&& readsOf(keep.db, "123456729")[0]?.payment_cents === 215000, readsOf(keep.db, "123456729"));

	// The switch on in a replica: off.
	const rep = wiringWorld({ env: ON, replica: true });
	await rep.email("123456730", REVISED_NO_DVIR, "$2,150.00");
	check("§7 the switch on in a replica: no line, recorded as would_fill", linesOf(rep.db, "123456730").length === 0 && readsOf(rep.db, "123456730").map((x) => x.verdict).join() === "would_fill", readsOf(rep.db, "123456730"));
	// The lines off: off, with the decision only.
	const nl = wiringWorld({ env: { RATECON_ADVANCE_READ_ENABLED: "true" } });
	await nl.email("123456731", REVISED_NO_DVIR, "$2,150.00");
	check("§7 BROKER_INVOICE_LINES_ENABLED off: no line, recorded as would_fill", linesOf(nl.db, "123456731").length === 0 && readsOf(nl.db, "123456731").map((x) => x.verdict).join() === "would_fill", readsOf(nl.db, "123456731"));
	// The re-issue hold off: nothing read or decided.
	const nh = wiringWorld({ env: { ...ON, RATECON_REISSUE_HOLD_ENABLED: "false" } });
	await nh.email("123456732", REVISED_NO_DVIR, "$2,150.00");
	check("§7 RATECON_REISSUE_HOLD_ENABLED off: no line and no row", linesOf(nh.db, "123456732").length === 0 && readsOf(nh.db, "123456732").length === 0);
	// The reading is taken only for a 9-digit load number, as C.H. Robinson's are.
	const pre = wiringWorld({ env: ON });
	pre.noteRateConReadings("LD-TEST-0001", pdf64(REVISED_NO_DVIR), "");
	pre.noteRateConReadings("12345678", pdf64(REVISED_NO_DVIR), "");
	const skipped = pre.store ? pre.store.size() : -1;
	pre.noteRateConReadings("#123456733", pdf64(REVISED_NO_DVIR), "");
	check("§7 a Load Number that isn't 9 digits is never read; a 9-digit one is (a leading # aside)", skipped === 0 && pre.store && pre.store.size() === 1 && pre.store.get("123456733") !== null,
		{ skipped, size: pre.store && pre.store.size() });
}

// ── §8 the report ───────────────────────────────────────────────────────────
async function section8() {
	if (!fs.existsSync(REPORT_FILE)) { check("§8 scripts/ratecon-advance-read-report.js exists", false); return; }
	if (!needsModule("§8 the report")) return;
	const report = require(REPORT_FILE);
	const db = freshDb();
	const h = hooksFor(db);
	const reading = A.readAdvanceFigures(REVISED);
	const shadow = (loadId, over = {}, at = "2026-11-16T12:00:00.000Z") => A.run(db, { loadId, reading, paymentCents: 211500, on: false, closedMonths: [], at, ...over }, h.hooks);
	shadow("123456751");
	shadow("123456751", {}, "2026-11-16T13:00:00.000Z");
	shadow("123456752");
	shadow("123456753", { reading: A.readAdvanceFigures(OFF_BY_A_CENT) });
	addDraft(db, "123456754");
	shadow("123456754");
	shadow("123456755", { reading: { state: "unreadable" } });
	shadow("123456756", {}, "2026-11-01T12:00:00.000Z");
	// What a person did since: typed the same advance on one, drafted another at the full figure.
	personLine(db, "123456752", 50000);
	addDraft(db, "123456751");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-read-report-"));
	try {
		const file = path.join(dir, "app.db");
		fs.writeFileSync(file, db.serialize());
		const hash = () => require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		const h0 = hash();
		const out = report.buildReport({ dbPath: file, since: "2026-11-10" });
		check("§8 the database file is byte-identical after the report (read-only)", hash() === h0);
		eqCheck("§8 counts by verdict, since the date (each load's latest decision)", out.summary.loadsByVerdict, { would_fill: 2, would_person: 2, unread: 1 });
		eqCheck("§8 the advances the read would fill, in cents", out.summary.wouldFillCents, 100000);
		eqCheck("§8 to a person, by reason", out.summary.personReasons, { after_invoice: 1, sum_off: 1 });
		const row = (k) => out.loads.find((l) => l.loadKey === k);
		eqCheck("§8 per load: what it would do, and what is on the load now", [row("123456751"), row("123456752")].map((l) => l && [l.verdict, l.reason, l.advanceCents, l.emails, l.linesNow, l.invoicedNow]),
			[["would_fill", "sum_checks", 50000, 2, "none", true], ["would_fill", "sum_checks", 50000, 1, "same", false]]);
		check("§8 the list names each load, and --counts names none", /123456751/.test(out.text) && !/\b1234567\d\d\b/.test(report.buildReport({ dbPath: file, since: "2026-11-10", counts: true }).text));
		check("§8 an older decision is left out", !out.loads.some((l) => l.loadKey === "123456756"));
		let refused = "";
		try { report.buildReport({ dbPath: path.join(dir, "none.db"), since: "2026-11-10" }); } catch (e) { refused = e.message; }
		check("§8 a missing database is refused, never made", Boolean(refused) && !fs.existsSync(path.join(dir, "none.db")), refused);
		const empty = path.join(dir, "empty.db");
		new Database(empty).close();
		const none = report.buildReport({ dbPath: empty, since: "2026-11-10" });
		check("§8 a database with no decision table says nothing was recorded", none.present === false && /nothing recorded/.test(none.text), none.text);
		let bad = "";
		try { report.buildReport({ dbPath: file, since: "last week" }); } catch (e) { bad = e.message; }
		check("§8 --since must be a date or an ISO time", /--since/.test(bad), bad);
		// The command line: --db is required.
		const { spawnSync } = require("child_process");
		const noDb = spawnSync(process.execPath, [REPORT_FILE, "--since=2026-11-10"], { encoding: "utf8", cwd: dir, env: { PATH: process.env.PATH } });
		check("§8 without --db it exits 2 before opening anything", noDb.status === 2 && /--db/.test(noDb.stderr), { status: noDb.status, stderr: noDb.stderr });
		const run = spawnSync(process.execPath, [REPORT_FILE, "--since=2026-11-10", `--db=${file}`, "--counts"], { encoding: "utf8", cwd: dir, env: { PATH: process.env.PATH } });
		check("§8 with --db it prints the counts and exits 0", run.status === 0 && /would_fill/.test(run.stdout), { status: run.status, stderr: run.stderr });
		// The PDF folder replay: the figure gate only, counts only.
		const pdfs = path.join(dir, "pdfs");
		fs.mkdirSync(pdfs);
		for (const [name, text] of [["a.pdf", REVISED], ["b.pdf", REVISED_NO_DVIR], ["c.pdf", AWAY], ["d.pdf", OFF_BY_A_CENT], ["e.pdf", PLAIN], ["f.pdf", NO_NAME]]) fs.writeFileSync(path.join(pdfs, name), textPdf(text, { mode: "skia" }));
		fs.writeFileSync(path.join(pdfs, "g.pdf"), textPdf("", { mode: "skia" }));
		const replay = report.replayPdfDir({ dir: pdfs });
		eqCheck("§8 a PDF folder replay: the figure gate's verdicts, in counts", replay.counts, { sum_checks: 2, sum_off: 1, figure_missing: 1, not_chr_text: 1, no_labels: 1, unreadable: 1 });
		check("§8 ...naming no file", !/[a-g]\.pdf/.test(replay.text), replay.text);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

(async () => {
	section1();
	section2();
	section3();
	section4();
	section5();
	section6();
	await section7();
	await section8();
	console.log(`\n${failures ? "FAILED" : "PASSED"}: ${passes} passed, ${failures} failed`);
	process.exit(failures ? 1 : 0);
})().catch((e) => {
	console.error(`FAILED: ${e && e.stack ? e.stack : e}`);
	process.exit(1);
});
