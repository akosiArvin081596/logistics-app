<!-- Extracted verbatim from CLAUDE.md on 2026-09-23 to keep that file inside the context budget.
     CLAUDE.md now carries a short summary and points here. Only pinned counts were dropped and
     verified errors corrected; nothing else was reworded. -->

# Helper scripts in `scripts/`

Helper scripts in `scripts/`:
- `reset-super-admin-password.js` — resets `super_admin`'s `password_hash` in a target `app.db`
  (defaults to the one beside the repo, or pass a path). Takes the plaintext from **`NEW_PASSWORD`**,
  never argv, so it stays out of shell history and `ps`; enforces a **16-char minimum**; verifies the
  bcrypt hash round-trips *before* writing; refuses unless **exactly one** row changed; then **clears
  `sessions`** so the old password's cookies stop working. Committed 2026-08-12 (PR #275) — it had
  existed untracked on the VPS since **2026-04-13**.
  - **⚠️ It fixes a FORGOTTEN PASSWORD, not a zero-Super-Admin state, so the guards it was once said to
    excuse are all still load-bearing.** It matches `WHERE username = 'super_admin'` and exits 1 with
    "no super_admin user found" when the row is gone, and it only writes `password_hash` — so it does
    **not** restore a *demoted* admin's role either. `DELETE`/`PUT /api/users/:id` refusing to remove or
    demote the last Super Admin, and `SETUP_RECOVERY_TOKEN`, remain the only cover for those two cases.
    Do not read "the script exists now" as "the guards can go."
  - **⚠️ Why the 2026-08-08 check said this file did not exist, so nobody repeats it.** It was verified
    against "the repo and the VPS checkout" — but the file was **untracked** in both. Anything that
    enumerates the repo through git (`git ls-files`, `git grep`, a tracked-file listing) reports nothing,
    and on the VPS it sits under `??` in `git status`, which is easy to read past. Its mtime is four
    months *older* than the verification that denied it. **A tracked-file query cannot answer "does this
    file exist" — stat the path.**
- `prepare-test-fixtures.js` — makes a LOCAL app.db runnable by `test-suite.js` by setting known
  passwords on the accounts that already own the test data. Refuses to touch a deployed path or
  `NODE_ENV=production`, and requires `--yes-local-db`. Deliberately does NOT wipe/reseed: loads live
  in Google Sheets, so a truncate destroys the fixture chain and cannot rebuild it.
- `seed-staging.js` — seed a staging DB.
- `refresh-env.js` + `refresh-local.sh` / `refresh-staging.sh` — rebuild LOCAL/STAGING from
  current `main` plus a trimmed, sanitized production snapshot. See [`environment-refresh.md`](environment-refresh.md)
  and `scripts/README-env-refresh.md`.
- `backup-db.js` — consistent, verified, gzipped snapshot of a LIVE `app.db` via SQLite's Online
  Backup API (a plain `cp` misses `-wal`). Driven nightly by `backup.sh` at 02:00 into
  `backups/`; those files are what the refresh scripts read.
- `geocode-loads.js` — backfill geocodes for rows in "Job Tracking".
- ~~`generate-timeline-docx.py` / `generate-timeline-apr13-apr17.py`~~ — **gone; `scripts/` contains no `.py` file at all** (verified 2026-08-26). They were never committed, so `git log` shows no deletion and any tracked-file query reports them as "not in the repo" rather than "removed" — the exact inverse of the `reset-super-admin-password.js` trap below. **Stat the path.**
