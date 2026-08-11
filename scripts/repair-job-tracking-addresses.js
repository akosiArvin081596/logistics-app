#!/usr/bin/env node
/**
 * Repair the Pickup / Drop-off Address cells of Job Tracking rows whose
 * addresses are missing or unplaceable — by RE-EXTRACTING the load's own
 * rate-con PDF through the shipping extraction path.
 *
 * OWNER RULE, AND THE ONLY RULE THAT MATTERS HERE:
 *   repair a row ONLY where the rate-con PDF exists AND the row's accounting
 *   month is NOT locked. A locked month gets a report and no write, ever.
 *
 * ── DRY RUN IS THE DEFAULT ───────────────────────────────────────────────────
 * Nothing is written without --apply AND an explicit row selection (--rows= or
 * --all-candidates). An empty selection is a refusal, not "do everything" —
 * the same call as SELECTION_REQUIRED on the gallons-recovery apply verb.
 *
 * ── ONE OPINION ABOUT "OPEN" ────────────────────────────────────────────────
 * This script does NOT classify rows. It calls runAudit() from
 * audit-job-tracking-damage.js and will only ever touch a row that audit marked
 * `writable`. Two implementations of "is this month closed?" is precisely the
 * drift that ends with a write into a settled period. It also refuses
 * --stale-locks-ok outright: reporting on a stale lock table is a judgement
 * call, repairing on one is not. Measured while building this, a stale table
 * (14 locks ending 2026-06 vs production's 15 ending 2026-07) offered FIVE
 * extra rows in the settled 2026-07 period, $6,050 of loads, as "open".
 *
 * ── ⚠️ WHERE THIS HAS TO RUN, AND WHY ───────────────────────────────────────
 * The Gemini key is IP-restricted to the VPS (measured: a call from a dev
 * machine returns 403 "The provided API key has an IP address restriction"),
 * and production sets GEMINI_OCR_MODEL=gemini-3.5-flash because the default
 * gemini-2.5-flash was retired to new projects. So the extraction half only
 * works from the VPS. Running there is better anyway: production's own app.db
 * IS the authoritative period_locks, so the staleness risk disappears rather
 * than being managed. Point LOGISX_ROOT at the checkout:
 *
 *   LOGISX_ROOT=/var/www/logistics-app node repair-job-tracking-addresses.js \
 *     --db=/var/www/logistics-app/app.db --rows=409,411            # dry run
 *   ... --apply --snapshot=/path/rollback.json                     # writes
 *
 * ── ⚠️ NEVER `values.append` ────────────────────────────────────────────────
 * append with a bare tab range lets Sheets auto-detect the anchor column from
 * existing data and lands values shifted right into the wrong columns. Every
 * write here is a values.batchUpdate at an EXPLICIT A1 cell computed from the
 * header index, e.g. "Job Tracking!H409".
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────
 * Only the two address columns are ever written. Payment, Status, Details and
 * every date column are untouched — the owner's standing rule is that a closed
 * month keeps the date recorded, and a repair that restates money is not a
 * repair. The route-shaped `Details` cells are explicitly out of scope.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, "..");
const audit = require("./audit-job-tracking-damage.js");
const { runAudit, withTimeout, columnLetter, PRODUCTION_SHEET_ID, SHEET_TAB } = audit;

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
	const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
	if (!hit) return dflt;
	const eq = hit.indexOf("=");
	return eq === -1 ? true : hit.slice(eq + 1);
};
const APPLY = !!arg("apply", false);
const SHEET_ID = String(arg("sheet-id", PRODUCTION_SHEET_ID));
const DB_PATH = String(arg("db", path.join(ROOT, "app.db")));
const KEY_FILE = arg("key", undefined) ? String(arg("key")) : (process.env.SERVICE_ACCOUNT_KEY || path.join(ROOT, "service-account-key.json"));
const ROWS_ARG = String(arg("rows", ""));
const ALL_CANDIDATES = !!arg("all-candidates", false);
const OVERWRITE_UNUSABLE = !!arg("overwrite-unusable", false);
const SNAPSHOT_OUT = String(arg("snapshot", path.join(process.cwd(), `jt-address-repair-snapshot-${Date.now()}.json`)));
const RATECON_DRIVE_FOLDER_ID = process.env.RATECON_DRIVE_FOLDER_ID || "1VAMgB8xQe50xs-PuX-WW3yL6Hom2xetL";

if (arg("stale-locks-ok", false)) {
	console.error("Refusing: --stale-locks-ok is a REPORTING flag. A repair never runs on a lock table that may be missing a closed month.");
	process.exit(2);
}

// ── env for the extraction half ──────────────────────────────────────────────
try { require("dotenv").config({ path: path.join(ROOT, ".env"), quiet: true }); } catch { /* optional */ }
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_OCR_MODEL = process.env.GEMINI_OCR_MODEL || "gemini-2.5-flash";

