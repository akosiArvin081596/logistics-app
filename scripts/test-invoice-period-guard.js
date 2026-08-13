#!/usr/bin/env node
// The invoice write routes must refuse a FINALIZED month — and must NOT refuse a
// paid invoice in an OPEN one.
//
// WHY THIS EXISTS. `invoiceRowPeriodLocked()` has sat in server.js since the
// driver-rename cascade shipped, and until now it was called by exactly two
// READERS (the user-delete cascade and planDriverRenameSqlite). No route that
// WRITES an invoice had any period guard at all — so PUT /api/invoices/:id/adjust
// would book a signed correction of up to ±$10,000 onto a settled month, and the
// `paid` branch of PUT /api/invoices/:id/approve would stamp `paid_at` on an
// invoice whose month had already closed, creating a permanently frozen row after
// the fact with nothing on the record saying so.
//
// ⚠️ THE TWO THINGS THIS FILE EXISTS TO PIN ARE OPPOSITES, AND BOTH ARE EASY TO
// LOSE:
//   (a) POLARITY. The obvious sibling, PUT /api/investor/payouts/:id/adjust,
//       refuses while a period is still OPEN — because investor_payouts.amount is
//       recomputed live, so a manual delta on an open month is double-counted.
//       Invoices carry a frozen render_data snapshot and are never reconciled, so
//       the hazard is the ordinary one and the polarity is INVERTED relative to
//       that route. Copy the sibling and you block every legitimate edit while
//       allowing every illegitimate one — and both mistakes return a plausible
//       409, so neither is visible without a test.
//   (b) THE `paid_at` RUNG IS DELIBERATELY ABSENT. Reusing
//       invoiceRowPeriodLocked() verbatim is one line and would silently delete a
//       capability the owner asked for BY NAME on 2026-06-11 ("re-edit even if
//       it's already paid") — the entire premise of the adjust route. So "a PAID
//       invoice in an OPEN month is still adjustable" is asserted explicitly
//       below, not implied.
//
// Every property is checked in BOTH directions, and section 5 runs mutants of the
// shipped source: a mutant that passes means the assertion above it is decorative.
//
// The guard is EXTRACTED from server.js rather than reimplemented — a
// reimplementation tests the test. No network, no sheet. Section 4 uses an
// in-memory SQLite seeded from a COPY of app.db (never the live file, and never
// written to at all); it degrades to synthetic fixtures when app.db is absent.
//
//   node scripts/test-invoice-period-guard.js     # exits 1 on any failure

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(label, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	failures.push(`  ${label}\n      expected ${e}\n      actual   ${a}`);
}
function section(t) { console.log(`\n${t}`); }
function guarded(label, fn) {
	try { fn(); } catch (err) { fail++; failures.push(`  ${label}\n      threw: ${err.message}`); }
}

// Anchored on a newline + `function name(` so a mention in a comment or at a call
// site cannot be mistaken for the definition, and the hit count is asserted so a
// rename fails the run rather than silently extracting nothing.
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

// The source of one route handler, from its `app.<verb>("<path>"` registration to
// the matching close paren. Used to prove WHERE the guard sits relative to the
// first write, which no unit test of the predicate alone can show.
function routeSource(verb, routePath) {
	const needle = `app.${verb}("${routePath}"`;
	const at = SRC.indexOf(needle);
	if (at < 0) throw new Error(`route not found: ${verb.toUpperCase()} ${routePath}`);
	let depth = 0;
	for (let j = SRC.indexOf("(", at); j < SRC.length; j++) {
		if (SRC[j] === "(") depth++;
		else if (SRC[j] === ")") { depth--; if (depth === 0) return SRC.slice(at, j + 1); }
	}
	throw new Error(`unbalanced parens extracting ${verb.toUpperCase()} ${routePath}`);
}

// ── 1. the predicate is a SECOND function, and the right kind ───────────────
section("1. invoiceMonthLockBlockers() is month-only, fail-closed, and both-ended");

const GUARD = extract("invoiceMonthLockBlockers");
const ROW_PREDICATE = extract("invoiceRowPeriodLocked");

