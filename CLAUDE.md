# CLAUDE.md

## Commands

```bash
# Backend (Express server)
npm start            # Run server (node server.js) on port 3000
npm run dev          # Run with nodemon for auto-restart on file changes

# Frontend (Vue 3 + Vite SPA)
npm run dev:client   # Start Vite dev server on port 5173 (proxies to Express:3000)
npm run build:client # Production build to client/dist/

# Docs (Puppeteer-driven static doc/screenshot generation from scripts/docs/)
npm run docs:build       # node scripts/docs/generate-docs.js
npm run docs:screenshots # node scripts/docs/capture-screenshots.js
```

Development requires two terminals: `npm run dev` + `npm run dev:client`. Open http://localhost:5173 during development.

For production: `npm run build:client` then `npm start` — Express serves the built SPA from `client/dist/`.

`postinstall` auto-runs `cd client && npm install`, so `npm install` at root installs both backend and frontend deps.

**Deploy:** production runs on a VPS at `76.13.22.110` under `/var/www/logistics-app`, managed by pm2 (process name `logistics-app`). Standard deploy flow after merging to `main`:
```bash
ssh root@76.13.22.110 "cd /var/www/logistics-app && git pull --ff-only origin main && npm install --silent --no-audit --no-fund && npm run build:client --silent && pm2 restart logistics-app --silent"
```
A staging process (`logisx-staging`) also runs on the same VPS.

**Tests & linting:** No Jest/Mocha/Vitest/ESLint configured. Integration harness at `test-suite.js` — 25 HTTP tests against a running server (`npm start`, then `node test-suite.js`). Covers auth, role gating, debug-endpoint auth, webhook secret, chat file validation, canceled-load exclusion. Exits 1 on any failure. Seed the DB via `scripts/truncate-and-seed.js` for deterministic state. When editing `server.js`, run `node --check server.js` before committing (~15k lines; a syntax error breaks the whole app).

## Environment Setup

Required files at project root:
- `service-account-key.json` — Google service account credentials (not in git)
- `.env` — environment variables

```
SPREADSHEET_ID=<optional — Google Sheet ID for the main Dispatch Management sheet; defaults to the production sheet when unset>
ARCHIVE_SPREADSHEET_ID=<optional — Google Sheet ID for the read-only archive; defaults to the production archive when unset>
GOOGLE_DRIVE_FOLDER_ID=<Drive folder ID for POD uploads — optional, uploads skip Drive if empty>
GOOGLE_MAPS_API_KEY=<Google Maps API key — required for maps, routing, geocoding, and places>
GMAIL_USER=<Gmail address for sending onboarding/outreach emails>
GMAIL_APP_PASSWORD=<Gmail app password for nodemailer>
GEMINI_API_KEY=<optional — enables receipt OCR auto-fill via Gemini 2.5 Flash vision; form falls back to manual entry when unset>
GEMINI_OCR_MODEL=<optional — override the default gemini-2.5-flash model>
SCANKIT_BASE_URL=<optional — ScanKit.io API base; defaults to https://api.scankit.io>
SCANKIT_API_KEY=<optional — ScanKit.io key (sk_...) for document scanning; scanner returns 503 + raw-photo fallback when unset>
SCANKIT_ENABLED=<optional — set "true" to enable; defaults off so the feature ships dormant>
PORT=3000  # optional, defaults to 3000
```

Default values in `server.js` (override via env):
- Spreadsheet ID falls back to `"1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"` (production Dispatch Management — n8n writes here). Override by setting `SPREADSHEET_ID` in `.env`. Staging uses this to point at its own copy.
- Archive Spreadsheet ID falls back to `"1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI"` (read-only archive). Override via `ARCHIVE_SPREADSHEET_ID`.
- Session secret: Set via `SESSION_SECRET` env var (required for production; falls back to default for dev)

Helper scripts in `scripts/`:
- `reset-super-admin-password.js` — reset the Super Admin password against the local SQLite DB.
- `truncate-and-seed.js` — wipe and reseed the local DB for clean-slate testing.
- `seed-staging.js` — seed a staging DB.
- `create-demo-user.js` — create a demo user for testing.
- `geocode-loads.js` — backfill geocodes for rows in "Job Tracking".
- `generate-timeline-docx.py` / `generate-timeline-apr13-apr17.py` — one-off Python scripts rendering session-timeline `.docx` reports from HTML/markdown (needs `python-docx`).

