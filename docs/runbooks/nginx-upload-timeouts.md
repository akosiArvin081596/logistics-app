# Runbook: nginx upload timeouts (driver POD uploads on cellular)

**Audience:** DevOps / whoever has SSH to the production VPS.
**Production:** VPS `76.13.22.110`, app at `/var/www/logistics-app`, pm2 process `logistics-app`, nginx terminating TLS on `app.logisx.com` and reverse-proxying to `127.0.0.1:3000`.
**Related:** [scankit-billing.md](./scankit-billing.md), [../troubleshooting/driver-pod-upload-failures.md](../troubleshooting/driver-pod-upload-failures.md).

## Symptom

Drivers on cellular cannot upload Proof of Delivery photos. The same upload from a desktop admin on wired/Wi-Fi succeeds. The nginx access log shows:

```
# driver iPhone, weak cellular
… "POST /api/documents/upload HTTP/2.0" 499 0 …   (×4, client aborted)
# desktop admin, good link
… "POST /api/documents/upload HTTP/2.0" 200 …
```

You may also see `408` on `POST /api/documents/scan` from the same devices.

## Cause

Two different timeouts, both caused by nginx's **defaults** being shorter than the time a large POD payload needs over a slow uplink:

- **`499` — client abort.** nginx logs `499` when the client closes the connection *before nginx sends a response*. A POD upload is a large base64 image (Express body limit is 50 MB). On weak cellular the request body trickles in slowly **and** the backend holds the request while it writes the POD flag to Google Sheets on the critical path (`server.js`, `POST /api/documents/upload` — a Sheets header `get` + cell `update` are `await`ed before the JSON response). If total round-trip time exceeds nginx's default `proxy_read_timeout` of **60s**, or the iPhone backgrounds/gives up first, the connection drops and nginx records `499`. The client-side fix retries, which is why you see it ×4.
- **`408` — request body timeout.** nginx returns `408` when the *request body* does not fully arrive within `client_body_timeout` (default **60s**). A multi-megabyte scan/upload over a one-bar link routinely takes longer than that.

The client-side fix sets an upload timeout of **~90s**. nginx's 60s defaults trip *before* the client's own 90s timeout, so the browser never gets the chance to finish or to show its own error. **nginx's timeouts must be ≥ the client's 90s upload timeout.** We use **120s** for headroom.

> Note: `client_max_body_size` is a separate concern (it controls the 413 size limit, not timeouts). The live config already has `client_max_body_size 55M`, which is fine — it is ≥ the Express 50 MB body limit. We pin it to `50m` below only to keep nginx and Express in lockstep; leaving `55M` also works.

## The fix

Add the four timeout directives (and confirm the body-size directive) to the upload route. Scoping them to `location /api/documents/` keeps the long timeouts off the rest of the site — only uploads/scans get the generous window.

### Where the config lives

```
/etc/nginx/sites-available/app.logisx.com      # edit this file
/etc/nginx/sites-enabled/app.logisx.com        # symlink → sites-available
```

Edit the `sites-available` file; the `sites-enabled` symlink picks up the change on reload.

### Directives to add

```nginx
client_body_timeout   120s;   # time allowed for the request body to arrive (default 60s) — fixes 408
proxy_read_timeout    120s;   # time allowed for the backend to respond     (default 60s) — fixes 499
proxy_send_timeout    120s;   # time allowed to send the request to backend  (default 60s)
send_timeout          120s;   # time allowed between writes to the client    (default 60s)
client_max_body_size  50m;    # match Express's 50mb body limit (current 55M is also fine)
```

All four timeouts (120s) are **≥** the client's 90s upload timeout — this is the load-bearing requirement.

### Copy-pasteable block

A more specific `location` does **not** inherit `proxy_pass` or the WebSocket/proxy headers from the parent `location /`, so the block below repeats them. Drop this `location /api/documents/` block into the `server { … }` for `app.logisx.com`, alongside the existing `location /`:

```nginx
# --- POD / document uploads: long timeouts for big payloads on slow cellular ---
location /api/documents/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    # standard reverse-proxy headers (match the existing location /)
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # uploads are large base64 images; raise the size + timeout ceilings
    client_max_body_size 50m;     # match Express express.json({limit:"50mb"}) — 55M also fine
    client_body_timeout  120s;    # ≥ client 90s upload timeout — fixes 408 on slow links
    proxy_read_timeout   120s;    # ≥ client 90s upload timeout — fixes 499 (client abort)
    proxy_send_timeout   120s;
    send_timeout         120s;
}
```

If you would rather not duplicate the proxy headers, put the five directives in the **`server` block** instead (they apply site-wide then). The scoped `location` is preferred so a hung non-upload request can't sit for 120s.

### Apply

```bash
ssh root@76.13.22.110
sudo nginx -t            # validate config — DO NOT reload if this fails
sudo systemctl reload nginx   # graceful reload, zero dropped connections
```

`nginx -t` must print `syntax is ok` / `test is successful` before you reload. A reload (not restart) re-reads the config without dropping in-flight connections.

## Verify

1. Tail the access log and watch a real cellular upload:

   ```bash
   sudo tail -f /var/log/nginx/access.log | grep --line-buffered "/api/documents/upload"
   ```

2. Have a driver (or a phone on cellular with Wi-Fi off) upload a POD. Confirm the line now ends in **`200`**, not `499`:

   ```
   … "POST /api/documents/upload HTTP/2.0" 200 …    ← fixed
   ```

3. Cross-check the app side — no upload error in pm2 logs for that window:

   ```bash
   pm2 logs logistics-app --lines 100
   ```

4. (Optional) Confirm the directives are live:

   ```bash
   sudo nginx -T 2>/dev/null | grep -E "proxy_read_timeout|client_body_timeout|send_timeout|client_max_body_size"
   ```

## Rollback

The change is a self-contained block — reverting is safe and instant.

1. Re-edit `/etc/nginx/sites-available/app.logisx.com` and remove the `location /api/documents/` block you added (or delete just the five directives if you put them in the `server` block). Keep a copy first:

   ```bash
   sudo cp /etc/nginx/sites-available/app.logisx.com /etc/nginx/sites-available/app.logisx.com.bak.$(date +%F)
   ```

2. Validate and reload:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

Removing the block restores nginx's 60s defaults. No app restart, no data impact — nginx config is fully reversible.

## Notes / follow-ups

- The deeper fix is on the backend: the POD-column write to Google Sheets is currently `await`ed on the upload's critical path (`server.js`, `POST /api/documents/upload`). Moving it off the hot path (respond as soon as the file is persisted locally, write the sheet flag after) would shrink request time and reduce 499s independent of nginx. Tracked in [../troubleshooting/driver-pod-upload-failures.md](../troubleshooting/driver-pod-upload-failures.md). This runbook is the deploy-time mitigation; that is the code-time fix.
- These timeouts only need to be this generous on the document routes. Do not raise site-wide timeouts further than necessary — a long `proxy_read_timeout` everywhere lets a wedged backend tie up worker connections.
