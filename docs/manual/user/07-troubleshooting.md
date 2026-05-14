# Troubleshooting

This chapter collects the most common issues across all roles and how to handle them. If your problem isn't here, see the FAQ chapter or contact your support person.

## Sign-in issues

**"I can't sign in. The page says my credentials are wrong."**
Double-check that **caps lock is off** and that the username is spelled exactly as your administrator set it (case-sensitive). If you've recently changed your password and now can't sign in, the new password may not have saved — ask your admin to reset it again.

**"The sign-in page just refreshes and doesn't sign me in."**
Your browser is probably blocking cookies. LogisX requires cookies enabled for session management. Open your browser's privacy settings and allow cookies for `app.logisx.com`.

**"I've been kicked out and need to sign back in."**
Sessions time out after a period of inactivity. This is expected. Just sign back in.

**"After several wrong password tries, I'm locked out."**
A brute-force protection kicks in after too many failed attempts. Wait 15 minutes and try again, or ask your admin to reset your password.

## Page-loading issues

**"The page is blank or shows 'something went wrong'."**
Refresh the page (Ctrl+R or Cmd+R). If that doesn't help, sign out and sign in again. If the issue persists across sessions, your administrator can check whether the system itself is having problems.

**"The dashboard loads but the numbers look wrong."**
The dashboard refreshes automatically on events. If a recent change isn't reflected, tap a different tab and back to force a re-fetch. If numbers are still off, the underlying sheet may have a duplicate row or a date error — escalate to a Super Admin to run a duplicate scan.

**"The map doesn't load."**
The map needs the Google Maps API to work. If it doesn't load, your network may be blocking Google's servers, or the API key may have expired. Refresh; if it still doesn't load, contact technical support.

## Driver-specific issues

**"My GPS shows the wrong location."**
Your position is reported by the truck's Routemate ELD, not your phone or the browser. If the position is wrong or stale, message dispatch with the load ID — they can verify the ELD is reporting and reach out to Routemate support if the device is offline.

**"My status didn't auto-update when I arrived."**
The geofence is generous (~500 m) but it isn't perfect. Tap the next status in the stepper manually and give a brief reason. This is normal — auto-advance covers most cases but never claims 100%.

**"I uploaded a POD but the system says it didn't upload."**
Try once more. If it keeps failing, your cell signal may be too weak for the upload. Move to a stronger signal area or use Wi-Fi. As a fallback, you can text or email the POD to dispatch.

**"I accepted a load but it disappeared from my list."**
The load may have been reassigned or cancelled. Pull-to-refresh on the Loads tab. If still missing, message dispatch.

**"The expense OCR read my receipt wrong."**
Edit the fields before saving. The OCR is a convenience, not a requirement. If it's consistently wrong on a vendor (e.g., always misreading a specific truck stop's receipts), let dispatch know so the issue can be flagged.

## Dispatcher-specific issues

**"A driver isn't responding to a load assignment."**
Check their position on the tracking map. If their phone shows offline (no recent GPS report), they may not have signal. Message them; if you still don't hear back within a reasonable window, reassign the load to a different driver.

**"A POD doesn't appear in the load even though the driver says they uploaded."**
Refresh the load detail. If still missing, ask the driver to retry. Failed uploads sometimes look successful on the driver's side. If it keeps failing, get the POD by text/email and upload it yourself.

**"The job board shows a load that shouldn't be there."**
The load may have a typo'd Load ID that created a duplicate. Open the load — if it duplicates another, ask Super Admin to run the duplicate scan and merge.

**"A driver's name shows wrong on a load."**
The Carrier Database is the source of truth for driver names. Find the load in Data Manager and either correct the driver field or, if the entire name is wrong (typo across all loads), use the Admin Tools' **Fix Driver Name** action.

## Super Admin issues

**"An invoice has the wrong driver pay."**
Check the driver's pay_type. Owner-operators are paid as a percentage of revenue; standard drivers are paid by active days. Check the load dates the invoice covers — if a load spans a date with a different pay rate, you may need to manually adjust.

**"Cancelling a load didn't remove it from financials."**
Cancellations are filtered out by the standard exclusion logic. If the load is still showing in financials, check the load's actual status — if it says "Cancellation Pending" or similar instead of "Cancelled", the exclusion regex didn't match. Set the status to exactly "Cancelled" and the load drops out.

**"A scan-orphans result has loads I want to keep."**
An orphan is a record pointing to nothing — usually a load with a deleted driver. Re-link the load to a current driver in Data Manager and re-run the scan. If the load is legitimately a no-driver placeholder (e.g., a load entered before assignment), the scanner is being overzealous; you can ignore the result.

## Investor-specific issues

**"My earnings show $0 for a month I know my fleet was running."**
Three things to check, in order. (1) Your account's company name should match the carrier name on your truck's records exactly. (2) The Owner ID column on the loads should match your investor record. (3) None of your loads should be cancelled or soft-deleted.

If all three look right and earnings are still $0, message operations with a specific load ID — we'll trace the join from there.

**"The monthly view and all-time view disagree."**
Some loads in your fleet may have incorrect pickup or dropoff dates in the sheet, which causes them to count for all-time but not for a specific month (or vice versa). Message operations with the month in question and we'll review the dates.

**"I want a custom report that the standard report doesn't show."**
Use the **Download Report** button with a custom date range. The PDF includes per-load detail. If you need a different cut (per-driver, per-truck), message operations.

## Browser and device issues

**"The app looks broken on my phone."**
First, refresh. If it still looks broken, you may be on a very old browser version. Update your browser to the latest version.

**"The driver tab logs me out when my screen turns off."**
This is a phone OS behavior — iOS and Android both background and eventually suspend tabs after the screen has been off for a while. The session itself doesn't expire that fast; the tab is just sleeping. Open the tab and you should be signed back in. If you weren't, your session truly expired — sign in and pin the tab.

**"The PDF I downloaded is corrupted."**
Try the download again. If it's a generated PDF (invoice, report, application), the generator may have rendered partially. If it's a stored document (a signed agreement), the file may have been replaced — refresh the page and try again.

## When to escalate

If none of the above resolves your issue:

- **Drivers** — message dispatch.
- **Dispatchers** — escalate to a Super Admin.
- **Super Admins and Investors** — contact LogisX technical support.

Have the following ready when you escalate: what role you are, what you were trying to do, what you saw instead, and (if relevant) the exact load ID or user ID involved.
