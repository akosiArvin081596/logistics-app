# Audit Trail

The audit trail records every administrator action in the system. It's how you (and anyone else with audit access) reconstruct what happened and who did it. This chapter is how to use it.

## What's logged

The `audit_trail` SQLite table records administrator-significant actions:

- **User CRUD** — created, edited, deleted, role changed, password reset.
- **Driver renames** — old name and new name.
- **Load cancellations.**
- **Load soft-deletes.**
- **Invoice approvals and rejections.**
- **Expense approvals and rejections.**
- **Application approvals and rejections** (driver and investor).
- **Routemate syncs.**
- **Admin Tools operations** (scans, fixes, batch removes).
- **Several other less-frequent actions.**

Each entry includes:

- `action` — a short slug describing what happened (e.g., `user_created`, `driver_renamed`, `load_soft_deleted`).
- `user_id` — who did it.
- `target` — what was affected (load ID, user ID, "all" for bulk operations).
- `details` — JSON blob with before/after where applicable.
- `created_at` — UTC timestamp.

## Opening the audit trail

Sidebar → **Admin → Audit Trail** (path may vary). Super Admin only.

You'll see entries sorted newest first. Filters typically include:

- **Date range.**
- **Action type** (one of the slugs above).
- **User** (who did it).
- **Target** (what was affected).

## When to use it

A few common scenarios:

**"Who approved this invoice?"**
Filter by action = `invoice_approved`, target = invoice ID.

**"When was this user deleted?"**
Filter by action = `user_deleted`, target = the username.

**"What happened to this load?"**
Filter by target = Load ID. Multiple entries show the load's history (status changes, reassignments, cancellation, etc.).

**"What did Super Admin X do this week?"**
Filter by user = their user ID, date range = the week.

**"Are there any suspicious actions in the last 24 hours?"**
Filter by date range = last 24 hours, scan for unusual entries (multiple deletes, after-hours password changes, etc.).

## Reading entries

Each entry has the columns described above. The `details` JSON varies by action:

For `user_created`:

```json
{
  "username": "newuser",
  "role": "Driver",
  "linked_driver": "John Smith"
}
```

For `driver_renamed`:

```json
{
  "old_name": "Lesline Jonhson",
  "new_name": "Lesline Johnson",
  "rows_updated": {
    "job_tracking": 86,
    "carrier_database": 1,
    "load_responses": 12,
    "load_ratings": 4
  }
}
```

For `load_soft_deleted`:

```json
{
  "load_id": "LD-3492",
  "reason": "Duplicate from re-sent rate confirmation"
}
```

Reading the JSON gives you the full picture of what changed.

## Audit retention

There's no scheduled retention or purge. Entries accumulate indefinitely. Over years, the table will grow but it's small (a few KB per entry); the storage cost is negligible.

If you ever need to prune (regulatory compliance, performance), it's a manual operation — but rare.

## Audit trail vs. notifications

Both record events but for different audiences:

- **Notifications** are user-facing summaries. Real-time, conversational ("a new load arrived").
- **Audit trail** is administrator-facing detail. Historical, technical ("user X with ID Y created user Z with role W at timestamp T").

For most diagnostic work, audit trail is more useful. For real-time awareness, notifications.

## Audit trail vs. status logs

Two different logs:

- **Status Logs sheet** records every load's status change, including who changed it.
- **Audit trail** records administrator actions, including some that touch loads (cancellation, soft-delete) and many that don't.

Some events appear in both. A load cancellation, for example, writes to both:

- **Status Logs** records the status transition to `Cancelled`.
- **Audit trail** records the admin action `load_cancelled` with the user and reason.

When investigating a load's history, look at both.

## Cross-referencing with other data

A few common joins:

- **User ID to username.** The `user_id` in audit trail is the database ID. Join to the users table to get the username and full name.
- **Load ID to current state.** The audit trail says "load LD-3492 was cancelled at time T." Look at the current Job Tracking row to see the load's state now.
- **Timestamps across systems.** Audit trail is UTC. Other systems may be in local time. Convert when comparing.

## Privacy

The audit trail is sensitive:

- It reveals who did what — potentially embarrassing if reviewed in the wrong context.
- It contains user information.
- It may contain financial events (invoice approvals, expense decisions).

Treat audit trail data with care. Don't export and share broadly. Don't expose to non-Super-Admin users.

## When to actively review

**Daily:** No. The dashboard's notifications surface what needs immediate attention.

**Weekly:** Optional. A 5-minute scan of significant actions (cancellations, role changes, large invoice approvals) catches surprises.

**Monthly:** Recommended. A more thorough review for unusual patterns.

**On demand:** When something specific needs investigation.

## Outputs of audit review

Audit reviews typically result in:

- **No action.** Most reviews find nothing surprising.
- **Conversation.** "Hey [other Super Admin], can you walk me through this driver rename?" Usually clarifies quickly.
- **Documentation.** A small write-up of what was found, for record.
- **Process change.** If audit reveals a recurring issue (e.g., dispatchers escalating cancellations vs. you forgetting), adjust the workflow.

Audits are a safety net, not a witch-hunt. Frame them constructively.

## Querying the table directly

For complex queries, use Database Admin → query audit_trail:

```sql
SELECT action, target, created_at, details
FROM audit_trail
WHERE user_id = 5
  AND created_at > datetime('now', '-7 days')
ORDER BY created_at DESC;
```

(Note: SQLite `CURRENT_TIMESTAMP` returns UTC; comparisons should account for that.)

Direct SQL gives more flexibility than the UI filters. Use for ad-hoc analysis.

## Audit trail integrity

The audit trail itself is database data. In theory, someone with database access could edit or delete entries. Mitigations:

- **Super Admin is a small role** — few people have direct database access.
- **The audit trail records edits to itself** (if someone tries to alter it, the alteration is logged).
- **Database backups** exist independent of the audit trail.

In practice, the audit trail is reliable for LogisX's scale. For a regulated industry needing tamper-evidence, you'd need an immutable log or signed entries — overkill for current operations.

## Pro tips

- **Bookmark the audit trail page.** You'll visit it more than you expect.
- **Train yourself to look at audit before asking.** "Did anyone delete this user?" is faster to answer via audit than via Slack message.
- **Use audit to validate suspicions.** When something feels off, audit trail confirms or denies.
- **Don't share specific audit entries casually.** They're often sensitive. Summarize when discussing externally.
