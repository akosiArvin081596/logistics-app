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

Both wrappers call `scripts/refresh-env.js`, which does the database half and holds every
safety gate. You can call it directly:

```bash
# install: snapshot -> sanitized local/staging app.db, in one pass
node scripts/refresh-env.js --from <snapshot.db|.gz> --to <app.db> --yes-non-prod \
     [--telemetry-days N | --telemetry-all] [--allow-mail] [--dry-run] [--no-backup]

# the pieces refresh-local.sh drives, each runnable on its own
node scripts/refresh-env.js --check-env-only --to <app.db>            # gates, reads no data
node scripts/refresh-env.js --sanitize-only --from <snap> --emit <out.gz>   # run ON the VPS
node scripts/refresh-env.js --verify <file.db|.gz> [--strict-scan]    # assert, read-only
node scripts/refresh-env.js --from <sanitized.gz> --to <app.db> --from-sanitized --yes-non-prod
```

---

## ⚠️ The sanitizer runs on the VPS, before the file moves

Until 2026-08-09 `refresh-local.sh` did this:

```
scp <production snapshot>  ->  laptop        # UNREDACTED
node refresh-env.js --from … --to app.db     # redact, here
```

Every gate below was real and every assertion held. The sanitizer simply ran one step too
late: by the time the first SSN was overwritten, a complete plaintext copy of every SSN,
EIN, bank routing and account number in the business had already been written to a
developer's disk. The intermediate lived in `$TMPDIR` behind a `trap … EXIT`, which a
crash, a `SIGKILL` or a closed lid does not run.

The order is now:

| # | step | where | what moves |
|---|---|---|---|
| 1 | `--check-env-only` | laptop | nothing — no connection is opened yet |
| 2 | code (`git`, `npm`, client build) | laptop | — |
| 3 | `--sanitize-only` into a mode-700 temp dir, asserted there | **VPS** | nothing |
| 4 | `scp` | → laptop | **the sanitized `.gz`, and only it** |
| 5 | remove the remote temp dir (always, pass or fail) | VPS | — |
| 6 | `--verify` the received file | laptop | — |
| 7 | `--from-sanitized` install | laptop | — |

Points worth keeping:

- **Step 1 before step 3 is the load-bearing part.** An `.env` that would boot against the
  production sheet, send real mail, or auto-submit invoices stops the run while the data is
  still on the server. `--check-env-only` cannot open a database at all, so a refusal is
  structurally incapable of having moved anything first.
- **There is no fallback to sanitizing locally.** If step 3 cannot run, the script fails. A
  fallback that copies the raw snapshot and redacts it on the laptop is precisely the
  behaviour being removed, and it would be taken every time the remote step got flaky.
- **The laptop re-asserts rather than trusting the sender.** `--from-sanitized` re-runs the
  same checks and *refuses to install* a dirty artifact. If that ever fires, the remote pass
  silently did not run — find out why; do not work around it.
- **`--sanitize-only` skips the target-environment gates on purpose**, and gets two of its
  own instead: it refuses `--from` the live `/var/www/logistics-app/app.db`, and refuses to
  `--emit` anywhere inside the production application directory. It installs into no
  environment, so a gate about somebody else's `.env` would be decorative there — and a
  decorative gate is one people learn to bypass.
- **The remote workspace is `/var/tmp`, not `/tmp`.** `/tmp` on this VPS is a 3.9 GB tmpfs
  and the box already runs with swap ~90% used; materializing a ~313 MB database there, plus
  VACUUM scratch, plus the gzip output, takes ~700 MB out of RAM on a production host.
- **Cleanup is a local trap, not a remote one.** A remote `trap … EXIT` only fires inside the
  ssh session that set it, so a dropped connection would strand the working copy — the exact
  failure this change exists to fix. Abandoned `/var/tmp/logisx-sanitize.*` directories are
  reported at the start of the next run.
