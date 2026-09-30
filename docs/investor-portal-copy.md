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

### NEW — the loss carry-forward rows (only on a month that carries one)

**Why these are here.** You screenshotted the statement PDF's "Earlier loss applied" line and said *"What is this earlier loss apply a shortfall from earlier month… I got to know these things cause I have to explain these things."* The reason it read as a surprise is that the Earnings screen **never mentioned it** — it stopped at `Your Share` — while the statement PDF subtracted it from the same month. Two surfaces, two different "your share" for one month. These rows close that gap.

This is not hypothetical: **August 2026 is genuinely −$995** for one investor, so September's statement will subtract it for real.

Nothing below renders on an ordinary month. A month with no carry looks exactly as it does today.

| Flag | Exact text | Where / when |
|---|---|---|
| 🔴 | `- Applied to an earlier month's loss` | Row under Your Share — a month **paying down** an earlier loss |
| 🔴 | `an earlier month's shortfall, covered by this month` | Caption under that row |
| 🟡 | `Shortfall that would carry forward` | Row under Your Share — the **current** month running at a loss |
| 🟡 | `carries into a later payout if the month closes short` | Caption under that row |
| 🔴 | `Loss carried to later months` | Same row once the month has **closed** — a fact, not a projection |
| 🔴 | `carried against later months, not billed to you` | Caption under that row |
| 🔴 | `Payable` | The total under the carry rows, on a closed month |
| 🟡 | `Projected payout` | The same total on the current month |
| 🔴 | `= your share − earlier loss applied` | Caption under the total — a month paying one down |
| 🔴 | `= your share + loss carried forward` | Caption under the total — a month deferring one |
| 🔴 | `= your share − earlier loss applied + loss carried forward` | Caption under the total — a month doing both |

> ⚠️ **One decision to make.** The same mechanism is now named **three different ways** across three surfaces, because they were written at different times:
>
> | Surface | How it names the deduction |
> |---|---|
> | Statement PDF (the document the investor keeps) | `− Earlier loss applied` |
> | Earnings screen + Payouts card | `Applied to an earlier month's loss` |
> | Payouts table, inline note | `…applied to an earlier loss` |
>
> They mean exactly the same thing, and all three are accurate. But you are the one who has to explain them, so **pick one wording and we will make all three match.** Same question for the other half: `Loss carried forward` (PDF) vs `Loss carried to later months` (screens).

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
| ⚪ | `Step 5: Apply the loss carry-forward` | **NEW** — step heading, only on a month with a carry |
| 🔴 | `A shortfall from an earlier month absorbed by this one.` | **NEW** — a month paying an earlier loss down. **Verbatim from the statement PDF** (§12) rather than a new paraphrase |
| 🔴 | `This month ran at a loss, so nothing is payable. The shortfall is carried against later months rather than billed back to you.` | **NEW** — a month running at a loss. Also verbatim from the PDF |

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
| 🔴 | `$X of earlier losses is still carried against future months` | Under the totals grid — the only line left there |
| 🔴 | `Your expenses are already subtracted here before the split.` | Totals note |
| 🔴 | `Your payout is the amount this month was settled at. The figures above reflect current records, which have changed since it closed.` | Drift, expanded row |
| ⚪ | `No change history — this month closed before change tracking started.` | History, pre-2026-08-04 months |
| 🔴 | `Completed loads that make up this month's revenue` | Drill-down |
| 🔴 | `Active days × daily rate — percentage drivers earn a share of revenue` | Drill-down |
| 🔴 | `Fuel, tolls, repairs and other on-the-road costs` | Drill-down |
| ⚪ | `Scroll to zoom, drag to pan. Download a copy with the button below.` | Statement viewer |

### ✅ Removed in this change

| Exact text | Was |
|---|---|
| `Includes manual adjustments of ±$X` | Under the totals grid — **the −$661** |

**Why.** Your ask: *"why is the negative 661 carrying over to the [rest] of months? That manual adjustment was only for that one month, that's it. It doesn't carry over or anything like that, and nor do we need to keep bringing it up displaying it somewhere else."* You were right, and the cause was structural: that figure summed **every** payout row with no period filter, while the totals strip it sat under has no month picker — so a correction belonging to one month (June 2026) was restated under the lifetime totals on every page load, reading as a recurring deduction.

