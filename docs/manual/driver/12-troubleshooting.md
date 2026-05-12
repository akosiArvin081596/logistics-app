# Troubleshooting

The most common things that go wrong, in roughly the order you'll hit them.

## "I can't sign in."

Check, in order:

1. **Caps lock.** Username and password are case-sensitive.
2. **Right URL.** `app.logisx.com`, not the marketing site `logisx.com`.
3. **Recent password change.** If you changed your password recently and now can't sign in, the change may not have saved correctly — ask dispatch to reset it.
4. **Locked out from failed attempts.** After several wrong passwords, the system temporarily blocks you. Wait 15 minutes.

If none of those, message dispatch.

## "My password worked yesterday but doesn't today."

Either:
- You changed it and forgot. Try your previous one.
- An administrator reset it (would happen after a security event or your request).
- Your account was disabled. Ask dispatch.

## "The page is blank."

1. Refresh the page (pull down on mobile, or tap the refresh icon).
2. Sign out and sign back in.
3. Clear your browser's cache for `app.logisx.com`.
4. Try a different browser.

If you've done all that and the page is still blank, message dispatch — there may be a server-side issue.

## "I see the 'Location Access Required' screen but I'm sure I granted location."

This means the browser's permission has reverted to denied or "ask every time." Re-grant:

- **Chrome (Android):** tap the lock icon in the address bar → Permissions → Location → Allow.
- **Safari (iPhone):** Settings → Safari → Location → Allow. And Settings → Privacy → Location Services → make sure it's on for Safari.

Then refresh the page.

## "My GPS shows the wrong location."

1. **Is the LogisX tab open?** GPS pauses if the tab is closed.
2. **How's your signal?** Weak signal = inaccurate or stale GPS.
3. **How long since you came out from indoors?** Phone GPS takes 30-60 seconds to re-acquire after being inside a steel warehouse.
4. **Is your phone hot?** Throttled phones can have erratic GPS.

Move outside, stand still 30 seconds, refresh the page. Position should resolve.

## "I'm at the shipper but the status didn't auto-advance."

Normal. Geofences miss sometimes, especially in industrial areas with weak GPS or addresses that aren't precisely set.

**Update manually.** Status tab → tap the next status. Give a brief reason ("auto missed").

## "I'm not at the shipper but the status auto-advanced anyway."

You probably drove past the geofence area. Common at truck stops or gas stations adjacent to the shipper.

**Update manually back** to the previous status. The app will let you go backwards if you give a reason.

## "I declined a load by accident."

Message dispatch right away. They can re-offer it if both of you agree. The decline isn't permanent.

## "I accepted a load and it disappeared from my list."

Pull-to-refresh the Loads tab. If it's still gone:

- The assignment may have been cancelled by dispatch.
- The load may have been reassigned to another driver.
- Your account may have been logged out and re-logged with stale data.

Message dispatch to confirm what's going on.

## "I uploaded a POD but the system says it didn't upload."

Try once more. If it keeps failing:

- **Check signal.** Weak signal kills photo uploads (large files).
- **Try a smaller photo.** If your camera shoots at maximum resolution (huge files), the upload may be timing out. Most phones have a setting to reduce photo size.
- **Use Wi-Fi if available.** Truck stops often have free Wi-Fi.
- **As a last resort:** text or email the POD to dispatch. They can upload it from their side.

## "The POD upload says 'success' but dispatch can't see it."

Rare but possible. Two checks:

- **Refresh the load** on your side. Does the upload still show in the documents list?
- **Try uploading again.** A second upload is fine — both PODs will be on the record.

If dispatch still can't see anything, escalate.

## "My expense OCR read the receipt wrong."

Edit the fields before saving. The OCR is a convenience; you're the final authority. If a specific vendor's receipts are consistently misread (some thermal printers are hard to OCR), let dispatch know — they can flag the issue.

## "The expense form won't let me save."

Common causes:

- **Required field missing.** Check that Type, Amount, and Date are all filled in.
- **Photo upload pending.** If you took a photo and it's still uploading in the background, the form may be waiting. Give it a few seconds.
- **Bad signal during save.** If your signal drops mid-save, the form gives up. Try again on better signal.

## "My invoice is missing a load I ran."

The load may be:

- **Not yet rolled into this week's invoice.** Invoices generate weekly; a load delivered Saturday night may land on next week's invoice depending on the cutoff.
- **Attributed to the wrong driver.** The driver name on the load might be a typo or assigned to someone else. Message dispatch with the load ID.
- **Cancelled or soft-deleted.** A load that was cancelled drops out of invoice math. If you ran a load that someone later cancelled (rare), it'll be off the invoice.

Message dispatch with the load ID and the period you expected it on.

## "My pay total looks wrong."

Don't just complain — be specific. Check:

1. **Are all your loads listed?** Count them, compare to what you remember.
2. **Are the active days right?** For daily-rate pay, count the calendar days each load actually spanned.
3. **Are the rates right?** For owner-op, compare to what the rate con showed for each load.

Then message dispatch with the specifics. "Load LD-3492 ran Mon-Wed but invoice shows 2 days, should be 3" is easy to verify and fix.

## "The map doesn't load."

Maps use Google's API. If they don't load:

- Check your connection. Maps need a moderately good signal.
- Refresh.
- If maps don't load anywhere in the app for hours, escalate — there may be a Google API issue.

## "I lost cell signal and now my updates didn't go through."

The app **queues** position reports and other small updates locally when offline, then sends them in a burst when signal returns. You don't have to do anything; just wait.

POD photo uploads are **not** queued — they retry once, then fail if signal is bad. You have to manually retry from the same screen when signal is back.

## "I closed the tab and now nothing is updating."

Open the tab again. GPS will resume reporting within a minute. Status will refresh on the first navigation.

If you've been away for an hour or more, refresh the page completely (don't just open the cached version).

## "My phone died, came back up an hour later, app is acting weird."

Sign out and back in. This resets any stale state in the browser.

## "Dispatch isn't responding."

If it's during their business hours and they haven't replied in 30+ minutes, **call.** Don't keep messaging into the void.

If it's after hours (evening, weekend) and you have a real issue, use the after-hours phone line. Dispatch told you the number during onboarding; check your email for it.

## "I think the app crashed."

Browser apps don't really "crash" the way installed apps do — they just stop responding or show an error. Refresh first. If refresh doesn't help, sign out and back in. If that doesn't help, restart your phone.

## "Something is wrong that's not in this list."

Message dispatch with:

- What you were trying to do.
- What you saw instead (a screenshot helps).
- The load ID involved if any.
- Whether it's blocking your work right now.

That's enough information for dispatch to start investigating.

## When to escalate

If dispatch can't resolve an issue, they'll escalate to LogisX technical support. You don't need to bypass dispatch and contact tech support yourself — that's their workflow.

The exception: in a true emergency (truck broken down on a highway, accident, medical issue), call 911 first, then dispatch, then anyone else.
