#!/usr/bin/env node
/**
 * The load phases report (plan F, PR 1): scripts/load-phases-report.js, run as
 * a child on a made-up database built from server.js's own DDL, as of Fri
 * 2026-10-30 16:00 EDT with a 28-day window. Read-only, no network, names
 * withheld; the POD-trigger backtest, the pay effect (parity with the weekly
 * invoice's generate route) and the switch-on criteria.
 *
 * Drivers Avery Quill (T1, device vid-t1), Bram Tollen (T2) and Cora Vint (T3);
 * $300 a day each. Loads (all made up; "geo" is the geofence's row):
 *   L-2001 A  geo At Receiver Tue 10/13 13:05, POD 14:20, tap 14:23: fires;
 *             the truck leaves the drop-off at 14:40 (the receiver exit)
 *   L-2002 A  manual At Receiver, POD with a fix inside the fence 2 min before:
 *             receiver_not_gps; F7 (b) would fire
 *   L-2003 B  POD while In Transit (drop 1): not_at_receiver; then geo At
 *             Receiver and a POD: fires
 *   L-2004 C  Fri 10/23 23:50 POD, Sat 00:05 tap, blank drop-off: a week change
 *   L-2005 B  Wed 10/28 23:55 POD, Thu 00:03 tap, blank drop-off: one day
 *   L-2006 C  the office uploads the POD (Dispatcher): staff_upload
 *   L-2007 A  a second POD file 20 minutes after the first: criterion 7
 *   L-2008 B  geo arrival, a staff revert, a second geo arrival, then the POD:
 *             fires on the second run
 *   L-2012 C  an override At Receiver: receiver_not_gps
 *   L-2013 C  its only POD filed at the shipper: not_at_receiver, and it keeps
 *             the Delivered button (L7)
 *   L-2015    a cancelled copy names C, the live row A: C's POD is not_his_row
 *   L-2016 B  two live rows: ambiguous
 *   L-2017 B  Assigned in September, closed 10/5: month_closed
 *   L-2018 A  its only sheet row is cancelled: load_cancelled
 * C's Oct 22 is removed from his pay (an override the invoice code honours).
 * Planted (the gate fixture): L-2019 B fires, then a manual In Transit and a
 * second geo arrival (a false completion); L-2020 C fires on a POD deleted
 * 10 minutes later (withdrawn) and gets a POD after its tap (already_completed);
 * L-2021 A's August closed after its upload (it fires); L-2022 C a Super
 * Admin's Dispatched then Delivered (a staff correction); L-2023 B a
 * Friday-night week change with a drop-off set (listed in the pay effect);
 * L-2024 C a midnight day change in the same week with one set (not listed).
 * The clean fixture: thirty deliveries that pass every checked criterion.
 *
 * Run: node scripts/test-load-phases-report.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const fs = require("fs");
const path = require("path");
const W = require("./lib/work-days-world");

const SCRIPT = "scripts/load-phases-report.js";
const REPORT = path.join(W.ROOT, SCRIPT);
const NOW = "2026-10-30T20:00:00Z";
const A = "Avery Quill";
const B = "Bram Tollen";
const C = "Cora Vint";
const NAME_RE = /Avery|Quill|Bram|Tollen|Cora|Vint/;
const ID_RE = /l-20\d\d|L-20\d\d/;
const iso = (wall) => new Date(W.etMs(wall)).toISOString();
const geoReason = (m, side = "delivery") => `auto by GPS — ${m} m from the mapped ${side} point (radius 3218.69 m)`;

// One load's sheet row (work-days-world's columns), Delivered unless told.
const row = (id, driver, { pickup = "", dropoff = "", assigned = "", done = "", status = "Delivered", truck = "" } = {}) => {
	const r = W.loadRow({ id, driver, pickup, dropoff, assigned, status, truck });
	r["Status Update Date"] = done;
	r["Completion Date"] = /delivered/i.test(status) ? done : "";
	return r;
};

function fixture({ planted = false } = {}) {
	const rows = [
		row("L-2001", A, { pickup: "2026-10-12 8:00", dropoff: "2026-10-13 15:00", assigned: "2026-10-12", done: "10/13/2026 14:23:00", truck: "T1" }),
		row("L-2002", A, { pickup: "2026-10-14 8:00", dropoff: "2026-10-15 10:00", assigned: "2026-10-14", done: "10/15/2026 9:16:00", truck: "T1" }),
		row("L-2003", B, { pickup: "2026-10-19 8:00", dropoff: "2026-10-19 18:00", assigned: "2026-10-19", done: "10/19/2026 17:40:00", truck: "T2" }),
		row("L-2004", C, { pickup: "2026-10-21 8:00", dropoff: "", assigned: "2026-10-21", done: "10/24/2026 0:05:00", truck: "T3" }),
		row("L-2005", B, { pickup: "2026-10-26 8:00", dropoff: "", assigned: "2026-10-26", done: "10/29/2026 0:03:00", truck: "T2" }),
		row("L-2006", C, { pickup: "2026-10-26 9:00", dropoff: "2026-10-27 12:00", assigned: "2026-10-26", done: "10/27/2026 11:45:00", truck: "T9" }),
		row("L-2007", A, { pickup: "2026-10-05 8:00", dropoff: "2026-10-06 11:00", assigned: "2026-10-05", done: "10/6/2026 10:55:00", truck: "T1" }),
		row("L-2008", B, { pickup: "2026-10-06 8:00", dropoff: "2026-10-07 12:00", assigned: "2026-10-06", done: "10/7/2026 11:20:00", truck: "T2" }),
		row("L-2012", C, { pickup: "2026-10-08 8:00", dropoff: "2026-10-08 16:00", assigned: "2026-10-08", done: "10/8/2026 15:20:00", truck: "T3" }),
		row("L-2013", C, { pickup: "2026-10-09 8:00", dropoff: "2026-10-12 11:00", assigned: "2026-10-09", done: "10/12/2026 10:20:00", truck: "T3" }),
		row("L-2015", C, { pickup: "2026-10-13 8:00", dropoff: "2026-10-14 17:00", assigned: "2026-10-13", status: "Cancelled", truck: "T3" }),
		row("L-2015", A, { pickup: "2026-10-13 8:00", dropoff: "2026-10-14 17:00", assigned: "2026-10-13", done: "10/14/2026 16:30:00", truck: "T1" }),
		row("L-2016", B, { pickup: "2026-10-15 8:00", dropoff: "2026-10-16 15:00", assigned: "2026-10-15", done: "10/16/2026 14:40:00", truck: "T2" }),
		row("L-2016", B, { pickup: "2026-10-15 8:00", dropoff: "2026-10-16 15:00", assigned: "2026-10-15", status: "Dispatched", truck: "T2" }),
		row("L-2017", B, { pickup: "2026-09-29 8:00", dropoff: "2026-10-08 10:00", assigned: "2026-09-29", status: "At Receiver", truck: "T2" }),
		row("L-2018", A, { pickup: "2026-10-26 8:00", dropoff: "2026-10-27 12:00", assigned: "2026-10-26", status: "Cancelled", truck: "T1" }),
	];
	if (planted) {
		rows.push(row("L-2019", B, { pickup: "2026-10-20 8:00", dropoff: "2026-10-20 13:00", assigned: "2026-10-20", done: "10/20/2026 12:15:00", truck: "T2" }));
		rows.push(row("L-2020", C, { pickup: "2026-10-21 8:00", dropoff: "2026-10-22 10:00", assigned: "2026-10-21", done: "10/22/2026 9:30:00", truck: "T3" }));
		rows.push(row("L-2021", A, { pickup: "2026-08-28 8:00", dropoff: "2026-10-09 11:00", assigned: "2026-08-28", done: "10/9/2026 10:40:00", truck: "T1" }));
		rows.push(row("L-2022", C, { pickup: "2026-10-26 8:00", dropoff: "2026-10-26 12:00", assigned: "2026-10-26", done: "10/26/2026 13:00:06", truck: "T3" }));
		rows.push(row("L-2023", B, { pickup: "2026-10-15 8:00", dropoff: "2026-10-16 23:00", assigned: "2026-10-15", done: "10/17/2026 0:02:00", truck: "T2" }));
		rows.push(row("L-2024", C, { pickup: "2026-10-20 8:00", dropoff: "2026-10-21 23:00", assigned: "2026-10-20", done: "10/22/2026 0:01:00", truck: "T3" }));
	}
	// vid-t1: parked at L-2001's drop-off (a slow drift outside the fence at
	// 13:30 is no exit), then leaving at 14:40; two fixes at L-2002's drop-off
	// before its POD.
	const pings = [];
	for (let m = 0; m <= 100; m += 10) pings.push({ ms: W.etMs("2026-10-13 12:50") + m * 60000, lat: 32.0005, lng: -96.0, odo: 1000, speed: 0 });
	pings.push({ ms: W.etMs("2026-10-13 13:35"), lat: 32.1, lng: -96.0, odo: 1000, speed: 1 });
	pings.push({ ms: W.etMs("2026-10-13 14:40"), lat: 32.1, lng: -96.0, odo: 1007, speed: 20 });
	pings.push({ ms: W.etMs("2026-10-15 09:05"), lat: 31.0005, lng: -97.0, odo: 1100, speed: 0 });
	pings.push({ ms: W.etMs("2026-10-15 09:10"), lat: 31.0005, lng: -97.0, odo: 1100, speed: 0 });
	// vid-t2 sat on T3 until Oct 16 08:00 ET and has been T2's since: its Oct 15
	// fix was C's truck, so B's L-2016 has no ELD data.
	const t2Pings = [{ ms: W.etMs("2026-10-15 11:00"), lat: 30.0, lng: -95.0, odo: 500, speed: 0 }];
	const w = W.startWorld({
		env: {},
		drivers: [{ name: A, payDaily: 300 }, { name: B, payDaily: 300 }, { name: C, payDaily: 300 }],
		trucks: [{ unit: "T1", driver: A, vid: "vid-t1" }, { unit: "T2", driver: B, vid: "vid-t2" }, { unit: "T3", driver: C }],
		rows,
		pings: { "vid-t1": pings, "vid-t2": t2Pings },
		// A Super Admin removed Oct 22 from C's pay: the invoice code honours it.
		overrides: [{ driver: C, day: "2026-10-22", action: "remove" }],
		now: Date.parse(NOW),
		expose: ["appStamp"],
	});
	const db = w.db;
	const lock = db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES (?, 'locked', ?, 'test')");
	lock.run("2026-09", "2026-10-05T05:00:00.000Z");
	// August closed after L-2021's upload: open when it came.
	if (planted) lock.run("2026-08", "2026-10-20T05:00:00.000Z");
	db.prepare("INSERT INTO server_state (key, value) VALUES ('eld_device_history_started', ?)").run(JSON.stringify({ atMs: Date.parse("2026-10-01T00:00:00Z") }));
	const link = db.prepare("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_until, assigned_by) VALUES (?, 'vid-t2', ?, ?, 'test')");
	link.run(3, "2026-10-10T00:00:00.000Z", "2026-10-16T12:00:00.000Z");
	link.run(2, "2026-10-16T12:00:00.000Z", "");
	const hist = db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, reason, actor_role, changed_at) VALUES (?, '', ?, ?, ?, ?, ?, ?)");
	const audit = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, 'update_status', 'load', ?, ?)");
	const doc = db.prepare("INSERT INTO documents (load_id, driver, type, file_name, uploaded_at, deleted_at, uploaded_by_user_id, uploaded_by_role) VALUES (?, ?, 'POD', 'x.pdf', ?, ?, ?, ?)");
	// [load, status, source, wall time ET, actor, { role (audit session), actorRole, reason }]
	const s = (lid, status, source, wall, actor, o = {}) => {
		hist.run(lid.toLowerCase(), status, source, actor, o.reason || (source === "geofence" ? geoReason(300, status === "At Shipper" ? "pickup" : "delivery") : ""), o.actorRole || "", W.et(wall));
		if (o.role) audit.run(iso(wall), o.role === "Driver" ? 10 : 1, o.role === "Driver" ? "drv" : "super_admin", o.role, lid, `Status changed to "${status}" for load ${lid} (driver: ${actor})`);
	};
	const tap = (lid, status, wall, actor) => s(lid, status, "manual", wall, actor, { role: "Driver" });
	const pod = (lid, driver, wall, role = "Driver", deleted = null) => doc.run(lid, driver, W.et(wall), deleted ? W.et(deleted) : null, role === "Driver" ? 10 : 1, role);
	const start = (lid, driver, wall) => { s(lid, "Dispatched", "dispatch", wall, "super_admin"); s(lid, "Assigned", "accept", wall.replace(/:00$/, ":10"), driver); };

	start("L-2001", A, "2026-10-12 08:00");
	s("L-2001", "Heading to Shipper", "manual", "2026-10-12 08:30", A, { role: "Super Admin" });
	s("L-2001", "At Shipper", "geofence", "2026-10-12 10:00", A, { reason: geoReason(420, "pickup") });
	tap("L-2001", "Loading", "2026-10-12 10:30", A);
	s("L-2001", "In Transit", "geofence", "2026-10-12 12:00", A);
	s("L-2001", "At Receiver", "geofence", "2026-10-13 13:05", A, { reason: geoReason(640) });
	pod("L-2001", A, "2026-10-13 14:20");
	tap("L-2001", "Delivered", "2026-10-13 14:23", A);

	start("L-2002", A, "2026-10-14 08:00");
	tap("L-2002", "At Receiver", "2026-10-15 09:00", A);
	pod("L-2002", A, "2026-10-15 09:12");
	s("L-2002", "Delivered", "manual", "2026-10-15 09:16", A, { actorRole: "Driver" });

	start("L-2003", B, "2026-10-19 07:00");
	tap("L-2003", "Heading to Shipper", "2026-10-19 07:30", B);
	tap("L-2003", "In Transit", "2026-10-19 12:00", B);
	pod("L-2003", B, "2026-10-19 15:00");
	s("L-2003", "At Receiver", "geofence", "2026-10-19 17:00", B, { reason: geoReason(1500) });
	pod("L-2003", B, "2026-10-19 17:30");
	tap("L-2003", "Delivered", "2026-10-19 17:40", B);

	start("L-2004", C, "2026-10-21 07:00");
	s("L-2004", "At Receiver", "geofence", "2026-10-23 22:30", C, { reason: geoReason(2600) });
	pod("L-2004", C, "2026-10-23 23:50");
	tap("L-2004", "Delivered", "2026-10-24 00:05", C);

	start("L-2005", B, "2026-10-26 07:00");
	s("L-2005", "At Receiver", "geofence", "2026-10-28 23:40", B);
	pod("L-2005", B, "2026-10-28 23:55");
	tap("L-2005", "Delivered", "2026-10-29 00:03", B);

	start("L-2006", C, "2026-10-26 09:00");
	s("L-2006", "At Receiver", "geofence", "2026-10-27 11:00", C);
	pod("L-2006", C, "2026-10-27 11:30", "Dispatcher");
	tap("L-2006", "Delivered", "2026-10-27 11:45", C);

	start("L-2007", A, "2026-10-05 08:00");
	s("L-2007", "At Receiver", "geofence", "2026-10-06 10:00", A);
	pod("L-2007", A, "2026-10-06 10:30");
	pod("L-2007", A, "2026-10-06 10:50");
	tap("L-2007", "Delivered", "2026-10-06 10:55", A);

	start("L-2008", B, "2026-10-06 07:00");
	s("L-2008", "At Receiver", "geofence", "2026-10-07 09:00", B);
	s("L-2008", "In Transit", "override", "2026-10-07 09:20", "super_admin");
	s("L-2008", "At Receiver", "geofence", "2026-10-07 11:00", B);
	pod("L-2008", B, "2026-10-07 11:15");
	tap("L-2008", "Delivered", "2026-10-07 11:20", B);

	start("L-2012", C, "2026-10-08 07:00");
	s("L-2012", "In Transit", "geofence", "2026-10-08 12:00", C);
	s("L-2012", "At Receiver", "override", "2026-10-08 15:00", "dispatcher1");
	pod("L-2012", C, "2026-10-08 15:10");
	tap("L-2012", "Delivered", "2026-10-08 15:20", C);

	start("L-2013", C, "2026-10-09 07:00");
	s("L-2013", "At Shipper", "manual", "2026-10-09 09:00", C);
	pod("L-2013", C, "2026-10-09 09:30");
	s("L-2013", "At Receiver", "geofence", "2026-10-12 10:00", C);
	tap("L-2013", "Delivered", "2026-10-12 10:20", C);

	start("L-2015", A, "2026-10-13 07:00");
	s("L-2015", "At Receiver", "geofence", "2026-10-14 16:00", A);
	pod("L-2015", C, "2026-10-14 16:10");
	pod("L-2015", A, "2026-10-14 16:20");
	tap("L-2015", "Delivered", "2026-10-14 16:30", A);

	start("L-2016", B, "2026-10-15 07:00");
	s("L-2016", "At Receiver", "geofence", "2026-10-16 14:00", B);
	pod("L-2016", B, "2026-10-16 14:30");
	tap("L-2016", "Delivered", "2026-10-16 14:40", B);

	start("L-2017", B, "2026-09-29 07:00");
	s("L-2017", "At Receiver", "geofence", "2026-10-08 09:00", B);
	pod("L-2017", B, "2026-10-08 09:30");

	start("L-2018", A, "2026-10-26 07:00");
	s("L-2018", "At Receiver", "geofence", "2026-10-27 10:00", A);
	pod("L-2018", A, "2026-10-27 10:10");
	s("L-2018", "Cancelled", "cancel", "2026-10-27 12:00", "super_admin");

	if (planted) {
		start("L-2021", A, "2026-08-28 07:00");
		s("L-2021", "At Receiver", "geofence", "2026-10-09 10:00", A);
		pod("L-2021", A, "2026-10-09 10:30");
		tap("L-2021", "Delivered", "2026-10-09 10:40", A);

		start("L-2022", C, "2026-10-26 07:00");
		s("L-2022", "At Receiver", "geofence", "2026-10-26 10:00", C);
		pod("L-2022", C, "2026-10-26 10:10");
		s("L-2022", "Dispatched", "manual", "2026-10-26 13:00", C, { role: "Super Admin" });
		s("L-2022", "Delivered", "manual", "2026-10-26 13:00", C, { role: "Super Admin" });

		start("L-2023", B, "2026-10-15 07:00");
		s("L-2023", "At Receiver", "geofence", "2026-10-16 23:30", B);
		pod("L-2023", B, "2026-10-16 23:55");
		tap("L-2023", "Delivered", "2026-10-17 00:02", B);

		start("L-2024", C, "2026-10-20 07:00");
		s("L-2024", "At Receiver", "geofence", "2026-10-21 23:30", C);
		pod("L-2024", C, "2026-10-21 23:58");
		tap("L-2024", "Delivered", "2026-10-22 00:01", C);

		start("L-2019", B, "2026-10-20 07:00");
		s("L-2019", "At Receiver", "geofence", "2026-10-20 10:00", B);
		pod("L-2019", B, "2026-10-20 10:10", null);
		tap("L-2019", "In Transit", "2026-10-20 10:40", B);
		s("L-2019", "At Receiver", "geofence", "2026-10-20 12:00", B);
		pod("L-2019", B, "2026-10-20 12:10");
		tap("L-2019", "Delivered", "2026-10-20 12:15", B);

		start("L-2020", C, "2026-10-21 07:00");
		s("L-2020", "At Receiver", "geofence", "2026-10-22 09:00", C);
		pod("L-2020", C, "2026-10-22 09:10", "Driver", "2026-10-22 09:20");
		pod("L-2020", C, "2026-10-22 09:25");
		tap("L-2020", "Delivered", "2026-10-22 09:30", C);
		pod("L-2020", C, "2026-10-22 09:40");
	}

	const co = db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng) VALUES (?, 34.0, -95.1, ?, ?)");
	const dests = { "L-2001": [32.0, -96.0], "L-2002": [31.0, -97.0], "L-2016": [null, null] };
	for (const id of ["L-2001", "L-2002", "L-2003", "L-2004", "L-2005", "L-2006", "L-2007", "L-2008", "L-2013", "L-2015", "L-2016", "L-2017", "L-2018",
		"L-2019", "L-2020", "L-2021", "L-2022", "L-2023"]) {
		const [lat, lng] = dests[id] || [30.5, -95.5];
		co.run(id, lat, lng);
	}
	const alert = db.prepare("INSERT INTO ratecon_extract_alerts (load_id, unusable, first_seen) VALUES (?, 'pickup', ?)");
	alert.run("L-2012", W.et("2026-10-08 06:00"));
	alert.run("L-9999", W.et("2026-10-10 06:00"));
	return w;
}

// Thirty clean deliveries (a geofence arrival, the driver's POD 10 minutes
// later, his tap 3 minutes after that): every checked criterion passes.
function cleanFixture() {
	const loads = [];
	for (let i = 0; i < 30; i++) {
		const day = W.addDays("2026-10-03", i % 27);
		loads.push({ id: `L-${3001 + i}`, day, hh: String(9 + Math.floor(i / 27)).padStart(2, "0") });
	}
	const w = W.startWorld({
		env: {},
		drivers: [{ name: B, payDaily: 300 }],
		trucks: [{ unit: "T2", driver: B }],
		rows: loads.map((l) => row(l.id, B, { pickup: `${l.day} 7:00`, dropoff: `${l.day} 12:00`, assigned: l.day, done: `${W.md(l.day)} ${Number(l.hh)}:13:00`, truck: "T2" })),
		now: Date.parse(NOW),
	});
	const hist = w.db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, changed_at) VALUES (?, '', ?, ?, ?, ?)");
	const doc = w.db.prepare("INSERT INTO documents (load_id, driver, type, file_name, uploaded_at, uploaded_by_user_id, uploaded_by_role) VALUES (?, ?, 'POD', 'x.pdf', ?, 10, 'Driver')");
	for (const l of loads) {
		hist.run(l.id.toLowerCase(), "Dispatched", "dispatch", "super_admin", W.et(`${l.day} 06:00`));
		hist.run(l.id.toLowerCase(), "At Receiver", "geofence", B, W.et(`${l.day} ${l.hh}:00`));
		doc.run(l.id, B, W.et(`${l.day} ${l.hh}:10`));
		hist.run(l.id.toLowerCase(), "Delivered", "manual", B, W.et(`${l.day} ${l.hh}:13`));
	}
	return w;
}

const argsFor = (copy, extra) => [`--db=${copy.db}`, `--env-file=${copy.envFile}`, `--now=${NOW}`, ...extra];
// Objects compared whatever their key order.
const canon = (x) => (Array.isArray(x) ? x.map(canon)
	: x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const criteria = (j) => Object.fromEntries(((j && j.criteria) || []).map((c) => [String(c.n), c.verdict]));

const R = W.createRunner("Load phases PR 1: the read-only report (scripts/load-phases-report.js)");

(async () => {
	const base = fixture();
	const copy = W.saveCopy(base, {});
	const before = W.fileHash(copy.db);
	const filesBefore = fs.readdirSync(copy.dir).sort();
	const noSheet = W.runScript(SCRIPT, argsFor(copy, ["--ids", "--json"]));
	const withSheet = W.runScript(SCRIPT, argsFor(copy, ["--ids", "--json", `--values-json=${copy.values}`]));
	const j0 = noSheet.json || {};
	const j = withSheet.json || {};
	const ran = (ok, r) => ok("the report exits 0 with JSON", r.code === 0 && !!r.json, (r.stderr || r.stdout).slice(0, 400));
	const load = (jj, id) => ((jj.backtest && jj.backtest.loads) || []).filter((x) => x.load === id.toLowerCase());

	await R.test("1 Refused (exit 2): no --db, --days outside 1-120, a --now with no zone, --sheet-id (no network read), an empty --values-json", async ({ eq: eqRaw }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		const empty = path.join(copy.dir, "empty.json");
		fs.writeFileSync(empty, JSON.stringify({ values: [] }));
		const code = (extra) => W.runScript(SCRIPT, extra).code;
		eq("[no db, days 0, days 121, bad now, sheet-id, empty values]", [
			code([`--env-file=${copy.envFile}`]),
			code(argsFor(copy, ["--days=0"])), code(argsFor(copy, ["--days=121"])),
			code([`--db=${copy.db}`, `--env-file=${copy.envFile}`, "--now=2026-10-30T16:00"]),
			code(argsFor(copy, ["--sheet-id=abc"])), code(argsFor(copy, [`--values-json=${empty}`])),
		], [2, 2, 2, 2, 2, 2]);
		fs.rmSync(empty);
	});

	await R.test("2 Read-only: the database file is unchanged byte for byte, its folder holds no new file, a write through the report's handle throws, and its own SQL only reads", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		ran(ok, withSheet);
		W.runScript(SCRIPT, argsFor(copy, [`--values-json=${copy.values}`, "--gate"]));
		eq("the database file", W.fileHash(copy.db), before);
		eq("the folder", fs.readdirSync(copy.dir).sort(), filesBefore);
		const { openReadOnly } = require(REPORT);
		const db = openReadOnly(copy.db);
		let threw = false;
		try { db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity) VALUES ('x', 0, 'x', 'x', 'x', 'x')").run(); } catch (e) { threw = /readonly|read-only/i.test(e.message); }
		db.close();
		ok("a write through the handle throws (read-only)", threw);
		const src = fs.readFileSync(REPORT, "utf8").replace(/\/\/.*$/gm, "");
		ok("no writing statement in the report's SQL", !/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|VACUUM)\b\s/i.test(src.replace(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g, (m) => (/\b(SELECT|PRAGMA)\b/i.test(m) ? m : "''"))));
	});

	await R.test("3 No network: a run that reads the sheet and lifts the invoice code loads no network module, and the lift denies every writer and sender", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		const hook = path.join(copy.dir, "..", `net-hook-${process.pid}.js`);
		fs.writeFileSync(hook, [
			"const Module = require('module');",
			"const seen = new Set();",
			"const NET = /^(?:node:)?(?:http|https|http2|net|tls|dns|dgram)$|^(?:googleapis|undici|node-fetch|axios|nodemailer)$/;",
			"const load = Module._load;",
			"Module._load = function (request, ...rest) { if (NET.test(request)) seen.add(request); return load.call(this, request, ...rest); };",
			"process.on('exit', () => { process.stderr.write(`NETWORK_MODULES ${JSON.stringify([...seen])}\\n`); });",
		].join("\n"));
		const r = require("child_process").spawnSync(process.execPath, ["--require", hook, REPORT, ...argsFor(copy, ["--json", `--values-json=${copy.values}`])], { encoding: "utf8", env: { ...process.env, TZ: "UTC" }, timeout: 60000 });
		fs.rmSync(hook);
		const m = /NETWORK_MODULES (\[.*\])/.exec(r.stderr || "");
		eq("[exit, network modules loaded]", [r.status, m ? JSON.parse(m[1]) : "no line"], [0, []]);
		const { LIFT_DENIED, LIFT_ROOTS, SHEET_ROOTS } = require(REPORT);
		ok("the writers and senders are denied, and none is a root", ["logAudit", "recordStatusChange", "jtCacheInvalidate", "getSheets", "sendEmail", "emitDispatchNotice"].every((n) => LIFT_DENIED.includes(n))
			&& ![...LIFT_ROOTS, ...SHEET_ROOTS].some((n) => LIFT_DENIED.includes(n)));
	});

	await R.test("4 Names withheld: drivers print as \"driver N\" and loads as \"load N\" without --ids; no driver name or load ID appears in the text or the JSON", async ({ ok }) => {
		const text = W.runScript(SCRIPT, argsFor(copy, [`--values-json=${copy.values}`]));
		const json = W.runScript(SCRIPT, argsFor(copy, [`--values-json=${copy.values}`, "--json"]));
		ok("the text runs", text.code === 0 && /nothing was written/i.test(text.stdout), (text.stderr || text.stdout).slice(0, 300));
		ok("no name or load ID in the text", !NAME_RE.test(text.stdout) && !ID_RE.test(text.stdout), (text.stdout.match(NAME_RE) || text.stdout.match(ID_RE) || [""])[0]);
		ok("no name or load ID in the JSON", !NAME_RE.test(json.stdout) && !ID_RE.test(json.stdout));
		ok("labels in their place", /\bload \d+\b/.test(text.stdout) && /\bdriver \d+\b/.test(text.stdout));
	});

	await R.test("5 Phase writers: a manual row's session role comes from its actor_role, else the update_status audit row of the same load and status within 5 s (the Super Admin's Heading on a driver's load reads Super Admin)", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		ran(ok, noSheet);
		const w = j0.writers || {};
		eq("Heading to Shipper", w.byPhase && w.byPhase["Heading to Shipper"], { "Super Admin": 1, Driver: 1 });
		eq("At Shipper (geofence, and a tap with no audit row)", w.byPhase && w.byPhase["At Shipper"], { geofence: 1, unmatched: 1 });
		eq("Heading to Shipper is not a geofence phase", Object.keys((w.byPhase && w.byPhase["Heading to Shipper"]) || {}).includes("geofence"), false);
		eq("Delivered", w.byPhase && w.byPhase.Delivered, { Driver: 12 });
		eq("Dispatched: L-2017's September dispatch is outside the window", w.byPhase && w.byPhase.Dispatched, { dispatch: 13 });
		eq("At Receiver", w.byPhase && w.byPhase["At Receiver"], { Driver: 1, geofence: 13, override: 1 });
		eq("[manual rows, role from actor_role, audit, none]", [w.manualRows, w.roleFrom], [18, { actor_role: 1, audit: 16, none: 1 }]);
	});

	await R.test("6 The backtest without the sheet: each upload fires or doesn't for the right reason (geofence arrival, manual, In Transit, an override, a staff upload, two uploads, a revert and a second arrival)", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		ran(ok, noSheet);
		const b = j0.backtest || {};
		eq("outcomes", b.outcomes, { already_fired: 2, not_at_receiver: 2, receiver_not_gps: 2, staff_upload: 1, would_fire: 10 });
		eq("[L-2001 fires, L-2002 not, L-2003 the second upload fires, L-2008 fires once]", [load(j0, "L-2001").length, load(j0, "L-2002").length, load(j0, "L-2003").map((x) => x.upload), load(j0, "L-2008").map((x) => x.upload)],
			[1, 0, ["2026-10-19 17:30"], ["2026-10-07 11:15"]]);
		eq("without the sheet, the closed-month load fires and is never delivered (criterion 1 fails), and the sheet half is not checked", [load(j0, "L-2017").map((x) => x.follow), criteria(j0)["1"], criteria(j0)["5"], criteria(j0).pay], [["never_delivered"], "FAIL", "NOT CHECKED", "NOT CHECKED"]);
		eq("pay effect not computed", j0.pay, null);
	});

	await R.test("7 The sheet half (as the sheet reads now): a cancelled copy naming another driver gives not_his_row, only cancelled rows load_cancelled, two live rows ambiguous, a month closed before the upload month_closed (the server's period guard, lifted)", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		ran(ok, withSheet);
		const b = j.backtest || {};
		eq("refusals", b.sheetOutcomes, { ambiguous: 1, load_cancelled: 1, month_closed: 1, not_his_row: 1 });
		eq("outcomes", b.outcomes, { already_fired: 1, ambiguous: 1, load_cancelled: 1, month_closed: 1, not_at_receiver: 2, not_his_row: 1, receiver_not_gps: 2, staff_upload: 1, would_fire: 7 });
		eq("L-2015 fires on its own driver's upload", load(j, "L-2015").map((x) => [x.upload, x.minutesToDelivered]), [["2026-10-14 16:20", 10]]);
		eq("[loads delivered, would complete]", [b.loadsDelivered, b.loadsWouldFire], [12, 7]);
	});

	await R.test("8 The stamp against the actual Delivered: a Friday 23:50 ET upload with a Saturday 00:05 tap is a week change; a Wednesday 23:55 upload with a Thursday 00:03 tap a day change in the same week", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		ran(ok, withSheet);
		const b = j.backtest || {};
		eq("L-2004", load(j, "L-2004").map((x) => [x.minutesToDelivered, x.sameDay, x.sameWeek, x.friday, x.afterBatch]), [[15, false, false, true, true]]);
		eq("L-2005", load(j, "L-2005").map((x) => [x.minutesToDelivered, x.sameDay, x.sameWeek, x.friday]), [[8, false, true, false]]);
		eq("[delivered, same day, same week, Fridays]", [b.delivered, b.sameDay, b.sameWeek, b.fridays], [7, 5, 6, { fired: 1, afterBatch: 1, weekChanges: 1 }]);
		eq("[criterion 2, 3, 4]", [criteria(j)["2"], criteria(j)["3"], criteria(j)["4"]], ["FAIL", "FAIL", "PASS"]);
	});

	await R.test("9 Proofs in several files: a second POD file 20 minutes after the upload that would fire fails criterion 7 (the 15-minute quiet period)", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		ran(ok, withSheet);
		const lf = (j.backtest || {}).laterFiles || {};
		eq("[loads, files, by gap, over 15 min, largest consecutive gap]", [lf.loads, lf.files, lf.byGap, (lf.overQuiet || []).map((x) => [x.load, x.laterFilesMin]), lf.maxConsecutiveMin],
			[1, 1, { ">15 min": 1 }, [["l-2007", [20]]], 20]);
		eq("criterion 7", criteria(j)["7"], "FAIL");
	});

	await R.test("10 The pay effect (M2): the blank drop-off loads whose day moves, per driver and week, with the tap's stamp and the upload's (C's removed Oct 22 stays unpaid)", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		ran(ok, withSheet);
		const p = j.pay || {};
		eq("the loads", (p.loads || []).map((l) => [l.load, l.tapDay, l.uploadDay, l.otherWeek]), [["l-2004", "2026-10-24", "2026-10-23", true], ["l-2005", "2026-10-29", "2026-10-28", false]]);
		eq("plan A's arrival rule is named only when this checkout's invoice code has it", p.planARule, W.SRC.includes("ARRIVAL_PICKUP_DATE_ENABLED"));
		eq("the weeks", (p.weeks || []).map((w) => [w.weekStart, w.daysTap, w.amountTap, w.daysUpload, w.amountUpload, w.delta]), [
			["2026-10-17", [], 0, ["2026-10-21", "2026-10-23"], 600, 600],
			["2026-10-24", ["2026-10-24", "2026-10-26", "2026-10-27"], 900, ["2026-10-26", "2026-10-27"], 600, -300],
			["2026-10-24", ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"], 1200, ["2026-10-26", "2026-10-27", "2026-10-28"], 900, -300],
		]);
	});

	await R.test("11 Parity: the report's paid days and amounts equal what the weekly invoice's generate route pays, on the sheet as it is and with both loads re-stamped at their uploads", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		ran(ok, withSheet);
		const weeks = (j.pay && j.pay.weeks) || [];
		const driverOf = { "l-2004": C, "l-2005": B };
		const paid = async (world, driver, weekEnd) => {
			const g = await W.generate(world, driver, weekEnd);
			if (g.status !== 200) return { days: [], amount: 0 };
			return { days: W.gridDays(g.data, weekEnd).map((d) => d.day), amount: Number(g.invoice.total_earnings) };
		};
		for (const w of weeks) {
			const driver = driverOf[w.loads[0]];
			const asIs = fixture();
			const moved = fixture();
			moved.setRow("L-2004", { "Status Update Date": moved.api.appStamp(new Date(W.etMs("2026-10-23 23:50"))), "Completion Date": moved.api.appStamp(new Date(W.etMs("2026-10-23 23:50"))) });
			moved.setRow("L-2005", { "Status Update Date": moved.api.appStamp(new Date(W.etMs("2026-10-28 23:55"))), "Completion Date": moved.api.appStamp(new Date(W.etMs("2026-10-28 23:55"))) });
			const t = await paid(asIs, driver, w.weekEnd);
			const u = await paid(moved, driver, w.weekEnd);
			eq(`${w.driver} ${w.weekStart}: [tap days, amount, upload days, amount]`, [w.daysTap, w.amountTap, w.daysUpload, w.amountUpload], [t.days, t.amount, u.days, u.amount]);
		}
		ok("three weeks compared", weeks.length === 3, JSON.stringify(weeks).slice(0, 200));
	});

	await R.test("12 Multi-stop shapes, the only POD before the arrival (L7), F7 (b) for comparison, and the receiver exit", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		ran(ok, withSheet);
		const b = j.backtest || {};
		eq("multi-stop", [b.multiStop && b.multiStop.loads, b.multiStop && b.multiStop.podDuring, b.multiStop && b.multiStop.list], [1, 0, ["l-2008"]]);
		eq("only a POD before the arrival", b.onlyPodBeforeArrival, { loads: 1, of: 10 });
		eq("F7 (b)", b.variantB, { uploads: 1, loads: 1, sameDay: 1, sameWeek: 1, within60: 1, notChecked: 0 });
		const e = j.receiverExit || {};
		eq("[loads, not checked, seen, after the POD within 1 h, before the tap, day differs]", [e.loads, e.notChecked, e.seen, e.withinHourOfPod, e.beforeTap, e.dayDiffers], [10, 8, 1, 1, 0, 0]);
	});

	await R.test("13 Heading and Loading shapes, coordinates, alerts, driver taps on loads with ELD data, and the Truck cell against the dated histories", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		ran(ok, withSheet);
		eq("Heading", [j.heading && j.heading.loads, j.heading && j.heading.sameDay, j.heading && j.heading.withinHour], [2, 2, 0]);
		eq("Loading", j.loading, { rows: 1, toNext: { "1-6 h": 1 }, daysSpanned: { 0: 1 }, writers: { Driver: 1 } });
		const c = j.coordinates || {};
		eq("[active, both, no row, no destination, by month]", [c.activeLoads, c.bothPoints, c.noRow, c.noDestination, c.withoutPointByMonth], [14, 12, 1, 1, { "2026-10": 2 }]);
		eq("the geofence's distances", [c.distances, c.maxM], [{ "At Shipper": { "250-1000 m": 1 }, "At Receiver": { "1-2 km": 1, "250-1000 m": 11, ">2 km": 1 } }, { "At Receiver": 2600, "At Shipper": 420 }]);
		eq("delivered with no geofence row", c.deliveredNoGeofence, { loads: 1, withEld: 1 });
		eq("alerts", c.alerts, { inWindow: 2, becameLoads: 1, delivered: 1, withBothPoints: 0, geofenceAtShipper: 0, geofenceAtReceiver: 0 });
		eq("taps", [j.taps && j.taps.byPhase.Delivered, j.taps && j.taps.byPhase["At Receiver"], j.taps && j.taps.geofencedOnEldLoads], [{ taps: 12, onEldLoads: 3 }, { taps: 1, onEldLoads: 1 }, 1]);
		eq("Truck cells: one disagrees", [j.truckCells && j.truckCells.disagree, j.truckCells && j.truckCells.noTruck], [1, 0]);
	});

	await R.test("14 The gate: exit 1 on a planted false completion and a withdrawn upload (criteria 1 and 5 FAIL); the base passes 1 and 5; criterion 6 is never passed here (no claims are read)", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		ran(ok, withSheet);
		const planted = W.saveCopy(fixture({ planted: true }), {});
		const g = W.runScript(SCRIPT, argsFor(planted, ["--ids", "--json", "--gate", `--values-json=${planted.values}`]));
		const pj = g.json || {};
		eq("[planted exit, criterion 1, criterion 5, gate]", [g.code, criteria(pj)["1"], criteria(pj)["5"], pj.gate], [1, "FAIL", "FAIL", "FAIL"]);
		const pb = pj.backtest || {};
		eq("the false completion and the withdrawn upload", [(pb.falseCompletions || []).map((x) => [x.load, x.follow]), (pb.withdrawn || []).map((x) => x.load), pb.uploaderRoleNotRecorded],
			[[["l-2019", "later_arrival"]], ["l-2020"], 1]);
		eq("a staff correction ending in Delivered within the hour is listed, not failed", (pb.staffCorrections || []).map((x) => x.load), ["l-2022"]);
		eq("one fire per arrival: L-2019 fires on each of its two arrivals", load(pj, "L-2019").map((x) => x.upload), ["2026-10-20 10:10", "2026-10-20 12:10"]);
		eq("a month closed after the upload was open then: L-2021 fires", [pb.closedSinceUpload, load(pj, "L-2021").length], [1, 1]);
		eq("a week change with a Drop-off Appointment set is listed in the pay effect; a day change in the same week with one set is not", [((pj.pay && pj.pay.loads) || []).filter((l) => l.load === "l-2023" || l.load === "l-2024").map((l) => [l.load, l.tapDay, l.uploadDay, l.otherWeek]), pj.pay && pj.pay.notListed],
			[[["l-2023", "2026-10-17", "2026-10-16", true]], { "Drop-off Appointment set, same week": 1 }]);
		eq("a POD after Delivered: already_completed, counted as a file after the tap and not as a later file of the proof", [pb.outcomes && pb.outcomes.already_completed, pb.laterFiles && pb.laterFiles.podsAfterTapIn24h, ((pb.laterFiles && pb.laterFiles.overQuiet) || []).map((x) => x.load)], [1, 1, ["l-2007"]]);
		eq("base: [1, 5, 6, S2, gate]", [criteria(j)["1"], criteria(j)["5"], criteria(j)["6"], j.s2, j.gate], ["PASS", "PASS", "NOT CHECKED", "FAIL", "FAIL"]);
		eq("the shadow-run minimums: 28 days, 4 Friday batches, 7 would-fire loads", (j.preconditions || []).map((p) => [p.verdict, p.detail]), [["PASS", "28 days"], ["PASS", "4"], ["FAIL", "7"]]);
		const text = W.runScript(SCRIPT, argsFor(planted, ["--gate", `--values-json=${planted.values}`]));
		ok("the text names each criterion and the gate", text.code === 1 && /^ {3}1\. FAIL: /m.test(text.stdout) && /^ {3}6\. NOT CHECKED: /m.test(text.stdout) && /^Gate: FAIL\.$/m.test(text.stdout), text.stdout.slice(-600));
	});

	await R.test("15 The gate passes nothing it did not check: thirty clean deliveries pass criteria 1-5 and 7, S2 and the minimums, and the gate still exits 1 while criterion 6 is not checked; without --values-json the pay effect is not checked either", async ({ eq: eqRaw, ok }) => {
		const eq = (l, a, e) => eqRaw(l, canon(a), canon(e));
		const clean = W.saveCopy(cleanFixture(), {});
		const g = W.runScript(SCRIPT, argsFor(clean, ["--json", "--gate", `--values-json=${clean.values}`]));
		ok("the report answers JSON", !!g.json, (g.stderr || g.stdout).slice(0, 300));
		const cj = g.json || {};
		eq("[exit, criteria, S2, minimums, gate]", [g.code, criteria(cj), cj.s2, (cj.preconditions || []).map((p) => p.verdict), cj.gate],
			[1, { 1: "PASS", 2: "PASS", 3: "PASS", 4: "PASS", 5: "PASS", 6: "NOT CHECKED", 7: "PASS" }, "PASS", ["PASS", "PASS", "PASS"], "FAIL"]);
		const bare = W.runScript(SCRIPT, argsFor(clean, ["--json", "--gate"]));
		eq("without the sheet: [exit, 5, pay]", [bare.code, criteria(bare.json)["5"], criteria(bare.json).pay], [1, "NOT CHECKED", "NOT CHECKED"]);
	});

	R.finish();
})();
