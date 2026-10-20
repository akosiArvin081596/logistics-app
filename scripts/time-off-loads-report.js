#!/usr/bin/env node
// scripts/time-off-loads-report.js — R11b's follow-up, the read-only list the
// user chose over a backfill (2026-10-16): every driver time-off row recorded
// since --since (R11 went on in production at 03:00 ET that day), or whose days
// were changed since, with the loads of his that its days cover, checked the way
// R11b's warning (lib/driver-availability.js loadsNewlyInTimeOff()) would have
// checked them when the time off was saved. Read-only: the database is opened
// with a read-only handle (checked), Job Tracking is read from a saved values.get
// or with the spreadsheets.readonly scope, and nothing is written anywhere: no
// database row, sheet cell, audit row or file. The output names real drivers:
// print it to the terminal or redirect it outside the repo, never into it.
//
// Which rows: driver_availability rows recorded (created_at) at or after
// --since, and older ones whose days a change at or after --since moved. A row's
// saves are rebuilt from the audit lines R11 writes for it (its create line, then
// each update line "old days -> new days"); a kind or reason change alone moves
// no days. A row the audit log does not fully account for (logAudit() is best
// effort) is listed when its created_at or updated_at is at or after --since,
// checked as of its last change, and flagged; one whose created_at cannot be read
// is counted, not listed. Cancelled and ended rows are listed too, with their
// state (cancelled, ended, current or upcoming, as of today).
//
// Which loads: Job Tracking's live loads as the server reads them for the
// warning (its own driverLoadsForTimeOff(), as a Super Admin sees them, so every
// Load ID as stored; cancelled and soft-deleted loads left out), matched to the
// row's driver (his directory row's current name) through normalizeDriverName().
// Each save asks loadsNewlyInTimeOff() which loads it brought in, with that
// save's business day as "today" (APP_TIMEZONE, America/New_York unless set) and,
// for a change, the row's days before it. A load is listed when the row's days
// still cover it, as of the latest save that brought it in. So the list shows
// what the warning would have named at that save, not what it would name now: a
// load that had ended before the save day is not listed, nor one the row was
// moved off.
//   already had  yes when its Assigned Date (read with sheetDayKey()) is on or
//                before that save's day, no when after; unknown when blank or
//                unreadable
//   confirmed    a driver_availability_confirmations row for this time off and
//                this load (none are expected while
//                DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED is off)
// Loads the warning skips are skipped and counted per row: no readable pickup or
// drop-off day, or a Load ID over 64 characters (timeOffLoadSkip()).
//
// Usage:
//   node scripts/time-off-loads-report.js --db=<app.db> --values-json=<file> [--since=<instant>] [--json]
//   node scripts/time-off-loads-report.js --db=app.db --sheet-id=<id> [--key=service-account-key.json] [--since=<instant>] [--json]
//   --db=<file>           the database, opened read-only; it must exist. Any copy,
//                         a replica working copy's app.db included: this report
//                         reads no setting from any .env, so it is not held to
//                         the app directory's own database as the money dry runs
//                         are (scripts/lib/ledger-world.js dbScope())
//   --values-json=<file>  a saved values.get of the Job Tracking tab
//   --sheet-id=<id>       Job Tracking read with the read-only scope
//                         (scripts/lib/ledger-world.js sheetFor(); =env takes the
//                         app's .env SPREADSHEET_ID, for the app's own app.db only)
//   --since=<instant>     an ISO instant with its zone; default 2026-10-16T07:00:00Z
//   --json                the whole result as JSON (default: a text report)
// On a WAL database whose -wal and -shm files are absent, SQLite's read-only open
// creates them, empty, beside it (as for every read-only script here); the
// database file itself is never written.
// Exit codes: 0 done, 1 error, 2 refused (an input or the database missing, a
// since that is not an instant, a database or sheet without what this reads).

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { parseArgs, sheetFor, openDb } = require("./lib/ledger-world");
const { closure } = require("./lib/server-lift");
const driverAvailability = require("../lib/driver-availability");
const appTime = require("../lib/app-time");
const { stampMs } = require("../lib/eld-feed-health");

