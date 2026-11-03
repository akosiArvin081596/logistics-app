#!/usr/bin/env node
// Drivers ask for days off; staff approve or decline (plan B Revision 2, PR 4),
// with DRIVER_TIME_OFF_REQUESTS_ENABLED on (and the screen and main flags it
// folds in). D's rules of 2026-10-31: a request button; someone approves it by
// hand; requests at least 5 days ahead. "Today" is the business day on
// APP_TIMEZONE (US Eastern), 2026-10-15 here unless a case moves the clock.
//
//   §0 the world serves the four routes
//   §1 a request: 201, Waiting, today + 5; what it writes (the row, an audit
//      line, one staff notice and its live copy); refusals (TOO_SOON, TOO_FAR,
//      the date rules, the kind, any reason), each audited, none writing; a
//      body naming another driver still asks for the session's own
//   §2 "today + 5" on the business clock: the plan's four instants (23:59 and
//      00:00 EDT, 01:30 before and after the clocks go back, a Pacific evening
//      that is already tomorrow in the East) and the end of that day, each under
//      four server zones; the form's first day (requestLimits.fromMin) matches
//   §3 overlap and the cap: an approved row or a waiting request blocks, a
//      declined row never does; at most 5 waiting (a passed one doesn't count)
//   §4 who asks: their account read again by id; no directory row, two, or
//      another account holding the name (L3) is a 409; a session whose account
//      is not a Driver is a 403
//   §5 the driver's cancel: their own waiting request only; 409 once decided
//      (never naming who decided) or already cancelled; 404 for anyone else's
//      row, an unknown id, a staff row, another account's request on their row
//   §6 the decision: approve and decline, the driver's notice (no decider, no
//      reason), the staff notice's decision, a second decision 409 naming the
//      first; a declined request blocks nothing; an approved one warns dispatch
//   §7 R11b at approval (loads warning on): 409 DRIVER_HAS_LOADS, "Approve
//      anyway" and its confirmations, Job Tracking unreadable approves
//      unchecked, a decision that lands during the sheet read wins; no loads
//      check when the driver asks
//   §8 later: staff changing or cancelling an approved request tell the driver;
//      a staff row never does; a waiting or declined row can't be edited or
//      cancelled by staff; staff recording over a waiting request get 409
//   §9 roles: Driver only on the driver routes, Super Admin and Dispatcher only
//      on the decide routes; signed out 401; no CSRF header 403; the per-account
//      limiter (30 then 429), mounted after the role check
//   §10 the staff panel's request keys; the directory delete cancels a waiting
//      request and leaves a declined one
//   §11 L4: a Dispatcher can't approve a request starting over 30 days back; a
//      Super Admin can; anyone may decline it
//   §12 flag off (requests unset, or the screen flag unset, or the main flag
//      unset): the routes answer as unknown paths, no answer carries a request
//      key, and a waiting request holds no days
//   §13 privacy: no decider, reason or author ever reaches the driver
//   §14 home time (H1): where he needs to be, a city and a state, required on
//      his own request (both, a real state's code, a city name that is not
//      digits or contact details), pre-filled from his Drivers page row; shown
//      to him and to staff, in the staff notice; the audit names the state
//      only; optional on a staff row (both or neither), edited like the dates;
//      the keys only while the requests flag is on; nothing composed for CHR
//      names it
//
// Everything runs through scripts/lib/availability-world.js: the shipped routes
// lifted out of server.js on an in-memory SQLite, over HTTP. Made-up data only.
// Run: node scripts/test-driver-time-off-requests.js

"use strict";

const fs = require("fs");
const path = require("path");
const W = require("./lib/availability-world");

const R = W.createRunner("test-driver-time-off-requests");
const { ok, eq, section } = R;
const { USERS, DIR } = W;

const ON = { DRIVER_TIME_OFF_SCREEN_ENABLED: "true", DRIVER_TIME_OFF_REQUESTS_ENABLED: "true" };
const world = (opts = {}) => W.startWorld({ ...opts, env: { ...ON, ...(opts.env || {}) } });
// A request names where he needs to be (H1: required); a §14 case passes its own
// homeCity / homeState, `undefined` leaving that key out of the body.
const HOME = { homeCity: "Springfield", homeState: "MO" };
const withHome = (body) => (body && typeof body === "object" && !Array.isArray(body) ? { ...HOME, ...body } : body);
const ask = (w, body, user = USERS.driver, opts = {}) => w.call("POST", "/api/driver/me/availability", { user, body: withHome(body), ...opts });
const bare = (w, body, user = USERS.driver) => w.call("POST", "/api/driver/me/availability", { user, body });
const withdraw = (w, id, user = USERS.driver, opts = {}) => w.call("POST", `/api/driver/me/availability/${id}/cancel`, { user, body: {}, ...opts });
const approve = (w, id, user = USERS.disp, body = {}, opts = {}) => w.call("POST", `/api/driver-availability/${id}/approve`, { user, body, ...opts });
const decline = (w, id, user = USERS.disp, opts = {}) => w.call("POST", `/api/driver-availability/${id}/decline`, { user, body: {}, ...opts });
const staffCreate = (w, dirId, body, user = USERS.sa) => w.call("POST", `/api/drivers-directory/${dirId}/availability`, { user, body });
const stored = (w, id) => w.db.prepare("SELECT * FROM driver_availability WHERE id = ?").get(id);
const count = (w) => w.db.prepare("SELECT COUNT(*) AS n FROM driver_availability").get().n;
const code = (r) => [r.status, r.body && r.body.code];
const reqId = (r) => (r.body && r.body.request ? r.body.request.id : null);
const staffNotices = (w) => w.db.prepare("SELECT * FROM dispatch_notifications WHERE type = 'time-off-request' ORDER BY id").all();
const driverNotices = (w) => w.db.prepare("SELECT * FROM notifications WHERE type = 'time-off' ORDER BY id").all();
const metaOf = (n) => (n ? JSON.parse(n.metadata) : null);
// A row written straight to the table, as an earlier request or decision left it.
const plant = (w, { dir = DIR.hollis, name = "Hollis Renner", from, to, status = "requested", source = "driver", by = USERS.driver.id, cancelled = null, decidedBy = null, decidedAt = null }) =>
	Number(w.db.prepare(`INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, reason, created_by, created_by_user_id, created_at,
		request_status, source, cancelled_at, decided_by, decided_at) VALUES (?, ?, 'vacation', ?, ?, '', 'test', ?, '2026-10-10T12:00:00Z', ?, ?, ?, ?, ?)`)
		.run(dir, name, from, to, by, status, source, cancelled, decidedBy, decidedAt).lastInsertRowid);
// What the driver's own session is served (the me route and the payload's timeOff).
const mine = (w, user = USERS.driver) => w.call("GET", "/api/driver/me/availability", { user });
const page = (w, user = USERS.driver, name = "Hollis Renner") => w.call("GET", `/api/driver/${encodeURIComponent(name)}`, { user });

