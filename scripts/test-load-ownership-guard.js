#!/usr/bin/env node
/**
 * The driver load-ownership guard — loadBelongsToDriver() — and EVERY route that
 * calls it.
 *
 * WHY THIS EXISTS. A driver reported fuel receipts "not uploading". The guard
 * read Job Tracking through the 60 s cache and, when that read FAILED, answered
 * `false` — so every caller told the driver "This load is not assigned to you"
 * (403) for a load that was theirs. The upload client fails fast on a 4xx, so the
 * false refusal was never retried. Failing closed was right; the signal was a
 * lie. The guard now answers THREE ways:
 *
 *     true  — owned          false — not owned          null — could not verify
 *
 * and every call site answers null with sentIfLoadOwnershipUnverified(): a 503
 * with Retry-After and code LOAD_OWNERSHIP_UNVERIFIED, sent before any write.
 *
 * THE RULE THAT MUST NEVER BREAK: a read failure REFUSES. It never admits. null
 * is FALSY on purpose so that a call site which lost its 503 line still refuses
 * through its `if (!owned)` 403. §5 builds the ways that could be undone —
 * returning true, making the sentinel truthy, testing `=== false`, dropping the
 * strict deleted_loads read — and requires an assertion here to catch each one.
 *
 * OWNERSHIP IS NOT STATUS. The guard answers "does this load name this driver"
 * and nothing more; a load cancelled by a sheet edit still names its driver.
 * Until the shared cache stopped being filtered in place (test-jt-cache-
 * isolation.js), that row was USUALLY hidden from the guard by accident. §5
 * pins the rule that replaced the accident: a Driver's write to a cancelled
 * BOUND row is refused (409 LOAD_CANCELLED) by PUT /api/driver/status and POST
 * /api/driver/respond — judged on the bound row, so load 7052901's live row
 * above a cancelled "#7052901" copy keeps working.
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 loadBelongsToDriver() executed for real, lifted out of server.js with its
 *      two reads injected (getDeletedLoadIds is the REAL function over a fake db)
 *   §2 sentIfLoadOwnershipUnverified() executed against a fake res
 *   §3 EVERY call site, found by scanning server.js: its two guard lines are
 *      extracted and executed for owned = true / false / null
 *   §4 getDeletedLoadIds(): { strict: true } rethrows, the default still swallows
 *   §5 sentIfDriverWriteOnCancelledRow() executed, and wired into both write
 *      routes on the bound row, before any write
 *   §6 DISCRIMINATION — defang each protective clause, require an assertion to flip
 *
 * Pure: no server, no app.db, no network, no fixtures.
 *
 * Run: node scripts/test-load-ownership-guard.js
 */

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}

// --- lifting ---------------------------------------------------------------
// Brace-count a `function name(` out of server.js without booting the app.
// ⚠️ Keeps a leading `async ` — lifting loadBelongsToDriver without it turns
// every `await` inside into a SyntaxError at build time.
function liftFn(name) {
	let a = SRC.indexOf(`function ${name}(`);
	if (a < 0) { console.error(`FAIL  could not locate ${name} in server.js`); process.exit(1); }
	if (SRC.slice(a - 6, a) === "async ") a -= 6;
	let depth = 0, seen = false;
	for (let i = SRC.indexOf("{", a); i < SRC.length; i++) {
		if (SRC[i] === "{") { depth++; seen = true; }
		else if (SRC[i] === "}") { depth--; if (seen && depth === 0) return SRC.slice(a, i + 1); }
	}
	throw new Error(`unbalanced braces in ${name}`);
}

// Paren-count a route registration out of server.js, anchored at a line start
// (comments QUOTE route registrations; a bare indexOf can land in one).
function routeSource(verb, routePath) {
	const nl = SRC.indexOf(`\napp.${verb}("${routePath}"`);
	if (nl < 0) { console.error(`FAIL  route not found: ${verb.toUpperCase()} ${routePath}`); process.exit(1); }
	let depth = 0;
	for (let j = SRC.indexOf("(", nl + 1); j < SRC.length; j++) {
		if (SRC[j] === "(") depth++;
		else if (SRC[j] === ")") { depth--; if (depth === 0) return SRC.slice(nl + 1, j + 1); }
	}
	throw new Error(`unbalanced parens extracting ${routePath}`);
}

