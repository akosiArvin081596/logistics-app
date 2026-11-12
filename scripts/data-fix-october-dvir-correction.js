#!/usr/bin/env node
// scripts/data-fix-october-dvir-correction.js — a one-time data fix: sets the Job
// Tracking Payment of the planned loads back to their invoiced figures, then posts
// the investor's share of the loads whose Payment a closed month keeps as an
// adjustment on the investor's payout row for the month.
//
// The loads, the figures and the adjustment's reason are not in this file (the
// repository is public). They come from a private plan, --plan=<json>, and each
// figure in it is checked against the sheet and the database before anything is
// written:
//   - each planned load's Payment is exactly the plan's "now" figure, and its "set"
//     figure is its last invoice row's total; a load planned by its gap ("under")
//     shows exactly that gap under its last invoice row's total;
//   - each adjust-only load shows exactly its gap under its last invoice row;
//   - the payout code (lifted from server.js, as the payout dry runs run it) counts
//     every one of them in the investor's month at that Payment, at the plan's
//     split, and moves the month by the plan's payoutDelta once the Payments are
//     set; the adjustment is the adjust-only gaps' share in whole dollars;
//   - every save would pass PUT /api/data/:rowIndex's own checks, the closed-month
//     guard included; the month is open; the investor's payout row for it exists,
//     is owed, is not finalized and carries no other adjustment.
// Any one of them failing, nothing is written (exit 2).
//
// What it writes, through the app's own code, in this order:
//   1. each planned Payment cell, as PUT /api/data/:rowIndex (Data Manager's save)
//      writes one: the route's own functions, lifted at run time from this
//      checkout's server.js, called in the route's order: the row read, the Load ID
//      binding (rowMovedRefusal()), the Owner ID, contact and driver checks, the
//      closed-month guard (sheetRowUpdateBlocker()), the re-read just before the
//      write (SHEET_CHANGED), the one-cell write (sheetRowCellWrites(),
//      USER_ENTERED) and the route's audit row (update_sheet_row, with the cell's
//      before and after); a refusal at write time is audited as the route audits it;
//   2. then the adjustment, through PUT /api/investor/payouts/:id/adjust itself (its
//      handler, lifted at run time): whole dollars, a closed month refused, the
//      payout row, its history row and its audit row.
// Every write is a system change: user 0, this script's name, role "system". No
// other cell, row or figure is written; the payout row's amount is the app's to
// recompute (its next Payouts read, and again at the month's close).
//
// Then it reads back each Payment, the payout row, and the investor's month as
// the payout code recomputes it (read-only) plus the adjustment, against the
// plan's expected figure.
//
// Idempotent: a load at its invoiced figure is already done, and the plan's
// adjustment already on the row with its exact reason is already done, so a
// re-run finishes a run that stopped part way and a replay writes nothing. A save
// that fails, or a row that changes under the run, stops the run with each load's
// state in the result file.
//
// The Sheets key is the app's own: server.js's KEY_FILE, lifted with the rest,
// which the Google client reads relative to the folder it runs in, as the
// server's does. So the run must start in this app's folder (it refuses
// otherwise) and takes no key option. The key decides who the script is, not what
// it touches: the sheet and the database are always named, with no default.
//
// Usage (on the server, from the app's folder, with the Node pm2 runs it with):
//   node scripts/data-fix-october-dvir-correction.js --db=<app.db> --sheet-id=<id> --plan=<plan.json> --result=<result.json> [--dry-run]
//   node scripts/data-fix-october-dvir-correction.js --db=<app.db> --sheet-id=<id> --plan=<plan.json> --result=<result.json> --apply
//   --db        the app's database: this app folder's own, or a copy under the temp
//               directory (scripts/lib/ledger-world.js dbScope()); no default
//   --sheet-id  the Job Tracking book; with the app's own database it must be the
//               app's own sheet; no default
//   --plan      the private plan (JSON), outside the repository
//   --result    where the result goes (JSON, owner-only), outside the repository
//   --dry-run   the default: the database opened read-only, the sheet read with
//               the read-only scope, nothing written
// The app folder's .env is read as the payout dry runs read it (the payout code's
// settings and the app's own sheet); nothing from it is printed.
// Exit codes: 0 done (or already done) and read back as planned; 1 a write failed
// or did not read back (each load's state is in the result file; a re-run carries
// on); 2 refused, nothing written; 3 done, but the payout reads back other than
// the plan's expected figure (the gap is printed).
// Required as a module (by its test runner) it runs nothing and exports its parts.

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { closure, indexDeclarations, liftRoute } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");
const { buildLedgerWorld, dbScope, envFor, openDb } = require("./lib/ledger-world");
const { normalizeLoadId } = require("../lib/ratecon-load");
const sheetIds = require("../lib/sheet-id");
const autoInvoiceLedger = require("../lib/auto-invoice-ledger");
const { claimSent } = require("../lib/auto-invoice-send");

const ROOT = path.join(__dirname, "..");
const SCRIPT_NAME = "data-fix-october-dvir-correction";
const ACTOR = `script:${SCRIPT_NAME}`;
const SYSTEM_USER = Object.freeze({ id: 0, username: ACTOR, role: "system" });
const TAB = "Job Tracking";
const PLAN_KIND = "october-dvir-correction";
const OPTIONS = Object.freeze(["db", "sheet-id", "plan", "result", "dry-run", "apply"]);
const PLAN_MAX_BYTES = 64 * 1024;
const GOOGLE_TIMEOUT_MS = 60 * 1000;
const READ_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const ADJUST_HEAD = 'app.put("/api/investor/payouts/:id/adjust", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const ADJUST_ROUTE = "PUT /api/investor/payouts/:id/adjust";
// What the run lifts from server.js: the key path, PUT /api/data/:rowIndex's own
// steps (in the order the route runs them), and the adjust route's audit and lock
// functions. recordPayoutChange is named: the adjust route calls it on the line
// after a comment ending in ".", which server-lift's walk reads as a property access.
const ROOTS = Object.freeze([
	"KEY_FILE",
	"resolveSheetTargetForWrite", "a1SheetPrefix", "rowMovedRefusal", "restoreUntouchedCells", "validateOwnerIdCell", "brokerContact",
	"driverCellRefusal", "sheetRowAfterUpdate", "changedGuardedCells", "ROW_EDITOR_CANCEL_GUARD_ENABLED", "rowEditCancelRefusal",
	"sheetRowUpdateBlocker", "sheetRowCellWrites", "buildSheetUpdateAudit", "sheetAuditWithCode",
	"logAudit", "logAuditRefusal", "periodWriteLocked", "periodLocksReadable",
	"recordPayoutChange",
]);
const PROVIDED = Object.freeze(["db", "require", "console", "process", "Date", "app", "requireRole", "refuseCrossOrigin", "SPREADSHEET_ID"]);
const DENIED = Object.freeze(["getSheets", "sheets", "server", "io", "transporter", "getDrive", "sendEmail", "jtCacheInvalidate", "getJobTrackingCached", "fetch", "REPLICA"]);

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
	for (const [name, what] of [["db", "the app's database"], ["sheet-id", "the Job Tracking book"], ["plan", "the private plan file"], ["result", "where the result goes"]]) {
		if (!out[name]) throw new Refusal(`--${name}=<…> is required (${what}); there is no default`);
	}
	return { db: out.db, sheetId: out["sheet-id"], plan: out.plan, result: out.result, apply: out.apply === true };
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

