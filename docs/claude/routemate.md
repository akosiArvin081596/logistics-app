<!-- Extracted verbatim from CLAUDE.md on 2026-09-23 to keep that file inside the context budget.
     CLAUDE.md now carries a short summary and points here. Only pinned counts were dropped and
     verified errors corrected; nothing else was reworded. -->

# Routemate ELD / telematics integration

Replaces phone-based driver GPS. Routemate is FMCSA-certified ELD hardware in trucks; LogisX pulls from their cloud REST API.

**Adapter:** `lib/routemate-client.js` — single point of contact. Auth via `X-Api-Key`. Retry/backoff + 15s `AbortController` timeout mirror the Gemini OCR pattern. Returns normalized objects so a future API change ripples through one file. Every server-side caller goes through it; no other module talks to Routemate directly.

**Env vars** (defined in `.env.example`):
- `ROUTEMATE_BASE_URL` (default `https://cloud.routemate.ai`)
- `ROUTEMATE_API_KEY` — sent as `X-Api-Key`
- `ROUTEMATE_ENABLED` — master kill switch. When `false`, all sync intervals are dormant and the manual probe returns 503. **Default off** until the key is wired in production.
- `ROUTEMATE_POLL_LIVE_SEC` (default 60) — used by Phase 2 live-telemetry sync
- `ROUTEMATE_POLL_FAULTS_SEC` (default 300) — Phase 5 fault-code sync
- `ROUTEMATE_POLL_DAILY_HOUR` (default 4) — listed in `.env.example` for the Phase 3+ daily rollups, but nothing in `server.js` or `lib/` reads it

**SQLite tables** (Phase 1, all `IF NOT EXISTS` — additive, reversible):

| Table | Purpose |
|---|---|
| `routemate_vehicles` | Local mirror of Routemate vehicle inventory (synced via `POST /api/admin/routemate/sync-now`). Fields: `routemate_vehicle_id` (UNIQUE), `vehicle_id`, `vin`, `make`, `model`, `year`, `fuel_type`, `eld_id`, `gps_ids` (JSON), `license_num`, `state`, `active`, `raw_json`, `last_synced_at`. |
| `routemate_telemetry` | Live GPS feed, append-only. Fields: `routemate_vehicle_id`, `latitude`, `longitude`, `speed`, `bearing`, `odometer`, `engine_hours`, `fuel_pct`, `geocoded_location`, `location_date_ms` (epoch ms from Routemate), `fetched_at`. Also the driver-pay "active days" source — see that convention. Since 2026-09-19 each row also carries `source` (`'routemate'` / `'linxup'`; `''` = written before the column) — the only provenance test, since Linxup writes this table too. |
| `routemate_fault_codes` | One row per active code per vehicle, UNIQUE on `(routemate_vehicle_id, code)`. Fields: `code`, `status`, `first_seen`, `last_seen`, `ack_by_user_id`, `ack_at`. |
| `routemate_dvir` | DVIR inspection reports per vehicle, UNIQUE on `dvir_id`. |
| `routemate_fuel_daily` | Telemetry-derived MPG rollup, UNIQUE on `(routemate_vehicle_id, date)`. Phase 4. |
| `routemate_hos_daily` | Driver duty-time rollup, UNIQUE on `(driver_id, date)`. Phase 3. |

**`trucks` table** gains one additive column via the existing try/catch ALTER pattern: `routemate_vehicle_id TEXT DEFAULT ''`. Set by admins via the Trucks UI (Phase 2) to link a LogisX truck to a Routemate vehicle.

**`driver_locations`** retains historical rows but is no longer written or read by any endpoint as of 2026-05-13. `GET /api/locations/latest` and `/api/locations/trail` now source exclusively from `routemate_telemetry`; responses tag `source: 'routemate'` with an ELD fix, else `'none'`. The 90-day purge job still ages the legacy data out.

**Phase 1 endpoints** (only ones live as of foundation):
- `POST /api/admin/routemate/sync-now` — Super Admin only. 503 when `ROUTEMATE_ENABLED=false` or key unset; else `getCompany()` smoke test, then paginates `listVehicles()` and upserts into `routemate_vehicles`. Logs `audit_trail` action `routemate_sync`. A failed sync answers 502 `ROUTEMATE_SYNC_FAILED`. Since 2026-09-23 `listVehicles()` tries once (`retries: 0`), and no request sleeps after its final attempt.
- `GET /api/routemate/health` — Super Admin only. Returns `{enabled, hasKey, baseUrl, lastSync, lastError, errorsLast24h}`. Since 2026-09-23 it — and `GET /api/eld/linxup/health` — also carries the fleet-wide ELD **feed-health** view from the hourly silence sweep (`lib/eld-feed-health.js`, `eld_feed_alerts`, `ELD_STALE_ALERT_ENABLED` — a kill switch, default ON): `feeds[]` (every feed, each with its `source`), `feedSummary`, `feedThresholds`, `lastFeedSweep` and `lastFeedSweepError`. A stale, never-reported, trickling or orphaned feed alerts once (email to `GMAIL_USER` plus an `eld-feed-silent` dispatch notification); the ledger row resolves when the feed recovers and re-opens if it goes quiet again.

**No webhooks in Routemate v0** — pull-only. Phase 2+ uses `setInterval` patterns like `setInterval(purgeOldDriverLocations, ...)` (`grep -n purgeOldDriverLocations server.js`). All gated by `ROUTEMATE_ENABLED`.

~~**Demo viewer** is blocked from `/api/admin/routemate/sync-now` by the global write-lockdown middleware (server.js:~1630).~~ **Stale — the `demo_viewer` account and its lockdown middleware were deleted 2026-08-04** (see the tombstone comment in `server.js`, and "demo_viewer removed"). There is **no** global write-lockdown middleware today; do not assume a new admin write route inherits one.

**Spec reference:** OpenAPI 3.0.1 at `https://cloud.routemate.ai/v3/api-docs` (public, no auth). Doc viewer `https://cloud.routemate.ai/open-api.html` is JS-rendered Redocly. Path prefix `/api/v0/`.
