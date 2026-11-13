#!/usr/bin/env node
// scripts/data-fix-october-driver-rate.js — a one-time data fix for one daily-rate
// driver whose own rate was raised during an open month. While the dated-rate
// rules are off, the payout code prices every day of a month at the driver's
// current own rate (resolveDailyRate()), so the raise re-priced days his weekly
// invoices had already paid at the earlier rate. The owner decides when the new
// rate started; this script applies the answer a private plan carries, --path
// naming which:
//   forward-only  the days before the raise keep the earlier rate. The payout code
//                 still prices them at the new one, so the investor's share of the
//                 difference goes on the investor's payout row for the month as an
//                 adjustment, beside the adjustment already there. No rate, rate
//                 row or anything else the payout code reads is changed, so no
//                 month's recompute moves.
//   october-300   the raise covers the month. The payout code already prices the
//                 days at it, so the investor's month stays as it is; the driver is
//                 paid the difference on the days his approved or paid invoices paid
//                 at the earlier rate, as an adjustment on his next open weekly
//                 invoice (a mistake found after approval goes on the next invoice;
//                 the correction-line route is switched off, so the adjustment is
//                 the way the code carries it today).
// A forward-only plan may also take the raise off days the driver's own open
// invoice priced at it, as an adjustment on that invoice. No day is added or
// removed by the rate: every day the plan lists stays a paid day.
// Either plan may first move Job Tracking rows to the investor ("rows": a load of
// his booked elsewhere that the owner says was his truck's haul): each row's
// Owner ID and Truck cells, as the Data Manager's save writes them. The payout
// code's checks then read the tab as the run will leave it.
//
// The driver, the days, the rows, the figures and the notes are not in this file
// (the repository is public). They come from a private plan, --plan=<json>, and
// each one is checked against the database and the sheet before anything is
// written:
//   - the month is open; the investor's payout row for it is owed, not finalized,
//     and carries the plan's "before" adjustment and note (or its "after" ones:
//     already done);
//   - the driver is one Drivers Database row, fixed pay, at the plan's own rate;
//   - each planned row is the one row of its load, his, at the plan's row number,
//     its two cells at the plan's "before" (or all at "after": already done), the
//     truck the investor's, and its save passes PUT /api/data/:rowIndex's own
//     checks, the closed-month guard included;
//   - the payout code (lifted from server.js, as the payout dry runs run it) counts
//     exactly the plan's days for him in the investor's month, each once, at the
//     plan's "ledger" figure (a day the plan gives no ledger figure, not at all);
//     replayed with the days at their "set" figures, it moves the month by the
//     plan's change to the adjustment; the payout it reads plus the "after"
//     adjustment is the plan's expected figure;
//   - each day the plan says an invoice pays is paid by that live invoice alone, at
//     the plan's "paid" figure, as its stored day grid or lines say, and that
//     invoice carries no correction line and no adjustment but one the plan names
//     exactly (knownAdjustments: read by a person, not a change to a day's pay);
//     every other day is paid by no live invoice of his;
//   - the invoice that carries a driver-side difference is a Submitted weekly
//     invoice of his, in open months, with its own PDF and render data, no Personal
//     or correction line, the app's own pick (his oldest open weekly invoice after
//     the corrected weeks: personalOpenInvoicesFrom()), or the one open invoice
//     whose own days move, and carries the plan's "before" adjustment and note;
//   - with a carrying invoice, the same difference is not already posted: every
//     other live invoice of his from the first planned day on that carries an
//     adjustment, a correction total, or manual lines off the planned days is one
//     the plan acknowledges by the fingerprint the dry run prints (a person read
//     it and it is not this difference), and no correction line of his waits.
// Any one failing, nothing is written (exit 2).
//
// What it writes, through the routes' own code, lifted at run time from this
// checkout's server.js, as a system change (user 0, this script's name, role
// "system"), in this order:
//   1. each planned row's cells, as PUT /api/data/:rowIndex writes a Super Admin's
//      save: the row read, the Load ID binding, the route's checks, the re-read
//      just before the write, only the changed cells (USER_ENTERED), and the
//      route's audit row (the route's off-duty check and date recorder read only
//      the Driver and date columns, which a planned row never moves);
//   2. the carrying invoice's adjustment, as PUT /api/invoices/:id/adjust writes
//      one: the row's adjustment, note, by and at; its PDF re-rendered from its
//      stored snapshot (the route's own render; a failed render puts the row back);
//      the route's audit row;
//   3. the investor's adjustment, as PUT /api/investor/payouts/:id/adjust writes
//      one: the row's adjustment, note, by and at; its history row; its audit row.
// Nothing else: the payout row's amount is the app's to recompute (its next
// Payouts read, and again at the month's close), and no closed month's row is
// touched (the read back checks the investor's closed-month rows are as they were).
//
// Then it reads back each planned row, both adjustment rows, the routes' audit
// rows (one per write) and the payout row's history row, and the investor's month
// as the payout code recomputes it, plus the stored adjustment, against the plan's
// expected figure.
//
// Idempotent: a row already carrying the plan's "after" values is done, so a re-run
// finishes a run that stopped part way and a replay writes nothing. A route that
// refuses or fails stops the run with each write's state in the result file.
//
// The Sheets key is the app's own (server.js's KEY_FILE, read relative to the
// folder the run starts in, as the server's is), so a run that reads the sheet must
// start in this app's folder and takes no key option. The sheet is read with the
// read-only scope unless the plan moves rows and the run applies it.
//
// Usage (on the server, from the app's folder, with the Node pm2 runs it with):
//   node scripts/data-fix-october-driver-rate.js --path=<forward-only|october-300> --db=<app.db> --sheet-id=<id> --plan=<plan.json> --result=<result.json> [--dry-run]
//   node scripts/data-fix-october-driver-rate.js --path=<…> --db=<app.db> --sheet-id=<id> --plan=<plan.json> --result=<result.json> --apply
//   --path           the answer the plan applies; it must be the plan's own
//   --db             the app's database: this app folder's own, or a copy under the
//                    temp directory (scripts/lib/ledger-world.js dbScope()); no default
//   --sheet-id       the Job Tracking book; with the app's own database it must be
//                    the app's own sheet; no default
//   --values-json    with a copy only, in place of --sheet-id, and not to apply a
//                    plan with rows: a saved values.get of Job Tracking
//   --settings-file  with a copy only, required there: the settings to run with
//                    (the app's own database runs with the app's own)
//   --data-dir       with a copy only: the folder whose uploads/invoices/ holds the
//                    copy's PDFs (default: the copy's folder)
//   --plan           the private plan (JSON), outside the repository
//   --result         where the result goes (JSON, owner-only), outside the repository
//   --dry-run        the default: the database opened read-only, the sheet read with
//                    the read-only scope, nothing rendered, nothing written
// The plan (made-up figures; amounts are strings of dollars and cents; adjustments
// on the payout row are whole dollars, as that route keeps them):
//   { "kind": "october-driver-rate", "path": "forward-only", "period": "YYYY-MM",
//     "ownerId": 7, "splitPct": 40, "driver": "d-<8 hex of sha256 of the normalized name>",
//     "ownRate": "280.00",
//     "days": [ { "day": "YYYY-MM-DD", "ledger": "280.00", "set": "240.00",
//                 "invoice": <invoices.id, when one pays it>, "paid": "240.00" }, … ],
//       ("ledger": null for a day of his the investor's month does not count, which
//       only his invoice pays: it moves his pay alone)
//     "payout": { "id": <investor_payouts.id>, "before": { "adjustment": 0, "note": "" },
//                 "after": { "adjustment": 16, "note": "…" } },
//     "carrier": null, or { "id": <invoices.id>, "before": { "adjustment": "0.00", "note": "" },
//                 "after": { "adjustment": "40.00", "note": "…" } },
//     "acknowledged": [ { "invoice": <invoices.id>, "fingerprint": "<16 hex>" } ] (required with a carrier; may be empty),
//     "knownAdjustments": [ { "invoice": <invoices.id>, "adjustment": "-12.40", "note": "…" } ] (optional),
//     "rows": [ { "load": "<load id>", "row": <sheet row>, "cells": { "Owner ID": { "before": "0", "after": "7" },
//                 "Truck": { "before": "", "after": "<the investor's unit>" } } } ] (optional),
//     "expectedEffective": <the payout code's payout plus the after adjustment, whole dollars> }
// Exit codes: 0 done (or already done) and read back as planned, or a clean dry
// run; 1 an error, or a write that failed or did not read back (each write's
// state is in the result file; a re-run carries on); 2 refused, nothing written;
// 3 done, but the payout reads back other than the plan's expected figure (the
// gap is printed).
// Required as a module (by its test runner) it runs nothing and exports its parts.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");
const { buildLedgerWorld, dbScope, envFor, openDb } = require("./lib/ledger-world");
const { normalizeLoadId } = require("../lib/ratecon-load");
// The lift check (a name the lifted code uses that the lift left out) and the
// app's-own-sheet rule are the October DVIR fix's, shared rather than copied.
const { unresolvedNames, ownSheetId } = require("./data-fix-october-dvir-correction");

const ROOT = path.join(__dirname, "..");
const SCRIPT_NAME = "data-fix-october-driver-rate";
const ACTOR = `script:${SCRIPT_NAME}`;
const SYSTEM_USER = Object.freeze({ id: 0, username: ACTOR, role: "system" });
const TAB = "Job Tracking";
const PLAN_KIND = "october-driver-rate";
const PATHS = Object.freeze(["forward-only", "october-300"]);
const OPTIONS = Object.freeze(["path", "db", "sheet-id", "values-json", "settings-file", "data-dir", "plan", "result", "dry-run", "apply"]);
const PLAN_MAX_BYTES = 64 * 1024;
const VALUES_MAX_BYTES = 64 * 1024 * 1024;
const GOOGLE_TIMEOUT_MS = 60 * 1000;
const READ_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
// Both adjust routes keep a note of 500 characters and refuse more than $10,000.
const NOTE_MAX = 500;
const ADJUST_CAP_CENTS = 10000 * 100;
// The Job Tracking cells a planned row moves: the two that decide whose load it is.
const ROW_COLUMNS = Object.freeze(["Owner ID", "Truck"]);
const LOAD_RE = /^#?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PAYOUT_HEAD = 'app.put("/api/investor/payouts/:id/adjust", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const INVOICE_HEAD = 'app.put("/api/invoices/:id/adjust", requireRole("Super Admin"), refuseCrossOrigin, async (req, res) => {';
const PAYOUT_ROUTE = "PUT /api/investor/payouts/:id/adjust";
const INVOICE_ROUTE = "PUT /api/invoices/:id/adjust";
const HEADS = Object.freeze([PAYOUT_HEAD, INVOICE_HEAD]);
// What the run lifts beside the two routes: the readers its checks share with the
// app, and PUT /api/data/:rowIndex's own steps for a planned row (as #764's script
// writes a cell). assertInvoiceFileStillOwn and recordPayoutChange are named: each
// is called on the line after a comment ending in ".", which server-lift's walk
// reads as a property access.
const ROOTS = Object.freeze([
	"KEY_FILE", "logAudit", "logAuditRefusal", "periodWriteLocked", "periodLocksReadable", "recordPayoutChange", "assertInvoiceFileStillOwn",
	"normalizeDriverName", "invoicePaidDaysOf", "invoiceGridDayName", "personalSnapshotOf", "personalOpenInvoicesFrom",
	"personalRowsOnInvoice", "correctionLinesOnInvoice", "correctionLinesTablePresent", "correctionWaitingLines", "invoiceMonthLockBlockers", "invoiceTotalDue",
	"resolveSheetTargetForWrite", "a1SheetPrefix", "rowMovedRefusal", "restoreUntouchedCells", "validateOwnerIdCell", "brokerContact",
	"driverCellRefusal", "sheetRowAfterUpdate", "changedGuardedCells", "ROW_EDITOR_CANCEL_GUARD_ENABLED", "rowEditCancelRefusal",
	"sheetRowUpdateBlocker", "sheetRowCellWrites", "buildSheetUpdateAudit", "sheetAuditWithCode",
]);
const PROVIDED = Object.freeze(["db", "require", "console", "process", "__dirname", "Date", "app", "requireRole", "refuseCrossOrigin", "notifyChange",
	"fs", "DATA_DIR", "REPLICA", "renderPolicy", "SPREADSHEET_ID"]);
