# Troubleshooting: driver POD upload failures

End-to-end map of why driver Proof-of-Delivery uploads fail — usually on cellular — and which layer fixes each failure. Use this to triage; the per-layer runbooks have the step-by-step.

**The chain:** driver phone (camera → base64 image → `useUpload.js` / `DocumentUpload.vue`) → cellular → nginx (`app.logisx.com`, TLS + reverse proxy) → Express (`server.js`, `POST /api/documents/upload` and `POST /api/documents/scan`) → Google Sheets / Drive / ScanKit.io.

A failure can come from any link. The tell is **which device fails**: if a desktop admin on Wi-Fi succeeds with the same load while the driver's iPhone on cellular fails, the problem is timeout/payload related, not a code bug.

## Symptom → cause → fix matrix

| Symptom (where seen) | Root cause | Layer that fixes it | Runbook / file |
|---|---|---|---|
| `POST /api/documents/upload` → **`499`** from driver iPhone on cellular (often ×4), but **`200`** from desktop admin | Large base64 POD payload over a slow uplink **+** nginx default `proxy_read_timeout` is only 60s → client aborts before the response. (The backend used to also hold the request for the POD-flag Sheets write and, on a **Receipt** photo, a Tesseract OCR pass; both are **fixed** — see below.) | **nginx** (raise timeouts ≥ 90s); **frontend** (payload size + retry) reduces how often it's hit | [nginx-upload-timeouts.md](../runbooks/nginx-upload-timeouts.md); `server.js` `POST /api/documents/upload`; `client/src/composables/useUpload.js`, `client/src/components/.../DocumentUpload.vue` |
| `POST /api/documents/scan` → **`402`** (`scan_no_credits`); scans silently fall back to raw photos | ScanKit account is out of credits (charged per successful scan; 4xx not billed/retried) | **ScanKit billing** — top up credits (no redeploy) | [scankit-billing.md](../runbooks/scankit-billing.md) |
| `POST /api/documents/scan` → **`408`** from driver on a slow link | Request body didn't fully arrive within nginx default `client_body_timeout` (60s) | **nginx** (`client_body_timeout ≥ 90s`) | [nginx-upload-timeouts.md](../runbooks/nginx-upload-timeouts.md) |
| `POST /api/documents/scan` → **`503`** (`scan_unavailable`) | ScanKit disabled (`SCANKIT_ENABLED=false`) or `SCANKIT_API_KEY` unset — by design; driver attaches raw photo | **config** — flip `SCANKIT_ENABLED=true` + set key, if scanning is supposed to be on | [scankit-billing.md](../runbooks/scankit-billing.md) (kill-switch section); `.env.example` |
| `POST /api/documents/upload` → **`413`** | Payload over nginx `client_max_body_size` (live: 55M) or Express 50 MB limit | **nginx** body-size (rare; current 55M ≥ 50 MB Express limit) / **frontend** image compression | [nginx-upload-timeouts.md](../runbooks/nginx-upload-timeouts.md) |
| `POST /api/documents/upload` → **`403`** ("This load is not assigned to you") | Driver uploading against a load not assigned to them (security guard, working as intended) | none — verify the load assignment | `server.js` `loadBelongsToDriver` |
| `POST /api/documents/upload` (or `POST /api/expenses`, or any other driver load route) → **`503`** `LOAD_OWNERSHIP_UNVERIFIED` ("Couldn't verify this load right now — please try again.") | The ownership check could not **read** Job Tracking (or `deleted_loads`), so it cannot say whose load this is. Fail-closed — nothing was written — but it is not a refusal, and `useUpload.js` retries a 5xx on its own. **Older logs:** until this was split out, the same read failure answered the `403` above, so a historical 403 is **not** proof the load belonged to someone else. | none if transient; if it persists, Google Sheets health (command 2: `[load-ownership] could not verify`) | `server.js` `loadBelongsToDriver()` / `sentIfLoadOwnershipUnverified()`; `scripts/test-load-ownership-guard.js` |

## Why desktop works but cellular fails

This is the signature of the production incident and worth calling out:

- **Payload size.** A POD is a multi-megabyte base64 image (Express body limit is `express.json({limit:"50mb"})`). On Wi-Fi it uploads in a second or two; on one-bar cellular it can take tens of seconds.
- **Backend on the critical path — the slow parts are FIXED; know what is left.** Two slow steps used to run before `POST /api/documents/upload` responded, and neither does now:
  - **The POD Sheets write.** The route `await`ed a Google Sheets header `get` **and** a cell `update`. It now sends `res.json(...)`, logs `[upload] 200 sent; deferring POD sheet update row N`, and does the Sheets write inside `setImmediate` afterwards — resolving the target row **by loadId** rather than trusting the client's `rowIndex`. A failure there logs `Sheet POD column update error (non-critical)` and never touches the response.
  - **Receipt OCR** (`docType` **Receipt** photos only — never POD, BOL or Other). The route `await`ed a Tesseract pass — a fresh worker per upload, plus a CDN fetch of its language data when not cached — to fill an `ocrText` response field **no client read**. `queueReceiptOcr()` now runs it after the response, one receipt at a time, and fills `documents.ocr_text` by id; `DocumentList` shows it on its next load. A failure logs `deferred receipt OCR failed for document N (non-critical)`; the receipt itself is already saved.

  Still before the response, and deliberately: the **load-ownership check** (a Job Tracking read — served from the 60 s cache, but a cold miss is a full-tab Sheets read of a few seconds), image → PDF conversion, the disk write, and one SQLite insert. The cold-cache read is the only third-party round trip left. Verify with `grep -n "deferring POD sheet update\|queueReceiptOcr(" server.js`.
- **nginx 60s defaults.** Add the slow uplink to the inline Sheets latency and total round-trip time can cross nginx's default 60s `proxy_read_timeout` / `client_body_timeout`. nginx (or the backgrounded iPhone) drops the connection → access log records `499`. The client's own ~90s timeout never gets a chance to fire because nginx's 60s window closes first.

**Three independent levers, in order of effort:**

1. **nginx (deploy-time, do first):** raise the document-route timeouts to 120s so they exceed the client's 90s upload timeout. See [nginx-upload-timeouts.md](../runbooks/nginx-upload-timeouts.md). This is the immediate mitigation.
2. **Frontend resilience:** `useUpload.js` / `DocumentUpload.vue` should compress the image before upload, set the ~90s timeout, and retry on transient failure. Smaller payloads cross the wire faster and trip fewer timeouts.
3. ~~**Backend fast-return (durable fix)**~~ — **already shipped.** The response is sent before the Sheets write and before receipt OCR; neither is on the critical path. What remains on it is listed above.

## Diagnostic commands

Run from an SSH session on the VPS (`ssh root@76.13.22.110`).

**1. nginx access log — are uploads 200 or 499?**

```bash
sudo grep "/api/documents/upload" /var/log/nginx/access.log | tail -50
# watch live during a test upload:
sudo tail -f /var/log/nginx/access.log | grep --line-buffered "/api/documents/"
```

Look at the status code at the end of each line: `200` = success, `499` = client aborted (timeout/abort), `408` = body timeout, `413` = too large.

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
- `deferred receipt OCR failed for document N (non-critical)` / `receipt OCR skipped for document N` — the receipt **was** saved; only its OCR text is missing.

**3. ScanKit health — credits / enabled / errors:**

```bash
node scripts/diag-scankit-health.js     # against a running server; prints the full health payload
```

Or hit `GET /api/scankit/health` directly with a Super Admin session. Check:
- `noCreditsSince` non-null → out of credits → [scankit-billing.md](../runbooks/scankit-billing.md).
- `enabled:false` / `hasKey:false` → kill switch or missing key.
- `errorsLast24h` climbing with `lastError` set → ScanKit-side trouble.

**4. Confirm nginx has the timeout directives live:**

```bash
sudo nginx -T 2>/dev/null | grep -E "proxy_read_timeout|client_body_timeout|send_timeout|client_max_body_size"
```

## Escalation order

1. Confirm device pattern (cellular fails, desktop works) → points at timeout/payload, not a bug.
2. Check the nginx access log (command 1). If `499`/`408` → apply [nginx-upload-timeouts.md](../runbooks/nginx-upload-timeouts.md).
3. If scans specifically fail with `402` → [scankit-billing.md](../runbooks/scankit-billing.md). Remember scanning failure never blocks the POD; the raw photo still uploads.
4. Check `pm2 logs` for backend errors (command 2) — rule out a Sheets/Drive outage.
5. If uploads still time out after nginx timeouts are raised, the cause is **not** the Sheets write or receipt OCR — both are already deferred. Look at payload size (a multi-page POD is several MB of base64) and link quality, then escalate.
