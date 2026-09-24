# CI/CD

Four workflows. `ci.yml` verifies, `deploy.yml` ships, `deploy-drift.yml` catches a ship that silently never happened, and `backup-freshness.yml` catches a backup that silently never happened.

| | `ci.yml` | `deploy.yml` | `deploy-drift.yml` | `backup-freshness.yml` |
|---|---|---|---|---|
| Fires on | PR into `main`, push to `main`, manual | push to `main` → **staging → production** (auto); manual → one chosen target | every 30 min (cron; GitHub actually fires it every 2.5–6 h), manual | 04:00 UTC daily (cron), manual |
| Runs | `npm ci` ×2 · `node --check` · every runner but the timing one · client build | box lock · lockfile reset · checkout of the **exact pushed commit** · install · build · scoped pm2 restart · smoke | compare production HEAD to `origin/main`, then ask GitHub whether that commit **passed staging** → in-sync, alarm, heal once, or re-run once a Deploy run whose staging never reached the VPS | age + size + `gzip -t` of the newest nightly `app.db` snapshot, and whether the last **scheduled** run succeeded |
| Duration | ~1 min | well under a minute | seconds (a heal: a deploy) | seconds |
| Touches production | never | **every push to `main` — no approval gate** | only for a deploy that never landed. Per commit: at most one re-run of main's Deploy run, when its staging job never reached the VPS (production then follows staging as usual), then at most one heal, only once that commit has passed staging, with the same auto-rollback | never — strictly read-only |
| Self-heals | n/a | rolls back on failed verification | yes: per commit, one re-run of the Deploy run, then possibly one heal | **no, by design** |

---

## One-time setup

Nothing runs until these four repository secrets exist. **Until then the deploy job fails at the SSH step** — which is the intended failure mode, not a silent no-op.

Add at **Settings → Secrets and variables → Actions → New repository secret**.

### 1. `VPS_SSH_KEY` — the deploy private key

Generate a **dedicated** key. Do not paste in `~/.ssh/abedubas_vps`: that key is your personal login to a box hosting ~23 other clients' apps, and a repo secret is readable by anyone who can push a workflow to `main`. A separate key can be revoked without locking you out.

```bash
# On your Mac
ssh-keygen -t ed25519 -C "github-actions-logisx-deploy" -f ~/.ssh/logisx_deploy -N ""

# Authorise it on the VPS (uses your existing personal key to get in)
ssh-copy-id -i ~/.ssh/logisx_deploy.pub -o IdentityFile=~/.ssh/abedubas_vps root@76.13.22.110

# Copy the PRIVATE key into the secret — the whole file, BEGIN/END lines included
pbcopy < ~/.ssh/logisx_deploy
```

### 2. `VPS_SSH_KNOWN_HOSTS` — the pinned host key

The workflow refuses to run with this empty. It exists so the deploy never trusts whatever answers on the other end — `ssh-keyscan` at deploy time would accept a substituted host, and this step hands that host a key that can restart production.

```bash
ssh-keyscan -t ed25519 76.13.22.110 | pbcopy
```

Verify the fingerprint matches what your own client already trusts before pasting:

```bash
ssh-keygen -lf <(ssh-keyscan -t ed25519 76.13.22.110 2>/dev/null)
grep 76.13.22.110 ~/.ssh/known_hosts | ssh-keygen -lf -
```

### 3. `VPS_HOST` → `76.13.22.110`  ·  4. `VPS_USER` → `root`

Both already appear in this repo's `CLAUDE.md` and it is public, so these are secrets for tidiness, not concealment. Keeping them out of the workflow file means moving the box later is a settings change, not a commit.

### 5. Environments

**Settings → Environments** → create `staging` and `production`.

⚠️ **Neither environment has a required reviewer today** — that is what makes production auto-deploy on every merge to `main` (deliberate, 2026-08-25; the safety that replaced the human is below). To re-arm the gate, add a reviewer under **`production` → Required reviewers**: the job then pauses and waits, and no workflow file changes.

---

## Deploying

**Both are automatic on every push to `main`.** Staging deploys first; production runs **only if staging succeeded** (`needs: staging`). No approval step — see the safety note below.

**A push deploys exactly its own commit** (`sha: github.sha`), on both jobs, so production receives the very commit its staging job verified. Several quick merges deploy one after another, in order (`queue: max`). A run that starts after a newer commit is already live does nothing (`DEPLOY_NOOP=1`); it never moves backwards.

