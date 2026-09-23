# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Deep dives — `docs/claude/`

The long-form reasoning behind the trickiest parts of this system was moved out of this file on 2026-08-18 so CLAUDE.md fits the context budget. **Nothing was reworded and nothing was dropped** — each file below is the verbatim text. A second move on 2026-09-23 (the rows from `ci-deploy.md` down, plus two nested files) also dropped the pinned counts — regenerate them — and corrected claims that had gone stale. The summaries in this file are enough to know that a hazard exists; **open the matching doc before changing anything it covers.**

Two nested files load on their own: Claude Code reads [`client/CLAUDE.md`](client/CLAUDE.md) (the Vue frontend) and [`lib/CLAUDE.md`](lib/CLAUDE.md) (the shared server modules) when it opens files in those directories. Code comments that cite "CLAUDE.md" predate the split — the passage they mean may now live in any of these files, so grep them all.

| Doc | Covers |
|---|---|
| [`backend-server.md`](docs/claude/backend-server.md) | The complete `server.js` endpoint reference — every route, its role gate, and the reasoning behind each guard. Includes the payout ledger, month-end close, and the fuel/POI endpoints in full. Since 2026-09-23 also the SQLite tables, the endpoint-group table, Socket.IO events and the rate-limit reasoning. |
| [`load-ingestion.md`](docs/claude/load-ingestion.md) | Both rate-con paths (n8n email + drag-and-drop) and why they must stay in lockstep; the n8n workflow's own traps (`pairedItem`, dead alert paths, the `output` column, LLM-guessed distances); rate-con reconciliation; unusable addresses. |
| [`invoice-drafting.md`](docs/claude/invoice-drafting.md) | `POST /api/loads/:loadId/draft-invoice` for all brokers — recipient resolution, order-number/total fallbacks, invoice numbering, and the **4** rate-con sources including the by-CONTENT fallback and the two rules that keep it from mailing the wrong customer's paperwork. |
| [`pii-at-rest.md`](docs/claude/pii-at-rest.md) | Why the answer was NOT encryption; the `/uploads` IDORs and the one normalizing guard; masking on read; the two audited reveal routes; what is still open. |
| [`fuel.md`](docs/claude/fuel.md) | Fuel-range honesty (the panel was ~2× optimistic), the range interval + `rangePlanningMiles`, trip planning, `ESTIMATED_BASIS_DERATE`, and gallons recovery off stored receipt images. |
| [`investor-money-math.md`](docs/claude/investor-money-math.md) | The month dimension on investor trip expenses (`investorExpenseScopeSql()`), the split-percentage resolver, and the insurance category that was absent from `GET /api/investor/report`. |
| [`truck-retirement.md`](docs/claude/truck-retirement.md) | `trucks.retired_at`, the inclusive both-ends billing interval, and the five gates that share one predicate. |
| [`user-routes-guards.md`](docs/claude/user-routes-guards.md) | `PUT`/`DELETE /api/users/:id` as finance routes — the 409 code list, the single driver-rename cascade (`DRIVER_RENAME_TARGETS`), and the `invoices.driver` case trap. |
| [`identity-collation.md`](docs/claude/identity-collation.md) | `drivers_directory.driver_name` `UNIQUE COLLATE NOCASE`, the shadow-row payroll bug, the create-verb/409 fixes around it, and **`resolveDailyRate()`'s per-driver → per-truck → `$250` ladder** (the shadow costs exactly $50/day because of it). |
| [`auth-setup-latch.md`](docs/claude/auth-setup-latch.md) | `POST /api/auth/setup`, the unauthenticated admin minter — the latch, `SETUP_RECOVERY_TOKEN`, and why session revocation is part of the guard. |
| [`last-login.md`](docs/claude/last-login.md) | `users.last_login_at` — why there was no history to backfill, the one choke point, and the load-bearing `try/catch`. |
| [`environment-refresh.md`](docs/claude/environment-refresh.md) | `refresh-local.sh` / `refresh-staging.sh` / `refresh-env.js` — the spreadsheet gate, telemetry trimming, and what sanitization does and does not cover. |
| [`maps-key-split.md`](docs/claude/maps-key-split.md) | Why one Maps key can never be restricted, the server/browser split, and the IPv6 egress trap. |
| [`maintenance-notice.md`](docs/claude/maintenance-notice.md) | The investor maintenance banner/popup/disclaimer — three surfaces, one flag, and the hard constraint that nothing gates. |
| [`ci-deploy.md`](docs/claude/ci-deploy.md) | The CI gate; the push-to-`main` auto-deploy (staging, then production with no approval gate); the box deploy lock and exact-SHA deploys; the drift heal; backup freshness; the shared VPS and `ecosystem.config.js`. |
| [`testing.md`](docs/claude/testing.md) | The standalone unit runners, and `test-suite.js` — the HTTP harness that writes — with how to point it away from production. |
| [`helper-scripts.md`](docs/claude/helper-scripts.md) | What each script in `scripts/` is for, including the Super Admin password reset and what it does not cover. |
| [`node-and-deps.md`](docs/claude/node-and-deps.md) | The VPS's two Node runtimes, the `better-sqlite3` ABI trap, and the `uuid` / `googleapis` pins behind a clean `npm audit`. |
| [`geofence.md`](docs/claude/geofence.md) | ELD-driven load-status advance: the radius, `load_coordinates` as the only coordinate source, departure as the detention time-out, one transition per ping. |
| [`driver-active-days.md`](docs/claude/driver-active-days.md) | The driver-pay basis — completed loads ∩ ELD travel days, truck-local days, the coverage-aware fallback, and `resolveDailyRate()`. |
| [`routemate.md`](docs/claude/routemate.md) | The Routemate ELD adapter: env vars, tables, endpoints, and the vehicle link on `trucks`. |
| [`linxup.md`](docs/claude/linxup.md) | The Linxup push webhook: token gate, message mapping, truck linkage, and the speed unit (confirmed mph) with its drift guard. |

