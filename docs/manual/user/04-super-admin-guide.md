# Super Admin Guide

Super Admin is the top of the access hierarchy. You can do everything a dispatcher can do, plus everything that touches money, users, applications, financials, and data integrity. This chapter focuses on those Super-Admin-only responsibilities — for daily dispatch work, see the Dispatcher Guide.

## What you uniquely manage

| Area | Why it's Super Admin only |
|---|---|
| Users | Adding, removing, and changing account roles touches access control. |
| Applications | Hiring drivers and approving investors are commitments only leadership should make. |
| Investor records | Tied to financial agreements and ownership stakes. |
| Drivers directory | The carrier database that financials and revenue attribution depend on. |
| Trucks & trailers | Fleet assets — additions, removals, and assignments. |
| Invoices | Approval flows are an audit-relevant moment. |
| Financials | The company P&L; not for general visibility. |
| Data Manager & Admin Tools | Direct sheet edits and data-integrity scans. |
| Archive | Historical records, mostly for reference. |

## Managing users

Open **Users** in the sidebar. You'll see every user account with their role, the company they're associated with (for Investors), and the driver record they're linked to (for Drivers).

To add a user:

1. Tap **Add User**.
2. Pick a **Role** (Super Admin, Dispatcher, Driver, Investor).
3. Fill in **Username** (used to sign in) and a **Password** (the user changes it after first sign-in).
4. For Drivers: pick the corresponding **Driver** record from the drivers directory so the user account links to their dispatch identity.
5. For Investors: pick the **Carrier Name** the investor will own — this controls which loads count toward their earnings.

Save. The user can now sign in with the username and password you set.

To **change a user's role**, open their row, edit, and save. Changing a role triggers a sign-out — the user must sign in again, and the next session reflects the new permissions.

To **reset a password**, open the user and use the **Reset Password** action. You set the new temporary password and share it with the user.

To **delete a user**, use the row's **Delete** action. The user can no longer sign in; their historical activity (loads they ran, expenses they logged) remains in the data.

## Reviewing driver applications

Open **Applications** in the sidebar. Each row is a pending driver application submitted via the public form. Click into one to see:

- Personal info (name, address, contact).
- Driving history (years experience, accidents, violations).
- Certifications (CDL class, endorsements, medical card).
- References.
- Prior employment.

Action buttons:

- **Approve** — creates a driver record, creates a user account, sends a welcome email with sign-in instructions, and triggers the onboarding flow on the driver's side.
- **Reject** — marks the application closed.
- **Download PDF** — a clean PDF of the full application (useful for records or printing for offline review).

> **Tip.** Before approving, review the references and the carrier database to check for prior employment. The **Drivers** screen has every driver we've worked with, including historical carrier moves.

## Reviewing investor applications

Open **Investor Applications**. Investor applications come from the public investor wizard at `/invest`. Each shows:

- Personal or company information.
- Investment intent (how much capital, target truck count).
- Funding source.
- References.

Approve to create an investor record, then walk them through the onboarding flow (master agreement, vehicle lease, W-9). The investor signs each document electronically from their side; signed PDFs land in their permanent documents portal.

Once onboarding completes, the investor's dashboard activates and they start seeing earnings for the truck(s) they fund.

## Approving invoices

Open **Invoices**. Each week's invoices are auto-generated from active loads and driver pay rules. Each invoice shows:

- The driver.
- The week covered.
- The loads included.
- Driver pay (calculated per the pay_type — daily rate or percentage of revenue).
- Adjustments, if any.
- Total.

A submitted invoice is **Pending Approval** until you act on it. Open it, review, then:

- **Approve** — the invoice is marked paid (or scheduled for payment, depending on your downstream payment process).
- **Reject** — back to the driver/dispatcher to correct.

Approved invoices generate a final PDF for the driver's records.

## The financials dashboard

Open **Admin → Financials**. This is the company P&L view, Super Admin only.

You'll see:

