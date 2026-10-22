#!/usr/bin/env node
/**
 * scripts/test-listed-accounts.js — lib/listed-accounts.js, the strict reader of
 * RATECON_PDF_VIEWER_IDS (and of any later list of account ids).
 *
 * §1 parsing: absent is "unset"; plain positive whole numbers, comma-separated
 *    with optional spaces, are "valid"; anything else set is "invalid" (empty,
 *    blank, a username, "01", "+1", "1.0", a stray or doubled comma, another
 *    separator, a negative, more than MAX_IDS entries). The problem names the
 *    entry's position, never its text.
 * §2 who is listed: only the session's id, read as a positive whole number;
 *    a username never counts; no usable id is "no-id"; an unset list answers
 *    "unset" and an invalid one "invalid" for everyone.
 * §3 protected changes: unset protects nobody; valid protects listed targets
 *    from anyone but themselves and another listed account; invalid protects
 *    every Super Admin from everyone, and nobody else.
 * §4 logging: fromSetting() logs one warning when unset, one error when
 *    invalid, nothing when valid, and never the setting's text.
 * §5 server.js reads the setting once, at module scope, through fromSetting(),
 *    and hands the same gate to the PDF route.
 *
 * Pure: no server, no database, no network. Every id and name is made up.
 * Run: node scripts/test-listed-accounts.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;
function ok(name, cond) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}`); }
}

let L = null;
try { L = require(path.join(ROOT, "lib", "listed-accounts.js")); } catch (e) { ok(`lib/listed-accounts.js loads (${e.code || e.message})`, false); }
if (!L) { console.log(`\nlisted-accounts: ${passed} passed, ${failed} failed`); process.exit(1); }

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── §1 parsing ──────────────────────────────────────────────────────────────
{
	for (const raw of [undefined, null]) {
		const l = L.parseListedAccountIds(raw);
		ok(`§1 ${String(raw)} is unset`, l.state === "unset" && l.ids.length === 0);
	}
	for (const [raw, ids] of [["1", [1]], ["1,7", [1, 7]], [" 1 , 7 ", [1, 7]], ["7,1,7", [7, 1]], ["123456789", [123456789]]]) {
		const l = L.parseListedAccountIds(raw);
		ok(`§1 ${JSON.stringify(raw)} is valid, ids ${JSON.stringify(ids)}`, l.state === "valid" && same(l.ids, ids));
	}
	const INVALID = ["", "   ", "owner_admin", "1,owner_admin", "1,,7", "1,", ",1", "01", "+1", "1.0", "1e3", "0x1", "1;7", "1 7", "-1", "0", "1234567890", "١"];
	for (const raw of INVALID) {
		const l = L.parseListedAccountIds(raw);
		ok(`§1 ${JSON.stringify(raw)} is invalid`, l.state === "invalid" && l.ids.length === 0);
	}
	const tooMany = Array.from({ length: L.MAX_IDS + 1 }, (_, i) => String(i + 1)).join(",");
	ok(`§1 more than ${L.MAX_IDS} entries is invalid`, L.parseListedAccountIds(tooMany).state === "invalid");
	ok(`§1 exactly ${L.MAX_IDS} entries is valid`, L.parseListedAccountIds(Array.from({ length: L.MAX_IDS }, (_, i) => String(i + 1)).join(",")).state === "valid");
	const named = L.parseListedAccountIds("1,owner_admin");
	ok(`§1 the problem names the entry's position, not its text (${named.problem})`, /entry 2\b/.test(named.problem) && !named.problem.includes("owner_admin"));
	const l = L.parseListedAccountIds("1,7");
	ok("§1 the parsed list cannot be changed afterwards", Object.isFrozen(l) && Object.isFrozen(l.ids));
}

// ── §2 who is listed ────────────────────────────────────────────────────────
{
	const valid = L.parseListedAccountIds("1,7");
	const cases = [
		[{ id: 1, username: "owner_admin" }, "listed"],
		[{ id: "7", username: "second_admin" }, "listed"],
		[{ id: " 7 " }, "listed"],
		[{ id: 5, username: "owner_admin" }, "unlisted"],
		[{ id: 5 }, "unlisted"],
		[{ username: "owner_admin" }, "no-id"],
		[{ id: null }, "no-id"],
		[{ id: 0 }, "no-id"],
		[{ id: -1 }, "no-id"],
		[{ id: 1.5 }, "no-id"],
		[{ id: "1.0" }, "no-id"],
		[{ id: "01" }, "no-id"],
		[{ id: true }, "no-id"],
		[{ id: [1] }, "no-id"],
		[{ id: { valueOf: () => 1 } }, "no-id"],
		[{ id: Number.MAX_SAFE_INTEGER + 2 }, "no-id"],
		[null, "no-id"],
		[undefined, "no-id"],
	];
	for (const [user, want] of cases) {
		const got = valid.verdict(user);
		ok(`§2 list "1,7", session ${JSON.stringify(user)}: ${want} (${got})`, got === want);
	}
	ok("§2 an unset list answers \"unset\" for everyone", ["unset", "unset"].every((w, i) => L.parseListedAccountIds(undefined).verdict([{ id: 1 }, {}][i]) === w));
	ok("§2 an invalid list answers \"invalid\" for everyone, a would-be listed id included",
		L.parseListedAccountIds("owner_admin").verdict({ id: 1, username: "owner_admin" }) === "invalid");
	ok("§2 sessionAccountId reads only plain account ids", L.sessionAccountId({ id: 3 }) === 3 && L.sessionAccountId({ id: "3" }) === 3 && L.sessionAccountId({ id: "x3" }) === null);
	ok("§2 isListedId", valid.isListedId(1) && valid.isListedId("7") && !valid.isListedId(5) && !L.parseListedAccountIds(undefined).isListedId(1));
}

// ── §3 protected changes ────────────────────────────────────────────────────
{
	const SA = "Super Admin";
	const valid = L.parseListedAccountIds("1,7");
	const p = (list, actor, targetId, targetRole = SA) => list.protectedChangeRefusal({ actor, targetId, targetRole });
	ok("§3 valid: an unlisted Super Admin changing listed account 1 is refused (listed)", p(valid, { id: 5 }, 1) === "listed");
	ok("§3 valid: ...also under account 1's username", p(valid, { id: 5, username: "owner_admin" }, 1) === "listed");
	ok("§3 valid: ...and a session with no id", p(valid, { username: "owner_admin" }, 1) === "listed");
	ok("§3 valid: account 1 changing itself goes through", p(valid, { id: 1 }, 1) === null);
	ok("§3 valid: listed account 7 changing account 1 goes through", p(valid, { id: "7" }, 1) === null);
	ok("§3 valid: an unlisted target is not protected", p(valid, { id: 5 }, 6) === null && p(valid, { id: 5 }, "6") === null);
	ok("§3 valid: the target id as digits counts the same", p(valid, { id: 5 }, "1") === "listed");
	ok("§3 valid: a listed target that is not a Super Admin is still protected", p(valid, { id: 5 }, 7, "Dispatcher") === "listed");
	const unset = L.parseListedAccountIds(undefined);
	ok("§3 unset: nobody is protected", p(unset, { id: 5 }, 1) === null && p(unset, {}, 1) === null);
	const invalid = L.parseListedAccountIds("owner_admin");
	ok("§3 invalid: every Super Admin target is refused, for every actor (itself included)", p(invalid, { id: 5 }, 1) === "invalid" && p(invalid, { id: 1 }, 1) === "invalid");
	ok("§3 invalid: a target that is not a Super Admin is not protected", p(invalid, { id: 5 }, 9, "Dispatcher") === null && p(invalid, { id: 5 }, 9, "Driver") === null);
}

// ── §4 logging ──────────────────────────────────────────────────────────────
{
	const logOf = (raw) => {
		const out = { warn: [], error: [], log: [] };
		const list = L.fromSetting("RATECON_PDF_VIEWER_IDS", raw, { warn: (m) => out.warn.push(m), error: (m) => out.error.push(m), log: (m) => out.log.push(m) }, { unsetMeans: "as before", invalidMeans: "nobody" });
		return { list, out };
	};
	const u = logOf(undefined);
	ok("§4 unset: one warning, no error", u.list.state === "unset" && u.out.warn.length === 1 && u.out.error.length === 0 && /RATECON_PDF_VIEWER_IDS/.test(u.out.warn[0]));
	const i = logOf("1,owner_admin");
	ok("§4 invalid: one error, no warning", i.list.state === "invalid" && i.out.error.length === 1 && i.out.warn.length === 0);
	ok("§4 ...and the error never repeats the setting's text", !i.out.error[0].includes("owner_admin"));
	const v = logOf("1,7");
	ok("§4 valid: nothing logged", v.list.state === "valid" && v.out.warn.length + v.out.error.length + v.out.log.length === 0);
}

// ── §5 server.js wiring ─────────────────────────────────────────────────────
{
	const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	const reads = SRC.match(/process\.env\.RATECON_PDF_VIEWER_IDS/g) || [];
	ok(`§5 server.js reads RATECON_PDF_VIEWER_IDS in one place (${reads.length})`, reads.length === 1);
	const at = SRC.indexOf('const RATECON_PDF_VIEWERS = require("./lib/listed-accounts.js").fromSetting(\n\t"RATECON_PDF_VIEWER_IDS", process.env.RATECON_PDF_VIEWER_IDS');
	ok("§5 ...at module scope, through fromSetting() (so its warning or error is logged once per start)", at > 0 && SRC[at - 1] === "\n");
	ok("§5 the gate is built once from that list", /\nconst rateconViewGate = require\("\.\/lib\/ratecon-pdf-route\.js"\)\.viewerGate\(RATECON_PDF_VIEWERS\);\n/.test(SRC));
	ok("§5 the PDF route is mounted with that gate", /require\("\.\/lib\/ratecon-pdf-route"\)\.mount\(app, \{[^\n]*viewerGate: rateconViewGate \}\);/.test(SRC));
	const ex = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
	ok("§5 .env.example names RATECON_PDF_VIEWER_IDS, commented out (unset by default)", /^# RATECON_PDF_VIEWER_IDS=$/m.test(ex) && !/^RATECON_PDF_VIEWER_IDS=/m.test(ex));
}

console.log(`\nlisted-accounts: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
