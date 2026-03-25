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
PORT=3000  # optional, defaults to 3000
```

Hardcoded values in `server.js` (change if forking):
- Spreadsheet ID: `"1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI"`
- Session secret: `"dispatch-logistics-2024"` (24-hour cookie max age)

## Architecture

### Backend (`server.js`)
Single-file Node.js/Express server (~2000 lines) using Google Sheets as the primary database via Sheets API v4, with SQLite for local data. Google Drive API for document uploads. Socket.IO for real-time events.

**Static file serving**: Express checks if `client/dist/` exists (production build) → falls back to `public/` (legacy vanilla HTML/JS). SPA catch-all `app.get("*")` serves `index.html` for client-side routing.

**SQLite** (`app.db`, WAL mode): `users`, `messages`, `expenses`, `maintenance_fund`, `compliance_fees`, `documents`, `driver_locations`, `investor_config`. Session store also in SQLite.

**Schema migrations**: On boot, server checks for missing columns/constraints and adds them with `ALTER TABLE`. Example: adding `gallons`/`odometer` columns to expenses, or expanding the role CHECK constraint to include Investor.

REST endpoints:
- `GET /api/tabs` — list all sheet tab names
- `GET /api/data?sheet=&page=&limit=` — read rows (paginated, max 200/page)
- `POST /api/data?sheet=` — append row (`{ values: [...] }`)
- `PUT /api/data/:rowIndex?sheet=` — update row by 1-based index
- `DELETE /api/data/:rowIndex?sheet=` — delete row (shifts rows up, Super Admin only)
- `GET /api/dashboard` — aggregated KPIs, job board, active loads, fleet data
- `POST /api/dispatch` — assign load to driver (writes to sheet + notifies via socket)
- `GET /api/driver/:name` — driver-specific data (rate/revenue columns auto-hidden for Driver role)
- `PUT /api/driver/status` — update load status (logs to "Status Logs" sheet)
- `POST /api/messages`, `PUT /api/messages/read`, `GET /api/messages`, `GET /api/messages/:driverName` — messaging
- `POST /api/expenses` — expense logging (fuel with gallons/odometer, maintenance, with optional base64 photo)
- `GET /api/expenses/fuel-analytics` — fuel spend, cost/gallon, monthly + per-driver breakdown
- `GET /api/expenses/ifta-mileage` — quarterly state-by-state mileage for IFTA compliance
- `POST /api/documents/upload` — upload POD/documents to Google Drive
- `POST /api/location` — driver reports GPS position (geofence auto-triggers status updates)
- `GET /api/locations/latest` — latest position per active driver with ETA enrichment
- `GET /api/investor`, `PUT /api/investor/config` — investor view
- Auth: `GET /api/auth/setup-check`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`
- Users: `GET /api/users`, `POST /api/users`, `DELETE /api/users/:id`

**Socket.IO events** (server emits):
- `load-assigned` — to specific driver when dispatched
- `status-updated` — to dispatch room on load status change
- `new-message` — to all on new chat message
- `pod-uploaded` — to dispatch room on document upload
- `location-update` — to dispatch room on driver GPS report
- `geofence-trigger` — to driver and dispatch room when geofence auto-triggers status
- `reload` — to all 500ms after server start (live reload during dev)

Clients emit `register` with their name to join a socket room.

Session-based auth with 4 roles: Super Admin, Dispatcher, Driver, Investor. Auth middleware: `requireAuth` (401), `requireRole(...roles)` (403). First-time setup creates the initial Super Admin via `POST /api/auth/setup`.

### Frontend (`client/`)
Vue 3 + Vite SPA with Vue Router, Pinia stores, and Leaflet for maps. Socket.IO client for real-time updates.

Key directories: `stores/` (auth, dashboard, sheets, driver, messages, investor, users), `composables/` (useApi, useSocket, useToast, usePagination, useGeolocation), `components/` (layout, shared, dashboard, data-manager, driver, investor, users), `views/` (6 view components).

**useApi**: Simple fetch wrapper with `get/post/put/del` methods, relative URLs, throws on non-200.

**useSocket**: Global singleton socket — `connect()`, `register(name)`, `emit()`, `on()`, `off()`. Reuses existing connection if already connected.

**Routing** (6 routes with role-based guards):
- `/login` — public (redirects authenticated users to role home)
- `/dashboard` — Super Admin, Dispatcher
- `/data` — Super Admin, Dispatcher
- `/driver` — Driver, Super Admin (no sidebar)
- `/investor` — Super Admin, Investor
- `/users` — Super Admin only

Auth guard calls `checkSession()` on first navigation, then checks role against route meta.

### Legacy Frontend (`public/`)
Original vanilla HTML/CSS/JS pages. Kept as fallback — Express serves `client/dist/` if it exists, otherwise `public/`.

## Key Conventions

- **Row indexing**: Row 1 = headers, row 2+ = data. API uses 1-based row indices. Each data object includes `_rowIndex`. DELETE internally converts to 0-indexed for Sheets `batchUpdate` `deleteDimension`.
- **Sheet selection**: All data endpoints accept `?sheet=` query param; defaults to "Job Tracking".
- **Value format**: POST/PUT bodies use `{ values: ["col1", "col2", ...] }` with `valueInputOption: "USER_ENTERED"` (supports formulas).
- **Column detection via regex**: Headers are matched with patterns — `/driver/i` for driver columns, `/rate|amount|revenue|pay|charge|price|cost/i` for financial columns (hidden from Driver role), `/status/i` for status, `/origin.*lat|pickup.*lat/i` and `/dest.*lat|delivery.*lat/i` for coordinates.
- **Driver fields**: Any column matching `/driver/i` renders as a `<select>` populated from the first driver-like column in "Carrier Database".
- **Role-based routing**: Super Admin sees all, Dispatcher sees dashboard+data (no broker/financial info), Driver sees driver app (no sidebar), Investor sees financial view.
- **Geofence logic**: `POST /api/location` uses `geolib.isPointWithinRadius()` with a **500m threshold**. Auto-advances status only when current status matches the expected predecessor (e.g., "Dispatched" → "At Shipper", "In Transit" → "At Receiver"). Logs to "Status Logs" sheet.
- **ETA calculation**: Uses `geolib.getDistance()` to destination. Default speed: 24.587 m/s (~55 mph) when GPS speed is unreliable. Compares ETA vs scheduled delivery to flag "on-time" / "delayed".
- **IFTA state matching**: Hardcoded bounding boxes for ~24 US states (TX, OK, LA, AR, NM, MS, AL, TN, GA, FL, MO, KS, CO, AZ, CA, NV, IL, IN, OH, PA, NY, NC, SC, VA) to classify driver GPS pings by state.
- **Sheet ID caching**: Google Sheet tab GIDs are cached in a `Map` in memory to avoid repeated API lookups.

## Google APIs

- **Sheets API v4**: Primary database. Rate limit 300 req/min. `valueInputOption: "USER_ENTERED"`.
- **Drive API v3**: Document/POD uploads to a shared folder (`GOOGLE_DRIVE_FOLDER_ID` env var).
- Scopes: `spreadsheets`, `drive.file`
- Service account: `sheets-bot@logistics-app-491014.iam.gserviceaccount.com`
- Spreadsheet and Drive folder must be shared with this email as Editor.