**Nothing was deleted, only un-repeated.** The −$661 still appears on the four surfaces that say *which* month it belongs to: the `Adjustment` column on June's own row in Past Months, June's expanded waterfall (`Your Share + Adjustment = Payout`), the `Manual adjustment` row on the Load Reports card (§9), and June's statement PDF (§12). Same family as the `$9,707` lifetime footer removed in §9 — a per-month fact needs a per-month frame.

---

## 12. The statement PDF (`lib/payout-statement.js`)

This one **leaves the app** — it is a document the investor keeps.

| Flag | Exact text |
|---|---|
| 🔴 | `− Earlier loss applied` — **the row label you screenshotted.** It was never listed here; only its caption below was, which is why the line you asked about was not in the inventory |
| 🔴 | `A shortfall from an earlier month absorbed by this one.` — the caption under that label |
| 🔴 | `Loss carried forward` — the row label on a loss month |
| 🔴 | `This month ran at a loss, so nothing is payable. The shortfall is carried against later months rather than billed back to you.` — the caption under **that** label. **Now also shown on the Earnings screen** (§2, Step 5 of the explainer dialog), word for word, so the screen and the document you hand over say the same thing |
| 🔴 | `This period predates the current earnings window, so its itemized composition is no longer available to re-derive. The amount shown is the settled figure recorded on the payout ledger.` |
| 🔴 | `Your trip expenses are deducted before the split, so the share above is already net of them.` |
| ⚪ | `Every figure in the summary, itemized. Each section totals the rows listed below it.` |
| ⚪ | `This statement reflects the settled payout recorded on the LogisX investor ledger for the period shown.` |
| ⚪ | Heading is `Final Amount` (finalized, unpaid), `Amount Paid` (paid), or `Net Settled` (adjusted after payment) |
| 🔴 | `Figures as of <date>; the portal shows current records.` — **NEW, you approved this on 2026-08-17.** Small grey italic line under the settled figure, on **both** the Final and the Paid version. `<date>` is the same "Issued" date already printed in the header. **Why it was added:** statements are now rendered once and stored, so the PDF is a snapshot of the day it was built. Two parts of the page are re-derived live at that moment — the itemized appendix, and the page-1 composition on older months — so a statement built while everything agreed stays that way and will never later grow the `The figures above reflect current records, which have changed since it closed.` caveat (§11) the *screen* would show. The alternative was to re-render on every click, which is the ~4-second delay you asked us to remove. This line is how the document stays honest instead. **The settled amount itself is frozen either way and is not affected.** |

---

## 13. Maintenance notice (only when switched on — currently **on** in production)

All three strings are set in the server environment, so you can retune them without a redeploy.

| Flag | Exact text | Where |
|---|---|---|
| ⚪ | `SYSTEM UPDATE IN PROGRESS` | Red banner heading (`MAINTENANCE_NOTICE_TITLE`) |
| ⚪ | `Application is currently under maintenance` | Login popup heading (`MAINTENANCE_NOTICE_MODAL_TITLE`) |
| ⚪ | `The final settlements are still being calculated.` | Disclaimer beside the money (`MAINTENANCE_NOTICE_DISCLAIMER`) |

---

## 14. Investor application (`/invest`) — the email address check

**You approved this on 2026-09-23; it shipped in PR #365.** This is the public application form, not the portal, so the reader is a *prospective* investor who has not logged in yet. Step 1 now checks the email address where it is typed, using the same rule the server applies when the application is submitted (the server check came in PR #364). Before this, a mistyped address was only refused at the final submit, after every document had been signed. Continue stays grey until the address is valid, and the message appears under the Email field once the applicant moves on from it. Error messages are normally left out of this inventory (see **Not listed** above); these are here because you signed them off.

