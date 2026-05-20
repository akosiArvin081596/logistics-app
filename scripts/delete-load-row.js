// One-shot: delete a sheet row by row index, but only after confirming
// the row's Load ID matches the expected value. Refuses to proceed on
// mismatch (defensive — if rows shifted, we don't want to nuke the wrong job).
//
// Usage: node scripts/delete-load-row.js <rowIndex> <expectedLoadId>

const path = require("path");
const { google } = require("googleapis");

const SPREADSHEET_ID = "1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo";
const SHEET = "Job Tracking";

async function getSheets() {
	const auth = new google.auth.GoogleAuth({
		keyFile: path.join(__dirname, "..", "service-account-key.json"),
		scopes: ["https://www.googleapis.com/auth/spreadsheets"],
	});
	const client = await auth.getClient();
	return google.sheets({ version: "v4", auth: client });
}

(async () => {
	const rowIndex = parseInt(process.argv[2], 10);
	const expectedLoadId = process.argv[3];
	if (!rowIndex || !expectedLoadId) {
		console.error("Usage: node scripts/delete-load-row.js <rowIndex> <expectedLoadId>");
		process.exit(1);
	}

	const sheets = await getSheets();

	// 1. Read headers + the target row to confirm load ID
	const read = await sheets.spreadsheets.values.get({
		spreadsheetId: SPREADSHEET_ID,
		range: `${SHEET}!A1:ZZ${rowIndex}`,
	});
	const all = read.data.values || [];
	const headers = all[0];
	const targetRow = all[rowIndex - 1];
	if (!targetRow) {
		console.error(`Row ${rowIndex} not found.`);
		process.exit(2);
	}
	const loadIdCol = headers.findIndex((h) => /load.?id|job.?id/i.test(h));
	const actualLoadId = String(targetRow[loadIdCol] || "").trim();
	if (actualLoadId !== String(expectedLoadId).trim()) {
		console.error(`Mismatch! Row ${rowIndex} has Load ID "${actualLoadId}", expected "${expectedLoadId}". Refusing to delete.`);
		process.exit(3);
	}
	console.log(`Confirmed: row ${rowIndex} has Load ID ${actualLoadId}. Proceeding with delete.`);

	// 2. Look up sheet (tab) ID for batchUpdate
	const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
	const sheet = meta.data.sheets.find((s) => s.properties.title === SHEET);
	if (!sheet) {
		console.error(`Sheet "${SHEET}" not found in spreadsheet.`);
		process.exit(4);
	}
	const sheetId = sheet.properties.sheetId;

	// 3. Delete the row (deleteDimension uses 0-indexed half-open range)
	await sheets.spreadsheets.batchUpdate({
		spreadsheetId: SPREADSHEET_ID,
		requestBody: {
			requests: [
				{
					deleteDimension: {
						range: {
							sheetId,
							dimension: "ROWS",
							startIndex: rowIndex - 1,
							endIndex: rowIndex,
						},
					},
				},
			],
		},
	});
	console.log(`Deleted row ${rowIndex} from "${SHEET}".`);
})().catch((e) => {
	console.error("Error:", e.message);
	process.exit(99);
});
