# Driver Applications

When someone applies to drive for LogisX, their application lands on the Applications screen for your review. This chapter is how to read an application and what happens when you approve or reject.

## Where applications come from

Public applications come from the form at `app.logisx.com/apply`. Anyone with the URL can submit — no account required. The form has rate-limiting to prevent abuse (10 submissions per 15 minutes per IP).

Each submission creates a row in the `job_applications` SQLite table and appears on the Applications screen.

## Opening Applications

Sidebar → **Applications**. You'll see a list of pending applications:

- Applicant name.
- Submission date.
- Status — Pending, Approved, Rejected.
- Quick contact info.

![Applications](screenshots/admin-applications.png)

Filter by status to focus on what needs review.

## Reading an application

Click into an application to open the full detail. The application has sections matching what the applicant filled in:

**Personal info:**
- Full name (legal).
- Email.
- Phone.
- Date of birth.
- Address.

**Driving history:**
- Years of CDL experience.
- Equipment types (dry van, reefer, flatbed, HAZMAT, tanker, etc.).
- Accidents in the last X years.
- Moving violations.
- DUI history.

**Certifications:**
- CDL class (A, B, C).
- Endorsements (H, T, N, X, P, S).
- Medical card status and expiration.
- HAZMAT certifications.

**References:**
- 2-3 professional references with phone numbers.

**Prior employment:**
- Carriers worked for.
- Dates.
- Reasons for leaving.

## What to look for

A few things that matter:

**Honesty signals.**
- Do the dates of employment have gaps that aren't explained?
- Are accidents and violations consistent with what FMCSA Clearinghouse will show later?
- Do the references list real people we can call?

If the application has obvious lies or omissions, lean toward rejection. A driver who fabricates an application will probably fabricate other things too.

**Experience signals.**
- Years of experience match the type of work we're hiring for?
- Equipment types match what we run?
- Endorsements match the freight we typically haul?

**Compliance signals.**
- CDL valid?
- Medical card current?
- HAZMAT cert current if relevant?
- Clean recent record (last 3 years)?

## Downloading the application PDF

Click **Download PDF** on the application detail. You get a formatted PDF with all the application data, suitable for:

- **Records** in case the digital record is ever lost.
- **Printing** for offline review.
- **Sharing** with someone offsite who needs to look at it.

The PDF is generated on demand from the latest application data.

## Approving an application

Click **Approve**. Several things happen automatically:

1. The application status changes to Approved.
2. A new driver record is created in the drivers directory.
3. A new user account is created with role Driver.
4. The user's `driver_name` is linked to the new driver record.
5. A welcome email is sent to the applicant with their username and temporary password.
6. The driver onboarding flow is initialized (the lock screen they'll see on first sign-in).

Before approving, **make sure everything is right**:

- The legal name is exactly as you want it stored (no typos).
- The email is correct (the welcome email goes there).
- The carrier name (if you want to assign immediately) is correct.

After approval, you can edit the user record, drivers directory record, or onboarding state, but it's cleaner to get it right at approval.

## Rejecting an application

Click **Reject**. The application status changes to Rejected.

You can (and should) add a brief reason. The applicant doesn't see the reason — it's for internal records — but it's useful for:

- **Audit** — why was this person not hired?
- **Future reference** — if they re-apply.
- **Patterns** — are we rejecting for consistent reasons?

There's no automatic email sent on rejection. If you want to notify the applicant, send an email manually or have HR do it.

## When an application is unclear

Don't approve or reject on the spot. Options:

**Call the applicant.** Sometimes a phone call resolves ambiguity in 5 minutes — clarify dates, ask about the gap, etc. If the answer is satisfactory, approve.

**Call references.** Old-school but reliable. A 5-minute call to a former supervisor gives you context the application can't.

**Run a background / driving record check.** Outside the app, but standard hiring practice. Cost is minor.

**Wait for FMCSA Clearinghouse query.** The pre-employment query is mandatory before hiring; you'll see prior testing history.

Don't approve under uncertainty. A questionable hire is harder to fire than to decline upfront.

## The onboarding flow

After approval, the driver:

1. Receives the welcome email.
2. Signs in on their phone.
3. Sees the onboarding lock screen (they can't access loads yet).
4. Walks through:
   - **Document signing** — equipment policy, mobile policy, substance policy, contractor agreement.
   - **Drug test** — you schedule the appointment; they go.
   - **FMCSA Clearinghouse enrollment** — they enroll, grant LogisX query permission; you verify.
   - **Training** — if assigned; they complete; you mark complete.

You monitor their progress from Sidebar → **Applications** → their record → onboarding tab (or similar in the UI).

When all steps are complete, the lock disappears and the driver can run loads.

## What if an applicant doesn't sign in

Sometimes a new hire never shows up — they got a different job, changed their mind, etc.

If they don't sign in within a week of approval:

1. Call them. Confirm they still intend to start.
2. If they're not interested, demote / remove their account.
3. If they want to start but haven't gotten around to it, send another welcome email (or share the temporary password again).

Don't let stale "approved but not started" accounts accumulate. They clutter the user list and waste your attention.

## Re-applications

If someone applies again after a rejection (or never starting), the second application is a fresh row. The system doesn't auto-detect "this is the same person." You may want to:

- **Look up their previous application** (search by name) to see what was decided last time.
- **Decide whether the prior reason still applies.**
- **Approve or reject anew.**

Rejecting a re-application is fine if the situation hasn't changed. Approving a previously-rejected person is fine if you have a reason (different role, more experience, gap addressed).

## Bulk applications

Mass-hiring events are rare. If you have 10 applications to review at once:

1. **Skim all 10 first.** Get a sense of the batch.
2. **Reject obvious passes** (incomplete, no CDL, bad fit).
3. **Approve obvious wins** (experienced, clean, matching equipment).
4. **Take time on the middle group.** Phone calls, reference checks.

A batch shouldn't change your standards. Rushing approvals to clear the queue creates problems later.

## Pro tips

- **Quote the application's text** when calling a reference. "John's application says he worked for you from June 2024 to March 2025 — is that right?" Catches lies quickly.
- **Keep a small mental list** of red-flag patterns. The list grows over time.
- **Don't approve on Fridays.** A driver hired Friday afternoon has no momentum until Monday. Hire Monday for the best start-of-week energy.
- **Talk to dispatch** about hiring needs. They know the gaps better than the org chart suggests.
