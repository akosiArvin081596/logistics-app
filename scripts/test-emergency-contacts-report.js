#!/usr/bin/env node
/**
 * scripts/emergency-contacts-report.js, the read-only "what would change"
 * report to run on production data before EMERGENCY_CONTACTS_ENABLED goes on.
 *
 *   §1 every bucket on a made-up database: Driver accounts (enabled,
 *      disabled), contacts on file (0, 1, 2-5, over 5), onboarding (no record,
 *      documents_pending and those that would wait on the contacts item,
 *      documents_signed, fully_onboarded), who would see the sign-in prompt,
 *      the Drivers page rows (linked, no account, two accounts) and the
 *      all-drivers email's dry-run buckets (would send, already sent this
 *      campaign, uncertain, failed earlier, complete, no usable address,
 *      excluded disabled / documents_pending / inactive)
 *   §2 --include-inactive and --campaign move the drivers they should
 *   §3 the output, text and JSON, holds counts and ids only: no made-up name,
 *      address or phone number, no contact value
 *   §4 read-only: the database file is byte-for-byte unchanged and the script
 *      opens it through the read-only handle
 *   §5 before the table exists: the report runs and counts every driver at 0
 *   §6 refusals (exit 2): a missing database, replica mode without --db, a bad
 *      campaign key
 *
 * Databases are made-up, in a mkdtemp folder outside the repository, built with
 * server.js's own CREATE text for driver_emergency_contacts and audit_trail.
 * Run: node scripts/test-emergency-contacts-report.js   # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");
const { serverSource } = require("./lib/server-source");

const SCRIPT = path.join(__dirname, "emergency-contacts-report.js");
const SRC = serverSource();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-ec-report-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`  ok    ${name}`); return; }
	failures.push(name);
	console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
}
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected),
	`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// The text a db.exec(`...`) in server.js holds, found by a marker inside it.
function execBlock(marker) {
	const at = SRC.indexOf(marker);
	if (at < 0) return null;
	const open = SRC.lastIndexOf("db.exec(`", at);
	const close = SRC.indexOf("`);", at);
	return open < 0 || close < 0 ? null : SRC.slice(open + "db.exec(`".length, close);
}
const AUDIT_DDL = execBlock("CREATE TABLE IF NOT EXISTS audit_trail (");
const CONTACTS_DDL = execBlock("CREATE TABLE IF NOT EXISTS driver_emergency_contacts (");
ok("(fixture) server.js's CREATE text for audit_trail and driver_emergency_contacts", !!AUDIT_DDL && !!CONTACTS_DDL);

// ── the made-up fleet ─────────────────────────────────────────────────────────
// [id, name, onboarding status or null, documents signed, contacts, account email, disabled]
const DRIVERS = [
	[90401, "Casey Example", "fully_onboarded", 5, 0, "casey.example@example.com", false],
	[90402, "Bailey Example", "fully_onboarded", 5, 1, "", false],
	[90403, "Cameron Example", "fully_onboarded", 5, 2, "cameron.example@example.com", false],
	[90404, "Dana Example", "documents_pending", 5, 0, "dana.example@example.com", false],
	[90405, "Emery Example", "documents_pending", 3, 0, "emery.example@example.com", false],
	[90406, "Finley Example", "documents_signed", 5, 1, "finley.example@example.com", false],
	[90407, "Gray Example", null, 0, 0, "gray@@example.com", false],
	[90408, "Hollis Example", "fully_onboarded", 5, 0, "hollis.example@example.com", true],
	[90409, "Indigo Example", "fully_onboarded", 5, 0, "indigo.example@example.com", false],
	[90410, "Jules Example", "fully_onboarded", 5, 0, "jules.example@example.com", false],
	[90411, "Kai Example", "fully_onboarded", 5, 0, "kai.example@example.com", false],
	[90412, "Lane Example", "fully_onboarded", 5, 0, "lane.example@example.com", false],
	[90413, "Marlow Example", "fully_onboarded", 5, 6, "marlow.example@example.com", false],
	[90414, "Jamie Twin", null, 0, 0, "", false],
	[90415, "jamie  twin", null, 0, 0, "", false],
];
const STAFF = [[90101, "sa.example", "Super Admin", "sa.example@example.com"], [90201, "dispatch.example", "Dispatcher", "dispatch.example@example.com"]];
// [id, name, status, email]
const DIRECTORY = [
	[601, "Casey Example", "active", "casey.directory@example.com"],
	[602, "Nobody Directory", "active", "nobody.directory@example.com"],
	[603, "Jamie Twin", "active", ""],
	[604, "Bailey Example", "active", "bailey.example@example.com"],
	[605, "Indigo Example", "inactive", ""],
];
const CAMPAIGN = "emergency-contacts-1";
// [account id, details]: what the email script records per send.
const CAMPAIGN_ROWS = [
	[90410, "emergency_contacts_request_attempt", `campaign ${CAMPAIGN}: attempt`],
	[90410, "emergency_contacts_request_result", `campaign ${CAMPAIGN}: sent`],
	[90411, "emergency_contacts_request_attempt", `campaign ${CAMPAIGN}: attempt`],
	[90412, "emergency_contacts_request_attempt", `campaign ${CAMPAIGN}: attempt`],
	[90412, "emergency_contacts_request_result", `campaign ${CAMPAIGN}: failed (EAUTH)`],
	[90401, "emergency_contacts_request_result", "campaign another-campaign: sent"],
];
const contactName = (id, i) => `Contact ${String.fromCharCode(65 + (id % 26))}${i} Madeup`;
// 555-0100 to 555-0199 only (the fictional range).
const contactPhone = (id, i) => `+151255501${String((id + i) % 100).padStart(2, "0")}`;

function buildDb(file, { withContacts = true } = {}) {
	const db = new Database(file);
	db.pragma("journal_mode = DELETE");
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL DEFAULT '',
			role TEXT NOT NULL, driver_name TEXT DEFAULT '', email TEXT DEFAULT '', full_name TEXT NOT NULL DEFAULT '', disabled_at TEXT DEFAULT NULL);
		CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
			status TEXT DEFAULT 'active', email TEXT DEFAULT '', phone TEXT DEFAULT '');
		CREATE TABLE driver_onboarding (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, application_id INTEGER NOT NULL DEFAULT 0,
			driver_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'documents_pending', drug_test_result TEXT DEFAULT '');
		CREATE TABLE onboarding_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, doc_key TEXT NOT NULL, doc_name TEXT NOT NULL DEFAULT '',
			signed INTEGER DEFAULT 0, UNIQUE(user_id, doc_key));
	`);
	db.exec(AUDIT_DDL);
	if (withContacts) db.exec(CONTACTS_DDL);
	const user = db.prepare("INSERT INTO users (id, username, role, driver_name, email, disabled_at) VALUES (?, ?, ?, ?, ?, ?)");
	for (const [id, username, role, email] of STAFF) user.run(id, username, role, "", email, null);
	const docKeys = ["contractor_agreement", "equipment_policy", "w9", "mobile_policy", "substance_policy"];
	const onboarding = db.prepare("INSERT INTO driver_onboarding (user_id, driver_name, status) VALUES (?, ?, ?)");
	const doc = db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, signed) VALUES (?, ?, ?)");
	const contact = withContacts ? db.prepare(`INSERT INTO driver_emergency_contacts (user_id, position, contact_name, relationship, contact_phone, created_at, updated_at, created_by, updated_by)
		VALUES (?, ?, ?, 'Friend', ?, '2026-10-30T12:00:00.000Z', '2026-10-30T12:00:00.000Z', ?, ?)`) : null;
	for (const [id, name, status, signed, contacts, email, disabled] of DRIVERS) {
		user.run(id, `driver.${id}`, "Driver", name, email, disabled ? "2026-10-01T00:00:00.000Z" : null);
		if (status) {
			onboarding.run(id, name, status);
			docKeys.forEach((k, i) => doc.run(id, k, i < signed ? 1 : 0));
		}
		for (let i = 1; i <= contacts && contact; i++) contact.run(id, i, contactName(id, i), contactPhone(id, i), id, id);
	}
	const dir = db.prepare("INSERT INTO drivers_directory (id, driver_name, status, email, phone) VALUES (?, ?, ?, ?, '+15125550199')");
	for (const row of DIRECTORY) dir.run(...row);
	const audit = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, 'system: emergency-contacts-email', 'system', ?, 'user', ?, ?)");
	for (const [id, action, details] of CAMPAIGN_ROWS) audit.run("2026-10-31T14:00:00.000Z", action, String(id), details);
	db.close();
	return file;
}

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LOCAL_REPLICA|DATABASE_PATH|SERVER_JS|SERVER_ROOT)$/.test(k)));
function report(args, env = {}) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...CLEAN_ENV, ...env }, cwd: TMP });
	let json = null;
	try { json = JSON.parse(r.stdout); } catch { json = null; }
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, stdout: r.stdout || "", json };
}
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const DB = AUDIT_DDL && CONTACTS_DDL ? buildDb(path.join(TMP, "made-up.db")) : null;
const beforeHash = DB ? sha(DB) : "";

// ── §1 every bucket ───────────────────────────────────────────────────────────
console.log("\n§1 every bucket");
const main = DB ? report([`--db=${DB}`, "--json"]) : { code: -1, json: null, out: "no fixture" };
ok("§1 the report runs (exit 0) and prints JSON", main.code === 0 && !!main.json, `exit ${main.code}: ${main.out.slice(0, 300)}`);
const J = main.json || {};
eq("§1 the database is a copy, and the table is there", [J.database, J.contactsTable], ["copy", true]);
eq("§1 Driver accounts: total, enabled, disabled", J.drivers, { total: 15, enabled: 14, disabled: 1 });
eq("§1 contacts on file, enabled Driver accounts: 0, 1, 2-5, over 5 (with ids)", J.contactsOnFile,
	{ zero: 10, one: 2, twoToFive: 1, overFive: 1, overFiveIds: [90413] });
eq("§1 onboarding of enabled Driver accounts", J.onboarding, {
	noRecord: 3, documentsPending: 2, pendingAllSignedWaiting: 1, pendingAllSignedWaitingIds: [90404],
	documentsSigned: 1, documentsSignedIds: [90406], fullyOnboarded: 8,
});
eq("§1 would see the sign-in prompt (fully onboarded or no record, fewer than 2)", J.prompt, 9);
eq("§1 Drivers page rows: linked, no Driver account, two Driver accounts", J.directory,
	{ total: 5, linked: 3, noAccount: 1, noAccountIds: [602], ambiguous: 1, ambiguousIds: [603] });
eq("§1 the email's dry-run buckets", J.email, {
	campaign: CAMPAIGN,
	includeInactive: false,
	wouldSend: [90401, 90402, 90406],
	alreadySent: [90410],
	uncertain: [90411],
	failedEarlier: [90412],
	complete: [90403, 90413],
	noAddress: [90407, 90414, 90415],
	excluded: { disabled: [90408], documentsPending: [90404, 90405], inactive: [90409] },
});
{
	const e = J.email || {};
	const all = [...(e.wouldSend || []), ...(e.alreadySent || []), ...(e.uncertain || []), ...(e.failedEarlier || []), ...(e.complete || []),
		...(e.noAddress || []), ...Object.values(e.excluded || {}).flat()];
	eq("§1 ...every Driver account is in exactly one bucket", [all.length, new Set(all).size], [15, 15]);
}

// ── §2 the options ────────────────────────────────────────────────────────────
console.log("\n§2 --include-inactive and --campaign");
{
	const inactive = DB ? report([`--db=${DB}`, "--json", "--include-inactive"]).json : null;
	eq("§2 --include-inactive: the inactive driver would be sent to",
		inactive && [inactive.email.includeInactive, inactive.email.wouldSend, inactive.email.excluded.inactive], [true, [90401, 90402, 90406, 90409], []]);
	const other = DB ? report([`--db=${DB}`, "--json", "--campaign=emergency-contacts-2"]).json : null;
	eq("§2 --campaign: another campaign's rows don't count, so those three would be sent to",
		other && [other.email.campaign, other.email.wouldSend, other.email.alreadySent, other.email.uncertain, other.email.failedEarlier],
		["emergency-contacts-2", [90401, 90402, 90406, 90410, 90411, 90412], [], [], []]);
}

// ── §3 counts and ids only ────────────────────────────────────────────────────
console.log("\n§3 counts and ids only");
{
	const text = DB ? report([`--db=${DB}`]) : { code: -1, out: "" };
	ok("§3 the text report runs (exit 0)", text.code === 0, `exit ${text.code}: ${text.out.slice(0, 300)}`);
	ok("§3 ...and names the campaign and its would-send count", /emergency-contacts-1/.test(text.out) && /would send: 3\b/.test(text.out), text.out.slice(0, 400));
	const values = [
		...DRIVERS.map((d) => d[1]), ...DRIVERS.map((d) => d[5]).filter(Boolean), ...STAFF.map((s) => s[3]),
		...DIRECTORY.map((d) => d[1]), ...DIRECTORY.map((d) => d[3]).filter(Boolean), "+15125550199", "5125550199",
		...DRIVERS.flatMap(([id, , , , n]) => Array.from({ length: n }, (_, i) => [contactName(id, i + 1), contactPhone(id, i + 1), contactPhone(id, i + 1).slice(2)]).flat()),
	];
	for (const [label, out] of [["text", text.out], ["JSON", main.out]]) {
		const hits = values.filter((v) => out.includes(v));
		eq(`§3 the ${label} output holds no made-up name, address or phone number`, hits, []);
		ok(`§3 the ${label} output holds no @ at all`, !out.includes("@"));
	}
}

// ── §4 read-only ──────────────────────────────────────────────────────────────
console.log("\n§4 read-only");
ok("§4 the database file is byte-for-byte unchanged after five runs", DB && sha(DB) === beforeHash);
{
	let src = "";
	try { src = fs.readFileSync(SCRIPT, "utf8"); } catch { src = ""; }
	ok("§4 the script opens the database through the read-only handle (openDb, readonly: true)", /openDb\(\{[^}]*readonly: true[^}]*\}\)/.test(src));
	ok("§4 ...and writes nothing: no INSERT, UPDATE, DELETE or DROP in it", src.length > 0 && !/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\s/i.test(src.replace(/\/\/.*$/gm, "")));
}

// ── §5 before the table exists ────────────────────────────────────────────────
console.log("\n§5 before the table exists");
{
	const bare = AUDIT_DDL ? buildDb(path.join(TMP, "no-table.db"), { withContacts: false }) : null;
	const r = bare ? report([`--db=${bare}`, "--json"]) : { code: -1, json: null, out: "" };
	ok("§5 the report runs on a database without the table (exit 0)", r.code === 0 && !!r.json, `exit ${r.code}: ${r.out.slice(0, 200)}`);
	eq("§5 ...says so and counts every enabled driver at 0", r.json && [r.json.contactsTable, r.json.contactsOnFile], [false, { zero: 14, one: 0, twoToFive: 0, overFive: 0, overFiveIds: [] }]);
	eq("§5 ...so nobody is complete, and the prompt reaches every fully onboarded or unrecorded driver",
		r.json && [r.json.email.complete, r.json.prompt], [[], 11]);
}

// ── §6 refusals ───────────────────────────────────────────────────────────────
console.log("\n§6 refusals");
{
	const missing = report([`--db=${path.join(TMP, "missing.db")}`]);
	ok("§6 a missing database: exit 2", missing.code === 2, `exit ${missing.code}: ${missing.out.slice(0, 200)}`);
	const replica = report([], { LOCAL_REPLICA: "1" });
	ok("§6 replica mode without --db: exit 2", replica.code === 2, `exit ${replica.code}: ${replica.out.slice(0, 200)}`);
	const badKey = DB ? report([`--db=${DB}`, "--campaign=Not A Key"]) : { code: -1, out: "" };
	ok("§6 a campaign key that is not lower-case letters, digits and hyphens: exit 2", badKey.code === 2, `exit ${badKey.code}: ${badKey.out.slice(0, 200)}`);
}

console.log(`\ntest-emergency-contacts-report: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
