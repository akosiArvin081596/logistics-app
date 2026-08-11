# `uploads/rate-cons/` ownership — recommendation

**Status:** recommendation only. No code changed. Written 2026-08-11 against `main` @ `c6919cf`.
**Decision needed from:** the owner. Workstream D3 of the current plan explicitly gates
implementation on a product decision, and this document is that decision's input.

**Recommendation in one line: do not build an ownership model. Keep the role gate, fix the two
model-free defects named in §6, and revisit only if Dispatcher scope narrows generally — at which
point the rate-con *file* is not the first thing to fix.**

---

## 1. The finding, restated precisely

Rate-con PDFs are stored at `uploads/rate-cons/${loadId}.pdf` — fully enumerable — and are held by a
role check hardcoded above the guard loop (`server.js:5671-5675`):

```js
if (probe.startsWith("/rate-cons/")) {
	const role = req.session.user.role;
	if (role !== "Super Admin" && role !== "Dispatcher") return res.status(403).json({ error: "Forbidden" });
	return next();
}
```

Any Dispatcher can therefore read any load's broker rate confirmation, and because the filename is
the load id, they can enumerate rather than guess. The three directories that *do* carry an
ownership rule — `GUARDED_UPLOAD_DIRS` at `server.js:5642-5646` — each resolve authority from a
**database row**, never from the filename.

**The blocker is not the guard. It is that there is nothing to look up.** Dispatch in this app is
fleet-wide by design: `GET /api/dashboard` returns every unassigned, active and completed load to
every Dispatcher, and no table or sheet column records which Dispatcher owns which load. "Ownership"
has to be invented before it can be enforced.

---

## 2. Measured facts (production, read-only, 2026-08-11)

All figures below were taken with `better-sqlite3` opened `{ readonly: true }` against
`/var/www/logistics-app/app.db`. Nothing was written.

| Measurement | Value |
|---|---|
| Files in `uploads/rate-cons/` | **6** (all `.pdf`, all mode 0644) |
| `documents` rows with `type='RATECON'` | **6** |
| Files resolving to a row by `load_id` | **6 / 6** |
| Files resolving to a row by `file_name` | **6 / 6** |
| Rows soft-deleted (`deleted_at`) | **0** |
| Rows carrying a `drive_file_id` | **0** (all local-only, as designed) |
| Dispatcher accounts | **2** (`amir_serrano`, `danna_gonzalez`) |
| Rows in `load_status_history` | **302** |
| …of which carry a Dispatcher as `actor` | **0** |
| Rows in `sheet_job_tracking` (local sheet mirror) | **0** — vestigial |
| Indexes on `documents` | **1**, `idx_documents_load_live(load_id, deleted_at)` — *not* unique |

The six files, with their `documents` row's `uploaded_at`:

| File | mtime | row `uploaded_at` |
|---|---|---|
| `2651585.pdf` | 2026-07-25 09:18:45 | 2026-07-25 09:18:45 |
| `2370952.pdf` | 2026-07-29 20:13:43 | 2026-07-29 20:13:43 |
| `2216467.pdf` | 2026-07-31 19:32:46 | 2026-07-31 19:32:46 |
| `561151778.pdf` | 2026-08-05 18:16:50 | 2026-08-05 18:16:50 |
| `562787563.pdf` | 2026-08-06 01:59:53 | 2026-08-06 01:59:53 |
| `563593554.pdf` | 2026-08-07 15:59:29 | 2026-08-07 15:59:29 |

---

## 3. ⚠️ The plan's stated failure mode is real in principle and **empty in fact** — measured at zero

The plan predicted that a DB-lookup guard would *"fail closed on every rate-con archived before the
`documents` row existed, silently 404ing files that work today"*. That is the correct thing to
worry about — it is exactly what happened to the 54 orphaned signed PDFs. **For this directory it
does not apply: 6 of 6 files resolve, so a DB-lookup guard would 404 nothing today.**

The reason is structural, not luck. `uploads/rate-cons/` has exactly **one writer** —
`POST /api/loads/from-ratecon` (`server.js:28126-28137`) — and it writes the file and the
`documents` row inside the same `try` block, `DELETE`ing any prior `RATECON` row for that load
first so at most one row exists per load. n8n never writes here at all; the email path uploads to
Drive under OAuth delegation, which is `getRateConBytes()` source (a). So there was never a
pre-`documents`-row era for this directory: the oldest file dates from the day the drag-and-drop
path shipped, and every file's mtime equals its row's `uploaded_at` **to the second**.