function readPlanFile(p) {
	const file = outsideRepo(p, "--plan");
	let st;
	try { st = fs.statSync(file); } catch { throw new Refusal(`--plan names no file: ${clip(p)}`); }
	if (!st.isFile() || st.size > PLAN_MAX_BYTES) throw new Refusal(`--plan must be a plan file of at most ${PLAN_MAX_BYTES} bytes`);
	return parsePlan(fs.readFileSync(file, "utf8"));
}

// ── money as the sheet shows it ─────────────────────────────────────────────

// Cents of "$1,234.56", "1234.56", "1,234", "$321.09"; null for anything else.
function moneyCents(text) {
	const m = /^\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(String(text == null ? "" : text));
	if (!m) return null;
	return Number(m[1].replace(/,/g, "")) * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
}

// The figure in the cell's own style: a dollar sign and thousands commas when the
// cell shows them, so the audit's before and after read alike.
function moneyText(cents, like) {
	const s = String(like == null ? "" : like).trim();
	const dollarSign = s.startsWith("$");
	const whole = Math.floor(cents / 100);
	const grouped = dollarSign || s.includes(",") ? whole.toLocaleString("en-US") : String(whole);
	return `${dollarSign ? "$" : ""}${grouped}.${String(cents % 100).padStart(2, "0")}`;
}

const usd = (cents) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dollars = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US")}`;

// ── the plan ────────────────────────────────────────────────────────────────

const PLAN_FIELDS = new Set(["kind", "period", "ownerId", "splitPct", "payments", "adjustOnly", "revenueDelta", "payoutDelta", "adjustment", "reason", "expectedEffective"]);
const LOAD_RE = /^#?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function planCents(v, what) {
	if (typeof v !== "string" || !/^\d{1,7}\.\d{2}$/.test(v)) throw new Refusal(`the plan's ${what} must be an amount like "123.45"`);
	const [w, f] = v.split(".");
	const c = Number(w) * 100 + Number(f);
	if (c <= 0) throw new Refusal(`the plan's ${what} must be above zero`);
	return c;
}

// The plan, its own figures checked against each other. Throws Refusal.
function parsePlan(text) {
	let p;
	try { p = JSON.parse(text); } catch (err) { throw new Refusal(`the plan is not JSON (${err.message})`); }
	const fail = (why) => { throw new Refusal(`the plan ${why}`); };
	if (!p || typeof p !== "object" || Array.isArray(p)) fail("is not an object");
	const extra = Object.keys(p).filter((k) => !PLAN_FIELDS.has(k));
	if (extra.length) fail(`has unknown fields: ${extra.join(", ")}`);
	if (p.kind !== PLAN_KIND) fail(`is not a ${PLAN_KIND} plan (kind)`);
	if (typeof p.period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(p.period)) fail("names no month (period, YYYY-MM)");
	if (!Number.isInteger(p.ownerId) || p.ownerId <= 0) fail("names no investor (ownerId)");
	if (!Number.isInteger(p.splitPct) || p.splitPct < 1 || p.splitPct > 100) fail("names no split (splitPct, a whole percentage)");
	if (!Array.isArray(p.payments) || !p.payments.length || p.payments.length > 50) fail("lists no Payments to set (payments)");
	if (!Array.isArray(p.adjustOnly) || p.adjustOnly.length > 50) fail("has no adjustOnly list");
	const seen = new Set();
	const keyOf = (x, where) => {
		if (!x || typeof x !== "object" || typeof x.load !== "string" || !LOAD_RE.test(x.load)) fail(`has an entry in ${where} with no readable load`);
		const key = normalizeLoadId(x.load);
		if (seen.has(key)) fail(`names load ${x.load} twice`);
		seen.add(key);
		return key;
	};
	const payments = p.payments.map((x) => {
		const key = keyOf(x, "payments");
		const fields = Object.keys(x).sort().join(",");
		if (fields === "load,now,set") {
			const nowCents = planCents(x.now, `now figure of load ${x.load}`);
			const setCents = planCents(x.set, `set figure of load ${x.load}`);
			if (setCents <= nowCents) fail(`sets load ${x.load} to no more than it shows now`);
			return { load: x.load, key, nowCents, setCents, underCents: setCents - nowCents, byGap: false };
		}
		if (fields === "load,under") return { load: x.load, key, nowCents: null, setCents: null, underCents: planCents(x.under, `gap of load ${x.load}`), byGap: true };
		return fail(`entry for load ${x.load} must give now and set, or under`);
	});
	const adjustOnly = p.adjustOnly.map((x) => {
		const key = keyOf(x, "adjustOnly");
		if (Object.keys(x).sort().join(",") !== "load,under") fail(`adjustOnly entry for load ${x.load} must give under`);
		return { load: x.load, key, underCents: planCents(x.under, `gap of load ${x.load}`) };
	});
	const revenueCents = planCents(p.revenueDelta, "revenueDelta");
	const sumPaid = payments.reduce((s, x) => s + x.underCents, 0);
	if (sumPaid !== revenueCents) fail(`revenueDelta (${usd(revenueCents)}) is not the sum of its loads' gaps (${usd(sumPaid)})`);
	if (!Number.isInteger(p.payoutDelta) || p.payoutDelta !== Math.round((revenueCents * p.splitPct) / 10000)) fail(`payoutDelta is not ${p.splitPct}% of revenueDelta in whole dollars`);
	let adjustment = 0;
	let reason = "";
	if (adjustOnly.length) {
		const gaps = adjustOnly.reduce((s, x) => s + x.underCents, 0);
		const share = Math.round((gaps * p.splitPct) / 10000);
		if (!Number.isInteger(p.adjustment) || p.adjustment !== share) fail(`adjustment (${clip(p.adjustment)}) is not ${p.splitPct}% of the adjust-only gaps (${usd(gaps)}) in whole dollars (${share})`);
		if (p.adjustment < 1 || p.adjustment > 10000) fail("adjustment must be 1 to 10,000 whole dollars (the adjust route's cap)");
		if (typeof p.reason !== "string" || !p.reason || p.reason !== p.reason.trim() || p.reason.length > 500 || /[\u0000-\u001f\u007f]/.test(p.reason)) {
			fail("reason must be one trimmed line of at most 500 characters (the adjust route keeps 500)");
		}
		adjustment = p.adjustment;
		reason = p.reason;
	} else if (p.adjustment !== undefined || p.reason !== undefined) {
		fail("gives an adjustment but no adjust-only loads");
	}
	if (!Number.isInteger(p.expectedEffective) || p.expectedEffective < 0) fail("names no expected payout (expectedEffective, whole dollars)");
	return { period: p.period, ownerId: p.ownerId, splitPct: p.splitPct, payments, adjustOnly, revenueCents, payoutDelta: p.payoutDelta, adjustment, reason, expectedEffective: p.expectedEffective };
}

