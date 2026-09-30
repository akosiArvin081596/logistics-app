# Browser end-to-end harness (`scripts/e2e/`)

Playwright (`playwright-core`) drives the real LogisX UI in Chrome for Testing. It signs in as each role, works through
the screens, captions every step on the page, screenshots it, and writes one verdict per step to a results table. In this
repo, "test" means this: a real browser run through the UI, headed so a person can watch, on a local server **and** on staging.

It is **not part of `npm run ci`**, and it never runs in CI or on deploy. It is its own npm package (`package.json` here):
the root install, CI and the deploy never install it, and `scripts/run-unit-tests.js` only runs the top-level
`scripts/test-*` / `check-*` files.

What it covers today, by section (`ONLY` picks them):

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
- **Money path (P1, E1, N1, N1b, F1, E2, B1, RC1).** Clearing a fixed-pay driver's daily rate in the Drivers Database
  stores 0 and leaves the other pay type's value alone (P1, local and staging). A driver's new expense carries the unit
  and owner of their truck when the truck stores a spacing variant of their name (E1). A rename on the Users page also
  moves the rows stored under a spacing variant of the old name (N1), and re-spelling an account onto the spacing its
  own directory row carries saves rather than being refused as a merge (N1b). An Active Loads edit writes only the cell
  that changed, so formula cells survive (F1). A Fuel expense stored under a percentage-paid driver's name with its
  space doubled is deducted from their pay on the Financials page (E2). The startup expense backfill stamps the truck
  onto an expense filed under a driver's own account spelling when the truck assignment covering it stores that name
  with a different spacing (B1, planted before boot). A rate-con import onto a load whose Payments Table row already exists writes only the cells that change, so
  text cells stay text (RC1). E1, N1, N1b, E2 and B1 are planted and local only; F1 and RC1 are local only.
- **ELD link (L1–L3).** A truck added today, with no load in any finalized month, links to an ELD device and unlinks
  from the Trucks page even while months are finalized (L1, L2; local and staging). A linked truck whose own Job
  Tracking loads reach a finalized month is still refused (409 `PERIOD_FINALIZED`), over finalized months only: every
  one of them when a row of that truck has an unreadable date, otherwise just the months its loads reach (L3, local
  only; it writes back any link the refusal failed to protect). One sign-in; `ONLY=eldlink`.
- **Invoice editor (I1–I9).** In the draft invoice editor (Dashboard → Completed → a delivered load → Draft Invoice
  Email), ORDER # takes any printable character but `<` and `>`, 80 max, and the SUBJECT the server builds carries it as
  typed (I2, I3). An optional NOTES box prints in a labelled "Notes" box beside the totals on the invoice PDF, only when
  it is non-empty, and never in the email body (I4–I6). Approve sends the note and the Order #, and Job Tracking is
  unchanged (I7); on a server with no mail target the load dialog then says no Gmail draft was created, never "Draft
  ready in Gmail" (I7r). A note saved on the approved draft record pre-fills the next editor and its dryRun PDF, and a
  preview sent with no notes key prints it too (I8, I8b, planted, local only); the pre-filled note is labelled as carried
  over until it is typed into (I8h). The server refuses a note over 500 characters, a note that is not text, and an Order # with `<` (I9).
  One sign-in; `ONLY=invoice`. The worktree needs the POD files linked (`E2E_LINK_PODS=1`, see `prep-worktree.sh`).
- **Investor terms (T0).** What a prospective investor is shown on `/invest` today: two test investors (`QA-TEST
  Investor A` / `B`) fill the application in fresh anonymous browsers, open the Master Participation & Management
  Agreement and the Commercial Vehicle Lease on the signature page, sign all three documents, and open both again from
  the review ("Signed — View Document"). Each preview PDF carries the default 50/50 terms and no `AMENDMENT`, and the
  master's §3.3 and the lease's §2.01 read the same for A and B. Nothing is submitted (the read-only W-9 check,
  `POST /api/public/investor-w9-check`, is let through as a non-write). No sign-in and no creds file; local and staging.
  `ONLY=terms STEPS=T0`.
- **Per-investor payment terms (T1–T11).** The Super Admin creates a split and a lease invite link on `/investors`
  (T1, T2; "2,000" is refused inline). An anonymous applicant who opens a link sees the terms read-only and the
  amendment in the preview PDFs, and the page never sends terms itself (T3–T5). Plain `/invest` is still T0's contract
  (T6). Terms cannot be changed through the API (T7). The lease application is submitted and its invite is used: the
  link then answers `INVITE_USED`, and `/investor-applications` shows the lease (T8; local, or `E2E_TERMS_SUBMIT=1`). A
  revoke stops a tab mid-flow (T9). The investor detail modal survives a list refresh (T10). An admin edit mid-flow
  clears the signatures (T11). Tc cleans up. Two sign-ins (the Super Admin and a throwaway test Investor). Local and
  staging. `ONLY=terms`, and see "The investor terms section" for why T0 and T1–T11 need two server processes.
- **Investor fixes (F1–F14).** Investor config writes (F1), legal documents across investors (F2), the admin fund and
  fuel targets (F3), the investor detail modal (F4, F5), acceptances that would collide with a record or an account:
  an Investor account's email is accepted over, any other role's is refused (F6), the application status select, its
  refusals and its notice for an existing account (F7), duplicate investor
  records (F8), previews of an id that is no investor (F9), the split shown in Admin Tools and in the investor's My
  Loads note (F10), the `/invest` help text (F11), the
  account-number eye, the Docs count and a refused delete's message (F12), the `/invest` thank-you after a reload
  (F13), and the public onboarding banking route (F14). FXc lists every failing resource as the run's own probe or
  the app's. Every actor is a `QA-TEST-INV-*` account, record or application the run creates and deletes (F6c's
  throwaway Driver account included).
  Local only (`DB_PATH`); three sign-ins; `ONLY=investorfixes`. Its F-numbers are its own: the money path's F1 is a
  different step.

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
  - **The rate-con Drive folder is never reached.** `server.js` reads `RATECON_DRIVE_FOLDER_ID` with a fallback: an
    empty value, or none (the local `.env` sets none), means production's rate-con folder, which is hardcoded there.
    So it cannot be blanked like a key: `boot-server.sh` sets it to `logisx-e2e-no-drive-folder`, a value that names
    no Drive folder, so a Drive call against it names no real folder. `POST /api/loads/from-ratecon`
    (RC1) archives a rate-con to disk and mirrors it to Drive only for an attached PDF, and RC1 attaches none. It sends
    no addresses either, so the route makes no geocode or Distance Matrix call, and it never calls the Gemini
    extraction (`POST /api/loads/ratecon/extract`).
  - **The invoice section's draft calls do ask Drive, and get nothing.** `POST /api/loads/:loadId/draft-invoice` (the
    `?dryRun=1` opens and I7's approve) looks for the load's rate-con in the Drive folder, by name and then by content.
    Against `logisx-e2e-no-drive-folder` both lists fail (the server log shows `rate-con Drive list failed: File not
    found` and `rate-con content scan failed: File not found`), and the draft goes on without a rate-con. The POD is read
    from disk (the linked files, see `prep-worktree.sh`), so the POD's own Drive fallback is not reached. Gemini is
    blanked, so nothing is extracted. Each invoice render (Chromium) loads the invoice template's Google Font.
- **Steps that write the Google Sheet: F1, RC1 and the names section (K1–K3), and only the local non-production one.** Every other step that
  writes changes the SQLite copy only (trucks, drivers, expenses, sessions, audit rows). Both run only against a server
  on this machine, and both resolve the sheet the way `boot-server.sh` does and refuse production's, with the
  service-account key of the main checkout.
  - F1 checks that the row it reads matches the server's copy of that load. It edits one row through the app, then
    writes back every cell of that row that differs from its first read. It plants a formula there first when the row
    has none, and clears it again (see the money-path section).
  - RC1 snapshots the rows it and the import will write (values and formats): the next free row of the Payments
    Table, of Job Tracking and of Job Details. It plants a Payments Table row for a synthetic load (`QA-RC1-<timestamp>`)
    and checks that the server lists it. After the import it puts each of those rows back from its snapshot, when the
    row holds that load, and re-reads it (see the money-path section).
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
| `plant-before-boot.cjs` | Plants what B1 needs in a copy BEFORE a server boots on it (one expense), or removes it (`--remove`). |
| `verify-creds.cjs` | Confirms the creds file matches a copy. Prints booleans and ids only. |
| `prep-worktree.sh` | Makes a worktree bootable: links the main checkout's installs, `.env` and key, then builds `client/dist`. With `E2E_LINK_PODS=1` it also links the main checkout's POD files into `uploads/`, for the invoice section. |
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
| `plant-journal.json` | Exists only while a planted value, a row the money path created, F1's planted sheet cell or RC1's sheet rows are live (see "Planting"). |

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
# Part 4: the money path (2 or 3 sign-ins; it fits beside part 1 on one server process). B1's expense is planted
# BEFORE the boot (the server stopped): the startup backfill it shows runs once, as the server starts.
fnm exec --using=22.23.2 node scripts/e2e/plant-before-boot.cjs "$W/qa.db"   # --force replaces a planted row
fnm exec --using=22.23.2 scripts/e2e/boot-server.sh "$PWD" 3181 "$W/qa.db"
BASE_URL=http://127.0.0.1:3181 PHASE=after OUT_TAG=after-moneypath ONLY=moneypath DB_PATH="$W/qa.db" \
  fnm exec --using=22.23.2 node scripts/e2e/e2e.mjs
