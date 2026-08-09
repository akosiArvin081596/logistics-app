#!/usr/bin/env node
/**
 * Tests for resolveLoadBinding() — the guard that ties a caller-supplied
 * `rowIndex` to the caller-supplied `loadId` before any of
 *   POST /api/dispatch, POST /api/dispatch/reassign,
 *   POST /api/dispatch/cancel, POST /api/driver/respond
 * writes to that row.
 *
 * THE DEFECT. Those four routes take `rowIndex` and `loadId` as INDEPENDENT body
 * fields and never compared them. POST /api/dispatch/cancel read only the header
 * row, then set `Job Status = "Cancelled"` and blanked `Driver` at the caller's
 * row — while the audit_trail entry, the driver notification, the dispatch feed
 * and load_status_history all named a DIFFERENT load. A client whose cached row
 * numbers no longer match the sheet therefore cancels whatever load sits at row
 * N, and the mandatory reason shipped after the 2026-08-05 mis-cancel is then
 * attached to the wrong load, making the record read as deliberate and correct.
 *
 * WHY IT LOADS THE FUNCTION OUT OF server.js SOURCE INSTEAD OF require()-ING IT.
 * Same reason as test-dispatch-period-guard.js / test-status-override-guard.js:
 * server.js opens SQLite, reads a service account key and starts listening on
 * import. Extracting the text exercises THE CODE THAT SHIPS rather than a copy
 * that can drift; each function is asserted to be found exactly once, so a
 * rename or a second definition fails loudly instead of silently testing nothing.
 *
 * WHAT IS REAL: resolveLoadBinding() and normLoadKey(), both lifted verbatim.
 * Nothing is stubbed — the binding is pure (no I/O, no clock, no database).
 *
 * THE FIXTURE IS THE REAL SHEET LAYOUT. Headers are the production/local Job
 * Tracking header row, so `/load.?id|job.?id/i` resolves the same column the
 * shipped routes resolve. A synthetic two-column fixture would pass while the
 * real layout failed.
 *
 * Run: node scripts/test-load-row-binding.js
 */
const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

// ---------------------------------------------------------------- extraction
function extract(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}
function extractConst(name) {
	const re = new RegExp(`\\nconst ${name} = [^\\n]+;`);
	const hits = SRC.match(new RegExp(`\\nconst ${name} = `, "g")) || [];
	if (hits.length !== 1) throw new Error(`expected exactly 1 \`const ${name}\`, found ${hits.length}`);
	return SRC.match(re)[0];
}

// ⚠️ normLoadKey is the app's SINGLE load-id normaliser (defined beside
// getLoadCoordsRow(), which exists because Job Tracking stores both "513987502"
// and "#513987502"). Asserting it is defined exactly once is what stops a second
// copy appearing next to the binding and drifting from every other lookup.
const G = {};
new Function(
	"G",
	[extractConst("normLoadKey"), extract("resolveLoadBinding")].join("\n") +
	"\nG.normLoadKey = normLoadKey; G.resolveLoadBinding = resolveLoadBinding;"
)(G);

// ------------------------------------------------------------------- harness
let pass = 0, fail = 0;
const failures = [];
function check(label, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (ok) { pass++; console.log(`  ok   ${label}`); }
	else { fail++; failures.push(`  FAIL ${label}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`); console.log(`  FAIL ${label}`); }
}
function section(t) { console.log(`\n${t}\n`); }