**Manual / rollback** — Actions → *Deploy* → *Run workflow* → pick a target and a `ref`. A manual run keeps the old meaning of `ref` (`main` = its tip at pull time).

From a terminal: `gh workflow run deploy.yml -f target=production -f ref=main` redeploys main's tip; `-f ref=<sha>` is the pin described next.

**Rollback** — same dialog, set **ref** to the SHA you want back:

```bash
git log --oneline -10 main    # pick the last good SHA
```

The box checks that SHA out detached, rebuilds and restarts. It also writes main's tip into the drift marker, because a pin is a human decision: `deploy-drift.yml` **raises an alarm about it and does not deploy `main` over it**. Deploying `main` afterwards returns to normal — a push, or this dialog with `ref` = `main`.

---

## Things the deploy does on purpose

**It holds a box-level lock, and a second deploy of the same app fails fast.** `remote-deploy.sh` and `remote-rollback.sh` take `flock -n` on `/var/lock/logisx-deploy<dir>.lock`. The file sits outside the repo tree, and `/var/lock` is `/run/lock` on Ubuntu (root-writable tmpfs). It holds one deploy per app directory, whatever started it: `deploy.yml`, the drift heal, an auto-rollback, or a human over ssh. A contender exits **75** and names the holder. `ssh-retry.sh` never retries 75, only ssh's own 255. The lock is a backstop: both workflows already share one concurrency group (below). ⚠️ Every `pm2` call runs with the lock descriptor closed (`9>&-`). If pm2 has to start its daemon, that daemon would otherwise inherit the descriptor and hold the lock after the deploy ended. This was demonstrated on Linux, not assumed. If a deploy ever refuses with no deploy running, `fuser -v <lockfile>` names the holder.

**It checks every git step.** The script runs without `set -e`, so each step is checked explicitly. A failed fast-forward or checkout fails the deploy with nothing built or restarted, and so does a pinned `sha` that is missing or that `main` does not contain. (A failed fetch is only a warning. Whatever step needed the missing commit then fails.)

**It resets `client/package-lock.json` before pulling.** The VPS runs npm 10.8.2, which does not know the `"libc"` field a newer npm writes onto optional platform deps, so *every* install on the box strips it and leaves the file permanently modified. `git pull --ff-only` refuses to overwrite a modified tracked file, so without the reset the first PR touching that lockfile aborts the deploy. It is pure metadata churn — npm regenerates it two steps later. **It is already modified on production right now**, so this is live, not hypothetical.

**It aborts if anything *else* is modified.** A blanket `git checkout -- .` would clear the lockfile drift and silently destroy a hand-applied hotfix with it. The deploy stops and prints what it found instead.

**It restarts one process, never `pm2 restart all`.** This VPS runs ~23 pm2 processes for other clients (LendyPH, binhs-coop, dromic, and more). A broad restart is a multi-client outage. Production restarts through `ecosystem.config.js` (`pm2 restart ecosystem.config.js --update-env`, which touches only the process the file names), staging by name; nothing runs `pm2 save`, so a changed setting reaches the live process but not `/root/.pm2/dump.pm2`.

**It probes `better-sqlite3` by opening a database.** The native binding loads lazily, so a bare `require()` passes under the wrong Node. The probe opens an in-memory database; on failure it runs `npm rebuild better-sqlite3` and probes again, and a module still broken fails the deploy before any restart.

**It smoke-checks `/api/config/maintenance`.** Unauthenticated, returns module constants only — no DB, no Sheets, no billed API call. It proves the process booted and Express is serving, and costs nothing. It polls for up to 60 s because boot runs schema migrations first.

**On smoke failure it prints the pm2 error log, labelled as possibly stale.** `pm2 logs --nostream` tails the error log whether or not anything new was written, so a days-old error prints and reads exactly like a fresh regression. Check the dates before concluding. The log prints with workflow commands switched off (`::stop-commands::` with a random token), so no line of the app's log becomes an annotation that the drift gate would read.

---

## What CI deliberately does not run

**`test-suite.js`.** It needs a live server, it **writes** (test 46 logs an expense), it defaults to **port 3000 — production on the VPS** — and with no `SPREADSHEET_ID` override `server.js` falls through to the **live Dispatch Management sheet**. Running it from CI would write to the client's real books.

