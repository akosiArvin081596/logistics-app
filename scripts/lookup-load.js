// One-shot: print the row for a given load ID from a Job Tracking sheet.
// Usage: SPREADSHEET_ID=<sheet> node scripts/lookup-load.js <loadId>

const path = require("path");
const { google } = require("googleapis");

// The sheet is always named (lib/sheet-id.js): there is no default, so a run
// never reaches the production sheet unless the command says so.
const TARGET = require("../lib/sheet-id").scriptSpreadsheetId(process.env, { script: "lookup-load.js" });
if (!TARGET.id) {
	console.error(TARGET.error);
	process.exit(2);
}
const SPREADSHEET_ID = TARGET.id;
const SHEET = "Job Tracking";

async function getSheets() {
	const auth = new google.auth.GoogleAuth({
		keyFile: path.join(__dirname, "..", "service-account-key.json"),
		scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
	});
	const client = await auth.getClient();
	return google.sheets({ version: "v4", auth: client });
}

(async () => {
	const loadId = process.argv[2];
	if (!loadId) {
		console.error("Usage: node scripts/lookup-load.js <loadId>");
		process.exit(1);
	}

	const sheets = await getSheets();
	const res = await sheets.spreadsheets.values.get({
		spreadsheetId: SPREADSHEET_ID,
		range: `${SHEET}!A1:ZZ`,
	});
	const [headers, ...rows] = res.data.values || [];
	if (!headers) {
		console.error("No headers in sheet");
		process.exit(2);
	}

	// Find the load_id column
	const loadIdCol = headers.findIndex((h) => /load.?id|job.?id/i.test(h));
	if (loadIdCol < 0) {
		console.error("No load_id column found. Headers:", headers);
		process.exit(3);
	}

	const matches = [];
	rows.forEach((row, i) => {
		if (String(row[loadIdCol] || "").trim() === String(loadId).trim()) {
			matches.push({ rowIndex: i + 2, row });
		}
	});

	if (matches.length === 0) {
		console.log(`No row found for load ID ${loadId} in "${SHEET}"`);
		process.exit(0);
	}

	console.log(`Found ${matches.length} row(s) for load ${loadId}:\n`);
	for (const m of matches) {
		console.log(`--- Sheet row ${m.rowIndex} ---`);
		headers.forEach((h, i) => {
			const v = m.row[i];
			if (v !== undefined && v !== "") console.log(`  ${h}: ${v}`);
		});
		console.log("");
	}
})().catch((e) => {
	console.error("Error:", e.message);
	process.exit(99);
});
