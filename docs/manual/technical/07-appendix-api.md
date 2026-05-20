# API Reference

A flat list of every REST endpoint in `server.js`, grouped by domain. Each row shows the verb, path, and required role. See the relevant chapter for behavior.

## Authentication

| Verb | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/auth/setup-check` | public | Is the system initialized? |
| POST | `/api/auth/setup` | public | One-time Super Admin creation. |
| POST | `/api/auth/login` | public | Establish session (rate-limited). |
| POST | `/api/auth/logout` | any | Destroy session. |
| GET | `/api/auth/session` | any | Current session info. |

## Users

| Verb | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/users` | Super Admin | List users. |
| POST | `/api/users` | Super Admin | Create user. |
| PUT | `/api/users/:id` | Super Admin | Update user. |
| DELETE | `/api/users/:id` | Super Admin | Delete user. |
| PUT | `/api/users/:id/rating` | Super Admin | Set rating. |
| GET | `/api/users/investors` | Super Admin | Users with Investor role. |

## Sheets CRUD

| Verb | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/tabs` | any | List sheet tab names. |
| GET | `/api/data?sheet=&page=&limit=` | any | Read rows (paginated). |
| POST | `/api/data?sheet=` | any | Append row. |
| PUT | `/api/data/:rowIndex?sheet=` | any | Update row. |
| DELETE | `/api/data/:rowIndex?sheet=` | Super Admin | Delete row. |

## Dashboard & dispatch

| Verb | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/dashboard` | Super Admin, Dispatcher | KPIs, job board, active loads, fleet. |
| POST | `/api/dispatch` | Super Admin, Dispatcher | Assign load to driver. |
| POST | `/api/dispatch/reassign` | Super Admin, Dispatcher | Reassign load. |
| POST | `/api/dispatch/cancel` | Super Admin | Cancel load (status → `Cancelled`). |
| DELETE | `/api/loads/:loadId` | Super Admin | Soft-delete via `deleted_loads`. |
| POST | `/api/driver/respond` | Driver | Accept/decline assignment. |
| GET | `/api/load/:loadId` | any | Single load detail. |
| PUT | `/api/load/:loadId` | any | Update load fields. |

## Driver

| Verb | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/driver/:driverName` | Driver, Super Admin | Driver-specific data (financials scrubbed). |
| PUT | `/api/driver/status` | Driver | Update load status. |
| GET | `/api/driver/truck-documents/:id/view` | Driver | View truck doc (rate-limited). |
| GET | `/api/driver/shared-documents/:id/download` | Driver | Admin-shared doc download. |

## Fleet

| Verb | Path | Role | Purpose |
|---|---|---|---|
| `/api/trucks` | CRUD | Super Admin (varies by op) | Trucks. |
| `/api/truck-assignments` | GET | any | Truck-driver assignments. |
| `/api/trailers` | CRUD | Super Admin, Dispatcher | Trailers. |
| `/api/drivers-directory` | CRUD | Super Admin | Drivers directory (SQLite Carrier Database). |

## Applications & onboarding

| Verb | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/public/apply` | public | Driver application (rate-limited). |
| GET | `/api/applications` | Super Admin | List applications. |
| PUT | `/api/applications/:id/status` | Super Admin | Approve/reject. |
| GET | `/api/applications/:id/pdf` | Super Admin | Download application PDF. |
| POST | `/api/public/investor-apply` | public | Investor application (rate-limited). |
| `/api/investor-applications` | CRUD | Super Admin | Manage. |
| `/api/public/investor-onboarding/:id/*` | public | Investor onboarding flow. |
| `/api/onboarding/*` | Driver | Driver onboarding flow. |

## Investors

| Verb | Path | Role | Purpose |
|---|---|---|---|
| `/api/investors` | CRUD | Super Admin | Investor records. |
| `/api/investor` | GET | Super Admin, Investor | Investor dashboard data. |
| `/api/investor/config` | GET/PUT | Super Admin, Investor | View configuration. |
| `/api/investor/documents` | GET | Super Admin, Investor | Signed documents. |
| `/api/investor/tax-csv` | GET | Super Admin, Investor | Tax CSV export. |
| `/api/investor/report` | GET | Super Admin, Investor | Range PDF report. |
| `/api/investor-outreach/send` | POST | Super Admin | Send outreach email. |
| `/api/investor-outreach/log` | GET | Super Admin | Outreach history. |
| `/api/legal-documents` | CRUD | Super Admin, Investor (scoped) | Legal doc storage. |

## Messaging

| Verb | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/messages` | any | Send message. |
| GET | `/api/messages` | any | List messages. |
| GET | `/api/messages/:driverName` | any | Conversation with driver. |
| PUT | `/api/messages/read` | any | Mark read. |
| PUT | `/api/notifications/read` | any | Mark notification read. |
| `/api/dispatch-notifications` | GET | Super Admin, Dispatcher | Admin notifications. |
| `/api/investor/messages` | GET/POST | Super Admin, Investor | Investor chat. |

## Expenses & finance

| Verb | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/expenses` | any | Log expense. |
| POST | `/api/expenses/ocr` | Driver, Super Admin, Dispatcher | Gemini receipt OCR (rate-limited). |
| GET | `/api/expenses/all` | Super Admin, Dispatcher | All expenses. |
| PUT | `/api/expenses/:id/status` | Super Admin | Approve/reject. |
| GET | `/api/expenses/fuel-analytics` | Super Admin | Fuel spend analytics. |
| `/api/maintenance-fund` | CRUD | Super Admin | Maintenance fund. |
| `/api/compliance/fees` | CRUD | Super Admin | Compliance fees. |
| `/api/compliance/ifta` | GET | Super Admin | IFTA mileage by state. |

