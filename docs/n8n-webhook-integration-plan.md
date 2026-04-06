# Plan: n8n → LogisX API Webhook Integration

## Context
Currently n8n writes load data to the **original** Google Sheet (`1ey1n0AAG...` "Dispatch Management"), but the LogisX app reads from a **copy** (`1WCiMmcI7...` "Copy of Dispatch Management"). This causes data drift — 8 loads exist in the original but not the copy, and the copy has 252 extra duplicate rows.

The fix: have n8n POST extracted load data to the LogisX app's API via a new webhook endpoint. The app then writes to Google Sheets AND stores coordinates in SQLite — single source of truth, no dual-sheet problem.

## Spreadsheet Comparison (as of 2026-04-05)

| Aspect | Current (app) | Original (n8n) |
|--------|--------------|-----------------|
| Title | Copy of Dispatch Management | Dispatch Management |
| ID | `1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI` | `1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo` |
| Job Tracking rows | 563 | 311 |
| Unique Load IDs | 220 | 228 |
| Extra columns | Contract ID, Origin Lat/Lng, Dest Lat/Lng | — |
| Payments Table | 295 rows | 318 rows (+23) |
| Carrier Database | Identical | Identical |
| Loads only in Original | — | 8 loads (545832787, 544815878, 545402904, 532427871, 532077325, 520019580, 515762482, 516197359) |

## Current Blockers
- App uses **session-based auth only** — no API keys, no bearer tokens
- **No CORS** configured — external requests blocked
- **No public/webhook endpoints** — all POST endpoints require `requireRole()`
- n8n cloud is stateless — cannot maintain Express session cookies

## Changes

### 1. Add API Key middleware (server.js ~line 710)
```javascript
function requireApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.N8N_API_KEY) {
        return res.status(401).json({ error: "Invalid API key" });
    }
    next();
}
```
Add `N8N_API_KEY` to `.env` file with a generated secret.

### 2. Create webhook endpoint (server.js ~line 2060)
```
POST /webhook/n8n/load
Auth: x-api-key header
```

Accepts the exact fields n8n extracts:
```json
{
  "loadId": "514964283",
  "details": "Beverages, 44,430 lbs, 1,808 pallets",
  "driver": "Kenrick Davis",
  "pickupInfo": "COCO COLA SOUTHWEST BEVERAGES",
  "pickupAppointment": "5/20/2025 16:00",
  "pickupAddress": "10220 ELLA BLVD, HOUSTON, TX 77038",
  "dropoffInfo": "FOSSIL CREEK COMBO CENTER, TX",
  "dropoffAppointment": "5/21/2025 09:00",
  "dropoffAddress": "3400 FOSSIL CREEK BLVD., Fort Worth, TX 76137",
  "payment": "$610.00",
  "brokerContactName": "Danna Garcia",
  "phone": "",
  "email": "Danna.Garcia@chrobinson.com",
  "documents": "514964283",
  "assignedDate": "4/5/2026, 12:39:40 PM",
  "rate": "610.00"
}
```

The endpoint will:
1. Map fields to Google Sheet column order (reuse existing header-matching regex from POST /api/data)
2. Use `appendOrUpdate` logic — check if Load ID exists, update if so, append if not
3. Auto-geocode pickup and dropoff addresses → store in `load_coordinates` table
4. Store payment in both Job Tracking AND Payments Table sheets
5. Emit Socket.IO event `load-created` or `load-updated` for real-time dashboard updates
6. Return `{ success: true, loadId, action: "created" | "updated" }`

### 3. Add CORS for webhook route only (server.js ~line 30)
```javascript
app.options("/webhook/*", (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, x-api-key");
    res.sendStatus(204);
});
```
Only open CORS on `/webhook/*` routes — keep existing routes unchanged.

### 4. Update .env
```
N8N_API_KEY=<generated-uuid-or-secret>
```

### 5. Update n8n Dispatch v2 workflow
Replace the **JOB DETAILS ENTRY** (Google Sheets appendOrUpdate) node with an **HTTP Request** node that POSTs to:
```
https://logistics-app.abedubas.dev/webhook/n8n/load
Headers: x-api-key: <the-api-key>
Body: JSON with extracted fields
```

Also replace or remove the **RATE UPDATE** node (Payments Table write) — the webhook endpoint handles both sheets.

## Files to modify
- `server.js` — add `requireApiKey` middleware, add `POST /webhook/n8n/load` endpoint, add CORS for webhook
- `.env` — add `N8N_API_KEY`
- `Dispatch-v2.json` — replace Google Sheets nodes with HTTP Request to webhook

## Verification
1. `node --check server.js`
2. Deploy to VPS
3. Test with curl:
   ```
   curl -X POST https://logistics-app.abedubas.dev/webhook/n8n/load \
     -H "Content-Type: application/json" \
     -H "x-api-key: <key>" \
     -d '{"loadId":"TEST-001","pickupAddress":"Houston, TX","dropoffAddress":"Dallas, TX","payment":"500"}'
   ```
4. Verify row appears in Google Sheet Job Tracking
5. Verify `load_coordinates` table has geocoded coordinates
6. Update n8n Dispatch v2 to use the webhook instead of Google Sheets
7. Trigger n8n manually → verify end-to-end flow

## Advantages
- **Single source of truth** — app controls all writes to Google Sheets
- **Auto-geocoding** — coordinates stored in SQLite immediately
- **Duplicate detection** — built-in Load ID dedup
- **Real-time updates** — Socket.IO notifies dashboard instantly
- **No dual-sheet drift** — n8n and app both use the same sheet