(async () => {
	section("§0 the world serves the four routes");
	await R.guard("§0", async () => {
		const w = await world();
		eq("§0.1 the request, its cancel, the approve and the decline are registered", W.REQUEST_ROUTES.filter((k) => w.found.includes(k)), W.REQUEST_ROUTES);
	});

	section("§1 a request");
	await R.guard("§1", async () => {
		const w = await world();
		const r = await ask(w, { from: "2026-10-20", to: "2026-10-22" });
		eq("§1.1 Hollis asks for Oct 20-22 (today + 5): 201, Waiting, his to cancel, kind Off duty by default, his home time",
			[r.status, r.body && r.body.request], [201, { id: reqId(r), kind: "off_duty", from: "2026-10-20", to: "2026-10-22", request: "waiting", canCancel: true, home: { city: "Springfield", state: "MO" } }]);
		const s = stored(w, reqId(r));
		eq("§1.2 ...stored as his request: requested, driver, his account, no reason, nothing decided, his home time",
			s && [s.directory_id, s.driver_name, s.request_status, s.source, s.created_by, s.created_by_user_id, s.reason, s.decided_by, s.decided_by_user_id, s.decided_at, s.cancelled_at, s.home_city, s.home_state],
			[DIR.hollis, "Hollis Renner", "requested", "driver", "drv_hollis", USERS.driver.id, "", null, 0, null, null, "Springfield", "MO"]);
		eq("§1.3 ...one audit line, on the driver's directory row, naming the home time's state only", w.audits("driver_availability_request").map((a) => [a.entity, a.entity_id, a.details]),
			[["driver", String(DIR.hollis), "Hollis Renner: off 2026-10-20..2026-10-22 (off_duty) requested by the driver; home time in MO"]]);
		const n = staffNotices(w);
		eq("§1.4 ...one staff notice: who and which days, the kind, the day asked and the home time, no load ID",
			[n.length, n[0] && n[0].title, n[0] && n[0].body, metaOf(n[0])],
			[1, "Time off request: Hollis Renner (Oct 20 – Oct 22)", "Off duty. Asked Oct 15. Home time: Springfield, MO.", { availabilityId: reqId(r), directoryId: DIR.hollis }]);
		const live = w.emits.filter((e) => e.event === "dispatch-notification");
		eq("§1.5 ...sent live to the staff rooms only (the dispatch room and its Super Admins), never a driver's room",
			[live.map((e) => [e.room, e.except]), w.emits.some((e) => String(e.room).startsWith("driver:"))], [[["super-admin", null], ["dispatch", "super-admin"]], false]);
		ok("§1.6 ...and the drivers screens are told", w.changes.includes("drivers"));
		eq("§1.7 kind vacation is taken as given", (await ask(w, { from: "2026-11-02", to: "2026-11-03", kind: "vacation" })).body.request.kind, "vacation");

		const before = count(w);
		const auditsBefore = w.audits("driver_availability_request_blocked").length;
		for (const [label, body, want] of [
			["Oct 19 (today + 4)", { from: "2026-10-19", to: "2026-10-23" }, [400, "TIME_OFF_TOO_SOON"]],
			["Oct 15 (today)", { from: "2026-10-15", to: "2026-10-16" }, [400, "TIME_OFF_TOO_SOON"]],
			["Jan 14, 2027 (today + 91)", { from: "2027-01-14", to: "2027-01-15" }, [400, "TIME_OFF_TOO_FAR"]],
			["2026-13-01", { from: "2026-13-01", to: "2026-12-02" }, [400, "INVALID_DATE"]],
			["no last day", { from: "2026-11-10" }, [400, "INVALID_DATE"]],
			["a reversed range", { from: "2026-11-20", to: "2026-11-14" }, [400, "RANGE_REVERSED"]],
			["61 days", { from: "2026-11-10", to: "2027-01-09" }, [400, "RANGE_TOO_LONG"]],
			["kind \"sick\"", { from: "2026-11-10", to: "2026-11-11", kind: "sick" }, [400, "INVALID_KIND"]],
			["a reason", { from: "2026-11-10", to: "2026-11-11", reason: "Family wedding" }, [400, "REASON_NOT_ALLOWED"]],
			["an empty reason", { from: "2026-11-10", to: "2026-11-11", reason: "" }, [400, "REASON_NOT_ALLOWED"]],
		]) eq(`§1.8 ${label}: ${want.join(" ")}`, code(await ask(w, body)), want);
		eq("§1.9 ...none of them wrote a row", count(w), before);
		ok("§1.10 ...each code's refusal is audited, never with a reason", w.audits("driver_availability_request_blocked").length > auditsBefore
			&& !w.audits("driver_availability_request_blocked").some((a) => /Family wedding/.test(a.details)));
		const soon = await ask(w, { from: "2026-10-19", to: "2026-10-19" });
		eq("§1.11 TOO_SOON names the earliest day in words and sends it (fromMin)",
			[soon.body && soon.body.error, soon.body && soon.body.fromMin],
			["Days off must be asked for at least 5 days ahead. The earliest day you can ask for now is Tue, Oct 20. For sooner days, message dispatch.", "2026-10-20"]);
		// The 60 days are Soren's: any 60 days of Hollis's that start by Jan 13 would cover a request he has waiting.
		eq("§1.12 Jan 13, 2027 (today + 90) and 60 days are allowed", [(await ask(w, { from: "2027-01-13", to: "2027-01-13" })).status,
			(await ask(w, { from: "2026-12-01", to: "2027-01-29" }, USERS.otherDriver)).status], [201, 201]);
		const named = await ask(w, { from: "2026-11-24", to: "2026-11-24", driver: "Soren King", directoryId: DIR.soren, source: "staff", request_status: "approved" });
		const ns = stored(w, reqId(named));
		eq("§1.13 a body naming another driver, a directory row or a status: still his own waiting request",
			[named.status, ns && ns.directory_id, ns && ns.created_by_user_id, ns && ns.request_status, ns && ns.source], [201, DIR.hollis, USERS.driver.id, "requested", "driver"]);
	});

	section("§2 \"today + 5\" on the business clock, under four server zones");
	await R.guard("§2", async () => {
		// [label, instant, today, accepted first day, refused first day]
		const CASES = [
			["Sat Oct 31, 23:59 EDT", "2026-11-01T03:59:00Z", "2026-10-31", "2026-11-05", "2026-11-04"],
			["Sun Nov 1, 00:00 EDT", "2026-11-01T04:00:00Z", "2026-11-01", "2026-11-06", "2026-11-05"],
			["Sun Nov 1, 01:30 EDT (before the clocks go back)", "2026-11-01T05:30:00Z", "2026-11-01", "2026-11-06", "2026-11-05"],
			["Sun Nov 1, 01:30 EST (after)", "2026-11-01T06:30:00Z", "2026-11-01", "2026-11-06", "2026-11-05"],
			["Sat Oct 31, 21:30 PDT (Sun 00:30 EDT)", "2026-11-01T04:30:00Z", "2026-11-01", "2026-11-06", "2026-11-05"],
			["Sun Nov 1, 23:59 EST", "2026-11-02T04:59:00Z", "2026-11-01", "2026-11-06", "2026-11-05"],
			["Mon Nov 2, 00:00 EST", "2026-11-02T05:00:00Z", "2026-11-02", "2026-11-07", "2026-11-06"],
		];
		const zoneBefore = process.env.TZ;
		const seen = new Set();
		for (const zone of ["UTC", "America/Los_Angeles", "Asia/Manila", "Pacific/Kiritimati"]) {
			process.env.TZ = zone;
			for (const [label, iso, today, accepted, refused] of CASES) {
				const w = await world({ now: Date.parse(iso) });
				const limits = (await mine(w)).body;
				const no = await ask(w, { from: refused, to: refused });
				const yes = await ask(w, { from: accepted, to: accepted });
				const got = [limits && limits.today, limits && limits.requestLimits && limits.requestLimits.fromMin, code(no), no.body && no.body.fromMin, yes.status];
				eq(`§2 ${label}, server zone ${zone}: today ${today}; ${accepted} accepted, ${refused} refused`, got, [today, accepted, [400, "TIME_OFF_TOO_SOON"], accepted, 201]);
				seen.add(`${label}|${JSON.stringify(got)}`);
				await w.close();
			}
		}
		if (zoneBefore === undefined) delete process.env.TZ;
		else process.env.TZ = zoneBefore;
		eq("§2.1 every server zone gave the same answers", seen.size, CASES.length);
	});

	section("§3 overlap and the cap");
	await R.guard("§3", async () => {
		const w = await world();
		eq("§3.0 staff record Oct 24-26 for him", (await staffCreate(w, DIR.hollis, { kind: "vacation", from: "2026-10-24", to: "2026-10-26" })).status, 201);
		const over = await ask(w, { from: "2026-10-26", to: "2026-10-28" });
		eq("§3.1 a request over his approved time off: 409 AVAILABILITY_OVERLAP, in his words", [...code(over), over.body && over.body.error],
			[409, "AVAILABILITY_OVERLAP", "You already have time off or a request on these days."]);
		const first = reqId(await ask(w, { from: "2026-11-02", to: "2026-11-04" }));
		eq("§3.2 a request over his waiting request: 409", code(await ask(w, { from: "2026-11-04", to: "2026-11-05" })), [409, "AVAILABILITY_OVERLAP"]);
		eq("§3.3 declined, it blocks nothing: the same days asked again, 201", [(await decline(w, first)).status, (await ask(w, { from: "2026-11-02", to: "2026-11-04" })).status], [200, 201]);
		const c = await world();
		for (const d of ["2026-11-02", "2026-11-04", "2026-11-06", "2026-11-08", "2026-11-10"]) await ask(c, { from: d, to: d });
		eq("§3.4 five waiting: a sixth is 409 TOO_MANY_WAITING", code(await ask(c, { from: "2026-11-12", to: "2026-11-12" })), [409, "TOO_MANY_WAITING"]);
		eq("§3.5 ...another driver's cap is his own", (await ask(c, { from: "2026-11-12", to: "2026-11-12" }, USERS.otherDriver)).status, 201);
		const p = await world();
		for (const d of ["2026-11-02", "2026-11-04", "2026-11-06", "2026-11-08"]) await ask(p, { from: d, to: d });
		plant(p, { from: "2026-10-01", to: "2026-10-03" });
		eq("§3.6 a waiting request whose days have passed doesn't count toward the five", (await ask(p, { from: "2026-11-12", to: "2026-11-12" })).status, 201);
	});

	section("§4 who asks");
	await R.guard("§4", async () => {
		const w = await world();
		const nobody = { id: 40, role: "Driver", username: "drv_nobody", driverName: "Nobody Listed" };
		w.db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (40, 'drv_nobody', 'x', 'Driver', 'Nobody Listed')").run();
		eq("§4.1 an account whose name is on no directory row: 409 DRIVER_NOT_ON_DIRECTORY", code(await ask(w, { from: "2026-11-02", to: "2026-11-02" }, nobody)), [409, "DRIVER_NOT_ON_DIRECTORY"]);
		w.db.prepare("INSERT INTO drivers_directory (id, driver_name, carrier_name, status) VALUES (9, 'Soren  King', 'Acme Carrier', 'active')").run();
		eq("§4.2 two directory rows that normalize to his name: 409 DRIVER_DIRECTORY_AMBIGUOUS", code(await ask(w, { from: "2026-11-02", to: "2026-11-02" }, USERS.otherDriver)), [409, "DRIVER_DIRECTORY_AMBIGUOUS"]);
		w.db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (41, 'drv_hollis_old', 'x', 'Driver', 'hollis  renner')").run();
		eq("§4.3 L3: another account holds his name in another spacing: 409 DRIVER_DIRECTORY_AMBIGUOUS", code(await ask(w, { from: "2026-11-02", to: "2026-11-02" })), [409, "DRIVER_DIRECTORY_AMBIGUOUS"]);
		const t = await world();
		const ghost = { id: 99, role: "Driver", username: "drv_ghost", driverName: "Hollis Renner" };
		eq("§4.4 a Driver session whose account id names no account: 403 DRIVER_ACCOUNT_REQUIRED, though its session names Hollis",
			code(await ask(t, { from: "2026-11-02", to: "2026-11-02" }, ghost)), [403, "DRIVER_ACCOUNT_REQUIRED"]);
		t.db.prepare("UPDATE users SET role = 'Dispatcher' WHERE id = ?").run(USERS.driver.id);
		eq("§4.5 ...and one whose account is no longer a Driver: 403", code(await ask(t, { from: "2026-11-02", to: "2026-11-02" })), [403, "DRIVER_ACCOUNT_REQUIRED"]);
		eq("§4.6 none of them wrote a row", [count(w), count(t)], [0, 0]);
	});

	section("§5 the driver's cancel");
	await R.guard("§5", async () => {
		const w = await world();
		const id = reqId(await ask(w, { from: "2026-11-02", to: "2026-11-04" }));
		const r = await withdraw(w, id);
		const s = stored(w, id);
		eq("§5.1 his own waiting request: 200; stamped cancelled by him, never deleted, still a request", [r.status, !!s.cancelled_at, s.cancelled_by, s.request_status], [200, true, "drv_hollis", "requested"]);
		eq("§5.2 ...audited", w.audits("driver_availability_request_cancel").map((a) => a.details), ["Hollis Renner: off 2026-11-02..2026-11-04 (off_duty) request cancelled by the driver"]);
		eq("§5.3 ...the staff notice says so, and open pages hear it", [metaOf(staffNotices(w)[0]).decision, metaOf(staffNotices(w)[0]).decidedBy,
			w.emits.some((e) => e.room === "dispatch" && e.event === "time-off-request-decided" && e.payload.decision === "cancelled")], ["cancelled", "driver", true]);
		eq("§5.4 cancelling it again: 409 AVAILABILITY_CANCELLED", code(await withdraw(w, id)), [409, "AVAILABILITY_CANCELLED"]);
		const a = reqId(await ask(w, { from: "2026-11-09", to: "2026-11-10" }));
		await approve(w, a);
		const late = await withdraw(w, a);
		eq("§5.5 once approved: 409 TIME_OFF_REQUEST_DECIDED, \"Message dispatch to change it\", never naming who decided",
			[...code(late), late.body && late.body.error, /dispatch_t/.test(late.text)], [409, "TIME_OFF_REQUEST_DECIDED", "This request was already decided. Message dispatch to change it.", false]);
		const d = reqId(await ask(w, { from: "2026-11-16", to: "2026-11-17" }));
		await decline(w, d);
		eq("§5.6 once declined: the same 409", code(await withdraw(w, d)), [409, "TIME_OFF_REQUEST_DECIDED"]);
		const soren = reqId(await ask(w, { from: "2026-11-02", to: "2026-11-02" }, USERS.otherDriver));
		const staffRow = (await staffCreate(w, DIR.hollis, { kind: "vacation", from: "2026-12-01", to: "2026-12-02" })).body.row.id;
		const oldAccount = plant(w, { from: "2026-12-07", to: "2026-12-08", by: 77 });
		const otherRow = plant(w, { dir: DIR.soren, name: "Soren King", from: "2026-12-14", to: "2026-12-15", by: USERS.driver.id });
		eq("§5.7 another driver's request, an unknown id, a staff row, another account's request on his row, his account's request on another row: 404 each",
			[(await withdraw(w, soren)).status, (await withdraw(w, 9999)).status, (await withdraw(w, staffRow)).status, (await withdraw(w, oldAccount)).status, (await withdraw(w, otherRow)).status],
			[404, 404, 404, 404, 404]);
		eq("§5.8 ...each left as it was", [stored(w, soren).cancelled_at, stored(w, staffRow).cancelled_at, stored(w, oldAccount).cancelled_at, stored(w, otherRow).cancelled_at], [null, null, null, null]);
	});

	section("§6 the decision");
	await R.guard("§6", async () => {
		// Two unassigned loads: 7801 on Oct 21 (row 6) and 7802 on Nov 3 (row 7).
		const w = await world({ rows: [...W.defaultRows(),
			W.jtRow({ id: "7801", pickup: "10/21/2026 08:00", dropoff: "10/21/2026 17:00" }),
			W.jtRow({ id: "7802", pickup: "11/3/2026 08:00", dropoff: "11/3/2026 17:00" })] });
		const dispatch = (rowIndex, loadId) => w.call("POST", "/api/dispatch", { user: USERS.disp, body: { rowIndex, loadId, driver: "Hollis Renner" } });
		const id = reqId(await ask(w, { from: "2026-10-20", to: "2026-10-22" }));
		w.emits.length = 0;
		const r = await approve(w, id);
		const s = stored(w, id);
		eq("§6.1 a Dispatcher approves: 200, approved, by whom and when", [r.status, r.body && r.body.decision, r.body && r.body.decidedBy, s.request_status, s.decided_by, s.decided_by_user_id, !!s.decided_at],
			[200, "approved", "dispatch_t", "approved", "dispatch_t", USERS.disp.id, true]);
		eq("§6.2 ...audited", w.audits("driver_availability_approve").map((a) => a.details), ["Hollis Renner: off 2026-10-20..2026-10-22 (off_duty) approved"]);
		const dn = driverNotices(w);
		eq("§6.3 ...the driver gets one notice, keyed to his account, saying neither who decided nor why",
			[dn.length, dn[0] && dn[0].driver_name, dn[0] && dn[0].title, dn[0] && dn[0].body, /dispatch_t/.test(JSON.stringify(dn))],
			[1, "hollis renner", "Time off approved: Oct 20 – Oct 22", "", false]);
		eq("§6.4 ...and a live event to his room only, with the notice's id", w.emits.filter((e) => e.event === "time-off-updated").map((e) => [e.room, e.payload]),
			[["driver:hollis renner", { notificationId: dn[0] && dn[0].id }]]);
		eq("§6.5 ...the staff notice now carries the decision; open pages hear it",
			[metaOf(staffNotices(w)[0]), w.emits.filter((e) => e.event === "time-off-request-decided").map((e) => [e.room, e.payload])],
			[{ availabilityId: id, directoryId: DIR.hollis, decision: "approved", decidedBy: "dispatch_t" }, [["dispatch", { availabilityId: id, decision: "approved", decidedBy: "dispatch_t" }]]]);
		const again = await approve(w, id, USERS.sa);
		eq("§6.6 a second decision: 409 TIME_OFF_REQUEST_DECIDED naming the first (staff only)", [...code(again), again.body && again.body.error, again.body && again.body.decidedBy],
			[409, "TIME_OFF_REQUEST_DECIDED", "Already approved by dispatch_t on Oct 15.", "dispatch_t"]);
		eq("§6.7 ...a decline after it too; still one decision and one driver notice", [code(await decline(w, id, USERS.sa)), stored(w, id).request_status, driverNotices(w).length],
			[[409, "TIME_OFF_REQUEST_DECIDED"], "approved", 1]);
		eq("§6.8 an approved request warns dispatch as any time off does: load 7801 (Oct 21) to Hollis, 409 DRIVER_OFF_DUTY",
			code(await dispatch(6, "7801")), [409, "DRIVER_OFF_DUTY"]);

		const d = reqId(await ask(w, { from: "2026-11-02", to: "2026-11-04" }));
		const no = await decline(w, d, USERS.sa);
		eq("§6.9 a Super Admin declines: 200, declined, by whom", [no.status, stored(w, d).request_status, stored(w, d).decided_by], [200, "declined", "super_admin"]);
		eq("§6.10 ...audited, and the driver is told: not approved, message dispatch", [w.audits("driver_availability_decline").map((a) => a.details), driverNotices(w).slice(-1).map((n) => [n.title, n.body])],
			[["Hollis Renner: off 2026-11-02..2026-11-04 (off_duty) declined"], [["Time off not approved: Nov 2 – Nov 4", "Message dispatch."]]]);
		eq("§6.11 ...it never warns: load 7802 (Nov 3) to Hollis, 200", (await dispatch(7, "7802")).status, 200);
		const cancelled = plant(w, { from: "2026-11-23", to: "2026-11-24", cancelled: "2026-10-12T12:00:00Z" });
		const staffRow = (await staffCreate(w, DIR.soren, { kind: "vacation", from: "2026-11-23", to: "2026-11-24" })).body.row.id;
		const staffAns = await approve(w, staffRow);
		eq("§6.12 a cancelled request: 409 AVAILABILITY_CANCELLED; a staff row: 409, nothing to approve; an unknown id: 404",
			[code(await approve(w, cancelled)), [...code(staffAns), staffAns.body && staffAns.body.error], (await decline(w, 9999)).status],
			[[409, "AVAILABILITY_CANCELLED"], [409, "TIME_OFF_REQUEST_DECIDED", "This time off was recorded by staff, so there is nothing to approve or decline."], 404]);
		ok("§6.13 every refused decision is audited", w.audits("driver_availability_decision_blocked").length >= 3);
		const clash = plant(w, { from: "2026-11-30", to: "2026-12-02" });
		await staffCreate(w, DIR.hollis, { kind: "vacation", from: "2026-12-01", to: "2026-12-01" }).catch(() => null);
		w.db.prepare("INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, created_by, created_at, request_status, source) VALUES (?, 'Hollis Renner', 'vacation', '2026-12-02', '2026-12-03', 'super_admin', '2026-10-12T12:00:00Z', 'approved', 'staff')").run(DIR.hollis);
		eq("§6.14 approving over approved time off recorded meanwhile: 409 AVAILABILITY_OVERLAP, still waiting", [code(await approve(w, clash)), stored(w, clash).request_status], [[409, "AVAILABILITY_OVERLAP"], "requested"]);
	});

	section("§7 R11b at approval (DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED)");
	await R.guard("§7", async () => {
		const w = await world({ loadsWarning: true, rows: W.hisLoadsRows() });
		const reads = w.jt.reads;
		const id = reqId(await ask(w, { from: "2026-10-20", to: "2026-10-22" }));
		eq("§7.1 no loads check when the driver asks: 201, Job Tracking not read", [stored(w, id).request_status, w.jt.reads - reads], ["requested", 0]);
		const asked = await approve(w, id);
		eq("§7.2 approving over his load 7001: 409 DRIVER_HAS_LOADS listing it, asking \"Approve anyway?\"",
			[...code(asked), asked.body && asked.body.loads, asked.body && asked.body.error],
			[409, "DRIVER_HAS_LOADS", [{ loadId: "7001", from: "2026-10-20", to: "2026-10-22" }], "Hollis Renner has load 7001 (Oct 20 – Oct 22) overlapping these dates. Approve anyway? The load stays assigned to the driver."]);
		eq("§7.3 ...nothing written: still waiting, no confirmation, no driver notice", [stored(w, id).request_status, w.db.prepare("SELECT COUNT(*) AS n FROM driver_availability_confirmations").get().n, driverNotices(w).length], ["requested", 0, 0]);
		const anyway = await approve(w, id, USERS.disp, { confirmLoads: asked.body.loads });
		const conf = w.db.prepare("SELECT availability_id, load_id, load_from, load_to, via, confirmed_by FROM driver_availability_confirmations").all();
		eq("§7.4 \"Approve anyway\" with the loads echoed: approved, one confirmation per load (via availability_approve), audited",
			[anyway.status, stored(w, id).request_status, conf, w.audits("driver_availability_loads_confirmed").length],
			[200, "approved", [{ availability_id: id, load_id: "7001", load_from: "2026-10-20", load_to: "2026-10-22", via: "availability_approve", confirmed_by: "dispatch_t" }], 1]);
		const u = await world({ loadsWarning: true, rows: W.hisLoadsRows() });
		const uid = reqId(await ask(u, { from: "2026-10-26", to: "2026-10-27" }));
		u.jt.fail = true;
		const unchecked = await approve(u, uid);
		eq("§7.5 Job Tracking unreadable: approved unchecked, the answer and the audit line say so",
			[unchecked.status, unchecked.body && unchecked.body.loadsUnchecked, stored(u, uid).request_status, u.audits("driver_availability_approve").map((a) => a.details)],
			[200, true, "approved", ["Hollis Renner: off 2026-10-26..2026-10-27 (off_duty) approved; loads not checked (Job Tracking unreadable)"]]);
		const race = await world({ loadsWarning: true, rows: W.hisLoadsRows() });
		const rid = reqId(await ask(race, { from: "2026-11-09", to: "2026-11-10" }));
		race.jt.during = () => race.db.prepare("UPDATE driver_availability SET request_status = 'declined', decided_by = 'super_admin', decided_at = '2026-10-15T15:59:00.000Z' WHERE id = ?").run(rid);
		const lost = await approve(race, rid);
		eq("§7.6 a decline landing while the approval reads the sheet wins: 409 naming it, one decision, no approval notice",
			[...code(lost), lost.body && lost.body.decidedBy, stored(race, rid).request_status, driverNotices(race).length], [409, "TIME_OFF_REQUEST_DECIDED", "super_admin", "declined", 0]);
	});

	section("§8 later changes, and staff over requests");
	await R.guard("§8", async () => {
		const w = await world();
		const id = reqId(await ask(w, { from: "2026-10-20", to: "2026-10-23" }));
		await approve(w, id);
		w.emits.length = 0;
		eq("§8.1 staff shorten his approved request to Oct 20-21: 200", (await w.call("PUT", `/api/driver-availability/${id}`, { user: USERS.disp, body: { to: "2026-10-21" } })).status, 200);
		eq("§8.2 ...he is told the new days, live", [driverNotices(w).slice(-1).map((n) => n.title), w.emits.filter((e) => e.event === "time-off-updated").map((e) => e.room)],
			[["Dispatch changed your time off: Oct 20 – Oct 21"], ["driver:hollis renner"]]);
		const before = driverNotices(w).length;
		eq("§8.3 a reason-only change tells him nothing (he never sees the reason)", [(await w.call("PUT", `/api/driver-availability/${id}`, { user: USERS.sa, body: { reason: "Family" } })).status, driverNotices(w).length], [200, before]);
		eq("§8.4 staff cancel it: he is told", [(await w.call("POST", `/api/driver-availability/${id}/cancel`, { user: USERS.disp, body: {} })).status, driverNotices(w).slice(-1).map((n) => n.title)],
			[200, ["Dispatch cancelled your time off: Oct 20 – Oct 21"]]);
		const staffRow = (await staffCreate(w, DIR.hollis, { kind: "vacation", from: "2026-11-02", to: "2026-11-04" })).body.row.id;
		const n0 = driverNotices(w).length;
		await w.call("PUT", `/api/driver-availability/${staffRow}`, { user: USERS.sa, body: { to: "2026-11-03" } });
		await w.call("POST", `/api/driver-availability/${staffRow}/cancel`, { user: USERS.sa, body: {} });
		eq("§8.5 a staff-recorded row changed and cancelled: no driver notice (as before requests)", driverNotices(w).length, n0);
		const waiting = reqId(await ask(w, { from: "2026-11-09", to: "2026-11-10" }));
		const declined = reqId(await ask(w, { from: "2026-11-16", to: "2026-11-17" }));
		await decline(w, declined);
		eq("§8.6 staff edit or cancel a waiting request: 409 TIME_OFF_REQUEST_PENDING; a declined one: 409 TIME_OFF_REQUEST_DECLINED", [
			code(await w.call("PUT", `/api/driver-availability/${waiting}`, { user: USERS.sa, body: { to: "2026-11-11" } })),
			code(await w.call("POST", `/api/driver-availability/${waiting}/cancel`, { user: USERS.sa, body: {} })),
			code(await w.call("PUT", `/api/driver-availability/${declined}`, { user: USERS.sa, body: { to: "2026-11-18" } })),
			code(await w.call("POST", `/api/driver-availability/${declined}/cancel`, { user: USERS.sa, body: {} })),
		], [[409, "TIME_OFF_REQUEST_PENDING"], [409, "TIME_OFF_REQUEST_PENDING"], [409, "TIME_OFF_REQUEST_DECLINED"], [409, "TIME_OFF_REQUEST_DECLINED"]]);
		const over = await staffCreate(w, DIR.hollis, { kind: "vacation", from: "2026-11-10", to: "2026-11-12" });
		eq("§8.7 staff recording over a waiting request: 409 AVAILABILITY_OVERLAP, named as a request to decide first",
			[...code(over), over.body && over.body.error, over.body && over.body.overlapping],
			[409, "AVAILABILITY_OVERLAP", "Hollis Renner has a request for time off Nov 9 – Nov 10 waiting on these dates. Approve or decline it first.", { id: waiting, from: "2026-11-09", to: "2026-11-10", request: "waiting" }]);
		eq("§8.8 ...over a declined one: 201", (await staffCreate(w, DIR.hollis, { kind: "vacation", from: "2026-11-16", to: "2026-11-17" })).status, 201);
	});

	section("§9 roles, the CSRF header and the limiter");
	await R.guard("§9", async () => {
		const w = await world();
		const id = reqId(await ask(w, { from: "2026-11-02", to: "2026-11-03" }));
		// The role check's own answer, { error: "Forbidden" }: the handler never ran (its
		// account check would answer 403 DRIVER_ACCOUNT_REQUIRED instead).
		const roleRefused = (r) => r.status === 403 && r.text === JSON.stringify({ error: "Forbidden" });
		for (const [label, user] of [["Super Admin", USERS.sa], ["Dispatcher", USERS.disp], ["Investor", USERS.inv]]) {
			eq(`§9.1 ${label}: 403 from the role check on the driver's request and cancel`, [roleRefused(await ask(w, { from: "2026-11-09", to: "2026-11-09" }, user)), roleRefused(await withdraw(w, id, user))], [true, true]);
		}
		for (const [label, user] of [["Driver", USERS.driver], ["Investor", USERS.inv]]) {
			eq(`§9.2 ${label}: 403 from the role check on approve and decline`, [roleRefused(await approve(w, id, user)), roleRefused(await decline(w, id, user))], [true, true]);
		}
		eq("§9.3 signed out: 401 on all four", [(await ask(w, {}, null)).status, (await withdraw(w, id, null)).status, (await approve(w, id, null)).status, (await decline(w, id, null)).status], [401, 401, 401, 401]);
		eq("§9.4 no X-Requested-With: 403 CSRF_HEADER_REQUIRED on all four", [
			code(await ask(w, { from: "2026-11-09", to: "2026-11-09" }, USERS.driver, { csrf: false })), code(await withdraw(w, id, USERS.driver, { csrf: false })),
			code(await approve(w, id, USERS.disp, {}, { csrf: false })), code(await decline(w, id, USERS.disp, { csrf: false })),
		], [[403, "CSRF_HEADER_REQUIRED"], [403, "CSRF_HEADER_REQUIRED"], [403, "CSRF_HEADER_REQUIRED"], [403, "CSRF_HEADER_REQUIRED"]]);
		eq("§9.5 ...the request still waits, untouched", [stored(w, id).request_status, stored(w, id).cancelled_at], ["requested", null]);
		const l = await world();
		const statuses = [];
		for (let i = 0; i < 31; i++) statuses.push((await ask(l, { from: "2026-10-16", to: "2026-10-16" })).status);
		eq("§9.6 the limiter: 30 tries in the window answer, the 31st is 429", [statuses.slice(0, 30).every((s) => s === 400), statuses[30]], [true, 429]);
		eq("§9.7 ...counted per account: another driver still asks", (await ask(l, { from: "2026-11-02", to: "2026-11-02" }, USERS.otherDriver)).status, 201);
		eq("§9.8 ...and the exhausted account on a staff route gets 403 (the role check comes first)", (await approve(l, 1, USERS.driver)).status, 403);
	});

	section("§10 the staff panel, and the directory delete");
	await R.guard("§10", async () => {
		const w = await world();
		const waiting = reqId(await ask(w, { from: "2026-11-02", to: "2026-11-03" }));
		const declined = reqId(await ask(w, { from: "2026-11-09", to: "2026-11-10" }));
		await decline(w, declined);
		const staffRow = (await staffCreate(w, DIR.hollis, { kind: "vacation", from: "2026-12-01", to: "2026-12-02" })).body.row.id;
		const panel = await w.call("GET", `/api/drivers-directory/${DIR.hollis}/availability`, { user: USERS.disp });
		const row = (id) => panel.body.rows.find((x) => x.id === id);
		eq("§10.1 each row says whose request it is and its decision", [waiting, declined, staffRow].map((id) => [row(id).request, row(id).source, row(id).decidedBy, row(id).decidedAt === null]),
			[["waiting", "driver", null, true], ["declined", "driver", "dispatch_t", false], ["approved", "staff", null, true]]);
		eq("§10.2 ...a waiting or declined row can't be edited or cancelled from the panel", [row(waiting).editable, row(waiting).limits, row(declined).editable], ["none", null, "none"]);
		const del = await w.call("DELETE", `/api/drivers-directory/${DIR.hollis}`, { user: USERS.sa });
		eq("§10.3 deleting his directory row cancels his waiting request and his time off, and leaves the declined one",
			[del.status, !!stored(w, waiting).cancelled_at, !!stored(w, staffRow).cancelled_at, stored(w, declined).cancelled_at], [200, true, true, null]);
		eq("§10.4 ...the waiting request's notice says so", [metaOf(staffNotices(w)[0]).decision, metaOf(staffNotices(w)[0]).decidedBy], ["cancelled", "system"]);
	});

	section("§11 L4: a late approval");
	await R.guard("§11", async () => {
		const w = await world();
		const late = plant(w, { from: "2026-09-10", to: "2026-09-12" });
		eq("§11.1 a Dispatcher approving a request that started over 30 days back: 400 BACKDATE_LIMIT", code(await approve(w, late)), [400, "BACKDATE_LIMIT"]);
		eq("§11.2 ...a Super Admin may: 200", (await approve(w, late, USERS.sa)).status, 200);
		const late2 = plant(w, { from: "2026-09-01", to: "2026-09-02" });
		eq("§11.3 a Dispatcher may decline one: 200", (await decline(w, late2)).status, 200);
		const edge = plant(w, { from: "2026-09-15", to: "2026-09-16" });
		eq("§11.4 one that started exactly 30 days back (Sep 15): a Dispatcher may approve it", (await approve(w, edge)).status, 200);
	});

	section("§12 the flag off");
	await R.guard("§12", async () => {
		const unknown = async (w) => {
			const base = { POST: await w.call("POST", "/api/no-such-route-pr4", { body: {} }) };
			const like = (r, url) => r.status === base.POST.status && r.text === base.POST.text.replace("/api/no-such-route-pr4", url);
			const out = [];
			for (const [url, users] of [["/api/driver/me/availability", [USERS.driver, USERS.sa, null]], ["/api/driver/me/availability/1/cancel", [USERS.driver, null]],
				["/api/driver-availability/1/approve", [USERS.sa, USERS.disp, USERS.driver, null]], ["/api/driver-availability/1/decline", [USERS.sa, USERS.disp, null]]]) {
				for (const user of users) out.push(like(await w.call("POST", url, { user, body: { from: "2026-11-02", to: "2026-11-02" } }), url));
			}
			return out.every(Boolean);
		};
		const variants = [
			["the requests flag unset", { DRIVER_TIME_OFF_SCREEN_ENABLED: "true", DRIVER_TIME_OFF_REQUESTS_ENABLED: "" }, true],
			["the screen flag unset", { DRIVER_TIME_OFF_SCREEN_ENABLED: "", DRIVER_TIME_OFF_REQUESTS_ENABLED: "true" }, true],
			["the main flag unset", { DRIVER_TIME_OFF_SCREEN_ENABLED: "true", DRIVER_TIME_OFF_REQUESTS_ENABLED: "true" }, false],
		];
		for (const [label, env, flag] of variants) {
			const w = await W.startWorld({ flag, env });
			plant(w, { from: "2026-10-14", to: "2026-10-20" });
			eq(`§12.1 ${label}: the four routes answer like an unknown path, for every role`, await unknown(w), true);
			const me = await mine(w);
			const pg = await page(w);
			const keys = (o) => (o ? Object.keys(o).sort().join() : "");
			ok(`§12.2 ${label}: no request key in the driver's answers`, !/requests|requestLimits|canRequest/.test(`${keys(me.body)}|${keys(pg.body && pg.body.timeOff)}`), `${keys(me.body)} | ${keys(pg.body && pg.body.timeOff)}`);
			eq(`§12.3 ${label}: nothing written`, [count(w), staffNotices(w).length, driverNotices(w).length], [1, 0, 0]);
		}
		const off = await W.startWorld({ env: { DRIVER_TIME_OFF_SCREEN_ENABLED: "true" } });
		const left = plant(off, { from: "2026-11-02", to: "2026-11-04" });
		const panel = await off.call("GET", `/api/drivers-directory/${DIR.hollis}/availability`, { user: USERS.sa });
		eq("§12.4 the staff panel's rows carry no request key", panel.body.rows.every((r) => !("request" in r) && !("source" in r) && !("decidedBy" in r)), true);
		eq("§12.5 a request left waiting from before holds no days: staff record them, 201", (await staffCreate(off, DIR.hollis, { kind: "vacation", from: "2026-11-02", to: "2026-11-04" })).status, 201);
		eq("§12.6 ...and it still counts for nothing (not in his own view)", (await mine(off)).body.rows.map((r) => r.id).includes(left), false);
	});

	section("§13 privacy");
	await R.guard("§13", async () => {
		const w = await world();
		const a = reqId(await ask(w, { from: "2026-10-20", to: "2026-10-21", kind: "vacation" }));
		const d = reqId(await ask(w, { from: "2026-11-02", to: "2026-11-03" }));
		await w.call("PUT", `/api/driver-availability/${a}`, { user: USERS.sa, body: {} });
		await approve(w, a);
		w.db.prepare("UPDATE driver_availability SET reason = 'Private details' WHERE id = ?").run(a);
		await decline(w, d, USERS.sa);
		const own = await mine(w);
		const pg = await page(w);
		const told = JSON.stringify(w.db.prepare("SELECT title, body, metadata FROM notifications WHERE driver_name = 'hollis renner'").all());
		const said = `${own.text}${JSON.stringify(pg.body && pg.body.timeOff)}${told}`;
		ok("§13.1 neither his answers nor his notices name who decided, the reason, or who recorded a row", !/dispatch_t|super_admin|Private details|decided|createdBy|reason/.test(said), said.slice(0, 300));
		eq("§13.2 his requests carry seven keys each (H1: with the home time)", (own.body.requests || []).every((q) => Object.keys(q).sort().join() === "canCancel,from,home,id,kind,request,to"), true);
		const other = await mine(w, USERS.otherDriver);
		eq("§13.3 another driver sees none of his requests", [other.status, other.body.requests, other.body.rows], [200, [], []]);
	});

	section("§14 home time (H1)");
	await R.guard("§14", async () => {
		const w = await world();
		w.db.prepare("UPDATE drivers_directory SET city = ' Springfield ', state = 'mo' WHERE id = ?").run(DIR.hollis);
		const day = { from: "2026-11-02", to: "2026-11-02" };
		const before = count(w);
		for (const [label, home, want] of [
			["no city or state", {}, [400, "HOME_LOCATION_REQUIRED"]],
			["a state only", { homeState: "MO" }, [400, "HOME_LOCATION_REQUIRED"]],
			["a city only", { homeCity: "Springfield" }, [400, "HOME_LOCATION_REQUIRED"]],
			["a blank city and state", { homeCity: "   ", homeState: "" }, [400, "HOME_LOCATION_REQUIRED"]],
			["state \"ZZ\"", { homeCity: "Springfield", homeState: "ZZ" }, [400, "INVALID_HOME_STATE"]],
			["state \"Missouri\" (a name, not its code)", { homeCity: "Springfield", homeState: "Missouri" }, [400, "INVALID_HOME_STATE"]],
			["state PR (a territory)", { homeCity: "Springfield", homeState: "PR" }, [400, "INVALID_HOME_STATE"]],
			["city \"75001\" (digits only)", { homeCity: "75001", homeState: "TX" }, [400, "INVALID_HOME_CITY"]],
			["city \"12\" (no letter)", { homeCity: "12", homeState: "TX" }, [400, "INVALID_HOME_CITY"]],
			["city a phone number", { homeCity: "555-0100", homeState: "TX" }, [400, "INVALID_HOME_CITY"]],
			["city a name with a phone number", { homeCity: "Springfield 5550100", homeState: "TX" }, [400, "INVALID_HOME_CITY"]],
			["city an email", { homeCity: "hollis@example.com", homeState: "TX" }, [400, "INVALID_HOME_CITY"]],
			["city a web address", { homeCity: "www.example.com/home", homeState: "TX" }, [400, "INVALID_HOME_CITY"]],
			["city a street address", { homeCity: "12 Elm Street, Apt 4", homeState: "TX" }, [400, "INVALID_HOME_CITY"]],
			["city 61 letters", { homeCity: "A".repeat(61), homeState: "TX" }, [400, "HOME_CITY_TOO_LONG"]],
			["city a number", { homeCity: 12, homeState: "TX" }, [400, "INVALID_HOME_CITY"]],
		]) eq(`§14.1 his request with ${label}: ${want.join(" ")}`, code(await bare(w, { ...day, ...home })), want);
		eq("§14.1b ...none wrote a row, and no refusal's audit line names a city", [count(w), w.audits("driver_availability_request_blocked").some((a) => /Springfield|Elm|example/.test(a.details))], [before, false]);

		const r = await bare(w, { from: "2026-11-09", to: "2026-11-10", homeCity: "  Coeur   d'Alene ", homeState: " id " });
		const s = stored(w, reqId(r));
		eq("§14.2 the city trimmed with each run of spaces made one, the state's code upper-cased: 201, stored and shown so",
			[r.status, r.body && r.body.request && r.body.request.home, s && [s.home_city, s.home_state]], [201, { city: "Coeur d'Alene", state: "ID" }, ["Coeur d'Alene", "ID"]]);
		const more = [];
		for (const [from, homeCity, homeState] of [["2026-11-16", "Winston-Salem", "NC"], ["2026-11-23", "St. Louis", "MO"], ["2026-11-30", "Twin 29 Pines", "CA"]]) {
			const m = await bare(w, { from, to: from, homeCity, homeState });
			more.push([m.status, m.body && m.body.request && m.body.request.home && m.body.request.home.city]);
		}
		eq("§14.3 a hyphen, a period, two digits: each a city, taken as typed", more, [[201, "Winston-Salem"], [201, "St. Louis"], [201, "Twin 29 Pines"]]);
		const asked = w.audits("driver_availability_request").map((a) => a.details);
		eq("§14.4 the audit names the home time's state, never its city",
			[asked[0], asked.some((d) => /Coeur|Winston|Louis|Pines/.test(d))], ["Hollis Renner: off 2026-11-09..2026-11-10 (off_duty) requested by the driver; home time in ID", false]);
		eq("§14.5 the staff notice names the city and state", staffNotices(w)[0] && staffNotices(w)[0].body, "Off duty. Asked Oct 15. Home time: Coeur d'Alene, ID.");

		const me = await mine(w);
		eq("§14.6 his answer: the form starts at his Drivers page city and state (trimmed, the code upper-cased); each request with its home time",
			[me.body.homeDefault, (me.body.requests || []).map((q) => q.home)],
			[{ city: "Springfield", state: "MO" }, [{ city: "Coeur d'Alene", state: "ID" }, { city: "Winston-Salem", state: "NC" }, { city: "St. Louis", state: "MO" }, { city: "Twin 29 Pines", state: "CA" }]]);
		eq("§14.6b ...the payload's timeOff says the same, form start included", [(await page(w)).body.timeOff, "homeDefault" in me.body], [me.body, true]);
		eq("§14.6c a Super Admin on his page: no form start (he can't ask), the requests' home time shown", [(await page(w, USERS.sa)).body.timeOff.homeDefault, (await page(w, USERS.sa)).body.timeOff.requests.length], [null, 4]);
		w.db.prepare("UPDATE drivers_directory SET city = '75001', state = 'Missouri' WHERE id = ?").run(DIR.hollis);
		eq("§14.6d a Drivers page city or state the request would refuse starts the form blank; none recorded, blank too",
			[(await mine(w)).body.homeDefault, (await mine(w, USERS.otherDriver)).body.homeDefault], [{ city: "", state: "" }, { city: "", state: "" }]);

		await approve(w, reqId(r));
		const staffRow = (await staffCreate(w, DIR.hollis, { kind: "vacation", from: "2026-10-24", to: "2026-10-25" })).body.row.id;
		const rows = (await mine(w)).body.rows;
		eq("§14.7 approved, his request's row keeps its home time; a staff row without one says null",
			[rows.find((x) => x.id === reqId(r)).home, rows.find((x) => x.id === staffRow).home], [{ city: "Coeur d'Alene", state: "ID" }, null]);

		const panel = await w.call("GET", `/api/drivers-directory/${DIR.hollis}/availability`, { user: USERS.disp });
		eq("§14.8 the staff panel offers home time on its add form, and every row carries its home time",
			[panel.body.homeTime, panel.body.rows.every((x) => "home" in x), panel.body.rows.find((x) => x.id === reqId(r)).home], [true, true, { city: "Coeur d'Alene", state: "ID" }]);
		const none = await staffCreate(w, DIR.soren, { kind: "vacation", from: "2026-12-01", to: "2026-12-02" });
		const both = await staffCreate(w, DIR.soren, { kind: "vacation", from: "2026-12-07", to: "2026-12-08", homeCity: "Riverton", homeState: "wy" });
		eq("§14.9 staff record time off with no home time, or with one: 201 each; the audit names the state only",
			[none.status, none.body.row.home, both.status, both.body.row.home, w.audits("driver_availability_create").slice(-2).map((a) => a.details)],
			[201, null, 201, { city: "Riverton", state: "WY" }, ["Soren King: off 2026-12-01..2026-12-02 (vacation)", "Soren King: off 2026-12-07..2026-12-08 (vacation); home time in WY"]]);
		eq("§14.10 ...a city without a state, a state without a city, or a bad state: 400, nothing written", [
			code(await staffCreate(w, DIR.soren, { kind: "vacation", from: "2026-12-14", to: "2026-12-14", homeCity: "Riverton" })),
			code(await staffCreate(w, DIR.soren, { kind: "vacation", from: "2026-12-14", to: "2026-12-14", homeState: "WY" })),
			code(await staffCreate(w, DIR.soren, { kind: "vacation", from: "2026-12-14", to: "2026-12-14", homeCity: "Riverton", homeState: "Wyoming" })),
		], [[400, "HOME_LOCATION_INCOMPLETE"], [400, "HOME_LOCATION_INCOMPLETE"], [400, "INVALID_HOME_STATE"]]);
		const put = (id, body, user = USERS.disp) => w.call("PUT", `/api/driver-availability/${id}`, { user, body });
		const noneId = none.body.row.id;
		const set = await put(noneId, { homeCity: "Lincoln", homeState: "NE" });
		const kept = await put(noneId, { to: "2026-12-03" });
		const same = await put(noneId, { homeCity: "Lincoln", homeState: "NE" });
		eq("§14.11 staff edit the home time like the dates: set it (200), change the days and keep it, the same again is no change",
			[set.status, set.body.row.home, kept.body.row.home, same.body.unchanged], [200, { city: "Lincoln", state: "NE" }, { city: "Lincoln", state: "NE" }, true]);
		const half = await put(noneId, { homeCity: "" });
		const cleared = await put(noneId, { homeCity: "", homeState: "" });
		eq("§14.12 ...clearing one side only: 400 HOME_LOCATION_INCOMPLETE; both: 200, none",
			[code(half), cleared.status, cleared.body.row.home, [stored(w, noneId).home_city, stored(w, noneId).home_state]], [[400, "HOME_LOCATION_INCOMPLETE"], 200, null, [null, null]]);
		eq("§14.13 ...each change audited with the state only, a removal as such",
			w.audits("driver_availability_update").filter((a) => a.entity_id === String(DIR.soren)).map((a) => a.details),
			["Soren King: off 2026-12-01..2026-12-02 (vacation) -> off 2026-12-01..2026-12-02 (vacation); home time in NE",
				"Soren King: off 2026-12-01..2026-12-02 (vacation) -> off 2026-12-01..2026-12-03 (vacation)",
				"Soren King: off 2026-12-01..2026-12-03 (vacation) -> off 2026-12-01..2026-12-03 (vacation); home time removed"]);
		const told = driverNotices(w).length;
		const homeOnly = await put(reqId(r), { homeCity: "Boise", homeState: "ID" }, USERS.sa);
		eq("§14.14 staff changing only the home time of his approved request: 200, changed, and no notice (it names days only)",
			[homeOnly.status, homeOnly.body.row.home, driverNotices(w).length], [200, { city: "Boise", state: "ID" }, told]);

		// An older row (started Sep 5, over 30 days back): a Dispatcher may only end it early.
		const old = Number(w.db.prepare(`INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, reason, created_by, created_at, home_city, home_state)
			VALUES (?, 'Tamsin Vale', 'vacation', '2026-09-05', '2026-10-20', '', 'super_admin', '2026-09-01T12:00:00Z', 'Riverton', 'WY')`).run(DIR.tamsin).lastInsertRowid);
		const early = await put(old, { to: "2026-10-18" });
		const moved = await put(old, { to: "2026-10-17", homeCity: "Lincoln", homeState: "NE" });
		eq("§14.15 a Dispatcher ends an older row early (its home time kept), but can't change its home time: 400 BACKDATE_LIMIT; a Super Admin can",
			[early.status, early.body.row.home, code(moved), (await put(old, { to: "2026-10-17", homeCity: "Lincoln", homeState: "NE" }, USERS.sa)).body.row.home],
			[200, { city: "Riverton", state: "WY" }, [400, "BACKDATE_LIMIT"], { city: "Lincoln", state: "NE" }]);
	});

	await R.guard("§14 flag off", async () => {
		// The requests flag off (the screen flag on): the home keys are ignored and never sent.
		const off = await W.startWorld({ env: { DRIVER_TIME_OFF_SCREEN_ENABLED: "true" } });
		off.db.prepare("UPDATE drivers_directory SET city = 'Springfield', state = 'MO' WHERE id = ?").run(DIR.hollis);
		const offRow = await staffCreate(off, DIR.hollis, { kind: "vacation", from: "2026-10-20", to: "2026-10-21", homeCity: "Riverton", homeState: "ZZ" });
		const offStored = off.db.prepare("SELECT home_city, home_state FROM driver_availability WHERE id = ?").get(offRow.body.row.id);
		const offEdit = await off.call("PUT", `/api/driver-availability/${offRow.body.row.id}`, { user: USERS.sa, body: { homeCity: "Lincoln", homeState: "NE" } });
		const offPanel = await off.call("GET", `/api/drivers-directory/${DIR.hollis}/availability`, { user: USERS.sa });
		const offMine = await mine(off);
		eq("§14.16 flag off: a staff body's home time (even a bad one) is ignored: 201, nothing stored, an edit of it alone is no change",
			[offRow.status, offStored, offEdit.body.unchanged, off.audits("driver_availability_create").map((a) => a.details)],
			[201, { home_city: null, home_state: null }, true, ["Hollis Renner: off 2026-10-20..2026-10-21 (vacation)"]]);
		eq("§14.17 ...and no answer carries a home key: the panel, its rows, his rows, his own answer",
			[("homeTime" in offPanel.body), offPanel.body.rows.some((x) => "home" in x), offMine.body.rows.some((x) => "home" in x), Object.keys(offMine.body).sort().join()],
			[false, false, false, "rows,today"]);
	});

	await R.guard("§14 CHR", async () => {
		// Nothing composed for CHR names the home time: the lib modules named for CHR (chr-*.js,
		// and a time-off-chr-draft.js once it exists), and every server.js statement whose head
		// names CHR (chrIntegration, CHR_..., buildChrDraft; not "chromium"), mention none of its names.
		const HOME_NAMES_RE = /\b(?:home_city|home_state|homeCity|homeState|homeDefault|homeLocation\w*|validateHomeLocation|storedHomeLocation|homeAuditNote)\b/;
		const CHR_FILE_RE = /(?:^|-)chr[-.]/;
		const CHR_HEAD_RE = /\bchr(?:[A-Z_.-]|\b)|CHR|Chr(?=[A-Z])/;
		const libDir = path.join(W.ROOT, "lib");
		const chrFiles = fs.readdirSync(libDir).filter((f) => CHR_FILE_RE.test(f) && f.endsWith(".js"));
		const isHead = (l) => /^[^\s}\])`/]/.test(l);
		const statements = [];
		for (const l of W.SRC.split("\n")) {
			if (isHead(l)) statements.push({ head: l, lines: [l] });
			else if (statements.length) statements[statements.length - 1].lines.push(l);
		}
		const chrStatements = statements.filter((st) => CHR_HEAD_RE.test(st.head));
		eq("§14.18 nothing composed for CHR names the home time: its names exist, and no CHR module or CHR statement in server.js mentions one",
			[HOME_NAMES_RE.test(W.SRC), chrFiles.length >= 5,
				chrFiles.filter((f) => HOME_NAMES_RE.test(fs.readFileSync(path.join(libDir, f), "utf8"))),
				chrStatements.filter((st) => HOME_NAMES_RE.test(st.lines.join("\n"))).map((st) => st.head.slice(0, 80))],
			[true, true, [], []]);
	});

	await R.finish();
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
