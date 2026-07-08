#!/usr/bin/env node
/**
 * Backfill: stamp expenses.vendor / vendor_normalized (and, via the opt-in
 * passes, location_lat/lng/state + location_source) on historical expense
 * rows so Expense Intelligence analytics have clean data to group on.
 *
 * Structure cloned from scripts/backfill-expense-location.js: dotenv,
 * better-sqlite3 in WAL mode, --dry-run/--limit flags, path-traversal-guarded
 * receipt resolution, ~1s OCR throttle, per-pass counters + summary.
 *
 * Idempotent + resumable: every UPDATE re-guards its own emptiness condition
 * (e.g. `AND COALESCE(vendor_normalized,'') = ''`), each row commits on its
 * own (no wrapping transaction), and the work queries only select rows still
 * missing data — so the script is safe to re-run, to resume after a crash,
 * and to run while the server is live (WAL).
 *
 * Usage (on the VPS, from the repo root):
 *   cd /var/www/logistics-app && node scripts/backfill-expense-vendor.js --dry-run
 *   cd /var/www/logistics-app && node scripts/backfill-expense-vendor.js
 *   cd /var/www/logistics-app && node scripts/backfill-expense-vendor.js --reocr --limit 25
 *   cd /var/www/logistics-app && node scripts/backfill-expense-vendor.js --geocode --eld
 *
 * Passes (DEFAULT run = pass 1 only; 2–4 are opt-in flags):
 *   PASS 1 (always)     Normalize existing vendor strings → vendor_normalized;
 *                       promote descriptions to vendor ONLY when they hit a
 *                       KNOWN brand alias (free text like "oil change" never
 *                       becomes a vendor).
 *   PASS 2 (--reocr)    Re-run Gemini receipt OCR on image receipts still
 *                       missing a vendor; accept high/medium confidence;
 *                       opportunistically fill empty location_city/state.
 *   PASS 3 (--geocode)  Forward-geocode "City, ST" → location_lat/lng via the
 *                       Google Geocoding API with the shared geocode_cache
 *                       (nulls cached too, so misses aren't re-fetched).
 *   PASS 4 (--eld)      Resolve the truck on the expense date (assignment
 *                       history, then truck_unit fallback), take the clean
 *                       ELD ping nearest that day, and derive the state from
 *                       lib/ifta-states bounding boxes.
 *
 * Flags:
 *   --dry-run    Log what WOULD change (sample capped at 10 rows/pass) and
 *                write NOTHING — but external calls (Gemini/Google) still
 *                happen so the dry run predicts real acceptance.
 *   --limit N    Per-pass cap: max rows processed (pass 1/3/4) and max OCR
 *                calls (pass 2). First canary batch.
 *   --reocr / --geocode / --eld   Enable passes 2 / 3 / 4.
 *
 * Dependencies:
 *   - lib/expense-analytics.js (normalizeVendor / normalizeVendorDetailed)
 *   - lib/receipt-ocr.js (runReceiptOcr) + GEMINI_API_KEY  (--reocr only)
 *   - GOOGLE_MAPS_API_KEY                                   (--geocode only)
 *   - lib/ifta-states.js (getStateFromCoords)               (--eld)
 *   - expenses vendor/vendor_normalized/location_* columns (ALTER-on-boot —
 *     boot the server once before running; the preflight checks this).
 *
 * Cost: --reocr = one Gemini call per attempted receipt (throttled ~1s);
 * --geocode = one Geocoding call per UNCACHED "City, ST" (throttled 200ms).
 * Pass 1 and --eld are free (local compute + SQLite only).
 */

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { normalizeVendor, normalizeVendorDetailed } = require("../lib/expense-analytics");
const { runReceiptOcr } = require("../lib/receipt-ocr");
const { getStateFromCoords } = require("../lib/ifta-states");

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = process.env.DATABASE_PATH || path.join(ROOT, "app.db");
const RECEIPTS_DIR = path.join(ROOT, "uploads", "expense-receipts");

