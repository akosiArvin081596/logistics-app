# Super Admin Best Practices

The patterns that separate effective Super Admins from those who create more problems than they solve.

## Discipline with destructive operations

**Pause before deletions.** Hard-delete is rarely the answer. Cancel or soft-delete first when possible.

**Verify before approving large items.** A $10K invoice or a $50K investor approval deserves more than 30 seconds of attention.

**Read before editing.** Open a record. Look at its current state. Only then make changes.

**Confirm dialogs are not obstacles, they're gates.** When the system asks "are you sure?", actually be sure.

## Consistency

**Use the dedicated workflows when they exist.** Users page for user CRUD. Expenses page for expense approvals. Invoices page for invoice approvals. Data Manager is the escape hatch, not the default.

**Don't shortcut around the audit trail.** Direct database edits bypass the trail. They should be rare and documented.

**Follow the role conventions.** Drivers in the Drivers role, Investors in the Investors role, Dispatchers in the Dispatcher role. Don't create cross-role accounts unless there's a clear reason.

**Username patterns.** Keep them predictable. Future-you will appreciate consistency.

## Communication

**Document decisions.** When you make an unusual call (custom investor split, expense exception, application reconsideration), note it somewhere visible (record notes, internal Slack, email log). Future-you forgets.

**Tell people when their work is approved or rejected.** Don't make drivers wonder about expense status. Don't make investors guess about onboarding. Send the message.

**Be specific in feedback.** "Application rejected" is unhelpful. "Application rejected — accident history within the last 12 months exceeds our risk tolerance" is actionable.

**Don't blindside dispatchers.** If you cancel a load they were managing, message them first or at least immediately after. They'll lose trust if loads disappear from under them.

## Working with the team

**Trust dispatchers' operational judgment.** They live in the day-to-day. When they say "this driver can run that load," they're probably right.

**Don't second-guess every decision.** Dispatchers make hundreds of micro-decisions a day. Mind the patterns, not each instance.

**Escalations are signals, not nuisances.** When a dispatcher escalates a cancellation, that's their job working right. Respond promptly.

**Use the chain of command appropriately.** Drivers escalate to dispatchers; dispatchers escalate to you; you escalate to leadership when needed. Don't skip layers.

## Working with drivers (when you do)

**You're not their primary interface.** Drivers should talk to dispatch by default. If you find yourself communicating with drivers regularly, dispatch may not be doing their job — or you're micromanaging.

**When you do communicate, be calibrated.** A note from a Super Admin carries more weight than one from dispatch. Use that weight sparingly.

**Don't override dispatch in front of the driver.** If you disagree with dispatch's decision, take it up with dispatch directly. The driver shouldn't see the disagreement.

## Working with investors

**You're often their main interface.** Investors talk to you about earnings, dashboards, contracts. Be available.

**Be transparent about numbers.** If an investor questions a calculation, walk them through it. Don't be defensive.

**Honor the contract terms.** The Master Participation Agreement is the source of truth for profit splits, responsibilities, and expectations. When in doubt, refer to it.

**Respect investor time.** They're not employees; they're partners. Don't waste their time with status updates that don't need their input.

## Data integrity

**Run scanners weekly.** Duplicate checks, mismatch checks, orphan checks. 10 minutes a week prevents hours of cleanup later.

**Fix typos at the source.** A wrong driver name on a load isn't fixed by editing each load — it's fixed by Fix Driver Name in Admin Tools.

**Don't tolerate stale data.** A truck assignment from a year ago that's still in the system, a driver who left months ago but is still in the user list, an expense category that's no longer used — clean up periodically.

**Verify exclusions work.** When you cancel a load, verify it dropped out of the dashboard. When you soft-delete, verify the same. Trust but check.

## Financial discipline

**Invoice approvals are a real decision.** Don't auto-approve. Don't bulk-approve without looking. Each represents someone's pay.

**Don't backdate approvals.** If an invoice should have been approved last week and you're approving it today, mark it with today's date. Backdating distorts the audit trail.

**Reconcile periodically.** Compare LogisX financials to your bookkeeping. They should be close — gaps are signals.

**Document special adjustments.** A bonus, a deduction, a layover pay — note the reason in the invoice. Future-you reading the audit trail will need it.

## Decision-making

**Reversible decisions get faster yeses.** Cancelling a load is reversible — say yes when in doubt. Hard-deleting is not — say no when in doubt.

**Defer ambiguous calls.** "Let me check on that and get back to you" is fine. Pretending to know is worse than admitting uncertainty.

**Sleep on hard decisions.** A driver-firing decision, a major investor decision, a structural change to the pay model — don't decide in heat. Sleep on it.

**Use the data when you can.** Audit trail, financial reports, historical patterns — let them inform decisions rather than gut feelings alone.

## Security

**Don't share Super Admin credentials.** Each Super Admin has their own account. The audit trail relies on individual accountability.

**Strong passwords.** 16+ characters. Unique to LogisX. Use a password manager.

**Sign out on shared devices.** If you sign in on a kiosk or someone else's machine, sign out before leaving.

**Be skeptical of unexpected resets.** If you get a "password reset" email you didn't request, contact technical support immediately. It might be social engineering.

**Audit user accounts periodically.** Old accounts are attack surface. Disable or remove the inactive ones.

## When things go wrong

**Stay calm.** Operational problems in trucking can feel urgent, but rare are truly emergent within the LogisX app. Most things can wait 5 minutes.

**Triage.** Which problems need to be addressed in the next hour? Which can wait until tomorrow?

**Communicate.** Tell affected parties what you know and what you're doing about it. Silence breeds anxiety.

**Document.** Even in the middle of a problem, write down key facts. Memory is unreliable; written records aren't.

**Don't blame.** A retrospective focused on "what happened and how do we prevent it" beats one focused on "whose fault is this."

**Escalate appropriately.** A bug in the app? Technical support. A legal question? Counsel. A leadership decision? Leadership.

## Career

**Build operational instinct.** The more time you spend with the data, the better your judgment gets. Look at the dashboard daily even when nothing demands it.

**Learn from dispatchers.** The dispatcher view is the operational ground truth. Spend time there occasionally.

**Stay curious about the business.** Understand why investors are investing, why drivers are driving, why the system is structured as it is. Context informs decisions.

**Develop relationships with the team.** Dispatchers, drivers, investors — they all see things you don't. Listen.

**Cross-train.** Make sure at least one other person can do critical Super Admin tasks. Single points of failure are bad.

## A note on speed

Super Admin work is slower than dispatcher work, and that's correct.

A dispatcher response in 5 minutes is good; a Super Admin decision in 5 minutes is often hasty. The dispatcher operates in immediate operational urgency; you operate in structural decisions that affect many things downstream.

Take the time. The system rewards careful work.
