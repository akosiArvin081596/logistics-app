# Browser end-to-end harness (`scripts/e2e/`)

Playwright (`playwright-core`) drives the real LogisX UI in Chrome for Testing. It signs in as each role, works through
the screens, captions every step on the page, screenshots it, and writes one verdict per step to a results table. In this
repo, "test" means this: a real browser run through the UI, headed so a person can watch, on a local server **and** on staging.

It is **not part of `npm run ci`**, and it never runs in CI or on deploy. It is its own npm package (`package.json` here):
the root install, CI and the deploy never install it, and `scripts/run-unit-tests.js` only runs the top-level
`scripts/test-*` / `check-*` files.

What it covers today, in four sections (`ONLY` picks them):

- **Trucks (steps 1–12, R1–R16).** Truck photos and drivers' identity files are stored and served only as what their
  bytes are. Truck amounts are validated (400 `INVALID_AMOUNT`) and cost edits audited. The Trucks forms keep their input
  through refreshes and refused saves. The photo, admin-fee and fuel limits hold, and the driver-file routes send the
  right cache headers (#393, #394). Round 3 (R12–R16): the unused driver-files route answers no files, hexadecimal
  amounts and unit numbers with control characters are refused, the driver's "has a photo" follows the stored bytes,
  and two renames to case variants of one unit number at the same moment leave one truck with it.
- **Sign-out / sign-in (S1–S7).** Account data does not survive a change of user in the same tab (#395). Sign-out ends
  on the app's own login form with no network and while the server is down. Other tabs stop showing the previous
  person: they follow a sign-out, leave for a clean `/login` when the session ends without one, and reload as the
  different person another tab signed in. `/login` after a confirmed sign-out renders without a session round-trip; a
  second tap on Sign In sends nothing.
- **Dispatcher data (D1–D3).** A Dispatcher's copies of the dashboard and of a load carry no broker/contact values, and
  the sheet reader (`GET /api/data`) is Super Admin only.
- **Maintenance notice (M1).** A popup dismissal in one tab belongs to the person who dismissed it. Local only, on a
  server booted with the notice on.

Every "Expected" column states the behaviour **after** the fix. A run on a build without it (a BEFORE baseline) is
expected to FAIL exactly the fix rows.

## Safety rails

- **Never production.** `e2e.mjs` refuses `app.logisx.com`. Staging, `staging-app.logisx.com`, is allowed.
  `boot-server.sh` refuses ports 3000 (production on the VPS) and 5173 (Vite), and any port already in use. It binds the
  server to 127.0.0.1.
- **The local data is real.** A local run uses a private copy of the main checkout's `app.db`: unsanitized production
  data, PII included. The copies, the logins, the screenshots, the results and the server logs all live in the
  **work dir**, which is created `0700` outside every checkout. The scripts refuse a database outside the work dir or a
  symlinked one. They also refuse a work dir that is inside a checkout, contains one, or is open to other users. The source
  database is only ever opened read-only, and it is copied with SQLite's backup API, never `cp`.
- **What leaves the machine, and what does not.** `boot-server.sh` blanks every outbound credential and forces every
  integration and default-ON alert off on the command line (dotenv never overrides a variable that is already set). It
  refuses a `SPREADSHEET_ID` that is unset, empty or production's, and it hands the server the exact value it checked.
  - **Goes out: reads, and Maps calls that Google refuses.** The server signs in to Google with the service-account key
    and reads that non-production Sheet (at boot, and whenever a page needs its rows). Its Google Maps calls go out
    with the blanked key, and Google refuses them: the server log shows `Routes API HTTP error … 403`
    (`PERMISSION_DENIED`). A page that draws a map also asks Google for the Maps script, with the blank browser key.
  - **Does not go out:** no write to production, no mail (Gmail is blanked) and no pushes (the n8n webhook, Routemate,
    Linxup and ScanKit are blanked or off). Production's read-only archive sheet (the `ARCHIVE_SPREADSHEET_ID` default)
    is read only by the `/archive` page and the rate-con reconcile; the run opens neither, and the reconcile is off.
- **Nothing writes to the Google Sheet.** Every step that writes changes the SQLite copy only (trucks, sessions, audit
  rows). The Sheet is only read.
- **Logins are never printed.** The creds file (`0600`) is read, never echoed. The scripts print ids and booleans only.
- **Identity documents are masked** in saved screenshots (`MASK_PII`, on by default). The live headed page is not masked.
- **Stop by PID only.** `stop-server.sh` kills the one process `boot-server.sh` recorded. It does so only while that process
  is still a `server.js` running from the worktree it was booted from. Never `pkill`: other worktrees run servers too.

## Install

```bash
npm --prefix scripts/e2e ci      # playwright-core only, pinned; the root and client installs are untouched
```

- **Browser:** the Chrome for Testing that the app's own `puppeteer` dependency already downloaded to `~/.cache/puppeteer`.
  It is found with `puppeteer.executablePath()`. `CHROME_PATH` picks another binary. If it is missing, run
  `npx puppeteer browsers install chrome` in the main checkout.
- **Node:** run everything on `.nvmrc`'s version, 22.23.2. `better-sqlite3` is a native module built for that ABI, so on
  another Node the database scripts die with `NODE_MODULE_VERSION`. The scripts that need it warn when `node -v` differs.
  `eval "$(fnm env)"` does not work in a worktree, so prefix each command with `fnm exec --using=22.23.2`, as the recipes
  below do. The shell scripts also take `NODE_BIN`, the path of a `node` binary.

## Files

| File | What it is |
|---|---|
| `e2e.mjs` | The run. Captions every step on screen, screenshots it, and writes `results-<tag>.md`. |
| `paths.cjs` | Where everything is: this checkout, the main checkout, the installs, the work dir. Every other script resolves through it. `node scripts/e2e/paths.cjs work-dir` prints the work dir. |
| `setup-db.cjs` | Makes a fresh private copy of the main checkout's `app.db` in the work dir and sets five logins on the copy. |
| `verify-creds.cjs` | Confirms the creds file matches a copy. Prints booleans and ids only. |
| `prep-worktree.sh` | Makes a worktree bootable: links the main checkout's installs, `.env` and key, then builds `client/dist`. |
| `boot-server.sh` / `stop-server.sh` | Start a local server on a copy with every outbound effect off; stop exactly that PID. |
| `stored-format-audit.cjs` | Read-only tally of the stored truck photos and CDL files: data-URI label vs actual bytes. |

**The work dir** (`E2E_WORK_DIR`, default `$TMPDIR/logisx-e2e`, or `/tmp/logisx-e2e` without `TMPDIR`) holds everything
a run produces. None of it belongs in the repo. As a second guard, the root `.gitignore` covers these names under
`scripts/e2e/`. macOS cleans `$TMPDIR` up over time, so for anything you need to keep, set `E2E_WORK_DIR` to a private
directory outside every checkout.

| In the work dir | What it is |
|---|---|
| `*.db` (+ `-wal`, `-shm`) | **Private copies of an unsanitized production database, PII included.** Never copy them elsewhere. |
| `creds.json` (`0600`) | The five logins: Super Admin, Driver, two Investors (`investor`, `investor2`), Dispatcher. **Never print or paste it.** |
| `shots/<tag>/`, `results-<tag>.md` | A run's screenshots and verdict table. The screenshots show real data. |
| `server-<port>.log`, `server-<port>.pid` | The server's output, and the PID `stop-server.sh` stops. |
| `plant-journal.json` | Exists only while a planted value is in a DB (see "Planting"). |

## Local run

Run every command from the checkout under test (a worktree, or the main checkout):

```bash
fnm exec --using=22.23.2 npm --prefix scripts/e2e ci                        # once
W="$(node scripts/e2e/paths.cjs work-dir)"                                   # the work dir (created 0700)
fnm exec --using=22.23.2 node scripts/e2e/setup-db.cjs "$W/qa.db"            # add --force to replace a copy
fnm exec --using=22.23.2 node scripts/e2e/verify-creds.cjs "$W/qa.db"        # expect "password matches=true must_change_password=0" x5
fnm exec --using=22.23.2 scripts/e2e/prep-worktree.sh                        # once per worktree
# Part 1: trucks + Dispatcher data (5 sign-ins)
fnm exec --using=22.23.2 scripts/e2e/boot-server.sh "$PWD" 3181 "$W/qa.db"   # waits until it answers
BASE_URL=http://127.0.0.1:3181 PHASE=after OUT_TAG=after-trucks ONLY=trucks,dispatcher DB_PATH="$W/qa.db" \
  fnm exec --using=22.23.2 node scripts/e2e/e2e.mjs                          # add HEADED=1 to watch it
fnm exec --using=22.23.2 scripts/e2e/stop-server.sh 3181
# Part 2: the sign-out section, on a fresh server process (up to 20 sign-ins)
fnm exec --using=22.23.2 scripts/e2e/boot-server.sh "$PWD" 3181 "$W/qa.db"
BASE_URL=http://127.0.0.1:3181 PHASE=after OUT_TAG=after-signout ONLY=signout \
  fnm exec --using=22.23.2 node scripts/e2e/e2e.mjs
fnm exec --using=22.23.2 scripts/e2e/stop-server.sh 3181
# Part 3: the maintenance notice, on a server booted with it ON (3 sign-ins)
E2E_MAINTENANCE_NOTICE=1 fnm exec --using=22.23.2 scripts/e2e/boot-server.sh "$PWD" 3181 "$W/qa.db"
BASE_URL=http://127.0.0.1:3181 PHASE=after OUT_TAG=after-maintenance ONLY=maintenance \
  fnm exec --using=22.23.2 node scripts/e2e/e2e.mjs
fnm exec --using=22.23.2 scripts/e2e/stop-server.sh 3181
```

- Headless: part 1 takes about 1.5 minutes, part 2 about 2.5 minutes, part 3 about 30 s.
- Headed (`HEADED=1`) takes roughly two to three times as long. Headed uses slowMo 350 ms, a 1.6 s pause on every
  caption (none on the timing-critical ones), 1400×900 admin and investor windows, and a 430×900 driver window.
- A BEFORE baseline is the same run on the build without the fix, with `PHASE=before`. Use a second copy from
  `setup-db.cjs`, so both phases start from the same data.
- The parts can run side by side on different ports, each on its own copy (`setup-db.cjs` reuses the creds file's
  passwords, so one creds file serves every copy). Start the part that plants values (part 1) last: a run refuses to
  start while `plant-journal.json` exists.

⚠️ **Login limiter:** `POST /api/auth/login` allows 20 attempts per 15 minutes per server process, counting every
attempt. Per section: `trucks` 3, `signout` up to 20, `dispatcher` 2 and `maintenance` 3. The sign-out figure is its
worst case: one fewer on a build without S4a's second half, and one fewer where S7 sends one sign-in (so 19 on a build
with the fixes). It fills a whole window, so run it on a fresh server process, as the recipe does. **All four together
are more than one window holds**, which is why the recipe restarts the server between the parts; the run prints a
warning when the sections it was given can exceed 20. If a step answers 429, the window is spent. To rerun single
sign-out cases, use `STEPS` (e.g. `ONLY=signout STEPS=S5a,S7`), on a server with sign-ins left in its window. S1a,
S1b, S4b, S5a and S6 sign in once; S2a, S2b, S3, S5b and S5c twice; S4a once or twice (its second half signs the
Dispatcher in); S7 two or three times.

⚠️ **`DB_PATH` must be the file the server was booted with.** The run proves it before planting anything: it writes a
sentinel into its own test truck and reads it back through the API. On a mismatch you get a `10*` FAIL row and the
planted cases SKIP. They are never silently mis-tested.

### `setup-db.cjs <db> [--force]`

- The source is `SOURCE_DB`, by default the main checkout's `app.db`. It is opened **read-only**
  (`{ readonly: true, fileMustExist: true }`) and copied with SQLite's backup API. The copy must be inside the work dir.
- Super Admin: `scripts/reset-super-admin-password.js` runs on the copy. It also clears the copy's sessions.
- Driver: a Driver whose `driver_name` matches (case-insensitively) the `assigned_driver` of exactly one truck with an
  image photo. The Driver must be `fully_onboarded` (or have no onboarding status), so the Kit tab renders, and their
  application's `cdl_front` must be an image. The creds file's existing driver is kept while they still qualify;
  otherwise the lowest user id wins.
- Investor: the `Investor` with the lowest id. With none, the creds file has no `investor` entry and R8 SKIPs.
- Second Investor (`investor2`): the `Investor` with the next-lowest id. With fewer than two, there is no `investor2`
  entry and M1 SKIPs.
- Dispatcher: the `Dispatcher` with the lowest id. With none, there is no `dispatcher` entry, and S2a, S3, S5b, S5c, S7
  and D1–D3 SKIP.
- The Driver, both Investors and the Dispatcher each get a random password (a bcryptjs hash,
  `must_change_password = 0`) on the copy only.
- An existing creds file's passwords are reused, so one creds file works for every copy. The script prints the ids it
  picked, never a password.

### `prep-worktree.sh [<worktree>]`

It defaults to the checkout it is in. It symlinks `node_modules`, `client/node_modules`, `.env` and
`service-account-key.json` from the main checkout (the parent of `git rev-parse --git-common-dir`; `MAIN_CHECKOUT`
overrides). All four are gitignored, so the worktree stays clean. It then runs `npm run build:client`. It never runs
`npm install` or `npm ci`, which would rewrite `client/package-lock.json`.

⚠️ If it prints `WARNING: package.json differs`, the branch changed its dependencies and the linked `node_modules` may
lack a package. Resolve that before reading a boot failure as a code bug.

### `boot-server.sh <worktree> <port> <db>` and `stop-server.sh <port>`

The boot script refuses:

- ports 3000 and 5173, and any port already in use;
- a DB outside the work dir, or a symlink;
- a worktree without `client/dist`, `node_modules`, the key or `.env`;
- a `SPREADSHEET_ID` that is unset, empty or production's. It checks the value the server will really use: the
  environment's, else the worktree's `.env` read with the app's own dotenv. It then passes that value explicitly.

It binds to 127.0.0.1, runs `NODE_ENV=development`, and logs to `<work dir>/server-<port>.log`. It forces these on the
command line (dotenv never overrides a set variable):

- **Credentials and keys blanked:** Gmail, n8n invoice webhook, Gemini, Google Maps (server and browser), Routemate,
  ScanKit and Linxup.
- **Feature flags off:** `ROUTEMATE/LINXUP/SCANKIT/INVOICE_AUTOGEN/PERIOD_FINALIZE/FUEL_GALLONS_RECOVERY/RATECON_RECONCILE/RATECON_INDEX_APPLY/FUEL_EVENTS/CHAT_ORPHAN_SWEEP_ENABLED=false`.
- **Default-ON alerts off:** `ELD_STALE/FUEL_LOW/EXPENSE_DUPLICATE/INVOICE_UNDATED/RATECON_EXTRACT_ALERT_ENABLED=false`.
- **The maintenance notice:** off (`MAINTENANCE_NOTICE_ENABLED=false`) unless the script is run with
  `E2E_MAINTENANCE_NOTICE=1`, which turns it on for M1 (`MAINTENANCE_NOTICE_ENABLED=true`). The audience is pinned to
  `investor` either way. The notice only shows a popup and a banner; it sends nothing.

`stop-server.sh <port>` reads `<work dir>/server-<port>.pid`. It sends SIGTERM only if that PID is still a `server.js`
whose working directory is the worktree it was booted from. Otherwise it kills nothing.

## Staging

```bash
BASE_URL=https://staging-app.logisx.com CREDS_FILE="$W/creds-staging.json" PHASE=after OUT_TAG=staging \
  fnm exec --using=22.23.2 node scripts/e2e/e2e.mjs
```

- **No `DB_PATH`:** nothing can be planted in a remote database. Steps 10a–e, 11b–f, R3a–b, R15 and R16 SKIP, and so
  does R8 when the creds file has no `investor` entry. M1 SKIPs too (local only: the notice is off on staging).
  Everything else runs unchanged, and the script discovers every id itself.
- **Expected differences:** staging's environment refresh strips identity documents. So 11a (the Kit's CDL) FAILs there,
  R10 scores only its truck-photo half, and on a build that still has the driver-files route R12 can only be
  `PASS (vacuous)` (the route answers, with no files to return).
