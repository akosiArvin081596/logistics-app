# Operations

Day-to-day operations: monitoring, scripts, audit, backups, common incident playbooks.

## Audit trail

Admin-significant mutations write a row to the `audit_trail` SQLite table. The schema:

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | |
| `action` | TEXT | A short slug — `user_created`, `driver_renamed`, `routemate_sync`, etc. |
| `user_id` | INTEGER | The acting user. |
| `target` | TEXT | What was acted on — usually a load ID, user ID, or "all". |
| `details` | TEXT | JSON blob with the before/after where applicable. |
| `created_at` | TIMESTAMP | UTC. |

Currently logged actions include user CRUD, driver renames (which fan out to multiple sheets), Routemate sync runs, and several `scan-*` admin tools. The action vocabulary grows organically — add entries when you add a new admin tool. There is no scheduled retention; rows accumulate forever.

`/api/admin/audit-trail` exposes this to Super Admins as a paginated list.

## Helper scripts

Live in `scripts/`:

| Script | Purpose |
|---|---|
| `reset-super-admin-password.js` | Reset the Super Admin password against the local SQLite DB. |
| `truncate-and-seed.js` | Wipe and reseed `app.db` for clean-slate testing. |
| `seed-staging.js` | Seed a staging DB. |
| `create-demo-user.js` | Create a demo user for testing. |
| `geocode-loads.js` | Backfill geocodes for rows in "Job Tracking". |
| `generate-timeline-docx.py` | One-off Python script to render `.docx` session timelines (requires `python-docx`). |
| `docs/generate-docs.js` | Build the technical and user PDFs. |
| `docs/capture-screenshots.js` | Capture the UI screenshots used by the user manual. |

Run scripts from the project root: `node scripts/<name>.js`. Each script is independent — no shared CLI framework, no shared config.

## Monitoring & log access

There is no APM or log-aggregation service. The two practical mechanisms are:

- **`pm2 logs logistics-app`** — live tail of stdout and stderr. Errors land here.
- **`audit_trail` table** — every admin-significant mutation. Run ad-hoc SQL via `GET /api/db/query/audit_trail` (Super Admin only).

Errors that surface to users return generic 500 JSON; the diagnostic detail is in pm2 logs. When investigating a user-reported issue, ask for the approximate time and look at `pm2 logs --lines 500` from that window.

## Backups

The SQLite database is the only mutable state the repo doesn't own. Take a snapshot of:

- `app.db` — via `GET /api/db/download` (Super Admin) or `scp` directly from the VPS.
- `.env` — runtime secrets.
- `service-account-key.json` — Google credentials.
- `uploads/` — local copies of POD photos, signatures, receipts.

Backups should be off-host. Cadence depends on tolerance for data loss; nightly is reasonable for the database, weekly is fine for everything else.

The Google Sheet is implicitly backed up by Google; you don't need to snapshot it yourself unless you want to be able to read it during a Google outage.

## Common incident playbooks

### Sheets API quota exhausted

**Symptom.** `/api/dashboard` returns 500. Logs show `Quota exceeded for quota metric 'Read requests'`.

**Cause.** 300 read requests per minute exceeded. Usually caused by a spike in dashboard refreshes when the in-memory cache hasn't warmed.

**Mitigation.** Wait — the limit refills every minute. Check that the cache (`getJobTrackingCached()`) is being used by the affected endpoint. If a new endpoint is bypassing the cache, route it through `getJobTrackingCached()` instead of calling Sheets directly.

### Driver GPS not updating

**Symptom.** Tracking map shows a stale driver position.

**Cause to check, in order:**

1. **Browser permission.** The driver's browser blocks geolocation. `DriverView` should be showing the "Location Access Required" gate — confirm the driver sees it.
2. **Phone background.** iOS especially backgrounds the tab aggressively. The 60-second stationary heartbeat is the workaround; if a driver hasn't moved 50 m in 60 s, no report goes out. This is intentional but can look like "broken GPS" on the map.
3. **Server-side dedup.** `POST /api/location` has a 10-second minimum inter-report interval per driver. Reports faster than that are ignored.
4. **Routemate fallback path.** If `ROUTEMATE_ENABLED=true`, the GPS source for that driver may have switched to Routemate. The `source: 'routemate' | 'phone'` field on `/api/locations/latest` tells you which.

