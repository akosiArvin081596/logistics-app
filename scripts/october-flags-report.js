#!/usr/bin/env node
// scripts/october-flags-report.js — the one combined "what would change" report
// for October the user asked for before any of the B12, daily-rate or B4 flags
// goes on (2026-10-16): each change alone and all three together, from one read
// of the data. Run it on the server with no login. Read-only: nothing is
// written anywhere.
//
// One read: the database is opened once, read-only, and read inside one read
// transaction (one snapshot); Job Tracking is read once inside it (--sheet-id,
// with the read-only scope, or --values-json), within 120 s, and both read times
// are printed. Every scenario computes from that data, with the lifted code's
// clock stopped at the snapshot. The app's .env is compared by hash at the start
// and the end (a change mid-run exits 1), and its APP_TIMEZONE must be the
// shell's (lib/ reads the shell's). Each scenario is this
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
// The headline (pay plan 2026-10-21, section 6; Arvin's e of 2026-10-21, which
// replaces the 2026-10-16 "each change alone and all three together") is "both":
// B12 + the daily rate (allThreeB4AsDesigned), today vs both, beside each change
// alone. B4 is opt-in: without --b4-ready its scenarios read as today's (B4
// applied = today, all three = both) and the report says it is left out.
// With it the report also gives:
//   - rates: the basis it prices by (R3). By default the data fix of pay
//     decisions a and b must be in place: its audit references RATE_FIX
//     present, and each driver of --rate-plan (the data fix's own plan file)
//     reading the plan's rate on every October day up to the data date with
//     both changes on; else it refuses. --simulate-rate-plan applies the plan to
//     a read-only in-memory copy of the snapshot instead (the file is never
//     written) and labels the run SIMULATED; --rates-as-recorded skips the gate
//     and labels the run "not final". Each daily-rate driver's October rate per
//     day, today vs both;
//   - ruleD (R4): rule d's reason for each driver-day both changes pay
//     differently from the daily rate alone, and per driver the waiting, rest
//     and dark days rule d does not pay, its loading-fallback days, lateTap
//     loads, loads whose reads failed (paid by their window), the days an issued
//     invoice keeps that rule d would not pay, the loads it pays by the old
//     window rule (tripWindowRule), and the possible drive days on cancelled
//     loads (Q17: from the Heading to Shipper tap to the cancel, the days the
//     truck drove; a person adds one with an "add" override);
//   - checkC (R5): each plan rate's first day in October, which live invoice
//     pays it and at what, beside the ledger today and both; and the days the
//     ledger pays with both changes on that a deleted correction draft named
//     (the invoice side keeps them out; the owner confirms they are not owed).
// --owner-note (R6) prints a plain note of 25 lines or fewer for the owner
// instead: October pay per driver and the investor payable, today -> both, each
// invoice that changes, rule d's counts and the send-by dates.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with;
// it lifts server.js up to 8 times and computes up to 13 payout ledgers, so run
// it at low priority with room for the heap, and expect several minutes: the
// run prints an estimate on stderr after its first ledger):
//   nice -n 10 node --max-old-space-size=4096 scripts/october-flags-report.js --db=app.db --sheet-id=<id> --rate-plan=<plan.json> [--b4-ready='{"<load id>":"YYYY-MM-DD"}'] [--key=service-account-key.json] [--names] [--json | --owner-note]
//   --rate-plan=<file>     the data fix's plan file (scripts/data-fix-driver-rates.js;
//                          kept outside the repository: it names drivers)
//   --simulate-rate-plan   price by --rate-plan applied in memory (SIMULATED)
//   --rates-as-recorded    price by the rates as recorded (not final)
//   --b4-ready=<json>      opt-in: the drop-trailer loads' Ready dates, read beforehand
//                          from their rate cons (the script reads no PDF and makes no
//                          other call): an object of load id -> YYYY-MM-DD
//   --sheet-id=env         the SPREADSHEET_ID the .env sets (refused when none)
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      with a copy of the database under the temp directory only
//   --names                name drivers and investors (default: "driver 1", …,
//                          numbered per run, and investors by owner id); for the
//                          owner note, whose file stays under ~/LogisX-replica/reports
//   --json                 print the whole result as JSON (default: a text report)
//   --owner-note           print the owner note (plain text) instead; a run that
//                          found a problem prints none (exit 1, the reason on stderr)
//   --dry-run              accepted; the run is always read-only
// Exit codes: 0 done, 1 error or a closed month would change, 2 refused (a
// malformed --b4-ready or --rate-plan, a missing input, no rate basis or the
// data fix not in place, October not open, B12 or the daily rate already on in
// the app's .env, so "today" would already include it, or a start record of
// either rule in the database, so one has already run).

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { createRequire } = require("module");
const { buildLedgerWorld, openDb, parseArgs, sheetFor, envFor } = require("./lib/ledger-world");
const { closure } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");
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
const SHEET_READ_TIMEOUT_MS = 120000;
// The worlds the run lifts and the payout ledgers it computes (six scenarios,
// and the work-days dry run twice for each of three), for the run-time note;
// without B4 the B4 worlds are today's and both's, so fewer.
const LIFTS = 8;
const LEDGER_RUNS = 12;
const LIFTS_NO_B4 = 4;
const LEDGER_RUNS_NO_B4 = 7;
// The data fix of pay decisions a and b (scripts/data-fix-driver-rates.js,
// approval arvin-2026-10-21-a-b): its audit rows carry "[<ref>-1]" .. "[<ref>-5]".
const RATE_FIX = { ref: "DRF-20261021", count: 5, actor: "system: data-fix-driver-rates" };
// A rule's start record: written the first time it runs (R8).
const START_KEYS = ["trip_work_days_started_at", "driver_rate_only.started"];
// Pay plan Q19: the note goes to the owner by this day, at the latest by the
// second, so both flags can go on before October's last batch (October closes Nov 15).
const SEND_BY = { by: "Fri Oct 30", latest: "Mon Nov 9" };
const OWNER_NOTE_MAX_LINES = 25;
// Rule d's dropped-day reasons the counts name (lib/trip-work-days.js).
const UNPAID_REASONS = ["waiting", "restDay", "dark", "lateTapGap"];
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
	"payoutRules", "invoiceTruckVidReader",
])];
const SCENARIOS = [
	["today", "today"],
	["b12", "B12 alone"],
	["dailyRate", "daily rate alone"],
	["b4AsDesigned", "B4 as designed"],
	["b4Applied", "B4 applied (3b)"],
	["allThree", "all three"],
	["allThreeB4AsDesigned", "both (B12 + daily rate)"],
];
// The headline: both changes, B12 + the daily rate (B4 as designed).
const BOTH = "allThreeB4AsDesigned";
// The scenarios that need B4's Ready dates; without them each reads as these.
const B4_ALIAS = { b4Applied: "today", allThree: BOTH, rateB4: "dailyRate", b12B4: "b12" };
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
// Absent: no B4 (opt-in, pay plan R1).
function parseReady(raw) {
	if (raw === undefined) return new Map();
	if (typeof raw !== "string") refuse("--b4-ready='{\"<load id>\":\"YYYY-MM-DD\"}' takes the drop-trailer loads' Ready dates ({} for none)");
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		refuse("--b4-ready is not JSON: give an object of load id -> YYYY-MM-DD");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) refuse("--b4-ready must be a JSON object of load id -> YYYY-MM-DD");
	const written = new Set();
	for (const id of topLevelKeys(raw)) {
		if (written.has(id)) refuse(`--b4-ready names load ${String(id).trim().slice(0, LOAD_ID_MAX)} twice`);
		written.add(id);
	}
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

// The keys of a JSON object's top level, as written (`text` already parsed as
// one object, so it is valid JSON): JSON.parse keeps the last of two equal keys,
// whatever their values, so a duplicate shows only here.
function topLevelKeys(text) {
	const keys = [];
	let depth = 0;
	let expectKey = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\"") {
			let j = i + 1;
			while (j < text.length && text[j] !== "\"") j += text[j] === "\\" ? 2 : 1;
			if (depth === 1 && expectKey) keys.push(JSON.parse(text.slice(i, j + 1)));
			expectKey = false;
			i = j;
		} else if (c === "{" || c === "[") {
			depth++;
			expectKey = depth === 1;
		} else if (c === "}" || c === "]") {
			depth--;
		} else if (c === "," && depth === 1) {
			expectKey = true;
		}
	}
	return keys;
}

// sha256 of the .env the run reads (or "absent"), to tell whether it changed
// during the run. The hash is compared, never printed.
function envHash(file) {
	try {
		return require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	} catch (err) {
		if (err.code === "ENOENT") return "absent";
		throw err;
	}
}