// ⚠️ THE HEADLINE ASSERTION. `paid_at` freezes a row for the READERS; for a WRITE
// route it would revoke the owner's stated requirement. If this ever fails, read
// the 2026-06-11 note on the adjust route before "fixing" it.
check("the write guard does NOT read paid_at", /paid_at/.test(GUARD), false);
// PAIRED — so the check above cannot pass by the extraction silently returning
// the wrong function.
check("...while the row predicate it is derived from still does", /paid_at/.test(ROW_PREDICATE), true);

check("it fails closed on an unreadable period_locks", /periodLocksReadable\(\)/.test(GUARD), true);
check("it consults the lock table, not periodPhase()/isPending()",
	[/\bisLocked\(/.test(GUARD), /isPending\(/.test(GUARD)], [true, false]);
// A Sat–Fri billing week straddles a month boundary; locking EITHER end freezes
// the row, because both months' settlement figures were computed with this
// driver's pay in them.
check("both ends of the billing week are read",
	[/week_start/.test(GUARD), /week_end/.test(GUARD)], [true, true]);

// ── 2. both routes are wired, and the guard precedes the first write ────────
section("2. the two write routes are guarded BEFORE their first write");

const ADJUST = routeSource("put", "/api/invoices/:id/adjust");
const APPROVE = routeSource("put", "/api/invoices/:id/approve");

for (const [label, src] of [["adjust", ADJUST], ["approve", APPROVE]]) {
	check(`${label} calls the write guard`, /invoiceMonthLockBlockers\(/.test(src), true);
	// ⚠️ ORDER IS THE POINT. This file has no transactions: a guard after the
	// UPDATE refuses nothing. Both routes must judge before they write.
	check(`${label} guards BEFORE its first UPDATE invoices`,
		src.indexOf("invoiceMonthLockBlockers(") < src.indexOf("UPDATE invoices"), true);
	check(`${label} refuses through the audited helpers`,
		[/periodLockUnreadableResponse\(req, res/.test(src), /periodBlockedResponse\(req, res/.test(src)],
		[true, true]);
	// The refusal must carry a descriptor — a bare omission is what the whole
	// refusal-audit pass exists to stop (see test-refusal-audit-coverage.js).
	check(`${label} passes an audit descriptor`, /_blocked"/.test(src), true);
}

// ⚠️ ONLY THE `paid` BRANCH OF approve IS GUARDED, and the scan proves it rather
// than trusting the prose: approve/reject/processing move an invoice through
// review, while `paid` is the one transition asserting money left the bank AND
// the one that stamps the `paid_at` invoiceRowPeriodLocked() reads.
check("approve guards inside an `action === \"paid\"` branch",
	/if \(action === "paid"\)[\s\S]{0,900}?invoiceMonthLockBlockers\(/.test(APPROVE), true);
// PAIRED: the guard must not have leaked onto the whole handler, which would
// refuse an ordinary approve/reject in a closed month and read as the route being
// broken rather than as a policy.
check("...and NOT above the transition switch (approve/reject/processing stay open)",
	APPROVE.indexOf("invoiceMonthLockBlockers(") > APPROVE.indexOf("const transitionOk"), true);

// The routes deliberately left alone. Asserted so "guard everything" cannot creep
// in silently later: they change workflow state, not money, they touch no money
// column, and each has its own state-machine check. (`revert` used to be on this
// list and has moved to section 2b — it does touch one.)
for (const p of ["/api/invoices/:id/submit", "/api/invoices/:id/restore"]) {
	check(`${p} is deliberately NOT period-guarded`,
		/invoiceMonthLockBlockers\(/.test(routeSource("put", p)), false);
	// PAIRED — the reason they are exempt is that they write no money column. If one
	// ever starts touching `paid_at`, this fails and the exemption must be revisited
	// rather than inherited.
	check(`...and the reason holds: ${p} writes no paid_at`,
		/paid_at\s*=/.test(routeSource("put", p)), false);
}

// ── 2b. revert is the ERASE direction of the same stamp ─────────────────────
// ⚠️ THE PAIR IS THE POINT. approve's `paid` branch is guarded because it CREATES
// `paid_at` in a month that may already be closed. `revert` ERASES the same
// column, on the same rows, in the same months — and a guard on only the creating
// direction is one you walk around by reverting and re-marking. The erase is the
// worse half: `paid_at` is what invoiceRowPeriodLocked() freezes on, what the user
// -route cascade reports as INVOICE_ALREADY_PAID, and what a settled month's
// statement was printed against.
section("2b. revert is guarded on the paid_at leg");

const REVERT = routeSource("put", "/api/invoices/:id/revert");
check("revert calls the write guard", /invoiceMonthLockBlockers\(/.test(REVERT), true);
// ⚠️ ORDER. No transactions here: a guard after the UPDATE refuses nothing.
check("revert guards BEFORE its UPDATE invoices",
	REVERT.indexOf("invoiceMonthLockBlockers(") < REVERT.indexOf("UPDATE invoices"), true);
check("revert refuses through the audited helpers",
	[/periodLockUnreadableResponse\(req, res/.test(REVERT), /periodBlockedResponse\(req, res/.test(REVERT)],
	[true, true]);
check("revert passes an audit descriptor", /revert_invoice_blocked/.test(REVERT), true);
// The write the guard exists for. If this ever stops being true the guard is
// pinned to a column the route no longer touches.
check("revert really does clear paid_at", /paid_at = ''/.test(REVERT), true);

// ⚠️ SCOPED TO A REVERT THAT ACTUALLY ERASES A STAMP, and the criterion is the
// COLUMN rather than the status: an Approved / Processing / Rejected invoice
// already carries `paid_at = ''`, so for those this route is pure workflow state —
// exactly what approve/reject/processing are, and exactly why submit / delete /
// restore are exempt above. Guarding them too would strand invoices in closed
// months over a write that changes no money column.
check("the guard sits inside a paid_at branch",
	/if \(String\(invoice\.paid_at \|\| ""\)\.trim\(\)\) \{[\s\S]{0,1600}?invoiceMonthLockBlockers\(/.test(REVERT), true);
// PAIRED: it must NOT sit above the state-machine check, or a Draft invoice in a
// closed month gets a month-end 409 about a write it was never going to make,
// instead of the clearer "already editable" 400.
check("...and BELOW the revertible-status check",
	REVERT.indexOf("invoiceMonthLockBlockers(") > REVERT.indexOf("const revertible"), true);

// The branch condition itself, EXTRACTED and executed — a reimplementation here
// would test the test.
{
	const line = REVERT.split("\n").find((l) => l.trim().startsWith("if (String(invoice.paid_at"));
	check("the paid_at branch is one legible condition", Boolean(line), true);
	const gates = new Function("invoice",
		`return Boolean(${String(line).trim().replace(/^if \(/, "").replace(/\) \{$/, "")});`);
	check("a PAID invoice IS gated", gates({ paid_at: "2026-05-20T10:00:00.000Z" }), true);
	check("...an Approved one (empty stamp) is NOT", gates({ paid_at: "" }), false);
	check("...nor is a null or absent stamp", [gates({ paid_at: null }), gates({})], [false, false]);
	check("...and whitespace is not a stamp", gates({ paid_at: "   " }), false);
}

// ── 3. the CSRF tier matches its payouts sibling ────────────────────────────
section("3. the adjust route carries the money tier");

const adjustLine = SRC.split("\n").find((l) => l.startsWith("app.put(") && l.includes('"/api/invoices/:id/adjust"'));
check("PUT /api/invoices/:id/adjust registration found", Boolean(adjustLine), true);
check("...carries refuseCrossOrigin, like PUT /api/investor/payouts/:id/adjust",
	Boolean(adjustLine) && adjustLine.includes("refuseCrossOrigin"), true);
check("...with requireRole first, so a 403 never spends the guard",
	Boolean(adjustLine) && adjustLine.indexOf("requireRole") < adjustLine.indexOf("refuseCrossOrigin"), true);

// ── 4. behaviour, against the REAL extracted guard ──────────────────────────
section("4. behaviour (real extracted guard, in-memory db seeded from a COPY of app.db)");

// ⚠️ NEVER THE LIVE app.db. It is copied to a temp path, opened READONLY, the few
// rows needed are harvested, and the copy is unlinked. Nothing in this file can
// reach the file the server writes. Absent app.db (CI, a fresh checkout) is not a
// failure — the synthetic fixtures below are the ones that carry the assertions;
// production rows are corroboration.
function harvestProduction() {
	const live = path.join(ROOT, "app.db");
	if (!fs.existsSync(live)) return null;
	const tmp = path.join(os.tmpdir(), `invoice-guard-fixture-${process.pid}-${Date.now()}.db`);
	try {
		fs.copyFileSync(live, tmp);
		const src = new Database(tmp, { readonly: true });
		const invoices = src.prepare(
			"SELECT id, invoice_number, driver, week_start, week_end, status, paid_at FROM invoices"
		).all();
		const locks = src.prepare("SELECT period, status FROM period_locks").all();
		src.close();
		return { invoices, locks };
	} catch { return null; }
	finally { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
}
const PROD = harvestProduction();

const db = new Database(":memory:");
db.exec("CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL)");
const setLocks = (periods) => {
	db.prepare("DELETE FROM period_locks").run();
	const ins = db.prepare("INSERT INTO period_locks (period, status) VALUES (?, ?)");
	for (const p of periods) ins.run(p, "locked");
};
// The break periodLocksReadable() was written for: the table exists but has no
// `status` column, so the SELECT throws on EXECUTION (SQLite recompiles a cached
// statement after a schema change) rather than on prepare.
const breakLocks = () => db.exec("DROP TABLE period_locks; CREATE TABLE period_locks (period TEXT PRIMARY KEY)");
const healLocks = () => db.exec("DROP TABLE period_locks; CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL)");

// The real constant, read from server.js rather than restated here — a test that
// hardcodes its own ceiling stops testing the shipped one the day it changes.
const MAX_SPAN = (() => {
	const m = /const INVOICE_MAX_SPAN_MONTHS = (\d+);/.exec(SRC);
	if (!m) throw new Error("INVOICE_MAX_SPAN_MONTHS not found in server.js");
	return parseInt(m[1], 10);
})();
check("the span ceiling is a sane number of months", MAX_SPAN >= 24 && MAX_SPAN <= 600, true);

function buildGuard(src) {
	const body = src || [
		extract("periodLockStmt"), extract("isLocked"), extract("periodLocksReadable"),
		// ⚠️ scrubPurgeMarker is not optional dressing — auditText() DELEGATES to it,
		// so omitting it makes every extraction here throw `scrubPurgeMarker is not
		// defined` at call time rather than at build time. It landed when the
		// [PERIOD_ purge-marker injection was closed; extracting a function without
		// its callees is the standing hazard of this whole extract() approach, and
		// it fails loudly here only because section 4 actually executes the result.
		extract("scrubPurgeMarker"),
		extract("periodLabel"), extract("auditText"), extract("invoiceMonthLockBlockers"),
	].join("\n");
	return new Function("db", "INVOICE_MAX_SPAN_MONTHS",
		`${body}\n return { invoiceMonthLockBlockers, isLocked, periodLocksReadable };`)(db, MAX_SPAN);
}

guarded("section 4-5 (behaviour + mutants) ran", () => {
	let G = buildGuard();
	// periodLockStmt caches its prepared statement on the function object, and the
	// tests below drop and recreate the table underneath it. Rebuild the runtime
	// whenever the schema changes so the cache can never mask a real answer.
	const rebuild = () => { G = buildGuard(); };

	const inv = (o) => ({ id: 7, invoice_number: "INV-SK-2026W19-01", driver: "shorn king",
		week_start: "2026-05-09", week_end: "2026-05-15", status: "Draft", paid_at: "", ...o });
	const verdict = (i) => {
		const r = G.invoiceMonthLockBlockers(i);
		return { unreadable: r.unreadable, blocked: r.blockers.length > 0,
			periods: r.blockers.flatMap((b) => b.periods) };
	};
	const remedyOf = (i) => G.invoiceMonthLockBlockers(i).remedy || "";

	// ── polarity ────────────────────────────────────────────────────────────
	// ⚠️ THE ASSERTION THIS FILE EXISTS FOR. Both directions, adjacent, so an
	// inversion cannot pass: an OPEN month is allowed, a FINALIZED one is refused.
	setLocks([]); rebuild();
	check("POLARITY: an open month is ALLOWED", verdict(inv()), { unreadable: false, blocked: false, periods: [] });
	setLocks(["2026-05"]); rebuild();
	check("POLARITY: a finalized month is REFUSED", verdict(inv()).blocked, true);
	check("...and it names the month, so the remedy is actionable", verdict(inv()).periods, ["2026-05"]);

	// ⚠️ THE OWNER'S REQUIREMENT, ASSERTED EXPLICITLY (2026-06-11, "re-edit even if
	// it's already paid"). A PAID invoice whose month is still OPEN must remain
	// adjustable — this is the single behaviour that reusing invoiceRowPeriodLocked()
	// would have silently removed.
	setLocks([]); rebuild();
	const paidOpen = inv({ status: "Paid", paid_at: "2026-05-20T10:00:00.000Z" });
	check("OWNER REQUIREMENT: a PAID invoice in an OPEN month is still adjustable",
		verdict(paidOpen), { unreadable: false, blocked: false, periods: [] });
	// PAIRED against the reader, which DOES freeze on paid_at — so the two really
	// are different predicates and this is not an artefact of the fixture.
	check("...while the READ-side predicate still freezes that same row",
		buildGuardRow()(paidOpen), true);
	// And the same row in a CLOSED month is refused, i.e. `paid` is not a bypass.
	setLocks(["2026-05"]); rebuild();
	check("...but the same paid row in a FINALIZED month is refused", verdict(paidOpen).blocked, true);

	// ── both ends of the week ───────────────────────────────────────────────
	// A Sat–Fri week straddling a month boundary. Locking EITHER end must refuse;
	// locking NEITHER must allow. Three cases, so a guard that reads only one
	// column fails on exactly one of them.
	const straddle = inv({ id: 40, invoice_number: "INV-SK-2026W17-01", week_start: "2026-04-25", week_end: "2026-05-01" });
	setLocks(["2026-04"]); rebuild();
	check("BOTH ENDS: week_start's month locked -> refused", verdict(straddle).periods, ["2026-04"]);
	setLocks(["2026-05"]); rebuild();
	check("BOTH ENDS: week_end's month locked -> refused", verdict(straddle).periods, ["2026-05"]);
	setLocks(["2026-04", "2026-05"]); rebuild();
	check("BOTH ENDS: both locked -> both named once, sorted", verdict(straddle).periods, ["2026-04", "2026-05"]);
	setLocks(["2026-03", "2026-06"]); rebuild();
	check("BOTH ENDS: neither end's month locked -> allowed", verdict(straddle).blocked, false);

	// ── the SPAN, not the endpoints ─────────────────────────────────────────
	// ⚠️ A MANUAL INVOICE IS NOT A WEEK. POST /api/invoices/manual validates only
	// `periodEnd >= periodStart` and writes those dates into the same two columns,
	// so a catch-up invoice can span an entire locked range with BOTH ENDPOINTS in
	// open months. An endpoints-only guard waves that through and lands ±$10,000 on
	// every closed month at once. This is the case an endpoints-only test cannot
	// see, which is why it is asserted separately from the straddling week above.
	const manual = inv({ id: 900, invoice_number: "INV-MAN-2026-01", is_manual: 1,
		week_start: "2025-04-01", week_end: "2026-08-31" });
	setLocks(["2025-05", "2025-06", "2026-01"]); rebuild();
	check("SPAN: a month in the MIDDLE is found, with both endpoints open",
		verdict(manual).periods, ["2025-05", "2025-06", "2026-01"]);
	setLocks(["2025-12"]); rebuild();
	check("SPAN: a single interior month still refuses", verdict(manual).periods, ["2025-12"]);
	setLocks(["2025-03", "2026-09"]); rebuild();
	check("SPAN: months OUTSIDE the billing range are not attributed to it",
		verdict(manual).blocked, false);
	// Reversed dates must not silently pass by walking away from the far end.
	const reversed = inv({ id: 901, week_start: "2026-08-31", week_end: "2025-04-01" });
	setLocks(["2025-12"]); rebuild();
	check("SPAN: reversed start/end is still walked (sorted, not assumed)",
		verdict(reversed).periods, ["2025-12"]);
	// ⚠️ AN ABSURD SPAN REFUSES; IT MUST NOT TRUNCATE. Examining a prefix and
	// reporting "no locked month" is the endpoints bug one order of magnitude out.
	const absurd = inv({ id: 902, week_start: "1900-01-01", week_end: "2026-08-31" });
	setLocks([]); rebuild();
	check("SPAN: a span beyond the cap is REFUSED, not truncated", verdict(absurd).blocked, true);
	check("...and names no month (a date problem, not a month-end)", verdict(absurd).periods, [""]);

	// ── fail-closed rungs ───────────────────────────────────────────────────
	breakLocks(); rebuild();
	check("UNREADABLE lock table -> refused (unreadable, not silently open)",
		verdict(inv()), { unreadable: true, blocked: false, periods: [] });
	healLocks(); setLocks([]); rebuild();

	// An unparseable week date is refused even though every month it CAN read is
	// open — the readable half says nothing about the half it cannot read.
	for (const bad of [
		{ label: "week_end blank", row: inv({ week_end: "" }) },
		{ label: "week_start blank", row: inv({ week_start: "" }) },
		{ label: "both blank", row: inv({ week_start: "", week_end: "" }) },
		{ label: "week_end junk", row: inv({ week_end: "not-a-date" }) },
		{ label: "week_end month 13", row: inv({ week_end: "2026-13-01" }) },
	]) {
		check(`UNPARSEABLE (${bad.label}) -> refused`, verdict(bad.row).blocked, true);
		// ⚠️ AND IT MUST NOT NAME A MONTH. periodBlockedResponse() reads a [""] as
		// PERIOD_UNRESOLVED; naming a month here would send an admin to reopen a
		// period that was never closed, when the real remedy is to fix the date.
		check(`...and names no month (audits PERIOD_UNRESOLVED)`, verdict(bad.row).periods, [""]);
		// ⚠️ AND IT CARRIES ITS OWN REMEDY. The month-end sentence — "reopen the
		// affected period" — names no period here (the wire `periods` is empty) and
		// points at a route that cannot edit a week date, so it is a dead end.
		check(`...and offers a remedy about the DATE, not about reopening a month`,
			[/dates/i.test(remedyOf(bad.row)), /reopen/i.test(remedyOf(bad.row))], [true, false]);
	}
	// PAIRED — a genuine month-end refusal must NOT carry the date remedy, or the
	// override swallows the one instruction that does work.
	setLocks(["2026-05"]); rebuild();
	check("a real month-end refusal carries NO date remedy (falls back to reopen)",
		remedyOf(inv()), "");
	setLocks([]); rebuild();

	// A well-formed date the regex accepts but the calendar does not is out of
	// scope on purpose: '2026-02-31' slices to '2026-02', which is the right month.
	setLocks(["2026-02"]); rebuild();
	check("an impossible DAY still resolves to the right MONTH",
		verdict(inv({ week_start: "2026-02-28", week_end: "2026-02-31" })).periods, ["2026-02"]);
	setLocks([]); rebuild();

	// A full ISO timestamp (what a future writer might store) slices identically.
	check("an ISO timestamp week date resolves to its month",
		verdict(inv({ week_start: "2026-05-09T00:00:00.000Z", week_end: "2026-05-15T00:00:00.000Z" })).blocked, false);

	// ── production corroboration ────────────────────────────────────────────
	if (PROD && PROD.invoices.length) {
		setLocks(PROD.locks.filter((l) => l.status === "locked").map((l) => l.period)); rebuild();
		const straddling = PROD.invoices.filter((i) =>
			String(i.week_start || "").slice(0, 7) !== String(i.week_end || "").slice(0, 7));
		check("production really does carry month-straddling weeks (or this case is untested)",
			straddling.length > 0, true);
		// ⚠️ The corroboration that matters: every straddling invoice is judged on
		// BOTH months, so a one-ended guard would answer differently here.
		for (const i of straddling) {
			const both = [String(i.week_start).slice(0, 7), String(i.week_end).slice(0, 7)];
			const expected = [...new Set(both.filter((m) => G.isLocked(m)))].sort();
			check(`production invoice #${i.id} (${i.week_start}..${i.week_end}) names exactly its locked months`,
				verdict(i).periods.filter(Boolean), expected);
		}
		// Nothing in production is refused for an unreadable DATE — every week date
		// parses — so any [""] here would be a false positive of the strict rung.
		const unresolved = PROD.invoices.filter((i) => verdict(i).periods.some((p) => !p));
		check("no production invoice trips the unparseable-date rung", unresolved.map((i) => i.id), []);
		// And a PAID invoice is not refused merely for being paid: at least one paid
		// row must sit in an open month, or this corroboration is vacuous.
		const paidOpenProd = PROD.invoices.filter((i) =>
			String(i.paid_at || "").trim() && !verdict(i).blocked);
		const paidLocked = PROD.invoices.filter((i) => String(i.paid_at || "").trim() && verdict(i).blocked);
		check("production paid invoices split by MONTH, not by paid_at",
			paidOpenProd.length + paidLocked.length > 0 && paidLocked.every((i) =>
				[String(i.week_start).slice(0, 7), String(i.week_end).slice(0, 7)].some((m) => G.isLocked(m))), true);
	} else {
		console.log("   (app.db absent or unreadable — production corroboration skipped)");
	}

	// ── 5. mutants ──────────────────────────────────────────────────────────
	section("5. mutants (each must be caught)");

	const BASE = [
		extract("periodLockStmt"), extract("isLocked"), extract("periodLocksReadable"),
		// ⚠️ scrubPurgeMarker is not optional dressing — auditText() DELEGATES to it,
		// so omitting it makes every extraction here throw `scrubPurgeMarker is not
		// defined` at call time rather than at build time. It landed when the
		// [PERIOD_ purge-marker injection was closed; extracting a function without
		// its callees is the standing hazard of this whole extract() approach, and
		// it fails loudly here only because section 4 actually executes the result.
		extract("scrubPurgeMarker"),
		extract("periodLabel"), extract("auditText"), extract("invoiceMonthLockBlockers"),
	].join("\n");

	function mutantCaught(label, mutate, probe) {
		let caught = false;
		try {
			const mutated = mutate(BASE);
			if (mutated === BASE) throw new Error("mutation did not change the source");
			caught = !probe(buildGuard(mutated));
		} catch { caught = true; }
		check(`M: ${label} is caught`, caught, true);
	}

	// M1 — POLARITY INVERTED, i.e. the payouts sibling copied verbatim. Blocks
	// every legitimate edit and allows every illegitimate one, and returns a
	// perfectly plausible 409 either way.
	setLocks(["2026-05"]); rebuild();
	mutantCaught("an inverted polarity (refuse while OPEN)",
		(s) => s.replace("resolved.filter((r) => isLocked(r.month))", "resolved.filter((r) => !isLocked(r.month))"),
		(M) => M.invoiceMonthLockBlockers(inv()).blockers.length > 0);

	// M2 — the `paid_at` rung reinstated, i.e. invoiceRowPeriodLocked() reused. The
	// finalized case still passes; what breaks is the owner's requirement, which is
	// exactly why that case is asserted separately above.
	mutantCaught("a reinstated paid_at rung (the owner's 2026-06-11 ask, deleted)",
		(s) => s.replace("if (!periodLocksReadable()) return { unreadable: true, blockers: [] };",
			"if (String((inv && inv.paid_at) || '').trim()) return { unreadable: false, blockers: [{ table: 'invoices', rows: 1, periods: [''], detail: 'paid' }] };\n\tif (!periodLocksReadable()) return { unreadable: true, blockers: [] };"),
		(M) => { setLocks([]); const M2 = M; return M2.invoiceMonthLockBlockers(inv({ status: "Paid", paid_at: "2026-05-20T10:00:00.000Z" })).blockers.length === 0; });

	// M3 — only week_start is read. Passes every same-month fixture and silently
	// waves through the straddling week whose LOCKED half is week_end.
	mutantCaught("a one-ended week (week_end ignored)",
		(s) => s.replace(`for (const col of ["week_start", "week_end"]) {`, `for (const col of ["week_start"]) {`),
		(M) => { setLocks(["2026-05"]); return M.invoiceMonthLockBlockers(straddle).blockers.length > 0; });

	// M3b — the ENDPOINTS-ONLY guard, i.e. the shape this file's first draft
	// shipped. Every weekly fixture still passes; only a manual invoice spanning a
	// locked range with open endpoints exposes it.
	mutantCaught("an endpoints-only guard (the span's interior ignored)",
		(s) => s.replace("const locked = span.filter(isLocked).sort();",
			"const locked = [lo, hi].filter(isLocked).sort();"),
		(M) => { setLocks(["2025-12"]); return M.invoiceMonthLockBlockers(manual).blockers.length > 0; });

	// M3c — the span cap TRUNCATES instead of refusing, so an absurd span is judged
	// on a 120-month prefix and reported as clean.
	mutantCaught("a span cap that truncates rather than refuses",
		(s) => s.replace("if (span[span.length - 1] !== hi) {", "if (false) {"),
		(M) => { setLocks([]); return M.invoiceMonthLockBlockers(absurd).blockers.length > 0; });

	// M4 — the unreadable-lock rung fails OPEN, the exact fail-open isLocked()
	// produces on its own and the reason periodWriteLocked() exists.
	mutantCaught("an unreadable lock table that fails OPEN",
		(s) => s.replace("if (!periodLocksReadable()) return { unreadable: true, blockers: [] };", ""),
		(M) => { breakLocks(); const r = M.invoiceMonthLockBlockers(inv()); healLocks(); setLocks([]); return r.unreadable === true; });
	rebuild();

	// M5 — the unparseable-date rung is loosened back to invoiceRowPeriodLocked()'s
	// "refuse only when NEITHER end parses". The straddling invoice with one
	// unreadable end is then judged on half the evidence.
	mutantCaught("a loosened unparseable-date rung (only refuse when NEITHER parses)",
		(s) => s.replace("if (unreadableDates.length) {", "if (unreadableDates.length === 2) {"),
		(M) => { setLocks([]); return M.invoiceMonthLockBlockers(inv({ week_end: "" })).blockers.length > 0; });

	// M6 — the unparseable case NAMES a month instead of [""], so the refusal
	// audits as PERIOD_FINALIZED and tells an admin to reopen an open month.
	mutantCaught("an unparseable date audited as a finalized month",
		(s) => s.replace("periods: [\"\"],", "periods: [\"2026-05\"],"),
		(M) => { setLocks([]); return M.invoiceMonthLockBlockers(inv({ week_end: "" })).blockers[0].periods.join("") === ""; });

	// M7 — the month regex loosened back to a bare shape test. "2026-13" then
	// RESOLVES, matches no lock row (none can exist), and the row is waved through
	// as an open month — a fail-OPEN on exactly the malformed date the unresolved
	// rung exists to withhold. This mutant IS the bug this file found in the first
	// draft of the guard, kept so it cannot come back.
	//
	// ⚠️ BOTH dates are in the impossible month, deliberately. With only ONE of them
	// out of range the span walk can never reach `hi`, so the span cap refuses the
	// row for a different reason and the mutant survives a weaker probe — a genuine
	// second line of defence, but not the one under test here.
	mutantCaught("a shape-only month test (2026-13 resolves and is never locked)",
		(s) => s.replace("const MONTH = /^\\d{4}-(0[1-9]|1[0-2])$/;", "const MONTH = /^\\d{4}-\\d{2}$/;"),
		(M) => { setLocks([]); return M.invoiceMonthLockBlockers(
			inv({ week_start: "2026-13-01", week_end: "2026-13-07" })).blockers.length > 0; });
});

// The read-side predicate, built separately so the paired assertion above can
// compare the two without the mutant harness reaching it.
function buildGuardRow() {
	const body = [
		extract("periodLockStmt"), extract("isLocked"), extract("periodLocksReadable"),
		extract("invoiceRowPeriodLocked"),
	].join("\n");
	return new Function("db", `${body}\n return invoiceRowPeriodLocked;`)(db);
}

db.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("\nFailures:");
	for (const f of failures) console.log(f);
	process.exit(1);
}