fnm exec --using=22.23.2 scripts/e2e/stop-server.sh 3181
# Part 5: the invoice editor (1 sign-in). The draft route reads a load's POD from the checkout's uploads/ on disk,
# so link the main checkout's POD files first (once per worktree; the main checkout has its own).
E2E_LINK_PODS=1 fnm exec --using=22.23.2 scripts/e2e/prep-worktree.sh
fnm exec --using=22.23.2 scripts/e2e/boot-server.sh "$PWD" 3181 "$W/qa.db"
BASE_URL=http://127.0.0.1:3181 PHASE=after OUT_TAG=after-invoice ONLY=invoice DB_PATH="$W/qa.db" \
  fnm exec --using=22.23.2 node scripts/e2e/e2e.mjs
fnm exec --using=22.23.2 scripts/e2e/stop-server.sh 3181
# Part 6: the investor terms (T0 renders 16 previews, T1-T11 about 17; the preview route allows 30 per 15 minutes
# per IP, so each half gets a fresh server process). T8 submits a test application: DB_PATH lets it, and Tc
# soft-deletes it and then hard-deletes it from the copy by id.
fnm exec --using=22.23.2 scripts/e2e/boot-server.sh "$PWD" 3181 "$W/qa.db"
BASE_URL=http://127.0.0.1:3181 PHASE=after OUT_TAG=after-terms-t0 ONLY=terms STEPS=T0 \
  fnm exec --using=22.23.2 node scripts/e2e/e2e.mjs
fnm exec --using=22.23.2 scripts/e2e/stop-server.sh 3181
fnm exec --using=22.23.2 scripts/e2e/boot-server.sh "$PWD" 3181 "$W/qa.db"
BASE_URL=http://127.0.0.1:3181 PHASE=after OUT_TAG=after-terms ONLY=terms STEPS=T1,T2,T3,T4,T5,T6,T7,T8,T9,T10,T11 DB_PATH="$W/qa.db" \
  fnm exec --using=22.23.2 node scripts/e2e/e2e.mjs
fnm exec --using=22.23.2 scripts/e2e/stop-server.sh 3181
# Part 7: the investor fixes (3 sign-ins, 5 public applications), on a fresh server process
fnm exec --using=22.23.2 scripts/e2e/boot-server.sh "$PWD" 3181 "$W/qa.db"
BASE_URL=http://127.0.0.1:3181 PHASE=after OUT_TAG=after-investorfixes ONLY=investorfixes DB_PATH="$W/qa.db" \
  fnm exec --using=22.23.2 node scripts/e2e/e2e.mjs
