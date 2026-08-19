<!-- Extracted verbatim from CLAUDE.md on 2026-08-18 to keep that file inside the context budget.
     CLAUDE.md now carries a short summary and points here. Nothing was reworded or dropped. -->

# Environment refresh (local + staging)
`./scripts/refresh-local.sh` and, on the VPS from `/var/www/logisx-staging`,
`./scripts/refresh-staging.sh --yes [--restart]`. Both bring the checkout to `origin/main`,
rebuild the client, and hand the database half to `scripts/refresh-env.js`. Full runbook,
including the drift audit that motivated it, in **`scripts/README-env-refresh.md`**.

- **The source is the nightly snapshot** (`/var/www/logistics-app/backups/app.db.*.gz`), never
  the live production `app.db` — that file already has a consistent Online-Backup-API copy that
  passed `integrity_check`, so re-snapshotting the live file adds risk for nothing.
- **The spreadsheet gate is the load-bearing safety.** `refresh-env.js` reads the `.env` beside
  its `--to` target and **refuses** when `SPREADSHEET_ID` is missing or is production's — because
  `server.js` falls through to the production sheet when it is unset, so a refreshed DB next to
  such an `.env` is a production writer on first boot. It checks the resolved **ID**, never the
  directory name, for the same reason the staging sheet is *titled* "logisx-production" and is
  not production. It also refuses an `.env` that can send mail (`GMAIL_USER` +
  `GMAIL_APP_PASSWORD`, override `--allow-mail`) or that has `INVOICE_AUTOGEN_ENABLED=true`.
- **⚠️ Telemetry is trimmed to 45 days by default, and that is not a neutral shrink.**
  `routemate_telemetry` is 99.7% of all rows (933,893 of ~936,000). Trimming does *not* zero old
  driver pay — `getEldTravelDaysByVehicle()` is coverage-aware, so a window with **no** pings
  falls back to the **full scheduled window**. Months older than the cutoff therefore pay *more*
  than production and their investor payouts come out *lower*. Bounded in practice (15 months are
  already locked and frozen), but **never reconcile a historical month on a trimmed copy** — pass
  `--telemetry-all`.
- **Sanitization is asserted, not assumed**: sessions cleared, every password re-hashed to the
  harness default (`Password123!`, so `test-suite.js` runs with no extra step), emails rewritten
  to RFC-2606 `.invalid` (can never resolve), bank/tax/identity fields, signatures and **signing
  evidence** (`signed_ip`, `signed_ip_source`, `signed_user_agent`, `consent_text`) redacted,
  investor onboarding `access_token`s regenerated, `driver_locations` emptied. The run fails if a
  routable address, a session, or a bank account number survives.
- **⚠️ That last sentence was ASPIRATIONAL until 2026-08-13 — every step above is column-aware.**
  An address typed into a notes field, embedded in a JSON blob, or recorded in an audit line
  walked straight through, and the run went on to print `clean: no routable address … survives`
  **four lines below the WARNING lines naming it**. Measured on the production-shaped local DB:
  **21 routable third-party addresses survived a run that reported success** —
  `job_applications.reference_info` (6 of 8 rows: applicants' *references and previous employers*,
  third parties who never consented to anything; ⚠️ the address sits under the key `relationship`,
  not `email`), `audit_trail.details` (8 of 1455), `load_invoice_drafts.recipient` (7 of 7).
  Stage **`3h`** now sweeps **every text column of every table** — deliberately *not* a list of
  those three, which would fix the columns populated the day someone looked and leave the
  mechanism intact — substituting each routable address **in place** with `<10 hex>@invalid`
  (HMAC, per-**run** salt: one address → one token within a database so the invoice-draft row and
  its audit row still agree, unlinkable between refreshes) and each `###-##-####` with
  `000-00-0000`. Never blanking and never a JSON round-trip: `audit_trail.details` is parsed
  structurally and `reference_info` is JSON the applications screen renders. The hex-only token
  and the bounded email regex are both load-bearing — a `[`, a quote, whitespace, or a loose
  `\S+@\S+\.\S+` would forge or destroy the `[PERIOD_…]` marker the purge exemption and
  `parsePeriodRefusalDetail` depend on. A free-text hit is now a **hard leak, not an advisory**,
  so a survivor means the scrubber failed rather than "we found content we never promised to
  clean"; `--strict-scan` is consequently a no-op for the two kinds scanned. **Phones are
  deliberately excluded** — nothing has ever scanned for them, and a useful phone pattern also
  matches 9-digit load ids. Full runbook in `scripts/README-env-refresh.md`.
- **⚠️ Stage 3h neutralizes exactly TWO SHAPES — a routable email and `###-##-####` — and reading
  "every text column of every table" as "free-text PII is handled" is itself a trap.** A security
  pass over the finished stage found three things it is *structurally* blind to, each still
  shipping under a `clean:` line: **base64 documents** — `job_applications.cdl_front` /
  `cdl_back` / `medical_card`, photographs of the driving licence and DOT medical card carrying
  the licence number, DOB, home address, face and signature, **8 of 8 rows, ~30 MB** (base64 holds
  no `@` and no `###-##-####`, so neither the SQL prefilter nor the scan ever looks at them — this
  is the same *"masking the NUMBER while shipping the DOCUMENT is not masking"* finding fixed for
  the API on 2026-08-08, which the sanitizer never inherited); **home locality** — `city`/`state`/
  `zip` on `job_applications` and `drivers_directory`, sitting beside an `address` already set to
  `REDACTED`, which makes the row *look* scrubbed while full name + city + ZIP re-identifies the
  person; and **the seven phone columns** stage 3d has always written, which had no assertion at
  all because the same loop's email half was covered by `REDIRECTED_EMAIL`. All are now redacted
  and asserted. **The rule: if a column can hold personal data in any shape that is not an email
  or an SSN, it needs an explicit list entry — assume stage 3h will not save you.**
- **Not copied:** `uploads/` (receipts/PODs/rate-cons are on disk — they 404 in a refreshed
  environment, and the tree is unredacted PII) and the Google Sheets themselves.