| Flag | Exact text | Where / when |
|---|---|---|
| ⚪ | `Nice work — that's Step 1 done. Click Continue at the bottom to move on to your fleet and documents. If the button is grey, you've missed a required field (legal name, address, phone, email, or EIN/SSN), or the email address isn't valid.` | Setup guide, "Ready to continue?" card (`STEP0_REVIEW` in `client/src/wizard/data/knowledge-base.json`). **Approved 2026-09-23 (PR #365)**: the new part is the closing `, or the email address isn't valid.` |
| ⚪ | `You're missing a required field, or the email address isn't valid. The required fields are: Legal Name, Principal Address, Phone, Email, and EIN/SSN. Fill all of them with a valid email address and the button turns blue.` | Setup guide FAQ, the answer to `Why is the Continue button grey?` (`continue_grey`, same file). **Approved 2026-09-23 (PR #365)**: adds `or the email address isn't valid` and `with a valid email address` |
| ⚪ | `Please provide a valid email address.` | Under the Email field on Step 1, once the applicant moves on with an address that isn't valid. **Approved 2026-09-23 (PR #365)** |
| ⚪ | `Please enter a single email address.` | Same place, when the field holds more than one address (a comma, a semicolon or a second `@`). **Approved 2026-09-23 (PR #365)** |
| ⚪ | `That email address is too long (254 characters at most).` | Same place, for an address over 254 characters. **PENDING the owner's sign-off** — not part of the 2026-09-23 approval. It shipped in the same change and an investor is very unlikely to see it, but it is investor-facing: keep / reword / cut? |

The same field errors also appear as the error pop-up if the application is submitted with a bad address, and the server answers with the same words (`POST /api/public/investor-apply`). The wording is written twice, once for the browser (`client/src/lib/emailAddress.js`) and once for the server (`lib/public-form-input.js`). `scripts/test-email-address-client.mjs` fails if the two ever differ, so any reword has to change both files.

---

## 15. Investor onboarding — payment terms (awaiting client sign-off)

**Every line in this section is AWAITING YOUR APPROVAL.** Nothing here has shipped; you review it on staging before it is merged.

**What it is.** An admin creates a personal invitation link on `/investors` with payment terms for one investor: a 50/50 profit split, or a fixed monthly lease payment, plus optional additional terms. The investor opens `/invest?invite=…`. The terms are shown to them **read-only** and printed in the Master Agreement and the Lease they sign. The plain `/invest` page, without an invitation link, is unchanged, and so is its contract. **Payouts are not changed:** they are still calculated from the Split % column, whatever the contract says.

Error messages are normally left out of this inventory (see **Not listed** above); the invitation ones are here because the applicant reads them instead of the whole form. `client/src/lib/investorInvite.js` holds them, and `scripts/test-investor-invite-client.mjs` fails if they differ from this section, so a reword changes both.

### 15.1 On the `/invest` page — only with an invitation link

| Flag | Exact text | Where / when | Status |
|---|---|---|---|
| ⚪ | `Loading your invitation...` | In place of the form while the link is checked, when the page first opens. | **Awaiting approval** |
| ⚪ | `Investor invitation` | Heading of the page shown **instead of the form** when the link can't be used. One of the six lines below sits under it. | **Awaiting approval** |
| ⚪ | `This invitation link isn't valid. Please ask LogisX for a new link.` | Under that heading: the link is mistyped or unknown, or LogisX has since issued a new link for the same invitation. | **Awaiting approval** |
| ⚪ | `This invitation has already been used to submit an application. If you just submitted, it was received.` | Same place: the link was already used to submit. The second sentence is for someone whose connection dropped just as they submitted. | **Awaiting approval** |
| ⚪ | `This invitation was withdrawn. Please contact LogisX.` | Same place: an admin withdrew (revoked) the invitation. | **Awaiting approval** |
| ⚪ | `This invitation has expired. Please ask LogisX for a new link.` | Same place: 30 days after the link was created or last reissued. | **Awaiting approval** |
| ⚪ | `We couldn't load your invitation just now. Please check your connection and try again.` | Same place: the check got no answer (offline, too many attempts, a server error). Nothing is wrong with the link, so it offers a retry instead of calling it invalid. **Added by the frontend; not in the original brief.** | **Awaiting approval** |
| ⚪ | `Try again` | Button, only under the line above. | **Awaiting approval** |
| ⚪ | `Your payment terms` | Card heading. The card sits on Step 2 just above **Onboarding Documents**, and again at the top of the signing panel for the **Master Agreement** and the **Lease** (never the W-9). Shown only when the invitation's terms differ from the standard contract. | **Awaiting approval** |
| ⚪ | `Payment type` · `Monthly amount` · `Additional terms` | The card's three labels. `Monthly amount` appears only for a fixed monthly lease payment. | **Awaiting approval** |
| ⚪ | The payment type, e.g. `Fixed monthly lease payment` / `50/50 profit split` | Card value beside `Payment type`. It is the server's label for the type; it should read exactly like the Amendment's `Payment type:` line in 15.3. Check the two match on staging. | **Awaiting approval** |
| ⚪ | The amount, e.g. `$2,000.00` | Card value beside `Monthly amount` (lease only), formatted by the server. | **Awaiting approval** |
| ⚪ | The additional terms, as LogisX typed them, or `None` | Card value beside `Additional terms`, line breaks kept. `None` is the same word the Amendment prints. | **Awaiting approval** |
| 🔴 | `These terms were set by LogisX for your agreement and appear in Amendment No. 1 of the documents you sign.` | Under the card, wherever the card appears. | **Awaiting approval** |
| ⚪ | `Payment Terms` | Section title in the **Review Your Application** window, with the same three rows as the card. | **Awaiting approval** |
| 🔴 | `LogisX updated the payment terms in your invitation. Please review and sign the agreements again.` | Blue notice at the top of Step 2, and at the top of the signing panel, when LogisX edits the terms after the investor opened the link (the page notices on the next document preview, or at submit). The new terms replace the old on screen; the Master Agreement and Lease signatures are cleared and must be given again; the W-9 keeps its signature. | **Awaiting approval** |

### 15.2 Fixes every applicant sees, with or without an invitation

| Flag | Exact text | Where / when | Status |
|---|---|---|---|
| ⚪ | `We couldn't load this document just now.` | In the document pane of the signing window, when the preview fails, for example while the server is busy with other previews. It used to stay on `Loading document...` with no way forward. When the server names the problem instead (say, a signature image it cannot accept), its own message shows here. **Also, since this change, in the document viewer opened from `Signed — View Document` in the Review Your Application window**, which used to do nothing at all when the preview failed: the click looked broken. That viewer now opens at once on the existing `Loading document...` line, then shows the document, or this line. | **Awaiting approval** |
| ⚪ | `Try again` | Button under that line. In the signing window it reloads the same document, and the signing panel beside it keeps the ticked box, the typed name and the drawn signature. In the review window's viewer it reloads the same signed document. | **Awaiting approval** |
| ⚪ | `Thank you, <legal name>. Your application and all documents have been submitted successfully.` | Unchanged wording. It now keeps the name when the page is refreshed after submitting; before, a refresh showed `Thank you, .` with no name. | **Awaiting approval** |
| ⚪ | `Thank you. Your application and all documents have been submitted successfully.` | **New variant**, shown only when the name is not known: someone who submitted before this change and then refreshes the page. | **Awaiting approval** |
| ⚪ | `Enter a 9-digit SSN or EIN.` | **New.** Under the EIN or SSN field on Step 1, once the applicant moves on from it with a number that is not nine digits (hyphens and spaces are fine), and Continue stays grey. The W-9 has nine boxes for it: ten digits used to stop the W-9 being produced, and fewer printed a short number. The server refuses the same number with the same words. | **Awaiting approval** |
| ⚪ | `Please enter this as it appears on your U.S. tax return, using Latin characters.` | **New.** Under Legal Name, DBA or Principal Address on Step 1, when Continue is clicked with text the W-9 cannot print (Japanese or Cyrillic, say; accented Latin such as `Café` is fine), until that field is changed. Also at the top of the signing panel when the W-9 is signed with such a name, which is then not taken. The W-9 used to fail silently for these applicants after they submitted. | **Awaiting approval** |
| ⚪ | `This is too long. Please keep it to 200 characters or fewer.` / `This is too long. Please keep it to 300 characters or fewer.` | **New.** Legal Name and DBA now stop at 200 characters, and Principal Address at 300, so a typist never sees these. The 300 line shows under Principal Address when a filled-in address is longer than that and Continue is clicked. The 200 line shows at the top of the signing panel when the W-9 is signed with a name over 200 characters, which is then not taken. | **Awaiting approval** |

### 15.3 The contract wording in the signed PDFs

The approved draft, copied from the shared contract. `[amount]` is the monthly amount, e.g. `$2,000.00`. None of it appears for an invitation with the standard terms, or without an invitation.

| Flag | Exact text, as the investor reads it | Where / when | Status |
|---|---|---|---|
| 🔴 | `3.3 Payment Terms and Method of Payment. In place of the 50/50 split, the Participant shall receive a fixed monthly lease payment of [amount], as set out in Amendment No. 1.` | Master Agreement §3.3, **lease only**. It replaces the 50/50 paragraph and its two distribution bullets; the existing **Payment Execution (Schedule A)** bullet follows it word for word. | **Awaiting approval** |
| 🔴 | `Fixed Monthly Lease Payment: [amount] per month, as set out in Amendment No. 1, in place of the 50/50 profit participation model.` | Lease §2.01, **lease only**. It replaces only the **Variable-Yield Settlement** bullet; the §2.01 lead paragraph and the **Settlement Cycle** and **Method of Payment** bullets stay word for word. | **Awaiting approval** |
| 🔴 | `AMENDMENT NO. 1 — PAYMENT TERMS` | A block in **both** documents, immediately before the signatures, for either type. | **Awaiting approval** |
| 🔴 | `These payment terms were agreed for this Participant and control over any conflicting provision of this Agreement.` | First sentence of that block. | **Awaiting approval** |
| ⚪ | `Payment type:` followed by `50/50 profit split` or `Fixed monthly lease payment` | In the block. | **Awaiting approval** |
| ⚪ | `Monthly amount:` followed by `[amount]` | In the block, **lease only**. | **Awaiting approval** |
| ⚪ | `Additional terms:` followed by the text LogisX entered, or `None` | In the block, line breaks kept. | **Awaiting approval** |

Verbatim, as the shared contract words it (its lines, unchanged):

- **Approved wording** (use it verbatim; `[amount]` is `<strong aria-label="Payment terms monthly amount"></strong>`):
  - **Master §3.3, lease variant:** `<p><span class="section-title">3.3 Payment Terms and Method of Payment.</span> In place of the 50/50 split, the Participant shall receive a fixed monthly lease payment of [amount], as set out in Amendment No. 1.</p>`. Then a `<ul>` holding the existing "Payment Execution (Schedule A)" `<li>`, copied verbatim from `:311`.
  - **Lease §2.01, lease variant:** the existing §2.01 lead paragraph and the Settlement Cycle and Method of Payment bullets, copied verbatim. Only the Variable-Yield bullet is replaced, by `<li><strong>Fixed Monthly Lease Payment:</strong> [amount] per month, as set out in Amendment No. 1, in place of the 50/50 profit participation model.</li>`.
  - **Amendment block** (both documents, both variants). Styled inline so the `<head>` CSS stays byte-identical:
    - Title: `AMENDMENT NO. 1 &mdash; PAYMENT TERMS`.
    - Sentence: "These payment terms were agreed for this Participant and control over any conflicting provision of this Agreement."
    - `Payment type:` `<span aria-label="Payment terms type"></span>`, filled with "50/50 profit split" or "Fixed monthly lease payment".
    - Lease only: `Monthly amount:` `<span aria-label="Payment terms monthly amount"></span>`.
    - `Additional terms:` `<div aria-label="Payment terms details" style="white-space:pre-wrap;overflow-wrap:anywhere"></div>`, filled with the text, or "None" when empty.
    - No checkboxes.

### 15.4 Setup-guide answers corrected — old → new

The setup guide on `/invest` (`client/src/wizard/data/knowledge-base.json`) said things that are not true. Each is corrected below. These show to **every** applicant, with or without an invitation.

| Flag | Old → new | Where | Why | Status |
|---|---|---|---|---|
| 🔴 | `Yes. It's encrypted in transit and at rest. We use it only to send you ACH payouts. You can update it any time from your investor dashboard after approval.` → `Yes. It's sent over an encrypted (HTTPS) connection, stored securely on LogisX's servers, and only visible to LogisX administrators and in your own signed documents. We use it only to send you ACH payouts. To change it later, contact LogisX.` | FAQ `Is my banking info secure?` | Bank details are not encrypted at rest, and there is no screen where an investor can edit them. The Master Agreement they sign prints them in full. | **Awaiting approval** |
| 🔴 | `… Your info is encrypted and stored securely.` → `… Your info is sent over an encrypted connection and stored securely.` | Guide card `Your payout account` (Step 3) | Same: encrypted on the way, not in storage. The rest of the card is unchanged. | **Awaiting approval** |
| 🔴 | `… Your SSN/EIN and banking info are never displayed back in full once you submit.` → `… Your SSN/EIN and banking info are only visible to LogisX administrators and in your own signed documents.` | FAQ `Is my personal info safe?` | The signed W-9 shows the SSN/EIN in full and the Master Agreement shows the bank details in full, and both are in the investor dashboard once approved. The first sentence is unchanged. | **Awaiting approval** |
| 🔴 | `… You'll get a copy of each signed document emailed to you after submission. …` → `… Once you're approved, your signed documents are available in your investor dashboard. …` | FAQ `Are these documents legally binding?` | The applicant's confirmation email carries no attachments; the signed PDFs go to LogisX only. The dashboard lists them under Signed Onboarding Documents. | **Awaiting approval** |
| ⚪ | `… You can pause anytime — everything auto-saves.` → `… You can pause while this tab stays open — your progress is kept, except your EIN/SSN, bank numbers and signatures, which are never saved.` | Guide card `Welcome to LogisX` | Progress is kept only in the open tab, for up to 12 hours, and the EIN/SSN, bank numbers and signatures are deliberately never saved. | **Awaiting approval** |
| ⚪ | `… Your progress auto-saves, so you can pause anytime.` → `… Your progress is kept while this tab stays open, so you can pause — except your EIN/SSN, bank numbers and signatures, which are never saved.` | FAQ `How long will this take?` | Same as above. | **Awaiting approval** |

**Related, left unchanged here** (for you to decide):

- The Step 3 banking note, the `Why do you need my address?` answer and the two profit-share answers that were listed here are now corrected: see 15.5 and 15.6.
- For an investor on a **fixed monthly lease payment**, the Lease §2.01 lead paragraph kept by the approved draft still reads `Rent as a derivative of the Net Operating Income (NOI)`. That is contract wording, so it is left to you. The Amendment says it controls over any conflicting provision, and payouts still follow the Split % column.

### 15.5 The `/invest` page's own security wording corrected — old → new

These are on the page itself, and every applicant sees them, with or without an invitation. Each claimed something the app does not do.

| Flag | Old → new | Where | Why | Status |
|---|---|---|---|---|
| 🔴 | `Your banking information is encrypted and stored securely.` → `Your banking information is sent over an encrypted connection and stored on LogisX's servers; only LogisX administrators can see it.` | Step 3, the green note above the bank fields | Bank details are encrypted on the way (HTTPS) but **not** in storage: they are saved as plain values in LogisX's database, a choice recorded in `docs/claude/pii-at-rest.md`. The admin screens mask them unless a Super Admin reveals them. They are also printed in full in the signed Master Agreement, which the applicant sees in their dashboard once approved and which LogisX's admin mailbox receives as an attachment. Same correction as the setup-guide answers in 15.4. | **Awaiting approval** |
| 🔴 | `256-bit encrypted & secure` → `Encrypted connection (HTTPS)` | Step 1, the green badge under the heading | The connection is encrypted, but not at 256 bits for most applicants. `app.logisx.com` uses whichever cipher the browser prefers, and Chrome prefers 128-bit AES. Checked 2026-09-30: a connection offering Chrome's order got `TLS_AES_128_GCM_SHA256`, and Chromium 152 chose the same. `& secure` promised nothing anyone could check. | **Awaiting approval** |
| 🔴 | `We need a principal business address for your tax forms (W-9) and for mailing any physical paperwork. We never share it with third parties.` → `We need a principal business address for your tax forms (W-9) and for mailing any physical paperwork. Address suggestions and the map are provided by Google Maps, so what you enter there is sent to Google.` | Setup guide FAQ `Why do you need my address?` (`client/src/wizard/data/knowledge-base.json`) | The address field sends what is typed to Google's address suggestions, the map picker is Google Maps, and `Use my current location` looks the position up with Google. The first sentence is unchanged. | **Awaiting approval** |

### 15.6 Payment answers, for an investor invited on different terms — old → new

An investor invited on a fixed monthly lease payment was told, in two setup-guide answers, that they are paid a share of their truck's earnings, while their documents step and Amendment No. 1 say otherwise. Each answer keeps its wording for the standard agreement and adds the same two sentences. Both answers show to every applicant; the second sentence only matters to someone invited with different terms. No other answer states the split or a profit share.

| Flag | Old → new | Where | Status |
|---|---|---|---|
| 🔴 | `LogisX is a trucking logistics company. As an investor, you lease your truck(s) to us. We handle dispatch, loads, insurance, and paperwork. You get paid monthly based on your truck's earnings.` → `LogisX is a trucking logistics company. As an investor, you lease your truck(s) to us. We handle dispatch, loads, insurance, and paperwork. You get paid monthly based on your truck's earnings. That's the standard agreement. If LogisX set different payment terms in your invitation, they're shown on the documents step and in Amendment No. 1 of your agreements.` | Setup guide FAQ `What is LogisX?` (linked from the `Welcome to LogisX` card) | **Awaiting approval** |
| 🔴 | `Payouts run monthly on Net-60 terms from the load delivery date. You'll see a statement each month with load details and your share.` → `Payouts run monthly on Net-60 terms from the load delivery date. You'll see a statement each month with load details and your share. That's the standard agreement. If LogisX set different payment terms in your invitation, they're shown on the documents step and in Amendment No. 1 of your agreements.` | Setup guide FAQ `How often do I get paid?` (linked from the `Your payout account` card on Step 3) | **Awaiting approval** |

⚠️ The caveat says where the invited terms are **shown**, not how payouts are **calculated**: payouts still follow the Split % column for everyone (see the top of §15).

---

## 16. The downloadable report PDF (`GET /api/investor/report`) and tax CSV: payout, date range, truck prices (awaiting your sign-off)

This document **leaves the app**, like the statement (§12). It is the PDF behind **Download Report** (§1), and the tax CSV behind the Section 179 figures' download (§4).

**What changed (2026-09-30).** The report printed `Investor Payout (50%)` and `Owner Earnings (50%)` as half of *revenue minus expenses*, with no driver pay, no rule for a month with no activity, and no loss carried forward. So it showed an investor **more** than their Payouts page for the same month. For a month with no loads it showed a **negative** payout. Both figures now come from the Payouts page: the total of the monthly payouts for the months the report covers. Driver pay is now its own expense line, and a month with no activity is not charged fixed costs, as on the Earnings screen. **Every line below is new and awaiting your approval.**

**Each choice is one setting, and every sentence below is one line of text, all in one file** (`lib/investor-report-options.js`), so a change you ask for is a one-line change.

### 16.1 The payout line

| Flag | Exact text | Where / when | Status |
|---|---|---|---|
| ⚪ | `Driver Pay` | New expense row in the Income Statement, under Gross Revenue. Always shown. | **Awaiting approval** |
| 🔴 | `Investor Payout is the total of your monthly payouts for <first month> – <last month>, the same figures as your Payouts page.` | Small grey line under the Income Statement. Always shown when the report covers at least one month (`for <month>` when it covers one). | **Awaiting approval** |
| 🔴 | `<month> is still in progress, so its figure is the projected payout if the month closed today.` | Same line, when the report reaches the current month. Built from §11's `Projected payout if the month closed today`. | **Awaiting approval** |
| 🔴 | `A month that ran at a loss pays nothing; the shortfall is carried against later months rather than billed back to you.` | Same line, when a month in the report ran at a loss or absorbed an earlier one. Built from the statement's caption (§12). | **Awaiting approval** |
| 🔴 | `Your payout for <month> is the amount that month was settled at. The figures above reflect current records, which have changed since it closed.` | Same line, when a settled month's records have changed since it closed. The Payouts page's own sentence (§11). Plural for several months. | **Awaiting approval** |
| 🔴 | `The payout for <month> includes a correction shown on your Payouts page.` | Same line, when a month in the report carries a manual correction on the Payouts page. | **Awaiting approval** |
| ⚪ | `No payout month falls in this report period.` | Same line, when the dates picked contain no month with a payout (e.g. a future range). | **Awaiting approval** |

### 16.2 Dates that start or end mid-month

**The choice (owner, 2026-09-30): whole months.** A payout is settled per month, so a report from July 15 to August 12 now covers **the whole of July and August on every line**: revenue, fuel and other trip expenses, Driver Pay, the fixed costs and the payout. The period under the title prints the whole months (`Period: 7/1/2026 – 8/31/2026`). Before, revenue and trip expenses followed the exact dates while the payout covered whole months, so half of *Net Profit* was not the payout. The other setting, **exact dates**, puts that back and swaps in the second sentence below.

| Flag | Exact text | Where / when | Status |
|---|---|---|---|
| 🔴 | `Payouts are settled by month, so this report covers the whole of each month in your date range: <first month> – <last month>.` | First sentence of the grey line under the Income Statement, whenever dates are picked. `<month>` when the range is inside one month; `<month> onward` for a start date only; `through <month>` for an end date only. The Super Admin's fleet report says `the date range` instead of `your date range`. | **Awaiting approval** |
| 🔴 | `Driver Pay, the fixed costs and Investor Payout cover whole months; revenue and trip expenses cover the exact dates you chose.` | Same place, **only if the setting is switched to exact dates**. Not shown today. | **Awaiting approval** |
| 🔴 | `Reports cover whole months: a date range that starts or ends mid-month includes that whole month, because payouts are settled by month.` | On the portal, under the report's date inputs (next to **Download Report**, §1), while the setting is whole months. | **Awaiting approval** |

### 16.3 Trucks with no recorded purchase price

**The choice (owner, 2026-09-30): say so, never $0.** A truck whose purchase price was never entered in the Truck Database used to count as **$0**, which quietly lowered every figure built from the price. Now:

- A **per-truck** figure is the average over the trucks that have a price. When none has one, it reads `Not recorded`.
- A figure that needs **every** truck's price reads `Not available` while any truck lacks one.
- The PDF adds a footnote and the CSV a count row saying how many trucks lack a price.

The other setting, **zero**, puts the old $0 back with no footnote.

| Flag | Exact text | Where / when | Status |
|---|---|---|---|
| ⚪ | `Not recorded` | PDF: Purchase Price (per truck) and Section 179 Deduction. CSV: Purchase Price (per truck), Section 179 Deduction (100%) and Annual Depreciation (Year 1). When none of the investor's trucks has a recorded price. | **Awaiting approval** |
| ⚪ | `Not available` | PDF: Total Purchase Price, Current Market Value (80%), Total Investment and Payoff Progress. CSV: Total Fleet Purchase Price and At-Risk Capital Remaining. When any of the investor's trucks has no recorded price. | **Awaiting approval** |
| 🔴 | `Purchase price not recorded for <n> of <total> truck(s). Figures that need it show "Not available" until it is entered in the Truck Database.` | PDF, small grey line under the Asset Security figures, when any truck has no recorded price. | **Awaiting approval** |
| ⚪ | `Trucks without a recorded purchase price` | CSV, a new row under Total Trucks with the number of such trucks, when there is at least one. | **Awaiting approval** |

*Business ROI* is net profit over revenue and does not use the purchase price, so it always shows its number.

### 16.4 Messages

Error messages are normally not listed here (see "Not listed" at the top). These are new, so here they are.

| Flag | Exact text | Where / when | Status |
|---|---|---|---|
| ⚪ | `The start date must be a real date written as YYYY-MM-DD.` (`end` for the end date) | The report, when a date is not a real calendar day. The portal's date picker cannot send one; a hand-edited link can. | **Awaiting approval** |
| ⚪ | `The start date is after the end date.` | The report, when the start date is later than the end date. | **Awaiting approval** |
| ⚪ | `Too many report downloads. Try again in a few minutes.` | After 20 report downloads by one person within 15 minutes. | **Awaiting approval** |
| ⚪ | `Too many tax document downloads. Try again in a few minutes.` | After 20 tax CSV downloads by one person within 15 minutes. | **Awaiting approval** |
| ⚪ | `Failed to generate tax document` | When the tax CSV fails unexpectedly. The report already said `Failed to generate report`. | **Awaiting approval** |

---

## The ones I'd raise first

0. **§2 / §12, the loss carry-forward** — the line you actually asked about. Two things to settle: (a) **one wording**, since the same deduction is currently called three different things across the PDF, the Earnings screen and the Payouts table; and (b) whether `Payable` / `Projected payout` is the right name for the figure that lands under it. Everything else in this file can wait — this one is live in August.
1. **§4 Section 179** — two paragraphs of tax explanation. Does the portal want to be saying this?
2. **§5 and §8, "the Job Tracking sheet … soft-deleted … load-exclusion filter"** — internal vocabulary in front of an investor, in two places.
3. **§10 "…and may differ"** — the portal telling an investor two of its own totals disagree.
4. **§15, a fixed monthly lease on paper, a split in the payouts** — an investor invited on a lease signs for a fixed monthly amount, while payouts are still calculated from the Split % column. The two setup-guide answers that describe a profit share now say it is the standard agreement (§15.6), but the Lease §2.01 lead paragraph still describes rent as a share of Net Operating Income (see "Related, left unchanged here" under §15.4).
5. **§16.2 / §16.3, the report's two choices** — whole months for a mid-month date range, and `Not available` / `Not recorded` instead of $0 for a truck with no recorded purchase price (*Business ROI*, which does not use the price, keeps its number). Each is one setting; the other setting is the report as it was.
