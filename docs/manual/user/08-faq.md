# Frequently Asked Questions

The questions that come up most often, across all roles. Skim for the one that matches yours.

## General

**Q. What does LogisX do?**
LogisX is the dispatch and fleet management platform that connects brokers, drivers, dispatchers, investors, and customers around the movement of freight. Brokers email loads, the system parses them, dispatchers assign drivers, drivers run the loads with live GPS tracking, customers track their freight, investors see the earnings on the trucks they fund.

**Q. Do I need to install anything?**
No. LogisX runs entirely in a web browser. The driver app is optimized for phones; the dispatcher and admin views work best on desktop or tablet.

**Q. Does it work offline?**
Not currently. The app needs a network connection for everything but caching small amounts of locally-typed text that can be re-sent when signal returns.

**Q. What data does LogisX collect about me?**
For drivers, your GPS location while the driver tab is open, the loads you run, status updates you make, expenses you log, and messages you exchange with dispatch. For everyone, basic account info and your activity within the app. Investors additionally see financial data scoped to their fleet. The app does not sell, share, or use this data for anything other than running the dispatch operation.

## Sign-in & accounts

**Q. I forgot my password.**
LogisX doesn't have a self-service password reset. Contact your administrator — for drivers that's dispatch, for everyone else it's your operations lead.

**Q. Can I have two accounts on different devices?**
Yes, the same account can be signed in on multiple devices simultaneously. All actions sync.

**Q. Can I share my account with a coworker?**
No. Each user should have their own account so actions are attributable. Ask your admin to create one.

**Q. Can I change my username?**
Not from the app. Ask your admin to do it.

## Drivers

**Q. Why does the app ask for my location?**
GPS reporting is how dispatch knows where you are, how the geofence auto-advances your status, and how the customer's tracking link shows your live position. Without it, none of those work, and dispatch has to call you for an update.

**Q. Does the app track me 24/7?**
No. The driver tab reports your position only while it's open. Close the tab — no reports. The 50-meter movement threshold also means we don't flood the server with reports while you're parked.

**Q. Why does the status sometimes auto-update and sometimes not?**
The geofence works most of the time, but GPS in dense urban areas, parking lots, or close to large buildings can be unreliable. When auto-update misses, you can update the status manually from the Loads or Status tab.

**Q. How is my pay calculated?**
For most drivers, it's a daily rate times the number of unique calendar days you were active on a load. A multi-day load (Monday pickup, Wednesday delivery) counts every day. Two loads on the same day count as one day. For owner-operators, pay is a percentage of the load revenue. Your administrator can tell you which rate applies to you.

**Q. Why is an invoice showing wrong?**
Two common reasons: the pay_type on your account doesn't match the rate that was actually used, or a load's dates in the sheet are wrong, which changes the active-day count. Message dispatch with the invoice number.

**Q. Can I see other drivers' loads?**
No. You see only your own work.

## Dispatchers

**Q. Why can't I cancel a load?**
Per a 2026-04-19 client decision, cancellation is restricted to Super Admins. You can reassign loads to a different driver, but final cancellation requires escalation.

**Q. How do I add a new driver?**
Drivers come from approved applications. Send them to the public driver application form (`/apply`), then Super Admin approves the application, which auto-creates the driver record and user account.

**Q. Why are some driver names case-different in the sheet vs. the dashboard?**
Driver matching is case-insensitive. The system handles "LESLINE JOHNSON" and "Lesline Johnson" as the same driver. If you see a driver showing in two places under different spellings, that's a data-entry issue — escalate to a Super Admin to run **Fix Driver Name** to merge them.

**Q. Does the system warn me before I assign a driver who's already on a load?**
A driver can't transition into an active status (At Shipper, Loading, In Transit, At Receiver) if they already have a load in one of those statuses — the system blocks the change with a 409 Conflict. Assignments themselves don't block; you assign and the driver decides whether to accept.

**Q. How do customers track their load?**
Each load has a public tracker URL. Open the load, tap **Copy tracking link**, and send the URL to the customer. They can refresh it freely without affecting the rest of the system.

## Super Admins

