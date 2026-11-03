#!/usr/bin/env node
// scripts/receipt-auto-approve-undo.js — the rollback for receipts auto-approve: moves
// back to Pending only the receipts the pass approved that nobody has touched since
// (lib/receipt-auto-approve-pass.js undoPlan(), six conditions). Ids and counts only.
//
// Usage: node scripts/receipt-auto-approve-undo.js --since=YYYY-MM-DD [--db=<path>] [--apply]
//   --since  approvals the pass made from that day (its stamp, UTC) on
//   --db     a copy outside the repository; without it, the app's own database
//            (scripts/lib/app-database.js resolveDatabase(), refused in replica mode)
// Dry run by default: the database is opened read-only and the script prints what it
// would change and what it would skip, by reason. --apply writes: per receipt a
// compare-and-set that re-checks the month and the Personal line inside its
// transaction, a system audit row by receipt-auto-approve-undo, and one summary row.
// Refused: when the month lock table can't be read; --apply while
// RECEIPT_AUTO_APPROVE_ENABLED is "true" in this environment, or while the database
// shows an on-mode pass within its last interval. A second run finds none.
// Exit codes: 0 done, 1 error, 2 refused.

"use strict";

const path = require("path");
const { parseArgs, openDb } = require("./lib/ledger-world");
const { resolveDatabase, DatabaseRefusal } = require("./lib/app-database");
const { liftServer, passDeps } = require("./lib/receipt-auto-approve-lift");
const passLib = require("../lib/receipt-auto-approve-pass");

const ROOT = path.join(__dirname, "..");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

class Refusal extends Error {}

function hasTable(db, name) {
	return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// { plan, result } for one run; throws Refusal for a refused one.
function undo(db, { since, apply, env = process.env, nowMs = Date.now() }) {
	const S = liftServer(db, { root: ROOT, env: {} });
	const deps = passDeps(db, S);
	if (!S.periodLocksReadable()) throw new Refusal("the month lock table can't be read, so no month can be confirmed open");
	if (!hasTable(db, "receipt_auto_reviews") || !hasTable(db, "receipt_auto_meta")) return { plan: [], result: null };
	if (apply) {
		const why = passLib.undoApplyRefusal(db, env, nowMs);
		if (why) throw new Refusal(why);
	}
	const plan = passLib.undoPlan(deps, { since });
	const result = apply ? passLib.undoApply(deps, plan, new Date(nowMs).toISOString()) : null;
	return { plan, result };
}

function print({ plan, result }, apply) {
	const would = plan.filter((p) => p.action === "undo").map((p) => p.id);
	const skipped = {};
	for (const p of plan.filter((x) => x.action === "skip")) (skipped[p.reason] = skipped[p.reason] || []).push(p.id);
	const out = [];
	out.push(apply ? `changed ${result.changed.length}: ${result.changed.join(",") || "none"}` : `would change ${would.length}: ${would.join(",") || "none"}`);
	for (const [reason, ids] of Object.entries(skipped)) out.push(`skipped ${reason} ${ids.length}: ${ids.join(",")}`);
	if (apply) for (const [reason, n] of Object.entries(result.skipped)) if (!skipped[reason]) out.push(`skipped at the write ${reason} ${n}`);
	if (!apply) out.push("dry run: nothing written (add --apply to write)");
	return out.join("\n");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const since = args.since && args.since !== true ? String(args.since) : "";
	if (!DAY_RE.test(since)) {
		console.error("REFUSED: --since=YYYY-MM-DD is required");
		process.exit(2);
	}
	const apply = args.apply === true;
	let target;
	try {
		target = resolveDatabase(args.db && args.db !== true ? String(args.db) : null, ROOT);
	} catch (e) {
		if (e instanceof DatabaseRefusal) {
			console.error(`REFUSED: ${e.message}`);
			process.exit(2);
		}
		throw e;
	}
	const db = openDb({ root: ROOT, dbFile: target.file, readonly: !apply });
	try {
		console.log(print(undo(db, { since, apply }), apply));
	} catch (e) {
		if (e instanceof Refusal) {
			console.error(`REFUSED: ${e.message}`);
			process.exitCode = 2;
			return;
		}
		throw e;
	} finally {
		db.close();
	}
}

if (require.main === module) {
	try {
		main();
	} catch (e) {
		console.error(`ERROR: ${e && e.message}`);
		process.exit(1);
	}
}

module.exports = { undo, print, Refusal };
