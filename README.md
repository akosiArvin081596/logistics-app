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
if either check fails. A manual production deploy (a rollback, say) deploys
only a commit that passed staging in its own push run, unless it is run with
`override=true`, which is recorded as a warning on the run.

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

## Local replica of production

A full local copy of production, to reproduce an issue first-hand on the same data, files,
version and settings, on a Mac, with nothing able to reach a real person or a real service. It
lives in `~/LogisX-replica/` (mode 700, files 600; outside the repo and outside Documents, so
iCloud never syncs it). **It holds real people's data, unredacted. Keep screenshots and exports
from it out of the repo and out of anything shared.**

```bash
fnm use   # Node 22.23.2: the replica refuses another version than production's
LOGISX_PROD_SSH=<user@host> LOGISX_PROD_SSH_KEY=<identity file> npm run replica:pull [-- --force]
npm run replica:start -- [--task <name>] [--port <n>] [--fresh] [--prod-commit]
npm run replica:login -- <username> [--task <name>] [--headless] [--screens <dir>] [--visit <path>]...
npm run replica:clean -- [--task <name>]
```

- **`replica:pull`** refreshes the clean snapshot when it is older than 24 hours (or with
  `--force`). Production is only read. The ssh destination comes from `LOGISX_PROD_SSH` and is
  never stored in the repo. A program streamed over ssh (`scripts/replica/remote/`, nothing is
  installed on the server) works in one temporary folder, `/root/logisx-replica-tmp/<stamp>/`
  (a stamp unique to the run; mode 700, umask 077), at low CPU and I/O priority. It first removes
  any such folder an earlier pull left behind for more than 6 hours:
  - it copies the live `app.db` read-only (`VACUUM INTO` from a `readonly` connection, so rows
    still in the WAL are included);
  - in that copy it deletes the sessions and clears stored credentials (any token, secret, key,
    nonce, OTP, `*_code` or `*_hash` column, found from the schema; password hashes and receipt
    fingerprints are kept, by name). It does so with SQLite's secure delete and then VACUUMs the
    copy, and the pull fails if any removed value can still be found in the file's bytes;
  - it exports the non-secret settings from `.env`. A name containing KEY, SECRET, TOKEN, PASS,
    CREDENTIAL, PRIVATE, AUTH, SMTP, DSN or WEBHOOK is never copied, nor is a URL carrying
    credentials (in its user, query or path), a value that looks like a key, a
    `NODE_ENV`/`PORT`-style runtime setting, or any name production's code does not read;
  - it reads every tab of the Google Sheets the app uses with its own `spreadsheets.readonly`
    client. The server's key never leaves the server.

  The folder is then downloaded with rsync and deleted, also when a step fails (a trap on each
  side); the pull fails when it cannot confirm the folder is gone. `uploads/`, `storage/` and `evidence-archive/` are copied with rsync. After the first
  pull, only what changed is transferred. The manifest (`clean/manifest.json`) records the
  production commit, its Node version and time zone, and every table's row count.
- **`replica:start`** clones the clean snapshot and the files as a task's working copy
  (`work/<task>/`, APFS clones: instant, no space until something changes; kept until
  `replica:clean`). It then starts this checkout's server on it in replica mode at
  `http://127.0.0.1:3901` (or `--port`), serving the built client, and prints the PID.
  `--prod-commit` runs production's exact commit from a worktree under
  `~/LogisX-replica/code/`; it is refused for a commit without replica mode (remove that
  worktree with `git worktree remove` when you are done with it).
- **`replica:login`** sets a local password on that account in the working copy only, from the
  Keychain item `logisx-replica` (generated once, never shown), then signs in through the
  login page in Chrome for Testing (headed unless `--headless`). The browser may reach the
  replica and nothing else.
- **`replica:clean`** stops the task's server (by its recorded PID, only while that PID is still
  that server) and deletes its working copy. The clean snapshot stays. While the recorded PID
  is alive but cannot be shown to be that server, it stops and deletes nothing.

**Replica mode (`LOCAL_REPLICA=1`, `lib/replica-mode.js`)** differs from production on purpose:

- **It refuses to start** in any of these cases:
  - anywhere but macOS, or not started by `replica:start` (it sets a marker nothing else sets);
  - `NODE_ENV=production`, or signs of a server: pm2, running as root, a server path such as
    `/var/www`, or a hosting host name;
  - any outbound credential set (`lib/replica-rules.js`), or a setting in `settings.env` that the
    export would not copy. `SESSION_SECRET` is not a credential: `replica:start` passes a fresh
    random one, in memory only;
  - any proxy setting (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` in any case, `NODE_USE_ENV_PROXY`);
  - `BIND_HOST` other than loopback;
  - a database or data folder outside the task's working copy (`~/LogisX-replica/work/<task>/`),
    or a settings file or guard log outside `~/LogisX-replica/`.
- **`LOCAL_REPLICA` is read before dotenv, and judged the same way after it.**
  - Unset, empty, `0`, `false`, `no` and `off` (any case) mean off.
  - Any other value but `1` is reported and otherwise ignored.
  - The flag stops a normal run in one case only: `LOCAL_REPLICA=1` set by a `.env` file. That
    server would otherwise run normally with the file's credentials while seeming to be a
    replica.
- **Settings:** it never loads the repo's `.env` (dotenv is made a no-op, and a file guard refuses
  to read any `.env` or Google key). It reads `~/LogisX-replica/settings.env` instead.
- **Outbound paths are off:**
  - Google Sheets come from the working copy, reads and writes alike (`lib/replica-sheets.js`).
    No Google client is ever built;
  - Drive, mail (SMTP and Gmail IMAP drafts), the rate-con mailbox reconcile, the n8n webhook,
    every HTTP call `server.js` makes (Maps, Routes, Places, geocoding, weather, Gemini), receipt
    OCR, Routemate, Linxup and ScanKit are off;
  - Chromium (PDFs) starts unable to reach any host.
- **No scheduled job starts**, each named in the log. The one timer kept is the sweep that ends
  sockets whose session has ended.
- **A network guard** refuses every non-loopback socket, DNS query and `fetch()` before a packet
  leaves, and records the attempt in `~/LogisX-replica/logs/outbound-<task>-<time>.log`. An
  empty log means nothing was attempted.
- **Every page shows a "LOCAL COPY OF PRODUCTION" banner**, the login page included.

What is not reproduced:

- Production's secrets, active sessions and stored tokens.
- Maps. The map area of Tracking and the other map views stays blank, because the browser key is
  a secret and the browser may reach only the replica. Lists, routes already in the route cache,
  and coordinates already geocoded still show; anything new falls back to straight lines.
- Google's number and date formatting of values the replica writes to its Sheets copy.
- The rate-con PDFs that exist only in Google Drive. The draft-invoice lookup that would read
  them finds the local rate-con archive (`uploads/rate-cons/`) or nothing.

Tests: `node scripts/test-replica-mode.js`, `node scripts/test-replica-sheets.js` and
`node scripts/test-replica-snapshot.js`.

## Docs

- [`docs/manual/`](docs/manual/) — user guides and technical documentation
  (the markdown source for the PDFs in [`docs/pdf/`](docs/pdf/))
