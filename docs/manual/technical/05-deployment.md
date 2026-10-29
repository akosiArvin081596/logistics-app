# Deployment

LogisX runs on a single VPS at `76.13.22.110` under `/var/www/logistics-app`, managed by `pm2` with the process name `logistics-app`. A staging process named `logisx-staging` runs on the same VPS for pre-production testing.

## Production runtime

- **Host:** Single VPS, Ubuntu, public IP `76.13.22.110`.
- **App path:** `/var/www/logistics-app`.
- **Process manager:** `pm2`. The app process is `logistics-app`; the staging process is `logisx-staging`.
- **Web server in front:** nginx, terminating TLS on `app.logisx.com` and reverse-proxying to the local Node process.
- **Domain split:** `app.logisx.com` is the Express app. `logisx.com` is a separate Wix marketing site, not part of this codebase.

## Environment configuration

The production environment requires these files at the project root:

- **`.env`** — environment variables (see below).
- **`service-account-key.json`** — Google service account credentials.

### Required `.env` variables

```
SESSION_SECRET=<long random string>           # required in production
GOOGLE_DRIVE_FOLDER_ID=<Drive folder ID>      # optional, POD uploads skip Drive if empty
GOOGLE_MAPS_API_KEY=<Maps API key>            # required for maps, routing, geocoding
GMAIL_USER=<info@logisx.com>                  # for onboarding/outreach email
GMAIL_APP_PASSWORD=<Gmail app password>       # nodemailer auth
ADMIN_NOTIFY_EMAIL=<admin inbox>              # admin notifications + investor RFI; no default
BISON_INVOICE_EMAIL=<Bison AP inbox>          # invoice drafts for Bison loads; no default
DEFAULT_INVOICE_EMAIL=<default broker AP inbox> # other brokers' drafts; no default
INVOICE_BANK_ROUTING=<payout bank routing #>  # invoice Payment Method; no default ("Bank details not set")
INVOICE_BANK_ACCOUNT=<payout bank account #>  # invoice Payment Method; no default ("Bank details not set")
GEMINI_API_KEY=<Gemini API key>               # optional, enables receipt OCR
N8N_WEBHOOK_SECRET=<shared with n8n>          # required for n8n ingestion
PORT=3000                                     # optional, defaults to 3000
NODE_ENV=production
```

### Optional `.env` variables

```
GEMINI_OCR_MODEL=<override default model>     # defaults to gemini-2.5-flash
ROUTEMATE_BASE_URL=https://cloud.routemate.ai
ROUTEMATE_API_KEY=<Routemate key>
ROUTEMATE_ENABLED=false                       # default off until key is wired in prod
ROUTEMATE_POLL_LIVE_SEC=60
ROUTEMATE_POLL_FAULTS_SEC=300
ROUTEMATE_POLL_DAILY_HOUR=4
```

### `service-account-key.json`

