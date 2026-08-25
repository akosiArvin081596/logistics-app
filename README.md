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
| Backend | Single-file Node.js + Express (`server.js`), Socket.IO for real-time |
| Primary data | **Google Sheets** (Sheets API v4) — the operational book of record |
| Local data | SQLite (`app.db`, WAL) — auth, messaging, fleet, finance, telemetry |
| Frontend | Vue 3 + Vite SPA (`client/`), Tailwind v4, shadcn-vue, Vant on mobile |
| Files | Google Drive (PODs, rate cons) + local `uploads/` |
| AI / vision | Gemini (receipt OCR, rate-con extraction), ScanKit (document scanning) |
| Telematics | Linxup GPS (webhook push), Routemate ELD |

Four roles — Super Admin, Dispatcher, Driver, Investor — with per-role routing
and server-side data scoping.

## Running it

Requires **Node 22** (see `.nvmrc`; both VPS environments run 22.23.2 via pm2's `interpreter`). The *system* node on that box is still 20.20.1 and belongs to other tenants — don't align to it.

```bash
npm install            # postinstall also installs client/ deps
npm run dev            # Express on :3000  (terminal 1)
npm run dev:client     # Vite on :5173     (terminal 2)
```

Open http://localhost:5173 — Vite proxies `/api` and `/socket.io` to Express.

For a production-style run: `npm run build:client && npm start`, which serves
the built SPA from `client/dist/`.

### Configuration

Two files at the repo root, neither in git:

- **`.env`** — see [`.env.example`](.env.example), the canonical list of all 62
  variables with the reasoning for each.
- **`service-account-key.json`** — Google service account credentials.

> ⚠️ **`SPREADSHEET_ID` has no safe default.** When it is unset, `server.js`
> falls through to the **production** Dispatch Management sheet — so any server
> started without an explicit override writes to the live book. Always set it
> locally. Identify a sheet by its **ID, never its title**: the staging sheet is
> titled "logisx-production".

## Tests

No Jest/Vitest/ESLint. Two harnesses:

```bash
npm run check      # node --check server.js — server.js is ~47k lines in one file
npm run test:unit  # 46 standalone runners in scripts/ — hermetic, ~20s
npm run ci         # all of the above + client build (exactly what CI runs)
```

`test-suite.js` at the repo root is a **separate, manual** HTTP harness. It needs
a running server, it **writes**, and it is deliberately excluded from CI — see
[`CLAUDE.md`](CLAUDE.md) for its fixture and sheet-override procedure before
running it.

## CI/CD

GitHub Actions. Every PR runs the `ci` gate above on Node 22. Merging to `main`
auto-deploys **staging**; **production** is a manual, approval-gated run of the
*Deploy* workflow. Setup and reasoning: [`.github/workflows/README.md`](.github/workflows/README.md).

## Docs

- [`CLAUDE.md`](CLAUDE.md) — architecture, conventions, and the hazards
- [`docs/claude/`](docs/claude/) — long-form reasoning per subsystem
- [`docs/manual/`](docs/manual/) — operational manual
