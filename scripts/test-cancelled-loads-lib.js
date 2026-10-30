#!/usr/bin/env node
// lib/cancelled-loads-view.js: the rows of the Super Admin "Cancelled loads"
// page (GET /api/admin/cancelled-loads) and the reads behind them.
//
//   §1  which loads: the cancelled rows of the deduplicated view, by the money
//       filter's own test and columns (parity with excludeDroppedLoads()), their
//       keys, a row with no Load ID, "also deleted"
//   §2  the audit-text parsers: each template server.js writes parses; long text
//       is cut and bounded; anything else is null
//   §3  which record: each way a cancel was recorded, twins, the latest event
//       deciding, and every case that must stay "Not recorded"
//   §4  times: ISO-8601 "Z" instants only, and the Eastern business day across DST
//   §5  the shared login is marked
//   §6  Load IDs leave only through the caller's shownLoadId()
//   §7  order: recorded cancels newest first, then the rest by sheet row
//   §8  the shared reads on a read-only SQLite: keys in params only, chunks, the
//       "#" spellings, and what the page makes of the rows
//   §9  pure: the module's requires, and the writers it reads (server.js's history
//       sources and audit actions)
//
// Made-up data only. A base run: SERVER_ROOT=<a checkout> reads its server.js and lib/.
//   node scripts/test-cancelled-loads-lib.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");
const { serverSource } = require("./lib/server-source");
const { closure } = require("./lib/server-lift");

const HERE = path.join(__dirname, "..");
const ROOT = process.env.SERVER_ROOT ? path.resolve(process.env.SERVER_ROOT) : HERE;
const LIB_FILE = path.join(ROOT, "lib", "cancelled-loads-view.js");
const Database = require(path.join(HERE, "node_modules", "better-sqlite3"));
const ZONE = "America/New_York";

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function throws(fn, re, label) {
	try {
		fn();
		failures.push(`${label}\n      did not throw`);
	} catch (err) {
		ok(re.test(String(err && err.message)), `${label} (${String(err && err.message).slice(0, 80)})`);
	}
}
// A section that throws (the module missing, a function gone) fails as a whole.
function section(title, fn) {
	console.log(`\n${title}`);
	try {
		fn();
	} catch (err) {
		failures.push(`${title}\n      threw: ${String(err && err.message).split("\n")[0]}`);
	}
}

let view = null;
let loadError = null;
try { view = require(LIB_FILE); } catch (err) { loadError = err; }
ok(view, `lib/cancelled-loads-view.js loads${loadError ? ` (${String(loadError.message).split("\n")[0]})` : ""}`);

// ── server.js, lifted as the server runs it ──────────────────────────────────
const SRC = serverSource();
const LIFT = ["parseSheet", "deduplicateLoads", "excludeDroppedLoads", "CANCELED_STATUS_RE", "jobTrackingMonthCols", "findCol"];
function liftServer() {
	const lifted = closure(SRC, {
		roots: LIFT,
		provided: ["require", "getDeletedLoadIds"],
		denied: ["db", "app", "io", "server", "getSheets", "sheets", "SPREADSHEET_ID", "jtCacheInvalidate"],
	});
	const ratecon = require(path.join(ROOT, "lib", "ratecon-load.js"));
	const liftedRequire = (m) => {
		if (m !== "./lib/ratecon-load") throw new Error(`lifted code required ${m}, which this runner does not load`);
		return ratecon;
	};
	const noDeletedRead = () => { throw new Error("the runner passes its own deleted set"); };
	return new Function("require", "getDeletedLoadIds", `"use strict";\n${lifted.text}\nreturn { ${LIFT.join(", ")}, normalizeLoadId };`)(liftedRequire, noDeletedRead);
}
const server = liftServer();
const { normalizeLoadId } = server;
const RE = server.CANCELED_STATUS_RE;

// The audit texts exactly as server.js writes them: each logAudit() template
// lifted from its one line and filled with made-up values.
function auditTemplate(action, names) {
	const needle = "logAudit(req, '" + action + "', 'load', loadId, `";
	const lines = SRC.split("\n").filter((l) => l.includes(needle));
	if (lines.length !== 1) throw new Error(`expected one ${action} audit line in server.js, found ${lines.length}`);
	const l = lines[0];
	return new Function(...names, `return \`${l.slice(l.indexOf("`") + 1, l.lastIndexOf("`"))}\`;`);
}
const render = {
	cancel: auditTemplate("cancel_load", ["loadId", "boundDriver", "cancelReason"]),
	override: auditTemplate("status_override", ["oldStatus", "canonicalStatus", "overrideUser", "reason"]),
	status: auditTemplate("update_status", ["newStatus", "loadId", "driverName"]),
};

