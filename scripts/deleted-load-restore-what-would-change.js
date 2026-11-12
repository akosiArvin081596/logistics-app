#!/usr/bin/env node
// What DELETED_LOAD_RESTORE_ENABLED (lib/deleted-load-restore.js) would change, read only: the report hard rule 3
// asks for before the switch-on. It runs the module's own banner code on the data it is given, with the flag on
// for this run only: create() and mount() on a stand-in app that registers nothing, its notices kept in memory,
// then hiddenLoads() for a made-up Super Admin session, the app's own answer to the first Super Admin dashboard
// read. The module's helpers are server.js's, lifted from this checkout at run time (scripts/lib/ledger-world.js
// buildLedgerWorld(), and scripts/lib/server-lift.js closure() for parseSheet() and deduplicateLoads()), so the
// trip work-day cover is on or off as the app's settings have it. Job Tracking is read as the server reads it:
// every row kept beside the de-duplicated ones (lib/job-tracking-every-row.js).
//
//   node scripts/deleted-load-restore-what-would-change.js --dry-run --db=<app.db> --sheet-id=<id> --key=<key file> [--ids] [--json]
//   node scripts/deleted-load-restore-what-would-change.js --dry-run --db=<app.db> --sheet-id=env --key=<key file> [--ids] [--json]
//   SPREADSHEET_ID=<id> node scripts/deleted-load-restore-what-would-change.js --dry-run --db=<app.db> --key=<key file> [--ids] [--json]
//   node scripts/deleted-load-restore-what-would-change.js --dry-run --db=<copy> --values-json=<saved values.get> [--env-file=<settings>] [--ids] [--json]
//
// --dry-run is required; there is no other mode. Every target is named, none has a default:
//   --db          the app directory's own database or a copy under the temp folder (ledger-world dbScope()). A
//                 missing file is refused, never created. Opened readonly with fileMustExist, checked to be
//                 read-only, then query_only = ON, so any write throws. A database without #754's row_digests
//                 column is refused: this report never adds it.
//   the sheet     named once: --sheet-id=<id>; --sheet-id=env, the app's own SPREADSHEET_ID; SPREADSHEET_ID in
//                 the environment (lib/sheet-id.js scriptSpreadsheetId() refuses when there is none); or
//                 --values-json, a saved values.get of Job Tracking, which reads no key and no network. A live
//                 sheet is read once, with the spreadsheets.readonly scope, as --key's service account.
//   --env-file    the settings for a copy of the database only; the app's own database runs with the app's own.
// Production's app directory runs against production's sheet, read live, only; production's sheet runs against
// production's own database or a copy under the temp folder only (lib/sheet-id.js).
//
// It lists: the state it starts from; every delete with a live row, on the banner (by evidence, by what a press
// would do now, by month, and the person group P1), in closed months only, or not shown (by why, by month, and
// the person group P2); the notices the next Super Admin dashboard read would write; what each Restore button
// would do; the Load IDs that would stop a create, with the last 90 days' creates after a delete; and the
// banner check's time. A month is open or closed as lockedAmong() reads period_locks. It works out each press
// with the restore route's own checks, over every row with the Load ID, and re-reads each delete the module's
// way: when its reading differs from the module's banner or notices, it stops (exit 1), since its other counts
// could then be wrong too.
//
// It prints counts, month keys and the delete record numbers of the banner lines (deleted_loads.id). Load
// numbers only with --ids, only for P1 and P2, in one block headed as real data; P2 only from open months.
// Never: who deleted or created a load, a driver, an address, an amount, a reason, a row's cells, the sheet ID
// or a settings value. --json prints the same as JSON. It writes nothing and sends nothing.
// Exit 0 done; 2 refused (an argument, an input, the database's shape); 1 any other failure, printed as a code.

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const restoreLib = require("../lib/deleted-load-restore");
const { keepEveryRow, everyJobTrackingRow } = require("../lib/job-tracking-every-row");
const { normalizeLoadId } = require("../lib/ratecon-load");
const { auditMonths, nearestAudit, sqliteUtcMs } = require("../lib/deleted-loads-view");
const appTime = require("../lib/app-time");
const sheetIds = require("../lib/sheet-id");
const ledgerWorld = require("./lib/ledger-world");
const { closure } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");

const ROOT = path.join(__dirname, "..");
const SCRIPT = "deleted-load-restore-what-would-change.js";
const FLAG_ARGS = new Set(["dry-run", "ids", "json"]);
const VALUE_ARGS = new Set(["db", "sheet-id", "values-json", "key", "env-file"]);
const ARG_RE = /^--([a-z][a-z-]{0,19})(?:=([\s\S]*))?$/;
const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,200}$/;
// The server.js helpers the module's mount takes that are code, not wiring (server.js passes these same ones).
const EXTRA_ROOTS = ["jobTrackingMonthCols", "tripDayLockCover", "loadRowPeriods", "lockedAmong", "periodLocksReadable", "periodLabel",
	"excludeDroppedLoads", "pickAddressColumn", "auditText"];
