#!/usr/bin/env node
/**
 * Receipts on recently delivered loads — the SERVER rule and the gate on
 * POST /api/expenses.
 *
 * WHY THIS EXISTS. A driver could not attach fuel receipts to loads he had
 * already delivered, so dispatch keyed them in. The owner approved "last 7 days"
 * (2026-09-23): a driver may add a receipt to an ACTIVE load, or to one DELIVERED
 * WITHIN THE LAST 7 DAYS. Until then the driver app's active-only form was the
 * whole rule — the route itself checked ownership only, so ANY load naming the
 * driver took a receipt, in any status, at any age. The rule now lives in
 * lib/expense-window.js and is ENFORCED on the route for the Driver role.
 *
 * THE DECISIONS PINNED HERE (reasoning in lib/expense-window.js):
 *   • 7 days is ELAPSED time, 7 × 24 h, INCLUSIVE: open at exactly +7 d, closed
 *     1 ms later. Not Central calendar days.
 *   • "Delivered at" = when the load ENTERED Delivered / Completed / POD Received
 *     in load_status_history (the driver's tap) — not the latest completed row.
 *   • No recorded delivery time → NOT eligible ('unknown').
 *   • Cancelled → never eligible.
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 expenseWindow() — day 0, day 7, 7 d + 1 ms, day 8, missing, cancelled
 *   §2 deliveredAtFromHistory() — the entry, reverts, off-record runs, UTC stamps
 *   §3 bestExpenseWindow() and refusalMessage()
 *   §4 sentIfDriverExpenseWindowClosed(), LIFTED FROM server.js and executed with
 *      its two reads injected — every case a driver can reach
 *   §5 POST /api/expenses wiring: the gate is called after the ownership check
 *      and before the duplicate checks and every write; its line is executed
 *   §6 GET /api/driver/:driverName: withExpenseWindows(), lifted and executed, and
 *      the route ships it — and it agrees with the gate on every fixture load
 *   §7 DISCRIMINATION — mutants of the lib, the gate and the route; each must be
 *      caught by an assertion above, or that assertion is decorative
 *   §8 LOAD_REQUIRED: a Driver's receipt must name its load. The route's Driver
 *      checks are replayed with no load / "#" — before this they all stood aside
 *      and the receipt reached the write
 *   §9 the gate as production feeds it: the fixture sheet run through the REAL
 *      deduplicateLoads() first, as getJobTrackingCached() does
 *
 * ⚠️ SEVERAL FIXTURE ROWS SHARE A LOAD ID (7052901, 100007, 100012). Production
 * never hands the gate such a list: getJobTrackingCached() keeps only the BOTTOM
 * row per id. §4/§6 feed them un-deduplicated on purpose, to pin the defensive
 * list handling; §9 is what the gate actually sees.
 *
 * SERVER_JS=<path> points the run at another copy of server.js (e.g. the pre-fix
 * base) to show the §8 assertions fail there.
 *
 * Pure: no server, no app.db, no network, no fixtures on disk.
 *
 * Run: node scripts/test-expense-load-window.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");
const LIB_PATH = path.join(ROOT, "lib", "expense-window.js");
const LIB_SRC = fs.readFileSync(LIB_PATH, "utf8");
const lib = require(LIB_PATH);
// THE load-id fold server.js requires from here — injected into the lifted helpers.
const { normalizeLoadId } = require(path.join(ROOT, "lib", "ratecon-load"));

let pass = 0;
let fail = 0;
function ok(name, cond) {
	if (cond) { pass++; return true; }
	fail++;
	console.log(`FAIL  ${name}`);
	return false;
}
function section(t) { console.log(`\n${t}`); }

// --- lifting ---------------------------------------------------------------
// A `function name(` out of server.js, without booting the app. Keeps a leading
// `async ` (an `await` inside is a SyntaxError without it), paren-matches the
// parameter list first (a default like `now = Date.now()` has parens), then
// brace-counts the body.
function liftFn(name, src = SRC) {
	const needle = `\nfunction ${name}(`;
	const asyncNeedle = `\nasync function ${name}(`;
	const hits = src.split(needle).length - 1 + src.split(asyncNeedle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	let a = src.indexOf(asyncNeedle);
	if (a < 0) a = src.indexOf(needle);
	a += 1;
	let p = src.indexOf("(", src.indexOf(`function ${name}(`, a));
	for (let d = 0; p < src.length; p++) {
		if (src[p] === "(") d++;
		else if (src[p] === ")") { d--; if (d === 0) break; }
	}
	let depth = 0;
	for (let i = src.indexOf("{", p); i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(a, i + 1); }
	}
	throw new Error(`unbalanced braces in ${name}()`);
}

// A route registration, anchored at a line start (comments quote routes).
function routeSource(verb, routePath, src = SRC) {
	const nl = src.indexOf(`\napp.${verb}("${routePath}"`);
	if (nl < 0) throw new Error(`route not found: ${verb.toUpperCase()} ${routePath}`);
	let depth = 0;
	for (let j = src.indexOf("(", nl + 1); j < src.length; j++) {
		if (src[j] === "(") depth++;
		else if (src[j] === ")") { depth--; if (depth === 0) return src.slice(nl + 1, j + 1); }
	}
	throw new Error(`unbalanced parens extracting ${routePath}`);
}

// Replace exactly one occurrence, or fail loudly: a mutant whose target is gone
// would run the ORIGINAL code and "pass", proving nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) throw new Error(`mutant target found ${n}× (expected 1): ${from.slice(0, 70)}`);
	return src.replace(from, to);
}

// The lib, rebuilt from (possibly mutated) source.
function buildLib(src = LIB_SRC) {
	const module = { exports: {} };
	new Function("module", "exports", "require", src)(module, module.exports, require);
	return module.exports;
}

const FINDCOL_SRC = liftFn("findCol");
const NORM_SRC = liftFn("normalizeDriverName");
const GATE_SRC = liftFn("sentIfDriverExpenseWindowClosed");
const ANNOTATE_SRC = liftFn("withExpenseWindows");
// Soft: absent from pre-fix server.js, and §8 must REPORT that, not crash on it.
const softLift = (name) => { try { return liftFn(name); } catch (e) { return null; } };
const LOAD_MISSING_SRC = softLift("sentIfDriverExpenseLoadMissing");
const OWNERSHIP_503_SRC = softLift("sentIfLoadOwnershipUnverified");
const DEDUPE_SRC = softLift("deduplicateLoads");

// sentIfDriverExpenseLoadMissing, built from (possibly mutated) source — or, when
// server.js has none, a stand-in that never answers (which is what the absence means).
function buildLoadMissing(src = LOAD_MISSING_SRC) {
	if (!src) return () => false;
	return new Function("normalizeLoadId", `"use strict";\n${src}\nreturn sentIfDriverExpenseLoadMissing;`)(normalizeLoadId);
}

// --- fixtures --------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-23T17:00:00Z");
// load_status_history.changed_at, as strftime('%Y-%m-%dT%H:%M:%SZ', …) serves it.
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const ago = (days) => stamp(NOW - days * DAY);

// Production's Job Tracking header names (the ones these checks read).
const HEADERS = ["Load ID", "Driver", "Job Status", "Status Update Date", "Pickup Address"];
const row = (id, driver, status) => ({ "Load ID": id, Driver: driver, "Job Status": status, "Status Update Date": "", "Pickup Address": "" });
const SHEET = {
	headers: HEADERS,
	data: [
		row("100001", "Deshorn King", "In Transit"),            // active
		row("100002", "Deshorn King", "Delivered"),             // delivered 2 d ago → open
		row("100003", "Deshorn King", "Delivered"),             // delivered 8 d ago → closed
		row("100004", "Deshorn King", "Delivered"),             // no history → unknown
		row("100005", "Deshorn King", "Cancelled"),             // cancelled → never
		// ⚠️ The three shared-id pairs below (7052901, 100007, 100012) are what the
		// SHEET can hold, not what the gate is handed: getJobTrackingCached() keeps
		// only the bottom row of each (deduplicateLoads()). §4/§6 feed them raw to
		// pin the defensive list handling; §9 runs them through the real dedup.
		row("7052901", "Howard Reddie", "In Transit"),          // live row…
		row("#7052901", "Howard Reddie", "Cancelled"),          // …above a cancelled copy (the bottom row wins)
		row("100007", "Shorn King", "In Transit"),              // ANOTHER driver's active row…
		row("100007", "Deshorn King", "Delivered"),             // …above ours, delivered 30 d ago
		row("100008", "Deshorn King", "Unassigned"),            // neither active nor delivered
		row("100009", "Deshorn King", "Completed"),             // delivered 9 d ago, "Completed" 1 d ago
		row("100010", "Deshorn King", "Delivered"),             // reverted and re-delivered 1 d ago
		row("100011", "Deshorn King", "Delivered"),             // exactly 7 d ago
		row("100012", "Deshorn King", "Delivered"),             // one id on TWO of our rows:
		row("#100012", "Deshorn King", "In Transit"),           // …a stale row above a live one
	],
};
const hist = (load_id, old_status, new_status, changed_at) => ({ load_id, old_status, new_status, changed_at });
const HISTORY = [
	hist("100002", "At Receiver", "Delivered", ago(2)),
	hist("100003", "At Receiver", "Delivered", ago(8)),
	hist("100005", "At Receiver", "Delivered", ago(1)),
	hist("100005", "Delivered", "Cancelled", ago(0.5)),
	hist("100007", "At Receiver", "Delivered", ago(30)),
	hist("100009", "At Receiver", "Delivered", ago(9)),
	hist("100009", "Delivered", "Completed", ago(1)),
	hist("100010", "At Receiver", "Delivered", ago(20)),
	hist("100010", "Delivered", "In Transit", ago(19)),
	hist("100010", "In Transit", "Delivered", ago(1)),
	hist("100011", "At Receiver", "Delivered", ago(7)),
	hist("100012", "At Receiver", "Delivered", ago(30)),
];

// A fake better-sqlite3 handle over HISTORY that records every read.
function fakeDb({ throws = null, history = HISTORY } = {}) {
	const reads = [];
	return {
		reads,
		prepare(sql) {
			return {
				all(...args) {
					reads.push({ sql, args });
					if (throws) throw throws;
					if (!/FROM load_status_history/.test(sql)) throw new Error(`unexpected query: ${sql}`);
					const ids = new Set(args.map(String));
					return history
						.filter((h) => ids.has(h.load_id))
						.sort((x, y) => Date.parse(x.changed_at) - Date.parse(y.changed_at))
						.map((h) => ({ ...h }));
				},
			};
		},
	};
}

function fakeRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, sends: 0,
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; this.sends++; return this; },
	};
}
const asRole = (role, driverName = role === "Driver" ? "Deshorn King" : null) =>
	({ session: { user: { role, driverName } } });

// The gate, built from (possibly mutated) server.js source, with its reads and
// its clock injected. `sheet` resolves, `sheetThrows` rejects.
function buildGate({ gateSrc = GATE_SRC, libObj = lib, sheet = SHEET, sheetThrows = null, db = fakeDb(), now = NOW, loadMissing = buildLoadMissing() } = {}) {
	const logs = [];
	let sheetReads = 0;
	const getJobTrackingCached = async () => { sheetReads++; if (sheetThrows) throw sheetThrows; return sheet; };
	class FixedDate extends Date { static now() { return now; } }
	const fn = new Function(
		"getJobTrackingCached", "db", "expenseWindowRule", "normalizeLoadId", "sentIfDriverExpenseLoadMissing", "console", "Date",
		`"use strict";\n${FINDCOL_SRC}\n${NORM_SRC}\n${gateSrc}\nreturn sentIfDriverExpenseWindowClosed;`,
	)(getJobTrackingCached, db, libObj, normalizeLoadId, loadMissing, { warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")), log() {} }, FixedDate);
	return { gate: fn, logs, db, sheetReads: () => sheetReads };
}

async function runGate(opts, role, loadId, driverName) {
	const built = buildGate(opts);
	const res = fakeRes();
	const req = asRole(role, driverName);
	const answered = await built.gate(req, res, loadId, driverName !== undefined ? driverName : req.session.user.driverName);
	return { answered, res, ...built };
}

// ExpenseForm's own "the photo was the problem" test — a refusal must never
// match it, or the app tells the driver to retake a photo that was never the issue.
// The regex lives in client/src/lib/uploadFailure.js; ExpenseForm must still be
// the one using it, or this would pin a rule the form no longer applies.
const FORM_SRC = fs.readFileSync(path.join(ROOT, "client", "src", "components", "driver", "ExpenseForm.vue"), "utf8");
const FAILURE_LIB_SRC = fs.readFileSync(path.join(ROOT, "client", "src", "lib", "uploadFailure.js"), "utf8");
if (!/^import \{[^}]*\bwithRetakeHint\b[^}]*\} from '\.\.\/\.\.\/lib\/uploadFailure'/m.test(FORM_SRC) || !/\bwithRetakeHint\(err,/.test(FORM_SRC)) {
	console.error("FAIL  ExpenseForm.vue no longer decides its photo hint through lib/uploadFailure.js");
	process.exit(1);
}
const PHOTO_RE_SRC = (FAILURE_LIB_SRC.match(/export const PHOTO_FAILURE_RE = (\/.+\/[a-z]*)/) || [])[1];
if (!PHOTO_RE_SRC) { console.error("FAIL  could not locate PHOTO_FAILURE_RE in client/src/lib/uploadFailure.js"); process.exit(1); }
const PHOTO_FAILURE_RE = new Function(`return ${PHOTO_RE_SRC}`)();

(async () => {
	// =========================================================================
	section("§1  expenseWindow() — the named cases");
	// =========================================================================
	const T = Date.parse("2026-09-16T15:00:00Z");
	const judge = (status, deliveredAt, now) => lib.expenseWindow({ status, deliveredAt, now });
	const at = (ms) => judge("Delivered", "2026-09-16T15:00:00Z", ms);

	let w = at(T);
	ok("day 0 — delivered this instant: OPEN", w.eligible === true && w.state === "open");
	ok("...and it says when it closes: exactly 7 × 24 h later", w.closesAt === "2026-09-23T15:00:00.000Z" && w.deliveredAt === "2026-09-16T15:00:00.000Z");
	ok("day 3: open", at(T + 3 * DAY).eligible === true);
	w = at(T + 7 * DAY);
	ok("day 7 EXACTLY (7 × 24 h to the millisecond): still OPEN — the boundary is INCLUSIVE", w.eligible === true && w.state === "open");
	w = at(T + 7 * DAY + 1);
	ok("day 7 + 1 ms: CLOSED", w.eligible === false && w.state === "closed" && w.closesAt === "2026-09-23T15:00:00.000Z");
	ok("day 8: CLOSED", at(T + 8 * DAY).eligible === false && at(T + 8 * DAY).state === "closed");
	ok("a delivery 'in the future' (clock skew) is inside the window, not outside it", at(T - 60 * 1000).eligible === true);
	ok("ELAPSED time, not Central calendar days: 10:00 AM CDT on day 7 is the end, not midnight",
		at(Date.parse("2026-09-23T15:00:00Z")).eligible === true && at(Date.parse("2026-09-23T15:00:01Z")).eligible === false);

	for (const missing of [null, undefined, "", "   ", "not a date", "9/16/2026", "9/16/2026 10:00:00", NaN, {}]) {
		const v = judge("Delivered", missing, T);
		ok(`missing / unusable delivery time (${JSON.stringify(missing)}) → NOT eligible, state 'unknown'`,
			v.eligible === false && v.state === "unknown" && v.closesAt === null);
	}
	for (const s of ["Completed", "POD Received", " delivered ", "DELIVERED"]) {
		ok(`"${s}" is a delivered status: open inside the window, closed after`,
			judge(s, "2026-09-16T15:00:00Z", T + DAY).state === "open" && judge(s, "2026-09-16T15:00:00Z", T + 8 * DAY).state === "closed");
	}
	for (const s of ["Cancelled", "canceled", "CANCEL", "  cancelled  "]) {
		const v = judge(s, "2026-09-16T15:00:00Z", T);
		ok(`"${s}" is NEVER eligible — not even with a delivery time from this very instant`,
			v.eligible === false && v.state === "cancelled");
	}
	for (const s of ["Assigned", "Dispatched", "Heading to Shipper", "At Shipper", "Loading", "In Transit", "At Receiver", "Unloading", " in transit "]) {
		const v = judge(s, null, T);
		ok(`"${s}" is active: eligible with no delivery time at all`, v.eligible === true && v.state === "active");
	}
	for (const s of ["", "Unassigned", "Picked Up", "Awaiting Rate Con", "In-Transit", "Delivered!"]) {
		const v = judge(s, "2026-09-16T15:00:00Z", T);
		ok(`"${s}" is neither active nor delivered → not eligible ('none')`, v.eligible === false && v.state === "none");
	}
	ok("`now` defaults to the current time (a delivery 1 h ago is open)",
		lib.expenseWindow({ status: "Delivered", deliveredAt: new Date(Date.now() - 3600e3).toISOString() }).eligible === true);
	ok("epoch ms and Date objects are accepted for both instants",
		judge("Delivered", T, new Date(T + DAY)).eligible === true);
	ok("the window is the owner's 7 days", lib.EXPENSE_WINDOW_DAYS === 7 && lib.EXPENSE_WINDOW_MS === 7 * DAY);

	// =========================================================================
	section("§2  deliveredAtFromHistory() — WHEN it was delivered");
	// =========================================================================
	const H = (old_status, new_status, changed_at) => ({ old_status, new_status, changed_at });
	ok("no history → null (and so 'unknown')", lib.deliveredAtFromHistory([]) === null && lib.deliveredAtFromHistory(null) === null);
	ok("the driver's tap: At Receiver → Delivered",
		lib.deliveredAtFromHistory([H("In Transit", "At Receiver", "2026-09-16T14:00:00Z"), H("At Receiver", "Delivered", "2026-09-16T15:00:00Z")]) === "2026-09-16T15:00:00.000Z");
	ok("Delivered → Completed ten days later does NOT move it — the ENTRY, not the latest row (no reopening)",
		lib.deliveredAtFromHistory([H("At Receiver", "Delivered", "2026-09-06T15:00:00Z"), H("Delivered", "Completed", "2026-09-16T15:00:00Z")]) === "2026-09-06T15:00:00.000Z");
	ok("reverted out of Delivered → the load is not delivered by the record (null)",
		lib.deliveredAtFromHistory([H("At Receiver", "Delivered", "2026-09-06T15:00:00Z"), H("Delivered", "In Transit", "2026-09-07T15:00:00Z")]) === null);
	ok("reverted and delivered AGAIN → the second delivery",
		lib.deliveredAtFromHistory([H("At Receiver", "Delivered", "2026-09-06T15:00:00Z"), H("Delivered", "In Transit", "2026-09-07T15:00:00Z"), H("In Transit", "Delivered", "2026-09-10T15:00:00Z")]) === "2026-09-10T15:00:00.000Z");
	ok("delivered OFF the record (history's first word is Delivered → Completed) → null, never the later row",
		lib.deliveredAtFromHistory([H("In Transit", "At Receiver", "2026-09-05T15:00:00Z"), H("Delivered", "Completed", "2026-09-16T15:00:00Z")]) === null);
	ok("…while a row's own old_status wins over the previous row (the sheet said In Transit at the write)",
		lib.deliveredAtFromHistory([H("At Receiver", "Delivered", "2026-09-01T15:00:00Z"), H("In Transit", "Delivered", "2026-09-12T15:00:00Z")]) === "2026-09-12T15:00:00.000Z");
	ok("a blank old_status falls back to the previous row",
		lib.deliveredAtFromHistory([H("", "Delivered", "2026-09-12T15:00:00Z")]) === "2026-09-12T15:00:00.000Z" &&
		lib.deliveredAtFromHistory([H("At Receiver", "Delivered", "2026-09-01T15:00:00Z"), H("", "POD Received", "2026-09-12T15:00:00Z")]) === "2026-09-01T15:00:00.000Z");
	ok("cancelled after delivery → null", lib.deliveredAtFromHistory([H("At Receiver", "Delivered", "2026-09-12T15:00:00Z"), H("Delivered", "Cancelled", "2026-09-13T15:00:00Z")]) === null);
	ok("rows out of order are put in time order",
		lib.deliveredAtFromHistory([H("Delivered", "Completed", "2026-09-16T15:00:00Z"), H("At Receiver", "Delivered", "2026-09-06T15:00:00Z")]) === "2026-09-06T15:00:00.000Z");
	ok("equal stamps (one-second resolution) keep the caller's `id ASC` order",
		lib.deliveredAtFromHistory([H("At Receiver", "Delivered", "2026-09-06T15:00:00Z"), H("Delivered", "In Transit", "2026-09-06T15:00:00Z")]) === null &&
		lib.deliveredAtFromHistory([H("Delivered", "In Transit", "2026-09-06T15:00:00Z"), H("In Transit", "Delivered", "2026-09-06T15:00:00Z")]) === "2026-09-06T15:00:00.000Z");
	ok("a ZONE-LESS SQLite stamp is UTC, never this machine's local time",
		lib.deliveredAtFromHistory([H("At Receiver", "Delivered", "2026-09-16 15:00:00")]) === "2026-09-16T15:00:00.000Z");
	ok("a row with no usable time is dropped — which can only move the answer to null",
		lib.deliveredAtFromHistory([H("At Receiver", "Delivered", "yesterday"), H("Delivered", "Completed", "2026-09-16T15:00:00Z")]) === null);
	ok("camelCase rows ({ oldStatus, newStatus, changedAt }) read the same",
		lib.deliveredAtFromHistory([{ oldStatus: "At Receiver", newStatus: "Delivered", changedAt: "2026-09-16T15:00:00Z" }]) === "2026-09-16T15:00:00.000Z");

	// =========================================================================
	section("§3  bestExpenseWindow() and the refusal sentence");
	// =========================================================================
	const V = (state, eligible = state === "active" || state === "open") => ({ state, eligible });
	ok("(defensive — production passes one verdict) any eligible verdict opens the id", lib.bestExpenseWindow([V("cancelled"), V("active")]).state === "active");
	ok("open beats closed; closed beats unknown; unknown beats none; none beats cancelled",
		lib.bestExpenseWindow([V("closed"), V("open")]).state === "open" &&
		lib.bestExpenseWindow([V("unknown"), V("closed")]).state === "closed" &&
		lib.bestExpenseWindow([V("none"), V("unknown")]).state === "unknown" &&
		lib.bestExpenseWindow([V("cancelled"), V("none")]).state === "none");
	ok("no rows → null; junk entries are ignored", lib.bestExpenseWindow([]) === null && lib.bestExpenseWindow([null, { state: "bogus" }]) === null);
	const closedWin = at(T + 8 * DAY);
	const sentences = {
		closed: lib.refusalMessage(closedWin, "564157463"),
		unknown: lib.refusalMessage(judge("Delivered", null, T), "564157463"),
		cancelled: lib.refusalMessage(judge("Cancelled", null, T), "564157463"),
		none: lib.refusalMessage(judge("Unassigned", null, T), "564157463"),
	};
	ok("closed: names the load and the closing time in CENTRAL, with its zone label",
		sentences.closed.includes("load 564157463") && sentences.closed.includes("Sep 23, 2026, 10:00 AM CDT") && /7 days after it was delivered/.test(sentences.closed));
	ok("unknown: says there is no record of the delivery", /no record of when load 564157463 was delivered/.test(sentences.unknown));
	ok("cancelled: says so", /^Load 564157463 was cancelled/.test(sentences.cancelled));
	for (const [k, s] of Object.entries(sentences)) {
		ok(`${k}: tells the driver what to do (dispatch)`, /dispatch/i.test(s));
		ok(`${k}: contains no word the app reads as "the PHOTO was the problem"`, !PHOTO_FAILURE_RE.test(s));
	}
	ok("no load id → 'this load'", /^Receipts for this load/.test(lib.refusalMessage(closedWin, "")));

	// =========================================================================
	section("§4  the gate — sentIfDriverExpenseWindowClosed(), lifted from server.js");
	// =========================================================================
	const proceeds = (r) => r.answered === false && r.res.sends === 0;
	const refused = (r, reason) => r.answered === true && r.res.statusCode === 403 && r.res.body.code === "EXPENSE_WINDOW_CLOSED" && r.res.body.reason === reason;

	let r = await runGate({}, "Driver", "100001");
	ok("ACTIVE load → the driver's receipt proceeds, nothing sent", proceeds(r));
	ok("...and load_status_history was never read (an active load never depends on it)", r.db.reads.length === 0);
	r = await runGate({}, "Driver", "100002");
	ok("delivered 2 days ago → proceeds", proceeds(r));
	ok("...after exactly ONE indexed history read, for that load id", r.db.reads.length === 1 && r.db.reads[0].args.join() === "100002");
	r = await runGate({}, "Driver", "100011");
	ok("delivered EXACTLY 7 days ago → proceeds (inclusive)", proceeds(r));
	r = await runGate({ now: NOW + 1000 }, "Driver", "100011");
	ok("...and one second later → refused, reason 'closed'", refused(r, "closed"));
	r = await runGate({}, "Driver", "100003");
	ok("delivered 8 days ago → 403 EXPENSE_WINDOW_CLOSED, reason 'closed'", refused(r, "closed"));
	ok("...carrying the delivery and closing times", r.res.body.deliveredAt === new Date(NOW - 8 * DAY).toISOString() && r.res.body.closesAt === new Date(NOW - DAY).toISOString());
	ok("...and the driver-facing sentence", /could be added until .+\. Ask dispatch to add this one\.$/.test(r.res.body.error) && r.res.body.error.includes("load 100003"));
	r = await runGate({}, "Driver", "100004");
	ok("delivered with NO recorded time → refused, reason 'unknown'", refused(r, "unknown"));
	r = await runGate({}, "Driver", "100005");
	ok("CANCELLED (even though delivered 1 day before) → refused, reason 'cancelled'", refused(r, "cancelled"));
	r = await runGate({}, "Driver", "7052901", "Howard Reddie");
	ok("(defensive, un-deduplicated input) a live row in the list opens the id — §9 shows production never hands the gate this list", proceeds(r));
	r = await runGate({}, "Driver", "100007");
	ok("(defensive) another driver's ACTIVE row on the same id does not open OUR delivered-30-days-ago row", refused(r, "closed"));
	r = await runGate({}, "Driver", "100008");
	ok("'Unassigned' → refused, reason 'none'", refused(r, "none"));
	r = await runGate({}, "Driver", "100009");
	ok("delivered 9 d ago and moved to 'Completed' 1 d ago → still CLOSED (the later row does not reopen it)", refused(r, "closed"));
	r = await runGate({}, "Driver", "100010");
	ok("reverted, then delivered again 1 d ago → open again", proceeds(r));
	for (const spelling of ["#100002", " 100002 ", "#100002\t"]) {
		r = await runGate({}, "Driver", spelling);
		ok(`load id spelling ${JSON.stringify(spelling)} is folded like the ownership check folds it`, proceeds(r));
	}
	r = await runGate({}, "Driver", "100003", "  deshorn   KING ");
	ok("the driver name is folded like the ownership check folds it (still refused on 100003)", refused(r, "closed"));

	for (const role of ["Super Admin", "Dispatcher"]) {
		r = await runGate({}, role, "100003");
		ok(`${role} filing on a load closed 1 day ago → untouched (false), nothing sent`, proceeds(r));
		ok(`...and not even a sheet read — the gate is Driver-only`, r.sheetReads() === 0);
	}
	for (const none of ["", "#", "  # "]) {
		r = await runGate({}, "Driver", none);
		ok(`a Driver with no usable load id (${JSON.stringify(none)}) is refused HERE too, 400 LOAD_REQUIRED — never admitted — with no read`,
			r.answered === true && r.res.statusCode === 400 && r.res.body && r.res.body.code === "LOAD_REQUIRED" && r.sheetReads() === 0);
	}

	const SHEETS_DOWN = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
	r = await runGate({ sheetThrows: SHEETS_DOWN }, "Driver", "100001");
	ok("Job Tracking read FAILS → 503 EXPENSE_WINDOW_UNVERIFIED, retryable, Retry-After — never proceeds",
		r.answered === true && r.res.statusCode === 503 && r.res.body.code === "EXPENSE_WINDOW_UNVERIFIED" &&
		r.res.body.retryable === true && r.res.headers["retry-after"] === "5");
	ok("...and it is logged with the reason", r.logs.some((l) => /could not check load "100001": Job Tracking read failed — socket hang up/.test(l)));
	r = await runGate({ sheet: { headers: ["Load ID", "Driver"], data: SHEET.data } }, "Driver", "100001");
	ok("a sheet with no status column → 503 (the question cannot be answered), never an admit", r.answered === true && r.res.statusCode === 503);
	const DB_DOWN = Object.assign(new Error("SQLITE_IOERR: disk I/O error"), { code: "SQLITE_IOERR" });
	r = await runGate({ db: fakeDb({ throws: DB_DOWN }) }, "Driver", "100002");
	ok("history read FAILS on a delivered load → 503, never an admit", r.answered === true && r.res.statusCode === 503 && r.res.body.code === "EXPENSE_WINDOW_UNVERIFIED");
	r = await runGate({ db: fakeDb({ throws: DB_DOWN }) }, "Driver", "100001");
	ok("...but an ACTIVE load's receipt does not depend on that read", proceeds(r));
	r = await runGate({}, "Driver", "999999");
	ok("named on no row (reassigned since the ownership check) → 403 not assigned",
		r.answered === true && r.res.statusCode === 403 && r.res.body.error === "This load is not assigned to you");
	r = await runGate({}, "Driver", "9".repeat(5000));
	ok("a caller-supplied id is capped in the log line", r.logs.every((l) => l.length < 200));
	{
		const flip = { headers: ["Load ID", "Driver", "Status Update Date", "Job Status"], data: [{ "Load ID": "100002", Driver: "Deshorn King", "Status Update Date": "09/21/2026 10:00:00", "Job Status": "Delivered" }] };
		r = await runGate({ sheet: flip }, "Driver", "100002");
		ok("the status is read from 'Job Status' even when 'Status Update Date' sorts first (excludeDroppedLoads' pick)", proceeds(r));
	}

	// =========================================================================
	section("§5  POST /api/expenses — the gate is wired, after ownership, before every write");
	// =========================================================================
	const GATE_LINE = "if (await sentIfDriverExpenseWindowClosed(req, res, safeLoadId, driver)) return;";
	// Returns the problems found; [] means wired correctly. A function so the
	// mutants in §7 run the very same check.
	function expenseRouteWiring(src) {
		const problems = [];
		let route;
		try { route = routeSource("post", "/api/expenses", src); } catch (e) { return [e.message]; }
		const lines = route.split("\n").map((l) => l.trim());
		const gateAt = lines.indexOf(GATE_LINE);
		const count = lines.filter((l) => l === GATE_LINE).length;
		if (count !== 1) problems.push(`the gate line appears ${count}× (expected exactly 1)`);
		const firstIdx = (re) => lines.findIndex((l) => re.test(l));
		const owned = firstIdx(/const owned = await loadBelongsToDriver\(safeLoadId, driver\);/);
		const refuse = firstIdx(/^if \(!owned\) return res\.status\(403\)/);
		if (owned < 0 || refuse < 0) problems.push("the ownership check is gone");
		if (gateAt >= 0 && (gateAt < owned || gateAt < refuse)) problems.push("the gate runs BEFORE the ownership check");
		for (const [what, re] of [
			["the receipt-hash duplicate check", /let receiptHash = ""/],
			["the content duplicate check", /findContentDuplicate\(\)/],
			["the image receipt write", /saveReceiptToDisk\(/],
			["the PDF receipt write", /savePdfReceiptToDisk\(/],
			["the expense INSERT", /INSERT INTO expenses/],
		]) {
			const i = firstIdx(re);
			if (i < 0) problems.push(`could not find ${what}`);
			else if (gateAt < 0 || gateAt > i) problems.push(`the gate does not run before ${what}`);
		}
		return problems;
	}
	const wiring = expenseRouteWiring(SRC);
	for (const p of wiring) console.log(`      ${p}`);
	ok("POST /api/expenses calls the gate once, after the ownership check, before the duplicate checks and every write", wiring.length === 0);
	{
		const run = (answered) => new Function("sentIfDriverExpenseWindowClosed", "req", "res", "safeLoadId", "driver",
			`"use strict"; return (async () => { ${GATE_LINE}\n return "PROCEEDED"; })();`)(async () => answered, {}, {}, "1", "d");
		ok("the extracted line RETURNS when the gate has answered", (await run(true)) === undefined);
		ok("...and carries on when it has not", (await run(false)) === "PROCEEDED");
	}
	const callers = SRC.split("\n").filter((l) => l.includes("sentIfDriverExpenseWindowClosed(") && !/^\s*\/\//.test(l) && !/async function sentIfDriverExpenseWindowClosed/.test(l));
	ok("the gate has exactly one caller (this route)", callers.length === 1 && callers[0].trim() === GATE_LINE);

	// =========================================================================
	section("§6  GET /api/driver/:driverName — the verdict the app renders from");
	// =========================================================================
	function buildAnnotate({ annotateSrc = ANNOTATE_SRC, db = fakeDb(), libObj = lib } = {}) {
		const logs = [];
		const fn = new Function("db", "expenseWindowRule", "normalizeLoadId", "console",
			`"use strict";\n${FINDCOL_SRC}\n${annotateSrc}\nreturn withExpenseWindows;`,
		)(db, libObj, normalizeLoadId, { warn: (...a) => logs.push(a.join(" ")), error() {}, log() {} });
		return { fn, logs, db };
	}
	const deepFreeze = (o) => { Object.freeze(o); for (const v of Object.values(o)) if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v); return o; };
	const deshorn = SHEET.data.filter((x) => x.Driver === "Deshorn King");
	const input = deepFreeze(JSON.parse(JSON.stringify(deshorn)));
	const { fn: annotate, db: annDb } = buildAnnotate();
	let out;
	let threw = null;
	try { out = annotate(input, HEADERS, NOW); } catch (e) { threw = e; }
	ok("it never writes to the rows it is handed (deep-frozen input, strict mode — a write would throw)", threw === null);
	ok("it returns NEW row objects, every cell carried over", out && out.length === input.length && out.every((o, i) => o !== input[i] && o["Load ID"] === input[i]["Load ID"] && o["Job Status"] === input[i]["Job Status"]));
	const byId = Object.fromEntries((out || []).map((o) => [o["Load ID"], o._expenseWindow]));
	ok("active → { eligible: true, state: 'active' }", byId["100001"] && byId["100001"].eligible === true && byId["100001"].state === "active");
	ok("delivered 2 d ago → open, with its closing time", byId["100002"].state === "open" && byId["100002"].closesAt === new Date(NOW + 5 * DAY).toISOString());
	ok("delivered 8 d ago → closed", byId["100003"].state === "closed" && byId["100003"].eligible === false);
	ok("no recorded delivery → unknown", byId["100004"].state === "unknown");
	ok("cancelled → cancelled", byId["100005"].state === "cancelled");
	ok("ONE history read for the whole list — not one per load", annDb.reads.length === 1);
	const asked = annDb.reads.length ? annDb.reads[0].args.slice().sort().join() : "";
	ok("...asking only for DELIVERED loads (active ones need no delivery time)",
		asked === ["100002", "100003", "100004", "100007", "100009", "100010", "100011", "100012"].join());
	const both12 = (out || []).filter((o) => o["Load ID"].replace("#", "") === "100012").map((o) => o._expenseWindow.state);
	ok("(defensive, un-deduplicated input) two rows of one id get ONE answer, the gate's ranking",
		both12.length === 2 && both12.every((s) => s === "active"));
	{
		const many = Array.from({ length: 1234 }, (_, i) => row(String(200000 + i), "Deshorn King", "Delivered"));
		const { fn, db } = buildAnnotate();
		fn(many, HEADERS, NOW);
		ok("a long history is read in chunks under SQLite's parameter ceiling", db.reads.length === 3 && db.reads.every((q) => q.args.length <= 500));
	}
	{
		const { fn, logs } = buildAnnotate({ db: fakeDb({ throws: DB_DOWN }) });
		const same = fn(input, HEADERS, NOW);
		ok("a failed history read ships NO verdict rather than a wrong one — the same rows, unannotated",
			same === input && same.every((o) => !("_expenseWindow" in o)));
		ok("...and says so in the log", logs.some((l) => /expense window not attached/.test(l)));
	}
	ok("an empty list is returned as-is", (() => { const e = []; return buildAnnotate().fn(e, HEADERS, NOW) === e; })());

	// The app and the gate must agree on every load: the verdict the phone renders
	// the form from IS the decision the route will make on submit.
	for (const o of out || []) {
		const lid = o["Load ID"];
		const g = await runGate({}, "Driver", lid);
		ok(`agreement on ${lid}: the app ${o._expenseWindow.eligible ? "offers" : "withholds"} the form, and the gate ${g.answered ? "refuses" : "accepts"}`,
			o._expenseWindow.eligible === !g.answered && (g.answered ? g.res.body.reason === o._expenseWindow.state : true));
	}

	const DRIVER_ROUTE = routeSource("get", "/api/driver/:driverName");
	const ANNOTATE_LINE = "filteredLoads = withExpenseWindows(filteredLoads, jobTracking.headers);";
	function driverRouteWiring(route) {
		const problems = [];
		const at = route.indexOf(ANNOTATE_LINE);
		if (at < 0) problems.push("the route never attaches _expenseWindow");
		if (route.split(ANNOTATE_LINE).length - 1 > 1) problems.push("the route attaches it twice");
		const reply = route.indexOf("res.json({");
		if (at > -1 && (reply < 0 || at > reply)) problems.push("…after the response is built");
		if (!/\bloads: filteredLoads,/.test(route)) problems.push("the response no longer ships filteredLoads");
		return problems;
	}
	const dw = driverRouteWiring(DRIVER_ROUTE);
	for (const p of dw) console.log(`      ${p}`);
	ok("GET /api/driver/:driverName attaches the verdict, once, before the response, and ships those rows", dw.length === 0);

	// =========================================================================
	section("§7  DISCRIMINATION — each mutant must be caught");
	// =========================================================================
	// M1 — the whole point: the route without its gate.
	{
		const mutantSrc = mutate(SRC, `\t\tif (await sentIfDriverExpenseWindowClosed(req, res, safeLoadId, driver)) return;\n`, "");
		ok("M1  POST /api/expenses WITHOUT the gate line is caught by §5's wiring check", expenseRouteWiring(mutantSrc).length > 0);
	}
	// M2 — the gate after the receipt is written (a refusal would orphan a file).
	{
		let m = mutate(SRC, `\t\tif (await sentIfDriverExpenseWindowClosed(req, res, safeLoadId, driver)) return;\n`, "");
		m = mutate(m, "\t\t// Best-effort geo enrichment — a failure here must NEVER fail the insert.\n",
			`\t\tif (await sentIfDriverExpenseWindowClosed(req, res, safeLoadId, driver)) return;\n\t\t// Best-effort geo enrichment — a failure here must NEVER fail the insert.\n`);
		ok("M2  the gate moved AFTER the receipt write is caught", expenseRouteWiring(m).length > 0);
	}
	// M3 — a gate that always admits.
	{
		const m = mutate(GATE_SRC, "if (win && win.eligible) return false;", "return false;");
		const g = await runGate({ gateSrc: m }, "Driver", "100003");
		ok("M3  a gate that always admits lets the 8-days-closed load through (so §4 would fail)", proceeds(g));
	}
	// M4 — a gate that forgets it is Driver-only.
	{
		const m = mutate(GATE_SRC, `if (req.session?.user?.role !== "Driver") return false;`, "");
		const g = await runGate({ gateSrc: m }, "Dispatcher", "100003", "Deshorn King");
		ok("M4  a gate applied to every role refuses the dispatcher (so §4's admin case would fail)", g.answered === true);
	}
	// M5 — an EXCLUSIVE boundary.
	{
		const m = buildLib(mutate(LIB_SRC, "const open = nowMs <= closesMs;", "const open = nowMs < closesMs;"));
		ok("M5  an exclusive boundary closes the window AT day 7 (so §1's day-7 case would fail)",
			m.expenseWindow({ status: "Delivered", deliveredAt: T, now: T + 7 * DAY }).eligible === false);
	}
	// M6 — a missing delivery time treated as open.
	{
		const m = buildLib(mutate(LIB_SRC, `if (!Number.isFinite(deliveredMs)) return verdict(false, "unknown");`, `if (!Number.isFinite(deliveredMs)) return verdict(true, "unknown");`));
		ok("M6  'missing → eligible' admits the no-record load (so §1 and §4 would fail)",
			m.expenseWindow({ status: "Delivered", deliveredAt: null, now: T }).eligible === true &&
			proceeds(await runGate({ libObj: m }, "Driver", "100004")));
	}
	// M7 — the LATEST completed row instead of the entry.
	{
		const m = buildLib(mutate(LIB_SRC, "if (!wasCompleted) enteredMs = r.t;", "enteredMs = r.t;"));
		ok("M7  'latest completed row' reopens a 9-day-old delivery that was merely marked Completed (§2, §4)",
			proceeds(await runGate({ libObj: m }, "Driver", "100009")));
	}
	// M8 — no cancelled-first check.
	{
		const m = buildLib(mutate(LIB_SRC, `\tif (CANCELLED_STATUS_RE.test(s)) return verdict(false, "cancelled");\n`, ""));
		const g = await runGate({ libObj: m }, "Driver", "100005");
		ok("M8  without the cancelled check the driver is told the wrong reason (§1, §4 pin 'cancelled')",
			m.expenseWindow({ status: "Cancelled", deliveredAt: T, now: T }).state !== "cancelled" && g.res.body && g.res.body.reason !== "cancelled");
	}
	// M9 — a failed read that admits instead of refusing.
	{
		const m = mutate(GATE_SRC, `catch (err) { return unverified("load_status_history read failed", err); }`, "catch (err) { deliveredAt = null; }");
		const g = await runGate({ gateSrc: m, db: fakeDb({ throws: DB_DOWN }) }, "Driver", "100002");
		ok("M9  a swallowed history failure answers 403 'unknown' instead of a retryable 503 (§4 would fail)",
			g.res.statusCode === 403 && g.res.body.reason === "unknown");
	}
	// M11 — the annotation judging each row alone, as the gate does not.
	{
		const m = mutate(ANNOTATE_SRC, "_expenseWindow: (keyOf(row) && byId.get(keyOf(row))) || verdicts[i] }", "_expenseWindow: verdicts[i] }");
		const rows = buildAnnotate({ annotateSrc: m }).fn(deshorn, HEADERS, NOW).filter((o) => o["Load ID"].replace("#", "") === "100012");
		const g = await runGate({}, "Driver", "100012");
		ok("M11 per-row verdicts would show the stale row closed while the gate accepts the id (so §6 would fail)",
			proceeds(g) && rows.some((o) => o._expenseWindow.eligible === false));
	}
	// M10 — the driver route without its annotation.
	{
		const m = mutate(DRIVER_ROUTE, `\t\t${ANNOTATE_LINE}\n`, "");
		ok("M10 GET /api/driver/:driverName without the verdict is caught by §6's wiring check", driverRouteWiring(m).length > 0);
	}

	// =========================================================================
	section("§8  LOAD_REQUIRED — a Driver's receipt must name its load");
	// =========================================================================
	// Before this, a Driver POST with no loadId skipped the ownership check (it
	// runs only `&& safeLoadId`) AND the window (no id → "untouched"), and the
	// expense was still stamped with the driver's truck and owner. "#" was worse:
	// the ownership guard folds it to "" and matches a sheet row whose Load ID is
	// BLANK, so a blank-id row naming the driver made "#" look owned.
	const LOAD_LINE = "if (sentIfDriverExpenseLoadMissing(req, res, safeLoadId)) return;";
	ok("sentIfDriverExpenseLoadMissing() exists in server.js", !!LOAD_MISSING_SRC);
	{
		const missing = buildLoadMissing();
		for (const none of ["", "#", "   ", " # ", null, undefined]) {
			const res = fakeRes();
			const answered = missing(asRole("Driver"), res, none);
			ok(`Driver + ${JSON.stringify(none)} → 400 LOAD_REQUIRED`, answered === true && res.statusCode === 400 && res.body && res.body.code === "LOAD_REQUIRED");
		}
		const sample = fakeRes();
		missing(asRole("Driver"), sample, "");
		ok("…with a sentence that says what to do, and no word the app reads as a PHOTO problem",
			!!(sample.body && /load/i.test(sample.body.error || "") && !PHOTO_FAILURE_RE.test(sample.body.error || "")));
		for (const id of ["100001", "#100001"]) {
			const res = fakeRes();
			ok(`Driver + ${JSON.stringify(id)} → passes, nothing sent`, missing(asRole("Driver"), res, id) === false && res.sends === 0);
		}
		for (const role of ["Super Admin", "Dispatcher"]) {
			const res = fakeRes();
			ok(`${role} + no load → unchanged (not refused here)`, missing(asRole(role), res, "") === false && res.sends === 0);
		}
	}
	// Wiring: once, before the ownership check, before any write.
	function loadRequiredWiring(src) {
		const problems = [];
		let route;
		try { route = routeSource("post", "/api/expenses", src); } catch (e) { return [e.message]; }
		const lines = route.split("\n").map((l) => l.trim());
		const at = lines.indexOf(LOAD_LINE);
		const count = lines.filter((l) => l === LOAD_LINE).length;
		if (count !== 1) problems.push(`the LOAD_REQUIRED line appears ${count}× (expected exactly 1)`);
		const owned = lines.findIndex((l) => /const owned = await loadBelongsToDriver\(safeLoadId, driver\);/.test(l));
		const write = lines.findIndex((l) => /saveReceiptToDisk\(|INSERT INTO expenses/.test(l));
		if (owned < 0 || write < 0) problems.push("could not find the ownership check or the first write");
		if (at >= 0 && (at > owned || at > write)) problems.push("LOAD_REQUIRED runs after the ownership check or a write");
		return problems;
	}
	const lw = loadRequiredWiring(SRC);
	for (const p of lw) console.log(`      ${p}`);
	ok("POST /api/expenses refuses a Driver with no load once, before the ownership check and every write", lw.length === 0);

	// Replay: the route's Driver checks exactly as written — the LOAD_REQUIRED
	// line (when present), the ownership block, the window gate — against a guard
	// that behaves like the real one on a sheet holding a blank-id row naming the
	// driver. "PROCEEDED" means the request would have gone on to the write.
	function driverChecksSlice(src) {
		const lines = routeSource("post", "/api/expenses", src).split("\n");
		const end = lines.findIndex((l) => l.trim() === GATE_LINE);
		let start = lines.findIndex((l) => /SECURITY: drivers can only file expenses against loads assigned to/.test(l));
		for (let k = start - 1; k >= Math.max(0, start - 8); k--) if (/sentIfDriverExpenseLoadMissing\(/.test(lines[k])) { start = k; break; }
		if (start < 0 || end < start) throw new Error("could not slice the route's Driver checks");
		return lines.slice(start, end + 1).join("\n");
	}
	const ownership503 = OWNERSHIP_503_SRC ? new Function(`"use strict";\n${OWNERSHIP_503_SRC}\nreturn sentIfLoadOwnershipUnverified;`)() : () => false;
	async function replay({ src = SRC, gateSrc = GATE_SRC, loadMissing = buildLoadMissing(), role = "Driver", loadId }) {
		const loadBelongsToDriver = async (id, driver) => {
			if (!id || !driver) return false;
			const lid = normalizeLoadId(id);
			if (!lid) return true; // the real guard's "" key matches the blank-id row naming this driver
			return SHEET.data.some((r) => normalizeLoadId(r["Load ID"]) === lid && r.Driver === driver);
		};
		const { gate } = buildGate({ gateSrc, loadMissing });
		const res = fakeRes();
		const run = new Function("req", "res", "safeLoadId", "driver", "loadBelongsToDriver",
			"sentIfLoadOwnershipUnverified", "sentIfDriverExpenseWindowClosed", "sentIfDriverExpenseLoadMissing",
			`"use strict"; return (async () => {\n${driverChecksSlice(src)}\nreturn "PROCEEDED";\n})();`);
		const out = await run(asRole(role), res, loadId, "Deshorn King", loadBelongsToDriver, ownership503, gate, loadMissing);
		return { proceeded: out === "PROCEEDED", res };
	}
	{
		let x = await replay({ loadId: "" });
		ok("REPLAY Driver, no loadId → refused 400 LOAD_REQUIRED, never reaches the write", !x.proceeded && x.res.statusCode === 400 && x.res.body.code === "LOAD_REQUIRED");
		x = await replay({ loadId: "#" });
		ok("REPLAY Driver, loadId \"#\" (a blank-id row names the driver) → refused 400, never reaches the write", !x.proceeded && x.res.statusCode === 400);
		x = await replay({ loadId: "100002" });
		ok("REPLAY Driver, load delivered 2 days ago → proceeds", x.proceeded && x.res.sends === 0);
		x = await replay({ loadId: "100003" });
		ok("REPLAY Driver, load closed 1 day ago → 403", !x.proceeded && x.res.statusCode === 403);
		x = await replay({ role: "Dispatcher", loadId: "" });
		ok("REPLAY Dispatcher, no loadId → unchanged, proceeds", x.proceeded);
	}
	// M12-M14 — each defang must flip an assertion above.
	if (LOAD_MISSING_SRC) {
		const noLine = mutate(SRC, `\t\t${LOAD_LINE}\n`, "");
		ok("M12 the route without its LOAD_REQUIRED line is caught by the wiring check", loadRequiredWiring(noLine).length > 0);
		const oldGate = mutate(GATE_SRC, "if (!targetLid) return sentIfDriverExpenseLoadMissing(req, res, loadId);", "if (!targetLid) return false;");
		const both = await replay({ src: noLine, gateSrc: oldGate, loadId: "" });
		ok("M13 without the line AND the gate's backstop (the pre-fix shape), a Driver's load-less receipt PROCEEDS — the replay catches it", both.proceeded);
		const truthy = buildLoadMissing(mutate(LOAD_MISSING_SRC, "if (normalizeLoadId(loadId)) return false;", "if (loadId) return false;"));
		const hash = await replay({ loadMissing: truthy, loadId: "#" });
		ok("M14 a raw-truthiness test lets \"#\" through to the write — the replay catches it", hash.proceeded);
	}

	// =========================================================================
	section("§9  the gate as production feeds it — through the real deduplicateLoads()");
	// =========================================================================
	ok("deduplicateLoads() found in server.js", !!DEDUPE_SRC);
	if (DEDUPE_SRC) {
		const deduplicateLoads = new Function(`"use strict";\n${DEDUPE_SRC}\nreturn deduplicateLoads;`)();
		const cached = { headers: HEADERS, data: deduplicateLoads(SHEET.data.map((x) => ({ ...x })), HEADERS) };
		const ids = cached.data.map((x) => normalizeLoadId(x["Load ID"]));
		ok("one row per load id reaches the gate (the bottom one)", new Set(ids).size === ids.length);
		r = await runGate({ sheet: cached }, "Driver", "7052901", "Howard Reddie");
		ok("7052901: only the cancelled BOTTOM copy survives, so the load reads cancelled and is refused — as the app, which does not list it",
			refused(r, "cancelled"));
		r = await runGate({ sheet: cached }, "Driver", "100012");
		ok("100012: the bottom row is the live one → accepted", proceeds(r));
		r = await runGate({ sheet: cached }, "Driver", "100007");
		ok("100007: the bottom row is ours, delivered 30 days ago → closed", refused(r, "closed"));
		const view = buildAnnotate().fn(cached.data.filter((x) => x.Driver === "Deshorn King"), HEADERS, NOW);
		let agree = true;
		for (const o of view) {
			const g = await runGate({ sheet: cached }, "Driver", o["Load ID"]);
			if (o._expenseWindow.eligible !== !g.answered) agree = false;
		}
		ok("…and on that same view the app's verdict and the gate agree on every load", agree && view.length > 0);
	}

	console.log(`\nexpense-load-window: ${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  harness error:", err && err.stack ? err.stack : err);
	process.exit(1);
});
