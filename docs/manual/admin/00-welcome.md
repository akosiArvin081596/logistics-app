# Welcome

Super Admin is the top of the access hierarchy at LogisX. You can do everything a dispatcher can do, plus everything that touches users, applications, money, financials, and data integrity. This guide is the complete reference for the things only you can do.

## What Super Admin uniquely manages

The dispatcher runs daily operations — assigning loads, tracking trucks, communicating with drivers. You handle the strategic and structural layer:

- **Users.** Adding, removing, role changes. Anyone who can sign in to LogisX is in your purview.
- **Applications.** Driver applications and investor applications both flow to you for review and decision.
- **Onboarding.** After approval, you orchestrate the onboarding flow (document signing, drug test, FMCSA, training).
- **Invoices.** Weekly invoices are auto-generated; you approve before payment.
- **Financials.** The company P&L, per-truck profitability, expense breakdowns — your view.
- **Data integrity.** Duplicate scans, driver name fixes, orphan cleanup — your tools.
- **Cancellations and soft-deletes.** Loads that need to disappear from active views are your responsibility (per a 2026-04-19 client decision, dispatchers don't have cancel rights).
- **Audit trail.** Reviewing system-wide actions.
- **Archive.** Read access to historical data.

You're not just a dispatcher with more buttons. The Super Admin role is different in kind, not just degree.

## What this guide covers

The chapters that follow walk through each domain:

- Getting started and quick reference.
- User management — creating, editing, deleting accounts.
- Driver applications — review, approval, onboarding triggering.
- Investor applications — same plus the investor-specific onboarding flow.
- Invoice approvals — what to check before approving.
- Financials — reading the P&L, exporting, troubleshooting numbers.
- Data Manager — direct sheet editing, with appropriate caution.
- Admin Tools — data integrity scanners and one-shot fixes.
- Load management — cancellation, soft-deletion, restoration.
- Archive — historical data access.
- Audit trail — accountability.
- Best practices, troubleshooting, and FAQ.

## What this guide doesn't cover

- **Dispatcher-level operations** (assigning loads, real-time tracking) are in the Dispatcher Guide. You can do all of it; the workflow is the same.
- **Driver-level operations** (POD upload, expense logging) are in the Driver Guide.
- **Technical documentation** (server architecture, API, database) is in the Technical Documentation PDF.

If you find yourself doing dispatcher work for an extended period (covering shifts, hands-on with assignments), the Dispatcher Guide is your reference for that.

## A note on power

Super Admin has access to delete, modify, and override almost any data in the system. With that comes responsibility:

- **A wrong click can lose data.** Soft-deletes are reversible; hard deletes typically aren't.
- **Edits to historical records can change the audit trail.** Don't rewrite history without good reason.
- **Financial decisions affect drivers and investors directly.** A wrong invoice approval means someone gets paid wrong.
- **User role changes affect access immediately.** Demoting someone in error loses their work mid-task.

Use the tools deliberately. When in doubt, consult leadership before acting.

## A note on accountability

Every Super Admin action is logged in the **audit_trail** SQLite table. The system records:

- What action was taken.
- Who took it (your user ID).
- When it happened.
- What was changed (before/after where applicable).

This isn't to police you — it's to ensure transparency. If a question arises later ("who deleted that user?", "who approved that invoice?"), the answer is in the system. Be the Super Admin you'd want auditing your own work.

## A note on supporting roles

Other people will be looking to you for support:

- **Dispatchers** when they hit a permission boundary (cancellation, financial questions).
- **Drivers** when they have an issue dispatcher can't resolve.
- **Investors** when they have a question about their dashboard or earnings.
- **Leadership** when they want operational metrics.

Some of this is dispatcher work; some is your unique work. The skill is knowing when to absorb a question vs. when to redirect.

Let's get into the details.
