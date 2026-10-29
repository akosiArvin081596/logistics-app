#!/usr/bin/env node
/**
 * The deny list's start line: every start of the rate-con driver-instructions runtime
 * (lib/driver-instructions-runtime.js create(), which server.js calls at the top level in
 * every mode) logs exactly one line saying how many deny values it loaded, whatever the
 * flags. It is the check before any rate-con flag goes on: the running app reports the
 * deny list is loaded, as a count only.
 *
 *   §1 set, flags off: "[driver-instructions] deny list: 2 value(s) loaded"
 *   §2 unset or blank, flags off: "[driver-instructions] deny list: not set (0 values)"
 *   §3 partly unusable: "... 1 value(s) loaded, 1 ignored (unusable: ...)", and every
 *      entry unusable: "... 0 value(s) loaded, 2 ignored (unusable: ...)"; one line, so
 *      no second line about the ignored entries
 *   §4 flags on: the same one line beside the existing warnings; the retired name's
 *      warning is kept
 *   §5 the count is the parsing every check uses (lib/driver-instructions.js
 *      parseDenyList()): a value written twice counts once
 *   §6 server.js calls create() at the top level, so the line logs on every start
 *   §7 two lists with the same counts but different values (other digits, other lengths)
 *      log the same lines word for word, at every level: nothing logged depends on a
 *      value, so no digit count, length, hash or prefix of one can appear, on any line
 *
 * In every case: no digit run of any made-up value, and no value's digit count, appears in
 * any captured log line at any level. Every value here is made up.
 *
 * DI_RUNTIME_LIB=<file> runs it against another copy of the runtime; SERVER_JS=<file>
 * against another copy of server.js. In-memory SQLite; no network, never touches app.db.
 * Run: node scripts/test-driver-instructions-deny-count.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const RUNTIME = process.env.DI_RUNTIME_LIB ? path.resolve(process.env.DI_RUNTIME_LIB) : path.join(ROOT, "lib", "driver-instructions-runtime.js");
const rt = require(RUNTIME);
const di = require(path.join(ROOT, "lib", "driver-instructions.js"));
const SERVER_SRC = require("./lib/server-source").serverSource();

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log(`\n${t}`); }

const SETTING = "CARRIER_ACCOUNT_NUMBERS_DENY_SECRET";
const RETIRED = "CARRIER_ACCOUNT_NUMBERS_DENY";
const PREFIX = "[driver-instructions] deny list:";
const UNUSABLE = "ignored (unusable: fewer than 5 or more than 20 digits)";

// Made-up values only. Two usable, two unusable (too few digits, too many).
const USABLE_A = "T-0000000";
const USABLE_B = "12-345-678";
const SHORT = "T-4321";
const LONG = "9876543210987654321012";
const ALL_VALUES = [USABLE_A, USABLE_B, SHORT, LONG];

// Every digit run of every made-up value, each value's digits joined and its last four,
// and each value's digit count when it has two digits: none may appear in a log line.
const FORBIDDEN = (() => {
	const out = new Set();
	for (const v of ALL_VALUES) {
		for (const run of v.match(/\d+/g) || []) out.add(run);
		const digits = v.replace(/\D/g, "");
		out.add(digits);
		out.add(digits.slice(-4));
		if (digits.length > 9) out.add(String(digits.length));
	}
	return [...out];
})();
// A one-digit count ("7 digits") is checked by its wording, and the words a length, hash
// or prefix would come with.
const LENGTHS = [...new Set(ALL_VALUES.map((v) => v.replace(/\D/g, "").length))];
function leaksIn(line) {
	const found = FORBIDDEN.filter((f) => new RegExp(`(^|\\D)${f}(\\D|$)`).test(line));
	for (const n of LENGTHS) if (new RegExp(`(^|\\D)${n}\\s*-?\\s*digits?\\b`, "i").test(line)) found.push(`a digit count (${n})`);
	if (/\blength\b|\bhash\b|\bprefix\b|sha256|\blast ?4\b|\bends? (in|with)\b|\bstarts? with\b/i.test(line)) found.push("a length, hash or prefix");
	return found;
}

// A fresh runtime start over an in-memory database, capturing every log level.
function start(env) {
	const logs = [];
	const cap = (level) => (...a) => logs.push({ level, text: a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") });
	const db = new Database(":memory:");
	try {
		rt.create({
			db,
			env: { ...env },
			log: { log: cap("log"), info: cap("info"), warn: cap("warn"), error: cap("error"), debug: cap("debug") },
			now: () => Date.parse("2026-10-22T12:00:00Z"),
			fetch: async () => { throw new Error("no network in this runner"); },
		});
	} finally {
		db.close();
	}
	return logs;
}
const denyLines = (logs) => logs.filter((l) => l.text.includes(PREFIX));
function checkStart(label, env, expectedText, expectedLevel) {
	const logs = start(env);
	const lines = denyLines(logs);
	eq(lines.length, 1, `${label}: exactly one deny-list line`);
	eq(lines[0] ? lines[0].text : null, expectedText, `${label}: the line reads`);
	eq(lines[0] ? lines[0].level : null, expectedLevel, `${label}: logged at`);
	eq(logs.filter((l) => leaksIn(l.text).length).map((l) => `${l.level} ${l.text} -> ${leaksIn(l.text).join(", ")}`), [], `${label}: no log line at any level holds a digit run, digit count, length, hash or prefix of a value`);
	eq(logs.filter((l) => /value\(s\) ignored/.test(l.text) && !l.text.includes(PREFIX)).length, 0, `${label}: no second line about ignored entries`);
	return logs;
}

const FLAGS_OFF = { RATECON_DRIVER_INSTRUCTIONS_ENABLED: "", DRIVER_LOAD_INSTRUCTIONS_SCREEN_ENABLED: "" };
const FLAGS_ON = { RATECON_DRIVER_INSTRUCTIONS_ENABLED: "true", DRIVER_LOAD_INSTRUCTIONS_SCREEN_ENABLED: "true" };

section("§1 set, flags off: one line with the count");
checkStart("§1 two usable values", { ...FLAGS_OFF, [SETTING]: `${USABLE_A}, ${USABLE_B}` }, `${PREFIX} 2 value(s) loaded`, "log");
checkStart("§1 one usable value, no flag named at all", { [SETTING]: USABLE_B }, `${PREFIX} 1 value(s) loaded`, "log");
checkStart("§1 semicolon and newline separators", { ...FLAGS_OFF, [SETTING]: `${USABLE_A};\n${USABLE_B}` }, `${PREFIX} 2 value(s) loaded`, "log");

section("§2 unset or blank, flags off: one line saying not set");
checkStart("§2 unset", { ...FLAGS_OFF }, `${PREFIX} not set (0 values)`, "log");
checkStart("§2 empty", { ...FLAGS_OFF, [SETTING]: "" }, `${PREFIX} not set (0 values)`, "log");
checkStart("§2 only separators and spaces", { ...FLAGS_OFF, [SETTING]: " , ;  " }, `${PREFIX} not set (0 values)`, "log");

section("§3 partly or wholly unusable: loaded and ignored counted on the one line");
checkStart("§3 one usable, one too short", { ...FLAGS_OFF, [SETTING]: `${USABLE_A}, ${SHORT}` }, `${PREFIX} 1 value(s) loaded, 1 ${UNUSABLE}`, "warn");
checkStart("§3 two usable, two unusable", { ...FLAGS_OFF, [SETTING]: `${SHORT}, ${USABLE_A}, ${LONG}, ${USABLE_B}` }, `${PREFIX} 2 value(s) loaded, 2 ${UNUSABLE}`, "warn");
checkStart("§3 every entry unusable", { ...FLAGS_OFF, [SETTING]: `${SHORT}, ${LONG}` }, `${PREFIX} 0 value(s) loaded, 2 ${UNUSABLE}`, "warn");

section("§4 flags on: the same one line beside the existing warnings");
checkStart("§4 set", { ...FLAGS_ON, [SETTING]: `${USABLE_A}, ${USABLE_B}` }, `${PREFIX} 2 value(s) loaded`, "log");
{
	const logs = checkStart("§4 unset", { ...FLAGS_ON }, `${PREFIX} not set (0 values)`, "log");
	eq(logs.filter((l) => l.text.includes(`${SETTING} is not set`)).length, 1, "§4 unset with the flag on: the existing warning that the flags are treated as off is kept");
}
checkStart("§4 partly unusable", { ...FLAGS_ON, [SETTING]: `${USABLE_B}, ${SHORT}` }, `${PREFIX} 1 value(s) loaded, 1 ${UNUSABLE}`, "warn");
{
	const logs = checkStart("§4 retired name set, new name unset", { ...FLAGS_ON, [RETIRED]: USABLE_A }, `${PREFIX} not set (0 values)`, "log");
	eq(logs.filter((l) => l.text.includes(`${RETIRED} is ignored`)).length, 1, "§4 the retired name's warning is kept, once");
	const both = checkStart("§4 retired name and new name set, flags off", { ...FLAGS_OFF, [RETIRED]: USABLE_B, [SETTING]: USABLE_A }, `${PREFIX} 1 value(s) loaded`, "log");
	eq(both.filter((l) => l.text.includes(`${RETIRED} is ignored`)).length, 1, "§4 the retired name's warning still logs with the flags off");
}

section("§5 the count is the parsing every check uses");
{
	const value = `${USABLE_A}, T 0000000, ${USABLE_B}, ${SHORT}`;
	const parsed = di.parseDenyList(value);
	eq([parsed.values.length, parsed.ignored], [2, 1], "§5 parseDenyList: a value written twice counts once");
	checkStart("§5 a duplicate", { ...FLAGS_OFF, [SETTING]: value }, `${PREFIX} ${parsed.values.length} value(s) loaded, ${parsed.ignored} ${UNUSABLE}`, "warn");
	const cfg = rt.readConfig({ ...FLAGS_ON, [SETTING]: value });
	eq([cfg.denyConfigured, cfg.denyIgnored], [true, 1], "§5 readConfig agrees with the line");
}

section("§6 server.js calls create() at the top level, on every start");
{
	const needle = '\nconst driverInstructions = require("./lib/driver-instructions-runtime").create({';
	eq(SERVER_SRC.split(needle).length - 1, 1, "§6 one top-level create() call, outside any mode check");
}

section("§7 the start lines depend on the counts only, never on the values");
for (const [a, b] of [[`${USABLE_A}, ${USABLE_B}`, "55555, 77777777777777777777"], [`${USABLE_A}, ${SHORT}`, "1234567890123, 9"]]) {
	const lines = (v) => start({ ...FLAGS_ON, [SETTING]: v }).map((l) => `${l.level} ${l.text}`);
	eq(lines(b), lines(a), "§7 two lists with the same counts log the same lines, word for word");
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
	for (const f of failures) console.log(`  FAIL ${f}`);
	process.exit(1);
}
