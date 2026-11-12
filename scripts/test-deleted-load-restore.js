#!/usr/bin/env node
/**
 * scripts/test-deleted-load-restore.js — lib/deleted-load-restore.js beyond its
 * restore route (scripts/test-deleted-loads-route.js runs that): a new load
 * whose Load ID an old delete still names, and the Super Admins' banner and
 * notice for a row such a delete hides. DELETED_LOAD_RESTORE_ENABLED.
 *
 *   §1 the module: ids, the choice a re-send carries, row digests, its words
 *      (plain: no reopen, no API path, no internal code in a sentence).
 *   §2 POST /api/data (New Job, the Data Manager's Add Row), the route lifted
 *      as shipped (scripts/lib/availability-world.js): a Super Admin gets the
 *      choice and nothing is written; "Create it as new" is checked at the
 *      duplicate read and clears every old delete of the ID (one
 *      clear_load_delete row) just before the append, then the row is created
 *      and counts; a stale or foreign choice, a row that still holds the ID, a
 *      delete added while the create was on its way, an unreadable header row,
 *      sheet or delete table, the off-duty "Keep as is" and a closed month:
 *      refused, nothing written; no delete: as before; the flag off: as before.
 *   §3 POST /api/loads/from-ratecon, lifted whole: the same for a Super Admin;
 *      a Dispatcher is refused in plain words with no who or when, nothing is
 *      created, and Super Admins get one notice (one per delete, per person, per
 *      day); the clear happens just before the append.
 *   §4 hidden rows (add-on 3): a live row an old delete hides shows in a Super
 *      Admin's hiddenLoads for each way it can get there (deleted with no row;
 *      created after the delete by a rate con, New Job, the Data Manager or n8n;
 *      a row the delete didn't record, as a hand edit makes; a row in a month an
 *      older delete didn't name), with its rows and months; a deliberate delete
 *      whose row is unchanged, sorted or not, shows nothing; a read writes
 *      nothing.
 *   §5 resolving it (Restore, or Create it as new through the restore route)
 *      clears it on the next read; one in closed months only stays off the
 *      banner, told once as a payout question.
 *   §6 nothing of it reaches another role: no hiddenLoads for a Dispatcher and
 *      nothing worked out for one, the notice type left out of their
 *      notifications, the refused create's answer without who or when.
 *   §7 one notice per hidden delete while it lasts; the flag off: no field, no
 *      notice, no digest written.
 *   §8 the dashboard step: behind the dashboard route's own gate; hiddenLoads
 *      second in a Super Admin's answer, never in an error's, never for another
 *      role or a session the gate refuses; a failed check leaves the answer as
 *      it was.
 *   §9 DELETE /api/loads/:loadId, lifted whole: with the flag on it records the
 *      rows it hides; off, it writes what it always wrote.
 *  §10 the wiring: both create routes ask the module after their own duplicate
 *      read, and clear just before their append, after every refusal.
 *  §11 the review's Create it as new is refused while a row that may be the
 *      delete's own is live, naming it; Restore isn't.
 *  §12 the reason a restore or a "Create it as new" needs (the 10-22 Restore
 *      decision): missing, not text, under 3 characters once cleaned, over 500
 *      or holding an email or phone is refused 400, nothing written; a good one
 *      is cleaned, saved in the audit row and named in the Super Admins' one
 *      notice (§3 and §5 check the notice: theirs only, never a Dispatcher's).
 *
 * Made-up loads, people and places only. Real: the lifted routes and helpers
 * (scripts/lib/server-lift.js) and an in-memory SQLite built from every CREATE
 * TABLE in server.js. Stubbed: the Sheets client, Drive, geocoding and sockets.
 * No network; the availability world's HTTP server listens on 127.0.0.1 for the
 * run only. Run: node scripts/test-deleted-load-restore.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const W = require("./lib/availability-world");
const { closure, liftRoute } = require("./lib/server-lift");
const { schemaDb } = require("./lib/work-days-world");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();
const rootRequire = createRequire(path.join(ROOT, "server.js"));
const { normalizeLoadId } = require(path.join(ROOT, "lib", "ratecon-load.js"));
const R = W.createRunner("test-deleted-load-restore");
const { ok, eq, section } = R;

let lib = null;
let libError = "";
try { lib = require(path.join(ROOT, "lib", "deleted-load-restore.js")); } catch (e) { libError = e.message; }

const QUIET = { log() {}, info() {}, warn() {}, error() {} };
const SA = { id: 1, role: "Super Admin", username: "super_admin" };
const DISP = { id: 2, role: "Dispatcher", username: "dispatch_t" };
const DISP2 = { id: 3, role: "Dispatcher", username: "dispatch_two" };
const reqOf = (user, body = {}) => ({ session: user ? { user } : {}, body });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-deleted-load-restore-"));

// ------------------------------------------------------------------ helpers
// The server's own helpers over one database, lifted with every declaration they use.
const HELPER_ROOTS = ["requireRole", "periodLocksReadable", "jobTrackingMonthCols", "loadRowPeriods", "lockedAmong", "periodLabel",
	"pickAddressColumn", "excludeDroppedLoads", "liveJobTrackingView", "noticeTypeScope", "auditText"];
let HELPERS_TEXT = "";
try { HELPERS_TEXT = closure(SRC, { roots: HELPER_ROOTS, provided: ["db", "require", "console", "process"], denied: ["app", "io", "server"] }).text; }
catch (e) { ok("the server's helpers lift", false, e.message); }
function helpersFor(db) {
	return new Function("db", "require", "console", "process", `"use strict";\n${HELPERS_TEXT}\nreturn { ${HELPER_ROOTS.join(", ")} };`)(
		db, rootRequire, QUIET, { env: {} });
}

// A Job Tracking read as getJobTrackingCached() hands it out: header-keyed rows.
function jtOf(headers, rows) {
	return { headers: headers.slice(), data: rows.map((r, i) => ({ _rowIndex: i + 2, ...Object.fromEntries(headers.map((h, j) => [h, r[j] == null ? "" : String(r[j])])) })) };
}

// An instance with the flag on, mounted over `db` with the server's helpers.
// `sent` records each notice and the room it went to (the server's mount sends
// to the super-admin room only; scripts/test-deleted-loads-route.js pins that).
function mounted(db, { enabled = true, read = null, now = null } = {}) {
	lib.ensureSchema(db);
	const H = helpersFor(db);
	const sent = [];
	const routes = {};
	const app = { post: (p, ...chain) => { routes[`POST ${p}`] = chain; }, get: (p, ...chain) => { routes[`GET ${p}`] = chain; } };
	const inst = lib.create({ db, enabled, log: QUIET, auditText: H.auditText, ...(now ? { now } : {}) });
	inst.mount(app, {
		requireRole: H.requireRole,
		refuseCrossSite: (req, res, next) => next(),
		periodLocksReadable: H.periodLocksReadable,
		getJobTrackingCached: async () => { const v = typeof read === "function" ? read() : read; if (v instanceof Error) throw v; return v; },
		jobTrackingMonthCols: H.jobTrackingMonthCols,
		tripDayLockCover: () => null,
		loadRowPeriods: H.loadRowPeriods,
		lockedAmong: H.lockedAmong,
		periodLabel: H.periodLabel,
		notifyChange() {},
		jtCacheInvalidate() {},
		pickAddressColumn: H.pickAddressColumn,
		excludeDroppedLoads: H.excludeDroppedLoads,
		notifySuperAdmins: (notice) => {
			db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata) VALUES (?, ?, ?, ?)")
				.run(notice.type, notice.title, notice.body, JSON.stringify(notice.metadata || {}));
			sent.push({ room: "super-admin", notice });
		},
	});
	return { inst, H, sent, routes };
}

// A made-up reason, sent with every restore and "Create it as new" that isn't about the reason itself.
const REASON = "Deleted by mistake; the broker confirmed the load (made-up)";
// One request through a mounted chain, as Express runs it. The body carries REASON unless it names its own `reason`.
async function run(chain, user, { params = {}, body = {} } = {}) {
	const sent = Object.prototype.hasOwnProperty.call(body, "reason") ? body : { ...body, reason: REASON };
	const req = { method: "POST", params, query: {}, body: sent, route: { path: "" }, headers: { "x-requested-with": "XMLHttpRequest" }, session: user ? { user: { ...user } } : {} };
	const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
	for (const mw of chain.slice(0, -1)) {
		let nexted = false;
		await mw(req, res, () => { nexted = true; });
		if (!nexted) return { status: res.statusCode, body: res.body };
	}
	await chain[chain.length - 1](req, res, () => {});
	return { status: res.statusCode, body: res.body };
}

const FP_SQL = ["SELECT * FROM deleted_loads ORDER BY id", "SELECT * FROM audit_trail ORDER BY id", "SELECT * FROM dispatch_notifications ORDER BY id"];
const fingerprint = (db) => JSON.stringify(FP_SQL.map((sql) => db.prepare(sql).all()));
const tomb = (db, loadId, rowIndex, deletedAt, by = "super_admin") =>
	db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_at, deleted_by) VALUES (?, ?, ?, ?)").run(loadId, rowIndex, deletedAt, by).lastInsertRowid;
// The delete_load audit row DELETE /api/loads/:loadId writes, naming the month the delete was made in.
const auditDelete = (db, loadId, at, month) => db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 1, 'super_admin', 'Super Admin', 'delete_load', 'load', ?, ?)")
	.run(at, loadId, `Soft-deleted load ${loadId.toUpperCase()} — settlement month ${month}. Reversible: DELETE FROM deleted_loads WHERE load_id = '${loadId}'`);
const actions = (db, entityId) => db.prepare("SELECT action FROM audit_trail WHERE entity_id = ? ORDER BY id").all(entityId).map((r) => r.action);
const clears = (db, entityId) => db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'clear_load_delete' AND entity_id = ?").get(entityId).n;
const tombsFor = (db, key) => db.prepare("SELECT id, load_id FROM deleted_loads ORDER BY id").all().filter((r) => normalizeLoadId(r.load_id) === key);
const notices = (db, type = "load-hidden-by-delete") => db.prepare("SELECT * FROM dispatch_notifications WHERE type = ? ORDER BY id").all(type)
	.map((n) => ({ ...n, metadata: JSON.parse(n.metadata || "{}") }));
// The Super Admins' notice of a restore or a cleared delete (the 10-22 Restore decision).
const DONE_TYPE = "deleted-load-restored";
const doneNotices = (db) => notices(db, DONE_TYPE);
// "Create it as new" as a create form re-sends it.
const asNewChoice = (id, count, reason = REASON) => ({ action: "create_new", id, count, reason });

// ----------------------------------------------------- the from-ratecon route
const RC_HEAD = 'app.post("/api/loads/from-ratecon", requireRole("Super Admin", "Dispatcher"), rateConLimiter, async (req, res) => {';
const RC_PROVIDED = ["app", "db", "fs", "path", "require", "console", "process", "requireRole", "rateConLimiter", "io", "notifyChange",
	"upsertLoadCoordsStmt", "getSheets", "getDrive", "geocodeAddress", "jtCacheInvalidate", "SPREADSHEET_ID", "GOOGLE_MAPS_API_KEY",
	"RATECON_DRIVE_FOLDER_ID", "DATA_DIR", "fetch", "driverInstructions", "deletedLoadRestore"];
let RC_TEXT = "";
try { RC_TEXT = closure(SRC, { routes: [RC_HEAD], provided: RC_PROVIDED, denied: ["server", "auth", "google", "sheetsClient", "sendEmail", "transporter"] }).text; }
catch (e) { ok("from-ratecon lifts", false, e.message); }
const JT_HEADERS = ["Load ID", "Details", "Driver", "Pickup Address", "Pickup Appointment", "Drop-off Address", "Drop-off Appointment", "Job Status", "  Payment  ", "Assigned Date"];
// The route over `db`, with tabs the test can read and an append that can fail. `geocode` stands in for the
// geocoder, which the route awaits between its duplicate read and its append.
function rateCon(db, instance, { rows = [], geocode = async () => null } = {}) {
	const tabs = { "Job Tracking": [JT_HEADERS, ...rows], "Payments Table": [[" Job ID", "Contract ID", "Payment Amount"]], "Job Details": [["Load ID", "Rate Per Mile", "Distance", "Details", "Payment"]] };
	const control = { failAppend: false };
	const sheets = { spreadsheets: { values: {
		get: async ({ range }) => ({ data: { values: (tabs[range] || []).map((r) => r.slice()) } }),
		append: async ({ range, requestBody }) => {
			if (control.failAppend && range === "Job Tracking") throw new Error("made-up Sheets write failure");
			tabs[range].push(requestBody.values[0]);
			return { data: { updates: { updatedRange: `'${range}'!A${tabs[range].length}:J${tabs[range].length}` } } };
		},
		update: async () => ({ data: {} }),
		batchUpdate: async () => ({ data: {} }),
	} } };
	const routes = {};
	const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
	const dataDir = fs.mkdtempSync(path.join(tmp, "data-"));
	const deps = {
		app, db, fs, path, require: rootRequire, console: QUIET, process: { env: {} },
		requireRole: () => (req, res, next) => next(), rateConLimiter: (req, res, next) => next(),
		io: { to: () => ({ emit() {}, except: () => ({ emit() {} }) }), emit() {} }, notifyChange() {},
		upsertLoadCoordsStmt: { run() {} }, getSheets: async () => sheets, getDrive: async () => { throw new Error("no Drive in a test"); },
		geocodeAddress: geocode, jtCacheInvalidate() {}, SPREADSHEET_ID: "sheet-under-test", GOOGLE_MAPS_API_KEY: "",
		RATECON_DRIVE_FOLDER_ID: "", DATA_DIR: dataDir, fetch: async () => { throw new Error("no network in a test"); },
		driverInstructions: { annotateDashboardRows() {}, afterDropzone() { return null; } },
		deletedLoadRestore: instance,
	};
	new Function(...RC_PROVIDED, `"use strict";\n${RC_TEXT}`)(...RC_PROVIDED.map((n) => deps[n]));
	const post = async (user, loadNumber, extra = {}) => {
		const out = { status: 200, body: null };
		// The route holds the Load ID until the response closes, as Express closes it.
		const closers = [];
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, on(ev, fn) { if (ev === "close") closers.push(fn); } };
		const fields = { "Load Number": loadNumber, Rate: "$1,250.00", "Broker Name": "Example Brokerage Test",
			"Pickup Address": "100 Test Way, Dallas, TX 75201", "Drop-off Address": "200 Sample Rd, Austin, TX 78701" };
		await routes["/api/loads/from-ratecon"]({ body: { fields, pdfBase64: "", fileName: "", ...extra }, session: { user: { ...user } } }, res);
		for (const fn of closers) fn();
		return out;
	};
	return { post, tabs, control, appended: () => tabs["Job Tracking"].length - 1 - rows.length };
}

// ------------------------------------------------- GET /api/dispatch-notifications
function noticeRoutes(db) {
	const handlers = {};
	const app = { get: (p, ...h) => { handlers[`GET ${p}`] = h[h.length - 1]; }, put: (p, ...h) => { handlers[`PUT ${p}`] = h[h.length - 1]; } };
	const deps = closure(SRC, { roots: ["noticeTypeScope"], provided: [], denied: ["app", "io", "server", "db"] }).text;
	const routes = liftRoute(SRC, 'app.get("/api/dispatch-notifications", requireRole("Super Admin", "Dispatcher"), (req, res) => {');
	const { withNoticeLoadKey } = require("./lib/withheld-load-key-lift").withheldLoadKeyHelpers(SRC);
	new Function("app", "db", "requireRole", "BROKER_CONTACT_VALUE_REDACTION_ENABLED", "staffDispatchNotice", "brokerContact", "currentShownLoadIdIndex", "withNoticeLoadKey", `${deps}\n${routes}`)(
		app, db, () => null, true, (n) => n, { fullDispatchNotice: (n) => n }, () => null, withNoticeLoadKey);
	return async (user) => {
		const out = { code: 200, body: null };
		const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
		await handlers["GET /api/dispatch-notifications"]({ session: { user }, body: {}, query: {}, params: {} }, res);
		return out;
	};
}

// ---------------------------------------------------------- the delete route
const DEL_HEAD = 'app.delete("/api/loads/:loadId", requireRole("Super Admin"), async (req, res) => {';
const DEL_PROVIDED = ["app", "db", "require", "console", "process", "requireRole", "io", "notifyChange", "jtCacheInvalidate", "getJobTrackingCached", "tripDayLockCover", "deletedLoadRestore"];
let DEL_TEXT = "";
try { DEL_TEXT = closure(SRC, { routes: [DEL_HEAD], provided: DEL_PROVIDED, denied: ["server", "auth", "sheetsClient", "transporter"] }).text; }
catch (e) { ok("the delete route lifts", false, e.message); }
function deleteRoute(db, instance, jt) {
	const routes = {};
	const app = { delete: (p, ...h) => { routes[p] = h[h.length - 1]; } };
	const deps = { app, db, require: rootRequire, console: QUIET, process: { env: {} }, requireRole: () => (req, res, next) => next(),
		io: { to: () => ({ emit() {}, except: () => ({ emit() {} }) }), emit() {} }, notifyChange() {}, jtCacheInvalidate() {},
		getJobTrackingCached: async () => jt, tripDayLockCover: () => null, deletedLoadRestore: instance };
	new Function(...DEL_PROVIDED, `"use strict";\n${DEL_TEXT}`)(...DEL_PROVIDED.map((n) => deps[n]));
	return async (loadId) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		await routes["/api/loads/:loadId"]({ params: { loadId }, body: {}, session: { user: { ...SA } } }, res);
		return out;
	};
}

// The availability world's Job Tracking (its header row; jtRow() builds a row).
const WH = W.HEADERS;
const worldJt = (w) => jtOf(WH, w.sheet.tabs["Job Tracking"].slice(1));
// A new load as New Job sends it: dates in an open month, so the append's own month guard lets it through.
const newRow = (id) => W.jtRow({ id, pickup: "10/20/2026 08:00", dropoff: "10/21/2026 17:00", status: "Unassigned", assigned: "10/15/2026" });

async function main() {
	section("§1 the module");
	ok("lib/deleted-load-restore.js loads", !!lib, libError);
	// §2 and §3 run without it too: on a checkout without it, they show the create going through.
	if (lib) unitChecks();

	await createRouteSections();
	if (!lib) return;
	await hiddenSections();
}

function unitChecks() {
	eq("ids: positive whole numbers of up to 15 digits", ["1", "42", "999999999999999", "0", "01", "-3", "1.5", "1e3", "x", "", null, "9999999999999999"].map(lib.restoreIdOf),
		[1, 42, 999999999999999, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
	eq("a re-send's choice: create_new with the newest delete's id and the count seen; anything else is no choice, a bad id or count is 0", [
		{ deletedLoadChoice: { action: "create_new", id: 7, count: 2 } }, { deletedLoadChoice: { action: "create_new", id: "7", count: "2" } },
		{ deletedLoadChoice: { action: "restore", id: 7 } }, { deletedLoadChoice: [] }, {}, null,
		{ deletedLoadChoice: { action: "create_new", id: 7, count: 1, reason: "Booked again by the broker (made-up)" } },
	].map(lib.choiceOf), [{ action: "create_new", id: 7, count: 2 }, { action: "create_new", id: 0, count: 0 }, null, null, null, null,
		{ action: "create_new", id: 7, count: 1, reason: "Booked again by the broker (made-up)" }]);
	const COLS = { pickupAddress: "Pickup Address", dropoffAddress: "Drop-off Address", pickupDate: "Pickup Appointment", dropoffDate: "Drop-off Appointment" };
	const one = { "Pickup Address": "100 Test Way, Dallas, TX", "Drop-off Address": "200 Sample Rd, Austin, TX", "Pickup Appointment": "10/01/2026 08:00", "Drop-off Appointment": "10/02/2026" };
	eq("a row's digest: the same for the same four cells, whatever the spacing or case; another for another cell", [
		lib.rowDigest(one, COLS) === lib.rowDigest({ ...one, "Pickup Address": "  100 TEST way,  Dallas, TX " }, COLS),
		lib.rowDigest(one, COLS) === lib.rowDigest({ ...one, "Drop-off Appointment": "10/03/2026" }, COLS),
		lib.rowDigest(one, COLS) === lib.rowDigest({ ...one, Driver: "Someone Else", "Job Status": "Delivered" }, COLS),
		/^[0-9a-f]{32}$/.test(lib.rowDigest(one, COLS)),
	], [true, false, true, true]);
	const words = Object.values(lib.WORDS).map((v) => (typeof v === "function" ? v("LX-1", ["May 2026"], 4) : v));
	eq("the words say no reopen, show no API path and print no internal code", words.filter((s) => /reopen|\/api\/|\bPERIOD_[A-Z_]+/i.test(s)), []);
}

async function createRouteSections() {
	// ------------------------------------------------------------ §2 POST /api/data
	section("§2 POST /api/data with a Load ID an old delete names");
	{
		const w = await W.startWorld({ flag: false, routes: ["dataPost"], env: { DELETED_LOAD_RESTORE_ENABLED: "true" } });
		if (lib) lib.ensureSchema(w.db);
		const post = (body, user = W.USERS.sa) => w.call("POST", "/api/data", { user, body });
		const rows = () => w.sheet.tabs["Job Tracking"].length;
		const gone = tomb(w.db, "7101", 0, "2026-10-01 12:00:00", "admin_two");
		const before = fingerprint(w.db);
		const n0 = rows();
		const first = await post({ values: newRow("7101") });
		eq("a Super Admin gets 409 LOAD_ID_DELETED with the choice", [first.status, first.body && first.body.code], [409, "LOAD_ID_DELETED"]);
		const pick = (b) => b && { loadId: b.loadId, tombstoneId: b.tombstoneId, deletedBy: b.deletedBy, deletedAt: b.deletedAt, sheetRow: b.sheetRow, canRestore: b.canRestore, canCreateNew: b.canCreateNew, deleteCount: b.deleteCount };
		eq("...naming the delete, who made it and when; no row holds the ID, so only Create it as new works",
			pick(first.body), { loadId: "7101", tombstoneId: gone, deletedBy: "admin_two", deletedAt: "2026-10-01T12:00:00Z", sheetRow: null, canRestore: false, canCreateNew: true, deleteCount: 1 });
		eq("...in words too", first.body && first.body.error, "Load 7101 was deleted on 2026-10-01 by admin_two. Restore the deleted load, or create it as new.");
		eq("...and nothing was written", [fingerprint(w.db) === before, rows()], [true, n0]);

		const stale = await post({ values: newRow("7101"), deletedLoadChoice: { action: "create_new", id: gone + 1000 } });
		eq("a choice naming another delete is refused as stale, nothing written", [stale.status, stale.body && stale.body.stale, stale.body && stale.body.error, fingerprint(w.db) === before, rows()],
			[409, true, "The delete record for load 7101 changed after you chose, so nothing was created. Choose again.", true, n0]);
		const other = tomb(w.db, "7999", 0, "2026-10-02 12:00:00");
		const foreign = await post({ values: newRow("7101"), deletedLoadChoice: { action: "create_new", id: other } });
		eq("...and so is one naming another load's delete", [foreign.status, foreign.body && foreign.body.stale, tombsFor(w.db, "7101").length, rows()], [409, true, 1, n0]);

		// The reason (the 10-22 Restore decision): missing, too short, too long or holding contact is refused, nothing written.
		const badReasons = [[undefined, "RESTORE_REASON_REQUIRED"], [42, "RESTORE_REASON_REQUIRED"], ["  ok ", "RESTORE_REASON_REQUIRED"], ["​​ok​", "RESTORE_REASON_REQUIRED"],
			["x".repeat(501), "RESTORE_REASON_REQUIRED"], ["Call the broker at (555) 010-0150", "CONTACT_NOT_ALLOWED"], ["Ask agent.one@example.com", "CONTACT_NOT_ALLOWED"]];
		const refusedReasons = [];
		const reasonBefore = fingerprint(w.db);
		for (const [reason] of badReasons) {
			const choice = { action: "create_new", id: gone, count: 1, ...(reason === undefined ? {} : { reason }) };
			const r = await post({ values: newRow("7101"), deletedLoadChoice: choice });
			refusedReasons.push([r.status, r.body && r.body.code, r.body && r.body.field]);
		}
		eq("Create it as new with a reason missing, not text, under 3 characters once cleaned, over 500, or holding an email or phone: 400, the field named",
			refusedReasons, badReasons.map(([, code]) => [400, code, "reason"]));
		eq("...nothing written for any of them", [fingerprint(w.db) === reasonBefore, rows()], [true, n0]);
		const long = await post({ values: newRow("7101"), deletedLoadChoice: asNewChoice(gone, 1, "x".repeat(501)) });
		eq("...a reason over 500 characters is refused, never cut", [long.body && long.body.reason, long.body && long.body.error],
			["too_long", "The reason is longer than 500 characters. Shorten it, then try again. Nothing was created."]);

		const asNew = await post({ values: newRow("7101"), deletedLoadChoice: asNewChoice(gone, 1) });
		eq("\"Create it as new\": created, the delete gone", [asNew.status, asNew.body && asNew.body.success, tombsFor(w.db, "7101").length, rows()], [200, true, 0, n0 + 1]);
		eq("...one clear_load_delete row", actions(w.db, "7101"), ["clear_load_delete"]);
		eq("...written before the new row's create_sheet_row",
			w.db.prepare("SELECT action FROM audit_trail WHERE action IN ('clear_load_delete', 'create_sheet_row') ORDER BY id").all().map((r) => r.action),
			["clear_load_delete", "create_sheet_row"]);
		const clear = w.db.prepare("SELECT * FROM audit_trail WHERE action = 'clear_load_delete'").get() || {};
		ok("...naming who, the delete record, its maker and time, the route and the reason",
			clear.username === "super_admin" && clear.role === "Super Admin" && [`deleted_loads row ${gone}`, "admin_two", "2026-10-01T12:00:00Z", "POST /api/data", `Reason: ${REASON}`].every((s) => (clear.details || "").includes(s)), clear.details);
		const H = helpersFor(w.db);
		eq("...and the new row counts", H.excludeDroppedLoads(worldJt(w).data, WH).some((r) => r["Load ID"] === "7101"), true);

		// "Create it as new" when the append then fails: the delete was cleared first, so no row is left hidden.
		const first2 = tomb(w.db, "7102", 0, "2026-10-03 12:00:00");
		w.sheet.control.failWrites = true;
		const failed = await post({ values: newRow("7102"), deletedLoadChoice: asNewChoice(first2, 1) });
		w.sheet.control.failWrites = false;
		eq("an append that fails after the clear: the delete is already gone, so nothing is left hidden",
			[failed.status, tombsFor(w.db, "7102").length, actions(w.db, "7102")], [500, 0, ["clear_load_delete"]]);

		// A row still holds the ID (7003 is on the sheet).
		const held = tomb(w.db, "7003", 4, "2026-10-04 12:00:00");
		const heldBefore = fingerprint(w.db);
		const h1 = await post({ values: newRow("7003") });
		eq("a row still holding the ID: Restore works, Create it as new doesn't", pick(h1.body),
			{ loadId: "7003", tombstoneId: held, deletedBy: "super_admin", deletedAt: "2026-10-04T12:00:00Z", sheetRow: 4, canRestore: true, canCreateNew: false, deleteCount: 1 });
		const h2 = await post({ values: newRow("7003"), deletedLoadChoice: asNewChoice(held, 1) });
		eq("...and a re-send that asks for it anyway is refused, nothing written", [h2.status, h2.body && h2.body.error, fingerprint(w.db) === heldBefore],
			[409, "Row 4 still holds load 7003: restore it instead, or remove that row first. Nothing was created.", true]);

		// Deleted twice (M5): "Create it as new" clears every delete of the ID, checked against the newest and the count.
		const twice1 = tomb(w.db, "7104", 0, "2026-10-05 12:00:00", "admin_two");
		const twice2 = tomb(w.db, "7104", 0, "2026-10-05 12:00:00");
		const t1 = await post({ values: newRow("7104") });
		eq("a load deleted twice: named by its newest delete, Create it as new on, the count sent", [t1.body && t1.body.tombstoneId, t1.body && t1.body.canCreateNew, t1.body && t1.body.deleteCount], [twice2, true, 2]);
		const tFewer = await post({ values: newRow("7104"), deletedLoadChoice: asNewChoice(twice2, 1) });
		eq("...a re-send that saw one delete fewer is refused as stale, both kept", [tFewer.status, tFewer.body && tFewer.body.stale, tombsFor(w.db, "7104").length], [409, true, 2]);
		const t2 = await post({ values: newRow("7104"), deletedLoadChoice: asNewChoice(twice2, 2) });
		const twiceClears = w.db.prepare("SELECT details FROM audit_trail WHERE action = 'clear_load_delete' AND entity_id = '7104'").all();
		eq("...the right one clears both: created, no delete left, one clear_load_delete row", [t2.status, tombsFor(w.db, "7104").length, twiceClears.length], [200, 0, 1]);
		ok("...naming each delete record", twiceClears[0] && [`deleted_loads row ${twice1}`, `deleted_loads row ${twice2}`, "admin_two"].every((s) => twiceClears[0].details.includes(s)), twiceClears[0] && twiceClears[0].details);

		// The choice is checked at the duplicate read; the delete is cleared only just before the append (M1). A delete
		// added while the create is on its way (here, during the route's second header read) makes the choice stale.
		const late1 = tomb(w.db, "7109", 0, "2026-10-07 12:00:00");
		const realGet2 = w.sheet.api.spreadsheets.values.get;
		let lateId = 0;
		w.sheet.api.spreadsheets.values.get = async (q) => {
			if (q.range === "'Job Tracking'!1:1" && !lateId) lateId = tomb(w.db, "7109", 0, "2026-10-07 12:30:00", "admin_two");
			return realGet2(q);
		};
		const nLate = rows();
		const late = await post({ values: newRow("7109"), deletedLoadChoice: asNewChoice(late1, 1) });
		w.sheet.api.spreadsheets.values.get = realGet2;
		eq("a delete added after the duplicate read: stale at the append, with the fresh choice; nothing cleared or created",
			[late.status, late.body && late.body.code, late.body && late.body.stale, late.body && late.body.tombstoneId, late.body && late.body.deleteCount, late.body && late.body.canCreateNew,
				tombsFor(w.db, "7109").length, actions(w.db, "7109"), rows()],
			[409, "LOAD_ID_DELETED", true, lateId, 2, true, 2, [], nLate]);

		// The first header read fails: which column holds the Load ID can't be told, so neither can a delete of it (M2).
		const realGet3 = w.sheet.api.spreadsheets.values.get;
		w.sheet.api.spreadsheets.values.get = async (q) => { if (q.range === "Job Tracking!1:1") throw new Error("made-up header read failure"); return realGet3(q); };
		tomb(w.db, "7111", 0, "2026-10-08 12:00:00");
		const hdrBefore = fingerprint(w.db);
		const nHdr = rows();
		const hd1 = await post({ values: newRow("7111") });
		const hd2 = await post({ values: newRow("7112") });
		w.sheet.api.spreadsheets.values.get = realGet3;
		eq("an unreadable header row: 503 in plain words, whether or not a delete names the ID; nothing written",
			[hd1.status, hd1.body && hd1.body.code, hd1.body && hd1.body.error, hd2.status, hd2.body && hd2.body.code, fingerprint(w.db) === hdrBefore, rows()],
			[503, "SHEET_UNREADABLE", "Job Tracking's header row could not be read, so this new load can't be checked against deleted loads. Nothing was created. Try again in a moment.",
				503, "SHEET_UNREADABLE", true, nHdr]);

		// The duplicate read fails: whether a row holds the ID can't be told.
		const realGet = w.sheet.api.spreadsheets.values.get;
		w.sheet.api.spreadsheets.values.get = async (q) => { if (q.range === "Job Tracking") throw new Error("made-up read failure"); return realGet(q); };
		tomb(w.db, "7105", 0, "2026-10-06 12:00:00");
		const r1 = await post({ values: newRow("7105") });
		const r2 = await post({ values: newRow("7106") });
		w.sheet.api.spreadsheets.values.get = realGet;
		eq("an unreadable sheet: 503 when a delete names the ID; created as before when none does", [r1.status, r1.body && r1.body.code, r2.status],
			[503, "SHEET_UNREADABLE", 200]);

		// The delete table can't be read.
		w.db.exec("ALTER TABLE deleted_loads RENAME TO deleted_loads_away");
		const nr = await post({ values: newRow("7107") });
		w.db.exec("ALTER TABLE deleted_loads_away RENAME TO deleted_loads");
		eq("an unreadable delete table: 503, nothing created", [nr.status, nr.body && nr.body.code], [503, "DELETED_LOADS_UNREADABLE"]);

		const plain = await post({ values: newRow("7108") });
		eq("no delete names the ID: created as before", [plain.status, plain.body && plain.body.success], [200, true]);
		await w.close();
	}
	{
		const w = await W.startWorld({ flag: false, routes: ["dataPost"] });
		if (lib) lib.ensureSchema(w.db);
		tomb(w.db, "7101", 0, "2026-10-01 12:00:00");
		const r = await w.call("POST", "/api/data", { user: W.USERS.sa, body: { values: newRow("7101") } });
		eq("the flag off: created as before (and hidden by the delete, as before)", [r.status, r.body && r.body.success, tombsFor(w.db, "7101").length], [200, true, 1]);
		const realGet = w.sheet.api.spreadsheets.values.get;
		w.sheet.api.spreadsheets.values.get = async (q) => { if (q.range === "Job Tracking!1:1") throw new Error("made-up header read failure"); return realGet(q); };
		const hdr = await w.call("POST", "/api/data", { user: W.USERS.sa, body: { values: newRow("7113") } });
		w.sheet.api.spreadsheets.values.get = realGet;
		eq("...and so with an unreadable header row", [hdr.status, hdr.body && hdr.body.success], [200, true]);
		await w.close();
	}
	{
		// A refusal the route makes after the choice was checked writes nothing (M1): the off-duty question answered
		// "Keep as is", and a row in a closed month.
		const w = await W.startWorld({ flag: true, routes: ["dataPost"], env: { DELETED_LOAD_RESTORE_ENABLED: "true" } });
		if (lib) lib.ensureSchema(w.db);
		const post = (body) => w.call("POST", "/api/data", { user: W.USERS.sa, body });
		const rows = () => w.sheet.tabs["Job Tracking"].length;
		w.db.prepare(`INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, reason, created_by, created_by_user_id, created_at, request_status, source)
			VALUES (?, 'Tamsin Vale', 'vacation', '2026-10-18', '2026-10-22', '', 'dispatch_t', 2, '2026-10-10T12:00:00Z', 'approved', 'staff')`).run(W.DIR.tamsin);
		const offId = tomb(w.db, "7121", 0, "2026-10-09 12:00:00");
		const offRow = W.jtRow({ id: "7121", driver: "Tamsin Vale", pickup: "10/20/2026 08:00", dropoff: "10/21/2026 17:00", status: "Dispatched", assigned: "10/15/2026" });
		const before = fingerprint(w.db);
		const n0 = rows();
		const kept = await post({ values: offRow, deletedLoadChoice: asNewChoice(offId, 1) });
		eq("Create it as new, then \"Keep as is\" to the off-duty question: 409, the delete kept, nothing audited, no row",
			[kept.status, kept.body && kept.body.code, fingerprint(w.db) === before, rows()], [409, "DRIVER_OFF_DUTY", true, n0]);
		const sure = await post({ values: offRow, deletedLoadChoice: asNewChoice(offId, 1), confirmOffDuty: true });
		eq("...confirmed: created, the delete cleared with one clear_load_delete row", [sure.status, tombsFor(w.db, "7121").length, clears(w.db, "7121"), rows()], [200, 0, 1, n0 + 1]);

		w.db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-09', 'locked', '2026-10-05T05:00:00Z', 'test')").run();
		const lockId = tomb(w.db, "7122", 0, "2026-10-09 13:00:00");
		const n1 = rows();
		const closed = await post({ values: W.jtRow({ id: "7122", pickup: "9/10/2026 08:00", dropoff: "9/11/2026 17:00", status: "Delivered", assigned: "9/10/2026" }),
			deletedLoadChoice: asNewChoice(lockId, 1) });
		// The server answers 409 PERIOD_FINALIZED; this world answers 500 there (its lift lacks logAuditRefusal).
		eq("Create it as new for a completed row in a closed month: refused, the delete kept, no clear, no row",
			[closed.status >= 400, tombsFor(w.db, "7122").length, clears(w.db, "7122"), rows()], [true, 1, 0, n1]);
		await w.close();
	}

	// ----------------------------------------------------------- §3 from-ratecon
	section("§3 POST /api/loads/from-ratecon with a Load ID an old delete names");
	const NONE = { inst: null, sent: [] };
	{
		const db = schemaDb();
		const m = lib ? mounted(db, { now: () => new Date("2026-10-15T16:00:00Z") }) : NONE;
		const rc = rateCon(db, m.inst);
		const gone = tomb(db, "rc-7101", 0, "2026-10-01 12:00:00", "admin_two");
		auditDelete(db, "rc-7101", "2026-10-01T12:00:00.300Z", "2026-10");
		const before = fingerprint(db);
		const d1 = await rc.post(DISP, "RC-7101");
		eq("a Dispatcher: 409 in plain words, no who, no when", [d1.status, d1.body],
			[409, { error: "Load RC-7101 can't be created here because an earlier load with this ID was deleted. Ask a Super Admin to restore it or create it as new.", code: "LOAD_ID_DELETED" }]);
		eq("...nothing created", rc.appended(), 0);
		const after = JSON.parse(fingerprint(db));
		const was = JSON.parse(before);
		eq("...the delete and the audit trail untouched", [JSON.stringify(after[0]) === JSON.stringify(was[0]), JSON.stringify(after[1]) === JSON.stringify(was[1])], [true, true]);
		const n1 = notices(db);
		eq("...one notice to Super Admins, naming who tried", [n1.length, n1[0] && n1[0].metadata.kind, n1[0] && n1[0].metadata.tombstoneId, n1[0] && n1[0].metadata.userId, m.sent.map((s) => s.room)],
			[1, "refused_create", gone, DISP.id, ["super-admin"]]);
		ok("...whose words name the load, who tried, who deleted it and when", n1[0] && /RC-7101/.test(n1[0].title) && /dispatch_t/.test(n1[0].body) && /admin_two/.test(n1[0].body) && /2026-10-01/.test(n1[0].body), n1[0] && `${n1[0].title} | ${n1[0].body}`);
		await rc.post(DISP, "RC-7101");
		eq("the same Dispatcher again the same day: no second notice", notices(db).length, 1);
		await rc.post(DISP2, "RC-7101");
		eq("another Dispatcher: one more", notices(db).length, 2);
		const m2 = lib ? mounted(db, { now: () => new Date("2026-10-16T16:00:00Z") }) : NONE;
		await rateCon(db, m2.inst).post(DISP, "RC-7101");
		eq("the first Dispatcher the next day: one more", notices(db).length, 3);

		const s1 = await rc.post(SA, "RC-7101");
		eq("a Super Admin: the choice, nothing created", [s1.status, s1.body && s1.body.code, s1.body && s1.body.tombstoneId, s1.body && s1.body.canCreateNew, rc.appended()], [409, "LOAD_ID_DELETED", gone, true, 0]);
		eq("...with the month its delete named, open or closed, from the delete record (L1)", [s1.body && s1.body.months, s1.body && s1.body.monthsFrom],
			[[{ month: "2026-10", closed: false }], "audit"]);
		const noReason = await rc.post(SA, "RC-7101", { deletedLoadChoice: { action: "create_new", id: gone, count: 1 } });
		const contact = await rc.post(SA, "RC-7101", { deletedLoadChoice: asNewChoice(gone, 1, "Text me at 555-010-0150") });
		eq("Create it as new with no reason, or one holding a phone: 400 in plain words, nothing created or cleared",
			[noReason.status, noReason.body && noReason.body.code, noReason.body && noReason.body.error, contact.status, contact.body && contact.body.code, rc.appended(), tombsFor(db, "rc-7101").length, doneNotices(db).length],
			[400, "RESTORE_REASON_REQUIRED", "A reason of 3 to 500 characters is required: it is saved in the audit trail and sent to the Super Admins. Nothing was created.",
				400, "CONTACT_NOT_ALLOWED", 0, 1, 0]);
		const s2 = await rc.post(SA, "RC-7101", { deletedLoadChoice: asNewChoice(gone, 1) });
		eq("\"Create it as new\": created, the delete gone, one clear row then the create", [s2.status, rc.appended(), tombsFor(db, "rc-7101").length, actions(db, "rc-7101")], [200, 1, 0, ["delete_load", "clear_load_delete"]]);
		eq("...the rate-con create audited as before", actions(db, "RC-7101"), ["create_load_ratecon"]);
		const cleared = doneNotices(db);
		eq("...one notice to the Super Admins naming the load, who cleared it and the reason", cleared.map((n) => [n.title, n.body, n.metadata.kind]),
			[["Load RC-7101's old delete was cleared", `Cleared by super_admin, so the load counts as new. Reason: ${REASON}`, "cleared"]]);
		eq("...sent live to the super-admin room only", m.sent.filter((s) => s.notice.type === DONE_TYPE).map((s) => s.room), ["super-admin"]);
		const lists = noticeRoutes(db);
		const typesOf = (out) => ((out.body && out.body.notifications) || []).map((n) => n.type);
		eq("...in a Super Admin's notifications, not in a Dispatcher's", [typesOf(await lists(SA)).includes(DONE_TYPE), typesOf(await lists(DISP)).includes(DONE_TYPE)], [true, false]);

		const second = tomb(db, "rc-7102", 0, "2026-10-02 12:00:00");
		rc.control.failAppend = true;
		const f = await rc.post(SA, "RC-7102", { deletedLoadChoice: asNewChoice(second, 1) });
		rc.control.failAppend = false;
		eq("an append that fails after the clear: the delete is already gone", [f.status, tombsFor(db, "rc-7102").length, actions(db, "rc-7102")], [500, 0, ["clear_load_delete"]]);

		const free = await rc.post(DISP, "RC-7103");
		eq("no delete names the ID: a Dispatcher creates it as before", [free.status, free.body && free.body.loadId], [200, "RC-7103"]);
	}
	{
		const db = schemaDb();
		const m = lib ? mounted(db) : NONE;
		const rc = rateCon(db, m.inst, { rows: [["RC-7201", "Dry van", "", "1 Elm St, Waco, TX 76701", "10/01/2026", "2 Oak St, Tyler, TX 75701", "10/02/2026", "Delivered", "$900.00", "10/01/2026"]] });
		const held = tomb(db, "rc-7201", 2, "2026-10-05 12:00:00");
		const s = await rc.post(SA, "RC-7201");
		eq("a row still holds the ID: the choice offers Restore (row 2), not Create it as new", [s.status, s.body && s.body.sheetRow, s.body && s.body.canRestore, s.body && s.body.canCreateNew], [409, 2, true, false]);
		const d = await rc.post(DISP, "RC-7201");
		eq("...a Dispatcher is refused the same way, never told the row", [d.status, d.body && d.body.code, Object.keys(d.body || {})], [409, "LOAD_ID_DELETED", ["error", "code"]]);
		const again = await rc.post(SA, "RC-7201", { deletedLoadChoice: asNewChoice(held, 1) });
		eq("...a re-send asking for it anyway is refused, the delete kept", [again.status, tombsFor(db, "rc-7201").length, rc.appended()], [409, 1, 0]);
	}
	{
		// The delete is cleared only just before the append (M1): one added while the route priced and placed the load
		// (here, during its geocoding) makes the choice stale, and nothing is written.
		const db = schemaDb();
		const m = lib ? mounted(db) : NONE;
		let lateId = 0;
		const rc = rateCon(db, m.inst, { geocode: async () => { if (!lateId) lateId = tomb(db, "rc-7401", 0, "2026-10-03 12:30:00", "admin_two"); return null; } });
		const first = tomb(db, "rc-7401", 0, "2026-10-03 12:00:00");
		const r = await rc.post(SA, "RC-7401", { deletedLoadChoice: asNewChoice(first, 1) });
		eq("a delete added after the duplicate read: stale at the append, with the fresh choice; nothing cleared or created",
			[r.status, r.body && r.body.stale, r.body && r.body.tombstoneId, r.body && r.body.deleteCount, tombsFor(db, "rc-7401").length, actions(db, "rc-7401"), rc.appended()],
			[409, true, lateId, 2, 2, [], 0]);
	}
	{
		const db = schemaDb();
		const rc = rateCon(db, lib ? lib.create({ db, enabled: false }) : null);
		tomb(db, "rc-7301", 0, "2026-10-01 12:00:00");
		const r = await rc.post(DISP, "RC-7301");
		eq("the flag off: created as before, the delete kept, no notice", [r.status, rc.appended(), tombsFor(db, "rc-7301").length, notices(db).length], [200, 1, 1, 0]);
	}
}

async function hiddenSections() {
	// -------------------------------------------------------------- §4 hidden rows
	section("§4 a live row an old delete hides shows for a Super Admin, from every path");
	const H4 = ["Load ID", "Driver", "Job Status", "Pickup Address", "Pickup Appointment", "Drop-off Address", "Drop-off Appointment", "Assigned Date"];
	const rowOf = (id, o = {}) => [id, o.driver || "Test Driver One", o.status || "Dispatched", o.pu || `${id} Pickup Rd, Dallas, TX 75201`, o.puAt || "10/20/2026 08:00",
		o.dr || `${id} Drop Ave, Austin, TX 78701`, o.drAt || "10/21/2026 17:00", o.assigned || "10/19/2026"];
	{
		const db = schemaDb();
		const sheetRows = [];
		let jt = jtOf(H4, sheetRows);
		const m = mounted(db, { read: () => jt });
		const hide = (rowsNow) => { jt = jtOf(H4, rowsNow); return jt; };
		const shown = (user = SA) => m.inst.hiddenLoads(reqOf(user), jt);
		const itemOf = (list, loadId) => (list || []).find((x) => normalizeLoadId(x.loadId) === normalizeLoadId(loadId)) || {};
		const evidenceOf = (list, loadId) => itemOf(list, loadId).evidence;
		const rowsOf = (x) => [x.sheetRow, x.rows, x.newRows, x.ownRows, x.canCreateNew];

		// A deliberate delete: its row stays, unchanged. Recorded by the delete route itself.
		const keep = rowOf("LX-5001");
		hide([keep, rowOf("LX-5009")]);
		const delRoute = deleteRoute(db, m.inst, jt);
		const d = await delRoute("LX-5001");
		eq("a deliberate delete (its row kept): nothing shows", [d.status, shown()], [200, []]);
		hide([rowOf("LX-5009"), keep]);
		eq("...sorted so its row moves: still nothing", shown(), []);

		// 1. Deleted when no row held the ID; a row appears later.
		tomb(db, "lx-5101", 0, "2026-10-01 12:00:00", "admin_two");
		hide([rowOf("LX-5009"), keep, rowOf("LX-5101")]);
		const s1 = shown();
		ok("deleted with no row, then a row: shows, saying so", (evidenceOf(s1, "LX-5101") || []).includes("deleted_with_no_row"), JSON.stringify(s1));
		const item = (s1 || []).find((x) => x.loadId === "LX-5101") || {};
		eq("...with the load as the sheet spells it, who deleted it and when, and the row", [item.loadId, item.deletedBy, item.deletedAt, item.sheetRow, Number.isInteger(item.tombstoneId)],
			["LX-5101", "admin_two", "2026-10-01T12:00:00Z", 4, true]);
		eq("...its row new to the delete, so both choices are open, and its month (M3, L1)",
			[item.rows, item.newRows, item.ownRows, item.canRestore, item.canCreateNew, item.months], [[4], [4], [], true, true, [{ month: "2026-10", closed: false }]]);

		// 2a. A rate con created it after the delete (before the switch was on: the flag-off route).
		const rcOff = rateCon(db, lib.create({ db, enabled: false }));
		tomb(db, "rc-5201", 0, "2026-10-01 12:00:00");
		db.prepare("UPDATE deleted_loads SET row_digests = '[]', row_index = 7 WHERE load_id = 'rc-5201'").run();
		await rcOff.post(SA, "RC-5201");
		hide([...jt.data.map((r) => H4.map((h) => r[h])), rowOf("RC-5201")]);
		ok("created by a rate con after the delete: shows", (evidenceOf(shown(), "RC-5201") || []).includes("created_by_rate_con"), JSON.stringify(evidenceOf(shown(), "RC-5201")));

		// 2b/2c. New Job and the Data Manager's Add Row (POST /api/data) after the delete.
		for (const [label, id, url] of [["New Job", "7301", "/api/data?sheet=Job%20Tracking"], ["the Data Manager's Add Row", "7302", "/api/data?sheet=Job%20Tracking&page=1"]]) {
			const w = await W.startWorld({ flag: false, routes: ["dataPost"] });
			lib.ensureSchema(w.db);
			tomb(w.db, id, 6, "2026-10-01 12:00:00");
			w.db.prepare("UPDATE deleted_loads SET row_digests = ? WHERE load_id = ?").run(JSON.stringify([lib.rowDigest({}, {})]), id);
			const made = await w.call("POST", url, { user: W.USERS.sa, body: { values: W.jtRow({ id, pickup: "10/20/2026 08:00", dropoff: "10/21/2026 17:00", status: "Unassigned" }) } });
			const mw = mounted(w.db);
			const list = mw.inst.hiddenLoads(reqOf(SA), worldJt(w));
			ok(`created by ${label} after the delete: shows`, made.status === 200 && (evidenceOf(list, id) || []).includes("created_in_sheet_row"), `${made.status} ${JSON.stringify(list)}`);
			await w.close();
		}

		// 2d. n8n wrote the row and told the app (POST /api/webhook/new-load). An older delete (no digests) whose
		// delete_load row names October: the row books into October, so it may be the delete's own.
		tomb(db, "lx-5401", 9, "2026-10-01 12:00:00");
		auditDelete(db, "lx-5401", "2026-10-01T12:00:00.300Z", "2026-10");
		hide([...jt.data.map((r) => H4.map((h) => r[h])), rowOf("LX-5401")]);
		db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata, created_at) VALUES ('new-load', 'New Load LX-5401', 'New load added from dispatch workflow', ?, '2026-10-12 08:00:00')")
			.run(JSON.stringify({ loadId: "LX-5401", driver: "", source: "n8n" }));
		eq("added by n8n after the delete: shows, by that alone", evidenceOf(shown(), "LX-5401"), ["created_by_n8n"]);
		eq("...its row in the month the delete named may be the delete's own, so Create it as new is shut", rowsOf(itemOf(shown(), "LX-5401")), [6, [6], [], [6], false]);
		ok("POST /api/webhook/new-load still stores its notice that way", /insertDispatchNotification\.run\(\s*"new-load",[\s\S]{0,200}JSON\.stringify\(\{ loadId, driver, source: "n8n" \}\)/.test(SRC));

		// 3. A hand edit: the deleted load's row is changed (another pickup) after the delete recorded it.
		const edited = rowOf("LX-5501");
		hide([...jt.data.map((r) => H4.map((h) => r[h])), edited]);
		const delEdit = deleteRoute(db, m.inst, jt);
		await delEdit("LX-5501");
		eq("recorded at the delete, unchanged: nothing", evidenceOf(shown(), "LX-5501"), undefined);
		const others = jt.data.map((r) => H4.map((h) => r[h])).filter((r) => r[0] !== "LX-5501");
		hide([...others, rowOf("LX-5501", { pu: "9 Changed Blvd, Plano, TX 75023" })]);
		eq("its row changed by hand: shows, by that alone", evidenceOf(shown(), "LX-5501"), ["row_changed"]);
		eq("...naming that row, which the delete didn't record, so Create it as new is open", rowsOf(itemOf(shown(), "LX-5501")), [7, [7], [7], [], true]);
		hide([...others, edited, edited.slice()]);
		eq("...and so does a second copy of the row the delete recorded", evidenceOf(shown(), "LX-5501"), ["row_changed"]);
		eq("...naming the copy; the recorded row may be the delete's own, so Create it as new is shut", rowsOf(itemOf(shown(), "LX-5501")), [8, [7, 8], [8], [7], false]);
		hide([...others, edited]);
		eq("...but not the recorded row alone again", evidenceOf(shown(), "LX-5501"), undefined);

		// An older delete (made before digests were kept): a read writes nothing (M4). Its delete_load row's months
		// decide which live rows may be its own; a row in a month it didn't name shows.
		const old = tomb(db, "lx-5601", 11, "2026-10-02 12:00:00");
		auditDelete(db, "lx-5601", "2026-10-02T12:00:00.250Z", "2026-10");
		hide([...jt.data.map((r) => H4.map((h) => r[h])), rowOf("LX-5601")]);
		eq("an older delete with its row in the month it named: nothing", evidenceOf(shown(), "LX-5601"), undefined);
		eq("...and nothing written on the read", db.prepare("SELECT row_digests FROM deleted_loads WHERE id = ?").get(old).row_digests, null);
		hide(jt.data.map((r) => H4.map((h) => r[h])).map((r) => (r[0] === "LX-5601" ? rowOf("LX-5601", { assigned: "11/02/2026", puAt: "11/03/2026 08:00", drAt: "11/04/2026 17:00" }) : r)));
		eq("...a row with its ID in a month it didn't name shows", evidenceOf(shown(), "LX-5601"), ["row_in_other_month"]);
		eq("...as a new row, its month November", [itemOf(shown(), "LX-5601").newRows, itemOf(shown(), "LX-5601").canCreateNew, itemOf(shown(), "LX-5601").months],
			[[8], true, [{ month: "2026-11", closed: false }]]);
		tomb(db, "lx-5602", 12, "2026-10-02 12:00:00");
		hide([...jt.data.map((r) => H4.map((h) => r[h])), rowOf("LX-5602", { assigned: "11/02/2026", puAt: "11/03/2026 08:00", drAt: "11/04/2026 17:00" })]);
		eq("an older delete that named no month: every live row may be its own, so nothing", evidenceOf(shown(), "LX-5602"), undefined);

		// A cancelled row hides nothing more than its own status does.
		tomb(db, "lx-5701", 0, "2026-10-01 12:00:00");
		hide([...jt.data.map((r) => H4.map((h) => r[h])), rowOf("LX-5701", { status: "Cancelled" })]);
		eq("a cancelled row with the ID: nothing", evidenceOf(shown(), "LX-5701"), undefined);
	}

	// ----------------------------------------------------------- §5 resolving it
	section("§5 resolving it clears it; one in closed months only stays off the banner");
	{
		const db = schemaDb();
		db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-05', 'locked', '2026-06-15T05:00:00Z', 'test')").run();
		const rows = [rowOf("LX-6001"), rowOf("LX-6002"), rowOf("LX-6003", { assigned: "05/04/2026", puAt: "05/05/2026", drAt: "05/06/2026" })];
		const jt = jtOf(H4, rows);
		const m = mounted(db, { read: jt });
		const ids = ["lx-6001", "lx-6002", "lx-6003"].map((l) => tomb(db, l, 0, "2026-10-01 12:00:00", "admin_two"));
		const listed = () => (m.inst.hiddenLoads(reqOf(SA), jt) || []).map((x) => x.loadId).sort();
		eq("two hidden in an open month on the banner; the one in a closed month left off it (L3)", listed(), ["LX-6001", "LX-6002"]);
		const closedOnes = () => notices(db).filter((n) => n.metadata.kind === "hidden_closed");
		eq("...the closed one told once, as a payout question", closedOnes().map((n) => [n.title, n.body, n.metadata.tombstoneId]), [[
			"Load LX-6003 is hidden by an earlier delete, in a closed month",
			"Deleted by admin_two on 2026-10-01. Its month (May 2026) is closed, so restoring it would change a settled payout, which is a payout question.",
			ids[2]]]);
		listed();
		eq("...and not again on the next read", closedOnes().length, 1);
		const chain = m.routes["POST /api/admin/deleted-loads/:id/restore"];
		const r1 = await run(chain, SA, { params: { id: String(ids[0]) } });
		const r2 = await run(chain, SA, { params: { id: String(ids[1]) }, body: { mode: "create_new" } });
		eq("Restore and Create it as new both answer 200", [r1.status, r2.status], [200, 200]);
		eq("...and the next read no longer lists them", listed(), []);
		eq("...one restore_load and one clear_load_delete", [actions(db, "lx-6001"), actions(db, "lx-6002")], [["restore_load"], ["clear_load_delete"]]);
		const details = (lid) => (db.prepare("SELECT details FROM audit_trail WHERE entity_id = ? AND action IN ('restore_load', 'clear_load_delete')").get(lid) || {}).details || "";
		ok("...each audit row carrying the reason", [details("lx-6001"), details("lx-6002")].every((d) => d.endsWith(`Reason: ${REASON}`)), `${details("lx-6001")} | ${details("lx-6002")}`);
		eq("...and one notice each to the Super Admins, naming the load, who did it and the reason", doneNotices(db).map((n) => [n.title, n.body, n.metadata.kind]), [
			["Load lx-6001 was restored", `Restored by super_admin. Reason: ${REASON}`, "restored"],
			["Load lx-6002's old delete was cleared", `Cleared by super_admin, so the load counts as new. Reason: ${REASON}`, "cleared"]]);
		eq("...sent live to the super-admin room only", m.sent.filter((s) => s.notice.type === DONE_TYPE).map((s) => s.room), ["super-admin", "super-admin"]);
		const lists = noticeRoutes(db);
		const typesOf = (out) => ((out.body && out.body.notifications) || []).map((n) => n.type);
		eq("...in a Super Admin's notifications, not in a Dispatcher's", [typesOf(await lists(SA)).filter((t) => t === DONE_TYPE).length, typesOf(await lists(DISP)).includes(DONE_TYPE)], [2, false]);
		const r3 = await run(chain, SA, { params: { id: String(ids[2]) }, body: { mode: "create_new" } });
		eq("the closed one: refused as a payout question, still off the banner, no notice", [r3.status, r3.body && r3.body.code, listed(), doneNotices(db).length], [409, "PERIOD_FINALIZED", [], 2]);
	}

	// -------------------------------------------------------- §6 other roles
	section("§6 nothing of it reaches another role");
	{
		const db = schemaDb();
		const jt = jtOf(H4, [rowOf("LX-7001")]);
		const m = mounted(db, { read: jt });
		tomb(db, "lx-7001", 0, "2026-10-01 12:00:00");
		const quietBefore = fingerprint(db) + JSON.stringify(db.prepare("SELECT row_digests FROM deleted_loads").all());
		for (const user of [DISP, { id: 9, role: "Driver", username: "drv" }, { id: 10, role: "Investor", username: "inv" }, { id: 11, role: "Admin", username: "adm" }, null]) {
			eq(`${user ? user.role : "signed out"}: no hidden loads worked out`, m.inst.hiddenLoads(reqOf(user), jt), null);
		}
		eq("...and nothing was written for them (no notice, no digest)", fingerprint(db) + JSON.stringify(db.prepare("SELECT row_digests FROM deleted_loads").all()), quietBefore);
		m.inst.hiddenLoads(reqOf(SA), jt);
		const list = noticeRoutes(db);
		const sa = await list(SA);
		const disp = await list(DISP);
		const types = (out) => ((out.body && out.body.notifications) || []).map((n) => n.type);
		eq("the notice: in a Super Admin's notifications, not in a Dispatcher's", [types(sa).includes("load-hidden-by-delete"), types(disp).includes("load-hidden-by-delete"), disp.body && disp.body.unreadCount],
			[true, false, 0]);
		eq("...sent live to the super-admin room only", m.sent.map((s) => s.room), ["super-admin"]);
	}

	// ------------------------------------------------- §7 one notice; flag off
	section("§7 one notice per hidden delete while it lasts; the flag off writes nothing");
	{
		const db = schemaDb();
		const jt = jtOf(H4, [rowOf("LX-8001"), rowOf("LX-8002")]);
		const m = mounted(db, { read: jt });
		tomb(db, "lx-8001", 0, "2026-10-01 12:00:00", "admin_two");
		m.inst.hiddenLoads(reqOf(SA), jt);
		m.inst.hiddenLoads(reqOf(SA), jt);
		const n = notices(db);
		eq("two reads, one notice", n.length, 1);
		eq("...naming the load, who deleted it and when", [n[0] && n[0].title, n[0] && n[0].body, n[0] && n[0].metadata.kind],
			["Load LX-8001 is hidden by an earlier delete", "Deleted by admin_two on 2026-10-01. Review it from the banner on the dashboard.", "hidden"]);
		tomb(db, "lx-8002", 0, "2026-10-02 12:00:00");
		m.inst.hiddenLoads(reqOf(SA), jt);
		eq("a second hidden delete: its own notice", notices(db).length, 2);

		const offDb = schemaDb();
		lib.ensureSchema(offDb);
		tomb(offDb, "lx-8001", 0, "2026-10-01 12:00:00");
		const before = fingerprint(offDb) + JSON.stringify(offDb.prepare("SELECT row_digests FROM deleted_loads").all());
		const off = mounted(offDb, { enabled: false, read: jt });
		eq("the flag off: no hidden loads, no dashboard step", [off.inst.hiddenLoads(reqOf(SA), jt), Object.keys(off.routes)], [null, []]);
		eq("...and nothing written", fingerprint(offDb) + JSON.stringify(offDb.prepare("SELECT row_digests FROM deleted_loads").all()), before);
	}

	// ------------------------------------------------------- §8 the dashboard step
	section("§8 the dashboard step");
	{
		const db = schemaDb();
		const jt = jtOf(H4, [rowOf("LX-9001")]);
		const m = mounted(db, { read: () => jt });
		tomb(db, "lx-9001", 0, "2026-10-01 12:00:00");
		const chain = m.routes["GET /api/dashboard"] || [];
		ok("mounted on GET /api/dashboard behind the dashboard route's own gate, then the step (L4)", chain.length === 2 && chain.every((f) => typeof f === "function"));
		// A GET through the mounted chain, as Express runs it; when every link passes, the route answers `answer`.
		const through = async (links, user, answer, status = 200) => {
			const req = { method: "GET", headers: {}, query: {}, params: {}, body: {}, session: user ? { user: { ...user } } : {} };
			const res = { statusCode: 200, sent: null, status(c) { this.statusCode = c; return this; }, json(b) { this.sent = b; return this; } };
			const original = res.json;
			for (const link of links) {
				let nexted = false;
				await link(req, res, () => { nexted = true; });
				if (!nexted) return { reached: false, status: res.statusCode, sent: res.sent, wrapped: res.json !== original };
			}
			res.statusCode = status;
			res.json(answer);
			return { reached: true, status: res.statusCode, sent: res.sent, wrapped: res.json !== original };
		};
		const answer = { timestamp: "2026-10-15T16:00:00.000Z", kpis: { activeLoads: 1 }, activeJobs: [] };
		const quiet = fingerprint(db);
		const pw = await through(chain, { ...SA, mustChangePassword: true }, answer);
		eq("a Super Admin who must change their password: refused by the gate, nothing worked out or written",
			[pw.reached, pw.status, pw.sent && pw.sent.code, pw.wrapped, fingerprint(db) === quiet], [false, 403, "PASSWORD_CHANGE_REQUIRED", false, true]);
		const drv = await through(chain, { id: 9, role: "Driver", username: "drv" }, answer);
		const anon = await through(chain, null, answer);
		eq("...and so are a Driver and a signed-out caller", [drv.reached, drv.status, anon.reached, anon.status, fingerprint(db) === quiet], [false, 403, false, 401, true]);
		const sa = await through(chain, SA, answer);
		eq("a Super Admin's answer: hiddenLoads second, the rest as sent", [sa.reached, Object.keys(sa.sent || {}), ((sa.sent && sa.sent.hiddenLoads) || []).map((x) => x.loadId), sa.sent && sa.sent.kpis],
			[true, ["timestamp", "hiddenLoads", "kpis", "activeJobs"], ["LX-9001"], { activeLoads: 1 }]);
		const err = await through(chain, SA, { error: "made-up failure" }, 500);
		eq("an error answer is sent as it was", err.sent, { error: "made-up failure" });
		const disp = await through(chain, DISP, answer);
		eq("a Dispatcher's: untouched, nothing worked out", [disp.reached, disp.wrapped, Object.keys(disp.sent || {})], [true, false, ["timestamp", "kpis", "activeJobs"]]);
		const broken = mounted(schemaDb(), { read: () => new Error("made-up Sheets outage") });
		const b = await through(broken.routes["GET /api/dashboard"] || [], SA, answer);
		eq("a check that can't read the sheet: the answer goes out as it was", [b.reached, Object.keys(b.sent || {})], [true, ["timestamp", "kpis", "activeJobs"]]);
	}

	// ---------------------------------------------------------- §9 the delete route
	section("§9 the delete records the rows it hides, with the flag on only");
	{
		const jt = jtOf(H4, [rowOf("LX-9101"), rowOf("LX-9101", { puAt: "10/22/2026 08:00" })]);
		const onDb = schemaDb();
		const on = mounted(onDb, { read: jt });
		const r = await deleteRoute(onDb, on.inst, jt)("LX-9101");
		const stored = onDb.prepare("SELECT * FROM deleted_loads WHERE load_id = 'lx-9101'").get() || {};
		eq("on: the tombstone holds both rows' digests", [r.status, JSON.parse(stored.row_digests || "[]").length], [200, 2]);
		const offDb = schemaDb();
		lib.ensureSchema(offDb);
		const off = lib.create({ db: offDb, enabled: false });
		const r2 = await deleteRoute(offDb, off, jt)("LX-9101");
		const stored2 = offDb.prepare("SELECT * FROM deleted_loads WHERE load_id = 'lx-9101'").get() || {};
		eq("off: the tombstone as always, no digests", [r2.status, stored2.row_digests, stored2.row_index, stored2.deleted_by], [200, null, 2, "super_admin"]);
	}

	// ------------------------------------------------------------- §10 the wiring
	section("§10 both create routes ask after their duplicate read and before their append");
	{
		const rc = (() => { try { return liftRoute(SRC, RC_HEAD); } catch { return ""; } })();
		const dp = (() => { try { return liftRoute(SRC, 'app.post("/api/data", requireRole("Super Admin"), async (req, res) => {'); } catch { return ""; } })();
		const at = (text, needle) => text.indexOf(needle);
		const RC_CALL = "const deletedLoadAnswer = deletedLoadRestore.onCreate(req, { loadId, rowIndex: existing ? existing._rowIndex : null, via: \"POST /api/loads/from-ratecon\" });";
		ok("from-ratecon: once, after its duplicate read, before the duplicate refusal and the append",
			rc.split(RC_CALL).length === 2 && at(rc, "const existing = deduplicateLoads(data, headers).find(") < at(rc, RC_CALL)
			&& at(rc, RC_CALL) < at(rc, "const softDeleted = getDeletedLoadIds().has(loadKey);") && at(rc, RC_CALL) < at(rc, "await sheets.spreadsheets.values.append("));
		const DP_CALL = "const deletedLoadAnswer = deletedLoadRestore.onCreate(req, { ...dupRead, via: \"POST /api/data\" });";
		ok("POST /api/data: once, after its duplicate read, before the append",
			dp.split(DP_CALL).length === 2 && at(dp, "dupRead.read = true;") < at(dp, DP_CALL) && at(dp, DP_CALL) < at(dp, "await sheets.spreadsheets.values.append("));
		ok("...both send the module's answer as it is", (rc + dp).split("if (deletedLoadAnswer) return res.status(deletedLoadAnswer.status).json(deletedLoadAnswer.body);").length === 3);
		ok("POST /api/data tells the module whether its first header read worked", /const dupRead = \{ loadId: "", rowIndex: null, read: false, headerRead: Array\.isArray\(hdrs\) && hdrs\.length > 0 \};/.test(dp));
		const CLEAR = "const deletedLoadClear = deletedLoadRestore.clearBeforeAppend(req);\n\t\tif (deletedLoadClear) return res.status(deletedLoadClear.status).json(deletedLoadClear.body);\n\t\t";
		ok("from-ratecon: the clear just before its append, after its last refusal (M1)",
			rc.split(CLEAR).length === 2 && at(rc, `${CLEAR}const appendResp = await sheets.spreadsheets.values.append(`) > 0
			&& at(rc, "if (formula) return res.status(400).json({ ...formula, sheet });") < at(rc, CLEAR));
		ok("POST /api/data: the clear just before its append, after the off-duty question (M1)",
			dp.split(CLEAR).length === 2 && at(dp, `${CLEAR}const response = await sheets.spreadsheets.values.append(`) > 0
			&& at(dp, "if (offDuty && offDuty.refusal) return res.status(409).json(offDuty.refusal);") < at(dp, CLEAR));
	}

	// ------------------------------------------- §11 the review's Create it as new
	section("§11 the review's Create it as new is refused while a row that may be the delete's own is live");
	{
		const db = schemaDb();
		const orig = rowOf("LX-6101");
		let jt = jtOf(H4, [rowOf("LX-6109"), orig]);
		const m = mounted(db, { read: () => jt });
		await deleteRoute(db, m.inst, jt)("LX-6101");
		jt = jtOf(H4, [rowOf("LX-6109"), orig, orig.slice()]);
		const item = (m.inst.hiddenLoads(reqOf(SA), jt) || []).find((x) => x.loadId === "LX-6101") || {};
		eq("a copy of the deleted row: listed by the copy, the recorded row named as maybe the delete's own", [item.sheetRow, item.newRows, item.ownRows, item.canCreateNew], [4, [4], [3], false]);
		const chain = m.routes["POST /api/admin/deleted-loads/:id/restore"];
		const before = fingerprint(db);
		const r = await run(chain, SA, { params: { id: String(item.tombstoneId) }, body: { mode: "create_new" } });
		eq("Create it as new: 409 naming the row in plain words, nothing changed (M3)",
			[r.status, r.body && r.body.code, r.body && r.body.rows, r.body && r.body.error, fingerprint(db) === before],
			[409, "DELETED_ROWS_PRESENT", [3], "Row 3 may be load lx-6101's row from before its delete, so creating it as new could bring that row back too. Restore the deleted load instead, or remove that row first. Nothing was changed.", true]);

		// Two recorded rows, both still on the sheet.
		const pair = [rowOf("LX-6301"), rowOf("LX-6301", { puAt: "10/22/2026 08:00" })];
		jt = jtOf(H4, [rowOf("LX-6109"), orig, orig.slice(), ...pair]);
		await deleteRoute(db, m.inst, jt)("LX-6301");
		const pairId = db.prepare("SELECT id FROM deleted_loads WHERE load_id = 'lx-6301'").get().id;
		const p = await run(chain, SA, { params: { id: String(pairId) }, body: { mode: "create_new" } });
		eq("...two such rows: named together", [p.status, p.body && p.body.rows, p.body && p.body.error],
			[409, [5, 6], "Rows 5 and 6 may be load lx-6301's rows from before its delete, so creating it as new could bring those rows back too. Restore the deleted load instead, or remove those rows first. Nothing was changed."]);

		// An older delete (no digests) whose row books into the month its delete_load row named.
		const older = tomb(db, "lx-6201", 7, "2026-10-02 12:00:00");
		auditDelete(db, "lx-6201", "2026-10-02T12:00:00.200Z", "2026-10");
		jt = jtOf(H4, [rowOf("LX-6109"), orig, orig.slice(), ...pair, rowOf("LX-6201")]);
		const o = await run(chain, SA, { params: { id: String(older) }, body: { mode: "create_new" } });
		eq("an older delete whose row is in the month it named: refused the same way", [o.status, o.body && o.body.code, o.body && o.body.rows], [409, "DELETED_ROWS_PRESENT", [7]]);
		const back = await run(chain, SA, { params: { id: String(older) } });
		eq("...while Restore goes through", [back.status, back.body && back.body.mode], [200, "restore"]);
	}

	// ------------------------------------------------------------- §12 the reason
	section("§12 a restore and the banner's Create it as new need a reason (the 10-22 Restore decision)");
	{
		const db = schemaDb();
		const jt = jtOf(H4, [rowOf("LX-6401")]);
		const m = mounted(db, { read: jt });
		const id = tomb(db, "lx-6401", 0, "2026-10-01 12:00:00");
		const chain = m.routes["POST /api/admin/deleted-loads/:id/restore"];
		const before = fingerprint(db);
		const cases = [
			["missing", {}, "RESTORE_REASON_REQUIRED", "missing"],
			["not text", { reason: ["Deleted by mistake"] }, "RESTORE_REASON_REQUIRED", "missing"],
			["blank", { reason: "   " }, "RESTORE_REASON_REQUIRED", "too_short"],
			["2 characters once cleaned", { reason: "​ok⁠" }, "RESTORE_REASON_REQUIRED", "too_short"],
			["501 characters", { reason: `${"y".repeat(250)} ${"z".repeat(250)}` }, "RESTORE_REASON_REQUIRED", "too_long"],
			["an email", { reason: "Per agent.two@example.com" }, "CONTACT_NOT_ALLOWED", undefined],
			["a phone", { reason: "Broker called from +1 555 010 0175" }, "CONTACT_NOT_ALLOWED", undefined],
		];
		const got = [];
		for (const mode of ["restore", "create_new"]) {
			for (const [, body] of cases) {
				const r = await run(chain, SA, { params: { id: String(id) }, body: { ...(mode === "create_new" ? { mode } : {}), reason: undefined, ...body } });
				got.push([mode, r.status, r.body && r.body.code, r.body && r.body.field, r.body && r.body.reason]);
			}
		}
		eq("each bad reason refused 400, the field and why named, for Restore and Create it as new alike",
			got, ["restore", "create_new"].flatMap((mode) => cases.map(([, , code, why]) => [mode, 400, code, "reason", why])));
		eq("...nothing written, no notice", [fingerprint(db) === before, m.sent.length], [true, 0]);
		const words = await run(chain, SA, { params: { id: String(id) }, body: { reason: "ok" } });
		const contactWords = await run(chain, SA, { params: { id: String(id) }, body: { reason: "Per agent.two@example.com" } });
		eq("...in plain words", [words.body && words.body.error, contactWords.body && contactWords.body.error], [
			"A reason of 3 to 500 characters is required: it is saved in the audit trail and sent to the Super Admins. Nothing was changed.",
			"The reason can't hold an email address or a phone number. Nothing was changed."]);
		const spaced = await run(chain, SA, { params: { id: String(id) }, body: { reason: "  Re-booked\nby the broker​  " } });
		const row = db.prepare("SELECT details FROM audit_trail WHERE action = 'restore_load' AND entity_id = 'lx-6401'").get() || {};
		eq("a good reason: trimmed and cleaned the audit trail's way, then saved", [spaced.status, (row.details || "").endsWith("Reason: Re-booked by the broker")], [200, true]);
	}
}

main()
	.catch((e) => ok("the runner finished", false, e && e.stack))
	.finally(async () => {
		fs.rmSync(tmp, { recursive: true, force: true });
		await R.finish();
	});
