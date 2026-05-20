# Admin Tools

Admin Tools is a collection of one-shot operations: data integrity scanners, batch fixes, and operational shortcuts. This chapter covers each.

## Opening Admin Tools

Sidebar → **Admin** → **Tools** (or navigate to `/admin/tools`). Super Admin only.

![Admin Tools](screenshots/admin-tools.png)

You'll see a screen with multiple tool cards or buttons, one per operation.

## The available tools

### Scan Duplicates

Finds rows in Job Tracking with the same Load ID. Common cause: a broker re-sent the same rate confirmation, n8n processed it twice.

How to use:

1. Click **Scan Duplicates**.
2. Results appear as a list of Load IDs with multiple matching rows.
3. For each group, pick the canonical row to keep.
4. Click **Remove Duplicates** to delete the others.

The system uses the bottom-most row by default as canonical (it's likely the most recent correction). Override if needed.

### Scan Driver Mismatches

Finds loads where the driver name doesn't match any name in the Carrier Database. Common cause: typos, abbreviations, alternate spellings.

How to use:

1. Click **Scan Driver Mismatches**.
2. Results show loads with unrecognized driver names.
3. For each, you can:
   - **Edit the load** (Data Manager) to fix the name.
   - **Add the driver** to Carrier Database (if it's a new driver).
   - **Use Fix Driver Name** if it's a common typo affecting many loads.

### Scan Orphans

Finds records that point to nothing — e.g., a load assigned to a deleted driver, a truck without a record. Usually safe to clean up.

How to use:

1. Click **Scan Orphans**.
2. Results show orphaned records.
3. Review each before acting — sometimes an "orphan" is intentionally pending (e.g., a load entered before driver assignment).
4. Clean up via Data Manager or the appropriate dedicated page.

### Scan Stale Locations

Finds drivers whose GPS reports haven't updated in too long. Usually means their phone is offline or they've closed the app.

How to use:

1. Click **Scan Stale Locations**.
2. Results show drivers with stale GPS.
3. For each, message the driver to verify they're online.
4. If they're truly offline (off duty), no action needed.
5. To clean up stale GPS rows from the `driver_locations` table, use **Fix Stale Locations**.

### Fix Stale Locations

Removes very-old GPS records from `driver_locations` to keep the table from growing unbounded. The system already has a background job that purges old locations, so this is rarely needed.

### Fix Driver Name

The most powerful single tool. Renames a driver across:

- Carrier Database.
- Job Tracking (all rows referencing this driver).
- SQLite tables (load_responses, load_ratings, driver_locations, etc.).
- User accounts (`driver_name` field).

How to use:

1. Click **Fix Driver Name**.
2. Enter the old name (exact case-insensitive match).
3. Enter the new name (exact spelling).
4. Click **Apply**.

The system shows you how many rows were updated across each table.

This is **destructive** in the sense that you can't easily undo a rename. Double-check the spelling before clicking Apply. Examples of when to use:

- **Typo fix.** "Lesline Jonhson" → "Lesline Johnson" across 86 loads (real historical case).
- **Name change.** Driver got married and changed their last name.
- **Standardization.** Driver was inconsistently entered as "Mike" sometimes and "Michael" others.

### Batch Remove Rows

Lets you remove multiple rows from a sheet at once. Use sparingly. Available filters:

- Date range.
- Status (e.g., remove all Cancelled loads older than X).
- Driver.

Confirms before executing. Once executed, deleted rows are gone (Google Sheets doesn't have native undo at this layer).

For Job Tracking specifically, prefer **soft-delete** (per-load Delete action) over batch hard-delete. Soft-delete is reversible.

## When to run each tool

**Weekly:**
- **Scan Duplicates** — catch broker double-sends.
- **Scan Driver Mismatches** — catch typos before they cause invoice issues.

**Monthly:**
- **Scan Orphans** — clean up stale data.
- **Scan Stale Locations** — verify the fleet's phones are reporting correctly.

**As needed:**
- **Fix Driver Name** — when a typo or name change is identified.
- **Batch Remove Rows** — when a clearly-bad batch of rows needs to go.

## A note on "Scan" results

A "scan" surfaces potential issues. Most surfaced issues are real; some are false positives:

- **A duplicate scan may show same-Load-ID loads that are actually distinct loads** (someone reused an ID by mistake). Don't auto-merge — review.
- **A driver mismatch may be a brand-new driver** who isn't yet in Carrier Database. Add them, don't fix the load.
- **An orphan may be intentionally pending** (e.g., load entered before driver assignment).

Review before acting. Most of these tools have a "review" step between scan and fix.

## The audit trail records your actions

Every Admin Tools action writes to the `audit_trail` table:

- What you did.
- When.
- What was affected (row counts, etc.).
- Your user ID.

If a tool's effect looks wrong later, the audit trail shows what was changed and you can reverse manually (if reversible).

## What's not in Admin Tools

Some operations aren't here:

- **Approving expenses** — go to Expenses screen.
- **Approving invoices** — go to Invoices screen.
- **Approving applications** — Applications / Investor Applications screens.
- **Cancelling a load** — per-load Cancel action.
- **Adding a user** — Users page.

Admin Tools is for cross-record operations and integrity scans, not single-record workflows.

## Limitations

The tools available are pre-defined. If you need a one-off operation that isn't here (e.g., "rename a column", "bulk-update a date field"), you'll need to either:

- Use Data Manager manually.
- Ask technical support to write a one-off script.
- Use Database Admin (Super Admin → DB → query) for SQLite-backed data.

There's no general scripting interface inside the app.

## Pro tips

- **Run scans during quiet hours.** Some scans take a few seconds and load the database; running mid-day is fine but off-hours is friendlier.
- **Document tool usage.** When you run a Fix Driver Name, note it somewhere (a Slack message to leadership, an email to ops). The audit trail captures it but a human-readable note helps.
- **Don't batch-delete what you can soft-delete.** Soft-delete is the friend of operations; hard-delete is the enemy of audits.
- **Build a routine.** A weekly 10-minute Admin Tools scan keeps data clean and surfaces issues early.