const argv = process.argv;
const DRY_RUN = argv.includes("--dry-run");
const RUN_REOCR = argv.includes("--reocr");
const RUN_GEOCODE = argv.includes("--geocode");
const RUN_ELD = argv.includes("--eld");
const LIMIT = parseLimit(argv);

const OCR_THROTTLE_MS = 1000; // ~1s between Gemini calls (template convention)
const GEOCODE_THROTTLE_MS = 200; // cache misses only
const HOUR_MS = 3600000;
const DRY_SAMPLE_MAX = 10;

// Same acceptance bar as backfill-expense-location.js: high or medium
// confidence; `low` is never trusted for writes.
const ACCEPTED_CONFIDENCE = new Set(["high", "medium"]);

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
function parseLimit(args) {
	const flagIdx = args.indexOf("--limit");
	if (flagIdx !== -1 && args[flagIdx + 1]) {
		const n = parseInt(args[flagIdx + 1], 10);
		if (Number.isFinite(n) && n > 0) return n;
	}
	const eq = args.find((a) => a.startsWith("--limit="));
	if (eq) {
		const n = parseInt(eq.split("=")[1], 10);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return Infinity;
}

// ---------------------------------------------------------------------------
// Counters (per pass): scanned / updated / skipped{reason} / api calls
// ---------------------------------------------------------------------------

function newCounters() {
	return { scanned: 0, updated: 0, wouldUpdate: 0, apiCalls: 0, skipped: {}, extra: {} };
}
function skip(c, reason) {
	c.skipped[reason] = (c.skipped[reason] || 0) + 1;
}
function bumpExtra(c, key) {
	c.extra[key] = (c.extra[key] || 0) + 1;
}
// Dry-run detail lines are capped at DRY_SAMPLE_MAX per pass; every
// would-change row still counts in the summary.
function dryLog(c, msg) {
	c.wouldUpdate++;
	if (c.wouldUpdate <= DRY_SAMPLE_MAX) console.log(`  [DRY] ${msg}`);
	else if (c.wouldUpdate === DRY_SAMPLE_MAX + 1) console.log(`  [DRY] … more would-change rows (sample capped at ${DRY_SAMPLE_MAX})`);
}
function printSummary(name, c) {
	const skippedTotal = Object.values(c.skipped).reduce((a, b) => a + b, 0);
	const reasons = Object.entries(c.skipped).map(([k, v]) => `${k}=${v}`).join(", ");
	const extras = Object.entries(c.extra).map(([k, v]) => ` ${k}=${v}`).join("");
	console.log(
		`${name}: scanned=${c.scanned} ` +
		(DRY_RUN ? `would_update=${c.wouldUpdate}` : `updated=${c.updated}`) +
		` skipped=${skippedTotal}${reasons ? ` (${reasons})` : ""} api_calls=${c.apiCalls}${extras}`
	);
}

// ---------------------------------------------------------------------------
// Receipt file resolution (clone of backfill-expense-location.js, incl. the
// path-traversal guard: resolved files must stay inside RECEIPTS_DIR)
// ---------------------------------------------------------------------------

function resolveReceiptDataUri(photoData) {
	const raw = String(photoData || "");

	// Legacy rows store the base64 data URI inline rather than a file path.
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

// ---------------------------------------------------------------------------
// PASS 1 (always): normalize vendor strings already on the rows
// ---------------------------------------------------------------------------

function passNormalize(db) {
	const c = newCounters();
	let budget = LIMIT;
	console.log("\n— PASS 1: normalize vendor strings (always on) —");

	// (a) vendor present, vendor_normalized empty → derive the canonical brand.
	const rowsA = db.prepare(
		`SELECT id, vendor FROM expenses
		 WHERE COALESCE(vendor_normalized, '') = '' AND COALESCE(vendor, '') <> ''
		 ORDER BY id`
	).all();
	const updA = db.prepare(
		`UPDATE expenses SET vendor_normalized = ?
		 WHERE id = ? AND COALESCE(vendor_normalized, '') = ''`
	);
	for (const row of rowsA) {
		if (budget-- <= 0) break;
		c.scanned++;
		const normalized = normalizeVendor(row.vendor);
		if (!normalized) { skip(c, "vendor_unnormalizable"); continue; }
		if (DRY_RUN) { dryLog(c, `id=${row.id} vendor=${JSON.stringify(row.vendor)} → vendor_normalized='${normalized}'`); continue; }
		if (updA.run(normalized, row.id).changes) c.updated++;
		else skip(c, "already_filled_concurrently");
	}

	// (b) vendor empty but a description exists → promote it ONLY when the
	// description hits a KNOWN brand alias. Free-typed descriptions like
	// "oil change" must never become vendors, so aliasHit (not the fallback
	// cleaner) is the gate.
	const rowsB = db.prepare(
		`SELECT id, description FROM expenses
		 WHERE COALESCE(vendor, '') = '' AND COALESCE(description, '') <> ''
		 ORDER BY id`
	).all();
	const updB = db.prepare(
		`UPDATE expenses SET vendor = ?, vendor_normalized = ?
		 WHERE id = ? AND COALESCE(vendor, '') = ''`
	);
	for (const row of rowsB) {
		if (budget-- <= 0) break;
		c.scanned++;
		const detail = normalizeVendorDetailed(row.description);
		if (!detail.aliasHit) { skip(c, "description_not_known_brand"); continue; }
		const vendor = String(row.description).trim().slice(0, 80);
		if (DRY_RUN) { dryLog(c, `id=${row.id} description=${JSON.stringify(row.description)} → vendor='${vendor}' vendor_normalized='${detail.normalized}'`); continue; }
		if (updB.run(vendor, detail.normalized, row.id).changes) c.updated++;
		else skip(c, "already_filled_concurrently");
	}

	printSummary("PASS 1 (normalize)", c);
}

// ---------------------------------------------------------------------------
// PASS 2 (--reocr): Gemini OCR for image receipts still missing a vendor
// ---------------------------------------------------------------------------

async function passReocr(db) {
	const c = newCounters();
	console.log("\n— PASS 2: re-OCR image receipts missing a vendor (--reocr) —");

	// Image receipts only: uploaded files (never PDFs) plus legacy inline
	// data:image URIs. PDFs/blank photo_data stay untouched.
	const rows = db.prepare(
		`SELECT id, photo_data, location_city, location_state FROM expenses
		 WHERE COALESCE(vendor_normalized, '') = ''
		   AND (
		         (photo_data LIKE '/uploads/expense-receipts/%' AND photo_data NOT LIKE '%.pdf')
		      OR photo_data LIKE 'data:image/%'
		   )
		 ORDER BY id`
	).all();
	const updVendor = db.prepare(
		`UPDATE expenses SET vendor = ?, vendor_normalized = ?
		 WHERE id = ? AND COALESCE(vendor_normalized, '') = ''`
	);
	const updCity = db.prepare(
		`UPDATE expenses SET location_city = ? WHERE id = ? AND COALESCE(location_city, '') = ''`
	);
	const updState = db.prepare(
		`UPDATE expenses SET location_state = ? WHERE id = ? AND COALESCE(location_state, '') = ''`
	);

	for (const row of rows) {
		// --limit = max OCR calls for this pass (dry-run calls Gemini too).
		if (c.apiCalls >= LIMIT) {
			console.log(`  --limit ${LIMIT} OCR-call cap reached; ${rows.length - c.scanned} row(s) left for a future run.`);
			break;
		}
		c.scanned++;

		const resolved = resolveReceiptDataUri(row.photo_data);
		if (resolved.skip) { skip(c, "unusable_photo_ref"); continue; }
		if (resolved.fail) { skip(c, "file_missing_or_unreadable"); continue; }

		let result;
		try {
			c.apiCalls++;
			result = await runReceiptOcr(resolved.dataUri);
		} catch (err) {
			console.log(`  [FAIL] id=${row.id} — OCR error: ${err.message}`);
			skip(c, "ocr_error");
			await sleep(OCR_THROTTLE_MS); // space out Gemini calls even on error
			continue;
		}
		await sleep(OCR_THROTTLE_MS); // ~1s between Gemini calls

		const vendor = String(result.vendor || "").trim().slice(0, 80);
		const confidence = String(result.confidence || "low").toLowerCase();
		if (!ACCEPTED_CONFIDENCE.has(confidence) || !vendor) {
			skip(c, "low_confidence_or_no_vendor");
			continue;
		}
		const normalized = normalizeVendor(vendor);
		if (!normalized) { skip(c, "ocr_vendor_unnormalizable"); continue; } // avoids endless re-OCR of junk

		const city = String(result.city || "").trim().slice(0, 60);
		const stateRaw = String(result.state || "").trim().toUpperCase();
		const state = /^[A-Z]{2}$/.test(stateRaw) ? stateRaw : "";
		const cityFill = city && !String(row.location_city || "").trim() ? city : "";
		const stateFill = state && !String(row.location_state || "").trim() ? state : "";

		if (DRY_RUN) {
			dryLog(c, `id=${row.id} → vendor='${vendor}' vendor_normalized='${normalized}'` +
				(cityFill ? ` +city='${cityFill}'` : "") + (stateFill ? ` +state='${stateFill}'` : ""));
			continue;
		}
		if (updVendor.run(vendor, normalized, row.id).changes) c.updated++;
		else skip(c, "already_filled_concurrently");
		// Opportunistic location fill — independently re-guarded on emptiness.
		if (cityFill && updCity.run(cityFill, row.id).changes) bumpExtra(c, "city_filled");
		if (stateFill && updState.run(stateFill, row.id).changes) bumpExtra(c, "state_filled");
	}

	printSummary("PASS 2 (re-OCR)", c);
}

// ---------------------------------------------------------------------------
// PASS 3 (--geocode): "City, ST" → lat/lng via cached Google Geocoding
// ---------------------------------------------------------------------------

// Inline forward-geocode mirroring server.js:14121 geocodeAddress: Google
// Geocoding API, first result's location, null on any miss/error. The caller
// handles the geocode_cache read/write (including caching nulls).
async function googleGeocode(address) {
	try {
		const resp = await fetch(
			`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${process.env.GOOGLE_MAPS_API_KEY}`
		);
		const data = await resp.json();
		if (data.status === "OK" && data.results && data.results.length > 0) {
			const loc = data.results[0].geometry.location;
			return { lat: loc.lat, lng: loc.lng };
		}
	} catch { /* fall through → null */ }
	return null;
}

async function passGeocode(db) {
	const c = newCounters();
	let budget = LIMIT;
	console.log("\n— PASS 3: forward-geocode city/state → lat/lng (--geocode) —");

	// Mirror server.js:584 so the script also works against a fresh DB copy;
	// IF NOT EXISTS makes this a no-op on the live database.
	db.exec(`CREATE TABLE IF NOT EXISTS geocode_cache (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		address TEXT NOT NULL UNIQUE,
		lat REAL,
		lng REAL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`);

	const rows = db.prepare(
		`SELECT id, location_city, location_state FROM expenses
		 WHERE location_lat IS NULL
		   AND COALESCE(location_city, '') <> ''
		   AND COALESCE(location_state, '') <> ''
		 ORDER BY id`
	).all();
	const upd = db.prepare(
		`UPDATE expenses SET
			location_lat = ?,
			location_lng = ?,
			location_source = CASE WHEN COALESCE(location_source, '') = '' THEN 'geocode' ELSE location_source END
		 WHERE id = ? AND location_lat IS NULL`
	);
	const cacheGet = db.prepare("SELECT lat, lng FROM geocode_cache WHERE address = ?");
	const cachePut = db.prepare("INSERT OR REPLACE INTO geocode_cache (address, lat, lng) VALUES (?, ?, ?)");

	for (const row of rows) {
		if (budget-- <= 0) {
			console.log(`  --limit ${LIMIT} row cap reached; ${rows.length - c.scanned} row(s) left for a future run.`);
			break;
		}
		c.scanned++;

		const address = `${String(row.location_city).trim()}, ${String(row.location_state).trim()}`;
		const key = address.toLowerCase();
		let coords;
		const cached = cacheGet.get(key);
		if (cached) {
			coords = cached.lat != null ? { lat: cached.lat, lng: cached.lng } : null;
			if (!coords) { skip(c, "cached_null_geocode"); continue; }
		} else {
			c.apiCalls++;
			coords = await googleGeocode(address);
			// Cache NULL results too so a bad "City, ST" is never re-fetched
			// (server.js geocodeAddress convention). Dry-run writes nothing.
			if (!DRY_RUN) cachePut.run(key, coords ? coords.lat : null, coords ? coords.lng : null);
			await sleep(GEOCODE_THROTTLE_MS); // throttle cache misses only
			if (!coords) { skip(c, "geocode_no_result"); continue; }
		}

		if (DRY_RUN) { dryLog(c, `id=${row.id} '${address}' → lat=${coords.lat} lng=${coords.lng}`); continue; }
		if (upd.run(coords.lat, coords.lng, row.id).changes) c.updated++;
		else skip(c, "already_filled_concurrently");
	}

	printSummary("PASS 3 (geocode)", c);
}

// ---------------------------------------------------------------------------
// PASS 4 (--eld): derive location_state from the truck's ELD pings
// ---------------------------------------------------------------------------

function passEld(db) {
	const c = newCounters();
	let budget = LIMIT;
	console.log("\n— PASS 4: ELD pings → location_state (--eld) —");

	const rows = db.prepare(
		`SELECT id, driver, date, truck_unit FROM expenses
		 WHERE COALESCE(location_state, '') = ''
		 ORDER BY id`
	).all();

	// server.js:2151 assignment-resolution pattern: the assignment covering
	// the expense date, newest start first. Assignments whose truck has no
	// Routemate link fall through to the truck_unit fallback below.
	const assignStmt = db.prepare(
		`SELECT t.routemate_vehicle_id AS vid
		 FROM truck_assignments ta
		 JOIN trucks t ON t.id = ta.truck_id
		 WHERE LOWER(ta.driver_name) = LOWER(?)
		   AND ta.start_date <= ?
		   AND (ta.end_date = '' OR ta.end_date >= ?)
		   AND COALESCE(t.routemate_vehicle_id, '') <> ''
		 ORDER BY ta.start_date DESC
		 LIMIT 1`
	);
	const unitStmt = db.prepare(
		`SELECT routemate_vehicle_id AS vid FROM trucks
		 WHERE LOWER(unit_number) = LOWER(?) AND COALESCE(routemate_vehicle_id, '') <> ''
		 LIMIT 1`
	);
	// Clean pings only (dropped_reason='') in [date 00:00Z − 6h, +30h] — a
	// generous band around the US business day regardless of local zone —
	// picking the ping closest to 18:00Z (~midday US) as "where the truck
	// was when the expense happened".
	const pingStmt = db.prepare(
		`SELECT latitude, longitude FROM routemate_telemetry
		 WHERE routemate_vehicle_id = ?
		   AND dropped_reason = ''
		   AND location_date_ms BETWEEN ? AND ?
		   AND latitude IS NOT NULL AND longitude IS NOT NULL
		 ORDER BY ABS(location_date_ms - ?)
		 LIMIT 1`
	);
	const upd = db.prepare(
		`UPDATE expenses SET
			location_state = ?,
			location_lat = CASE WHEN location_lat IS NULL THEN ? ELSE location_lat END,
			location_lng = CASE WHEN location_lng IS NULL THEN ? ELSE location_lng END,
			location_source = CASE WHEN COALESCE(location_source, '') = '' THEN 'eld' ELSE location_source END
		 WHERE id = ? AND COALESCE(location_state, '') = ''`
	);

	for (const row of rows) {
		if (budget-- <= 0) {
			console.log(`  --limit ${LIMIT} row cap reached; ${rows.length - c.scanned} row(s) left for a future run.`);
			break;
		}
		c.scanned++;

		if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || ""))) { skip(c, "bad_date"); continue; }
		const dayStartMs = Date.parse(`${row.date}T00:00:00Z`);
		if (!Number.isFinite(dayStartMs)) { skip(c, "bad_date"); continue; }

		let vid = (assignStmt.get(String(row.driver || ""), row.date, row.date) || {}).vid || "";
		if (!vid && String(row.truck_unit || "").trim()) {
			vid = (unitStmt.get(String(row.truck_unit).trim()) || {}).vid || "";
		}
		if (!vid) { skip(c, "no_vehicle_link"); continue; }

		const ping = pingStmt.get(vid, dayStartMs - 6 * HOUR_MS, dayStartMs + 30 * HOUR_MS, dayStartMs + 18 * HOUR_MS);
		if (!ping) { skip(c, "no_clean_pings_in_window"); continue; }

		const state = getStateFromCoords(ping.latitude, ping.longitude);
		if (!/^[A-Z]{2}$/.test(state)) { skip(c, "state_unresolved"); continue; } // "Other" = outside known bounds

		if (DRY_RUN) {
			dryLog(c, `id=${row.id} date=${row.date} vid=${vid} → state='${state}' (ping ${ping.latitude},${ping.longitude})`);
			continue;
		}
		if (upd.run(state, ping.latitude, ping.longitude, row.id).changes) c.updated++;
		else skip(c, "already_filled_concurrently");
	}

	printSummary("PASS 4 (ELD)", c);
}