const GUARD_SRC = liftFn("loadBelongsToDriver");
const UNVERIFIED_SRC = liftFn("ownershipUnverified");
const SENT_SRC = liftFn("sentIfLoadOwnershipUnverified");
const DELETED_SRC = liftFn("getDeletedLoadIds");
const NORM_SRC = liftFn("normalizeDriverName");
const FINDCOL_SRC = liftFn("findCol");
const CANCELLED_WRITE_SRC = liftFn("sentIfDriverWriteOnCancelledRow");
const CANCELED_RE_SRC = (SRC.match(/const CANCELED_STATUS_RE = [^\n]+;/) || [""])[0];
if (!CANCELED_RE_SRC) { console.error("FAIL  could not locate CANCELED_STATUS_RE"); process.exit(1); }

// The cancelled-row refusal, with logAuditRefusal injected so the audit is seen.
function buildCancelledWrite(src = CANCELLED_WRITE_SRC, reSrc = CANCELED_RE_SRC) {
	const audits = [];
	const logAuditRefusal = (req, action, entity, entityId, details, code) => audits.push({ action, entity, entityId, details, code });
	const fn = new Function("logAuditRefusal",
		`"use strict";\n${reSrc}\n${src}\nreturn sentIfDriverWriteOnCancelledRow;`)(logAuditRefusal);
	return { fn, audits };
}

// The bound-row driver match (PUT /api/driver/status only), same injection.
const OTHERS_ROW_SRC = liftFn("sentIfDriverWriteOnOthersRow");
function buildOthersRow(src = OTHERS_ROW_SRC) {
	const audits = [];
	const logAuditRefusal = (req, action, entity, entityId, details, code) => audits.push({ action, entityId, code });
	const fn = new Function("logAuditRefusal",
		`"use strict";\n${NORM_SRC}\n${src}\nreturn sentIfDriverWriteOnOthersRow;`)(logAuditRefusal);
	return { fn, audits };
}

// The real getDeletedLoadIds over a fake `db`: `rows` or a thrown read.
function buildDeleted(deletedSrc = DELETED_SRC, { rows = [], throws = null } = {}) {
	const db = {
		prepare() {
			return { all() { if (throws) throw throws; return rows.map((load_id) => ({ load_id })); } };
		},
	};
	return new Function("db", `"use strict";\n${deletedSrc}\nreturn getDeletedLoadIds;`)(db);
}

// A guard instance. `sheet` is what the cache resolves to; `sheetThrows` throws
// synchronously, `sheetRejects` rejects — both are real failure shapes.
function buildGuard({
	guardSrc = GUARD_SRC, unverifiedSrc = UNVERIFIED_SRC, deletedSrc = DELETED_SRC,
	sheet = { headers: HEADERS, data: ROWS }, sheetThrows = null, sheetRejects = null,
	deleted = ["209875716"], deletedThrows = null,
} = {}) {
	const logs = [];
	const fakeConsole = { warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")), log() {} };
	const getDeletedLoadIds = buildDeleted(deletedSrc, { rows: deleted, throws: deletedThrows });
	const getJobTrackingCached = () => {
		if (sheetThrows) throw sheetThrows;
		if (sheetRejects) return Promise.reject(sheetRejects);
		return Promise.resolve(sheet);
	};
	const fn = new Function(
		"getDeletedLoadIds", "getJobTrackingCached", "console",
		`"use strict";\n${NORM_SRC}\n${FINDCOL_SRC}\n${unverifiedSrc}\n${guardSrc}\nreturn loadBelongsToDriver;`,
	)(getDeletedLoadIds, getJobTrackingCached, fakeConsole);
	return { fn, logs };
}

const sent = new Function(`"use strict";\n${SENT_SRC}\nreturn sentIfLoadOwnershipUnverified;`)();

function fakeRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, sends: 0,
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; this.sends++; return this; },
	};
}

// --- fixtures --------------------------------------------------------------
// Real header names from production's Job Tracking tab.
const HEADERS = ["Load ID", "Driver", "Job Status", "Pickup Address"];
const ROWS = [
	{ _rowIndex: 2, "Load ID": "564157463", Driver: "Deshorn King", "Job Status": "In Transit", "Pickup Address": "" },
	{ _rowIndex: 3, "Load ID": "#30080873", Driver: "Shorn  King", "Job Status": "Dispatched", "Pickup Address": "" },
	{ _rowIndex: 4, "Load ID": "209875716", Driver: "Deshorn King", "Job Status": "Cancelled", "Pickup Address": "" },
];
const SHEETS_DOWN = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
const DB_DOWN = Object.assign(new Error("SQLITE_IOERR: disk I/O error"), { code: "SQLITE_IOERR" });

