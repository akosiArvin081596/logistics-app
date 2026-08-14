# Investor portal — every word an investor can read

**For sign-off.** Reply against any row with **keep / reword / cut**. Nothing here changes until you say so.

**Why this exists.** Your ask, 2026-08-14: *"please let me know what you are putting or add in the notes section before you put it in front of the investor because I'm getting blindsided and asked about the logic behind these statements and I can't explain."* This is the whole inventory, so nothing reaches an investor that you have not read first.

## How to read it

Order is top-to-bottom as the investor scrolls `/investor`. For each string: the **exact** wording, where it sits, and when it appears (a lot of this copy only shows in a specific state — a loss month, a truck with no telemetry, a clicked tooltip).

| Flag | Meaning |
|---|---|
| 🔴 | **Asserts a mechanism.** Explains how a number was derived. If an investor pushes back, someone has to defend this sentence. These are the ones that blindside you. |
| 🟡 | **Forward-looking.** A projection or estimate. Carries risk if read as a promise. |
| ⚪ | Plain label or instruction. Low risk. |

**Not listed:** button labels, column headers, error toasts, and screen-reader-only `aria-label`s. Say the word and I'll add them.

---

## 1. Page header

| Flag | Exact text | Where / when |
|---|---|---|
| ⚪ | `Email LogisX Operations (info@logisx.com) about loads, dispatch, or anything operational` | Hover on "Contact Operations" |
| ⚪ | `Email LogisX Tech Support (dev@logisx.com) for portal or login issues` | Hover on "Contact Tech Support" |
| ⚪ | `Download a PDF report of your financials for the selected date range` | Hover on "Download Report" |
| ⚪ | `Click, or drop an image here, to change your profile picture` | Hover on the avatar (desktop) |

---

## 2. Earnings Summary — the monthly breakdown

The first money on the page, and the card you told me already carries the in-progress figure.

### On the card itself

| Flag | Exact text | Where / when |
|---|---|---|
| ⚪ | `Pick a month to view its earnings breakdown` | Under the month picker |
| 🔴 | `= SUM(Payment col, completed loads)` | Under Revenue |
| 🔴 | `= each driver's daily rate × calendar days worked this month` | Under Driver Pay, fixed-rate drivers |
| 🔴 | `= each driver's percentage × (revenue − deductible trip expenses)` | Under Driver Pay, percentage drivers |
| 🔴 | `= per-driver pay structure (see detail)` | Under Driver Pay, mixed rates |
| 🔴 | `= insurance + ELD + truck payment + IRP/12 + HVUT/12` | Under Fixed Costs |
| 🔴 | `= fuel + tolls + repairs (from expenses table)` | Under Trip Expenses |
| 🔴 | `= revenue - all costs` | Under Net Profit |
| 🔴 | `= netProfit × 50%` | Under Your Share — **the 50% is read live from config, not hardcoded** |
| ⚪ | `CLICK TO SEE FULL BREAKDOWN` | On the card |
| 🔴 | `* <Month> — Month in progress` | Only on the current month |
| 🔴 | `not charged — truck inactive this month` | Fixed Costs row, zero-activity month |
| 🔴 | `Truck was inactive this month — fixed costs deferred.` | Same case, expanded |

> ⚠️ The seven `=` formula lines are the highest-risk copy on the page. They are literal formulas next to real money — an investor who disagrees with a number will quote these back. They are accurate today.

### Inside the explainer dialogs (only when clicked)

| Flag | Exact text | Where |
|---|---|---|
| 🔴 | `Each time one of your trucks delivers a load, the shipper/broker pays a rate for that trip. This figure is the sum of all those payments for the selected month.` | Revenue |
| 🔴 | `Total compensation paid to your driver(s) — fixed-rate drivers earn per active day, percentage drivers earn a share of revenue after deductible trip expenses.` | Driver Pay |
| 🔴 | `Per calendar day worked (ELD-matched), not per load` | Driver Pay subtitle |
| 🔴 | `Monthly insurance, ELD tracking, registration (IRP), and road tax (HVUT).` | Fixed Costs |
| 🔴 | `Commercial liability insurance required to operate.` | Fixed Costs → insurance |
| 🔴 | `Monthly truck loan / lease payment.` | Fixed Costs → truck payment |
| 🔴 | `Once your truck is dispatched even one load in a month, the full monthly fixed costs apply normally.` | Fixed Costs, inactive-month note |
| 🔴 | `These are variable costs that only occur when your truck is on the road. Unlike fixed costs, trip expenses change from month to month based on how many loads were hauled and the routes taken.` | Trip Expenses |
| ⚪ | `No trip expenses were logged for this month.` | Trip Expenses, empty |
| 🔴 | `A negative net profit means operating costs exceeded revenue this month. This can happen during the first month, slow freight periods, or when major maintenance occurs.` | Net Profit, loss month |
| 🔴 | `This is the total revenue your fleet has generated since your first load. It represents every dollar earned from completed deliveries across all months.` | All-time Revenue |
| 🔴 | `This is the total cost of operating your fleet since day one. Expenses fall into three categories:` | All-time Expenses |
| 🔴 | `This is the total profit your fleet has generated after all operating costs. It represents the bottom line across your entire investment period.` | All-time Net Profit |