// ── the lift ────────────────────────────────────────────────────────────────

// The names a piece of code uses: every identifier outside comments, strings,
// regex literals and template text, except a property name after "." or "?.",
// with a template's ${…} read as code. It reads alone what server-lift's
// codeIdentifiers() misreads: a name on the line after a comment ending in "."
// (read there as a property), and the code after a template whose ${…} holds a
// regex with a quote in it.
const REGEX_AFTER_WORD = /^(return|typeof|case|in|of|new|delete|void|throw|else|do|yield|await|instanceof)$/;
function usedNames(text) {
	const names = new Set();
	let i = 0;
	const word = /[A-Za-z_$][\w$]*/y;
	const number = /[0-9][\w.]*/y;
	// From i: code until the end, or (inTemplate) until the "}" closing a ${.
	function code(inTemplate) {
		let prev = "";
		let depth = 0;
		while (i < text.length) {
			const ch = text[i];
			if (ch === "/" && text[i + 1] === "/") { const e = text.indexOf("\n", i); i = e === -1 ? text.length : e; continue; }
			if (ch === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e === -1 ? text.length : e + 2; continue; }
			if (/\s/.test(ch)) { i++; continue; }
			if (ch === '"' || ch === "'") {
				i++;
				while (i < text.length && text[i] !== ch && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
				i++;
				prev = "a";
				continue;
			}
			if (ch === "`") { template(); prev = "a"; continue; }
			if (ch === "/") {
				if (prev === "" || prev === "k" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev)) {
					i++;
					let inClass = false;
					while (i < text.length && text[i] !== "\n" && (inClass || text[i] !== "/")) {
						if (text[i] === "\\") { i += 2; continue; }
						if (text[i] === "[") inClass = true;
						else if (text[i] === "]") inClass = false;
						i++;
					}
					i++;
					while (/[a-z]/i.test(text[i] || "")) i++;
					prev = "a";
				} else {
					i++;
					prev = "/";
				}
				continue;
			}
			if (/[A-Za-z_$]/.test(ch)) {
				word.lastIndex = i;
				const w = word.exec(text)[0];
				if (prev !== ".") names.add(w);
				i += w.length;
				prev = REGEX_AFTER_WORD.test(w) ? "k" : "a";
				continue;
			}
			if (/[0-9]/.test(ch)) { number.lastIndex = i; i += number.exec(text)[0].length; prev = "a"; continue; }
			if (ch === "." && text[i + 1] === "." && text[i + 2] === ".") { i += 3; prev = ","; continue; }
			if (ch === "?" && text[i + 1] === "." && !/[0-9]/.test(text[i + 2] || "")) { i += 2; prev = "."; continue; }
			if (inTemplate && ch === "{") depth++;
			if (inTemplate && ch === "}") {
				if (depth === 0) { i++; return; }
				depth--;
			}
			prev = ch;
			i++;
		}
	}
	function template() {
		i++;
		while (i < text.length && text[i] !== "`") {
			if (text[i] === "\\") { i += 2; continue; }
			if (text[i] === "$" && text[i + 1] === "{") { i += 2; code(true); continue; }
			i++;
		}
		i++;
	}
	code(false);
	return names;
}

// The top-level names of server.js the lifted code uses that the lift leaves
// undefined, each lifted piece and route read on its own as closure() reads it.
// One missed throws only when its line runs, which can be after a write, so the
// run refuses first.
function unresolvedNames(src, lifted, provided = PROVIDED, routes = [ADJUST_HEAD]) {
	const { decls } = indexDeclarations(src);
	const pieces = new Set(lifted.names.map((n) => decls.get(n)).filter(Boolean));
	const have = new Set(provided);
	for (const d of pieces) for (const n of d.name.split(", ")) have.add(n);
	const used = new Set();
	for (const t of [...[...pieces].map((d) => d.text), ...routes.map((h) => liftRoute(src, h))]) for (const n of usedNames(t)) used.add(n);
	return [...used].filter((n) => decls.has(n) && !have.has(n)).sort();
}

const clockDate = (nowMs) => (nowMs === null || nowMs === undefined ? Date : class extends Date {
	constructor(...a) { super(...(a.length ? a : [nowMs])); }
	static now() { return nowMs; }
});

