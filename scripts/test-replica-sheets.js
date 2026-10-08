#!/usr/bin/env node
// The replica's Google Sheets (lib/replica-sheets.js): the API surface the app
// uses, answered from a local working copy, reads and writes alike, and never
// Google.
//
//   §1 coverage: every spreadsheets.* / spreadsheets.values.* call server.js and
//      lib/ make, and every spreadsheets.batchUpdate request kind server.js
//      sends, is implemented (a new one fails here before it fails in a replica)
//   §2 reads: A1 ranges as the app writes them, Google's trimming, FORMULA render
//   §3 writes: update, batchUpdate, append, row deletes; each saved to the
//      working copy file and nowhere else; null skips a cell as the API does
//   §4 errors shaped like the API's (unknown spreadsheet, unknown tab), and a
//      batch refused whole: no request of a refused batch is applied
//   §5 isolation: no googleapis module is loaded and nothing but the file is written
//
// Standalone: node scripts/test-replica-sheets.js. No server, no network.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const loadedBefore = new Set(Object.keys(require.cache));
const fake = require(path.join(ROOT, "lib", "replica-sheets.js"));

let failures = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`  ok   ${name}`);
	else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

const MAIN = "main-sheet-id";
const ARCHIVE = "archive-sheet-id";
function workingCopy() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replica-sheets-"));
	const file = path.join(dir, "sheets.json");
	const tab = (sheetId, title, index, values, formulas = {}) => ({
		properties: { sheetId, title, index, sheetType: "GRID", gridProperties: { rowCount: 1000, columnCount: 26 } },
		values,
		formulas,
	});
	const doc = {
		format: 1,
		exportedAt: "2026-10-08T07:00:00.000Z",
		spreadsheets: {
			[MAIN]: {
				role: "main",
				properties: { title: "Dispatch (test)" },
				sheets: [
					tab(0, "Job Tracking", 0, [
						["Load ID", "Driver", "Status", "  Payment  "],
						["L1", "Avery Stone", "Delivered", "$1,500.00"],
						["L2", "Blake Rivers", "In Transit", "$900.00", "", ""],
						["L3", "", "Unassigned"],
					], { "1:3": "=1500" }),
					tab(7, "Carrier Database", 1, [["Driver Name", "Phone"], ["Avery Stone", "555-0100"]]),
				],
			},
			[ARCHIVE]: { role: "archive", properties: { title: "Archive (test)" }, sheets: [tab(3, "Job Tracking", 0, [["Load ID"], ["OLD1"]])] },
		},
	};
	fs.writeFileSync(file, JSON.stringify(doc));
	return { dir, file };
}
const onDisk = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

