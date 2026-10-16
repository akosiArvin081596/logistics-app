#!/usr/bin/env node
// scripts/october-flags-report.js — the one combined "what would change" report
// for October the user asked for before any of the B12, daily-rate or B4 flags
// goes on (2026-10-16): each change alone and all three together, from one read
// of the data. Run it on the server with no login. Read-only: nothing is
// written anywhere.
//
// One read: the database is opened once, read-only, and read inside one read
// transaction (one snapshot); Job Tracking is read once (--sheet-id, with the
// read-only scope, or --values-json). Every scenario computes from that data,
// with the lifted code's clock stopped at the read instant. Each scenario is this
// checkout's server.js lifted with its own settings (scripts/lib/ledger-world.js),
// the app's .env as the server reads it being "today":
//   b12                   TRIP_WORK_DAYS on from October (lib/trip-work-days.js)
//   dailyRate             DRIVER_RATE_ONLY on from October (lib/driver-rate-only.js)
//   b4AsDesigned          B4 as designed changes future rate-con extractions only:
//                         stored loads, so every figure, stay as today. The report
//                         lists the in-flight drop-trailer loads whose next
//                         rate-con email would store the Ready date, by the rule
//                         POST /api/n8n/keep-stored-values applies (not delivered,
//                         no broker invoice draft, not in a closed month)
//   b4Applied             as if every load in --b4-ready had its Pickup
//                         Appointment set to its Ready date (a load that books
//                         into a closed month stays as recorded, and is listed)
//   allThree              b12 + dailyRate + b4Applied
//   allThreeB4AsDesigned  b12 + dailyRate
// For each scenario:
//   - per daily-rate driver, the payout ledger's October days and pay
//     (computeFleetLedger(), every scope);
//   - per investor, the October payable: computeInvestorMonthlyEarnings(),
//     which settles through settleInvestorMonths(), then the loss carried
//     forward (computeLossCarryForward()), as the server does;
//   - every live weekly invoice and Draft that would differ. The daily rate
//     reprices its paid days that pay in October or later
//     (driver-rate-only-report.js invoiceRateDiffs()); B12 adds the days its
//     rule pays and lists the ones it would not (workDaysDryRun()'s perInvoice,
//     the work-days dry run's own code, on the scenario without B12); B4 adds
//     or drops the days the payout ledger gains or loses in that invoice's week
//     for its driver when the Ready dates apply (the ledger and the weekly
//     invoice share the pay-day path). An issued invoice is never reduced: a day
//     the scenario would not pay stays as issued, and the rest is an
//     "adjustment" (its week all in open months) or a "correction draft" (its
//     week touches a closed month), as the daily-rate report decides it. A Draft
//     is regenerated.
// Then every closed month and every month before October checked identical in
// every scenario, the closed months' frozen-row fingerprint, and the earlier
// figures this report replaces, each beside this run's own.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/october-flags-report.js --db=app.db --sheet-id=<id> --b4-ready='{"<load id>":"YYYY-MM-DD"}' [--key=service-account-key.json] [--names] [--json]
//   --b4-ready=<json>      the drop-trailer loads' Ready dates, read beforehand from
//                          their rate cons (the script reads no PDF and makes no
//                          other call): an object of load id -> YYYY-MM-DD, {} for none
//   --sheet-id=env         the SPREADSHEET_ID the .env sets (refused when none)
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      with a copy of the database under the temp directory only
//   --names                name drivers and investors (default: "driver 1", …,
//                          numbered per run, and investors by owner id)
//   --json                 print the whole result as JSON (default: a text report)
//   --dry-run              accepted; the run is always read-only
// Exit codes: 0 done, 1 error or a closed month would change, 2 refused (a
// malformed --b4-ready, a missing input, October not open, or B12 or the daily
// rate already on in the app's .env, so "today" would already include it).

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildLedgerWorld, openDb, parseArgs, sheetFor, envFor } = require("./lib/ledger-world");
const rateReport = require("./driver-rate-only-report");
const tripWorkDays = require("../lib/trip-work-days");
const driverRateOnly = require("../lib/driver-rate-only");
const ledgerDayOnce = require("../lib/ledger-day-once");
const appTime = require("../lib/app-time");
const { normalizeLoadId } = require("../lib/ratecon-load");

