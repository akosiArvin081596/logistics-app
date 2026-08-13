#!/usr/bin/env node
// A purgeable refusal action that can carry a period cause MUST write the cause
// as `[PERIOD_…]` in its details — or purgeOldAuditRefusals() deletes it.
//
// WHY THIS EXISTS — this was a LIVE DEFECT, not a hypothetical. Two mechanisms
// protect a period refusal from being thrown away, and they are keyed on two
// different things:
//
//   • UNCOALESCED_REFUSAL_CODES exempts it from COALESCING, keyed on the CODE.
//   • purgeOldAuditRefusals() exempts it from DELETION, keyed on the DETAILS —
//     `AND details NOT LIKE '%[PERIOD\_%' ESCAPE '\'`.
//
// `create_sheet_row_blocked` and `update_sheet_row_blocked` are both on
// PURGEABLE_REFUSAL_ACTIONS and both built their details with
// buildSheetUpdateAudit(), which emits pure JSON: `"code":"PERIOD_FINALIZED"`.
// A quote and a colon where the filter wants a bracket — so the exemption never
// matched and every period refusal on the two sheet-WRITE routes was silently
// deleted at 90 days. Those are the routes that rewrite Job Tracking, where the
// revenue lives, and a settlement dispute surfaces on a quarterly or annual
// cadence, i.e. reliably AFTER the retention window. The evidence was being
// destroyed exactly before it was first wanted, while the corresponding
// successful writes were kept forever.
//
// ⚠️ THE FIX WAS THE MARKER, NOT THE LIST. Removing the two actions from
// PURGEABLE_REFUSAL_ACTIONS would also have "worked" and is wrong twice over: it
// would retain the cheap, on-demand refusals (DUPLICATE_LOAD, SHEET_CHANGED,
// ROW_LOAD_MISMATCH) that the purge exists to age out, and it would fail
// test-driver-status-row-binding.js, which pins all eight reviewed actions as a
// required subset.
//
// ⚠️ THE POSITIVE CONTROL IS THE POINT. A test that only asserts "the marked row
// survived" passes on a purge that deletes nothing at all — including one broken
// by a typo in the action list, an unescaped LIKE, or a cutoff that never
// matches. So every case is paired with an UNMARKED row of the same age and the
// same action, which MUST be deleted. If the control survives, the test is
// measuring nothing and says so.
//
// Runs the REAL purgeOldAuditRefusals() and the REAL detail builders, extracted
// from server.js source, against an in-memory database. No network, no sheet,
// never the live app.db.
//
//   node scripts/test-purge-detail-marker.js     # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(label, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	failures.push(`  ${label}\n      expected ${e}\n      actual   ${a}`);
}
function section(t) { console.log(`\n${t}`); }
// ⚠️ A HARNESS ERROR IS A FAILURE, NOT A CRASH. Sections 3-4 extract
// sheetAuditWithCode() by name; against a server.js that predates the fix that
// name does not exist, and an uncaught throw would hide the finding instead of
// reporting it. Fail loudly, but finish the run and print the summary.
function guarded(label, fn) {
	try { fn(); } catch (err) { fail++; failures.push(`  ${label}\n      threw: ${err.message}`); }
}

function extract(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}
function extractArrayConst(name) {
	const anchor = `\nconst ${name} = [`;
	const hits = SRC.split(anchor).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 \`const ${name} = [\`, found ${hits}`);
	const start = SRC.indexOf(anchor) + 1;
	return SRC.slice(start, SRC.indexOf("];", start) + 2);
}

