#!/usr/bin/env node
/**
 * The payout bank's routing and account numbers printed in the broker
 * invoice's "Payment Method" block are settings, INVOICE_BANK_ROUTING and
 * INVOICE_BANK_ACCOUNT, with no default in code. Production's .env names them;
 * anywhere else the slot prints "Bank details not set".
 *
 *   §1 rendering: buildInvoiceHtml() prints each setting in its slot, trimmed
 *      and escaped like every other field, reading the environment at each
 *      call (no restart, no cache). Unset or blank, the slot prints exactly
 *      "Bank details not set"; one setting missing leaves the other slot as it
 *      is. The rest of the block (name, bank name, address, e-mail) is the same
 *      in every case, and the document with the settings unset differs from
 *      the one with them set in those two slots only.
 *   §2 source: PAYMENT_METHOD holds no bank number (no run of six or more
 *      digits, no routing or account key); missingInvoiceBankSettings() names
 *      what is unset or blank; server.js warns once at module scope ([invoice-
 *      bank], setting names only) and nothing in it refuses a draft for these
 *      settings; .env.example names both, commented out, with no value.
 *   §3 replica: lib/replica-rules.js never copies either setting off the
 *      server, whatever the app reads, and a replica's settings file may not
 *      hold one; scripts/replica/remote/settings.js leaves both out of the
 *      exported file.
 *
 * Obvious test values only (000000000 / 0000000000), so nothing here depends
 * on production's settings. The booted server's [invoice-bank] warning
 * is checked in scripts/test-no-production-defaults.js §2.
 * Plain node, no server, no network.
 *   node scripts/test-invoice-bank-settings.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
const replicaRules = require(path.join(ROOT, "lib", "replica-rules.js"));
const { exportSettings } = require(path.join(ROOT, "scripts", "replica", "remote", "settings.js"));

const NAMES = ["INVOICE_BANK_ROUTING", "INVOICE_BANK_ACCOUNT"];
const TEST = Object.freeze({ INVOICE_BANK_ROUTING: "000000000", INVOICE_BANK_ACCOUNT: "0000000000" });
const OTHER = Object.freeze({ INVOICE_BANK_ROUTING: "000000001", INVOICE_BANK_ACCOUNT: "0000000002" });
const NOT_SET = "Bank details not set";

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

// Runs fn with exactly `values` for the two settings (a missing key is unset).
function withBankEnv(values, fn) {
	const saved = NAMES.map((k) => [k, process.env[k]]);
	for (const k of NAMES) {
		if (values[k] === undefined) delete process.env[k];
		else process.env[k] = values[k];
	}
	try {
		return fn();
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

const FIXTURE = Object.freeze({
	invoiceId: "BANK-TEST-1",
	invoiceDate: "09/30/2026",
	brokerName: "Acme Freight",
	invoiceTo: Object.freeze({ name: "Acme Freight", email: "ap@example.test" }),
	orderNumber: "ORD-1",
	poNumber: "",
	deliveryDate: "09/29/2026",
	total: "$1,500.00",
});
const render = (values) => withBankEnv(values, () => brokerInvoice.buildInvoiceHtml(FIXTURE));
const routingLine = (v) => `<div><strong>Bank Routing #:</strong> ${v}</div>`;
const accountLine = (v) => `<div><strong>Bank Account #:</strong> ${v}</div>`;
const count = (hay, needle) => hay.split(needle).length - 1;
// The Payment Method block's other four lines, as today.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const PM = brokerInvoice.PAYMENT_METHOD;
const FIXED_LINES = [
	`<div><strong>Name:</strong> ${esc(PM.name)}</div>`,
	`<div><strong>Bank Name:</strong> ${esc(PM.bankName)}</div>`,
	`<div><strong>Address:</strong> ${esc(PM.address)}</div>`,
	`<div><strong>E-mail:</strong> ${esc(PM.email)}</div>`,
];

function renderingSection() {
	section("§1 rendering");
	const unset = render({});
	ok(unset.includes(routingLine(NOT_SET)), "§1 unset: the routing slot prints \"Bank details not set\"");
	ok(unset.includes(accountLine(NOT_SET)), "§1 unset: the account slot prints \"Bank details not set\"");
	eq(count(unset, NOT_SET), 2, "§1 unset: the text appears in those two slots and nowhere else");

	for (const [label, blank] of [["empty", ""], ["spaces and a tab", "  \t "], ["a newline", "\n"]]) {
		const html = render({ INVOICE_BANK_ROUTING: blank, INVOICE_BANK_ACCOUNT: blank });
		eq(html, unset, `§1 blank (${label}): byte-identical to unset`);
	}

	const set = render(TEST);
	ok(set.includes(routingLine(TEST.INVOICE_BANK_ROUTING)), "§1 set: the routing slot prints INVOICE_BANK_ROUTING");
	ok(set.includes(accountLine(TEST.INVOICE_BANK_ACCOUNT)), "§1 set: the account slot prints INVOICE_BANK_ACCOUNT");
	ok(!set.includes(NOT_SET), "§1 set: \"Bank details not set\" is not printed");
	eq(render({ INVOICE_BANK_ROUTING: ` ${TEST.INVOICE_BANK_ROUTING}\n`, INVOICE_BANK_ACCOUNT: `\t${TEST.INVOICE_BANK_ACCOUNT} ` }), set,
		"§1 set with edge spaces: trimmed, byte-identical to the bare values");

	const onlyRouting = render({ INVOICE_BANK_ROUTING: TEST.INVOICE_BANK_ROUTING });
	ok(onlyRouting.includes(routingLine(TEST.INVOICE_BANK_ROUTING)) && onlyRouting.includes(accountLine(NOT_SET)),
		"§1 only INVOICE_BANK_ROUTING set: routing printed, account slot \"Bank details not set\"");
	const onlyAccount = render({ INVOICE_BANK_ACCOUNT: TEST.INVOICE_BANK_ACCOUNT });
	ok(onlyAccount.includes(routingLine(NOT_SET)) && onlyAccount.includes(accountLine(TEST.INVOICE_BANK_ACCOUNT)),
		"§1 only INVOICE_BANK_ACCOUNT set: routing slot \"Bank details not set\", account printed");

	// Read at each call: the same loaded module follows the environment.
	const seq = [TEST, OTHER, {}, TEST].map((v) => render(v));
	ok(seq[0].includes(routingLine(TEST.INVOICE_BANK_ROUTING)) && seq[1].includes(routingLine(OTHER.INVOICE_BANK_ROUTING))
		&& seq[1].includes(accountLine(OTHER.INVOICE_BANK_ACCOUNT)) && seq[2].includes(routingLine(NOT_SET)) && seq[3] === set,
		"§1 read at each call: set, changed, unset, set again, each render follows the environment");

	// Escaped like every other field.
	const odd = render({ INVOICE_BANK_ROUTING: "<b>&\"'", INVOICE_BANK_ACCOUNT: "12 34" });
	ok(odd.includes(routingLine("&lt;b&gt;&amp;&quot;&#39;")) && !odd.includes("<b>&\"'"), "§1 a set value is HTML-escaped");
	ok(odd.includes(accountLine("12 34")), "§1 a value with an inner space prints as given");

	for (const [label, html] of [["unset", unset], ["set", set], ["one set", onlyRouting]]) {
		ok(FIXED_LINES.every((l) => count(html, l) === 1), `§1 ${label}: name, bank name, address and e-mail print as before`);
	}

	// Only the two slots differ between unset and set.
	const swapped = set
		.replace(routingLine(TEST.INVOICE_BANK_ROUTING), routingLine(NOT_SET))
		.replace(accountLine(TEST.INVOICE_BANK_ACCOUNT), accountLine(NOT_SET));
	eq(swapped === unset, true, "§1 the set and unset documents differ in the two bank slots only");
}

function sourceSection() {
	section("§2 source");
	const lib = readSource("lib/broker-invoice.js");
	const decl = lib.match(/\nconst PAYMENT_METHOD = \{[^}]*\};/);
	ok(decl && lib.split("\nconst PAYMENT_METHOD = ").length === 2, "§2 lib/broker-invoice.js declares PAYMENT_METHOD once");
	if (decl) {
		ok(!/\d{6,}/.test(decl[0]), "§2 PAYMENT_METHOD holds no run of six or more digits");
		ok(!/routing|account/i.test(decl[0]), "§2 PAYMENT_METHOD has no routing or account entry");
	}
	eq(Object.keys(PM).sort(), ["address", "bankName", "email", "name"], "§2 the exported PAYMENT_METHOD carries no bank number");
	eq([...brokerInvoice.INVOICE_BANK_SETTINGS], NAMES, "§2 INVOICE_BANK_SETTINGS names the two settings");
	eq(brokerInvoice.BANK_DETAILS_NOT_SET, NOT_SET, "§2 BANK_DETAILS_NOT_SET is the printed text");
	ok(!/\d{6,}/.test(lib.slice(lib.indexOf("const INVOICE_BANK_SETTINGS"), lib.indexOf("function missingInvoiceBankSettings"))),
		"§2 the settings block holds no run of six or more digits");

	const missing = (env) => brokerInvoice.missingInvoiceBankSettings(env).join(",");
	eq(missing({}), NAMES.join(","), "§2 missingInvoiceBankSettings: none set names both");
	eq(missing({ INVOICE_BANK_ROUTING: TEST.INVOICE_BANK_ROUTING, INVOICE_BANK_ACCOUNT: "  " }), "INVOICE_BANK_ACCOUNT",
		"§2 missingInvoiceBankSettings: a blank one counts as unset");
	eq(missing(TEST), "", "§2 missingInvoiceBankSettings: both set names none");
	eq(withBankEnv(TEST, () => missing(undefined)), "", "§2 missingInvoiceBankSettings: defaults to the process environment");

	const srv = readSource("server.js");
	const warnDecl = "\nconst MISSING_INVOICE_BANK_SETTINGS = brokerInvoice.missingInvoiceBankSettings();\n";
	eq(srv.split(warnDecl).length - 1, 1, "§2 server.js computes the missing settings once, at module scope");
	eq(srv.split("missingInvoiceBankSettings").length - 1, 1, "§2 …and nowhere else, so no route refuses a draft for them");
	ok(!/INVOICE_BANK_(ROUTING|ACCOUNT)/.test(srv.replace(/\/\/[^\n]*/g, "")), "§2 server.js code reads neither setting itself");
	const warnAt = srv.indexOf(warnDecl);
	const warnBlock = warnAt === -1 ? "" : srv.slice(warnAt, srv.indexOf("\n}\n", warnAt) + 3);
	ok(/console\.warn\(\s*`\[invoice-bank\]/.test(warnBlock), "§2 the warning is tagged [invoice-bank]");
	ok(/MISSING_INVOICE_BANK_SETTINGS\.join\(/.test(warnBlock) && !/process\.env/.test(warnBlock),
		"§2 the warning names the settings and never reads a value");

	const example = readSource(".env.example");
	for (const name of NAMES) {
		eq(example.split(`\n# ${name}=\n`).length - 1, 1, `§2 .env.example names ${name} once, commented out, with no value`);
		ok(!new RegExp(`^${name}=`, "m").test(example), `§2 .env.example sets no ${name}`);
	}
	ok(example.includes(`"${NOT_SET}"`), "§2 .env.example says what prints when they are unset");
}