Shared server-side modules live in `lib/` (required from `server.js`):
- `ifta-states.js` — US state bounding-box lookup used by the IFTA mileage classifier.
- `pdf-browser.js` — Puppeteer HTML→PDF renderer for onboarding/investor docs (why `puppeteer` is a top-level dep alongside `pdfkit`/`pdf-lib`).
- `policy-field-maps.js`, `policy-renderer.js` — field mapping + template rendering for onboarding legal documents.
- `routemate-client.js` — Routemate ELD/telematics API adapter (single point of contact).
- `scankit-client.js` — ScanKit.io document-scanning API adapter (single point of contact; `POST /scan/crop`). See the AI/vision services note below.

## Architecture

### Backend (`server.js`)
Single-file Node.js/Express server (~15,350 lines, ~168 REST endpoints). Google Sheets is the primary database (Sheets API v4); SQLite for local data; Drive API for uploads; Socket.IO for real-time. Body limit raised to 50mb for large payloads with embedded base64 photos/signatures.

**Static file serving**: Express serves `client/dist/` if it exists (production build), else `public/` (legacy vanilla HTML/JS). SPA catch-all `app.get("*")` serves `index.html` for client-side routing.

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
- **Rename-recreate** for CHECK constraint changes: a test insert in try-catch; on failure, rename the table, create a new one with the updated constraint, migrate data, drop the old, and clear all sessions to force re-login.

**Notable libraries**:
- **pdfkit**: PDFs for applications, invoices, onboarding docs; converts base64 camera photos to PDF for Drive uploads (`imageToPdf()`).
- **pdf-lib**: alongside pdfkit for document manipulation (e.g., embedding signatures into onboarding PDFs).
- **tesseract.js**: OCR fallback on POD image uploads only (`extractReceiptText()` at `POST /api/documents/upload`). Once hooked into expense receipts but unwired for low accuracy — that path now uses Gemini (see below). Errors are silently swallowed — OCR failure never blocks the upload.
- **nodemailer**: emails for driver onboarding acceptance and investor outreach. Needs `GMAIL_USER` + `GMAIL_APP_PASSWORD`.
- **compression**: Gzip response compression middleware.
- **archiver**: Streams zip downloads directly to the response — currently the per-truck expense-receipts bundle (lazy `require`d inside the handler; error handler installed before `pipe()`).
- **express-rate-limit**: Per-endpoint limiters; see the rate-limiting section below.

**AI / vision services**:
- **Gemini 2.5 Flash vision** — expense receipt OCR (`POST /api/expenses/ocr`). Called via `fetch` (no SDK) with `responseSchema` enforcing the JSON shape. Requires `GEMINI_API_KEY`; falls back to 503 + silent manual-entry in the driver form when unset. Key is shared across Alchemy projects (rotate in one place). Retry (2 retries, exp backoff, 15 s `AbortController` timeout) mirrors the Google Routes integration.
- **ScanKit.io document scanning** — server-side crop / deskew / lighting-correction (and optional searchable-PDF with OCR layer) via `POST /api/documents/scan`, backed by the `lib/scankit-client.js` adapter (single point of contact; `Authorization: Bearer`, multipart upload, retry/timeout mirror the Routemate/Gemini pattern). **Replaced** the old client-side jscanify + OpenCV-WASM (~9 MB) scanner in `DocumentUpload.vue`. Used by driver POD/BOL scanning, the admin dashboard upload (`ActiveLoadsTab` reuses the same component), and receipt enhancement before Gemini OCR (`ExpenseForm`, `ExpensesTab`). Requires `SCANKIT_API_KEY` + `SCANKIT_ENABLED=true`; returns 503 (client falls back to attaching the raw photo) when unset. Credit-billed (`scanKitLimiter` caps spend) — **rotate the key if it is ever exposed**.

REST endpoints (grouped by domain):

**Sheets CRUD** (Google Sheets as database):
- `GET /api/tabs` — list all sheet tab names
- `GET /api/data?sheet=&page=&limit=` — read rows (paginated, max 200/page)
- `POST /api/data?sheet=` — append row (`{ values: [...] }`)
- `PUT /api/data/:rowIndex?sheet=` — update row by 1-based index
- `DELETE /api/data/:rowIndex?sheet=` — delete row (shifts rows up, Super Admin only)

