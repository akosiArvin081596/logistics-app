# Troubleshooting: driver POD upload failures

End-to-end map of why driver Proof-of-Delivery uploads fail — usually on cellular — and which layer fixes each failure. Use this to triage; the per-layer runbooks have the step-by-step.

**The chain:** driver phone (camera → base64 image → `useUpload.js` / `DocumentUpload.vue`) → cellular → nginx (`app.logisx.com`, TLS + reverse proxy; long-timeout `location` blocks for `/api/documents/` **and** `/api/expenses`) → Express (`server.js`, `POST /api/documents/upload` and `POST /api/documents/scan`; a fuel receipt logged from the expense form rides `POST /api/expenses` instead) → Google Sheets / Drive / ScanKit.io.

A failure can come from any link. The tell is **which device fails**: if a desktop admin on Wi-Fi succeeds with the same load while the driver's iPhone on cellular fails, the problem is timeout/payload related, not a code bug.

## Symptom → cause → fix matrix

| Symptom (where seen) | Root cause | Layer that fixes it | Runbook / file |
|---|---|---|---|
| `POST /api/documents/upload` (or `POST /api/expenses`, a fuel receipt) → **`499`** from driver iPhone on cellular (often ×4), but **`200`** from desktop admin | Large base64 POD payload over a slow uplink **+** nginx default `proxy_read_timeout` was only 60s → client aborts before the response. (The backend used to also hold the request for the POD-flag Sheets write and, on a **Receipt** photo, a Tesseract OCR pass; both are **fixed** — see below.) | **nginx** — live since 2026-09-23: **120s** on `/api/documents/` and `/api/expenses` (must stay ≥ the client's 90s); **frontend** (payload size + retry) reduces how often it's hit | [nginx-upload-timeouts.md](../runbooks/nginx-upload-timeouts.md); `server.js` `POST /api/documents/upload`; `client/src/composables/useUpload.js`, `client/src/components/.../DocumentUpload.vue` |
| `POST /api/documents/scan` → **`402`** (`scan_no_credits`); scans silently fall back to raw photos | ScanKit account is out of credits (charged per successful scan; 4xx not billed/retried) | **ScanKit billing** — top up credits (no redeploy) | [scankit-billing.md](../runbooks/scankit-billing.md) |
| `POST /api/documents/scan` (or `/upload`, or `POST /api/expenses`) → **`408`** from driver on a slow link | The request body stalled for longer than `client_body_timeout` — now **120s** on both long-timeout blocks (was the 60s default). In the timing log a `408` with `ust=-` never reached Express, so nothing was written | **nginx** — already raised; a 408 now means the phone's link went silent for 2 minutes | [nginx-upload-timeouts.md](../runbooks/nginx-upload-timeouts.md) (Timing log) |
| `POST /api/documents/scan` → **`503`** (`scan_unavailable`) | ScanKit disabled (`SCANKIT_ENABLED=false`) or `SCANKIT_API_KEY` unset — by design; driver attaches raw photo | **config** — flip `SCANKIT_ENABLED=true` + set key, if scanning is supposed to be on | [scankit-billing.md](../runbooks/scankit-billing.md) (kill-switch section); `.env.example` |
| `POST /api/documents/upload` (or `POST /api/expenses`) → **`413`** | Payload over nginx `client_max_body_size` (live: `50m` on both long-timeout blocks) or the Express 50 MB limit | **nginx** body-size (rare; `50m` = Express's 50 MB, so both refuse at the same size) / **frontend** image compression | [nginx-upload-timeouts.md](../runbooks/nginx-upload-timeouts.md) |
| `POST /api/documents/upload` → **`403`** ("This load is not assigned to you") | Driver uploading against a load not assigned to them (security guard, working as intended) | none — verify the load assignment | `server.js` `loadBelongsToDriver` |
| `POST /api/documents/upload` (or `POST /api/expenses`, or any other driver load route) → **`503`** `LOAD_OWNERSHIP_UNVERIFIED` ("Couldn't verify this load right now — please try again.") | The ownership check could not **read** Job Tracking (or `deleted_loads`), so it cannot say whose load this is. Fail-closed — nothing was written — but it is not a refusal, and `useUpload.js` retries a 5xx on its own. **Older logs:** until this was split out, the same read failure answered the `403` above, so a historical 403 is **not** proof the load belonged to someone else. | none if transient; if it persists, Google Sheets health (command 2: `[load-ownership] could not verify`) | `server.js` `loadBelongsToDriver()` / `sentIfLoadOwnershipUnverified()`; `scripts/test-load-ownership-guard.js` |

## Why desktop works but cellular fails

This is the signature of the production incident and worth calling out:

- **Payload size.** A POD is a multi-megabyte base64 image (Express body limit is `express.json({limit:"50mb"})`). On Wi-Fi it uploads in a second or two; on one-bar cellular it can take tens of seconds.
- **Backend on the critical path — the slow parts are FIXED; know what is left.** Two slow steps used to run before `POST /api/documents/upload` responded, and neither does now:
  - **The POD Sheets write.** The route `await`ed a Google Sheets header `get` **and** a cell `update`. It now sends `res.json(...)`, logs `[upload] 200 sent; deferring POD sheet update row N`, and does the Sheets write inside `setImmediate` afterwards — resolving the target row **by loadId** rather than trusting the client's `rowIndex`. A failure there logs `Sheet POD column update error (non-critical)` and never touches the response.
  - **Receipt OCR** (`docType` **Receipt** photos only — never POD, BOL or Other). The route `await`ed a Tesseract pass — a fresh worker per upload, plus a CDN fetch of its language data when not cached — to fill an `ocrText` response field **no client read**. `queueReceiptOcr()` now runs it after the response, one receipt at a time, each in its own short-lived OCR process (never inside the server), and fills `documents.ocr_text` by id; `DocumentList` shows it on its next load. A failure logs `deferred receipt OCR failed for document N (non-critical)`; the receipt itself is already saved.

  Still before the response, and deliberately: the **load-ownership check** (a Job Tracking read — served from the 60 s cache, but a cold miss is a full-tab Sheets read of a few seconds), image → PDF conversion, the disk write, and one SQLite insert. The cold-cache read is the only third-party round trip left. Verify with `grep -n "deferring POD sheet update\|queueReceiptOcr(" server.js`.
- **~~nginx 60s defaults.~~ Raised to 120s on 2026-09-23** for `/api/documents/` and `/api/expenses` (every other route keeps 60s). Before that, a slow uplink plus backend time could cross the default 60s `proxy_read_timeout` / `client_body_timeout`; nginx (or the backgrounded iPhone) dropped the connection → `499`, and the client's own ~90s timeout never got a chance to fire because nginx's 60s window closed first. The 120s values must stay **≥ the client's 90s upload/save timeouts** — see [nginx-upload-timeouts.md](../runbooks/nginx-upload-timeouts.md).

**Three independent levers, in order of effort:**

1. ~~**nginx (deploy-time, do first)**~~ — **live since 2026-09-23:** 120s on `/api/documents/` and `/api/expenses`, above the client's 90s upload timeout, plus a timing log that records request time and size per request. See [nginx-upload-timeouts.md](../runbooks/nginx-upload-timeouts.md).
2. **Frontend resilience:** `useUpload.js` / `DocumentUpload.vue` should compress the image before upload, set the ~90s timeout, and retry on transient failure. Smaller payloads cross the wire faster and trip fewer timeouts.
3. ~~**Backend fast-return (durable fix)**~~ — **already shipped.** The response is sent before the Sheets write and before receipt OCR; neither is on the critical path. What remains on it is listed above.

## Diagnostic commands

Run from an SSH session on the VPS (`ssh root@76.13.22.110`).

**1. nginx timing log — status, request time and size for each upload:**

```bash
sudo grep -E '"(POST|PUT) /api/(documents|expenses)' /var/log/nginx/app.logisx.com.timing.log | tail -50
# watch live during a test upload:
sudo tail -f /var/log/nginx/app.logisx.com.timing.log | grep --line-buffered -E "/api/(documents|expenses)"
```

Status codes: `200` = success, `499` = client aborted (timeout/abort), `408` = body timeout, `413` = too large. The five extra fields say why:

- `rt=` — total seconds, **including** the body upload; `urt=` — seconds spent on Express (`rt − urt` ≈ time on the phone's link).
- `ust=` — Express's own status; **`-` = Express never answered** (usually never received the request).
- `rl=` — bytes received: the payload size.
- A `408` with `ust=-` stalled before Express got it; an `rt` near **120** hit an nginx timeout; a `499` with `rt` near **90** is the client's own timer giving up. Full guide: [nginx-upload-timeouts.md → Timing log](../runbooks/nginx-upload-timeouts.md#timing-log).

The shared `/var/log/nginx/access.log` still carries the plain lines (`sudo grep "/api/documents/upload" /var/log/nginx/access.log | tail -50`) — the site restates it deliberately — but it has no timing fields.

**2. App logs — backend errors during the failing window:**

```bash
pm2 logs logistics-app --lines 200
# or scoped to recent errors
pm2 logs logistics-app --lines 500 | grep -iE "upload|scan|sheet|error"
```

Ask the driver for the approximate time of the failure and look at that window. A `Sheet POD column update error (non-critical)` line means the deferred Sheets call failed (it won't have blocked the upload, but it indicates Sheets latency/quota pressure).

```bash
pm2 logs logistics-app --lines 500 | grep -E "load-ownership|receipt OCR"
```

- `[load-ownership] could not verify load "…": Job Tracking read failed — …` — the ownership check could not read the sheet; the driver got a retryable **503**, not a 403. A burst of these is a Sheets outage, not a permissions problem.
- `deferred receipt OCR failed for document N (non-critical)` / `receipt OCR skipped for document N` — the receipt **was** saved; only its OCR text is missing. The reason follows the colon:
  - `…is over the 25 MP limit` / `…dimensions could not be read` — OCR was not attempted.
  - `receipt OCR timed out` — the job hit its 90 s deadline and its process was killed. A first-ever job also downloads the model, and a failed download looks like this.
  - `receipt OCR process exited (…)` — the OCR process died. The server did not. If it died while loading the model, the cached model is cleared so the next receipt fetches a fresh copy.

**3. ScanKit health — credits / enabled / errors:**

```bash
node scripts/diag-scankit-health.js     # against a running server; prints the full health payload
```

Or hit `GET /api/scankit/health` directly with a Super Admin session. Check:
- `noCreditsSince` non-null → out of credits → [scankit-billing.md](../runbooks/scankit-billing.md).
- `enabled:false` / `hasKey:false` → kill switch or missing key.
- `errorsLast24h` climbing with `lastError` set → ScanKit-side trouble.

**4. Confirm nginx has both long-timeout blocks, their directives and the timing log live:**

```bash
sudo nginx -T 2>/dev/null | grep -E "location /api/(documents|expenses)|proxy_read_timeout|client_body_timeout|send_timeout|client_max_body_size|logisx_timing"
```

## Escalation order

1. Confirm device pattern (cellular fails, desktop works) → points at timeout/payload, not a bug.
2. Check the nginx timing log (command 1). The timeouts are already 120s, so read the fields rather than re-raising them: `408` + `ust=-` = the body stalled on the phone's link; `499` with `rt` ≈ 90 = the client gave up first; a large `urt` = Express itself was slow. See [nginx-upload-timeouts.md](../runbooks/nginx-upload-timeouts.md).
3. If scans specifically fail with `402` → [scankit-billing.md](../runbooks/scankit-billing.md). Remember scanning failure never blocks the POD; the raw photo still uploads.
4. Check `pm2 logs` for backend errors (command 2) — rule out a Sheets/Drive outage.
5. If uploads still time out with the 120s timeouts in place, the cause is **not** the Sheets write or receipt OCR — both are already deferred. Look at payload size (a multi-page POD is several MB of base64) and link quality, then escalate.
