"use strict";
// Receipts auto-approve on the admin Expenses list (GET /api/expenses/all): the pass's
// mode, each receipt's verdict, and the "Approved automatically" filter. Read-only.
// A verdict is sent only in on mode: during shadow the people it is compared with see none.

const { PASS_NAME } = require("./receipt-auto-approve-pass");

// The status filter's value, as the screen sends it.
const AUTO_FILTER = "Approved automatically";

const CODE_RE = /^[A-Z][A-Z_]{0,39}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATE_RE = /^[A-Z]{2}$/;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const idOf = (v) => (Number.isInteger(v) && v > 0 ? v : null);
function parseJson(text, fallback) {
	try {
		const v = JSON.parse(text);
		return v == null ? fallback : v;
	} catch {
		return fallback;
	}
}

// The list's own field while the pass flag is on; nothing at all while it is off.
function listMeta(mode) {
	return mode === "on" || mode === "shadow" ? { autoApprove: { mode } } : {};
}

// The filter: receipts whose current Approved status is the pass's own write. Null unless
// the pass is on and the filter is asked for, so the route keeps today's status condition.
function statusCondition(mode, status) {
	if (mode !== "on" || status !== AUTO_FILTER) return null;
	return { sql: "(status = 'Approved' AND COALESCE(status_by_role, '') = 'system' AND status_by_name = ?)", params: [PASS_NAME] };
}

// The stored evidence, re-checked: the re-read's values came from the model.
function factsOf(evidenceText) {
	const ev = parseJson(evidenceText, {});
	const link = ev && typeof ev.link === "object" && ev.link ? ev.link : {};
	const r = ev && typeof ev.read === "object" && ev.read ? ev.read : null;
	return {
		fill: idOf(link.fill),
		km: num(link.km),
		read: r ? {
			amount: num(r.amount),
			date: typeof r.date === "string" && DAY_RE.test(r.date) ? r.date : null,
			gallons: num(r.gallons),
			state: typeof r.state === "string" && STATE_RE.test(r.state) ? r.state : null,
		} : null,
	};
}

// A review row against its receipt's current status and record, or null: "checking" (Pending, nobody
// has set it, the pass waits), "held" (Pending, with the codes), "auto" (the pass's approval, still current).
function shape(r) {
	if (r.verdict === "wait" && r.status === "Pending" && r.by_role === "") return { state: "checking" };
	if (r.verdict === "hold" && r.status === "Pending") {
		const codes = parseJson(r.reasons, []);
		return { state: "held", reasons: (Array.isArray(codes) ? codes : []).filter((c) => typeof c === "string" && CODE_RE.test(c)), ...factsOf(r.evidence) };
	}
	if (r.verdict === "approve" && r.status === "Approved" && r.applied_at && !r.undone_at
		&& r.by_role === "system" && r.by_name === PASS_NAME && r.by_at === r.applied_at) {
		return { state: "auto", ...factsOf(r.evidence) };
	}
	return null;
}

// expense id -> its `auto_review`, in on mode only (else null: the list sends no field).
// An unreadable table shows no verdict; the list itself still loads.
function reviewsFor(db, mode) {
	if (mode !== "on") return null;
	const out = new Map();
	let rows = [];
	try {
		rows = db.prepare(`SELECT r.expense_id, r.verdict, r.reasons, r.evidence, r.applied_at, r.undone_at, e.status,
			COALESCE(e.status_by_role, '') AS by_role, COALESCE(e.status_by_name, '') AS by_name, COALESCE(e.status_at, '') AS by_at
			FROM receipt_auto_reviews r JOIN expenses e ON e.id = r.expense_id WHERE r.mode = 'on'`).all();
	} catch {
		return out;
	}
	for (const r of rows) {
		const v = shape(r);
		if (v) out.set(Number(r.expense_id), v);
	}
	return out;
}

module.exports = { AUTO_FILTER, PASS_NAME, listMeta, statusCondition, reviewsFor, shape };
