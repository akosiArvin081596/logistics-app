# LogisX Documentation Source

This directory holds the markdown source for the two committed PDFs:

- **`docs/pdf/LogisX-Technical-Documentation.pdf`** — architecture, APIs, deployment, operations. For developers and technical staff.
- **`docs/pdf/LogisX-User-Manual.pdf`** — how to use the app as each of the 4 roles, plus the public flows. For end users.

Both are generated from markdown via Puppeteer (the same path the app uses for invoices and signed agreements), so no separate PDF stack is involved.

## Regenerating the PDFs

```bash
npm run docs:build              # both PDFs
node scripts/docs/generate-docs.js --technical   # technical only
node scripts/docs/generate-docs.js --user        # user manual only
```

That's it for the documents themselves. The script reads `technical/*.md` and `user/*.md` in sort order, concatenates them, runs them through `marked`, wraps the result in the HTML shell at `assets/template.html` + `assets/styles.css`, inlines every referenced image as a `data:` URI, then hands the HTML to `lib/pdf-browser.js` — the same singleton-Puppeteer pipeline used elsewhere in the app.

Output lands in `docs/pdf/`. Existing files are overwritten; the directory is auto-created.

## Re-capturing screenshots

The screenshots in `assets/screenshots/` are captured by Puppeteer driving a local LogisX dev server. To re-capture (after a UI change, for example):

```bash
# 1. Build the SPA so Express can serve it from client/dist/
npm run build:client

# 2. Reset the local DB and seed multi-role users + trucks
node scripts/truncate-and-seed.js
node scripts/seed-staging.js

# 3. (One time after first seed) populate the trucks if seed-staging.js
#    fails partway (the seed expects the trucks table to exist, which
#    requires the server to have booted at least once to run migrations).
node scripts/docs/_seed-trucks.js

# 4. Start the server (leave running in another terminal)
npm start

# 5. Run the capture
npm run docs:screenshots
# or: node scripts/docs/capture-screenshots.js --filter driver
```

Seeded test credentials (from `scripts/seed-staging.js`):

| Username | Password | Role |
|---|---|---|
| `super_admin` | `Password123!` | Super Admin |
| `dispatch1` | `investor123` | Dispatcher |
| `lesline` | `investor123` | Driver |
| `kevin` | `investor123` | Investor (owns 2 trucks) |

The capture script logs in via `POST /api/auth/login`, forwards the session cookie to a new Puppeteer page, navigates to each route in `screenshot-manifest.js`, waits for animations to settle, and writes a PNG to `assets/screenshots/`.

The manifest is the single source of truth for what to capture. Add a new entry there to capture a new screen.

## Capturing against production data

If you want richer screenshots with real load counts and revenue figures, you can capture against a snapshot of production data without ever touching production or your local dev DB. The trick is `server.js` now reads `DATABASE_PATH` from the environment — you can boot a second server on a different port pointed at a snapshot file, capture against it, then throw the snapshot away.

```bash
# 1. Pull a read-only snapshot of production app.db
scp root@76.13.22.110:/var/www/logistics-app/app.db scripts/docs/app.db.production-snapshot

# 2. Make a working copy (so the snapshot stays pristine)
cp scripts/docs/app.db.production-snapshot scripts/docs/app.db.prod-capture

# 3. Reset passwords on the LOCAL copy only (production is untouched).
#    Write a small Node script using bcryptjs to UPDATE users SET password_hash = …
#    for one representative user per role you want to log in as.

# 4. Boot a second server on port 3001 against the snapshot.
#    Leave your normal dev server (if any) running on :3000.
PORT=3001 DATABASE_PATH="$(pwd)/scripts/docs/app.db.prod-capture" node server.js
#    (or in PowerShell: $env:PORT=3001; $env:DATABASE_PATH="…"; node server.js)

# 5. In a separate shell, run the capture against :3001 with the prod credentials.
#    The capture script honors CAPTURE_CREDS env var as a JSON override.
CAPTURE_CREDS='{"super_admin":{"username":"super_admin","password":"…"},"driver":{"username":"…","password":"…"},"investor":{"username":"…","password":"…"},"dispatcher":{"username":"super_admin","password":"…"}}' \
  node scripts/docs/capture-screenshots.js --base=http://localhost:3001

# 6. Stop the :3001 server, delete the snapshot files.
rm scripts/docs/app.db.production-snapshot scripts/docs/app.db.prod-capture
```

The local `app.db` you use for normal development is never touched. Production is never written to — `scp` only goes one direction (VPS → local). The reset-password helper only modifies `scripts/docs/app.db.prod-capture`.

`.gitignore` already excludes anything under `scripts/docs/app.db.*`, so accidental commit is not a risk.

Be aware: production screenshots contain real names and load data. Only share the resulting PDF internally unless you redact or recapture with demo data.

## Editing content

- **Technical doc chapters** live in `technical/`. Each `.md` becomes a chapter; chapters are concatenated in filename-sort order. To add a chapter, drop a new file with a numeric prefix.
- **User manual chapters** live in `user/`. Same rule.
- The **cover page** and **table of contents** are generated automatically by `scripts/docs/generate-docs.js`. The cover takes its title and subtitle from the `DOCS` object at the top of that file; the TOC is auto-built from h1/h2 headings in the markdown.

Common edits:

- **Update a chapter** — edit the `.md` file, run `npm run docs:build`.
- **Add a screenshot** — drop the PNG into `assets/screenshots/`, reference it from markdown as `![Alt text](screenshots/your-file.png)`, rebuild.
- **Restyle the PDF** — edit `assets/styles.css`. The CSS controls cover layout, page margins, header/footer, headings, tables, code blocks, callouts, and screenshot framing.

## Notes on the build pipeline

- **Font loading.** The HTML shell loads DM Sans and JetBrains Mono from Google Fonts. The Puppeteer wrapper waits for `document.fonts.ready` before rendering, so first-paint Arial fallback is not a risk.
- **Image inlining.** All `<img src="…">` references are rewritten to `data:` URIs at build time. The PDF therefore has no runtime asset dependencies — you can move it anywhere and every image still renders.
- **Missing images.** If a referenced screenshot doesn't exist, the entire `<img>` tag is stripped (with a warning logged). The PDF won't show broken-image icons.
- **Page breaks.** Each chapter (`<section class="chapter">`) gets `page-break-before: always` so chapters always start on a new page. h1 also gets the same rule for safety.
- **Headers and footers.** Powered by CSS `@page` rules in `assets/styles.css`. Page numbers are auto-counted; the header shows the document title.

## What's NOT in this directory

- The actual PDFs — committed to `docs/pdf/` so the deliverable lives alongside the source.
- The Puppeteer wrapper — lives at `lib/pdf-browser.js` (also used by invoices, onboarding documents, etc.).
- One-off helper scripts (`scripts/docs/_seed-trucks.js`, `_patch-indexes.js`) — leading underscores indicate "internal, ad-hoc, safe to delete after they've done their job."

## Heads-up for future maintainers

- Screenshots will drift from reality when the UI changes. Re-run `npm run docs:screenshots` after notable UI work. Spot-check the resulting PNGs before committing.
- The auto-built TOC is based on heading text alone — there are no cross-reference anchors yet. If you add a `[See Chapter 4 → "Foo"](…)` style link, you'll need to plumb anchor IDs through marked's tokens.
- `scripts/docs/_patch-indexes.js` was a one-shot to wrap unguarded `CREATE INDEX` statements in `server.js` so a fresh app.db could bootstrap. The wrappings are checked into `server.js`. If you make schema changes, follow the same try/catch pattern for any index that touches a table or column added later in the migration sequence.