**Dashboard & dispatch**:
- `GET /api/dashboard` — aggregated KPIs, job board, active loads, fleet data. Each job row is enriched with `_pickupLocation` / `_dropLocation` (clean "City, ST ZIP" from `load_coordinates.pickup_address` / `dropoff_address` or parsed from the sheet) plus `_pickupStreet` / `_dropStreet` (line 1, the street; "" when none); JobBoardTab + ActiveLoadsTab + CompletedLoadsTab render these as a two-line address (street over "City, ST ZIP") in place of the raw broker-reference columns. Split by `splitAddressLines()` / `resolveAddressParts()` in server.js (mirrored client-side in `client/src/lib/address.js` for surfaces with only the raw string, e.g. driver LoadDetail). The public tracker shows "City, State" + a separate ZIP line — never the street.
- `POST /api/dispatch` — assign load to driver (writes to sheet + notifies via socket)
- `POST /api/dispatch/reassign` — reassign load to different driver
- `POST /api/dispatch/cancel` — **Super Admin only**. Sets status `Cancelled` (not `Unassigned`) so the load drops from every KPI via `excludeDroppedLoads()`. Per 2026-04-19 client decision, dispatchers lost this; use the Driver reassign dropdown for swaps.
- `DELETE /api/loads/:loadId` — **Super Admin only**. Soft-delete via the `deleted_loads` table; row stays in the Sheet for audit but is filtered from all admin lists + KPIs. Reversible via `DELETE FROM deleted_loads WHERE load_id = ?`.
- `POST /api/driver/respond` — driver accepts/declines a load assignment
- `GET /api/load/:loadId` — single load details
- `PUT /api/load/:loadId` — update load fields

**Driver**:
- `GET /api/driver/:driverName` — driver-specific data (financial columns auto-hidden for Driver role). Also returns `truckDocuments` — admin-flagged driver-visible legal docs on the driver's assigned truck. No file URLs; row IDs only.
- `PUT /api/driver/status` — update load status (logs to "Status Logs" sheet)
- `GET /api/driver/truck-documents/:id/view` — view-only inline stream of a driver-visible truck doc. Re-checks the active `truck_assignments` row on every request (reassignment revokes access immediately). Rate-limited. Sets `Content-Disposition: inline` + `X-Content-Type-Options: nosniff`.
- `GET /api/driver/shared-documents/:id/download` — admin-shared docs uploaded via the drivers directory modal.

**Fleet management**:
- `/api/trucks` — CRUD for trucks (GET, POST, PUT, DELETE)
- `/api/truck-assignments` — GET truck-driver assignments
- `/api/trailers` — CRUD for trailers
- `/api/drivers-directory` — CRUD for drivers directory (Carrier Database in SQLite)

**Applications & onboarding**:
- `POST /api/public/apply` — public driver application form (no auth)
- `GET /api/applications`, `PUT /api/applications/:id/status` — manage driver applications
- `GET /api/applications/:id/pdf` — download application as PDF
- `POST /api/public/investor-apply` — public investor application (no auth)
- `/api/investor-applications` — manage investor applications
- `/api/public/investor-onboarding/:id/*` — public investor onboarding flow (document signing, banking)
- `/api/onboarding/*` — driver onboarding (document signing, drug test upload)

**Investors**:
- `/api/investors` — CRUD for investor records
- `/api/investor` — investor dashboard (financial data, reports)
- `/api/investor/config` — investor view configuration
- `/api/investor/documents`, `/api/investor/tax-csv`, `/api/investor/report` — investor documents and reports
- `/api/investor-outreach/send`, `/api/investor-outreach/log` — email outreach
- `/api/legal-documents` — manage legal documents for investor portal

**Super Admin "View as investor" preview**: every `/api/investor/*` GET (plus `/api/trucks`) honors `?as_user_id=N` **only when the session user is a Super Admin and N is a real Investor's `users.id`**. The `resolvePreviewUser(req)` helper (server.js, just below `getInvestorDriverSet`) validates and silently falls back to the session user otherwise — no 403, no info leak. Endpoints then shadow `user.id` / `user.username` / `isSuperAdmin` with the target's values so the handler runs the investor-scoped branch unchanged. Each preview is audit-logged (`audit_trail.action = 'investor_preview_view'`). Two conventions coexist: `?as_user_id=` keys on `users.id` (this feature); `?investor_id=` keys on `investors.id` (only `/api/investor/onboarding-documents` and `/api/legal-documents`). Frontend entry `/investor-portals` (Super Admin sidebar) lists investors as cards; clicking opens `/investor-portals/:userId` — a thin wrapper around `InvestorView.vue` that calls `investorStore.setPreview(userId)` and stamps a yellow read-only banner. Read-only UI hides the chat composer, "Add Truck" button, and legal-doc upload/delete. `setPreview` resets `data` + `isLoading` to prevent stale-data flash between previews (Pinia singleton gotcha).

