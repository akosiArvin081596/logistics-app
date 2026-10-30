#!/usr/bin/env node
// Read-only count report for the Super Admin "Cancelled loads" list
// (CANCELLED_LOADS_PAGE_ENABLED): what the page would list, in counts only, for
// the "what would change" check before the flag goes on. The loads come from
// lib/cancelled-loads-view.js with the reads the route makes (recordQueries()),
// so every bucket is the page's. It also counts what a later version could add
// (dispatch-feed times, other audit rows) and what the page leaves out.
//
//   node scripts/cancelled-loads-report.js --db=<app.db> --sheets-json=<replica sheets.json> [--json]
//   node scripts/cancelled-loads-report.js --db=<app.db> --values-json=<saved values.get> [--json]
//   node scripts/cancelled-loads-report.js --db=<app.db> --sheet-id=<id> [--key=<service-account key file>] [--json]
//
// --db is opened read-only; a missing file is refused, never created.
// --sheets-json: a replica Sheets working copy (format 1, the "main" spreadsheet,
// its Job Tracking tab). --values-json: a saved values.get of Job Tracking.
// --sheet-id: Job Tracking read with the spreadsheets.readonly scope
// (scripts/lib/ledger-world.js sheetFor()), the only form that reads a key file
// or the network. The tab is parsed and de-duplicated by server.js's own code,
// lifted at run time (scripts/lib/server-lift.js).
// Prints counts only: no Load ID, name, account, reason or driver. Writes nothing.
// Exit 0; 2 on a refused argument or input; 1 on any other failure.

"use strict";

const fs = require("fs");
const path = require("path");
const view = require("../lib/cancelled-loads-view");
const appTime = require("../lib/app-time");
const ratecon = require("../lib/ratecon-load");
const { closure } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");

const { normalizeLoadId } = ratecon;
const ROOT = path.join(__dirname, "..");
const KNOWN_ARGS = new Set(["db", "sheets-json", "values-json", "sheet-id", "key", "json"]);
const SHEET_ARGS = ["sheets-json", "values-json", "sheet-id"];
const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,200}$/;
const TABLES = ["load_status_history", "audit_trail", "deleted_loads", "dispatch_notifications", "documents"];
// The first dispatch-feed row that means a cancel (SQLite UTC): before it the
// Cancel button set the load Unassigned under the same feed type.
const FEED_CANCEL_FROM = "2026-04-20 01:14:15";
// A JSON cell longer than this is not parsed; the server's own builders stay far below it.
const JSON_MAX = 200000;
// The server code the report reads the sheet with. Nothing that reaches Google,
// the database, the mailer or the HTTP server may come along.
const LIFT_ROOTS = ["parseSheet", "deduplicateLoads", "findCol", "CANCELED_STATUS_RE", "excludeDroppedLoads", "jobTrackingMonthCols", "RATECON_DOC_TYPES"];
const LIFT_DENIED = ["db", "app", "io", "server", "getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "sendEmail", "transporter", "getDrive", "jtCacheInvalidate"];

function refused(msg) {
	const e = new Error(msg);
	e.refused = true;
	return e;
}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/.exec(a);
		if (!m) throw refused(`unknown argument ${JSON.stringify(String(a).slice(0, 40))}`);
		if (!KNOWN_ARGS.has(m[1])) throw refused(`unknown argument --${m[1]}`);
		out[m[1]] = m[2] === undefined ? true : m[2];
	}
	return out;
}

// Every refusal that needs no file, before anything is opened.
function checkArgs(args) {
	if (typeof args.db !== "string" || !args.db) throw refused("--db=<app.db> is required");
	for (const k of [...SHEET_ARGS, "key"]) {
		if (args[k] === true || args[k] === "") throw refused(`--${k} needs a value`);
	}
	if (args.json !== undefined && args.json !== true) throw refused("--json takes no value");
	if (SHEET_ARGS.filter((k) => args[k] !== undefined).length !== 1) throw refused("give exactly one of --sheets-json, --values-json or --sheet-id");
	if (args["sheet-id"] !== undefined && !SHEET_ID_RE.test(args["sheet-id"])) throw refused("--sheet-id: name the sheet by its ID; there is no default sheet");
	if (args.key !== undefined && args["sheet-id"] === undefined) throw refused("--key is for --sheet-id only");
}

