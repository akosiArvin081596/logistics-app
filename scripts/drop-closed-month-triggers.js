#!/usr/bin/env node
/**
 * Drop the closed-month triggers from an app.db. Only for running OLDER code on
 * this database.
 *
 * The server installs these triggers at every boot (installPeriodLockTriggers()
 * in server.js). They live in the database file, so a rollback or a deploy of a
 * commit from before they existed leaves them in place, and that older code
 * writes into closed months in ways they refuse: its reconcile late-stamps a row
 * into a closed month (the payouts screens then answer 500), its month close
 * locks before it stamps (the stamp is refused, every pass), and its adjust route
 * accepts a closed month (500). Drop them right after such a rollback. Deploying
 * the current code again reinstalls them at boot.
 *
 * Dry run by default: prints the triggers present and changes nothing.
 * Idempotent: a trigger that is not there is skipped.
 *
 *   node scripts/drop-closed-month-triggers.js --db=/var/www/logistics-app/app.db          # dry run
 *   node scripts/drop-closed-month-triggers.js --db=/var/www/logistics-app/app.db --apply  # drops
 *
 * No --db means ./app.db beside this checkout.
 */
"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const TRIGGERS = [
	"investor_payouts_locked_insert",
	"investor_payouts_locked_update",
	"investor_payouts_locked_delete",
	"financials_ledger_items_locked_insert",
	"financials_ledger_items_locked_update",
	"financials_ledger_items_locked_delete",
];

const apply = process.argv.includes("--apply");
const dbArg = process.argv.find((a) => a.startsWith("--db="));
const dbPath = dbArg ? dbArg.slice("--db=".length) : path.join(__dirname, "..", "app.db");

const db = new Database(dbPath, { fileMustExist: true });
const present = db.prepare(
	`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${TRIGGERS.map(() => "?").join(",")}) ORDER BY name`
).all(...TRIGGERS).map((r) => r.name);

console.log(`${dbPath}: ${present.length} of ${TRIGGERS.length} closed-month trigger(s) present${present.length ? `: ${present.join(", ")}` : ""}`);
if (!apply) {
	console.log(present.length ? "Dry run: nothing dropped. Re-run with --apply to drop them." : "Nothing to drop.");
	process.exit(0);
}
db.transaction(() => { for (const name of present) db.exec(`DROP TRIGGER IF EXISTS ${name}`); })();
const left = db.prepare(
	`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${TRIGGERS.map(() => "?").join(",")})`
).get(...TRIGGERS).n;
console.log(`Dropped ${present.length}; ${left} left.`);
process.exit(left ? 1 : 0);
