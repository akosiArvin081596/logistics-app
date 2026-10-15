#!/usr/bin/env node
// Driver availability (R11), with DRIVER_AVAILABILITY_ENABLED on: the table,
// the six routes, who may use them, what they record, the directory delete, and
// the ELD silence sweep pausing while a truck's driver is off.
//
// The owner's rules (2026-10-15): Super Admin and Dispatcher create, edit, end
// and cancel; a Driver sees his own rows, read-only and without the reason;
// Investors see nothing. One row is at most 60 days. A Dispatcher may start or
// change a row at most 30 days back and may end a row early only by moving its
// end date earlier, never before yesterday; a Super Admin is not limited. Rows
// are never deleted (a cancel is a stamp). Dates are calendar days on the
// business clock (APP_TIMEZONE, Eastern), "today" 2026-10-15 here.
//
//   §1 the migration: the shipped DDL, run twice
//   §2 create: 400 INVALID_DATE / RANGE_REVERSED / RANGE_TOO_LONG /
//      INVALID_KIND / REASON_TOO_LONG / BACKDATE_LIMIT, 409 AVAILABILITY_OVERLAP
//   §3 edit (one validator with create): the same codes on the merged row, the
//      overlap check ignoring the row itself and cancelled rows, 409
//      AVAILABILITY_CANCELLED, the Dispatcher's 30-day and end-early rules
//   §4 cancel
//   §5 roles and the CSRF header; the driver's own read-only view
//   §6 the directory delete cancels a driver's live rows; a re-added driver
//      starts with none; an orphan row pauses nothing
//   §7 the sweep: the open alert resolves while the driver is off, stays quiet
//      through the grace after he returns, then re-opens; a row still owing an
//      email retry (#507) resolves and is not retried; a load given him with
//      "Assign anyway" that covers today makes his truck alert as normal (the
//      owner's rule, 2026-10-15)
//
// Everything runs through scripts/lib/availability-world.js: the shipped routes
// and sweep lifted out of server.js on an in-memory SQLite, over HTTP.
// Run: node scripts/test-driver-availability.js

"use strict";

const W = require("./lib/availability-world");
const Database = require("better-sqlite3");

const R = W.createRunner("test-driver-availability");
const { ok, eq, section } = R;
const { USERS, DIR } = W;

const create = (w, dirId, body, user = USERS.sa, opts = {}) => w.call("POST", `/api/drivers-directory/${dirId}/availability`, { user, body, ...opts });
const edit = (w, id, body, user = USERS.sa) => w.call("PUT", `/api/driver-availability/${id}`, { user, body });
const cancel = (w, id, user = USERS.sa) => w.call("POST", `/api/driver-availability/${id}/cancel`, { user, body: {} });
const list = (w, dirId, user = USERS.sa) => w.call("GET", `/api/drivers-directory/${dirId}/availability`, { user });
const stored = (w, id) => w.db.prepare("SELECT * FROM driver_availability WHERE id = ?").get(id);
const count = (w) => w.db.prepare("SELECT COUNT(*) AS n FROM driver_availability").get().n;
const code = (r) => [r.status, r.body && r.body.code];
const rowId = (r) => (r.body && r.body.row ? r.body.row.id : null);
const vacation = (from, to, extra = {}) => ({ kind: "vacation", from, to, reason: "Family", ...extra });

