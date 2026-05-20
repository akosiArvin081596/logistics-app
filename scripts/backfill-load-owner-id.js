#!/usr/bin/env node
/**
 * One-off backfill: stamp the Job Tracking "Owner ID" column for rows that
 * are missing it (empty cell or literal "0"). For each such row we look up
 * the driver in trucks.assigned_driver, falling back to active
 * truck_assignments, and write the matched truck's owner_id back into the
 * sheet — but only when owner_id is non-zero (a truly company-truck load
 * stays at 0).
 *
 * This cleans up rows poisoned by two prior bugs:
 *   - /api/dispatch stamped 0 whenever the driver→truck lookup missed,
 *     even though the driver did belong to an investor's truck.
 *   - /api/dispatch/reassign never touched Owner ID at all, so loads moved
 *     between drivers kept the original assignment's value.
 *
 * Usage (on the VPS):
 *   cd /var/www/logistics-app && node scripts/backfill-load-owner-id.js
 *
 * Idempotent — safe to run repeatedly. Reads the same service-account-key.json
 * and SPREADSHEET_ID that server.js uses.
 */

const path = require("path");
const Database = require("better-sqlite3");
const { google } = require("googleapis");

const SPREADSHEET_ID = "1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo";
const SHEET_NAME = "Job Tracking";
const KEY_FILE = path.resolve(__dirname, "..", "service-account-key.json");
const DB_PATH = path.resolve(__dirname, "..", "app.db");

function colLetter(idx) {
	let result = "";
	let n = idx;
	while (n >= 0) {
		result = String.fromCharCode(65 + (n % 26)) + result;
		n = Math.floor(n / 26) - 1;
	}
	return result;
}

async function main() {
	const db = new Database(DB_PATH, { readonly: true });

	const auth = new google.auth.GoogleAuth({
		keyFile: KEY_FILE,
		scopes: ["https://www.googleapis.com/auth/spreadsheets"],
	});
	const authClient = await auth.getClient();
	const sheets = google.sheets({ version: "v4", auth: authClient });

	// Pull the whole Job Tracking tab in one shot.
	const resp = await sheets.spreadsheets.values.get({
		spreadsheetId: SPREADSHEET_ID,
		range: `${SHEET_NAME}!A:ZZ`,
	});
	const rows = resp.data.values || [];
	if (rows.length < 2) {
		console.log("No data rows in Job Tracking. Nothing to do.");
		return;
	}
	const headers = rows[0];
	const driverColIdx = headers.findIndex(h => /^driver$/i.test(h));
	const ownerColIdx = headers.findIndex(h => /^owner.?id$/i.test(h));
	if (driverColIdx === -1) {
		console.error(`No "Driver" column found in ${SHEET_NAME}. Aborting.`);
		process.exit(1);
	}
	if (ownerColIdx === -1) {
		console.error(`No "Owner ID" column found in ${SHEET_NAME}. Aborting (let /api/dispatch create it first, then re-run).`);
		process.exit(1);
	}
	const loadIdColIdx = headers.findIndex(h => /load.?id|job.?id/i.test(h));

	const findByAssigned = db.prepare(
		"SELECT unit_number, owner_id FROM trucks WHERE LOWER(assigned_driver) = LOWER(?)"
	);
	const findByActiveAssignment = db.prepare(
		"SELECT t.unit_number AS unit_number, t.owner_id AS owner_id " +
		"FROM truck_assignments ta JOIN trucks t ON t.id = ta.truck_id " +
		"WHERE LOWER(ta.driver_name) = LOWER(?) AND ta.end_date = '' " +
		"ORDER BY ta.start_date DESC LIMIT 1"
	);

	const updates = [];
	let scanned = 0;
	let alreadyStamped = 0;
	let noDriver = 0;
	let noMatch = 0;
	let skippedCompanyTruck = 0;

	for (let i = 1; i < rows.length; i++) {
		scanned++;
		const row = rows[i];
		const rowIndex = i + 1; // 1-based sheet row
		const driver = (row[driverColIdx] || "").trim();
		const rawOwner = row[ownerColIdx];
		const ownerStr = (rawOwner === undefined || rawOwner === null) ? "" : String(rawOwner).trim();
		const needsStamp = ownerStr === "" || ownerStr === "0";
		if (!needsStamp) { alreadyStamped++; continue; }
		if (!driver) { noDriver++; continue; }

		let truck = findByAssigned.get(driver);
		if (!truck) truck = findByActiveAssignment.get(driver);
		if (!truck) { noMatch++; continue; }
		if (!truck.owner_id || parseInt(truck.owner_id) === 0) { skippedCompanyTruck++; continue; }

		updates.push({
			range: `${SHEET_NAME}!${colLetter(ownerColIdx)}${rowIndex}`,
			values: [[String(truck.owner_id)]],
			_loadId: loadIdColIdx !== -1 ? (row[loadIdColIdx] || "").trim() : "",
			_driver: driver,
			_truck: truck.unit_number,
			_owner: truck.owner_id,
		});
	}

	console.log("Plan:");
	updates.slice(0, 25).forEach(u => {
		console.log(`  ${u.range}  load=${u._loadId || "(no id)"}  driver=${u._driver}  → owner_id=${u._owner} (truck ${u._truck})`);
	});
	if (updates.length > 25) console.log(`  ... and ${updates.length - 25} more`);
	console.log("");
	console.log(`Summary: scanned=${scanned} updates=${updates.length} already_stamped=${alreadyStamped} no_driver=${noDriver} no_match=${noMatch} skipped_company_truck=${skippedCompanyTruck}`);

	const dryRun = process.argv.includes("--dry-run");
	if (dryRun) {
		console.log("\n--dry-run: not writing to the sheet.");
		return;
	}
	if (updates.length === 0) {
		console.log("Nothing to update. Done.");
		return;
	}

	console.log(`\nWriting ${updates.length} cells to ${SHEET_NAME}...`);
	const payload = updates.map(({ range, values }) => ({ range, values }));
	const writeResp = await sheets.spreadsheets.values.batchUpdate({
		spreadsheetId: SPREADSHEET_ID,
		requestBody: { valueInputOption: "USER_ENTERED", data: payload },
	});
	console.log(`Done. totalUpdatedCells=${writeResp.data.totalUpdatedCells}`);
}

main().catch(err => {
	console.error("backfill-load-owner-id failed:", err);
	process.exit(1);
});
