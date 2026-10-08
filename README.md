# LogisX

Dispatch and back-office platform for a trucking carrier: load ingestion from
broker rate confirmations, driver dispatch and live GPS tracking, expenses and
fuel, invoicing, driver/investor onboarding, and an investor payout ledger.

Runs in production at **app.logisx.com**.

## Stack

| Layer | What |
|---|---|
| Backend | Node.js + Express in one large `server.js` (shared modules in `lib/`), Socket.IO for real-time |
| Primary data | **Google Sheets** (Sheets API v4) — the operational book of record |
| Local data | SQLite (`app.db`, WAL) — auth, messaging, fleet, finance, telemetry |
| Frontend | Vue 3 + Vite SPA (`client/`), Tailwind v4, shadcn-vue; Vant in the driver app |
| Files | Local `uploads/` (PODs, receipts, signed documents, the rate-con archive) + Google Drive (rate-con PDFs) |
| AI / vision | Gemini (receipt OCR, rate-con extraction), ScanKit (document scanning) |
| Telematics | Linxup GPS (webhook push), Routemate ELD |

Roles are Super Admin, Dispatcher, Driver and Investor, with per-role routing
and server-side data scoping.

## Running it

Requires **Node 22**. The exact version is pinned in `.nvmrc`, which CI reads
too. On the VPS, pm2's `interpreter` runs the app on Node 22; the box's older
*system* node belongs to other tenants, so don't align anything to it.

```bash
npm install            # postinstall also installs client/ deps
npm run dev            # Express on :3000  (terminal 1)
npm run dev:client     # Vite on :5173     (terminal 2)
```

Open http://localhost:5173 — Vite proxies `/api`, `/socket.io` and `/uploads`
to Express.

For a production-style run: `npm run build:client && npm start`, which serves
the built SPA from `client/dist/`.

### Configuration

Needed at the repo root, and never committed:

- **`.env`** — see [`.env.example`](.env.example), the canonical list of
  variables, with the reasoning for each.
- **`service-account-key.json`** — Google service account credentials.

> ⚠️ **`SPREADSHEET_ID` has no safe default.** When it is unset, `server.js`
> falls through to the **production** Dispatch Management sheet — so any server
> started without an explicit override writes to the live book. Always set it
> locally. Identify a sheet by its **ID, never its title**: the staging sheet is
> titled "logisx-production".

## Tests

No Jest/Vitest/ESLint. Instead, standalone runners plus a manual HTTP harness:

```bash
npm run lint       # node --check over server.js, lib/*.js and scripts/*.js (under a second)
npm run test:unit  # every scripts/test-* and check-* runner (.js/.mjs), 4 at a time — no server needed
npm run check      # lint + test:unit: the fast local check, 70–110 s on an M-series Mac
npm run ci         # check + build:client — the same gate CI runs
```

`npm run test:unit` (that is, `node scripts/run-unit-tests.js`) prints how many
runners it found and names each one, so no count is kept here. It runs them 4 at
a time (`UNIT_TEST_CONCURRENCY=1` for one by one), so a new runner must be
isolated: temp files from `mkdtemp`, databases `:memory:` or inside that temp
directory, servers on port 0, nothing written into the repo. Timing-sensitive
runners (`scripts/test-pdf-cold-start.js`) run alone after the rest.

**Pre-push hook.** `.githooks/pre-push` runs `npm run check` before every push
and blocks the push if it fails. Turn it on once per clone:

```bash
git config core.hooksPath .githooks
```

It switches to the Node in `.nvmrc` through fnm when fnm is installed, and skips
a push that only deletes branches. It checks the working tree, so commit first.
`git push --no-verify` skips it for one push; CI runs the same runners anyway.

`test-suite.js` at the repo root is a **separate, manual** HTTP harness. It needs
a running server, it **writes** (it logs an expense, among other things), and it
is deliberately excluded from CI. Before running it:

- **Point the server at a non-production sheet.** Start it with an explicit
  `SPREADSHEET_ID` for a copy — without one it writes to the live book (see
  Configuration above).
- **Mind the port.** The suite defaults to `3000`, which is production on the
  VPS; set `TEST_PORT` (and the server's `PORT`) to run anywhere else.
- **Prepare fixtures first** with `node scripts/prepare-test-fixtures.js --yes-local-db`
  (local database only). It sets a test password on one account per role and
  prints the `test-suite.js` command with those usernames filled in; without
  it nearly every test fails at login.
- **Don't run it twice inside 15 minutes** — it exhausts its own rate limiters,
  and the second run's 429s look like regressions.

Browser end-to-end tests (Playwright, local and staging) live in
[`scripts/e2e/`](scripts/e2e/README.md) — also outside CI.

## CI/CD

GitHub Actions. Every PR into `main`, and every push to it, runs the `ci` gate
above on the Node version in `.nvmrc`.

**Merging to `main` deploys staging, then production, with nobody approving.**
Production deploys only after the staging job passed: staging deployed, a
read-only staging smoke check through the public edge passed (health, the login
page, every bundle file, an API call that must answer 401 signed out, the
live-update handshake), and CI's push run passed on that same commit. Branch
protection does not require PRs to be up to date with `main`, so that push run
is the first CI verdict on what a merge produced. Production then smoke-checks
itself, verifies the public edge, and **rolls itself back** to the previous SHA
if either check fails.

Setup, the safety reasoning, and the rollback design: [`.github/workflows/README.md`](.github/workflows/README.md).

## Admin scripts (run on the server, no login)

Run from the app directory with the Node pm2 runs the app with. Each script's header
has its full usage; none has a default sheet.

- `scripts/payout-rules-dry-run.js --db=app.db --sheet-id=<id>`: the payout-rules dry
  run (`GET /api/admin/payout-rules/dry-run`), read-only.
- `scripts/freeze-closed-months.js --db=app.db --sheet-id=<id>`: the closed-month
  freeze's plan and fingerprint, read-only. `--apply --fingerprint=<it>
  --include-unverified` backs `app.db` up next to itself, then freezes, with an
  audit row naming the script.
- `scripts/ensure-automation-user.js --db=app.db --username=<name>`: creates a
  non-production browser-automation Super Admin from a password piped on stdin;
  refuses on production and never changes an existing account.

Tests: `node scripts/test-admin-ledger-scripts.js`.

## Docs

- [`docs/manual/`](docs/manual/) — user guides and technical documentation
  (the markdown source for the PDFs in [`docs/pdf/`](docs/pdf/))
