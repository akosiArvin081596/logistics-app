"use strict";
// Restoring a soft-deleted load (the restore plan of 2026-10-22, Revision 2): what
// the payout ledger would change. The server computes the ledger twice, with
// today's soft-deleted set ("before") and with the load's rows taken out of it
// ("after"), from one Job Tracking snapshot and one rules object
// (restoreLedgerSnapshot() / restoreLedgerChanges() in server.js, which only
// read), and passes both here with its own closed-month answer.
//
// ledgerChanges({ before, after, isClosed }) compares, for every scope (each
// settlable investor, and the company as owner 0) and every month either side
// has, these figures to the cent:
//   revenue    the month's load revenue
//   driverPay  the month's driver pay
//   raw        the month's result before any split (netProfit)
//   payable    an investor's payable after loss carry-forward; null for a scope
//              with no payable (the company)
// and the fleet's months, each figure the sum over the scopes (the fleet is the
// sum of its scopes; computeFleetLedger()). It returns:
//   scopes        [{ ownerId, name, month, closed, revenue, driverPay, raw,
//                  payable }], each figure { before, after, change } in dollars;
//                 only the scope-months where some figure changes, in the order
//                 the scopes come (before's, then any new one), oldest month first
//   fleet         [{ month, closed, revenue, driverPay, raw }], the same way
//   closedMonths  the sorted months a changed row falls in that `isClosed` says
//                 are closed: a restore that would change one is refused
//   dayOnce       { added, removed }: the ledger day-once rule's dropped
//                 driver-days ({ ownerId, driver, day, month, keptMonth, loadId,
//                 keptLoadId }) that appear, or go, with the restore: the days that
//                 move between months, later open months included
//
// Below it, the rest of the restore's pure pieces: the reason check, New Job's
// duplicate message, the preview's invoice lines and possible duplicates, its
// fingerprint and the audit text.
//
// Pure: no database, sheet or network.

const crypto = require("crypto");

// [the name in a change row, the field on a ledger month]
const FIGURES = [["revenue", "revenue"], ["driverPay", "driverPay"], ["raw", "netProfit"]];

const cents = (v) => Math.round((Number(v) || 0) * 100);
const figure = (b, a) => ({ before: b / 100, after: a / 100, change: (a - b) / 100 });

function isSnapshot(s) {
	return !!s && typeof s === "object" && Array.isArray(s.scopes);
}

// A snapshot's payable map for one owner, or null when it has none.
function payableOf(snapshot, ownerId) {
	const all = snapshot.payable;
	if (!all || typeof all !== "object") return null;
	const own = Object.prototype.hasOwnProperty.call(all, String(ownerId)) ? all[String(ownerId)] : null;
	return own && typeof own === "object" ? own : null;
}

const dropKey = (ownerId, d) => [ownerId, d.driver, d.day, d.month, d.keptMonth].join("\t");
function dropsOf(snapshot) {
	const out = new Map();
	for (const s of snapshot.scopes) {
		for (const d of s.dayOnceDrops || []) {
			out.set(dropKey(s.ownerId, d), {
				ownerId: s.ownerId, driver: d.driver, day: d.day, month: d.month, keptMonth: d.keptMonth,
				loadId: d.loadId || "", keptLoadId: d.keptLoadId || "",
			});
		}
	}
	return out;
}
const dropOrder = (x, y) => x.ownerId - y.ownerId || (x.day < y.day ? -1 : x.day > y.day ? 1 : 0) || (x.month < y.month ? -1 : x.month > y.month ? 1 : 0);

