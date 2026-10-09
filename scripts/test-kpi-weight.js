#!/usr/bin/env node
/**
 * The KPI bot's freight-weight reader (lib/kpi-weight.js) and the rule that picks
 * a load's stated weight (statedWeight() in lib/kpi-metrics.js).
 *
 * §1 a weight counts with a unit (lb, lbs, pounds, "#" straight after the number,
 *    kg converted at 2.20462) or right after a weight label; thousands
 *    separators and decimals; a labelled weight beats an unlabelled one.
 * §2 never a weight: a ZIP code, a bare number, money, a date, a phone number,
 *    the "MAX GROSS WEIGHT 80,000 LB" boilerplate, limit wording, anything
 *    outside 100–48,000 lb.
 * §3 two different plausible weights are a conflict (never the larger); repeats
 *    and a pound/kilogram pair of one weight are not.
 * §4 the 200,000-character cap comes before any regex, and a pathological text
 *    finishes in under TIMING_BUDGET_MS (200 ms).
 * §5 classifyPdfText(): too large, no text (short, binary, or the raw-file
 *    fallback extractPdfText() returns when it finds no strings), ok.
 * §6 fixtures: three tiny PDFs built here (deflate streams) through the real
 *    extractPdfText(), classifyPdfText() and parseWeight(); realistic Details
 *    cells.
 * §7 the load's weight: the Details cell first, then the rate con's.
 * §8 MUTANTS: each plausible regression, applied to the shipped source, must
 *    fail the section that guards it.
 *
 * Fixtures are fake ("Zed Sentinel" names). Pure: no server, no files written.
 *
 * Run: node scripts/test-kpi-weight.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "lib");
// The same budget scripts/test-collapse-address-linear.js uses: generous enough
// for a shared 2-core CI runner, far below what a backtracking regex takes on
// 200 KB (seconds).
const TIMING_BUDGET_MS = 200;
const SOURCES = {
	weight: fs.readFileSync(path.join(LIB, "kpi-weight.js"), "utf8"),
	metrics: fs.readFileSync(path.join(LIB, "kpi-metrics.js"), "utf8"),
};
const { extractPdfText } = require(path.join(LIB, "broker-invoice.js"));

let pass = 0;
const failures = [];
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }

function compileLib(file, src, overrides) {
	const filename = path.join(LIB, file);
	const req = Module.createRequire(filename);
	const localRequire = (id) => (overrides && Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : req(id));
	const m = { exports: {} };
	new Function("module", "exports", "require", "__filename", "__dirname", src)(m, m.exports, localRequire, filename, LIB);
	return m.exports;
}
function swap(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) die(`mutant anchor not found exactly once (${n}): ${from}`);
	return src.replace(from, () => to);
}
const realWeight = compileLib("kpi-weight.js", SOURCES.weight);
const REAL = { weight: realWeight, metrics: compileLib("kpi-metrics.js", SOURCES.metrics, { "./kpi-weight": realWeight }) };

// ── fixtures ─────────────────────────────────────────────────────────────────
// A one-page PDF whose single content stream is `content`, deflated.
function makePdf(content) {
	const stream = zlib.deflateSync(Buffer.from(content, "latin1"));
	return Buffer.concat([
		Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1"),
		Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
			+ "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n", "latin1"),
		Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
		stream,
		Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"),
	]);
}
const RATECON_STREAM = [
	"BT /F1 11 Tf 72 720 Td (ZED SENTINEL FREIGHT - RATE CONFIRMATION) Tj",
	"0 -14 Td (Load # 7700123   Pickup: Zed Sentinel Mill, Atlanta, GA 30301) Tj",
	"0 -14 Td (Delivery: Zed Sentinel Foods, Dallas, TX 75201   Appt 10/12/2026 08:00) Tj",
	"0 -14 Td (Commodity: Paper rolls   Pieces: 22   Weight: 42,000 LBS) Tj",
	"0 -14 Td (MAX GROSS WEIGHT 80,000 LB) Tj",
	"0 -14 Td (Rate: $2,450.00   Miles: 812) Tj ET",
].join("\n");
const PDF_TEXT = makePdf(RATECON_STREAM);
const PDF_DRAWING = makePdf("q 1 0 0 1 0 0 cm 0 0 m 200 200 l S 72 72 300 200 re f Q");
const PDF_BINARY = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 167 + 13) & 0xff));

// Details cells as the rate-con extractor writes them (shapes, not real loads).
const DETAILS = [
	["Commodity: Frozen poultry; Weight: 42,000 lbs; Pallets: 22; Temp: -10F", 42000],
	["Paper rolls, 43,764 lb, 24 pieces, tarps required", 43764],
	["Weight (lbs): 38,500 | Reefer 34F continuous | Seal required", 38500],
	["Est. Weight 40,000 lbs. Driver assist. Max gross weight 80,000 lb", 40000],
	["Beverages 22 pallets 41,250# ", 41250],
	["Steel coils 19,050 kg, chains and binders required", 41998],
	["Dry van 53', no touch freight, deliver to ZIP 30301", null],
	["Reefer; continuous; 34F; load # 1123581321", null],
];

function timed(f) {
	let best = Infinity;
	for (let i = 0; i < 3; i++) {
		const t0 = process.hrtime.bigint();
		f();
		best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
	}
	return best;
}
// Whitespace and digit runs, and the shapes each regex works hardest on: a
// label followed by a long gap, unit words with no number, separators.
const PATHOLOGICAL_UNITS = [
	`${"9".repeat(60)}${" ".repeat(60)}${"1,000,".repeat(12)}${"\t".repeat(30)}Weight${" ".repeat(40)}${"4".repeat(30)}wt.${" \n".repeat(20)}`,
	"9 ", "wt ", "1,000,", "1234567890", "\n\n\n\n9\n", "1 lbs ", "max 45,000 lbs ",
	"Weight lbs lbs lbs lbs lbs lbs lbs lbs lbs lbs lbs lbs lbs ",
	"Weight: : : : : : : : : : : : : : ",
	"Weight (kg) - - - - - - - - - - ( ) [ ] 4 ",
];
function pathological(length, unit) {
	const u = unit || PATHOLOGICAL_UNITS[0];
	return u.repeat(Math.ceil(length / u.length)).slice(0, length);
}

// ── the battery ──────────────────────────────────────────────────────────────
function battery(mods) {
	const r = [];
	const t = (cond, name, detail) => r.push({ ok: !!cond, name: detail === undefined ? name : `${name} (${detail})` });
	const W = mods.weight;
	const M = mods.metrics;
	const pw = (s) => W.parseWeight(s);
	const okIs = (s, lb, evidence, tag) => {
		const p = pw(s);
		t(p.status === "ok" && p.weightLb === lb && (!evidence || p.evidence === evidence), `${tag} ${JSON.stringify(s)} -> ${lb} lb${evidence ? ` (${evidence})` : ""}`, JSON.stringify(p));
	};
	const none = (s, tag) => {
		const p = pw(s);
		t(p.status === "none" && p.weightLb === null && p.evidence === "none", `${tag} ${JSON.stringify(s)} is no weight`, JSON.stringify(p));
	};

	// §1 units and labels
	okIs("Weight: 42,000 LBS", 42000, "labelled", "§1");
	okIs("Gross Weight: 43,764 lb", 43764, "labelled", "§1");
	okIs("Estimated Weight 40,000", 40000, "labelled", "§1");
	okIs("WT: 41500", 41500, "labelled", "§1");
	okIs("Weight (kg): 19,050", 41998, "labelled", "§1");
	okIs("42000.0LBS", 42000, "unit", "§1");
	okIs("38,000 pounds of resin", 38000, "unit", "§1");
	okIs("Total 42000# on 22 pallets", 42000, "unit", "§1");
	okIs("19,050 kg", 41998, "kg", "§1");
	okIs("12,500 KGS", 27558, "kg", "§1");
	okIs("Pallets 22 @ 1,200 lbs each. Total Weight: 26,400 lbs", 26400, "labelled", "§1");
	okIs("Load 1,000,000 lbs? no. Weight: 40,000", 40000, "labelled", "§1");

	// §2 never a weight
	none("Deliver to Zed Sentinel Foods, Atlanta, GA 30301", "§2");
	none("Load # 7700123, PO 4412, 812 miles", "§2");
	none("Rate: $2,450.00 all in", "§2");
	none("Pickup 10/12/2026 08:00, deliver 10/14/2026", "§2");
	none("Weight: 2026-10-12", "§2");
	none("Call 404-555-0142 for appointment", "§2");
	none("MAX GROSS WEIGHT 80,000 LB", "§2");
	none("Do not exceed 45,000 lbs", "§2");
	none("Trailer capacity 45,000 lbs", "§2");
	none("45,000 lbs max", "§2");
	none("Weight: 52,000 lbs", "§2");
	none("Weight: 99 lbs", "§2");
	none("Case weight 35 lbs", "§2");
	none("", "§2");
	none(null, "§2");
	okIs("Weight: 42,000 LBS MAX GROSS WEIGHT 80,000 LB", 42000, "labelled", "§2 the boilerplate beside a real weight leaves it alone:");
	t(W.isPlausibleLb(100) && W.isPlausibleLb(48000) && !W.isPlausibleLb(99.9) && !W.isPlausibleLb(48001) && !W.isPlausibleLb(NaN) && !W.isPlausibleLb("42000"),
		"§2 isPlausibleLb: 100 to 48,000 lb, numbers only");

	// §3 conflicts and repeats
	const c = pw("Est. Weight 40,000 lbs; Actual Weight: 42,500 lbs");
	t(c.status === "conflict" && c.weightLb === null && c.evidence === "conflict", "§3 two labelled weights 6% apart are a conflict, not the larger", JSON.stringify(c));
	const cu = pw("Stop 1: 18,000 lbs. Stop 2: 22,000 lbs.");
	t(cu.status === "conflict" && cu.weightLb === null, "§3 two unlabelled weights are a conflict", JSON.stringify(cu));
	okIs("Weight: 42,000 LBS ... Weight: 42,000 LBS", 42000, "labelled", "§3 a repeat is fine:");
	okIs("Weight: 42,000 LBS (19,051 KG)", 42000, "labelled", "§3 a pound/kilogram pair within 1% is one weight:");
	okIs("42,000 lbs / 19,051 kg", 42000, "unit", "§3 the same pair unlabelled:");
	okIs("Weight: 40,000 lbs; 22 pallets at 1,800 lbs", 40000, "labelled", "§3 a labelled weight beats a different unlabelled one:");

	// §4 the cap and the bounded regexes
	t(W.MAX_TEXT_CHARS === 200000 && W.MAX_PDF_BYTES === 3 * 1024 * 1024, "§4 MAX_TEXT_CHARS 200,000; MAX_PDF_BYTES 3 MB");
	const past = `${" ".repeat(250000)}Weight: 42,000 lbs`;
	t(pw(past).status === "none", "§4 a weight past character 200,000 is not read");
	const inside = `${" ".repeat(199000)}Weight: 42,000 lbs`;
	t(pw(inside).weightLb === 42000, "§4 a weight inside the cap is read");
	for (const [i, unit] of PATHOLOGICAL_UNITS.entries()) {
		const p200 = pathological(200000, unit);
		const ms200 = timed(() => { W.parseWeight(p200); W.classifyPdfText(p200, 1000); });
		t(ms200 < TIMING_BUDGET_MS, `§4 200 KB of pathological text #${i + 1} (${JSON.stringify(unit.slice(0, 16))}…): under ${TIMING_BUDGET_MS} ms`, `${ms200.toFixed(1)} ms`);
	}
	const p8m = pathological(8 * 1024 * 1024);
	const ms8m = timed(() => { W.parseWeight(p8m); W.classifyPdfText(p8m, 1000); });
	t(ms8m < TIMING_BUDGET_MS, `§4 8 MB of it: still under ${TIMING_BUDGET_MS} ms, the cap cuts it first`, `${ms8m.toFixed(1)} ms`);

	// §4 extractPdfText()'s maxInflatedBytes (the nightly job reads files it never chose)
	const small = makePdf("BT (Weight: 42,000 lbs) Tj ET");
	t(extractPdfText(small) === extractPdfText(small, { maxInflatedBytes: 8 * 1024 * 1024 }), "§4 a normal rate-con reads the same with the cap as without it");
	const bomb = makePdf("(Weight: 42,000 lbs) Tj\n".repeat(400000));
	const tb = Date.now();
	const capped = extractPdfText(bomb, { maxInflatedBytes: 1024 * 1024 });
	t(Date.now() - tb < TIMING_BUDGET_MS && !/Weight: 42,000/.test(capped), "§4 a stream that inflates past the cap is not inflated (kept as its raw bytes)");
	t(capped.length <= 1024 * 1024, "§4 the text handed back is cut to the cap");
	t(/Weight: 42,000/.test(extractPdfText(bomb)), "§4 ...and without the cap (the invoice routes) nothing changes");
	const streamOf = (body) => {
		const z = zlib.deflateSync(Buffer.from(body, "latin1"));
		return Buffer.concat([Buffer.from(`9 0 obj\n<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), z, Buffer.from("\nendstream\nendobj\n", "latin1")]);
	};
	const bombThenText = Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), streamOf("(x) Tj\n".repeat(400000)), streamOf("BT (Weight: 42,000 lbs) Tj ET")]);
	t(!/Weight: 42,000/.test(extractPdfText(bombThenText, { maxInflatedBytes: 1024 * 1024 })), "§4 a stream past the budget spends all of it: no later stream is inflated");
	t(/Weight: 42,000/.test(extractPdfText(bombThenText)), "§4 ...while without the cap both streams are read");

	// §5 classifyPdfText
	const prose = "ZED SENTINEL FREIGHT RATE CONFIRMATION Pickup Atlanta GA Delivery Dallas TX Commodity paper rolls Weight 42,000 LBS Rate $2,450.00";
	t(W.classifyPdfText(prose, 3 * 1024 * 1024 + 1) === "too_large" && W.classifyPdfText(prose, 3 * 1024 * 1024) === "ok", "§5 over 3 MB is too_large; 3 MB is read");
	t(W.classifyPdfText("", 1000) === "no_text" && W.classifyPdfText("Weight: 42,000 LBS   Rate $2,450", 1000) === "no_text", "§5 empty or short text is no_text");
	t(W.classifyPdfText(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${"0 0 m 200 200 l S ".repeat(20)}`, 2000) === "no_text", "§5 the raw-file fallback is no_text");
	t(W.classifyPdfText(Buffer.from(Array.from({ length: 2000 }, (_, i) => 0x80 + (i % 120))).toString("latin1"), 2000) === "no_text", "§5 binary is no_text");
	t(W.classifyPdfText(`${prose}${"\u0001".repeat(10)}`, 2000) === "ok", "§5 a few control characters in real text are fine");
	// Real rate cons' text strings carry font bytes: measured median 41% printable.
	const fontBytes = Buffer.from(Array.from({ length: 900 }, (_, i) => 0x80 + (i % 100))).toString("latin1");
	t(W.classifyPdfText(`${fontBytes} ${prose} ${fontBytes}`, 5000) === "ok", "§5 real text among font bytes (under half printable) is read");
	t(W.classifyPdfText(`${fontBytes} Rate Load ${"x7Q!".repeat(40)} ${fontBytes}`, 5000) === "no_text", "§5 noise with fewer than MIN_RATECON_WORDS rate-con words is no_text");
	t(W.MIN_RATECON_WORDS === 4, "§5 four distinct rate-con words make text readable");

	// §6 PDFs through the real extractor, and Details cells
	const tText = extractPdfText(PDF_TEXT);
	t(W.classifyPdfText(tText, PDF_TEXT.length) === "ok", "§6 the rate-con PDF has text");
	const wText = W.parseWeight(tText);
	t(wText.status === "ok" && wText.weightLb === 42000 && wText.evidence === "labelled", "§6 ...and states 42,000 lb (the 80,000 lb limit line and the ZIPs ignored)", JSON.stringify(wText));
	const tDraw = extractPdfText(PDF_DRAWING);
	t(W.classifyPdfText(tDraw, PDF_DRAWING.length) === "no_text", "§6 a PDF that only draws has no text");
	const tBin = extractPdfText(PDF_BINARY);
	t(W.classifyPdfText(tBin, PDF_BINARY.length) === "no_text", "§6 a binary file has no text");
	t(W.classifyPdfText(tText, 3 * 1024 * 1024 + 1) === "too_large", "§6 the same PDF over 3 MB is too_large");
	for (const [cell, lb] of DETAILS) {
		const p = W.parseWeight(cell);
		t(lb == null ? p.status === "none" : (p.status === "ok" && p.weightLb === lb), `§6 Details ${JSON.stringify(cell)} -> ${lb == null ? "none" : `${lb} lb`}`, JSON.stringify(p));
	}

	// §7 the load's stated weight
	const sw = M.statedWeight;
	const a = sw("Weight: 42,000 lbs", { status: "ok", weightLb: 40000 });
	t(a && a.lb === 42000 && a.source === "details", "§7 the Details weight comes first", JSON.stringify(a));
	const b = sw("Commodity: produce", { status: "ok", weightLb: 40000 });
	t(b && b.lb === 40000 && b.source === "ratecon", "§7 the rate con's fills a Details gap", JSON.stringify(b));
	const cf = sw("Est. Weight 40,000 lbs; Actual Weight: 42,500 lbs", { status: "ok", weightLb: 41000 });
	t(cf && cf.lb === 41000 && cf.source === "ratecon", "§7 a Details conflict falls through to the rate con", JSON.stringify(cf));
	t(sw("Commodity: produce", { status: "no_text", weightLb: null }) === null && sw("", { status: "ok", weightLb: 120000 }) === null && sw("", null) === null,
		"§7 no Details weight and no usable rate-con weight is no weight");
	return r;
}

// ── run ──────────────────────────────────────────────────────────────────────
const started = Date.now();
const real = battery(REAL);
const bySection = new Map();
for (const x of real) {
	const s = (x.name.match(/^§\d+/) || ["§?"])[0];
	if (!bySection.has(s)) bySection.set(s, { ok: 0, n: 0 });
	bySection.get(s).n++;
	if (x.ok) bySection.get(s).ok++;
}
for (const [s, e] of bySection) console.log(`${s}: ${e.ok}/${e.n} checks`);
for (const x of real) { if (x.ok) pass++; else failures.push(x.name); }

console.log("\n§8 mutants");
const MUTANTS = [
	["unit made optional (a ZIP read as pounds)", "§2", { weight: [["const UNIT_RE = new RegExp(`${NUM}${UNIT}`, \"gi\");", "const UNIT_RE = new RegExp(`${NUM}${UNIT}?`, \"gi\");"]] }],
	["thousands separator dropped", "§1", { weight: [["const whole = Number(intPart.replace(/,/g, \"\"));", "const whole = parseFloat(intPart);"]] }],
	["one rate-con word is enough", "§5", { weight: [["const MIN_RATECON_WORDS = 4;", "const MIN_RATECON_WORDS = 1;"]] }],
	["a printable-share test reads real rate cons as binary", "§5", { weight: [["if (visible < MIN_PRINTABLE_CHARS) return \"no_text\";", "if (visible < MIN_PRINTABLE_CHARS || visible / s.length < 0.85) return \"no_text\";"]] }],
	["kg not converted", "§1", { weight: [["const LB_PER_KG = 2.20462;", "const LB_PER_KG = 1;"]] }],
	["plausibility bounds removed", "§2", { weight: [["return typeof lb === \"number\" && Number.isFinite(lb) && lb >= MIN_PLAUSIBLE_LB && lb <= MAX_PLAUSIBLE_LB;", "return typeof lb === \"number\" && Number.isFinite(lb) && lb > 0;"]] }],
	["the first number beats the labelled weight", "§1", { weight: [["const pool = labelled.length ? labelled : all;", "const pool = all.slice(0, 1);"]] }],
	["length cap removed", "§4", { weight: [["return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) : s;", "return s;"]] }],
	["Details/PDF priority swapped", "§7", { metrics: [["return fromDetails || fromRatecon;", "return fromRatecon || fromDetails;"]] }],
	["a conflict collapsed to the larger weight", "§3", { weight: [["if (hi > lo * CONFLICT_RATIO) return { ...CONFLICT };", "if (hi > lo * CONFLICT_RATIO) return { status: \"ok\", weightLb: hi, evidence: \"labelled\" };"]] }],
];
for (const [name, section, edits] of MUTANTS) {
	let weightSrc = SOURCES.weight;
	let metricsSrc = SOURCES.metrics;
	for (const [from, to] of edits.weight || []) weightSrc = swap(weightSrc, from, to);
	for (const [from, to] of edits.metrics || []) metricsSrc = swap(metricsSrc, from, to);
	let results;
	try {
		const w = compileLib("kpi-weight.js", weightSrc);
		results = battery({ weight: w, metrics: compileLib("kpi-metrics.js", metricsSrc, { "./kpi-weight": w }) });
	} catch (e) {
		results = [{ ok: false, name: `${section} the mutant threw: ${e && e.message}` }];
	}
	const caught = results.filter((x) => !x.ok && x.name.startsWith(section));
	if (caught.length) pass++; else failures.push(`MUTANT ${name}: not caught by ${section}`);
	console.log(`  ${caught.length ? "caught" : "MISSED"}  ${name}${caught.length ? ` (${caught[0].name})` : ""}`);
}

const ms = Date.now() - started;
if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed (${ms} ms)`);
	process.exit(1);
}
console.log(`\n✓ ${pass} assertions passed (${ms} ms)`);
