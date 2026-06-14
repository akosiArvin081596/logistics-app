# Dispatcher Guide

Dispatchers run the daily operation. This chapter covers your workflow: where loads come from, how to assign them, how to track trucks on the road, and how to communicate with drivers and customers.

## Your home screen

When you sign in, you land on the **Operations Dashboard** at `/dashboard`. The dashboard is organized into four tabs:

1. **Job Board** — unassigned and pending loads waiting for a driver.
2. **Active Loads** — loads currently in progress (dispatched, in transit, at receiver).
3. **Completed Loads** — recently delivered work.
4. **Fleet** — the drivers and trucks you have available.

A row of KPI cards across the top shows totals: active loads, pending loads, trucks on the road, revenue this period.

![Operations dashboard](screenshots/dispatcher-dashboard.png)

## Where loads come from

Most loads arrive automatically. When a broker emails a rate confirmation to `info@logisx.com`, an automated workflow parses the PDF and adds a new load to the system. You'll see it appear on the **Job Board** within seconds, and an alert chime briefly highlights it.

You can also create loads manually from the **New Job** button. Manual entry is mostly used for unusual situations (a phone-confirmed load, a corrected re-entry, a test load).

## Assigning a load

On the **Job Board**, each load card shows the broker, the rate, the pickup and dropoff cities, the dates, and the load ID. To assign:

1. Tap the load card.
2. The detail view opens. Pick a driver from the **Driver** dropdown — only available drivers (those not currently on an active load) appear.
3. Tap **Assign**.

The driver receives an instant notification on their phone. The load moves from Job Board to Active Loads with status **Dispatched**, awaiting the driver's accept/decline.

If the driver declines, the load returns to the Job Board with a note showing the decline. Pick a different driver and reassign.

## Reassigning an active load

If a driver gets sick, has a breakdown, or otherwise can't continue, you can hand the load to someone else mid-trip:

1. Open the load from **Active Loads**.
2. Change the **Driver** dropdown to the new driver.
3. Tap **Save**.

The old driver is notified the assignment was withdrawn; the new driver is notified they have a new load. Status stays at its current value — you don't need to restart from Dispatched.

> **Note.** Cancelling a load (vs. reassigning) is a Super Admin action, not a dispatcher action. If a load needs to be cancelled outright, ask Super Admin to handle it.

## The live tracking map

Tap **Tracking** in the sidebar (or open `/tracking`). You'll see a map with markers for every driver currently on a load.

![Tracking map](screenshots/dispatcher-tracking.png)

- **Blue marker** — the driver's current position. The marker glides smoothly between positions instead of jumping, which makes movement easier to read.
- **Green pin** — origin (pickup).
- **Red pin** — destination.
- **Orange dashed line** — the path the driver has already traveled.
- **Blue solid line** — the remaining route to destination.

Click a marker to see the driver's name, current speed, last update time, and a link to the load details. Use this to gauge whether a driver is on schedule, see traffic-related delays, or look for trucks that haven't moved when they should be moving.

If a driver's position hasn't updated in several minutes, the marker dims and shows the last-update time. This usually means the driver's phone has lost signal or backgrounded the tab — not necessarily a problem.

## Updating a load's status

You can update a load's status from the **Active Loads** tab without waiting for the driver. Click the load, change the **Status** dropdown, and save. This is useful when:

- A driver tells you on the phone they've arrived (and they're between GPS reports).
- The geofence missed an auto-advance.
- You're correcting a status that was set wrong.

The driver sees the change immediately on their phone.

## Logging expenses on the driver's behalf

If a driver pays for something by phone (a tire repair, a quick fuel stop), you can log the expense for them:

1. Open **Expenses** in the sidebar.
2. Tap **Add Expense**.
3. Choose the driver from the dropdown, fill in the details, and (optionally) upload a photo of the receipt.
4. Save.

The expense appears in the system as if the driver logged it, with a note that dispatch entered it.

## Messages

The **Messages** screen shows all your conversations with drivers. Each driver has a thread; load-specific messages appear in both the driver thread and on the load detail.

- **New messages** are highlighted with a blue dot.
- **Send a message** by typing in the box and tapping **Send**.
- **Attach a photo** with the paperclip icon (useful for sharing a customer-provided BOL, a corrected rate con, etc.).

You can also message from inside a load's detail view — the conversation is scoped to that load so the driver knows what you're talking about.

## Notifications

The **Notifications** screen is the catch-all alert feed. Every action that involves you — a new load arrived, a driver accepted/declined, a POD was uploaded, a status changed unexpectedly — shows up here in reverse chronological order.

Click any notification to jump to the relevant load. The dashboard switches to **Active Loads** and opens the load's detail modal so you can see what happened in context.

## Fleet health

The **Fleet** tab on the dashboard shows trucks and trailers, who's assigned to what, and which trucks are idle. Use this to:

- See at a glance which drivers are available.
- Spot a truck nobody's been assigned to (maintenance candidate).
- Confirm a driver-truck pairing before assigning a new load.

You can drill into a specific truck for full details (mileage, last inspection, documents) but most edits to truck records are Super Admin actions.

## Customer tracking links

For every active load, a public tracking URL is available so the broker or shipper can watch the load themselves without needing an account.

1. Open the load from **Active Loads**.
2. Tap **Copy tracking link**.
3. Paste into an email or text to the customer.

The link shows the load's progress, ETA, current location, and pickup/delivery addresses. Driver name, phone, broker info, and rate are **not** exposed — the customer sees only what they should see. The link is rate-limited so a customer can refresh it freely without affecting our other services.

## What you can do and what you can't

You **can**:

- Assign loads to drivers.
- Reassign loads in flight.
- Update load status.
- Send and receive messages with drivers.
- Add expenses on behalf of drivers.
- View the tracking map.
- Read the public customer tracker for any load.

You **cannot**:

- Cancel a load (Super Admin only — by client decision).
- See the Financials dashboard (Super Admin only).
- Add or edit user accounts.
- Approve invoices (Super Admin only).
- Approve or reject expenses (you can see them, but approval is Super Admin).
- Edit truck records or trailer records other than read-only viewing.

If you need any of those actions, escalate to a Super Admin.

## Common situations

**"A load was sent to the wrong driver."** Open the load in Active Loads and change the Driver dropdown. The old driver is notified.

**"A driver isn't responding to a load assignment."** Check their location on the Tracking map — if their phone is offline, they may not have seen it. Message them on Messages; if they still don't respond, reassign.

**"The status auto-advanced too early."** The geofence is generous (~1000 m). If a driver's GPS pings briefly inside the geofence then back out (parking on the wrong side of a yard, going through a gas station next to the receiver), the status might advance prematurely. You can edit the status back from the Active Loads tab.

**"A POD upload failed."** The driver can retry from their phone. If it keeps failing, ask the driver to text or email the POD as a fallback and you can upload it from your side via the load's documents area.

**"A broker is calling about a load I can't find."** Search by Load ID on the dashboard. If it's not there, check the Archive in the sidebar — it might have been delivered and rolled out of Active.

**"I see an alert that doesn't make sense."** Notifications are clickable — tap to see the underlying load, then read the audit trail (Admin Tools) for the full history of who did what.
