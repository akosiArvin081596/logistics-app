"use strict";
// The investor-facing wording for a month paid as a FIXED MONTHLY LEASE: the
// agreed sentences L1–L10, verbatim, in one place.
//
// ⚠️ Every sentence reaches an investor, on the portal, in the statement PDF or
// in the downloadable report, and each is listed in docs/investor-portal-copy.md
// §17 for the client's sign-off: change one here and change it there too.
//
// Who prints them:
//   lib/payout-statement.js         EXPLAIN, REASON and LOSS_MONTH (through its
//                                   own LEASE_TEXT, beside the statement's labels)
//   server.js                       PER_LOAD_SHARE, on the load report
//   lib/investor-report-options.js  keeps its own copies of the REPORT_* texts,
//                                   because it loads nothing;
//                                   scripts/test-investor-report-options.js pins
//                                   them equal to these
//   client/src/lib/leasePayoutText.js  the portal's and the admin screens' copy
//                                   (the client cannot load this file);
//                                   scripts/test-lease-payout-text.mjs
//                                   pins it equal to this
//
// {amount} and {paid} are whole dollars ("$2,000"), {covered} and {days} day
// counts, {month} a month ("June 2026") and {span} a span of months ("June 2026"
// or "June 2026 – July 2026").
//
// Pure: no I/O and no requires.

const LEASE_TEXT = Object.freeze({
	// L1: the basis, as a label.
	LABEL: "Fixed monthly lease",
	// L2: the headline sub-line.
	SUB_LINE: "Fixed monthly lease payment of {amount}",
	// L3: what a lease pays, and that the truck's revenue and costs do not move it.
	EXPLAIN: "Under your agreement you are paid a fixed monthly lease of {amount}, not a share of net profit. Your truck's revenue and costs are shown for your information and do not change this payment.",
	// L4–L6: why a month pays other than the full lease, by payoutBasis.reason.
	REASON: Object.freeze({
		prorated: "The lease covered {covered} of {days} days this month, so this month pays {paid}.",
		downtime: "No lease payment is owed for this month: the truck had no activity, and your agreement (section 3.1) owes nothing during downtime.",
		not_in_service: "No lease payment is owed for this month: no truck was in service under your lease.",
	}),
	// L7: where a split month would explain its loss carry-forward.
	LOSS_MONTH: "A month your truck runs at a loss still pays the full lease. Losses are not carried forward against your lease.",
	// L8, L8b, L8c: the downloadable report's note under the Income Statement,
	// for a range that is all one lease, a lease from a month on, and a stretch
	// of lease months that a split month follows.
	REPORT_NOTE: "Your payout is a fixed monthly lease of {amount}, not a share of net profit.",
	REPORT_NOTE_FROM: "From {month}, your payout is a fixed monthly lease of {amount}, not a share of net profit.",
	REPORT_NOTE_DURING: "For {span}, your payout is a fixed monthly lease of {amount}, not a share of net profit.",
	// L9: the report's payout label when every month is a lease.
	REPORT_LABEL: "Investor Payout (fixed monthly lease)",
	// L10: in place of a per-load share.
	PER_LOAD_SHARE: "Paid as a fixed monthly lease, so there is no per-load share.",
});

module.exports = { LEASE_TEXT };