- **`refresh-staging.sh` is unchanged and does not need this.** Its source and target are on
  the same box, so nothing crosses a network; it keeps the single-pass form.

Proof, offline and reproducible: `node scripts/test-sanitize-before-transfer.js` seeds a
scratch database with invented SSNs/EINs/routing numbers, runs the real script in the real
modes, and greps the emitted artifact for every planted value. 30 assertions.

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

| Gate | Refuses when | Applies to |
|---|---|---|
| Deployed path | `--to` **or `--emit`** is inside `/var/www/logistics-app` (deliberately narrower than `prepare-test-fixtures.js`'s blanket `/var/www` refusal — `/var/www/logisx-staging` is a legitimate target) | all modes |
| **Live source** | `--from` is the live production `app.db` (or its `-wal`/`-shm`). The header always claimed this and nothing enforced it; `--sanitize-only` runs one directory away from that file, so the claim had to become a check | all modes |
| `NODE_ENV` | `NODE_ENV=production` | modes that install |
| Explicit opt-in | `--yes-non-prod` absent | modes that install |
| **Spreadsheet** | the `.env` beside `--to` has **no** `SPREADSHEET_ID`, or has the production one | install, `--check-env-only` |
| **Mail** | that `.env` has both `GMAIL_USER` and `GMAIL_APP_PASSWORD` (override: `--allow-mail`) | install, `--check-env-only` |
| **Money** | that `.env` has `INVOICE_AUTOGEN_ENABLED=true` | install, `--check-env-only` |
| Integrity | the file fails `integrity_check` | all modes that open one |
| **Assertions** | any scrubbed column still holds a value — see below | sanitize, `--verify`, install |

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

### The assertions, and why they are tiered

One function (`collectLeaks`) is used by all three places that need to answer "is this file
safe to move?" — the sanitize pass, `--verify`, and `--from-sanitized` before it installs.
Written once on purpose: a second copy is a second thing to forget when a column joins the
scrub list, and the entire value of these checks is that they fail when the scrub silently
stops covering something.

**Hard failures** — a named column the sanitizer owns is still populated. Precise, so a hit
is always a refusal: `investor_payment_info.routing_number` / `.account_number`,
`driver_payment_info.bank_routing` / `.bank_account`, `investors.ein_ssn`,
`investor_applications.ein_ssn`, `job_applications.ssn` / `.drivers_license`; a non-`@invalid`
address in any of the seven redirected email columns; any surviving `sessions` or
`driver_locations` row.

**Advisories** — a free-text sweep over every text column for SSN-shaped strings and routable
addresses. It reads columns nobody scrubs (`messages.body`, `audit_trail.details`), where a
broker's address is ordinary operational content rather than a leak. Failing on those would
make refusal routine on real data, and a routine refusal gets flagged away within a week.
`--strict-scan` promotes them for callers who know their data has none. A hit inside a column
the scrub *does* own is never advisory.

⚠️ **The sweep matches `###-##-####` only, never a bare 9-digit run.** Load ids in this system
are exactly nine digits (`562620213`, `563593554`), so a 9-digit rule would flag the Job
Tracking mirror on every single run — which is how a checker gets muted.

### The environment half

Scrubbing the database is only half. A staging box holding production's Gmail app password can
email a real driver the moment a code path fires, whatever the database says — so
`refresh-env.js` **refuses to run** against an `.env` that has both `GMAIL_USER` and
`GMAIL_APP_PASSWORD`, or `INVOICE_AUTOGEN_ENABLED=true`, and warns on `N8N_*` secrets. Staging
currently has none of these, which is correct; keep it that way.

Recommended non-production `.env` (staging shown; local is the same with the LOCAL sheet id):

```
PORT=3003
SPREADSHEET_ID=1Ny1q0nY-sYxgjH_4KqzEdWXUNp8etfW7M-G7h_MNA9Y
ARCHIVE_SPREADSHEET_ID=1IG3yTknz91EesmyMog-d63UT5LkmpBYxHFEWSuDlgn8
NODE_ENV=development        # required, or every auth smoke test 401s
SESSION_SECRET=<anything non-production>
# deliberately absent: GMAIL_USER, GMAIL_APP_PASSWORD, N8N_WEBHOOK_SECRET,
#                      N8N_EXTRACT_SECRET, INVOICE_AUTOGEN_ENABLED
# safe to enable for testing: PERIOD_FINALIZE_ENABLED, FUEL_EVENTS_ENABLED,
#                             MAINTENANCE_NOTICE_ENABLED, SCANKIT_ENABLED (billed)
```

---

## Already-downloaded copies — what to do about the ones the old flow left

Fixing the flow does nothing about the copies it already made. Anyone who ran
`refresh-local.sh` before 2026-08-09 may still hold unredacted production PII, in up to four
places — and note that the fourth has nothing to do with this flow, so "I never ran the old
refresh" does not clear it:

1. **`$TMPDIR/tmp.XXXXXXXX/prod-snapshot.gz`** — the raw download. The old script removed it
   with `trap … EXIT`, which covers a normal exit and a `Ctrl-C`, but **not** a crash, a
   `SIGKILL`, an OOM kill, or a closed lid mid-transfer. On macOS these survive under
   `/var/folders/…/T/` until the OS decides otherwise, which can be weeks.
2. **`app.db.pre-refresh-<stamp>`** in the checkout — every refresh renames the previous
   database aside. Later ones are sanitized copies of sanitized copies and are harmless; the
   **first** one predates any sanitizing at all and is a full production database.
3. **`app.db` itself**, if it was ever built by hand from a snapshot rather than by this
   script.
4. **`$TMPDIR/app_backup-<ms>-<hex>.db`** — nothing to do with the refresh flow. `GET
   /api/db/download` copies the whole database into `os.tmpdir()` per request and unlinks it
   after a **completed** response, so every download that was cancelled, timed out or hit a
   dropped connection left a full ~313 MB unsanitized database behind. Per-request names mean
   they **accumulate** rather than overwrite, and `app_backup*.db` is gitignored, so nothing
   else in the repo notices them. Added to `--scan-legacy` on 2026-08-09; a scan run before
   that date did not look for them.

**Recommendation — classify, then delete; do not delete blind.** `--verify` answers the
question directly, read-only, printing counts and column names but never values:

```bash
./scripts/refresh-local.sh --scan-legacy          # list the candidates
node scripts/refresh-env.js --verify <path>       # exit 0 = clean, exit 1 = NOT sanitized
rm -f <the ones that came back dirty>             # and their -wal / -shm
```

**Deliberately not automatic.** A refresh script does not get to delete a database it did not
create: one of those paths is somebody's working `app.db`, and another may be the only copy of
a state someone is mid-debug on. The cost of a wrong automatic `rm` here is unbounded and the
cost of one manual command is a minute. `--scan-legacy` therefore reports and prints the
commands; it never removes anything.

Two things it cannot reach, worth saying plainly: a copy that has been moved somewhere the
scan does not look, and any copy already synced to iCloud/Dropbox/Time Machine. If a laptop
with one of these has been lost, the retention fix and this flow change do not help — that is
an incident, and the answer is credential rotation, not a script.

---

## Backup directory permissions

`scripts/secure-backups.sh` — dry run by default, `--apply` to act, run on the VPS as root.
It closes local read access to `backups/`, moves the `.env.pre-*` snapshots out of it, and
accounts for the stray `app.db.bak*` copies in the application directory. See PR #231 for the
retention half and the encryption-at-rest assessment.

`scripts/backup-db.js` now writes **new** snapshots `0600` and creates `backups/` `0700` when
it creates it at all, so the nightly run cannot undo the remediation. It deliberately does
**not** re-permission an existing directory — a cron job silently changing modes on a
production directory at 02:00 is a surprise, and the one-time fix is a decision. It warns
instead, naming the command.

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
