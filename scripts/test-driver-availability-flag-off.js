#!/usr/bin/env node
// With DRIVER_AVAILABILITY_ENABLED off (production until the owner approves),
// nothing reads or writes the driver_availability table (R11). Only the
// additive migration runs, so turning the flag on later needs no other step.
//
// The world starts with the flag unset and a live row covering today for the
// driver of a dark, linked, Active truck (#91), as if it had been saved while
// the flag was on. Then:
//   §1 the six availability routes answer exactly like an unknown /api path,
//      for a Super Admin too: no 401 or 403 shows that a route exists. Here,
//      where nothing else is registered, that is Express's 404. In production
//      it is not always a 404: a GET falls through to the SPA catch-all and
//      gets the app's page (200), as every unknown /api GET does, and a POST or
//      PUT gets Express's 404
//   §2 each of the five assign routes puts him on a load inside his off dates
//      without confirmOffDuty (200), and no off-duty confirmation is audited
//   §3 the ELD sweep opens the stale alert for #91
//   §4 GET /api/dashboard, GET /api/trucks and GET /api/drivers-directory carry
//      no offUntil / DriverOffUntil / OffFrom / OffTo key at all
//   §4b the driver app's payload (GET /api/driver/:driverName) answers 200 with
//      his loads and no `timeOff` key, though DRIVER_TIME_OFF_SCREEN_ENABLED is
//      set: the driver's time-off screen works only while the main flag is on
//   §5 the tables (the time off and its "Assign anyway" confirmations) are
//      dropped under the running server, and the five assign routes, the
//      sweep, those three responses, the driver app's payload and the directory
//      delete still answer: no flag-off path touches either
// DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED (R11b) is set in that world too, and
// changes none of it (§1 also checks Job Tracking is never read). Then, in a
// world with the main flag ON and R11b's flag unset (as production until the
// user's yes):
//   §6 time off recorded and extended over his loads saves exactly as before
//      R11b: 201 / 200 with the same answer, `confirmLoads` ignored, no
//      confirmation recorded or audited, the same audit lines, and Job
//      Tracking never read (unreadable, nothing changes either)
//
// The routes are the shipped ones, lifted out of server.js
// (scripts/lib/availability-world.js). On a server.js without the table, the
// seed itself fails: that is the only way this runner can fail there. Its job
// is to fail when a flag-off path starts reading the table.
// Run: node scripts/test-driver-availability-flag-off.js

"use strict";

const W = require("./lib/availability-world");

const R = W.createRunner("test-driver-availability-flag-off");
const { ok, eq, section } = R;
const { USERS, DIR, COL, HEADERS } = W;

const KEYS = ["offUntil", "DriverOffUntil", "OffFrom", "OffTo"];
function keysFound(value, out = new Set()) {
	if (Array.isArray(value)) value.forEach((v) => keysFound(v, out));
	else if (value && typeof value === "object") {
		for (const k of Object.keys(value)) {
			if (KEYS.includes(k)) out.add(k);
			keysFound(value[k], out);
		}
	}
	return out;
}
const rowValues = (w, rowIndex, patch) => {
	const r = HEADERS.map((h, i) => (w.sheet.tabs["Job Tracking"][rowIndex - 1] || [])[i] || "");
	for (const [k, v] of Object.entries(patch)) r[COL[k]] = v;
	return r;
};
// The five assign routes, each putting `driver` on a load inside Oct 14-20
// (the two row saves change the Driver cell from someone else's name).
const assign = (w, driver, n) => [
	["PUT /api/data/:rowIndex", () => w.call("PUT", "/api/data/4", { user: USERS.disp, body: { values: rowValues(w, 4, { Driver: driver }) } })],
	["PUT /api/load/:loadId", () => w.call("PUT", "/api/load/7002", { user: USERS.disp, body: { Driver: driver } })],
	["POST /api/dispatch", () => w.call("POST", "/api/dispatch", { user: USERS.disp, body: { rowIndex: 2, loadId: "7001", driver } })],
	["POST /api/dispatch/reassign", () => w.call("POST", "/api/dispatch/reassign", { user: USERS.disp, body: { rowIndex: 4, loadId: "7003", newDriver: driver, oldDriver: "" } })],
	["POST /api/data", () => w.call("POST", "/api/data", { user: USERS.sa, body: { values: W.jtRow({ id: `78${n}0`, driver, pickup: "10/16/2026", dropoff: "10/17/2026", status: "Dispatched" }) } })],
];

// The driver app's payload for Hollis, as he asks for it.
const page = (w) => w.call("GET", `/api/driver/${encodeURIComponent("Hollis Renner")}`, { user: USERS.driver });
const pageSays = (r) => [r.status, Array.isArray(r.body && r.body.loads) && r.body.loads.length > 0, !!r.body && "timeOff" in r.body];

