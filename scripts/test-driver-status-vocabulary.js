#!/usr/bin/env node
/**
 * Tests for the two follow-ups PR #230 named and left:
 *
 *   1. PUT /api/driver/status took `newStatus` as UNCONSTRAINED FREE TEXT, on the
 *      one status-writing route a **Driver** can reach. PR #223 constrained the
 *      admin-only override route; PR #230 refused a locked month here. An OPEN
 *      month was unchanged — and "Cancelled" in an open month drops the load out
 *      of revenue, driver pay and every KPI via excludeDroppedLoads(), with none
 *      of the reason, driver notification or `cancel_load` audit row that
 *      POST /api/dispatch/cancel demands. An open month is precisely the one
 *      still being accrued into, so this is the live half.
 *
 *   2. POST /api/dispatch/cancel still validated its row number with
 *      `if (!rowIndex)`. `1` is truthy, so it passed — and the route then writes
 *      Job Status = "Cancelled" and blanks Driver on the HEADER row, re-pointing
 *      every findCol() regex in the app. It is the last route in the family
 *      carrying that shape; #222 skipped it only to avoid colliding with another
 *      agent.
 *
 * WHY IT LOADS THE GATE OUT OF server.js SOURCE INSTEAD OF require()-ING IT.
 * Same reason as test-status-override-guard.js and test-dispatch-period-guard.js:
 * server.js opens SQLite, reads a service account key and starts listening on
 * import. Extracting the text keeps this honest in the way that matters — it
 * exercises THE CODE THAT SHIPS, not a copy that can drift from it. Every anchor
 * is asserted to appear exactly once, so a rename, a move or a second copy fails
 * the run loudly rather than silently testing nothing.
 *
 * WHAT IS REAL AND WHAT IS STUBBED. The whole gate is real: the allowlist read
 * off its own source line, the case-insensitive match, the trim, the real
 * CANCELED_STATUS_RE, the real status codes, the real prose, and the
 * `newStatus = canonicalStatus` reassignment that decides what actually gets
 * written. Only `res` and `logAudit` are stubbed — they are the I/O, not the
 * decision.
 *
 * THE PROPERTY UNDER TEST is not merely "a bad status is refused". It is:
 *   (a) the server's vocabulary is a SUPERSET of every client's, so no client
 *       can offer a button the server refuses — the direction that breaks the
 *       driver app, and the reason this list could not just be guessed at;
 *   (b) "Cancelled" is refused SPECIFICALLY, with its own code and an audit row,
 *       because it is the one value on the allowlist's doorstep that ERASES a
 *       figure rather than moving it;
 *   (c) what gets written downstream is the CANONICAL spelling, never the raw
 *       request string — otherwise the sheet accumulates one spelling per typist
 *       and completedStatuses starts missing rows;
 *   (d) the gate sits before the ownership check and the sheet write, not after.
 *
 * Run: node scripts/test-driver-status-vocabulary.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

// ---------------------------------------------------------------- extraction
// The route body, sliced out first so the gate below is anchored INSIDE it. The
// two status-writing routes deliberately share prose (`newStatus is required`
// is byte-identical in PR #223's override route), so a file-wide anchor would be
// ambiguous — and picking the wrong one would silently test the other route.
// Ends at the route's own column-0 `});` — NOT at the next `app.`, which on the
// cancel route would swallow the sendPeriodRefusal() helper defined between the
// two registrations and make every "this route does not call X" assertion lie.
function routeBody(signature) {
	const hits = SRC.split(signature).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 ${signature} in server.js, found ${hits}`);
	const s = SRC.indexOf(signature);
	const e = SRC.indexOf("\n});", s);
	if (e === -1) throw new Error(`could not find the end of ${signature}`);
	return SRC.slice(s, e + 4);
}
const ROUTE = routeBody('app.put("/api/driver/status"');
const CANCEL = routeBody('app.post("/api/dispatch/cancel"');

// Whole-line comments stripped, for the assertions that a route does NOT contain
// something. Both routes now carry comments *quoting* the defect they fixed
// (`if (!rowIndex)`), so a raw text search finds the tombstone and reports the
// bug as still present. Only lines that are entirely a comment are dropped, so a
// string holding `//` (a URL) can never be truncated mid-statement.
const codeOnly = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const CANCEL_CODE = codeOnly(CANCEL);
// Offset of a marker within PUT /api/driver/status, for the ordering assertions.
const at = (needle) => ROUTE.indexOf(needle);

function once(needle, label) {
	const hits = ROUTE.split(needle).length - 1;
	if (hits !== 1) {
		throw new Error(`expected exactly 1 occurrence of ${label} in PUT /api/driver/status, found ${hits}`);
	}
	return ROUTE.indexOf(needle);
}

// The allowlist, read off the same source line both routes use.
function extractAllowList() {
	const m = SRC.match(/\nconst STATUS_OVERRIDE_ALLOWED = (\[[^\]]*\]);/);
	if (!m) throw new Error("STATUS_OVERRIDE_ALLOWED not found in server.js");
	if (SRC.split("\nconst STATUS_OVERRIDE_ALLOWED = ").length - 1 !== 1) {
		throw new Error("STATUS_OVERRIDE_ALLOWED is declared more than once — the two routes would diverge");
	}
	return JSON.parse(m[1].replace(/'/g, '"'));
}

function extractCanceledRe() {
	const m = SRC.match(/\nconst CANCELED_STATUS_RE = (\/[^\n]*\/[a-z]*);/);
	if (!m) throw new Error("CANCELED_STATUS_RE not found in server.js");
	return m[1];
}

// The gate itself, sliced out of PUT /api/driver/status between two anchors that
// each appear exactly once in the file. Everything between them ships as-is.
const GATE_START = '\t\tif (!newStatus || typeof newStatus !== "string") {';
const GATE_END = "\t\tnewStatus = canonicalStatus;";
function extractGate() {
	const a = once(GATE_START, "the driver-status newStatus type check");
	const b = once(GATE_END, "the canonical-status reassignment");
	if (b < a) throw new Error("newStatus is reassigned BEFORE it is validated");
	return ROUTE.slice(a, b + GATE_END.length);
}

const STATUS_OVERRIDE_ALLOWED = extractAllowList();
const CANCELED_STATUS_RE = eval(extractCanceledRe()); // eslint-disable-line no-eval

// Wrap the extracted gate so its `return`s land here. `newStatus` is the
// parameter, exactly as the route's `let` destructure makes it, so the shipped
// `newStatus = canonicalStatus` reassignment is exercised rather than simulated.
// ⚠️ The injected audit sink is `logAuditRefusal`, not `logAudit`. The
// audit-retention PR routed every refusal in this family through the coalescing
// wrapper so a Driver cannot flood audit_trail at 60/min; the cancel-attempt row
// this suite asserts on is still written, just through that helper. Injecting it
// under the name the route actually calls is what keeps this test exercising the
// shipped line — a stale `logAudit` parameter would make the gate throw
// ReferenceError rather than silently pass, which is how this was caught.
const runGate = new Function(
	"newStatus", "res", "req", "loadId", "logAuditRefusal", "STATUS_OVERRIDE_ALLOWED", "CANCELED_STATUS_RE",
	`${extractGate()}\n\t\treturn { written: newStatus };`
);

// A `res` that records instead of responding.
function judge(raw, opts = {}) {
	const audits = [];
	let sent = null;
	const res = {
		status(code) { sent = { code }; return { json(body) { sent.body = body; return sent; } }; },
	};
	const out = runGate(
		raw, res, {}, opts.loadId || "L1",
		(_req, action, entity, entityId, details, code) => audits.push({ action, entity, entityId, details, code }),
		STATUS_OVERRIDE_ALLOWED, CANCELED_STATUS_RE
	);
	// `body` defaults to {} so an assertion on a refusal that did NOT happen
	// reports a failure instead of throwing — a mutant that lets everything
	// through must not crash the run before the later sections get to speak.
	return { sent, audits, written: out && out.written, body: (sent && sent.body) || {} };
}

// -------------------------------------------------------------------- runner
let pass = 0, fail = 0;
const failures = [];
function check(label, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; console.log(`  ok   ${label}`); }
	else { fail++; failures.push(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); console.log(`  FAIL ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ============================================================ 1. the allowlist
section("1. the vocabulary itself");

check("the seven statuses, in flow order", STATUS_OVERRIDE_ALLOWED,
	["Dispatched", "Heading to Shipper", "At Shipper", "Loading", "In Transit", "At Receiver", "Delivered"]);
check("no cancel spelling is settable through either route",
	STATUS_OVERRIDE_ALLOWED.filter((s) => CANCELED_STATUS_RE.test(s)), []);
check("no Completed / POD Received (no client ever offered them)",
	STATUS_OVERRIDE_ALLOWED.filter((s) => /^(completed|pod received)$/i.test(s)), []);
check("no Assigned / Unassigned — POST /api/driver/respond owns those",
	STATUS_OVERRIDE_ALLOWED.filter((s) => /^(assigned|unassigned)$/i.test(s)), []);
check("exactly one value satisfies completedStatuses, so a completion has one spelling",
	STATUS_OVERRIDE_ALLOWED.filter((s) => /^(delivered|completed|pod received)$/i.test(s)), ["Delivered"]);
// Declared ABOVE PUT /api/driver/status, or the route would hit the TDZ.
check("the allowlist is declared before the driver-status route",
	SRC.indexOf("\nconst STATUS_OVERRIDE_ALLOWED = ") < SRC.indexOf('app.put("/api/driver/status"'), true);

// ==================================== 2. the server must not refuse a client button
section("2. cross-check — every client's vocabulary against the server's");

function readList(rel, re, label) {
	const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
	const m = src.match(re);
	if (!m) throw new Error(`${label} not found in ${rel}`);
	return m[1];
}
// Dispatch dropdown -> PUT /api/driver/status. The override modal defaults to
// statusOptions[0], so this one list feeds both routes and must be EQUAL.
const statusOptions = JSON.parse(
	readList("client/src/components/dashboard/ActiveLoadsTab.vue",
		/const statusOptions = (\[[^\]]*\])/, "statusOptions").replace(/'/g, '"')
);
check("ActiveLoadsTab statusOptions === server allowlist", statusOptions, STATUS_OVERRIDE_ALLOWED);

// The driver app and the legacy page are strict SUBSETS — a driver never moves a
// load backwards to "Dispatched". Asserting equality here would fail on lists
// that are correct; subset pins the direction that actually breaks the app.
const stepperValues = [...readList("client/src/components/driver/StatusStepper.vue",
	/const statusFlow = (\[[\s\S]*?\n\])/, "statusFlow").matchAll(/value: '([^']+)'/g)].map((m) => m[1]);
check("StatusStepper offers 6 steps", stepperValues.length, 6);
check("every StatusStepper step is settable on the server",
	stepperValues.filter((s) => !STATUS_OVERRIDE_ALLOWED.includes(s)), []);

const legacyValues = [...readList("public/driver.html",
	/const STATUS_FLOW = (\[[\s\S]*?\n\])/, "STATUS_FLOW").matchAll(/value: '([^']+)'/g)].map((m) => m[1]);
check("legacy public/driver.html offers 5 steps", legacyValues.length, 5);
check("every legacy step is settable on the server",
	legacyValues.filter((s) => !STATUS_OVERRIDE_ALLOWED.includes(s)), []);

// The union of every caller is the list — neither wider (dead values nobody can
// send) nor narrower (a button the server refuses).
check("the allowlist is exactly the union of its clients",
	[...new Set([...statusOptions, ...stepperValues, ...legacyValues])].sort(),
	[...STATUS_OVERRIDE_ALLOWED].sort());

// ========================================================= 3. the gate's verdicts
section("3. the gate — what it accepts, and what it writes");

for (const s of STATUS_OVERRIDE_ALLOWED) {
	check(`"${s}" is accepted and written verbatim`, judge(s).written, s);
}
check("no refusal is sent on a legal status", judge("In Transit").sent, null);

// Canonicalisation: the sheet keeps ONE spelling per status however it was typed.
check('"delivered" -> "Delivered"', judge("delivered").written, "Delivered");
check('"  IN TRANSIT  " -> "In Transit"', judge("  IN TRANSIT  ").written, "In Transit");
check('"aT sHiPpEr" -> "At Shipper"', judge("aT sHiPpEr").written, "At Shipper");
check("a canonical write emits no refusal", judge("dELIVERED").sent, null);

// ============================================================ 4. the refusals
section("4. the gate — what it refuses");

const bogus = judge("Delivered!!");
check("an unknown status is 400", bogus.sent && bogus.sent.code, 400);
check("...with INVALID_STATUS", bogus.body.code, "INVALID_STATUS");
check("...and nothing is written", bogus.written, undefined);
check("...the refusal names the allowed values, so the caller can fix it",
	bogus.body.allowed, STATUS_OVERRIDE_ALLOWED);
check("...an ordinary typo is NOT audited (it would bury the cancel signal)",
	bogus.audits.length, 0);

// The whole point of the PR. Every spelling excludeDroppedLoads() drops.
for (const spelling of ["Cancelled", "cancelled", "Canceled", "CANCEL", " cancel "]) {
	const c = judge(spelling);
	check(`"${spelling}" is refused`, c.sent && c.sent.code, 400);
	check(`"${spelling}" -> CANCEL_NOT_A_STATUS_UPDATE`, c.body.code, "CANCEL_NOT_A_STATUS_UPDATE");
	check(`"${spelling}" writes nothing`, c.written, undefined);
	check(`"${spelling}" is audited as status_update_blocked`,
		c.audits.map((a) => a.action), ["status_update_blocked"]);
}
check("the cancel refusal points at the route that records a reason",
	/POST \/api\/dispatch\/cancel/.test(judge("Cancelled").body.error), true);
check("the cancel audit row carries the load id",
	(judge("Cancelled", { loadId: "562620213" }).audits[0] || {}).entityId, "562620213");
// Every value CANCELED_STATUS_RE matches must take the cancel branch, not the
// generic one — the two differ in privilege, not in tidiness.
check("no cancel spelling can reach the generic INVALID_STATUS branch",
	["cancel", "canceled", "cancelled", "CANCELLED"].map((s) => judge(s).body.code),
	["CANCEL_NOT_A_STATUS_UPDATE", "CANCEL_NOT_A_STATUS_UPDATE", "CANCEL_NOT_A_STATUS_UPDATE", "CANCEL_NOT_A_STATUS_UPDATE"]);

// A missing or non-string status must not fall through as "no status to check".
for (const [label, v] of [["undefined", undefined], ["null", null], ["empty", ""], ["a number", 7], ["an array", ["Delivered"]], ["an object", { s: "Delivered" }]]) {
	const r = judge(v);
	check(`${label} newStatus is 400`, r.sent && r.sent.code, 400);
	check(`${label} newStatus writes nothing`, r.written, undefined);
}
// ⚠️ The length cap. express.json is 50mb and body-parser inflates by default, so
// a small gzip body expands to a huge string; without this the INVALID_STATUS
// branch echoes it back and trim/lower-case make more copies, at 60 req/min per
// Driver. Refusing early keeps a bad request O(1).
section("4b. an oversized newStatus is refused before it is transformed or echoed");
const big = judge("A".repeat(100000));
check("a 100 KB status is 400", big.sent && big.sent.code, 400);
check("...with INVALID_STATUS", big.body.code, "INVALID_STATUS");
check("...and writes nothing", big.written, undefined);
check("...and does NOT echo the value back", (big.body.error || "").includes("AAAA"), false);
check("...so the response stays small", JSON.stringify(big.body).length < 500, true);
check("65 chars is over the line", judge("B".repeat(65)).body.code, "INVALID_STATUS");
check("...and every real status is far inside it",
	STATUS_OVERRIDE_ALLOWED.filter((s) => s.length > 64), []);
check("a padded but legal status still canonicalises", judge("   Delivered   ").written, "Delivered");
// The type guard must precede the cap, or a non-string throws on .length instead
// of returning a clean 400; the cap must precede the first transform.
check("the type guard still precedes the length cap",
	at('typeof newStatus !== "string"') < at("newStatus.length > 64"), true);
check("the length cap precedes the first transform of the value",
	at("newStatus.length > 64") < at("newStatus.trim().toLowerCase()"), true);

// logAudit stores entity_id unbounded, and loadId is caller-supplied.
section("4c. the audit row cannot be used as a write amplifier");
const longId = judge("Cancelled", { loadId: "9".repeat(5000) });
check("a cancel attempt with a 5 KB loadId still audits", longId.audits.length, 1);
check("...but the stored entity id is capped at 100", (longId.audits[0] || {}).entityId.length, 100);
check("a normal load id is stored whole",
	(judge("Cancelled", { loadId: "562620213" }).audits[0] || {}).entityId, "562620213");

section("4d. near-miss inputs");
// "Delivered" inside a longer string must NOT match — the comparison is on the
// whole trimmed value, not a substring, or " Cancelled (per broker)" would pass.
check("a substring match is not enough", judge("Delivered per broker").body.code, "INVALID_STATUS");
check("Cancelled with a note is still caught as a cancel attempt, not a typo",
	judge("Cancelled").body.code, "CANCEL_NOT_A_STATUS_UPDATE");

// ====================================================== 5. placement in the route
section("5. the gate is wired where it can actually bite");

check("the gate is inside PUT /api/driver/status", at(GATE_START.trim()) > -1, true);
// Request validation, not authorization: it must not cost an ownership lookup or
// a full Job Tracking read, and it reveals nothing about the load.
check("validation runs BEFORE the driver ownership check",
	at("const canonicalStatus") < at("loadBelongsToDriver"), true);
// ⚠️ The route's inline `spreadsheets.values.get` became
// readJobTrackingSnapshot(), the shared full-tab read the load binding needs.
// The property is unchanged and is what is pinned: an invalid status is refused
// without paying for a Job Tracking read at all.
check("validation runs BEFORE the sheet is read",
	at("const canonicalStatus") < at("readJobTrackingSnapshot("), true);
check("validation runs BEFORE the row is written",
	at("const canonicalStatus") < at("spreadsheets.values.batchUpdate"), true);
check("the rowIndex guard still runs first (#222/#230)",
	at("resolveSheetDataRow") < at("const canonicalStatus"), true);
// If the raw string could still reach a write site, canonicalising is decorative.
check("the canonical value replaces the request string exactly once",
	ROUTE.split("newStatus = canonicalStatus;").length - 1, 1);
check("canonicalStatus is not read after the reassignment",
	ROUTE.slice(at("newStatus = canonicalStatus;") + "newStatus = canonicalStatus;".length).includes("canonicalStatus"), false);
check("the write still uses newStatus, i.e. the canonical value",
	/values: \[\[newStatus\]\]/.test(ROUTE), true);
// The guards PR #230 and the POD gate installed must judge the canonical value too.
check("the POD gate is downstream of canonicalisation",
	at("const canonicalStatus") < at("POD_REQUIRED"), true);
check("the one-active-job 409 is downstream of canonicalisation",
	at("const canonicalStatus") < at("ACTIVE_JOB_CONFLICT"), true);
check("the period guard is downstream of canonicalisation",
	at("const canonicalStatus") < at("dispatchWriteBlocker"), true);

// ============================================ 6. POST /api/dispatch/cancel rowIndex
section("6. POST /api/dispatch/cancel — the header row");

check("the truthy `if (!rowIndex)` shape is gone", /if \(!rowIndex\)/.test(CANCEL_CODE), false);
check("it validates through the shared helper, not a fourth copy",
	/const rowIndex = resolveSheetDataRow\(res, rawRowIndex\)/.test(CANCEL), true);
// ⚠️ `driver` LEFT THIS DESTRUCTURE. The notification target is now read off the
// bound row (`snapshot.row[driverColIdx]`) instead of being taken on the caller's
// word, so the body field is not destructured at all — which is what stops a
// later edit reaching for it again. Pinned in its own right below.
check("it destructures the RAW value, so the validated number is what gets used",
	/const \{ rowIndex: rawRowIndex, loadId \} = req\.body/.test(CANCEL), true);
check("cancel no longer destructures a caller-supplied driver",
	/rowIndex: rawRowIndex, loadId, driver \} = req\.body/.test(CANCEL), false);
check("the validated row number reaches both A1 ranges",
	CANCEL.split("${colLetter(").length - 1, 2);
check("the row guard runs before the reason guard, matching the old order",
	CANCEL.indexOf("resolveSheetDataRow") < CANCEL.indexOf("CANCEL_REASON_REQUIRED"), true);
check("the row guard runs before any sheet write",
	CANCEL.indexOf("resolveSheetDataRow") < CANCEL.indexOf("spreadsheets.values.update"), true);
check("CANCEL_REASON_REQUIRED survives untouched", CANCEL.includes("CANCEL_REASON_REQUIRED"), true);

// ⚠️ #211's carve-out. Cancelling a load a broker called off is ordinary business
// in any month, and a guard that refuses ordinary work gets switched off — then it
// protects nothing. This PR adds row validation ONLY.
check("no period guard was smuggled into cancel (#211's deliberate carve-out)",
	/dispatchWriteBlocker|statusOverrideBlocker|periodLocksReadable|sendPeriodRefusal|sendDispatchRefusal|isLocked\(/.test(CANCEL_CODE), false);

// All five caller-supplied row indexes in the family now answer identically.
check("every route taking a caller rowIndex uses the one helper",
	SRC.split("resolveSheetDataRow(res, rawRowIndex)").length - 1, 5);
for (const route of ['app.post("/api/dispatch"', 'app.post("/api/dispatch/reassign"',
	'app.post("/api/dispatch/cancel"', 'app.post("/api/driver/respond"', 'app.put("/api/driver/status"']) {
	const s = SRC.indexOf(route);
	const e = SRC.indexOf("\napp.", s + 10);
	check(`${route.slice(9, -1)} validates its rowIndex`,
		SRC.slice(s, e).includes("resolveSheetDataRow(res, rawRowIndex)"), true);
}

// ------------------------------------------------------------------ report
console.log(`\n${"=".repeat(60)}`);
if (fail) {
	console.log(`FAILURES (${fail}):`);
	failures.forEach((f) => console.log(f));
} else {
	console.log("ALL PASS");
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
