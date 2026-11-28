#!/usr/bin/env node
// scripts/eld-time-only-cells-report.js: Part A of the time-only date cell fix, read-only and counts only. It runs on
// the served code before the fix is merged, and on any checkout after it. The fix makes the forward-only stop (check
// (5b')) read a Job Tracking date cell holding only a time of day as blank, as the pay paths read it
// (lib/eld-link-forward.js isTimeOnlyCell() and blankTimeOnlyCells(), through server.js eldLinkStopRows()).
//
// Every truck with a unit is judged twice, as the link routes judge an unlink, by the served readers lifted from the
// app's server.js (scripts/lib/server-lift.js): "before" on Job Tracking as read; "after" on the same one read through
// this script's copy of the fix's rule (map, never filter; each piece's text sha256-pinned to the fix's own, which
// scripts/test-eld-link-forward.js §7 checks). One unit's reach is eldLinkRowMonths(), eldLinkRowReach() and
// eldLinkBadCell(), then eldLinkForwardStop() at one instant and truckEditLockBlockers().
//
// It prints counts and fixed words only:
//   - per date column (pickup, drop-off, assigned, status update, completion, another date column): the cells holding
//     only a time, the cells holding a time and "Appt." (still unreadable after the fix), the other cells the stop
//     can't read; and the rows with a time-only cell;
//   - the trucks with a unit, and how each one's verdict moves when time-only cells read as blank;
//   - the trucks still refused after, by the stop's branch;
//   - the stop rule. Each of these is a STOP, to ask about before the merge: a truck that comes to pass while one of its
//     finalized-month rows is not completed (no Completion Date, and a status, by the app's own status column rule,
//     other than Delivered, Completed or POD Received); a truck with no time-only cell whose verdict moves at all; a
//     truck that comes to be refused.
//
// Read-only: the database is opened read-only (query_only checked) and read in one transaction (refused outside WAL,
// where that would hold the app's writers back); Job Tracking is read once (--sheet-id with the read-only scope, or
// --values-json), and the lifted readers never read it themselves; nothing is written. The app's settings go into this
// process first, as server.js loads them, so lib/ reads the business clock the app reads. An output that would name a
// truck, a device, a load or a driver is held back whole.
//
// Usage, from the app directory:
//   node scripts/eld-time-only-cells-report.js --db=app.db --sheet-id=<id> [--key=<key file>] [--at=<ISO instant>] [--lift-sha=<sha256>] [--json]
// or on standard input, for a checkout without this file (the served code before the merge):
//   node - --app=<app directory> --db=<app directory>/app.db --sheet-id=<id> [...] < scripts/eld-time-only-cells-report.js
//   --app=<dir>            the app directory (default: the checkout this file sits in)
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      the settings, for a copy of the database under the temp directory only
//   --at=<ISO instant>     judge as of this instant, in UTC (default: now)
//   --lift-sha=<sha256>    refuse unless the lifted readers' text has this sha256 (the reviewed code); the output always
//                          prints it
//   --print-pins           print the sha256 of this script's copy of each piece of the fix's rule, and stop
//   --json                 print the counts as JSON
// Exit codes: 0 done, no STOP; 3 done, a STOP; 1 an error, or an output held back; 2 refused (a missing or malformed
// input, a copy of the rule that is not the pinned one, readers that are not the pinned ones, a handle that is not
// read-only, a database not in WAL mode).

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createRequire } = require("module");

