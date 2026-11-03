#!/usr/bin/env node
// Made-up C.H. Robinson rows for the CHR page's browser check, planted in a
// scratch DB BEFORE boot-server.sh boots a server on it with
// CHR_UPDATES_ENABLED=true.
//
//   node scripts/e2e/plant-chr-made-up.cjs <db> [--load <Load ID>]   plant
//   node scripts/e2e/plant-chr-made-up.cjs <db> --remove             delete them
//
// What it plants, through lib/chr-store.js (made-up values only): the CHR tables;
// one CHR load (default 123456789; pass a made-up load the e2e dashboard shows,
// so its detail carries the badge) with one dry-run "Departed pickup" row (its
// allowlisted payload: load number, event, stop, time, city and state, truck
// T-101) and one held "Arrived at delivery" row (no clean truck position). Every
// planted row's key starts "e2e|", which --remove deletes. No name, phone or
// address is written.
//
// Refuses: a DB outside the work dir or a symlink (paths.cjs), and a DB any
// process has open (plant before boot).
"use strict";
const { execFileSync } = require("child_process");
const path = require("path");
const paths = require("./paths.cjs");

function fail(msg, code = 2) {
	console.error(`plant-chr-made-up: ${msg}`);
	process.exit(code);
}

const args = process.argv.slice(2);
const dbArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--load");
const loadAt = args.indexOf("--load");
const loadId = loadAt >= 0 ? String(args[loadAt + 1] || "") : "123456789";
const remove = args.includes("--remove");
if (!dbArg) fail("usage: node scripts/e2e/plant-chr-made-up.cjs <db> [--load <Load ID> | --remove]  (db inside the work dir)");
if (!/^\d{9}$/.test(loadId)) fail("--load takes a made-up 9-digit Load ID");

paths.warnNodeVersion("plant-chr-made-up");
let dbAbs, Database, S;
try {
	paths.workDir();
	dbAbs = paths.workFile(dbArg);
	Database = paths.appRequire("better-sqlite3");
	S = require(path.join(paths.appDir(), "lib", "chr-store.js"));
} catch (e) {
	fail(e.message);
}

let holders = "";
try {
	holders = execFileSync("lsof", ["-t", "--", dbAbs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch { /* no process has it open */ }
if (holders) fail(`refusing: process(es) ${holders.split(/\s+/).join(", ")} have ${dbAbs} open: stop that server, plant, then boot.`);

const db = new Database(dbAbs, { fileMustExist: true });
db.pragma("busy_timeout = 5000");
try {
	if (remove) {
		const n = S.tablesExist(db) ? db.prepare("DELETE FROM chr_events WHERE idem_key LIKE 'e2e|%'").run().changes : 0;
		if (S.tablesExist(db)) db.prepare("DELETE FROM chr_loads WHERE load_id = ?").run(loadId);
		console.log(`plant-chr-made-up: removed ${n} planted row(s)`);
	} else {
		S.ensureSchema(db);
		const now = Date.now();
		const iso = (ms) => new Date(ms).toISOString();
		const departedAt = now - 50 * 60 * 1000;
		const payload = {
			loadNumber: loadId, event: "departed_pickup", stop: { kind: "pickup", index: 1 }, eventAt: iso(departedAt).replace(/\.\d{3}Z$/, "Z"),
			place: { city: "Ames", state: "IA" }, truck: "T-101",
		};
		const base = { load_id: loadId, kind: "milestone", source: "geofence", mode: "dry_run", next_attempt_at: "" };
		S.applyRecording(db, {
			inserts: [
				{ ...base, event: "departed_pickup", stop_kind: "pickup", stop_index: 1, history_row_id: 0, event_at: iso(departedAt), verify: "confirmed",
					idem_key: `e2e|${loadId}|departed_pickup`, payload_json: JSON.stringify(payload), status: "dry_run" },
				{ ...base, event: "arrived_delivery", stop_kind: "delivery", stop_index: 1, history_row_id: 0, event_at: iso(now - 10 * 60 * 1000), verify: "unverified",
					idem_key: `e2e|${loadId}|arrived_delivery`, status: "held", hold_reason: "tap_unverified" },
			],
			loads: [{ load_id: loadId, multi_stop: false, multi_stop_why: "", last_event: "arrived_delivery", last_event_at: iso(now - 10 * 60 * 1000) }],
			state: S.readState(db),
			nowIso: iso(now),
		});
		db.prepare("UPDATE chr_events SET sent_at = ? WHERE idem_key = ?").run(iso(departedAt + 6 * 60 * 1000), `e2e|${loadId}|departed_pickup`);
		console.log(`plant-chr-made-up: planted 2 rows for made-up load ${loadId}; boot with CHR_UPDATES_ENABLED=true`);
	}
} catch (e) {
	fail(e.message, 1);
} finally {
	try { db.close(); } catch { /* ignore */ }
}
