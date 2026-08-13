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
modes, and greps the emitted artifact for every planted value. It prints its own total on
the last line (`N assertions · M failed`) and exits non-zero on any failure — **read the
count from the run, not from here.** A number written into this file goes stale the next
time a check is added, and a stale one reads as "the suite shrank".

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
| Email — `users`, `drivers_directory`, `investors`, `investor_applications`, `investor_outreach_log`, `job_applications`, `sheet_job_tracking` | rewritten to `<id-or-username>@invalid` | `.invalid` is RFC 2606 reserved and **can never resolve**, so even a misconfigured mailer cannot deliver. Per-row rather than a single constant, so accounts stay distinguishable. |
| Phone / cell | `555-0100` | NANP reserved fictional range. |
| Bank routing + account numbers, account/check names (`investor_payment_info`, `driver_payment_info`) | emptied / `REDACTED` | Nothing computes from them; they are only displayed or printed. No test value, unlimited downside. |
| `ein_ssn`, `ssn`, `dob`, `drivers_license`, personal `address` | emptied / `REDACTED` | Same. |
| `signature_text`, `signature_image` | `REDACTED` / emptied | A legal artefact, and as base64 the bulk of the onboarding tables. |
| Signing evidence — `signed_ip`, `signed_ip_source`, `signed_user_agent`, `consent_text` (both onboarding-document tables) | emptied | Personal data *about the signer*: an IP address and a browser fingerprint, plus free text off the wire. `evidence_version` and `artifact_sha256` are deliberately **kept** — the version is what marks a row as captured under the evidence regime, and a digest of a file this script never copies discloses nothing. |
| `investor_applications.access_token` | regenerated | These are **live bearer credentials** for the public onboarding flow. Regenerating means a leaked copy cannot be replayed against production, and a production link cannot be replayed against staging. |
| `driver_locations` | emptied | Retired 2026-05-13; no endpoint reads or writes it. Pure historical position PII. |
| **Free text — every text column of every table** (stage `3h`) | routable addresses → `<10 hex>@invalid`, `###-##-####` → `000-00-0000`, substituted **in place** | Everything above names a table and a column, so an address typed into a notes field, embedded in a JSON blob, or recorded in an audit line walked straight through. Measured on the 2026-08-13 production-shaped database: **21 routable third-party addresses survived a run that reported success** — `job_applications.reference_info` (6 of 8 rows: applicants' references and previous employers, third parties who never consented to anything — ⚠️ the address is stored under the key `relationship`, not `email`), `audit_trail.details` (8 of 1455), `load_invoice_drafts.recipient` (7 of 7, broker AP addresses). |

### Stage 3h — the free-text sweep, and what constrains it

Read the stage-3h comment in `scripts/refresh-env.js` for the detail. The guarantees and the
traps:

⚠️ **It is deliberately NOT a list of those three columns.** Enumerating them fixes the columns
that happened to be populated on the day someone looked and leaves the mechanism — a scrub that
only covers what it was told about — exactly as it was. It sweeps every text column of every
table (SQL-prefiltered, so the ~900k-row telemetry table costs nothing), which is the only shape
that also covers the column somebody adds next month.

⚠️ **Substitution in place — never a blank, never a JSON round-trip.** `audit_trail.details` is
parsed structurally by the app and `reference_info` is JSON the applications screen renders, so
blanking destroys the value and a round-trip reorders keys, re-escapes strings and moves the
` [PERIOD_…]` suffix that deliberately sits *outside* the JSON body. Everything around the
address is left byte-identical.

⚠️ **The token charset is a requirement, not a preference.** `<10 hex>@invalid` contains no `[`
(which would forge or break the `[PERIOD_` purge exemption), no `"` or `\` (which would break the
JSON detail bodies) and no whitespace (which would break the `] periods=` adjacency
`parsePeriodRefusalDetail` requires). The email regex is bounded for the same reason — a loose
`\S+@\S+\.\S+` spans brackets and would swallow `agent@x.com [PERIOD_FINALIZED]` whole.

**The salt is per-RUN: not per-row, and not absent.** The token is
`HMAC-SHA256(per-run salt, lowercased address)`. Per-run keeps one address mapping to one token
across every column of a given database — `load_invoice_drafts.recipient` and the `audit_trail`
row describing the same draft still agree, so anything that groups by recipient still works —
while two different refreshes stay unlinkable. Unsalted would be a confirmation oracle over a
guessable space, which is why a bare email digest is still personal data.

**Addresses on reserved names are left alone** — `.invalid` / `.test` / `.example` /
`.localhost` (RFC 2606, RFC 6761) and `example.com|net|org`. They already cannot resolve, and
skipping them is what makes the stage **idempotent**: it never churns its own output, and it does
not rewrite the deliberately-fake addresses in fixtures and documentation.

**Deliberately not scrubbed:**

- `geocode_cache.address`, `load_coordinates.pickup_address` / `dropoff_address` — shipper and
  receiver *facilities*, i.e. business locations, not personal contact details. They are also
  the only coordinate source geofencing has (`checkGeofence`'s sheet columns do not exist), so
  scrubbing them disables the feature you would be trying to test.
- `trucks.license_plate`, `trailers.license_plate`, `routemate_vehicles.license_num` — company
  asset identifiers; the ELD linkage keys off adjacent columns.
- `messages` / `notifications` bodies — operational content, worth exercising at realistic volume.
  **Note the scope, which narrowed on 2026-08-13:** the body text is still kept in full, and stage
  3h neutralizes only an email address or SSN shape appearing *inside* it. Realistic volume was
  always the point; a routable address was never part of it.
- **Phone numbers in free text** — out of stage 3h's reach on purpose. The assertion sweep has
  never scanned for them, so there is no signal that any exist, and a phone pattern loose enough
  to be useful also matches this system's 9-digit load ids (`562620213`) and dollar amounts.
  Neutralizing a load id inside an audit line would be a worse bug than the one being fixed.

### The assertions, and why they are tiered

One function (`collectLeaks`) is used by all three places that need to answer "is this file
safe to move?" — the sanitize pass, `--verify`, and `--from-sanitized` before it installs.
Written once on purpose: a second copy is a second thing to forget when a column joins the
scrub list, and the entire value of these checks is that they fail when the scrub silently
stops covering something.

**The tiering was INVERTED on 2026-08-13.** Read the rest of this section before restoring the
old behaviour.

**Hard failures**, two kinds, both an unconditional refusal:

1. **A named column the sanitizer owns did not get scrubbed.** Three lists in
   `refresh-env.js`, and the lists themselves are the specification — do not re-enumerate them
   here, that is how this section drifted before:
   - `REDACTED_EMPTY` — columns the scrub **empties** (bank routing/account, `ein_ssn`, `ssn`,
     `drivers_license`, `dob`, `signature`, `signature_image`, and the signing evidence
     `signed_ip` / `signed_ip_source` / `signed_user_agent` / `consent_text` on both
     onboarding-document tables). A leak is any non-empty value.
   - `REDACTED_LITERAL` — columns the scrub **replaces with a placeholder** rather than emptying,
     so "empty" is the wrong test: the four personal **home address** columns, the bank
     account/cheque/bank names and bank address/phone, and `signature_text`. A leak is a value
     that is neither empty nor the placeholder.
   - `REDIRECTED_EMAIL` — the seven columns rewritten to `@invalid`. A leak is any address that
     is not.

   Plus any surviving `sessions` or `driver_locations` row.

   ⚠️ **`REDACTED_LITERAL` and seven of `REDACTED_EMPTY`'s entries were added on 2026-08-13,
   because the assertion list had drifted into being a strict SUBSET of the scrub list** — the
   exact failure the paragraph above says these checks exist to prevent. Home addresses, dates of
   birth and signature blobs were scrubbed but never verified, and **the free-text sweep cannot
   cover for that omission**: none of them is email- or SSN-shaped, so a `setCols()` that quietly
   stopped matching (a renamed column, a rebuilt table) would have shipped real personal addresses
   with every check in the file still green.
2. **Any routable address or SSN shape anywhere in free text** — the sweep over every text column
   of every table. Advisory until 2026-08-13; a refusal since.

⚠️ **Why (2) stopped being an advisory.** The old rationale was sound *for its time*: the sweep
read columns nobody scrubbed, so a broker's address in a message body was ordinary operational
content rather than a leak, and a refusal that fires on ordinary content gets flagged away within
a week. But that argument rested entirely on **nothing scrubbing free text**. Stage 3h scrubs it.
A survivor therefore no longer means "we found content we never promised to clean" — it means the
scrubber ran and did not work, which is precisely what a hard refusal is for. The cost of the old
tier was measured: 21 routable third-party addresses shipped in a run that printed
`clean: no routable address … survives` four lines below the WARNING lines naming them.

**Advisories** — **nothing populates this tier today.** It survives so that the next scan kind
added (phone numbers are the obvious candidate) does not also have to invent a way to report
itself. `--strict-scan` is consequently a **no-op for the two kinds scanned today**; it is kept
because it costs nothing and a graduated tier will be wanted again.

⚠️ **The `clean:` line is now conditional on there being no advisories**, so it can never again
contradict the warnings printed above it. It used to print unconditionally once the leak list was
empty. A summary that contradicts its own warnings does not merely fail to inform — it teaches
the reader that the warnings are noise, which is how this gap survived as long as it did.

⚠️ **The detector judges every match individually, never the whole value.** It used to be
`ROUTABLE_EMAIL.test(v) && !v.includes("@invalid")`. After stage 3h a value routinely *contains*
a scrubbed `<hex>@invalid` token, so a routable address sitting beside one would have been waved
through — a fail-open in exactly the case that now matters most, since post-scrub survivors are
the entire reason this sweep exists. Every match is now graded by the shared
`isRoutableAddress()`, the same predicate stage 3h scrubs with: a scrubber and the check that
grades it must never be able to disagree about what counts as a leak.

⚠️ **Keep the assertion lists a SUPERSET of what the scrub touches.** They were a strict subset
until 2026-08-13 — see the `REDACTED_LITERAL` note above. When you add a column to stage 3e/3f,
add it to `REDACTED_EMPTY` (if the scrub empties it) or `REDACTED_LITERAL` (if the scrub writes a
placeholder) in the same edit. A scrub step with no assertion behind it fails silently, and the
free-text sweep is not a safety net for it: that sweep only sees email- and SSN-shaped values.

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

**2026-08-13 — stage 3h, the real sanitizer against a copy of the production-shaped local
database.** **21 of 21 values rewritten across 11 distinct addresses**; `--verify --strict-scan`
on the resulting artifact reports clean; **129/129** structural assertions passed — the text
surrounding each address is byte-identical, every `reference_info` still parses as JSON, one
address maps to one token across every table it appears in, and zero routable addresses survive
anywhere. Runtime ~67 s over 963,211 telemetry rows.

**2026-08-08 — end-to-end, against the `app.db.20260808_020003.gz` snapshot.** 298.8 MB →
**144.6 MB**, `integrity_check ok`, 12 users re-hashed, 6 sessions cleared. Booted on port 3011
against the LOCAL sheet: server up, 11 tabs cached, 279 load coordinates populated, login
succeeded with the reset password, `/api/dashboard` returned live KPIs, `/api/fuel/verify`
backtested all 3 instrumented trucks, and `/api/periods` showed the real close calendar (July
pending, June finalized).

⚠️ That run's **per-category redaction counts are superseded** and were deliberately dropped from
the line above (they read 10 emails redirected, 46 contact fields, 28 bank/tax, 34 signatures, 3
access tokens). Both the signing-evidence columns and stage 3h landed after it, so a current run
redacts strictly more and no count from 2026-08-08 reconciles against one taken today. The boot
half still stands.
