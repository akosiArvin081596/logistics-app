#!/usr/bin/env node
/**
 * rename-job-details-output-column.js — retire the stale `output` header on the
 * **Job Details** tab, in place, preserving all 151 stored values.
 *
 * WHY RENAME AND NOT DELETE
 * -------------------------
 * Column `output` holds raw JSON written by the n8n `AI Agent` node, which is
 * now deleted. Production Job Details is 163 data rows: **151 `output`-only
 * rows + 12 real drag-and-drop rows, with ZERO overlap** (measured read-only,
 * 2026-08-09) — a clean partition, so the junk cannot be separated by row
 * without a non-contiguous, index-shifting delete of 151 interleaved rows.
 * Renaming instead:
 *   * preserves the 151 values for audit (they are the only record of what the
 *     retired LLM answered, and `scripts/measure-load-distance-accuracy.js`
 *     still measures them);
 *   * keeps `upsertByKey()` intact — it resolves every column by header NAME on
 *     a fresh read, so a renamed column is simply one it no longer matches;
 *   * leaves a tripwire: if the retired node is ever restored, its
 *     `autoMapInputData` will find no `output` column and the regression is
 *     visible rather than silent.
 *
 * WHY IT IS SAFE TO DO NOW (this precondition did NOT hold before 2026-08-09)
 * --------------------------------------------------------------------------
 * `POST /api/n8n/load-distance` replaced the `AI Agent` and returns a FLAT body
 * whose top-level keys are exactly the Job Details column names — it contains
 * no `output` key at all. So nothing writes this column any more. (Renaming it
 * while the old node still ran would have been harmless too; DELETING it would
 * not — with no matching column, `autoMapInputData` appends an empty row per
 * load, converting junk cells into junk rows.)
 *
 * ⚠️⚠️ THE DECOY: `Job Tracking` ALSO HAS A COLUMN NAMED `output`
 * ---------------------------------------------------------------
 * Job Tracking column **Z** (position 26, 421 rows, all empty) is named
 * `output` too. It is NOT the target. Renaming it breaks four test fixtures
 * (scripts/test-status-override-guard.js, test-dispatch-period-guard.js,
 * test-load-row-binding.js, test-put-load-guard.js) and invalidates the
 * `sheetRowToObject` comment in server.js. This script therefore hardcodes the
 * tab, asserts the header layout before writing, and refuses anything else.
 *
 * SAFETY
 * ------
 *   * The spreadsheet id is a REQUIRED argument — there is no default, so a
 *     bare run cannot fall through to production the way `server.js` does.
 *   * Production is refused outright unless --i-really-mean-production is
 *     passed as well. The override IS the safety.
 *   * Read-only by default. Nothing is written without --apply.
 *   * Pre-flight assertions (tab name, column count, column index, current
 *     header text) all must pass, or it aborts before touching anything.
 *   * It writes ONE cell: `Job Details!T1`. It never touches T2:T (the data).
 *
 * USAGE
 *   node scripts/rename-job-details-output-column.js <spreadsheetId>            # dry run
 *   node scripts/rename-job-details-output-column.js <spreadsheetId> --apply
 *   node scripts/rename-job-details-output-column.js <prodId> --apply --i-really-mean-production
 *   ... --revert            # put the header back to `output`
 */

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const PRODUCTION_SHEET_ID = "1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo";
const TAB = "Job Details";
const EXPECTED_COLUMNS = 20;      // Job Details is A..T
const TARGET_INDEX = 19;          // 0-based -> column T, the LAST column
const TARGET_CELL = "T1";
const OLD_HEADER = "output";
const NEW_HEADER = "output (retired 2026-08-09 — n8n AI Agent, do not reuse)";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const SHEET_ID = argv.find((a) => !a.startsWith("--"));
const APPLY = has("--apply");
const REVERT = has("--revert");
const ALLOW_PROD = has("--i-really-mean-production");

const desired = REVERT ? OLD_HEADER : NEW_HEADER;
const undesired = REVERT ? NEW_HEADER : OLD_HEADER;

function die(msg) { console.error(`ABORT: ${msg}`); process.exit(1); }

