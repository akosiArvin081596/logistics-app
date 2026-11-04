#!/usr/bin/env node
/**
 * The owner-operator agreement (Form OO-1, DRAFT) and the weekly settlement
 * statement: onboarding-templates/policy/owner-operator-agreement.html and
 * owner-operator-settlement.html, their field maps (lib/owner-operator-templates.js,
 * registered in lib/policy-field-maps.js), their wording
 * (lib/owner-operator-agreement-text.js), the flag gate in lib/policy-renderer.js
 * and the mirror in scripts/audit-policy-labels.js.
 *
 * WHAT IS ASSERTED
 *   §1 registered only behind the flags: with OWNER_OPERATOR_ONBOARDING_ENABLED
 *      off the agreement is an unknown document (template and field map), with
 *      OWNER_OPERATOR_SETTLEMENTS_ENABLED off the statement is; each flag opens
 *      only its own document and only for exactly "true"; a refused render opens
 *      no page; the other documents are unchanged; the flagged list and its
 *      mirror agree and stay out of DOC_FILES
 *   §2 labels: each template carries exactly its map's labels, every one
 *      required; each party's lines sit in its own block; each table's id and
 *      cells match the map; audit-policy-labels.js exits 0
 *   §3 DRAFT: each template's header, every printed page's top and footer, and
 *      its title say DRAFT, as the text module does; the agreement prints its
 *      form version; no note to counsel or review note on the form
 *   §4 the agreement's text: the lawyer packet's clauses (fee, the only-fee
 *      sentence, no markup, only what the Carrier paid or advanced, the
 *      charge-back list, installment, escrow, payment time, load records, no
 *      required purchases, insurance, copies); the charge-back list equals the
 *      exported categories and is what a charge validates against; no person's
 *      name; no script; no text input (every value is a span that wraps)
 *   §5 the agreement's map: Appendix B's terms print to the cent; a term that
 *      isn't valid is refused (labels named, values never); he signs only a
 *      whole agreement; a blank preview renders; no figure is added
 *   §6 fee rules: the company percentage is the split, its one fee line exactly
 *      the signed fee on the week's load pay; a fee with no cost behind it only
 *      from the signed schedule, which lists only what the form lists (the draft
 *      lists none), and never dated before its settlement week
 *   §7 the statement's map: Appendix B weeks 1 and 2 built by lib/owner-operator.js
 *      print to the cent; office-filed lines, pending receipts and held items are
 *      marked; no customer, rate-con or investor text; every amount printed is a
 *      server figure; a bad week, figure or line kind is refused
 *   §8 render on a stand-in page, POLICY_FIELD_WRAP_ENABLED off and on: both
 *      documents fill whole, long values included; a required label the
 *      template lost is refused
 *   §9 mutants: each part removed or loosened flips a case above
 *
 * Made-up data only. No browser, server, network, database or writes: the
 * renderer runs on a stand-in page.
 *
 * Run: node scripts/test-owner-operator-templates.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TPL_DIR = path.join(ROOT, "onboarding-templates", "policy");
const AG = "owner_operator_agreement";
const ST = "owner_operator_settlement";
const FILES = { [AG]: "owner-operator-agreement.html", [ST]: "owner-operator-settlement.html" };
const RENDERER_PATH = path.join(ROOT, "lib", "policy-renderer.js");
const MAPS_PATH = path.join(ROOT, "lib", "owner-operator-templates.js");
const TEXT_PATH = path.join(ROOT, "lib", "owner-operator-agreement-text.js");
const AUDIT_PATH = path.join(ROOT, "scripts", "audit-policy-labels.js");
const FLAGS = { onboarding: "OWNER_OPERATOR_ONBOARDING_ENABLED", settlements: "OWNER_OPERATOR_SETTLEMENTS_ENABLED" };
const OTHER_ENV = ["OWNER_OPERATOR_LOAD_PAY_ENABLED", "OWNER_OPERATOR_ESCROW_ENABLED", "POLICY_FIELD_WRAP_ENABLED",
	"POLICY_TEMPLATE_DIR_CONTRACTOR_AGREEMENT", "POLICY_TEMPLATE_DIR_SUBSTANCE_POLICY", "POLICY_TEMPLATE_DIR_VEHICLE_LEASE"];

// The shell's values never reach a case.
for (const k of [...Object.values(FLAGS), ...OTHER_ENV]) delete process.env[k];

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
const eq = (actual, expected, msg) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	ok(a === e, `${msg}\n      expected ${e}\n      actual   ${a}`);
};
// A part that throws (a missing file or export on older code) is one failure, not a crash.
async function part(title, fn) {
	console.log(title);
	try { await fn(); } catch (err) { failures.push(`${title}: threw ${err && err.message ? err.message : err}`); }
}
const read = (p) => fs.readFileSync(p, "utf8");
const template = (key) => read(path.join(TPL_DIR, FILES[key]));
const ariaLabels = (html) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
const sorted = (a) => [...a].sort();
const uniq = (a) => [...new Set(a)];
const holds = (fn) => { try { return fn() === true; } catch { return false; } };
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e && e.code ? e.code : `uncoded: ${e && e.message}`; } };
const errorOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const throwsUnknown = (fn) => { try { fn(); return false; } catch (e) { return /^Unknown onboarding doc: /.test(String(e && e.message)); } };

function withEnv(vars, fn) {
	const keys = [...Object.values(FLAGS), ...OTHER_ENV];
	const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	for (const k of keys) delete process.env[k];
	Object.assign(process.env, vars);
	try { return fn(); } finally {
		for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
	}
}
async function withEnvAsync(vars, fn) {
	const keys = [...Object.values(FLAGS), ...OTHER_ENV];
	const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	for (const k of keys) delete process.env[k];
	Object.assign(process.env, vars);
	try { return await fn(); } finally {
		for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
	}
}
const ON_AG = { [FLAGS.onboarding]: "true" };
const ON_ST = { [FLAGS.settlements]: "true" };
const ON_BOTH = { ...ON_AG, ...ON_ST };

// The text a reader sees in the body, tags dropped and whitespace collapsed.
function bodyText(html) {
	const body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html) || [null, ""])[1];
	return body
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}
// A { key: "file" } block as written in a source file.
function filesBlockOf(src, name) {
	const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(src);
	if (!m) throw new Error(`no ${name} block`);
	return Object.fromEntries([...m[1].matchAll(/^\s*([a-z_]+):\s*(?:\{\s*file:\s*)?"([^"]+)"/gm)].map((x) => [x[1], x[2]]));
}
// Independent of the module under test: "$1,234.56", "-$23.75".
const usd = (c) => `${c < 0 ? "-" : ""}$${Math.floor(Math.abs(c) / 100).toLocaleString("en-US")}.${String(Math.abs(c) % 100).padStart(2, "0")}`;

// Modules compiled from source at their own path, with some requires replaced.
function compileAt(filePath, src, overrides = {}) {
	const realRequire = Module.prototype.require;
	Module.prototype.require = function (id) {
		if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
		return realRequire.apply(this, arguments);
	};
	try {
		const m = new Module(filePath, null);
		m.filename = filePath;
		m.paths = Module._nodeModulePaths(path.dirname(filePath));
		m._compile(src, filePath);
		return m.exports;
	} finally {
		Module.prototype.require = realRequire;
	}
}
// A mutated copy of a source: every replacement must apply, or the fixture is wrong.
function mutate(src, pairs) {
	let out = src;
	for (const [from, to] of pairs) {
		if (!out.includes(from)) throw new Error(`mutant: "${from.slice(0, 60)}" not found`);
		out = out.split(from).join(to);
	}
	return out;
}

// ── made-up people and values (no real person, carrier or place of business) ─
const PNG = `data:image/png;base64,${Buffer.from("made-up owner-operator signature").toString("base64")}`;
const AGREEMENT_PREVIEW = {
	effectiveDate: "November 2, 2026",
	fullName: "Alex Example",
	businessName: "Example Hauling LLC",
	address: "100 Made-Up Road, Testville, TX 00000",
	startDate: "November 2, 2026",
	feeBps: 1800,
	escrowWeeklyCents: 50000,
	escrowTargetCents: 250000,
	truckYear: 2020,
	truckMake: "Made-Up Motors",
	truckModel: "MU-1",
	truckVin: "1MADEUPVIN0000001",
	truckPlate: "MU-0000",
	truckPlateState: "TX",
	truckUnit: "OO-9001-A",
	registeredOwner: "Alex Example",
	truckOwnership: "own",
	// Appendix B: the truck row's $1,343.33 and $65.00 a month, x 12 / 52 on the server.
	weeklyInsuranceCents: 31000,
	weeklyEldCents: 1500,
	onboardingCosts: [
		{ label: "Form 2290", cents: 55000 },
		{ label: "IRP registration and plates", cents: 185000 },
		{ label: "ELD device", cents: 30000 },
		{ label: "Lettering", cents: 25000 },
	],
	onboardingTotalCents: 295000,
	installmentCents: 100000,
	paymentMethod: "ach",
	carrierSignerName: "Sam Example",
	carrierSignerTitle: "Operations Manager",
	carrierSignedOn: "November 2, 2026",
};
const AGREEMENT_SIGNED = { ...AGREEMENT_PREVIEW, signatureText: "Alex Example", signatureImage: PNG, signedOn: "November 3, 2026" };

const AG_LABELS = [
	"Agreement date", "Owner-operator name", "Doing business as", "Owner-operator address", "Registered owner",
	"Lease start date", "Company fee percent", "Escrow weekly amount", "Escrow target", "Carrier signer name",
	"Carrier signer title", "Carrier date", "Owner-operator signature", "Owner-operator printed name", "Owner-operator date",
	"Truck year", "Truck make", "Truck model", "Truck VIN", "Truck plate and state", "Truck unit number", "Truck ownership",
	"Weekly insurance", "Weekly ELD service", "Onboarding total", "Weekly installment", "Payment method",
];
const ST_LABELS = [
	"Settlement number", "Week start", "Week end", "Issue date", "Owner-operator name", "Business name", "Truck unit",
	"Total load pay", "Company fee line", "Company fee amount", "Onboarding balance before", "Onboarding installment",
	"Onboarding balance left", "Escrow balance before", "Escrow this week", "Escrow balance after", "Balance carried in",
	"Net settlement", "Amount paid", "Balance carried out", "Bank on file",
];
const PARTY_LABELS = {
	carrier: ["Carrier signer name", "Carrier date", "Carrier signer title"],
	"owner-operator": ["Owner-operator signature", "Owner-operator date", "Owner-operator printed name"],
};
// Every capitalized word each template carries: a name added to either fails §4.
const AG_WORDS = ("A Accounting After Agreement AGREEMENT Alcohol Amount AMOUNT An AND Arial As At B Before BlinkMacSystemFont Build By C " +
	"Care Carrier CARRIER Carrier's CDL Changes Charge Clearinghouse Company Confidentiality Contractor CONTRACTOR Copies Cost D Date " +
	"DATE DEDUCTIBLE DOCTYPE Doing DOT DRAFT Drug Each Either ELD End ENTITY Equipment EQUIPMENT Equipment's Escrow Every For FOR Form " +
	"Friday How ID If IFTA Independent INDEPENDENT Insurance Interest IRP It Lease LEASE LEGAL Load Loading Make MC Mobile Model NAME " +
	"No NOT NUMBER October Onboarding Once Only OO Open Operator OPERATOR Operator's Owned Owner OWNER Pay Payment Plate Policy Printed " +
	"Refill Registered REVIEW Roboto Safety Sans Saturday Schedule Section Segoe Seven Signature SIGNATURE Signatures Starting STATE " +
	"Substance Term The These This Title Total Truck TYPE UI Unit USDOT Use Uses UTF VIN Weekly When While Year").split(" ");
const ST_WORDS = ("A Amount Arial Balance Bank BlinkMacSystemFont Business Charge Company Date Delivered Details DOCTYPE DRAFT Escrow " +
	"FINAL FOR From Held ID Installment Issue Issued Item Load Loads Logo Net NOT Onboarding Open Owner Paid REVIEW Roboto Sans Segoe " +
	"Settlement STATEMENT Status Summary The This To Total Truck UI UTF Week Weekly").split(" ");
const capitalized = (html) => uniq(html.match(/\b[A-Z][A-Za-z']*\b/g) || []).sort();

// The lawyer packet's clauses, as its draft words them (bracketed figures are
// its proposed defaults; an empty fill leaves one space in the body text).
const CLAUSES = [
	["the fee", "The Carrier keeps a company fee of % of load pay, computed on each settlement week's total load pay and rounded to the nearest cent."],
	["a fee change needs an amendment", "A change to the fee needs a written amendment signed by both parties."],
	["no markup, only what the Carrier paid or advanced", "at the amount the Carrier actually paid, as shown on the receipt, invoice or notice, with no markup. Only an item the Carrier paid or advanced is deducted:"],
	["a self-paid purchase is never deducted", "A purchase the Owner-Operator paid for with the Owner-Operator's own money is not deducted."],
	["the only kinds of charge-back", "(b) These are the only kinds of charge-back; any other needs a written amendment signed by both parties."],
	["a dispatcher's item waits for approval", "(d) An item a dispatcher enters for the Owner-Operator is deducted only after [an authorized manager] of the Carrier approves it, except a paper toll filed with its scanned notice."],
	["paper tolls from the scanned notice", "(e) A paper toll is charged from the toll notice the Carrier's office scans. The settlement shows its travel date, the issuing agency, the notice number and the toll amount, with any violation or administrative fee as its own line, marked as filed by the office."],
	["copies behind a charge-back", "(f) The Owner-Operator may ask for a copy of the receipt, invoice or notice behind any charge-back."],
	["no interest on the onboarding balance", "No interest or fee is added to it."],
	["the installment rule", "If Schedule C shows no installment, the installment is one third of the onboarding balance at the first settlement that has a balance, rounded up to the cent, and it does not change after that unless the Carrier lowers it."],
	["the installment never makes a week negative", "(c) An installment comes only from what is left of a week after its charges and any carried balance. It never makes a week negative."],
	["the escrow build-up never makes a week negative", "A hold-back comes only from what is left of a week after its charges, any carried balance and any installment. It never makes a week negative."],
	["the escrow uses", "(b) Uses. The fund is held for the Owner-Operator and may be used only for: (1) insurance deductibles for claims involving the Equipment; (2) charge-back items under Section 6 left unpaid, such as tolls or fuel; and (3) amounts the Owner-Operator owes the Carrier under this agreement when this lease ends, including any onboarding balance left."],
	["the escrow accounting", "(e) Accounting. Every settlement shows the fund's balance before, that week's hold-back or use, and the balance after. The Owner-Operator may ask for an accounting of the fund at any time."],
	["the escrow hold and return", "The Carrier holds the fund for [45] days after the last settlement week ends."],
	["escrow comes back whatever the hold-backs", "The fund is applied and returned in this way even if the Carrier has stopped taking new hold-backs."],
	["escrow amounts change only by amendment", "(h) Changes. The amounts in (a) change only by a written amendment signed by both parties."],
	["payment time", "(c) The Carrier pays the net amount by the method in Schedule D on [the Friday after the settlement week ends]."],
	["a short week is still settled", "(d) If a week's charges, together with any balance carried in, are more than its load pay, nothing is paid that week and the difference is carried to the next settlement. A settlement is still issued for that week to show the amount carried."],
	["an approved settlement never changes", "Once the Carrier has approved a settlement, it is not changed; any correction is made as a charge or credit on a later settlement."],
	["the load records", "5. Load records. At or before each settlement the Carrier gives the Owner-Operator, for each load, its load ID, dates, origin and destination (city and state) and load pay. The Carrier's rate confirmations and other agreements with its customers are the Carrier's confidential business records and are not provided."],
	["no required purchases", "8. No required purchases. The Owner-Operator is not required to buy or rent any product, equipment or service from the Carrier as a condition of this lease."],
	["insurance", "The Carrier keeps public liability and property damage insurance on the Equipment while it is operated for the Carrier."],
	["copies", "14. Copies. Each party keeps a signed copy. A copy stays in the Equipment while it is leased to the Carrier, on paper or electronically in the Carrier's driver app."],
	["no load before signing or after the end", "The Carrier does not dispatch loads to the Owner-Operator before both parties have signed this agreement or after this lease ends."],
	["weekly charges from the monthly amounts", "(each is the Carrier's monthly amount for the Equipment x 12 / 52, rounded to the cent)"],
	["an installment set before signing, only lowered after", "(The Carrier may set any installment before this agreement is signed; after signing it may only lower it. If left blank, the installment is one third of the onboarding balance at the first settlement that has a balance, rounded up to the cent.)"],
	["independent business", "11. Independent business. The Owner-Operator is an independent business, not an employee: no tax withholding and no employee benefits."],
];

// ── Appendix B, built by lib/owner-operator.js (weeks 1 and 2) ───────────────
function appendixB() {
	const oo = require(path.join(ROOT, "lib", "owner-operator.js"));
	const profile = { feeBps: 1800, escrowTargetCents: 250000, escrowWeeklyCents: 50000 };
	const win = { firstWeekStart: "2026-11-07", floorWeekStart: "2026-11-07" };
	const weekly = (sat) => [
		{ kind: "weekly", ref: `insurance:${sat}`, lineDate: sat, label: "Insurance", cents: -31000, baseCents: 31000 },
		{ kind: "weekly", ref: `eld:${sat}`, lineDate: sat, label: "ELD service", cents: -1500, baseCents: 1500 },
	];
	const w1Loads = [
		{ ref: "QA-OO-1", day: "2026-11-09", label: "QA-OO-1", cents: 400000 },
		{ ref: "QA-OO-2", day: "2026-11-12", label: "QA-OO-2", cents: 350000 },
	];
	const w1Receipts = [
		{ ref: "r-1", day: "2026-11-08", label: "Fuel", cents: 142035 },
		{ ref: "r-2", day: "2026-11-11", label: "Fuel", cents: 110510 },
		{ ref: "r-3", day: "2026-11-10", label: "Toll", cents: 4650 },
	];
	const w1 = oo.ooBuildSettlement({
		weekStart: "2026-11-07", window: win, profile, installmentCents: 100000, loads: w1Loads, receipts: w1Receipts,
		weeklyLines: weekly("2026-11-07"), onboardingLeftCents: 295000, escrow: { enabled: false },
	});
	const w2 = oo.ooBuildSettlement({
		weekStart: "2026-11-14", window: win, profile, installmentCents: 100000,
		loads: [...w1Loads, { ref: "QA-OO-3", day: "2026-11-18", label: "QA-OO-3", cents: 210000 }],
		receipts: [...w1Receipts, { ref: "r-4", day: "2026-11-16", label: "Fuel", cents: 198000 }],
		weeklyLines: weekly("2026-11-14"), settled: oo.ooSettledFromLines(w1.lines), onboardingLeftCents: 195000, escrow: { enabled: false },
	});
	return { oo, w1, w2 };
}
// What the server adds to each line for the statement; the customer, broker and
// rate-con fields are there to prove they never print.
const DISPLAY = {
	"QA-OO-1": { from: "Laredo, TX", to: "Dallas, TX", customer: "Made-Up Shipper Co", broker: "Made-Up Broker Co", rateConText: "made-up rate con words" },
	"QA-OO-2": { from: "Dallas, TX", to: "Houston, TX", late: true },
	"QA-OO-3": { from: "Houston, TX", to: "Austin, TX" },
	"r-1": { receiptType: "Fuel", place: "Made-Up Fuel Stop, Laredo, TX", gallons: 300.5 },
	"r-2": { receiptType: "Fuel", place: "Made-Up Fuel Stop, Waco, TX", pendingReview: true },
	"r-3": { receiptType: "Toll", agency: "Made-Up Toll Agency", noticeNumber: "N-0001", filedByOffice: true },
	"r-4": { receiptType: "Fuel", place: "Made-Up Fuel Stop, Austin, TX" },
};
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
function statementData(built, onboarding, extra = {}) {
	return {
		settlementNumber: "S-0001",
		weekStart: built.weekStart,
		weekEnd: built.weekEnd,
		issuedOn: "2026-11-14",
		ownerOperatorName: "Alex Example",
		businessName: "Example Hauling LLC",
		truckUnit: "OO-9001-A",
		feeBps: 1800,
		feeSchedule: [],
		lines: built.lines.map((l) => ({ ...l, ...(DISPLAY[l.ref] || {}) })),
		held: [
			{ date: "2026-11-10", label: "QA-OO-9", reason: "investor_ledger", investorId: 4242, investorName: "Made-Up Investor Co" },
			{ date: "2026-11-11", label: "Repair receipt", reason: "waiting_for_approval" },
		],
		onboarding,
		escrow: null,
		totals: pick(built.totals, ["loadCents", "carriedInCents", "netCents", "payableCents", "carriedOutCents"]),
		bankOnFile: "Checking ending 0000",
		...extra,
	};
}
// Every amount a map prints, and every amount its input carries in a *Cents field.
function printedAmounts(fields) {
	const strings = [...Object.values(fields.text || {}), ...(fields.tableRows || []).flatMap((t) => t.rows.flat())];
	return strings.flatMap((s) => String(s).match(/-?\$[\d,]+\.\d{2}/g) || []);
}
function inputAmounts(data) {
	const out = new Set();
	const walk = (v, key) => {
		if (Array.isArray(v)) v.forEach((x) => walk(x, key));
		else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
		else if (Number.isInteger(v) && /cents$/i.test(String(key))) out.add(usd(v));
	};
	walk(data, "");
	return out;
}
const onlyServerAmounts = (fields, data) => {
	const have = inputAmounts(data);
	const extra = printedAmounts(fields).filter((a) => !have.has(a));
	return { ok: extra.length === 0, extra };
};

// ── the stand-in page (as scripts/test-passenger-authorization-form.js) ──────
function cssEscape(value) {
	const s = String(value);
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c === 0) { out += "�"; continue; }
		if ((c >= 0x01 && c <= 0x1f) || c === 0x7f || (i === 0 && c >= 0x30 && c <= 0x39) ||
			(i === 1 && c >= 0x30 && c <= 0x39 && s.charCodeAt(0) === 0x2d)) { out += `\\${c.toString(16)} `; continue; }
		if (i === 0 && s.length === 1 && c === 0x2d) { out += `\\${s[i]}`; continue; }
		if (c >= 0x80 || c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) { out += s[i]; continue; }
		out += `\\${s[i]}`;
	}
	return out;
}
const cssUnescape = (s) => s.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));
function parseSelector(sel) {
	const tag = /^[a-zA-Z]*/.exec(sel)[0];
	const attrs = [];
	let i = tag.length;
	const bad = () => new Error(`stub document: unsupported selector ${sel}`);
	while (i < sel.length) {
		if (sel[i] !== "[") throw bad();
		const name = /^[a-zA-Z-]+/.exec(sel.slice(i + 1));
		if (!name) throw bad();
		i += 1 + name[0].length;
		if (sel[i] === "]") { attrs.push([name[0], undefined]); i++; continue; }
		if (sel.slice(i, i + 2) !== "=\"") throw bad();
		i += 2;
		let raw = "";
		while (i < sel.length && sel[i] !== "\"") {
			if (sel[i] === "\\") { raw += sel.slice(i, i + 2); i += 2; } else { raw += sel[i]; i++; }
		}
		if (sel.slice(i, i + 2) !== "\"]") throw bad();
		i += 2;
		attrs.push([name[0], cssUnescape(raw)]);
	}
	return { tag, attrs };
}
function makeNode(doc, tagName, attrs = {}, initialText = "") {
	const attributes = new Map(Object.entries(attrs));
	let value = tagName === "INPUT" ? (attributes.get("value") ?? "") : "";
	let text = initialText;
	const node = {
		tagName,
		style: { cssText: "", setProperty() {} },
		getAttribute: (n) => (attributes.has(n) ? attributes.get(n) : null),
		setAttribute: (n, v) => { attributes.set(n, String(v)); },
		removeAttribute: (n) => { attributes.delete(n); },
		hasAttribute: (n) => attributes.has(n),
		get value() { return value; },
		set value(v) { value = String(v); },
		get textContent() { return text; },
		set textContent(v) { text = v == null ? "" : String(v); },
		get src() { return attributes.get("src") ?? ""; },
		set src(v) { attributes.set("src", String(v)); },
		get alt() { return attributes.get("alt") ?? ""; },
		set alt(v) { attributes.set("alt", String(v)); },
		replaceWith(other) {
			const at = doc.nodes.indexOf(node);
			if (at < 0) throw new Error("stub document: replaceWith on a node not in the document");
			doc.nodes.splice(at, 1, other);
			doc.replaced.push({ from: node, to: other });
		},
	};
	return node;
}
// Every element that carries an aria-label or a data- attribute, plus every input.
function stubDocument(html) {
	const doc = {
		nodes: [],
		replaced: [],
		querySelectorAll(sel) {
			const q = parseSelector(sel);
			return doc.nodes.filter((n) => (!q.tag || n.tagName === q.tag.toUpperCase()) &&
				q.attrs.every(([name, want]) => (want === undefined ? n.hasAttribute(name) : n.getAttribute(name) === want)));
		},
		querySelector(sel) { return doc.querySelectorAll(sel)[0] || null; },
		getElementById: () => null,
		createElement: (tag) => makeNode(doc, String(tag).toUpperCase()),
	};
	const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
	let m;
	while ((m = tagRe.exec(html))) {
		const attrs = {};
		for (const a of m[2].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g)) {
			attrs[a[1].toLowerCase()] = (a[2] ?? "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
		}
		const tagName = m[1].toUpperCase();
		if (tagName !== "INPUT" && !("aria-label" in attrs) && !Object.keys(attrs).some((k) => k.startsWith("data-"))) continue;
		const after = m.index + m[0].length;
		const initial = tagName === "INPUT" ? "" : html.slice(after, html.indexOf("<", after));
		doc.nodes.push(makeNode(doc, tagName, attrs, initial));
	}
	return doc;
}
const recorder = (transform = null) => ({ transform, docs: [], args: [], results: [], closed: 0 });
function fakePage(html, rec) {
	const doc = stubDocument(html);
	rec.docs.push(doc);
	return {
		async evaluate(fn, arg) {
			// Puppeteer sends the function's source and a JSON copy of its argument.
			const inPage = new Function("document", "CSS", "getComputedStyle", `return (${fn.toString()});`)(
				doc, { escape: cssEscape }, () => ({ getPropertyValue: () => "" }));
			const sent = arg === undefined ? undefined : JSON.parse(JSON.stringify(arg));
			rec.args.push(sent);
			const result = await inPage(sent);
			const back = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
			rec.results.push(back);
			return back;
		},
		async pdf() { return new Uint8Array(Buffer.from("%PDF-1.7\n% made-up stand-in for the browser's output\n")); },
		async close() { rec.closed++; },
	};
}
// The renderer compiled from `src`, ./pdf-browser replaced by the stand-in page
// and puppeteer by nothing: no browser can start.
function loadRenderer(src, rec, overrides = {}) {
	const fakeBrowser = { openPageWithContent: async (html) => fakePage(rec.transform ? rec.transform(html) : html, rec) };
	return compileAt(RENDERER_PATH, src, { "./pdf-browser": fakeBrowser, puppeteer: {}, ...overrides });
}
async function rendering(R, docKey, data) {
	const warns = [];
	const realWarn = console.warn;
	console.warn = (...a) => warns.push(a.map(String).join(" "));
	try {
		return { pdf: await R.renderPolicy(docKey, data), warns, error: null };
	} catch (error) {
		return { pdf: null, warns, error };
	} finally {
		console.warn = realWarn;
	}
}
// Removes the one span carrying `label`; anything but exactly one match throws.
function dropSlot(label) {
	return (html) => {
		const re = new RegExp(`<span\\b[^>]*aria-label="${label}"[^>]*></span>`, "g");
		const found = html.match(re) || [];
		if (found.length !== 1) throw new Error(`fixture: "${label}" slot found ${found.length} times`);
		return html.replace(re, "");
	};
}

