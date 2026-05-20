# Status Management

Most status changes happen automatically through the geofence as drivers arrive at and leave locations. But the geofence isn't perfect, and you'll sometimes need to step in to correct or advance a status manually from the dispatcher side.

## The status flow

Every load progresses through this sequence:

```
  Dispatched → Accepted → At Shipper → Loading → In Transit
            → At Receiver → Unloading → Delivered → POD Received
```

Not every load uses every step. Some shippers skip Loading; some receivers skip Unloading. The order is fixed.

## When auto-update misses

The geofence is a ~500-meter circle around pickup and dropoff. Misses are common in:

- **Urban areas** with weak GPS.
- **Indoor docks** — driver pulls into a steel building, GPS dies.
- **Imprecise addresses** — the address in the sheet is off from where they actually park.
- **Adjacent locations** — gas station, truck stop, scale next to the actual location.

When it misses, you'll see a driver who should be at At Receiver still showing In Transit. The driver may or may not have updated manually.

## Updating from the dispatcher side

You can update any load's status without waiting for the driver:

1. **Open the load.** From Active Loads tab, click the load.
2. **Find the Status dropdown** in the detail view.
3. **Change to the new status.**
4. **Save.**

The change is logged. The driver sees the new status on their phone immediately.

When to do this:

- **Driver tells you on the phone they've arrived.** They may be between GPS reports; you can update on their behalf.
- **The geofence missed.** They're physically there but auto didn't trigger.
- **The geofence misfired.** They drove through a geofence and the system auto-advanced; you can correct back.

## The "valid predecessor" check

Status updates enforce a sanity check. You can't jump from At Shipper straight to At Receiver without passing through In Transit. Trying to skip steps returns an error.

This is intentional. Out-of-order statuses confuse downstream systems (customer tracker, invoices, financial calculations).

If you genuinely need to skip a step (rare, but it happens — e.g., a load that bypassed a checkpoint), make the intermediate transition manually. The audit trail will show what you did.

## The "one active job" rule

A driver can have **only one load in an active state** (At Shipper, Loading, In Transit, At Receiver) at a time. The status update endpoint returns a 409 Conflict if you try to put a driver in an active status while another load is already active.

This protects against physical impossibility. You can't be at two pickups at once.

If you hit this on a status update, check which other load is in an active state. Usually it's a stale load that needs to be finalized first.

## Backwards updates

The dispatcher UI lets you move a status backwards as well as forwards. Examples:

- **Mis-advance correction.** Auto-advanced to At Receiver because the driver passed the geofence; correct back to In Transit.
- **POD upload mistake.** Driver uploaded a wrong file and re-uploaded the right one; status doesn't need to change.
- **Driver returns to pickup.** A receiver refuses the load; driver returns to shipper for re-delivery. Backwards from At Receiver to In Transit makes sense.

Backwards changes are logged the same as forward changes.

## Logging reasons

When you (or a driver) change status manually, the system asks for a brief reason. Examples:

- "Geofence missed at pickup"
- "Driver arrived per phone confirmation"
- "Corrected after misfire"
- "Receiver refused, returning to shipper"

Be specific enough that someone reading the log later understands what happened. A vague "manual update" is fine if there's no story behind it, but a concrete reason helps with audits and dispute resolution.

## Status Logs sheet

Every status change — auto or manual, by driver or dispatcher — writes to the "Status Logs" sheet in the backend. The sheet has:

- Timestamp.
- Load ID.
- Old status → new status.
- Reason given.
- Who made the change.

Super Admin can read the full logs. If you're trying to understand a load's history, that's the source of truth.

## When to update aggressively vs. let it ride

Some dispatchers update aggressively (every status change confirmed within minutes). Others wait and only intervene when something looks stuck.

**Lean toward aggressive when:**
- The load has a tight delivery window.
- The broker is calling for updates.
- The customer is using the public tracker.

**Lean toward letting it ride when:**
- The load is on a long haul with plenty of time.
- The driver is reliable and you trust their auto-updates.
- You have other things needing attention.

There's no rule. Use judgment.

## Geofence trigger notifications

Every geofence event — auto-advance, manual update, status logs — fires a real-time notification:

- **Dispatcher Notifications tab** shows the event.
- **Driver app** shows it as a status change.
- **Customer tracker** updates if the load is being tracked.

If you see a status change you didn't expect, click the notification to see the load and check whether anything is wrong.

## Diagnosing a stuck status

If a load's status seems stuck (driver clearly at the receiver but status is still In Transit, hours later):

1. **Is the driver's app open?** Check tracking map — does their dot show recent position?
2. **Did the geofence miss?** Some addresses are slightly off. Check the geocoded pickup/dropoff in the sheet.
3. **Did the driver decline to update?** They may have forgotten or been busy unloading.
4. **Is there a bigger issue?** Driver may have been pulled off duty, broken down, or had an incident.

Message the driver. The fastest fix is usually to ask.

## Special status: "Cancelled"

A cancelled load has its status set to **Cancelled**. This is a Super Admin action — you can't do it from the dispatcher side.

Per the 2026-04-19 client decision, dispatchers don't have cancel authority. If a load needs to be cancelled outright, escalate to Super Admin. They'll handle it.

If you just need to swap drivers, reassign instead. That's a different action and works without cancellation.

## Pro tips

- **Update status when you talk to a driver.** If they call to say they've arrived, update before you hang up. Eliminates confusion.
- **Trust auto-updates by default.** They're right 80% of the time. Only override when you have specific information.
- **Don't manually advance past where the driver actually is.** Tempting on a long-haul to advance to "At Receiver" when they're still 30 min out. Don't — the customer tracker shows the status and "At Receiver" when actually not is misleading.
- **Use the Status Logs sheet for disputes.** If a driver claims to have done X and you don't see it on the load, check the logs.
