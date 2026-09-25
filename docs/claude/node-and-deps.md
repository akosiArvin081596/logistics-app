<!-- Extracted verbatim from CLAUDE.md on 2026-09-23 to keep that file inside the context budget.
     CLAUDE.md now carries a short summary and points here. Only pinned counts were dropped and
     verified errors corrected; nothing else was reworded. -->

# Node runtimes and the dependency pins

## ⚠️ The two environments now run DIFFERENT Node versions (2026-08-25)

The VPS has **two** Node runtimes and each pm2 process picks one. This is deliberate — it is what lets this app move forward without a Node upgrade on a box shared with ~23 other clients' processes.

| | Node | pm2 `exec_interpreter` | ABI (`NODE_MODULE_VERSION`) |
|---|---|---|---|
| `logisx-staging` | **22.23.2** | `/opt/node22/bin/node` | 127 |
| `logistics-app` (prod) | **22.23.2** | `/opt/node22/bin/node` (via `ecosystem.config.js`) | 127 |
| CI (`.nvmrc`) | **22.23.2** | — | 127 |
| **system node on the box** | 20.20.1 | *not ours* — apt/nodesource, ~23 other clients | 115 |

- **`/usr/bin/node` is apt/nodesource-managed and stays at 20.** Node 22 was installed from a checksum-verified tarball to `/opt/node-v22.23.2-linux-x64`, symlinked `/opt/node22`. Nothing else on the box was touched; all 23 processes stayed online throughout.
- **⚠️ `better-sqlite3` is a native module, so the Node major and the build must match.** Installing under one and running under the other is an instant `ERR_DLOPEN_FAILED` on boot — *"compiled against NODE_MODULE_VERSION 115, this version requires 127"*. **And `npm install` will NOT fix it**: npm tracks package *versions*, not ABI, so it reports "up to date" and skips the rebuild. Only `npm rebuild better-sqlite3` recompiles. `deploy.yml` now probes the module and rebuilds only when it actually fails to load. Since 2026-09-23 the probe opens an in-memory database (`new (require('better-sqlite3'))(':memory:')`) rather than only `require()`-ing it: the binding loads lazily, so `require` alone passes under the wrong Node. `backup.sh` probes the same way and picks its Node by pm2 process name, and so do `refresh-local.sh` and `refresh-staging.sh`, through one block copied byte-identically into both and pinned by `scripts/test-refresh-remote-node.js` (on 2026-09-25 their old greedy `sed` read the *last* process in `pm2 jlist`, another tenant's Node 20). Since 2026-09-26 `refresh-staging.sh` also *installs* the way the deploy does: `npm` under the interpreter pm2 runs `logisx-staging` with (it had run a bare `npm`, i.e. the system Node 20), the same probe, `npm rebuild better-sqlite3` when it fails, and no build, database or restart when the rebuild does not help; it refuses before installing when pm2 cannot say which Node that is.
- **The deploy resolves its build Node from pm2's own `exec_interpreter`, never a hardcoded path** — so repinning a process automatically repoints its build, and the two cannot drift.
- **⚠️ Production was migrated via `ecosystem.config.js`, NOT `pm2 delete` + `pm2 start`.** Staging was recreated that way safely because it carries no pm2-level settings; **production carries five** — `NODE_OPTIONS` (the 4 GB heap that exists because it was OOM-ing at the 2 GB default), `kill_timeout`, `max_restarts`, `min_uptime`, `restart_delay`. Recreating the process silently drops all of them. Apply changes with `pm2 restart ecosystem.config.js --update-env && pm2 save`.
- **⚠️ Do NOT "align" `.nvmrc` to the box's `/usr/bin/node`.** pm2's `interpreter` decides what runs this app, and that is 22 — the system 20 belongs to the other tenants.
- Rollback for the staging pin: `/root/.pm2/dump.pm2.bak.20260825-075431` plus `/root/pm2-state-before-node22.20260825-075431.json`.

## Dependency advisories — ALL CLEAR, and the two pins that keep it that way (2026-08-25)

`npm audit` reports **0 vulnerabilities** on both root and client. It got there via two `overrides` pins, not by taking npm's advised fixes — **do not run `npm audit fix --force`, and do not "tidy away" either pin.**

**Re-verified 2026-09-24 — same two pins, no third.** Advisories published after 2026-08-25 flagged `nodemailer` 9.0.5 and `qs` 6.15.3 (the latter via `express` and `body-parser`). Both cleared with in-range updates — `nodemailer` → `^9.1.1`; `express` 4.22.2 → 4.22.3 and `body-parser` 1.20.6 → 1.20.8, which is what moves `qs` to 6.16.0 — and `npm audit` is 0 on root and client again. ⚠️ `express` 4 and `body-parser` 1 declare `qs` with a **tilde** range, so `npm update qs` alone cannot cross a `qs` minor: a `qs` fix arrives through an `express`/`body-parser` patch release, and an `overrides` entry is the last resort, not the first.

**1. `uuid` → `^11.1.1` (root `overrides`).** All four moderate advisories traced to **one** root: uuid `<11.1.1` (GHSA-w5hq-g745-h8pq — missing buffer bounds check in v3/v5/v6 when `buf` is given). `gaxios`, `googleapis` and `googleapis-common` were each flagged only *via* it.
- **⚠️ npm's advised fix — `googleapis` 128 → 176 — is deliberately NOT taken.** It pulls `google-auth-library` 10.5 → `gaxios` 7, which moves to **node-fetch v3** (no `timeout` option) and reimplements `timeout` as `AbortSignal.timeout()`. **Measured** against a server that accepts and never responds: **gaxios 6 retries (4 requests); gaxios 7 does not (1 request).** That would leave `google.options({timeout})` *looking* configured while silently converting "retry 3×" into "fail the user's page on the first blip" — reviving the 150 s dashboard-hang class of bug that option exists to prevent.
- The override is inert at runtime: gaxios uses uuid for exactly one thing, `v4()` for a multipart boundary (`gaxios.js:417`), and uuid 11 still exports `v4` for CommonJS. Verified with live Sheets + Drive calls.
- **`scripts/test-google-timeout-retry.js` locks this.** It is hermetic (a throwaway localhost server, no credentials) and it **fails on gaxios 7** — verified. If it goes red, someone bumped googleapis/gaxios and the timeout layer must be rewritten *before* that lands. Do not delete the test to make it green.

**2. `pdfjs-dist` (client `overrides`) — see the note in [`client/CLAUDE.md`](../../client/CLAUDE.md#the-pdfjs-dist-security-pin).**

Revisit the googleapis bump only when its transport raises a timeout that gaxios classifies as retryable.
