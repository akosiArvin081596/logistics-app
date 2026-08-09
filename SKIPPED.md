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

---

## Sprint 5 — Dependency advisories: the 4 that remain, and why

PR #213 took `npm audit` from 29 advisories to 8, entirely inside the declared semver
ranges. A follow-up pass then cleared 3 more (2 high + 1 that #213 had mis-assessed).
**4 moderate advisories remain, all in one chain, and they are deliberately not fixed.**

Re-verify with `npm audit`; do not re-litigate from the advisory text alone — every
verdict below was reached from *this app's* call sites, not from the CVSS score.

### S5.1: `uuid` / `gaxios` / `googleapis-common` / `googleapis` (4 moderate) — UNREACHABLE, and the fix is worse than the bug
**Advisory:** GHSA-w5hq-g745-h8pq — missing buffer bounds check in `uuid` **v3/v5/v6 when `buf` is provided**.

**Why it cannot fire here** (three independent reasons, each sufficient):
1. There are exactly **two** `uuid` consumers in the whole tree — `gaxios/build/src/gaxios.js:63`
   and `googleapis-common/build/src/apirequest.js:20`. Nothing else, and the app never
   requires `uuid` directly.
2. Both call **`v4()`**, not v3/v5/v6 — three call sites, all `const boundary = v4()`
   (gaxios.js:417, apirequest.js:152 and :190). A grep for `v3(`/`v5(`/`v6(` across the
   installed tree returns **nothing**.
3. All three calls pass **zero arguments**, so `buf` is `undefined` and `v4()` takes its
   `crypto.randomUUID()` fast path — it never reaches the byte-copy loop the advisory
   describes.

**⚠️ Do NOT "just bump googleapis" — 128 → 174 breaks the PR #190 outage fix, silently.**
The only npm-offered fix is `googleapis@174`, which pulls `googleapis-common@8`
(pins `gaxios: "7.1.3"` exactly) and `google-auth-library@10.5.0` (`gaxios ^7.0.0`), so
gaxios 7 is not optional and gaxios 6 cannot be pinned underneath.

gaxios 7 moved **node-fetch v2 → v3**, and node-fetch v3 *removed* the `timeout` option, so
gaxios reimplemented it with `AbortSignal.timeout()`. That is precisely what the comment
beside `google.options()` in `server.js` forbids: *"The timeout MUST NOT be an
AbortController… Do not 'modernise' this into `signal`."* gaxios refuses to retry an
aborted request.

Measured against a server that accepts the connection and never answers — the exact shape
of the 2026-08-06 dead-keep-alive-socket outage:

| | TCP connections | `onRetryAttempt` calls | error |
|---|---|---|---|
| gaxios 6.7.1 (current) | **3** | 2 | `network timeout at: …` (node-fetch v2 `FetchError`) |
| gaxios 7.3.0 (googleapis 174) | **1** | **0** | `The operation was aborted.` (node-fetch v3 `AbortError`) |

PR #190's fix has two halves. **Prevention** (bound the hang to `GOOGLE_API_TIMEOUT_MS`
instead of a ~150 s TCP retransmission budget) survives the upgrade. **Containment** —
retry on a fresh socket, the half that actually keeps the user's page working — is lost.
A dashboard request that drew a stale pooled socket would return a hard error at 15 s
instead of transparently succeeding on retry in ~470 ms.

**The regression is silent**: gaxios 7 still declares `timeout?: number` and still accepts
the function-form `agent` (`agent?: Agent | ((parsedUrl: URL) => Agent)`, which
`googleAgentFor` relies on), so `google.options({timeout, agent, retryConfig})` still
type-checks and still merges. `retry` / `noResponseRetries` / `httpMethodsToRetry` (the
POST exclusion that stops a retried `values.append` duplicating a load) all still work.
Only the retry-on-timeout is gone, and nothing errors to tell you.

Everything else about the upgrade is clean, which is what makes it tempting: the Sheets v4
and Drive v3 surfaces are unchanged, `googleapis@174` is still CJS, and
`googleapis-common@8` drops `uuid` outright (so the advisory genuinely closes rather than
merely moving). The blocker is this repo's unusually specific dependence on node-fetch v2
timeout semantics.