const ROOT = path.join(__dirname, "..");
const MONTH = "2026-10";
const W40_START = "2026-10-03";
const B4_MAX_LOADS = 500;
const LOAD_ID_MAX = 64;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TRIP = { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: MONTH };
const RATE = { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: MONTH };
// What the report lifts beside the ledger: the daily-rate report's own list,
// the work-days dry run, the invoice's paid days, the keep-stored-values rule,
// and the money settings it prints.
const EXTRA_ROOTS = [...new Set([
	...rateReport.EXTRA_ROOTS, "workDaysDryRun", "invoicePaidDaysOf", "sheetCellDate",
	"reissueHoldFor", "reissueOutgoingHold", "keepStoredSheetValues", "loadRowAccountingMonths", "periodWriteLocked", "periodLocksReadable",
	"RATECON_REISSUE_HOLD_ENABLED", "PAYOUT_RULES_V2_ENABLED", "PRE_DISPATCH_PAY_DAY_RULE_FROM", "INVESTOR_LEASE_PAYOUTS_ENABLED",
	"MARK_PAID_CLOSED_MONTH_ENABLED", "PERSONAL_EXPENSE_DEDUCTIONS_ENABLED",
])];
const SCENARIOS = [
	["today", "today"],
	["b12", "B12 alone"],
	["dailyRate", "daily rate alone"],
	["b4AsDesigned", "B4 as designed"],
	["b4Applied", "B4 applied (3b)"],
	["allThree", "all three"],
	["allThreeB4AsDesigned", "all three, B4 as designed"],
];
// Each scenario's parts: B12, the daily rate, and the B4 Ready dates applied.
const PARTS = {
	today: {}, b12: { trip: true }, dailyRate: { rate: true }, b4AsDesigned: {}, b4Applied: { b4: true },
	allThree: { trip: true, rate: true, b4: true }, allThreeB4AsDesigned: { trip: true, rate: true },
};
const round2 = (x) => Math.round(x * 100) / 100;
const cents = (x) => Math.round(Number(x || 0) * 100);
const usd = (x) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;
const signed = (x) => `${x > 0 ? "+" : ""}${usd(x)}`;
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isCalendarDay = (s) => {
	const ms = DAY_RE.test(s) ? Date.parse(`${s}T12:00:00Z`) : NaN;
	return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
};
const sorted = (xs) => [...new Set(xs)].sort();

class Refusal extends Error {}
function refuse(msg) { throw new Refusal(msg); }

// --b4-ready: { "<load id>": "YYYY-MM-DD" }, keyed by the load id as the app
// keys a load (normalizeLoadId(), the keep-stored-values route's normLoadKey()).
function parseReady(raw) {
	if (typeof raw !== "string") refuse("--b4-ready='{\"<load id>\":\"YYYY-MM-DD\"}' is required: the drop-trailer loads' Ready dates ({} for none)");
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		refuse("--b4-ready is not JSON: give an object of load id -> YYYY-MM-DD");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) refuse("--b4-ready must be a JSON object of load id -> YYYY-MM-DD");
	const entries = Object.entries(value);
	if (entries.length > B4_MAX_LOADS) refuse(`--b4-ready names ${entries.length} loads; at most ${B4_MAX_LOADS}`);
	const out = new Map();
	for (const [id, day] of entries) {
		const given = String(id).trim();
		const key = normalizeLoadId(given);
		if (!key || given.length > LOAD_ID_MAX) refuse(`--b4-ready has a blank or overlong load id (${JSON.stringify(String(id).slice(0, LOAD_ID_MAX))})`);
		if (typeof day !== "string" || !isCalendarDay(day)) refuse(`--b4-ready: load ${given}'s Ready date ${JSON.stringify(day)} is not a calendar date (YYYY-MM-DD)`);
		if (out.has(key)) refuse(`--b4-ready names load ${given} twice`);
		out.set(key, { given, ready: day });
	}
	return out;
}

// The app checkout's commit: git's HEAD, else the client build's record.
function appCommit() {
	const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", timeout: 10000 });
	const head = String(r.stdout || "").trim();
	if (r.status === 0 && /^[0-9a-f]{40}$/.test(head)) return head;
	let built = "";
	try {
		built = fs.readFileSync(path.join(ROOT, "client", "dist", ".build-commit"), "utf8").trim();
	} catch {
		built = "";
	}
	return /^[0-9a-f]{40}$/.test(built) ? built : "unknown";
}

// An instant as "YYYY-MM-DD HH:MM:SS EDT" in the app's zone.
function easternText(ms, zone) {
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
		timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short",
	}).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