Other long-form docs already in the repo: `scripts/README-env-refresh.md` (env-refresh runbook), `docs/ratecon-ownership-recommendation.md`, `docs/investor-portal-copy.md` (investor-facing copy sign-off inventory), `docs/manual/technical/06-operations.md`, `docs/vps-disk-and-data-handoff.md`.

**Driver POD upload failures have their own triage set — start at [`docs/troubleshooting/driver-pod-upload-failures.md`](docs/troubleshooting/driver-pod-upload-failures.md).** It maps the whole chain (phone → cellular → nginx → Express → Sheets/Drive/ScanKit) to a symptom → cause → fix matrix, then hands off to two runbooks: [`docs/runbooks/nginx-upload-timeouts.md`](docs/runbooks/nginx-upload-timeouts.md) (a `499` from a driver's phone while a desktop admin gets `200` is a timeout, **not** a code bug — nginx's default `proxy_read_timeout` is 60 s; the POD flag write to Sheets is **no longer** on the critical path — the route responds first and defers it to `setImmediate`, so do not chase that as the cause) and [`docs/runbooks/scankit-billing.md`](docs/runbooks/scankit-billing.md) (a `402 scan_no_credits` degrades to the raw photo — scanning is an enhancement, never a gate on closing the load). Since 2026-09-23 live nginx gives `/api/documents/` **and `/api/expenses`** 120 s, and logs `rt`/`urt`/`ust`/`rl`/`host` per request to `/var/log/nginx/app.logisx.com.timing.log` — phone uplink vs server.

**`README.md` at the repo root is the project's front door and is accurate as of 2026-08-25** — it was rewritten then, having previously described the "Google Sheets CRUD" starter this repo grew out of (a four-route `/api/data` API, `public/index.html` as "the" frontend, and an instruction to *"Open `server.js` and update these three values at the top"*). It is a short orientation that points here. **This file plus `docs/claude/` remains the real documentation** — the README deliberately does not duplicate any hazard, it links to them. Its pinned counts were dropped on 2026-09-23.

### House invariants — the rules you can break without knowing the topic exists

- **Anything that moves money ships dormant** — a new flag defaults **off**. The flags that do: `INVOICE_AUTOGEN_ENABLED`, `PERIOD_FINALIZE_ENABLED`, `FUEL_GALLONS_RECOVERY_ENABLED`, `MAINTENANCE_NOTICE_ENABLED`, `LINXUP_ENABLED`, `ROUTEMATE_ENABLED`, `SCANKIT_ENABLED`, `RATECON_INDEX_APPLY_ENABLED`, `RATECON_RECONCILE_ENABLED`, `FUEL_EVENTS_ENABLED`, `CHAT_ORPHAN_SWEEP_ENABLED`.
  - **⚠️ These `*_ENABLED` flags deliberately default ON because they are kill switches, not enable switches: `PII_MASK_ENABLED`, `RATECON_EXTRACT_ALERT_ENABLED`, `EXPENSE_DUPLICATE_ALERT_ENABLED`, `FUEL_LOW_ALERT_ENABLED`, `LOAD_HAUL_ELD_ENABLED`, `ELD_STALE_ALERT_ENABLED` and `INVOICE_UNDATED_ALERT_ENABLED`.** (`CSRF_HEADER_REQUIRED` is one more kill switch under a different naming shape — see the CSRF decision below.) The reasoning is written out at `FUEL_LOW_ALERT_ENABLED`'s definition and applies to every one of them: *"a safety warning that ships disabled is a safety warning nobody turned on."*
  - **⚠️ Read the SHAPE at the definition site, not the name.** There are **three** and only the middle one is self-describing:

    | Shape | Default |
    |---|---|
    | `String(process.env.X \|\| "").toLowerCase() === "true"` | **off** |
    | `/^(true\|1\|yes\|on)$/i.test(...)` | **off** |
    | `!/^(false\|0\|no\|off)$/i.test(...)` | **ON** |

    So `EXPENSE_DUPLICATE_ALERT_ENABLED=true` and `FUEL_LOW_ALERT_ENABLED=true` are **no-ops** — the only thing either variable can do is turn its alert **off**. This list goes stale; regenerate it by grepping `process.env.*ENABLED` and reading each definition.
  - **⚠️ Keep `process.env.` in that grep — the obvious grep finds one extra name, and it is not a flag.** `grep -rhoE '[A-Z_]+_ENABLED' server.js lib/` returns one more name than the two lists above, which reads as "this doc is stale". The extra one is **`STATEMENT_CACHE_ENABLED`** — `const STATEMENT_CACHE_ENABLED = !!STATEMENT_TEMPLATE_HASH`, a **derived constant**, not an environment variable. Nothing turns it on or off; it is false only when the statement template hash could not be computed.
