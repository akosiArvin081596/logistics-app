# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Backend (Express server)
npm start            # Run server (node server.js) on port 3000
npm run dev          # Run with nodemon for auto-restart on file changes

# Frontend (Vue 3 + Vite SPA)
npm run dev:client   # Start Vite dev server on port 5173 (proxies to Express:3000)
npm run build:client # Production build to client/dist/
```

Development requires two terminals: `npm run dev` + `npm run dev:client`. Open http://localhost:5173 during development.

For production: `npm run build:client` then `npm start` — Express serves the built SPA from `client/dist/`.

`postinstall` auto-runs `cd client && npm install`, so `npm install` at root installs both backend and frontend deps.

**Deploy:** production runs on a VPS at `76.13.22.110` under `/var/www/logistics-app`, managed by pm2 (process name `logistics-app`). Standard deploy flow after merging to `main`:
```bash
ssh root@76.13.22.110 "cd /var/www/logistics-app && git pull --ff-only origin main && npm install --silent --no-audit --no-fund && npm run build:client --silent && pm2 restart logistics-app --silent"
```
A staging process (`logisx-staging`) also runs on the same VPS.

**Tests & linting:** No Jest/Mocha/Vitest/ESLint configured. A standalone integration harness lives at `test-suite.js` — 25 tests that hit a running server over HTTP (requires `npm start` first, then `node test-suite.js`). Covers auth, role gating, debug-endpoint auth, webhook secret, chat file validation, and canceled-load exclusion. Exits 1 on any failure. Seed the DB via `scripts/truncate-and-seed.js` before running if you want deterministic state. When editing `server.js`, run `node --check server.js` before committing (the file is ~11k lines; a syntax error there breaks the whole app).

## Environment Setup

Required files at project root:
- `service-account-key.json` — Google service account credentials (not in git)
- `.env` — environment variables

```
GOOGLE_DRIVE_FOLDER_ID=<Drive folder ID for POD uploads — optional, uploads skip Drive if empty>
GOOGLE_MAPS_API_KEY=<Google Maps API key — required for maps, routing, geocoding, and places>
GMAIL_USER=<Gmail address for sending onboarding/outreach emails>
GMAIL_APP_PASSWORD=<Gmail app password for nodemailer>
GEMINI_API_KEY=<optional — enables receipt OCR auto-fill via Gemini 2.5 Flash vision; form falls back to manual entry when unset>
GEMINI_OCR_MODEL=<optional — override the default gemini-2.5-flash model>
PORT=3000  # optional, defaults to 3000
```

Hardcoded values in `server.js` (change if forking):
- Spreadsheet ID: `"1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"` — the production Dispatch Management sheet that n8n writes into. A separate archive sheet (`1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI`) is referenced only by the archive viewer.
- Session secret: Set via `SESSION_SECRET` env var (required for production; falls back to default for dev)

Helper scripts in `scripts/`:
- `reset-super-admin-password.js` — reset the Super Admin password against the local SQLite DB.
- `truncate-and-seed.js` — wipe and reseed the local DB for clean-slate testing.
- `seed-staging.js` — seed a staging DB.
- `create-demo-user.js` — create a demo user for testing.
- `geocode-loads.js` — backfill geocodes for rows in "Job Tracking".
- `generate-timeline-docx.py` / `generate-timeline-apr13-apr17.py` — one-off Python scripts that render session-timeline `.docx` reports from source HTML/markdown (requires `python-docx`).

Shared server-side modules live in `lib/` (required from `server.js`):
- `ifta-states.js` — US state bounding-box lookup used by the IFTA mileage classifier.
- `pdf-browser.js` — Puppeteer-backed HTML→PDF renderer used for onboarding and investor document generation. (This is why `puppeteer` is a top-level dep alongside `pdfkit`/`pdf-lib`.)
- `policy-field-maps.js`, `policy-renderer.js` — field mapping + template rendering for onboarding legal documents.

## Architecture

### Backend (`server.js`)
Single-file Node.js/Express server (~11,200 lines, ~150 REST endpoints) using Google Sheets as the primary database via Sheets API v4, with SQLite for local data. Google Drive API for document uploads. Socket.IO for real-time events. Body limit raised to 50mb to accept large application payloads with embedded base64 photos/signatures.

**Static file serving**: Express checks if `client/dist/` exists (production build) → falls back to `public/` (legacy vanilla HTML/JS). SPA catch-all `app.get("*")` serves `index.html` for client-side routing.

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

**Schema migrations**: On boot, server runs two types of migrations:
- `ALTER TABLE ... ADD COLUMN` for adding new columns. Checks for existing columns first.
- **Rename-recreate** for CHECK constraint changes: when the role constraint needs updating, the code does a test insert in a try-catch; on failure, it renames the table, creates a new one with the updated constraint, migrates data, drops the old, and clears all sessions to force re-login.

**Notable libraries**:
- **pdfkit**: Generates PDFs for applications, invoices, onboarding documents, and converts base64 camera photos to PDF for Drive uploads (`imageToPdf()`).
- **pdf-lib**: Used alongside pdfkit for document manipulation (e.g., embedding signatures into onboarding PDFs).
- **tesseract.js**: OCR fallback on POD image uploads only (`extractReceiptText()` at `POST /api/documents/upload`). Historically hooked into expense receipts but was unwired once accuracy turned out to be too low — expense-receipt OCR now goes to Gemini instead (see below). Errors are silently swallowed — OCR failure never blocks the underlying upload.
- **nodemailer**: Sends emails for driver onboarding acceptance and investor outreach. Requires `GMAIL_USER` and `GMAIL_APP_PASSWORD` env vars.
- **compression**: Gzip response compression middleware.
- **express-rate-limit**: Per-endpoint limiters; see the rate-limiting section below.

**AI / vision services**:
- **Gemini 2.5 Flash vision** — powers expense receipt OCR (`POST /api/expenses/ocr`). Called via `fetch` (no SDK) with `responseSchema` so the API enforces the JSON shape. Requires `GEMINI_API_KEY`; falls back to 503 + silent manual-entry in the driver form when unset. Same key is reused across Alchemy projects so credentials rotate in one place. Retry pattern (2 retries, exp backoff, 15 s `AbortController` timeout) mirrors the Google Routes integration.

REST endpoints — the full verb/path/role catalog lives in `docs/manual/technical/07-appendix-api.md`. Only the **non-obvious behavior** that reference doesn't capture is noted below:

**Dashboard & dispatch**:
- `GET /api/dashboard` — enriches each job row with `_pickupLocation`/`_dropLocation` ("City, ST ZIP") + `_pickupStreet`/`_dropStreet` (line 1, `""` when none); JobBoard/ActiveLoads/CompletedLoads render these as a two-line address (street over "City, ST ZIP") in place of the raw broker-reference column. Split by `splitAddressLines()`/`resolveAddressParts()` in server.js, mirrored client-side in `client/src/lib/address.js`. The public tracker shows "City, State" + a separate ZIP line — **never the street**.
- `POST /api/dispatch/cancel` — **Super Admin only**. Sets status `Cancelled` (not `Unassigned`) so the load drops from every KPI via `excludeDroppedLoads()`. Per 2026-04-19 client decision dispatchers lost this; use the Driver reassign dropdown for swaps.
- `DELETE /api/loads/:loadId` — **Super Admin only**. Soft-delete via the `deleted_loads` SQLite table; the sheet row stays for audit but is filtered from all admin lists + KPIs. Reversible via `DELETE FROM deleted_loads WHERE load_id = ?`.

**Driver**:
- `GET /api/driver/:driverName` — financial columns auto-hidden for Driver role. Also returns `truckDocuments` (driver-visible legal docs on the assigned truck) as **row IDs only — never file URLs**.
- `GET /api/driver/truck-documents/:id/view` — view-only inline stream; re-checks the active `truck_assignments` row on **every** request (reassignment revokes access immediately). Rate-limited; `Content-Disposition: inline` + `X-Content-Type-Options: nosniff`.

**Super Admin "View as investor" preview**: every `/api/investor/*` GET (plus `/api/trucks`) honors `?as_user_id=N` **only when the session user is a Super Admin and N is a real Investor's `users.id`**. `resolvePreviewUser(req)` (server.js, below `getInvestorDriverSet`) validates and silently falls back to the session user otherwise — no 403, no info leak; handlers then shadow `user.id`/`user.username`/`isSuperAdmin` so the investor-scoped branch runs unchanged. Each preview is audit-logged (`audit_trail.action = 'investor_preview_view'`). Note two conventions: `?as_user_id=` keys on `users.id` (this feature); `?investor_id=` keys on `investors.id` (only `/api/investor/onboarding-documents` + `/api/legal-documents`). Frontend `/investor-portals` → `/investor-portals/:userId` wraps `InvestorView.vue`, calls `investorStore.setPreview(userId)` (resets `data`+`isLoading` to avoid stale-data flash — Pinia singleton gotcha), and stamps a read-only banner (hides chat composer, "Add Truck", legal-doc upload/delete).

**Expenses & finance**:
- `POST /api/expenses/ocr` — sends a receipt image to Gemini 2.5 Flash vision, returns `{amount, date, vendor, gallons, odometer, suggestedType, confidence}` to prefill the driver's ExpenseForm. Role: Driver/Super Admin/Dispatcher; rate-limited; 503 when `GEMINI_API_KEY` unset (form falls back to manual entry).

**Invoices**:
- `POST /api/invoices/generate` — weekly (Sat–Fri) invoice PDF. Fixed-driver pay = active-days basis clipped to the billing week × the truck's `driver_pay_daily`; owner-op/percentage drivers bill `(week revenue − fuel/maintenance) × pct`. Reads the sheet directly, so applies its own `getDeletedLoadIds()` filter. See *Key Conventions → "Driver active days"* + *"Load exclusion"*.

**Financials** (Super Admin only):
- `GET /api/financials` — P&L. Revenue counts in the month the load was **assigned**, not delivered (matches the dashboard); only completed loads count toward `totalRevenue`; reconciles with `/api/dashboard` + `/api/investor` via `excludeDroppedLoads()`. Driver pay uses the active-days basis (see *Key Conventions*).

**Public tracker** (no auth):
- `GET /api/public/track/:loadId` — customer tracker. Strict response **whitelist** — driver name, phone, broker, rate, notes never flow through; GPS redacted if >2 h stale. Load-ID-only verification is the accepted client tradeoff, mitigated by the rate limiter, the whitelist, and `X-Robots-Tag: noindex, nofollow`. Input sanitized via `/^[A-Za-z0-9\-_.#]{1,40}$/`.

**Documents & uploads**:
- `POST /api/legal-documents/upload` — `visibleToDriver` only honored when `truck_id > 0` (per-truck docs are the only kind the Driver Kit shows). `PATCH /api/legal-documents/:id/visibility` flips it without re-uploading.

**Location & maps**:
- `POST /api/location` — retired **410 Gone** stub (Routemate ELD is the sole GPS source; see "Phone GPS retired").

**Debug** (`/api/debug/*`) — **no auth, development only.**

**Socket.IO events** (server emits):
- `load-assigned` — to specific driver when dispatched
- `load-cancelled` — to driver when dispatch cancelled
- `load-deleted` — to dispatch room when a load is soft-deleted
- `load-accepted` / `load-declined` — to dispatch room on driver response
- `status-updated` — to dispatch room on load status change
- `dispatch-notification` — to dispatch room for all dispatch-related events. Notification `metadata` JSON includes `loadId` for every emitter; the admin NotificationsView uses that to route click → `/dashboard?load=<loadId>` which auto-opens the load's detail modal via ActiveLoadsTab's `focusLoadId` prop.
- `new-message` — to all on new chat message
- `pod-uploaded` — to dispatch room on document upload
- `location-update` — to dispatch room on driver GPS report
- `geofence-trigger` — to driver and dispatch room when geofence auto-triggers status
- `reload` — to all 500ms after server start (live reload during dev)

Clients emit `register` with their name to join a socket room.

**Status progression & guards**: Status updates (`PUT /api/driver/status`) enforce a one-active-job constraint — a driver cannot transition to "At Shipper" if they already have another load in an active state (`at shipper|loading|in transit|at receiver`), returning 409 Conflict. Every status change is logged to the "Status Logs" sheet with a `LOG-{timestamp}` entry, old→new status, and reason. The update uses `batchUpdate` to atomically set both the status column and corresponding date column.

Session-based auth with 4 roles: Super Admin, Dispatcher, Driver, Investor. Auth middleware: `requireAuth` (401), `requireRole(...roles)` (403). First-time setup creates the initial Super Admin via `POST /api/auth/setup`.

**Role-based data sanitization**: `PUT /api/data/:rowIndex` preserves broker and phone contact columns for non-Super Admin users (values are read from the sheet and spliced back in before writing). `GET /api/data` strips financial columns for Driver role.

**Error handling**: All endpoints use try-catch with generic 500 JSON responses. Geofence check errors inside `POST /api/location` are caught and logged but never fail the location response.

**Rate limiting** (express-rate-limit, all `standardHeaders: true`, naming convention `{feature}Limiter`):
| Limiter | Window | Max | Scope |
|---------|--------|-----|-------|
| `publicFormLimiter` | 15 min | 10 | `POST /api/public/apply`, `POST /api/public/investor-apply` |
| `loginLimiter` | 15 min | 20 | `POST /api/auth/login` |
| `changePasswordLimiter` | 15 min | 5 | password change |
| `driverFilesLimiter` | 15 min | 30 | `GET /api/trucks/:id/driver-files` |
| `truckDocViewLimiter` | 15 min | 30 | `GET /api/driver/truck-documents/:id/view` |
| `trackPublicLimiter` | 15 min | 60 | `GET /api/public/track/:loadId` (customers refresh often) |
| `expenseOcrLimiter` | 15 min | 20 | `POST /api/expenses/ocr` (caps Gemini spend) |

The 60s in-memory Job Tracking sheet cache (`getJobTrackingCached()`) is the other core throttle — it absorbs bursty dashboard traffic so Google Sheets' 300 req/min quota isn't a real constraint day-to-day.

### Frontend (`client/`)
Vue 3 + Vite SPA with Vue Router, Pinia stores, Tailwind CSS v4, shadcn-vue components (via radix-vue/reka-ui), Vant mobile UI, Leaflet + Google Maps for maps, and Socket.IO client for real-time updates.

Key directories:
- `stores/` — auth, dashboard, sheets, driver, messages, investor, users, adminTools, dispatchNotifications, driversDb, investors, trucks, trailers, invoices, financials
- `composables/` — useApi, useSocket, useToast, usePagination, useGeocode, useGoogleMaps
- `components/ui/` — shadcn-vue primitives (badge, button, card, dialog, input, select, skeleton, table, tabs)
- `components/` — feature-organized: layout, shared, dashboard, data-manager, driver, drivers-db, trucks, investors, investor, invest, apply, users
- `views/` — 24 view components (includes the public `TrackLoadView.vue`)
- `wizard/` — JSON-driven wizard framework used for the multi-step Invest application flow. `engine/WizardEngine.js` interprets a step schema from `data/`, `expressionEvaluator.js` evaluates `show-if`/`require-if` conditions without `eval()`, and `spotlight.js` drives the guided highlight overlay. When adding a new multi-step form, extend this engine instead of rolling a bespoke stepper.

**Vite proxy** (`client/vite.config.js`): `/api` and `/socket.io` (with `ws: true`) both proxy to `http://localhost:3000`.

**Composable singletons**: `useApi()`, `useSocket()`, and `useToast()` are module-level singletons, not per-component instances. Each Pinia store instantiates `const api = useApi()` at module scope. `useSocket` maintains a single global socket connection.

**Phone GPS retired**: As of 2026-05-13, Routemate ELD is the sole location source. The `useGeolocation` composable was deleted; the driver app no longer requests location permission, no longer reports pings, and the full-screen "Location Access Required" gate was removed from `DriverView`. `POST /api/location` (server.js) is a 410 Gone stub so cached clients on old phones get a clear error instead of 404. See `routemateSyncTelemetry()` for the live-position pipeline.

**useGoogleMaps**: Loads the Google Maps JS API via `@googlemaps/js-api-loader`, fetches the API key from `GET /api/config/maps-key`.

**Optimistic updates**: Both `driver` and `messages` stores append messages locally before the API request completes.

**Mobile / admin drawer**: A shared `appShell` Pinia store exposes `isMobile` (resize-listener-driven) and `sidebarOpen`. On mobile, `AppSidebar.vue` renders as a slide-in drawer with a backdrop overlay (`v-if="isMobile && appShell.sidebarOpen"`); on desktop, the same component is the persistent collapsible sidebar. New admin views should toggle the drawer via `appShell.openSidebar()` instead of rolling their own mobile nav. Admin pages (Dashboard, Notifications, Messages, Expenses) are responsive top-down — Phase 0–4 commits (`dbe9d4e` … `8e1a62d`) collapse multi-pane layouts into single-pane stacks below the `md` Tailwind breakpoint and swap detail tables for card lists. Vant components are reserved for the driver/public surfaces; admin views stick with shadcn-vue + Tailwind.

**Routing** (25 routes with role-based guards):

| Route | Access | Notes |
|-------|--------|-------|
| `/login` | Public | Redirects authenticated users to role home |
| `/apply` | Public | Driver application form (no sidebar) |
| `/invest` | Public | Investor application form (no sidebar) |
| `/track` | Public (`alwaysPublic`) | Customer search form — enter Load ID to track |
| `/track/:loadId` | Public (`alwaysPublic`) | Customer tracker view with stages, ETA, live map. Accessible to logged-in admins too (so dispatchers can preview what a customer sees). |
| `/dashboard` | Super Admin, Dispatcher | |
| `/jobs/new` | Super Admin | Create new job |
| `/tracking` | Super Admin, Dispatcher | |
| `/expenses` | Super Admin, Dispatcher | |
| `/invoices` | Super Admin | Invoice workflow |
| `/messages` | Super Admin, Dispatcher | |
| `/notifications` | Super Admin, Dispatcher | |
| `/data` | Super Admin | Sheet data manager |
| `/driver` | Driver, Super Admin | Driver app (no sidebar) |
| `/investor` | Super Admin, Investor | Investor dashboard |
| `/users` | Super Admin | |
| `/trucks` | Super Admin, Dispatcher, Investor | |
| `/investors` | Super Admin | Investor records management |
| `/investor-portals` | Super Admin | Index of investors — opens a read-only replica of each one's portal |
| `/investor-portals/:userId` | Super Admin | Read-only preview of a single investor's `/investor` view (banner + same components, scoped via `?as_user_id=`) |
| `/drivers` | Super Admin | Drivers directory |
| `/trailers` | Super Admin, Dispatcher | |
| `/applications` | Super Admin | Driver applications review |
| `/investor-applications` | Super Admin | Investor applications review |
| `/admin/tools` | Super Admin | Admin data tools |
| `/admin/financials` | Super Admin | Company P&L view |
| `/archive` | Super Admin | Archived data viewer |

Auth guard calls `checkSession()` on first navigation only (blocks until resolved), then subsequent navigations use cached `isAuthenticated` state. Unauthorized users redirect to `auth.roleHome` (Driver → `/driver`, Dispatcher → `/dashboard`, Investor → `/investor`).

Routes flagged `meta: { alwaysPublic: true }` (only `/track` and `/track/:loadId` today) bypass the "authenticated users get redirected to roleHome" rule applied to other public routes like `/login` and `/apply` — so a logged-in dispatcher can still preview the customer-facing tracker without being punted home.

### Legacy Frontend (`public/`)
Original vanilla HTML/CSS/JS pages. Kept as fallback — Express serves `client/dist/` if it exists, otherwise `public/`.

## Key Conventions

- **Row indexing**: Row 1 = headers, row 2+ = data. API uses 1-based row indices. Each data object includes `_rowIndex`. DELETE internally converts to 0-indexed for Sheets `batchUpdate` `deleteDimension` (`startIndex: rowIndex - 1`).
- **Sheet selection**: All data endpoints accept `?sheet=` query param; defaults to "Job Tracking".
- **Value format**: POST/PUT bodies use `{ values: ["col1", "col2", ...] }` with `valueInputOption: "USER_ENTERED"` (supports formulas).
- **Column detection via regex**: Both backend and frontend match headers dynamically with regex patterns — `/driver/i` for driver columns, `/rate|amount|revenue|pay|charge|price|cost/i` for financial columns (hidden from Driver role), `/status/i` for status, `/load.?id|job.?id/i` for load IDs, `/origin.*lat|pickup.*lat/i` and `/dest.*lat|delivery.*lat/i` for coordinates. This makes the system flexible to different sheet column names.
- **Driver fields**: Any column matching `/driver/i` renders as a `<select>` populated from the first driver-like column in "Carrier Database".
- **Role-based routing**: Super Admin sees all, Dispatcher sees dashboard+data (no broker/financial info), Driver sees driver app (no sidebar), Investor sees financial view + truck fleet.
- **Geofence logic**: `tryGeofenceAdvance()` (called from `routemateSyncTelemetry()`) uses `geolib.isPointWithinRadius()` with a **500m threshold** against each ELD ping's lat/lng. Auto-advances status only when current status matches the expected predecessor (Dispatched/Assigned/Heading to Shipper → At Shipper, In Transit → At Receiver). Never auto-writes a completion status. Geofence errors are caught silently; emits `geofence-trigger` + `dispatch-notification`. The phone-GPS path (`POST /api/location`) is retired — see "useGeolocation" note above.
- **ETA calculation**: Uses `geolib.getDistance()` to destination. Default speed: 24.587 m/s (~55 mph) when GPS speed is unreliable. Compares ETA vs scheduled delivery to flag "on-time" / "delayed".
- **IFTA state matching**: Hardcoded bounding boxes for ~24 US states to classify driver GPS pings by state.
- **Sheet ID caching**: Google Sheet tab GIDs are cached in a `Map` in memory to avoid repeated API lookups. Lazy-initialized via `getSheetId()`.
- **Geocode caching**: Geocode results are cached in the `geocode_cache` SQLite table to avoid redundant Google Maps API calls.
- **No transactions**: Multi-step operations (update sheet + append log + emit socket) are not atomic. Network failures mid-operation can leave data inconsistent.
- **Onboarding documents**: Both driver and investor onboarding use a seeded document list (`ONBOARDING_DOCS`, `INVESTOR_ONBOARDING_DOCS`) with PDF generation and electronic signature capture.
- **Audit trail**: Admin actions (user creation, driver rename, etc.) are logged to the `audit_trail` table.
- **Load exclusion is centralized**: every load-revenue aggregator (`/api/dashboard`, `/api/financials`, `/api/investor`) runs its sheet data through `excludeDroppedLoads(rows, headers)` before any math. That helper drops (a) rows whose status matches `CANCELED_STATUS_RE = /^(cancel|canceled|cancelled)$/i` and (b) rows whose `load_id` is in the `deleted_loads` SQLite table. Keep this single helper the only place that decides "is this load live?" so dashboard / financials / investor numbers stay consistent. `POST /api/invoices/generate` reads the sheet directly (not through this helper), so it applies its own `getDeletedLoadIds()` filter to avoid billing soft-deleted loads — keep that in sync.
- **Driver "active days" = completed loads ∩ ELD travel** (the driver-pay basis, shared by `/api/investor`, `/api/financials`, and `POST /api/invoices/generate`): an *active day* counts only when the assigned truck **actually traveled** that calendar day **and** the day falls inside a **completed** load's pickup→delivery window. "Traveled" = a clean `routemate_telemetry` ping (`dropped_reason=''`) with `speed > 2.235` m/s (~5 mph). Computed via the shared module-scope helper `getEldTravelDaysByVehicle(vehicleIds, minMs, maxMs)` → `{ vid: { travel: Set<"YYYY-MM-DD">, coverage: Set<...> } }`; each ping is bucketed into the **truck's local calendar day** — the zone is derived per-ping from the ping longitude (`usTzForLongitude` → a continental-US IANA zone, DST-aware via `Intl`), so a late-evening trip lands on the day the driver actually worked instead of the server's UTC day. The pickup→delivery window days are bare wall-clock dates from the sheet (via `fmtDate`/`expandDateRange`), so they stay as-is and line up with the truck-local travel days. (US-centric; falls back to Central when longitude is missing.) A load's truck → vehicle map comes from `trucks.routemate_vehicle_id` (matched on `LOWER(unit_number)`). **Coverage-aware fallback**: if a load's window has *no* ELD pings (truck not linked, or the load predates the feed) it falls back to the full scheduled window so historical / un-instrumented pay is never zeroed; a covered-but-*parked* window correctly yields 0. The fixed daily rate is the assigned truck's `trucks.driver_pay_daily` (falls back to `$250`) — invoices used to hardcode `$250`, now reconciled. Only `completedStatuses` (`/^(delivered|completed|pod received)$/i`) count — the old broad `activeWorkStatuses` set is gone, so deadhead travel, in-progress loads, and parked days are excluded. `parseSheetDate` in the investor/financials handlers accepts ISO `YYYY-MM-DD` as well as US `M/D/Y`. Each driver-month is tagged `source: eld | mixed | estimated`; `EarningsSection.vue` renders an "ELD-verified / partly / estimated" badge. **Keep all three endpoints in lockstep** so the investor portal, Financials P&L, and weekly invoice reconcile. (Invoices additionally clip the window to the Sat–Fri billing week.)
- **Two soft-delete patterns coexist**, by design — pick the right one for new tables:
  - **Separate `deleted_loads` table** (load_id keyed): used because the canonical row lives in Google Sheets, not SQLite. Query path: `LEFT JOIN deleted_loads ... WHERE deleted_loads.load_id IS NULL`. Recovery: `DELETE FROM deleted_loads WHERE load_id = ?`.
  - **`deleted_at` timestamp column** on the source table: used by `job_applications` (`scripts/truncate-and-seed.js` and listing endpoints filter `WHERE deleted_at IS NULL`; pass `?include_deleted=true` for admin recovery). Cheaper because no join, but only works when the table itself lives in SQLite.
- **Notification click routing**: Every `dispatch-notification` emitter stores `loadId` in the row's `metadata` JSON. The admin `NotificationsView` parses that and `router.push('/dashboard?load=<loadId>')`. `DashboardView` reads `route.query.load`, switches to the Active Loads tab, and passes `focusLoadId` into `ActiveLoadsTab`, which auto-opens that load's detail modal then emits `focus-consumed` so the query is cleared.
- **SQLite timestamps on the wire**: SQLite `CURRENT_TIMESTAMP` is UTC but serializes zone-less (`"2026-04-20 14:30:00"`), which JS parses as local time. When exposing DB timestamps to the frontend, wrap with `strftime('%Y-%m-%dT%H:%M:%SZ', created_at)` so the client can `new Date(ts)` correctly. `/api/dispatch-notifications` does this; follow the pattern for new endpoints that surface `created_at`.

## Google APIs

- **Sheets API v4**: Primary database. Rate limit 300 req/min. `valueInputOption: "USER_ENTERED"`.
- **Drive API v3**: Document/POD uploads to a shared folder (`GOOGLE_DRIVE_FOLDER_ID` env var). Photos are converted to PDF via pdfkit before upload.
- **Maps APIs**: Directions, Geocoding, Places — used for route calculation, address lookup, and geocode caching. API key exposed to frontend via `GET /api/config/maps-key`.
- Scopes: `spreadsheets`, `drive.file`
- Service account: `sheets-bot@logistics-app-491014.iam.gserviceaccount.com`
- Spreadsheet and Drive folder must be shared with this email as Editor.
- API clients (`sheetsClient`, `driveClient`) are lazy-initialized singletons via `getSheets()` / `getDrive()`.

## Routemate ELD / telematics integration

Replacement for phone-based driver GPS sharing. Routemate is FMCSA-certified ELD hardware installed in trucks; LogisX pulls from their cloud REST API.

**Adapter:** `lib/routemate-client.js` — single point of contact. Auth via `X-Api-Key` header. Retry/backoff + 15s `AbortController` timeout mirror the Gemini OCR pattern. Returns normalized objects so a future Routemate API change ripples through one file. Reused by every server-side caller; no other module talks to Routemate directly.

**Env vars** (defined in `.env.example`):
- `ROUTEMATE_BASE_URL` (default `https://cloud.routemate.ai`)
- `ROUTEMATE_API_KEY` — sent as `X-Api-Key`
- `ROUTEMATE_ENABLED` — master kill switch. When `false`, all sync intervals are dormant and the manual probe returns 503. **Default off** until the key is wired in production.
- `ROUTEMATE_POLL_LIVE_SEC` (default 60) — used by Phase 2 live-telemetry sync
- `ROUTEMATE_POLL_FAULTS_SEC` (default 300) — Phase 5 fault-code sync
- `ROUTEMATE_POLL_DAILY_HOUR` (default 4) — Phase 3+ daily rollups

**SQLite tables** (Phase 1, all `IF NOT EXISTS` — additive, reversible):

| Table | Purpose |
|---|---|
| `routemate_vehicles` | Local mirror of Routemate vehicle inventory (synced via `POST /api/admin/routemate/sync-now`). Fields: `routemate_vehicle_id` (UNIQUE), `vehicle_id`, `vin`, `make`, `model`, `year`, `fuel_type`, `eld_id`, `gps_ids` (JSON), `license_num`, `state`, `active`, `raw_json`, `last_synced_at`. |
| `routemate_telemetry` | Live GPS feed, append-only. Fields: `routemate_vehicle_id`, `latitude`, `longitude`, `speed`, `bearing`, `odometer`, `engine_hours`, `fuel_pct`, `geocoded_location`, `location_date_ms` (epoch ms from Routemate), `fetched_at`. Also the source of truth for driver-pay **"active days"** — see the "Driver active days = completed loads ∩ ELD travel" convention. |
| `routemate_fault_codes` | One row per active code per vehicle, UNIQUE on `(routemate_vehicle_id, code)`. Fields: `code`, `status`, `first_seen`, `last_seen`, `ack_by_user_id`, `ack_at`. |
| `routemate_dvir` | DVIR inspection reports per vehicle, UNIQUE on `dvir_id`. |
| `routemate_fuel_daily` | Telemetry-derived MPG rollup, UNIQUE on `(routemate_vehicle_id, date)`. Phase 4. |
| `routemate_hos_daily` | Driver duty-time rollup, UNIQUE on `(driver_id, date)`. Phase 3. |

**`trucks` table** gains one additive column via the existing try/catch ALTER pattern: `routemate_vehicle_id TEXT DEFAULT ''`. Set by admins via the Trucks UI (Phase 2) to link a LogisX truck to a Routemate vehicle.

**`driver_locations`** retains historical rows but is no longer written to and no longer read from any endpoint as of 2026-05-13. `GET /api/locations/latest` and `GET /api/locations/trail` now source exclusively from `routemate_telemetry`; responses tag `source: 'routemate'` when an ELD fix is available and `source: 'none'` otherwise. The 90-day purge job continues to age the legacy data out.

**Phase 1 endpoints** (only ones live as of foundation):
- `POST /api/admin/routemate/sync-now` — Super Admin only. Returns 503 when `ROUTEMATE_ENABLED=false` or key unset; otherwise calls `getCompany()` as a smoke test then paginates `listVehicles()` and upserts into `routemate_vehicles`. Logs to `audit_trail` with action `routemate_sync`.
- `GET /api/routemate/health` — Super Admin only. Returns `{enabled, hasKey, baseUrl, lastSync, lastError, errorsLast24h}`.

**No webhooks in Routemate v0.** Pull-only. Phase 2+ uses `setInterval` patterns matching `setInterval(purgeOldDriverLocations, ...)` at server.js:726. All gated by `ROUTEMATE_ENABLED`.

**Demo viewer** is automatically blocked from `/api/admin/routemate/sync-now` via the existing global write-lockdown middleware (server.js:~1630).

**Spec reference:** OpenAPI 3.0.1 at `https://cloud.routemate.ai/v3/api-docs` (publicly readable, no auth needed for the spec itself). Doc viewer at `https://cloud.routemate.ai/open-api.html` is JS-rendered Redocly. Path prefix `/api/v0/`.