function ledgerChanges({ before, after, isClosed = () => false } = {}) {
	if (!isSnapshot(before) || !isSnapshot(after)) throw new TypeError("ledgerChanges: before and after must be ledger snapshots ({ scopes: [...] })");
	const closedCache = new Map();
	const closed = (mk) => {
		if (!closedCache.has(mk)) closedCache.set(mk, isClosed(mk) === true);
		return closedCache.get(mk);
	};
	const scopeOf = (snapshot) => new Map(snapshot.scopes.map((s) => [s.ownerId, s]));
	const was = scopeOf(before);
	const will = scopeOf(after);
	const owners = [];
	for (const s of [...before.scopes, ...after.scopes]) if (!owners.some((o) => o.ownerId === s.ownerId)) owners.push({ ownerId: s.ownerId, name: s.name || "" });

	const scopes = [];
	const fleet = new Map();
	for (const { ownerId, name } of owners) {
		const monthsOf = (scope) => new Map(((scope && scope.months) || []).map((m) => [m.month, m]));
		const b = monthsOf(was.get(ownerId));
		const a = monthsOf(will.get(ownerId));
		const bPay = payableOf(before, ownerId);
		const aPay = payableOf(after, ownerId);
		const hasPayable = !!(bPay || aPay);
		for (const mk of [...new Set([...b.keys(), ...a.keys()])].sort()) {
			const row = { ownerId, name, month: mk, closed: closed(mk) };
			let moved = false;
			const sums = fleet.get(mk) || { revenue: [0, 0], driverPay: [0, 0], raw: [0, 0] };
			for (const [key, field] of FIGURES) {
				const x = cents((b.get(mk) || {})[field]);
				const y = cents((a.get(mk) || {})[field]);
				row[key] = figure(x, y);
				if (x !== y) moved = true;
				sums[key][0] += x;
				sums[key][1] += y;
			}
			fleet.set(mk, sums);
			if (hasPayable) {
				const x = cents(bPay && bPay[mk]);
				const y = cents(aPay && aPay[mk]);
				row.payable = figure(x, y);
				if (x !== y) moved = true;
			} else {
				row.payable = null;
			}
			if (moved) scopes.push(row);
		}
	}

	const fleetRows = [];
	for (const mk of [...fleet.keys()].sort()) {
		const sums = fleet.get(mk);
		if (FIGURES.every(([key]) => sums[key][0] === sums[key][1])) continue;
		const row = { month: mk, closed: closed(mk) };
		for (const [key] of FIGURES) row[key] = figure(sums[key][0], sums[key][1]);
		fleetRows.push(row);
	}

	const closedMonths = [...new Set([...scopes, ...fleetRows].filter((r) => r.closed).map((r) => r.month))].sort();
	const b = dropsOf(before);
	const a = dropsOf(after);
	return {
		scopes,
		fleet: fleetRows,
		closedMonths,
		dayOnce: {
			added: [...a].filter(([k]) => !b.has(k)).map(([, d]) => d).sort(dropOrder),
			removed: [...b].filter(([k]) => !a.has(k)).map(([, d]) => d).sort(dropOrder),
		},
	};
}

// ── The reason (plan section 4, decision 8) ──────────────────────────────────
// Required text, 3 to 500 characters. The length is checked on the trimmed raw
// text BEFORE auditText() (server.js), which cuts at 500 without saying so: a
// longer reason is refused, never cut. What is left after auditText() (line
// breaks folded, control and format characters dropped, the purge marker
// scrubbed) must hold 3 characters. A reason holding an email or a phone is
// refused, with the broker-contact patterns the Load ID refusals use (#525), so
// no contact reaches the audit row.
//   raw          req.body.reason
//   auditText    server.js auditText(v, max)
//   hasContact   lib/broker-contact.js hasContact(text)
// Returns { ok: true, reason } or { ok: false, status: 400, body }.
const REASON_MIN = 3;
const REASON_MAX = 500;
function checkRestoreReason(raw, { auditText, hasContact }) {
	const refuse = (why) => ({
		ok: false,
		status: 400,
		body: {
			error: why === "too_long"
				? `The reason can be at most ${REASON_MAX} characters.`
				: `A reason of ${REASON_MIN}-${REASON_MAX} characters is required. It is written to the audit trail.`,
			code: "RESTORE_REASON_REQUIRED",
			field: "reason",
			reason: why,
		},
	});
	if (typeof raw !== "string") return refuse("missing");
	if (raw.trim().length > REASON_MAX) return refuse("too_long");
	const reason = auditText(raw, REASON_MAX);
	if (reason.length < REASON_MIN) return refuse("too_short");
	if (hasContact(reason)) {
		return {
			ok: false,
			status: 400,
			body: {
				error: "The reason can't hold an email address or a phone number.",
				code: "CONTACT_NOT_ALLOWED",
				field: "reason",
			},
		};
	}
	return { ok: true, reason };
}

