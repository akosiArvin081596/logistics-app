# Disk & Backup-Data Handoff (shared VPS)

**Written by the obsidian-quant workstream, 2026-08-11. We did not change anything in this
repo or in this project's data on the server.** We were tracking down disk pressure on the
shared VPS, found that the two largest consumers belong to logistics-app, and stopped there —
acting on another project's backups is your call, not ours. Everything below was read-only
(`ls`, `du`, `find`, `cat`, `docker inspect`). No file was moved, compressed, or deleted.

---

## ⚠️ RECONCILED 2026-08-18 — read this before acting on anything below

Re-measured against the live VPS on **2026-08-18**, seven days after the original survey. All
checks read-only. **The original findings were accurate when taken**; the body below is kept as
the historical record. Three things have since changed, and one recommendation is now unsafe as
written.

**Headline: disk pressure has eased on its own. 82% → 72% (79G used/18G free → 69G used/28G
free).** Nothing here is urgent any more.

**Update, same day: the OSRM extract was then deleted, taking the box to 61% — 58G used, 39G
free.** See "Finding #6 actioned" below. The 96G filesystem now has more headroom than at any
point in this document's history.

| Original claim (2026-08-11) | Measured 2026-08-18 | Status |
|---|---|---|
| Root fs 82%, 79G used, 18G free | **72%, 69G used, 28G free** | Improved 10G |
| `backups/` 8.1 GB, 53 entries | **7.2 GB, 59 entries** | Shrinking on its own |
| 31 uncompressed snapshots, 7.50 GB | **24, 6.07 GB** | Ageing out nightly |
| 10 gzipped, 0.58 GB | **20, 1.09 GB** | Every new nightly is `.gz` |
| Compression 18–21% of source | **17%** | Confirmed, slightly better |
| 30-day prune working | **Still exact** — 1 file/night at the 30.0d boundary | Confirmed |
| Six pinned snapshots, 1.54 GB | **All six present, 1.54 GB** | Confirmed intact |
| Orphan `-shm` ×4 / `-wal` ×4 | **Unchanged, still 0-byte `-wal`** | Confirmed benign |
| `backups/` is mode `0755` | **`0700`, and all 57 files `0600`** | ✅ **FIXED — action #1 done** |
| `.env.pre-*` sitting in `backups/` | **Gone** (absent under `/var/www/logistics-app`) | ✅ **action #4 appears done** |
| OSRM 11,805,038,885 B, containers `Exited (137)` | **Byte-identical; still exited; no `.osrm.*`; nothing on :5000; 1 stale `osrm` hit in deployed `server.js`, 0 in `.env`** | Fully confirmed |
| DB "plateaued" at 313,290,752 B | **317,546,496 B (302.8 MB) + 88.7 MB `-wal`** | Minor drift — still growing slowly |

### The one recommendation that is now wrong

**Do NOT run action #2 as written ("gzip the 31 uncompressed snapshots in place").** Two
independent reasons, both discovered on re-measurement:

1. **It would silently destroy the six pinned snapshots.** The pin is an exact filename set
   membership test — `pins.has(s.name)` at `scripts/backup-db.js:271`, loaded from
   `.retention-keep`, which lists the six names **without** a `.gz` suffix. Gzip renames
   `app.db.pre-datefix.20260801-013137` to `…-013137.gz`, which is **not** in the pin set, so it
   falls through to the age check — and all six are dated Jul 8 / Aug 1, far past the 30-day
   cutoff. **The next nightly run would prune them.** Action #2 as written therefore contradicts
   this document's own "Do NOT delete the six pinned snapshots" rule.
2. **~4.5 GB of the ~6 GB it targets is self-resolving.** Of the 24 remaining uncompressed
   files, 18 (**4.53 GB**) are ordinary nightlies dated Jul 20 → Aug 6. The last uncompressed
   nightly is **Aug 6** — everything after it is already `.gz` — so all 4.53 GB prunes itself by
   roughly **2026-09-05** with no action at all.

**Revised: the only durable win is the six pinned files (1.54 GB), and only if the pin survives.**
At the measured 17% ratio that is **~1.28 GB reclaimed, permanently** — not ~6.0 GB. It requires
rewriting the six `.retention-keep` entries to their `.gz` names **in the same change**, and is
worth doing only if you want the space; at 28G free it is optional. Verify a round-trip first.