// ── the cases, as tables any copy of the code can be run against ────────────
// §1: R is a policy renderer.
function gateCases(R) {
	const both = (key, data) => throwsUnknown(() => R.prepareTemplateHtml(key, data)) && throwsUnknown(() => R.buildRenderFields(key, data));
	const opens = (key, data) => R.prepareTemplateHtml(key, data).length > 0 && typeof R.buildRenderFields(key, data).text === "object";
	return [
		["the agreement is unknown with every flag off", () => withEnv({}, () => both(AG, AGREEMENT_SIGNED))],
		["the statement is unknown with every flag off", () => withEnv({}, () => both(ST, {}))],
		["ONBOARDING on opens the agreement", () => withEnv(ON_AG, () => opens(AG, AGREEMENT_SIGNED))],
		["ONBOARDING on leaves the statement unknown", () => withEnv(ON_AG, () => both(ST, {}))],
		["SETTLEMENTS on opens the statement", () => withEnv(ON_ST, () => opens(ST, {}))],
		["SETTLEMENTS on leaves the agreement unknown", () => withEnv(ON_ST, () => both(AG, AGREEMENT_SIGNED))],
		["the other two flags open neither", () => withEnv({ OWNER_OPERATOR_LOAD_PAY_ENABLED: "true", OWNER_OPERATOR_ESCROW_ENABLED: "true" },
			() => both(AG, AGREEMENT_SIGNED) && both(ST, {}))],
		["only exactly \"true\" opens a document", () => ["TRUE", "True", "1", "yes", "on", " true", "true "]
			.every((v) => withEnv({ [FLAGS.onboarding]: v, [FLAGS.settlements]: v }, () => both(AG, AGREEMENT_SIGNED) && both(ST, {})))],
		["the flag is read at each render", () => withEnv(ON_AG, () => opens(AG, AGREEMENT_SIGNED)) && withEnv({}, () => both(AG, AGREEMENT_SIGNED))],
		["the documents the renderer already had are unchanged with the flags off", () => withEnv({}, () =>
			["passenger_authorization", "contractor_agreement", "equipment_policy", "service_invoice"].every((k) => R.prepareTemplateHtml(k, {}).length > 0))],
	];
}
// §5 and §6: T is the owner-operator field maps module.
function agreementCases(T) {
	const fields = (d) => T.ownerOperatorAgreementFields(d);
	const invalid = (d, label) => {
		const e = errorOf(() => fields(d));
		return Boolean(e) && e.code === "OO_AGREEMENT_TERMS_INVALID" && Array.isArray(e.labels) && e.labels.includes(label);
	};
	return [
		["the signed fee prints as a percent", () => fields(AGREEMENT_SIGNED).text["Company fee percent"] === "18"],
		["a fee out of range is refused (9.99%, 25.01%)", () => invalid({ ...AGREEMENT_PREVIEW, feeBps: 999 }, "Company fee percent") &&
			invalid({ ...AGREEMENT_PREVIEW, feeBps: 2501 }, "Company fee percent")],
		["a fee that isn't whole basis points is refused (18, \"1800\", 1800.5)", () => [18, "1800", 1800.5]
			.every((v) => invalid({ ...AGREEMENT_PREVIEW, feeBps: v }, "Company fee percent"))],
		["escrow above its target is refused", () => invalid({ ...AGREEMENT_PREVIEW, escrowWeeklyCents: 300000 }, "Escrow weekly amount")],
		["a total that disagrees with its items is refused", () => invalid({ ...AGREEMENT_PREVIEW, onboardingTotalCents: 295001 }, "Onboarding total")],
		["an unknown payment method or ownership is refused", () => invalid({ ...AGREEMENT_PREVIEW, paymentMethod: "cash" }, "Payment method") &&
			invalid({ ...AGREEMENT_PREVIEW, truckOwnership: "rent" }, "Truck ownership")],
		["a signed render with a term unset is refused, naming it", () => {
			const e = errorOf(() => fields({ ...AGREEMENT_SIGNED, feeBps: undefined, truckVin: "" }));
			return Boolean(e) && e.code === "OO_AGREEMENT_NOT_READY" && JSON.stringify(e.labels) === JSON.stringify(["Company fee percent", "Truck VIN"]);
		}],
		["a signed render without the Carrier's lines is refused", () => codeOf(() => fields({ ...AGREEMENT_SIGNED, carrierSignerName: "" })) === "OO_AGREEMENT_NOT_READY"],
		["the same terms unsigned render as a preview with blanks", () => {
			const f = fields({ ...AGREEMENT_PREVIEW, feeBps: undefined, truckVin: "" });
			return f.text["Company fee percent"] === "" && f.text["Truck VIN"] === "" && f.text["Owner-operator signature"] === "";
		}],
		["a refusal names labels and never a value", () => {
			const e = errorOf(() => fields({ ...AGREEMENT_PREVIEW, feeBps: 31337, onboardingTotalCents: 424242 }));
			return Boolean(e) && !/31337|424242|4,242\.42|313\.37/.test(e.message) && /Company fee percent/.test(e.message);
		}],
	];
}
function feeCases(T) {
	const { w1 } = appendixB();
	const onb = { beforeCents: 295000, installmentCents: 100000, leftCents: 195000 };
	const base = () => statementData(w1, onb);
	const withLines = (fn) => { const d = base(); d.lines = fn(d.lines); return d; };
	const code = (d) => codeOf(() => T.ownerOperatorSettlementFields(d));
	const scheduleLine = (extra) => ({ kind: "one_time", ref: "c-9", lineDate: "2026-11-12", label: "Made-up service fee", cents: -2500, baseCents: 2500, scheduleFee: "made_up_fee", ...extra });
	return [
		["the company fee line is the signed percentage of the week's load pay", () => {
			const f = T.ownerOperatorSettlementFields(base());
			return f.text["Company fee line"] === "Company fee (18% of $7,500.00)" && f.text["Company fee amount"] === "-$1,350.00";
		}],
		["a fee line that isn't the signed fee is refused", () => code({ ...base(), feeBps: 2000 }) === "OO_STATEMENT_FEE_INVALID"],
		["a fee line off the week's load pay is refused", () => code({ ...base(), totals: { ...base().totals, loadCents: 760000 } }) === "OO_STATEMENT_FEE_INVALID"],
		["a fee line whose amount isn't the fee on its base is refused", () => code(withLines((ls) => ls.map((l) => (l.kind === "fee" ? { ...l, cents: l.cents - 1 } : l)))) === "OO_STATEMENT_FEE_INVALID"],
		["a second fee line, or one that isn't the company fee, is refused", () =>
			code(withLines((ls) => [...ls, { kind: "fee", ref: "fee", lineDate: "2026-11-13", label: "Company fee", cents: -100, baseCents: 0 }])) === "OO_STATEMENT_FEE_INVALID" &&
			code(withLines((ls) => ls.map((l) => (l.kind === "fee" ? { ...l, ref: "made-up-fee" } : l)))) === "OO_STATEMENT_FEE_INVALID"],
		["a fee line with the fee out of range is refused", () => code({ ...base(), feeBps: 900 }) === "OO_STATEMENT_FEE_INVALID"],
		["a fee the form doesn't list is refused even when the signed schedule names it", () =>
			code({ ...withLines((ls) => [...ls, scheduleLine()]), feeSchedule: [{ key: "made_up_fee" }] }) === "OO_STATEMENT_FEE_NOT_ON_SCHEDULE"],
	];
}
// T2 is the same module with a made-up fee on the form's schedule.
function scheduledFeeCases(T2) {
	const { w1 } = appendixB();
	const onb = { beforeCents: 295000, installmentCents: 100000, leftCents: 195000 };
	const line = (extra) => ({ kind: "one_time", ref: "c-9", lineDate: "2026-11-12", label: "Made-up service fee", cents: -2500, baseCents: 2500, scheduleFee: "made_up_fee", ...extra });
	const data = (l, schedule = [{ key: "made_up_fee" }], extra = {}) => {
		const d = statementData(w1, onb, { feeSchedule: schedule, ...extra });
		d.lines = [...d.lines, l];
		return d;
	};
	const code = (d) => codeOf(() => T2.ownerOperatorSettlementFields(d));
	return [
		["a fee on the signed schedule, dated in its week, prints as its own fee line", () => {
			const f = T2.ownerOperatorSettlementFields(data(line()));
			const row = f.tableRows.find((t) => t.tbodyId === "oo-charges").rows.find((r) => /Made-up service fee/.test(r[1]));
			return Boolean(row) && row[1] === "Made-up service fee (fee)" && row[2] === "-$25.00";
		}],
		["a fee dated before its settlement week is refused", () => code(data(line({ lineDate: "2026-11-06" }))) === "OO_STATEMENT_FEE_BACKDATED"],
		["a fee with no readable date, or on a statement with no week, is refused", () =>
			code(data(line({ lineDate: "" }))) === "OO_STATEMENT_FEE_BACKDATED" &&
			code(data(line(), [{ key: "made_up_fee" }], { weekStart: undefined, weekEnd: undefined })) === "OO_STATEMENT_FEE_BACKDATED"],
		["a fee the signed schedule doesn't name is refused", () => code(data(line(), [])) === "OO_STATEMENT_FEE_NOT_ON_SCHEDULE"],
		["a schedule fee on a weekly or receipt line is refused", () =>
			code(data(line({ kind: "weekly" }))) === "OO_STATEMENT_FEE_NOT_ON_SCHEDULE" &&
			code(data(line({ kind: "receipt" }))) === "OO_STATEMENT_FEE_NOT_ON_SCHEDULE"],
	];
}
function statementCases(T) {
	const { w1, w2 } = appendixB();
	const d1 = statementData(w1, {
		beforeCents: 295000, installmentCents: w1.totals.installmentCents, leftCents: w1.totals.onboardingLeftAfterCents,
		items: [{ date: "2026-11-02", label: "Form 2290", cents: 55000 }, { date: "2026-11-02", label: "IRP registration and plates", cents: 185000 }],
	});
	const d2 = statementData(w2, { beforeCents: 195000, installmentCents: w2.totals.installmentCents, leftCents: w2.totals.onboardingLeftAfterCents });
	const f1 = () => T.ownerOperatorSettlementFields(d1);
	const rows = (f, id) => f.tableRows.find((t) => t.tbodyId === id).rows;
	const allText = (f) => JSON.stringify([f.text, f.tableRows]);
	return [
		["week 1 nets $2,253.05 and pays it", () => { const t = f1().text; return t["Net settlement"] === "$2,253.05" && t["Amount paid"] === "$2,253.05" && t["Balance carried out"] === "$0.00"; }],
		["week 1's onboarding balance: $2,950.00, $1,000.00 this week, $1,950.00 left", () => {
			const t = f1().text;
			return t["Onboarding balance before"] === "$2,950.00" && t["Onboarding installment"] === "$1,000.00" && t["Onboarding balance left"] === "$1,950.00";
		}],
		["week 2 is short: $0.00 paid, $583.00 carried", () => {
			const t = T.ownerOperatorSettlementFields(d2).text;
			return t["Net settlement"] === "-$583.00" && t["Amount paid"] === "$0.00" && t["Balance carried out"] === "$583.00" && t["Onboarding installment"] === "$0.00";
		}],
		["each load prints its date, ID, lane and pay; a late one is marked", () => JSON.stringify(rows(f1(), "oo-loads")) === JSON.stringify([
			["Nov 9, 2026", "QA-OO-1", "Laredo, TX", "Dallas, TX", "$4,000.00"],
			["Nov 12, 2026", "QA-OO-2 (late)", "Dallas, TX", "Houston, TX", "$3,500.00"],
		])],
		["charge-backs print their place, gallons and notice; office-filed and pending lines are marked", () => JSON.stringify(rows(f1(), "oo-receipts")) === JSON.stringify([
			["Nov 8, 2026", "Fuel", "Made-Up Fuel Stop, Laredo, TX; 300.5 gal", "-$1,420.35"],
			["Nov 10, 2026", "Toll", "Made-Up Toll Agency, notice N-0001; filed by the office", "-$46.50"],
			["Nov 11, 2026", "Fuel", "Made-Up Fuel Stop, Waco, TX; pending review", "-$1,105.10"],
		])],
		["weekly charges print with their week", () => JSON.stringify(rows(f1(), "oo-charges")) === JSON.stringify([
			["Nov 7, 2026", "Insurance", "-$310.00"], ["Nov 7, 2026", "ELD service", "-$15.00"],
		])],
		["held items are listed, not deducted or paid, and name no investor", () => {
			const f = f1();
			return JSON.stringify(rows(f, "oo-held")) === JSON.stringify([
				["Nov 10, 2026", "QA-OO-9", "On an investor's ledger, not paid"],
				["Nov 11, 2026", "Repair receipt", "Waiting for approval, not deducted"],
			]) && !/4242|Made-Up Investor/.test(allText(f));
		}],
		["the first settlement lists the onboarding items", () => rows(f1(), "oo-onboarding-items").length === 2 &&
			rows(T.ownerOperatorSettlementFields(d2), "oo-onboarding-items").length === 0],
		["no customer, broker or rate-con text prints", () => !/Made-Up Shipper|Made-Up Broker|rate con words/.test(allText(f1()))],
		["every amount printed is a server figure (weeks 1 and 2)", () => onlyServerAmounts(f1(), d1).ok && onlyServerAmounts(T.ownerOperatorSettlementFields(d2), d2).ok],
		["escrow off prints no escrow figures", () => { const t = f1().text; return t["Escrow balance before"] === "" && t["Escrow this week"] === "" && t["Escrow balance after"] === ""; }],
		["escrow on prints the server's three figures", () => {
			const t = T.ownerOperatorSettlementFields({ ...d1, escrow: { beforeCents: 0, thisWeekCents: 50000, afterCents: 50000 } }).text;
			return t["Escrow balance before"] === "$0.00" && t["Escrow this week"] === "$500.00" && t["Escrow balance after"] === "$500.00";
		}],
		["the header prints the number, week and payee", () => {
			const t = f1().text;
			return t["Settlement number"] === "S-0001" && t["Week start"] === "Nov 7, 2026" && t["Week end"] === "Nov 13, 2026" &&
				t["Owner-operator name"] === "Alex Example" && t["Truck unit"] === "OO-9001-A" && t["Bank on file"] === "Checking ending 0000";
		}],
		["a week that isn't Saturday to Friday is refused", () =>
			codeOf(() => T.ownerOperatorSettlementFields({ ...d1, weekStart: "2026-11-08" })) === "OO_STATEMENT_WEEK_INVALID" &&
			codeOf(() => T.ownerOperatorSettlementFields({ ...d1, weekEnd: "2026-11-14" })) === "OO_STATEMENT_WEEK_INVALID"],
		["a figure that isn't whole cents is refused, never printed blank", () =>
			codeOf(() => T.ownerOperatorSettlementFields({ ...d1, totals: { ...d1.totals, netCents: 2253.05 } })) === "OO_STATEMENT_FIGURE_INVALID" &&
			codeOf(() => T.ownerOperatorSettlementFields({ ...d1, lines: [...d1.lines, { kind: "weekly", ref: "x", lineDate: "2026-11-07", label: "X", cents: "100" }] })) === "OO_STATEMENT_FIGURE_INVALID"],
		["a line of a kind the statement can't show is refused", () =>
			codeOf(() => T.ownerOperatorSettlementFields({ ...d1, lines: [...d1.lines, { kind: "made_up", ref: "x", lineDate: "2026-11-07", label: "X", cents: -100 }] })) === "OO_STATEMENT_LINE_INVALID"],
		["an empty statement renders blank", () => { const f = T.ownerOperatorSettlementFields({}); return Object.values(f.text).every((v) => v === ""); }],
	];
}