### Admin-only day adjustments (visible to an investor as a **reason string** in the audit log)

| Flag | Exact text | Where |
|---|---|---|
| ⚪ | `Credit a day the ELD missed (truck offline, lost feed)` | Admin tooltip |
| ⚪ | `Exclude this day from the driver's pay count` | Admin tooltip |
| ⚪ | `Reason (optional, shown in the audit log — e.g. 'Truck ELD offline')` | Admin input placeholder |

---

## 3. Cash Flow & Projections

| Flag | Exact text | Where / when |
|---|---|---|
| 🔴 | `= totalRevenue - totalExpenses` | Net Cash Flow |
| 🔴 | `= sum(monthly investor earnings)` | Your Earnings (to date) |
| 🔴 | `= purchasePrice / avg monthly take-home` | Break-Even |
| 🟡 | `= (est annual take-home / purchasePrice) × 100` | Your ROI |
| ⚪ | `Fleet-level revenue minus expenses (pre-split)` | Tooltip |
| ⚪ | `Cumulative take-home, summed across every month` | Tooltip |
| 🟡 | `We use the trailing 3-month average to smooth out one-off slow months. As that average changes, this estimate updates with it.` | Break-Even dialog |
| 🟡 | `ROI is a forward-looking estimate. Actual results depend on freight rates, fuel costs, and maintenance over the next 12 months.` | ROI dialog |
| 🔴 | `The Truck Payoff bar shows how much of your original investment you've recovered through your cumulative take-home so far. It is a real-money progress meter, not a projection.` | Payoff dialog |
| ⚪ | `When the bar reaches 100%, your fleet has paid for itself.` | Payoff bar |
| ⚪ | `Your fleet has paid for itself!` | Payoff bar at 100% |

---

## 4. Asset / truck metrics

| Flag | Exact text | Where |
|---|---|---|
| 🔴 | `The total miles your truck(s) have been driven since the first odometer reading was captured.` | Total Miles |
| 🔴 | `For each truck, take the highest odometer reading seen and subtract the earliest one. Sum across all your trucks.` | Total Miles |
| 🔴 | `Odometer readings come from Routemate ELD telemetry. If the truck wasn't on the road yet (no telemetry), this will read 0 until the first ping arrives.` | Total Miles |
| 🔴 | `For the truck to be profitable, Revenue / Mile must exceed Cost / Mile. The gap between the two is your gross margin per mile, before your profit split.` | Revenue/Cost per Mile |
| 🔴 | `Section 179 of the IRS tax code lets a business write off the full purchase price of qualifying equipment (including heavy trucks) in the year it's placed in service, rather than depreciating it over several years.` | Depreciation |
| 🔴 | `On paper, the truck has zero remaining book value. In reality, it still operates, generates revenue, and has resale value. The "100% depreciated" label is an IRS accounting concept, not a statement about the truck's condition.` | Depreciation |

> ⚠️ The two Section 179 paragraphs read as **tax advice** to an investor. Worth deciding whether the portal should say this at all, or point at their accountant.

---

## 5. Fleet Breakdown (per-truck table)

| Flag | Exact text | Where |
|---|---|---|
| 🔴 | `For each truck in the table, this is the number of completed loads that truck has hauled since being added to your fleet.` | Loads |
| 🔴 | `Only loads that **completed delivery**. Cancelled or soft-deleted loads are excluded by the standard load-exclusion filter, so the count matches every other live-loads number on this page.` | Loads → "What Counts" |
| 🔴 | `Total miles each truck has driven since odometer data started being captured. Sourced from Routemate ELD telemetry.` | Miles |
| 🔴 | `Miles can lag the actual odometer by a few hours while telemetry catches up. The most recent trip may not yet be reflected.` | Miles |
| 🔴 | `Each truck is measured on its own loads, so two trucks in one fleet won't show the same number. Where a load doesn't name a truck, its assigned driver's loads are used instead.` | Est. Your Revenue |
| 🟡 | `This is an estimate, not a guarantee. Freight market swings, maintenance, or a driver change can shift it quickly.` | Est. Your Revenue |
| 🟡 | `Est. Your Revenue = that truck's own trailing 3-month take-home × 12 … A "—" means the truck hasn't been in service a full 3 months yet, so there's nothing to average from — it isn't a $0 forecast, and it's left out of the Fleet Total. Based on N months of data — projections become more accurate over time.` | Footnote under the table |
| ⚪ | `Not yet in service a full 3 months` | Cell value |

