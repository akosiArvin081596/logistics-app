# Backend

The backend lives in a single file, `server.js`, ~12,000 lines and growing. It exposes roughly 150 REST endpoints, hosts a Socket.IO server for real-time fan-out, and brokers between three storage layers: SQLite (`app.db`), Google Sheets, and Google Drive.

## Why a single file

When LogisX started, the data model lived entirely in Google Sheets and the server was a thin proxy. As features piled on — SQLite tables, real-time sockets, PDF generation, OCR, telematics — the file kept growing rather than fragmenting. The trade-off is real: one file is easy to grep but hard to refactor. We keep it intentionally for now because:

- The route handlers are mostly independent (no deep shared state beyond a few singletons).
- Logical sections are clearly fenced with comment banners.
- Splitting into modules would require designing the boundaries that don't naturally exist yet.

When a domain finally outgrows the single-file model (the PDF rendering already has, hence `lib/pdf-browser.js`), we lift it into `lib/` as a focused module. Anything in `lib/` is the right place to look first for self-contained logic.

## Process model

`server.js` boots in this order:

1. Load `.env` via `dotenv`.
2. Open `app.db` via `better-sqlite3` (synchronous, WAL-mode SQLite). All queries are synchronous — no connection pool, no async lock.
3. Run schema migrations (described below).
4. Construct Express app: body parser (50 MB limit for base64 photos), compression, session middleware (SQLite-backed), CSP-free static serving from `client/dist/` (or `public/` fallback).
5. Mount routes.
6. Wire Socket.IO onto the same HTTP server.
7. Start background intervals (driver-location cleanup, Routemate sync if enabled, demo-viewer write lockdown ticks).
8. Listen on `process.env.PORT` (default 3000).

A single Node process handles everything — there is no worker pool, no queue, no sidecar. The 60-second in-memory Sheets cache (`getJobTrackingCached()`) is the only thing keeping this honest under load.

## Storage layout

The system has three storage backends serving different needs.

### Google Sheets (system of record for loads)

The "Job Tracking" tab in spreadsheet `1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo` is the canonical source for every load that ever moved through LogisX. Columns include Load ID, Driver, Status, Pickup / Drop-off Appointment, Payment, Owner ID, and many more — the exact schema is determined by header row 1 and discovered by regex at query time, not by a fixed type definition.

Why Sheets and not a database? History: clients started in Sheets and want to keep the same interface. n8n also reads/writes the sheet directly when ingesting broker emails, so the sheet is the integration point. Sheets imposes a 300 req/min quota, which is the reason for the 60-second in-memory read cache.

A separate archive spreadsheet (`1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI`) holds historical data accessed only via `/archive`.

### SQLite (`app.db`, WAL mode)

About 35 tables holding everything that doesn't fit the Sheets model. Grouped by domain:

| Domain | Tables |
|---|---|
| Auth & users | `users`, session store |
| Messaging | `messages`, `notifications`, `dispatch_notifications` |
| Dispatch state | `load_responses`, `load_ratings`, `load_coordinates`, `deleted_loads` |
| Fleet | `trucks`, `truck_assignments`, `trailers`, `drivers_directory`, `carrier_driver_history` |
| Finance | `expenses`, `maintenance_fund`, `compliance_fees`, `invoices`, `investor_config` |
| Investors | `investors`, `investor_applications`, `investor_onboarding`, `investor_onboarding_documents`, `investor_payment_info`, `investor_outreach_log` |
| Driver onboarding | `job_applications`, `driver_onboarding`, `onboarding_documents`, `driver_payment_info` |
| Documents | `documents`, `legal_documents` |
| Tracking | `driver_locations`, `geocode_cache` |
| Telematics | `routemate_vehicles`, `routemate_telemetry`, `routemate_fault_codes`, `routemate_dvir`, `routemate_fuel_daily`, `routemate_hos_daily` |
| Admin | `audit_trail` |

The SQLite file lives at the project root and is the only thing other than `.env` and `service-account-key.json` that needs to be backed up.

### Google Drive (POD storage)

Driver-uploaded proof-of-delivery photos are converted to PDF (via `imageToPdf()` in `server.js`) and uploaded to a single shared Drive folder identified by `GOOGLE_DRIVE_FOLDER_ID`. The Drive file ID is stored back in SQLite (`documents.drive_file_id`). If the environment variable is unset, uploads silently skip Drive and persist only locally.

## Schema migrations

There is no migration framework. Two patterns coexist:

**Additive column adds.** On boot, the server tries `ALTER TABLE … ADD COLUMN` for every column that may not yet exist, wrapped in `try/catch`. The catch absorbs the duplicate-column error and moves on. This is the path used for the vast majority of schema changes.

**Rename-recreate.** When a CHECK constraint changes (most commonly the `users.role` constraint when a new role is added), the migration tries a test insert in `try/catch`; on failure, it renames the old table, creates the new one with the updated constraint, copies data over, drops the renamed table, and clears all active sessions so users are forced to re-login. This is more invasive but reversible at the cost of a forced re-login.

Migrations are idempotent and run on every boot. A fresh `app.db` and a long-lived `app.db` reach the same final schema.

## Authentication & authorization

Session-based, no JWTs. Cookies are `httpOnly`, `secure` in production, `sameSite=strict`. The session secret comes from `SESSION_SECRET` in `.env` — in development there is a default fallback, but production must set it.

Four roles enforced by two middlewares:

- `requireAuth` — returns 401 if no session.
- `requireRole(...roles)` — returns 403 if the session role doesn't match.

