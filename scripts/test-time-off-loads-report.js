#!/usr/bin/env node
/**
 * R11b follow-up, the user's read-only list (no backfill): scripts/time-off-loads-report.js
 * (--db --values-json --since --json). Every time-off row recorded since --since
 * (default 2026-10-16T07:00:00Z, 03:00 ET, when R11 went on), or re-dated since, with
 * the driver's loads its days cover, each load checked the way R11b's warning
 * (lib/driver-availability.js loadsNewlyInTimeOff()) would have checked it at the
 * save that brought it into the time off: "today" is that save's business day
 * (America/New_York), and the driver "already had" the load when its Assigned Date
 * is on or before that day.
 *
 * The rows are recorded, re-dated, ended early and cancelled through the shipped
 * routes (scripts/lib/availability-world.js) on a clock the test moves, so their
 * stamps and audit lines are the ones server.js writes. Made-up data only; EDT is
 * UTC-4 throughout. The seeded directory: Hollis Renner, Soren King, Tamsin Vale.
 *
 *   row  driver  days         recorded (UTC)             then
 *   A    Tamsin  11/10-11/11  10-15 16:00 (before since)  10-17 kind changed only: not listed
 *   B    Soren   10/24-10/25  10-15 18:00 (before since)  10-18 15:00 re-dated to 10/24-10/27: listed
 *   G    Soren   11/8-11/9    10-16 06:59:59.999          not listed (1 ms before since)
 *   F    Soren   11/5-11/6    10-16 07:00:00.000          listed (exactly since), no loads
 *   H    Soren   11/12-11/13  10-17 12:00, changed 10-18 12:00, written with no audit line:
 *                             listed from its own stamps, checked as of its last change, flagged
 *   C    Hollis  10/20-10/26  10-17 14:00 (10:00 EDT)
 *   E    Hollis  11/2-11/3    10-19 15:00                 cancelled 10-19 16:00: listed, cancelled
 *   D    Tamsin  10/14-10/25  10-20 02:30 (10/19 22:30 EDT)  10-20 14:00 ended early to 10/19
 *
 *   load  driver           days         Assigned       expected
 *   8101  Hollis           10/18-10/20  10/15          C: ends on its first day, already had, confirmed
 *   8102  Hollis           10/26-10/28  10/17          C: starts on its last day; Assigned on the save day: already had
 *   8103  Hollis           10/17-10/19  10/10          not listed (ends the day before C)
 *   8104  Hollis           10/27-10/28  10/10          not listed (starts the day after C)
 *   8105  Hollis           10/22-10/23  10/18          C: not yet assigned at the save
 *   8106  Hollis           10/24        (blank)        C: assigned date unknown
 *   8107  Hollis           10/23        "soon"         C: assigned date unknown
 *   8108  Hollis           TBD / blank  10/10          skipped, no readable day (counted under C and E)
 *   8109  "  hollis   RENNER "  10/21-10/22  RFC 2822 10/16   C: his name in other spacing and case
 *   8110  Hollis           10/21        Cancelled      not listed
 *   8111  Hollis           10/22        soft-deleted   not listed
 *   8112  Hollis           11/2-11/3    10/15          E (cancelled row)
 *   8201  Soren            10/24-10/25  10/10          B: covered when recorded, as of 10/15
 *   8202  Soren            10/26-10/27  10/17          B: brought in by the re-dating, as of 10/18
 *   8203  Soren            10/27        10/19          B: not yet assigned at the re-dating
 *   8204  Soren            11/12-11/13  10/18          H: as of its last change (10/18)
 *   8301  Soren            10/21-10/22  10/10          not listed (no row of his covers it)
 *   8401  Tamsin           10/18-10/19  10/12          D: as of 10/19, the Eastern day it was
 *                                                      recorded (UTC says 10/20; it ended early on 10/20)
 *   8402  Tamsin           10/13-10/15  10/10          not listed (ended before D was recorded)
 *   8403  Tamsin           10/22-10/23  10/10          not listed (the early end left it out)
 *
 * Read-only: the database file keeps its bytes and mtime and its folder gains no
 * file; a missing database is refused, never created; a WAL database another
 * connection holds open is read (rows still in its -wal included) and its main
 * file left as it was.
 * Run: node scripts/test-time-off-loads-report.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const A = require("./lib/availability-world");
const W = require("./lib/work-days-world");

const SCRIPT = "scripts/time-off-loads-report.js";
const SA = A.USERS.sa;

const tempDirs = [];
function tempDir() {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "r11b-time-off-report-"));
	tempDirs.push(d);
	return d;
}
process.on("exit", () => {
	for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function sheetRows() {
	const load = (o) => A.jtRow({ status: "Dispatched", truck: "LogisX-#91", owner: "5", ...o });
	const hollis = "Hollis Renner";
	const soren = "Soren King";
	const tamsin = "Tamsin Vale";
	return [
		A.HEADERS.slice(),
		load({ id: "8101", driver: hollis, pickup: "10/18/2026 08:00", dropoff: "10/20/2026 17:00", assigned: "10/15/2026 09:12:00" }),
		load({ id: "8102", driver: hollis, pickup: "10/26/2026 08:00", dropoff: "10/28/2026 17:00", assigned: "10/17/2026 16:40:00" }),
		load({ id: "8103", driver: hollis, pickup: "10/17/2026 08:00", dropoff: "10/19/2026 17:00", assigned: "10/10/2026 08:00:00" }),
		load({ id: "8104", driver: hollis, pickup: "10/27/2026 08:00", dropoff: "10/28/2026 17:00", assigned: "10/10/2026 08:00:00" }),
		load({ id: "8105", driver: hollis, pickup: "10/22/2026 08:00", dropoff: "10/23/2026 17:00", assigned: "10/18/2026 07:30:00" }),
		load({ id: "8106", driver: hollis, pickup: "10/24/2026 08:00", dropoff: "10/24/2026 17:00", assigned: "" }),
		load({ id: "8107", driver: hollis, pickup: "10/23/2026 08:00", dropoff: "", assigned: "soon" }),
		load({ id: "8108", driver: hollis, pickup: "TBD", dropoff: "", assigned: "10/10/2026 08:00:00" }),
		load({ id: "8109", driver: "  hollis   RENNER ", pickup: "10/21/2026 08:00", dropoff: "10/22/2026 17:00", assigned: "Date: Fri, 16 Oct 2026 09:05:00 -0400" }),
		load({ id: "8110", driver: hollis, pickup: "10/21/2026 08:00", dropoff: "10/21/2026 17:00", assigned: "10/10/2026 08:00:00", status: "Cancelled" }),
		load({ id: "8111", driver: hollis, pickup: "10/22/2026 08:00", dropoff: "10/22/2026 17:00", assigned: "10/10/2026 08:00:00" }),
		load({ id: "8112", driver: hollis, pickup: "11/2/2026 08:00", dropoff: "11/3/2026 17:00", assigned: "10/15/2026 10:00:00" }),
		load({ id: "8201", driver: soren, pickup: "10/24/2026 08:00", dropoff: "10/25/2026 17:00", assigned: "10/10/2026 08:00:00", truck: "LogisX-#33" }),
		load({ id: "8202", driver: soren, pickup: "10/26/2026 08:00", dropoff: "10/27/2026 17:00", assigned: "10/17/2026 11:00:00", truck: "LogisX-#33" }),
		load({ id: "8203", driver: soren, pickup: "10/27/2026 08:00", dropoff: "10/27/2026 17:00", assigned: "10/19/2026 11:00:00", truck: "LogisX-#33" }),
		load({ id: "8204", driver: soren, pickup: "11/12/2026 08:00", dropoff: "11/13/2026 17:00", assigned: "2026-10-18", truck: "LogisX-#33" }),
		load({ id: "8301", driver: soren, pickup: "10/21/2026 08:00", dropoff: "10/22/2026 17:00", assigned: "10/10/2026 08:00:00", truck: "LogisX-#33" }),
		load({ id: "8401", driver: tamsin, pickup: "10/18/2026 08:00", dropoff: "10/19/2026 17:00", assigned: "10/12/2026 08:00:00", truck: "" }),
		load({ id: "8402", driver: tamsin, pickup: "10/13/2026 08:00", dropoff: "10/15/2026 17:00", assigned: "10/10/2026 08:00:00", truck: "" }),
		load({ id: "8403", driver: tamsin, pickup: "10/22/2026 08:00", dropoff: "10/23/2026 17:00", assigned: "10/10/2026 08:00:00", truck: "" }),
	];
}

async function buildWorld() {
	const w = await A.startWorld({ routes: ["availabilityCreate", "availabilityEdit", "availabilityCancel"], rows: sheetRows(), now: Date.parse("2026-10-15T16:00:00Z") });
	const at = (iso) => { w.clock.ms = Date.parse(iso); };
	const expect = (what, r, status) => {
		if (r.status !== status) throw new Error(`${what}: ${r.status} ${String(r.text).slice(0, 200)}`);
		return r;
	};
	const create = async (iso, dir, body) => {
		at(iso);
		return expect(`create ${body.from}..${body.to}`, await w.call("POST", `/api/drivers-directory/${dir}/availability`, { user: SA, body }), 201).body.row.id;
	};
	const edit = async (iso, id, body) => {
		at(iso);
		expect(`edit row ${id}`, await w.call("PUT", `/api/driver-availability/${id}`, { user: SA, body }), 200);
	};
	const cancel = async (iso, id) => {
		at(iso);
		expect(`cancel row ${id}`, await w.call("POST", `/api/driver-availability/${id}/cancel`, { user: SA, body: {} }), 200);
	};
	const id = {};
	id.A = await create("2026-10-15T16:00:00.000Z", A.DIR.tamsin, { kind: "vacation", from: "2026-11-10", to: "2026-11-11" });
	id.B = await create("2026-10-15T18:00:00.000Z", A.DIR.soren, { kind: "off_duty", from: "2026-10-24", to: "2026-10-25" });
	id.G = await create("2026-10-16T06:59:59.999Z", A.DIR.soren, { kind: "vacation", from: "2026-11-08", to: "2026-11-09" });
	id.F = await create("2026-10-16T07:00:00.000Z", A.DIR.soren, { kind: "vacation", from: "2026-11-05", to: "2026-11-06" });
	id.C = await create("2026-10-17T14:00:00.000Z", A.DIR.hollis, { kind: "vacation", from: "2026-10-20", to: "2026-10-26" });
	await edit("2026-10-17T15:00:00.000Z", id.A, { kind: "other" });
	await edit("2026-10-18T15:00:00.000Z", id.B, { to: "2026-10-27" });
	id.E = await create("2026-10-19T15:00:00.000Z", A.DIR.hollis, { kind: "off_duty", from: "2026-11-02", to: "2026-11-03" });
	await cancel("2026-10-19T16:00:00.000Z", id.E);
	id.D = await create("2026-10-20T02:30:00.000Z", A.DIR.tamsin, { kind: "other", from: "2026-10-14", to: "2026-10-25" });
	await edit("2026-10-20T14:00:00.000Z", id.D, { to: "2026-10-19" });
	// A row the audit log does not account for (logAudit() is best effort).
	id.H = Number(w.db.prepare(`
		INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, reason, created_by, created_by_user_id, created_at, updated_at)
		VALUES (?, 'Soren King', 'vacation', '2026-11-12', '2026-11-13', '', 'super_admin', 1, '2026-10-17T12:00:00.000Z', '2026-10-18T12:00:00.000Z')
	`).run(A.DIR.soren).lastInsertRowid);
	w.db.prepare(`
		INSERT INTO driver_availability_confirmations (availability_id, directory_id, load_id, load_from, load_to, via, confirmed_by, confirmed_by_user_id, confirmed_at)
		VALUES (?, ?, '8101', '2026-10-18', '2026-10-20', 'availability_create', 'super_admin', 1, '2026-10-17T14:00:00.000Z')
	`).run(id.C, A.DIR.hollis);
	w.db.prepare("INSERT INTO deleted_loads (load_id, deleted_by) VALUES ('8111', 'super_admin')").run();
	return { w, id };
}

// The world's database and sheet as files: the database as SQLite writes it, the
// sheet as a saved values.get of Job Tracking.
function saveCopy(w) {
	const dir = tempDir();
	const db = path.join(dir, "app.db");
	fs.writeFileSync(db, w.db.serialize());
	const values = path.join(dir, "job-tracking.json");
	fs.writeFileSync(values, JSON.stringify({ range: "'Job Tracking'!A1:Z30", majorDimension: "ROWS", values: w.sheet.tabs["Job Tracking"] }));
	return { dir, db, values };
}

const run = (copy, extra) => W.runScript(SCRIPT, [`--db=${copy.db}`, `--values-json=${copy.values}`, ...extra]);
const snapshot = (copy) => ({ hash: W.fileHash(copy.db), mtimeMs: fs.statSync(copy.db).mtimeMs, files: fs.readdirSync(copy.dir).sort() });

const R = A.createRunner("R11b follow-up: time off recorded over loads the driver already had (scripts/time-off-loads-report.js)");

(async () => {
	let world;
	try {
		world = await buildWorld();
	} catch (err) {
		R.ok("the fixture builds through the shipped routes", false, err.message);
		await R.finish();
		return;
	}
	const { w, id } = world;
	const copy = saveCopy(w);
	const before = snapshot(copy);
	const out = run(copy, ["--json"]);
	const j = out.json || {};
	const rows = Array.isArray(j.rows) ? j.rows : [];
	const row = (k) => rows.find((r) => r.id === id[k]) || { loads: [], saves: [], skipped: {} };
	const loadLines = (k) => (row(k).loads || []).map((l) => `${l.loadId} ${l.alreadyHad} ${l.checkedAsOf}`);

	R.section("The run");
	R.ok("exits 0 with JSON", out.code === 0 && !!out.json, (out.stderr || out.stdout).slice(0, 300));

	R.section("Which rows: recorded at or after --since, or re-dated at or after it");
	R.eq("rows listed, in the order recorded (B re-dated since; F at exactly since; H, C, E, D after it)", rows.map((r) => r.id), [id.B, id.F, id.H, id.C, id.E, id.D]);
	R.ok("A (recorded before since, only its kind changed since) is not listed", !rows.some((r) => r.id === id.A));
	R.ok("G (recorded 1 ms before since) is not listed", !rows.some((r) => r.id === id.G));
	R.eq("the default since is 2026-10-16 03:00 ET", j.since, "2026-10-16T07:00:00.000Z");

	R.section("Each row's loads: Load ID, already had (Assigned Date on or before the save day), the save day");
	R.eq("C: the edge days overlap, the day before and after don't; spacing and case match; cancelled and soft-deleted loads left out", loadLines("C"),
		["8101 yes 2026-10-17", "8109 yes 2026-10-17", "8105 no 2026-10-17", "8107 unknown 2026-10-17", "8106 unknown 2026-10-17", "8102 yes 2026-10-17"]);
	R.eq("B: a load covered when it was recorded stays as of that day; the re-dating's loads as of the re-dating", loadLines("B"),
		["8201 yes 2026-10-15", "8202 yes 2026-10-18", "8203 no 2026-10-18"]);
	R.eq("H: no audit line, so checked as of its last change", loadLines("H"), ["8204 yes 2026-10-18"]);
	R.eq("E: a cancelled row keeps its loads", loadLines("E"), ["8112 yes 2026-10-19"]);
	R.eq("D: as of 10/19, the Eastern day it was recorded at 22:30 EDT; 8402 ended before that day; 8403 left out by the early end", loadLines("D"), ["8401 yes 2026-10-19"]);
	R.eq("F: no loads", loadLines("F"), []);
	const l8101 = row("C").loads.find((l) => l.loadId === "8101") || {};
	R.eq("8101's days, status and cells", [l8101.from, l8101.to, l8101.status, l8101.pickup, l8101.dropoff, l8101.assignedDate],
		["2026-10-18", "2026-10-20", "Dispatched", { cell: "10/18/2026 08:00", day: "2026-10-18" }, { cell: "10/20/2026 17:00", day: "2026-10-20" }, { cell: "10/15/2026 09:12:00", day: "2026-10-15" }]);
	const l8106 = row("C").loads.find((l) => l.loadId === "8106") || {};
	R.eq("8106's blank Assigned Date", l8106.assignedDate, { cell: "", day: "" });

	R.section("Loads with no readable day are skipped and counted");
	R.eq("C and E (both Hollis's) skip 8108", [row("C").skipped.noDates, row("E").skipped.noDates], [["8108"], ["8108"]]);
	R.eq("B skips none", row("B").skipped.noDates, []);

	R.section("Confirmations (driver_availability_confirmations)");
	R.eq("only 8101 on C is confirmed, via the time-off save", rows.flatMap((r) => (r.loads || []).filter((l) => l.confirmed).map((l) => `${r.id} ${l.loadId} ${l.confirmedVia.join(",")}`)),
		[`${id.C} 8101 availability_create`]);

	R.section("Row details: driver, days, state, stamps in Eastern, the saves");
	const c = row("C");
	R.eq("C", [c.driver, c.kind, c.from, c.to, c.recordedAt, c.recordedAtText, c.lastChangedAt, c.lastChangedAtText, c.historyComplete],
		["Hollis Renner", "vacation", "2026-10-20", "2026-10-26", "2026-10-17T14:00:00.000Z", "2026-10-17 10:00 EDT", null, null, true]);
	const b = row("B");
	R.eq("B's saves", b.saves, [
		{ change: "recorded", at: "2026-10-15T18:00:00.000Z", atText: "2026-10-15 14:00 EDT", day: "2026-10-15", from: "2026-10-24", to: "2026-10-25", oldFrom: null, oldTo: null },
		{ change: "changed", at: "2026-10-18T15:00:00.000Z", atText: "2026-10-18 11:00 EDT", day: "2026-10-18", from: "2026-10-24", to: "2026-10-27", oldFrom: "2026-10-24", oldTo: "2026-10-25" },
	]);
	R.eq("B last changed", [b.lastChangedAt, b.lastChangedAtText], ["2026-10-18T15:00:00.000Z", "2026-10-18 11:00 EDT"]);
	const e = row("E");
	R.eq("E is cancelled", [e.state, e.cancelledAt, e.cancelledAtText], ["cancelled", "2026-10-19T16:00:00.000Z", "2026-10-19 12:00 EDT"]);
	const d = row("D");
	R.eq("D ended early: recorded in the evening Eastern, ended", [d.from, d.to, d.state, d.recordedAtText, d.saves.map((s) => `${s.change} ${s.day} ${s.from}..${s.to}`)],
		["2026-10-14", "2026-10-19", "ended", "2026-10-19 22:30 EDT", ["recorded 2026-10-19 2026-10-14..2026-10-25", "changed 2026-10-20 2026-10-14..2026-10-19"]]);
	R.eq("H is flagged: the audit log does not account for it", [row("H").historyComplete, row("H").saves.map((s) => `${s.change} ${s.day}`)], [false, ["changed 2026-10-18"]]);

	R.section("Counts");
	const s = j.summary || {};
	R.eq("[rows checked, with already-had loads, loads listed, already had, not yet, unknown, skipped for no dates, confirmed]",
		[s.rowsChecked, s.rowsWithAlreadyHadLoads, s.loadsListed, s.loadsAlreadyHad, s.loadsNotYetAssigned, s.loadsAssignedDateUnknown, s.loadsSkippedNoDates, s.loadsConfirmed],
		[6, 5, 12, 8, 2, 2, 1, 1]);

	R.section("The --json shape");
	R.eq("top-level keys", Object.keys(j).sort(), ["generatedAt", "rows", "since", "summary", "timeZone", "today"]);
	R.eq("a row's keys", Object.keys(c).sort(), ["cancelledAt", "cancelledAtText", "directoryId", "driver", "from", "historyComplete", "id", "kind", "lastChangedAt", "lastChangedAtText", "loads", "recordedAs", "recordedAt", "recordedAtText", "saves", "skipped", "state", "to"]);
	R.eq("a load's keys", Object.keys(l8101).sort(), ["alreadyHad", "assignedDate", "checkedAsOf", "confirmed", "confirmedVia", "dropoff", "from", "loadId", "pickup", "status", "to"]);
	R.eq("the zone", j.timeZone, "America/New_York");

	R.section("--since");
	const later = run(copy, ["--since=2026-10-18T00:00:00Z", "--json"]);
	R.eq("since 10/18 00:00 UTC: B (re-dated 10/18), H (changed 10/18), E and D", ((later.json || {}).rows || []).map((r) => r.id), [id.B, id.H, id.E, id.D]);
	R.eq("refused (exit 2): a since that is not an instant, no sheet, no database", [
		run(copy, ["--since=2026-10-16", "--json"]).code,
		W.runScript(SCRIPT, [`--db=${copy.db}`, "--json"]).code,
		W.runScript(SCRIPT, [`--values-json=${copy.values}`, "--json"]).code,
	], [2, 2, 2]);

	R.section("The text report");
	const text = run(copy, []);
	R.ok("exits 0 and says nothing was written", text.code === 0 && /Nothing was written/.test(text.stdout), (text.stderr || text.stdout).slice(0, 300));
	R.ok("names the driver, the groups and the Eastern stamps", ["Hollis Renner", "Already had", "Not yet assigned", "Assigned date unknown", "10:00 EDT", "cancelled"].every((x) => text.stdout.includes(x)), text.stdout.slice(0, 400));
	R.ok("ends with the counts", /rows checked 6.*rows with already-had loads 5.*loads listed 12.*loads skipped for no dates 1/s.test(text.stdout.split("\n").slice(-3).join("\n")), text.stdout.split("\n").slice(-3).join(" | "));

	R.section("Read-only");
	R.eq("the database file's bytes, mtime and folder after five runs", snapshot(copy), before);
	const missing = path.join(copy.dir, "no-such.db");
	const gone = W.runScript(SCRIPT, [`--db=${missing}`, `--values-json=${copy.values}`, "--json"]);
	R.eq("a missing database is refused (exit 2) and never created", [gone.code, fs.existsSync(missing)], [2, false]);

	// A WAL database the app holds open: a row still in the -wal is read, and the
	// main file is left as it was.
	const live = saveCopy(w);
	const writer = new W.Database(live.db);
	try {
		writer.pragma("journal_mode = WAL");
		writer.pragma("wal_autocheckpoint = 0");
		const walId = Number(writer.prepare(`
			INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, reason, created_by, created_by_user_id, created_at)
			VALUES (?, 'Tamsin Vale', 'vacation', '2026-12-01', '2026-12-02', '', 'super_admin', 1, '2026-10-21T12:00:00.000Z')
		`).run(A.DIR.tamsin).lastInsertRowid);
		const mainBefore = W.fileHash(live.db);
		const walRun = run(live, ["--json"]);
		R.ok("a row only in the -wal is listed", ((walRun.json || {}).rows || []).some((r) => r.id === walId), (walRun.stderr || walRun.stdout).slice(0, 300));
		R.eq("the main file unchanged", W.fileHash(live.db), mainBefore);
	} finally {
		writer.close();
	}

	await w.close();
	await R.finish();
})();
