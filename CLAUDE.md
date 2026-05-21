# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Backend (Express server)
npm start            # Run server (node server.js) on port 3000
npm run dev          # Run with nodemon for auto-restart

# Frontend (Vue 3 + Vite SPA)
npm run dev:client   # Vite dev server on 5173 (proxies to Express:3000)
npm run build:client # Production build to client/dist/
```

Development requires two terminals: `npm run dev` + `npm run dev:client`. Open http://localhost:5173.

For production: `npm run build:client` then `npm start` — Express serves the built SPA from `client/dist/`. `postinstall` auto-runs `cd client && npm install`, so `npm install` at root installs both.

**Deploy:** production runs on a VPS at `76.13.22.110` under `/var/www/logistics-app`, managed by pm2 (process name `logistics-app`). Standard deploy flow after merging to `main`:
```bash
ssh root@76.13.22.110 "cd /var/www/logistics-app && git pull --ff-only origin main && npm install --silent --no-audit --no-fund && npm run build:client --silent && pm2 restart logistics-app --silent"
```
A staging process (`logisx-staging`) also runs on the same VPS.

**Tests & linting:** No Jest/Mocha/Vitest/ESLint configured. Integration harness at `test-suite.js` — 25 HTTP tests against a running server (`npm start` then `node test-suite.js`). Covers auth, role gating, debug auth, webhook secret, chat file validation, canceled-load exclusion. Seed via `scripts/truncate-and-seed.js` for deterministic state. When editing `server.js`, run `node --check server.js` before committing (~11k lines; a syntax error breaks the whole app).

## Environment Setup

Required at project root:
- `service-account-key.json` — Google service account credentials (not in git)
- `.env` — environment variables

```
GOOGLE_DRIVE_FOLDER_ID=<optional — uploads skip Drive when empty>
GOOGLE_MAPS_API_KEY=<required for maps, routing, geocoding, places>
GMAIL_USER=<Gmail address for onboarding/outreach emails>
GMAIL_APP_PASSWORD=<Gmail app password for nodemailer>
GEMINI_API_KEY=<optional — enables receipt OCR; form falls back to manual when unset>
GEMINI_OCR_MODEL=<optional — override the default gemini-2.5-flash>
PORT=3000  # optional
SESSION_SECRET=<required in prod; falls back to default in dev>
```

Hardcoded in `server.js` (change if forking): production Spreadsheet ID `1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo` (Dispatch Management — n8n writes here); archive sheet `1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI` (archive viewer only).

Helper scripts in `scripts/` — see directory. Key ones: `truncate-and-seed.js` (wipe+reseed local DB), `reset-super-admin-password.js`, `seed-staging.js`, `geocode-loads.js` (backfill geocodes for "Job Tracking").

Shared server modules in `lib/`: `ifta-states.js` (US state bounding boxes), `pdf-browser.js` (Puppeteer HTML→PDF for onboarding/investor docs — why `puppeteer` is a top-level dep alongside `pdfkit`/`pdf-lib`), `policy-field-maps.js` + `policy-renderer.js` (onboarding legal-doc templates), `routemate-client.js` (Routemate ELD adapter).

## Architecture

### Backend (`server.js`)
Single-file Node.js/Express server (~11,200 lines, ~150 REST endpoints). Google Sheets as primary database (Sheets API v4), SQLite for local data, Google Drive for document uploads, Socket.IO for real-time events. Body limit raised to 50mb (base64 photos/signatures).

**Static file serving**: Express checks `client/dist/` (production build) → falls back to `public/` (legacy vanilla HTML/JS). SPA catch-all `app.get("*")` serves `index.html` for client-side routing.

**SQLite** (`app.db`, WAL mode) — ~35 tables organized by domain:

| Domain | Tables |
|--------|--------|
| Auth & users | `users` |
| Messaging | `messages`, `notifications`, `dispatch_notifications` |
| Dispatch | `load_responses`, `load_ratings`, `load_coordinates`, `deleted_loads` |
| Fleet | `trucks`, `truck_assignments`, `trailers`, `drivers_directory`, `carrier_driver_history` |
| Finance | `expenses`, `maintenance_fund`, `compliance_fees`, `invoices`, `investor_config` |
| Investors | `investors`, `investor_applications`, `investor_onboarding`, `investor_onboarding_documents`, `investor_payment_info`, `investor_outreach_log` |
| Driver onboarding | `job_applications`, `driver_onboarding`, `onboarding_documents`, `driver_payment_info` |
| Documents | `documents`, `legal_documents` |
| Tracking | `driver_locations`, `geocode_cache` |
| Admin | `audit_trail` |

Session store also in SQLite.

**Schema migrations** on boot:
- `ALTER TABLE ... ADD COLUMN` for new columns (checks existing first).
- **Rename-recreate** for CHECK constraint changes: test-insert in try-catch; on failure, renames the table, creates a new one with the updated constraint, migrates data, drops old, clears sessions to force re-login.

**Notable libraries**: `pdfkit` (PDFs for applications/invoices/onboarding; converts base64 camera photos via `imageToPdf()`), `pdf-lib` (used alongside pdfkit for signature embedding), `tesseract.js` (OCR on POD uploads only — expense OCR moved to Gemini after accuracy issues; errors silently swallowed, never blocks upload), `nodemailer` (driver onboarding emails + investor outreach; needs `GMAIL_*`), `compression`, `express-rate-limit`.

**Gemini 2.5 Flash vision** — expense receipt OCR (`POST /api/expenses/ocr`). Called via `fetch` (no SDK) with `responseSchema` so the API enforces the JSON shape. Requires `GEMINI_API_KEY`; falls back to 503 + silent manual-entry. Retry pattern (2 retries, exp backoff, 15s `AbortController`) mirrors the Google Routes integration.

REST endpoints — the full verb/path/role catalog lives in `docs/manual/technical/07-appendix-api.md`. Only **non-obvious behavior** is noted below:

**Dashboard & dispatch**:
- `GET /api/dashboard` — enriches each job row with `_pickupLocation`/`_dropLocation` ("City, ST ZIP") + `_pickupStreet`/`_dropStreet` (line 1, `""` when none); JobBoard/ActiveLoads/CompletedLoads render these as a two-line address. Split via `splitAddressLines()`/`resolveAddressParts()` in server.js, mirrored client-side in `client/src/lib/address.js`. The public tracker shows "City, State" + a separate ZIP line — **never the street**.
- `POST /api/dispatch/cancel` — **Super Admin only**. Sets status `Cancelled` so the load drops from every KPI via `excludeDroppedLoads()`. Per 2026-04-19 client decision dispatchers lost this; use the Driver reassign dropdown for swaps.
- `DELETE /api/loads/:loadId` — **Super Admin only**. Soft-delete via `deleted_loads` SQLite table; sheet row stays for audit. Reversible via `DELETE FROM deleted_loads WHERE load_id = ?`.

**Driver**:
- `GET /api/driver/:driverName` — financial columns auto-hidden for Driver role. Returns `truckDocuments` (driver-visible legal docs on assigned truck) as **row IDs only — never file URLs**.
- `GET /api/driver/truck-documents/:id/view` — view-only inline stream; re-checks active `truck_assignments` on **every** request (reassignment revokes access immediately). Rate-limited; `Content-Disposition: inline` + `X-Content-Type-Options: nosniff`.

**Super Admin "View as investor" preview**: every `/api/investor/*` GET (plus `/api/trucks`) honors `?as_user_id=N` **only when** the session user is a Super Admin and N is a real Investor's `users.id`. `resolvePreviewUser(req)` validates and silently falls back to the session user otherwise — no 403, no info leak; handlers shadow `user.id`/`user.username`/`isSuperAdmin` so the investor-scoped branch runs unchanged. Each preview is audit-logged (`action='investor_preview_view'`). **Two conventions**: `?as_user_id=` keys on `users.id` (this feature); `?investor_id=` keys on `investors.id` (only `/api/investor/onboarding-documents` + `/api/legal-documents`). Frontend `/investor-portals/:userId` wraps `InvestorView.vue`, calls `investorStore.setPreview(userId)` (resets state to avoid stale-data flash — Pinia singleton gotcha), and stamps a read-only banner (hides chat composer, "Add Truck", legal-doc upload/delete).

**Expenses**: `POST /api/expenses/ocr` — sends receipt to Gemini, returns `{amount, date, vendor, gallons, odometer, suggestedType, confidence}` for ExpenseForm prefill. Roles: Driver/Super Admin/Dispatcher; rate-limited; 503 when key unset.

**Invoices**: `POST /api/invoices/generate` — weekly (Sat–Fri). Fixed-driver pay = active-days clipped to the billing week × the truck's `driver_pay_daily`; owner-op/percentage drivers bill `(week revenue − fuel/maintenance) × pct`. Reads the sheet directly so applies its own `getDeletedLoadIds()` filter. See *Key Conventions → "Driver active days"* + *"Load exclusion"*.

**Financials** (Super Admin only): `GET /api/financials` — P&L. Revenue counts in the month the load was **assigned**, not delivered (matches dashboard); only completed loads count toward `totalRevenue`. Reconciles with `/api/dashboard` + `/api/investor` via `excludeDroppedLoads()`. Driver pay uses the active-days basis.

**Public tracker** (no auth): `GET /api/public/track/:loadId` — customer tracker. Strict response **whitelist** — driver name, phone, broker, rate, notes never flow through; GPS redacted if >2h stale. Input sanitized via `/^[A-Za-z0-9\-_.#]{1,40}$/`. Load-ID-only verification is an accepted client tradeoff, mitigated by the rate limiter, whitelist, and `X-Robots-Tag: noindex, nofollow`.

**Documents**: `POST /api/legal-documents/upload` — `visibleToDriver` only honored when `truck_id > 0` (per-truck docs are the only kind the Driver Kit shows). `PATCH /api/legal-documents/:id/visibility` flips it without re-uploading.

**Location**: `POST /api/location` — retired **410 Gone** stub (Routemate ELD is the sole GPS source).

**Debug** (`/api/debug/*`) — **no auth, development only.**

**Socket.IO events** (server → clients): `load-assigned` (to driver), `load-cancelled` (to driver), `load-deleted`/`load-accepted`/`load-declined`/`status-updated`/`pod-uploaded`/`location-update`/`geofence-trigger` (to dispatch room), `dispatch-notification` (dispatch room — `metadata.loadId` drives click-routing → `/dashboard?load=<id>` auto-opens the load modal via `ActiveLoadsTab`'s `focusLoadId` prop), `new-message` (to all), `reload` (to all 500ms after server start — dev live reload). Clients emit `register` with their name to join a socket room.

**Status progression**: `PUT /api/driver/status` enforces one-active-job — a driver can't transition to "At Shipper" if another load is `at shipper|loading|in transit|at receiver` (409 Conflict). Every change logged to "Status Logs" sheet with `LOG-{timestamp}`. Update uses `batchUpdate` to atomically set status + the corresponding date column.

Session-based auth, 4 roles: Super Admin, Dispatcher, Driver, Investor. Middleware: `requireAuth` (401), `requireRole(...)` (403). First-time setup creates Super Admin via `POST /api/auth/setup`.

**Role-based data sanitization**: `PUT /api/data/:rowIndex` preserves broker/phone columns for non-Super Admin (values read from sheet and spliced back before writing). `GET /api/data` strips financial columns for Driver.

**Error handling**: try-catch with generic 500 JSON. Geofence check errors inside location flow are caught/logged but never fail the response.

**Rate limiting** (express-rate-limit, `standardHeaders: true`, naming `{feature}Limiter`):
| Limiter | Window | Max | Scope |
|---------|--------|-----|-------|
| `publicFormLimiter` | 15m | 10 | `POST /api/public/apply`, `/api/public/investor-apply` |
| `loginLimiter` | 15m | 20 | `POST /api/auth/login` |
| `changePasswordLimiter` | 15m | 5 | password change |
| `driverFilesLimiter` | 15m | 30 | `GET /api/trucks/:id/driver-files` |
| `truckDocViewLimiter` | 15m | 30 | `GET /api/driver/truck-documents/:id/view` |
| `trackPublicLimiter` | 15m | 60 | `GET /api/public/track/:loadId` |
| `expenseOcrLimiter` | 15m | 20 | `POST /api/expenses/ocr` (caps Gemini spend) |

The 60s in-memory Job Tracking sheet cache (`getJobTrackingCached()`) is the other core throttle — absorbs bursty dashboard traffic so Google Sheets' 300 req/min quota isn't a real constraint.

### Frontend (`client/`)
Vue 3 + Vite SPA. Vue Router, Pinia, Tailwind v4, shadcn-vue (radix-vue/reka-ui), Vant mobile UI, Leaflet + Google Maps, Socket.IO client.

Key directories:
- `stores/` — auth, dashboard, sheets, driver, messages, investor, users, adminTools, dispatchNotifications, driversDb, investors, trucks, trailers, invoices, financials
- `composables/` — useApi, useSocket, useToast, usePagination, useGeocode, useGoogleMaps
- `components/ui/` — shadcn-vue primitives
- `views/` — 24 view components (includes public `TrackLoadView.vue`)
- `wizard/` — JSON-driven wizard framework for the multi-step Invest application. `engine/WizardEngine.js` interprets a step schema from `data/`, `expressionEvaluator.js` evaluates `show-if`/`require-if` conditions without `eval()`, `spotlight.js` drives the guided highlight overlay. Extend this engine for new multi-step forms instead of rolling a bespoke stepper.

**Vite proxy** (`client/vite.config.js`): `/api` and `/socket.io` (with `ws: true`) → `http://localhost:3000`.

**Composable singletons**: `useApi()`, `useSocket()`, `useToast()` are module-level singletons, not per-component instances. Each Pinia store instantiates `const api = useApi()` at module scope. `useSocket` maintains a single global socket connection.

**Phone GPS retired** (2026-05-13): Routemate ELD is the sole location source. The `useGeolocation` composable was deleted; the driver app no longer requests location permission or reports pings; the full-screen "Location Access Required" gate was removed from `DriverView`. `POST /api/location` is a 410 Gone stub so cached old-phone clients get a clear error. See `routemateSyncTelemetry()` for the live-position pipeline.

**useGoogleMaps**: Loads the Google Maps JS API via `@googlemaps/js-api-loader`; fetches the key from `GET /api/config/maps-key`.

**Optimistic updates**: Both `driver` and `messages` stores append messages locally before the API request completes.

**Mobile / admin drawer**: Shared `appShell` Pinia store exposes `isMobile` (resize-listener-driven) and `sidebarOpen`. On mobile, `AppSidebar.vue` is a slide-in drawer with backdrop overlay; on desktop, the same component is the persistent collapsible sidebar. New admin views should toggle via `appShell.openSidebar()` instead of rolling their own mobile nav. Admin pages (Dashboard, Notifications, Messages, Expenses) collapse multi-pane layouts into single-pane stacks below the `md` Tailwind breakpoint and swap detail tables for card lists (Phase 0–4 commits `dbe9d4e` … `8e1a62d`). Vant is reserved for driver/public surfaces; admin views stick with shadcn-vue + Tailwind.

**Routing** (25 routes, role-guarded).
- **Public**: `/login`, `/apply` (driver), `/invest` (investor), `/track` + `/track/:loadId` (customer tracker — `alwaysPublic` so logged-in admins can preview).
- **Driver**: `/driver` (no sidebar; also accessible to Super Admin).
- **Investor**: `/investor`, `/trucks` (also Super Admin/Dispatcher).
- **Dispatcher + Super Admin**: `/dashboard`, `/tracking`, `/expenses`, `/messages`, `/notifications`, `/trailers`.
- **Super Admin only**: `/jobs/new`, `/invoices`, `/data`, `/users`, `/investors`, `/investor-portals` + `/investor-portals/:userId` (read-only investor preview, scoped via `?as_user_id=`), `/drivers`, `/applications`, `/investor-applications`, `/admin/tools`, `/admin/financials`, `/archive`.

Auth guard calls `checkSession()` on first navigation only (blocks until resolved); subsequent navigations use cached `isAuthenticated`. Unauthorized → `auth.roleHome` (Driver→`/driver`, Dispatcher→`/dashboard`, Investor→`/investor`). Routes with `meta: { alwaysPublic: true }` (only the `/track` family today) bypass the "authenticated users redirect to roleHome" rule applied to `/login`, `/apply`, etc. — so a logged-in dispatcher can preview the customer tracker without being punted home.

### Legacy Frontend (`public/`)
Original vanilla HTML/CSS/JS pages. Kept as fallback — Express serves `client/dist/` if it exists, otherwise `public/`.

## Key Conventions

- **Row indexing**: Row 1 = headers, row 2+ = data. API uses 1-based row indices. Each data object includes `_rowIndex`. DELETE converts to 0-indexed for Sheets `batchUpdate` `deleteDimension` (`startIndex: rowIndex - 1`).
- **Sheet selection**: All data endpoints accept `?sheet=`; defaults to "Job Tracking".
- **Value format**: POST/PUT bodies use `{ values: ["col1", ...] }` with `valueInputOption: "USER_ENTERED"` (supports formulas).
- **Column detection via regex**: Both backend and frontend match headers dynamically — `/driver/i`, `/rate|amount|revenue|pay|charge|price|cost/i` (financials hidden from Driver), `/status/i`, `/load.?id|job.?id/i`, `/origin.*lat|pickup.*lat/i`, `/dest.*lat|delivery.*lat/i`. Flexible to varying sheet column names.
- **Driver fields**: Columns matching `/driver/i` render as `<select>` populated from the first driver-like column in "Carrier Database".
- **Role-based routing**: Super Admin all; Dispatcher dashboard+data (no broker/financial); Driver driver app only (no sidebar); Investor financial view + truck fleet.
- **Geofence logic**: `tryGeofenceAdvance()` (called from `routemateSyncTelemetry()`) uses `geolib.isPointWithinRadius()` with a **500m threshold** against each ELD ping. Auto-advances only when current status matches the expected predecessor (Dispatched/Assigned/Heading to Shipper → At Shipper; In Transit → At Receiver). Never auto-writes a completion. Errors caught silently; emits `geofence-trigger` + `dispatch-notification`.
- **ETA calculation**: `geolib.getDistance()` to destination; default speed `24.587 m/s` (~55 mph) when GPS speed is unreliable. Compares to scheduled delivery for "on-time" / "delayed".
- **IFTA state matching**: Hardcoded bounding boxes for ~24 US states.
- **Sheet ID caching**: Google Sheet tab GIDs cached in a `Map`. Lazy-init via `getSheetId()`.
- **Geocode caching**: Results cached in `geocode_cache` SQLite table.
- **No transactions**: Multi-step ops (update sheet + append log + emit socket) are not atomic. Mid-op network failures can leave data inconsistent.
- **Onboarding documents**: Driver and investor flows use seeded lists (`ONBOARDING_DOCS`, `INVESTOR_ONBOARDING_DOCS`) with PDF generation and electronic signature capture.
- **Audit trail**: Admin actions (user creation, driver rename, etc.) are logged to `audit_trail`.
- **Load exclusion is centralized**: every load-revenue aggregator (`/api/dashboard`, `/api/financials`, `/api/investor`) runs sheet data through `excludeDroppedLoads(rows, headers)` before any math. Drops (a) rows whose status matches `CANCELED_STATUS_RE = /^(cancel|canceled|cancelled)$/i` and (b) rows whose `load_id` is in `deleted_loads`. Keep this single helper the only place that decides "is this load live?". `POST /api/invoices/generate` reads the sheet directly so applies its own `getDeletedLoadIds()` filter — keep in sync.
- **Driver "active days" = completed loads ∩ ELD travel** (the driver-pay basis; shared by `/api/investor`, `/api/financials`, `POST /api/invoices/generate`): a day counts only when the assigned truck **actually traveled** that calendar day **and** the day falls inside a **completed** load's pickup→delivery window. "Traveled" = a clean `routemate_telemetry` ping (`dropped_reason=''`) with `speed > 2.235` m/s (~5 mph). Helper `getEldTravelDaysByVehicle(vehicleIds, minMs, maxMs)` → `{ vid: { travel: Set<"YYYY-MM-DD">, coverage: Set<...> } }`; each ping bucketed into the **truck's local calendar day** — zone derived per-ping from the ping longitude (`usTzForLongitude` → continental-US IANA, DST-aware via `Intl`), so a late-evening trip lands on the working day, not server UTC. Load-window days are bare wall-clock from the sheet (`fmtDate`/`expandDateRange`), aligned with truck-local. (Falls back to Central when longitude is missing.) Truck→vehicle mapped via `trucks.routemate_vehicle_id` (matched on `LOWER(unit_number)`). **Coverage-aware fallback**: if a load's window has *no* ELD pings (truck not linked, or pre-feed) it falls back to the full scheduled window so historical/un-instrumented pay isn't zeroed; covered-but-*parked* correctly yields 0. Daily rate = truck's `driver_pay_daily` (falls back to `$250`) — invoices used to hardcode `$250`, now reconciled. Only `/^(delivered|completed|pod received)$/i` count — the old broad `activeWorkStatuses` is gone, so deadhead/in-progress/parked are excluded. `parseSheetDate` accepts ISO `YYYY-MM-DD` and US `M/D/Y`. Each driver-month tagged `source: eld | mixed | estimated`; `EarningsSection.vue` renders an "ELD-verified / partly / estimated" badge. **Keep all three endpoints in lockstep**. (Invoices additionally clip to the Sat–Fri billing week.)
- **Two soft-delete patterns coexist** — pick the right one for new tables:
  - **`deleted_loads` separate table** (load_id keyed): used because the canonical row lives in Google Sheets. Query: `LEFT JOIN deleted_loads ... WHERE deleted_loads.load_id IS NULL`. Recover: `DELETE FROM deleted_loads WHERE load_id = ?`.
  - **`deleted_at` timestamp column** on source table: used by `job_applications` (listing endpoints filter `WHERE deleted_at IS NULL`; `?include_deleted=true` for admin recovery). Cheaper (no join) but only works when the table itself lives in SQLite.
- **Notification click routing**: Every `dispatch-notification` stores `loadId` in `metadata` JSON. `NotificationsView` parses it and `router.push('/dashboard?load=<loadId>')`. `DashboardView` reads `route.query.load`, switches to Active Loads tab, and passes `focusLoadId` into `ActiveLoadsTab`, which auto-opens that load's modal then emits `focus-consumed` to clear the query.
- **SQLite timestamps on the wire**: SQLite `CURRENT_TIMESTAMP` is UTC but serializes zone-less (`"2026-04-20 14:30:00"`), which JS parses as local time. When exposing DB timestamps, wrap with `strftime('%Y-%m-%dT%H:%M:%SZ', created_at)` so the client can `new Date(ts)` correctly. `/api/dispatch-notifications` does this; follow for new endpoints.

## Google APIs

- **Sheets API v4**: Primary DB. Rate limit 300 req/min. `valueInputOption: "USER_ENTERED"`.
- **Drive API v3**: Document/POD uploads to a shared folder (`GOOGLE_DRIVE_FOLDER_ID`). Photos converted to PDF via pdfkit before upload.
- **Maps APIs**: Directions, Geocoding, Places — route calc, address lookup, geocode cache. Key exposed via `GET /api/config/maps-key`.
- Scopes: `spreadsheets`, `drive.file`. Service account: `sheets-bot@logistics-app-491014.iam.gserviceaccount.com`. Spreadsheet + Drive folder must be shared with this email as Editor.
- API clients (`sheetsClient`, `driveClient`) are lazy-initialized singletons via `getSheets()` / `getDrive()`.

## Routemate ELD / telematics

Replacement for phone-based driver GPS. Routemate is FMCSA-certified ELD hardware installed in trucks; LogisX pulls from their cloud REST API.

**Adapter:** `lib/routemate-client.js` — single point of contact. Auth via `X-Api-Key` header. Retry/backoff + 15s `AbortController` timeout mirror the Gemini OCR pattern. Returns normalized objects so a future Routemate API change ripples through one file. No other module talks to Routemate directly.

**Env vars** (see `.env.example`): `ROUTEMATE_BASE_URL` (default `https://cloud.routemate.ai`), `ROUTEMATE_API_KEY` (sent as `X-Api-Key`), `ROUTEMATE_ENABLED` (master kill switch — when `false`, sync intervals are dormant and the manual probe returns 503; **default off** until the key is wired in prod), `ROUTEMATE_POLL_LIVE_SEC` (60, Phase 2 telemetry), `ROUTEMATE_POLL_FAULTS_SEC` (300, Phase 5 faults), `ROUTEMATE_POLL_DAILY_HOUR` (4, Phase 3+ rollups).

**SQLite tables** (all `IF NOT EXISTS` — additive, reversible):
- `routemate_vehicles` — local mirror of Routemate inventory (synced via `POST /api/admin/routemate/sync-now`). UNIQUE on `routemate_vehicle_id`.
- `routemate_telemetry` — live GPS feed, append-only. Also the source of truth for driver-pay **active days** (see Key Conventions).
- `routemate_fault_codes` — UNIQUE on `(routemate_vehicle_id, code)`.
- `routemate_dvir` — DVIR inspection reports, UNIQUE on `dvir_id`.
- `routemate_fuel_daily` — telemetry-derived MPG rollup (Phase 4).
- `routemate_hos_daily` — driver duty-time rollup (Phase 3).

`trucks` gains one additive column via the existing try/catch ALTER pattern: `routemate_vehicle_id TEXT DEFAULT ''`. Set by admins in the Trucks UI to link a LogisX truck to a Routemate vehicle.

**`driver_locations`** retains historical rows but is no longer written/read as of 2026-05-13. `GET /api/locations/latest` and `/trail` now source exclusively from `routemate_telemetry`; responses tag `source: 'routemate' | 'none'`. The 90-day purge job continues aging the legacy data out.

**Phase 1 endpoints** (only ones live as of foundation):
- `POST /api/admin/routemate/sync-now` — Super Admin only. Returns 503 when disabled/key unset; otherwise calls `getCompany()` as a smoke test then paginates `listVehicles()` and upserts into `routemate_vehicles`. Logs `audit_trail.action = 'routemate_sync'`.
- `GET /api/routemate/health` — Super Admin only. Returns `{enabled, hasKey, baseUrl, lastSync, lastError, errorsLast24h}`.

**No webhooks in Routemate v0.** Pull-only via `setInterval` (mirrors `purgeOldDriverLocations` at server.js:726). All gated by `ROUTEMATE_ENABLED`. Demo viewer blocked from `/sync-now` via the global write-lockdown middleware (server.js:~1630).

**Spec:** OpenAPI 3.0.1 at `https://cloud.routemate.ai/v3/api-docs` (publicly readable). Path prefix `/api/v0/`.
