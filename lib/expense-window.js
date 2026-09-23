"use strict";

/**
 * WHICH LOADS A DRIVER MAY STILL ADD A RECEIPT TO — the one definition.
 *
 * Owner's rule, 2026-09-23: an ACTIVE load, or one DELIVERED WITHIN THE LAST
 * 7 DAYS. It exists because a driver could not attach fuel receipts to loads he
 * had already delivered, so dispatch had to key them in by hand.
 *
 * Two callers in server.js, and they must never disagree about a load:
 *   • GET /api/driver/:driverName computes the verdict for every load and ships
 *     it as `load._expenseWindow`. The driver app renders from THAT — it never
 *     re-derives the rule from a status (client/src/lib/expenseWindow.js only
 *     re-checks `closesAt` against the phone's clock).
 *   • POST /api/expenses enforces it for the Driver role
 *     (sentIfDriverExpenseWindowClosed), so the app is not the only gate.
 *
 * The decisions, each deliberate:
 *
 *   • 7 DAYS IS ELAPSED TIME — 7 × 24 h from the delivery, INCLUSIVE of the exact
 *     boundary (open while now <= deliveredAt + 7 d) — not Central calendar days.
 *     The drivers work across several US zones, and the phone and the server must
 *     reach the same answer from the same instant; elapsed milliseconds need no
 *     zone and have no DST edge. Timestamps are still SHOWN in Central, with a
 *     zone label, like every other instant in this app.
 *
 *   • "DELIVERED AT" IS WHEN THE LOAD ENTERED A COMPLETED STATUS (Delivered /
 *     Completed / POD Received) according to load_status_history — i.e. when the
 *     driver tapped Delivered. That column is a button press, not a movement
 *     (CLAUDE.md, load-haul.js), which is exactly the right notion here: "when
 *     did this load stop being the driver's work in progress". It is also the
 *     only candidate that is an unambiguous instant — the sheet's "Status Update
 *     Date" / "Completion Date" are zone-less text with two eras (UTC before
 *     2026-08-03, Houston after) and anyone with the sheet can edit them.
 *     See deliveredAtFromHistory() for why the ENTRY, not the latest row.
 *
 *   • NO RECORDED DELIVERY TIME → NOT ELIGIBLE ('unknown'). A load marked
 *     delivered outside the tracked paths (a sheet edit) has no history row, and
 *     guessing a time would either lock a driver out early or leave the window
 *     open forever. The driver is told to ask dispatch, who can still log it —
 *     the server gate is Driver-role only.
 *
 *   • A CANCELLED LOAD IS NEVER ELIGIBLE, whatever its history says. Checked
 *     first, so no other branch can open it.
 *
 * Pure: no database, no network, no clock of its own beyond the `now` default.
 */

// Owner's number. Change it here and both the driver app and the server gate
// follow — the app reads the verdict, never this constant.
const EXPENSE_WINDOW_DAYS = 7;
const EXPENSE_WINDOW_MS = EXPENSE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// The same "active" set the driver app has always shown the expense form on
// (LoadDetail's isActiveLoad) and the telemetry paths use to find a driver's
// working load. client/src/lib/expenseWindow.js carries the client's copy;
// scripts/test-expense-load-window-client.mjs pins the two to the same answers.
const ACTIVE_STATUS_RE = /^(assigned|dispatched|heading to shipper|at shipper|loading|in transit|at receiver|unloading)$/i;
// completedStatuses, as every pay and revenue path spells it.
const COMPLETED_STATUS_RE = /^(delivered|completed|pod received)$/i;
// CANCELED_STATUS_RE in server.js — the excludeDroppedLoads() rule.
const CANCELLED_STATUS_RE = /^(cancel|canceled|cancelled)$/i;

const text = (v) => String(v == null ? "" : v).trim();

function isActiveLoadStatus(status) {
	return ACTIVE_STATUS_RE.test(text(status));
}
function isCompletedLoadStatus(status) {
	return COMPLETED_STATUS_RE.test(text(status));
}
function isCancelledLoadStatus(status) {
	return CANCELLED_STATUS_RE.test(text(status));
}

