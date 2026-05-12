# Integrations

LogisX leans on several external services. This chapter covers each integration, why it's there, how it's authenticated, and how to recover if it goes down.

## Google Sheets — system of record for loads

The "Job Tracking" tab in spreadsheet `1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo` is where every active load lives. The spreadsheet is shared with the service account `sheets-bot@logistics-app-491014.iam.gserviceaccount.com` as Editor.

**Auth.** A JSON service-account key at the project root (`service-account-key.json`, not in git). The Google API client is lazy-initialized as a singleton via `getSheets()`.

**Quota.** 300 requests per minute per project. The 60-second in-memory cache (`getJobTrackingCached()`) is the practical throttle — without it, a dashboard refresh fan-out could blow the quota in seconds.

**Write semantics.** `valueInputOption: "USER_ENTERED"` so spreadsheet formulas in payloads are interpreted, not treated as literal strings. Rows are 1-indexed (row 1 = headers, row 2+ = data). DELETE converts to 0-indexed for the Sheets `batchUpdate` `deleteDimension` call.

**Sheet ID caching.** Tab GIDs are looked up once per process and cached in a `Map` to avoid repeated metadata API calls.

**Recovery.** If a row write fails partway (the network drops between the read and the write), the sheet may be left in an intermediate state. The status update endpoint guards against this by reading the entire sheet, verifying the Load ID at the given row index still matches, and falling back to a load-ID scan if not.

## Google Drive — POD storage

Driver-uploaded proof-of-delivery photos are converted to PDF via `imageToPdf()` (pdfkit) and uploaded to a single shared folder identified by `GOOGLE_DRIVE_FOLDER_ID`. The returned Drive file ID is stored in `documents.drive_file_id` so we can render a "View on Drive" link later.

**If `GOOGLE_DRIVE_FOLDER_ID` is unset**, the upload silently skips Drive and stores only the local copy. This is the path used in development.

**Scopes.** `drive.file` only — the service account can read and write only files it created, not the whole Drive.

## Google Maps — routing, geocoding, weather

Three Maps APIs are in use:

- **Directions** for live route calculation on `/api/route`.
- **Geocoding** for converting Pickup/Drop-off addresses into lat/lng. Results are cached forever in the `geocode_cache` SQLite table.
- **Places** for the address autocomplete in driver/investor application forms.

A small `/api/weather` proxy exists as well — though it uses a different provider, the API key is on the same shared key store.

**Auth.** A single API key in `GOOGLE_MAPS_API_KEY`. Exposed to the frontend via `GET /api/config/maps-key` so it doesn't need to ship at build time. The key should be restricted to LogisX's domains in Google Cloud Console (this is currently parked until Cloud Console access is provisioned).

**Geocode cache.** Hits return immediately; misses call the Maps API and persist the result. There is no TTL — addresses don't change. To force a re-geocode, delete the row from `geocode_cache`.

## Google Gemini 2.5 Flash — receipt OCR

Drivers can photograph a fuel or repair receipt and the form pre-fills from a Gemini vision call. The integration lives at `POST /api/expenses/ocr`.

**Why Gemini and not Tesseract.** Tesseract was the first attempt. Accuracy on phone-camera receipts was too low — wrong totals, miscoded vendors, missing odometer readings. Gemini 2.5 Flash, called with a `responseSchema` so the API itself enforces the JSON shape we expect, dramatically outperforms Tesseract on this task.

**Auth.** `GEMINI_API_KEY` in `.env`. Called via `fetch` (no SDK), with a 15-second `AbortController` timeout and two retries on backoff — same pattern as the Routemate client.

**Output.** A structured `{amount, date, vendor, gallons, odometer, suggestedType, confidence}` object. The driver's form prefills these fields, the driver confirms or edits, and only then is the expense saved.

**Cost gate.** `expenseOcrLimiter` caps each user to 20 OCR calls per 15 minutes.

**Graceful degradation.** When `GEMINI_API_KEY` is unset, the endpoint returns 503 and the form silently falls back to manual entry. The user experience is "OCR was unavailable" rather than "the app broke."

## n8n — broker email ingestion

When a broker emails a Rate Confirmation to `info@logisx.com`, an n8n workflow parses the PDF and posts a structured payload to `POST /api/n8n/job`. The server appends a new row to the Job Tracking sheet with status `Unassigned`, and a `dispatch-notification` socket event fires immediately so dispatchers see the new load without refreshing.