// --rate-plan: the data fix's plan file (scripts/data-fix-driver-rates.js, its
// readPlan() shape): { drivers: [{ name, payDaily?, rates: [{ from, rate }] }] },
// the rates in date order. Only what this report reads is checked; a message
// never prints a name.
function readRatePlan(file) {
	let plan;
	try {
		plan = JSON.parse(fs.readFileSync(String(file), "utf8"));
	} catch (err) {
		refuse(`--rate-plan ${err && err.code === "ENOENT" ? "names no file" : "is not a JSON plan"}`);
	}
	if (!plan || !Array.isArray(plan.drivers) || !plan.drivers.length) refuse("--rate-plan names no driver");
	const rate = (x) => typeof x === "number" && Number.isFinite(x) && x > 0 && Math.round(x * 100) === x * 100;
	return plan.drivers.map((d, i) => {
		const at = `--rate-plan driver ${i + 1}`;
		if (!d || typeof d.name !== "string" || !d.name.trim()) refuse(`${at}: no name`);
		if (d.payDaily !== undefined && !rate(d.payDaily)) refuse(`${at}: payDaily must be a rate above $0`);
		if (!Array.isArray(d.rates) || !d.rates.length) refuse(`${at}: no dated rates`);
		let prev = "";
		const rates = d.rates.map((s, j) => {
			if (!s || !isCalendarDay(s.from) || (prev && s.from <= prev)) refuse(`${at}, rate ${j + 1}: "from" must be a day (YYYY-MM-DD), in date order`);
			if (!rate(s.rate)) refuse(`${at}, rate ${j + 1}: the rate must be above $0`);
			prev = s.from;
			return { from: s.from, rate: s.rate };
		});
		return { name: d.name.trim(), payDaily: d.payDaily, rates };
	});
}
// A plan driver's rate on `day` (null before his first dated rate).
function planRateOn(rates, day) {
	let r = null;
	for (const s of rates) if (s.from <= day) r = s.rate;
	return r;
}

// server.js's normalizeDriverName(), lifted (the key pay_rate_history uses).
let NORMALIZE = null;
function liftedNormalizeDriverName() {
	if (!NORMALIZE) {
		const lifted = closure(serverSource({ root: ROOT }), { roots: ["normalizeDriverName"] });
		NORMALIZE = new Function(`"use strict";\n${lifted.text}\nreturn normalizeDriverName;`)();
	}
	return NORMALIZE;
}

// The instant a business day starts in `zone` (its midnight), as ISO text.
function midnightOf(day, zone) {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(appTime.wallClockToMs(zone, y, m, d, 0, 0, 0)).toISOString();
}

// --simulate-rate-plan: a read-only in-memory copy of `db`'s snapshot with the
// plan written as the data fix writes it (each driver's Drivers Database rate
// when the plan names one; a pay_rate_history row per dated rate at that day's
// midnight, source data-fix; a cover row for each seed row from the first
// dated rate on whose rate differs, sorting after it). No audit row. The file
// is never written: the copy lives in memory and is closed with the run.
function simulatedCopy(db, plan, zone) {
	const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");
	const norm = liftedNormalizeDriverName();
	const image = db.serialize();
	// A WAL database's header says so (bytes 18-19 are 2); a memory copy reads
	// only as a rollback-journal one.
	if (image[18] === 2) image[18] = 1;
	if (image[19] === 2) image[19] = 1;
	const mem = new Database(image);
	try {
		const directory = mem.prepare("SELECT id, driver_name FROM drivers_directory ORDER BY id").all();
		const ins = mem.prepare("INSERT INTO pay_rate_history (subject, subject_key, rate, effective_from, source) VALUES ('driver', ?, ?, ?, 'data-fix')");
		const seedsOf = mem.prepare("SELECT rate, effective_from FROM pay_rate_history WHERE subject = 'driver' AND subject_key = ? AND source = 'seed' ORDER BY effective_from, id");
		const setRate = mem.prepare("UPDATE drivers_directory SET pay_daily = ? WHERE id = ?");
		mem.transaction(() => {
			plan.forEach((d, i) => {
				const key = norm(d.name);
				const rows = directory.filter((r) => norm(r.driver_name) === key);
				if (rows.length !== 1) refuse(`--rate-plan driver ${i + 1} matches ${rows.length} Drivers Database rows; exactly one is needed`);
				if (d.payDaily !== undefined) setRate.run(d.payDaily, rows[0].id);
				const seeds = seedsOf.all(key);
				for (const s of d.rates) ins.run(key, s.rate, midnightOf(s.from, zone));
				for (const h of seeds) {
					const ms = Date.parse(h.effective_from);
					const day = Number.isFinite(ms) ? tripWorkDays.dayInZone(ms, zone) : "";
					const want = day && day >= d.rates[0].from ? planRateOn(d.rates, day) : null;
					if (want !== null && Number(h.rate) !== want) ins.run(key, want, h.effective_from);
				}
			});
		})();
		return new Database(mem.serialize(), { readonly: true });
	} finally {
		mem.close();
	}
}

// The data fix's audit references found (RATE_FIX), as "<ref>-<n>".
function rateFixRefs(db) {
	const found = new Set();
	const re = new RegExp(`\\[(${RATE_FIX.ref}-\\d+)\\]`, "g");
	for (const r of db.prepare("SELECT details FROM audit_trail WHERE username = ? AND user_id = 0 AND role = 'system'").all(RATE_FIX.actor)) {
		for (const m of String(r.details || "").matchAll(re)) found.add(m[1]);
	}
	return found;
}

// A rule's start record in app_settings (R8): the first one found, or "".
function startRecord(db) {
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get()) return "";
	const row = db.prepare(`SELECT key FROM app_settings WHERE key IN (${START_KEYS.map(() => "?").join(", ")}) ORDER BY key LIMIT 1`).get(...START_KEYS);
	return row ? row.key : "";
}

// A day -> rate function as runs of equal rates over October: [{ from, to, rate }].
function octoberRuns(rateOn) {
	const out = [];
	for (let d = `${MONTH}-01`; d.startsWith(MONTH); d = addDays(d, 1)) {
		const rate = round2(Number(rateOn(d)) || 0);
		const last = out[out.length - 1];
		if (last && last.rate === rate) last.to = d;
		else out.push({ from: d, to: d, rate });
	}
	return out;
}

