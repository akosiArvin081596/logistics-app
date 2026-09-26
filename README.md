# LogisX

Dispatch and back-office platform for a trucking carrier: load ingestion from
broker rate confirmations, driver dispatch and live GPS tracking, expenses and
fuel, invoicing, driver/investor onboarding, and an investor payout ledger.

Runs in production at **app.logisx.com**.

> **Working on this codebase?** Read [`CLAUDE.md`](CLAUDE.md) first — it is the
> real documentation, and it leads with the hazards that are expensive to
> rediscover. The long-form reasoning lives in [`docs/claude/`](docs/claude/).

## Stack

| Layer | What |
|---|---|
| Backend | Node.js + Express in one large `server.js` (shared modules in `lib/`), Socket.IO for real-time |
| Primary data | **Google Sheets** (Sheets API v4) — the operational book of record |
| Local data | SQLite (`app.db`, WAL) — auth, messaging, fleet, finance, telemetry |
| Frontend | Vue 3 + Vite SPA (`client/`), Tailwind v4, shadcn-vue; Vant in the driver app |
| Files | Local `uploads/` (PODs, receipts, signed documents, the rate-con archive) + Google Drive (rate-con PDFs) |
| AI / vision | Gemini (receipt OCR, rate-con extraction), ScanKit (document scanning) |
| Telematics | Linxup GPS (webhook push), Routemate ELD |

Roles are Super Admin, Dispatcher, Driver and Investor, with per-role routing
and server-side data scoping.

## Running it

Requires **Node 22**. The exact version is pinned in `.nvmrc`, which CI reads
too. On the VPS, pm2's `interpreter` runs the app on Node 22; the box's older
*system* node belongs to other tenants, so don't align anything to it.

```bash
npm install            # postinstall also installs client/ deps
npm run dev            # Express on :3000  (terminal 1)
npm run dev:client     # Vite on :5173     (terminal 2)
```

Open http://localhost:5173 — Vite proxies `/api`, `/socket.io` and `/uploads`
to Express.

For a production-style run: `npm run build:client && npm start`, which serves
the built SPA from `client/dist/`.

### Configuration

Needed at the repo root, and never committed:

- **`.env`** — see [`.env.example`](.env.example), the canonical list of
  variables, with the reasoning for each.
- **`service-account-key.json`** — Google service account credentials.

> ⚠️ **`SPREADSHEET_ID` has no safe default.** When it is unset, `server.js`
> falls through to the **production** Dispatch Management sheet — so any server
> started without an explicit override writes to the live book. Always set it
> locally. Identify a sheet by its **ID, never its title**: the staging sheet is
> titled "logisx-production".

## Tests

No Jest/Vitest/ESLint. Instead, standalone runners plus a manual HTTP harness:

```bash
npm run check      # node --check server.js — one very large file (wc -l server.js)
npm run test:unit  # every scripts/test-* and check-* runner (.js/.mjs) — no server needed
npm run ci         # check + test:unit + build:client — the same gate CI runs
```

`npm run test:unit` (that is, `node scripts/run-unit-tests.js`) prints how many
runners it found and names each one, so no count is kept here.

`test-suite.js` at the repo root is a **separate, manual** HTTP harness. It needs
a running server, it **writes**, and it is deliberately excluded from CI — see
[`docs/claude/testing.md`](docs/claude/testing.md) for its fixture and
sheet-override procedure before running it.

## CI/CD

GitHub Actions. Every PR into `main`, and every push to it, runs the `ci` gate
above on the Node version in `.nvmrc`.

**Merging to `main` deploys staging automatically; production follows once a reviewer
approves it** (the `production` Environment has a required reviewer since 2026-09-25:
test staging, then approve). Production runs only if staging went green, smoke-checks
itself, verifies the public edge, and **rolls itself back** to the previous SHA if
either check fails.

Setup, the safety reasoning, and the rollback design: [`.github/workflows/README.md`](.github/workflows/README.md).

## Docs

- [`CLAUDE.md`](CLAUDE.md) — architecture, conventions, and the hazards
- [`docs/claude/`](docs/claude/) — long-form reasoning per subsystem
- [`docs/manual/`](docs/manual/) — user guides and technical documentation
  (the markdown source for the PDFs in [`docs/pdf/`](docs/pdf/))
