#!/usr/bin/env node
// Audit the onboarding/invoice templates against their field maps.
//
// WHY THIS EXISTS. lib/policy-renderer.js fills fields by aria-label and, for
// anything not in requiredText, still does the equivalent of "skip what I cannot
// find". A label a field map asks for but the template does not have is therefore
// dropped with no error and no trace in the PDF. vehicle_lease shipped that way
// for the life of the product: it asked for "Lessor name" / "Lessor address" /
// "Lessor contact" against markup that had none of them. PR #234 added the
// fill assertion, but that assertion is a DECLARED SUBSET (requiredText) by
// design, so it does not and should not catch every such gap. This does.
//
// Pure static analysis — no Puppeteer, no network, no DB, no writes. Safe to run
// anywhere, including against production checkouts.
//
//   node scripts/audit-policy-labels.js
//
// Exit 0 = every label a map asks for exists in its template, and no CHECKBOX
//          label is repeated (see the duplicated-label block below — the two
//          kinds of repeat now have two different verdicts).
// Exit 1 = at least one gap, or a repeated checkbox label the singular
//          renderer would half-tick (prints each one).

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TPL_DIR = path.join(ROOT, "onboarding-templates", "policy");
const POLICY_FIELD_MAPS = require(path.join(ROOT, "lib", "policy-field-maps.js"));

// Mirrors DOC_FILES in lib/policy-renderer.js.
const DOC_FILES = {
	contractor_agreement: "contractor-agreement.html",
	equipment_policy: "equipment-policy.html",
	mobile_policy: "mobile-policy.html",
	substance_policy: "substance-policy.html",
	service_invoice: "service-invoice.html",
	service_invoice_owner_op: "service-invoice-owner-op.html",
	service_invoice_manual: "service-invoice-manual.html",
	master_agreement: "master-agreement.html",
	vehicle_lease: "vehicle-lease.html",
};

// Every mapper field is exercised with a non-empty, OBVIOUSLY FAKE value, so a
// label is reported whether or not real data happens to populate it. Never put a
// real SSN/EIN/bank number here — this file is committed.
const PROBE = new Proxy(
	{
		vehicles: [{ year: "2000", make: "PROBE", model: "P", vin: "PROBEVIN000000000", mileage: "1", titleState: "TX", liens: "PROBE", registeredOwner: "PROBE", unitNumber: "P-1" }],
		loads: [], fuelMaintExpenses: [], lineItems: [], deductions: [], days: {},
		signatureImage: null,
		adjustment: 1,
		totalDue: 1, subtotal: 1, deductionsTotal: 1, grossRevenue: 1,
		deductible: 1, net: 1, payPercentage: 1, totalEarnings: 1,
		entityType: "Other - PROBE",
		accountType: "Business Checking",
		paymentMethod: "ach",
	},
	{
		// Any key the mappers read that is not pinned above resolves to a non-empty
		// string, so "asked" is maximal and the audit cannot pass by accident.
		get(target, prop) {
			if (prop in target) return target[prop];
			if (typeof prop === "symbol") return undefined;
			return "PROBE";
		},
		has: () => true,
	},
);