if (!SHEET_ID) die("spreadsheet id is required (there is deliberately no default)");
if (SHEET_ID === PRODUCTION_SHEET_ID && !ALLOW_PROD) {
	die(
		"that is the PRODUCTION spreadsheet. Re-run with --i-really-mean-production " +
		"if the owner has explicitly approved this write."
	);
}

(async () => {
	const keyFile = process.env.SERVICE_ACCOUNT_KEY || path.join(__dirname, "..", "service-account-key.json");
	if (!fs.existsSync(keyFile)) die(`service account key not found at ${keyFile}`);

	// Read-only scope unless we actually intend to write — so a dry run cannot
	// write even if the code below were wrong.
	const scopes = APPLY
		? ["https://www.googleapis.com/auth/spreadsheets"]
		: ["https://www.googleapis.com/auth/spreadsheets.readonly"];
	const auth = new google.auth.GoogleAuth({ keyFile, scopes });
	const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

	const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
	console.log(`spreadsheet : ${meta.data.properties.title}`);
	console.log(`id          : ${SHEET_ID}${SHEET_ID === PRODUCTION_SHEET_ID ? "  ** PRODUCTION **" : ""}`);

	if (!meta.data.sheets.some((s) => s.properties.title === TAB)) die(`no "${TAB}" tab on this spreadsheet`);

	const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A1:ZZ1` });
	const headers = (resp.data.values || [])[0] || [];

	// ---- pre-flight assertions -------------------------------------------
	if (headers.length !== EXPECTED_COLUMNS) {
		die(`expected ${EXPECTED_COLUMNS} columns on "${TAB}", found ${headers.length}: ${JSON.stringify(headers)}`);
	}
	const current = String(headers[TARGET_INDEX] ?? "");
	console.log(`target cell : ${TAB}!${TARGET_CELL} (column ${TARGET_INDEX + 1} of ${headers.length}, the last)`);
	console.log(`current     : ${JSON.stringify(current)}`);
	console.log(`desired     : ${JSON.stringify(desired)}`);

	if (current === desired) {
		console.log("\nNo change needed — header is already what was asked for. (idempotent)");
		return;
	}
	if (current !== undesired) {
		die(
			`${TAB}!${TARGET_CELL} is ${JSON.stringify(current)}, expected ${JSON.stringify(undesired)}. ` +
			"Refusing to overwrite a header this script did not expect."
		);
	}
	// Guard the decoy from the other direction: nothing about this run may touch Job Tracking.
	if (TAB !== "Job Details") die("tab guard failed");

	// How much data is riding on this column (renaming must not disturb it).
	const dataResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!T2:T` });
	const filled = (dataResp.data.values || []).filter((r) => String(r[0] ?? "").trim() !== "").length;
	console.log(`values below: ${filled} non-empty cells in ${TAB}!T2:T (these are NOT touched)`);

	if (!APPLY) {
		console.log("\nDRY RUN — nothing written. Re-run with --apply to write the single cell above.");
		return;
	}

	await sheets.spreadsheets.values.update({
		spreadsheetId: SHEET_ID,
		range: `${TAB}!${TARGET_CELL}`,
		valueInputOption: "RAW", // a header is literal text, never a formula
		requestBody: { values: [[desired]] },
	});

	// ---- post-flight verification ----------------------------------------
	const after = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A1:ZZ1` });
	const nowHeaders = (after.data.values || [])[0] || [];
	const afterData = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!T2:T` });
	const filledAfter = (afterData.data.values || []).filter((r) => String(r[0] ?? "").trim() !== "").length;

	console.log(`\nWROTE ${TAB}!${TARGET_CELL}`);
	console.log(`  header now : ${JSON.stringify(nowHeaders[TARGET_INDEX])}`);
	console.log(`  columns    : ${nowHeaders.length} (was ${headers.length})`);
	console.log(`  data cells : ${filledAfter} (was ${filled})`);
	if (nowHeaders.length !== EXPECTED_COLUMNS) die("column count changed — investigate immediately");
	if (filledAfter !== filled) die("data cell count changed — investigate immediately");
	console.log("  verified   : column count and data unchanged.");
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