// ── the SHIPPING extractor, lifted from server.js source ─────────────────────
// Same reasoning as the audit's helper extraction: server.js cannot be
// require()d (it opens SQLite and listens on import) but its text can be, and
// re-implementing the rate-con prompt/schema would mean repairing production
// data with an extractor that is not the one production uses. The slab spans
// RATECON_PDF_SYSTEM_PROMPT .. end of runRateConGemini(), which is contiguous.
function loadShippingExtractor() {
	const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	const startNeedle = "\nconst RATECON_PDF_SYSTEM_PROMPT = ";
	const endNeedle = "\nasync function runRateConGemini(";
	if (SRC.split(startNeedle).length - 1 !== 1) throw new Error("expected exactly 1 RATECON_PDF_SYSTEM_PROMPT in server.js");
	if (SRC.split(endNeedle).length - 1 !== 1) throw new Error("expected exactly 1 runRateConGemini() in server.js");
	const start = SRC.indexOf(startNeedle) + 1;
	const fnStart = SRC.indexOf(endNeedle);
	if (fnStart < start) throw new Error("runRateConGemini() precedes the prompt — slab assumption broken");
	let depth = 0, end = -1;
	for (let j = SRC.indexOf("{", fnStart); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
	}
	if (end < 0) throw new Error("unbalanced braces extracting runRateConGemini()");
	const slab = SRC.slice(start, end);
	// The slab must be pure extraction code. If a future edit drops route wiring
	// or a DB call in between these two anchors, fail loudly rather than eval it.
	for (const forbidden of ["app.get(", "app.post(", "app.use(", "db.prepare(", "process.exit("]) {
		if (slab.includes(forbidden)) throw new Error(`refusing: extracted slab contains ${forbidden} — the span is no longer pure extraction code`);
	}
	const { geminiFailure } = require(path.join(ROOT, "lib", "gemini-errors.js"));
	return new Function(
		"GEMINI_API_KEY", "GEMINI_OCR_MODEL", "geminiFailure", "fetch", "AbortController",
		`${slab}\nreturn { runRateConGemini, RATECON_GEMINI_FIELDS };`
	)(GEMINI_API_KEY, GEMINI_OCR_MODEL, geminiFailure, fetch, AbortController);
}

