# Frequently Asked Questions

Common dispatcher questions, grouped roughly.

## Access and accounts

**Q. How do I sign in?**
Go to `app.logisx.com`. Enter your username (case-sensitive) and password. You'll land on the operations dashboard.

**Q. Forgot my password.**
Ask Super Admin to reset it. There's no self-service reset.

**Q. Can I have my account on multiple devices?**
Yes. Phone, tablet, desktop — all simultaneous. Same login.

**Q. Will I see other dispatchers' actions?**
Yes. Every load shows the most recent activity regardless of which dispatcher took it. The Notifications tab shows all dispatch-related events.

## Job board

**Q. Where do new loads come from?**
Most arrive automatically from n8n parsing broker rate confirmation emails. Some are manually entered via the New Job button.

**Q. Why is a load missing from the Job Board that should be there?**
Either n8n hasn't processed it yet (check email status), it's already been assigned (check Active Loads), or it was filtered out (cancelled, deleted).

**Q. Can I edit a load on the Job Board?**
Some fields, yes — date, address, notes. Open the load detail and look for edit affordances. Rate and broker info usually require Data Manager (Super Admin) or n8n re-parsing.

**Q. Can I assign multiple loads to one driver?**
No. A driver can have only one active load at a time (the system enforces "one active job" via status guards). Pre-assign future loads after current ones complete.

## Assignments

**Q. Why doesn't a driver show in the dropdown?**
They're already on an active load. Check Active Loads to confirm.

**Q. Can I assign without the driver accepting?**
The assignment is created when you click Assign. The driver then accepts or declines. They have to act to either confirm or release.

**Q. What if a driver declines?**
The load returns to the Job Board. Reassign to a different driver.

**Q. How do I see a driver's load history?**
Sidebar → Drivers (Super Admin only for direct access). Or open a recent load, click the driver name. Some dispatchers ask Super Admin for the driver's load history report.

## Status updates

**Q. Why didn't the status auto-advance?**
Geofence missed. Common in urban or industrial areas. Manually update via the Status dropdown.

**Q. Can I move a status backwards?**
Yes. The system allows status backwards-moves if you give a reason.

**Q. Can I jump from At Shipper to At Receiver?**
No. Statuses must go in order. The system enforces this; you'll get an error if you try to skip.

**Q. Why does the system say "another load is in an active state for this driver"?**
The one-active-job rule. A driver can have only one load in At Shipper / Loading / In Transit / At Receiver at a time. Resolve the other load first.

## Tracking

**Q. Why isn't a driver on the tracking map?**
Their phone may have the LogisX tab closed, GPS denied, or signal lost. Message them to confirm they're online.

**Q. Can I see historical position data for a driver?**
The trail line on the map shows recent movement. For older history, ask Super Admin to query the driver_locations table.

**Q. Is the ETA accurate?**
Reasonably so. It uses current position, speed, and route to estimate. ETAs get more accurate as the driver gets closer. Take with grain of salt 5+ hours out; trust within an hour.

**Q. Can I share my screen with a broker?**
The customer tracking link is better. Click **Copy tracking link** on the load and send it.

## Messaging

**Q. Can I message multiple drivers at once?**
Not currently. Send individual messages.

**Q. Are messages logged forever?**
Yes. Nothing is deleted. Super Admin can audit any conversation.

**Q. Can I message brokers through the app?**
No. The Messages tab is dispatch-to-driver only. Broker communication is outside the app (email, phone).

## Customer tracking

**Q. What does the customer see?**
Status, last known position, ETA, pickup/dropoff cities, truck unit number. Not driver name, phone, broker, or rate.

**Q. Is the tracker secure?**
The only credential is the Load ID itself. Without the Load ID, the URL is useless. The page is rate-limited and excluded from search engines.

**Q. Can the customer leave a note?**
No. The page is read-only.

**Q. When does the tracking link stop working?**
It works as long as the load record exists. Even after delivery, the page shows the final delivered status.

## Expenses

**Q. Can I approve an expense?**
No. Approval is Super Admin.

**Q. Can I add an expense for a driver?**
Yes. Expenses → Add Expense → pick driver from dropdown.

**Q. What about company fuel card transactions?**
Those happen outside the app. The driver should still log a fuel expense linking the transaction to the load.

**Q. Why was an expense rejected?**
Usually missing receipt, unreadable receipt, wrong category, or personal expense flagged. The driver sees the reason on their side.

## Reassignment

**Q. Does reassignment reset the status?**
No. The new driver inherits the current status.

**Q. Will the broker know about the swap?**
Not automatically. If the broker asks for an updated driver, tell them.

**Q. Can the old driver still see the load after reassignment?**
No. The load disappears from their view immediately.

**Q. Will the audit trail show the swap?**
Yes. Super Admin can pull the audit entry.

## Notifications

**Q. Can I turn off notifications?**
No granular controls. The feed is what it is.

**Q. Why am I getting notifications for things I didn't do?**
The feed shows all dispatch-relevant events, not just yours. Multiple dispatchers' actions all surface in the same feed.

**Q. Can I mark all as read?**
Yes — there's usually a "Mark all as read" button at the top of the feed.

## Cancellations

**Q. Can I cancel a load?**
No. Per the 2026-04-19 client decision, cancellation is Super Admin only. Escalate.

**Q. What about deletion?**
Same. Super Admin only.

**Q. What if a broker cancels a load I haven't assigned yet?**
Tell Super Admin to delete it. They'll remove it from the Job Board.

**Q. What if a load was cancelled by mistake?**
Super Admin can restore from the deleted_loads table.

## Working with drivers

**Q. Can I see a driver's HOS in the app?**
LogisX doesn't currently track HOS itself. The drivers' ELDs (Routemate or similar) do.

**Q. Can I see who a driver's emergency contact is?**
Super Admin → Drivers → driver detail.

**Q. Why is a driver showing as "On Duty" but they say they're not?**
The app doesn't track on/off duty status the way an ELD does. "Active" in the app means "they have a load in an active state."

## Reports and analytics

**Q. Can I see weekly fleet stats?**
Some dashboard KPIs show fleet stats. Full P&L is in /admin/financials (Super Admin only).

**Q. Can I export driver activity to a spreadsheet?**
Ask Super Admin. Data Manager has direct sheet access.

**Q. Can I see how many loads I assigned this week?**
Not in a dedicated report. Sidebar → Notifications → filter by your actions, then count manually.

## Technical

**Q. Why is the dashboard sometimes slow?**
The system reads from Google Sheets. Sheets has a rate limit; we cache aggressively. A cache miss can be slow occasionally. Usually resolves within seconds.

**Q. Can I work offline?**
No. The app needs a live connection for almost everything.

**Q. Are sessions secure?**
Sessions use HTTPS, cookie flags (httpOnly, secure, sameSite=strict), and database storage. Standard web-security practices.

## Career

**Q. Can I move from dispatcher to Super Admin?**
Talk to leadership. Internal mobility depends on operational needs and your demonstrated capabilities.

**Q. What if I want to give feedback about the app?**
Tell your supervisor or operations lead. Feedback is welcomed and shapes future improvements.

**Q. Can I refer a friend?**
For a driver position, yes — most carriers welcome referrals. For dispatcher positions, depends on hiring.

That's the most common stuff. Anything else, ask Super Admin or leadership.