fnm exec --using=22.23.2 scripts/e2e/stop-server.sh 3181
```

- Headless: part 1 takes about 1.5 minutes, part 2 about 2.5 minutes, part 3 about 30 s, part 4 about 2.5 minutes
  (up to 80 s more when F1 has to plant its formula and wait for the server's cached copy of the sheet), part 5 about
  45 s, part 6 about 1.5 minutes (T0) and 2–3 minutes (T1–T11), part 7 about 1.5 minutes (headed about 2.5
  minutes).
- B1 deletes its expense and puts its assignment's spelling back when it runs, so plant again before every boot that
  B1 is to read. A run whose server booted before the plant scores B1 INFO (the boot never saw the row); a copy with
  nothing planted SKIPs it.
- Headed (`HEADED=1`) takes roughly two to three times as long. Headed uses slowMo 350 ms, a 1.6 s pause on every
  caption (none on the timing-critical ones), 1400×900 admin and investor windows, and a 430×900 driver window.
- A BEFORE baseline is the same run on the build without the fix, with `PHASE=before`. Use a second copy from
  `setup-db.cjs`, so both phases start from the same data.
- The parts can run side by side on different ports, each on its own copy (`setup-db.cjs` reuses the creds file's
  passwords, so one creds file serves every copy). Start the part that plants values (part 1) last: a run refuses to
  start while `plant-journal.json` exists.

⚠️ **Login limiter:** `POST /api/auth/login` allows 20 attempts per 15 minutes per server process, counting every
attempt. Per section: `trucks` 3, `signout` up to 20, `dispatcher` 2, `maintenance` 3, `names` 2, `eldlink` 1, `invoice` 1, `terms` 2 (the Super Admin and T7's throwaway test Investor; 0 with `STEPS=T0`), `investorfixes` 3 and `moneypath` up to 3 (the
Super Admin and the driver, plus the Super Admin again when E1 has to file on the driver's behalf). The sign-out figure is its
worst case: one fewer on a build without S4a's second half, and one fewer where S7 sends one sign-in (so 19 on a build
with the fixes). It fills a whole window, so run it on a fresh server process, as the recipe does. **All five together
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

### `plant-before-boot.cjs <db> [--force | --remove]`

B1 shows the startup expense backfill, which runs once, as the server starts, so its input must be in the copy before
the boot. The script plants the case the backfill's spacing step exists for: a receipt filed under a driver's own
account spelling, while the truck assignment covering its date stores the name with a different spacing.

- **Driver:** a Driver account whose name has two words. The creds file's driver is preferred, else the lowest-id
  Driver account that qualifies. No other account's name reads as the same driver, and no account, directory row or
  assignment holds the name with its space doubled. The account has a truck assignment stored under exactly its own
  spelling that covers today.
- **The row:** the expense is filed under the account's own spelling, dated today (US Central), in a month that is not
  finalized. The truck is blank and the owner 0; type Other, $0.01. `load_id` is `QA-TEST-B1` and the description
  `QA-TEST-B1-<timestamp>`, and `timestamp` records when it was planted.
- **The assignment:** re-spelled in the copy with its space doubled. `b1-plant.json` (`0600`, in the work dir) records
  the expense, assignment and account ids, never a name.
- **Output:** ids, the date and the truck's unit number only.

The backfill takes an assignment found only across spacing while no other account holds the name, the rule the money
stamps apply (`findTruckForDriverStamp()`). A receipt under a spelling no account uses is left unattributed on purpose,
so B1 plants the account's own spelling.

It refuses:

- a copy outside the work dir, or a symlink;
- a copy any process has open (`lsof`): a server booted on it has already run its backfill, so stop it first;
- a copy that already holds B1's row. `--force` replaces it, and `--remove` deletes it; both put the assignment's
  spelling back first.

The run finds the row by its `load_id` and description, deletes it at the end of B1, and puts the assignment's spelling
back from the account's own name. A run that dies mid-B1 leaves `b1-plant.json`: `--remove` (with the server stopped)
restores the assignment.

### `prep-worktree.sh [<worktree>]`

It defaults to the checkout it is in. It symlinks `node_modules`, `client/node_modules`, `.env` and
`service-account-key.json` from the main checkout (the parent of `git rev-parse --git-common-dir`; `MAIN_CHECKOUT`
overrides). All four are gitignored, so the worktree stays clean. It then runs `npm run build:client`. It never runs
`npm install` or `npm ci`, which would rewrite `client/package-lock.json`.

⚠️ If it prints `WARNING: package.json differs`, the branch changed its dependencies and the linked `node_modules` may
lack a package. Resolve that before reading a boot failure as a code bug.

**`E2E_LINK_PODS=1` (the invoice section).** `POST /api/loads/:loadId/draft-invoice` reads a load's POD from
`<checkout>/uploads` on disk, which a worktree does not have, so without this every Draft Invoice Email answers 400
"POD not found for this load". With it, the script makes `uploads/` a real directory in the worktree (the server
creates one at boot anyway; it is gitignored) and symlinks each top-level `*_POD_*` file of the main checkout's
`uploads/` into it. They are links, not copies, and nothing else is linked: no receipts, onboarding files or invoices.
It refuses an `uploads` that is itself a symlink. Remove the links with
`find <worktree>/uploads -maxdepth 1 -type l -name '*_POD_*' -delete`, before `git worktree remove`.

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
- **The rate-con Drive folder named away:** `RATECON_DRIVE_FOLDER_ID=logisx-e2e-no-drive-folder`. An empty value would
  not do: `server.js` falls back to production's folder (see "What leaves the machine").
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
  does R8 when the creds file has no `investor` entry. M1 SKIPs too (local only: the notice is off on staging), and so
  do E1, N1, N1b, F1, E2, B1 and RC1 (RC1 and F1 because they write the sheet, which only a local run may). P1 runs on
  a real driver (see the money-path section). I8 SKIPs (it plants the saved note), and I7 fills the form but SKIPs
  its Approve unless `E2E_INVOICE_APPROVE=1`: an approve creates a real Gmail draft wherever the server has a mail
  target. The investor-fixes section SKIPs as a whole (local only). Everything else runs unchanged, and the script
  discovers every id itself.
- **Expected differences:** staging's environment refresh strips identity documents. So 11a (the Kit's CDL) FAILs there,
  R10 scores only its truck-photo half, and on a build that still has the driver-files route R12 can only be
  `PASS (vacuous)` (the route answers, with no files to return).
- **Safe there:** R12 and D1–D3 only read; the sign-out section only signs in and out. R13 and R14 edit and delete
  `QA-TEST-*` trucks, like the rest of the truck section.
- **Creds file:** it has `creds.json`'s shape, with staging logins:
  `{"superAdmin": {"username", "password", "userId"}, "driver": {…}, "investor": {…}, "dispatcher": {…}}`.
  `investor` and `dispatcher` are optional. Keep it in the work dir, `0600`.
- **`ONLY=terms STEPS=T0` needs no creds file.** It signs nobody in, so a run of only login-free steps starts without
  one (point `CREDS_FILE` at a path that does not exist to prove it). It writes nothing on staging.
- **`ONLY=terms` T1–T11 need only `superAdmin`** in the creds file: T7 makes its own throwaway test Investor and deletes
  it. They write on staging: the invites T1, T2 and T11 create (revoked by Tc unless used), T7's user and T10's
  investor record (both deleted), and their audit lines (which stay). T8 SKIPs there unless `E2E_TERMS_SUBMIT=1`; with
  it, T8 submits a real application (which also sends staging's new-application emails wherever it has a mail target),
  and Tc can only soft-delete it. Run T0 and T1–T11 at least 15 minutes apart (the preview limiter, see the terms section).
- ⚠️ **A full run writes on staging.** It creates, edits and deletes `QA-TEST-*` trucks, and their audit rows stay.
  `ONLY=signout` only signs in and out. `ONLY=moneypath` saves one real driver's pay terms four times and then puts the
  row back as it was read; its `update_driver_pay` audit lines stay (SQLite only).

## Environment

| Env | Meaning |
|---|---|
| `BASE_URL` | Required by `e2e.mjs`. Refuses `app.logisx.com` (production). |
| `PHASE` | `before` or `after`. Only names the output; the "Expected" column is always the after-the-fix behaviour. |
| `OUT_TAG` | Writes `shots/<tag>/` and `results-<tag>.md` instead of `<PHASE>`, so a rehearsal cannot overwrite a baseline. |
| `ONLY` | A comma-separated list of sections: `trucks` (1–12, R1–R16), `signout` (S1–S7), `dispatcher` (D1–D3), `maintenance` (M1), `moneypath` (P1, E1, N1, N1b, F1, E2, B1, RC1), `names` (K1–K3), `eldlink` (L1–L3), `invoice` (I1–I9), `terms` (T0–T11), `investorfixes` (F1–F14). Unset: all ten, in that order, then step 12's clean-up — more sign-ins than one limiter window holds (see above). |
| `STEPS` | Only these sign-out, money-path or invoice cases, e.g. `STEPS=S5a,S7` (each has its own browser context), `STEPS=P1,F1` or `STEPS=E2,B1,RC1` (`P1` selects P1a and P1b; `N1` selects N1 and N1b), `STEPS=I8,I9` (`I3` selects I3a–c, `I7` selects I7, I7r and I7j, `I8` selects I8, I8b and I8h, `I9` selects I9 and I9a–c; I1 opens the editor whenever any of I1–I7 is picked), `STEPS=T0` or `STEPS=T1,T2,…,T11` (a terms step also runs the steps it builds on: T3 and T9 run T1, T4 and T7 run T2, T5 runs T4, T8 runs T5). The other sections ignore it. |
| `HEADED=1` | A visible browser. |
| `DB_PATH` | The copy the server runs on (inside the work dir). It is used **only** to plant stored values for steps 10, 11b–f, R3 and R15, to stage and clean up R16, to plant and read back E1, N1, N1b and E2, to read and delete B1's planted expense, to delete the rows RC1's import writes, to plant P1's own driver, to plant and delete I8's saved invoice note, to let T8 submit a test application and hard-delete it (by id) after Tc's soft delete, and for the investor-fixes section (see there). Unset: those rows SKIP, P1 uses a real driver, T8 SKIPs unless `E2E_TERMS_SUBMIT=1`, and the investor-fixes section SKIPs. |
| `E2E_TERMS_SUBMIT=1` | Lets T8 submit its test lease application on a server that is not on this machine (it writes an application; Tc soft-deletes it). Locally `DB_PATH` enables T8. |
| `E2E_INVOICE_APPROVE=1` | Lets I7 press Approve on a server that is not on this machine. Off by default: an approve creates a real Gmail draft wherever the server has a mail target. Locally `boot-server.sh` blanks them, so I7 always approves there. |
| `E2E_LINK_PODS=1` | For `prep-worktree.sh`, not `e2e.mjs`: link the main checkout's POD files into the worktree's `uploads/`, for the invoice section. |
| `CREDS_FILE` | The logins. Default: `<work dir>/creds.json`. Not needed when every section given is login-free (`ONLY=terms STEPS=T0`). T1–T11 need only its `superAdmin`. |
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
`photo`, or their application's `cdl_front`. E1 plants the driver's truck's `assigned_driver`, and E2 a directory row's
`pay_type` and `pay_percentage`. The originals are kept in memory only, and they are restored after each block and on
Ctrl-C. The money path also creates rows (a directory row, an account, expenses, an assignment, an invoice) and
deletes them again by id. While a plant or a created row is live, `plant-journal.json` records tables and ids only,
never values; while F1's planted formula or RC1's rows are in the sheet, it records their addresses. If a run dies
mid-plant, that file blocks the next run: recreate the copy (`setup-db.cjs … --force`), clear the recorded sheet cells
or rows if there are any, then delete the journal.

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

## The money-path section (P1, E1, N1, N1b, F1, E2, B1, RC1)

`ONLY=moneypath` (`STEPS` picks cases). The Super Admin signs in once, and every case but E1 shares that page; E1 signs
the driver in. With `DB_PATH`, the run first proves the server reads that file (a throwaway directory row must appear
in the Drivers Database list; `MP*` FAIL otherwise, and E1, N1, N1b, E2, B1 and RC1 SKIP). Names stay in memory: the
results name rows by id, and a spacing variant is described, never printed. No pay figure of a real driver is written
out either. `MPc` reports every restore and delete.

**Run order:** the DB check, then B1 (it reads its expense as the boot left it, before anything else runs), then P1,
E1, N1, N1b, F1, E2 and RC1.

| Step | How it is shown | Expected (AFTER) |
|---|---|---|
| P1a | **UI.** Drivers Database, Edit on a fixed-pay driver: the Daily Rate is set to the driver's current resolved rate and saved, then emptied and saved. The stored terms are read back from the list the page loads, and the dialog is reopened for the screenshot. | Daily rate stored as 0; the percentage and the pay type as they were |
| P1b | **UI.** The same driver: the rate set again and saved, then typed as 0 and saved. | The same |
| E1 | **Planted, local only.** The driver's truck stores a spacing variant of their name (the space doubled). The driver files an expense for one of their own loads whose receipt window is open, from their own page as the app does, with no receipt. The stored expense is read from `DB_PATH`. | The expense carries that truck's unit and owner |
| N1 | **Planted, local only.** A throwaway Driver account (`qa-test-n1-<timestamp> driver`) beside a directory row spelled `QA-TEST-N1-<timestamp> Driver`, with an expense, a truck assignment and a Draft invoice stored under the account's name with its space doubled. The run first confirms Job Tracking has no row for it. **UI:** Users page, Edit, Linked Driver set to the directory spelling, Save. | Every planted row carries the new name: the expense and the assignment as spelled, the invoice lowercase (that column's own convention) |
| N1b | **Planted, local only.** A throwaway Driver account (`QA-TEST-N1B-<timestamp> Driver`) beside its own directory row, planted as the same name with its space doubled (the app adds no second directory row for it), with one expense under each spelling. The run first confirms Job Tracking has no row for it. **UI:** Users page, Edit, Linked Driver set to the directory spelling (offered as stored), Save. | Saved, not 409 `DRIVER_RENAME_IS_MERGE`: the account and both expenses carry the directory spelling, and that directory row is still the only one for the name, unchanged |
| F1 | **Local only.** A load from the Super Admin's Active Loads, its sheet row read with the service account (formulas as formulas). **UI:** the load opened from the dashboard, Edit, Details changed (a `QA-F1-<timestamp>` suffix), Save changes. The row is read again. | Only the Details cell changed; every formula cell of the row is still a formula |
| E2 | **Planted, local only.** A percentage-paid driver who earns revenue in the month (see below). **UI:** Financials, the month's row in Monthly Performance (the current month, MTD; see below), the drill-down's Driver Pay table: the driver's Pay is read. A Fuel expense ($250, or half the driver's month net when that is smaller) is planted under their name with its space doubled, dated in that month, and the month is opened again. The response behind each opening is read too. | The driver's Pay drops by the planted amount × their percentage (±$1: the page shows whole dollars). The month's Fuel Spend rises by the planted amount on every build: the control that the receipt counts in the month |
| B1 | **Planted before boot, local only** (`plant-before-boot.cjs`). An expense with a blank truck, under a driver's own account spelling, dated today inside a truck assignment re-spelled with the space doubled. **UI:** Expenses, All, its description typed into the search box: the row's Truck column. The stored row is read too. | The startup backfill stamped it: the Truck column shows the assignment's truck (`#<unit>`), and the row stores that truck's unit and owner |
| RC1 | **Local only.** A Payments Table row planted for a synthetic load `QA-RC1-<timestamp>`: the text `00123` (Invoice Number), the text `=QA` (Payment Status) and a formula (Amount Due To Carrier, `=<Payment Amount>-<Tender Fee>`), both texts written RAW; Payment Amount blank. The page then sends `POST /api/loads/from-ratecon` as the review modal does: the load number, a rate of $1,234.00 and a Details note, with no PDF. The row is read back: each cell's entered type (grid data) and the `FORMULA` render. **UI:** the Data Manager, Payments Table, searched for the load, before and after. | Only the blank Payment Amount changed (filled with the rate). The text `00123` and the text `=QA` are still text, the formula is still the same formula, and every other cell is as planted |

