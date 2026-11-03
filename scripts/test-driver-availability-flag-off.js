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
// The time-off ELD check (B) off, in a world with the main flag ON and
// DRIVER_TIME_OFF_ELD_CHECK_ENABLED unset (production until the owner's yes):
//   §7 no answer carries eldDays, eldSummary or eldChecked; the run does
//      nothing; the 90-day purge still removes an old result's miles and times
//      (D18: it runs with the check on or off); the results table dropped under
//      the running server, the staff list, the driver's own route, the driver
//      app's payload and the sweep still answer 200
// Drivers' requests (plan B Revision 2, PR 4) off: DRIVER_TIME_OFF_REQUESTS_ENABLED
// is set in the first world too (its four routes join §1), then
//   §8 with the main and screen flags on and the requests flag unset, or set
//      with the screen flag unset: the four request routes answer like an
//      unknown path; a staff row is stored approved and staff; the panel's
//      rows and the driver's answers carry exactly the keys they had before; a
//      waiting request left from before holds no days and warns no one; staff
//      changing a driver-made row tell the driver nothing
//   §9 home time (H1), on the same flag, with it unset: a staff create or edit
//      naming a home time answers, audits and stores exactly as one that doesn't;
//      a home time stored before the switch-off is in no answer
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
	// The screen sub-flag, R11b's flag and the requests flag are set; without the main flag they must do nothing.
	const w = await W.startWorld({ flag: false, loadsWarning: true, env: { DRIVER_TIME_OFF_SCREEN_ENABLED: "true", DRIVER_TIME_OFF_REQUESTS_ENABLED: "true" } });
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
				// A driver's request and the staff decision (PR 4), their own flag set here too.
				["POST", "/api/driver/me/availability", { from: "2026-11-02", to: "2026-11-03" }],
				["POST", "/api/driver/me/availability/1/cancel", {}],
				["POST", "/api/driver-availability/1/approve", {}],
				["POST", "/api/driver-availability/1/decline", {}],
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

	section("§7 the main flag on, the ELD check's flag unset");
	await R.guard("§7", async () => {
		const ELD_KEYS = ["eldDays", "eldSummary", "eldChecked"];
		const eldKeys = (value, out = new Set()) => {
			if (Array.isArray(value)) value.forEach((v) => eldKeys(v, out));
			else if (value && typeof value === "object") for (const k of Object.keys(value)) { if (ELD_KEYS.includes(k)) out.add(k); eldKeys(value[k], out); }
			return out;
		};
		const on = await W.startWorld({ env: { DRIVER_TIME_OFF_SCREEN_ENABLED: "true" } });
		W.eldFixtures(on.db);
		const created = await on.call("POST", `/api/drivers-directory/${DIR.hollis}/availability`, { body: { kind: "vacation", from: "2026-10-05", to: "2026-10-07", reason: "Family" } });
		const id = created.body && created.body.row ? created.body.row.id : 0;
		// A result saved while the check was on, final 100 days ago.
		const old = new Date(on.clock.ms - 100 * W.DAY).toISOString();
		on.db.prepare(`INSERT INTO driver_time_off_days (availability_id, directory_id, day, state, reason, miles, samples, first_move_ms, last_move_ms, rule_version, first_evaluated_at, evaluated_at, final_at)
			VALUES (?, ?, '2026-10-05', 'confirmed', 'parked', 2.5, 40, 123, 456, 1, ?, ?, ?)`).run(id, DIR.hollis, old, old, old);
		const answers = async () => [
			["GET /api/drivers-directory/:id/availability (Super Admin)", await on.call("GET", `/api/drivers-directory/${DIR.hollis}/availability`, { user: USERS.sa })],
			["GET /api/drivers-directory/:id/availability (Dispatcher)", await on.call("GET", `/api/drivers-directory/${DIR.hollis}/availability`, { user: USERS.disp })],
			["GET /api/driver/me/availability", await on.call("GET", "/api/driver/me/availability", { user: USERS.driver })],
			["GET /api/driver/:driverName", await on.call("GET", `/api/driver/${encodeURIComponent("Hollis Renner")}`, { user: USERS.driver })],
		];
		for (const [label, r] of await answers()) eq(`§7.1 ${label}: 200, none of ${ELD_KEYS.join(" / ")}`, [r.status, [...eldKeys(r.body)]], [200, []]);
		const audits = on.db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n;
		eq("§7.2 the run does nothing: no result written, audited or told", [await on.api.runTimeOffEldCheck({ nowMs: on.clock.ms }),
			on.db.prepare("SELECT COUNT(*) AS n FROM driver_time_off_days").get().n, on.db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n - audits,
			on.db.prepare("SELECT COUNT(*) AS n FROM dispatch_notifications WHERE type = 'time-off-eld'").get().n], [{ skipped: "off" }, 1, 0, 0]);
		eq("§7.3 D18: the purge still runs, removing the old result's miles and times and keeping its verdict", [on.api.purgeTimeOffEldResults(on.clock.ms),
			Object.values(on.db.prepare("SELECT miles, samples, first_move_ms, last_move_ms, state, reason, purged_at IS NOT NULL AS purged FROM driver_time_off_days").get())],
			[1, [0, 0, null, null, "confirmed", "parked", 1]]);
		on.db.exec("DROP TABLE driver_time_off_days");
		for (const [label, r] of await answers()) eq(`§7.4 the results table dropped: ${label} still 200`, r.status, 200);
		let swept = null;
		try { swept = await on.sweep(); } catch (err) { swept = err.message; }
		ok("§7.5 ...and the sweep still runs", swept && typeof swept === "object", String(swept));
		eq("§7.6 the purge with no table logs and returns 0, never throws", on.api.purgeTimeOffEldResults(on.clock.ms), 0);
	});

	// Drivers' requests (plan B Revision 2, PR 4) off: DRIVER_TIME_OFF_REQUESTS_ENABLED
	// unset with the screen flag on (production until its checkpoint), or set with
	// the screen flag unset. The request columns exist (they are additive).
	section("§8 the main and screen flags on, the requests flag unset (or set without the screen flag)");
	await R.guard("§8", async () => {
		const REQUEST_ROUTES = [["POST", "/api/driver/me/availability"], ["POST", "/api/driver/me/availability/1/cancel"], ["POST", "/api/driver-availability/1/approve"], ["POST", "/api/driver-availability/1/decline"]];
		for (const [label, env] of [["requests unset", { DRIVER_TIME_OFF_SCREEN_ENABLED: "true" }], ["requests set, screen unset", { DRIVER_TIME_OFF_REQUESTS_ENABLED: "true" }]]) {
			const on = await W.startWorld({ env });
			const unknown = await on.call("POST", "/api/no-such-route-pr4", { body: {} });
			const answered = [];
			for (const [method, url] of REQUEST_ROUTES) {
				for (const user of [USERS.sa, USERS.disp, USERS.driver, null]) {
					const r = await on.call(method, url, { user, body: { from: "2026-11-02", to: "2026-11-02" } });
					answered.push(r.status === unknown.status && r.text === unknown.text.replace("/api/no-such-route-pr4", url));
				}
			}
			ok(`§8.1 ${label}: the four request routes answer like an unknown path, for every role`, answered.every(Boolean), answered.join());
		}
		const on = await W.startWorld({ env: { DRIVER_TIME_OFF_SCREEN_ENABLED: "true" } });
		const created = await on.call("POST", `/api/drivers-directory/${DIR.hollis}/availability`, { body: { kind: "vacation", from: "2026-10-14", to: "2026-10-16", reason: "Family" } });
		const staffId = created.body && created.body.row ? created.body.row.id : 0;
		const stored = on.db.prepare("SELECT request_status, source, decided_by, decided_by_user_id, decided_at FROM driver_availability WHERE id = ?").get(staffId);
		eq("§8.2 a staff row is stored approved and staff, nothing decided", stored, { request_status: "approved", source: "staff", decided_by: null, decided_by_user_id: 0, decided_at: null });
		// Left from before the switch-off: his own waiting request (Nov 2-4) and an approved one (Oct 26-27).
		const leftover = (from, to, status) => Number(on.db.prepare(`INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, reason, created_by, created_by_user_id, created_at,
			request_status, source, decided_by, decided_at) VALUES (?, 'Hollis Renner', 'off_duty', ?, ?, '', 'drv_hollis', ?, '2026-10-05T12:00:00Z', ?, 'driver', ?, ?)`)
			.run(DIR.hollis, from, to, USERS.driver.id, status, status === "approved" ? "dispatch_t" : null, status === "approved" ? "2026-10-06T12:00:00Z" : null).lastInsertRowid);
		const waiting = leftover("2026-11-02", "2026-11-04", "requested");
		const approved = leftover("2026-10-26", "2026-10-27", "approved");
		const panel = await on.call("GET", `/api/drivers-directory/${DIR.hollis}/availability`, { user: USERS.sa });
		const ROW_KEYS = "cancelledAt,cancelledBy,createdAt,createdBy,directoryId,editable,from,id,kind,limits,reason,status,to,updatedAt";
		eq("§8.3 the staff panel's rows carry exactly the keys they had before requests", [panel.status, [...new Set((panel.body.rows || []).map((r) => Object.keys(r).sort().join()))]], [200, [ROW_KEYS]]);
		const mine = await on.call("GET", "/api/driver/me/availability", { user: USERS.driver });
		const pg = await on.call("GET", `/api/driver/${encodeURIComponent("Hollis Renner")}`, { user: USERS.driver });
		eq("§8.4 his own answers carry exactly today's keys, and his rows are the approved ones only",
			[Object.keys(mine.body || {}).sort().join(), Object.keys((pg.body && pg.body.timeOff) || {}).sort().join(), (mine.body.rows || []).map((r) => r.id)], ["rows,today", "rows,today", [staffId, approved]]);
		const over = await on.call("POST", `/api/drivers-directory/${DIR.hollis}/availability`, { body: { kind: "vacation", from: "2026-11-03", to: "2026-11-05" } });
		eq("§8.5 the waiting request holds no days: staff record Nov 3-5 over it, 201", over.status, 201);
		const load = await on.call("POST", "/api/data", { user: USERS.sa, body: { values: W.jtRow({ id: "7880", driver: "Hollis Renner", pickup: "11/2/2026", dropoff: "11/2/2026", status: "Dispatched" }) } });
		eq("§8.6 ...and warns no one: a load on Nov 2 (its first day, before the staff row) for him, 200", load.status, 200);
		const notices = () => on.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'time-off'").get().n;
		await on.call("PUT", `/api/driver-availability/${approved}`, { user: USERS.sa, body: { to: "2026-10-26" } });
		await on.call("POST", `/api/driver-availability/${approved}/cancel`, { user: USERS.sa, body: {} });
		eq("§8.7 staff shortening, then cancelling, his approved request tell him nothing (no notice, no live event)",
			[notices(), on.emits.filter((e) => e.event === "time-off-updated").length, on.db.prepare("SELECT COUNT(*) AS n FROM dispatch_notifications WHERE type = 'time-off-request'").get().n], [0, 0, 0]);
		eq("§8.8 the waiting request is left as it was", on.db.prepare("SELECT request_status, cancelled_at FROM driver_availability WHERE id = ?").get(waiting), { request_status: "requested", cancelled_at: null });
	});

	// Home time (H1) rides the requests flag: with it unset, a staff body naming a home time
	// answers exactly as one that doesn't, and a home time left from before shows nowhere.
	section("§9 the requests flag unset: home time is ignored and never sent");
	await R.guard("§9", async () => {
		const pair = async (home) => {
			const w = await W.startWorld({ env: { DRIVER_TIME_OFF_SCREEN_ENABLED: "true" } });
			const made = await w.call("POST", `/api/drivers-directory/${DIR.hollis}/availability`, { body: { kind: "vacation", from: "2026-10-20", to: "2026-10-21", ...home } });
			const id = made.body && made.body.row ? made.body.row.id : 0;
			const edited = await w.call("PUT", `/api/driver-availability/${id}`, { body: { to: "2026-10-22", ...home } });
			const scrub = (x) => JSON.stringify(x.body).replace(/"(createdAt|updatedAt)":"[^"]*"/g, "");
			return {
				w, id,
				said: [made.status, scrub(made), edited.status, scrub(edited)],
				stored: w.db.prepare("SELECT home_city, home_state FROM driver_availability WHERE id = ?").get(id),
				audits: [...w.audits("driver_availability_create"), ...w.audits("driver_availability_update")].map((a) => a.details),
			};
		};
		const plain = await pair({});
		const named = await pair({ homeCity: "Riverton", homeState: "ZZ" });
		eq("§9.1 a staff create and edit naming a home time (a bad one too) answer and audit exactly as without it, and store none",
			[named.said, named.audits, named.stored], [plain.said, plain.audits, { home_city: null, home_state: null }]);
		named.w.db.prepare("UPDATE driver_availability SET home_city = 'Riverton', home_state = 'WY' WHERE id = ?").run(named.id);
		const panel = await named.w.call("GET", `/api/drivers-directory/${DIR.hollis}/availability`, { user: USERS.sa });
		const mine = await named.w.call("GET", "/api/driver/me/availability", { user: USERS.driver });
		const pg = await named.w.call("GET", `/api/driver/${encodeURIComponent("Hollis Renner")}`, { user: USERS.driver });
		eq("§9.2 a home time stored before the switch-off is in no answer: the staff panel, his own route, the driver app's payload",
			[/Riverton|"home"|homeTime|homeDefault/.test(`${panel.text}${mine.text}${pg.text}`), mine.body.rows.length], [false, 1]);
	});
	await R.finish();
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