**If it is ever revisited**, the prerequisites are: (a) confirm the VPS runs Node ≥ 18
(googleapis 174 requires it; 128 required ≥ 14), and (b) restore retry-on-timeout — either
a `fetchImplementation` that surfaces a `TimeoutError` gaxios will retry, or an explicit
retry wrapper — and *prove it* with the connection-count experiment above. Also update the
`GOOGLE_API_TIMEOUT_MS` note in `.env.example`, which becomes factually wrong the moment
gaxios 7 lands (one total deadline, not two independent per-phase budgets).

**An `overrides: { "uuid": "^11.1.1" }` was evaluated and NOT taken.** It is technically
viable — uuid 11 still ships CJS (`require: ./dist/cjs/index.js`) and `v4()` no-arg was
verified to work — and it would clear all 4 advisories without touching googleapis. It was
rejected because it lands on the **multipart upload** path (`v4()` is only ever the
multipart boundary), and that path **cannot be exercised locally**: `drive.files.create`
with media returns *"Service Accounts do not have storage quota"*, and the production
"Rate Confirmations" folder is not writable by the service account either. An untestable
change to the datastore spine, bought to silence a provably unreachable advisory, is a bad
trade. Not the same call as #213's `pdfjs-dist` refusal — that override would have been
*ineffective*; this one would be effective but unverifiable.

### S5.2 (DONE, and #213's assessment was wrong): `picomatch` 2.3.1 → 2.3.2
#213 recorded *"2.3.1 **is** the last 2.x — the fix is a major under `anymatch`."* It is
not. **`picomatch@2.3.2` exists** and is exactly the patch both advisories name
(GHSA-3v7f-55p6-f55p and GHSA-c2c7-rcm5-vvqj, both `<2.3.2`). `anymatch@3.1.3` declares
`picomatch ^2.0.4` and `readdirp@3.6.0` declares `^2.2.1` — **2.3.2 satisfies both**, so
this was an in-range fix all along, needing no override and no major bump. `npm update
picomatch` changed exactly one lockfile line. Two **high** advisories closed.
(It was dev-only regardless — `nodemon → chokidar → anymatch`, `dev: true` in the lockfile,
and production runs `node server.js` under pm2 — but "dev-only" was never the reason it
was unfixable.)

### S5.3 (DONE): `nodemailer` 8.0.11 → 9.0.5
GHSA-p6gq-j5cr-w38f (*the message-level `raw` option bypasses `disableFileAccess` /
`disableUrlAccess`*) is **unreachable here** — confirmed, but on stronger evidence than the
advisory text. `raw` is consumed at `nodemailer/lib/mail-composer/index.js:34`
(`if (this.mail.raw)`), and all three places this app builds a message use **literal keys
with no spread**, so no caller-supplied property can become `raw`:
`server.js:3355` (`sendEmail()`), `server.js:6804` (investor outreach), and
`lib/imap-draft.js:28` (MailComposer for Gmail drafts). Neither
`disableFileAccess` nor `disableUrlAccess` appears anywhere in the codebase.

The upgrade was taken anyway, because nodemailer 9.0.0's **only** breaking change is TLS
certificate validation on **remote content fetching** — attachment `href`/URL, OAuth2 token
endpoints, and HTTP/HTTPS proxy CONNECT. This app uses none of those: every attachment is a
local `path:` built server-side (`server.js:5453`, `:6904`, `:11423`), auth is plain Gmail
user/password, and there is no proxy. 9.0.1–9.0.5 also harden SMTP header handling, which
matters for the outreach route since it passes an admin-supplied `subject` straight through.

Verified before/after with a harness covering all three real message shapes: **MIME output
byte-identical**, `service:'gmail'` still resolves `smtp.gmail.com:465 secure`, and a real
SMTP conversation against a throwaway local server was identical (same `accepted`, same
661 data bytes, attachment base64 present, `AUTH PLAIN` negotiated and accepted).
