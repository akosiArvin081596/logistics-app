#!/usr/bin/env node
/**
 * The month-end lock over the trip rule's days (pay plan 2026-10-21, section 2;
 * Arvin's e: "B12's trip-rule days get the month-lock cover before TRIP_WORK_DAYS
 * can go on"). Written before the fix: L1, L2, L4, L5, L9 and L10 fail on main;
 * L3, L6, L7 and L8 are controls.
 *
 * The gap: a Super Admin day override ("remove") is held to the months of the
 * driver's loads whose WINDOW covers the date (excludedDayPeriods()), and a load
 * with no Assigned Date to its window's months (loadRowPeriods(), behind the load
 * delete, the sheet-edit and status guards). The trip rule pays days outside the
 * window: the drive to the pickup, an unloading day after the Drop-off
 * Appointment, a load whose window is blank. Such a day settles in the load's
 * Assigned month, so an override on it, or a status change that moves it,
 * restates that month while the guards ask only about the window's.
 *
 * The fix, with TRIP_WORK_DAYS on only (off, every guard is byte-identical):
 *   - excludedDayPeriods() adds a row's loadRowPeriods() months whenever the trip
 *     rule pays the date for that load, asked with the invoice's and the ledger's
 *     pay windows (their blank-appointment flags differ), any status;
 *   - loadRowPeriods()' no-Assigned-Date branch adds the months of the load's trip
 *     days;
 *   - a history or ELD read error refuses (unresolved); "add" overrides unchanged.
 *
 * Runs the real routes, lifted from server.js (scripts/lib/work-days-world.js), on
 * one in-memory SQLite. Made-up data only. No truck feed unless a case says so, so
 * every trip day of a span is paid (no ELD fix).
 * Run: node scripts/test-trip-work-days-month-lock.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const W = require("./lib/work-days-world");
const { loadRow, et } = W;

const D = "Lu Lock";
const TRIP = (from) => ({ TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: from });
const ROUTES = [
	["post", "/api/admin/excluded-days"],
	["delete", "/api/loads/:loadId"],
	["put", "/api/loads/:loadId/status-override"],
	["put", "/api/driver/status"],
];
const s = (lid, status, wall, source = "manual", actor = D) => [lid, status, source, et(wall), actor];
const dispatched = (lid, wall) => s(lid, "Dispatched", wall, "dispatch", "super_admin");

function world({ env, rows, status = [], locks = [], trucks = null, pings = {} }) {
	return W.startWorld({ env, rows, status, locks, trucks, pings, drivers: [{ name: D }], routes: ROUTES, now: Date.parse("2026-11-20T17:00:00Z") });
}
const override = (w, date, action = "remove") => W.route(w, "POST /api/admin/excluded-days", { body: { driverName: D, date, action, reason: "test override" } });
const deleteLoad = (w, loadId) => W.route(w, "DELETE /api/loads/:loadId", { params: { loadId } });
const statusOverride = (w, loadId, newStatus) => W.route(w, "PUT /api/loads/:loadId/status-override", { params: { loadId }, body: { newStatus, reason: "test override reason" } });
const driverStatus = (w, rowIndex, loadId, newStatus) => W.route(w, "PUT /api/driver/status", { body: { rowIndex, loadId, newStatus, driverName: D } });
const verdict = (r) => (r.status === 409 ? `409 ${r.body && r.body.code}${r.body && Array.isArray(r.body.periods) && r.body.periods.length ? ` ${r.body.periods.join(",")}` : ""}` : r.status === 200 ? "200" : `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

// L1's load: Assigned Thu 10/1 (October), window 10/1-10/2, the drive to the
// pickup headed out Wed 9/30 (a trip day outside the window).
const headingLoad = () => ({
	rows: [loadRow({ id: "L101", driver: D, pickup: "2026-10-01 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T1" })],
	status: [dispatched("L101", "2026-09-29 08:00"), s("L101", "Heading to Shipper", "2026-09-30 09:00"), s("L101", "At Shipper", "2026-10-01 08:00"), s("L101", "Delivered", "2026-10-02 12:00")],
});
// L2's load: Assigned 10/30, window 10/30 only, At Receiver 10/31, Delivered
// tapped 11/2 (no receiver exit to read: the At Receiver day and 11/2 are paid).
const lateUnloadLoad = () => ({
	rows: [loadRow({ id: "L201", driver: D, pickup: "2026-10-30 8:00", dropoff: "2026-10-30 18:00", assigned: "2026-10-30", done: "2026-11-02", truck: "T1" })],
	status: [s("L201", "At Shipper", "2026-10-30 08:00"), s("L201", "At Receiver", "2026-10-31 09:00"), s("L201", "Delivered", "2026-11-02 10:00")],
});
// L4's load: no Assigned Date, window 10/1-10/2 (October), headed out 9/30.
const unassignedLoad = () => ({
	rows: [loadRow({ id: "L401", driver: D, pickup: "2026-10-01 8:00", dropoff: "2026-10-02 18:00", assigned: "", done: "2026-10-02", truck: "T1" })],
	status: [dispatched("L401", "2026-09-29 08:00"), s("L401", "Heading to Shipper", "2026-09-30 09:00"), s("L401", "At Shipper", "2026-10-01 08:00"), s("L401", "Delivered", "2026-10-02 12:00")],
});

const R = W.createRunner("Month-end lock over the trip rule's days (excludedDayPeriods(), loadRowPeriods() and the routes on them)");

(async () => {
	await R.test("L1 remove-override-heading-day-closed-assigned-month-409: FROM=2026-10, October closed, September open: removing Wed 9/30, the heading day of a load Assigned in October, is refused (it would restate October). Base: allowed (no window covers 9/30, its own month is open)", async ({ eq }) => {
		const w = world({ env: TRIP("2026-10"), locks: ["2026-10"], ...headingLoad() });
		eq("refused", verdict(await override(w, "2026-09-30")), "409 PERIOD_FINALIZED 2026-10");
	});

	await R.test("L2 remove-override-unloading-day-after-dropoff-appt-409: FROM=2026-10, October closed: removing Mon 11/2, the Delivered day of a load Assigned 10/30 whose Drop-off Appointment was 10/30, is refused. Base: allowed", async ({ eq }) => {
		const w = world({ env: TRIP("2026-10"), locks: ["2026-10"], ...lateUnloadLoad() });
		eq("refused", verdict(await override(w, "2026-11-02")), "409 PERIOD_FINALIZED 2026-10");
	});

	await R.test("L3 waiting-day-inside-window-still-refused (control): FROM=2026-09, September closed: a load Assigned 9/30, window 9/30-10/2, the truck parked Thu 10/1 (a day rule d does not pay): removing 10/1 is still refused, the window covers it", async ({ eq }) => {
		const feed = W.feed(100000).drive("2026-09-30", { miles: 200 }).park("2026-10-01").drive("2026-10-02", { miles: 200 }).pings;
		const w = world({
			env: TRIP("2026-09"), locks: ["2026-09"], trucks: [{ unit: "T1", driver: D, vid: "V3" }], pings: { V3: feed },
			rows: [loadRow({ id: "L301", driver: D, pickup: "2026-09-30 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-09-30", done: "2026-10-02", truck: "T1" })],
			status: [s("L301", "At Shipper", "2026-09-30 08:00"), s("L301", "Loading", "2026-09-30 09:00"), s("L301", "In Transit", "2026-09-30 12:00"), s("L301", "Delivered", "2026-10-02 12:00")],
		});
		eq("refused", verdict(await override(w, "2026-10-01")), "409 PERIOD_FINALIZED 2026-09");
	});

	await R.test("L4 no-assigned-date-trip-day-in-closed-month-refused: FROM=2026-09, September closed: a load with no Assigned Date, its window in October and its heading day 9/30, cannot be deleted nor have its status overridden (its trip days settle in their own months). Base: both allowed", async ({ eq }) => {
		const a = world({ env: TRIP("2026-09"), locks: ["2026-09"], ...unassignedLoad() });
		eq("delete refused", verdict(await deleteLoad(a, "L401")), "409 PERIOD_FINALIZED 2026-09");
		const b = world({ env: TRIP("2026-09"), locks: ["2026-09"], ...unassignedLoad() });
		eq("status override refused", verdict(await statusOverride(b, "L401", "In Transit")), "409 PERIOD_FINALIZED 2026-09");
	});

	await R.test("L5 eld-or-history-read-error-refuses-unresolved: the trip history cannot be read, or the truck's ELD feed cannot: a remove override on the driver's days, and the no-Assigned-Date load's delete, are refused as unresolved. Base: allowed", async ({ eq }) => {
		const a = world({ env: TRIP("2026-10"), locks: ["2026-10"], ...headingLoad() });
		a.db.exec("DROP TABLE load_status_history");
		eq("history unreadable: override refused", verdict(await override(a, "2026-09-30")), "409 PERIOD_UNRESOLVED");
		const b = world({ env: TRIP("2026-10"), locks: ["2026-10"], trucks: [{ unit: "T1", driver: D, vid: "V5" }], ...headingLoad() });
		b.db.exec("DROP TABLE routemate_telemetry");
		eq("ELD unreadable: override refused", verdict(await override(b, "2026-09-30")), "409 PERIOD_UNRESOLVED");
		const c = world({ env: TRIP("2026-09"), locks: ["2026-09"], ...unassignedLoad() });
		c.db.exec("DROP TABLE load_status_history");
		eq("history unreadable: no-Assigned-Date delete refused", verdict(await deleteLoad(c, "L401")), "409 PERIOD_UNRESOLVED");
	});

	await R.test("L6 flag-off-byte-identical (control): with the flags off, or TRIP_WORK_DAYS_FROM set and the flag off, L1, L2 and L4's writes are allowed as today", async ({ eq }) => {
		for (const [label, env] of [["no flags", {}], ["FROM set, flag off", { TRIP_WORK_DAYS_FROM: "2026-09" }]]) {
			eq(`${label}: L1 override`, verdict(await override(world({ env, locks: ["2026-10"], ...headingLoad() }), "2026-09-30")), "200");
			eq(`${label}: L2 override`, verdict(await override(world({ env, locks: ["2026-10"], ...lateUnloadLoad() }), "2026-11-02")), "200");
			eq(`${label}: L4 delete`, verdict(await deleteLoad(world({ env, locks: ["2026-09"], ...unassignedLoad() }), "L401")), "200");
		}
	});

	await R.test("L7 settling-before-FROM-window-only (control): FROM=2026-11, L1's load settles in October, before FROM: its heading day is no trip day of the rule, so removing 9/30 is allowed as today", async ({ eq }) => {
		eq("allowed", verdict(await override(world({ env: TRIP("2026-11"), locks: ["2026-10"], ...headingLoad() }), "2026-09-30")), "200");
	});

	await R.test("L8 add-override-unchanged (control): an 'add' override is held to its own month only: adding 9/30 (September open) is allowed, adding 10/5 (October closed) refused, as today", async ({ eq }) => {
		const w = world({ env: TRIP("2026-10"), locks: ["2026-10"], ...headingLoad() });
		eq("add 9/30", verdict(await override(w, "2026-09-30", "add")), "200");
		eq("add 10/5", verdict(await override(w, "2026-10-05", "add")), "409 PERIOD_FINALIZED 2026-10");
	});

	await R.test("L9 driver-status-route-cannot-step-back-a-delivered-load: FROM=2026-09, September closed: stepping L4's delivered load (no Assigned Date, heading day 9/30) back to At Receiver through PUT /api/driver/status is refused, as its delete is. Base: allowed", async ({ eq }) => {
		const w = world({ env: TRIP("2026-09"), locks: ["2026-09"], ...unassignedLoad() });
		eq("refused", verdict(await driverStatus(w, 2, "L401", "At Receiver")), "409 PERIOD_FINALIZED 2026-09");
		eq("nothing written to the sheet", w.sheetWrites.length, 0);
	});

	await R.test("L10 union-of-invoice-and-ledger-windows: FROM=2026-10, October closed: a load Assigned 10/30 with no status rows, Pickup Appointment 10/30, a blank Drop-off Appointment and completed 11/2: the weekly invoice's window runs to the completion date (the ledger's, its blank drop-off fallback off, is 10/30 alone), so 11/2 is a trip day and removing it is refused. Base: allowed", async ({ eq }) => {
		const w = world({
			env: TRIP("2026-10"), locks: ["2026-10"],
			rows: [loadRow({ id: "L1001", driver: D, pickup: "2026-10-30 8:00", dropoff: "", assigned: "2026-10-30", done: "2026-11-02", truck: "T1" })],
		});
		eq("refused", verdict(await override(w, "2026-11-02")), "409 PERIOD_FINALIZED 2026-10");
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