// ── the made-up sheet ─────────────────────────────────────────────────────────
const HEADERS = ["Load ID", "Job Status", "Driver", "Pickup Address", "Drop-off Address", "Pickup Appointment", "Status Update Date"];
const R = (id, status, driver = "") => [id, status, driver, "Made-up Pickup, IL", "Made-up Drop, IN", "10/18/2026 08:00", "10/18/2026 09:00:00"];
const ROWS = [
	R("LD-TEST-0101", "Cancelled"), // 2
	R("LD-TEST-0102", "canceled"), // 3
	R("LD-TEST-0103", " CANCEL "), // 4
	R("LD-TEST-0104", "Cancelled", "Made-up Driver B"), // 5
	R("LD-TEST-0105", "Cancelled", "Made-up Driver C"), // 6
	R("LD-TEST-0106", "Cancelled"), // 7
	R("LD-TEST-0107", "Cancelled"), // 8
	R("LD-TEST-0108", "Cancelled"), // 9
	R("LD-TEST-0109", "Cancelled"), // 10
	R("LD-TEST-0110", "Cancelled"), // 11
	R("LD-TEST-0111", "Cancelled"), // 12
	R("LD-TEST-0112", "Cancelled"), // 13
	R("LD-TEST-0113", "Cancelled"), // 14
	R("LD-TEST-0114", "Cancelled"), // 15
	R("LD-TEST-0115", "Cancelled"), // 16
	R("LD-TEST-0116", "Dispatched", "Made-up Driver F"), // 17: live, with an old cancel record
	R("", "Cancelled"), // 18: no Load ID
	R("LD-TEST-0117", "Cancelled"), // 19: also soft-deleted
	R("LD-TEST-0118", "Dispatched"), // 20: an earlier copy
	R("#LD-TEST-0118", "Cancelled"), // 21: the bottom copy wins
	R("LD-TEST-0119", "Cancelled"), // 22
	R("LD-TEST-0120", "Cancelled"), // 23
	R("LD-TEST-0121", "Cancelled"), // 24
	R("LD-TEST-0122", "Cancelled"), // 25: an earlier copy
	R("LD-TEST-0122", "In Transit", "Made-up Driver G"), // 26: the bottom copy wins
	R("LD-TEST-0123", "Cancellation requested"), // 27: not a cancelled status
	R("LD-TEST-0124", "cancelled "), // 28
	R("LD-TEST-0125", "Cancelled"), // 29
];
const PARSED = server.parseSheet({ values: [HEADERS, ...ROWS] });
const DEDUP = server.deduplicateLoads(PARSED.data, PARSED.headers);
const COLS = server.jobTrackingMonthCols(HEADERS);
const LANE = (row) => ({ pickup: row["Pickup Address"], dropoff: row["Drop-off Address"] });

let hid = 0;
const H = (loadId, source, newStatus, actor, reason, at) => ({ id: ++hid, load_id: loadId, new_status: newStatus, source, actor, reason, at });
let aid = 1000;
const A = (entityId, action, username, role, details, timestamp) => ({ id: ++aid, timestamp, username, role, action, entity_id: entityId, details });

const HISTORY = [
	H("ld-test-0101", "cancel", "Cancelled", "made-up-admin", "Broker called it off (made-up)", "2026-10-20T14:00:00Z"),
	H("ld-test-0102", "cancel", "Cancelled", "super_admin", "", "2026-07-01T15:00:00Z"),
	H("ld-test-0103", "override", "Cancelled", "made-up-dispatcher", "", "2026-07-02T16:00:00Z"),
	H("ld-test-0104", "manual", "Cancelled", "Made-up Driver B", "", "2026-07-03T17:00:00Z"),
	H("ld-test-0105", "manual", "Cancelled", "Made-up Driver C", "", "2026-07-04T18:00:00Z"),
	H("ld-test-0107", "cancel", "Cancelled", "made-up-admin", "First cancel (made-up)", "2026-09-01T12:00:00Z"),
	H("ld-test-0107", "dispatch", "Dispatched", "made-up-dispatcher", "", "2026-09-02T12:00:00Z"),
	H("ld-test-0109", "cancel", "Cancelled", "made-up-admin", "History reason 0109 (made-up)", "2026-09-04T10:00:00Z"),
	H("ld-test-0110", "cancel", "Cancelled", "made-up-admin", "History reason 0110 (made-up)", "2026-09-05T10:00:00Z"),
	H("ld-test-0111", "cancel", "Cancelled", "made-up-admin", "Reason 0111 (made-up)", "2026-09-06T10:00:00Z"),
	H("ld-test-0112", "cancel", "Cancelled", "made-up-admin", "Reason 0112 (made-up)", "2026-09-07T10:00:00Z"),
	H("ld-test-0113", "cancel", "Cancelled", "made-up-admin", "Reason 0113 (made-up)", "2026-09-08T10:00:00Z"),
	H("ld-test-0114", "import", "Cancelled", "made-up-tool", "", "2026-09-09T10:00:00Z"),
	H("ld-test-0115", "cancel", "Cancelled", "made-up-admin", "Reason 0115 (made-up)", null),
	H("ld-test-0116", "cancel", "Cancelled", "made-up-admin", "Old cancel (made-up)", "2026-08-10T10:00:00Z"),
	H("ld-test-0117", "cancel", "Cancelled", "made-up-admin", "Reason 0117 (made-up)", "2026-08-11T10:00:00Z"),
	H("ld-test-0121", "cancel", "Cancelled", "made-up-admin", "First (made-up)", "2026-08-01T10:00:00Z"),
	H("ld-test-0121", "dispatch", "Dispatched", "made-up-dispatcher", "", "2026-08-02T10:00:00Z"),
	H("ld-test-0121", "cancel", "Cancelled", "made-up-admin-2", "Second (made-up)", "2026-08-03T10:00:00Z"),
	H("ld-test-0125", "cancel", "Cancelled", "made-up-admin", "History reason 0125 (made-up)", "2026-09-10T10:00:00Z"),
	H("ld-test-0199", "cancel", "Cancelled", "made-up-admin", "Not on this sheet (made-up)", "2026-09-11T10:00:00Z"),
];
const AUDITS = [
	A("LD-TEST-0101", "cancel_load", "made-up-admin", "Super Admin", render.cancel("LD-TEST-0101", "Made-up Driver A", "Broker called it off (made-up)"), "2026-10-20T14:00:00.400Z"),
	A("LD-TEST-0103", "status_override", "made-up-dispatcher", "Dispatcher", render.override("Dispatched", "Cancelled", "made-up-dispatcher", "Shipper closed for the week (made-up)"), "2026-07-02T15:59:59.800Z"),
	A("LD-TEST-0104", "update_status", "made-up-dispatcher", "Dispatcher", render.status("Cancelled", "LD-TEST-0104", "Made-up Driver B"), "2026-07-03T16:59:59.500Z"),
	A("LD-TEST-0107", "cancel_load", "made-up-admin", "Super Admin", render.cancel("LD-TEST-0107", "", "First cancel (made-up)"), "2026-09-01T12:00:00.300Z"),
	A("LD-TEST-0107", "dispatch_load", "made-up-dispatcher", "Dispatcher", "Assigned driver Made-up Driver D to load LD-TEST-0107", "2026-09-02T12:00:00.200Z"),
	A("#LD-TEST-0108", "cancel_load", "made-up-admin", "Super Admin", render.cancel("#LD-TEST-0108", "", "Duplicate of another load (made-up)"), "2026-09-03T13:14:15.678Z"),
	A("LD-TEST-0109", "cancel_load", "made-up-admin-2", "Super Admin", render.cancel("LD-TEST-0109", "", "Audit reason 0109 (made-up)"), "2026-09-04T10:00:59.000Z"),
	A("LD-TEST-0110", "cancel_load", "made-up-admin-2", "Super Admin", render.cancel("LD-TEST-0110", "", "Audit reason 0110 (made-up)"), "2026-09-05T10:01:01.000Z"),
	A("LD-TEST-0111", "cancel_load", "made-up-admin", "Super Admin", render.cancel("LD-TEST-0111", "", "Reason 0111 (made-up)"), "2026-09-06T10:00:00.250Z"),
	A("LD-TEST-0111", "status_override", "made-up-dispatcher", "Dispatcher", "Override of an unexpected shape (made-up)", "2026-09-06T12:00:00.000Z"),
	A("LD-TEST-0112", "update_status", "made-up-dispatcher", "Dispatcher", "Status changed to Cancelled for load LD-TEST-0112", "2026-09-07T11:00:00.000Z"),
	A("LD-TEST-0113", "update_status", "made-up-dispatcher", "Dispatcher", "garbled text (made-up)", "2026-09-08T09:00:00.000Z"),
	A("LD-TEST-0119", "status_override", "made-up-dispatcher", "Dispatcher", render.override("Assigned", "cancelled", "made-up-dispatcher", "Customer withdrew the load (made-up)"), "2026-05-20T14:00:00.000Z"),
	A("LD-TEST-0120", "update_status", "made-up-dispatcher", "Dispatcher", render.status("Cancelled", "LD-TEST-0120", "Made-up Driver E"), "2026-05-21T14:00:00.000Z"),
	A("LD-TEST-0125", "cancel_load", "made-up-admin-2", "Super Admin", render.cancel("LD-TEST-0125", "", "Audit reason 0125 (made-up)"), "2026-09-10T10:01:00.000Z"),
	A("LD-TEST-0101", "login", "made-up-admin", "Super Admin", "Not a status action (made-up)", "2026-10-21T10:00:00.000Z"),
];
const DELETED = [{ load_id: "#ld-test-0117" }, { load_id: "ld-test-0199" }];
const FIELDS = ["alsoDeleted", "cancelledAt", "cancelledBy", "cancelledByRole", "cancelledBySharedLogin", "cancelledDay", "driver", "dropoff",
	"hasLoadId", "loadId", "pickup", "pickupAt", "reason", "recordedBy", "rowIndex"];