// Job Tracking, once, or an error after SHEET_READ_TIMEOUT_MS: the database
// snapshot is held while it reads, so a stalled call must not hold it.
class SheetTimeout extends Error {}
function readSheetOnce(loadSheet, args) {
	let timer = null;
	const late = new Promise((resolve, reject) => {
		timer = setTimeout(() => reject(new SheetTimeout(`Job Tracking was not read within ${SHEET_READ_TIMEOUT_MS / 1000} s; nothing was computed. Run it again.`)), SHEET_READ_TIMEOUT_MS);
	});
	return Promise.race([Promise.resolve(loadSheet(args, ROOT)), late]).finally(() => clearTimeout(timer));
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

// Q17: the possible drive days on cancelled loads. A load whose last status row
// is a cancel, with a Heading to Shipper tap before it (after any earlier
// cancel), of a daily-rate driver, its span from the heading day to the cancel
// day touching October: the span's October days on which the truck's ELD shows
// driving (a fix faster than rule d's DRIVING_MPS, as its reader reads them;
// the device's link time is not applied), or every span day, flagged noEld, when
// the truck has no fix in the span. A cancelled load leaves every pay path, so a
// person checks these and adds a day with an "add" override.
async function cancelledDriveDays({ db, A, index, zone }) {
	const jt = await A.getJobTrackingCached();
	const headers = jt.headers || [];
	const cols = A.jobTrackingMonthCols(headers);
	if (!cols.loadIdCol || !cols.driverCol) return [];
	const vidOf = A.invoiceTruckVidReader(headers);
	const rowOf = new Map();
	for (const r of jt.data || []) {
		const k = tripWorkDays.statusKey(r[cols.loadIdCol]);
		if (k) rowOf.set(k, r);
	}
	const byLoad = new Map();
	for (const r of db.prepare("SELECT load_id, new_status, changed_at FROM load_status_history ORDER BY changed_at, id").all()) {
		const k = tripWorkDays.statusKey(r.load_id);
		const ms = tripWorkDays.stampMs(r.changed_at);
		if (!k || !Number.isFinite(ms)) continue;
		if (!byLoad.has(k)) byLoad.set(k, []);
		byLoad.get(k).push({ status: String(r.new_status || "").trim().toLowerCase().replace(/\s+/g, " "), ms });
	}
	const fixes = db.prepare("SELECT location_date_ms AS ms, speed FROM routemate_telemetry WHERE routemate_vehicle_id = ? AND dropped_reason = '' AND location_date_ms >= ? AND location_date_ms < ?");
	const isCancel = (e) => /^cancel/.test(e.status);
	const out = [];
	for (const [k, events] of byLoad) {
		const last = events[events.length - 1];
		if (!isCancel(last)) continue;
		const earlier = events.slice(0, -1).filter(isCancel).pop();
		const heading = events.find((e) => e.status === "heading to shipper" && e.ms <= last.ms && (!earlier || e.ms > earlier.ms));
		if (!heading) continue;
		const from = tripWorkDays.dayInZone(heading.ms, zone);
		const to = tripWorkDays.dayInZone(last.ms, zone);
		const row = rowOf.get(k);
		if (!row || to < `${MONTH}-01` || from > `${MONTH}-31`) continue;
		const key = index.norm(row[cols.driverCol] || "");
		if (!key || !index.isDaily(key)) continue;
		const span = [];
		for (let d = from; d <= to && span.length < tripWorkDays.MAX_TRIP_DAYS; d = addDays(d, 1)) if (d.startsWith(MONTH)) span.push(d);
		const vid = vidOf(row);
		const seen = new Set();
		const driving = new Set();
		if (vid) {
			for (const f of fixes.all(String(vid), Date.parse(`${from}T00:00:00Z`) - 86400000, Date.parse(`${to}T00:00:00Z`) + 2 * 86400000)) {
				const d = tripWorkDays.dayInZone(Number(f.ms), zone);
				seen.add(d);
				if ((Number(f.speed) || 0) > tripWorkDays.DRIVING_MPS) driving.add(d);
			}
		}
		const noEld = !span.some((d) => seen.has(d));
		const days = noEld ? span : span.filter((d) => driving.has(d));
		if (days.length) out.push({ key, loadId: String(row[cols.loadIdCol]).trim(), heading: from, cancelledOn: to, days, noEld });
	}
	return out.sort((p, q) => p.key.localeCompare(q.key) || p.heading.localeCompare(q.heading));
}

// The payout ledger's daily-rate days per driver: { month: { driver: { days, cents } }, days: driver -> Map(day -> cents) }.
// octoberDays: the same, only the days the ledger pays in October.
function ledgerDays(fleet) {
	const month = new Map();
	const days = new Map();
	const octoberDays = new Map();
	const percentage = new Map();
	const add = (map, it) => {
		if (!map.has(it.driver)) map.set(it.driver, new Map());
		const d = map.get(it.driver);
		d.set(it.day, (d.get(it.day) || 0) + it.cents);
	};
	for (const s of fleet.scopes) {
		for (const it of s.items) {
			if (it.kind === "driver_pay" && it.payType === "percentage" && it.month === MONTH) percentage.set(it.driver, (percentage.get(it.driver) || 0) + it.cents);
			if (it.kind !== "driver_pay" || it.payType !== "fixed" || !it.day) continue;
			add(days, it);
			if (it.month !== MONTH) continue;
			add(octoberDays, it);
			const m = month.get(it.driver) || { days: 0, cents: 0 };
			m.days++;
			m.cents += it.cents;
			month.set(it.driver, m);
		}
	}
	return { month, days, octoberDays, percentage };
}

async function compute(args, { now, loadSheet, log }) {
	if (!args.db || args.db === true) refuse("--db is required");
	const ready = parseReady(args["b4-ready"]);
	if (!args["values-json"] && (typeof args["sheet-id"] !== "string" || !args["sheet-id"])) refuse("--sheet-id (or --values-json) is required; there is no default sheet");
	// The rate basis (R3): the data fix in place (default), simulated, or the
	// rates as recorded; never two.
	const simulate = args["simulate-rate-plan"] === true;
	const asRecorded = args["rates-as-recorded"] === true;
	if (simulate && asRecorded) refuse("--simulate-rate-plan and --rates-as-recorded exclude each other");
	if (asRecorded && args["rate-plan"] !== undefined) refuse("--rates-as-recorded prices by the rates as recorded; it takes no --rate-plan");
	if (!asRecorded && (typeof args["rate-plan"] !== "string" || !args["rate-plan"])) {
		refuse("the report prices by the data fix of pay decisions a and b (scripts/data-fix-driver-rates.js): give its plan file with --rate-plan=<file> (add --simulate-rate-plan before the fix is applied), or say --rates-as-recorded");
	}
	const plan = asRecorded ? null : readRatePlan(args["rate-plan"]);
	const rateMode = asRecorded ? "asRecorded" : simulate ? "simulated" : "fixed";
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let env;
	let dbFile;
	try {
		({ env, file: dbFile } = envFor({ root: ROOT, dbPath: args.db, envFile }));
	} catch (err) {
		refuse(err.message);
	}
	const envPath = envFile || path.join(ROOT, ".env");
	const envAtStart = envHash(envPath);
	const quiet = () => {};
	const tripNow = tripWorkDays.ruleFromEnv(env, quiet);
	const rateNow = driverRateOnly.ruleFromEnv(env, quiet);
	if (tripNow || rateNow) {
		refuse(`the app's .env already has ${tripNow ? `TRIP_WORK_DAYS on from ${tripNow}` : `DRIVER_RATE_ONLY on from ${rateNow}`}, so "today" would already include it`);
	}
	// The lifted code reads the .env's APP_TIMEZONE; lib/ (the trip work-day
	// rule's days, app-time) reads this shell's. They must name one zone.
	const zone = appTime.resolveAppTimeZone(env.APP_TIMEZONE, quiet);
	const shellZone = appTime.appTimeZone();
	if (zone !== shellZone) refuse(`the app's .env sets APP_TIMEZONE ${zone}, but this shell runs ${shellZone}; run it with APP_TIMEZONE=${zone}`);
	const b4On = ready.size > 0;
	log(`October flags report: read-only, one snapshot; it lifts server.js ${b4On ? LIFTS : LIFTS_NO_B4} times and computes about ${b4On ? LEDGER_RUNS : LEDGER_RUNS_NO_B4} payout ledgers plus the investor payables. `
		+ "On the server run it as: nice -n 10 node --max-old-space-size=4096 scripts/october-flags-report.js ... A run-time estimate follows the first ledger.");

	const db = openDb({ root: ROOT, dbFile, readonly: true });
	let simDb = null;
	try {
		// One snapshot for every world: a read transaction held to the end. Job
		// Tracking is read inside it, under a time limit (readSheetOnce()).
		db.exec("BEGIN");
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'period_locks'").get()) {
			refuse("the database has no period_locks table, so its closed months cannot be told");
		}
		const latestClosed = ledgerDayOnce.latestClosedMonth(db);
		if (latestClosed && MONTH <= latestClosed) {
			refuse(`${MONTH} is at or before ${latestClosed}, the latest closed month. The rules may only start in an open month: closed months are final as recorded.`);
		}
		const started = startRecord(db);
		if (started) refuse(`the database holds ${started}: a rule this report compares has already run, so "today" is not before it`);
		let refs = null;
		if (rateMode === "fixed") {
			const found = rateFixRefs(db);
			const missing = Array.from({ length: RATE_FIX.count }, (_, i) => `${RATE_FIX.ref}-${i + 1}`).filter((r) => !found.has(r));
			if (missing.length) refuse(`the data fix is not in place: ${missing.join(", ")} not in the audit trail. Apply it first, or run with --simulate-rate-plan`);
			refs = [...found].sort();
		}
		if (rateMode === "simulated") simDb = simulatedCopy(db, plan, zone);
		const snapshotAt = Number.isFinite(now) ? now : Date.now();
		const commit = appCommit();
		const sheetData = await readSheetOnce(loadSheet, args);
		const sheetAt = Number.isFinite(now) ? now : Date.now();
		const result = await report({
			db: simDb || db, memoryCopy: !!simDb, args, envFile, sheetData, ready, snapshotAt, sheetAt, zone, env, latestClosed, names: args.names === true, log,
			rateBasis: { mode: rateMode, plan, refs },
		});
		result.commit = commit;
		const after = appCommit();
		if (after !== commit) result.problems.push({ scenario: "", issue: `the app's commit changed during the run (${commit} -> ${after}); run it again` });
		result.envUnchanged = envHash(envPath) === envAtStart;
		if (!result.envUnchanged) result.problems.push({ scenario: "", issue: "the app's .env changed during the run (compared by hash; no value is printed); run it again" });
		return result;
	} finally {
		if (simDb) simDb.close();
		if (db.inTransaction) db.exec("ROLLBACK");
		db.close();
	}
}

