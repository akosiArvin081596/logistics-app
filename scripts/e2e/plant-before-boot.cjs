#!/usr/bin/env node
// What the E2E's B1 needs in a scratch DB BEFORE boot-server.sh boots a server on it.
//
//   node scripts/e2e/plant-before-boot.cjs <db> [--force]   plant B1's expense
//   node scripts/e2e/plant-before-boot.cjs <db> --remove    delete it and restore the assignment
//
// B1 shows the server's startup expense backfill: on every boot, server.js stamps
// truck_unit/owner_id onto the expenses whose truck_unit is empty by matching the
// expense's driver against truck_assignments on the expense's date. The backfill
// runs once, at boot, so its input has to be in the DB before the server starts.
// This script plants the case the backfill's spacing step exists for: a receipt
// filed under a driver's OWN account spelling, while the truck assignment covering
// its date stores that name with a different spacing.
//   - expense: driver = the Driver account's own name, exactly as the account
//     stores it (what the driver's own session files under); date = today in US
//     Central, a month that is not finalized (period_locks); truck_unit blank,
//     owner_id 0, type Other, $0.01, load_id QA-TEST-B1, description
//     QA-TEST-B1-<timestamp>, timestamp = when it was planted.
//   - the assignment covering that date, stored under exactly the account's
//     spelling, is RE-SPELLED in this copy with its first whitespace run doubled.
//     No account, no directory row and no other assignment holds that spelling,
//     and no other account's name normalizes to the driver's, so the fixed
//     backfill may take it (the other-account rule findTruckForDriverStamp()
//     applies) while a case-only match cannot.
//   - b1-plant.json (0600, in the work dir) records the expense, assignment and
//     account ids, never a name. The run's B1 step, --remove and --force put the
//     assignment's spelling back from the account's own name.
// The harness driver (logins.json) is preferred; otherwise the lowest-id Driver
// account that qualifies. The run (ONLY=moneypath, STEPS=B1) finds the row by its
// load_id and description, reads what the boot made of it, shows it on the
// Expenses page and deletes it. Nothing else is written, and nothing is printed
// but ids, dates and the truck's unit number: no name, no pay.
//
// Refuses: a DB outside the work dir or a symlink (paths.cjs), a DB any process
// has open (a server booted on it plants nothing: stop it first), and a DB that
// already holds B1's row (--force replaces it; --remove deletes it).
//
// Env: E2E_WORK_DIR, CREDS_FILE, APP_DIR (see paths.cjs and setup-db.cjs).
"use strict";
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const paths = require("./paths.cjs");

const B1_LOAD = "QA-TEST-B1";
const B1_DESC_PREFIX = "QA-TEST-B1-";
const B1_PLANT_FILE = "b1-plant.json";

function fail(msg, code = 2) {
	console.error(`plant-before-boot: ${msg}`);
	process.exit(code);
}

const args = process.argv.slice(2);
const dbArg = args.find((a) => !a.startsWith("--"));
const force = args.includes("--force");
const remove = args.includes("--remove");
if (!dbArg) fail("usage: node scripts/e2e/plant-before-boot.cjs <db> [--force | --remove]  (db inside the work dir)");

paths.warnNodeVersion("plant-before-boot");
let WORK, dbAbs, Database;
try {
	WORK = paths.workDir();
	dbAbs = paths.workFile(dbArg);
	Database = paths.appRequire("better-sqlite3");
} catch (e) {
	fail(e.message);
}