// SQLite's CURRENT_TIMESTAMP is UTC but zone-less ("2026-09-16 15:04:05"), and
// Date.parse reads that shape as LOCAL time — hours out on any machine not set to
// UTC. Read it as UTC, the only thing it can mean.
const SQLITE_UTC_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)$/;
// Anything else must carry its own zone. A bare "9/16/2026" is refused rather
// than parsed in whatever zone this process happens to run in.
const ISO_ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

// Epoch ms for an instant, or NaN when the value is not one we can trust.
function toEpochMs(v) {
	if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
	if (v instanceof Date) return v.getTime();
	if (typeof v !== "string") return NaN;
	const s = v.trim();
	if (!s || s.length > 40) return NaN;
	const bare = SQLITE_UTC_RE.exec(s);
	if (bare) return Date.parse(`${bare[1]}T${bare[2]}Z`);
	return ISO_ZONED_RE.test(s) ? Date.parse(s) : NaN;
}

/**
 * When the load's CURRENT delivered run began, from its load_status_history rows
 * ({ old_status, new_status, changed_at }). ISO string, or null when history
 * cannot say.
 *
 * ⚠️ THE ENTRY INTO THE COMPLETED SET, NOT THE LATEST COMPLETED ROW. An admin
 * moving Delivered → Completed ten days later is not a second delivery; taking
 * the latest row would reopen a closed window. Conversely a load reverted out of
 * the completed set (Delivered → In Transit) and delivered again WAS delivered
 * again, so any later non-completed row resets the run.
 *
 * "Was the status before this row completed?" is answered by the row's OWN
 * old_status whenever it has one — that is what the sheet said at the moment of
 * the write — and by the previous history row only when it does not. So a run
 * that began OFF the record (the status reached Delivered by a sheet edit, and
 * history's first word on it is Delivered → Completed) yields null: we do not
 * know when it was delivered, and must not pretend the later row is the answer.
 *
 * Rows with no parseable time are dropped, which can only move the answer toward
 * null — never invent a later delivery.
 */
function deliveredAtFromHistory(rows) {
	const list = (Array.isArray(rows) ? rows : [])
		.map((r, i) => ({
			i,
			t: toEpochMs(r && (r.changed_at != null ? r.changed_at : r.changedAt)),
			to: text(r && (r.new_status != null ? r.new_status : r.newStatus)),
			from: text(r && (r.old_status != null ? r.old_status : r.oldStatus)),
		}))
		.filter((r) => Number.isFinite(r.t) && r.to)
		// Chronological; equal stamps (one-second resolution) keep caller order,
		// which the callers make `id ASC`.
		.sort((a, b) => a.t - b.t || a.i - b.i);
	let enteredMs = null;
	let inCompleted = false;
	for (const r of list) {
		if (COMPLETED_STATUS_RE.test(r.to)) {
			const wasCompleted = r.from ? COMPLETED_STATUS_RE.test(r.from) : inCompleted;
			if (!wasCompleted) enteredMs = r.t;
			inCompleted = true;
		} else {
			inCompleted = false;
			enteredMs = null;
		}
	}
	return enteredMs == null ? null : new Date(enteredMs).toISOString();
}

function verdict(eligible, state, deliveredMs, closesMs) {
	return {
		eligible,
		// 'active' | 'open' | 'closed' | 'unknown' | 'cancelled' | 'none'
		state,
		deliveredAt: Number.isFinite(deliveredMs) ? new Date(deliveredMs).toISOString() : null,
		closesAt: Number.isFinite(closesMs) ? new Date(closesMs).toISOString() : null,
	};
}

/**
 * The verdict for ONE sheet row: may a driver add a receipt to it at `now`?
 *
 *   status      the row's status cell
 *   deliveredAt deliveredAtFromHistory() for the row's load id (ISO / epoch ms / null)
 *   now         the instant to judge at (defaults to the current time)
 *
 * → { eligible, state, deliveredAt, closesAt }
 *     active     working load — eligible, no clock
 *     open       delivered, inside the window — eligible until closesAt (inclusive)
 *     closed     delivered, window over
 *     unknown    delivered, but no recorded delivery time
 *     cancelled  never eligible
 *     none       any other status (Unassigned, blank, legacy values)
 */
