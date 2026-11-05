#!/usr/bin/env node
// Driver availability (R11) never touches money. Availability is about the
// DRIVER (who can be dispatched, whether a quiet truck is expected); it creates
// and removes no pay day, and no fixed cost, fee, reserve, payout, projection,
// Financials figure or invoice reads it. These guards pass before and after the
// feature: they pin that it stays out of the money paths.
//
//   §0 the comment stripper blanks comments only: a "/*" in a string, template
//      or regex literal hides no code, and every route head in server.js
//      outside a comment survives it; once routes move, the ROUTE_CONTEXT list
//      is no mention, while a read in a moved route still is
//   §1 behaviour: a month with the driver recorded off all month gives the same
//      weekly invoice, investor view and payout ledger (fixed costs included)
//      as the same month with no row, with DRIVER_AVAILABILITY_ENABLED on
//   §2 the money modules in lib/ never name a tracked name
//   §3 in server.js every mention of a tracked name sits inside an allowlisted
//      declaration or route: the migration and the availability routes, the
//      directory list and delete, eldFeedSnapshot(), the helpers themselves, the
//      five assign routes, the dashboard and the trucks list. So the payout
//      builders, Financials, the fixed-cost and projection queries and the
//      invoice generator can neither read the table nor call a helper that does.
//      The driver app's payload (GET /api/driver/:driverName) is NOT allowlisted:
//      it carries invoiceTotalDue. There a tracked name may stand only on the one
//      line of its res.json({...}) that spreads `timeOff` behind
//      DRIVER_TIME_OFF_SCREEN_ENABLED (R11 follow-up), and nowhere else in it.
//   §4 every call of the off-duty check sits inside
//      `if (DRIVER_AVAILABILITY_ENABLED) {`; DRIVER_TIME_OFF_SCREEN_ENABLED folds
//      in the main flag and gates only that spread; so does
//      DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED (R11b), and each of its three
//      steps (the Job Tracking read, the decision, the confirmations) is the
//      first statement of an `if (DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED...) {`,
//      which gates nothing else
// The time-off ELD check (B) is tracked the same way: its results table, its
// module and binding, every name the module exports and its server.js helpers.
// §1 also gives the month off Confirmed and Not-confirmed day results; §3 allows
// its binding, helpers, job and purge, and its table in the same migration; and
//   §4.8 DRIVER_TIME_OFF_ELD_CHECK_ENABLED folds in DRIVER_AVAILABILITY_ENABLED
//      first and gates only the job's registration (with its start-up line), the
//      job's own guard, the staff list's spread and the driver's eldChecked line
//   §5 GET /api/trucks and every investor route name none of the check's names
//   §6 its helpers are defined and survive comment stripping, and its table is
//      created in the time-off migration
// A driver's request (plan B Revision 2, PR 4) is tracked the same way: its four
// routes, its helpers and the column migration are allowlisted in §3 (so §3.1
// proves no request name reaches a money path); §1 also runs a month holding a
// waiting, a declined and an approved driver request beside the staff row and
// expects the same figures; and
//   §4.9 DRIVER_TIME_OFF_REQUESTS_ENABLED folds in DRIVER_TIME_OFF_SCREEN_ENABLED
//      first and appears only in its route gate, its start-up line, the driver
//      notice's guard, the staff row view's request keys, the overlap check's
//      bound value and driverOwnTimeOff()'s request keys
//   §5b GET /api/trucks and every investor route name none of the request names
// Home time (H1) rides the same flag: its two columns are tracked names (so §3
// keeps them to the allowlisted places), the lib's home exports are tracked as
// exports; §1 also runs that month with a home time on every row; §4.9b names
// the flag's four new places (the staff list's homeTime key, the staff create's
// and edit's validator scope, the driver's rows' home key); and
//   §5c GET /api/trucks, every investor route, every KPI route and the KPI
//      modules in lib/ name none of the home time's names
// The note to CHR's contact (plan B PR 5) is tracked the same way: its table, module,
// binding and server.js helpers; §3 allows its boot reads, its CREATE, its helpers and
// its Retry route; §1 also runs the month with a made note on the approved request; and
//   §4.10 DRIVER_TIME_OFF_CHR_DRAFT_ENABLED folds in DRIVER_TIME_OFF_REQUESTS_ENABLED
//      first and appears only in the recipient's boot read, the CREATE, the Retry
//      route's gate, the decision, the draft row readers and the staff panel's spread
//   §5d GET /api/trucks, every investor route and every KPI route name none of its names
//
// Tracked names: the table, the module path, the module's binding in server.js,
// every name lib/driver-availability.js exports (read from the module, so a new
// export is tracked on its own), and the server.js helpers that read the table,
// listed by name below.
// Run: node scripts/test-driver-availability-guards.js

"use strict";

const fs = require("fs");
const path = require("path");
const WD = require("./lib/work-days-world");
const { serverSource, spliceModules, routeContextLines } = require("./lib/server-source");

const ROOT = path.join(__dirname, "..");
// server.js with any route module spliced in at its mount line, so a moved
// route stays pinned.
const SRC = serverSource();

