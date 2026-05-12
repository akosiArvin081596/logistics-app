# Troubleshooting

The most common Super Admin issues and how to resolve them.

## "I can't sign in."

Standard checks — caps lock, exact username spelling, recent password changes. After multiple failed attempts, wait 15 minutes for brute-force protection to reset.

If you've never been able to sign in (newly created account), have another Super Admin reset your password.

If you used to sign in but suddenly can't, the password was either changed or your account was disabled. Contact other Super Admins.

## "I see the dispatcher view, not the admin sidebar."

Your role may have been demoted. Check your profile or have another Super Admin verify. Re-elevate if appropriate.

## Application issues

**"A driver application is missing."** Check the Applications tab filter — make sure you're not filtered to only Approved or only Rejected. Search by name.

**"I approved an application but no user account was created."** Refresh the Applications screen and the Users screen. Sometimes the create lags by a few seconds. If still no account, look in the audit trail for the approval action — the creation may have failed silently. Recreate the user manually if needed.

**"The welcome email didn't arrive."** Two things to verify: the applicant's email is correct, and Gmail credentials (`GMAIL_USER` and `GMAIL_APP_PASSWORD`) are configured. Check the server logs for email errors.

## Invoice approval issues

**"The invoice math looks wrong."** Open the invoice detail. Check the loads listed, the dates, and the pay structure. The most common causes are wrong load dates (affecting active-day count) or wrong pay_type for the driver. Fix the underlying data and regenerate.

**"A load that should be on an invoice is missing."** Check the load's driver assignment in Data Manager — it may be attributed to the wrong driver. Or it may be cancelled. Or it may be still in progress.

**"A load that shouldn't be on an invoice is there."** Inverse — wrong attribution. Fix in Data Manager.

**"I approved an invoice but it doesn't show as Paid."** Approval and Payment are separate steps. Your team's payment processor (Bill.com, ACH, etc.) handles the actual disbursement. Once paid, someone needs to mark the invoice as Paid in the system.

## Financials issues

**"Revenue is lower than expected."** Common causes: a load was cancelled or soft-deleted that you didn't expect, an Owner ID is wrong on a high-revenue load, or the date attribution is off. Drill into specific loads to verify.

**"Expenses look high."** Filter the expenses list by date and category. Look for outliers. A single very-large repair or an unusual fuel pattern might explain it.

**"Per-truck profitability is wrong."** Check the truck's Owner ID, its fixed costs (insurance, ELD, IRP, HVUT, maintenance), and which loads are attributed to it. One wrong Owner ID can shift a lot of revenue.

**"Investor dashboard doesn't match financials view."** Both should agree if they use the same exclusion logic. If they disagree, one of them is using stale data — refresh both. If still off, escalate.

## User management issues

**"I created a user but they can't sign in."** Verify the password you set (case-sensitive). Re-reset if unclear. Confirm the user knows the correct URL (app.logisx.com, not the marketing site).

**"I deleted a user by accident."** Recreate them with the same username, role, and links. Historical data they generated (messages, status updates) is preserved. They'll have a new session ID but the same operational identity.

**"A driver's linked name doesn't match the loads."** Update the `driver_name` field on the user record to match how the driver appears in Job Tracking. Or use Fix Driver Name to update both.

**"An investor's company name doesn't link to their fleet."** Update the `company_name` field on the user record to match the carrier name on the Carrier Database. Both should match exactly (case-insensitive).

## Data Manager issues

**"My edit didn't save."** Check the cell — the save indicator should confirm. If not, network may have dropped. Try again.

**"I made an edit and now the dashboard is wrong."** Sometimes edits propagate slowly (60-second cache). Wait, refresh. If still wrong, the edit may have been invalid (e.g., wrong format for a date field).

**"I deleted a row I needed."** If it's a Job Tracking row, restore from the Google Sheets version history (Sheets natively versions). For SQLite-backed tables, restore from your backup or escalate to technical support.

## Admin Tools issues

**"Scan duplicates found false positives."** Two loads with the same Load ID may genuinely be different (someone reused an ID by mistake). Don't auto-merge — investigate each.

**"Fix Driver Name didn't update everything."** The tool updates the major tables but a few obscure ones may not be covered. Verify after running. Escalate any holdouts.

**"A scan timed out."** Some scans (especially on large datasets) take time. Try again or escalate if persistent.

## Load cancellation issues

**"I cancelled a load but it's still showing on the dashboard."** Verify the status is exactly "Cancelled" (not "Cancellation Pending" or some variant). The exclusion regex matches `^(cancel|canceled|cancelled)$` case-insensitively.

**"A cancelled load is still in financials."** Same root cause — status spelling. Fix the status to exact `Cancelled`.

**"I want to undo a cancellation."** Open the load, change status back to a valid earlier status, save.

## Soft-delete issues

**"I soft-deleted a load but it's still showing."** Check the dashboard cache — refresh. If still showing, the load may not have actually been added to `deleted_loads`. Verify via Database Admin.

**"I want to restore a soft-deleted load."** Database Admin → run `DELETE FROM deleted_loads WHERE load_id = '<load-id>'`. Refresh dashboards.

## Audit trail issues

**"I see an audit entry I don't recognize."** Click into it for details. The user ID and timestamp give you context. If the action is suspicious, escalate.

**"An audit entry is missing for an action I took."** Either the action wasn't actually logged (some are not), or the database write failed. Look at the relevant table directly to verify the action's effect.

**"I can't query the audit trail effectively."** The UI filters cover common cases. For complex queries, use Database Admin → SQL.

## Routemate issues

**"Routemate sync isn't running."** Check `ROUTEMATE_ENABLED` in `.env`. If false, the master switch is off — flip to true if appropriate.

**"Routemate API is returning errors."** Check `ROUTEMATE_API_KEY` validity. Test with `/api/admin/routemate/sync-now`. Check Routemate's status page.

**"I don't see Routemate data anywhere."** Phase 1 is the foundation; data appears only after sync-now is run and vehicles are present.

## n8n / email ingestion issues

**"New loads aren't appearing on the Job Board."** Check n8n's workflow status. The Gmail trigger may have failed silently. Check the n8n execution logs (separate system).

**"A broker email created a wrong load."** The parsing failed. Fix the load via Data Manager or manually re-run the email through the replay script.

**"The webhook secret is failing."** Verify `N8N_WEBHOOK_SECRET` in `.env` matches what n8n is sending. Rotate if needed.

## System-wide issues

**"The dashboard is very slow."** Sheets API rate limit may be hit (300/min). Wait, refresh. The 60-second cache absorbs bursts; sustained traffic eventually hits the limit.

**"Sessions are getting reset randomly."** Check `SESSION_SECRET` in `.env`. If it changed (or rolled back to default), all existing sessions are invalidated.

**"Real-time updates aren't arriving."** Socket.IO may be disconnected. Refresh the browser. Check for browser extensions that block WebSockets.

## When all else fails

Escalate to technical support with:

- **What you were doing.**
- **What you saw instead.**
- **Screenshot if relevant.**
- **Affected user, load, or other identifier.**
- **Time it happened.**
- **Whether it's blocking your work right now.**

The audit trail and server logs can be searched on your behalf to find what actually happened.