// The shipped detail builders, executed rather than paraphrased. `scrubPurgeMarker`
// is extracted alongside them because capAuditField() delegates to it — that is the
// purge-marker reservation, and stubbing it here would test a defence that is not
// the one running in production. `mutate` lets section 9 run the same builders with
// one line of the source changed.
function makeBuilders(mutate) {
	const src = [extract("scrubPurgeMarker"), extract("capAuditField"),
		extract("sheetAuditWithCode"), extract("buildSheetUpdateAudit")].join("\n");
	const body = mutate ? mutate(src) : src;
	if (mutate && body === src) throw new Error("mutation did not change the source");
	return new Function("SHEET_ROW_AUDIT_DETAILS_MAX", "SHEET_ROW_AUDIT_MAX_CHANGES",
		`${body}\n return { buildSheetUpdateAudit, sheetAuditWithCode, capAuditField, scrubPurgeMarker };`)(4000, 40);
}

const PURGE_LIST = (() => {
	const body = extractArrayConst("PURGEABLE_REFUSAL_ACTIONS");
	return (body.match(/"[a-z_]+"/g) || []).map((s) => s.slice(1, -1));
})();

// ── the real purge, over an in-memory audit_trail ───────────────────────────
const db = new Database(":memory:");
db.exec(`CREATE TABLE audit_trail (
	id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL,
	username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL,
	entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

const purge = new Function("db", "PURGEABLE_REFUSAL_ACTIONS", "REFUSAL_AUDIT_RETENTION_DAYS", "console",
	`${extract("purgeOldAuditRefusals")}\nreturn purgeOldAuditRefusals;`
)(db, PURGE_LIST, 90, { log: () => {}, error: (m) => { throw new Error(m); } });

const DAY = 24 * 60 * 60 * 1000;
const at = (days) => new Date(Date.now() - days * DAY).toISOString();
let seq = 0;
function row(action, details, days) {
	const id = ++seq;
	db.prepare("INSERT INTO audit_trail (id, timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?,?,?,?,?,?,?,?,?)")
		.run(id, at(days), 3, "super_admin", "Super Admin", action, "sheet_row", String(id), details);
	return id;
}
const alive = (id) => !!db.prepare("SELECT 1 FROM audit_trail WHERE id = ?").get(id);
const reset = () => { db.prepare("DELETE FROM audit_trail").run(); };

// ── 1. the control: the purge really deletes ────────────────────────────────
// Everything below is meaningless if this fails.
section("1. positive control — an unmarked purgeable row IS deleted at 400 days");
{
	reset();
	const old = row("update_sheet_row_blocked", `{"outcome":"blocked","code":"DUPLICATE_LOAD"}`, 400);
	const fresh = row("update_sheet_row_blocked", `{"outcome":"blocked","code":"DUPLICATE_LOAD"}`, 3);
	const write = row("update_sheet_row", `{"outcome":"updated"}`, 400);
	purge();
	check("a 400-day-old unmarked refusal is deleted", alive(old), false);
	check("...a 3-day-old one is not (the cutoff is real)", alive(fresh), true);
	// ⚠️ AUDIT ROWS ARE EVIDENCE. Nothing that records a WRITE may ever be purged.
	check("...and a row recording a WRITE is never touched, at any age", alive(write), true);
}

// ── 2. the defect: JSON alone does not save the row ─────────────────────────
section("2. the defect — a bare JSON code is NOT the marker the purge looks for");
{
	reset();
	// Exactly what buildSheetUpdateAudit() emitted before the fix.
	const jsonOnly = row("update_sheet_row_blocked",
		`{"outcome":"blocked","sheet":"Job Tracking","rowIndex":14,"periods":["2026-05"],"code":"PERIOD_FINALIZED"}`, 400);
	// The same payload, with the bracketed marker appended outside the JSON.
	const marked = row("update_sheet_row_blocked",
		`{"outcome":"blocked","sheet":"Job Tracking","rowIndex":14,"periods":["2026-05"],"code":"PERIOD_FINALIZED"} [PERIOD_FINALIZED]`, 400);
	purge();
	check("`\"code\":\"PERIOD_FINALIZED\"` inside the JSON does NOT survive", alive(jsonOnly), false);
	check("...the same row WITH `[PERIOD_FINALIZED]` outside it does", alive(marked), true);
}

