"use strict";
// Receipts auto-approve after the fact (plan §4.12), read only: the month close's count of receipts
// the pass approved, and what the daily integrity check (check 12, lib/integrity-check.js) names
// about them. Nothing here changes a receipt: a person decides what to do.

const { PASS_NAME } = require("./receipt-auto-approve-pass");
const { findDuplicateGroups } = require("./receipt-duplicates");
const { REFUEL_COALESCE_MS } = require("./fuel-model");

const str = (v) => (v == null ? "" : String(v)).trim();
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const PLACE_COLS = ["location_city", "location_state", "location_lat", "location_lng"];

function parseJson(text, fallback) {
	try {
		const v = JSON.parse(text);
		return v == null ? fallback : v;
	} catch {
		return fallback;
	}
}

// ── the month close ─────────────────────────────────────────────────────────
// Receipts booked to `period` whose standing approval is the pass's own: Approved, and the "who set
// it" record still names the pass. Never throws: the close is already done when this is read, so a
// count that can't be read is logged and the close's text stays as it was.
function approvedInPeriod(db, period, periodExpr, log = console) {
	try {
		return db.prepare(`SELECT id FROM expenses WHERE status = 'Approved' AND status_by_role = 'system' AND status_by_name = ?
			AND ${periodExpr} = ? ORDER BY id`).all(PASS_NAME, String(period || ""));
	} catch (e) {
		log.error(`[receipt-auto-approve] the close's count of receipts approved automatically could not be read: ${(e && e.message) || e}`);
		return [];
	}
}

// Said only when the month holds one, so a close with none reads exactly as before.
function closeAuditPart(receipts, idList) {
	return receipts && receipts.length ? `; ${receipts.length} receipt(s) approved automatically: ${idList(receipts)}` : "";
}
function closeNoticePart(receipts, monthLabel, idList) {
	return receipts && receipts.length
		? ` ${receipts.length} receipt(s) booked to ${monthLabel} were approved automatically (receipt ${idList(receipts)}).`
		: "";
}

// ── the daily check ─────────────────────────────────────────────────────────
function fillKey(f) {
	if (!f) return null;
	return { id: Number(f.id), vehicle: str(f.routemate_vehicle_id), start: Number(f.start_ms), day: str(f.local_day) };
}

// One fill: the same row, or the same truck and business day with a start within one fill's window.
// A re-detection prunes an episode and inserts it again under a new id (L18), and the detector never
// keeps two fills on one truck that close together (lib/fuel-model.js REFUEL_COALESCE_MS).
function sameFill(was, now) {
	if (!was || !now) return false;
	if (Number.isInteger(was.id) && was.id === now.id) return true;
	return !!was.vehicle && was.vehicle === now.vehicle && !!was.day && was.day === now.day
		&& Number.isFinite(was.start) && Number.isFinite(now.start) && Math.abs(was.start - now.start) <= REFUEL_COALESCE_MS;
}

const placeValue = (v) => (v == null || v === "" ? null : v);
const placeText = (r) => [str(r.location_city), str(r.location_state)].filter(Boolean).join(", ");