// --------------------------------------------------------------- the fixture
// The real Job Tracking header row (local copy of production, 26 columns).
const H = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info",
	"Pickup Appointment", "Pickup Address", "Drop-off Info", "Drop-off Appointment",
	"Drop-off Address", "Job Status", "Phase of Progress", "Carrier Stage",
	"  Payment  ", "Broker Contact Name", "Phone Number", "Email", "Location Link",
	"Documents", "Assigned Date", "Status Update Date", "Completion Date", "Truck",
	"Owner ID", "output",
];
const LID = 1, ST = 11, DRV = 4;
function mk(loadId, status, driver) {
	const r = new Array(H.length).fill("");
	r[LID] = loadId; r[ST] = status || ""; r[DRV] = driver || "";
	return r;
}
// rows[0] is sheet row 2.
const ROWS = [
	/* row 2  */ mk("562620213", "Dispatched", "Howard Reddie"),
	/* row 3  */ mk("#513987502", "In Transit", "Shorn King"),
	/* row 4  */ mk("2216467", "Delivered", "Rodney Brown"),
	/* row 5  */ mk("", "Completed", "Lesline Johnson"),      // one of the 8 blank-id rows
	/* row 6  */ mk("514964283", "Completed", "Kenrick Davis"), // duplicate, copy 1
	/* row 7  */ mk("7086762", "At Receiver", "Shorn King"),
	/* row 8  */ mk("514964283", "Completed", "Kenrick Davis"), // duplicate, copy 2
];
const bind = (rowIndex, loadId, rows = ROWS, headers = H) =>
	G.resolveLoadBinding(headers, rows, rowIndex, loadId);
const code = (r) => (r === null ? null : r.code);
const http = (r) => (r === null ? null : r.http);

// =====================================================================
section("1. The happy path — the row really does hold the load");
// =====================================================================
check("a row that carries the load id binds", bind(2, "562620213"), null);
check("...and so does the next one", bind(4, "2216467"), null);
check("...and one in the middle", bind(7, "7086762"), null);

// =====================================================================
section("2. THE DEFECT — rowIndex and loadId disagree");
// =====================================================================
// The 2026-08-05 shape: a stale client cancels row 2 believing it is 7086762.
check("a stale row number is REFUSED, not written", code(bind(2, "7086762")), "ROW_LOAD_MISMATCH");
check("...as a 409, not a silent success", http(bind(2, "7086762")), 409);
check("...and it names where the load actually is, so the caller can refresh",
	bind(2, "7086762").rowIndex, 7);
check("the refusal message names the row that was asked for",
	/Row 2 of Job Tracking does not hold load 7086762/.test(bind(2, "7086762").error), true);

// ⚠️ THE REFUSAL MUST NOT SAY WHAT THE TARGET ROW ACTUALLY HOLDS. POST
// /api/driver/respond is Driver-reachable, so echoing it would let any driver
// sweep rowIndex 2..N with their own load id and read every load id on the
// sheet back — and GET /api/public/track/:loadId is unauthenticated and keyed on
// nothing but a load id.
check("the refusal never leaks the OTHER load sitting at that row",
	/562620213/.test(bind(2, "7086762").error), false);
check("...nor anywhere else in the refusal body",
	/562620213/.test(JSON.stringify(bind(2, "7086762"))), false);

// A row shift is the realistic cause: DELETE /api/data/:rowIndex uses
// deleteDimension, which moves every row below it up by one.
const SHIFTED = ROWS.slice(1); // row 3 became row 2, and so on
check("after a row above is deleted, the cached index is refused",
	code(bind(4, "2216467", SHIFTED)), "ROW_LOAD_MISMATCH");
check("...pointing at the row the load moved to", bind(4, "2216467", SHIFTED).rowIndex, 3);

// Off the end of the data: the row is [], carries no load id, and is refused —
// so a cancel can never create a brand-new row far below the sheet.
check("a rowIndex past the end of the sheet is refused",
	code(bind(9999, "562620213")), "ROW_LOAD_MISMATCH");
check("the header row can never be the load's row either (it is not a data row)",
	code(bind(1, "562620213")), "ROW_LOAD_MISMATCH");

