#!/usr/bin/env node
// Assigning a load to a driver who is recorded off (R11), with
// DRIVER_AVAILABILITY_ENABLED on. The owner's rule (2026-10-15): warn, never
// block. Each of the five routes that put a driver on a load answers 409
// DRIVER_OFF_DUTY, naming the dates, when the load's window overlaps one of the
// driver's live off rows, and writes nothing; the same request with
// confirmOffDuty: true (PUT /api/load/:loadId, whose body keys are all column
// names: ?confirmOffDuty=true) goes through and is audited with the dates.
//
//   §1 the five routes: 409 without the confirmation, nothing written; 200 with
//      it, plus a dispatch_off_duty_confirmed audit row
//   §2 no warning: a window that misses the off days, a past load, a driver
//      with no rows, a cancelled row, the same driver kept on a row
//   §3 the load window (sheetDayKey() on Pickup / Drop-off Appointment):
//      start = pickup || drop-off, end = drop-off || pickup, an end before the
//      start reads as the start, and only both cells unreadable reads as today;
//      a window that ends before today never warns
//   §4 the call sites: exactly the five routes, each inside
//      `if (DRIVER_AVAILABILITY_ENABLED)`, so n8n and system writes never pass
//      through the check
//
// The routes are the shipped ones, lifted out of server.js
// (scripts/lib/availability-world.js) over a fake Job Tracking sheet; "today"
// is 2026-10-15 on the business clock.
// Run: node scripts/test-dispatch-off-duty.js

"use strict";

const W = require("./lib/availability-world");

const R = W.createRunner("test-dispatch-off-duty");
const { ok, eq, section } = R;
const { USERS, DIR, COL, HEADERS } = W;

let lib = null;
try { lib = require("../lib/driver-availability"); } catch { lib = null; }

const off = (w, dirId, from, to, kind = "vacation") => w.call("POST", `/api/drivers-directory/${dirId}/availability`, { body: { kind, from, to } });
const sheetCopy = (w) => JSON.stringify(w.sheet.tabs["Job Tracking"]);
const driverAt = (w, rowIndex) => (w.sheet.tabs["Job Tracking"][rowIndex - 1] || [])[COL.Driver];
const confirmed = (w) => w.audits("dispatch_off_duty_confirmed");
const code = (r) => [r.status, r.body && r.body.code];
const rowValues = (w, rowIndex, patch) => {
	const r = HEADERS.map((h, i) => (w.sheet.tabs["Job Tracking"][rowIndex - 1] || [])[i] || "");
	for (const [k, v] of Object.entries(patch)) r[COL[k]] = v;
	return r;
};

// Each route, as a function of (world, driver, confirm) aimed at load 7003
// (row 4, Oct 18-19) unless it is the append, which adds its own row.
const ROUTES = [
	["POST /api/dispatch", (w, driver, confirm) => w.call("POST", "/api/dispatch", { user: USERS.disp,
		body: { rowIndex: 4, loadId: "7003", driver, ...(confirm ? { confirmOffDuty: true } : {}) } })],
	["POST /api/dispatch/reassign", (w, driver, confirm) => w.call("POST", "/api/dispatch/reassign", { user: USERS.disp,
		body: { rowIndex: 4, loadId: "7003", newDriver: driver, oldDriver: "", ...(confirm ? { confirmOffDuty: true } : {}) } })],
	["PUT /api/data/:rowIndex", (w, driver, confirm) => w.call("PUT", "/api/data/4", { user: USERS.disp,
		body: { values: rowValues(w, 4, { Driver: driver }), ...(confirm ? { confirmOffDuty: true } : {}) } })],
	["PUT /api/load/:loadId", (w, driver, confirm) => w.call("PUT", `/api/load/7003${confirm ? "?confirmOffDuty=true" : ""}`, { user: USERS.disp,
		body: { Driver: driver } })],
	["POST /api/data", (w, driver, confirm) => w.call("POST", "/api/data", { user: USERS.sa,
		body: { values: W.jtRow({ id: "7100", driver, pickup: "10/18/2026 08:00", dropoff: "10/19/2026 12:00", status: "Dispatched" }), ...(confirm ? { confirmOffDuty: true } : {}) } })],
];

