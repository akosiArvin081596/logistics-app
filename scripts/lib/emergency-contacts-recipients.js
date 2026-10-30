// Who the all-drivers emergency-contacts email is for, and why each other Driver
// account is not. One classifier for scripts/emergency-contacts-report.js (the
// read-only report before EMERGENCY_CONTACTS_ENABLED goes on) and the script
// that sends the email, so the report's buckets are the send's.
//
// Reads only through the database handle it is given, and prints nothing. The
// directory lookup and the driver-name rule are the server's own code, lifted
// by the caller (scripts/lib/server-lift.js) and handed in.

"use strict";

const DEFAULT_CAMPAIGN = "emergency-contacts-1";
const CAMPAIGN_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
// The audit rows the sending script writes per driver: an attempt before the
// send, a result after it (details "campaign <key>: attempt", "...: sent",
// "...: failed (<code>)"), user_id 0, role system, entity "user".
const ATTEMPT_ACTION = "emergency_contacts_request_attempt";
const RESULT_ACTION = "emergency_contacts_request_result";
const ADDRESS_MAX = 254;
const BAD_ADDRESS_CHAR_RE = /^[\s\p{C}]$/u;

function tableExists(db, name) {
	return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
function columnsOf(db, table) {
	return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
}

// An address the email can go to, or null: one "@" with text on each side, no
// whitespace or control character, at most 254 characters.
function usableAddress(raw) {
	if (typeof raw !== "string") return null;
	const s = raw.trim();
	if (!s || s.length > ADDRESS_MAX) return null;
	let at = -1;
	for (let i = 0; i < s.length; i++) {
		if (BAD_ADDRESS_CHAR_RE.test(s[i])) return null;
		if (s[i] === "@") {
			if (at >= 0) return null;
			at = i;
		}
	}
	return at > 0 && at < s.length - 1 ? s : null;
}

// Per account id, one campaign's { attempts, sent, failed }.
function campaignStates(db, campaign) {
	const out = new Map();
	if (!tableExists(db, "audit_trail")) return out;
	const prefix = `campaign ${campaign}: `;
	const rows = db.prepare("SELECT action, entity_id, details FROM audit_trail WHERE entity = 'user' AND action IN (?, ?) ORDER BY id")
		.all(ATTEMPT_ACTION, RESULT_ACTION);
	for (const r of rows) {
		const details = String(r.details || "");
		const id = Number(r.entity_id);
		if (!details.startsWith(prefix) || !Number.isSafeInteger(id) || id <= 0) continue;
		const s = out.get(id) || { attempts: 0, sent: 0, failed: 0 };
		const rest = details.slice(prefix.length);
		if (r.action === ATTEMPT_ACTION) s.attempts++;
		else if (rest.startsWith("sent")) s.sent++;
		else if (rest.startsWith("failed")) s.failed++;
		out.set(id, s);
	}
	return out;
}

// One entry per Driver account, by id: { id, enabled, onboarding (status or
// null), allSigned, contacts, directoryStatus, address }. Works on a database
// without the contacts table (every count 0) or without the onboarding tables.
//   deps: { findDirectoryRowForDriver, onboardingDocCount }
function driverFacts(db, deps) {
	const userCols = columnsOf(db, "users");
	const users = db.prepare(`SELECT id, driver_name, email${userCols.has("disabled_at") ? ", disabled_at" : ""} FROM users WHERE role = 'Driver' ORDER BY id`).all();
	const countBy = (sql) => new Map(db.prepare(sql).all().map((r) => [r.user_id, r.n]));
	const contacts = tableExists(db, "driver_emergency_contacts")
		? countBy("SELECT user_id, COUNT(*) AS n FROM driver_emergency_contacts GROUP BY user_id") : new Map();
	const onboarding = tableExists(db, "driver_onboarding")
		? new Map(db.prepare("SELECT user_id, status FROM driver_onboarding").all().map((r) => [r.user_id, r.status])) : new Map();
	const signed = tableExists(db, "onboarding_documents")
		? countBy("SELECT user_id, COUNT(*) AS n FROM onboarding_documents WHERE signed = 1 GROUP BY user_id") : new Map();
	const dirCols = columnsOf(db, "drivers_directory");
	const dirRow = db.prepare(`SELECT ${dirCols.has("status") ? "status" : "'' AS status"}, ${dirCols.has("email") ? "email" : "'' AS email"} FROM drivers_directory WHERE id = ?`);
	return users.map((u) => {
		const link = deps.findDirectoryRowForDriver(u.driver_name);
		const dir = link ? dirRow.get(link.id) : null;
		return {
			id: u.id,
			enabled: String(u.disabled_at ?? "") === "",
			onboarding: onboarding.get(u.id) || null,
			allSigned: (signed.get(u.id) || 0) === deps.onboardingDocCount,
			contacts: contacts.get(u.id) || 0,
			directoryStatus: dir ? String(dir.status || "").trim().toLowerCase() : "",
			address: usableAddress(u.email) || (dir ? usableAddress(dir.email) : null),
		};
	});
}

// The email's buckets, account ids in each, every Driver account in exactly one.
function emailBuckets(facts, { minContacts, includeInactive, states }) {
	const b = { wouldSend: [], alreadySent: [], uncertain: [], failedEarlier: [], complete: [], noAddress: [],
		excluded: { disabled: [], documentsPending: [], inactive: [] } };
	for (const f of facts) {
		const s = states.get(f.id) || { attempts: 0, sent: 0, failed: 0 };
		if (!f.enabled) b.excluded.disabled.push(f.id);
		else if (f.onboarding === "documents_pending") b.excluded.documentsPending.push(f.id);
		else if (f.contacts >= minContacts) b.complete.push(f.id);
		else if (f.directoryStatus === "inactive" && !includeInactive) b.excluded.inactive.push(f.id);
		else if (s.sent > 0) b.alreadySent.push(f.id);
		// An attempt with no result: it may or may not have gone. Skipped, never retried blind.
		else if (s.attempts > s.sent + s.failed) b.uncertain.push(f.id);
		else if (s.failed > 0) b.failedEarlier.push(f.id);
		else if (!f.address) b.noAddress.push(f.id);
		else b.wouldSend.push(f.id);
	}
	return b;
}

module.exports = {
	DEFAULT_CAMPAIGN,
	CAMPAIGN_RE,
	ATTEMPT_ACTION,
	RESULT_ACTION,
	usableAddress,
	campaignStates,
	driverFacts,
	emailBuckets,
	tableExists,
};