function openReadOnly(file) {
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	let db;
	try {
		db = new Database(file, { readonly: true, fileMustExist: true });
	} catch (e) {
		throw refused(`cannot open the database read-only: ${String(e.message).slice(0, 120)}`);
	}
	if (!db.readonly) {
		db.close();
		throw refused("the database did not open read-only");
	}
	return db;
}

function valuesOf(doc, flag) {
	const values = (doc && doc.values) || (doc && doc.data && doc.data.values);
	if (!Array.isArray(values)) throw refused(`${flag} holds no values.get answer ({ values: [...] })`);
	return values;
}

// The Job Tracking values from the one sheet argument given.
async function readValues(args) {
	if (args["sheet-id"] !== undefined) {
		// The only path that reads a key file or the network (spreadsheets.readonly).
		const { sheetFor } = require("./lib/ledger-world");
		return valuesOf(await sheetFor({ "sheet-id": args["sheet-id"], key: args.key }, ROOT), "--sheet-id");
	}
	const file = String(args["values-json"] !== undefined ? args["values-json"] : args["sheets-json"]);
	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		throw refused(`cannot read ${path.basename(file)}: ${String(e.message).slice(0, 120)}`);
	}
	if (args["values-json"] !== undefined) return valuesOf(doc, "--values-json");
	if (!doc || doc.format !== 1 || !doc.spreadsheets || typeof doc.spreadsheets !== "object") {
		throw refused("--sheets-json is not a replica Sheets working copy (format 1)");
	}
	const mains = Object.values(doc.spreadsheets).filter((b) => b && b.role === "main");
	if (mains.length !== 1) throw refused(`--sheets-json must hold exactly one main spreadsheet, found ${mains.length}`);
	const tabs = Array.isArray(mains[0].sheets) ? mains[0].sheets : [];
	const title = (t) => String((t && t.properties && t.properties.title) || "");
	const tab = tabs.find((t) => title(t) === "Job Tracking") || tabs.find((t) => title(t).toLowerCase() === "job tracking");
	if (!tab || !Array.isArray(tab.values)) throw refused("the main spreadsheet has no Job Tracking tab");
	return tab.values;
}

// parseSheet(), deduplicateLoads(), CANCELED_STATUS_RE, excludeDroppedLoads(),
// jobTrackingMonthCols() and RATECON_DOC_TYPES as server.js has them.
function liftServer(root = ROOT) {
	const src = serverSource({ root });
	const lifted = closure(src, { roots: LIFT_ROOTS, provided: ["require", "getDeletedLoadIds"], denied: LIFT_DENIED });
	const liftedRequire = (m) => {
		if (m !== "./lib/ratecon-load") throw new Error(`lifted code required ${m}, which the report does not load`);
		return ratecon;
	};
	// Every call passes its own deleted set, so a read of its own would be a bug.
	const noDeletedRead = () => { throw new Error("the report hands excludeDroppedLoads() its own deleted set"); };
	return new Function("require", "getDeletedLoadIds", `"use strict";\n${lifted.text}\nreturn { ${LIFT_ROOTS.join(", ")} };`)(liftedRequire, noDeletedRead);
}