// What the mount takes that reaches HTTP, the sheet cache or a socket: stand-ins here that reach nothing.
const STAND_INS = ["requireRole", "refuseCrossSite", "getJobTrackingCached", "notifyChange", "jtCacheInvalidate", "notifySuperAdmins"];
const SHEET_ROOTS = ["parseSheet", "deduplicateLoads"];
const SHEET_DENIED = ["db", "app", "io", "server", "getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "sendEmail", "transporter", "getDrive", "jtCacheInvalidate"];
// The tables and columns the module and this report read.
const TABLES = {
	deleted_loads: ["id", "load_id", "row_index", "deleted_at", "deleted_by", "row_digests"],
	audit_trail: ["id", "timestamp", "role", "action", "entity", "entity_id", "details"],
	dispatch_notifications: ["id", "type", "metadata", "created_at"],
	period_locks: ["period", "status"],
};
const DELETE_AUDIT_SQL = "SELECT timestamp, details FROM audit_trail WHERE entity = 'load' AND entity_id = ? AND action = 'delete_load' ORDER BY id";
const EVIDENCE = ["deleted_with_no_row", "created_by_rate_con", "created_in_sheet_row", "created_by_n8n", "row_changed", "row_in_other_month"];
const CREATED = ["created_by_rate_con", "created_in_sheet_row", "created_by_n8n"];
// A delete that found no row says so in its own delete_load row (the delete route's words), written within
// moments of it; a delete from before that row was written (#211, 2026-08-08) may have lost a row's number.
const NO_ROW_TEXT = "no matching Job Tracking row";
const OWN_AUDIT_MS = 10 * 60 * 1000;
const WINDOW_MS = 90 * 24 * 3600 * 1000;
const TIMED_RUNS = 5;
const COST_LIMIT_MS = 200;
const REPORT_USER = { id: 0, role: restoreLib.ROLE, username: "what-would-change report" };

class Refusal extends Error {}
class Failure extends Error {
	constructor(code, records = null) {
		super(code);
		this.code = code;
		this.records = records;
	}
}

const isFile = (p) => {
	try { return fs.statSync(p).isFile(); } catch { return false; }
};
// Objects compare whatever their key order; arrays in order.
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
	? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

// --name or --name=value only; an argument's value is never echoed (it may be a sheet ID or a path).
function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = ARG_RE.exec(String(a));
		if (!m) throw new Refusal("unknown argument: give --name or --name=value only");
		const [, name, value] = m;
		if (Object.prototype.hasOwnProperty.call(out, name)) throw new Refusal(`--${name} is given twice`);
		if (FLAG_ARGS.has(name)) {
			if (value !== undefined) throw new Refusal(`--${name} takes no value`);
			out[name] = true;
		} else if (VALUE_ARGS.has(name)) {
			if (value === undefined || !value.trim()) throw new Refusal(`--${name} needs a value`);
			out[name] = value.trim();
		} else {
			throw new Refusal(`unknown argument --${name}`);
		}
	}
	return out;
}

const productionRoot = (root, dir) => {
	if (path.resolve(root) === dir) return true;
	try { return fs.realpathSync(root) === dir; } catch { return false; }
};
// null, or why this database and sheet may not be read together. `production`: lib/sheet-id.js's directory and sheet.
function targetRefusal({ root, scope, live, sheetId, production }) {
	const inProduction = productionRoot(root, production.dir);
	const productionSheet = live && sheetId === production.sheetId;
	if (inProduction && !productionSheet) return "in production's app directory this report reads production's own sheet, live, and nothing else";
	if (productionSheet && !inProduction && scope !== "copy") return "production's sheet is read only for production's own database, or for a copy of it under the temp folder";
	return null;
}

// Every refusal that needs no database, before anything is opened.
function targets(args, { env = process.env, root = ROOT } = {}) {
	if (args["dry-run"] !== true) throw new Refusal("--dry-run is required: this report only reads, and it has no other mode");
	if (!args.db) throw new Refusal("--db=<app.db> is required; it has no default");
	const envSheet = String((env && env.SPREADSHEET_ID) || "").trim();
	const named = ["values-json", "sheet-id"].filter((k) => args[k] !== undefined);
	if (named.length + (envSheet ? 1 : 0) > 1) throw new Refusal("name the sheet once: --values-json, --sheet-id or SPREADSHEET_ID, not two of them");
	if (!named.length && !envSheet) {
		const r = sheetIds.scriptSpreadsheetId({}, { script: SCRIPT });
		throw new Refusal(`${r.error} Or give --sheet-id=<id>, --sheet-id=env, or --values-json=<a saved values.get>.`);
	}
	const live = args["values-json"] === undefined;
	if (live && args.key === undefined) throw new Refusal("--key=<the service account's key file> is required to read the live sheet; it has no default");
	if (!live && args.key !== undefined) throw new Refusal("--key is for reading the live sheet; a --values-json run reads no key");
	if (args["sheet-id"] !== undefined && args["sheet-id"] !== "env" && !SHEET_ID_RE.test(args["sheet-id"])) {
		throw new Refusal("--sheet-id: name the sheet by its ID, or give --sheet-id=env for the app's own; there is no default sheet");
	}
	let scope;
	try {
		scope = ledgerWorld.dbScope(args.db, root);
	} catch (e) {
		throw new Refusal(`--db: ${String(e && e.message).slice(0, 1000)}`);
	}
	const envFile = args["env-file"] !== undefined ? path.resolve(args["env-file"]) : null;
	if (envFile && scope.scope !== "copy") throw new Refusal("--env-file is only for a copy of the database under the temp folder; the app's own database runs with the app's own settings");
	if (envFile && !isFile(envFile)) throw new Refusal("--env-file names no file");
	let sheetId = null;
	if (live) {
		let r;
		if (args["sheet-id"] === "env") {
			r = sheetIds.scriptSpreadsheetId(ledgerWorld.envFor({ root, dbPath: args.db, envFile }).env, { script: SCRIPT });
			if (!r.id) throw new Refusal(`--sheet-id=env: the settings name no sheet. ${r.error}`);
		} else {
			r = args["sheet-id"] !== undefined ? { id: args["sheet-id"] } : sheetIds.scriptSpreadsheetId(env, { script: SCRIPT });
			if (!r.id) throw new Refusal(r.error);
		}
		sheetId = r.id;
		if (!SHEET_ID_RE.test(sheetId)) throw new Refusal("the sheet named isn't a sheet ID; name the sheet by its ID");
	}
	const refusal = targetRefusal({ root, scope: scope.scope, live, sheetId, production: { dir: sheetIds.PRODUCTION_DIR, sheetId: sheetIds.PRODUCTION_SPREADSHEET_ID } });
	if (refusal) throw new Refusal(refusal);
	if (!isFile(scope.file)) throw new Refusal("--db names no file; nothing was created");
	const keyFile = live ? path.resolve(args.key) : null;
	if (live && !isFile(keyFile)) throw new Refusal("--key names no file");
	const valuesFile = live ? null : path.resolve(args["values-json"]);
	if (!live && !isFile(valuesFile)) throw new Refusal("--values-json names no file");
	return { live, scope, sheetId, keyFile, valuesFile, envFile };
}

