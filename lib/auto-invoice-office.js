// An office user's Delivered starts the automatic invoice (AUTO_INVOICE_OFFICE_DELIVERED_ENABLED):
// what the job reads before it lets one arm. lib/auto-invoice-trigger.js arms() is the rule,
// lib/auto-invoice-job.js applies it.
//
// Nothing retroactive. A load with no claim starts nothing when its status history shows a
// completed or Cancelled status anywhere, or when it is on the "already delivered" list: every
// load a start with the switch on, or the 5-minute watch since, read completed on any of its
// rows with no claim. The list covers what the history can't: a load completed by a row edit,
// a sheet edit or n8n, which write no history, and every load completed while the switch was
// off. Its table is made only with the switch on.
//
// A read that can't be made throws, and the job reads that as "starts nothing".

"use strict";

const rules = require("./auto-invoice-rules");
const ledger = require("./auto-invoice-ledger");
const { everyJobTrackingRow } = require("./job-tracking-every-row");
const { sharedLoginNote } = require("./sign-in");

const LIST = "auto_invoice_office_before";
// server.js's own table: the app's status routes write it, forward only, keyed by the load key.
const HISTORY = "load_status_history";

// On only when exactly "true". The job counts it only while the driver's trigger is on.
function enabled(env = {}) {
	return String((env && env.AUTO_INVOICE_OFFICE_DELIVERED_ENABLED) ?? "").trim() === "true";
}

// What the app's status routes recorded of this load: whether any row's old or new status is
// a completed one, or a Cancelled one.
function historyOf(db, key) {
	const rows = db.prepare(`SELECT old_status, new_status FROM ${HISTORY} WHERE load_id = ?`).all(key);
	const any = (test) => rows.some((r) => test(r.old_status) || test(r.new_status));
	return { completed: any(rules.isCompletedStatus), cancelled: any(rules.isCancelledStatus) };
}

function listed(db, key) {
	return Boolean(db.prepare(`SELECT 1 FROM ${LIST} WHERE load_key = ?`).get(key));
}

// The loads a Job Tracking read shows completed on any of their rows, not only the row the
// job keeps for a key. null for a read with no load rows, or no Load ID or status column: a
// read like that would list nothing, and nothing may open on it.
function completedKeys(jt) {
	const cols = rules.jobColumns((jt && jt.headers) || []);
	if (!cols.loadIdCol || !cols.statusCol) return null;
	const keys = new Set();
	let loads = 0;
	for (const row of everyJobTrackingRow(jt)) {
		const key = row ? rules.loadKey(row[cols.loadIdCol]) : "";
		if (!key) continue;
		loads++;
		if (rules.isCompletedStatus(row[cols.statusCol])) keys.add(key);
	}
	return loads ? keys : null;
}

// Each of `keys` that has no claim joins the list, in one transaction. How many joined.
function addCompleted(db, keys, { nowIso }) {
	return db.transaction(() => {
		db.exec(`CREATE TABLE IF NOT EXISTS ${LIST} (load_key TEXT PRIMARY KEY, recorded_at TEXT NOT NULL)`);
		const add = db.prepare(`INSERT OR IGNORE INTO ${LIST} (load_key, recorded_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${ledger.CLAIMS} WHERE load_key = ?)`);
		let n = 0;
		for (const key of keys) n += add.run(key, nowIso, key).changes;
		return n;
	}).immediate();
}

// The audit row's words when an office Delivered started the invoice: who, as what, and from where. A row
// on the shared login names the login, not a person, so it says so.
function startedDetails({ username, role, route }) {
	const who = String(username || "").trim() || "an unnamed account";
	const where = route === "Override" ? "the Override" : "the Status dropdown";
	return `the automatic invoice was started by ${who}'s Delivered (${role}, ${where})${sharedLoginNote({ username: who })}`;
}

module.exports = { LIST, enabled, historyOf, listed, completedKeys, addCompleted, startedDetails };
