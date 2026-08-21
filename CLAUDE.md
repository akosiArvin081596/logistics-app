# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Deep dives — `docs/claude/`

The long-form reasoning behind the trickiest parts of this system was moved out of this file on 2026-08-18 so CLAUDE.md fits the context budget. **Nothing was reworded and nothing was dropped** — each file below is the verbatim text. The summaries in this file are enough to know that a hazard exists; **open the matching doc before changing anything it covers.**

| Doc | Covers |
|---|---|
| [`backend-server.md`](docs/claude/backend-server.md) | The complete `server.js` endpoint reference — every route, its role gate, and the reasoning behind each guard. Includes the payout ledger, month-end close, and the fuel/POI endpoints in full. |
| [`load-ingestion.md`](docs/claude/load-ingestion.md) | Both rate-con paths (n8n email + drag-and-drop) and why they must stay in lockstep; the n8n workflow's own traps (`pairedItem`, dead alert paths, the `output` column, LLM-guessed distances); rate-con reconciliation; unusable addresses. |
| [`invoice-drafting.md`](docs/claude/invoice-drafting.md) | `POST /api/loads/:loadId/draft-invoice` for all brokers — recipient resolution, order-number/total fallbacks, invoice numbering, and the **4** rate-con sources including the by-CONTENT fallback and the two rules that keep it from mailing the wrong customer's paperwork. |
| [`pii-at-rest.md`](docs/claude/pii-at-rest.md) | Why the answer was NOT encryption; the `/uploads` IDORs and the one normalizing guard; masking on read; the two audited reveal routes; what is still open. |
| [`fuel.md`](docs/claude/fuel.md) | Fuel-range honesty (the panel was ~2× optimistic), the range interval + `rangePlanningMiles`, trip planning, `ESTIMATED_BASIS_DERATE`, and gallons recovery off stored receipt images. |
| [`investor-money-math.md`](docs/claude/investor-money-math.md) | The month dimension on investor trip expenses (`investorExpenseScopeSql()`), the split-percentage resolver, and the insurance category that was absent from `GET /api/investor/report`. |
| [`truck-retirement.md`](docs/claude/truck-retirement.md) | `trucks.retired_at`, the inclusive both-ends billing interval, and the five gates that share one predicate. |
| [`user-routes-guards.md`](docs/claude/user-routes-guards.md) | `PUT`/`DELETE /api/users/:id` as finance routes — the 409 code list, the single driver-rename cascade (`DRIVER_RENAME_TARGETS`), and the `invoices.driver` case trap. |
| [`identity-collation.md`](docs/claude/identity-collation.md) | `drivers_directory.driver_name` `UNIQUE COLLATE NOCASE`, the shadow-row payroll bug, and the create-verb/409 fixes around it. |
| [`auth-setup-latch.md`](docs/claude/auth-setup-latch.md) | `POST /api/auth/setup`, the unauthenticated admin minter — the latch, `SETUP_RECOVERY_TOKEN`, and why session revocation is part of the guard. |
| [`last-login.md`](docs/claude/last-login.md) | `users.last_login_at` — why there was no history to backfill, the one choke point, and the load-bearing `try/catch`. |
| [`environment-refresh.md`](docs/claude/environment-refresh.md) | `refresh-local.sh` / `refresh-staging.sh` / `refresh-env.js` — the spreadsheet gate, telemetry trimming, and what sanitization does and does not cover. |
| [`maps-key-split.md`](docs/claude/maps-key-split.md) | Why one Maps key can never be restricted, the server/browser split, and the IPv6 egress trap. |
| [`maintenance-notice.md`](docs/claude/maintenance-notice.md) | The investor maintenance banner/popup/disclaimer — three surfaces, one flag, and the hard constraint that nothing gates. |

Other long-form docs already in the repo: `scripts/README-env-refresh.md` (env-refresh runbook), `docs/ratecon-ownership-recommendation.md`, `docs/investor-portal-copy.md` (investor-facing copy sign-off inventory), `docs/manual/technical/06-operations.md`, `docs/vps-disk-and-data-handoff.md`.

### House invariants — the rules you can break without knowing the topic exists