// The fix's rule, copied from lib/eld-link-forward.js. Each piece's text must stay the lib's byte for byte: PINS is
// checked at every run, and against the lib by scripts/test-eld-link-forward.js §7.
const TIME_ONLY_CELL_RE = /^(?:(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?|(?:0?[1-9]|1[0-2]):[0-5]\d(?::[0-5]\d)?[ \t\xa0]{0,2}[AaPp]\.?[Mm]\.?)$/;
const STOP_DATE_COLUMN_RE = /date|appo|appt/i;
function isTimeOnlyCell(text) {
	return TIME_ONLY_CELL_RE.test(String(text == null ? "" : text).trim());
}
function blankTimeOnlyCells(headers, rows) {
	const dateCols = [];
	(Array.isArray(headers) ? headers : []).forEach((h, i) => { if (STOP_DATE_COLUMN_RE.test(String(h || ""))) dateCols.push(i); });
	return (rows || []).map((row) => {
		if (!Array.isArray(row) || !dateCols.some((i) => isTimeOnlyCell(row[i]))) return row;
		const out = row.slice();
		for (const i of dateCols) if (isTimeOnlyCell(out[i])) out[i] = "";
		return out;
	});
}
const PINS = {
	TIME_ONLY_CELL_RE: "0dce46dd6cc908a10c42fd303c03928bd662e12ec925caf7e591d1f1f6d4155f",
	STOP_DATE_COLUMN_RE: "0e51591e40d040197ea71b387970c1fa0978ee35fbbfa7210b5a5a108f7678b0",
	isTimeOnlyCell: "05772c886c097d680f4e27b5cd249f7645caa75aa7a6399fefa9e4f5f1209ed6",
	blankTimeOnlyCells: "afd7c7b7ba0d4241cfdc4d93788335b07ac9abc035a3f113dc0e10e79ff7655b",
};

// What the read lifts from the served server.js (all of it there before the fix): the stop's row readers, its stop and
// the guard the routes call, the cell readers, the closed months and the rule's own decision.
const ROOTS = ["ELD_LINK_TRUCK_COL_RE", "eldLinkUnitKey", "sheetCellMonths", "sheetCellDate", "loadRowAccountingMonths", "eldLinkRowMonths",
	"eldLinkRowReach", "eldLinkBadCell", "eldLinkForwardStop", "truckEditLockBlockers", "lockedPeriodsDesc", "periodLocksReadable",
	"eldLinkForwardRule", "TRIP_WORK_DAYS_FROM"];
// What the read stands in for (a writer counts and writes nothing; a sheet read by the lifted code is counted and
// refused), and what it may never lift.
const PROVIDED = ["db", "require", "console", "process", "__dirname", "app", "requireRole", "refuseCrossOrigin", "refuseCrossSite",
	"notifyChange", "fetch", "getSheets", "SPREADSHEET_ID", "logAudit", "insertDispatchNotification", "emitDispatchNotice", "getJobTrackingCached"];
const DENIED = ["sheets", "KEY_FILE", "server", "io", "jtCacheInvalidate", "sendEmail", "transporter", "getDrive"];
// How a truck's verdict moves, in the order told.
const MOVES = [
	["toPass", "refused, now passing"],
	["cellToNoEnd", "a cell the stop can't read, now no end date"],
	["cellToRunning", "a cell the stop can't read, now still running or delivered less than 36 hours before"],
	["cellToCell", "a cell the stop can't read, now another cell it can't read"],
	["cellToNoDate", "a cell the stop can't read, now a row with no date"],
	["cellToNoLoadId", "a cell the stop can't read, now no Load ID (trip rule)"],
	["cellToTaps", "a cell the stop can't read, now the Delivered taps unreadable"],
	["unchanged", "unchanged"],
	["toRefused", "passing, now refused (none expected)"],
	["other", "another change"],
];
// The branches a truck can still be refused on, in the order told.
const BRANCHES = [
	["cell", "a date cell the stop can't read"],
	["nodate", "a row with no date"],
	["noend", "a finalized-month load with no end date"],
	["running", "a finalized-month load running on or after the day"],
	["noloadid", "a load with no Load ID (trip rule)"],
	["delivered", "a load delivered less than 36 hours before (trip rule)"],
	["taps", "the Delivered taps can't be read"],
	["locks", "the lock table can't be read"],
	["other", "another reason"],
];
const KINDS = [["pickup", "pickup"], ["dropoff", "drop-off"], ["assigned", "assigned"], ["statusUpdate", "status update"], ["completion", "completion"], ["other", "another date column"]];
// A time with "Appt." after it: still unreadable after the fix, counted on its own.
const APPT_RE = /^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?[ \t\xa0]{0,2}appt\.?$/i;
// The app's own status column (the first header naming a status), its completed statuses and its Completion Date
// column, as the status update route reads them.
const STATUS_COL_RE = /status/i;
const COMPLETED_RE = /^(delivered|completed|pod received)$/i;
const COMPLETION_COL_RE = /completion.*date/i;
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };
const coded = (code) => Object.assign(new Error(code), { code });
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const pinsNow = () => ({
	TIME_ONLY_CELL_RE: sha256(TIME_ONLY_CELL_RE), STOP_DATE_COLUMN_RE: sha256(STOP_DATE_COLUMN_RE),
	isTimeOnlyCell: sha256(isTimeOnlyCell), blankTimeOnlyCells: sha256(blankTimeOnlyCells),
});
const zeros = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