## Invoices

| Verb | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/invoices/generate` | Super Admin | Generate from load data. |
| GET | `/api/invoices` | Super Admin, Driver (own) | List invoices. |
| GET | `/api/invoices/:id/pdf` | Super Admin, Driver (own) | Download invoice PDF. |
| PUT | `/api/invoices/:id/submit` | Driver, Dispatcher | Submit for approval. |
| PUT | `/api/invoices/:id/approve` | Super Admin | Approve. |

## Financials

| Verb | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/financials` | Super Admin | Aggregated P&L. |

## Public tracker

| Verb | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/public/track/:loadId` | public | Customer-facing tracker (rate-limited, response-whitelisted). |

## Documents & uploads

| Verb | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/documents/upload` | any | Upload POD/document to Drive. |
| GET | `/api/documents/:loadId` | any | List documents for load. |
| POST | `/api/chat/attachment` | any | Upload chat attachment. |
| POST | `/api/legal-documents/upload` | Super Admin | Upload truck/investor/driver legal doc. |
| PATCH | `/api/legal-documents/:id/visibility` | Super Admin | Toggle driver visibility. |
| GET | `/api/legal-documents?truck_id=` | Super Admin, Investor (scoped) | Scoped fetch. |

## Location & maps

| Verb | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/location` | Driver | **Retired 2026-05-13.** Returns 410 Gone; phone GPS replaced by Routemate ELD telemetry. |
| GET | `/api/locations/latest` | Super Admin, Dispatcher | Latest position per active driver. |
| GET | `/api/locations/trail` | Super Admin, Dispatcher | Historical GPS trail. |
| GET | `/api/route` | any | Route directions. |
| `/api/geocode` | GET | any | Geocode address (cached). |
| `/api/geocode/search` | GET | any | Places search. |
| `/api/geocode/bulk` | POST | Super Admin | Batch geocode. |
| `/api/geocode/load/:loadId` | GET | any | Geocode a specific load's addresses. |
| GET | `/api/config/maps-key` | any | Expose Maps API key to frontend. |
| GET | `/api/weather` | any | Weather for coordinates. |

## Admin tools

| Verb | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/admin/audit-trail` | Super Admin | View audit log. |
| PUT | `/api/admin/fix-driver-name` | Super Admin | Rename driver across sheets. |
| GET | `/api/admin/scan-duplicates` | Super Admin | Find duplicates. |
| GET | `/api/admin/scan-driver-mismatches` | Super Admin | Find mismatches. |
| GET | `/api/admin/scan-orphans` | Super Admin | Find orphans. |
| GET | `/api/admin/scan-stale-locations` | Super Admin | Stale GPS. |
| POST | `/api/admin/fix-stale-locations` | Super Admin | Clean stale. |
| POST | `/api/admin/remove-rows` | Super Admin | Batch remove. |
| GET | `/api/archive` | Super Admin | Archived data. |
| GET | `/api/archive/tabs` | Super Admin | Archive tabs list. |

## Database admin

| Verb | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/db/download` | Super Admin | Download SQLite file. |
| GET | `/api/db/tables` | Super Admin | List tables. |
| GET | `/api/db/query/:table` | Super Admin | Query a table. |

## Routemate (telematics)

| Verb | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/admin/routemate/sync-now` | Super Admin | Manual vehicle sync. |
| GET | `/api/routemate/health` | Super Admin | Health probe. |

## Webhooks

| Verb | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/n8n/job` | `x-webhook-secret` | New load from n8n. |
| POST | `/api/webhook/new-load` | `x-webhook-secret` | Secondary ingestion path. |

## Debug (development)

| Verb | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/debug/driver-view/:driverName` | Super Admin | What this driver sees. |
| GET | `/api/debug/driver-empty/:driverName` | Super Admin | Empty-state probe. |
| GET | `/api/debug/sample-row` | Super Admin | First sheet row. |
| GET | `/api/debug/driver-loads/:driverName` | Super Admin | Driver's loads, raw. |
| GET | `/api/debug/user/:username` | Super Admin | User record dump. |

## Socket.IO events

| Event | Direction | Room |
|---|---|---|
| `register` | client → server | — |
| `load-assigned` | server → client | `driver:<name>` |
| `load-cancelled` | server → client | `driver:<name>` |
| `load-deleted` | server → client | `dispatch` |
| `load-accepted` / `load-declined` | server → client | `dispatch` |
| `status-updated` | server → client | `dispatch` |
| `dispatch-notification` | server → client | `dispatch` |
| `new-message` | server → client | all |
| `pod-uploaded` | server → client | `dispatch` |
| `location-update` | server → client | `dispatch` |
| `geofence-trigger` | server → client | `dispatch`, `driver:<name>` |
| `reload` | server → client | all |
