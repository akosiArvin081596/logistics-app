#!/usr/bin/env node
// Mark loads factored (Triumph, per load), or clear marks, from a list: the lead's
// tool for D's list, under rule F. The same checks as the marking route
// (lib/factoring-store.js mark() and clear()), whatever TRIUMPH_FACTORING_ENABLED
// says; a load a check refuses is skipped and listed with its code, never forced.
//
//   node scripts/factoring-mark.js --db=<app.db> (--mark | --clear)
//     (--loads=<Load ID>[,<Load ID>...] | --file=<one Load ID per line>)
//     --reason="<why, at most 200 characters>" (--dry-run | --apply) [--json]
//
// --dry-run: opens the database read-only, runs every check and says what
//   --apply would do; writes nothing.
// --apply: each load in its own immediate transaction, with one audit row as the
//   system actor "factoring-mark" (factoring_marked or factoring_cleared). A load
//   already as asked is left alone and counted (a replay changes nothing).
// --clear leaves a locked row (handed to Triumph, or handled in its process) as
//   it is, in both modes, and counts it.
// --db has no default. Output: counts by outcome and code, and each load by its
// last four characters; never a reason, an amount or an address.
// Exit 0 done; 2 refused (an argument, or a database without the tables); 1 any
// other failure.
//
// Required as a module (by its runner) it runs nothing and exports run().

"use strict";

const fs = require("fs");
const path = require("path");
const store = require("../lib/factoring-store");
const { loadKey } = require("../lib/auto-invoice-rules");

const ACTOR = Object.freeze({ id: 0, username: "factoring-mark", role: "system" });
const MAX_LOADS = 500;
const LOAD_ID_RE = /^#?[A-Za-z0-9][A-Za-z0-9 ._/-]{0,59}$/;
const KNOWN = { flags: new Set(["mark", "clear", "dry-run", "apply", "json"]), values: new Set(["db", "loads", "file", "reason"]) };

class Refusal extends Error {}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/s.exec(String(a));
		if (!m) throw new Refusal(`unknown argument: ${String(a).slice(0, 40)}`);
		const [, name, value] = m;
		if (KNOWN.flags.has(name) && value === undefined) out[name] = true;
		else if (KNOWN.values.has(name) && value !== undefined) out[name] = value;
		else throw new Refusal(`unknown or malformed argument: --${name}`);
	}
	if (Boolean(out.mark) === Boolean(out.clear)) throw new Refusal("give exactly one of --mark and --clear");
	if (Boolean(out["dry-run"]) === Boolean(out.apply)) throw new Refusal("give exactly one of --dry-run and --apply");
	if (!out.db) throw new Refusal("--db=<app.db> is required");
	if (Boolean(out.loads) === Boolean(out.file)) throw new Refusal("give exactly one of --loads and --file");
	if (!store.cleanReason(out.reason)) throw new Refusal("--reason is required");
	return out;
}

function loadIdsOf(args) {
	const raw = args.loads ? String(args.loads).split(",") : fs.readFileSync(args.file, "utf8").split(/\r?\n/);
	const ids = raw.map((s) => s.trim()).filter(Boolean);
	if (!ids.length) throw new Refusal("no Load ID given");
	if (ids.length > MAX_LOADS) throw new Refusal(`at most ${MAX_LOADS} loads at a time`);
	const bad = ids.findIndex((id) => !LOAD_ID_RE.test(id));
	if (bad >= 0) throw new Refusal(`entry ${bad + 1} is not a Load ID`);
	return ids;
}

const suffix = (id) => `...${String(id).slice(-4)}`;

// One run. `db` is opened by the caller (read-only for a dry run). Answers the
// counts and the per-load outcomes.
function run({ db, ids, mode, dryRun, reason, nowIso = new Date().toISOString() }) {
	if (!store.hasTable(db, store.FACTORING) || !store.hasTable(db, "audit_trail")) {
		throw new Refusal("the database has no load_factoring or audit_trail table (start the app on it once first)");
	}
	const insertAudit = dryRun ? null : db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	const seen = new Set();
	const loads = [];
	const counts = { asked: ids.length, duplicate: 0, changed: 0, unchanged: 0, locked: 0, refused: 0, refusedBy: {} };
	for (const loadId of ids) {
		const key = loadKey(loadId);
		if (seen.has(key)) {
			counts.duplicate++;
			continue;
		}
		seen.add(key);
		const audit = (action, details) => insertAudit.run(nowIso, ACTOR.id, ACTOR.username, ACTOR.role, action, "load", loadId, details);
		const args = { key, loadId, reason, source: "script", actor: ACTOR, nowIso, audit, dryRun };
		const r = mode === "mark" ? store.mark(db, args) : store.clear(db, args);
		let outcome;
		if (r.ok) outcome = r.changed ? "changed" : "unchanged";
		else if (r.code === "FACTORING_LOCKED") outcome = "locked";
		else outcome = "refused";
		counts[outcome]++;
		if (outcome === "refused") counts.refusedBy[r.code] = (counts.refusedBy[r.code] || 0) + 1;
		loads.push({ load: suffix(loadId), outcome, code: r.ok ? "" : r.code });
	}
	return { mode, dryRun, counts, loads };
}

function textOf(result) {
	const c = result.counts;
	const verb = result.mode === "mark" ? "mark factored" : "clear the mark";
	const would = result.dryRun ? "would " : "";
	return [
		`${result.dryRun ? "DRY RUN (nothing written)" : "APPLIED"}: ${verb}, ${c.asked} load(s) asked${c.duplicate ? ` (${c.duplicate} repeated, counted once)` : ""}`,
		`  ${would}change: ${c.changed}`,
		`  already so: ${c.unchanged}`,
		`  locked, left as it is: ${c.locked}`,
		`  refused by a check: ${c.refused}${Object.keys(c.refusedBy).length ? ` (${Object.entries(c.refusedBy).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`,
		...result.loads.map((l) => `  ${l.load}: ${l.outcome}${l.code ? ` ${l.code}` : ""}`),
	].join("\n");
}

function main(argv) {
	let args;
	try {
		args = parseArgs(argv);
		const ids = loadIdsOf(args);
		const dbPath = path.resolve(args.db);
		if (!fs.existsSync(dbPath)) throw new Refusal("--db names no file");
		const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
		const dryRun = Boolean(args["dry-run"]);
		const db = new Database(dbPath, dryRun ? { readonly: true, fileMustExist: true } : { fileMustExist: true });
		try {
			if (!dryRun) db.pragma("busy_timeout = 5000");
			const result = run({ db, ids, mode: args.mark ? "mark" : "clear", dryRun, reason: args.reason });
			process.stdout.write(`${args.json ? JSON.stringify(result) : textOf(result)}\n`);
		} finally {
			db.close();
		}
		return 0;
	} catch (e) {
		if (e instanceof Refusal) {
			process.stderr.write(`refused: ${e.message}\n`);
			return 2;
		}
		process.stderr.write(`failed: ${(e && e.code) || "ERROR"}\n`);
		return 1;
	}
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { run, parseArgs, textOf, main, Refusal };
