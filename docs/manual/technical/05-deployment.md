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

A standard Google Cloud service account JSON key for the account `sheets-bot@logistics-app-491014.iam.gserviceaccount.com`. Both the production spreadsheet and the Drive POD folder must be shared with this email as **Editor**.

## Deploy workflow

**Deploys run through GitHub Actions.** Pushing to `main` deploys **staging and
then production automatically** — production runs only if staging went green,
smoke-checks itself, and rolls back on its own if verification fails. Rolling back is the
same dialog with **ref** set to an older SHA. Setup, required secrets and the
reasoning behind each step are in
[`.github/workflows/README.md`](../../../.github/workflows/README.md).

Every PR is gated by the *CI* workflow: `node --check server.js`, the 45
standalone runners in `scripts/`, and a client build, all on Node 22 to match
what pm2 actually runs these apps with (the box's *system* node is still 20 and
belongs to other tenants).

### Deploying by hand

Still valid when Actions is unavailable, and it is what the workflow automates:

```bash
ssh root@76.13.22.110 "cd /var/www/logistics-app && \
  git checkout -- client/package-lock.json && \
  git pull --ff-only origin main && \
  npm install --silent --no-audit --no-fund && \
  npm run build:client --silent && \
  pm2 restart logistics-app --silent"
```

> **⚠️ The leading `git checkout -- client/package-lock.json` is load-bearing,
> not tidiness.** This box runs npm 10.8.2, which does not know the `"libc"`
> field a newer npm writes onto optional platform-specific deps — so **every**
> `npm install` here strips it and leaves `client/package-lock.json`
> permanently modified. `git pull --ff-only` refuses to overwrite a
> locally-modified tracked file, so without this line the first PR that touches
> the lockfile **aborts the deploy**. It aborts before anything is installed or
> restarted, so it fails safe, but it blocks the release until someone clears it
> by hand. Discarding this one path is safe: npm regenerates it on the very next
> line and nothing reads it at runtime.
>
> **Keep the reset scoped to that one path.** A blanket `git checkout -- .` or
> `git reset --hard` could silently discard a deliberate hotfix applied on the
> box. (Earlier revisions of this document omitted the line entirely — the
> version above is the corrected one.)

Staging is the same sequence against `/var/www/logisx-staging` with
`pm2 restart logisx-staging`.

This is intentionally one shell pipeline, not a deploy script. It runs in this order:

1. Pull main, fast-forward only — no merge commits, no rebase, fail if not fast-forward.
2. Install npm dependencies. The `postinstall` hook on the root `package.json` also installs `client/`'s dependencies.
3. Build the Vue client to `client/dist/`.
4. Restart `pm2`. The `--silent` flag suppresses chatter — failures still surface via exit code.

If any step fails, the deploy aborts mid-flight and the previous build keeps serving — `pm2` only restarts the process if the script reaches step 4.

## nginx configuration

nginx is the public-facing server. Two adjustments matter for LogisX:

- **`client_max_body_size 50m`** — necessary because the Express body limit is 50 MB to accept large base64 payloads with embedded photos and signatures. Without this, multipart uploads from drivers (large POD photos) get 413'd at the nginx layer.
- **WebSocket upgrade headers** — `proxy_set_header Upgrade $http_upgrade` and `proxy_set_header Connection "upgrade"` so Socket.IO can negotiate from polling to WebSocket transport.

TLS certificates are managed by Let's Encrypt. Renewal runs from cron.

## pm2 configuration

The `logistics-app` process is started with `pm2 start server.js --name logistics-app`. Useful pm2 commands:

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
| `npm run build:client` | Vite production build to `client/dist/` | Pre-deploy step. |

In development, run `npm run dev` and `npm run dev:client` in two terminals and open `http://localhost:5173`. In production, only `npm start` runs — Express serves the pre-built `client/dist/`.

## What lives on the VPS but not in git

- **`.env`** — environment secrets.
- **`service-account-key.json`** — Google credentials.
- **`app.db`** — SQLite database. Backed up via the manual download endpoint.
- **`uploads/`** — local copies of POD photos, receipts, signatures. (Drive holds the canonical PODs.)

Nothing else. The repo is the source of truth for code; the VPS holds runtime state.

## Hardening

Several defaults that protect the production environment:

- **`SESSION_SECRET`** is enforced — the server warns at boot if it falls back to the dev default. In production, the warning becomes a real risk.
- **Cookie flags** — `httpOnly`, `secure: true` when `NODE_ENV=production`, `sameSite: 'lax'` (tightened from `'none'` 2026-08-09; override via `SESSION_COOKIE_SAMESITE`, which defaults to `lax`).
- **`compression`** middleware gzips all responses.
- **`express-rate-limit`** caps the abusable endpoints (see backend chapter).
- **Demo viewer write lockdown** — a global middleware blocks all mutating verbs (POST/PUT/PATCH/DELETE) for a special demo role with a small whitelist for harmless idempotent operations.

## Rollback

If a deploy goes wrong:

```bash
ssh root@76.13.22.110
cd /var/www/logistics-app
git log --oneline -10                    # find the last good commit
git checkout <good-commit>               # detach HEAD to that commit
npm install --silent --no-audit --no-fund
npm run build:client --silent
pm2 restart logistics-app --silent
```

The `app.db` SQLite file is not touched by a code rollback — schema migrations are additive, so older code reads a newer schema fine. The exception is the rename-recreate migration: if you deployed code that triggered a CHECK-constraint table recreate, a rollback to older code that doesn't know about the new constraint may or may not work depending on the constraint. When in doubt, restore `app.db` from a backup.

To restore main:

```bash
git checkout main
git pull --ff-only origin main
# … rebuild and restart as in the deploy flow above
```

## Backups

There is no automated backup currently. The SQLite database can be exported by a Super Admin via `POST /api/db/download` — wired up for exactly this purpose. It is a POST and not a GET (a GET returns 405); the `curl` recipe is in Operations → Database admin tools. The Google Sheet is itself the system of record for loads and is implicitly backed up by Google.

Plan ahead for a routine snapshot of `app.db`, `.env`, `service-account-key.json`, and the contents of `uploads/`. The first three are tiny; `uploads/` can be larger depending on POD/receipt volume.

## Two-process model with staging

Both `logistics-app` (production) and `logisx-staging` (staging) run on the same VPS. They share the host but have separate `.env`, separate SQLite databases, and separate ports. This is enough isolation for "test a deploy before promoting" — not enough for "run integration tests against a fresh DB." For destructive testing, point staging at a copy of `app.db` and run `scripts/prepare-test-fixtures.js` against it before exercising it. Note there is no truncate-and-reseed path: loads come from Google Sheets, not the database, so a wiped DB cannot be rebuilt locally.