The roles are **Super Admin**, **Dispatcher**, **Driver**, **Investor**. Routes either guard with `requireRole('Super Admin')` or accept multiple roles. The `requireAuth`-only routes (no role check) are the ones any logged-in user can hit.

Two additional gates:

- **Webhook secret.** n8n's load-ingestion endpoints require an `x-webhook-secret` header matching `N8N_WEBHOOK_SECRET`. There is no user session involved.
- **Demo viewer lockdown.** A global write-lockdown middleware blocks all mutating verbs (POST/PUT/PATCH/DELETE) for a demo-only role, with a small whitelist for harmless idempotent operations.

## Role-based data sanitization

Two scrubbing points where data flows out:

- `GET /api/data` strips columns whose headers match `/rate|amount|revenue|pay|charge|price|cost/i` when the requester is a Driver.
- `PUT /api/data/:rowIndex` preserves broker and phone-contact columns by reading them back from the sheet and splicing them into the write payload, so a non-Super-Admin update cannot accidentally clobber broker info.

The pattern is "regex-detect sensitive columns at request time" — not "schema-declared sensitivity." This makes the system tolerant of differently-named columns across sheets but fragile to typos in column headers.

## Error handling

Every route handler is wrapped in `try/catch` with a generic `500` JSON response on failure. There is no structured error type and no error-aggregation service — errors are `console.error`'d with enough context to diagnose from `pm2 logs`.

Multi-step operations are not atomic. If a dispatch assignment writes to the sheet successfully but the audit-trail insert fails afterward, the sheet has the new state and the audit table doesn't. The system tolerates this because:

- Audit failures don't block the user.
- Sheets-vs-SQLite drift is rare in practice and visible from the affected screen.

The geofence handler inside `POST /api/location` is the canonical example: location persistence is the primary obligation, and geofence-triggered status updates are best-effort — any error inside the geofence block is caught and logged but never causes the location report to fail.

## Rate limiting

Per-endpoint limiters using `express-rate-limit`, naming pattern `{feature}Limiter`:

| Limiter | Window | Max | Purpose |
|---|---|---|---|
| `publicFormLimiter` | 15 min | 10 | Public driver/investor application submission |
| `loginLimiter` | 15 min | 20 | Brute-force protection on `/api/auth/login` |
| `changePasswordLimiter` | 15 min | 5 | Slow password rotation attacks |
| `driverFilesLimiter` | 15 min | 30 | Enumeration protection on `/api/trucks/:id/driver-files` |
| `truckDocViewLimiter` | 15 min | 30 | Same for `/api/driver/truck-documents/:id/view` |
| `trackPublicLimiter` | 15 min | 60 | Higher cap because customers refresh the public tracker often |
| `expenseOcrLimiter` | 15 min | 20 | Caps Gemini API spend on receipt OCR |

All limiters use `standardHeaders: true` so clients can read `X-RateLimit-*` headers. The 60-second in-memory Sheets cache is the other practical throttle — it absorbs bursty dashboard traffic before it ever reaches the limiter.

## Real-time fan-out

Socket.IO is the way the UI stays current without polling. Clients emit `register` with their name (or role) to join a room. Server emits include:

- `load-assigned` — to a specific driver when dispatched.
- `load-cancelled` — to a driver when their dispatch is cancelled.
- `load-deleted` — to the dispatch room when a load is soft-deleted.
- `load-accepted` / `load-declined` — to the dispatch room on driver response.
- `status-updated` — to the dispatch room on every status transition.
- `dispatch-notification` — for everything that needs to surface in the admin notifications panel. Metadata always contains `loadId` so clicks can deep-link to `/dashboard?load=…`.
- `new-message` — to all on chat message.
- `pod-uploaded` — to the dispatch room when a driver uploads proof of delivery.
- `location-update` — to the dispatch room when a driver reports GPS.
- `geofence-trigger` — to driver and dispatch room when the geofence auto-advances a status.
- `reload` — to all clients 500 ms after server start, used as a dev-only live-reload signal.

Investors join an `investor` room — separate from the `dispatch` room — so dispatch traffic doesn't leak to them. Drivers join a per-driver room `driver:<name>` keyed by their full name (case-insensitive after normalization).

## The load-exclusion helper

Three financial aggregators (`/api/dashboard`, `/api/financials`, `/api/investor`) all answer the question "is this load live?" the same way: they run sheet rows through `excludeDroppedLoads(rows, headers)` before any math. The helper drops:

- Rows whose status matches `CANCELED_STATUS_RE = /^(cancel|canceled|cancelled)$/i`.
- Rows whose Load ID is in the `deleted_loads` SQLite table.

This is the single chokepoint that keeps dashboard, financials, and investor numbers aligned. If you add a fourth aggregator, route it through the same helper or your number will drift from everyone else's.

## Soft-delete patterns

Two patterns coexist by design:

**Separate `deleted_loads` table.** Used when the canonical record lives in Google Sheets, not SQLite — the soft-delete state is what lives locally. Query pattern: `LEFT JOIN deleted_loads … WHERE deleted_loads.load_id IS NULL`. Recovery: `DELETE FROM deleted_loads WHERE load_id = ?`.

**`deleted_at` timestamp column.** Used on tables that live entirely in SQLite (e.g., `job_applications`). List endpoints filter `WHERE deleted_at IS NULL`, with `?include_deleted=true` to recover. Cheaper than the join but only works when SQLite owns the record.

Pick the pattern that matches your table's home, not the other way around.