const DENIED = Object.freeze(["getSheets", "sheets", "server", "io", "transporter", "getDrive", "sendEmail", "jtCacheInvalidate",
	"getJobTrackingCached", "fetch"]);
// The modules the lifted code may load: server.js's own top-level requires.
const LIFTED_REQUIRE_OK = (m) => ["crypto", "path", "pdfkit", "pdf-lib"].includes(m) || /^\.\/lib\/[\w.-]+$/.test(m);
const LOCKED_STATUSES = new Set(["Approved", "Processing", "Paid"]);

class Refusal extends Error {}

// ── the command line and the files ──────────────────────────────────────────

const clip = (s) => String(s).slice(0, 80);

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/s.exec(String(a));
		if (!m || !OPTIONS.includes(m[1])) throw new Refusal(`unknown argument: ${clip(a)}`);
		const [, name, value] = m;
		if (name in out) throw new Refusal(`--${name} is given twice`);
		if (name === "dry-run" || name === "apply") {
			if (value !== undefined) throw new Refusal(`--${name} takes no value`);
			out[name] = true;
		} else {
			if (value === undefined || !value.trim()) throw new Refusal(`--${name}=<…> needs a value`);
			out[name] = value.trim();
		}
	}
	if (out["dry-run"] && out.apply) throw new Refusal("give --dry-run or --apply, not both");
	for (const [name, what] of [["path", `the answer to apply (${PATHS.join(" or ")})`], ["db", "the app's database"], ["plan", "the private plan file"], ["result", "where the result goes"]]) {
		if (!out[name]) throw new Refusal(`--${name}=<…> is required (${what}); there is no default`);
	}
	if (!PATHS.includes(out.path)) throw new Refusal(`--path must be ${PATHS.join(" or ")}, not ${clip(out.path)}`);
	if (out["sheet-id"] && out["values-json"]) throw new Refusal("give --sheet-id or --values-json, not both");
	if (!out["sheet-id"] && !out["values-json"]) throw new Refusal("--sheet-id=<…> is required (the Job Tracking book); there is no default");
	return {
		path: out.path, db: out.db, sheetId: out["sheet-id"] || null, valuesJson: out["values-json"] || null, settingsFile: out["settings-file"] || null,
		dataDir: out["data-dir"] || null, plan: out.plan, result: out.result, apply: out.apply === true,
	};
}

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (p, base) => p === base || p.startsWith(`${base}${path.sep}`);

// A path outside the repository (links followed as far as they exist).
function outsideRepo(p, what) {
	const abs = path.resolve(p);
	let dir;
	try { dir = fs.realpathSync(path.dirname(abs)); } catch { throw new Refusal(`${what}'s folder does not exist: ${clip(p)}`); }
	const file = path.join(dir, path.basename(abs));
	if (inside(realOr(file), fs.realpathSync(ROOT)) || inside(dir, fs.realpathSync(ROOT))) throw new Refusal(`${what} must be outside the repository: ${clip(p)}`);
	return file;
}

function resultPath(p) {
	const file = outsideRepo(p, "--result");
	let st = null;
	try { st = fs.lstatSync(file); } catch { st = null; }
	if (st && (st.isSymbolicLink() || !st.isFile())) throw new Refusal(`--result must be a plain file, not a link or a folder: ${clip(p)}`);
	return file;
}

// The result, owner-only, replaced whole (written beside it, then renamed).
function writeResult(file, result) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(result, null, 1)}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
	fs.chmodSync(file, 0o600);
}

function readSmallFile(p, what, max) {
	const file = outsideRepo(p, what);
	let st;
	try { st = fs.statSync(file); } catch { throw new Refusal(`${what} names no file: ${clip(p)}`); }
	if (!st.isFile() || st.size > max) throw new Refusal(`${what} must be a file of at most ${max} bytes`);
	return fs.readFileSync(file, "utf8");
}

const readPlanFile = (p) => parsePlan(readSmallFile(p, "--plan", PLAN_MAX_BYTES));

// A saved values.get of Job Tracking: { values: [[header…], [row…]] }.
function readValuesFile(p) {
	let v;
	try { v = JSON.parse(readSmallFile(p, "--values-json", VALUES_MAX_BYTES)); } catch (err) { throw err instanceof Refusal ? err : new Refusal(`--values-json is not JSON (${err.message})`); }
	if (!v || !Array.isArray(v.values) || !v.values.length || !v.values.every((r) => r == null || Array.isArray(r))) throw new Refusal("--values-json must hold { \"values\": [[…], …] }, a values.get of Job Tracking");
	return v.values;
}

// ── money and days ───────────────────────────────────────────────────────────

