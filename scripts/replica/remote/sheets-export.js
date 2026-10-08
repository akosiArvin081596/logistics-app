#!/usr/bin/env node
// replica:pull, on the server, step 2c: every tab of the spreadsheets the app
// reads (the Dispatch Management sheet and the read-only archive), READ-ONLY,
// as the replica's Google Sheets working copy (lib/replica-sheets.js).
//
//   node sheets-export.js --app=<app dir> --out=/root/logisx-replica-tmp/<stamp>/sheets.json
//
// It signs in with its own client, scoped to spreadsheets.readonly, using the
// service-account key already on the server (<app dir>/service-account-key.json);
// the key is read here and never leaves the server. The spreadsheet IDs are the
// ones the running app uses: SPREADSHEET_ID / ARCHIVE_SPREADSHEET_ID from
// <app dir>/.env, else the defaults in <app dir>/server.js.
//
// Per spreadsheet: its properties and every tab's properties (sheetId, title,
// index, grid size), every GRID tab's values as Google displays them
// (FORMATTED_VALUE, what the app reads by default) and each formula (FORMULA
// render, which one app read asks for). Prints tab and row counts only.
"use strict";

const fs = require("fs");
const path = require("path");

const FORMAT = 1;

function arg(name) {
	const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : undefined;
}

// The ID the app resolves: the .env value, else production's own default. The
// main sheet's default is lib/sheet-id.js's PRODUCTION_SPREADSHEET_ID (an older
// server.js carried it as a literal); the archive's is still in server.js.
function spreadsheetIds(appDir, dotenv) {
	const envFile = path.join(appDir, ".env");
	const env = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
	const src = fs.readFileSync(path.join(appDir, "server.js"), "utf8");
	const libFile = path.join(appDir, "lib", "sheet-id.js");
	const lib = fs.existsSync(libFile) ? fs.readFileSync(libFile, "utf8") : "";
	const fallback = (name) => {
		const m = src.match(new RegExp(`const ${name} = process\\.env\\.${name} \\|\\| "([A-Za-z0-9_-]+)"`));
		if (m) return m[1];
		const l = name === "SPREADSHEET_ID" ? lib.match(/^const PRODUCTION_SPREADSHEET_ID = "([A-Za-z0-9_-]+)";$/m) : null;
		return l ? l[1] : "";
	};
	const ids = {
		main: (env.SPREADSHEET_ID || "").trim() || fallback("SPREADSHEET_ID"),
		archive: (env.ARCHIVE_SPREADSHEET_ID || "").trim() || fallback("ARCHIVE_SPREADSHEET_ID"),
	};
	if (!ids.main) throw new Error("could not resolve the app's SPREADSHEET_ID");
	return ids;
}

const quote = (title) => `'${String(title).replace(/'/g, "''")}'`;

async function exportSpreadsheet(sheets, spreadsheetId, role) {
	const meta = await sheets.spreadsheets.get({
		spreadsheetId,
		fields: "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,sheetType,gridProperties))",
	});
	const tabs = meta.data.sheets.map((s) => ({ properties: s.properties }));
	const grid = tabs.filter((t) => (t.properties.sheetType || "GRID") === "GRID");
	const ranges = grid.map((t) => quote(t.properties.title));
	const [shown, formulas] = ranges.length ? await Promise.all([
		sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges, valueRenderOption: "FORMATTED_VALUE" }),
		sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges, valueRenderOption: "FORMULA" }),
	]) : [{ data: { valueRanges: [] } }, { data: { valueRanges: [] } }];
	let rows = 0;
	grid.forEach((t, i) => {
		t.values = (shown.data.valueRanges[i] && shown.data.valueRanges[i].values) || [];
		const f = (formulas.data.valueRanges[i] && formulas.data.valueRanges[i].values) || [];
		t.formulas = {};
		f.forEach((row, r) => (row || []).forEach((cell, c) => {
			if (typeof cell === "string" && cell.startsWith("=")) t.formulas[`${r}:${c}`] = cell;
		}));
		rows += t.values.length;
	});
	return {
		book: { role, properties: meta.data.properties || {}, sheets: tabs },
		summary: { role, tabs: tabs.length, gridTabs: grid.length, rows },
	};
}

async function main() {
	const appDir = arg("app");
	const out = arg("out");
	if (!appDir || !out) throw new Error("usage: sheets-export.js --app=<app dir> --out=<sheets.json>");
	const req = (m) => require(path.join(appDir, "node_modules", m));
	const dotenv = req("dotenv");
	const { google } = req("googleapis");
	const ids = spreadsheetIds(appDir, dotenv);
	const auth = new google.auth.GoogleAuth({
		keyFile: path.join(appDir, "service-account-key.json"),
		scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
	});
	const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
	const doc = { format: FORMAT, exportedAt: new Date().toISOString(), spreadsheets: {} };
	const summaries = [];
	for (const [role, id] of Object.entries(ids)) {
		if (!id) continue;
		try {
			const { book, summary } = await exportSpreadsheet(sheets, id, role);
			doc.spreadsheets[id] = book;
			summaries.push(summary);
		} catch (err) {
			// The main sheet is required; the archive is copied when it can be
			// read (the replica answers it as not found otherwise).
			if (role === "main") throw err;
			summaries.push({ role, error: String((err && err.message) || err).slice(0, 200) });
		}
	}
	fs.writeFileSync(out, JSON.stringify(doc), { mode: 0o600, flag: "wx" });
	console.log(JSON.stringify({ step: "sheets", spreadsheets: summaries }));
}

if (require.main === module) {
	main().catch((err) => {
		console.error(`sheets-export: ${err.message}`);
		process.exit(1);
	});
}

module.exports = { spreadsheetIds, exportSpreadsheet, FORMAT };
