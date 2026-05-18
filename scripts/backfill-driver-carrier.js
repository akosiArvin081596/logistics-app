#!/usr/bin/env node
/**
 * Backfill drivers_directory.carrier_name from trucks.assigned_driver +
 * trucks.owner_id -> users.company_name.
 *
 * Path 2 of getInvestorDriverSet (server.js:678-685) joins drivers_directory
 * by carrier_name -> users.company_name. Production has empty carrier_name
 * for every investor-linked driver, so that safety net never fires. This
 * script seeds the carrier_name only when currently empty — never overwrites.
 *
 * Usage:   node scripts/backfill-driver-carrier.js
 *   --dry  Print the SQL that would run, change nothing
 *
 * Idempotent. Safe to re-run.
 */

const path = require("path");
const Database = require("better-sqlite3");

const DRY = process.argv.includes("--dry");
const dbPath = path.join(__dirname, "..", "app.db");
const db = new Database(dbPath);

const rows = db.prepare(`
	SELECT t.id           AS truck_id,
	       t.unit_number  AS unit_number,
	       t.assigned_driver AS driver_name,
	       u.company_name AS carrier_name,
	       dd.id          AS dd_id,
	       dd.carrier_name AS dd_current_carrier
	FROM trucks t
	JOIN users u ON u.id = t.owner_id AND u.role = 'Investor'
	LEFT JOIN drivers_directory dd ON LOWER(dd.driver_name) = LOWER(t.assigned_driver)
	WHERE t.owner_id > 0
	  AND t.assigned_driver IS NOT NULL
	  AND TRIM(t.assigned_driver) != ''
`).all();

let updates = 0;
let skipped = 0;
let missing = 0;

const update = db.prepare("UPDATE drivers_directory SET carrier_name = ? WHERE id = ? AND (carrier_name IS NULL OR carrier_name = '')");

for (const r of rows) {
	if (!r.dd_id) {
		console.log(`[MISS] truck ${r.unit_number} driver "${r.driver_name}" has no drivers_directory row — skipping`);
		missing++;
		continue;
	}
	const current = (r.dd_current_carrier || "").trim();
	const target = (r.carrier_name || "").trim();
	if (!target) {
		console.log(`[SKIP] truck ${r.unit_number} owner.company_name is empty`);
		skipped++;
		continue;
	}
	if (current) {
		console.log(`[KEEP] driver "${r.driver_name}" already has carrier "${current}" — leaving alone (target was "${target}")`);
		skipped++;
		continue;
	}
	if (DRY) {
		console.log(`[DRY]  would set drivers_directory.id=${r.dd_id} ("${r.driver_name}").carrier_name = "${target}"`);
	} else {
		const info = update.run(target, r.dd_id);
		if (info.changes) {
			console.log(`[OK]   set drivers_directory.id=${r.dd_id} ("${r.driver_name}").carrier_name = "${target}"`);
			updates++;
		}
	}
}

console.log("");
console.log(`Done. updates=${updates} skipped=${skipped} missing=${missing}${DRY ? " (DRY RUN)" : ""}`);
