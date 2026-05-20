# Frequently Asked Questions

## Authority and access

**Q. What can Super Admin do that Dispatchers can't?**
Approve invoices, approve/reject expenses, approve/reject applications, cancel loads, soft-delete loads, manage user accounts, see the company financials dashboard, edit truck records fully, access Data Manager and Admin Tools, view the archive, view the audit trail.

**Q. Can I demote myself to Dispatcher?**
Yes — you can change your own role. But then you can't change it back without another Super Admin's help. Don't do this casually.

**Q. Are there multiple Super Admins?**
Typically yes — companies usually have at least two for redundancy. Check the Users page for the current count.

**Q. Do I need 2FA?**
LogisX doesn't currently require 2FA. If your company adopts it, it would be added system-wide.

## User management

**Q. What happens when I delete a user?**
They can no longer sign in. Their historical activity (messages, status updates, etc.) remains. To restore, recreate the user with the same username; history reconnects.

**Q. Can I change a username?**
Edit the user record. Note: this can break historical connections if the old username is referenced elsewhere. Usually safer to delete and recreate with the new username.

**Q. Why does the system force re-login after a role change?**
Sessions cache the role. Changing the role requires a fresh session to pick up the new permissions.

**Q. Can I have a user with no role?**
No. Every user has exactly one of the four roles.

## Applications

