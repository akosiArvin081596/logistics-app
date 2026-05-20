# Invoice Approvals

Every week, LogisX auto-generates invoices for each driver based on the work they did. You review and approve before payment. This chapter is how to read an invoice and what to check.

## Opening Invoices

Sidebar → **Invoices**. You'll see a list of recent invoices with:

- Driver.
- Week covered.
- Total.
- Status — Pending, Submitted, Approved, Paid.
- Loads included (count).

![Invoices](screenshots/admin-invoices.png)

Filter by status to focus on the ones needing your action.

## Invoice lifecycle

Statuses progress:

```
Pending → Submitted → Approved → Paid
```

- **Pending** — auto-generated. Driver (or dispatch) hasn't submitted for approval yet.
- **Submitted** — driver or dispatcher submitted for approval. Awaiting your review.
- **Approved** — you approved. Payment can be processed.
- **Paid** — payment was disbursed (typically by your bookkeeping team outside the app).

Your action is moving Submitted → Approved.

## Reading an invoice

Click into an invoice. You'll see:

- **Header** — driver name, week start and end dates.
- **Pay type** — Daily Rate or Owner-Operator percentage.
- **Loads list** — each load worked during the period, with dates and Load IDs.
- **Active days** (Daily Rate) or **revenue & percentage** (Owner-Op) — the math for the base pay.
- **Base pay total.**
- **Adjustments** — bonuses, deductions, layover pay, detention pay.
- **Total.**

For Daily Rate drivers, the system shows each active day:

```
Mon 04/14  — Load LD-3492 (pickup→In Transit)   1 day
Tue 04/15  — Load LD-3492 (continuing)           1 day
Wed 04/16  — Load LD-3492 (delivered)            1 day
Thu 04/17  — Load LD-3498                        1 day
Fri 04/18  — Loads LD-3501, LD-3502, LD-3503     1 day (multiple loads same day)
─────────────────────────────────────────────────────
Total active days: 5 × $250 = $1,250
```

For Owner-Op, the system shows each load's revenue and the percentage:

```
LD-3492 (Atlanta → Chicago, 04/14-04/16)   Rev $2,400 × 70% = $1,680
LD-3498 (Chicago → Dallas, 04/17)          Rev $1,800 × 70% = $1,260
─────────────────────────────────────────────────────────────────
Total base pay: $2,940
```

## What to check before approving

A few things worth verifying:

**All loads delivered.** The invoice should include loads that completed during the period, not loads still in progress.

**Pay type matches contract.** Make sure the system is using the right pay structure for this driver. If their contractor agreement says daily rate but the invoice computed as owner-op, that's a problem.

**Dates make sense.** For daily rate, the active days should match the actual pickup-to-delivery span. A load that spans Monday-Wednesday should be 3 days, not 1.

**Revenue numbers right.** For owner-op, the rates should match the original rate confirmations.

**No duplicates.** Sometimes the same load appears twice (corrected entry, duplicate row). The system deduplicates by Load ID but verify.

**Cancelled loads excluded.** A load that was cancelled mid-trip shouldn't count toward pay. The system excludes via `excludeDroppedLoads` but spot-check if you've recently cancelled anything.

## Approving

Click **Approve**. The invoice status changes to Approved. Payment processing can proceed.

## Rejecting

Click **Reject**. The status reverts to Pending and the driver/dispatcher can correct and resubmit.

When you reject, **add a clear reason**. The driver will see it. Examples:

- "Active days count is wrong — load LD-3492 was 3 days, not 2."
- "Owner-op rate for LD-3498 should be $1,800, not $1,500. Verify against rate con."
- "Missing load LD-3501 from Friday."

Specific feedback gets fixed faster than vague feedback.

## Adjustments

You can add adjustments to an invoice manually. Common reasons:

- **Bonus** — recognition for exceptional service.
- **Layover pay** — driver stuck overnight at a dock.
- **Detention pay** — receiver kept driver over the standard window.
- **Deduction** — fine paid by company, equipment damage, etc.
- **Per diem** — if your company offers it.

For each adjustment, enter:

- **Amount** (positive for additions, negative for deductions).
- **Description** of what it's for.
- **Date** (the date the event occurred).

Adjustments appear on the invoice with the description. The driver sees them.

## Common issues

**"The active days count looks wrong."**
The system expands pickup-to-delivery dates into a list of unique calendar days, then deduplicates across all loads. If the count is wrong, check:

- **Were the load dates entered correctly?** A typo in pickup or dropoff date will throw off the math.
- **Was a load cancelled?** Cancelled loads don't count.
- **Did the driver have a pickup or delivery span midnight?** Cross-midnight is fine — each calendar day counts.

To fix: edit the load dates in Data Manager, then regenerate the invoice (or wait for the auto-recalc).

**"The owner-op rate is wrong."**
Look at the load's Payment field in Data Manager. That's the source of the rate. If it's wrong there, fix it. Then regenerate.

**"A load that should be on the invoice is missing."**
Three possibilities:

1. The load is still in progress (not delivered as of the invoice cutoff). It'll be on next week's invoice.
2. The load was attributed to a different driver. Fix the driver name on the load.
3. The load was cancelled or soft-deleted. Restore if needed.

**"A load that shouldn't be on the invoice is there."**
Inverse of above. The load was attributed to this driver in error, or wasn't actually theirs to begin with. Fix the attribution.

## When to send back vs. fix yourself

Sometimes you'll see an invoice error you can fix directly (edit the load dates in Data Manager and regenerate). Other times you want the dispatcher or driver to fix.

**Fix yourself** when:
- The error is a typo or formatting issue.
- The fix is straightforward.
- You need to move quickly (Friday afternoon, payroll Monday).

**Send back** when:
- The error reveals a process issue the team should learn from.
- The fix requires information you don't have (broker contact, rate confirmation, etc.).
- You want the driver or dispatcher to be aware of the issue.

## After approval — payment

The "Paid" status is set when payment is actually disbursed. In typical operation:

1. You approve invoices Monday or Tuesday for the prior week.
2. Bookkeeping processes the batch via your payment system (Bill.com, direct ACH, etc.).
3. Payments land in driver bank accounts by Friday.
4. Bookkeeping marks invoices as Paid.

The mechanics of payment vary by company. The LogisX app is the approval gate, not the disbursement system.

## Disputes

If a driver disputes an approved invoice (or asks for retroactive corrections to a paid one):

1. **Listen to their case.** Look at the specific loads they're disputing.
2. **Pull the data.** Look at the loads in Data Manager. Verify dates, rates, etc.
3. **Decide.** Either:
   - **They're right** — make a corrective adjustment on a future invoice. Don't try to retroactively un-pay; payment already happened.
   - **They're wrong** — explain why with reference to the contract and the data.
4. **Document.** Note the dispute and resolution in the driver's record.

Disputes are rare if invoice review is careful. Most disputes are honest disagreements, not bad faith.

## Pro tips

- **Don't approve in bulk without reading.** Each invoice is someone's pay. Take the 30 seconds to look.
- **Watch for outliers.** If a driver's typical invoice is $1,500 and this week's is $3,500, that's worth investigating. Could be a great week, could be an error.
- **Adjust early in the cycle.** Adjustments are easier to verify when the events are fresh. Don't sit on a layover pay request.
- **Communicate approvals.** If you make any unusual adjustment (significant bonus, large deduction), message the driver to explain before they see it.
