#!/usr/bin/env node
/**
 * Backfill carrier_driver_history from truck_assignments + trucks.owner_id ->
 * users.company_name. Carrier_driver_history is path 3 of getInvestorDriverSet
 * (server.js:687-692); production has it empty for every investor, so the
 * resolver only has trucks.assigned_driver as a single point of truth.
 *
 * This script creates one history row per (driver_name, carrier_name) pairing
 * that exists in truck_assignments but is missing from carrier_driver_history.
 * Open rows (no ended_at) are created for currently-active assignments;
 * closed rows mirror the end_date from truck_assignments.
 *
 * Usage:   node scripts/backfill-driver-history.js
 *   --dry  Print what would happen, change nothing
 *
 * Idempotent. Safe to re-run.
 */

const path = require("path");
const Database = require("better-sqlite3");

const DRY = process.argv.includes("--dry");
const dbPath = path.join(__dirname, "..", "app.db");
const db = new Database(dbPath);

const assignments = db.prepare(`
	SELECT ta.driver_name    AS driver_name,
	       ta.start_date     AS start_date,
	       ta.end_date       AS end_date,
	       u.company_name    AS carrier_name
	FROM truck_assignments ta
	JOIN trucks t ON t.id = ta.truck_id
	JOIN users u ON u.id = t.owner_id AND u.role = 'Investor'
	WHERE t.owner_id > 0
	  AND ta.driver_name IS NOT NULL
	  AND TRIM(ta.driver_name) != ''
	ORDER BY ta.id ASC
`).all();

let inserted = 0;
let skipped = 0;

const findExact = db.prepare(`
	SELECT id FROM carrier_driver_history
	WHERE LOWER(driver_name) = LOWER(?)
	  AND LOWER(carrier_name) = LOWER(?)
	  AND COALESCE(started_at, '') = COALESCE(?, '')
`);

const insert = db.prepare(`
	INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at, ended_at)
	VALUES (?, ?, ?, ?)
`);

for (const a of assignments) {
	const driver = (a.driver_name || "").trim();
	const carrier = (a.carrier_name || "").trim();
	if (!driver || !carrier) {
		skipped++;
		continue;
	}
	const started = a.start_date || null;
	const ended = a.end_date && a.end_date.trim() ? a.end_date : null;
	const dupe = findExact.get(driver, carrier, started);
	if (dupe) {
		skipped++;
		continue;
	}
	if (DRY) {
		console.log(`[DRY]  would INSERT carrier_driver_history (${JSON.stringify(carrier)}, ${JSON.stringify(driver)}, started_at=${started}, ended_at=${ended})`);
	} else {
		insert.run(carrier, driver, started, ended);
		console.log(`[OK]   inserted ${JSON.stringify(carrier)} <- ${JSON.stringify(driver)} (${started || "no-start"}..${ended || "open"})`);
	}
	inserted++;
}

console.log("");
console.log(`Done. inserted=${inserted} skipped=${skipped}${DRY ? " (DRY RUN)" : ""}`);
