# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # Run server (node server.js) on port 3000
npm run dev      # Run with --watch for auto-restart on file changes
```

No build step, test runner, or linter is configured.

## Architecture

Single-server Node.js/Express app using Google Sheets as the database via Sheets API v4.

**Backend (`server.js`)** — Express server with 6 REST endpoints:
- `GET /api/tabs` — list all sheet tab names
- `GET /api/data?sheet=&page=&limit=` — read rows (paginated, max 200/page)
- `POST /api/data?sheet=` — append row (`{ values: [...] }`)
- `PUT /api/data/:rowIndex?sheet=` — update row by 1-based index
- `DELETE /api/data/:rowIndex?sheet=` — delete row (shifts rows up)
- `GET /api/dashboard` — aggregated KPIs, job board, active loads, fleet data from 5 sheets via single `batchGet`

Authentication uses a Google service account (`service-account-key.json`) with `googleapis` library. The spreadsheet ID and default sheet name ("Job Tracking") are hardcoded at the top of `server.js`.

**Frontend** — Two single-file vanilla HTML/CSS/JS pages, no framework or build tooling:

`public/dashboard.html` — Operations Dashboard ("Control Tower") with KPI cards, revenue bar, unassigned job board with driver assignment, active loads table, and fleet/driver grid. Auto-refreshes every 60s. Fetches from `/api/dashboard`.

`public/index.html` — Data Manager for CRUD operations on individual sheets. Features:
- Sidebar navigation auto-populated from sheet tabs via `/api/tabs`
- Dynamic table rendering with inline editing
- Driver dropdown fields populated from "Carrier Database" sheet
- Modal form for adding rows
- Pagination with configurable page size
- Toast notifications for feedback

## Key Conventions

- **Row indexing**: Row 1 = headers, row 2+ = data. API uses 1-based row indices. Each data object includes `_rowIndex` for referencing.
- **Sheet selection**: All data endpoints accept `?sheet=` query param; defaults to "Job Tracking".
- **Value format**: POST/PUT bodies use `{ values: ["col1", "col2", ...] }` with `valueInputOption: "USER_ENTERED"` (supports formulas).
- **Delete mechanism**: Uses Sheets `batchUpdate` with `deleteDimension` (0-indexed internally), not clearing cell values.
- **Driver fields**: Any column matching `/driver/i` renders as a `<select>` populated from the first driver-like column in "Carrier Database".

## Google Sheets API

- Rate limit: 300 requests/minute
- Scopes: `https://www.googleapis.com/auth/spreadsheets`
- Service account email: `sheets-bot@logistics-app-491014.iam.gserviceaccount.com`
- Spreadsheet must be shared with this email as Editor