// A day key from a sheet date cell (the money math's sheetCellDate()), or "".
function cellDay(A, cell) {
	const d = A.sheetCellDate(cell);
	if (!d) return "";
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The Ready date written the way the stored cell writes its date.
function readyCell(stored, day) {
	if (/^\s*\d{4}-/.test(String(stored || ""))) return day;
	const [y, m, d] = day.split("-").map(Number);
	return `${m}/${d}/${y}`;
}

// B4: for each --b4-ready load, what its next rate-con email would store (as
// designed) and the sheet as if its Pickup Appointment were the Ready date.
function b4Plan(A, sheetData, ready) {
	const rows = (sheetData && sheetData.values) || [];
	const headers = rows[0] || [];
	const idCol = headers.findIndex((h) => String(h).trim().toLowerCase() === "load id");
	const pickupHeader = A.jobTrackingMonthCols(headers).pickupDateCol;
	const pickupIdx = pickupHeader ? headers.indexOf(pickupHeader) : -1;
	const statusIdx = headers.findIndex((h) => /^(job[\s._-]?)?status$/i.test(String(h || "").trim()));
	if (ready.size && (idCol === -1 || pickupIdx === -1)) refuse("Job Tracking has no Load ID or Pickup Appointment column, so the Ready dates cannot be placed");
	const loads = [];
	const overrides = new Map();
	for (const [key, { given, ready: day }] of ready) {
		const at = [];
		for (let i = 1; i < rows.length; i++) if (normalizeLoadId(rows[i][idCol]) === key) at.push(i);
		if (!at.length) refuse(`--b4-ready names load ${given}, which is not on Job Tracking`);
		// The row the app reads as the load: the last one (deduplicateLoads()).
		const match = rows[at[at.length - 1]];
		const storedCell = match[pickupIdx] == null ? "" : String(match[pickupIdx]);
		const cell = readyCell(storedCell, day);
		const stored = {};
		headers.forEach((h, i) => { stored[h] = match[i] == null ? "" : match[i]; });
		const values = { [pickupHeader]: cell };
		// As designed: POST /api/n8n/keep-stored-values' answer to an email carrying it.
		let hold = A.RATECON_REISSUE_HOLD_ENABLED ? A.reissueHoldFor(headers, match, key) : null;
		let out = A.keepStoredSheetValues(stored, values, {}, hold);
		if (A.RATECON_REISSUE_HOLD_ENABLED && !(hold && hold.all)) {
			const outgoing = A.reissueOutgoingHold(headers, match, out.values);
			if (outgoing) {
				hold = { all: true, reasons: [...(hold ? hold.reasons : []), outgoing] };
				out = A.keepStoredSheetValues(stored, values, {}, hold);
			}
		}
		const already = cellDay(A, storedCell) === day;
		const takesReady = !already && out.values[pickupHeader] === cell;
		const reason = already ? "already the Ready date"
			: takesReady ? "takes the Ready date on its next rate-con email"
				: `kept: ${hold ? hold.reasons.join(" and ") : "the stored value stays"}`;
		// Applied: unless the load books into a closed month, stored or changed.
		const changed = [...match];
		while (changed.length <= pickupIdx) changed.push("");
		changed[pickupIdx] = cell;
		let skipped = already ? "already the Ready date" : "";
		if (!skipped && !A.periodLocksReadable()) skipped = "the closed months can't be read";
		if (!skipped) {
			const before = A.loadRowAccountingMonths(headers, match);
			const after = A.loadRowAccountingMonths(headers, changed);
			if (before === null || after === null) skipped = "a date on the load can't be placed in a month";
			else {
				const locked = sorted([...before, ...after]).filter((m) => A.periodWriteLocked(m));
				if (locked.length) skipped = `in a closed month (${locked.join(", ")}), left as recorded`;
			}
		}
		if (!skipped) for (const i of at) overrides.set(i, cell);
		loads.push({
			loadId: String(match[idCol]).trim(), status: statusIdx === -1 ? "" : String(match[statusIdx] || "").trim(),
			storedPickup: storedCell, ready: day, asDesigned: { takesReady, reason }, applied: !skipped, skipped,
		});
	}
	const values = rows.map((r, i) => {
		if (!overrides.has(i)) return r;
		const c = [...r];
		while (c.length <= pickupIdx) c.push("");
		c[pickupIdx] = overrides.get(i);
		return c;
	});
	loads.sort((p, q) => p.loadId.localeCompare(q.loadId));
	return { loads, sheet: { ...sheetData, values } };
}

// The payout ledger's daily-rate days per driver: { month: { driver: { days, cents } }, days: driver -> Map(day -> cents) }.
function ledgerDays(fleet) {
	const month = new Map();
	const days = new Map();
	for (const s of fleet.scopes) {
		for (const it of s.items) {
			if (it.kind !== "driver_pay" || it.payType !== "fixed" || !it.day) continue;
			if (!days.has(it.driver)) days.set(it.driver, new Map());
			const d = days.get(it.driver);
			d.set(it.day, (d.get(it.day) || 0) + it.cents);
			if (it.month !== MONTH) continue;
			const m = month.get(it.driver) || { days: 0, cents: 0 };
			m.days++;
			m.cents += it.cents;
			month.set(it.driver, m);
		}
	}
	return { month, days };
}

async function compute(args, { now, loadSheet }) {
	if (!args.db || args.db === true) refuse("--db is required");
	const ready = parseReady(args["b4-ready"]);
	if (!args["values-json"] && (typeof args["sheet-id"] !== "string" || !args["sheet-id"])) refuse("--sheet-id (or --values-json) is required; there is no default sheet");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let env;
	let dbFile;
	try {
		({ env, file: dbFile } = envFor({ root: ROOT, dbPath: args.db, envFile }));
	} catch (err) {
		refuse(err.message);
	}
	const quiet = () => {};
	const tripNow = tripWorkDays.ruleFromEnv(env, quiet);
	const rateNow = driverRateOnly.ruleFromEnv(env, quiet);
	if (tripNow || rateNow) {
		refuse(`the app's .env already has ${tripNow ? `TRIP_WORK_DAYS on from ${tripNow}` : `DRIVER_RATE_ONLY on from ${rateNow}`}, so "today" would already include it`);
	}
	const zone = appTime.resolveAppTimeZone(env.APP_TIMEZONE, quiet);

	const db = openDb({ root: ROOT, dbFile, readonly: true });
	try {
		// One snapshot for every world: a read transaction held to the end.
		db.exec("BEGIN");
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'period_locks'").get()) {
			refuse("the database has no period_locks table, so its closed months cannot be told");
		}
		const latestClosed = ledgerDayOnce.latestClosedMonth(db);
		if (latestClosed && MONTH <= latestClosed) {
			refuse(`${MONTH} is at or before ${latestClosed}, the latest closed month. The rules may only start in an open month: closed months are final as recorded.`);
		}
		const readAt = Number.isFinite(now) ? now : Date.now();
		const commit = appCommit();
		const sheetData = await loadSheet(args, ROOT);
		const result = await report({ db, args, envFile, sheetData, ready, readAt, zone, env, latestClosed, names: args.names === true });
		result.commit = commit;
		const after = appCommit();
		if (after !== commit) result.problems.push({ scenario: "", issue: `the app's commit changed during the run (${commit} -> ${after}); run it again` });
		return result;
	} finally {
		if (db.inTransaction) db.exec("ROLLBACK");
		db.close();
	}
}