A standard Google Cloud service account JSON key for the app's Google service account. Both the production spreadsheet and the Drive POD folder must be shared with that account's email (the key's `client_email`) as **Editor**.

## Deploy workflow

**Deploys run only through GitHub Actions** (`.github/workflows/deploy.yml`;
the halves that run on the VPS are `scripts/deploy/*.sh`, shared by every job
through `.github/actions/vps-deploy`). Setup, required secrets and the
reasoning behind each step are in
[`.github/workflows/README.md`](../../../.github/workflows/README.md).

- **A merge to `main` deploys staging, then production, with nobody
  approving.** The `production` environment has had no required reviewer since
  #431. Production runs once the staging job has passed, and that job has three
  parts: the deploy itself, the staging smoke through staging's public edge
  (`scripts/deploy/staging-smoke.sh`), and CI on `main` for the same commit.
  Both jobs deploy exactly the commit that was pushed.
- **Deploys are locked to `main`** (#434). The VPS secrets exist only in the
  `staging` and `production` environments, which accept runs from `main` only.
- **Every deploy** takes a box-level lock and reads which Node pm2 runs the app
  with. A deploy that cannot read it refuses before its checkout, with nothing
  changed. Then it clears npm's lockfile drift, refuses to deploy over any
  other local change, checks out the exact commit, installs and builds with
  that Node, restarts the one named pm2 process and proves the restart took. It
  then smoke-checks the app: `/api/config/maintenance` must answer, and `/`
  must be the app's page, not the 503 page. Production also checks its public
  edge. Only after every check passes is the commit recorded as verified
  (`refs/logisx/verified-deploy`).
- **The client build never takes the app's pages away.** Vite empties its
  output folder before it writes, so a deploy builds into `client/dist.next`
  beside the build being served. It swaps the new build in with two renames,
  and only once the build is whole: an `index.html` plus every `/assets` bundle
  file that page names, none of them empty. Every build swapped in is stamped
  with its commit (`client/dist/.build-commit`, which is never served). The
  build it replaced is kept, stamped, in `client/dist.prev` until the next
  swap. A failed build leaves `client/dist` as it was.
  - `scripts/refresh-staging.sh` and `scripts/refresh-local.sh` build the same
    way, running the deploy's own `client_build`.
  - CI, the replica, the e2e servers and `npm run build:client` still build
    straight into `client/dist`.
- **Without `client/dist/index.html`, every page is the 503 "being updated"
  page** (`lib/app-updating-page.js`, with `Retry-After` and `no-store`), while
  the API still answers. Every deploy check tells the app from that page by
  the SPA's mount point, `id="app"`. A request under `/assets/` for a file that
  is not there gets a 404, never a page. Express serves `client/dist` whether or
  not it existed at boot, so a process started during a swap serves the bundle
  as soon as it is back.
- **A failed install or build restarts nothing.** HEAD is on the new commit,
  but the old process keeps serving with its build in place, and the deploy
  reports `DEPLOY_RESULT=unbuilt`.
- **Production rolls itself back** when its install or build fails
  (`unbuilt`), when pm2 does not prove the restart (`unproven`), or when its
  smoke or edge check fails. `scripts/deploy/remote-rollback.sh` checks out the
  code that ran before the deploy, then installs, builds, restarts and
  re-verifies it. It also writes the failed commit into the drift marker, and
  ends `ROLLBACK OK` or `ROLLBACK FAILED … MANUAL INTERVENTION REQUIRED`. It
  serves its target's own client build, put back from `client/dist.prev` by its
  stamp when its own build fails, or it fails loudly. The job ends red either
  way: a successful rollback is not a successful deploy.
- **Staging never rolls back.** It is the canary: a failure stays in place to
  be inspected, and the job ends red.
- A deploy that exits without one of its four results (`deployed`, `noop`,
  `unproven`, `unbuilt`) fails its job, since nothing after it could tell what
  the box runs.

Every PR is gated by the *CI* workflow on Node 22.23.2, the Node pm2 runs these
apps with (the box's *system* Node is 20 and belongs to other tenants). It runs
`node --check` over the server and scripts, every standalone runner in
`scripts/` except the timing-sensitive PDF cold-start one, and a client build.

### Deploying or rolling back by hand

Only through the workflow, never over ssh:

```bash
gh workflow run deploy.yml -f target=production -f ref=main    # main's tip, once it passed staging
gh workflow run deploy.yml -f target=production -f ref=<sha>   # pin production to that commit (a rollback)
gh workflow run deploy.yml -f target=staging -f ref=<ref>      # staging: any plain branch, tag or commit
```

A manual production deploy passes its own gate first
(`scripts/deploy/dispatch-gate.js`): the commit must have passed the `staging`
job of a push-triggered Deploy run. Every commit `main` deployed before has
passed one, so a rollback to any of them works. Any other commit needs
`-f override=true`, which is recorded as a warning. A pin to anything but
`main` writes main's tip into the drift marker. The drift check then raises an
alarm rather than deploying `main` over the pin, and the next deploy of `main`
ends the pin.

> **⚠️ Not over ssh.** A checkout made by hand skips the box lock, the
> dirty-tree guard, the native-module probe and the build swap. It builds with
> the box's system Node 20, not pm2's Node 22. It also leaves the verified-deploy
> record naming a commit HEAD no longer contains, so the drift check alarms
> (`verified-record-inconsistent`) until a verified deploy rewrites it.

### Deploy drift

`deploy-drift.yml` compares production's last verified deploy with
`origin/main` on a schedule, and checks that the box serves the app (the API,
and `/` with the same page check as the smoke). The states that matter most:

- `in-sync` passes.
- `in-sync-unhealthy`: on main's commit but not serving the app (the API does
  not answer, or `/` is the 503 page). This raises an alarm. It is an incident,
  and nothing is behind to heal.
- `behind-healable`: behind, serving the app, and main's commit passed staging.
  It heals once, with a full deploy and the same auto-rollback.
- `behind-and-unhealthy`: behind and not serving the app. This raises an alarm
  and is never healed.

The full state table is in the workflows README.

## nginx configuration

nginx is the public-facing server. Two adjustments matter for LogisX:

- **`client_max_body_size 50m`** — necessary because the Express body limit is 50 MB to accept large base64 payloads with embedded photos and signatures. Without this, multipart uploads from drivers (large POD photos) get 413'd at the nginx layer.
- **WebSocket upgrade headers** — `proxy_set_header Upgrade $http_upgrade` and `proxy_set_header Connection "upgrade"` so Socket.IO can negotiate from polling to WebSocket transport.

TLS certificates are managed by Let's Encrypt. Renewal runs from cron.

## pm2 configuration

The `logistics-app` process is defined in `ecosystem.config.js` (`server.js` from `/var/www/logistics-app` on Node 22). Deploys restart production through that file (`pm2 restart ecosystem.config.js --update-env`), so a changed setting reaches the live process on the next deploy. Nothing runs `pm2 save`, though, so pm2's saved process list keeps the old settings until someone does; read the file's header comment before changing a number. This VPS runs about 23 other clients' pm2 processes: restart only by exact process name, never `all` or a numeric id. Useful pm2 commands:

- `pm2 logs logistics-app` — tail stdout/stderr.
- `pm2 logs logistics-app --lines 200` — recent logs.
- `pm2 restart logistics-app` — restart in-place. Brief downtime (seconds) while Node restarts.
- `pm2 reload logistics-app` — zero-downtime reload (only useful when the app supports it; for a single-process app like ours, `restart` is equivalent in practice).
- `pm2 monit` — live CPU/memory dashboard.
- `pm2 save` — persist the process list across reboots.
- `pm2 startup` — register pm2 with systemd so it survives a host reboot.

The staging process (`logisx-staging`) is the same `server.js` against a separate database file and port. Useful for testing a deploy before promoting to production.

## Build vs. dev

Three commands cover the matrix:

| Command | What it does | When |
|---|---|---|
| `npm start` | `node server.js` | Production / staging. |
| `npm run dev` | `nodemon --ext js server.js` | Local backend development with auto-restart on file changes. |
| `npm run dev:client` | Vite dev server on port 5173, proxying `/api` and `/socket.io` to :3000 | Local frontend development. |
| `npm run build:client` | Vite production build to `client/dist/` | Local production-style runs and CI. A deploy runs the same client build into `client/dist.next` and swaps it in. |

In development, run `npm run dev` and `npm run dev:client` in two terminals and open `http://localhost:5173`. In production, only `npm start` runs — Express serves the pre-built `client/dist/`.

## What lives on the VPS but not in git

- **`.env`** — environment secrets.
- **`service-account-key.json`** — Google credentials.
- **`app.db`** — SQLite database. `backup.sh` snapshots it nightly (cron, 02:00 UTC) into `backups/`, verified and gzipped, kept 30 days; the Backup freshness workflow checks the newest snapshot from outside the box every morning.
- **`uploads/`** — POD photos, receipts and signatures, stored only here. (Uploads never go to Drive; Drive holds only rate-cons.)

Nothing else. The repo is the source of truth for code; the VPS holds runtime state.

## Hardening

Several defaults that protect the production environment:

- **`SESSION_SECRET`** is enforced — the server warns at boot if it falls back to the dev default. In production, the warning becomes a real risk.
- **Cookie flags** — `httpOnly`, `secure: true` when `NODE_ENV=production`, `sameSite: 'lax'` (tightened from `'none'` 2026-08-09; override via `SESSION_COOKIE_SAMESITE`, which defaults to `lax`).
- **`compression`** middleware gzips all responses.
- **`express-rate-limit`** caps the abusable endpoints (see backend chapter).
- **Demo viewer write lockdown** — a global middleware blocks all mutating verbs (POST/PUT/PATCH/DELETE) for a special demo role with a small whitelist for harmless idempotent operations.

## Rollback

Production rolls itself back when a deploy fails its install, build, restart
proof or checks (Deploy workflow, above). To go back to an earlier commit
yourself, pin it through the workflow, never over ssh:

```bash
git log --oneline -10 main                                      # find the last good commit
gh workflow run deploy.yml -f target=production -f ref=<sha>    # check it out, build, restart and verify it
```

The `app.db` SQLite file is not touched by a code rollback — schema migrations are additive, so older code reads a newer schema fine. The exception is the rename-recreate migration: if you deployed code that triggered a CHECK-constraint table recreate, a rollback to older code that doesn't know about the new constraint may or may not work depending on the constraint. When in doubt, restore `app.db` from a backup.

To end the pin and return to `main`, deploy `main`, by a merge or by hand:

```bash
gh workflow run deploy.yml -f target=production -f ref=main
```

## Backups

`backup.sh` snapshots `app.db` every night (cron, 02:00 UTC) with `scripts/backup-db.js`. It uses SQLite's online backup, so the WAL is included, checks the snapshot's integrity before keeping it, gzips it into `backups/` and keeps 30 days. The *Backup freshness* workflow (`backup-freshness.yml`) checks the newest snapshot from outside the box every morning, read-only. It fails on a snapshot that is stale, too small, corrupt or missing, or when the last scheduled run failed. The accounts listed in `RATECON_PDF_VIEWER_IDS` can also export the database via `POST /api/db/download` (Admin Tools → *Download database backup*); every other account gets 403 `DB_DOWNLOAD_RESTRICTED`, and with the list unset or invalid nobody can. It is a POST and not a GET (a GET returns 405); the `curl` recipe is in Operations → Database admin tools. The Google Sheet is itself the system of record for loads and is implicitly backed up by Google.

The nightly snapshot covers `app.db` only: `.env`, `service-account-key.json` and the contents of `uploads/` have no routine backup. The first two are tiny; `uploads/` can be larger depending on POD/receipt volume.

## Two-process model with staging

Both `logistics-app` (production) and `logisx-staging` (staging) run on the same VPS. They share the host but have separate `.env`, separate SQLite databases, and separate ports. This is enough isolation for "test a deploy before promoting" — not enough for "run integration tests against a fresh DB." For destructive testing on staging, rebuild its database with `scripts/refresh-staging.sh`, which installs a sanitized copy of the nightly snapshot on which every account has a random password nobody knows; set `REFRESH_OPERATOR_PASSWORD` in the environment for that run to give one Super Admin a password you choose (see `scripts/README-env-refresh.md`). `scripts/prepare-test-fixtures.js` is for a **local** database only — it refuses deployed paths, and a database it has prepared must never be served from anywhere reachable. Note there is no truncate-and-reseed path: loads come from Google Sheets, not the database, so a wiped DB cannot be rebuilt locally.
