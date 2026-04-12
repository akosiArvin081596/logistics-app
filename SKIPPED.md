# Audit Hardening — Skipped Items

Items skipped during the audit hardening sprint with reasons.

---

## Sprint 2 — Refactor (skipped to keep edits surgical)

### S2.1: Extract `lib/geocoding.js` (~520 lines)
**Why skipped:** Extracting 520 lines from server.js touches:
- 5 endpoints (`/api/geocode`, `/api/geocode/search`, `/api/geocode/bulk`, `/api/geocode/load/:loadId`, `/api/route`)
- The shared `geocodeAddress`, `geocodeReverse`, `getRoute`, `decodePolyline` helpers
- Module-scope state (`geocodeCache` SQLite prepared statements)

A clean extraction needs all of those moved together. The risk of breaking the dispatch/tracking flow is too high for a surgical edit. **Logged for next sprint with proper testing.**

### S2.2: Consolidate 11 frontend `findCol()` copies
**Why skipped:** Each copy is locally scoped to one component and not causing bugs. The signatures differ slightly across files (some take `(headers, regex)`, some take just `(regex)` and close over `props.headers`). Touching 11 files for a stylistic dedupe is high risk for low value. **Logged for a follow-up sprint.**

### S2.3: Extract column regex patterns to `lib/column-patterns.js`
**Why skipped:** Same reason as S2.2 — patterns are harmless local constants. Centralizing them touches 8+ frontend files and the server. Not blocking anything. **Logged for a follow-up sprint.**

### S2.4: Archive then delete `public/` folder (~3000 lines legacy)
**Why skipped:** The Express static fallback is unreachable in production (client/dist/ exists), but the user may still expect the legacy fallback to work for emergency rollback. Deleting it permanently changes the rollback story. **Needs explicit user approval — logged.**

### S2.5: Split `EarningsSection.vue` → extract `EarningsDetailModal.vue`
**Why skipped:** Recently rewritten this session with computation modals. Splitting the 741-line SFC into a separate modal component is a multi-file change with risk of breaking the recent investor-friendly modal work. **Logged for a follow-up sprint after stabilization.**

### S2.6: Extract `computeInvestorData()` to share between `/api/investor` and `/api/investor/report`
**Why skipped:** Both endpoints are 200+ lines each. Extracting requires careful handling of the slight regex divergence (the audit specifically called this out). One bug here breaks investor financials, which is the most critical surface in the app. **Logged for a dedicated session with full test pass.**

---

## What WAS done in Sprint 2

- Extracted `lib/ifta-states.js` (US_STATE_BOUNDS + getStateFromCoords) — clean, no callers besides one
- Removed shadowed `parseSheet`/`findCol` inside `/api/dashboard` handler
- Deleted dead code: `snapToRoads`, `getDrive`/`driveClient`, `lib/pdf-helpers.js`
- Consolidated inline `require("fs")` and `require("path")` to module-level imports

Net Sprint 2 result: **server.js shrunk by ~100 lines**, no behavior changes, all syntax-checked.

---

## Sprint 3 — Performance (skipped)

### S3.1: Cache load coords + status in `load_coordinates` to eliminate Sheets calls in `POST /api/location`
**Why skipped:** This requires changing the geofence trigger logic, the load_coordinates schema (add `status` column), and ensuring cache invalidation on status updates fires correctly. The geofence logic auto-advances load status — a bug here corrupts dispatch state. **Logged for next sprint with full geofence regression test.**

### S3.2: Move OCR out of expense POST request path (background worker)
**Why skipped:** Tesseract worker management requires a queue + state machine for "pending OCR → completed → failed" states, plus a frontend UI that polls or refreshes for updates. Per audit, OCR currently always returns empty string on failure (already known) — moving to background doesn't fix correctness, just latency. **Logged as a feature, not a bug fix.**

### S3.3: Vant selective imports in DriverView
**Why skipped:** Already largely fixed by the manualChunks vendor split (Vant now in `vendor-vant` chunk at 65kb gzipped, separate from DriverView). Further savings would require auditing every import in the driver/ component subtree. Marginal improvement on top of the already-shipped 44% DriverView reduction.

---

## Sprint 4 — PII Encryption (skipped main item)

### S4.1: AES-256-GCM encrypt SSN/EIN/bank columns at application layer
**Why skipped:** This is a multi-step migration that requires:
1. A key management strategy (env var? KMS? rotated?)
2. New `encrypt(plaintext)` and `decrypt(ciphertext)` helpers wrapping every column access
3. Migration of existing rows (and a way to detect already-encrypted rows)
4. Updates to every endpoint that reads/writes:
   - `job_applications.ssn` (1 endpoint)
   - `investor_applications.ein_ssn` (3 endpoints)
   - `investor_onboarding.bank_routing`, `bank_account` (4 endpoints)
   - `investor_payment_info.routing_number`, `account_number` (3 endpoints)
   - `driver_payment_info.routing_number`, `account_number` (3 endpoints)
5. PDF generators (W-9, payment info pages) need decryption hooks
6. CSV exports for investors need decryption

A bug here means investors and drivers can't access their own onboarding data. The risk profile is too high for a surgical edit. **What WAS done:** added `app.db*` and `uploads/` to `.gitignore` so the database file with plaintext PII no longer gets committed. The encryption itself is **logged as a dedicated security sprint with full migration plan and integration tests.**

### S4.2 (DONE): Add app.db*, uploads/, attachments/ to .gitignore
Database files and user uploads are now gitignored. Existing tracked files (the recent commits accidentally pulled in some) need a separate cleanup pass — see AUDIT_CHANGELOG.md.
