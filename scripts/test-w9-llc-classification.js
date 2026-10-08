#!/usr/bin/env node
/**
 * The investor W-9's line 3a box and Part I TIN follow what was chosen on /invest.
 *
 * LINE 3a. fillW9Form() used to check the LLC box and print "P" (partnership)
 * for every LLC, and the C corporation box for every corporation, whatever the
 * applicant chose. Per the W-9's line 3a instructions:
 *   - LLC taxed as a C corporation, an S corporation or a partnership → the LLC
 *     box and "C", "S" or "P"; a single-member LLC that is disregarded (the
 *     form's "Individual/LLC") → its owner's box, Individual/sole proprietor,
 *     and NOT the LLC box;
 *   - Corp → C corporation or S corporation, as classified;
 *   - Other → the classification's own box ("Other" is for a classification
 *     the form does not list, and the four /invest offers are all listed);
 *   - no entity type → Individual/sole proprietor for "Individual/LLC" only (the
 *     other three could each be an LLC or the named box);
 *   - Sole Prop → Individual/sole proprietor, whatever the classification.
 * A classification that is missing, not one of the four, or not one the entity
 * type can have picks nothing: the entity type's own box stands (Corp: C
 * corporation; LLC: the LLC box, letter blank; Other: Other; none: none).
 *
 * PART I. The TIN is printed in ONE group, never both. 123-45-6789 is an SSN
 * and 12-3456789 an EIN, whatever else was chosen; any other writing (nine bare
 * digits) goes by the filer: the SSN boxes when line 3a is Individual/sole
 * proprietor, or when there is no entity type and the classification is not
 * one only an entity has (C-Corp, S-Corp, Partnership); the EIN boxes
 * otherwise. It used to go by the entity type alone, so an LLC's SSN (even
 * one written 123-45-6789) was printed as an EIN.
 *
 * WHAT IS ASSERTED. The shipped fillW9Form() is lifted out of server.js and run
 * with pdf-lib on the real template (onboarding-templates/pdf/fw9.pdf). The one
 * thing stubbed is the form's flatten(), so the checkboxes and fields can be
 * read back from the saved PDF.
 *   §1 line 3a, every entity type × classification /invest offers, plus
 *      classifications and entity types it does not: which box is checked and
 *      the letter in the LLC field.
 *   §2 nothing else on the form moves with the classification: every other
 *      field's value is identical across classifications.
 *   §3 the entity types and classifications /invest offers are exactly the ones
 *      §1 covers, and both investor callers pass the stored / posted
 *      classification.
 *   §4 Part I: the group the TIN lands in, and that the other group is empty.
 *   §5 MUTANTS, one per guard.
 *
 * Test TINs only (123-45-6789, 12-3456789). Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-w9-llc-classification.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }

let pdfLib;
try {
	pdfLib = require("pdf-lib");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
const imageLimits = require(path.join(ROOT, "lib", "image-size"));

function liftFunction(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${head}`);
	return SRC.slice(a, end + 2);
}
const FILL_SRC = liftFunction("async function fillW9Form(");
const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

// The real pdf-lib, except that the form's flatten() leaves the fields in
// place so they can be read back.
const PdfLibDocument = {
	load: async (bytes) => {
		const doc = await pdfLib.PDFDocument.load(bytes);
		doc.getForm().flatten = () => {};
		return doc;
	},
};
function build(src = FILL_SRC) {
	return new Function("path", "fs", "__dirname", "DATA_DIR", "PdfLibDocument", "StandardFonts", "rgb", "imageLimits", "console",
		`"use strict";\n${src}\nreturn fillW9Form;`)(path, fs, ROOT, ROOT, PdfLibDocument, pdfLib.StandardFonts, pdfLib.rgb, imageLimits,
		{ ...console, warn: () => {} });
}

const P = "topmostSubform[0].Page1[0].";
const BOX = (i) => `${P}Boxes3a-b_ReadOrder[0].c1_1[${i}]`;
const LETTER = `${P}Boxes3a-b_ReadOrder[0].f1_03[0]`;
const SSN_FIELDS = ["f1_11", "f1_12", "f1_13"].map((f) => `${P}${f}[0]`);
const EIN_FIELDS = ["f1_14", "f1_15"].map((f) => `${P}${f}[0]`);
const BOX_NAMES = ["Individual/sole proprietor", "C corporation", "S corporation", "Partnership", "Trust/estate", "LLC", "Other"];
const APPLICANT = { legalName: "QA Test Holdings LLC", dba: "QA Test", address: "1 QA Test Way, Testville, TX 77001", einSsn: "12-3456789", effectiveDate: "September 30, 2026" };

// Fills the form and reads line 3a, Part I and every other field back. pdf-lib
// warns on every getForm() of the IRS template that it drops the XFA copy;
// that notice is silenced here, as it says nothing about the fields.
async function fill(fillW9Form, entityType, taxClassification, einSsn = APPLICANT.einSsn) {
	const warn = console.warn;
	console.warn = () => {};
	let bytes;
	let form;
	try {
		bytes = await fillW9Form({ ...APPLICANT, entityType, taxClassification, einSsn });
		if (!bytes) die("the W-9 template was not found");
		form = (await pdfLib.PDFDocument.load(bytes)).getForm();
	} finally { console.warn = warn; }
	const checked = BOX_NAMES.map((_, i) => form.getCheckBox(BOX(i)).isChecked());
	const text = (name) => form.getTextField(name).getText() || "";
	const others = {};
	for (const f of form.getFields()) {
		const name = f.getName();
		if (name === LETTER || name.includes("c1_1[")) continue;
		if (f instanceof pdfLib.PDFTextField) others[name] = f.getText() || "";
		else if (f instanceof pdfLib.PDFCheckBox) others[name] = f.isChecked();
	}
	return {
		boxes: BOX_NAMES.filter((_, i) => checked[i]), letter: text(LETTER),
		ssn: SSN_FIELDS.map(text), ein: EIN_FIELDS.map(text), others,
	};
}

const IND = ["Individual/sole proprietor"];
const LINE_3A = [
	// [entity type, tax classification, boxes checked, letter]
	// Every pair /invest offers (§3 pins the two lists).
	["", "", [], ""],
	["", "C-Corp", [], ""],
	["", "S-Corp", [], ""],
	["", "Partnership", [], ""],
	["", "Individual/LLC", IND, ""],
	["LLC", "", ["LLC"], ""],
	["LLC", "C-Corp", ["LLC"], "C"],
	["LLC", "S-Corp", ["LLC"], "S"],
	["LLC", "Partnership", ["LLC"], "P"],
	["LLC", "Individual/LLC", IND, ""],
	["Corp", "", ["C corporation"], ""],
	["Corp", "C-Corp", ["C corporation"], ""],
	["Corp", "S-Corp", ["S corporation"], ""],
	["Corp", "Partnership", ["C corporation"], ""],
	["Corp", "Individual/LLC", ["C corporation"], ""],
	["Sole Prop", "", IND, ""],
	["Sole Prop", "C-Corp", IND, ""],
	["Sole Prop", "S-Corp", IND, ""],
	["Sole Prop", "Partnership", IND, ""],
	["Sole Prop", "Individual/LLC", IND, ""],
	["Other", "", ["Other"], ""],
	["Other", "C-Corp", ["C corporation"], ""],
	["Other", "S-Corp", ["S corporation"], ""],
	["Other", "Partnership", ["Partnership"], ""],
	["Other", "Individual/LLC", IND, ""],
	// A classification /invest does not offer picks nothing.
	["LLC", undefined, ["LLC"], ""],
	["LLC", "Trust", ["LLC"], ""],
	["LLC", "c-corp", ["LLC"], ""],
	["LLC", "constructor", ["LLC"], ""],
	["LLC", 5, ["LLC"], ""],
	["Corp", "s-corp", ["C corporation"], ""],
	["Corp", "constructor", ["C corporation"], ""],
	["Other", "Trust", ["Other"], ""],
	["Other", "constructor", ["Other"], ""],
	["", "individual/llc", [], ""],
	["", "constructor", [], ""],
	// Entity types /invest does not offer (only a hand-written request sends
	// them): the entity type's own box, as before, and none for a name the map
	// does not know.
	["S-Corp", "C-Corp", ["S corporation"], ""],
	["Trust", "", ["Trust/estate"], ""],
	["Corporation", "S-Corp", [], ""],
];

// Stops at the first failing row when `stopEarly` (a mutant needs only one).
async function line3aSection(src = FILL_SRC, { stopEarly = false } = {}) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const fillW9Form = build(src);
	for (const [entity, tax, boxes, letter] of LINE_3A) {
		const got = await fill(fillW9Form, entity, tax);
		t(JSON.stringify(got.boxes) === JSON.stringify(boxes) && got.letter === letter,
			`§1 ${JSON.stringify(entity)} + ${JSON.stringify(tax)}: box ${boxes.join(", ") || "(none)"}, letter "${letter}" (got box ${got.boxes.join(", ") || "(none)"}, letter "${got.letter}")`);
		if (stopEarly && !r[r.length - 1].ok) break;
	}
	return r;
}

async function othersSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const fillW9Form = build();
	const base = await fill(fillW9Form, "LLC", "");
	t(base.others["topmostSubform[0].Page1[0].f1_01[0]"] === APPLICANT.legalName && base.others["topmostSubform[0].Page1[0].f1_14[0]"] === "12",
		"§2 the name and the EIN are on the form (the comparison below is not over an empty form)");
	for (const tax of ["C-Corp", "S-Corp", "Partnership", "Individual/LLC"]) {
		const got = await fill(fillW9Form, "LLC", tax);
		t(JSON.stringify(got.others) === JSON.stringify(base.others), `§2 LLC + ${tax}: every field outside line 3a is as with no classification`);
	}
	return r;
}

function sourceSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const view = fs.readFileSync(path.join(ROOT, "client", "src", "views", "InvestorApplyView.vue"), "utf8");
	const optionsOf = (model) => {
		const select = (view.match(new RegExp(`<select v-model="form\\.${model}"[^>]*>([\\s\\S]*?)<\\/select>`)) || [])[1] || "";
		return [...select.matchAll(/<option(?: value="([^"]*)")?>([^<]*)<\/option>/g)].map(([, v, text]) => (v !== undefined ? v : text)).filter(Boolean).sort();
	};
	const covered = (i) => [...new Set(LINE_3A.slice(0, 25).map((row) => row[i]).filter(Boolean))].sort();
	const classifications = optionsOf("tax_classification");
	t(JSON.stringify(classifications) === JSON.stringify(covered(1)) && classifications.length === 4,
		`§3 /invest offers exactly the four classifications §1 covers (got ${JSON.stringify(classifications)})`);
	const entities = optionsOf("entity_type");
	t(JSON.stringify(entities) === JSON.stringify(covered(0)) && entities.length === 4,
		`§3 /invest offers exactly the four entity types §1 covers (got ${JSON.stringify(entities)})`);
	const render = code(liftFunction("function buildInvestorDocRender("));
	t(/fillW9Form\(\{[\s\S]*?taxClassification: application\?\.tax_classification \|\| ""/.test(render),
		"§3 the signed W-9 (buildInvestorDocRender) passes the stored tax_classification");
	const previewAt = SRC.indexOf('app.post("/api/public/investor-preview-pdf/:docKey"');
	const preview = code(SRC.slice(previewAt, SRC.indexOf("\n});", previewAt)));
	t(/fillW9Form\(\{ \.\.\.appData, taxClassification: req\.body\.tax_classification \}\)/.test(preview),
		"§3 the /invest preview passes the posted tax_classification (the form sends it)");
	return r;
}

const SSN = ["123", "45", "6789"];
const EIN = ["12", "3456789"];
const TIN_TABLE = [
	// [entity type, tax classification, TIN as typed, group, digits in it]
	// Its own shape decides.
	["LLC", "Individual/LLC", "123-45-6789", "ssn", SSN],
	["LLC", "C-Corp", "123-45-6789", "ssn", SSN],
	["Corp", "S-Corp", "123-45-6789", "ssn", SSN],
	["Corp", "C-Corp", " 123-45-6789 ", "ssn", SSN],
	["Sole Prop", "", "12-3456789", "ein", EIN],
	["LLC", "Individual/LLC", "12-3456789", "ein", EIN],
	["", "", "12-3456789", "ein", EIN],
	// Any other writing: the filer decides.
	["LLC", "Individual/LLC", "123456789", "ssn", SSN],
	["LLC", "Individual/LLC", "123 45 6789", "ssn", SSN],
	["LLC", "C-Corp", "123456789", "ein", EIN],
	["LLC", "Partnership", "123456789", "ein", EIN],
	["LLC", "", "123456789", "ein", EIN],
	["Corp", "S-Corp", "123456789", "ein", EIN],
	["Corp", "", "123456789", "ein", EIN],
	["Corp", "", 123456789, "ein", EIN],
	["Sole Prop", "", "123456789", "ssn", SSN],
	["Sole Prop", "C-Corp", "123456789", "ssn", SSN],
	["Other", "", "123456789", "ein", EIN],
	["Other", "Partnership", "123456789", "ein", EIN],
	["Other", "Individual/LLC", "123456789", "ssn", SSN],
	["", "", "123456789", "ssn", SSN],
	["", "Individual/LLC", "123456789", "ssn", SSN],
	["", "Partnership", "123456789", "ein", EIN],
	["", "C-Corp", "1234-56789", "ein", EIN],
	// Not nine digits: still one group, the filer's.
	["Sole Prop", "", "12345678", "ssn", ["123", "45", "678"]],
	["Corp", "", "12345678", "ein", ["12", "345678"]],
];

async function tinSection(src = FILL_SRC, { stopEarly = false } = {}) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const fillW9Form = build(src);
	for (const [entity, tax, tin, group, digits] of TIN_TABLE) {
		const got = await fill(fillW9Form, entity, tax, tin);
		const want = group === "ssn" ? { ssn: digits, ein: ["", ""] } : { ssn: ["", "", ""], ein: digits };
		t(JSON.stringify(got.ssn) === JSON.stringify(want.ssn) && JSON.stringify(got.ein) === JSON.stringify(want.ein),
			`§4 ${JSON.stringify(entity)} + ${JSON.stringify(tax)}, TIN ${JSON.stringify(tin)}: the ${group.toUpperCase()} boxes only (got SSN ${JSON.stringify(got.ssn)}, EIN ${JSON.stringify(got.ein)})`);
		if (stopEarly && !r[r.length - 1].ok) break;
	}
	return r;
}

async function mutantSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const failed = (results) => results.some((x) => !x.ok);
	const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };
	const line3a = async (from, to) => failed(await line3aSection(swap(FILL_SRC, from, to), { stopEarly: true }));
	const tin = async (from, to) => failed(await tinSection(swap(FILL_SRC, from, to), { stopEarly: true }));
	t(await line3a('llcLetter = llcTaxLetters.get(taxClassification) || "";', 'llcLetter = "P";'),
		"MUTANT every LLC printed as \"P\" (the old form): caught by §1");
	t(await line3a('if (taxClassification === "Individual/LLC") cbIdx = INDIVIDUAL_BOX;\n\t\telse llcLetter', 'if (taxClassification === "Individual/LLC") cbIdx = entityCheckMap.LLC;\n\t\telse llcLetter'),
		"MUTANT a disregarded LLC left on the LLC box: caught by §1");
	t(await line3a('if (taxClassification === "S-Corp") cbIdx = entityCheckMap["S-Corp"];', 'if (false) cbIdx = entityCheckMap["S-Corp"];'),
		"MUTANT a corporation always on C corporation (the old form): caught by §1");
	t(await line3a("if (classificationBoxes.has(taxClassification)) cbIdx = classificationBoxes.get(taxClassification);", "if (false) cbIdx = classificationBoxes.get(taxClassification);"),
		"MUTANT an Other entity always on Other (the old form): caught by §1");
	t(await line3a('} else if (!entityType) {\n\t\tif (taxClassification === "Individual/LLC")', '} else if (!entityType) {\n\t\tif (false)'),
		"MUTANT no entity type with \"Individual/LLC\" left without a box (the old form): caught by §1");
	t(await tin("if (/^\\d{3}-\\d{2}-\\d{4}$/.test(tin)) tinIsSsn = true;", "if (false) tinIsSsn = true;"),
		"MUTANT a 123-45-6789 TIN not read as an SSN: caught by §4");
	t(await tin("else if (/^\\d{2}-\\d{7}$/.test(tin)) tinIsSsn = false;", "else if (false) tinIsSsn = false;"),
		"MUTANT a 12-3456789 TIN not read as an EIN: caught by §4");
	t(await tin("else tinIsSsn = cbIdx === INDIVIDUAL_BOX || (!entityType && !llcTaxLetters.has(taxClassification));",
		'else tinIsSsn = !entityType || entityType === "Sole Prop";'),
	"MUTANT the group chosen by the entity type alone (the old form): caught by §4");
	t(await tin("(!entityType && !llcTaxLetters.has(taxClassification))", "!entityType"),
		"MUTANT no entity type always on the SSN boxes, even for a partnership: caught by §4");
	t(await tin("\t} else if (digits.length >= 2) {\n\t\t\t// EIN fields", "\t}\n\t\tif (digits.length >= 2) {\n\t\t\t// EIN fields"),
		"MUTANT an SSN also printed in the EIN boxes: caught by §4");
	return r;
}

function record(results) {
	for (const x of results) ok(x.ok, x.name);
	console.log(`  ${results.filter((x) => x.ok).length}/${results.length} checks`);
}

(async () => {
	section("§1 line 3a, read back from the filled template");
	record(await line3aSection());
	section("§2 nothing else moves");
	record(await othersSection());
	section("§3 the /invest options and the callers");
	record(sourceSection());
	section("§4 Part I: one group, the right one");
	record(await tinSection());
	section("§5 mutants");
	record(await mutantSection());
	if (failures.length) {
		console.error(`\nFAILURES (${failures.length}):`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n✓ ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