- **Anything that moves money ships dormant** — a new flag defaults **off** (`INVOICE_AUTOGEN_ENABLED`, `PERIOD_FINALIZE_ENABLED`, `FUEL_GALLONS_RECOVERY_ENABLED`, `MAINTENANCE_NOTICE_ENABLED`, `LINXUP_ENABLED`, `ROUTEMATE_ENABLED`, `SCANKIT_ENABLED`). **⚠️ Two deliberately default ON because they are kill switches, not enable switches: `PII_MASK_ENABLED` and `RATECON_EXTRACT_ALERT_ENABLED`.**
- **`""` means UNBOUNDED at both ends** in `truckChargeFromMonth()` / `truckChargeUntilMonth()` / `intersectMonthWindow()`. A guard that reads either `""` the other way waves through exactly the truck with the most exposure. This inversion has been corrected twice (PR #205, PR #216).
- **`getInvestorDriverSet()` answers "who is on my trucks *right now*" and has no month dimension** — never use it as an unbounded expense filter. Use `investorExpenseScopeSql()`, and remember `COALESCE(truck_unit,'') = ''` is the other half of that guard.
- **Ownership checks are MEMBERSHIP tests, not fetch-one-then-compare.** `invoices.pdf_file_name`, `investors.application_id` and `documents.file_name` have no unique index, so `.get()` can refuse the real owner and admit a stranger.
- **A guard mounted on a sub-path of a static mount does not hold.** `express.static` decodes and normalizes; a literal-path guard does not. Mount the guard where `express.static` is mounted, do your own decode → fold → collapse → `path.posix.normalize`, match the directory **case-insensitively**, and reject `..` **before** normalize.
- **Masking the NUMBER while shipping the DOCUMENT is not masking** — a masked SSN beside a base64 photo of the licence is not redaction. The same lesson had to be learned twice (API 2026-08-08, sanitizer 2026-08-13).
- **No `await` between a check and its write.** `bcrypt.hash` is hoisted above the guards in `PUT /api/users/:id` and `POST /api/auth/setup` for exactly this reason, and state must be re-read *after* the last await.
- **Never identify a Google Sheet by its title** — the VPS `logisx-staging` process uses a sheet *titled* "logisx-production". Check the ID. Production sets **no** `SPREADSHEET_ID`, so any server started without an explicit override writes to the live sheet.
- **`super_admin` is a SHARED login** — `actor` records that the account was used, never who used it. Encryption is the wrong tool for "which person read this"; masking plus an audit row is the right one.
- **SQLite timestamps on the wire**: store/serve an explicit ISO-8601 `Z` string (or wrap with `strftime('%Y-%m-%dT%H:%M:%SZ', col)`). A bare `CURRENT_TIMESTAMP` serializes zone-less and the browser parses it as local time.
- **Never PATCH an n8n credential to "test" it** — the PATCH overwrites immediately and has broken rate-con ingestion twice. And never reason about an n8n node from this file alone; read the live workflow over the API.
- **Bound every regex quantifier that runs on attacker-influenced text.** Two separate super-linear parsers have blocked the event loop for 9 s, 28 s and 113 s in production. ⚠️ Only an *internal* whitespace run is expensive; a trailing one is cheap and hides the problem.
- **Fixing one copy of a duplicated rule only resets the drift clock** — `DRIVER_RENAME_TARGETS`, `investorExpenseScopeSql()`, `truckChargedInMonth()`, `driverOwnsInvoice()` and `truckMonthlyFixed()` each exist because a hand-copied rule diverged.

### Decisions recorded so they are not re-litigated

- **Same-site CSRF is closed by a HEADER, not a token.** `requireAuth`/`requireRole` refuse a state-changing request without `X-Requested-With`; `useApi.js` sends it on every call and the two components that use raw `fetch` set it themselves. This closes what `crossSiteGuard` cannot — `refuseCrossSite` tolerates `Sec-Fetch-Site: same-site`, and `logisx.com` is a **Wix** site whose account credential lives nowhere in this repo. **⚠️ The check is DUPLICATED in both guards on purpose and must stay self-contained** (only `req`/`res`/globals): `scripts/test-db-export-guard.js` lifts `requireRole` into a bare `new Function` with nothing injected, so a shared module-scope helper throws at call time. `scripts/test-csrf-write-header.js` pins the two copies identical. `CSRF_HEADER_REQUIRED` is a **kill switch** (default ON, only `"false"` disables) for the legacy `public/` pages, which use raw fetch and are served only when `client/dist` is missing.
- **Load `209875716` is a cancelled duplicate of `30080873`** — same commodity, same 2,940 piece count, no payment, no truck, no owner. `excludeDroppedLoads()` drops it from every aggregator and its extract alert already fired once (deduped by `ratecon_extract_alerts`), so it costs nothing ongoing. **Left in place deliberately**; deleting sheet history has more downside than the row does. Do not re-investigate.
- **⚠️ The rate-con Gemini extractor is ~6-7% nondeterministic per field with the prompt unchanged** — two identical-prompt runs disagreed on 15 of 216 field comparisons, including a flipped street number. Any prompt edit must run each prompt **at least twice** and compare the disagreement *rate*, not the raw diff. Detail and the reverted PO-prompt experiment in [`docs/claude/invoice-drafting.md`](docs/claude/invoice-drafting.md).
- **PDF rendering has TWO layers of limit, and they answer different questions.** `lib/pdf-browser.js` holds the global gate — the resource ceiling over the one Chromium, bounding OPEN PAGES (the slot is released by the page's `close` event). The route-local `PDF_PREVIEW_MAX_INFLIGHT` / `INVOICE_PREVIEW_MAX_INFLIGHT` are **admission control per surface** and were deliberately NOT folded in: the first gates an *anonymous* surface, and sharing one pool would let an unauthenticated flood starve authenticated work while the global cap held perfectly.

## Commands

```bash
# Backend (Express server)
npm start            # Run server (node server.js) on port 3000
npm run dev          # Run with nodemon for auto-restart on file changes

# Frontend (Vue 3 + Vite SPA)
npm run dev:client   # Start Vite dev server on port 5173 (proxies to Express:3000)
npm run build:client # Production build to client/dist/

# Docs (Puppeteer-driven static doc/screenshot generation from scripts/docs/)
npm run docs:build       # node scripts/docs/generate-docs.js
npm run docs:screenshots # node scripts/docs/capture-screenshots.js
```

Development requires two terminals: `npm run dev` + `npm run dev:client`. Open http://localhost:5173 during development.

For production: `npm run build:client` then `npm start` — Express serves the built SPA from `client/dist/`.

`postinstall` auto-runs `cd client && npm install`, so `npm install` at root installs both backend and frontend deps.

**Repo layout & parallel dev:** the git repo root is *this* folder (the app), with sibling worktrees `LogisX-wt-1` / `LogisX-wt-2` for running parallel feature branches side by side. To run two full stacks at once, give each worktree its own ports in its `.env`: `PORT` (Express), `VITE_DEV_PORT`, and `VITE_API_TARGET` (the Express URL Vite proxies `/api` + `/socket.io` to — read in `client/vite.config.js`); leave all three unset for the default `5173 → :3000` pairing.

**Branch & PR workflow:** cut `feat/…` or `fix/…` branches off `main`; PRs target `main`, and merging to `main` is what ships to production (run the deploy command below). The `/start-task` (or `/logisx-start`) skill freshens the branch from `origin/main` and cuts a fresh feature branch; `/end-task` (or `/logisx-end`) commits, pushes, and opens/locates the PR to `main`. These skills never merge or switch branches for you.

**Deploy:** production runs on a VPS at `76.13.22.110` under `/var/www/logistics-app`, managed by pm2 (process name `logistics-app`). Standard deploy flow after merging to `main`:
```bash
ssh root@76.13.22.110 "cd /var/www/logistics-app && git checkout -- client/package-lock.json && git pull --ff-only origin main && npm install --silent --no-audit --no-fund && npm run build:client --silent && pm2 restart logistics-app --silent"
```
⚠️ **The leading `git checkout -- client/package-lock.json` is load-bearing, not tidiness.** The VPS runs **npm 10.8.2** (bundled with its Node 20.20.1) while the committed lockfile was generated by a newer npm that writes `"libc": [...]` on optional platform-specific deps. npm 10.8.2 does not know that field, so **every `npm install` on the box strips it and leaves `client/package-lock.json` permanently modified** — measured 2026-08-17: 15 deletions, `lockfileVersion` 3 on both sides, so it is pure metadata churn and nothing is broken by it. But `git pull --ff-only` **refuses to overwrite a locally-modified tracked file**, so the first PR that touches the lockfile would abort the deploy. That aborts *before* anything is installed or restarted, so it fails safe — it just looks alarming and blocks the release until someone clears it by hand. Discarding this one file is safe because npm regenerates it on the very next line and nothing reads it at runtime. **Keep the reset scoped to that one path** — a blanket `git checkout -- .` or `git reset --hard` on production could silently discard a deliberate hotfix. The alternative fixes (upgrade Node/npm on a box running 20+ other clients' processes, or switch the deploy to `npm ci`, which also needs the root `postinstall`'s `cd client && npm install` changed) both carry more blast radius than they are worth.

A staging process (`logisx-staging`) also runs on the same VPS.

**Tests & linting:** No Jest/Mocha/Vitest/ESLint configured. Integration harness at `test-suite.js` — **144** HTTP tests against a running server. Prepare fixtures first, or nearly everything fails at the login on test 2.

**⚠️ The suite WRITES — point the server at a copy, never the live sheet.** Test 46 logs an expense, so this is not a read-only harness. Production's `.env` sets **no `SPREADSHEET_ID` at all**, so `server.js` falls through to its hardcoded production default (`1ey1n0AA…`) — meaning *any* server started without an explicit override (this suite's, a helper script's, a stray `npm start`) writes to the live Dispatch Management sheet. **And never identify a sheet by its title:** the VPS `logisx-staging` process uses a sheet *titled* **"logisx-production"**. Its ID is not production — the title is a leftover from how the copy was made — but read in a hurry it says the opposite of the truth. Check the ID, never the name. The safe local copy, used in the command below, is `156Y5-OUUEZspiY7dRsJZ57iyKWLJAjdVP8a4yw0PMN0` ("Dispatch Management (LOCAL)"). Same class of accident on the port: the suite defaults to **3000, which is production on the VPS** — pass `TEST_PORT` (and the server's `PORT`) to run anywhere else.

```bash
node scripts/prepare-test-fixtures.js --yes-local-db   # sets known passwords on existing accounts
# separate terminal — the override IS the safety; without it the server uses the PRODUCTION sheet
SPREADSHEET_ID=156Y5-OUUEZspiY7dRsJZ57iyKWLJAjdVP8a4yw0PMN0 npm start
TEST_ADMIN_USER=super_admin TEST_INVESTOR_USER=johnny.rocks.spirits.llc \
  TEST_DISPATCHER_USER=amir_serrano TEST_DISPATCHER_PASS='Password123!' node test-suite.js
```
**The suite cannot be run twice inside 15 minutes** — it exhausts its own rate limiters (`exportLimiter` is 20/15min), so a second back-to-back run returns 429 across the export and statement tests and looks like a regression. Wait for the window, or compare against a run from the same cold start. Covers auth, role gating, debug-endpoint auth, webhook secret, chat file validation, canceled-load exclusion. Exits 1 on any failure. When editing `server.js`, run `node --check server.js` before committing (~18k lines; a syntax error breaks the whole app).

## Environment Setup

Required files at project root:
- `service-account-key.json` — Google service account credentials (not in git)
- `.env` — environment variables

```
SPREADSHEET_ID=<optional — Google Sheet ID for the main Dispatch Management sheet; defaults to the production sheet when unset>
ARCHIVE_SPREADSHEET_ID=<optional — Google Sheet ID for the read-only archive; defaults to the production archive when unset>
GOOGLE_DRIVE_FOLDER_ID=<Drive folder ID for POD uploads — optional, uploads skip Drive if empty>
GOOGLE_API_TIMEOUT_MS=<optional — per-request ceiling on EVERY Sheets/Drive call and the OAuth token exchange; default 15000. Applied twice and independently by node-fetch (to response headers, then over the body read), so a slow body is not charged the server's think time. A timed-out request retries on a fresh socket for GET/PUT only — never POST, which would duplicate a values.append.>
GOOGLE_SOCKET_IDLE_MS=<optional — idle timeout on FREE (pooled) sockets only; default 5000, matching Node >=19's own https.globalAgent. In-flight requests are unaffected. Do NOT raise it: that widens the window in which a stale keep-alive socket can be drawn. Both added after the 2026-08-06 dashboard outage, where a request handed to a half-open pooled socket blocked ~150 s (a TCP retransmission budget) while Google answered the same read in ~470 ms. See the note beside google.options() in server.js before changing either.>
GOOGLE_MAPS_API_KEY=<SERVER Google Maps key — every outbound call the app makes itself: Geocoding, Distance Matrix, Routes, Places (New). Restrict by IP to the VPS. Never sent to a browser.>
GOOGLE_MAPS_BROWSER_KEY=<optional — the BROWSER key, the only value GET /api/config/maps-key serves. Restrict by HTTP referrer + to Maps JavaScript/Places. Falls back to GOOGLE_MAPS_API_KEY when unset (the pre-split behaviour). See "Maps key split" below.>
GMAIL_USER=<Gmail address for sending onboarding/outreach emails>
GMAIL_APP_PASSWORD=<Gmail app password for nodemailer>
GEMINI_API_KEY=<optional — enables receipt OCR auto-fill via Gemini 2.5 Flash vision; form falls back to manual entry when unset>
GEMINI_OCR_MODEL=<optional — override the default gemini-2.5-flash model>
SCANKIT_BASE_URL=<optional — ScanKit.io API base; defaults to https://api.scankit.io>
SCANKIT_API_KEY=<optional — ScanKit.io key (sk_...) for document scanning; scanner returns 503 + raw-photo fallback when unset>
SCANKIT_ENABLED=<optional — set "true" to enable; defaults off so the feature ships dormant>
INVOICE_AUTOGEN_ENABLED=<optional — set "true" to enable the Friday 4 PM ET auto-generate-and-submit invoice batch; defaults off (moves money) so it ships dormant>
MAINTENANCE_NOTICE_ENABLED=<optional — set "true" to show investors the maintenance popup + red banner; defaults off so it ships dormant>
MAINTENANCE_NOTICE_TITLE=<optional — BANNER heading only, rendered uppercase; defaults to "SYSTEM UPDATE IN PROGRESS">
MAINTENANCE_NOTICE_MODAL_TITLE=<optional — LOGIN POPUP heading, deliberately separate from the banner; defaults to "Application is currently under maintenance">
MAINTENANCE_NOTICE_MESSAGE=<optional — supporting sentence under the heading>
MAINTENANCE_NOTICE_DISCLAIMER=<optional — the figures caveat; defaults to the client's wording, "The final settlements are still being calculated.">
MAINTENANCE_NOTICE_AUDIENCE=<optional — "investor" (default) or "all"; anything unrecognized falls back to "investor">
MAINTENANCE_NOTICE_VERSION=<optional — bump to re-show the popup to everyone who already dismissed it; defaults to 1>
FUEL_GALLONS_RECOVERY_ENABLED=<optional — set "true" to let POST /api/admin/fuel-gallons-recovery/apply write; defaults off so it ships dormant. The GET proposal works either way, so a run can be inspected in prod before it touches a finance row.>
RATECON_CONTENT_WINDOW_DAYS=<optional — default 21. How far either side of a load's own dates getRateConBytes() step 4 looks when the Drive FILE NAME does not carry our load id and it has to read the PDFs instead.>
RATECON_CONTENT_MAX_FILES=<optional — default 40. Hard cap on PDFs downloaded per miss.>
RATECON_CONTENT_CONCURRENCY=<optional — default 6. Overlapping Drive reads. ⚠️ Round trips are the cost, not bytes: a SEQUENTIAL 40-file scan measured 137 s (the whole window is 2.6 MB) against a client that gives up at 60 s. All three are COST controls, not correctness knobs — widening them scans more PDFs, it does not make a match more likely to be right.>
RATECON_INDEX_APPLY_ENABLED=<optional — set "true" to let POST /api/admin/ratecon-index WRITE the load→rate-con links it proposes; defaults off so it ships dormant. The proposal runs either way, so ~50 broker-facing links can be read in prod before any are committed.>
PORT=3000  # optional, defaults to 3000
```

Default values in `server.js` (override via env):
- Spreadsheet ID falls back to `"1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"` (production Dispatch Management — n8n writes here). Override by setting `SPREADSHEET_ID` in `.env`. Staging uses this to point at its own copy.
- Archive Spreadsheet ID falls back to `"1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI"` (read-only archive). Override via `ARCHIVE_SPREADSHEET_ID`.
- Session secret: Set via `SESSION_SECRET` env var (required for production; falls back to default for dev)

Helper scripts in `scripts/`:
- `reset-super-admin-password.js` — resets `super_admin`'s `password_hash` in a target `app.db`
  (defaults to the one beside the repo, or pass a path). Takes the plaintext from **`NEW_PASSWORD`**,
  never argv, so it stays out of shell history and `ps`; enforces a **16-char minimum**; verifies the
  bcrypt hash round-trips *before* writing; refuses unless **exactly one** row changed; then **clears
  `sessions`** so the old password's cookies stop working. Committed 2026-08-12 (PR #275) — it had
  existed untracked on the VPS since **2026-04-13**.
  - **⚠️ It fixes a FORGOTTEN PASSWORD, not a zero-Super-Admin state, so the guards it was once said to
    excuse are all still load-bearing.** It matches `WHERE username = 'super_admin'` and exits 1 with
    "no super_admin user found" when the row is gone, and it only writes `password_hash` — so it does
    **not** restore a *demoted* admin's role either. `DELETE`/`PUT /api/users/:id` refusing to remove or
    demote the last Super Admin, and `SETUP_RECOVERY_TOKEN`, remain the only cover for those two cases.
    Do not read "the script exists now" as "the guards can go."
  - **⚠️ Why the 2026-08-08 check said this file did not exist, so nobody repeats it.** It was verified
    against "the repo and the VPS checkout" — but the file was **untracked** in both. Anything that
    enumerates the repo through git (`git ls-files`, `git grep`, a tracked-file listing) reports nothing,
    and on the VPS it sits under `??` in `git status`, which is easy to read past. Its mtime is four
    months *older* than the verification that denied it. **A tracked-file query cannot answer "does this
    file exist" — stat the path.**
- `prepare-test-fixtures.js` — makes a LOCAL app.db runnable by `test-suite.js` by setting known
  passwords on the accounts that already own the test data. Refuses to touch a deployed path or
  `NODE_ENV=production`, and requires `--yes-local-db`. Deliberately does NOT wipe/reseed: loads live
  in Google Sheets, so a truncate destroys the fixture chain and cannot rebuild it.
- `seed-staging.js` — seed a staging DB.
- `refresh-env.js` + `refresh-local.sh` / `refresh-staging.sh` — rebuild LOCAL/STAGING from
  current `main` plus a trimmed, sanitized production snapshot. See "Environment refresh" below
  and `scripts/README-env-refresh.md`.
- `backup-db.js` — consistent, verified, gzipped snapshot of a LIVE `app.db` via SQLite's Online
  Backup API (a plain `cp` misses `-wal`). Driven nightly by `backup.sh` at 02:00 into
  `backups/`; those files are what the refresh scripts read.
- `geocode-loads.js` — backfill geocodes for rows in "Job Tracking".
- `generate-timeline-docx.py` / `generate-timeline-apr13-apr17.py` — one-off Python scripts rendering session-timeline `.docx` reports from HTML/markdown (needs `python-docx`).

### Environment refresh (local + staging)
`./scripts/refresh-local.sh` and, on the VPS from `/var/www/logisx-staging`, `./scripts/refresh-staging.sh --yes [--restart]`. Both bring the checkout to `origin/main`, rebuild the client, and hand the database half to `scripts/refresh-env.js`. **The source is the nightly snapshot** (`/var/www/logistics-app/backups/app.db.*.gz`), never the live production `app.db`. Full runbook in **`scripts/README-env-refresh.md`**; the full rationale, including the drift audit that motivated it, in **[`docs/claude/environment-refresh.md`](docs/claude/environment-refresh.md)**.

- **The spreadsheet gate is the load-bearing safety.** `refresh-env.js` reads the `.env` beside its `--to` target and **refuses** when `SPREADSHEET_ID` is missing or is production's — `server.js` falls through to the production sheet when it is unset, so a refreshed DB next to such an `.env` is a production writer on first boot. It checks the resolved **ID**, never the directory or sheet name. It also refuses an `.env` that can send mail or has `INVOICE_AUTOGEN_ENABLED=true`.
- **⚠️ Telemetry is trimmed to 45 days by default, and that is not a neutral shrink.** `getEldTravelDaysByVehicle()` is coverage-aware, so a window with **no** pings falls back to the **full scheduled window** — months older than the cutoff pay drivers *more* and pay investors *less*. **Never reconcile a historical month on a trimmed copy**; pass `--telemetry-all`.
- **Sanitization is asserted, not assumed** — sessions cleared, passwords re-hashed to `Password123!` (so `test-suite.js` runs with no extra step), emails rewritten to `.invalid`, bank/tax/identity/signature/consent fields redacted, onboarding `access_token`s regenerated, `driver_locations` emptied. Stage **`3h`** then sweeps **every text column of every table**, substituting routable emails in place with an HMAC `<10 hex>@invalid` (per-run salt, so cross-table rows still agree) and `###-##-####` with `000-00-0000`. A free-text hit is a **hard leak, not an advisory**.
- **⚠️ Stage 3h neutralizes exactly TWO SHAPES.** Reading "every text column of every table" as "free-text PII is handled" is itself a trap — base64 licence/medical-card documents, `city`/`state`/`zip`, and the seven phone columns are all structurally invisible to it and each needed an explicit list entry. **If a column can hold personal data in any shape that is not an email or an SSN, assume stage 3h will not save you.**
- **Not copied:** `uploads/` (unredacted PII on disk — files 404 in a refreshed environment) and the Google Sheets themselves.

Shared server-side modules live in `lib/` (required from `server.js`):
- `ifta-states.js` — US state bounding-box lookup used by the IFTA mileage classifier.
- `pdf-browser.js` — Puppeteer HTML→PDF renderer for onboarding/investor docs (why `puppeteer` is a top-level dep alongside `pdfkit`/`pdf-lib`).
- `policy-field-maps.js`, `policy-renderer.js` — field mapping + template rendering for onboarding legal documents.
- `routemate-client.js` — Routemate ELD/telematics API adapter (single point of contact).
- `linxup-push.js` — Linxup Push API v3 message mapping (pure, no network/DB): `detectMessageType()`, `normalizePosition()` (→ neutral telemetry shape), `vehicleIdCandidates()`, `speedToMps()`. server.js owns the webhook, token gate, DB insert, and geofence fan-out. See "Linxup GPS ingestion" below.
- `ratecon-load.js` — pure helpers for rate-con ingestion, now shared by **both** paths: `buildJobTrackingRow()` (header-order mapping + creation defaults), `calculateRatePerMile()` / `cityStateZip()` (ported from the n8n `Calculate RPM + Details` node — never "Calculate Rate Per Mile", which does not exist; the n8n original has since been deleted as unreachable), `extractionWarnings()`, `upsert`-support helpers. No network or DB access. Called by `POST /api/loads/from-ratecon` **and** by `POST /api/n8n/load-distance`, which is what makes the email path and the drag-and-drop path agree. See "Load ingestion" below.
  - **⚠️ `cityStateZip()` normalizes newlines to commas first, and that line is load-bearing.** Its character class was `[^,]`, which matches `\n`, so a multi-line rate-con address (`"4528 W Royal Ln\nIrving, TX 75063"` — the common shape) had its whole street swallowed into the city capture, and `Details` read `"4528 W Royal Ln\nIrving, TX 75063 - 818 Hallmark Dr\nLAREDO, TX 78045"`. Measured on the 144 production rows where the retired LLM had also answered: **118/144 (81.9%) before, 140/144 (97.2%) after**. This was the **precondition** for retiring the LLM, not a tidy-up — moving the address half onto a parser that leaks streets would have swapped a wrong distance for a wrong address. `node scripts/check-ratecon-address-parsing.js` locks it (16 cases, all verbatim production addresses, exits 1 on failure). Known residual, deliberately not chased: an address with no delimiter between street and city keeps the street — 1 of 144, and every rule that would split them guesses where a street name ends.
- `scankit-client.js` — ScanKit.io document-scanning API adapter (single point of contact; `POST /scan/crop`). See the AI/vision services note below.
- `broker-invoice.js` — invoice assembly for **every** broker: `resolveInvoiceTo()` / `resolveBrokerName()` recipient + naming, `isBisonLoad()` (now a recipient *branch*, not a gate), deterministic rate-con field extraction, and the payload shape for the Draft Invoice route. See the "Invoice drafting — all brokers" section below.
- `imap-draft.js` — `appendGmailDraft()`: writes an assembled invoice email straight into the Gmail Drafts folder over IMAP (no send), using `GMAIL_USER` / `GMAIL_APP_PASSWORD`.
- `receipt-gallons-recovery.js` — pure decision logic for recovering GALLONS onto fuel receipts that have a price and no volume: `cpgBand()`, `judgeGallonsRecovery()`, `summarizeRecovery()`. No network/DB/fs. See "Gallons recovery" below.
- `fuel-model.js` — pure fuel-range math (no network/DB): `computeRange()`, `deriveMpg()` (from ELD odometer/fuel deltas, guards refuels/tiny samples), `hasFuelSensor()` (distinguishes "no fuel sensor" from an empty tank), `estimateRangeForVehicle()`. Defaults `DEFAULT_TANK_GALLONS=200`, `DEFAULT_MPG=6.5`. Powers `GET /api/fuel/range`. Also holds the **range verification + trip-planning** math — `measureBurnRate()`, `backtestRangeFormula()`, `rangeInterval()`, `planTripFuel()`, `tripReserveMiles()`. See "Fuel range honesty" below.
- `poi-fuel-stops.js` — `findFuelStopsAlongRoute({originLat,originLng,destLat,destLng,apiKey,fetchImpl,limit})` → diesel truck stops along a route via Google Places (New) `places:searchNearby` (`includedTypes:['truck_stop','gas_station']`) at sampled waypoints; dedupes by placeId, ranks truck-stop/known-diesel-brand first, tags `aboutMilesFromRoute`. The field mask includes `places.fuelOptions`, so each stop carries a **live per-station diesel pump price** (`extractDiesel()` prefers `TRUCK_DIESEL` then `DIESEL`; `dieselPrice`/`dieselType`/`dieselPriceUpdated`, null where Google has no coverage — ~⅔ of major-chain stops do). Priced stations get a rank boost so a cheap stop survives the result cap. Powers `GET /api/poi/fuel-stops` (rate-limited by `poiLimiter`).
- `ratecon-normalize.js` — pure post-extraction hardening for multi-broker rate-cons: `normalizeRateConFields()` (money→`$X,XXX.XX`, collapse multi-line addresses, tidy phones, `None`/`""`→null), `missingCriticalFields()`, `addressLooksUsable()` / `unusableCriticalFields()`, `mergeExtractions()`. Wired into `POST /api/loads/ratecon/extract` **and, since 2026-08-09, `POST /api/n8n/extract-pdf-via-gemini`** with a second-pass Gemini nudge when a critical field is missing — see "Unusable addresses" below for why the unattended half went 151 loads without it. Paired with the hardened `RATECON_PDF_SYSTEM_PROMPT` (multi-stop first-pickup/last-drop, total-pay vs line-haul/accessorial, agent-vs-brokerage, appointment windows, ref disambiguation, injection resistance).

## Architecture

### Backend (`server.js`)
Single-file Node.js/Express server (~18,450 lines, ~185 REST endpoints). Google Sheets is the primary database (Sheets API v4); SQLite for local data; Drive API for uploads; Socket.IO for real-time. Body limit raised to 50mb for large payloads with embedded base64 photos/signatures.

**📖 The complete endpoint reference — every route, its role gate, and the reasoning behind each guard — is [`docs/claude/backend-server.md`](docs/claude/backend-server.md). Read it before touching a route.** What follows is the index.

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
- **Gemini 2.5 Flash vision** — expense-receipt OCR (`POST /api/expenses/ocr`) and rate-con field extraction. `fetch`, no SDK, with `responseSchema` enforcing the JSON shape; retry + 15 s `AbortController` timeout. Requires `GEMINI_API_KEY`, 503 + silent manual entry when unset. **The key is shared across Alchemy projects** (rotate in one place) — an exhausted key took rate-con ingestion down on 2026-08-05. Autofill surfaces: driver `ExpenseForm`, admin `ExpensesTab`, and **Bulk Upload** (`components/dashboard/expenses/BulkReceiptScan.vue`, ≤25/batch, concurrency 3). Write-timeouts are parked in a non-auto-retried `timeout` state — `POST /api/expenses` is not idempotent.
- **ScanKit.io document scanning** — server-side crop / deskew / lighting correction via `POST /api/documents/scan`, backed by `lib/scankit-client.js`. **Replaced** the client-side jscanify + OpenCV-WASM (~9 MB) scanner. Used by driver POD/BOL scanning, the admin dashboard upload, and receipt enhancement before Gemini OCR. Requires `SCANKIT_API_KEY` + `SCANKIT_ENABLED=true`; returns 503 and the client falls back to attaching the raw photo. Credit-billed (`scanKitLimiter`) — **rotate the key if it is ever exposed**.

**REST endpoint groups** — full list and per-route reasoning in the backend doc:

| Group | Paths | Must-know |
|---|---|---|
| Sheets CRUD | `/api/tabs`, `GET\|POST /api/data`, `PUT\|DELETE /api/data/:rowIndex` | DELETE is Super Admin. `?sheet=` defaults to "Job Tracking". |
| Dashboard & dispatch | `/api/dashboard`, `/api/dispatch{,/reassign,/cancel}`, `GET\|PUT /api/load/:loadId`, `DELETE /api/loads/:loadId`, `/api/loads/ratecon/extract`, `/api/loads/from-ratecon`, `/api/driver/respond` | ⚠️ **cancel is Super Admin only and requires `reason`** (≥3 chars, else 400 `CANCEL_REASON_REQUIRED`) — stored, audited, and **stripped from the public tracker** alongside `actor`. `DELETE /api/loads/:loadId` is a soft delete via `deleted_loads`. `ratecon/extract` **writes nothing**. |
| Driver | `/api/driver/:driverName`, `PUT /api/driver/status`, `/api/driver/truck-documents/:id/view`, `/api/driver/shared-documents/:id/download` | Financial columns auto-hidden for the Driver role. Truck-doc access re-checks the active `truck_assignments` row on **every** request, so reassignment revokes immediately. |
| Fleet | `/api/trucks`, `/api/truck-assignments`, `/api/trailers`, `/api/drivers-directory` | ⚠️ `POST /api/drivers-directory` is a **create** verb — 409 `DRIVER_EXISTS`, 400 `DRIVER_NAME_REQUIRED`. It was once `INSERT OR REPLACE` on a UNIQUE column, i.e. delete-then-insert. |
| Applications & onboarding | `/api/public/apply`, `/api/public/investor-apply`, `/api/applications*`, `/api/investor-applications*`, `/api/onboarding/*`, `/api/public/investor-onboarding/:id/*` | Public forms are unauthenticated + `publicFormLimiter`. PII is masked on read; two audited reveal routes exist. |
| Investors | `/api/investors`, `/api/investor/*`, `/api/investor-outreach/*`, `/api/legal-documents` | See the preview note below and [`investor-money-math.md`](docs/claude/investor-money-math.md). |
| Payout ledger & month-end close | `/api/investor/payouts*`, `/api/payouts`, `/api/periods*` | Settlement layer over `/api/investor` earnings. **Read the doc before touching** — a settled row's figure is frozen, reopening requires a reason, and "Mark Paid" is confirm-gated. |
| Messaging | `/api/messages*`, `/api/notifications/read`, `/api/dispatch-notifications`, `/api/investor/messages` | Every `dispatch-notification` stores `loadId` in `metadata` — that drives click-routing. |
| Expenses & finance | `/api/expenses*`, `/api/expenses/ocr`, `/api/expenses/fuel-analytics`, `/api/maintenance-fund`, `/api/compliance/{fees,ifta}` | Receipts re-saved under `/uploads/expense-receipts/`. |
| Invoices | `/api/invoices`, `/api/invoices/generate`, `/api/invoices/:id/{pdf,submit,approve}` | ⚠️ **`:id/pdf` and `:id/submit` are Super Admin or the owning Driver — nothing else** (issue #228). ⚠️ `test-suite.js` exercises neither, so a regression is silent. |
| Financials | `GET /api/financials` | Super Admin. Revenue counts in the month the load was **assigned**, not delivered, to match the dashboard. |
| Public tracker | `GET /api/public/track/:loadId` | No auth. **Strict whitelist** — driver name, phone, broker, rate, notes never flow through. Load-ID-only verification is an accepted client tradeoff, mitigated by `trackPublicLimiter`, the whitelist and `X-Robots-Tag: noindex, nofollow`. |
| Documents & uploads | `/api/documents/upload`, `/api/documents/:loadId`, `/api/documents/scan`, `/api/chat/attachment`, `/api/legal-documents/*` | `visibleToDriver` is only honored when `truck_id > 0`. |
| Location, maps & fuel | `/api/location` (**410 Gone** — phone GPS retired), `/api/locations/{latest,trail}`, `/api/route`, `/api/geocode*`, `/api/config/{maps-key,maintenance}`, `/api/fuel/{range,verify,trip-plan}`, `/api/poi/fuel-stops`, `/api/weather` (dead stub) | `/api/config/*` are unauthenticated **by necessity** — public surfaces load them before a session exists; treat what they serve as published. Driver-role scoping below. |
| Admin tools | `/api/admin/*` — audit-trail, fix-driver-name, scan-{duplicates,driver-mismatches,orphans,stale-locations}, fix-stale-locations, remove-rows, fuel-events, fuel-gallons-recovery, routemate/*, ratecon-reconcile — plus `/api/archive*` | Super Admin. |
| Database admin | `POST /api/db/download`, `/api/db/tables`, `/api/db/query/:table` | ⚠️ **`/api/db/download` is POST and the verb IS the control** — a GET returns 405 so it cannot fall through to the SPA catch-all. As a GET, one link a Super Admin followed dumped ~313 MB of every SSN/EIN/routing number into their Downloads. Carries `refuseCrossOriginStrict`; every refusal is audited. `dbAdminLimiter` 10/15 min. |
| Auth & users | `/api/auth/{setup-check,setup,login,logout,session}`, `/api/users*`, `PUT /api/users/:id/rating`, `/api/load-ratings/*` | ⚠️ `POST /api/auth/setup` is the **unauthenticated admin minter**, and `PUT`/`DELETE /api/users/:id` are **finance routes**. See both docs. |
| Debug | `GET /api/debug/{driver-view,driver-empty,sample-row,driver-loads,user}/…` | **No auth — dev only.** |

**Super Admin "View as investor" preview**: every `/api/investor/*` GET (plus `/api/trucks`) honors `?as_user_id=N` **only when the session user is a Super Admin and N is a real Investor's `users.id`** — `resolvePreviewUser(req)` silently falls back to the session user otherwise (no 403, no info leak). Audit-logged as `investor_preview_view`. **⚠️ Two conventions coexist**: `?as_user_id=` keys on `users.id` (this feature), `?investor_id=` keys on `investors.id` (only `/api/investor/onboarding-documents` and `/api/legal-documents`). Frontend entry `/investor-portals` → `/investor-portals/:userId`, a read-only `InvestorView.vue` wrapper; `setPreview` resets `data` + `isLoading` to prevent a stale-data flash (Pinia singleton gotcha).

**⚠️ Driver-role scoping on the fuel/POI endpoints is a security control, not a convenience.** On `GET /api/fuel/range`, `/api/fuel/trip-plan` and `/api/poi/fuel-stops` the Driver role has **both query params ignored** — the truck comes from the session `driverName` (`resolveTruckForDriverName()`) — `vehicleId` is **omitted from the response** so the enumeration key is never published, a `loadId` is **required** and `loadBelongsToDriver()`-checked (403), and any *parseable* raw coordinate param is refused so `load_coordinates` is the only coordinate source. Dispatch keeps both params and the whole fleet, because they price prospective lanes that have no load yet.

**⚠️ `poiStopsCache` is the actual cost control, not `poiLimiter`.** Each `/api/poi/fuel-stops` cache miss fans out to 4–8 billed Places calls on the Enterprise + Atmosphere SKU (~$0.16–0.32). The cache is a Map + TTL + FIFO cap (15 min, aligned to `ROUTE_CACHE_TTL`; 200 entries) sitting **after** coordinate resolution and **after** the Driver ownership check, so a hit can never bypass authorization. Keyed on the **resolved coordinates rounded to 3 decimals**, never the query string — so two loads on one lane share a fan-out and re-geocoding moves the key automatically. `limit` is not part of the key and never refetches. **Empty results are deliberately NOT cached** (an empty array is ambiguous between "no truck stops here" and "Places was briefly down").

Fuel range, trip planning and gallons recovery have their own hazards — see [`docs/claude/fuel.md`](docs/claude/fuel.md) before quoting any range number.

**Debug** (no auth — dev only). `GET /api/debug/` paths: `driver-view/:driverName`, `driver-empty/:driverName`, `sample-row`, `driver-loads/:driverName`, `user/:username`.

**Socket.IO events** (server emits):
- `load-assigned` — to specific driver when dispatched
- `load-cancelled` — to driver when dispatch cancelled
- `load-deleted` — to dispatch room when a load is soft-deleted
- `load-accepted` / `load-declined` — to dispatch room on driver response
- `status-updated` — to dispatch room on load status change
- `dispatch-notification` — to dispatch room for all dispatch events. `metadata` JSON includes `loadId` for every emitter (drives the NotificationsView click-routing below).
- `new-message` — to all on new chat message
- `pod-uploaded` — to dispatch room on document upload
- `location-update` — to dispatch room on driver GPS report
- `geofence-trigger` — to driver and dispatch room when geofence auto-triggers status
- `reload` — to all 500ms after server start (live reload during dev)

Clients emit `register` with their name to join a socket room.

**Status progression & guards**: `PUT /api/driver/status` enforces one active job — a driver can't transition to "At Shipper" with another load already active (`at shipper|loading|in transit|at receiver`) → 409 Conflict. Every change is logged to the "Status Logs" sheet (`LOG-{timestamp}`, old→new status, reason). Uses `batchUpdate` to atomically set both the status and date columns.

Session-based auth with 4 roles: Super Admin, Dispatcher, Driver, Investor. Auth middleware: `requireAuth` (401), `requireRole(...roles)` (403). First-time setup creates the initial Super Admin via `POST /api/auth/setup` — see "the unauthenticated admin minter" above before touching that route, and note the app deliberately refuses to be left with **zero** Super Admins.

**Role-based data sanitization**: `PUT /api/data/:rowIndex` preserves broker and phone contact columns for non-Super Admin users (values are read from the sheet and spliced back in before writing). `GET /api/data` strips financial columns for Driver role.

**Error handling**: All endpoints use try-catch with generic 500 JSON responses. Geofence check errors inside `POST /api/location` are caught and logged but never fail the location response.

**Rate limiting** (express-rate-limit, all `standardHeaders: true`, naming convention `{feature}Limiter`):
| Limiter | Window | Max | Scope |
|---------|--------|-----|-------|
| `publicFormLimiter` | 15 min | 10 | `POST /api/public/apply`, `POST /api/public/investor-apply` |
| `loginLimiter` | 15 min | 20 | `POST /api/auth/login` |
| `setupLimiter` | 15 min | 5 | `POST /api/auth/setup` — the only route that mints a Super Admin with no session. Tighter than `loginLimiter` because a legitimate caller uses it **once, ever**, so anything past a typo retry is abuse. Caps the burst on the one window the latch cannot close (a lost `app.db`). |
| `changePasswordLimiter` | 15 min | 5 | password change |
| `driverFilesLimiter` | 15 min | 30 | `GET /api/trucks/:id/driver-files` |
| `truckDocViewLimiter` | 15 min | 30 | `GET /api/driver/truck-documents/:id/view` |
| `trackPublicLimiter` | 15 min | 60 | `GET /api/public/track/:loadId` (customers refresh often) |
| `expenseOcrLimiter` | 15 min | 100 (Super Admin/Dispatcher) · 20 (Driver) | `POST /api/expenses/ocr` (caps Gemini spend; role-aware `max` so the admin/dispatcher bulk-receipt upload — 1 OCR call/receipt — has headroom while drivers stay tight) |
| `fuelEventsLimiter` | 15 min | 20 | `GET /api/admin/fuel-events`, `POST /api/admin/fuel-events/run` (each call re-scans telemetry synchronously). `requireRole` is mounted BEFORE it on both verbs so an unauthenticated caller can't spend the budget on 403s. |
| `fuelGallonsLimiter` | 15 min | 6 | `GET /api/admin/fuel-gallons-recovery`, `POST /api/admin/fuel-gallons-recovery/apply`. Tighter than `fuelEventsLimiter` because the unit of work differs by orders of magnitude: one fuel-events call is ~140 ms of local CPU, one call here is up to 25 **billed Gemini vision** requests. 6 is four full passes over the whole backlog. `requireRole` before the limiter, same reasoning. |
| `fuelPlanLimiter` | 15 min | 120 (Super Admin/Dispatcher) · 30 (Driver) | `GET /api/fuel/trip-plan` — **keyed per user**, same generator as `poiLimiter`. One Routes call per miss (`ROUTE_CACHE_TTL`-cached) plus indexed SQLite reads, an order of magnitude cheaper than `poiLimiter`'s billed Places fan-out, hence the looser caps. |
| `poiLimiter` | 15 min | 60 (Super Admin/Dispatcher) · 6 (Driver) | `GET /api/poi/fuel-stops` — **keyed per user** (`u:<id>`, `ip:<ip>` fallback), not per IP. Each **cache miss** fans out to 4–8 `places:searchNearby` calls on the Places **Enterprise + Atmosphere** SKU (`fuelOptions` = live pump prices, ~$40/1,000 → **~$0.16–0.32 per miss**) plus a Routes call. IP keying was actively backwards here: a dispatch office behind one NAT shared one bucket while every driver on cellular got a fresh one — the cheap callers throttled, the expensive ones not. Note per-user keying *raises* the aggregate ceiling (each dispatcher gets their own 60), which is why `poiStopsCache` below, not this limiter, is the primary cost control; the cap is the backstop on a scripted client. |

The 60s in-memory Job Tracking cache (`getJobTrackingCached()`) is the other core throttle — it absorbs bursty dashboard traffic so the Sheets 300 req/min quota isn't a real constraint day-to-day.

### Load ingestion — two paths, one shape
A load reaches Job Tracking two ways, and **they must stay in lockstep** — a load that arrived one way has to be indistinguishable from one that arrived the other.

1. **Rate-con email (original, unattended).** `info@logisx.com` receives the rate con → a Gmail filter **stars** it + applies the **`RATECONs`** label → n8n "Dispatch v2 (Fixed)" fires → Drive upload, extraction, dedupe, then writes **three tabs**. **Extraction and distance both run in the APP now, not in n8n** — `POST /api/n8n/extract-pdf-via-gemini` and `POST /api/n8n/load-distance`, authenticated with **`N8N_EXTRACT_SECRET`** (never `N8N_WEBHOOK_SECRET`, which also gates `POST /api/webhook/new-load`). Blind spot: if the email never arrives, or arrives from a sender the filter doesn't match, there is **zero signal** — no execution, no alert, no row. That is what `reconcileRateCons()` exists to catch, from outside the pipeline.
2. **Drag-and-drop (attended).** The dispatcher drops the PDF on the Job Board. `POST /api/loads/ratecon/extract` parses it and **returns without writing**; the dispatcher reviews/corrects; `POST /api/loads/from-ratecon` then replicates the n8n sequence server-side — validate load number → dedupe (409 `DUPLICATE_LOAD`) → distance + rate-per-mile → append Job Tracking → upsert Payments Table → upsert Job Details → archive the PDF → `load_coordinates` + audit + notification → `jtCacheInvalidate()`.

Gotchas that will bite you before you think to open the doc:
- **⚠️ Anchor every sheet write to column A explicitly.** `values.append` with a bare tab range lets Sheets auto-detect the anchor column from *existing* data; Job Details' column A is blank-named and Payments Table's early columns are sparse, so an appended row lands **shifted right into the wrong columns** (broker name into Payment Amount). The upserts therefore write via `values.update` at a computed `A{lastRow+1}`. A synthetic-header unit test will **not** catch this.
- **⚠️ The rate-con archive is LOCAL, not Drive, and that is what makes a dropped load invoiceable.** The production "Rate Confirmations" folder is a *My Drive* folder the service account cannot write to. `from-ratecon` writes `uploads/rate-cons/<loadId>.pdf` + a `documents(type=RATECON)` row, and only *mirrors* to Drive best-effort. Do not "fix" the archive by making Drive the primary — it will fail in prod.
- **⚠️ `POST /api/n8n/load-distance` must return a FLAT body** whose top-level keys are exactly the Job Details column names. Giving it the `{output:{…}}` envelope its sibling uses re-creates the trap that dumped 151 JSON blobs into a column literally named `output`. A Maps outage is **not an error** there — it answers 200 with `0 Miles`, and must never zero `Payment`.
- `Contract ID` on Job Tracking stays blank, and `Driver` is left blank even when the rate-con names one (dispatching is what emits the driver notification).
- Every step after the Job Tracking append is best-effort and degrades to a `warnings[]` entry — the row already exists at that point and there are no transactions.
- **⚠️ A LOAD ARRIVES AS TWO EMAILS, and one Gmail poll can carry both.** C.H. Robinson sends "Booked Load #: X" and "Navisphere Carrier Load Confirmation - Load X" for the same load. Landing in separate polls is harmless — `JOB DETAILS ENTRY`'s `appendOrUpdate` matches on `Load ID` and the second run UPDATES the first row. Landing in the SAME poll is not: the workflow runs once with two items, and `appendOrUpdate` **cannot dedupe inside its own batch** — neither item sees the row the other just appended, so BOTH append. Execution 2501 (2026-08-21) put load `564446669` on rows 433 and 434, after which it could not be dispatched at all, because the binding ladder refuses an ambiguous load id rather than guess. **87 of 308 load ids carry a historical duplicate from this**, 74 of them adjacent pairs — and nobody noticed for a year because every earlier one landed on a load that was already completed. Fixed by the **`Dedupe Loads In Batch`** Code node wired between `Validate Load ID` and `JOB DETAILS ENTRY` (keeps the LAST item per load number, which is what cross-poll overwrite already produced). `POST /api/n8n/load-distance` carries the tripwire that says it stayed fixed — it observes only, never deletes a row and never adds a response key.
- **⚠️ Never PATCH an n8n credential to "test" it** — the PATCH overwrites immediately and has broken ingestion twice.

The n8n workflow's own traps (`pairedItem` on multi-email polls, the dead errorWorkflow, the retired LlamaParse chain, the deleted LLM distance agent, the `Details` commodity-vs-route collision), rate-con reconciliation, and the unusable-address guard are all in **[`docs/claude/load-ingestion.md`](docs/claude/load-ingestion.md)**.

### Invoice drafting — all brokers (IMAP + rate-cons)
One-click "Draft Invoice Email" on any **delivered/completed** load with a POD — `POST /api/loads/:loadId/draft-invoice` (alias `…/draft-bison-invoice`) assembles the invoice + supporting docs and writes a Gmail **draft**, never auto-sends, via `lib/imap-draft.js`. Distinct from the `/api/invoices/generate` weekly-pay flow. Bison → `QPinvoicesUSA@bisontransport.com`; **every other broker → `quickpay@megacorplogistics.com`**. Broker identity resolves via `BROKER_DOMAIN_NAMES` on the email domain (the sheet has **no** brokerage-company column — `Broker Contact Name` and `Contract ID` both hold the booking *agent*). Order number falls back to the load id — **except on a BISON load, where that fallback is now a hard stop**: the route answers **422 `INVOICE_REFS_REQUIRED`** until a human supplies the Order # and PO #, because Bison AP matches on *their* number and ours reconciles against nothing. Total falls back to the sheet's `"  Payment  "` column (real surrounding spaces, exact-`payment` match only) → **422 `INVOICE_TOTAL_UNKNOWN`** rather than a `$0.00` invoice. **⚠️ `dryRun` is a QUERY param** — a body-only run creates the real draft and burns an invoice number. Full detail in **[`docs/claude/invoice-drafting.md`](docs/claude/invoice-drafting.md)**.

### Frontend (`client/`)
Vue 3 + Vite SPA with Vue Router, Pinia stores, Tailwind CSS v4, shadcn-vue components (via radix-vue/reka-ui), Vant mobile UI, Leaflet + Google Maps for maps, and Socket.IO client for real-time updates.

Key directories:
- `stores/` — auth, dashboard, sheets, driver, messages, investor, users, adminTools, dispatchNotifications, driversDb, investors, trucks, trailers, invoices, financials
- `composables/` — useApi, useSocket, useToast, usePagination, useGeocode, useGoogleMaps
- `components/ui/` — shadcn-vue primitives (badge, button, card, dialog, input, select, skeleton, table, tabs)
- `components/` — feature-organized: layout, shared, dashboard, data-manager, driver, drivers-db, trucks, investors, investor, invest, apply, users
- `views/` — 28 view components (includes the public `TrackLoadView.vue`)
- `wizard/` — JSON-driven framework for the multi-step Invest flow. `engine/WizardEngine.js` interprets a step schema from `data/`, `expressionEvaluator.js` evaluates `show-if`/`require-if` without `eval()`, `spotlight.js` drives the highlight overlay. Extend this engine for new multi-step forms instead of a bespoke stepper.

**Vite proxy** (`client/vite.config.js`): `/api` and `/socket.io` (with `ws: true`) both proxy to `http://localhost:3000`.

**Composable singletons**: `useApi()`, `useSocket()`, `useToast()` are module-level singletons (not per-component). Each Pinia store does `const api = useApi()` at module scope; `useSocket` keeps one global socket connection.

**Phone GPS retired**: As of 2026-05-13, Routemate ELD is the sole location source. `useGeolocation` was deleted; the driver app no longer requests location permission or reports pings on a real load, and the "Location Access Required" gate was removed from `DriverView`. `POST /api/location` is a 410 Gone stub so cached old clients get a clear error, not a 404. See `routemateSyncTelemetry()` for the live-position pipeline.

⚠️ **"Retired" does NOT mean `navigator.geolocation` is gone — it is still called in four places, and a `Permissions-Policy: geolocation=()` header would break all of them.** Verified 2026-08-08 while scoping a CSP; the plain-English summary above reads as if the API were unused, and acting on that reading breaks the driver app.
- `DriverView.vue` (`enablePhoneGps` / `phoneGpsWatcherId`) — a **test-only** `watchPosition` hook, gated to `PHONE_GPS_TEST_LOAD_IDS = {'LD-MP4W4LP1'}` and tagged `source:'phone-test'`. It is why the retirement is true for production loads and false for the API surface.
- `StepPersonalInfo.vue`, `LocationPickerModal.vue`, `InvestorApplyView.vue` — one-shot `getCurrentPosition` for **address autofill**, unrelated to load tracking and never retired.

**useGoogleMaps**: Loads the Google Maps JS API via `@googlemaps/js-api-loader`, fetches the API key from `GET /api/config/maps-key`.

**Optimistic updates**: Both `driver` and `messages` stores append messages locally before the API request completes.

**Mobile / admin drawer**: A shared `appShell` Pinia store exposes `isMobile` (resize-driven) and `sidebarOpen`. On mobile, `AppSidebar.vue` is a slide-in drawer with backdrop (`v-if="isMobile && appShell.sidebarOpen"`); on desktop, the persistent collapsible sidebar. New admin views should toggle it via `appShell.openSidebar()` rather than rolling their own mobile nav. Admin pages (Dashboard, Notifications, Messages, Expenses) are responsive top-down — commits `dbe9d4e`…`8e1a62d` collapse multi-pane layouts into single-pane stacks below the `md` breakpoint and swap detail tables for card lists. Vant is reserved for driver/public surfaces; admin uses shadcn-vue + Tailwind.

**Routing** (34 routes with role-based guards):

| Route | Access | Notes |
|-------|--------|-------|
| `/login` | Public | Redirects authenticated users to role home |
| `/apply` | Public | Driver application form (no sidebar) |
| `/invest` | Public | Investor application form (no sidebar) |
| `/track` | Public (`alwaysPublic`) | Customer search form — enter Load ID to track |
| `/track/:loadId` | Public (`alwaysPublic`) | Customer tracker view with stages, ETA, live map. Accessible to logged-in admins too (so dispatchers can preview what a customer sees). |
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
| `/investor-portals` | Super Admin | Index of investors — opens a read-only replica of each one's portal |
| `/investor-portals/:userId` | Super Admin | Read-only preview of a single investor's `/investor` view (banner + same components, scoped via `?as_user_id=`) |
| `/drivers` | Super Admin | Drivers directory |
| `/trailers` | Super Admin, Dispatcher | |
| `/applications` | Super Admin | Driver applications review |
| `/investor-applications` | Super Admin | Investor applications review |
| `/admin/tools` | Super Admin | Admin data tools |
| `/admin/financials` | Super Admin | Company P&L view |
| `/admin/fleet-health` | Super Admin, Dispatcher | Routemate ELD fleet health — fault codes, DVIR, telemetry status |
| `/archive` | Super Admin | Archived data viewer |

Auth guard calls `checkSession()` on first navigation only (blocks until resolved); later navigations use cached `isAuthenticated`. Unauthorized users redirect to `auth.roleHome` (Driver → `/driver`, Dispatcher → `/dashboard`, Investor → `/investor`).

Routes flagged `meta: { alwaysPublic: true }` (only `/track`, `/track/:loadId`) bypass the "authenticated → roleHome" redirect that applies to `/login`/`/apply` — so a logged-in dispatcher can preview the tracker.

### Legacy Frontend (`public/`)
Original vanilla HTML/CSS/JS pages, kept as the `public/` fallback (see Static file serving above).

## Key Conventions

- **Row indexing**: Row 1 = headers, row 2+ = data. API uses 1-based row indices. Each data object includes `_rowIndex`. DELETE internally converts to 0-indexed for Sheets `batchUpdate` `deleteDimension` (`startIndex: rowIndex - 1`).
- **Sheet selection**: All data endpoints accept `?sheet=` query param; defaults to "Job Tracking".
- **Value format**: POST/PUT bodies use `{ values: ["col1", "col2", ...] }` with `valueInputOption: "USER_ENTERED"` (supports formulas).
- **Column detection via regex**: Both backend and frontend match headers dynamically with regex patterns — `/driver/i` for driver columns, `/rate|amount|revenue|pay|charge|price|cost/i` for financial columns (hidden from Driver role), `/status/i` for status, `/load.?id|job.?id/i` for load IDs, `/origin.*lat|pickup.*lat/i` and `/dest.*lat|delivery.*lat/i` for coordinates. This makes the system flexible to different sheet column names.
- **Driver fields**: Any column matching `/driver/i` renders as a `<select>` populated from the first driver-like column in "Carrier Database".
- **Role-based routing**: Super Admin sees all, Dispatcher sees dashboard+data (no broker/financial info), Driver sees driver app (no sidebar), Investor sees financial view + truck fleet.
- **Geofence logic**: `tryGeofenceAdvance()` (from `routemateSyncTelemetry()`) uses `geolib.isPointWithinRadius()` with a **3218.69 m (2 mile) threshold** on each ELD ping — env-tunable via `GEOFENCE_RADIUS_M`, raised from 1000 m on 2026-08-06 at the client's request (of the first two automatic status changes ever recorded, one fired at 881 m against the old zone). Two consequences to know: **`load_status_history.reason` is a mixed-radius audit log** — rows before that date legitimately read `(radius 1000 m)` and are not rewritten; and a load **shorter than the radius** would strand at "At Shipper" (the truck never exits the pickup circle, so `In Transit` never fires, and `At Receiver` needs `in transit` as its predecessor) — the departure check therefore *also* accepts "moving and now closer to the delivery than to the pickup". Do not remove that second clause. Auto-advances only when current status matches the expected predecessor (Dispatched/Assigned/Heading to Shipper → At Shipper, **At Shipper/Loading → In Transit on departure**, In Transit → At Receiver); **never auto-writes a completion status**. Errors caught silently; emits `geofence-trigger` + `dispatch-notification`. Phone-GPS path (`POST /api/location`) is retired (see above).
  - **⚠️ Coordinates come from `load_coordinates`, NOT the sheet.** `checkGeofence()` prefers Job Tracking lat/lng columns, but **that sheet has no coordinate columns** (26 columns, none of them lat/lng) — so from the feature's introduction until 2026-08-05 it returned `[]` on every ping and geofencing **never fired once** (0 rows of `source='geofence'` against 197 manual status changes) while looking fully implemented. `resolveGeofencePoints()` now falls back to the `load_coordinates` table, which is where the data actually lives. Do not "simplify" this back to sheet-only.
  - **Coverage is the other half.** `load_coordinates` is filled only opportunistically — at `POST /api/loads/from-ratecon`, or by `GET /api/geocode/load/:loadId` when a human opens the map. **n8n-ingested loads get no row until someone looks at them**, so geofencing would stay dead for exactly the loads nobody is watching. `ensureLoadCoordinates()` geocodes once from the addresses already on the cached sheet row on first ping (best-effort, `geocode_cache`-backed, never throws). Row keys are inconsistent (`513987502` vs `#513987502`), so `getLoadCoordsRow()` tries both forms.
  - **Departure = time-out.** Arrival alone gives a time-IN only, which is why detention was invisible. Departure fires when the previous clean fix was inside the pickup zone, the current fix is outside, speed > `GEOFENCE_DEPART_SPEED_MPS` (2.235 m/s — the same "traveled" threshold the driver-pay active-day basis uses), and status is `at shipper|loading`. **Pickup-only by design**: leaving the receiver would mean "delivered", and completion stays manual because POD depends on it. Arrival hysteresis (previous fix also inside) is skipped for departures — a departure has already proven the previous fix was inside, so re-checking would require being in and out of the zone at once.
  - **Time in / time out needs no new storage**: `load_status_history` stamps each transition and `computeStatusPhases()` derives started/ended/`durationMs` per phase. At Shipper → In Transit *is* the shipper detention window.
  - **Every active load of a driver is evaluated, not just the first.** Queueing is supported (`POST /api/dispatch`), so a driver routinely carries two. The old `if (!loadIdByDriver[d])` first-match was **sheet row order = rate-con arrival order**, so the *oldest* load held the slot until completed and starved the load actually being driven — a row left sitting in `Dispatched` blocked automation on everything after it. Both location paths (Routemate poller **and** the Linxup webhook) now build a driver→loads list, sort by `statusProgressRank()` (most-progressed first), and `break` on the first advance so one ping writes at most one transition. Safe because `tryGeofenceAdvance` only advances from a valid predecessor, so two loads cannot both fire for one zone. **`loadIdByDriver` itself is deliberately left first-match** — the public-tracker fan-out (`publicTrack.to("load:"+activeLoadId)`) depends on that single-id shape, and changing it would alter customer-facing tracking as a side effect.
  - **⚠️ Pass `speedMps` from every location source.** The Linxup webhook path originally omitted it, which would have silently disabled departure detection (and with it the time-out half of detention) the day Linxup replaced the poller.
- **ETA calculation**: Uses `geolib.getDistance()` to destination. Default speed: 24.587 m/s (~55 mph) when GPS speed is unreliable. Compares ETA vs scheduled delivery to flag "on-time" / "delayed".
- **IFTA state matching**: Hardcoded bounding boxes for ~24 US states to classify driver GPS pings by state.
- **Sheet ID caching**: Google Sheet tab GIDs are cached in a `Map` in memory to avoid repeated API lookups. Lazy-initialized via `getSheetId()`.
- **Geocode caching**: Geocode results are cached in the `geocode_cache` SQLite table to avoid redundant Google Maps API calls.
- **No transactions**: Multi-step operations (update sheet + append log + emit socket) are not atomic. Network failures mid-operation can leave data inconsistent.
- **Onboarding documents**: driver and investor onboarding use seeded lists (`ONBOARDING_DOCS`, `INVESTOR_ONBOARDING_DOCS`) with PDF generation + e-signature capture.
- **Audit trail**: Admin actions (user creation, driver rename, etc.) are logged to the `audit_trail` table.
- **Load exclusion is centralized**: every load-revenue aggregator (`/api/dashboard`, `/api/financials`, `/api/investor`) runs sheet data through `excludeDroppedLoads(rows, headers)` before any math. It drops (a) rows whose status matches `CANCELED_STATUS_RE = /^(cancel|canceled|cancelled)$/i` and (b) rows whose `load_id` is in the `deleted_loads` table. Keep this the single place deciding "is this load live?" so dashboard/financials/investor stay consistent. `POST /api/invoices/generate` reads the sheet directly (not via this helper), so it applies its own `getDeletedLoadIds()` filter to avoid billing soft-deleted loads — keep in sync.
- **Driver "active days" = completed loads ∩ ELD travel** (driver-pay basis, shared by `/api/investor`, `/api/financials`, `POST /api/invoices/generate`): an *active day* counts only when the assigned truck **traveled** that day **and** the day is inside a **completed** load's pickup→delivery window. "Traveled" = a clean `routemate_telemetry` ping (`dropped_reason=''`) with `speed > 2.235` m/s (~5 mph). Computed by the module-scope helper `getEldTravelDaysByVehicle(vehicleIds, minMs, maxMs)` → `{ vid: { travel: Set<"YYYY-MM-DD">, coverage: Set } }`; each ping is bucketed into the **truck's local day** (zone derived per-ping from longitude via `usTzForLongitude` → continental-US IANA zone, DST-aware via `Intl`), so late trips land on the worked day, not the server's UTC day. Window days are bare wall-clock dates from the sheet (`fmtDate`/`expandDateRange`), matching the truck-local travel days. (US-centric; falls back to Central when longitude is missing.) Load truck→vehicle map: `trucks.routemate_vehicle_id` (matched on `LOWER(unit_number)`). **Coverage-aware fallback**: a window with *no* ELD pings (truck unlinked or load predates the feed) falls back to the full scheduled window so historical/un-instrumented pay is never zeroed; a covered-but-*parked* window yields 0. Daily rate = the truck's `trucks.driver_pay_daily` (falls back to `$250`; invoices used to hardcode `$250`). Only `completedStatuses` (`/^(delivered|completed|pod received)$/i`) count — the old broad `activeWorkStatuses` is gone, so deadhead, in-progress, and parked days are excluded. `parseSheetDate` (investor/financials) accepts ISO `YYYY-MM-DD` and US `M/D/Y`. Each driver-month is tagged `source: eld | mixed | estimated`; `EarningsSection.vue` renders an "ELD-verified / partly / estimated" badge. **Keep all three endpoints in lockstep** so investor portal, Financials P&L, and weekly invoice reconcile. (Invoices clip the window to the Sat–Fri billing week.)
- **Two soft-delete patterns coexist**, by design — pick the right one for new tables:
  - **Separate `deleted_loads` table** (load_id keyed): the canonical row lives in Sheets, not SQLite. Query: `LEFT JOIN deleted_loads ... WHERE deleted_loads.load_id IS NULL`. Recovery: `DELETE FROM deleted_loads WHERE load_id = ?`.
  - **`deleted_at` timestamp column** on the source table: used by `job_applications` (listings filter `WHERE deleted_at IS NULL`; `?include_deleted=true` for admin recovery). Cheaper (no join), but only works when the table lives in SQLite.
- **Notification click routing**: every `dispatch-notification` emitter stores `loadId` in the row's `metadata` JSON; admin `NotificationsView` parses it → `router.push('/dashboard?load=<loadId>')`. `DashboardView` reads `route.query.load`, switches to Active Loads, passes `focusLoadId` into `ActiveLoadsTab`, which auto-opens that load's modal then emits `focus-consumed` to clear the query.
- **SQLite timestamps on the wire**: `CURRENT_TIMESTAMP` is UTC but serializes zone-less (`"2026-04-20 14:30:00"`), which JS parses as local time. When exposing DB timestamps, wrap with `strftime('%Y-%m-%dT%H:%M:%SZ', created_at)` so the client can `new Date(ts)` correctly. `/api/dispatch-notifications` does this; follow it for new endpoints surfacing `created_at`.

## Google APIs

- **Sheets API v4**: Primary database. Rate limit 300 req/min. `valueInputOption: "USER_ENTERED"`.
- **Drive API v3**: POD/document uploads to a shared folder (`GOOGLE_DRIVE_FOLDER_ID`). Photos → PDF via pdfkit before upload.
- **Maps APIs**: Routes (v2 `computeRoutes`), Geocoding, Distance Matrix, Places (New) — route calc, address lookup, geocode caching, diesel POI. All **server-side**, on `GOOGLE_MAPS_API_KEY`.

### Maps key split — one key cannot be restricted, two can
`GET /api/config/maps-key` publishes a Maps key to every visitor, by necessity: `/apply`, `/invest` and the public `/track/:loadId` tracker all load a map before a session exists. So the **only** thing between that key and an arbitrary bill is a Google Cloud restriction. Audited 2026-08-08: there was **none** — no application restriction and no API allowlist, verified empirically. Full audit, evidence and n8n history in **[`docs/claude/maps-key-split.md`](docs/claude/maps-key-split.md)**.

- **⚠️ The two restriction types are mutually exclusive, which is why one key can never be locked down.** A referrer-restricted key is refused outright by the legacy web services and, having no `Referer` to match, by Routes/Places (New) too — it breaks **every server call**. An IP-restricted key cannot drive the Maps JavaScript API — it breaks **every map**. Anyone "just adding a referrer restriction" to the shared key takes the dashboard, tracking, geocoding and rate-per-mile down at once.
- **The split**: `GOOGLE_MAPS_API_KEY` = server key (IP-restricted to the VPS; Geocoding + Distance Matrix + Routes + Places New). `GOOGLE_MAPS_BROWSER_KEY` = browser key (referrer-restricted; Maps JavaScript + Places) and the **only** value the endpoint serves. Unset → falls back to the server key, so deploying the split changes nothing until a second key exists. This also moves the expensive `places:searchNearby` SKU off the published key.
- **⚠️⚠️ The VPS talks to Google over IPv6, so an IPv4-only allowlist breaks everything.** `76.13.22.110` is the address the box is *reached* on, not the one it *leaves* from — both curl and the Node runtime egress from **`2a02:4780:59:f4fb::1`**. An allowlist containing only the IPv4 address would silently 403 **every** Maps call in production. Allowlist **both**, and re-check after any VPS network change.
- **⚠️ A referrer restriction is anti-scraper, not anti-attacker** — `Referer` is client-supplied and forgeable. The real spend ceiling is the **API allowlist plus per-API quota caps and a budget alert**.
- **n8n no longer calls Maps at all.** The `Get Distance Matrix` node held a **plaintext** key and was deleted live 2026-08-09 (45 → 43 nodes), so the server key can now be IP-restricted without breaking email-ingested rate-per-mile — the app computes it via `calculateRatePerMile()`. **⚠️ That key must still be rotated: deletion is not revocation**, and n8n Cloud's internal workflow history is not readable over the public API.
- `GET /api/weather` is **dead twice over** — it calls a `weather.googleapis.com` path that does not exist, and nothing calls it (`TrackingMap.vue`'s fetch is disabled to reduce API cost). Kept as a stub. The Weather API does **not** belong on either allowlist.

## Routemate ELD / telematics integration

Replaces phone-based driver GPS. Routemate is FMCSA-certified ELD hardware in trucks; LogisX pulls from their cloud REST API.

**Adapter:** `lib/routemate-client.js` — single point of contact. Auth via `X-Api-Key`. Retry/backoff + 15s `AbortController` timeout mirror the Gemini OCR pattern. Returns normalized objects so a future API change ripples through one file. Every server-side caller goes through it; no other module talks to Routemate directly.

**Env vars** (defined in `.env.example`):
- `ROUTEMATE_BASE_URL` (default `https://cloud.routemate.ai`)
- `ROUTEMATE_API_KEY` — sent as `X-Api-Key`
- `ROUTEMATE_ENABLED` — master kill switch. When `false`, all sync intervals are dormant and the manual probe returns 503. **Default off** until the key is wired in production.
- `ROUTEMATE_POLL_LIVE_SEC` (default 60) — used by Phase 2 live-telemetry sync
- `ROUTEMATE_POLL_FAULTS_SEC` (default 300) — Phase 5 fault-code sync
- `ROUTEMATE_POLL_DAILY_HOUR` (default 4) — Phase 3+ daily rollups

**SQLite tables** (Phase 1, all `IF NOT EXISTS` — additive, reversible):

| Table | Purpose |
|---|---|
| `routemate_vehicles` | Local mirror of Routemate vehicle inventory (synced via `POST /api/admin/routemate/sync-now`). Fields: `routemate_vehicle_id` (UNIQUE), `vehicle_id`, `vin`, `make`, `model`, `year`, `fuel_type`, `eld_id`, `gps_ids` (JSON), `license_num`, `state`, `active`, `raw_json`, `last_synced_at`. |
| `routemate_telemetry` | Live GPS feed, append-only. Fields: `routemate_vehicle_id`, `latitude`, `longitude`, `speed`, `bearing`, `odometer`, `engine_hours`, `fuel_pct`, `geocoded_location`, `location_date_ms` (epoch ms from Routemate), `fetched_at`. Also the driver-pay "active days" source — see that convention. |
| `routemate_fault_codes` | One row per active code per vehicle, UNIQUE on `(routemate_vehicle_id, code)`. Fields: `code`, `status`, `first_seen`, `last_seen`, `ack_by_user_id`, `ack_at`. |
| `routemate_dvir` | DVIR inspection reports per vehicle, UNIQUE on `dvir_id`. |
| `routemate_fuel_daily` | Telemetry-derived MPG rollup, UNIQUE on `(routemate_vehicle_id, date)`. Phase 4. |
| `routemate_hos_daily` | Driver duty-time rollup, UNIQUE on `(driver_id, date)`. Phase 3. |

**`trucks` table** gains one additive column via the existing try/catch ALTER pattern: `routemate_vehicle_id TEXT DEFAULT ''`. Set by admins via the Trucks UI (Phase 2) to link a LogisX truck to a Routemate vehicle.

**`driver_locations`** retains historical rows but is no longer written or read by any endpoint as of 2026-05-13. `GET /api/locations/latest` and `/api/locations/trail` now source exclusively from `routemate_telemetry`; responses tag `source: 'routemate'` with an ELD fix, else `'none'`. The 90-day purge job still ages the legacy data out.

**Phase 1 endpoints** (only ones live as of foundation):
- `POST /api/admin/routemate/sync-now` — Super Admin only. 503 when `ROUTEMATE_ENABLED=false` or key unset; else `getCompany()` smoke test, then paginates `listVehicles()` and upserts into `routemate_vehicles`. Logs `audit_trail` action `routemate_sync`.
- `GET /api/routemate/health` — Super Admin only. Returns `{enabled, hasKey, baseUrl, lastSync, lastError, errorsLast24h}`.

**No webhooks in Routemate v0** — pull-only. Phase 2+ uses `setInterval` patterns like `setInterval(purgeOldDriverLocations, ...)` (server.js:726). All gated by `ROUTEMATE_ENABLED`.

~~**Demo viewer** is blocked from `/api/admin/routemate/sync-now` by the global write-lockdown middleware (server.js:~1630).~~ **Stale — the `demo_viewer` account and its lockdown middleware were deleted 2026-08-04** (see the tombstone comment in `server.js`, and "demo_viewer removed"). There is **no** global write-lockdown middleware today; do not assume a new admin write route inherits one.

**Spec reference:** OpenAPI 3.0.1 at `https://cloud.routemate.ai/v3/api-docs` (public, no auth). Doc viewer `https://cloud.routemate.ai/open-api.html` is JS-rendered Redocly. Path prefix `/api/v0/`.

## Linxup GPS ingestion (webhook push)

**Linxup is the fleet GPS/telematics provider going forward, replacing the Routemate *poll* model.** (Apollo ELD — the `feat/eld-apollo-migration` provider-neutral effort — was evaluated for driver **HOS only** and dropped for GPS; Linxup won live tracking.) The defining difference from Routemate: **Linxup PUSHES** telemetry to us — there is no base URL, no poll cadence, and no `setInterval`. Linxup POSTs each message to our webhook; we validate a shared secret and ingest.

**Endpoints:**
- `POST /api/eld/linxup/webhook` — inbound push. **Token-gated** (`safeEqual` constant-time compare against `LINXUP_WEBHOOK_TOKEN`): the token is read from `Authorization: Bearer`, `X-Api-Key`, `X-Webhook-Token`, or `X-Linxup-Token` headers, or `?token=`. Returns **503** when the token is unset (not configured), **401** on mismatch, **200** `{ok, received, enabled}` on success. **ACKs fast, ingests async** (`res.json()` then `setImmediate`) so a slow sheet/geofence read never makes Linxup time out and re-deliver. Accepts a single message OR an array (`body`, `body.messages`, or `[body]`).
- `GET /api/eld/linxup/health` — **Super Admin only**. Returns `{provider:'linxup', enabled, hasToken, speedUnit, lastReceived, lastWritten, lastError, messageCounts, unlinkedPositions}`. **Never echoes the token** (`hasToken` boolean only).

**Mapping & storage:** `lib/linxup-push.js` is pure message-shape mapping. Each pushed message is classified structurally by `detectMessageType()` (the Push API carries no explicit type field) — Position, Trip, Stop, Usage, Geofence, Alert, Media, etc. **Only `Position` feeds tracking in v1**; other types are recognized + counted (`messageCounts`) so the receiver can ACK, but not written. A Position → `normalizePosition()` → the neutral telemetry shape, which server.js inserts into **`routemate_telemetry`** (the existing live table that tracking **and** the driver-pay "active days" basis already read) with `source:'linxup'` and **speed converted mph→m/s** (`speedToMps`, unit from `LINXUP_SPEED_UNIT`). It reuses the poller's quality gates (invalid-coords / speed-outlier tagged via `dropped_reason`) and the same `location-update` + `tryGeofenceAdvance()` fan-out, so tracking/pay/geofence behave identically to the Routemate path.

**Truck linkage:** a Position carries several stable ids (`tracker.trackerId`, `tracker.deviceNumber`, `tracker.deviceSerialNumber`, `asset.vin`); `vehicleIdCandidates()` returns them in that preference order and the receiver matches **any** of them against **`trucks.routemate_vehicle_id`** (the existing link column — unchanged) to resolve the truck + active driver. Unmatched positions are still stored (first candidate) so no data is lost; they just don't map to a truck until it's linked, and increment `unlinkedPositions`.

**Env vars** (in `.env.example`):
- `LINXUP_ENABLED` — master write switch. **Default off.** When false the token gate is still enforced but positions are recognized/counted only, never written → ships **dormant** (matches `ROUTEMATE_ENABLED` / `SCANKIT_ENABLED`).
- `LINXUP_WEBHOOK_TOKEN` — shared secret Linxup presents on every push. Unset → webhook 503.
- `LINXUP_SPEED_UNIT` — `mph` | `kmh` | `mps`, default `mph`.

**⚠️ LIVE-CAPTURE (confirm against the first real push):** two fields are inferred from the Push API V3 doc, not a real payload — the **speed unit** (assumed mph; a wrong guess silently mis-pays drivers via the `speed > 2.235 m/s` travel gate) and the **exact auth header** Linxup uses (we accept several defensively). Both are flagged in `lib/linxup-push.js`; lock them down once a live push is seen. **Docs:** Push API V3 PDF (`PushAPIV3.pdf`, 25-page message catalog: Position/Trip/Stop/Usage/Geofence/Alert/Media).

## House rules

**⚠️ `.claude/rules/` does not exist in this repo** (verified 2026-08-18) — earlier revisions of this file described it as present, so do not go looking. If generic team guidelines are ever reintroduced there, treat them as defaults and let **this repo's reality override them where they conflict**: those rules called for "many small files (<800 lines)" and "TDD with 80%+ coverage", whereas the backend is a deliberate ~18k-line single-file `server.js` and there is **no test framework** — only the `test-suite.js` HTTP harness plus the standalone `scripts/test-*.js` assertion runners. Follow the surrounding code's established patterns.

Two conventions do apply everywhere: **conventional-commit messages** (`feat:`/`fix:`/`refactor:`/`docs:`/`test:`/`chore:`/`perf:`/`ci:`) and **parameterized SQLite queries**.