### The 10G improvement is only partly attributable

`backups/` accounts for **~0.9 GB** of it. The remaining ~9 GB **cannot be attributed from
available evidence** — the original survey recorded no comparable baseline. Docker now reports
build cache at **0B** with 9.454 GB (79%) still reclaimable across images, which is a plausible
but unconfirmed contributor. Recorded as unexplained rather than guessed.

### Still open, unchanged

Finding **#5 (8 GB of plaintext financial PII on a multi-tenant box)** stands exactly as written.
The permissions half is now fixed, but that was always the smaller half — the snapshots are still
unencrypted plaintext copies of every SSN, EIN and bank account number, and that decision is
still open.

### ✅ Finding #6 actioned — OSRM extract deleted 2026-08-18

The owner made the call this document asked for. `/opt/osrm/data/us-latest.osm.pbf`
(11,805,038,885 B, mtime 2026-03-30) was **deleted 2026-08-18 06:51 UTC** after a final
pre-flight that closed the one gap the original survey left open — whether anything still
referenced it:

- Both `Exited (137)` containers ran `osrm-extract -p /opt/car.lua /data/us-latest.osm.pbf`,
  finishing **2026-03-30 09:50 and 10:03 UTC** — two OOM-killed attempts thirteen minutes apart,
  both dying at the **first** of the three preprocessing stages. This confirms the original
  inference: no `.osrm.*` output was ever produced, so the file could never have served a query.
- They are the **only** two containers mounting `/opt/osrm/data`, and there is **no** reference
  to `/opt/osrm` in systemd, cron, or any compose/service/env file on the box.

**Result: 72% → 61%, 69G used/28G free → 58G used/39G free.** One-way door as flagged — a
re-download from Geofabrik yields a newer extract, not this Mar 30 one.

Left in place deliberately: the two dead containers (1.5 MB total) and the now-empty
`/opt/osrm/data/`, which keeps their mount path valid. Neither is worth a maintenance window.

## Why you're reading this

*(Everything from here down is the original 2026-08-11 survey, kept as the historical record.
Where a number has since moved, the reconciliation block above is authoritative.)*

The shared Hostinger VPS (`srv1292086`, 76.13.22.110, 96G root filesystem) is at **82% —
79G used, 18G free** as of 2026-08-11 *(now 72% — 69G used, 28G free)*. The two largest single consumers on the entire box are
both yours: an **11 GB abandoned OSRM map extract** and **8.1 GB of database backups, 7.5 GB of
which are uncompressed plaintext copies of `app.db`**. Neither is a bug in your app. But the
backups directory turns out to be a data-protection question more than a disk question, and the
OSRM file appears to be a dead artifact from a migration that has since been superseded — so
both are worth a decision rather than being left to drift.

---

## Findings

### 1. `/var/www/logistics-app/backups` — 8.1 GB, 53 entries *(now 7.2 GB, 59 entries)*

Measured breakdown:

| Class | Count | Size |
|---|---|---|
| Uncompressed `app.db.*` snapshots | 31 | **7.50 GB** |
| Gzipped `app.db.*.gz` snapshots | 10 | 0.58 GB |
| Orphan `-shm` sidecars (32 KB each) | 4 | 128 KB |
| Orphan `-wal` sidecars (**0 bytes each**) | 4 | 0 |
| JSON one-off dumps + `backup.log` | 4 | ~20 KB |

Of the 7.50 GB uncompressed, **1.54 GB is the six pinned pre-operation snapshots** and
**5.96 GB is ordinary nightly snapshots** from 2026-07-13 through 2026-08-06.

Individual snapshots run 194 MB (Jul 8) → 313 MB (Aug 1 onward). The Aug 1–6 files are all
*exactly* 313,290,752 bytes, matching the live `app.db` — the database has plateaued at
~298.8 MiB, so snapshot size is now flat rather than growing.

### 2. Correction: the 30-day prune **is** working

We want to flag this because it is the opposite of what disk-usage alone suggests. It would be
easy to look at "files back to July 8" and conclude retention is broken. `backups/backup.log`
shows it running correctly on consecutive nights:

```
[backup] retention: keep-days=30 keep-min=7 cutoff=2026-07-12T02:00:41.183Z
[backup]   PRUNE  app.db.20260712_020001  196.9 MB  — older than 30d (30.0d, by filename)
[backup] pruned 1 file(s), freed 196.9 MB
```

It pruned `app.db.20260711_*` on Aug 10 and `app.db.20260712_*` on Aug 11 — exactly at the
30-day boundary, one per night. The oldest surviving nightly is Jul 13, which is 29 days old.
The single July 8 file is `app.db.pre-expense-backfill-20260708-055919`, which is **pinned in
`.retention-keep` and therefore deliberately exempt**.

So there is no retention bug to fix. The real arithmetic is simply: *30 days × ~300 MB
uncompressed = ~8 GB*. The cost driver is that snapshots before **2026-08-06 06:39** were
written uncompressed; gzip only starts with `app.db.20260806_063921.gz`.

### 3. Gzip is worth ~6 GB and deletes nothing *(⚠️ superseded — see reconciliation: ~1.28 GB, and it deletes the pinned six unless `.retention-keep` is rewritten with it)*

Measured compression on the 10 existing `.gz` files is **18–21% of source** (the Aug 11 log line
reads `kept app.db.20260811_020003.gz 55.1 MB (18% of source)`). Applying that ratio to the
7.50 GB of uncompressed snapshots gives roughly **1.4 GB compressed, i.e. ~6.0–6.1 GB
reclaimed** — *inferred from the measured ratio, not measured directly.*

This is the same transformation `backup.sh` → `scripts/backup-db.js` already performs on every
new snapshot. It changes no retention decision, destroys no data, and `scripts/backup-db.js`
already treats `.gz` and plain files identically for pruning (the retention matcher accepts an
optional `(\.gz)?`), so compressed files continue to age out on the same schedule.

### 4. The orphan `-wal`/`-shm` sidecars are benign — no integrity concern

Four snapshots (`20260727`, `20260801`, `20260803`, `20260804`) have `-shm`/`-wal` siblings.
These are **not** evidence of an incomplete backup. Per the header comment in
`scripts/backup-db.js`, they are created when the verify step *opens* the snapshot to run
`PRAGMA integrity_check`; the copy inherits WAL journal mode and SQLite materialises sidecars
next to it. Every one of the `-wal` files is **0 bytes**, meaning nothing was left
uncheckpointed. Each parent snapshot also passed `integrity_check` before being kept. Treat
them as clutter, not risk — and note `backup-db.js` retention now collects strays on its own.

### 5. The finding that actually matters: 8 GB of plaintext financial PII on a shared box

The directory's own `.retention-keep` says it plainly:

> `WARNING: each is a full PLAINTEXT copy of app.db — every SSN, EIN, bank routing and account`
> `number. Pinned = kept indefinitely. Unpin once the corresponding change is no longer disputable.`

This is a **multi-tenant machine** — it also runs alchemydev-crm, obsidian-quant-onboarding,
zoey, wikibotanica prod+staging, two extractor stacks, and four GitHub Actions self-hosted
runners under `/home/nodeapp/`. In our judgement the disk space is the less serious half of this
finding; unencrypted SSNs, EINs and bank account numbers at rest, on a box with that many other
tenants and CI runners, is the bigger one. **This is your call and we are not making it — but it
should be an explicit decision rather than a default.**

Your own tooling is already flagging a concrete piece of this. From `backup.log`, 2026-08-11:

```
[backup] WARNING: /var/www/logistics-app/backups is mode 0755 — group/other can list every snapshot.
[backup] WARNING:   new files are written 0600, but the existing ones keep their modes.
[backup] WARNING:   fix once with: scripts/secure-backups.sh --apply   (dry run by default)
```

The directory is `0755`. Individual snapshot files are `0600`, so the contents are not readable
by other users — but the directory listing is, which discloses your backup cadence, schema-change
history, and the names of every pre-operation snapshot. `scripts/secure-backups.sh` exists in this
repo and is executable; it has not been run with `--apply`.