let passed = 0;
const failures = [];
const ok = (name, cond, detail) => {
	if (cond) { passed++; return; }
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (name, a, e) => ok(name, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

// ── tracked names ──────────────────────────────────────────────────────────────
const SERVER_HELPERS = ["driverAvailabilityByName", "truckDriverAvailability", "driverOffDutyRefusal", "cancelDirectoryAvailability",
	"availabilityRowWithDriver", "availabilityOverlap", "availabilityOverlapBody", "recordOffDutyConfirmation", "sheetRowOffDutyDriver",
	"availabilityRowView", "driverOwnTimeOff", "driverLoadsForTimeOff", "recordTimeOffLoadConfirmations",
	// A driver's request (PR 4): the column migration, who asks, the notices, the request keys and a refused decision.
	"addTimeOffRequestColumns", "timeOffRequestDriver", "timeOffNoticeRecipient", "timeOffDriverNotice", "markTimeOffRequestNotice",
	"driverTimeOffRequestKeys", "timeOffDecisionRefused"];
let libExports = [];
try { libExports = Object.keys(require("../lib/driver-availability")); } catch { libExports = []; }
// The time-off ELD check: its results table (created in the same migration),
// module and binding, server.js helpers and the module's exports; §3 also allows
// its binding, helpers and two job registrations (ELD_ALLOW_HEADS).
const ELD_CHECK_HELPERS = ["timeOffDayEvidence", "timeOffEldRowFields", "timeOffEldRunPlan", "applyTimeOffEldPlan", "runTimeOffEldCheck", "timeOffEldCheckTick", "purgeTimeOffEldResults"];
let eldCheckExports = [];
try { eldCheckExports = Object.keys(require("../lib/time-off-eld-check")); } catch { eldCheckExports = []; }
const ELD_CHECK_NAMES = ["driver_time_off_days", "time-off-eld-check", "timeOffEldCheck", ...ELD_CHECK_HELPERS, ...eldCheckExports];
const ELD_ALLOW_HEADS = [
	'const timeOffEldCheck = require("./lib/time-off-eld-check");',
	...ELD_CHECK_HELPERS.flatMap((n) => [`function ${n}(`, `async function ${n}(`]),
	'if (DRIVER_TIME_OFF_ELD_CHECK_ENABLED && startsJob("time-off ELD check")) {',
	'if (startsJob("time-off ELD results purge (at boot, then weekly)")) {',
];
// Home time (H1): its columns, so no money path can read them.
const HOME_COLUMNS = ["home_city", "home_state"];
// The note to CHR's contact (plan B PR 5): its table, module and binding, and the server.js helpers that read or
// write the table or decide the note; §3 also allows the module's binding, the boot reads and the table's CREATE.
const CHR_DRAFT_HELPERS = ["timeOffChrDraftRecipientAtBoot", "timeOffChrDraftDecision", "markTimeOffChrDraftNotice", "startTimeOffChrDraft", "timeOffChrDraftByHand",
	"timeOffChrDraftRow", "timeOffChrDraftView", "timeOffChrDraftPanelFields", "runTimeOffChrDraft", "queueTimeOffChrDraft", "timeOffChrDraftChange", "timeOffChrDraftChangesForDirectory"];
const CHR_DRAFT_NAMES = ["time_off_chr_drafts", "time-off-chr-draft", "timeOffChrDraft", ...CHR_DRAFT_HELPERS];
const CHR_DRAFT_ALLOW_HEADS = [
	'const timeOffChrDraft = require("./lib/time-off-chr-draft");',
	"const TIME_OFF_CHR_DRAFT_TO = timeOffChrDraftRecipientAtBoot();",
	"const timeOffChrDraftDeny = timeOffChrDraft.createDenyCheck(",
	"if (DRIVER_TIME_OFF_CHR_DRAFT_ENABLED) {",
	...CHR_DRAFT_HELPERS.flatMap((n) => [`function ${n}(`, `async function ${n}(`]),
	'app.post("/api/driver-availability/:id/chr-draft",',
];
const TRACKED = ["driver_availability", "driver_availability_confirmations", "driver-availability", "driverAvailability", ...SERVER_HELPERS, ...libExports, ...ELD_CHECK_NAMES, ...HOME_COLUMNS,
	...CHR_DRAFT_NAMES];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A tracked name as a whole word ("driver_availability_create", an audit
// action, is not the table).
const TRACKED_RE = new RegExp(`(?<![\\w$-])(?:${TRACKED.map(escapeRe).join("|")})(?![\\w$])`);

// Comments blanked, all else and the line structure kept, so a comment naming
// driver_availability is not a mention. Strings, templates and regex literals are
// walked as tokens, so a "/*" or "//" inside one opens no comment.
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const isWordChar = (c) => c.charCodeAt(0) > 127 || /[\w$]/.test(c);
function blankComments(src) {
	const n = src.length;
	const out = [];
	// "{" for a block or object literal, "${" for a template substitution.
	const braces = [];
	// The last significant token: "" (none), "word" (a keyword a regex may
	// follow), "value", or the punctuator itself.
	let prev = "";
	let i = 0;
	const regexEnd = (from) => {
		let inClass = false;
		for (let j = from + 1; j < n; j++) {
			const c = src[j];
			if (c === "\n") return -1;
			if (c === "\\") { j++; continue; }
			if (c === "[") inClass = true;
			else if (c === "]") inClass = false;
			else if (c === "/" && !inClass) {
				j++;
				while (j < n && isWordChar(src[j])) j++;
				return j;
			}
		}
		return -1;
	};
	// A template literal's text from i up to its closing backtick or next "${".
	const templateText = () => {
		while (i < n) {
			const c = src[i];
			if (c === "\\") { out.push(src.slice(i, i + 2)); i += 2; continue; }
			if (c === "`") { out.push(c); i++; prev = "value"; return; }
			if (c === "$" && src[i + 1] === "{") { out.push("${"); i += 2; braces.push("${"); prev = "("; return; }
			out.push(c);
			i++;
		}
	};
	while (i < n) {
		const c = src[i];
		const d = src[i + 1];
		if (c === "/" && d === "/") {
			const j = src.indexOf("\n", i);
			i = j < 0 ? n : j;
			continue;
		}
		if (c === "/" && d === "*") {
			const j = src.indexOf("*/", i + 2);
			const end = j < 0 ? n : j + 2;
			out.push(src.slice(i, end).replace(/[^\n]/g, " "));
			i = end;
			continue;
		}
		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
			if (src[j] === c) j++;
			j = Math.min(j, n);
			out.push(src.slice(i, j));
			i = j;
			prev = "value";
			continue;
		}
		if (c === "`") { out.push(c); i++; templateText(); continue; }
		if (c === "/") {
			// A regex may start where a value can't end; one that doesn't close on
			// its line was a division after all.
			// Known limit: a regex right after an if/while head reads as a division.
			const end = prev === "value" || prev === ")" || prev === "]" ? -1 : regexEnd(i);
			if (end > 0) { out.push(src.slice(i, end)); i = end; prev = "value"; continue; }
			out.push(c);
			i++;
			prev = "/";
			continue;
		}
		if (c === "{") { braces.push("{"); out.push(c); i++; prev = "{"; continue; }
		if (c === "}") {
			out.push(c);
			i++;
			if (braces.pop() === "${") templateText();
			else prev = "}";
			continue;
		}
		if (isWordChar(c)) {
			let j = i + 1;
			while (j < n && isWordChar(src[j])) j++;
			const w = src.slice(i, j);
			prev = prev !== "." && REGEX_AFTER_WORD.has(w) ? "word" : "value";
			out.push(w);
			i = j;
			continue;
		}
		// A postfix ++ or -- ends a value: a "/" after it divides.
		if ((c === "+" || c === "-") && src[i + 1] === c && (prev === "value" || prev === ")" || prev === "]")) { out.push(c, c); i += 2; continue; }
		out.push(c);
		i++;
		if (!/\s/.test(c)) prev = c;
	}
	return out.join("");
}

// The code lines §3 and §4 judge. ROUTE_CONTEXT only lists the names route
// modules receive, so its lines are blanked, as the sibling runners skip them.
function codeLines(src) {
	const code = blankComments(src).split("\n");
	const rc = routeContextLines(src);
	if (rc) for (let n = rc.first; n <= rc.last; n++) code[n - 1] = "";
	return code;
}

// ── §3's allowlist and scan ─────────────────────────────────────────────────────
const ALLOW_HEADS = [
	'const driverAvailability = require("./lib/driver-availability");',
	"const DRIVER_AVAILABILITY_ENABLED =",
	"function availabilityFlagGate(",
	...SERVER_HELPERS.flatMap((n) => [`function ${n}(`, `async function ${n}(`]),
	"function eldFeedSnapshot(",
	...ELD_ALLOW_HEADS,
	...CHR_DRAFT_ALLOW_HEADS,
	'app.get("/api/drivers-directory/:id/availability",',
	'app.post("/api/drivers-directory/:id/availability",',
	'app.put("/api/driver-availability/:id",',
	'app.post("/api/driver-availability/:id/cancel",',
	'app.get("/api/driver/me/availability",',
	'app.get("/api/driver-availability",',
	// A driver's request and its cancel, the staff approve and decline, and the
	// column migration's one call at boot (PR 4).
	'app.post("/api/driver/me/availability",',
	'app.post("/api/driver/me/availability/:id/cancel",',
	'app.post("/api/driver-availability/:id/approve",',
	'app.post("/api/driver-availability/:id/decline",',
	"addTimeOffRequestColumns();",
	'app.get("/api/drivers-directory",',
	'app.delete("/api/drivers-directory/:id",',
	'app.post("/api/dispatch",',
	'app.post("/api/dispatch/reassign",',
	'app.put("/api/data/:rowIndex",',
	'app.put("/api/load/:loadId",',
	'app.post("/api/data",',
	'app.get("/api/dashboard",',
	'app.get("/api/trucks",',
	// A driver's own week lowers its target for approved days off; it is display only and no money path reads it.
	'const driverPerformance = require("./lib/driver-performance-routes").mount(app, {',
];
// The note to CHR's contact's switch, folding in the requests flag first.
const DRAFT_DEF_RE = /^const DRIVER_TIME_OFF_CHR_DRAFT_ENABLED = DRIVER_TIME_OFF_REQUESTS_ENABLED && \/\^\(true\|1\|yes\|on\)\$\/i\.test\(String\(process\.env\.DRIVER_TIME_OFF_CHR_DRAFT_ENABLED \?\? ""\)\.trim\(\)\);$/;
// The staff panel's rows: the ELD check's spread, then the note to CHR's contact's, each behind its own flag.
const PANEL_ROWS_RE = /^rows: rows\.map\(\(r\) => \(\{ \.\.\.availabilityRowView\(r, today, user\), \.\.\.\(DRIVER_TIME_OFF_ELD_CHECK_ENABLED \? timeOffEldRowFields\(r, \{ today, req \}\) : \{\}\), \.\.\.\(DRIVER_TIME_OFF_CHR_DRAFT_ENABLED \? timeOffChrDraftPanelFields\(r, dir\.driver_name, today\) : \{\}\) \}\)\),$/;
// The driver app's payload: one exempt line, the `timeOff` spread, as a
// property of the route's res.json({ ... }).
const PAYLOAD_HEAD = 'app.get("/api/driver/:driverName",';
const TIME_OFF_SPREAD_RE = /^\.\.\.\(DRIVER_TIME_OFF_SCREEN_ENABLED \? \{ timeOff: driverOwnTimeOff\([^()]*\) \} : \{\}\),$/;
// { stray, spreads, mentions } over codeLines() output.
function scanMentions(code) {
	const isHead = (l) => /^[^\s}\])`/]/.test(l);
	const headOf = (i) => { for (let j = i; j >= 0; j--) if (isHead(code[j])) return j; return -1; };
	const statementText = (j) => { let k = j + 1; while (k < code.length && !isHead(code[k])) k++; return code.slice(j, k).join("\n"); };
	const inReply = (j, i) => {
		for (let k = i - 1; k > j; k--) {
			const t = code[k].trim();
			if (t === "res.json({") return true;
			if (t === "});" || /^(if|for|while|const|let|return|try|await)\b|^\} catch\b/.test(t)) return false;
		}
		return false;
	};
	const stray = [];
	const spreads = [];
	let mentions = 0;
	code.forEach((l, i) => {
		if (!TRACKED_RE.test(l)) return;
		mentions++;
		const j = headOf(i);
		const head = j < 0 ? "" : code[j];
		const allowed = ALLOW_HEADS.some((h) => head.startsWith(h))
			|| (head.startsWith("db.exec(") && statementText(j).includes("CREATE TABLE IF NOT EXISTS driver_availability"));
		if (allowed) return;
		if (head.startsWith(PAYLOAD_HEAD) && TIME_OFF_SPREAD_RE.test(l.trim()) && inReply(j, i)) { spreads.push(i + 1); return; }
		stray.push(`line ${i + 1} (in ${head.slice(0, 70) || "?"}): ${l.trim().slice(0, 90)}`);
	});
	return { stray, spreads, mentions };
}

// ── §1 behaviour: the money paths with and without a month off ──────────────────
const AMY = "Amy Birch";
const PLAN_DDL = `CREATE TABLE IF NOT EXISTS driver_availability (
	id INTEGER PRIMARY KEY AUTOINCREMENT, directory_id INTEGER NOT NULL, driver_name TEXT NOT NULL,
	kind TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
	created_by TEXT NOT NULL, created_by_user_id INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
	updated_at TEXT, cancelled_at TEXT, cancelled_by TEXT)`;
function moneyWorld(withRow) {
	const w = WD.startWorld({
		env: { DRIVER_AVAILABILITY_ENABLED: "true" },
		now: Date.parse("2026-10-12T16:00:00Z"),
		drivers: [{ name: AMY, payDaily: 300 }],
		rows: [
			WD.loadRow({ id: "G101", driver: AMY, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" }),
			WD.loadRow({ id: "G102", driver: AMY, pickup: "2026-10-08 8:00", dropoff: "2026-10-08 18:00", assigned: "2026-10-08", done: "2026-10-08", truck: "T1" }),
		],
	});
	w.db.prepare("UPDATE trucks SET insurance_monthly = 1680, truck_payment_monthly = 1210, eld_monthly = 50, hvut_annual = 749, irp_annual = 1840, maintenance_fund_monthly = 800").run();
	if (withRow) {
		// The shipped table when server.js has it, else the plan's shape: the
		// guard holds before the feature exists, too.
		w.db.exec(PLAN_DDL);
		const dir = w.db.prepare("SELECT id FROM drivers_directory WHERE driver_name = ?").get(AMY).id;
		w.db.prepare(`INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, reason, created_by, created_at)
			VALUES (?, ?, 'vacation', '2026-10-01', '2026-10-30', 'Vacation', 'super_admin', '2026-09-30T12:00:00Z')`).run(dir, AMY);
		// ...and the ELD check's results for its days, Confirmed and Not confirmed
		// (the shipped table, else the plan's shape), the loaded days among them.
		w.db.exec(PLAN_DAYS_DDL);
		const avail = w.db.prepare("SELECT id FROM driver_availability WHERE directory_id = ?").get(dir).id;
		const day = w.db.prepare(`INSERT INTO driver_time_off_days (availability_id, directory_id, day, state, reason, miles, rule_version, first_evaluated_at, evaluated_at, final_at)
			VALUES (?, ?, ?, ?, ?, ?, 1, '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z')`);
		for (const d of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) day.run(avail, dir, d, "confirmed", "parked", 0);
		for (const d of ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]) day.run(avail, dir, d, "not_confirmed", "truck_moved", 250);
		// PR 4: a driver's waiting, declined and approved requests over the loaded days (the shipped columns).
		if (withRow === "requests" || withRow === "home" || withRow === "draft") {
			const req = w.db.prepare(`INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, reason, created_by, created_by_user_id, created_at,
				request_status, source, decided_by, decided_at) VALUES (?, ?, 'off_duty', ?, ?, '', 'drv_amy', 0, '2026-09-20T12:00:00Z', ?, 'driver', ?, ?)`);
			req.run(dir, AMY, "2026-10-05", "2026-10-06", "requested", null, null);
			req.run(dir, AMY, "2026-10-07", "2026-10-08", "declined", "dispatch_t", "2026-09-21T12:00:00Z");
			req.run(dir, AMY, "2026-10-08", "2026-10-09", "approved", "dispatch_t", "2026-09-21T12:00:00Z");
		}
		// H1: every row (the staff month off and the three requests) with a home time (the shipped columns).
		if (withRow === "home" || withRow === "draft") w.db.prepare("UPDATE driver_availability SET home_city = 'Springfield', home_state = 'MO'").run();
		// PR 5: a note to CHR's contact made for the approved request (the shipped table, else the plan's shape).
		if (withRow === "draft") {
			w.db.exec(PLAN_CHR_DDL);
			const approved = w.db.prepare("SELECT id FROM driver_availability WHERE request_status = 'approved' AND source = 'driver'").get().id;
			w.db.prepare(`INSERT INTO time_off_chr_drafts (availability_id, message_id, unit, from_day, to_day, state, attempts, created_at, drafted_at)
				VALUES (?, '<made-up.time-off-chr@example.invalid>', 'T1', '2026-10-08', '2026-10-09', 'made', 1, '2026-09-21T12:00:00Z', '2026-09-21T12:01:00Z')`).run(approved);
		}
	}
	return w;
}
const PLAN_CHR_DDL = `CREATE TABLE IF NOT EXISTS time_off_chr_drafts (
	id INTEGER PRIMARY KEY AUTOINCREMENT, availability_id INTEGER NOT NULL UNIQUE, message_id TEXT NOT NULL, unit TEXT NOT NULL, from_day TEXT NOT NULL,
	to_day TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_stage TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, drafted_at TEXT)`;
const PLAN_DAYS_DDL = `CREATE TABLE IF NOT EXISTS driver_time_off_days (
	id INTEGER PRIMARY KEY AUTOINCREMENT, availability_id INTEGER NOT NULL, directory_id INTEGER NOT NULL, day TEXT NOT NULL,
	state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', miles REAL NOT NULL DEFAULT 0, rule_version INTEGER NOT NULL,
	first_evaluated_at TEXT NOT NULL, evaluated_at TEXT NOT NULL, final_at TEXT)`;
async function moneyViews(withRow) {
	const w = moneyWorld(withRow);
	const excludedBefore = w.db.prepare("SELECT COUNT(*) AS n FROM excluded_driver_days").get().n;
	const gen = await WD.generate(w, AMY, "2026-10-09");
	const led = await WD.ledger(w);
	const inv = await WD.investorDays(w);
	const out = {
		invoiceStatus: gen.status,
		invoiceDays: WD.gridDays(gen.data, "2026-10-09"),
		invoiceTotal: gen.invoice ? gen.invoice.total : null,
		ledgerItems: led.items.map((i) => ({ kind: i.kind, month: i.month, amount: i.amount, label: i.label })),
		ledgerMonths: led.monthlyEarnings,
		investorMonths: inv.months,
		excluded: w.db.prepare("SELECT COUNT(*) AS n FROM excluded_driver_days").get().n - excludedBefore,
		availabilityRows: withRow ? w.db.prepare("SELECT COUNT(*) AS n FROM driver_availability").get().n : 0,
		eldDays: withRow ? w.db.prepare("SELECT state, COUNT(*) AS n FROM driver_time_off_days GROUP BY state ORDER BY state").all().map((r) => [r.state, r.n]) : [],
	};
	return out;
}

(async () => {
	console.log("\n── §0 the comment stripper blanks comments and nothing else");
	{
		// Made-up sources: line 2 of each names a tracked name in code, and a
		// "/*" before it sits in a string, regex, template or line comment.
		const seenOnLine2 = (name, lines, at = 1) => {
			const out = blankComments(lines.join("\n")).split("\n");
			ok(name, out.length === lines.length && TRACKED_RE.test(out[at]), `stripped line ${at + 1}: ${JSON.stringify(out[at])}`);
		};
		seenOnLine2("§0.1 a \"/*\" in a string hides no code", [
			'const banner = "see /* the notes";',
			'function weekTotal() { return db.prepare("SELECT COUNT(*) AS n FROM driver_availability").get().n; }',
			'const footer = "end of notes */";',
		]);
		seenOnLine2("§0.2 ...nor one in a regex literal", [
			"const slashStar = /a\\/*b/;",
			"const rows = truckDriverAvailability(\"T1\");",
			"const starSlash = /c*/;",
		]);
		seenOnLine2("§0.3 ...nor one in a template literal", [
			"const glob = `/api/sample/${unit}/*`;",
			"const off = driverAvailabilityByName(name);",
			"const done = `*/`;",
		]);
		seenOnLine2("§0.4 ...nor one in a line comment", [
			"// the sample /api/demo/* routes",
			"const off = driverAvailabilityByName(name);",
			"/* a real comment */",
		]);
		const commented = blankComments([
			"const a = 1; // reads driver_availability",
			"/* driver_availability",
			"   truckDriverAvailability() */ const b = \"http://example.test/x\";",
			"const c = '//' + \"/*\" + `*/`;",
		].join("\n")).split("\n");
		eq("§0.5 real comments are blanked, strings kept, line count kept",
			[commented.length, commented.some((l) => TRACKED_RE.test(l)), commented[2].trim(), commented[3]],
			[4, false, 'const b = "http://example.test/x";', "const c = '//' + \"/*\" + `*/`;"]);

		// Every route head in server.js (column 0) outside a comment is still
		// there after stripping. A comment is judged here by lines alone: a
		// head between a line opening with "/*" and the line closing it.
		const raw = SRC.split("\n");
		const stripped = blankComments(SRC).split("\n");
		eq("§0.6 stripping server.js keeps its line count", stripped.length, raw.length);
		const ROUTE_HEAD_RE = /^app\.(?:get|post|put|patch|delete|all|use)\([^,)]*/;
		let inBlock = false;
		const heads = [];
		raw.forEach((l, i) => {
			const t = l.trim();
			if (!inBlock && t.startsWith("/*")) inBlock = !t.includes("*/", 2);
			else if (inBlock && t.includes("*/")) { inBlock = false; return; }
			if (inBlock) return;
			const m = ROUTE_HEAD_RE.exec(l);
			if (m) heads.push([i, m[0]]);
		});
		const lost = heads.filter(([i, h]) => !(stripped[i] || "").startsWith(h)).map(([i, h]) => `line ${i + 1}: ${h.slice(0, 70)}`);
		ok(`§0.7 every route head outside a comment (${heads.length}) survives stripping`, heads.length > 100 && lost.length === 0,
			`${lost.length} lost: ${lost.slice(0, 8).join(" | ")}`);

		// A "/" read as a regex opener runs to the next "/" on its line; a backtick
		// in that span flips the template state and a later "/*" then hides code.
		seenOnLine2("§0.8 a division after a keyword-named property is a division", [
			"const share = counts.delete / 2; const sep = `/`;",
			"const pattern = `/* sample`;",
			"const off = driverAvailabilityByName(name);",
		], 2);
		seenOnLine2("§0.9 ...and so is one after a postfix ++", [
			"let n = 1; const half = n++ / 2; const sep = `/`;",
			"const pattern = `/* sample`;",
			"const off = driverAvailabilityByName(name);",
		], 2);

		// A made-up split: server.js lists the helpers in ROUTE_CONTEXT and mounts
		// a module whose money route reads one. The list is no mention; the read is.
		const splitServer = [
			'const driverAvailability = require("./lib/driver-availability");',
			"function truckDriverAvailability(unit) {",
			"\treturn driverAvailability.forUnit(unit);",
			"}",
			"const ROUTE_CONTEXT = {",
			"\tdriverAvailability,",
			"\ttruckDriverAvailability,",
			"\tDRIVER_TIME_OFF_SCREEN_ENABLED,",
			"};",
			'require("./routes/sample-money")(ROUTE_CONTEXT);',
			'app.get("*", (req, res) => res.end());',
			"",
		].join("\n");
		const sampleModule = [
			"// Made-up sample module.",
			"module.exports = function mount({ truckDriverAvailability }) {",
			'app.get("/api/financials", (req, res) => {',
			'\tconst off = truckDriverAvailability("T1");',
			"\tres.json({ off });",
			"});",
			"};",
			"",
		].join("\n");
		const spliced = spliceModules(splitServer, () => sampleModule).text;
		const splitCode = codeLines(spliced);
		const splitScan = scanMentions(splitCode);
		eq("§0.10 in a split server.js the ROUTE_CONTEXT list is no mention, and a read in a moved money route is one",
			[splitScan.stray.length, splitScan.stray.every((s) => s.includes('app.get("/api/financials",') && s.includes("truckDriverAvailability(")),
				splitCode.some((l) => /\bDRIVER_TIME_OFF_SCREEN_ENABLED\b/.test(l))],
			[1, true, false]);
	}

	console.log("\n── §1 the money paths with and without a month off");
	try {
		const base = await moneyViews(false);
		const offAllMonth = await moneyViews(true);
		eq("§1.0 the fixture invoices Oct 5-8 and the row covers the month", [base.invoiceStatus, base.invoiceDays.map((d) => d.day), offAllMonth.availabilityRows],
			[200, ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"], 1]);
		ok("§1.0b the ledger has fixed-cost items to compare", base.ledgerItems.some((i) => /fixed|insurance|payment/i.test(`${i.kind} ${i.label}`)));
		eq("§1.0c the month off carries ELD results: 4 Confirmed, 4 Not confirmed (its loaded days)", offAllMonth.eldDays, [["confirmed", 4], ["not_confirmed", 4]]);
		eq("§1.1 the weekly invoice's days are the same", offAllMonth.invoiceDays, base.invoiceDays);
		eq("§1.2 ...and its total", offAllMonth.invoiceTotal, base.invoiceTotal);
		eq("§1.3 the payout ledger's items (driver pay, fixed costs, fees) are the same", offAllMonth.ledgerItems, base.ledgerItems);
		eq("§1.4 ...and its months", JSON.stringify(offAllMonth.ledgerMonths), JSON.stringify(base.ledgerMonths));
		eq("§1.5 the investor view's months are the same", JSON.stringify(offAllMonth.investorMonths), JSON.stringify(base.investorMonths));
		eq("§1.6 no excluded day is written", [base.excluded, offAllMonth.excluded], [0, 0]);
	} catch (err) {
		ok("§1 ran", false, `threw: ${err && err.message}`);
	}
	try {
		const base = await moneyViews(false);
		const requests = await moneyViews("requests");
		eq("§1.7 PR 4: the month also holds a waiting, a declined and an approved driver request", requests.availabilityRows, 4);
		eq("§1.8 ...and the weekly invoice's days and total are the same", [requests.invoiceDays, requests.invoiceTotal], [base.invoiceDays, base.invoiceTotal]);
		eq("§1.9 ...the payout ledger's items and months are the same", [requests.ledgerItems, JSON.stringify(requests.ledgerMonths)], [base.ledgerItems, JSON.stringify(base.ledgerMonths)]);
		eq("§1.10 ...the investor view's months are the same, and no excluded day is written", [JSON.stringify(requests.investorMonths), requests.excluded], [JSON.stringify(base.investorMonths), 0]);
	} catch (err) {
		ok("§1.7 ran", false, `threw: ${err && err.message}`);
	}
	try {
		const base = await moneyViews(false);
		const home = await moneyViews("home");
		eq("§1.11 H1: the same month with a home time on every row gives the same weekly invoice (days and total), payout ledger (items and months), investor months, and no excluded day",
			[home.availabilityRows, home.invoiceDays, home.invoiceTotal, home.ledgerItems, JSON.stringify(home.ledgerMonths), JSON.stringify(home.investorMonths), home.excluded],
			[4, base.invoiceDays, base.invoiceTotal, base.ledgerItems, JSON.stringify(base.ledgerMonths), JSON.stringify(base.investorMonths), 0]);
	} catch (err) {
		ok("§1.11 ran", false, `threw: ${err && err.message}`);
	}
	try {
		const base = await moneyViews(false);
		const drafted = await moneyViews("draft");
		eq("§1.12 PR 5: the same month with a note to CHR's contact made for the approved request gives the same weekly invoice, payout ledger, investor months, and no excluded day",
			[drafted.availabilityRows, drafted.invoiceDays, drafted.invoiceTotal, drafted.ledgerItems, JSON.stringify(drafted.ledgerMonths), JSON.stringify(drafted.investorMonths), drafted.excluded],
			[4, base.invoiceDays, base.invoiceTotal, base.ledgerItems, JSON.stringify(base.ledgerMonths), JSON.stringify(base.investorMonths), 0]);
	} catch (err) {
		ok("§1.12 ran", false, `threw: ${err && err.message}`);
	}

	console.log("\n── §2 the money modules in lib/ never name a tracked name");
	for (const f of ["load-pay-days.js", "financials-calc.js", "investor-payout-basis.js", "financials-report.js"]) {
		const text = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
		const hit = text.split("\n").findIndex((l) => TRACKED_RE.test(l));
		ok(`§2 lib/${f} names none of them`, hit < 0, hit < 0 ? "" : `line ${hit + 1}`);
	}
	ok("§2.0 the tracked names include the module's exports when it exists",
		!fs.existsSync(path.join(ROOT, "lib", "driver-availability.js")) || libExports.length > 0);

	console.log("\n── §3 server.js: every mention sits in an allowlisted place");
	{
		const code = codeLines(SRC);
		const missing = SERVER_HELPERS.filter((n) => !code.some((l) => l.startsWith(`function ${n}(`) || l.startsWith(`async function ${n}(`)));
		eq("§3.0 every tracked helper is defined in server.js", missing, []);
		const { stray, spreads, mentions } = scanMentions(code);
		eq("§3.1 no tracked name outside the allowlist", stray, []);
		console.log(`  (${mentions} mention(s) checked)`);
		ok("§3.1b the driver app's payload route is not on the allowlist", !ALLOW_HEADS.some((h) => PAYLOAD_HEAD.startsWith(h) || h.startsWith(PAYLOAD_HEAD)));
		ok("§3.1c ...and holds at most one exempt line, the timeOff spread in its res.json", spreads.length <= 1, `lines ${spreads.join(", ")}`);
		// The money paths, by name: none is on the allowlist, so §3.1 covers them;
		// asserted directly as well so a rename cannot slip one onto it.
		const money = ["computeInvestorMonthlyEarnings", "buildFinancialsLedger", "buildFinancialsReport", "generateInvoiceHandler", "truckMonthlyFixed",
			"financialsExtraItems", "computeFleetLedger", "computeLossCarryForward"];
		for (const fn of money) {
			const at = SRC.indexOf(`\nfunction ${fn}(`) >= 0 ? SRC.indexOf(`\nfunction ${fn}(`) : SRC.indexOf(`\nasync function ${fn}(`);
			if (at < 0) { ok(`§3.2 ${fn}() is in server.js`, false); continue; }
			const end = SRC.indexOf("\n}\n", at);
			ok(`§3.2 ${fn}() names no tracked name`, !TRACKED_RE.test(blankComments(SRC.slice(at, end))));
		}
	}

	console.log("\n── §4 every off-duty check sits inside the flag");
	{
		const lines = SRC.split("\n");
		const calls = [];
		lines.forEach((l, i) => { if (/\bdriverOffDutyRefusal\(/.test(l) && !/^function driverOffDutyRefusal\(/.test(l) && !/^\s*\/\//.test(l)) calls.push(i); });
		const unguarded = calls.filter((i) => {
			for (let j = i - 1; j >= 0; j--) {
				const t = lines[j].trim();
				if (!t || t.startsWith("//")) continue;
				return t !== "if (DRIVER_AVAILABILITY_ENABLED) {";
			}
			return true;
		}).map((i) => `line ${i + 1}`);
		eq(`§4.1 every call (${calls.length}) is inside if (DRIVER_AVAILABILITY_ENABLED)`, unguarded, []);
		// The screen sub-flag works only while the main flag is on, and gates the
		// driver app's timeOff spread and nothing else.
		const code = codeLines(SRC);
		const defs = code.filter((l) => l.startsWith("const DRIVER_TIME_OFF_SCREEN_ENABLED ="));
		ok("§4.2 DRIVER_TIME_OFF_SCREEN_ENABLED, where defined, is defined once and folds in DRIVER_AVAILABILITY_ENABLED first",
			defs.length <= 1 && defs.every((l) => l.startsWith("const DRIVER_TIME_OFF_SCREEN_ENABLED = DRIVER_AVAILABILITY_ENABLED && /^(true|1|yes|on)$/i.test(")), defs.join(" | "));
		const uses = code.map((l, i) => [l, i + 1]).filter(([l]) => /\bDRIVER_TIME_OFF_SCREEN_ENABLED\b/.test(l) && !l.startsWith("const DRIVER_TIME_OFF_SCREEN_ENABLED ="));
		// ...and, since PR 4, exactly one more line: the requests flag folding the screen flag in.
		const REQUESTS_DEF = "const DRIVER_TIME_OFF_REQUESTS_ENABLED = DRIVER_TIME_OFF_SCREEN_ENABLED && /^(true|1|yes|on)$/i.test(";
		ok("§4.3 ...and every other mention is the timeOff spread, or the requests flag's one definition",
			uses.every(([l]) => l.trim().startsWith("...(DRIVER_TIME_OFF_SCREEN_ENABLED ? { timeOff: driverOwnTimeOff(") || l.startsWith(REQUESTS_DEF))
				&& uses.filter(([l]) => l.startsWith(REQUESTS_DEF)).length <= 1,
			uses.map(([l, n]) => `line ${n}: ${l.trim().slice(0, 80)}`).join(" | "));

		// R11b: the time-off loads warning works only while the main flag is on, and
		// gates its three steps and nothing else.
		const loadsDefs = code.filter((l) => l.startsWith("const DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED ="));
		ok("§4.4 DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED is defined once and folds in DRIVER_AVAILABILITY_ENABLED first",
			loadsDefs.length === 1 && loadsDefs[0].startsWith("const DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED = DRIVER_AVAILABILITY_ENABLED && /^(true|1|yes|on)$/i.test("),
			`${loadsDefs.length} definition(s): ${loadsDefs.join(" | ")}`);
		const GATE_RE = /^if \(DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED(?: && [^{}]+)?\) \{$/;
		const STEPS = ["driverLoadsForTimeOff", "driverAvailability.timeOffLoadsDecision", "recordTimeOffLoadConfirmations"];
		const stepRe = (name) => new RegExp(`(?<![\\w$.])${escapeRe(name)}\\(`);
		const prevCode = (i) => { for (let j = i - 1; j >= 0; j--) if (code[j].trim()) return code[j].trim(); return ""; };
		const nextCode = (i) => { for (let j = i + 1; j < code.length; j++) if (code[j].trim()) return code[j].trim(); return ""; };
		for (const name of STEPS) {
			const calls = [];
			code.forEach((l, i) => { if (stepRe(name).test(l) && !l.startsWith(`function ${name}(`) && !l.startsWith(`async function ${name}(`)) calls.push(i); });
			const unguarded = calls.filter((i) => !GATE_RE.test(prevCode(i))).map((i) => `line ${i + 1}`);
			ok(`§4.5 ${name}() is called (${calls.length}), each call the first statement of an if (DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED...)`,
				calls.length > 0 && unguarded.length === 0, unguarded.join(", "));
		}
		const gates = code.map((l, i) => [l, i]).filter(([l]) => /\bDRIVER_AVAILABILITY_LOADS_WARNING_ENABLED\b/.test(l) && !l.startsWith("const DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED ="));
		const strayGates = gates.filter(([l, i]) => !GATE_RE.test(l.trim()) || !STEPS.some((n) => stepRe(n).test(nextCode(i)))).map(([l, i]) => `line ${i + 1}: ${l.trim().slice(0, 80)}`);
		ok(`§4.6 ...and every other mention of it (${gates.length}) is such a gate around one of those steps`, gates.length > 0 && strayGates.length === 0, strayGates.join(" | "));

		// The time-off ELD check: its flag works only while the main flag is on, and
		// gates its job, the job's own guard, the staff list's spread and the
		// driver's eldChecked line, each in its own place, and nothing else.
		const eldDefs = code.filter((l) => l.startsWith("const DRIVER_TIME_OFF_ELD_CHECK_ENABLED ="));
		ok("§4.8 DRIVER_TIME_OFF_ELD_CHECK_ENABLED is defined once and folds in DRIVER_AVAILABILITY_ENABLED first",
			eldDefs.length === 1 && eldDefs[0].startsWith("const DRIVER_TIME_OFF_ELD_CHECK_ENABLED = DRIVER_AVAILABILITY_ENABLED && /^(true|1|yes|on)$/i.test("),
			`${eldDefs.length} definition(s): ${eldDefs.join(" | ")}`);
		const headLine = (i) => { for (let j = i; j >= 0; j--) if (/^[^\s}\])`/]/.test(code[j])) return code[j]; return ""; };
		const JOB_HEAD = 'if (DRIVER_TIME_OFF_ELD_CHECK_ENABLED && startsJob("time-off ELD check")) {';
		const ELD_FLAG_USES = [
			[/^if \(DRIVER_TIME_OFF_ELD_CHECK_ENABLED && startsJob\("time-off ELD check"\)\) \{$/, JOB_HEAD],
			[/^\} else if \(!DRIVER_TIME_OFF_ELD_CHECK_ENABLED\) \{$/, JOB_HEAD],
			[/^console\.log\("\[time-off-eld\] ELD check OFF \(DRIVER_TIME_OFF_ELD_CHECK_ENABLED\)"\);$/, JOB_HEAD],
			[/^if \(!DRIVER_TIME_OFF_ELD_CHECK_ENABLED\) return \{ skipped: "off" \};$/, "async function runTimeOffEldCheck("],
			[PANEL_ROWS_RE, 'app.get("/api/drivers-directory/:id/availability",'],
			[/^\.\.\.\(DRIVER_TIME_OFF_ELD_CHECK_ENABLED \? \{ eldChecked: true \} : \{\}\),$/, "function driverOwnTimeOff("],
		];
		const eldUses = code.map((l, i) => [l.trim(), i]).filter(([l]) => /\bDRIVER_TIME_OFF_ELD_CHECK_ENABLED\b/.test(l) && !l.startsWith("const DRIVER_TIME_OFF_ELD_CHECK_ENABLED ="));
		const placed = eldUses.filter(([l, i]) => ELD_FLAG_USES.some(([re, head]) => re.test(l) && headLine(i).startsWith(head)));
		const strayEld = eldUses.filter((u) => !placed.includes(u)).map(([l, i]) => `line ${i + 1}: ${l.slice(0, 80)}`);
		ok(`§4.8b ...and its ${eldUses.length} other mentions are exactly the job's registration and start-up line, the job's own guard, the staff list's spread and the driver's eldChecked line`,
			eldUses.length === ELD_FLAG_USES.length && strayEld.length === 0, strayEld.join(" | "));

		// A driver's request (PR 4): its flag works only while the screen flag is on,
		// and switches exactly these places, each in its own helper or route.
		const reqDefs = code.filter((l) => l.startsWith("const DRIVER_TIME_OFF_REQUESTS_ENABLED ="));
		ok("§4.9 DRIVER_TIME_OFF_REQUESTS_ENABLED is defined once and folds in DRIVER_TIME_OFF_SCREEN_ENABLED first",
			reqDefs.length === 1 && reqDefs[0].startsWith(REQUESTS_DEF), `${reqDefs.length} definition(s): ${reqDefs.join(" | ")}`);
		const REQ_FLAG_USES = [
			[/^if \(!DRIVER_TIME_OFF_REQUESTS_ENABLED\) return next\("route"\);$/, "function timeOffRequestsFlagGate("],
			[/^console\.log\(`\[availability\] driver time-off requests \$\{DRIVER_TIME_OFF_REQUESTS_ENABLED \? "ON" : "OFF"\} \(DRIVER_TIME_OFF_REQUESTS_ENABLED\)`\);$/,
				"console.log(`[availability] driver time-off requests "],
			[/^if \(!DRIVER_TIME_OFF_REQUESTS_ENABLED \|\| !row \|\| row\.source !== "driver"\) return null;$/, "function timeOffDriverNotice("],
			[/^\.\.\.\(DRIVER_TIME_OFF_REQUESTS_ENABLED \? driverAvailability\.requestRowFields\(r\) : \{\}\),$/, "function availabilityRowView("],
			[/^`\)\.get\(directoryId, exceptId, to, from, DRIVER_TIME_OFF_REQUESTS_ENABLED && !approvedOnly \? 1 : 0\);$/, "function availabilityOverlap("],
			[/^\.\.\.\(DRIVER_TIME_OFF_REQUESTS_ENABLED \? driverTimeOffRequestKeys\(key, today, viewer\) : \{\}\),$/, "function driverOwnTimeOff("],
			// H1: the staff list's add-form key, the staff create's and edit's validator scope, the driver's rows' home key.
			[/^\.\.\.\(DRIVER_TIME_OFF_REQUESTS_ENABLED \? \{ homeTime: true \} : \{\}\),$/, 'app.get("/api/drivers-directory/:id/availability",'],
			[/^const v = driverAvailability\.validateAvailability\(req\.body, \{ todayKey: today, isSuperAdmin: user\.role === "Super Admin", home: DRIVER_TIME_OFF_REQUESTS_ENABLED \}\);$/,
				'app.post("/api/drivers-directory/:id/availability",'],
			[/^const scope = \{ todayKey: today, isSuperAdmin, home: DRIVER_TIME_OFF_REQUESTS_ENABLED \};$/, 'app.put("/api/driver-availability/:id",'],
			[/^\.\.\.\(DRIVER_TIME_OFF_REQUESTS_ENABLED \? \{ home: driverAvailability\.homeLocationOf\(r\) \} : \{\}\),$/, "function driverOwnTimeOff("],
			// The note to CHR's contact (PR 5): its switch folds this flag in, and the staff create's answer carries the
			// by-hand line only while requests are on.
			[DRAFT_DEF_RE, "const DRIVER_TIME_OFF_CHR_DRAFT_ENABLED ="],
			[/^\.\.\.\(DRIVER_TIME_OFF_REQUESTS_ENABLED \? \{ chrDraft: timeOffChrDraftByHand\(outcome\.row\.id, today\) \} : \{\}\),$/, 'app.post("/api/drivers-directory/:id/availability",'],
		];
		const reqUses = code.map((l, i) => [l.trim(), i]).filter(([l]) => /\bDRIVER_TIME_OFF_REQUESTS_ENABLED\b/.test(l) && !l.startsWith("const DRIVER_TIME_OFF_REQUESTS_ENABLED ="));
		const reqPlaced = reqUses.filter(([l, i]) => REQ_FLAG_USES.some(([re, head]) => re.test(l) && headLine(i).startsWith(head)));
		const strayReq = reqUses.filter((u) => !reqPlaced.includes(u)).map(([l, i]) => `line ${i + 1}: ${l.slice(0, 90)}`);
		ok(`§4.9b ...and its ${reqUses.length} other mentions are exactly the route gate, the start-up line, the driver notice's guard, the staff row view's keys, the overlap check's bound value, driverOwnTimeOff()'s keys, (H1) the home time's four places and (PR 5) the draft switch's definition and the staff create's chrDraft key`,
			reqUses.length === REQ_FLAG_USES.length && strayReq.length === 0, strayReq.join(" | "));

		// The note to CHR's contact (PR 5): its switch works only while the requests flag is on, and switches exactly
		// these places, each in its own helper or route.
		const draftDefs = code.filter((l) => l.startsWith("const DRIVER_TIME_OFF_CHR_DRAFT_ENABLED ="));
		ok("§4.10 DRIVER_TIME_OFF_CHR_DRAFT_ENABLED is defined once and folds in DRIVER_TIME_OFF_REQUESTS_ENABLED first",
			draftDefs.length === 1 && DRAFT_DEF_RE.test(draftDefs[0]), `${draftDefs.length} definition(s): ${draftDefs.join(" | ")}`);
		const BOOT = "function timeOffChrDraftRecipientAtBoot(";
		const DRAFT_FLAG_USES = [
			[/^const to = DRIVER_TIME_OFF_CHR_DRAFT_ENABLED \? timeOffChrDraft\.chrRecipient\(process\.env\.TIME_OFF_CHR_DRAFT_TO\) : "";$/, BOOT],
			[/^console\.log\(`\[availability\] CHR day-off drafts \$\{DRIVER_TIME_OFF_CHR_DRAFT_ENABLED \? `ON \(DRIVER_TIME_OFF_CHR_DRAFT_ENABLED\), address: \$\{to \? "set, chrobinson\.com" : "not set"\}` : "OFF \(DRIVER_TIME_OFF_CHR_DRAFT_ENABLED\)"\}`\);$/, BOOT],
			[/^if \(DRIVER_TIME_OFF_CHR_DRAFT_ENABLED && !to\) console\.warn\("[^"`$]*"\);$/, BOOT],
			[/^if \(DRIVER_TIME_OFF_CHR_DRAFT_ENABLED\) \{$/, "if (DRIVER_TIME_OFF_CHR_DRAFT_ENABLED) {"],
			[/^if \(!DRIVER_TIME_OFF_CHR_DRAFT_ENABLED\) return next\("route"\);$/, "function timeOffChrDraftFlagGate("],
			[/^\{ draftOn: DRIVER_TIME_OFF_CHR_DRAFT_ENABLED, recipientOk: !!TIME_OFF_CHR_DRAFT_TO, staffRecorded, denyHits: timeOffChrDraftDeny \}\);$/, "function timeOffChrDraftDecision("],
			[/^if \(!DRIVER_TIME_OFF_CHR_DRAFT_ENABLED\) return undefined;$/, "function timeOffChrDraftRow("],
			[/^if \(!DRIVER_TIME_OFF_CHR_DRAFT_ENABLED\) return \[\];$/, "function timeOffChrDraftChangesForDirectory("],
			[PANEL_ROWS_RE, 'app.get("/api/drivers-directory/:id/availability",'],
		];
		const draftUses = code.map((l, i) => [l.trim(), i]).filter(([l]) => /\bDRIVER_TIME_OFF_CHR_DRAFT_ENABLED\b/.test(l) && !l.startsWith("const DRIVER_TIME_OFF_CHR_DRAFT_ENABLED ="));
		const draftPlaced = draftUses.filter(([l, i]) => DRAFT_FLAG_USES.some(([re, head]) => re.test(l) && headLine(i).startsWith(head)));
		const strayDraft = draftUses.filter((u) => !draftPlaced.includes(u)).map(([l, i]) => `line ${i + 1}: ${l.slice(0, 90)}`);
		ok(`§4.10b ...and its ${draftUses.length} other mentions are exactly the boot read of the recipient (with its start-up line and warning), the table's CREATE, the Retry route's gate, the decision's draftOn, the draft row reader, the Drivers-page delete's reader and the staff panel's spread`,
			draftUses.length === DRAFT_FLAG_USES.length && strayDraft.length === 0, strayDraft.join(" | "));
		const retryHeads = code.filter((l) => l.startsWith('app.post("/api/driver-availability/:id/chr-draft",'));
		ok("§4.10c the Retry route is registered once: its flag gate first, the role check second, its per-account limiter third",
			retryHeads.length === 1 && retryHeads[0].startsWith('app.post("/api/driver-availability/:id/chr-draft", timeOffChrDraftFlagGate, requireRole("Super Admin", "Dispatcher"), timeOffChrDraftRetryLimiter, '),
			retryHeads.join(" | "));
		const defined = CHR_DRAFT_HELPERS.filter((n) => !code.some((l) => l.startsWith(`function ${n}(`) || l.startsWith(`async function ${n}(`)));
		eq("§4.10d every tracked helper of the note is defined in server.js, so §3 judges its mentions", defined, []);
		const gated = ['app.post("/api/driver/me/availability",', 'app.post("/api/driver/me/availability/:id/cancel",',
			'app.post("/api/driver-availability/:id/approve",', 'app.post("/api/driver-availability/:id/decline",'];
		const heads = code.filter((l) => gated.some((g) => l.startsWith(g)));
		ok("§4.9c each of the four request routes is registered once, its flag gate first and its role check second",
			heads.length === 4 && gated.every((g) => heads.filter((l) => l.startsWith(g)).length === 1)
				&& heads.every((l) => /^app\.post\("[^"]+", timeOffRequestsFlagGate, requireRole\(/.test(l)),
			heads.map((l) => l.slice(0, 120)).join(" | "));
	}

	console.log("\n── §5 the ELD check's names stay off the trucks list and every investor route");
	{
		const code = blankComments(SRC).split("\n");
		const names = [...ELD_CHECK_NAMES, "DRIVER_TIME_OFF_ELD_CHECK_ENABLED", "eldDays", "eldSummary", "eldChecked"];
		const NAME_RE = new RegExp(`(?<![\\w$-])(?:${names.map(escapeRe).join("|")})(?![\\w$])`);
		const isHead = (l) => /^[^\s}\])`/]/.test(l);
		const statementAt = (i) => { let k = i + 1; while (k < code.length && !isHead(code[k])) k++; return code.slice(i, k).join("\n"); };
		const routes = code.map((l, i) => [l, i]).filter(([l]) => /^app\.(get|post|put|patch|delete)\(/.test(l)
			&& (l.startsWith('app.get("/api/trucks",') || /^app\.\w+\("\/api\/investor/.test(l) || /requireRole\([^)]*"Investor"/.test(l)));
		ok(`§5.1 GET /api/trucks and the investor routes are found (${routes.length})`, routes.some(([l]) => l.startsWith('app.get("/api/trucks",')) && routes.length > 30);
		eq("§5.2 none of them names the check's table, module, helpers, exports, flag or keys",
			routes.filter(([, i]) => NAME_RE.test(statementAt(i))).map(([l, i]) => `line ${i + 1}: ${l.slice(0, 70)}`), []);
		// §5b: nor a driver's request: its column, flag, helpers or answer keys.
		const reqNames = ["DRIVER_TIME_OFF_REQUESTS_ENABLED", "request_status", "decided_by", "decided_by_user_id", "decided_at", "requestRowFields",
			"driverTimeOffRequestKeys", "timeOffRequestDriver", "timeOffDriverNotice", "markTimeOffRequestNotice", "canRequest", "requestLimits", "decidedBy"];
		const REQ_NAME_RE = new RegExp(`(?<![\\w$-])(?:${reqNames.map(escapeRe).join("|")})(?![\\w$])`);
		eq("§5b none of them names a driver's request: its column, flag, helpers or answer keys",
			routes.filter(([, i]) => REQ_NAME_RE.test(statementAt(i))).map(([l, i]) => `line ${i + 1}: ${l.slice(0, 70)}`), []);
		// §5c: nor the home time (H1): its columns, answer keys and the lib's home helpers. The
		// KPI routes and the KPI modules join the investor routes here.
		const homeNames = [...HOME_COLUMNS, "homeCity", "homeState", "homeDefault", "homeTime", ...libExports.filter((n) => /home/i.test(n))];
		const HOME_NAME_RE = new RegExp(`(?<![\\w$-])(?:${homeNames.map(escapeRe).join("|")})(?![\\w$])`);
		const kpiRoutes = code.map((l, i) => [l, i]).filter(([l]) => /^app\.(get|post|put|patch|delete)\("[^"]*kpi/i.test(l));
		const kpiFiles = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => /^kpi-.*\.js$/.test(f));
		const homeIn = code.filter((l) => HOME_NAME_RE.test(l)).length;
		eq("§5c the home time's names are in server.js, and none of GET /api/trucks, the investor routes, the KPI routes or lib/kpi-*.js names one", [
			homeIn > 0, libExports.filter((n) => /home/i.test(n)).length > 0, kpiRoutes.length > 0 && kpiFiles.length > 0,
			[...routes, ...kpiRoutes].filter(([, i]) => HOME_NAME_RE.test(statementAt(i))).map(([l, i]) => `line ${i + 1}: ${l.slice(0, 70)}`),
			kpiFiles.filter((f) => HOME_NAME_RE.test(fs.readFileSync(path.join(ROOT, "lib", f), "utf8"))),
		], [true, true, true, [], []]);
		// §5d: nor the note to CHR's contact (PR 5): its table, module, switch, recipient setting, helpers or answer keys.
		const draftNames = [...CHR_DRAFT_NAMES, "DRIVER_TIME_OFF_CHR_DRAFT_ENABLED", "TIME_OFF_CHR_DRAFT_TO", "chrDraft", "chrDraftChange", "chrDraftChanges"];
		const DRAFT_NAME_RE = new RegExp(`(?<![\\w$-])(?:${draftNames.map(escapeRe).join("|")})(?![\\w$])`);
		eq("§5d none of GET /api/trucks, the investor routes or the KPI routes names the note to CHR's contact: its table, module, switch, setting, helpers or keys",
			[...routes, ...kpiRoutes].filter(([, i]) => DRAFT_NAME_RE.test(statementAt(i))).map(([l, i]) => `line ${i + 1}: ${l.slice(0, 70)}`), []);
	}

	console.log("\n── §6 the ELD check's helpers are where §3 can see them");
	{
		const code = blankComments(SRC).split("\n");
		eq("§6.1 each is defined in server.js and survives comment stripping, so §3 judges its mentions",
			ELD_CHECK_HELPERS.filter((n) => !code.some((l) => l.startsWith(`function ${n}(`) || l.startsWith(`async function ${n}(`))), []);
		ok("§6.2 its results table is created in the time-off migration, so §3 allows it there",
			/db\.exec\(`\s*CREATE TABLE IF NOT EXISTS driver_availability \([^`]*CREATE TABLE IF NOT EXISTS driver_time_off_days \(/.test(SRC));
	}

	WD.cleanup();
	console.log(`\ntest-driver-availability-guards: ${passed} passed, ${failures.length} failed`);
	if (failures.length) {
		for (const f of failures) console.log(`  ✗ ${f}`);
		process.exit(1);
	}
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
