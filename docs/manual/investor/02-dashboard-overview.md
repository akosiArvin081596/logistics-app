# The Dashboard, Section by Section

This chapter is a tour of every section on the investor dashboard. What it shows, what it means, and how to read it.

## The hero header

What you see:
- Your profile photo.
- Your full name (the name you signed your agreement under).
- "Performance overview" subtitle.
- **Date range picker.**
- **Download Report** button.
- **Refresh** button.

What to use it for:

The **date range picker** is the most-used control. Pick a single month (e.g., April 2026) or a custom date range to focus the whole dashboard on that period. Everything below the hero — earnings, fleet breakdown, production, charts — filters to the chosen range.

The **Download Report** button generates a PDF covering the selected range. Useful for your records or your accountant.

The **Refresh** button forces a data reload from the server. Rarely needed — the dashboard updates in real time. But if a number looks stale and you want to be sure, refresh.

## Earnings section

The headline section. Shows your share of the net profit for the selected period.

The main card displays:

```
Your Earnings (50% of net profit)
$X,XXX
```

Beneath, a breakdown table:

| Line | Amount |
|---|---|
| Revenue (from completed loads) | $XX,XXX |
| − Driver Pay | ($X,XXX) |
| − Fixed Costs (insurance, ELD, IRP, HVUT, maintenance) | ($X,XXX) |
| − Trip Expenses (fuel, repairs, tolls, etc.) | ($X,XXX) |
| **Net Profit** | $XX,XXX |
| ÷ 2 (your share) | $XX,XXX |
| **Your Earnings** | **$X,XXX** |

A **month selector** lets you flip between months without changing the global date range picker. Useful for comparing month-over-month.

An **all-time totals strip** beneath shows lifetime revenue, lifetime expenses, lifetime net profit, lifetime earnings.

Each line is clickable — click for the per-load detail behind the number (which loads contributed to revenue, which expenses are in trip expenses, etc.).

The full math is explained in the [Earnings Calculation](#) chapter.

## Fleet Breakdown section

Per-truck cards. For each truck you own:

- **Truck unit number** (e.g., TRK-101).
- **Make, model, year.**
- **Status** — Active, Available, Maintenance.
- **Assigned driver** (if any).
- **Last known location** (city, state).
- **This month's revenue** for that truck.

Click any card for the full truck record:

- VIN.
- License plate.
- Mileage.
- Documents (registration, insurance, inspection).
- Acquisition date.
- Historical drivers.

If you own multiple trucks, this is where you see relative performance — which truck is generating more revenue, which is idle.

## Production section

Three operational metrics:

- **Miles driven** during the selected period.
- **Loads completed** during the period.
- **Utilization percentage** — how much of the period your trucks were on active loads.

These tell you whether your fleet is working. A truck that earns well but only ran 3 loads has a different long-term outlook than one that earned the same on 12 loads.

A truck idle with high utilization but low revenue might be running low-rate freight (worth a conversation). A truck with low utilization is sitting more than it should (worth investigating).

## Cash Flow section

A line chart of revenue over time. Typically shows monthly revenue for the prior 12 months (depending on your install).

Use it to:

- **Spot trends.** Is revenue growing month over month? Stagnant? Declining?
- **See seasonality.** Trucking has busy and slow seasons. Your chart should reflect them.
- **Compare to expectations.** Is this year tracking similar to last year?

Hover over points to see exact monthly values.

## Asset section

Your trucks as assets. For each:

- **Truck.**
- **Acquisition date.**
- **Book value** (depreciation-adjusted).
- **Status.**

Useful for tax planning and equity discussions with leadership.

## Tax Shield and Recession sections (if applicable)

Depending on your install, you may see additional sections:

- **Tax Shield** — depreciation and other tax considerations.
- **Recession Analysis** — modeling for downturns.

These are informational; consult your tax preparer for actionable advice.

## Document Portal

Every document you've signed and every report you've generated. Categories:

- **Onboarding documents** — Master Participation Agreement, Vehicle Lease, W-9, Exhibit A.
- **Historical reports** — PDFs you've downloaded for past periods.
- **Operating documents** — anything else operations has shared with you.

Click any document to view inline. Tap the download icon to save a copy locally.

## Configuration panel

Profile-related settings:

- **Profile photo** upload.
- **Notification preferences** — what you get emailed about.
- **Contact info** — phone, email.
- **Change password.**

## Chat with operations

In-app messaging. Same as drivers chat with dispatch; you chat with operations.

Use for:
- Questions about specific numbers on your dashboard.
- Reporting truck issues you've observed.
- Requesting custom reports.
- Anything else needing a response from the team.

## What you won't see

A few things absent by design:

- **Other investors' data.** You see only your fleet.
- **Driver personal info beyond name.** Phones, addresses, employment history — operations' to manage, not yours.
- **Specific broker names per load.** Your dashboard shows revenue per load but typically not the broker name. (This may vary by your install.)
- **Operational controls** — assigning, dispatching, status updates. Read-only.

This isn't because of secrecy — it's because the data isn't your responsibility. Operations handles those things.

## Mobile vs. desktop

The dashboard works on both. On mobile, sections stack vertically and some layouts collapse. The data is the same.

For deep reviews (comparing months, downloading reports for your accountant), desktop is more comfortable. For a quick "what's my month look like?", mobile is fine.

## How often to check

A few patterns:

- **Daily check** is unnecessary unless you're actively monitoring a specific issue.
- **Weekly check** is more than enough for most investors.
- **Monthly review** is the minimum recommended habit. Catch the prior month's final numbers, scan for surprises.

You can always sign in more often, but you don't need to.

## Pro tips

- **Bookmark the dashboard URL** and any specific monthly view you reference often.
- **Use the date range picker actively.** Comparing the same metrics across different periods is more useful than just looking at "this month."
- **Take screenshots when you see something interesting.** A revenue spike, an unusual expense — capture it. Helpful when you message operations to ask about it.
- **Download reports periodically.** Don't wait until tax time and download 12 months of reports in a hurry.

The chapters that follow dig into each major section in more detail.
