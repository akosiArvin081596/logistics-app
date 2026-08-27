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
2. **Manual** — you open the load and tap the next status in the stepper.

Most transitions happen automatically. Manual is the backup.

## The geofence

A **geofence** is an invisible circle on the map around a location. LogisX uses a **2-mile** geofence around your pickup and drop-off addresses.

When the app detects your GPS position has crossed into a geofence (entering) or out of it (leaving), it triggers a status change automatically.

- **Entering the pickup geofence** when status is Dispatched/Accepted → auto-advance to **At Shipper.**
- **Leaving the pickup geofence** when status is At Shipper/Loading → auto-advance to **In Transit.**
- **Entering the drop-off geofence** when status is In Transit → auto-advance to **At Receiver.**

The geofence will not jump statuses out of order. Even if you parked at the receiver's lot two days early, the app won't auto-advance to At Receiver until your current status logically allows it.

**Delivered is never automatic.** The geofence will move you to At Receiver, but marking a load Delivered is always something you do yourself — and it requires a POD on file first.

## When the geofence works perfectly

About 80% of the time, the geofence does exactly what you'd want:

- You drive into the shipper's lot. Status flips to At Shipper.
- They load you. You pull out. Status flips to In Transit.
- You drive to the receiver. Status flips to At Receiver when you arrive.

In these cases you don't have to touch the app at all — the workflow just happens.

## When the geofence misses or misfires

The remaining 20% of the time, something doesn't go right. Common causes:

- **Bad GPS in the area.** Tall buildings, indoor docks, dense urban canyons. GPS works fine in the open; it's terrible inside a steel warehouse.
- **The address is slightly off.** If the shipper's address in the system is 100 m off from where you actually park, the geofence is centered in the wrong spot.
- **You parked next door.** If you parked at the gas station next to the receiver, you may bounce in and out of the geofence and confuse the system.
- **You arrived early and left.** If you came by yesterday to scout the location and entered the geofence then, the system may have already auto-advanced and you missed it.

When the geofence misses, just **update the status manually** — it takes two taps.

## Updating status manually

Open the load from the **Loads** tab. The **Update Status** section is at the top:

1. You'll see a six-step stepper: Heading to Shipper → At Shipper → Loading → In Transit → At Receiver → Delivered.
2. Your current step is highlighted.
3. A large button underneath is labelled with the next step.
4. Tap it, then tap to confirm.

You are not asked for a reason. The change happens immediately, and dispatch sees it within a couple of seconds.

The stepper only moves **forward**. If a status needs to go backwards, message dispatch — they can correct it.

## The "one active job" guard

The app will **not** let you advance status into an active state (At Shipper, Loading, In Transit, At Receiver) if you already have **another** load in one of those statuses. This is a safety check — you can't be physically at two pickups at once.

If you hit this and you genuinely need to update both loads (rare — typically only happens when a load is being incorrectly tracked), message dispatch. They can fix the underlying issue.

## Where your position comes from

**Your phone does not report your location to LogisX.** Tracking comes from the **ELD in your truck**, which reports roughly once a minute on its own. You don't have to do anything, keep the app open, or grant a location permission for tracking, pay or the geofence to work.

That means:

- Closing the app does **not** stop tracking.
- Denying the location permission does **not** stop tracking.
- If your truck's ELD is offline, the map will say so plainly — *"Showing route only — truck position unavailable (ELD offline)"* — rather than showing a stale pin as if it were live.

## When your phone's GPS *is* used

Only when you tap **Navigate** on a load. Turn-by-turn directions need to know where you are far more precisely and far more often than once a minute, so the app asks for your location at that point and uses it for the map and the voice guidance.

That position stays on your phone. It is never sent to LogisX, and it never affects tracking, your pay or the geofence.

If you decline the permission, navigation still shows you the route — you just don't get the moving arrow or spoken directions. Everything else keeps working.

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
