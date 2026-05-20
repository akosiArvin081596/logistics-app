# Troubleshooting

Common dispatch issues and how to resolve them.

## Sign-in and access

**"I can't sign in."** Check caps lock. Verify the username (case-sensitive). After multiple failed attempts, the system temporarily blocks; wait 15 minutes. If still locked out, ask Super Admin to reset.

**"I can see only my own loads, not the dashboard."** Your role may have been changed. Check your profile — does it say Dispatcher? If not, ask Super Admin.

**"The page is blank or shows an error."** Refresh. Sign out and back in. Clear browser cache. If still broken, escalate.

## Assignment problems

**"A driver I want isn't in the dropdown."** They're already on an active load. Check Active Loads to confirm.

**"The driver doesn't have available status but Fleet shows them as Available."** Refresh. If the discrepancy persists, ask Super Admin to investigate — there's probably a status update that hasn't synced.

**"I assigned a load but it's not showing on the driver's phone."** Check the driver's connection. They may have the tab closed. Message them to confirm and have them refresh.

**"The driver hasn't accepted my assignment in 30 minutes."** Try the tracking map — are they online? If offline, message and call. If online but unresponsive, they may have stepped away.

## Job board issues

**"New loads aren't appearing on the Job Board."** Check the n8n workflow status (or ask Super Admin to). The workflow may have failed silently and loads are stuck in the broker email pipeline.

**"A load is on the Job Board with wrong information (typo in city, wrong rate, etc.)."** Could be a parsing error from n8n. Edit via Data Manager (or ask Super Admin). Re-verify with the broker.

**"There's a duplicate load on the Job Board."** Broker sent the rate con twice. Ask Super Admin to delete the duplicate.

## Status problems

**"A driver's status is stuck."** First check whether their phone is online (Tracking map). If yes, message them. If no, the geofence missed and the driver isn't manually updating.

**"Status auto-advanced when the driver isn't actually there."** Geofence misfire. Update back to the previous status. Note the reason.

**"Status is at At Receiver but the driver says they're at the wrong place."** The geocoded delivery address may be off. Look at the load detail; if the address is wrong in the system, edit it (Data Manager).

**"I can't change the status — it gives an error."** The transition may be out of order (you tried to skip a step). Or another load is in an active state for this driver (one-active-job rule). Check both.

## Tracking problems

**"A truck isn't showing on the map."** Their phone may have the tab closed, GPS denied, or signal lost. Message to confirm.

**"A truck is in the wrong place."** Either the GPS is glitchy or you have stale data. Refresh. If wrong info persists, the driver's GPS was off; have them refresh.

**"The route line goes through impossible places."** The route is from Google Maps, which sometimes picks weird paths. The truck itself is following their actual GPS, not the route line. Not a problem.

**"The map is slow or doesn't load."** Could be network. Refresh. Try a different browser if persistent.

## POD upload issues

**"A driver says they uploaded POD but I don't see it."** Refresh the load. If still missing, the upload may have silently failed on their side. Ask them to retry.

**"The POD photo is unreadable."** Ask the driver to re-photograph and re-upload. Multiple uploads on the same load are fine — all are stored.

**"The driver lost the BOL."** Reach out to the receiver for an electronic copy. Or have the driver describe the delivery and document what they remember. Escalate to Super Admin if needed.

## Expense issues

**"A driver's expense list is empty but they say they logged things."** Have them refresh. If still empty, check whether they're logged into the same account on multiple devices and ended up out of sync.

**"An expense was auto-filled wrong by the OCR."** Edit the values before approval. The OCR is a starting point, not the final word.

**"A driver disputes a rejection."** Talk to them, talk to Super Admin (who rejected it), find common ground. Reversibility is possible.

**"Cash expenses without receipts."** Log them with a clear description. Super Admin decides whether to approve. Anything reasonable usually gets approved.

## Driver communication issues

**"A driver isn't responding to messages."** Check tracking — are they driving? If yes, they shouldn't read messages anyway. If parked and not responding for hours, call.

**"A driver responded with something inappropriate."** Document. Talk to them about it. Escalate to Super Admin if patterns develop.

**"A driver is asking for help with something outside my scope."** Refer them to the right person. Don't pretend you can help when you can't.

## Customer tracking issues

**"A customer says the tracker isn't showing updated info."** Their browser may be caching. Suggest they clear cache or use a different browser. If the data on the dispatcher side is current, the public tracker should be too.

**"A customer says the tracker shows the wrong status."** Could be geofence misfire or your tracking has stale data. Verify against the driver's actual position.

**"A broker complains the tracking link doesn't work."** Verify they have the right URL (copy from the **Copy tracking link** button in the load). If they're using a different URL, that's the problem.

## System-wide issues

**"The dashboard is slow."** Could be Google Sheets API rate-limit (the system caches but a cache miss is slower). Wait a minute, refresh.

**"Notifications aren't appearing."** Refresh. Check the Notifications tab directly. If the badge count is right but the feed is empty, sign out and back in.

**"Everything looks weird and I'm not sure why."** Sign out, sign back in. If still weird, escalate to Super Admin.

## Edge cases

**"A driver was reassigned mid-load. The old driver is still showing the load on their phone."** Have them refresh. If still showing, sign out and back in.

**"Two dispatchers are logged into the same account."** Don't do this. Each dispatcher should have their own account.

**"A load was deleted by Super Admin but it's still showing on the customer tracker."** The tracker reads from the same source; if it's not updating, the customer's browser may be caching. Tell them to clear cache.

**"A driver got two assignments for the same load somehow."** Likely a re-assignment that didn't clean up. Ask Super Admin to investigate; the audit trail will show the sequence.

## When you're truly stuck

If the troubleshooting above doesn't apply or doesn't resolve, escalate. Provide:

- **What you were trying to do** (the action).
- **What you saw instead** (a screenshot helps).
- **The Load ID, Driver name, and timestamp** involved.
- **Whether it's blocking your work right now** (priority signal).

Super Admin can pull deeper audit data, query the database directly, and resolve things you can't from the dispatcher view.

## Reporting bugs vs. asking questions

**Bug** — the system did something wrong. Example: "I clicked Reassign and got an error message I've never seen."

**Question** — you're unsure how to use a feature correctly. Example: "How do I see a driver's full history?"

Both are valid escalations. Phrase the request honestly so the right person can help quickly.