// The route functions and the adjust route, lifted from this checkout's
// server.js onto `db`. Throws Refusal when the lift is incomplete.
function liftServer({ db, env = {}, sheetId, nowMs = null, roots = ROOTS, src = null }) {
	const text = src || serverSource({ root: ROOT });
	let lifted;
	try {
		lifted = closure(text, { roots: [...roots], routes: [ADJUST_HEAD], provided: [...PROVIDED], denied: [...DENIED] });
	} catch (err) {
		throw new Refusal(`this checkout's server.js can't be lifted for the fix (${err.message}); nothing was read or written`);
	}
	const missing = unresolvedNames(text, lifted, PROVIDED);
	if (missing.length) throw new Refusal(`the lifted code uses ${missing.join(", ")}, which the lift left out; nothing was read or written`);
	const routes = {};
	const register = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
	const app = { get: register("GET"), put: register("PUT"), post: register("POST"), delete: register("DELETE"), use() {} };
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const liftedRequire = (m) => {
		if (m === "crypto" || /^\.\/lib\/[\w.-]+$/.test(m)) return appRequire(m);
		throw new Error(`lifted code required ${m}, which this script does not load`);
	};
	const scriptProcess = { env: { ...env }, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } };
	const body = ['"use strict";', lifted.text, `return { ${roots.join(", ")} };`].join("\n");
	const api = new Function(...PROVIDED, body)(db, liftedRequire, console, scriptProcess, clockDate(nowMs), app, pass, pass(), sheetId);
	api.adjust = routes[ADJUST_ROUTE];
	if (typeof api.adjust !== "function") throw new Refusal(`${ADJUST_ROUTE} did not register from this checkout's server.js`);
	api.liftedNames = lifted.names;
	return api;
}

// ── the sheet ───────────────────────────────────────────────────────────────

// The app's own sheet: SPREADSHEET_ID, else production's for production's own folder.
function ownSheetId(env, root) {
	const named = String((env && env.SPREADSHEET_ID) || "").trim();
	if (named) return named;
	const here = new Set([path.resolve(root), realOr(root)]);
	return [sheetIds.PRODUCTION_DIR, realOr(sheetIds.PRODUCTION_DIR)].some((d) => here.has(d)) ? sheetIds.PRODUCTION_SPREADSHEET_ID : "";
}

// The Google client with the app's own key (see the header).
async function googleSheets({ keyFile, write, cwd = process.cwd() }) {
	if (realOr(cwd) !== realOr(ROOT)) {
		throw new Refusal("run it from the app's own folder: the Sheets key is the app's own, which the Google client reads relative to the folder it runs in, as the server's does");
	}
	const { google } = createRequire(path.join(ROOT, "server.js"))("googleapis");
	google.options({ timeout: GOOGLE_TIMEOUT_MS });
	const auth = new google.auth.GoogleAuth({ keyFile, scopes: [write ? WRITE_SCOPE : READ_SCOPE] });
	return google.sheets({ version: "v4", auth: await auth.getClient() });
}

async function readTab(sheets, sheetId, a1) {
	const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: a1 });
	return { values: (res && res.data && res.data.values) || [] };
}

// The tab's headers, the Load ID and Payment columns (the payout ledger's own
// column rules), and each load's rows. `problems` when a column can't be told.
function sheetFacts(values) {
	const rows = Array.isArray(values) ? values : [];
	const headers = (rows[0] || []).map((h) => (h == null ? "" : String(h)));
	const loadCol = headers.findIndex((h) => /load.?id|job.?id/i.test(h));
	const payCol = headers.findIndex((h) => /payment|rate|amount|revenue/i.test(h));
	const moneyCols = headers.filter((h) => /payment|rate|amount|revenue|pay|charge|price|cost/i.test(h));
	const problems = [];
	if (loadCol < 0) problems.push(`${TAB} has no Load ID column`);
	if (payCol < 0 || !/payment/i.test(headers[payCol]) || moneyCols.length !== 1) problems.push(`${TAB}'s Payment column can't be told for sure: exactly one column must read as money to every reader of the sheet`);
	const data = rows.slice(1).map((cells, i) => ({ rowIndex: i + 2, cells: (cells || []).map((c) => (c == null ? "" : c)) }));
	const rowsOf = (key) => (loadCol < 0 ? [] : data.filter((r) => normalizeLoadId(r.cells[loadCol]) === key));
	return { headers, loadCol, payCol, rowsOf, problems };
}

const cellText = (v) => (v == null ? "" : String(v));
function sameCells(a, b) {
	const n = Math.max(a.length, b.length);
	for (let i = 0; i < n; i++) if (cellText(a[i]) !== cellText(b[i])) return false;
	return true;
}

// The load's last invoice row (load_invoice_drafts, newest first): { id, cents } or { problem }.
function latestInvoice(db, key) {
	const cols = new Set(db.prepare("PRAGMA table_info(load_invoice_drafts)").all().map((c) => c.name));
	if (!cols.size) return { problem: "the database has no invoice rows (load_invoice_drafts)" };
	const row = db.prepare(`SELECT id, total${cols.has("gross_total") ? ", gross_total" : ""} FROM load_invoice_drafts WHERE LOWER(TRIM(load_id)) IN (?, ?) ORDER BY id DESC LIMIT 1`).get(key, `#${key}`);
	if (!row) return { problem: "it has no invoice row, so its invoiced figure can't be proven" };
	const cents = moneyCents(row.total);
	if (cents === null) return { problem: `its last invoice row's total (${JSON.stringify(clip(row.total))}) can't be read` };
	if (String(row.gross_total || "").trim() && moneyCents(row.gross_total) !== cents) return { problem: "its last invoice printed an advance line, so its total is a balance, not the invoiced figure" };
	return { id: row.id, cents };
}

// ── the payout code (read-only) ─────────────────────────────────────────────

function moneyWorld(ctx, values) {
	return buildLedgerWorld({ root: ROOT, dbPath: ctx.dbPath, readonly: true, sheetData: { values }, envFile: ctx.envFile, extraRoots: ["resolveInvestorSplitPct"], now: ctx.nowMs, db: ctx.roDb });
}

// The investor's month as GET /api/payouts' reconcile computes it: its split, its
// payable, whether a lease pays it, and each load's revenue items.
async function ownerMonth(world, ownerId, period) {
	const { api, db } = world;
	const carrierDB = api.getCarrierDBFromSQLite();
	const driverCol = api.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
	const carrierCol = api.findCol(carrierDB.headers, /carrier/i);
	const config = {};
	for (const r of db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all()) config[r.key] = r.value;
	for (const r of db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(ownerId)) config[r.key] = r.value;
	const investorDriverSet = api.getInvestorDriverSet(ownerId, carrierDB.data, driverCol, carrierCol);
	const out = await api.computeInvestorMonthlyEarnings({ user: { id: ownerId }, isSuperAdmin: false, investorDriverSet, investorOwnerId: ownerId, config });
	const carry = api.computeLossCarryForward(out.monthlyEarnings);
	const month = out.monthlyEarnings.find((m) => m.month === period) || null;
	const revenue = new Map();
	for (const it of out.items || []) {
		if (it.kind !== "revenue") continue;
		const k = normalizeLoadId(it.loadId);
		if (!revenue.has(k)) revenue.set(k, []);
		revenue.get(k).push({ month: it.month, cents: it.cents });
	}
	return { splitPct: api.resolveInvestorSplitPct(config), payable: carry[period] ? carry[period].payable : null, lease: Boolean(month && month.payoutBasis), known: Boolean(month), revenue };
}