**Auth.** Shared secret in the `x-webhook-secret` header. Matches `N8N_WEBHOOK_SECRET` from `.env`. n8n stores the secret in its own credentials.

**Endpoints.**
- `POST /api/n8n/job` — primary ingestion path.
- `POST /api/webhook/new-load` — secondary, used for re-pushing after manual fixes in n8n.

**Replay.** A `replay-via-webhook-injection.js` script (committed alongside the n8n workflows) lets us re-run a single message through the pipeline when a workflow change should be applied retroactively.

**PDF parsing.** The actual PDF parsing happens inside n8n using LlamaParse, with a "Validate Parse Quality" node that gates on confidence before posting downstream. The server doesn't see the PDF — it only receives the structured payload.

## Routemate — ELD telematics (off by default)

Routemate is FMCSA-certified ELD hardware in each truck. LogisX pulls live GPS, fuel diagnostics, fault codes, and DVIR reports from their cloud REST API.

**Adapter.** A single point of contact at `lib/routemate-client.js`. Every server-side caller goes through this adapter, never direct. The adapter handles auth (`X-Api-Key` header), retry/backoff, and a 15-second `AbortController` timeout — same template as the Gemini client.

**Master switch.** `ROUTEMATE_ENABLED` in `.env`. **Defaults to off.** All sync intervals are dormant and the manual probe returns 503 until this is flipped on.

**Pull cadence.** Three intervals, each configurable:

- `ROUTEMATE_POLL_LIVE_SEC` (60) — live telemetry sync.
- `ROUTEMATE_POLL_FAULTS_SEC` (300) — fault-code sync.
- `ROUTEMATE_POLL_DAILY_HOUR` (4) — daily rollups (MPG, HOS).

**Tables.** Six SQLite tables, all `IF NOT EXISTS` (additive, reversible):

- `routemate_vehicles` — local mirror of the Routemate vehicle inventory.
- `routemate_telemetry` — append-only GPS feed.
- `routemate_fault_codes` — one row per active code per vehicle.
- `routemate_dvir` — DVIR inspection reports.
- `routemate_fuel_daily` — telemetry-derived MPG rollup.
- `routemate_hos_daily` — driver duty-time rollup.

**Linking trucks.** Each truck row in the `trucks` table has a `routemate_vehicle_id` column. Admins set this in the Trucks UI to link a LogisX truck to a Routemate vehicle.

**Live GPS source priority.** `GET /api/locations/latest` prefers a Routemate telemetry row younger than 5 minutes over the phone-based `driver_locations` row. The response is tagged with `source: 'routemate' | 'phone'` so consumers can show provenance. Old consumers that ignore `source` continue to work because the response shape is otherwise unchanged.

**Phone GPS as fallback.** `useGeolocation.js` and `POST /api/location` are untouched by Routemate — they remain the fallback path. If Routemate goes down, phone GPS takes over with no code change.

## Tesseract — legacy POD OCR

Tesseract still runs on POD image uploads only (`POST /api/documents/upload`). It exists in case the POD photo contains a stamp or signature we want to capture as text. Errors are silently swallowed — OCR failure never blocks the underlying upload.

Tesseract was previously used for expense receipts as well, but was unwired once accuracy turned out to be too low. That path now goes to Gemini.

## Nodemailer — outbound email

Used by:

- Driver onboarding acceptance emails.
- Investor outreach campaigns (`/api/investor-outreach/send`).

**Auth.** `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env`. Standard Gmail app password — the account itself is `info@logisx.com`.

## Putting it together — a load's lifecycle

```
Broker email → n8n parses PDF → POST /api/n8n/job (x-webhook-secret)
    └─► Sheet row appended (status: Unassigned)
            └─► Socket "dispatch-notification" → admin notifications panel
                    └─► Dispatcher assigns driver in /dashboard
                            └─► Socket "load-assigned" → driver phone
                                    └─► Driver taps Accept
                                            └─► Driver phone GPS → POST /api/location
                                                    └─► (Routemate, if enabled, also reporting)
                                                            └─► Geofence enters pickup → status auto-advances
                                                                    └─► Driver uploads POD → Drive upload
                                                                            └─► Status: Delivered
                                                                                    └─► Super Admin generates invoice (pdf-lib/pdfkit)
                                                                                            └─► Approve → payment
```

Every external system in that chain is replaceable: swap the email parser, change the GPS source, move the POD store. The integration boundaries are narrow enough (a webhook, an API call, a file upload) that this is mostly a one-file edit per replacement.