// =====================================================================
section("3. Both id forms resolve — '#123' and '123' are one load");
// =====================================================================
// 93 of 412 rows on the local copy carry the leading '#'. A raw string compare
// would refuse that whole slice of legitimate cancels.
check("a bare id matches a sheet cell written with '#'", bind(3, "513987502"), null);
check("a '#' id matches a sheet cell written with '#'", bind(3, "#513987502"), null);
check("a '#' id matches a sheet cell written bare", bind(2, "#562620213"), null);
check("surrounding whitespace does not break the match", bind(2, "  562620213  "), null);
// Alphanumeric broker ids are real — cleanRef() preserves shapes like
// SHP2607-A3BJ112 — so the fold has to work in both directions.
check("case is folded (broker ids are alphanumeric)",
	G.resolveLoadBinding(H, [mk("SHP2607-A3BJ112", "", "")], 2, "shp2607-a3bj112"), null);
check("...and in the other direction",
	G.resolveLoadBinding(H, [mk("shp2607-a3bj112", "", "")], 2, "SHP2607-A3BJ112"), null);
check("a numeric loadId (not a string) still matches", bind(2, 562620213), null);
// The '#' is stripped only at the START — an id that merely contains one is not
// silently equated with a different load.
check("an internal '#' is not stripped",
	code(G.resolveLoadBinding(H, [mk("AB#12", "", "")], 2, "AB12")), "LOAD_NOT_ON_SHEET");

// =====================================================================
section("4. A duplicated load id refuses rather than guessing");
// =====================================================================
// #223's convention. Even when the caller's row IS one of the copies: the
// dashboard reads deduplicateLoads() (last row wins), so cancelling the earlier
// copy changes nothing visible while load_status_history records the load as
// cancelled — a coin flip on whether the cancel takes effect at all.
check("a duplicated id refuses even when the row is one of the copies",
	code(bind(6, "514964283")), "AMBIGUOUS_LOAD");
check("...and from the other copy too", code(bind(8, "514964283")), "AMBIGUOUS_LOAD");
check("...and when the row is neither", code(bind(2, "514964283")), "AMBIGUOUS_LOAD");
check("it names every row carrying the id", bind(6, "514964283").rowIndices, [6, 8]);
check("...as a 409", http(bind(6, "514964283")), 409);
check("the remedy is in the message, not just the code",
	/distinct load ids/.test(bind(6, "514964283").error), true);
// Ambiguity outranks the mismatch: with two candidates there is no single row to
// point a caller at, so "refresh and retry row N" would be a guess.
check("ambiguity outranks ROW_LOAD_MISMATCH", code(bind(3, "514964283")), "AMBIGUOUS_LOAD");
check("an ambiguous refusal offers no single retry row",
	bind(3, "514964283").rowIndex, undefined);
// Duplicates in the '#' form are still duplicates.
check("normalisation applies to duplicate detection too",
	G.resolveLoadBinding(H, [mk("#77", "", ""), mk("77", "", "")], 2, "77").rowIndices, [2, 3]);

// =====================================================================
section("5. A missing load id is refused, not waved through");
// =====================================================================
// Otherwise omitting the field is a free bypass of the entire guard.
for (const [label, v] of [["absent", undefined], ["null", null], ["empty", ""],
	["whitespace", "   "], ["just a hash", "#"], ["false", false]]) {
	check(`a ${label} loadId is refused`, code(bind(2, v)), "LOAD_ID_REQUIRED");
}
check("...as a 400 — it is a malformed request, not a conflict", http(bind(2, "")), 400);
// It refuses no real work: on the local copy 8 of 412 rows carry no load id, all
// eight are already Completed, and recordStatusChange() already discards the
// history row for a blank id (`if (!lid || !ns) return`).
check("a blank body id can never bind to a blank-id row",
	code(bind(5, "")), "LOAD_ID_REQUIRED");
check("...and a real id never matches a blank row either",
	code(bind(5, "562620213")), "ROW_LOAD_MISMATCH");

// =====================================================================
section("6. Fail closed when the sheet cannot be interrogated");
// =====================================================================
const NO_LID = H.map((h) => (h === "Load ID" ? "Reference" : h));
check("no load-id column → refuse, never assume",
	code(G.resolveLoadBinding(NO_LID, ROWS, 2, "562620213")), "SHEET_LOAD_ID_MISSING");