const pageRows = (over = {}) => view.cancelledLoadRows({
	rows: DEDUP, headers: HEADERS, cancelledStatusRe: RE, normalizeLoadId,
	history: HISTORY, audits: AUDITS, deleted: DELETED, cols: COLS, laneOf: LANE,
	shownLoadId: (raw) => raw, timeZone: ZONE, ...over,
});
const byId = (rows) => new Map(rows.map((r) => [r.hasLoadId ? r.loadId : `(row ${r.rowIndex})`, r]));
const pick = (row, keys) => (row ? Object.fromEntries(keys.map((k) => [k, row[k]])) : null);
const WHO = ["recordedBy", "cancelledAt", "cancelledBy", "cancelledByRole", "reason"];
const BLANK = (recordedBy) => ({ recordedBy, cancelledAt: "", cancelledBy: "", cancelledByRole: "", reason: "" });
const LISTED_KEYS = ["ld-test-0101", "ld-test-0102", "ld-test-0103", "ld-test-0104", "ld-test-0105", "ld-test-0106", "ld-test-0107",
	"ld-test-0108", "ld-test-0109", "ld-test-0110", "ld-test-0111", "ld-test-0112", "ld-test-0113", "ld-test-0114", "ld-test-0115",
	"ld-test-0117", "ld-test-0118", "ld-test-0119", "ld-test-0120", "ld-test-0121", "ld-test-0124", "ld-test-0125"];

