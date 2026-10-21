"use strict";
// ===========================================================================
// The Load ID a NEW load may take: one its own pages can open.
//
// A load's pages fetch it by its Load ID, trimmed. GET
// /api/loads/:loadId/status-history and GET /api/loads/:loadId/haul in
// server.js accept it only when it matches LOAD_ROUTE_ID_RE, and GET
// /api/loads/:loadId/ratecon.pdf (lib/ratecon-pdf-route.js) only when it
// matches RATECON_PDF_ID_RE. A load created with an ID either one refuses (a
// space inside, a "#" after the first character, more than 40 characters)
// half-loads: its details dialog answers 400 "Invalid load id" and
// RATECON_BAD_LOAD_ID.
//
// POST /api/data on Job Tracking holds a new Load ID to both patterns, after
// trimming its edge whitespace, so a load is never created that its own pages
// refuse. Its two callers are New Job and the Data Manager's add-row, so a
// Data Manager append to Job Tracking is held to the same rule (400
// INVALID_LOAD_ID, shown in its error toast); its duplicate-ID warning reads
// the trimmed ID too. This module never decides what those pages accept: the
// two patterns are copies of theirs, pinned equal to them by
// scripts/test-new-job-load-id.mjs, which also pins the client's copy
// (client/src/lib/loadIdRule.js) equal to this one. A stored load is never
// judged by it, and nothing renames one.
//
// Pure: no network, database or file system.
// ===========================================================================

const LOAD_ROUTE_ID_RE = /^[A-Za-z0-9\-_.#]{1,40}$/;
const RATECON_PDF_ID_RE = /^#?[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

const LOAD_ID_RULE_MESSAGE =
	"Load ID can only use letters, numbers, hyphens (-), underscores (_) and dots (.), with no spaces. " +
	"It must start with a letter or number (a # in front is fine) and be at most 40 characters.";

// The ID as the load pages read it: edge whitespace trimmed. Text and numbers
// only (a sheet cell); anything else reads as blank.
function trimLoadId(raw) {
	if (typeof raw === "string") return raw.trim();
	if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
	return "";
}

// Whether a load's pages open this ID.
function loadIdOpenable(raw) {
	const id = trimLoadId(raw);
	return LOAD_ROUTE_ID_RE.test(id) && RATECON_PDF_ID_RE.test(id);
}

// null when the pages open this ID; otherwise the 400 body the create route
// answers, naming the column it read the ID from.
function newLoadIdRefusal(raw, field = "Load ID") {
	if (loadIdOpenable(raw)) return null;
	return { error: LOAD_ID_RULE_MESSAGE, code: "INVALID_LOAD_ID", field };
}

module.exports = {
	LOAD_ROUTE_ID_RE,
	RATECON_PDF_ID_RE,
	LOAD_ID_RULE_MESSAGE,
	trimLoadId,
	loadIdOpenable,
	newLoadIdRefusal,
};