async function report({ db, args, envFile, sheetData, ready, readAt, zone, env, latestClosed, names }) {
	const world = (overrides, sheet) => buildLedgerWorld({
		root: ROOT, dbPath: args.db, readonly: true, sheetData: sheet, envFile, envOverrides: overrides, extraRoots: EXTRA_ROOTS, now: readAt, db,
	});
	const W = { today: world(null, sheetData) };
	const A = W.today.api;
	const b4 = b4Plan(A, sheetData, ready);
	Object.assign(W, {
		b12: world(TRIP, sheetData),
		dailyRate: world(RATE, sheetData),
		b4Applied: world(null, b4.sheet),
		allThree: world({ ...TRIP, ...RATE }, b4.sheet),
		allThreeB4AsDesigned: world({ ...TRIP, ...RATE }, sheetData),
		// Not reported on their own: B12's invoice days for all three, and the
		// B4 impact's "B12 on" for the figures this report replaces.
		rateB4: world(RATE, b4.sheet),
		b12B4: world(TRIP, b4.sheet),
	});
	W.b4AsDesigned = W.today;
	for (const [k, w] of Object.entries(W)) {
		const parts = PARTS[k] || { trip: k === "b12B4", rate: k === "rateB4" };
		if ((w.api.TRIP_WORK_DAYS_FROM || null) !== (parts.trip ? MONTH : null) || (w.api.DRIVER_RATE_ONLY_FROM || null) !== (parts.rate ? MONTH : null)) {
			throw new Error(`the ${k} world did not lift with its settings (TRIP_WORK_DAYS_FROM ${w.api.TRIP_WORK_DAYS_FROM || "unset"}, DRIVER_RATE_ONLY_FROM ${w.api.DRIVER_RATE_ONLY_FROM || "unset"})`);
		}
	}
	const closedMonths = db.prepare("SELECT period FROM period_locks WHERE status = 'locked' ORDER BY period").all().map((r) => r.period);
	const guarded = (m) => A.isLocked(m) || m < MONTH;

	// The payout ledger and the investor payables, once per world (B4 as
	// designed is today's world).
	const fleets = new Map();
	const fleetOf = async (k) => { if (!fleets.has(W[k])) fleets.set(W[k], await W[k].api.computeFleetLedger()); return fleets.get(W[k]); };
	const investors = A.listSettlableInvestors();
	const carrierDB = A.getCarrierDBFromSQLite();
	const driverCol = A.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
	const carrierCol = A.findCol(carrierDB.headers, /carrier/i);
	const globalConfig = {};
	db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all().forEach((r) => { globalConfig[r.key] = r.value; });
	// owner id -> month -> { payable, driverPay }, per world.
	const payableMaps = new Map();
	const payablesOf = async (k) => {
		if (payableMaps.has(W[k])) return payableMaps.get(W[k]);
		const api = W[k].api;
		const out = new Map();
		for (const inv of investors) {
			const config = { ...globalConfig };
			db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(inv.ownerId).forEach((r) => { config[r.key] = r.value; });
			const investorDriverSet = api.getInvestorDriverSet(inv.ownerId, carrierDB.data, driverCol, carrierCol);
			const { monthlyEarnings } = await api.computeInvestorMonthlyEarnings({ user: { id: inv.ownerId }, isSuperAdmin: false, investorDriverSet, investorOwnerId: inv.ownerId, config });
			const carry = api.computeLossCarryForward(monthlyEarnings);
			out.set(inv.ownerId, new Map(monthlyEarnings.map((m) => [m.month, { payable: round2(carry[m.month].payable), driverPay: round2((m.exact && m.exact.driverPay) ?? m.driverPay ?? 0) }])));
		}
		payableMaps.set(W[k], out);
		return out;
	};

	const keys = SCENARIOS.map(([k]) => k);
	const ledger = new Map();
	const payables = new Map();
	for (const k of keys) ledger.set(k, ledgerDays(await fleetOf(k)));
	for (const k of [...keys, "b12B4"]) payables.set(k, await payablesOf(k));

	// Drivers: every daily-rate driver the ledger pays in October in any scenario.
	const index = await rateReport.driverIndex({ db, A });
	const driverKeys = sorted(keys.flatMap((k) => [...ledger.get(k).month.keys()]));
	// Names, or numbers ("driver 1", …, in this run's order; a driver only an
	// invoice names takes the next number).
	const labels = new Map();
	const label = (d) => {
		if (!labels.has(d)) labels.set(d, names ? (index.display.get(d) || d) : `driver ${labels.size + 1}`);
		return labels.get(d);
	};
	const pay = (k, d) => { const m = ledger.get(k).month.get(d) || { days: 0, cents: 0 }; return { days: m.days, pay: m.cents / 100 }; };
	const drivers = driverKeys.map((d) => ({ driver: label(d), byScenario: Object.fromEntries(keys.map((k) => [k, pay(k, d)])) }));
	const driverTotals = Object.fromEntries(keys.map((k) => [k, driverKeys.reduce((t, d) => ({ days: t.days + pay(k, d).days, pay: round2(t.pay + pay(k, d).pay) }), { days: 0, pay: 0 })]));
	const octPayable = (k, ownerId) => (payables.get(k).get(ownerId).get(MONTH) || { payable: 0, driverPay: 0 });
	const investorRows = investors.map((inv) => ({
		ownerId: inv.ownerId, investor: names ? inv.name : `owner ${inv.ownerId}`,
		byScenario: Object.fromEntries(keys.map((k) => [k, octPayable(k, inv.ownerId)])),
	}));
	const investorTotals = Object.fromEntries(keys.map((k) => [k, round2(investors.reduce((t, inv) => t + octPayable(k, inv.ownerId).payable, 0))]));

	// Invoices, by scenario.
	const live = db.prepare("SELECT * FROM invoices WHERE COALESCE(deleted_at, '') = '' ORDER BY week_start, id").all();
	const byNumber = new Map(live.map((inv) => [inv.invoice_number, inv]));
	const gridTotal = (inv, day) => {
		let snap = null;
		try { snap = JSON.parse(inv.render_data || "{}"); } catch { snap = null; }
		const cell = snap && snap.days ? snap.days[A.invoiceGridDayName(day)] : null;
		return cell && cell.completed ? Number(cell.total) || 0 : 0;
	};
	const dryRuns = new Map();
	const dryRunOf = async (k) => {
		if (!dryRuns.has(k)) {
			const dry = await W[k].api.workDaysDryRun({ from: MONTH, to: MONTH });
			if (dry.refused) refuse(dry.reason);
			dryRuns.set(k, dry);
		}
		return dryRuns.get(k);
	};
	// The world each scenario's B12 invoice days come from: the scenario without B12.
	const withoutTrip = { b12: "today", allThreeB4AsDesigned: "dailyRate", allThree: "rateB4" };
	// The scenario without B4, for the B4 ledger days.
	const withoutB4 = { b4Applied: "today", allThree: "allThreeB4AsDesigned" };
	const problems = [];
	const invoicesBy = {};
	for (const k of keys) {
		const parts = PARTS[k];
		const rows = new Map();
		const rowOf = (number) => {
			if (!rows.has(number)) rows.set(number, { added: new Map(), b12Added: null, notPaid: new Set(), repriced: [], notes: [], kind: "" });
			return rows.get(number);
		};
		if (parts.rate) {
			const idx = await rateReport.driverIndex({ db, A: W[k].api });
			const diff = rateReport.invoiceRateDiffs({ db, A: W[k].api, from: MONTH, index: idx });
			for (const r of [...diff.invoices, ...diff.drafts]) {
				const row = rowOf(r.invoiceNumber);
				row.repriced = r.days.map((d) => ({ day: d.day, printed: d.printed, scenario: d.rule }));
				if (r.kind === "manual") row.kind = "manual";
			}
		}
		if (parts.trip) {
			const dry = await dryRunOf(withoutTrip[k]);
			if (!dry.closedMonthsUnchanged || !dry.monthsBeforeFromUnchanged) {
				for (const p of dry.problems) problems.push({ scenario: k, ownerId: p.ownerId, issue: `B12 dry run: ${p.issue}`, closed: !!p.closed });
			}
			for (const p of dry.perInvoice) {
				const row = rowOf(p.invoiceNumber);
				row.b12Added = { days: p.addedDays, amount: p.amountAdded };
				for (const d of p.droppedDays) row.notPaid.add(d);
				if (p.addedDays.length) row.notes.push(`B12: ${p.afterSwitchOn}`);
			}
		}
		if (parts.b4) {
			const before = ledger.get(withoutB4[k]).days;
			const after = ledger.get(k).days;
			for (const inv of live) {
				if (Number(inv.is_manual) || !DAY_RE.test(String(inv.week_start || ""))) continue;
				const d = index.norm(inv.driver || "");
				if (!d || !index.isDaily(d)) continue;
				const printed = new Set(A.invoicePaidDaysOf(inv));
				const was = before.get(d) || new Map();
				const is = after.get(d) || new Map();
				for (let i = 0; i < 7; i++) {
					const day = addDays(inv.week_start, i);
					if (printed.has(day) && was.has(day) && !is.has(day)) rowOf(inv.invoice_number).notPaid.add(day);
					else if (!printed.has(day) && !was.has(day) && is.has(day)) rowOf(inv.invoice_number).added.set(day, is.get(day) / 100);
				}
			}
		}
		const list = [];
		for (const [number, row] of rows) {
			const inv = byNumber.get(number);
			if (!inv) continue;
			const daysNow = A.invoicePaidDaysOf(inv);
			const b12Days = row.b12Added ? row.b12Added.days : [];
			const b4Days = [...row.added.keys()].filter((d) => !b12Days.includes(d));
			const addedDays = sorted([...b12Days, ...b4Days]);
			const notPaidDays = sorted([...row.notPaid]);
			const repricedDays = row.repriced.filter((d) => !row.notPaid.has(d.day));
			const added = cents(row.b12Added ? row.b12Added.amount : 0) + b4Days.reduce((c, d) => c + cents(row.added.get(d)), 0);
			const repriced = repricedDays.reduce((c, d) => c + cents(d.scenario) - cents(d.printed), 0);
			const draft = inv.status === "Draft";
			const dropped = draft ? notPaidDays.reduce((c, d) => c + cents(gridTotal(inv, d)), 0) : 0;
			const difference = (added + repriced - dropped) / 100;
			if (!addedDays.length && !notPaidDays.length && !repricedDays.length) continue;
			const amountNow = round2(Number(inv.total_earnings) || 0);
			const correction = draft
				? (row.kind === "manual" ? "a person checks the line's rate before approving the Draft" : "regenerate the Draft once the flags are on")
				: difference ? (rateReport.weekTouchesClosed(A, inv) ? "correction draft" : "adjustment") : "none: stays as issued";
			const notes = [...row.notes];
			if (!draft && notPaidDays.length) notes.push(`${notPaidDays.length} day(s) the scenario would not pay stay as issued (${usd(notPaidDays.reduce((c, d) => c + gridTotal(inv, d), 0))})`);
			list.push({
				invoiceNumber: number, driver: label(index.norm(inv.driver || "")), status: inv.status, weekStart: inv.week_start, weekEnd: inv.week_end,
				daysNow, daysScenario: sorted([...daysNow.filter((d) => !row.notPaid.has(d)), ...addedDays]),
				addedDays, notPaidDays, repricedDays,
				amountNow, amountScenario: round2(amountNow + difference), difference: round2(difference), correction, notes,
			});
		}
		list.sort((p, q) => String(p.weekStart).localeCompare(String(q.weekStart)) || String(p.invoiceNumber).localeCompare(String(q.invoiceNumber)));
		invoicesBy[k] = list;
	}

	// Closed months and months before October: identical in every scenario.
	const scopeMonths = (fleet) => new Map(fleet.scopes.map((s) => [s.ownerId, { months: new Map(s.months.map((m) => [m.month, m])), items: s.items }]));
	const base = scopeMonths(await fleetOf("today"));
	for (const k of keys.slice(1)) {
		const other = scopeMonths(await fleetOf(k));
		for (const ownerId of new Set([...base.keys(), ...other.keys()])) {
			const a = base.get(ownerId) || { months: new Map(), items: [] };
			const b = other.get(ownerId) || { months: new Map(), items: [] };
			for (const m of new Set([...a.months.keys(), ...b.months.keys(), ...a.items.map((i) => i.month), ...b.items.map((i) => i.month)])) {
				if (!guarded(m)) continue;
				const same = JSON.stringify(a.months.get(m) || null) === JSON.stringify(b.months.get(m) || null)
					&& JSON.stringify(a.items.filter((i) => i.month === m)) === JSON.stringify(b.items.filter((i) => i.month === m));
				if (!same) problems.push({ scenario: k, ownerId, month: m, closed: A.isLocked(m), issue: `${m}'s payout ledger would change` });
			}
		}
		for (const inv of investors) {
			const a = payables.get("today").get(inv.ownerId);
			const b = payables.get(k).get(inv.ownerId);
			for (const m of new Set([...a.keys(), ...b.keys()])) {
				if (!guarded(m)) continue;
				const x = a.get(m) || { payable: 0, driverPay: 0 };
				const y = b.get(m) || { payable: 0, driverPay: 0 };
				if (cents(x.payable) !== cents(y.payable) || cents(x.driverPay) !== cents(y.driverPay)) {
					problems.push({ scenario: k, ownerId: inv.ownerId, month: m, closed: A.isLocked(m), issue: `${m}'s payable or driver pay would change` });
				}
			}
		}
	}
	const fingerprint = Object.fromEntries(rateReport.FINGERPRINTED.map((t) => [t, rateReport.closedRowsHash(db, t, closedMonths)]));

	// The earlier figures this report replaces (labels, not computations).
	const owner5 = investors.find((i) => i.ownerId === 5) ? (k) => octPayable(k, 5).payable : null;
	const w40 = invoicesBy.dailyRate.filter((i) => i.weekStart === W40_START).map((i) => ({ invoiceNumber: i.invoiceNumber, driver: i.driver, difference: i.difference }));
	const replaces = [
		{
			earlier: "investor 5 October payable $2,347 -> $722", source: "B12 production dry run, 2026-10-16, before the daily-rate merge",
			compare: "owner 5, today -> B12 alone", thisRun: owner5 ? { today: owner5("today"), b12: owner5("b12") } : null,
		},
		{
			earlier: "investor 5 October payable $1,969 -> $194", source: "B4 impact, replica, 2026-10-15: B12 off -> on, B4 applied",
			compare: "owner 5, B4 applied -> B12 with B4 applied (no daily rate)", thisRun: owner5 ? { b4Applied: owner5("b4Applied"), b12WithB4Applied: owner5("b12B4") } : null,
		},
		{
			earlier: "the daily-rate plan's driver: +$900 ledger, W40 invoice +$600", source: "daily-rate plan, replica, 2026-10-15",
			compare: "daily rate alone, October ledger change per driver and the W40 invoices",
			thisRun: {
				drivers: drivers.map((d) => ({ driver: d.driver, change: round2(d.byScenario.dailyRate.pay - d.byScenario.today.pay) })).filter((d) => d.change),
				w40Invoices: w40,
			},
		},
		{
			earlier: "B12 October driver pay +$3,250", source: "B12 production dry run, 2026-10-16",
			compare: "B12 alone, October driver pay", thisRun: { change: round2(driverTotals.b12.pay - driverTotals.today.pay) },
		},
	];

	const pdpFrom = A.PRE_DISPATCH_PAY_DAY_RULE_FROM || null;
	return {
		report: "october-flags", month: MONTH, latestClosedMonth: latestClosed, closedMonths,
		readAt: { iso: new Date(readAt).toISOString(), eastern: easternText(readAt, zone) },
		commit: "",
		settings: {
			LEDGER_DAY_ONCE_FROM: ledgerDayOnce.ruleFromEnv(env) || null,
			TRIP_WORK_DAYS_FROM: A.TRIP_WORK_DAYS_FROM || null,
			DRIVER_RATE_ONLY_FROM: A.DRIVER_RATE_ONLY_FROM || null,
			PAYOUT_RULES_V2_ENABLED: !!A.PAYOUT_RULES_V2_ENABLED,
			PRE_DISPATCH_PAY_DAY_RULE_FROM: pdpFrom,
			INVESTOR_LEASE_PAYOUTS_ENABLED: !!A.INVESTOR_LEASE_PAYOUTS_ENABLED,
			MARK_PAID_CLOSED_MONTH_ENABLED: !!A.MARK_PAID_CLOSED_MONTH_ENABLED,
			PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: !!A.PERSONAL_EXPENSE_DEDUCTIONS_ENABLED,
			RATECON_REISSUE_HOLD_ENABLED: !!A.RATECON_REISSUE_HOLD_ENABLED,
		},
		scenarios: SCENARIOS.map(([key, name]) => ({ key, name, ...PARTS[key] })),
		drivers, driverTotals, investors: investorRows, investorTotals,
		invoices: invoicesBy,
		b4Loads: b4.loads, b4InFlight: b4.loads.filter((l) => l.asDesigned.takesReady).map((l) => l.loadId),
		closedMonthsUnchanged: !problems.some((p) => p.closed),
		monthsBeforeUnchanged: !problems.some((p) => p.month && !p.closed),
		closedMonthsFingerprint: fingerprint,
		problems,
		replaces,
		generatedAt: new Date().toISOString(),
	};
}

