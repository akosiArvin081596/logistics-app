#!/usr/bin/env node
// scripts/test-messaging-desk-name-count.js — the pre-merge count for the
// staff-only messaging change (scripts/messaging-desk-name-count.js):
//   §1 countDeskNames(): (a) desk-named accounts, (b) name collisions, (c)
//      Drivers without a driver name, each folded like normalizeDriverName();
//      the gate passes only when (a) and (b) are 0
//   §2 its reserved names are server.js's (findDriverNameClashes())
//   §3 the command on a database file: read-only (the file is unchanged), counts
//      only (no name in the output), exit 0 / 1 / 2
// Made-up names only; a temp database, removed at the end.
// Run: node scripts/test-messaging-desk-name-count.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");
const { countDeskNames, RESERVED } = require("./messaging-desk-name-count");

let failed = 0;
const ok = (name, cond) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}`); }
};

// §1
const clean = [
	{ id: 1, role: "Super Admin", username: "boss_t", driver_name: "" },
	{ id: 2, role: "Dispatcher", username: "desk_t", driver_name: "" },
	{ id: 10, role: "Driver", username: "drv_a", driver_name: "Tamsin Vale" },
	{ id: 11, role: "Driver", username: "drv_b", driver_name: "Orrin Cade" },
	{ id: 50, role: "Investor", username: "inv_t", driver_name: "" },
	{ id: 51, role: "Investor", username: "admin_wren", driver_name: "" },
];
const base = countDeskNames(clean);
ok("§1 a clean set: (a) 0, (b) 0, (c) 0, PASS", base.a_desk_named_accounts === 0 && base.b_name_collisions === 0
	&& base.c_driver_accounts_without_a_driver_name === 0 && base.gate === "PASS" && base.accounts === 6);
const withRow = (row) => countDeskNames([...clean, row]);
ok("§1 an Investor named \" Admin \": (a) 1, STOP", withRow({ id: 52, role: "Investor", username: " Admin ", driver_name: "" }).a_desk_named_accounts === 1
	&& withRow({ id: 52, role: "Investor", username: " Admin ", driver_name: "" }).gate === "STOP");
ok("§1 a staff account named \"DISPATCH\": (a) 1", withRow({ id: 3, role: "Dispatcher", username: "DISPATCH", driver_name: "" }).a_desk_named_accounts === 1);
ok("§1 a driver named \"Investor\": (a) 1", withRow({ id: 12, role: "Driver", username: "drv_c", driver_name: "Investor" }).a_desk_named_accounts === 1);
{
	const r = withRow({ id: 53, role: "Investor", username: "tamsin  VALE", driver_name: "" });
	ok("§1 a username that is another account's driver name (case and spacing aside): (b) 1, STOP",
		r.b1_username_is_another_accounts_driver_name === 1 && r.b_name_collisions === 1 && r.gate === "STOP");
}
{
	const r = withRow({ id: 13, role: "Driver", username: "drv_d", driver_name: " orrin cade " });
	ok("§1 two accounts sharing a driver name: (b) 1", r.b2_accounts_sharing_a_driver_name === 1 && r.gate === "STOP");
}
{
	const r = withRow({ id: 54, role: "Investor", username: "INV_T", driver_name: "" });
	ok("§1 two usernames equal but for case: (b) 1", r.b3_usernames_equal_but_for_case_or_spacing === 1 && r.gate === "STOP");
}
{
	const r = withRow({ id: 14, role: "Driver", username: "drv_e", driver_name: "  " });
	ok("§1 a Driver with no driver name: (c) 1, the gate still PASS", r.c_driver_accounts_without_a_driver_name === 1 && r.gate === "PASS");
}
{
	const r = withRow({ id: 15, role: "Driver", username: "Wren Holt", driver_name: "wren holt" });
	ok("§1 an account whose username is its own driver name is no collision", r.b_name_collisions === 0 && r.gate === "PASS");
}

// §2
{
	const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
	const m = src.match(/\n\tconst RESERVED_NAMES = (\[[^\]\n]*\]);/);
	const shipped = m ? JSON.parse(m[1]) : null;
	ok("§2 the reserved names are findDriverNameClashes()'s", !!shipped && shipped.length === RESERVED.length && shipped.every((n) => RESERVED.includes(n)));
}

// §3
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msg-desk-count-"));
	try {
		const file = path.join(tmp, "app.db");
		const db = new Database(file);
		db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, role TEXT, driver_name TEXT DEFAULT '')");
		const add = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (?, ?, 'x', ?, ?)");
		for (const r of clean) add.run(r.id, r.username, r.role, r.driver_name);
		db.close();
		const script = path.join(__dirname, "messaging-desk-name-count.js");
		const before = fs.readFileSync(file);
		const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
		const pass = run(`--db=${file}`);
		ok(`§3 a clean database: exit 0, GATE: PASS (got ${pass.status})`, pass.status === 0 && /GATE: PASS/.test(pass.stdout));
		ok("§3 ...the output names no account", !clean.some((r) => pass.stdout.includes(r.username) || (r.driver_name && pass.stdout.includes(r.driver_name))));
		ok("§3 ...and the database file is unchanged", Buffer.compare(before, fs.readFileSync(file)) === 0);
		const json = run(`--db=${file}`, "--json");
		ok("§3 --json: the counts as one JSON line", json.status === 0 && JSON.parse(json.stdout.trim()).gate === "PASS");
		const w = new Database(file);
		w.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (60, 'admin', 'x', 'Investor', '')").run();
		w.close();
		const stop = run(`--db=${file}`);
		ok(`§3 a desk-named account: exit 1, GATE: STOP (got ${stop.status})`, stop.status === 1 && /GATE: STOP/.test(stop.stdout) && !/\badmin\b/.test(stop.stdout.split("\n").filter((l) => !l.startsWith("GATE")).join("\n")));
		ok("§3 no --db: exit 2", run().status === 2);
		ok("§3 a file that is not there: exit 2, nothing created", run(`--db=${path.join(tmp, "missing.db")}`).status === 2 && !fs.existsSync(path.join(tmp, "missing.db")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