**Q. How do I delete a load without losing the audit trail?**
Use **Delete** on the load. This soft-deletes — the row stays in the Google Sheet for the record, but the load drops out of every operational view.

**Q. How do I undo a soft-delete?**
Soft-deletes are reversible by removing the row from the `deleted_loads` SQLite table. That's a developer task — contact technical support.

**Q. How is revenue calculated in financials?**
Revenue counts in the month a load was **assigned**, not delivered. This matches the dispatcher dashboard and the investor dashboard, so all three views agree on monthly totals.

**Q. Why is a scan-duplicate result showing two loads that are clearly different?**
Two loads with the same Load ID look like duplicates to the scanner. Re-key one of them to a unique ID in Data Manager.

**Q. Can dispatchers see the financials dashboard?**
No. The financials dashboard is Super Admin only. Dispatchers see the operations dashboard, which shows revenue at a high level but not the cost breakdown.

## Investors

**Q. How is my earnings number calculated?**
For each month: revenue minus driver pay minus fixed costs (insurance, ELD, IRP, HVUT, maintenance fund) minus trip expenses (fuel, repairs, tolls) equals net profit. You get half of net profit by the management agreement.

**Q. Why doesn't my earnings dashboard match the report PDF I downloaded?**
The dashboard and the report should match. If they don't, take a screenshot of both and message operations — the most common cause is the dashboard refreshing mid-update.

**Q. Can I see who's driving my truck?**
Yes — the Fleet Breakdown section shows the currently-assigned driver per truck. The investor dashboard does not show driver contact info or financial details about the driver, just the assignment.

**Q. Can I download historical reports?**
Yes — use the date range picker in the hero header. Pick the period you want and tap **Download Report**.

**Q. Will my reports include every load?**
Yes. Reports include a per-load detail section showing every load that contributed to revenue in the period.

**Q. How do I increase my fleet?**
Message operations. Adding a truck is a process — agreement updates, vehicle lease, possibly capital movement — that's handled by leadership directly.

## Customers (public tracker)

**Q. What is the URL for the tracker?**
You should have received the URL from your broker or LogisX dispatch. The format is `app.logisx.com/track/LD-XXXX`. If you only have the Load ID, you can also go to `app.logisx.com/track` and enter the ID in the search box.

**Q. The tracker says my load isn't found.**
Double-check the Load ID. If it's correct, the load may not have been entered into LogisX yet, or it may have been completed and rolled out of active tracking. Contact LogisX dispatch.

**Q. The location hasn't updated in a while.**
The driver's phone may have lost signal. The tracker shows the last-update time so you can tell if the position is stale. If it's been hours, contact LogisX.

**Q. Can I see the driver's contact info?**
Not on the tracker. The tracker shows only what's appropriate for a customer view. If you need to reach the driver, contact LogisX dispatch.

**Q. Will the tracker work after delivery?**
Yes — the page shows the final delivered status and stays accessible for reference.

## Technical (everyone)

**Q. Why is the system sometimes slow?**
The system reads from Google Sheets, which has a quota and occasionally returns slower-than-usual responses. We cache aggressively to mask this, but a slow response from Google can still bleed through to the UI. Usually resolves in seconds.

**Q. Does the system support multiple companies?**
Currently, no. LogisX is a single-tenant deployment for LogisX Inc. Multi-tenancy would require a different architecture.

**Q. Will I get notified by email when something happens?**
Some things, yes — driver application approvals, investor onboarding milestones, password resets. Day-to-day operations (load assignments, status changes) happen entirely inside the app; you'll see them on the relevant screen the moment they happen.

**Q. Can I export data to Excel?**
Several screens have a download button that produces a PDF or CSV. For sheet-level data, Super Admins have direct access via Data Manager and can copy/paste from there.

**Q. Is the app secure?**
The standard web-security baseline: HTTPS-only, session cookies marked `httpOnly` and `secure`, brute-force protection on sign-in, rate limiting on public endpoints, role-based access control on every protected route, sensitive data scrubbed from responses to roles that shouldn't see it.

**Q. Where can I read the technical documentation?**
A companion **Technical Documentation** PDF covers the architecture, API, database schema, integrations, deployment, and operations. Ask your administrator or technical team for a copy.
