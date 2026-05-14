# Driver Guide

This chapter walks you through everything you'll do as a driver in LogisX, from first sign-in to delivered load.

## The first time you sign in

After your application is accepted, you'll receive your username and a temporary password. Sign in at **app.logisx.com**. The first thing you'll see is the **Onboarding Lock** — a full-screen panel that blocks the rest of the app until you complete the required onboarding steps.

![Driver onboarding lock](screenshots/driver-onboarding.png)

Onboarding has these steps:

1. **Sign onboarding documents.** A list of agreements appears (equipment policy, mobile policy, substance abuse policy, independent contractor agreement). Tap each one in turn, read the document, check the acknowledgement box, type your full name as your signature, and tap **Sign**. The system generates and stores a signed PDF copy for the company's records.

2. **Pre-employment screening.** Your administrator schedules this — you'll see a status indicator on the onboarding panel showing whether it's pending or complete.

3. **FMCSA Clearinghouse enrollment.** You enroll on the FMCSA site directly and grant LogisX permission to query your record. Your administrator verifies the permission and marks this step complete.

4. **Driver training.** When training is assigned, you'll see the requirement on the onboarding panel; the administrator marks it complete after you finish.

Once every step shows green, the lock screen disappears and you have full access to the driver app.

## How location works

You don't need to grant the driver app location permission. Your truck's **Routemate ELD** is the location source — it reports the truck's position to LogisX continuously, whether the driver app is open or not. That position powers:

- Your current position on the dispatcher's tracking map.
- Auto-advance of load status when you arrive at the shipper or receiver (geofencing).
- The real-time tracking link the customer can share.

If your tracking position looks wrong, the issue is on the ELD side, not the app — let dispatch know and they can check the device.

## The five tabs

The driver app has five tabs across the bottom (or top on tablets):

1. **Loads** — your assigned and pending loads.
2. **Status** — quick status update for your current load.
3. **Alerts** — notifications about new loads, messages, and reminders.
4. **Kit** — your truck's documents (registration, insurance, inspections) and onboarding documents.
5. **Messages** — chat with dispatch.

![Driver loads tab](screenshots/driver-loads.png)

Move between tabs by tapping them. Each tab shows a small badge with a count when something needs your attention (e.g., "Loads (1)" means you have one new load awaiting your response).

## Accepting or declining a load

When a dispatcher assigns you a load, it appears on the **Loads** tab with **Accept** and **Decline** buttons. The card shows the Load ID, pickup and delivery locations, dates, and the rate.

Read the card carefully. If you can take the load, tap **Accept**. The status changes to "Dispatched" and the load moves to your active list.

If you can't take it, tap **Decline**. The load returns to the job board and the dispatcher is notified to reassign. **Use this honestly** — declining a load isn't a problem if you have a legitimate reason; accepting one you can't actually run is.

## Reporting status as you go

The **Status** tab shows your current active load with a status stepper. The expected progression is:

```
Dispatched → At Shipper → Loading → In Transit → At Receiver → Unloading → Delivered → POD Received
```

Most transitions happen automatically:

- When you enter the **geofence around the pickup location** (about 500 m), your status auto-advances to **At Shipper**.
- When you leave the pickup area, it advances to **In Transit**.
- When you enter the dropoff geofence, it advances to **At Receiver**.

The geofence isn't perfect. If you're at the location but the app didn't auto-advance, tap the next status in the stepper to update it manually. You'll be asked for a brief reason — anything like "auto-update missed" is fine.

> **Tip.** You can also update the status from the load card on the Loads tab — tap the load and pick a status. Both routes do the same thing.

## Uploading proof of delivery (POD)

After you deliver, you need to upload the signed bill of lading or proof-of-delivery document. From the load detail screen, tap **Upload POD** and either:

- **Take a photo** with your phone's camera.
- **Choose from gallery** if you've already taken it.

The app uploads the photo, converts it to a PDF, and stores it. Dispatch is notified the moment the upload completes. The load status advances to **POD Received**.

![Driver POD upload](screenshots/driver-pod.png)

You can upload multiple PODs per load if you have several pages. Once uploaded, you can't delete them yourself — ask dispatch if you need a correction.

## Logging expenses

The **Kit** tab includes an **Expenses** section where you log fuel, repairs, tolls, scale tickets, and other trip-related costs. To log:

1. Tap **Add Expense**.
2. Photograph the receipt. The app uses AI to read the amount, date, vendor, and (for fuel) the gallons and odometer. Fields populate automatically — confirm them.
3. Pick an expense type if it wasn't detected correctly.
4. Tap **Save**.

Your expense appears in the list with a "Pending" status until an admin reviews it. Approved expenses count against trip costs.

If the AI reads the receipt wrong (it happens with crumpled or blurry photos), just edit the fields before tapping **Save**. The auto-fill is a convenience, not a requirement.

## Messaging dispatch

The **Messages** tab is a chat with your dispatcher. You can:

- **Type a message** in the box at the bottom and tap **Send**.
- **Attach a photo** by tapping the paperclip icon (useful for sending a picture of an issue you've spotted).
- **See unread messages** — the Messages tab shows a badge when new messages arrive.

Messages are organized by load when applicable. If your dispatcher messages you about a specific load, the conversation thread appears on the relevant load card too.

## Viewing your invoices

The **Kit** tab also has an **Invoices** section showing your weekly pay invoices. Each invoice lists the loads, days worked, base pay, any adjustments, and the total. You can download each invoice as a PDF for your records.

If something looks wrong on an invoice, message dispatch with the invoice number and what you're disputing. Admin can issue a correction.

## Viewing your truck's documents

The **Kit** tab's **Documents** section shows the documents your administrator has shared with you for the truck you're currently driving:

- Registration
- Insurance card
- Annual inspection
- Any other documents dispatch has flagged "driver-visible"

You can view these documents inline (they open in your browser) — handy at a weigh station or roadside check. You cannot download them, only view, by design.

When you're reassigned to a different truck, the document list changes automatically to show that truck's documents.

## Common situations

**"I declined a load by accident."** Message dispatch right away — they can re-offer it to you if you both agree.

**"My GPS shows the wrong location."** Your position comes from the truck's Routemate ELD, not your phone. If the position is wrong or stuck, message dispatch with the load ID so they can check the ELD device.

**"My status didn't auto-advance when I got to the shipper."** Tap the status manually. The geofence sometimes misses, especially in dense urban areas with poor GPS.

**"I lost cell signal and now my status is wrong."** The app will catch up when signal returns — your reports queue locally. If something is still out of sync after you regain signal, message dispatch with the load ID.

**"I don't see a load that I know was assigned to me."** Pull-to-refresh the Loads tab. If it still doesn't show, the assignment may have been cancelled — ask dispatch.

**"I can't log in."** Double-check the username — they're case-sensitive. If you're sure it's right, ask dispatch to reset your password.

## What you can't do (by design)

- **You can't see other drivers' loads or status.** The app shows only your own work.
- **You can't see financial details** for other drivers or for the company.
- **You can't edit load details** (broker, rate, addresses) — those are managed by dispatch.
- **You can't delete an expense** after submitting it. You can ask dispatch to reject it if it's wrong.

If something feels missing, it probably is — and it's usually because that function belongs to dispatch, not to you. Message them.
