# Logging Expenses

Trip expenses — fuel, repairs, tolls, scale tickets, parking, lumpers, washouts — get logged in the app so the company can track and reimburse them. This chapter is how.

## What to log

Anything you paid for that's related to running a load:

- **Fuel** — diesel or DEF. Most common expense.
- **Repairs** — tire, brake, anything emergency-fix at a truck stop or shop.
- **Tolls** — turnpikes, bridges, expressways. (If your truck has an automatic toll device, those get billed separately and you don't need to log them.)
- **Scale tickets** — weighing fees at CAT or other scales.
- **Lumpers** — payments to dock workers for help unloading.
- **Washouts** — reefer or tanker cleaning.
- **Parking** — overnight at paid lots.
- **Tarps** — if you had to buy or rent one.
- **Permits** — overweight, oversize, single-trip permits.

What **not** to log here:

- **Personal expenses** — your food, coffee, motel. Those are yours.
- **Fines or tickets** — yours.
- **Insurance** — that's a company-level fixed cost, not a trip expense.

If you're not sure whether something counts, log it with a clear note. Worst case, dispatch rejects it and you know for next time.

## How to log an expense

From the **Kit** tab, scroll to **Expenses** and tap **Add Expense.**

The form has these fields:

| Field | What to enter |
|---|---|
| **Type** | Fuel, Repair, Toll, Scale, Lumper, Wash, Parking, Other. Pick the closest match. |
| **Amount** | The dollar amount. No currency symbol needed. |
| **Date** | Defaults to today. Change if logging an older expense. |
| **Vendor** | Where you paid (Loves, Pilot, the receiver's lumper service, etc.). |
| **Description** | Short note — useful for unusual expenses. |
| **Load ID** | Which load this expense is associated with. Defaults to your current load if any. |
| **Gallons** (fuel only) | How many gallons you bought. |
| **Odometer** (fuel only) | Truck odometer reading. |
| **Photo** | A picture of the receipt. |

Tap **Save.** The expense appears in your list with status **Pending** until an admin reviews it.

## Using the photo + AI

This is the trick that saves you typing. Instead of filling in the form by hand:

1. Tap **Add Expense.**
2. Tap **Take photo of receipt** (or the camera icon at the top of the form).
3. Photograph the receipt.
4. **Wait a few seconds** while the app's AI reads the receipt.
5. **Fields auto-fill** — amount, date, vendor, and (for fuel) gallons and odometer.
6. **Review the values.** The AI is usually right but not perfect. Fix anything wrong.
7. **Pick the type** if it wasn't detected correctly.
8. Tap **Save.**

The OCR works best on:

- Clear, well-lit photos.
- Receipts that aren't crumpled.
- Receipts where the printing is dark and readable (older thermal receipts that have faded are hard).

If the AI reads it wrong, just edit the field. The auto-fill is a convenience, not a requirement — you can also tap **Skip AI** and fill the form manually.

## Photographing receipts

The OCR is forgiving but not magical. To help it:

- **Flat on a surface.** Don't hold the receipt in mid-air.
- **Good lighting.** Fluorescent dome light at a truck stop is fine. Direct sun causes glare.
- **The whole receipt.** Including the total and the date.
- **Right-side up.** The AI can handle some rotation, but a perfectly oriented photo is more reliable.

If the receipt is two pages (some longer fuel receipts are), photograph the total page. The line items page is nice-to-have but the total is what matters.

## Fuel receipts have extra fields

Fuel is the most-logged expense and it has two extra fields:

- **Gallons** — the volume you bought.
- **Odometer** — the truck's odometer reading at the time of fueling.

Both are used for fleet MPG analytics. Logging them means the company can spot trucks burning fuel faster than expected (often a sign of a maintenance issue) or drivers who fuel suspiciously often (often a sign of a problem worth investigating).

You don't have to be perfect. **Within 10 gallons is fine for the gallons field; within 100 miles is fine for the odometer.** The point is the trend over time, not the individual data point.

## After you save

Your expense appears in your **Expenses** list with a status of **Pending.** From there:

- **Admin reviews** — usually within a day or two.
- **Approved** — the expense is counted toward your reimbursement.
- **Rejected** — admin will message you with a reason. Common reasons: missing photo, wrong load ID, expense that's not actually reimbursable.

You can see the status of all your expenses on the same list. **Approved** expenses show a green checkmark; **Rejected** show red.

## What you cannot do

- **Delete an expense** after submitting it. If you logged something by mistake, ask dispatch to reject it. The rejection records the mistake clearly.
- **Edit a submitted expense.** Same workflow — ask dispatch to reject it, then submit a corrected one.

These limitations are intentional. Once an expense is in the system, it has an audit trail. Edits and deletes would muddy the trail.

## Cash vs. card

It doesn't matter how you paid — log it the same way. Cash payments still need a receipt (or, in a pinch, a short description of what was paid and why).

If you paid with a company fuel card, log it anyway — the company already sees the card transaction, but your log links it to the specific load. Without the link, the expense doesn't get matched to the right load's profitability calculation.

## When you didn't get a receipt

It happens — automatic toll booths, some lumpers, lost receipts. Log it anyway:

- **Type:** the closest match.
- **Amount:** what you paid (be honest).
- **Description:** something like "automatic toll, no receipt issued."
- **Photo:** skip.

Admin may follow up to confirm. As long as it's reasonable and clearly logged, it usually gets approved.

## Tips

- **Log expenses at the truck stop, not at the end of the day.** A 30-second log right after fueling is easy. Reconstructing a full day from a fistful of receipts at 9 PM is miserable.
- **Photograph in landscape, not portrait, for long receipts.** Better aspect ratio.
- **Tap into the Load ID field.** If your current load is selected, you don't have to type. If you're logging an expense for a previous load, the dropdown shows recent loads.
- **Don't double-log.** If you've already logged a fuel stop and you check the list later, don't add it again. The list shows all your pending and approved expenses.
- **Receipts faded?** Some thermal receipts fade in heat. Photograph fresh.

Now, on to messaging dispatch — the lifeline.