// ── §1 ────────────────────────────────────────────────────────────────────────
section("§1  which loads", () => {
	const rows = pageRows();
	const live = server.excludeDroppedLoads(DEDUP, HEADERS, new Set());
	const dropped = DEDUP.filter((r) => !live.includes(r)).map((r) => r._rowIndex);
	eq(rows.map((r) => r.rowIndex).sort((a, b) => a - b), dropped.sort((a, b) => a - b),
		"§1 the page's rows are exactly the rows excludeDroppedLoads() drops for status (empty deleted set)");
	eq(rows.length, 23, "§1 23 cancelled loads in the deduplicated view");
	const ids = byId(rows);
	ok(["LD-TEST-0102", "LD-TEST-0103", "LD-TEST-0124"].every((id) => ids.has(id)), "§1 canceled, \" CANCEL \" and \"cancelled \" count");
	ok(!ids.has("LD-TEST-0116"), "§1 a live load with an old cancel record is not listed");
	ok(!ids.has("LD-TEST-0123"), "§1 \"Cancellation requested\" is not a cancelled status");
	eq(pick(ids.get("#LD-TEST-0118"), ["rowIndex", "recordedBy"]), { rowIndex: 21, recordedBy: "none" }, "§1 a load whose bottom copy is cancelled is listed (the copy every figure reads)");
	ok(!ids.has("LD-TEST-0122"), "§1 a load whose bottom copy is live is not listed, though an earlier copy is cancelled");
	eq(pick(ids.get("(row 18)"), ["loadId", "hasLoadId", ...WHO]), { loadId: "", hasLoadId: false, ...BLANK("none") }, "§1 a row with no Load ID is listed, with no records");
	eq(rows.filter((r) => r.alsoDeleted).map((r) => r.loadId), ["LD-TEST-0117"], "§1 \"also deleted\" comes from deleted_loads, either spelling");
	eq(Object.keys(rows[0]).sort(), FIELDS, "§1 each row carries exactly the listed fields");
	eq(pick(ids.get("LD-TEST-0106"), ["pickup", "dropoff", "pickupAt", "driver"]), { pickup: "Made-up Pickup, IL", dropoff: "Made-up Drop, IN", pickupAt: "10/18/2026 08:00", driver: "" },
		"§1 route from laneOf(), pickup as stored, the sheet's Driver cell");
	const keys = view.cancelledKeys({ rows: DEDUP, headers: HEADERS, cancelledStatusRe: RE, normalizeLoadId });
	eq([...keys].sort(), LISTED_KEYS, "§1 cancelledKeys(): each listed load's normalizeLoadId() key, no blank");
	eq(view.cancelledKeys({ rows: PARSED.data, headers: HEADERS, cancelledStatusRe: RE, normalizeLoadId }).filter((k) => k === "ld-test-0122").length, 1,
		"§1 cancelledKeys() lists a key once, however many rows carry it");
	const sheetRows = view.cancelledSheetRows({ rows: DEDUP, headers: HEADERS, cancelledStatusRe: RE, normalizeLoadId });
	eq(sheetRows.find((c) => c.row._rowIndex === 21).key, "ld-test-0118", "§1 cancelledSheetRows(): the row with its key");
	throws(() => view.cancelledKeys({ rows: DEDUP, headers: HEADERS, normalizeLoadId }), /CANCELED_STATUS_RE/, "§1 the money filter's test is required, never a copy");
	const g = new RegExp(RE.source, `${RE.flags}g`);
	eq(view.cancelledKeys({ rows: DEDUP, headers: HEADERS, cancelledStatusRe: g, normalizeLoadId }).length, 22, "§1 a /g copy of the test is not stateful");

	// The column rules, on every order of three headers from a pool.
	const POOL = ["Load ID", "Job ID", "Job Status", "Status", "Load Status", "Status Update Date", "job_status", "Job.Status", "JobStatus", "Driver", "Notes"];
	let lists = 0;
	const rowMismatch = [];
	const keyMismatch = [];
	for (const a of POOL) for (const b of POOL) for (const c of POOL) {
		if (a === b || b === c || a === c) continue;
		const hs = [a, b, c];
		lists++;
		const rs = hs.map((_, i) => {
			const r = { _rowIndex: i + 2 };
			hs.forEach((h, j) => { r[h] = j === i ? "Cancelled" : `V-${i}-${j}`; });
			return r;
		});
		const kept = server.excludeDroppedLoads(rs, hs, new Set());
		const drop = rs.filter((r) => !kept.includes(r)).map((r) => r._rowIndex);
		const mine = view.cancelledSheetRows({ rows: rs, headers: hs, cancelledStatusRe: RE, normalizeLoadId });
		if (JSON.stringify(mine.map((x) => x.row._rowIndex)) !== JSON.stringify(drop)) rowMismatch.push(hs.join(" | "));
		const idCol = server.jobTrackingMonthCols(hs).loadIdCol;
		if (!mine.every((x) => x.key === (idCol ? normalizeLoadId(x.row[idCol]) : ""))) keyMismatch.push(hs.join(" | "));
	}
	eq(rowMismatch.slice(0, 3), [], `§1 on ${lists} header orders, the status column is excludeDroppedLoads()'s`);
	eq(keyMismatch.slice(0, 3), [], `§1 on ${lists} header orders, the Load ID column is the server's`);
	const exSrc = closure(SRC, { roots: ["excludeDroppedLoads"], provided: ["require", "getDeletedLoadIds", "normalizeLoadId", "loadKeySet", "findCol", "CANCELED_STATUS_RE"] }).text;
	const libSrc = fs.readFileSync(LIB_FILE, "utf8");
	for (const lit of ["/load.?id|job.?id/i", "/^(job[\\s._-]?)?status$/i", "/status/i"]) {
		ok(exSrc.includes(lit) && libSrc.includes(lit), `§1 excludeDroppedLoads() and the module both resolve a column with ${lit}`);
	}
});