---

## 6. Trend

| Flag | Exact text | Where |
|---|---|---|
| 🔴 | `Your strongest revenue month to date. This is the single month where your truck(s) earned the most across all completed loads.` | Best Month |
| 🔴 | `This is the truck's gross revenue averaged across the last 30 days. It tells you how much money the truck is generating per calendar day, regardless of whether it's actively driving.` | Revenue/Day |
| 🔴 | `Sum of revenue from loads completed in the last 30 days, divided by 30.` | Revenue/Day |
| 🔴 | `Average gross revenue per month, across every month with data. This includes the current (in-progress) month, so the average will rise as the month finishes.` | Avg/Month |
| 🟡 | `A forward-looking estimate of what you would earn over the next 12 months if recent activity continues. Uses the trailing 3-month investor take-home as the basis.` | 12-mo projection |
| 🟡 | `This is a projection, not a guarantee. Freight market swings, maintenance, or a driver change can move this up or down quickly.` | 12-mo projection |

---

## 7. My Loads

| Flag | Exact text | Where |
|---|---|---|
| 🔴 | `"Your Share" is an estimate based on the configured investor split … earnings breakdown after driver pay and expenses are deducted.` | Section note |
| 🔴 | `"Your Share" is the estimated portion of the load's gross payment that you'll keep, based on your configured investor split.` | Column tooltip |
| ⚪ | `Loads in the "Assigned", "Dispatched", or "Heading to Shipper" stage. Once the driver arrives at the shipper, the load moves into the Active bucket.` | Pending |
| ⚪ | `"At Shipper", "Loading", "In Transit", "At Receiver", and "Unloading" all count as active. Once the load is marked Delivered or POD-Received, it leaves this bucket.` | Active |

---

## 8. My Trucks

| Flag | Exact text | Where |
|---|---|---|
| 🔴 | `7-day average miles per gallon, derived from ELD telemetry. Click for full explanation.` | MPG |
| 🔴 | `Trailing 7-day fuel efficiency, derived from ELD telemetry` | MPG subtitle |
| 🔴 | `Use this as a trend indicator: a sudden drop in MPG can flag a maintenance issue (e.g., a clogged air filter or dragging brake) before it becomes a fault code.` | MPG dialog |
| 🔴 | `The count of open Diagnostic Trouble Codes (DTCs) reported by each truck's ELD. These are fault codes the engine ECM has logged but a fleet admin has not yet acknowledged.` | Faults |
| 🔴 | `A Super Admin opens the Fleet Health page, reviews the fault, takes whatever action is needed (often: replace a part, schedule maintenance), then marks the code acknowledged. Acknowledged faults stop counting here.` | Faults dialog |
| 🔴 | `The Job Tracking sheet, filtered to rows whose assigned driver matches one of your truck's assignment history. Excludes loads soft-deleted or with a Cancelled status (per the standard load-exclusion filter).` | Loads dialog |

> ⚠️ That last one names internal machinery ("the Job Tracking sheet", "soft-deleted", "load-exclusion filter"). It tells an investor how the sausage is made. Strong candidate for a reword.

---

## 9. Payment Summary & Load Reports — **as of this change**

| Flag | Exact text | Where / when |
|---|---|---|
| ⚪ | `What you earned, what was adjusted and what was paid — for the period you pick.` | Section subtitle |
| ⚪ | `Net investor share is reconciled monthly — switch to Monthly to see your share.` | Weekly tab only |
| 🔴 | `Awaiting payment — due <date>.` | Closed month, unpaid |
| 🔴 | `Paid on <date>.` | Closed month, paid |
| 🔴 | `Payment in progress — due <date>.` | Status = processing |
| 🔴 | `In final settlement — the books close <date>, so this figure can still move.` | Inside the 7-day window |
| 🔴 | `Nothing due — this month's shortfall carried into a later payout.` | $0 closed month with a loss |
| ⚪ | `Nothing due for this month.` | $0 closed month, no loss |
| ⚪ | `No settlement record for this month.` | Month with no ledger row |
| 🔴 | `Your payout is the amount this month was settled at. The earnings line reflects current records, which have changed since it closed.` | Settled month whose records moved |
| 🔴 | `month's performance — not a payout` | Under "Your Net Result" |
| ⚪ | `delivered loads only` | Under Gross Revenue |

