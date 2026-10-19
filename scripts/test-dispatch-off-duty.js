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
//   §5 a read of the availability table that fails is logged and the
//      assignment goes ahead, as every other availability read degrades: the
//      check is a warning, never a reason a dispatch cannot be made
//   §6 the "Assign anyway" audit row is written only after the sheet write
//      succeeded: a confirmed assignment whose write fails leaves none
//   §7 the owner's rule (2026-10-15): moving an assigned load's dates into its
//      driver's time off asks the same question as changing the driver, on
//      both row saves (the only routes that change an assigned load's dates;
//      n8n and re-issue writes are system writes and never checked). A new
//      time on the same day is no move. The Driver column is the one checked:
//      Job Tracking has no co-driver column.
//   §8 the other side (R11b, pure, lib/driver-availability.js): recording or
//      changing time off over loads he already has. loadsNewlyInTimeOff()
//      lists his live loads whose window (offDutyLoadWindow()) overlaps the new
//      dates, ends today or later and, on an edit, misses the old dates; a load
//      with no readable day is skipped. parseConfirmLoads() reads the "Save
//      anyway" echo and nothing else; timeOffLoadsDecision() asks again when
//      the echo misses a listed load or its window; driverHasLoadsBody() is
//      the 409's words. Every listed load can be confirmed (an id over 64
//      characters is not listed; an echo of the whole list is never too long);
//      an unchecked echo is kept to the time off's days; each load is listed and
//      matched by the id the viewer is shown, and confirmed by the stored one
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

	section("§5 an availability read that fails never stops an assignment");
	for (const [label, send] of ROUTES) {
		await R.guard(`§5 ${label}`, async () => {
			const w = await W.startWorld();
			await off(w, DIR.tamsin, "2026-10-18", "2026-10-22");
			// The table gone under the running server: every read of it throws.
			w.db.exec("DROP TABLE driver_availability");
			const logsBefore = w.logs.length;
			const r = await send(w, "Tamsin Vale", false);
			eq(`§5 ${label}, the availability read fails: 200, the assignment goes ahead`, r.status, 200);
			const rows = w.sheet.tabs["Job Tracking"];
			const written = label === "POST /api/data" ? rows[rows.length - 1][COL.Driver] : driverAt(w, 4);
			eq(`§5 ${label}: the Driver cell is written`, written, "Tamsin Vale");
			ok(`§5 ${label}: the failed read is logged as the availability check's`,
				w.logs.slice(logsBefore).some((l) => /off-duty check/i.test(l) && /no such table/i.test(l)), w.logs.slice(logsBefore).join(" | "));
		});
	}

	section("§6 a confirmed assignment is audited only once it is written");
	for (const [label, send] of ROUTES) {
		await R.guard(`§6 ${label}`, async () => {
			const w = await W.startWorld();
			await off(w, DIR.tamsin, "2026-10-18", "2026-10-22");
			w.sheet.control.failWrites = true;
			const failed = await send(w, "Tamsin Vale", true);
			ok(`§6 ${label}, confirmed but the sheet write fails: not answered 200`, failed.status !== 200, `status ${failed.status}`);
			eq(`§6 ${label}: ...and no dispatch_off_duty_confirmed audit row`, confirmed(w).length, 0);
			w.sheet.control.failWrites = false;
			const done = await send(w, "Tamsin Vale", true);
			eq(`§6 ${label}, confirmed again with the sheet writable: 200 and one audit row`, [done.status, confirmed(w).length], [200, 1]);
		});
	}

	section("§7 moving an assigned load's dates into the driver's time off");
	await R.guard("§7 the rule", async () => {
		const pick = (o) => (lib && lib.offDutyCheckDriver ? lib.offDutyCheckDriver({ normalize: (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " "), ...o }) : undefined);
		const same = { driverBefore: "Soren King", driverAfter: "Soren King", pickupBefore: "2026-10-16", pickupAfter: "2026-10-16", dropoffBefore: "2026-10-17", dropoffAfter: "2026-10-17" };
		eq("§7.1 nothing moved, same driver: no check", pick(same), "");
		eq("§7.2 a new driver: checked", pick({ ...same, driverAfter: "Tamsin Vale" }), "Tamsin Vale");
		eq("§7.3 the same driver in other spacing and case: no check", pick({ ...same, driverAfter: " soren   KING " }), "");
		eq("§7.4 the pickup day moved: the driver is checked", pick({ ...same, pickupAfter: "2026-10-20" }), "Soren King");
		eq("§7.5 the drop-off day moved: checked", pick({ ...same, dropoffAfter: "2026-10-21" }), "Soren King");
		eq("§7.6 a load with no driver whose dates move: no check", pick({ ...same, driverBefore: "", driverAfter: "", pickupAfter: "2026-10-20" }), "");
		eq("§7.7 the driver cleared: no check", pick({ ...same, driverAfter: "" }), "");
	});
	for (const [label, move] of [
		["PUT /api/data/:rowIndex", (w, rowIndex, loadId, patch, confirm) => w.call("PUT", `/api/data/${rowIndex}`, { user: USERS.disp,
			body: { values: rowValues(w, rowIndex, patch), ...(confirm ? { confirmOffDuty: true } : {}) } })],
		["PUT /api/load/:loadId", (w, rowIndex, loadId, patch, confirm) => w.call("PUT", `/api/load/${loadId}${confirm ? "?confirmOffDuty=true" : ""}`, { user: USERS.disp,
			body: Object.fromEntries(Object.entries(patch).map(([k, v]) => [W.HEADERS.find((h) => h.trim() === k), v])) })],
	]) {
		await R.guard(`§7 ${label}`, async () => {
			const w = await W.startWorld();
			await off(w, DIR.soren, "2026-10-20", "2026-10-21");
			await off(w, DIR.hollis, "2026-10-20", "2026-10-21");
			const into = { "Pickup Appointment": "10/20/2026 09:00", "Drop-off Appointment": "10/21/2026 15:00" };
			const writesBefore = w.sheet.log.writes.length;
			const r = await move(w, 3, "7002", into, false);
			eq(`§7 ${label}: Soren's load (Oct 16-17) moved to Oct 20-21, inside his time off: 409 DRIVER_OFF_DUTY naming it`,
				[r.status, r.body && r.body.code, r.body && r.body.offFrom, r.body && r.body.offTo], [409, "DRIVER_OFF_DUTY", "2026-10-20", "2026-10-21"]);
			eq(`§7 ${label}: ...nothing written, nothing audited`, [w.sheet.log.writes.length - writesBefore, confirmed(w).length], [0, 0]);
			const c = await move(w, 3, "7002", into, true);
			const row3 = w.sheet.tabs["Job Tracking"][2];
			eq(`§7 ${label}, confirmed: 200, the dates written, one confirmation audited`,
				[c.status, row3[COL["Pickup Appointment"]], confirmed(w).length], [200, "10/20/2026 09:00", 1]);
			ok(`§7 ${label}: ...the audit names the move's window`, /2026-10-20\.\.2026-10-21/.test((confirmed(w)[0] || {}).details || ""));
			eq(`§7 ${label}: Hollis's load (Oct 20-22, already inside his time off) given a new pickup time the same day: 200, no warning`,
				(await move(w, 2, "7001", { "Pickup Appointment": "10/20/2026 10:00" }, false)).status, 200);
			eq(`§7 ${label}: ...its pickup moved to another day still inside the time off (Oct 21): 409`,
				(await move(w, 2, "7001", { "Pickup Appointment": "10/21/2026 10:00" }, false)).status, 409);
			eq(`§7 ${label}: Soren's load moved out of his time off (Oct 23-24): 200`,
				(await move(w, 3, "7002", { "Pickup Appointment": "10/23/2026 09:00", "Drop-off Appointment": "10/24/2026 15:00" }, false)).status, 200);
			eq(`§7 ${label}: an unassigned load (7003) moved onto Oct 20-21: 200`,
				(await move(w, 4, "7003", into, false)).status, 200);
		});
	}

	section("§8 R11b: time off over loads he already has (pure)");
	await R.guard("§8", async () => {
		const fn = (name) => (lib && typeof lib[name] === "function" ? lib[name] : null);
		eq("§8.0 lib/driver-availability.js exports the four R11b functions",
			["loadsNewlyInTimeOff", "parseConfirmLoads", "timeOffLoadsDecision", "driverHasLoadsBody"].filter((n) => !fn(n)), []);
		// server.js's normalizeDriverName() and normLoadKey(), as far as these cases need.
		const norm = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
		const key = (id) => String(id || "").trim().toLowerCase().replace(/^#/, "");
		const L = (loadId, pickupKey, dropoffKey, driver = "Hollis Renner", truck = "LogisX-#91") => ({ loadId, driver, truck, pickupKey, dropoffKey });
		// Today 2026-10-15.
		const LOADS = [
			L("A1", "2026-10-20", "2026-10-22"),
			L("A2", "2026-10-25", "2026-10-27"),
			L("A3", "2026-10-16", "2026-10-18"),
			L("B1", "2026-10-26", "2026-10-28"),
			L("B2", "2026-10-10", "2026-10-14"),
			L("B3", "", ""),
			L("B4", "2026-10-21", "", "Soren King"),
			L("C1", "2026-10-21", ""),
			L("C2", "", "2026-10-24"),
			L("C3", "2026-10-22", "2026-10-19"),
			L("C4", "2026-10-14", "2026-10-15"),
			L("D1", "2026-10-19", "2026-10-19", " hollis  RENNER "),
			L("", "2026-10-20", "2026-10-20"),
		];
		const newly = (o, loads = LOADS) => (fn("loadsNewlyInTimeOff")
			? fn("loadsNewlyInTimeOff")({ loads, driverName: "Hollis Renner", normalize: norm, todayKey: "2026-10-15", ...o }).map((l) => [l.loadId, l.from, l.to])
			: null);
		eq("§8.1 a new row Oct 18-25: every live load of his overlapping it, by first day; a pickup-only or drop-off-only load is that day, a drop-off before the pickup the pickup day; his name in other spacing counts",
			newly({ from: "2026-10-18", to: "2026-10-25" }),
			[["A3", "2026-10-16", "2026-10-18"], ["D1", "2026-10-19", "2026-10-19"], ["A1", "2026-10-20", "2026-10-22"], ["C1", "2026-10-21", "2026-10-21"],
				["C3", "2026-10-22", "2026-10-22"], ["C2", "2026-10-24", "2026-10-24"], ["A2", "2026-10-25", "2026-10-27"]]);
		eq("§8.2 ...never one that misses the dates (B1), ended before today (B2), has no readable day (B3), another driver's (B4) or has no load id",
			(newly({ from: "2026-10-01", to: "2026-10-31" }) || []).map((x) => x[0]).filter((id) => ["B2", "B3", "B4", ""].includes(id)), []);
		eq("§8.3 a window ending today counts (C4 on Oct 15); one that ended yesterday never does (B2)", newly({ from: "2026-10-10", to: "2026-10-15" }), [["C4", "2026-10-14", "2026-10-15"]]);
		eq("§8.4 an edit from Oct 18-22 to Oct 18-25: only the loads it newly covers", newly({ from: "2026-10-18", to: "2026-10-25", oldFrom: "2026-10-18", oldTo: "2026-10-22" }),
			[["C2", "2026-10-24", "2026-10-24"], ["A2", "2026-10-25", "2026-10-27"]]);
		eq("§8.5 ...a load touching the old dates by one day (A3 on Oct 18) is not newly covered", newly({ from: "2026-10-16", to: "2026-10-18", oldFrom: "2026-10-18", oldTo: "2026-10-18" }), []);
		eq("§8.6 a shrink inside the old dates: none", newly({ from: "2026-10-20", to: "2026-10-22", oldFrom: "2026-10-18", oldTo: "2026-10-25" }), []);
		eq("§8.7 old dates that miss every load: as a new row", newly({ from: "2026-10-26", to: "2026-10-28", oldFrom: "2026-10-01", oldTo: "2026-10-05" }),
			[["A2", "2026-10-25", "2026-10-27"], ["B1", "2026-10-26", "2026-10-28"]]);
		eq("§8.8 unreadable old dates: as a new row", newly({ from: "2026-10-26", to: "2026-10-28", oldFrom: "", oldTo: "soon" }), [["A2", "2026-10-25", "2026-10-27"], ["B1", "2026-10-26", "2026-10-28"]]);
		eq("§8.9 nothing for an unreadable today, reversed dates, no loads or no driver",
			[newly({ from: "2026-10-18", to: "2026-10-25", todayKey: "" }), newly({ from: "2026-10-25", to: "2026-10-18" }), newly({ from: "2026-10-18", to: "2026-10-25" }, null),
				newly({ from: "2026-10-18", to: "2026-10-25", driverName: "  " })], [[], [], [], []]);
		const one = fn("loadsNewlyInTimeOff") ? fn("loadsNewlyInTimeOff")({ loads: [L(" 7001 ", "2026-10-20", "2026-10-22", "Hollis Renner", " LogisX-#91 ")], driverName: "Hollis Renner", normalize: norm, todayKey: "2026-10-15", from: "2026-10-20", to: "2026-10-20" }) : null;
		eq("§8.10 each listed load is { loadId, shownId, from, to }, trimmed, with no Truck cell (shownId the id itself when none is given)", one,
			[{ loadId: "7001", shownId: "7001", from: "2026-10-20", to: "2026-10-22" }]);

		const parse = (v) => (fn("parseConfirmLoads") ? fn("parseConfirmLoads")(v) : "missing");
		const E = (loadId, from = "2026-10-20", to = "2026-10-22") => ({ loadId, from, to });
		eq("§8.11 the echo: a list of { loadId, from, to }, ids trimmed, other keys dropped, repeats once",
			parse([{ ...E(" 7001 "), truck: "T-1", note: "x" }, E("7002", "2026-10-21", "2026-10-21"), E("7001")]), [E("7001"), E("7002", "2026-10-21", "2026-10-21")]);
		eq("§8.12 an empty list is an echo of nothing", parse([]), []);
		eq("§8.13 500 entries are read; 501 are not a confirmation unless the server listed that many",
			[(parse(Array.from({ length: 500 }, (_, i) => E(`L${i}`))) || []).length, parse(Array.from({ length: 501 }, (_, i) => E(`L${i}`))),
				(fn("parseConfirmLoads") ? fn("parseConfirmLoads")(Array.from({ length: 501 }, (_, i) => E(`L${i}`)), { max: 501 }) || [] : []).length], [500, null, 501]);
		eq("§8.14 a 64-character id is read; 65 is not a confirmation", [(parse([E("7".repeat(64))]) || []).length, parse([E("7".repeat(65))])], [1, null]);
		for (const [label, v] of [
			["true", true], ["an object", E("7001")], ["text", "7001"], ["null", null], ["nothing", undefined],
			["an entry that is null", [E("7001"), null]], ["an entry that is a list", [["7001", "2026-10-20", "2026-10-22"]]],
			["a number id", [{ loadId: 7001, from: "2026-10-20", to: "2026-10-22" }]], ["a blank id", [E("   ")]],
			["no last day", [{ loadId: "7001", from: "2026-10-20" }]], ["a US-style day", [E("7001", "10/20/2026")]],
			["a day that does not exist", [E("7001", "2026-02-30", "2026-03-01")]], ["a reversed window", [E("7001", "2026-10-22", "2026-10-20")]],
		]) eq(`§8.15 ${label}: not a confirmation`, parse(v), null);

		const decide = (o) => (fn("timeOffLoadsDecision")
			? fn("timeOffLoadsDecision")({ loads: LOADS, driverName: "Hollis Renner", normalize: norm, loadKey: key, todayKey: "2026-10-15", from: "2026-10-20", to: "2026-10-21", ...o })
			: null);
		const asked = [{ loadId: "A1", from: "2026-10-20", to: "2026-10-22" }, { loadId: "C1", from: "2026-10-21", to: "2026-10-21" }];
		eq("§8.16 listed loads and no echo: ask with the list", decide({}), { ask: asked });
		eq("§8.17 confirmLoads true: ask", decide({ confirmLoads: true }), { ask: asked });
		eq("§8.18 the list echoed: confirm each listed load's window, checked",
			decide({ confirmLoads: [E("A1"), E("C1", "2026-10-21", "2026-10-21")] }), { ask: null, confirm: [E("A1"), E("C1", "2026-10-21", "2026-10-21")], unchecked: false });
		eq("§8.19 ...ids matched as load ids are (\"#a1\" is A1)", (decide({ confirmLoads: [E("#a1"), E("c1", "2026-10-21", "2026-10-21")] }) || {}).confirm, [E("A1"), E("C1", "2026-10-21", "2026-10-21")]);
		eq("§8.20 an echo missing a listed load: ask again with the whole list", decide({ confirmLoads: [E("A1")] }), { ask: asked });
		eq("§8.21 an echo with a load's old window: ask again", decide({ confirmLoads: [E("A1", "2026-10-20", "2026-10-21"), E("C1", "2026-10-21", "2026-10-21")] }), { ask: asked });
		eq("§8.22 an echo naming more than is listed: confirm the listed loads only",
			(decide({ confirmLoads: [E("A1"), E("C1", "2026-10-21", "2026-10-21"), E("Z9")] }) || {}).confirm, [E("A1"), E("C1", "2026-10-21", "2026-10-21")]);
		eq("§8.23 nothing listed: no ask, nothing confirmed, whatever the echo", decide({ from: "2026-11-20", to: "2026-11-21", confirmLoads: [E("A1")] }), { ask: null, confirm: [], unchecked: false });
		eq("§8.24 the sheet unreadable (loads null), no echo: save unchecked", decide({ loads: null }), { ask: null, confirm: [], unchecked: true });
		eq("§8.25 ...with an echo: each echoed load overlapping the new dates, as given, its window kept to them",
			decide({ loads: null, confirmLoads: [E("A1"), E("Q7", "2026-10-22", "2026-10-23"), E("C1", "2026-10-21", "2026-10-21")] }),
			{ ask: null, confirm: [E("A1", "2026-10-20", "2026-10-21"), E("C1", "2026-10-21", "2026-10-21")], unchecked: true });
		eq("§8.26 ...with a malformed echo: unchecked, nothing confirmed", decide({ loads: null, confirmLoads: true }), { ask: null, confirm: [], unchecked: true });

		const body = (o) => (fn("driverHasLoadsBody") ? fn("driverHasLoadsBody")({ driverName: "Hollis Renner", from: "2026-10-20", to: "2026-10-21", ...o }) : null);
		eq("§8.27 the 409 body for one load", body({ loads: [asked[0]] }), {
			error: "Hollis Renner has load A1 on Oct 20 – Oct 22 inside these dates. Save anyway? The load stays assigned to him.",
			code: "DRIVER_HAS_LOADS", driver: "Hollis Renner", from: "2026-10-20", to: "2026-10-21", loads: [asked[0]],
		});
		eq("§8.28 ...a one-day load", (body({ loads: [asked[1]] }) || {}).error, "Hollis Renner has load C1 on Oct 21 inside these dates. Save anyway? The load stays assigned to him.");
		eq("§8.29 ...two loads", (body({ loads: asked }) || {}).error, "Hollis Renner has 2 loads inside these dates: A1 (Oct 20 – Oct 22), C1 (Oct 21). Save anyway? The loads stay assigned to him.");
		const seven = Array.from({ length: 7 }, (_, i) => ({ loadId: `M${i + 1}`, from: `2026-10-2${i}`, to: `2026-10-2${i}`, truck: "" }));
		eq("§8.30 ...seven loads: the first five named, the rest counted", (body({ loads: seven }) || {}).error,
			"Hollis Renner has 7 loads inside these dates: M1 (Oct 20), M2 (Oct 21), M3 (Oct 22), M4 (Oct 23), M5 (Oct 24) and 2 more. Save anyway? The loads stay assigned to him.");
		eq("§8.31 ...a blank name", (body({ driverName: " ", loads: [asked[0]] }) || {}).error, "This driver has load A1 on Oct 20 – Oct 22 inside these dates. Save anyway? The load stays assigned to him.");
		eq("§8.32 ...each load copied as { loadId, from, to } only (no Truck cell)",
			(body({ loads: [{ ...asked[0], truck: "LogisX-#91", shownId: "A1", driver: "Hollis Renner", pickupKey: "2026-10-20" }] }) || {}).loads, [asked[0]]);

		// The security review's fixes (2026-10-19).
		const newlyIds = (loads, o = {}) => (fn("loadsNewlyInTimeOff")
			? fn("loadsNewlyInTimeOff")({ loads, driverName: "Hollis Renner", normalize: norm, todayKey: "2026-10-15", from: "2026-10-20", to: "2026-10-21", ...o }).map((l) => l.loadId)
			: null);
		eq("§8.33 L1: a load whose id is over 64 characters is skipped, like one with none; 64 is listed",
			newlyIds([L("7".repeat(65), "2026-10-20", ""), L("8".repeat(64), "2026-10-20", ""), L("A1", "2026-10-20", "")]), ["8".repeat(64), "A1"]);
		eq("§8.34 L1: ...so is one whose id as the viewer is shown it is over 64 characters",
			newlyIds([{ ...L("A1", "2026-10-20", ""), shownId: `A1 ${"x".repeat(62)}` }, { ...L("A2", "2026-10-20", ""), shownId: "A2 [contact withheld]" }]), ["A2"]);
		const many = Array.from({ length: 60 }, (_, i) => L(`N${String(i).padStart(2, "0")}`, "2026-10-20", "2026-10-21"));
		const manyAsk = decide({ loads: many });
		const manyDone = decide({ loads: many, confirmLoads: manyAsk && Array.isArray(manyAsk.ask) ? manyAsk.ask : [] });
		eq("§8.35 L1: 60 listed loads, all echoed: confirmed, all 60", [manyAsk && Array.isArray(manyAsk.ask) ? manyAsk.ask.length : null, manyDone && manyDone.ask, manyDone && Array.isArray(manyDone.confirm) ? manyDone.confirm.length : null],
			[60, null, 60]);
		eq("§8.36 L2: unchecked, an echoed window reaching past the time off (to 2099) is recorded clamped to its days",
			(decide({ loads: null, confirmLoads: [E("A1", "2026-10-15", "2099-12-31"), E("C1", "2026-10-21", "2026-10-21")] }) || {}).confirm,
			[E("A1", "2026-10-20", "2026-10-21"), E("C1", "2026-10-21", "2026-10-21")]);
		const shown = [
			{ ...L("7710 ops@broker.example", "2026-10-20", "2026-10-22"), shownId: "7710 [contact withheld]" },
			{ ...L("ops@broker.example", "2026-10-21", ""), shownId: "[contact withheld]" },
		];
		const shownAsk = decide({ loads: shown });
		eq("§8.37 R1: the ask lists each load by the id the viewer is shown, never the stored one",
			shownAsk, { ask: [E("7710 [contact withheld]", "2026-10-20", "2026-10-22"), E("[contact withheld]", "2026-10-21", "2026-10-21")] });
		eq("§8.38 R1: ...that echo confirms, recording the stored ids",
			decide({ loads: shown, confirmLoads: shownAsk && shownAsk.ask }),
			{ ask: null, confirm: [E("7710 ops@broker.example", "2026-10-20", "2026-10-22"), E("ops@broker.example", "2026-10-21", "2026-10-21")], unchecked: false });
		eq("§8.39 R1: ...an echo of the stored ids, not what he was shown, asks again",
			(decide({ loads: shown, confirmLoads: [E("7710 ops@broker.example", "2026-10-20", "2026-10-22"), E("ops@broker.example", "2026-10-21", "2026-10-21")] }) || {}).ask,
			shownAsk && shownAsk.ask);
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
