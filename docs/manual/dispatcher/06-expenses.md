# Expenses

Drivers log expenses (fuel, tolls, repairs, lumpers, scale tickets, etc.) on their phones throughout the day. You see them on the **Expenses** screen, review them in context, and can log on a driver's behalf when needed. Approval itself is a Super Admin action — you see the data and surface issues.

## Opening expenses

Sidebar → **Expenses**. You'll see a list of all expense submissions across the fleet, most recent first. Each row shows:

- **Date** of the expense.
- **Driver** who logged it.
- **Type** (Fuel, Repair, Toll, Scale, Lumper, etc.).
- **Amount.**
- **Vendor** (where they paid).
- **Load ID** the expense is associated with.
- **Status** — Pending, Approved, Rejected.

You can also click into a row for the full detail, including the receipt photo, the auto-parsed values from OCR, and the driver's description.

## Reviewing submissions

What dispatchers typically look at:

- **Does the amount match what's expected for that vendor and type?** A $400 fuel charge at a truck stop on a long haul is normal; the same amount for a lumper is unusual.
- **Is the receipt photo readable?** If you can't read it, the expense may not be approvable.
- **Is the Load ID right?** If the expense is associated with a different load than expected, the financial allocation will be off.
- **For fuel:** are gallons and odometer logged? If not, the analytics suffer.

If something looks off, **message the driver** to clarify before escalating. Many issues are simple data-entry mistakes the driver will gladly fix.

## What you can't do directly

You **can't approve or reject** expenses. That's a Super Admin action. What you can do:

- **Add notes** for Super Admin to see.
- **Message Super Admin** to flag specific submissions.
- **Identify patterns** worth reviewing (a driver fueling more than expected, repeated lumper fees, etc.).

In practice, the workflow is: drivers submit, you review and flag issues, Super Admin processes the approvals. You're not in the approval chain — you're in the quality-check chain.

## Adding an expense on a driver's behalf

Sometimes a driver pays for something by phone and tells you about it instead of logging it themselves:

- "Hey, the tire repair shop only takes phone payments and I authorized $300."
- "Just paid the lumper $80 cash; can you log it for me?"
- "I forgot to log fuel from yesterday."

To add on their behalf:

1. **Expenses → Add Expense.**
2. **Pick the driver from the dropdown.**
3. **Fill in the form** — type, amount, date, vendor, description, Load ID.
4. **Photo** (if you have a receipt).
5. **Save.**

The expense appears in the system as if the driver logged it, with a small indicator showing "added by dispatch." That indicator is informational — it doesn't change the approval workflow.

## Expense types and what they mean

The expense Type field is structured. Choose the closest match:

| Type | Use for |
|---|---|
| **Fuel** | Diesel, DEF. Gallons and odometer fields appear. |
| **Repair** | Tire, brake, mechanical work, anything emergency-fix. |
| **Toll** | Manual toll payments (not automatic E-ZPass which is billed separately). |
| **Scale** | Weighing fees at CAT scales or others. |
| **Lumper** | Payments to dock workers. |
| **Wash** | Reefer or tanker washouts. |
| **Parking** | Paid overnight or longer parking. |
| **Permit** | Overweight, oversize, single-trip permits. |
| **Other** | Anything that doesn't fit. Use the description to clarify. |

When in doubt, **Other** with a clear description is fine. Super Admin will recategorize if needed.

## Fuel analytics

Fuel is the biggest expense category and has dedicated analytics. From the Expenses tab (or via Super Admin), you can see:

- **Total fuel spend** for a period.
- **Cost per gallon** (avg).
- **Monthly trend.**
- **Per-driver breakdown** — which drivers are buying more fuel per mile.

Useful for spotting:

- A driver suddenly fueling much more often (could be a truck issue or a driver issue).
- Vendor patterns — are drivers buying at expensive truck stops when cheaper ones are on the route?
- Seasonal trends.

You don't typically act on fuel analytics yourself — Super Admin does. But you may be asked to investigate something the analytics surface.

## When a driver disputes a rejection

If Super Admin rejects an expense, the driver will see a "rejected" status on their side and (typically) a reason. Common rejection reasons:

- **No receipt.**
- **Receipt unreadable.**
- **Personal expense miscategorized as company.**
- **Duplicate** (same fuel stop logged twice).
- **Wrong load attribution.**

If a driver thinks the rejection is unfair, they message you. Your role: hear them out, talk to Super Admin, mediate. If the rejection stands, communicate that to the driver clearly. If it's reversible, ask Super Admin to reconsider.

## Patterns to watch for

A few things worth flagging if you notice them:

- **Same driver, multiple lumpers on consecutive days.** Lumpers are sometimes scams; if a driver is paying them frequently, ask about the receivers.
- **Fuel receipts at truck stops far from the route.** Could be a deadhead, a personal stop, or something else. Ask.
- **Unusually high repair amounts.** Even normal mechanical issues should be in the hundreds, not thousands, without notice.
- **Mass receipts within a tight window.** Could be a driver catching up on logging. Fine, but verify load IDs are correct.

Most patterns turn out to be innocent. The point is to look — patterns invisible to the driver may be visible to you.

## Best practices

- **Glance at expenses daily.** A 2-minute scan of the day's submissions catches issues early.
- **Don't ignore the photo.** It's the proof. Open a few each day to make sure they're legible.
- **Talk to drivers, not at them.** "Hey, can you help me understand this $400 repair?" lands better than "Why is this so high?"
- **Encourage logging at the time of purchase.** Drivers who log on the day of are way more accurate than drivers who reconstruct a week.
- **Use the AI's auto-fill but don't trust it blindly.** Receipt OCR is good, not perfect. Verify.