- **Safe there:** R12 and D1–D3 only read; the sign-out section only signs in and out. R13 and R14 edit and delete
  `QA-TEST-*` trucks, like the rest of the truck section.
- **Creds file:** it has `creds.json`'s shape, with staging logins:
  `{"superAdmin": {"username", "password", "userId"}, "driver": {…}, "investor": {…}, "dispatcher": {…}}`.
  `investor` and `dispatcher` are optional. Keep it in the work dir, `0600`.
- ⚠️ **A full run writes on staging.** It creates, edits and deletes `QA-TEST-*` trucks, and their audit rows stay.
  `ONLY=signout` only signs in and out.

## Environment

| Env | Meaning |
|---|---|
| `BASE_URL` | Required by `e2e.mjs`. Refuses `app.logisx.com` (production). |
| `PHASE` | `before` or `after`. Only names the output; the "Expected" column is always the after-the-fix behaviour. |
| `OUT_TAG` | Writes `shots/<tag>/` and `results-<tag>.md` instead of `<PHASE>`, so a rehearsal cannot overwrite a baseline. |
| `ONLY` | A comma-separated list of sections: `trucks` (1–12, R1–R16), `signout` (S1–S7), `dispatcher` (D1–D3), `maintenance` (M1). Unset: all four, in that order, then step 12's clean-up — more sign-ins than one limiter window holds (see above). |
| `STEPS` | Only these sign-out cases, e.g. `STEPS=S5a,S7` (each has its own browser context). The other sections ignore it. |
| `HEADED=1` | A visible browser. |
| `DB_PATH` | The copy the server runs on (inside the work dir). It is used **only** to plant stored values for steps 10, 11b–f, R3 and R15, and to stage and clean up R16. Unset: those rows SKIP. |
| `CREDS_FILE` | The logins. Default: `<work dir>/creds.json`. |
| `E2E_WORK_DIR` | The work dir. Default: `$TMPDIR/logisx-e2e`. It must be private, outside every checkout, and contain none. |
| `SOURCE_DB` | `setup-db.cjs`'s source, opened read-only. Default: the main checkout's `app.db`. |
| `APP_DIR` | The checkout whose `node_modules` (better-sqlite3, bcryptjs, puppeteer, dotenv) and `scripts/` are used. Default: this checkout once it has installs (or `prep-worktree.sh`'s links), else the main checkout. |
| `MAIN_CHECKOUT` | The main checkout. Default: the parent of `git rev-parse --git-common-dir`. |
| `CHROME_PATH` | Another Chrome binary. Default: the app's puppeteer Chrome for Testing. |
| `NODE_BIN` | The `node` binary the shell scripts run. Default: `node` on `PATH`. |
| `MASK_PII=0` | Stops masking the driver's identity documents in saved screenshots. Masking only affects the saved PNGs; the live page is not masked. |
| `EXTRA=1` | Adds X1, an INFO probe of the Edit-modal-vs-refresh bug. R1 now scores the same behaviour, so X1 is redundant. |
| `CAPTION_PAUSE_MS`, `SLOWMO` | Override the pacing. Headed defaults: 1600 / 350. |
| `DRIVER_VIEWPORT` | The driver window. Default: `430x900`. |
| `S3_LATENCY_MS`, `S3_KBPS` | The CDP throttle of S3, S6 and S7. Default: +2500 ms per request, 24 KB/s each way. |
| `E2E_MAINTENANCE_NOTICE=1` | For `boot-server.sh`, not `e2e.mjs`: boot with the maintenance notice on, for M1. |

## Verdicts and exit code

- **PASS** / **FAIL**: judged against the after-the-fix expectation.
- **PASS (vacuous)**: the check held only because the feature it guards does not exist yet (step 7, R3b).
- **INFO**: not scored.
- **SKIP**: the case could not be planted, or its login is missing.

The results header totals them. The exit code is 0 when the run completed, FAIL rows included (a BEFORE baseline is
expected to fail). It is 1 when a block aborted, and 2 when the run refused to start.

## The truck steps (1–12, R1–R16)

| Step | What |
|---|---|
| 1 | Super Admin signs in. |
| 2a–c | Add Truck: attach three non-images as the photo: an SVG, PDF bytes named `scan.jpg`, and a plain `.pdf`. |
| 3 | Add a fresh `QA-TEST-…` truck ("truck A") with a real canvas-made JPEG and costs (1000 / 40 / 600 yr / 1200 yr). |
| 4 | Edit truck A: type `1e999` into Insurance and Save. |
| 5a–h | API bad amounts: `"Infinity"`, `-5`, `"abc"`, `"1e999"`, `1000001`, IRP `"Infinity"`, the 1,000,000 boundary, and a POST with `"Infinity"`. |
| 6 | Edit Insurance 1150 and IRP 1800 in the UI, then open `/api/admin/audit-trail?entity=truck&limit=10`. Expects one `update_truck_costs` row with "fixed costs $1,190.00/mo → $1,390.00/mo". |
| 7 | Save again with no changes; expects no new cost row. |
| 8a–h | API photo: HTML, SVG, HTML labelled JPEG, a malformed value, and a POST with HTML must be refused. A real PNG, `""` and a real JPEG must still be accepted. |
| 9 | The driver signs in, opens a load and expands Truck Details; the photo renders. |
| 10a–e | Planted truck photos, opened at `/api/driver/me/truck-photo`. |
| 11a | The Kit tab's CDL renders. |
| 11b–f | Planted `cdl_front` values, opened at `/api/driver/me/identity-file/cdl-front`. A real PDF must still serve. |
| 12 | Restore every planted value and delete every test truck. |

| Step | How it is shown | Expected (AFTER) |
|---|---|---|
| R1 | **UI.** Open Edit on truck A and type Insurance 2468 without saving. A page `fetch` then `PUT`s a notes change on truck B. The script waits for the `trucks:changed` reload (`GET /api/trucks`, whose body carries B's new notes). | Modal still open, 2468 still in the box, nothing saved |
| R11 | **UI.** Edit truck A and type Insurance 1357. Meanwhile a page `fetch` saves new Notes on the same truck, as another person would. Then Save. | Both survive: Insurance 1357 and the other person's notes (the Save sends only the changed fields) |
| R2a | **UI.** Edit A, set Unit # to an existing unit (the lowest-id non-QA truck from `/api/trucks`), Save. | 400 "Unit number already exists" shown inline; modal open; the typed unit kept |
| R2b | **UI.** Add Truck with that unit, a note and Insurance 777. | 400; every field kept; the error shown inline or as a toast; no duplicate created |
| R4 | API `PUT` A photo = real PNG bytes under `data:image/jpeg`, then `GET /api/trucks`. **UI:** the Edit dialog's preview `src`. | Photo returned as `data:image/png;base64,…` |
| R5a–b | API `PUT` A photo = a valid JPEG header (640×480) padded to 2.5 MiB; a 45-byte PNG whose IHDR says 5000×4000 (20 MP). | 413 `IMAGE_TOO_LARGE` each; stored photo unchanged |
| R6a–d | API `PUT` `adminFeePct` 150, -5, "abc"; then 40 followed by "". | 400 `INVALID_AMOUNT` / `admin_fee_pct` ×3; then 200, stored 50 |
| R7a–e | API `PUT` fuel tank 600 and MPG 25, then the 500 / 20 boundary; then a Super Admin `POST` with fuel tank 600 (the create verb). | 400 `INVALID_AMOUNT` naming the field and its limit; the boundary values 200; the POST 400 |
| R7f | **UI.** Edit A, type 600 into Fuel Tank (gallons), Save. | Inline error naming the fuel tank; no request sent |
| R9 | **UI.** Super Admin adds `…-R9` with Fuel Tank 180 and Avg MPG 6.8, then opens the audit trail. | The `create_truck` line names 180 gal and 6.8 MPG |
| R8 | **Third context: the Investor** signs in, and a page `fetch` sends `POST /api/trucks {unitNumber:"QA-TEST-INV-…", fuel_tank_gallons:400}`. **UI:** the Investor's own Trucks page, Tank column. | 200, `FuelTankGallons` 0, Tank "200 gal (default)" |
| R3a | **Planted, local only.** Put a real PDF in `cdl_front` and reload the driver app, so the Kit card is a PDF card. An in-page `fetch` (`cache: 'no-store'`) reads the headers. **UI:** tap the Kit card and record the browser's download name. | `Content-Disposition: attachment; filename="CDL-Front.pdf"` (matched case-insensitively); the tap downloads `CDL-Front.pdf` |
| R3b | **Planted.** Put the canvas JPEG in `cdl_front`: headers, plus the Kit thumbnail decoding. | 200 `image/jpeg`, no attachment header. A PASS is **vacuous** when R3a shows the build sends no attachment header at all |
| R10 | The driver's file routes, read in the page with `cache: 'no-store'`: `/api/driver/me/identity-file/cdl-front` and `/api/driver/me/truck-photo`, then the photo again with `If-None-Match`. | identity-file `Cache-Control: private, no-store`; truck-photo `private, no-cache` with an ETag, and the matching `If-None-Match` answers 304 with no body. With no identity file on the server (staging), only the truck-photo half is scored |
| R13a–b | API `PUT` truck A `insuranceMonthly: "0x10"`, then `driverPayDaily: "0x10"` (a value that is stored is put back). | 400 each (insurance: `INVALID_AMOUNT`, field `insurance_monthly`); stored values unchanged |
| R14a–d | API `POST` a unit number containing U+0007, then one containing U+202E; then `PUT` both onto a truck of its own (`…-R14`, deleted after). A truck that is created is deleted again; a rename is put back. | 400 `INVALID_UNIT_NUMBER`, field `unitNumber`; nothing created or renamed |
| R16 | **Local only.** Two new trucks (`…-R16A`, `…-R16B`) are renamed by two page `fetch`es that leave in the same tick, to `…-R16-DUP` and `…-r16-dup`. Each save also assigns a throwaway driver (`QA-TEST-DRV-<timestamp>-A/-B`), so the route's active-load check (a live read of the sheet) runs inside the save. Then `GET /api/trucks`. | Exactly one 200 and one 400 "Unit number already exists"; one truck with that unit number, case-insensitively |
| R15 | **Planted, local only.** The driver's truck photo becomes HTML bytes under a `data:image/jpeg` label. The driver's page reads `GET /api/driver/<name>` and `truck.has_photo`; then **UI:** a fresh driver app, a load's Truck Details. | `has_photo` 0 (Truck Details offers no photo) |
| R12 | A Super Admin page `fetch` of `GET /api/trucks/<the driver's truck>/driver-files`, summarized in the page (labels, types and sizes only). | No files come back (404, or anything that is not the driver-files payload); the answer is recorded as it is. A payload with no files is `PASS (vacuous)` |

**Run order:** steps 1–8, then R1, R11, R2a–b, R4–R7 and R9, then R13 and R14, then R8, then step 9, then the
`DB_PATH` check and R16, then steps 10–11, then R3, R10, R15 and R12. Step 12's clean-up runs last, after every other
section that runs.

**R16's throwaway drivers.** Assigning a driver writes a `truck_assignments` row and a `drivers_directory` row, and a
truck with an assignment row cannot be deleted (409 `TRUCK_REFERENCED`). So R16 deletes both rows through `DB_PATH`
by exact name, then its two trucks. Only names that start `QA-TEST-DRV-` are ever deleted, and a run starts by
deleting any that an aborted run left behind. No real driver's assignment is touched. When one save is refused but
answered long before the other, the two did not overlap in the server, and the row is `PASS (vacuous)`. A save that
failed (500) is INFO.

**Trucks it creates:**

- Kept for the run: `QA-TEST-<timestamp>` (truck A), `…-B` (R1's other save) and `…-R9`. The Investor creates
  `QA-TEST-INV-<timestamp>` (R8).
- Short-lived: `…-BADAMT`, `…-BADPHOTO` and `…-BADFUEL`, deleted at once, and only if the build accepts them. R14's
  `…-R14` and whatever its POSTs create, and R16's `…-R16A` / `…-R16B`, are deleted at the end of their step.
- Clean-up (step 12) deletes every one of them. A run also starts by deleting any `QA-TEST-*` leftovers.

**Planting.** Steps 10, 11b–f, R3 and R15 write test values straight into the copy (`DB_PATH`): the driver's truck
`photo`, or their application's `cdl_front`. The originals are kept in memory only, and they are restored after each block and on
Ctrl-C. While a plant is live, `plant-journal.json` records ids only, never values. If a run dies mid-plant, that file
blocks the next run: recreate the copy (`setup-db.cjs … --force`), then delete the journal.

R3 turns the driver tab's HTTP cache off over CDP. The Kit URL has no cache-buster, so on a build that lets the browser
cache it, step 11a's real CDL could otherwise answer for the planted value.

## The sign-out section (S1–S7)

Run it alone with `ONLY=signout` (and single cases with `STEPS`). The AFTER behaviour:

- **(a)** Sign-out ends with a full page load of `/login` (`location.replace`).
- **(b)** Signing in as a DIFFERENT person than the page last showed (e.g. after a session expired without a sign-out)
  ends with a full page load of that person's home page.
- **(c)** The same person again, or a first sign-in on a fresh page, keeps in-app navigation.
- **(d)** A tab left open stops showing a person the browser's session no longer belongs to, without being touched. It
  leaves for a fresh `/login` when another tab signs out or finds the session gone, and it reloads as the new person
  when another tab signs someone else in.

**The evidence:** each case plants a JS global, `window.__qaMarker = 'page-1'`. A full page load discards it; an in-app
route change (`router.push`) keeps it. Each case also counts the main frame's document requests: a full load makes one.

**Isolation:** every case runs in its own browser context, so no case inherits another's cookie. Nothing is planted in
the DB and no data is written. The only side effects are sign-ins and sign-outs, which touch `last_login_at` and the
session store.

| Step | How it is shown | Expected (AFTER) |
|---|---|---|
| S1a | The Super Admin signs in, waits for the dashboard's KPIs, plants the marker and clicks the sidebar's **Logout**. | `/login` is a fresh page: marker `undefined`, one document load. |
| S1b | The same with the Driver in a 430×900 context, clicking the driver app's **Logout** (`button.header-btn.danger`). | `/login` is a fresh page: marker `undefined`. |
| S2a | The session expires on the Super Admin's `/trucks` with no sign-out (see below). The app routes itself to `/login` in-app, where the marker is still there. The **Dispatcher** then signs in through the form on that page. | A full page load of `/dashboard`: marker `undefined`, and the session is the Dispatcher's. |
| S2b | **Control.** The same, but the **same Super Admin** signs back in. | In-app navigation: marker still `'page-1'`, and the session is the Super Admin's. |
| S3 | The Super Admin loads `/dashboard` with full data and signs out with the sidebar. The network is throttled and the **Dispatcher** signs in on the same tab. The screenshot is taken 700 ms after the Dispatcher's dashboard requests `/api/dashboard`, before the response. | A fresh page (KPI skeleton, header "Loading..."): nothing from the previous account on screen or in the page's store. |
| S4a | The Super Admin on `/dashboard` plants the marker. `context.setOffline(true)`, then the sidebar's **Logout**; 3 s later the page is read. Then online again, and the **Dispatcher** signs in on that form (only when there is one). | The app's own login form at `/login`, not the browser's error page (`chrome-error://`); the marker still set. Then a full page load of `/dashboard` (marker `undefined`) with the Dispatcher's session. |
| S4b | The same, with the server "down": `page.route` answers `POST /api/auth/logout` and the **document** request for `/login` with 502 and a small HTML body. | The app's own login form at `/login`, in-app (marker still set); never the 502 body. |
| S5a | **One context, two tabs**, both the Super Admin: A on `/dashboard`, B on `/trucks` with its marker. A presses the sidebar's **Logout**; B is polled for 6 s and never touched. | Within ~5 s, B is on `/login` as a fresh page (marker `undefined`), with no truck data: no table rows, an empty trucks store, none of the unit numbers it listed in its text. |
| S5b | The same two tabs. `context.clearCookies()` (the session "ends" without a sign-out); A goes to `/login`, and the **Dispatcher** signs in through the form there. B is polled for 10 s and never touched. | B leaves by itself for a fresh `/login` (marker `undefined`), holding nobody and none of the Super Admin's rows or unit numbers. It does not have to follow the later sign-in. |
| S5c | The same two tabs. `context.clearCookies()`; A is closed and the app is opened in a **new tab A**, whose own `GET /api/auth/session` gets no answer (`page.route` on A only, aborted with `internetdisconnected`; B's requests are untouched). A shows its sign-in form without deciding "signed out", and the **Dispatcher** signs in there. B is polled for 10 s and never touched. | Within ~10 s, by itself: B is loaded again (marker `undefined`) as the Dispatcher. Its auth store and its server session are the Dispatcher's, and it shows their view of `/trucks` or their home. Nothing only the Super Admin gets is left: no Owner column, no sidebar link to a page a Dispatcher may not open. |
| S6 | The Super Admin on `/dashboard`; the CDP throttle (as S3's) goes on, then the sidebar's **Logout**. An init script in every document of the context records when the app booted (its Vue instance, or its first `/api/` request, whichever is first), when the login form became visible, and every `/api/` request. | No `GET /api/auth/session` before the login form is visible: the form appears without a session round-trip. The boot-to-form time is recorded. |
| S7 | S2's expiry path (the app routes itself to `/login` in-app), then the throttle, and the **Dispatcher** signs in: a different person, so the sign-in loads a fresh page. After the first sign-in answers and before that page arrives, Sign In is tapped again (see below). | Exactly one `POST /api/auth/login`: the button stays disabled until the fresh page replaces this one. |

**How S2's expiry is driven.** The app has exactly one in-app route to `/login` without a sign-out, and S2 uses it:

1. `/trucks` is loaded while `GET /api/auth/session` gets **no answer**. `page.route` aborts it with
   `internetdisconnected`, as on a weak signal.
2. The auth store keeps the tab's saved user and shows the Super Admin's `/trucks`, with `isReconnecting = true`. The
   session check keeps retrying in the background.
3. `context.clearCookies()` makes the session "expire", and the route block is lifted.
4. `context.setOffline(true)`, then `(false)`, fires the browser's own `online` event.
5. The store's wake listener re-checks at once and gets `authenticated:false`. The path is `_reconnectNow` →
   `onSessionResolved` → `router.replace` → the guard → `/login`.

This takes about 300 ms, and the marker is still there. Two other routes look plausible but do not work, so they are not
used:

- **API 401s:** they do not redirect anywhere. After `clearCookies`, in-app navigation to `/dashboard` and `/trucks`
  gets 401s, and the page stays where it was.
- **`history.pushState` + `popstate` to `/login`:** this only changes the URL bar. The router stays on `/trucks` and no
  login form renders.

**How S3's throttle is driven.** CDP `Network.emulateNetworkConditions` adds +2500 ms per request, at 24 KB/s each way.

- It is applied **after** the sign-out, so a build that reloads `/login` is not slowed. It is removed when the case ends.
- Under it, `/api/dashboard` takes about 2.7 s to its headers and about 4.7 s to the full body.
- The screenshot comes at about 760 ms, so a response cannot land first: the verdict is deterministic by the latency
  floor. If it ever did, the row would be scored INFO ("window missed"), not PASS/FAIL.

**What S3 looks for.** `/api/dashboard` strips one thing for a Dispatcher: the broker/contact columns (`server.js`'s
`BROKER_WITHHELD_RE`, which `e2e.mjs` mirrors; keep the two in step). They are blanked, and a JSON contact blob is
reduced to its name. The dashboard never renders those columns for any role, and the Revenue grid is gated on the client
by role, so no Super Admin-only **value** can appear as text. S3 therefore checks two things:

- **On screen:** whether the previous account's payload is rendered (KPI values, rows, the "Updated …" header).
- **In memory:** whether the page's dashboard store holds the Super Admin's payload, identified by its timestamp and read
  through the app's Pinia instance. It also counts the Super Admin-only cells in it: the cells whose value differs from
  the Dispatcher's own copy.

Only counts are written out, never values.

**How S7's second tap is made.** While a page load is pending, DevTools holds every command to the page until the new
page has committed. So in S7's window no Playwright action and no CDP call reaches the old page: both answer from the
new one. The page's own script still runs, as a person's tap would still land. Before the first press, S7 wraps the
page's `fetch`; 400 ms after the first `POST /api/auth/login` answers, the page clicks Sign In itself (`click()` does
nothing on a disabled button, as a tap does nothing). It records the button's state, its marker and every sign-in POST
it sent in `sessionStorage` (key `qa.e2e.s7`), which the fresh page in the same tab reads and then removes. The
network's own count of `POST /api/auth/login` is recorded beside it, and both must be 1. The timeline (the fresh page's
document request and commit) shows the window. When the fresh page committed first, the row is INFO.

**How S7 wakes the app.** S2 toggles `context.setOffline()` to fire the browser's `online` event. S7 dispatches an
`online` event in the page instead, so the CDP throttle it applies next is the only network emulation set on the page.

**What S5b and S5c show, and why they differ.** A tab that shows someone follows every change of cookie owner another
tab records: the epoch in `localStorage`, which every sign-in, every sign-out and every definitive "signed out" answer
stamps.

- **S5b:** A's `/login` asks the server, which answers "signed out", and A stamps the epoch. B follows that stamp to a
  fresh `/login` within ~50 ms, before anyone signs in. Showing nobody, it has nothing to follow when the Dispatcher then
  signs in on A. That is the design: no tab keeps showing the signed-out person. If B ever ends up showing the
  Dispatcher on a fresh page instead (its own check answered after the sign-in), the row is INFO: not wrong, and S5c
  scores that branch.
- **S5c:** the first stamp B sees must be the Dispatcher's sign-in, which is the store's "different person → reload"
  branch. So A must not decide "signed out" first, and its session check gets no answer. A must also be a new tab. A tab
  keeps its saved user in `sessionStorage`, and one that still has it restores the Super Admin while its check gets no
  answer, then routes itself from `/login` to `/dashboard`: there is no form to sign in on. A new tab starts with an
  empty `sessionStorage`, so it shows the form (after about 3 s of unanswered checks) and keeps re-checking in the
  background.
- **Telling the two views apart on `/trucks`:** a Dispatcher loads the same truck list as a Super Admin, so rows and
  unit numbers cannot. The Super Admin-only parts can: the Trucks table's Owner column, and the sidebar links to pages
  the app's own router closes to a Dispatcher (their `meta.roles`). S5c counts both, before and after.

## The Dispatcher data section (D1–D3)

`ONLY=dispatcher`. The Dispatcher signs in through the form; a second context signs the Super Admin in, only to read the
same things for comparison, so a 0 cannot come from data with nothing to withhold. The broker/contact columns are the
headers matching `BROKER_WITHHELD_RE` (the mirror of `server.js`). Counts only; every value stays in memory, or in the
page.

| Step | How it is shown | Expected (AFTER) |
|---|---|---|
| D1 | The payload of the Dispatcher's own dashboard request, `GET /api/dashboard` (captured from the network). | 0 non-empty cells in any broker/contact column (not even a name). |
| D2 | A page `fetch` of `GET /api/load/<id>`, as the Dispatcher and as the Super Admin. The load is the one with the most broker/contact values in the Super Admin's dashboard. | 200, with every broker/contact field blank for the Dispatcher (the Super Admin's copy still has them). |
| D3a–c | The Dispatcher's page `fetch`es of `GET /api/data` in three request shapes (the Job Tracking tab and two others), summarized in the page: the non-empty cells of broker/contact columns in every row list of the answer, and how many values look like an email address or a phone number. | 403 each: the sheet reader is Super Admin only. |

"Phone-looking" is a pattern (ten digits in the usual groupings), so it can also count a long reference number; the
email count is the sharper signal. Everything here is read-only, and safe on staging.

## The maintenance notice section (M1)

`ONLY=maintenance`, local only, on a server booted with `E2E_MAINTENANCE_NOTICE=1`. It SKIPs when the notice is off
(`GET /api/config/maintenance`), when its audience has no investors, or without the creds file's `investor2`.

| Step | How it is shown | Expected (AFTER) |
|---|---|---|
| M1a | In **one tab**: Investor A signs in, sees the popup, closes it and signs out with the sidebar; Investor B signs in on the same tab. | B sees the popup: a dismissal belongs to the person who dismissed it. |
| M1b | B closes it (if shown) and signs out; A signs back in on that tab. | A does not see it again. `PASS (vacuous)` when B did not see it either: the tab's one dismissal then hides it from everyone. |

## Teardown (once the whole QA cycle is done)

```bash
fnm exec --using=22.23.2 scripts/e2e/stop-server.sh <port>
W="$(node scripts/e2e/paths.cjs work-dir)" && echo "$W"
find "$W" -maxdepth 1 -type f \( -name '*.db' -o -name '*.db-*' -o -name 'creds*.json' -o -name 'results-*.md' \
  -o -name 'server-*.log' -o -name 'plant-journal.json' \) -print -delete
rm -rf -- "$W/shots"   # real data: the dashboard, truck lists, the driver's truck photo, the Kit page (identity documents masked)
```

The creds file's passwords exist only on the copies. In each worktree, the four symlinks and `client/dist` are gitignored;
they can stay or go.