**Row labels inside the card** (`lib/payoutPeriod.js`): `This month's earnings` · `Applied to an earlier month's loss` · `Loss carried to later months` · `Records changed after this month closed` 🔴 · `Amount this month settled at` 🔴 · `Manual adjustment` · `Still owed to you` / `Paid out to you` / `Payment processing`.

### ✅ Removed in this change

| Exact text | Was |
|---|---|
| `Projected if the month closed today` | Card heading, current month |
| `Earned so far this month` | Term row |
| `Shortfall that would carry forward` | Term row |
| `Projected payout` | Term row |
| `In progress — not payable until the month closes, with receipts accepted through <date>.` | Status line |
| `The month is running at a loss — a shortfall carries into a later payout, it is not an amount you owe.` | Loss prose |
| `All months — Earned … · Adjustments … · Paid out … · Still owed …` | Lifetime footer — **the $9,707** |
| `Across every settled month. Pick a month above to see it on its own.` | Lifetime view status line |
| `<Month> accruing: $X — not payable until the month closes` | Lifetime view note |
| `<Month> so far: -$X — the month is running at a loss, not an amount you owe` | Lifetime view note |

---

## 10. Expenses table

| Flag | Exact text | Where |
|---|---|---|
| 🔴 | `Raw expense entries against your trucks. The Cash Flow total above reflects bottom-line P&L (completed-load expenses + maintenance + compliance) and may differ.` | Footer total |
| ⚪ | `No expenses found for the selected filters.` | Empty |

> ⚠️ This one **admits two totals disagree** and asks the investor to accept it. Same family as the $9,707 problem. Worth a decision.

---

## 11. Payouts

| Flag | Exact text | Where / when |
|---|---|---|
| 🔴 | `Projected payout if the month closed today` | Current-month card — **still live, you chose to keep it** |
| 🔴 | `Accruing this month — not yet payable until the period closes, with receipts accepted through <date>.` | Current-month card |
| 🔴 | `$X short so far — the rest of the month's earnings go against that first. Anything still short when the month closes carries into a later payout.` | Current month running at a loss |
| 🔴 | `Includes manual adjustments of ±$X` | Under the totals grid |
| 🔴 | `Your expenses are already subtracted here before the split.` | Totals note |
| 🔴 | `Your payout is the amount this month was settled at. The figures above reflect current records, which have changed since it closed.` | Drift, expanded row |
| ⚪ | `No change history — this month closed before change tracking started.` | History, pre-2026-08-04 months |
| 🔴 | `Completed loads that make up this month's revenue` | Drill-down |
| 🔴 | `Active days × daily rate — percentage drivers earn a share of revenue` | Drill-down |
| 🔴 | `Fuel, tolls, repairs and other on-the-road costs` | Drill-down |
| ⚪ | `Scroll to zoom, drag to pan. Download a copy with the button below.` | Statement viewer |

---

## 12. The statement PDF (`lib/payout-statement.js`)

This one **leaves the app** — it is a document the investor keeps.

| Flag | Exact text |
|---|---|
| 🔴 | `A shortfall from an earlier month absorbed by this one.` |
| 🔴 | `This month ran at a loss, so nothing is payable. The shortfall is carried against later months rather than billed back to you.` |
| 🔴 | `This period predates the current earnings window, so its itemized composition is no longer available to re-derive. The amount shown is the settled figure recorded on the payout ledger.` |
| 🔴 | `Your trip expenses are deducted before the split, so the share above is already net of them.` |
| ⚪ | `Every figure in the summary, itemized. Each section totals the rows listed below it.` |
| ⚪ | `This statement reflects the settled payout recorded on the LogisX investor ledger for the period shown.` |
| ⚪ | Heading is `Final Amount` (finalized, unpaid), `Amount Paid` (paid), or `Net Settled` (adjusted after payment) |

---

## 13. Maintenance notice (only when switched on — currently **on** in production)

All three strings are set in the server environment, so you can retune them without a redeploy.

| Flag | Exact text | Where |
|---|---|---|
| ⚪ | `SYSTEM UPDATE IN PROGRESS` | Red banner heading (`MAINTENANCE_NOTICE_TITLE`) |
| ⚪ | `Application is currently under maintenance` | Login popup heading (`MAINTENANCE_NOTICE_MODAL_TITLE`) |
| ⚪ | `The final settlements are still being calculated.` | Disclaimer beside the money (`MAINTENANCE_NOTICE_DISCLAIMER`) |

---

## The three I'd raise first

1. **§4 Section 179** — two paragraphs of tax explanation. Does the portal want to be saying this?
2. **§5 and §8, "the Job Tracking sheet … soft-deleted … load-exclusion filter"** — internal vocabulary in front of an investor, in two places.
3. **§10 "…and may differ"** — the portal telling an investor two of its own totals disagree.