async function report({ db, memoryCopy, args, envFile, sheetData, ready, snapshotAt, sheetAt, zone, env, latestClosed, names, log, rateBasis }) {
	const world = (overrides, sheet) => buildLedgerWorld({
		root: ROOT, dbPath: args.db, readonly: true, sheetData: sheet, envFile, envOverrides: overrides, extraRoots: EXTRA_ROOTS, now: snapshotAt, db, memoryCopy,
	});
	const W = { today: world(null, sheetData) };
	const A = W.today.api;
	const b4On = ready.size > 0;
	const b4 = b4Plan(A, sheetData, ready);
	Object.assign(W, {
		b12: world(TRIP, sheetData),
		dailyRate: world(RATE, sheetData),
		allThreeB4AsDesigned: world({ ...TRIP, ...RATE }, sheetData),
	});
	if (b4On) {
		Object.assign(W, {
			b4Applied: world(null, b4.sheet),
			allThree: world({ ...TRIP, ...RATE }, b4.sheet),
			// Not reported on their own: B12's invoice days for all three, and the
			// B4 impact's "B12 on" for the figures this report replaces.
			rateB4: world(RATE, b4.sheet),
			b12B4: world(TRIP, b4.sheet),
		});
	} else {
		// No Ready dates: the B4 sheet is the stored one, so each B4 world is the
		// same world without B4 (B4_ALIAS).
		for (const [k, same] of Object.entries(B4_ALIAS)) W[k] = W[same];
	}
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
	const started = Date.now();
	ledger.set("today", ledgerDays(await fleetOf("today")));
	const first = (Date.now() - started) / 1000;
	const runs = b4On ? LEDGER_RUNS : LEDGER_RUNS_NO_B4;
	// Rough: the ledgers, and the investor payables at about half a ledger each world.
	log(`Run-time estimate: the first payout ledger took ${first.toFixed(1)} s; the run needs about ${runs} of them plus the payables: about ${Math.max(1, Math.ceil((first * runs * 1.5) / 60))} min.`);
	// Both changes' ledger, as computeFleetLedger() builds it by default but with
	// the trip rule's reading held here (lib/trip-work-days.js ledgerFacts(), the
	// lifted world's own environment), so each load's rule-d answer can be read
	// afterwards (ruleD).
	const bothApi = W[BOTH].api;
	const bothFacts = tripWorkDays.ledgerFacts({ db, env: { ...env, ...TRIP, ...RATE } });
	if (!bothFacts.tripDays) throw new Error("both changes' ledger has no trip rule");
	fleets.set(W[BOTH], await bothApi.computeFleetLedger({ rules: { ...bothApi.payoutRules(), tripFacts: bothFacts } }));
	for (const k of keys) if (!ledger.has(k)) ledger.set(k, ledgerDays(await fleetOf(k)));
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
	// Percentage drivers: none of the three changes touches their pay, so their
	// October pay must be the same in every scenario.
	const percentageKeys = sorted(keys.flatMap((k) => [...ledger.get(k).percentage.keys()]));
	const percentageDrivers = percentageKeys.map((d) => ({ driver: label(d), byScenario: Object.fromEntries(keys.map((k) => [k, (ledger.get(k).percentage.get(d) || 0) / 100])) }));

	// Invoices, by scenario.
	const live = db.prepare("SELECT * FROM invoices WHERE COALESCE(deleted_at, '') = '' ORDER BY week_start, id").all();
	const byNumber = new Map(live.map((inv) => [inv.invoice_number, inv]));
	const gridTotal = (inv, day) => {
		let snap = null;
		try { snap = JSON.parse(inv.render_data || "{}"); } catch { snap = null; }
		const cell = snap && snap.days ? snap.days[A.invoiceGridDayName(day)] : null;
		return cell && cell.completed ? Number(cell.total) || 0 : 0;
	};
	// Once per world (without B4 a B4 scenario's world is its twin's).
	const dryRuns = new Map();
	const dryRunOf = async (k) => {
		if (!dryRuns.has(W[k])) {
			const dry = await W[k].api.workDaysDryRun({ from: MONTH, to: MONTH, names: true });
			if (dry.refused) refuse(dry.reason);
			dryRuns.set(W[k], dry);
		}
		return dryRuns.get(W[k]);
	};
	// The world each scenario's B12 invoice days come from: the scenario without B12.
	const withoutTrip = { b12: "today", allThreeB4AsDesigned: "dailyRate", allThree: "rateB4" };
	// The scenario without B4, for the B4 ledger days.
	const withoutB4 = { b4Applied: "today", allThree: "allThreeB4AsDesigned" };
	// What the switch-on does with B12's added days, by the dry run's own
	// afterSwitchOn (settleLateWorkDays()): added to the invoice in place, or on a
	// correction Draft for that week, both paid; anything else (a blocker that
	// may already pay them, a week before the floor) is not added.
	const b12Pays = (afterSwitchOn) => /^(added to this invoice in place|a correction invoice)/.test(String(afterSwitchOn || ""));
	const REGENERATE = "regenerate the Draft once the flags are on";
	const problems = [];
	const invoicesBy = {};
	const refusedBy = {};
	for (const k of keys) {
		const parts = PARTS[k];
		const rows = new Map();
		const rowOf = (number) => {
			if (!rows.has(number)) rows.set(number, { b12: null, b12Held: null, b12NotPaid: new Set(), b12Pricing: [], rate: [], manual: false, b4Added: new Map(), b4NotPaid: new Set() });
			return rows.get(number);
		};
		const repricedOf = (r) => r.days.map((d) => ({ day: d.day, printed: d.printed, scenario: d.rule }));
		if (parts.rate) {
			const diff = rateReport.invoiceRateDiffs({ db, A: W[k].api, from: MONTH, index: await rateReport.driverIndex({ db, A: W[k].api }) });
			for (const r of [...diff.invoices, ...diff.drafts]) {
				const row = rowOf(r.invoiceNumber);
				row.rate = repricedOf(r);
				if (r.kind === "manual") row.manual = true;
			}
		} else if (parts.trip) {
			// A Draft regenerated with B12 on prices each day as the ledger does (the
			// driver-day price, driverDayRater()); an issued invoice is never regenerated.
			const diff = rateReport.invoiceRateDiffs({ db, A: W[k].api, from: MONTH, index: await rateReport.driverIndex({ db, A: W[k].api }) });
			for (const r of diff.drafts) if (r.kind === "weekly") rowOf(r.invoiceNumber).b12Pricing = repricedOf(r);
		}
		refusedBy[k] = [];
		if (parts.trip) {
			const dry = await dryRunOf(withoutTrip[k]);
			if (!dry.closedMonthsUnchanged || !dry.monthsBeforeFromUnchanged) {
				for (const p of dry.problems) problems.push({ scenario: k, ownerId: p.ownerId, issue: `B12 dry run: ${p.issue}`, closed: !!p.closed, beforeMonth: !!p.beforeFrom });
			}
			// A day a deleted correction Draft named is refused by the switch-on
			// (refusedDays kind deletedDraft; 2026-10-21 item 2), though the dry
			// run's per-invoice projection still adds it: it is left to a person.
			const held = new Map();
			for (const d of dry.refusedDays) if (d.kind === "deletedDraft") held.set(`${index.norm(d.driver)}\t${d.day}`, d);
			for (const p of dry.perInvoice) {
				const row = rowOf(p.invoiceNumber);
				const nm = index.norm(p.driver);
				const out = p.addedDays.filter((d) => held.has(`${nm}\t${d}`));
				// Every added day held: the projection's own amount (a day two loads
				// of different Assigned months name has one refused entry per load,
				// each at its own month's price; the projection prices the day once).
				const outAmount = out.length && out.length === p.addedDays.length ? round2(p.amountAdded)
					: round2(out.reduce((c, d) => c + held.get(`${nm}\t${d}`).amount, 0));
				row.b12 = { days: p.addedDays.filter((d) => !out.includes(d)), amount: round2(p.amountAdded - outAmount), action: p.afterSwitchOn, pays: b12Pays(p.afterSwitchOn) };
				if (out.length) row.b12Held = { days: out, amount: outAmount, reason: `not added: ${held.get(`${nm}\t${out[0]}`).reason}` };
				for (const d of p.droppedDays) row.b12NotPaid.add(d);
			}
			refusedBy[k] = dry.refusedDays.map((d) => ({ driver: label(index.norm(d.driver)), day: d.day, loadId: d.loadId, amount: d.amount, kind: d.kind, reason: d.reason }));
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
					if (printed.has(day) && was.has(day) && !is.has(day)) rowOf(inv.invoice_number).b4NotPaid.add(day);
					else if (!printed.has(day) && !was.has(day) && is.has(day)) rowOf(inv.invoice_number).b4Added.set(day, is.get(day) / 100);
				}
			}
		}
		const list = [];
		for (const [number, row] of rows) {
			const inv = byNumber.get(number);
			if (!inv) continue;
			const draft = inv.status === "Draft";
			const issuedAction = (c) => (c ? (rateReport.weekTouchesClosed(A, inv) ? "correction draft" : "adjustment") : "none: stays as issued");
			const notPaid = new Set([...row.b12NotPaid, ...row.b4NotPaid]);
			const printedCents = (days) => days.reduce((c, d) => c + cents(gridTotal(inv, d)), 0);
			const repricedCents = (list) => list.reduce((c, d) => c + cents(d.scenario) - cents(d.printed), 0);
			// Each change's own part, with what the switch-on does with it.
			const out = [];
			const notAdded = [];
			const b12Days = row.b12 ? row.b12.days : [];
			if (row.b12 && b12Days.length && row.b12.pays) out.push({ part: "B12", addedDays: b12Days, notPaidDays: [], repricedDays: [], cents: cents(row.b12.amount), action: row.b12.action });
			if (row.b12 && b12Days.length && !row.b12.pays) notAdded.push({ days: b12Days, amount: round2(row.b12.amount), reason: row.b12.action });
			if (row.b12Held) notAdded.push(row.b12Held);
			const b12Dropped = sorted([...row.b12NotPaid]);
			const b12Priced = row.b12Pricing.filter((d) => !notPaid.has(d.day));
			if (b12Dropped.length || b12Priced.length) {
				out.push({
					part: "B12", addedDays: [], notPaidDays: b12Dropped, repricedDays: b12Priced,
					cents: repricedCents(b12Priced) - (draft ? printedCents(b12Dropped) : 0), action: draft ? REGENERATE : "none: stays as issued",
				});
			}
			const ratePriced = row.rate.filter((d) => !notPaid.has(d.day));
			if (ratePriced.length) {
				const c = repricedCents(ratePriced);
				out.push({
					part: "daily rate", addedDays: [], notPaidDays: [], repricedDays: ratePriced, cents: c,
					action: draft ? (row.manual ? "a person checks the line's rate before approving the Draft" : REGENERATE) : issuedAction(c),
				});
			}
			const b4Days = [...row.b4Added.keys()].filter((d) => !b12Days.includes(d)).sort();
			const b4Dropped = sorted([...row.b4NotPaid].filter((d) => !row.b12NotPaid.has(d)));
			if (b4Days.length || b4Dropped.length) {
				const c = b4Days.reduce((t, d) => t + cents(row.b4Added.get(d)), 0) - (draft ? printedCents(b4Dropped) : 0);
				out.push({ part: "B4", addedDays: b4Days, notPaidDays: b4Dropped, repricedDays: [], cents: c, action: draft ? REGENERATE : issuedAction(c) });
			}
			if (!out.length && !notAdded.length) continue;
			const difference = out.reduce((c, p) => c + p.cents, 0) / 100;
			const daysNow = A.invoicePaidDaysOf(inv);
			const addedDays = sorted(out.flatMap((p) => p.addedDays));
			const notPaidDays = sorted(out.flatMap((p) => p.notPaidDays));
			const actions = [...new Set(out.map((p) => p.action))];
			const correction = actions.length === 1 ? actions[0]
				: actions.length ? out.map((p) => `${p.part}: ${p.action}`).filter((x, i, a) => a.indexOf(x) === i).join("; ")
					: notAdded.map((x) => x.reason).join("; ");
			const notes = [];
			if (!draft && notPaidDays.length) notes.push(`${notPaidDays.length} day(s) the scenario would not pay stay as issued (${usd(printedCents(notPaidDays) / 100)})`);
			const amountNow = round2(Number(inv.total_earnings) || 0);
			list.push({
				invoiceNumber: number, driver: label(index.norm(inv.driver || "")), status: inv.status, weekStart: inv.week_start, weekEnd: inv.week_end,
				daysNow, daysScenario: sorted([...daysNow.filter((d) => !notPaid.has(d)), ...addedDays]),
				addedDays, notPaidDays, repricedDays: out.flatMap((p) => p.repricedDays),
				amountNow, amountScenario: round2(amountNow + difference), difference: round2(difference), correction,
				parts: out.map((p) => ({ part: p.part, addedDays: p.addedDays, notPaidDays: p.notPaidDays, repricedDays: p.repricedDays, amount: p.cents / 100, action: p.action })),
				notAdded, notes,
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
				if (!same) problems.push({ scenario: k, ownerId, month: m, closed: A.isLocked(m), beforeMonth: !A.isLocked(m), issue: `${m}'s payout ledger would change` });
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
					problems.push({ scenario: k, ownerId: inv.ownerId, month: m, closed: A.isLocked(m), beforeMonth: !A.isLocked(m), issue: `${m}'s payable or driver pay would change` });
				}
			}
		}
	}
	let percentageDriversUnchanged = true;
	for (const d of percentageDrivers) {
		for (const k of keys.slice(1)) {
			if (cents(d.byScenario[k]) === cents(d.byScenario.today)) continue;
			percentageDriversUnchanged = false;
			problems.push({ scenario: k, issue: `${d.driver}'s October percentage pay would change (${usd(d.byScenario.today)} -> ${usd(d.byScenario[k])})` });
		}
	}
	const fingerprint = Object.fromEntries(rateReport.FINGERPRINTED.map((t) => [t, rateReport.closedRowsHash(db, t, closedMonths)]));

	// The rate basis (R3): with --rate-plan, every plan driver reads the plan's
	// rate on each October day up to the data date with both changes on (else
	// refused); and each daily-rate driver's October rate per day, today vs both.
	const bothIndex = await rateReport.driverIndex({ db, A: bothApi });
	const dataDay = appTime.dayInZone(snapshotAt, zone);
	const lastChecked = dataDay < `${MONTH}-31` ? dataDay : `${MONTH}-31`;
	const planDrivers = (rateBasis.plan || []).map((d, i) => {
		const k = bothIndex.norm(d.name);
		const rateOn = bothIndex.raterOf(k);
		if (d.payDaily !== undefined && cents((bothIndex.structs[k] || {}).payDaily) !== cents(d.payDaily)) {
			refuse(`--rate-plan driver ${i + 1}'s Drivers Database rate is ${usd(Number((bothIndex.structs[k] || {}).payDaily) || 0)}, not the plan's ${usd(d.payDaily)}`);
		}
		const first = d.rates[0].from > `${MONTH}-01` ? d.rates[0].from : `${MONTH}-01`;
		for (let day = first; day <= lastChecked; day = addDays(day, 1)) {
			const want = planRateOn(d.rates, day);
			if (want !== null && cents(rateOn(day, MONTH)) !== cents(want)) {
				refuse(`--rate-plan driver ${i + 1} reads ${usd(rateOn(day, MONTH))} on ${day} with both changes on, not the plan's ${usd(want)}: the data fix is not in place as planned`);
			}
		}
		return { key: k, rates: d.rates };
	});
	const rateKeys = sorted([...driverKeys, ...planDrivers.map((p) => p.key)]).filter((k) => index.isDaily(k));
	const october = rateKeys.map((k) => ({
		driver: label(k), today: octoberRuns((day) => index.raterOf(k)(day, MONTH)), both: octoberRuns((day) => bothIndex.raterOf(k)(day, MONTH)),
	}));
	const rates = { mode: rateBasis.mode, auditRefs: rateBasis.refs, planDrivers: planDrivers.map((p) => label(p.key)), checkedThrough: planDrivers.length ? lastChecked : null, october };

	// Rule d in both changes' figures (R4): each driver-day both changes pay
	// differently from the daily rate alone, with rule d's reason (the work-days
	// dry run's own perDay), and per driver what rule d left unpaid and how.
	const dryBoth = await dryRunOf(withoutTrip[BOTH]);
	const changedDays = dryBoth.perDay
		.filter((p) => p.month === MONTH && index.isDaily(index.norm(p.driver)))
		.map((p) => ({ driver: label(index.norm(p.driver)), day: p.day, change: p.change, reason: p.reason || (p.added ? "added override" : "other"), loadId: p.loadId, amount: p.amount }))
		.sort((p, q) => p.driver.localeCompare(q.driver) || p.day.localeCompare(q.day));
	const resolver = bothFacts.tripDays;
	const paidDays = new Map();
	const loadsOf = new Map();
	const driverOfLoad = new Map();
	for (const s of (await fleetOf(BOTH)).scopes) {
		for (const it of s.items) {
			if (it.kind !== "driver_pay" || it.payType !== "fixed" || !it.day) continue;
			const k = index.norm(it.driver);
			if (it.loadId) driverOfLoad.set(tripWorkDays.statusKey(it.loadId), k);
			if (it.month !== MONTH) continue;
			if (!paidDays.has(k)) paidDays.set(k, new Set());
			paidDays.get(k).add(it.day);
			if (it.loadId) {
				if (!loadsOf.has(k)) loadsOf.set(k, new Set());
				loadsOf.get(k).add(it.loadId);
			}
		}
	}
	// Per driver label.
	const counts = new Map();
	const countFor = (l) => {
		if (!counts.has(l)) counts.set(l, { driver: l, waiting: 0, restDay: 0, dark: 0, lateTapGap: 0, loadingFallback: 0, lateTapLoads: 0, noEldLoads: 0, errorLoads: 0, windowRuleLoads: 0, keptOnIssued: 0, cancelledDriveDays: 0 });
		return counts.get(l);
	};
	const countOf = (k) => countFor(label(k));
	for (const [k, loads] of loadsOf) {
		const c = countOf(k);
		const paid = paidDays.get(k) || new Set();
		const unpaid = new Map();
		const fallback = new Set();
		for (const id of loads) {
			const t = resolver.lastTrip(id);
			if (!t || (t.basis !== "trip" && t.basis !== "appointments")) continue;
			for (const [d, why] of Object.entries(t.dropped || {})) if (d.startsWith(MONTH) && !paid.has(d) && !unpaid.has(d)) unpaid.set(d, why);
			for (const [d, why] of Object.entries(t.reasons || {})) if (why === "loading-fallback" && paid.has(d)) fallback.add(d);
			if (t.flags && t.flags.lateTap) c.lateTapLoads++;
			if (t.flags && t.flags.noEld) c.noEldLoads++;
		}
		for (const why of unpaid.values()) if (UNPAID_REASONS.includes(why)) c[why]++;
		c.loadingFallback = fallback.size;
	}
	const named = (list) => list.map((x) => {
		const k = driverOfLoad.get(tripWorkDays.statusKey(x.loadId)) || "";
		if (k) countOf(k)[x.count]++;
		return { driver: k ? label(k) : "", loadId: x.loadId, reason: x.reason };
	});
	const errorLoads = named(resolver.errors().map((e) => ({ loadId: e.loadId, reason: e.error, count: "errorLoads" })));
	const windowRule = named(resolver.fallbacks().map((f) => ({ loadId: f.loadId, reason: f.reason, count: "windowRuleLoads" })));
	const keptOnIssued = (invoicesBy[BOTH] || []).filter((i) => i.status !== "Draft" && i.notPaidDays.length)
		.map((i) => ({ driver: i.driver, invoiceNumber: i.invoiceNumber, status: i.status, days: i.notPaidDays }));
	for (const x of keptOnIssued) countFor(x.driver).keptOnIssued += x.days.length;
	const cancelled = await cancelledDriveDays({ db, A, index, zone });
	for (const x of cancelled) countOf(x.key).cancelledDriveDays += x.days.length;
	const ruleD = {
		changedDays,
		drivers: [...counts.values()].sort((p, q) => p.driver.localeCompare(q.driver)),
		errorLoads, windowRule, keptOnIssued,
		cancelled: cancelled.map((x) => ({ driver: label(x.key), loadId: x.loadId, heading: x.heading, cancelledOn: x.cancelledOn, days: x.days, noEld: x.noEld })),
	};

	// Check c (R5): each plan rate's first day in October, which live invoice
	// pays it and at what, beside the ledger today and both; and the days a
	// deleted correction draft named that both changes' ledger pays.
	const payersOf = (k, day) => {
		const out = [];
		for (const inv of live) {
			// A Rejected invoice pays nothing (the pay plan's check c query).
			if (index.norm(inv.driver || "") !== k || inv.status === "Rejected") continue;
			if (!Number(inv.is_manual)) {
				if (inv.week_start <= day && inv.week_end >= day && A.invoicePaidDaysOf(inv).includes(day)) out.push({ invoiceNumber: inv.invoice_number, status: inv.status, amount: gridTotal(inv, day) });
				continue;
			}
			let snap = null;
			try { snap = JSON.parse(inv.render_data || "{}"); } catch { snap = null; }
			for (const l of (snap && Array.isArray(snap.lineItems) ? snap.lineItems : [])) {
				if (l && l.date === day) out.push({ invoiceNumber: inv.invoice_number, status: inv.status, amount: Number(l.amount) || 0 });
			}
		}
		return out;
	};
	// What the payout ledger pays the driver for the day in October (a day paid
	// in a closed month's frozen ledger is not October's).
	const ledgerOn = (k2, k, day) => ((ledger.get(k2).octoberDays.get(k) || new Map()).get(day) || 0) / 100;
	const rateDays = [];
	for (const p of planDrivers) {
		for (const s of p.rates) {
			if (!s.from.startsWith(MONTH)) continue;
			rateDays.push({ driver: label(p.key), day: s.from, planRate: s.rate, paidBy: payersOf(p.key, s.from), ledgerToday: ledgerOn("today", p.key, s.from), ledgerBoth: ledgerOn(BOTH, p.key, s.from) });
		}
	}
	// Once per driver-day (the dry run can name a day once per load).
	const deletedDraftDays = [];
	for (const d of (refusedBy[BOTH] || []).filter((x) => x.kind === "deletedDraft")) {
		const at = deletedDraftDays.find((x) => x.driver === d.driver && x.day === d.day);
		if (at) {
			if (d.loadId && !at.loadId.split(", ").includes(d.loadId)) at.loadId = `${at.loadId}, ${d.loadId}`;
			continue;
		}
		const k = [...labels.entries()].find(([, l]) => l === d.driver);
		const key = k ? k[0] : "";
		deletedDraftDays.push({ driver: d.driver, day: d.day, loadId: d.loadId, reason: d.reason, ledgerToday: key ? ledgerOn("today", key, d.day) : 0, ledgerBoth: key ? ledgerOn(BOTH, key, d.day) : 0 });
	}
	const checkC = { rateDays, deletedDraftDays };

	// The headline: both changes, today vs both.
	const headline = {
		scenario: BOTH, name: SCENARIOS.find(([k]) => k === BOTH)[1],
		drivers: drivers.map((d) => ({ driver: d.driver, today: d.byScenario.today, both: d.byScenario[BOTH] })),
		driverTotals: { today: driverTotals.today, both: driverTotals[BOTH] },
		investors: investorRows.map((i) => ({ ownerId: i.ownerId, investor: i.investor, today: i.byScenario.today.payable, both: i.byScenario[BOTH].payable })),
		investorTotals: { today: investorTotals.today, both: investorTotals[BOTH] },
		// The invoices that change (a row with only days left to a person is in
		// the full list, not here).
		invoices: (invoicesBy[BOTH] || []).filter((i) => i.difference || i.addedDays.length || i.notPaidDays.length),
	};

	// The earlier figures this report replaces (labels, not computations).
	const owner5 = investors.find((i) => i.ownerId === 5) ? (k) => octPayable(k, 5).payable : null;
	const w40 = invoicesBy.dailyRate.filter((i) => i.weekStart === W40_START).map((i) => ({ invoiceNumber: i.invoiceNumber, driver: i.driver, difference: i.difference }));
	const replaces = [
		{
			earlier: "investor 5 October payable $2,347 -> $722", source: "B12 production dry run, 2026-10-16, before the daily-rate merge",
			compare: "owner 5, today -> B12 alone", thisRun: owner5 ? { today: owner5("today"), b12: owner5("b12") } : null,
		},
		{
			earlier: "investor 5 October payable $1,969 -> $194", source: "B4 impact, computed 2026-10-16 ~05:00 ET on the replica copy of 2026-10-15: B12 off -> on, B4 applied",
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
		{
			earlier: "today $10,750 / 40 days, investor payable $2,169; both $14,700 / 49 days, payable $194",
			source: "this report's production run of 2026-10-16 (data 09:42 ET, commit 73be100), before rule d and the dated rates",
			compare: "October driver pay and the investor payable, today and both",
			thisRun: {
				today: { days: driverTotals.today.days, pay: driverTotals.today.pay, payable: investorTotals.today },
				both: { days: driverTotals[BOTH].days, pay: driverTotals[BOTH].pay, payable: investorTotals[BOTH] },
			},
		},
	];

	const pdpFrom = A.PRE_DISPATCH_PAY_DAY_RULE_FROM || null;
	return {
		report: "october-flags", month: MONTH, latestClosedMonth: latestClosed, closedMonths,
		readAt: { database: { iso: new Date(snapshotAt).toISOString(), eastern: easternText(snapshotAt, zone) }, sheet: { iso: new Date(sheetAt).toISOString(), eastern: easternText(sheetAt, zone) } },
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
		b4Included: b4On, headline, rates, ruleD, checkC,
		drivers, driverTotals, investors: investorRows, investorTotals, percentageDrivers, percentageDriversUnchanged,
		invoices: invoicesBy, refusedDays: refusedBy,
		b4Loads: b4.loads, b4InFlight: b4.loads.filter((l) => l.asDesigned.takesReady).map((l) => l.loadId),
		closedMonthsUnchanged: !problems.some((p) => p.closed),
		monthsBeforeUnchanged: !problems.some((p) => p.beforeMonth),
		closedMonthsFingerprint: fingerprint,
		problems,
		replaces,
		generatedAt: new Date().toISOString(),
	};
}

