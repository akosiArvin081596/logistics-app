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

No test runner or linter is configured.

## Architecture

### Backend (`server.js`)
Node.js/Express server using Google Sheets as the primary database via Sheets API v4, with SQLite for local data (users, messages, expenses, investor config).

REST endpoints:
- `GET /api/tabs` — list all sheet tab names
- `GET /api/data?sheet=&page=&limit=` — read rows (paginated, max 200/page)
- `POST /api/data?sheet=` — append row (`{ values: [...] }`)
- `PUT /api/data/:rowIndex?sheet=` — update row by 1-based index
- `DELETE /api/data/:rowIndex?sheet=` — delete row (shifts rows up)
- `GET /api/dashboard` — aggregated KPIs, job board, active loads, fleet data
- `GET /api/driver/:name` — driver-specific data
- `PUT /api/driver/status` — update load status
- `POST /api/messages`, `PUT /api/messages/read`, `GET /api/messages` — messaging
- `POST /api/expenses` — expense logging
- `GET /api/investor`, `PUT /api/investor/config` — investor view
- Auth: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`, `POST /api/auth/setup`
- Users: `GET /api/users`, `POST /api/users`, `DELETE /api/users/:id`

Socket.IO for real-time messaging. Session-based auth with 4 roles: Admin, Dispatcher, Driver, Investor.

### Frontend (`client/`)
Vue 3 + Vite SPA with Vue Router and Pinia state management.

```
client/src/
  main.js              — App bootstrap
  App.vue              — Root: sidebar + router-view + toast
  router/index.js      — 6 routes with role-based auth guards
  stores/              — Pinia stores (auth, dashboard, sheets, driver, messages, investor, users)
  composables/         — useApi, useSocket, useToast, usePagination
  components/
    layout/            — AppSidebar, AppToast
    shared/            — StatusBadge, PaginationBar, EmptyState, SkeletonLoader, ConfirmModal
    dashboard/         — KpiGrid, RevenueGrid, JobBoardTab, ActiveLoadsTab, FleetTab, MessagingPanel
    data-manager/      — DataTable, AddRowModal, SheetTabs
    driver/            — DriverHeader, BottomNav, LoadCard, StatusStepper, ChatView, ExpenseForm, etc.
    investor/          — ProductionSection, AssetSection, TaxShieldSection, RecessionSection
    users/             — AddUserForm, UserTable
  views/               — LoginView, DashboardView, DataManagerView, DriverView, InvestorView, UsersView
```

### Legacy Frontend (`public/`)
Original vanilla HTML/CSS/JS pages. Kept as fallback — Express serves `client/dist/` if it exists, otherwise `public/`.

## Key Conventions

- **Row indexing**: Row 1 = headers, row 2+ = data. API uses 1-based row indices. Each data object includes `_rowIndex` for referencing.
- **Sheet selection**: All data endpoints accept `?sheet=` query param; defaults to "Job Tracking".
- **Value format**: POST/PUT bodies use `{ values: ["col1", "col2", ...] }` with `valueInputOption: "USER_ENTERED"` (supports formulas).
- **Delete mechanism**: Uses Sheets `batchUpdate` with `deleteDimension` (0-indexed internally), not clearing cell values.
- **Driver fields**: Any column matching `/driver/i` renders as a `<select>` populated from the first driver-like column in "Carrier Database".
- **Role-based routing**: Admin sees all, Dispatcher sees dashboard+data, Driver sees driver app (no sidebar), Investor sees financial view.

## Google Sheets API

- Rate limit: 300 requests/minute
- Scopes: `https://www.googleapis.com/auth/spreadsheets`
- Service account email: `sheets-bot@logistics-app-491014.iam.gserviceaccount.com`
- Spreadsheet must be shared with this email as Editor
