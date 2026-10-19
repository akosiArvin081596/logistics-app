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
// The R11 follow-up (the user, 2026-10-16: staff full edit, ended rows too, under
// the same server rules; the driver's own screen behind
// DRIVER_TIME_OFF_SCREEN_ENABLED):
//   §11 the staff GET says per row what the caller may change (`editable`,
//       `limits`) and what a new row may use (`createLimits`), for both roles,
//       on a recent, an old live and an old ended row; the writes' answers carry
//       the same; each served limit is accepted and the day past it refused
//   §12 an edit's audit line says "reason changed" when the reason changed, and
//       no audit row the runner creates, of any action (refusals too), holds
//       any reason text it used. logAudit() swallows its own errors, so an
//       audit row is best effort and is not claimed to commit with the row
//   §13 a Dispatcher's full edit is held to the same rules (guards: these pass
//       before the follow-up too)
//   §14 GET /api/driver/:driverName: `timeOff` only while both flags are on,
//       his own current and upcoming rows, as /api/driver/me/availability
//       answers them
//
// R11b (the user, 2026-10-16), with DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED on:
// recording time off, or moving or extending it, over loads he already has
// warns; "Save anyway" echoes the listed loads and records a confirmation per
// load, so his truck's dark-ELD alert still fires while one covers today; loads
// with no readable day are skipped. Record-only: it pays nothing.
//   §8  create: 409 DRIVER_HAS_LOADS listing his live loads inside the dates,
//       nothing written; the echo (confirmLoads) and nothing else confirms; an
//       echo missing a load added or moved since is asked again; no warning for
//       a past, cancelled, soft-deleted, undated or other driver's load; the
//       sheet unreadable saves unchecked (an echo recorded as given); the
//       overlap check first; the directory row re-read after the sheet read
//   §9  edit: only an edit that adds days reads the sheet; only loads newly
//       covered warn; the stored row re-read after the sheet read (cancelled,
//       moved or its driver deleted meanwhile)
//   §10 the sweep: after "Save anyway" his dark truck alerts while the load
//       covers today; an unchecked confirmation whose load was since
//       reassigned no longer counts
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
	// The re-check's rule (2026-10-15), the safe direction: a Truck cell is
	// matched with the fleet's unit-number rule (unitNumberToken(), "91" names
	// "LogisX-#91"), and a cell naming no known unit counts on the driver's own
	// truck, so a misspelt cell never keeps a dark truck quiet.
	await R.guard("§7h", async () => {
		const w = await W.startWorld();
		eq("§7.26 \"Assign anyway\" of a load whose Truck cell reads \"91\": 200", (await confirmLoad(w, "91")).status, 200);
		await w.sweep();
		const s = t91(w);
		eq("§7.27 ...it names #91: the dark truck alerts", [s.state, !!(s.row && !s.row.resolved_at)], ["stale", true]);
	});
	await R.guard("§7i", async () => {
		const w = await W.startWorld();
		eq("§7.28 \"Assign anyway\" of a load whose Truck cell names no known unit (\"T-999\"): 200", (await confirmLoad(w, "T-999")).status, 200);
		await w.sweep();
		const s = t91(w);
		eq("§7.29 ...it counts on his own truck: #91 alerts", [s.state, !!(s.row && !s.row.resolved_at)], ["stale", true]);
	});
	await R.guard("§7c", async () => {
		const w = await W.startWorld();
		w.db.prepare("INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, created_by, created_at) VALUES (999, 'Hollis Renner', 'vacation', '2026-10-14', '2026-10-20', 'test', '2026-10-14T00:00:00Z')").run();
		await w.sweep();
		const row = w.db.prepare("SELECT * FROM eld_feed_alerts WHERE alert_key = ?").get(`vid:${W.VID.t91}`);
		ok("§7.13 a row whose directory row is gone (same name) pauses nothing: #91 alerts", !!row && !row.resolved_at && !!row.alerted_at);
	});

	// ── R11b ────────────────────────────────────────────────────────────────────
	// W.hisLoadsRows(), with load 7503 soft-deleted as the fixture says.
	const startR11b = async (opts = {}) => {
		const w = await W.startWorld({ loadsWarning: true, rows: W.hisLoadsRows(), ...opts });
		w.db.prepare("INSERT INTO deleted_loads (load_id, deleted_by) VALUES ('7503', 'super_admin')").run();
		return w;
	};
	const confirmsOf = (w) => w.db.prepare("SELECT availability_id, directory_id, load_id, load_from, load_to, via, confirmed_by FROM driver_availability_confirmations ORDER BY id").all();
	const listed = (r) => (r.body && Array.isArray(r.body.loads) ? r.body.loads.map((l) => [l.loadId, l.from, l.to]) : null);
	const echoOf = (r) => (r.body && Array.isArray(r.body.loads) ? r.body.loads.map((l) => ({ loadId: l.loadId, from: l.from, to: l.to })) : []);
	const auditCount = (w) => w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n;
	const lastAudit = (w, action) => { const a = w.audits(action); return a.length ? a[a.length - 1].details : ""; };
	const jtRowOf = (w, loadId) => w.sheet.tabs["Job Tracking"].find((r) => r[W.COL["Load ID"]] === loadId);
	const ASKED = [409, "DRIVER_HAS_LOADS"];

	section("§8 R11b: recording time off over loads he already has");
	await R.guard("§8", async () => {
		const w = await startR11b();
		// Broker and customer cells on his load, to show none reaches the answer.
		const r7001 = jtRowOf(w, "7001");
		r7001[W.COL["Broker Contact Name"]] = "Pat Brokerly";
		r7001[W.COL["Phone Number"]] = "555-0142";
		r7001[W.COL.Email] = "pat@broker.example";
		r7001[W.COL["Pickup Address"]] = "100 Shipper Way, Dallas, TX";
		r7001[W.COL["Drop-off Address"]] = "200 Receiver Rd, Tulsa, OK";
		for (const [label, from, to] of [
			["a past load (7004, Oct 1-3)", "2026-10-01", "2026-10-03"],
			["a load that ended yesterday (7506, Oct 12-14)", "2026-10-12", "2026-10-14"],
			["an undated load (7504, \"TBD\" both), today", "2026-10-15", "2026-10-15"],
			["another driver's load (7002, Soren, Oct 16-17)", "2026-10-16", "2026-10-17"],
			["dates that miss his loads (Oct 23-25)", "2026-10-23", "2026-10-25"],
			["a cancelled load (7502, Oct 28)", "2026-10-28", "2026-10-28"],
			["a soft-deleted load (7503, Oct 29)", "2026-10-29", "2026-10-29"],
		]) {
			const reads = w.jt.reads;
			const r = await create(w, DIR.hollis, vacation(from, to));
			eq(`§8.1 ${label}: 201 with no warning, Job Tracking read`, [r.status, w.jt.reads > reads, !!r.body && "loadsUnchecked" in r.body], [201, true, false]);
		}
		eq("§8.2 ...no confirmation recorded", confirmsOf(w).length, 0);

		const before = count(w);
		const auditsBefore = auditCount(w);
		const asked = await create(w, DIR.hollis, vacation("2026-10-20", "2026-10-21"));
		eq("§8.3 Oct 20-21 over his load 7001 (Oct 20-22): 409 DRIVER_HAS_LOADS listing it", [code(asked), listed(asked)], [ASKED, [["7001", "2026-10-20", "2026-10-22"]]]);
		eq("§8.4 ...naming the driver, the dates asked for and the load's truck",
			asked.body && [asked.body.driver, asked.body.from, asked.body.to, asked.body.loads && asked.body.loads[0].truck], ["Hollis Renner", "2026-10-20", "2026-10-21", "LogisX-#91"]);
		eq("§8.5 ...in words", asked.body && asked.body.error, "Hollis Renner has load 7001 on Oct 20 – Oct 22 inside these dates. Save anyway? The load stays assigned to him.");
		eq("§8.6 ...the body holds only error, code, driver, from, to and loads; each load only loadId, from, to and truck",
			asked.body && Array.isArray(asked.body.loads) ? [Object.keys(asked.body).sort(), asked.body.loads.map((l) => Object.keys(l).sort())] : null,
			[["code", "driver", "error", "from", "loads", "to"], [["from", "loadId", "to", "truck"]]]);
		ok("§8.7 ...and no broker or customer data", !/Brokerly|555-0142|broker\.example|Shipper Way|Receiver Rd/.test(asked.text), asked.text);
		eq("§8.8 ...nothing written, nothing audited", [count(w) - before, auditCount(w) - auditsBefore], [0, 0]);

		for (const [label, confirmLoads] of [
			["true", true],
			["an object, not a list", { loadId: "7001", from: "2026-10-20", to: "2026-10-22" }],
			["an entry without its last day", [{ loadId: "7001", from: "2026-10-20" }]],
			["a day not written YYYY-MM-DD", [{ loadId: "7001", from: "10/20/2026", to: "2026-10-22" }]],
			["a load id of 65 characters", [{ loadId: "7".repeat(65), from: "2026-10-20", to: "2026-10-22" }]],
			["a load id that is a number", [{ loadId: 7001, from: "2026-10-20", to: "2026-10-22" }]],
			["51 entries, the right one among them", [...Array.from({ length: 50 }, (_, i) => ({ loadId: `X${i}`, from: "2026-10-20", to: "2026-10-20" })), { loadId: "7001", from: "2026-10-20", to: "2026-10-22" }]],
		]) eq(`§8.9 confirmLoads ${label}: no confirmation, 409 again`, code(await create(w, DIR.hollis, { ...vacation("2026-10-20", "2026-10-21"), confirmLoads })), ASKED);
		eq("§8.10 ...still nothing written", count(w) - before, 0);

		const saved = await create(w, DIR.hollis, { ...vacation("2026-10-20", "2026-10-21"), confirmLoads: echoOf(asked) });
		eq("§8.11 \"Save anyway\", the listed loads echoed: 201, no loadsUnchecked", [saved.status, !!saved.body && "loadsUnchecked" in saved.body], [201, false]);
		eq("§8.12 ...one confirmation, for the load's window, tied to the new row", confirmsOf(w),
			[{ availability_id: rowId(saved), directory_id: DIR.hollis, load_id: "7001", load_from: "2026-10-20", load_to: "2026-10-22", via: "availability_create", confirmed_by: "super_admin" }]);
		const confirmedAudit = w.audits("driver_availability_loads_confirmed");
		eq("§8.13 ...one driver_availability_loads_confirmed audit row, entity load, id the load", confirmedAudit.map((a) => [a.entity, a.entity_id]), [["load", "7001"]]);
		ok("§8.14 ...naming the driver, his dates, the load's window and the route, never the reason",
			!!confirmedAudit[0] && /Hollis Renner/.test(confirmedAudit[0].details) && /2026-10-20\.\.2026-10-21/.test(confirmedAudit[0].details)
				&& /2026-10-20\.\.2026-10-22/.test(confirmedAudit[0].details) && /availability_create/.test(confirmedAudit[0].details) && !/Family/.test(confirmedAudit[0].details),
			confirmedAudit[0] && confirmedAudit[0].details);
		eq("§8.15 ...the create audit line as before", lastAudit(w, "driver_availability_create"), "Hollis Renner: off 2026-10-20..2026-10-21 (vacation)");

		const variant = await create(w, DIR.hollis, vacation("2026-11-03", "2026-11-04"));
		eq("§8.16 his name in other spacing and case on load 7505 (Nov 3-4): still warns", [code(variant), listed(variant)], [ASKED, [["7505", "2026-11-03", "2026-11-04"]]]);

		const first = await create(w, DIR.hollis, vacation("2026-10-26", "2026-10-27"));
		eq("§8.17 Oct 26-27 over 7501: 409 listing it", listed(first), [["7501", "2026-10-26", "2026-10-27"]]);
		w.sheet.tabs["Job Tracking"].push(W.jtRow({ id: "7507", driver: "Hollis Renner", pickup: "10/27/2026 06:00", dropoff: "10/27/2026 20:00", status: "Dispatched", truck: "LogisX-#91", owner: "5" }));
		const again = await create(w, DIR.hollis, { ...vacation("2026-10-26", "2026-10-27"), confirmLoads: echoOf(first) });
		eq("§8.18 a load added since (7507, Oct 27), the echo naming only 7501: 409 again listing both", [code(again), listed(again)],
			[ASKED, [["7501", "2026-10-26", "2026-10-27"], ["7507", "2026-10-27", "2026-10-27"]]]);
		jtRowOf(w, "7501")[W.COL["Drop-off Appointment"]] = "10/28/2026 12:00";
		const moved = await create(w, DIR.hollis, { ...vacation("2026-10-26", "2026-10-27"), confirmLoads: echoOf(again) });
		eq("§8.19 7501's drop-off moved to Oct 28 since: 409 again with its new window", [code(moved), listed(moved)],
			[ASKED, [["7501", "2026-10-26", "2026-10-28"], ["7507", "2026-10-27", "2026-10-27"]]]);
		eq("§8.20 ...the words name both", moved.body && moved.body.error,
			"Hollis Renner has 2 loads inside these dates: 7501 (Oct 26 – Oct 28), 7507 (Oct 27). Save anyway? The loads stay assigned to him.");
		eq("§8.21 ...none of the refused saves wrote a row (the one row since is the Oct 20-21 save)", count(w) - before, 1);
		const done = await create(w, DIR.hollis, { ...vacation("2026-10-26", "2026-10-27"), confirmLoads: [...echoOf(moved), { loadId: "9999", from: "2026-10-26", to: "2026-10-26" }] });
		eq("§8.22 echoed in full, plus a load no longer listed (9999): 201, confirmations for the two listed only",
			[done.status, confirmsOf(w).filter((c) => c.availability_id === rowId(done)).map((c) => [c.load_id, c.load_from, c.load_to])],
			[201, [["7501", "2026-10-26", "2026-10-28"], ["7507", "2026-10-27", "2026-10-27"]]]);

		eq("§8.23 over his Oct 20-21 row and load 7001 at once: 409 AVAILABILITY_OVERLAP first", code(await create(w, DIR.hollis, vacation("2026-10-21", "2026-10-22"))), [409, "AVAILABILITY_OVERLAP"]);

		const sAsk = await create(w, DIR.soren, vacation("2026-10-16", "2026-10-16"), USERS.disp);
		eq("§8.24 a Dispatcher records Soren off Oct 16, over his load 7002 (Oct 16-17): 409", [code(sAsk), listed(sAsk)], [ASKED, [["7002", "2026-10-16", "2026-10-17"]]]);
		const sDone = await create(w, DIR.soren, { ...vacation("2026-10-16", "2026-10-16"), confirmLoads: echoOf(sAsk) }, USERS.disp);
		eq("§8.25 ...his \"Save anyway\": 201, confirmed by him", [sDone.status, confirmsOf(w).filter((c) => c.availability_id === rowId(sDone)).map((c) => [c.load_id, c.confirmed_by])],
			[201, [["7002", "dispatch_t"]]]);
	});
	await R.guard("§8b", async () => {
		const w = await startR11b();
		w.jt.fail = true;
		const logsBefore = w.logs.length;
		const r = await create(w, DIR.hollis, vacation("2026-10-20", "2026-10-21"));
		eq("§8.26 Job Tracking unreadable, Oct 20-21 over load 7001: 201 with loadsUnchecked, nothing confirmed",
			[r.status, r.body && r.body.loadsUnchecked, confirmsOf(w).length], [201, true, 0]);
		eq("§8.27 ...the create audit says the loads were not checked", lastAudit(w, "driver_availability_create"),
			"Hollis Renner: off 2026-10-20..2026-10-21 (vacation); loads not checked (Job Tracking unreadable)");
		ok("§8.28 ...and the failed read is logged", w.logs.slice(logsBefore).some((l) => /Job Tracking unreadable/.test(l)), w.logs.slice(logsBefore).join(" | "));
		const e = await create(w, DIR.hollis, { ...vacation("2026-10-26", "2026-10-27"), confirmLoads: [
			{ loadId: "7501", from: "2026-10-26", to: "2026-10-27" },
			{ loadId: "7001", from: "2026-10-20", to: "2026-10-22" },
		] });
		eq("§8.29 unreadable, with an echo: 201 loadsUnchecked; the echoed load inside the dates recorded as given, \"_unchecked\"; the one outside them not",
			[e.status, e.body && e.body.loadsUnchecked, confirmsOf(w).map((c) => [c.load_id, c.load_from, c.load_to, c.via])],
			[201, true, [["7501", "2026-10-26", "2026-10-27", "availability_create_unchecked"]]]);
		eq("§8.30 ...with its audit row", w.audits("driver_availability_loads_confirmed").map((a) => a.entity_id), ["7501"]);
		w.jt.fail = false;
		w.jt.during = () => w.db.prepare("DELETE FROM drivers_directory WHERE id = ?").run(DIR.soren);
		const gone = await create(w, DIR.soren, vacation("2026-11-01", "2026-11-02"));
		eq("§8.31 the directory row deleted while the sheet was read: 404 DRIVER_NOT_FOUND, nothing written",
			[code(gone), w.db.prepare("SELECT COUNT(*) AS n FROM driver_availability WHERE directory_id = ?").get(DIR.soren).n], [[404, "DRIVER_NOT_FOUND"], 0]);
	});

	section("§9 R11b: moving or extending time off onto loads he already has");
	await R.guard("§9", async () => {
		const w = await startR11b();
		const a = rowId(await create(w, DIR.hollis, vacation("2026-10-16", "2026-10-18")));
		ok("§9.0 a row over none of his loads (Oct 16-18)", !!a);
		const snap = () => JSON.stringify(stored(w, a));
		const aBefore = snap();
		const onto = await edit(w, a, { from: "2026-10-20", to: "2026-10-21" });
		eq("§9.1 moved onto load 7001 (to Oct 20-21): 409 DRIVER_HAS_LOADS listing it", [code(onto), listed(onto)], [ASKED, [["7001", "2026-10-20", "2026-10-22"]]]);
		const ext = await edit(w, a, { to: "2026-10-20" });
		eq("§9.2 extended over it (to Oct 20): 409 listing it", [code(ext), listed(ext)], [ASKED, [["7001", "2026-10-20", "2026-10-22"]]]);
		eq("§9.3 ...the row unchanged, no update audited", [snap() === aBefore, w.audits("driver_availability_update").length], [true, 0]);

		const askB = await create(w, DIR.hollis, vacation("2026-10-26", "2026-10-31"));
		const b = rowId(await create(w, DIR.hollis, { ...vacation("2026-10-26", "2026-10-31"), confirmLoads: echoOf(askB) }));
		ok("§9.4 a row over load 7501, saved anyway (Oct 26-31)", !!b);
		for (const [label, body] of [
			["the kind only", { kind: "off_duty" }],
			["the reason only", { reason: "Personal" }],
			["an end-early (to Oct 30)", { to: "2026-10-30" }],
			["a shrink inside the old dates (Oct 27-29)", { from: "2026-10-27", to: "2026-10-29" }],
		]) {
			const reads = w.jt.reads;
			const r = await edit(w, b, body);
			eq(`§9.5 ${label}: 200, Job Tracking not read`, [r.status, w.jt.reads - reads], [200, 0]);
		}
		const reads = w.jt.reads;
		const longer = await edit(w, b, { to: "2026-11-02" });
		eq("§9.6 Oct 27-29 extended to Nov 2: Job Tracking read; 7501 already inside the old dates and no other load: 200",
			[longer.status, w.jt.reads > reads], [200, true]);
		const over = await edit(w, b, { to: "2026-11-04" });
		eq("§9.7 extended to Nov 4: 409 listing only the newly covered load 7505", [code(over), listed(over)], [ASKED, [["7505", "2026-11-03", "2026-11-04"]]]);
		const confirmed = await edit(w, b, { to: "2026-11-04", confirmLoads: echoOf(over) });
		eq("§9.8 echoed: 200, one more confirmation, for 7505 only",
			[confirmed.status, (stored(w, b) || {}).to_date, confirmsOf(w).filter((c) => c.availability_id === b).map((c) => [c.load_id, c.via])],
			[200, "2026-11-04", [["7501", "availability_create"], ["7505", "availability_update"]]]);
		eq("§9.9 ...with its audit row", w.audits("driver_availability_loads_confirmed").map((x) => x.entity_id), ["7501", "7505"]);

		const c = rowId(await create(w, DIR.tamsin, vacation("2026-10-16", "2026-10-17")));
		w.jt.during = () => w.db.prepare("UPDATE driver_availability SET cancelled_at = '2026-10-15T16:00:00.000Z', cancelled_by = 'super_admin' WHERE id = ?").run(c);
		const cancelledMeanwhile = await edit(w, c, { to: "2026-10-20" });
		eq("§9.10 cancelled while the sheet was read: 409 AVAILABILITY_CANCELLED, the row as cancelled",
			[code(cancelledMeanwhile), stored(w, c).to_date, !!stored(w, c).cancelled_at], [[409, "AVAILABILITY_CANCELLED"], "2026-10-17", true]);

		w.jt.during = () => w.db.prepare("UPDATE driver_availability SET from_date = '2026-10-19', to_date = '2026-10-22' WHERE id = ?").run(a);
		const movedMeanwhile = await edit(w, a, { to: "2026-10-21" });
		eq("§9.11 a Super Admin moved it to Oct 19-22 (over 7001) while the sheet was read, then this edit to Oct 21: the re-read days are the old range, so 7001 is not newly covered: 200, Oct 19-21",
			[movedMeanwhile.status, stored(w, a).from_date, stored(w, a).to_date], [200, "2026-10-19", "2026-10-21"]);
		ok("§9.12 ...its audit line starts from the re-read days", /: off 2026-10-19\.\.2026-10-22 \(vacation\) -> off 2026-10-19\.\.2026-10-21 \(vacation\)$/.test(lastAudit(w, "driver_availability_update")), lastAudit(w, "driver_availability_update"));

		const d = rowId(await create(w, DIR.tamsin, vacation("2026-11-10", "2026-11-11")));
		w.jt.during = () => w.db.prepare("DELETE FROM drivers_directory WHERE id = ?").run(DIR.tamsin);
		const goneMeanwhile = await edit(w, d, { to: "2026-11-14" });
		eq("§9.13 its driver's directory row deleted while the sheet was read: 404 AVAILABILITY_NOT_FOUND, the row unchanged",
			[code(goneMeanwhile), stored(w, d).to_date], [[404, "AVAILABILITY_NOT_FOUND"], "2026-11-11"]);
	});

	section("§10 R11b: after \"Save anyway\" his dark truck alerts while that load covers today");
	const todayLoadRows = () => [...W.defaultRows(), W.jtRow({ id: "7600", driver: "Hollis Renner", pickup: "10/15/2026 08:00", dropoff: "10/16/2026 17:00", status: "Dispatched", truck: "LogisX-#91", owner: "5" })];
	await R.guard("§10", async () => {
		const w = await startR11b({ rows: todayLoadRows() });
		const ask = await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20"));
		eq("§10.1 Oct 14-20 over his loads 7600 (Oct 15-16) and 7001 (Oct 20-22): 409 listing both",
			[code(ask), listed(ask)], [ASKED, [["7600", "2026-10-15", "2026-10-16"], ["7001", "2026-10-20", "2026-10-22"]]]);
		eq("§10.2 saved anyway: 201", (await create(w, DIR.hollis, { ...vacation("2026-10-14", "2026-10-20"), confirmLoads: echoOf(ask) })).status, 201);
		await w.sweep();
		const s = t91(w);
		eq("§10.3 the sweep alerts on his dark truck (#91) as normal while 7600 covers today", [s.state, !!(s.row && !s.row.resolved_at && s.row.alerted_at)], ["stale", true]);
		w.clock.ms = Date.parse("2026-10-18T16:00:00Z");
		await w.sweep();
		const s2 = t91(w);
		eq("§10.4 Oct 18, between his loads and still off: driver_off again, the alert resolved", [s2.state, !!(s2.row && s2.row.resolved_at)], ["driver_off", true]);
	});
	await R.guard("§10b", async () => {
		const w = await startR11b({ rows: todayLoadRows() });
		w.jt.fail = true;
		const r = await create(w, DIR.hollis, { ...vacation("2026-10-14", "2026-10-20"), confirmLoads: [{ loadId: "7600", from: "2026-10-15", to: "2026-10-16" }] });
		eq("§10.5 Job Tracking unreadable, 7600 echoed: 201 unchecked, its confirmation \"_unchecked\"",
			[r.status, r.body && r.body.loadsUnchecked, confirmsOf(w).map((c) => [c.load_id, c.via])], [201, true, [["7600", "availability_create_unchecked"]]]);
		w.jt.fail = false;
		await w.sweep();
		eq("§10.6 the load still his: #91 alerts", t91(w).state, "stale");
		eq("§10.7 7600 reassigned to Soren: 200", (await w.call("PUT", "/api/load/7600", { user: USERS.disp, body: { Driver: "Soren King" } })).status, 200);
		await w.sweep();
		const s = t91(w);
		eq("§10.8 ...the unchecked confirmation no longer counts: #91 back to driver_off, the alert resolved", [s.state, !!(s.row && s.row.resolved_at)], ["driver_off", true]);
	});

	// Today 2026-10-15: a Dispatcher's floor is Sep 15 (30 days back), yesterday Oct 14.
	const NO_LIMITS = { fromMin: null, toMin: null, toMax: null, maxDays: 60 };
	const scopeOf = (r, id) => {
		const x = r.body && Array.isArray(r.body.rows) ? r.body.rows.find((y) => y.id === id) : null;
		return x ? [x.editable, x.limits === undefined ? "missing" : x.limits] : null;
	};
	section("§11 what the staff GET says the caller may change");
	await R.guard("§11", async () => {
		const w = await W.startWorld();
		const recent = rowId(await create(w, DIR.hollis, vacation("2026-10-05", "2026-10-25")));
		const recentEnded = rowId(await create(w, DIR.hollis, vacation("2026-09-20", "2026-10-02")));
		const oldLive = rowId(await create(w, DIR.tamsin, vacation("2026-09-10", "2026-10-25")));
		const oldEnded = rowId(await create(w, DIR.soren, vacation("2026-09-01", "2026-09-12")));
		const gone = rowId(await create(w, DIR.soren, vacation("2026-11-01", "2026-11-02")));
		await cancel(w, gone);
		ok("§11.0 five rows: a recent current one, a recent ended one, an old live one, an old ended one, a cancelled one",
			[recent, recentEnded, oldLive, oldEnded, gone].every(Boolean));
		const sa = { h: await list(w, DIR.hollis), t: await list(w, DIR.tamsin), s: await list(w, DIR.soren) };
		eq("§11.1 Super Admin: every live row \"full\", no date limits, the 60-day cap",
			[scopeOf(sa.h, recent), scopeOf(sa.h, recentEnded), scopeOf(sa.t, oldLive), scopeOf(sa.s, oldEnded)], Array(4).fill(["full", NO_LIMITS]));
		eq("§11.2 ...a cancelled row: \"none\", limits null", scopeOf(sa.s, gone), ["none", null]);
		eq("§11.3 ...createLimits: no first-day limit, the 60-day cap, the Dispatcher window named", sa.h.body && sa.h.body.createLimits, { fromMin: null, toMin: null, maxDays: 60, dispatcherBackDays: 30 });
		const d = { h: await list(w, DIR.hollis, USERS.disp), t: await list(w, DIR.tamsin, USERS.disp), s: await list(w, DIR.soren, USERS.disp) };
		eq("§11.4 Dispatcher, a recent current row (Oct 5-25): \"full\", from no earlier than Sep 15, an earlier end no earlier than yesterday",
			scopeOf(d.h, recent), ["full", { fromMin: "2026-09-15", toMin: "2026-10-14", toMax: null, maxDays: 60 }]);
		eq("§11.5 ...a recent ended row (Sep 20 - Oct 2): \"full\", its end may stay or move later",
			scopeOf(d.h, recentEnded), ["full", { fromMin: "2026-09-15", toMin: "2026-10-02", toMax: null, maxDays: 60 }]);
		eq("§11.6 ...an old live row (Sep 10 - Oct 25): \"end_early\", the end from yesterday to the day before its end",
			scopeOf(d.t, oldLive), ["end_early", { fromMin: null, toMin: "2026-10-14", toMax: "2026-10-24", maxDays: 60 }]);
		eq("§11.7 ...an old ended row (Sep 1-12): \"none\"", scopeOf(d.s, oldEnded), ["none", null]);
		eq("§11.8 ...a cancelled row: \"none\"", scopeOf(d.s, gone), ["none", null]);
		eq("§11.9 ...createLimits: from no earlier than Sep 15", d.h.body && d.h.body.createLimits, { fromMin: "2026-09-15", toMin: null, maxDays: 60, dispatcherBackDays: 30 });

		const made = await create(w, DIR.soren, vacation("2026-10-28", "2026-10-29"), USERS.disp);
		eq("§11.10 a Dispatcher's POST answer carries his editable and limits", made.body && made.body.row && [made.body.row.editable, made.body.row.limits],
			["full", { fromMin: "2026-09-15", toMin: "2026-10-14", toMax: null, maxDays: 60 }]);
		const ended = await edit(w, oldLive, { to: "2026-10-20" }, USERS.disp);
		eq("§11.11 ...his PUT answer too (the old row ended early at Oct 20 stays \"end_early\")", ended.body && ended.body.row && [ended.status, ended.body.row.editable, ended.body.row.limits],
			[200, "end_early", { fromMin: null, toMin: "2026-10-14", toMax: "2026-10-19", maxDays: 60 }]);
		const c = await cancel(w, rowId(made), USERS.disp);
		eq("§11.12 ...and his cancel answer: \"none\"", c.body && c.body.row && [c.body.row.editable, c.body.row.limits], ["none", null]);
		const saEdit = await edit(w, oldEnded, { reason: "Personal" });
		eq("§11.13 a Super Admin's PUT answer: \"full\", no date limits, the 60-day cap", saEdit.body && saEdit.body.row && [saEdit.body.row.editable, saEdit.body.row.limits], ["full", NO_LIMITS]);
	});
	await R.guard("§11b", async () => {
		// Each limit a Dispatcher is served is a day the server accepts; one day past it is refused.
		const w = await W.startWorld();
		const recent = rowId(await create(w, DIR.hollis, vacation("2026-10-05", "2026-10-25")));
		const oldLive = rowId(await create(w, DIR.tamsin, vacation("2026-09-10", "2026-10-25")));
		eq("§11.14 recent row, from one day before fromMin (Sep 14): 400; at fromMin (Sep 15): 200",
			[code(await edit(w, recent, { from: "2026-09-14" }, USERS.disp)), (await edit(w, recent, { from: "2026-09-15" }, USERS.disp)).status], [[400, "BACKDATE_LIMIT"], 200]);
		eq("§11.15 ...its end one day before toMin (Oct 13): 400; at toMin (Oct 14): 200",
			[code(await edit(w, recent, { to: "2026-10-13" }, USERS.disp)), (await edit(w, recent, { to: "2026-10-14" }, USERS.disp)).status], [[400, "BACKDATE_LIMIT"], 200]);
		eq("§11.16 old row, its end one day before toMin (Oct 13): 400; one day past toMax (its own end, Oct 25): 400; at toMax (Oct 24): 200",
			[code(await edit(w, oldLive, { to: "2026-10-13" }, USERS.disp)), code(await edit(w, oldLive, { to: "2026-10-25" }, USERS.disp)), (await edit(w, oldLive, { to: "2026-10-24" }, USERS.disp)).status],
			[[400, "BACKDATE_LIMIT"], [400, "BACKDATE_LIMIT"], 200]);
		const after = await list(w, DIR.tamsin, USERS.disp);
		eq("§11.17 ...served again: \"end_early\", toMax the day before its new end (Oct 23)", scopeOf(after, oldLive), ["end_early", { fromMin: null, toMin: "2026-10-14", toMax: "2026-10-23", maxDays: 60 }]);
		// The recent row is now Sep 15 - Oct 14. maxDays as served is the cap the server enforces.
		const served = scopeOf(await list(w, DIR.hollis, USERS.disp), recent);
		eq("§11.18 the recent row's served maxDays is 60; one day longer (Sep 15 - Nov 14, 61 days): 400 RANGE_TOO_LONG; at it (Sep 15 - Nov 13): 200",
			[served && served[1] && served[1].maxDays, code(await edit(w, recent, { to: "2026-11-14" }, USERS.disp)), (await edit(w, recent, { to: "2026-11-13" }, USERS.disp)).status],
			[60, [400, "RANGE_TOO_LONG"], 200]);
	});

	section("§12 the edit audit names a reason change, never the reason");
	await R.guard("§12", async () => {
		const w = await W.startWorld();
		const SECRET = ["Family wedding", "Jury duty", "Knee surgery", "Moving house", "Court date", "Dentist visit"];
		const TOO_LONG = "Hospital stay ".repeat(15).slice(0, 201);
		const a = rowId(await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20", { reason: SECRET[0] })));
		const b = rowId(await create(w, DIR.soren, vacation("2026-10-16", "2026-10-18", { reason: SECRET[1] }), USERS.disp));
		const old = rowId(await create(w, DIR.tamsin, vacation("2026-09-10", "2026-10-25", { reason: SECRET[2] })));
		ok("§12.0 three rows, each with a reason", !!a && !!b && !!old);
		const updates = () => w.audits("driver_availability_update");
		const last = () => { const u = updates(); return u.length ? u[u.length - 1].details : ""; };
		let n = updates().length;
		eq("§12.1 a reason-only edit: 200", (await edit(w, a, { reason: SECRET[3] })).status, 200);
		eq("§12.2 ...audited once", updates().length - n, 1);
		ok("§12.3 ...the line says the reason changed (dates and kind as before)",
			/off 2026-10-14\.\.2026-10-20 \(vacation\) -> off 2026-10-14\.\.2026-10-20 \(vacation\); reason changed$/.test(last()), last());
		eq("§12.4 a Dispatcher's kind and reason edit: 200", (await edit(w, b, { kind: "other", reason: SECRET[4] }, USERS.disp)).status, 200);
		ok("§12.5 ...the line shows the kind and says the reason changed", /\(vacation\) -> off 2026-10-16\.\.2026-10-18 \(other\); reason changed$/.test(last()), last());
		eq("§12.6 a dates-only edit: 200", (await edit(w, a, { to: "2026-10-19" })).status, 200);
		ok("§12.7 ...its line says nothing about the reason", /-> off 2026-10-14\.\.2026-10-19 \(vacation\)$/.test(last()), last());
		n = updates().length;
		const again = await edit(w, a, { reason: `  ${SECRET[3]}  ` });
		eq("§12.8 the same reason again (edge spaces aside): 200 unchanged, nothing audited", [again.status, again.body && again.body.unchanged, updates().length - n], [200, true, 0]);
		eq("§12.9 refusals: an old row's reason (Dispatcher), a 201-character reason on create and on edit, an overlap carrying a reason",
			[code(await edit(w, old, { reason: SECRET[5] }, USERS.disp)), code(await create(w, DIR.hollis, vacation("2026-12-01", "2026-12-02", { reason: TOO_LONG }))),
				code(await edit(w, a, { reason: TOO_LONG })), code(await create(w, DIR.hollis, vacation("2026-10-18", "2026-10-22", { reason: SECRET[5] })))],
			[[400, "BACKDATE_LIMIT"], [400, "REASON_TOO_LONG"], [400, "REASON_TOO_LONG"], [409, "AVAILABILITY_OVERLAP"]]);
		eq("§12.10 ...a Dispatcher's cancel of the old row is refused too", code(await cancel(w, old, USERS.disp)), [400, "BACKDATE_LIMIT"]);
		eq("§12.11 ...and the Super Admin cancels it", (await cancel(w, old)).status, 200);
		const all = w.db.prepare("SELECT * FROM audit_trail ORDER BY id").all();
		const actions = new Set(all.map((x) => x.action));
		ok("§12.12 the audit holds creates, updates, a cancel and refusals of each kind",
			["driver_availability_create", "driver_availability_update", "driver_availability_cancel", "driver_availability_create_blocked",
				"driver_availability_update_blocked", "driver_availability_cancel_blocked"].every((x) => actions.has(x)), [...actions].join());
		const hits = all.filter((x) => { const t = JSON.stringify(x); return SECRET.some((s) => t.includes(s)) || t.includes("Hospital stay"); })
			.map((x) => `${x.action}: ${x.details}`);
		eq(`§12.13 none of the ${all.length} audit rows, of any action, holds a reason text the runner used`, hits, []);
	});

	section("§13 a Dispatcher's full edit, held to the same server rules");
	await R.guard("§13", async () => {
		const w = await W.startWorld();
		const recent = rowId(await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20")));
		const old = rowId(await create(w, DIR.tamsin, vacation("2026-09-10", "2026-10-25")));
		const oldBefore = JSON.stringify(stored(w, old));
		eq("§13.1 he changes only the kind of a recent row: 200", (await edit(w, recent, { kind: "off_duty" }, USERS.disp)).status, 200);
		eq("§13.2 he changes the kind of an old row: 400 BACKDATE_LIMIT", code(await edit(w, old, { kind: "off_duty" }, USERS.disp)), [400, "BACKDATE_LIMIT"]);
		eq("§13.3 on an old row, he changes the kind and ends it at yesterday: 400 BACKDATE_LIMIT",
			code(await edit(w, old, { kind: "off_duty", to: "2026-10-14" }, USERS.disp)), [400, "BACKDATE_LIMIT"]);
		eq("§13.4 he moves from later on a current row (Oct 14 -> Oct 16): 200", (await edit(w, recent, { from: "2026-10-16" }, USERS.disp)).status, 200);
		eq("§13.5 he extends to on a recent row (Oct 20 -> Oct 30): 200", (await edit(w, recent, { to: "2026-10-30" }, USERS.disp)).status, 200);
		eq("§13.6 an edit whose merged range is 61 days (Oct 16 - Dec 15): 400 RANGE_TOO_LONG",
			code(await edit(w, recent, { to: "2026-12-15" }, USERS.disp)), [400, "RANGE_TOO_LONG"]);
		eq("§13.7 he sends an unchanged body for an old row: 400 BACKDATE_LIMIT",
			code(await edit(w, old, { kind: "vacation", from: "2026-09-10", to: "2026-10-25", reason: "Family" }, USERS.disp)), [400, "BACKDATE_LIMIT"]);
		eq("§13.8 ...the old row is as the Super Admin left it", JSON.stringify(stored(w, old)), oldBefore);
		eq("§13.9 ...and the recent row holds his edits (off_duty, Oct 16-30)", [stored(w, recent).kind, stored(w, recent).from_date, stored(w, recent).to_date], ["off_duty", "2026-10-16", "2026-10-30"]);
	});

	section("§14 the driver app's payload and DRIVER_TIME_OFF_SCREEN_ENABLED");
	await R.guard("§14", async () => {
		const page = (w, name, user) => w.call("GET", `/api/driver/${encodeURIComponent(name)}`, { user });
		const seedRows = async (w) => {
			await create(w, DIR.hollis, vacation("2026-10-14", "2026-10-20", { reason: "Family wedding" }));
			await create(w, DIR.hollis, { kind: "off_duty", from: "2026-11-01", to: "2026-11-03", reason: "Court date" });
			await create(w, DIR.hollis, vacation("2026-10-01", "2026-10-03"));
			await cancel(w, rowId(await create(w, DIR.hollis, vacation("2026-10-25", "2026-10-27"))));
			await create(w, DIR.soren, { kind: "other", from: "2026-10-16", to: "2026-10-18", reason: "Moving house" });
		};
		const shape = (r) => (r.body && r.body.timeOff && Array.isArray(r.body.timeOff.rows) ? r.body.timeOff.rows.map((t) => [t.from, t.to, t.kind, t.status]) : null);
		const off = await W.startWorld();
		eq("§14.0 the world serves the payload route", off.found.includes("driverPage"), true);
		await seedRows(off);
		const r0 = await page(off, "Hollis Renner", USERS.driver);
		eq("§14.1 main flag on, sub-flag unset: 200 with his loads, no timeOff key",
			[r0.status, Array.isArray(r0.body && r0.body.loads) && r0.body.loads.length > 0, !!r0.body && "timeOff" in r0.body], [200, true, false]);
		const on = await W.startWorld({ env: { DRIVER_TIME_OFF_SCREEN_ENABLED: "true" } });
		await seedRows(on);
		const r1 = await page(on, "Hollis Renner", USERS.driver);
		eq("§14.2 both on: 200 with his loads, and timeOff for today with his current and upcoming rows",
			[r1.status, Array.isArray(r1.body && r1.body.loads) && r1.body.loads.length > 0, r1.body && r1.body.timeOff && r1.body.timeOff.today, shape(r1)],
			[200, true, "2026-10-15", [["2026-10-14", "2026-10-20", "vacation", "current"], ["2026-11-01", "2026-11-03", "off_duty", "upcoming"]]]);
		ok("§14.3 ...each row exactly { id, kind, from, to, status }, and no reason text anywhere in the answer",
			!!(r1.body && r1.body.timeOff) && r1.body.timeOff.rows.every((t) => Object.keys(t).sort().join() === "from,id,kind,status,to")
			&& !/Family wedding|Court date|Moving house/.test(r1.text), JSON.stringify(r1.body && r1.body.timeOff));
		const mine = await on.call("GET", "/api/driver/me/availability", { user: USERS.driver });
		eq("§14.4 ...the same as GET /api/driver/me/availability for him", r1.body && r1.body.timeOff, mine.body);
		eq("§14.5 Soren gets only his own", shape(await page(on, "Soren King", USERS.otherDriver)), [["2026-10-16", "2026-10-18", "other", "upcoming"]]);
		const foreign = await page(on, "Soren King", USERS.driver);
		eq("§14.6 a Driver asking for another driver's page: 403, no timeOff", [foreign.status, !!foreign.body && "timeOff" in foreign.body], [403, false]);
		eq("§14.7 Dispatcher and Investor: 403; signed out: 401",
			[(await page(on, "Hollis Renner", USERS.disp)).status, (await page(on, "Hollis Renner", USERS.inv)).status, (await page(on, "Hollis Renner", null)).status], [403, 403, 401]);
		eq("§14.8 a Super Admin on a driver's page: that driver's rows", shape(await page(on, "Soren King", USERS.sa)), [["2026-10-16", "2026-10-18", "other", "upcoming"]]);
	});

	await R.finish();
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
