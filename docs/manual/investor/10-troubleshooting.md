# Troubleshooting

Common investor dashboard issues and what to do about them.

## "I can't sign in."

Standard checks:

- **Caps lock off?** Username and password are case-sensitive.
- **Right URL?** `app.logisx.com`, not the marketing site `logisx.com`.
- **Recent password change?** If the change didn't save correctly, contact operations.
- **Brute-force lockout?** After multiple failed attempts, the system blocks for 15 minutes. Wait.

If none of those, message operations or call.

## "I see the wrong dashboard."

If you signed in but see a different view than expected:

- **Driver app at `/driver`?** Your role got changed. Message operations.
- **Operations dashboard at `/dashboard`?** Same issue.
- **Blank or error page?** Refresh. If still wrong, message operations.

Your role should be **Investor**. Verify in your profile.

## Dashboard data issues

**"My earnings are showing $0 for a month I know my fleet was running."**

Three things to check, in order:

1. **Your company_name field.** From your profile, verify it matches the carrier name on your trucks' records. Spelling matters (case-insensitive but no typos).

2. **The Owner ID on the loads.** Loads should have your investor record ID in their Owner ID column. If they don't, attribution fails.

3. **Recent cancellations.** A load that was cancelled drops out of revenue. If many of your loads were recently cancelled, your earnings will reflect that.

If all three look right and earnings are still $0, message operations with specifics.

**"My earnings are much lower than expected."**

- **Cancelled loads** drop out (verify status on each load).
- **Date attribution** — a load assigned in March counts in March (not April when it delivered).
- **Driver pay multi-day** — a 3-day load = $750 in driver pay for daily-rate drivers, not $250.
- **Pending expenses** that get approved later reduce your earnings retroactively.

Drill into the dashboard breakdown to see exactly where the math went.

**"My monthly view and all-time view don't add up exactly."**

Common cause: loads with incorrect pickup or dropoff dates. The date affects active-day counts, which affect driver pay, which affects net profit.

If a load was assigned in April but its pickup date in the system shows 2021, the load's revenue counts in April but its active days count toward 2021. The math doesn't reconcile.

Message operations to verify the dates and fix if needed.

**"Fleet Breakdown shows a truck I don't own."**

Possible mistake in the Owner ID. Operations can fix.

**"A truck I do own isn't showing."**

Same — Owner ID mismatch. Operations can fix.

**"The mileage on a truck looks wrong."**

LogisX tracks mileage from fuel receipts and driver reports. If the dashboard shows much less mileage than reality, the data may be lagging. Message operations to update.

**"A truck shows as Maintenance but I haven't been told."**

Maintenance status is set by operations when a truck is in the shop. If you weren't informed:

- The maintenance may have been a quick service (planned).
- Communication may have been missed on operations' side.

Either way, ask. Operations can tell you what's happening with the truck.

## Reports and downloads

**"The Download Report button doesn't do anything."**

Refresh the page. Try again. If the PDF doesn't download, check your browser's pop-up blocker — some browsers block PDF downloads.

If still not working, your file size limit may be exceeded (rare). Message operations.

**"The downloaded PDF is corrupted or won't open."**

Try downloading again. PDFs sometimes get corrupted in transit. If repeated downloads are corrupted, escalate.

**"The PDF report shows different numbers than the dashboard."**

Possible reasons:

- **Different date ranges.** Verify both views are using the same range.
- **Different generation times.** The dashboard updates live; the PDF locks numbers at generation time. Expenses approved between generation and view will show on dashboard but not on the older PDF.

Regenerate the PDF if the dashboard has newer data.

## Documents and portal

**"A document I signed isn't showing in my portal."**

- **Refresh the page.** Sometimes documents lag a few seconds.
- **Check the right section.** Documents are categorized; look in onboarding, operating, and reports separately.
- **Message operations.** If it's truly missing, they can re-attach.

**"A document is showing as corrupted or won't view."**

- **Refresh.**
- **Download and open in a separate PDF viewer.**
- **If still bad, message operations** — the file may need re-uploading on their end.

**"My W-9 wasn't accepted (received wrong tax info)."**

If the 1099 you received has wrong information (wrong TIN, wrong address, wrong amount):

- Compare to your records.
- Message operations to flag the discrepancy.
- They issue a corrected 1099-NEC if appropriate.

## Messaging issues

**"My messages aren't being delivered."**

Refresh the page. If you sent a message and it's still showing as "sending" after a minute, the connection may have dropped. Refresh and try again.

If the message went but operations didn't see it, that's a different issue — escalate.

**"Operations hasn't responded in hours."**

During business hours, response should be within 1-2 hours. If longer:

1. Send a follow-up message.
2. If still no response after another few hours, call directly.

If it's after hours, expect delays.

## Truck and fleet issues

**"My truck shows as Available for days/weeks."**

A truck idle for an extended period is unusual:

- **Driver could be on extended leave** (vacation, medical, family).
- **Truck could be undocumented in maintenance** (operational issue not yet logged).
- **Dispatch capacity issue** — too few loads matching this truck.

Message operations to ask. Idle trucks are lost revenue.

**"I see expenses for a truck I don't own."**

Possible attribution error. Message operations.

**"A driver assigned to my truck isn't appearing in any system."**

Operations would know. Message them.

## Account and settings

**"Profile photo upload isn't working."**

Photo file too large? Try a smaller image. Format wrong? Use JPG or PNG.

**"Change password isn't saving."**

Try again. If still failing, escalate to operations.

**"I can't update my email or phone."**

These edits should work. If they don't, message operations.

## System-wide issues

**"The whole dashboard is slow."**

Could be temporary server load. Try again in a few minutes. The system caches aggressively; brief slowness usually resolves.

**"Nothing is updating in real time."**

The Socket.IO connection may have dropped. Refresh the page to reconnect.

**"I get logged out frequently."**

Sessions time out after extended inactivity. Sign back in. If you're being logged out within minutes (not hours), there may be a session issue — escalate.

## Calculation transparency

If a number doesn't make sense and you want to verify the math:

1. **Click into the breakdown row** (each line is clickable).
2. **See the underlying loads and expenses** that make up the number.
3. **Compare to your expectations** load by load.
4. **Identify the specific discrepancy.**
5. **Message operations** with the specific load IDs or expense IDs in question.

Don't argue with the dashboard. Argue with the data behind it.

## Tax form issues

**"My 1099 didn't arrive."**

Check spam folder. Check your Document Portal. If still not there by mid-February, message operations.

**"My 1099 has wrong information."**

Operations can issue a corrected 1099-NEC. Provide the specific discrepancy.

**"I need a K-1 but got a 1099."** (or vice versa)

Possibly a tax structure mismatch. Message operations and your CPA to determine the correct form.

## Escalation

If operations can't resolve:

- **Call directly.** Voice resolves things faster than chat.
- **Escalate to LogisX leadership.** Senior contacts can intervene.
- **Refer to your contract** for dispute resolution if needed.

Issues that escalate are rare — most things resolve in conversation. But when they don't, you have paths.

## What to have ready when you escalate

Provide:

- **The specific issue** (be precise).
- **What you saw on the dashboard** (screenshot).
- **What you expected to see** (if applicable).
- **Specific load IDs, expense IDs, or document references** involved.
- **Timeline** — when did you notice, how often does it occur.
- **Whether it's blocking** (urgent vs. routine).

The more specific, the faster the resolution.
