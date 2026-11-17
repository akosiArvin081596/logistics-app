#!/usr/bin/env node
/**
 * scripts/kpi-followups-report.js --part=weekly, run as a child process on a
 * made-up database and a made-up Job Tracking copy (R4, lane W part A's step 5).
 *
 * §1 it exits 0, prints its JSON, and leaves the database byte for byte as it
 *    was (opened read-only).
 * §2 (a) the Monday email, built by lib/kpi-digest.js buildDigest() from the
 *    run's own answer and never sent: for the next Monday, last week against
 *    the week before and the one line in place of the month section; for a
 *    first Monday, the month section too; with kpi.weekly_since unset (a first
 *    switch-on) every weekly approval line reads No.
 * §3 (b) the metrics approved now, each with its approval day, and which of
 *    them K29 asks to approve again (weekly ones only); a stale approval is not
 *    listed.
 * §4 with kpi.weekly_since before an approval, that metric's weekly line reads
 *    Yes and it needs no re-approval.
 * §5 no name, load id or email address in the JSON or the text output; the
 *    weekly compute time is a signed figure (PR 1 review, L7).
 * §6 no send path is reachable: the lift denies the mailer and the email
 *    claim, and the report reaches neither.
 *
 * Made-up data only ("Zed Sentinel" names, sentinel ids, example.test). The
 * database and the sheet copy live in a temporary folder this runner removes.
 *
 * Run: node scripts/test-kpi-followups-report.js    # exits 1 on failure
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPORT = path.join(__dirname, "kpi-followups-report.js");
const SRC = require("./lib/server-source").serverSource();
const catalog = require(path.join(ROOT, "lib", "kpi-catalog.js"));

function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

function tableDdl(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${name}`);
	return `CREATE TABLE ${name} (${m[1]}\n)`;
}
function alterDdl(table, col) {
	const m = SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN ${col} [^"\`]*`));
	if (!m) die(`could not locate the ${table}.${col} migration`);
	return m[0];
}
// Every table the lifted KPI gatherers and the report read, as server.js makes them.
const DDL = [
	tableDdl("trucks"), alterDdl("trucks", "in_service_date"), alterDdl("trucks", "retired_at"), alterDdl("trucks", "routemate_vehicle_id"),
	tableDdl("eld_miles_daily"), tableDdl("eld_device_assignments"),
	tableDdl("expenses"), alterDdl("expenses", "gallons"), alterDdl("expenses", "receipt_details"),
	tableDdl("audit_trail"), tableDdl("load_status_history"), tableDdl("invoice_autogen_runs"),
	tableDdl("load_eld_miles"), tableDdl("load_coordinates"), tableDdl("load_ratecon_miles"),
	tableDdl("app_settings"), tableDdl("server_state"), tableDdl("deleted_loads"), tableDdl("period_locks"),
	tableDdl("kpi_snapshots"), tableDdl("kpi_metric_approvals"), tableDdl("kpi_load_weights"), tableDdl("truck_assignments"),
];

const SENTINELS = [/sentinel/i, /@/, /zed\.admin/i];
const DRIVER = "Quinn Sentinel";
const BROKER = "Zed Sentinel Freight";
const RECIPIENT = "quinn.sentinel@example.test";

function addDays(day, n) {
	return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
const isWeekend = (day) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());

function seed(db) {
	for (const sql of DDL) db.exec(sql);
	require(path.join(ROOT, "lib", "kpi-ratecon-pass.js")).ensureTables(db);
	require(path.join(ROOT, "lib", "kpi-deadhead-routes.js")).ensureTables(db);
	const truck = db.prepare("INSERT INTO trucks (id, unit_number, status, created_at, in_service_date, retired_at, routemate_vehicle_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
	truck.run(1, "101", "Active", "2026-04-01 12:00:00", "2026-04-01", "", "rv-1");
	truck.run(2, "102", "Active", "2026-05-01 12:00:00", "2026-05-01", "", "rv-2");
	const eld = db.prepare("INSERT INTO eld_miles_daily (routemate_vehicle_id, local_day, driver_key, driver_name, truck_id, miles) VALUES (?, ?, ?, ?, ?, ?)");
	for (let d = "2026-09-01"; d <= "2026-11-19"; d = addDays(d, 1)) {
		if (isWeekend(d)) continue;
		eld.run("rv-1", d, "quinn sentinel", DRIVER, 1, 400);
		eld.run("rv-2", d, "quinn sentinel", DRIVER, 2, 300);
	}
	const exp = db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, photo_data, status, gallons, receipt_details, created_at) VALUES ('t', ?, 'Fuel', ?, ?, 'PHOTO-SENTINEL', 'Approved', ?, ?, ?)");
	exp.run(DRIVER, 500, "2026-10-06", 100, `[{"label":"Vendor","value":"${BROKER}"}]`, "2026-10-06 15:00:00");
	exp.run(DRIVER, 520, "2026-11-03", 104, "", "2026-11-03 15:00:00");
	db.prepare("INSERT INTO app_settings (key, value) VALUES ('kpi.settings', ?)")
		.run(JSON.stringify({ aiDispatchStart: null, dedicatedStart: null, baselineMpg: 6.5, recipients: [RECIPIENT] }));
	const ap = db.prepare("INSERT INTO kpi_metric_approvals (metric_key, approved, definition_version, settings_hash, approved_by, approved_at) VALUES (?, 1, ?, '', 'zed.admin', ?)");
	ap.run("loads_delivered", catalog.metricByKey("loads_delivered").definitionVersion, "2026-11-10T15:00:00.000Z");
	ap.run("fuel_mpg", catalog.metricByKey("fuel_mpg").definitionVersion, "2026-11-11T15:00:00.000Z");
	// An approval of an earlier definition: not valid now, so not listed.
	ap.run("revenue", 0, "2026-11-12T15:00:00.000Z");
}

// Job Tracking as values.get returns it: the weeks Oct 31-Nov 6 (2 loads),
// Nov 7-13 (3, its Saturday and its Friday included) and Nov 14-19 so far.
function sheet() {
	const headers = ["Contract ID", "Load ID", "Status", "Driver", "Truck", "Details", "Pickup Appointment", "Drop-off Appointment", "Completion Date", "Payment"];
	const rows = [];
	const add = (day, status, pay) => rows.push([BROKER, `LOAD-SENTINEL-${rows.length + 101}`, status, DRIVER, "101", `${BROKER}, 40,000 lbs`, day, day, day, pay]);
	for (const d of ["2026-10-05", "2026-10-15", "2026-10-25"]) add(d, "Delivered", "$2,000.00");
	add("2026-11-02", "Delivered", "$2,000.00");
	add("2026-11-05", "Delivered", "$2,500.00");
	add("2026-11-07", "Delivered", "$3,000.00");
	add("2026-11-10", "Delivered", "$3,000.00");
	add("2026-11-13", "Delivered", "$3,000.00");
	add("2026-11-10", "Cancelled", "$9,999.00");
	add("2026-11-17", "Delivered", "$1,500.00");
	return { values: [headers, ...rows] };
}

const sha1 = (file) => crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");

function runReport(dir, extra) {
	const res = spawnSync(process.execPath, [REPORT, "--part=weekly", `--db=${path.join(dir, "app.db")}`, `--env-file=${path.join(dir, "made-up-settings.txt")}`,
		`--values-json=${path.join(dir, "jt.json")}`, "--as-of=2026-11-19", ...extra], {
		cwd: ROOT, encoding: "utf8", timeout: 120000,
		env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), TZ: "UTC" },
	});
	return { status: res.status, out: res.stdout || "", err: res.stderr || "" };
}

let pass = 0;
const failures = [];
function record(results) {
	for (const x of results) { if (x.ok) pass++; else failures.push(x.name); }
	console.log(`  ${results.filter((x) => x.ok).length}/${results.length} checks`);
}

// The lines under `label` inside `text`, up to the next blank line.
function blockOf(text, label, from = 0) {
	const at = text.indexOf(`\n${label}\n`, from);
	if (at < 0) return "";
	const end = text.indexOf("\n\n", at + 1);
	return text.slice(at + 1, end < 0 ? undefined : end);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kpi-report-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const dbFile = path.join(dir, "app.db");
{
	const db = new Database(dbFile);
	seed(db);
	db.close();
}
fs.writeFileSync(path.join(dir, "made-up-settings.txt"), "");
fs.writeFileSync(path.join(dir, "jt.json"), JSON.stringify(sheet()));

const results = [];
const t = (cond, name) => results.push({ ok: !!cond, name });

// §1
const before = sha1(dbFile);
const jsonRun = runReport(dir, ["--json"]);
let r = null;
try { r = JSON.parse(jsonRun.out); } catch { r = null; }
t(jsonRun.status === 0 && r && r.part === "weekly", `§1 the report exits 0 with its JSON (exit ${jsonRun.status}${jsonRun.err ? `: ${jsonRun.err.split("\n")[0]}` : ""})`);
t(sha1(dbFile) === before, "§1 the database is byte for byte as it was");
const email = (r && r.email) || {};
const next = email.nextMonday || {};
const first = email.firstMonday || {};

// §2 (a)
t(email.builtFrom === "2026-11-19" && next.day === "2026-11-23" && first.day === "2026-12-07", `§2 the next Monday and the first Monday after it (${JSON.stringify([email.builtFrom, next.day, first.day])})`);
t(next.subject === "LogisX weekly KPIs: Nov 7-13, 2026" && first.subject === next.subject, `§2 the subject names the last complete week as of the run (${JSON.stringify(next.subject)})`);
const nextText = String(next.text || "");
const firstText = String(first.text || "");
t(nextText.includes("\nLast week (Nov 7-13) against the week before (Oct 31-Nov 6)\n"), "§2 last week against the week before");
t(blockOf(nextText, "Loads delivered").startsWith("Loads delivered\n  Last week (Nov 7-13): 3. Week before (Oct 31-Nov 6): 2. Change: +50.0%.\n  Measured.\n"),
	`§2 loads delivered: the run's own figures, the Saturday and the Friday in their week, the cancelled load out (${JSON.stringify(blockOf(nextText, "Loads delivered"))})`);
t(nextText.includes("\nMonthly figures come in the first Monday's email of each month.\n") && !nextText.includes("\nMonth\n"), "§2 the next Monday (the 23rd): no month section, the one line");
t(firstText.includes("\nMonth\n") && !firstText.includes("Monthly figures come in"), "§2 a first Monday: the month section");
const weeklyPart = nextText.slice(nextText.indexOf("\nLast week ("));
t(weeklyPart.includes("Approved for public use (weekly figures)") && !/Approved for public use \(weekly figures\): Yes/.test(weeklyPart),
	"§2 kpi.weekly_since unset: every weekly approval line reads No");
t(/\nLoads delivered\n(?: {2}.*\n)*? {2}Approved for public use: Yes/.test(firstText.slice(firstText.indexOf("\nMonth\n"))),
	"§2 ...while the month section keeps the monthly approval");
t(nextText.includes("Last week (") && !/Nov 14-19/.test(nextText) && !nextText.includes("$1,500"), "§2 the week in progress is not in the email");

// §3 (b)
const approved = Array.isArray(r && r.approvedNow) ? r.approvedNow : null;
t(approved && JSON.stringify(approved) === JSON.stringify([
	{ key: "loads_delivered", day: "2026-11-10", mode: "weekly", reapprove: true },
	{ key: "fuel_mpg", day: "2026-11-11", mode: "monthly_only", reapprove: false },
]), `§3 the metrics approved now, their approval day, and the re-approvals K29 asks for (${JSON.stringify(approved)})`);

// §4 kpi.weekly_since before the loads approval.
{
	const db = new Database(dbFile);
	db.prepare("INSERT INTO server_state (key, value, updated_at) VALUES ('kpi.weekly_since', '2026-11-09T12:00:00.000Z', '2026-11-09 12:00:00')").run();
	db.close();
}
const sinceBefore = sha1(dbFile);
const sinceRun = runReport(dir, ["--json"]);
let s = null;
try { s = JSON.parse(sinceRun.out); } catch { s = null; }
const sinceText = String((s && s.email && s.email.nextMonday && s.email.nextMonday.text) || "");
t(sinceRun.status === 0 && sha1(dbFile) === sinceBefore, "§4 the report exits 0 and writes nothing");
t(blockOf(sinceText, "Loads delivered").endsWith("Approved for public use (weekly figures): Yes")
	&& blockOf(sinceText, "Gross load revenue").endsWith("Approved for public use (weekly figures): No"),
"§4 an approval after kpi.weekly_since covers the weekly line; none other does");
t(s && Array.isArray(s.approvedNow) && s.approvedNow.length === 2 && s.approvedNow.every((x) => x.reapprove === false), "§4 ...and nothing is left to approve again");

// §5 the outputs, and L7's signed compute time.
const textRun = runReport(dir, []);
t(textRun.status === 0 && /\(a\) /.test(textRun.out) && /\(b\) /.test(textRun.out) && /never sent/.test(textRun.out), "§5 the text output prints parts (a) and (b), and says the email is never sent");
for (const [name, out] of [["JSON", jsonRun.out + sinceRun.out], ["text", textRun.out]]) {
	const hit = SENTINELS.find((re) => re.test(out));
	t(out.length > 0 && !hit, `§5 the ${name} output names no driver, broker, load id, account or email address${hit ? ` (found ${hit})` : ""}`);
}
t(/ ms on \([+-]\d+ ms\)/.test(textRun.out) && !/\+-/.test(textRun.out) && Number.isFinite(r && r.computeMsAdded) && Number.isInteger(r && r.computeRuns) && r.computeRuns >= 3,
	`§5 L7: the added compute time is a signed median over several warm runs (${(textRun.out.match(/Compute:[^\n]*/) || [""])[0]})`);

// §6 no send path.
{
	const report = require(REPORT);
	const { closure } = require("./lib/server-lift");
	const denied = new Set(report.DENIED || []);
	t(["sendEmail", "transporter", "kpiClaimAndSend", "kpiStoreResult", "runKpiSnapshot"].every((n) => denied.has(n)), "§6 the lift denies the mailer, the email claim and the KPI writers");
	let lifted = null;
	try {
		lifted = closure(SRC, { roots: report.ROOTS, provided: ["db", "require", "console", "process", "__dirname", "fetch"], denied: report.DENIED });
	} catch (e) {
		lifted = { error: e.message };
	}
	t(lifted && !lifted.error && ["kpiPayload", "kpiWeeklyRowsOf", "kpiEnforceApprovals"].every((n) => lifted.names.includes(n)) && !lifted.names.some((n) => denied.has(n)),
		`§6 the report lifts the server's own row and approval code and nothing that sends (${lifted && lifted.error ? lifted.error : "ok"})`);
	const reportSrc = fs.readFileSync(REPORT, "utf8");
	t(!/\bsendEmail\(|\bkpiClaimAndSend\(|nodemailer/.test(reportSrc) && /require\("\.\/lib\/kpi-digest"\)|appRequire\("\.\/lib\/kpi-digest"\)/.test(reportSrc),
		"§6 the report builds the email with lib/kpi-digest.js and calls no sender");
}

console.log("\n§1-§6 kpi-followups-report.js --part=weekly on made-up data");
record(results);
if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`\n✓ ${pass} assertions passed`);