// Some labels do not exist in the static markup at all: service-invoice.html's
// own <script> builds its 7 day rows with aria-label="${day} total" and friends,
// and lib/policy-renderer.js deliberately lets that script run before filling.
// A purely literal scan reports all 14 as missing, which is a false alarm — and a
// checker that cries wolf gets ignored, which is how the real gap survived. So an
// interpolated label is kept as a PATTERN and matched, and counted separately so
// nobody mistakes "matched a pattern" for "verified in the DOM".
function ariaLabelIndex(html) {
	const literals = new Map(); // exact label -> occurrence count
	const patterns = []; // { source, re } for aria-label="...${x}..."
	const re = /aria-label="([^"]*)"/g;
	let m;
	while ((m = re.exec(html))) {
		const raw = m[1];
		if (raw.includes("${")) {
			const rx = new RegExp(
				"^" +
					raw
						.split(/\$\{[^}]*\}/)
						.map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
						.join("[^\"]+") +
					"$",
			);
			patterns.push({ source: raw, re: rx });
		} else {
			literals.set(raw, (literals.get(raw) || 0) + 1);
		}
	}

	// A SECOND, checkbox-scoped index. lib/policy-renderer.js:290 selects with
	// `input[type="checkbox"][aria-label="…"]`, so "is this label duplicated?"
	// has to be asked of CHECKBOX elements only. Counting every aria-label
	// instead would be wrong in both directions: a label carried by one checkbox
	// and one text input is NOT a collision for that selector (it would be a
	// false alarm), while the count that matters — two checkboxes, one label —
	// is exactly what the general index cannot distinguish.
	const checkboxLiterals = new Map();
	const inputRe = /<input\b[^>]*>/gi;
	let t;
	while ((t = inputRe.exec(html))) {
		const tag = t[0];
		if (!/\btype\s*=\s*["']?checkbox\b/i.test(tag)) continue;
		const la = /\saria-label="([^"]*)"/.exec(tag);
		// An interpolated label belongs to markup the template's own script
		// builds; it is not a literal anyone can duplicate by editing the HTML.
		if (!la || la[1].includes("${")) continue;
		checkboxLiterals.set(la[1], (checkboxLiterals.get(la[1]) || 0) + 1);
	}

	return {
		literals,
		patterns,
		checkboxLiterals,
		hasLiteral: (l) => literals.has(l),
		matchPattern: (l) => patterns.find((p) => p.re.test(l)) || null,
		has: (l) => literals.has(l) || patterns.some((p) => p.re.test(l)),
		count: (l) => literals.get(l) || 0,
		countCheckbox: (l) => checkboxLiterals.get(l) || 0,
	};
}

let problems = 0;
let cbDuplicates = 0; // counted into `problems` — see the duplicated-label block
let repeatNotes = 0; // informational only, never counted into `problems`