(async () => {
	section("§1 the five routes warn, and go through when confirmed");
	for (const [label, send] of ROUTES) {
		await R.guard(`§1 ${label}`, async () => {
			const w = await W.startWorld();
			ok(`§1 ${label}: Tamsin is recorded off Oct 18-22`, (await off(w, DIR.tamsin, "2026-10-18", "2026-10-22")).status === 201);
			const before = sheetCopy(w);
			const writesBefore = w.sheet.log.writes.length;
			const r = await send(w, "Tamsin Vale", false);
			eq(`§1 ${label}, load Oct 18-19: 409 DRIVER_OFF_DUTY`, code(r), [409, "DRIVER_OFF_DUTY"]);
			eq(`§1 ${label}: the refusal names the off dates`, r.body && [r.body.offFrom, r.body.offTo, r.body.kind], ["2026-10-18", "2026-10-22", "vacation"]);
			ok(`§1 ${label}: ...and says so in words`, r.body && /Oct 18 – Oct 22/.test(r.body.error || ""), r.body && r.body.error);
			eq(`§1 ${label}: nothing written to the sheet`, [w.sheet.log.writes.length - writesBefore, sheetCopy(w) === before], [0, true]);
			eq(`§1 ${label}: nothing audited as confirmed`, confirmed(w).length, 0);
			const c = await send(w, "Tamsin Vale", true);
			eq(`§1 ${label}, with the confirmation: 200`, c.status, 200);
			const rows = w.sheet.tabs["Job Tracking"];
			const written = label === "POST /api/data" ? rows[rows.length - 1][COL.Driver] : driverAt(w, 4);
			eq(`§1 ${label}: the Driver cell is written`, written, "Tamsin Vale");
			const a = confirmed(w);
			eq(`§1 ${label}: one dispatch_off_duty_confirmed audit row`, a.length, 1);
			ok(`§1 ${label}: ...naming the driver, the off dates and the load window`,
				a[0] && /Tamsin Vale/.test(a[0].details) && /2026-10-18\.\.2026-10-22/.test(a[0].details) && /2026-10-18\.\.2026-10-19/.test(a[0].details), a[0] && a[0].details);
		});
	}

	section("§2 no warning");
	await R.guard("§2", async () => {
		const w = await W.startWorld();
		await off(w, DIR.tamsin, "2026-10-24", "2026-10-30");
		await off(w, DIR.tamsin, "2026-09-30", "2026-10-04");
		const cancelled = await off(w, DIR.soren, "2026-10-18", "2026-10-19");
		await w.call("POST", `/api/driver-availability/${cancelled.body.row.id}/cancel`, { body: {} });
		eq("§2.1 Tamsin off Oct 24-30, load Oct 18-19: 200", (await ROUTES[0][1](w, "Tamsin Vale", false)).status, 200);
		eq("§2.2 a driver with no rows (Hollis) on load 7002 (Oct 16-17): 200",
			(await w.call("POST", "/api/dispatch/reassign", { user: USERS.disp, body: { rowIndex: 3, loadId: "7002", newDriver: "Hollis Renner", oldDriver: "Soren King" } })).status, 200);
		eq("§2.3 Soren's cancelled Oct 18-19 row: no warning on a load Oct 18-19",
			(await w.call("PUT", "/api/load/7003", { user: USERS.disp, body: { Driver: "Soren King" } })).status, 200);
		eq("§2.4 a past load (7004, Oct 1-3) given to Tamsin, off Sep 30 - Oct 4: 200",
			(await w.call("PUT", "/api/data/5", { user: USERS.disp, body: { values: rowValues(w, 5, { Driver: "Tamsin Vale" }) } })).status, 200);
		eq("§2.5 no confirmation was audited", confirmed(w).length, 0);
		await off(w, DIR.hollis, "2026-10-20", "2026-10-21");
		eq("§2.6 a row save that keeps Hollis on his own load (7001, Oct 20-22) and edits Details: 200, no warning",
			(await w.call("PUT", "/api/data/2", { user: USERS.disp, body: { values: rowValues(w, 2, { Details: "Dry van - 2 pallets" }) } })).status, 200);
		eq("§2.7 a name variant still warns (\"  tamsin   VALE \" on a load Oct 24-25)",
			code(await w.call("POST", "/api/data", { user: USERS.sa, body: { values: W.jtRow({ id: "7101", driver: "  tamsin   VALE ", pickup: "10/24/2026", dropoff: "10/25/2026", status: "Dispatched" }) } })),
			[409, "DRIVER_OFF_DUTY"]);
	});

	section("§3 the load window");
	await R.guard("§3", async () => {
		const win = (p, d, today = "2026-10-15") => (lib && lib.offDutyLoadWindow ? lib.offDutyLoadWindow(p, d, today) : null);
		eq("§3.1 pickup and drop-off: start..end", win("2026-10-18", "2026-10-19"), { start: "2026-10-18", end: "2026-10-19" });
		eq("§3.2 both unreadable (\"\"): today..today", win("", ""), { start: "2026-10-15", end: "2026-10-15" });
		eq("§3.3 a future pickup, no drop-off: the pickup day only", win("2026-10-20", ""), { start: "2026-10-20", end: "2026-10-20" });
		eq("§3.4 no pickup, drop-off Oct 18: Oct 18", win("", "2026-10-18"), { start: "2026-10-18", end: "2026-10-18" });
		eq("§3.5 a drop-off before the pickup: the pickup day", win("2026-10-20", "2026-10-17"), { start: "2026-10-20", end: "2026-10-20" });
		const rows = [{ id: 1, kind: "vacation", from_date: "2026-10-20", to_date: "2026-10-22", cancelled_at: null }];
		const hit = (p, d, rs = rows, today = "2026-10-15") => (lib && lib.offDutyConflict ? lib.offDutyConflict({ rows: rs, pickupKey: p, dropoffKey: d, todayKey: today }) : undefined);
		ok("§3.6 pickup Oct 20, drop-off unreadable, off Oct 20-22: warns", !!hit("2026-10-20", ""));
		eq("§3.7 ...off Oct 15-16 instead (today Oct 15): no warning", hit("2026-10-20", "", [{ id: 2, kind: "vacation", from_date: "2026-10-15", to_date: "2026-10-16", cancelled_at: null }]), null);
		eq("§3.8 a window that ended yesterday never warns", hit("2026-10-13", "2026-10-14", [{ id: 3, kind: "vacation", from_date: "2026-10-10", to_date: "2026-10-20", cancelled_at: null }]), null);
		eq("§3.9 a window ending today warns", !!hit("2026-10-14", "2026-10-15", [{ id: 3, kind: "vacation", from_date: "2026-10-15", to_date: "2026-10-20", cancelled_at: null }]), true);
		eq("§3.10 a cancelled row never warns", hit("2026-10-20", "2026-10-21", [{ ...rows[0], cancelled_at: "2026-10-15T00:00:00Z" }]), null);

		// The same rules through a route, over the sheet's own cells.
		const w = await W.startWorld({ rows: [...W.defaultRows(),
			W.jtRow({ id: "7201", pickup: "TBD", dropoff: "TBD" }),
			W.jtRow({ id: "7202", pickup: "10/20/2026 08:00", dropoff: "TBD" }),
			W.jtRow({ id: "7203", pickup: "TBD", dropoff: "2026-10-18" }),
			W.jtRow({ id: "7204", pickup: "10/20/2026", dropoff: "10/17/2026" }),
		] });
		await off(w, DIR.soren, "2026-10-14", "2026-10-15");
		await off(w, DIR.hollis, "2026-10-20", "2026-10-22");
		await off(w, DIR.tamsin, "2026-10-18", "2026-10-18");
		const dispatch = (rowIndex, loadId, driver) => w.call("POST", "/api/dispatch", { user: USERS.disp, body: { rowIndex, loadId, driver } });
		eq("§3.11 both cells \"TBD\": the window is today; Soren off through today: 409, never 500", code(await dispatch(6, "7201", "Soren King")), [409, "DRIVER_OFF_DUTY"]);
		eq("§3.12 pickup Oct 20, drop-off \"TBD\": Hollis off Oct 20-22 warns", code(await dispatch(7, "7202", "Hollis Renner")), [409, "DRIVER_OFF_DUTY"]);
		eq("§3.13 ...Soren, off Oct 14-15, does not", (await dispatch(7, "7202", "Soren King")).status, 200);
		eq("§3.14 pickup \"TBD\", drop-off 2026-10-18: Tamsin off Oct 18 warns", code(await dispatch(8, "7203", "Tamsin Vale")), [409, "DRIVER_OFF_DUTY"]);
		eq("§3.15 drop-off before the pickup: the pickup day (Oct 20); Tamsin off Oct 18 does not", (await dispatch(9, "7204", "Tamsin Vale")).status, 200);
	});

	section("§4 the call sites");
	await R.guard("§4", async () => {
		const lines = W.SRC.split("\n");
		const calls = [];
		lines.forEach((l, i) => {
			if (/\bdriverOffDutyRefusal\(/.test(l) && !/^function driverOffDutyRefusal\(/.test(l) && !/^\s*\/\//.test(l)) calls.push(i);
		});
		eq("§4.1 the off-duty check is called from exactly five places", calls.length, 5);
		const routeOf = (i) => { for (let j = i; j >= 0; j--) if (/^app\.\w+\("/.test(lines[j])) return lines[j].slice(0, lines[j].indexOf(",")); return ""; };
		eq("§4.2 ...the five assign routes", calls.map(routeOf).sort(), [
			'app.post("/api/data"', 'app.post("/api/dispatch"', 'app.post("/api/dispatch/reassign"', 'app.put("/api/data/:rowIndex"', 'app.put("/api/load/:loadId"',
		]);
		const guarded = calls.filter((i) => {
			for (let j = i - 1; j >= 0; j--) {
				const t = lines[j].trim();
				if (!t || t.startsWith("//")) continue;
				return t === "if (DRIVER_AVAILABILITY_ENABLED) {";
			}
			return false;
		});
		eq("§4.3 ...each inside `if (DRIVER_AVAILABILITY_ENABLED) {`", guarded.length, calls.length);
	});

	await R.finish();
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