// Every finding check 12 can name, each with the key it is named once under, and the counts of
// findings left unraised because their receipt's month is closed or can't be told. Only on-mode
// rows: a shadow verdict is never shown to people. `lockedMonths` is the set of closed months, or
// null when the lock table can't be read (then nothing is raised).
function evidenceChanges(db, { periodExpr, lockedMonths }) {
	const out = { findings: [], closed: 0, unknownMonth: 0 };
	const reviews = db.prepare(`SELECT expense_id, verdict, reasons, evidence, applied_at, applied_row FROM receipt_auto_reviews
		WHERE mode = 'on' AND ((applied_at <> '' AND undone_at = '') OR verdict = 'hold') ORDER BY expense_id`).all();
	if (!reviews.length) return out;
	const rowOf = db.prepare(`SELECT id, status, status_by_role, status_by_name, status_at, date, truck_unit,
		location_city, location_state, location_lat, location_lng, ${periodExpr} AS period FROM expenses WHERE id = ?`);
	const hasFills = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fuel_events'").get();
	const fillOf = hasFills ? db.prepare("SELECT id, routemate_vehicle_id, start_ms, local_day FROM fuel_events WHERE expense_id = ?") : null;
	const fillById = hasFills ? db.prepare("SELECT id, routemate_vehicle_id, start_ms, local_day FROM fuel_events WHERE id = ?") : null;

	// Rule 8's own groups: every receipt that isn't Rejected, a group a person kept left out.
	let groupOf = null;
	const groups = () => {
		if (groupOf) return groupOf;
		const rows = db.prepare(`SELECT id, date, type, driver, truck_unit, amount, gallons, vendor, vendor_normalized, status FROM expenses
			WHERE COALESCE(status, '') != 'Rejected'`).all();
		let suppressedIds = new Set();
		try {
			suppressedIds = new Set(db.prepare("SELECT entity_id FROM audit_trail WHERE action = 'expense_duplicate_override' AND entity = 'expense'").all()
				.map((r) => Number(r.entity_id)).filter(Number.isFinite));
		} catch { /* none kept, which names more */ }
		groupOf = new Map();
		for (const g of findDuplicateGroups(rows, { suppressedIds })) {
			const ids = g.rows.map((r) => Number(r.id)).sort((a, b) => a - b);
			for (const id of ids) groupOf.set(id, ids);
		}
		return groupOf;
	};

	const monthState = (row) => {
		const months = [str(row.period), str(row.date).slice(0, 7)];
		if (lockedMonths == null || !months.every((m) => MONTH_RE.test(m))) return "unknown";
		return months.some((m) => lockedMonths.has(m)) ? "closed" : "open";
	};

	for (const r of reviews) {
		const id = Number(r.expense_id);
		const row = rowOf.get(id);
		if (!row) continue;
		const ev = parseJson(r.evidence, {});
		const base = { id, truck: str(row.truck_unit), date: str(row.date), period: str(row.period) };
		const found = [];
		if (r.applied_at) {
			// Still the pass's approval: a person's later write, or the undo, makes it theirs.
			if (!(row.status === "Approved" && row.status_by_role === "system" && row.status_by_name === PASS_NAME && row.status_at === r.applied_at)) continue;
			const link = ev && ev.link && typeof ev.link === "object" ? ev.link : null;
			if (link && hasFills) {
				const n = Number(link.fill);
				const stored = link.fill != null && link.fill !== "" && Number.isInteger(n) && n > 0 ? n : null;
				// An approval recorded without the fill's key is judged by the stored row while it lasts, then by its id.
				const was = link.vehicle && link.day && link.start != null && Number.isFinite(Number(link.start))
					? { id: stored, vehicle: str(link.vehicle), start: Number(link.start), day: str(link.day) }
					: fillKey(stored == null ? null : fillById.get(stored)) || { id: stored };
				const now = fillKey(fillOf.get(id));
				if (!sameFill(was, now)) {
					found.push(now
						? { ...base, kind: "link_moved", fill: { id: now.id, day: now.day }, key: `link|${now.vehicle}|${now.day}` }
						: { ...base, kind: "link_gone", key: "link|none" });
				}
			}
			const snap = parseJson(r.applied_row, null);
			if (snap && typeof snap === "object" && PLACE_COLS.every((k) => k in snap)) {
				if (PLACE_COLS.some((k) => placeValue(snap[k]) !== placeValue(row[k]))) {
					found.push({ ...base, kind: "place", from: placeText(snap), to: placeText(row), key: `place|${JSON.stringify(PLACE_COLS.map((k) => placeValue(row[k])))}` });
				}
			}
			const members = groups().get(id);
			if (members) found.push({ ...base, kind: "duplicate", with: members.filter((m) => m !== id), key: `duplicate|${members.join(",")}` });
		} else if (r.verdict === "hold" && parseJson(r.reasons, []).includes("SAME_PAPER") && row.status !== "Rejected") {
			// The held copy still counts; its twin was already decided, by a person or by the pass.
			for (const t of Array.isArray(ev.twins) ? ev.twins : []) {
				const twin = rowOf.get(Number(t));
				if (!twin || (twin.status !== "Approved" && twin.status !== "Rejected")) continue;
				const byPass = twin.status === "Approved" && twin.status_by_role === "system" && twin.status_by_name === PASS_NAME;
				found.push({ ...base, kind: "twin", twin: Number(twin.id), twinStatus: twin.status, twinBy: byPass ? "pass" : "person", key: `twin|${Number(twin.id)}` });
			}
		}
		if (!found.length) continue;
		// Closed months are final as recorded: counted for the log line, never raised.
		const state = monthState(row);
		if (state === "closed") out.closed += found.length;
		else if (state === "unknown") out.unknownMonth += found.length;
		else out.findings.push(...found);
	}
	return out;
}

module.exports = {
	approvedInPeriod,
	closeAuditPart,
	closeNoticePart,
	sameFill,
	evidenceChanges,
};
