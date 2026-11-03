"use strict";
// The receipt status recorder (RECEIPT_STATUS_RECORDER_ENABLED, read in
// server.js): with it on, a person's status write on a receipt, and a Personal
// mark whose line is placed in an open month, record who last set the status:
//
//   status_by_role   the session's role ("Super Admin", "Dispatcher"); "system"
//                    for a system actor
//   status_by_id     the account id; 0 for a system actor
//   status_by_name   the session's username (a shared login names an account,
//                    not a person)
//   status_at        when, ISO-8601 UTC
//
// With it off the writers run today's statements and nothing here reads or
// writes a column. Nothing that computes money reads these columns.

const STAMP_SET = "status_by_role = ?, status_by_id = ?, status_by_name = ?, status_at = ?";
const LIST_COLUMNS = ", status_by_role, status_by_name, status_at";

// The four values for STAMP_SET, from a session user.
function stampValues(user, at) {
	const u = user && typeof user === "object" ? user : {};
	const id = Number(u.id);
	return [String(u.role || ""), Number.isInteger(id) ? id : null, String(u.username || ""), String(at || "")];
}

// A person's status write: the SET clause and the values it binds first. Off,
// today's clause alone, so the statement text is unchanged.
function statusSet(on, status, user, at) {
	if (!on) return { sql: "status = ?", params: [status] };
	return { sql: `status = ?, ${STAMP_SET}`, params: [status, ...stampValues(user, at)] };
}

// The Personal mark's write with the recorder on, inside the mark's transaction.
// The receipt's status ends exactly as today's mark leaves it: a Pending receipt
// in place is approved (`approve`, read before the line was drawn). The marker is
// stamped only where the line is placed in place and the row's own months are
// open (`rowLocked` is expenseRowPeriodLocked()), since a closed month's expenses
// row is never written; there the mark's own audit row is the trace. An Approved
// receipt is stamped too: marking it is a person's decision about it.
// `approved` is true only when this write moved the receipt to Approved, so the
// implied-approval audit row never claims an approval that did not happen.
function markPersonalWrite(db, { id, user, at, inPlace, approve, rowLocked }) {
	const none = { approved: false, stamped: false };
	if (!inPlace) return none;
	const row = db.prepare("SELECT status, date, posted_period, created_at FROM expenses WHERE id = ?").get(id);
	if (!row) return none;
	if (rowLocked(row)) {
		if (!approve) return none;
		const r = db.prepare("UPDATE expenses SET status = 'Approved' WHERE id = ? AND status = 'Pending'").run(id);
		return { approved: r.changes === 1, stamped: false };
	}
	const was = String(row.status || "");
	if (was !== "Approved" && !(was === "Pending" && approve)) return none;
	const r = db.prepare(`UPDATE expenses SET status = 'Approved', ${STAMP_SET} WHERE id = ? AND status = ?`)
		.run(...stampValues(user, at), id, was);
	return { approved: was === "Pending" && r.changes === 1, stamped: r.changes === 1 };
}

// The admin list's columns with the recorder on (appended to its SELECT list),
// and a row's shape: `status_by` { role, name, at } once someone has set its
// status, else null. The account id stays in the database.
function listColumns(on) {
	return on ? LIST_COLUMNS : "";
}
function withStatusBy(row) {
	const { status_by_role: role, status_by_name: name, status_at: at, ...rest } = row;
	return { ...rest, status_by: role ? { role: String(role), name: String(name || ""), at: String(at || "") } : null };
}

module.exports = { STAMP_SET, stampValues, statusSet, markPersonalWrite, listColumns, withStatusBy };