function jsonOf(v) {
	const s = v == null ? "" : String(v);
	if (!s || s.length > JSON_MAX) return null;
	try {
		const parsed = JSON.parse(s);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function buildReport({ values, db, helpers = liftServer(), zone = appTime.appTimeZone() }) {
	const parsed = helpers.parseSheet({ values });
	const headers = parsed.headers;
	const cols = view.sheetColumns(headers);
	if (!cols.loadIdCol || !cols.statusCol) throw refused("the Job Tracking values have no Load ID or status column");
	const re = helpers.CANCELED_STATUS_RE;
	const isCancelled = (v) => re.test(String(v == null ? "" : v).trim());
	const rows = helpers.deduplicateLoads(parsed.data, headers);
	const base = { headers, cancelledStatusRe: re, normalizeLoadId };
	const listed = view.cancelledSheetRows({ ...base, rows });
	const keys = view.cancelledKeys({ ...base, rows });

	// The page's own reads, then the page's own rows.
	const q = view.recordQueries(keys);
	const read = (stmts) => stmts.flatMap((s) => db.prepare(s.sql).all(...s.params));
	const loads = view.cancelledLoadRows({
		...base,
		rows,
		history: read(q.history),
		audits: read(q.audit),
		deleted: read([q.deleted]),
		cols: helpers.jobTrackingMonthCols(headers),
		shownLoadId: (raw) => raw,
		timeZone: zone,
	});
	const count = (pred) => loads.filter(pred).length;
	const recorded = (l) => l.cancelledAt !== "";
	const keyOfRow = new Map(listed.map((c) => [c.row._rowIndex, c.key]));
	const moneyFilterDrops = rows.length - helpers.excludeDroppedLoads(rows, headers, new Set()).length;

	// A listed load with an earlier copy that is not cancelled (the bottom row wins).
	const rawCancelled = new Set(view.cancelledSheetRows({ ...base, rows: parsed.data }).map((c) => c.row));
	const rawByKey = new Map();
	for (const r of parsed.data) {
		const k = normalizeLoadId(r[cols.loadIdCol]);
		if (!k) continue;
		if (!rawByKey.has(k)) rawByKey.set(k, []);
		rawByKey.get(k).push(r);
	}
	const earlierCopyNotCancelled = listed.filter((c) => c.key && rawByKey.get(c.key).some((r) => r !== c.row && !rawCancelled.has(r))).length;

	// What a later version could add: dispatch-feed cancel times (no account), and
	// other recorded status changes to cancelled (audit rows from other screens).
	const feedKeys = new Set();
	for (const f of db.prepare("SELECT metadata FROM dispatch_notifications WHERE type = ? AND created_at >= ?").all("load-cancelled", FEED_CANCEL_FROM)) {
		const m = jsonOf(f.metadata);
		const k = m ? normalizeLoadId(m.loadId) : "";
		if (k) feedKeys.add(k);
	}
	const otherAuditKeys = new Set();
	const otherCancelAudits = { withLoadId: 0, withoutLoadId: 0 };
	for (const r of db.prepare("SELECT details FROM audit_trail WHERE action = ? AND entity = ?").all("update_sheet_row", "sheet_row")) {
		const d = jsonOf(r.details);
		if (!d || d.sheet !== "Job Tracking" || !Array.isArray(d.changed)) continue;
		const toCancelled = d.changed.some((c) => c && view.sheetColumns([String(c.column == null ? "" : c.column)]).statusCol && isCancelled(c.to) && !isCancelled(c.from));
		if (!toCancelled) continue;
		const k = normalizeLoadId(d.loadId);
		if (k) {
			otherCancelAudits.withLoadId++;
			otherAuditKeys.add(k);
		} else {
			otherCancelAudits.withoutLoadId++;
		}
	}
	const notRecorded = loads.filter((l) => !recorded(l));
	const split = (keySet) => ({
		none: notRecorded.filter((l) => l.recordedBy === "none" && keySet.has(keyOfRow.get(l.rowIndex))).length,
		changedAfter: notRecorded.filter((l) => l.recordedBy === "changed-after" && keySet.has(keyOfRow.get(l.rowIndex))).length,
	});

	const monthCounts = {};
	for (const l of loads) if (recorded(l)) monthCounts[l.cancelledDay.slice(0, 7)] = (monthCounts[l.cancelledDay.slice(0, 7)] || 0) + 1;
	const months = Object.keys(monthCounts).sort();

	// Loads with a cancel on record whose sheet status is not cancelled now.
	const listedKeys = new Set(keys);
	const sheetKeys = new Set(rows.map((r) => normalizeLoadId(r[cols.loadIdCol])).filter(Boolean));
	const onRecord = new Set();
	for (const h of db.prepare("SELECT load_id, new_status FROM load_status_history").all()) {
		if (isCancelled(h.new_status)) onRecord.add(String(h.load_id == null ? "" : h.load_id));
	}
	for (const a of db.prepare("SELECT action, entity_id, details FROM audit_trail WHERE entity = ? AND action IN (?, ?, ?)").all("load", "cancel_load", "status_override", "update_status")) {
		const to = a.action === "cancel_load" ? "Cancelled"
			: a.action === "status_override" ? (view.parseStatusOverrideAudit(a.details) || {}).to
			: (view.parseUpdateStatusAudit(a.details) || {}).to;
		if (to != null && isCancelled(to)) onRecord.add(normalizeLoadId(a.entity_id));
	}
	onRecord.delete("");
	const notCancelledNow = [...onRecord].filter((k) => !listedKeys.has(k));

	// Information only: a documents row is not the Drive folder.
	const types = [...helpers.RATECON_DOC_TYPES];
	const docKeys = new Set(db.prepare(`SELECT load_id FROM documents WHERE deleted_at IS NULL AND UPPER(type) IN (${types.map(() => "?").join(", ")})`)
		.all(...types).map((d) => normalizeLoadId(d.load_id)).filter(Boolean));

	const out = {
		generatedAt: new Date().toISOString(),
		timeZone: zone,
		sheet: {
			rowsRead: parsed.data.length,
			rowsAfterDedup: rows.length,
			cancelledRowsBeforeDedup: parsed.data.length - helpers.excludeDroppedLoads(parsed.data, headers, new Set()).length,
		},
		cancelled: {
			loads: loads.length,
			alsoDeleted: count((l) => l.alsoDeleted),
			noLoadId: count((l) => !l.hasLoadId),
			earlierCopyNotCancelled,
			moneyFilterDrops,
			matchesMoneyFilter: moneyFilterDrops === loads.length,
		},
		recorded: {
			total: count(recorded),
			cancelButton: count((l) => l.recordedBy === "cancel-button"),
			statusOverride: count((l) => l.recordedBy === "status-override"),
			driverStatus: count((l) => l.recordedBy === "driver-status"),
		},
		time: { recorded: count(recorded), notRecorded: notRecorded.length },
		account: {
			sharedLogin: count((l) => l.cancelledBySharedLogin),
			named: count((l) => l.cancelledBy !== "" && !l.cancelledBySharedLogin),
			notRecorded: count((l) => l.cancelledBy === ""),
		},
		reason: { recorded: count((l) => l.reason !== ""), notRecorded: count((l) => l.reason === "") },
		notRecorded: {
			total: notRecorded.length,
			none: count((l) => l.recordedBy === "none"),
			changedAfter: count((l) => l.recordedBy === "changed-after"),
			withFeedTime: split(feedKeys),
			withOtherAudit: split(otherAuditKeys),
		},
		byMonth: Object.fromEntries(months.map((m) => [m, monthCounts[m]])),
		noRecordedTime: notRecorded.length,
		earliestMonth: months[0] || null,
		latestMonth: months[months.length - 1] || null,
		otherCancelAudits,
		cancelEventsOnLoadsNotCancelled: {
			total: notCancelledNow.length,
			onSheet: notCancelledNow.filter((k) => sheetKeys.has(k)).length,
			notOnSheet: notCancelledNow.filter((k) => !sheetKeys.has(k)).length,
		},
		rateConDocumentRow: keys.filter((k) => docKeys.has(k)).length,
	};
	out.text = textOf(out);
	return out;
}

function textOf(r) {
	const c = r.cancelled;
	const n = r.notRecorded;
	const e = r.cancelEventsOnLoadsNotCancelled;
	const months = Object.entries(r.byMonth).map(([m, k]) => `${m} ${k}`).join(", ") || "none";
	return [
		`Cancelled loads report: read-only, counts only (${r.timeZone}, run ${r.generatedAt})`,
		`Job Tracking: ${r.sheet.rowsRead} rows read, ${r.sheet.rowsAfterDedup} after de-duplication; ${r.sheet.cancelledRowsBeforeDedup} rows with a cancelled status before de-duplication`,
		`Cancelled loads by the page's rule: ${c.loads} (also deleted ${c.alsoDeleted}, no Load ID ${c.noLoadId}); the money filter drops ${c.moneyFilterDrops} for status (${c.matchesMoneyFilter ? "the same" : "DIFFERENT: check before switch-on"})`,
		`  of which an earlier copy of the same Load ID is not cancelled (the bottom row wins): ${c.earlierCopyNotCancelled}`,
		`Recorded cancel as the latest event: ${r.recorded.total} (Cancel button ${r.recorded.cancelButton}, status override ${r.recorded.statusOverride}, driver status screen ${r.recorded.driverStatus})`,
		`Time: recorded ${r.time.recorded}, not recorded ${r.time.notRecorded}. Account: shared login ${r.account.sharedLogin}, named accounts ${r.account.named}, not recorded ${r.account.notRecorded}. Reason: recorded ${r.reason.recorded}, not recorded ${r.reason.notRecorded}`,
		`Not recorded: ${n.total} (no record ${n.none}, changed after its last recorded cancel ${n.changedAfter})`,
		`  with a dispatch-feed cancel time (no account): no record ${n.withFeedTime.none}, changed after ${n.withFeedTime.changedAfter}`,
		`  with another recorded status change to cancelled (audit rows from other screens), by Load ID: no record ${n.withOtherAudit.none}, changed after ${n.withOtherAudit.changedAfter}`,
		`By month of the recorded cancel: ${months}; no recorded time ${r.noRecordedTime}; earliest ${r.earliestMonth || "none"}, latest ${r.latestMonth || "none"}`,
		`Other recorded status changes to cancelled (audit rows from other screens), any load: with a Load ID ${r.otherCancelAudits.withLoadId}, without one ${r.otherCancelAudits.withoutLoadId}`,
		`Loads with a cancel on record whose sheet status is not cancelled now: ${e.total} (on the sheet ${e.onSheet}, not on it ${e.notOnSheet})`,
		`Cancelled loads with a live RATECON documents row: ${r.rateConDocumentRow} (information only: the Drive folder is not read, so no row does not mean no rate con)`,
	].join("\n");
}

async function run(argv) {
	const args = parseArgs(argv);
	checkArgs(args);
	const db = openReadOnly(path.resolve(args.db));
	try {
		const missing = TABLES.filter((t) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
		if (missing.length) throw refused(`the database has no ${missing.join(", ")} table${missing.length > 1 ? "s" : ""}`);
		const values = await readValues(args);
		return { args, out: buildReport({ values, db }) };
	} finally {
		db.close();
	}
}

async function main() {
	let result;
	try {
		result = await run(process.argv.slice(2));
	} catch (e) {
		if (!e.refused) {
			console.error(`FAILED: ${e.stack || e.message}`);
			process.exit(1);
		}
		console.error(`REFUSED: ${e.message}`);
		process.exit(2);
	}
	const { args, out } = result;
	if (args.json) {
		const { text: _text, ...json } = out;
		console.log(JSON.stringify(json, null, 2));
	} else {
		console.log(out.text);
	}
}

if (require.main === module) main();

module.exports = { buildReport, liftServer, readValues, parseArgs, run };