const ROOT = path.join(__dirname, "..");
const DEFAULT_SINCE = "2026-10-16T07:00:00Z";
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TABLES = ["driver_availability", "drivers_directory", "driver_availability_confirmations", "audit_trail"];
// The audit lines server.js writes when time off is recorded and changed:
// "<name>: off <from>..<to> (<kind>)" and
// "<name>: off <old from>..<old to> (<kind>) -> off <from>..<to> (<kind>)".
const DAYS = "(\\d{4}-\\d{2}-\\d{2})\\.\\.(\\d{4}-\\d{2}-\\d{2}) \\([a-z_]{1,20}\\)";
const CREATE_LINE_RE = new RegExp(`: off ${DAYS}`);
const UPDATE_LINE_RE = new RegExp(`: off ${DAYS} -> off ${DAYS}`);
// The warning's load list is read as a Super Admin sees it: every Load ID as stored.
const SUPER_ADMIN_REQ = { session: { user: { role: "Super Admin" } } };
const LIFT_ROOTS = ["driverLoadsForTimeOff", "getJobTrackingCached", "jobTrackingMonthCols", "invoiceWeekColumns", "assignedDateColumn",
	"sheetDayKey", "normalizeDriverName", "normLoadKey", "excludeDroppedLoads"];

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

// The server's own code for the loads the warning reads, lifted from this
// checkout's server.js (scripts/lib/server-lift.js): driverLoadsForTimeOff() over
// getJobTrackingCached() (the tab parsed and de-duplicated as the server does it),
// and the column, day, name and live-load rules beside them. getDeletedLoadIds()
// is lifted on its own and handed the read-only handle, the one lifted function
// given the database (as scripts/integrity-check.js does); getSheets() answers
// getJobTrackingCached()'s one values.get with the tab already read. The lifted
// code sees no environment and may require the app's lib/ only.
function liftFromServer(db, sheetData) {
	const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const deletedReader = closure(SRC, { roots: ["getDeletedLoadIds"], provided: ["db"] });
	const getDeletedLoadIds = new Function("db", `"use strict";\n${deletedReader.text}\nreturn getDeletedLoadIds;`)(db);
	const lifted = closure(SRC, {
		roots: LIFT_ROOTS,
		provided: ["getDeletedLoadIds", "getSheets", "SPREADSHEET_ID"],
		denied: ["db", "app", "io", "server", "sheets", "sendEmail", "transporter", "getDrive", "KEY_FILE", "jtCacheInvalidate"],
	});
	const liftedRequire = (m) => {
		if (!/^\.\/lib\/[\w.-]+$/.test(m)) throw new Error(`lifted code required ${m}, which this report does not load`);
		return appRequire(m);
	};
	const getSheets = async () => ({ spreadsheets: { values: { get: async () => ({ data: sheetData }) } } });
	return new Function("getDeletedLoadIds", "getSheets", "SPREADSHEET_ID", "console", "process", "require",
		`"use strict";\n${lifted.text}\nreturn { ${LIFT_ROOTS.join(", ")} };`)(getDeletedLoadIds, getSheets, "", console, { env: {} }, liftedRequire);
}