// A read-only handle, checked to be one, with query_only on.
function openReadOnly(file, root = ROOT) {
	const Database = createRequire(path.join(root, "server.js"))("better-sqlite3");
	let db;
	try {
		db = new Database(file, { readonly: true, fileMustExist: true });
	} catch (e) {
		throw new Refusal(`cannot open the database read-only (${(e && e.code) || "an error"})`);
	}
	if (!db.readonly) {
		db.close();
		throw new Refusal("the database did not open read-only");
	}
	db.pragma("busy_timeout = 10000");
	db.pragma("query_only = ON");
	if (db.pragma("query_only", { simple: true }) !== 1) {
		db.close();
		throw new Refusal("query_only could not be turned on for the handle");
	}
	return db;
}

function checkShape(db) {
	for (const [table, cols] of Object.entries(TABLES)) {
		const have = db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((c) => c.name);
		if (!have.length) throw new Refusal(`the database has no ${table} table`);
		const missing = cols.filter((c) => !have.includes(c));
		if (missing.length) {
			throw new Refusal(`the database's ${table} table has no ${missing.join(", ")} column${missing.length > 1 ? "s" : ""}` +
				`${missing.includes("row_digests") ? ": #754's deploy adds it, and this report never does" : ""}`);
		}
	}
}

function valuesOf(doc, what) {
	const values = (doc && doc.values) || (doc && doc.data && doc.data.values);
	if (!Array.isArray(values)) throw new Refusal(`${what} holds no values.get answer ({ values: [...] })`);
	return values;
}
// A refusal names the file and the reason only: a parse error would quote what the file holds.
function readValuesFile(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		throw new Refusal(`cannot read ${path.basename(file)} (${(e && e.code) || "an error"})`);
	}
	let doc;
	try {
		doc = JSON.parse(raw);
	} catch {
		throw new Refusal(`cannot read ${path.basename(file)}: it is not valid JSON`);
	}
	return valuesOf(doc, "--values-json");
}
// The one network call: values.get of Job Tracking, spreadsheets.readonly (ledger-world sheetFor()).
async function readLiveSheet({ sheetId, keyFile }, root = ROOT) {
	let doc;
	try {
		doc = await ledgerWorld.sheetFor({ "sheet-id": sheetId, key: keyFile }, root);
	} catch (e) {
		const code = e && /^[A-Za-z0-9_]{1,30}$/.test(String(e.code || "")) ? `_${String(e.code).toUpperCase()}` : "";
		throw new Failure(`SHEET_READ_FAILED${code}`);
	}
	return valuesOf(doc, "the sheet read");
}

// parseSheet() and deduplicateLoads() as server.js has them; neither requires anything.
function liftSheet(root) {
	const lifted = closure(serverSource({ root }), { roots: SHEET_ROOTS, provided: ["require", "console"], denied: SHEET_DENIED });
	const noRequire = (m) => { throw new Error(`the sheet parser required ${m}`); };
	return new Function("require", "console", `"use strict";\n${lifted.text}\nreturn { ${SHEET_ROOTS.join(", ")} };`)(noRequire, console);
}

// The module's helpers, lifted from `root`'s server.js and bound to `db` (opened on `dbPath`, the file
// dbScope() resolved), with the settings that apply to it.
function liftHelpers({ root = ROOT, dbPath, db, envFile = null, readonly = true }) {
	const world = ledgerWorld.buildLedgerWorld({ root, dbPath, readonly, sheetData: { values: [] }, envFile, extraRoots: EXTRA_ROOTS, db });
	const helpers = {};
	for (const name of EXTRA_ROOTS) {
		if (typeof world.api[name] !== "function") throw new Failure("LIFT_FAILED");
		helpers[name] = world.api[name];
	}
	return { helpers, sheet: liftSheet(root), env: ledgerWorld.envFor({ root, dbPath, envFile }).env };
}

// Job Tracking as getJobTrackingCached() hands it out: parsed, every row kept beside it, then de-duplicated.
function jobTrackingRead(values, sheet) {
	const parsed = sheet.parseSheet({ values });
	keepEveryRow(parsed, parsed.data);
	parsed.data = sheet.deduplicateLoads(parsed.data, parsed.headers);
	return parsed;
}

// The helpers server.js hands the module's mount, by the same names: the lifted ones as they are, stand-ins for
// the rest. `notices` collects what notifySuperAdmins would store and send.
function mountHelpers(helpers, jt, notices) {
	const serveNothing = () => { throw new Error("the report's stand-in app serves no request"); };
	return {
		requireRole: () => serveNothing,
		refuseCrossSite: serveNothing,
		periodLocksReadable: helpers.periodLocksReadable,
		getJobTrackingCached: async () => jt,
		jobTrackingMonthCols: helpers.jobTrackingMonthCols,
		tripDayLockCover: helpers.tripDayLockCover,
		loadRowPeriods: helpers.loadRowPeriods,
		lockedAmong: helpers.lockedAmong,
		periodLabel: helpers.periodLabel,
		notifyChange() {},
		jtCacheInvalidate() {},
		pickAddressColumn: helpers.pickAddressColumn,
		excludeDroppedLoads: helpers.excludeDroppedLoads,
		notifySuperAdmins: (notice) => { notices.push(notice); },
	};
}

function parseDigests(v) {
	if (v == null || v === "") return null;
	try {
		const a = JSON.parse(v);
		return Array.isArray(a) ? a.filter((d) => typeof d === "string") : null;
	} catch {
		return null;
	}
}

