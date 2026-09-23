# Runbook: nginx upload timeouts (driver POD uploads and receipts on cellular)

**Audience:** DevOps / whoever has SSH to the production VPS.
**Production:** VPS `76.13.22.110`, app at `/var/www/logistics-app`, pm2 process `logistics-app`, nginx terminating TLS on `app.logisx.com` and reverse-proxying to `127.0.0.1:3000`.
**Related:** [scankit-billing.md](./scankit-billing.md), [../troubleshooting/driver-pod-upload-failures.md](../troubleshooting/driver-pod-upload-failures.md).

## Symptom

Drivers on cellular cannot upload Proof of Delivery photos (or, through `POST /api/expenses`, fuel receipts). The same upload from a desktop admin on wired/Wi-Fi succeeds. The nginx access log shows:

```
# driver iPhone, weak cellular
… "POST /api/documents/upload HTTP/2.0" 499 0 …   (×4, client aborted)
# desktop admin, good link
… "POST /api/documents/upload HTTP/2.0" 200 …
```

You may also see `408` on `POST /api/documents/scan` from the same devices.

## Cause

Two different timeouts, both caused by nginx's **defaults** being shorter than the time a large POD payload needs over a slow uplink:

- **`499` — client abort.** nginx logs `499` when the client closes the connection *before nginx sends a response*. A POD upload is a large base64 image (Express body limit is 50 MB). On weak cellular the request body trickles in slowly. (The backend used to also hold the request for the POD-flag Sheets write and, on a Receipt photo, a Tesseract OCR pass; both are now deferred until after the response — see the follow-up note below.) If total round-trip time exceeds nginx's default `proxy_read_timeout` of **60s**, or the iPhone backgrounds/gives up first, the connection drops and nginx records `499`. The client-side fix retries, which is why you see it ×4.
- **`408` — request body timeout.** nginx returns `408` when the *request body* stops arriving for longer than `client_body_timeout` (default **60s**). A multi-megabyte scan/upload over a one-bar link routinely stalls that long.

The client-side fix sets an upload timeout of **~90s**. nginx's 60s defaults trip *before* the client's own 90s timeout, so the browser never gets the chance to finish or to show its own error. **nginx's timeouts must be ≥ the client's 90s upload/save timeouts.** We use **120s** for headroom.

> Note: `client_max_body_size` is a separate concern (it controls the 413 size limit, not timeouts). The live value is **`50m`** on both long-timeout blocks below — exactly Express's `express.json({ limit: "50mb" })` ceiling, so nginx and Express refuse at the same size. Change both together or neither.

## The fix — live since 2026-09-23

The four timeout directives and the body-size directive sit in **two scoped `location` blocks**, `/api/documents/` and `/api/expenses`, so only uploads, scans and expense receipts get the long window. Every other route keeps nginx's 60s defaults.

### Where the config lives

```
/etc/nginx/sites-available/app.logisx.com      # edit this file
/etc/nginx/sites-enabled/app.logisx.com        # symlink → sites-available
/root/nginx-backups/                           # backups — and ONLY here (see Apply)
/var/log/nginx/app.logisx.com.timing.log       # the timing log (see below)
```

Edit the `sites-available` file; the `sites-enabled` symlink picks up the change on reload.

### The directives

```nginx
client_body_timeout   120s;   # longest the request body may stall between reads (default 60s) — fixes 408
proxy_read_timeout    120s;   # longest Express may go silent before responding   (default 60s) — fixes 499
proxy_send_timeout    120s;   # longest a write of the request to Express may stall (default 60s)
send_timeout          120s;   # longest a write of the response to the client may stall (default 60s)
client_max_body_size  50m;    # = Express's 50mb body limit
```

**The rule:** all four 120s values must stay **≥ the client's 90s upload/save timeouts** (`client/src/composables/useUpload.js` for documents; the driver's expense save must stay inside the same bound). nginx tripping before the client's own timer *is* the original bug. If a client timeout is ever raised, raise these first.

### Live long-timeout blocks

Both blocks sit beside `location /` in the `server { … }` for `app.logisx.com`. The `/api/expenses` block is a **byte-identical copy** of the `/api/documents/` block's body — only the path differs:

```nginx
location /api/documents/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    client_max_body_size 50m;
    client_body_timeout  120s;
    proxy_read_timeout   120s;
    proxy_send_timeout   120s;
    send_timeout         120s;
}

location /api/expenses {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    client_max_body_size 50m;
    client_body_timeout  120s;
    proxy_read_timeout   120s;
    proxy_send_timeout   120s;
    send_timeout         120s;
}
```

- **`/api/expenses` has no trailing slash, on purpose.** It is a prefix match, so it covers the receipt save itself (`POST /api/expenses`) as well as `/api/expenses/ocr`, `/api/expenses/:id/…` and every other `/api/expenses…` route. `location /api/expenses/` would miss the save — and worse than miss it: for a `proxy_pass` location ending in a slash, nginx answers the slash-less URI with a `301`, and a `301` turns the receipt `POST` into a `GET`. `/api/documents/` keeps its slash because every document route has a sub-path.
- **Why both blocks repeat the proxy lines.** A `location` inherits nothing from its sibling `location /`: `proxy_pass` is never inherited, and `proxy_set_header` is inherited only from an enclosing level, and only when the block sets none of its own. So each block restates all of them, and each one is load-bearing here:
  - without `proxy_pass`, the request never reaches Express at all;
  - without `X-Forwarded-For`, Express (`app.set("trust proxy", 1)`) sees every request as `127.0.0.1`, and every IP-keyed rate limiter pools all drivers into one bucket;
  - without `X-Forwarded-Proto`, Express believes the request is plain HTTP and will not issue the production `secure` session cookie on these routes.
