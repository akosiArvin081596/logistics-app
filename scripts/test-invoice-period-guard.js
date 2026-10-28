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
// Section 7: with INVOICE_CLOSED_MONTH_GUARD_ENABLED exactly "true", no weekly or
// manual invoice is generated, regenerated, created, deleted or restored in a span
// touching a closed month, and the Friday batch counts such a driver skipped; flag
// off, each case is pinned to today's behaviour. Its handlers run lifted from
// server.js on an in-memory SQLite, with the server's own audit writer.
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

	const inv = (o) => ({ id: 7, invoice_number: "INV-SK-2026W19-01", driver: "soren king",
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

// ── 6. the adjust route's finalized refusal, in plain words ─────────────────
// The 409's `error` is the toast an admin reads on the Invoices screen, so the
// adjust route's finalized-month refusal names the months and where corrections
// go (a manual invoice dated in the current month; closed months are never
// reopened, 2026-10-14), and no API path. Only that string changes: the status, `code`, `periods`,
// `unresolved`, `blockers` and the audit call are asserted as before, and the
// unresolved-date and unreadable-lock refusals keep their own text.
//
// The REAL route runs, lifted from server.js with the real guard and response
// helpers on the in-memory db above; only the audit recorder is captured.
const PLAIN_TAIL = "so this invoice can't be changed. For a correction, create a manual invoice (New Manual Invoice) dated in the current month.";

async function section6() {
	section("6. the adjust route's finalized refusal (real route, real helpers)");

	healLocks();
	db.exec(`CREATE TABLE invoices (id INTEGER PRIMARY KEY, invoice_number TEXT, driver TEXT,
		week_start TEXT, week_end TEXT, status TEXT, adjustment REAL DEFAULT 0, deleted_at TEXT)`);
	const addInvoice = db.prepare(
		"INSERT INTO invoices (id, invoice_number, driver, week_start, week_end, status) VALUES (?, ?, ?, ?, ?, ?)");
	// A Sat–Fri week straddling September and October 2026, so one invoice gives
	// both the one-month and the two-month sentence.
	addInvoice.run(39, "INV-SK-2026W39-01", "soren king", "2026-09-26", "2026-10-02", "Approved");
	addInvoice.run(41, "INV-SK-2026W41-01", "soren king", "2026-10-10", "", "Draft");
	const row = (id) => db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);

	const remedyConst = /\nconst INVOICE_LOCK_REMEDY =[^;]*;/.exec(SRC);
	if (!remedyConst) throw new Error("INVOICE_LOCK_REMEDY not found in server.js");

	const mkRes = () => {
		const out = { status: 0, body: null };
		return { out, res: { status(c) { out.status = c; return { json(b) { out.body = b; return b; } }; } } };
	};
	const build = () => {
		const handlers = [];
		const recorded = [];
		const R = new Function("db", "INVOICE_MAX_SPAN_MONTHS", "AUDITED_UPSTREAM", "recordPeriodRefusal",
			"app", "requireRole", "refuseCrossOrigin", [
				extract("periodLockStmt"), extract("isLocked"), extract("periodLocksReadable"),
				extract("scrubPurgeMarker"), extract("periodLabel"), extract("auditText"), extract("auditReasonNote"),
				extract("invoiceMonthLockBlockers"), extract("periodBlockedResponse"), extract("periodLockUnreadableResponse"),
				remedyConst[0], `${ADJUST};`,
				"return { invoiceMonthLockBlockers, periodBlockedResponse };",
			].join("\n"))(
			db, MAX_SPAN, Symbol("AUDITED_UPSTREAM"),
			(audit, code, periods, what) => recorded.push({
				action: audit.action, entity: audit.entity, entityId: audit.entityId, code, periods, what }),
			{ put: (p, ...hs) => handlers.push(hs[hs.length - 1]) },
			() => () => {}, () => {});
		if (handlers.length !== 1) throw new Error(`the adjust route registered ${handlers.length} handlers, expected 1`);
		R.adjust = async (id) => {
			recorded.length = 0;
			const { out, res } = mkRes();
			await handlers[0]({ params: { id: String(id) }, body: { adjustment: -300, adjustmentNote: "test" },
				session: { user: { id: 1, username: "super_admin", role: "Super Admin" } } }, res);
			return { ...out, recorded: recorded.slice() };
		};
		return R;
	};
	const errorOf = (r) => (r.body && r.body.error) || "";

	setLocks(["2026-09"]);
	let R = build();
	let r = await R.adjust(39);
	check("ONE MONTH: the refusal is a 409", r.status, 409);
	check("...worded in plain language", errorOf(r), `September 2026 is closed, ${PLAIN_TAIL}`);
	check("...naming no API path", /\/api\//.test(errorOf(r)), false);
	check("...and the rest of the body is as before (code, periods, unresolved, blockers)",
		r.body && [r.body.code, r.body.periods, r.body.unresolved, r.body.blockers],
		["PERIOD_FINALIZED", ["2026-09"], false, R.invoiceMonthLockBlockers(row(39)).blockers]);
	check("...with the same audit call (adjust_invoice_blocked, PERIOD_FINALIZED, the month)", r.recorded,
		[{ action: "adjust_invoice_blocked", entity: "invoice", entityId: "39",
			code: "PERIOD_FINALIZED", periods: ["2026-09"], what: "Cannot adjust INV-SK-2026W39-01" }]);

	setLocks(["2026-09", "2026-10"]);
	R = build();
	r = await R.adjust(39);
	check("TWO MONTHS: both named, in the order of the wire `periods`",
		errorOf(r), `September 2026, October 2026 are closed, ${PLAIN_TAIL}`);
	check("...naming no API path", /\/api\//.test(errorOf(r)), false);
	check("...and the rest of the body is as before",
		[r.status, r.body && r.body.code, r.body && r.body.periods, r.body && r.body.unresolved],
		[409, "PERIOD_FINALIZED", ["2026-09", "2026-10"], false]);
	check("...with the same audit call", r.recorded.map((x) => [x.action, x.code, x.periods]),
		[["adjust_invoice_blocked", "PERIOD_FINALIZED", ["2026-09", "2026-10"]]]);

	// ⚠️ PAIRED: an unresolved week date keeps the helper's composed refusal and
	// its own date remedy; no month is finalized there, so the plain sentence
	// would be false.
	setLocks([]);
	R = build();
	{
		const lock = R.invoiceMonthLockBlockers(row(41));
		const composed = mkRes();
		R.periodBlockedResponse({}, composed.res, "Cannot adjust INV-SK-2026W41-01", lock.blockers, lock.remedy,
			{ action: "adjust_invoice_blocked" });
		r = await R.adjust(41);
		check("UNRESOLVED DATE: the composed refusal, unchanged", errorOf(r), composed.out.body && composed.out.body.error);
		check("...ending on the date remedy, not the plain sentence",
			[errorOf(r).endsWith(lock.remedy), errorOf(r).includes(PLAIN_TAIL)], [true, false]);
		check("...and audited PERIOD_UNRESOLVED", r.recorded.map((x) => x.code), ["PERIOD_UNRESOLVED"]);
	}

	// ⚠️ PAIRED: an unreadable lock table keeps its own refusal.
	breakLocks();
	R = build();
	r = await R.adjust(39);
	check("UNREADABLE LOCKS: its own refusal, not the plain sentence",
		[r.status, r.body && r.body.code, /could not be read/.test(errorOf(r)), errorOf(r).includes(PLAIN_TAIL)],
		[409, "PERIOD_LOCK_UNREADABLE", true, false]);
	healLocks();

	// ⚠️ THE HELPER'S OWN RULE, pinned for any later caller (the adjust route can
	// never reach these shapes): a refusal that also carries an unresolved date,
	// or that names no month at all, keeps the composed text even when a
	// finalizedMessage is passed. Each half of the condition has its own case.
	R = build();
	{
		const plain = (labels) => `${labels.join(", ")} ${labels.length === 1 ? "is" : "are"} finalized, ${PLAIN_TAIL}`;
		const both = (blockers) => {
			const withMsg = mkRes();
			const without = mkRes();
			R.periodBlockedResponse({}, withMsg.res, "Cannot adjust X", blockers, "REMEDY.", { action: "t" }, plain);
			R.periodBlockedResponse({}, without.res, "Cannot adjust X", blockers, "REMEDY.", { action: "t" });
			return [errorOf(withMsg.out), errorOf(without.out)];
		};
		const [mixedWith, mixedWithout] = both([
			{ table: "invoices", rows: 1, periods: ["2026-09"], detail: "a" },
			{ table: "invoices", rows: 1, periods: [""], detail: "b" },
		]);
		check("MIXED finalized + unresolved: the composed text even with a finalizedMessage",
			[mixedWith === mixedWithout, mixedWith.includes(PLAIN_TAIL)], [true, false]);
		const [noneWith, noneWithout] = both([{ table: "invoices", rows: 1, periods: [], detail: "c" }]);
		check("NO month named: the composed text even with a finalizedMessage",
			[noneWith === noneWithout, noneWith.includes(PLAIN_TAIL)], [true, false]);
	}

	// The plain sentence is the adjust route's alone: mark-paid and revert keep theirs.
	check("the plain sentence is in server.js once, in the adjust route",
		[SRC.split(PLAIN_TAIL).length - 1, ADJUST.includes(PLAIN_TAIL)], [1, true]);
}

// ── 7. closed months: generate, regenerate, manual, delete, restore, batch ──
// Closed months are never changed. The routes run lifted from server.js
// (scripts/lib/server-lift.js) on scripts/lib/work-days-world.js's schema, with
// the server's own logAudit, so each refusal's audit row is read back. A world
// is one start: env, locks and the clock are its own. Made-up data only.
const CM_FLAG = "INVOICE_CLOSED_MONTH_GUARD_ENABLED";
const CM_A = "Test Driver A";
const CM_B = "Test Driver B";
// Fri 2026-11-13 12:00 Eastern. W38 Sat 09-19..Fri 09-25 (September), W39
// 09-26..10-02 (September and October), W41 10-10..10-16 (October).
const CM_NOW = Date.parse("2026-11-13T17:00:00Z");

async function section7() {
	section("7. closed months: generate, regenerate, manual, delete, restore and the Friday batch");
	// Production's clock zone.
	process.env.TZ = "UTC";
	const { createRequire } = require("module");
	const W7 = require(path.join(ROOT, "scripts", "lib", "work-days-world.js"));
	const { closure, codeIdentifiers } = require(path.join(ROOT, "scripts", "lib", "server-lift.js"));
	const personalExpense = require(path.join(ROOT, "lib", "personal-expense.js"));

	const LINES = SRC.split("\n");
	const head = (method, p) => {
		const heads = LINES.filter((l) => l.startsWith(`app.${method}(${JSON.stringify(p)},`));
		if (heads.length !== 1) throw new Error(`expected one registration of ${method.toUpperCase()} ${p}, found ${heads.length}`);
		return heads[0];
	};
	// The two names work-days-world lifts by hand (a call after a comment ending in
	// "." is missed by the closure walk).
	const named = [
		...["assertInvoiceFileStillOwn"].filter((n) => SRC.includes(`\nfunction ${n}(`)),
		...["_jtInflight"].filter((n) => SRC.includes(`\nlet ${n} =`)),
	];
	const L7 = closure(SRC, {
		roots: ["generateInvoiceHandler", "runWeeklyInvoiceBatch", "parseSheet", "deduplicateLoads", ...named],
		routes: [head("post", "/api/invoices/manual"), head("delete", "/api/invoices/:id"), head("put", "/api/invoices/:id/restore")],
		provided: ["db", "require", "console", "process", "__dirname", "Date", "app", "requireRole", "requireAuth", "refuseCrossOrigin",
			"notifyChange", "getJobTrackingCached", "getSheets", "SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "renderPolicy", "fs",
			"DATA_DIR", "fetch", "io", "sendEmail", "setTimeout"],
		denied: ["server", "transporter", "getDrive", "KEY_FILE"],
	});

	const ROWS = [
		W7.loadRow({ id: "CM38", driver: CM_A, pickup: "2026-09-21 8:00", dropoff: "2026-09-22 18:00", assigned: "2026-09-21", done: "2026-09-22", truck: "T1" }),
		W7.loadRow({ id: "CM39", driver: CM_A, pickup: "2026-09-30 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-09-30", done: "2026-10-01", truck: "T1" }),
		W7.loadRow({ id: "CM41", driver: CM_A, pickup: "2026-10-12 8:00", dropoff: "2026-10-13 18:00", assigned: "2026-10-12", done: "2026-10-13", truck: "T1" }),
	];
	const lockMonths = (wdb, periods) => {
		const ins = wdb.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES (?, 'locked', '2026-11-08T05:00:00.000Z', 'test')");
		for (const p of periods) ins.run(p);
	};
	// The break periodLocksReadable() exists for: the table without its `status`.
	const breakLockTable = (wdb) => wdb.exec("DROP TABLE period_locks; CREATE TABLE period_locks (period TEXT PRIMARY KEY)");

	// One server start. flag: the flag's raw value (undefined = unset); rows: Job Tracking.
	function world({ flag, locks = [], personal = false, rows = ROWS } = {}) {
		const wdb = W7.schemaDb();
		if (personal) wdb.exec(personalExpense.SCHEMA_SQL);
		const user = wdb.prepare("INSERT INTO users (id, username, password_hash, role, company_name, driver_name) VALUES (?, ?, 'x', ?, ?, ?)");
		user.run(1, "super_admin", "Super Admin", "", "");
		user.run(4, "drivera", "Driver", "Acme Carrier", CM_A);
		user.run(5, "inv5", "Investor", "Acme Carrier", "");
		wdb.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (5, 'Ivy Investor', 'Acme Carrier')").run();
		wdb.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
		const dir = wdb.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_daily, pay_percentage) VALUES (?, 'Acme Carrier', 'fixed', ?, 0)");
		dir.run(CM_A, 300);
		dir.run(CM_B, 250);
		const truck = wdb.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, assigned_driver, driver_pay_daily)
			VALUES (?, ?, 5, 'Active', '2026-08-01', '2026-08-01 00:00:00', ?, 0)`);
		truck.run(1, "T1", CM_A);
		truck.run(2, "T2", CM_B);
		const assign = wdb.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (?, ?, '2026-08-01T17:00:00.000Z')");
		assign.run(1, CM_A);
		assign.run(2, CM_B);
		lockMonths(wdb, locks);

		const w = { db: wdb, dataDir: W7.tempDir(), routes: {}, rendered: [], onRender: null, emails: [], clock: { ms: CM_NOW } };
		class FixedDate extends Date {
			constructor(...args) { super(...(args.length ? args : [w.clock.ms])); }
			static now() { return w.clock.ms; }
		}
		const register = (method) => (p, ...h) => { w.routes[`${method} ${p}`] = h[h.length - 1]; };
		const pass = () => (req, res, next) => (next ? next() : undefined);
		const sheet = () => W7.sheetValues(rows);
		const deps = {
			db: wdb,
			require: createRequire(path.join(ROOT, "server.js")),
			console: { log() {}, info() {}, warn() {}, error() {} },
			process: { env: { INVOICE_UNDATED_ALERT_ENABLED: "false", ...(flag === undefined ? {} : { [CM_FLAG]: flag }) }, argv: [], cwd: () => ROOT, pid: 4245 },
			__dirname: ROOT,
			Date: FixedDate,
			app: { get: register("GET"), put: register("PUT"), post: register("POST"), delete: register("DELETE"), use() {} },
			requireRole: pass,
			requireAuth: pass(),
			refuseCrossOrigin: pass(),
			notifyChange: () => {},
			getJobTrackingCached: null,
			getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: sheet() } }) } } }),
			SPREADSHEET_ID: "test-sheet",
			REPLICA: null,
			SHEET_TARGET: null,
			renderPolicy: async (templateName) => {
				if (w.onRender) await w.onRender();
				w.rendered.push(templateName);
				return Buffer.from("%PDF-stub");
			},
			fs,
			DATA_DIR: w.dataDir,
			fetch: () => { throw new Error("no network in a test"); },
			io: null,
			sendEmail: async (to, subject, html) => { w.emails.push({ subject, html: String(html || "") }); },
			// The batch's 90 s per-driver race timers must not hold the run open.
			setTimeout: (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); if (t && t.unref) t.unref(); return t; },
		};
		const body = [
			'"use strict";',
			L7.text,
			"getJobTrackingCached = async () => { const p = parseSheet({ values: __sheet() }); p.data = deduplicateLoads(p.data, p.headers); return p; };",
			"return { generateInvoiceHandler, runWeeklyInvoiceBatch };",
		].join("\n");
		w.api = new Function(...Object.keys(deps), "__sheet", body)(...Object.values(deps), sheet);
		return w;
	}

	const ADMIN = { id: 1, role: "Super Admin", username: "super_admin" };
	const DRIVER = { id: 4, role: "Driver", username: "drivera", driverName: CM_A };
	const gen = (w, user, weekEnd) => W7.call(w.api.generateInvoiceHandler,
		{ session: { user: { ...user } }, headers: {}, query: {}, params: {}, body: { driver: CM_A, weekEnd } });
	const route = (w, key, { params = {}, query = {}, body = {} } = {}) => {
		if (!w.routes[key]) throw new Error(`${key} is not registered`);
		return W7.call(w.routes[key], { session: { user: { ...ADMIN } }, headers: {}, query, params, body });
	};
	const weekRows = (w, weekStart) => w.db.prepare("SELECT * FROM invoices WHERE week_start = ? AND is_manual = 0 ORDER BY id").all(weekStart);
	const manualRows = (w) => w.db.prepare("SELECT id, week_start, week_end FROM invoices WHERE is_manual = 1 ORDER BY id").all();
	const pdfFiles = (w) => {
		const d = path.join(w.dataDir, "uploads", "invoices");
		return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
	};
	const blocked = (w, action) => w.db.prepare("SELECT username, role, entity, entity_id, details FROM audit_trail WHERE action = ? ORDER BY id").all(action)
		.map((a) => ({
			username: a.username, role: a.role, entity: a.entity, entityId: a.entity_id,
			code: (/\[(PERIOD_[A-Z_]+)\]/.exec(a.details) || [])[1] || "",
			periods: (/\] periods=([0-9,-]+)/.exec(a.details) || [])[1] || "",
		}));
	const insertInvoice = (wdb, o) => {
		const row = {
			invoice_number: "INV-TDA-2026W39-01", driver: "test driver a", week_start: "2026-09-26", week_end: "2026-10-02",
			loads_count: 2, rate_per_load: 300, total_earnings: 600, expenses_total: 0, status: "Approved", pdf_file_name: "",
			load_ids: "[]", expense_ids: "[]", render_data: "{}", adjustment: 0, is_manual: 0, deleted_at: "", ...o,
		};
		const cols = Object.keys(row);
		return Number(wdb.prepare(`INSERT INTO invoices (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c])).lastInsertRowid);
	};
	const errorOf = (r) => (r.body && r.body.error) || "";
	const run = async (label, fn) => {
		try { await fn(); } catch (err) { fail++; failures.push(`  ${label}\n      threw: ${err.message}`); }
	};

	// 7a. A week wholly in a closed month, from the driver app and from a Super Admin.
	await run("7a (generate in a closed month)", async () => {
		const w = world({ flag: "true", locks: ["2026-09"] });
		const r = await gen(w, DRIVER, "2026-09-25");
		check("7a ON: a Driver generating W38 (September closed) is refused: 409 PERIOD_FINALIZED naming September",
			[r.status, r.body && r.body.code, r.body && r.body.periods, r.body && r.body.unresolved], [409, "PERIOD_FINALIZED", ["2026-09"], false]);
		check("...in plain words: the month is closed, nothing changed, the office pays a missed day on a correction dated in the current month",
			[/^September 2026 is closed, so /.test(errorOf(r)), /nothing was changed/i.test(errorOf(r)),
				/The office pays .* on a correction invoice dated in the current month/.test(errorOf(r)), /\/api\//.test(errorOf(r))], [true, true, true, false]);
		check("...refused before any work: nothing rendered, no invoice row, no PDF",
			[w.rendered.length, weekRows(w, "2026-09-19").length, pdfFiles(w)], [0, 0, []]);
		check("...audited as the driver: generate_invoice_blocked [PERIOD_FINALIZED] periods=2026-09",
			blocked(w, "generate_invoice_blocked").map((a) => [a.username, a.role, a.entity, a.code, a.periods]),
			[["drivera", "Driver", "invoice", "PERIOD_FINALIZED", "2026-09"]]);
		const s = await gen(w, ADMIN, "2026-09-25");
		check("7a ON: a Super Admin generating W38 is refused the same way",
			[s.status, s.body && s.body.code, s.body && s.body.periods, weekRows(w, "2026-09-19").length], [409, "PERIOD_FINALIZED", ["2026-09"], 0]);
		check("...audited as the Super Admin", blocked(w, "generate_invoice_blocked").map((a) => a.username), ["drivera", "super_admin"]);
		const open = await gen(w, ADMIN, "2026-10-16");
		check("7a ON: a week in an open month (W41) still generates",
			[open.status, open.body && open.body.invoice && open.body.invoice.week_start, open.body && open.body.invoice && open.body.invoice.status],
			[200, "2026-10-10", "Draft"]);
		const off = world({ locks: ["2026-09"] });
		const o = await gen(off, DRIVER, "2026-09-25");
		check("7a OFF (pin, today): the Driver's W38 invoice is generated in the closed month",
			[o.status, weekRows(off, "2026-09-19").map((x) => x.status)], [200, ["Draft"]]);
	});

	// 7b. A Saturday-Friday week straddling a closed and an open month.
	await run("7b (straddling week)", async () => {
		const w = world({ flag: "true", locks: ["2026-09"] });
		const r = await gen(w, ADMIN, "2026-10-02");
		check("7b ON: W39 (September closed, October open) is refused, naming September",
			[r.status, r.body && r.body.periods, weekRows(w, "2026-09-26").length], [409, ["2026-09"], 0]);
		const w2 = world({ flag: "true", locks: ["2026-10"] });
		const r2 = await gen(w2, ADMIN, "2026-10-02");
		check("...and with only October closed, refused naming October",
			[r2.status, r2.body && r2.body.periods, weekRows(w2, "2026-09-26").length], [409, ["2026-10"], 0]);
		const off = world({ locks: ["2026-09"] });
		const o = await gen(off, ADMIN, "2026-10-02");
		check("7b OFF (pin, today): W39 is generated", [o.status, weekRows(off, "2026-09-26").length], [200, 1]);
	});

	// 7c. A Draft made while its month was open, regenerated after the month closed.
	await run("7c (Draft regenerate)", async () => {
		for (const flag of ["true", undefined]) {
			const w = world({ flag });
			const first = await gen(w, ADMIN, "2026-10-02");
			const before = weekRows(w, "2026-09-26");
			lockMonths(w.db, ["2026-09"]);
			const again = await gen(w, ADMIN, "2026-10-02");
			const byDriver = await gen(w, DRIVER, "2026-10-02");
			const after = weekRows(w, "2026-09-26");
			if (flag === "true") {
				check("7c ON: a Draft regenerated after September closed is refused, by the Super Admin and by the Driver",
					[first.status, before.length, again.status, again.body && again.body.periods, byDriver.status], [200, 1, 409, ["2026-09"], 409]);
				check("...and the Draft stays exactly as it was (row, number, PDF name, render)", after, before);
			} else {
				check("7c OFF (pin, today): the regenerate re-mints the Draft: a new row under the same number",
					[first.status, again.status, byDriver.status, after.length, after[0] && after[0].id !== before[0].id, after[0] && after[0].invoice_number === before[0].invoice_number],
					[200, 200, 200, 1, true, true]);
			}
		}
	});

	// 7d. The month closes during the request's awaits (here, its render): the
	// guard passed at the start, so only the write's own check can refuse.
	await run("7d (re-check at the write)", async () => {
		for (const flag of ["true", undefined]) {
			const w = world({ flag });
			w.onRender = async () => { lockMonths(w.db, ["2026-10"]); };
			const r = await gen(w, ADMIN, "2026-10-16");
			if (flag === "true") {
				check("7d ON: October closing while W41 renders refuses the write: 409 naming October",
					[w.rendered.length, r.status, r.body && r.body.code, r.body && r.body.periods], [1, 409, "PERIOD_FINALIZED", ["2026-10"]]);
				check("...nothing saved: no row, no PDF, no temporary file", [weekRows(w, "2026-10-10").length, pdfFiles(w)], [0, []]);
				check("...audited once, naming October",
					blocked(w, "generate_invoice_blocked").map((a) => [a.username, a.code, a.periods]), [["super_admin", "PERIOD_FINALIZED", "2026-10"]]);
			} else {
				check("7d OFF (pin, today): the write does not look again; the invoice is saved",
					[r.status, weekRows(w, "2026-10-10").length, pdfFiles(w).length], [200, 1, 1]);
			}
		}
	});

	// 7e. POST /api/invoices/manual.
	await run("7e (manual invoice)", async () => {
		const manual = (start, end) => ({ payee: CM_A, payeeAddress: "", payeePhone: "", periodStart: start, periodEnd: end,
			lineItems: [{ description: "Made-up correction line", amount: 300 }], deductions: [] });
		const w = world({ flag: "true", locks: ["2026-09"] });
		const r = await route(w, "POST /api/invoices/manual", { body: manual("2026-09-01", "2026-09-30") });
		check("7e ON: a manual invoice dated in closed September is refused: 409 naming September, no row, nothing rendered",
			[r.status, r.body && r.body.code, r.body && r.body.periods, manualRows(w).length, w.rendered.length], [409, "PERIOD_FINALIZED", ["2026-09"], 0, 0]);
		check("...in plain words, pointing at the current month",
			[/^September 2026 is closed, so /.test(errorOf(r)), /dated in the current month/.test(errorOf(r)), /\/api\//.test(errorOf(r))], [true, true, false]);
		check("...audited create_manual_invoice_blocked",
			blocked(w, "create_manual_invoice_blocked").map((a) => [a.username, a.entity, a.code, a.periods]), [["super_admin", "invoice", "PERIOD_FINALIZED", "2026-09"]]);
		const span = await route(w, "POST /api/invoices/manual", { body: manual("2026-08-01", "2026-10-31") });
		check("...a period with the closed month inside it (both ends open) is refused too",
			[span.status, span.body && span.body.periods, manualRows(w).length], [409, ["2026-09"], 0]);
		const open = await route(w, "POST /api/invoices/manual", { body: manual("2026-10-01", "2026-10-31") });
		check("7e ON: a manual invoice dated in the open month is created (the remedy works)", [open.status, manualRows(w).length], [200, 1]);
		const late = world({ flag: "true" });
		late.onRender = async () => { lockMonths(late.db, ["2026-10"]); };
		const l = await route(late, "POST /api/invoices/manual", { body: manual("2026-10-01", "2026-10-31") });
		check("7e ON: October closing while a manual invoice renders refuses its write: 409, no row, no PDF",
			[late.rendered.length, l.status, l.body && l.body.periods, manualRows(late).length, pdfFiles(late)], [1, 409, ["2026-10"], 0, []]);
		const off = world({ locks: ["2026-09"] });
		const o = await route(off, "POST /api/invoices/manual", { body: manual("2026-09-01", "2026-09-30") });
		check("7e OFF (pin, today): the manual invoice dated in September is created", [o.status, manualRows(off).length], [200, 1]);
	});

	// 7f. DELETE /api/invoices/:id.
	await run("7f (delete)", async () => {
		for (const flag of ["true", undefined]) {
			const w = world({ flag, locks: ["2026-09"] });
			const closedId = insertInvoice(w.db, {});
			w.db.prepare("INSERT INTO invoice_paid_days (driver_norm, day, invoice_id) VALUES ('test driver a', '2026-09-30', ?)").run(closedId);
			const openId = insertInvoice(w.db, { invoice_number: "INV-TDA-2026W41-01", week_start: "2026-10-10", week_end: "2026-10-16", status: "Draft" });
			const r = await route(w, "DELETE /api/invoices/:id", { params: { id: String(closedId) }, query: { reason: "made-up reason" } });
			const deletedAt = w.db.prepare("SELECT deleted_at FROM invoices WHERE id = ?").get(closedId).deleted_at;
			const days = w.db.prepare("SELECT COUNT(*) AS n FROM invoice_paid_days WHERE invoice_id = ?").get(closedId).n;
			if (flag === "true") {
				check("7f ON: deleting an invoice whose week touches closed September is refused: 409, the row and its paid day stay",
					[r.status, r.body && r.body.code, r.body && r.body.periods, deletedAt, days], [409, "PERIOD_FINALIZED", ["2026-09"], "", 1]);
				check("...in plain words", [/^September 2026 is closed, so INV-TDA-2026W39-01 can't be deleted/.test(errorOf(r))], [true]);
				check("...audited delete_invoice_blocked on that invoice",
					blocked(w, "delete_invoice_blocked").map((a) => [a.entityId, a.code, a.periods]), [[String(closedId), "PERIOD_FINALIZED", "2026-09"]]);
				const o = await route(w, "DELETE /api/invoices/:id", { params: { id: String(openId) } });
				check("7f ON: an open month's invoice still deletes",
					[o.status, !!w.db.prepare("SELECT deleted_at FROM invoices WHERE id = ?").get(openId).deleted_at], [200, true]);
			} else {
				check("7f OFF (pin, today): the delete goes through and frees its paid day", [r.status, !!deletedAt, days], [200, true, 0]);
			}
		}
	});

	// 7g. PUT /api/invoices/:id/restore.
	await run("7g (restore)", async () => {
		for (const flag of ["true", undefined]) {
			const w = world({ flag, locks: ["2026-09"] });
			const gone = { deleted_at: "2026-11-01T12:00:00.000Z", deleted_by: "super_admin" };
			const closedId = insertInvoice(w.db, gone);
			const openId = insertInvoice(w.db, { ...gone, invoice_number: "INV-TDA-2026W41-01", week_start: "2026-10-10", week_end: "2026-10-16", status: "Draft" });
			const r = await route(w, "PUT /api/invoices/:id/restore", { params: { id: String(closedId) } });
			const deletedAt = w.db.prepare("SELECT deleted_at FROM invoices WHERE id = ?").get(closedId).deleted_at;
			if (flag === "true") {
				check("7g ON: restoring a deleted invoice whose week touches closed September is refused: 409, it stays deleted",
					[r.status, r.body && r.body.code, r.body && r.body.periods, deletedAt], [409, "PERIOD_FINALIZED", ["2026-09"], gone.deleted_at]);
				check("...audited restore_invoice_blocked on that invoice",
					blocked(w, "restore_invoice_blocked").map((a) => [a.entityId, a.code, a.periods]), [[String(closedId), "PERIOD_FINALIZED", "2026-09"]]);
				const o = await route(w, "PUT /api/invoices/:id/restore", { params: { id: String(openId) } });
				check("7g ON: an open month's invoice still restores",
					[o.status, w.db.prepare("SELECT deleted_at FROM invoices WHERE id = ?").get(openId).deleted_at], [200, ""]);
			} else {
				check("7g OFF (pin, today): the restore goes through", [r.status, deletedAt], [200, ""]);
			}
		}
	});

	// 7h. The Friday batch on a week touching a closed month (a late catch-up).
	await run("7h (Friday batch)", async () => {
		for (const flag of ["true", undefined]) {
			const w = world({ flag, locks: ["2026-09"] });
			const out = await w.api.runWeeklyInvoiceBatch("2026-10-02", 1);
			const marker = w.db.prepare("SELECT created, submitted, skipped, failed, summary FROM invoice_autogen_runs WHERE week_end = '2026-10-02'").get() || {};
			const rows = weekRows(w, "2026-09-26");
			if (flag === "true") {
				check("7h ON: the batch bills nobody in W39 and counts both drivers skipped, none failed (no retry)",
					[out.created, out.submitted, out.skipped, out.unbilled, out.problem, marker.skipped, marker.failed, rows.length],
					[0, 0, 2, 0, false, 2, 0, 0]);
				check("...its summary names the driver who worked that week, for a correction in the current month",
					[/closed month/i.test(String(marker.summary)), String(marker.summary).includes(CM_A), String(marker.summary).includes(CM_B)], [true, true, false]);
				check("...counts only the driver with no loads as \"skipped (no loads)\"",
					String(marker.summary).startsWith("0 generated & submitted · 1 skipped (no loads) · 1 NOT BILLED"), true);
				check("...and the run's notification asks for action",
					w.db.prepare("SELECT title FROM dispatch_notifications WHERE type = 'invoices-autogen'").all().map((n) => /ACTION NEEDED/.test(n.title)), [true]);
				const html = (w.emails[0] || {}).html || "";
				check("...the email names the driver for a correction, says 1 skipped (no loads), and never says to generate it",
					[/Not billed, the week touches a closed month:<\/b> Test Driver A\. Pay their days on a correction invoice dated in the current month\./.test(html),
						/Skipped \(no loads\)<\/span><b>1</.test(html), html.includes("Generate these from the Invoices page")],
					[true, true, false]);
			} else {
				check("7h OFF (pin, today): the batch generates and submits W39 in the closed month",
					[out.created, out.submitted, out.skipped, out.unbilled, rows.map((x) => x.status)], [1, 1, 1, 0, ["Submitted"]]);
			}
		}
		// A driver who already submitted W39 is billed: skipped as INVOICE_EXISTS is, never
		// named for a correction, and the run asks for no action.
		const w = world({ flag: "true", locks: ["2026-09"] });
		insertInvoice(w.db, { status: "Submitted" });
		const out = await w.api.runWeeklyInvoiceBatch("2026-10-02", 1);
		const marker = w.db.prepare("SELECT skipped, failed, summary FROM invoice_autogen_runs WHERE week_end = '2026-10-02'").get() || {};
		check("7h ON: a driver who already submitted W39 is not named; nothing failed, nothing asks for action",
			[out.created, out.skipped, out.unbilled, marker.failed, /closed month/i.test(String(marker.summary)),
				w.db.prepare("SELECT title FROM dispatch_notifications WHERE type = 'invoices-autogen'").all().length],
			[0, 2, 0, 0, false, 0]);

		// A live Draft for the week can still be submitted as is: named for that, not for a
		// correction (a correction beside it would pay its days twice).
		const d = world({ flag: "true", locks: ["2026-09"] });
		const draftId = insertInvoice(d.db, { status: "Draft" });
		const dOut = await d.api.runWeeklyInvoiceBatch("2026-10-02", 1);
		const dMarker = d.db.prepare("SELECT failed, summary FROM invoice_autogen_runs WHERE week_end = '2026-10-02'").get() || {};
		const dHtml = (d.emails[0] || {}).html || "";
		check("7h ON: a driver with a live Draft for W39 is named to submit it as is, not for a correction; nothing failed",
			[dOut.skipped, dOut.problem, dMarker.failed, /NOT BILLED/.test(String(dMarker.summary)),
				/1 with an unsubmitted Draft for this week, which touches a closed month \(Test Driver A\): submit it as is; only days it misses go on a correction invoice/.test(String(dMarker.summary)),
				String(dMarker.summary).startsWith("0 generated & submitted · 1 skipped (no loads)")],
			[2, false, 0, false, true, true]);
		check("...the Draft stays a Draft, and the email says to submit it",
			[d.db.prepare("SELECT status FROM invoices WHERE id = ?").get(draftId).status,
				/Unsubmitted Draft for this week, which touches a closed month:<\/b> Test Driver A\. Submit it as is/.test(dHtml), /Not billed/.test(dHtml)],
			["Draft", true, false]);

		// A driver missing from the roster who worked the week: no weekly invoice can bill him
		// either, so he is named for a correction too, and nothing retries.
		const offRows = [...ROWS, W7.loadRow({ id: "CM39C", driver: "Test Driver C", pickup: "2026-09-29 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-29", done: "2026-09-30", truck: "T9" })];
		const o = world({ flag: "true", locks: ["2026-09"], rows: offRows });
		const oOut = await o.api.runWeeklyInvoiceBatch("2026-10-02", 1);
		const oMarker = o.db.prepare("SELECT failed, summary FROM invoice_autogen_runs WHERE week_end = '2026-10-02'").get() || {};
		const oHtml = (o.emails[0] || {}).html || "";
		check("7h ON: an off-roster driver who worked W39 is named with the rest for a correction, not WORKED-BUT-UNBILLED, and not retried",
			[oOut.unbilled, oOut.problem, oMarker.failed, /2 NOT BILLED, the week touches a closed month \(Test Driver A, test driver c\)/.test(String(oMarker.summary)),
				/WORKED-BUT-UNBILLED/.test(String(oMarker.summary)), oHtml.includes("Generate these from the Invoices page")],
			[0, false, 0, true, false, false]);

		// A lock table that can't be read is not a closed month: the batch errors and retries.
		const u = world({ flag: "true" });
		breakLockTable(u.db);
		const uOut = await u.api.runWeeklyInvoiceBatch("2026-10-02", 1);
		const uMarker = u.db.prepare("SELECT failed, summary FROM invoice_autogen_runs WHERE week_end = '2026-10-02'").get() || {};
		check("7h ON: an unreadable lock table errors the run and leaves the driver who worked for the retry",
			[uOut.created, uOut.unbilled, uOut.problem, uMarker.failed, /2 errored/.test(String(uMarker.summary)),
				/WORKED-BUT-UNBILLED \(test driver a\)/.test(String(uMarker.summary)), /closed month/i.test(String(uMarker.summary)), weekRows(u, "2026-09-26").length],
			[0, 1, true, 1, true, true, false, 0]);
	});

	// 7i. A Personal line waiting on a closed-month week.
	await run("7i (waiting Personal line)", async () => {
		for (const flag of ["true", undefined]) {
			const w = world({ flag, locks: ["2026-09"], personal: true });
			w.db.prepare(`INSERT INTO expenses (id, timestamp, driver, type, amount, gallons, date, status, vendor, truck_unit, owner_id, created_at, description, photo_data)
				VALUES (501, '2026-09-22T15:00:00.000Z', ?, 'Other', 40, 0, '2026-09-22', 'Approved', 'Made-up Diner', 'T1', 5, '2026-09-22 15:00:00', '', '')`).run(CM_A);
			w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start,
				invoice_id, created_at, created_by, created_by_id, created_role)
				VALUES (501, 'deduct', 4000, 4000, 'Made-up Diner', '2026-09-22', '2026-09', 1, '2026-09-22', '2026-09-19', NULL, '2026-09-23T15:00:00.000Z', 'super_admin', 1, 'Super Admin')`).run();
			const r = await gen(w, DRIVER, "2026-09-25");
			const line = w.db.prepare("SELECT invoice_id FROM expense_personal WHERE expense_id = 501").get();
			if (flag === "true") {
				check("7i ON: a Personal line waiting on W38 (closed) is not attached: the generate is refused and the line keeps waiting",
					[r.status, line.invoice_id, weekRows(w, "2026-09-19").length], [409, null, 0]);
			} else {
				const inv = weekRows(w, "2026-09-19")[0];
				check("7i OFF (pin, today): generating W38 attaches the waiting line to the closed month's new invoice",
					[r.status, !!inv, line.invoice_id === (inv && inv.id)], [200, true, true]);
			}
		}
	});

	// 7j. A lock table that cannot be read refuses every one of the four writes.
	await run("7j (unreadable lock table)", async () => {
		const w = world({ flag: "true" });
		// Weeks apart from W41's generate, so no case touches another's row.
		const liveId = insertInvoice(w.db, { invoice_number: "INV-TDA-2026W40-01", week_start: "2026-10-03", week_end: "2026-10-09", status: "Draft" });
		const goneId = insertInvoice(w.db, { invoice_number: "INV-TDA-2026W42-01", week_start: "2026-10-17", week_end: "2026-10-23", status: "Draft", deleted_at: "2026-11-01T12:00:00.000Z" });
		breakLockTable(w.db);
		const g = await gen(w, ADMIN, "2026-10-16");
		const m = await route(w, "POST /api/invoices/manual", { body: { payee: CM_A, payeeAddress: "", payeePhone: "", periodStart: "2026-10-01", periodEnd: "2026-10-31", lineItems: [{ description: "Made-up line", amount: 10 }] } });
		const d = await route(w, "DELETE /api/invoices/:id", { params: { id: String(liveId) } });
		const s = await route(w, "PUT /api/invoices/:id/restore", { params: { id: String(goneId) } });
		check("7j ON: unreadable lock table: generate, manual, delete and restore each answer 409 PERIOD_LOCK_UNREADABLE",
			[g, m, d, s].map((x) => [x.status, x.body && x.body.code]), Array(4).fill([409, "PERIOD_LOCK_UNREADABLE"]));
		check("...and nothing was written",
			[weekRows(w, "2026-10-10").length, weekRows(w, "2026-10-03").map((x) => [x.id, x.deleted_at]), manualRows(w).length,
				w.db.prepare("SELECT deleted_at FROM invoices WHERE id = ?").get(goneId).deleted_at],
			[0, [[liveId, ""]], 0, "2026-11-01T12:00:00.000Z"]);
		check("...each audited [PERIOD_LOCK_UNREADABLE]",
			["generate_invoice_blocked", "create_manual_invoice_blocked", "delete_invoice_blocked", "restore_invoice_blocked"].map((a) => blocked(w, a).map((x) => x.code)),
			Array(4).fill(["PERIOD_LOCK_UNREADABLE"]));
		const off = world({});
		breakLockTable(off.db);
		const o = await gen(off, ADMIN, "2026-10-16");
		check("7j OFF (pin, today): generate does not read the lock table", [o.status, weekRows(off, "2026-10-10").length], [200, 1]);
	});

	// 7k. On only when exactly "true".
	await run("7k (flag values)", async () => {
		const statuses = [];
		for (const v of ["1", "TRUE", "on", "yes", " true", ""]) {
			const w = world({ flag: v, locks: ["2026-09"] });
			statuses.push((await gen(w, ADMIN, "2026-09-25")).status);
		}
		check("7k: any value but exactly \"true\" leaves the flag off (W38 generates as today)", statuses, Array(6).fill(200));
	});

	// 7n. A Driver's repeated refusals: answered every time, recorded once per week a day,
	// and for at most 10 weeks a day; a Super Admin's are recorded every time.
	await run("7n (a Driver's repeated refusals)", async () => {
		const w = world({ flag: "true", locks: ["2026-09"] });
		const taps = [];
		for (let i = 0; i < 3; i++) taps.push(await gen(w, DRIVER, "2026-09-25"));
		check("7n ON: a Driver tapping W38 three times is refused three times, the same way",
			taps.map((t) => [t.status, t.body && t.body.code, errorOf(t) === errorOf(taps[0])]), Array(3).fill([409, "PERIOD_FINALIZED", true]));
		check("...and recorded once", blocked(w, "generate_invoice_blocked").map((a) => a.username), ["drivera"]);
		await gen(w, ADMIN, "2026-09-25");
		await gen(w, ADMIN, "2026-09-25");
		check("...while a Super Admin's refusals are each recorded",
			blocked(w, "generate_invoice_blocked").map((a) => a.username), ["drivera", "super_admin", "super_admin"]);
		w.clock.ms += 24 * 3600 * 1000 + 60 * 1000;
		await gen(w, DRIVER, "2026-09-25");
		check("...and 24 h later the Driver's next refusal of W38 is recorded again",
			blocked(w, "generate_invoice_blocked").filter((a) => a.username === "drivera").length, 2);
		const many = world({ flag: "true", locks: ["2026-05", "2026-06", "2026-07"] });
		const fridays = ["2026-05-01", "2026-05-08", "2026-05-15", "2026-05-22", "2026-05-29", "2026-06-05",
			"2026-06-12", "2026-06-19", "2026-06-26", "2026-07-03", "2026-07-10", "2026-07-17"];
		const answers = [];
		for (const f of fridays) answers.push((await gen(many, DRIVER, f)).status);
		check("7n ON: 12 closed weeks in a day are all refused, and 10 of them recorded",
			[answers.every((s) => s === 409), blocked(many, "generate_invoice_blocked").length], [true, 10]);
	});

	// 7o. With the flag on, a weekEnd that is not a real day is a bad request, before the guard.
	await run("7o (weekEnd)", async () => {
		const w = world({ flag: "true", locks: ["2026-09"] });
		const bad = [];
		for (const v of ["2026-13-01", "2026-02-30", "not-a-date", "2026-10-02T12:00:00Z", 12345]) {
			const r = await gen(w, DRIVER, v);
			bad.push([r.status, r.body && r.body.code]);
		}
		check("7o ON: a weekEnd that is not a real YYYY-MM-DD day answers 400 INVOICE_WEEK_END_INVALID",
			bad, Array(5).fill([400, "INVOICE_WEEK_END_INVALID"]));
		check("...with no refusal recorded and nothing rendered", [blocked(w, "generate_invoice_blocked").length, w.rendered.length], [0, 0]);
		const none = await W7.call(w.api.generateInvoiceHandler, { session: { user: { ...DRIVER } }, headers: {}, query: {}, params: {}, body: { driver: CM_A } });
		check("...while no weekEnd is still this week (no loads here: today's plain 400)",
			[none.status, none.body && none.body.code], [400, undefined]);
		const off = world({ locks: ["2026-09"] });
		const o = [];
		for (const v of ["2026-13-01", "not-a-date"]) {
			const r = await gen(off, DRIVER, v);
			o.push([r.status, r.body && r.body.code, /No completed loads/.test(errorOf(r))]);
		}
		check("7o OFF (pin, today): such a weekEnd finds no loads (400, no code)", o, Array(2).fill([400, undefined, true]));
	});

	// 7p. A closed week whose settled invoice exists answers with that invoice, as today.
	await run("7p (settled invoice in a closed week)", async () => {
		const answers = [];
		for (const flag of ["true", undefined]) {
			const w = world({ flag, locks: ["2026-09"] });
			insertInvoice(w.db, { invoice_number: "INV-TDA-2026W38-01", week_start: "2026-09-19", week_end: "2026-09-25", status: "Approved" });
			const r = await gen(w, DRIVER, "2026-09-25");
			answers.push([r.status, r.body && r.body.code, errorOf(r), r.body && r.body.invoice && r.body.invoice.invoice_number,
				blocked(w, "generate_invoice_blocked").length]);
		}
		const expectedAnswer = [409, "INVOICE_EXISTS", "Invoice already exists for this week (INV-TDA-2026W38-01, status: Approved). Contact admin if this needs to be regenerated.", "INV-TDA-2026W38-01", 0];
		check("7p ON: a Driver generating a closed week with an approved invoice is told that invoice, unaudited", answers[0], expectedAnswer);
		check("7p OFF (pin, today): the same answer", answers[1], expectedAnswer);
	});

	// 7l. The flag, declared once beside its neighbour, on only when exactly "true".
	check("7l: the flag is declared once, on only when exactly \"true\"",
		SRC.split(`\nconst ${CM_FLAG} = process.env.${CM_FLAG} === "true";\n`).length - 1, 1);

	// 7m. One start-up line with the two closed-month invoice flags' states and
	// nothing else, printed once per start (column 0: no block or function).
	{
		const at = LINES.map((l, i) => [l, i]).filter(([l]) => l.includes("[invoice-month-lock]"));
		check("7m: exactly one [invoice-month-lock] line in server.js, a top-level console.log",
			at.map(([l]) => l.startsWith("console.log(`[invoice-month-lock] ")), [true]);
		const line = at.length === 1 ? at[0][0] : "";
		check("...naming only the two flags (no other setting, no process.env)",
			[...new Set(codeIdentifiers(line))].sort(), ["INVOICE_CLOSED_MONTH_GUARD_ENABLED", "MARK_PAID_CLOSED_MONTH_ENABLED", "console"]);
		const decl = (name) => LINES.find((l) => l.startsWith(`const ${name} = `)) || "";
		const printed = (env) => {
			const out = [];
			const fake = { log: (...a) => out.push(a.join(" ")), info() {}, warn() {}, error() {} };
			new Function("process", "console", [decl(CM_FLAG), decl("MARK_PAID_CLOSED_MONTH_ENABLED"), line].join("\n"))({ env }, fake);
			return out;
		};
		// Other settings set to made-up values, so a line that printed one would show it.
		const others = { SESSION_SECRET: "made-up-session-secret", INVOICE_BANK_ACCOUNT: "000111222", PERIOD_FINALIZE_ENABLED: "true", GMAIL_USER: "nobody@example.com" };
		const cases = [
			[{ [CM_FLAG]: "true", MARK_PAID_CLOSED_MONTH_ENABLED: "true" }, "on", "on"],
			[{ [CM_FLAG]: "true" }, "on", "off"],
			[{ MARK_PAID_CLOSED_MONTH_ENABLED: "yes" }, "off", "on"],
			[{ [CM_FLAG]: "1", MARK_PAID_CLOSED_MONTH_ENABLED: "false" }, "off", "off"],
		];
		guarded("7m (the line, printed)", () => {
			for (const [env, mine, paid] of cases) {
				const out = printed({ ...others, ...env });
				check(`...prints exactly the two states (${CM_FLAG} ${mine}, MARK_PAID_CLOSED_MONTH_ENABLED ${paid})`, out,
					[`[invoice-month-lock] ${CM_FLAG} ${mine}; MARK_PAID_CLOSED_MONTH_ENABLED ${paid}`]);
				check("...and no other setting's name or value", Object.entries(others).filter(([k, v]) => out.join("\n").includes(k) || out.join("\n").includes(v)), []);
			}
		});
	}
}

// The read-side predicate, built separately so the paired assertion above can
// compare the two without the mutant harness reaching it.
function buildGuardRow() {
	const body = [
		extract("periodLockStmt"), extract("isLocked"), extract("periodLocksReadable"),
		extract("invoiceRowPeriodLocked"),
	].join("\n");
	return new Function("db", `${body}\n return invoiceRowPeriodLocked;`)(db);
}

// Sections 6 and 7 await route handlers, so the summary waits for them.
section6()
	.catch((err) => { fail++; failures.push(`  section 6 (adjust refusal wording) ran\n      threw: ${err.message}`); })
	.then(() => section7())
	.catch((err) => { fail++; failures.push(`  section 7 (closed-month invoice guard) ran\n      threw: ${err.message}`); })
	.then(() => {
		db.close();
		console.log(`\n${pass} passed, ${fail} failed`);
		if (fail) {
			console.log("\nFailures:");
			for (const f of failures) console.log(f);
			process.exit(1);
		}
	});