(async () => {
	// =========================================================================
	console.log("\n§1  loadBelongsToDriver() — true / false / null");
	// =========================================================================
	const { fn: guard } = buildGuard();
	ok("the owning driver is ADMITTED (true)", (await guard("564157463", "Deshorn King")) === true);
	ok("case, whitespace and a leading # are folded on both sides",
		(await guard("#564157463", "  deshorn   KING ")) === true &&
		(await guard("30080873", "Shorn King")) === true);
	ok("another driver is REFUSED with false — a real answer, not null",
		(await guard("564157463", "Shorn King")) === false);
	ok('whole-value compare: "Shorn King" does not own "Deshorn King"\'s load',
		(await guard("564157463", "Shorn King")) === false);
	ok("an unknown load is false", (await guard("999999999", "Deshorn King")) === false);
	ok("a soft-deleted load is false even for the driver named on it",
		(await guard("209875716", "Deshorn King")) === false);
	ok("no loadId / no driverName is false, not null (nothing failed to read)",
		(await guard("", "Deshorn King")) === false && (await guard("564157463", "")) === false &&
		(await guard(null, null)) === false);

	const { fn: throwing, logs: throwLogs } = buildGuard({ sheetThrows: SHEETS_DOWN });
	const onThrow = await throwing("564157463", "Deshorn King");
	ok("Job Tracking read THROWS → null (could not verify), even for the real owner", onThrow === null);
	ok("...and it is logged with the reason", throwLogs.some((l) => /could not verify load "564157463".*Job Tracking read failed.*socket hang up/.test(l)));

	const { fn: rejecting } = buildGuard({ sheetRejects: SHEETS_DOWN });
	ok("Job Tracking read REJECTS → null", (await rejecting("564157463", "Deshorn King")) === null);
	ok("...and a stranger gets the same null — refused, never admitted",
		(await rejecting("564157463", "Shorn King")) === null);

	const { fn: dbDown } = buildGuard({ deletedThrows: DB_DOWN });
	ok("deleted_loads read fails → null, even for the owner of a LIVE load",
		(await dbDown("564157463", "Deshorn King")) === null);
	ok("deleted_loads read fails → null for the soft-deleted load's own driver " +
		"(the default empty-Set fallback would have admitted them)",
		(await dbDown("209875716", "Deshorn King")) === null);
	ok("NO ORACLE during a Sheets outage: a soft-deleted id answers null like every " +
		"other id (a deleted-first check answered it false → 403, the rest 503)",
		(await throwing("209875716", "Deshorn King")) === null && (await throwing("209875716", "x")) === null);
	ok("...because both reads happen before any answer",
		GUARD_SRC.indexOf("getJobTrackingCached()") > -1 &&
		GUARD_SRC.indexOf("getJobTrackingCached()") < GUARD_SRC.indexOf("if (deleted.has(targetLid)) return false;"));

	const { fn: noDriverCol } = buildGuard({ sheet: { headers: ["Load ID", "Job Status"], data: ROWS } });
	const { fn: noLoadCol } = buildGuard({ sheet: { headers: ["Driver", "Job Status"], data: ROWS } });
	const { fn: emptySheet } = buildGuard({ sheet: { headers: [], data: [] } });
	ok("a sheet with no Driver column → null (the question cannot be answered)",
		(await noDriverCol("564157463", "Deshorn King")) === null);
	ok("a sheet with no Load ID column → null", (await noLoadCol("564157463", "Deshorn King")) === null);
	ok("an empty read (no header row at all) → null", (await emptySheet("564157463", "Deshorn King")) === null);

	ok("⚠️ the could-not-verify answer is FALSY, so a bare `if (!owned)` still refuses",
		!onThrow === true);
	const answers = new Set();
	for (const g of [guard, throwing, rejecting, dbDown, noDriverCol]) {
		for (const [l, d] of [["564157463", "Deshorn King"], ["564157463", "x"], ["", "y"], ["209875716", "Deshorn King"]]) {
			answers.add(await g(l, d));
		}
	}
	ok("the guard only ever answers true, false or null", [...answers].every((v) => v === true || v === false || v === null));

	const { fn: longId, logs: longLogs } = buildGuard({ sheetThrows: SHEETS_DOWN });
	await longId("9".repeat(5000), "Deshorn King");
	ok("the logged id is capped (caller-supplied, against a 50 MB body limit)",
		longLogs.length === 1 && longLogs[0].length < 200);
	await longId("12\n[load-ownership] forged line", "Deshorn King");
	ok("...and JSON-quoted, so a newline in it cannot forge a second log line",
		longLogs.length === 2 && !longLogs[1].includes("\n") && longLogs[1].includes('"12\\n'));

	// =========================================================================
	console.log("\n§2  sentIfLoadOwnershipUnverified()");
	// =========================================================================
	{
		const res = fakeRes();
		const answered = sent(res, null);
		ok("null → answers (returns true)", answered === true);
		ok("...with 503, not 403", res.statusCode === 503);
		ok("...with Retry-After", res.headers["retry-after"] === "5");
		ok("...code LOAD_OWNERSHIP_UNVERIFIED, retryable: true",
			res.body.code === "LOAD_OWNERSHIP_UNVERIFIED" && res.body.retryable === true);
		ok("...and a message that asks for a retry instead of accusing the driver",
			/couldn't verify this load right now/i.test(res.body.error) && !/not assigned/i.test(res.body.error));
		ok("...sent exactly once", res.sends === 1);
	}
	for (const v of [true, false, undefined]) {
		const res = fakeRes();
		ok(`${String(v)} → does NOT answer, sends nothing, sets no header`,
			sent(res, v) === false && res.sends === 0 && res.statusCode === 200 && !Object.keys(res.headers).length);
	}
	{
		const res = fakeRes();
		sent(res, null, { ok: false, stops: [], code: "HIJACK", error: "x", retryable: false });
		ok("a route's envelope rides along ({ ok: false, stops: [] })",
			res.body.ok === false && Array.isArray(res.body.stops));
		ok("...but can never override the error, code or retryable flag",
			res.body.code === "LOAD_OWNERSHIP_UNVERIFIED" && res.body.retryable === true && res.body.error !== "x");
	}

	// =========================================================================
	console.log("\n§3  EVERY call site — found by scan, guard lines extracted and executed");
	// =========================================================================
	const lines = SRC.split("\n");
	const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
	const routeOf = (lineNo) => {
		for (let i = lineNo; i >= 0; i--) {
			const m = lines[i].match(/^app\.(get|post|put|delete|patch)\("([^"]+)"/);
			if (m) return `${m[1].toUpperCase()} ${m[2]}`;
		}
		return "(no route)";
	};
	const codeRefs = [];
	lines.forEach((l, i) => { if (l.includes("loadBelongsToDriver(") && !isComment(l)) codeRefs.push(i); });
	const callSites = codeRefs.filter((i) => !/async function loadBelongsToDriver\(/.test(lines[i]));
	ok("every code reference is the definition or `const owned = await loadBelongsToDriver(` " +
		"(no .then(), no un-awaited Promise — a Promise is TRUTHY and would admit)",
		callSites.every((i) => /^\s*const owned = await loadBelongsToDriver\(/.test(lines[i])));
	ok(`found the call sites (${callSites.length}; 10 when this runner was written)`, callSites.length >= 10);

	const routes = new Set(callSites.map(routeOf));
	for (const must of [
		"POST /api/expenses", "POST /api/documents/upload", "GET /api/documents/:loadId",
		"GET /api/fuel/trip-plan", "GET /api/poi/fuel-stops", "PUT /api/driver/status",
		"POST /api/driver/respond",
	]) ok(`${must} still calls the guard`, routes.has(must));

	const UNVERIFIED_LINE = /^\s*if \(sentIfLoadOwnershipUnverified\(res, owned(?:, \{[^}]*\})?\)\) return;\s*$/;
	const REFUSE_LINE = /^\s*if \(!owned\) return res\.status\(403\)\.json\(\{.*"This load is not assigned to you".*\}\);\s*$/;
	function runSite(unverifiedLine, refuseLine, owned) {
		const res = fakeRes();
		const r = new Function("res", "owned", "sentIfLoadOwnershipUnverified",
			`"use strict";\n${unverifiedLine}\n${refuseLine}\nreturn "PROCEEDED";`)(res, owned, sent);
		return { proceeded: r === "PROCEEDED", res };
	}
	for (const i of callSites) {
		const where = `${routeOf(i)} (server.js:${i + 1})`;
		const l1 = lines[i + 1], l2 = lines[i + 2];
		const shaped = UNVERIFIED_LINE.test(l1) && REFUSE_LINE.test(l2);
		ok(`${where}: 503 line, then the \`!owned\` 403 line`, shaped);
		if (!shaped) continue;
		const yes = runSite(l1, l2, true), no = runSite(l1, l2, false), unk = runSite(l1, l2, null);
		ok(`${where}: owner proceeds, nothing sent`, yes.proceeded && yes.res.sends === 0);
		ok(`${where}: non-owner → 403`, !no.proceeded && no.res.statusCode === 403);
		ok(`${where}: read failure → 503 LOAD_OWNERSHIP_UNVERIFIED, never 403, never proceeds`,
			!unk.proceeded && unk.res.statusCode === 503 && unk.res.body.code === "LOAD_OWNERSHIP_UNVERIFIED");
		const env403 = Object.keys(no.res.body).filter((k) => k !== "error");
		ok(`${where}: the 503 carries the route's own envelope (${env403.join(", ") || "none"})`,
			env403.every((k) => JSON.stringify(unk.res.body[k]) === JSON.stringify(no.res.body[k])));
	}

	// =========================================================================
	console.log("\n§4  getDeletedLoadIds() — strict for the guard, lenient for filters");
	// =========================================================================
	const lenient = buildDeleted(DELETED_SRC, { throws: DB_DOWN });
	let threw = null;
	try { lenient({ strict: true }); } catch (e) { threw = e; }
	ok("{ strict: true } RETHROWS a failed read", threw === DB_DOWN);
	ok("the default still answers an empty Set (excludeDroppedLoads and friends unchanged)",
		lenient() instanceof Set && lenient().size === 0);
	const working = buildDeleted(DELETED_SRC, { rows: [" 209875716 ", "ABC"] });
	ok("a working read is identical either way (trimmed, lower-cased)",
		[...working()].join() === "209875716,abc" && [...working({ strict: true })].join() === "209875716,abc");
	ok("the guard asks for the strict read", /getDeletedLoadIds\(\{ strict: true \}\)/.test(GUARD_SRC));

	// =========================================================================
	console.log("\n§5  a cancelled row is not a driver's to move — sentIfDriverWriteOnCancelledRow()");
	// =========================================================================
	const CANCELLED_NAMED = { _rowIndex: 6, "Load ID": "555000111", Driver: "Deshorn King", "Job Status": "Cancelled", "Pickup Address": "" };
	const { fn: guardSeesCancelled } = buildGuard({ sheet: { headers: HEADERS, data: [...ROWS, CANCELLED_NAMED] } });
	ok("OWNERSHIP IS NOT STATUS: the guard admits a driver still named on a cancelled row " +
		"(a sheet-edit cancel keeps the Driver cell) — which is why the refusal below is load-bearing",
		(await guardSeesCancelled("555000111", "Deshorn King")) === true);

	// Both routes hand the helper RAW sheet values: a header array and a row array.
	const RAW_HEADERS = ["Load ID", "Driver", "Job Status"];
	const asRole = (role) => ({ session: { user: { role, driverName: role === "Driver" ? "Howard Reddie" : null } } });
	{
		const { fn, audits } = buildCancelledWrite();
		const res = fakeRes();
		const answered = fn(asRole("Driver"), res, RAW_HEADERS, ["555000111", "Howard Reddie", "Cancelled"], "status_update_blocked", "555000111");
		ok("a Driver's write to a cancelled BOUND row → answered 409 LOAD_CANCELLED",
			answered === true && res.statusCode === 409 && res.body.code === "LOAD_CANCELLED");
		ok("...and audited under the route's own *_blocked action (coalesced helper)",
			audits.length === 1 && audits[0].action === "status_update_blocked" &&
			audits[0].code === "LOAD_CANCELLED" && audits[0].entityId === "555000111");
	}
	for (const spelling of ["Cancelled", "canceled", "CANCEL", "  cancelled  "]) {
		const { fn } = buildCancelledWrite();
		const res = fakeRes();
		ok(`"${spelling}" is refused — the excludeDroppedLoads() rule, not a new spelling list`,
			fn(asRole("Driver"), res, RAW_HEADERS, ["1", "Howard Reddie", spelling], "a", "1") === true && res.statusCode === 409);
	}
	{
		const { fn, audits } = buildCancelledWrite();
		const res = fakeRes();
		ok("a live bound row passes untouched: nothing sent, nothing audited",
			fn(asRole("Driver"), res, RAW_HEADERS, ["1", "Howard Reddie", "In Transit"], "a", "1") === false &&
			res.sends === 0 && audits.length === 0);
	}
	for (const role of ["Super Admin", "Dispatcher"]) {
		const { fn } = buildCancelledWrite();
		const res = fakeRes();
		ok(`${role} is not refused by this rule (Driver-only; admins keep their own paths)`,
			fn(asRole(role), res, RAW_HEADERS, ["1", "", "Cancelled"], "a", "1") === false && res.sends === 0);
	}
	{
		const { fn } = buildCancelledWrite();
		ok("a sheet with no status column has nothing to judge (and both routes refuse that shape elsewhere)",
			fn(asRole("Driver"), fakeRes(), ["Load ID", "Driver"], ["1", "Howard Reddie"], "a", "1") === false);
	}
	{
		// Load 7052901 in production: row 383 live, row 388 a cancelled "#7052901"
		// copy. The deduplicated view keeps the LAST row — the cancelled one — so a
		// rule judged there would strand the driver on his own live load.
		const REDDIE_LIVE = ["7052901", "Howard Reddie", "In Transit"];
		const REDDIE_COPY = ["#7052901", "Howard Reddie", "Cancelled"];
		const { fn } = buildCancelledWrite();
		ok("7052901: bound to the LIVE row, the driver keeps advancing it",
			fn(asRole("Driver"), fakeRes(), RAW_HEADERS, REDDIE_LIVE, "a", "7052901") === false);
		ok("7052901: bound to the cancelled copy, the write is refused",
			fn(asRole("Driver"), fakeRes(), RAW_HEADERS, REDDIE_COPY, "a", "7052901") === true);
	}
	{
		const { fn, audits } = buildCancelledWrite();
		fn(asRole("Driver"), fakeRes(), RAW_HEADERS, ["1", "x", "Cancelled"], "a", "9".repeat(5000));
		ok("the audited id is capped at 100 (caller-supplied)", audits[0].entityId.length === 100);
	}

	const STATUS_ROUTE = routeSource("put", "/api/driver/status");
	const RESPOND_ROUTE = routeSource("post", "/api/driver/respond");
	const STATUS_CALL = 'if (sentIfDriverWriteOnCancelledRow(req, res, headers, dataRows[rowIndex - 2], "status_update_blocked", loadId)) return;';
	const RESPOND_CALL = 'if (sentIfDriverWriteOnCancelledRow(req, res, headers, snapshot.row, "driver_respond_blocked", loadId)) return;';
	const at = (src, s) => src.indexOf(s);
	ok("PUT /api/driver/status passes the BOUND row (dataRows[rowIndex - 2]) and returns on refusal",
		STATUS_ROUTE.includes(STATUS_CALL));
	ok("...after the load binding, before the POD gate and before the sheet write",
		at(STATUS_ROUTE, "resolveLoadBinding(") > -1 &&
		at(STATUS_ROUTE, "resolveLoadBinding(") < at(STATUS_ROUTE, STATUS_CALL) &&
		at(STATUS_ROUTE, STATUS_CALL) < at(STATUS_ROUTE, "POD_REQUIRED") &&
		at(STATUS_ROUTE, STATUS_CALL) < at(STATUS_ROUTE, "spreadsheets.values.batchUpdate"));
	ok("POST /api/driver/respond passes the BOUND row (snapshot.row) and returns on refusal",
		RESPOND_ROUTE.includes(RESPOND_CALL));
	ok("...after the load binding, before the period guard and before the first write",
		at(RESPOND_ROUTE, "resolveLoadBinding(") > -1 &&
		at(RESPOND_ROUTE, "resolveLoadBinding(") < at(RESPOND_ROUTE, RESPOND_CALL) &&
		at(RESPOND_ROUTE, RESPOND_CALL) < at(RESPOND_ROUTE, "dispatchWriteBlocker(") &&
		at(RESPOND_ROUTE, RESPOND_CALL) < at(RESPOND_ROUTE, "insertLoadResponse.run("));

	// --- the bound copy must name the acting driver (PUT /api/driver/status) ---
	// That route lets a Driver pick WHICH copy of a duplicated id to write. Safe
	// only while the bottom row the guard judges names them — and a cancelled
	// bottom copy is no longer hidden from the guard.
	{
		const { fn, audits } = buildOthersRow();
		const res = fakeRes();
		ok("a Driver writing a copy that names ANOTHER driver → 403 ROW_NOT_ASSIGNED",
			fn(asRole("Driver"), res, RAW_HEADERS, ["7052901", "Deshorn King", "Delivered"], "Howard Reddie", "status_update_blocked", "7052901") === true &&
			res.statusCode === 403 && res.body.code === "ROW_NOT_ASSIGNED");
		ok("...and audited under status_update_blocked", audits.length === 1 && audits[0].code === "ROW_NOT_ASSIGNED");
	}
	{
		const { fn } = buildOthersRow();
		ok("a copy with a BLANK Driver cell is refused too (nobody's row is not yours)",
			fn(asRole("Driver"), fakeRes(), RAW_HEADERS, ["1", "", "Dispatched"], "Howard Reddie", "a", "1") === true);
		ok("7052901: the live copy names its own driver — allowed",
			fn(asRole("Driver"), fakeRes(), RAW_HEADERS, ["7052901", "Howard Reddie", "In Transit"], "Howard Reddie", "a", "7052901") === false);
		ok("case and whitespace are folded (normalizeDriverName), not a new comparison",
			fn(asRole("Driver"), fakeRes(), RAW_HEADERS, ["1", "  howard   REDDIE ", "In Transit"], "Howard Reddie", "a", "1") === false);
		ok('whole-name compare: "Shorn King" does not own a row naming "Deshorn King"',
			fn(asRole("Driver"), fakeRes(), RAW_HEADERS, ["1", "Deshorn King", "In Transit"], "Shorn King", "a", "1") === true);
		ok("Super Admin and Dispatcher are not refused by this rule",
			fn(asRole("Super Admin"), fakeRes(), RAW_HEADERS, ["1", "Deshorn King", "x"], "", "a", "1") === false &&
			fn(asRole("Dispatcher"), fakeRes(), RAW_HEADERS, ["1", "Deshorn King", "x"], "", "a", "1") === false);
	}
	const OTHERS_CALL = 'if (sentIfDriverWriteOnOthersRow(req, res, headers, dataRows[rowIndex - 2], driverName, "status_update_blocked", loadId)) return;';
	ok("PUT /api/driver/status checks the bound copy's driver, after the cancelled check, before the POD gate and the write",
		STATUS_ROUTE.includes(OTHERS_CALL) &&
		at(STATUS_ROUTE, STATUS_CALL) < at(STATUS_ROUTE, OTHERS_CALL) &&
		at(STATUS_ROUTE, OTHERS_CALL) < at(STATUS_ROUTE, "POD_REQUIRED") &&
		at(STATUS_ROUTE, OTHERS_CALL) < at(STATUS_ROUTE, "spreadsheets.values.batchUpdate"));

	// --- POST /api/driver/respond is role-gated ---
	ok("POST /api/driver/respond is requireRole-gated (Investor refused), mounted before the limiter",
		SRC.includes('app.post("/api/driver/respond", requireRole("Super Admin", "Dispatcher", "Driver"), driverWriteLimiter,') &&
		!SRC.includes('app.post("/api/driver/respond", requireAuth'));

	// =========================================================================
	console.log("\n§6  DISCRIMINATION — each mutant must be caught by an assertion above");
	// A guard test that still passes against a defanged guard is worse than none.
	// =========================================================================
	const JT_CATCH = 'catch (err) { return ownershipUnverified(targetLid, "Job Tracking read failed", err); }';
	ok("(mutation anchor present)", GUARD_SRC.includes(JT_CATCH));

	const failOpen = buildGuard({ guardSrc: GUARD_SRC.replace(JT_CATCH, "catch { return true; }"), sheetThrows: SHEETS_DOWN }).fn;
	const foStranger = await failOpen("564157463", "Shorn King");
	ok("MUTANT fail-open (`catch { return true; }`): §1's null assertion flips — and a STRANGER is admitted",
		foStranger === true && foStranger !== null);
	ok("MUTANT fail-open: at a real call site the stranger PROCEEDS",
		runSite(lines[callSites[0] + 1], lines[callSites[0] + 2], foStranger).proceeded === true);

	const legacy = buildGuard({ guardSrc: GUARD_SRC.replace(JT_CATCH, "catch { return false; }"), sheetThrows: SHEETS_DOWN }).fn;
	const legacyAnswer = await legacy("564157463", "Deshorn King");
	const legacySite = runSite(lines[callSites[0] + 1], lines[callSites[0] + 2], legacyAnswer);
	ok("MUTANT the original bug (`catch { return false; }`): §1 flips, and the owner is told " +
		"\"not assigned to you\" with a 403 the upload client never retries",
		legacyAnswer === false && legacySite.res.statusCode === 403 && /not assigned/.test(legacySite.res.body.error));

	const lenientGuard = buildGuard({
		guardSrc: GUARD_SRC.replace("getDeletedLoadIds({ strict: true })", "getDeletedLoadIds()"),
		deletedThrows: DB_DOWN,
	}).fn;
	ok("MUTANT lenient deleted_loads read: the soft-deleted load's driver is ADMITTED when that read fails",
		(await lenientGuard("209875716", "Deshorn King")) === true);

	const truthySentinel = buildGuard({
		unverifiedSrc: UNVERIFIED_SRC.replace("return null;", "return { unverified: true };"),
		sheetThrows: SHEETS_DOWN,
	}).fn;
	const truthy = await truthySentinel("564157463", "Shorn King");
	ok("MUTANT truthy sentinel: the falsy assertion flips — and at a call site the stranger PROCEEDS",
		!truthy === false && runSite(lines[callSites[0] + 1], lines[callSites[0] + 2], truthy).proceeded === true);

	const strictEq = lines[callSites[0] + 2].replace("if (!owned)", "if (owned === false)");
	ok("MUTANT `if (owned === false)` with the 503 line gone: §3's shape check flips, and null PROCEEDS",
		!REFUSE_LINE.test(strictEq) && runSite("", strictEq, null).proceeded === true);

	const noColumnsFalse = buildGuard({
		guardSrc: GUARD_SRC.replace(
			'return ownershipUnverified(targetLid, "Job Tracking has no Driver / Load ID column", null);', "return false;"),
		sheet: { headers: ["Load ID"], data: ROWS },
	}).fn;
	ok("MUTANT missing-column → false: §1's null assertion flips",
		(await noColumnsFalse("564157463", "Deshorn King")) === false);

	const ROLE_LINE = 'if (req.session?.user?.role !== "Driver") return false;';
	const STATUS_LINE = /if \(!CANCELED_STATUS_RE\.test\([^\n]+\) return false;/;
	ok("(cancelled-row mutation anchors present)",
		CANCELLED_WRITE_SRC.includes(ROLE_LINE) && STATUS_LINE.test(CANCELLED_WRITE_SRC));
	const anyRole = buildCancelledWrite(CANCELLED_WRITE_SRC.replace(ROLE_LINE, "")).fn;
	ok("MUTANT Driver-only check dropped: a Dispatcher is refused — §5's role assertion flips",
		anyRole(asRole("Dispatcher"), fakeRes(), RAW_HEADERS, ["1", "", "Cancelled"], "a", "1") === true);
	const privateList = buildCancelledWrite(CANCELLED_WRITE_SRC, "const CANCELED_STATUS_RE = /^cancelled$/i;").fn;
	ok('MUTANT a private spelling list (/^cancelled$/): "canceled" slips through — §5 flips',
		privateList(asRole("Driver"), fakeRes(), RAW_HEADERS, ["1", "x", "canceled"], "a", "1") === false);
	const statusBlind = buildCancelledWrite(CANCELLED_WRITE_SRC.replace(STATUS_LINE, "return false;")).fn;
	ok("MUTANT status never read: the cancelled row is written — §5's refusal flips",
		statusBlind(asRole("Driver"), fakeRes(), RAW_HEADERS, ["1", "x", "Cancelled"], "a", "1") === false);

	const MATCH_LINE = "if (onRow && onRow === normalizeDriverName(driverName)) return false;";
	ok("(driver-match mutation anchor present)", OTHERS_ROW_SRC.includes(MATCH_LINE));
	const anyCopy = buildOthersRow(OTHERS_ROW_SRC.replace(MATCH_LINE, "return false;")).fn;
	ok("MUTANT driver match removed: a Driver rewrites another driver's copy — §5 flips",
		anyCopy(asRole("Driver"), fakeRes(), RAW_HEADERS, ["1", "Deshorn King", "Delivered"], "Howard Reddie", "a", "1") === false);
	const substring = buildOthersRow(OTHERS_ROW_SRC.replace(MATCH_LINE,
		"if (onRow && onRow.includes(normalizeDriverName(driverName))) return false;")).fn;
	ok('MUTANT substring compare: "Shorn King" passes on "Deshorn King"\'s row — §5 flips',
		substring(asRole("Driver"), fakeRes(), RAW_HEADERS, ["1", "Deshorn King", "x"], "Shorn King", "a", "1") === false);

	const netLess = runSite("", lines[callSites[0] + 2], null);
	ok("SAFETY NET (by design, not a mutant): a call site that LOST its 503 line still refuses a " +
		"read failure — with the old 403, never by admitting",
		!netLess.proceeded && netLess.res.statusCode === 403);

	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack || err);
	process.exit(1);
});
