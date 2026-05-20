# Data Manager

The Data Manager is a direct editor for the underlying Google Sheets that drive LogisX. This chapter is what's in there and how to use it without breaking things.

## What it is

Sidebar → **Data Manager** (or navigate to `/data`). You'll see a tab list at the top — each tab is a sheet tab in the production Google Sheets workbook:

- **Job Tracking** — the system of record for every load.
- **Carrier Database** — the drivers directory.
- **Status Logs** — historical status changes (read-mostly).
- **Payments Table** — historical payment records (older system; may be empty).
- Other tabs as configured.

![Data Manager](screenshots/admin-data-manager.png)

Click a tab to see its rows. Each row is editable inline.

## Why it exists

For 90% of operations, you use the dedicated UIs (Users, Drivers, Trucks, etc.). For the other 10%:

- **Correcting a typo** in a sheet column that doesn't have a dedicated UI.
- **Backfilling a column** for old rows.
- **Inspecting raw values** when something looks off elsewhere.
- **Bulk edits** that would be tedious via the dedicated UI.
- **One-off data entry** for rows that don't have an obvious flow.

The Data Manager is the universal escape hatch.

## How to use it carefully

Three rules:

**1. Verify before saving.**
Edits write directly to the production Google Sheet. There's no undo. If you mistype a value or paste into the wrong cell, you've changed live data.

**2. Don't make sweeping changes during peak hours.**
A bulk edit at 10 AM can cause cascading issues across the dispatcher dashboard and customer trackers. Save bulk work for after-hours.

**3. Don't delete columns or rename headers.**
The whole system relies on regex-based column matching. Adding a column is safe; removing or renaming an existing column will break downstream queries.

If you need to rearrange columns substantially, talk to technical support first.

## Editing a cell

Click a cell. Type. Hit Enter or Tab to save. The change writes to Google Sheets within a second.

You'll see a small indicator confirming the save (or an error if something went wrong).

## Adding a row

Use the **Add Row** button at the top of the table. The form asks for each column's value.

For Job Tracking specifically, you should rarely add rows manually — broker emails via n8n handle that. Manual entries are for:

- Phone-confirmed loads.
- Test or training entries.
- Corrections to misimported rows.

## Deleting a row

Use the **Delete Row** button on the row. Confirm. The row is removed from the Google Sheet.

**Be careful.** Deletion is hard to undo. The audit trail logs that you deleted, but reconstructing the data requires a copy from somewhere else.

For Job Tracking, prefer **soft-delete** (the dedicated Delete action that uses the `deleted_loads` table) over hard-delete from Data Manager. Soft-delete is reversible; hard-delete isn't.

## The Job Tracking columns

The most-edited sheet. Columns of interest:

| Column | Notes |
|---|---|
| **Load ID** | Unique identifier. Don't change after a load is in motion. |
| **Driver** | Who's running it. Matched case-insensitively. |
| **Status** | The current status. Edits here update the load. |
| **Pickup Appointment** | Pickup date/time. Affects driver pay (active days). |
| **Drop-off Appointment** | Delivery date/time. Same. |
| **Payment** | Load revenue. Drives investor earnings and owner-op pay. |
| **Owner ID** | Investor record ID owning the truck. Drives investor attribution. |
| **Truck #** | Truck unit number. |

Editing these has downstream effects. Be deliberate.

## The Carrier Database

The drivers directory. Each row is a driver:

- Name (matched against Job Tracking's Driver column).
- Carrier Name (matched to investor user accounts' `company_name`).
- Address, contact, etc.

Editing a driver name here doesn't auto-rename them in Job Tracking. Use the **Fix Driver Name** tool from Admin Tools to propagate a rename across both sheets and SQLite tables.

## Best practices

**Read before you edit.** Open the cell you're about to change and read its current value. Don't paste over without looking.

**Verify with the dispatcher view.** After an edit, switch to the operations dashboard and confirm the change took effect as expected.

**Don't multi-edit in one session unless you're prepared.** A series of careful edits is fine. A barrage of edits while distracted is how mistakes happen.

**Save backups.** Before a major edit (especially deletes), download a CSV of the affected sheet tab via Google Sheets directly. Cheap insurance.

**Use Admin Tools first when applicable.** If you're trying to fix duplicate Load IDs, use the duplicate scanner — don't manually pick which to delete.

## When NOT to use Data Manager

- **Adding a new user account.** Use the Users page.
- **Approving an expense.** Use the Expenses page.
- **Renaming a driver.** Use Admin Tools → Fix Driver Name.
- **Cancelling a load.** Use the dedicated Cancel action on the load.
- **Routine load updates.** Drivers and dispatch handle these via the operations dashboard.

The Data Manager is the wrench, not the screwdriver. Use it when the screwdriver isn't enough.

## What about adding columns?

Adding a new column to a sheet (e.g., a new field on Job Tracking) requires:

1. Adding the column in Google Sheets directly.
2. Updating regex patterns in server.js if the column needs special handling (financial scrubbing, status detection, etc.).

The first part you can do; the second part requires technical support.

## Editing the archive sheet

There's a separate **Archive** spreadsheet for historical data. The Data Manager has access (sidebar → Archive). Edits there don't affect live operations — the archive is essentially a snapshot.

**Be careful** with the archive too. Editing history can confuse audits. Better to leave it untouched.

## Editing while a dispatcher is using the same data

Risk: dispatcher reads a row, you edit it, dispatcher writes back with their old value. You lose your edit.

In practice this is rare because:

- Most operations happen via the dedicated UIs which serialize changes.
- The Data Manager edits write immediately and the dispatcher view auto-refreshes.

If you're worried, time edits for off-hours. Or message dispatch first: "I'm going to fix the dates on LD-3492; hold off on that load for 2 minutes."

## Mass operations

For mass edits (e.g., backfill a column across 100 rows), Data Manager is slow. Two alternatives:

1. **Edit directly in Google Sheets** (same sheet, full Sheets UI). Faster for bulk work.
2. **Direct SQL via Database Admin** for SQLite-backed tables.

Both bypass the LogisX server logic, which means:

- No audit trail.
- No real-time refresh for users.
- No validation of values.

Trade speed for safety as needed.

## Pro tips

- **Reload after edits.** Refresh the Data Manager to confirm what you actually saved.
- **Use search.** Most tabs have a search bar. Find your specific row before editing.
- **Read recently-changed rows.** If you're investigating an issue, look at rows changed in the last 24 hours first. Usually that's where the problem is.
- **Keep a log.** When you do significant Data Manager work, jot down what you changed and when. Future-you will appreciate it.
