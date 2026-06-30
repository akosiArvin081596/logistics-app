#!/usr/bin/env node
/**
 * One-off backfill: stamp expenses.location_city / expenses.location_state for
 * image receipts that are missing them, by re-running the receipt OCR (Gemini)
 * over the stored receipt image and writing back any confident city/state.
 *
 * Scope: IMAGE receipts only. Rows whose photo_data is empty, or points at a
 * PDF receipt, are intentionally excluded from the work set and merely
 * reported in the summary (image OCR can't read those here).
 *
 * Idempotent: only fills rows whose location_city is currently empty, and the
 * UPDATE re-guards on that same condition, so the script is safe to re-run and
 * to resume after an interruption. Each UPDATE commits on its own (no wrapping
 * transaction) so progress survives a crash and the live server sees rows
 * immediately. Re-running only re-touches rows that are still empty
 * (low-confidence / failed last time).
 *
 * Usage (on the VPS, from the repo root):
 *   cd /var/www/logistics-app && node scripts/backfill-expense-location.js --dry-run
 *   cd /var/www/logistics-app && node scripts/backfill-expense-location.js
 *
 *   --dry-run    Call Gemini and log intended updates, but write NOTHING.
 *   --limit N    Process at most N image receipts (first canary batch).
 *
 * Dependencies (produced by the backend/OCR lane — must be deployed FIRST):
 *   - lib/receipt-ocr.js exporting `runReceiptOcr(dataUri)` -> the OCR object
 *     plus city/state + a `confidence` of "high" | "medium" | "low".
 *   - expenses.location_city / expenses.location_state columns (added on
 *     server boot via the ALTER-on-boot pattern).
 *   - GEMINI_API_KEY in .env (GEMINI_OCR_MODEL optional) — consumed by the lib.
 *
 * Cost: one Gemini call per image receipt (dry-run included). Throttled ~1s
 * between calls; budget accordingly.
 */

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { runReceiptOcr } = require("../lib/receipt-ocr");

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = process.env.DATABASE_PATH || path.join(ROOT, "app.db");
const RECEIPTS_DIR = path.join(ROOT, "uploads", "expense-receipts");
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = parseLimit(process.argv);
const THROTTLE_MS = 1000;

// "Confident" = high-confidence OCR with BOTH a city and a state. `medium` is a
// documented tunable — add it here if precision proves too strict on staging.
const ACCEPTED_CONFIDENCE = new Set(["high"]);