// ── Drive: the rate-con archive n8n writes to ────────────────────────────────
// Mirrors getRateConBytes() source (a): all files in the rate-con folder whose
// NAME contains the order number, newest first. Sanitized before interpolation
// so the quoted `name contains '...'` clause cannot be broken.
async function fetchRateConCandidates(drive, loadId) {
	const orderNumber = String(loadId || "").replace(/^#/, "").trim();
	const safe = orderNumber.replace(/[^A-Za-z0-9]/g, "");
	if (!safe) return [];
	const list = await withTimeout(drive.files.list({
		q: `'${RATECON_DRIVE_FOLDER_ID}' in parents and trashed = false and name contains '${safe}'`,
		fields: "files(id,name,createdTime,size)",
		orderBy: "createdTime desc", pageSize: 10,
		supportsAllDrives: true, includeItemsFromAllDrives: true,
	}), 30000, `drive.files.list(${safe})`);
	const files = (list.data.files || []).filter((f) => (f.name || "").includes(safe));
	const out = [];
	for (const f of files.slice(0, 5)) {
		try {
			const resp = await withTimeout(drive.files.get(
				{ fileId: f.id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" },
			), 45000, `drive.files.get(${f.id})`);
			const buffer = Buffer.from(resp.data);
			if (buffer && buffer.length) out.push({ name: f.name, createdTime: f.createdTime, buffer });
		} catch (e) {
			console.error(`    ! Drive fetch failed for ${f.name}: ${e.message}`);
		}
	}
	return out;
}

const PDF_MAGIC = "JVBERi"; // base64 of "%PDF-"

(async () => {
	console.log(`Job Tracking address repair — ${APPLY ? "APPLY (WILL WRITE)" : "DRY RUN (no writes)"}`);
	console.log(`  root      ${ROOT}`);
	console.log(`  sheet     ${SHEET_ID}${SHEET_ID === PRODUCTION_SHEET_ID ? "  (PRODUCTION)" : ""}`);
	console.log(`  locks db  ${DB_PATH}`);
	console.log(`  model     ${GEMINI_OCR_MODEL}   key ${GEMINI_API_KEY ? "present" : "MISSING"}`);
	if (!GEMINI_API_KEY) { console.error("Refusing: GEMINI_API_KEY is not set — there is no extraction path."); process.exit(2); }

	// ── 1. classify, via the audit and only the audit ──────────────────────────
	const report = await runAudit({ sheetId: SHEET_ID, dbPath: DB_PATH, keyFile: KEY_FILE });
	const { pickupAddrCol, dropAddrCol, loadIdCol, pickupAddrIndex, dropAddrIndex } = report.resolvedColumns;
	console.log(`  locks     ${report.lockedPeriods.length} periods, newest ${report.lockFreshness.newest}`);
	console.log(`  candidates (open + address-damaged): ${report.repairCandidates.length}`);
	for (const c of report.repairCandidates) {
		console.log(`    row ${c.sheetRow} load ${c.loadId} period ${c.periods.join(",")} status ${c.status} [${c.flags.join(",")}]`);
	}

	// ── 2. selection ───────────────────────────────────────────────────────────
	let selected;
	if (ALL_CANDIDATES) selected = report.repairCandidates.slice();
	else if (ROWS_ARG) {
		const want = new Set(ROWS_ARG.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean));
		selected = report.repairCandidates.filter((c) => want.has(c.sheetRow));
		const missing = [...want].filter((n) => !selected.some((c) => c.sheetRow === n));
		if (missing.length) {
			console.error(`\nRefusing: rows ${missing.join(",")} are not repair candidates.`);
			console.error(`A row is a candidate only when it is address-damaged AND its period is open and resolvable.`);
			process.exit(2);
		}
	} else {
		console.error(`\nRefusing: no selection. Pass --rows=409,411 or --all-candidates.`);
		console.error(`An empty selection is a refusal, never "repair everything".`);
		process.exit(2);
	}
	if (!selected.length) { console.log(`\nNothing selected — nothing to do.`); return; }

	// ── 3. extraction, via the shipping path ───────────────────────────────────
	const { runRateConGemini } = loadShippingExtractor();
	const { normalizeRateConFields, addressLooksUsable } = require(path.join(ROOT, "lib", "ratecon-normalize.js"));

	const { google } = require("googleapis");
	// Two clients, two scopes: Drive stays READ-ONLY, and only Sheets gets a
	// writable scope. A read-only Drive credential cannot damage the rate-con
	// archive even if this script is wrong.
	const driveAuth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
	const drive = google.drive({ version: "v3", auth: await driveAuth.getClient() });
	const sheetsAuth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
	const sheets = google.sheets({ version: "v4", auth: await sheetsAuth.getClient() });

	const plans = [];
	for (const c of selected) {
		console.log(`\n── row ${c.sheetRow} · load ${c.loadId} · ${c.periods.join(",")} ──`);
		const files = await fetchRateConCandidates(drive, c.loadId);
		console.log(`  rate-con candidates in Drive: ${files.length}${files.length ? " -> " + files.map((f) => `${f.name} (${f.buffer.length}B)`).join(" | ") : ""}`);
		if (!files.length) {
			console.log(`  REFUSED: no rate-con PDF. The addresses are unrecoverable from this system.`);
			plans.push({ ...c, decision: "refused", reason: "no_ratecon_pdf" });
			continue;
		}

		let best = null;
		for (const f of files) {
			const b64 = f.buffer.toString("base64");
			if (!b64.startsWith(PDF_MAGIC)) { console.log(`  skip ${f.name}: not a PDF (magic prefix)`); continue; }
			let fields;
			try { fields = normalizeRateConFields(await runRateConGemini(b64)); }
			catch (e) { console.log(`  extract failed on ${f.name}: ${e.message}`); continue; }
			const pu = fields["Pickup Address"] || "";
			const dr = fields["Drop-off Address"] || "";
			const ok = addressLooksUsable(pu) && addressLooksUsable(dr);
			console.log(`  ${f.name}: pickup=${JSON.stringify(pu)} drop=${JSON.stringify(dr)} usable=${ok}`);
			if (ok) { best = { file: f.name, pickup: pu, dropoff: dr }; break; }
			if (!best) best = { file: f.name, pickup: pu, dropoff: dr, partial: true };
		}

		if (!best || !addressLooksUsable(best.pickup) || !addressLooksUsable(best.dropoff)) {
			console.log(`  REFUSED: re-extraction did not yield two placeable addresses.`);
			plans.push({ ...c, decision: "refused", reason: "extraction_not_usable", extracted: best || null });
			continue;
		}

		// Never silently overwrite a value a human may have typed. Empty is always
		// fillable; a present-but-unplaceable value needs --overwrite-unusable.
		const cells = [];
		for (const [colName, colIdx, current, next] of [
			[pickupAddrCol, pickupAddrIndex, c.pickup, best.pickup],
			[dropAddrCol, dropAddrIndex, c.drop, best.dropoff],
		]) {
			if (current && addressLooksUsable(current)) { console.log(`  keep ${colName}: already placeable`); continue; }
			if (current && !OVERWRITE_UNUSABLE) { console.log(`  keep ${colName}: present but unplaceable — pass --overwrite-unusable to replace`); continue; }
			cells.push({
				column: colName,
				range: `${SHEET_TAB}!${columnLetter(colIdx)}${c.sheetRow}`,
				before: current, after: next,
			});
		}
		if (!cells.length) { plans.push({ ...c, decision: "nothing_to_write" }); continue; }
		plans.push({ ...c, decision: "repair", source: best.file, cells });
		for (const cell of cells) console.log(`  WILL WRITE ${cell.range} (${cell.column}): ${JSON.stringify(cell.before)} -> ${JSON.stringify(cell.after)}`);
	}

	const toWrite = plans.filter((p) => p.decision === "repair");
	console.log(`\n── plan ──`);
	console.log(`  repair ${toWrite.length} row(s), ${toWrite.reduce((n, p) => n + p.cells.length, 0)} cell(s)`);
	for (const p of plans.filter((x) => x.decision !== "repair")) console.log(`  row ${p.sheetRow} load ${p.loadId}: ${p.decision}${p.reason ? " (" + p.reason + ")" : ""}`);

	// ── 4. snapshot BEFORE anything is written ────────────────────────────────
	const snapshot = {
		generatedAt: new Date().toISOString(),
		mode: APPLY ? "apply" : "dry-run",
		sheetId: SHEET_ID, sheetTab: SHEET_TAB,
		lockedPeriods: report.lockedPeriods,
		lockFreshness: report.lockFreshness,
		rollback: toWrite.flatMap((p) => p.cells.map((c) => ({
			range: c.range, loadId: p.loadId, sheetRow: p.sheetRow, restoreTo: c.before, wouldBecome: c.after,
		}))),
		plans,
	};
	fs.writeFileSync(SNAPSHOT_OUT, JSON.stringify(snapshot, null, 2));
	console.log(`  snapshot -> ${SNAPSHOT_OUT}`);

	if (!APPLY) { console.log(`\nDRY RUN — nothing written. Re-run with --apply to write.`); return; }
	if (!toWrite.length) { console.log(`\nNothing to write.`); return; }

	// ── 5. check-then-act, immediately before the write ───────────────────────
	// The audit read the sheet minutes ago and a row index is not a stable key —
	// an insert or delete above shifts every row below it. Re-read and require
	// both the Load ID and the current cell values to be exactly what the plan
	// was built on, or abort without writing anything.
	const fresh = await audit.readJobTracking({ sheetId: SHEET_ID, keyFile: KEY_FILE });
	const freshRows = fresh.values || [];
	const headerRow = freshRows[0] || [];
	const iLoad = headerRow.indexOf(loadIdCol);
	for (const p of toWrite) {
		const row = freshRows[p.sheetRow - 1] || [];
		const nowLoad = String(row[iLoad] ?? "").trim();
		if (nowLoad !== p.loadId) {
			console.error(`\nABORT: row ${p.sheetRow} now carries Load ID ${JSON.stringify(nowLoad)}, expected ${JSON.stringify(p.loadId)}. The sheet moved under us; nothing written.`);
			process.exit(4);
		}
		for (const cell of p.cells) {
			const idx = headerRow.indexOf(cell.column);
			const nowVal = String(row[idx] ?? "").trim();
			if (nowVal !== String(cell.before ?? "").trim()) {
				console.error(`\nABORT: ${cell.range} changed since the plan was built (${JSON.stringify(nowVal)} vs ${JSON.stringify(cell.before)}). Nothing written.`);
				process.exit(4);
			}
		}
	}

	// ── 6. write, at EXPLICIT ranges ──────────────────────────────────────────
	const data = toWrite.flatMap((p) => p.cells.map((c) => ({ range: c.range, values: [[c.after]] })));
	console.log(`\nwriting ${data.length} cell(s) via values.batchUpdate at explicit ranges…`);
	const resp = await withTimeout(sheets.spreadsheets.values.batchUpdate({
		spreadsheetId: SHEET_ID,
		requestBody: { valueInputOption: "USER_ENTERED", data },
	}), 60000, "values.batchUpdate");
	console.log(`  updated cells: ${resp.data.totalUpdatedCells}`);

	// ── 7. re-read and diff ───────────────────────────────────────────────────
	const after = await audit.readJobTracking({ sheetId: SHEET_ID, keyFile: KEY_FILE });
	const afterRows = after.values || [];
	const afterHeader = afterRows[0] || [];
	let ok = 0, bad = 0;
	console.log(`\n── verification (re-read) ──`);
	for (const p of toWrite) {
		const row = afterRows[p.sheetRow - 1] || [];
		for (const cell of p.cells) {
			const got = String(row[afterHeader.indexOf(cell.column)] ?? "").trim();
			const want = String(cell.after).trim();
			if (got === want) { ok++; console.log(`  OK  ${cell.range} = ${JSON.stringify(got)}`); }
			else { bad++; console.log(`  BAD ${cell.range} = ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`); }
		}
	}
	snapshot.mode = "applied";
	snapshot.appliedAt = new Date().toISOString();
	snapshot.verification = { ok, bad, totalUpdatedCells: resp.data.totalUpdatedCells };
	fs.writeFileSync(SNAPSHOT_OUT, JSON.stringify(snapshot, null, 2));
	console.log(`\n${bad ? "⚠️  " : ""}verified ${ok} ok / ${bad} bad. Rollback artifact: ${SNAPSHOT_OUT}`);
	if (bad) process.exit(5);
})().catch((e) => {
	console.error(`\nrepair failed: ${e && e.message ? e.message : e}`);
	if (e && e.code === "STALE_LOCKS") console.error(`The lock table must be fresh for a repair. Point --db at production's app.db.`);
	process.exit(1);
});
