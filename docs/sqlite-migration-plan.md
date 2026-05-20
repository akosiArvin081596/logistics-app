# Plan: Migrate from Google Sheets to SQLite (Full)

## Context
The LogisX app currently uses Google Sheets API v4 as its primary database for Job Tracking, Carrier Database, Payments, and Status Logs. This causes:
- Dual-spreadsheet drift (n8n writes to original, app reads from copy)
- Google API rate limits (300 req/min)
- Slow reads (network calls vs local DB)
- No real SQL queries (regex column matching instead)
- Dependency on external service

The client only uses the LogisX web app — never edits Google Sheets directly. All data will be processed in the application. n8n will POST to the app's API instead of Google Sheets.

## Scope
- Migrate ALL data from Google Sheets to SQLite
- Remove Google Sheets as primary database
- Keep Google Drive API for document/POD uploads only
- n8n writes to app via webhook API, not Sheets
- Migrate ~300 loads, payments, status logs, carrier database

## New SQLite Tables

### `loads` (replaces Job Tracking sheet)
```sql
CREATE TABLE IF NOT EXISTS loads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    load_id TEXT NOT NULL,
    contract_id TEXT DEFAULT '',
    details TEXT DEFAULT '',
    trailer_number TEXT DEFAULT '',
    driver TEXT DEFAULT '',
    pickup_info TEXT DEFAULT '',
    pickup_appointment TEXT DEFAULT '',
    pickup_address TEXT DEFAULT '',
    dropoff_info TEXT DEFAULT '',
    dropoff_appointment TEXT DEFAULT '',
    dropoff_address TEXT DEFAULT '',
    job_status TEXT DEFAULT 'Unassigned',
    phase_of_progress TEXT DEFAULT '',
    carrier_stage TEXT DEFAULT '',
    payment TEXT DEFAULT '',
    broker_contact_name TEXT DEFAULT '',
    phone_number TEXT DEFAULT '',
    email TEXT DEFAULT '',
    location_link TEXT DEFAULT '',
    documents TEXT DEFAULT '',
    assigned_date TEXT DEFAULT '',
    status_update_date TEXT DEFAULT '',
    completion_date TEXT DEFAULT '',
    origin_lat REAL,
    origin_lng REAL,
    dest_lat REAL,
    dest_lng REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_loads_load_id ON loads(load_id);
```

### `carriers` (replaces Carrier Database sheet)
```sql
CREATE TABLE IF NOT EXISTS carriers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver TEXT NOT NULL,
    carrier_name TEXT DEFAULT '',
    state TEXT DEFAULT '',
    city TEXT DEFAULT '',
    zip TEXT DEFAULT '',
    address TEXT DEFAULT '',
    trucks TEXT DEFAULT '',
    hazmat TEXT DEFAULT '',
    phone_number TEXT DEFAULT '',
    cell_number TEXT DEFAULT '',
    email TEXT DEFAULT '',
    dot TEXT DEFAULT '',
    mc TEXT DEFAULT '',
    rating REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `payments` (replaces Payments Table sheet)
```sql
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT DEFAULT '',
    job_id TEXT NOT NULL,
    invoice_number TEXT DEFAULT '',
    payment_amount TEXT DEFAULT '',
    payment_date TEXT DEFAULT '',
    payment_status TEXT DEFAULT '',
    tender_fee TEXT DEFAULT '',
    amount_due_to_carrier TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `status_logs` (replaces Status Logs sheet)
```sql
CREATE TABLE IF NOT EXISTS status_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id TEXT NOT NULL,
    load_id TEXT DEFAULT '',
    driver TEXT DEFAULT '',
    old_status TEXT DEFAULT '',
    new_status TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    timestamp TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Migration Steps

### Phase 1: Create tables + migrate data
1. Add new table schemas to server.js boot migrations
2. Write one-time migration script that:
   - Reads all rows from Google Sheets (Job Tracking, Carrier Database, Payments Table, Status Logs)
   - Deduplicates Job Tracking by Load ID (keep last row)
   - Inserts into corresponding SQLite tables
   - Merges `load_coordinates` data into the `loads` table (coordinates now inline)
3. Run migration on VPS

### Phase 2: Rewrite API endpoints
Replace all Sheets API calls with SQLite queries:

| Endpoint | Current (Sheets) | New (SQLite) |
|----------|-----------------|--------------|
| GET /api/tabs | List sheet tabs | List table names |
| GET /api/data | Read sheet rows (paginated) | SELECT with LIMIT/OFFSET |
| POST /api/data | Append sheet row | INSERT INTO |
| PUT /api/data/:rowIndex | Update by row index | UPDATE by id |
| DELETE /api/data/:rowIndex | Delete by row index | DELETE by id |
| GET /api/dashboard | Read multiple sheets, aggregate | SQL JOINs and aggregates |
| POST /api/dispatch | Write to sheet + socket | INSERT/UPDATE + socket |
| GET /api/driver/:name | Filter sheet rows | WHERE driver = ? |
| PUT /api/driver/status | Update sheet row + log | UPDATE loads + INSERT status_logs |
| GET /api/expenses/fuel-analytics | Read expenses | Already SQLite |
| GET /api/investor | Read sheet + compute | SQL JOIN loads + carriers |

### Phase 3: Add webhook endpoint for n8n
```
POST /webhook/n8n/load
Auth: x-api-key header
```
- Receives extracted load data from n8n
- INSERT OR REPLACE into `loads` table
- Auto-geocode addresses
- INSERT into `payments` table
- Emit socket event
- No Google Sheets involved

### Phase 4: Update n8n workflow
- Replace Google Sheets nodes with HTTP Request to webhook
- Remove RATE UPDATE node (payments handled by webhook)
- Remove JOB DETAILS ENTRY node (loads handled by webhook)

### Phase 5: Cleanup
- Remove `load_coordinates` table (coordinates now in `loads` table)
- Remove Google Sheets lazy init (`getSheets()`, `sheetsClient`)
- Remove sheet ID caching
- Remove regex column matching (direct column names now)
- Keep Google Drive API for document uploads only
- Remove `service-account-key.json` dependency for Sheets (keep for Drive)

## Files to modify
- `server.js` — major rewrite of all API endpoints (~4000 lines affected)
- `.env` — add `N8N_API_KEY`, remove `GOOGLE_SHEETS` references
- `Dispatch-v2.json` — replace Sheets nodes with HTTP Request
- Client-side stores may need minor updates if API response format changes

## What stays the same
- Frontend Vue 3 app — mostly unchanged (reads from same API endpoints)
- SQLite tables already in use (users, messages, expenses, etc.)
- Google Drive API for POD/document uploads
- Socket.IO real-time events
- Session-based auth for web users
- API key auth for n8n webhook

## Verification
1. `node --check server.js`
2. Run migration script → verify row counts match
3. Test all API endpoints with existing frontend
4. Test n8n webhook with curl
5. Test full n8n flow: email → extract → webhook → load appears in dashboard
6. Build and deploy to VPS
7. Monitor for 24h