// ── New Job's duplicate message (decision 11) ────────────────────────────────
// POST /api/loads/from-ratecon's 409 DUPLICATE_LOAD for a Load ID already on the
// sheet. For a soft-deleted load, with the restore switched on, the way back
// depends on who asks: only a Super Admin can restore.
function duplicateLoadMessage({ loadId, rowIndex, softDeleted, restoreEnabled, superAdmin }) {
	if (!softDeleted) return `Load ${loadId} already exists (row ${rowIndex}).`;
	const head = `Load ${loadId} already exists (row ${rowIndex}) but was deleted.`;
	if (!restoreEnabled) return `${head} Restore it instead of re-creating it.`;
	return `${head} ${superAdmin ? "Restore it from Deleted loads." : "Ask a Super Admin to restore it from Deleted loads."}`;
}

// ── The preview's invoice lines (plan section 3e, L7) ────────────────────────
// One line per Sat-Fri pay week the load's window touches, oldest first:
//   weeks        [{ weekStart, weekEnd, days: ["YYYY-MM-DD", ...] }]
//   invoiceFor   (weekStart) -> the driver's live weekly invoice row for that
//                week ({ id, invoice_number, status, load_ids }) or null
//   holderOf     (day) -> { invoiceId, invoiceNumber } of the live invoice
//                holding that driver-day (invoice_paid_days), or null
//   key          the load's normalizeLoadId() key; normalizeLoadId the server's
//   todayKey     today's business day ("YYYY-MM-DD")
//   tripRule     the trip work-day rule is on (TRIP_WORK_DAYS_FROM set)
// Each line: { weekStart, weekEnd, invoiceId, invoiceNumber, status, holdsLoad,
// unpaidDays, daysOnOtherInvoices: [{ day, invoiceNumber }], state, note }, where
// `state` is "on" (the invoice lists the load), "draft" (a Draft without it),
// "issued" (any other status without it), "none_yet" (no invoice, the week not
// over) or "none_past" (no invoice for a past week). Nothing here writes or
// promises a correction: a person decides.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function weekLabel(start, end) {
	const [, sm, sd] = start.split("-").map(Number);
	const [, em, ed] = end.split("-").map(Number);
	return sm === em ? `${MONTHS[sm - 1]} ${sd}-${ed}` : `${MONTHS[sm - 1]} ${sd}-${MONTHS[em - 1]} ${ed}`;
}
function loadIdsOf(invoice) {
	try {
		const list = JSON.parse((invoice && invoice.load_ids) || "[]");
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}
function invoiceLines({ weeks, invoiceFor, holderOf, key, normalizeLoadId, todayKey, tripRule = false }) {
	const tripNote = tripRule ? " With the trip work-day rule on, the next weekly generation adds or corrects its days." : "";
	return (weeks || []).map(({ weekStart, weekEnd, days }) => {
		const inv = invoiceFor(weekStart) || null;
		const held = [];
		const unpaidDays = [];
		for (const day of days) {
			const h = holderOf(day);
			if (h) held.push({ day, invoiceNumber: h.invoiceNumber || `invoice #${h.invoiceId}` });
			else unpaidDays.push(day);
		}
		const label = weekLabel(weekStart, weekEnd);
		const line = {
			weekStart, weekEnd,
			invoiceId: inv ? inv.id : null,
			invoiceNumber: inv ? inv.invoice_number : null,
			status: inv ? inv.status : null,
			holdsLoad: !!inv && loadIdsOf(inv).some((id) => normalizeLoadId(id) === key),
			unpaidDays,
			daysOnOtherInvoices: held,
		};
		if (!inv) {
			line.state = weekEnd >= todayKey ? "none_yet" : "none_past";
			line.note = line.state === "none_yet"
				? `Week ${label} has no invoice for this driver yet: the Friday batch or a manual generate will include it.`
				: `Week ${label} has no invoice for this driver: no invoice was generated for this week; generate it by hand.`;
		} else if (line.holdsLoad) {
			line.state = "on";
			line.note = `${inv.status} ${inv.invoice_number} (week ${label}) already includes this load.`;
		} else if (inv.status === "Draft") {
			line.state = "draft";
			line.note = `Draft ${inv.invoice_number} (week ${label}) does not include it: regenerate the draft to add it.${tripNote}`;
		} else {
			line.state = "issued";
			line.note = `${inv.status} ${inv.invoice_number} (week ${label}) does not include it: ${unpaidDays.length
				? "its days are not on any invoice; a correction invoice is a person's call"
				: `its days are already on ${[...new Set(held.map((h) => h.invoiceNumber))].join(", ")}`}.${tripNote}`;
		}
		return line;
	});
}

// ── Possible duplicates (plan section 3b, decision 3, L5) ────────────────────
// A live load that may be this one re-entered under another Load ID: the same
// driver with a window within a day of this one's, or a shared reference number
// (the B19 numbers lib/load-search-refs.js finds; a Load ID counts as one).
// Payment is never compared: a re-entered load often has a corrected amount.
//   target   { key, loadId, driver, days, refs }   (driver normalized; days the
//            window's "YYYY-MM-DD" list; refs the row's `_refs` values)
//   others   the same shape for each live load, plus rowIndex
//   normalizeRef   lib/load-search-refs.js normalizeRef
// Returns [{ loadId, rowIndex, reasons }] in sheet order. A warning, never a
// refusal: the POST asks for a "This is not a duplicate" tick.
const SAME_DRIVER = "same driver, overlapping dates";
const SAME_REF = "same reference number";
function shiftDay(day, n) {
	return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
function refSet(load, normalizeRef) {
	const out = new Set();
	for (const v of [load.loadId, ...(load.refs || [])]) {
		const k = normalizeRef(v);
		if (k) out.add(k);
	}
	return out;
}
function possibleDuplicates({ target, others, normalizeRef }) {
	const days = [...(target.days || [])].sort();
	const lo = days.length ? shiftDay(days[0], -1) : null;
	const hi = days.length ? shiftDay(days[days.length - 1], 1) : null;
	const mine = refSet(target, normalizeRef);
	const out = [];
	for (const o of [...(others || [])].sort((x, y) => (x.rowIndex || 0) - (y.rowIndex || 0))) {
		if (!o || o.key === target.key) continue;
		const reasons = [];
		const theirs = [...(o.days || [])].sort();
		if (target.driver && o.driver === target.driver && lo && theirs.length && theirs[0] <= hi && theirs[theirs.length - 1] >= lo) reasons.push(SAME_DRIVER);
		if ([...refSet(o, normalizeRef)].some((k) => mine.has(k))) reasons.push(SAME_REF);
		if (reasons.length) out.push({ loadId: o.loadId, rowIndex: o.rowIndex || 0, reasons });
	}
	return out;
}
// The reference values a row carries after annotateLoadSearchRefs() (its `_refs`).
function rowRefs(row) {
	return Array.isArray(row && row._refs) ? row._refs.map((r) => String(r.value)) : [];
}

// ── The fingerprint (plan section 3i, L4) ────────────────────────────────────
// A hash of everything the person confirms: the key and its delete records, the
// months (the sheet's and the delete record's), the row that returns (sheet row,
// status, dates, Payment), the invoice lines, the possible duplicates and every
// changed ledger figure before and after. The POST recomputes the preview and
// refuses (409 PREVIEW_STALE) when the hash differs, so a restore applies
// exactly the figures confirmed.
function restoreFingerprint(facts) {
	return crypto.createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 32);
}

// ── The audit row (plan section 5) ───────────────────────────────────────────
// "Restored load X (sheet row N) — settlement month M; removed delete record 12
// (deleted by A at T). Reason: R". The months use the delete row's words, so
// lib/deleted-loads-view.js auditMonths() reads them; the reason is last, so the
// history reads it after the first ". Reason: ".
function restoreAuditDetails({ loadId, rowIndex, months, removed, reason }) {
	const list = months || [];
	const recs = removed || [];
	const monthsText = list.length ? ` — settlement month${list.length > 1 ? "s" : ""} ${list.join(", ")}` : "";
	const who = recs.map((r) => `deleted by ${r.deletedBy || "unknown"} at ${r.deletedAt || "an unknown time"}`).join("; ");
	return `Restored load ${loadId}${rowIndex ? ` (sheet row ${rowIndex})` : ""}${monthsText}; removed delete record${recs.length > 1 ? "s" : ""} ${recs.map((r) => r.id).join(", ")} (${who}). Reason: ${reason}`;
}

module.exports = {
	ledgerChanges, checkRestoreReason, duplicateLoadMessage, invoiceLines, weekLabel, possibleDuplicates, rowRefs, restoreFingerprint,
	restoreAuditDetails, REASON_MIN, REASON_MAX, SAME_DRIVER, SAME_REF,
};
