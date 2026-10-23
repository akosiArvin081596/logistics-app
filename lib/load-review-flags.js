// THE DASHBOARD'S `_review` CODES (Needs Confirmation pickup plan, section 6, decision 8):
// one server function adds a single `_review` list to the dashboard's request-local rows,
// from each feature's own table. The client words the codes (client/src/lib/loadReview.js);
// it never works one out.
//
// - Called by GET /api/dashboard on the raw rows right after enrichLocations() and BEFORE
//   sanitizeBrokerColumns(), so the match is on the stored Load ID and a Load ID withheld
//   from a Dispatcher (#549) still gets its codes (the sanitize copy carries `_review`).
// - Each entry is { code, ...days }: dates only, never a Load ID, broker or contact text.
// - Today's one source is the Needs Confirmation pickup reason (lib/ratecon-pickup-
//   confirmation.js reviewCode()), behind RATECON_PICKUP_CONFIRMATION_REVIEW_ENABLED: the
//   caller passes `pickup` only with the flag on, so with it off no row gets the key.
//   The driver-instructions codes stay on `_instructionsReview` (they shipped first).
//
// Pure: the caller reads the tables (one query per table per call) and passes them in.
"use strict";

const pickupConfirmation = require("./ratecon-pickup-confirmation");
const tripWorkDays = require("./trip-work-days");
const personEditHold = require("./person-edit-hold");

const PICKUP_HEADER_RE = /pickup.*appo|pickup.*date/i;
const STATUS_HEADER_RE = /^(job[\s._-]?)?status$/i;

function headerText(h) {
	return h === undefined || h === null ? "" : String(h);
}

// The Pickup Appointment header (the person-hold column) and the status header, or null.
function pickupHeaderOf(headers) {
	const h = (headers || []).find((x) => personEditHold.personHoldColumn(x) && PICKUP_HEADER_RE.test(headerText(x).trim()));
	return h === undefined ? null : h;
}
function statusHeaderOf(headers) {
	const h = (headers || []).find((x) => STATUS_HEADER_RE.test(headerText(x).trim()));
	return h === undefined ? null : h;
}

// Adds `_review` to each row that has a code. rows: header-keyed objects (request-local);
// loadIdHeader: the Load ID column's header; keyOf(loadId): the tables' load key.
// pickup (null = off): { records: Map key -> ratecon_pickup_readings row, cellRows: Map
// key -> load_cell_writes rows of the Pickup Appointment column, events: Map key ->
// load_status_history rows, accountingMonths(rowCells) (loadRowAccountingMonths()),
// isClosed(month) (periodWriteLocked()), zone (APP_TIMEZONE) }. Answers how many rows
// got a code.
function annotateLoadReview({ headers, rows, loadIdHeader, keyOf, pickup = null } = {}) {
	if (!pickup || !Array.isArray(headers) || !Array.isArray(rows) || typeof keyOf !== "function" || loadIdHeader == null) return 0;
	const pickupHeader = pickupHeaderOf(headers);
	if (pickupHeader === null) return 0;
	const statusHeader = statusHeaderOf(headers);
	let n = 0;
	for (const r of rows) {
		if (!r || typeof r !== "object") continue;
		const key = keyOf(r[loadIdHeader]);
		if (!key) continue;
		const record = pickup.records.get(key);
		if (!record) continue;
		const code = pickupConfirmation.reviewCode({
			record,
			stored: r[pickupHeader],
			cellRows: pickup.cellRows.get(key) || [],
			status: statusHeader === null ? "" : r[statusHeader],
			months: pickup.accountingMonths(headers.map((h) => (r[h] == null ? "" : r[h]))),
			isClosed: pickup.isClosed,
			firstTap: tripWorkDays.firstPickupTap(pickup.events.get(key) || [], { zone: pickup.zone }),
		});
		if (!code) continue;
		r._review = [...(Array.isArray(r._review) ? r._review : []), code];
		n++;
	}
	return n;
}

module.exports = { annotateLoadReview, pickupHeaderOf, statusHeaderOf };
