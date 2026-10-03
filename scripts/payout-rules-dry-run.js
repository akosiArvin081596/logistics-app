#!/usr/bin/env node
// scripts/payout-rules-dry-run.js — the 2026-10 payout rules' dry run (GET
// /api/admin/payout-rules/dry-run), run on the server with no login. It runs
// payoutRulesDryRun() lifted from this checkout's server.js
// (scripts/lib/ledger-world.js) on a read-only handle of app.db, so it computes
// exactly what the endpoint would and writes nothing.
//
// It prints every open-month payout the rules would change (against every rule
// off), by how much and by which rule, and each load datedAttribution would move
// between owners. Investors are named by owner id; --names adds their names.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/payout-rules-dry-run.js --db=app.db --sheet-id=<id> [--key=service-account-key.json] [--names]
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      read the flags from this file, not the app directory's .env
// There is no default sheet. Exit codes: 0 done, 1 error.

"use strict";

const path = require("path");
const { buildLedgerWorld, parseArgs, sheetFor } = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.db) throw new Error("--db is required");
	const sheetData = await sheetFor(args, ROOT);
	const { db, api } = buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile: args["env-file"] || null });
	const result = await api.payoutRulesDryRun();
	if (args.names !== true) {
		for (const c of result.changes) delete c.investor;
		for (const m of result.movedLoads) delete m.driver;
	}
	console.log(JSON.stringify({ ...result, summary: { changes: result.changes.length, movedLoads: result.movedLoads.length } }, null, 1));
	db.close();
}

main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
