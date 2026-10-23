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
 * The rest of section 9 (the routes) joins this file with the server part.
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

// ── the fixtures ─────────────────────────────────────────────────────────────
const ANN = "Ann Ames";   // investor 5's driver (Acme Carrier), truck T1
const CARA = "Cara Pike"; // a company driver (no carrier), truck C9
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

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
