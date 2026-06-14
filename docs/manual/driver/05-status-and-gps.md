# Status, GPS, and Geofencing

This chapter explains how the app knows where you are and how that drives the load status automatically. Understanding this saves you from "why didn't my status update?" frustration.

## The status flow

Every load goes through a series of statuses from assignment to closure:

```
  Dispatched
     ↓
  Accepted
     ↓
  At Shipper
     ↓
  Loading
     ↓
  In Transit
     ↓
  At Receiver
     ↓
  Unloading
     ↓
  Delivered
     ↓
  POD Received
```

Not every load uses every status — some shippers skip Loading, some receivers skip Unloading. The order is fixed; you can't skip from At Shipper to At Receiver without passing through In Transit.

## How statuses change

Statuses change in two ways:

1. **Automatic** — the geofence detects you've entered or left a location.
2. **Manual** — you tap the next status in the stepper on the Status tab.

Most transitions happen automatically. Manual is the backup.

## The geofence

A **geofence** is an invisible circle on the map around a location. The LogisX app uses a **500-meter** geofence (roughly a third of a mile) around your pickup and drop-off addresses.

When the app detects your GPS position has crossed into a geofence (entering) or out of it (leaving), it triggers a status change automatically.

- **Entering the pickup geofence** when status is Dispatched/Accepted → auto-advance to **At Shipper.**
- **Leaving the pickup geofence** when status is At Shipper/Loading → auto-advance to **In Transit.**
- **Entering the drop-off geofence** when status is In Transit → auto-advance to **At Receiver.**

The geofence will not jump statuses out of order. Even if you parked at the receiver's lot two days early, the app won't auto-advance to At Receiver until your current status logically allows it.

## When the geofence works perfectly

About 80% of the time, the geofence does exactly what you'd want:

- You drive into the shipper's lot. Status flips to At Shipper.
- They load you. You pull out. Status flips to In Transit.
- You drive to the receiver. Status flips to At Receiver when you arrive.

In these cases, you don't have to touch the Status tab — the workflow just happens.

## When the geofence misses or misfires

The remaining 20% of the time, something doesn't go right. Common causes:

- **Bad GPS in the area.** Tall buildings, indoor docks, dense urban canyons. GPS works fine in the open; it's terrible inside a steel warehouse.
- **The address is slightly off.** If the shipper's address in the system is 100 m off from where you actually park, the geofence is centered in the wrong spot.
- **You parked next door.** If you parked at the gas station next to the receiver, you may bounce in and out of the geofence and confuse the system.
- **You arrived early and left.** If you came by yesterday to scout the location and entered the geofence then, the system may have already auto-advanced and you missed it.

When the geofence misses, just **update the status manually**. Tap the next status in the stepper. The app will ask for a brief reason — type anything, "auto missed" is fine — and confirm.

## Updating status manually

From the **Status** tab:

1. You'll see your current load and a status stepper showing all the steps.
2. The current status is highlighted.
3. The next valid status is tappable.
4. Tap it.
5. You'll see a small dialog asking for a reason.
6. Type a short reason.
7. Tap **Confirm.**

The change happens immediately. Dispatch sees it within a couple seconds.

You can also update status from the load card on the **Loads** tab — tap the load, pick a status. Same result.

## The "one active job" guard

The app will **not** let you advance status into an active state (At Shipper, Loading, In Transit, At Receiver) if you already have **another** load in one of those statuses. This is a safety check — you can't be physically at two pickups at once.

If you hit this and you genuinely need to update both loads (rare — typically only happens when a load is being incorrectly tracked), message dispatch. They can fix the underlying issue.

## GPS reporting cadence

The app reports your GPS to the server on this schedule:

- **Every 60 seconds** when you're stationary or moving slowly.
- **Every 50 meters of movement,** whichever happens first.
- **Minimum 10 seconds between reports** to avoid flooding the server.

In practice this means: when you're driving 60+ mph, the app reports every 5-6 seconds (every 50 m of movement). When you're parked, it reports once a minute. When you're crawling through a yard, somewhere in between.

This is enough resolution that dispatch and the customer's tracking link see your position update smoothly without your battery taking a beating.

## GPS accuracy

A few realities about phone GPS:

- **Good signal:** accurate to 5-10 meters.
- **Marginal signal (tall buildings, deep canyons):** accurate to 30-100 meters.
- **No signal (indoor, tunnel):** no GPS at all; the app keeps the last known position.

The geofence is generous (1000 m) to tolerate the marginal-signal case. In tunnels and deep indoor areas, the app falls back to "last known position" until GPS returns.

If you see your position on the map jumping around erratically, your phone is having trouble locking onto satellites. Move outside, stand still for 30 seconds, then check again.

## What dispatch sees

When dispatch opens the Tracking map, they see:

- A blue dot for your current position.
- The path you've traveled (orange dashed line).
- The remaining route to destination (blue solid line).
- An ETA based on your current speed and remaining distance.

When you're parked, the dot doesn't move. When you're rolling, it moves smoothly between updates.

If dispatch doesn't see you moving when they expect you to be, they may call. Have your story ready — bathroom break, scale, lunch, fueling, accident — anything legitimate is fine. If you've broken down or had an accident, **call them, don't just sit there expecting them to figure it out.**

## What happens if your phone dies

Three scenarios:

1. **Phone dies for 5 minutes.** Charge it, open the app, you're back. The system saw a gap but nothing breaks. Your status hasn't moved on its own; it'll auto-advance again when you next come into or out of a geofence.

2. **Phone dies for an hour.** Same recovery, longer gap. Dispatch may have called your cell phone (or your spare). They'll have noticed.

3. **Phone is stolen or broken and you can't get it back online.** Call dispatch immediately. They can take over the status updates manually from their side. Don't let a dead phone leave a load in limbo.

## Pro tips

- **Pull into the geofence on purpose.** When the app auto-advances on a phantom pass-through, the fix is to drive back in and out. Easier than fighting the manual UI.
- **Update status manually if you suspect anyone is waiting.** A dispatcher sitting at the dashboard watching your dot crawl into the receiver's lot is happy to see "At Receiver" pop up. If your geofence is going to miss, beat it.
- **Don't manually advance ahead of yourself.** Tempting on a long haul to flip In Transit → At Receiver when you're still 5 minutes out. Don't — the customer tracker shows the status to the broker, and "At Receiver" when you're not actually there looks dishonest.
- **If you forgot you accepted a load, the GPS will catch up.** As long as the app is open, GPS keeps reporting. The status flow just runs.

Now turn the page for POD uploads — the one part of the workflow you actually do have to be deliberate about.
