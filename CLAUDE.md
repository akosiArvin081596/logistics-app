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

No test runner or linter is configured.

## Environment Setup

Required files at project root:
- `service-account-key.json` — Google service account credentials (not in git)
- `.env` — environment variables

```
GOOGLE_DRIVE_FOLDER_ID=<Drive folder ID for POD uploads — optional, uploads skip Drive if empty>
GOOGLE_MAPS_API_KEY=<Google Maps API key — required for maps, routing, geocoding, and places>
GMAIL_USER=<Gmail address for sending onboarding/outreach emails>
GMAIL_APP_PASSWORD=<Gmail app password for nodemailer>
ANTHROPIC_API_KEY=<optional — enables receipt OCR auto-fill via Claude Haiku 4.5 vision; form falls back to manual entry when unset>
PORT=3000  # optional, defaults to 3000
```

Hardcoded values in `server.js` (change if forking):
- Spreadsheet ID: `"1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"` — the production Dispatch Management sheet that n8n writes into. A separate archive sheet (`1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI`) is referenced only by the archive viewer.
- Session secret: Set via `SESSION_SECRET` env var (required for production; falls back to default for dev)

Helper scripts in `scripts/`:
- `reset-super-admin-password.js` — reset the Super Admin password against the local SQLite DB.
- `truncate-and-seed.js` — wipe and reseed the local DB for clean-slate testing.
- `seed-staging.js` — seed a staging DB.
- `geocode-loads.js` — backfill geocodes for rows in "Job Tracking".

## Architecture

### Backend (`server.js`)
Single-file Node.js/Express server (~10,500 lines, ~140 REST endpoints) using Google Sheets as the primary database via Sheets API v4, with SQLite for local data. Google Drive API for document uploads. Socket.IO for real-time events. Body limit raised to 50mb to accept large application payloads with embedded base64 photos/signatures.

**Static file serving**: Express checks if `client/dist/` exists (production build) → falls back to `public/` (legacy vanilla HTML/JS). SPA catch-all `app.get("*")` serves `index.html` for client-side routing.

**SQLite** (`app.db`, WAL mode) — ~35 tables organized by domain:

| Domain | Tables |
|--------|--------|
| Auth & users | `users` |
| Messaging | `messages`, `notifications`, `dispatch_notifications` |
| Dispatch | `load_responses`, `load_ratings`, `load_coordinates` |
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
- **tesseract.js**: OCR on receipt photos during expense submission (`extractReceiptText()`). Errors are silently swallowed — OCR failure never blocks expense creation.
- **nodemailer**: Sends emails for driver onboarding acceptance and investor outreach. Requires `GMAIL_USER` and `GMAIL_APP_PASSWORD` env vars.
- **compression**: Gzip response compression middleware.

REST endpoints (grouped by domain):

**Sheets CRUD** (Google Sheets as database):
- `GET /api/tabs` — list all sheet tab names
- `GET /api/data?sheet=&page=&limit=` — read rows (paginated, max 200/page)
- `POST /api/data?sheet=` — append row (`{ values: [...] }`)
- `PUT /api/data/:rowIndex?sheet=` — update row by 1-based index
- `DELETE /api/data/:rowIndex?sheet=` — delete row (shifts rows up, Super Admin only)

**Dashboard & dispatch**:
- `GET /api/dashboard` — aggregated KPIs, job board, active loads, fleet data
- `POST /api/dispatch` — assign load to driver (writes to sheet + notifies via socket)
- `POST /api/dispatch/reassign` — reassign load to different driver
- `POST /api/dispatch/cancel` — cancel a dispatched load
- `POST /api/driver/respond` — driver accepts/declines a load assignment
- `GET /api/load/:loadId` — single load details
- `PUT /api/load/:loadId` — update load fields

**Driver**:
- `GET /api/driver/:driverName` — driver-specific data (financial columns auto-hidden for Driver role)
- `PUT /api/driver/status` — update load status (logs to "Status Logs" sheet)

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

**Messaging**:
- `POST /api/messages`, `GET /api/messages`, `GET /api/messages/:driverName` — driver messaging
- `PUT /api/messages/read`, `PUT /api/notifications/read` — mark as read
- `/api/dispatch-notifications` — dispatch-specific notifications
- `/api/investor/messages` — investor chat

**Expenses & finance**:
- `POST /api/expenses` — log expense (fuel with gallons/odometer, maintenance, with optional base64 photo)
- `GET /api/expenses/all`, `PUT /api/expenses/:id/status` — manage all expenses
- `GET /api/expenses/fuel-analytics` — fuel spend, cost/gallon, monthly + per-driver breakdown
- `/api/maintenance-fund` — maintenance fund tracking
- `/api/compliance/fees`, `/api/compliance/ifta` — compliance fee tracking, IFTA mileage