**This removes the plan's stated blocker. It does not change the recommendation** — the reason not
to build the guard is §4, not the orphans.

Two caveats worth carrying forward:

- `audit_trail` holds **7** `create_load_ratecon` actions against 6 files. Consistent with one
  re-create (the `DELETE`-then-`INSERT` replaces both) or one create where no PDF was attached —
  `from-ratecon` warns rather than fails in that case. Not an orphan either way.
- The zero is a property of *today's* single writer. Any future backfill — e.g. mirroring the
  Drive-hosted email-ingested rate cons into `uploads/` so both paths share one archive — would
  create files with no `documents` row and resurrect the failure mode immediately. If that backfill
  is ever written, it must write the row in the same transaction as the file.

---

## 4. The two models

### Model A — an assigned-dispatcher column on the load

**Where it would live.** There is no candidate column. Job Tracking has 26 columns and none names a
dispatcher (the canonical order survives in the vestigial `sheet_job_tracking` mirror:
`contract_id, load_id, details, trailer_number, driver, pickup_info, pickup_appointment,
pickup_address, dropoff_info, dropoff_appointment, dropoff_address, job_status, phase_of_progress,
carrier_stage, _payment_, broker_contact_name, phone_number, email, location_link, documents,
assigned_date, status_update_date, completion_date, truck, owner_id`). So it is either a new sheet
column or, better, a new SQLite table keyed on `load_id` — the `deleted_loads` /
`load_coordinates` pattern, which keeps an authorization input out of a Google Sheet.

**What it costs.**

- **The unattended path structurally cannot populate it.** `from-ratecon` is attended, so the
  session user *is* the dispatcher and the write is free. The n8n email path has no session and no
  human — nobody has claimed the load. Every email-ingested load would carry a null dispatcher and
  fail closed. That is the majority path: 151 of 163 Job Details rows came from n8n.
- **There is nothing to backfill from.** Across **302** `load_status_history` rows the `actor`
  vocabulary is `Howard Reddie` (108), `Shorn King` (100), `super_admin` (77), `Rodney Brown` (15),
  `Lesline Johnson` (1), `""` (1). **Neither Dispatcher account appears once.** Dispatch actions
  are recorded under the shared `super_admin` login, which by design cannot identify a person. So
  the column would start empty for all ~413 existing loads and could only be populated going
  forward.
- **It is a business process, not a column.** Someone has to claim loads, and someone has to cover
  the claim at 2am. With **2** dispatchers on a fleet-wide desk, the model must ship with a claiming
  UI, a reassignment path, and a break-glass — and the security it buys is bounded by partitioning
  6 files between 2 people.

**What breaks.** Nothing existing reads a dispatcher-per-load, so nothing regresses. The cost is
entirely new surface plus the operational cost in §5.

### Model B — `owner_id` via the truck

**Where it would live.** It already exists: `trucks.owner_id` is populated (`5, 0, 41, 42, 5, 0`
across the six trucks) and `getInvestorDriverSet()` (`server.js:1287`) already fans it out to a
driver set. The chain would be rate-con file → `documents.load_id` → Job Tracking row → `Driver`
column → `truck_assignments` / `trucks.assigned_driver` → `trucks.owner_id`.

**Why it cannot work here — four independent reasons, any one of which is fatal.**

1. **It answers the wrong question.** `owner_id` names an **Investor**, not a Dispatcher. D3 asks
   *"which Dispatcher may read this rate con"*, and there is no dispatcher→investor mapping to
   derive. Applying it to Investors instead would be a *widening* — Investors currently get 403 and
   would begin receiving a document that states the broker rate.
2. **The link does not exist when the file is written.** `from-ratecon` deliberately leaves the
   `Driver` cell blank on creation (`lib/ratecon-load.js:272` — *"blank on creation (assigned later
   from the dashboard)"*), because writing it would create a silently-assigned load. So at archive
   time, and for the whole pre-dispatch window, the load→truck→owner chain is null — and the
   pre-dispatch window is precisely when dispatch needs to open the rate con.