const usd = (cents) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dollars = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US")}`;
const centsOf = (n) => Math.round(Number(n || 0) * 100);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (s) => {
	const t = DAY_RE.test(String(s)) ? Date.parse(`${s}T12:00:00Z`) : NaN;
	return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const dayAfter = (s) => new Date(Date.parse(`${s}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
// The tag a plan names the driver by: 8 hex of the sha256 of the normalized name.
const driverTag = (normalized) => (normalized ? `d-${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8)}` : "");
// An invoice number without the driver's initials.
const numberTail = (n) => String(n || "").replace(/^INV-(?:M-)?[A-Za-z]+-/, "");
const cellText = (v) => (v == null ? "" : String(v));
function sameCells(a, b) {
	const n = Math.max(a.length, b.length);
	for (let i = 0; i < n; i++) if (cellText(a[i]) !== cellText(b[i])) return false;
	return true;
}

// ── the plan ────────────────────────────────────────────────────────────────

const PLAN_FIELDS = new Set(["kind", "path", "period", "ownerId", "splitPct", "driver", "ownRate", "days", "payout", "carrier", "acknowledged", "knownAdjustments", "rows", "expectedEffective"]);
const DAY_FIELDS = new Set(["day", "ledger", "set", "invoice", "paid"]);

function planMoney(v, what, { signed = false } = {}) {
	const re = signed ? /^-?\d{1,7}\.\d{2}$/ : /^\d{1,7}\.\d{2}$/;
	if (typeof v !== "string" || !re.test(v)) throw new Refusal(`the plan's ${what} must be an amount like "${signed ? "-" : ""}123.45"`);
	const neg = v.startsWith("-");
	const [w, f] = v.replace(/^-/, "").split(".");
	const c = Number(w) * 100 + Number(f);
	if (!signed && c <= 0) throw new Refusal(`the plan's ${what} must be above zero`);
	return neg ? -c : c;
}

function planNote(v, what) {
	if (typeof v !== "string" || v !== v.trim() || v.length > NOTE_MAX || /[\u0000-\u001f\u007f]/.test(v)) {
		throw new Refusal(`the plan's ${what} must be one trimmed line of at most ${NOTE_MAX} characters`);
	}
	return v;
}

// The plan, its own figures checked against each other. Throws Refusal.
function parsePlan(text) {
	let p;
	try { p = JSON.parse(text); } catch (err) { throw new Refusal(`the plan is not JSON (${err.message})`); }
	const fail = (why) => { throw new Refusal(`the plan ${why}`); };
	const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
	if (!obj(p)) fail("is not an object");
	const extra = Object.keys(p).filter((k) => !PLAN_FIELDS.has(k));
	if (extra.length) fail(`has unknown fields: ${extra.join(", ")}`);
	if (p.kind !== PLAN_KIND) fail(`is not a ${PLAN_KIND} plan (kind)`);
	if (!PATHS.includes(p.path)) fail(`names no path (${PATHS.join(" or ")})`);
	if (typeof p.period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(p.period)) fail("names no month (period, YYYY-MM)");
	if (!Number.isInteger(p.ownerId) || p.ownerId <= 0) fail("names no investor (ownerId)");
	if (!Number.isInteger(p.splitPct) || p.splitPct < 1 || p.splitPct > 100) fail("names no split (splitPct, a whole percentage)");
	if (typeof p.driver !== "string" || !/^d-[0-9a-f]{8}$/.test(p.driver)) fail("names no driver (driver, d- and 8 hex)");
	const ownRateCents = planMoney(p.ownRate, "ownRate");
	if (!Array.isArray(p.days) || !p.days.length || p.days.length > 62) fail("lists no days (days)");
	const seen = new Set();
	const days = p.days.map((d, i) => {
		if (!obj(d)) fail(`has a day that is not an object (days[${i}])`);
		const bad = Object.keys(d).filter((k) => !DAY_FIELDS.has(k));
		if (bad.length) fail(`has unknown fields on days[${i}]: ${bad.join(", ")}`);
		if (!realDay(d.day)) fail(`has no calendar day on days[${i}] (day, YYYY-MM-DD)`);
		if (seen.has(d.day)) fail(`names ${d.day} twice`);
		seen.add(d.day);
		// A null ledger figure: a day of his the investor's month does not count, which only his invoice pays.
		const out = { day: d.day, ledgerCents: d.ledger === null ? null : planMoney(d.ledger, `ledger figure of ${d.day}`), setCents: planMoney(d.set, `set figure of ${d.day}`), invoiceId: null, paidCents: null };
		if ((d.invoice === undefined) !== (d.paid === undefined)) fail(`gives ${d.day} an invoice without what it paid, or the other way round (invoice and paid go together)`);
		if (d.invoice !== undefined) {
			if (!Number.isInteger(d.invoice) || d.invoice <= 0) fail(`names no invoice id on ${d.day}`);
			out.invoiceId = d.invoice;
			out.paidCents = planMoney(d.paid, `paid figure of ${d.day}`);
		}
		if (out.ledgerCents === null && out.invoiceId === null) fail(`gives ${d.day} neither a ledger figure nor an invoice`);
		return out;
	}).sort((a, b) => (a.day < b.day ? -1 : 1));
	const adjustmentSide = (v, what, whole) => {
		if (!obj(v) || Object.keys(v).sort().join(",") !== "adjustment,note") fail(`${what} must give adjustment and note`);
		let cents;
		if (whole) {
			if (!Number.isInteger(v.adjustment)) fail(`${what}'s adjustment must be whole dollars`);
			cents = v.adjustment * 100;
		} else {
			cents = planMoney(v.adjustment, `${what}'s adjustment`, { signed: true });
		}
		if (Math.abs(cents) > ADJUST_CAP_CENTS) fail(`${what}'s adjustment is over the routes' $10,000 cap`);
		return { cents, note: planNote(v.note, `${what}'s note`) };
	};
	if (!obj(p.payout) || Object.keys(p.payout).sort().join(",") !== "after,before,id") fail("must give payout { id, before, after }");
	if (!Number.isInteger(p.payout.id) || p.payout.id <= 0) fail("names no payout row (payout.id)");
	const payout = { id: p.payout.id, before: adjustmentSide(p.payout.before, "payout.before", true), after: adjustmentSide(p.payout.after, "payout.after", true) };
	let carrier = null;
	if (p.carrier !== null && p.carrier !== undefined) {
		if (!obj(p.carrier) || Object.keys(p.carrier).sort().join(",") !== "after,before,id") fail("must give carrier as null or { id, before, after }");
		if (!Number.isInteger(p.carrier.id) || p.carrier.id <= 0) fail("names no carrying invoice (carrier.id)");
		carrier = { id: p.carrier.id, before: adjustmentSide(p.carrier.before, "carrier.before", false), after: adjustmentSide(p.carrier.after, "carrier.after", false) };
	}
	// An adjustment a paying invoice carries that a person read and judged not a
	// change to what it paid a day: that invoice may carry exactly it.
	const knownAdjustments = new Map();
	if (p.knownAdjustments !== undefined) {
		if (!Array.isArray(p.knownAdjustments) || p.knownAdjustments.length > 20) fail("must give knownAdjustments as a list");
		for (const k of p.knownAdjustments) {
			if (!obj(k) || Object.keys(k).sort().join(",") !== "adjustment,invoice,note" || !Number.isInteger(k.invoice) || k.invoice <= 0) fail("must give each known adjustment as { invoice, adjustment, note }");
			if (knownAdjustments.has(k.invoice) || (carrier && carrier.id === k.invoice)) fail(`names invoice ${k.invoice}'s adjustment twice`);
			const cents = planMoney(k.adjustment, `known adjustment of invoice ${k.invoice}`, { signed: true });
			if (!cents) fail(`gives invoice ${k.invoice} a known adjustment of $0.00`);
			knownAdjustments.set(k.invoice, { cents, note: planNote(k.note, `known adjustment note of invoice ${k.invoice}`) });
		}
	}
	// The other invoices of his that carry money a person read and judged not to
	// be this difference, each by the fingerprint the dry run prints. A plan that
	// pays the driver a difference must say, even when there are none.
	let acknowledged = null;
	if (p.acknowledged !== undefined) {
		if (!Array.isArray(p.acknowledged) || p.acknowledged.length > 20) fail("must give acknowledged as a list");
		acknowledged = new Map();
		for (const a of p.acknowledged) {
			if (!obj(a) || Object.keys(a).sort().join(",") !== "fingerprint,invoice" || !Number.isInteger(a.invoice) || a.invoice <= 0 || typeof a.fingerprint !== "string" || !/^[0-9a-f]{16}$/.test(a.fingerprint)) {
				fail("must give each acknowledged invoice as { invoice, fingerprint }");
			}
			if (acknowledged.has(a.invoice)) fail(`acknowledges invoice ${a.invoice} twice`);
			acknowledged.set(a.invoice, a.fingerprint);
		}
	}
	if (carrier && !acknowledged) fail("pays the driver a difference, so it must list the other invoices of his it has read (acknowledged: a list, which may be empty)");
	if (!carrier && acknowledged && acknowledged.size) fail("acknowledges other invoices but pays the driver no difference");
	// The rows to move to the investor first: each one's Owner ID and Truck.
	const rows = [];
	if (p.rows !== undefined) {
		if (!Array.isArray(p.rows) || !p.rows.length || p.rows.length > 20) fail("must give rows as a list of 1 to 20");
		const seenLoads = new Set();
		const seenRows = new Set();
		p.rows.forEach((r, i) => {
			if (!obj(r) || Object.keys(r).sort().join(",") !== "cells,load,row") fail(`must give rows[${i}] as { load, row, cells }`);
			if (typeof r.load !== "string" || !LOAD_RE.test(r.load)) fail(`names no load on rows[${i}]`);
			const key = normalizeLoadId(r.load);
			if (seenLoads.has(key)) fail(`names load ${r.load} twice`);
			seenLoads.add(key);
			if (!Number.isInteger(r.row) || r.row < 2) fail(`names no sheet row on rows[${i}] (row, 2 or more)`);
			if (seenRows.has(r.row)) fail(`names row ${r.row} twice`);
			seenRows.add(r.row);
			if (!obj(r.cells) || Object.keys(r.cells).sort().join(",") !== [...ROW_COLUMNS].sort().join(",")) fail(`must move exactly ${ROW_COLUMNS.join(" and ")} on rows[${i}]`);
			const cells = ROW_COLUMNS.map((column) => {
				const v = r.cells[column];
				if (!obj(v) || Object.keys(v).sort().join(",") !== "after,before" || typeof v.before !== "string" || typeof v.after !== "string") fail(`gives ${column} on rows[${i}] no before and after`);
				if (v.after === v.before) fail(`gives ${column} on rows[${i}] the same before and after`);
				if (!v.after || v.after !== v.after.trim() || v.after.length > 64 || /[\u0000-\u001f\u007f]/.test(v.after) || /^[=+@-]/.test(v.after)) fail(`gives ${column} on rows[${i}] an after value that is not one plain cell`);
				return { column, before: v.before, after: v.after };
			});
			if (cells[0].after !== String(p.ownerId)) fail(`must move rows[${i}]'s Owner ID to the plan's investor, ${p.ownerId}`);
			rows.push({ load: r.load, key, row: r.row, cells });
		});
	}
	if (!Number.isInteger(p.expectedEffective) || p.expectedEffective < 0) fail("names no expected payout (expectedEffective, whole dollars)");

	// The investor's side: the ledger's driver pay falls (or rises) by the days'
	// moves, and the investor's share of it is the change to the adjustment.
	const ledgerFallCents = days.reduce((s, d) => s + (d.ledgerCents === null ? 0 : d.ledgerCents - d.setCents), 0);
	const shareDollars = Math.sign(ledgerFallCents) * Math.round((Math.abs(ledgerFallCents) * p.splitPct) / 10000);
	const payoutMove = (payout.after.cents - payout.before.cents) / 100;
	if (payoutMove !== shareDollars) fail(`moves the payout adjustment by ${dollars(payoutMove)}, not ${p.splitPct}% of the days' ${usd(ledgerFallCents)} in whole dollars (${dollars(shareDollars)})`);
	if (!shareDollars && payout.after.note !== payout.before.note) fail("changes the payout row's note but not its adjustment");
	if (shareDollars && !payout.after.note) fail("gives the payout adjustment no note");
	// The driver's side: what the days' invoices paid against what they move to.
	const driverMoveCents = days.reduce((s, d) => s + (d.invoiceId != null ? d.setCents - d.paidCents : 0), 0);
	if (carrier) {
		if (carrier.after.cents - carrier.before.cents !== driverMoveCents) fail(`moves the carrying invoice by ${usd(carrier.after.cents - carrier.before.cents)}, not the days' ${usd(driverMoveCents)}`);
		if (!driverMoveCents) fail("names a carrying invoice but moves no invoiced day");
		if (!carrier.after.note) fail("gives the carrying invoice's adjustment no note");
	} else if (driverMoveCents) {
		fail(`moves invoiced days by ${usd(driverMoveCents)} but names no carrying invoice`);
	}
	if (p.path === "forward-only") {
		const up = days.find((d) => (d.ledgerCents !== null && d.setCents > d.ledgerCents) || (d.invoiceId != null && d.setCents > d.paidCents));
		if (up) fail(`is forward-only but raises ${up.day}`);
		if (shareDollars <= 0) fail("is forward-only but moves no day off the new rate");
	} else {
		const off = days.find((d) => (d.ledgerCents !== null && d.setCents !== d.ledgerCents) || (d.invoiceId != null && d.setCents < d.paidCents));
		if (off) fail(`is october-300 but moves ${off.day} off the ledger's figure, or below what was paid`);
		if (!carrier) fail("is october-300 but pays the driver no difference (carrier)");
	}
	return {
		path: p.path, period: p.period, ownerId: p.ownerId, splitPct: p.splitPct, driver: p.driver, ownRateCents, days, payout, carrier,
		acknowledged: acknowledged || new Map(), knownAdjustments, rows, expectedEffective: p.expectedEffective, ledgerFallCents, shareDollars, driverMoveCents,
	};
}

// ── the lift ────────────────────────────────────────────────────────────────

const clockDate = (nowMs) => (nowMs === null || nowMs === undefined ? Date : class extends Date {
	constructor(...a) { super(...(a.length ? a : [nowMs])); }
	static now() { return nowMs; }
});

// The two routes and the readers, lifted from this checkout's server.js onto `db`.
// `dataDir` is where the invoice PDFs live; `sheetId` is the book a planned row is
// written to; `render` replaces renderPolicy() (tests pass a stub). Throws Refusal
// when the lift is incomplete.
function liftServer({ db, env = {}, nowMs = null, dataDir = ROOT, sheetId = null, render = null, roots = ROOTS, src = null }) {
	const text = src || serverSource({ root: ROOT });
	let lifted;
	try {
		lifted = closure(text, { roots: [...roots], routes: [...HEADS], provided: [...PROVIDED], denied: [...DENIED] });
	} catch (err) {
		throw new Refusal(`this checkout's server.js can't be lifted for the fix (${err.message}); nothing was read or written`);
	}
	const missing = unresolvedNames(text, lifted, PROVIDED, HEADS);
	if (missing.length) throw new Refusal(`the lifted code uses ${missing.join(", ")}, which the lift left out; nothing was read or written`);
	const routes = {};
	const register = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
	const app = { get: register("GET"), put: register("PUT"), post: register("POST"), delete: register("DELETE"), use() {} };
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const liftedRequire = (m) => {
		if (!LIFTED_REQUIRE_OK(m)) throw new Error(`lifted code required ${m}, which this script does not load`);
		return appRequire(m);
	};
	const scriptProcess = { env: { ...env }, pid: process.pid, argv: [], cwd: () => process.cwd(), exit: () => { throw new Error("lifted code called process.exit()"); } };
	const state = { rendered: 0 };
	// The app's own renderer, loaded on the first render only, so a dry run starts no browser.
	const renderPolicy = async (...a) => {
		state.rendered++;
		return render ? render(...a) : appRequire("./lib/policy-renderer").renderPolicy(...a);
	};
	const body = ['"use strict";', lifted.text, `return { ${roots.join(", ")} };`].join("\n");
	// A script has no sockets: notifyChange() is nothing, and the screens show the change on their next read.
	const api = new Function(...PROVIDED, body)(db, liftedRequire, console, scriptProcess, ROOT, clockDate(nowMs), app, pass, pass(), () => {}, fs, dataDir, null, renderPolicy, sheetId);
	api.adjustPayout = routes[PAYOUT_ROUTE];
	api.adjustInvoice = routes[INVOICE_ROUTE];
	if (typeof api.adjustPayout !== "function" || typeof api.adjustInvoice !== "function") throw new Refusal(`${PAYOUT_ROUTE} or ${INVOICE_ROUTE} did not register from this checkout's server.js`);
	api.liftedNames = lifted.names;
	api.renders = () => state.rendered;
	return api;
}

// ── the sheet ───────────────────────────────────────────────────────────────

// The Google client with the app's own key (see the header): the read-only scope,
// or the read-write one when a planned row is to be written.
async function googleSheets({ keyFile, write = false, cwd = process.cwd() }) {
	if (realOr(cwd) !== realOr(ROOT)) {
		throw new Refusal("run it from the app's own folder: the Sheets key is the app's own, which the Google client reads relative to the folder it runs in, as the server's does");
	}
	const { google } = createRequire(path.join(ROOT, "server.js"))("googleapis");
	google.options({ timeout: GOOGLE_TIMEOUT_MS });
	const auth = new google.auth.GoogleAuth({ keyFile, scopes: [write ? WRITE_SCOPE : READ_SCOPE] });
	return google.sheets({ version: "v4", auth: await auth.getClient() });
}

async function readTab(sheets, sheetId) {
	const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: TAB });
	return (res && res.data && res.data.values) || [];
}

