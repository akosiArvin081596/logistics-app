#!/usr/bin/env node
/**
 * Per-investor payment terms: the input rules, the stored snapshot and the two
 * contract templates (lib/investor-payment-terms.js, lib/policy-renderer.js,
 * onboarding-templates/policy/master-agreement.html and vehicle-lease.html).
 *
 * WHAT IS ASSERTED
 *   §1 the standard render is the template's original bytes: sha256 of
 *      applyPaymentTermsToHtml(file, doc, null) is origin/main's hash of each
 *      template (pinned below; recomputed with `git show origin/main:<file> |
 *      shasum -a 256` when the slots were added)
 *   §2 prepareTemplateHtml() / buildRenderFields() with no terms are exactly
 *      what renderPolicy() did before (file bytes + logo; the field map's own
 *      output), for every registered document
 *   §3 the lease and split variants print the approved wording, the amendment
 *      block sits where it must, and no marker or <template text is left; the
 *      terms labels join requiredText
 *   §4 the template refusals: unbalanced, duplicate, a missing required
 *      variant or slot, a stray marker, a marker in a non-investor template
 *   §5 normalizeTermsInput() over a case table (bidi, zero-width, U+2028, NUL,
 *      emoji and the copyright / registered / trade mark signs, all built with
 *      String.fromCodePoint), and normalizing twice changes nothing. The three
 *      signs are allowed; a sign with U+FE0F after it, emoji and every other
 *      pictograph are refused
 *   §6 formatMoneyCents(), snapshotJson() / parseSnapshot()
 *   §7 a 100,000-character adversarial input finishes in under 50 ms
 *
 * Pure: no server, no browser (renderPolicy is never called), no network.
 *
 * Run: node scripts/test-payment-terms-template.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { performance } = require("perf_hooks");

const ROOT = path.join(__dirname, "..");
const TPL_DIR = path.join(ROOT, "onboarding-templates", "policy");
const pt = require(path.join(ROOT, "lib", "investor-payment-terms.js"));
const { prepareTemplateHtml, buildRenderFields } = require(path.join(ROOT, "lib", "policy-renderer.js"));
const POLICY_FIELD_MAPS = require(path.join(ROOT, "lib", "policy-field-maps.js"));

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
const eq = (actual, expected, msg) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	ok(a === e, `${msg}\n      expected ${e}\n      actual   ${a}`);
};
const cp = (...codes) => String.fromCodePoint(...codes);
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
function throwsCode(fn, code) {
	try { fn(); } catch (e) { return e && e.code === code; }
	return false;
}

const FILES = { master_agreement: "master-agreement.html", vehicle_lease: "vehicle-lease.html" };
const ORIGIN_MAIN_SHA256 = {
	master_agreement: "28f70f6d0993f9de45e12b09d1caba3b9cbeaa378b945b0ffb0f4ba4fff71882",
	vehicle_lease: "e0f9fe28ebe0df0679f2b6f44bc4307e74631bd570ae9a4e44a793fae1e5f9d2",
};
const raw = (doc) => fs.readFileSync(path.join(TPL_DIR, FILES[doc]), "utf8");
const LEASE = { type: "lease", leaseAmountCents: 200000, details: "" };
const LEASE_DETAILS = { type: "lease", leaseAmountCents: 200000, details: "Paid on the 5th.\nFirst month prorated." };
const SPLIT_DETAILS = { type: "split", leaseAmountCents: null, details: "Reviewed after 12 months." };
const STANDARD_SPLIT = { type: "split", leaseAmountCents: null, details: "" };

// ── §1 the standard render is the original bytes ────────────────────────────
console.log("§1 standard render = origin/main bytes");
for (const doc of Object.keys(FILES)) {
	const html = raw(doc);
	ok(html.includes("payment-terms:slot"), `§1 ${doc}: the template carries its payment-terms slots`);
	ok(sha(pt.applyPaymentTermsToHtml(html, doc, null)) === ORIGIN_MAIN_SHA256[doc],
		`§1 ${doc}: the standard render must hash to origin/main's ${ORIGIN_MAIN_SHA256[doc].slice(0, 12)}…`);
	ok(pt.applyPaymentTermsToHtml(html, doc, STANDARD_SPLIT) === pt.applyPaymentTermsToHtml(html, doc, null),
		`§1 ${doc}: a split with no additional terms IS the standard contract`);
}

// ── §2 the renderer helpers are unchanged for no terms ──────────────────────
console.log("§2 renderer helpers");
const LOGO_PATH = path.join(ROOT, "logo.png");
const LOGO = fs.existsSync(LOGO_PATH) ? `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString("base64")}` : "";
const ALL_DOCS = {
	contractor_agreement: "contractor-agreement.html", equipment_policy: "equipment-policy.html",
	mobile_policy: "mobile-policy.html", substance_policy: "substance-policy.html",
	service_invoice: "service-invoice.html", service_invoice_owner_op: "service-invoice-owner-op.html",
	service_invoice_manual: "service-invoice-manual.html", ...FILES,
};
const SAMPLE = {
	legalName: "Sample Investor LLC", contactPerson: "Pat Sample", email: "pat@example.com", address: "1 Main St",
	einSsn: "00-0000000", signatureText: "Pat Sample", signedAt: "September 30, 2026", effectiveDate: "September 30, 2026",
	vehicles: [{ year: "2022", make: "Volvo", model: "VNL", vin: "4V4NC9EH0NN000000" }],
	driverName: "Sample Driver", weekEnding: "2026-09-25", loads: [], lineItems: [], deductions: [], days: {},
};
for (const [doc, file] of Object.entries(ALL_DOCS)) {
	const before = fs.readFileSync(path.join(TPL_DIR, file), "utf8").replace(/\{\{LOGO_SRC\}\}/g, LOGO);
	const expectHtml = doc in FILES ? pt.applyPaymentTermsToHtml(fs.readFileSync(path.join(TPL_DIR, file), "utf8"), doc, null).replace(/\{\{LOGO_SRC\}\}/g, LOGO) : before;
	ok(prepareTemplateHtml(doc, {}) === expectHtml, `§2 ${doc}: prepareTemplateHtml() with no terms is the file plus the logo`);
	ok(prepareTemplateHtml(doc, { paymentTerms: null }) === expectHtml, `§2 ${doc}: …and with paymentTerms: null`);
	eq(buildRenderFields(doc, SAMPLE), POLICY_FIELD_MAPS[doc](SAMPLE), `§2 ${doc}: buildRenderFields() with no terms is the field map's own output`);
}
for (const doc of Object.keys(FILES)) {
	const prepared = prepareTemplateHtml(doc, {});
	ok(prepared.length > 1000 && sha(LOGO ? prepared.split(LOGO).join("{{LOGO_SRC}}") : prepared) === ORIGIN_MAIN_SHA256[doc],
		`§2 ${doc}: the prepared standard HTML is origin/main's template with the logo filled`);
	eq(buildRenderFields(doc, { ...SAMPLE, paymentTerms: STANDARD_SPLIT }), POLICY_FIELD_MAPS[doc](SAMPLE),
		`§2 ${doc}: a standard split asks for no terms fields`);
}

// ── §3 the approved wording ─────────────────────────────────────────────────
console.log("§3 lease and split variants");
const AMOUNT = '<strong aria-label="Payment terms monthly amount"></strong>';
const MASTER_33_LEASE = `  <p><span class="section-title">3.3 Payment Terms and Method of Payment.</span> In place of the 50/50 split, the Participant shall receive a fixed monthly lease payment of ${AMOUNT}, as set out in Amendment No. 1.</p>`;
const MASTER_33_STANDARD = '<p><span class="section-title">3.3 Revenue Participation and Method of Payment.</span> Upon the final determination of the monthly NOI, the remaining funds shall be distributed according to a <strong>50/50 split</strong>:</p>';
const MASTER_EXEC_LI = '    <li><strong>Payment Execution (Schedule A):</strong> All disbursements shall be issued to the Participant via the electronic payment method and banking instructions designated in the attached <strong>Schedule A (Payment &amp; Banking Election Form)</strong>. The Participant is responsible for maintaining the accuracy of the information in <strong>Schedule A</strong> to avoid processing delays.</li>';
const LEASE_201_LEAD = '  <p><span class="section-title">2.01 Lease Payments and Remittance Structure.</span> The Lessee agrees to pay the Lessor "Rent" as a derivative of the <strong>Net Operating Income (NOI)</strong> generated by the Vehicle, as defined and governed by the <strong>Master Participation &amp; Management Agreement</strong>.</p>';
const LEASE_FIXED_LI = `    <li><strong>Fixed Monthly Lease Payment:</strong> ${AMOUNT} per month, as set out in Amendment No. 1, in place of the 50/50 profit participation model.</li>`;
const LEASE_VARIABLE_LI = "<li><strong>Variable-Yield Settlement:</strong>";
const LEASE_CYCLE_LI = '    <li><strong>Settlement Cycle (Net-60):</strong> In alignment with industry receivable aging, all lease payments shall be settled and remitted on the <strong>last Friday of the calendar month following the month of production</strong>.</li>';
const LEASE_METHOD_LI = '    <li><strong>Method of Payment:</strong> Remittance shall be executed via <strong>ACH Direct Deposit</strong> using the banking coordinates provided by the Lessor in <strong>Schedule A</strong> (Payment &amp; Banking Election Form).</li>';
const AMENDMENT_TITLE = "AMENDMENT NO. 1 &mdash; PAYMENT TERMS";
const AMENDMENT_SENTENCE = "These payment terms were agreed for this Participant and control over any conflicting provision of this Agreement.";
const TYPE_SLOT = '<strong>Payment type:</strong> <span aria-label="Payment terms type"></span>';
const AMOUNT_SLOT = '<strong>Monthly amount:</strong> <span aria-label="Payment terms monthly amount"></span>';
const DETAILS_SLOT = '<strong>Additional terms:</strong></p>\n    <div aria-label="Payment terms details" style="white-space:pre-wrap;overflow-wrap:anywhere"></div>';
const BEFORE_SIGNATURE = { master_agreement: "  <!-- Signature Box -->", vehicle_lease: "  <!-- SIGNATURE EXECUTION -->" };

function clean(label, html) {
	ok(!html.includes("payment-terms"), `§3 ${label}: no payment-terms marker is left`);
	ok(!/<template/i.test(html) && !/<\/template/i.test(html), `§3 ${label}: no <template text is left`);
}
function amendmentBefore(html, doc) {
	const at = html.indexOf(AMENDMENT_TITLE);
	const sig = html.indexOf(BEFORE_SIGNATURE[doc]);
	const block = at >= 0 && sig > at ? html.slice(at, sig) : "";
	// Nothing but the block's own closing tag and one blank line before the signatures.
	return { block, placed: !!block && block.endsWith("  </div>\n\n") };
}

{
	const html = pt.applyPaymentTermsToHtml(raw("master_agreement"), "master_agreement", LEASE);
	clean("master, lease", html);
	ok(html.includes(`${MASTER_33_LEASE}\n  <ul>\n${MASTER_EXEC_LI}\n  </ul>\n`), "§3 master, lease: §3.3 reads the approved lease wording, then the Payment Execution bullet verbatim");
	ok(!html.includes(MASTER_33_STANDARD) && !html.includes("Participant Distribution (50%)"), "§3 master, lease: the 50/50 §3.3 and its 50% bullets are gone");
	const { block, placed } = amendmentBefore(html, "master_agreement");
	ok(placed, "§3 master, lease: the amendment block sits immediately before the signature box");
	ok(block.includes(AMENDMENT_SENTENCE) && block.includes(TYPE_SLOT) && block.includes(AMOUNT_SLOT) && block.includes(DETAILS_SLOT),
		"§3 master, lease: the amendment has its sentence, type, monthly amount and details slots");
	ok(!/type="checkbox"/.test(block), "§3 master, lease: the amendment has no checkboxes");
}
{
	const html = pt.applyPaymentTermsToHtml(raw("master_agreement"), "master_agreement", SPLIT_DETAILS);
	clean("master, split", html);
	ok(html.includes(MASTER_33_STANDARD) && !html.includes(MASTER_33_LEASE), "§3 master, split: §3.3 keeps the standard 50/50 wording");
	const { block, placed } = amendmentBefore(html, "master_agreement");
	ok(placed && block.includes(AMENDMENT_SENTENCE) && block.includes(TYPE_SLOT) && block.includes(DETAILS_SLOT) && !block.includes("Monthly amount"),
		"§3 master, split: the amendment has type and details but no monthly amount");
}
{
	const html = pt.applyPaymentTermsToHtml(raw("vehicle_lease"), "vehicle_lease", LEASE);
	clean("lease, lease", html);
	ok(html.includes(`${LEASE_201_LEAD}\n  <ul>\n${LEASE_FIXED_LI}\n${LEASE_CYCLE_LI}\n${LEASE_METHOD_LI}\n  </ul>\n`),
		"§3 lease, lease: §2.01 keeps its lead, cycle and method verbatim with the Fixed Monthly Lease Payment bullet in place of Variable-Yield");
	ok(!html.includes(LEASE_VARIABLE_LI), "§3 lease, lease: the Variable-Yield bullet is gone");
	const { block, placed } = amendmentBefore(html, "vehicle_lease");
	ok(placed && block.includes(AMENDMENT_SENTENCE) && block.includes(TYPE_SLOT) && block.includes(AMOUNT_SLOT) && block.includes(DETAILS_SLOT),
		"§3 lease, lease: the amendment sits immediately before SIGNATURE EXECUTION with every slot");
}
{
	const html = pt.applyPaymentTermsToHtml(raw("vehicle_lease"), "vehicle_lease", SPLIT_DETAILS);
	clean("lease, split", html);
	ok(html.includes(LEASE_VARIABLE_LI) && !html.includes("Fixed Monthly Lease Payment"), "§3 lease, split: §2.01 keeps the Variable-Yield bullet");
	const { block, placed } = amendmentBefore(html, "vehicle_lease");
	ok(placed && !block.includes("Monthly amount") && block.includes(DETAILS_SLOT), "§3 lease, split: the amendment has no monthly amount");
}
for (const doc of Object.keys(FILES)) {
	const html = prepareTemplateHtml(doc, { paymentTerms: LEASE });
	ok(html.includes(AMENDMENT_TITLE) && !html.includes("{{LOGO_SRC}}"), `§3 ${doc}: prepareTemplateHtml() applies the terms and the logo`);
	const fields = buildRenderFields(doc, { ...SAMPLE, paymentTerms: LEASE_DETAILS });
	eq({
		type: fields.text["Payment terms type"], amount: fields.text["Payment terms monthly amount"], details: fields.text["Payment terms details"],
	}, { type: "Fixed monthly lease payment", amount: "$2,000.00", details: "Paid on the 5th.\nFirst month prorated." },
	`§3 ${doc}: a lease fills type, amount and details`);
	ok(["Payment terms type", "Payment terms monthly amount", "Payment terms details"].every((l) => fields.requiredText.includes(l)),
		`§3 ${doc}: the terms labels are required text`);
	const split = buildRenderFields(doc, { ...SAMPLE, paymentTerms: SPLIT_DETAILS });
	eq([split.text["Payment terms type"], split.text["Payment terms details"], "Payment terms monthly amount" in split.text],
		["50/50 profit split", "Reviewed after 12 months.", false], `§3 ${doc}: a split fills type and details, no amount`);
	eq(buildRenderFields(doc, { ...SAMPLE, paymentTerms: LEASE }).text["Payment terms details"], "None", `§3 ${doc}: empty details print "None"`);
	// Every label the variant asks for exists in the rendered HTML.
	for (const label of Object.keys(pt.renderFieldsFor(doc, LEASE))) {
		ok(prepareTemplateHtml(doc, { paymentTerms: LEASE }).includes(`aria-label="${label}"`), `§3 ${doc}: "${label}" is in the lease render`);
	}
}

// ── §4 refusals ─────────────────────────────────────────────────────────────
console.log("§4 template refusals");
const CODE = "PAYMENT_TERMS_TEMPLATE_INVALID";
const M = raw("master_agreement");
const without = (html, text) => {
	if (!html.includes(text)) throw new Error(`fixture text not found: ${text}`);
	return html.replace(text, "");
};
const LEASE_VARIANT_33 = M.slice(M.indexOf('<template data-payment-terms="lease">\n  <p><span class="section-title">3.3'), M.indexOf("<!-- /payment-terms:slot -->") );
const REFUSALS = [
	["a slot never closed", (h) => h.replace("<!-- /payment-terms:slot -->\n  <!-- Signature Box -->", "  <!-- Signature Box -->")],
	["a slot closed that never opened", (h) => h.replace("  <!-- Signature Box -->", "<!-- /payment-terms:slot -->\n  <!-- Signature Box -->")],
	["a variant not closed", (h) => h.replace("</template>\n<!-- /payment-terms:slot -->", "<!-- /payment-terms:slot -->")],
	["a slot opened inside a slot", (h) => h.replace("<!-- payment-terms:slot master.3.3 -->\n", "<!-- payment-terms:slot master.3.3 -->\n<!-- payment-terms:slot master.amendment -->\n")],
	["a duplicate slot", (h) => `${h}\n<!-- payment-terms:slot master.3.3 -->\n<template data-payment-terms="lease">\n</template>\n<!-- /payment-terms:slot -->`],
	["a duplicate variant", (h) => h.replace("</template>\n<!-- /payment-terms:slot -->", '</template>\n<template data-payment-terms="lease">\n</template>\n<!-- /payment-terms:slot -->')],
	["a missing required variant", (h) => without(h, LEASE_VARIANT_33)],
	["a missing slot", (h) => h.slice(0, h.indexOf("<!-- payment-terms:slot master.amendment -->")) + h.slice(h.indexOf("<!-- /payment-terms:slot -->", h.indexOf("<!-- payment-terms:slot master.amendment -->")) + "<!-- /payment-terms:slot -->\n".length)],
	["an unknown slot", (h) => h.replace("<!-- payment-terms:slot master.3.3 -->", "<!-- payment-terms:slot master.9.9 -->")],
	["an unknown variant", (h) => h.replace('<template data-payment-terms="split">', '<template data-payment-terms="bonus">')],
	["a stray inline marker", (h) => h.replace("  <!-- Signature Box -->", "  <p><!-- payment-terms:slot master.3.3 --></p>\n  <!-- Signature Box -->")],
	["a variant outside any slot", (h) => h.replace("  <!-- Signature Box -->", '<template data-payment-terms="lease">\n</template>\n  <!-- Signature Box -->')],
	["a stray template tag inside a slot", (h) => h.replace("<!-- payment-terms:slot master.3.3 -->\n", "<!-- payment-terms:slot master.3.3 -->\n<template>\n")],
	["a CRLF marker line", (h) => h.replace("<!-- payment-terms:slot master.3.3 -->\n", "<!-- payment-terms:slot master.3.3 -->\r\n")],
];
for (const [label, mutate] of REFUSALS) {
	const bad = mutate(M);
	ok(bad !== M, `§4 fixture "${label}" differs from the template`);
	ok(throwsCode(() => pt.applyPaymentTermsToHtml(bad, "master_agreement", null), CODE), `§4 ${label}: refused for the standard render`);
	ok(throwsCode(() => pt.applyPaymentTermsToHtml(bad, "master_agreement", LEASE), CODE), `§4 ${label}: refused for a lease render`);
}
ok(throwsCode(() => pt.applyPaymentTermsToHtml(raw("master_agreement"), "vehicle_lease", null), CODE), "§4 the master's slots in the lease are refused");
const CONTRACTOR = fs.readFileSync(path.join(TPL_DIR, "contractor-agreement.html"), "utf8");
ok(pt.applyPaymentTermsToHtml(CONTRACTOR, "contractor_agreement", null) === CONTRACTOR, "§4 a non-investor template renders unchanged");
ok(throwsCode(() => pt.applyPaymentTermsToHtml(`${CONTRACTOR}\n<!-- payment-terms:slot master.3.3 -->\n<!-- /payment-terms:slot -->`, "contractor_agreement", null), CODE),
	"§4 a marker in a non-investor template is refused");
ok(throwsCode(() => pt.applyPaymentTermsToHtml(CONTRACTOR, "contractor_agreement", LEASE), CODE), "§4 terms asked of a non-investor document are refused");
ok(throwsCode(() => pt.renderFieldsFor("w9", LEASE), CODE), "§4 renderFieldsFor() refuses the W-9");
ok(throwsCode(() => pt.applyPaymentTermsToHtml(M, "master_agreement", { type: "lease", leaseAmountCents: 5, details: "" }), "PAYMENT_TERMS_INVALID"),
	"§4 out-of-range terms never reach a template");
ok(throwsCode(() => prepareTemplateHtml("master_agreement", { paymentTerms: { type: "bonus" } }), "PAYMENT_TERMS_INVALID"),
	"§4 prepareTemplateHtml() refuses unknown terms");

// ── §5 the input case table ─────────────────────────────────────────────────
console.log("§5 normalizeTermsInput");
const RLO = cp(0x202e);
const ZWSP = cp(0x200b);
const LSEP = cp(0x2028);
const PSEP = cp(0x2029);
const NUL = cp(0x0000);
const BOM = cp(0xfeff);
const EMOJI = cp(0x1f600);
const COPYRIGHT = cp(0x00a9);
const REGISTERED = cp(0x00ae);
const TRADE_MARK = cp(0x2122);
const EMOJI_PRESENTATION = cp(0xfe0f);
const INFORMATION_SOURCE = cp(0x2139);
const DOUBLE_EXCLAMATION = cp(0x203c);
const CYRILLIC_A = cp(0x0430);
const E_ACUTE_NFD = `e${cp(0x0301)}`;
const E_ACUTE_NFC = cp(0x00e9);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const PRIVATE_USE = cp(0xe000);
const CASES = [
	// [label, input, expected]
	["lease, plain dollars", { paymentType: "lease", leaseAmount: "2000" }, { ok: true, value: { type: "lease", leaseAmountCents: 200000, details: "" } }],
	["lease, $ and cents, padded", { paymentType: "lease", leaseAmount: " $2000.5 " }, { ok: true, value: { type: "lease", leaseAmountCents: 200050, details: "" } }],
	["lease, a number", { paymentType: "lease", leaseAmount: 1234.56 }, { ok: true, value: { type: "lease", leaseAmountCents: 123456, details: "" } }],
	["lease, the floor", { paymentType: "lease", leaseAmount: "1" }, { ok: true, value: { type: "lease", leaseAmountCents: 100, details: "" } }],
	["lease, the ceiling", { paymentType: "lease", leaseAmount: "100000.00" }, { ok: true, value: { type: "lease", leaseAmountCents: 10000000, details: "" } }],
	["lease, below the floor", { paymentType: "lease", leaseAmount: "0.99" }, { ok: false, field: "leaseAmount", reason: "amount_out_of_range", message: pt.MESSAGES.amount_out_of_range }],
	["lease, above the ceiling", { paymentType: "lease", leaseAmount: "100000.01" }, { ok: false, field: "leaseAmount", reason: "amount_out_of_range", message: pt.MESSAGES.amount_out_of_range }],
	["lease, 2,000", { paymentType: "lease", leaseAmount: "2,000" }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, 0x10", { paymentType: "lease", leaseAmount: "0x10" }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, 1e3", { paymentType: "lease", leaseAmount: "1e3" }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, -5", { paymentType: "lease", leaseAmount: "-5" }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, a negative number", { paymentType: "lease", leaseAmount: -5 }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, Infinity text", { paymentType: "lease", leaseAmount: "Infinity" }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, Infinity", { paymentType: "lease", leaseAmount: Infinity }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, NaN", { paymentType: "lease", leaseAmount: NaN }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, three decimals", { paymentType: "lease", leaseAmount: "2000.123" }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, two dollar signs", { paymentType: "lease", leaseAmount: "$$5" }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, $ then a space", { paymentType: "lease", leaseAmount: "$ 2000" }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, 17 characters", { paymentType: "lease", leaseAmount: "0000000000002000." }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, an array", { paymentType: "lease", leaseAmount: ["2000"] }, { ok: false, field: "leaseAmount", reason: "invalid_amount", message: pt.MESSAGES.invalid_amount }],
	["lease, missing", { paymentType: "lease" }, { ok: false, field: "leaseAmount", reason: "amount_required", message: pt.MESSAGES.amount_required }],
	["lease, blank", { paymentType: "lease", leaseAmount: "   " }, { ok: false, field: "leaseAmount", reason: "amount_required", message: pt.MESSAGES.amount_required }],
	["split, no amount", { paymentType: "split", leaseAmount: "" }, { ok: true, value: { type: "split", leaseAmountCents: null, details: "" } }],
	["split with an amount", { paymentType: "split", leaseAmount: "5" }, { ok: false, field: "leaseAmount", reason: "amount_not_allowed", message: pt.MESSAGES.amount_not_allowed }],
	["type in capitals", { paymentType: "Split" }, { ok: false, field: "paymentType", reason: "invalid_type", message: pt.MESSAGES.invalid_type }],
	["type missing", {}, { ok: false, field: "paymentType", reason: "invalid_type", message: pt.MESSAGES.invalid_type }],
	["details: bidi override, zero-width, BOM and NUL dropped", { paymentType: "split", details: `${RLO}Net ${ZWSP}30${BOM}${NUL} days` },
		{ ok: true, value: { type: "split", leaseAmountCents: null, details: "Net 30 days" } }],
	["details: U+2028 / U+2029 are line breaks", { paymentType: "split", details: `Line one${LSEP}Line two${PSEP}Line three` },
		{ ok: true, value: { type: "split", leaseAmountCents: null, details: "Line one\nLine two\nLine three" } }],
	["details: CRLF, CR, tabs, line ends, blank runs, outer space", { paymentType: "split", details: "  \r\n A\tB   \r\rC\r\n\r\n\r\n\n  D  \n\n" },
		{ ok: true, value: { type: "split", leaseAmountCents: null, details: "A B\n\nC\n\n  D" } }],
	["details: NFC", { paymentType: "split", details: `Caf${E_ACUTE_NFD}` }, { ok: true, value: { type: "split", leaseAmountCents: null, details: `Caf${E_ACUTE_NFC}` } }],
	["details: a lone surrogate and private use dropped", { paymentType: "split", details: `A${LONE_SURROGATE}B${PRIVATE_USE}C` },
		{ ok: true, value: { type: "split", leaseAmountCents: null, details: "ABC" } }],
	["details: only invisible characters is empty", { paymentType: "split", details: `${ZWSP}${RLO}\n\n` }, { ok: true, value: { type: "split", leaseAmountCents: null, details: "" } }],
	["details: emoji", { paymentType: "split", details: `Great ${EMOJI}` }, { ok: false, field: "details", reason: "unsupported_characters", message: pt.MESSAGES.unsupported_characters }],
	["details: the copyright, registered and trade mark signs", { paymentType: "split", details: `Acme${TRADE_MARK} ${COPYRIGHT}2026 ${REGISTERED}` },
		{ ok: true, value: { type: "split", leaseAmountCents: null, details: `Acme${TRADE_MARK} ${COPYRIGHT}2026 ${REGISTERED}` } }],
	["details: all three signs together, then an emoji", { paymentType: "split", details: `${COPYRIGHT}${REGISTERED}${TRADE_MARK} ${EMOJI}` },
		{ ok: false, field: "details", reason: "unsupported_characters", message: pt.MESSAGES.unsupported_characters }],
	["details: the copyright sign as an emoji (U+FE0F after it)", { paymentType: "split", details: `${COPYRIGHT}${EMOJI_PRESENTATION} 2026` },
		{ ok: false, field: "details", reason: "unsupported_characters", message: pt.MESSAGES.unsupported_characters }],
	["details: the trade mark sign as an emoji (U+FE0F after it)", { paymentType: "split", details: `Acme${TRADE_MARK}${EMOJI_PRESENTATION}` },
		{ ok: false, field: "details", reason: "unsupported_characters", message: pt.MESSAGES.unsupported_characters }],
	["details: another letterlike pictograph (information source)", { paymentType: "split", details: `See ${INFORMATION_SOURCE}` },
		{ ok: false, field: "details", reason: "unsupported_characters", message: pt.MESSAGES.unsupported_characters }],
	["details: another punctuation pictograph (double exclamation)", { paymentType: "split", details: `Note${DOUBLE_EXCLAMATION}` },
		{ ok: false, field: "details", reason: "unsupported_characters", message: pt.MESSAGES.unsupported_characters }],
	["details: another script", { paymentType: "split", details: `P${CYRILLIC_A}yment` }, { ok: false, field: "details", reason: "unsupported_characters", message: pt.MESSAGES.unsupported_characters }],
	["details: not text", { paymentType: "split", details: 42 }, { ok: false, field: "details", reason: "details_not_text", message: pt.MESSAGES.details_not_text }],
	["details: 2001 characters", { paymentType: "split", details: "x".repeat(2001) }, { ok: false, field: "details", reason: "details_too_long", message: pt.MESSAGES.details_too_long }],
	["details: 2000 characters", { paymentType: "split", details: "x".repeat(2000) }, { ok: true, value: { type: "split", leaseAmountCents: null, details: "x".repeat(2000) } }],
	["details: 8001 raw characters", { paymentType: "split", details: " ".repeat(8001) }, { ok: false, field: "details", reason: "details_too_long", message: pt.MESSAGES.details_too_long }],
	["details: 31 lines", { paymentType: "split", details: Array.from({ length: 31 }, (_, i) => `line ${i}`).join("\n") },
		{ ok: false, field: "details", reason: "details_too_many_lines", message: pt.MESSAGES.details_too_many_lines }],
	["details: 30 lines", { paymentType: "lease", leaseAmount: "1500", details: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") },
		{ ok: true, value: { type: "lease", leaseAmountCents: 150000, details: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") } }],
	["details: symbols and accents are fine", { paymentType: "split", details: "5% of $1,000 — per § 3.3 (naïve)" },
		{ ok: true, value: { type: "split", leaseAmountCents: null, details: "5% of $1,000 — per § 3.3 (naïve)" } }],
];
for (const [label, input, expected] of CASES) {
	const got = pt.normalizeTermsInput(input);
	eq(got, expected, `§5 ${label}`);
	if (got.ok) eq(pt.normalizeTermsInput({ paymentType: got.value.type, leaseAmount: got.value.leaseAmountCents === null ? "" : String(got.value.leaseAmountCents / 100), details: got.value.details }).value,
		got.value, `§5 ${label}: normalizing the stored value again changes nothing`);
}
ok(Object.values(pt.MESSAGES).every((m) => typeof m === "string" && m.length > 10), "§5 every refusal has a message");
eq(pt.normalizeName(`  Ada ${ZWSP}\n  Lovelace${RLO} `), { ok: true, value: "Ada Lovelace" }, "§5 normalizeName() collapses space and drops invisible characters");
eq(pt.normalizeName("x".repeat(121)), { ok: false, reason: "too_long" }, "§5 normalizeName() caps at 120");
eq(pt.normalizeName(7), { ok: false, reason: "not_text" }, "§5 normalizeName() refuses a non-string");
ok(pt.INVITE_TOKEN_RE.test(pt.newInviteToken()) && pt.newInviteToken() !== pt.newInviteToken(), "§5 newInviteToken() is 43 base64url characters, fresh each time");
ok(/^[0-9a-f]{64}$/.test(pt.hashInviteToken("a".repeat(43))), "§5 hashInviteToken() is a sha256 hex digest");

// ── §6 money, describe, snapshots ───────────────────────────────────────────
console.log("§6 formatMoneyCents / describeTerms / snapshots");
for (const [cents, want] of [[0, "$0.00"], [5, "$0.05"], [100, "$1.00"], [99999, "$999.99"], [100000, "$1,000.00"], [200000, "$2,000.00"],
	[123456789, "$1,234,567.89"], [10000000, "$100,000.00"], [99999999999, "$999,999,999.99"], [-1, ""], [1.5, ""], ["100", ""], [null, ""]]) {
	eq(pt.formatMoneyCents(cents), want, `§6 formatMoneyCents(${JSON.stringify(cents)})`);
}
eq(pt.describeTerms(null), { typeLabel: "50/50 profit split", amountLabel: "", summary: "50/50 profit split — standard contract terms" }, "§6 describeTerms(null)");
eq(pt.describeTerms(STANDARD_SPLIT), pt.describeTerms(null), "§6 a standard split describes as the standard contract");
eq(pt.describeTerms(LEASE), { typeLabel: "Fixed monthly lease payment", amountLabel: "$2,000.00 per month", summary: "Fixed monthly lease payment — $2,000.00 per month" }, "§6 describeTerms(lease)");
eq(pt.describeTerms(SPLIT_DETAILS).summary, "50/50 profit split — with additional terms", "§6 describeTerms(split with details)");
eq(pt.describeTerms(LEASE_DETAILS).summary, "Fixed monthly lease payment — $2,000.00 per month — with additional terms", "§6 describeTerms(lease with details)");

const META = { inviteId: 7, termsRevision: 3, capturedAt: "2026-09-30T12:00:00.000Z" };
ok(pt.snapshotJson(null, META) === null && pt.snapshotJson(STANDARD_SPLIT, META) === null, "§6 the standard contract snapshots as NULL");
const snap = pt.snapshotJson(LEASE_DETAILS, META);
eq(JSON.parse(snap), { v: 1, type: "lease", leaseAmountCents: 200000, details: LEASE_DETAILS.details, inviteId: 7, termsRevision: 3, capturedAt: META.capturedAt },
	"§6 snapshotJson() writes the v1 shape");
eq(pt.parseSnapshot(snap), { type: "lease", leaseAmountCents: 200000, details: LEASE_DETAILS.details, ...META }, "§6 parseSnapshot() reads it back");
eq(pt.parseSnapshot(pt.snapshotJson(SPLIT_DETAILS, META)).type, "split", "§6 a split with details round-trips");
ok(pt.parseSnapshot(null) === null && pt.parseSnapshot("") === null && pt.parseSnapshot(undefined) === null, "§6 NULL / empty is the standard contract");
const good = JSON.parse(snap);
const BAD_SNAPSHOTS = [
	["not JSON", "{bad"],
	["an array", "[]"],
	["a number", 42],
	["too long", `"${"x".repeat(20000)}"`],
	["version 2", JSON.stringify({ ...good, v: 2 })],
	["unknown type", JSON.stringify({ ...good, type: "bonus" })],
	["lease below the floor", JSON.stringify({ ...good, leaseAmountCents: 99 })],
	["lease amount as text", JSON.stringify({ ...good, leaseAmountCents: "200000" })],
	["split with an amount", JSON.stringify({ ...good, type: "split", leaseAmountCents: 100 })],
	["split with the amount missing", JSON.stringify({ v: 1, type: "split", details: "x", inviteId: 7, termsRevision: 3, capturedAt: META.capturedAt })],
	["standard split stored", JSON.stringify({ ...good, type: "split", leaseAmountCents: null, details: "" })],
	["details not in stored form", JSON.stringify({ ...good, details: "  padded" })],
	["details with an invisible character", JSON.stringify({ ...good, details: `a${RLO}b` })],
	["no invite id", JSON.stringify({ ...good, inviteId: undefined })],
	["revision 0", JSON.stringify({ ...good, termsRevision: 0 })],
	["capture time not ISO", JSON.stringify({ ...good, capturedAt: "yesterday" })],
];
for (const [label, value] of BAD_SNAPSHOTS) {
	ok(throwsCode(() => pt.parseSnapshot(value), "PAYMENT_TERMS_SNAPSHOT_INVALID"), `§6 parseSnapshot() refuses: ${label}`);
}
eq(pt.termsFromInviteRow({ payment_type: "lease", lease_amount_cents: 150000, amendment_details: "" }), { type: "lease", leaseAmountCents: 150000, details: "" },
	"§6 termsFromInviteRow() reads a lease row");
eq(pt.termsFromInviteRow({ payment_type: "split", lease_amount_cents: null, amendment_details: "" }), { type: "split", leaseAmountCents: null, details: "" },
	"§6 termsFromInviteRow() reads a standard split row as stored");
ok(throwsCode(() => pt.termsFromInviteRow({ payment_type: "lease", lease_amount_cents: null, amendment_details: "" }), "PAYMENT_TERMS_INVALID"),
	"§6 termsFromInviteRow() refuses a lease row without an amount");

// ── §7 adversarial input is cheap ───────────────────────────────────────────
console.log("§7 timing");
const BUDGET_MS = 50;
function timed(label, fn) {
	fn(); // warm
	const t0 = performance.now();
	fn();
	const ms = performance.now() - t0;
	ok(ms < BUDGET_MS, `§7 ${label} took ${ms.toFixed(1)} ms (budget ${BUDGET_MS} ms)`);
}
const HUGE = 100000;
timed("100k spaces-and-newlines details", () => pt.normalizeTermsInput({ paymentType: "split", details: " \n".repeat(HUGE / 2) }));
timed("100k combining marks details", () => pt.normalizeDetails(`a${cp(0x0301).repeat(HUGE)}`));
timed("100k-character amount", () => pt.parseLeaseAmountToCents("9".repeat(HUGE)));
timed("100k-character name", () => pt.normalizeName(" a".repeat(HUGE / 2)));
timed("100k-character token", () => pt.INVITE_TOKEN_RE.test("A".repeat(HUGE)));
timed("100k-character snapshot", () => { try { pt.parseSnapshot("x".repeat(HUGE)); } catch { /* refused */ } });
timed("8,000 characters of internal whitespace runs", () => pt.normalizeDetails(`a${" \t".repeat(1999)}\n${"\n".repeat(3000)}b${" ".repeat(1000)}`));
timed("8,000 characters of invisible characters", () => pt.normalizeDetails(`${RLO}${ZWSP}`.repeat(4000)));

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	for (const f of failures) console.log(`  x ${f}`);
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`${pass} assertions passed`);
