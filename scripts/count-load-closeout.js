#!/usr/bin/env node
/**
 * Count the loads the per-load ELD miles sweep could not close out before the
 * sheet's completion signal, and how many that signal now closes.
 *
 * STRUCTURALLY READ-ONLY. The SQLite handle is opened `readonly: true` and
 * asserted; the only Google scope requested is `spreadsheets.readonly`. There
 * is no write path in this file.
 *
 * ONE OPINION. The decision is not re-derived here: computeStatusPhases(),
 * haulWindowFromPhases(), haulSheetCloseOut(), haulLoadWindow() and the
 * live-load filter (excludeDroppedLoads(), deduplicateLoads()) are lifted from
 * server.js source, so this counts exactly what sweepLoadEldMiles() decides.
 *
 * NO DEFAULT SHEET. --sheet-id is required: a script that falls back to a sheet
 * when none is named is how local runs reached production before.
 *
 * Usage:
 *   node scripts/count-load-closeout.js --db=<app.db> --sheet-id=<id> [--key=<service-account.json>]
 *   node scripts/count-load-closeout.js --db=<app.db> --values-json=<file>   # a saved values.get of Job Tracking
 * LOGISX_ROOT=<checkout> reads server.js from another checkout.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const loadHaul = require(path.join(ROOT, "lib", "load-haul"));
const { normalizeLoadId } = require(path.join(ROOT, "lib", "ratecon-load"));

function extractFunction(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of function ${name}() in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}
function extractConst(name) {
	const hits = SRC.match(new RegExp(`^const ${name} = .*$`, "gm")) || [];
	if (hits.length !== 1) throw new Error(`expected exactly 1 declaration of const ${name} in server.js, found ${hits.length}`);
	return hits[0];
}

const FNS = ["parseSheet", "deduplicateLoads", "findCol", "getDeletedLoadIds", "loadKeySet", "excludeDroppedLoads",
	"computeStatusPhases", "haulWindowFromPhases", "haulSheetCloseOut", "haulLoadWindow"];
const CONSTS = ["CANCELED_STATUS_RE", "normLoadKey", "LOAD_ELD_MILES_SWEEP_MAX_AGE_MS"];

function lifted(db) {
	return new Function("db", "loadHaul", "normalizeLoadId", [
		...CONSTS.map(extractConst),
		...FNS.map(extractFunction),
		`return { ${[...FNS, ...CONSTS].join(", ")} };`,
	].join("\n"))(db, loadHaul, normalizeLoadId);
}

/**
 * The count. `values` is a values.get of the Job Tracking tab (header row first).
 */
function countCloseOut({ db, values, nowMs }) {
	const S = lifted(db);
	const parsed = S.parseSheet({ values });
	const headers = parsed.headers;
	const data = S.excludeDroppedLoads(S.deduplicateLoads(parsed.data, headers), headers);
	const loadCol = S.findCol(headers, /load.?id|job.?id/i);
	if (!loadCol) throw new Error("no Load ID column on Job Tracking");
	const final = db.prepare("SELECT load_id, in_progress FROM load_eld_miles WHERE load_id = ?");
	const out = {
		loads: 0,
		already_final: 0,
		closed_by_history: 0,
		before_not_closed_out: 0,
		closed_by_sheet: { total: 0, within_retained_telemetry: 0, older_than_retained_telemetry: 0, by_date_column: {} },
		still_not_closed_out: { not_completed: 0, no_date: 0, future_date: 0 },
	};
	const columns = ["Completion Date", "Status Update Date", "Drop-off Appointment"];
	const seen = new Set();
	for (const r of data) {
		const rawId = String(r[loadCol] || "").trim();
		const key = S.normLoadKey(rawId);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.loads += 1;
		const stored = final.get(key);
		if (stored && !stored.in_progress) { out.already_final += 1; continue; }
		const historyOnly = S.haulWindowFromPhases(S.computeStatusPhases(rawId), nowMs);
		if (!historyOnly.terminal) out.before_not_closed_out += 1;
		const win = S.haulLoadWindow(rawId, r, headers, nowMs);
		if (!win.terminal) {
			const why = S.haulSheetCloseOut(r, headers, nowMs);
			out.still_not_closed_out[(why && why.reason) || "not_completed"] += 1;
			continue;
		}
		if (win.closedBy !== "sheet") { out.closed_by_history += 1; continue; }
		out.closed_by_sheet.total += 1;
		if (win.endMs < nowMs - S.LOAD_ELD_MILES_SWEEP_MAX_AGE_MS) out.closed_by_sheet.older_than_retained_telemetry += 1;
		else out.closed_by_sheet.within_retained_telemetry += 1;
		const used = S.haulSheetCloseOut(r, headers, nowMs);
		const col = columns[used && used.cell] || "?";
		out.closed_by_sheet.by_date_column[col] = (out.closed_by_sheet.by_date_column[col] || 0) + 1;
	}
	return out;
}

async function readJobTracking({ sheetId, keyFile }) {
	const { google } = require("googleapis");
	const auth = new google.auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
	const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
	const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Job Tracking" });
	return res.data.values || [];
}

async function main() {
	const arg = (name) => {
		const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
		return hit ? hit.slice(name.length + 3) : "";
	};
	const dbPath = arg("db");
	const sheetId = arg("sheet-id");
	const valuesJson = arg("values-json");
	if (!dbPath || (!sheetId && !valuesJson)) {
		console.error("usage: --db=<app.db> and one of --sheet-id=<id> | --values-json=<file>  (no defaults)");
		process.exit(2);
	}
	const Database = require("better-sqlite3");
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	if (!db.readonly) throw new Error("refusing: SQLite handle is not readonly");
	const values = valuesJson
		? JSON.parse(fs.readFileSync(valuesJson, "utf8"))
		: await readJobTracking({ sheetId, keyFile: arg("key") || process.env.SERVICE_ACCOUNT_KEY || path.join(ROOT, "service-account-key.json") });
	console.log(JSON.stringify(countCloseOut({ db, values, nowMs: Date.now() }), null, 2));
	db.close();
}

if (require.main === module) {
	main().catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { countCloseOut };