function expenseWindow({ status, deliveredAt, now } = {}) {
	const s = text(status);
	if (CANCELLED_STATUS_RE.test(s)) return verdict(false, "cancelled");
	if (ACTIVE_STATUS_RE.test(s)) return verdict(true, "active");
	if (!COMPLETED_STATUS_RE.test(s)) return verdict(false, "none");
	const deliveredMs = toEpochMs(deliveredAt);
	if (!Number.isFinite(deliveredMs)) return verdict(false, "unknown");
	const closesMs = deliveredMs + EXPENSE_WINDOW_MS;
	const nowMs = Number.isFinite(toEpochMs(now)) ? toEpochMs(now) : Date.now();
	// Inclusive: at exactly 7 × 24 h the window is still open.
	const open = nowMs <= closesMs;
	return verdict(open, open ? "open" : "closed", deliveredMs, closesMs);
}

// One load id can sit on more than one sheet row (a rate-con that arrived as two
// emails in one poll — CLAUDE.md, "A LOAD ARRIVES AS TWO EMAILS"), and a live row
// can sit beside a cancelled copy. The load takes receipts if ANY of the driver's
// rows does; otherwise the most informative refusal is reported.
const STATE_RANK = { active: 6, open: 5, closed: 4, unknown: 3, none: 2, cancelled: 1 };
function bestExpenseWindow(windows) {
	let best = null;
	for (const w of Array.isArray(windows) ? windows : []) {
		if (!w || !STATE_RANK[w.state]) continue;
		if (!best || STATE_RANK[w.state] > STATE_RANK[best.state]) best = w;
	}
	return best;
}

// Instants are shown in Central with a zone label — the app-wide rule
// (client/src/utils/datetime.js) — even though the window itself is zone-free.
const CENTRAL_FMT = new Intl.DateTimeFormat("en-US", {
	timeZone: "America/Chicago",
	month: "short", day: "numeric", year: "numeric",
	hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
});
function fmtCentral(v) {
	const ms = toEpochMs(v);
	return Number.isFinite(ms) ? CENTRAL_FMT.format(new Date(ms)) : "";
}

/**
 * The driver-facing sentence for a refused receipt. Every branch says what to do
 * next, and none of them contains a word the driver app reads as "the PHOTO was
 * the problem" (ExpenseForm's PHOTO_FAILURE_RE) — nothing here is about the photo.
 */
function refusalMessage(win, loadId) {
	const id = text(loadId);
	const load = id ? `load ${id}` : "this load";
	const Load = id ? `Load ${id}` : "This load";
	switch (win && win.state) {
		case "closed": {
			const until = fmtCentral(win.closesAt);
			return until
				? `Receipts for ${load} could be added until ${until}, ${EXPENSE_WINDOW_DAYS} days after it was delivered. Ask dispatch to add this one.`
				: `Receipts for ${load} could be added for ${EXPENSE_WINDOW_DAYS} days after it was delivered. Ask dispatch to add this one.`;
		}
		case "unknown":
			return `There's no record of when ${load} was delivered, so a receipt can't be added to it here. Ask dispatch to add it.`;
		case "cancelled":
			return `${Load} was cancelled, so receipts can't be added to it. Contact dispatch if that's a mistake.`;
		default:
			return `Receipts can be added to a load while it's active, or for ${EXPENSE_WINDOW_DAYS} days after it's delivered. Ask dispatch to add this one.`;
	}
}

module.exports = {
	EXPENSE_WINDOW_DAYS,
	EXPENSE_WINDOW_MS,
	ACTIVE_STATUS_RE,
	COMPLETED_STATUS_RE,
	CANCELLED_STATUS_RE,
	isActiveLoadStatus,
	isCompletedLoadStatus,
	isCancelledLoadStatus,
	toEpochMs,
	deliveredAtFromHistory,
	expenseWindow,
	bestExpenseWindow,
	fmtCentral,
	refusalMessage,
};
