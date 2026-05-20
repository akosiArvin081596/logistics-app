# Reassignment

A load is in progress with a driver, and something changes. The driver gets sick, breaks down, runs out of hours, or you need to optimize routing. You can move the load to a different driver mid-trip.

## When to reassign

Common scenarios:

- **Driver A's HOS runs out.** They're 200 miles from delivery; Driver B is closer and has hours.
- **Driver A's truck breaks down.** Repair will take a day; the load needs to deliver tonight.
- **Driver A had a personal emergency.** They have to get home; the load needs to keep moving.
- **You realize a better match.** Driver A accepted the load but Driver B is now in a much better position for it.
- **Driver A declined.** They started running and decided they can't finish. Rare but it happens.

Reassignment is faster than cancelling and re-creating the load, and it preserves the load's history.

## How to reassign

1. **Open the load** from the **Active Loads** tab.
2. **Find the Driver dropdown** in the load detail view.
3. **Pick the new driver.**
4. **Click Save** (or Reassign — the button text may differ).

What happens:

- **Old driver** sees the load disappear from their Loads tab and gets a notification "load reassigned."
- **New driver** sees the load appear on their Loads tab with status whatever it was (At Shipper, In Transit, At Receiver — not reset to Dispatched).
- **Load status doesn't change.** A load that was At Receiver stays At Receiver. The new driver picks up wherever the old one left off.

This is intentional. Reassignment is a hand-off, not a restart.

## Coordinating the hand-off

The app moves the load record cleanly, but the real-world hand-off requires coordination:

- **Where are they meeting?** If Driver A has the trailer at a truck stop, Driver B needs to know where.
- **Bobtail or with trailer?** Some hand-offs are bobtail (driver B comes empty, hooks up to Driver A's trailer). Some require driver B to bring an empty trailer.
- **Paperwork.** Driver A's been keeping the BOL with the freight. Driver B needs it.
- **Keys, fuel card, communication.** All sorts of practical details depend on the situation.

**Use the Messages tab to coordinate.** Send a message to both drivers with the meet-up details, then verify they've connected.

## Special cases

### Driver A is at a shipper, hasn't picked up yet

Easiest case. Reassign the load. Driver B becomes the new picker.

If Driver A is physically at the shipper, message them to walk away — they don't need to do anything physically, and the shipper can wait for Driver B.

### Driver A picked up and is in transit

Hand-off at a truck stop or rest area is typical. Driver A drops the trailer; Driver B picks it up. Coordinate the location and timing via Messages.

Some receivers don't accept driver changes mid-trip — if that's a concern, message the broker.

### Driver A is at the receiver

If the freight is still on the truck, Driver B can complete the unload. Reassign.

If the freight is already off the truck (delivery complete, just no POD yet), this isn't really a reassignment — it's a POD upload issue. Better to have Driver A upload the POD (even from a different location) than complicate the load record.

### Driver A had an accident

This is the worst case. The load is on a truck that's not moving for hours or days. Decisions:

1. Is the freight OK? Photograph if you can.
2. Can Driver B come retrieve it (with permission of authorities)?
3. Is recovery needed first? Towing, insurance, etc.

Reassignment in the app is the easy part. Coordination is everything.

## When NOT to reassign

A few scenarios where reassignment isn't the right call:

- **The load is already delivered with POD uploaded.** It's done. Don't reassign.
- **The driver had a tiny gripe and you're capitulating.** Drivers sometimes complain because they're tired or had a bad day. Talk through it before reassigning.
- **The new driver doesn't actually have hours.** Reassignment with a driver who can't run it just moves the problem. Verify before clicking.
- **You haven't asked Driver A.** Sometimes Driver A has a plan you don't know about (they were going to ask for a partial swap with Driver B already). Talk to them first.

When in doubt, message both drivers, get alignment, then reassign.

## Status doesn't reset

Reassignment preserves the load's current status. If the load was at **At Receiver**, it stays At Receiver after reassignment. Driver B inherits the in-progress status.

This means:
- Driver B doesn't have to "re-accept" the load. It's just theirs.
- The geofence is still aware of the load's location. If Driver B arrives at the geofence and status is appropriate, auto-advance still works.
- The customer tracker is unaffected — they see the same load progressing.

The one thing that does change is the driver name visible on the load. Old name → new name.

## Audit trail

Every reassignment is logged:

- **Notifications tab** shows the reassignment event.
- **Audit trail** (Super Admin) has a full record.
- **The load history** shows the swap.

If anyone asks "why did Driver A start this load and Driver B finish it?", the answer is in the system.

## A cleaner workflow

For a clean reassignment, the steps in order:

1. **Decide it's the right move.** Talk to Driver A, Driver B, the broker if needed.
2. **Confirm Driver B has hours and equipment.**
3. **Coordinate the meet-up.** Location, time, who brings what.
4. **Reassign in the app.** This step is the easy one.
5. **Message both drivers** with confirmation and any final instructions.
6. **Update the broker** if they need to know (some do, some don't).
7. **Monitor.** Once Driver B is in possession, watch their tracking like any other load.

The first three steps take more time than the actual reassignment click. Plan for that.

## When reassignment is the wrong tool

If a driver is fundamentally unable to finish a load (truck destroyed, driver hospitalized) and there's no replacement available, reassignment doesn't solve the problem. In that case:

1. **Tell the broker.** They may agree to extend the delivery window or take it back.
2. **Escalate to Super Admin.** They can cancel the load if needed (you can't).
3. **Document.** Photographs, conversation logs, anything that explains what happened.

The app gives you tools, not magic. Real-world logistics is still messy.