A step in `ci.yml` greps the workflows and fails the build if anything ever invokes it. It stays a manual, deliberate, local-only harness — see [`docs/claude/testing.md`](../../docs/claude/testing.md) for the fixture and sheet-override procedure.

**And one runner is skipped on CI: `scripts/test-pdf-cold-start.js`.** It deliberately induces an event-loop stall and asserts that the PDF renderer's retry caught it — which is a race by construction. Measured on an 8-core Mac it passes **6/6 idle but only 3/6 at load average ~11**, and a GitHub-hosted runner is **two shared cores**. Left in, CI would be red a third of the time for reasons unrelated to the change under review, and a pipeline nobody trusts is worse than none.

The skip is never silent: it prints at the start and end of the run and appears in the job summary. It does mean **the PDF cold-start path is not covered by a green check** — run `npm run test:unit` locally (no `UNIT_TEST_SKIP_TIMING`) before touching `lib/pdf-browser.js` or anything in the render path.

---

## Production auto-deploys — what carries the safety

Enabled 2026-08-25 at the owner's request. There is **no approval gate and nobody watching**, so three things replace the human:

1. **staging is a hard prerequisite.** On a push, `production` has `needs: staging` and runs only on `success`. Same box, same pm2, same Node — a merge is always exercised somewhere first.
2. **Every deploy smoke-checks**, and production additionally verifies the public edge through nginx.
3. **Production auto-rolls-back.** If its smoke or edge check fails, the workflow checks the box back out at the SHA it was on *before* the deploy, rebuilds, restarts and re-verifies. The job still goes red — a successful rollback is not a successful deploy — but production does not sit broken waiting to be noticed. Tested for real: staging was rolled to an older SHA, served 200, and rolled forward again.

**Staging deliberately does NOT auto-roll-back** (`rollback_on_failure: "false"`). It is the canary; a failure should stay put so it can be inspected.

A rollback also records the commit it rejected in the drift marker, so no automatic path deploys that commit again. A human decides what happens next.

**Deploys never overlap.** `deploy.yml` and `deploy-drift.yml` share **one literal concurrency group** (`deploy-refs/heads/main`) with `queue: max`. A drift run therefore waits for an in-flight deploy and reads the box after it; a deploy waits for a heal. A Deploy re-run that a drift run asks for joins the same group behind it and starts once the drift run ends. The drift run never waits for it, so nothing can deadlock. The default queue keeps only one pending run and **cancels** it when another arrives, which in a shared group could cancel a queued deploy; `queue: max` keeps up to 100 waiting, in order. The box lock (above) catches anything that does not come through Actions. ⚠️ actionlint 1.7.12 predates `queue` (GitHub, 2026-05) and reports it as an unexpected key. Lint with `-ignore 'unexpected key "queue" for "concurrency" section'`.

### To turn auto-deploy back off

Give the `production` GitHub Environment a **required reviewer** again (Settings → Environments → production). The workflow needs no change — the job will simply pause for approval. That is the whole switch. It covers the drift heal too, which runs in the same `production` environment. Note that a run waiting for approval holds the shared deploy queue, so everything behind it waits as well. Reject a stale one rather than leaving it pending.

### Where the deploy logic lives

`scripts/deploy/remote-deploy.sh`, `remote-smoke.sh`, `remote-rollback.sh` — versioned in the repo, not inline in YAML, so both jobs share one reviewable copy and cannot drift. `.github/actions/vps-deploy` is the composite step that ships them over ssh and wires the rollback. deploy.yml's two jobs **and** the drift heal all use it. Runner-side, `ssh-setup.sh` writes the key and the pinned host key, and `ssh-retry.sh` is the one copy of the transport retry, used by every connection. `remote-drift-check.sh`, `remote-drift-heal.sh` and `drift-gate.js` are the drift path, described below.

Tests: `scripts/test-deploy-scripts.js` runs the real scripts through `bash -s` against a throwaway git sandbox, each property with mutants:
- the lock, exact-SHA deploys and the marker's three writers;
- retry and setup, including `ssh-retry.sh`'s exact give-up line, which the gate reads back;
- the smoke check's log tail printing with workflow commands off;
- a static pin that no remote script exits 255 itself.

`scripts/test-drift-gate.js` covers the staging gate, pins the drift workflow's permissions and deploy.yml's staging-before-production `if:`, and runs the rerun job's own script against a stub `gh`. Both are picked up by `npm run test:unit`, so CI runs them.

---