// --flag=value / --flag value / --flag, as scripts/lib/ledger-world.js parseArgs() reads them.
function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const eq = a.indexOf("=");
		if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
		else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
		else out[a.slice(2)] = true;
	}
	return out;
}

function kindOf(header) {
	const h = String(header || "");
	if (/pickup.*appo|pickup.*date/i.test(h)) return "pickup";
	if (/drop.?off.*appo|drop.?off.*date|delivery.*date/i.test(h)) return "dropoff";
	if (/assigned/i.test(h)) return "assigned";
	if (/status.*update/i.test(h)) return "statusUpdate";
	if (/completion/i.test(h)) return "completion";
	return "other";
}

// The stop's branch for one truck's unlink: "pass", or why it is refused.
function branchOf(lock, stop, locked, eldLinkForward) {
	if (lock.unreadable) return "locks";
	if (!lock.blockers.length) return "pass";
	if (!Array.isArray(stop.rows)) return !stop.cell ? "other" : stop.cell.header ? "cell" : "nodate";
	if (stop.unreadable) return "taps";
	const reaching = eldLinkForward.reachingRows(stop, locked);
	if (reaching.some((r) => r.byDay && r.row.lastDay === "")) return "noend";
	if (reaching.some((r) => r.byDay)) return "running";
	if (reaching.some((r) => r.byTail && r.row.noLoadId)) return "noloadid";
	return reaching.length ? "delivered" : "other";
}

const cellKey = (c) => (c ? [c.loadId, c.sheetRow, c.header, c.value].join("\u0000") : "");
// How one truck's verdict moved from `before` to `after` (each { branch, cell }).
function moveOf(before, after) {
	if (before.branch === after.branch && cellKey(before.cell) === cellKey(after.cell)) return "unchanged";
	if (after.branch === "pass") return "toPass";
	if (before.branch === "pass") return "toRefused";
	if (before.branch === "cell" || before.branch === "nodate") {
		if (after.branch === "noend") return "cellToNoEnd";
		if (after.branch === "running" || after.branch === "delivered") return "cellToRunning";
		if (after.branch === "cell") return "cellToCell";
		if (after.branch === "nodate") return "cellToNoDate";
		if (after.branch === "noloadid") return "cellToNoLoadId";
		if (after.branch === "taps") return "cellToTaps";
	}
	return "other";
}

// True when `text` holds `word` whole: no letter, digit or "_" right before or after it.
function namesWhole(text, word) {
	const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^A-Za-z0-9_])${esc}($|[^A-Za-z0-9_])`).test(text);
}

function report(r) {
	const cells = (k) => `${r.cells.timeOnly[k]} / ${r.cells.appt[k]} / ${r.cells.unreadable[k]}`;
	return [
		"eld-time-only-cells-report: Part A, what reading a time-only date cell as blank changes at the forward-only stop (read-only, counts only)",
		`judged at ${r.at}; the stop's day ${r.day}; closed months ${r.locked} (latest ${r.latest}); the forward-only rule in force: ${r.ruleInForce ? "yes" : "no"}; the trip rule: ${r.trip ? "on" : "off"}`,
		`the served readers' lift: ${r.lift}`,
		`Job Tracking: ${r.rows} row(s), read once; the lifted readers asked for it ${r.liftedSheetAsks} time(s)`,
		"date cells by column (a time only / a time and \"Appt.\" / other cells the stop can't read):",
		...KINDS.map(([k, words]) => `  ${words}: ${cells(k)}`),
		`  rows with a time-only cell: ${r.timeRows}`,
		`trucks with a unit: ${r.trucks} (holding a device: ${r.trucksWithDevice}); with a time-only cell on one of their rows: ${r.trucksWithTimeCells}`,
		"how each truck's verdict moves with time-only cells read as blank:",
		...MOVES.map(([k, words]) => `  ${words}: ${r.moves[k]}${k === "toPass" ? ` (holding a device: ${r.moves.toPassWithDevice})` : ""}`),
		`still refused with time-only cells read as blank: ${r.stillRefused.all}`,
		...BRANCHES.map(([k, words]) => `  ${words}: ${r.stillRefused[k]}`),
		"the stop rule:",
		`  trucks now passing with a finalized-month row that is not completed: ${r.stop.notCompleted} (expected 0)`,
		`  trucks with no time-only cell whose verdict moves: ${r.stop.noTimeCellMoved} (expected 0)`,
		`  trucks now refused: ${r.stop.toRefused} (expected 0)`,
		r.stop.fired ? "RESULT: STOP: ask before the merge" : "RESULT: no stop",
		`nothing was written: the database was opened read-only (query_only on) in one read transaction; writes the lifted code tried: ${r.writesTried}`,
	].join("\n");
}