(async () => {
	// A module missing (older code) is one failure; each part that needs it then fails on its own.
	const load = (p) => {
		try { return require(p); } catch (e) { failures.push(`cannot load ${path.relative(ROOT, p)}: ${e && e.code ? e.code : e}`); return {}; }
	};
	const readOrEmpty = (p) => (fs.existsSync(p) ? read(p) : "");
	const TEXT = load(TEXT_PATH);
	const AGT = TEXT.OWNER_OPERATOR_AGREEMENT_TEXT || {};
	const STT = TEXT.OWNER_OPERATOR_STATEMENT_TEXT || {};
	const T = load(MAPS_PATH);
	const POLICY_FIELD_MAPS = require(path.join(ROOT, "lib", "policy-field-maps.js"));
	const R = require(RENDERER_PATH);
	const RENDERER_SRC = read(RENDERER_PATH);
	const MAPS_SRC = readOrEmpty(MAPS_PATH);

	// ── §1 registered only behind the flags ─────────────────────────────────
	await part("§1 registered only behind the flags", async () => {
		for (const [name, fn] of gateCases(R)) ok(holds(fn), `§1 ${name}`);
		ok(typeof POLICY_FIELD_MAPS[AG] === "function" && POLICY_FIELD_MAPS[AG] === T.ownerOperatorAgreementFields, "§1 lib/policy-field-maps.js registers the agreement's map");
		ok(typeof POLICY_FIELD_MAPS[ST] === "function" && POLICY_FIELD_MAPS[ST] === T.ownerOperatorSettlementFields, "§1 lib/policy-field-maps.js registers the statement's map");
		const docFiles = filesBlockOf(RENDERER_SRC, "DOC_FILES");
		ok(!(AG in docFiles) && !(ST in docFiles), "§1 neither document is in DOC_FILES (served whatever the flags)");
		const flagged = filesBlockOf(RENDERER_SRC, "FLAGGED_DOC_FILES");
		eq(flagged, FILES, "§1 FLAGGED_DOC_FILES maps each document to its template");
		// The agreement's profile path (plan C PR 3) is scripts/test-owner-operator-onboarding.js §3's subject.
		ok(/owner_operator_agreement: \{ file: "owner-operator-agreement\.html", flag: "onboarding", profilePath: true \}/.test(RENDERER_SRC) &&
			/owner_operator_settlement: \{ file: "owner-operator-settlement\.html", flag: "settlements", profilePath: false \}/.test(RENDERER_SRC),
		"§1 the agreement sits behind ONBOARDING and the statement behind SETTLEMENTS");
		const audit = read(AUDIT_PATH);
		eq(filesBlockOf(audit, "FLAGGED_DOC_FILES"), flagged, "§1 scripts/audit-policy-labels.js mirrors FLAGGED_DOC_FILES");
		eq(filesBlockOf(audit, "DOC_FILES"), docFiles, "§1 its DOC_FILES mirror is unchanged");
		// scripts/test-pdf-cold-start.js derives each key from its file name and skips an unknown one.
		for (const [key, file] of Object.entries(FILES)) eq(file.slice(0, -5).replace(/-/g, "_"), key, `§1 ${key}'s file name gives its key`);
		// A refused render opens no page.
		const rec = recorder();
		const SR = loadRenderer(RENDERER_SRC, rec);
		const off = await withEnvAsync({}, () => rendering(SR, AG, AGREEMENT_SIGNED));
		const offSt = await withEnvAsync({}, () => rendering(SR, ST, {}));
		ok(off.error && /^Unknown onboarding doc: owner_operator_agreement$/.test(off.error.message) && offSt.error && rec.docs.length === 0,
			"§1 with the flags off a render is refused before any page opens");
	});

	// ── §2 labels ────────────────────────────────────────────────────────────
	await part("§2 labels", () => {
		const cases = [[AG, T.ownerOperatorAgreementFields(AGREEMENT_SIGNED), AG_LABELS], [ST, T.ownerOperatorSettlementFields({}), ST_LABELS]];
		for (const [key, fields, labels] of cases) {
			const html = template(key);
			const inTemplate = ariaLabels(html);
			eq(Object.keys(fields.text), labels, `§2 ${key}: the map fills exactly its ${labels.length} labels`);
			eq(sorted(uniq(inTemplate)), sorted(labels), `§2 ${key}: the template carries exactly those labels`);
			eq(sorted(fields.requiredText), sorted(labels), `§2 ${key}: every label is required (an empty value is skipped)`);
			for (const t of fields.tableRows) {
				const body = new RegExp(`<tbody id="${t.tbodyId}">\\s*<tr>([\\s\\S]*?)</tr>`).exec(html);
				ok(Boolean(body), `§2 ${key}: the template has tbody #${t.tbodyId}`);
				const cells = body ? (body[1].match(/class="cell-text"/g) || []).length : -1;
				eq(cells, t.cellCount, `§2 ${key}: #${t.tbodyId}'s row has ${t.cellCount} cells`);
				const table = html.slice(html.lastIndexOf("<table", html.indexOf(`id="${t.tbodyId}"`)), html.indexOf(`id="${t.tbodyId}"`));
				eq((table.match(/<th\b/g) || []).length, t.cellCount, `§2 ${key}: #${t.tbodyId}'s table heads ${t.cellCount} columns`);
				ok(t.rows.every((r) => r.length === t.cellCount), `§2 ${key}: each #${t.tbodyId} row has ${t.cellCount} values`);
			}
		}
		const html = template(AG);
		eq(T.ownerOperatorAgreementFields(AGREEMENT_SIGNED).signatureLabelForImage, "Owner-operator signature", "§2 the drawn signature goes on the owner-operator's line");
		const blocks = {};
		const order = ["carrier", "owner-operator"];
		order.forEach((party, i) => {
			const at = html.indexOf(`data-party="${party}"`);
			const end = i + 1 < order.length ? html.indexOf(`data-party="${order[i + 1]}"`, at) : html.indexOf("</section>", at);
			blocks[party] = at < 0 ? "" : html.slice(at, end);
		});
		for (const [party, labels] of Object.entries(PARTY_LABELS)) {
			eq(sorted(ariaLabels(blocks[party])), sorted(labels), `§2 the ${party} block holds exactly the ${party}'s lines`);
			for (const l of labels) eq(ariaLabels(html).filter((x) => x === l).length, 1, `§2 "${l}" appears once, in its party's block`);
		}
		const audit = spawnSync(process.execPath, [AUDIT_PATH], { encoding: "utf8" });
		ok(audit.status === 0, `§2 scripts/audit-policy-labels.js exits 0 (got ${audit.status}): ${(audit.stdout || "").split("\n").filter((l) => /FAIL|MISSING|absent/.test(l)).join(" | ")}`);
		ok(/ok {4}owner_operator_settlement|note {2}owner_operator_settlement/.test(audit.stdout || "") && /owner_operator_agreement/.test(audit.stdout || ""),
			"§2 the audit covers both documents");
	});

	// ── §3 DRAFT ─────────────────────────────────────────────────────────────
	await part("§3 DRAFT", () => {
		for (const [key, marker] of [[AG, AGT.DRAFT_MARKER], [ST, STT.DRAFT_MARKER]]) {
			ok(/^DRAFT\b/.test(marker), `§3 ${key}: the text module's marker starts with DRAFT`);
			for (const [name, fn] of draftChecks(template(key), marker)) ok(fn(), `§3 ${key}: ${name}`);
			ok(withEnv(ON_BOTH, () => R.prepareTemplateHtml(key, {}).includes(`<p class="draft-banner">${marker}</p>`)), `§3 ${key}: the rendered HTML keeps the banner`);
		}
		const html = template(AG);
		const version = `Form ${AGT.FORM_VERSION} DRAFT (${AGT.FORM_DATE})`;
		ok(html.includes(`<span>${version}</span>`), `§3 the agreement prints "${version}"`);
		ok(html.includes(`content: "${version}, page " counter(page)`), "§3 every page's footer carries the form version and DRAFT");
		const text = bodyText(html);
		ok(!text.includes(AGT.REVIEW_NOTE), "§3 the review note never prints on the form");
		ok(!/note to counsel|question \d|counsel|legal advice|\bLQ\d/i.test(text), "§3 no note to counsel, question or advice line on the form");
		ok(typeof AGT.REVIEW_NOTE === "string" && /counsel/.test(AGT.REVIEW_NOTE), "§3 the review note is kept for the Super Admin page and the sample");
	});

	// ── §4 the agreement's text ──────────────────────────────────────────────
	await part("§4 the agreement's text", () => {
		const oo = require(path.join(ROOT, "lib", "owner-operator.js"));
		const html = template(AG);
		const text = bodyText(html);
		for (const [name, clause] of CLAUSES) ok(text.includes(clause), `§4 the agreement carries the packet's clause: ${name}`);
		ok(text.includes(AGT.ONLY_FEE_SENTENCE), "§4 the company fee is the Carrier's only fee (the text module's sentence)");
		const list = /<ol class="categories" data-charge-back-categories>([\s\S]*?)<\/ol>/.exec(html);
		const items = list ? [...list[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].trim()) : [];
		eq(items, [...AGT.CHARGE_BACK_CATEGORIES.map((c) => c.text), "[other items, each listed]."], "§4 the charge-back list is the exported categories, then counsel's placeholder");
		const keys = AGT.CHARGE_BACK_CATEGORIES.map((c) => c.key);
		eq(uniq(keys).length, keys.length, "§4 each category key is distinct");
		const charge = (category) => oo.ooValidateCharge({ kind: "one_time", category, label: "Made-up repair", reason: "made-up reason", cents: 12000, costRecord: "outside_app", chargeDate: "2026-11-10" }, { categories: keys });
		ok(charge("repairs").ok === true, "§4 a charge in a listed category validates");
		ok(charge("admin_fee").code === "OO_CHARGE_CATEGORY_INVALID" && charge("other").code === "OO_CHARGE_CATEGORY_INVALID",
			"§4 a charge outside the list is refused (counsel's placeholder is no category)");
		eq(AGT.FEE_SCHEDULE, [], "§4 the draft lists no fee beyond the company percentage");
		ok(Object.isFrozen(AGT.FEE_SCHEDULE) && Object.isFrozen(AGT.CHARGE_BACK_CATEGORIES), "§4 the lists can't be changed at run time");
		eq(capitalized(html), sorted(AG_WORDS), "§4 the agreement's capitalized words are its own: no person's or other carrier's name");
		eq(capitalized(template(ST)), sorted(ST_WORDS), "§4 the statement's capitalized words are its own");
		const people = uniq([POLICY_FIELD_MAPS.mobile_policy({}).text["Received by signature"], POLICY_FIELD_MAPS.vehicle_lease({}).text["Lessor printed name"]].filter(Boolean));
		for (const key of [AG, ST]) {
			const h = template(key);
			ok(people.every((p) => !h.includes(p)), `§4 ${key} names none of the people the other documents name`);
			ok(!/<script\b/i.test(h), `§4 ${key} has no script`);
			ok([...h.matchAll(/<link\b[^>]*href="([^"]+)"/g)].every((m) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\b/.test(m[1])), `§4 ${key} loads nothing but the fonts`);
			ok([...h.matchAll(/\ssrc="([^"]*)"/g)].every((m) => m[1] === "{{LOGO_SRC}}"), `§4 ${key} embeds no image but the logo slot`);
			ok(!/<input\b/i.test(h), `§4 ${key} has no input: every value is a span that wraps, so the field wrap has nothing to cut`);
			ok(/\.fill \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/.test(h), `§4 ${key}'s values wrap`);
		}
	});

	// ── §5 the agreement's map ───────────────────────────────────────────────
	await part("§5 the agreement's map", () => {
		const oo = require(path.join(ROOT, "lib", "owner-operator.js"));
		const f = T.ownerOperatorAgreementFields(AGREEMENT_SIGNED);
		eq(pick(f.text, ["Company fee percent", "Escrow weekly amount", "Escrow target", "Weekly insurance", "Weekly ELD service", "Onboarding total", "Weekly installment"]),
			{ "Company fee percent": "18", "Escrow weekly amount": "$500.00", "Escrow target": "$2,500.00", "Weekly insurance": "$310.00", "Weekly ELD service": "$15.00", "Onboarding total": "$2,950.00", "Weekly installment": "$1,000.00" },
			"§5 Appendix B's terms print to the cent");
		ok(oo.ooWeeklyFromMonthlyCents(134333) === 31000 && oo.ooWeeklyFromMonthlyCents(6500) === 1500, "§5 Schedule B's amounts are the server's monthly x 12 / 52");
		eq(f.tableRows[0].rows, [["Form 2290", "$550.00"], ["IRP registration and plates", "$1,850.00"], ["ELD device", "$300.00"], ["Lettering", "$250.00"]], "§5 Schedule C lists each cost");
		eq(pick(f.text, ["Owner-operator name", "Doing business as", "Truck year", "Truck plate and state", "Truck ownership", "Payment method", "Owner-operator signature", "Owner-operator printed name", "Owner-operator date"]),
			{ "Owner-operator name": "Alex Example", "Doing business as": ", doing business as Example Hauling LLC", "Truck year": "2020", "Truck plate and state": "MU-0000, TX",
				"Truck ownership": "Owned", "Payment method": AGT.PAYMENT_METHOD.ach, "Owner-operator signature": "Alex Example", "Owner-operator printed name": "Alex Example", "Owner-operator date": "November 3, 2026" },
			"§5 the parties, the truck and the payment method print as given");
		eq(f.signatureImage, PNG, "§5 his drawn signature goes with a signed render");
		const preview = T.ownerOperatorAgreementFields(AGREEMENT_PREVIEW);
		ok(preview.signatureImage === null && preview.text["Owner-operator signature"] === "" && preview.text["Owner-operator date"] === "", "§5 before he signs, his lines are blank and no image is placed");
		ok(T.ownerOperatorAgreementFields({ ...AGREEMENT_PREVIEW, signatureImage: PNG }).signatureImage === null, "§5 an image without his signature is not placed");
		eq(T.ownerOperatorAgreementFields({ ...AGREEMENT_SIGNED, installmentCents: 0 }).text["Weekly installment"], AGT.INSTALLMENT_UNSET, "§5 an installment of 0 prints as left blank");
		eq(T.ownerOperatorAgreementFields({ ...AGREEMENT_SIGNED, businessName: "" }).text["Doing business as"], "", "§5 no business name, no \"doing business as\"");
		eq(["1800", "1850", "1825", "1000", "2500"].map((b) => T.ooFeePercentText(Number(b))), ["18", "18.5", "18.25", "10", "25"], "§5 the fee prints in percent, trailing zeros dropped");
		eq([0, 123456, -2375, 1.5, "100", null].map((c) => T.ooMoneyText(c)), ["$0.00", "$1,234.56", "-$23.75", "", "", ""], "§5 money prints to the cent, and nothing for a non-cent value");
		for (const [name, fn] of agreementCases(T)) ok(holds(fn), `§5 ${name}`);
		ok(Object.values(T.ownerOperatorAgreementFields({}).text).every((v) => v === ""), "§5 a blank preview renders with every slot empty");
		const served = onlyServerAmounts(f, AGREEMENT_SIGNED);
		ok(served.ok, `§5 every amount printed is a server figure (extra: ${served.extra.join(", ")})`);
		eq(T.AGREEMENT_READY_LABELS.filter((l) => !AG_LABELS.includes(l)), [], "§5 every term he must have before signing is a label of the form");
		eq(AG_LABELS.filter((l) => !T.AGREEMENT_READY_LABELS.includes(l) && !/^Owner-operator (signature|printed name|date)$/.test(l)), ["Doing business as", "Truck unit number"],
			"§5 only the business name and the unit number may be blank when he signs");
	});

	// ── §6 fee rules ─────────────────────────────────────────────────────────
	await part("§6 fee rules", () => {
		for (const [name, fn] of feeCases(T)) ok(holds(fn), `§6 ${name}`);
		const T2 = compileAt(MAPS_PATH, MAPS_SRC, { "./owner-operator-agreement-text": withFormFee(TEXT) });
		for (const [name, fn] of scheduledFeeCases(T2)) ok(holds(fn), `§6 ${name}`);
		ok(scheduledFeeCases(T).slice(0, 1).every(([, fn]) => !holds(fn)), "§6 with the draft's empty schedule even an otherwise good fee line is refused");
	});

	// ── §7 the statement's map ───────────────────────────────────────────────
	await part("§7 the statement's map", () => {
		const { w1, w2 } = appendixB();
		ok(w1.ok && w2.ok, "§7 lib/owner-operator.js builds Appendix B's weeks 1 and 2");
		for (const [name, fn] of statementCases(T)) ok(holds(fn), `§7 ${name}`);
		eq(STT.HELD.investor_ledger, "On an investor's ledger, not paid", "§7 the held wording is the plan's");
	});

	// ── §8 render on a stand-in page ─────────────────────────────────────────
	await part("§8 render on a stand-in page, field wrap off and on", async () => {
		const { w1 } = appendixB();
		const stData = statementData(w1, { beforeCents: 295000, installmentCents: 100000, leftCents: 195000 });
		const LONG = {
			...AGREEMENT_SIGNED,
			fullName: "Alexandria Quinn Examplesworth-Madeupington",
			signatureText: "Alexandria Quinn Examplesworth-Madeupington",
			businessName: "Examplesworth Madeupington Long Haul Transport and Logistics LLC",
			address: "48210 Made-Up Industrial Parkway, Building 12, Suite 1200, Testville, TX 00000",
			registeredOwner: "Examplesworth Madeupington Equipment Leasing Company LLC",
		};
		for (const wrap of [undefined, "true"]) {
			const tag = wrap ? "wrap on" : "wrap off";
			for (const [key, data] of [[AG, AGREEMENT_SIGNED], [AG, LONG], [AG, AGREEMENT_PREVIEW], [ST, stData], [ST, {}]]) {
				const rec = recorder();
				const SR = loadRenderer(RENDERER_SRC, rec);
				const env = { ...ON_BOTH, ...(wrap ? { POLICY_FIELD_WRAP_ENABLED: wrap } : {}) };
				const r = await withEnvAsync(env, () => rendering(SR, key, data));
				const asked = Object.entries(T[key === AG ? "ownerOperatorAgreementFields" : "ownerOperatorSettlementFields"](data).text).filter(([, v]) => v !== "").map(([l]) => l);
				const report = rec.results[0] || {};
				const label = `${key} (${data === LONG ? "long values" : data === AGREEMENT_PREVIEW ? "preview" : Object.keys(data).length ? "filled" : "blank"}), ${tag}`;
				ok(r.error === null && r.pdf && r.pdf.length > 0, `§8 ${label}: renders (${r.error && r.error.message})`);
				ok(asked.every((l) => (report.verified || []).includes(l)) && (report.mismatched || []).length === 0 && (report.missed || []).length === 0,
					`§8 ${label}: every value given reaches its slot (missed ${JSON.stringify(report.missed)}, mismatched ${JSON.stringify(report.mismatched)})`);
				const wrapRan = rec.results.some((x) => x && Array.isArray(x.clipped));
				ok(wrap ? wrapRan && rec.results.find((x) => x && Array.isArray(x.clipped)).clipped.length === 0 : !wrapRan,
					`§8 ${label}: the wrap step ${wrap ? "runs and cuts nothing" : "does not run"}`);
				ok(rec.closed === 1, `§8 ${label}: the page is closed`);
			}
		}
		for (const [key, data, slot] of [[AG, AGREEMENT_SIGNED, "Company fee percent"], [ST, stData, "Net settlement"]]) {
			const rec = recorder(dropSlot(slot));
			const r = await withEnvAsync(ON_BOTH, () => rendering(loadRenderer(RENDERER_SRC, rec), key, data));
			ok(r.error && r.error.code === "DOCUMENT_FIELDS_UNFILLED" && r.error.message.includes(slot), `§8 ${key}: a template that lost "${slot}" is refused`);
		}
	});

	// ── §9 mutants ───────────────────────────────────────────────────────────
	await part("§9 mutants", async () => {
		const flips = (cases) => cases.some(([, fn]) => !holds(fn));
		const renderer = (pairs) => loadRenderer(mutate(RENDERER_SRC, pairs), recorder());
		// The gate since plan C PR 3 also opens the agreement for the server's existing-profile
		// path (scripts/test-owner-operator-onboarding.js §3); these mutants remove the flag half.
		const gateLine = "return ooFlagsFromEnv(env)[flagged.flag] === true || profileOpens ? flagged.file : null;";
		ok(flips(gateCases(renderer([[gateLine, "return flagged.file;"]]))), "§9 the gate removed: §1 fails");
		ok(flips(gateCases(renderer([["owner_operator_agreement: { file: \"owner-operator-agreement.html\", flag: \"onboarding\", profilePath: true }",
			"owner_operator_agreement: { file: \"owner-operator-agreement.html\", flag: \"settlements\", profilePath: true }"]]))), "§9 the agreement behind the wrong flag: §1 fails");
		ok(flips(gateCases(renderer([["\tif (!docFileFor(docKey, process.env, options)) throw new Error(`Unknown onboarding doc: ${docKey}`);\n\tconst mapper", "\tconst mapper"]]))),
			"§9 the field map left ungated: §1 fails");
		ok(flips(gateCases(renderer([["DOC_FILES[docKey]) return DOC_FILES[docKey];", "DOC_FILES[docKey]) return DOC_FILES[docKey];\n\tif (FLAGGED_DOC_FILES[docKey]) return FLAGGED_DOC_FILES[docKey].file;"]]))),
			"§9 the flagged documents served whatever the flags: §1 fails");

		// A required label dropped from the map: the lost slot would render unnoticed.
		const realMaps = require(path.join(ROOT, "lib", "policy-field-maps.js"));
		const loose = { ...realMaps, [AG]: (d) => { const f = realMaps[AG](d); return { ...f, requiredText: f.requiredText.filter((l) => l !== "Company fee percent") }; } };
		ok(await requiredHolds(realMaps), "§9 control: with the real map every label is required and a lost slot is refused");
		ok(!(await requiredHolds(loose)), "§9 the fee left out of requiredText: §2 and §8 fail");

		// DRAFT taken out of each template, in turn.
		for (const [key, marker] of [[AG, AGT.DRAFT_MARKER], [ST, STT.DRAFT_MARKER]]) {
			const html = template(key);
			const noBanner = html.replace(`<p class="draft-banner">${marker}</p>`, "");
			const noTop = html.replace(`content: "${marker}";`, "content: \"\";");
			const noTitle = html.replace(/<title>DRAFT — /, "<title>");
			for (const [what, h] of [["banner", noBanner], ["page top", noTop], ["title", noTitle]]) {
				ok(h !== html && draftChecks(h, marker).some(([, fn]) => !fn()), `§9 ${key} without its DRAFT ${what}: §3 fails`);
			}
		}

		const maps = (pairs, overrides = {}) => compileAt(MAPS_PATH, mutate(MAPS_SRC, pairs), overrides);
		ok(flips(agreementCases(maps([["const bad = agreementTermErrors(data);", "const bad = [];"]]))), "§9 term checks removed: §5 fails");
		ok(flips(agreementCases(maps([["\tif (signed) {\n\t\tconst missing", "\tif (false) {\n\t\tconst missing"]]))), "§9 the signing check removed: §5 fails");
		ok(flips(agreementCases(maps([["ooValidateEscrowTerms({ targetCents: data.escrowTargetCents, weeklyCents: data.escrowWeeklyCents })", "null"]]))),
			"§9 the escrow check removed: §5 fails");
		ok(flips(agreementCases(maps([["rows.reduce((s, c) => s + c.cents, 0) !== data.onboardingTotalCents", "false"]]))), "§9 the total check removed: §5 fails");
		ok(flips(feeCases(maps([["\tconst feeError = statementFeeError(data, lines);\n\tif (feeError) throw feeError;", ""]]))), "§9 the fee rules removed: §6 fails");
		ok(flips(feeCases(maps([["fee.cents === -ooFeeCents(fee.baseCents, data.feeBps) &&", ""]]))), "§9 the fee amount check removed: §6 fails");
		ok(flips(feeCases(maps([["&& (!given(totals.loadCents) || totals.loadCents === fee.baseCents)", ""]]))), "§9 the load-pay base check removed: §6 fails");
		ok(flips(feeCases(maps([["if (feeLines.length > 1 || feeLines.some((l) => l.ref !== \"fee\")) {", "if (false) {"]]))), "§9 one company fee line not enforced: §6 fails");
		ok(flips(feeCases(maps([[".filter((k) => typeof k === \"string\" && formFees.has(k))", ".filter((k) => typeof k === \"string\")"]]))), "§9 the form's schedule ignored: §6 fails");
		const formFee = { "./owner-operator-agreement-text": withFormFee(TEXT) };
		ok(flips(scheduledFeeCases(maps([["|| line.lineDate < data.weekStart", ""]], formFee))), "§9 the back-dating check removed: §6 fails");
		ok(flips(scheduledFeeCases(maps([["if (line.kind !== \"one_time\" || !signedFees.has(line.scheduleFee)) {", "if (false) {"]], formFee))), "§9 the signed schedule ignored: §6 fails");
		ok(flips(statementCases(maps([["\"Bank on file\": said(data.bankOnFile),", "\"Bank on file\": said(data.bankOnFile) + \" \" + ooMoneyText(of(RECEIPT_KINDS).reduce((s, l) => s + l.cents, 0)),"]]))),
			"§9 the map adds a figure of its own: §7 fails");
		ok(flips(statementCases(maps([["if (line.filedByOffice === true) parts.push(STATEMENT.FILED_BY_OFFICE);", ""]]))), "§9 office-filed lines unmarked: §7 fails");
		ok(flips(statementCases(maps([["own(STATEMENT.HELD, h.reason) ? STATEMENT.HELD[h.reason] : STATEMENT.HELD_OTHER", "said(h.investorName) || STATEMENT.HELD_OTHER"]]))),
			"§9 a held item printed with its investor: §7 fails");
		ok(flips(statementCases(maps([["\t\tsaid(l.from),\n\t\tsaid(l.to),", "\t\tsaid(l.from) + said(l.customer),\n\t\tsaid(l.to),"]]))), "§9 a customer name printed: §7 fails");
	});

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) {
		for (const f of failures) console.log(`  FAIL ${f}`);
		process.exit(1);
	}
})();

// §2 and §8 for a field-maps module: every label required, and a lost slot refused.
async function requiredHolds(maps) {
	const f = maps[AG](AGREEMENT_SIGNED);
	const allRequired = JSON.stringify(sorted(f.requiredText)) === JSON.stringify(sorted(AG_LABELS));
	const rec = recorder(dropSlot("Company fee percent"));
	const r = await withEnvAsync(ON_BOTH, () => rendering(loadRenderer(read(RENDERER_PATH), rec, { "./policy-field-maps": maps }), AG, AGREEMENT_SIGNED));
	return allRequired && Boolean(r.error) && r.error.code === "DOCUMENT_FIELDS_UNFILLED";
}

// §3: the DRAFT marks a template must carry.
function draftChecks(html, marker) {
	return [
		["the header's first line is the DRAFT banner", () => /<main class="document">\s*<p class="draft-banner">([^<]*)<\/p>/.exec(html)?.[1] === marker],
		["every printed page's top carries the marker", () => new RegExp(`@top-center \\{\\s*content: "${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}";`).test(html)],
		["every printed page's footer says DRAFT", () => /@bottom-center \{\s*content: "[^"]*DRAFT[^"]*"/.test(html)],
		["the title says DRAFT", () => /<title>DRAFT — [^<]+<\/title>/.test(html)],
	];
}
// The text module with one made-up fee on the form's schedule.
function withFormFee(TEXT) {
	return {
		...TEXT,
		OWNER_OPERATOR_AGREEMENT_TEXT: Object.freeze({
			...TEXT.OWNER_OPERATOR_AGREEMENT_TEXT,
			FEE_SCHEDULE: Object.freeze([Object.freeze({ key: "made_up_fee", text: "a made-up service fee" })]),
		}),
	};
}
