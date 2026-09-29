# Investor Applications

When someone applies to invest in the LogisX fleet, their application arrives on the Investor Applications screen. This chapter covers reviewing investor applications and orchestrating their onboarding through the signed-documents flow.

## Where investor applications come from

The public investor application form lives at `app.logisx.com/invest`. It's a multi-step wizard with conditional fields. Anyone with the URL can apply — no account required. Rate-limited at 10 submissions per 15 minutes per IP.

Each submission creates a row in the `investor_applications` table.

## Payment terms invites

Plain `/invest` always produces the standard contract: a 50/50 profit split. When an investor has agreed different terms, send them a **personal invitation link** instead.

- **Create one.** Sidebar → **Investors** → the invitations panel. Enter the investor's name (the email is optional) and choose the payment type: a **50/50 profit split** or a **fixed monthly lease payment** ($1.00 to $100,000.00 a month). **Additional terms** (up to 2,000 characters, 30 lines, Latin script, no emoji) are printed word for word in the contract.
- **Copy the link when it is shown.** It appears once, in a dialog with a Copy button, and is never shown again. It works for 30 days and for one submission.
- **What the investor signs.** Their Master Participation & Management Agreement and Commercial Vehicle Lease Agreement print an **Amendment No. 1 — Payment Terms** just above the signatures, with the payment type, the monthly amount for a lease, and the additional terms ("None" when there are none). For a lease, master §3.3 and lease §2.01 name the fixed monthly payment in place of the 50/50 split. A 50/50 split with no additional terms is the standard contract, with no amendment. Use **Preview** to see either document with the invite's terms before sending the link.
- **Edit before it is used.** Changing the terms moves the invite to a new terms revision. An investor who already has the link open is shown the new terms and must sign the agreements again; one who submits against the old terms is asked to review them first.
- **Reissue** gives the same invite a new link and a fresh 30 days; the old link stops working at once. **Revoke** withdraws it (an optional reason is recorded). A used invite is locked: it can be neither edited, reissued nor revoked.
- **After submission.** The Investor Applications list shows each application's terms in its **Terms** column, and the application's detail has a **Payment Terms** section. On the Investors page, an investor's detail shows the terms they signed, read-only: signed contracts never change.

> ⚠️ **These terms change the contract only.** Payouts, statements and the investor dashboard are still calculated from the investor's **Split %** on the Investors page. For an investor on a fixed monthly lease, settle the payment accordingly — the app does not compute it.

## Opening Investor Applications

Sidebar → **Investor Applications**. List of pending applications with:

- Name (individual or company).
- Submission date.
- Status — Pending, Approved, Rejected.
- Investment intent (amount, target truck count).

## Reading an application

Click into an application for the full detail. Sections:

**Personal or company information:**
- If individual: full name, contact, DOB.
- If company: company name, primary contact, role in company.

**Investment intent:**
- Capital amount to deploy.
- Target number of trucks.
- Timeline.
- Goals (passive return, fleet building, semi-active management).

**Funding source:**
- Source of capital (savings, business cash, financing, etc.).
- Confirmation of legitimate funds.

**Legal acknowledgment:**
- The applicant confirms they've reviewed the high-level terms of the Master Participation Agreement.
- Not a final signature — that comes during onboarding.

**References:**
- Optional. Bankers, accountants, attorneys, business partners.

## What to look for

**Capital fit.**
- Does the stated capital match what LogisX needs and absorbs?
- Is the deployment timeline realistic?

**Source legitimacy.**
- Funded by legitimate means? Some carriers have AML compliance requirements.
- Documented (bank statements, etc.) — usually verified later in onboarding, but flag early concerns.

**Engagement level.**
- Passive investor expecting hands-off returns? Fine.
- Wants to be heavily involved in daily ops? May not fit.

**Industry experience.**
- Trucking experience is a plus but not required.
- Business management experience matters more.

**References.**
- If provided, are they credible (banker, accountant, attorney)?
- Worth a call before approving.

## Talking to the applicant

Most investor approvals involve a phone call before deciding. The application is starting context; the call is where you confirm alignment.

Things to cover:

- **What returns are they expecting?** Set realistic expectations.
- **How involved do they want to be?** Day-to-day vs. quarterly updates.
- **Have they read the management agreement?** It's a 30+ page legal document; serious applicants will have at least skimmed it.
- **What's their exit plan?** Trucks aren't liquid investments. Make sure they understand.

Conversations like this usually filter the serious from the merely curious.

## Approving an application

