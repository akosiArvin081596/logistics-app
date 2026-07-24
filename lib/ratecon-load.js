// ============================================================
// Rate-con → load creation helpers
// ============================================================
// Pure helpers for the drag-and-drop rate-con ingestion flow
// (POST /api/loads/ratecon/extract + POST /api/loads/from-ratecon).
// These replicate, server-side, what the n8n "Dispatch v2 (Fixed)" workflow
// does after its Information Extractor node — see Dispatch-v2-fixed.json,
// nodes: Validate Load ID, Check Existing Load, RATE UPDATE,
// JOB DETAILS ENTRY, Google Maps Distance, Calculate Rate Per Mile,
// Google Sheets2.
//
// Nothing here touches the network, Google Sheets, Drive, or SQLite —
// callers pass in already-fetched rows / API responses and write the
// results themselves. Same rationale (and shape) as lib/bison-invoice.js.
//
// Exports:
//   normalizeLoadId(v)                          -> comparison key for a Load ID
//   extractionWarnings(fields)                  -> string[] for the review UI
//   cityStateZip(addr)                          -> "City, ST ZIP" (n8n verbatim)
//   calculateRatePerMile(dm, fields)            -> { distance_miles, ... } (n8n verbatim)
//   buildPickupInfo(fields)                     -> "Company REF/PU#: 123"
//   buildJobTrackingRow(headers, fields, extra) -> values[] in header order
//   buildMappedRow(headers, mapping, existing)  -> values[] for an upsert
//   findRowIndexByColumn(rows, colName, value)  -> 1-based sheet row, or -1

"use strict";

// ------------------------------------------------------------
// Small shared primitives
// ------------------------------------------------------------

// Sheet headers are matched on their trimmed/lowercased form because the live
// Job Tracking tab really does carry a column literally named "  Payment  "
// (leading + trailing spaces) and the Payments Table one named " Job ID".
function normHeader(h) {
	return String(h == null ? "" : h).trim().toLowerCase();
}

function str(v) {
	return v == null ? "" : String(v).trim();
}

