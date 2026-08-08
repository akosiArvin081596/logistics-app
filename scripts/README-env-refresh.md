# Environment refresh — local and staging

Rebuilds **local** and **staging** from current `main` plus a trimmed, sanitized copy of
production data, so a change can be exercised against realistic data before it ships.

```bash
# LOCAL — run from the repo root on your machine
./scripts/refresh-local.sh

# STAGING — run ON the VPS, from /var/www/logisx-staging
cd /var/www/logisx-staging && ./scripts/refresh-staging.sh --yes           # stage it
cd /var/www/logisx-staging && ./scripts/refresh-staging.sh --yes --restart # and restart pm2
```

**Bootstrapping staging before these scripts are on `main`.** `refresh-staging.sh` runs
`git reset --hard origin/main`, which rewrites the working tree it is executing from — so on the
first run, when `main` does not yet contain these files, copy both into an untracked directory
inside the staging tree and run from there:

```bash
scp scripts/refresh-env.js scripts/refresh-staging.sh <vps>:/var/www/logisx-staging/.env-refresh-tmp/
ssh <vps> 'cd /var/www/logisx-staging && bash .env-refresh-tmp/refresh-staging.sh --yes --restart'
```

That path specifically, not `/tmp`: `git reset --hard` leaves untracked files alone, and node
resolves `require()` from the *module's* directory upwards, so a copy in `/tmp` cannot find
`better-sqlite3`. The script handles being invoked from its own stash directory.

Both wrappers call `scripts/refresh-env.js`, which does the database half and holds every
safety gate. You can call it directly:

```bash
node scripts/refresh-env.js --from <snapshot.db|.gz> --to <app.db> --yes-non-prod \
     [--telemetry-days N | --telemetry-all] [--allow-mail] [--dry-run] [--no-backup]
```

---

## Why this exists

Measured 2026-08-08:

| | Local | Staging (`logisx-staging`) | Production (`logistics-app`) |
|---|---|---|---|
| git | `main`, current | **`develop` @ `e3efd78` (2026-07-24), 89+ commits behind** | `main` @ `83ab986` |
| `SPREADSHEET_ID` | `156Y5-…` (LOCAL) | `1Ny1q0nY-sYxgjH_4KqzEdWXUNp8etfW7M-G7h_MNA9Y` | **unset → hardcoded production default** |
| `app.db` | 313 MB | **639 KB**, last written 2026-07-24 | 313 MB + 93 MB WAL |
| `routemate_telemetry` | 933k rows | **0** | 933,893 rows |
| feature flags | most off | **none set** | all 9 on |

Staging could not validate anything. With zero telemetry, the driver-pay "active days" basis,
fuel-event detection, the range/MPG math and geofence departure all take their *fallback*
branches; and the tables `period_locks`, `fuel_events`, `fuel_event_alerts`,
`ratecon_reconcile_alerts`, `investor_payout_history` and `fuel_price_cache` did not exist at
all, so month-end close and the whole fuel-honesty wave had nothing to run against.

---

## The source is the nightly snapshot, never the live database

`--from` should be a file from `/var/www/logistics-app/backups/` — the output of
`scripts/backup-db.js`, which uses SQLite's Online Backup API and has already passed
`PRAGMA integrity_check`. Nothing in this refresh opens a file production is writing to.
Both wrappers pick the newest `app.db.*.gz` automatically.

---

## Safety gates

`refresh-env.js` refuses, before it reads a single row:

