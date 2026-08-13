#!/usr/bin/env node
// Every period refusal in server.js must leave an audit_trail row.
//
// WHY THIS EXISTS. When a write is refused because its accounting month is
// closed, `audit_trail` is the only place anyone looks afterwards — and
// `super_admin` is a SHARED login, so a refusal that writes nothing makes a
// repeated attempt to restate a settled month invisible AND unattributable. It
// was invisible on eighteen routes. Ten of them refused through
// periodBlockedResponse() / periodLockUnreadableResponse() and three more
// through sendPeriodRefusal(), none of which took a `req`, so none of them
// COULD write a row however much anyone wanted them to; the rest refused inline
// and simply did not.
//
// ⚠️ THE FAILURE MODE THIS LOCKS IS DRIFT, NOT A BUG. Four routes were fixed by
// hand in an earlier batch and are already four different spellings of one idea.
// The defect is that auditing a refusal stopped being systematic — so the lock
// has to be systematic too: it EXTRACTS the refusal sites from server.js source
// and fails when one of them can refuse without recording it. A test that only
// checked the four known-good routes would pass on the exact regression it
// exists to catch.
//
// ⚠️ EVERY CASE IS PAIRED. A source scan that only asserts "an audit call is
// present" passes on a stub that writes nothing, and a behavioural test that
// only asserts "the happy path writes a row" passes on a helper that writes one
// row for every request including the successful ones. So each property below is
// checked in both directions, and section 5 runs five deliberate mutants of the
// shipped source — if a mutant passes, the assertion above it is decorative.
//
// No network, no sheet, no live database. Section 4 opens an in-memory SQLite.
//
//   node scripts/test-refusal-audit-coverage.js     # exits 1 on any failure

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
// ⚠️ A HARNESS ERROR IS REPORTED AS A FAILURE, NOT AS A CRASH. The runtime
// sections below extract functions by name; against a server.js that predates
// this change those names do not exist, and an uncaught throw there would hide
// the source-scan findings of sections 1-3 — which are the ones that say WHICH
// routes refuse in silence. Fail loudly, but finish the run.
function guarded(label, fn) {
	try { fn(); } catch (err) { fail++; failures.push(`  ${label}\n      threw: ${err.message}`); }
}

// ── source extraction ───────────────────────────────────────────────────────
// Anchored on a newline + `function name(` so a mention inside a comment or a
// call site cannot be mistaken for the definition, and the count is asserted so
// a rename fails the run rather than silently extracting nothing.
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

// ── 1. the three helpers can audit at all ───────────────────────────────────
// The original defect was structural, not an oversight: `periodBlockedResponse`
// and its two siblings had no `req` parameter, so no amount of care at a call
// site could have produced a row. `req` first, matching sendDispatchRefusal(),
// which is the precedent for a helper that records and then delegates.
section("1. the response helpers are shaped so they CAN audit");