check("...as a 409", http(G.resolveLoadBinding(NO_LID, ROWS, 2, "562620213")), 409);
check("empty headers → refuse", code(G.resolveLoadBinding([], ROWS, 2, "x")), "SHEET_LOAD_ID_MISSING");
check("undefined headers → refuse, not a throw",
	code(G.resolveLoadBinding(undefined, ROWS, 2, "x")), "SHEET_LOAD_ID_MISSING");
check("an empty sheet → the load is not on it",
	code(G.resolveLoadBinding(H, [], 2, "562620213")), "LOAD_NOT_ON_SHEET");
check("undefined rows → refuse, not a throw",
	code(G.resolveLoadBinding(H, undefined, 2, "562620213")), "LOAD_NOT_ON_SHEET");
check("a load absent from the sheet is a 404",
	http(G.resolveLoadBinding(H, ROWS, 2, "999999999")), 404);
// A ragged sheet: Sheets omits trailing empty cells, so short rows are normal.
check("a short row is not a throw and does not match",
	code(G.resolveLoadBinding(H, [["Contract"], mk("562620213", "", "")], 2, "562620213")),
	"ROW_LOAD_MISMATCH");
check("...and the load is still found on the row that has it",
	G.resolveLoadBinding(H, [["Contract"], mk("562620213", "", "")], 3, "562620213"), null);

// =====================================================================
section("7. Hostile input cannot escape or amplify");
// =====================================================================
// ⚠️ PR #246's lesson: the body limit is 50mb and body-parser inflates, so an
// unbounded id echoed into an error string is a reflection amplifier — and
// POST /api/driver/respond is Driver-reachable at driverWriteLimiter's 60/min.
const HUGE = "9".repeat(200000);
const hugeRes = bind(2, HUGE);
check("a 200 KB loadId is refused", code(hugeRes), "LOAD_ID_REQUIRED");
check("...without echoing the value at all", /9/.test(hugeRes.error), false);
check("...so the whole refusal body stays small", JSON.stringify(hugeRes).length < 500, true);

// ⚠️ THE LENGTH GATE IS NOT COSMETIC. `.trim()` strips SP/TAB/NBSP/ZWNBSP/LS, so
// padding survives normalisation: without the cap this BINDS, and the routes then
// hand the RAW value (never the normalised one) to insertLoadResponse.run,
// insertNotification.run, insertDispatchNotification.run, logAudit and io.emit,
// none of which bound it.
for (const pad of [" ", "\t", " ", "﻿", " "]) {
	check(`${JSON.stringify(pad)}-padded oversize id cannot bind`,
		code(bind(2, pad.repeat(200000) + "#562620213")), "LOAD_ID_REQUIRED");
}
check("a padded id of legal length still binds (padding itself is fine)",
	bind(2, "   #562620213   "), null);
check("128 chars is accepted", code(bind(2, "5".repeat(128))), "LOAD_NOT_ON_SHEET");
check("129 chars is not", code(bind(2, "5".repeat(129))), "LOAD_ID_REQUIRED");
// The echo cap still applies to ids that ARE within the length gate.
const long64 = bind(2, "9".repeat(120));
check("a legal-but-long id is echoed at no more than 64 chars",
	(long64.error.match(/9+/) || [""])[0].length, 64);
