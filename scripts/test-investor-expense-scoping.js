#!/usr/bin/env node
/**
 * Tests for the MONTH DIMENSION on investor trip expenses.
 *
 * WHY IT LOADS THE FUNCTIONS OUT OF server.js SOURCE INSTEAD OF require()-ING IT.
 * Same reason as scripts/test-truck-retirement.js: server.js opens SQLite, reads a
 * service account key and starts listening on import. Extracting the text keeps this
 * honest in the way that matters — it exercises THE CODE THAT SHIPS, not a copy that
 * can quietly drift. Each extraction asserts the function is found exactly once, so a
 * rename or a second definition fails the run loudly rather than silently testing
 * nothing.
 *
 * THE BUG. `expenses` was scoped `owner_id = ? OR LOWER(driver) IN (<live driver
 * set>)`. getInvestorDriverSet() answers "who is on my trucks RIGHT NOW" and has no
 * clock, so the moment a driver was reassigned onto an investor's truck, every
 * receipt he had ever filed — on a different truck, stamped owner_id = 0 at insert —
 * became a deduction in that investor's already-finalized months.
 *
 * Production, 2026-08-13. Shorn King moved off LogisX-#2372 (owner_id 0) onto
 * Logisx-#91 (owner_id 5, in service 2026-08-04) on 2026-08-12 23:17. Three closed
 * months restated at once, all downward, none of them his:
 *
 *      2026-05   $3,992 -> ~$1,757     (his May expenses  $4,469.83)
 *      2026-06   $8,703 -> ~$5,020     (his June expenses $7,366.68)
 *      2026-07   $9,107 ->  $6,786     (his July expenses $4,641.85)
 *
 * It was ONE-SIDED. Revenue and driver pay scope off the sheet's Owner ID column and
 * truckChargedInMonth(), so nothing was added back — only costs moved.
 *
 * THE PROPERTY UNDER TEST is not "Shorn King's July expenses are excluded". It is
 * that THE DRIVER FALLBACK CAN ONLY EVER NARROW. `owner_id` is stamped at insert and
 * is the historically correct attribution; the driver leg exists only for legacy rows
 * that stamp could not classify, and it must never re-admit a row the stamp already
 * placed elsewhere. §5 proves that as a universal over the full cross-product, not
 * just on the one row that broke.
 *
 * Proved four ways, and all four are required:
 *
 *   §1 TEXTUAL. Every investor expense query in server.js goes through the single
 *      builder. Asserted by counting occurrences in the shipped source, so a future
 *      hand-rolled seventh site fails this run. A behavioural test cannot catch that
 *      — a new site simply would not be exercised. This is the DRIVER_RENAME_TARGETS
 *      lesson: six hand-copies of one predicate is how a fix to one becomes a fix to
 *      none.
 *
 *   §2 assignmentMonthKey — truck_assignments/carrier_driver_history hold ISO UTC
 *      instants, unlike in_service_date/retired_at which are bare calendar days. Both
 *      directions of that trap are pinned.
 *
 *   §3 intersectMonthWindow — "" means UNBOUNDED on both ends, the same convention as
 *      truckChargedInMonth(). Reading either the other way waves through the case
 *      with the most exposure; that inversion has already been corrected twice
 *      (PR #205, PR #216).
 *
 *   §4/§5 BEHAVIOURAL, against a REAL SQLite database seeded with the production
 *      shape — the 2 trucks, the real assignment history, the real per-month expense
 *      totals. The generated SQL is executed, not inspected, so a builder that emits
 *      syntactically valid nonsense fails here.
 *
 *   §11 THE SEVENTH SITE. GET /api/investor/report hand-rolled the pre-fix predicate
 *      ~500 lines from the other six and kept it for a further round — $40,761.24 vs a
 *      correctly-scoped $19,553.93 on one production investor, in a document they
 *      download and keep. Neither §1 (a caller COUNT, which six correct sites satisfy)
 *      nor §8 (structural over that handler's FIXED costs) could see it. §11 extracts
 *      that handler's expenses block and both inspects AND runs it.
 *
 *   §6 MUTANTS. Each deliberately reintroduces one half of the bug and must be caught.
 *      §7, §10 and §11 carry their own in-section mutants for the same reason.
 *
 * Run: node scripts/test-investor-expense-scoping.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const Database = require("better-sqlite3");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

let pass = 0;
const failures = [];
function ok(cond, label) {
	if (cond) { pass++; return; }
	failures.push(label);
}
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	ok(a === e, `${label}\n      expected ${e}\n      actual   ${a}`);
}

// ---------------------------------------------------------------- extraction
function extract(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) {
		throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	}
	const start = SRC.indexOf(needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}

function extractConst(name) {
	const re = new RegExp(`^const ${name} =([\\s\\S]*?);$`, "m");
	const m = SRC.match(re);
	if (!m) throw new Error(`could not extract const ${name} from server.js`);
	return m[1].trim();
}

const FNS = [
	"houstonDay",
	"truckChargeFromMonth",
	"truckChargeUntilMonth",
	"assignmentMonthKey",
	"intersectMonthWindow",
	"getInvestorDriverMonthWindows",
	"investorExpenseScopeSql",
	// §11's mutant rebuilds the pre-fix predicate, and it must do so from the SHIPPED
	// getInvestorDriverSet — a hand-written stand-in would only prove that a set of
	// names this test invented leaks, not that the one the handler actually built did.
	"getInvestorDriverSet",
];

// `db` is injected so getInvestorDriverMonthWindows runs against a real fixture
// database rather than a stub that could agree with a broken query.
function loadShipped(db, mutate = (s) => s) {
	const body = FNS.map(extract).join("\n\n");
	const consts = `const EXPENSE_PNL_FILTER = ${extractConst("EXPENSE_PNL_FILTER")};\n` +
		`const EXPENSE_PERIOD_EXPR = ${extractConst("EXPENSE_PERIOD_EXPR")};\n`;
	const src = mutate(`${consts}${body}\nreturn { ${FNS.join(", ")}, EXPENSE_PNL_FILTER, EXPENSE_PERIOD_EXPR };`);
	return new Function("db", src)(db);
}

// ------------------------------------------------------------------ fixtures
// The production shape as read read-only from app.db on 2026-08-13.
const OWNER = 5;                       // johnny.rocks.spirits.llc / "Johnny Rocks Spirits"
const TRUCKS = [
	// #33: no in_service_date, so truckChargeFromMonth falls back to created_at.
	{ id: 2, unit_number: "LogisX-#33", owner_id: OWNER, assigned_driver: "Howard Reddie",
	  created_at: "2026-04-15 03:10:50", in_service_date: "", retired_at: "" },
	// #2372: the FLEET truck. owner_id 0 — never this investor's.
	{ id: 3, unit_number: "LogisX-#2372", owner_id: 0, assigned_driver: "Jayden Morrison",
	  created_at: "2026-04-17 14:28:15", in_service_date: "", retired_at: "" },
	// #91: entered service 2026-08-04, three months after the row was created.
	{ id: 11, unit_number: "Logisx-#91", owner_id: OWNER, assigned_driver: "Shorn King",
	  created_at: "2026-05-21 12:07:08", in_service_date: "2026-08-04", retired_at: "" },
	// #77 is SYNTHETIC and exists to make the TRUCK bound the binding one: its driver
	// is assigned from 2026-06 but it does not enter service until 2026-10. On the
	// three real trucks the assignment always starts on or after the in-service date,
	// so the truck half of the intersection is never load-bearing there and a mutant
	// that drops it goes unnoticed. This is the shape that catches it.
	{ id: 77, unit_number: "Logisx-#77", owner_id: OWNER, assigned_driver: "Marcus Webb",
	  created_at: "2026-05-30 09:00:00", in_service_date: "2026-10-01", retired_at: "" },
];
const ASSIGNMENTS = [
	{ id: 8,  truck_id: 3,  driver_name: "Shorn King",    start_date: "2026-04-29T12:54:15.342Z", end_date: "2026-08-12T23:16:13.964Z" },
	{ id: 11, truck_id: 2,  driver_name: "Howard Reddie", start_date: "2026-05-13T10:47:01.338Z", end_date: "2026-05-19T14:25:33.210Z" },
	{ id: 14, truck_id: 2,  driver_name: "Howard Reddie", start_date: "2026-05-19T14:25:33.210Z", end_date: "" },
	{ id: 24, truck_id: 3,  driver_name: "Jayden Morrison", start_date: "2026-08-12T23:16:13.964Z", end_date: "" },
	{ id: 25, truck_id: 11, driver_name: "Shorn King",    start_date: "2026-08-12T23:17:51.574Z", end_date: "" },
	{ id: 77, truck_id: 77, driver_name: "Marcus Webb",  start_date: "2026-06-01T12:00:00.000Z", end_date: "" },
];
const CARRIER_HISTORY = [
	{ carrier_name: "Johnny Rocks Spirits", driver_name: "Howard Reddie", started_at: "2026-05-13T10:47:01.338Z", ended_at: "" },
	{ carrier_name: "Johnny Rocks Spirits", driver_name: "Jayden Morrison", started_at: "2026-08-04T13:05:40.435Z", ended_at: "" },
	{ carrier_name: "Johnny Rocks Spirits", driver_name: "Shorn King", started_at: "2026-08-12T23:17:51.574Z", ended_at: "" },
	// SYNTHETIC. Marcus is in the carrier history from 2026-06 while his only truck
	// does not enter service until 2026-10. Without the fleet clamp on leg C this
	// wider carrier window SUBSUMES his correct 2026-10 truck window in dedupe, and
	// the truck bound silently stops applying to him at all.
	{ carrier_name: "Johnny Rocks Spirits", driver_name: "Marcus Webb", started_at: "2026-06-01T12:00:00.000Z", ended_at: "" },
];
// Real production monthly totals, collapsed to one row per (driver, month).
//
// `type` exists for §11: GET /api/investor/report is the one caller that GROUPs BY it
// (Fuel / Maintenance / Other are its printed P&L lines), so the fixture has to be able
// to express a mis-bucketed as well as a mis-scoped total. Nothing else reads it, so
// §0/§5 are byte-identical with or without the column.
const EXPENSES = [
	{ driver: "Howard Reddie", owner_id: OWNER, truck_unit: "LogisX-#33",   date: "2026-05-20", amount: 5296.00, type: "Fuel" },
	{ driver: "Howard Reddie", owner_id: OWNER, truck_unit: "LogisX-#33",   date: "2026-06-20", amount: 6345.79, type: "Fuel" },
	{ driver: "Howard Reddie", owner_id: OWNER, truck_unit: "LogisX-#33",   date: "2026-07-20", amount: 6739.44, type: "Fuel" },
	{ driver: "Howard Reddie", owner_id: OWNER, truck_unit: "LogisX-#33",   date: "2026-08-06", amount: 1140.17, type: "Maintenance" },
	{ driver: "Shorn King",    owner_id: 0,     truck_unit: "LogisX-#2372", date: "2026-05-20", amount: 4469.83, type: "Fuel" },
	{ driver: "Shorn King",    owner_id: 0,     truck_unit: "LogisX-#2372", date: "2026-06-20", amount: 7366.68, type: "Fuel" },
	{ driver: "Shorn King",    owner_id: 0,     truck_unit: "LogisX-#2372", date: "2026-07-20", amount: 4641.85, type: "Fuel" },
	{ driver: "Shorn King",    owner_id: 0,     truck_unit: "LogisX-#2372", date: "2026-08-04", amount: 1118.00, type: "Fuel" },
	// Post-move: stamped to the investor at insert, so it needs no fallback at all.
	{ driver: "Shorn King",    owner_id: OWNER, truck_unit: "Logisx-#91",   date: "2026-09-10", amount: 900.00, type: "Fuel" },

	// --- UNATTRIBUTED legacy rows (truck_unit = ''), the only kind the driver
	// fallback may admit. These are what the leg exists for: rows written before
	// truck_unit/owner_id were stamped, sitting in a finalized month the boot
	// backfill deliberately refuses to touch.
	// Howard, inside his window -> ADMITTED.
	{ driver: "Howard Reddie", owner_id: 0, truck_unit: "", date: "2026-06-10", amount: 200.00, type: "Toll" },
	// Shorn, BEFORE he was ever this investor's -> REFUSED. Deleting the month
	// window would silently pull this into a closed month.
	{ driver: "Shorn King",    owner_id: 0, truck_unit: "", date: "2026-07-15", amount: 300.00, type: "Toll" },
	// Shorn, after the move -> ADMITTED.
	{ driver: "Shorn King",    owner_id: 0, truck_unit: "", date: "2026-09-20", amount: 150.00, type: "Toll" },

	// SYNTHETIC, for §11 only: a driver who is in NO leg of getInvestorDriverSet(OWNER)
	// and stamped to nobody. Without her the pre-fix hand-rolled shape and the Super
	// Admin "no scope at all" branch produce the SAME number on this fixture (every
	// other row's driver is in the set), so a mutant restoring the hand-rolled shape
	// would be indistinguishable from the correct Super Admin path. She is invisible to
	// §0/§5: owner_id 0 with a non-empty truck_unit is admitted by neither.
	{ driver: "Priya Raman",   owner_id: 0, truck_unit: "LogisX-#302", date: "2026-06-15", amount: 500.00, type: "Fuel" },
];

function makeDb() {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "logisx-scope-")), "t.db");
	const db = new Database(file);
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, company_name TEXT DEFAULT '');
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, owner_id INTEGER DEFAULT 0,
			assigned_driver TEXT DEFAULT '', created_at TEXT, in_service_date TEXT DEFAULT '', retired_at TEXT DEFAULT '');
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY, truck_id INTEGER, driver_name TEXT,
			start_date TEXT, end_date TEXT DEFAULT '');
		CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY AUTOINCREMENT, carrier_name TEXT,
			driver_name TEXT, started_at TEXT, ended_at TEXT DEFAULT '');
		CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT, owner_id INTEGER DEFAULT 0,
			truck_unit TEXT DEFAULT '', date TEXT, amount REAL, type TEXT DEFAULT '', status TEXT DEFAULT '',
			posted_period TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
	`);
	db.prepare("INSERT INTO users (id, company_name) VALUES (?, ?)").run(OWNER, "Johnny Rocks Spirits");
	const t = db.prepare("INSERT INTO trucks (id, unit_number, owner_id, assigned_driver, created_at, in_service_date, retired_at) VALUES (@id,@unit_number,@owner_id,@assigned_driver,@created_at,@in_service_date,@retired_at)");
	TRUCKS.forEach(r => t.run(r));
	const a = db.prepare("INSERT INTO truck_assignments (id, truck_id, driver_name, start_date, end_date) VALUES (@id,@truck_id,@driver_name,@start_date,@end_date)");
	ASSIGNMENTS.forEach(r => a.run(r));
	const c = db.prepare("INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at, ended_at) VALUES (@carrier_name,@driver_name,@started_at,@ended_at)");
	CARRIER_HISTORY.forEach(r => c.run(r));
	const e = db.prepare("INSERT INTO expenses (driver, owner_id, truck_unit, date, amount, type) VALUES (@driver,@owner_id,@truck_unit,@date,@amount,@type)");
	EXPENSES.forEach(r => e.run(r));
	return db;
}

const db = makeDb();
const S = loadShipped(db);

// ---------------------------------------------------------------------- §0
// THE BUG REPRODUCES ON THIS FIXTURE.
//
// Without this the suite proves only that the new code is self-consistent — it
// could pass against a fixture that never expressed the defect at all. Here the
// RETIRED predicate is run verbatim against the same rows and must produce the
// production numbers that were actually on screen. That is what makes §5's
// expectations a fix rather than a preference.
{
	// The live driver set as getInvestorDriverSet() built it on 2026-08-13: trucks
	// .assigned_driver + active truck_assignments + carrier_driver_history, unioned,
	// with no clock anywhere.
	const oldSet = ["howard reddie", "shorn king", "jayden morrison", "marcus webb"];
	const ph = oldSet.map(() => "?").join(",");
	const before = {};
	// Restricted to the rows that mirror production (the ones carrying a truck_unit),
	// so the synthetic unattributed rows added below for §5 do not pollute a
	// reproduction of what was genuinely on screen.
	db.prepare(
		`SELECT ${S.EXPENSE_PERIOD_EXPR} AS m, COALESCE(SUM(amount),0) AS t FROM expenses WHERE (owner_id = ? OR LOWER(driver) IN (${ph})) AND COALESCE(truck_unit,'') != '' AND ${S.EXPENSE_PNL_FILTER} GROUP BY m`
	).all(OWNER, ...oldSet).forEach(r => { before[r.m] = Math.round(r.t * 100) / 100; });

	eq(before["2026-07"], 11381.29, "§0 the OLD predicate reproduces July's $11,381.29 — the figure in the screenshot");
	const beforeShare = Math.round((32197 - 4200 - 3043.33 - before["2026-07"]) * 0.5);
	eq(beforeShare, 6786, "§0 ...which yields the $6,786 the client reported, against a frozen ledger of $9,107");
	eq(Math.round((before["2026-05"] - 5296.00) * 100) / 100, 4469.83, "§0 May was inflated by Shorn's expenses too (the 'cut in half' month)");
	eq(Math.round((before["2026-08"] - 1140.17) * 100) / 100, 1118.00, "§0 and August, the one OPEN month, is genuinely mis-stated today");
}

// ---------------------------------------------------------------------- §1
// TEXTUAL: one builder, no survivors.
{
	const expenseDriverLeg = /owner_id = \? OR LOWER\(driver\) IN/g;
	const hits = (SRC.match(expenseDriverLeg) || []).length;
	// The one permitted occurrence is inside the ⚠️ comment above
	// getInvestorDriverMonthWindows, which quotes the old predicate to explain it.
	ok(hits === 1, `§1 exactly one 'owner_id = ? OR LOWER(driver) IN' should survive (the explanatory comment); found ${hits}`);
	const commentLine = SRC.split("\n").find(l => expenseDriverLeg.test(l));
	ok(/^\s*\/\//.test(commentLine || ""), "§1 the surviving occurrence is a comment, not live SQL");

	// Counted on a COMMENT-STRIPPED copy, because the ⚠️ above the builder and the one
	// inside the report handler both name it in prose to explain why the seventh caller
	// was missed — and a raw count cannot tell an explanation from a call.
	const CODE = SRC.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
	const callers = (CODE.match(/investorExpenseScopeSql\(/g) || []).length;
	// 1 definition + 7 call sites. The seventh is GET /api/investor/report, which kept
	// the hand-rolled shape for a further round after the other six were fixed — see §11,
	// which pins that handler specifically. This COUNT alone would have been satisfied by
	// six correct sites plus one wrong one, because a wrong site does not call the builder.
	ok(callers === 8, `§1 investorExpenseScopeSql should have 1 definition + 7 callers; found ${callers}`);

	for (const marker of [
		"FROM expenses WHERE ${scope.sql} AND ${EXPENSE_PNL_FILTER} GROUP BY m",
		"FROM expenses WHERE ${scope.sql} AND ${EXPENSE_PNL_FILTER} GROUP BY m, LOWER(type)",
	]) ok(SRC.includes(marker), `§1 shared scope reaches: ${marker}`);

	ok(SRC.includes("fixedCostComposition"), "§1 monthlyEarnings carries fixedCostComposition");
	ok((SRC.match(/function getMonthlyFixedCostParts\(/g) || []).length === 1,
		"§1 exactly one getMonthlyFixedCostParts definition");
	ok(SRC.includes("if (!truckChargedInMonth(t, monthKey)) continue;\n\t\t\t\t\tconst f = truckMonthlyFixed(t);"),
		"§1 the composition uses the SAME month gate as the total, not a second predicate");
}

// ---------------------------------------------------------------------- §2
// assignmentMonthKey: ISO UTC instants, and the bare-calendar-day exception.
{
	eq(S.assignmentMonthKey("2026-08-12T23:17:51.574Z"), "2026-08", "§2 mid-month UTC instant");
	// 02:30Z on the 1st is 21:30 on the PREVIOUS day in Houston. A bare slice would
	// read '2026-08'; the month boundary is a money boundary.
	eq(S.assignmentMonthKey("2026-08-01T02:30:00.000Z"), "2026-07", "§2 UTC instant just after month start is the PREVIOUS Houston month");
	// ...and the mirror: 23:00Z on the last day is still that day in Houston.
	eq(S.assignmentMonthKey("2026-07-31T23:00:00.000Z"), "2026-07", "§2 UTC instant just before month end stays put");
	// A bare calendar day must be SLICED, never parsed: new Date('2026-08-01') is
	// UTC midnight = 2026-07-31 in Houston, the inversion truckChargeFromMonth warns about.
	eq(S.assignmentMonthKey("2026-08-01"), "2026-08", "§2 bare YYYY-MM-DD is sliced, not parsed");
	eq(S.assignmentMonthKey(""), "", "§2 empty stays empty");
	eq(S.assignmentMonthKey(null), "", "§2 null stays empty");
	eq(S.assignmentMonthKey("not-a-date"), "", "§2 unparseable stays empty (caller falls back to the truck window)");
}

// ---------------------------------------------------------------------- §3
// intersectMonthWindow: "" is UNBOUNDED, both ends, and can never win.
{
	eq(S.intersectMonthWindow({ from: "2026-08", until: "" }, { from: "2026-05", until: "" }),
		{ from: "2026-08", until: "" }, "§3 from = the LATER of two starts");
	eq(S.intersectMonthWindow({ from: "", until: "2026-07" }, { from: "", until: "2026-09" }),
		{ from: "", until: "2026-07" }, "§3 until = the EARLIER of two ends");
	eq(S.intersectMonthWindow({ from: "", until: "" }, { from: "2026-08", until: "2026-09" }),
		{ from: "2026-08", until: "2026-09" }, "§3 an empty bound DEFERS to the other, never overrides it");
	eq(S.intersectMonthWindow({ from: "2026-08", until: "2026-09" }, { from: "", until: "" }),
		{ from: "2026-08", until: "2026-09" }, "§3 ...in either argument order");
	eq(S.intersectMonthWindow({ from: "2026-09", until: "" }, { from: "", until: "2026-07" }),
		null, "§3 an EMPTY intersection is null — 'never yours', not 'always yours'");
	eq(S.intersectMonthWindow({ from: "2026-08", until: "2026-08" }, { from: "2026-08", until: "2026-08" }),
		{ from: "2026-08", until: "2026-08" }, "§3 both bounds inclusive, single month survives");
}

// ---------------------------------------------------------------------- §4
// The windows, against the real fixture database.
{
	const w = S.getInvestorDriverMonthWindows(OWNER);

	// Shorn King is in the driver SET for this investor (truck #91 names him), but
	// his window must start at the LATER of the assignment (2026-08) and the truck
	// entering service (2026-08) — never at his 2026-04 start on the FLEET truck,
	// which belongs to a different owner entirely.
	const shorn = w.get("shorn king") || [];
	ok(shorn.length > 0, "§4 Shorn King has a window (he is genuinely on truck #91 now)");
	ok(shorn.every(x => x.from >= "2026-08"), `§4 every Shorn King window starts 2026-08 or later; got ${JSON.stringify(shorn)}`);

	// Howard Reddie: on #33 (owner 5, created 2026-04) from 2026-05.
	const howard = w.get("howard reddie") || [];
	ok(howard.length > 0, "§4 Howard Reddie has a window");
	ok(howard.some(x => x.from === "2026-05" && x.until === ""), `§4 Howard's open window starts 2026-05; got ${JSON.stringify(howard)}`);

	// Jayden Morrison drives the FLEET truck (owner 0), so legs A/B give him nothing
	// under this investor and leg C is the ONLY thing that answers — the gap that leg
	// exists to cover. It starts 2026-08-04, and he must not reach back past it.
	const jayden = w.get("jayden morrison") || [];
	eq(jayden, [{ from: "2026-08", until: "" }], "§4 a driver with no truck link is covered by carrier history alone");

	// Marcus Webb: assigned 2026-06, truck not in service until 2026-10. The TRUCK
	// bound is the binding one here — a driver sitting in a truck that is not yet
	// in service is not yet an expense.
	const marcus = w.get("marcus webb") || [];
	eq(marcus, [{ from: "2026-10", until: "" }], "§4 the truck's in-service date wins over an earlier assignment");

	// Subsumed windows are dropped, because the clause count grows with assignment
	// history and history only grows. Howard has three raw windows here — two
	// assignment rows plus a carrier-history row — and his closed 2026-05..2026-05
	// stint sits wholly inside his open one.
	eq(howard, [{ from: "2026-05", until: "" }], "§4 subsumed windows collapse into the one that contains them");
	ok(shorn.length === 1, `§4 Shorn's two identical windows (truck + carrier history) dedupe to one; got ${shorn.length}`);
	// ...but only when genuinely contained. Two disjoint stints must both survive.
	eq(S.intersectMonthWindow({ from: "2026-01", until: "2026-02" }, { from: "", until: "" }),
		{ from: "2026-01", until: "2026-02" }, "§4 (sanity) a bounded stint keeps both bounds");

	// An investor with no trucks gets no windows at all — and the scope SQL then
	// degenerates to owner_id alone, which is the correct conservative answer.
	eq([...S.getInvestorDriverMonthWindows(999).keys()], [], "§4 an owner with no trucks has no windows");
	const bare = S.investorExpenseScopeSql(999, S.getInvestorDriverMonthWindows(999), S.EXPENSE_PERIOD_EXPR);
	eq(bare.sql, "(owner_id = ?)", "§4 no windows -> owner_id alone");
	eq(bare.params, [999], "§4 no windows -> one param");
}

// ---------------------------------------------------------------------- §5
// BEHAVIOURAL: run the generated SQL and compare against the frozen ledger.
function monthlyTripExp(ownerId, lib = S) {
	const scope = lib.investorExpenseScopeSql(ownerId, lib.getInvestorDriverMonthWindows(ownerId), lib.EXPENSE_PERIOD_EXPR);
	const out = {};
	db.prepare(
		`SELECT ${lib.EXPENSE_PERIOD_EXPR} AS m, COALESCE(SUM(amount),0) AS t FROM expenses WHERE ${scope.sql} AND ${lib.EXPENSE_PNL_FILTER} GROUP BY m`
	).all(...scope.params).forEach(r => { out[r.m] = Math.round(r.t * 100) / 100; });
	return out;
}
{
	const got = monthlyTripExp(OWNER);

	// The frozen investor_payouts rows were computed BEFORE the contamination, so
	// they are the ground-truth oracle. Howard alone, every closed month.
	eq(got["2026-05"], 5296.00, "§5 2026-05 trip expenses = Howard only");
	// Howard's stamped 6345.79 + his 200.00 unattributed legacy row: the fallback
	// still does the job it exists for.
	eq(got["2026-06"], 6545.79, "§5 2026-06 = Howard stamped + Howard's unattributed legacy row");
	// 6739.44, NOT 11381.29 (which added Shorn's 4641.85) and NOT 7039.44 (which
	// would add his 300.00 unattributed row from a month he was not yet here).
	eq(got["2026-07"], 6739.44, "§5 2026-07 trip expenses = Howard only (was 11381.29)");

	// August: Shorn's pre-move receipts (2026-08-04, on the fleet truck) are still
	// not this investor's — he did not move until 2026-08-12. The month window alone
	// cannot see that; truck_unit is what does.
	eq(got["2026-08"], 1140.17, "§5 2026-08 excludes Shorn's pre-move receipts (SAME month as the move)");

	// September: one stamped row + one unattributed row, both after the move.
	eq(got["2026-09"], 1050.00, "§5 2026-09 includes Shorn's post-move rows (stamped and unattributed)");

	// Reconstruct the July investor share and check it against the frozen ledger.
	// netProfit = 32197 - 4200 - 3043.33 - tripExpenses; share = netProfit * 50%.
	const julyShare = Math.round((32197 - 4200 - 3043.33 - got["2026-07"]) * 0.5);
	eq(julyShare, 9107, "§5 July investor share matches the FROZEN investor_payouts.amount of $9,107");

	// THE UNIVERSAL, and the real property under test: the driver fallback may only
	// ever admit a row NO owner is stamped on. It must never move a row out of
	// another owner's ledger, in any month, for any driver.
	const scope = S.investorExpenseScopeSql(OWNER, S.getInvestorDriverMonthWindows(OWNER), S.EXPENSE_PERIOD_EXPR);
	const admitted = db.prepare(`SELECT id, owner_id, truck_unit FROM expenses WHERE ${scope.sql}`).all(...scope.params);
	ok(admitted.every(r => r.owner_id === OWNER || (r.truck_unit || "") === ""),
		"§5 UNIVERSAL: every admitted row is either stamped to this owner or unattributed — never another owner's");
	ok(EXPENSES.filter(e => e.owner_id === OWNER).length === admitted.filter(r => r.owner_id === OWNER).length,
		"§5 UNIVERSAL: and every row that IS stamped to this owner is admitted, unconditionally");
}

// ---------------------------------------------------------------------- §7
// THE FIXED-COST DRILL-DOWN RECONCILES, at every month, for every truck set.
//
// The modal used to render production.fixedCostBreakdown — a present-tense FLEET
// rate with no in-service gate — against this month's gated total, and printed the
// two as one equation. July 2026:
//     $3,310 + $100 + $2,410 + $233 + $97 = $3,043/mo      (left side: $6,150)
// The $3,107 excess was Logisx-#91, which did not enter service until August.
//
// Both halves are extracted from the shipped source and compared across the full
// cross-product of the real trucks x months, so "the parts sum to the total" is
// proved rather than asserted on the one month someone looked at.
{
	// The two are nested inside the route handler, so they are tab-indented rather
	// than at column 0 and need their own extraction. Still exactly-once-asserted.
	function extractNested(name) {
		const re = new RegExp(`\\n(\\t+)function ${name}\\(`);
		const hits = SRC.split(`function ${name}(`).length - 1;
		if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}(), found ${hits}`);
		const m = SRC.match(re);
		const start = SRC.indexOf(m[0]) + 1;
		let depth = 0;
		for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
			if (SRC[j] === "{") depth++;
			else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
		}
		throw new Error(`unbalanced braces extracting ${name}()`);
	}
	const F = new Function("fixedTrucks", `
		${extract("truckMonthlyFixed")}
		${extract("truckChargeFromMonth")}
		${extract("truckChargeUntilMonth")}
		${extract("truckChargedInMonth")}
		${extractNested("getMonthlyFixedCosts")}
		${extractNested("getMonthlyFixedCostParts")}
		return { getMonthlyFixedCosts, getMonthlyFixedCostParts };`);

	// The real per-truck money, read read-only from app.db on 2026-08-13.
	const MONEY = {
		2:  { insurance_monthly: 1630, eld_monthly: 50, truck_payment_monthly: 1200, irp_annual: 1380, hvut_annual: 580 },
		11: { insurance_monthly: 1680, eld_monthly: 50, truck_payment_monthly: 1210, irp_annual: 1410, hvut_annual: 580 },
		77: { insurance_monthly: 0, eld_monthly: 0, truck_payment_monthly: 0, irp_annual: 0, hvut_annual: 0 },
	};
	const owned = TRUCKS.filter(t => t.owner_id === OWNER).map(t => ({ ...t, ...MONEY[t.id] }));
	const { getMonthlyFixedCosts, getMonthlyFixedCostParts } = F(owned);

	const MONTHS = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
	for (const mk of MONTHS) {
		const total = getMonthlyFixedCosts(mk);
		const p = getMonthlyFixedCostParts(mk);
		const summed = Math.round((p.insurance + p.eld + p.truckPayment + p.irp + p.hvut) * 100) / 100;
		eq(summed, total, `§7 ${mk}: itemized parts sum to the headline`);
	}

	// The specific regression: July is #33 alone, NOT the fleet rate.
	eq(getMonthlyFixedCosts("2026-07"), 3043.33, "§7 July total = LogisX-#33 alone");
	const july = getMonthlyFixedCostParts("2026-07");
	eq(july.insurance, 1630, "§7 July insurance excludes #91's $1,680 (it was not in service)");
	eq(july.truckPayment, 1200, "§7 July truck payment excludes #91's $1,210");
	eq(july.truckCount, 1, "§7 July counts one truck");
	// August: #91 joins, and the headline moves with it.
	const aug = getMonthlyFixedCostParts("2026-08");
	eq(aug.insurance, 3310, "§7 August insurance includes #91 — this is where it belongs");
	eq(aug.truckCount, 2, "§7 August counts both trucks");
	ok(getMonthlyFixedCosts("2026-08") > getMonthlyFixedCosts("2026-07"),
		"§7 the second truck raises fixed costs from August onward, not retroactively");

	// MUTANT: drop the month gate from the composition only — i.e. rebuild the
	// present-tense fleet rate the modal used to print. Must reproduce the exact
	// $6,150-vs-$3,043 mismatch, or this section is not testing what it claims.
	const ungated = new Function("fixedTrucks", `
		${extract("truckMonthlyFixed")}
		${extract("truckChargeFromMonth")}
		${extract("truckChargeUntilMonth")}
		${extract("truckChargedInMonth")}
		${extractNested("getMonthlyFixedCosts")}
		${extractNested("getMonthlyFixedCostParts").replace("if (!truckChargedInMonth(t, monthKey)) continue;", "")}
		return { getMonthlyFixedCosts, getMonthlyFixedCostParts };`)(owned);
	const bad = ungated.getMonthlyFixedCostParts("2026-07");
	const badSum = Math.round((bad.insurance + bad.eld + bad.truckPayment + bad.irp + bad.hvut) * 100) / 100;
	// 6149.16 exact; the modal renders whole dollars, so on screen it reads
	// "$3,310 + $100 + $2,410 + $233 + $97", which a reader sums to $6,150.
	eq(badSum, 6149.16, "§7 MUTANT reproduces the fleet-rate left side of $6,149.16 (displayed as $6,150)...");
	ok(badSum !== ungated.getMonthlyFixedCosts("2026-07"),
		"§7 ...against a headline of $3,043 — the equation the client was shown");
}

// ---------------------------------------------------------------------- §8
// GET /api/investor/report BUCKETS EVERY PART OF truckMonthlyFixed().
//
// ⚠️ THE FAILURE THIS GUARDS IS A CATEGORY BEING ABSENT, NOT MISCOMPUTED, and no
// value-based test finds that — the report added up perfectly, to the wrong total.
// `insurance_monthly` appeared NOWHERE in the handler: a grep across all ~430 of
// its lines returned zero hits, so every downloadable P&L understated Total
// Expenses by the full insurance accrual ($6,460/month fleet-wide, $17,430 already
// absent across the three investors) while /api/investor and the payouts ledger
// both billed it. The investor-facing report was the flattering one.
//
// So the assertion is STRUCTURAL and derived from truckMonthlyFixed's own return
// shape rather than from a hardcoded list: every key it produces except `total`
// must be read by the report's per-truck loop. Add a sixth fixed cost to that
// helper and this fails until the report decides which bucket it belongs in —
// which is the decision that was skipped the first time.
{
	const helper = extract("truckMonthlyFixed");
	const returned = helper.match(/return \{([^}]*)\}/)[1]
		.split(",").map(s => s.trim().split(":")[0].trim())
		.filter(k => k && k !== "total");
	ok(returned.length >= 5, `§8 truckMonthlyFixed returns >=5 parts; found ${returned.length}`);

	// The report handler, bounded by its own route registration.
	const start = SRC.indexOf('app.get("/api/investor/report"');
	ok(start > 0, "§8 the report handler is findable");
	const end = SRC.indexOf('\napp.', start + 10);
	const handler = SRC.slice(start, end > start ? end : SRC.length);

	ok(/const f = truckMonthlyFixed\(t\);/.test(handler),
		"§8 the report uses the SHARED per-truck math, not a hand-rolled copy that can drift");
	for (const key of returned) {
		ok(handler.includes(`f.${key}`), `§8 the report buckets truckMonthlyFixed().${key} — a part it never reads is a category silently missing from Total Expenses`);
	}
	// And each bucket must actually reach the total.
	for (const bucket of ["complianceExpenses", "truckPaymentExpenses", "insuranceExpenses"]) {
		ok(new RegExp(`totalExpenses = .*\\b${bucket}\\b`).test(handler),
			`§8 ${bucket} is summed into totalExpenses`);
	}
	ok(handler.includes('{ label: "  Insurance", value: `(${fmt(insuranceExpenses)})`'),
		"§8 Insurance is a printed P&L line, not just an accumulator");

	// The page-break rule keys on plLines.length - 3 to keep the last three bold
	// rows together. Adding a row shifts every absolute index, so pin that the
	// separator still lands on Total Expenses rather than mid-table.
	const labels = [...handler.matchAll(/\{ label: [`"]([^`"]*)[`"]/g)].map(m => m[1].trim());
	const pl = labels.slice(labels.indexOf("Gross Revenue"));
	eq(pl[pl.length - 3], "Total Expenses", "§8 the page-break separator still lands on Total Expenses after the new row");

	// The split must come from investor_config, not a hardcoded 0.5 — the report's
	// whole job is to agree with the portal, which reads investor_split_pct.
	// Negative assertions run against a COMMENT-STRIPPED copy: the comments here
	// deliberately quote the old hardcoded forms to explain them, and a raw text
	// search cannot tell an explanation from a survivor.
	const code = handler.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
	ok(!/netCashFlow \* 0\.5/.test(code), "§8 no hardcoded 0.5 split");
	ok(!/\(50%\)/.test(code), "§8 no hardcoded (50%) label");
	ok(/resolveInvestorSplitPct\(config\)/.test(code),
		"§8 the split comes from the SHARED resolver, so the report and the portal cannot disagree");
}

// --------------------------------------------------------------------- §11
// GET /api/investor/report's EXPENSES QUERY GOES THROUGH THE SHARED BUILDER.
//
// ⚠️ WHY THIS IS ITS OWN SECTION AND §1 AND §8 BOTH MISSED IT.
// §1 counts callers of investorExpenseScopeSql — a count six correct sites satisfy
// while a seventh, wrong one sits silently beside them, because a hand-rolled query
// does not call the builder it is failing to use. §8 is structural over
// truckMonthlyFixed()'s FIXED costs in the same handler and never looks at trip
// expenses at all. So the report kept ` AND LOWER(driver) IN (<the live driver set>)`
// — getInvestorDriverSet(), present tense, no clock, no owner_id leg — for a full
// round after the portal was fixed, and the two surfaces disagreed:
//
//     owner 5, all-time, measured on production   BEFORE $40,761.24
//                                                  AFTER $19,553.93
//              Shorn King, 93 rows, owner_id 0, truck_unit 'LogisX-#2372'
//                                                  DELTA $21,207.31
//
// It failed OPEN twice over: `investorDriverSet.size > 0` meant an investor whose set
// came back EMPTY was shown the WHOLE FLEET's expenses, and the driver leg had no
// owner_id leg to fall back to.
//
// Proved two ways, and both are needed. (a) STRUCTURAL, so a future hand-rolled
// eighth site in this handler fails even if it happens to compute the right number on
// this fixture. (b) BEHAVIOURAL, by EXTRACTING THE SHIPPED BLOCK AND RUNNING IT — a
// text assertion cannot tell `scope.sql` wired to the right owner id from `scope.sql`
// wired to the wrong one.
let sectionMutants = 0;
{
	const start = SRC.indexOf('app.get("/api/investor/report"');
	ok(start > 0, "§11 the report handler is findable");
	const endIdx = SRC.indexOf("\napp.", start + 10);
	const handler = SRC.slice(start, endIdx > start ? endIdx : SRC.length);

	// The `{ ... }` block that owns the itemized trip-expense query, located from the
	// query itself and brace-matched — never by line number, which every edit moves.
	function expenseBlockOf(h) {
		const anchor = h.indexOf("const expRows = db.prepare(");
		if (anchor < 0) throw new Error("§11 could not find the report's itemized expenses query");
		const open = h.lastIndexOf("\n\t\t{\n", anchor);
		if (open < 0) throw new Error("§11 could not find the block that owns it");
		let depth = 0;
		for (let j = open + 3; j < h.length; j++) {
			if (h[j] === "{") depth++;
			else if (h[j] === "}") { depth--; if (depth === 0) return h.slice(open + 3, j + 1); }
		}
		throw new Error("§11 unbalanced braces around the expenses block");
	}
	const block = expenseBlockOf(handler);

	// --- (a) STRUCTURAL. Run as a function so the mutant below is judged by the
	// IDENTICAL checks rather than a second, looser copy of them.
	function findings(h, b) {
		const code = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
		const hCode = code(h), bCode = code(b);
		return [
			[(hCode.match(/FROM expenses/g) || []).length === 1,
				"§11 the handler has exactly ONE `FROM expenses` query — a second one is a second place to get the scope wrong"],
			[/investorExpenseScopeSql\(\s*reportOwnerId\s*,\s*getInvestorDriverMonthWindows\(\s*reportOwnerId\s*\)\s*,\s*EXPENSE_PERIOD_EXPR\s*\)/.test(bCode),
				"§11 it scopes via investorExpenseScopeSql(reportOwnerId, getInvestorDriverMonthWindows(reportOwnerId), EXPENSE_PERIOD_EXPR)"],
			[!/LOWER\(driver\)\s*IN/.test(bCode),
				"§11 no hand-rolled `LOWER(driver) IN (...)` survives in the expenses block"],
			[!/getInvestorDriverSet|investorDriverSet/.test(bCode),
				"§11 the expenses block does not touch the present-tense driver SET at all"],
			[/WHERE \$\{scopeSql\}\$\{dateWhere\}/.test(bCode),
				"§11 the WHERE is the builder's fragment plus the caller's date range, in that order"],
			[/reportOwnerId !== null/.test(bCode),
				"§11 the owner id is tested `!== null`, not for truthiness — a falsy 0 must not silently become Super Admin scope"],
			[!/label:/.test(bCode),
				"§11 the block prints no P&L line, so it cannot shift §8's plLines.length - 3 page break"],
			// The settlement-vs-operational split. The BUILDER gets EXPENSE_PERIOD_EXPR
			// (which month does this row settle in); the report's own caller-supplied
			// range keeps plain `date` (which purchases fall between these two days).
			[/dateWhere \+= ' AND date >= \?'/.test(hCode) && /dateWhere \+= ' AND date <= \?'/.test(hCode),
				"§11 dateWhere still reads plain `date` — the report's range is an OPERATIONAL question and must not move to the settlement basis"],
			[!/dateWhere \+= [^\n]*EXPENSE_PERIOD_EXPR/.test(hCode),
				"§11 ...and specifically was not 'helpfully' switched to EXPENSE_PERIOD_EXPR"],
			// Surgical: the revenue and driver-pay legs still use the driver set, so a
			// blanket deletion of getInvestorDriverSet from this handler fails here.
			[/getInvestorDriverSet\(user\.id/.test(hCode) && /investorDriverSet\.has\(/.test(hCode),
				"§11 the REVENUE leg still uses getInvestorDriverSet — the fix is scoped to expenses, not a blanket removal"],
		];
	}
	for (const [pass_, label] of findings(handler, block)) ok(pass_, label);

	// --- (b) BEHAVIOURAL. Execute the shipped block against the fixture database.
	// Everything it closes over is injected, so what runs is the code that ships.
	function runBlock(b, ownerId, lib) {
		const fn = new Function("db", "S", "reportOwnerId", `
			const { investorExpenseScopeSql, getInvestorDriverMonthWindows, getInvestorDriverSet,
			        EXPENSE_PNL_FILTER, EXPENSE_PERIOD_EXPR } = S;
			const dateWhere = ''; const dateParams = [];
			let fuelExpenses = 0, maintenanceExpenses = 0, otherExpenses = 0, totalExpenses = 0;
			${b}
			const r = (n) => Math.round(n * 100) / 100;
			return { fuel: r(fuelExpenses), maint: r(maintenanceExpenses), other: r(otherExpenses), total: r(totalExpenses) };`);
		return fn(db, lib, ownerId);
	}

	// Guarded, because this leg is the one that cannot run at all against a handler
	// still on the pre-fix shape — that block closes over `investorDriverSet`, which
	// this runner deliberately does NOT inject. A bare throw would exit the process
	// before §9/§10 ran, so the inability to run is recorded as the failure it is.
	try {
		const got = runBlock(block, OWNER, S);
		// Howard's four stamped rows + Shorn's one POST-move stamped row + the two
		// unattributed rows inside their drivers' windows. Nothing else.
		eq(got.fuel, 19281.23, "§11 Fuel = Howard's stamped fuel + Shorn's post-move row only");
		eq(got.maint, 1140.17, "§11 Maintenance = Howard's August row");
		eq(got.other, 350.00, "§11 Other = the two admissible unattributed rows (200 + 150), NOT Shorn's pre-move 300");
		eq(got.total, 20771.40, "§11 Total Expenses on the downloadable P&L");

		// Super Admin: reportOwnerId is null, so no scope at all — every row, including
		// Priya Raman's, who is in no investor's driver set.
		const sa = runBlock(block, null, S);
		eq(sa.total, 39167.76, "§11 Super Admin (reportOwnerId null) still aggregates the whole fleet, unchanged");
		ok(sa.total > got.total, "§11 ...and the investor sees strictly less than the Super Admin");

		// An investor with no trucks degenerates to `owner_id = ?` alone and sums nothing —
		// where the pre-fix shape's empty-driver-set branch published the entire fleet.
		const orphan = runBlock(block, 999, S);
		eq(orphan.total, 0, "§11 an investor with no trucks sees $0, not the fleet (the old `size > 0` fail-open)");

		// --- MUTANT: restore the hand-rolled `LOWER(driver) IN (...)` shape, built from the
		// SHIPPED getInvestorDriverSet, and require BOTH legs to catch it.
		const mutantBlock = block.replace(
			/if \(reportOwnerId !== null\) \{[\s\S]*?\n\t\t\t\}/,
			[
				"const investorDriverSet = reportOwnerId !== null ? getInvestorDriverSet(reportOwnerId) : null;",
				"\t\t\tif (investorDriverSet && investorDriverSet.size > 0) {",
				"\t\t\t\tconst driverList = [...investorDriverSet];",
				"\t\t\t\tconst ph = driverList.map(() => '?').join(',');",
				"\t\t\t\tscopeSql = `1=1 AND LOWER(driver) IN (${ph})`;",
				"\t\t\t\tscopeParams.push(...driverList);",
				"\t\t\t}",
			].join("\n"));
		ok(mutantBlock !== block, "§11 the mutant surgery actually applied (a no-op mutant proves nothing)");
		sectionMutants++;

		const mutantHandler = handler.replace(block, mutantBlock);
		ok(findings(mutantHandler, mutantBlock).some(([p]) => !p),
			"§11 MUTANT not caught by the structural checks: the hand-rolled driver-set shape is restored");

		const bad = runBlock(mutantBlock, OWNER, S);
		// $17,896.36 of Shorn King's costs, on trucks this investor has never owned,
		// land in his downloadable P&L. This is the production defect, to scale.
		eq(bad.total, 38667.76, "§11 MUTANT reproduces the contaminated total the report was printing");
		eq(Math.round((bad.total - got.total) * 100) / 100, 17896.36,
			"§11 MUTANT: the delta is exactly Shorn King's rows, none of which are this investor's");
		ok(bad.total !== sa.total,
			"§11 MUTANT is distinguishable from the Super Admin branch (Priya Raman is in no driver set)");
	} catch (e) {
		failures.push(`§11 the report's expenses block would not run in isolation — it still closes over handler state the shared builder does not need: ${e.message}`);
	}
}

// ---------------------------------------------------------------------- §9
// resolveInvestorSplitPct — a configured 0 must stay 0.
{
	const R = new Function(`${extract("resolveInvestorSplitPct")}return resolveInvestorSplitPct;`)();

	// THE BUG: `parseFloat(x) || 50` reads a deliberate 0 as 50, because 0 is
	// falsy. That is the direction that moves money — an investor set to 0% would
	// have been paid half of net profit on every screen AND in the payout ledger,
	// every figure agreeing, so nothing would look wrong.
	eq(R({ investor_split_pct: "0" }), 0, "§9 a configured 0 stays 0, not 50");
	eq(R({ investor_split_pct: 0 }), 0, "§9 ...as a number too");

	// Missing / unparseable still falls back to the seeded default.
	eq(R({}), 50, "§9 absent -> 50 (the seeded default)");
	eq(R({ investor_split_pct: "" }), 50, "§9 empty string -> 50");
	eq(R({ investor_split_pct: "abc" }), 50, "§9 unparseable -> 50");
	eq(R(null), 50, "§9 no config object at all -> 50");
	eq(R(undefined), 50, "§9 undefined -> 50");

	// Ordinary values pass through, including fractional splits.
	eq(R({ investor_split_pct: "50" }), 50, "§9 50 passes through");
	eq(R({ investor_split_pct: "62.5" }), 62.5, "§9 a fractional split is preserved");

	// Clamped, because the value comes from a free-text config row.
	eq(R({ investor_split_pct: "500" }), 100, "§9 500 clamps to 100 — never pay 5x net profit");
	eq(R({ investor_split_pct: "-10" }), 0, "§9 negative clamps to 0 — never invert the split and bill the investor");

	// One definition, and every reader goes through it.
	const raw = (SRC.match(/parseFloat\([^)]*investor_split_pct/g) || []).length;
	ok(raw === 1, `§9 exactly one raw parseFloat of investor_split_pct should survive (inside the helper); found ${raw}`);
	ok(!/investor_split_pct\)\s*\|\|\s*50/.test(SRC), "§9 no `|| 50` falsy fallback survives anywhere");
	const callers = (SRC.match(/resolveInvestorSplitPct\(/g) || []).length;
	ok(callers >= 8, `§9 1 definition + >=7 callers; found ${callers}`);
}

// --------------------------------------------------------------------- §10
// EarningsSection.vue — the month picker, and the numbers it must not invent.
{
	const SFC = fs.readFileSync(
		path.join(__dirname, "..", "client", "src", "components", "investor", "EarningsSection.vue"), "utf8");

	// --- the month watcher, extracted and RUN, not just grepped.
	const open = "watch(months, (v) => {";
	const i = SFC.indexOf(open);
	ok(i > 0, "§10 the months watcher is findable");
	const j = SFC.indexOf("}, { immediate: true })", i);
	const body = SFC.slice(i + open.length, j);
	// The body closes over `selectedIdx` (a ref) and `monthIdxInitialised` (a let).
	// Both are injected so the SHIPPED body is what runs. The body uses early
	// `return`s, so it goes in an IIFE (which they exit) with the flag written back
	// in a `finally` — a plain trailing assignment is skipped by every early return,
	// which silently pins the flag to false and makes every case look like a first
	// load. That is a harness bug that reads exactly like a passing fix.
	const step = new Function("selectedIdx", "ctx",
		`let monthIdxInitialised = ctx.init; const v = ctx.v;
		 try { (function () {\n${body}\n})(); } finally { ctx.init = monthIdxInitialised; }`);
	const run = (sequence) => {
		const idx = { value: 0 }, ctx = { init: false };
		for (const s of sequence) {
			if (Array.isArray(s)) { ctx.v = s; step(idx, ctx); }
			else idx.value = s;               // the user picking a month
		}
		return idx.value;
	};
	const m = (n) => Array.from({ length: n }, (_, k) => ({ month: k }));

	eq(run([m(5)]), 4, "§10 first load lands on the CURRENT month (last item)");
	eq(run([m(5), 2, m(5)]), 2, "§10 a refetch keeps the month the user is on");
	// THE BUG: `Math.min(idx, len-1) || len-1` used falsiness as 'not initialised',
	// so a legitimately clamped 0 fell through to the current month and the
	// EARLIEST month was unreachable across any refetch.
	eq(run([m(5), 0, m(5)]), 0, "§10 index 0 SURVIVES a refetch — the earliest month is reachable");
	eq(run([m(5), 4, m(3)]), 2, "§10 shrinking months clamps to the new last");
	eq(run([m(5), 3, [], m(6)]), 5, "§10 emptying re-arms, so a preview switch lands on its own current month");
	eq(run([[]]), 0, "§10 no months -> 0");

	// And the harness genuinely discriminates: the RETIRED body, run through the
	// same driver, must fail the two cases above. Without this the section could be
	// passing because the extraction silently returned something inert.
	{
		const oldBody = `
			if (v.length) selectedIdx.value = Math.min(selectedIdx.value, v.length - 1) || v.length - 1
			else selectedIdx.value = 0`;
		const oldStep = new Function("selectedIdx", "ctx",
			`let monthIdxInitialised = ctx.init; const v = ctx.v;
			 try { (function () {\n${oldBody}\n})(); } finally { ctx.init = monthIdxInitialised; }`);
		const oldRun = (sequence) => {
			const idx = { value: 0 }, ctx = { init: false };
			for (const s of sequence) {
				if (Array.isArray(s)) { ctx.v = s; oldStep(idx, ctx); } else idx.value = s;
			}
			return idx.value;
		};
		eq(oldRun([m(5)]), 4, "§10 (control) the old body also landed on the current month on first load");
		eq(oldRun([m(5), 0, m(5)]), 4, "§10 (control) ...but threw index 0 to the current month — the bug, reproduced");
		ok(oldRun([m(5), 2, m(5)]) === 2, "§10 (control) a non-zero index was unaffected, which is why this hid for so long");
	}

	// --- no fabricated rates. This annotation sits beside real money.
	ok(!/dailyRate \|\| 250/.test(SFC), "§10 no `dailyRate || 250` — never print a rate the server did not send");
	ok(!/'= \$250 ×/.test(SFC), "§10 no hardcoded $250 empty-state label");
	ok(!/'\$rate'/.test(SFC), "§10 no literal '$rate' placeholder leaking to the page");
	ok(!/'driver %'/.test(SFC), "§10 no literal 'driver %' placeholder leaking to the page");
	ok(SFC.includes("filter(r => Number.isFinite(r) && r > 0)"),
		"§10 unknown daily rates are DROPPED, not defaulted");
	ok(SFC.includes("= daily rate × calendar days worked this month"),
		"§10 the empty state says 'daily rate', which is true at any rate");
	// The split is read from the server's resolved value with a NULLISH default, so
	// a genuine 0 survives the wire the same way it now survives the config read.
	ok(/production\?\.investorSplitPct \?\? 50/.test(SFC),
		"§10 the client uses ?? (nullish), not || — a server-sent 0% must not become 50%");
}

// ---------------------------------------------------------------------- §6
// MUTANTS. Each reintroduces one half of the bug; each must be caught.
const MUTANTS = [
	{
		name: "M1 driver leg unbounded again (the original bug)",
		mutate: (s) => s.replace("if (!bounds.length) continue;", "if (!bounds.length) { clauses.push(`LOWER(driver) = ?`); params.push(driver); }\n\t\t\tif (!bounds.length) continue;")
			.replace("if (w.from) { bounds.push(`${periodExpr} >= ?`); }", "")
			.replace("if (w.until) { bounds.push(`${periodExpr} <= ?`); }", "")
			.replace("if (w.from) params.push(w.from);", "")
			.replace("if (w.until) params.push(w.until);", ""),
		expect: (lib) => monthlyTripExp(OWNER, lib)["2026-07"] !== 6739.44,
	},
	{
		name: "M2 window ignores the truck's in-service date",
		mutate: (s) => s.replace(
			"const truckWindow = (t) => ({ from: truckChargeFromMonth(t), until: truckChargeUntilMonth(t) });",
			"const truckWindow = (t) => ({ from: '', until: '' });"),
		// Caught on Marcus Webb, whose assignment (2026-06) PRECEDES his truck
		// entering service (2026-10) — the only fixture where the truck half of the
		// intersection is load-bearing.
		expect: (lib) => {
			const marcus = lib.getInvestorDriverMonthWindows(OWNER).get("marcus webb") || [];
			return !marcus.some(x => x.from === "2026-10");
		},
	},
	{
		name: "M3 empty bound WINS the intersection instead of deferring",
		mutate: (s) => s.replace(
			"const from = !a.from ? b.from : (!b.from ? a.from : (a.from > b.from ? a.from : b.from));",
			"const from = a.from < b.from ? a.from : b.from;"),
		// min() instead of max() takes the EARLIER start, so Marcus reaches back to
		// his 2026-06 assignment on a truck that is not in service until October.
		expect: (lib) => {
			const marcus = lib.getInvestorDriverMonthWindows(OWNER).get("marcus webb") || [];
			return marcus.some(x => x.from < "2026-10");
		},
	},
	{
		name: "M7 carrier history runs for a driver who already has a truck window",
		mutate: (s) => s.replace(
			"if (truckDerived.has(String(h.driver_name || \"\").trim().toLowerCase())) return;", ""),
		// Marcus is in the carrier history from 2026-06 and on a truck that does not
		// enter service until 2026-10. The wider carrier window then SUBSUMES the
		// truck one in dedupe, and the truck bound stops applying to him entirely.
		expect: (lib) => {
			const marcus = lib.getInvestorDriverMonthWindows(OWNER).get("marcus webb") || [];
			return marcus.some(x => x.from < "2026-10");
		},
	},
	{
		name: "M6 driver leg admits an ATTRIBUTED row (owner_id = 0 read as unstamped)",
		mutate: (s) => s.replace("COALESCE(truck_unit,'') = '' AND LOWER(driver) = ?", "LOWER(driver) = ?"),
		// Shorn's 2026-08-04 receipts sit on the fleet truck in the SAME month he
		// moved, so only the truck_unit bound refuses them.
		expect: (lib) => monthlyTripExp(OWNER, lib)["2026-08"] !== 1140.17,
	},
	{
		name: "M4 assignment stamps sliced as UTC instead of Houston-localised",
		mutate: (s) => s.replace("return houstonDay(d).slice(0, 7);", "return s.slice(0, 7);"),
		expect: (lib) => lib.assignmentMonthKey("2026-08-01T02:30:00.000Z") !== "2026-07",
	},
	{
		name: "M5 an empty intersection reads as 'always yours' instead of 'never'",
		mutate: (s) => s.replace("if (from && until && from > until) return null;", ""),
		expect: (lib) => lib.intersectMonthWindow({ from: "2026-09", until: "" }, { from: "", until: "2026-07" }) !== null,
	},
];
for (const m of MUTANTS) {
	let caught = false;
	try { caught = !!m.expect(loadShipped(db, m.mutate)); }
	catch { caught = true; } // a mutant that cannot even run is caught
	ok(caught, `§6 mutant NOT caught: ${m.name}`);
}

// -------------------------------------------------------------------- report
db.close();
if (failures.length) {
	console.error(`\n${failures.length} FAILURE(S):\n`);
	failures.forEach(f => console.error(`  ✗ ${f}`));
	console.error(`\n${pass} passed, ${failures.length} failed\n`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed (${MUTANTS.length} library mutants + ${sectionMutants} report-handler mutant caught)`);
