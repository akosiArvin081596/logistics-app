# Fleet Breakdown — Reading Per-Truck Performance

Your dashboard's Fleet Breakdown section shows each truck individually. This chapter is how to read those cards and what they tell you.

## What you see

Each truck you own appears as a card showing:

- **Truck unit number** (TRK-101, INV-4-A, etc.).
- **Make, model, year.**
- **Status:** Active (assigned to a driver running a load), Available (idle), Maintenance.
- **Assigned driver** (if any).
- **Last known location** (city, state).
- **This period's revenue** for the truck.

If you own multiple trucks, the cards appear side by side or stacked depending on your screen.

## Drilling into a truck

Click any card for the full truck record. You'll see:

- **VIN** — vehicle identification number.
- **License plate.**
- **Make, model, year, color** (if logged).
- **Current mileage.**
- **Purchase price and acquisition date.**
- **Documents** — registration, insurance card, annual inspection, cab card, HVUT Schedule 1.
- **Currently-assigned driver** (and how long they've been on this truck).
- **Historical drivers** — who else has driven this truck.
- **Maintenance history** (if logged).

This is the source-of-truth view for a specific truck.

## Why per-truck visibility matters

Two reasons:

**Relative performance.** Two trucks running the same loads should perform similarly. If one is consistently below the other in revenue, something is off — driver issue, mechanical issue, route mismatch.

**Accountability for individual assets.** Each truck is a separate asset on your books. You want to know which is paying off and which is dragging.

## Status meanings

- **Active.** The truck is currently assigned a driver and on a load. Generating revenue.
- **Available.** The truck has an assigned driver but no current load. Not generating revenue right now but is ready to take one.
- **Maintenance.** The truck is in the shop or grounded for an issue. Not available for assignment.

A long stretch in Available status is worth investigating — either the truck-driver pair isn't getting loads (dispatch issue) or the driver isn't able to work (HOS, health, etc.).

A long stretch in Maintenance is worth investigating — what's the issue and what's the resolution timeline.

## When a truck has no assigned driver

Cards may show "no driver" status. Reasons:

- **Driver recently left** and the truck hasn't been reassigned.
- **New truck** still being prepped.
- **Driver on extended leave** (vacation, medical).
- **Truck in maintenance** with the driver temporarily moved elsewhere.

If your truck has no driver and the situation isn't temporary, message operations. An idle truck is lost revenue.

## Reading documents per truck

Click into a truck → Documents section. You'll see:

- **Registration.**
- **Insurance card.**
- **Annual inspection.**
- **Cab card / IRP.**
- **HVUT Schedule 1.**

These are the documents LogisX is responsible for keeping current on your behalf. Click to view inline.

Driver-visible flag: documents flagged "driver-visible" appear on the driver's phone (Kit tab). Most operational documents are flagged; some internal docs aren't.

## Mileage tracking

The truck's mileage on the card and in detail reflects what LogisX records (typically odometer readings from fuel receipts or driver-reported logs).

Mileage tells you:

- **Wear and tear** — a high-mile truck needs more maintenance.
- **Productivity** — high miles in a month = high activity.
- **Future value** — used trucks depreciate with mileage.

If the mileage on a truck seems too low (you know your truck has been running 2,500 miles/week and the dashboard shows much less), the data may not be current. Message operations to update.

## Acquisition info

Each truck shows:

- **When you acquired it** — typically when the Vehicle Lease was signed and the truck was registered.
- **Purchase price.**
- **Title status.**

This info is used for asset valuation and tax depreciation. Verify it matches your records.

## Maintenance status

A truck in **Maintenance** status:

- Is not assigned new loads.
- Doesn't generate revenue while down.
- May still accrue fixed costs (insurance doesn't pause).
- Will show maintenance notes in its detail (if logged).

Mechanical events are facts of life in trucking. Hopefully short downtimes, occasionally longer ones. The dashboard reflects reality — if your truck is down for a transmission replacement, that's a real event with a real cost.

## Truck-driver pairings

LogisX assigns drivers to trucks. Some operational rules:

- **Each driver has one assigned truck at a time.**
- **A truck can have one assigned driver at a time.**
- **Reassignment happens when needed** — driver leaves, truck goes down, productivity issues, etc.

You see the current pairing. You don't decide it. If you have a preference or concern about a pairing, message operations and we'll discuss.

## Multiple trucks comparison

If you own multiple trucks, the Fleet Breakdown gives you side-by-side comparison.

Things to compare:

- **Revenue per month.** Are they similar? Outliers?
- **Utilization.** Are they all running consistently or is one sitting?
- **Maintenance frequency.** Are some trucks needing more repairs than others?
- **Driver tenure.** Is one truck on its third driver this year while another has the same driver for two years?

Patterns can signal:

- A specific truck has issues (consistent maintenance, low revenue).
- A specific pairing isn't working (high turnover).
- A specific driver is underperforming.

Don't draw conclusions from one data point. Look at sustained patterns.

## When to add to your fleet

Sometimes investors want to expand. Signals it might make sense:

- **Strong revenue per truck** with sustained demand.
- **Available capital** for the acquisition.
- **Risk tolerance** to take on more.

Signals to wait:

- **Inconsistent performance** on current trucks.
- **Heavy maintenance season** on existing fleet.
- **Soft freight market** broadly.

This is your decision; LogisX can advise. Message operations to discuss.

## When to remove from your fleet

Trucks come out of service for various reasons:

- **Sold** — you sell to another owner, possibly LogisX.
- **Retired** — too old or too damaged to keep operating profitably.
- **Wrecked** — total loss, insurance proceeds, replace or exit.

In any case, the truck record is updated to reflect the exit. Past revenue and expenses stay attributed to it for historical reporting.

## Pro tips

- **Periodically open each truck's detail.** Once a quarter, click through each truck. Verify the documents are current, the driver is assigned, the data looks right.
- **Cross-check truck records to physical reality.** If you have a physical truck inspection or a driver's report, compare to what the system shows.
- **Note any patterns** in your own log. The system shows current state; you can track trends.
- **Investigate underperformers.** A truck consistently below your other trucks deserves a conversation with operations. Multiple causes, multiple possible fixes.