Click **Approve**. The system:

1. Marks the application Approved.
2. Creates an investor record in the `investors` table.
3. Creates a user account with role Investor.
4. Links the user's `company_name` to the carrier name.
5. Initiates the investor onboarding flow.

Before approving, verify the names and emails are correct.

## The investor onboarding flow

Investor onboarding is different from driver onboarding. Where a driver signs internal policy documents, an investor signs the legal documents that govern their relationship with LogisX:

1. **Master Participation & Management Agreement** — the umbrella contract covering profit-sharing, management responsibilities, dispute resolution. The investor signs in their capacity as the truck owner.

2. **Vehicle Lease Agreement** — separately, one per truck. Documents that the investor (as Lessor) leases their truck to LogisX (as Lessee) for operation.

3. **W-9 Form** — tax form. The investor's TIN goes on this for 1099 issuance.

4. **Exhibit A documents** — vehicle specifications, one per truck. If the investor owns multiple trucks, the system generates multiple Exhibit A pages.

The investor signs each document electronically through the onboarding portal. Each signature generates a permanent signed PDF stored in their Documents portal.

You orchestrate this from your side:

- **Initiate the documents** — the system does this automatically on approval, but you may need to verify they appeared.
- **Watch progress** — investor signs documents one at a time; you can see who signed what and when.
- **Handle questions** — investors often ask about specific clauses. You can answer most, or escalate to legal counsel for the tricky ones.
- **Verify banking info** — they enter payment info during onboarding for direct deposit of distributions.

When all documents are signed, the investor's dashboard activates and they begin seeing earnings on their fleet.

## Adding trucks to an investor's fleet

After approval, you'll typically attach one or more trucks to the new investor. The flow:

1. **Trucks page** → find or create the truck.
2. **Set Owner ID** to the new investor's record ID.
3. **Save.**

Now any loads run on this truck count toward the investor's earnings.

The investor sees the truck in their Fleet Breakdown section.

## Multiple trucks

Investors with multiple trucks get multiple Exhibit A pages in their signed Master Agreement. The system clones the Exhibit A template per truck when rendering the signed PDF.

If you add a truck after the investor has signed their Master Agreement, the existing signed agreement doesn't auto-update — it represents what was signed at that time. Subsequent truck additions are handled via a separate Vehicle Lease for each new truck.

## Rejecting an application

Click **Reject**. Note the reason internally.

Common rejection reasons:

- **Inadequate capital.** They wanted to invest $5K but the minimum is $50K.
- **Source of funds unclear.** Couldn't verify legitimacy.
- **Misaligned expectations.** Wants daily operational control we don't offer.
- **Reference check failed.** Bad signal from a stated reference.

Notify the applicant by email (manually — there's no auto-rejection email). Keep the tone professional and brief.

## When the investor disappears

If an approved investor doesn't sign any documents within a couple weeks:

1. Call them. Are they still interested?
2. If yes, walk them through the onboarding steps.
3. If no, demote their account or remove it. Clear the truck attribution.

Stale onboarding state is messy. Don't let it sit.

## Coordinating with the truck purchase

In the typical workflow, the investor signs documents around the same time they're purchasing a truck (either directly or through LogisX). The sequence matters:

1. **Application** approved.
2. **Master Agreement** signed.
3. **Funds wired** to the appropriate account.
4. **Truck purchased** — paperwork in the investor's name (or LLC).
5. **Vehicle Lease** signed for that specific truck.
6. **Truck added to LogisX** with the investor as Owner ID.
7. **First load** runs.
8. **First earnings** show on dashboard.

Each of these is a real-world step happening outside the app. Your job is to coordinate the LogisX side and verify each happens in turn.

## Reading the investor dashboard from your side

You can view any investor's dashboard as if you were them — sidebar → Investors → click an investor → "View Dashboard" (the exact label may vary).

This is useful when:

- An investor has a question about their numbers. You see what they see.
- Verifying the dashboard looks right before activating an investor.
- Generating a report on the investor's behalf.

Their dashboard is read-only for them but you can act on data behind it.

## Pro tips

- **Don't approve and forget.** New investors need active onboarding orchestration. Set a calendar reminder if they go quiet.
- **Use the phone, not email.** Investor relationships are higher-touch than driver relationships. Call.
- **Send the Investor Guide PDF early.** Set their expectations for what they'll see on their dashboard.
- **Document odd cases.** If you bent a rule for a specific investor (lower minimum, custom split), note it in their record. Future-you needs the context.
