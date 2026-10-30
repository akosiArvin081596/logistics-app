#!/usr/bin/env node
// scripts/emergency-contacts-report.js — what switching EMERGENCY_CONTACTS_ENABLED
// on would change, read-only, for the report the switch-on waits for. It prints
// counts and account or Drivers page row ids only: never a name, an address or a
// phone number, and never a contact.
//
//   1. Driver accounts: total, enabled, disabled
//   2. Contacts on file per enabled Driver account: 0, 1, 2-5, over 5
//   3. Onboarding of enabled Driver accounts: no record; documents_pending (and
//      those with every document signed and fewer than 2 contacts, who would wait
//      on the contacts item); documents_signed (asked, not blocked);
//      fully_onboarded
//   4. Would see the sign-in prompt: enabled, fully onboarded or no onboarding
//      record, fewer than 2 contacts
//   5. Drivers page rows: linked to exactly one Driver account, to none (staff
//      cannot add contacts there), to two or more
//   6. The all-drivers email's dry-run buckets for one campaign
//      (scripts/lib/emergency-contacts-recipients.js, shared with the send)
//
// Usage: node scripts/emergency-contacts-report.js [--db=<path>] [--include-inactive] [--campaign=<key>] [--json]
//   --db         a copy outside the repository; without it, the app's own database
//                (scripts/lib/app-database.js resolveDatabase(), refused in replica mode)
//   --campaign   lower-case letters, digits and hyphens; default emergency-contacts-1
// The database is opened read-only (checked) and works before the table exists
// (every driver at 0). On a WAL database whose -wal and -shm files are absent,
// SQLite's read-only open creates them, empty; the database file is never written.
// Exit codes: 0 done, 1 error, 2 refused.

"use strict";

const path = require("path");
const { parseArgs, openDb } = require("./lib/ledger-world");
const { resolveDatabase, DatabaseRefusal } = require("./lib/app-database");
const { closure } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");
const recipients = require("./lib/emergency-contacts-recipients");
const rules = require("../lib/emergency-contacts");

const ROOT = path.join(__dirname, "..");
const LIFT_ROOTS = ["normalizeDriverName", "findDirectoryRowForDriver", "driverAccountForDirectoryRow", "ONBOARDING_DOCS"];

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

// The server's own directory lookups and onboarding list, lifted from this
// checkout's server.js and given the read-only handle as their `db`.
function liftFromServer(db) {
	const lifted = closure(serverSource({ root: ROOT }), {
		roots: LIFT_ROOTS,
		provided: ["db"],
		denied: ["app", "io", "server", "sheets", "sendEmail", "transporter", "getSheets", "getDrive", "getJobTrackingCached", "fetch"],
	});
	return new Function("db", `"use strict";\n${lifted.text}\nreturn { ${LIFT_ROOTS.join(", ")} };`)(db);
}

function buildReport(db, scope, { campaign, includeInactive }) {
	const server = liftFromServer(db);
	const facts = recipients.driverFacts(db, { findDirectoryRowForDriver: server.findDirectoryRowForDriver, onboardingDocCount: server.ONBOARDING_DOCS.length });
	const enabled = facts.filter((f) => f.enabled);
	const min = rules.MIN_CONTACTS;
	const max = rules.MAX_CONTACTS;
	const ids = (list) => list.map((f) => f.id);
	const waiting = enabled.filter((f) => f.onboarding === "documents_pending" && f.allSigned && f.contacts < min);
	const signed = enabled.filter((f) => f.onboarding === "documents_signed");
	const overMax = enabled.filter((f) => f.contacts > max);
	const directory = { total: 0, linked: 0, noAccount: 0, noAccountIds: [], ambiguous: 0, ambiguousIds: [] };
	for (const row of db.prepare("SELECT id, driver_name FROM drivers_directory ORDER BY id").all()) {
		directory.total++;
		const link = server.driverAccountForDirectoryRow(row);
		if (link.account) directory.linked++;
		else if (link.reason === "ambiguous") { directory.ambiguous++; directory.ambiguousIds.push(row.id); }
		else { directory.noAccount++; directory.noAccountIds.push(row.id); }
	}
	return {
		database: scope,
		contactsTable: recipients.tableExists(db, "driver_emergency_contacts"),
		drivers: { total: facts.length, enabled: enabled.length, disabled: facts.length - enabled.length },
		contactsOnFile: {
			zero: enabled.filter((f) => f.contacts === 0).length,
			one: enabled.filter((f) => f.contacts === 1).length,
			twoToFive: enabled.filter((f) => f.contacts >= min && f.contacts <= max).length,
			overFive: overMax.length,
			overFiveIds: ids(overMax),
		},
		onboarding: {
			noRecord: enabled.filter((f) => f.onboarding === null).length,
			documentsPending: enabled.filter((f) => f.onboarding === "documents_pending").length,
			pendingAllSignedWaiting: waiting.length,
			pendingAllSignedWaitingIds: ids(waiting),
			documentsSigned: signed.length,
			documentsSignedIds: ids(signed),
			fullyOnboarded: enabled.filter((f) => f.onboarding === "fully_onboarded").length,
		},
		prompt: enabled.filter((f) => (f.onboarding === "fully_onboarded" || f.onboarding === null) && f.contacts < min).length,
		directory,
		email: {
			campaign,
			includeInactive,
			...recipients.emailBuckets(facts, { minContacts: min, includeInactive, states: recipients.campaignStates(db, campaign) }),
		},
	};
}