- **No `Upgrade` / `Connection` headers.** These are plain request/response routes; Socket.IO's WebSocket upgrade stays on `location /`.

### Timing log

`log_format logisx_timing` is defined at the top of the site file, outside `server { … }`: nginx's `combined` format plus five fields.

| Field | Variable | What it tells you |
|---|---|---|
| `rt=` | `$request_time` | Seconds from the first byte read from the phone to the log write. **Includes the upload of the body.** |
| `urt=` | `$upstream_response_time` | Seconds spent on Express. nginx buffers the whole body before contacting Express (`proxy_request_buffering` is on by default), so this **excludes** the upload: `rt − urt` ≈ time spent on the phone's link. `-` = Express was never contacted. |
| `ust=` | `$upstream_status` | The status Express answered. **`-` = Express never answered** — usually because it never received the request. |
| `rl=` | `$request_length` | Bytes received from the client, headers + body: the payload size. |
| `host=` | `$host` | The hostname that was asked for. |

It writes to `/var/log/nginx/app.logisx.com.timing.log` (`www-data:adm`, `0640`), rotated daily by the existing `/var/log/nginx/*.log` logrotate rule. The `server` block also restates `access_log /var/log/nginx/access.log;` — declaring **any** `access_log` in a `server` block stops it inheriting the shared one, so without that line the site would silently vanish from `access.log`.

**Reading it:**

- **`408` with `ust=-`** — the upload **stalled before Express got it**: the phone sent nothing for 120s mid-body. Nothing reached the app, so a retry cannot duplicate anything.
- **`rt` near 120** — a 120s timeout was hit. These are gap timers (the time between two successive reads or writes), not a cap on the whole transfer: a slow-but-steady upload may run past 120s and still succeed; 120s of silence will not.
- **`499` with `rt` near 90** — the client's own 90s timer gave up first. If `urt` is a number, nginx had already handed Express the whole body, so the upload may well have been saved — and the client's retry is what makes a duplicate.
- **`rl`** — the payload size. A multi-page POD is several MB of base64; compare against normal uploads on the same route.

```bash
sudo tail -f /var/log/nginx/app.logisx.com.timing.log | grep --line-buffered -E '"(POST|PUT) /api/(documents|expenses)'
```

### Apply

Back up first, **into `/root/nginx-backups/` and nowhere else** — never `sites-available/`, and never anywhere under `/etc/nginx/`. `sites-enabled/*` is included wholesale, so a copy that lands there loads as a second `server` for `app.logisx.com`, and a copy in `sites-available/` is one symlink away from the same thing.

```bash
ssh root@76.13.22.110
mkdir -p /root/nginx-backups
cp /etc/nginx/sites-available/app.logisx.com /root/nginx-backups/app.logisx.com.$(date -u +%Y%m%dT%H%M%SZ)
# … edit /etc/nginx/sites-available/app.logisx.com …
sudo nginx -t                 # validate config — DO NOT reload if this fails
sudo systemctl reload nginx   # graceful reload, zero dropped connections
```

`nginx -t` must print `syntax is ok` / `test is successful` before you reload. A reload (not restart) re-reads the config without dropping in-flight connections.

## Verify

1. Watch a real cellular upload in the timing log (it carries the status plus `rt`/`urt`/`ust`/`rl`):

   ```bash
   sudo tail -f /var/log/nginx/app.logisx.com.timing.log | grep --line-buffered -E "/api/(documents|expenses)"
   ```

2. Have a driver (or a phone on cellular with Wi-Fi off) upload a POD. Confirm the line now ends in **`200`**, not `499`:

   ```
   … "POST /api/documents/upload HTTP/2.0" 200 …    ← fixed
   ```

3. Cross-check the app side — no upload error in pm2 logs for that window:

   ```bash
   pm2 logs logistics-app --lines 100
   ```

4. (Optional) Confirm the blocks, the directives and the timing log are live:

   ```bash
   sudo nginx -T 2>/dev/null | grep -E "location /api/(documents|expenses)|proxy_read_timeout|client_body_timeout|send_timeout|client_max_body_size|logisx_timing"
   ```

## Rollback

The change is self-contained — reverting is safe and instant.

1. Restore the backup taken before the change. For the 2026-09-23 change it is `/root/nginx-backups/app.logisx.com.20260923T042020Z`; restoring it removes the `/api/expenses` block and the timing log, and keeps `/api/documents/`, which predates it. Back up the current file first — into the same directory:

   ```bash
   cp /etc/nginx/sites-available/app.logisx.com /root/nginx-backups/app.logisx.com.$(date -u +%Y%m%dT%H%M%SZ)
   cp /root/nginx-backups/app.logisx.com.20260923T042020Z /etc/nginx/sites-available/app.logisx.com
   ```

   To drop just one `location` block instead, delete that block; the other and the timing log keep working.

2. Validate and reload:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

Removing a block restores nginx's 60s defaults for that path. No app restart, no data impact — nginx config is fully reversible.

## Notes / follow-ups

- **The backend half is already done.** Neither the POD-column write to Google Sheets nor receipt OCR is on the upload's critical path: `POST /api/documents/upload` sends the response first, then performs the Sheets write in `setImmediate` and queues a Receipt photo's OCR through `queueReceiptOcr()`. This runbook remains the deploy-time mitigation for slow-uplink bodies, which nginx timeouts still govern.
- These timeouts only need to be this generous on the upload routes. Do not raise site-wide timeouts further than necessary — a long `proxy_read_timeout` everywhere lets a wedged backend tie up worker connections.