(async () => {
	section("§1 the migration");
	await R.guard("§1", async () => {
		const m = W.SRC.match(/db\.exec\(`\s*CREATE TABLE IF NOT EXISTS driver_availability[\s\S]*?`\);/g) || [];
		eq("§1.1 server.js creates driver_availability once, in one db.exec", m.length, 1);
		if (m.length !== 1) return;
		const db = new Database(":memory:");
		const run = new Function("db", m[0]);
		let threw = null;
		try { run(db); run(db); } catch (err) { threw = err.message; }
		eq("§1.2 the migration runs twice without error", threw, null);
		const cols = db.prepare("PRAGMA table_info(driver_availability)").all().map((c) => c.name);
		eq("§1.3 its columns", cols, ["id", "directory_id", "driver_name", "kind", "from_date", "to_date", "reason", "created_by",
			"created_by_user_id", "created_at", "updated_at", "cancelled_at", "cancelled_by"]);
		ok("§1.4 the (directory_id, from_date) index exists",
			db.prepare("PRAGMA index_list(driver_availability)").all().some((i) => i.name === "idx_driver_avail_dir"));
		eq("§1.4b the same migration records \"Assign anyway\" confirmations, with the load's window",
			db.prepare("PRAGMA table_info(driver_availability_confirmations)").all().map((c) => c.name),
			["id", "availability_id", "directory_id", "load_id", "load_from", "load_to", "via", "confirmed_by", "confirmed_by_user_id", "confirmed_at"]);
		const ins = (kind, from, to) => {
			try {
				db.prepare("INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, created_by, created_at) VALUES (1, 'x', ?, ?, ?, 'test', '2026-10-15T00:00:00Z')").run(kind, from, to);
				return "ok";
			} catch { return "refused"; }
		};
		eq("§1.5 the table refuses an unknown kind and a reversed range", [ins("sick", "2026-10-01", "2026-10-02"), ins("vacation", "2026-10-05", "2026-10-02"), ins("off_duty", "2026-10-01", "2026-10-01")], ["refused", "refused", "ok"]);
	});

	section("§2 create");
	await R.guard("§2", async () => {
		const w = await W.startWorld();
		const excludedBefore = w.db.prepare("SELECT COUNT(*) AS n FROM excluded_driver_days").get().n;
		const r = await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20"));
		eq("§2.1 Super Admin records Oct 14-20: 201", r.status, 201);
		const row = r.body && r.body.row;
		eq("§2.2 ...the row as served", row && [row.directoryId, row.kind, row.from, row.to, row.reason, row.status], [DIR.hollis, "vacation", "2026-10-14", "2026-10-20", "Family", "current"]);
		const s = stored(w, rowId(r));
		eq("§2.3 ...stored with the driver's name, the actor and no cancel", s && [s.driver_name, s.created_by, s.created_by_user_id, s.cancelled_at], ["Hollis Renner", "super_admin", 1, null]);
		const audit = w.audits("driver_availability_create");
		eq("§2.4 ...audited once, entity driver, id the directory id", audit.map((a) => [a.entity, a.entity_id]), [["driver", String(DIR.hollis)]]);
		ok("§2.5 ...the audit names the dates and kind", audit[0] && audit[0].details.includes("off 2026-10-14..2026-10-20 (vacation)"));
		ok("§2.6 ...and notifies the drivers screens", w.changes.includes("drivers"));

		const before = count(w);
		for (const [label, body, want] of [
			["2026-13-01", vacation("2026-13-01", "2026-10-20"), [400, "INVALID_DATE"]],
			["2026-10-1", vacation("2026-10-1", "2026-10-20"), [400, "INVALID_DATE"]],
			["2026-02-30", vacation("2026-02-30", "2026-03-02"), [400, "INVALID_DATE"]],
			["a missing end date", { kind: "vacation", from: "2026-11-01" }, [400, "INVALID_DATE"]],
			["a reversed range", vacation("2026-11-20", "2026-11-14"), [400, "RANGE_REVERSED"]],
			["61 days", vacation("2026-11-01", "2026-12-31"), [400, "RANGE_TOO_LONG"]],
			["kind \"sick\"", vacation("2026-11-01", "2026-11-02", { kind: "sick" }), [400, "INVALID_KIND"]],
			["a 201-character reason", vacation("2026-11-01", "2026-11-02", { reason: "x".repeat(201) }), [400, "REASON_TOO_LONG"]],
			["Oct 18-22, over Oct 14-20", vacation("2026-10-18", "2026-10-22"), [409, "AVAILABILITY_OVERLAP"]],
			["Oct 20-20, touching Oct 14-20", vacation("2026-10-20", "2026-10-20"), [409, "AVAILABILITY_OVERLAP"]],
		]) eq(`§2.7 ${label}: ${want.join(" ")}`, code(await create(w, DIR.hollis, body)), want);
		eq("§2.8 ...none of them wrote a row", count(w), before);
		ok("§2.9 ...and each refusal is audited", w.audits("driver_availability_create_blocked").length >= 1);
		eq("§2.10 60 days is allowed", (await create(w, DIR.hollis, vacation("2026-11-01", "2026-12-30"))).status, 201);
		eq("§2.11 a day right after a row is allowed (Oct 21)", (await create(w, DIR.hollis, vacation("2026-10-21", "2026-10-21"))).status, 201);
		eq("§2.12 an unknown driver: 404", (await create(w, 999, vacation("2026-11-01", "2026-11-02"))).status, 404);

		eq("§2.13 Dispatcher, from 31 days back (Sep 14): 400 BACKDATE_LIMIT", code(await create(w, DIR.soren, vacation("2026-09-14", "2026-09-16"), USERS.disp)), [400, "BACKDATE_LIMIT"]);
		eq("§2.14 Dispatcher, from 30 days back (Sep 15): 201", (await create(w, DIR.soren, vacation("2026-09-15", "2026-09-16"), USERS.disp)).status, 201);
		eq("§2.15 Super Admin, from Aug 1: 201", (await create(w, DIR.tamsin, vacation("2026-08-01", "2026-08-05"))).status, 201);
		eq("§2.16 kind off_duty and other, no reason: 201",
			[(await create(w, DIR.soren, { kind: "off_duty", from: "2026-11-02", to: "2026-11-03" }, USERS.disp)).status,
				(await create(w, DIR.soren, { kind: "other", from: "2026-11-05", to: "2026-11-05" }, USERS.disp)).status], [201, 201]);
		eq("§2.17 excluded_driver_days is untouched", w.db.prepare("SELECT COUNT(*) AS n FROM excluded_driver_days").get().n, excludedBefore);
		const listed = await list(w, DIR.hollis, USERS.disp);
		eq("§2.18 GET the driver's rows (Dispatcher): 200, newest first", [listed.status, listed.body && listed.body.rows.map((x) => x.from)], [200, ["2026-11-01", "2026-10-21", "2026-10-14"]]);
		eq("§2.19 GET for an unknown driver: 404", (await list(w, 999)).status, 404);
	});

	section("§3 edit");
	await R.guard("§3", async () => {
		const w = await W.startWorld();
		const a = rowId(await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20")));
		const b = rowId(await create(w, DIR.hollis, vacation("2026-10-25", "2026-10-30")));
		ok("§3.0 two rows to edit", !!a && !!b);
		const snapshot = (id) => JSON.stringify(stored(w, id));
		const aBefore = snapshot(a);
		for (const [label, body, want] of [
			["from 2026-13-01", { from: "2026-13-01" }, [400, "INVALID_DATE"]],
			["to before the stored from", { to: "2026-10-10" }, [400, "RANGE_REVERSED"]],
			["to Dec 13 (61 days from Oct 14)", { to: "2026-12-13" }, [400, "RANGE_TOO_LONG"]],
			["moved onto the Oct 25-30 row", { from: "2026-10-26", to: "2026-10-28" }, [409, "AVAILABILITY_OVERLAP"]],
			["kind \"sick\"", { kind: "sick" }, [400, "INVALID_KIND"]],
		]) eq(`§3.1 ${label}: ${want.join(" ")}`, code(await edit(w, a, body)), want);
		eq("§3.2 ...the row is unchanged", snapshot(a), aBefore);
		ok("§3.3 ...and the refusals are audited", w.audits("driver_availability_update_blocked").length >= 1);

		eq("§3.4 the same body again: 200 (the overlap check ignores the row itself)", (await edit(w, a, vacation("2026-10-14", "2026-10-20"))).status, 200);
		const early = await edit(w, a, { to: "2026-10-18" });
		eq("§3.5 end early (only to): 200, the stored from kept", [early.status, early.body && early.body.row.from, early.body && early.body.row.to], [200, "2026-10-14", "2026-10-18"]);
		const audit = w.audits("driver_availability_update");
		ok("§3.6 ...audited with before and after", audit.length >= 1 && /2026-10-14\.\.2026-10-20/.test(audit[audit.length - 1].details) && /2026-10-14\.\.2026-10-18/.test(audit[audit.length - 1].details));
		ok("§3.7 ...the stored row has updated_at", !!stored(w, a).updated_at);

		eq("§3.8 cancel the Oct 25-30 row", (await cancel(w, b)).status, 200);
		eq("§3.9 now Oct 14-27 overlaps only a cancelled row: 200", (await edit(w, a, { to: "2026-10-27" })).status, 200);
		const bBefore = snapshot(b);
		eq("§3.10 editing a cancelled row: 409 AVAILABILITY_CANCELLED", code(await edit(w, b, { to: "2026-10-29" })), [409, "AVAILABILITY_CANCELLED"]);
		eq("§3.11 cancelling it again: 409 AVAILABILITY_CANCELLED", code(await cancel(w, b)), [409, "AVAILABILITY_CANCELLED"]);
		eq("§3.12 ...the cancelled row is unchanged", snapshot(b), bBefore);
		eq("§3.13 an unknown id: 404", (await edit(w, 9999, { to: "2026-10-29" })).status, 404);
		w.db.prepare("INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, created_by, created_at) VALUES (999, 'Gone Driver', 'vacation', '2026-10-14', '2026-10-16', 'test', '2026-10-15T00:00:00Z')").run();
		const orphan = w.db.prepare("SELECT id FROM driver_availability WHERE directory_id = 999").get().id;
		eq("§3.14 a row whose directory row is gone: 404 to edit and to cancel", [(await edit(w, orphan, { to: "2026-10-15" })).status, (await cancel(w, orphan)).status], [404, 404]);

		// The Dispatcher's limits.
		eq("§3.15 Dispatcher moves from to 31 days back: 400 BACKDATE_LIMIT", code(await edit(w, a, { from: "2026-09-14" }, USERS.disp)), [400, "BACKDATE_LIMIT"]);
		eq("§3.16 Dispatcher moves from to 30 days back: 200", (await edit(w, a, { from: "2026-09-15", to: "2026-10-20" }, USERS.disp)).status, 200);
		const old = rowId(await create(w, DIR.tamsin, vacation("2026-09-10", "2026-10-25")));
		ok("§3.17 a Super Admin row starting 35 days back (Sep 10 - Oct 25)", !!old);
		eq("§3.18 Dispatcher changes its reason: 400 BACKDATE_LIMIT", code(await edit(w, old, { reason: "Personal" }, USERS.disp)), [400, "BACKDATE_LIMIT"]);
		eq("§3.19 Dispatcher moves its end later: 400 BACKDATE_LIMIT", code(await edit(w, old, { to: "2026-10-28" }, USERS.disp)), [400, "BACKDATE_LIMIT"]);
		eq("§3.20 Dispatcher cancels it: 400 BACKDATE_LIMIT", code(await cancel(w, old, USERS.disp)), [400, "BACKDATE_LIMIT"]);
		eq("§3.21 Dispatcher ends it early, to before yesterday (Oct 13): 400 BACKDATE_LIMIT", code(await edit(w, old, { to: "2026-10-13" }, USERS.disp)), [400, "BACKDATE_LIMIT"]);
		const endYesterday = await edit(w, old, { to: "2026-10-14" }, USERS.disp);
		eq("§3.22 Dispatcher ends it early, to yesterday (Oct 14): 200", [endYesterday.status, endYesterday.body && endYesterday.body.row.to], [200, "2026-10-14"]);
		const recent = rowId(await create(w, DIR.soren, vacation("2026-10-05", "2026-10-25"), USERS.disp));
		eq("§3.23 Dispatcher ends a recent row early to before yesterday (Oct 12): 400 BACKDATE_LIMIT", code(await edit(w, recent, { to: "2026-10-12" }, USERS.disp)), [400, "BACKDATE_LIMIT"]);
		eq("§3.24 ...and to today: 200", (await edit(w, recent, { to: "2026-10-15" }, USERS.disp)).status, 200);
		eq("§3.25 Super Admin edits and cancels the old row: 200, 200",
			[(await edit(w, old, { reason: "Personal", to: "2026-10-02" })).status, (await cancel(w, old)).status], [200, 200]);
	});

	section("§4 cancel");
	await R.guard("§4", async () => {
		const w = await W.startWorld();
		const a = rowId(await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20")));
		const r = await cancel(w, a, USERS.disp);
		eq("§4.1 Dispatcher cancels: 200, status cancelled", [r.status, r.body && r.body.row.status], [200, "cancelled"]);
		const s = stored(w, a);
		eq("§4.2 ...stamped, never deleted", [!!s, !!s.cancelled_at, s.cancelled_by], [true, true, "dispatch_t"]);
		eq("§4.3 ...audited", w.audits("driver_availability_cancel").map((x) => x.entity_id), [String(DIR.hollis)]);
		eq("§4.4 an unknown id: 404", (await cancel(w, 9999)).status, 404);
	});

	section("§5 roles and the CSRF header");
	await R.guard("§5", async () => {
		const w = await W.startWorld();
		const a = rowId(await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20", { reason: "Family wedding" })));
		await create(w, DIR.hollis, vacation("2026-11-01", "2026-11-03"));
		await create(w, DIR.soren, vacation("2026-10-16", "2026-10-18"));
		await create(w, DIR.tamsin, vacation("2026-09-01", "2026-09-03"));
		const body = vacation("2026-12-01", "2026-12-02");
		eq("§5.1 Dispatcher reads, creates, edits", [(await list(w, DIR.hollis, USERS.disp)).status, (await create(w, DIR.hollis, body, USERS.disp)).status,
			(await edit(w, a, { reason: "Family" }, USERS.disp)).status], [200, 201, 200]);
		for (const [label, user] of [["Driver", USERS.driver], ["Investor", USERS.inv]]) {
			eq(`§5.2 ${label}: 403 on every staff route`, [
				(await list(w, DIR.hollis, user)).status,
				(await create(w, DIR.hollis, vacation("2026-12-10", "2026-12-11"), user)).status,
				(await edit(w, a, { to: "2026-10-19" }, user)).status,
				(await cancel(w, a, user)).status,
				(await w.call("GET", "/api/driver-availability", { user })).status,
			], [403, 403, 403, 403, 403]);
		}
		eq("§5.3 signed out: 401", (await list(w, DIR.hollis, null)).status, 401);
		const noHeader = await create(w, DIR.hollis, vacation("2026-12-20", "2026-12-21"), USERS.sa, { csrf: false });
		eq("§5.4 a write without X-Requested-With: 403 CSRF_HEADER_REQUIRED", code(noHeader), [403, "CSRF_HEADER_REQUIRED"]);
		eq("§5.5 ...edit and cancel too", [(await w.call("PUT", `/api/driver-availability/${a}`, { body: { to: "2026-10-19" }, csrf: false })).status,
			(await w.call("POST", `/api/driver-availability/${a}/cancel`, { body: {}, csrf: false })).status], [403, 403]);

		const mine = await w.call("GET", "/api/driver/me/availability", { user: USERS.driver });
		eq("§5.6 the driver's own view: 200, his current and upcoming rows", [mine.status, mine.body && mine.body.rows.map((x) => [x.from, x.to])],
			[200, [["2026-10-14", "2026-10-20"], ["2026-11-01", "2026-11-03"], ["2026-12-01", "2026-12-02"]]]);
		ok("§5.7 ...without the reason (or any other driver's rows)", mine.body && mine.body.rows.every((x) => !("reason" in x) && !("directoryId" in x) && !("createdBy" in x)) && !/Family/.test(mine.text));
		eq("§5.8 another driver sees only his own", (await w.call("GET", "/api/driver/me/availability", { user: USERS.otherDriver })).body.rows.map((x) => x.from), ["2026-10-16"]);
		eq("§5.9 staff and investors: 403 on the driver's view",
			[(await w.call("GET", "/api/driver/me/availability", { user: USERS.sa })).status, (await w.call("GET", "/api/driver/me/availability", { user: USERS.inv })).status], [403, 403]);
		const all = await w.call("GET", "/api/driver-availability", { user: USERS.disp });
		eq("§5.10 the staff list: live rows ending today or later, by start",
			[all.status, all.body && all.body.rows.map((x) => [x.driver, x.from, x.to])],
			[200, [["Hollis Renner", "2026-10-14", "2026-10-20"], ["Soren King", "2026-10-16", "2026-10-18"], ["Hollis Renner", "2026-11-01", "2026-11-03"], ["Hollis Renner", "2026-12-01", "2026-12-02"]]]);
	});

	section("§6 the directory delete");
	await R.guard("§6", async () => {
		const w = await W.startWorld();
		await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20"));
		await create(w, DIR.hollis, vacation("2026-11-01", "2026-11-03"));
		const past = rowId(await create(w, DIR.hollis, vacation("2026-10-01", "2026-10-02")));
		await cancel(w, past);
		const del = await w.call("DELETE", `/api/drivers-directory/${DIR.hollis}`);
		eq("§6.1 Super Admin deletes the driver's directory row: 200", del.status, 200);
		const rows = w.db.prepare("SELECT cancelled_at, cancelled_by FROM driver_availability WHERE directory_id = ? ORDER BY id").all(DIR.hollis);
		eq("§6.2 ...every live row is cancelled by the system, the cancelled one left as it was",
			rows.map((x) => [!!x.cancelled_at, x.cancelled_by]), [[true, "system:directory-delete"], [true, "system:directory-delete"], [true, "super_admin"]]);
		ok("§6.3 ...audited", w.audits("driver_availability_cancel").some((x) => /directory row deleted/.test(x.details)));
		const again = w.db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, status) VALUES ('Hollis Renner', 'Acme Carrier', 'active')").run().lastInsertRowid;
		const fresh = await list(w, again);
		eq("§6.4 the driver re-added gets a new id and starts with no rows", [Number(again) !== DIR.hollis, fresh.status, fresh.body && fresh.body.rows.length], [true, 200, 0]);
		eq("§6.5 ...and the staff list shows nothing for him", (await w.call("GET", "/api/driver-availability", { user: USERS.disp })).body.rows.length, 0);
	});

	section("§7 the ELD silence sweep");
	await R.guard("§7", async () => {
		const w = await W.startWorld();
		const alertRow = () => w.db.prepare("SELECT * FROM eld_feed_alerts WHERE alert_key = ?").get(`vid:${W.VID.t91}`);
		// #33's feed goes quiet too once the clock moves a week; only #91's mail counts.
		const mails91 = () => w.emails.filter((e) => e.subject.includes("LogisX-#91")).length;
		await w.sweep();
		const opened = alertRow();
		ok("§7.1 #91 dark three days: the alert opens and is told", !!opened && !opened.resolved_at && !!opened.alerted_at);
		const mailed = mails91();
		eq("§7.2 ...one email", mailed, 1);
		await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20"));
		await w.sweep();
		ok("§7.3 he is recorded off Oct 14-20: the next sweep resolves the open row", !!(alertRow() || {}).resolved_at);
		eq("§7.4 ...and sends nothing", mails91(), mailed);
		const health = w.api.eldFeedHealthReport(w.clock.ms);
		const feed = health.feeds.find((f) => f.vehicleId === W.VID.t91);
		eq("§7.5 the health report shows driver_off with the end date", feed && [feed.state, feed.alerting, feed.driverOffUntil], ["driver_off", false, "2026-10-20"]);
		eq("§7.6 ...and counts it", health.summary.driver_off, 1);
		const live = health.feeds.find((f) => f.vehicleId === W.VID.t33);
		eq("§7.7 #33 (its driver not off) is unchanged", live && live.state, "ok");

		w.clock.ms = Date.parse("2026-10-22T02:00:00Z");       // Oct 21, 10:00 PM EDT: back, inside the grace
		await w.sweep();
		eq("§7.8 back on Oct 21, 10 PM: driver_returning, still resolved, nothing sent",
			[w.api.eldFeedHealthReport(w.clock.ms).feeds.find((f) => f.vehicleId === W.VID.t91).state, !!alertRow().resolved_at, mails91()],
			["driver_returning", true, mailed]);
		w.clock.ms = Date.parse("2026-10-22T04:30:00Z");       // Oct 22, 12:30 AM EDT: grace over
		await w.sweep();
		const reopened = alertRow();
		eq("§7.9 Oct 22, 12:30 AM: the dark feed alerts again, as a new episode",
			[!!reopened && !reopened.resolved_at, mails91(), reopened && reopened.alert_condition], [true, mailed + 1, "stale"]);
	});
	await R.guard("§7b", async () => {
		const w = await W.startWorld();
		w.mailFails = true;
		await w.sweep();
		const row = () => w.db.prepare("SELECT * FROM eld_feed_alerts WHERE alert_key = ?").get(`vid:${W.VID.t91}`);
		const owing = row();
		ok("§7.10 the email failed, the in-app notice went out: the row is open and owes the email", !!owing && !owing.resolved_at && !owing.emailed_at && !!owing.notified_at);
		const tried = w.emails.length;
		w.mailFails = false;
		await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20"));
		await w.sweep();
		eq("§7.11 he is recorded off: the row resolves and the email is not retried", [!!row().resolved_at, w.emails.length], [true, tried]);
		await w.sweep();
		eq("§7.12 ...nor on the sweep after", w.emails.length, tried);
	});
	await R.guard("§7d", async () => {
		// The owner's rule (2026-10-15): after "Assign anyway", a confirmed load
		// covering today overrides the time off, so the truck's dark-ELD alert
		// fires as normal.
		const w = await W.startWorld();
		await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20"));
		const load = W.jtRow({ id: "7300", driver: "Hollis Renner", pickup: "10/15/2026 08:00", dropoff: "10/16/2026 17:00", status: "Dispatched", truck: "LogisX-#91", owner: "5" });
		const asked = await w.call("POST", "/api/data", { body: { values: load } });
		eq("§7.14 a load covering today for Hollis, off Oct 14-20: 409 DRIVER_OFF_DUTY", [asked.status, asked.body && asked.body.code], [409, "DRIVER_OFF_DUTY"]);
		const done = await w.call("POST", "/api/data", { body: { values: load, confirmOffDuty: true } });
		eq("§7.15 ...\"Assign anyway\": 200", done.status, 200);
		await w.sweep();
		const row = w.db.prepare("SELECT * FROM eld_feed_alerts WHERE alert_key = ?").get(`vid:${W.VID.t91}`);
		ok("§7.16 the sweep alerts on his dark truck as normal", !!row && !row.resolved_at && !!row.alerted_at);
		const feed = w.api.eldFeedHealthReport(w.clock.ms).feeds.find((f) => f.vehicleId === W.VID.t91);
		eq("§7.17 ...the health report says stale, not driver_off", feed && feed.state, "stale");
		w.clock.ms = Date.parse("2026-10-18T16:00:00Z");
		await w.sweep();
		eq("§7.18 Oct 18, after that load's days (still off): driver_off again, the alert resolved",
			[w.api.eldFeedHealthReport(w.clock.ms).feeds.find((f) => f.vehicleId === W.VID.t91).state, !!w.db.prepare("SELECT resolved_at FROM eld_feed_alerts WHERE alert_key = ?").get(`vid:${W.VID.t91}`).resolved_at],
			["driver_off", true]);
	});
	// The review's rules (2026-10-15): a confirmation counts on the truck its
	// load names, and only while the load still has that driver and is live.
	const confirmLoad = async (w, truck) => {
		await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20"));
		const load = W.jtRow({ id: "7300", driver: "Hollis Renner", pickup: "10/15/2026 08:00", dropoff: "10/16/2026 17:00", status: "Dispatched", truck, owner: "5" });
		return w.call("POST", "/api/data", { body: { values: load, confirmOffDuty: true } });
	};
	const t91 = (w) => ({
		row: w.db.prepare("SELECT * FROM eld_feed_alerts WHERE alert_key = ?").get(`vid:${W.VID.t91}`),
		state: w.api.eldFeedHealthReport(w.clock.ms).feeds.find((f) => f.vehicleId === W.VID.t91).state,
	});
	await R.guard("§7e", async () => {
		const w = await W.startWorld();
		eq("§7.19 \"Assign anyway\" of a load that runs in another truck (#33): 200", (await confirmLoad(w, "LogisX-#33")).status, 200);
		await w.sweep();
		const s = t91(w);
		eq("§7.20 ...his own parked truck (#91) stays driver_off: no alert", [s.state, !!(s.row && !s.row.resolved_at)], ["driver_off", false]);
	});
	await R.guard("§7f", async () => {
		const w = await W.startWorld();
		await confirmLoad(w, "LogisX-#91");
		await w.sweep();
		eq("§7.21 the confirmed load runs in his own truck: #91 alerts", t91(w).state, "stale");
		const moved = await w.call("PUT", "/api/load/7300", { user: USERS.disp, body: { Driver: "Soren King" } });
		eq("§7.22 the load reassigned to another driver: 200", moved.status, 200);
		await w.sweep();
		const s = t91(w);
		eq("§7.23 ...the confirmation no longer counts: #91 back to driver_off, the alert resolved", [s.state, !!(s.row && s.row.resolved_at)], ["driver_off", true]);
	});
	await R.guard("§7g", async () => {
		const w = await W.startWorld();
		await confirmLoad(w, "LogisX-#91");
		await w.sweep();
		const cancelled = await w.call("PUT", "/api/load/7300", { body: { "Job Status": "Cancelled" } });
		eq("§7.24 the confirmed load cancelled: 200", cancelled.status, 200);
		await w.sweep();
		const s = t91(w);
		eq("§7.25 ...the confirmation no longer counts: #91 back to driver_off, the alert resolved", [s.state, !!(s.row && s.row.resolved_at)], ["driver_off", true]);
	});
	await R.guard("§7c", async () => {
		const w = await W.startWorld();
		w.db.prepare("INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, created_by, created_at) VALUES (999, 'Hollis Renner', 'vacation', '2026-10-14', '2026-10-20', 'test', '2026-10-14T00:00:00Z')").run();
		await w.sweep();
		const row = w.db.prepare("SELECT * FROM eld_feed_alerts WHERE alert_key = ?").get(`vid:${W.VID.t91}`);
		ok("§7.13 a row whose directory row is gone (same name) pauses nothing: #91 alerts", !!row && !row.resolved_at && !!row.alerted_at);
	});

	await R.finish();
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
