<!-- Extracted verbatim from CLAUDE.md on 2026-08-18 to keep that file inside the context budget.
     CLAUDE.md now carries a short summary and points here. Nothing was reworded or dropped. -->

# Backend (`server.js`)
Single-file Node.js/Express server (~18,450 lines, ~185 REST endpoints). Google Sheets is the primary database (Sheets API v4); SQLite for local data; Drive API for uploads; Socket.IO for real-time. Body limit raised to 50mb for large payloads with embedded base64 photos/signatures.

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
- **Gemini 2.5 Flash vision** — expense receipt OCR (`POST /api/expenses/ocr`). Called via `fetch` (no SDK) with `responseSchema` enforcing the JSON shape. Requires `GEMINI_API_KEY`; falls back to 503 + silent manual-entry when unset. Key is shared across Alchemy projects (rotate in one place). Retry (2 retries, exp backoff, 15 s `AbortController` timeout) mirrors the Google Routes integration. **Autofill surfaces:** the driver `ExpenseForm`, the admin/dispatcher single "Log Expense" form in `ExpensesTab` (enhance→OCR→prefill, with Undo), and the **Bulk Upload** sub-tab (`components/dashboard/expenses/BulkReceiptScan.vue`) — pick a default driver, drop N receipts (≤25/batch), each image is OCR'd (concurrency 3; bulk skips the ScanKit enhance pass to save credits) into an editable review grid, then one create per row via `POST /api/expenses`. Write-timeouts (ambiguous re: whether the insert landed) are parked in a non-auto-retried `timeout` state to avoid double-booking the P&L, since `POST /api/expenses` is not idempotent.
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
- `POST /api/dispatch/cancel` — **Super Admin only**. Sets status `Cancelled` (not `Unassigned`) so the load drops from every KPI via `excludeDroppedLoads()`. Per 2026-04-19 client decision, dispatchers lost this; use the Driver reassign dropdown for swaps. **Requires `reason`** (≥3 chars, else 400 `CANCEL_REASON_REQUIRED`) — enforced server-side so the guard holds for any caller, not just the UI. The reason is stored on the `load_status_history` row, echoed to the driver notification and the dispatch feed, and the cancel is `logAudit`ed (`cancel_load`). Added 2026-08-05 after a live $1,050 load was cancelled instead of the one the broker called off: the old confirm read only "Cancel this assignment?" with **no load id**, so the right and wrong rows prompted identically, and nothing recorded *why*. Both cancel surfaces (`ActiveLoadsTab`, `JobBoardTab`) now use `ConfirmModal` showing load id / driver / route / payment plus a required reason. `computeStatusPhases` returns `reason`, and the **public tracker strips it alongside `actor`** — never leak dispatch's internal note to a customer.
- `DELETE /api/loads/:loadId` — **Super Admin only**. Soft-delete via the `deleted_loads` table; row stays in the Sheet for audit but is filtered from all admin lists + KPIs. Reversible via `DELETE FROM deleted_loads WHERE load_id = ?`.
- `POST /api/loads/ratecon/extract` — Super Admin/Dispatcher. `{pdfBase64, fileName}` → `{fields, warnings}` via the shared `runRateConGemini()`. **Writes nothing** (no sheet, no DB, no Drive) — it exists so the dispatcher can review before committing. Rejects non-PDFs on the `JVBERi` magic prefix, caps size, 503s without `GEMINI_API_KEY`. Rate-limited by `rateConLimiter`.
- `POST /api/loads/from-ratecon` — Super Admin/Dispatcher. `{fields, pdfBase64, fileName}` (fields = what the dispatcher reviewed/edited) → creates the load. See "Load ingestion" below.
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

**Investor payout ledger** (settlement layer over `/api/investor` earnings; table `investor_payouts`, one row per `(owner_id, period)`):
- `GET /api/investor/payouts?as_user_id=N` — one investor's ledger. `GET /api/payouts` — Super Admin fleet-wide console (`/payouts` view), summing every investor into `monthlyTotals` + `grandTotals`. Both run the **same** `reconcileInvestorPayouts()`, which idempotently UPSERTs a row per completed past month and refreshes `amount` **only while the row is still `owed`** — a settled row's figure is frozen.
- `POST /api/investor/payouts/:id/status` — Super Admin moves a payout **either direction**: forward `owed → processing → paid` (`owed → paid` allowed), or backward ("reopen") `paid → processing → owed` (`paid → owed` allowed). A reopen **requires `reason`** (400 without one), clears the stamps it undoes (leaving `paid` nulls `paid_at`/`paid_by`; going to `owed` also nulls `processed_at`/`processed_by`), and records `reopened_at`/`reopened_by`/`reopen_reason` on the row plus a `REOPENED …` line in `audit_trail`. Reopening is exempt from the "$0 is not settleable" guard, which still blocks forward moves. Same-status transitions 409. **Reopening to `owed` re-links the row to live earnings** so the next reconcile refreshes its amount; reopening to `processing` keeps it frozen.
- `PUT /api/investor/payouts/:id/adjust` — signed correction on **any** period including a settled one (late receipts). Capped at ±$10,000, can never invert a payout below $0. Effective payout = `amount + adjustment`; the reconcile only writes `amount`, so adjustments survive recomputes.
- UI (`client/src/views/PayoutsView.vue`): `owed` rows offer Mark Processing / Mark Paid, settled rows offer Reopen / Adjust. **"Mark Paid" is confirm-gated** — it is the only status asserting money actually moved, and an unguarded click once booked $8,703 as paid that was never sent. Reopened rows carry a `reopened` badge with the reason on hover.