## Deploy drift — what each state does

`deploy-drift.yml` has three jobs. **check** reads the box (`remote-drift-check.sh`). For `behind-healable` only, it then asks GitHub whether main's exact commit passed the **`staging` job of its push-triggered Deploy run** (`drift-gate.js`, with `actions: read`, plus `checks: read` for a failed staging job's annotations). **heal** runs only on a green gate, in the `production` environment. It first re-reads the box and writes the marker (`remote-drift-heal.sh`, which refuses if production moved since the check). Then it runs the same `vps-deploy` action as production, pinned to that exact commit, with auto-rollback. **rerun** runs only when main's staging job never reached the VPS. It asks GitHub to re-run that Deploy run's failed jobs, and holds the workflow's only write permission (`actions: write`, set on the job, which replaces the workflow's read-only set for that job). It checks nothing out and runs no action. The check job shreds the deploy key as soon as it has read the box, so the gate runs with no key on disk.

⚠️ **A run that is not completed is `pending`, whatever its jobs say.** The gate reads the Deploy run's own status before any job. While a drift run executes it holds the shared concurrency group, so a Deploy run it sees is either completed or queued behind it, and a queued re-run still lists its previous attempt's jobs. It never keys on the staging job's own `run_attempt`: after a re-run of production alone, staging keeps attempt 1 in a run on attempt 2, and that pass still counts toward a heal.

| State | Meaning | Action |
|---|---|---|
| `in-sync` | production HEAD = `origin/main` | pass |
| `behind-healable` | behind, serving 200, no marker, **and main's commit passed staging** | **heal once** (deploy → smoke → edge → rollback on failure) |
| `behind-staging-pending` | behind, but main's Deploy run, or a queued re-run of it, has not finished yet | notice only; the deploy is on its way |
| `behind-staging-unreached` | main's staging job **never reached the VPS** (every ssh attempt exited 255, so ssh-retry.sh gave up), and its Deploy run is still on its first attempt | **re-run once**: that run's failed jobs, so staging deploys and smoke-checks again and production follows only if it passes |
| `behind-staging-unreached-retried` | staging never reached the VPS, but the Deploy run has already been re-run (by this workflow or by hand) or reports no attempt number | **alarm**. 255 is not only the network: a refused deploy key, a changed host key or a dropped session end the same way. Check those, then `gh run rerun <run-id> --failed` |
| `behind-staging-failed` | staging **rejected** main's commit, or failed with annotations that could not be read | **alarm**; production must not get it |
| `behind-staging-unverified` | no push-triggered Deploy run for the commit (e.g. `[skip ci]`), still none on a re-look 20 s later; or the API lookup failed | **alarm**; no heal without a verdict |
| `behind-already-attempted` | the marker names main's commit | **alarm** |
| `behind-and-unhealthy` | behind **and** not serving 200 | **alarm**; an incident, not a missed deploy |

A production job that failed on **transport** after staging passed stays healable. That is the case this workflow exists for. A production job that failed **verification** is not healable, because its rollback wrote the marker.

**A STAGING job that failed on transport is re-run, never healed.** It left no staging verdict to heal on. `ssh-retry.sh` prints `::error title=VPS unreachable::ssh failed to connect after N attempts — …` only after its last attempt, and `drift-gate.js` reads that line back from the failed staging job's check-run annotations. It matches the title, or the message prefix alone, which is all a Deploy run from before the title carries. The rerun job then re-runs that Deploy run's failed jobs. That replays the same run on the same commit: staging deploys and smoke-checks first, and production runs only if staging succeeds (`needs: staging`), so the staging gate still decides. Nothing in the drift workflow deploys production for this case. "Once" is GitHub's own `run_attempt`: only attempt 1 is re-run. A staging job that failed for real never carries the annotation, so it still alarms as `behind-staging-failed`, and so does one whose annotations cannot be read.

"Never reached the VPS" means every ssh attempt exited 255. That is usually the runner→VPS network, which is what `ssh-retry.sh`'s message says, but a refused deploy key, a changed host key and a dropped session end the same way. So when the re-run fails too, check those before the network.

Right before asking, the rerun job reads the run back in one call. It must still be main's push-triggered Deploy run for the commit the check read on the box, and still on attempt 1. It must also still be main's newest push-triggered Deploy run. A mismatch in the first is an error. A re-run made since the check, or a newer push to `main`, is a notice and no re-run: the newer push's own Deploy run goes first and decides for `main`.