function printText(r) {
	const lines = [];
	const cols = SCENARIOS.filter(([k]) => k !== "b4AsDesigned");
	const pad = (s, n) => String(s).padEnd(n);
	const lpad = (s, n) => String(s).padStart(n);
	lines.push(`October flags report (${r.month}): B12, the daily rate and B4, alone and together. Nothing was written.`);
	lines.push(`Data read once at ${r.readAt.eastern} (database snapshot and Job Tracking); app commit ${r.commit}; latest closed month ${r.latestClosedMonth || "none"}.`);
	const s = r.settings;
	lines.push(`Settings found (the app's .env, as the server reads them): LEDGER_DAY_ONCE ${s.LEDGER_DAY_ONCE_FROM ? `from ${s.LEDGER_DAY_ONCE_FROM}` : "off"}; TRIP_WORK_DAYS ${s.TRIP_WORK_DAYS_FROM || "off"}; DRIVER_RATE_ONLY ${s.DRIVER_RATE_ONLY_FROM || "off"}; PAYOUT_RULES_V2 ${s.PAYOUT_RULES_V2_ENABLED ? "on" : "off"}; PRE_DISPATCH_PAY_DAY_RULE ${s.PRE_DISPATCH_PAY_DAY_RULE_FROM ? `from ${s.PRE_DISPATCH_PAY_DAY_RULE_FROM}` : "off"}; INVESTOR_LEASE_PAYOUTS ${s.INVESTOR_LEASE_PAYOUTS_ENABLED ? "on" : "off"}; MARK_PAID_CLOSED_MONTH ${s.MARK_PAID_CLOSED_MONTH_ENABLED ? "on" : "off"}; PERSONAL_EXPENSE_DEDUCTIONS ${s.PERSONAL_EXPENSE_DEDUCTIONS_ENABLED ? "on" : "off"}; RATECON_REISSUE_HOLD ${s.RATECON_REISSUE_HOLD_ENABLED ? "on" : "off"}.`);
	lines.push(`Scenarios: B12 = TRIP_WORK_DAYS from ${r.month}; daily rate = DRIVER_RATE_ONLY from ${r.month}; B4 as designed = today's figures (stored loads unchanged); B4 applied = each --b4-ready load's Pickup Appointment set to its Ready date; all three = B12 + daily rate + B4 applied.`);
	const width = cols.map(([, name]) => Math.max(name.length, 14) + 2);
	const row = (first, cells) => `  ${pad(first, 22)}${cells.map((c, i) => lpad(c, width[i])).join("")}`;
	const days = (x) => `${x.days}d ${usd(x.pay)}`;
	lines.push("", "Driver October pay (payout ledger, daily-rate drivers; days, pay; B4 as designed = today):", row("driver", cols.map(([, name]) => name)));
	for (const d of r.drivers) lines.push(row(d.driver, cols.map(([k]) => days(d.byScenario[k]))));
	lines.push(row("total", cols.map(([k]) => days(r.driverTotals[k]))));
	lines.push("", "Investor October payable (after the loss carried forward; B4 as designed = today):", row("investor", cols.map(([, name]) => name)));
	for (const i of r.investors) lines.push(row(i.investor, cols.map(([k]) => usd(i.byScenario[k].payable))));
	lines.push(row("total", cols.map(([k]) => usd(r.investorTotals[k]))));
	for (const [k, name] of SCENARIOS.slice(1)) {
		const list = r.invoices[k] || [];
		lines.push("", `Invoices that would differ, ${name}: ${list.length || "none"}${k === "b4AsDesigned" ? " (stored loads unchanged)" : ""}`);
		for (const i of list) {
			const parts = [];
			if (i.addedDays.length) parts.push(`added ${i.addedDays.join(", ")}`);
			if (i.notPaidDays.length) parts.push(`not paid ${i.notPaidDays.join(", ")}`);
			if (i.repricedDays.length) parts.push(`repriced ${i.repricedDays.map((d) => `${d.day} ${usd(d.printed)} -> ${usd(d.scenario)}`).join(", ")}`);
			lines.push(`  ${i.invoiceNumber}  ${i.status}  week ${i.weekStart}  ${i.driver}  days ${i.daysNow.length} -> ${i.daysScenario.length}  ${usd(i.amountNow)} -> ${usd(i.amountScenario)} (${signed(i.difference)})  ${i.correction}`);
			lines.push(`      ${parts.join("; ")}${i.notes.length ? `; ${i.notes.join("; ")}` : ""}`);
		}
	}
	lines.push("", "B4 drop-trailer loads (--b4-ready): load, status, stored Pickup Appointment -> Ready date; as designed; applied:");
	for (const l of r.b4Loads) lines.push(`  ${l.loadId}  ${l.status || "(no status)"}  ${l.storedPickup || "(blank)"} -> ${l.ready}  as designed: ${l.asDesigned.reason}  applied: ${l.applied ? "yes" : `no, ${l.skipped}`}`);
	lines.push(`In-flight loads that would take the Ready date on their next rate-con email: ${r.b4InFlight.join(", ") || "none"}.`);
	lines.push("", `Closed months unchanged in every scenario: ${r.closedMonthsUnchanged ? "yes" : "NO"}. Months before ${r.month} unchanged: ${r.monthsBeforeUnchanged ? "yes" : "NO"}.`);
	lines.push(`Closed months' frozen rows (${r.closedMonths.join(", ") || "none"}): ${Object.entries(r.closedMonthsFingerprint).map(([t, f]) => `${t} ${f.rows} row(s) ${f.sha256.slice(0, 16)}`).join("; ")}.`);
	for (const p of r.problems) lines.push(`PROBLEM: ${p.scenario ? `${p.scenario}: ` : ""}${p.ownerId != null ? `owner ${p.ownerId}: ` : ""}${p.issue}`);
	lines.push("", "Figures this report replaces (earlier figure; this run's):");
	for (const e of r.replaces) {
		const t = e.thisRun;
		let now;
		if (!t) now = "owner 5 is not a settlable investor in this data";
		else if ("today" in t) now = `${usd(t.today)} -> ${usd(t.b12)}`;
		else if ("b4Applied" in t) now = `${usd(t.b4Applied)} -> ${usd(t.b12WithB4Applied)}`;
		else if ("change" in t) now = signed(t.change);
		else now = `${t.drivers.map((d) => `${d.driver} ${signed(d.change)} ledger`).join(", ") || "no ledger change"}; W40: ${t.w40Invoices.map((i) => `${i.invoiceNumber} (${i.driver}) ${signed(i.difference)}`).join(", ") || "no W40 invoice differs"}`;
		lines.push(`  - ${e.earlier} (${e.source}). This run, ${e.compare}: ${now}.`);
	}
	return lines.join("\n");
}

// The whole run, for the command line and the runner: { code, result, output }
// or { code, error }. `now` (epoch ms) is the read instant the lifted code's
// clock stops at (default: the clock); `loadSheet` reads Job Tracking once.
async function run({ argv = process.argv.slice(2), now = null, loadSheet = sheetFor } = {}) {
	const args = parseArgs(argv);
	try {
		const result = await compute(args, { now, loadSheet });
		const code = result.problems.length ? 1 : 0;
		return { code, result, output: args.json === true ? JSON.stringify(result, null, 1) : printText(result) };
	} catch (err) {
		if (err instanceof Refusal) return { code: 2, error: `REFUSED: ${err.message}` };
		return { code: 1, error: `ERROR: ${err.stack || err.message}` };
	}
}

module.exports = { run };

if (require.main === module) {
	run().then((out) => {
		if (out.error) console.error(out.error);
		else console.log(out.output);
		process.exitCode = out.code;
	});
}
