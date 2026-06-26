# Runbook: ScanKit out of credits (driver document scanning)

**Audience:** DevOps + whoever holds the ScanKit.io billing login.
**Production:** VPS `76.13.22.110`, app at `/var/www/logistics-app`, pm2 process `logistics-app`. ScanKit env lives in `/var/www/logistics-app/.env`.
**Related:** [nginx-upload-timeouts.md](./nginx-upload-timeouts.md), [../troubleshooting/driver-pod-upload-failures.md](../troubleshooting/driver-pod-upload-failures.md).

## What ScanKit does

ScanKit.io crops, deskews, and lighting-corrects a document photo server-side (optionally returning a searchable OCR PDF). It powers the driver POD/BOL scanner, the admin dashboard upload, and receipt enhancement before Gemini OCR. The app talks to it only through `lib/scankit-client.js` (`POST /scan/crop`), called by `POST /api/documents/scan` in `server.js`. The key is server-side only and never reaches the client.

**Scanning is an enhancement, not a gate.** If ScanKit is unavailable for any reason, the driver app falls back to attaching the **raw photo** and the POD still uploads. The only difference is image quality (crop/deskew/lighting), never whether the load can be closed.

## Symptom

- Drivers report their scans look "unprocessed" — the document isn't cropped/straightened; the raw camera photo is what gets attached.
- `app.logisx.com/api/documents/scan` returns **`402`** (`{"error":"scan_no_credits"}`).
- The admin health check `GET /api/scankit/health` shows a non-null **`noCreditsSince`** timestamp.

The fallback is silent by design — drivers are not blocked, so this can run for a while before anyone notices. The health endpoint is how you catch it.

## How ScanKit billing works

- **Credit-billed, per successful scan.** Each successful `POST /scan/crop` (HTTP 2xx) consumes one credit. When the account balance hits zero, ScanKit returns **HTTP 402**.
- **4xx errors are NOT billed and NOT retried.** Per `lib/scankit-client.js`: `codeForStatus()` maps `402 → SCANKIT_NO_CREDITS`, and the retry loop **fails fast on any 4xx that isn't 429** (`if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw err`). So a `402` is thrown immediately, with no retry and no credit charge — running out of credits costs nothing and does not hammer ScanKit. Only `429` (rate limit) and `5xx` are retried with backoff.
- **Server mapping.** `server.js` (`POST /api/documents/scan`) catches `SCANKIT_NO_CREDITS` and returns **`402 {"error":"scan_no_credits"}`** to the client. The client treats that as "enhancement unavailable" and attaches the raw photo.

So: out-of-credits is a clean, cheap, self-contained failure. Nothing is lost; scans just stop being enhanced until you top up.

## Fix: top up credits

1. Sign in to the **ScanKit.io dashboard** (billing login held by the team — not in this repo).
2. Go to **Billing / Credits** and purchase a credit top-up (or enable auto-recharge so this doesn't recur).
3. No app restart or redeploy is needed — the next scan request uses the same key against the now-funded account and succeeds. Credits are account-level, not tied to the running process.

> **Cost note:** topping up spends real money on the ScanKit account. Confirm with the account owner before purchasing if you are not the budget holder.

## Kill switch: `SCANKIT_ENABLED=false`

The master switch lives in `/var/www/logistics-app/.env`. Setting `SCANKIT_ENABLED=false` (or leaving `SCANKIT_API_KEY` unset) makes `POST /api/documents/scan` return **`503`** (`{"error":"scan_unavailable"}`) instead of calling ScanKit at all.

**When to flip it off:**
- ScanKit is having a sustained outage (lots of `5xx`/timeouts in `errorsLast24h`) and you want to skip the retry/timeout delay entirely so drivers fall back instantly.
- A billing dispute or hard stop where you do not want any further spend.
- **The API key is exposed/compromised** — disable, then rotate (see below).

**Effect either way (`402` out-of-credits *or* `503` disabled):** identical from the driver's seat — the scanner skips enhancement and attaches the raw photo, and the POD uploads normally. The driver is never blocked. The only thing lost is auto-crop/deskew/lighting on that photo.

To apply a `.env` change:

```bash
ssh root@76.13.22.110
cd /var/www/logistics-app
# edit .env (set SCANKIT_ENABLED=false, or true after recovery)
pm2 restart logistics-app --silent
```

## Verify recovery

Use the admin health endpoint `GET /api/scankit/health` (Super Admin session). Locally/against a running server you can use the bundled diagnostic:

```bash
node scripts/diag-scankit-health.js
```

It prints `enabled / hasKey / baseUrl / lastScan / noCreditsSince / errorsLast24h / lastError`. After a top-up, confirm on the **next successful scan**:

- **`noCreditsSince`** flips back to `null` (it clears the moment a scan succeeds again).
- **`lastScan`** updates to the current timestamp.
- **`enabled: true`** and **`hasKey: true`** (sanity check the key is still wired).
- **`errorsLast24h`** stops climbing.

If `noCreditsSince` does not clear after a top-up, the most likely cause is that the credits landed on a *different* ScanKit account than the one whose key is in `.env`. Confirm the dashboard account matches the `SCANKIT_API_KEY` in use.

## Key rotation (if exposed)

ScanKit is credit-billed, so a leaked key is a spend risk, not just an access risk. **Rotate immediately if the key is ever exposed** (committed, logged, shared in a ticket, etc.):

1. In the ScanKit.io dashboard, revoke the old key and issue a new one (`sk_...`).
2. Update `SCANKIT_API_KEY` in `/var/www/logistics-app/.env`.
3. `pm2 restart logistics-app --silent`.
4. Confirm via `GET /api/scankit/health` that `hasKey: true` and the next scan succeeds (`lastScan` updates, `lastError` is clear).

The key must never be committed to git — it belongs only in `.env` (git-ignored) and the secret store. `.env.example` documents the variable, not the value.
