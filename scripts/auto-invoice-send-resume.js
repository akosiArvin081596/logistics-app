#!/usr/bin/env node
// Resume automatic invoice sending (AUTO_INVOICE_SEND_ENABLED) after a stop: the
// one way the stop is cleared. A Super Admin's Stop, or an automatic one (an SMTP
// refusal, an unanswered send, a send not found in Sent Mail, a load changed
// after its send), stays until this runs on the server, after an approved go-ahead.
//
//   node scripts/auto-invoice-send-resume.js --db=<app.db> (--dry-run | --apply) [--json]
//
// --dry-run: opens the database read-only and says whether sending is stopped,
//   since when and why, and what --apply would do; writes nothing.
// --apply: clears the stop and writes one audit row as the system actor
//   "auto-invoice-send-resume" (auto_invoice_send_resumed), in one transaction, and
//   clears the list of loads held after their send with it, so the next hold starts a
//   new count rather than trip the breaker at once (AUTO_INVOICE_HOLD_ONE_LOAD).
//   Nothing stopped: nothing written (a replay changes nothing).
// Either way it refuses while any load's send is unconfirmed (it may have gone
// out and isn't found in Sent Mail yet, or a person must check): resolve those
// first (Try again searches Sent Mail once more; a person who finds it wasn't sent
// drafts it by hand, confirming the re-issue with a reason). --db has no default. Output: the stop's time and reason code, and counts;
// never an address, an amount or a load.
// Exit 0 done; 2 refused (an argument, a database without the tables, or an
// unconfirmed send); 1 any other failure.
//
// Required as a module (by its runner) it runs nothing and exports run().

"use strict";

const fs = require("fs");
const path = require("path");
const ledger = require("../lib/auto-invoice-ledger");

const ACTOR = Object.freeze({ id: 0, username: "auto-invoice-send-resume", role: "system" });
const KNOWN = { flags: new Set(["dry-run", "apply", "json"]), values: new Set(["db"]) };

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
	if (Boolean(out["dry-run"]) === Boolean(out.apply)) throw new Refusal("give exactly one of --dry-run and --apply");
	if (!out.db) throw new Refusal("--db=<app.db> is required");
	return out;
}

// Sends started and not confirmed: still searched for, or waiting for a person
// (MAYBE_SENT). One a person closed (drafted by hand after a re-issue) is not.
function unconfirmedSends(db) {
	const cols = new Set(db.prepare(`PRAGMA table_info(${ledger.CLAIMS})`).all().map((c) => c.name));
	if (!cols.has("delivery")) return 0;
	return db.prepare(`SELECT COUNT(*) AS n FROM ${ledger.CLAIMS} WHERE delivery = 'send' AND stage = 'appending' AND state IN ('queued', 'working', 'needs_attention')`).get().n;
}

// One run on a database the caller opened (read-only for a dry run).
function run({ db, dryRun, nowIso = new Date().toISOString() }) {
	if (!ledger.hasSchema(db) || !ledger.hasTable(db, "audit_trail")) {
		throw new Refusal("the database has no automatic-invoice or audit_trail tables (start the app on it once first)");
	}
	const go = () => {
		const stop = ledger.getSendStop(db);
		const unconfirmed = unconfirmedSends(db);
		if (!stop) return { dryRun, stopped: false, changed: false, unconfirmed };
		if (unconfirmed > 0) throw new Refusal(`${unconfirmed} send(s) not confirmed in Sent Mail: check each one (the load's Try again searches Sent Mail again) before resuming`);
		if (!dryRun) {
			ledger.clearSendStop(db);
			ledger.clearHeldLoads(db);
			db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
				.run(nowIso, ACTOR.id, ACTOR.username, ACTOR.role, "auto_invoice_send_resumed", "auto_invoice", "send", `cleared the stop of ${stop.at} (${stop.reason || "no reason"})`);
		}
		return { dryRun, stopped: true, stoppedAt: stop.at, reason: stop.reason, changed: true, unconfirmed };
	};
	return dryRun ? db.transaction(go).deferred() : db.transaction(go).immediate();
}

function textOf(r) {
	if (!r.stopped) return `${r.dryRun ? "DRY RUN (nothing written)" : "APPLIED"}: automatic sending is not stopped; nothing to do`;
	return [
		`${r.dryRun ? "DRY RUN (nothing written)" : "APPLIED"}: automatic sending ${r.dryRun ? "would be resumed" : "resumed"}`,
		`  stopped at: ${r.stoppedAt}`,
		`  reason: ${r.reason || "none recorded"}`,
		`  unconfirmed sends: ${r.unconfirmed}`,
	].join("\n");
}

function main(argv) {
	try {
		const args = parseArgs(argv);
		const dbPath = path.resolve(args.db);
		if (!fs.existsSync(dbPath)) throw new Refusal("--db names no file");
		const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
		const dryRun = Boolean(args["dry-run"]);
		const db = new Database(dbPath, dryRun ? { readonly: true, fileMustExist: true } : { fileMustExist: true });
		try {
			if (!dryRun) db.pragma("busy_timeout = 5000");
			const result = run({ db, dryRun });
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

module.exports = { run, parseArgs, textOf, main, Refusal, ACTOR };
