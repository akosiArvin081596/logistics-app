# Getting Paid

This chapter is the part you actually care about. How LogisX calculates your pay, what your weekly invoice looks like, when you get paid, and what to do if something looks wrong.

## The pay structure

LogisX uses one of two pay structures, depending on how you're set up:

### Daily rate (most company drivers)

You get paid a **flat daily rate** for every calendar day you were active on a load.

- The default rate is **$250 per active day** (this may be different for you — check your contractor agreement).
- An "active day" is any calendar day you spent some portion of on a load.
- **Multi-day loads count every day they span.** A pickup on Monday and delivery on Wednesday is **3 active days** ($750), not 1.
- **Multiple loads on the same day count as 1 day.** Three short hops on Thursday is **1 active day** ($250).
- The system **deduplicates** so you can't double-count a day.

In math:

```
Driver Pay for the week =
  $250 × (number of unique calendar days you were active on any load)
```

### Owner-operator (percentage of revenue)

If you're an owner-operator, you get a **percentage of the load's revenue** rather than a daily rate.

- Typical splits are **70% to driver / 30% to company** but yours may differ — check your contract.
- The percentage is calculated on **gross revenue** of the load.
- This includes the line haul rate but generally excludes fuel surcharge and accessorials (your contract spells out exactly what's in the calculation).

In math:

```
Driver Pay for the week =
  Σ (load_revenue × your_percentage) for every load delivered in the period
```

Your administrator told you which structure applies to you during onboarding. If you don't remember, check your contractor agreement or ask.

## The weekly invoice

Once a week, the system generates an invoice for you covering the past period (typically Sunday-to-Saturday or Monday-to-Sunday, depending on your company's convention).

To see it: **Kit** tab → **Invoices.** You'll see a list of invoices ordered newest first.

Each invoice shows:

- **The period covered** (e.g., "Apr 14 - Apr 20, 2026").
- **The loads included** — Load ID, pickup city, dropoff city, dates.
- **Active days** (daily rate) or **revenue and percentage** (owner-op).
- **Base pay** before any adjustments.
- **Adjustments** — additions or subtractions for unusual circumstances.
- **Total** — what you'll be paid.
- **Status** — Pending, Submitted, Approved, Paid.

You can **download the invoice as a PDF** for your records. Most drivers keep these for tax season.

## Invoice statuses

The lifecycle:

```
Pending → Submitted → Approved → Paid
```

- **Pending** — the system generated the invoice. You should review it.
- **Submitted** — you've submitted it for approval (some workflows have you do this; others auto-submit).
- **Approved** — admin reviewed and approved. Payment will be processed.
- **Paid** — payment has been initiated to your bank.

The payment itself goes through your company's payroll/AP process. The LogisX app shows "Paid" once admin marks it; the actual money lands in your bank a day or two later depending on the bank.

## When you get paid

Standard cadence is **weekly,** with payment landing in your bank account on a fixed day of the week (often Friday for work performed through the prior Sunday). Your administrator told you the specific schedule during onboarding.

If you don't see a payment by the expected day, **message dispatch first.** They can check the invoice status. If it's still "Approved" rather than "Paid," the payment hasn't been processed yet.

## What to do if your invoice looks wrong

Three common things to verify before you complain:

1. **Are all your loads from the period there?** If you remember running a load that's missing, the load may not be attributed to you in the system. Check the load's driver name field; ask dispatch to fix if it's wrong.

2. **Are the dates correct?** For daily-rate pay, an incorrect pickup or dropoff date can mean a multi-day load is counted as fewer days. The dates need to match the actual pickup-to-delivery span.

3. **Are the rates correct?** For owner-op, the rate per load comes from the original rate confirmation. If the rate in the system doesn't match what was agreed, ask dispatch — there may have been a typo on entry.

To raise an issue:

1. **Open the invoice** and screenshot the parts that look wrong.
2. **Message dispatch** with: the invoice number, the specific load(s) involved, and what you think is wrong.
3. **Be specific.** "My invoice is wrong" is hard to act on. "Invoice #INV-2026-15 is missing load LD-3492 from Tuesday" is easy.

Admin will investigate and either correct the invoice or explain why it's calculated the way it is.

## Adjustments

Sometimes an invoice has an adjustment — an addition or subtraction outside the normal load-based calculation. Common reasons:

- **Bonus** — exceptional service, on-time delivery streak, etc.
- **Deduction** — fines paid by the company that the contract assigns to the driver, equipment damage, etc.
- **Layover pay** — being stuck at a dock for an extended wait.
- **Detention pay** — receiver kept you over the loading allowance.
- **Per diem** — daily meal allowance (different rules per company).

Adjustments are at the discretion of admin. They typically come with a note explaining why. If you see one and you're not sure what it's for, ask.

## Direct deposit setup

Your direct deposit information was set up during onboarding (you entered routing and account numbers on the Independent Contractor Agreement). To change it:

- Don't change it in the app yourself.
- **Notify your administrator** in writing — usually email — with the new banking info.
- Admin will update it in the system.

This is intentional. Changing your direct deposit is a security-sensitive operation; the company wants a paper trail before it happens.

## Tax forms

At the end of the year, you'll receive a **1099-NEC** (if you're an independent contractor) or **W-2** (if you're a company employee). The form summarizes your annual earnings for the IRS.

- **1099-NEC contractors** — no taxes are withheld. You're responsible for paying quarterly estimated taxes. Set aside ~25-30% of every payment for the IRS.
- **W-2 employees** — taxes are withheld from each payment.

Talk to a tax pro if you're unsure which applies. For drivers especially, deductions for fuel, meals, lodging, etc. can significantly reduce your taxable income, but only if you keep records.

## Keeping good records

A few things you should keep yourself, regardless of what the app tracks:

- **PDF copies of every weekly invoice.** Download from the app. Keep in a folder by year.
- **Personal expense receipts** — meals, lodging, anything not reimbursed by the company that you can deduct on your taxes.
- **Personal mileage log** — if you drive your own car between truck and home, you may be able to deduct.
- **Per diem records** — if you took per diem, keep day counts.

LogisX tracks what you got paid for and reimbursed for. It doesn't track your personal tax situation. That's on you.

## Pay disputes — escalation

If you've messaged dispatch about a pay issue and the response is "no, that's how it's calculated," but you still think it's wrong:

1. **Re-read your contract** carefully. The pay terms are spelled out and they're binding.
2. **Talk to your administrator** by phone, not just message. Voice resolves things faster than text on financial questions.
3. **If you're still not satisfied,** escalate to LogisX leadership. The CEO is Deshorn King; operations leadership has contact info on file.

In years of operation, the vast majority of pay disputes turn out to be either (a) a misunderstanding about the pay formula or (b) a data entry error that admin gladly fixes. The system is designed to be transparent — every load, every day, every adjustment is on the invoice. If you can point to a specific discrepancy, it gets resolved.