- **Revenue** — broken down by month, by truck, by driver.
- **Expenses** — fuel, repairs, fixed costs (insurance, ELD, IRP, HVUT), driver pay.
- **Net profit** — per month and cumulative.
- **Per-truck profitability** — which trucks are paying off and which aren't.

The numbers exclude cancelled and soft-deleted loads — the same exclusion rule that applies to the dispatcher dashboard and the investor dashboard, so all three views agree on what counts as a live load.

Revenue is recognized in the month a load is **assigned**, not the month it's delivered. This matches how the dispatcher dashboard reports revenue, so monthly totals line up across views.

## Data Manager

Open **Data Manager** in the sidebar. This is a direct editor for the underlying Google Sheets — every tab, every row, every column. Useful for:

- Correcting a typo in a column that doesn't have a dedicated UI.
- Backfilling a column for old rows.
- Inspecting raw values when something looks off elsewhere.

**Use carefully.** A row edit here writes directly to the production sheet. There's no undo. If you're going to make a sweeping change, consider running it during low-traffic hours, and have the **Archive** screen open as a reference point.

## Admin Tools

Open **Admin → Tools**. This screen has several data-integrity scanners:

- **Scan duplicates** — finds rows with the same Load ID in the sheet. Lets you pick the canonical row and remove the others.
- **Scan driver mismatches** — finds loads where the driver name doesn't match anything in the drivers directory (often a typo).
- **Scan orphans** — finds records that point to nothing (e.g., a load assigned to a deleted driver).
- **Scan stale locations** — finds drivers whose GPS hasn't updated in a long time.
- **Fix driver name** — rename a driver across every sheet that references them, in one operation.

Run these periodically — say, once a week — to keep the data clean.

## Soft-deleting a load

Sometimes a load needs to disappear from every active view without removing it from the sheet for audit reasons. From **Active Loads** (or the Data Manager), find the load and use the **Delete** action. Super Admin only.

The load:

- Stays visible in the Google Sheet for record-keeping.
- Is filtered out of the dashboard, financials, and investor dashboard.
- Can be restored by removing its row from the `deleted_loads` table (a developer task — ask technical support if needed).

## Cancelling a load

Cancelling is different from deleting. A cancelled load:

- Has its status set to **Cancelled**.
- Drops out of every revenue calculation via the standard exclusion logic.
- Is still visible on the dashboard (in the Completed or All Loads tabs depending on filters) so the cancellation is auditable.

Per a 2026-04-19 client decision, only Super Admins can cancel a load. Dispatchers who need a load undone should escalate to a Super Admin or, for a simple swap, use the driver reassignment dropdown.

## The archive

Open **Archive**. This is a read-only window into the historical archive spreadsheet — loads, drivers, and other data that predate the current production sheet. Useful when you need to look up a long-completed load that no longer appears in the dispatcher dashboard.

Edits to the archive are not supported through the UI; it's view-only.

## Common situations

**"I approved an application but the new user can't sign in."** Check that the welcome email arrived — sometimes it lands in spam. If the user has the credentials but still can't sign in, reset their password from Users.

**"An invoice has the wrong driver pay total."** Check the load dates the invoice covers and the driver's pay_type. Owner-operator pay is a percentage of revenue; standard driver pay is daily. If the math looks off, it usually means a load was attributed wrong — fix the load's driver assignment in Data Manager and re-generate the invoice.

**"Financials don't match what I expect."** Verify the `excludeDroppedLoads` filter — cancelled and soft-deleted loads are excluded. If a load was cancelled in error, restore its status and the numbers update.

**"A scan-duplicate result has loads I want to keep distinct."** The dedup default keeps the bottom-most (most recent) row. If two rows are genuinely distinct loads with the same ID, that's a data-entry mistake — re-key one of them with a unique ID before letting the deduper run.

**"An investor says their earnings dashboard is wrong."** Check three things in order: (1) the investor's user account's company_name matches the carrier name on their drivers' records; (2) the Owner ID column on the relevant loads matches the investor; (3) no relevant loads are accidentally cancelled or soft-deleted.