// The rate basis in one line (R3).
function basisLine(r) {
	const m = r.rates.mode;
	if (m === "simulated") return `SIMULATED: the rates are the data fix's plan applied in memory; the data fix is not in this database. Not final.`;
	if (m === "asRecorded") return "Rates as recorded: the data fix of pay decisions a and b is not applied. Not final.";
	return `Rates: the data fix is in place (${(r.rates.auditRefs || []).join(", ")}); its plan's rates checked through ${r.rates.checkedThrough || "n/a"}.`;
}

// Money for the owner: "$1,000" or "$1,012.50".
function money(x) {
	const n = Math.abs(Number(x) || 0);
	const text = n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
	return `${x < 0 ? "-" : ""}$${text}`;
}
const signedMoney = (x) => `${x > 0 ? "+" : ""}${money(x)}`;
const dayText = (d) => { const [, m, dd] = d.split("-").map(Number); return `${m}/${dd}`; };

// The owner note (R6): plain text, OWNER_NOTE_MAX_LINES lines or fewer.
function printOwnerNote(r) {
	const h = r.headline;
	const lines = [];
	const head = r.rates.mode === "fixed" ? "" : ` ${r.rates.mode === "simulated" ? "SIMULATED rates, not final" : "rates as recorded, not final"}.`;
	lines.push(`October pay, today vs with both changes (paid days rule + each driver's own daily rate). Data as of ${r.readAt.database.eastern}.${head}`);
	lines.push("Driver pay (days, $):");
	const plural = (n) => `${n} day${n === 1 ? "" : "s"}`;
	const driverLines = h.drivers.filter((d) => d.today.days || d.both.days)
		.map((d) => `- ${d.driver}: ${plural(d.today.days)}, ${money(d.today.pay)} -> ${plural(d.both.days)}, ${money(d.both.pay)} (${signedMoney(round2(d.both.pay - d.today.pay))})`);
	const t = h.driverTotals;
	const tail = [];
	tail.push(`Total driver pay: ${plural(t.today.days)}, ${money(t.today.pay)} -> ${plural(t.both.days)}, ${money(t.both.pay)}.`);
	tail.push(`Investor payable: ${money(h.investorTotals.today)} -> ${money(h.investorTotals.both)}${h.investors.length > 1 ? ` (${h.investors.map((i) => `${i.investor} ${money(i.today)} -> ${money(i.both)}`).join("; ")})` : ""}.`);
	const inv = h.invoices.map((i) => `${i.invoiceNumber} (${i.status}, ${signedMoney(i.difference)}: ${i.correction})`);
	tail.push(`Invoices that change: ${inv.length ? inv.join("; ") : "none"}.`);
	const sum = (f) => r.ruleD.drivers.reduce((c, d) => c + (d[f] || 0), 0);
	tail.push(`Paid-days rule: not paid ${sum("waiting")} waiting, ${sum("restDay")} rest and ${sum("dark")} no-ELD days; ${sum("loadingFallback")} loading days without a Loading tap; ${sum("lateTapLoads")} late Delivered loads; `
		+ `${sum("keptOnIssued")} days stay on issued invoices; ${sum("cancelledDriveDays")} possible drive days on cancelled loads (not paid; tell us any to add).`);
	if (r.ruleD.windowRule.length) tail.push(`Paid by appointment dates, not taps (dates don't fit): ${r.ruleD.windowRule.map((w) => `${w.driver} load ${w.loadId}`).join("; ")}.`);
	const deleted = r.checkC.deletedDraftDays;
	if (deleted.length) {
		tail.push(`${deleted.map((d) => `${d.driver} ${dayText(d.day)} (October ledger ${money(d.ledgerToday)} -> ${money(d.ledgerBoth)})`).join("; ")}: its correction was deleted as not valid, so no invoice pays it. Please confirm it isn't owed; we then mark it unpaid before the change goes on.`);
	}
	if (r.ruleD.errorLoads.length) tail.push(`Loads whose trip data could not be read (paid by dates): ${r.ruleD.errorLoads.length}.`);
	tail.push(`Please reply by ${SEND_BY.by} (at the latest ${SEND_BY.latest}): OK to switch both changes on for October? October closes Nov 15.`);
	const room = OWNER_NOTE_MAX_LINES - lines.length - tail.length;
	if (driverLines.length > room) {
		lines.push(...driverLines.slice(0, Math.max(0, room - 1)), `- and ${driverLines.length - Math.max(0, room - 1)} more drivers (full list in the report).`);
	} else {
		lines.push(...driverLines);
	}
	lines.push(...tail);
	return lines.join("\n");
}