**Invoices**:
- `POST /api/invoices/generate` — generate invoice PDF from load data
- `GET /api/invoices`, `GET /api/invoices/:id/pdf` — list and download invoices
- `PUT /api/invoices/:id/submit` — submit an invoice (driver/dispatcher)
- `PUT /api/invoices/:id/approve` — approve submitted invoice (Super Admin only)

**Financials** (Super Admin only):
- `GET /api/financials` — aggregated P&L: revenue, expenses, driver pay, profit. Revenue counts in the month the load was **assigned**, not delivered, to match the dashboard. Only completed loads count toward `totalRevenue`.

**Documents & uploads**:
- `POST /api/documents/upload` — upload POD/documents to Google Drive
- `GET /api/documents/:loadId` — list documents for a load
- `POST /api/chat/attachment` — upload chat attachment

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

**Debug** (no auth required — development only):
- `GET /api/debug/driver-view/:driverName`, `GET /api/debug/driver-empty/:driverName`
- `GET /api/debug/sample-row`, `GET /api/debug/driver-loads/:driverName`
- `GET /api/debug/user/:username`

**Socket.IO events** (server emits):
- `load-assigned` — to specific driver when dispatched
- `load-cancelled` — to driver when dispatch cancelled
- `load-accepted` / `load-declined` — to dispatch room on driver response
- `status-updated` — to dispatch room on load status change
- `dispatch-notification` — to dispatch room for all dispatch-related events
- `new-message` — to all on new chat message
- `pod-uploaded` — to dispatch room on document upload
- `location-update` — to dispatch room on driver GPS report
- `geofence-trigger` — to driver and dispatch room when geofence auto-triggers status
- `reload` — to all 500ms after server start (live reload during dev)

Clients emit `register` with their name to join a socket room.

**Status progression & guards**: Status updates (`PUT /api/driver/status`) enforce a one-active-job constraint — a driver cannot transition to "At Shipper" if they already have another load in an active state (`at shipper|loading|in transit|at receiver`), returning 409 Conflict. Every status change is logged to the "Status Logs" sheet with a `LOG-{timestamp}` entry, old→new status, and reason. The update uses `batchUpdate` to atomically set both the status column and corresponding date column.

Session-based auth with 4 roles: Super Admin, Dispatcher, Driver, Investor. Auth middleware: `requireAuth` (401), `requireRole(...roles)` (403). First-time setup creates the initial Super Admin via `POST /api/auth/setup`.

**Role-based data sanitization**: `PUT /api/data/:rowIndex` preserves broker and phone contact columns for non-Super Admin users (values are read from the sheet and spliced back in before writing). `GET /api/data` strips financial columns for Driver role.

**Error handling**: All endpoints use try-catch with generic 500 JSON responses. Geofence check errors inside `POST /api/location` are caught and logged but never fail the location response. No explicit rate limiting — relies on Google Sheets' 300 req/min limit and pagination max of 200 rows.

### Frontend (`client/`)
Vue 3 + Vite SPA with Vue Router, Pinia stores, Tailwind CSS v4, shadcn-vue components (via radix-vue/reka-ui), Vant mobile UI, Leaflet + Google Maps for maps, and Socket.IO client for real-time updates.

Key directories:
- `stores/` — auth, dashboard, sheets, driver, messages, investor, users, adminTools, dispatchNotifications, driversDb, investors, trucks, trailers, invoices, financials
- `composables/` — useApi, useSocket, useToast, usePagination, useGeolocation, useGeocode, useGoogleMaps
- `components/ui/` — shadcn-vue primitives (badge, button, card, dialog, input, select, skeleton, table, tabs)
- `components/` — feature-organized: layout, shared, dashboard, data-manager, driver, drivers-db, trucks, investors, investor, invest, apply, users
- `views/` — 23 view components

**Vite proxy** (`client/vite.config.js`): `/api` and `/socket.io` (with `ws: true`) both proxy to `http://localhost:3000`.

**Composable singletons**: `useApi()`, `useSocket()`, and `useToast()` are module-level singletons, not per-component instances. Each Pinia store instantiates `const api = useApi()` at module scope. `useSocket` maintains a single global socket connection.

**useGeolocation**: Smart GPS reporting — 30s interval when tab is active, 2m when hidden (via `document.visibilitychange`). Reports to `POST /api/location` with loadId. Silently swallows API errors to avoid disrupting the driver.

**useGoogleMaps**: Loads the Google Maps JS API via `@googlemaps/js-api-loader`, fetches the API key from `GET /api/config/maps-key`.

**Optimistic updates**: Both `driver` and `messages` stores append messages locally before the API request completes.

