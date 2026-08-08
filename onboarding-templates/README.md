# onboarding-templates/

Source documents for driver and investor onboarding. **Tracked in git.** Read this
before moving anything in here.

| Directory | Contents | Read by |
|---|---|---|
| `policy/` | HTML templates rendered to PDF (equipment, mobile, substance, contractor agreement, master agreement, vehicle lease, service invoices) | `lib/policy-renderer.js` → `TEMPLATE_DIR` |
| `pdf/` | Original / fillable PDFs. `fw9.pdf` is the live IRS form whose AcroForm fields `fillW9Form()` fills; the other five are the signed-original source documents the `policy/` HTML was authored from. | `server.js` → `fillW9Form()` (`fw9.pdf` only) |

## Why `pdf/` is here and not in `uploads/`

These six PDFs used to live at `uploads/onboarding-templates/`. That was a
**structural hazard: tracked files inside a gitignored tree.**

`.gitignore` excludes `uploads/` wholesale, and correctly so — it holds ~60
runtime files with driver and investor PII (PODs, signed onboarding documents,
receipt photos). That rule is not going to be relaxed.

But git only applies ignore rules to *untracked* files, so these six were tracked
*through* the exclusion. The consequences:

- **They get deleted by ordinary cleanup.** Twice in one day an agent tidying
  scratch files ran `rm -rf uploads` — entirely reasonable, since `uploads/` is
  gitignored and everything else in it is runtime data — and took all six legal
  templates with it. Both times it was caught in `git status`. A third time might
  not be.
- **The tooling actively hides the trap.** `git check-ignore -v
  uploads/onboarding-templates/fw9.pdf` reports *not ignored*, because the file is
  tracked. Only `--no-index` reveals `.gitignore:30:uploads/` — so the usual way of
  asking "is this safe here?" answers "yes" for a file that is not.
- **Restoring one is not obvious either.** Re-adding a deleted file at that path
  needs `git add -f`; a plain `git add` silently does nothing.

## The rule

**Tracked files must not live inside an ignored tree.** If you need a new tracked
document asset, put it here (or anywhere outside `uploads/`) — never next to the
runtime uploads just because the other document assets are there. Confirm with:

```sh
git check-ignore -v --no-index <new-path>   # exit 1 / no output = safe
```

## If you move these anyway

`fw9.pdf` is the only one read at runtime, from `fillW9Form()` in `server.js`. A
missing template makes that function return `null` — and both call sites (driver
`/api/onboarding/sign`, investor `/api/public/investor-onboarding/:id/sign`) still
mark the document **signed** with an empty `signed_pdf_url`. So the failure mode is
not an error page: it is a person recorded as having signed a W-9 that does not
exist. Update the path and generate a document end-to-end before shipping.
