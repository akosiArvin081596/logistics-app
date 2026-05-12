# Archive

The Archive is a read-only view of historical data — loads, drivers, financial records — that predates the current production sheet or has rolled off the active dashboard. This chapter is how to use it.

## What's in the Archive

A separate Google Sheets workbook holds the archive. It contains:

- **Old Job Tracking entries** from before the current production sheet started.
- **Historical driver records.**
- **Old expense records.**
- **Other historical data.**

The exact contents vary depending on when the archive was populated. As of this writing, it's primarily older Job Tracking data.

## Opening the Archive

Sidebar → **Archive** (or navigate to `/archive`). Super Admin only.

You'll see tabs corresponding to archive spreadsheet tabs. Click any to view the data.

## What you can do

**View only.** The Archive UI is read-only. You can browse, search, and filter, but you can't edit.

To export a slice of archive data, you can:

- **Copy from the UI** — select cells and copy.
- **Download from Google Sheets directly** — the archive spreadsheet is in the same Google account; open it directly in Sheets.

## What you can't do

- **Edit** archive rows.
- **Delete** archive rows.
- **Move data** between archive and production (no UI for this).

If you need to operate on archive data — restore something to production, edit a historical record — escalate to technical support. They have direct access to the archive spreadsheet.

## When to use the Archive

Common scenarios:

**Researching a historical load.** Broker asks about a load from a year ago that's no longer in the active dashboard. Look in the archive.

**Verifying historical driver activity.** A driver disputes a claim about their past work. Pull their archive records.

**Audit research.** Leadership asks about a financial pattern from 18 months ago. The archive may have the underlying data.

**Reference lookups.** "When was the last time we ran for this broker?" Search the archive.

## Searching the archive

Each tab has a search bar. Type a Load ID, driver name, broker, city — results filter as you type.

## Archive's relationship to production

The current production sheet (`1ey1n0AAG0k8k...`) is where current operations live. The archive (`1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI`) is the historical reference.

Operationally:

- **Production** is read AND written constantly. Driver assignments, status updates, n8n ingestion, customer trackers — all hit production.
- **Archive** is read occasionally for reference. Nothing writes to it day-to-day.

The system uses the production sheet ID for all live operations. The archive viewer reads from the archive sheet ID. They're separate logical stores.

## Archive memory

A user memory in your `MEMORY.md` reminds you that the production sheet ID is `1ey1n0AAG0k8k...`, NOT `1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI` (which is the archive). When troubleshooting or running scripts that need the sheet ID, use the production one. Mixing them up causes confusion.

## Growing the archive

The archive doesn't grow automatically. To move old data from production to archive (e.g., to prune the production sheet for performance):

1. **Decide on a cutoff** — e.g., "loads older than 2 years."
2. **Export those rows** from production.
3. **Import them into the archive** — append to the appropriate sheet tab.
4. **Delete the rows** from production after verifying the archive copy.

This is a manual process, not automated. Schedule it periodically (maybe annually).

## Archiving is not deletion

A load moved to archive **still exists** in the system, just in a different sheet. Some implications:

- The load isn't visible on the operational dashboard (because the dashboard reads production only).
- The load isn't included in current-period KPIs.
- The load is still available for reference via the Archive viewer.

This is different from soft-delete (which keeps the load in the production sheet but hides it from views) and from hard-delete (which removes the row entirely).

## When to archive vs. delete

**Archive** when:
- The load is real and historical.
- You want to keep it for reference but not have it clutter the active view.
- Auditors might need to see it later.

**Delete** when:
- The row was never legitimate (typo, duplicate, test, fraud).
- Removing it is the right answer.

In practice, almost everything older than a year or two could be archived. Almost nothing should be hard-deleted.

## Backup strategy

The archive functions as a kind of long-term backup. Combined with:

- **Google Drive auto-versioning** of the sheet (you can see prior versions).
- **The audit trail** in SQLite.
- **Manual backups** of `app.db`.

You have multiple layers of historical record. The archive is the easiest to access for non-technical staff.

## The Pending Google Cloud reminder

A memory item notes that the Maps API key needs HTTP referrer restriction in Google Cloud Console, parked until developer access is available. This is unrelated to the archive but it's a similar "deferred admin task" — track it somewhere so it doesn't get forgotten.

If you periodically check the Archive, also check whether the Google Cloud key restriction has been done. Both are eventually-needed tasks.

## Pro tips

- **Use the Archive for context, not action.** Looking up history is fine; trying to operate on archive data is friction.
- **If you find yourself needing to edit the archive often,** that's a sign the archive process needs to be revisited (maybe data shouldn't have been archived).
- **Bookmark direct Google Sheets links** to the archive workbook for power users. The in-app Archive viewer is convenient; direct Sheets is faster for deep work.
- **Don't move active loads to archive.** A load that's still relevant to current operations belongs in production.
