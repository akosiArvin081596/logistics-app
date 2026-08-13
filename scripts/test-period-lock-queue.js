#!/usr/bin/env node
// The month-end-close queue on /admin/data-issues — its absent-vs-empty contract,
// its counts, and the marker the server keys the history on.
//
// WHY THIS EXISTS. This queue reports on the thing that FREEZES money, and it has
// two ways of returning a well-formed zero that means nothing at all:
//
//   • `period_locks` unreadable. Every write guard in the app fails CLOSED on that
//     table, so the app is at that moment refusing invoice adjustments, truck
//     edits, expense status flips and driver renames it cannot confirm are safe —
//     while the endpoint, failing closed the same way, deliberately lists NO
//     invoice (one root cause is not twenty-nine findings). "Nothing stuck" would
//     be the exact inverse of the truth.
//   • No month has ever been finalized. That is the ships-dormant default —
//     PERIOD_FINALIZE_ENABLED off, `period_locks` empty — and in it nothing CAN be
//     frozen and no lock refusal can have fired, so an empty queue is trivially
//     true and says nothing about whether month-end close works.
//
// lib/dataIssues.js exists to keep those apart from "we checked, nothing to
// report", and its header states the rule the whole page rests on: `undefined`
// ("this server could not tell us") is NEVER `[]`. Both non-clear states were
// MEASURED on a copy of the production database (see §1a) before this was written.
//
// ⚠️ EVERY CASE IS PAIRED, because a test that only proves the correct answer
// proves nothing about whether the assertion is still live. The mutants are run
// alongside the shipped code and asserted to get it WRONG: a synthesised report
// for an absent payload, a `neverPayable + unresolvedDates` sum that double-counts
// the row that is both, an inconclusive text that reports the quietest cause
// first, and a cause-code renderer that invents a sentence for a code it has never
// seen.
//
// §8 leaves the client entirely: the HISTORY half is keyed on the `[PERIOD_`
// marker in `audit_trail.details` and NOT on a list of action names, which is what
// makes a guard added later appear with no code change. That is asserted against
// server.js SOURCE — the real parser, extracted and executed, and the real WHERE
// clause, compared character-for-character with purgeOldAuditRefusals(). Detail
// strings in §8 are verbatim captures from a live run against a copy of the
// refreshed app.db.
//
// §9 covers the review round on all of the above, and its two load-bearing cases
// are the ones the first cut of §8 MISSED:
//
//   • §8 plants `periods=` in the SUBJECT — the half that was already closed.
//     periodRefusalDetail() splices caller text AFTER the marker too (`— reason:`
//     straight off req.body) and OMITS the `periods=` fragment whenever no month
//     is named, which is every PERIOD_LOCK_UNREADABLE and PERIOD_UNRESOLVED
//     refusal. An unanchored search found the caller's copy first. §9 composes the
//     real WRITER with the real PARSER rather than hand-typing a detail string,
//     because a format this file invented would prove nothing about either.
//   • The three establishment-gated queues built their context with
//     `Boolean(payload?.x)`, so a call that FAILED and a detector that is genuinely
//     OFF produced the same false — and the page then asserted a server state
//     nobody had been told. On this database that read "no month has ever been
//     finalized" against FIFTEEN locked months.
//
// No network and no filesystem writes; the one exception is an in-memory SQLite
// database in §9, which measures that the endpoint's own LIKE predicate really
// does select a lower-case `[period_…]` row. That premise is what makes the
// parser's case handling load-bearing, and it is worth measuring rather than
// quoting from the documentation.
//
//   node scripts/test-period-lock-queue.js     # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const MODULE_PATH = path.join(__dirname, "..", "client", "src", "lib", "dataIssues.js");

let pass = 0, fail = 0;
const failures = [];
function check(label, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	failures.push(`  ${label}\n      expected ${e}\n      actual   ${a}`);
}
function section(t) { console.log(`\n${t}`); }
// A harness error is a FAILURE, not a crash: §6 extracts by name, and against a
// server.js that predates this work the name is absent. An uncaught throw would
// hide the finding instead of reporting it.
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

// ═══════════════════════════════════════════════════════════════════════════
// The payloads. Every figure is a real one, read off GET /api/admin/period-lock-issues
// running against a copy of the refreshed app.db on 2026-08-13.
// ═══════════════════════════════════════════════════════════════════════════

// The live shape: 15 months closed, 25 of 29 invoices frozen, 6 that can never be
// marked Paid, and — because refusal auditing had not yet run anywhere — an EMPTY
// history beside 1,433 ordinary audit rows.
const LIVE = {
	closeEnabled: false, locksReadable: true, auditReadable: true,
	lockedPeriods: ["2025-05", "2026-06", "2026-07"], lockedCount: 15,
	currentPeriod: "2026-08", auditRows: 1433,
	refusals: [], refusalCount: 0, refusalShown: 0, refusalTruncated: false,
	refusalOldest: null, refusalNewest: null,
	invoices: [], invoiceCount: 25, invoiceShown: 25, invoiceTruncated: false,
	liveInvoices: 29,
	invoiceSummary: {
		live: 29, frozen: 25, neverPayable: 6, unresolvedDates: 0, noRemedy: 6,
		frozenAmount: 32657, neverPayableAmount: 3320,
	},
};
// Measured: period_locks rebuilt without its `status` column — the DB-level break
// periodLocksReadable() was written for, since CREATE TABLE IF NOT EXISTS sees a
// table already there and repairs nothing.
const BROKEN_LOCKS = {
	...LIVE, locksReadable: false, lockedPeriods: [], lockedCount: 0,
	invoiceCount: 0, invoiceShown: 0, liveInvoices: 29,
	invoiceSummary: { live: 29, frozen: 0, neverPayable: 0, unresolvedDates: 0, noRemedy: 0, frozenAmount: 0, neverPayableAmount: 0 },
};
// Measured: every period_locks row deleted, close flag off — the ships-dormant
// default a fresh deployment starts in.
const NO_LOCKS = {
	...LIVE, closeEnabled: false, locksReadable: true, lockedPeriods: [], lockedCount: 0,
	invoiceCount: 0, invoiceShown: 0,
	invoiceSummary: { live: 29, frozen: 0, neverPayable: 0, unresolvedDates: 0, noRemedy: 0, frozenAmount: 0, neverPayableAmount: 0 },
};
const NO_LOCKS_FLAG_ON = { ...NO_LOCKS, closeEnabled: true };
const AUDIT_BROKEN = { ...LIVE, auditReadable: false, refusalCount: 0, auditRows: 0 };
// A genuinely clean month-end: months are closing, and nothing is stuck.
const ALL_CLEAR = {
	...LIVE, invoiceCount: 0, invoiceShown: 0, refusalCount: 0,
	invoiceSummary: { live: 29, frozen: 0, neverPayable: 0, unresolvedDates: 0, noRemedy: 0, frozenAmount: 0, neverPayableAmount: 0 },
};

