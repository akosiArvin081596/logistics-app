# /applications Performance Fixes — Summary

**Date:** 2026-04-16
**Based on:** `applications-performance-audit.md`
**Fixes applied:** A + B + C + D (all four from the audit)
**Total diff:** ~45 lines across 2 files

---

## Files Changed

| File | Lines touched | Change |
|---|---|---|
| `server.js` | 1707-1741 (replaced + expanded) | Fix A + Fix B |
| `server.js` | 368-373 (inserted) | Fix D |
| `client/src/views/ApplicationsView.vue` | 248-277 (modified) | Fix C + Fix B |

---

## Fix A — Explicit column list on list endpoint

**File:** `server.js` (was line 1707, now 1707-1721)

**What changed:** Replaced `SELECT ja.*` with an explicit 26-column list.

**Excluded columns** (the expensive ones that the list UI never renders):
- `cdl_front`, `cdl_back`, `medical_card` — base64 image TEXT columns, ~1 MB each
- `signature` — base64 signature PNG TEXT
- `ssn` — only shown in detail modal, masked in list
- `felony_explanation`, `accident_description`, `traffic_citations` — long-text narrative fields
- `skills`, `reference_info`, `additional_info`, `availability` — JSON blobs only shown in detail
- `signature_date` — only shown in detail

**Kept columns** (everything the `<table>` actually renders in `ApplicationsView.vue:39-79`):
`id, full_name, email, phone, dob, address, drivers_license, position, experience, has_cdl, work_authorized, felony_convicted, accident_history, certifications, status, created_at, city, state, zip, cell, dot, mc, hazmat` plus the 3 joined `driver_onboarding` columns.

**Verified on production today:** each row averages ~2.9 MB of base64 image bytes from the excluded columns. Fix A drops the per-row payload from ~3 MB to ~2 KB.

---

## Fix B — Detail endpoint `GET /api/applications/:id`

**File:** `server.js` lines 1724-1736 (new block inserted before `PUT /api/applications/:id/status`)

```js
app.get("/api/applications/:id", requireRole("Super Admin"), (req, res) => {
  try {
    const row = db.prepare(`SELECT ja.*, do.user_id AS onboarding_user_id, do.status AS onboarding_status, do.drug_test_result
      FROM job_applications ja
      LEFT JOIN driver_onboarding do ON do.application_id = ja.id
      WHERE ja.id = ?`).get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "Application not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- Same `requireRole("Super Admin")` middleware as the list endpoint
- `SELECT ja.*` is OK here because we only return a single row
- Includes the same JOIN to `driver_onboarding` so the detail modal has identical shape to what the list used to return (no template changes needed)
- Returns 404 on unknown ID

### Frontend hydration (`ApplicationsView.vue:267-277`)

`openDetail()` is now async:

```js
async function openDetail(app) {
  selectedApp.value = app              // show lightweight row data instantly
  showDetail.value = true
  try {
    const full = await api.get(`/api/applications/${app.id}`)
    if (selectedApp.value && selectedApp.value.id === app.id) {
      selectedApp.value = full         // swap in full record (~50ms later)
    }
  } catch (err) {
    toast(err.message, 'error')
  }
}
```

- Modal opens immediately with the lightweight list-row data (no perceived delay)
- Full record with images/signature/SSN streams in ~50 ms later and swaps silently
- Race-guard: the `.id === app.id` check prevents a slow response from overwriting a newer selection

---

## Fix C — Delta status update

**File:** `ApplicationsView.vue:248-262`

**Before:**
```js
async function updateStatus(id, status) {
  ...
  await load()                         // full ~5.8 MB refetch
}
```

**After:**
```js
async function updateStatus(id, status) {
  ...
  const row = applications.value.find(a => a.id === id)
  if (row) row.status = status         // in-place update, zero network
}
```

Vue reactivity picks up the property mutation and re-renders only the affected row. Zero HTTP cost per status click.

---

## Fix D — Database indexes

**File:** `server.js:369-373` (new block inserted after the `hazmat` column migration)

```js
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_ja_created_at ON job_applications(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ja_status     ON job_applications(status);
  CREATE INDEX IF NOT EXISTS idx_do_app_id     ON driver_onboarding(application_id);
`);
```

- `IF NOT EXISTS` is idempotent — safe on every server boot
- Matches the existing migration pattern (plain `db.exec()` block, no migration framework)
- Placed immediately after the last `ALTER TABLE job_applications` migration so it runs after any new columns are added
- Covers the three hot paths for the list query:
  - `ORDER BY ja.created_at DESC` → `idx_ja_created_at`
  - Future `WHERE ja.status = ?` filters → `idx_ja_status`
  - `LEFT JOIN driver_onboarding ON application_id` → `idx_do_app_id`

---

## Verification

1. **Syntax:** `node --check server.js` → OK
2. **Build:** `npx vite build --logLevel error` → OK (no errors)
3. **Payload size check** (after deploy):
   ```bash
   curl -s -b cookie.txt https://logisx.com/api/applications | wc -c
   # Expected: ~6,000 bytes (was ~5,800,000)
   ```
4. **Index verification** (after deploy):
   ```bash
   ssh root@76.13.22.110 "cd /var/www/logistics-app && node -e \"
     const db=require('better-sqlite3')('app.db');
     console.log(db.prepare(\\\"SELECT name FROM sqlite_master WHERE type='index' AND (tbl_name='job_applications' OR tbl_name='driver_onboarding')\\\").all());
   \""
   # Expected: includes idx_ja_created_at, idx_ja_status, idx_do_app_id
   ```
5. **End-to-end click test:**
   - Open `/applications` as Super Admin → Network tab shows one `GET /api/applications` ≤ 10 KB
   - Click "View" on a row → Network tab shows `GET /api/applications/:id` with the full payload including images
   - Change status via dropdown → Network tab shows `PUT /api/applications/:id/status` and **no** follow-up list reload

---

## What Was NOT Changed (intentional)

- No schema migrations beyond `CREATE INDEX IF NOT EXISTS`
- No new Pinia stores
- No table template changes in `ApplicationsView.vue`
- No other endpoints touched
- No rate-limiting added (acknowledged as a deeper refactor in the audit, not part of the A-D bundle)
- No pagination added (defer until row count > 500 per audit recommendation)
- No virtualization added (defer until row count > 500 per audit recommendation)
- No changes to the PDF download, status update, or acceptance flow

---

## Expected Impact

| Metric | Before | After |
|---|---|---|
| `/api/applications` payload (2 rows) | ~5.8 MB | ~6 KB |
| `/api/applications` payload (projected 50 rows) | ~145 MB | ~150 KB |
| Network cost per status change | ~5.8 MB | 0 bytes |
| Detail modal open latency | instant (but list was slow) | instant + 50 ms hydrate |
| `ORDER BY created_at` sort (at 10k rows) | full table scan | indexed |
| `LEFT JOIN driver_onboarding` (at 10k rows) | nested loop O(n×m) | indexed O(n log m) |

---

*Fix bundle complete. Ready for deploy.*
