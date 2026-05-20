# Uploading Proof of Delivery

The POD upload is the single most important manual step in the whole workflow. Without a POD, the load is not delivered — it sits in limbo until you (or dispatch) closes it. This chapter is how to do it right.

## What counts as a POD

A POD is a **signed Bill of Lading (BOL)** from the receiver. The signature confirms the receiver got the freight in the condition described. Standard contents:

- **Receiver signature** — legible, full name (or company stamp).
- **Date of delivery.**
- **Time of delivery.**
- **Any damage exceptions** noted by the receiver (e.g., "2 cases dented").
- **Receiver's printed name** alongside the signature.
- **Company stamp** if the receiver uses one (some warehouses do; not required if signed).

A clean signed BOL with no exceptions is the gold standard. A BOL with exceptions is still valid — it just means you and dispatch need to flag the damage for the broker.

## When to upload

**As soon as you have the signed BOL.** Don't wait until the end of the day. Uploading at the dock means:

- Dispatch knows the load is delivered.
- The broker can be invoiced immediately.
- You don't have to remember to do it later (or forget and have dispatch chasing you).

Best practice: tape the BOL to your dashboard, walk back to the cab, upload, then pull out.

## How to take a good POD photo

Bad PODs are the #1 reason an upload has to be re-done. Three rules:

1. **Get the whole document in frame.** All edges visible. Don't crop the receiver's signature.
2. **Lighting matters.** If you're at a dark dock, step into better light or use your phone's flash. A photo where you can't read the signature is useless.
3. **Hold still.** Blurry photos can't be processed. Brace your phone hand against your other arm or against the dashboard. Wait for autofocus to settle.

A few specific tips:

- **Flat on a surface** is easier than holding the document by hand. Put it on the dashboard, the seat, or the dock's clipboard.
- **Avoid glare.** If the BOL is printed on glossy paper or has a wet ink signature, angle the phone to avoid reflections.
- **Crop tight, but not too tight.** A small white border around the document is fine. Don't cut off anything important.
- **Try a second photo if the first looks bad.** Just retake — uploads aren't billed by attempt.

## The upload step by step

1. Open the load. From the **Status** tab (your current load) or **Loads** tab (any active load), tap the load to open its detail view.

2. Tap **Upload POD.** You'll see two options:
   - **Take photo** — opens your phone's camera directly.
   - **Choose from gallery** — opens your photo library if you already took the picture.

3. **Take or pick the photo.** Frame it as described above.

4. **Review.** A preview will show. If it looks bad, tap **Retake** and try again.

5. Tap **Upload.** The progress indicator shows the upload working. Most uploads take 5-15 seconds.

6. **Wait for the confirmation.** A green checkmark appears when the upload is complete.

The status will auto-advance to **POD Received** once the upload completes.

![POD upload screen](screenshots/driver-pod.png)

## Multi-page PODs

Some loads have more than one BOL — pallet manifests, lumper receipts, scale tickets that count as part of the delivery package. You can upload as many photos as you need.

For each additional page:

1. Tap **Upload POD** again from the load detail.
2. Take or pick the next page's photo.
3. Upload.

Each upload is a separate entry on the load's documents. Dispatch sees all of them.

A tip for multi-page jobs: photograph them in order (page 1, page 2, page 3) so the documents are easy to follow in dispatch's view.

## What happens after upload

When the upload completes:

- The photo is converted to a PDF on the server.
- The PDF is uploaded to Google Drive in LogisX's POD folder.
- A record is added to the load's documents list.
- Dispatch is notified.
- Your load status advances to **POD Received.**

The load is now functionally closed. Your work on it is done. The accounting team can invoice the broker; your dispatcher can release the load from active tracking.

## When the upload fails

The most common failure is "weak signal." If the upload spinner runs for more than 30 seconds, the signal probably isn't strong enough.

What to do:

1. **Check your signal bars.** If you have one bar or less, the upload won't make it.
2. **Move to better signal.** Even 100 feet can make a difference. Drive across the receiver's lot or up to the street.
3. **Try again.**
4. **As a fallback, text or email the photo to dispatch.** They can upload from their side. Get a confirmation back from them so the load doesn't sit in limbo.

The app will retry a failed upload automatically once, but after that, you have to manually try again.

## When the photo is bad

If you uploaded a blurry or poorly-framed POD, dispatch may ask you to upload a better one. They can see the photo from their side and decide.

You **cannot delete** a POD you uploaded — only add more. So if you uploaded a bad one, just upload a good one. The good one will be the working copy; the bad one stays as a "first attempt" record.

If dispatch isn't asking for a re-upload, the bad one was good enough for them. Don't worry about it.

## What if you forget to upload?

It happens. You unload, drive away, get a call about your next load 30 minutes later, and only remember the BOL at the next fuel stop.

Open the previous load (it'll still show in your active list because POD isn't uploaded yet) and upload from wherever you are. Dispatch will appreciate it before the day is out.

If you've lost the BOL — left it at the dock, blew out the window, dog ate it — call dispatch immediately. They have processes for this (typically the receiver can email a copy, or dispatch can take a verbal confirmation as a stopgap). Don't try to make it up.

## Some receivers' quirks

A few things you'll encounter:

- **Bagged BOLs.** Some receivers seal the signed BOL in a bag and tell you not to open it. In that case, photograph the bagged document — the receiver's signature should still be visible through the plastic.
- **Multiple-copy BOLs.** Some BOLs are 3-part or 4-part forms. You usually keep one copy and the receiver keeps another. Photograph the copy you keep (which should have the receiver's signature).
- **Stamped, not signed.** Some warehouses stamp the BOL with the company name instead of signing. That's typically acceptable as POD; upload as normal.
- **Digital BOLs.** A few receivers are moving to electronic POD systems. If they email you the signed BOL, save the email and upload the attachment via "Choose from gallery."

When in doubt, upload what you have and let dispatch make the call on whether it's enough.