**Why P1 sets the rate first.** Every month but the current one may be finalized, and the month-end lock refuses a
directory edit that moves a finalized month's pay. The rate is first set to what the driver is already paid (their own
rate, else their truck's, else the $250 default), so neither save moves a figure the pay math reads. A refusal is
still possible on data that disagrees, and is scored INFO with the server's reason.

- **Local (`DB_PATH`):** a planted directory row, `QA-TEST-DRV-<timestamp>-P1`: fixed, rate 0, owner-operator share 37 %.
  The share is the inactive pay type's value that must survive. It is deleted at the end.
- **Staging (no `DB_PATH`):** a real fixed-pay driver whose resolved rate a clear cannot move. Their row is put back
  exactly as it was read, and the `update_driver_pay` audit lines stay.

**E1's fallback.** If none of the driver's loads takes a receipt today, the Super Admin files the expense on the
driver's behalf, which reaches the same truck lookup; the row says so. The expense is deleted and the truck's name
restored at the end.

**Why N1 renames by case.** The Users page offers only names in the drivers directory as a Linked Driver. A rename onto a
name the directory already holds is refused as a merge. So the one rename this page can make is a re-spelling of the
account's own directory name. The throwaway account, its directory row and every planted row are deleted at the end,
by id, and the run then counts what is left under the throwaway name (it expects none).

**What N1b adds.** The other re-spelling the page can make is by spacing: the list trims only the ends of a name, so a
directory row stored with its space doubled is offered as stored. Such a row, and the rows under its spelling, are the
account's own, and a build without the fix refuses the re-spelling as a merge (409 `DRIVER_RENAME_IS_MERGE`, its
`mergeTargets` naming that directory row and the expense). Its toast then reads "Cannot rename" between two names that
render identically. Any other refusal (a 409 with another code) is INFO. The same clean-up and count as N1 follow.

**F1's formula cell.** A row that already has a formula keeps it as the test's subject. Otherwise `=1+1` is written
into an empty column that no feature reads (never a money, status, date, contact, address or driver column; a column
that reads like progress or holds a link only when nothing else is empty). The run then waits, up to about 80 s,
until the server's cached copy of the sheet shows the computed value, as a person opening the load would see it.
Afterwards every cell that differs from the first read is written back (formulas and numbers as entered, text as
plain text), the planted formula is cleared, and the row is read once more to confirm it matches.

**E2's driver.** The driver pay month rows are keyed by the directory row that wins for the name (the lowest id, as
the pay math picks it). E2 uses a percentage-paid driver with revenue in the current month when there is one. With
none, it switches the fixed-pay driver with the most revenue this month to percentage (40 %) in the copy for the step,
and restores the directory row's pay type and percentage at the end. The name must have a space to double, and no
account or directory row may hold the doubled spelling. The planted expense is deleted by id. The results report the
Pay's move as a share of the expected deduction; they give it in dollars only when the percentage is the 40 % the
step set and the receipt is the default $250. The month is the current one (the receipt dated today). When no driver
has revenue in it yet, early in a month, it is the previous month while that is still open (not finalized in
`period_locks`), with the receipt dated its last day. With neither, E2 SKIPs.

**Why B1 is planted before boot.** The backfill runs once per boot, over every expense with a blank truck, so a row
planted into a running server's copy is never seen. B1 reads what the row stores: a unit means it was stamped; `NULL` means an older build
ran the backfill and found no truck (it rewrote unmatched rows); `''` means no truck was found by a build that writes
only matched rows, or that no boot has processed it yet. The run compares the row's plant time with the server's pid
file to tell those apart: a server that booted before the plant scores INFO.
The backfill leaves finalized months alone, so the row is dated today, in an open month.