function printText(r) {
	const lines = [];
	const cols = SCENARIOS.filter(([k]) => k !== "b4AsDesigned" && (r.b4Included || (k !== "b4Applied" && k !== "allThree")));
	const pad = (s, n) => String(s).padEnd(n);
	const lpad = (s, n) => String(s).padStart(n);
	lines.push(basisLine(r));
	lines.push(`October flags report (${r.month}): B12 and the daily rate, both and alone${r.b4Included ? ", and B4" : ""}. Nothing was written.`);
	const gap = Math.round((Date.parse(r.readAt.sheet.iso) - Date.parse(r.readAt.database.iso)) / 1000);
	lines.push(`Data read once: database snapshot ${r.readAt.database.eastern}, Job Tracking ${r.readAt.sheet.eastern} (${gap} s later); app commit ${r.commit}; latest closed month ${r.latestClosedMonth || "none"}; the .env unchanged during the run: ${r.envUnchanged ? "yes" : "NO"}.`);
	const s = r.settings;
	lines.push(`Settings found (the app's .env, as the server reads them): LEDGER_DAY_ONCE ${s.LEDGER_DAY_ONCE_FROM ? `from ${s.LEDGER_DAY_ONCE_FROM}` : "off"}; TRIP_WORK_DAYS ${s.TRIP_WORK_DAYS_FROM || "off"}; DRIVER_RATE_ONLY ${s.DRIVER_RATE_ONLY_FROM || "off"}; PAYOUT_RULES_V2 ${s.PAYOUT_RULES_V2_ENABLED ? "on" : "off"}; PRE_DISPATCH_PAY_DAY_RULE ${s.PRE_DISPATCH_PAY_DAY_RULE_FROM ? `from ${s.PRE_DISPATCH_PAY_DAY_RULE_FROM}` : "off"}; INVESTOR_LEASE_PAYOUTS ${s.INVESTOR_LEASE_PAYOUTS_ENABLED ? "on" : "off"}; MARK_PAID_CLOSED_MONTH ${s.MARK_PAID_CLOSED_MONTH_ENABLED ? "on" : "off"}; PERSONAL_EXPENSE_DEDUCTIONS ${s.PERSONAL_EXPENSE_DEDUCTIONS_ENABLED ? "on" : "off"}; RATECON_REISSUE_HOLD ${s.RATECON_REISSUE_HOLD_ENABLED ? "on" : "off"}.`);
	lines.push(`Scenarios: B12 = TRIP_WORK_DAYS from ${r.month}; daily rate = DRIVER_RATE_ONLY from ${r.month}; both = B12 + daily rate; B4 as designed = today's figures (stored loads unchanged)${r.b4Included ? "; B4 applied = each --b4-ready load's Pickup Appointment set to its Ready date; all three = B12 + daily rate + B4 applied" : ""}.`);
	if (!r.b4Included) lines.push("B4: not included (opt-in with --b4-ready); its scenarios read as today's and both's.");
	const width = cols.map(([, name]) => Math.max(name.length, 14) + 2);
	const row = (first, cells) => `  ${pad(first, 22)}${cells.map((c, i) => lpad(c, width[i])).join("")}`;
	const days = (x) => `${x.days}d ${usd(x.pay)}`;
	// The headline: both changes, today -> both.
	const h = r.headline;
	const two = (first, a, b, c) => `  ${pad(first, 22)}${lpad(a, 18)}${lpad(b, 18)}${lpad(c, 14)}`;
	lines.push("", `Both changes (B12 + daily rate), October, today -> both:`, two("driver", "today", "both", "change"));
	for (const d of h.drivers) lines.push(two(d.driver, days(d.today), days(d.both), signed(round2(d.both.pay - d.today.pay))));
	lines.push(two("total", days(h.driverTotals.today), days(h.driverTotals.both), signed(round2(h.driverTotals.both.pay - h.driverTotals.today.pay))));
	for (const i of h.investors) lines.push(two(`payable ${i.investor}`, usd(i.today), usd(i.both), signed(round2(i.both - i.today))));
	lines.push(two("payable, total", usd(h.investorTotals.today), usd(h.investorTotals.both), signed(round2(h.investorTotals.both - h.investorTotals.today))));
	lines.push(`  Invoices that change: ${h.invoices.length ? h.invoices.map((i) => `${i.invoiceNumber} ${i.status} ${signed(i.difference)} (${i.correction})`).join("; ") : "none"}.`);
	lines.push("", `October daily rate per day (${r.rates.mode === "fixed" ? "after the data fix" : r.rates.mode === "simulated" ? "SIMULATED data fix" : "rates as recorded"}), today -> both:`);
	const runsText = (list) => list.map((x) => `${x.from === x.to ? x.from.slice(5) : `${x.from.slice(5)}..${x.to.slice(5)}`} ${usd(x.rate)}`).join(", ");
	for (const d of r.rates.october) lines.push(`  ${pad(d.driver, 22)}${runsText(d.today)} -> ${runsText(d.both)}`);
	const rd = r.ruleD;
	lines.push("", `Rule d, both changes vs the daily rate alone: ${rd.changedDays.length} driver-day(s) change:`);
	for (const d of rd.changedDays) lines.push(`  ${pad(d.driver, 22)}${d.day}  ${d.change}  ${d.reason}  load ${d.loadId}  ${signed(d.amount)}`);
	lines.push("  Per driver (not paid: waiting, rest, dark, lateTap gap days; loading-fallback days; lateTap, no-ELD, read-error and window-rule loads; days issued invoices keep; possible drive days on cancelled loads):");
	for (const c of rd.drivers) {
		lines.push(`  ${pad(c.driver, 22)}waiting ${c.waiting}, rest ${c.restDay}, dark ${c.dark}, gap ${c.lateTapGap}; fallback ${c.loadingFallback}; lateTap ${c.lateTapLoads}, noEld ${c.noEldLoads}, error ${c.errorLoads}, window ${c.windowRuleLoads}; kept ${c.keptOnIssued}; cancelled ${c.cancelledDriveDays}`);
	}
	for (const x of rd.windowRule) lines.push(`  Paid by the window rule (tripWindowRule): ${x.driver} load ${x.loadId}: ${x.reason}`);
	for (const x of rd.errorLoads) lines.push(`  Read error, paid by the window: ${x.driver} load ${x.loadId}: ${x.reason}`);
	for (const x of rd.keptOnIssued) lines.push(`  Kept on issued invoice ${x.invoiceNumber} (${x.status}), ${x.driver}: ${x.days.join(", ")}`);
	for (const x of rd.cancelled) lines.push(`  Cancelled load ${x.loadId}, ${x.driver}: heading ${x.heading}, cancelled ${x.cancelledOn}; ${x.noEld ? "no ELD in the span, every day listed" : "drove"} ${x.days.join(", ")}: a person checks and adds with an "add" override`);
	lines.push("", "Check c: each plan rate's first day in October, who pays it (invoice, status, $), ledger today -> both:");
	for (const d of r.checkC.rateDays) {
		lines.push(`  ${pad(d.driver, 22)}${d.day} at ${usd(d.planRate)}: ${d.paidBy.length ? d.paidBy.map((p) => `${p.invoiceNumber} ${p.status} ${usd(p.amount)}`).join(", ") : "no live invoice"}; ledger ${usd(d.ledgerToday)} -> ${usd(d.ledgerBoth)}`);
	}
	if (!r.checkC.rateDays.length) lines.push("  (no plan, or no plan rate starts in October)");
	for (const d of r.checkC.deletedDraftDays) lines.push(`  Deleted correction draft named ${d.driver} ${d.day} (load ${d.loadId}): the invoice side keeps it out; ledger ${usd(d.ledgerToday)} -> ${usd(d.ledgerBoth)}. The owner confirms it is not owed.`);
	lines.push("", "Driver October pay (payout ledger, daily-rate drivers; days, pay; B4 as designed = today):", row("driver", cols.map(([, name]) => name)));
	for (const d of r.drivers) lines.push(row(d.driver, cols.map(([k]) => days(d.byScenario[k]))));
	lines.push(row("total", cols.map(([k]) => days(r.driverTotals[k]))));
	lines.push("", "Investor October payable (after the loss carried forward; B4 as designed = today):", row("investor", cols.map(([, name]) => name)));
	for (const i of r.investors) lines.push(row(i.investor, cols.map(([k]) => usd(i.byScenario[k].payable))));
	lines.push(row("total", cols.map(([k]) => usd(r.investorTotals[k]))));
	lines.push("", `Percentage drivers' October pay, the same in every scenario: ${r.percentageDriversUnchanged ? "yes" : "NO"}${r.percentageDrivers.length ? ` (${r.percentageDrivers.map((d) => `${d.driver} ${usd(d.byScenario.today)}`).join(", ")})` : " (none)"}.`);
	for (const [k, name] of SCENARIOS.slice(1)) {
		if (!r.b4Included && (k === "b4Applied" || k === "allThree")) continue;
		const list = r.invoices[k] || [];
		lines.push("", `Invoices that would differ, ${name}: ${list.length || "none"}${k === "b4AsDesigned" ? " (stored loads unchanged)" : ""}`);
		for (const i of list) {
			lines.push(`  ${i.invoiceNumber}  ${i.status}  week ${i.weekStart}  ${i.driver}  days ${i.daysNow.length} -> ${i.daysScenario.length}  ${usd(i.amountNow)} -> ${usd(i.amountScenario)} (${signed(i.difference)})  ${i.correction}`);
			for (const p of i.parts) {
				const what = [];
				if (p.addedDays.length) what.push(`added ${p.addedDays.join(", ")}`);
				if (p.notPaidDays.length) what.push(`not paid ${p.notPaidDays.join(", ")}`);
				if (p.repricedDays.length) what.push(`repriced ${p.repricedDays.map((d) => `${d.day} ${usd(d.printed)} -> ${usd(d.scenario)}`).join(", ")}`);
				lines.push(`      ${p.part}: ${what.join("; ")} (${signed(p.amount)}): ${p.action}`);
			}
			for (const x of i.notAdded) lines.push(`      B12, a person decides: ${x.days.join(", ")} (${usd(x.amount)}), left out of the amounts: ${x.reason}`);
			for (const n of i.notes) lines.push(`      ${n}`);
		}
		if (PARTS[k].trip) {
			const refused = r.refusedDays[k] || [];
			lines.push(`  Days B12 would not add automatically (worked by the trip timestamps; each with its own reason): ${refused.length || "none"}`);
			for (const d of refused) lines.push(`    ${d.driver}  ${d.day}  load ${d.loadId}  ${usd(d.amount)}  ${d.kind}: ${d.reason}`);
		}
	}
	if (r.b4Included) {
		lines.push("", "B4 drop-trailer loads (--b4-ready): load, status, stored Pickup Appointment -> Ready date; as designed; applied:");
		for (const l of r.b4Loads) lines.push(`  ${l.loadId}  ${l.status || "(no status)"}  ${l.storedPickup || "(blank)"} -> ${l.ready}  as designed: ${l.asDesigned.reason}  applied: ${l.applied ? "yes" : `no, ${l.skipped}`}`);
		lines.push(`In-flight loads that would take the Ready date on their next rate-con email: ${r.b4InFlight.join(", ") || "none"}.`);
	}
	lines.push("", `Closed months unchanged in every scenario: ${r.closedMonthsUnchanged ? "yes" : "NO"}. Months before ${r.month} unchanged: ${r.monthsBeforeUnchanged ? "yes" : "NO"}.`);
	lines.push(`Closed months' frozen rows (${r.closedMonths.join(", ") || "none"}): ${Object.entries(r.closedMonthsFingerprint).map(([t, f]) => `${t} ${f.rows} row(s) ${f.sha256.slice(0, 16)}`).join("; ")}.`);
	for (const p of r.problems) lines.push(`PROBLEM: ${p.scenario ? `${p.scenario}: ` : ""}${p.ownerId != null ? `owner ${p.ownerId}: ` : ""}${p.issue}`);
	lines.push("", "Figures this report replaces (earlier figure; this run's):");
	for (const e of r.replaces) {
		const t = e.thisRun;
		let now;
		if (!t) now = "owner 5 is not a settlable investor in this data";
		else if ("both" in t) now = `today ${t.today.days} days ${usd(t.today.pay)}, payable ${usd(t.today.payable)}; both ${t.both.days} days ${usd(t.both.pay)}, payable ${usd(t.both.payable)}`;
		else if ("today" in t) now = `${usd(t.today)} -> ${usd(t.b12)}`;
		else if ("b4Applied" in t) now = `${usd(t.b4Applied)} -> ${usd(t.b12WithB4Applied)}`;
		else if ("change" in t) now = signed(t.change);
		else now = `${t.drivers.map((d) => `${d.driver} ${signed(d.change)} ledger`).join(", ") || "no ledger change"}; W40: ${t.w40Invoices.map((i) => `${i.invoiceNumber} (${i.driver}) ${signed(i.difference)}`).join(", ") || "no W40 invoice differs"}`;
		lines.push(`  - ${e.earlier} (${e.source}). This run, ${e.compare}: ${now}.`);
	}
	return lines.join("\n");
}