**Messaging**:
- `POST /api/messages`, `GET /api/messages`, `GET /api/messages/:driverName` — driver messaging
- `PUT /api/messages/read`, `PUT /api/notifications/read` — mark as read
- `/api/dispatch-notifications` — dispatch-specific notifications
- `/api/investor/messages` — investor chat

**Expenses & finance**:
- `POST /api/expenses` — log expense (fuel w/ gallons/odometer, maintenance, optional base64 photo). Receipts re-saved under `/uploads/expense-receipts/`, URL stored in `expenses.photo_data`.
- `POST /api/expenses/ocr` — receipt JPEG/PNG → Gemini 2.5 Flash vision, returns `{amount, date, vendor, gallons, odometer, suggestedType, confidence}`. Driver ExpenseForm prefills fields before the driver confirms. Role: Driver / Super Admin / Dispatcher. Rate-limited.
- `GET /api/expenses/all`, `PUT /api/expenses/:id/status` — manage all expenses
- `GET /api/expenses/fuel-analytics` — fuel spend, cost/gallon, monthly + per-driver breakdown
- `/api/maintenance-fund` — maintenance fund tracking
- `/api/compliance/fees`, `/api/compliance/ifta` — compliance fee tracking, IFTA mileage

**Invoices**:
- `POST /api/invoices/generate` — weekly (Sat–Fri) invoice PDF from completed loads. Fixed-driver pay uses the completed-loads ∩ ELD-travel active-day basis (see "Driver active days"), clipped to the billing week, at the truck's `driver_pay_daily`; soft-deleted loads are filtered out. Owner-op/percentage drivers bill `(week revenue − fuel/maintenance) × pct` instead.
- `GET /api/invoices`, `GET /api/invoices/:id/pdf` — list and download invoices
- `PUT /api/invoices/:id/submit` — submit an invoice (driver/dispatcher)
- `PUT /api/invoices/:id/approve` — approve submitted invoice (Super Admin only)

**Financials** (Super Admin only):
- `GET /api/financials` — aggregated P&L: revenue, expenses, driver pay, profit. Revenue counts in the month the load was **assigned**, not delivered, to match the dashboard. Only completed loads count toward `totalRevenue`. Loads dropped via `excludeDroppedLoads()` (cancelled + soft-deleted) are filtered upstream so these numbers match `/api/dashboard` and `/api/investor` exactly. Driver pay (per-driver and per-truck) uses the active-day basis × per-truck `driver_pay_daily` (see "Driver active days").

**Public tracker** (no auth):
- `GET /api/public/track/:loadId` — customer-facing tracker. Returns stage progression, last driver GPS ping (redacted if >2 h stale), ETA + on-time/delayed flag, origin/destination city, truck unit number. Strict whitelist — driver name, phone, broker, rate, notes never flow through. Load-ID-only verification is the accepted client-chosen tradeoff; mitigated by the rate limiter, whitelist, and `X-Robots-Tag: noindex, nofollow`. Input sanitized via `/^[A-Za-z0-9\-_.#]{1,40}$/`. Used by the `/track/:loadId` SPA view and ActiveLoadsTab's "Copy tracking link" button.

**Documents & uploads**:
- `POST /api/documents/upload` — upload POD/documents to Google Drive
- `GET /api/documents/:loadId` — list documents for a load
- `POST /api/chat/attachment` — upload chat attachment
- `POST /api/legal-documents/upload` — upload a legal doc scoped to a truck, investor, or driver. `visibleToDriver: boolean` only honored when `truck_id > 0` (per-truck docs are the only kind the Driver Kit shows).
- `PATCH /api/legal-documents/:id/visibility` — Super Admin toggles `visible_to_driver` on a truck doc (flip on/off without re-uploading).
- `GET /api/legal-documents?truck_id=`/`?driver_id=`/`?investor_id=` — scoped fetch (Super Admin or doc-owning Investor).

**Location & maps**:
- `POST /api/location` — driver reports GPS position (geofence auto-triggers status updates)
- `GET /api/locations/latest` — latest position per active driver with ETA enrichment
- `GET /api/locations/trail` — historical GPS trail for a driver
- `GET /api/route` — route directions via Google Maps
- `/api/geocode`, `/api/geocode/search`, `/api/geocode/bulk`, `/api/geocode/load/:loadId` — geocoding with SQLite cache
- `GET /api/config/maps-key` — expose Google Maps API key to frontend
- `GET /api/weather` — weather data for coordinates