// ⚠️ THE TYPE GATE IS LOAD-BEARING, and this assertion is why it exists.
// String(["562620213"]) === "562620213" — one-element array coercion is the
// identity — so without a type check an array binds exactly as the bare id does,
// and that same array then reaches logAudit() and a `db.prepare(...).run()`,
// where better-sqlite3 refuses a non-primitive and throws AFTER the sheet write.
check("an array loadId cannot bind by coercion", code(bind(2, ["562620213"])), "LOAD_ID_REQUIRED");
for (const [label, v] of [["an object", {}], ["an array", []], ["a nested array", [["x"]]],
	["a boolean", true], ["NaN", NaN], ["Infinity", Infinity],
	["a String object", new String("562620213")]]) {
	check(`${label} loadId is refused on type`, code(bind(2, v)), "LOAD_ID_REQUIRED");
}
check("...and a plain number is still accepted", bind(2, 562620213), null);
// A regex-flavoured id is compared as a string, never compiled.
check("a regex-shaped id matches nothing", code(bind(2, ".*")), "LOAD_NOT_ON_SHEET");
check("a prototype key does not match a row", code(bind(2, "__proto__")), "LOAD_NOT_ON_SHEET");
// The binding is a pure function of its arguments — no clock, no database, so
// two identical calls answer identically.
check("the binding is deterministic",
	JSON.stringify(bind(2, "7086762")), JSON.stringify(bind(2, "7086762")));
// It must never mutate the sheet it was handed.
const SNAPSHOT_BEFORE = JSON.stringify(ROWS);
bind(2, "7086762"); bind(6, "514964283"); bind(2, "562620213");
check("the binding never mutates the rows it is given", JSON.stringify(ROWS), SNAPSHOT_BEFORE);