**Q. Can I approve an application provisionally?**
No formal "provisional" state. You can approve and then immediately start the onboarding process, which acts as a gating step (driver can't run loads until onboarding completes).

**Q. What if I rejected the wrong application?**
The application status changes to Rejected but the row remains. You can technically revert by changing the status back (via Data Manager), but the better workflow is to call the applicant and ask them to reapply.

**Q. Why don't approved applications create users automatically sometimes?**
Edge cases where the approval succeeded but the user creation failed silently. Re-run the user creation manually.

## Invoices

**Q. How are invoices generated?**
A scheduled background job runs weekly and creates an invoice per driver for the prior period. It includes all loads delivered in the period, calculates active days (for daily-rate) or revenue × percentage (for owner-op), and saves the invoice with status Pending.

**Q. Can I generate an invoice manually?**
Yes — the `POST /api/invoices/generate` endpoint. The UI may surface this as a button on the Invoices page.

**Q. Why is an invoice's pay type wrong?**
Check the driver's user record. The `pay_type` field is what the invoice generator uses. Edit if needed and regenerate.

**Q. Can I issue a corrective invoice for a past period?**
Yes. Generate a special invoice with adjustments to fix the prior period. Don't try to retroactively edit a Paid invoice.

## Financials

**Q. Why don't the financials match QuickBooks?**
LogisX shows operational P&L (revenue earned, expenses logged). QuickBooks shows cash flow (money in, money out). They use different timing.

**Q. Are the per-truck numbers accurate?**
Yes if the underlying data is right. Check Owner ID on loads, truck fixed costs, expense attribution.

**Q. How is revenue recognized?**
In the month the load was assigned (not delivered). Per a CEO decision. Matches how the dispatcher dashboard reports revenue.

**Q. Can I see year-over-year comparisons?**
Not in the built-in dashboard. Pull data from Job Tracking via Data Manager or Database Admin for custom analysis.

## Data Manager

**Q. Can I bulk-edit cells?**
Limited bulk via the Data Manager UI. For real bulk operations, edit directly in Google Sheets or use Database Admin SQL.

**Q. Will dispatchers see my Data Manager edits?**
Yes, in real time. Any edit affects the live dispatcher view.

**Q. Are there protected cells?**
The UI doesn't enforce protection at the cell level. Be careful.

**Q. Should I edit the archive sheet?**
Generally no. The archive is historical reference. Edits there can confuse audits.

## Admin Tools

**Q. How often should I run scanners?**
Weekly for duplicates and mismatches. Monthly for orphans. As-needed for everything else.

**Q. Can I run a custom scan?**
Not via Admin Tools. Use Database Admin SQL for custom queries.

**Q. Fix Driver Name didn't update all rows.**
Verify which tables are affected. The tool updates the main ones; obscure tables may need manual update. Escalate if you see gaps.

**Q. Is there an "undo" for Admin Tools actions?**
No native undo. Some actions (Fix Driver Name) can be reversed by running again with old and new swapped, but it's not automatic. Verify before clicking.

## Cancellation and deletion

**Q. Can I un-cancel a load?**
Yes. Change the status from `Cancelled` back to a valid earlier status.

**Q. Can I restore a soft-deleted load?**
Yes. Database Admin → `DELETE FROM deleted_loads WHERE load_id = '<id>'`.

**Q. Why can dispatchers not cancel?**
Per a 2026-04-19 client decision. The CEO wanted cancellation authority restricted to Super Admin to reduce accidental cancellations. Dispatchers escalate.

**Q. What if I need to hard-delete?**
Almost never. If you think you need to, ask: would soft-delete or cancel solve the same problem? Usually yes.

## Audit trail

**Q. How long is audit data kept?**
Indefinitely. There's no scheduled purge.

**Q. Can audit entries be deleted?**
Technically yes (someone with database access could). In practice, the audit trail is treated as append-only.

**Q. Do all admin actions log?**
Most do. A few less-frequent actions don't. Use the audit trail as your primary record but verify with the underlying data when something's important.

**Q. Are dispatcher actions in the audit trail?**
Some. Dispatcher actions that affect operational data (assignments, status updates) typically log to the relevant operational table (load_responses, status_logs sheet) rather than the audit_trail. Audit trail focuses on admin-significant changes.

## Investors

**Q. Can investors see each other's data?**
No. Each investor sees only their own fleet's performance.

**Q. Can investors message each other?**
No. Investor messaging is only with operations.

**Q. What if an investor wants to add a truck?**
Manual process: confirm the addition, sign new Vehicle Lease, register the truck in Trucks page with the investor as Owner ID.

**Q. What if an investor wants to exit?**
Outside the app. Coordinate with leadership and legal. Disable the investor's user account and reattribute their trucks (or sell them) when ready.

## Data integrity

**Q. The dashboard shows weird numbers — what do I check?**
1. Cancelled loads with wrong status spelling.
2. Wrong Owner ID on high-revenue loads.
3. Wrong load dates affecting active-day counts.
4. Excluded loads not actually excluded.
5. Recent Data Manager edits.

**Q. How do I know if a Routemate position is real or stale?**
The response from `/api/locations/latest` includes `source: 'routemate' | 'phone'` and a timestamp. Older than ~5 minutes for Routemate, ~2 hours for phone — treat as stale.

## Technical questions

**Q. Where is the production database?**
SQLite file at `/var/www/logistics-app/app.db` on the production VPS (76.13.22.110).

**Q. Where is the production Google Sheet?**
Spreadsheet ID `1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo` (NOT the archive at `1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI`).

**Q. Can I run scripts against production?**
Direct SSH to the VPS lets you run scripts. Be careful. The scripts directory includes utilities for password resets, geocode backfill, etc. Document any production script runs.

**Q. How do I back up the database?**
`GET /api/db/download` returns the SQLite file. Or `scp` it from the VPS directly. Schedule periodic backups.

**Q. What about backing up the Google Sheet?**
Google Sheets has native version history. For deeper backup, export to CSV periodically.

## Career and growth

**Q. Where can I learn more about LogisX architecture?**
The Technical Documentation PDF covers backend, frontend, integrations, deployment, and operations in detail.

**Q. Can I propose new features?**
Yes. Talk to leadership. Feature requests are welcomed.

**Q. Can I see source code?**
Internal source code access depends on your role. Ask leadership.

That's the standard list. Anything more specific, escalate to your operations lead or technical support.