// The tab's headers, the Load ID and Driver columns and each column a planned row
// moves (one each, by its exact header), and the rows. `problems` when one can't be told.
function sheetFacts(values) {
	const all = Array.isArray(values) ? values : [];
	const headers = (all[0] || []).map(cellText);
	const problems = [];
	const one = (test, what) => {
		const hits = headers.map((h, i) => (test(h.trim()) ? i : -1)).filter((i) => i >= 0);
		if (hits.length !== 1) problems.push(`${TAB} has ${hits.length} ${what} column(s), not one`);
		return hits.length === 1 ? hits[0] : -1;
	};
	const loadCol = one((h) => /^load.?id$/i.test(h), "Load ID");
	const driverCol = one((h) => /^driver$/i.test(h), "Driver");
	const cols = new Map(ROW_COLUMNS.map((c) => [c, one((h) => h.toLowerCase() === c.toLowerCase(), c)]));
	const data = all.slice(1).map((cells, i) => ({ rowIndex: i + 2, cells: (cells || []).map(cellText) }));
	return { headers, loadCol, driverCol, cols, data, problems };
}

// The tab's values with each planned row as the run will leave it.
function valuesAfter(values, entries) {
	const out = values.map((r) => (r || []).slice());
	for (const e of entries) out[e.rowIndex - 1] = e.values.slice();
	return out;
}

// The checks PUT /api/data/:rowIndex makes of a Super Admin's save once the row is
// read and bound, on `before` (the row as read), the row as the checks read it
// (`baseline`) and the new values: { refusal, audit } or { cellWrites, details }.
function judgeRowSave(api, { a1, rowIndex, headers, before, baseline, values, columns }) {
	const vals = values.slice();
	api.restoreUntouchedCells(before, vals, baseline);
	const owner = api.validateOwnerIdCell(TAB, headers, vals);
	if (owner) return { refusal: { code: "OWNER_ID_REFUSED", error: owner.error } };
	const contact = api.brokerContact.contactNotAllowedRefusal(headers, before, vals);
	if (contact) return { refusal: contact };
	const driver = api.driverCellRefusal(headers, before, vals);
	if (driver) return { refusal: driver };
	const after = api.sheetRowAfterUpdate(before, vals);
	const changes = api.changedGuardedCells(headers, before, after);
	const cellWrites = api.sheetRowCellWrites(a1, rowIndex, before, after);
	// The route's audit lists every changed cell; with only the planned cells (both
	// guarded) changed, that list is changedGuardedCells()'s.
	const planned = [...columns].sort((x, y) => x - y);
	if (cellWrites.length !== planned.length || changes.length !== planned.length || changes.some((c, i) => c.index !== planned[i])) {
		return { refusal: { code: "NOT_THE_PLANNED_CELLS", error: `the save would change ${cellWrites.length} cell(s), not the planned ${planned.length}` } };
	}
	const details = (outcome, extra = {}) => api.buildSheetUpdateAudit({ outcome, sheet: TAB, rowIndex, changed: changes, guardedChanged: changes, snapshotUnavailable: false, ...extra });
	if (api.ROW_EDITOR_CANCEL_GUARD_ENABLED) {
		const cancel = api.rowEditCancelRefusal(headers, before, after);
		if (cancel) return { refusal: cancel, audit: { code: cancel.code, details: api.sheetAuditWithCode(details("blocked", { code: cancel.code }), cancel.code) } };
	}
	const blocker = api.sheetRowUpdateBlocker(true, headers, before, after, changes);
	if (blocker) return { refusal: blocker, audit: { code: blocker.code, details: api.sheetAuditWithCode(details("blocked", { code: blocker.code, periods: blocker.periods }), blocker.code) } };
	return { cellWrites, details };
}

// Each planned row as the tab shows it, judged before any write: { problems, entries }.
function rowChecks({ api, db, plan, facts }) {
	if (!plan.rows.length) return { problems: [], entries: [] };
	const problems = [...facts.problems];
	const entries = [];
	if (problems.length) return { problems, entries };
	const a1 = api.a1SheetPrefix(TAB);
	for (const r of plan.rows) {
		const hits = facts.data.filter((x) => normalizeLoadId(x.cells[facts.loadCol]) === r.key);
		if (hits.length !== 1) { problems.push(`load ${r.load}: ${hits.length} ${TAB} rows carry it, not one`); continue; }
		const row = hits[0];
		if (row.rowIndex !== r.row) { problems.push(`load ${r.load} is on row ${row.rowIndex}, not the plan's ${r.row}`); continue; }
		if (driverTag(api.normalizeDriverName(cellText(row.cells[facts.driverCol]))) !== plan.driver) { problems.push(`load ${r.load} (row ${r.row}) is not driver ${plan.driver}'s`); continue; }
		const columns = r.cells.map((c) => facts.cols.get(c.column));
		const now = columns.map((i) => cellText(row.cells[i]));
		const state = r.cells.every((c, k) => now[k] === c.after) ? "already-done" : r.cells.every((c, k) => now[k] === c.before) ? "to-write" : null;
		if (!state) { problems.push(`load ${r.load} (row ${r.row}) shows ${r.cells.map((c, k) => `${c.column} ${JSON.stringify(now[k])}`).join(", ")}: neither the plan's before nor its after`); continue; }
		const truck = r.cells.find((c) => c.column === "Truck").after;
		const trucks = db.prepare("SELECT id, owner_id FROM trucks WHERE LOWER(TRIM(unit_number)) = LOWER(TRIM(?))").all(truck);
		if (trucks.length !== 1 || trucks[0].owner_id !== plan.ownerId) { problems.push(`load ${r.load}: truck ${JSON.stringify(truck)} is not one truck of owner ${plan.ownerId}`); continue; }
		const values = row.cells.slice();
		r.cells.forEach((c, k) => { while (values.length <= columns[k]) values.push(""); values[columns[k]] = c.after; });
		const e = { load: r.load, key: r.key, rowIndex: row.rowIndex, cells: row.cells, values, columns, state, before: r.cells.map((c) => c.before), after: r.cells.map((c) => c.after) };
		if (state === "to-write") {
			const j = judgeRowSave(api, { a1, rowIndex: row.rowIndex, headers: facts.headers, before: row.cells, baseline: row.cells, values, columns });
			if (j.refusal) { problems.push(`load ${r.load}: the save would be refused (${j.refusal.code || "REFUSED"}): ${clip(j.refusal.error || "")}`); continue; }
		}
		entries.push(e);
	}
	return { problems, entries };
}