(async () => {
	// ---- §1 coverage -------------------------------------------------------
	console.log("§1 every call the app makes is implemented");
	const sources = [path.join(ROOT, "server.js"), ...fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js")).map((f) => path.join(ROOT, "lib", f))]
		.filter((f) => !/replica-/.test(path.basename(f)))
		.map((f) => fs.readFileSync(f, "utf8"))
		.join("\n");
	const used = new Set([...sources.matchAll(/\bspreadsheets\.((?:values\.)?[a-zA-Z]+)\(/g)].map((m) => m[1]));
	const { file: f0 } = workingCopy();
	const api = fake.createFakeSheets({ file: f0 });
	ok("the app makes some Sheets calls (the scan works)", used.size >= 6, [...used]);
	for (const name of used) {
		const parts = name.split(".");
		const fn = parts.length === 2 ? api.spreadsheets.values[parts[1]] : api.spreadsheets[parts[0]];
		ok(`spreadsheets.${name} is implemented`, typeof fn === "function");
	}
	const kinds = new Set([...sources.matchAll(/\b(deleteDimension|insertDimension|appendDimension|updateCells|repeatCell|addSheet|deleteSheet|updateSheetProperties|sortRange|insertRange|deleteRange|moveDimension|copyPaste|cutPaste|findReplace|setDataValidation|updateDimensionProperties|mergeCells|unmergeCells|autoResizeDimensions)\s*:/g)].map((m) => m[1]));
	ok("server.js sends deleteDimension (the scan works)", kinds.has("deleteDimension"), [...kinds]);
	for (const k of kinds) ok(`batchUpdate request ${k} is supported`, ["deleteDimension", "insertDimension"].includes(k));

	// ---- §2 reads ------------------------------------------------------------
	console.log("§2 reads");
	const { file, dir } = workingCopy();
	const s = fake.createFakeSheets({ file });
	const get = async (range, extra = {}) => (await s.spreadsheets.values.get({ spreadsheetId: MAIN, range, ...extra })).data;
	eq("a whole tab: rows as stored, trailing empty cells trimmed", (await get("Job Tracking")).values, [
		["Load ID", "Driver", "Status", "  Payment  "], ["L1", "Avery Stone", "Delivered", "$1,500.00"], ["L2", "Blake Rivers", "In Transit", "$900.00"], ["L3", "", "Unassigned"],
	]);
	eq("the header row (Job Tracking!1:1)", (await get("Job Tracking!1:1")).values, [["Load ID", "Driver", "Status", "  Payment  "]]);
	eq("one column (B:B)", (await get("Job Tracking!B:B")).values, [["Driver"], ["Avery Stone"], ["Blake Rivers"]]);
	eq("a block (A2:B3)", (await get("Job Tracking!A2:B3")).values, [["L1", "Avery Stone"], ["L2", "Blake Rivers"]]);
	eq("one cell (C3)", (await get("Job Tracking!C3")).values, [["In Transit"]]);
	eq("an open-ended range (A3:B)", (await get("'Job Tracking'!A3:B")).values, [["L2", "Blake Rivers"], ["L3"]]);
	eq("past the data: no values key at all", "values" in (await get("Job Tracking!A50:B60")), false);
	eq("FORMULA render shows the formula", (await get("Job Tracking!D2", { valueRenderOption: "FORMULA" })).values, [["=1500"]]);
	eq("a quoted name with a quote in it parses", fake.parseA1("'It''s'!A1").sheet, "It's");
	eq("the tab name matches case aside, as Google does", (await get("job tracking!A1")).values, [["Load ID"]]);
	const bg = await s.spreadsheets.values.batchGet({ spreadsheetId: MAIN, ranges: ["Job Tracking!A1", "Carrier Database"] });
	eq("batchGet answers each range in order", bg.data.valueRanges.map((v) => v.values), [[["Load ID"]], [["Driver Name", "Phone"], ["Avery Stone", "555-0100"]]]);
	const meta = await s.spreadsheets.get({ spreadsheetId: MAIN, fields: "sheets.properties.title" });
	eq("spreadsheets.get lists every tab with its sheetId", meta.data.sheets.map((t) => [t.properties.title, t.properties.sheetId]), [["Job Tracking", 0], ["Carrier Database", 7]]);
	eq("the archive is its own spreadsheet", (await s.spreadsheets.values.get({ spreadsheetId: ARCHIVE, range: "Job Tracking" })).data.values, [["Load ID"], ["OLD1"]]);

	// ---- §3 writes -------------------------------------------------------------
	console.log("§3 writes go to the working copy");
	const up = await s.spreadsheets.values.update({ spreadsheetId: MAIN, range: "Job Tracking!C3", valueInputOption: "USER_ENTERED", requestBody: { values: [["Delivered"]] } });
	eq("update answers the range it wrote", [up.data.updatedRange, up.data.updatedCells], ["'Job Tracking'!C3:C3", 1]);
	eq("...and the next read sees it", (await get("Job Tracking!C3")).values, [["Delivered"]]);
	eq("...and it is saved in the working copy file", onDisk(file).spreadsheets[MAIN].sheets[0].values[2][2], "Delivered");
	await s.spreadsheets.values.update({ spreadsheetId: MAIN, range: "Job Tracking!A2:C2", resource: { values: [[null, "Avery  Stone", 12]] } });
	eq("null skips a cell; numbers are stored as their text", (await get("Job Tracking!A2:C2")).values, [["L1", "Avery  Stone", "12"]]);
	const bu = await s.spreadsheets.values.batchUpdate({ spreadsheetId: MAIN, requestBody: { valueInputOption: "USER_ENTERED", data: [{ range: "Job Tracking!B4", values: [["Casey Moss"]] }, { range: "Job Tracking!C4", values: [["Assigned"]] }] } });
	eq("values.batchUpdate writes every range", [bu.data.totalUpdatedCells, (await get("Job Tracking!B4:C4")).values], [2, [["Casey Moss", "Assigned"]]]);
	const ap = await s.spreadsheets.values.append({ spreadsheetId: MAIN, range: "Job Tracking", valueInputOption: "USER_ENTERED", requestBody: { values: [["L4", "Dana Reed", "Unassigned"]] } });
	eq("append lands below the last row, and says where (the app reads the row from it)", ap.data.updates.updatedRange, "'Job Tracking'!A5:C5");
	ok("...which the app's own parse reads as row 5", /![A-Z]+(\d+)/.exec(ap.data.updates.updatedRange)[1] === "5");
	await s.spreadsheets.values.update({ spreadsheetId: MAIN, range: "Job Tracking!D5", requestBody: { values: [["=SUM(1,2)"]] } });
	eq("a written formula reads back as its text under FORMULA render", (await get("Job Tracking!D5", { valueRenderOption: "FORMULA" })).values, [["=SUM(1,2)"]]);
	await s.spreadsheets.batchUpdate({ spreadsheetId: MAIN, requestBody: { requests: [{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2 } } }] } });
	eq("deleteDimension removes the row and shifts the rest up", (await get("Job Tracking!A:A")).values, [["Load ID"], ["L2"], ["L3"], ["L4"]]);
	eq("...formulas move with their rows", (await get("Job Tracking!D4", { valueRenderOption: "FORMULA" })).values, [["=SUM(1,2)"]]);
	eq("...and the grid shrinks by one row", (await s.spreadsheets.get({ spreadsheetId: MAIN })).data.sheets[0].properties.gridProperties.rowCount, 999);
	await s.spreadsheets.batchUpdate({ spreadsheetId: MAIN, requestBody: { requests: [{ insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2 } } }] } });
	eq("insertDimension adds an empty row", (await get("Job Tracking!A1:A3")).values, [["Load ID"], [], ["L2"]]);
	const reopened = fake.createFakeSheets({ file });
	eq("a restarted replica reads what it wrote", (await reopened.spreadsheets.values.get({ spreadsheetId: MAIN, range: "Job Tracking!A5" })).data.values, [["L4"]]);
	eq("the working copy is the only file in its folder (the write is renamed into place)", fs.readdirSync(dir), ["sheets.json"]);
	eq("the working copy stays private (0600)", (fs.statSync(file).mode & 0o777).toString(8), "600");

	// ---- §4 errors -----------------------------------------------------------------
	console.log("§4 errors");
	const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
	const e404 = await errOf(s.spreadsheets.values.get({ spreadsheetId: "nope", range: "Job Tracking" }));
	eq("an unknown spreadsheet is a 404 shaped like gaxios's", [e404 && e404.code, e404 && e404.response && e404.response.status], [404, 404]);
	const e400 = await errOf(s.spreadsheets.values.get({ spreadsheetId: MAIN, range: "No Such Tab!A1" }));
	eq("an unknown tab is Google's 400 'Unable to parse range'", [e400 && e400.code, /Unable to parse range/.test(e400 && e400.message)], [400, true]);
	const eReq = await errOf(s.spreadsheets.batchUpdate({ spreadsheetId: MAIN, requestBody: { requests: [{ addSheet: { properties: { title: "X" } } }] } }));
	ok("a request kind the copy does not support is refused, never ignored", eReq && eReq.code === 400);
	// A batch is applied whole or not at all, as Google applies one.
	const before = fs.readFileSync(file, "utf8");
	const rowsBefore = (await get("Job Tracking!A:A")).values;
	const eHalf = await errOf(s.spreadsheets.batchUpdate({ spreadsheetId: MAIN, requestBody: { requests: [
		{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2 } } },
		{ addSheet: { properties: { title: "X" } } },
	] } }));
	ok("a batch with one refused request is refused...", eHalf && eHalf.code === 400);
	eq("...and its valid requests are not applied (no half-applied batch)", (await get("Job Tracking!A:A")).values, rowsBefore);
	const eBad = await errOf(s.spreadsheets.batchUpdate({ spreadsheetId: MAIN, requestBody: { requests: [
		{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2 } } },
		{ deleteDimension: { range: { sheetId: 99, dimension: "ROWS", startIndex: 1, endIndex: 2 } } },
	] } }));
	ok("an unknown sheet id anywhere in a batch refuses the whole batch", eBad && eBad.code === 400 && JSON.stringify((await get("Job Tracking!A:A")).values) === JSON.stringify(rowsBefore));
	const eInv = await errOf(s.spreadsheets.batchUpdate({ spreadsheetId: MAIN, requestBody: { requests: [{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 3, endIndex: 2 } } }] } }));
	ok("an inverted row range is refused", eInv && eInv.code === 400);
	const eVals = await errOf(s.spreadsheets.values.batchUpdate({ spreadsheetId: MAIN, requestBody: { valueInputOption: "RAW", data: [
		{ range: "Job Tracking!C2", values: [["SHOULD NOT LAND"]] },
		{ range: "No Such Tab!A1", values: [["x"]] },
	] } }));
	ok("values.batchUpdate with one unknown range writes none of its ranges", eVals && eVals.code === 400 && !JSON.stringify((await get("Job Tracking")).values).includes("SHOULD NOT LAND"));
	eq("...and the working copy file is untouched by refused batches", fs.readFileSync(file, "utf8"), before);
	let badFormat = null;
	const { file: f2 } = workingCopy();
	fs.writeFileSync(f2, JSON.stringify({ format: 99 }));
	try { fake.createFakeSheets({ file: f2 }); } catch (e) { badFormat = e; }
	ok("a file that is not a working copy is refused at load", !!badFormat);

	// ---- §5 isolation ------------------------------------------------------------------
	console.log("§5 isolation");
	const loaded = Object.keys(require.cache).filter((k) => !loadedBefore.has(k));
	ok("no Google client is loaded", !loaded.some((k) => /googleapis|google-auth-library|gaxios/.test(k)), loaded);
	const src = fs.readFileSync(path.join(ROOT, "lib", "replica-sheets.js"), "utf8");
	ok("the module requires nothing but fs and path", [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]).every((m) => m === "fs" || m === "path"));

	console.log(failures ? `\n${failures} FAILED` : "\nall passed");
	process.exit(failures ? 1 : 0);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