**Routing** (23 routes with role-based guards):

| Route | Access | Notes |
|-------|--------|-------|
| `/login` | Public | Redirects authenticated users to role home |
| `/apply` | Public | Driver application form (no sidebar) |
| `/invest` | Public | Investor application form (no sidebar) |
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
| `/drivers` | Super Admin | Drivers directory |
| `/trailers` | Super Admin, Dispatcher | |
| `/applications` | Super Admin | Driver applications review |
| `/investor-applications` | Super Admin | Investor applications review |
| `/admin/tools` | Super Admin | Admin data tools |
| `/admin/financials` | Super Admin | Company P&L view |
| `/archive` | Super Admin | Archived data viewer |

Auth guard calls `checkSession()` on first navigation only (blocks until resolved), then subsequent navigations use cached `isAuthenticated` state. Unauthorized users redirect to `auth.roleHome` (Driver → `/driver`, Dispatcher → `/dashboard`, Investor → `/investor`).

### Legacy Frontend (`public/`)
Original vanilla HTML/CSS/JS pages. Kept as fallback — Express serves `client/dist/` if it exists, otherwise `public/`.

## Key Conventions

- **Row indexing**: Row 1 = headers, row 2+ = data. API uses 1-based row indices. Each data object includes `_rowIndex`. DELETE internally converts to 0-indexed for Sheets `batchUpdate` `deleteDimension` (`startIndex: rowIndex - 1`).
- **Sheet selection**: All data endpoints accept `?sheet=` query param; defaults to "Job Tracking".
- **Value format**: POST/PUT bodies use `{ values: ["col1", "col2", ...] }` with `valueInputOption: "USER_ENTERED"` (supports formulas).
- **Column detection via regex**: Both backend and frontend match headers dynamically with regex patterns — `/driver/i` for driver columns, `/rate|amount|revenue|pay|charge|price|cost/i` for financial columns (hidden from Driver role), `/status/i` for status, `/load.?id|job.?id/i` for load IDs, `/origin.*lat|pickup.*lat/i` and `/dest.*lat|delivery.*lat/i` for coordinates. This makes the system flexible to different sheet column names.
- **Driver fields**: Any column matching `/driver/i` renders as a `<select>` populated from the first driver-like column in "Carrier Database".
- **Role-based routing**: Super Admin sees all, Dispatcher sees dashboard+data (no broker/financial info), Driver sees driver app (no sidebar), Investor sees financial view + truck fleet.
- **Geofence logic**: `POST /api/location` uses `geolib.isPointWithinRadius()` with a **500m threshold**. Auto-advances status only when current status matches the expected predecessor (e.g., "Dispatched"/"Assigned" → "At Shipper", "In Transit" → "At Receiver"). Geofence errors are caught silently. Logs to "Status Logs" sheet.
- **ETA calculation**: Uses `geolib.getDistance()` to destination. Default speed: 24.587 m/s (~55 mph) when GPS speed is unreliable. Compares ETA vs scheduled delivery to flag "on-time" / "delayed".
- **IFTA state matching**: Hardcoded bounding boxes for ~24 US states to classify driver GPS pings by state.
- **Sheet ID caching**: Google Sheet tab GIDs are cached in a `Map` in memory to avoid repeated API lookups. Lazy-initialized via `getSheetId()`.
- **Geocode caching**: Geocode results are cached in the `geocode_cache` SQLite table to avoid redundant Google Maps API calls.
- **No transactions**: Multi-step operations (update sheet + append log + emit socket) are not atomic. Network failures mid-operation can leave data inconsistent.
- **Onboarding documents**: Both driver and investor onboarding use a seeded document list (`ONBOARDING_DOCS`, `INVESTOR_ONBOARDING_DOCS`) with PDF generation and electronic signature capture.
- **Audit trail**: Admin actions (user creation, driver rename, etc.) are logged to the `audit_trail` table.

## Google APIs

- **Sheets API v4**: Primary database. Rate limit 300 req/min. `valueInputOption: "USER_ENTERED"`.
- **Drive API v3**: Document/POD uploads to a shared folder (`GOOGLE_DRIVE_FOLDER_ID` env var). Photos are converted to PDF via pdfkit before upload.
- **Maps APIs**: Directions, Geocoding, Places — used for route calculation, address lookup, and geocode caching. API key exposed to frontend via `GET /api/config/maps-key`.
- Scopes: `spreadsheets`, `drive.file`
- Service account: `sheets-bot@logistics-app-491014.iam.gserviceaccount.com`
- Spreadsheet and Drive folder must be shared with this email as Editor.
- API clients (`sheetsClient`, `driveClient`) are lazy-initialized singletons via `getSheets()` / `getDrive()`.