// One planned row written as PUT /api/data/:rowIndex writes a Super Admin's save.
// { state, code?, why? }: written, failed (the write threw: it may have landed),
// refused (a check of the route's, audited as the route audits it) or not-written.
async function writeRow({ api, sheets, sheetId, entry, planHeaders }) {
	const a1 = api.a1SheetPrefix(TAB);
	const r = entry.rowIndex;
	const req = { session: { user: { ...SYSTEM_USER } } };
	const log = (action, details) => api.logAudit(req, action, "sheet_row", `${TAB}!${r}`, details);
	const logRefusal = (action, details, code) => api.logAuditRefusal(req, action, "sheet_row", `${TAB}!${r}`, details, code);
	let headers;
	let before;
	try {
		const pre = await sheets.spreadsheets.values.batchGet({ spreadsheetId: sheetId, ranges: [`${a1}!1:1`, `${a1}!${r}:${r}`] });
		const vr = (pre && pre.data && pre.data.valueRanges) || [];
		headers = ((vr[0] && vr[0].values) || [[]])[0] || [];
		before = ((vr[1] && vr[1].values) || [[]])[0] || [];
	} catch (err) {
		return { state: "not-written", code: "ROW_READ_FAILED", why: err.message };
	}
	if (!headers.length) return { state: "not-written", code: "ROW_READ_FAILED", why: "the header row came back empty" };
	const moved = api.rowMovedRefusal(headers, r, before, entry.values, entry.cells);
	if (moved) {
		log("update_sheet_row_blocked", api.sheetAuditWithCode(api.buildSheetUpdateAudit({
			outcome: "blocked", sheet: TAB, rowIndex: r, changed: moved.edited, guardedChanged: moved.edited.filter((c) => c.why),
			code: "ROW_MOVED", expectedLoadId: moved.expectedRaw, foundLoadId: moved.foundRaw,
		}), "ROW_MOVED"));
		return { state: "refused", code: "ROW_MOVED", why: moved.body.error };
	}
	// This run's own rule: the row is the row the checks judged, every cell of it.
	if (!sameCells(headers, planHeaders) || !sameCells(before, entry.cells)) {
		return { state: "not-written", code: "ROW_CHANGED_SINCE_CHECK", why: "the row is not the row the checks judged; run it again" };
	}
	const j = judgeRowSave(api, { a1, rowIndex: r, headers, before, baseline: entry.cells, values: entry.values, columns: entry.columns });
	if (j.refusal) {
		if (j.audit) logRefusal("update_sheet_row_blocked", j.audit.details, j.audit.code);
		return { state: "refused", code: j.refusal.code || "REFUSED", why: j.refusal.error || "" };
	}
	let fresh;
	try {
		const re = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${a1}!${r}:${r}` });
		fresh = ((re && re.data && re.data.values) || [[]])[0] || [];
	} catch (err) {
		log("update_sheet_row_blocked", api.sheetAuditWithCode(j.details("blocked", { code: "ROW_READ_FAILED", error: err.message }), "ROW_READ_FAILED"));
		return { state: "refused", code: "ROW_READ_FAILED", why: err.message };
	}
	if (api.sheetRowCellWrites(a1, r, before, fresh).length) {
		log("update_sheet_row_blocked", api.sheetAuditWithCode(j.details("blocked", { code: "SHEET_CHANGED" }), "SHEET_CHANGED"));
		return { state: "refused", code: "SHEET_CHANGED", why: "the row changed while the save was being checked" };
	}
	try {
		await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: sheetId, requestBody: { valueInputOption: "USER_ENTERED", data: j.cellWrites } });
	} catch (err) {
		log("update_sheet_row_failed", j.details("failed", { error: err.message }));
		return { state: "failed", code: "WRITE_FAILED", why: err.message };
	}
	log("update_sheet_row", j.details("updated"));
	return { state: "written" };
}

// ── the payout code (read-only) ─────────────────────────────────────────────

function moneyWorld(ctx, values) {
	return buildLedgerWorld({ root: ROOT, dbPath: ctx.dbPath, readonly: true, sheetData: { values }, envFile: ctx.settingsFile, extraRoots: ["resolveInvestorSplitPct", "normalizeDriverName"], now: ctx.nowMs, db: ctx.roDb });
}

// The investor's months as GET /api/payouts' reconcile computes them, the plan's
// driver's days in the plan's month, and the month replayed with those days at
// their "set" figures: the split on the raw net, rounded once, carried as the
// payout code carries it.
async function ownerLedger(world, plan) {
	const { api, db } = world;
	const carrierDB = api.getCarrierDBFromSQLite();
	const driverCol = api.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
	const carrierCol = api.findCol(carrierDB.headers, /carrier/i);
	const config = {};
	for (const r of db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all()) config[r.key] = r.value;
	for (const r of db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(plan.ownerId)) config[r.key] = r.value;
	const investorDriverSet = api.getInvestorDriverSet(plan.ownerId, carrierDB.data, driverCol, carrierCol);
	const out = await api.computeInvestorMonthlyEarnings({ user: { id: plan.ownerId }, isSuperAdmin: false, investorDriverSet, investorOwnerId: plan.ownerId, config });
	const carry = api.computeLossCarryForward(out.monthlyEarnings);
	const month = out.monthlyEarnings.find((m) => m.month === plan.period) || null;
	const splitPct = api.resolveInvestorSplitPct(config);
	const days = new Map();
	for (const it of out.items || []) {
		if (it.kind !== "driver_pay" || it.month !== plan.period || driverTag(api.normalizeDriverName(String(it.driver || ""))) !== plan.driver) continue;
		const k = it.day || "(the month)";
		if (!days.has(k)) days.set(k, []);
		days.get(k).push({ cents: it.cents, payType: it.payType });
	}
	let replayPayable = null;
	if (month && !month.payoutBasis) {
		const moved = out.monthlyEarnings.map((m) => (m.month === plan.period
			? { ...m, investorEarnings: Math.round((m.exact.netProfit + plan.ledgerFallCents / 100) * (splitPct / 100)) }
			: m));
		const c2 = api.computeLossCarryForward(moved);
		replayPayable = c2[plan.period] ? c2[plan.period].payable : null;
	}
	return {
		splitPct, known: Boolean(month), lease: Boolean(month && month.payoutBasis),
		payable: carry[plan.period] ? carry[plan.period].payable : null, replayPayable, days,
		months: out.monthlyEarnings.map((m) => ({ month: m.month, net: Math.round(m.exact.netProfit * 100) / 100, payable: carry[m.month] ? carry[m.month].payable : null })),
	};
}

// ── what the driver's invoices pay and carry ────────────────────────────────

// What one live invoice pays on `day`, in cents, as the invoice itself records it:
// a weekly invoice's day grid (the day's rate, else its total, as a correction
// line reads a grid day), a manual invoice's lines dated that day; a day it pays
// at no amount it can show is { cents: null }. null when it does not pay the day.
function invoicePays(api, inv, day) {
	const snap = api.personalSnapshotOf(inv) || {};
	if (Number(inv.is_manual)) {
		const lines = (Array.isArray(snap.lineItems) ? snap.lineItems : []).filter((li) => String((li && li.date) || "").trim() === day);
		if (lines.length) {
			const c = lines.reduce((s, li) => s + Math.round(Number(li && li.amount) * 100), 0);
			return { cents: Number.isFinite(c) ? c : null };
		}
		return api.invoicePaidDaysOf(inv).includes(day) ? { cents: null } : null;
	}
	if (!api.invoicePaidDaysOf(inv).includes(day)) return null;
	const cell = snap.days ? snap.days[api.invoiceGridDayName(day)] : null;
	const rate = cell ? (cell.rate != null ? Number(cell.rate) : Number(cell.total)) : NaN;
	return { cents: Number.isFinite(rate) ? Math.round(rate * 100) : null };
}

// A weekly invoice whose grid can't be read can't say which days it pays.
function gridReadable(api, inv) {
	const snap = api.personalSnapshotOf(inv);
	return Boolean(snap && snap.__templateName === "service_invoice" && snap.days && typeof snap.days === "object" && realDay(String(inv.week_start || "")));
}

// What an invoice of his carries that could be a difference posted already: its
// adjustment and note and its correction lines' total (unless `linesOnly`: a
// paying invoice, whose adjustment the payer check reads), and a manual invoice's
// lines off the planned days and its deductions.
function carriedBy(api, inv, planned, { linesOnly = false } = {}) {
	const snap = Number(inv.is_manual) ? api.personalSnapshotOf(inv) || {} : {};
	const line = (li, sign) => [cellText(li && li.date).trim(), sign * Math.round(Number(li && li.amount) * 100), cellText(li && li.description)];
	const lines = [
		...(Array.isArray(snap.lineItems) ? snap.lineItems : []).filter((li) => !planned.has(cellText(li && li.date).trim())).map((li) => line(li, 1)),
		...(Array.isArray(snap.deductions) ? snap.deductions : []).map((li) => line(li, -1)),
	];
	return linesOnly
		? { adjustmentCents: 0, note: "", correctionCents: 0, lines }
		: { adjustmentCents: centsOf(inv.adjustment), note: cellText(inv.adjustment_note), correctionCents: centsOf(inv.correction_lines_total), lines };
}
const carriesAny = (c) => c.adjustmentCents !== 0 || c.correctionCents !== 0 || c.lines.length > 0;
// A fingerprint of what an invoice carries: any change to it changes the fingerprint.
const fingerprintOf = (c) => crypto.createHash("sha256").update(JSON.stringify(c)).digest("hex").slice(0, 16);
function carriedText(c) {
	const sum = c.lines.reduce((s, l) => s + (Number.isFinite(l[1]) ? l[1] : 0), 0);
	return `adjustment ${usd(c.adjustmentCents)}${c.note ? ` (${JSON.stringify(clip(c.note))})` : ""}, correction lines ${usd(c.correctionCents)}, ${c.lines.length} manual line(s) off the planned days (${usd(sum)})`;
}

// Every live invoice of his, from the first planned day on, but the carrier, that
// carries something: { id, number, status, week, text, fingerprint }.
function otherInvoices({ api, db, plan, mine, payers }) {
	const planned = new Set(plan.days.map((d) => d.day));
	return db.prepare(`SELECT ${INVOICE_COLS} FROM invoices WHERE deleted_at = '' AND week_end >= ? ORDER BY id`).all(plan.days[0].day)
		.filter((r) => mine(r.driver) && !(plan.carrier && r.id === plan.carrier.id))
		.map((r) => ({ r, c: carriedBy(api, r, planned, { linesOnly: payers.has(r.id) }) }))
		.filter((x) => carriesAny(x.c))
		.map(({ r, c }) => ({ id: r.id, number: numberTail(r.invoice_number), status: r.status, week: `${r.week_start}..${r.week_end}`, text: carriedText(c), fingerprint: fingerprintOf(c) }));
}

// ── the checks ──────────────────────────────────────────────────────────────

const INVOICE_COLS = "*, strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at";

// The adjustment a row carries against the plan's two sides: to-write, already-done,
// unchanged (the plan leaves it), or null when it is neither.
function sideState(rowCents, rowNote, side) {
	const at = (s) => rowCents === s.cents && rowNote === s.note;
	const same = side.before.cents === side.after.cents && side.before.note === side.after.note;
	if (same) return at(side.before) ? "unchanged" : null;
	if (at(side.after)) return "already-done";
	if (at(side.before)) return "to-write";
	return null;
}

// Everything the database must show before a write.
function dbChecks({ api, db, plan }) {
	const problems = [];
	const norm = (s) => api.normalizeDriverName(typeof s === "string" ? s : "");
	const mine = (name) => driverTag(norm(name)) === plan.driver;
	if (!api.periodLocksReadable()) problems.push("the closed months can't be read (period_locks), so no month can be confirmed open");
	else if (api.periodWriteLocked(plan.period)) problems.push(`${plan.period} is already closed`);

	// The driver: one Drivers Database row, fixed pay, at the plan's own rate.
	const dir = db.prepare("SELECT id, driver_name, pay_type, pay_daily FROM drivers_directory ORDER BY id").all().filter((r) => mine(r.driver_name));
	if (dir.length !== 1) problems.push(`driver ${plan.driver}: ${dir.length} Drivers Database rows carry the name, not one`);
	else {
		if (String(dir[0].pay_type || "").trim().toLowerCase() !== "fixed") problems.push(`driver ${plan.driver} is not on fixed (daily) pay`);
		if (centsOf(dir[0].pay_daily) !== plan.ownRateCents) problems.push(`driver ${plan.driver}'s own rate is ${usd(centsOf(dir[0].pay_daily))}, not the plan's ${usd(plan.ownRateCents)}`);
	}

	// The payout row: the investor's, the month's, owed, not finalized, at the plan's before (or after).
	const row = db.prepare("SELECT * FROM investor_payouts WHERE id = ?").get(plan.payout.id) || null;
	let payout = null;
	if (!row) problems.push(`payout row ${plan.payout.id} does not exist`);
	else if (row.owner_id !== plan.ownerId || row.period !== plan.period) problems.push(`payout row ${plan.payout.id} is owner ${row.owner_id}'s ${row.period}, not owner ${plan.ownerId}'s ${plan.period}`);
	else {
		const state = sideState(centsOf(row.adjustment), String(row.adjustment_note || ""), plan.payout);
		payout = { id: row.id, amount: row.amount, status: row.status, finalized: String(row.finalized_at || "") !== "", adjustmentBefore: Number(row.adjustment || 0), adjustedBy: row.adjusted_by || "", adjustedAt: row.adjusted_at || "", note: String(row.adjustment_note || ""), state };
		if (payout.finalized) problems.push(`owner ${plan.ownerId}'s ${plan.period} payout row is finalized`);
		if (row.status !== "owed") problems.push(`owner ${plan.ownerId}'s ${plan.period} payout row is ${row.status}, not owed`);
		if (!state) problems.push(`owner ${plan.ownerId}'s ${plan.period} payout row carries ${dollars(Number(row.adjustment || 0))} with a note this plan did not write (neither its before nor its after)`);
		if (state === "to-write" && Math.round(row.amount || 0) + plan.payout.after.cents / 100 < 0) problems.push(`the adjustment would take owner ${plan.ownerId}'s ${plan.period} payout below $0 (the route refuses that)`);
	}

	// The driver's live invoices, Rejected aside, and who pays each planned day.
	const all = db.prepare(`SELECT ${INVOICE_COLS} FROM invoices WHERE deleted_at = '' ORDER BY id`).all().filter((r) => mine(r.driver) && r.status !== "Rejected");
	const first = plan.days[0].day;
	const last = plan.days[plan.days.length - 1].day;
	for (const inv of all) {
		if (Number(inv.is_manual) || inv.week_end < first || inv.week_start > last) continue;
		if (!gridReadable(api, inv)) problems.push(`invoice ${inv.id} (${numberTail(inv.invoice_number)}) covers the plan's days but has no day grid to read, so which days it pays can't be told`);
	}
	const dayLines = api.correctionLinesTablePresent()
		? db.prepare("SELECT c.id, c.line_date, s.driver AS source_driver FROM invoice_correction_lines c LEFT JOIN invoices s ON s.id = c.source_invoice_id WHERE c.kind = 'day' AND c.voided_at = ''").all().filter((l) => mine(l.source_driver))
		: [];
	const days = [];
	const payers = new Set();
	for (const d of plan.days) {
		const paidBy = [];
		for (const inv of all) {
			const p = invoicePays(api, inv, d.day);
			if (p) paidBy.push({ id: inv.id, cents: p.cents });
		}
		for (const l of dayLines) if (l.line_date === d.day) paidBy.push({ id: `correction line ${l.id}`, cents: null });
		const shown = paidBy.map((x) => `${x.id}${x.cents == null ? "" : ` at ${usd(x.cents)}`}`).join(", ");
		if (d.invoiceId == null) {
			if (paidBy.length) problems.push(`${d.day}: the plan has no invoice paying it, but ${shown} pays it`);
		} else if (paidBy.length !== 1 || paidBy[0].id !== d.invoiceId) {
			problems.push(`${d.day}: the plan says invoice ${d.invoiceId} alone pays it, but ${shown || "no live invoice"} does`);
		} else if (paidBy[0].cents !== d.paidCents) {
			problems.push(`${d.day}: invoice ${d.invoiceId} pays it at ${paidBy[0].cents == null ? "no amount it shows" : usd(paidBy[0].cents)}, not the plan's ${usd(d.paidCents)}`);
		} else {
			payers.add(d.invoiceId);
		}
		days.push({ day: d.day, ledger: d.ledgerCents === null ? null : usd(d.ledgerCents), set: usd(d.setCents), invoice: d.invoiceId, paid: d.paidCents == null ? null : usd(d.paidCents) });
	}
	const byId = new Map(all.map((r) => [r.id, r]));
	const carrierId = plan.carrier ? plan.carrier.id : null;
	for (const id of payers) {
		const inv = byId.get(id);
		if (id === carrierId) continue;
		const known = plan.knownAdjustments.get(id) || { cents: 0, note: "" };
		const carries = centsOf(inv.adjustment) !== known.cents || (known.cents !== 0 && String(inv.adjustment_note || "") !== known.note);
		if (carries || centsOf(inv.correction_lines_total) !== 0) {
			problems.push(`invoice ${id} (${numberTail(inv.invoice_number)}) carries an adjustment or a correction line the plan does not know, so its days may already be corrected`);
		}
	}
	for (const id of plan.knownAdjustments.keys()) if (!payers.has(id)) problems.push(`the plan knows an adjustment on invoice ${id}, which pays none of its days`);

	// The carrying invoice, and that it is where the difference goes.
	let carrier = null;
	let others = [];
	if (plan.carrier) {
		const c = db.prepare(`SELECT ${INVOICE_COLS} FROM invoices WHERE id = ?`).get(plan.carrier.id) || null;
		if (!c || c.deleted_at) problems.push(`the carrying invoice ${plan.carrier.id} does not exist or is deleted`);
		else if (!mine(c.driver)) problems.push(`the carrying invoice ${plan.carrier.id} is not driver ${plan.driver}'s`);
		else {
			const state = sideState(centsOf(c.adjustment), String(c.adjustment_note || ""), plan.carrier);
			const file = String(c.pdf_file_name || "");
			carrier = { id: c.id, number: numberTail(c.invoice_number), status: c.status, week: `${c.week_start}..${c.week_end}`, file, adjustmentBefore: centsOf(c.adjustment), adjustedBy: c.adjusted_by || "", adjustedAt: c.adjusted_at || "", note: String(c.adjustment_note || ""), totalDue: api.invoiceTotalDue(c), state, driverName: c.driver };
			if (Number(c.is_manual)) problems.push(`the carrying invoice ${c.id} is a manual invoice, not a weekly one`);
			if (c.status !== "Submitted") problems.push(`the carrying invoice ${c.id} is ${c.status}, not Submitted`);
			if (!api.personalSnapshotOf(c) || !file) problems.push(`the carrying invoice ${c.id} has no render data or no PDF to redraw`);
			if (file && db.prepare("SELECT 1 FROM invoices WHERE pdf_file_name = ? COLLATE NOCASE AND id != ?").get(file, c.id)) problems.push(`the carrying invoice ${c.id}'s PDF is another invoice's file too`);
			const lock = api.invoiceMonthLockBlockers(c);
			if (lock.unreadable || lock.blockers.length) problems.push(`the carrying invoice ${c.id}'s week touches a closed month (or the locks can't be read)`);
			if (centsOf(c.personal_total) || centsOf(c.personal_share_total) || centsOf(c.correction_lines_total) || api.personalRowsOnInvoice(c.id).length || api.correctionLinesOnInvoice(c.id).length) {
				problems.push(`the carrying invoice ${c.id} carries a Personal or correction line, which an adjustment can move: not planned`);
			}
			if (!state) problems.push(`the carrying invoice ${c.id} carries ${usd(centsOf(c.adjustment))} with a note this plan did not write (neither its before nor its after)`);
			if (state === "to-write" && Math.round((api.invoiceTotalDue(c) - c.adjustment) * 100) + plan.carrier.after.cents < 0) problems.push(`the adjustment would take the carrying invoice ${c.id} below $0`);
			// Where the difference goes: the app's own pick after the corrected weeks, or
			// the one open invoice whose own days move.
			const sources = [...new Set(plan.days.filter((d) => d.invoiceId != null && d.setCents !== d.paidCents).map((d) => d.invoiceId))].map((id) => byId.get(id)).filter(Boolean);
			if (sources.length && sources.every((s) => LOCKED_STATUSES.has(s.status))) {
				const lastWeek = sources.map((s) => s.week_end).sort().pop();
				const pick = api.personalOpenInvoicesFrom(c.driver, dayAfter(lastWeek))[0] || null;
				if (!pick || pick.id !== c.id) problems.push(`the driver's next open weekly invoice after ${lastWeek} is ${pick ? `${pick.id} (${numberTail(pick.invoice_number)}, ${pick.status})` : "none"}, not the plan's ${c.id}`);
			} else if (!(sources.length === 1 && sources[0].id === c.id)) {
				problems.push(`the days to correct are on ${sources.map((s) => `${s.id} (${s.status})`).join(", ") || "no invoice"}: neither all locked (the next invoice carries them) nor the carrying invoice's own`);
			}
			// The same difference posted already, by hand, somewhere the checks above don't
			// look: another invoice of his carrying money the plan doesn't acknowledge, or
			// a correction line of his waiting for an invoice.
			others = otherInvoices({ api, db, plan, mine, payers });
			for (const o of others) {
				const ack = plan.acknowledged.get(o.id);
				if (ack !== o.fingerprint) {
					problems.push(`invoice ${o.id} (${o.number}, ${o.status}, week ${o.week}) carries ${o.text}${ack ? ", not what the plan acknowledged" : ""}: it may be this difference, posted already. If a person has read it and it is not, the plan acknowledges it as { "invoice": ${o.id}, "fingerprint": "${o.fingerprint}" }`);
				}
			}
			for (const id of plan.acknowledged.keys()) if (!others.some((o) => o.id === id)) problems.push(`the plan acknowledges invoice ${id}, which carries nothing of his from ${first} on`);
			for (const l of api.correctionWaitingLines(c.driver)) problems.push(`correction line ${l.id} (${l.kind}, ${usd(l.cents)}, to ${numberTail(l.source_invoice_number)}) waits for his next invoice: it may be this difference; not planned`);
		}
	}
	return { problems, payout, carrier, days, others, mine, payers };
}

