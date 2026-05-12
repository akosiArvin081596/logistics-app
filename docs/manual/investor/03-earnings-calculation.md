# Earnings Calculation — How the Math Works

This chapter is the formula behind your earnings number, step by step, with examples. Read it once to understand exactly what's happening; refer back when a number surprises you.

## The full formula

For a given period (typically a month):

```
Revenue
  − Driver Pay
  − Fixed Costs
  − Trip Expenses
  ─────────────────
  = Net Profit

Your Earnings = Net Profit ÷ 2
```

The "divide by 2" reflects your 50/50 split with LogisX per your Master Participation Agreement. If your agreement has a different split, the divisor adjusts accordingly.

## Step 1: Revenue

**Revenue** = sum of the **Payment** column from Job Tracking for all completed loads run on your trucks during the period.

What counts as a load run on "your" truck:

- The load's **Owner ID** column matches your investor record ID. (Primary attribution.)
- OR the load's driver matches a driver in your **company** (Carrier Database fallback).

A load counts in the month it was **assigned**, not the month it was delivered. This is a CEO decision to align with how the dispatcher dashboard reports revenue.

Excluded:
- **Cancelled loads** (status matches `Cancelled`).
- **Soft-deleted loads** (in the `deleted_loads` table).

Both exclusions are centralized in the `excludeDroppedLoads` helper used across the system.

### Example

You own TRK-101 and TRK-102. In April:
- TRK-101 ran 4 loads: $2,000, $1,800, $2,400, $1,500 = **$7,700**.
- TRK-102 ran 3 loads: $2,200, $2,500, $1,900 = **$6,600**.
- One load on TRK-102 was cancelled: $1,800 not counted.

**April Revenue = $14,300**

## Step 2: Driver Pay

**Driver Pay** = what you owe the drivers for running your loads in the period.

Two pay structures:

### Daily Rate Drivers

```
Driver Pay = $250 × unique active calendar days
```

An "active calendar day" is any day a driver was on at least one load. Multi-day loads count every day they spanned (pickup Mon → delivery Wed = 3 days). Multiple same-day loads count as 1 day.

Deduplication happens across all loads for the same driver in the period.

The $250 default rate comes from each truck's `driver_pay_daily` setting; can vary per truck.

### Owner-Operator Drivers

```
Driver Pay = Σ (load_revenue × driver_pay_percentage) for each load
```

The percentage comes from each load's pay split (typically 70% to driver, but configurable). Calculated per load.

### Example

TRK-101 has daily-rate driver Lesline:
- 4 loads spanning Apr 5-15. Unique active days: Apr 5, 6, 7, 8, 9, 10, 14, 15 = 8 days.
- 8 × $250 = **$2,000**.

TRK-102 has owner-op driver Kenrick at 70%:
- 3 loads at $2,200, $2,500, $1,900.
- Driver pay: $1,540 + $1,750 + $1,330 = **$4,620**.

**Total Driver Pay = $6,620**

## Step 3: Fixed Costs

**Fixed Costs** = the recurring cost of operating each truck. Per truck per month:

```
Insurance (monthly)
+ ELD Service (monthly)
+ HVUT (annual / 12)
+ IRP (annual / 12)
+ Maintenance Fund Reserve (monthly)
= Truck's monthly fixed cost
```

These come from the truck record. Examples (per truck, per month):

- Insurance: $250
- ELD: $45
- HVUT (annual ÷ 12): $46
- IRP (annual ÷ 12): $150
- Maintenance fund: $800
- **Total: $1,291 / truck / month**

Note: fixed costs accrue **only for months the truck has existed in your fleet**. They don't backdate to before your acquisition.

### Example

TRK-101 monthly fixed: $1,291. April: $1,291.
TRK-102 monthly fixed: $1,381 (slightly different rates). April: $1,381.

**Total Fixed Costs = $2,672**

## Step 4: Trip Expenses

**Trip Expenses** = approved expenses (fuel, repairs, tolls, lumpers, scale fees, etc.) submitted by drivers for loads run on your trucks.

Only **approved** expenses count. Pending and rejected expenses are excluded from your earnings until they're decided.

Expenses are attributed to your trucks via the load's truck assignment.

### Example