// The whole run, for the command line and the runner: { code, result, output }
// or { code, error } (stalled: the Job Tracking read timed out and may still be
// pending). `now` (epoch ms) is the instant the lifted code's clock stops at
// (default: the snapshot's); `loadSheet` reads Job Tracking once; `log` takes
// the progress notes (stderr).
async function run({ argv = process.argv.slice(2), now = null, loadSheet = sheetFor, log = (msg) => console.error(msg) } = {}) {
	const args = parseArgs(argv);
	try {
		const result = await compute(args, { now, loadSheet, log });
		const code = result.problems.length ? 1 : 0;
		// The owner note has no room for a PROBLEM line: a run that found one
		// prints no note (the text or --json report shows the problems).
		if (args["owner-note"] === true && result.problems.length) {
			const listed = result.problems.map((p) => `${p.scenario ? `${p.scenario}: ` : ""}${p.ownerId != null ? `owner ${p.ownerId}: ` : ""}${p.issue}`).join("; ");
			return { code: 1, result, error: `owner note withheld: ${result.problems.length} problem(s): ${listed}` };
		}
		const output = args["owner-note"] === true ? printOwnerNote(result) : args.json === true ? JSON.stringify(result, null, 1) : printText(result);
		return { code, result, output };
	} catch (err) {
		if (err instanceof Refusal) return { code: 2, error: `REFUSED: ${err.message}` };
		if (err instanceof SheetTimeout) return { code: 1, error: `ERROR: ${err.message}`, stalled: true };
		return { code: 1, error: `ERROR: ${err.stack || err.message}` };
	}
}

module.exports = { run };

if (require.main === module) {
	run().then((out) => {
		if (out.error) console.error(out.error);
		else console.log(out.output);
		// A timed-out Sheets call would keep the process waiting on it.
		if (out.stalled) process.exit(out.code);
		process.exitCode = out.code;
	});
}