// What the payout code must show before a write.
function ledgerChecks(plan, L) {
	const problems = [];
	if (!L.known || L.payable === null) problems.push(`the payout code has no ${plan.period} for owner ${plan.ownerId}`);
	if (L.splitPct !== plan.splitPct) problems.push(`owner ${plan.ownerId}'s split is ${L.splitPct}%, not the plan's ${plan.splitPct}%`);
	if (L.lease) problems.push(`owner ${plan.ownerId}'s ${plan.period} is paid as a lease, not the split`);
	const planned = new Set(plan.days.map((d) => d.day));
	for (const d of plan.days) {
		const items = L.days.get(d.day) || [];
		const counted = `the payout code counts it ${items.length} time(s)${items.length ? ` at ${items.map((x) => usd(x.cents)).join(", ")}` : ""} for driver ${plan.driver} in owner ${plan.ownerId}'s ${plan.period}`;
		if (d.ledgerCents === null) {
			if (items.length) problems.push(`${d.day}: ${counted}, though the plan says that month does not count it`);
		} else if (items.length !== 1 || items[0].cents !== d.ledgerCents || items[0].payType !== "fixed") {
			problems.push(`${d.day}: ${counted}, not once at ${usd(d.ledgerCents)}`);
		}
	}
	const extra = [...L.days.keys()].filter((k) => !planned.has(k)).sort();
	if (extra.length) problems.push(`the payout code counts driver ${plan.driver} on ${extra.join(", ")} in owner ${plan.ownerId}'s ${plan.period} too, which the plan does not list`);
	if (!problems.length) {
		if (L.replayPayable === null || L.replayPayable - L.payable !== plan.shareDollars) {
			problems.push(`with the days at their set figures the payout code moves owner ${plan.ownerId}'s ${plan.period} by ${L.replayPayable === null ? "nothing it can show" : dollars(L.replayPayable - L.payable)}, not the plan's ${dollars(plan.shareDollars)}`);
		}
		const effective = L.payable + plan.payout.after.cents / 100;
		if (effective !== plan.expectedEffective) problems.push(`owner ${plan.ownerId}'s ${plan.period} would read ${dollars(effective)} (the payout code's ${dollars(L.payable)} plus the ${dollars(plan.payout.after.cents / 100)} adjustment), not the plan's expected ${dollars(plan.expectedEffective)}`);
	}
	return problems;
}

// The investor's closed-month rows, the history beside them and the month locks, hashed.
function closedRowsPrint(db, ownerId) {
	const locked = db.prepare("SELECT period FROM period_locks WHERE status = 'locked'").all().map((r) => r.period);
	const ph = locked.map(() => "?").join(",") || "''";
	const rows = db.prepare(`SELECT * FROM investor_payouts WHERE owner_id = ? AND period IN (${ph}) ORDER BY id`).all(ownerId, ...locked);
	const hist = db.prepare(`SELECT * FROM investor_payout_history WHERE owner_id = ? AND period IN (${ph}) ORDER BY id`).all(ownerId, ...locked);
	const locks = db.prepare("SELECT * FROM period_locks ORDER BY period").all();
	return { months: locked.length, rows: rows.length, hash: crypto.createHash("sha256").update(JSON.stringify([rows, hist, locks])).digest("hex").slice(0, 16) };
}

// The rows a write changes, each column with its before and after.
function plannedWrites(plan, d, rows) {
	const out = [];
	for (const e of rows.filter((x) => x.state === "to-write")) {
		e.columns.forEach((col, k) => out.push({ table: TAB, id: `row ${e.rowIndex} (load ${e.load})`, column: ROW_COLUMNS[k], before: e.before[k], after: e.after[k] }));
		out.push({ table: "audit_trail", id: "new", column: "row", before: "", after: `update_sheet_row, sheet_row ${TAB}!${e.rowIndex}, the route's details (each cell's before and after)` });
	}
	if (d.carrier && d.carrier.state === "to-write") {
		const id = d.carrier.id;
		out.push(
			{ table: "invoices", id, column: "adjustment", before: usd(plan.carrier.before.cents), after: usd(plan.carrier.after.cents) },
			{ table: "invoices", id, column: "adjustment_note", before: plan.carrier.before.note, after: plan.carrier.after.note },
			{ table: "invoices", id, column: "adjusted_by", before: d.carrier.adjustedBy, after: ACTOR },
			{ table: "invoices", id, column: "adjusted_at", before: d.carrier.adjustedAt, after: "the run's time" },
			{ file: `invoice ${id}'s own PDF in ${path.join("uploads", "invoices")}`, change: "redrawn from the invoice's stored render data with the new adjustment (the route's own render)" },
			{ table: "audit_trail", id: "new", column: "row", before: "", after: `adjust_invoice, invoice ${id}: adjustment ${(plan.carrier.before.cents / 100).toFixed(2)} → ${(plan.carrier.after.cents / 100).toFixed(2)} (the note)` },
		);
	}
	if (d.payout && d.payout.state === "to-write") {
		const id = d.payout.id;
		const amount = Number(d.payout.amount || 0);
		out.push(
			{ table: "investor_payouts", id, column: "adjustment", before: plan.payout.before.cents / 100, after: plan.payout.after.cents / 100 },
			{ table: "investor_payouts", id, column: "adjustment_note", before: plan.payout.before.note, after: plan.payout.after.note },
			{ table: "investor_payouts", id, column: "adjusted_by", before: d.payout.adjustedBy, after: ACTOR },
			{ table: "investor_payouts", id, column: "adjusted_at", before: d.payout.adjustedAt, after: "the run's time" },
			{ table: "investor_payout_history", id: "new", column: "row", before: "", after: `kind adjustment, old ${amount + plan.payout.before.cents / 100}, new ${amount + plan.payout.after.cents / 100} (the stored amount plus each adjustment), detail "adjustment: " and the note` },
			{ table: "audit_trail", id: "new", column: "row", before: "", after: `investor_payout_adjust, investor_payout ${id}: owner ${plan.ownerId} ${plan.period}: adjustment ${(plan.payout.before.cents / 100).toFixed(2)} -> ${(plan.payout.after.cents / 100).toFixed(2)} (the note)` },
		);
	}
	return out;
}