const groupBy = (list, keyOf) => {
	const out = new Map();
	for (const x of list) {
		const k = keyOf(x);
		if (!k) continue;
		if (!out.has(k)) out.set(k, []);
		out.get(k).push(x);
	}
	return out;
};
const rowNumber = (r) => (Number.isInteger(r._rowIndex) ? r._rowIndex : null);
const rowNumbers = (rows) => rows.map(rowNumber).filter((n) => n !== null);
const median = (nums) => {
	const s = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const sortedCounts = (map) => Object.fromEntries([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
const bump = (map, k) => map.set(k, (map.get(k) || 0) + 1);

// The report: `db` read-only, `jt` Job Tracking as jobTrackingRead() builds it, `helpers` liftHelpers()'s,
// `env` the app's settings, `now` epoch ms. Answers { out, model }: `out` is what may be printed; `model` the
// per-record reading the runners check, never printed.
function buildReport({ db, jt, helpers, env = {}, now = Date.now(), ids = false, timedRuns = TIMED_RUNS }) {
	const headers = (jt && jt.headers) || [];
	const notices = [];
	const errors = [];
	const log = { log() {}, info() {}, warn() {}, error: (...a) => errors.push(a.join(" ")) };
	const zone = appTime.resolveAppTimeZone(env.APP_TIMEZONE, () => {});
	const mod = restoreLib.create({ db, enabled: true, auditText: helpers.auditText, timeZone: zone, log });
	mod.mount({ get() {}, post() {} }, mountHelpers(helpers, jt, notices));
	const dcols = mod.digestColumns(headers);
	if (!dcols.loadId) throw new Refusal("the Job Tracking values have no Load ID column");
	if (!helpers.periodLocksReadable()) throw new Refusal("period_locks can't be read, so no month can be told open or closed");

	// The module's answer to the first Super Admin dashboard read, timed: the banner, and the notices it writes.
	const req = { session: { user: { ...REPORT_USER } } };
	const times = [];
	let banner = null;
	let told = null;
	for (let i = 0; i < timedRuns; i++) {
		notices.length = 0;
		const t0 = process.hrtime.bigint();
		const answer = mod.hiddenLoads(req, jt);
		times.push(Number(process.hrtime.bigint() - t0) / 1e6);
		const kinds = notices.map((n) => ({ kind: n.metadata && n.metadata.kind, tombstoneId: n.metadata && n.metadata.tombstoneId }));
		if (!Array.isArray(answer)) throw new Failure("BANNER_NOT_READ");
		if (i === 0) {
			banner = answer;
			told = kinds;
		} else if (canon(answer) !== canon(banner) || canon(kinds) !== canon(told)) {
			throw new Failure("BANNER_UNSTABLE");
		}
	}
	if (errors.length) throw new Failure("MODULE_LOGGED_AN_ERROR");

	// Each delete read again the module's way, for what its answer leaves out: the groups off the banner, and why.
	const monthCols = helpers.jobTrackingMonthCols(headers);
	const cover = helpers.jobTrackingMonthCols(headers);
	const tripCover = helpers.tripDayLockCover(headers);
	if (tripCover) cover.tripCover = tripCover;
	const every = everyJobTrackingRow(jt);
	const keyOfRow = (r) => normalizeLoadId(r[dcols.loadId]);
	const allByKey = groupBy(every, keyOfRow);
	const liveByKey = groupBy(helpers.excludeDroppedLoads(every, headers, new Set()), keyOfRow);
	const tombstones = db.prepare("SELECT id, load_id, row_index, deleted_at, deleted_by, row_digests FROM deleted_loads ORDER BY id").all();
	const tombsByKey = groupBy(tombstones, (t) => normalizeLoadId(t.load_id));
	const auditStmt = db.prepare(DELETE_AUDIT_SQL);
	const audits = new Map();
	const auditsFor = (loadId) => {
		const k = String(loadId);
		if (!audits.has(k)) audits.set(k, auditStmt.all(k));
		return audits.get(k);
	};
	const nearestOf = (t) => nearestAudit(auditsFor(t.load_id), sqliteUtcMs(t.deleted_at));
	const namedMonths = (t) => {
		const entry = nearestOf(t);
		return entry ? auditMonths(entry.details) : [];
	};
	const splitRows = (t, live) => {
		if (!(Number(t.row_index) > 0)) return { basis: "none", own: [], other: live.slice() };
		const recorded = parseDigests(t.row_digests);
		if (recorded) {
			const left = new Map();
			for (const d of recorded) left.set(d, (left.get(d) || 0) + 1);
			const own = [];
			const other = [];
			for (const r of live) {
				const d = restoreLib.rowDigest(r, dcols);
				const n = left.get(d) || 0;
				if (n) {
					left.set(d, n - 1);
					own.push(r);
				} else other.push(r);
			}
			return { basis: "digests", own, other, recorded: recorded.length };
		}
		const named = namedMonths(t);
		if (!named.length) return { basis: "months", own: live.slice(), other: [] };
		const own = [];
		const other = [];
		for (const r of live) {
			const p = helpers.loadRowPeriods(r, monthCols);
			(!p || !p.resolved || p.periods.every((m) => named.includes(m)) ? own : other).push(r);
		}
		return { basis: "months", own, other };
	};
	const rowsMonths = (rows) => {
		const set = new Set();
		let resolved = rows.length > 0;
		for (const r of rows) {
			const p = helpers.loadRowPeriods(r, cover);
			if (p && p.resolved) for (const m of p.periods) set.add(m);
			else resolved = false;
		}
		const sorted = [...set].sort();
		const closed = new Set(helpers.lockedAmong(sorted));
		return { months: sorted.map((month) => ({ month, closed: closed.has(month) })), resolved };
	};
	// The restore route's checks, in its order, over every row with the Load ID.
	const pressOf = (rec, mode) => {
		if (!rec.all.length) return { code: "NO_SHEET_ROW" };
		if (mode === "create_new" && splitRows(rec.t, rec.live).own.length) return { code: "DELETED_ROWS_PRESENT" };
		const months = new Set();
		let resolved = true;
		for (const r of rec.all) {
			const p = helpers.loadRowPeriods(r, cover);
			if (!p || !p.resolved) resolved = false;
			for (const m of (p && p.periods) || []) months.add(m);
		}
		if (!resolved) return { code: "PERIOD_UNRESOLVED" };
		if (helpers.lockedAmong([...months]).length) return { code: "PERIOD_FINALIZED" };
		return { code: "OK", months: [...months].sort(), remaining: rec.sameKey - 1, liveRows: rec.live.length };
	};

	const recs = tombstones.map((t) => {
		const key = normalizeLoadId(t.load_id);
		return {
			t, id: t.id, key,
			all: (key && allByKey.get(key)) || [],
			live: (key && liveByKey.get(key)) || [],
			deletedMs: sqliteUtcMs(t.deleted_at),
			recorded: parseDigests(t.row_digests) !== null,
			sameKey: (key && tombsByKey.get(key) || []).length,
		};
	});
	const knownMs = recs.map((r) => r.deletedMs).filter((ms) => !Number.isNaN(ms));
	const creates = createsSince(db, Math.min(now - WINDOW_MS, ...knownMs));
	for (const rec of recs) {
		rec.restore = pressOf(rec, "restore");
		rec.createNew = pressOf(rec, "create_new");
		if (!rec.live.length) {
			rec.group = "none";
			continue;
		}
		rec.split = splitRows(rec.t, rec.live);
		rec.monthsInfo = rowsMonths(rec.live);
		if (rec.split.basis === "digests" && !rec.split.other.length) {
			rec.group = "notShown";
			rec.why = "recordedRows";
			continue;
		}
		const evidence = [];
		if (rec.split.basis === "none") evidence.push("deleted_with_no_row");
		const later = Number.isNaN(rec.deletedMs) ? [] : (creates.get(rec.key) || []).filter((x) => x.ms > rec.deletedMs);
		for (const kind of CREATED) if (later.some((x) => x.evidence === kind)) evidence.push(kind);
		if (rec.split.basis === "digests" && rec.split.recorded > 0) evidence.push("row_changed");
		if (rec.split.basis === "months" && rec.split.other.length) evidence.push("row_in_other_month");
		rec.evidence = evidence;
		if (!evidence.length) {
			rec.group = "notShown";
			if (rec.split.basis !== "months") rec.why = "other";
			else if (!nearestOf(rec.t)) rec.why = "noAuditRow";
			else rec.why = namedMonths(rec.t).length ? "auditNamesItsMonths" : "auditNamesNoMonth";
		} else if (rec.monthsInfo.resolved && rec.monthsInfo.months.length && rec.monthsInfo.months.every((x) => x.closed)) {
			rec.group = "closedOnly";
		} else {
			rec.group = "banner";
		}
	}
	const byId = new Map(recs.map((r) => [r.id, r]));
	const itemOf = (rec) => {
		const shown = rec.split.other[0] || rec.live[0];
		return {
			tombstoneId: rec.id,
			loadId: String(shown[dcols.loadId] || "").trim() || String(rec.t.load_id),
			sheetRow: rowNumber(shown),
			rows: rowNumbers(rec.live),
			newRows: rowNumbers(rec.split.other),
			ownRows: rowNumbers(rec.split.own),
			canRestore: true,
			canCreateNew: rec.split.own.length === 0,
			months: rec.monthsInfo.months,
			evidence: rec.evidence,
		};
	};

	// The stored notices, and the ones this reading predicts (what the module's own read just collected).
	const stored = db.prepare("SELECT type, metadata FROM dispatch_notifications WHERE type IN (?, ?)").all(restoreLib.NOTICE_TYPE, restoreLib.RESTORED_NOTICE_TYPE)
		.map((r) => {
			let meta = {};
			try { meta = JSON.parse(r.metadata || "{}") || {}; } catch { meta = {}; }
			return { type: r.type, kind: meta.kind, tombstoneId: meta.tombstoneId };
		});
	const hiddenStored = stored.filter((n) => n.type === restoreLib.NOTICE_TYPE);
	const toldOf = (kind) => new Set(hiddenStored.filter((n) => n.kind === kind).map((n) => n.tombstoneId));
	const toldHidden = toldOf("hidden");
	const toldClosed = toldOf("hidden_closed");
	const bannerRecs = recs.filter((r) => r.group === "banner");
	const closedRecs = recs.filter((r) => r.group === "closedOnly");
	const notShownRecs = recs.filter((r) => r.group === "notShown");
	const predictedNotices = [
		...bannerRecs.filter((r) => !toldHidden.has(r.id)).map((r) => ({ kind: "hidden", tombstoneId: r.id })),
		...closedRecs.filter((r) => !toldClosed.has(r.id)).map((r) => ({ kind: "hidden_closed", tombstoneId: r.id })),
	];

	// The module's answer and this reading must agree, line for line and notice for notice.
	const FIELDS = ["tombstoneId", "loadId", "sheetRow", "rows", "newRows", "ownRows", "canRestore", "canCreateNew", "months", "evidence"];
	const pick = (x) => canon(Object.fromEntries(FIELDS.map((f) => [f, x[f]])));
	const theirs = new Map(banner.map((x) => [x.tombstoneId, pick(x)]));
	const mine = new Map(bannerRecs.map((r) => [r.id, pick(itemOf(r))]));
	const differ = new Set([...theirs.keys(), ...mine.keys()].filter((id) => theirs.get(id) !== mine.get(id)));
	const noticeKeys = (list) => new Set(list.map((n) => `${n.kind}:${n.tombstoneId}`));
	const toldKeys = noticeKeys(told);
	const predictedKeys = noticeKeys(predictedNotices);
	for (const n of [...told, ...predictedNotices]) {
		const k = `${n.kind}:${n.tombstoneId}`;
		if (toldKeys.has(k) !== predictedKeys.has(k)) differ.add(n.tombstoneId);
	}
	if (told.length !== toldKeys.size) differ.add("a notice twice");
	if (differ.size) throw new Failure("CHECK_FAILED", [...differ].sort((a, b) => Number(a) - Number(b)));

	// 1a: the banner as the module answers it.
	const evidenceCounts = Object.fromEntries(EVIDENCE.map((e) => [e, 0]));
	const press = { createNew: 0, onlyRestore: 0, neither: 0 };
	const bannerMonths = new Map();
	let bannerNoMonth = 0;
	const p1 = { count: 0, noRowNumber: 0, datesMoved: 0 };
	const person = [];
	const confirmedNoRow = (rec) => auditsFor(rec.t.load_id).some((a) => {
		const ms = Date.parse(String(a.timestamp || ""));
		return !Number.isNaN(ms) && !Number.isNaN(rec.deletedMs) && Math.abs(ms - rec.deletedMs) <= OWN_AUDIT_MS && String(a.details || "").includes(NO_ROW_TEXT);
	});
	for (const item of [...banner].sort((a, b) => a.tombstoneId - b.tombstoneId)) {
		const rec = byId.get(item.tombstoneId);
		for (const e of item.evidence || []) if (e in evidenceCounts) evidenceCounts[e]++;
		if (rec.restore.code !== "OK") press.neither++;
		else if (item.canCreateNew) press.createNew++;
		else press.onlyRestore++;
		for (const m of item.months || []) bump(bannerMonths, m.month);
		if (!rec.monthsInfo.resolved) bannerNoMonth++;
		const ev = item.evidence || [];
		let why = "";
		if (item.canCreateNew && ev.includes("deleted_with_no_row") && !confirmedNoRow(rec)) {
			p1.noRowNumber++;
			why = "no row number at an older delete";
		} else if (item.canCreateNew && ev.length === 1 && ev[0] === "row_in_other_month" && (item.rows || []).length === 1) {
			p1.datesMoved++;
			why = "dates moved, one live row";
		}
		if (why) {
			p1.count++;
			person.push({ group: "P1", record: item.tombstoneId, loadId: item.loadId, rows: item.rows || [], why });
		}
	}

	// 1b: closed months only, a count per month.
	const closedMonths = new Map();
	for (const rec of closedRecs) for (const m of rec.monthsInfo.months) bump(closedMonths, m.month);

	// 1c: not shown, by why; open months by month, closed ones as one count; P2 from open months only.
	const why = { auditNamesItsMonths: 0, noAuditRow: 0, auditNamesNoMonth: 0, recordedRows: 0, other: 0 };
	const openMonths = new Map();
	let notShownClosed = 0;
	let notShownNoMonth = 0;
	const p2 = { moreThanOneLiveRow: 0, noneAtStoredRow: 0 };
	const p2Person = [];
	for (const rec of notShownRecs) {
		why[rec.why]++;
		const open = rec.monthsInfo.months.filter((m) => !m.closed);
		for (const m of open) bump(openMonths, m.month);
		if (rec.monthsInfo.months.some((m) => m.closed)) notShownClosed++;
		if (!rec.monthsInfo.resolved) notShownNoMonth++;
		if (rec.split.basis !== "months" || !open.length) continue;
		const signals = [];
		if (rec.live.length > 1) {
			p2.moreThanOneLiveRow++;
			signals.push("more than one live row");
		}
		const storedRow = Number(rec.t.row_index);
		if (storedRow > 0 && !rec.live.some((r) => r._rowIndex === storedRow)) {
			p2.noneAtStoredRow++;
			signals.push(`none at its stored row number, ${storedRow}`);
		}
		if (signals.length) {
			const shown = String(rec.live[0][dcols.loadId] || "").trim() || String(rec.t.load_id);
			p2Person.push({ group: "P2", record: rec.id, loadId: shown, rows: rowNumbers(rec.live), why: signals.join("; ") });
		}
	}
	person.push(...p2Person.sort((a, b) => a.record - b.record));

	// 3: every Restore button.
	const restoreMonths = new Map();
	const buttons = {
		count: recs.length,
		restore: { count: 0, months: {}, cancelledRowsOnly: 0, anotherDeleteStays: 0 },
		refuse: { count: 0, closedMonth: 0, noMonth: 0, noSheetRow: 0 },
	};
	for (const rec of recs) {
		const r = rec.restore;
		if (r.code === "OK") {
			buttons.restore.count++;
			for (const m of r.months) bump(restoreMonths, m);
			if (r.liveRows === 0) buttons.restore.cancelledRowsOnly++;
			if (r.remaining > 0) buttons.restore.anotherDeleteStays++;
			continue;
		}
		buttons.refuse.count++;
		if (r.code === "PERIOD_FINALIZED") buttons.refuse.closedMonth++;
		else if (r.code === "PERIOD_UNRESOLVED") buttons.refuse.noMonth++;
		else if (r.code === "NO_SHEET_ROW") buttons.refuse.noSheetRow++;
	}
	buttons.restore.months = sortedCounts(restoreMonths);

	// 4: the Load IDs a create would now stop on, and the last 90 days' creates after a delete of their ID.
	const last90 = { rateCon: 0, rateConByRole: { Dispatcher: 0, "Super Admin": 0, other: 0 }, newJobOrDataManager: 0, n8n: 0 };
	for (const [key, list] of creates) {
		const deletes = (tombsByKey.get(key) || []).map((t) => sqliteUtcMs(t.deleted_at)).filter((ms) => !Number.isNaN(ms));
		for (const x of list) {
			if (x.ms < now - WINDOW_MS || !deletes.some((ms) => ms < x.ms)) continue;
			if (x.evidence === "created_by_rate_con") {
				last90.rateCon++;
				if (x.role === "Dispatcher" || x.role === "Super Admin") last90.rateConByRole[x.role]++;
				else last90.rateConByRole.other++;
			} else if (x.evidence === "created_in_sheet_row") last90.newJobOrDataManager++;
			else last90.n8n++;
		}
	}

	const monthsNamed = [...new Set([...bannerMonths.keys(), ...closedMonths.keys(), ...openMonths.keys(), ...restoreMonths.keys()])].sort();
	const lockedNamed = new Set(helpers.lockedAmong(monthsNamed));
	const count = (sql, ...params) => db.prepare(sql).get(...params).n;
	const kindCount = (kind) => hiddenStored.filter((n) => n.kind === kind).length;
	const personKeys = new Set(person.map((p) => normalizeLoadId(p.loadId)));
	const withLive = recs.filter((r) => r.live.length);
	const out = {
		dryRun: true,
		state: {
			flag: env.DELETED_LOAD_RESTORE_ENABLED === "true" ? "on" : "off",
			tripCover: tripCover ? "on" : "off",
			rows: every.length,
			rowsAfterDedupe: (jt.data || []).length,
			records: recs.length,
			loadIds: new Set(recs.map((r) => r.key).filter(Boolean)).size,
			withRecordedRows: recs.filter((r) => r.recorded).length,
			storedNotices: {
				hidden: kindCount("hidden"),
				hiddenClosed: kindCount("hidden_closed"),
				refusedCreate: kindCount("refused_create"),
				restored: stored.filter((n) => n.type === restoreLib.RESTORED_NOTICE_TYPE).length,
			},
			restoreLoad: count("SELECT COUNT(*) AS n FROM audit_trail WHERE action = ? AND entity = 'load'", "restore_load"),
			clearLoadDelete: count("SELECT COUNT(*) AS n FROM audit_trail WHERE action = ? AND entity = 'load'", "clear_load_delete"),
		},
		months: monthsNamed.map((month) => ({ month, closed: lockedNamed.has(month) })),
		withLiveRow: { count: withLive.length, of: recs.length, older: withLive.filter((r) => !r.recorded).length, recorded: withLive.filter((r) => r.recorded).length },
		banner: {
			count: banner.length,
			records: banner.map((x) => x.tombstoneId).sort((a, b) => a - b),
			evidence: evidenceCounts,
			press,
			months: sortedCounts(bannerMonths),
			noMonth: bannerNoMonth,
			p1,
		},
		closedOnly: { count: closedRecs.length, months: sortedCounts(closedMonths) },
		notShown: { count: notShownRecs.length, why, openMonths: sortedCounts(openMonths), closed: notShownClosed, noMonth: notShownNoMonth, p2 },
		notices: {
			wouldWrite: { hidden: told.filter((n) => n.kind === "hidden").length, hidden_closed: told.filter((n) => n.kind === "hidden_closed").length },
			stored: { hidden: kindCount("hidden"), hidden_closed: kindCount("hidden_closed") },
		},
		buttons,
		creates: { loadIds: new Set(recs.map((r) => r.key).filter(Boolean)).size, last90Days: last90 },
		cost: { medianMs: Math.round(median(times) * 10) / 10, runs: times.length, records: recs.length, rows: every.length },
		person: { count: personKeys.size, printed: ids === true },
	};
	if (ids === true) out.person.ids = person;
	const model = {
		banner,
		bannerReplica: bannerRecs.map(itemOf),
		notices: told,
		predictedNotices,
		records: recs.map((r) => ({ id: r.id, group: r.group, restore: r.restore, createNew: r.createNew })),
	};
	return { out, model };
}

// Each Load ID's creates since `sinceMs` as app.db records them (key -> [{ evidence, ms, role }]), read as the
// module reads them: a rate con's audit row, New Job's or the Data Manager's create_sheet_row on Job Tracking,
// and n8n's new-load notice.
function createsSince(db, sinceMs) {
	const out = new Map();
	const add = (raw, evidence, ms, role) => {
		const key = normalizeLoadId(raw);
		if (!key || Number.isNaN(ms)) return;
		if (!out.has(key)) out.set(key, []);
		out.get(key).push({ evidence, ms, role });
	};
	const sinceIso = new Date(sinceMs).toISOString();
	const sinceSql = sinceIso.slice(0, 19).replace("T", " ");
	for (const r of db.prepare("SELECT entity_id, timestamp, role FROM audit_trail WHERE action = 'create_load_ratecon' AND entity = 'load' AND timestamp >= ?").all(sinceIso)) {
		add(r.entity_id, "created_by_rate_con", Date.parse(r.timestamp), r.role);
	}
	for (const r of db.prepare("SELECT details, timestamp, role FROM audit_trail WHERE action = 'create_sheet_row' AND entity = 'sheet_row' AND entity_id LIKE 'Job Tracking!%' AND timestamp >= ?").all(sinceIso)) {
		let changed = [];
		try { changed = (JSON.parse(r.details || "{}").changed) || []; } catch { changed = []; }
		const cell = Array.isArray(changed) ? changed.find((c) => c && /load.?id|job.?id/i.test(String(c.column || ""))) : null;
		if (cell) add(cell.to, "created_in_sheet_row", Date.parse(r.timestamp), r.role);
	}
	for (const r of db.prepare("SELECT metadata, created_at FROM dispatch_notifications WHERE type = 'new-load' AND created_at >= ?").all(sinceSql)) {
		let meta = {};
		try { meta = JSON.parse(r.metadata || "{}") || {}; } catch { meta = {}; }
		if (meta.source === "n8n") add(meta.loadId, "created_by_n8n", sqliteUtcMs(r.created_at), "n8n");
	}
	return out;
}

// "row 4", "rows 2 and 4", "rows 2, 4 and 6".
function rowsText(rows) {
	const list = rows.map(String);
	if (list.length < 2) return `row ${list[0] || "unknown"}`;
	return `rows ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function textOf(o) {
	const closed = new Map(o.months.map((m) => [m.month, m.closed]));
	const state = (month) => (closed.get(month) ? "closed" : "open");
	const join = (parts) => parts.join("; ") || "none";
	const s = o.state;
	const stored = s.storedNotices;
	const b = o.banner;
	const e = b.evidence;
	const ns = o.notShown;
	const bt = o.buttons;
	const c = o.creates.last90Days;
	const hiddenTotal = stored.hidden + stored.hiddenClosed + stored.refusedCreate;
	const restoreParts = Object.entries(bt.restore.months).map(([m, n]) => `${m} ${n}`).join(", ");
	const restoreDetail = bt.restore.count
		? ` (${restoreParts}; cancelled rows only ${bt.restore.cancelledRowsOnly}; another delete of the Load ID still hides it ${bt.restore.anotherDeleteStays})`
		: "";
	const lines = [
		"DRY RUN (nothing written, nothing sent): what DELETED_LOAD_RESTORE_ENABLED would change",
		`  flag in the app's settings: ${s.flag}; trip work-day cover: ${s.tripCover}; Job Tracking rows ${s.rows} (${s.rowsAfterDedupe} after the dedupe)`,
		`  delete records ${s.records} (${s.loadIds} Load IDs); with recorded rows ${s.withRecordedRows}; stored notices: ${restoreLib.NOTICE_TYPE} ${hiddenTotal} ` +
			`(hidden ${stored.hidden}, hidden_closed ${stored.hiddenClosed}, refused_create ${stored.refusedCreate}), ${restoreLib.RESTORED_NOTICE_TYPE} ${stored.restored}; ` +
			`restore_load ${s.restoreLoad}; clear_load_delete ${s.clearLoadDelete}`,
		`  months named below: ${o.months.map((m) => `${m.month} ${m.closed ? "closed" : "open"}`).join(", ") || "none"}`,
		`1. deletes with a live row: ${o.withLiveRow.count} of ${o.withLiveRow.of} (older ${o.withLiveRow.older}, with recorded rows ${o.withLiveRow.recorded})`,
		`  1a. on the banner: ${b.count}${b.records.length ? ` (records ${b.records.join(", ")})` : ""}`,
		`      evidence: no row at the delete ${e.deleted_with_no_row}; rate con after it ${e.created_by_rate_con}; New Job or Data Manager after it ${e.created_in_sheet_row}; ` +
			`n8n after it ${e.created_by_n8n}; row changed ${e.row_changed}; row in another month ${e.row_in_other_month}`,
		`      a press now: Create it as new clears it ${b.press.createNew}; only Restore, bringing the deleted row back ${b.press.onlyRestore}; neither ${b.press.neither}`,
		`      months: ${join([...Object.entries(b.months).map(([m, n]) => `${m} ${state(m)} ${n}`), ...(b.noMonth ? [`no month ${b.noMonth}`] : [])])}`,
		`      may be the deleted row itself, Create it as new offered (P1): ${b.p1.count} (no row number at an older delete ${b.p1.noRowNumber}; dates moved, one live row ${b.p1.datesMoved})`,
		`  1b. closed months only (off the banner, one notice each): ${o.closedOnly.count}${o.closedOnly.count ? ` (${Object.entries(o.closedOnly.months).map(([m, n]) => `${m} ${n}`).join(", ")})` : ""}`,
		`  1c. not shown: ${ns.count} (audit names its months ${ns.why.auditNamesItsMonths}; no audit row ${ns.why.noAuditRow}; audit names no month ${ns.why.auditNamesNoMonth}` +
			`${ns.why.recordedRows ? `; recorded rows only ${ns.why.recordedRows}` : ""}${ns.why.other ? `; other ${ns.why.other}` : ""})`,
		`      months: ${join([...Object.entries(ns.openMonths).map(([m, n]) => `${m} open ${n}`), ...(ns.closed ? [`closed ${ns.closed}`] : []), ...(ns.noMonth ? [`no month ${ns.noMonth}`] : [])])}`,
		`      for a person, open months (P2): more than one live row ${ns.p2.moreThanOneLiveRow}; none at the stored row number ${ns.p2.noneAtStoredRow}`,
		`2. notices the next Super Admin dashboard read would write: ${o.notices.wouldWrite.hidden + o.notices.wouldWrite.hidden_closed} ` +
			`(hidden ${o.notices.wouldWrite.hidden}, hidden_closed ${o.notices.wouldWrite.hidden_closed}); already stored: hidden ${o.notices.stored.hidden}, hidden_closed ${o.notices.stored.hidden_closed}`,
		`3. Restore buttons: ${bt.count}. A press would restore ${bt.restore.count}${restoreDetail};`,
		`   refuse ${bt.refuse.count}: closed month ${bt.refuse.closedMonth}, no month ${bt.refuse.noMonth}, no Job Tracking row ${bt.refuse.noSheetRow}`,
		`4. Load IDs that would stop a create: ${o.creates.loadIds}. Last 90 days, creates after a delete: rate con ${c.rateCon} ` +
			`(Dispatcher ${c.rateConByRole.Dispatcher}, Super Admin ${c.rateConByRole["Super Admin"]}${c.rateConByRole.other ? `, other roles ${c.rateConByRole.other}` : ""}); ` +
			`New Job or Data Manager ${c.newJobOrDataManager}; n8n ${c.n8n}`,
		`5. dashboard check: ${o.cost.medianMs.toFixed(1)} ms (median of ${o.cost.runs}; go ahead at ${COST_LIMIT_MS} ms or less) over ${o.cost.records} records and ${o.cost.rows} rows`,
		`load numbers for a person: ${o.person.count} (${o.person.printed ? "printed below, as real data" : "not printed; run with --ids"})`,
	];
	if (o.person.printed) {
		lines.push("REAL DATA (load numbers for a person; keep this output mode 600, outside the repo, and delete it once reviewed):");
		for (const p of o.person.ids) lines.push(`  ${p.group} record ${p.record}: load ${p.loadId}, ${rowsText(p.rows)} (${p.why})`);
		if (!o.person.ids.length) lines.push("  none");
		lines.push("END OF REAL DATA");
	}
	return lines.join("\n");
}

// The whole run: `env` is where SPREADSHEET_ID is looked for (this process's environment by default).
async function run(argv, { env = process.env, now = Date.now(), root = ROOT } = {}) {
	const args = parseArgs(argv);
	const t = targets(args, { env, root });
	const db = openReadOnly(t.scope.file, root);
	try {
		checkShape(db);
		let lifted;
		try {
			lifted = liftHelpers({ root, dbPath: t.scope.file, db, envFile: t.envFile, readonly: true });
		} catch (e) {
			if (e instanceof Refusal || e instanceof Failure) throw e;
			throw new Failure("LIFT_FAILED");
		}
		const values = t.live ? await readLiveSheet(t, root) : readValuesFile(t.valuesFile);
		const jt = jobTrackingRead(values, lifted.sheet);
		const { out, model } = buildReport({ db, jt, helpers: lifted.helpers, env: lifted.env, now, ids: args.ids === true });
		return { args, out, model, text: textOf(out) };
	} finally {
		db.close();
	}
}

async function main(argv = process.argv.slice(2)) {
	try {
		const r = await run(argv);
		process.stdout.write(`${r.args.json ? JSON.stringify(r.out, null, 2) : r.text}\n`);
		return 0;
	} catch (e) {
		if (e instanceof Refusal) {
			process.stderr.write(`REFUSED: ${e.message}\n`);
			return 2;
		}
		if (e instanceof Failure && e.code === "CHECK_FAILED") {
			process.stderr.write(`FAILED: CHECK_FAILED (records ${e.records.join(", ")}): this report's reading of those deletes differs from the module's banner or notices, so its counts can't be trusted\n`);
			return 1;
		}
		const code = e instanceof Failure ? e.code : (e && /^[A-Z][A-Z0-9_]{1,40}$/.test(String(e.code || "")) ? String(e.code) : "REPORT_FAILED");
		process.stderr.write(`FAILED: ${code}\n`);
		return 1;
	}
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = {
	EXTRA_ROOTS, STAND_INS, Refusal, Failure, parseArgs, targets, targetRefusal, openReadOnly, checkShape, liftHelpers, jobTrackingRead,
	mountHelpers, buildReport, createsSince, textOf, run, main,
};
