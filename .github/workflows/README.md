# CI/CD

Two workflows. `ci.yml` verifies, `deploy.yml` ships.

| | `ci.yml` | `deploy.yml` |
|---|---|---|
| Fires on | PR into `main`, push to `main`, manual | push to `main` → **staging**; manual → staging **or** production |
| Runs | `npm ci` ×2 · `node --check` · 45 of 46 runners · client build | lockfile reset · pull · install · build · scoped pm2 restart · smoke |
| Duration | ~1 min | well under a minute |
| Touches production | never | only on an explicit manual run |

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

On **`production`**, add yourself under **Required reviewers**. That is what turns a production deploy into an approval gate — the job pauses and waits. Without it the manual dispatch ships immediately on click.

---

## Deploying

**Staging** — automatic on every push to `main`. Nothing to do.

**Production** — Actions → *Deploy* → *Run workflow* → target `production` → Run.

**Rollback** — same dialog, set **ref** to the SHA you want back:

```bash
git log --oneline -10 main    # pick the last good SHA
```

The box checks that SHA out detached, rebuilds and restarts. Deploying `main` afterwards returns to normal — nothing needs undoing.

---

## Things the deploy does on purpose

**It resets `client/package-lock.json` before pulling.** The VPS runs npm 10.8.2, which does not know the `"libc"` field a newer npm writes onto optional platform deps, so *every* install on the box strips it and leaves the file permanently modified. `git pull --ff-only` refuses to overwrite a modified tracked file, so without the reset the first PR touching that lockfile aborts the deploy. It is pure metadata churn — npm regenerates it two steps later. **It is already modified on production right now**, so this is live, not hypothetical.

**It aborts if anything *else* is modified.** A blanket `git checkout -- .` would clear the lockfile drift and silently destroy a hand-applied hotfix with it. The deploy stops and prints what it found instead.

**It restarts by process name, never `pm2 restart all`.** This VPS runs ~23 pm2 processes for other clients (LendyPH, binhs-coop, dromic, and more). A broad restart is a multi-client outage.

**It smoke-checks `/api/config/maintenance`.** Unauthenticated, returns module constants only — no DB, no Sheets, no billed API call. It proves the process booted and Express is serving, and costs nothing. It polls for up to 60 s because boot runs schema migrations first.

**On smoke failure it prints the pm2 error log, labelled as possibly stale.** `pm2 logs --nostream` tails the error log whether or not anything new was written, so a days-old error prints and reads exactly like a fresh regression. Check the dates before concluding.

---

## What CI deliberately does not run

**`test-suite.js`.** It needs a live server, it **writes** (test 46 logs an expense), it defaults to **port 3000 — production on the VPS** — and with no `SPREADSHEET_ID` override `server.js` falls through to the **live Dispatch Management sheet**. Running it from CI would write to the client's real books.

A step in `ci.yml` greps the workflows and fails the build if anything ever invokes it. It stays a manual, deliberate, local-only harness — see CLAUDE.md for the fixture and sheet-override procedure.

**And one runner is skipped on CI: `scripts/test-pdf-cold-start.js`.** It deliberately induces an event-loop stall and asserts that the PDF renderer's retry caught it — which is a race by construction. Measured on an 8-core Mac it passes **6/6 idle but only 3/6 at load average ~11**, and a GitHub-hosted runner is **two shared cores**. Left in, CI would be red a third of the time for reasons unrelated to the change under review, and a pipeline nobody trusts is worse than none.

The skip is never silent: it prints at the start and end of the run and appears in the job summary. It does mean **the PDF cold-start path is not covered by a green check** — run `npm run test:unit` locally (no `UNIT_TEST_SKIP_TIMING`) before touching `lib/pdf-browser.js` or anything in the render path.

---

## Making production auto-deploy

Currently production ships only on a manual run. To have a merge to `main` go straight to production, change the target default in `deploy.yml`:

```yaml
group: deploy-${{ github.event.inputs.target || 'staging' }}   # ← 'production'
```

…and the two `|| 'staging'` fallbacks in the `environment:` and `Resolve target` blocks.

Worth knowing before you do: this app writes to a live Google Sheet, a production `app.db` and real invoices, and `INVOICE_AUTOGEN_ENABLED` is on in production. An unattended bad merge is not "the site is down", it is "money data was touched". The staging process exists on the same box precisely so a merge can be exercised before a human sends it on.