// One route called as a Super Admin's screen calls it, as the system actor.
async function callRoute(handler, id, body) {
	const out = { status: 200, body: null };
	const res = { status(code) { out.status = code; return res; }, json(b) { out.body = b; return res; } };
	await handler({ params: { id: String(id) }, body, session: { user: { ...SYSTEM_USER } }, headers: {}, query: {} }, res);
	return out;
}

// ── the run ─────────────────────────────────────────────────────────────────

// `opts` (tests): sheets (a Sheets client), nowMs (the lifted code's clock), roots
// (what to lift), render (in place of the app's renderer), log / err (output).
async function main(argv = process.argv.slice(2), opts = {}) {
	const say = opts.log || ((s) => console.log(s));
	const warn = opts.err || ((s) => console.error(s));
	const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : null;
	const stamp = () => (nowMs === null ? new Date() : new Date(nowMs)).toISOString();
	const result = { script: SCRIPT_NAME, mode: "", path: "", startedAt: stamp(), finishedAt: "", outcome: "refused", problems: [], driver: "", rows: [], days: [], others: [], payout: null, carrier: null, ledger: null, writes: [], closedMonths: null, counts: {} };
	let resultFile = null;
	const dbs = [];
	let api = null;
	const save = () => { if (resultFile) writeResult(resultFile, { ...result, finishedAt: stamp() }); };
	const done = (code) => {
		try { save(); } catch (err) { warn(`ERROR: the result file could not be written (${err.message})`); return code === 2 ? 2 : 1; }
		return code;
	};
	// "check" (nothing written yet), "write", then "read-back" (every write made).
	let phase = "check";
	try {
		const args = parseArgs(argv);
		result.mode = args.apply ? "apply" : "dry-run";
		result.path = args.path;
		resultFile = resultPath(args.result);
		const plan = readPlanFile(args.plan);
		if (plan.path !== args.path) throw new Refusal(`the plan is a ${plan.path} plan, not ${args.path}`);
		result.driver = plan.driver;
		if (String(process.env.LOCAL_REPLICA || "").trim()) throw new Refusal("LOCAL_REPLICA is set: a replica's files are not the app's, and this script runs on the app or a copy only");
		if (plan.rows.length && args.apply && args.valuesJson) throw new Refusal("the plan moves rows, which are written to the sheet itself: --values-json is for a dry run of such a plan");
		let scope;
		let dbFile;
		try { ({ scope, file: dbFile } = dbScope(args.db, ROOT)); } catch (err) { throw new Refusal(err.message); }
		if (!fs.existsSync(dbFile)) throw new Refusal(`--db names no file: ${clip(args.db)}`);
		if (scope === "app" && (args.valuesJson || args.settingsFile || args.dataDir)) throw new Refusal("the app's own database runs with the app's own sheet, settings and files: --values-json, --settings-file and --data-dir are for a copy only");
		if (scope === "copy" && !args.settingsFile) throw new Refusal("a copy runs with the settings named: --settings-file=<…> is required with a copy");
		const settingsFile = args.settingsFile ? outsideRepo(args.settingsFile, "--settings-file") : null;
		let env;
		try { env = envFor({ root: ROOT, dbPath: args.db, envFile: settingsFile }).env; } catch (err) { throw new Refusal(err.message); }
		if (scope === "app" && ownSheetId(env, ROOT) !== args.sheetId) throw new Refusal("--sheet-id is not this app's own sheet: the database and the sheet must be one app's");
		let dataDir = ROOT;
		if (scope === "copy") {
			dataDir = args.dataDir ? outsideRepo(args.dataDir, "--data-dir") : path.dirname(dbFile);
			if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) throw new Refusal(`--data-dir is not a folder: ${clip(dataDir)}`);
		}
		const roDb = openDb({ root: ROOT, dbFile, readonly: true });
		dbs.push(roDb);
		if (!roDb.readonly) throw new Refusal("the read-only handle on the database is not read-only");
		const rwDb = args.apply ? openDb({ root: ROOT, dbFile, readonly: false }) : null;
		if (rwDb) dbs.push(rwDb);
		api = liftServer({ db: rwDb || roDb, env, nowMs, dataDir, sheetId: args.sheetId, render: opts.render || null, roots: opts.roots || ROOTS });
		const sheets = args.valuesJson ? null : (opts.sheets || await googleSheets({ keyFile: api.KEY_FILE, write: Boolean(plan.rows.length && args.apply) }));
		const readValues = async () => (args.valuesJson ? readValuesFile(args.valuesJson) : readTab(sheets, args.sheetId));
		const values = await readValues();

		say(`Data fix ${SCRIPT_NAME} (${plan.path}): driver ${plan.driver}'s ${plan.days.length} day(s) in owner ${plan.ownerId}'s ${plan.period}${plan.rows.length ? `, after ${plan.rows.length} row(s) move to owner ${plan.ownerId}` : ""}. Mode: ${args.apply ? "apply" : "dry run (nothing is written)"}.`);
		say(`  database ${dbFile} (${rwDb ? "opened for writing" : "opened read-only"}); sheet ${args.sheetId || `saved values ${args.valuesJson}`} (${plan.rows.length && args.apply ? "read and written" : "read-only"})`);
		// The rows first: the payout code's checks read the tab as the run will leave it.
		const facts = sheetFacts(values);
		const problems = [];
		if (plan.rows.length && sheets) {
			const target = await api.resolveSheetTargetForWrite(sheets, TAB);
			if (!target.resolved || !target.guarded || target.title !== TAB) problems.push(`the sheet has no ${TAB} tab the closed-month guard covers`);
		}
		const rc = rowChecks({ api, db: roDb, plan, facts });
		problems.push(...rc.problems);
		result.rows = rc.entries.map((e) => ({ load: e.load, row: e.rowIndex, before: e.before, after: e.after, state: e.state }));
		const d = dbChecks({ api, db: roDb, plan });
		problems.push(...d.problems);
		result.days = d.days;
		result.others = d.others.map((o) => ({ ...o, acknowledged: plan.acknowledged.get(o.id) === o.fingerprint }));
		result.payout = d.payout ? { id: d.payout.id, owner: plan.ownerId, period: plan.period, status: d.payout.status, finalized: d.payout.finalized, adjustmentBefore: d.payout.adjustmentBefore, adjustment: plan.payout.after.cents / 100, state: d.payout.state } : null;
		result.carrier = d.carrier ? { id: d.carrier.id, number: d.carrier.number, status: d.carrier.status, week: d.carrier.week, adjustmentBefore: usd(d.carrier.adjustmentBefore), adjustment: usd(plan.carrier.after.cents), totalDueBefore: d.carrier.totalDue, state: d.carrier.state } : null;
		const ctx = { dbPath: args.db, settingsFile, nowMs, roDb };
		let L = null;
		if (!problems.length) {
			L = await ownerLedger(moneyWorld(ctx, valuesAfter(values, rc.entries)), plan);
			problems.push(...ledgerChecks(plan, L));
		}
		if (problems.length) {
			result.problems = problems;
			for (const p of problems) warn(`  REFUSED: ${p}`);
			warn(`REFUSED: ${problems.length} check(s) failed; nothing was written.`);
			return done(2);
		}
		const effectiveAfter = L.payable + plan.payout.after.cents / 100;
		result.ledger = { owner: plan.ownerId, period: plan.period, splitPct: L.splitPct, recomputed: L.payable, replayedAtSet: L.replayPayable, adjustment: plan.payout.after.cents / 100, effectiveAfter, expected: plan.expectedEffective, months: L.months };
		const closedBefore = closedRowsPrint(roDb, plan.ownerId);
		result.closedMonths = { before: closedBefore };
		result.writes = plannedWrites(plan, d, rc.entries);
		const rowsToWrite = rc.entries.filter((e) => e.state === "to-write");
		const toCarrier = Boolean(d.carrier && d.carrier.state === "to-write");
		const toPayout = Boolean(d.payout && d.payout.state === "to-write");
		result.counts = { daysPlanned: plan.days.length, rowsToWrite: rowsToWrite.length, carrierToWrite: toCarrier ? 1 : 0, payoutToWrite: toPayout ? 1 : 0, rowsWritten: 0, carrierWritten: 0, payoutWritten: 0, auditRows: 0, renders: 0 };

		for (const e of rc.entries) say(`  row ${e.rowIndex} (load ${e.load}): ${ROW_COLUMNS.map((c, k) => `${c} ${JSON.stringify(e.before[k])} -> ${JSON.stringify(e.after[k])}`).join(", ")} (${e.state})`);
		if (plan.rows.length && !sheets) say("  (saved values: the tab's closed-month guard cover is read on the sheet itself, not here)");
		say(`  ${plan.period} is open; payout row ${d.payout.id}: ${d.payout.status}, not finalized, adjustment ${dollars(d.payout.adjustmentBefore)} (${d.payout.state})`);
		for (const x of d.days) say(`  ${x.day}: ${x.ledger === null ? `not in owner ${plan.ownerId}'s ${plan.period}` : `the payout code ${x.ledger}`}, set ${x.set}; ${x.invoice == null ? "on no invoice" : `invoice ${x.invoice} paid ${x.paid}`}`);
		say(`  owner ${plan.ownerId}'s ${plan.period}, by the payout code${plan.rows.length ? " with the rows moved" : ""}: ${dollars(L.payable)}; with the days at their set figures ${dollars(L.replayPayable)} (${dollars(L.replayPayable - L.payable)}, as planned)`);
		say(`  the payout adjustment ${dollars(plan.payout.before.cents / 100)} -> ${dollars(plan.payout.after.cents / 100)}: owner ${plan.ownerId}'s ${plan.period} reads ${dollars(effectiveAfter)} (expected ${dollars(plan.expectedEffective)}: matches)`);
		if (d.carrier) say(`  the driver: ${usd(plan.driverMoveCents)} on invoice ${d.carrier.id} (${d.carrier.number}, ${d.carrier.status}, week ${d.carrier.week}), adjustment ${usd(plan.carrier.before.cents)} -> ${usd(plan.carrier.after.cents)} (${d.carrier.state}); total due ${usd(Math.round(d.carrier.totalDue * 100))} -> ${usd(Math.round(d.carrier.totalDue * 100) - d.carrier.adjustmentBefore + plan.carrier.after.cents)}`);
		else say("  the driver: no invoice changes");
		if (plan.carrier) say(`  his other invoices from ${plan.days[0].day} on that carry money: ${d.others.length ? d.others.map((o) => `${o.id} (${o.number}, ${o.status}): ${o.text}; fingerprint ${o.fingerprint}, acknowledged`).join(" | ") : "none"}`);
		say(`  closed months: ${closedBefore.months} locked, owner ${plan.ownerId}'s ${closedBefore.rows} closed-month payout row(s) (fingerprint ${closedBefore.hash}); this run writes none of them`);
		for (const w of result.writes) say(w.file ? `  WRITE file ${w.file}: ${w.change}` : `  WRITE ${w.table} ${w.id} ${w.column}: ${JSON.stringify(w.before)} -> ${JSON.stringify(w.after)}`);
		const anything = Boolean(rowsToWrite.length || toCarrier || toPayout);
		if (!args.apply) {
			result.outcome = anything ? "would-write" : "already-done";
			say(anything ? `Would write: ${[rowsToWrite.length ? `${rowsToWrite.length} row(s) to owner ${plan.ownerId}` : "", toCarrier ? "the carrying invoice's adjustment (and its PDF)" : "", toPayout ? "the payout adjustment" : ""].filter(Boolean).join(", then ")}, each with its route's rows. Nothing was written.` : "Everything is already done. Nothing was written.");
			return done(0);
		}

		phase = "write";
		const auditFloor = (roDb.prepare("SELECT MAX(id) AS n FROM audit_trail").get() || {}).n || 0;
		const historyFloor = (roDb.prepare("SELECT MAX(id) AS n FROM investor_payout_history").get() || {}).n || 0;
		const countAudits = () => roDb.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE id > ? AND user_id = 0 AND username = ? AND role = 'system'").get(auditFloor, ACTOR).n;
		const progress = () => { result.counts = { ...result.counts, auditRows: countAudits(), renders: api.renders() }; save(); };
		for (const e of rowsToWrite) {
			const slot = result.rows.find((x) => x.load === e.load);
			const w = await writeRow({ api, sheets, sheetId: args.sheetId, entry: e, planHeaders: facts.headers });
			slot.state = w.state;
			if (w.code) slot.code = w.code;
			if (w.why) slot.why = clip(w.why);
			if (w.state === "written") result.counts.rowsWritten++;
			progress();
			say(`  row ${e.rowIndex} (load ${e.load}): ${w.state}${w.code ? ` (${w.code}${w.why ? `: ${clip(w.why)}` : ""})` : ""}`);
			if (w.state !== "written") {
				result.outcome = "partial";
				result.problems.push(`load ${e.load}: ${w.state}${w.code ? ` (${w.code})` : ""}; the run stopped there. Run it again to carry on (a row at its after values is already done).`);
				warn(`STOPPED: load ${e.load} was ${w.state}; ${result.counts.rowsWritten} row(s) written before it. Each row's state is in the result file.`);
				return done(1);
			}
		}
		// Each row is read again just before its write: a change a person made since
		// the checks stops the run, so the route never writes over it.
		const stillToWrite = (sql, id, side) => {
			const r = roDb.prepare(sql).get(id);
			return Boolean(r) && sideState(centsOf(r.adjustment), String(r.adjustment_note || ""), side) === "to-write";
		};
		const changed = (slot, what) => {
			slot.state = "not-written";
			result.outcome = "partial";
			result.problems.push(`${what} changed since the checks; nothing was written for it. Run it again.`);
			progress();
			warn(`STOPPED: ${what} changed since the checks; nothing was written for it.`);
			return done(1);
		};
		if (toCarrier) {
			if (!stillToWrite("SELECT adjustment, adjustment_note FROM invoices WHERE id = ? AND deleted_at = '' AND status = 'Submitted'", d.carrier.id, plan.carrier)) return changed(result.carrier, `invoice ${d.carrier.id}`);
			const othersNow = otherInvoices({ api, db: roDb, plan, mine: d.mine, payers: d.payers });
			if (JSON.stringify(othersNow.map((o) => [o.id, o.fingerprint])) !== JSON.stringify(d.others.map((o) => [o.id, o.fingerprint])) || api.correctionWaitingLines(d.carrier.driverName).length) {
				return changed(result.carrier, "his other invoices or his waiting correction lines");
			}
			const a = await callRoute(api.adjustInvoice, d.carrier.id, { adjustment: plan.carrier.after.cents / 100, adjustmentNote: plan.carrier.after.note });
			const inv = a.body && a.body.invoice;
			const ok = a.status === 200 && a.body && a.body.success === true && inv && centsOf(inv.adjustment) === plan.carrier.after.cents && inv.adjustment_note === plan.carrier.after.note;
			result.carrier.state = ok ? "written" : "failed";
			if (!ok) result.carrier.answer = { status: a.status, error: clip((a.body && (a.body.error || a.body.code)) || "") };
			else result.counts.carrierWritten = 1;
			progress();
			say(`  invoice ${d.carrier.id}'s adjustment: ${ok ? `written (${usd(plan.carrier.after.cents)}), its PDF redrawn (${a.body.pdfMode})` : `not written (${a.status}: ${clip((a.body && a.body.error) || "")})`}`);
			if (!ok) {
				result.outcome = "partial";
				result.problems.push(`the carrying invoice's adjustment was not written (${a.status})${rowsToWrite.length ? "; the rows are" : "; nothing else was"}. Run it again to carry on.`);
				return done(1);
			}
		}
		if (toPayout) {
			if (!stillToWrite("SELECT adjustment, adjustment_note FROM investor_payouts WHERE id = ? AND status = 'owed' AND COALESCE(finalized_at, '') = ''", d.payout.id, plan.payout)) return changed(result.payout, `payout row ${d.payout.id}`);
			const a = await callRoute(api.adjustPayout, d.payout.id, { adjustment: plan.payout.after.cents / 100, adjustmentNote: plan.payout.after.note });
			const p = a.body && a.body.payout;
			const ok = a.status === 200 && a.body && a.body.success === true && p && Number(p.adjustment) === plan.payout.after.cents / 100 && p.adjustment_note === plan.payout.after.note;
			result.payout.state = ok ? "written" : "failed";
			if (!ok) result.payout.answer = { status: a.status, error: clip((a.body && (a.body.error || a.body.code)) || "") };
			else result.counts.payoutWritten = 1;
			progress();
			say(`  owner ${plan.ownerId}'s ${plan.period} adjustment: ${ok ? `written (${dollars(plan.payout.after.cents / 100)})` : `not written (${a.status}: ${clip((a.body && a.body.error) || "")})`}`);
			if (!ok) {
				result.outcome = "partial";
				result.problems.push(`the payout adjustment was not written (${a.status})${rowsToWrite.length || toCarrier ? "; the earlier writes are" : ""}. Run it again to carry on.`);
				return done(1);
			}
		}
		result.outcome = anything ? "written" : "already-done";
		phase = "read-back";

		// The read back: the rows, both adjustment rows and the routes' own rows, the
		// closed months' rows, and the payout code.
		const unconfirmed = [];
		const back = await readValues();
		const f2 = sheetFacts(back);
		for (const e of rc.entries) {
			const hit = f2.data.find((x) => x.rowIndex === e.rowIndex);
			const okRow = Boolean(hit) && normalizeLoadId(hit.cells[f2.loadCol]) === e.key && e.after.every((v, k) => cellText(hit.cells[f2.cols.get(ROW_COLUMNS[k])]) === v);
			result.rows.find((x) => x.load === e.load).readBack = okRow ? "ok" : "differs";
			if (!okRow) unconfirmed.push(`row ${e.rowIndex} (load ${e.load}) does not read back with the plan's after values`);
		}
		const prow = roDb.prepare("SELECT * FROM investor_payouts WHERE id = ?").get(d.payout.id);
		if (!prow || Number(prow.adjustment || 0) !== plan.payout.after.cents / 100 || String(prow.adjustment_note || "") !== plan.payout.after.note) unconfirmed.push("the payout row does not read back with the plan's adjustment and note");
		if (plan.carrier) {
			const crow = roDb.prepare(`SELECT ${INVOICE_COLS} FROM invoices WHERE id = ?`).get(d.carrier.id);
			if (!crow || centsOf(crow.adjustment) !== plan.carrier.after.cents || String(crow.adjustment_note || "") !== plan.carrier.after.note) unconfirmed.push("the carrying invoice does not read back with the plan's adjustment and note");
			else result.carrier.totalDueAfter = api.invoiceTotalDue(crow);
		}
		// The routes record their own rows and swallow a failed insert: each write's audit row, and the payout's history row.
		const wrote = result.counts.rowsWritten + result.counts.carrierWritten + result.counts.payoutWritten;
		const audits = countAudits();
		if (audits !== wrote) unconfirmed.push(`the routes' audit rows read back ${audits}, not one for each of the ${wrote} write(s)`);
		if (result.counts.payoutWritten) {
			const h = roDb.prepare("SELECT COUNT(*) AS n FROM investor_payout_history WHERE id > ? AND payout_id = ? AND kind = 'adjustment' AND actor = ?").get(historyFloor, d.payout.id, ACTOR).n;
			if (h !== 1) unconfirmed.push(`the payout row's history row reads back ${h} time(s), not once`);
		}
		const closedAfter = closedRowsPrint(roDb, plan.ownerId);
		result.closedMonths.after = closedAfter;
		if (closedAfter.hash !== closedBefore.hash) unconfirmed.push(`owner ${plan.ownerId}'s closed-month rows changed during the run`);
		const L2 = await ownerLedger(moneyWorld(ctx, back), plan);
		const storedAdjustment = prow ? Number(prow.adjustment || 0) : 0;
		const effective = L2.payable + storedAdjustment;
		const movedMonths = L2.months.filter((m) => m.month < plan.period).filter((m) => { const b = L.months.find((x) => x.month === m.month); return !b || b.net !== m.net || b.payable !== m.payable; }).map((m) => m.month);
		Object.assign(result.ledger, { recomputedReadBack: L2.payable, storedAmount: prow ? prow.amount : null, storedAdjustment, effectiveReadBack: effective, difference: effective - plan.expectedEffective, earlierMonthsMoved: movedMonths });
		result.counts = { ...result.counts, auditRows: audits, renders: api.renders() };
		say(`  read back: ${rc.entries.length ? `${rc.entries.filter((e) => result.rows.find((x) => x.load === e.load).readBack === "ok").length} of ${rc.entries.length} row(s) at their after values; ` : ""}the payout row's adjustment ${dollars(storedAdjustment)}${plan.carrier ? `; invoice ${d.carrier.id}'s ${usd(plan.carrier.after.cents)}, total due ${usd(Math.round((result.carrier.totalDueAfter || 0) * 100))}` : ""}; ${audits} audit row(s)`);
		say(`  owner ${plan.ownerId}'s ${plan.period}: the payout code recomputes ${dollars(L2.payable)}; with the adjustment ${dollars(effective)} (expected ${dollars(plan.expectedEffective)}: ${effective === plan.expectedEffective ? "matches" : `differs by ${dollars(effective - plan.expectedEffective)}`})`);
		say(`  the months before ${plan.period}: ${movedMonths.length ? `${movedMonths.join(", ")} moved during the run (not by its writes: the closed-month guard keeps a moved row in open months)` : "as before the run"}; the closed-month rows: ${closedAfter.hash === closedBefore.hash ? "as they were" : "CHANGED"}`);
		if (unconfirmed.length) {
			result.outcome = "unconfirmed";
			result.problems.push(...unconfirmed);
			for (const u of unconfirmed) warn(`  READ BACK: ${u}`);
			return done(1);
		}
		say(`Written: ${result.counts.rowsWritten} row(s) and ${result.counts.carrierWritten + result.counts.payoutWritten} adjustment(s); ${audits} audit row(s).${anything ? "" : " Everything was already done."}`);
		return done(effective === plan.expectedEffective ? 0 : 3);
	} catch (err) {
		if (err instanceof Refusal && phase === "check") {
			result.outcome = "refused";
			result.problems.push(err.message);
			warn(`REFUSED: ${err.message}`);
			return done(2);
		}
		result.outcome = { check: "error", write: "partial", "read-back": "unconfirmed" }[phase];
		result.problems.push(clip(String((err && err.message) || err)));
		warn(`ERROR: ${(err && (err.stack || err.message)) || err}`);
		return done(1);
	} finally {
		for (const h of dbs) { try { h.close(); } catch { /* already closed */ } }
		if (api && api.renders() && !opts.render) {
			try { await createRequire(path.join(ROOT, "server.js"))("./lib/pdf-browser").shutdownBrowser(); } catch { /* no browser was started */ }
		}
	}
}

if (require.main === module) {
	main().then((code) => { process.exitCode = code; });
}

module.exports = {
	ACTOR, ROOTS, PROVIDED, DENIED, HEADS, OPTIONS, PATHS, ROW_COLUMNS,
	parseArgs, parsePlan, liftServer, googleSheets, driverTag, numberTail, invoicePays, carriedBy, fingerprintOf, main, Refusal,
};