3. **It puts a live Google Sheets read inside an authorization decision.** `sheet_job_tracking`
   holds **0 rows**, so there is no local mirror; the `Driver` cell can only come from
   `getJobTrackingCached()`. This codebase has already made and recorded this exact call and
   rejected it — for `GET /api/invoices/:id/pdf`, `getInvestorDriverSet()` scoping was considered
   and refused because *"it needs live Carrier Database sheet rows to be complete, so an
   authorization decision resting on it fails open for the truck-linked subset and closed for the
   rest depending on whether a sheet read succeeded."* The same mechanism, for the same kind of
   decision, deserves the same answer.
4. **`owner_id = 0` on 2 of 6 trucks.** A guard keying on it fails closed for a third of the fleet,
   including `LogisX-#2372`, the truck of one of the two currently most active drivers.

### Comparison

| | Model A (assigned dispatcher) | Model B (`owner_id` via truck) |
|---|---|---|
| Answers "which Dispatcher?" | Yes | **No** — names an Investor |
| Data exists today | No column, no history | Column yes; the load→truck link no |
| Populated on the n8n path | **No** | Only after dispatch |
| Populated at archive time | Yes (attended path) | **No** — `Driver` is blank by design |
| Needs a live sheet read | No | **Yes** (`sheet_job_tracking` is empty) |
| Precedent in this codebase | none | **explicitly rejected** for the invoice guard |
| New process required | claiming + break-glass | none |

---

## 5. Super Admin, and what a Dispatcher actually loses

**Super Admin should stay unconditional.** All three existing guards do exactly this
(`guardDriverSignedDoc`, `guardInvestorSignedDoc`, `guardInvoicePdf` all `return next()` for Super
Admin before any ownership test). It is the break-glass role, it is the only role that can
reconstruct an invoice from source documents, and — being a **shared** login — scoping it would buy
nothing while breaking recovery.

**What a Dispatcher loses under either model** is the ability to open the rate con for a load they
did not book. That is not a marginal loss on a 2-person fleet-wide desk. The rate con is the source
document for a broker check-call, an appointment-window dispute, a detention claim, a reference
number, and a re-drafted invoice — and there is no "my loads" concept anywhere in the UI to fall
back on, because `/api/dashboard` hands every Dispatcher the entire fleet. Handoffs, nights and
weekends all mean the dispatcher answering the phone is routinely not the one who booked it.

---

## 6. ⚠️ The exposure delta is much smaller than it looks — and mostly already published

Before spending a product decision on this, price the leak honestly.

- **The broker rate is already visible to Dispatchers.** `/api/dashboard` strips financial columns
  for `role === "Driver"` **only** (`server.js:24276`). A Dispatcher sees the `Payment` cell on
  every load in the fleet, all day, in the primary UI. Guarding the file does not remove it.
- **The genuine delta is the broker contact block and the commercial terms** — the counterparty's
  desk name, phone, email, the signature block, accessorial and detention rates. `/api/dashboard`
  does call `sanitizeBrokerColumns()` for every non-Super-Admin (`server.js:23414-23422`), so this
  *is* material the app deliberately withholds from Dispatchers and the rate con hands back in
  full. That is the real inconsistency, and it is worth recording.

**So the correct framing is: the rate-con file leaks broker contact detail, not the rate.** If the
owner's concern is the rate, the file is the wrong target and the dashboard is the right one. If
the concern is broker contact, see the model-free options below — none needs an ownership model.

> ### ⚠️ Adjacent, unverified, and worth one line of someone's time
> `sanitizeBrokerColumns()` (`server.js:23515`) picks `brokerCol = headers.find(/broker/i)` and
> `phoneCol = headers.find(/phone|contact/i)`. On the column order above, **`Broker Contact Name`
> matches both**, so `phoneCol` resolves to `Broker Contact Name` rather than `Phone Number`, and
> the blanking branch (`cleaned[phoneCol] = ""`) would never touch the phone column — while `email`
> is not covered by either regex at all. Additionally `sanitizeBrokerContact()` returns the value
> **unchanged** unless it is JSON-shaped (`startsWith("{")`), and `Broker Contact Name` holds a
> plain string. If both hold, broker phone and email are already served to Dispatchers and the
> delta in this section shrinks further.
> **This is inferred from `sheet_job_tracking`'s column order, not from a live sheet read, and it
> is in `server.js`, which this workstream must not touch.** It needs one header dump to confirm or
> dismiss. Flagged, not fixed.

---

## 7. Recommendation