function replicaSection() {
	section("§3 replica");
	eq([...replicaRules.PRODUCTION_ONLY_SETTINGS].sort(), [...NAMES].sort(), "§3 replica-rules' production-only settings are exactly the two bank settings");
	for (const name of NAMES) {
		const plain = replicaRules.classifySetting(name, TEST[name]);
		eq(plain.copy, false, `§3 ${name} is never copied`);
		eq(replicaRules.classifySetting(name, TEST[name], { readByApp: new Set(NAMES) }).copy, false,
			`§3 ${name} is never copied, even if the app read it as process.env.${name}`);
		ok(/production only/.test(plain.rule), `§3 ${name}'s rule says why without its value (${plain.rule})`);
	}
	const parsed = { ...TEST, ROUTEMATE_ENABLED: "true" };
	const out = exportSettings(parsed, { readByApp: new Set([...NAMES, "ROUTEMATE_ENABLED"]) });
	eq(out.copied, ["ROUTEMATE_ENABLED"], "§3 the settings export copies the business setting and neither bank setting");
	ok(!out.text.includes(TEST.INVOICE_BANK_ROUTING) && !out.text.includes(TEST.INVOICE_BANK_ACCOUNT) && !/INVOICE_BANK_/.test(out.text),
		"§3 the exported settings file holds neither name nor value");
	eq(out.skipped.filter((s) => NAMES.includes(s.name)).map((s) => s.name).sort(), [...NAMES].sort(), "§3 both are listed as skipped, by name");
}

// -------------------------------------------------------------------- report
for (const [name, run] of [["§1", renderingSection], ["§2", sourceSection], ["§3", replicaSection]]) {
	try { run(); } catch (e) { failures.push(`${name} threw: ${e && e.stack}`); }
}
console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