// =====================================================================
section("8. The wiring — every route in the family binds, and binds FIRST");
// =====================================================================
function routeBody(signature) {
	const hits = SRC.split(signature).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 ${signature}, found ${hits}`);
	const s = SRC.indexOf(signature);
	const e = SRC.indexOf("\n});", s);
	if (e === -1) throw new Error(`could not find the end of ${signature}`);
	return SRC.slice(s, e + 4);
}
const ROUTES = {
	'app.post("/api/dispatch"': "dispatch_blocked",
	'app.post("/api/dispatch/reassign"': "reassign_blocked",
	'app.post("/api/dispatch/cancel"': "cancel_blocked",
	'app.post("/api/driver/respond"': "driver_respond_blocked",
};
for (const [sig, action] of Object.entries(ROUTES)) {
	const body = routeBody(sig);
	const name = sig.slice(9, -1);
	check(`${name} binds the row to the load`, body.includes("resolveLoadBinding("), true);
	check(`${name} refuses through the shared helper`, body.includes("sendLoadBindRefusal("), true);
	check(`${name} audits the refusal as ${action}`, body.includes(`"${action}"`), true);
	// The binding establishes WHICH LOAD this request is about, so nothing that
	// reasons about the load — least of all a write — may run before it.
	check(`${name} binds before any sheet write`,
		body.indexOf("resolveLoadBinding(") < (body.includes("spreadsheets.values.update")
			? body.indexOf("spreadsheets.values.update") : Infinity), true);
	check(`${name} binds before any batchUpdate`,
		body.indexOf("resolveLoadBinding(") < (body.includes("values.batchUpdate")
			? body.indexOf("values.batchUpdate") : Infinity), true);
}
// The period guard judges the row at rowIndex; if that row is not the load the
// caller named, its verdict is about the wrong load. Binding must come first.
for (const sig of ['app.post("/api/dispatch"', 'app.post("/api/dispatch/reassign"',
	'app.post("/api/driver/respond"']) {
	const body = routeBody(sig);
	check(`${sig.slice(9, -1)} binds before the period guard runs`,
		body.indexOf("resolveLoadBinding(") < body.indexOf("dispatchWriteBlocker("), true);
}
// ⚠️ 4 → 5. PUT /api/driver/status joined the family: it was the fifth route
// taking `rowIndex` and `loadId` as independent body fields, and the only one
// this suite's own header comment listed as "reported, not fixed". The count is
// deliberately an equality, not a `>=`, so ADDING a sixth caller-row route
// without binding it fails here rather than passing quietly.
check("resolveLoadBinding is called from exactly the 5 routes",
	SRC.split("const unbound = resolveLoadBinding(").length - 1, 5);
check("all five read the sheet through the one snapshot helper",
	SRC.split("await readJobTrackingSnapshot(sheets, rowIndex)").length - 1, 5);

// ⚠️ #211's carve-out, re-pinned here because this PR touches the cancel route:
// a broker calling off a July load in August is ordinary business, and a guard
// that refuses ordinary work gets switched off. The binding is a different
// question ("is this the load you named?"), which has one right answer in every
// month — so it must not have dragged a period check in with it.
const CANCEL_CODE = routeBody('app.post("/api/dispatch/cancel"')
	.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
check("still no period guard in cancel (#211, re-pinned)",
	/dispatchWriteBlocker|statusOverrideBlocker|periodLocksReadable|sendPeriodRefusal|sendDispatchRefusal|isLocked\(/.test(CANCEL_CODE),
	false);
check("cancel still requires a reason", CANCEL_CODE.includes("CANCEL_REASON_REQUIRED"), true);
check("cancel still validates the row number through the shared helper",
	/const rowIndex = resolveSheetDataRow\(res, rawRowIndex\)/.test(CANCEL_CODE), true);
// The reason guard is pure request validation with no I/O; the binding costs a
// sheet read. Cheap refusals first.
check("cancel refuses a missing reason before paying for a sheet read",
	CANCEL_CODE.indexOf("CANCEL_REASON_REQUIRED") < CANCEL_CODE.indexOf("resolveLoadBinding("), true);
// An unreadable sheet cannot confirm the row, so cancel refuses instead of
// falling through to the write it used to do.
check("cancel refuses when Job Tracking cannot be read",
	CANCEL_CODE.includes("SHEET_UNREADABLE"), true);
check("...and that refusal is a 503, i.e. retryable", CANCEL_CODE.includes("http: 503"), true);

// The Driver-reachable route must bind AFTER the ownership check, so the binding
// cannot become a pre-auth oracle.
const RESPOND = routeBody('app.post("/api/driver/respond"');
check("driver/respond checks load ownership before binding",
	RESPOND.indexOf("loadBelongsToDriver(") < RESPOND.indexOf("resolveLoadBinding("), true);

// One normaliser, app-wide.
// ⚠️ The audit line is built from caller-derived strings. `what` interpolates
// `driver`/`newDriver`, which fall back to the caller's raw value, on two routes
// with NO rate limiter — and audit_trail has no retention job. Both refusal
// helpers must cap, not just the new one: one capping and the other not reads as
// a decision that the other case is safe.
for (const fn of ["sendLoadBindRefusal", "sendDispatchRefusal"]) {
	const body = extract(fn);
	check(`${fn} caps the audited action string`,
		/String\(what == null \? "" : what\)\.slice\(0, 200\)/.test(body), true);
	check(`${fn} caps the audited load id`, /\.slice\(0, 100\)/.test(body), true);
	check(`${fn} stringifies the id only when it is a primitive`,
		/typeof loadId === "string" \|\| typeof loadId === "number"/.test(body), true);
}
check("the ambiguous-rows detail is capped too",
	/join\(","\)\.slice\(0, 200\)/.test(extract("sendLoadBindRefusal")), true);

check("normLoadKey is defined exactly once in server.js",
	SRC.split("const normLoadKey = ").length - 1, 1);
// Comment lines stripped: the function's own prose names normLoadKey() when
// explaining the type gate, and a raw count would score that as a call site.
const BIND_CODE = extract("resolveLoadBinding").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
check("the binding uses it rather than a private copy — once for the caller's id, once per row",
	BIND_CODE.split("normLoadKey(").length - 1, 2);
check("the binding defines no normaliser of its own",
	/const norm|function norm|replace\(\/\^#\//.test(BIND_CODE), false);

// ------------------------------------------------------------------ report
console.log(`\n${"=".repeat(60)}`);
if (fail) {
	console.log(`FAILURES (${fail}):`);
	failures.forEach((f) => console.log(f));
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(1);
}
console.log(`ALL PASS\n${pass} passed, 0 failed`);
