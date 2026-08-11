#!/usr/bin/env node
/**
 * Audit the Job Tracking sheet for damaged rows, and resolve each row's
 * settlement month against period_locks — so a repair can be split into
 * "open, may be written" and "locked, report only".
 *
 * STRUCTURALLY READ-ONLY. The Google scope requested is `spreadsheets.readonly`
 * and no other; the SQLite handle is opened `readonly: true` and asserted. There
 * is no write path in this file to reach by accident, by flag, or by argument.
 * The repair lives in scripts/repair-job-tracking-addresses.js, which REQUIRES
 * this module rather than re-deriving anything — see "one opinion" below.
 *
 * ── WHY IT REUSES server.js's OWN HELPERS INSTEAD OF RE-DERIVING THE RULE ────
 * Which month a load's money lands in is decided by moneySheetDate() /
 * loadRowPeriods(), and those are the SAME functions every period-lock guard
 * consults. A second implementation here would be a second opinion about which
 * month is closed — and the only failure that matters is the one where this
 * script says "open" about a month the settlement path calls closed. So the
 * functions are EXTRACTED FROM server.js SOURCE, in the pattern already used by
 * scripts/test-money-date.js and scripts/test-truck-retirement.js: server.js
 * opens SQLite, reads a service-account key and starts listening on import, so
 * it cannot be require()d, but its text can be. The extractor asserts each name
 * is defined EXACTLY ONCE, so a rename or a second definition fails the run
 * loudly rather than silently auditing a copy that has drifted.
 *
 * ── ONE OPINION ABOUT "OPEN" ────────────────────────────────────────────────
 * The repair script does not classify rows. It calls runAudit() and writes only
 * rows this file marked `writable`. Two implementations of "is this month
 * closed?" is precisely the drift that ends with a write into a settled period.
 *
 * ── ⚠️ THE STALE LOCK TABLE IS THE FAIL-OPEN, AND IT IS NOT HYPOTHETICAL ─────
 * A period_locks table read from a snapshot is MISSING the most recently closed
 * months, and a missing lock row reads as "not locked", i.e. as PERMISSION TO
 * WRITE. Measured while building this: the repo-local app.db (7 Aug) carried 14
 * locks ending 2026-06, while production carried 15 ending 2026-07 — so an audit
 * trusting the local copy would have declared every 2026-07 row writable, and
 * 2026-07 is closed and settled ($1,800 loads sit in it). That is the exact
 * direction a guard must never fail in, so freshness is ASSERTED, not assumed:
 * assertLockTableFresh() refuses to run unless the newest locked period is the
 * previous calendar month or later. --stale-locks-ok downgrades it to a warning
 * for REPORTING only; the repair script never accepts that flag.
 *
 * ── ⚠️ ROWS ARE HEADER-KEYED OBJECTS, NOT ARRAYS ────────────────────────────
 * loadRowPeriods()/loadAssignedMonthKey() index by HEADER NAME
 * (`row[cols.dateCol]`), so a positional array makes every lookup `undefined` —
 * which does not throw. It silently answers `resolved:false` for every row,
 * which reads as "locked", so the audit looks conservative while being blind.
 * That mistake produced "0 open rows" in all eight damage classes and declared
 * all 205 RFC-2822 dates unreadable by the money resolver, contradicting the
 * resolver's own RFC-2822 branch. parseSheet() is server.js's own converter and
 * is reused here so the shape cannot drift.
 *
 * Usage:
 *   node scripts/audit-job-tracking-damage.js --db=<app.db with FRESH locks>
 *   node scripts/audit-job-tracking-damage.js --db=... --json=out.json
 *   node scripts/audit-job-tracking-damage.js --sheet-id=<id> --allow-non-production
 */

"use strict";

const fs = require("fs");
const path = require("path");

// LOGISX_ROOT lets the script run from outside the checkout it is auditing —
// needed because the Gemini key is IP-restricted to the VPS, so the repair's
// extraction half can only run there, against /var/www/logistics-app.
const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, "..");

// ── the sheet, identified by ID and never by title ───────────────────────────
// The staging sheet is *titled* "logisx-production" and is not production, so a
// title check reads as the opposite of the truth. Only the ID is authoritative.
const PRODUCTION_SHEET_ID = "1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo";
const LOCAL_COPY_SHEET_ID = "156Y5-OUUEZspiY7dRsJZ57iyKWLJAjdVP8a4yw0PMN0";
const SHEET_TAB = "Job Tracking";