(async () => {
	// The screen sub-flag and R11b's flag are set; without the main flag they must do nothing.
	const w = await W.startWorld({ flag: false, loadsWarning: true, env: { DRIVER_TIME_OFF_SCREEN_ENABLED: "true" } });
	let seeded = false;
	try {
		w.db.prepare(`INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, reason, created_by, created_at)
			VALUES (?, 'Hollis Renner', 'vacation', '2026-10-14', '2026-10-20', 'Family', 'super_admin', '2026-10-13T12:00:00Z')`).run(DIR.hollis);
		seeded = true;
	} catch (err) {
		ok("§0 the migration created driver_availability (a row saved while the flag was on)", false, err.message);
	}
	if (seeded) {
		section("§1 the six routes answer like an unknown path");
		await R.guard("§1", async () => {
			const unknown = {
				GET: await w.call("GET", "/api/no-such-route-r11"),
				POST: await w.call("POST", "/api/no-such-route-r11", { body: {} }),
				PUT: await w.call("PUT", "/api/no-such-route-r11", { body: {} }),
			};
			eq("§1.0 an unknown /api path in this harness (no SPA catch-all): 404", [unknown.GET.status, unknown.POST.status, unknown.PUT.status], [404, 404, 404]);
			const like = (r, method, url) => r.status === unknown[method].status && r.text === unknown[method].text.replace("/api/no-such-route-r11", url);
			const ROUTES = [
				["GET", `/api/drivers-directory/${DIR.hollis}/availability`, undefined],
				["POST", `/api/drivers-directory/${DIR.hollis}/availability`, { kind: "vacation", from: "2026-11-01", to: "2026-11-02" }],
				["POST", `/api/drivers-directory/${DIR.hollis}/availability`, { kind: "vacation", from: "2026-10-20", to: "2026-10-21", confirmLoads: [{ loadId: "7001", from: "2026-10-20", to: "2026-10-22" }] }],
				["PUT", "/api/driver-availability/1", { to: "2026-10-18" }],
				["PUT", "/api/driver-availability/1", { to: "2026-10-27" }],
				["POST", "/api/driver-availability/1/cancel", {}],
				["GET", "/api/driver/me/availability", undefined],
				["GET", "/api/driver-availability", undefined],
			];
			for (const [method, url, body] of ROUTES) {
				for (const user of [USERS.sa, USERS.disp, USERS.driver, USERS.inv, null]) {
					const r = await w.call(method, url, { user, body });
					ok(`§1 ${method} ${url} as ${user ? user.role : "signed out"}: answered like an unknown path`, like(r, method, url), `${r.status} ${r.text.slice(0, 60)}`);
				}
			}
			const row = w.db.prepare("SELECT * FROM driver_availability WHERE id = 1").get();
			eq("§1.1 the stored row is untouched", [row.to_date, row.cancelled_at, row.updated_at], ["2026-10-20", null, null]);
			eq("§1.2 ...no confirmation recorded, and Job Tracking never read", [w.db.prepare("SELECT COUNT(*) AS n FROM driver_availability_confirmations").get().n, w.jt.reads], [0, 0]);
		});

		section("§2 the assign routes put him on a load inside his off dates");
		await R.guard("§2", async () => {
			for (const [label, send] of assign(w, "Hollis Renner", 1)) {
				const r = await send();
				eq(`§2 ${label}: 200 without confirmOffDuty`, r.status, 200);
			}
			eq("§2.1 no off-duty confirmation audited", w.audits("dispatch_off_duty_confirmed").length, 0);
		});

		section("§3 the sweep");
		await R.guard("§3", async () => {
			await w.sweep();
			const row = w.db.prepare("SELECT * FROM eld_feed_alerts WHERE alert_key = ?").get(`vid:${W.VID.t91}`);
			ok("§3.1 #91's stale alert opens while he is recorded off", !!row && !row.resolved_at && !!row.alerted_at);
			const feed = w.api.eldFeedHealthReport(w.clock.ms).feeds.find((f) => f.vehicleId === W.VID.t91);
			eq("§3.2 the health report says stale, with no driverOffUntil", feed && [feed.state, "driverOffUntil" in feed], ["stale", false]);
			ok("§3.3 the alert email keeps today's remedy text", w.emails.some((e) => /set its status to OOS or Maintenance/.test(e.html) && !/time off/.test(e.html)));
		});

		section("§4 no availability keys in the responses");
		await R.guard("§4", async () => {
			for (const [url, user] of [["/api/dashboard", USERS.sa], ["/api/trucks", USERS.sa], ["/api/trucks", USERS.disp], ["/api/drivers-directory", USERS.disp]]) {
				const r = await w.call("GET", url, { user });
				eq(`§4 GET ${url} (${user.role}): 200, none of ${KEYS.join(" / ")}`, [r.status, [...keysFound(r.body)]], [200, []]);
			}
		});

		section("§4b the driver app's payload, with the screen sub-flag set");
		await R.guard("§4b", async () => {
			eq("§4b.0 the world serves the payload route", w.found.includes("driverPage"), true);
			eq("§4b.1 GET /api/driver/:driverName as the driver: 200 with his loads, no timeOff key", pageSays(await page(w)), [200, true, false]);
			const admin = await w.call("GET", `/api/driver/${encodeURIComponent("Hollis Renner")}`, { user: USERS.sa });
			eq("§4b.2 ...as a Super Admin: 200 with his loads, no timeOff key", pageSays(admin), [200, true, false]);
		});

		section("§5 the table dropped under the running server");
		await R.guard("§5", async () => {
			w.db.exec("DROP TABLE driver_availability; DROP TABLE IF EXISTS driver_availability_confirmations;");
			for (const [label, send] of assign(w, "Tamsin Vale", 2)) {
				const r = await send();
				eq(`§5 ${label}: still 200`, r.status, 200);
			}
			let swept = null;
			try { swept = await w.sweep(); } catch (err) { swept = err.message; }
			ok("§5.1 the sweep still runs", swept && typeof swept === "object", String(swept));
			for (const [url, user] of [["/api/dashboard", USERS.sa], ["/api/trucks", USERS.disp], ["/api/drivers-directory", USERS.sa]]) {
				eq(`§5 GET ${url}: still 200`, (await w.call("GET", url, { user })).status, 200);
			}
			eq("§5 GET /api/driver/:driverName: still 200 with his loads, no timeOff key", pageSays(await page(w)), [200, true, false]);
			eq("§5.2 the directory delete still answers 200", (await w.call("DELETE", `/api/drivers-directory/${DIR.tamsin}`)).status, 200);
			ok("§5.3 nothing logged an error", !w.logs.some((l) => /driver_availability|no such table/i.test(l)), w.logs.join(" | ").slice(0, 300));
		});
	}

	section("§6 the main flag on, R11b's flag unset: time off over his loads saves as before");
	await R.guard("§6", async () => {
		const on = await W.startWorld({ rows: W.hisLoadsRows() });
		const post = (body) => on.call("POST", `/api/drivers-directory/${DIR.hollis}/availability`, { body });
		const keys = (r) => (r.body ? Object.keys(r.body).sort() : null);
		const reads = on.jt.reads;
		const plain = await post({ kind: "vacation", from: "2026-10-20", to: "2026-10-21", reason: "Family" });
		eq("§6.1 Oct 20-21 over his load 7001: 201, the answer only success and the row", [plain.status, keys(plain)], [201, ["row", "success"]]);
		const echoed = await post({ kind: "vacation", from: "2026-10-26", to: "2026-10-27", reason: "Family", confirmLoads: [{ loadId: "7501", from: "2026-10-26", to: "2026-10-27" }] });
		eq("§6.2 Oct 26-27 over 7501 with confirmLoads (ignored): 201, the same answer", [echoed.status, keys(echoed)], [201, ["row", "success"]]);
		on.jt.fail = true;
		const unreadable = await post({ kind: "vacation", from: "2026-11-03", to: "2026-11-04" });
		eq("§6.3 Job Tracking unreadable, Nov 3-4 over 7505: 201, no loadsUnchecked", [unreadable.status, keys(unreadable)], [201, ["row", "success"]]);
		const moved = await on.call("PUT", `/api/driver-availability/${plain.body && plain.body.row ? plain.body.row.id : 0}`, { body: { to: "2026-10-24", confirmLoads: true } });
		eq("§6.4 an edit extending Oct 20-21 to Oct 24: 200, the answer only success and the row", [moved.status, keys(moved)], [200, ["row", "success"]]);
		on.jt.fail = false;
		eq("§6.5 Job Tracking never read", on.jt.reads - reads, 0);
		eq("§6.6 no confirmation recorded or audited",
			[on.db.prepare("SELECT COUNT(*) AS n FROM driver_availability_confirmations").get().n, on.audits("driver_availability_loads_confirmed").length], [0, 0]);
		eq("§6.7 the create audit lines as before", on.audits("driver_availability_create").map((a) => a.details),
			["Hollis Renner: off 2026-10-20..2026-10-21 (vacation)", "Hollis Renner: off 2026-10-26..2026-10-27 (vacation)", "Hollis Renner: off 2026-11-03..2026-11-04 (vacation)"]);
		eq("§6.8 the update audit line as before", on.audits("driver_availability_update").map((a) => a.details),
			["Hollis Renner: off 2026-10-20..2026-10-21 (vacation) -> off 2026-10-20..2026-10-24 (vacation)"]);
	});
	await R.finish();
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
