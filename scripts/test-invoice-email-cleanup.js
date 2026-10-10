#!/usr/bin/env node
/**
 * normalizeEmail() (lib/broker-invoice.js) strips trailing punctuation from a
 * candidate invoice recipient, then checks it is an email address.
 *
 *   §1 SAME OUTPUT. A table of inputs (clean addresses, each kind of trailing
 *      punctuation, punctuation followed by other text, punctuation only,
 *      spaces, tabs and newlines, angle brackets, a character outside the
 *      stripped set, an astral character, non-addresses, empty, null and a
 *      number) gives exactly the results the function gave before its trailing
 *      strip became a loop (captured from it, 2026-10-11). The recipient an
 *      invoice goes to never changes.
 *   §2 LINEAR TIME. 100,000 punctuation characters followed by a letter, with
 *      and without an address in front, are each cleaned in under 250 ms, and
 *      a run ten times longer costs far less than the 100 times a squared cost
 *      would.
 *
 * Plain node, no server, no network, never touches app.db.
 * Run: node scripts/test-invoice-email-cleanup.js
 */
"use strict";

const { normalizeEmail } = require("../lib/broker-invoice");

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log(`\n${t}`); }

// An astral character (two UTF-16 units), built from its code point.
const TRUCK = String.fromCodePoint(0x1f69a);

function sameOutputSection() {
	section("§1 the same result for every input as before");
	const table = [
		["billing@broker.com", "billing@broker.com"],
		["  billing@broker.com  ", "billing@broker.com"],
		["billing@broker.com.", "billing@broker.com"],
		["billing@broker.com.,;>)]", "billing@broker.com"],
		["billing@broker.com)", "billing@broker.com"],
		["billing@broker.com>", "billing@broker.com"],
		["billing@broker.com]]]]", "billing@broker.com"],
		["a.b-c+d@sub.domain.co.uk;", "a.b-c+d@sub.domain.co.uk"],
		["<billing@broker.com>", ""],
		["Billing <billing@broker.com>", ""],
		["billing@broker.com x", ""],
		["billing@broker.com .", ""],
		["billing@broker.c", ""],
		["billing@broker.com.x", ""],
		["billing@broker.com;billing2@broker.com", ""],
		["billing@broker.com.)x", ""],
		["billing@broker.com.!", ""],
		[`billing@broker.com${TRUCK}.`, ""],
		[`billing@broker.com.${TRUCK}`, ""],
		["\tbilling@broker.com)\n", "billing@broker.com"],
		["...", ""],
		[" .;) ", ""],
		["not an email", ""],
		["", ""],
		[null, ""],
		[undefined, ""],
		[12345, ""],
	];
	for (const [input, want] of table) eq(normalizeEmail(input), want, `normalizeEmail(${JSON.stringify(input)})`);
}

function timed(input) {
	const t = process.hrtime.bigint();
	const out = normalizeEmail(input);
	return { out, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}

function linearTimeSection() {
	section("§2 a long run of trailing punctuation costs linear time");
	const run = ".,;>)]".repeat(Math.ceil(100000 / 6)).slice(0, 100000);
	for (const [label, input] of [
		["an address, 100,000 punctuation characters, a letter", "billing@broker.com" + run + "x"],
		["100,000 punctuation characters, a letter", run + "x"],
		["an address and 100,000 trailing punctuation characters", "billing@broker.com" + run],
	]) {
		const { out, ms } = timed(input);
		ok(ms < 250, `${label}: cleaned in ${ms.toFixed(1)} ms (limit 250 ms)`);
		eq(out, label.startsWith("an address and") ? "billing@broker.com" : "", `${label}: result`);
	}
	// 10x the input may cost about 10x, never about 100x.
	const small = timed("a@b.co" + ".".repeat(20000) + "x").ms;
	const large = timed("a@b.co" + ".".repeat(200000) + "x").ms;
	ok(large < Math.max(50, small * 40), `200,000 characters cost ${large.toFixed(1)} ms against ${small.toFixed(1)} ms for 20,000`);
}

for (const [name, run] of [["§1", sameOutputSection], ["§2", linearTimeSection]]) {
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
