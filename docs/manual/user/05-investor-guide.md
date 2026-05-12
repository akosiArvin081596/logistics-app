# Investor Guide

Your dashboard shows the performance of every truck you fund: how much it earned, what it cost to run, and what's left for you. This chapter walks through every section so you know what each number means and how to read it.

## Where you land

After you sign in, you go straight to the **Investor Dashboard** at `/investor`. There is no sidebar — your dashboard is your home and your destination. You can also reach **Trucks** to see fleet-level details for the trucks you own.

The dashboard starts with a **hero header** showing your photo, your name, and a **Performance overview** subtitle. From here you can:

- Choose a date range from the picker on the right.
- Tap **Download Report** to get a PDF for the date range you've selected.
- Tap **Refresh** to force-reload the data (it auto-refreshes when relevant events happen, so this is rarely needed).

![Investor dashboard hero](screenshots/investor-hero.png)

## Earnings section

This is the section most investors look at first. It shows your earnings for a single month with a full breakdown of how the number was calculated.

At the top, a **month selector** lets you flip between months. The current month is shown by default.

A large card shows **Your Earnings** for the selected month — your 50% share of the net profit on your fleet for that month. Below that, a breakdown table explains the math:

```
Revenue (from completed loads)         $XX,XXX
  − Driver Pay                          ($X,XXX)
  − Fixed Costs (per truck × month)     ($X,XXX)
  − Trip Expenses (fuel, repairs, etc.) ($X,XXX)
  ─────────────────────────────────────────────
  = Net Profit                          $XX,XXX
  ÷ 2 (your half)                       $XX,XXX
```

![Investor earnings section](screenshots/investor-earnings.png)

Beneath that, an **all-time totals** strip shows lifetime revenue, lifetime expenses, lifetime net profit, and your lifetime earnings.

### How each number is calculated

- **Revenue.** The total payment amount for every load assigned to a truck you own during the month. Loads that were cancelled or removed are excluded. A load counts in the month it was **assigned**, not delivered — this matches how dispatch reports revenue, so the numbers line up.
- **Driver Pay.** For drivers on a **daily rate**, this is $250 (or whatever rate is configured) times the number of unique calendar days the driver was active on your loads. Multi-day trips count every day they spanned. Multiple loads in one day count as one day. For drivers on an **owner-operator** pay type, this is a percentage of revenue per the agreed split.
- **Fixed Costs.** The monthly portion of insurance, ELD service, IRP, HVUT, and the maintenance fund for each truck you own. Fixed costs only accrue for months the truck has actually existed in your fleet — they don't backdate.
- **Trip Expenses.** Fuel, tolls, weight tickets, repairs, and any other variable expense logged against one of your trucks for the month.
- **Net Profit.** Revenue minus all expenses.
- **Your Earnings.** Half of net profit, by your management agreement.

## Fleet breakdown section

This section shows every truck you own as a card. Each card has:

- The truck number and basic info (make, model, year).
- Current status — Active (assigned to a driver), Available (idle, no driver), Maintenance.
- Currently-assigned driver.
- A small summary of this month's revenue for that truck.

Click into a truck card for the full truck record: VIN, mileage, last inspection, document list, and historical drivers.

## Production section

Three numbers that summarize how hard your fleet is working:

- **Miles driven** — total miles across your trucks for the selected period.
- **Loads completed** — count of delivered loads.
- **Utilization** — percentage of the period your trucks were on active loads vs. idle. Higher is better.

These tell you whether your investment is generating activity. A truck that earns well but only because it ran a few high-rate loads has different long-term implications than a truck that earns well by staying busy.

## Cash flow section

A line chart showing revenue over time. Use it to:

- Spot trends — is revenue growing month over month?
- See seasonal effects — your sector likely has slow and busy periods.
- Compare against expectations — is this month tracking like prior months?

## Asset section

Your trucks listed as assets with acquisition dates and book values. Useful for tax planning and equity discussions.

## Documents portal

Every document you've signed during onboarding and every document the company has shared with you specifically. Common documents include:

- **Master Participation & Management Agreement** — the umbrella contract.
- **Vehicle Lease** — per-truck lease.
- **Exhibit A** — vehicle specification (one per truck if you have multiple).
- **W-9** — your tax form.
- **Monthly reports** — historical PDFs of the report you've downloaded.

Tap any document to view inline. Tap the download icon to save a copy.

## Messages

Direct chat with the LogisX operations team. Use it for:

- Asking about a specific number you don't understand.
- Reporting that a truck is offline or having issues.
- Requesting a new document or report.
- Anything else that needs an answer from the team.

Messages are response within business hours.

## Downloading a report

Use the **Download Report** button in the hero header. Pick a date range (a single month, a custom range, or all-time) and tap **Download**. The system generates a PDF showing:

- Cover page with your name, the period, and the date.
- Revenue breakdown per truck.
- Driver pay summary.
- Fixed costs by category.
- Trip expense summary.
- Net profit calculation.
- Per-load detail (every load that contributed to the period's revenue).

This is the report you'd share with your accountant or use to reconcile with a check or bank statement.

## Trucks tab

Open **Trucks** from the dashboard's secondary nav. You see only the trucks you own. Click into a truck for everything we know about it — VIN, plate, registration expiry, insurance card, last inspection date, mileage, current driver, document list.

This is the right place to verify a truck's documents are current or to look up a registration number when an officer asks.

## What you can do and what you can't

You **can**:

- View earnings and reports for your fleet.
- Download monthly or custom-range reports.
- View and download all your signed documents.
- See current truck status and assigned drivers.
- Message the operations team.
- Update your profile photo and notification preferences.

You **cannot**:

- Edit a load's details, driver pay, or expenses.
- See data for trucks you don't own.
- Access financials for the company as a whole.
- Approve or reject operational decisions.

Your read-only access is by design — it lets you trust the numbers without being responsible for the daily operation.

## Common situations

**"My monthly earnings show $0 but I know my truck has been running."** Three things to check. First, your account's company name (in your profile) should match the carrier name on your truck's records. Second, the Owner ID on the loads should match your investor record. Third, make sure no recent loads were cancelled. If any of these look wrong, message operations.

**"The monthly view and the all-time view don't add up exactly."** The most common cause is loads with incorrect pickup/dropoff dates in the sheet — they may count as active days for all-time but not for a specific month (or vice versa). Message operations with the specific month and we can correct the dates.

**"I see a fixed cost line on a truck I haven't had for that long."** Fixed costs should only accrue for months the truck has been in your fleet. If they appear earlier than that, the truck's acquisition date may be set wrong. Message operations to check.

**"I want to see the per-load detail for a single month."** Download the report for that month — the PDF includes a per-load section showing every load, its driver, its revenue, and the date.

**"I can't find a document I signed."** Check your Documents portal first; signed docs land there after the signing flow completes. If it's truly missing, message operations — the master copy is also stored on our side and can be re-attached to your portal.

**"My profile photo is outdated."** Open your profile (top of the dashboard) and use the photo upload to replace it.
