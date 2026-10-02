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
 * Closed months: a pairing that lies entirely inside closed months (every
 * month from its start to its end has a period_locks row with status 'locked')
 * is skipped. It could only change attribution in months that are final as
 * settled. The script refuses to write anything if period_locks cannot be read.
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

let lockedMonths;
try {
	lockedMonths = new Set(db.prepare("SELECT period FROM period_locks WHERE period_locks.status = 'locked'").all().map((r) => r.period));
} catch (e) {
	console.error(`period_locks could not be read (${e.message}); nothing was written.`);
	process.exit(2);
}
// Every month a pairing covers, from its start to its end (or to now when open).
function monthsCovered(start, end) {
	const first = String(start || "").slice(0, 7);
	const last = String(end || new Date().toISOString()).slice(0, 7);
	if (!/^\d{4}-\d{2}$/.test(first) || !/^\d{4}-\d{2}$/.test(last) || last < first) return null;
	const out = [];
	let [y, m] = first.split("-").map(Number);
	while (`${y}-${String(m).padStart(2, "0")}` <= last && out.length < 600) {
		out.push(`${y}-${String(m).padStart(2, "0")}`);
		m++;
		if (m > 12) { m = 1; y++; }
	}
	return out;
}

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
let skippedClosed = 0;

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
	// A pairing with no readable start covers open months too, so it is written.
	const covered = monthsCovered(started, ended);
	if (covered && covered.length && covered.every((mk) => lockedMonths.has(mk))) {
		console.log(`[SKIP] ${JSON.stringify(carrier)} <- ${JSON.stringify(driver)} (${started}..${ended}) lies entirely in closed months; they stay as settled`);
		skippedClosed++;
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
console.log(`Done. inserted=${inserted} skipped=${skipped} skipped_closed_months=${skippedClosed}${DRY ? " (DRY RUN)" : ""}`);
