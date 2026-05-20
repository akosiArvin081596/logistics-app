# Monthly Reports — Generating and Reading

Beyond the live dashboard, you can generate downloadable PDF reports for any date range. This chapter is how.

## Generating a report

From the hero header at the top of your dashboard:

1. **Pick a date range.** The picker accepts single months, custom ranges, year-to-date, all-time.
2. **Click Download Report.**
3. **Wait a few seconds** for the PDF to generate.
4. **The PDF downloads** automatically (or appears in your browser's downloads).

## What's in the report

The PDF includes:

- **Cover page** — your name, the period covered, the date generated.
- **Summary** — total revenue, total expenses, total driver pay, net profit, your earnings.
- **Monthly breakdown** — if the range spans multiple months, each month is shown separately.
- **Fleet breakdown** — per-truck performance for the period.
- **Per-load detail** — every load that contributed to revenue, with Load ID, pickup/delivery cities, dates, rate.
- **Expense detail** — every approved expense in the period.

The report is comprehensive enough to be the source-of-truth document for the period.

## What to use it for

A few practical uses:

**Tax preparation.** Hand to your CPA. They can extract revenue and expense numbers for your Schedule C or business tax return.

**Quarterly reviews.** A quarterly report gives a fuller view than monthly snapshots.

**Annual investor letter** to your own partners or stakeholders (if you have any).

**Year-over-year comparison.** Generate the same range from the prior year, compare.

**Reconciliation with bank deposits.** Your monthly distribution should match the "Your Earnings" line in the report (within timing differences for when payment processed).

## Report format

The PDF uses the same branding as your dashboard. Sections are clearly labeled. Tables are readable. Total numbers are prominent.

If the period is more than one month, monthly subtotals appear before the grand total. Useful for spotting trends within the range.

## What's not in the report

Some things deliberately not included:

- **Driver personal info beyond name** — privacy.
- **Broker names per load** (typically) — internal use.
- **Internal LogisX accounting** — your slice only, not the company's.
- **Future projections** — historical only.

If you need any of those, message operations.

## When the report doesn't match the dashboard

Both pull from the same underlying data. If they show different numbers, possibilities:

- **Different date ranges.** The dashboard view is one range; the report is another. Verify both ranges match.
- **Inclusion of pending expenses.** The dashboard updates as expenses are approved; the report locks the numbers as of the generation time. If you approve an expense after generating the report, the dashboard updates but the report stays as-is.
- **Cache.** Rare, but possible. Refresh and re-generate.

If they truly disagree, message operations.

## Frequency

Some patterns for when to generate:

**Monthly.** Generate a report for the prior month in the first week of the new month. Save it.

**Quarterly.** Generate a quarter report (Jan-Mar, Apr-Jun, etc.) for quarterly tax payments and reviews.

**Annual.** Generate a full-year report in early January for tax preparation.

**Ad-hoc.** Any time something looks unusual on the dashboard and you want to verify.

## Storing reports

The reports stay accessible in your Document Portal — you can re-download any historical report you've generated. But also save them locally:

- **Local folder.** A folder per year with monthly PDFs.
- **Cloud backup.** Google Drive, iCloud, Dropbox — wherever you keep important business records.
- **Off-site.** If you're security-conscious, a physical backup or a separate cloud account.

Don't rely solely on the platform — keep your own copies.

## Sharing reports

The reports contain financial details about your trucks. Share carefully:

- **Tax preparer** — yes.
- **Personal partners or co-investors** — typically yes (depends on your arrangement).
- **Strangers or potential investors** — generally no without redacting personal details.
- **Public** — never (financial privacy).

You decide who sees them. LogisX doesn't track who you share with.

## Customizing reports

The standard report format is fixed. If you need a custom format (different sections, additional metrics), message operations. We can typically generate one-off reports manually for specific needs.

## Comparing reports across periods

A few comparison patterns:

**Last month vs. this month:** generate both, lay side by side, eyeball differences.

**Year-over-year:** generate same-month prior-year, compare to current.

**Trend across a year:** generate Jan-Dec of one year, look at the monthly subtotals for the trend.

The dashboard itself shows some of this (cash flow chart, monthly earnings selector), but PDFs let you compare offline at your own pace.

## Report integrity

The reports are generated server-side from the same data the dashboard uses. They're not edited or filtered beyond what you specify (date range).

If you doubt a number in a report, you can:

1. **Cross-check the dashboard** for the same period.
2. **Spot-check per-load detail** against the loads list in your Fleet view.
3. **Compare to your bank deposit** for the corresponding distribution period.
4. **Message operations** to walk through the calculation.

The math is transparent and the data is real.

## When to ignore the report

A report is a snapshot in time. If you generated a report on April 5 covering March, then on April 10 an expense for March gets approved, the report won't reflect the new expense — but the dashboard will.

Don't treat a monthly report as immutable. Regenerate after any significant retroactive changes.

## Pro tips

- **Name files consistently.** "LogisX_2026-04.pdf" beats "report.pdf" when you have a dozen of them.
- **Generate at month-end-plus-a-week.** Gives time for end-of-month expenses to be approved.
- **Compare your bank deposit to the report's Your Earnings line.** They should match (within timing). Discrepancies are worth investigating.
- **Don't lose them.** A year of monthly reports plus an annual report is a substantial paper trail. Worth backing up.