**Admin tools**:
- `GET /api/admin/audit-trail` — view audit log
- `PUT /api/admin/fix-driver-name` — rename driver across all sheets
- `GET /api/admin/scan-duplicates` — find duplicate rows in sheets
- `GET /api/admin/scan-driver-mismatches` — find driver name inconsistencies
- `GET /api/admin/scan-orphans` — find orphaned data
- `GET /api/admin/scan-stale-locations` — find stale GPS locations
- `POST /api/admin/fix-stale-locations` — clean up stale locations
- `POST /api/admin/remove-rows` — batch remove rows from sheets
- `GET /api/archive`, `GET /api/archive/tabs` — view archived sheet data

**Database admin** (Super Admin only):
- `GET /api/db/download` — download SQLite database file
- `GET /api/db/tables` — list all tables
- `GET /api/db/query/:table` — query a table

**Auth & users**:
- `GET /api/auth/setup-check`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`
- `GET /api/users`, `POST /api/users`, `PUT /api/users/:id`, `DELETE /api/users/:id`
- `PUT /api/users/:id/rating` — rate a user
- `/api/load-ratings/*` — per-load driver ratings
- `GET /api/users/investors` — list users with Investor role

**Debug** (no auth — dev only). `GET /api/debug/` paths: `driver-view/:driverName`, `driver-empty/:driverName`, `sample-row`, `driver-loads/:driverName`, `user/:username`.

**Socket.IO events** (server emits):
- `load-assigned` — to specific driver when dispatched
- `load-cancelled` — to driver when dispatch cancelled
- `load-deleted` — to dispatch room when a load is soft-deleted
- `load-accepted` / `load-declined` — to dispatch room on driver response
- `status-updated` — to dispatch room on load status change
- `dispatch-notification` — to dispatch room for all dispatch events. `metadata` JSON includes `loadId` for every emitter (drives the NotificationsView click-routing below).
- `new-message` — to all on new chat message
- `pod-uploaded` — to dispatch room on document upload
- `location-update` — to dispatch room on driver GPS report
- `geofence-trigger` — to driver and dispatch room when geofence auto-triggers status
- `reload` — to all 500ms after server start (live reload during dev)

Clients emit `register` with their name to join a socket room.

**Status progression & guards**: `PUT /api/driver/status` enforces one active job — a driver can't transition to "At Shipper" with another load already active (`at shipper|loading|in transit|at receiver`) → 409 Conflict. Every change is logged to the "Status Logs" sheet (`LOG-{timestamp}`, old→new status, reason). Uses `batchUpdate` to atomically set both the status and date columns.

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

The 60s in-memory Job Tracking cache (`getJobTrackingCached()`) is the other core throttle — it absorbs bursty dashboard traffic so the Sheets 300 req/min quota isn't a real constraint day-to-day.

### Frontend (`client/`)
Vue 3 + Vite SPA with Vue Router, Pinia stores, Tailwind CSS v4, shadcn-vue components (via radix-vue/reka-ui), Vant mobile UI, Leaflet + Google Maps for maps, and Socket.IO client for real-time updates.

Key directories:
- `stores/` — auth, dashboard, sheets, driver, messages, investor, users, adminTools, dispatchNotifications, driversDb, investors, trucks, trailers, invoices, financials
- `composables/` — useApi, useSocket, useToast, usePagination, useGeocode, useGoogleMaps
- `components/ui/` — shadcn-vue primitives (badge, button, card, dialog, input, select, skeleton, table, tabs)
- `components/` — feature-organized: layout, shared, dashboard, data-manager, driver, drivers-db, trucks, investors, investor, invest, apply, users
- `views/` — 28 view components (includes the public `TrackLoadView.vue`)
- `wizard/` — JSON-driven framework for the multi-step Invest flow. `engine/WizardEngine.js` interprets a step schema from `data/`, `expressionEvaluator.js` evaluates `show-if`/`require-if` without `eval()`, `spotlight.js` drives the highlight overlay. Extend this engine for new multi-step forms instead of a bespoke stepper.

**Vite proxy** (`client/vite.config.js`): `/api` and `/socket.io` (with `ws: true`) both proxy to `http://localhost:3000`.

**Composable singletons**: `useApi()`, `useSocket()`, `useToast()` are module-level singletons (not per-component). Each Pinia store does `const api = useApi()` at module scope; `useSocket` keeps one global socket connection.

**Phone GPS retired**: As of 2026-05-13, Routemate ELD is the sole location source. `useGeolocation` was deleted; the driver app no longer requests location permission or reports pings, and the "Location Access Required" gate was removed from `DriverView`. `POST /api/location` is a 410 Gone stub so cached old clients get a clear error, not a 404. See `routemateSyncTelemetry()` for the live-position pipeline.

**useGoogleMaps**: Loads the Google Maps JS API via `@googlemaps/js-api-loader`, fetches the API key from `GET /api/config/maps-key`.

**Optimistic updates**: Both `driver` and `messages` stores append messages locally before the API request completes.

**Mobile / admin drawer**: A shared `appShell` Pinia store exposes `isMobile` (resize-driven) and `sidebarOpen`. On mobile, `AppSidebar.vue` is a slide-in drawer with backdrop (`v-if="isMobile && appShell.sidebarOpen"`); on desktop, the persistent collapsible sidebar. New admin views should toggle it via `appShell.openSidebar()` rather than rolling their own mobile nav. Admin pages (Dashboard, Notifications, Messages, Expenses) are responsive top-down — commits `dbe9d4e`…`8e1a62d` collapse multi-pane layouts into single-pane stacks below the `md` breakpoint and swap detail tables for card lists. Vant is reserved for driver/public surfaces; admin uses shadcn-vue + Tailwind.

**Routing** (34 routes with role-based guards):

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
| `/admin/fleet-health` | Super Admin, Dispatcher | Routemate ELD fleet health — fault codes, DVIR, telemetry status |
| `/archive` | Super Admin | Archived data viewer |

Auth guard calls `checkSession()` on first navigation only (blocks until resolved); later navigations use cached `isAuthenticated`. Unauthorized users redirect to `auth.roleHome` (Driver → `/driver`, Dispatcher → `/dashboard`, Investor → `/investor`).

Routes flagged `meta: { alwaysPublic: true }` (only `/track`, `/track/:loadId`) bypass the "authenticated → roleHome" redirect that applies to `/login`/`/apply` — so a logged-in dispatcher can preview the tracker.

### Legacy Frontend (`public/`)
Original vanilla HTML/CSS/JS pages, kept as the `public/` fallback (see Static file serving above).

## Key Conventions

- **Row indexing**: Row 1 = headers, row 2+ = data. API uses 1-based row indices. Each data object includes `_rowIndex`. DELETE internally converts to 0-indexed for Sheets `batchUpdate` `deleteDimension` (`startIndex: rowIndex - 1`).
- **Sheet selection**: All data endpoints accept `?sheet=` query param; defaults to "Job Tracking".
- **Value format**: POST/PUT bodies use `{ values: ["col1", "col2", ...] }` with `valueInputOption: "USER_ENTERED"` (supports formulas).
- **Column detection via regex**: Both backend and frontend match headers dynamically with regex patterns — `/driver/i` for driver columns, `/rate|amount|revenue|pay|charge|price|cost/i` for financial columns (hidden from Driver role), `/status/i` for status, `/load.?id|job.?id/i` for load IDs, `/origin.*lat|pickup.*lat/i` and `/dest.*lat|delivery.*lat/i` for coordinates. This makes the system flexible to different sheet column names.
- **Driver fields**: Any column matching `/driver/i` renders as a `<select>` populated from the first driver-like column in "Carrier Database".
- **Role-based routing**: Super Admin sees all, Dispatcher sees dashboard+data (no broker/financial info), Driver sees driver app (no sidebar), Investor sees financial view + truck fleet.
- **Geofence logic**: `tryGeofenceAdvance()` (from `routemateSyncTelemetry()`) uses `geolib.isPointWithinRadius()` with a **500m threshold** on each ELD ping. Auto-advances only when current status matches the expected predecessor (Dispatched/Assigned/Heading to Shipper → At Shipper, In Transit → At Receiver); never auto-writes a completion status. Errors caught silently; emits `geofence-trigger` + `dispatch-notification`. Phone-GPS path (`POST /api/location`) is retired (see above).
- **ETA calculation**: Uses `geolib.getDistance()` to destination. Default speed: 24.587 m/s (~55 mph) when GPS speed is unreliable. Compares ETA vs scheduled delivery to flag "on-time" / "delayed".
- **IFTA state matching**: Hardcoded bounding boxes for ~24 US states to classify driver GPS pings by state.
- **Sheet ID caching**: Google Sheet tab GIDs are cached in a `Map` in memory to avoid repeated API lookups. Lazy-initialized via `getSheetId()`.
- **Geocode caching**: Geocode results are cached in the `geocode_cache` SQLite table to avoid redundant Google Maps API calls.
- **No transactions**: Multi-step operations (update sheet + append log + emit socket) are not atomic. Network failures mid-operation can leave data inconsistent.
- **Onboarding documents**: driver and investor onboarding use seeded lists (`ONBOARDING_DOCS`, `INVESTOR_ONBOARDING_DOCS`) with PDF generation + e-signature capture.
- **Audit trail**: Admin actions (user creation, driver rename, etc.) are logged to the `audit_trail` table.
- **Load exclusion is centralized**: every load-revenue aggregator (`/api/dashboard`, `/api/financials`, `/api/investor`) runs sheet data through `excludeDroppedLoads(rows, headers)` before any math. It drops (a) rows whose status matches `CANCELED_STATUS_RE = /^(cancel|canceled|cancelled)$/i` and (b) rows whose `load_id` is in the `deleted_loads` table. Keep this the single place deciding "is this load live?" so dashboard/financials/investor stay consistent. `POST /api/invoices/generate` reads the sheet directly (not via this helper), so it applies its own `getDeletedLoadIds()` filter to avoid billing soft-deleted loads — keep in sync.
- **Driver "active days" = completed loads ∩ ELD travel** (driver-pay basis, shared by `/api/investor`, `/api/financials`, `POST /api/invoices/generate`): an *active day* counts only when the assigned truck **traveled** that day **and** the day is inside a **completed** load's pickup→delivery window. "Traveled" = a clean `routemate_telemetry` ping (`dropped_reason=''`) with `speed > 2.235` m/s (~5 mph). Computed by the module-scope helper `getEldTravelDaysByVehicle(vehicleIds, minMs, maxMs)` → `{ vid: { travel: Set<"YYYY-MM-DD">, coverage: Set } }`; each ping is bucketed into the **truck's local day** (zone derived per-ping from longitude via `usTzForLongitude` → continental-US IANA zone, DST-aware via `Intl`), so late trips land on the worked day, not the server's UTC day. Window days are bare wall-clock dates from the sheet (`fmtDate`/`expandDateRange`), matching the truck-local travel days. (US-centric; falls back to Central when longitude is missing.) Load truck→vehicle map: `trucks.routemate_vehicle_id` (matched on `LOWER(unit_number)`). **Coverage-aware fallback**: a window with *no* ELD pings (truck unlinked or load predates the feed) falls back to the full scheduled window so historical/un-instrumented pay is never zeroed; a covered-but-*parked* window yields 0. Daily rate = the truck's `trucks.driver_pay_daily` (falls back to `$250`; invoices used to hardcode `$250`). Only `completedStatuses` (`/^(delivered|completed|pod received)$/i`) count — the old broad `activeWorkStatuses` is gone, so deadhead, in-progress, and parked days are excluded. `parseSheetDate` (investor/financials) accepts ISO `YYYY-MM-DD` and US `M/D/Y`. Each driver-month is tagged `source: eld | mixed | estimated`; `EarningsSection.vue` renders an "ELD-verified / partly / estimated" badge. **Keep all three endpoints in lockstep** so investor portal, Financials P&L, and weekly invoice reconcile. (Invoices clip the window to the Sat–Fri billing week.)
- **Two soft-delete patterns coexist**, by design — pick the right one for new tables:
  - **Separate `deleted_loads` table** (load_id keyed): the canonical row lives in Sheets, not SQLite. Query: `LEFT JOIN deleted_loads ... WHERE deleted_loads.load_id IS NULL`. Recovery: `DELETE FROM deleted_loads WHERE load_id = ?`.
  - **`deleted_at` timestamp column** on the source table: used by `job_applications` (listings filter `WHERE deleted_at IS NULL`; `?include_deleted=true` for admin recovery). Cheaper (no join), but only works when the table lives in SQLite.
- **Notification click routing**: every `dispatch-notification` emitter stores `loadId` in the row's `metadata` JSON; admin `NotificationsView` parses it → `router.push('/dashboard?load=<loadId>')`. `DashboardView` reads `route.query.load`, switches to Active Loads, passes `focusLoadId` into `ActiveLoadsTab`, which auto-opens that load's modal then emits `focus-consumed` to clear the query.
- **SQLite timestamps on the wire**: `CURRENT_TIMESTAMP` is UTC but serializes zone-less (`"2026-04-20 14:30:00"`), which JS parses as local time. When exposing DB timestamps, wrap with `strftime('%Y-%m-%dT%H:%M:%SZ', created_at)` so the client can `new Date(ts)` correctly. `/api/dispatch-notifications` does this; follow it for new endpoints surfacing `created_at`.

## Google APIs

- **Sheets API v4**: Primary database. Rate limit 300 req/min. `valueInputOption: "USER_ENTERED"`.
- **Drive API v3**: POD/document uploads to a shared folder (`GOOGLE_DRIVE_FOLDER_ID`). Photos → PDF via pdfkit before upload.
- **Maps APIs**: Directions, Geocoding, Places — route calc, address lookup, geocode caching. Key exposed to frontend via `GET /api/config/maps-key`.
- Scopes: `spreadsheets`, `drive.file`
- Service account: `sheets-bot@logistics-app-491014.iam.gserviceaccount.com`
- Spreadsheet and Drive folder must be shared with this email as Editor.
- API clients (`sheetsClient`, `driveClient`) are lazy-initialized singletons via `getSheets()` / `getDrive()`.

## Routemate ELD / telematics integration

Replaces phone-based driver GPS. Routemate is FMCSA-certified ELD hardware in trucks; LogisX pulls from their cloud REST API.

**Adapter:** `lib/routemate-client.js` — single point of contact. Auth via `X-Api-Key`. Retry/backoff + 15s `AbortController` timeout mirror the Gemini OCR pattern. Returns normalized objects so a future API change ripples through one file. Every server-side caller goes through it; no other module talks to Routemate directly.

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
| `routemate_telemetry` | Live GPS feed, append-only. Fields: `routemate_vehicle_id`, `latitude`, `longitude`, `speed`, `bearing`, `odometer`, `engine_hours`, `fuel_pct`, `geocoded_location`, `location_date_ms` (epoch ms from Routemate), `fetched_at`. Also the driver-pay "active days" source — see that convention. |
| `routemate_fault_codes` | One row per active code per vehicle, UNIQUE on `(routemate_vehicle_id, code)`. Fields: `code`, `status`, `first_seen`, `last_seen`, `ack_by_user_id`, `ack_at`. |
| `routemate_dvir` | DVIR inspection reports per vehicle, UNIQUE on `dvir_id`. |
| `routemate_fuel_daily` | Telemetry-derived MPG rollup, UNIQUE on `(routemate_vehicle_id, date)`. Phase 4. |
| `routemate_hos_daily` | Driver duty-time rollup, UNIQUE on `(driver_id, date)`. Phase 3. |

**`trucks` table** gains one additive column via the existing try/catch ALTER pattern: `routemate_vehicle_id TEXT DEFAULT ''`. Set by admins via the Trucks UI (Phase 2) to link a LogisX truck to a Routemate vehicle.

**`driver_locations`** retains historical rows but is no longer written or read by any endpoint as of 2026-05-13. `GET /api/locations/latest` and `/api/locations/trail` now source exclusively from `routemate_telemetry`; responses tag `source: 'routemate'` with an ELD fix, else `'none'`. The 90-day purge job still ages the legacy data out.

**Phase 1 endpoints** (only ones live as of foundation):
- `POST /api/admin/routemate/sync-now` — Super Admin only. 503 when `ROUTEMATE_ENABLED=false` or key unset; else `getCompany()` smoke test, then paginates `listVehicles()` and upserts into `routemate_vehicles`. Logs `audit_trail` action `routemate_sync`.
- `GET /api/routemate/health` — Super Admin only. Returns `{enabled, hasKey, baseUrl, lastSync, lastError, errorsLast24h}`.

**No webhooks in Routemate v0** — pull-only. Phase 2+ uses `setInterval` patterns like `setInterval(purgeOldDriverLocations, ...)` (server.js:726). All gated by `ROUTEMATE_ENABLED`.

**Demo viewer** is blocked from `/api/admin/routemate/sync-now` by the global write-lockdown middleware (server.js:~1630).

**Spec reference:** OpenAPI 3.0.1 at `https://cloud.routemate.ai/v3/api-docs` (public, no auth). Doc viewer `https://cloud.routemate.ai/open-api.html` is JS-rendered Redocly. Path prefix `/api/v0/`.