Two side effects of the re-run:
- **A persistent staging ssh failure alarms one drift tick later than before.** The first tick re-runs; the tick after it sees attempt 2 and alarms (`behind-staging-unreached-retried`).
- **A re-run deploys main's commit to staging again.** If someone deployed another branch to staging by hand in between, the re-run moves staging back to main over it.

**The marker (`.drift-heal-attempted`) names the one main commit drift must not auto-deploy.** It has three writers, and each means a human decides now:
- `remote-drift-heal.sh`: a heal of that commit was already attempted. It is written before the deploy, so a heal that dies halfway still counts.
- `remote-rollback.sh`: production verification rejected that commit.
- `remote-deploy.sh` with a non-`main` `ref`: a human pinned production elsewhere while `main` was at that commit.

It never needs clearing by hand. Once production reaches `main` (a push, or a manual Deploy of `main`), the state is `in-sync` and the marker no longer matches anything.

⚠️ **The gate finds deploy.yml's job by its `name: staging`.** Rename it and every heal fails closed as `behind-staging-unverified` until `STAGING_JOB_NAME` in `drift-gate.js` moves with it. `scripts/test-drift-gate.js` pins the two together.

---

## Backup freshness — why a fourth workflow exists

`backup.sh` can only ever report a failure into `backups/backup.log`, and **nothing reads that file.** That has now cost two silent outages of the only backup of a 411 MB database holding every SSN, EIN and bank routing number:

| When | Nights lost | Cause |
|---|---|---|
| 2026-08-26 .. 08-31 | six | cron's `PATH` resolved `node` to the system Node 20; `better-sqlite3` is built for 22 |
| 2026-09-15 .. 09-19 | five | `pm2 jlist` is one line of JSON, so a greedy `sed` captured **another tenant's** `exec_interpreter` |

Both root causes are fixed in `backup.sh` — it now selects the interpreter **by process name** via a real JSON parse, and its capability probe **opens a database** rather than merely `require()`-ing the module. That second point is the subtle one:

```
/usr/bin/node        v20.20.1   require("better-sqlite3") PASS   new Database() FAIL
/opt/node22/bin/node v22.23.2   require("better-sqlite3") PASS   new Database() PASS
```

The native binding loads **lazily**, so the old probe passed under a Node that could not actually run the backup.

But the failure mode that actually hurt was never "the backup broke" — it was "the backup broke and nobody found out for five days." No fix inside `backup.sh` can solve that, because the report has nowhere to go. So snapshot age is checked **from outside the box**.

**States** (anything but `fresh` fails the job):

| State | Meaning |
|---|---|
| `fresh` | newest nightly snapshot is < 25 h old, over the size floor, passes `gzip -t`, and the last scheduled run succeeded |
| `stale` | newest snapshot is ≥ 25 h old. Age is counted in whole hours, and at the 04:00 check a missed 02:00 run leaves a snapshot ~25h59m old — 25, which a 26 h limit let through for a day. At 25 the **first** missed night alarms |
| `degraded` | snapshot is fresh but the last **scheduled** run FAILED — i.e. someone ran it by hand while cron is still broken. This was the live state on 2026-09-19 and is exactly the case a naive age check would wave through. Both of `backup.sh`'s failure lines count: `[backup] backup FAILED with exit code N` and `[backup] FAILED: <why>` |
| `too-small` / `corrupt` | under the 1 MB floor, or `gzip -t` fails — catches a truncated write that age and size both pass |
| `missing` | no `app.db.<date>_<time>.gz` at all. The glob deliberately matches only the dated nightly shape, so a **pinned** pre-operation snapshot in `.retention-keep` can never masquerade as a fresh one |

**Deliberately not self-healing.** Unlike `deploy-drift.yml` there is nothing safe to retry: a backup that failed for an unknown reason should stop and get a human, not re-run on a schedule.

Logic lives in `scripts/deploy/remote-backup-check.sh`, versioned like the other remote halves and piped over ssh stdin. It connects through the same `scripts/deploy/ssh-setup.sh` (pinned host key, refuses an empty one) and `ssh-retry.sh` (transport-only retry) as every deploy, under **its own** concurrency group: it never queues behind a deploy, never holds one up, and never takes the box's deploy lock. `scripts/test-drift-gate.js` §7 pins all of that, plus a repo-wide rule that no workflow puts an expression inside a `run:` script.
