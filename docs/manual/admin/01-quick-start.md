# Quick Start

What you'll see when you sign in, the menu structure, and how a typical week flows.

## Signing in

Go to `app.logisx.com`. Sign in with your Super Admin credentials. You land on the operations dashboard at `/dashboard` — the same view as a dispatcher, with additional sidebar items available.

## The full sidebar

Super Admin sees the most expansive sidebar:

| Item | What it's for |
|---|---|
| **Dashboard** | Operations view (Job Board, Active Loads, Completed, Fleet). |
| **Tracking** | Live truck map. |
| **Expenses** | Driver expense submissions — you can approve/reject. |
| **Invoices** | Weekly invoices — your approval action. |
| **Messages** | Chat with drivers. |
| **Notifications** | System-generated alerts feed. |
| **Users** | Account management. |
| **Drivers** | The drivers directory (carrier database). |
| **Trucks** | Fleet inventory — full edit access. |
| **Trailers** | Trailer inventory. |
| **Investors** | Investor records. |
| **Applications** | Driver applications — review and decide. |
| **Investor Applications** | Investor applications — review and decide. |
| **Data Manager** | Direct Google Sheets editor. |
| **Admin Tools** | Data integrity scanners, batch fixes. |
| **Admin → Financials** | Company P&L. |
| **Archive** | Historical archived data, read-only. |

That's roughly 17 destinations. Most days you'll touch 5-6.

## A typical week

**Monday morning:**
- Quick dashboard glance.
- Review any weekend applications (Applications, Investor Applications).
- Check the Notifications feed for weekend events.

**Daily:**
- Spot-check expenses — approve clear submissions, message ambiguous ones.
- Respond to escalations from dispatchers (cancellations, unusual situations).
- Field investor questions if any.

**Mid-week:**
- Quick financials check. Are revenue and expenses tracking expected?
- Any audit-worthy events (unusual deletes, late nights of activity).

**End of week / payroll day:**
- Review the week's invoices. Approve.
- Handle any pay disputes from drivers.
- Coordinate with bookkeeping for actual disbursement.

**Periodically:**
- Run Admin Tools scanners (duplicates, mismatches, orphans).
- Audit trail review.
- Fix any data-quality issues that have accumulated.

## What's different from dispatcher view

You see everything a dispatcher sees, plus:

- **Financials tab** in the sidebar.
- **Approve/Reject buttons** on expenses, applications, invoices.
- **Cancel/Delete actions** on loads.
- **Edit access** to user accounts and truck records.
- **Data Manager** and **Admin Tools** access.
- **Archive** access.

Some screens show additional fields when you visit them as Super Admin. For example, the Trucks page shows Owner ID and lets you edit it; dispatchers see Owner ID but can't edit it.

## Keyboard shortcuts (none yet)

The UI doesn't have keyboard shortcuts. You'll use the mouse/touchscreen for everything.

## Search

Most lists have a search bar. Common uses:

- **Users** — search by username, full name, or company.
- **Loads** (anywhere) — search by Load ID, driver, broker, city.
- **Applications** — search by name.

## How real-time updates work

The dashboard updates automatically when:

- A new load arrives or is acted on.
- A driver responds to an assignment.
- A driver reports GPS.
- A driver uploads a POD.
- A driver submits an expense.
- A driver sends a message.

You don't need to refresh. If you're not seeing something you expect, refresh manually — but in 99% of cases the screen is already current.

## Click anywhere to drill in

Almost everything is clickable. The general rule: if it shows a value, you can click it to see more or do something with it.

## A daily glance routine

A 10-minute routine that catches most issues:

1. **Dashboard KPIs** — anything looking unusual? Active loads spike or drop? Trucks idle that shouldn't be?
2. **Notifications** — anything that needs immediate attention?
3. **Applications** — any new ones waiting?
4. **Expenses** — any new submissions to approve?
5. **Invoices** — anything pending approval near payroll?
6. **Messages from dispatchers** — any escalations?

That's it. Most of your time is the work that flows from that initial scan.

## What to escalate (yes, you can escalate too)

Some things are outside the Super Admin scope:

- **Technical bugs** (server errors, data corruption, login failures across the board) — escalate to technical support.
- **Legal questions** (lease terms, regulatory compliance, audits) — to leadership and legal counsel.
- **Major financial decisions** (capital expenditures, large investor exits, new contract negotiations) — to leadership and finance.
- **Personnel decisions** (hiring, firing, disciplinary action) — to HR and leadership.

Super Admin handles operational and data-integrity decisions. Strategic decisions still flow up.

## A note on speed

Don't rush Super Admin actions. The dispatcher world is fast — you need to respond in minutes. Super Admin work is slower:

- Approving an invoice with $5,000 of pay should take more than 30 seconds.
- Approving an application should involve reading the application, not just clicking through.
- Edits to user roles should be considered, not impulsive.

Take the time. The system rewards careful work.

## A note on transparency

Super Admin actions are logged. If you're unsure whether to do something, ask. If you're sure, document why. The audit trail captures what you did; your notes capture why.

Examples of transparency:

- **Rejecting an expense** — add a clear reason in the note (driver will see it).
- **Cancelling a load** — note why (broker cancellation, force majeure, etc.) in the load's history.
- **Demoting a user** — note the reason in the user's record or audit trail.

Future-you will thank present-you for the notes.

Let's dig into the specific areas.