// MIME lookup for the on-disk receipt extensions saveReceiptToDisk writes
// (server.js: jpg/jpeg/png/webp). Anything else can't be handed to image OCR.
const MIME_BY_EXT = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse `--limit N` or `--limit=N`; returns Infinity (no cap) when absent/bad.
function parseLimit(argv) {
	const flagIdx = argv.indexOf("--limit");
	if (flagIdx !== -1 && argv[flagIdx + 1]) {
		const n = parseInt(argv[flagIdx + 1], 10);
		if (Number.isFinite(n) && n > 0) return n;
	}
	const eq = argv.find((a) => a.startsWith("--limit="));
	if (eq) {
		const n = parseInt(eq.split("=")[1], 10);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return Infinity;
}

// Pull city / state / confidence out of runReceiptOcr's result without assuming
// the exact field names. Single source of truth for the OCR shape so retuning
// the contract with the backend lane is a one-line change here.
function extractLocation(result) {
	const r = result || {};
	const city = String(r.city || r.locationCity || "").trim();
	const state = String(r.state || r.locationState || "").trim();
	const confidence = String(r.confidence || "low").toLowerCase();
	return { city, state, confidence };
}

// Turn a stored photo_data value into a base64 image data URI for OCR.
// Returns { dataUri } on success, or { skip } / { fail } with a human reason.
function resolveReceiptDataUri(photoData) {
	const raw = String(photoData || "");

	// Legacy rows store the base64 data URI inline rather than a file path.
	// Pass image data URIs straight through; anything else (e.g. inline PDFs)
	// is reported and skipped.
	if (raw.startsWith("data:")) {
		if (/^data:image\/(jpe?g|png|webp);base64,/i.test(raw)) {
			return { dataUri: raw };
		}
		return { skip: "non-image data URI (legacy/non-receipt)" };
	}

	// Normal case: photo_data is a URL path like /uploads/expense-receipts/<file>.
	const abs = path.join(ROOT, raw.replace(/^[\\/]+/, ""));

	// Path-traversal guard: the resolved file must stay inside RECEIPTS_DIR.
	const rel = path.relative(RECEIPTS_DIR, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return { skip: `path outside receipts dir (${raw})` };
	}
	if (!fs.existsSync(abs)) return { fail: `file missing on disk (${raw})` };

	const ext = path.extname(abs).slice(1).toLowerCase();
	const mime = MIME_BY_EXT[ext];
	if (!mime) return { skip: `unsupported extension .${ext || "(none)"}` };

	let buf;
	try {
		buf = fs.readFileSync(abs);
	} catch (err) {
		return { fail: `read error: ${err.message}` };
	}
	return { dataUri: `data:${mime};base64,${buf.toString("base64")}` };
}

async function main() {
	// OCR is required even for --dry-run (dry-run still CALLS Gemini; it only
	// skips the write), so fail fast when the key is missing.
	if (!process.env.GEMINI_API_KEY) {
		console.error(
			"GEMINI_API_KEY is not set. Receipt OCR is required (dry-run still calls Gemini). Aborting."
		);
		process.exit(1);
	}

	const db = new Database(DB_PATH);
	db.pragma("journal_mode = WAL");

	try {
		// Idempotent work set: image receipts still missing a city.
		const allWork = db
			.prepare(
				`SELECT id, photo_data
				 FROM expenses
				 WHERE COALESCE(location_city, '') = ''
				   AND photo_data != ''
				   AND photo_data NOT LIKE '%.pdf'
				 ORDER BY id`
			)
			.all();
		const workRows = Number.isFinite(LIMIT) ? allWork.slice(0, LIMIT) : allWork;

		// Diagnostics: rows the work query intentionally excludes, so the summary
		// explains what was left untouched and why.
		const pdfMissing = db
			.prepare(
				`SELECT COUNT(*) AS n FROM expenses
				 WHERE COALESCE(location_city, '') = '' AND photo_data LIKE '%.pdf'`
			)
			.get().n;
		const blankMissing = db
			.prepare(
				`SELECT COUNT(*) AS n FROM expenses
				 WHERE COALESCE(location_city, '') = '' AND COALESCE(photo_data, '') = ''`
			)
			.get().n;

		const update = db.prepare(
			`UPDATE expenses
			 SET location_city = ?, location_state = ?
			 WHERE id = ? AND COALESCE(location_city, '') = ''`
		);

		const total = workRows.length;
		const limitNote =
			Number.isFinite(LIMIT) && allWork.length > total
				? ` (limited to ${total} of ${allWork.length})`
				: "";
		console.log(
			`backfill-expense-location: ${total} image receipt(s) missing location_city.${limitNote}${
				DRY_RUN ? " (DRY RUN)" : ""
			}`
		);
		console.log(
			`Reported (excluded from work set): pdf_missing=${pdfMissing} blank_missing=${blankMissing}`
		);
		console.log("");

		let scanned = 0;
		let updated = 0;
		let skipped = 0;
		let failed = 0;
		let wouldUpdate = 0;

		for (let i = 0; i < workRows.length; i++) {
			const row = workRows[i];
			scanned++;
			const pos = `[${i + 1}/${total}]`;

			const resolved = resolveReceiptDataUri(row.photo_data);
			if (resolved.skip) {
				console.log(`[SKIP] ${pos} id=${row.id} — ${resolved.skip}`);
				skipped++;
				continue;
			}
			if (resolved.fail) {
				console.log(`[FAIL] ${pos} id=${row.id} — ${resolved.fail}`);
				failed++;
				continue;
			}

			let result;
			try {
				result = await runReceiptOcr(resolved.dataUri);
			} catch (err) {
				console.log(`[FAIL] ${pos} id=${row.id} — OCR error: ${err.message}`);
				failed++;
				await sleep(THROTTLE_MS); // space out Gemini calls even on error
				continue;
			}
			await sleep(THROTTLE_MS); // ~1s between Gemini calls

			const { city, state, confidence } = extractLocation(result);
			if (!ACCEPTED_CONFIDENCE.has(confidence) || !city || !state) {
				console.log(
					`[SKIP] ${pos} id=${row.id} — low/no location (confidence=${confidence} city="${city}" state="${state}")`
				);
				skipped++;
				continue;
			}

			if (DRY_RUN) {
				console.log(
					`[DRY] ${pos} id=${row.id} would set location_city='${city}' location_state='${state}'`
				);
				wouldUpdate++;
				continue;
			}

			const info = update.run(city, state, row.id);
			if (info.changes) {
				console.log(`[OK] ${pos} id=${row.id} -> ${city}, ${state}`);
				updated++;
			} else {
				// Re-guard hit: another run already filled it. Keeps the script
				// idempotent under concurrent execution.
				console.log(`[SKIP] ${pos} id=${row.id} — already filled by a concurrent run`);
				skipped++;
			}
		}

		console.log("");
		console.log(
			`Done. scanned=${scanned} updated=${DRY_RUN ? wouldUpdate : updated} ` +
				`skipped=${skipped} failed=${failed} ` +
				`(pdf_reported=${pdfMissing} blank_reported=${blankMissing})${
					DRY_RUN ? " (DRY RUN — no writes)" : ""
				}`
		);
	} finally {
		db.close();
	}
}

main().catch((err) => {
	console.error("backfill-expense-location failed:", err);
	process.exit(1);
});