// ── 3. the real builders produce a surviving row ────────────────────────────
// The two sections above establish the rule. This runs the actual code that
// writes these details and asserts the output of THAT survives — so the test
// tracks the implementation rather than a copy of it.
guarded("sections 3-4 (shipped detail builders) ran", () => {
	section("3. the shipped detail builders emit a row the purge spares");
	{
		const buildRuntime = makeBuilders();

		const details = buildRuntime.sheetAuditWithCode(buildRuntime.buildSheetUpdateAudit({
			outcome: "blocked", sheet: "Job Tracking", rowIndex: 14,
			changed: [{ column: "  Payment  ", index: 14, from: "1050", to: "0", why: "revenue" }],
			guardedChanged: [{ column: "  Payment  " }],
			code: "PERIOD_FINALIZED", periods: ["2026-05"],
		}), "PERIOD_FINALIZED");

		check("the built detail carries the bracketed marker", /\[PERIOD_FINALIZED\]/.test(details), true);
		check("...and the JSON object is still intact as the leading token",
			(() => { try { return JSON.parse(details.slice(0, details.lastIndexOf("}") + 1)).code; } catch { return null; } })(),
			"PERIOD_FINALIZED");
		reset();
		const kept = row("update_sheet_row_blocked", details, 400);
		// PAIRED: the same builder WITHOUT the wrapper is the pre-fix behaviour.
		const lost = row("update_sheet_row_blocked", buildRuntime.buildSheetUpdateAudit({
			outcome: "blocked", sheet: "Job Tracking", rowIndex: 14, changed: [], guardedChanged: [],
			code: "PERIOD_FINALIZED", periods: ["2026-05"],
		}), 400);
		purge();
		check("a real wrapped detail survives 400 days", alive(kept), true);
		check("...and the unwrapped one — the shipped bug — does not", alive(lost), false);
	}

	// ⚠️ THE MARKER MUST SURVIVE TRUNCATION. buildSheetUpdateAudit() drops entries
	// and then flattens values when a payload is over budget; if the marker lived
	// INSIDE that payload, a single wide cell could push it off the end and silently
	// re-arm the purge on the highest-value rows. Appending outside is what makes it
	// unloseable, and this is the case that proves it.
	section("4. a huge payload cannot lose the marker");
	{
		const buildRuntime = makeBuilders();
		const fat = Array.from({ length: 60 }, (_, i) => ({
			column: `col${i}`, index: i, from: "x".repeat(400), to: "y".repeat(400),
		}));
		const details = buildRuntime.sheetAuditWithCode(buildRuntime.buildSheetUpdateAudit({
			outcome: "blocked", sheet: "Job Tracking", rowIndex: 14, changed: fat,
			guardedChanged: [], code: "PERIOD_FINALIZED", periods: ["2026-05"],
		}), "PERIOD_FINALIZED");
		check("the oversized payload was actually truncated", /changesOmitted|truncated/.test(details), true);
		check("...and the marker is still there", /\[PERIOD_FINALIZED\]$/.test(details), true);
		reset();
		const kept = row("update_sheet_row_blocked", details, 400);
		purge();
		check("...so the row survives", alive(kept), true);
	}
});

// ── 5. every purgeable action, both directions ──────────────────────────────
// Whole-list sweep rather than the two that were broken: the property is a
// property of the list, and the next action added to it inherits the same trap.
section("5. every purgeable action: marked survives, unmarked is purged");
{
	check("the purge list was extracted", PURGE_LIST.length >= 8, true);
	const survived = [], purged = [];
	reset();
	const ids = PURGE_LIST.map((a) => ({
		action: a,
		marked: row(a, `Blocked something [PERIOD_FINALIZED] periods=2026-05`, 400),
		unmarked: row(a, `Blocked something [ROW_LOAD_MISMATCH]`, 400),
	}));
	purge();
	for (const r of ids) {
		if (!alive(r.marked)) survived.push(r.action);
		if (alive(r.unmarked)) purged.push(r.action);
	}
	check("no marked period refusal was deleted, on any purgeable action", survived, []);
	check("...and every unmarked one was (so the sweep is not vacuous)", purged, []);
}