function text(r) {
	const list = (a) => (a.length ? ` [${a.join(", ")}]` : "");
	const e = r.email;
	return [
		"Emergency contacts: what switching EMERGENCY_CONTACTS_ENABLED on would change (read-only; counts and ids only)",
		`database: ${r.database === "app" ? "the app's own" : "a copy"}; contacts table ${r.contactsTable ? "present" : "absent (every driver counts 0)"}`,
		"",
		`1. Driver accounts: ${r.drivers.total} (enabled ${r.drivers.enabled}, disabled ${r.drivers.disabled})`,
		`2. Contacts on file, enabled Driver accounts: 0: ${r.contactsOnFile.zero}, 1: ${r.contactsOnFile.one}, 2-5: ${r.contactsOnFile.twoToFive}, over 5: ${r.contactsOnFile.overFive}${list(r.contactsOnFile.overFiveIds)}`,
		"3. Onboarding, enabled Driver accounts:",
		`   no record: ${r.onboarding.noRecord}`,
		`   documents_pending: ${r.onboarding.documentsPending}; every document signed, would wait on the contacts item: ${r.onboarding.pendingAllSignedWaiting}${list(r.onboarding.pendingAllSignedWaitingIds)}`,
		`   documents_signed (asked, not blocked): ${r.onboarding.documentsSigned}${list(r.onboarding.documentsSignedIds)}`,
		`   fully_onboarded: ${r.onboarding.fullyOnboarded}`,
		`4. Would see the sign-in prompt: ${r.prompt}`,
		`5. Drivers page rows: ${r.directory.total}; linked to one Driver account: ${r.directory.linked}; no Driver account: ${r.directory.noAccount}${list(r.directory.noAccountIds)}; two or more: ${r.directory.ambiguous}${list(r.directory.ambiguousIds)}`,
		`6. The all-drivers email, campaign ${e.campaign}${e.includeInactive ? " (inactive drivers included)" : ""}:`,
		`   would send: ${e.wouldSend.length}${list(e.wouldSend)}`,
		`   already sent this campaign: ${e.alreadySent.length}${list(e.alreadySent)}`,
		`   uncertain (an attempt with no result): ${e.uncertain.length}${list(e.uncertain)}`,
		`   failed earlier: ${e.failedEarlier.length}${list(e.failedEarlier)}`,
		`   complete (2 or more on file): ${e.complete.length}`,
		`   no usable address: ${e.noAddress.length}${list(e.noAddress)}`,
		`   excluded: disabled ${e.excluded.disabled.length}, documents_pending ${e.excluded.documentsPending.length}, inactive on the Drivers page ${e.excluded.inactive.length}${list(e.excluded.inactive)}`,
	].join("\n");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.db !== undefined && (typeof args.db !== "string" || !args.db.trim())) refuse("--db needs a path");
	const campaign = args.campaign === undefined ? recipients.DEFAULT_CAMPAIGN : args.campaign;
	if (typeof campaign !== "string" || !recipients.CAMPAIGN_RE.test(campaign)) refuse("--campaign must be lower-case letters, digits and hyphens (at most 48), starting with a letter or digit");
	let target;
	try {
		target = resolveDatabase(typeof args.db === "string" ? args.db.trim() : null, ROOT);
	} catch (err) {
		if (err instanceof DatabaseRefusal) refuse(err.message);
		throw err;
	}
	const db = openDb({ root: ROOT, dbFile: target.file, readonly: true });
	try {
		if (!recipients.tableExists(db, "users") || !recipients.tableExists(db, "drivers_directory")) refuse("the database has no users or drivers_directory table");
		const report = buildReport(db, target.scope, { campaign, includeInactive: args["include-inactive"] === true });
		console.log(args.json === true ? JSON.stringify(report, null, 2) : text(report));
	} finally {
		db.close();
	}
}

try {
	main();
} catch (err) {
	console.error(`ERROR: ${err.message}`);
	process.exit(1);
}