// ── §2 ────────────────────────────────────────────────────────────────────────
section("§2  the audit-text parsers", () => {
	eq(view.parseCancelLoadAudit(render.cancel("LD-TEST-0201", "Made-up Driver A", "Broker called it off (made-up)")),
		{ driver: "Made-up Driver A", reason: "Broker called it off (made-up)" }, "§2 cancel_load: driver and reason");
	eq(view.parseCancelLoadAudit(render.cancel("LD-TEST-0201", "", "Made-up reason")), { driver: "", reason: "Made-up reason" }, "§2 cancel_load with no driver");
	eq(view.parseCancelLoadAudit(render.cancel("", "", "Made-up reason")), { driver: "", reason: "Made-up reason" }, "§2 cancel_load for a load the client named N/A");
	eq(view.parseCancelLoadAudit(render.cancel("LD-TEST-0201", "Made-up (Jr) Driver", "Line one\nLine two — reason: still the reason (made-up)")),
		{ driver: "Made-up (Jr) Driver", reason: "Line one\nLine two — reason: still the reason (made-up)" }, "§2 cancel_load: a driver with brackets; a reason with lines and the separator in it");
	eq(view.parseStatusOverrideAudit(render.override("Dispatched", "Cancelled", "made-up-dispatcher", "  Shipper closed (made-up)  ")),
		{ from: "Dispatched", to: "Cancelled", reason: "Shipper closed (made-up)" }, "§2 status_override: from, to and reason");
	eq(view.parseStatusOverrideAudit(render.override("", "cancelled", "made-up-dispatcher", "Made-up reason")),
		{ from: "", to: "cancelled", reason: "Made-up reason" }, "§2 status_override from a blank status");
	eq(view.parseStatusOverrideAudit(render.override("In \"transit\"", "Cancelled", "made-up-dispatcher", "Made-up reason")), null,
		"§2 status_override with a quote mark in a status: null (never a guessed target)");
	eq(view.parseUpdateStatusAudit(render.status("Cancelled", "LD-TEST-0201", "Made-up Driver B")), { to: "Cancelled" }, "§2 update_status: the target");
	eq(view.parseUpdateStatusAudit(render.status("At Shipper", "LD-TEST-0201", "")), { to: "At Shipper" }, "§2 update_status with no driver");
	for (const [name, parse] of [["cancel_load", view.parseCancelLoadAudit], ["status_override", view.parseStatusOverrideAudit], ["update_status", view.parseUpdateStatusAudit]]) {
		eq([null, undefined, "", "Assigned driver Made-up Driver D to load LD-TEST-0201", "Override Dispatched → Cancelled", "Status changed to \"Cancelled\""].map((t) => parse(t)),
			[null, null, null, null, null, null], `§2 ${name}: anything else is null`);
	}
	eq(view.parseCancelLoadAudit(`Cancelled load ${"y".repeat(5000)} — reason: made-up`), null, "§2 the text is cut before matching: a separator past the cut is not read");
	const t0 = Date.now();
	const hostile = [
		`Cancelled load ${" (driver: ".repeat(500)}`,
		`Cancelled load ${"x".repeat(1000000)}`,
		`Override "${" ".repeat(1000000)}`,
		`Status changed to "Cancelled" for load ${" (driver: ".repeat(500)}`,
		`Override "a" → "b" by ${": ".repeat(2000)}`,
	];
	for (const h of hostile) {
		view.parseCancelLoadAudit(h);
		view.parseStatusOverrideAudit(h);
		view.parseUpdateStatusAudit(h);
	}
	ok(Date.now() - t0 < 1000, `§2 hostile texts parse in bounded time (${Date.now() - t0} ms)`);
});

// ── §3 ────────────────────────────────────────────────────────────────────────
section("§3  which record", () => {
	const ids = byId(pageRows());
	const got = (id) => pick(ids.get(id), WHO);
	eq(got("LD-TEST-0101"), { recordedBy: "cancel-button", cancelledAt: "2026-10-20T14:00:00Z", cancelledBy: "made-up-admin", cancelledByRole: "Super Admin", reason: "Broker called it off (made-up)" },
		"§3 a Cancel button cancel: time from history, account and role from the audit row, the reason");
	eq(ids.get("LD-TEST-0101").driver, "Made-up Driver A", "§3 the driver recorded with the cancel, though the sheet's Driver cell is blank");
	eq(got("LD-TEST-0102"), { recordedBy: "cancel-button", cancelledAt: "2026-07-01T15:00:00Z", cancelledBy: "super_admin", cancelledByRole: "", reason: "" },
		"§3 a Cancel button cancel before reasons were kept: time and account, reason blank");
	eq(got("LD-TEST-0103"), { recordedBy: "status-override", cancelledAt: "2026-07-02T16:00:00Z", cancelledBy: "made-up-dispatcher", cancelledByRole: "Dispatcher", reason: "Shipper closed for the week (made-up)" },
		"§3 a status override: its history row and audit row are one event; the reason from the audit text");
	eq(got("LD-TEST-0104"), { recordedBy: "driver-status", cancelledAt: "2026-07-03T17:00:00Z", cancelledBy: "made-up-dispatcher", cancelledByRole: "Dispatcher", reason: "" },
		"§3 a driver status screen cancel with its update_status row: the session's account, no reason");
	eq(ids.get("LD-TEST-0104").driver, "Made-up Driver B", "§3 ...and the driver from the sheet");
	eq(got("LD-TEST-0105"), { recordedBy: "driver-status", cancelledAt: "2026-07-04T18:00:00Z", cancelledBy: "", cancelledByRole: "", reason: "" },
		"§3 a manual history row without its audit row: the account is blank (the stored actor is the driver asked about)");
	eq(got("LD-TEST-0106"), BLANK("none"), "§3 no events: \"none\", all blank");
	eq(got("LD-TEST-0107"), BLANK("changed-after"), "§3 re-dispatched after the cancel, then cancelled on the sheet: \"changed-after\", not the older cancel");
	eq(got("LD-TEST-0108"), { recordedBy: "cancel-button", cancelledAt: "2026-09-03T13:14:15Z", cancelledBy: "made-up-admin", cancelledByRole: "Super Admin", reason: "Duplicate of another load (made-up)" },
		"§3 an audit-only cancel_load (its history insert failed), keyed by \"#\" + ID, is still shown");
	eq(got("LD-TEST-0109"), { recordedBy: "cancel-button", cancelledAt: "2026-09-04T10:00:00Z", cancelledBy: "made-up-admin-2", cancelledByRole: "Super Admin", reason: "History reason 0109 (made-up)" },
		"§3 twins 59 s apart merge: history's time and reason, the audit row's account");
	eq(got("LD-TEST-0125"), { recordedBy: "cancel-button", cancelledAt: "2026-09-10T10:00:00Z", cancelledBy: "made-up-admin-2", cancelledByRole: "Super Admin", reason: "History reason 0125 (made-up)" },
		"§3 twins exactly 60 s apart merge");
	eq(got("LD-TEST-0110"), { recordedBy: "cancel-button", cancelledAt: "2026-09-05T10:01:01Z", cancelledBy: "made-up-admin-2", cancelledByRole: "Super Admin", reason: "Audit reason 0110 (made-up)" },
		"§3 61 s apart they don't: the later audit row is its own, latest event");
	eq(got("LD-TEST-0111"), BLANK("changed-after"), "§3 a later status_override whose text doesn't parse: not recorded (no guess past it)");
	eq(got("LD-TEST-0112"), BLANK("changed-after"), "§3 a later update_status whose text doesn't parse: not recorded");
	eq(got("LD-TEST-0113"), { recordedBy: "cancel-button", cancelledAt: "2026-09-08T10:00:00Z", cancelledBy: "made-up-admin", cancelledByRole: "", reason: "Reason 0113 (made-up)" },
		"§3 an unparseable row before the cancel changes nothing; a history-only cancel names its actor");
	eq(got("LD-TEST-0114"), BLANK("changed-after"), "§3 a history source the page doesn't know is never shown as a cancel");
	eq(got("LD-TEST-0115"), BLANK("changed-after"), "§3 an event with no readable time can't be placed: not recorded");
	eq(got("LD-TEST-0117"), { recordedBy: "cancel-button", cancelledAt: "2026-08-11T10:00:00Z", cancelledBy: "made-up-admin", cancelledByRole: "", reason: "Reason 0117 (made-up)" },
		"§3 a soft-deleted load's cancel is shown too");
	eq(got("LD-TEST-0119"), { recordedBy: "status-override", cancelledAt: "2026-05-20T14:00:00Z", cancelledBy: "made-up-dispatcher", cancelledByRole: "Dispatcher", reason: "Customer withdrew the load (made-up)" },
		"§3 a status override from before the history table: the audit row alone, any case of \"cancelled\"");
	eq(got("LD-TEST-0120"), { recordedBy: "driver-status", cancelledAt: "2026-05-21T14:00:00Z", cancelledBy: "made-up-dispatcher", cancelledByRole: "Dispatcher", reason: "" },
		"§3 a driver status screen cancel from before the history table: the audit row's account");
	eq(got("LD-TEST-0121"), { recordedBy: "cancel-button", cancelledAt: "2026-08-03T10:00:00Z", cancelledBy: "made-up-admin-2", cancelledByRole: "", reason: "Second (made-up)" },
		"§3 cancelled, re-dispatched, cancelled again: the latest cancel");
	eq(got("LD-TEST-0124"), BLANK("none"), "§3 a cancel with no record at all (a sheet edit): \"none\"");
	eq(view.TWIN_WINDOW_MS, 60000, "§3 TWIN_WINDOW_MS is 60 s");
	eq([...view.RECORDED_BY_VALUES], ["cancel-button", "status-override", "driver-status", "changed-after", "none"], "§3 the recordedBy values");
	const noAudit = byId(pageRows({ audits: [] }));
	eq(pick(noAudit.get("LD-TEST-0103"), ["recordedBy", "cancelledBy", "reason"]), { recordedBy: "status-override", cancelledBy: "made-up-dispatcher", reason: "" },
		"§3 an override's history row alone: its actor (the session's account), no reason");
	eq(pick(noAudit.get("LD-TEST-0104"), ["recordedBy", "cancelledBy"]), { recordedBy: "driver-status", cancelledBy: "" }, "§3 a manual history row alone: the account blank");
});