// A copy of the tab's values with each planned Payment at its "now" or "set" figure.
function valuesAt(values, entries, payCol, which) {
	const out = values.map((r) => (r || []).slice());
	for (const e of entries) {
		const row = out[e.rowIndex - 1];
		while (row.length <= payCol) row.push("");
		row[payCol] = which === "set" ? moneyText(e.setCents, e.text) : moneyText(e.nowCents, e.text);
	}
	return out;
}

// ── one Payment save: PUT /api/data/:rowIndex's steps, in its order ─────────

// The checks PUT /api/data/:rowIndex makes of a Super Admin's save once the row is
// read and bound, on `before` (the row as read), the form's row `baseline` and
// the new Payment: { refusal, audit } or { cellWrites, details }.
function judgeSave(api, { a1, rowIndex, headers, before, baseline, payCol, newText }) {
	const values = baseline.slice();
	values[payCol] = newText;
	api.restoreUntouchedCells(before, values, baseline);
	const owner = api.validateOwnerIdCell(TAB, headers, values);
	if (owner) return { refusal: { code: "OWNER_ID_REFUSED", error: owner.error } };
	const contact = api.brokerContact.contactNotAllowedRefusal(headers, before, values);
	if (contact) return { refusal: contact };
	const driver = api.driverCellRefusal(headers, before, values);
	if (driver) return { refusal: driver };
	const after = api.sheetRowAfterUpdate(before, values);
	const changes = api.changedGuardedCells(headers, before, after);
	const cellWrites = api.sheetRowCellWrites(a1, rowIndex, before, after);
	// The route's audit lists every changed cell; with the Payment alone changed
	// that list is changedGuardedCells()'s.
	if (cellWrites.length !== 1 || changes.length !== 1 || changes[0].index !== payCol) {
		return { refusal: { code: "NOT_ONE_CELL", error: `the save would change ${cellWrites.length} cell(s), not the Payment alone` } };
	}
	const details = (outcome, extra = {}) => api.buildSheetUpdateAudit({ outcome, sheet: TAB, rowIndex, changed: changes, guardedChanged: changes, snapshotUnavailable: false, ...extra });
	if (api.ROW_EDITOR_CANCEL_GUARD_ENABLED) {
		const cancel = api.rowEditCancelRefusal(headers, before, after);
		if (cancel) return { refusal: cancel, audit: { refusal: true, code: cancel.code, details: api.sheetAuditWithCode(details("blocked", { code: cancel.code }), cancel.code) } };
	}
	const blocker = api.sheetRowUpdateBlocker(true, headers, before, after, changes);
	if (blocker) return { refusal: blocker, audit: { refusal: true, code: blocker.code, details: api.sheetAuditWithCode(details("blocked", { code: blocker.code, periods: blocker.periods }), blocker.code) } };
	return { cellWrites, details };
}

// One planned Payment written as the route writes it. { state, code?, why? }:
// written, failed (the write threw: it may have landed), refused (a check of the
// route's, audited as the route audits it) or not-written (nothing attempted).
async function writePayment({ api, sheets, sheetId, entry, planHeaders, payCol }) {
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
	const values = entry.cells.slice();
	values[payCol] = entry.newText;
	const moved = api.rowMovedRefusal(headers, r, before, values, entry.cells);
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
	const j = judgeSave(api, { a1, rowIndex: r, headers, before, baseline: entry.cells, payCol, newText: entry.newText });
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
	let response;
	try {
		response = await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: sheetId, requestBody: { valueInputOption: "USER_ENTERED", data: j.cellWrites } });
	} catch (err) {
		log("update_sheet_row_failed", j.details("failed", { error: err.message }));
		return { state: "failed", code: "WRITE_FAILED", why: err.message };
	}
	log("update_sheet_row", j.details("updated"));
	return { state: "written", updatedCells: response && response.data ? response.data.totalUpdatedCells : null };
}

// The adjustment through the adjust route's own handler, as Payouts sends it.
async function postAdjustment(api, payoutId, plan) {
	const out = { status: 200, body: null };
	const res = { status(code) { out.status = code; return res; }, json(body) { out.body = body; return res; } };
	await api.adjust({ params: { id: String(payoutId) }, body: { adjustment: plan.adjustment, adjustmentNote: plan.reason }, session: { user: { ...SYSTEM_USER } }, headers: {}, query: {} }, res);
	return out;
}

// ── the checks ──────────────────────────────────────────────────────────────

const payoutRowOf = (db, plan) => db.prepare("SELECT * FROM investor_payouts WHERE owner_id = ? AND period = ?").get(plan.ownerId, plan.period) || null;

