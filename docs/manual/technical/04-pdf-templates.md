# PDF Generation & Document Templates

LogisX generates a lot of PDFs: driver employment applications, weekly invoices, signed onboarding documents (driver and investor), investor reports, master agreements, vehicle leases, W-9 forms, and the documentation you are reading right now. Three libraries cover the field, each chosen for a different reason.

## Three libraries, three jobs

| Library | When to use it | Example |
|---|---|---|
| **pdfkit** | Programmatic PDFs built from scratch — write text, draw boxes, embed images. Best for one-off documents with a fixed structure. | Employment application PDF, image-to-PDF conversion for POD photos. |
| **pdf-lib** | Manipulating existing PDFs — merging multiple files, embedding signatures into a pre-built form, filling AcroForm fields. | Merging the application PDF with uploaded certificates; filling W-9 AcroForm fields. |
| **Puppeteer (via `lib/pdf-browser.js`)** | Rendering HTML/CSS to PDF. Best when the document needs designer-grade layout, fonts, and styling. | Onboarding policies, weekly service invoices, master agreement, vehicle lease, investor reports, this documentation. |

When in doubt, use Puppeteer. HTML is the most maintainable substrate — a designer can edit a template without touching code.

## The Puppeteer pipeline

`lib/pdf-browser.js` is the canonical entry point. Its API:

- **`getBrowser()`** — returns a singleton Chromium instance. If Chromium crashes (OOM, SIGKILL), the next call relaunches transparently. A mutex serializes concurrent launches so two requests don't race during a relaunch.
- **`renderHtmlToPdf(html)`** — takes a raw HTML string and returns a `Buffer`. Internally:
  1. Open a new page.
  2. `setContent(html, { waitUntil: "networkidle0", timeout: 30000 })`.
  3. `await page.evaluateHandle(() => document.fonts.ready)` — critical, without it the first render uses Arial fallback because Google Fonts haven't finished loading.
  4. `page.pdf({ format: "Letter", printBackground: true, margin: 0, preferCSSPageSize: true })` — margins are delegated to the template's `@page { margin: 1in }` so the template is the single source of truth.
  5. Wrap in `Buffer.from(pdf)` because Puppeteer ≥22 returns `Uint8Array`, which Express's `res.send()` mis-serializes to JSON without the wrap.
- **`shutdownBrowser()`** — called on process termination to close the singleton.

This module is the only place in the codebase that talks to Puppeteer. Every other PDF-via-HTML caller (invoices, onboarding documents, this documentation) goes through `renderHtmlToPdf()`.

## Policy templates

Onboarding documents — equipment policy, mobile policy, substance policy, contractor agreement, investor master agreement, vehicle lease — live as HTML templates in `onboarding-templates/policy/`. Each template is a plain HTML page with inline CSS, Google Fonts loaded by `<link>`, and form inputs using `aria-label` attributes as placeholders:

```html
<input aria-label="Full name" />
<input aria-label="Date" />
```

The corresponding field map in `lib/policy-field-maps.js` declares which `aria-label` matches which data field. The renderer in `lib/policy-renderer.js` walks the field map and uses Puppeteer's `page.evaluate()` to populate inputs by `aria-label` lookup at render time.

**Why `aria-label` and not `{{mustache}}`.** Two reasons. First, `aria-label` is real HTML — the template still renders as a fillable form in a browser, which is useful for proofing. Second, DOM-based population can do things a string-replace template can't: replace specific inputs with `<img>` tags for hand-drawn signatures, clone table rows for multi-vehicle Exhibit A documents, conditionally check checkboxes by ID or label.

**Multi-vehicle Exhibit A.** The Master Participation Agreement template has a single Exhibit A row. When an investor owns multiple trucks, the renderer clones that row N times before rendering. This is one of the things string-replace templating cannot do, and is the reason `policy-renderer.js` exists.

**Owner-operator weekly invoice.** Same pattern — the template has placeholder rows for loads and expenses; the renderer clones them based on the actual week's data.

## The policy field map

`policy-field-maps.js` exports a mapper per document type. Each mapper is a function that takes a data object and returns:

