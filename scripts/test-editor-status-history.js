#!/usr/bin/env node
/**
 * A status set in the admin editors is recorded in load_status_history.
 *
 * WHY THIS EXISTS. PUT /api/data/:rowIndex and PUT /api/load/:loadId rewrote
 * Job Status and inserted nothing into load_status_history. Every other status
 * writer records its transition there, and the driver's 7-day receipt window
 * (lib/expense-window.js) takes its delivery time from that table — so a load
 * marked Delivered from an editor had no delivery time, read as 'unknown', and
 * the driver was sent to ask dispatch. The status timeline skipped the step too.
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 recordEditorStatusChange(), LIFTED FROM server.js together with the real
 *      recordStatusChange() it delegates to, over a recording statement
 *   §2 both editor routes call it once, AFTER the sheet write and its success
 *      audit and BEFORE the reply — so a refused or failed write records nothing;
 *      the extracted call line is executed
 *   §3 end to end on a real in-memory SQLite built from server.js's own
 *      CREATE TABLE and INSERT: an editor-set Delivered yields a delivery time,
 *      and the receipt window reads 'open' instead of 'unknown'
 *   §4 DISCRIMINATION — mutants of the helper and of both routes
 *
 * SERVER_JS=<path> points the whole run at another copy of server.js (e.g. the
 * pre-fix base) to show these assertions fail there rather than passing vacuously.
 *
 * Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-editor-status-history.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");
const rule = require(path.join(ROOT, "lib", "expense-window.js"));

let pass = 0;
let fail = 0;
function ok(name, cond) {
	if (cond) { pass++; return true; }
	fail++;
	console.log(`FAIL  ${name}`);
	return false;
}
function section(t) { console.log(`\n${t}`); }

// A top-level `function name(` out of server.js: paren-match the parameter list,
// then brace-count the body. Returns null (and records a FAIL) when it is absent,
// so a run against pre-fix code reports every check it cannot make.
function liftFn(name, src = SRC) {
	const needle = `\nfunction ${name}(`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) { ok(`exactly one definition of ${name}() in server.js (found ${hits})`, false); return null; }
	const a = src.indexOf(needle) + 1;
	let p = src.indexOf("(", a);
	for (let d = 0; p < src.length; p++) {
		if (src[p] === "(") d++;
		else if (src[p] === ")") { d--; if (d === 0) break; }
	}
	let depth = 0;
	for (let i = src.indexOf("{", p); i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(a, i + 1); }
	}
	return null;
}
// A route registration, anchored at a line start (comments quote routes).
function routeSource(verb, routePath, src = SRC) {
	const nl = src.indexOf(`\napp.${verb}("${routePath}"`);
	if (nl < 0) return null;
	let depth = 0;
	for (let j = src.indexOf("(", nl + 1); j < src.length; j++) {
		if (src[j] === "(") depth++;
		else if (src[j] === ")") { depth--; if (depth === 0) return src.slice(nl + 1, j + 1); }
	}
	return null;
}
// Replace exactly one occurrence, or throw: a mutant whose target is gone would
// run the original code and "pass", proving nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) throw new Error(`mutant target found ${n}× (expected 1): ${from.slice(0, 70)}`);
	return src.replace(from, to);
}

const FINDCOL_SRC = liftFn("findCol");
const RECORD_SRC = liftFn("recordStatusChange");
const HELPER_SRC = liftFn("recordEditorStatusChange");

// The helper with the real recordStatusChange() behind it, over a statement that
// records every .run() — or throws, to prove a failed insert never escapes.
function buildHelper({ helperSrc = HELPER_SRC, insertThrows = null, stmt = null } = {}) {
	const runs = [];
	const logs = [];
	const insertStatusHistory = stmt || { run: (...args) => { if (insertThrows) throw insertThrows; runs.push(args); } };
	const fn = new Function("insertStatusHistory", "console",
		`"use strict";\n${FINDCOL_SRC}\n${RECORD_SRC}\n${helperSrc}\nreturn recordEditorStatusChange;`,
	)(insertStatusHistory, { error: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), log() {} });
	return { fn, runs, logs };
}

// Production's Job Tracking headers, in order (the columns this reads, and the
// "Status Update Date" that must not be mistaken for the status).
const HEADERS = ["Contract ID", "Load ID", "Driver", "Job Status", "Status Update Date", "Completion Date", "  Payment  "];
const row = (id, status, extra = {}) => HEADERS.map((h) => (h === "Load ID" ? id : h === "Job Status" ? status : h === "Driver" ? "Deshorn King" : (extra[h] || "")));
const asUser = (username) => ({ session: { user: { role: "Super Admin", username } } });

// ===========================================================================
section("§1  recordEditorStatusChange(), lifted from server.js");
// ===========================================================================
if (FINDCOL_SRC && RECORD_SRC && HELPER_SRC) {
	let h = buildHelper();
	h.fn(asUser("super_admin"), HEADERS, row("#564157463", "At Receiver"), row("#564157463", "Delivered"));
	ok("an editor setting Delivered writes ONE history row", h.runs.length === 1);
	ok("...normalized id, old → new, source 'admin-edit', the session username, no reason",
		JSON.stringify(h.runs[0]) === JSON.stringify(["564157463", "At Receiver", "Delivered", "admin-edit", "super_admin", ""]));

	h = buildHelper();
	h.fn(asUser("amir_serrano"), HEADERS, row("100001", "In Transit"), row("100001", "In Transit", { "  Payment  ": "$900" }));
	ok("an edit that leaves the status alone writes nothing", h.runs.length === 0);
	h.fn(asUser("amir_serrano"), HEADERS, row("100001", "Delivered"), row("100001", " delivered "));
	ok("re-saving the same status (case / whitespace only) writes nothing", h.runs.length === 0);
	h.fn(asUser("amir_serrano"), HEADERS, row("100001", "Delivered"), row("100001", "Delivered", { "Status Update Date": "09/23/2026 10:00:00" }));
	ok("a change to 'Status Update Date' alone is not a status change (the status column is picked precisely)", h.runs.length === 0);

	h = buildHelper();
	h.fn(asUser("super_admin"), HEADERS, row("100002", ""), row("100002", "Delivered"));
	ok("blank → Delivered is recorded, with a blank old status", h.runs.length === 1 && h.runs[0][1] === "" && h.runs[0][2] === "Delivered");
	h.fn(asUser("super_admin"), HEADERS, row("100003", "Delivered"), row("100003", "In Transit"));
	ok("a revert out of Delivered is recorded too (it ends the delivered run)", h.runs.length === 2 && h.runs[1][2] === "In Transit");

	h = buildHelper();
	h.fn(asUser("super_admin"), HEADERS, row("100004", "At Receiver"), row("#100005", "Delivered"));
	ok("an edit that also retyped the Load ID records under the id the row carries NOW", h.runs.length === 1 && h.runs[0][0] === "100005");

	h = buildHelper();
	h.fn({}, HEADERS, row("100006", "At Receiver"), row("100006", "Delivered"));
	ok("no session → blank actor, still recorded", h.runs.length === 1 && h.runs[0][4] === "");

	h = buildHelper();
	let threw = null;
	try {
		h.fn(asUser("super_admin"), ["Load ID", "Driver"], ["1", "x"], ["1", "y"]);
		h.fn(asUser("super_admin"), ["Driver", "Job Status"], ["x", "At Receiver"], ["x", "Delivered"]);
		h.fn(asUser("super_admin"), null, null, null);
	} catch (e) { threw = e; }
	ok("no status column / no load-id column / nothing at all → nothing written, nothing thrown", threw === null && h.runs.length === 0);

	const DB_DOWN = Object.assign(new Error("SQLITE_IOERR: disk I/O error"), { code: "SQLITE_IOERR" });
	h = buildHelper({ insertThrows: DB_DOWN });
	threw = null;
	try { h.fn(asUser("super_admin"), HEADERS, row("100007", "At Receiver"), row("100007", "Delivered")); } catch (e) { threw = e; }
	ok("a failing insert NEVER fails the edit — nothing thrown…", threw === null);
	ok("…and it is logged", h.logs.some((l) => /SQLITE_IOERR/.test(l)));
}

// ===========================================================================
section("§2  both editor routes record it — after the write, before the reply");
// ===========================================================================
const CALL_LINE = "if (guarded) recordEditorStatusChange(req, headers, before, after);";
function editorWiring(route) {
	const problems = [];
	if (!route) return ["route not found"];
	const lines = route.split("\n").map((l) => l.trim());
	const at = (re) => lines.findIndex((l) => re.test(l));
	const count = lines.filter((l) => l === CALL_LINE).length;
	if (count !== 1) problems.push(`the call appears ${count}× (expected exactly 1)`);
	const call = lines.indexOf(CALL_LINE);
	const write = at(/sheets\.spreadsheets\.values\.update\(/);
	const audit = at(/^logAudit\(req, "update_sheet_row", /);
	const reply = lines.findIndex((l, i) => i > audit && /^res\.json\(/.test(l));
	if (write < 0 || audit < 0 || reply < 0) problems.push("could not find the write, its success audit, or the reply");
	if (call >= 0 && call < write) problems.push("recorded BEFORE the sheet write — a refused or failed write would leave a row");
	if (call >= 0 && call < audit) problems.push("recorded before the success audit (i.e. possibly on a failed write)");
	if (call >= 0 && reply >= 0 && call > reply) problems.push("recorded after the reply");
	return problems;
}
const ROUTES = [["put", "/api/data/:rowIndex"], ["put", "/api/load/:loadId"]];
for (const [verb, p] of ROUTES) {
	const problems = editorWiring(routeSource(verb, p));
	for (const x of problems) console.log(`      ${p}: ${x}`);
	ok(`${verb.toUpperCase()} ${p} records the status change once, after the write and its audit, before the reply`, problems.length === 0);
}
{
	const run = (guarded) => {
		const calls = [];
		new Function("guarded", "recordEditorStatusChange", "req", "headers", "before", "after",
			`"use strict";\n${CALL_LINE}`)(guarded, (...a) => calls.push(a), "REQ", "H", "B", "A");
		return calls;
	};
	ok("the extracted line records on Job Tracking (guarded), passing the row before and after", JSON.stringify(run(true)) === JSON.stringify([["REQ", "H", "B", "A"]]));
	ok("...and not on any other tab", run(false).length === 0);
}

// ===========================================================================
section("§3  end to end: an editor-set Delivered opens the driver's receipt window");
// ===========================================================================
{
	const table = (SRC.match(/CREATE TABLE IF NOT EXISTS load_status_history \([\s\S]*?\n\t\)/) || [])[0];
	const reasonCol = (SRC.match(/ALTER TABLE load_status_history ADD COLUMN reason TEXT DEFAULT ''/) || [])[0];
	const insertSql = (SRC.match(/const insertStatusHistory = db\.prepare\(\s*`([^`]+)`/) || [])[1];
	if (ok("server.js's own table, reason column and INSERT were found", !!(table && reasonCol && insertSql)) && HELPER_SRC && RECORD_SRC && FINDCOL_SRC) {
		const db = new Database(":memory:");
		db.exec(table);
		db.exec(reasonCol);
		// changed_at is CURRENT_TIMESTAMP; pin "now" so the window can be judged.
		const { fn } = buildHelper({ stmt: db.prepare(insertSql) });
		fn(asUser("super_admin"), HEADERS, row("563000111", "At Receiver"), row("563000111", "Delivered"));
		// The read the gate and the driver route make.
		const history = db.prepare(
			`SELECT old_status, new_status, strftime('%Y-%m-%dT%H:%M:%SZ', changed_at) AS changed_at
			   FROM load_status_history WHERE load_id = ? ORDER BY changed_at ASC, id ASC`).all("563000111");
		const deliveredAt = rule.deliveredAtFromHistory(history);
		ok("the row lands in the real table and yields a delivery time", history.length === 1 && typeof deliveredAt === "string");
		const now = Date.parse(deliveredAt) + 60 * 1000;
		ok("…so the receipt window is OPEN (it read 'unknown' — ask dispatch — with no row)",
			rule.expenseWindow({ status: "Delivered", deliveredAt, now }).state === "open" &&
			rule.expenseWindow({ status: "Delivered", deliveredAt: rule.deliveredAtFromHistory([]), now }).state === "unknown");
		fn(asUser("super_admin"), HEADERS, row("563000111", "Delivered"), row("563000111", "Completed"));
		const after = db.prepare(
			`SELECT old_status, new_status, strftime('%Y-%m-%dT%H:%M:%SZ', changed_at) AS changed_at
			   FROM load_status_history WHERE load_id = ? ORDER BY changed_at ASC, id ASC`).all("563000111");
		ok("a later editor move Delivered → Completed is recorded but does NOT restart the window",
			after.length === 2 && rule.deliveredAtFromHistory(after) === deliveredAt);
		db.close();
	}
}

// ===========================================================================
section("§4  DISCRIMINATION — each mutant must be caught");
// ===========================================================================
for (const [verb, p] of ROUTES) {
	const route = routeSource(verb, p);
	if (!route || route.indexOf(CALL_LINE) < 0) { ok(`M1 ${p}: (mutant needs the call line)`, false); continue; }
	const without = route.replace(`\t\t${CALL_LINE}\n`, "");
	ok(`M1 ${p} without the call is caught by §2`, editorWiring(without).length > 0);
	const early = mutate(without, "\t\tconst sheets = await getSheets();\n", `\t\tconst sheets = await getSheets();\n\t\t${CALL_LINE}\n`);
	ok(`M2 ${p} recording before the write is caught by §2`, editorWiring(early).length > 0);
}
if (HELPER_SRC) {
	const m3 = buildHelper({ helperSrc: mutate(HELPER_SRC, "loadId: cell(after, loadIdCol) || cell(before, loadIdCol),", "loadId: cell(before, loadIdCol),") });
	m3.fn(asUser("super_admin"), HEADERS, row("100004", "At Receiver"), row("#100005", "Delivered"));
	ok("M3 recording under the OLD id after a Load ID retype is caught by §1", m3.runs.length === 1 && m3.runs[0][0] !== "100005");
	const m4 = buildHelper({ helperSrc: mutate(HELPER_SRC, "oldStatus: cell(before, statusCol),", "oldStatus: \"\",") });
	m4.fn(asUser("super_admin"), HEADERS, row("100001", "Delivered"), row("100001", "Delivered", { "  Payment  ": "$1" }));
	ok("M4 a helper that loses the old status records a non-change (so §1 would fail)", m4.runs.length === 1);
	const m5 = buildHelper({ helperSrc: mutate(HELPER_SRC, "const statusCol = findCol(hs, /^(job[\\s._-]?)?status$/i) || findCol(hs, /status/i);", "const statusCol = findCol(hs, /status/i);") });
	const flipped = ["Load ID", "Status Update Date", "Job Status"];
	m5.fn(asUser("super_admin"), flipped, ["1", "09/22/2026 9:00:00", "Delivered"], ["1", "09/23/2026 9:00:00", "Delivered"]);
	ok("M5 a loose /status/ pick reads the DATE column as the status (so §1's precise-pick check guards it)", m5.runs.length === 1);
	const real = buildHelper();
	real.fn(asUser("super_admin"), flipped, ["1", "09/22/2026 9:00:00", "Delivered"], ["1", "09/23/2026 9:00:00", "Delivered"]);
	ok("...while the real helper reads 'Job Status' and records nothing", real.runs.length === 0);
}

console.log(`\neditor-status-history: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