// ── 6. the LIKE escape ──────────────────────────────────────────────────────
// `_` is a single-character wildcard in SQL LIKE. Without ESCAPE the pattern
// `%[PERIOD_%` also matches `[PERIODX…`, so an unrelated code beginning
// "PERIOD" + any character would be spared — retaining too much, which is the
// safe direction, but it also means the test above would pass on a broken
// filter. Asserted directly on the shipped SQL.
section("6. the underscore is a literal, not a wildcard");
{
	const fn = extract("purgeOldAuditRefusals");
	check("the purge escapes the LIKE", /ESCAPE '\\\\'/.test(fn), true);
	check("...and narrows by details, not by action alone", /details NOT LIKE '%\[PERIOD/.test(fn), true);
	reset();
	// `[PERIODX]` must NOT be read as a period marker.
	const decoy = row("update_sheet_row_blocked", "Blocked [PERIODX_WHATEVER]", 400);
	purge();
	check("a code that merely starts with PERIOD+1 char is not spared", alive(decoy), false);
	// ⚠️ THAT DECOY IS A SERVER-CHOSEN CODE, NOT AN ATTACKER-CHOSEN ONE, and reading
	// it as coverage of injection is how this file came to look like it had already
	// considered the case below. `[PERIODX_WHATEVER]` asks "does the ESCAPE work?".
	// Section 9 asks the different question "can a CALLER put `[PERIOD_` in there?",
	// and until scrubPurgeMarker() the answer was yes.
}

// ── 9. the exemption is a RESERVED sequence, not merely an appended one ─────
// ⚠️ THE MARKER LIVES IN A COLUMN BUILT FROM REQUEST DATA. `create_sheet_row_blocked`
// and `update_sheet_row_blocked` are both PURGEABLE, and buildSheetUpdateAudit()
// serialises `changed[].from` / `.to` — which are RAW SHEET CELLS off the body of
// POST/PUT /api/data (`after[i]` is the caller's `values[i]`, verbatim). They are
// capped by capAuditField() and, before this, never scanned; JSON.stringify escapes
// quotes and newlines but not `[` or `_`. So ONE request with a cell reading
// `[PERIOD_` wrote an audit row that could never be deleted — neither /api/data
// route is rate-limited, and these codes do not coalesce, so it is one permanent
// multi-KB row per request against the only table here with no other retention job.
//
// ⚠️ AND THE OPPOSITE DIRECTION IS HALF THE TEST. A scrub applied one layer too
// late — to the finished detail rather than to the caller's half — deletes the
// exemption from exactly the rows it exists to keep, which is the same defect
// upside down. Every case below is therefore paired with a REAL period refusal
// carrying the SAME hostile cell, which must still survive.
section("9. caller text cannot forge the exemption, and the real one is unstrippable");
guarded("section 9 (marker injection) ran", () => {
	const R = makeBuilders();
	// One blocked sheet-row rewrite, with a caller-controlled cell and a
	// caller-independent cause code. `DUPLICATE_LOAD` is one of the cheap,
	// on-demand refusals the purge exists to age out — the row MUST die.
	const blocked = (code, cell, over) => R.sheetAuditWithCode(R.buildSheetUpdateAudit({
		outcome: "blocked", sheet: "Job Tracking", rowIndex: 14,
		changed: [{ column: "Details", index: 9, from: "", to: cell, why: "" }],
		guardedChanged: [], code, periods: code.startsWith("PERIOD") ? ["2026-05"] : [],
		...over,
	}), code);

	// The control first: without it, "the injected row was deleted" passes on a
	// purge that deletes everything.
	reset();
	const ordinary = row("update_sheet_row_blocked", blocked("DUPLICATE_LOAD", "Empty CHEP Pallets, 53' Dry Van"), 400);
	const genuine = row("update_sheet_row_blocked", blocked("PERIOD_FINALIZED", "Empty CHEP Pallets, 53' Dry Van"), 400);
	purge();
	check("CONTROL: an ordinary cheap refusal is purged at 400 days", alive(ordinary), false);
	check("CONTROL: a genuine period refusal is not", alive(genuine), true);

	// ⚠️ THE INJECTION. Each of these is one sheet cell a Dispatcher can type.
	// Lower- and mixed-case are included because SQLite's LIKE is case-INSENSITIVE
	// for ASCII by default, so `[period_` is spared just as readily as `[PERIOD_` —
	// a case-sensitive scrub would leave the hole open under one keystroke.
	for (const payload of [
		"[PERIOD_FINALIZED]",
		"[period_finalized]",
		"[PeRiOd_x]",
		"pallets [PERIOD_ anything at all",
		"[PERIOD_",
	]) {
		reset();
		const injected = row("update_sheet_row_blocked", blocked("DUPLICATE_LOAD", payload), 400);
		// PAIRED, and this is the assertion the fix could most easily break: the same
		// hostile cell on a row whose cause REALLY is a period lock must still be kept.
		const paired = row("update_sheet_row_blocked", blocked("PERIOD_FINALIZED", payload), 400);
		purge();
		check(`INJECTION: a cell reading ${JSON.stringify(payload)} does NOT make its row immortal`, alive(injected), false);
		check("...while the same cell on a REAL period refusal still survives", alive(paired), true);
	}

	// Every other caller-influenced field on the builder goes through the same cap,
	// so the scrub has to travel with the cap rather than sit at one call site.
	for (const [label, over] of [
		["the sheet name", { sheet: "[PERIOD_Job Tracking" }],
		["a column header", { changed: [{ column: "[PERIOD_Details", index: 9, from: "", to: "x", why: "" }] }],
		["the error text", { error: "write failed [PERIOD_FINALIZED]" }],
		["the loadId provenance", { loadId: "[PERIOD_562787563" }],
		["the `via` provenance", { via: "[PERIOD_load" }],
	]) {
		reset();
		const injected = row("update_sheet_row_blocked", blocked("DUPLICATE_LOAD", "x", over), 400);
		purge();
		check(`INJECTION via ${label} is neutralised too`, alive(injected), false);
	}

	// ⚠️ NEUTRALISED, NOT DELETED. An audited sheet cell is the evidence that makes
	// the write reversible by hand, so the value must stay legible — only the
	// bracket changes.
	{
		const d = blocked("DUPLICATE_LOAD", "pallets [PERIOD_FINALIZED] 53ft");
		check("the injected value is still readable, just defanged", /pallets \(PERIOD_FINALIZED\] 53ft/.test(d), true);
		check("...and no `[PERIOD` survives anywhere in the row", /\[period/i.test(d), false);
	}

	// ⚠️ THE REAL MARKER IS APPENDED OUTSIDE THE CAPPING CALL — that is WHY the
	// scrub cannot reach it, and it is a structural property worth asserting
	// directly rather than inferring from the survival tests above.
	check("sheetAuditWithCode still emits the bracketed code itself",
		/\[PERIOD_FINALIZED\]$/.test(R.sheetAuditWithCode("{}", "PERIOD_FINALIZED")), true);
	check("...and capAuditField, which the scrub lives in, never sees that bracket",
		R.capAuditField("PERIOD_FINALIZED", 60), "PERIOD_FINALIZED");

	// The truncation interaction: a hostile cell padded past the byte budget must
	// still lose its forged marker AND keep the real one. This is where a scrub
	// applied after truncation, or before the wrong step, shows up.
	{
		reset();
		const fat = Array.from({ length: 60 }, (_, i) => ({
			column: `col${i}`, index: i, from: "[PERIOD_" + "x".repeat(400), to: "y".repeat(400),
		}));
		const mk = (code) => R.sheetAuditWithCode(R.buildSheetUpdateAudit({
			outcome: "blocked", sheet: "Job Tracking", rowIndex: 14, changed: fat,
			guardedChanged: [], code, periods: [],
		}), code);
		const injected = row("update_sheet_row_blocked", mk("DUPLICATE_LOAD"), 400);
		const real = row("update_sheet_row_blocked", mk("PERIOD_FINALIZED"), 400);
		check("the oversized payload was actually truncated", /changesOmitted|truncated/.test(mk("DUPLICATE_LOAD")), true);
		purge();
		check("OVERSIZED: the forged marker is still neutralised", alive(injected), false);
		check("OVERSIZED: the real marker still survives", alive(real), true);
	}

	// ── mutants ─────────────────────────────────────────────────────────────
	// ⚠️ MUTATED ON scrubPurgeMarker's BODY, never on its call site: renaming the
	// call throws, and a throw is counted as "caught", so such a mutant would pass
	// for the wrong reason and prove nothing.
	// ⚠️ "THE NEEDLE NO LONGER MATCHES" IS A VACUOUS MUTANT, NOT A CAUGHT ONE, and
	// the usual `try { … } catch { caught = true }` shape cannot tell them apart —
	// so a refactor that renames one line turns every mutant below into a
	// permanently-passing no-op, silently. Whether the mutation APPLIED is asserted
	// separately from whether it was caught.
	function mutantCaught(label, mutate, probe) {
		let caught = false, applied = true;
		try {
			caught = !probe(makeBuilders(mutate));
		} catch (err) {
			if (/mutation did not change the source/.test(err.message)) applied = false;
			else caught = true;
		}
		check(`M: ${label} actually mutated the shipped source`, applied, true);
		check(`M: ${label} is caught`, caught, true);
	}
	const survives = (M) => {
		reset();
		const id = row("update_sheet_row_blocked", M.sheetAuditWithCode(M.buildSheetUpdateAudit({
			outcome: "blocked", sheet: "Job Tracking", rowIndex: 14,
			changed: [{ column: "Details", index: 9, from: "", to: "[PERIOD_FINALIZED]", why: "" }],
			guardedChanged: [], code: "DUPLICATE_LOAD", periods: [],
		}), "DUPLICATE_LOAD"), 400);
		purge();
		return alive(id) === false;
	};

	// M9a — the scrub becomes the identity function, i.e. the shipped bug restored.
	mutantCaught("a scrub that no longer reserves the marker",
		(s) => s.replace('return String(s).replace(/\\[(?=period)/gi, "(");', "return String(s);"),
		survives);
	// M9b — the scrub is made CASE-SENSITIVE. Every uppercase test above still
	// passes; only `[period_` gets through, and SQLite's LIKE spares it just the
	// same. This is the subtlest way back to the bug.
	mutantCaught("a case-SENSITIVE scrub (SQLite's LIKE is not)",
		(s) => s.replace('/\\[(?=period)/gi', '/\\[(?=PERIOD)/g'),
		(M) => {
			reset();
			const id = row("update_sheet_row_blocked", M.sheetAuditWithCode(M.buildSheetUpdateAudit({
				outcome: "blocked", sheet: "Job Tracking", rowIndex: 14,
				changed: [{ column: "Details", index: 9, from: "", to: "[period_finalized]", why: "" }],
				guardedChanged: [], code: "DUPLICATE_LOAD", periods: [],
			}), "DUPLICATE_LOAD"), 400);
			purge();
			return alive(id) === false;
		});
	// M9c — the scrub is applied to the FINISHED detail instead of the caller's
	// half, which neutralises the REAL marker and silently re-arms the purge on
	// every genuine period refusal. The injection tests all still pass.
	mutantCaught("a scrub applied one layer too late (the real marker eaten)",
		(s) => s.replace("return code ? `${details} [${capAuditField(code, 60)}]` : details;",
			"return code ? scrubPurgeMarker(`${details} [${capAuditField(code, 60)}]`) : details;"),
		(M) => {
			reset();
			const id = row("update_sheet_row_blocked", M.sheetAuditWithCode(M.buildSheetUpdateAudit({
				outcome: "blocked", sheet: "Job Tracking", rowIndex: 14, changed: [],
				guardedChanged: [], code: "PERIOD_FINALIZED", periods: ["2026-05"],
			}), "PERIOD_FINALIZED"), 400);
			purge();
			return alive(id) === true;
		});
});

// ── 7. the two mechanisms stay a pair ───────────────────────────────────────
// UNCOALESCED_REFUSAL_CODES (never collapsed) and the purge filter (never
// deleted) are documented as a pair and keyed on different columns. A member of
// that set not named `PERIOD_…` would be written in full and then silently
// purged — the worse half of both behaviours.
section("7. never-coalesced and never-purged remain the same family");
{
	const start = SRC.indexOf("const UNCOALESCED_REFUSAL_CODES = new Set([");
	const codes = SRC.slice(start, SRC.indexOf("]);", start))
		.match(/"[A-Z_]+"/g).map((s) => s.slice(1, -1));
	check("the code set was extracted", codes.length >= 3, true);
	check("every never-coalesced code is named PERIOD_*, so the purge filter spares it",
		codes.filter((c) => !c.startsWith("PERIOD_")), []);
	reset();
	const ids = codes.map((c) => row("status_update_blocked", `Blocked x [${c}]`, 400));
	purge();
	check("...proven: every one of them survives 400 days", ids.filter((i) => !alive(i)), []);
}

// ── 8. the call sites, not just the builder ─────────────────────────────────
// ⚠️ THE ONE THAT NAMES THE ORIGINAL BUG. Sections 3-4 prove the wrapper works;
// this proves it is actually USED. `create_sheet_row_blocked` and
// `update_sheet_row_blocked` are the only purgeable actions whose details are
// machine-built JSON, so they are the only ones that can carry a period cause
// the purge cannot see. Every call site writing one of them must pass its detail
// through sheetAuditWithCode() — a builder that emits the marker is worth
// nothing if a call site bypasses it, which is exactly the state this fixed.
section("8. every JSON-detail purgeable action writes its detail through the wrapper");
{
	const JSON_DETAIL_ACTIONS = ["create_sheet_row_blocked", "update_sheet_row_blocked"];
	const bad = [];
	for (const action of JSON_DETAIL_ACTIONS) {
		const re = new RegExp(`logAudit(?:Refusal)?\\(req, "${action}"`, "g");
		let m, seen = 0;
		while ((m = re.exec(SRC))) {
			seen++;
			// The call's argument list, walked with a depth counter — these carry
			// nested calls, template literals and object literals full of commas.
			const open = SRC.indexOf("(", m.index);
			let depth = 0, end = -1;
			for (let j = open; j < SRC.length; j++) {
				if (SRC[j] === "(") depth++;
				else if (SRC[j] === ")") { depth--; if (depth === 0) { end = j; break; } }
			}
			const args = SRC.slice(open + 1, end);
			if (!/sheetAuditWithCode\(/.test(args)) {
				bad.push(`${action} @${SRC.slice(0, m.index).split("\n").length}`);
			}
		}
		check(`${action} has call sites to check`, seen > 0, true);
	}
	check("no purgeable JSON-detail refusal bypasses sheetAuditWithCode()", bad, []);
}

db.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("\nFailures:");
	for (const f of failures) console.log(f);
	process.exit(1);
}