const HELPERS = ["periodBlockedResponse", "periodLockUnreadableResponse", "sendPeriodRefusal"];
for (const h of HELPERS) {
	const src = extract(h);
	const sig = src.slice(0, src.indexOf(")") + 1);
	check(`${h}() takes req as its first parameter`, /^function \w+\(req, res[,)]/.test(sig), true);
	check(`${h}() records the refusal`, /recordPeriodRefusal\(/.test(src), true);
	// ⚠️ ORDER MATTERS. `res.status(409).json()` does not end the function, so an
	// audit written after it would still run — but the reason to put the record
	// first is that this file has no transactions: anything that can throw between
	// the decision and the row is a refusal with no record. Cheap to assert, and
	// it pins the shape reviewers will copy.
	check(`${h}() records BEFORE it answers`,
		src.indexOf("recordPeriodRefusal(") < src.indexOf("res.status(409)"), true);
}

// The wire contract is NOT what changed. periodBlockedResponse still answers
// PERIOD_FINALIZED unconditionally — clients branch on it — while the AUDITED
// cause may be PERIOD_UNRESOLVED. Asserted because the tempting "simplification"
// is to make them the same value, which throws away the distinction between
// "reopen the month" and "fix the date on the row".
{
	const src = extract("periodBlockedResponse");
	check("periodBlockedResponse still answers PERIOD_FINALIZED on the wire",
		/code: "PERIOD_FINALIZED",/.test(src), true);
	check("...but can audit PERIOD_UNRESOLVED when no month is named",
		/PERIOD_UNRESOLVED/.test(src), true);
}

// ── 2. every call site hands the helper something to record ─────────────────
// The scan is over server.js source, so a route added later is covered without
// anyone remembering to add it here.
section("2. every helper call site passes an audit descriptor");

// ⚠️ SCAN CODE, NOT PROSE. server.js documents these helpers by name in its own
// comments ("routes refuse through periodBlockedResponse() / …"), and a bare
// regex reads `periodBlockedResponse()` in a comment as a call site with an
// empty argument list — i.e. as an unaudited call. That is a false FAILURE
// rather than a false pass, but a lock that cries wolf is a lock people delete.
// Comment-only lines are dropped; every real call sits on a code line.
const CODE = SRC.split("\n")
	.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
	.join("\n");

// One call site = one occurrence of `helper(` that is not the definition. The
// argument list is walked with a depth counter rather than split on commas:
// these calls carry template literals and object literals containing commas.
function callSites(name) {
	const out = [];
	const re = new RegExp(`(?<!function )\\b${name}\\(`, "g");
	let m;
	while ((m = re.exec(CODE))) {
		const open = m.index + m[0].length - 1;
		let depth = 0;
		for (let j = open; j < CODE.length; j++) {
			if (CODE[j] === "(") depth++;
			else if (CODE[j] === ")") {
				depth--;
				if (depth === 0) { out.push(CODE.slice(open + 1, j)); break; }
			}
		}
	}
	return out;
}

// An audited call passes either a descriptor (recognised by `action:`, the field
// naming the `*_blocked` row) or the explicit AUDITED_UPSTREAM sentinel.
// ⚠️ A BARE OMISSION IS NOT ACCEPTED, and that is the whole point: an omitted
// argument is exactly what the eighteen routes were doing, so it must never be
// the shape that passes. AUDITED_UPSTREAM is spelled out at the call site so a
// deliberate skip is legible as one.
const AUDITED = (args) => /\baction:\s*["'`a-zA-Z]/.test(args) || /AUDITED_UPSTREAM/.test(args)
	|| /\b(dirAudit|dirDelAudit|createAudit|truckEditAudit|truckDelAudit|linkAudit|unlinkAudit|maintAudit|feeAudit|feePayAudit|loadDelAudit|invoiceAdjustAudit|invoicePaidAudit|invoiceRevertAudit)\b/.test(args);

let totalSites = 0;
for (const h of HELPERS) {
	const sites = callSites(h);
	totalSites += sites.length;
	check(`${h}() has call sites to check`, sites.length > 0, true);
	const unaudited = sites.filter((a) => !AUDITED(a));
	check(`every ${h}() call site is audited`,
		unaudited.map((a) => a.replace(/\s+/g, " ").slice(0, 90)), []);
}
// A floor, so a refactor that deletes the guards cannot make this section
// vacuously true by leaving nothing to check.
check("the helper call sites really are numerous", totalSites >= 20, true);

// ── 3. the inline refusals audit too ────────────────────────────────────────
// Five routes refuse with a hand-written 409 rather than through a helper,
// because their `code` is selected from blockers that are not all period
// blockers (INVOICE_ALREADY_PAID, DRIVER_NAME_IN_USE, INVOICE_WEEK_COLLISION,
// TARGET_UNREADABLE). Those must record the code the ROUTE selected — auditing
// them all as PERIOD_FINALIZED would send whoever reads the row to reopen a
// period that is open.
section("3. the inline (non-helper) period refusals audit as well");

// The 409 body, and the source window immediately above it.
function windowAbove(anchor, lines) {
	const at = SRC.indexOf(anchor);
	if (at < 0) throw new Error(`anchor not found in server.js: ${anchor.slice(0, 60)}`);
	const before = SRC.slice(0, at).split("\n");
	return before.slice(Math.max(0, before.length - lines)).join("\n");
}

const INLINE = [
	["PUT /api/users/:id — unreadable lock table",
		`error: "The period lock table could not be read, so no month can be confirmed open. This change is held until that is fixed."`],
	["PUT /api/users/:id — blocked cascade",
		"error: `Cannot update ${who}:"],
	["DELETE /api/users/:id — unreadable lock table",
		`error: "The period lock table could not be read, so no month can be confirmed open. User deletion is held until that is fixed."`],
	["DELETE /api/users/:id — blocked cascade",
		"error: `Cannot delete ${who}:"],
	["PUT /api/admin/fix-driver-name — blocked rename",
		`code: verdict.code, oldName: oldTrim, newName: newTrim, plan, verdict,`],
	["POST /api/admin/remove-rows — wholesale withhold",
		"error: skipped[0].reason,"],
	["DELETE /api/data/:rowIndex — blocked row delete",
		"return res.status(409).json({ error: blocker.error, code: blocker.code, periods: blocker.periods });"],
];
for (const [label, anchor] of INLINE) {
	const w = windowAbove(anchor, 24);
	check(`${label} records a refusal`,
		/recordPeriodRefusal\(|logAuditRefusal\(|auditWithheld\(/.test(w), true);
}

// ⚠️ PAIRED: the two user routes must NOT hardcode the cause. Asserting only
// "an audit call is present" would pass on `recordPeriodRefusal(x,
// "PERIOD_FINALIZED", …)`, which is the mislabel the route's own `code`
// selection exists to prevent.
for (const [label, anchor] of INLINE.slice(1, 4).concat([INLINE[4]])) {
	if (!/cascade|rename/.test(label)) continue;
	const w = windowAbove(anchor, 24);
	check(`${label} audits the code the route selected, not a hardcoded one`,
		/recordPeriodRefusal\([\s\S]*?\},\s*(code|verdict\.code)/.test(w), true);
}

// ── 3b. the AVAILABILITY refusals on the user routes audit too ──────────────
// ⚠️ THESE FOUR ARE NOT PERIOD REFUSALS, AND THAT IS EXACTLY WHY THEY WERE MISSED.
// Both user routes build one audit descriptor and it used to be declared BELOW the
// availability guards, beside the month-end one — so the refusals that return
// FIRST wrote nothing at all. They are not lesser causes:
//   • DRIVER_NAME_TAKEN refuses an IRREVERSIBLE merge of two people's expenses,
//     invoices and documents. After it there is nothing left to tell the rows
//     apart, so the refusal row is the only record that two identities were
//     involved at all.
//   • LAST_SUPER_ADMIN (both routes) and CANNOT_DELETE_SELF refuse the edits that
//     would leave the system with nobody able to manage it — terminal, with no
//     scripted recovery (reset-super-admin-password.js resets an EXISTING row).
// On a SHARED `super_admin` login, "someone kept trying this" is the only signal
// there will ever be — which is the argument the rest of this file makes for the
// period refusals, applied to the guards standing in front of them.
section("3b. the availability refusals on the user routes are audited");

const AVAILABILITY = [
	["PUT /api/users/:id — LAST_SUPER_ADMIN (demotion)",
		"error: `Cannot change the role of ${user.username}"],
	["PUT /api/users/:id — DRIVER_NAME_TAKEN (irreversible merge)",
		"error: `Cannot set the driver name to "],
	["DELETE /api/users/:id — CANNOT_DELETE_SELF",
		`code: "CANNOT_DELETE_SELF",`],
	["DELETE /api/users/:id — LAST_SUPER_ADMIN",
		"error: `Cannot delete ${user.username}: this is the only Super Admin account"],
];
for (const [label, anchor] of AVAILABILITY) {
	// Uniqueness first: a duplicated anchor would silently test the wrong route.
	check(`${label} anchor is unique in server.js`, SRC.split(anchor).length - 1, 1);
	const w = windowAbove(anchor, 12);
	check(`${label} records a refusal`, /recordPeriodRefusal\(/.test(w), true);
	// PAIRED — and it must record the cause the route actually selected, not a
	// hardcoded period code. Auditing CANNOT_DELETE_SELF as PERIOD_FINALIZED would
	// send whoever reads the row to reopen a month that is open.
	check(`${label} audits its own cause code, not a period one`,
		/recordPeriodRefusal\([\s\S]*?"(LAST_SUPER_ADMIN|DRIVER_NAME_TAKEN|CANNOT_DELETE_SELF)"/.test(w), true);
}

// ⚠️ THE STRUCTURAL FIX, PINNED SEPARATELY FROM ITS EFFECT. The four calls above
// can only work while the descriptor is in scope ABOVE them — moving it back down
// beside the month-end guard is a ReferenceError at best and, if someone
// "helpfully" re-declares a second copy there, a silent return to the original
// bug on whichever refusals fire first. Assert the ORDER, not just the presence.
{
	const putAt = SRC.indexOf("const userEditAudit = {");
	const putGuardAt = SRC.indexOf("error: `Cannot change the role of ${user.username}");
	const putLockAt = SRC.indexOf("const lock = userUpdateLockBlockers(");
	check("PUT: the audit descriptor is declared before the FIRST availability guard",
		putAt > 0 && putAt < putGuardAt, true);
	check("...i.e. above the month-end guard it used to sit beside",
		putAt < putLockAt, true);

	const delAt = SRC.indexOf("const userDelAudit = {");
	const delSelfAt = SRC.indexOf(`code: "CANNOT_DELETE_SELF",`);
	const delLockAt = SRC.indexOf("const lock = userDeleteLockBlockers(");
	check("DELETE: the audit descriptor is declared before the FIRST availability guard",
		delAt > 0 && delAt < delSelfAt, true);
	check("...i.e. above the month-end guard it used to sit beside",
		delAt < delLockAt, true);
	// PAIRED — exactly one descriptor per route. A second copy declared lower down
	// is how the hoist gets silently undone while every check above still passes.
	check("exactly one userEditAudit descriptor exists", SRC.split("const userEditAudit = {").length - 1, 1);
	check("exactly one userDelAudit descriptor exists", SRC.split("const userDelAudit = {").length - 1, 1);
}

// ── 4. the recording actually reaches the database ──────────────────────────
// Sections 2 and 3 prove the calls are written. This proves they do something:
// the real recordPeriodRefusal() → the real logAuditRefusal() → the real
// logAudit() → a row. Without this, every assertion above passes on a no-op.
section("4. a refusal really lands in audit_trail (real code, in-memory db)");

const db = new Database(":memory:");
db.exec(`CREATE TABLE audit_trail (
	id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL,
	username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL,
	entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

function buildRuntime(src) {
	const body = src || [
		extract("logAudit"),
		// auditText() delegates to it — the purge-marker reservation. Extracted
		// rather than stubbed, so the runtime below exercises the shipped scrub.
		extract("scrubPurgeMarker"),
		extract("auditText"),
		extract("periodRefusalDetail"),
		extract("recordPeriodRefusal"),
		extract("logAuditRefusal"),
		extract("periodBlockedResponse"),
		extract("periodLockUnreadableResponse"),
		extract("sendPeriodRefusal"),
	].join("\n");
	return new Function("db", "AUDITED_UPSTREAM", "UNCOALESCED_REFUSAL_CODES",
		"REFUSAL_AUDIT_WINDOW_MS", "refusalAuditWindows", "periodLabel", "console",
		`${body}
		 return { periodBlockedResponse, periodLockUnreadableResponse, sendPeriodRefusal,
		          recordPeriodRefusal, periodRefusalDetail, auditText };`
	)(db, AUDITED_UPSTREAM_SYM, new Set(["PERIOD_FINALIZED", "PERIOD_LOCK_UNREADABLE", "PERIOD_UNRESOLVED"]),
		60000, new Map(), (p) => p, { error: () => {} });
}
const AUDITED_UPSTREAM_SYM = Symbol("upstream");
const REQ = { session: { user: { id: 3, username: "super_admin", role: "Super Admin" } } };
const mkRes = () => { const o = { code: 0, body: null }; return { res: { status(c) { o.code = c; return { json(b) { o.body = b; return b; } }; } }, o }; };
const rows = () => db.prepare("SELECT action, entity, entity_id, details, username FROM audit_trail ORDER BY id").all();
const clear = () => db.prepare("DELETE FROM audit_trail").run();

guarded("sections 4-5 (runtime + mutants) ran", () => {
	const R = buildRuntime();

	{
		clear();
		const { res, o } = mkRes();
		R.periodBlockedResponse(REQ, res, "Cannot edit LogisX-#33",
			[{ table: "trucks", rows: 1, periods: ["2026-05"], detail: "would restate May" }],
			"Reopen the period first.",
			{ action: "update_truck_blocked", entity: "truck", entityId: "4", subject: "driver_pay_daily 250 -> 300" });
		const r = rows();
		check("periodBlockedResponse writes exactly one row", r.length, 1);
		check("...under the *_blocked action given", r[0] && r[0].action, "update_truck_blocked");
		check("...with the entity of the success line", [r[0] && r[0].entity, r[0] && r[0].entity_id], ["truck", "4"]);
		check("...naming the account (a shared login, never a person)", r[0] && r[0].username, "super_admin");
		check("...carrying the bracketed cause code", /\[PERIOD_FINALIZED\]/.test(r[0].details), true);
		check("...the period it would have restated", /periods=2026-05/.test(r[0].details), true);
		check("...what was being changed", /driver_pay_daily 250 -> 300/.test(r[0].details), true);
		check("...and it still answers 409 PERIOD_FINALIZED", [o.code, o.body.code], [409, "PERIOD_FINALIZED"]);
	}

	// ⚠️ PAIRED: an unresolved-only blocker set names no month, and auditing it as
	// PERIOD_FINALIZED would be a false statement about a month-end that never
	// happened. The wire code stays PERIOD_FINALIZED for the existing client.
	{
		clear();
		const { res, o } = mkRes();
		R.periodBlockedResponse(REQ, res, "Cannot record this fee",
			[{ table: "compliance_fees", rows: 1, periods: [""], detail: "unreadable date" }],
			"Fix the date.", { action: "create_compliance_fee_blocked", entity: "compliance_fee", entityId: "x" });
		check("an unresolved-only refusal audits PERIOD_UNRESOLVED", /\[PERIOD_UNRESOLVED\]/.test(rows()[0].details), true);
		check("...and does NOT claim a finalized month in the row", /\[PERIOD_FINALIZED\]/.test(rows()[0].details), false);
		check("...while the wire code is unchanged", o.body.code, "PERIOD_FINALIZED");
		check("...and no month is named", /periods=/.test(rows()[0].details), false);
	}

	{
		clear();
		const { res } = mkRes();
		R.periodLockUnreadableResponse(REQ, res, "Deleting a truck",
			{ action: "delete_truck_blocked", entity: "truck", entityId: "9", subject: "delete LogisX-#302" });
		check("periodLockUnreadableResponse audits PERIOD_LOCK_UNREADABLE",
			/\[PERIOD_LOCK_UNREADABLE\]/.test(rows()[0].details), true);
		check("...under its own action", rows()[0].action, "delete_truck_blocked");
	}

	// sendPeriodRefusal maps `kind` onto the cause code, so the row and the response
	// can never disagree about why the write was refused.
	for (const [kind, code] of [["unreadable", "PERIOD_LOCK_UNREADABLE"], ["unresolved", "PERIOD_UNRESOLVED"], ["finalized", "PERIOD_FINALIZED"]]) {
		clear();
		const { res, o } = mkRes();
		R.sendPeriodRefusal(REQ, res, kind, kind === "finalized" ? ["2026-06"] : [], "Deleting load #123",
			{ action: "delete_load_blocked", entity: "load", entityId: "#123" });
		check(`sendPeriodRefusal("${kind}") audits ${code}`, new RegExp(`\\[${code}\\]`).test(rows()[0].details), true);
		check(`sendPeriodRefusal("${kind}") answers ${code}`, o.body.code, code);
	}

	// ⚠️ PAIRED, and this is the one that keeps the sentinel honest: a caller that
	// already wrote its own row must write NOTHING here, or every dispatch refusal
	// is double-counted and "how many times was this attempted" stops being
	// answerable from the table.
	{
		clear();
		const { res } = mkRes();
		R.sendPeriodRefusal(REQ, res, "finalized", ["2026-06"], "x", AUDITED_UPSTREAM_SYM);
		check("AUDITED_UPSTREAM writes no second row", rows().length, 0);
	}

	// ⚠️ PAIRED: a FORGOTTEN descriptor must still leave a trace. "No descriptor →
	// no audit" is the tempting shape and it silently reproduces the original bug on
	// the next route someone adds.
	{
		clear();
		const { res } = mkRes();
		R.sendPeriodRefusal(REQ, res, "finalized", ["2026-06"], "Deleting load #999");
		check("a forgotten descriptor still records the refusal", rows().length, 1);
		check("...under a generic, greppable action", rows()[0].action, "period_refusal_blocked");
		check("...still carrying the cause code, so it is not purged", /\[PERIOD_FINALIZED\]/.test(rows()[0].details), true);
		// ⚠️ AND IT STILL NAMES THE ACCOUNT. The degraded row may lose the action
		// name — that costs a grep — but it must not lose the actor: `super_admin`
		// is a SHARED login, so the account and session are the only attribution
		// audit_trail ever has, and they are the whole reason the row exists. An
		// earlier draft merged `req` only when a descriptor was supplied and this
		// path recorded `system`.
		check("...and still names the account, not 'system'", rows()[0].username, "super_admin");
		check("...with the subject the caller did supply, so the attempt is legible",
			/Deleting load #999/.test(rows()[0].details), true);
	}

	// Caller-supplied text is bounded and single-line: audit_trail is read one row
	// per line and exported, these routes carry no rate limiter, and the body limit
	// is 50 MB.
	{
		clear();
		const { res } = mkRes();
		R.sendPeriodRefusal(REQ, res, "finalized", ["2026-06"], "x",
			{ action: "delete_load_blocked", entity: "load", entityId: "y".repeat(500), subject: "s".repeat(4000), note: "a\nb\tc " + "z".repeat(4000) });
		const r = rows()[0];
		check("entity_id is capped", r.entity_id.length <= 100, true);
		check("the detail is bounded", r.details.length < 1200, true);
		check("newlines and tabs are collapsed", /[\r\n\t]/.test(r.details), false);
	}

	// ⚠️ THE PURGE MARKER CANNOT BE FORGED FROM CALLER TEXT. These descriptors
	// interpolate a subject and a caller-supplied `reason`/`note`, and
	// purgeOldAuditRefusals() spares any row whose details contain `[PERIOD_` — so
	// without the scrub in auditText(), text a caller controls could exempt its own
	// row from a 90-day delete forever. Counted rather than merely matched: the
	// details must carry EXACTLY ONE marker, the real one this helper appends.
	// (Case-folded, because SQLite's LIKE is case-insensitive for ASCII, so
	// `[period_` is spared just as readily as `[PERIOD_`.)
	{
		clear();
		const { res } = mkRes();
		R.sendPeriodRefusal(REQ, res, "finalized", ["2026-06"], "Deleting load [PERIOD_FINALIZED] x",
			{ action: "delete_load_blocked", entity: "load", entityId: "[PERIOD_x]", note: "[period_finalized] and [PeRiOd_y]" });
		const d = rows()[0].details;
		check("caller text cannot inject a second purge marker",
			(d.match(/\[period/gi) || []).length, 1);
		check("...and the ONE that survives is the helper's own bracketed code",
			/WITHHELD \[PERIOD_FINALIZED\]/.test(d), true);
		// PAIRED — neutralised, NOT deleted: an audited value is evidence and must
		// stay legible, so only the bracket changes.
		check("...while the caller's text is still readable, just defanged",
			/\(PERIOD_FINALIZED\] x/.test(d), true);
	}

	// ⚠️ STRINGIFY ONLY PRIMITIVES. String() on a deeply-nested array throws
	// RangeError; inside the refusal path that turns a 409 into a 500 and loses both
	// the refusal and its row.
	{
		clear();
		let deep = ["x"];
		for (let i = 0; i < 60000; i++) deep = [deep];
		const { res, o } = mkRes();
		R.sendPeriodRefusal(REQ, res, "finalized", ["2026-06"], "x",
			{ action: "delete_load_blocked", entity: "load", entityId: deep, subject: deep, note: deep });
		check("a hostile nested body does not break the refusal", o.code, 409);
		check("...and the row is still written", rows().length, 1);
	}

	// ── 5. mutants — each must FAIL, or the assertion above it is decorative ─────
	section("5. mutants (each must be caught)");

	function mutantCaught(label, mutate, probe) {
		let caught = false;
		try {
			const src = [
				extract("logAudit"), extract("scrubPurgeMarker"), extract("auditText"), extract("periodRefusalDetail"),
				extract("recordPeriodRefusal"), extract("logAuditRefusal"),
				extract("periodBlockedResponse"), extract("periodLockUnreadableResponse"),
				extract("sendPeriodRefusal"),
			].join("\n");
			const mutated = mutate(src);
			if (mutated === src) throw new Error("mutation did not change the source");
			caught = !probe(buildRuntime(mutated));
		} catch { caught = true; }
		check(`M: ${label} is caught`, caught, true);
	}

	// M1 — recordPeriodRefusal becomes a no-op. This is the shape every "the call is
	// present" source scan passes on.
	mutantCaught("a no-op recorder", (s) => s.replace(
		/function recordPeriodRefusal\(audit, code, periods, subjectFallback\) \{/,
		"function recordPeriodRefusal(audit, code, periods, subjectFallback) { if (1) return;"),
		(R2) => { clear(); const { res } = mkRes(); R2.sendPeriodRefusal(REQ, res, "finalized", ["2026-06"], "x", { action: "a_blocked", entity: "e", entityId: "1" }); return rows().length === 1; });

	// M2 — the bracketed code is dropped from the detail. Everything still "audits";
	// purgeOldAuditRefusals() then deletes the row at 90 days.
	mutantCaught("a detail with no [CODE] marker", (s) => s.replace("WITHHELD [${code}]", "WITHHELD ${code}"),
		(R2) => { clear(); const { res } = mkRes(); R2.sendPeriodRefusal(REQ, res, "finalized", ["2026-06"], "x", { action: "a_blocked", entity: "e", entityId: "1" }); return /\[PERIOD_FINALIZED\]/.test(rows()[0].details); });

	// M3 — a missing descriptor silently writes nothing, i.e. the original bug
	// reintroduced. Mutated on the ACTION, because the helpers always merge `req`
	// in, so `!audit` alone is no longer reachable.
	mutantCaught("silence on a forgotten descriptor", (s) => s.replace(
		"if (audit === AUDITED_UPSTREAM) return;", "if (audit === AUDITED_UPSTREAM || !audit.action) return;"),
		(R2) => { clear(); const { res } = mkRes(); R2.sendPeriodRefusal(REQ, res, "finalized", ["2026-06"], "x"); return rows().length === 1; });

	// M6 — the actor is merged only when a descriptor was supplied, so the
	// degraded row records `system` instead of the account. This was a real
	// draft-stage defect, and on a shared login it is the worst field to lose.
	mutantCaught("a fallback row that loses the account", (s) => s.replace(
		/audit === AUDITED_UPSTREAM \? audit : \{ req, \.\.\.\(audit \|\| \{\}\) \}/g,
		"audit && audit !== AUDITED_UPSTREAM ? { req, ...audit } : audit"),
		(R2) => { clear(); const { res } = mkRes(); R2.sendPeriodRefusal(REQ, res, "finalized", ["2026-06"], "x"); return rows()[0].username === "super_admin"; });

	// M4 — AUDITED_UPSTREAM stops suppressing, so upstream-audited refusals are
	// recorded twice and the attempt count becomes unreadable.
	mutantCaught("a sentinel that no longer suppresses", (s) => s.replace(
		"if (audit === AUDITED_UPSTREAM) return;", "if (false) return;"),
		(R2) => { clear(); const { res } = mkRes(); R2.sendPeriodRefusal(REQ, res, "finalized", ["2026-06"], "x", AUDITED_UPSTREAM_SYM); return rows().length === 0; });

	// M7 — the scrub becomes the identity function, i.e. caller text can forge the
	// purge marker again. Mutated on scrubPurgeMarker's BODY rather than on its call
	// site: renaming the call would throw, and this harness counts a throw as
	// "caught", so that mutant would pass for the wrong reason and prove nothing.
	mutantCaught("a scrub that no longer reserves the purge marker",
		(s) => s.replace('return String(s).replace(/\\[(?=period)/gi, "(");', "return String(s);"),
		(R2) => {
			clear(); const { res } = mkRes();
			R2.sendPeriodRefusal(REQ, res, "finalized", ["2026-06"], "x [PERIOD_FINALIZED]",
				{ action: "a_blocked", entity: "e", entityId: "1" });
			return (rows()[0].details.match(/\[period/gi) || []).length === 1;
		});

	// M5 — the unresolved cause is folded into PERIOD_FINALIZED, which is a false
	// claim that a month-end happened.
	mutantCaught("an unresolved cause mislabelled as finalized", (s) => s.replace(
		'const code = periods.length ? "PERIOD_FINALIZED" : (unresolved ? "PERIOD_UNRESOLVED" : "PERIOD_FINALIZED");',
		'const code = "PERIOD_FINALIZED";'),
		(R2) => { clear(); const { res } = mkRes(); R2.periodBlockedResponse(REQ, res, "w", [{ periods: [""], detail: "d" }], "r", { action: "a_blocked", entity: "e", entityId: "1" }); return /\[PERIOD_UNRESOLVED\]/.test(rows()[0].details); });
});

// ── 6. naming contract ──────────────────────────────────────────────────────
// The purge and the coalescer both key on the ACTION, and this file's split
// between a refusal and its success is carried entirely by the `_blocked`
// suffix. A stray name breaks both silently.
section("6. every new refusal action obeys the naming contract");

const actions = [...new Set((SRC.match(/"[a-zA-Z0-9_]+_blocked"/g) || []).map((s) => s.slice(1, -1)))].sort();
check("there are refusal actions to check", actions.length >= 15, true);
check("every *_blocked action is lowercase words and underscores only",
	actions.filter((a) => !/^[a-z_]+_blocked$/.test(a)), []);

// ⚠️ THE PURGE DECISION, PINNED PER ACTION. purgeOldAuditRefusals() deletes rows
// whose action is on PURGEABLE_REFUSAL_ACTIONS and whose details lack `[PERIOD_`.
// The safe default for a new refusal action is to stay OFF that list — it is
// then kept forever — and every action introduced for the period guards was
// reviewed and deliberately left off, for the reason the purge's own comment
// gives: settlement disputes surface on a quarterly or annual cadence, i.e.
// reliably AFTER the 90-day window.
//
// This is a REQUIRED-ABSENT pin, the mirror of test-driver-status-row-binding's
// REQUIRED-PRESENT one. Adding any of these to the purge list would delete the
// evidence of an attempt to restate a closed month at exactly the point someone
// first goes looking for it, and would do so silently.
const PURGE = (() => {
	const anchor = "\nconst PURGEABLE_REFUSAL_ACTIONS = [";
	const start = SRC.indexOf(anchor);
	if (start < 0) throw new Error("PURGEABLE_REFUSAL_ACTIONS not found");
	const body = SRC.slice(start, SRC.indexOf("];", start));
	return (body.match(/"[a-z_]+"/g) || []).map((s) => s.slice(1, -1));
})();
const MUST_NOT_BE_PURGEABLE = [
	"update_driver_pay_blocked", "delete_driver_blocked",
	"update_user_blocked", "delete_user_blocked",
	"create_truck_blocked", "update_truck_blocked", "delete_truck_blocked",
	"driver_rename_blocked", "delete_sheet_rows_blocked", "delete_load_blocked",
	"add_driver_day_blocked", "exclude_driver_day_blocked",
	"restore_driver_day_blocked", "restore_added_driver_day_blocked",
	"delete_sheet_row_blocked", "routemate_link_blocked", "routemate_unlink_blocked",
	"maintenance_fund_blocked", "create_compliance_fee_blocked", "pay_compliance_fee_blocked",
	"period_refusal_blocked",
	// The invoice write guard. `adjust_invoice_blocked` refuses a ±$10,000 signed
	// correction against a finalized month; `pay_invoice_blocked` refuses the one
	// invoice transition that asserts money left the bank AND stamps the `paid_at`
	// that invoiceRowPeriodLocked() reads. Both are settlement evidence on the same
	// quarterly-to-annual dispute cadence as their neighbours, so both stay off the
	// purge list — kept forever, deliberately.
	// `revert_invoice_blocked` is the third and the mirror of the second: it refuses
	// a revert that would ERASE that same `paid_at` in a closed month. An attempt to
	// un-assert a payment in a settled month is at least as much settlement evidence
	// as an attempt to assert one.
	"adjust_invoice_blocked", "pay_invoice_blocked", "revert_invoice_blocked",
];
check("every new period-refusal action exists in server.js",
	MUST_NOT_BE_PURGEABLE.filter((a) => !SRC.includes(`"${a}"`)), []);
check("...and none of them is purgeable (they are kept forever, deliberately)",
	MUST_NOT_BE_PURGEABLE.filter((a) => PURGE.includes(a)), []);
// ⚠️ PAIRED, so the check above cannot pass by the list being empty or the
// extraction silently returning nothing.
check("...while the reviewed eight really are still purgeable",
	["create_sheet_row_blocked", "update_sheet_row_blocked", "status_update_blocked"]
		.filter((a) => !PURGE.includes(a)), []);

db.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("\nFailures:");
	for (const f of failures) console.log(f);
	process.exit(1);
}
