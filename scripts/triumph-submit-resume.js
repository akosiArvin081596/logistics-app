#!/usr/bin/env node
// Lifts the pause on Triumph submissions (lib/triumph-job.js), the lead's step on Arvin's yes,
// after a host key that didn't match the pinned fingerprint (once Arvin has checked it), a
// refused sign-in, or a CSV that may have reached Triumph (MAYBE_SUBMITTED, once a person has
// looked on Triumph's side). The one writer that clears it.
//
//   node scripts/triumph-submit-resume.js --db=<app.db> (--dry-run | --apply) [--reason="<why>"] [--json]
//
// --dry-run: opens the database read-only and says what --apply would do: the pause's reason
//   code and since when, and the claims waiting for a person, by code. Writes nothing.
// --apply: clears the pause in one immediate transaction, with one audit row as the system
//   actor "triumph-resume" (triumph_resumed, with the reason). A run with no pause changes
//   nothing and writes no row, so a replay is harmless. No claim is touched: a MAYBE_SUBMITTED
//   one stays with a person and is never sent again; the others go on at the next tick.
// --db has no default. Output: codes and counts only. Exit 0 done; 2 refused; 1 any other failure.
//
// Required as a module (by its runner) it runs nothing and exports run().

"use strict";

const fs = require("fs");
const path = require("path");
const ledger = require("../lib/triumph-ledger");
const factoring = require("../lib/factoring-store");

const ACTOR = Object.freeze({ id: 0, username: "triumph-resume", role: "system" });

class Refusal extends Error {}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/s.exec(String(a));
		if (!m) throw new Refusal(`unknown argument: ${String(a).slice(0, 40)}`);
		const [, name, value] = m;
		if (["dry-run", "apply", "json"].includes(name) && value === undefined) out[name] = true;
		else if (["db", "reason"].includes(name) && value !== undefined) out[name] = value;
		else throw new Refusal(`unknown or malformed argument: --${name}`);
	}
	if (Boolean(out["dry-run"]) === Boolean(out.apply)) throw new Refusal("give exactly one of --dry-run and --apply");
	if (!out.db) throw new Refusal("--db=<app.db> is required");
	if (out.apply && !factoring.cleanReason(out.reason)) throw new Refusal("--apply needs --reason");
	return out;
}

// One run on an open database (read-only for a dry run).
function run({ db, dryRun, reason = "", nowIso = new Date().toISOString() }) {
	if (!ledger.hasSchema(db) || !ledger.hasTable(db, "audit_trail")) throw new Refusal("the database has no Triumph tables or no audit_trail (the job never ran on it)");
	const meta = ledger.getMeta(db);
	const pause = meta.paused_until ? { reason: meta.pause_reason || "", until: meta.paused_until, ended: meta.paused_until <= nowIso } : null;
	const waiting = {};
	for (const c of ledger.listClaims(db, ["needs_attention"])) waiting[c.reason_code || "NONE"] = (waiting[c.reason_code || "NONE"] || 0) + 1;
	const out = { dryRun, pause, waiting, cleared: false };
	if (!pause || dryRun) return out;
	const why = factoring.cleanReason(reason);
	db.transaction(() => {
		ledger.clearPause(db);
		db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.run(nowIso, ACTOR.id, ACTOR.username, ACTOR.role, "triumph_resumed", "triumph", "", `the pause (${pause.reason || "PAUSED"}) cleared: ${why}`);
	}).immediate();
	return { ...out, cleared: true };
}

function textOf(r) {
	const lines = [r.dryRun ? "DRY RUN (nothing written)" : r.cleared ? "APPLIED: the pause is cleared" : "Nothing to clear"];
	lines.push(r.pause ? `  pause: ${r.pause.reason || "PAUSED"}${r.pause.ended ? " (its time has already passed)" : ""}${r.dryRun ? "; --apply would clear it" : ""}` : "  pause: none");
	const codes = Object.entries(r.waiting);
	lines.push(`  claims with a person: ${codes.length ? codes.map(([k, v]) => `${k} ${v}`).join(", ") : "none"}`);
	if (r.waiting.MAYBE_SUBMITTED) lines.push("  MAYBE_SUBMITTED stays with a person: it is never sent again");
	return lines.join("\n");
}

function main(argv) {
	let args;
	try {
		args = parseArgs(argv);
		const dbPath = path.resolve(args.db);
		if (!fs.existsSync(dbPath)) throw new Refusal("--db names no file");
		const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
		const dryRun = Boolean(args["dry-run"]);
		const db = new Database(dbPath, dryRun ? { readonly: true, fileMustExist: true } : { fileMustExist: true });
		try {
			if (!dryRun) db.pragma("busy_timeout = 5000");
			const r = run({ db, dryRun, reason: args.reason });
			process.stdout.write(`${args.json ? JSON.stringify(r) : textOf(r)}\n`);
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