// ── §4 ────────────────────────────────────────────────────────────────────────
section("§4  times", () => {
	const hs = ["Load ID", "Job Status"];
	const ids = ["LD-TEST-0401", "LD-TEST-0402", "LD-TEST-0403", "LD-TEST-0404", "LD-TEST-0405", "LD-TEST-0406"];
	const parsed = server.parseSheet({ values: [hs, ...ids.map((id) => [id, "Cancelled"])] });
	const rows = view.cancelledLoadRows({
		rows: parsed.data, headers: hs, cancelledStatusRe: RE, normalizeLoadId, shownLoadId: (raw) => raw, timeZone: ZONE,
		history: [
			H("ld-test-0401", "cancel", "Cancelled", "made-up-admin", "", "2026-10-31T03:30:00Z"),
			H("ld-test-0402", "cancel", "Cancelled", "made-up-admin", "", "2026-11-01T05:30:00Z"),
			H("ld-test-0403", "cancel", "Cancelled", "made-up-admin", "", "2026-11-01T06:30:00Z"),
			H("ld-test-0405", "cancel", "Cancelled", "made-up-admin", "", "2026-02-30T10:00:00Z"),
			H("ld-test-0406", "cancel", "Cancelled", "made-up-admin", "", "2026-10-29 18:05:00"),
		],
		audits: [A("LD-TEST-0404", "cancel_load", "made-up-admin", "Super Admin", render.cancel("LD-TEST-0404", "", "Made-up reason"), "2026-10-29T18:05:00.999Z")],
	});
	const m = byId(rows);
	eq(pick(m.get("LD-TEST-0401"), ["cancelledAt", "cancelledDay"]), { cancelledAt: "2026-10-31T03:30:00Z", cancelledDay: "2026-10-30" }, "§4 11:30 PM EDT Oct 30 is Oct 30 (not the UTC date)");
	eq(pick(m.get("LD-TEST-0402"), ["cancelledAt", "cancelledDay"]), { cancelledAt: "2026-11-01T05:30:00Z", cancelledDay: "2026-11-01" }, "§4 1:30 AM EDT Nov 1, before the clocks go back");
	eq(pick(m.get("LD-TEST-0403"), ["cancelledAt", "cancelledDay"]), { cancelledAt: "2026-11-01T06:30:00Z", cancelledDay: "2026-11-01" }, "§4 1:30 AM EST Nov 1, after");
	eq(m.get("LD-TEST-0404").cancelledAt, "2026-10-29T18:05:00Z", "§4 an audit time is given to the second, cut (not rounded)");
	eq(m.get("LD-TEST-0405").recordedBy, "changed-after", "§4 an impossible date is no time");
	eq(m.get("LD-TEST-0406").recordedBy, "changed-after", "§4 a time with no zone is never read as local time");
});