for (const [docKey, file] of Object.entries(DOC_FILES)) {
	const filePath = path.join(TPL_DIR, file);
	if (!fs.existsSync(filePath)) {
		console.error(`MISSING TEMPLATE  ${docKey} -> ${file}`);
		problems++;
		continue;
	}
	const mapper = POLICY_FIELD_MAPS[docKey];
	if (!mapper) {
		console.error(`MISSING FIELD MAP ${docKey}`);
		problems++;
		continue;
	}

	const html = fs.readFileSync(filePath, "utf-8");
	const have = ariaLabelIndex(html);
	const fields = mapper(PROBE);

	const askedText = Object.keys(fields.text || {});
	const missingText = askedText.filter((l) => !have.has(l));
	const runtimeText = askedText.filter((l) => !have.hasLiteral(l) && have.matchPattern(l));

	const askedCb = Object.keys(fields.checkboxesByLabel || {});
	const missingCb = askedCb.filter((l) => !have.has(l));

	const askedIds = Object.keys(fields.checkboxesById || {});
	const missingIds = askedIds.filter((id) => !new RegExp(`\\sid="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(html));

	// requiredText must name a key the mapper actually asks for, or PR #234's
	// assertion silently disarms itself (renaming the key in `text` alone).
	const required = Array.isArray(fields.requiredText) ? fields.requiredText : [];
	const orphanRequired = required.filter((l) => !Object.prototype.hasOwnProperty.call(fields.text || {}, l));
	const requiredNotInTemplate = required.filter((l) => !have.has(l));

	const sigTarget = fields.signatureLabelForImage;
	const sigMissing = sigTarget && !have.has(sigTarget);

	// --- Duplicated aria-labels: ONE symptom, TWO renderers, TWO verdicts ------
	//
	// This block used to compute a single `duplicated` set from askedText only,
	// and print "only the FIRST is filled — querySelector is singular". After PR
	// #247 (bf98107) that sentence was false for the case it described and the
	// case it was true of was not being checked at all — the script warned about
	// the bug that was fixed and stayed silent about the one that was not.
	//
	// TEXT — informational, not a defect. lib/policy-renderer.js:218 now uses
	// querySelectorAll and credits a label as verified only when EVERY slot took
	// the value (:230-232), so a repeated text label loses nothing. It is still
	// worth naming, because filling every match is safe only while each repeat
	// belongs to the SAME party — the invariant recorded at :206-215. So this
	// prints as something to confirm, and never fails the run: several templates
	// legitimately repeat a signature line, and what each repeat should say is
	// an editorial call.
	const repeatedText = askedText.filter((l) => have.count(l) > 1);

	// CHECKBOXES — fatal. lib/policy-renderer.js:290 is STILL querySelector
	// (singular), and the comment above it at :280-287 records that as a
	// MEASURED no-op — 32 distinct checkbox aria-labels across the 9 templates,
	// not one of them repeated — with an explicit instruction, "Make it
	// querySelectorAll then", for the day one is. Nothing enforced that
	// measurement, so it was one template edit away from silently expiring.
	// This is the check that enforces it.
	//
	// Fatal rather than a warning, and deliberately unlike the text case above:
	// a repeated checkbox label is never an editorial choice. It ticks the first
	// box and leaves the rest unchecked on an inspection or compliance
	// attestation — a signed document asserting something nobody asserted — and
	// the remedy is a one-line renderer change, not a template rewrite. Note the
	// remedy is NOT this script's to make: report it and let the renderer's
	// owner apply it.
	const duplicatedCb = askedCb.filter((l) => have.countCheckbox(l) > 1);

	const bad =
		missingText.length +
		missingCb.length +
		missingIds.length +
		orphanRequired.length +
		requiredNotInTemplate.length +
		(sigMissing ? 1 : 0) +
		duplicatedCb.length;
	problems += bad;
	cbDuplicates += duplicatedCb.length;
	repeatNotes += repeatedText.length;

	if (bad || repeatedText.length) {
		console.log(`\n${bad ? "FAIL" : "note"}  ${docKey}  (${file})`);
		if (missingText.length) console.log(`   text labels asked but absent from template : ${missingText.join(", ")}`);
		if (missingCb.length) console.log(`   checkbox labels asked but absent           : ${missingCb.join(", ")}`);
		if (missingIds.length) console.log(`   checkbox ids asked but absent              : ${missingIds.join(", ")}`);
		if (orphanRequired.length) console.log(`   requiredText names a key not in text{}     : ${orphanRequired.join(", ")}`);
		if (requiredNotInTemplate.length) console.log(`   requiredText absent from template          : ${requiredNotInTemplate.join(", ")}`);
		if (sigMissing) console.log(`   signatureLabelForImage absent from template: ${sigTarget}`);
		if (duplicatedCb.length) {
			console.log(`   duplicated CHECKBOX aria-labels — only the FIRST is ticked, the rest stay`);
			console.log(`   unchecked on a signed attestation (lib/policy-renderer.js:290 is still`);
			console.log(`   querySelector, singular):`);
			for (const l of duplicatedCb) console.log(`       "${l}" x${have.countCheckbox(l)}`);
			console.log(`   fix: make that selector querySelectorAll, exactly as the comment at`);
			console.log(`        lib/policy-renderer.js:280-287 instructs. Do not "fix" it here.`);
		}
		if (repeatedText.length) {
			console.log(`   repeated text aria-labels — FILLED, not dropped: lib/policy-renderer.js:218`);
			console.log(`   is querySelectorAll and credits the label only if every slot took the value.`);
			console.log(`   Informational — confirm each repeat is the SAME party (policy-renderer.js:206-215),`);
			console.log(`   or one party's value lands on another party's line:`);
			for (const l of repeatedText) console.log(`       "${l}" x${have.count(l)}`);
		}
		if (runtimeText.length) console.log(`   (${runtimeText.length} label(s) generated at runtime by the template's own script — matched by pattern)`);
	} else {
		const rt = runtimeText.length ? `, ${runtimeText.length} runtime-generated` : "";
		console.log(`ok    ${docKey}  (${askedText.length} text, ${askedCb.length} checkbox labels${rt})`);
	}
}

console.log(
	`\n${problems ? "FAILED" : "PASSED"} — ${problems} problem(s)` +
		` (of which ${cbDuplicates} duplicated checkbox label(s)),` +
		` ${repeatNotes} repeated text label(s) [informational, not a defect]` +
		` across ${Object.keys(DOC_FILES).length} documents.`,
);
process.exit(problems ? 1 : 0);