async function main(argv) {
	const now = pinsNow();
	if (Object.keys(PINS).some((k) => PINS[k] !== now[k])) refuse("this script's copy of the fix's rule is not the pinned one");
	const args = parseArgs(argv);
	if (args["print-pins"]) {
		process.stdout.write(`${JSON.stringify(now)}\n`);
		return 0;
	}
	const fromFile = typeof __filename === "string" && path.isAbsolute(__filename) && fs.existsSync(__filename);
	const ROOT = typeof args.app === "string" ? path.resolve(args.app) : fromFile ? path.join(__dirname, "..") : null;
	if (!ROOT) refuse("--app=<the app directory> is required when this script comes on standard input");
	for (const f of ["server.js", "package.json", path.join("scripts", "lib", "ledger-world.js")]) if (!fs.existsSync(path.join(ROOT, f))) refuse(`the app directory holds no ${f}`);
	if (typeof args.db !== "string") refuse("--db=<app.db> is required");
	if (args["sheet-id"] === undefined && args["values-json"] === undefined) refuse("--sheet-id (or --values-json) is required; there is no default sheet");
	if (args.at !== undefined && !(typeof args.at === "string" && AT_RE.test(args.at) && Number.isFinite(Date.parse(args.at)))) refuse("--at must be an ISO instant in UTC, such as 2026-11-20T15:00:00Z");
	if (args["lift-sha"] !== undefined && !(typeof args["lift-sha"] === "string" && /^[0-9a-f]{64}$/.test(args["lift-sha"]))) refuse("--lift-sha must be a sha256 in hex");
	const atMs = args.at === undefined ? Date.now() : Date.parse(args.at);

	const ledgerWorld = require(path.join(ROOT, "scripts", "lib", "ledger-world.js"));
	const { closure } = require(path.join(ROOT, "scripts", "lib", "server-lift.js"));
	const { serverSource } = require(path.join(ROOT, "scripts", "lib", "server-source.js"));
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let scope;
	try { scope = ledgerWorld.envFor({ root: ROOT, dbPath: args.db, envFile }); } catch (err) { refuse(err.message); }
	const { env, file: dbFile } = scope;
	// The app's settings in this process, as server.js's dotenv loads them (a name already set wins), before any lib/
	// module loads: lib/ reads the business clock from here. The box runs in UTC.
	for (const [k, v] of Object.entries(env)) if (!Object.prototype.hasOwnProperty.call(process.env, k)) process.env[k] = v;
	if (!process.env.TZ) process.env.TZ = "UTC";

	const db = ledgerWorld.openDb({ root: ROOT, dbFile, readonly: true });
	try {
		db.pragma("query_only = ON");
		if (db.readonly !== true || db.pragma("query_only", { simple: true }) !== 1) refuse("the database handle is not read-only");
		if (String(db.pragma("journal_mode", { simple: true })).toLowerCase() !== "wal") refuse("the database is not in WAL mode, where one read transaction would hold the app's writers back");
		db.exec("BEGIN");

		const lifted = closure(serverSource({ root: ROOT }), { roots: ROOTS, provided: PROVIDED, denied: DENIED });
		const lift = sha256(lifted.text);
		if (args["lift-sha"] !== undefined && args["lift-sha"] !== lift) refuse("the served readers are not the pinned ones (--lift-sha)");
		const appRequire = createRequire(path.join(ROOT, "server.js"));
		const okRequire = (m) => m === "crypto" || m === "geolib" || /^\.\/lib\/[A-Za-z0-9_.-]+$/.test(m);
		const tried = { writes: 0, sheetAsks: 0 };
		const ClockDate = class extends Date {
			constructor(...a) { super(...(a.length ? a : [atMs])); }
			static now() { return atMs; }
		};
		const pass = () => (req, res, next) => (next ? next() : undefined);
		const deps = {
			db,
			require: (m) => { if (!okRequire(m)) throw coded("READ_REQUIRE"); return appRequire(m); },
			console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
			process: { env: { ...env }, argv: [], cwd: () => ROOT, exit: () => { throw coded("READ_EXIT"); } },
			__dirname: ROOT,
			app: { get() {}, post() {}, put() {}, delete() {}, patch() {}, use() {} },
			requireRole: pass,
			refuseCrossOrigin: pass(),
			refuseCrossSite: pass(),
			notifyChange: () => {},
			fetch: () => { throw coded("READ_FETCH"); },
			getSheets: async () => { tried.sheetAsks++; throw coded("READ_SHEET"); },
			SPREADSHEET_ID: "",
			logAudit: () => { tried.writes++; },
			insertDispatchNotification: { run() { tried.writes++; } },
			emitDispatchNotice: () => { tried.writes++; },
			getJobTrackingCached: async () => { tried.sheetAsks++; throw coded("READ_JOB_TRACKING"); },
			Date: ClockDate,
		};
		const body = ['"use strict";', lifted.text, `return { ${ROOTS.join(", ")} };`].join("\n");
		const api = new Function(...Object.keys(deps), body)(...Object.values(deps));
		const eldLinkForward = require(path.join(ROOT, "lib", "eld-link-forward.js"));

		const sheetData = await ledgerWorld.sheetFor(args, ROOT);
		const values = sheetData && Array.isArray(sheetData.values) ? sheetData.values : null;
		if (!values || !values.length) refuse("Job Tracking came back with no header row");
		const headers = values[0] || [];
		const asRead = values.slice(1);
		const asBlank = blankTimeOnlyCells(headers, asRead);

		const truckCols = [];
		headers.forEach((h, i) => { if (api.ELD_LINK_TRUCK_COL_RE.test(String(h || ""))) truckCols.push(i); });
		const unitsOf = (row) => (Array.isArray(row) ? truckCols.map((i) => api.eldLinkUnitKey(row[i])).filter(Boolean) : []);

		// Every date cell, by column: a time only, a time and "Appt.", or other text the stop can't read.
		const cells = { timeOnly: zeros(KINDS.map(([k]) => k)), appt: zeros(KINDS.map(([k]) => k)), unreadable: zeros(KINDS.map(([k]) => k)) };
		const dateCols = [];
		headers.forEach((h, i) => { if (STOP_DATE_COLUMN_RE.test(String(h || ""))) dateCols.push(i); });
		for (const row of asRead) {
			if (!Array.isArray(row)) continue;
			for (const i of dateCols) {
				const text = String(row[i] == null ? "" : row[i]).trim();
				if (!text) continue;
				const kind = kindOf(headers[i]);
				if (isTimeOnlyCell(text)) cells.timeOnly[kind]++;
				else if (APPT_RE.test(text)) cells.appt[kind]++;
				else if (api.sheetCellMonths(text) === null || api.sheetCellDate(text) === null) cells.unreadable[kind]++;
			}
		}
		for (const c of Object.values(cells)) c.all = KINDS.reduce((n, [k]) => n + c[k], 0);
		const timeUnits = new Set();
		let timeRows = 0;
		asRead.forEach((row, n) => {
			if (asBlank[n] === row) return;
			timeRows++;
			for (const u of unitsOf(row)) timeUnits.add(u);
		});

		const locksReadable = api.periodLocksReadable();
		const locked = locksReadable ? api.lockedPeriodsDesc() : [];
		const isLocked = new Set(locked);
		const reachOf = (rows, unit) => {
			const months = api.eldLinkRowMonths(headers, rows, unit);
			const reach = months === null ? null : api.eldLinkRowReach(headers, rows, unit, { firstSheetRow: 2 });
			return { months, reach, cell: reach === null ? api.eldLinkBadCell(headers, rows, unit, 2) : null };
		};
		const verdict = (truck, rows) => {
			const { months, reach, cell } = reachOf(rows, truck.unit_number);
			const stop = { ...api.eldLinkForwardStop(reach, atMs), cell };
			const lock = api.truckEditLockBlockers(truck, { routemate_vehicle_id: "" }, { eldLinkMonths: months, eldLinkForward: stop });
			return { branch: branchOf(lock, stop, locked, eldLinkForward), cell };
		};
		// The stop rule's row test: a row of the unit whose months (read as the fix reads them) hold a finalized month, with
		// no Completion Date and a status that is not a completed one.
		const statusCol = headers.findIndex((h) => STATUS_COL_RE.test(String(h || "")));
		const completionCol = headers.findIndex((h) => COMPLETION_COL_RE.test(String(h || "")));
		const openFinalizedRow = (unit) => asBlank.some((row) => {
			if (!Array.isArray(row) || !unitsOf(row).includes(api.eldLinkUnitKey(unit))) return false;
			const months = api.loadRowAccountingMonths(headers, row) || [];
			if (!months.some((m) => isLocked.has(m))) return false;
			const completedOn = completionCol >= 0 && api.sheetCellDate(row[completionCol]) !== null;
			const completedStatus = statusCol >= 0 && COMPLETED_RE.test(String(row[statusCol] == null ? "" : row[statusCol]).trim());
			return !completedOn && !completedStatus;
		});

		const trucks = db.prepare("SELECT * FROM trucks WHERE TRIM(COALESCE(unit_number, ?)) <> ? ORDER BY id").all("", "");
		const moves = { ...zeros(MOVES.map(([k]) => k)), toPassWithDevice: 0 };
		const stillRefused = zeros(["all", ...BRANCHES.map(([k]) => k)]);
		const stop = { notCompleted: 0, noTimeCellMoved: 0, toRefused: 0, fired: false };
		let trucksWithDevice = 0;
		let trucksWithTimeCells = 0;
		for (const t of trucks) {
			const device = String(t.routemate_vehicle_id == null ? "" : t.routemate_vehicle_id).trim() !== "";
			const hasTime = timeUnits.has(api.eldLinkUnitKey(t.unit_number));
			if (device) trucksWithDevice++;
			if (hasTime) trucksWithTimeCells++;
			const before = verdict(t, asRead);
			const after = verdict(t, asBlank);
			const move = moveOf(before, after);
			moves[move]++;
			if (move === "toPass" && device) moves.toPassWithDevice++;
			if (move === "toPass" && openFinalizedRow(t.unit_number)) stop.notCompleted++;
			if (move !== "unchanged" && !hasTime) stop.noTimeCellMoved++;
			if (move === "toRefused") stop.toRefused++;
			if (after.branch !== "pass") {
				stillRefused.all++;
				stillRefused[after.branch]++;
			}
		}
		stop.fired = stop.notCompleted + stop.noTimeCellMoved + stop.toRefused > 0;
		const rule = api.eldLinkForwardRule();
		const result = {
			at: new Date(atMs).toISOString(),
			day: eldLinkForward.earliestLocalDay(atMs),
			locked: locked.length,
			latest: locked.length ? locked.slice().sort()[locked.length - 1] : "none",
			lockTableReadable: !!locksReadable,
			ruleInForce: !!(rule && rule.inForce),
			trip: !!api.TRIP_WORK_DAYS_FROM,
			lift,
			rows: asRead.length,
			liftedSheetAsks: tried.sheetAsks,
			cells,
			timeRows,
			trucks: trucks.length,
			trucksWithDevice,
			trucksWithTimeCells,
			moves,
			stillRefused,
			stop,
			writesTried: tried.writes,
		};
		db.exec("COMMIT");

		// Every truck, device, load and driver the read saw: an output holding one whole is held back.
		const seen = new Set();
		const keep = (v) => { const s = String(v == null ? "" : v).trim(); if (s.length >= 4) seen.add(s); };
		for (const t of db.prepare("SELECT unit_number, routemate_vehicle_id, assigned_driver FROM trucks").all()) {
			keep(t.unit_number);
			keep(t.routemate_vehicle_id);
			keep(t.assigned_driver);
		}
		headers.forEach((h, i) => {
			if (!truckCols.includes(i) && !/^driver$|load.?id|job.?id/i.test(String(h || "").trim())) return;
			for (const row of asRead) if (Array.isArray(row)) keep(row[i]);
		});
		const text = args.json ? JSON.stringify(result, null, 2) : report(result);
		if ([...seen].some((w) => namesWhole(text, w))) {
			process.stderr.write("held back: the output would name a truck, a device, a load or a driver; nothing printed\n");
			return 1;
		}
		process.stdout.write(`${text}\n`);
		return stop.fired ? 3 : 0;
	} finally {
		if (db.inTransaction) db.exec("ROLLBACK");
		db.close();
	}
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
	if (err instanceof Refusal) {
		process.stderr.write(`refused: ${err.message}\n`);
		process.exitCode = 2;
		return;
	}
	// Fixed words only: an error's own text can carry a sheet's id or a cell.
	const code = err && typeof err.code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(err.code) ? err.code : "ERROR";
	process.stderr.write(`error: ${code} (${err && err.name ? String(err.name).replace(/[^A-Za-z]/g, "") : "Error"})\n`);
	process.exitCode = 1;
});
