# Financials

The Admin → Financials view is the company-wide P&L. This chapter is how to read it, what each number means, and how to drill into specifics.

## Opening Financials

Sidebar → **Admin** → **Financials**. (Or navigate to `/admin/financials`.) Super Admin only.

![Financials](screenshots/admin-financials.png)

You'll see the company's financial dashboard with:

- **Revenue** by month and year-to-date.
- **Expenses** broken down by category.
- **Driver pay** total.
- **Net profit** by month and YTD.
- **Per-truck profitability.**

## Key numbers

### Revenue

**Total revenue** = sum of all completed load payments from the Job Tracking sheet, excluding cancelled and soft-deleted loads.

A load counts in the month it was **assigned**, not the month it was delivered. This is an intentional decision (confirmed with the CEO) so that revenue lines up with how the dispatcher dashboard reports it.

Excluded:
- **Cancelled loads** (status matches `^(cancel|canceled|cancelled)$`).
- **Soft-deleted loads** (rows in the `deleted_loads` table).

These exclusions are centralized in the `excludeDroppedLoads` helper — every revenue aggregator (dashboard, investor view, financials) uses the same filter.

### Expenses

Breakdown by category:

- **Fuel.**
- **Repairs.**
- **Tolls.**
- **Lumpers.**
- **Scale fees.**
- **Other** (catch-all from the expenses table).

Plus structural costs:
- **Driver pay** (calculated, not from expenses table).
- **Insurance** (per-truck monthly amount × months of operation).
- **ELD service** (per-truck monthly amount × months).
- **IRP** (per-truck annual / 12).
- **HVUT** (per-truck annual / 12).
- **Maintenance fund** contributions (per-truck monthly).

The expense list only counts **approved** expenses — pending and rejected are excluded.

### Driver pay

Calculated per the formula in the [Invoice Approvals](#) chapter:

- **Daily rate drivers**: $250 × unique active days.
- **Owner-operator**: percentage of load revenue.

The total here is across all drivers for the period.

### Net profit

Revenue minus all expenses minus all driver pay. This is the company's bottom line for the period.

## Per-truck profitability

A separate section shows each truck individually:

| Truck | Revenue | Driver Pay | Fixed Costs | Trip Expenses | Net Profit |
|---|---|---|---|---|---|
| TRK-101 | $14,200 | $3,750 | $1,915 | $1,200 | $7,335 |
| TRK-102 | $9,800 | $2,500 | $1,915 | $800 | $4,585 |
| ... | | | | | |

Use this to identify:

- **Strong performers** — trucks with high net profit.
- **Underperformers** — trucks with low or negative net.
- **Expense outliers** — trucks with unusually high fuel or repair costs.

A truck consistently underperforming is worth investigating: bad driver-truck match? Mechanical issues? Wrong rates?

## Reading trends

The financials view shows trends over time. Look for:

- **Revenue growing or flat?** A growing fleet should show growing revenue.
- **Expenses growing faster than revenue?** Margin compression.
- **Driver pay percentage** — is it consistent with your pay structure? Drifting can indicate a structural issue.
- **Fixed costs trending up?** Insurance, ELD costs creeping up matter over time.
- **Per-truck profitability spread** — if some trucks are at $8K/month and others at $1K, why?

## When numbers look wrong

Three common causes:

**Cancelled loads not excluded.**
Verify a recent cancelled load shows `Cancelled` status exactly (not `Cancellation Pending` or some other variant). The exclusion regex matches exactly.

**Soft-deleted loads not excluded.**
If you remember deleting a load, verify it's in the `deleted_loads` table. Query via Database Admin tools.

**Driver pay miscalculated.**
Check the driver's pay type and the load dates. If a load's pickup or dropoff dates are wrong, the active-day count is wrong. The investor dashboard chapter goes deeper on this.

**Owner ID mismatched.**
A load attributed to the wrong owner shows up in the wrong investor's earnings (or none). Fix the Owner ID on the load.

## Reconciling with bank statements

The Financials view shows the operational P&L, not the cash flow:

- **Revenue** here is what was earned (load delivered). The broker might pay 30-60 days later.
- **Expenses** here are submitted/approved expenses. The actual cash might have come out of a fuel card or bank account at a different time.
- **Driver pay** here is the calculated owed amount. Payment happens later via your payment process.

Don't expect this view to match a bank statement exactly. For cash reconciliation, you need accounting software (QuickBooks, etc.) that imports bank transactions.

What this view gives you is **operational visibility** — what's the business earning, what's it spending, on what timeline.

## Drilling into specific items

The dashboard isn't a drill-down tool — you can't click a number and see the underlying loads in detail. To drill in:

- **Open Data Manager** → Job Tracking → filter by date and status.
- **Open the relevant driver's record** → see their loads list.
- **Open the truck's record** → see loads attributed to it.

Most "why is this number what it is" questions require pulling the underlying data.

## Exporting

For deeper analysis (e.g., spreadsheet pivoting), you can:

- **Download the Job Tracking sheet** as CSV directly from Google Sheets.
- **Download the expenses table** via Database Admin → query expenses → export.
- **Generate an investor report** for a specific investor (sidebar → Investor Applications → ...; this gives you their slice but not the whole company).

There's no one-click "export financials" feature. If you need that, talk to leadership about adding one.

## Comparing periods

The view shows current month and YTD by default. To compare to prior periods:

- **Mental comparison** based on memory of last month.
- **Database query** to pull historical data.
- **Spreadsheet** with manual entry from past months.

A historical comparison chart isn't built into the dashboard. This is a limitation worth flagging if you regularly need it.

## Investor reports

Each investor's earnings are a slice of the financials. The numbers on an investor's dashboard equal:

- **Their** loads' revenue (filtered to trucks they own).
- **Minus their** drivers' pay (proportionate to their loads).
- **Minus their** fixed costs (their trucks' insurance, ELD, IRP, HVUT, maintenance).
- **Minus their** trip expenses (fuel etc. on their loads).
- **Divided by 2** (their 50% share).

Run their dashboard and the math should reconcile to the company financials if you sum across all investors. Plus or minus the company-owned trucks (not investor-owned).

## When financials shock you

If a number is surprisingly high or low:

1. **Don't panic.** The system aggregates a lot of data. One bad input creates apparent surprises.
2. **Drill into the underlying data.** Find the specific loads or expenses driving the surprise.
3. **Verify the data is right** — are dates correct, are amounts right, are exclusions applied?
4. **If the data is right**, the surprise is real — investigate the business reason.

Half of "weird financial numbers" turn out to be data entry issues. The other half are real and worth understanding.

## Pro tips

- **Glance at financials weekly.** Catching trends early is way easier than catching them quarterly.
- **Coordinate with bookkeeping.** They have visibility into actual cash; you have operational visibility. Together you see the whole picture.
- **Per-truck profitability over time is your best metric for fleet decisions.** Use it to argue for or against truck acquisitions.
- **Don't share specific numbers casually.** Financials are sensitive. Even within the company, not everyone needs to know exact figures.