// Everything that must hold before a write: { problems, facts, entries, adjustOnly, adjust }.
function figureChecks({ api, db, plan, values }) {
	const problems = [];
	const facts = sheetFacts(values);
	problems.push(...facts.problems);
	if (!api.periodLocksReadable()) problems.push("the closed months can't be read (period_locks), so no month can be confirmed open");
	else if (api.periodWriteLocked(plan.period)) problems.push(`${plan.period} is already closed`);
	const entries = [];
	const adjustOnly = [];
	const a1 = api.a1SheetPrefix(TAB);
	const one = (x) => {
		const hits = facts.rowsOf(x.key);
		if (hits.length !== 1) { problems.push(`load ${x.load}: ${hits.length} ${TAB} rows carry it, not one`); return null; }
		const text = cellText(hits[0].cells[facts.payCol]);
		const cents = moneyCents(text);
		if (cents === null) { problems.push(`load ${x.load}: its Payment (${JSON.stringify(clip(text))}) can't be read as an amount`); return null; }
		const inv = latestInvoice(db, x.key);
		if (inv.problem) { problems.push(`load ${x.load}: ${inv.problem}`); return null; }
		return { row: hits[0], text, cents, inv };
	};
	if (!facts.problems.length) {
		for (const p of plan.payments) {
			const f = one(p);
			if (!f) continue;
			const setCents = f.inv.cents;
			if (!p.byGap && p.setCents !== setCents) { problems.push(`load ${p.load}: its last invoice row is ${usd(setCents)}, not the plan's ${usd(p.setCents)}`); continue; }
			const nowCents = p.byGap ? setCents - p.underCents : p.nowCents;
			let state;
			if (f.cents === nowCents) state = "to-write";
			else if (f.cents === setCents) state = "already-done";
			else { problems.push(`load ${p.load}: its Payment is ${usd(f.cents)}, not ${usd(nowCents)} (to set) or ${usd(setCents)} (already set)`); continue; }
			const e = { load: p.load, key: p.key, rowIndex: f.row.rowIndex, cells: f.row.cells, text: f.text, cents: f.cents, nowCents, setCents, invoiceRow: f.inv.id, state, newText: moneyText(setCents, f.text) };
			if (state === "to-write") {
				const j = judgeSave(api, { a1, rowIndex: e.rowIndex, headers: facts.headers, before: e.cells, baseline: e.cells, payCol: facts.payCol, newText: e.newText });
				if (j.refusal) { problems.push(`load ${p.load}: the save would be refused (${j.refusal.code}): ${clip(j.refusal.error || "")}`); continue; }
			}
			entries.push(e);
		}
		for (const a of plan.adjustOnly) {
			const f = one(a);
			if (!f) continue;
			if (f.cents !== f.inv.cents - a.underCents) { problems.push(`load ${a.load}: its Payment is ${usd(f.cents)}, not ${usd(a.underCents)} under its last invoice row (${usd(f.inv.cents)})`); continue; }
			adjustOnly.push({ load: a.load, key: a.key, rowIndex: f.row.rowIndex, text: f.text, cents: f.cents, invoiceCents: f.inv.cents, underCents: a.underCents });
		}
	}
	// The payout row: owed and not finalized, or the Payments would not reach it.
	let adjust = null;
	const row = payoutRowOf(db, plan);
	if (!row && plan.adjustOnly.length) problems.push(`owner ${plan.ownerId} has no payout row for ${plan.period} (the Payouts screen makes it on its next read)`);
	if (row) {
		if (String(row.finalized_at || "") !== "") problems.push(`owner ${plan.ownerId}'s ${plan.period} payout row is finalized`);
		if (row.status !== "owed") problems.push(`owner ${plan.ownerId}'s ${plan.period} payout row is ${row.status}, not owed`);
	}
	if (row && plan.adjustOnly.length) {
		const adj = Number(row.adjustment || 0);
		const note = String(row.adjustment_note || "");
		adjust = { payoutId: row.id, status: row.status, finalized: String(row.finalized_at || "") !== "", amount: row.amount, adjustmentBefore: adj, state: "" };
		if (adj === plan.adjustment && note === plan.reason) adjust.state = "already-done";
		else if (adj === 0 && note === "") adjust.state = "to-write";
		else problems.push(`owner ${plan.ownerId}'s ${plan.period} payout row already carries an adjustment (${usd(Math.round(adj * 100))}, note ${JSON.stringify(clip(note))}) this plan did not write; the route would replace it`);
	}
	return { problems, facts, entries, adjustOnly, adjust };
}

// The payout code's view, before and after the Payments: { problems, original, final }.
async function moneyChecks(ctx, plan, c) {
	const problems = [];
	const original = await ownerMonth(moneyWorld(ctx, valuesAt(ctx.values, c.entries, c.facts.payCol, "now")), plan.ownerId, plan.period);
	const final = await ownerMonth(moneyWorld(ctx, valuesAt(ctx.values, c.entries, c.facts.payCol, "set")), plan.ownerId, plan.period);
	if (!original.known || original.payable === null) problems.push(`the payout code has no ${plan.period} for owner ${plan.ownerId}`);
	if (original.splitPct !== plan.splitPct) problems.push(`owner ${plan.ownerId}'s split is ${original.splitPct}%, not the plan's ${plan.splitPct}%`);
	if (original.lease || final.lease) problems.push(`owner ${plan.ownerId}'s ${plan.period} is paid as a lease, not the split`);
	const counted = (m, key, cents) => {
		const items = m.revenue.get(key) || [];
		return items.length === 1 && items[0].month === plan.period && items[0].cents === cents;
	};
	for (const e of c.entries) {
		if (!counted(original, e.key, e.nowCents) || !counted(final, e.key, e.setCents)) problems.push(`load ${e.load}: the payout code doesn't count it once in owner ${plan.ownerId}'s ${plan.period} at its Payment`);
	}
	for (const a of c.adjustOnly) {
		if (!counted(original, a.key, a.cents)) problems.push(`load ${a.load}: the payout code doesn't count it once in owner ${plan.ownerId}'s ${plan.period} at its Payment`);
	}
	if (!problems.length && final.payable - original.payable !== plan.payoutDelta) {
		problems.push(`the Payments move owner ${plan.ownerId}'s ${plan.period} by ${dollars(final.payable - original.payable)}, not the plan's ${dollars(plan.payoutDelta)}`);
	}
	return { problems, original, final };
}

function automaticInvoices(db, entries) {
	if (!autoInvoiceLedger.hasSchema(db)) return { ledger: false, sent: [] };
	const sent = entries.filter((e) => { const c = autoInvoiceLedger.getClaim(db, e.key); return Boolean(c) && claimSent(c); }).map((e) => e.load);
	return { ledger: true, sent };
}

// ── the run ─────────────────────────────────────────────────────────────────