// ---------------------------------------------------------------------------
// Preflight + main
// ---------------------------------------------------------------------------

// The vendor/location columns are added by server.js's ALTER-on-boot
// migrations — fail with a clear message instead of a raw SQL error when the
// DB predates them.
function preflight(db) {
	const cols = new Set(db.prepare("PRAGMA table_info(expenses)").all().map((c) => c.name));
	const need = ["vendor", "vendor_normalized", "location_city", "location_state"];
	if (RUN_GEOCODE || RUN_ELD) need.push("location_lat", "location_lng", "location_source");
	const missing = need.filter((c) => !cols.has(c));
	if (missing.length) {
		console.error(
			`expenses table is missing column(s): ${missing.join(", ")}. ` +
			"Boot the server once so the ALTER-on-boot migrations run, then re-run this script."
		);
		process.exit(1);
	}
}

async function main() {
	// Fail fast on required keys for the opted-in passes (dry-run still calls
	// the external APIs, so the keys are required either way).
	if (RUN_REOCR && !process.env.GEMINI_API_KEY) {
		console.error("GEMINI_API_KEY is not set. --reocr calls Gemini (dry-run included). Aborting.");
		process.exit(1);
	}
	if (RUN_GEOCODE && !process.env.GOOGLE_MAPS_API_KEY) {
		console.error("GOOGLE_MAPS_API_KEY is not set. --geocode calls the Google Geocoding API on cache misses (dry-run included). Aborting.");
		process.exit(1);
	}

	const db = new Database(DB_PATH);
	db.pragma("journal_mode = WAL");

	try {
		preflight(db);
		const passes = ["1:normalize"];
		if (RUN_REOCR) passes.push("2:reocr");
		if (RUN_GEOCODE) passes.push("3:geocode");
		if (RUN_ELD) passes.push("4:eld");
		console.log(
			`backfill-expense-vendor: db=${DB_PATH} passes=[${passes.join(", ")}]` +
			`${Number.isFinite(LIMIT) ? ` limit=${LIMIT}` : ""}${DRY_RUN ? " (DRY RUN)" : ""}`
		);

		passNormalize(db);
		if (RUN_REOCR) await passReocr(db);
		if (RUN_GEOCODE) await passGeocode(db);
		if (RUN_ELD) passEld(db);

		console.log(`\nDone.${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);
	} finally {
		db.close();
	}
}

main().catch((err) => {
	console.error("backfill-expense-vendor failed:", err);
	process.exit(1);
});