> **✅ RESOLVED (verified 2026-08-18).** The directory is now `drwx------` (`0700`) and **all 57
> files are `0600`**. `secure-backups.sh --apply` has been run. The two paragraphs above and
> recommended action #1 are stale — no action needed. **The plaintext-PII half of this finding is
> NOT resolved** and remains the substantive issue.

Also sitting in that directory, unrelated to snapshots: `.env.pre-fuel-events-20260807` and
`.env.pre-gallons-recovery-20260808` — environment files, which typically carry credentials, in a
world-listable directory. `backup-db.js` correctly leaves them alone ("left alone (not app.db.*)"),
so they will stay there indefinitely.

> **✅ RESOLVED (verified 2026-08-18).** Neither file is present in `backups/`, nor anywhere under
> `/var/www/logistics-app`. The only non-snapshot entries remaining are `.retention-keep`,
> `backup.log` and three small JSON one-off dumps. Where they went was not traced.

### 6. `/opt/osrm/data/us-latest.osm.pbf` — 11 GB, and we believe it is dead *(✅ confirmed dead and DELETED 2026-08-18 — see reconciliation)*

The single largest file on the box: **11,805,038,885 bytes (11.0 GiB)**, dated Mar 30. It is the
only thing in `/opt/osrm/`.

We went looking for what still uses it, and the answer appears to be nothing:

- **Routing no longer uses OSRM.** `getRoute()` at `server.js:31431` calls the **Google Routes
  API** (`computeAlternativeRoutes`, `TRAFFIC_AWARE_OPTIMAL`, `FUEL_CONSUMPTION`/`TOLLS`
  extra-computations). There is no OSRM host, port, or URL anywhere in the codebase.
- The **only** occurrence of the string "osrm" in this repo is a stale comment at
  `server.js:31711` — `// Return empty route instead of 500 (e.g. cross-ocean routes OSRM can't
  compute)`. The deployed `/var/www/logistics-app/server.js` on the box likewise contains exactly
  one case-insensitive match. `LogisX/server.js:15142` carries the same orphaned comment.
- Both OSRM containers are **`Exited (137)`** — OOM-killed — **4 months ago**, and nothing has
  restarted them. The `osrm/osrm-backend:latest` image on the box is **5 years old**.
- `/opt/osrm/data/` contains **only the raw `.pbf`** — there are no `.osrm.*` files. OSRM cannot
  serve queries from a raw PBF; it needs `osrm-extract` → `osrm-partition` → `osrm-customize`
  output. *Inferred:* preprocessing was attempted, OOM-killed on this 8 GB shared box (a full
  US extract needs far more), and never completed. The stand-up appears to have failed and then
  been superseded by the Google Routes API integration.

Caveat worth stating: nothing on the box records **which** Geofabrik extract or date this is
beyond the Mar 30 mtime, so if it were removed and later wanted, you would be re-downloading a
*newer* extract, not this exact one. For a road network that is almost certainly an improvement,
but it is a one-way door on reproducing this specific file.

---

## Recommended actions

Ranked by value-to-risk. **All of these are yours to run — we deliberately did not.**

> **⚠️ This table is superseded — see the reconciliation at the top of this file.** As of
> 2026-08-18: **#1 and #4 are done**, **#2 is unsafe as written** (it would unpin and thereby
> delete the six protected snapshots) and its payoff is ~1.28 GB rather than ~6.0 GB, and **#3 is
> now the largest remaining item by a wide margin**. #5 and #6 stand as written.