// `opts` (tests): sheets (a Sheets client), envFile (settings for a database copy),
// nowMs (the lifted code's clock), roots (what to lift), log / err (output).
async function main(argv = process.argv.slice(2), opts = {}) {
	const say = opts.log || ((s) => console.log(s));
	const warn = opts.err || ((s) => console.error(s));
	const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : null;
	const stamp = () => (nowMs === null ? new Date() : new Date(nowMs)).toISOString();
	const result = { script: SCRIPT_NAME, mode: "", startedAt: stamp(), finishedAt: "", outcome: "refused", problems: [], counts: {}, payments: [], adjustOnly: [], adjust: null, payout: null, automaticInvoices: null };
	let resultFile = null;
	const dbs = [];
	const save = () => { if (resultFile) writeResult(resultFile, { ...result, finishedAt: stamp() }); };
	const done = (code) => {
		try { save(); } catch (err) { warn(`ERROR: the result file could not be written (${err.message})`); return code === 2 ? 2 : 1; }
		return code;
	};
	const counts = () => ({
		paymentsPlanned: result.payments.length,
		paymentsToWrite: result.payments.filter((p) => p.state === "to-write").length,
		paymentsWritten: result.payments.filter((p) => p.state === "written").length,
		paymentsAlreadyDone: result.payments.filter((p) => p.state === "already-done").length,
		paymentsStopped: result.payments.filter((p) => ["failed", "refused", "not-written"].includes(p.state)).length,
		adjustToWrite: result.adjust && result.adjust.state === "to-write" ? 1 : 0,
		adjustWritten: result.adjust && result.adjust.state === "written" ? 1 : 0,
		auditRows: result.counts.auditRows || 0,
	});
	// "check" (nothing written yet), "write", then "read-back" (every write made).
	let phase = "check";
	try {
		const args = parseArgs(argv);
		result.mode = args.apply ? "apply" : "dry-run";
		resultFile = resultPath(args.result);
		const plan = readPlanFile(args.plan);
		let scope;
		let dbFile;
		try { ({ scope, file: dbFile } = dbScope(args.db, ROOT)); } catch (err) { throw new Refusal(err.message); }
		if (!fs.existsSync(dbFile)) throw new Refusal(`--db names no file: ${clip(args.db)}`);
		let env;
		try { env = envFor({ root: ROOT, dbPath: args.db, envFile: opts.envFile || null }).env; } catch (err) { throw new Refusal(err.message); }
		if (scope === "app" && ownSheetId(env, ROOT) !== args.sheetId) throw new Refusal("--sheet-id is not this app's own sheet: the database and the sheet must be one app's");
		const roDb = openDb({ root: ROOT, dbFile, readonly: true });
		dbs.push(roDb);
		if (!roDb.readonly) throw new Refusal("the read-only handle on the database is not read-only");
		const rwDb = args.apply ? openDb({ root: ROOT, dbFile, readonly: false }) : null;
		if (rwDb) dbs.push(rwDb);
		const api = liftServer({ db: rwDb || roDb, env, sheetId: args.sheetId, nowMs, roots: opts.roots || ROOTS });
		const sheets = opts.sheets || await googleSheets({ keyFile: api.KEY_FILE, write: args.apply });

		say(`Data fix ${SCRIPT_NAME}: ${plan.payments.length} Payment cell(s) to their invoiced figures, then owner ${plan.ownerId}'s ${plan.period} adjustment. Mode: ${args.apply ? "apply" : "dry run (nothing is written)"}.`);
		say(`  database ${dbFile} (${rwDb ? "opened for writing" : "opened read-only"}); sheet ${args.sheetId}`);
		const target = await api.resolveSheetTargetForWrite(sheets, TAB);
		if (!target.resolved || !target.guarded || target.title !== TAB) throw new Refusal(`the sheet has no ${TAB} tab the closed-month guard covers`);
		const a1 = api.a1SheetPrefix(target.title);
		const snapshot = await readTab(sheets, args.sheetId, a1);

		const c = figureChecks({ api, db: roDb, plan, values: snapshot.values });
		result.payments = c.entries.map((e) => ({ load: e.load, row: e.rowIndex, shows: usd(e.cents), now: usd(e.nowCents), set: usd(e.setCents), invoiceRow: e.invoiceRow, state: e.state }));
		result.adjustOnly = c.adjustOnly.map((a) => ({ load: a.load, row: a.rowIndex, shows: usd(a.cents), invoiced: usd(a.invoiceCents), under: usd(a.underCents) }));
		result.adjust = c.adjust ? { payoutId: c.adjust.payoutId, owner: plan.ownerId, period: plan.period, status: c.adjust.status, finalized: c.adjust.finalized, adjustmentBefore: c.adjust.adjustmentBefore, adjustment: plan.adjustment, state: c.adjust.state } : null;
		const ctx = { dbPath: args.db, envFile: opts.envFile || null, nowMs, roDb, values: snapshot.values };
		const m = c.problems.length ? null : await moneyChecks(ctx, plan, c);
		const problems = [...c.problems, ...(m ? m.problems : [])];
		if (problems.length) {
			result.problems = problems;
			result.counts = counts();
			for (const p of problems) warn(`  REFUSED: ${p}`);
			warn(`REFUSED: ${problems.length} check(s) failed; nothing was written.`);
			return done(2);
		}
		const effectiveAfter = Math.max(0, Math.round(m.final.payable + plan.adjustment));
		result.payout = {
			owner: plan.ownerId, period: plan.period, splitPct: m.original.splitPct,
			recomputedBefore: m.original.payable, recomputedAfter: m.final.payable, adjustment: plan.adjustment,
			effectiveAfter, expected: plan.expectedEffective, difference: effectiveAfter - plan.expectedEffective,
		};
		result.automaticInvoices = automaticInvoices(roDb, c.entries);
		result.counts = counts();
		say(`  ${plan.period} is open; owner ${plan.ownerId}'s payout row ${c.adjust ? `${c.adjust.payoutId}: ${c.adjust.status}, not finalized, adjustment ${usd(Math.round(c.adjust.adjustmentBefore * 100))}` : "is not needed (no adjustment)"}.`);
		for (const e of c.entries) say(`  load ${e.load}, ${TAB} row ${e.rowIndex}: Payment ${e.text} -> ${e.newText} (its last invoice row)${e.state === "already-done" ? ": already done" : args.apply ? "" : ": would write"}`);
		for (const a of c.adjustOnly) say(`  load ${a.load}, ${TAB} row ${a.rowIndex}: Payment stays ${a.text}, ${usd(a.underCents)} under its last invoice row (a closed month's date: the adjustment only)`);
		say(`  owner ${plan.ownerId}'s ${plan.period}, by the payout code: ${dollars(m.original.payable)} before the Payments, ${dollars(m.final.payable)} after (${dollars(m.final.payable - m.original.payable)}, as planned); with the ${dollars(plan.adjustment)} adjustment ${dollars(effectiveAfter)} (expected ${dollars(plan.expectedEffective)}: ${effectiveAfter === plan.expectedEffective ? "matches" : `differs by ${dollars(effectiveAfter - plan.expectedEffective)}`})`);
		if (result.automaticInvoices.sent.length) say(`  heads-up: load(s) ${result.automaticInvoices.sent.join(", ")} have a sent automatic invoice; the automatic-invoice job holds each with an alert once its Payment changes, as after a person's edit.`);
		const toWrite = c.entries.filter((e) => e.state === "to-write");
		const adjustToWrite = Boolean(c.adjust && c.adjust.state === "to-write");
		const nothingToDo = !toWrite.length && !adjustToWrite;
		if (!args.apply) {
			result.outcome = nothingToDo ? "already-done" : "would-write";
			say(nothingToDo ? "Everything is already done. Nothing was written." : `Would write: ${toWrite.length} Payment cell(s), each with its update_sheet_row audit row${adjustToWrite ? `, and the ${dollars(plan.adjustment)} adjustment with its history and audit rows` : ""}. Nothing was written.`);
			return done(result.payout.difference === 0 ? 0 : 3);
		}

		phase = "write";
		const auditFloor = (roDb.prepare("SELECT MAX(id) AS n FROM audit_trail").get() || {}).n || 0;
		const countAudits = () => roDb.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE id > ? AND user_id = 0 AND username = ? AND role = 'system'").get(auditFloor, ACTOR).n;
		for (const e of toWrite) {
			const slot = result.payments.find((p) => p.load === e.load);
			const w = await writePayment({ api, sheets, sheetId: args.sheetId, entry: e, planHeaders: c.facts.headers, payCol: c.facts.payCol });
			slot.state = w.state;
			if (w.code) slot.code = w.code;
			if (w.why) slot.why = clip(w.why);
			result.counts = { ...counts(), auditRows: countAudits() };
			save();
			say(`  load ${e.load}: ${w.state}${w.code ? ` (${w.code}${w.why ? `: ${clip(w.why)}` : ""})` : ""}`);
			if (w.state !== "written") {
				result.outcome = "partial";
				result.problems.push(`load ${e.load}: ${w.state}${w.code ? ` (${w.code})` : ""}; the run stopped there. Run it again to carry on (a load at its invoiced figure is already done).`);
				warn(`STOPPED: load ${e.load} was ${w.state}; ${result.counts.paymentsWritten} written before it. Each load's state is in the result file.`);
				return done(1);
			}
		}
		if (adjustToWrite) {
			const a = await postAdjustment(api, c.adjust.payoutId, plan);
			const ok = a.status === 200 && a.body && a.body.success === true && a.body.payout && Number(a.body.payout.adjustment) === plan.adjustment && a.body.payout.adjustment_note === plan.reason;
			result.adjust.state = ok ? "written" : "failed";
			if (!ok) result.adjust.answer = { status: a.status, error: clip((a.body && (a.body.error || a.body.code)) || "") };
			result.counts = { ...counts(), auditRows: countAudits() };
			save();
			say(`  owner ${plan.ownerId}'s ${plan.period} adjustment: ${ok ? `written (${dollars(plan.adjustment)})` : `not written (${a.status}: ${clip((a.body && a.body.error) || "")})`}`);
			if (!ok) {
				result.outcome = "partial";
				result.problems.push(`the adjustment was not written (${a.status}); the Payments are. Run it again to carry on.`);
				return done(1);
			}
		}
		result.outcome = toWrite.length || adjustToWrite ? "written" : "already-done";
		phase = "read-back";

		// The read back: the sheet, the payout row and the payout code.
		const back = await readTab(sheets, args.sheetId, a1);
		const f2 = sheetFacts(back.values);
		const unconfirmed = [];
		for (const e of c.entries) {
			const hits = f2.rowsOf(e.key);
			const okBack = hits.length === 1 && moneyCents(hits[0].cells[f2.payCol]) === e.setCents;
			result.payments.find((p) => p.load === e.load).readBack = okBack ? "ok" : "differs";
			if (!okBack) unconfirmed.push(`load ${e.load} does not read back at ${usd(e.setCents)}`);
		}
		for (const a of c.adjustOnly) {
			const hits = f2.rowsOf(a.key);
			if (hits.length !== 1 || moneyCents(hits[0].cells[f2.payCol]) !== a.cents) unconfirmed.push(`load ${a.load}'s Payment moved during the run`);
		}
		const row = payoutRowOf(roDb, plan);
		if (c.adjust && (!row || Number(row.adjustment || 0) !== plan.adjustment || row.adjustment_note !== plan.reason)) unconfirmed.push("the payout row does not read back with the adjustment");
		const recomputed = await ownerMonth(moneyWorld({ ...ctx, values: back.values }, back.values), plan.ownerId, plan.period);
		const storedAdjustment = row ? Number(row.adjustment || 0) : 0;
		const effective = Math.max(0, Math.round(recomputed.payable + storedAdjustment));
		Object.assign(result.payout, {
			recomputedReadBack: recomputed.payable,
			storedAmount: row ? row.amount : null,
			storedAdjustment,
			storedEffective: row ? Math.max(0, Math.round(Number(row.amount || 0) + storedAdjustment)) : null,
			effectiveReadBack: effective,
			difference: effective - plan.expectedEffective,
		});
		result.counts = { ...counts(), auditRows: countAudits() };
		say(`  read back: ${c.entries.length - unconfirmed.filter((u) => /does not read back/.test(u)).length} of ${c.entries.length} Payments at their invoiced figures; the payout row's adjustment ${dollars(storedAdjustment)}`);
		say(`  owner ${plan.ownerId}'s ${plan.period}: the payout code recomputes ${dollars(recomputed.payable)}; with the adjustment ${dollars(effective)} (expected ${dollars(plan.expectedEffective)}: ${effective === plan.expectedEffective ? "matches" : `differs by ${dollars(effective - plan.expectedEffective)}`})`);
		say(`  the stored row reads ${dollars(result.payout.storedEffective)} until the app's next Payouts read stores the recomputed figure (and again at the month's close)`);
		if (unconfirmed.length) {
			result.outcome = "unconfirmed";
			result.problems.push(...unconfirmed);
			for (const u of unconfirmed) warn(`  READ BACK: ${u}`);
			return done(1);
		}
		say(`Written: ${result.counts.paymentsWritten} Payment cell(s)${result.adjust && result.adjust.state === "written" ? " and the adjustment" : ""}; ${result.counts.auditRows} audit row(s).${result.counts.paymentsAlreadyDone ? ` Already done: ${result.counts.paymentsAlreadyDone}.` : ""}`);
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
		for (const d of dbs) { try { d.close(); } catch { /* already closed */ } }
	}
}

if (require.main === module) {
	main().then((code) => { process.exitCode = code; });
}

module.exports = {
	ACTOR, ROOTS, PROVIDED, DENIED, ADJUST_HEAD, OPTIONS,
	parseArgs, parsePlan, moneyCents, moneyText, usedNames, unresolvedNames, liftServer, ownSheetId, googleSheets, sheetFacts, main, Refusal,
};
