#!/usr/bin/env node
/**
 * One-time data fix: return a driver's surplus "Dispatched" loads to the Job Board.
 *
 * Context: the "one load at a time" rule (enforced server-side as of this change)
 * means a driver can only ever hold a single active load. Howard predates the rule
 * with 3 assigned loads. This script returns every load currently in "Dispatched"
 * status for the target driver back to the Job Board — exactly reversing what
 * POST /api/dispatch writes (Driver, Status, Truck, Owner ID) so the row looks
 * untouched/unassigned again. Loads that have progressed past Dispatched
 * (Assigned, In Transit, etc.) are LEFT ALONE.
 *
 * Safe by default: prints what it WOULD change and exits. Pass --apply to write.
 *
 *   node scripts/return-howard-loads.js                 # dry run (read-only)
 *   node scripts/return-howard-loads.js --apply         # perform the revert
 *   node scripts/return-howard-loads.js "Howard" --apply # explicit driver name
 *
 * Writes directly to the production Dispatch Management sheet via the service
 * account, so it does NOT emit sockets — Howard's app drops the loads on its
 * next refresh/login. Run from the project root (service-account-key.json there).
 */

const path = require("path");
const { google } = require("googleapis");

const SPREADSHEET_ID = "1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"; // production Job Tracking
const SHEET = "Job Tracking";
const KEY_FILE = path.join(__dirname, "..", "service-account-key.json");

// Status we return to the board, and the value we write for "back on the board".
const REVERT_STATUS_RE = /^dispatched$/i;
const UNASSIGNED_STATUS = "Unassigned";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const TARGET_DRIVER = (args.find((a) => !a.startsWith("--")) || "Howard").trim();

function normalizeDriverName(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function colLetter(idx) {
  // 0-based column index -> A1 letter (0 -> A, 26 -> AA)
  let s = "";
  let n = idx + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: SHEET });
  const rows = resp.data.values || [];
  if (rows.length < 2) {
    console.error("No data rows found in", SHEET);
    process.exit(1);
  }

  const headers = rows[0];
  const driverCol = headers.findIndex((h) => /^driver$/i.test(h));
  const statusCol = headers.findIndex((h) => /status/i.test(h));
  const loadIdCol = headers.findIndex((h) => /load.?id|job.?id/i.test(h));
  const truckCol = headers.findIndex((h) => /^truck$/i.test(h));
  const ownerCol = headers.findIndex((h) => /^owner.?id$/i.test(h));

  if (driverCol === -1 || statusCol === -1) {
    console.error("Could not locate Driver and/or Status columns. Headers:", headers);
    process.exit(1);
  }

  const target = normalizeDriverName(TARGET_DRIVER);
  const mine = [];
  for (let i = 1; i < rows.length; i++) {
    if (normalizeDriverName(rows[i][driverCol]) === target) {
      mine.push({
        sheetRow: i + 1, // 1-based sheet row
        loadId: loadIdCol !== -1 ? rows[i][loadIdCol] || "" : "",
        status: (rows[i][statusCol] || "").trim(),
      });
    }
  }

  console.log(`\nDriver "${TARGET_DRIVER}" — ${mine.length} load(s) on ${SHEET}:`);
  if (mine.length === 0) {
    console.log("  (none) — nothing to do.");
    return;
  }
  for (const m of mine) {
    const tag = REVERT_STATUS_RE.test(m.status) ? "  <-- will return to Job Board" : "  (kept)";
    console.log(`  row ${m.sheetRow}  ${m.loadId || "(no id)"}  [${m.status || "blank"}]${tag}`);
  }

  const toRevert = mine.filter((m) => REVERT_STATUS_RE.test(m.status));
  if (toRevert.length === 0) {
    console.log(`\nNo "${UNASSIGNED_STATUS}"-bound loads (none in Dispatched). Nothing to change.`);
    return;
  }

  // Build the cell writes that reverse a dispatch: clear Driver, set Status to
  // Unassigned, and clear Truck + Owner ID (all four are what POST /api/dispatch sets).
  const data = [];
  for (const m of toRevert) {
    data.push({ range: `${SHEET}!${colLetter(driverCol)}${m.sheetRow}`, values: [[""]] });
    data.push({ range: `${SHEET}!${colLetter(statusCol)}${m.sheetRow}`, values: [[UNASSIGNED_STATUS]] });
    if (truckCol !== -1) data.push({ range: `${SHEET}!${colLetter(truckCol)}${m.sheetRow}`, values: [[""]] });
    if (ownerCol !== -1) data.push({ range: `${SHEET}!${colLetter(ownerCol)}${m.sheetRow}`, values: [[""]] });
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — would return ${toRevert.length} load(s) to the Job Board (${data.length} cell writes).`);
    console.log("Re-run with --apply to perform the change.");
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: "USER_ENTERED", data },
  });
  console.log(`\nDONE — returned ${toRevert.length} load(s) to the Job Board:`);
  for (const m of toRevert) console.log(`  ${m.loadId || "row " + m.sheetRow}  (was Dispatched -> Unassigned, driver cleared)`);
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