### A load is stuck in the wrong status

**Symptom.** A driver completed delivery but the dashboard still shows "In Transit" or similar.

**Cause to check.**

1. **Duplicate Load ID rows.** The deduplicator keeps the bottom-most row per Load ID; if the corrected row is above the stale row, the stale row wins. Look at the sheet directly.
2. **Status guard.** Status updates enforce a "valid predecessor" rule. If the current status doesn't match the expected predecessor, the transition is rejected with a 409. Look at the response in the driver's browser console.
3. **Wrong-row write.** Older status updates didn't verify the row index against the Load ID before writing. The current code does, falling back to a Load ID scan if mismatch is detected. If a status update lands on the wrong row, it's a regression worth investigating.

### Soft-deleted load reappeared

**Symptom.** A load that was deleted via `/api/loads/:loadId` shows up again in lists.

**Cause.** The Google Sheet row was edited (manually or by n8n) after the soft-delete, which generally doesn't restore the row but can if the row was on a Load ID that was previously in `deleted_loads` and the `deleted_loads` row got removed.

**Mitigation.** Re-run the soft-delete. Investigate why the `deleted_loads` row went away — possibly a manual cleanup.

### Investor dashboard shows $0 earnings

**Symptom.** Investor logs in, sees zero across the board even though their truck has been running.

**Cause to check.**

1. **Carrier name mismatch.** The investor's `users.company_name` must match (case-insensitive) the Carrier Database carrier names assigned to their drivers. Spelling differences ("JONHSON" vs. "JOHNSON" — a real past bug) cause the join to miss.
2. **Owner ID column.** The Job Tracking sheet has an "Owner ID" column that links a load row to an investor. The investor view prefers Owner ID over the carrier-name fallback. If Owner ID is blank on every load, only the carrier-name fallback runs — which is fragile.
3. **Excluded loads.** The `excludeDroppedLoads` helper filters cancelled and soft-deleted loads from every aggregator. If every load was somehow flagged cancelled, the dashboard would zero out.

### Webhook secret rejected

**Symptom.** n8n reports 401 from `POST /api/n8n/job`.

**Cause.** `N8N_WEBHOOK_SECRET` in the server `.env` doesn't match the value n8n is sending in `x-webhook-secret`.

**Mitigation.** Reset both sides to the same value. After rotating, run a single test message through n8n's manual replay and verify the row appears in the sheet.

## Rate-limit telemetry

`express-rate-limit` sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers on every response. To diagnose "is this rate-limited?", inspect the response headers in the browser dev tools. The limiters are listed in the backend chapter.

## Database admin tools

`GET /api/db/tables` lists every table. `GET /api/db/query/:table` returns rows from a single table with optional `?where=` and `?limit=`. `GET /api/db/download` returns the entire `app.db` file. All three are Super Admin only.

For ad-hoc SQL beyond what `/api/db/query` exposes, `scp` the database off the VPS and open it in DB Browser for SQLite or `sqlite3` CLI locally — never write SQL directly against the production file.

## Schema scans

Three admin endpoints help find data-quality issues:

- `GET /api/admin/scan-duplicates` — duplicate rows in sheets.
- `GET /api/admin/scan-driver-mismatches` — driver name inconsistencies between sheet and Carrier Database.
- `GET /api/admin/scan-orphans` — orphaned data.
- `GET /api/admin/scan-stale-locations` — driver locations that haven't updated in too long.

Run periodically as a sanity check. Each surfaces issues that aren't usually visible in normal admin views.

## When something is on fire

The right escalation order:

1. **Check `pm2 logs`** for the last 5 minutes of output.
2. **Check `pm2 monit`** for CPU/memory — Puppeteer can OOM the box if a runaway render queue forms.
3. **`pm2 restart logistics-app`** if the process looks wedged. Brief downtime.
4. **Roll back the last deploy** if the symptoms started right after one (see deployment chapter).
5. **Restore `app.db` from backup** as a last resort — there is no automated point-in-time recovery.

Most issues are recoverable without data loss because the Google Sheet holds the system of record for loads. SQLite tables (users, expenses, onboarding, telemetry) need their own backups.
