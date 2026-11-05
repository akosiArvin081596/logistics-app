#!/usr/bin/env node
// lib/invoice-status.js: one invoice status on every completed load, the rule.
//
//   §1 the eight statuses, their CSV words, the kill switch's shape
//   §2 one case per row of the rule, first match wins
//   §3 rule 12: each branch, on the mailbox alone, for each kind of load that reaches it
//   §4 an unbilled load must not read billed, and a billed one must not read unbilled:
//      a person-closed MAYBE_SENT, a cleared factoring mark, no claim with the job off, a
//      deleted job draft, a blank `via`, a Bison row, a load only mentioned, a filled
//      Payments Table row above Needs attention and above "in neither"
//   §5 closed months never read Needs attention from the mailbox
//   §6 with the mailbox pass off nothing claims "No invoice found" or "in neither", and
//      what was found stays found
//   §7 an answer holds codes, numbers and a day: never an address or a subject
//
// Made-up data only, no database, no network. Fails on a tree without the module.
//   node scripts/test-invoice-status.js      # exits 1 on any failure
"use strict";

const path = require("path");

const ROOT = path.join(__dirname, "..");
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));

let pass = 0;
const failures = [];
// An answer's fields in any order: what a client reads is the field, not its place.
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
function eq(actual, expected, label) {
	const a = canon(actual);
	const e = canon(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { console.log(`\n${t}`); }
function finish() {
	for (const f of failures) console.log(`  FAIL ${f}`);
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(failures.length ? 1 : 0);
}

let S = null;
try {
	S = require(path.join(ROOT, "lib", "invoice-status.js"));
} catch {
	// asserted next
}
section("§1  the eight statuses, the words, the kill switch");
ok(S, "§1 FAILS ON THE OLD CODE: lib/invoice-status.js exists");
if (!S) finish();
const { STATUS, STATUS_LABELS, STATUS_CODES, FOUND, statusOf, exportCells, statusEnabled } = S;

eq(Object.values(STATUS).map((s) => STATUS_LABELS[s]), [
	"Sent by LogisX", "Invoiced by hand", "Draft in Gmail", "Waiting", "Needs attention", "Factored (Triumph)", "No invoice found", "Couldn't check",
], "§1 the eight statuses and their words");
for (const v of ["false", "0", "no", "off", "FALSE", "No", "OFF", " off "]) {
	eq(statusEnabled({ INVOICE_STATUS_ENABLED: v }), false, `§1 INVOICE_STATUS_ENABLED=${JSON.stringify(v)}: off`);
}
for (const v of [undefined, "", "true", "1", "yes", "on", "anything"]) {
	eq(statusEnabled({ INVOICE_STATUS_ENABLED: v }), true, `§1 INVOICE_STATUS_ENABLED=${JSON.stringify(v)}: on, it's a kill switch`);
}
eq(statusEnabled(), true, "§1 no settings at all: on");
for (const code of STATUS_CODES) {
	ok(!rules.REASON_CODES.includes(code), `§1 ${code} is this rule's own, not a claim's`);
}

// ------------------------------------------------------------------ made-up data
const LOAD = "900000001";
const INV = "11042026-7";
const LATER = "2026-11-04T15:00:00.000Z";
const claim = (over = {}) => ({ load_key: LOAD, load_id: LOAD, state: "baseline", reason_code: "", stage: "", delivery: "", invoice_id: "", invoice_date: "", sent_at: "", drafted_at: "", changed_fields: "", ...over });
const row = (over = {}) => ({ id: 1, load_id: LOAD, invoice_id: INV, order_number: "", via: "imap", created_at: "2026-11-03T15:00:00Z", ...over });
const saved = (over = {}) => ({
	load_key: LOAD, drafts_invoice: 0, drafts_mention: 0, sent_invoice: 0, sent_mention: 0, first_sent_at: "",
	searched_at: LATER, tried_at: LATER, result: "answered",
	payments_checked_at: LATER, payments_invoice_number: 0, payments_payment_date: 0, payments_status: 0, updated_at: LATER, ...over,
});
const inSent = saved({ sent_invoice: 1, first_sent_at: "2026-11-02T18:30:00.000Z" });
const inDrafts = saved({ drafts_invoice: 1 });
const clean = saved();
const mentioned = saved({ sent_mention: 1 });
const filled = saved({ payments_invoice_number: 1 });
const failed = saved({ result: "failed", searched_at: "" });
const read = (over = {}) => statusOf({
	claim: null, rows: [], presses: [], factored: false, triumphDone: false, saved: null,
	isBison: false, closedMonth: () => false, sweepOn: false, passOn: true, dayOf: (iso) => String(iso).slice(0, 10), ...over,
});
const { SENT, BY_HAND, DRAFT, WAITING, ATTENTION, FACTORED, NONE_FOUND, UNKNOWN } = STATUS;
const SENT_CLAIM = claim({ state: "drafted", delivery: "send", stage: "recorded", invoice_id: INV, invoice_date: "2026-11-02", sent_at: "2026-11-02T18:30:00.000Z" });
const JOB_DRAFT = claim({ state: "drafted", stage: "recorded", invoice_id: INV, invoice_date: "2026-11-02", drafted_at: "2026-11-02T18:30:00.000Z" });
const HELD = claim({ state: "needs_attention", reason_code: "TOTAL_MISMATCH" });
const BY_SENT_MAIL = { status: BY_HAND, found: FOUND.SENT_MAIL, date: "2026-11-02" };
const FROM_PAYMENTS = { status: BY_HAND, found: FOUND.PAYMENTS };

// ===================================================================== §2
section("§2  one case per row of the rule, first match wins");
eq(read({ factored: null }), { status: UNKNOWN, code: "FACTORING_UNREADABLE" }, "§2 rule 1: the factoring marker can't be read: Couldn't check");
eq(read({ factored: null, claim: SENT_CLAIM, saved: inSent }), { status: UNKNOWN, code: "FACTORING_UNREADABLE" }, "§2 rule 1 comes first, a sent claim or an invoice in Sent Mail included");

eq(read({ factored: true }), { status: FACTORED }, "§2 rule 2: marked factored now");
eq(read({ rows: [row({ via: "triumph" })] }), { status: FACTORED }, "§2 rule 2: a draft row via triumph");
eq(read({ triumphDone: true }), { status: FACTORED }, "§2 rule 2: a Triumph submission that went");
eq(read({ factored: true, saved: inSent, claim: HELD }), { status: FACTORED }, "§2 rule 2 comes before what the mailbox and the claim say");

eq(read({ claim: SENT_CLAIM }), { status: SENT, invoiceId: INV, date: "2026-11-02" }, "§2 rule 3: drafted, delivery send, stage recorded: Sent by LogisX, with its date and number");
eq(read({ claim: { ...SENT_CLAIM, stage: "appended" } }), { status: SENT, invoiceId: INV, date: "2026-11-02" }, "§2 rule 3: stage appended too");
eq(read({ claim: { ...SENT_CLAIM, changed_fields: "pods,payment" } }), { status: SENT, invoiceId: INV, date: "2026-11-02", changed: ["pods", "payment"] }, "§2 rule 3: a load changed after its send keeps Sent, with the mark");
eq(read({ claim: { ...SENT_CLAIM, invoice_date: "" } }), { status: SENT, invoiceId: INV, date: "2026-11-02" }, "§2 rule 3: no invoice date on the claim: the day it was sent");

const SEND_STARTED = claim({ delivery: "send", stage: "appending", invoice_id: INV });
eq(read({ claim: { ...SEND_STARTED, state: "queued", reason_code: "SEND_UNCONFIRMED" } }), { status: WAITING, code: "SEND_UNCONFIRMED" }, "§2 rule 4: a send that got no answer, queued: Waiting");
eq(read({ claim: { ...SEND_STARTED, state: "working" } }), { status: WAITING, code: "SEND_UNCONFIRMED" }, "§2 rule 4: ...and being searched for");
eq(read({ claim: { ...SEND_STARTED, state: "needs_attention", reason_code: "MAYBE_SENT" } }), { status: ATTENTION, code: "MAYBE_SENT" }, "§2 rule 4: ...and given to a person: Needs attention");
eq(read({ claim: { ...SEND_STARTED, state: "needs_attention", reason_code: "MAYBE_SENT" }, saved: clean }), { status: ATTENTION, code: "MAYBE_SENT" }, "§2 rule 4: a clean mailbox doesn't clear a maybe-sent load");

eq(read({ claim: claim({ state: "needs_attention", reason_code: "MAYBE_IN_GMAIL", stage: "appending" }) }), { status: ATTENTION, code: "MAYBE_IN_GMAIL" }, "§2 rule 5: MAYBE_IN_GMAIL");
eq(read({ claim: claim({ state: "needs_attention", reason_code: "IN_GMAIL_UNRECORDED", stage: "appended" }), saved: inSent }), { status: ATTENTION, code: "IN_GMAIL_UNRECORDED" }, "§2 rule 5: IN_GMAIL_UNRECORDED, whatever the mailbox says");
eq(read({ presses: [{ invoice_id: INV, effective: "maybe_drafted" }] }), { status: ATTENTION, code: "INVOICE_MAYBE_DRAFTED" }, "§2 rule 5: a press row reading maybe drafted");

eq(read({ presses: [{ invoice_id: INV, effective: "in_flight" }] }), { status: WAITING, code: "HAND_DRAFT_IN_FLIGHT" }, "§2 rule 6: a press row in flight");
eq(read({ presses: [{ invoice_id: INV, effective: "in_flight" }, { invoice_id: "11042026-8", effective: "maybe_drafted" }] }), { status: ATTENTION, code: "INVOICE_MAYBE_DRAFTED" }, "§2 rule 5 before rule 6: one press in flight, another maybe drafted");

eq(read({ claim: JOB_DRAFT, saved: inSent }), { ...BY_SENT_MAIL, invoiceId: INV }, "§2 rule 7: the job's own draft, an invoice in Sent Mail: Invoiced by hand");
eq(read({ claim: JOB_DRAFT, saved: inDrafts }), { status: DRAFT, invoiceId: INV, whose: "job", searchedAt: LATER }, "§2 rule 7: FAILS ON THE OLD CODE: ...in Drafts: Draft in Gmail, the job's, as of that search");
eq(read({ claim: JOB_DRAFT }), { status: DRAFT, invoiceId: INV, whose: "job", sentUnchecked: true }, "§2 rule 7: FAILS ON THE OLD CODE: ...not searched yet: Draft in Gmail, Sent Mail not checked yet: a person may already have sent it");
eq(read({ claim: JOB_DRAFT, saved: failed }), { status: DRAFT, invoiceId: INV, whose: "job", sentUnchecked: true }, "§2 rule 7: FAILS ON THE OLD CODE: ...the search failed: not searched, so the same");
eq(read({ claim: JOB_DRAFT, saved: clean }), { status: ATTENTION, code: "DRAFT_NOT_IN_GMAIL", invoiceId: INV }, "§2 rule 7: ...searched, in neither: Needs attention");

for (const via of ["imap", "n8n", "", null, undefined, "some-later-path"]) {
	const rows = [row({ via })];
	const name = `via ${JSON.stringify(via)}`;
	eq(read({ rows, saved: inSent }), { ...BY_SENT_MAIL, invoiceId: INV }, `§2 rule 8: a draft row ${name}, an invoice in Sent Mail: Invoiced by hand`);
	eq(read({ rows, saved: inDrafts }), { status: DRAFT, invoiceId: INV, whose: "person", searchedAt: LATER }, `§2 rule 8: FAILS ON THE OLD CODE: ${name}, in Drafts: Draft in Gmail, a person's, as of that search`);
	eq(read({ rows, saved: clean }), { status: ATTENTION, code: "DRAFT_NOT_IN_GMAIL", invoiceId: INV }, `§2 rule 8: ${name}, searched, in neither: Needs attention`);
	eq(read({ rows }), { status: BY_HAND, invoiceId: INV, found: FOUND.DRAFT_ROW, sentUnchecked: true }, `§2 rule 8: ${name}, not searched yet: Invoiced by hand, Sent Mail not checked yet`);
	eq(read({ rows, saved: failed }), { status: BY_HAND, invoiceId: INV, found: FOUND.DRAFT_ROW, sentUnchecked: true }, `§2 rule 8: ${name}, the search failed: the same`);
}
eq(read({ rows: [row({ invoice_id: "old" }), row({ id: 2, invoice_id: INV })], saved: inSent }), { ...BY_SENT_MAIL, invoiceId: INV }, "§2 rule 8: two rows: the newest one's number");
eq(read({ rows: [row({ via: "auto-imap" })], saved: inDrafts }), { status: DRAFT, invoiceId: INV, whose: "job", searchedAt: LATER }, "§2 rule 7: FAILS ON THE OLD CODE: a job's row with no drafted claim still reads as the job's");
eq(read({ rows: [row({ via: "auto-smtp", created_at: "2026-11-02T18:30:00Z" })] }), { status: SENT, invoiceId: INV, date: "2026-11-02" }, "§2 a row saying the job sent it reads Sent by LogisX, whatever the claim");

eq(read({ claim: claim({ state: "queued" }) }), { status: WAITING }, "§2 rule 9: queued: Waiting");
eq(read({ claim: claim({ state: "queued", reason_code: "RETRY_LATER" }) }), { status: WAITING, code: "RETRY_LATER" }, "§2 rule 9: ...with its code");
eq(read({ claim: claim({ state: "working" }) }), { status: WAITING }, "§2 rule 9: working: Waiting");
eq(read({ claim: claim({ state: "waiting", reason_code: "DRIVER_PENDING" }) }), { status: WAITING, code: "DRIVER_PENDING" }, "§2 rule 9: the driver's record: Waiting");
eq(read({ claim: claim({ state: "waiting", reason_code: "WAITING_POD" }), sweepOn: true }), { status: WAITING, code: "WAITING_POD" }, "§2 rule 9: the sweep on: its other waiting codes too");
eq(read({ claim: claim({ state: "waiting", reason_code: "SEND_SETTLING" }), sweepOn: true }), { status: WAITING, code: "SEND_SETTLING" }, "§2 rule 9: the sweep on: settling");
eq(read({ claim: claim({ state: "waiting", reason_code: "WAITING_POD" }), sweepOn: false, saved: clean }), { status: NONE_FOUND, searchedAt: LATER }, "§2 rule 9: the sweep off: nothing will move it, so it isn't Waiting");

eq(read({ claim: HELD, saved: inSent }), BY_SENT_MAIL, "§2 rule 10: held, an invoice in Sent Mail: Invoiced by hand");
eq(read({ claim: HELD, saved: clean }), { status: ATTENTION, code: "TOTAL_MISMATCH" }, "§2 rule 10: held, otherwise: Needs attention, why");
eq(read({ claim: HELD }), { status: ATTENTION, code: "TOTAL_MISMATCH" }, "§2 rule 10: ...not searched yet");
eq(read({ claim: HELD, saved: inDrafts }), { status: DRAFT, code: "TOTAL_MISMATCH", searchedAt: LATER }, "§2 rule 10: FAILS ON THE OLD CODE: ...an invoice in Drafts: Draft in Gmail, since \"draft it by hand\" would bill the load twice; the hold's reason stays on it");
eq(read({ claim: HELD, saved: inDrafts, passOn: false }), { status: DRAFT, code: "TOTAL_MISMATCH", searchedAt: LATER }, "§2 rule 10: FAILS ON THE OLD CODE: ...with the pass off too: what was found stays found");
eq(read({ claim: HELD, saved: saved({ drafts_invoice: 1, sent_mention: 1 }) }), { status: DRAFT, code: "TOTAL_MISMATCH", searchedAt: LATER, mentioned: true }, "§2 rule 10: FAILS ON THE OLD CODE: ...an invoice in Drafts over a mention, which it keeps");
eq(read({ claim: HELD, saved: saved({ drafts_invoice: 1, sent_invoice: 1, first_sent_at: "2026-11-02T18:30:00.000Z" }) }), BY_SENT_MAIL, "§2 rule 10: ...in both: Sent Mail wins");
eq(read({ claim: claim({ state: "needs_attention", reason_code: "MAILBOX_HIT" }), saved: inDrafts }), { status: DRAFT, code: "MAILBOX_HIT", searchedAt: LATER }, "§2 rule 10: FAILS ON THE OLD CODE: ...a hit from Try again that was an invoice in Drafts");

// A sweep-held load whose invoice has turned up: its "draft it by hand" words would bill it twice.
const SWEEP_HELD = claim({ state: "waiting", reason_code: "RATECON_MISSING" });
eq(read({ claim: SWEEP_HELD, sweepOn: true, saved: inSent }), BY_SENT_MAIL, "§2 rule 9: FAILS ON THE OLD CODE: the sweep's waiting claim, an invoice in Sent Mail: Invoiced by hand");
eq(read({ claim: SWEEP_HELD, sweepOn: true, saved: inDrafts }), { status: DRAFT, code: "RATECON_MISSING", searchedAt: LATER }, "§2 rule 9: FAILS ON THE OLD CODE: ...an invoice in Drafts: Draft in Gmail, its reason kept");
eq(read({ claim: SWEEP_HELD, sweepOn: true, saved: clean }), { status: WAITING, code: "RATECON_MISSING" }, "§2 rule 9: ...nothing found: still Waiting");
eq(read({ claim: claim({ state: "waiting", reason_code: "DRIVER_PENDING" }), saved: inSent }), { status: WAITING, code: "DRIVER_PENDING" }, "§2 rule 9: a driver's tap isn't one: it looks before it sends");

// A clean answer speaks only for what existed when it came.
const SINCE = "2026-11-05T09:00:00.000Z";
eq(read({ claim: { ...JOB_DRAFT, drafted_at: SINCE }, saved: clean }), { status: DRAFT, invoiceId: INV, whose: "job", sentUnchecked: true }, "§2 FAILS ON THE OLD CODE: the job's draft made after a clean search isn't in neither: not searched");
eq(read({ rows: [row({ created_at: SINCE })], saved: clean }), { status: BY_HAND, invoiceId: INV, found: FOUND.DRAFT_ROW, sentUnchecked: true }, "§2 FAILS ON THE OLD CODE: a person's draft made after a clean search: the same");
eq(read({ rows: [row(), row({ id: 2, created_at: SINCE })], saved: clean }).sentUnchecked, true, "§2 FAILS ON THE OLD CODE: ...the newest row decides");
eq(read({ rows: [row({ created_at: LATER })], saved: clean }).code, "DRAFT_NOT_IN_GMAIL", "§2 ...made in the same moment as the search: it holds");
eq(read({ rows: [row()], saved: clean }).code, "DRAFT_NOT_IN_GMAIL", "§2 ...made before it: in neither, as before");
eq(read({ rows: [row({ created_at: "not a time" })], saved: clean }).code, "DRAFT_NOT_IN_GMAIL", "§2 ...a time that can't be read proves no draft came after");
eq(read({ rows: [row({ created_at: SINCE })], saved: mentioned }), { status: UNKNOWN, code: "MENTIONED", invoiceId: INV }, "§2 ...a mention isn't clean: it keeps its words");
eq(read({ rows: [row({ created_at: SINCE })], saved: filled }), { ...FROM_PAYMENTS, invoiceId: INV }, "§2 ...nor a filled Payments Table row");

// The mark the job keeps on its own draft, whatever the job's mode.
const CHANGED_DRAFT = { ...JOB_DRAFT, changed_fields: "payment,pods" };
const MARK = ["payment", "pods"];
eq(read({ claim: CHANGED_DRAFT }), { status: DRAFT, invoiceId: INV, whose: "job", sentUnchecked: true, changed: MARK }, "§2 rule 7: FAILS ON THE OLD CODE: a changed draft carries its mark, not searched");
eq(read({ claim: CHANGED_DRAFT, saved: inDrafts }), { status: DRAFT, invoiceId: INV, whose: "job", searchedAt: LATER, changed: MARK }, "§2 rule 7: FAILS ON THE OLD CODE: ...found in Drafts");
eq(read({ claim: CHANGED_DRAFT, saved: inSent }), { ...BY_SENT_MAIL, invoiceId: INV, changed: MARK }, "§2 rule 7: FAILS ON THE OLD CODE: ...found in Sent Mail");
eq(read({ claim: CHANGED_DRAFT, saved: clean }), { status: ATTENTION, code: "DRAFT_NOT_IN_GMAIL", invoiceId: INV, changed: MARK }, "§2 rule 7: FAILS ON THE OLD CODE: ...in neither");
eq(read({ claim: CHANGED_DRAFT, saved: mentioned }), { status: UNKNOWN, code: "MENTIONED", invoiceId: INV, changed: MARK }, "§2 rule 7: FAILS ON THE OLD CODE: ...only a mention");
eq(read({ claim: CHANGED_DRAFT, saved: filled }), { ...FROM_PAYMENTS, invoiceId: INV, changed: MARK }, "§2 rule 7: FAILS ON THE OLD CODE: ...on the Payments Table");
eq("changed" in read({ claim: JOB_DRAFT }), false, "§2 rule 7: no change: no mark");
eq("changed" in read({ claim: { ...CHANGED_DRAFT, state: "skipped" }, rows: [row({ via: "auto-imap" })] }), false, "§2 rule 7: a mark on a claim no longer drafted isn't one: nothing can clear it");
eq(read({ claim: claim({ state: "needs_attention", reason_code: "MAILBOX_HIT" }), saved: mentioned }), { status: ATTENTION, code: "MAILBOX_HIT", mentioned: true }, "§2 rule 10: ...a hit that was only a mention stays held");

for (const col of ["payments_invoice_number", "payments_payment_date", "payments_status"]) {
	eq(read({ saved: saved({ [col]: 1 }) }), FROM_PAYMENTS, `§2 rule 11: ${col} filled: Invoiced by hand (Payments Table)`);
}

// ===================================================================== §3
section("§3  rule 12: each branch, on the mailbox alone");
const REACHES_12 = {
	"no claim": null,
	baseline: claim(),
	"OFF_GAP": claim({ state: "needs_attention", reason_code: "OFF_GAP" }),
	"skipped, no row": claim({ state: "skipped", reason_code: "BROKER_OPTED_OUT" }),
	"a mark since cleared": claim({ state: "skipped", reason_code: "LOAD_FACTORED" }),
	"waiting NOT_COMPLETED on a load that now reads completed": claim({ state: "waiting", reason_code: "NOT_COMPLETED" }),
};
for (const [name, c] of Object.entries(REACHES_12)) {
	eq(read({ claim: c, saved: inSent }), BY_SENT_MAIL, `§3 ${name}: an invoice in Sent Mail: Invoiced by hand`);
	eq(read({ claim: c, saved: inDrafts }), { status: DRAFT, searchedAt: LATER }, `§3 FAILS ON THE OLD CODE: ${name}: an invoice in Drafts: Draft in Gmail, as of that search`);
	eq(read({ claim: c, saved: mentioned }), { status: UNKNOWN, code: "MENTIONED" }, `§3 ${name}: only a mention: Couldn't check`);
	eq(read({ claim: c, saved: failed }), { status: UNKNOWN, code: "SEARCH_FAILED" }, `§3 ${name}: the search failed: Couldn't check`);
	eq(read({ claim: c }), { status: UNKNOWN, code: "NOT_SEARCHED" }, `§3 ${name}: not searched yet: Couldn't check`);
	eq(read({ claim: c, saved: clean, isBison: true }), { status: UNKNOWN, code: "BISON_ORDER_NUMBER" }, `§3 ${name}: a Bison load with no row: Couldn't check`);
	eq(read({ claim: c, saved: clean }), { status: NONE_FOUND, searchedAt: LATER }, `§3 ${name}: both mailboxes answered with nothing: No invoice found`);
}
eq(read({ saved: saved({ payments_checked_at: "" }) }), { status: UNKNOWN, code: "PAYMENTS_NOT_READ" }, "§3 the Payments Table never read for this load: a clean mailbox isn't enough");
eq(read({ saved: saved({ sent_mention: 0, drafts_mention: 1 }) }), { status: UNKNOWN, code: "MENTIONED" }, "§3 a mention in Drafts counts too");
eq(read({ saved: saved({ sent_invoice: 1, drafts_invoice: 1, first_sent_at: "2026-11-02T18:30:00.000Z" }) }), BY_SENT_MAIL, "§3 first match: Sent Mail before Drafts");
eq(read({ saved: saved({ drafts_invoice: 1, sent_mention: 1 }) }), { status: DRAFT, searchedAt: LATER, mentioned: true }, "§3 FAILS ON THE OLD CODE: first match: an invoice in Drafts before a mention, which it keeps");
eq(read({ saved: saved({ sent_invoice: 1, result: "failed", first_sent_at: "2026-11-02T18:30:00.000Z" }) }), BY_SENT_MAIL, "§3 a later search that failed doesn't lose an invoice already found");
eq(read({ saved: saved({ sent_invoice: 1, first_sent_at: "" }) }), { status: BY_HAND, found: FOUND.SENT_MAIL }, "§3 an invoice whose date couldn't be read has no date");

// ===================================================================== §4
section("§4  an unbilled load must not read billed, and a billed one must not read unbilled");
const CLOSED_MAYBE = claim({ state: "skipped", reason_code: "DRAFTED_BY_HAND", delivery: "send", stage: "appending", invoice_id: "11042026-9" });
eq(read({ claim: CLOSED_MAYBE, rows: [row()], saved: inSent }), { ...BY_SENT_MAIL, invoiceId: INV }, "§4 a person closed a MAYBE_SENT with their draft: rule 8, not Waiting for good");
eq(read({ claim: CLOSED_MAYBE, rows: [row()] }), { status: BY_HAND, invoiceId: INV, found: FOUND.DRAFT_ROW, sentUnchecked: true }, "§4 ...not searched yet");
eq(read({ claim: { ...CLOSED_MAYBE, reason_code: "LOAD_FACTORED" }, saved: clean }), { status: UNKNOWN, code: "MAYBE_SENT" }, "§4 a send that started, closed with no row: never No invoice found, whatever the mailbox says");
eq(read({ claim: { ...CLOSED_MAYBE, reason_code: "LOAD_FACTORED" }, saved: inSent }), BY_SENT_MAIL, "§4 ...and an invoice found there reads as found");

eq(read({ claim: claim({ state: "skipped", reason_code: "LOAD_FACTORED" }), factored: false, saved: clean }), { status: NONE_FOUND, searchedAt: LATER }, "§4 a factoring mark since cleared reads by the mailbox");
eq(read({ claim: null, saved: clean }), { status: NONE_FOUND, searchedAt: LATER }, "§4 no claim with the job off reads by the mailbox");
eq(read({ claim: JOB_DRAFT, saved: clean }).code, "DRAFT_NOT_IN_GMAIL", "§4 a job draft deleted from Gmail doesn't read Draft in Gmail");
eq(read({ rows: [row({ via: null })], saved: clean }).status, ATTENTION, "§4 a blank `via` is a row, never No invoice found");
eq(read({ claim: claim({ state: "needs_attention", reason_code: "OFF_GAP" }), saved: clean }).status, NONE_FOUND, "§4 an OFF_GAP load can reach No invoice found");

const BISON_ROW = [row({ order_number: "7000001", via: "imap" })];
eq(read({ rows: BISON_ROW, saved: inSent, isBison: true }), { ...BY_SENT_MAIL, invoiceId: INV }, "§4 a Bison row found by its order number: Invoiced by hand");
eq(read({ rows: BISON_ROW, saved: clean, isBison: true }).code, "DRAFT_NOT_IN_GMAIL", "§4 its order number was searched, so in neither means in neither");
eq(read({ rows: [row({ order_number: "" })], saved: clean, isBison: true }), { status: UNKNOWN, code: "BISON_ORDER_NUMBER", invoiceId: INV }, "§4 a Bison row with no order number can't be found by a search, so it isn't called missing");
eq(read({ claim: JOB_DRAFT, saved: clean, isBison: true }), { status: UNKNOWN, code: "BISON_ORDER_NUMBER", invoiceId: INV }, "§4 the same for the job's own Bison draft");

eq(read({ claim: JOB_DRAFT, saved: mentioned }), { status: UNKNOWN, code: "MENTIONED", invoiceId: INV }, "§4 rule 7, only a mention: not in neither, and not proven a draft");
eq(read({ rows: [row()], saved: mentioned }), { status: UNKNOWN, code: "MENTIONED", invoiceId: INV }, "§4 rule 8, only a mention");
eq(read({ claim: HELD, saved: mentioned }), { status: ATTENTION, code: "TOTAL_MISMATCH", mentioned: true }, "§4 rule 10, only a mention: Needs attention, saying so");

eq(read({ claim: HELD, saved: filled }), FROM_PAYMENTS, "§4 a filled Payments Table row above rule 10: it reads billed, not held");
eq(read({ claim: { ...HELD, reason_code: "TOTAL_MISMATCH" }, saved: saved({ payments_status: 1, sent_mention: 1 }) }), FROM_PAYMENTS, "§4 ...above a mention too");
eq(read({ claim: JOB_DRAFT, saved: filled }), { ...FROM_PAYMENTS, invoiceId: INV }, "§4 above rule 7's in neither");
eq(read({ rows: [row()], saved: filled }), { ...FROM_PAYMENTS, invoiceId: INV }, "§4 above rule 8's in neither");
eq(read({ claim: claim({ state: "queued" }), saved: filled }), { status: WAITING }, "§4 rule 9 stays above it: the job is on the load right now");
eq(read({ saved: saved({ payments_payment_date: 1, sent_invoice: 1, first_sent_at: "2026-11-02T18:30:00.000Z" }), rows: [row()] }), { ...BY_SENT_MAIL, invoiceId: INV }, "§4 an invoice in Sent Mail says more than the table: it has the date");

// ===================================================================== §5
section("§5  closed months never read Needs attention from the mailbox");
const closedMonth = () => true;
eq(read({ claim: JOB_DRAFT, saved: clean, closedMonth }), { status: UNKNOWN, code: "DRAFT_NOT_IN_GMAIL", invoiceId: INV }, "§5 rule 7, closed month, in neither: Couldn't check, the same sentence");
eq(read({ rows: [row()], saved: clean, closedMonth }), { status: UNKNOWN, code: "DRAFT_NOT_IN_GMAIL", invoiceId: INV }, "§5 rule 8, the same");
eq(read({ rows: [row()], saved: clean, closedMonth: () => { throw new Error("made up"); } }).status, UNKNOWN, "§5 a month that can't be read isn't raised either");
eq(read({ saved: clean, closedMonth }), { status: NONE_FOUND, searchedAt: LATER }, "§5 No invoice found on a closed month is a status, not an alert");
eq(read({ claim: claim({ state: "needs_attention", reason_code: "CLOSED_MONTH" }), saved: clean, closedMonth }), { status: ATTENTION, code: "CLOSED_MONTH" }, "§5 the job's own CLOSED_MONTH stays as it is");
let asked = 0;
read({ saved: clean, closedMonth: () => { asked++; return true; } });
read({ claim: SENT_CLAIM, closedMonth: () => { asked++; return true; } });
eq(asked, 0, "§5 the month is read only when it can change the answer: a dashboard read stays cheap");

// ===================================================================== §6
section("§6  the mailbox pass off: nothing claims a negative");
const off = (over) => read({ passOn: false, ...over });
eq(off({ saved: null }), { status: UNKNOWN, code: "NOT_SEARCHED" }, "§6 an old load with no record: not looked at, never No invoice found");
eq(off({ claim: claim(), saved: null }), { status: UNKNOWN, code: "NOT_SEARCHED" }, "§6 a baseline load: the same");
eq(off({ saved: clean }), { status: UNKNOWN, code: "NOT_SEARCHED" }, "§6 a clean row saved earlier claims nothing once the pass is off");
eq(off({ saved: clean, isBison: true }), { status: UNKNOWN, code: "NOT_SEARCHED" }, "§6 a Bison load: the same");
eq(off({ claim: JOB_DRAFT, saved: clean }), { status: DRAFT, invoiceId: INV, whose: "job", sentUnchecked: true }, "§6 rule 7: FAILS ON THE OLD CODE: no in neither without the pass, and Sent Mail is unchecked");
eq(off({ claim: JOB_DRAFT, saved: inDrafts }), { status: DRAFT, invoiceId: INV, whose: "job", searchedAt: LATER }, "§6 rule 7: FAILS ON THE OLD CODE: a draft found stays found, as of that search");
eq(off({ rows: [row()], saved: clean }), { status: BY_HAND, invoiceId: INV, found: FOUND.DRAFT_ROW, sentUnchecked: true }, "§6 rule 8: no in neither without the pass");
eq(off({ saved: inSent }), BY_SENT_MAIL, "§6 what was found stays found");
eq(off({ saved: inDrafts }), { status: DRAFT, searchedAt: LATER }, "§6 FAILS ON THE OLD CODE: ...in Drafts too");
eq(off({ saved: filled }), FROM_PAYMENTS, "§6 ...and on the Payments Table");
eq(off({ saved: mentioned }), { status: UNKNOWN, code: "MENTIONED" }, "§6 a mention is still doubt");
eq(off({ claim: SENT_CLAIM }), { status: SENT, invoiceId: INV, date: "2026-11-02" }, "§6 the app's own rows need no pass: Sent by LogisX");
eq(off({ claim: HELD }), { status: ATTENTION, code: "TOTAL_MISMATCH" }, "§6 ...Needs attention");
eq(off({ claim: claim({ state: "queued" }) }), { status: WAITING }, "§6 ...Waiting");
eq(off({ factored: true }), { status: FACTORED }, "§6 ...Factored");
eq(read({ passOn: undefined, saved: clean }), { status: UNKNOWN, code: "NOT_SEARCHED" }, "§6 only exactly true counts as on");

// ===================================================================== §7
section("§7  an answer holds codes, numbers and a day, and the CSV's three cells");
const FIELDS = new Set(["status", "code", "invoiceId", "date", "found", "whose", "changed", "searchedAt", "sentUnchecked", "mentioned"]);
const everyAnswer = [
	read({ claim: SENT_CLAIM }), read({ claim: JOB_DRAFT, saved: inSent }), read({ rows: [row()] }), read({ claim: HELD, saved: mentioned }), read({ saved: clean }),
	read({ rows: [row({ recipient: "billing@example-broker.test", broker_name: "Made-up Broker" })], saved: { ...inSent, subject: "Example Broker Order #900000001", to: "billing@example-broker.test" } }),
];
for (const a of everyAnswer) ok(Object.keys(a).every((k) => FIELDS.has(k)), `§7 only the known fields: ${Object.keys(a).join(",")}`);
ok(!JSON.stringify(everyAnswer).includes("example-broker") && !JSON.stringify(everyAnswer).includes("Made-up Broker") && !JSON.stringify(everyAnswer).includes("Order #"), "§7 no address, name or subject passes through, even if handed in");
eq(exportCells(read({ claim: SENT_CLAIM })), ["Sent by LogisX", INV, "2026-11-02"], "§7 the CSV's cells: status, number, date");
eq(exportCells(read({ saved: inSent })), ["Invoiced by hand", "", "2026-11-02"], "§7 ...a number only if a row has one");
eq(exportCells(read({ rows: [row()] })), ["Invoiced by hand (Sent Mail not checked yet)", INV, ""], "§7 a person's draft row the mailbox hasn't been checked for says so in the file: a draft made isn't a draft sent");
eq(exportCells(read({ rows: [row()], saved: failed })), ["Invoiced by hand (Sent Mail not checked yet)", INV, ""], "§7 ...the search failed: the same");
eq(exportCells(read({ rows: [row()], saved: clean, passOn: false })), ["Invoiced by hand (Sent Mail not checked yet)", INV, ""], "§7 ...the pass off: the same");
eq(exportCells(read({ rows: [row()], saved: inSent })), ["Invoiced by hand", INV, "2026-11-02"], "§7 ...found in Sent Mail: plain, with its date");
eq(exportCells(read({ rows: [row()], saved: filled })), ["Invoiced by hand", INV, ""], "§7 ...on the Payments Table: plain");
eq(exportCells(read({ claim: JOB_DRAFT })), ["Draft in Gmail (Sent Mail not checked yet)", INV, ""], "§7 FAILS ON THE OLD CODE: the job's draft with no search behind it says so in the file too");
eq(exportCells(read({ claim: JOB_DRAFT, saved: inDrafts })), ["Draft in Gmail", INV, ""], "§7 ...found in Drafts: plain");
eq(exportCells(read({ saved: null })), ["Couldn't check", "", ""], "§7 ...and blanks");
eq(exportCells(null), ["Couldn't check", "", ""], "§7 no answer at all reads Couldn't check, never blank");

finish();