// A server that already booted on this DB has run its backfill: a row planted now
// would never meet it. lsof exits 1 when no process has the file open.
let holders = "";
try {
	holders = execFileSync("lsof", ["-t", "--", dbAbs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch { /* no process has it open */ }
if (holders) {
	fail(`refusing: process(es) ${holders.split(/\s+/).join(", ")} have ${dbAbs} open. ` +
		"B1 is planted BEFORE boot: stop that server (stop-server.sh <port>), plant, then boot.");
}

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const dayCT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const db = new Database(dbAbs, { fileMustExist: true });
db.pragma("busy_timeout = 5000");
let outcome = { code: 0, msg: "" };
try {
	outcome = run() || outcome;
} catch (e) {
	outcome = { code: 1, msg: e.message };
} finally {
	try { db.close(); } catch { /* ignore */ }
}
if (outcome.code) fail(outcome.msg, outcome.code);

// Returns { code, msg } to refuse; undefined when done.
// Puts the planted assignment's spelling back from the account's own name, when
// it still holds a spacing variant of it. Ids come from b1-plant.json; no name is
// read from or written to disk.
function restoreAssignment() {
	const file = path.join(WORK, B1_PLANT_FILE);
	if (!fs.existsSync(file)) return "no b1-plant.json (no assignment to restore)";
	let rec = null;
	try { rec = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return `b1-plant.json unreadable: ${e.message}`; }
	const u = db.prepare("SELECT driver_name FROM users WHERE id = ?").get(rec.userId);
	const a = db.prepare("SELECT driver_name FROM truck_assignments WHERE id = ?").get(rec.assignmentId);
	let note;
	if (!u || !a) note = `assignment #${rec.assignmentId} or account #${rec.userId} not found; nothing restored`;
	else if (a.driver_name === u.driver_name) note = `assignment #${rec.assignmentId} already holds the account's spelling`;
	else if (norm(a.driver_name) !== norm(u.driver_name)) note = `assignment #${rec.assignmentId} holds another name; left alone`;
	else {
		const n = db.prepare("UPDATE truck_assignments SET driver_name = ? WHERE id = ?").run(u.driver_name, rec.assignmentId).changes;
		note = `assignment #${rec.assignmentId} ${n === 1 ? "restored to the account's spelling" : "NOT restored"}`;
	}
	fs.unlinkSync(file);
	return note;
}

function run() {
	const existing = db.prepare("SELECT id FROM expenses WHERE load_id = ? AND description LIKE ?").all(B1_LOAD, `${B1_DESC_PREFIX}%`);
	if (remove) {
		const n = db.prepare("DELETE FROM expenses WHERE load_id = ? AND description LIKE ?").run(B1_LOAD, `${B1_DESC_PREFIX}%`).changes;
		console.log(`removed ${n} B1 row(s)${existing.length ? ` (#${existing.map((r) => r.id).join(", #")})` : ""}; ${restoreAssignment()}`);
		return;
	}
	if (existing.length && !force) {
		return { code: 2, msg: `refusing: B1 is already planted in this DB (expense #${existing.map((r) => r.id).join(", #")}). ` +
			"--force replaces it; --remove deletes it." };
	}

	const month = dayCT.slice(0, 7);
	const lock = db.prepare("SELECT status FROM period_locks WHERE period = ?").get(month);
	if (lock && String(lock.status) === "locked") return { code: 2, msg: `refusing: ${month} is finalized (period_locks), and the backfill leaves finalized months alone` };

	let creds = null;
	try { creds = JSON.parse(fs.readFileSync(process.env.LOGINS_FILE || path.join(WORK, "logins.json"), "utf8")); } catch { /* no logins file: any Driver */ }
	const users = db.prepare("SELECT id, driver_name FROM users WHERE role = 'Driver' AND COALESCE(driver_name, '') != '' ORDER BY id").all();
	const preferred = creds?.driver?.userId;
	users.sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : a.id - b.id));

	const heldBy = (spelling) =>
		db.prepare("SELECT COUNT(*) AS n FROM users WHERE LOWER(driver_name) = LOWER(?)").get(spelling).n +
		db.prepare("SELECT COUNT(*) AS n FROM drivers_directory WHERE LOWER(driver_name) = LOWER(?)").get(spelling).n;
	const covering = db.prepare(`
		SELECT ta.id, ta.truck_id, ta.driver_name, t.unit_number, t.owner_id
		FROM truck_assignments ta JOIN trucks t ON t.id = ta.truck_id
		WHERE LOWER(ta.driver_name) = LOWER(?)
		  AND substr(ta.start_date, 1, 10) <= ?
		  AND (ta.end_date = '' OR substr(ta.end_date, 1, 10) >= ?)
		ORDER BY ta.start_date DESC
		LIMIT 1
	`);
	const assignedUnder = db.prepare("SELECT COUNT(*) AS n FROM truck_assignments WHERE LOWER(driver_name) = LOWER(?)");

	let pick = null;
	const why = [];
	for (const u of users) {
		const name = String(u.driver_name).trim();
		if (!/\S\s+\S/.test(name)) { why.push(`#${u.id} one word`); continue; }
		const variant = name.replace(/\s+/, "  ");
		if (variant === name) { why.push(`#${u.id} already doubled`); continue; }
		if (u.driver_name !== name) { why.push(`#${u.id} stored with edge spaces`); continue; }
		if (db.prepare("SELECT driver_name FROM users WHERE COALESCE(driver_name, '') != ''").all().filter((x) => norm(x.driver_name) === norm(name)).length !== 1) { why.push(`#${u.id} shares its name`); continue; }
		if (heldBy(variant)) { why.push(`#${u.id} doubled spelling is held`); continue; }
		if (assignedUnder.get(variant).n) { why.push(`#${u.id} has an assignment under the doubled spelling`); continue; }
		const a = covering.get(name, dayCT, dayCT);
		if (!a || !String(a.unit_number || "").trim()) { why.push(`#${u.id} no assignment covers ${dayCT}`); continue; }
		if (a.driver_name !== name) { why.push(`#${u.id} covering assignment spelled differently`); continue; }
		pick = { user: u, variant, assignment: a };
		break;
	}
	if (!pick) return { code: 3, msg: `no Driver account qualifies for B1 (${why.join("; ") || "no Driver accounts"})` };

	if (existing.length || fs.existsSync(path.join(WORK, B1_PLANT_FILE))) {
		const n = db.prepare("DELETE FROM expenses WHERE load_id = ? AND description LIKE ?").run(B1_LOAD, `${B1_DESC_PREFIX}%`).changes;
		console.log(`--force: removed ${n} earlier B1 row(s); ${restoreAssignment()}`);
	}
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
	const id = db.prepare(`
		INSERT INTO expenses (timestamp, driver, load_id, type, amount, description, date, status, truck_unit, owner_id)
		VALUES (?, ?, ?, 'Other', 0.01, ?, ?, 'Pending', '', 0)
	`).run(new Date().toISOString(), pick.user.driver_name, B1_LOAD, `${B1_DESC_PREFIX}${stamp}`, dayCT).lastInsertRowid;
	const a = pick.assignment;
	const changed = db.prepare("UPDATE truck_assignments SET driver_name = ? WHERE id = ? AND driver_name = ?").run(pick.variant, a.id, pick.user.driver_name).changes;
	if (changed !== 1) throw new Error(`could not re-spell assignment #${a.id}`);
	fs.writeFileSync(path.join(WORK, B1_PLANT_FILE), JSON.stringify({ expenseId: Number(id), assignmentId: a.id, userId: pick.user.id }) + "\n", { mode: 0o600 });
	console.log(`planted B1: expense #${id}, dated ${dayCT}, truck_unit blank, driver = user #${pick.user.id}'s own account spelling`);
	console.log(`the assignment covering that date: #${a.id} -> truck #${a.truck_id} (unit ${a.unit_number}, owner #${a.owner_id}), re-spelled in this copy with its space doubled`);
	console.log("next: boot the server on this DB (boot-server.sh), then run ONLY=moneypath (STEPS=B1 for B1 alone)");
}