| # | Action | Reclaims | Risk |
|---|---|---|---|
| 1 | ~~`scripts/secure-backups.sh --apply` — tighten the `0755` backups directory~~ **✅ DONE** | 0 | **Very low.** Already written, tested, dry-run by default, and your own cron is asking for it. |
| 2 | ~~Gzip the 31 uncompressed snapshots in place~~ **⚠️ DO NOT RUN AS WRITTEN** — see reconciliation | ~~**~6.0 GB**~~ → **~1.28 GB** | ~~**Low.**~~ → **High as written**: gzip renames the file, the `.retention-keep` pin is an exact-name match, so the six pinned snapshots become prunable and the next nightly run deletes them. The other ~4.5 GB self-prunes by ~2026-09-05 anyway. |
| 3 | ~~Decide the fate of `/opt/osrm/data/us-latest.osm.pbf`~~ **✅ DONE — deleted 2026-08-18, reclaimed 11.0 GB** | **11.0 GB** | **Low–moderate.** No live code path references it and preprocessing never completed. Re-downloadable from Geofabrik, but not this exact extract. Consider archiving the *decision*, not the file. |
| 4 | ~~Move `.env.pre-*` files out of `backups/` into a credential store~~ **✅ DONE** | ~0 | Low. |
| 5 | Encryption-at-rest or off-box archival for the plaintext snapshots | 0 (or all 8 GB, if off-box) | **The real remediation.** Larger change; needs a restore path that still works at 02:00 unattended. Your call. |
| 6 | Revisit whether 30 days × full plaintext copies is the right retention shape | up to ~6 GB | Policy question. A weekly/monthly tier past day 7 would cut this a lot. |

Optional cleanup with no real payoff: the 4 orphan `-shm`/`-wal` pairs total 128 KB. Not worth a
maintenance window; `backup-db.js` already sweeps strays.

---

## Do NOT do this

- **Do not delete the six pinned snapshots.** `.retention-keep` names them explicitly:
  `pre-datefix.20260801-013137`, `pre-dupe-removal.20260801-003833`,
  `pre-expense-backfill-20260708-055919`, `pre-hash-backfill.20260801-050245`,
  `pre-june-revert.20260801-141155`, `pre-restore-661.20260801-144037` (1.54 GB total). The file
  states they are *"the only record of the state before each change, which matters because those
  months are now closed and their payouts paid."* They are pinned precisely so that a
  disk-pressure reflex cannot take them.
- **Do not gzip a *pinned* snapshot without rewriting its `.retention-keep` entry in the same
  change** (added 2026-08-18). The pin is `pins.has(s.name)` — an exact filename match against
  `.retention-keep`, which lists the six names with no `.gz` suffix. Compressing one renames it
  out of the pin set and hands the nightly prune permission to delete it. This is the failure
  mode that makes recommended action #2 unsafe as originally written.
- **Do not "fix" the retention prune.** It is working correctly (see Finding 2). Changing
  `--keep-days` or the matcher to free space would delete snapshots that are legitimately inside
  the window. If you want less disk, compress — don't shorten the window by accident.
- **Do not bulk-delete the uncompressed snapshots to free space.** Gzip gets you ~6.0 of the
  ~7.5 GB with no data loss. There is no scenario where deletion is the better first move.
- **Do not copy these backups off the box for convenience** (laptop, shared drive, ticket
  attachment) without treating them as regulated data. Each file is a complete, unencrypted copy
  of every SSN, EIN, and bank account number in the system.
- ~~**Do not delete `/opt/osrm/data/us-latest.osm.pbf` on our say-so.** Our conclusion that it is
  dead is an inference from code search and container state, not a statement from whoever set it
  up. Confirm nobody is planning a self-hosted routing return first — the 11 GB is not on fire.~~
  **✅ Satisfied and actioned 2026-08-18.** The inference was independently confirmed (both
  containers died at `osrm-extract`, nothing else mounts the path, no systemd/cron/compose
  reference), the owner made the call rather than a disk-pressure reflex taking it, and the file
  was deleted. This entry is retained because the *reasoning* still applies to the next such
  artifact.

---

## Verifying any of this yourself

Read-only, safe to paste:

```bash
ssh -4 -i ~/.ssh/abedubas_vps root@76.13.22.110

df -h /
du -sh /var/www/logistics-app/backups /opt/osrm/data
tail -40 /var/www/logistics-app/backups/backup.log
cat /var/www/logistics-app/backups/.retention-keep
ls -la /opt/osrm/data/
node scripts/backup-db.js --out /var/www/logistics-app/backups --prune-only --dry-run
```

That last one is your own retention report — it deletes nothing and prints exactly what the
nightly job would consider.

---

*Questions about how these numbers were taken can go to whoever is running the obsidian-quant
workstream. We have no visibility into logistics-app's roadmap and no opinion on your retention
policy — this is a handoff, not a recommendation to act on any particular timeline.*