**RC1's rows.** The rows RC1 and the import write are the first free rows below each tab's data. Each is snapshotted
first and must be empty. The import appends one Job Tracking row, updates the planted Payments Table row, and appends
one Job Details row, which carries no load id (the tab's key column is unnamed), so it is recognized by position and
by the Payment it holds. At the end each row that differs from its snapshot is put back from it (values and formats,
`updateCells`), only when it holds this step's load, and read again. Each tab's data must then end where it did. The
import's rows in the copy are deleted as well: its dispatch notification, and any document or `load_coordinates` row
(none, with no PDF and no addresses). Its `create_load_ratecon` audit line stays, as the harness's other audit lines
do. The server's 60 s cache of Job Tracking can still list the load for up to a minute after the clean-up. While the
sheet rows are live, `plant-journal.json` records their addresses.

## The names section (K1–K3)

`ONLY=names`, local only (a staging run SKIPs it with a reason). It writes the local non-production sheet the way F1
and RC1 do: it resolves the sheet as `boot-server.sh` does, refuses production's, snapshots every row it touches first
(values and formats) and restores and re-reads each one. `Kc` reports every restore. The name under test is test data;
real driver names are never printed.

| Step | How it is shown | Expected (AFTER) |
|---|---|---|
| K1 | The Dispatcher dispatches a real load to a driver name that reads as a built-in property name, through the request the Job Board's Assign sends (its dropdown cannot offer such a name). The row is read back. | 400 `DRIVER_NAME_RESERVED` naming the field; the row is unchanged |
| K2 | That name is stored in the Driver cell of a completed load in the current open month (as someone with access to the sheet could), after a baseline read. **UI:** the Super Admin opens the Dashboard and Financials. | Both load (200); an unrelated driver's figure and the fleet revenue match the baseline; the load counts as unassigned |
| K3 | The Dispatcher edits a load and saves a harmless changed cell as a value the sheet would store as a formula, then as a plain signed number. | The first is refused 400 `FORMULA_NOT_ALLOWED`, shown on the page, with nothing written; the plain number is saved |

**Run order.** K1 and K3 run first and K2 last. **After a BEFORE run, stop that server and never reuse it:** a build
without the fix can be left in a broken state for the rest of that process, so every run gets a fresh server.

## The invoice editor section (I1–I9)

`ONLY=invoice` (`STEPS` picks cases). The Super Admin signs in once and every step shares that page. The editor is
`InvoiceDraftPreviewModal.vue`: it opens with `POST /api/loads/:loadId/draft-invoice?dryRun=1` and re-renders as you
type with `POST /api/loads/:loadId/invoice-preview`. The evidence is the page's own requests and responses, the form,
and the invoice PDF the server rendered: each `invoicePdfBase64` is decoded and its text read in Node with the app's
own `pdfjs-dist` (`client/node_modules/pdfjs-dist/legacy/build/pdf.mjs`). The "Notes" label prints letter-spaced and
upper-cased (`N O T E S`), so it is matched with its spaces removed. Only ids, booleans, codes and the typed test
values are written out: the subject is shown from `Order #` on (`<broker>` stands for the broker's name), and the
Job Tracking row, the recipient and every amount stay in memory.

**The load** is discovered at run time, from the Super Admin's own `GET /api/dashboard` and `GET /api/documents/<id>`
(no draft budget spent): a Completed load whose status reads delivered, completed or POD received, with a POD.
Non-Bison loads come first (a Bison load renders nothing until its Order # and PO # are typed), then loads with a
Payment (so the dryRun renders a PDF), then loads with no draft yet (no second confirm on Approve). The first whose
dryRun answers 200 is used, trying at most four. A Bison load still works: I1 ticks "This rate confirmation has no PO
#", and a load with no derivable total gets 1234.00 typed (Approve then confirms the edited total).

**Budgets, per server process:** one sign-in; `POST …/draft-invoice` (25 per 15 minutes per user, the `?dryRun=1`
opens included) three times, plus one per candidate whose dryRun failed; `POST …/invoice-preview` (120 per 15
minutes) about seventeen times.

**What it writes:** the approve (I7) mints the next invoice number, in the copy. Locally it creates no mail draft
and no draft record: `boot-server.sh` blanks Gmail and the n8n invoice webhook, so the route answers 200 with
`preview: true`. I8 plants one `load_invoice_drafts` row, recorded in `plant-journal.json` by id, and deletes it at the
end of I8, at the end of the section, and on Ctrl-C. `Ic` reports the delete. Nothing writes the sheet: I7j proves it
for the load under test.

| Step | How it is shown | Expected (AFTER) |
|---|---|---|
| I1 | **UI.** Dashboard → Completed → the load (searched by number) → **Draft Invoice Email**. A page `fetch` of `GET /api/load/<id>` then reads the load's Job Tracking row, before any edit. | The editor opens (the dryRun answers 200); the row is read (kept in memory) |
| I2 | **UI.** Type `7101850-$700 ADV` into ORDER #. The invoice-preview response it triggers is read. | No error under the field; the hint "Invoice only — Job Tracking is not changed." shows; the SUBJECT in the response and on the form ends `Order #7101850-$700 ADV`; the PDF prints `Order: #7101850-$700 ADV` |
| I3a | **UI.** Type `A (ADV): 50% + fee & 'tax' @ dock`. | Accepted; the SUBJECT ends with it, with a literal `&` (never `&amp;`), and so does the PDF |
| I3b | **UI.** Type `7101850<b>`. | The error "Must start with a letter or number — any characters except < and >, 80 max." under the field; no preview request carries it; Approve disabled |
| I3c | **UI.** Paste an 81-character value (select all, then text insertion, as a paste); then put back `7101850-$700 ADV`. | The field holds the first 80 characters (`maxlength="80"`); the put-back value renders |
| I4 | **UI.** Type a three-line note into NOTES: `Advance $700 paid at pickup.` / `Detention 2h — see POD.` / `Ref <ADV-7101850> & thanks`. The viewer is then panned and zoomed onto the totals row for the screenshot. | The counter reads `79 / 500`; the PDF has the "Notes" label followed by the three lines, in order, exactly as typed (`<ADV-7101850>` and `&` literal, no `&amp;`); the preview's email body does not carry the note |
| I5 | **UI.** Clear NOTES. | No "Notes" label and none of the note's text in the PDF; its text and positions are identical to I2's render (the same fields, no note), so the totals box stands alone with no gap or blank box |
| I6 | **UI.** Type a note, then **Reset to extracted values**. | NOTES empty with no "edited" badge; the next preview (notes `""`) has no "Notes" section |
| I7 | **UI.** Type a note and the Order # `7101850-$700 ADV`, then **Approve & Create Draft**, accepting any confirm. The approve request is read. Local only unless `E2E_INVOICE_APPROVE=1`. | The request body carries `notes` exactly as typed and `orderNumber: "7101850-$700 ADV"` |
| I7r | The approve's response, then the message under the load's title in the load dialog (`.draft-result`) once the editor closes. | Scored only when the response has `preview: true` (no mail target — locally always, since `boot-server.sh` blanks Gmail and the n8n webhook): the message does **not** say "Draft ready in Gmail" and says no Gmail draft was created ("Invoice … was generated, but no Gmail draft was created — this server has no mail account configured."). Any other response (a real draft): INFO. The row also lists the response (200, `preview: true`, the server's note "No Gmail/n8n draft target configured"; its own PDF prints the note) |
| I7j | A page `fetch` of `GET /api/load/<id>` again, compared field by field with I1's read. | Identical: the editor wrote nothing to Job Tracking |
| I8 | **Planted, local only.** A `load_invoice_drafts` row for the load with a two-line note (and minimal other columns). `GET /api/loads/<id>/invoice-draft` must return it first, which proves `DB_PATH` is the server's file (otherwise it is deleted again and I8 SKIPs). **UI:** reload the page and open the editor again. | NOTES is pre-filled with the saved note exactly; the dryRun echoes it; the dryRun's own PDF prints it under "Notes" |
| I8b | **Planted, local only**, while I8's note is there: a page `fetch` of `POST /api/loads/<id>/invoice-preview` with an otherwise valid body and **no** `notes` key, as a tab still running a bundle from before Notes sends it. | Its PDF prints the saved note under "Notes": the approve's rule for an omitted key (the last approved note), so that tab previews what it would send |
| I8h | **Planted, local only**, in I8's editor: the NOTES box is read with the pre-filled note untouched; then **UI:** click into it and type ` (edited)` at the end of the note. | While untouched, "Carried over from this load's last approved invoice — clear it or use Reset if it no longer applies." shows under NOTES; after typing it is gone. SKIPs when I8 had no note to pre-fill |
| I9, I9a–c | Page `fetch`es of `POST /api/loads/<id>/invoice-preview` with `X-Requested-With`, as `useApi` sends them. The body is otherwise valid (invoice #, invoice date, total, recipient, and an Order #, `7101850`, that every build accepts); I9 is that body as it is, the control. | I9: 200. I9a, notes of 501 characters: 400 `INVOICE_NOTES_TOO_LONG`. I9b, `notes: ["x"]`: 400 `INVOICE_NOTES_INVALID`. I9c, `orderNumber: "a<b"`: 400 `ORDER_NUMBER_INVALID` |
| Ic | Local only. | The planted row deleted; no plant journal left |

**On a build without the feature** (a BEFORE baseline): the Order # keeps its old rule (letters, numbers, spaces and
`. _ / # -`, 40 max), so I2 and I3a are refused by the form, I3c's field holds 40 characters, and I3b's refusal carries
the old sentence (a FAIL on the wording: `<` is refused on both builds). The editor has no NOTES box, so I4–I6 FAIL. I7
finds Approve disabled (the `$` in the Order #). The draft table has no `notes` column, so I8 and I8b FAIL. The server
ignores `notes`, so I9a and I9b answer 200. I1, I7j, I9 (the control) and I9c pass on both builds. There is no
approve there, so no I7r row, and I8h SKIPs (nothing is pre-filled).

**On a build with Notes but before the follow-ups** (`718e386`): I7r FAILs — the load dialog says "✓ Draft ready in
Gmail" although the response is `preview: true` and no draft exists — and I8h FAILs (no "carried over" hint). Every
other row passes.

## The investor terms section (T0–T11)

### T0: what `/invest` shows today

`ONLY=terms STEPS=T0`, local and staging, no sign-in: `/invest` is public, and it sends a signed-in user elsewhere. Each test
investor gets a **fresh anonymous browser context**. It records what a prospective investor is shown before any change
to the payment terms, so the Expected column is the same on every row: default 50/50 terms, no `AMENDMENT`, identical
for A and B.

**The walk-through, per investor** (`InvestorApplyView.vue`, as a person does it; the guided wizard, which opens by
itself, is closed with its own button):

1. Step 1 of 3: the application, all fake. Legal name and contact `QA-TEST Investor A <timestamp>` (B for the second),
   `QA-TEST DBA A`, `1xx QA-TEST Street, Testville, TX 75001`, a `(555) 010-01xx` phone, `qa-test+<ts>a@example.com`,
   EIN `00-000000x`.
2. Step 2 of 3: one fake vehicle (VIN `QATEST0000000000A`). Then each document card opens the signature page
   (`InvestorSignModal.vue`), which fetches its preview. The master and the lease are read, and the viewer is pointed
   at the page carrying the clause for a second screenshot (the iframe's `#page=` open parameter; the document is not
   touched). Each document is signed as a person signs it: the consent box, the typed name (the same QA-TEST name),
   strokes drawn on the canvas, **Sign Document**. The page then renders the preview again, with the signature.
3. Step 3 of 3: fake banking (`QA-TEST Bank`, routing `000000000`), then **Review & Complete**, which only opens the
   review modal. There, "Signed — View Document" for the master and the lease: both read, as above.
4. **Confirm & Complete Onboarding is never pressed.** On top of that, every request from these pages that is not a GET,
   the preview route or the read-only W-9 check is aborted in the browser; T0l lists any that was attempted.

**The read-only W-9 check.** Step 1's Continue, and each W-9 signature, send `POST /api/public/investor-w9-check`: it
asks whether the W-9 can print the typed legal name, business name, address and signature name (the application's own
`lib/w9-input.js` check), and answers 200 `{ ok: true }` or the 400 the application would get. It stores, renders and
sends nothing, so the pages let it through (`TERMS_READ_ONLY_POSTS` in `e2e.mjs`). T0l and Tm list it, with its
status, apart from the writes, and it never counts as one. Everything else that is not a GET or the preview, above all
`POST /api/public/investor-apply`, is still aborted. T0 sends it four times (twice per investor), under its own limiter
(60 per 15 minutes per IP).

**How a PDF is read.** Every document is the stateless preview, `POST /api/public/investor-preview-pdf/<docKey>`.
The page reads it with `res.blob()`, and Chromium keeps no copy of a body read that way (Playwright's `Response.body()`
answers empty). So the preview request is passed through a route: `route.fetch()` sends the page's own request
(method, headers, body) to the server, the harness keeps the bytes, and `route.fulfill()` hands the page that exact
response. The text is read with the app's own `pdfjs-dist`, as in the invoice section, whitespace collapsed; images are
counted from the operator list.

| Step | How it is shown | Expected |
|---|---|---|
| T0a / T0e | A / B: the master agreement's preview on the signature page, before signing. | `distributed according to a 50/50 split` and `Participant Distribution (50%)` present; `AMENDMENT` (upper case, so the boilerplate "amendment" of §7.06 does not count) absent |
| T0b / T0f | A / B: the lease's preview on the signature page, before signing. | `50/50 profit participation model` present; no `AMENDMENT` |
| T0c / T0g | A / B: the master from the review modal, "Signed — View Document". | As T0a, and the signed copy is the signer's: their typed name is in the text, and the drawn signature is embedded (more images than the unsigned copy) |
| T0d / T0h | A / B: the lease from the review modal. | As T0b, with the same signer check |
| T0i | The master's §3.3, from `3.3 Revenue Participation` up to `3.4 Settlement Cycle`, in all four master PDFs (A and B, signature page and review). | Present in all four and identical; the row quotes it |
| T0j | The lease's §2.01, from `2.01 Lease Payments` up to `2.02`, in all four lease PDFs. | Present in all four and identical; the row quotes it |
| T0k | The JSON body keys the page sent to the preview route (sorted), unsigned and signed, and those of `banking` and `vehicles[0]`; the preview count per investor. | INFO: recorded for a later regression check |
| T0l | Every write the pages attempted; the read-only `POST /api/public/investor-w9-check` calls are let through and listed apart, with their status, as non-writes. | No attempted write (the W-9 check is not one), and both walk-throughs reached the review |
| T0m | The browser console's errors, page errors and failed API requests on `/invest`. | INFO |

**Why the typed name is checked the way it is.** The renderer replaces the signer's signature slot ("Participant
signature", "Lessee signature") with the drawn image, so the typed name is never printed on the signature line. It
appears because the same name was given as the legal name and the contact, and the signature shows up as images: the
unsigned copies have none, the signed master three and the signed lease two.

**Budget and writes.** No sign-in. The preview route allows 30 renders per 15 minutes per IP, and each investor makes
8 (three opens, three re-renders after signing, two from the review), so a run makes 16: a second run against the same
server within 15 minutes gets 429s. Locally, restart the server between runs. The preview route writes nothing, and the
application is never submitted, so the section leaves nothing behind locally or on staging. The QA-TEST data lives only
in the two browser contexts, which are closed at the end.

### T1–T11: per-investor payment terms

`ONLY=terms STEPS=T1,T2,T3,T4,T5,T6,T7,T8,T9,T10,T11`, local and staging. The feature (the shared contract): a Super
Admin creates a personal invite link on `/investors` that carries payment terms, either a 50/50 split with extra details
or a fixed monthly lease. The applicant who opens it sees them read-only and signs contracts carrying them as
"AMENDMENT NO. 1". Plain `/invest` keeps T0's contract. The steps address the UI by the contract's `data-test` names
(`invites-panel`, `invite-name`, `invite-email`, `invite-type-split|lease`, `invite-amount`, `invite-details`,
`invite-create`, `invite-link`, `invite-terms-card`, `sign-terms`, `review-terms`, `invite-error` with `data-code`,
`investor-terms-section`).

**Who signs in:** the Super Admin once; every admin step shares that page. T7 signs in once more, as a throwaway test
Investor (`QA-TEST-INV-<timestamp>`) that it creates through `POST /api/users` with a random password held in memory
only, and deletes at its end. Applicants are fresh anonymous contexts with T0's safety net: every write but the preview
route, the read-only W-9 check (let through and listed as a non-write) and T8's one submit is aborted in the browser,
and a successful submit is kept from leaving for `logisx.com`.
Invite tokens are credentials: the results never print one (the link dialog's screenshot does show it; the invites are
revoked or used by the end of the run).

| Step | How it is shown | Expected (AFTER) |
|---|---|---|
| T1 | **UI.** `/investors` → the invites panel → the form: `QA-TEST Invite Split <ts>`, `qa-test+<ts>@example.com`, split, details "Quarterly review call with owner.", Create. | `POST /api/admin/investor-invites` 201; a dialog whose `invite-link` value matches `/\/invest\?invite=[A-Za-z0-9_-]{43}$/`; the panel's row shows Active and a 50/50 summary |
| T2 | **UI.** A lease invite: amount "2,000", then Create; then "2000", with details of two lines, the second typed with a U+202E (right-to-left override) inside it. | "2,000": an inline error (one that is gone once the amount is valid, or `aria-invalid`) and no invite with that email in `GET /api/admin/investor-invites?status=all`. "2000": 201, the link, a row showing Active and $2,000.00; the saved details are both lines with no bidirectional control character, and none is shown in the panel |
| T3a | **Anonymous.** The split link, step 1 filled (`QA-TEST Investor S <ts>`), step 2. | `invite-terms-card` shows "50/50" and the details, with no input, select, textarea or contenteditable in it. Also recorded: the URL keeps `?invite=`, and the token travels in `X-Invite-Token`, not in the URL of `GET /api/public/investor-invite` |
| T3b | The master agreement card: the preview PDF. | Contains "AMENDMENT NO. 1", the details and "50/50 profit split"; not "Fixed monthly lease payment" |
| T3c | That preview's request body. | `invite_token` (the link's own) and no key that reads as terms (`pay`, `lease`, `amount`, `detail`, `term`, `split`, `amend`, `revision`) beyond T0's list |
| T4a | **Anonymous.** The lease link (`QA-TEST Investor L <ts>`): step 2's card, and `sign-terms` on each signature page. | The card, and `sign-terms` on the master and the lease, read-only and showing $2,000.00; the card's details carry no bidirectional control character; no `sign-terms` on the W-9 |
| T4b | The master agreement's preview. | Contains "$2,000.00" and "fixed monthly lease payment"; not "distributed according to a 50/50 split" |
| T4c | The vehicle lease's preview. | Contains "$2,000.00" and "Fixed Monthly Lease Payment"; not "Disbursements shall be calculated based on the 50/50 profit participation model" |
| T5a | All three signed, fake banking, Review & Complete. | 3/3 signed; `review-terms` shown, read-only, with $2,000.00 |
| T5b | Review → "Signed — View Document", the master agreement. | Contains "$2,000.00"; more images than T4b's unsigned copy (the drawn signature is embedded) |
| T6a | **Anonymous.** Plain `/invest` (`QA-TEST Investor N <ts>`), step 2. | No `invite-terms-card`, no `invite-error`, no `GET /api/public/investor-invite` |
| T6b | The master's preview. | "distributed according to a 50/50 split" and "Participant Distribution (50%)"; no "AMENDMENT"; §3.3 equal to T0's |
| T6c | The lease's preview. | "50/50 profit participation model"; no "AMENDMENT"; §2.01 equal to T0's |
| T6d | The preview bodies, unsigned (master, lease) and signed (the master re-render). | Exactly T0's keys (T0k); signed adds `signatureImage`, `signatureText` |
| T7a | **The test Investor**, page fetches: `PUT /api/investor/config?ownerId=<own id>` `{"investor_split_pct":"99"}`, with a GET before and after. | 403; the GETs agree |
| T7b | `POST /api/admin/investor-invites`. | 403 |
| T7c | `PUT /api/admin/investor-invites/<the lease invite>`. | 403 |
| T7d | **Anonymous** (a cookie-less request context): the master preview with the lease token and `payment_type: "split"`, `lease_amount: "1"` (plus `paymentType`, `leaseAmount`, `details`, `amendment_details`). | The PDF still shows $2,000.00; no $1.00, no injected details, no 50/50 §3.3 |
| T7e | **Super Admin**: `PUT /api/investor/config` with no `ownerId`; the body is the global `investor_split_pct` as read, so a build that still accepts it writes nothing new. | 400 `OWNER_ID_REQUIRED` |
| T7f | `DELETE /api/users/<the test Investor>`. | 200 |
| T8a | **Local (`DB_PATH`) or `E2E_TERMS_SUBMIT=1`.** T5's page: Confirm & Complete Onboarding; then the admin panel. | 200 with an application id (recorded in "Discovered ids"); the body carries the token and `invite_terms_revision`; the lease row shows Used |
| T8b | The lease link, opened again in a fresh context. | `invite-error` with `data-code="INVITE_USED"`; no form |
| T8c | **UI.** `/investor-applications`: the row's Terms column; the row's detail. | Both show the lease at $2,000.00 (the API's `payment_terms_summary` and `paymentTerms` are recorded too) |
| T8d | `PUT /api/admin/investor-invites/<the used invite>` (amount 2500). | 409 `INVITE_LOCKED` |
| T9 | T3's tab, still on step 2 of the split link. **UI:** the Super Admin presses Revoke on its row (a native confirm is accepted; an in-page one is confirmed, with the reason "QA-TEST e2e" when it asks). The tab then opens a document. | The revoke answers 200; the tab shows `invite-error` with `data-code="INVITE_REVOKED"` |
| T10 | **UI.** Add Investor `QA-TEST-INV-<ts>-REC`, its name clicked in the Investor Directory (the detail modal), then a page fetch `PUT /api/investors/<id>` (a notes change), which refreshes the list over the socket. | 2 s later the modal and its `investor-terms-section` are still visible. The record is deleted at the end |
| T11 | An API-made lease invite ($1,500). **Anonymous:** its link, the master signed. The Super Admin `PUT`s the amount to 1750 (`expectedRevision`). The tab opens the lease. | The lease preview carries the new `X-Payment-Terms-Revision`; the page shows "LogisX updated the payment terms in your invitation. Please review and sign the agreements again."; the master is no longer signed |
| Tm | Every anonymous page of T3–T11. | INFO: aborted writes (the read-only `POST /api/public/investor-w9-check` is not one: it is let through and listed apart, with its status), console errors, renders per page |
| Tc | **Always runs.** | Every invite the run made that is still active is revoked (and any earlier run's `QA-TEST Invite …` left active). Every application it made (and any earlier run's QA-TEST one) is soft-deleted, then, locally, hard-deleted by id. The test user and record are deleted. Ids only |

**Steps build on each other.** T3 and T9 use T1's split link, T4 and T7d T2's lease link, T5 continues T4's tab, T8
submits T5's application, and T9 reuses T3's tab (it opens its own when T3 did not run). `STEPS` adds what a picked step
needs, and those steps record their rows too. A step whose input is missing records one FAIL row, "not reached", naming
what was missing.

**What it writes, and where it is cleaned up:**

- **Invites:** T1's split, T2's lease (and a second one if the build wrongly saves "2,000"), T11's. Tc revokes each one
  still active; T8's lease is used, and T9's split is already revoked. Their rows and audit lines stay.
- **T7's throwaway Investor account:** deleted at T7's end, or by Tc. Its `investor_config` rows go with it (the
  delete's own cascade).
- **T8's application** (local, or `E2E_TERMS_SUBMIT=1`): Tc soft-deletes it through `DELETE /api/investor-applications/<id>`.
  Locally it then deletes it from the copy by exact id, with its `investor_onboarding`, `investor_onboarding_documents` and
  `investor_payment_info` rows. It deletes only an application with a QA-TEST name that has been soft-deleted. It also
  deletes the three signed PDFs the server wrote under this checkout's `uploads/investor-onboarding-signed/`, each only
  when its sha256 equals the artifact hash the row recorded. On staging the soft-deleted row stays.
- **T10's investor record:** deleted at T10's end, or by Tc.
- Nothing is planted, so the section needs no `plant-journal.json`. A run that dies mid-way leaves at most these rows,
  and the next run's Tc revokes and deletes the QA-TEST ones it finds.

**Budget.**

- **Previews:** `POST /api/public/investor-preview-pdf` allows 30 renders per 15 minutes per IP, and refused requests
  count. T1–T11 make about 17: T3 1, T4 4, T5 3, T6 3, T7d 1, T9 1 (the refused one), and T11 3–4. T0 makes 16.
  **T0 and T1–T11 together (33) do not fit one window**, and the run warns when the steps picked add up to more than 30.
  So run them as two parts, each on a fresh server process locally, or 15 minutes apart on staging. The recipe's part 6
  does this.
- **Sign-ins:** 2 (the Super Admin and the test Investor). `GET /api/public/investor-invite` (60 per 15 minutes) is
  called a handful of times, and so is the read-only `POST /api/public/investor-w9-check` (60 per 15 minutes).

**Staging.** The creds file needs only `superAdmin`. Everything but T8 runs there as it does locally. T8 SKIPs unless
`E2E_TERMS_SUBMIT=1`: it writes a real application, which also sends staging's new-application emails wherever staging
has a mail target, and Tc can only soft-delete it.

**On a build without the feature:** T6 PASSes on both builds; it is the regression control, holding plain `/invest` to
T0. T7f and Tc PASS as well.

**What the steps assume about the UI** (not fixed by the contract; check them against the built feature):

- The create form sits in the invites panel. It is either already open, or behind the panel's closed `<details>` or a
  button whose name reads like "New invite" (T1 tries all three).
- The type choice may be a radio or a button: a radio is checked (forced, for a styled one), anything else clicked.
  `invite-amount` shows once "lease" is chosen.
- The link dialog closes with a Close / Done / OK button, or on Escape.
- A row in the panel is the smallest element holding the invitee's name and a status word (Active / Used / Revoked /
  Expired). Its summary carries "50/50" (split) or "$2,000.00" (lease). Revoke is a button in that row.
- The inline error for "2,000" is an element with `role="alert"`, an error / invalid / danger class, red text, or
  `aria-invalid="true"` on the amount box.
- `invite-terms-card` is shown on step 2 of 3 (Fleet & Documents). The cards' text carries "50/50" or "$2,000.00".
  `sign-terms` shows on the master and lease signature pages only.
- The revision notice is found by its text.
- The detail modal on `/investors` is a fixed-position element under `<body>` that holds the record's name.
- `/investor-applications` has a column whose header reads "Terms", and the detail dialog (`role="dialog"`) has a
  "Payment Terms" section.
- An invite link may pre-fill and lock the legal name or email; a locked field is left as it is, and the name the form
  holds is used.

## The investor-fixes section (F1–F14)

`ONLY=investorfixes`, **local only** (`DB_PATH`): it plants rows (F3, F10b, F12b), reads what an acceptance created
(F6), reads an accepted application's bank row (F14), and removes the applications afterwards, which the API can
only soft-delete. On any other server, or without `DB_PATH`, the whole section SKIPs.

**Test actors only.** The copy holds real investors. Every investor account, investor record, truck and application
the section touches is one it creates, named `QA-TEST-INV-<stamp>-…` with emails `qa-test+<stamp>-…@example.com`:

- **FX0** (Super Admin API): investor accounts A and B (`POST /api/users`, random passwords kept in memory only), an
  investor record for each (`POST /api/investors`), and a truck owned by A. The run proves `DB_PATH` is the server's
  file by finding account A in it under the id the API lists.
- **FX1** (the public `POST /api/public/investor-apply`, fake data): applications P and Q with the same company name,
  and C whose email is account A's. F13 makes application E through the `/invest` UI.
- **F6c** (Super Admin API, then the public API): a throwaway Driver account (`qa-test-inv-<stamp>-drv`, a random
  password in memory only, and **no driver name**, so neither its create nor its delete syncs the Carrier Database
  sheet, and no finance row matches its cascade name), and application D with its email.

No real investor is signed in as, edited, uploaded for or accepted, and the creds file's investor logins are not used.
An acceptance's temporary password is never written out; in the screenshot of the credentials dialog it is masked.
Saved screenshots also blur, for the moment of the shot, every table row that is not QA-TEST data. A blur rather than
a mask, because a mask box is drawn over a row even where an open dialog covers it.

**What leaves the machine.** Nothing beyond the other sections: mail is blanked, so the applications' confirmation
emails and the acceptances' welcome emails go nowhere. Each application renders its three signed PDFs in the server's
Chromium, and `/invest` renders previews the same way. `/invest` sends an applicant to the public site 5 s after
submitting: the run answers that navigation with a local placeholder page and aborts any other request to the
`logisx.com` hosts.

| Step | How it is shown | Expected (AFTER) |
|---|---|---|
| F1a | Investor A's page fetch: `PUT /api/investor/config?ownerId=<A's id>` `{"investor_split_pct":"99"}` with `X-Requested-With` | 403; `GET /api/investor/config` unchanged; no per-investor row written |
| F1b | Super Admin's page fetch: `PUT /api/investor/config` with no `ownerId`, sending the global split's own value (nothing changes) | 400 `OWNER_ID_REQUIRED` |
| F1c | **UI.** `/investors`, investor B's Split % cell: 45, Save. The copy's `audit_trail` is read | 200, and an audit row records the split change |
| F2a | **UI.** Investor A uploads a document from their Legal Documents panel. B's page fetch: `DELETE /api/legal-documents/<A's id>`. A's panel is reloaded | B refused (4xx); the document still listed for A |
| F2b, F2c | B's page fetch: `POST /api/legal-documents/upload` with `investorId` = A's record (F2b), or `truckId` = A's truck (F2c). **UI:** A's panel. `driverId` is not tried: every driver on the copy is real | Refused (4xx), or not stored against A (not in A's list) |
| F3 | **Planted:** A's own `investor_config` rows `maintenance_fund_monthly` 98765 and `fuel_savings_target_pct` 87. **UI:** Expenses → Maintenance Fund and Fuel Logs; the two GETs behind them | The global values (800, 15%), not the planted ones |
| F10a | The global split set to 55 (`PUT /api/investor/config`; set in the copy if the build refuses that). **UI:** Admin Tools, Fleet Configuration. Put back at once | "Owner Take %" shows 55 |
| F10b | **Planted:** A's own split stored as `"150"`. **UI:** A's portal, My Loads expanded (the note renders with no loads) | The "Your Share" note shows the split the server applies (100) |
| F9 | **UI:** `/investor-portals`, then `/investor-portals/99999999`; the page's own requests under `/api/investor` are watched. Page fetch `GET /api/investor?as_user_id=99999999`, compared with the Super Admin's own `GET /api/investor` | 404 `INVESTOR_NOT_FOUND`; the page renders the "Investor not found" card (naming the id, with "Back to Investor Portals") and no portal: no "Previewing" banner, no portal section, no fleet numbers, no portal data request |
| F8 | Page fetch: `POST /api/investors` twice with one name and carrier name | The second 409 with a code; one record |
| F5 | **UI:** `/investors` → + Add Investor (a record with no application) → its detail modal. The Investor Directory is the `table.inv-table` whose header has "Investor Name" (see below) | "No application data linked" |
| F4 | With that modal open, a page fetch `PUT /api/investors/<id>` (notes); the server emits `investors:changed`; 2 s | The modal still open |
| F11 | **UI:** `/invest`, the guided tour resumed at its banking card, its FAQ link "Is my banking info secure?" | No "encrypted … at rest" claim, and none that bank details can be updated any time from the dashboard |
| F13 | **UI:** the whole `/invest` flow for application E (three documents signed on the canvas), then a reload | "Thank you, <name>" after the reload |
| F13n | While F13 signs, a trial click on each sign dialog's × (INFO) | An observation: whether the guided tour covers the × |
| F7a | **UI:** `/investor-applications`, "Accepted" picked in P's status select; native and in-page dialogs and the `PUT …/status` are watched | A confirmation before anything is sent. (An AFTER build's dialog is confirmed, so P is accepted for what follows.) |
| F6a | Page fetch `PUT /api/investor-applications/:id/status` "Accepted" for Q (the same company name as P); the copy is read for accounts, records and trucks made | 409 with a code; Q not left Accepted; nothing made |
| F6b | Page fetch `PUT /api/investor-applications/:id/status` "Accepted" for C (A's email); the copy's whole-table counts of `users`, `investors` and `trucks` are read before and after, and its `audit_trail` | 200 `{ success: true, accountCreated: false, existingUserId: <A's id> }` with the message, exactly, "Accepted. This application's email matches Investor account #<A's id>, so no new account, investor record or trucks were created. Confirm it is the same person before acting on its banking or vehicle details."; C Accepted; the three counts unchanged; one `accept_investor_existing_account` audit row for C. (Mail is blanked, so "no email" is not observable.) |
| F6c | A throwaway QA-TEST **Driver** account (`POST /api/users`, no driver name) and application D with its email (`POST /api/public/investor-apply`, fake data); page fetch `PUT /api/investor-applications/:id/status` "Accepted" for D; the copy's whole-table counts of `users`, `investors` and `trucks` before and after, and the `audit_trail` rows for D (recorded, not scored) | 409 `{ code: "USER_ALREADY_EXISTS", error }` with the error, exactly, "An account with this email already exists (Driver #<its id>) and it is not an investor account, so this application can't be accepted with that email."; D keeps its status (not Accepted); the three counts unchanged; nothing created for D. FXz deletes the Driver account (API) and D (soft delete, then by id in the copy) |
| F12b | **Planted:** a fourth document row on application E. **UI:** the list's cell under the "Docs" header (found by its header text, not its position), then E's detail; the list API's `docs_total` for E | The Docs denominator, the API's `docs_total` and the detail all give the real count (4) |
| F7b | **UI:** "Accepted" picked in application Q's row (Q has accepted P's company name), the confirmation accepted; the list re-reads | 409 `INVESTOR_RECORD_CONFLICT`; the select back at Q's stored status, the server's message shown, Q still listed and nothing created (the copy's counts unchanged) |
| F7d | C put back by page fetch at the status it had before F6b; **UI:** "Accepted" picked in C's row (C's email is account A's), the confirmation accepted; the list re-reads | 200 `accountCreated: false` with F6b's exact message ("Accepted. This application's email matches Investor account #<A's id>, …"); the on-page notice `data-test="application-status-notice"` shows it (a warning toast is recorded); C's row reads Accepted; no credentials dialog; the copy's counts unchanged; one `accept_investor_existing_account` audit row for C |
| F7c | E soft-deleted by page fetch (the open list is not refreshed); "Reviewed" picked in its row | 409 `APPLICATION_DELETED` with the server's message shown; after the list re-reads, E's row is gone (or, still listed, shows the stored status) |
| F12a | **UI:** `/investors`, P's record → Banking → the eye by the account number | A real reveal (the full number) or no toggle |
| F14 | A public page (no session) fetches `POST /api/public/investor-onboarding/<P>/banking` with a well-formed random token (a UUID, the removed routes' shape; in the query and the body). New applications get no token, and the route must be gone whatever token is sent | 404; P's bank row unchanged |
| F12c | **UI:** `/investors`, the REC record deleted in the copy first, then Remove → Delete. The route's only refusal is an id it cannot find | The page shows the server's reason ("Investor not found") |
| FXc | Every failing resource (an HTTP 4xx/5xx or a request with no answer: its page, method, path and status; numeric ids as `:id`, uploads cut to their folder, never a query string) on every page the section opened, split into the run's own probes and the app's. A probe is a page fetch of the run (it carries `X-QA-Probe: <step>`), a UI request a step sends on purpose (F7b, F7c, F12c) or the harness's `logisx.com` block. Console "Failed to load resource" lines are matched to their resource; other console errors are listed | Recorded, not scored |
| FXz | Clean-up (below) | Nothing left; the global split as it was |

**Run order:** FX0, F1, F2, F3, F10, F9, F8, F5, F4, F11, F13 (+F13n), FX1, F7a, F6 (F6a, F6b, F6c), F12b, F7b, F7d,
F7c, F12a, F14, F12c, FXc, FXz. F7a accepts P, which F6a, F7b, F12a and F14 need. F6a's refused acceptance leaves Q as
it was, so F7b can pick "Accepted" in Q's row. F6b accepts C, so F7d first puts C back at its earlier status by page
fetch. F12b plants on E before F7c removes it.

**On a build without the exact acceptance wording** (the server change that names an Investor account's match and
refuses any other role's): F6b and F7d FAIL on the message alone (everything else about them holds), and F6c FAILs
outright, because that build accepts D over the Driver's email with 200 and marks it Accepted. Its steps still run to
the end and FXz removes the account and D.

**The Investor Directory's table, and the invites panel's.** `/investors` has two `table.inv-table` elements whenever
the Personal Invite Links panel lists an invite: the panel reuses the class, and its default filter is "all", so one
revoked invite an earlier terms run left is enough. `locator('table.inv-table')` then matches both, and Playwright's
strict mode fails the step (F5 did, and F4 and F12c, which need F5's record, SKIPped). The section addresses the
directory as the `table.inv-table` whose header has "Investor Name", and every directory row (F1c, F5, F12a, F12c)
through it. The panel's rows carry no `td.name-cell` (its name is a `div.name-cell`) and no `tr.clickable-row`, so the
terms section's `findInvestorRow()` (T10) matches the directory only.

**Budgets per server process:** three sign-ins; five public applications (`POST /api/public/investor-apply` allows 10 per
15 minutes per address); about six `/invest` PDF previews (30 per 15 minutes).

**Clean-up (FXz), in the `finally`:** the API first (legal documents, trucks, investor records, accounts, then the
applications' soft delete), then the copy by exact id: the applications with their documents, onboarding and payment
rows and the signed PDFs they name under this checkout's `uploads/`, and whatever the API refused. Then the QA-TEST
accounts' `investor_config`, `investor_payouts` and `investor_payout_history` rows, and the `audit_trail` and
`dispatch_notifications` rows written during the section (this private server only). The row records what is still
above the start mark, table by table: a login session is expected, and so is the global split's row when F10a's `PUT`
re-wrote it with its own value. The section's rows are listed in `plant-journal.json` (ids only) while they exist, and
Ctrl-C deletes them from the copy.

## Teardown (once the whole QA cycle is done)

```bash
fnm exec --using=22.23.2 scripts/e2e/stop-server.sh <port>
W="$(node scripts/e2e/paths.cjs work-dir)" && echo "$W"
find "$W" -maxdepth 1 -type f \( -name '*.db' -o -name '*.db-*' -o -name 'creds*.json' -o -name 'results-*.md' \
  -o -name 'server-*.log' -o -name 'plant-journal.json' \) -print -delete
rm -rf -- "$W/shots"   # real data: the dashboard, truck lists, the driver's truck photo, the Kit page (identity documents masked)
```

The creds file's passwords exist only on the copies. In each worktree, the four symlinks and `client/dist` are gitignored;
they can stay or go. So are the POD links `E2E_LINK_PODS=1` made; before removing a worktree, delete them
(`find <worktree>/uploads -maxdepth 1 -type l -name '*_POD_*' -delete`) along with the four symlinks.
