#!/usr/bin/env node
/**
 * Restoring a soft-deleted load (the restore plan of 2026-10-22, Revision 2,
 * section 9): the payout ledger before and after a restore, and the month close.
 *   14  Later open months (M1): with the ledger day-once rule on from October, a
 *       deleted October load that pays a driver-day a November load also pays.
 *       Restoring it lists October (revenue up, its days added) AND November (the
 *       shared day leaves it, and its payable after carry-forward moves, because
 *       October's loss changes), for the investor, the company and the fleet.
 *       The "after" figures are the ledger of a database where the delete row
 *       was really removed; a changed closed month is named.
 *   15  Write-free (M2): the before/after ledger writes nothing: every table is
 *       byte-identical, reconcileInvestorPayouts() and logAudit() are never
 *       called; without deletedIds the ledger reads the stored set as before,
 *       and a deletedIds that is not a Set is refused.
 *   16  Close race (L1, decision 14): a restore (or a delete) that commits while
 *       the close computes makes it close nothing (retry "changed"), even with no
 *       Job Tracking cache invalidation; the next pass freezes figures that
 *       include (or leave out) the load.
 * And the routes (GET .../restore-preview, POST .../restore, the Deleted loads
 * list, the dispatch notice list, New Job's duplicate message):
 *   1   an open month restores: the delete rows go, one audit row, one notice,
 *       the cache invalidated in the commit's tick, the list's history
 *   2   a closed month: 409 PERIOD_FINALIZED, as the delete words it
 *   3   unreadable locks, sheet, dates or trip history; an open + closed span
 *   3b-3d  a trip day in a closed month; a later closed month (decision 13);
 *       a delete record naming a closed month the row no longer names (12)
 *   4   a month closed during the read; the write re-checks
 *   5   no row; two delete rows of one load ("x" and "#X")
 *   6   a second POST; a delete landing during the read
 *   7   roles, signed out, cross-origin
 *   8   the reason (3-500 characters, never cut, no contact) and confirm
 *   9   the flag off
 *   10  a paid payout for the month
 *   11  the preview's invoices, row, in-flight note, duplicates, fingerprint
 *   12  money: revenue moves, every other table byte-identical
 *   13  notices carry no reason, and withhold a Load ID from a Dispatcher
 *   15b the switch-on report reads only, and agrees with the preview
 *   17  New Job's duplicate message by role (decision 11)
 *
 * The code runs lifted from server.js (scripts/lib/server-lift.js closure()), on
 * the in-memory database scripts/lib/work-days-world.js builds from server.js's
 * own DDL, with one Job Tracking sheet and a clock the case sets. Made-up data
 * only. Pure: no server, no app.db, no network.
 * Run: node scripts/test-deleted-load-restore.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const path = require("path");
const { createRequire } = require("module");
const W = require("./lib/work-days-world");
const { closure } = require("./lib/server-lift");

const ONCE = { LEDGER_DAY_ONCE_ENABLED: "true", LEDGER_DAY_ONCE_FROM: "2026-10" };
const has = (name) => W.SRC.includes(`\nasync function ${name}(`) || W.SRC.includes(`\nfunction ${name}(`);
// The restore's ledger functions, lifted once server.js has them; until then each
// case that needs one fails on its own with "... is not in server.js yet".
const RESTORE_FNS = ["restoreLedgerSnapshot", "restoreLedgerChanges"].filter(has);
const READ_ROOTS = ["computeFleetLedger", "computeInvestorMonthlyEarnings", "computeLossCarryForward", "listSettlableInvestors", "getCarrierDBFromSQLite",
	"getInvestorDriverSet", "findCol", "getDeletedLoadIds", "parseSheet", "deduplicateLoads", ...RESTORE_FNS];
const CLOSE_ROOTS = [...READ_ROOTS, "finalizePeriods", "installPeriodLockTriggers"];
const BASE_PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "requireRole", "requireAuth", "refuseCrossOrigin",
	"notifyChange", "logAudit", "getJobTrackingCached", "getSheets", "SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "renderPolicy", "fs",
	"DATA_DIR", "fetch", "io", "sendEmail"];
const DENIED = ["server", "transporter", "getDrive", "KEY_FILE"];

// Two lifts: the read path (reconcileInvestorPayouts() provided as a recording
// stub, so a call to it is counted instead of run) and the close (the real one).
const LIFTS = new Map();
function lift(kind) {
	if (LIFTS.has(kind)) return LIFTS.get(kind);
	const close = kind === "close";
	const provided = [...BASE_PROVIDED, ...(close ? [] : ["reconcileInvestorPayouts"])];
	const l = closure(W.SRC, { roots: close ? CLOSE_ROOTS : READ_ROOTS, provided, denied: DENIED });
	const out = { ...l, provided, returned: close ? CLOSE_ROOTS : READ_ROOTS };
	LIFTS.set(kind, out);
	return out;
}

// The lifted server for a world from W.startWorld(): `env` is what it boots with.
// world.onRead(stack), when set, runs at each Job Tracking read, before the read
// answers (the stack names the caller).
function serverFor(world, env, kind = "read") {
	const L = lift(kind);
	const calls = { reconcile: 0, logAudit: 0, notifyChange: 0 };
	const clock = world.clock;
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [clock.ms])); }
		static now() { return clock.ms; }
	}
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const quiet = { log() {}, info() {}, error() {}, warn() {} };
	const deps = {
		db: world.db,
		require: createRequire(path.join(W.ROOT, "server.js")),
		console: quiet,
		process: { env: { ...env }, argv: [], cwd: () => W.ROOT, pid: 4242 },
		__dirname: W.ROOT,
		Date: FixedDate,
		app: { get() {}, put() {}, post() {}, delete() {}, use() {} },
		requireRole: pass,
		requireAuth: pass(),
		refuseCrossOrigin: pass(),
		notifyChange: () => { calls.notifyChange++; },
		logAudit: () => { calls.logAudit++; },
		getJobTrackingCached: null,
		getSheets: async () => { throw new Error("no Sheets in a test"); },
		SPREADSHEET_ID: "test-sheet",
		REPLICA: null,
		SHEET_TARGET: null,
		renderPolicy: async () => Buffer.from("%PDF-stub"),
		fs: { existsSync: () => false, mkdirSync() {}, readFileSync: () => "", writeFileSync() {}, renameSync() {}, unlinkSync() {} },
		DATA_DIR: "/nonexistent-restore",
		fetch: () => { throw new Error("no network in a test"); },
		io: null,
		sendEmail: async () => undefined,
	};
	if (L.provided.includes("reconcileInvestorPayouts")) deps.reconcileInvestorPayouts = async () => { calls.reconcile++; throw new Error("reconcileInvestorPayouts() called on the read path"); };
	const body = [
		'"use strict";',
		L.text,
		"getJobTrackingCached = async () => { __onRead(); const p = parseSheet({ values: __sheet() }); p.data = deduplicateLoads(p.data, p.headers); return p; };",
		`return { ${L.returned.join(", ")} };`,
	].join("\n");
	const onRead = () => { if (world.onRead) world.onRead(String(new Error("read").stack)); };
	const api = new Function(...Object.keys(deps), "__sheet", "__onRead", body)(...Object.values(deps), () => W.sheetValues(world.rows), onRead);
	const need = (name) => {
		if (typeof api[name] !== "function") throw new Error(`${name}() is not in server.js yet`);
		return api[name];
	};
	return { api, calls, need };
}

// ── the routes (cases 1-13, 17) ──────────────────────────────────────────────
// The two restore routes, the Deleted loads list and the dispatch notice list,
// lifted with everything they reach. requireRole, refuseCrossOrigin and
// logAudit run as shipped; the Job Tracking read, the cache invalidation, the
// sockets and reconcileInvestorPayouts() (which must never run) are recorded.
const ROUTE_KEYS = {
	preview: ["get", "/api/admin/deleted-loads/:id/restore-preview"],
	restore: ["post", "/api/admin/deleted-loads/:id/restore"],
	list: ["get", "/api/admin/deleted-loads"],
	notices: ["get", "/api/dispatch-notifications"],
};
const ROUTE_ROOTS = [...READ_ROOTS, "excludeDroppedLoads", "restorePlanFor", "commitRestore"];
const ROUTE_PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "notifyChange", "getJobTrackingCached", "getSheets",
	"SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "renderPolicy", "fs", "DATA_DIR", "fetch", "io", "sendEmail", "jtCacheInvalidate",
	"reconcileInvestorPayouts", "requireAuth"];
const srcLines = (src) => src.split("\n");
function routeHeadIn(src, method, p) {
	const heads = srcLines(src).filter((l) => l.startsWith(`app.${method}(${JSON.stringify(p)},`));
	if (heads.length !== 1) throw new Error(`${method.toUpperCase()} ${p} is not in server.js yet`);
	return heads[0];
}
const ROUTE_LIFTS = new Map();
function routeLift(extra = []) {
	const k = extra.map(([m, p]) => `${m} ${p}`).join("|");
	if (ROUTE_LIFTS.has(k)) return ROUTE_LIFTS.get(k);
	const heads = [...Object.values(ROUTE_KEYS), ...extra].map(([m, p]) => routeHeadIn(W.SRC, m, p));
	// An extra route (New Job) reaches the Drive client: supplied as a stub that
	// refuses, never lifted.
	const provided = extra.length ? [...ROUTE_PROVIDED, "getDrive"] : ROUTE_PROVIDED;
	const denied = extra.length ? DENIED.filter((n) => n !== "getDrive") : DENIED;
	const l = { ...closure(W.SRC, { roots: ROUTE_ROOTS, routes: heads, provided, denied }), provided };
	ROUTE_LIFTS.set(k, l);
	return l;
}

// The lifted routes for a world from routeWorld(). s.calls records the cache
// invalidations (each with whether a microtask ran since the restore's delete:
// the commit and the invalidation must share one tick), the socket emits and
// notifyChange().
function routeServer(world, { extra = [] } = {}) {
	const L = routeLift(extra);
	const calls = { reconcile: 0, notifyChange: 0, invalidate: [], emits: [] };
	const routes = {};
	const reg = (m) => (p, ...chain) => { routes[`${m} ${p}`] = chain; };
	const clock = world.clock;
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [clock.ms])); }
		static now() { return clock.ms; }
	}
	const quiet = { log() {}, info() {}, error() {}, warn() {} };
	const emitter = (room) => ({
		emit: (ev, payload) => calls.emits.push({ room, ev, payload: JSON.parse(JSON.stringify(payload)) }),
		except: (other) => ({ emit: (ev, payload) => calls.emits.push({ room: `${room} except ${other}`, ev, payload: JSON.parse(JSON.stringify(payload)) }) }),
	});
	const deps = {
		db: world.db,
		require: createRequire(path.join(W.ROOT, "server.js")),
		console: quiet,
		process: { env: { ...world.env }, argv: [], cwd: () => W.ROOT, pid: 4242 },
		__dirname: W.ROOT,
		Date: FixedDate,
		app: { get: reg("GET"), post: reg("POST"), put: reg("PUT"), delete: reg("DELETE"), use() {} },
		notifyChange: () => { calls.notifyChange++; },
		getJobTrackingCached: null,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: W.sheetValues(world.rows) } }) } } }),
		SPREADSHEET_ID: "test-sheet",
		REPLICA: null,
		SHEET_TARGET: null,
		renderPolicy: async () => Buffer.from("%PDF-stub"),
		fs: { existsSync: () => false, mkdirSync() {}, readFileSync: () => "", writeFileSync() {}, renameSync() {}, unlinkSync() {} },
		DATA_DIR: "/nonexistent-restore",
		fetch: () => { throw new Error("no network in a test"); },
		io: { to: emitter },
		sendEmail: async () => undefined,
		jtCacheInvalidate: () => calls.invalidate.push({ sameTick: world.marker.pending, deleteRowsLeft: world.db.prepare("SELECT COUNT(*) AS n FROM deleted_loads").get().n }),
		reconcileInvestorPayouts: async () => { calls.reconcile++; throw new Error("reconcileInvestorPayouts() called by a restore route"); },
		requireAuth: (req, res, next) => (next ? next() : undefined),
	};
	if (L.provided.includes("getDrive")) deps.getDrive = async () => { throw new Error("no Drive in a test"); };
	const body = [
		'"use strict";',
		L.text,
		"getJobTrackingCached = async () => { __onRead(); const p = parseSheet({ values: __sheet() }); p.data = deduplicateLoads(p.data, p.headers); return p; };",
		`return { ${ROUTE_ROOTS.join(", ")} };`,
	].join("\n");
	const onRead = () => { world.reads = (world.reads || 0) + 1; if (world.onRead) world.onRead(); };
	const api = new Function(...Object.keys(deps), "__sheet", "__onRead", body)(...Object.values(deps), () => W.sheetValues(world.rows), onRead);
	return { api, calls, routes };
}

// One request through a route's whole chain, middleware first, as Express runs it.
async function hit(s, key, { user = USERS.super, params = {}, body = {}, headers = {} } = {}) {
	const chain = s.routes[key];
	if (!chain) throw new Error(`${key} is not registered`);
	const [method, p] = key.split(" ");
	const h = { "x-requested-with": "XMLHttpRequest", ...headers };
	const req = {
		method, path: p, url: p, originalUrl: p, route: { path: p }, params, query: {}, body, headers: h, ip: "127.0.0.1",
		session: user ? { user: { ...user } } : {}, get(name) { return h[String(name).toLowerCase()]; },
	};
	const out = { status: 200, body: undefined, reached: false };
	const res = {
		status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, send(b) { out.body = b; return res; },
		set() { return res; }, setHeader() {}, end() { return res; }, on() {},
	};
	for (const mw of chain.slice(0, -1)) {
		let nexted = false;
		await mw(req, res, () => { nexted = true; });
		if (!nexted) return out;
	}
	out.reached = true;
	await chain[chain.length - 1](req, res);
	return out;
}

const USERS = {
	super: { id: 1, role: "Super Admin", username: "super_admin" },
	dispatcher: { id: 2, role: "Dispatcher", username: "dispatch_test" },
	driver: { id: 3, role: "Driver", username: "driver_test", driverName: "Ann Ames" },
	investor: { id: 5, role: "Investor", username: "inv5" },
};
const PREVIEW = "GET /api/admin/deleted-loads/:id/restore-preview";
const RESTORE = "POST /api/admin/deleted-loads/:id/restore";
const preview = (s, id, opts = {}) => hit(s, PREVIEW, { params: { id: String(id) }, ...opts });
const restore = (s, id, body, opts = {}) => hit(s, RESTORE, { params: { id: String(id) }, body, ...opts });
const REASON = "Deleted by mistake";
// The preview, then a restore confirming its fingerprint.
async function previewThenRestore(s, id, extra = {}) {
	const p = await preview(s, id);
	const r = await restore(s, id, { confirm: true, reason: REASON, fingerprint: p.body && p.body.fingerprint, ...extra });
	return { p, r };
}

// ── the fixtures ─────────────────────────────────────────────────────────────
const ANN = "Ann Ames";   // investor 5's driver (Acme Carrier), truck T1
const CARA = "Cara Pike"; // a company driver (no carrier), truck C9
const BO = "Bo Reyes";    // investor 5's second driver, truck T2
const ON = { RESTORE_DELETED_LOADS_ENABLED: "true" };
const NOW_OCT20 = Date.parse("2026-10-20T17:00:00Z");

// A world for the routes: `deleted` [{ id, row, at, by }] are the delete rows to
// store, `audits` [[entityId, details, timestamp]] the delete_load audit rows.
// world.marker.pending is true from a deleted_loads delete until the next
// microtask runs.
function routeWorld({ rows, deleted = [], audits = [], locks = [], env = {}, status = [], now = NOW_OCT20, drivers = null, trucks = null } = {}) {
	const fullEnv = { ...ON, ...env };
	const w = W.startWorld({
		env: fullEnv, now, locks, rows, status,
		drivers: drivers || [{ name: ANN }, { name: BO }],
		trucks: trucks || [{ unit: "T1", driver: ANN, owner: 5 }, { unit: "T2", driver: BO, owner: 5 }],
	});
	w.env = fullEnv;
	const del = w.db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_at, deleted_by) VALUES (?, ?, ?, ?)");
	for (const d of deleted) del.run(d.id, d.row || 0, d.at || "2026-10-15 14:00:00", d.by || "super_admin");
	const audit = w.db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 1, 'super_admin', 'Super Admin', 'delete_load', 'load', ?, ?)");
	for (const [entityId, details, at] of audits) audit.run(at || "2026-10-15T14:00:00.200Z", entityId, details);
	w.marker = { pending: false };
	w.db.function("restore_mark", () => {
		w.marker.pending = true;
		queueMicrotask(() => { w.marker.pending = false; });
		return 0;
	});
	w.db.exec("CREATE TEMP TRIGGER restore_mark_t AFTER DELETE ON deleted_loads BEGIN SELECT restore_mark(); END");
	return w;
}
const idOf = (w, loadId) => (w.db.prepare("SELECT id FROM deleted_loads WHERE load_id = ? ORDER BY id").get(loadId) || {}).id;
const deleteRows = (w) => w.db.prepare("SELECT load_id FROM deleted_loads ORDER BY id").all().map((r) => r.load_id);
const auditsOf = (w, action) => w.db.prepare("SELECT entity_id, username, role, details FROM audit_trail WHERE action = ? ORDER BY id").all(action);
const noticesOf = (w) => w.db.prepare("SELECT type, title, body, metadata FROM dispatch_notifications WHERE type = 'load-restored' ORDER BY id").all();
const verdict = (r) => `${r.status} ${(r.body && r.body.code) || ""}${r.body && Array.isArray(r.body.periods) && r.body.periods.length ? ` ${r.body.periods.join(",")}` : ""}`.trim();
const row = (o) => W.loadRow({ truck: "T1", owner: "5", ...o });
// The trip work-day rule's no-Assigned-Date load (scripts/test-trip-work-days-month-lock.js
// L4): window 10/1-10/2, the drive to the pickup on Wed 9/30, deleted.
const tripStatus = (lid, status, wall, source = "manual", actor = ANN) => [lid, status, source, W.et(wall), actor];
function noAssignedTrip() {
	return {
		rows: [row({ id: "L401", driver: ANN, pickup: "2026-10-01 8:00", dropoff: "2026-10-02 18:00", assigned: "", done: "2026-10-02" })],
		status: [tripStatus("L401", "Dispatched", "2026-09-29 08:00", "dispatch", "super_admin"), tripStatus("L401", "Heading to Shipper", "2026-09-30 09:00"),
			tripStatus("L401", "At Shipper", "2026-10-01 08:00"), tripStatus("L401", "Delivered", "2026-10-02 12:00")],
		deleted: [{ id: "l401", row: 2 }],
		now: Date.parse("2026-11-20T17:00:00Z"),
	};
}
const NOW_DEC = Date.parse("2026-12-05T17:00:00Z");

// Test 14's world. Ann's October load RS-OCT (deleted, stored as "rs-oct") pays
// 10/30 and 10/31; her November load RS-NOV pays 10/31, 11/1 and 11/2. RS-OCT0
// (live, 10/5) keeps October in investor 5's ledger either way (a ledger starts
// at its earliest Assigned month), and a $2,000 October receipt on T1 makes
// October a loss either way. The company's RS-CO (deleted under the older
// spelling "#rs-co") and RS-CO2 (live) are Cara's October loads. `deleted` lists
// the delete rows to store.
function restoreWorld({ deleted = ["rs-oct", "#rs-co"], locks = [] } = {}) {
	const w = W.startWorld({
		env: ONCE,
		now: NOW_DEC,
		drivers: [{ name: ANN }, { name: CARA, carrier: "" }],
		trucks: [{ unit: "T1", driver: ANN, owner: 5 }, { unit: "C9", driver: CARA, owner: 0 }],
		locks,
		rows: [
			W.loadRow({ id: "RS-OCT0", driver: ANN, pickup: "2026-10-05 8:00", dropoff: "2026-10-05 18:00", assigned: "2026-10-05", done: "2026-10-05", truck: "T1", owner: "5", payment: "$300.00" }),
			W.loadRow({ id: "RS-OCT", driver: ANN, pickup: "2026-10-30 8:00", dropoff: "2026-10-31 18:00", assigned: "2026-10-30", done: "2026-10-31", truck: "T1", owner: "5", payment: "$500.00" }),
			W.loadRow({ id: "RS-NOV", driver: ANN, pickup: "2026-10-31 8:00", dropoff: "2026-11-02 18:00", assigned: "2026-11-01", done: "2026-11-02", truck: "T1", owner: "5", payment: "$3,000.00" }),
			W.loadRow({ id: "RS-CO", driver: CARA, pickup: "2026-10-14 8:00", dropoff: "2026-10-15 18:00", assigned: "2026-10-14", done: "2026-10-15", truck: "C9", owner: "0", payment: "$1,200.00" }),
			W.loadRow({ id: "RS-CO2", driver: CARA, pickup: "2026-10-20 8:00", dropoff: "2026-10-20 18:00", assigned: "2026-10-20", done: "2026-10-20", truck: "C9", owner: "0", payment: "$900.00" }),
		],
	});
	w.db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, status, owner_id, truck_unit) VALUES ('2026-10-15T17:00:00.000Z', ?, 'Repair', 2000, '2026-10-15', 'Approved', 5, 'T1')").run(ANN);
	const del = w.db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_by) VALUES (?, 0, 'super_admin')");
	for (const id of deleted) del.run(id);
	return w;
}

// One change row's figures as [before, after, change], to the cent.
const fig = (f) => (f ? [f.before, f.after, f.change] : null);
const rowOf = (list, ownerId, month) => (list || []).find((r) => r.ownerId === ownerId && r.month === month) || null;
const fleetOf = (list, month) => (list || []).find((r) => r.month === month) || null;
// A ledger snapshot's figures, for comparing two runs.
const figures = (snap) => JSON.stringify({
	scopes: snap.scopes.map((s) => ({ ownerId: s.ownerId, months: s.months, items: s.items, dayOnceDrops: s.dayOnceDrops || [] })),
	payable: snap.payable,
});

const R = W.createRunner("Restore a deleted load: the ledger before and after, and the month close");

(async () => {
	await R.test("14 Later open months: restoring October's RS-OCT lists investor 5's October (revenue +$500, two days +$520) and November (10/31 leaves it under day-once, payable +$120 after carry-forward), the fleet totals, and no company change; the company's own restore lists the company's October", async ({ eq, ok }) => {
		const w = restoreWorld();
		const s = serverFor(w, ONCE);
		// The plumbing first: computeFleetLedger() with the load's delete row left
		// out of deletedIds = computeFleetLedger() on a database where that row was
		// really removed (the default path, no deletedIds).
		const removed = restoreWorld({ deleted: ["#rs-co"] });
		const sr = serverFor(removed, ONCE);
		const kept = new Set(["#rs-co"]);
		const viaOption = JSON.stringify((await s.api.computeFleetLedger({ deletedIds: kept })).scopes);
		ok("computeFleetLedger({ deletedIds }) = computeFleetLedger() with the row really removed", viaOption === JSON.stringify((await sr.api.computeFleetLedger()).scopes));
		ok("...which counts RS-OCT", /"RS-OCT"/.test(viaOption));

		const lib = W.requireLib("deleted-load-restore");
		const res = await s.need("restoreLedgerChanges")("RS-OCT");
		eq("the key", res.key, "rs-oct");
		// Investor 5 at 50%, $260 a day. Before: October $300 - $260 - $2,000 =
		// -$1,960 (half, $980, carried); November $3,000 - 3 days = $2,220, half
		// $1,110, pays $130. After: October $800 - 3 days - $2,000 = -$1,980 ($990
		// carried); November loses 10/31 to October: $3,000 - 2 days = $2,480, half
		// $1,240, pays $250.
		eq("investor 5, October: revenue, driver pay, raw result, payable [before, after, change]",
			[fig(rowOf(res.scopes, 5, "2026-10")?.revenue), fig(rowOf(res.scopes, 5, "2026-10")?.driverPay), fig(rowOf(res.scopes, 5, "2026-10")?.raw), fig(rowOf(res.scopes, 5, "2026-10")?.payable)],
			[[300, 800, 500], [260, 780, 520], [-1960, -1980, -20], [0, 0, 0]]);
		eq("investor 5, November: revenue, driver pay, raw result, payable",
			[fig(rowOf(res.scopes, 5, "2026-11")?.revenue), fig(rowOf(res.scopes, 5, "2026-11")?.driverPay), fig(rowOf(res.scopes, 5, "2026-11")?.raw), fig(rowOf(res.scopes, 5, "2026-11")?.payable)],
			[[3000, 3000, 0], [780, 520, -260], [2220, 2480, 260], [130, 250, 120]]);
		eq("only investor 5's October and November change (no company row, no December)", res.scopes.map((r) => `${r.ownerId} ${r.month}`), ["5 2026-10", "5 2026-11"]);
		// The fleet is the sum of its scopes: the company's live RS-CO2 ($900, one
		// day) is in October on both sides.
		eq("the fleet: October and November", res.fleet.map((r) => [r.month, fig(r.revenue), fig(r.driverPay), fig(r.raw)]), [
			["2026-10", [1200, 1700, 500], [520, 1040, 520], [-1320, -1340, -20]],
			["2026-11", [3000, 3000, 0], [780, 520, -260], [2220, 2480, 260]],
		]);
		eq("the driver-day that moves: 10/31 leaves November for October", res.dayOnce.added.map((d) => [d.ownerId, d.driver, d.day, d.month, d.keptMonth, d.loadId, d.keptLoadId]),
			[[5, "ann ames", "2026-10-31", "2026-11", "2026-10", "RS-NOV", "RS-OCT"]]);
		eq("no day stops moving", res.dayOnce.removed, []);
		eq("no closed month changes", res.closedMonths, []);

		// The company's own load, stored under "#rs-co": the delete row matches by
		// normalizeLoadId(), so it comes back with its key.
		const co = await s.need("restoreLedgerChanges")("rs-co");
		eq("company, October: revenue, driver pay, raw result; no payable", [fig(rowOf(co.scopes, 0, "2026-10")?.revenue), fig(rowOf(co.scopes, 0, "2026-10")?.driverPay), fig(rowOf(co.scopes, 0, "2026-10")?.raw), rowOf(co.scopes, 0, "2026-10")?.payable],
			[[900, 2100, 1200], [260, 780, 520], [640, 1320, 680], null]);
		eq("only the company's October changes", co.scopes.map((r) => `${r.ownerId} ${r.month}`), ["0 2026-10"]);
		eq("the fleet's October moves with it", co.fleet.map((r) => [r.month, fig(r.revenue)]), [["2026-10", [1200, 2400, 1200]]]);

		// The figures equal the ledger of a database where the delete row was really
		// removed (the default path, no deletedIds), and "before" is today's.
		const after = await s.need("restoreLedgerSnapshot")({ deletedIds: kept });
		const real = await sr.need("restoreLedgerSnapshot")({});
		ok("after = the ledger with the row really removed (every scope's months, items, day-once drops and payable)", figures(after) === figures(real), `${figures(after).slice(0, 300)}\n             ${figures(real).slice(0, 300)}`);
		const before = await s.need("restoreLedgerSnapshot")({});
		eq("the change list is the pure differ's over those two ledgers", res.scopes, lib.ledgerChanges({ before, after: real, isClosed: () => false }).scopes);

		// October closed: the restore would change it, so it is named.
		const locked = restoreWorld({ locks: ["2026-10"] });
		const closedRes = await serverFor(locked, ONCE).need("restoreLedgerChanges")("RS-OCT");
		eq("a closed October that would change is named", closedRes.closedMonths, ["2026-10"]);
		ok("...and its rows say closed", rowOf(closedRes.scopes, 5, "2026-10")?.closed === true && fleetOf(closedRes.fleet, "2026-10")?.closed === true && rowOf(closedRes.scopes, 5, "2026-11")?.closed === false, JSON.stringify(closedRes.scopes));
	});

	await R.test("15 Write-free: the before/after ledger leaves every table byte-identical and never calls reconcileInvestorPayouts() or logAudit(); without deletedIds the stored set is read as before; a deletedIds that is not a Set is refused", async ({ eq, ok }) => {
		const w = restoreWorld();
		// Rows a write would touch: an owed payout, its history, an audit row.
		w.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (5, '2026-10', 0, '2026-11-27', 'owed')").run();
		w.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (5, '2026-11', 110, '2026-12-25', 'owed')").run();
		w.db.prepare("INSERT INTO investor_payout_history (payout_id, owner_id, period, kind, old_amount, new_amount, detail, actor) VALUES (2, 5, '2026-11', 'recompute', 0, 110, 'test', 'test')").run();
		w.db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES ('2026-11-03T15:00:00.000Z', 1, 'super_admin', 'Super Admin', 'delete_load', 'load', 'rs-oct', 'test')").run();
		const s = serverFor(w, ONCE);
		const hashes = W.tableHashes(w.db);

		const stored = s.api.getDeletedLoadIds({ strict: true });
		const plain = JSON.stringify(await s.api.computeFleetLedger());
		ok("without deletedIds = with the stored set", plain === JSON.stringify(await s.api.computeFleetLedger({ deletedIds: stored })));
		ok("...and RS-OCT stays out of it", !/"RS-OCT"/.test(plain));
		let refused = "";
		try { await s.api.computeFleetLedger({ deletedIds: ["rs-oct"] }); } catch (e) { refused = e.message; }
		ok("an array for deletedIds is refused, never read as \"use the stored set\"", /deletedIds/.test(refused), refused);

		const res = await s.need("restoreLedgerChanges")("RS-OCT");
		await s.need("restoreLedgerSnapshot")({ deletedIds: new Set() });
		ok("the run saw the restore (investor 5's November payable moves)", fig(rowOf(res.scopes, 5, "2026-11")?.payable)?.[2] === 120, JSON.stringify(res.scopes));
		const after = W.tableHashes(w.db);
		eq("every table byte-identical", Object.keys(hashes).filter((t) => hashes[t] !== after[t]), []);
		eq("reconcileInvestorPayouts(), logAudit(), notifyChange() calls", [s.calls.reconcile, s.calls.logAudit, s.calls.notifyChange], [0, 0, 0]);
	});

	await R.test("16 Close race: a restore committed while September's close computes (no cache invalidation) makes it close nothing (retry \"changed\"); the next pass freezes September with the load; a delete in the same window does the same", async ({ eq, ok }) => {
		const NOW_OCT = Date.parse("2026-10-20T17:00:00Z");
		const septWorld = (deleted) => {
			const w = W.startWorld({
				now: NOW_OCT,
				drivers: [{ name: ANN }],
				trucks: [{ unit: "T1", driver: ANN, owner: 5 }],
				rows: [
					W.loadRow({ id: "RC-1", driver: ANN, pickup: "2026-09-08 8:00", dropoff: "2026-09-09 18:00", assigned: "2026-09-08", done: "2026-09-09", truck: "T1", owner: "5", payment: "$2,000.00" }),
					W.loadRow({ id: "RC-2", driver: ANN, pickup: "2026-09-15 8:00", dropoff: "2026-09-16 18:00", assigned: "2026-09-15", done: "2026-09-16", truck: "T1", owner: "5", payment: "$1,000.00" }),
				],
			});
			for (const id of deleted) w.db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_by) VALUES (?, 3, 'super_admin')").run(id);
			return w;
		};
		const lockOf = (w) => w.db.prepare("SELECT status FROM period_locks WHERE period = '2026-09'").get() || null;
		const payout = (w) => w.db.prepare("SELECT amount, finalized_at, finalized_amount FROM investor_payouts WHERE owner_id = 5 AND period = '2026-09'").get() || null;
		const septItems = (w) => w.db.prepare("SELECT kind, load_id FROM financials_ledger_items WHERE period = '2026-09' AND kind = 'revenue' ORDER BY load_id").all().map((r) => r.load_id);
		// The write lands at the close's last sheet read (the Financials items'
		// fleet ledger), after the payout reconcile has read the deleted set.
		const during = (w, sql) => {
			const state = { fired: false };
			w.onRead = (stack) => {
				if (state.fired || !/\bclosingLedgerItems\b/.test(stack)) return;
				state.fired = true;
				w.db.prepare(sql).run();
			};
			return state;
		};

		// Restore: RC-2 ($1,000; 9/15 and 9/16) comes back mid-close.
		const w = septWorld(["rc-2"]);
		const s = serverFor(w, {}, "close");
		s.api.installPeriodLockTriggers(w.db);
		const hook = during(w, "DELETE FROM deleted_loads WHERE load_id = 'rc-2'");
		const first = await s.api.finalizePeriods(["2026-09"], "system");
		ok("the restore landed inside the close", hook.fired === true);
		eq("first pass: closes nothing, retry \"changed\"", [first.retry === true, first.reason, first.periods], [true, "changed", []]);
		ok("...no lock, no stamp, no frozen items", !lockOf(w) && payout(w) && !payout(w).finalized_at && septItems(w).length === 0, JSON.stringify({ lock: lockOf(w), payout: payout(w), items: septItems(w) }));
		w.onRead = null;
		const second = await s.api.finalizePeriods(["2026-09"], "system");
		eq("next pass: September closes", [second.periods, lockOf(w) && lockOf(w).status], [["2026-09"], "locked"]);
		eq("...frozen with RC-2: $3,000 revenue less four days at $260 = $1,960, half is $980", payout(w) && payout(w).finalized_amount, 980);
		eq("...and both loads' revenue items", septItems(w), ["RC-1", "RC-2"]);

		// Delete: RC-2 goes mid-close (the same gap, finding F6).
		const d = septWorld([]);
		const sd = serverFor(d, {}, "close");
		sd.api.installPeriodLockTriggers(d.db);
		const dHook = during(d, "INSERT INTO deleted_loads (load_id, row_index, deleted_by) VALUES ('rc-2', 3, 'super_admin')");
		const dFirst = await sd.api.finalizePeriods(["2026-09"], "system");
		ok("the delete landed inside the close", dHook.fired === true);
		eq("delete, first pass: closes nothing, retry \"changed\"", [dFirst.retry === true, dFirst.reason, dFirst.periods], [true, "changed", []]);
		d.onRead = null;
		await sd.api.finalizePeriods(["2026-09"], "system");
		eq("delete, next pass: frozen without RC-2 ($2,000 less two days = $1,480, half is $740)", [lockOf(d) && lockOf(d).status, payout(d) && payout(d).finalized_amount, septItems(d)], ["locked", 740, ["RC-1"]]);
	});

	await R.test("1 Open month: the preview can restore; the POST removes the key's delete row, the load is live again, one restore_load audit row (reason, month, removed id), one load-restored notice, the cache invalidated in the commit's tick; the list shows the restore", async ({ eq, ok }) => {
		const w = routeWorld({
			rows: [row({ id: "RL-1", driver: ANN, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-06", done: "2026-10-07", payment: "$1,000.00" })],
			deleted: [{ id: "rl-1", row: 2 }],
		});
		const s = routeServer(w);
		const id = idOf(w, "rl-1");
		const { p, r } = await previewThenRestore(s, id);
		eq("preview: 200, can restore, October open", [p.status, p.body && p.body.canRestore, p.body && p.body.months], [200, true, [{ month: "2026-10", closed: false, pending: false }]]);
		ok("preview: a fingerprint", typeof (p.body && p.body.fingerprint) === "string" && p.body.fingerprint.length >= 16, JSON.stringify(p.body).slice(0, 300));
		eq("restore: 200", [r.status, r.body && r.body.success], [200, true]);
		eq("no delete row left", deleteRows(w), []);
		const parsed = s.api.parseSheet({ values: W.sheetValues(w.rows) });
		ok("excludeDroppedLoads() keeps RL-1 again", s.api.excludeDroppedLoads(parsed.data, parsed.headers).some((x) => x["Load ID"] === "RL-1"));
		const audits = auditsOf(w, "restore_load");
		eq("one restore_load row, keyed like the delete", audits.map((a) => [a.entity_id, a.username, a.role]), [["rl-1", "super_admin", "Super Admin"]]);
		ok("...naming the month, the removed delete record and the reason", audits.length === 1 && audits[0].details.includes("2026-10") && audits[0].details.includes(`removed delete record ${id} `) && audits[0].details.endsWith(`Reason: ${REASON}`), audits[0] && audits[0].details);
		eq("one load-restored notice", noticesOf(w).map((n) => [n.title, n.body]), [["Restored Load RL-1", "Restored by super_admin"]]);
		eq("the cache invalidated once, after the commit, in its tick", s.calls.invalidate, [{ sameTick: true, deleteRowsLeft: 0 }]);
		eq("live notices: Super Admins and the rest of the dispatch room", s.calls.emits.map((e) => [e.room, e.ev]), [["super-admin", "dispatch-notification"], ["dispatch except super-admin", "dispatch-notification"]]);
		eq("notifyChange once; reconcile never", [s.calls.notifyChange, s.calls.reconcile], [1, 0]);
		const list = await hit(s, "GET /api/admin/deleted-loads");
		eq("the list: no deleted row, the restore in its history", [list.status, list.body && list.body.loads.length, list.body && (list.body.restored || []).map((h) => [h.loadId, h.restoredBy, h.reason, h.months])],
			[200, 0, [["rl-1", "super_admin", REASON, ["2026-10"]]]]);
		eq("the list says the restore is on", list.body && list.body.restoreEnabled, true);
		// Deleted again: the row says when it was restored before, and by whom.
		w.db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_by) VALUES ('rl-1', 2, 'super_admin')").run();
		const again = await hit(s, "GET /api/admin/deleted-loads");
		eq("a deleted-again row names its earlier restore", again.body && again.body.loads.map((l) => [l.loadId, l.restoredBefore && l.restoredBefore.by, l.restoredBefore && l.restoredBefore.day]), [["rl-1", "super_admin", "2026-10-20"]]);
	});

	await R.test("2 Closed month: 409 PERIOD_FINALIZED naming September, in the delete's words; nothing removed; restore_load_blocked audited; the preview says so", async ({ eq, ok }) => {
		const w = routeWorld({
			rows: [row({ id: "RL-2", driver: ANN, pickup: "2026-09-08 8:00", dropoff: "2026-09-09 18:00", assigned: "2026-09-08", done: "2026-09-09" })],
			deleted: [{ id: "rl-2", row: 2 }], locks: ["2026-09"],
		});
		const s = routeServer(w);
		const id = idOf(w, "rl-2");
		const p = await preview(s, id);
		eq("preview: 200, cannot restore, PERIOD_FINALIZED", [p.status, p.body && p.body.canRestore, p.body && p.body.refusal && p.body.refusal.code, p.body && p.body.fingerprint], [200, false, "PERIOD_FINALIZED", null]);
		const r = await restore(s, id, { confirm: true, reason: REASON, fingerprint: "stale" });
		eq("refused", verdict(r), "409 PERIOD_FINALIZED 2026-09");
		ok("the delete's message shape", /^Restoring load RL-2 would restate September 2026 — a month that is already finalized, .*nothing was changed\.$/.test(r.body && r.body.error), r.body && r.body.error);
		eq("nothing removed", deleteRows(w), ["rl-2"]);
		const blocked = auditsOf(w, "restore_load_blocked");
		ok("restore_load_blocked audited with the code and month", blocked.length === 1 && blocked[0].details.includes("[PERIOD_FINALIZED]") && blocked[0].details.includes("2026-09"), JSON.stringify(blocked));
		eq("no restore row, no notice", [auditsOf(w, "restore_load").length, noticesOf(w).length], [0, 0]);
	});

	await R.test("3 Unreadable or spanning: period_locks unreadable -> PERIOD_LOCK_UNREADABLE; the sheet unreadable, dates unreadable (a delete record naming a month does not help), the trip history unreadable -> PERIOD_UNRESOLVED; an open + closed span -> PERIOD_FINALIZED", async ({ eq }) => {
		const oct = () => [row({ id: "RL-3", driver: ANN, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-06", done: "2026-10-07" })];
		const go = async (w) => {
			const s = routeServer(w);
			const r = await restore(s, idOf(w, w.db.prepare("SELECT load_id FROM deleted_loads").get().load_id), { confirm: true, reason: REASON, fingerprint: "x" });
			return `${verdict(r)} | left ${deleteRows(w).length}`;
		};
		const a = routeWorld({ rows: oct(), deleted: [{ id: "rl-3", row: 2 }] });
		a.db.exec("DROP TABLE period_locks");
		eq("period_locks unreadable", await go(a), "409 PERIOD_LOCK_UNREADABLE | left 1");
		const b = routeWorld({ rows: oct(), deleted: [{ id: "rl-3", row: 2 }] });
		b.onRead = () => { throw new Error("made-up Sheets outage"); };
		eq("the sheet unreadable", await go(b), "409 PERIOD_UNRESOLVED | left 1");
		const tbd = row({ id: "RL-3", driver: ANN, done: "2026-10-07" });
		tbd["Assigned Date"] = "TBD";
		const c = routeWorld({ rows: [tbd], deleted: [{ id: "rl-3", row: 2 }], audits: [["rl-3", "Soft-deleted load RL-3 (sheet row 2) — settlement month 2026-10. Reversible: …"]] });
		eq("dates unreadable, the delete record naming October", await go(c), "409 PERIOD_UNRESOLVED | left 1");
		const TRIP = { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-09" };
		const d = routeWorld({ ...noAssignedTrip(), env: TRIP, locks: ["2026-09"] });
		d.db.exec("DROP TABLE load_status_history");
		eq("the trip rule's history unreadable", await go(d), "409 PERIOD_UNRESOLVED | left 1");
		const span = row({ id: "RL-3", driver: ANN, pickup: "2026-09-29 8:00", dropoff: "2026-10-02 18:00", assigned: "", done: "2026-10-02" });
		const e = routeWorld({ rows: [span], deleted: [{ id: "rl-3", row: 2 }], locks: ["2026-09"] });
		eq("September closed, October open: refused, never partly", await go(e), "409 PERIOD_FINALIZED 2026-09 | left 1");
	});

	await R.test("3b-3d Trip days, later months, the delete record: a trip day in closed September (no Assigned Date) -> PERIOD_FINALIZED 2026-09; November closed after October -> PERIOD_FINALIZED 2026-11; a delete record naming closed September while the row now books October -> DELETE_RECORD_MONTH_CLOSED, both lists in the preview", async ({ eq, ok }) => {
		const TRIP = { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-09" };
		const a = routeWorld({ ...noAssignedTrip(), env: TRIP, locks: ["2026-09"] });
		const sa = routeServer(a);
		eq("3b the heading day 9/30 settles in closed September", verdict(await restore(sa, idOf(a, "l401"), { confirm: true, reason: REASON, fingerprint: "x" })), "409 PERIOD_FINALIZED 2026-09");
		eq("3b nothing removed", deleteRows(a), ["l401"]);

		const b = routeWorld({
			rows: [row({ id: "RL-3C", driver: ANN, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-06", done: "2026-10-07" })],
			deleted: [{ id: "rl-3c", row: 2 }], locks: ["2026-11"], now: Date.parse("2026-12-05T17:00:00Z"),
		});
		const sb = routeServer(b);
		eq("3c October open, November closed", verdict(await restore(sb, idOf(b, "rl-3c"), { confirm: true, reason: REASON, fingerprint: "x" })), "409 PERIOD_FINALIZED 2026-11");
		eq("3c nothing removed", deleteRows(b), ["rl-3c"]);

		const c = routeWorld({
			rows: [row({ id: "RL-3D", driver: ANN, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-06", done: "2026-10-07" })],
			deleted: [{ id: "rl-3d", row: 2, at: "2026-09-20 14:00:00" }], locks: ["2026-09"],
			audits: [["rl-3d", "Soft-deleted load RL-3D (sheet row 2) — settlement month 2026-09. Reversible: …", "2026-09-20T14:00:00.300Z"]],
		});
		const sc = routeServer(c);
		const p = await preview(sc, idOf(c, "rl-3d"));
		eq("3d preview: both month lists", [p.body && p.body.months, p.body && p.body.deleteRecordMonths], [[{ month: "2026-10", closed: false, pending: false }], [{ month: "2026-09", closed: true }]]);
		const r = await restore(sc, idOf(c, "rl-3d"), { confirm: true, reason: REASON, fingerprint: "x" });
		eq("3d refused", [r.status, r.body && r.body.code], [409, "DELETE_RECORD_MONTH_CLOSED"]);
		ok("3d the message names both months", /September 2026/.test(r.body && r.body.error) && /October 2026/.test(r.body && r.body.error), r.body && r.body.error);
		eq("3d nothing removed, audited", [deleteRows(c), auditsOf(c, "restore_load_blocked").length], [["rl-3d"], 1]);
	});

	await R.test("4 A month closed during the sheet read -> PERIOD_FINALIZED, nothing removed; and the write itself re-checks: a plan made before October closed is refused at commit", async ({ eq, ok }) => {
		const rows = () => [row({ id: "RL-4", driver: ANN, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-06", done: "2026-10-07" })];
		const w = routeWorld({ rows: rows(), deleted: [{ id: "rl-4", row: 2 }] });
		const s = routeServer(w);
		const p = await preview(s, idOf(w, "rl-4"));
		let fired = false;
		w.onRead = () => { if (!fired) { fired = true; w.lock(["2026-10"]); } };
		const r = await restore(s, idOf(w, "rl-4"), { confirm: true, reason: REASON, fingerprint: p.body.fingerprint });
		eq("refused", verdict(r), "409 PERIOD_FINALIZED 2026-10");
		eq("nothing removed, no restore row", [deleteRows(w), auditsOf(w, "restore_load").length], [["rl-4"], 0]);

		const v = routeWorld({ rows: rows(), deleted: [{ id: "rl-4", row: 2 }] });
		const sv = routeServer(v);
		const plan = await sv.api.restorePlanFor(idOf(v, "rl-4"));
		ok("the plan can restore", plan && plan.canRestore === true, JSON.stringify(plan && plan.refusal));
		v.lock(["2026-10"]);
		const done = sv.api.commitRestore(plan, { session: { user: USERS.super } }, REASON);
		eq("the commit refuses", done && done.refusal && [done.refusal.code, done.refusal.periods], ["PERIOD_FINALIZED", ["2026-10"]]);
		eq("nothing removed, nothing audited, no notice", [deleteRows(v), auditsOf(v, "restore_load").length, noticesOf(v).length], [["rl-4"], 0, 0]);
	});

	await R.test("5 No row -> 409 RESTORE_NO_ROW (audited); two delete rows of one load (\"rl-5\" and \"#RL-5\") -> both removed, one audit row naming both", async ({ eq, ok }) => {
		const a = routeWorld({ rows: [row({ id: "RL-OTHER", driver: ANN, pickup: "2026-10-06 8:00", assigned: "2026-10-06" })], deleted: [{ id: "rl-gone" }] });
		const sa = routeServer(a);
		const r = await restore(sa, idOf(a, "rl-gone"), { confirm: true, reason: REASON, fingerprint: "x" });
		eq("no row", [r.status, r.body && r.body.code], [409, "RESTORE_NO_ROW"]);
		ok("...says why", /No Job Tracking row carries load rl-gone, so there is nothing to restore\. The row may have been archived, or its Load ID retyped\./.test(r.body && r.body.error), r.body && r.body.error);
		eq("nothing removed, audited", [deleteRows(a), auditsOf(a, "restore_load_blocked").length], [["rl-gone"], 1]);

		const b = routeWorld({
			rows: [row({ id: "RL-5", driver: ANN, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-06", done: "2026-10-07" })],
			deleted: [{ id: "rl-5", row: 2 }, { id: "#RL-5", row: 2, at: "2026-10-15 14:00:01" }],
		});
		const sb = routeServer(b);
		const ids = b.db.prepare("SELECT id FROM deleted_loads ORDER BY id").all().map((x) => x.id);
		const { r: rb } = await previewThenRestore(sb, ids[1]);
		eq("restored", rb.status, 200);
		eq("both delete rows gone", deleteRows(b), []);
		const audits = auditsOf(b, "restore_load");
		ok("one audit row naming both ids", audits.length === 1 && audits[0].details.includes(`removed delete records ${ids[0]}, ${ids[1]} `), JSON.stringify(audits));
	});

	await R.test("6 A second POST -> LOAD_NOT_DELETED, no second audit row or notice; a delete landing during the read -> 409 RESTORE_CONFLICT, nothing removed", async ({ eq }) => {
		const rows = () => [row({ id: "RL-6", driver: ANN, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-06", done: "2026-10-07" })];
		const a = routeWorld({ rows: rows(), deleted: [{ id: "rl-6", row: 2 }] });
		const sa = routeServer(a);
		const id = idOf(a, "rl-6");
		const { p, r } = await previewThenRestore(sa, id);
		eq("first restores", r.status, 200);
		const again = await restore(sa, id, { confirm: true, reason: REASON, fingerprint: p.body.fingerprint });
		eq("second: LOAD_NOT_DELETED", again.body && again.body.code, "LOAD_NOT_DELETED");
		eq("one audit row, one notice", [auditsOf(a, "restore_load").length, noticesOf(a).length], [1, 1]);

		const b = routeWorld({ rows: rows(), deleted: [{ id: "rl-6", row: 2 }] });
		const sb = routeServer(b);
		const bid = idOf(b, "rl-6");
		const pb = await preview(sb, bid);
		let fired = false;
		b.onRead = () => { if (!fired) { fired = true; b.db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_by) VALUES ('rl-6', 2, 'admin_two')").run(); } };
		const rb = await restore(sb, bid, { confirm: true, reason: REASON, fingerprint: pb.body.fingerprint });
		eq("conflict", [rb.status, rb.body && rb.body.code], [409, "RESTORE_CONFLICT"]);
		eq("nothing removed, no restore row, no notice", [deleteRows(b), auditsOf(b, "restore_load").length, noticesOf(b).length], [["rl-6", "rl-6"], 0, 0]);
	});

	await R.test("7 Dispatcher, Driver and Investor get 403 and signed out 401 on both routes; a cross-origin POST is refused; nothing read or written", async ({ eq }) => {
		const w = routeWorld({ rows: [row({ id: "RL-7", driver: ANN, pickup: "2026-10-06 8:00", assigned: "2026-10-06" })], deleted: [{ id: "rl-7", row: 2 }] });
		const s = routeServer(w);
		const id = idOf(w, "rl-7");
		const body = { confirm: true, reason: REASON, fingerprint: "x" };
		const got = [];
		for (const who of ["dispatcher", "driver", "investor"]) {
			got.push(`${who} ${(await preview(s, id, { user: USERS[who] })).status} ${(await restore(s, id, body, { user: USERS[who] })).status}`);
		}
		got.push(`signed out ${(await preview(s, id, { user: null })).status} ${(await restore(s, id, body, { user: null })).status}`);
		const x = await restore(s, id, body, { headers: { "sec-fetch-site": "cross-site" } });
		got.push(`cross-site ${x.status} ${x.body && x.body.code}`);
		eq("refused", got, ["dispatcher 403 403", "driver 403 403", "investor 403 403", "signed out 401 401", "cross-site 403 CROSS_SITE_REFUSED"]);
		eq("no sheet read, nothing removed, no restore row", [w.reads || 0, deleteRows(w), auditsOf(w, "restore_load").length], [0, ["rl-7"], 0]);
	});

	await R.test("8 The reason: missing, not text, 2 characters, 501 (refused, never cut), only spaces and control characters -> 400 RESTORE_REASON_REQUIRED; an email or a phone -> 400 CONTACT_NOT_ALLOWED; no confirm -> 400 CONFIRMATION_REQUIRED; 500 characters restore", async ({ eq }) => {
		const rows = () => [row({ id: "RL-8", driver: ANN, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-06", done: "2026-10-07" })];
		const w = routeWorld({ rows: rows(), deleted: [{ id: "rl-8", row: 2 }] });
		const s = routeServer(w);
		const id = idOf(w, "rl-8");
		const fp = (await preview(s, id)).body.fingerprint;
		const reads = w.reads;
		const try8 = async (body) => { const r = await restore(s, id, body); return `${r.status} ${r.body && r.body.code}${r.body && r.body.reason ? ` ${r.body.reason}` : ""}`; };
		eq("refusals", [
			await try8({ confirm: true, fingerprint: fp }),
			await try8({ confirm: true, fingerprint: fp, reason: 12345 }),
			await try8({ confirm: true, fingerprint: fp, reason: "ab" }),
			await try8({ confirm: true, fingerprint: fp, reason: "a".repeat(501) }),
			await try8({ confirm: true, fingerprint: fp, reason: "  \u0000​\n\t  " }),
			await try8({ confirm: true, fingerprint: fp, reason: "ask someone@example.com about it" }),
			await try8({ confirm: true, fingerprint: fp, reason: "call 555-201-7788 first" }),
			await try8({ fingerprint: fp, reason: REASON }),
		], [
			"400 RESTORE_REASON_REQUIRED missing", "400 RESTORE_REASON_REQUIRED missing", "400 RESTORE_REASON_REQUIRED too_short",
			"400 RESTORE_REASON_REQUIRED too_long", "400 RESTORE_REASON_REQUIRED too_short", "400 CONTACT_NOT_ALLOWED", "400 CONTACT_NOT_ALLOWED",
			"400 CONFIRMATION_REQUIRED",
		]);
		eq("none of them read the sheet, removed or audited anything", [w.reads - reads, deleteRows(w), auditsOf(w, "restore_load_blocked").length], [0, ["rl-8"], 0]);
		const long = "a".repeat(500);
		const ok500 = await restore(s, id, { confirm: true, fingerprint: fp, reason: long });
		eq("500 characters restore", ok500.status, 200);
		eq("...stored whole", auditsOf(w, "restore_load").map((a) => a.details.endsWith(`Reason: ${long}`)), [true]);
	});

	await R.test("9 Flag off: both routes answer 404 FEATURE_OFF and read nothing; the list says the restore is off", async ({ eq }) => {
		const w = routeWorld({ rows: [row({ id: "RL-9", driver: ANN, pickup: "2026-10-06 8:00", assigned: "2026-10-06" })], deleted: [{ id: "rl-9", row: 2 }], env: { RESTORE_DELETED_LOADS_ENABLED: "false" } });
		const s = routeServer(w);
		const id = idOf(w, "rl-9");
		const p = await preview(s, id);
		const r = await restore(s, id, { confirm: true, reason: REASON, fingerprint: "x" });
		eq("404 FEATURE_OFF on both", [verdict(p), verdict(r)], ["404 FEATURE_OFF", "404 FEATURE_OFF"]);
		eq("nothing read or removed", [w.reads || 0, deleteRows(w)], [0, ["rl-9"]]);
		const list = await hit(s, "GET /api/admin/deleted-loads");
		eq("the list: restore off, no history", [list.body && list.body.restoreEnabled, list.body && list.body.restored], [false, []]);
	});

	await R.test("10 A paid payout for the load's month (September reopened) -> 409 PAYOUT_SETTLED, nothing removed, audited", async ({ eq }) => {
		const w = routeWorld({
			rows: [row({ id: "RL-10", driver: ANN, pickup: "2026-09-08 8:00", dropoff: "2026-09-09 18:00", assigned: "2026-09-08", done: "2026-09-09" })],
			deleted: [{ id: "rl-10", row: 2 }],
		});
		w.db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by, reopened_at, reopened_by, reopen_reason) VALUES ('2026-09', 'reopened', '2026-10-15T05:00:00.000Z', 'system', '2026-10-16T05:00:00.000Z', 'super_admin', 'test')").run();
		w.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (5, '2026-09', 500, '2026-10-30', 'paid')").run();
		const s = routeServer(w);
		const r = await restore(s, idOf(w, "rl-10"), { confirm: true, reason: REASON, fingerprint: "x" });
		eq("refused", [r.status, r.body && r.body.code], [409, "PAYOUT_SETTLED"]);
		eq("nothing removed, audited", [deleteRows(w), auditsOf(w, "restore_load_blocked").length], [["rl-10"], 1]);
	});

	await R.test("11 The preview: each pay week's invoice (Approved without -> unpaid, Draft without -> regenerate, holding it -> already on, none yet, none in a past week), Cancelled, rowMoved, in flight with the driver's other active load, possible duplicates (driver and dates within a day, a shared reference; never Payment alone) and DUPLICATE_UNCONFIRMED; a Payment-only or payable-only change -> PREVIEW_STALE", async ({ eq, ok }) => {
		const rl11 = row({ id: "RL-11", driver: ANN, pickup: "2026-10-09 8:00", dropoff: "2026-10-17 18:00", assigned: "2026-10-09", done: "2026-10-17", payment: "$2,500.00" });
		rl11["Pickup Info"] = "PO: 7781234";
		const rl19 = row({ id: "RL-19", driver: BO, truck: "T2", pickup: "2026-11-10 8:00", dropoff: "2026-11-10 18:00", assigned: "2026-11-10", done: "2026-11-10", payment: "$900.00" });
		rl19["Pickup Info"] = "PO: 7781234";
		const rows = [
			rl11,
			row({ id: "RL-13", driver: BO, truck: "T2", pickup: "2026-10-13 8:00", dropoff: "2026-10-14 18:00", assigned: "2026-10-13", done: "2026-10-14" }),
			row({ id: "RL-14", driver: BO, truck: "T2", pickup: "2026-10-01 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-10-01", done: "2026-10-01" }),
			row({ id: "RL-15", driver: ANN, pickup: "2026-10-05 8:00", dropoff: "2026-10-05 18:00", assigned: "2026-10-05", status: "Cancelled" }),
			row({ id: "RL-16", driver: ANN, pickup: "2026-10-19 8:00", dropoff: "2026-10-21 18:00", assigned: "2026-10-19", status: "In Transit" }),
			row({ id: "RL-17", driver: ANN, pickup: "2026-11-02 8:00", dropoff: "2026-11-03 18:00", assigned: "2026-10-20", status: "Dispatched" }),
			row({ id: "RL-18", driver: ANN, pickup: "2026-10-18 8:00", dropoff: "2026-10-18 18:00", assigned: "2026-10-18", done: "2026-10-18" }),
			rl19,
			row({ id: "RL-20", driver: BO, truck: "T2", pickup: "2026-11-20 8:00", dropoff: "2026-11-20 18:00", assigned: "2026-11-20", done: "2026-11-20", payment: "$2,500.00" }),
		];
		const w = routeWorld({
			rows,
			deleted: [{ id: "rl-11", row: 99 }, { id: "rl-13", row: 3 }, { id: "rl-14", row: 4 }, { id: "rl-15", row: 5 }, { id: "rl-16", row: 6 }],
		});
		const inv = w.db.prepare("INSERT INTO invoices (invoice_number, driver, week_start, week_end, status, load_ids) VALUES (?, ?, ?, ?, ?, ?)");
		inv.run("INV-A1", ANN, "2026-10-03", "2026-10-09", "Approved", JSON.stringify(["RL-OTHER"]));
		inv.run("INV-D2", ANN, "2026-10-10", "2026-10-16", "Draft", "[]");
		inv.run("INV-B2", BO, "2026-10-10", "2026-10-16", "Submitted", JSON.stringify(["RL-13"]));
		const s = routeServer(w);
		const pv = async (key) => (await preview(s, idOf(w, key))).body;

		const p11 = await pv("rl-11");
		const lines = (p) => (p.invoices || []).map((i) => [i.weekStart, i.invoiceNumber, i.status, i.state, i.holdsLoad, i.unpaidDays.length]);
		eq("RL-11's three weeks: Approved without it, Draft without it, no invoice yet", lines(p11), [
			["2026-10-03", "INV-A1", "Approved", "issued", false, 1],
			["2026-10-10", "INV-D2", "Draft", "draft", false, 7],
			["2026-10-17", null, null, "none_yet", false, 1],
		]);
		ok("...each line says what a person does", /correction invoice is a person's call/.test(p11.invoices[0].note) && /regenerate the draft/.test(p11.invoices[1].note) && /Friday batch or a manual generate/.test(p11.invoices[2].note), JSON.stringify(p11.invoices.map((i) => i.note)));
		eq("RL-11 comes back from sheet row 2, not the stored 99", [p11.row && p11.row.rowIndex, p11.row && p11.row.storedRowIndex, p11.row && p11.row.rowMoved], [2, 99, true]);
		eq("RL-11's possible duplicates: RL-18 (Ann, the day after) and RL-19 (the same PO); never RL-20 (the same Payment only)",
			(p11.possibleDuplicates || []).map((d) => [d.loadId, d.reasons]), [["RL-18", ["same driver, overlapping dates"]], ["RL-19", ["same reference number"]]]);
		eq("RL-11 is not in flight; revenue +$2,500 in October", [p11.inFlight, p11.revenue], [null, { month: "2026-10", amount: 2500 }]);
		const p13 = await pv("rl-13");
		eq("RL-13: its week's invoice already holds it", lines(p13), [["2026-10-10", "INV-B2", "Submitted", "on", true, 2]]);
		const p14 = await pv("rl-14");
		eq("RL-14: a past week with no invoice", lines(p14), [["2026-09-26", null, null, "none_past", false, 1]]);
		ok("...generate it by hand", /generate it by hand/.test(p14.invoices[0].note), p14.invoices[0].note);
		const p15 = await pv("rl-15");
		eq("RL-15: Cancelled stays out; the ledger moves nothing", [p15.canRestore, p15.row && p15.row.cancelled, p15.ledger && p15.ledger.scopes.length], [true, true, 0]);
		const p16 = await pv("rl-16");
		eq("RL-16: in flight, with Ann's other active load", p16.inFlight && [p16.inFlight.status, p16.inFlight.otherActive], ["In Transit", [{ loadId: "RL-17", status: "Dispatched" }]]);

		const id11 = idOf(w, "rl-11");
		const noTick = await restore(s, id11, { confirm: true, reason: REASON, fingerprint: p11.fingerprint });
		eq("no tick: DUPLICATE_UNCONFIRMED", [noTick.status, noTick.body && noTick.body.code], [409, "DUPLICATE_UNCONFIRMED"]);
		w.setRow("RL-11", { "  Payment  ": "$2,600.00" });
		const payStale = await restore(s, id11, { confirm: true, reason: REASON, fingerprint: p11.fingerprint, notDuplicate: true });
		eq("only the Payment changed: PREVIEW_STALE", [payStale.status, payStale.body && payStale.body.code], [409, "PREVIEW_STALE"]);
		const fresh = await pv("rl-11");
		w.db.prepare("UPDATE investor_config SET value = '60' WHERE owner_id = 0 AND key = 'investor_split_pct'").run();
		const after = await pv("rl-11");
		const payables = (p) => p.ledger.scopes.filter((x) => x.ownerId === 5).map((x) => [x.month, x.revenue.change, x.payable && x.payable.change]);
		ok("the split moved only the payable", JSON.stringify(payables(fresh)) !== JSON.stringify(payables(after)) && JSON.stringify(fresh.ledger.fleet) === JSON.stringify(after.ledger.fleet), JSON.stringify([payables(fresh), payables(after)]));
		const splitStale = await restore(s, id11, { confirm: true, reason: REASON, fingerprint: fresh.fingerprint, notDuplicate: true });
		eq("only a payable changed: PREVIEW_STALE", [splitStale.status, splitStale.body && splitStale.body.code], [409, "PREVIEW_STALE"]);
		eq("nothing removed yet", deleteRows(w).includes("rl-11"), true);
		const done = await restore(s, id11, { confirm: true, reason: REASON, fingerprint: after.fingerprint, notDuplicate: true });
		eq("ticked, fresh: restored", done.status, 200);
		// The second PREVIEW_STALE inside the same minute is coalesced into the
		// first (logAuditRefusal(): one row per user, action and code a minute).
		eq("the refusals were audited, a repeat in the same minute coalesced", auditsOf(w, "restore_load_blocked").map((a) => /\[(DUPLICATE_UNCONFIRMED|PREVIEW_STALE)\]/.exec(a.details)?.[1]), ["DUPLICATE_UNCONFIRMED", "PREVIEW_STALE"]);
	});

	await R.test("12 Money: restoring an October load raises the fleet's October revenue by its Payment; every other table (invoices, paid days, payouts and their history, the closed month's freeze) is byte-identical and audit_trail only grows", async ({ eq, ok }) => {
		const w = routeWorld({
			rows: [
				row({ id: "RL-12", driver: ANN, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-06", done: "2026-10-07", payment: "$1,750.00" }),
				row({ id: "RL-12B", driver: ANN, pickup: "2026-09-14 8:00", dropoff: "2026-09-15 18:00", assigned: "2026-09-14", done: "2026-09-15", payment: "$1,000.00" }),
			],
			deleted: [{ id: "rl-12", row: 2 }], locks: ["2026-09"],
		});
		w.db.prepare("INSERT INTO invoices (invoice_number, driver, week_start, week_end, status, load_ids) VALUES ('INV-12', ?, '2026-10-03', '2026-10-09', 'Approved', '[]')").run(ANN);
		w.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (5, '2026-09', 240, '2026-10-30', 'owed')").run();
		w.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (5, '2026-10', 0, '2026-11-27', 'owed')").run();
		w.db.prepare("INSERT INTO investor_payout_history (payout_id, owner_id, period, kind, old_amount, new_amount, detail, actor) VALUES (1, 5, '2026-09', 'recompute', 0, 240, 'test', 'test')").run();
		const s = routeServer(w);
		const fleetRevenue = (snap, mk) => Math.round(snap.scopes.reduce((t, sc) => t + ((sc.months || []).find((m) => m.month === mk) || { revenue: 0 }).revenue, 0) * 100) / 100;
		const before = await s.api.computeFleetLedger();
		const hashes = W.tableHashes(w.db);
		const auditBefore = w.db.prepare("SELECT * FROM audit_trail ORDER BY id").all();
		const { r } = await previewThenRestore(s, idOf(w, "rl-12"));
		eq("restored", r.status, 200);
		const after = await s.api.computeFleetLedger();
		eq("October revenue +$1,750; September unchanged", [fleetRevenue(after, "2026-10") - fleetRevenue(before, "2026-10"), fleetRevenue(after, "2026-09") - fleetRevenue(before, "2026-09")], [1750, 0]);
		const now = W.tableHashes(w.db);
		eq("only deleted_loads, audit_trail and dispatch_notifications changed", Object.keys(hashes).filter((t) => hashes[t] !== now[t]).sort(), ["audit_trail", "deleted_loads", "dispatch_notifications"]);
		const auditAfter = w.db.prepare("SELECT * FROM audit_trail ORDER BY id").all();
		ok("audit_trail before is a prefix of after", JSON.stringify(auditAfter.slice(0, auditBefore.length)) === JSON.stringify(auditBefore) && auditAfter.length === auditBefore.length + 1);
		eq("reconcileInvestorPayouts() never called", s.calls.reconcile, 0);
	});

	await R.test("13 Notices carry no reason: the saved row and both live copies hold none; read back as a Dispatcher and as a Super Admin neither holds it, and the Dispatcher's withholds a Load ID that reads as a phone", async ({ eq, ok }) => {
		const SECRET_REASON = "Restored after the broker call on Tuesday";
		const w = routeWorld({ rows: [row({ id: "555-201-7788", driver: ANN, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-06", done: "2026-10-07" })], deleted: [{ id: "555-201-7788", row: 2 }] });
		const s = routeServer(w);
		const { r } = await previewThenRestore(s, idOf(w, "555-201-7788"), { reason: SECRET_REASON });
		eq("restored", r.status, 200);
		const saved = w.db.prepare("SELECT * FROM dispatch_notifications WHERE type = 'load-restored'").all();
		ok("the saved row holds no reason", saved.length === 1 && !JSON.stringify(saved).includes("broker call"), JSON.stringify(saved));
		ok("no live copy holds it", s.calls.emits.length === 2 && !JSON.stringify(s.calls.emits).includes("broker call"), JSON.stringify(s.calls.emits));
		const asSuper = await hit(s, "GET /api/dispatch-notifications", { user: USERS.super });
		const asDispatch = await hit(s, "GET /api/dispatch-notifications", { user: USERS.dispatcher });
		const mine = (res) => ((res.body && res.body.notifications) || []).filter((n) => n.type === "load-restored");
		ok("read back: no reason for either role", mine(asSuper).length === 1 && mine(asDispatch).length === 1 && !JSON.stringify([asSuper.body, asDispatch.body]).includes("broker call"));
		ok("the Super Admin's names the load", mine(asSuper)[0].title === "Restored Load 555-201-7788", mine(asSuper)[0] && mine(asSuper)[0].title);
		ok("the Dispatcher's withholds it", !JSON.stringify(mine(asDispatch)).includes("555-201-7788"), JSON.stringify(mine(asDispatch)));
		ok("the reason is in the audit row", auditsOf(w, "restore_load").length === 1 && auditsOf(w, "restore_load")[0].details.endsWith(`Reason: ${SECRET_REASON}`));
	});

	await R.test("15b The switch-on report: read-only on a copy (the file byte-identical), every deleted load listed with its months and verdict, and a restorable one's ledger equal to the preview's", async ({ eq, ok }) => {
		const w = restoreWorld();
		w.db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_by) VALUES ('rs-gone', 0, 'super_admin')").run();
		const env = { ...ONCE, ...ON };
		w.env = env;
		w.marker = { pending: false };
		const s = routeServer(w);
		const pv = await preview(s, idOf(w, "rs-oct"));
		const copy = W.saveCopy(w, env);
		const hash = W.fileHash(copy.db);
		const run = W.runScript("scripts/deleted-loads-restore-report.js", [`--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, `--now=${new Date(NOW_DEC).toISOString()}`, "--json"]);
		ok("the report ran", run.code === 0 && run.json, `${run.code} ${run.stderr.slice(0, 300)}`);
		eq("the copy is byte-identical", W.fileHash(copy.db), hash);
		const loads = (run.json && run.json.loads) || [];
		eq("every deleted load, with its verdict", loads.map((l) => [l.key, l.canRestore, (l.refusal && l.refusal.code) || null]), [["rs-oct", true, null], ["rs-co", true, null], ["rs-gone", false, "RESTORE_NO_ROW"]]);
		const oct = loads.find((l) => l.key === "rs-oct");
		eq("the report's ledger is the preview's", oct && oct.ledger, pv.body && pv.body.ledger);
		eq("...and so are its months and invoice lines", oct && [oct.months, oct.invoices], pv.body && [pv.body.months, pv.body.invoices]);
	});

	await R.test("17 New Job's DUPLICATE_LOAD for a deleted load (D11): with the flag on, a Super Admin is told to restore it from Deleted loads and a Dispatcher to ask a Super Admin; with the flag off, the message is as before", async ({ eq }) => {
		const FROM_RATECON = ["post", "/api/loads/from-ratecon"];
		const ask = async (env, user) => {
			const w = routeWorld({ rows: [row({ id: "RL-17D", driver: ANN, pickup: "2026-10-06 8:00", assigned: "2026-10-06" })], deleted: [{ id: "rl-17d", row: 2 }], env });
			const s = routeServer(w, { extra: [FROM_RATECON] });
			const chain = s.routes["POST /api/loads/from-ratecon"];
			const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, on() {}, statusCode: 200, body: null };
			await chain[chain.length - 1]({ session: { user: { ...user } }, body: { fields: { "Load Number": "RL-17D" } }, headers: {}, get: () => undefined }, res);
			return `${res.statusCode} ${res.body && res.body.code} ${res.body && res.body.error}`;
		};
		eq("the three messages", [
			await ask({}, USERS.super),
			await ask({}, USERS.dispatcher),
			await ask({ RESTORE_DELETED_LOADS_ENABLED: "false" }, USERS.super),
			await ask({ RESTORE_DELETED_LOADS_ENABLED: "false" }, USERS.dispatcher),
		], [
			"409 DUPLICATE_LOAD Load RL-17D already exists (row 2) but was deleted. Restore it from Deleted loads.",
			"409 DUPLICATE_LOAD Load RL-17D already exists (row 2) but was deleted. Ask a Super Admin to restore it from Deleted loads.",
			"409 DUPLICATE_LOAD Load RL-17D already exists (row 2) but was deleted. Restore it instead of re-creating it.",
			"409 DUPLICATE_LOAD Load RL-17D already exists (row 2) but was deleted. Restore it instead of re-creating it.",
		]);
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