// ── extraction from server.js (see header) ───────────────────────────────────
const SERVER_PATH = path.join(ROOT, "server.js");
const SRC = fs.readFileSync(SERVER_PATH, "utf8");

function extractFunction(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of function ${name}() in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}

// Single-line `const NAME = ...;` declarations at top level.
function extractConst(name) {
	const re = new RegExp(`^const ${name} = .*;$`, "gm");
	const hits = SRC.match(re) || [];
	if (hits.length !== 1) throw new Error(`expected exactly 1 declaration of const ${name} in server.js, found ${hits.length}`);
	return hits[0];
}

const FN_NAMES = [
	"parseSheet",
	"findCol",
	"pickAddressColumn",
	"jtParseSheetDate",
	"jtFmtDate",
	"jtExpandDateRange",
	"jobTrackingMonthCols",
	"loadAssignedMonthKey",
	"loadWindowDays",
	"loadRowPeriods",
	"moneySheetDate",
];
const CONST_NAMES = ["RFC2822_MONTHS", "LOCKABLE_MONTH_KEY", "CANCELED_STATUS_RE"];

const S = new Function([
	...CONST_NAMES.map(extractConst),
	...FN_NAMES.map(extractFunction),
	`return { ${FN_NAMES.join(", ")}, ${CONST_NAMES.join(", ")} };`,
].join("\n"))();

// ── period_locks, read-only, freshness asserted ──────────────────────────────
function loadLocks(dbPath) {
	const Database = require("better-sqlite3");
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	if (!db.readonly) throw new Error("refusing: SQLite handle is not readonly");
	const rows = db.prepare("SELECT period, status FROM period_locks ORDER BY period").all();
	db.close();
	return rows;
}

// Previous calendar month in America/Chicago — the business timezone the close
// calendar runs on (currentMonthKeyCT in server.js). Deliberately not UTC: on
// the 1st of a month the two disagree, in the permissive direction.
function previousMonthKeyCT(now = new Date()) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Chicago", year: "numeric", month: "2-digit",
	}).formatToParts(now);
	const y = +parts.find((p) => p.type === "year").value;
	const m = +parts.find((p) => p.type === "month").value;
	const d = new Date(Date.UTC(y, m - 1, 1));
	d.setUTCMonth(d.getUTCMonth() - 1);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// `now` is injectable so the freshness rule can be asserted against a fixed
// clock rather than whatever month the test happens to run in.
function assertLockTableFresh(lockRows, now = new Date()) {
	const locked = lockRows.filter((r) => r.status === "locked").map((r) => r.period).sort();
	const newest = locked[locked.length - 1] || "(none)";
	const expect = previousMonthKeyCT(now);
	return { locked, newest, expect, fresh: newest >= expect };
}

// Every remote call gets a hard ceiling — an unbounded Google call is how two
// agents lost an hour each on this plan.
function withTimeout(p, ms, label) {
	return Promise.race([
		p,
		new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms).unref()),
	]);
}

// 0-based column index -> A1 letter. Used by the repair to anchor an explicit
// range; `values.append` with a bare tab range auto-detects the anchor column
// and lands rows shifted right into the wrong columns.
function columnLetter(idx) {
	let n = idx, s = "";
	do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
	return s;
}