| Gate | Refuses when |
|---|---|
| Deployed path | `--to` is inside `/var/www/logistics-app` (deliberately narrower than `prepare-test-fixtures.js`'s blanket `/var/www` refusal — `/var/www/logisx-staging` is a legitimate target) |
| `NODE_ENV` | `NODE_ENV=production` |
| Explicit opt-in | `--yes-non-prod` absent |
| **Spreadsheet** | the `.env` beside `--to` has **no** `SPREADSHEET_ID`, or has the production one |
| **Mail** | that `.env` has both `GMAIL_USER` and `GMAIL_APP_PASSWORD` (override: `--allow-mail`) |
| **Money** | that `.env` has `INVOICE_AUTOGEN_ENABLED=true` |
| Integrity | the rebuilt database fails `integrity_check`, or the post-sanitization assertions find a routable address, a surviving session, or a surviving bank account number |

The spreadsheet gate is the one that matters. `server.js` falls back to the production sheet
whenever `SPREADSHEET_ID` is unset, so **the override is the safety** — a refreshed database
sitting next to an `.env` without one is a production writer on first boot. The gate reads the
`.env` the server will actually load rather than trusting the directory name, for the same
reason the staging sheet is *titled* "logisx-production" and is not: **identify by ID, never by
name.**

Nothing is deleted without a fallback — the previous `app.db` is renamed to
`app.db.pre-refresh-<stamp>` (with its `-wal`/`-shm`, which belong to the old database and
would be read as corruption if left beside the new one). Use `--dry-run` to see the plan and
the row counts without replacing anything.

---

## Database copy strategy — recommendation

**Default: `--telemetry-days 45`. Recommended for both local and staging.**

Production is ~936,000 rows, of which **933,893 (99.7%) are `routemate_telemetry`** — also the
known performance hotspot. Everything else in the database is small: the next largest table is
`audit_trail` at 1,372 rows.

Measured on the 2026-08-08 snapshot:

| Mode | Telemetry rows | Result |
|---|---|---|
| `--telemetry-all` | 933,893 | ~299 MB |
| `--telemetry-days 45` *(default)* | 518,911 | **145 MB** |
| `--telemetry-days 0` | 0 | ~15 MB |

45 days covers the current month and the whole of the previous one, which is what settlement
and every open payout period actually read. The cut is made against the newest row **in the
snapshot**, not wall-clock now, so a snapshot restored a week later still yields the window you
asked for.

### The tradeoff, plainly

Trimming telemetry does **not** zero historical driver pay — it does something less obvious and
more misleading. `getEldTravelDaysByVehicle()` is *coverage-aware*: a load window with **no**
ELD pings is treated as "this truck was never instrumented" and falls back to the **full
scheduled window**, whereas a window that is covered but shows no movement correctly yields 0.
So for months older than the cutoff:

- driver pay flips from `eld`/`mixed` to `estimated` and is billed for **every scheduled day**,
  i.e. it comes out **higher** than production;
- investor payouts, which net driver pay off revenue, therefore come out **lower**;
- `EarningsSection.vue` renders the "estimated" badge instead of "ELD-verified", which is at
  least an honest signal that the number is not production's.

This is bounded in practice: `period_locks` already holds 15 finalized months, and a finalized
or paid payout row is frozen — the reconcile will not refresh it. The drift is confined to
periods still open, which the 45-day window covers anyway. **But do not use a trimmed copy to
reconcile a historical month against production.** Use `--telemetry-all` for that.

Also affected by a short window:

- **Fuel events / burn legs.** `fuel_events` rows are copied as-is, but re-running the sweep
  over a trimmed table finds fewer refuel episodes, so `burnRateForVehicle()` has fewer legs
  and the `measured` range basis rests on a thinner sample. 45 days still leaves plenty
  (verified: `GET /api/fuel/verify` returned all 3 instrumented trucks).
- **Live tracking and trails.** Unaffected — both read the newest rows.
- **Geofencing.** Unaffected — it evaluates each incoming ping.

Use `--telemetry-all` when you are specifically testing telemetry-scale performance or
reconciling old months; the only cost is ~150 MB and a slower vacuum.

---

## Sanitization — what is scrubbed and why

The copy contains real driver and investor PII, bank details and live session rows. Applied on
every run, and asserted afterwards (a sanitizer that silently no-ops is worse than none,
because it produces a file everyone believes is clean):

| Data | Treatment | Why |
|---|---|---|
| `sessions` | deleted | A session row caches the user record, so a survivor authenticates against the **old** hash — clearing them is what makes the re-hash below take effect. Forces re-login. |
| `users.password_hash` | all replaced with `Password123!` | bcrypt is not reversible, but these *are* production's live credentials. A copy on a laptop is a copy of production authentication. Uses the same password as `prepare-test-fixtures.js` and `test-suite.js`, so the harness runs with no extra step. |
| `demo_viewer` | deleted | Super Admin role, password published in a public repo, gated only by a method check. Removed from production 2026-08-04; a copy is the same hole. |
| Email — `users`, `drivers_directory`, `investors`, `investor_applications`, `investor_outreach_log`, `job_applications` | rewritten to `<id-or-username>@invalid` | `.invalid` is RFC 2606 reserved and **can never resolve**, so even a misconfigured mailer cannot deliver. Per-row rather than a single constant, so accounts stay distinguishable. |
| Phone / cell | `555-0100` | NANP reserved fictional range. |
| Bank routing + account numbers, account/check names (`investor_payment_info`, `driver_payment_info`) | emptied / `REDACTED` | Nothing computes from them; they are only displayed or printed. No test value, unlimited downside. |
| `ein_ssn`, `ssn`, `dob`, `drivers_license`, personal `address` | emptied / `REDACTED` | Same. |
| `signature_text`, `signature_image` | `REDACTED` / emptied | A legal artefact, and as base64 the bulk of the onboarding tables. |
| `investor_applications.access_token` | regenerated | These are **live bearer credentials** for the public onboarding flow. Regenerating means a leaked copy cannot be replayed against production, and a production link cannot be replayed against staging. |
| `driver_locations` | emptied | Retired 2026-05-13; no endpoint reads or writes it. Pure historical position PII. |

**Deliberately not scrubbed:**

- `geocode_cache.address`, `load_coordinates.pickup_address` / `dropoff_address` — shipper and
  receiver *facilities*, i.e. business locations, not personal contact details. They are also
  the only coordinate source geofencing has (`checkGeofence`'s sheet columns do not exist), so
  scrubbing them disables the feature you would be trying to test.
- `trucks.license_plate`, `trailers.license_plate`, `routemate_vehicles.license_num` — company
  asset identifiers; the ELD linkage keys off adjacent columns.
- `messages` / `notifications` bodies — operational content, worth exercising at realistic volume.

### The environment half

Scrubbing the database is only half. A staging box holding production's Gmail app password can
email a real driver the moment a code path fires, whatever the database says — so
`refresh-env.js` **refuses to run** against an `.env` that has both `GMAIL_USER` and
`GMAIL_APP_PASSWORD`, or `INVOICE_AUTOGEN_ENABLED=true`, and warns on `N8N_*` secrets. Staging
currently has none of these, which is correct; keep it that way.

### ⚠️ `GOOGLE_DRIVE_FOLDER_ID` was the leak nobody was looking for

Until 2026-08-08 staging's `.env` held the **same** `GOOGLE_DRIVE_FOLDER_ID` as production, so
every POD or document uploaded on staging was written into the **production** Drive folder. The
spreadsheet was correctly separated and the Drive folder silently was not. It is now empty on
staging, which is a supported configuration — uploads skip Drive and the local-first `documents`
row still records them. **Check this whenever you stand up a new environment: separating the
sheet is not the same as separating the storage.**

The `GEMINI_API_KEY` is likewise shared with production (verified by hash). That is left in
place because expense OCR is not flag-gated and would be untestable without it, and
`expenseOcrLimiter` bounds the spend — but be aware staging OCR draws on production's quota,
and an exhausted key took rate-con ingestion down on 2026-08-05.

### Flags actually set on staging (2026-08-08)

Production runs nine. Staging runs the three that compute purely against its own sanitized
SQLite copy; the other six are held off because each can reach a real person, move money, spend
a shared billed key, or is inert without a credential staging deliberately lacks:

| Flag | Staging | Why |
|---|---|---|
| `PERIOD_FINALIZE_ENABLED` | **on** | Month-close math, local DB only. |
| `FUEL_EVENTS_ENABLED` | **on** | Telemetry sweep, local DB only. Needed for `rangeBasis:'measured'`. |
| `MAINTENANCE_NOTICE_ENABLED` | **on** | UI copy only. |
| `INVOICE_AUTOGEN_ENABLED` | off | Auto-submits invoices on a timer and emails a summary. Moves money. `refresh-env.js` refuses an `.env` that has it on. |
| `RATECON_RECONCILE_ENABLED` | off | Connects to the real `info@logisx.com` mailbox and **sends alert mail**. |
| `FUEL_GALLONS_RECOVERY_ENABLED` | off | Spends billed Gemini calls on the shared key, and reads receipt images from `uploads/`, which staging does not have. The read-only GET proposal works regardless. |
| `SCANKIT_ENABLED` | off | No key here, and it is credit-billed. |
| `ROUTEMATE_ENABLED` | off | No key here; would only log errors. Superseded by the Linxup push path. |
| `LINXUP_ENABLED` | off | No token here, and Linxup pushes to production's endpoint. Inert either way. |

Recommended non-production `.env` (staging shown; local is the same with the LOCAL sheet id):

```
PORT=3003
SPREADSHEET_ID=1Ny1q0nY-sYxgjH_4KqzEdWXUNp8etfW7M-G7h_MNA9Y
ARCHIVE_SPREADSHEET_ID=1IG3yTknz91EesmyMog-d63UT5LkmpBYxHFEWSuDlgn8
GOOGLE_DRIVE_FOLDER_ID=                 # EMPTY on purpose — see the warning above
SESSION_SECRET=<anything non-production>
PERIOD_FINALIZE_ENABLED=true
FUEL_EVENTS_ENABLED=true
MAINTENANCE_NOTICE_ENABLED=true
# deliberately absent: GMAIL_USER, GMAIL_APP_PASSWORD, N8N_WEBHOOK_SECRET,
#                      N8N_EXTRACT_SECRET, INVOICE_AUTOGEN_ENABLED
```

`NODE_ENV` is deliberately **unset** on staging: `server.js` only reads it to decide session
cookie `secure` / `sameSite`, and unset gives `secure:false` + `sameSite:'lax'`, which is what
staging needs over plain HTTP. Setting it to `production` there would 401 every login.

---

## Known gaps

- **`uploads/` is not copied.** Receipt images, PODs and rate-con PDFs live on disk, and the
  database only stores paths. So `expenses.photo_data` points at files a refreshed environment
  does not have: receipts 404 and the gallons-recovery routes have nothing to OCR. Copy the
  tree separately if you need it (`rsync -a <vps>:/var/www/logistics-app/uploads/ ./uploads/`) —
  it is large and contains unredacted scans of real documents, so treat it as PII.
- **Sheet data is not copied.** Loads live in Google Sheets, not `app.db`. The LOCAL and
  staging sheets are separate copies that drift from production independently; this script does
  not touch them.
- **`--allow-mail` scrubs addresses but does not stop sending.** It only suppresses the refusal.

## Verified

Run end-to-end on 2026-08-08 against the `app.db.20260808_020003.gz` snapshot: 298.8 MB →
**144.6 MB**, `integrity_check ok`, 12 users re-hashed, 10 emails redirected, 46 contact fields
neutralized, 28 bank/tax redactions, 34 signatures cleared, 3 access tokens regenerated, 6
sessions cleared. Booted on port 3011 against the LOCAL sheet: server up, 11 tabs cached, 279
load coordinates populated, login succeeded with the reset password, `/api/dashboard` returned
live KPIs, `/api/fuel/verify` backtested all 3 instrumented trucks, and `/api/periods` showed
the real close calendar (July pending, June finalized).