**Do not build an ownership model for `uploads/rate-cons/`.** Neither model can be populated on the
path that creates most loads; Model B additionally answers the wrong question and depends on a live
sheet read this codebase has already rejected for exactly this purpose; and the exposure it would
close is mostly already published through the dashboard.

**Keep the role gate as-is, and take these three instead — all model-free:**

1. **Make the gate soft-delete aware.** Today a Dispatcher is admitted to a rate con whose
   `documents` row has been soft-deleted, because the file stays on disk and the role check never
   consults the database. Refusing a deleted document needs no ownership concept at all and mirrors
   `guardInvoicePdf`'s handling of soft-deleted invoices. Cheapest real tightening available.
   *(0 rows are soft-deleted today, so this ships behaviour-neutral.)*
2. **Decide the broker-contact question at the source, not the file** — resolve the §6 warning
   first. If broker phone/email are already reaching Dispatchers through `/api/dashboard`, then the
   rate-con file is not where that leak lives, and fixing the file alone would be theatre.
3. **Write the guard's shape down now, so the day it is needed nobody re-derives it.** See §8.

**Revisit if, and only if, Dispatcher scope narrows generally.** If the owner decides a Dispatcher
should see only their own loads, that is a change to `/api/dashboard` first — and once loads carry
an owner for the dashboard's sake, the rate-con guard becomes a three-line reuse of it rather than a
feature in its own right. Build it in that order; the file is downstream of the model, never the
reason for it.

---

## 8. If it is built anyway — the shape, and two traps

Recorded so the design is not re-derived under time pressure.

**Key on `documents.drive_url`, which already stores the exact served path.** `from-ratecon` writes
`` `/uploads/rate-cons/${fileNameOut}` `` into that column (`server.js:28137`), so the guard is a
direct mirror of how `guardDriverSignedDoc` resolves `signed_pdf_url` — and it needs no derivation
at all.

**⚠️ Trap 1 — never reconstruct a `load_id` from the filename stem.** `from-ratecon` sanitizes the
stem with `String(loadId).replace(/[^A-Za-z0-9._-]/g, "_")` while storing the **raw** `loadId` in
`documents.load_id`. Job Tracking carries both `513987502` and `#513987502` (93 of 412 rows on the
local copy carry the `#`), so a `#`-prefixed load id yields `file_name = "_562787563.pdf"` against
`load_id = "#562787563"` — and a stem-derived lookup misses, i.e. fails closed on a real document.
All six production files happen to be bare digits, which is exactly why this would pass review and
break later.

**⚠️ Trap 2 — membership test, never fetch-one-then-compare.** `documents` carries exactly one
index, `idx_documents_load_live(load_id, deleted_at)`, and it is **not unique**; there is no index
on `file_name` or `drive_url` at all. `.get()` would return an arbitrary row among any duplicates
and could refuse the real owner while admitting a stranger. Use `.all()` + `.some()`, the same shape
`guardInvoicePdf` adopted after `invoices.pdf_file_name` turned out to have no unique index either.
The table is ~120 rows; the scan is free.

**Keep the 403.** Unlike a person's W-9, a rate con's existence is already implied by the load id,
so there is nothing to conceal by returning 404 — and `server.js:5668-5670` records that reasoning
deliberately.

---

## 9. Sources

- `server.js:5606-5646` — `GUARDED_UPLOAD_DIRS` and the comment naming rate-cons as role-gated.
- `server.js:5648-5696` — the unified `/uploads` guard, the case-insensitive probe, the rate-cons branch.
- `server.js:28112-28160` — `POST /api/loads/from-ratecon`, the directory's only writer.
- `server.js:28236-28262` — why RATECON rows are hidden from the driver document list (the rate).
- `server.js:23414-23422`, `23503-23530` — `sanitizeBrokerColumns()` / `sanitizeBrokerContact()`.
- `server.js:24273-24294` — dashboard financial stripping, Driver-only.
- `server.js:1287-1322` — `getInvestorDriverSet()`.
- `server.js:23595-23615` — `loadBelongsToDriver()`, the sheet-read shape Model B would need.
- `lib/ratecon-load.js:272` — `Driver` blank on creation.
- `CLAUDE.md` — the invoice-guard precedent rejecting `getInvestorDriverSet()` scoping.
- Production `app.db`, read-only, 2026-08-11 — every figure in §2.