// The context establishCtx() builds in DataIssuesView, for one report.
//
// ⚠️ `answered` IS SEPARATE FROM EVERY OTHER FIELD AND CANNOT BE DERIVED FROM
// THEM — that is finding 2 in one line. All the others are `Boolean(payload?.x)`,
// so a call that FAILED and a server that is genuinely dormant produce byte-identical
// context; only "did the payload arrive" tells them apart. `answered` defaults to
// tracking the report so the existing sections read unchanged, and §9 overrides it
// to build the two contexts explicitly and compare them.
function ctxOf(report, answered) {
	return {
		answered: { periodlock: answered === undefined ? report !== null : answered },
		periodLockMeaningful: Boolean(report && report.meaningful),
		locksReadable: report ? report.locksReadable : null,
		auditReadable: report ? report.auditReadable : null,
		lockedCount: (report && report.lockedCount) || 0,
		closeEnabled: Boolean(report && report.closeEnabled),
	};
}

(async () => {
	const m = await import(pathToFileURL(MODULE_PATH).href);
	const {
		ISSUE_QUEUES, emptyQueueState, queueEstablished, queueInconclusiveText,
		periodLockInconclusiveText, periodLockReport, periodIssueCounts,
		normalizePeriodRefusal, normalizeFrozenInvoice, refusalCauseText,
		frozenInvoiceImpact, PERIOD_HISTORY_NOTE, queueCtxAnswered,
	} = m;

	// ═══════════════════════════════════════════════════════════════════════
	// §1  ABSENT IS NOT EMPTY — the contract this whole file exists for
	// ═══════════════════════════════════════════════════════════════════════
	section("§1  absent (`undefined`) vs empty (`[]`) — the core invariant");

	// (a) A call that never answered must produce NOTHING to report from.
	check("periodLockReport(undefined) -> null", periodLockReport(undefined), null);
	check("periodLockReport(null) -> null", periodLockReport(null), null);
	check("periodLockReport('') -> null", periodLockReport(""), null);
	check("counts(null) -> all zero", periodIssueCounts(null), { total: 0, actionable: 0, closed: 0 });
	check("counts(undefined) -> all zero", periodIssueCounts(undefined), { total: 0, actionable: 0, closed: 0 });

	// (b) …AND THE PAIR: a payload that DID answer with nothing to report is a
	// report, and is entitled to say so. Without this half, "return null always"
	// passes (a).
	{
		const r = periodLockReport(ALL_CLEAR);
		check("an answered-but-empty payload IS a report", r !== null, true);
		check("…and it is established (months are closing)", r.meaningful, true);
		check("…and its counts are a genuine zero", periodIssueCounts(r), { total: 0, actionable: 0, closed: 0 });
		check("…so this queue may say 'all clear'",
			queueEstablished("periodlock", ctxOf(r)) && periodIssueCounts(r).total === 0, true);
	}

	// (c) The two zeros are numerically identical and mean opposite things. THIS is
	// the pairing the whole section turns on.
	{
		const clear = periodLockReport(ALL_CLEAR);
		const dormant = periodLockReport(NO_LOCKS);
		check("clear and dormant produce the SAME counts",
			JSON.stringify(periodIssueCounts(clear)) === JSON.stringify(periodIssueCounts(dormant)), true);
		check("…yet only one of them may claim to be clear",
			[queueEstablished("periodlock", ctxOf(clear)), queueEstablished("periodlock", ctxOf(dormant))],
			[true, false]);
	}

	// (d) MUTANT: the tempting `payload || {}` shape, which turns a call that never
	// happened into a confident zero on the page.
	{
		const mutant = (p) => ({ ...(p || {}), meaningful: true, lockedCount: 0, summary: { noRemedy: 0 } });
		check("mutant `payload || {}` gets the ABSENT case wrong", mutant(undefined) === null, false);
		check("…where the shipped one returns null", periodLockReport(undefined), null);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// §2  ANSWERING IS NOT ESTABLISHING
	// ═══════════════════════════════════════════════════════════════════════
	section("§2  queueEstablished('periodlock') — four states, three of them silent");

	check("live production shape -> established", queueEstablished("periodlock", ctxOf(periodLockReport(LIVE))), true);
	check("period_locks unreadable -> NOT established", queueEstablished("periodlock", ctxOf(periodLockReport(BROKEN_LOCKS))), false);
	check("no month ever locked -> NOT established", queueEstablished("periodlock", ctxOf(periodLockReport(NO_LOCKS))), false);
	check("no month locked, close flag ON -> still NOT established",
		queueEstablished("periodlock", ctxOf(periodLockReport(NO_LOCKS_FLAG_ON))), false);
	check("audit_trail unreadable -> NOT established", queueEstablished("periodlock", ctxOf(periodLockReport(AUDIT_BROKEN))), false);
	// A queue that has not answered cannot be established either — `meaningful` is
	// false while the report is null, so this needs no separate branch.
	check("payload absent -> NOT established", queueEstablished("periodlock", ctxOf(null)), false);

	// ⚠️ REGRESSION PAIR. Adding a key must not change what the other five claim —
	// three of them establish unconditionally, and folding this queue's context
	// into the shared default would silence them.
	check("fuelverify still keys on sweepHasRun (true)", queueEstablished("fuelverify", { sweepHasRun: true }), true);
	check("fuelverify still keys on sweepHasRun (false)", queueEstablished("fuelverify", { sweepHasRun: false }), false);
	check("linxup still keys on linxupMeaningful", queueEstablished("linxup", { linxupMeaningful: false }), false);
	check("duplicates still establishes unconditionally", queueEstablished("duplicates", {}), true);
	check("onboarding still establishes unconditionally", queueEstablished("onboarding", {}), true);
	check("ratecon still establishes unconditionally", queueEstablished("ratecon", {}), true);
	check("an unknown key still establishes unconditionally", queueEstablished("whatever", {}), true);

	// ═══════════════════════════════════════════════════════════════════════
	// §3  WHY it established nothing — loudest cause FIRST
	// ═══════════════════════════════════════════════════════════════════════
	section("§3  periodLockInconclusiveText — an unreadable lock table outranks a dormant one");

	const say = (p) => periodLockInconclusiveText(ctxOf(periodLockReport(p)));
	check("established -> no sentence at all", say(LIVE), "");
	check("unreadable lock table names the guards that are refusing", say(BROKEN_LOCKS),
		"the month-end lock table can't be read, so every write guard in the app is refusing what it can't confirm is safe");
	check("audit unreadable names the history it cannot list", say(AUDIT_BROKEN),
		"the audit trail can't be read, so refused writes can't be listed");
	// ⚠️ THE FLAG CHANGES THE SENTENCE, and it has to: "no month yet" on a server
	// where nothing will EVER close is a promise of a settlement that is not coming.
	check("dormant, flag off -> says the feature is off", say(NO_LOCKS),
		"automatic month-close is switched off and no month has ever been finalized, so nothing can be held by one");
	check("dormant, flag on -> says only that nothing has closed yet", say(NO_LOCKS_FLAG_ON),
		"no month has been finalized yet, so nothing can be held by one");

	// ⚠️ ALL THREE AT ONCE. A broken deployment hits every branch, and the sentence
	// must be the fault, not the configuration. A mutant ordered the other way
	// round reports "automatic month-close is switched off" while the app is
	// refusing every money write it cannot confirm.
	{
		const worst = { ...BROKEN_LOCKS, auditReadable: false, closeEnabled: false, lockedCount: 0 };
		check("all three causes at once -> the LOCK sentence wins", say(worst),
			"the month-end lock table can't be read, so every write guard in the app is refusing what it can't confirm is safe");
		const mutantOrder = (ctx) => {
			if (!ctx.lockedCount) return "no month has been finalized yet, so nothing can be held by one";
			if (ctx.auditReadable === false) return "the audit trail can't be read, so refused writes can't be listed";
			return "";
		};
		check("mutant `quietest cause first` gets it WRONG",
			mutantOrder(ctxOf(periodLockReport(worst))) === say(worst), false);
	}

	// The shared entry point must agree with the specialised one — the section
	// renders its own copy of this sentence, and two spellings on one screen is the
	// drift this file's single-registry design exists to stop.
	check("queueInconclusiveText routes 'periodlock' to the same sentence",
		queueInconclusiveText("periodlock", ctxOf(periodLockReport(BROKEN_LOCKS))), say(BROKEN_LOCKS));
	check("queueInconclusiveText stays silent when established",
		queueInconclusiveText("periodlock", ctxOf(periodLockReport(LIVE))), "");

	// ═══════════════════════════════════════════════════════════════════════
	// §4  THE COUNTS — server-told, and never double-counted
	// ═══════════════════════════════════════════════════════════════════════
	section("§4  periodIssueCounts — actionable = rows with NO in-app remedy");

	{
		const r = periodLockReport(LIVE);
		check("live shape: 25 frozen invoices + 0 refusals", periodIssueCounts(r), { total: 25, actionable: 6, closed: 19 });
	}
	{
		// Measured on the same copy after seeding 208 marked audit rows: the list is
		// capped at 200 while the count is over the full set.
		const p = { ...LIVE, refusalCount: 208, refusalShown: 200, refusalTruncated: true };
		const r = periodLockReport(p);
		check("counts come from the FULL set, not the capped list",
			periodIssueCounts(r), { total: 233, actionable: 6, closed: 227 });
		check("…and the truncation is reported", [r.refusalTruncated, r.refusalShown, r.refusalCount], [true, 200, 208]);
	}

	// ⚠️ THE OVERLAP, AND IT IS REAL ON THIS DATA. Seeding two Draft invoices with
	// unresolvable week dates left neverPayable at 6 and unresolvedDates at 2 —
	// both rows are BOTH. `noRemedy` is 6, not 8.
	{
		const p = { ...LIVE, invoiceCount: 25, invoiceSummary: { ...LIVE.invoiceSummary, unresolvedDates: 2, noRemedy: 6 } };
		const r = periodLockReport(p);
		check("overlapping causes are not double-counted", periodIssueCounts(r).actionable, 6);
		const mutantSum = (rep) => rep.summary.neverPayable + rep.summary.unresolvedDates;
		check("mutant `neverPayable + unresolvedDates` gets it WRONG", mutantSum(r), 8);
		check("…and would overstate the work by exactly the overlap", mutantSum(r) - periodIssueCounts(r).actionable, 2);
	}

	// A malformed summary must not invent work. `actionable` is clamped to `total`,
	// so a server sending a bigger noRemedy than there are rows cannot drive
	// `closed` negative.
	{
		const r = periodLockReport({ ...LIVE, invoiceCount: 1, refusalCount: 0, invoiceSummary: { ...LIVE.invoiceSummary, noRemedy: 99 } });
		check("a noRemedy larger than the row count is clamped", periodIssueCounts(r), { total: 1, actionable: 1, closed: 0 });
	}
	// An older server that sends no summary at all reports zero work rather than
	// NaN — the same absent-is-not-a-number rule toNum() enforces.
	{
		const r = periodLockReport({ locksReadable: true, auditReadable: true, lockedCount: 15, refusalCount: 3, invoiceCount: 2 });
		check("a payload with no invoiceSummary still counts", periodIssueCounts(r), { total: 5, actionable: 0, closed: 5 });
		check("…and reports every summary figure as 0, never null", r.summary.noRemedy, 0);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// §5  ROW NORMALIZERS — server-told, and honest about what it did not say
	// ═══════════════════════════════════════════════════════════════════════
	section("§5  normalizePeriodRefusal / normalizeFrozenInvoice");

	{
		// A verbatim row from the live run: PUT /api/invoices/368/adjust, refused.
		const raw = {
			id: 1436, at: "2026-08-13T04:21:25.603Z", account: "super_admin", role: "Super Admin",
			action: "adjust_invoice_blocked", entity: "invoice", entityId: "368",
			code: "PERIOD_FINALIZED", periods: ["2026-07"], unnamedPeriods: false,
			attempted: "adjust INV-SK-2026W30-01 (shorn king, 2026-07-25 — 2026-07-31, status Submitted, adjustment 0.00 -> -$125.50)",
			note: "late fuel receipt, per Danna", suppressed: null,
			details: "adjust INV-SK-2026W30-01 … WITHHELD [PERIOD_FINALIZED] periods=2026-07 — nothing was written — reason: late fuel receipt, per Danna",
		};
		const r = normalizePeriodRefusal(raw);
		check("periods survive and are labelled", [r.periods, r.periodLabels], [["2026-07"], ["July 2026"]]);
		check("the stated reason survives", r.note, "late fuel receipt, per Danna");
		check("the raw detail is kept verbatim", r.details, raw.details);
		// ⚠️ ABSENT IS NOT ZERO. A row that never carried a suppressed tally must not
		// render "+0 more suppressed" — a claim the server never made.
		check("absent `suppressed` stays null", r.suppressed, null);
		check("…and a real tally comes through as a number",
			normalizePeriodRefusal({ ...raw, suppressed: 4 }).suppressed, 4);
	}
	{
		// An older server, or a row the parser could not read structurally: no
		// periods, no code. Nothing may be invented from that.
		const r = normalizePeriodRefusal({ id: 1, at: "x", details: "something" });
		check("no periods -> empty list, never a guess", [r.periods, r.periodLabels], [[], []]);
		check("no code -> empty string", r.code, "");
		check("unnamedPeriods defaults to false, not true", r.unnamedPeriods, false);
		check("…and is true ONLY when the server said so",
			normalizePeriodRefusal({ unnamedPeriods: true }).unnamedPeriods, true);
	}
	{
		// Verbatim from the live run's seeded row: one month named, one it could not.
		const r = normalizePeriodRefusal({ periods: ["2026-06"], unnamedPeriods: true });
		check("an unnameable month never becomes a period", r.periods, ["2026-06"]);
		check("…but the row still says there were others", r.unnamedPeriods, true);
	}

	{
		// Verbatim: invoice #368, Submitted, July 2026 closed.
		const inv = normalizeFrozenInvoice({
			id: 368, invoiceNumber: "INV-SK-2026W30-01", driver: "shorn king",
			weekStart: "2026-07-25", weekEnd: "2026-07-31", status: "Submitted",
			amount: 900, cause: "PERIOD_FINALIZED", periods: ["2026-07"],
			adjustable: false, neverPayable: true, isManual: false,
			detail: "INV-SK-2026W30-01 bills 2026-07-25 — 2026-07-31, which covers July 2026",
			remedy: "Reopen the affected period first — POST /api/periods/:period/reopen records a reason.",
		});
		check("a frozen invoice is never adjustable", inv.adjustable, false);
		check("…and names its month in words", inv.periodLabels, ["July 2026"]);
		check("neverPayable is server-told", inv.neverPayable, true);
		check("…and defaults to FALSE when the server did not say",
			normalizeFrozenInvoice({ id: 1 }).neverPayable, false);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// §6  THE SENTENCES — and the refusal to invent one
	// ═══════════════════════════════════════════════════════════════════════
	section("§6  refusalCauseText / frozenInvoiceImpact");

	check("PERIOD_FINALIZED reads as a closed month",
		refusalCauseText("PERIOD_FINALIZED"), "the month this would have changed is already closed");
	check("PERIOD_LOCK_UNREADABLE reads as a fail-closed withhold",
		refusalCauseText("PERIOD_LOCK_UNREADABLE").includes("withheld the write"), true);
	check("PERIOD_UNRESOLVED reads as a date problem",
		refusalCauseText("PERIOD_UNRESOLVED").includes("resolve to a month"), true);
	check("PERIOD_NOT_FINALIZED reads as a grace window",
		refusalCauseText("PERIOD_NOT_FINALIZED").includes("grace window"), true);

	// ⚠️ THE POINT OF THE WHOLE QUEUE. A guard added later appears here with no code
	// change, so this build WILL meet codes it has never seen — and must show the
	// stored detail rather than a sentence it made up. Verified live: a seeded
	// `PERIOD_SOMETHING_NEW` row was listed by the endpoint and rendered '' here.
	check("an unknown PERIOD_ code gets NO invented sentence", refusalCauseText("PERIOD_SOMETHING_NEW"), "");
	check("a blank code gets none either", refusalCauseText(""), "");
	check("null gets none either", refusalCauseText(null), "");
	{
		const mutant = (c) => (c ? "this was blocked by month-end close" : "");
		check("mutant `one sentence for everything` gets the unknown code WRONG",
			mutant("PERIOD_SOMETHING_NEW") === refusalCauseText("PERIOD_SOMETHING_NEW"), false);
		check("…while agreeing on nothing-to-say for a blank code",
			mutant("") === refusalCauseText(""), true);
	}

	const impact = (o) => frozenInvoiceImpact(normalizeFrozenInvoice(o));
	check("a stuck-before-Paid invoice names the month to reopen",
		impact({ status: "Draft", cause: "PERIOD_FINALIZED", periods: ["2026-07"], neverPayable: true }),
		"Can't be adjusted, and can never be marked Paid — it is Draft, and July 2026 would have to be reopened first.");
	check("two months read as a list",
		impact({ status: "Submitted", cause: "PERIOD_FINALIZED", periods: ["2026-05", "2026-06"], neverPayable: true })
			.includes("May 2026 and June 2026"), true);
	// The PAIR: an already-settled invoice is frozen too, and saying "can never be
	// paid" about a Paid row would be nonsense.
	check("an already-Paid invoice is not reported as waiting on anything",
		impact({ status: "Paid", cause: "PERIOD_FINALIZED", periods: ["2026-06"], neverPayable: false }),
		"Can't be adjusted. It is already Paid, so nothing is waiting on it.");
	check("a Rejected invoice reads the same way",
		impact({ status: "Rejected", cause: "PERIOD_FINALIZED", periods: ["2026-05"], neverPayable: false })
			.startsWith("Can't be adjusted. It is already Rejected"), true);
	// ⚠️ THE DEAD END. No route in this app can edit week_start / week_end, so
	// "reopen the month" is not merely unhelpful here — it names no month at all.
	{
		const t = impact({ status: "Draft", cause: "PERIOD_UNRESOLVED", periods: [], neverPayable: true });
		check("an unresolvable date says the dates cannot be edited", t.includes("no route in the app can edit"), true);
		check("…and never tells anyone to reopen a month", /reopen/i.test(t), false);
		check("…where the finalized branch DOES say reopen",
			/reopened/i.test(impact({ status: "Draft", cause: "PERIOD_FINALIZED", periods: ["2026-07"], neverPayable: true })), true);
	}
	check("no invoice at all -> no sentence", frozenInvoiceImpact(null), "");

	// ═══════════════════════════════════════════════════════════════════════
	// §7  REGISTRY WIRING
	// ═══════════════════════════════════════════════════════════════════════
	section("§7  the registry entry");

	const q = ISSUE_QUEUES.find((x) => x.key === "periodlock");
	check("the queue is registered", Boolean(q), true);
	check("it has a per-queue clear phrase", q && q.clear, "nothing is held by a closed month");
	// ⚠️ NOT `manual`. That flag is a COST property (the rate-con queue opens IMAP
	// against the production mailbox on every call); this endpoint is a handful of
	// indexed SQLite reads and writes nothing, so it must load on mount or the page
	// silently stops watching the thing that freezes money.
	check("it is NOT load-on-demand", Boolean(q && q.manual), false);
	check("…so its initial state is 'loading', not 'idle'", emptyQueueState(q).status, "loading");
	check("…where the rate-con queue really does start idle",
		emptyQueueState(ISSUE_QUEUES.find((x) => x.key === "ratecon")).status, "idle");
	check("the history note states what it cannot cover",
		PERIOD_HISTORY_NOTE.includes("began recording refusals"), true);

	// ═══════════════════════════════════════════════════════════════════════
	// §8  THE MARKER — server.js source, executed
	// ═══════════════════════════════════════════════════════════════════════
	section("§8  the history is keyed on `[PERIOD_`, not on action names");

	guarded("extract + run parsePeriodRefusalDetail()", () => {
		const parse = new Function(`${extract("parsePeriodRefusalDetail")}\nreturn parsePeriodRefusalDetail;`)();

		// Four different writers, four different templates, all captured verbatim
		// from a live run against a copy of the refreshed app.db. None of them is
		// recognised by shape — only by the marker.
		const A = parse('adjust INV-SK-2026W30-01 (shorn king, 2026-07-25 — 2026-07-31, status Submitted, adjustment 0.00 -> -$125.50) WITHHELD [PERIOD_FINALIZED] periods=2026-07 — nothing was written — reason: late fuel receipt, per Danna');
		check("periodRefusalDetail(): code", A.code, "PERIOD_FINALIZED");
		check("periodRefusalDetail(): periods", A.periods, ["2026-07"]);
		check("periodRefusalDetail(): reason", A.note, "late fuel receipt, per Danna");
		check("periodRefusalDetail(): the trailing 'WITHHELD' is stripped from the subject",
			A.attempted.endsWith("-$125.50)"), true);

		const B = parse('status -> Rejected WITHHELD on 3 of 3 expense(s): 20,21,23 [PERIOD_FINALIZED] periods=2026-05 — nothing was written — reason: testing the closed-month guard');
		check("bulk-status template: periods", B.periods, ["2026-05"]);
		check("bulk-status template: the middle of the subject is KEPT",
			B.attempted, "status -> Rejected WITHHELD on 3 of 3 expense(s): 20,21,23");

		const C = parse('LogisX-#33: in_service_date "" -> "2025-05-01" WITHHELD [PERIOD_FINALIZED] periods=2025-05,2025-06,2026-03 — nothing was written');
		check("truck template: every month in the list", C.periods, ["2025-05", "2025-06", "2026-03"]);

		const D = parse('Blocked override to "Delivered" [PERIOD_FINALIZED] periods=2026-06 — {"code":"PERIOD_FINALIZED","periods":["2026-06"]}');
		check("dispatch template: leading 'Blocked ' is stripped", D.attempted, 'override to "Delivered"');
		check("dispatch template: the JSON tail is not mistaken for a period", D.periods, ["2026-06"]);

		// ⚠️ AN UNNAMEABLE MONTH IS NEVER RENDERED AS ONE. namedLockedPeriods() emits
		// "(unrecognized date)" where a row's month could not be resolved, and
		// auditText() caps the joined list at 200 chars, which can cut a key in half.
		const E = parse('delete driver Someone WITHHELD [PERIOD_FINALIZED] periods=2026-06,(unrecognized date) — nothing was written');
		check("'(unrecognized date)' is not a period", E.periods, ["2026-06"]);
		check("…but the row records that there were others", E.unnamedPeriods, true);
		const F = parse('x WITHHELD [PERIOD_FINALIZED] periods=2026-05,2026-0 — nothing was written');
		check("a truncated month key is not a period", F.periods, ["2026-05"]);
		check("…and is likewise reported as unnameable", F.unnamedPeriods, true);
		check("a well-formed list sets no unnamed flag", C.unnamedPeriods, false);
		// A month outside 01-12 passes a bare \d{4}-\d{2} shape test and equals no
		// real month — the same trap invoiceMonthLockBlockers() range-checks for.
		check("an out-of-range month is not a period", parse("x [PERIOD_FINALIZED] periods=2026-13").periods, []);

		// ⚠️ CALLER TEXT CANNOT SUPPLY THE MONTHS. Everything structural is read from
		// AFTER the marker; the subject interpolates raw driver names, load ids and
		// sheet cells. A driver named `periods=2026-01` would otherwise hand the page
		// a month list of their choosing.
		const G = parse('dispatch to "periods=2099-01" WITHHELD [PERIOD_FINALIZED] periods=2026-06 — nothing was written');
		check("a `periods=` planted in the SUBJECT is ignored", G.periods, ["2026-06"]);
		const H = parse('rename to "x — reason: not really" WITHHELD [PERIOD_FINALIZED] — nothing was written');
		check("a `— reason:` planted in the SUBJECT is not read as the note", H.note, "");

		// The negative controls. Both are real `*_blocked` actions and NEITHER is a
		// period refusal — this is the whole reason the query cannot key on names.
		check("db_export_blocked carries no PERIOD_ code",
			parse("Refused cross-site database export from 10.0.0.1 [CROSS_SITE]").code, "");
		check("dispatch_blocked's ROW_LOAD_MISMATCH carries none either",
			parse('Blocked assign to Someone [ROW_LOAD_MISMATCH] — {"code":"ROW_LOAD_MISMATCH"}').code, "");
		// And the forgery control: the writers run caller text through
		// scrubPurgeMarker(), which turns `[period` into `(period`.
		check("a scrubbed forgery does not read as a period refusal",
			parse('Blocked update: cell "(PERIOD_ nice try" [SHEET_CHANGED]').code, "");
	});

	// ⚠️ THE QUEUE AND THE RETENTION JOB MUST ASK THE SAME QUESTION. purgeOldAuditRefusals()
	// spares a row by matching this exact predicate; the endpoint lists a row by
	// matching it. If the two ever diverge, the queue starts promising history the
	// purge is quietly deleting — the failure test-purge-detail-marker.js exists to
	// stop, one layer up.
	//
	// ⚠️ BOTH SIDES ARE READ OUT OF THE SOURCE, never spelled out here. The
	// predicate carries SQL's LIKE escape inside a JS string inside (on the purge
	// side) a template literal, so any hand-written copy in this file would be a
	// third escaping of the same thing and would drift on its own. Comparing the
	// two extracted source fragments is the only version of this assertion that
	// cannot pass by accident.
	{
		const marked = /const MARKED = "([^"]+)";/.exec(SRC);
		const purged = /AND timestamp < \? AND (details NOT LIKE [^`]+)`/.exec(SRC);
		check("purgeOldAuditRefusals() still exempts on the marker", Boolean(purged), true);
		check("the queue selects on a marker predicate", Boolean(marked), true);
		check("…and the two are the SAME predicate, one negated",
			Boolean(marked && purged) && purged[1].trim() === marked[1].replace("LIKE", "NOT LIKE"), true);
		// A positive control on the extraction itself: if the regexes stopped
		// matching anything, the comparison above would be trivially true on two
		// nulls, which is exactly the "measuring nothing" case this file rejects.
		check("…and the extraction really found the marker text",
			Boolean(marked) && marked[1].includes("[PERIOD"), true);
	}

	// The route itself: Super Admin, and structurally read-only. Both were measured
	// (Dispatcher -> 403, no session -> 401); this pins them against a later edit.
	{
		const at = SRC.indexOf('app.get("/api/admin/period-lock-issues"');
		check("the endpoint exists", at > 0, true);
		const head = SRC.slice(at, at + 200);
		check("…and is Super Admin only", head.includes('requireRole("Super Admin")'), true);
		// The handler alone — `\n});` at column 0 is its close; every nested arrow
		// inside it is indented, so this cannot swallow the next declaration.
		const end = SRC.indexOf("\n});", at);
		check("…the handler's extent could be found", end > at, true);
		const body = SRC.slice(at, end);
		check("…and writes nothing", /\b(INSERT INTO|UPDATE |DELETE FROM)\b/.test(body), false);
		check("…and logs no audit row of its own (it is a read)", /logAudit/.test(body), false);
		// Positive control on the same extraction: a route that DOES write must trip
		// the very regex above, or "writes nothing" is measuring nothing.
		{
			const w = SRC.indexOf('app.put("/api/invoices/:id/adjust"');
			const wBody = SRC.slice(w, SRC.indexOf("\n});", w));
			check("…where the adjust route DOES trip the same test",
				/\b(INSERT INTO|UPDATE |DELETE FROM)\b/.test(wBody), true);
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// §9  THE REVIEW FINDINGS — each one paired with the case it must NOT break
	// ═══════════════════════════════════════════════════════════════════════
	section("§9  the writer cannot dictate its own audit row, and a failed call asserts nothing");

	// -----------------------------------------------------------------------
	// (a) FINDING 1 — the parser's defence was one-sided.
	//
	// §8 already plants `periods=` in the SUBJECT, i.e. the half that was closed:
	// everything structural is read from AFTER the `[CODE]` marker. But
	// periodRefusalDetail() puts caller-supplied text after it TOO — the `tail`,
	// and `— reason: <note>` straight off req.body — and it OMITS the `periods=`
	// fragment entirely when no month is named, which is EVERY
	// PERIOD_LOCK_UNREADABLE refusal (periodLockUnreadableResponse passes []) and
	// every PERIOD_UNRESOLVED one. An unanchored `tail.indexOf("periods=")` then
	// finds the caller's copy first and renders it in the Month(s) column.
	//
	// Six routes reach that shape with a caller-controlled note: invoice
	// adjust/revert, fix-driver-name, remove-rows and both driver-day overrides.
	// All Super Admin — but `super_admin` is a SHARED login and this queue IS the
	// record of who tried what, so "the writer can lie about their own row" is
	// exactly the property that must not hold.
	//
	// ⚠️ THE WRITER IS EXECUTED, NOT IMITATED. Hand-typing the detail string would
	// test a format this file invented; composing the real periodRefusalDetail()
	// with the real parsePeriodRefusalDetail() is the only version that fails when
	// either side of the pair drifts.
	// -----------------------------------------------------------------------
	guarded("extract + run periodRefusalDetail() -> parsePeriodRefusalDetail()", () => {
		const write = new Function(
			`${extract("scrubPurgeMarker")}\n${extract("auditText")}\n${extract("periodRefusalDetail")}\n` +
			`return periodRefusalDetail;`)();
		const parse = new Function(`${extract("parsePeriodRefusalDetail")}\nreturn parsePeriodRefusalDetail;`)();
		const round = (...a) => parse(write(...a));

		// The exact reproduction from the review, verbatim.
		const inj = round("adjust INV-2", "PERIOD_UNRESOLVED", [], "periods=2099-01,2098-02", "nothing was written");
		check("a `periods=` in the caller's NOTE supplies no months", inj.periods, []);
		check("…and is not laundered into the unnamed flag either", inj.unnamedPeriods, false);
		check("…while the note itself is still recorded verbatim", inj.note, "periods=2099-01,2098-02");
		check("…and the code is untouched", inj.code, "PERIOD_UNRESOLVED");

		// The other no-month code, and the other caller-influenced slot.
		check("a `periods=` in a PERIOD_LOCK_UNREADABLE note supplies none",
			round("adjust INV-2", "PERIOD_LOCK_UNREADABLE", [], "periods=2099-01", "nothing was written").periods, []);
		check("a `periods=` planted in the TAIL supplies none",
			round("x", "PERIOD_UNRESOLVED", [], "", "periods=2099-03").periods, []);
		// A second `— reason:` in the note cannot smuggle a list in behind the first.
		check("a note carrying its own `— reason:` still names no month",
			round("x", "PERIOD_LOCK_UNREADABLE", [], "periods=2099-01 — reason: gotcha", "nothing").periods, []);

		// ⚠️ THE PAIR. A refusal that really did name months must still render them,
		// or "the fix" is just breaking the feature. Both halves at once is the case
		// that matters: the row keeps its real months and gains none of the note's.
		const real = round("adjust INV-9", "PERIOD_FINALIZED", ["2026-07"], "late fuel receipt", "nothing was written");
		check("a genuine list still parses", real.periods, ["2026-07"]);
		check("…with its note intact", real.note, "late fuel receipt");
		const both = round("adjust INV-9", "PERIOD_FINALIZED", ["2026-07"], "periods=2099-01", "nothing was written");
		check("a genuine list beside a hostile note keeps ONLY the real months", both.periods, ["2026-07"]);
		check("multi-month lists are unaffected",
			round("x", "PERIOD_FINALIZED", ["2025-05", "2025-06", "2026-03"], "", "n").periods,
			["2025-05", "2025-06", "2026-03"]);

		// MUTANT: the shipped-before parser. Same file, same everything, except the
		// list is SEARCHED FOR in the tail instead of ANCHORED to the marker.
		const mutantSrc = extract("parsePeriodRefusalDetail")
			.replace('const list = /^[ \\t]*periods=/.exec(tail);', 'const list = tail.indexOf("periods=") >= 0 ? ["periods="] : null;')
			.replace("const after = tail.slice(list[0].length);",
				'const after = tail.slice(tail.indexOf("periods=") + "periods=".length);');
		const mutant = new Function(`${mutantSrc}\nreturn parsePeriodRefusalDetail;`)();
		check("the mutant really is the unanchored version (it differs from the source)",
			mutantSrc !== extract("parsePeriodRefusalDetail"), true);
		check("mutant `search the tail` accepts the caller's months",
			mutant(write("adjust INV-2", "PERIOD_UNRESOLVED", [], "periods=2099-01,2098-02", "nothing was written")).periods,
			["2099-01", "2098-02"]);
		check("…and agrees with the shipped parser on the genuine row",
			mutant(write("adjust INV-9", "PERIOD_FINALIZED", ["2026-07"], "late fuel receipt", "n")).periods, ["2026-07"]);

		// -------------------------------------------------------------------
		// (b) The SELECT folds ASCII case and this regex does not, so a row whose
		// only marker is a lower-case `[period_…]` IS listed and has no code. It
		// must still BOUND the caller's text: promoting the whole stored string
		// into the Attempted column gives a forgery a bigger stage than a real
		// refusal. Nothing can mint one today — scrubPurgeMarker() folds case —
		// which is precisely why it is asserted rather than assumed.
		// -------------------------------------------------------------------
		const forged = parse('update cell "[period_x] periods=2099-05" WITHHELD [SHEET_CHANGED] — nothing');
		check("a lower-case marker yields NO code", forged.code, "");
		check("…and no months", forged.periods, []);
		check("…and bounds the Attempted column at it", forged.attempted, 'update cell "');
		check("…rather than promoting the whole row", forged.attempted.includes("SHEET_CHANGED"), false);
		// PAIR: a REAL refusal that happens to carry a forged marker in its subject
		// still reads the real one, and reads it in the right place. ONE string
		// serves both halves so the mutant below is an exact contrast, not a
		// different input that happens to fail.
		const SHADOW = 'update cell "[period_x] periods=2099-05 — end" WITHHELD [PERIOD_FINALIZED] periods=2026-07 — nothing was written';
		const shadowed = parse(SHADOW);
		check("a real marker after a forged one still wins", shadowed.code, "PERIOD_FINALIZED");
		check("…and the months are the real ones", shadowed.periods, ["2026-07"]);
		// MUTANT: fold the CODE regex to match the SQL. First-match then lands on
		// the forgery and hands the caller the month list.
		const foldedSrc = extract("parsePeriodRefusalDetail")
			.replace("/\\[(PERIOD_[A-Z0-9_]+)\\]/.exec(details)", "/\\[(PERIOD_[A-Z0-9_]+)\\]/i.exec(details)");
		const folded = new Function(`${foldedSrc}\nreturn parsePeriodRefusalDetail;`)();
		check("the folded mutant really differs from the source",
			foldedSrc !== extract("parsePeriodRefusalDetail"), true);
		check("mutant `case-insensitive code regex` takes the forged marker as the anchor",
			folded(SHADOW).periods, ["2099-05"]);

		// -------------------------------------------------------------------
		// (a2) THE SAME FAMILY, FOUND DURING THIS ROUND. `suppressed` was read with
		// an unanchored scan of the whole string, so it too came off caller text —
		// and the real suffix, which logAuditRefusal() APPENDS, was being swallowed
		// into `note` because the note is read from the last " — reason: " before
		// it. Both are fixed by taking the terminal suffix off first.
		// -------------------------------------------------------------------
		const SUFFIX = " [+3 more identical refusal(s) suppressed in the previous 60s]";
		const coalesced = parse(write("adjust INV-2", "PERIOD_FINALIZED", ["2026-07"], "late receipt", "nothing was written") + SUFFIX);
		check("a genuine burst tally is still read", coalesced.suppressed, 3);
		check("…and no longer contaminates the stated reason", coalesced.note, "late receipt");
		check("…while the months are unaffected", coalesced.periods, ["2026-07"]);
		// A tally quoted MID-string — the shape a subject or a tail could carry — is
		// no longer read at all.
		check("a tally quoted inside the subject is not read",
			parse('rename "[+9 more identical refusal(s) suppressed] " WITHHELD [PERIOD_FINALIZED] periods=2026-07 — n').suppressed,
			null);
		check("a row with no tally still reports null, never 0",
			round("x", "PERIOD_FINALIZED", ["2026-07"], "", "n").suppressed, null);
		// MUTANT: the unanchored scan. Reads the quoted one and calls a single
		// refusal a burst of nine.
		const burstSrc = extract("parsePeriodRefusalDetail")
			.replace('/\\s*\\[\\+(\\d+) more identical refusal\\(s\\) suppressed in the previous \\d+s\\]$/.exec(raw0)',
				'/\\[\\+(\\d+) more identical refusal/.exec(raw0)');
		const burstMutant = new Function(`${burstSrc}\nreturn parsePeriodRefusalDetail;`)();
		check("the unanchored mutant really differs from the source",
			burstSrc !== extract("parsePeriodRefusalDetail"), true);
		check("mutant `scan the whole string` reads a quoted tally as real",
			burstMutant('rename "[+9 more identical refusal(s) suppressed] " WITHHELD [PERIOD_FINALIZED] periods=2026-07 — n').suppressed,
			9);
	});

	// The premise the `bound` fallback rests on: SQLite's LIKE really does select
	// the lower-case row, so it really can reach the parser. Measured rather than
	// asserted from the docs — the whole point of scrubPurgeMarker() folding case.
	guarded("the endpoint's own predicate selects a lower-case marker", () => {
		const Database = require("better-sqlite3");
		const mem = new Database(":memory:");
		mem.exec("CREATE TABLE audit_trail (details TEXT)");
		const ins = mem.prepare("INSERT INTO audit_trail (details) VALUES (?)");
		ins.run("real [PERIOD_FINALIZED] periods=2026-07");
		ins.run('forged "[period_x] periods=2099-05" [SHEET_CHANGED]');
		ins.run('scrubbed "(PERIOD_ nice try" [SHEET_CHANGED]');
		// ⚠️ THE CAPTURE IS JS SOURCE, NOT SQL. `MARKED` is a JS string literal whose
		// body reads `…LIKE '%[PERIOD\\_%' ESCAPE '\\'`, so the raw capture carries
		// DOUBLED backslashes; handing that straight to SQLite is "ESCAPE expression
		// must be a single character". One unescape, and it is the same predicate the
		// endpoint compiles at runtime.
		const marked = /const MARKED = "([^"]+)";/.exec(SRC);
		const sql = marked[1].replace(/\\\\/g, "\\");
		check("the predicate unescaped to a single-character ESCAPE", /ESCAPE '\\'$/.test(sql), true);
		const n = mem.prepare(`SELECT COUNT(*) AS n FROM audit_trail WHERE ${sql}`).get().n;
		mem.close();
		check("both the real AND the lower-case row are selected", n, 2);
	});

	// -----------------------------------------------------------------------
	// (c) FINDING 2 — a failed call must assert nothing about the server.
	// -----------------------------------------------------------------------
	check("queueCtxAnswered: no ctx -> not answered", queueCtxAnswered(undefined, "periodlock"), false);
	check("queueCtxAnswered: no map -> not answered", queueCtxAnswered({}, "periodlock"), false);
	check("queueCtxAnswered: an unlisted key -> not answered", queueCtxAnswered({ answered: {} }, "periodlock"), false);
	check("queueCtxAnswered: only an explicit true counts",
		[queueCtxAnswered({ answered: { periodlock: "yes" } }, "periodlock"),
			queueCtxAnswered({ answered: { periodlock: true } }, "periodlock")], [false, true]);

	{
		const failed = ctxOf(null);
		const dormant = ctxOf(periodLockReport(NO_LOCKS));

		check("payload absent -> periodLockInconclusiveText says NOTHING",
			periodLockInconclusiveText(failed), "");
		check("payload absent -> queueInconclusiveText says NOTHING",
			queueInconclusiveText("periodlock", failed), "");
		// PAIR: the dormant server, which really did answer, still gets its sentence.
		check("…where the dormant server, having answered, still explains itself",
			periodLockInconclusiveText(dormant),
			"automatic month-close is switched off and no month has ever been finalized, so nothing can be held by one");

		// MUTANT: the shipped-before text, which tested `=== false` on the two
		// readable flags (so a null fell through) and then asserted the flag state.
		const mutantAbsent = (ctx) => {
			if (!ctx) return "";
			if (ctx.periodLockMeaningful) return "";
			if (ctx.locksReadable === false) return "the month-end lock table can't be read, so every write guard in the app is refusing what it can't confirm is safe";
			if (ctx.auditReadable === false) return "the audit trail can't be read, so refused writes can't be listed";
			if (!ctx.lockedCount) {
				return ctx.closeEnabled
					? "no month has been finalized yet, so nothing can be held by one"
					: "automatic month-close is switched off and no month has ever been finalized, so nothing can be held by one";
			}
			return "";
		};
		check("mutant `null falls through to the dormant rung` reports a switched-off flag it was never told",
			mutantAbsent(failed).includes("automatic month-close is switched off"), true);
		check("…where the shipped one is silent", periodLockInconclusiveText(failed), "");
		check("…and the two still agree once the call has landed",
			mutantAbsent(dormant) === periodLockInconclusiveText(dormant), true);

		// ⚠️ THE CORE OF THE FINDING, AS AN ASSERTION, AND STATED PRECISELY. The two
		// contexts are NOT byte-identical — a failed call carries `null` where a
		// dormant server carries `true` — but every rung tests `=== false`, so null
		// and true take the SAME branch and the pre-fix function could not tell them
		// apart at all. One sentence, two completely different server states, and on
		// this database the sentence is false: 15 months are locked.
		check("the pre-fix logic hands a FAILED call the dormant server's exact sentence",
			mutantAbsent(failed) === mutantAbsent(dormant) && mutantAbsent(failed) !== "", true);
		check("…so `answered` is the only field that separates them",
			[failed.answered.periodlock, dormant.answered.periodlock,
				failed.locksReadable === false, dormant.locksReadable === false],
			[false, true, false, false]);
	}

	// ⚠️ THE SHARED PATH, NOT A SPECIAL CASE. `linxup` and `fuelverify` had the
	// identical shape — `Boolean(payload?.x)` collapsing "off" into "never heard" —
	// so the gate belongs in queueInconclusiveText() where all three pass through.
	check("fuelverify: payload absent -> no sentence",
		queueInconclusiveText("fuelverify", { answered: { fuelverify: false }, sweepHasRun: false }), "");
	check("fuelverify: answered and genuinely off -> the sentence",
		queueInconclusiveText("fuelverify", { answered: { fuelverify: true }, sweepHasRun: false }),
		"the fuel-event sweep has never run, so there is no fill history to check against");
	check("linxup: payload absent -> no sentence",
		queueInconclusiveText("linxup", { answered: { linxup: false }, linxupMeaningful: false, linxupHasToken: false }), "");
	check("linxup: answered with no token -> the sentence",
		queueInconclusiveText("linxup", { answered: { linxup: true }, linxupMeaningful: false, linxupHasToken: false }),
		"the Linxup webhook has no token configured, so nothing is being counted");
	check("linxup: answered WITH a token -> the other sentence",
		queueInconclusiveText("linxup", { answered: { linxup: true }, linxupMeaningful: false, linxupHasToken: true }),
		"no Linxup message has arrived since this server started");
	// The three ungated queues are unaffected — they establish unconditionally, so
	// they never reach an inconclusive sentence at all.
	check("duplicates has no inconclusive sentence either way",
		[queueInconclusiveText("duplicates", { answered: { duplicates: true } }),
			queueInconclusiveText("duplicates", { answered: { duplicates: false } })], ["", ""]);

	// -----------------------------------------------------------------------
	// (d) FINDING 3 — no count may be printed from a table that could not be read.
	// The server initialises refusalCount to 0 BEFORE its try, so `auditReadable`
	// is the only thing separating "none recorded" from "we could not look".
	// -----------------------------------------------------------------------
	{
		const broken = periodLockReport(AUDIT_BROKEN);
		check("the report still carries the server's 0 (periodIssueCounts adds it)", broken.refusalCount, 0);
		check("…and says the table was unreadable beside it", broken.auditReadable, false);
		check("…so the queue establishes nothing", broken.meaningful, false);

		const VIEW = fs.readFileSync(path.join(__dirname, "..", "client", "src", "views", "DataIssuesView.vue"), "utf8");
		const at = VIEW.indexOf(">Writes refused<");
		check("the rollup card exists", at > 0, true);
		const card = VIEW.slice(at, VIEW.indexOf("</div>", VIEW.indexOf("rollup-note", at)));
		// Positive control on the extraction: the count must actually be in there,
		// or the guard assertion below is measuring an empty string.
		check("…and really renders refusalCount", card.includes("periodLock.refusalCount"), true);
		check("…behind an auditReadable guard",
			/v-if="periodLock\.auditReadable"[\s\S]*periodLock\.refusalCount/.test(card), true);
		check("…and its note explains the unreadable case",
			/v-if="!periodLock\.auditReadable"/.test(card), true);
	}

	// -----------------------------------------------------------------------
	// (e) FINDING 4 — the unresolved-date arm returned before any status check.
	// -----------------------------------------------------------------------
	{
		const impact2 = (o) => frozenInvoiceImpact(normalizeFrozenInvoice(o));
		const paid = impact2({ status: "Paid", cause: "PERIOD_UNRESOLVED", periods: [], neverPayable: false, settled: true });
		check("a PAID invoice with an unresolvable date is not told to regenerate",
			/regenerated/.test(paid), false);
		check("…it is told nothing is waiting on it", paid.includes("nothing is waiting on it"), true);
		check("…and still that it cannot be adjusted", paid.startsWith("Can't be adjusted"), true);
		check("…and never to reopen a month (there is none to name)", /reopen/i.test(paid), false);
		check("a Rejected one reads the same way",
			impact2({ status: "Rejected", cause: "PERIOD_UNRESOLVED", periods: [], settled: true })
				.includes("nothing is waiting on it"), true);
		// PAIR: the case the branch was written for is unchanged.
		check("a Draft with an unresolvable date still says it has to be regenerated",
			impact2({ status: "Draft", cause: "PERIOD_UNRESOLVED", periods: [], neverPayable: true, settled: false })
				.includes("has to be regenerated"), true);
		// ⚠️ AN UNRECOGNISED STATUS IS A THIRD STATE and must keep the dead-end
		// sentence, because the server's noRemedy count keeps it too. `!neverPayable`
		// would have called it settled and dropped it out of both.
		check("an unrecognised status keeps the dead-end sentence",
			impact2({ status: "Voided?", cause: "PERIOD_UNRESOLVED", periods: [], neverPayable: false, settled: false })
				.includes("has to be regenerated"), true);
		check("normalizeFrozenInvoice: settled is server-told, absent -> false",
			normalizeFrozenInvoice({ id: 1 }).settled, false);
		check("…and only an explicit true counts",
			[normalizeFrozenInvoice({ settled: "yes" }).settled, normalizeFrozenInvoice({ settled: true }).settled],
			[false, true]);
		// MUTANT: derive `settled` by negating neverPayable. The unknown status flips.
		const mutantSettled = (o) => ({ ...normalizeFrozenInvoice(o), settled: !normalizeFrozenInvoice(o).neverPayable });
		check("mutant `settled = !neverPayable` mislabels an unrecognised status as finished",
			frozenInvoiceImpact(mutantSettled({ status: "Voided?", cause: "PERIOD_UNRESOLVED", periods: [] }))
				.includes("has to be regenerated"), false);

		// The server half, so the sentence and the headline count cannot drift apart.
		const ep = SRC.slice(SRC.indexOf('app.get("/api/admin/period-lock-issues"'));
		const body = ep.slice(0, ep.indexOf("\n});"));
		check("the endpoint publishes `settled`", /\bsettled,/.test(body), true);
		check("…and noRemedy consults it on the unresolved arm",
			/noRemedy: frozen\.filter\(\(f\) => f\.neverPayable \|\| \(f\.cause === "PERIOD_UNRESOLVED" && !f\.settled\)\)/.test(body), true);
	}

	// -----------------------------------------------------------------------
	// (f) FINDING 5 — the "indexed lookups" claim was the stated justification for
	// carrying no limiter. Corrected premise, corrected conclusion.
	// -----------------------------------------------------------------------
	check("the registry really holds six queues (the header sentence said five)", ISSUE_QUEUES.length, 6);
	{
		const at = SRC.indexOf('app.get("/api/admin/period-lock-issues"');
		const head = SRC.slice(at, at + 200);
		check("the route is limited", head.includes("periodIssueLimiter"), true);
		// ⚠️ ORDER IS THE POINT, not the presence: with the limiter first an
		// unauthenticated caller spends the whole bucket on 403s and locks out the
		// legitimate user behind that key. Same ordering as fuelEventsLimiter.
		check("…AFTER requireRole, not before",
			head.indexOf('requireRole("Super Admin")') < head.indexOf("periodIssueLimiter"), true);
		check("…and it is keyed per user, not per IP",
			/const periodIssueLimiter = rateLimit\(\{[\s\S]{0,400}?u:\$\{id\}/.test(SRC), true);
	}

	console.log(`\n${pass} passed, ${fail} failed`);
	if (failures.length) console.error("\nFAILURES\n" + failures.join("\n"));
	process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
	console.error("harness error:", err);
	process.exit(1);
});