```
{
  text: { /* aria-label → text value */ },
  checkboxesById: { /* element id → boolean */ },
  checkboxesByLabel: { /* aria-label → boolean */ },
  signatureImage: '<base64 PNG>',
  signatureLabelForImage: 'Driver signature',
  vehicles: [ /* array, drives Exhibit A cloning */ ],
  loadsRows: [ /* for owner-op invoice */ ],
  expensesRows: [ /* for owner-op invoice */ ],
  dayCompletedByIndex: { /* day index → "completed" | "n-a" */ },
}
```

The renderer treats every key as optional. Add a new field to a template by adding an `<input aria-label="…">`, then adding the matching entry to the mapper.

## Where each template is used

| Template file | Endpoint | When it renders |
|---|---|---|
| `equipment-policy.html` | `GET /api/onboarding/documents/equipment_policy/pdf` | Driver onboarding (3 simple text fields). |
| `mobile-policy.html` | Same pattern | Driver onboarding (~5 fields). |
| `substance-policy.html` | Same pattern | Driver onboarding. |
| `contractor-agreement.html` | Same pattern | Driver onboarding (heaviest — ~25 fields + banking info + payment method checkboxes). |
| `service-invoice.html` | `POST /api/invoices/generate` | Weekly driver invoice (fixed-rate driver pay). |
| `service-invoice-owner-op.html` | Same endpoint, different `pay_type` | Weekly invoice for owner-operators (percentage of revenue, with cloneable loads/expenses tables). |
| `master-agreement.html` | `GET /api/public/investor-onboarding/:id/documents/master_agreement/pdf` | Investor onboarding (~25 fields, equipment checkboxes, multi-vehicle Exhibit A). |
| `vehicle-lease.html` | Same pattern | Investor onboarding (lessee/lessor split, 10-item inspection checklist). |

## W-9 — a different mechanism

The W-9 is the one onboarding document that does **not** use the HTML-template pipeline. It uses pdf-lib to fill AcroForm fields on a pre-built PDF (`docs/w9-test.pdf`-style template). The `fillW9Form()` helper in `server.js` looks up each AcroForm field by name and sets its value. The result is then merged into the investor's signed-document bundle alongside the HTML-rendered docs.

Why not use HTML? The W-9 is a federally-defined form with exact layout requirements. Reproducing it in HTML would be more work and harder to audit; the IRS already publishes a fillable PDF.

## Imageto-PDF conversion

POD photos uploaded by drivers are not stored as raw images on Drive — they are wrapped in a single-page PDF via `imageToPdf()`. This keeps the document set homogenous (everything in the Drive folder is a PDF) and lets us add a header/footer with metadata if we want to.

## How this documentation is generated

The PDF you are reading is built by `scripts/docs/generate-docs.js`, which:

1. Reads markdown files from `docs/manual/{technical|user}/` in sort order.
2. Concatenates them and runs `marked.lexer()` to extract headings for the auto-generated table of contents.
3. Renders each markdown file with `marked.parse()`, wraps each in a `<section class="chapter">` element (CSS `page-break-before: always`), and stitches them together.
4. Wraps in an HTML shell that loads Google Fonts and the shared `docs/manual/assets/styles.css`.
5. Rewrites all `<img>` `src` attributes to inline `data:` URIs so Puppeteer doesn't need network access to resolve screenshots.
6. Calls `renderHtmlToPdf()` from `lib/pdf-browser.js` — the same path every other production PDF goes through.

Total dependencies for the documentation pipeline: `marked` (devDependency). Everything else — Puppeteer, the singleton browser, the font-loading dance — is already there.

## Adding a new policy document

The full workflow:

1. **Create the HTML template.** Drop `onboarding-templates/policy/my-doc.html` with `aria-label` inputs where data should go. Use inline CSS and load Google Fonts via `<link>` for visual parity with the existing documents.
2. **Add a field map.** In `policy-field-maps.js`, add `myDoc(data) { return { text: {...}, checkboxesById: {...} } }`.
3. **Wire up the endpoint.** In `server.js`, add a route that calls `renderPolicy('my_doc', data)` from `policy-renderer.js`.
4. **Test.** Hit the endpoint, open the resulting PDF, verify every field landed in the right spot.

No new dependencies, no new abstractions. The pattern scales linearly with the number of document types.