// Comparison key for Load IDs. Mirrors deduplicateLoads()/POST /api/data in
// server.js: trim, lowercase, drop a leading "#".
function normalizeLoadId(v) {
	return String(v == null ? "" : v).trim().toLowerCase().replace(/^#/, "");
}

// ------------------------------------------------------------
// Extraction warnings (POST /api/loads/ratecon/extract)
// ------------------------------------------------------------
// Human-readable, ordered so the most blocking issue reads first. The review
// modal highlights the matching inputs; only a blank Load Number is actually
// fatal (POST /api/loads/from-ratecon rejects it with a 400).
function extractionWarnings(fields) {
	const f = fields || {};
	const warnings = [];
	if (!str(f["Load Number"])) {
		warnings.push("No Load Number found in the rate-con — enter it manually before creating the load.");
	}
	if (!str(f["Rate"])) {
		warnings.push("No Rate found — the load will be created with a blank payment amount.");
	}
	if (!str(f["Pickup Address"])) {
		warnings.push("No Pickup Address found — distance and rate-per-mile cannot be calculated.");
	}
	if (!str(f["Drop-off Address"])) {
		warnings.push("No Drop-off Address found — distance and rate-per-mile cannot be calculated.");
	}
	return warnings;
}

// ------------------------------------------------------------
// n8n "Calculate Rate Per Mile" node — ported verbatim
// ------------------------------------------------------------
// Source: Dispatch-v2-fixed.json → node "Calculate Rate Per Mile" (jsCode).
// Keep this byte-for-byte equivalent to the workflow so an email-ingested load
// and a dropped-PDF load produce identical Job Details rows.
function cityStateZip(addr) {
	const match = addr.match(/([^,]+),\s*([A-Z]{2})\s*(\d{5})/i);
	if (match) return `${match[1].trim()}, ${match[2].toUpperCase()} ${match[3]}`;
	const parts = addr.split(",");
	return parts.length >= 2 ? parts.slice(-2).join(",").trim() : addr;
}

// `distanceMatrix` is the parsed JSON body of the Google Distance Matrix call
// (the n8n "Google Maps Distance" HTTP Request node). `fields` is the rate-con
// field object. A Maps failure — unset key, quota, ZERO_RESULTS, a thrown
// fetch — arrives here as null/garbage and falls through to the same
// all-zeros / "Distance unavailable" result the n8n node produces, so a Maps
// outage can never block load creation.
function calculateRatePerMile(distanceMatrix, fields) {
	const f = fields || {};
	const rows = distanceMatrix && distanceMatrix.rows;
	const element = rows && rows[0] && rows[0].elements && rows[0].elements[0];

	if (!element || element.status !== "OK" || !element.distance) {
		return {
			distance_miles: 0,
			distance_text: "N/A",
			payment: 0,
			rate_per_mile: "0",
			details: "Distance unavailable",
		};
	}

	const distanceMiles = Math.round(element.distance.value / 1609.34);
	const rateStr = String(f["Rate"] == null ? "" : f["Rate"]) || "0";
	// Deviation from the n8n node (deliberate): an unparseable rate yields NaN
	// there and writes the literal string "NaN" into the sheet. Coerce to 0 so
	// the Payment / Rate Per Mile cells stay numeric.
	const parsed = parseFloat(rateStr.replace(/[$,]/g, ""));
	const payment = Number.isFinite(parsed) ? parsed : 0;
	const ratePerMile = distanceMiles > 0 ? (payment / distanceMiles).toFixed(2) : "0";

	const pickup = str(f["Pickup Address"]);
	const dropoff = str(f["Drop-off Address"]);

	return {
		distance_miles: distanceMiles,
		distance_text: element.distance.text || "",
		payment: payment,
		rate_per_mile: ratePerMile,
		details: `${cityStateZip(pickup)} - ${cityStateZip(dropoff)}`,
	};
}

// ------------------------------------------------------------
// n8n "JOB DETAILS ENTRY" node — Pickup Info concatenation
// ------------------------------------------------------------
// "<Pickup Company Information> REF/PU#: <P/U Reference Number>" plus, when a
// distinct delivery reference exists, ", DEL#: <Delivery Reference Number>".
// Returns "" rather than a bare "REF/PU#:" when the rate-con carried none of
// the three values.
function buildPickupInfo(fields) {
	const f = fields || {};
	const company = str(f["Pickup Company Information"]);
	const pu = str(f["P/U Reference Number"]);
	const del = str(f["Delivery Reference Number"]);
	if (!company && !pu && !del) return "";
	let out = `${company} REF/PU#: ${pu}`;
	if (del && del !== pu) out += `, DEL#: ${del}`;
	return out.trim();
}

// ------------------------------------------------------------
// Job Tracking row builder
// ------------------------------------------------------------
// Header-order → values[] mapping. Mirrors client/src/views/NewJobView.vue
// (submit(), the `hdrs.map(h => ...)` block) so a dropped rate-con and a
// hand-typed job produce the same row shape — including the regex-based
// column detection that lets the sheet's column names drift.
//
// Two branches exist here that NewJobView has no equivalent for:
//   * Documents — the n8n JOB DETAILS ENTRY node writes `BOL Number` ||
//     `Load Number` there; the manual form leaves it blank.
//   * Owner ID  — forced to "0" (company load). server.js still runs the
//     value through validateOwnerIdCell() before writing.
//
// `extras` = { today, contractId, ownerId, trailerNumber, driver }.
// `driver` defaults to "" on purpose: dispatch happens from the dashboard,
// and that is the path that emits the driver socket event + notification.
function buildJobTrackingRow(headers, fields, extras) {
	const f = fields || {};
	const x = extras || {};
	const today = x.today || new Date().toISOString().split("T")[0];
	const ownerId = x.ownerId == null ? "0" : String(x.ownerId);
	const contractId = x.contractId == null ? "" : String(x.contractId);
	const driver = x.driver == null ? "" : String(x.driver);

	const loadId = str(f["Load Number"]);
	const rate = str(f["Rate"]);
	const pickupAddress = str(f["Pickup Address"]);
	const dropoffAddress = str(f["Drop-off Address"]);
	const trailerNumber = x.trailerNumber != null ? String(x.trailerNumber) : str(f["Trailer Number"]);
	const documents = str(f["BOL Number"]) || loadId;
	const pickupInfo = buildPickupInfo(f);

	return (headers || []).map((h) => {
		const hl = normHeader(h);

		// Owner ID — company load unless a caller overrides. Checked first so it
		// can never fall through to a looser id/date match.
		if (/^owner.?id$/i.test(hl)) return ownerId;

		// Contract ID
		if (/^contract.?id$/i.test(hl)) return contractId;

		// Load ID
		if (/load.?id|job.?id/i.test(hl)) return loadId;

		// Trailer Number
		if (/trailer.*num|trailer.?#/i.test(hl)) return trailerNumber;

		// Status — always Unassigned on creation
		if (/^(job.?)?status$/i.test(hl)) return "Unassigned";

		// Driver — blank on creation (assigned later from the dashboard)
		if (/^driver$/i.test(hl)) return driver;

		// Rate / Payment (the live header is literally "  Payment  ")
		if (/^(rate|amount|revenue|pay|payment|charge)$/i.test(hl)) return rate;

		// Broker
		if (/broker.*contact|contact.*name/i.test(hl)) return str(f["Broker Name"]);
		if (/phone/i.test(hl)) return str(f["Broker Phone"]);
		if (/email/i.test(hl)) return str(f["Broker Email"]);

		// Pickup Info (shipper/facility name) — must be before the address regex
		if (/pickup.*info|origin.*info/i.test(hl)) return pickupInfo;

		// Pickup Address
		if (/pickup.*addr|origin.*addr|shipper.*addr/i.test(hl)) return pickupAddress;
		if (/origin.*city|pickup.*city|shipper.*city/i.test(hl)) return pickupAddress;
		if (/(origin|pickup|shipper).*lat/i.test(hl)) return x.pickupLat ? String(x.pickupLat) : "";
		if (/(origin|pickup|shipper).*l(on|ng)/i.test(hl)) return x.pickupLng ? String(x.pickupLng) : "";
		if (/pickup.*date|pickup.*appoint/i.test(hl)) return str(f["Pickup Appointment Time"]);

		// Drop-off Info (receiver/facility name) — must be before the address regex
		if (/drop.*info|dest.*info/i.test(hl)) return str(f["Drop-off Company Information"]);

		// Drop-off Address
		if (/drop.*addr|dest.*addr|receiver.*addr|delivery.*addr/i.test(hl)) return dropoffAddress;
		if (/dest.*city|drop.*city|receiver.*city|delivery.*city|consignee/i.test(hl)) return dropoffAddress;
		if (/(dest|drop|receiver|delivery).*lat/i.test(hl)) return x.dropoffLat ? String(x.dropoffLat) : "";
		if (/(dest|drop|receiver|delivery).*l(on|ng)/i.test(hl)) return x.dropoffLng ? String(x.dropoffLng) : "";
		if (/drop.*date|deliv.*date|drop.*appoint|deliv.*appoint/i.test(hl)) return str(f["Delivery Appointment Time"]);

		// Details
		if (/^details$/i.test(hl)) return str(f["Details"]);

		// Documents — n8n writes the BOL number here, falling back to the load ID
		if (/^documents?$/i.test(hl)) return documents;

		// Auto-fill defaults
		if (/phase.*progress/i.test(hl)) return "Heading to Pickup";
		if (/carrier.*stage/i.test(hl)) return "Waiting on Documents";
		if (/assigned.*date/i.test(hl)) return today;
		if (/status.*update.*date/i.test(hl)) return today;

		return "";
	});
}

// ------------------------------------------------------------
// Append-or-update helpers (Payments Table / Job Details)
// ------------------------------------------------------------
// Sheets API v4 has no native appendOrUpdate (the n8n node fakes it the same
// way): read the tab, look for a matching key, values.update that row or
// values.append a new one.

// Build a full row in header order. Mapped columns take the supplied value;
// every other column keeps whatever the existing row held (or "" on append),
// so an update never blanks out columns this feature doesn't own — e.g. the
// Payments Table's Invoice Number / Payment Status.
function buildMappedRow(headers, mapping, existingRow) {
	const lookup = new Map();
	for (const key of Object.keys(mapping || {})) {
		lookup.set(normHeader(key), mapping[key]);
	}
	return (headers || []).map((h, i) => {
		const key = normHeader(h);
		if (lookup.has(key)) {
			const v = lookup.get(key);
			return v == null ? "" : String(v);
		}
		const existing = existingRow && existingRow[i];
		return existing == null ? "" : existing;
	});
}

// Same shape as buildMappedRow, but it will never overwrite a cell that
// already holds a different non-empty value — those columns keep what they
// had and their names come back in `conflicts` so the caller can warn.
// Used for the Payments Table, where a matched row may be a *settled* payment
// (Payment Amount / Invoice Number / Payment Date already filled) belonging to
// an older load whose Job Tracking row was archived away. Filling blanks is
// still useful — completing a half-written row is the whole point of an upsert
// — but silently rewriting a booked amount is not something a load-creation
// flow should ever do.
function buildMappedRowPreservingFilled(headers, mapping, existingRow) {
	const lookup = new Map();
	for (const key of Object.keys(mapping || {})) {
		lookup.set(normHeader(key), mapping[key]);
	}
	const conflicts = [];
	const values = (headers || []).map((h, i) => {
		const key = normHeader(h);
		const existing = existingRow && existingRow[i] != null ? existingRow[i] : "";
		if (!lookup.has(key)) return existing;
		const raw = lookup.get(key);
		const incoming = raw == null ? "" : String(raw);
		const current = String(existing).trim();
		if (current === "") return incoming;
		if (current === incoming.trim()) return existing;
		conflicts.push(String(h).trim());
		return existing;
	});
	return { values, conflicts };
}

// `rows` is the raw values array straight off the Sheets API (row 0 = headers).
// Returns the 1-based sheet row index of the first match, or -1. Matching is
// Load-ID normalized (trim / lowercase / leading "#"), which is what makes
// " Job ID" = "#12345" match a Load Number of "12345".
function findRowIndexByColumn(rows, columnName, value) {
	const all = Array.isArray(rows) ? rows : [];
	if (all.length === 0) return -1;
	const headers = all[0] || [];
	const target = normHeader(columnName);
	const colIdx = headers.findIndex((h) => normHeader(h) === target);
	if (colIdx < 0) return -1;
	const needle = normalizeLoadId(value);
	if (!needle) return -1;
	for (let i = 1; i < all.length; i++) {
		const cell = (all[i] || [])[colIdx];
		if (normalizeLoadId(cell) === needle) return i + 1; // 1-based, header is row 1
	}
	return -1;
}

module.exports = {
	normHeader,
	normalizeLoadId,
	extractionWarnings,
	cityStateZip,
	calculateRatePerMile,
	buildPickupInfo,
	buildJobTrackingRow,
	buildMappedRow,
	buildMappedRowPreservingFilled,
	findRowIndexByColumn,
};