// ── §5 ────────────────────────────────────────────────────────────────────────
section("§5  the shared login", () => {
	const hs = ["Load ID", "Job Status"];
	const parsed = server.parseSheet({ values: [hs, ["LD-TEST-0501", "Cancelled"], ["LD-TEST-0502", "Cancelled"], ["LD-TEST-0503", "Cancelled"], ["LD-TEST-0504", "Cancelled"]] });
	const m = byId(view.cancelledLoadRows({
		rows: parsed.data, headers: hs, cancelledStatusRe: RE, normalizeLoadId, shownLoadId: (raw) => raw, timeZone: ZONE,
		history: [
			H("ld-test-0501", "cancel", "Cancelled", " Super_Admin ", "", "2026-10-01T12:00:00Z"),
			H("ld-test-0502", "cancel", "Cancelled", "super_admin", "", "2026-10-02T12:00:00Z"),
			H("ld-test-0503", "cancel", "Cancelled", "made-up-admin", "", "2026-10-03T12:00:00Z"),
		],
	}));
	eq(pick(m.get("LD-TEST-0501"), ["cancelledBy", "cancelledBySharedLogin"]), { cancelledBy: "Super_Admin", cancelledBySharedLogin: true }, "§5 \" Super_Admin \" is the shared login");
	eq(m.get("LD-TEST-0502").cancelledBySharedLogin, true, "§5 super_admin is the shared login");
	eq(m.get("LD-TEST-0503").cancelledBySharedLogin, false, "§5 a named account is not");
	eq(m.get("LD-TEST-0504").cancelledBySharedLogin, false, "§5 no account recorded: not the shared login");
});

// ── §6 ────────────────────────────────────────────────────────────────────────
section("§6  Load IDs leave only through shownLoadId()", () => {
	const calls = [];
	const rows = pageRows({ shownLoadId: (raw, row) => { calls.push([raw, row && row._rowIndex]); return "Load (contact withheld)"; } });
	ok(rows.filter((r) => r.hasLoadId).every((r) => r.loadId === "Load (contact withheld)"), "§6 every Load ID is the shower's text");
	ok(!/ld-test/i.test(JSON.stringify(rows)), "§6 no raw ID or key appears anywhere in the rows");
	eq(calls.length, 22, "§6 the shower is asked once per listed load with an ID");
	ok(calls.some(([raw, at]) => raw === "#LD-TEST-0118" && at === 21), "§6 it is given the ID as stored and its row");
	throws(() => pageRows({ shownLoadId: undefined }), /shownLoadId/, "§6 without a shower the module refuses");
	// "driver" is the Driver column, not a Drive reference.
	ok(rows.every((r) => Object.keys(r).every((k) => !/url|path|drive(?!r)|file/i.test(k))), "§6 no row names a file, path or Drive id");
});

// ── §7 ────────────────────────────────────────────────────────────────────────
section("§7  order", () => {
	eq(pageRows().map((r) => (r.hasLoadId ? r.loadId : `(row ${r.rowIndex})`)), [
		"LD-TEST-0101", "LD-TEST-0125", "LD-TEST-0113", "LD-TEST-0110", "LD-TEST-0109", "LD-TEST-0108", "LD-TEST-0117",
		"LD-TEST-0121", "LD-TEST-0105", "LD-TEST-0104", "LD-TEST-0103", "LD-TEST-0102", "LD-TEST-0120", "LD-TEST-0119",
		"LD-TEST-0124", "#LD-TEST-0118", "(row 18)", "LD-TEST-0115", "LD-TEST-0114", "LD-TEST-0112", "LD-TEST-0111", "LD-TEST-0107", "LD-TEST-0106",
	], "§7 recorded cancels newest first, then the rest by sheet row, newest first");
});

