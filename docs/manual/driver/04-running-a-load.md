# Running a Load, Start to Finish

This chapter is the canonical workflow — from accepting a fresh assignment to delivered with POD uploaded. Most days will look just like this.

## When a new load lands

You're on duty (or about to be). Your phone is unlocked. The **Loads** tab in the LogisX app shows a new card with **Accept** and **Decline** buttons.

A few things to look at on the card before you tap anything:

- **Pickup city and date.** Can you get there in time?
- **Drop-off city and date.** Will the delivery window work for you?
- **Pay** (if shown). Does it match what dispatch told you to expect?
- **Equipment notes** (if any). Reefer set point, special permits, anything unusual.

If you have any doubts, **message dispatch first**, before you accept. It's better to ask than to accept and then have to decline.

If everything looks right, tap **Accept.**

## What happens when you accept

Three things happen instantly:

1. The load card moves from "Pending" to "Accepted." The Accept/Decline buttons go away.
2. Your dispatcher gets a notification. They know you're committed.
3. The load's status moves from **Dispatched** (which is what an assigned-but-not-accepted load is) to **Accepted.**

You'll see the load appear on the **Status** tab now too — that's where you'll spend most of your time during the actual run.

## Driving to pickup

Tap the load card to open the **Load Detail** view. You'll see:

- A **map** showing your current position and the pickup location.
- The full pickup address with appointment time.
- The broker's reference number (good to have if the receiver asks).
- Notes from dispatch, if any.

Use your preferred navigation app to drive to pickup. The LogisX map is for reference; it doesn't do turn-by-turn navigation itself. Most drivers use Google Maps or whatever GPS unit they normally use in the cab.

## Arriving at the shipper

When you get within about **1000 meters** (1 km) of the pickup location, your status will **auto-advance to "At Shipper."** You'll see a small notification confirming the change.

If you arrive and the status doesn't auto-advance:

1. **Give it a minute.** GPS sometimes takes a moment to settle.
2. **Refresh the Status tab.** Pull down to refresh.
3. **Manually update.** Tap the next status in the stepper. You'll be asked for a brief reason; "auto-update missed" is fine.

The geofence is not perfect. Dense urban areas, parking lots, big buildings — all of these can interfere with GPS. Manual updates are a normal part of the workflow.

## At the shipper

When you check in with the shipper, update status to **Loading** if it isn't already there. (Some workflows skip Loading and go straight from At Shipper to In Transit — your dispatcher will tell you the convention if it differs.)

While they're loading, you can:

- **Message dispatch** if there's a problem (wait time, damaged seal, missing paperwork).
- **Log expenses** if you paid for anything (scale ticket, lumper, etc.).
- **Walk around the truck** for your pre-trip inspection.

Don't leave the shipper until they've signed your BOL.

## Leaving the shipper

When you pull out, your status auto-advances to **In Transit.**

If you have a BOL from the shipper (a "pickup signed" copy), you can photograph it now — but most drivers wait until they have the receiver's signature too, then upload everything at once. Either is fine.

## On the road

The drive itself is just driving. The LogisX app does its thing in the background:

- GPS reports your position every 60 seconds (or every 50 meters of movement, whichever is more frequent).
- The customer's tracking link shows your live progress.
- Dispatch can see where you are.

You don't need to do anything in the app while driving. Eyes on the road.

If dispatch messages you on the way, you'll see a badge on the **Messages** tab. **Pull over before responding.**

## Arriving at the receiver

Same as pickup: when you get within ~1000 m, status auto-advances to **At Receiver.** If it misses, manually update.

When you check in with the receiver, update to **Unloading** if your workflow uses that step. (Some don't — fine either way.)

## Getting the BOL signed

This is the most important part of the delivery, because the signed BOL is your **Proof of Delivery (POD)** and you have to upload it to get the load closed.

What to make sure happens:

- **Signature** of the receiver (legible, full name).
- **Date and time** of delivery.
- **Any damage notes** the receiver makes.
- **Stamp** if the receiver uses one.

Get the signed BOL into your hands before you pull out of the dock. Don't leave it in the trailer.

## Uploading POD

Once you have the signed BOL:

1. Open the load on your phone (Status tab or Loads tab → tap the load).
2. Tap **Upload POD.**
3. Choose **Take photo** to use your camera, or **Choose from gallery** if you've already photographed it.
4. **Frame the BOL** so the whole document is visible, including the signature and any stamps. Make sure it's well-lit and not blurry.
5. Tap to capture, then **Upload.**

The photo uploads, the app converts it to a PDF, and dispatch is notified. Your status advances to **POD Received** (or **Delivered**, depending on the workflow).

![Driver POD upload](screenshots/driver-pod.png)

If you have **multiple BOL pages**, repeat the upload for each. The app stores them all on the load record.

If the upload fails:

- Check signal strength. Weak signal kills photo uploads.
- Try again from the same screen.
- If it keeps failing, **text or email the BOL** to dispatch as a fallback. They can upload it from their side.

## Done

Once POD is uploaded:

- The load is closed from your perspective. You're free to take your next assignment.
- The load shows on your **Completed Loads** view.
- It will appear on your next weekly invoice.

If dispatch needs anything else (a particular note about the load, a follow-up about damage), they'll message you. Otherwise, that's it.

## What happens after

A few things in the background once POD is uploaded:

- **Your status** is updated everywhere — admin dashboards, the customer's public tracker, the broker's view.
- **Your driver pay** for this load is accrued. (Calculated based on either daily rate or owner-operator percentage — see Getting Paid.)
- **Your invoice** for the current week is updated.

You don't have to do anything for any of this. The system handles it automatically.

Now go take your break, drink some water, and check the Loads tab for what's next.