// An instant as the business clock shows it ("2026-10-17 10:00 EDT"), or null.
let zoneTextFormat = null;
function zoneText(stamp) {
	const ms = stampMs(stamp);
	if (!Number.isFinite(ms)) return null;
	zoneTextFormat = zoneTextFormat || new Intl.DateTimeFormat("en-US", {
		timeZone: appTime.appTimeZone(), year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
	});
	const p = {};
	for (const x of zoneTextFormat.formatToParts(new Date(ms))) p[x.type] = x.value;
	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

// The business day an instant falls on, or "".
function dayOf(stamp) {
	const ms = stampMs(stamp);
	return Number.isFinite(ms) ? appTime.dayInZone(new Date(ms), appTime.appTimeZone()) : "";
}

// One row's saves of its days, from its driver's create and update audit lines
// (`lines`, oldest first). Walking back from the row's days now, each update line
// in the row's life whose new days are the row's days at that point is one of its
// changes (a driver's live rows never overlap, so no other row of his had those
// days then), and its create line must name the days the walk ends on. Returns
// { complete, saves }, each save { change, at, from, to, oldFrom, oldTo }: the
// "recorded" save, then each "changed" one that moved its days. When a line is
// missing: one save, the row's days now, at its last change (else its recording).
function rowSaves(row, lines) {
	const createdMs = stampMs(row.created_at);
	const endMs = row.cancelled_at ? stampMs(row.cancelled_at) : Infinity;
	const life = lines.filter((a) => {
		const t = stampMs(a.timestamp);
		return t >= createdMs && t <= endMs;
	});
	let cur = { from: row.from_date, to: row.to_date };
	const changes = [];
	for (const a of life.filter((x) => x.action === "driver_availability_update").reverse()) {
		const m = UPDATE_LINE_RE.exec(a.details || "");
		if (!m || m[3] !== cur.from || m[4] !== cur.to) continue;
		changes.unshift({ at: a.timestamp, from: m[3], to: m[4], oldFrom: m[1], oldTo: m[2] });
		cur = { from: m[1], to: m[2] };
	}
	const created = life.some((a) => {
		const m = a.action === "driver_availability_create" ? CREATE_LINE_RE.exec(a.details || "") : null;
		return !!m && m[1] === cur.from && m[2] === cur.to;
	});
	const lastChange = changes.length ? stampMs(changes[changes.length - 1].at) : NaN;
	const complete = created && (!row.updated_at || lastChange >= stampMs(row.updated_at));
	if (!complete) {
		return { complete, saves: [{ change: row.updated_at ? "changed" : "recorded", at: row.updated_at || row.created_at, from: row.from_date, to: row.to_date, oldFrom: null, oldTo: null }] };
	}
	const moved = changes.filter((c) => c.from !== c.oldFrom || c.to !== c.oldTo).map((c) => ({ change: "changed", ...c }));
	return { complete, saves: [{ change: "recorded", at: row.created_at, from: cur.from, to: cur.to, oldFrom: null, oldTo: null }, ...moved] };
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function buildReport(db, sheetData, sinceMs) {
	const server = liftFromServer(db, sheetData);
	const jt = await server.getJobTrackingCached();
	const monthCols = server.jobTrackingMonthCols(jt.headers);
	if (!monthCols.loadIdCol || !monthCols.driverCol) refuse("the Job Tracking values have no Load ID or Driver column: pass a saved values.get of the Job Tracking tab");
	const loads = await server.driverLoadsForTimeOff(SUPER_ADMIN_REQ);
	if (!loads) throw new Error("Job Tracking could not be read");
	const statusCol = server.invoiceWeekColumns(jt.headers).statusCol;
	const assignedCol = jt.headers.find(server.assignedDateColumn) || null;
	const cell = (r, col) => (r && col ? String(r[col] == null ? "" : r[col]).trim() : "");
	const sheetRowOf = new Map();
	for (const r of server.excludeDroppedLoads(jt.data, jt.headers)) {
		const k = server.normLoadKey(r[monthCols.loadIdCol]);
		if (k && !sheetRowOf.has(k)) sheetRowOf.set(k, r);
	}

	const linesOf = new Map();
	const lines = db.prepare(`
		SELECT id, timestamp, action, entity_id, details FROM audit_trail
		WHERE entity = 'driver' AND action IN ('driver_availability_create', 'driver_availability_update')
	`).all().sort((a, b) => stampMs(a.timestamp) - stampMs(b.timestamp) || a.id - b.id);
	for (const a of lines) {
		if (!linesOf.has(a.entity_id)) linesOf.set(a.entity_id, []);
		linesOf.get(a.entity_id).push(a);
	}
	const viaOf = new Map();
	for (const c of db.prepare("SELECT availability_id, load_id, via FROM driver_availability_confirmations").all()) {
		const k = `${c.availability_id}\t${server.normLoadKey(c.load_id)}`;
		if (!viaOf.has(k)) viaOf.set(k, new Set());
		viaOf.get(k).add(String(c.via || ""));
	}

	const today = appTime.appDay();
	const normalize = server.normalizeDriverName;
	const skippedNoDates = new Set();
	const skippedLongId = new Set();
	const out = [];
	const stored = db.prepare(`
		SELECT a.id, a.directory_id, a.driver_name, a.kind, a.from_date, a.to_date, a.created_at, a.updated_at, a.cancelled_at,
			d.driver_name AS directory_name
		FROM driver_availability a LEFT JOIN drivers_directory d ON d.id = a.directory_id
	`).all().sort((a, b) => stampMs(a.created_at) - stampMs(b.created_at) || a.id - b.id);
	let unreadableStamps = 0;
	for (const row of stored) {
		if (!Number.isFinite(stampMs(row.created_at))) {
			unreadableStamps++;
			continue;
		}
		const { complete, saves } = rowSaves(row, linesOf.get(String(row.directory_id)) || []);
		const listed = complete
			? stampMs(row.created_at) >= sinceMs || saves.some((s) => s.change === "changed" && stampMs(s.at) >= sinceMs)
			: [row.created_at, row.updated_at].some((t) => stampMs(t) >= sinceMs);
		if (!listed) continue;
		const driverName = String(row.directory_name || row.driver_name || "").trim();
		const driverKey = normalize(driverName);
		const his = driverKey ? loads.filter((l) => normalize(l.driver) === driverKey) : [];
		const recordOf = new Map(his.map((l) => [server.normLoadKey(l.loadId), l]));
		const asked = (list, s, day) => driverAvailability.loadsNewlyInTimeOff({ loads: list, driverName, normalize, from: s.from, to: s.to, oldFrom: s.oldFrom, oldTo: s.oldTo, todayKey: day });
		// The latest save that brought each load in, then only the loads the row still covers.
		const broughtIn = new Map();
		const savesOut = saves.map((s) => {
			const day = dayOf(s.at);
			for (const l of asked(loads, s, day)) broughtIn.set(server.normLoadKey(l.loadId), { l, day });
			return { change: s.change, at: s.at, atText: zoneText(s.at), day, from: s.from, to: s.to, oldFrom: s.oldFrom, oldTo: s.oldTo };
		});
		const now = { from: row.from_date, to: row.to_date, oldFrom: null, oldTo: null };
		const rowLoads = [];
		for (const [k, { l, day }] of broughtIn) {
			if (!asked([recordOf.get(k)], now, day).length) continue;
			const r = sheetRowOf.get(k);
			const assignedCell = cell(r, assignedCol);
			const assignedDay = server.sheetDayKey(assignedCell);
			const alreadyHad = !driverAvailability.isAvailabilityDay(assignedDay) ? "unknown" : assignedDay <= day ? "yes" : "no";
			const via = viaOf.get(`${row.id}\t${k}`);
			rowLoads.push({
				loadId: l.loadId, from: l.from, to: l.to,
				pickup: { cell: cell(r, monthCols.pickupDateCol), day: recordOf.get(k).pickupKey },
				dropoff: { cell: cell(r, monthCols.dropoffDateCol), day: recordOf.get(k).dropoffKey },
				status: cell(r, statusCol),
				assignedDate: { cell: assignedCell, day: assignedDay },
				alreadyHad, checkedAsOf: day,
				confirmed: !!via, confirmedVia: via ? [...via].sort() : [],
			});
		}
		rowLoads.sort((a, b) => byText(a.from, b.from) || byText(a.loadId, b.loadId));
		const noDates = his.filter((l) => driverAvailability.timeOffLoadSkip(l) === "no_day");
		const longIds = his.filter((l) => driverAvailability.timeOffLoadSkip(l) === "id");
		for (const l of noDates) skippedNoDates.add(`${driverKey}\t${server.normLoadKey(l.loadId)}`);
		for (const l of longIds) skippedLongId.add(`${driverKey}\t${server.normLoadKey(l.loadId)}`);
		const recordedAs = String(row.driver_name || "").trim();
		out.push({
			id: row.id, directoryId: row.directory_id, driver: driverName,
			recordedAs: row.directory_name && recordedAs !== driverName ? recordedAs : null,
			kind: row.kind, from: row.from_date, to: row.to_date,
			state: row.cancelled_at ? "cancelled" : row.to_date < today ? "ended" : row.from_date > today ? "upcoming" : "current",
			recordedAt: row.created_at, recordedAtText: zoneText(row.created_at),
			lastChangedAt: row.updated_at || null, lastChangedAtText: zoneText(row.updated_at),
			cancelledAt: row.cancelled_at || null, cancelledAtText: zoneText(row.cancelled_at),
			historyComplete: complete,
			saves: savesOut,
			loads: rowLoads,
			skipped: { noDates: noDates.map((l) => l.loadId).sort(byText), loadIdTooLong: longIds.length },
		});
	}
	const all = out.flatMap((r) => r.loads);
	const count = (v) => all.filter((l) => l.alreadyHad === v).length;
	return {
		since: new Date(sinceMs).toISOString(),
		timeZone: appTime.appTimeZone(),
		today,
		generatedAt: new Date().toISOString(),
		rows: out,
		summary: {
			rowsChecked: out.length,
			rowsSkippedUnreadableStamp: unreadableStamps,
			rowsWithAlreadyHadLoads: out.filter((r) => r.loads.some((l) => l.alreadyHad === "yes")).length,
			rowsWithAssignedDateUnknown: out.filter((r) => r.loads.some((l) => l.alreadyHad === "unknown")).length,
			loadsListed: all.length,
			loadsAlreadyHad: count("yes"),
			loadsNotYetAssigned: count("no"),
			loadsAssignedDateUnknown: count("unknown"),
			loadsSkippedNoDates: skippedNoDates.size,
			loadsSkippedLoadIdTooLong: skippedLongId.size,
			loadsConfirmed: all.filter((l) => l.confirmed).length,
		},
	};
}

function printText(r) {
	const lines = [];
	const s = r.summary;
	lines.push(`Time off recorded or re-dated since ${zoneText(r.since)}, with the driver's loads it covers. Read-only. Nothing was written.`);
	lines.push(`Each load is checked as R11b's warning would have checked it at the save that brought it into the time off ("as of" that save's day, ${r.timeZone}); "already had" means its Assigned Date is on or before that day. Loads are as Job Tracking has them now.`);
	const loadLine = (l) => `    ${l.loadId}  ${l.from}..${l.to}  pickup ${l.pickup.cell || "(blank)"}, drop-off ${l.dropoff.cell || "(blank)"}  ${l.status || "(no status)"}  Assigned ${l.assignedDate.cell || "(blank)"}  as of ${l.checkedAsOf}  ${l.confirmed ? `confirmed (${l.confirmedVia.join(", ")})` : "not confirmed"}`;
	for (const row of r.rows) {
		lines.push("");
		lines.push(`Row ${row.id}  ${row.driver}${row.recordedAs ? ` (recorded as ${row.recordedAs})` : ""}  ${driverAvailability.availabilityRangeText(row.from, row.to)} (${row.from}..${row.to}, ${row.kind})  ${row.state}`);
		lines.push(`  recorded ${row.recordedAtText || row.recordedAt}; last changed ${row.lastChangedAtText || "never"}${row.cancelledAt ? `; cancelled ${row.cancelledAtText || row.cancelledAt}` : ""}`);
		if (!row.historyComplete) lines.push("  note: the audit log does not account for every change of this row, so its loads are checked as of its last change");
		const groups = [["yes", "Already had (Assigned Date on or before the save day)"], ["no", "Not yet assigned at the save"], ["unknown", "Assigned date unknown (blank or unreadable)"]];
		for (const [v, title] of groups) {
			const these = row.loads.filter((l) => l.alreadyHad === v);
			if (!these.length) continue;
			lines.push(`  ${title}: ${these.length}`);
			for (const l of these) lines.push(loadLine(l));
		}
		if (!row.loads.length) lines.push("  No loads in these days.");
		if (row.skipped.noDates.length) lines.push(`  Skipped, no readable pickup or drop-off day: ${row.skipped.noDates.join(", ")}`);
		if (row.skipped.loadIdTooLong) lines.push(`  Skipped, a Load ID over 64 characters: ${row.skipped.loadIdTooLong}`);
	}
	lines.push("");
	if (s.rowsSkippedUnreadableStamp) lines.push(`Not checked: ${s.rowsSkippedUnreadableStamp} time-off row(s) whose recorded-at stamp cannot be read.`);
	lines.push(`Counts: rows checked ${s.rowsChecked}; rows with already-had loads ${s.rowsWithAlreadyHadLoads}; loads listed ${s.loadsListed} (already had ${s.loadsAlreadyHad}, not yet assigned ${s.loadsNotYetAssigned}, assigned date unknown ${s.loadsAssignedDateUnknown}); loads skipped for no dates ${s.loadsSkippedNoDates}${s.loadsSkippedLoadIdTooLong ? `; loads skipped for a Load ID over 64 characters ${s.loadsSkippedLoadIdTooLong}` : ""}; confirmed ${s.loadsConfirmed}.`);
	console.log(lines.join("\n"));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (typeof args.db !== "string" || !args.db.trim()) refuse("--db=<app.db> is required: the database to read (opened read-only)");
	if (typeof args["values-json"] !== "string" && typeof args["sheet-id"] !== "string") {
		refuse("--values-json=<file> (a saved values.get of Job Tracking) or --sheet-id=<id> is required; there is no default sheet");
	}
	if (args.since !== undefined && typeof args.since !== "string") refuse("--since needs a value: an ISO instant with its zone, e.g. 2026-10-16T07:00:00Z");
	const sinceText = args.since === undefined ? DEFAULT_SINCE : args.since.trim();
	const sinceMs = Date.parse(sinceText);
	if (!INSTANT_RE.test(sinceText) || !Number.isFinite(sinceMs)) refuse("--since must be an ISO instant with its zone, e.g. 2026-10-16T07:00:00Z");
	const dbFile = path.resolve(args.db);
	if (!fs.existsSync(dbFile) || !fs.statSync(dbFile).isFile()) refuse(`--db=${args.db}: there is no such database file`);
	const db = openDb({ root: ROOT, dbFile, readonly: true });
	try {
		const missing = TABLES.filter((t) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
		if (missing.length) refuse(`the database has no ${missing.join(", ")} table, so it holds no time off to list`);
		let sheetData;
		try {
			sheetData = await sheetFor(args, ROOT);
		} catch (err) {
			refuse(err.message);
		}
		const result = await buildReport(db, sheetData, sinceMs);
		if (args.json === true) console.log(JSON.stringify(result, null, 1));
		else printText(result);
	} finally {
		db.close();
	}
}

main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