// ── §8 ────────────────────────────────────────────────────────────────────────
section("§8  the shared reads", () => {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP, reason TEXT DEFAULT '');
		CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL,
			role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_by TEXT DEFAULT '');
	`);
	const insH = db.prepare("INSERT INTO load_status_history (load_id, new_status, source, actor, changed_at, reason) VALUES (?, ?, ?, ?, ?, ?)");
	insH.run("ld-test-0801", "Cancelled", "cancel", "made-up-admin", "2026-10-29 18:05:00", "Made-up reason 0801");
	insH.run("ld-test-'0802", "Cancelled", "cancel", "made-up-admin", "2026-10-29 19:00:00", "Made-up reason 0802");
	insH.run("ld-test-0899", "Cancelled", "cancel", "made-up-admin", "2026-10-29 20:00:00", "Not asked for (made-up)");
	const insA = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 7, ?, ?, ?, ?, ?, ?)");
	insA.run("2026-10-29T18:05:00.300Z", "made-up-admin", "Super Admin", "cancel_load", "load", " #LD-TEST-0801 ", render.cancel("#LD-TEST-0801", "", "Made-up reason 0801"));
	insA.run("2026-10-29T18:06:00.000Z", "made-up-admin", "Super Admin", "cancel_load", "sheet_row", "LD-TEST-0801", "Another entity (made-up)");
	insA.run("2026-10-29T18:07:00.000Z", "made-up-admin", "Super Admin", "login", "load", "LD-TEST-0801", "Another action (made-up)");
	insA.run("2026-10-29T18:08:00.000Z", "made-up-dispatcher", "Dispatcher", "dispatch_load", "load", "LD-TEST-0899", "Assigned driver Made-up Driver D to load LD-TEST-0899");
	db.prepare("INSERT INTO deleted_loads (load_id) VALUES (?)").run("LD-TEST-'0802");
	db.pragma("query_only = ON");
	throws(() => db.prepare("DELETE FROM audit_trail").run(), /readonly|query_only|attempt to write/i, "§8 the test's handle refuses writes");

	const hs = ["Load ID", "Job Status"];
	const parsed = server.parseSheet({ values: [hs, ["LD-TEST-0801", "Cancelled"], ["LD-TEST-'0802", "Cancelled"], ["x' OR '1'='1", "Cancelled"]] });
	const keys = view.cancelledKeys({ rows: parsed.data, headers: hs, cancelledStatusRe: RE, normalizeLoadId });
	const q = view.recordQueries(keys);
	const all = [...q.history, ...q.audit, q.deleted];
	ok(all.every((s) => keys.every((k) => !s.sql.includes(k))), "§8 no key is written into the SQL");
	ok(all.every((s) => (s.sql.match(/\?/g) || []).length === s.params.length), "§8 one placeholder per parameter");
	const run = (stmts) => stmts.flatMap((s) => db.prepare(s.sql).all(...s.params));
	const history = run(q.history);
	const audits = run(q.audit);
	const deleted = db.prepare(q.deleted.sql).all(...q.deleted.params);
	eq(history.map((h) => [h.load_id, h.at]).sort(), [["ld-test-'0802", "2026-10-29T19:00:00Z"], ["ld-test-0801", "2026-10-29T18:05:00Z"]],
		"§8 history: the listed keys only, each time as ISO-8601 Z");
	eq(audits.map((a) => a.entity_id), [" #LD-TEST-0801 "], "§8 audit: entity load and the four actions only, the ID with its \"#\", any case, spaces trimmed");
	eq(Object.keys(audits[0]).sort(), ["action", "details", "entity_id", "id", "role", "timestamp", "username"], "§8 the audit columns read");
	const m = byId(view.cancelledLoadRows({ rows: parsed.data, headers: hs, cancelledStatusRe: RE, normalizeLoadId, shownLoadId: (raw) => raw, timeZone: ZONE, history, audits, deleted }));
	eq(pick(m.get("LD-TEST-0801"), WHO), { recordedBy: "cancel-button", cancelledAt: "2026-10-29T18:05:00Z", cancelledBy: "made-up-admin", cancelledByRole: "Super Admin", reason: "Made-up reason 0801" },
		"§8 changed_at 2026-10-29 18:05:00 is cancelledAt 2026-10-29T18:05:00Z, merged with its audit row");
	eq(pick(m.get("LD-TEST-'0802"), ["recordedBy", "alsoDeleted"]), { recordedBy: "cancel-button", alsoDeleted: true }, "§8 a key with a quote mark reads its own rows");
	eq(m.get("x' OR '1'='1").recordedBy, "none", "§8 an ID shaped like SQL reads nothing but its own (none)");

	const many = Array.from({ length: 600 }, (_, i) => `ld-test-${String(i).padStart(4, "0")}`);
	const q600 = view.recordQueries(many);
	eq([q600.history.map((s) => s.params.length), q600.audit.map((s) => s.params.length)], [[500, 100], [504, 504, 204]],
		"§8 600 keys: history in chunks of 500; audit in chunks of 250 keys, each with its \"#\" spelling");
	ok([...q600.history, ...q600.audit].every((s) => (s.sql.match(/\?/g) || []).length <= 999), "§8 no statement passes 999 placeholders");
	ok([...q600.history, ...q600.audit].every((s) => Array.isArray(db.prepare(s.sql).all(...s.params))), "§8 every chunk runs");
	const none = view.recordQueries([]);
	eq([none.history.length, none.audit.length], [0, 0], "§8 no keys: no statement (never an empty IN list)");
	eq(view.recordQueries(["ld-a", "ld-a", ""]).history[0].params, ["ld-a"], "§8 keys are de-duplicated, blanks dropped");
	eq([...view.AUDIT_ACTIONS], ["cancel_load", "status_override", "update_status", "dispatch_load"], "§8 the four audit actions read");
	db.close();
});

// ── §9 ────────────────────────────────────────────────────────────────────────
section("§9  pure, and the writers it reads", () => {
	const libSrc = fs.readFileSync(LIB_FILE, "utf8");
	const code = libSrc.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	eq([...code.matchAll(/require\(([^)]{1,80})\)/g)].map((x) => x[1]).sort(), ["\"./app-time\"", "\"./sign-in\""], "§9 the module requires only ./app-time and ./sign-in");
	for (const dep of ["app-time.js", "sign-in.js"]) {
		const depCode = fs.readFileSync(path.join(ROOT, "lib", dep), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
		eq((depCode.match(/\brequire\(/g) || []).length, 0, `§9 lib/${dep} requires nothing`);
	}
	ok(!/\bprocess\.|\bfs\.|better-sqlite3|\bfetch\(|child_process/.test(code), "§9 no environment, file, database or network");

	// Every recordStatusChange() call names its source as a literal; a new one
	// must be read by the page's rules before it is added here.
	const sources = [];
	for (let at = SRC.indexOf("recordStatusChange({"); at !== -1; at = SRC.indexOf("recordStatusChange({", at + 1)) {
		const lineStart = SRC.lastIndexOf("\n", at) + 1;
		if (/^\s*function\s/.test(SRC.slice(lineStart, at))) continue;
		const call = SRC.slice(at, SRC.indexOf("})", at));
		const m = /\bsource:\s*(['"])([a-z_-]{1,30})\1/.exec(call);
		sources.push(m ? m[2] : `(not a literal: ${call.slice(0, 60)})`);
	}
	eq([...new Set(sources)].sort(), ["accept", "cancel", "decline", "dispatch", "geofence", "manual", "override"],
		"§9 server.js writes status history under these sources only (a new one: decide how the page reads it first)");
	for (const action of ["cancel_load", "status_override", "update_status", "dispatch_load"]) {
		const writers = SRC.split("\n").filter((l) => new RegExp(`logAudit(?:Refusal)?\\([^,]{1,40}, ['"]${action}['"]`).test(l));
		eq(writers.length, 1, `§9 one writer of the ${action} audit row`);
		ok(writers.length === 1 && writers[0].includes(`'${action}', 'load', loadId,`), `§9 ${action} is written against the load's ID`);
	}
});

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