TRK-101 expenses in April:
- Fuel: $1,200.
- Repairs (tire): $400.
- Tolls: $80.
- Scale: $30.
- **Subtotal: $1,710.**

TRK-102 expenses:
- Fuel: $1,400.
- Lumpers: $200.
- **Subtotal: $1,600.**

**Total Trip Expenses = $3,310**

## Step 5: Net Profit

Now we put it together:

```
Revenue           $14,300
− Driver Pay      ($6,620)
− Fixed Costs     ($2,672)
− Trip Expenses   ($3,310)
─────────────────────────
= Net Profit       $1,698
```

In this example: April was a slow month, expenses were elevated, net was modest.

## Step 6: Your Earnings

```
Your Earnings = Net Profit ÷ 2 = $1,698 ÷ 2 = $849
```

The other $849 goes to LogisX as management compensation.

## Why your number might be different

Compared to a back-of-envelope calculation, the actual numbers can differ for several reasons:

1. **Cancelled or soft-deleted loads** drop out of revenue. If you're counting "what I expected to earn" based on loads you remember, but some were cancelled, the actual number is lower.

2. **Date attribution.** A load assigned in late April but delivered in early May counts in April (not May). If you're mentally counting by delivery date, you'll be off.

3. **Driver pay can be higher than expected.** Multi-day loads count multiple days for daily-rate drivers. A 4-day load is $1,000 in driver pay (4 × $250), which is substantial.

4. **Fixed costs are constant.** Even in a low-revenue month, fixed costs accrue. They don't scale with revenue.

5. **Pending expenses** aren't included. Once approved (later in the cycle), they apply retroactively to the month, reducing your earnings on a subsequent refresh.

## When to question the math

A few patterns are worth checking:

**Revenue much lower than expected.** Check:
- Were loads cancelled?
- Are your trucks' Owner IDs correct on the loads?
- Did some loads get attributed to a different investor?

**Driver pay much higher than expected.** Check:
- Are the load dates correct in the system? A typo can inflate active-day counts.
- Is the driver's pay_type correct (daily vs. owner-op)?

**Fixed costs higher than expected.** Check the truck record for the monthly amounts. They should match your contract.

**Trip expenses unusually high.** Look at the per-truck breakdown to see which truck has elevated expenses. Then drill into specific expenses.

For any of these, message operations. They can show you the underlying data.

## Comparing months

Your earnings month-to-month will vary. Factors:

- **Number of loads run** — directly drives revenue.
- **Average load rate** — higher per-load rate = higher revenue.
- **Multi-day vs. short loads** — multi-day loads earn more revenue per truck-day but also higher driver pay per truck-day (for daily-rate drivers).
- **Maintenance events** — a transmission repair can wipe out a month's earnings.
- **Fuel prices** — variable but a big line.
- **Driver assignment** — productive drivers vs. less-productive ones make a real difference.

A 30-50% month-to-month swing isn't unusual in trucking. Worry about sustained declines, not single bad months.

## How LogisX manages

A few decisions LogisX makes that affect your earnings:

- **Which loads to take.** Higher-rate loads are obviously better; LogisX optimizes for revenue per truck-day.
- **Which driver runs your truck.** Productive drivers generate more revenue.
- **When to do major maintenance.** Preventive maintenance is cheaper than reactive; LogisX schedules.
- **Operational efficiency.** Less deadhead = more revenue per gallon.

You don't make these decisions, but you see their effects in your dashboard. If something looks consistently off, talk to operations.

## What you can do

- **Be patient on individual months.** Trucking has cycles.
- **Watch quarterly and annual trends.** Those matter more than monthly variance.
- **Ask questions about your numbers.** The math is transparent; we'll walk through any line.
- **Set realistic expectations.** Trucking returns aren't index-fund-like. Some months disappoint; others delight.

## Pro tips

- **Use the dashboard's drill-down clicks.** Each line in the breakdown is interactive. Click to see the loads or expenses behind it.
- **Compare same-month-prior-year.** April this year vs. April last year is more apples-to-apples than April vs. March.
- **Generate a monthly PDF report** at the end of each month and keep them. They're a paper trail for the year.
- **Don't get fixated on one month.** A bad month + a great month averages out. The annual number is what matters.