async function readJobTracking({ sheetId, keyFile }) {
	const { google } = require("googleapis");
	const auth = new google.auth.GoogleAuth({
		keyFile,
		scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
	});
	const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
	// values.get, RAW — not getJobTrackingCached(), which returns
	// deduplicateLoads() output (last row per load id wins) and has hidden 8 of
	// 28 matching rows before. A duplicate-load-id row is a real row on the sheet
	// and a real row a repair would have to consider.
	const res = await withTimeout(
		sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${SHEET_TAB}!A1:ZZ` }),
		60000, "values.get");
	return res.data;
}

const RFC2822_CELL = /^\s*(?:Date:)?\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),/i;
const COMPLETED_STATUS_RE = /^(delivered|completed|pod received)$/i;

/**
 * The whole audit. Returns a payload; prints nothing unless `log` is given.
 */
async function runAudit(opts = {}) {
	const started = Date.now();
	const sheetId = opts.sheetId || PRODUCTION_SHEET_ID;
	const dbPath = opts.dbPath || path.join(ROOT, "app.db");
	const keyFile = opts.keyFile || process.env.SERVICE_ACCOUNT_KEY || path.join(ROOT, "service-account-key.json");
	const log = opts.log || (() => {});

	const freshness = assertLockTableFresh(loadLocks(dbPath));
	if (!freshness.fresh && !opts.staleLocksOk) {
		const e = new Error(
			`period_locks looks STALE: newest locked period is ${freshness.newest}, expected ${freshness.expect} or later. ` +
			`A missing lock row reads as "not locked", i.e. as permission to write. Point --db at a FRESH copy of production's period_locks.`);
		e.code = "STALE_LOCKS";
		throw e;
	}
	const lockedSet = new Set(freshness.locked);

	const raw = await readJobTracking({ sheetId, keyFile });
	const parsed = S.parseSheet(raw);
	const headers = parsed.headers;
	const rows = parsed.data;
	if (!headers.length) throw new Error("no headers on the sheet");

	const cols = S.jobTrackingMonthCols(headers);
	const loadIdCol = S.findCol(headers, /load.?id|job.?id/i);
	const statusCol = S.findCol(headers, /status/i);
	// Exact-`payment` on the trimmed header, matching findPaymentColumn's rule:
	// deliberately no /rate|amount/ fallback, so "Rate Per Mile" can never be read
	// as money. The real header carries surrounding spaces ("  Payment  ").
	const paymentCol = headers.find((h) => String(h).trim().toLowerCase() === "payment") || null;
	const pickupAddrCol = S.pickAddressColumn(headers, /origin|pickup|shipper/i);
	const dropAddrCol = S.pickAddressColumn(headers, /dest|drop.?off|delivery|receiver|consignee/i);

	const { addressLooksUsable } = require(path.join(ROOT, "lib", "ratecon-normalize.js"));

	// Repair material on the LOCAL disk. Production's archive lives on the VPS and
	// the n8n Drive folder is a third source, so a `false` here is "not local",
	// never "unrecoverable" — the repair script resolves Drive itself.
	let localRateConIds = new Set();
	try {
		localRateConIds = new Set(fs.readdirSync(path.join(ROOT, "uploads", "rate-cons"))
			.filter((f) => f.toLowerCase().endsWith(".pdf")).map((f) => f.replace(/\.pdf$/i, "")));
	} catch { /* absent locally is normal */ }

	const norm = (v) => String(v ?? "").trim();

	const records = rows.map((row) => {
		const loadId = norm(row[loadIdCol]);
		const status = norm(row[statusCol]);
		const payment = norm(row[paymentCol]);
		const pickup = norm(row[pickupAddrCol]);
		const drop = norm(row[dropAddrCol]);
		const assigned = norm(row[cols.dateCol]);

		const { periods, resolved } = S.loadRowPeriods(row, cols);
		const locked = periods.filter((p) => lockedSet.has(p));
		// Fail CLOSED: a row whose dates cannot be read cannot be SHOWN to sit in an
		// open month, so it is treated exactly as if it were locked.
		const writable = resolved && locked.length === 0;

		const flags = [];
		if (!loadId) flags.push("blank_load_id");
		if (!pickup && !drop) flags.push("both_addresses_empty");
		else {
			if (!pickup) flags.push("pickup_empty");
			else if (!addressLooksUsable(pickup)) flags.push("pickup_unusable");
			if (!drop) flags.push("dropoff_empty");
			else if (!addressLooksUsable(drop)) flags.push("dropoff_unusable");
		}
		if (!payment) flags.push("blank_payment");
		if (RFC2822_CELL.test(assigned)) flags.push("rfc2822_assigned_date");

		return {
			sheetRow: row._rowIndex, loadId, status, payment, pickup, drop, assigned,
			assignedMonth: S.loadAssignedMonthKey(row, cols),
			periods, resolved, locked, writable,
			cancelled: S.CANCELED_STATUS_RE.test(status),
			completed: COMPLETED_STATUS_RE.test(status),
			hasLocalRateConPdf: !!loadId && localRateConIds.has(loadId.replace(/^#/, "")),
			addressDamaged: flags.some((f) => /address|pickup|dropoff/.test(f)),
			flags,
		};
	});

	const damaged = records.filter((r) => r.flags.length);
	const byFlag = (f) => damaged.filter((r) => r.flags.includes(f));
	const classes = [
		["both addresses empty", byFlag("both_addresses_empty")],
		["pickup empty (drop-off present)", byFlag("pickup_empty")],
		["drop-off empty (pickup present)", byFlag("dropoff_empty")],
		["pickup present but unusable", byFlag("pickup_unusable")],
		["drop-off present but unusable", byFlag("dropoff_unusable")],
		["blank Payment", byFlag("blank_payment")],
		["blank Load ID", byFlag("blank_load_id")],
		["RFC-2822 Assigned Date", byFlag("rfc2822_assigned_date")],
	];
	const addressDamaged = damaged.filter((r) => r.addressDamaged);
	const repairCandidates = addressDamaged.filter((r) => r.writable);

	// The 205-row date question, decided on data rather than on a code reading:
	// a cell is FINANCIAL only if the resolver the money math uses cannot read it.
	const rfc = byFlag("rfc2822_assigned_date");
	const unreadableByMoney = rfc.filter((r) => !r.assignedMonth);
	const unreadableByStrict = rfc.filter((r) => {
		const d = S.jtParseSheetDate(r.assigned);
		return !d || isNaN(d);
	});

	// Blank Payment: a completed load with no money is missing revenue; a
	// cancelled/unassigned one is correctly blank.
	const blankPay = byFlag("blank_payment");
	const blankPayByStatus = {};
	for (const r of blankPay) {
		const k = r.status || "(blank status)";
		blankPayByStatus[k] = (blankPayByStatus[k] || 0) + 1;
	}

	const payload = {
		generatedAt: new Date().toISOString(),
		sheetId, sheetTab: SHEET_TAB, dbPath,
		lockFreshness: freshness,
		lockedPeriods: freshness.locked,
		headers,
		resolvedColumns: {
			loadIdCol, statusCol, paymentCol, pickupAddrCol, dropAddrCol,
			assignedDateCol: cols.dateCol,
			pickupAddrIndex: headers.indexOf(pickupAddrCol),
			dropAddrIndex: headers.indexOf(dropAddrCol),
		},
		totals: {
			dataRows: rows.length,
			damagedRows: damaged.length,
			byClass: Object.fromEntries(classes.map(([l, list]) => [l, {
				total: list.length,
				open: list.filter((r) => r.writable).length,
				locked: list.length - list.filter((r) => r.writable).length,
			}])),
			addressDamaged: { total: addressDamaged.length, open: repairCandidates.length },
		},
		blankPayment: {
			total: blankPay.length,
			byStatus: blankPayByStatus,
			completedWithNoPayment: blankPay.filter((r) => r.completed).length,
			cancelledOrOther: blankPay.filter((r) => !r.completed).length,
			open: blankPay.filter((r) => r.writable).length,
		},
		rfc2822Verdict: {
			rows: rfc.length,
			unreadableByStrictParser: unreadableByStrict.length,
			unreadableByMoneyResolver: unreadableByMoney.length,
			cosmetic: unreadableByMoney.length === 0,
		},
		repairCandidates,
		damaged,
		elapsedMs: Date.now() - started,
	};

	// ── human report ──────────────────────────────────────────────────────────
	log(`Job Tracking damage audit`);
	log(`  sheet     ${sheetId}${sheetId === PRODUCTION_SHEET_ID ? "  (PRODUCTION)" : ""}`);
	log(`  locks db  ${dbPath}`);
	log(`  locked    ${freshness.locked.length} periods, newest ${freshness.newest}${freshness.fresh ? "" : "   ⚠️ STALE"}`);
	log(`  rows      ${rows.length} data rows, ${headers.length} columns`);
	log(`  columns   loadId="${loadIdCol}" status="${statusCol}" payment="${paymentCol}"`);
	log(`            pickup="${pickupAddrCol}" dropoff="${dropAddrCol}" assignedDate="${cols.dateCol}"`);

	const split = (list) => {
		const open = list.filter((r) => r.writable).length;
		return `${String(list.length).padStart(3)} total — ${open} OPEN / ${list.length - open} locked-or-unresolved`;
	};
	log(`\n── damage classes (OPEN = writable under the locked-months rule) ──`);
	for (const [label, list] of classes) log(`  ${label.padEnd(34)} ${split(list)}`);
	log(`\n  rows failing addressLooksUsable()  ${split(addressDamaged)}`);

	log(`\n── blank Payment: missing revenue vs correctly blank ──`);
	for (const [k, n] of Object.entries(blankPayByStatus).sort((a, b) => b[1] - a[1])) log(`  ${k.padEnd(24)} ${n}`);
	log(`  completed-with-no-payment ${payload.blankPayment.completedWithNoPayment} (real missing revenue), other ${payload.blankPayment.cancelledOrOther}, OPEN ${payload.blankPayment.open}`);

	log(`\n── OPEN and address-damaged (the only rows a repair may touch) ──`);
	if (!repairCandidates.length) log(`  (none)`);
	for (const r of repairCandidates) {
		log(`  row ${String(r.sheetRow).padStart(4)}  load ${(r.loadId || "(blank)").padEnd(12)} ` +
			`period ${(r.periods.join(",") || "?").padEnd(9)} status ${(r.status || "-").padEnd(12)} ` +
			`pay ${(r.payment || "-").padEnd(12)} [${r.flags.join(",")}]`);
	}

	log(`\n── RFC-2822 Assigned Date: cosmetic or financial? ──`);
	log(`  rows with an RFC-2822 cell            ${rfc.length}`);
	log(`  ... unreadable by the STRICT parser   ${unreadableByStrict.length}  (jtParseSheetDate)`);
	log(`  ... unreadable by the MONEY resolver  ${unreadableByMoney.length}  (moneySheetDate -> loadAssignedMonthKey)`);
	log(`  verdict: ${payload.rfc2822Verdict.cosmetic
		? "COSMETIC — every one resolves to a settlement month, so no revenue is mis-bucketed. Display-only; do NOT restate."
		: `FINANCIAL — ${unreadableByMoney.length} row(s) book to NO month. Investigate before any repair.`}`);

	return payload;
}

module.exports = {
	runAudit, loadLocks, assertLockTableFresh, previousMonthKeyCT,
	withTimeout, columnLetter, readJobTracking,
	PRODUCTION_SHEET_ID, LOCAL_COPY_SHEET_ID, SHEET_TAB, ROOT, S,
};

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
	const argv = process.argv.slice(2);
	const arg = (name, dflt) => {
		const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
		if (!hit) return dflt;
		const eq = hit.indexOf("=");
		return eq === -1 ? true : hit.slice(eq + 1);
	};
	const sheetId = String(arg("sheet-id", PRODUCTION_SHEET_ID));
	if (sheetId !== PRODUCTION_SHEET_ID && !arg("allow-non-production", false)) {
		console.error(`Refusing: --sheet-id is not the production Dispatch Management sheet.`);
		console.error(`  given:      ${sheetId}`);
		console.error(`  production: ${PRODUCTION_SHEET_ID}`);
		console.error(`  local copy: ${LOCAL_COPY_SHEET_ID}`);
		console.error(`Pass --allow-non-production if that is genuinely what you want.`);
		process.exit(2);
	}
	runAudit({
		sheetId,
		dbPath: String(arg("db", path.join(ROOT, "app.db"))),
		keyFile: arg("key", undefined) ? String(arg("key")) : undefined,
		staleLocksOk: !!arg("stale-locks-ok", false),
		log: (...a) => console.log(...a),
	}).then((payload) => {
		const out = arg("json", "");
		if (out) { fs.writeFileSync(String(out), JSON.stringify(payload, null, 2)); console.log(`\nwrote ${out}`); }
		console.log(`\ndone in ${payload.elapsedMs}ms`);
	}).catch((e) => {
		console.error(`\naudit failed: ${e && e.message ? e.message : e}`);
		if (e && e.code === "STALE_LOCKS") console.error(`Pass --stale-locks-ok to report anyway (reporting only — never repair on a stale table).`);
		process.exit(e && e.code === "STALE_LOCKS" ? 3 : 1);
	});
}
