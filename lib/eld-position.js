// Which ELD fix a truck may show as its position, and what may be measured
// from it (B11). Pure: no database, no network, no clock of its own.
//
// FIXES BEFORE THE LINK (2026-10-16). A device's fixes from before it was
// linked to a truck were taken on another vehicle, or wherever the unit sat;
// they say nothing about this truck. On 2026-09-28 a truck linked to a tracker
// parked in another state since August showed that tracker's 13-day-old fix as
// its live position, 1,010 mi from its load, because the position routes show
// any fix under 14 days old. So a position route shows a fix only if it was
// taken at or after the link.
//
// The link time is the assigned_from of the truck's OPEN eld_device_assignments
// row for that device (server.js eldDeviceLinkedSinceMs()). It is unknown when
// there is no such row, when the time can't be read, or when the row was opened
// by the history seed or the boot reconcile: those carry the moment recording
// began, or the moment a link changed outside the link routes was noticed, not
// the moment the device was linked. An unknown link time keeps the fix, as
// before this rule; the 14-day window (dispatch, driver app) and the 3-hour
// window (customer link) still bound it.
//
// NO ETA FROM AN OLD FIX (2026-10-15). A fix older than 2 hours gives no
// distance and no ETA: both would be measured from where the truck was. The
// browser hides them by the same rule (client/src/lib/fixAge.js
// NO_ETA_AFTER_MS, pinned equal by scripts/test-position-link-time.js), so the
// server asks no paid route for them.

"use strict";

const ETA_MAX_FIX_AGE_MS = 2 * 60 * 60 * 1000;

// assigned_by values whose assigned_from is not a link time.
const LINK_TIME_UNKNOWN_BY = new Set(["system:seed", "system:boot"]);

// The link time of an open eld_device_assignments row ({ assigned_from,
// assigned_by }) in epoch ms, or null when it is unknown (see above).
function linkedSinceMs(row) {
	if (!row) return null;
	if (LINK_TIME_UNKNOWN_BY.has(String(row.assigned_by || "").trim())) return null;
	const ms = Date.parse(String(row.assigned_from || ""));
	return Number.isFinite(ms) ? ms : null;
}

// Was the fix taken before the link? Never when the link time is unknown. A
// fix with no readable time, beside a known link, counts as before it.
function fixPredatesLink(fixMs, sinceMs) {
	if (sinceMs === null || sinceMs === undefined || !Number.isFinite(sinceMs)) return false;
	const ms = fixMs === null || fixMs === undefined ? NaN : Number(fixMs);
	return !(Number.isFinite(ms) && ms >= sinceMs);
}

// May a distance or an ETA be measured from a fix this old (ms)? Up to 2
// hours exactly; never for an unknown age.
function fixAllowsEta(ageMs) {
	return ageMs !== null && ageMs !== undefined && Number.isFinite(ageMs) && ageMs <= ETA_MAX_FIX_AGE_MS;
}

module.exports = {
	ETA_MAX_FIX_AGE_MS,
	linkedSinceMs,
	fixPredatesLink,
	fixAllowsEta,
};