**Month-end close** (`PERIOD_FINALIZE_ENABLED`, default off — ships dormant). Client ask: stop hand-adjusting a prior month every time a late receipt lands. A work month now runs `accruing` → `pending` (books open `settlement_grace_days`, default 7, past month end) → `finalized` (frozen; statement published). Table `period_locks` (one row per closed month, **fleet-wide** — one carrier, one month-end; a per-investor lock is incoherent because the super-admin branch of the monthly math sums all expenses with no owner scope). Presence of a `status='locked'` row *is* the lock; `'reopened'` keeps the row so the per-minute sweep can't re-lock what an admin just reopened. No new `investor_payouts.status` value, so **no CHECK rebuild and no forced re-login** — the phase is the pair `(status, locked(period))`.
- **Three legs, all required.** *Lock*: the reconcile's refresh guard becomes `status='owed' && !finalized_at && !isLocked(period)`, which freezes the figure against **all six** drift sources (sheet revenue, driver pay, `trucks.status='Active'` fixed costs, live-read split %, maint/compliance, trip expenses) — not just expenses. *Document*: `finalized_breakdown` JSON snapshot so the statement prints the composition as of close instead of a live recompute. *Posting rule*: `expenses.posted_period` — a receipt whose own month is already finalized books to the **current open month** (prior-period adjustment) while `date` keeps the true purchase date. Legs 1+2 without 3 lose the money; 3 without 1+2 leaks through five other doors.
- **`EXPENSE_PERIOD_EXPR`** (beside `EXPENSE_PNL_FILTER`) is the single source of truth for *which month* an expense counts in. The rule: **settlement basis uses it; operational basis keeps plain `date`.** Applied at 8 sites — incl. `getDeductibleExpensesByDriverMonth()`, whose `substr(date,1,7)` is invisible to a grep for `strftime('%Y-%m'` and drives percentage-driver pay at three call sites. Deliberately *not* applied to the weekly invoice week, fuel CPM, IFTA, or expense trend charts.
- **Scheduled sweep**, not a lazy read-path close (ported from the invoice-autogen batch): a lazy close freezes whatever value is present on the first page load after day 7, so a day-9 receipt lands inside a "final" number and two investors finalize at different values depending on who logged in first. `finalizePeriods()` takes every due lock first (pure clock math, cannot fail), then reconciles **once per investor** and stamps across all periods. Stamps `recomputedAmount`, **not** `amount` — `amount` only refreshes on a page GET, so freezing it would lose receipts that landed while nobody was looking.
- Guards, all inert when the flag is off: forward settle (409 `PERIOD_NOT_FINALIZED`, reopen exempt), adjust (closes a hole the UI was faking client-side; a finalized-but-unpaid row *is* adjustable), statement (**finalized OR paid** — monotone, so legacy paid months stay printable), and expense status flips (`PUT /api/expenses/:id/status` + `/bulk-status`, which could otherwise move three closed months while clearing a backlog; bulk skips locked rows and names the periods rather than failing wholesale).
- `POST /api/periods/:period/finalize` (close early) and `/reopen` (**requires `reason`**; re-links only `status='owed'` rows — a paid row keeps its snapshot because its statement already went out; returns the count of receipts redirected away, which reopening does **not** pull back). `GET /api/periods` is the close calendar.
- **`lib/payout-statement.js` is dual-mode.** Statements now publish at finalization, i.e. possibly before money moves, so the doc keys on `paidAt`: FINAL prints "Final Amount", the finalized/due dates, and "not a receipt"; PAID is unchanged. Shipping without this mails investors a PDF saying they were paid when they weren't.
- Rollout: deploy flag-off (ledger byte-identical), then enable — a baseline seed locks every period whose window already passed, so nothing is retroactively reopened and a month still inside its window closes naturally.

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
- `POST /api/invoices/generate` — weekly (Sat–Fri) invoice PDF from completed loads. Fixed-driver pay uses the completed-loads ∩ ELD-travel active-day basis (see "Driver active days"), clipped to the billing week, at the truck's `driver_pay_daily`; soft-deleted loads are filtered out. Owner-op/percentage drivers bill `(week revenue − fuel/maintenance) × pct` instead. The handler is the named `generateInvoiceHandler(req, res)` so the auto-gen batch (below) can invoke the **same** pay math in-process — one source of truth.
- **Auto-invoice batch** (`INVOICE_AUTOGEN_ENABLED`, default off): a per-minute `setInterval` fires once the current week's **Friday 4:00 PM America/New_York** (DST-aware via `Intl`, `mostRecentInvoiceFridayET()`) has passed, then loops every `drivers_directory` driver, runs `generateInvoiceHandler` in-process (mock req/res, system actor), and **auto-submits** each fresh Draft → `Submitted` (drivers kept forgetting to submit; approval stays manual). Idempotent per week via the `invoice_autogen_runs` marker (keyed on the billing Friday); a boot-time run covers a restart across 4 PM; first-enable seeds a baseline so it never retroactively bills a pre-feature week. It pre-reads the sheet once and **aborts without a marker** if empty (never closes a payroll week on a transient Sheets glitch), cross-checks that every driver who worked got billed (worked-but-unbilled → bounded throttled retry, then an ACTION-NEEDED alert), and sends **one** batch summary (dispatch notification + email to `GMAIL_USER`) instead of N per-invoice submit emails.
- `GET /api/invoices`, `GET /api/invoices/:id/pdf` — list and download invoices. **Super Admin, or the owning Driver — nothing else** (tightened 2026-08-09, issue #228). ⚠️ That rule, and the matching one on `PUT :id/submit` and `POST /api/invoices/generate`, is enforced **inside the handler**, not in the mount — it depends on the row, which middleware cannot express. A `requireAuth`-only mount here is not a missing gate; audited and confirmed 2026-08-19.
- `PUT /api/invoices/:id/submit` — submit an invoice. Same rule: **Super Admin or the owning Driver.** Both routes previously gated only on `role === "Driver"`, so a **Dispatcher or an Investor read any invoice PDF by id and could flip any Draft to Submitted**. The gate is now `role !== "Super Admin" && !driverOwnsInvoice(...)`, which needs no role list because `driverOwnsInvoice()` refuses a blank session `driverName` and neither role carries one. This aligns the detail routes with `GET /api/invoices`, whose non-Super-Admin branch already scopes to `LOWER(driver) = <own name>` and therefore hands both roles zero rows; the SPA `/invoices` view is `meta.roles: ['Super Admin']` and the driver app shows a driver only their own, so no surface loses anything. Production: **0 of 4** non-Driver accounts (1 Dispatcher, 3 Investors) carry a `driver_name`, so this removes exactly their un-discoverable access. Investor scoping via `getInvestorDriverSet()` was considered and **rejected** — it needs live Carrier Database sheet rows to be complete, so an authorization decision resting on it fails **open** for the truck-linked subset and closed for the rest depending on whether a sheet read succeeded. **⚠️ `test-suite.js` exercises neither route** (it only calls `GET /api/invoices`), so a regression here is silent.
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
- `GET /api/config/maps-key` — expose the **browser** Maps key (`GOOGLE_MAPS_BROWSER_KEY`) to the frontend. Unauthenticated **by necessity**, not by oversight: `/apply`, `/invest` and the public `/track/:loadId` tracker all load a map before a session exists, so `requireAuth` here breaks three public surfaces. Treat whatever it serves as published. See "Maps key split" below.
- `GET /api/config/maintenance` — investor maintenance-notice copy (see "Investor maintenance notice" below). No auth, same reasoning as `maps-key`: static copy, fetched at SPA boot before the session resolves.
- `GET /api/fuel/range?driver=|vehicleId=` — miles-left-in-tank from the assigned truck's latest ELD `fuel_pct` × `trucks.fuel_tank_gallons` (or 200 default) × MPG (ELD-derived, else `trucks.avg_mpg`/6.5). Returns `hasFuelData:false` (→ frontend hides the panel) when the device reports no fuel. Powers the tracking Fuel Finder. **Super Admin / Dispatcher / Driver** — Drivers were added 2026-08-06 and are **scoped to themselves**: both query params are *ignored* for the Driver role and the truck comes from `req.session.user.driverName`, the same no-spoofable-surface `/me` shape as `GET /api/driver/me/truck-photo`. This is not cosmetic — `?vehicleId=` bypasses the driver lookup entirely, so honoring it for a Driver would expose any truck's live fuel state to id-guessing. Dispatch keeps both params and the whole fleet. The response also **omits `vehicleId` for the Driver role** (`unit` stays — it's the placard on the truck they're in, and `/api/driver/:driverName` already returns it): the id is inert while the param is ignored, but publishing it to every driver hands out exactly the enumeration key the scoping depends on, so a later refactor that relaxed the blanking would find the fleet's ids already in the wild.
- `GET /api/fuel/verify[?vehicleId=]` — **Super Admin**. Backtests the range formula against each truck's own fill history. Read-only. See "Fuel range honesty" below.
- `GET /api/admin/fuel-gallons-recovery[?limit=]` / `POST /api/admin/fuel-gallons-recovery/apply` — **Super Admin**. Reads the missing gallons back off stored receipt images via Gemini, corroborated against the row's own total. GET proposes (read-only), POST writes. `fuelGallonsLimiter`. See "Gallons recovery" below.
- `GET /api/fuel/trip-plan?loadId=[&vehicleId=]` — Super Admin / Dispatcher / **Driver** (scoped exactly like `/api/poi/fuel-stops`). "Will this load's remaining route fit in the tank, and if not, where must I stop?" See "Fuel range honesty" below.
- `GET /api/poi/fuel-stops?loadId=|originLat=&originLng=&destLat=&destLng=[&limit=]` — diesel truck stops along a load's route (Google Places). Each stop carries `dieselPrice` (live pump price via `fuelOptions`), `priceSource` (`'station'` | `null`), and `effectivePrice` (the live price, or `null` → UI shows "price n/a"). The endpoint **ranks true-cheapest-first** (live prices ascending, then no-price stops by distance) and returns `cheapest` + `livePriceCount`. No regional-average fallback — a coarse estimate would sort as if it were the cheapest stop. `poiLimiter`-capped (`fuelOptions` bumps these to the higher Places SKU). Feeds the tracking-map POI layer + cheapest-diesel list. **Super Admin / Dispatcher / Driver** — a Driver must pass `loadId` (400 without one), is `loadBelongsToDriver()`-checked against it (403), and any **parseable** raw `originLat/originLng/destLat/destLng` is refused (403) then `NaN`-ed for defense in depth, so `load_coordinates` is the only coordinate source. Empty-string coord params are tolerated as no-ops rather than 403s, so a stray querystring key can't break the driver panel. Same reasoning as `GET /api/geocode/load/:loadId` (route coordinates are competitive intel) plus a cost one: a free coordinate pair is an arbitrary route-pricing oracle billed at 4–8 Places calls a shot. Dispatch keeps the raw-coordinate form — they price prospective lanes that have no load yet.

**`poiStopsCache` — the Places fan-out cache (the actual cost control).** This endpoint shipped with a cost asymmetry: `getRoute()` was cached 15 min (`ROUTE_CACHE_TTL`) but the *expensive* half was not, so the cheap Routes call was memoized while the 4–8 billed Places calls were re-issued on every request, including repeat polls of a load whose route hadn't moved. `poiStopsCache` (Map + TTL + FIFO cap, mirroring `trackResponseCache`, 15 min TTL aligned to `ROUTE_CACHE_TTL` so both halves expire together, 200 entries) sits **after** coordinate resolution and **after** the Driver ownership check, so a hit can never bypass authorization. Responses carry `cached: <bool>` as an ops/QA signal for whether the request billed Google.
- **Keyed on the resolved coordinates**, rounded to 3 decimals (~111 m) exactly like `routeCacheKey()` — *not* on the query string or the raw `loadId`. So `?loadId=%23123` and `?loadId=123` land on the same `load_coordinates` row → same coords → same entry; two loads on the same lane share one fan-out; dispatch's raw-coordinate form reuses a driver's cached lane; and re-geocoding a load moves its key automatically, so there is no stale route and no invalidation hook to maintain.
- **`limit` is not part of the key and never refetches.** The fill always requests `POI_FETCH_CAP` (25) and the handler slices on read. This is **billing-neutral**: `limit` only feeds `maxResultCount` per call, while the billed call count is the waypoint count — `clamp(ceil(routeMiles/75), 4, 8)` — which `limit` cannot influence. Consequence worth knowing: the returned set is now the *N genuinely cheapest* rather than the lib's internal top-N re-sorted, which matches the endpoint's stated cheapest-first contract. `cheapest` is stable across limits (the global cheapest sorts to index 0); `livePriceCount` describes the returned slice, so it stays consistent with `stops`.
- **Empty results are deliberately NOT cached.** `findFuelStopsAlongRoute()` degrades a failed waypoint to `[]` silently, so an empty array is ambiguous between "no truck stops on this lane" and "Places was briefly down" — caching the latter would pin a blip into a 15-minute outage for that lane.