- **`""` means UNBOUNDED at both ends** in `truckChargeFromMonth()` / `truckChargeUntilMonth()` / `intersectMonthWindow()`. A guard that reads either `""` the other way waves through exactly the truck with the most exposure. This inversion has been corrected twice (PR #205, PR #216).
- **`getInvestorDriverSet()` answers "who is on my trucks *right now*" and has no month dimension** — never use it as an unbounded expense filter. Use `investorExpenseScopeSql()`, and remember `COALESCE(truck_unit,'') = ''` is the other half of that guard.
- **Every expense amount SUM needs `EXPENSE_PNL_FILTER`** (`COALESCE(status,'') != 'Rejected'`; `grep -n EXPENSE_PNL_FILTER server.js` lists the sites). An expense an admin explicitly *denied* must never reduce revenue or profit in **any** view — investor P&L, `/api/financials`, the tax CSV, investor reports, weekly driver invoices. Omitting it pays out against rejected receipts, silently. `COALESCE` is what keeps legacy `NULL`/`''` and `Pending`/`Approved` rows counted.
- **WHICH MONTH an expense counts in has two bases, and mixing them is the bug.** `EXPENSE_PERIOD_EXPR` (`posted_period` wins) for anything feeding a **settlement** figure — a receipt logged into an already-finalized month books to the current open month, because the closed month has been published and must never move. Plain `date` for anything measuring the **world**: fuel cost-per-gallon, IFTA state mileage, the weekly invoice week, expense trend charts. A stray `strftime('%Y-%m', …)` over `expenses` in a settlement path is exactly as wrong as a missing `EXPENSE_PNL_FILTER`. ⚠️ `getDeductibleExpensesByDriverMonth()` uses `substr(date,1,7)`, which is **invisible to a grep for `strftime`** and drives percentage-driver pay at three call sites — see [`backend-server.md`](docs/claude/backend-server.md) under Month-end close.
- **Ownership checks are MEMBERSHIP tests, not fetch-one-then-compare.** `invoices.pdf_file_name`, `investors.application_id` and `documents.file_name` have no unique index, so `.get()` can refuse the real owner and admit a stranger.
- **A guard mounted on a sub-path of a static mount does not hold.** `express.static` decodes and normalizes; a literal-path guard does not. Mount the guard where `express.static` is mounted, do your own decode → fold → collapse → `path.posix.normalize`, match the directory **case-insensitively**, and reject `..` **before** normalize.
- **Masking the NUMBER while shipping the DOCUMENT is not masking** — a masked SSN beside a base64 photo of the licence is not redaction. The same lesson had to be learned twice (API 2026-08-08, sanitizer 2026-08-13).
- **No `await` between a check and its write.** `bcrypt.hash` is hoisted above the guards in `PUT /api/users/:id` and `POST /api/auth/setup` for exactly this reason, and state must be re-read *after* the last await.
- **Never identify a Google Sheet by its title** — the VPS `logisx-staging` process uses a sheet *titled* "logisx-production". Check the ID. Production sets **no** `SPREADSHEET_ID`, so any server started without an explicit override writes to the live sheet.
- **`super_admin` is a SHARED login** — `actor` records that the account was used, never who used it. Encryption is the wrong tool for "which person read this"; masking plus an audit row is the right one.
- **SQLite timestamps on the wire**: store/serve an explicit ISO-8601 `Z` string (or wrap with `strftime('%Y-%m-%dT%H:%M:%SZ', col)`). A bare `CURRENT_TIMESTAMP` serializes zone-less and the browser parses it as local time. `/api/dispatch-notifications` does this; follow it for new endpoints surfacing `created_at`.
- **Never PATCH an n8n credential to "test" it** — the PATCH overwrites immediately and has broken rate-con ingestion twice. And never reason about an n8n node from this file alone; read the live workflow over the API.
- **Bound every regex quantifier that runs on attacker-influenced text.** Two separate super-linear parsers have blocked the event loop for 9 s, 28 s and 113 s in production. ⚠️ Only an *internal* whitespace run is expensive; a trailing one is cheap and hides the problem.
- **⚠️ `getWeekRange()` parses a bare `YYYY-MM-DD` as UTC MIDNIGHT, then converts to Central — moving it to 19:00 the PREVIOUS day.** A Saturday therefore reads as a Friday and resolves to the week *before* the one it starts. Existing invoice callers pass a Friday week-**end**, where the same shift lands on a Thursday inside the same Sat–Fri week and is harmless — which is why this has never bitten. Passing a week **start** exposes it. Anchor at `T12:00:00Z` first (`GET /api/analytics/mileage` does).
- **`loadBelongsToDriver()` answers `true`, `false` or `null`** (could not read). On `null` every caller answers a retryable 503 `LOAD_OWNERSHIP_UNVERIFIED` — never a false 403, never a pass; `null` is falsy on purpose, so never test `=== false`.
- **Read an image's header before decoding it.** Every in-process decode first calls `checkImage()` (`lib/image-size.js`: known type, readable size, a pixel ceiling) and an upload it fails is refused with 413 `IMAGE_TOO_LARGE` / 415 `UNSUPPORTED_IMAGE_TYPE` (the receipt thumbnail answers 404; the PDF renders leave the image out); `scripts/test-image-limits.js` pins each guard.
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

# Verify — this IS the CI gate (.github/workflows/ci.yml runs the same three)
npm run ci           # check + test:unit + build:client, ~1 min. Run before pushing.
npm run check        # node --check server.js — one very large file; a syntax error breaks the whole app
npm run test:unit    # scripts/run-unit-tests.js — every standalone runner (it prints the list); seconds, not minutes
node scripts/test-truck-retirement.js   # run ONE runner: plain node, no server/fixtures, exits 1 on failure

# Docs (Puppeteer-driven static doc/screenshot generation from scripts/docs/)
npm run docs:build       # node scripts/docs/generate-docs.js
npm run docs:screenshots # node scripts/docs/capture-screenshots.js
npm run docs:driver-guide # node scripts/docs/capture-driver-guide.js
npm run docs:video       # node scripts/docs/capture-driver-video.js (--dry via docs:video:script)
```

**⚠️ Activate `.nvmrc` (Node 22.23.2) before running ANY of the above, or the failures are lies.** `better-sqlite3` is a native module and this repo's `node_modules` is built for one ABI. On a newer local Node — a machine-wide default of 26 is the common case here — `npm run test:unit` reports **most runners FAILing**, and the message names a module path, so it reads as a real regression in the code you just touched. It is not; the whole error is `NODE_MODULE_VERSION 127 … requires 147`. Under 22.23.2 the same tree passes in full locally; CI runs all but one because it sets `UNIT_TEST_SKIP_TIMING`, which skips the one timing runner. Same trap as the VPS deploy one in [`node-and-deps.md`](docs/claude/node-and-deps.md) — **`npm install` will not fix it either**, since npm tracks package versions, not ABI. `fnm` is installed; `fnm use` reads `.nvmrc`. If a runner fails, check `node -v` **before** you read the diff.

Why 22.23.2, the VPS's two Node runtimes, and the dependency pins that must not be "fixed" (the `uuid` override, `googleapis` held back) → [`docs/claude/node-and-deps.md`](docs/claude/node-and-deps.md).

Development requires two terminals: `npm run dev` + `npm run dev:client`. Open http://localhost:5173 during development.

For production: `npm run build:client` then `npm start` — Express serves the built SPA from `client/dist/`.

`postinstall` auto-runs `cd client && npm install`, so `npm install` at root installs both backend and frontend deps.

**Repo layout & parallel dev:** the git repo root is *this* folder (the app), with sibling worktrees `LogisX-wt-1` / `LogisX-wt-2` for running parallel feature branches side by side. To run two full stacks at once, give each worktree its own ports in its `.env`: `PORT` (Express), `VITE_DEV_PORT`, and `VITE_API_TARGET` (the Express URL Vite proxies `/api`, `/socket.io` and `/uploads` to — read in `client/vite.config.js`); leave all three unset for the default `5173 → :3000` pairing.

**Branch & PR workflow:** cut `feat/…` or `fix/…` branches off `main`; PRs target `main`, and merging to `main` is what ships to production (automatically — see CI/CD below). **⚠️ The `/start-task` / `/end-task` (aka `/logisx-start` / `/logisx-end`) skills this file used to describe DO NOT EXIST — do not go looking for them** (verified 2026-08-26: repo `.claude/` holds only `settings.local.json` and `worktrees/`, and neither `~/.claude/skills/` nor `~/.claude/commands/` exists). Same class of stale pointer as `.claude/rules/` below. Do the branch work by hand, or ask the release-engineer agent: freshen from `origin/main`, cut the `feat/…`/`fix/…` branch, and open the PR against `main` — and never merge or switch branches on the user's behalf without asking.

**CI/CD, deploy and the VPS → [`docs/claude/ci-deploy.md`](docs/claude/ci-deploy.md).** ⚠️ A merge to `main` deploys staging, then **production with no approval gate** (staging, a smoke + edge check and auto-rollback stand in for a human). ⚠️ The VPS is shared with other clients: restart by exact pm2 name, never `all` or an id. Deploy or roll back with `gh workflow run deploy.yml`, not an ssh one-liner. `npm run ci` is the CI gate.

**Tests → [`docs/claude/testing.md`](docs/claude/testing.md).** `npm run test:unit` runs the standalone `scripts/{test,check}-*` runners — no server, no fixtures, safe any time. ⚠️ `test-suite.js` is an HTTP harness that **writes**: it defaults to port 3000 (production on the VPS) and, with no `SPREADSHEET_ID` override, the **live** sheet. Read the doc before running it.

## Environment Setup

**⚠️ `.env.example` is the canonical variable list, and this file keeps no copy of it.** `grep -ohE 'process\.env\.[A-Za-z_][A-Za-z0-9_]*' server.js lib/*.js | sort -u` lists the names the code reads; when wiring anything new, grep `.env.example` first.

Required files at project root:
- `service-account-key.json` — Google service account credentials (not in git)
- `.env` — environment variables

**The variable list lives in [`.env.example`](.env.example) and only there.** It documents every variable `server.js` and `lib/` read, with the same reasoning this file used to duplicate for some of them — including the ones you must not get wrong (`GOOGLE_API_TIMEOUT_MS` / `GOOGLE_SOCKET_IDLE_MS` and the 2026-08-06 socket-hang outage behind them, the `RATECON_CONTENT_*` cost controls, the `MAINTENANCE_NOTICE_*` split). Duplicating it here only reset the drift clock, which is the hazard this file warns about everywhere else — so the copy is gone rather than half-maintained. **Read `.env.example` before wiring anything new**, and see the flag-shape warning under House invariants: the name does not tell you whether a flag ships on or off.

Default values in `server.js` (override via env):
- Spreadsheet ID falls back to `"1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"` (production Dispatch Management — n8n writes here). Override by setting `SPREADSHEET_ID` in `.env`. Staging uses this to point at its own copy.
- Archive Spreadsheet ID falls back to `"1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI"` (read-only archive). Override via `ARCHIVE_SPREADSHEET_ID`.
- Session secret: Set via `SESSION_SECRET` env var (required for production; falls back to default for dev)

Helper scripts in `scripts/` — `reset-super-admin-password.js`, `prepare-test-fixtures.js`, `seed-staging.js`, `refresh-env.js` with `refresh-local.sh` / `refresh-staging.sh`, `backup-db.js`, `geocode-loads.js` → [`docs/claude/helper-scripts.md`](docs/claude/helper-scripts.md). ⚠️ The password-reset script covers a forgotten password only; it does not stand in for the last-Super-Admin guards.

### Environment refresh → [`docs/claude/environment-refresh.md`](docs/claude/environment-refresh.md)
`refresh-local.sh` / `refresh-staging.sh` (runbook: `scripts/README-env-refresh.md`). ⚠️ The target `.env` must name its own non-production `SPREADSHEET_ID`, and the default telemetry trim changes old months' pay math.

## Architecture

### Backend (`server.js`)
Single-file Node.js/Express server — measure it with `wc -l server.js` and count its routes with `grep -cE '^\s*app\.(get|post|put|patch|delete)\(' server.js`; every size this file used to pin went stale within weeks. Google Sheets is the primary database (Sheets API v4); SQLite for local data; uploads on local disk (Drive only for rate-cons); Socket.IO for real-time. Body limit raised to 50mb for large payloads with embedded base64 photos/signatures.

**📖 The complete endpoint reference — every route, its role gate, and the reasoning behind each guard — is [`docs/claude/backend-server.md`](docs/claude/backend-server.md). Read it before touching a route.** What follows is the index.

**SQLite** (`app.db`, WAL mode) holds everything that does not live in the Sheets. The table-per-domain map (and the command that regenerates the table list), the session store and the two migration shapes are in [`backend-server.md`](docs/claude/backend-server.md#sqlite--tables-by-domain).

**The `*_alerts` tables are dedupe ledgers, not logs** — an alert path writes a row so the *same* condition never notifies twice. Clearing one re-arms the alert; that is the intended recovery, but it will re-fire on historical rows. This is why cancelled-duplicate load `209875716` "costs nothing ongoing" (its `ratecon_extract_alerts` row is already there).

**⚠️ Money tables that outlive their inputs**: `investor_payouts` / `investor_payout_history` **freeze** a settled figure, and `period_locks` freezes a whole month. A recomputation that disagrees with a frozen row is not automatically a bug — see [`investor-money-math.md`](docs/claude/investor-money-math.md) and the payout-ledger section of [`backend-server.md`](docs/claude/backend-server.md) before "correcting" one.

**Notable libraries** and the **AI / vision services** (Gemini vision for receipts and rate-cons, ScanKit scanning — each degrades to manual entry or the raw photo rather than block) → [`backend-server.md`](docs/claude/backend-server.md#ai--vision-services).

**REST endpoint groups** — the group table (paths + the gate worth knowing) and every route's detail: [`backend-server.md`](docs/claude/backend-server.md#endpoint-groups-at-a-glance); read it before touching a route. Most-tripped gates: load cancel (Super Admin + `reason`), invoice `pdf`/`submit` (Super Admin or the owning Driver), `POST /api/db/download` (POST on purpose), `POST /api/auth/setup` (an admin without a session); `/api/public/*` and `/api/config/*` are public by design; `?as_user_id=` and the Driver scoping on fuel/POI routes are security controls.

Fuel range, trip planning and gallons recovery have their own hazards — see [`docs/claude/fuel.md`](docs/claude/fuel.md) before quoting any range number.

**Socket.IO events** — every emit and its room, incl. `notifyChange(domain)` → `<domain>:changed`, which `useSocketRefresh()` depends on → [`backend-server.md`](docs/claude/backend-server.md#socketio-events).

Session-based auth with 4 roles: Super Admin, Dispatcher, Driver, Investor. Auth middleware: `requireAuth` (401), `requireRole(...roles)` (403). First-time setup creates the initial Super Admin via `POST /api/auth/setup` — see "the unauthenticated admin minter" in [`auth-setup-latch.md`](docs/claude/auth-setup-latch.md) before touching that route, and note the app deliberately refuses to be left with **zero** Super Admins. While `users.must_change_password` is set, both guards answer 403 `PASSWORD_CHANGE_REQUIRED` to all but `POST /api/auth/change-password` — a self-contained copy in each guard, like the CSRF check — and `refreshPasswordChangeFlag` must stay directly below `sessionMiddleware`. Login, setup and change-password regenerate the session, and a session's live-update sockets end with it.

**Role-based data sanitization**: `PUT /api/data/:rowIndex` preserves broker and phone contact columns for non-Super Admin users (values are read from the sheet and spliced back in before writing). `GET /api/data` is Super Admin / Dispatcher only, so its branch that strips financial columns for the Driver role is unreachable; drivers read loads through `GET /api/driver/:driverName`, which hides those columns.

**Rate limiting** — every limiter (window, max, scope) and why they are shaped the way they are → [`backend-server.md`](docs/claude/backend-server.md#rate-limiting). ⚠️ On anything expensive, `requireRole` is mounted before the limiter, and the POI cache — not its limiter — is the real cost control.

The 60s in-memory Job Tracking cache (`getJobTrackingCached()`) is the other core throttle — it absorbs bursty dashboard traffic so the Sheets 300 req/min quota isn't a real constraint day-to-day. ⚠️ Every caller gets the **same** object, so never write to it: annotate `liveJobTrackingView(jt)` (live rows, fresh copies) instead — `scripts/test-jt-cache-isolation.js` enforces it.

### Load ingestion — two paths, one shape
A load reaches Job Tracking two ways, and **they must stay in lockstep** — a load that arrived one way has to be indistinguishable from one that arrived the other.

1. **Rate-con email (original, unattended).** `info@logisx.com` receives the rate con → a Gmail filter **stars** it + applies the **`RATECONs`** label → n8n "Dispatch v2 (Fixed)" fires → Drive upload, extraction, dedupe, then writes **three tabs**. **Extraction and distance both run in the APP now, not in n8n** — `POST /api/n8n/extract-pdf-via-gemini` and `POST /api/n8n/load-distance`, authenticated with **`N8N_EXTRACT_SECRET`** (never `N8N_WEBHOOK_SECRET`, which also gates `POST /api/webhook/new-load`). Blind spot: if the email never arrives, or arrives from a sender the filter doesn't match, there is **zero signal** — no execution, no alert, no row. That is what `reconcileRateCons()` exists to catch, from outside the pipeline.
2. **Drag-and-drop (attended).** The dispatcher drops the PDF on the Job Board. `POST /api/loads/ratecon/extract` parses it and **returns without writing**; the dispatcher reviews/corrects; `POST /api/loads/from-ratecon` then replicates the n8n sequence server-side — validate load number → dedupe (409 `DUPLICATE_LOAD`) → distance + rate-per-mile → append Job Tracking → upsert Payments Table → upsert Job Details → archive the PDF → `load_coordinates` + audit + notification → `jtCacheInvalidate()`.

The gotchas that bite before you think to open the doc — anchor every sheet write to column A, the rate-con archive is local (not Drive), `POST /api/n8n/load-distance` answers a flat body, and one Gmail poll can carry both emails of a load — lead [`load-ingestion.md`](docs/claude/load-ingestion.md).

The n8n workflow's own traps (`pairedItem` on multi-email polls, the dead errorWorkflow, the retired LlamaParse chain, the deleted LLM distance agent, the `Details` commodity-vs-route collision), rate-con reconciliation, and the unusable-address guard are all in **[`docs/claude/load-ingestion.md`](docs/claude/load-ingestion.md)**.

### Invoice drafting — all brokers (IMAP + rate-cons)
One-click "Draft Invoice Email" on any **delivered/completed** load with a POD — `POST /api/loads/:loadId/draft-invoice` (alias `…/draft-bison-invoice`) assembles the invoice + supporting docs and writes a Gmail **draft**, never auto-sends, via `lib/imap-draft.js`. Distinct from the `/api/invoices/generate` weekly-pay flow. Bison → `QPinvoicesUSA@bisontransport.com`; **every other broker → `quickpay@megacorplogistics.com`**. Broker identity resolves via `BROKER_DOMAIN_NAMES` on the email domain (the sheet has **no** brokerage-company column — `Broker Contact Name` and `Contract ID` both hold the booking *agent*). Order number falls back to the load id — **except on a BISON load, where that fallback is now a hard stop**: the route answers **422 `INVOICE_REFS_REQUIRED`** until a human supplies the Order # and PO #, because Bison AP matches on *their* number and ours reconciles against nothing. Total falls back to the sheet's `"  Payment  "` column (real surrounding spaces, exact-`payment` match only) → **422 `INVOICE_TOTAL_UNKNOWN`** rather than a `$0.00` invoice. **⚠️ `dryRun` is a QUERY param** — a body-only run creates the real draft and burns an invoice number. Full detail in **[`docs/claude/invoice-drafting.md`](docs/claude/invoice-drafting.md)**.

### Frontend → [`client/CLAUDE.md`](client/CLAUDE.md)
Vue 3 + Vite SPA. Its stack, directory map, composable conventions, the `navigator.geolocation` caveat, the `pdfjs-dist` security pin and the route/role table are in the nested file, which Claude Code loads when it reads anything under `client/`. Shared server modules have the same arrangement: [`lib/CLAUDE.md`](lib/CLAUDE.md).

### Legacy Frontend (`public/`)
Original vanilla HTML/CSS/JS pages, kept as the `public/` fallback (see Static file serving in [`backend-server.md`](docs/claude/backend-server.md)).

## Key Conventions

- **Row indexing**: Row 1 = headers, row 2+ = data. API uses 1-based row indices. Each data object includes `_rowIndex`. DELETE internally converts to 0-indexed for Sheets `batchUpdate` `deleteDimension` (`startIndex: rowIndex - 1`).
- **Sheet selection**: All data endpoints accept `?sheet=` query param; defaults to "Job Tracking".
- **Value format**: POST/PUT bodies use `{ values: ["col1", "col2", ...] }` with `valueInputOption: "USER_ENTERED"` (supports formulas).
- **Column detection via regex**: Both backend and frontend match headers dynamically with regex patterns — `/driver/i` for driver columns, `/rate|amount|revenue|pay|charge|price|cost/i` for financial columns (hidden from Driver role), `/status/i` for status, `/load.?id|job.?id/i` for load IDs, `/origin.*lat|pickup.*lat/i` and `/dest.*lat|delivery.*lat/i` for coordinates. This makes the system flexible to different sheet column names.
- **Driver fields**: Any column matching `/driver/i` renders as a `<select>` populated from the first driver-like column in "Carrier Database".
- **Role-based routing**: Super Admin sees all, Dispatcher sees the dashboard and the dispatch screens (no broker/financial info; the `/data` sheet manager is Super Admin only), Driver sees driver app (no sidebar), Investor sees financial view + truck fleet.
- **Geofence auto-status** → [`docs/claude/geofence.md`](docs/claude/geofence.md). ELD pings advance a load's status inside a radius (`GEOFENCE_RADIUS_M`, 2 miles); coordinates come from `load_coordinates`, never the sheet; leaving the pickup is the detention time-out; a completion status is never written automatically.
- **ETA calculation**: Uses `geolib.getDistance()` to destination. Default speed: 24.587 m/s (~55 mph) when GPS speed is unreliable. Compares ETA vs scheduled delivery to flag "on-time" / "delayed".
- **IFTA state matching**: Hardcoded US state bounding boxes (`lib/ifta-states.js`) classify driver GPS pings by state.
- **Sheet ID caching**: Google Sheet tab GIDs are cached in a `Map` in memory to avoid repeated API lookups. Lazy-initialized via `getSheetId()`.
- **Geocode caching**: Geocode results are cached in the `geocode_cache` SQLite table to avoid redundant Google Maps API calls.
- **No transactions**: Multi-step operations (update sheet + append log + emit socket) are not atomic. Network failures mid-operation can leave data inconsistent.
- **Onboarding documents**: driver and investor onboarding use seeded lists (`ONBOARDING_DOCS`, `INVESTOR_ONBOARDING_DOCS`) with PDF generation + e-signature capture.
- **Audit trail**: Admin actions (user creation, driver rename, etc.) are logged to the `audit_trail` table.
- **Load exclusion is centralized**: every load-revenue aggregator (`/api/dashboard`, `/api/financials`, `/api/investor`) runs sheet data through `excludeDroppedLoads(rows, headers)` before any math. It drops (a) rows whose status matches `CANCELED_STATUS_RE = /^(cancel|canceled|cancelled)$/i` and (b) rows whose `load_id` is in the `deleted_loads` table. Keep this the single place deciding "is this load live?" so dashboard/financials/investor stay consistent. `POST /api/invoices/generate` reads the sheet directly (not via this helper), so `selectInvoiceWeekLoads()` applies its own soft-delete filter — through the same `normalizeLoadId()` / `loadKeySet()` pair — to avoid billing soft-deleted loads; keep the two in sync.
- **Driver "active days"** (the driver-pay basis) → [`docs/claude/driver-active-days.md`](docs/claude/driver-active-days.md): completed-load windows ∩ ELD travel days in the truck's local time zone, with a coverage-aware fallback, priced through `resolveDailyRate()`. ⚠️ `/api/investor`, `/api/financials` and `POST /api/invoices/generate` share it and must move together.
- **Two soft-delete patterns coexist**, by design — pick the right one for new tables:
  - **Separate `deleted_loads` table** (load_id keyed): the canonical row lives in Sheets, not SQLite. Query: `LEFT JOIN deleted_loads ... WHERE deleted_loads.load_id IS NULL`. Recovery: `DELETE FROM deleted_loads WHERE load_id = ?`.
  - **`deleted_at` timestamp column** on the source table: used by `job_applications` (listings filter `WHERE deleted_at IS NULL`; `?include_deleted=true` for admin recovery). Cheaper (no join), but only works when the table lives in SQLite.
- **Notification click routing**: every load `dispatch-notification` emitter stores `loadId` in the row's `metadata` JSON (system alerts carry none); admin `NotificationsView` parses it → `router.push('/dashboard?load=<loadId>')`. `DashboardView` reads `route.query.load`, switches to Active Loads, passes `focusLoadId` into `ActiveLoadsTab`, which auto-opens that load's modal then emits `focus-consumed` to clear the query.

## Google APIs

- **Sheets API v4**: Primary database. Rate limit 300 req/min. `valueInputOption: "USER_ENTERED"`.
- **Drive API v3**: rate-con PDFs only — the best-effort mirror of the local rate-con archive, and the rate-con lookup (`RATECON_DRIVE_FOLDER_ID`). POD/document uploads are written to local `uploads/` (photos → PDF via pdfkit first); `GOOGLE_DRIVE_FOLDER_ID` is read but unused.
- **Maps APIs**: Routes (v2 `computeRoutes`), Geocoding, Distance Matrix, Places (New) — route calc, address lookup, geocode caching, diesel POI. These web-service calls are **server-side**, on `GOOGLE_MAPS_API_KEY`; the browser loads the Maps JavaScript API with whatever key `GET /api/config/maps-key` serves — see the key split below.

### Maps key split → [`docs/claude/maps-key-split.md`](docs/claude/maps-key-split.md)
⚠️ The published browser key (`GOOGLE_MAPS_BROWSER_KEY`) and the IP-restricted server key (`GOOGLE_MAPS_API_KEY`) can never be one key, and the VPS reaches Google over IPv6 — read the doc before touching either key's restrictions.

## ELD / GPS providers

- **Routemate** (ELD; polled via `lib/routemate-client.js`, gated by `ROUTEMATE_ENABLED`) → [`docs/claude/routemate.md`](docs/claude/routemate.md).
- **Linxup** (GPS; pushes to `POST /api/eld/linxup/webhook`; **live in production**, mph confirmed) → [`docs/claude/linxup.md`](docs/claude/linxup.md).
- Both write `routemate_telemetry` — tracking, geofence and pay all read it — tagged by its `source` column. `routemate_vehicles` holds both providers' ids, so an id's presence there proves nothing about provenance.

## House rules

**⚠️ `.claude/rules/` does not exist in this repo** (verified 2026-08-18) — earlier revisions of this file described it as present, so do not go looking. If generic team guidelines are ever reintroduced there, treat them as defaults and let **this repo's reality override them where they conflict**: those rules called for "many small files (<800 lines)" and "TDD with 80%+ coverage", whereas the backend is a deliberately single-file `server.js` and there is **no test framework** — only the `test-suite.js` HTTP harness plus the standalone `scripts/test-*.js` assertion runners. Follow the surrounding code's established patterns.

Two conventions do apply everywhere: **conventional-commit messages** (`feat:`/`fix:`/`refactor:`/`docs:`/`test:`/`chore:`/`perf:`/`ci:`) and **parameterized SQLite queries**.

**⚠️ This repository is public.** Commit messages, PR titles and bodies, and code comments are world-readable, edit history included. Describe a security fix by its behaviour — the gate, the status code, the error code — never by how it could have been abused, and describe nothing about a weakness until its fix is deployed.
