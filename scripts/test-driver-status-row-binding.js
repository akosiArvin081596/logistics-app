#!/usr/bin/env node
/**
 * Tests for the three things this PR changed:
 *
 *   1. PUT /api/driver/status is BOUND to its row. It was the fifth and last
 *      route taking `rowIndex` and `loadId` as independent body fields, and the
 *      only one PR #248 listed as "reported, not fixed". Its `rowMatchesData`
 *      re-resolution was not a binding on three counts — `rowData` was optional,
 *      it compared only non-empty caller-supplied values and need not contain the
 *      Load ID column, and its fallback silently retargeted to the LAST row
 *      carrying the id. Live consequence: the POD gate keys on the CLAIMED
 *      `loadId`, so a Driver holding a genuine POD for their own load could stamp
 *      "Delivered" onto an arbitrary row — another driver's live load, or a
 *      completed one in a closed month.
 *
 *   2. POST /api/dispatch/cancel notifies the driver on the BOUND ROW, not
 *      `req.body.driver`.
 *
 *   3. audit_trail refusal rows coalesce, and only refusals are ever purged.
 *
 * WHY IT LOADS THE CODE OUT OF server.js SOURCE. Same reason as its four
 * siblings: server.js opens SQLite, reads a service-account key and starts
 * listening on import. Extracting the text exercises THE CODE THAT SHIPS rather
 * than a copy that can drift, and each function is asserted to be found exactly
 * once so a rename fails loudly instead of silently testing nothing.
 *
 * WHAT IS REAL: resolveLoadBinding(), normLoadKey() and logAuditRefusal(), all
 * lifted verbatim. Only `logAudit` and `Date` are injected — `Date` because the
 * coalescing window is 60s and a test must not sleep for it.
 *
 * THE FIXTURE IS THE REAL SHEET LAYOUT (the production/local 26-column Job
 * Tracking header row), so `/load.?id|job.?id/i` resolves the same column the
 * shipped route resolves.
 *
 * Run: node scripts/test-driver-status-row-binding.js
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
	const hits = SRC.match(new RegExp(`\\nconst ${name} = `, "g")) || [];
	if (hits.length !== 1) throw new Error(`expected exactly 1 \`const ${name}\`, found ${hits.length}`);
	return SRC.match(new RegExp(`\\nconst ${name} = [^\\n]+;`))[0];
}
// Multi-line array literal (PURGEABLE_REFUSAL_ACTIONS).
function extractArrayConst(name) {
	const anchor = `\nconst ${name} = [`;
	const hits = SRC.split(anchor).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 \`const ${name} = [\`, found ${hits}`);
	const start = SRC.indexOf(anchor) + 1;
	const end = SRC.indexOf("];", start);
	return SRC.slice(start, end + 2);
}
function routeBody(sig) {
	const hits = SRC.split(sig).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 \`${sig}\`, found ${hits}`);
	const start = SRC.indexOf(sig);
	let depth = 0, seen = false;
	for (let j = start; j < SRC.length; j++) {
		if (SRC[j] === "{") { depth++; seen = true; }
		else if (SRC[j] === "}") { depth--; if (seen && depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting route ${sig}`);
}

const G = {};
new Function("G",
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

// The REAL 26-column Job Tracking header row.
const PROD_HEADERS = ["Contract ID", "Load ID", "Broker Contact Name", "Broker Phone", "Driver",
	"Truck", "Trailer", "Owner ID", "Pickup Location", "Delivery Location", "Pickup Date",
	"Job Status", "  Payment  ", "Rate Per Mile", "Distance", "Notes", "Broker Email",
	"Pickup Ref", "Delivery Ref", "Commodity", "Assigned Date", "Status Update Date",
	"Completion Date", "Weight", "Equipment", "Miles"];
const LOAD_ID = PROD_HEADERS.indexOf("Load ID");
const STATUS = PROD_HEADERS.indexOf("Job Status");
const DRIVER = PROD_HEADERS.indexOf("Driver");
function row(loadId, opts = {}) {
	const r = new Array(PROD_HEADERS.length).fill("");
	r[LOAD_ID] = loadId;
	if (opts.status) r[STATUS] = opts.status;
	if (opts.driver) r[DRIVER] = opts.driver;
	return r;
}
const code = (r) => (r === null ? null : r.code);
// The relaxation this route opts into.
const OPT = { callerRowWinsAmongDuplicates: true };

// ================================================ 1. the relaxation, on and off
section("1. AMBIGUOUS_LOAD — the rung that had to be reshaped");

// ⚠️ THE MEASUREMENT THAT FORCED THIS. Against the PRODUCTION sheet, read-only,
// over the whole load_status_history window (2026-06-15..2026-08-06): of 199 real
// manual status changes, 195 bind cleanly, 0 hit LOAD_ID_REQUIRED, 0 hit
// LOAD_NOT_ON_SHEET, and 4 hit AMBIGUOUS_LOAD. Those 4 are Howard Reddie
// advancing load 7052901 through Heading to Shipper -> In Transit -> At Receiver
// -> Delivered on 2026-07-11..14. Row 383 holds the live load; row 388 holds a
// "#7052901" copy that was CANCELLED. A blanket rung 4 would have refused a
// driver in the cab, four times, on his own load.
const REDDIE = [row("7052901", { status: "In Transit", driver: "Howard Reddie" }), row("#7052901", { status: "Cancelled" })];
check("the live production case: caller's row is one of the copies -> ALLOWED",
	code(G.resolveLoadBinding(PROD_HEADERS, REDDIE, 2, "7052901", OPT)), null);
check("...and the '#'-prefixed copy binds too (normLoadKey, both directions)",
	code(G.resolveLoadBinding(PROD_HEADERS, REDDIE, 3, "7052901", OPT)), null);
check("...caller may name the id in '#' form as well",
	code(G.resolveLoadBinding(PROD_HEADERS, REDDIE, 2, "#7052901", OPT)), null);
// ⚠️ The relaxation is EXACTLY "the caller's row is one of the copies". A row
// that is NOT one of them is still refused, because the server would have to
// guess which copy — and guessing is what produced the 2026-08-05 incident.
check("a row that is NOT one of the copies is still AMBIGUOUS_LOAD",
	code(G.resolveLoadBinding(PROD_HEADERS, REDDIE, 4, "7052901", OPT)), "AMBIGUOUS_LOAD");
check("...and the refusal still names every candidate row",
	G.resolveLoadBinding(PROD_HEADERS, REDDIE, 4, "7052901", OPT).rowIndices, [2, 3]);

// ⚠️ DEFAULT OFF. The four routes PR #248 wired must keep byte-identical
// behaviour; only PUT /api/driver/status opts in. Cancel in particular must
// still refuse, for #248's own stated reason (cancelling one of two copies is a
// coin flip on whether it takes effect, since the dashboard reads
// deduplicateLoads() and the last row wins).
check("WITHOUT the opt-in, the same call still refuses (cancel/dispatch/reassign/respond)",
	code(G.resolveLoadBinding(PROD_HEADERS, REDDIE, 2, "7052901")), "AMBIGUOUS_LOAD");
check("...an explicitly false option is the same as absent",
	code(G.resolveLoadBinding(PROD_HEADERS, REDDIE, 2, "7052901", { callerRowWinsAmongDuplicates: false })), "AMBIGUOUS_LOAD");
check("...an unrelated option does not switch it on",
	code(G.resolveLoadBinding(PROD_HEADERS, REDDIE, 2, "7052901", { somethingElse: true })), "AMBIGUOUS_LOAD");

// ============================================ 2. the relaxation is NARROW
section("2. the relaxation touches rung 4 ONLY — every other rung is unchanged");

const ONE = [row("562620213", { status: "In Transit", driver: "Amir" }), row("999999", { status: "Delivered" })];
// This is the defect itself: a Driver's rowIndex pointing at a different load.
check("ROW_LOAD_MISMATCH still refuses, opt-in or not",
	code(G.resolveLoadBinding(PROD_HEADERS, ONE, 3, "562620213", OPT)), "ROW_LOAD_MISMATCH");
check("...and it names the row the load IS on, so the caller can refresh",
	G.resolveLoadBinding(PROD_HEADERS, ONE, 3, "562620213", OPT).rowIndex, 2);
// ⚠️ NO ORACLE: the body must be byte-identical for every wrong N, or a Driver
// could sweep rowIndex 2..N with their own load id and read the sheet's ids back.
check("...the mismatch body never leaks what the TARGET row holds",
	JSON.stringify(G.resolveLoadBinding(PROD_HEADERS, ONE, 3, "562620213", OPT)).includes("999999"), false);
check("LOAD_NOT_ON_SHEET still refuses",
	code(G.resolveLoadBinding(PROD_HEADERS, ONE, 2, "no-such-load", OPT)), "LOAD_NOT_ON_SHEET");
check("LOAD_ID_REQUIRED still refuses (omitting the id would bypass the guard)",
	code(G.resolveLoadBinding(PROD_HEADERS, ONE, 2, "", OPT)), "LOAD_ID_REQUIRED");
check("...including a whitespace-padded oversize id",
	code(G.resolveLoadBinding(PROD_HEADERS, ONE, 2, " ".repeat(200000) + "562620213", OPT)), "LOAD_ID_REQUIRED");
check("SHEET_LOAD_ID_MISSING still fails closed on a sheet with no Load ID column",
	code(G.resolveLoadBinding(["A", "B"], [["x", "y"]], 2, "562620213", OPT)), "SHEET_LOAD_ID_MISSING");
check("a correct single-row binding is allowed",
	code(G.resolveLoadBinding(PROD_HEADERS, ONE, 2, "562620213", OPT)), null);
// The header row and off-the-end rows carry no load id, so they can never bind.
check("row 1 (headers) can never bind", code(G.resolveLoadBinding(PROD_HEADERS, ONE, 1, "562620213", OPT)), "ROW_LOAD_MISMATCH");
check("a row past the end can never bind", code(G.resolveLoadBinding(PROD_HEADERS, ONE, 9999, "562620213", OPT)), "ROW_LOAD_MISMATCH");

// ⚠️ The security invariant the relaxation preserves, stated as a test: a row can
// only be accepted by CARRYING THE CALLER'S OWN LOAD ID. Reaching another load's
// row would need that row to carry the attacker's id, which is a contradiction.
const THREE = [row("AAA", { driver: "Victim" }), row("BBB"), row("AAA")];
for (let n = 2; n <= 4; n++) {
	const r = G.resolveLoadBinding(PROD_HEADERS, THREE, n, "AAA", OPT);
	const allowed = r === null;
	const carries = G.normLoadKey(THREE[n - 2][LOAD_ID]) === "AAA".toLowerCase();
	check(`row ${n} is allowed for load AAA only if it carries AAA`, allowed, carries);
}
// ⚠️ THE RELAXATION USES `carrying.includes(rowIndex)`, i.e. STRICT equality
// against numbers. Every route feeds it resolveSheetDataRow()'s output, which is
// `Number(value)` — a genuine Number, so the check works. Pinned here because if
// that helper ever returned a coerced STRING, the relaxation would silently stop
// firing. The direction of that failure is the safe one (refuse, loudly and
// immediately, not admit) and this asserts it stays that way: a string row index
// must never bind through the duplicate branch.
check("a string rowIndex fails CLOSED through the relaxation, never open",
	code(G.resolveLoadBinding(PROD_HEADERS, REDDIE, "2", "7052901", OPT)), "AMBIGUOUS_LOAD");
check("...and through the single-row branch too",
	code(G.resolveLoadBinding(PROD_HEADERS, ONE, "2", "562620213", OPT)), "ROW_LOAD_MISMATCH");
check("resolveSheetDataRow returns a Number, which is what makes that moot",
	/function resolveSheetDataRow\(res, value\) \{\n\tconst rowIndex = Number\(value\);/.test(SRC), true);

check("determinism: repeated calls agree", (() => {
	const a = JSON.stringify(G.resolveLoadBinding(PROD_HEADERS, REDDIE, 4, "7052901", OPT));
	const b = JSON.stringify(G.resolveLoadBinding(PROD_HEADERS, REDDIE, 4, "7052901", OPT));
	return a === b;
})(), true);
check("non-mutation: the fixture is untouched", (() => {
	const before = JSON.stringify(REDDIE);
	G.resolveLoadBinding(PROD_HEADERS, REDDIE, 2, "7052901", OPT);
	return JSON.stringify(REDDIE) === before;
})(), true);

// ================================================== 3. wiring in the status route
section("3. PUT /api/driver/status — the wiring");

const ROUTE = routeBody('app.put("/api/driver/status"');
const at = (s) => ROUTE.indexOf(s);
// Strip comments so prose about the old code cannot satisfy a code assertion.
const ROUTE_CODE = ROUTE.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

// ⚠️ H1 — THE ROUTE MUST BE ROLE-GATED. `requireAuth` only asserts a session
// exists, and the ownership check is gated on `role === "Driver"`, so under
// requireAuth an INVESTOR reached this route with no ownership check at all —
// and the binding's ROW_LOAD_MISMATCH names the row a load is on, turning that
// into a precise row-location oracle for any load id their own portal shows.
check("the route is requireRole-gated, NOT bare requireAuth",
	/app\.put\("\/api\/driver\/status", requireRole\("Super Admin", "Dispatcher", "Driver"\), driverWriteLimiter/.test(SRC), true);
check("...so an Investor cannot reach it", /app\.put\("\/api\/driver\/status", requireAuth/.test(SRC), false);
// The mount regex above already fixes the order (requireRole then the limiter);
// this states the property being protected rather than re-matching the string.
check("...and the role gate precedes the rate limiter (no budget spent on 403s)",
	/app\.put\("\/api\/driver\/status", requireRole\([^)]*\), driverWriteLimiter/.test(SRC), true);

// ⚠️ M2 — the relaxation is only safe while ownership is judged on the
// DEDUPLICATED view (last row per id wins). If loadBelongsToDriver() is ever
// changed to scan raw rows, a Driver owning any copy of a duplicated id could
// stamp a status onto another driver's copy. Pin the dependency both ways.
check("loadBelongsToDriver still judges ownership on the deduplicated cache",
	/function loadBelongsToDriver[\s\S]{0,900}getJobTrackingCached\(/.test(SRC), true);
check("...and the binding still reads the RAW snapshot, not that cache",
	ROUTE_CODE.includes("readJobTrackingSnapshot(sheets, rowIndex)")
	&& !/resolveLoadBinding\([\s\S]{0,120}getJobTrackingCached/.test(ROUTE_CODE), true);
check("...and the dependency is recorded where someone would break it",
	/loadBelongsToDriver\(\) is ever[\s\S]{0,200}raw scan|do not change that helper/i.test(SRC), true);

check("the route binds its row to the load", ROUTE_CODE.includes("resolveLoadBinding("), true);
check("...and opts into the measured relaxation", ROUTE_CODE.includes("callerRowWinsAmongDuplicates: true"), true);
check("...refusing through the shared helper, not a private 404",
	ROUTE_CODE.includes("sendLoadBindRefusal("), true);
// ⚠️ THE ORDERING THE BRIEF NAMES: dispatchWriteBlocker() judges the row AT
// rowIndex, so if that row is not the named load its verdict is about the wrong
// load. Binding must come first.
check("binding runs BEFORE the period guard", at("resolveLoadBinding(") < at("dispatchWriteBlocker("), true);
check("binding runs BEFORE the sheet write", at("resolveLoadBinding(") < at("values.batchUpdate"), true);
check("binding runs BEFORE the POD gate", at("resolveLoadBinding(") < at("POD_REQUIRED"), true);
check("binding runs BEFORE the one-active-job 409", at("resolveLoadBinding(") < at("ACTIVE_JOB_CONFLICT"), true);
// Authorization first: ownership of the id is checked before the row is read,
// exactly as PR #248 ordered /api/driver/respond.
check("the Driver ownership check still runs BEFORE the binding",
	at("loadBelongsToDriver") < at("resolveLoadBinding("), true);

// ⚠️ THE UNSAFE RE-RESOLUTION IS GONE, IN EVERY FORM.
check("rowMatchesData no longer exists anywhere in server.js", /function rowMatchesData/.test(SRC), false);
check("...no last-match-wins loadId fallback survives", ROUTE_CODE.includes("usedLoadIdFallback"), false);
check("...no descending rescan survives", /for \(let i = dataRows\.length - 1; i >= 0; i--\)/.test(ROUTE_CODE), false);
check("...the 'Could not find exact row' 404 is gone", ROUTE_CODE.includes("Could not find exact row"), false);
check("...rowData is not destructured from the body", /rowData/.test(ROUTE_CODE), false);
// ⚠️ `const`, not `let`: nothing can reassign the row between the guard and the
// write, so "the row the caller named is the row written" is true by construction.
check("rowIndex is const, so no code path can retarget the write",
	/const rowIndex = resolveSheetDataRow\(res, rawRowIndex\)/.test(ROUTE_CODE), true);
check("...and it is never reassigned", /\browIndex = /.test(ROUTE_CODE.replace(/const rowIndex = /, "")), false);
// One snapshot for the binding, the active-job scan and the period guard.
check("the route reads the tab through the shared snapshot helper",
	ROUTE_CODE.includes("readJobTrackingSnapshot(sheets, rowIndex)"), true);
check("...and no longer issues its own values.get", ROUTE_CODE.includes("spreadsheets.values.get"), false);
check("an unreadable sheet refuses rather than falling through",
	ROUTE_CODE.includes("SHEET_UNREADABLE"), true);

// #246's work must survive intact.
check("#246: the status vocabulary gate is still here", ROUTE_CODE.includes("STATUS_OVERRIDE_ALLOWED"), true);
check("#246: newStatus is still canonically reassigned", ROUTE_CODE.includes("newStatus = canonicalStatus"), true);
check("#246: the cancel walk-around is still refused", ROUTE_CODE.includes("CANCEL_NOT_A_STATUS_UPDATE"), true);
check("#230: the period guard is still here", ROUTE_CODE.includes("dispatchWriteBlocker("), true);
check("#222: the row-number guard is still here", ROUTE_CODE.includes("resolveSheetDataRow(res, rawRowIndex)"), true);
check("the POD gate is still here", ROUTE_CODE.includes("POD_REQUIRED"), true);
check("the socket event still fires", ROUTE_CODE.includes('io.to("dispatch").emit("status-updated"'), true);
check("the dispatch feed row is still written", ROUTE_CODE.includes("insertDispatchNotification.run"), true);
check("the success audit line is still written", ROUTE_CODE.includes("'update_status'"), true);
check("load_status_history is still stamped", ROUTE_CODE.includes("recordStatusChange("), true);

// ================================================= 4. cancel notifies the bound driver
section("4. POST /api/dispatch/cancel — the notification target");

const CANCEL = routeBody('app.post("/api/dispatch/cancel"');
const CANCEL_CODE = CANCEL.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

check("the driver is read off the BOUND row", /const boundDriver = /.test(CANCEL_CODE), true);
check("...from the snapshot row at the caller's rowIndex",
	/snapshot\.row \|\| \[\]\)\[driverColIdx\]/.test(CANCEL_CODE), true);
check("req.body.driver is not destructured at all",
	/rowIndex: rawRowIndex, loadId, driver \}/.test(CANCEL_CODE), false);
// Each of the four sites the body value used to reach. Named individually rather
// than by a blanket "no `driver` identifier" scan, which would also match the
// `/driver/i` column-matching literal and fail for the wrong reason.
check("...no req.body.driver anywhere in the handler", /req\.body\.driver/.test(CANCEL_CODE), false);
check("...the old `driver.trim().toLowerCase()` target is gone", /[^a-zA-Z]driver\.trim\(\)/.test(CANCEL_CODE), false);
check("...no `${driver}`/`driver ||` interpolation survives",
	/\$\{driver\}|\$\{driver \|\||[^a-zA-Z]driver \|\| 'unknown'/.test(CANCEL_CODE), false);
check("...and the feed payload no longer shorthands a bare `driver`",
	/\{ loadId, driver, rowIndex/.test(CANCEL_CODE), false);
check("the driver notification targets the bound driver",
	/insertNotification\.run\(\s*boundDriver\.toLowerCase\(\)/.test(CANCEL_CODE), true);
check("the socket room is the bound driver", /io\.to\(boundDriver\.toLowerCase\(\)\)/.test(CANCEL_CODE), true);
check("the dispatch feed records the bound driver", /driver: boundDriver/.test(CANCEL_CODE), true);
check("the audit line names the bound driver", /\(driver: \$\{boundDriver\}\)/.test(CANCEL_CODE), true);
// It must be read BEFORE the write blanks the Driver cell, or it is always "".
check("boundDriver is read BEFORE the cell is blanked",
	CANCEL.indexOf("const boundDriver") < CANCEL.indexOf("values.update"), true);
// And the binding still has to have run, or "bound row" means nothing.
check("...and AFTER the binding proved the row holds this load",
	CANCEL.indexOf("resolveLoadBinding(") < CANCEL.indexOf("const boundDriver"), true);
// #211 / #246 carve-outs re-pinned.
check("#211: still no period guard in cancel", /dispatchWriteBlocker|sendPeriodRefusal|isLocked\(/.test(CANCEL_CODE), false);
check("cancel still requires a reason", CANCEL_CODE.includes("CANCEL_REASON_REQUIRED"), true);

// ============================================== 5. audit coalescing + retention
section("5. audit_trail — coalescing and bounded retention");

// Real logAuditRefusal(), with `logAudit` and `Date` injected. `Date` is injected
// because the window is 60s and a test must not sleep for it.
function makeCoalescer() {
	const written = [];
	const C = {};
	// ⚠️ UNCOALESCED_REFUSAL_CODES must be extracted too. Leaving it out made the
	// helper throw ReferenceError INSIDE its own try/catch, which swallows the
	// error and writes nothing — so every coalescing assertion silently "passed"
	// against a function that did nothing. Caught by the first-refusal assertion.
	const uncoalesced = SRC.slice(
		SRC.indexOf("const UNCOALESCED_REFUSAL_CODES = new Set(["),
		SRC.indexOf("]);", SRC.indexOf("const UNCOALESCED_REFUSAL_CODES = new Set([")) + 3
	);
	if (!uncoalesced.includes("PERIOD_FINALIZED")) throw new Error("could not extract UNCOALESCED_REFUSAL_CODES");
	new Function("C", "logAudit", "Date",
		[extractConst("REFUSAL_AUDIT_WINDOW_MS"), extractConst("refusalAuditWindows"), uncoalesced, extract("logAuditRefusal")].join("\n") +
		"\nC.logAuditRefusal = logAuditRefusal; C.windows = refusalAuditWindows;"
	)(C, (_req, action, entity, entityId, details) => written.push({ action, entityId, details }),
		{ now: () => makeCoalescer.clock });
	return { fire: (...a) => C.logAuditRefusal({ session: { user: { id: 7 } } }, ...a), written, windows: C.windows };
}
makeCoalescer.clock = 1_000_000;

let co = makeCoalescer();
co.fire("status_update_blocked", "load", "L1", "Blocked A", "ROW_LOAD_MISMATCH");
check("the FIRST refusal in a window is written in full", co.written.length, 1);
check("...and still carries its own entity_id, so the load is not lost", co.written[0].entityId, "L1");
for (let i = 0; i < 500; i++) co.fire("status_update_blocked", "load", `L${i}`, "Blocked A", "ROW_LOAD_MISMATCH");
check("500 more inside the window write NOTHING (the flood is capped)", co.written.length, 1);
// ⚠️ Keyed on (user, action, code) and NOT on entity_id: the cheapest flood
// varies the load id every request, which would make every request a fresh key.
check("...even though every one named a DIFFERENT load id", co.written.length, 1);
// A different code is a different signal and must not be swallowed.
co.fire("status_update_blocked", "load", "L1", "Blocked B", "AMBIGUOUS_LOAD");
check("a different refusal CODE is written immediately", co.written.length, 2);
// A different route likewise.
co.fire("cancel_blocked", "load", "L1", "Blocked C", "ROW_LOAD_MISMATCH");
check("a different ACTION is written immediately", co.written.length, 3);
// After the window, the next one is written AND carries the suppressed count.
makeCoalescer.clock += 61_000;
co.fire("status_update_blocked", "load", "L1", "Blocked A", "ROW_LOAD_MISMATCH");
check("after the window the next refusal is written", co.written.length, 4);
check("...and the burst is COUNTED, not silently discarded",
	/\+500 more identical refusal\(s\) suppressed/.test(co.written[3].details), true);
// ⚠️ M3 — PERIOD refusals are NEVER coalesced. They need a locked month AND a
// material write on an admin-only route, so they are not floodable; collapsing
// them would cost the per-attempt load id and period list, and on the SHARED
// `super_admin` login would merge two different operators' attempts on two
// different months into one row.
{
	const co3 = makeCoalescer();
	for (let i = 0; i < 10; i++) co3.fire("status_update_blocked", "load", `L${i}`, "Blocked", "PERIOD_FINALIZED");
	check("10 period refusals write 10 rows — never collapsed", co3.written.length, 10);
	check("...each keeping its own load id", co3.written.map((w) => w.entityId), ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9"]);
	for (const c of ["PERIOD_LOCK_UNREADABLE", "PERIOD_UNRESOLVED"]) {
		const co4 = makeCoalescer();
		co4.fire("cancel_blocked", "load", "A", "x", c);
		co4.fire("cancel_blocked", "load", "B", "x", c);
		check(`${c} is exempt too`, co4.written.length, 2);
	}
	// ...but a binding refusal in the same action still coalesces.
	const co5 = makeCoalescer();
	for (let i = 0; i < 10; i++) co5.fire("status_update_blocked", "load", `L${i}`, "Blocked", "ROW_LOAD_MISMATCH");
	check("a binding refusal on the SAME action still collapses", co5.written.length, 1);
}

// A different user must never be suppressed by someone else's burst.
const co2 = makeCoalescer();
co2.fire("status_update_blocked", "load", "L1", "x", "ROW_LOAD_MISMATCH");
check("a second actor is audited independently", co2.written.length, 1);
// The map cannot grow without bound.
check("the key map is bounded by (user x action x code), not by load id",
	co.windows.size <= 8, true);

// ---- the purge: what it is allowed to touch
const P = {};
new Function("P", extractArrayConst("PURGEABLE_REFUSAL_ACTIONS") + "\nP.list = PURGEABLE_REFUSAL_ACTIONS;")(P);
const PURGE = P.list;
const PURGE_FN = extract("purgeOldAuditRefusals");

// ⚠️ A SUBSET PIN, NOT AN EQUALITY, AND THE DIRECTION IS THE WHOLE ARGUMENT.
// The dangerous direction is a WRITE action appearing on the list (evidence
// destroyed) — asserted exhaustively below. The other direction, a `*_blocked`
// action NOT on the list, means that action is simply KEPT FOREVER, which is the
// safe default. An equality pin (my first draft) inverts the pressure: any new
// `*_blocked` action fails CI until someone adds it, and the path of least
// resistance is to add it un-reviewed — a test that manufactures the exact
// unsafe edit it exists to prevent. So: every entry must be a real `*_blocked`
// action, and nothing is forced onto the list.
const blockedInSrc = [...new Set((SRC.match(/"[a-z_]+_blocked"/g) || []).map((s) => s.slice(1, -1)))].sort();
check("every purgeable action is a real *_blocked action in server.js",
	PURGE.every((a) => blockedInSrc.includes(a)), true);
check("...and there is no dead entry on the list", PURGE.filter((a) => !blockedInSrc.includes(a)), []);
// ⚠️ THE REVIEWED LIST, pinned as a SUPERSET requirement. This is the half of the
// old equality pin that is worth keeping: each of these eight was checked call
// site by call site and confirmed to return before any sheet or database write,
// so silently DROPPING one is a regression worth failing on. What is deliberately
// not asserted is the other direction — a NEW `*_blocked` action is not forced
// onto the list, because forcing it is what produces an un-reviewed addition.
const REVIEWED_PURGEABLE = ["dispatch_blocked", "reassign_blocked", "cancel_blocked",
	"driver_respond_blocked", "status_update_blocked", "status_override_blocked",
	"create_sheet_row_blocked", "update_sheet_row_blocked"].sort();
check("the reviewed refusal actions are all still purgeable",
	REVIEWED_PURGEABLE.filter((a) => !PURGE.includes(a)), []);
// Informational, and deliberately NOT a failure: an unlisted refusal is retained.
{
	const unlisted = blockedInSrc.filter((a) => !PURGE.includes(a));
	console.log(`       (note: ${unlisted.length} *_blocked action(s) not on the purge list — retained forever, the safe default${unlisted.length ? ": " + unlisted.join(", ") : ""})`);
}
check("every purgeable action really exists in server.js",
	PURGE.every((a) => SRC.includes(`"${a}"`)), true);
check("every purgeable action is named *_blocked", PURGE.every((a) => a.endsWith("_blocked")), true);

// ⚠️ AUDIT ROWS ARE EVIDENCE. Nothing that records a WRITE may be purgeable.
const WRITE_ACTIONS = ["cancel_load", "update_status", "dispatch_load", "status_override",
	"update_sheet_row", "create_sheet_row", "delete_sheet_row", "delete_sheet_rows",
	"setup_super_admin", "create_user", "investor_payout_status", "routemate_sync"];
for (const a of WRITE_ACTIONS) {
	check(`write action "${a}" is NOT purgeable`, PURGE.includes(a), false);
}
// `*_failed` records a write that already started — possibly a partial write.
const failedInSrc = [...new Set((SRC.match(/"[a-z_]+_failed"/g) || []).map((s) => s.slice(1, -1)))];
check("no *_failed action is purgeable (a partial write is the most important row)",
	failedInSrc.some((a) => PURGE.includes(a)), false);
check("...and there really are some to protect", failedInSrc.length > 0, true);
// ⚠️ setup_refused is the one refusal deliberately kept forever.
check("setup_refused exists in server.js", SRC.includes('"setup_refused"'), true);
check("...and is NOT purgeable (unauthenticated route, slow-guess evidence)",
	PURGE.includes("setup_refused"), false);

// The DELETE itself.
check("the purge scopes by an explicit action list, never a LIKE pattern",
	/action IN \(\$\{placeholders\}\)/.test(PURGE_FN), true);
// ⚠️ The property is "no pattern match on the ACTION column" — that is what
// would silently adopt a future `*_blocked` action, including one recording a
// write. The `details NOT LIKE '%[PERIOD_%'` clause added for L5 is the opposite
// kind of thing: it only ever REMOVES rows from the delete set, so it can retain
// too much but never destroy too much.
check("the action column is never pattern-matched", /action LIKE/.test(PURGE_FN), false);
check("...and the only LIKE narrows the delete set (NOT LIKE on details)",
	(PURGE_FN.match(/LIKE/g) || []).length, 1);
check("...and is also bounded by timestamp", /AND timestamp < \?/.test(PURGE_FN), true);
// ⚠️ L5 — the ACTION is not fine-grained enough: status_update_blocked carries
// both cheap ROW_LOAD_MISMATCH noise and PERIOD_FINALIZED settlement disputes,
// which surface on a cadence longer than the retention window.
check("period refusals are excluded from the purge by detail, not just by action",
	/details NOT LIKE '%\[PERIOD/.test(PURGE_FN), true);
check("...with a LIKE escape, so the underscore is a literal not a wildcard",
	/ESCAPE '\\\\'/.test(PURGE_FN), true);
check("the never-coalesced and never-purged sets are the same family",
	/UNCOALESCED_REFUSAL_CODES = new Set\(\[\s*\n?\s*"PERIOD_FINALIZED", "PERIOD_LOCK_UNREADABLE", "PERIOD_UNRESOLVED",/.test(SRC), true);

// ⚠️ I10 — an own-property test, so a polluted Object.prototype cannot switch
// the relaxation on for a caller that passed a bare {}.
check("the relaxation reads an OWN property, not an inherited one",
	/Object\.hasOwn\(opts, "callerRowWinsAmongDuplicates"\)/.test(SRC), true);
{
	const poisoned = {};
	Object.defineProperty(Object.prototype, "callerRowWinsAmongDuplicates", { value: true, configurable: true });
	const viaEmpty = code(G.resolveLoadBinding(PROD_HEADERS, REDDIE, 2, "7052901", poisoned));
	const viaAbsent = code(G.resolveLoadBinding(PROD_HEADERS, REDDIE, 2, "7052901"));
	delete Object.prototype.callerRowWinsAmongDuplicates;
	check("a polluted prototype cannot enable it via {}", viaEmpty, "AMBIGUOUS_LOAD");
	check("...nor via an omitted opts", viaAbsent, "AMBIGUOUS_LOAD");
}
// ⚠️ ISO-to-ISO. logAudit() always stores toISOString(); SQLite's datetime()
// renders `YYYY-MM-DD HH:MM:SS`, and comparing that to `…THH:MM:SS.sssZ` is a
// string comparison in which 'T' sorts above the space.
check("the cutoff is an ISO string computed in JS, not SQLite datetime()",
	/new Date\(Date\.now\(\) - REFUSAL_AUDIT_RETENTION_DAYS[\s\S]*?\.toISOString\(\)/.test(PURGE_FN), true);
check("...so the DELETE never calls datetime('now', …)", /datetime\('now'/.test(PURGE_FN), false);
check("the purge is scheduled like purgeOldDriverLocations (boot + weekly)",
	/purgeOldAuditRefusals\(\);\nsetInterval\(purgeOldAuditRefusals, 7 \* 24 \* 60 \* 60 \* 1000\)/.test(SRC), true);
check("logAudit itself is untouched — successes are never coalesced",
	/function logAudit\(req, action, entity, entityId, details\) \{\n\ttry \{\n\t\tconst user = req\.session\?\.user \|\| \{\};\n\t\tdb\.prepare\("INSERT INTO audit_trail/.test(SRC), true);

// =========================================================== 6. family coherence
section("6. the whole caller-row family still agrees");

for (const sig of ['app.post("/api/dispatch"', 'app.post("/api/dispatch/reassign"',
	'app.post("/api/dispatch/cancel"', 'app.post("/api/driver/respond"', 'app.put("/api/driver/status"']) {
	const body = routeBody(sig);
	check(`${sig.slice(9, -1)} binds its row to the load`, body.includes("resolveLoadBinding("), true);
}
// Only the status route may opt in; the other four must keep #248's behaviour.
check("exactly one route opts into the duplicate relaxation",
	SRC.split("callerRowWinsAmongDuplicates: true").length - 1, 1);
check("...and it is PUT /api/driver/status",
	routeBody('app.put("/api/driver/status"').includes("callerRowWinsAmongDuplicates: true"), true);
// ⚠️ COMMENTS STRIPPED FIRST. Both helpers carry a `// Coalesced — see
// logAuditRefusal()` note in their body, so a naive substring test passes on the
// PROSE even after the call itself is reverted to logAudit(). A mutant reverting
// sendLoadBindRefusal survived exactly that way before this line stripped them.
const decomment = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
check("both refusal helpers coalesce, so neither reads as 'the other cannot flood'",
	decomment(extract("sendLoadBindRefusal")).includes("logAuditRefusal(") &&
	decomment(extract("sendDispatchRefusal")).includes("logAuditRefusal("), true);
check("...and neither still calls plain logAudit()",
	/[^a-zA-Z]logAudit\(/.test(decomment(extract("sendLoadBindRefusal"))) ||
	/[^a-zA-Z]logAudit\(/.test(decomment(extract("sendDispatchRefusal"))), false);

// ------------------------------------------------------------------- summary
console.log("\n" + "=".repeat(60));
if (failures.length) { console.log(`FAILURES (${failures.length}):`); failures.forEach((f) => console.log(f)); }
else console.log("ALL PASS");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
