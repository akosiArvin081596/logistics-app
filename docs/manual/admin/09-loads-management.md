# Loads Management — Cancellation, Soft-Delete, Restoration

Sometimes a load needs to disappear from active operations. This chapter covers the three ways to make that happen and how each affects the audit trail.

## The three options

Three actions to "remove" a load, each with different semantics:

| Action | What happens | Reversible? | Use case |
|---|---|---|---|
| **Cancel** | Status → `Cancelled`. Stays in sheet for record. Excluded from KPIs. | Yes — change status back | Broker withdrew, force majeure, agreed mutual cancellation |
| **Soft-delete** | Row in `deleted_loads` table. Stays in sheet. Excluded from all admin views and KPIs. | Yes — remove from `deleted_loads` | Errors, duplicates, fraud, internal test loads |
| **Hard-delete** | Row removed from sheet entirely. | No (without backup) | Almost never. Reserved for emergencies. |

You'll use **Cancel** and **Soft-delete** routinely. **Hard-delete** almost never.

## Cancelling a load

A cancellation is a legitimate business event: the broker called and said the load fell through, or you mutually decided to end the run.

How to cancel:

1. **Open the load** from Active Loads (or Job Board).
2. **Click Cancel.**
3. **Confirm.**

The status is set to `Cancelled`. The load:

- **Stays visible** on the dashboard in the completed/all-loads tabs (depending on filters).
- **Drops out of revenue calculations** (excluded by the `excludeDroppedLoads` helper).
- **Drops out of driver pay calculations.**
- **Drops out of investor earnings.**
- **Drops out of financial reports.**

The status is preserved as `Cancelled` so the cancellation is auditable. If you ever need to "undo" the cancellation:

1. Open the load.
2. Change status back to a valid earlier status (Dispatched, In Transit, etc.).
3. Save.

The exclusion is regex-based on `Cancelled` exactly, so case matters. If a load doesn't drop out of KPIs after cancellation, check the status spelling.

## Soft-deleting a load

Soft-delete is for loads that should never appear in any operational view — typos, duplicates, test loads, fraudulent entries.

How to soft-delete:

1. **Open the load** from Active Loads.
2. **Click Delete.**
3. **Confirm.**

The load:

- **Stays in the Google Sheet** as a row (audit-friendly).
- **Has a row added** to the `deleted_loads` SQLite table.
- **Drops out of every operational view** — dashboard, financials, investor view, KPIs, search results.

The exclusion is via SQL `LEFT JOIN deleted_loads ... WHERE deleted_loads.load_id IS NULL`. Anything that hits the centralized `excludeDroppedLoads` helper is filtered.

If you ever need to restore a soft-deleted load:

```sql
DELETE FROM deleted_loads WHERE load_id = ?
```

(Use Database Admin → query, or escalate to technical support.)

## Hard-deleting a row

Hard-delete removes the row from the Google Sheet entirely. The audit trail records that you did it, but the row's data is gone.

How:

1. **Data Manager** → Job Tracking.
2. **Find the row.**
3. **Delete Row.**
4. **Confirm.**

Reasons hard-delete is almost never the right choice:

- **Audit problems.** A cancelled load shows the cancellation; a hard-deleted load shows nothing.
- **Recovery is hard.** You'd need a Google Sheet backup or a CSV export from before the delete.
- **Dependencies.** Other systems (status logs, audit trail) reference the load ID. Hard-deleting orphans those references.

When might hard-delete be right:

- **Genuinely garbage rows** that were never legitimate (test loads, accidental n8n parses with no real data).
- **Privacy compliance** if a load contains data that legally must be deleted.

For anything else, soft-delete is the right tool.

## When to cancel vs. soft-delete

**Cancel** when the load was real but ended early:
- Broker withdrew.
- Mutual agreement to stop.
- Driver couldn't complete and no replacement.
- Receiver refused and the freight returned to shipper.

**Soft-delete** when the load shouldn't have been there at all:
- N8n parsed an email wrong and created a phantom load.
- Duplicate of another load.
- Internal test that escaped to production.
- Fraudulent entry that needs to disappear from views.

The mental test: "would a customer or auditor expect to see this load if they looked?" If yes, cancel. If no, soft-delete.

## The dispatcher can't cancel

Per the 2026-04-19 client decision, dispatchers don't have cancel authority. They have to escalate.

When dispatch escalates a cancellation:

1. **Hear them out.** Why does the load need to be cancelled?
2. **Verify the reason** is legit (broker email, recorded call, etc.).
3. **Cancel via the dedicated action.**
4. **Confirm to dispatch** so they can update broker and driver.

Don't auto-approve every escalation. Some cancellations should be reassignments instead. Most should be uncontroversial.

## Notifying drivers about cancellations

When you cancel a load that was assigned to a driver:

- **The driver gets a real-time notification** ("load cancelled").
- **The load disappears** from their Loads tab.
- **They should be told why** — message them or have dispatch message them.

A driver who finds out their load was cancelled without explanation is annoyed and confused. A 30-second message fixes it.

## Notifying brokers

The broker who originally sent the rate confirmation should be told:

- **Email confirming cancellation.**
- **Note any agreement** about the cancellation (no fees, partial pay, etc.).
- **Update any tracking link** you've shared with them — the public tracker shows the cancelled status.

Cancellations are usually agreed to before you act, so this is more confirmation than news.

## Audit trail of cancellations and deletions

Every cancellation and deletion is logged:

- **Action**: `cancel_load`, `soft_delete_load`, `hard_delete_load`.
- **Load ID** affected.
- **User ID** who acted.
- **Timestamp.**
- **Reason** (if you provided one).

To review historical cancellations or deletions, query the audit_trail table (Database Admin) filtered to the relevant action.

## Patterns and outliers

A few things worth watching:

**Same broker cancelling frequently.** Could be the broker is taking loads they can't actually deliver. Watch for the pattern; talk to them.

**Same driver having loads cancelled mid-trip.** Could indicate a problem with the driver (refusing freight, equipment issues). Or could be unlucky. Pattern matters.

**Soft-deletes that get questioned later.** If someone asks "what happened to load LD-3492?", check `deleted_loads`. The audit trail tells you who deleted and when.

## Restoring a soft-deleted load

Sometimes a load was soft-deleted in error and needs to come back.

Steps:

1. **Confirm it should be restored.** Get sign-off from whoever flagged it.
2. **Open Database Admin** → query `deleted_loads`.
3. **Find the row.**
4. **Run:** `DELETE FROM deleted_loads WHERE load_id = '<the-load-id>'`.
5. **Verify** by refreshing the dashboard — the load should reappear.

If you don't have direct SQL access, escalate to technical support.

## Restoring a cancelled load

Easier. Open the load, change status back to a valid in-progress status (Dispatched, At Shipper, In Transit, etc.), save.

The status_logs sheet will show the change. The audit trail will too.

## Pro tips

- **Always cancel before deleting.** If you're considering hard-delete, ask whether soft-delete or cancel solves the same problem with less risk.
- **Document the reason.** Especially for unusual cancellations. The audit trail captures what but not why.
- **Don't make cancellations look like deletions.** Cancellations are records of what happened; deletions are records of what shouldn't have happened. Use the right one.
- **Verify exclusion after acting.** After cancelling or soft-deleting, check the dashboard. If the load still shows, the exclusion didn't work — investigate why.
