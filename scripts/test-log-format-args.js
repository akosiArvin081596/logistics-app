#!/usr/bin/env node
/**
 * Two server.js log lines that include text a caller supplies keep a fixed
 * message pattern and pass that text as an argument. console.error treats its
 * first argument as a pattern (util.format), so with the text as an argument
 * the method, URL and load id are logged exactly as written, and the error
 * after them in full.
 *
 *   §1 THE FINAL ERROR HANDLER. The method and URL are arguments: a URL
 *      holding those characters is logged exactly as written, followed by the
 *      error's message and stack.
 *   §2 THE DISTANCE LOOKUP FAILURE (POST /api/n8n/load-distance). The load id
 *      is an argument: an id holding those characters is logged exactly as
 *      written, followed by the lookup error; with no load id the line reads
 *      as it always has.
 *
 * WHY server.js IS READ AS TEXT: it opens SQLite and starts listening on
 * import. Every extraction asserts its needle is found exactly once, so a
 * rename fails loudly instead of testing nothing.
 *
 * Plain node, no server, no network, never touches app.db.
 * Run: node scripts/test-log-format-args.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const util = require("util");

const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log(`\n${t}`); }
function countOf(hay, needle) { return hay.split(needle).length - 1; }

// Each console.error call joined the way console.error joins it.
function logged(run) {
	const lines = [];
	run({ error: (...args) => lines.push(util.format(...args)) });
	return lines;
}

// Text that util.format would read as directives if it sat in the pattern.
const DIRECTIVES = "%s%o%d%c%j%%";

function finalHandlerSection() {
	section("§1 the final error handler logs the URL as written");
	const marker = "[unhandled]";
	if (countOf(SRC, marker) !== 1) throw new Error(`expected exactly 1 "${marker}" in server.js`);
	const at = SRC.indexOf(marker);
	const open = "app.use((err, req, res, next) => {";
	const start = SRC.lastIndexOf(open, at);
	const end = SRC.indexOf("\n});", at);
	if (start < 0 || end < 0) throw new Error("final error handler not found");
	const fnText = SRC.slice(start + "app.use(".length, end + 2);
	const url = `/api/loads?q=${DIRECTIVES}`;
	const err = new Error("handler-sentinel");
	const res = { headersSent: false, status() { return this; }, json() { return this; } };
	const lines = logged((con) => new Function("console", `return ${fnText};`)(con)(err, { method: "GET", originalUrl: url }, res, () => {}));
	eq(lines.length, 1, "one line is logged");
	ok(lines[0].includes(`GET ${url}`), "the method and URL are logged exactly as written");
	ok(lines[0].includes(err.stack.split("\n")[1].trim()), "the error's stack follows the URL");
}

function distanceLookupSection() {
	section("§2 the distance lookup failure logs the load id as written");
	const needle = "n8n load-distance: Distance Matrix failed";
	if (countOf(SRC, needle) !== 1) throw new Error(`expected exactly 1 "${needle}" in server.js`);
	const at = SRC.indexOf(needle);
	const start = SRC.lastIndexOf("console.error(", at);
	const end = SRC.indexOf(");\n", at);
	if (start < 0 || end < 0) throw new Error("distance lookup log line not found");
	const log = new Function("console", "loadId", "lookupError", SRC.slice(start, end + 2));
	const id = `LD-77${DIRECTIVES}`;
	let lines = logged((con) => log(con, id, "timeout-sentinel"));
	eq(lines.length, 1, "one line is logged");
	ok(lines[0].includes(`(load ${id})`), "the load id is logged exactly as written");
	ok(lines[0].endsWith(" timeout-sentinel"), "the lookup error follows the load id");
	lines = logged((con) => log(con, "", "timeout-sentinel"));
	eq(lines[0], "n8n load-distance: Distance Matrix failed: timeout-sentinel", "with no load id the line reads as before");
}

for (const [name, run] of [["§1", finalHandlerSection], ["§2", distanceLookupSection]]) {
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
