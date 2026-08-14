#!/usr/bin/env node
/**
 * Tests for the investor loss carry-forward — ONE definition, and a statement
 * PDF whose two halves are frozen TOGETHER.
 *
 * WHY IT LOADS THE CODE OUT OF server.js SOURCE INSTEAD OF require()-ING IT.
 * Same reason as test-truck-retirement.js and test-status-override-guard.js:
 * server.js opens SQLite, reads a service account key and starts listening on
 * import. Extracting the text keeps this honest in the way that matters — it
 * exercises THE CODE THAT SHIPS, not a copy that can quietly drift. Every
 * extraction asserts it matched exactly once, so a rename or a second definition
 * fails the run loudly rather than silently testing nothing.
 *
 * TWO BUGS ARE PINNED HERE, and they are the same bug seen from two sides:
 * the carry-forward rule was known to exactly ONE surface.
 *
 *   BUG 1 — the statement PDF printed a FROZEN top half against a LIVE carry.
 *     finalizePeriods() snapshotted only `p.breakdown` into finalized_breakdown,
 *     while the statement route always passed the LIVE p.lossCarriedIn /
 *     p.lossDeferred. The carry chain moves whenever any EARLIER month's
 *     recompute moves, so a June statement showed clean frozen figures (share
 *     $8,790.00) with a live "− Earlier loss applied −$1,563.00" beneath it that
 *     no longer corresponded to anything: 8790 − 1563 = 7227, printed directly
 *     above a settled amount of $8,703. §4 reproduces that non-footing page and
 *     proves the fix closes it.
 *
 *   BUG 2 — GET /api/investor never published the carry at all, so the Earnings
 *     waterfall showed the FULL monthly share while the payouts ledger and the
 *     statement showed the POST-carry figure, for the same month. §6.
 *
 * THE DANGEROUS VALUE IS ZERO. Most months carry nothing in, so `frozen || live`
 * would send the MAJORITY of statements back to the live recompute and re-create
 * bug 1 for them. §5 runs the shipped resolver and a `||` mutant side by side;
 * the mutant must fail or this file is decorative.
 *
 * §3's fixtures are REAL: the 23 investor_payouts rows read read-only from a
 * local copy of the production-shaped app.db on 2026-08-14. Their frozen
 * `monthShare` and frozen `amount` are an independent record of what the carry
 * WAS at close — computed by a build that predates this change — so replaying
 * the shipped walk over them is a genuine oracle and not a restatement of the
 * code under test.
 *
 * Run: node scripts/test-payout-carry-freeze.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");
const { buildPayoutStatementHtml } = require("../lib/payout-statement");

let pass = 0;
const failures = [];
function ok(cond, label) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.error(`  ✗ ${label}`);
}
function eq(actual, expected, label) {
	ok(JSON.stringify(actual) === JSON.stringify(expected),
		`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- extraction
function extractFn(name) {
	// `async function` and `function` both, so an async handler is not silently
	// reported as "0 definitions" (which would read as a rename and mask a real
	// failure).
	const plain = `\nfunction ${name}(`;
	const asyncy = `\nasync function ${name}(`;
	const hits = (SRC.split(plain).length - 1) + (SRC.split(asyncy).length - 1);
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const needle = SRC.includes(asyncy) ? asyncy : plain;
	const start = SRC.indexOf(needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}

// Comments deliberately quote the retired forms (`|| 50`-style hazards, the old
// inline walk), so every textual assertion runs against a comment-stripped copy
// or it would pass/fail on prose. Same guard §8 of test-investor-expense-scoping
// needed for the same reason.
const CODE = SRC
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.split("\n").map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1")).join("\n");

const carrySrc = extractFn("computeLossCarryForward");
const computeLossCarryForward = new Function(`${carrySrc}; return computeLossCarryForward;`)();

// ============================================================ §1 ONE definition
console.log("\n§1 the rule has exactly one definition, and every reader shares it");
{
	eq(SRC.split("\nfunction computeLossCarryForward(").length - 1, 1,
		"computeLossCarryForward defined exactly once");

	// The walk's running accumulator. If a second `let deficit = 0` appears, some
	// caller has copied the rule instead of calling it — which is the whole
	// failure mode this refactor removes.
	eq((CODE.match(/let deficit = 0;/g) || []).length, 1,
		"exactly one running deficit accumulator in server.js (no second copy of the walk)");

	const callSites = (CODE.match(/computeLossCarryForward\(monthlyEarnings\)/g) || []).length;
	ok(callSites >= 2, `at least two call sites share the walk (found ${callSites})`);

	// Both readers must be the real ones: the settlement reconcile and the
	// investor dashboard. A grep for the call alone would pass if someone pointed
	// both at the same handler.
	const reconcile = extractFn("reconcileInvestorPayouts");
	ok(/computeLossCarryForward\(monthlyEarnings\)/.test(reconcile),
		"reconcileInvestorPayouts() calls the shared walk");
	ok(!/let deficit/.test(reconcile),
		"reconcileInvestorPayouts() no longer carries its own inline walk");

	const investorRoute = SRC.slice(SRC.indexOf('app.get("/api/investor",'));
	const investorHandler = investorRoute.slice(0, investorRoute.indexOf('\napp.get("/api/investor/'));
	ok(/computeLossCarryForward\(monthlyEarnings\)/.test(investorHandler),
		"GET /api/investor calls the shared walk");
	for (const k of ["lossCarriedIn", "lossDeferred", "payable"]) {
		ok(new RegExp(`m\\.${k} = c\\.`).test(investorHandler),
			`GET /api/investor publishes monthlyEarnings[].${k}`);
	}
}

// ================================================ §2 behaviour vs an oracle
console.log("\n§2 the walk, against an INDEPENDENT oracle");
{
	// Written from the stated semantics in a deliberately different shape:
	// reduce over a signed running balance rather than an if/else on the sign,
	// so it cannot pass by sharing a mistake with the implementation.
	function oracle(months) {
		const out = {};
		let owedBack = 0; // outstanding losses, always >= 0
		for (const m of months) {
			const raw = Math.round(m.investorEarnings);
			const absorbed = raw > 0 ? Math.min(owedBack, raw) : 0;
			const added = raw < 0 ? Math.abs(raw) : 0;
			owedBack = owedBack - absorbed + added;
			out[m.month] = {
				raw,
				payable: Math.max(0, raw) - absorbed,
				carriedIn: absorbed,
				deferred: added,
			};
		}
		return out;
	}

	const cases = [
		["all profitable", [1000, 2000, 3000]],
		["single loss then absorbed in full", [-970, 1882]],
		["loss larger than the next month", [-5000, 780, 780]],
		["exact absorption to the dollar", [-500, 500, 100]],
		["consecutive losses", [-100, -200, 1000]],
		["zeros everywhere", [0, 0, 0]],
		["loss last, nothing to absorb it", [1000, -400]],
		["alternating", [500, -600, 700, -800, 900]],
		["a single month", [42]],
		["deficit outliving the array", [-9000, 100, 100]],
		["zero between a loss and its absorber", [-300, 0, 300]],
	];
	for (const [label, seq] of cases) {
		const months = seq.map((v, i) => ({ month: `2026-${String(i + 1).padStart(2, "0")}`, investorEarnings: v }));
		eq(computeLossCarryForward(months), oracle(months), `§2 ${label}`);
	}

	// Invariants that must hold for EVERY case, checked across the cross-product
	// rather than on the one sequence that broke.
	for (const [label, seq] of cases) {
		const months = seq.map((v, i) => ({ month: `2026-${String(i + 1).padStart(2, "0")}`, investorEarnings: v }));
		const got = computeLossCarryForward(months);
		const slots = Object.values(got);
		ok(slots.every((c) => c.payable >= 0), `§2 ${label}: payable is never negative`);
		ok(slots.every((c) => c.carriedIn >= 0 && c.deferred >= 0), `§2 ${label}: carry terms are never negative`);
		ok(slots.every((c) => c.payable === Math.max(0, c.raw) - c.carriedIn), `§2 ${label}: payable = raw − carriedIn`);
		ok(slots.every((c) => !(c.carriedIn > 0 && c.deferred > 0)), `§2 ${label}: a month never both defers and absorbs`);
		// Lifetime conservation: nothing is created or destroyed by the carry.
		const paid = slots.reduce((s, c) => s + c.payable, 0);
		const earned = slots.reduce((s, c) => s + c.raw, 0);
		const outstanding = slots.reduce((s, c) => s + c.deferred - c.carriedIn, 0);
		eq(paid, earned + outstanding, `§2 ${label}: Σpayable = Σraw + outstanding deficit`);
	}

	// Purity + totality: the input is not mutated and every month gets a slot, so
	// callers may index the result without a presence check (both readers do).
	const input = [{ month: "2026-01", investorEarnings: -5 }, { month: "2026-02", investorEarnings: 5 }];
	const snapshot = JSON.stringify(input);
	const got = computeLossCarryForward(input);
	eq(JSON.stringify(input), snapshot, "§2 input array is not mutated");
	eq(Object.keys(got), ["2026-01", "2026-02"], "§2 every month passed in gets a slot");
	eq(computeLossCarryForward([]), {}, "§2 empty array is not a crash");
	eq(computeLossCarryForward(undefined), {}, "§2 undefined is not a crash");

	// Idempotence: the reconcile runs this on nearly every investor request.
	const twice = computeLossCarryForward(input);
	eq(twice, got, "§2 repeated runs are identical (the reconcile stays idempotent)");
}

// ======================== §3 replayed against REAL frozen production rows
console.log("\n§3 replayed against the REAL frozen snapshots (owner 42, 15 periods)");
{
	// finalized_breakdown.monthShare and finalized_amount, read read-only from a
	// local copy of the production-shaped app.db on 2026-08-14. These were frozen
	// by a build that PREDATES this change, so reproducing every `amount` from the
	// `monthShare` chain is an independent confirmation of the walk's semantics —
	// and it is the evidence that the carry the statements need really did exist
	// at close and simply was not stored.
	const owner42 = [
		["2025-05", 3622, 3622], ["2025-06", 1530, 1530], ["2025-07", -970, 0],
		["2025-08", 1882, 912], ["2025-09", 60, 60], ["2025-10", -942, 0],
		["2025-11", 780, 0], ["2025-12", 0, 0], ["2026-01", 0, 0],
		["2026-02", 0, 0], ["2026-03", 0, 0], ["2026-04", 1733, 1571],
		["2026-05", 200, 200], ["2026-06", 0, 0], ["2026-07", 0, 0],
	];
	const carry = computeLossCarryForward(owner42.map(([month, share]) => ({ month, investorEarnings: share })));
	let matched = 0;
	for (const [month, , frozenAmount] of owner42) {
		const got = carry[month].payable;
		ok(got === frozenAmount, `§3 ${month}: replayed payable ${got} === frozen amount ${frozenAmount}`);
		if (got === frozenAmount) matched++;
	}
	eq(matched, owner42.length, "§3 every frozen settled amount is reproduced from the monthShare chain");

	// The two carries that were actually applied, and that no statement could
	// print correctly before this change.
	eq(carry["2025-08"].carriedIn, 970, "§3 2025-08 absorbed July's $970 loss in full");
	eq(carry["2025-07"].deferred, 970, "§3 2025-07 deferred $970");
	eq(carry["2025-11"].carriedIn, 780, "§3 2025-11 absorbed $780 of October's $942");
	eq(carry["2026-04"].carriedIn, 162, "§3 2026-04 absorbed October's remaining $162 — five months later");
}

// ============================ §4 the statement PDF has to FOOT
console.log("\n§4 the statement's two halves are frozen together");
{
	// The real June row: frozen share $8,790, frozen settled amount $8,703, so the
	// carry applied at close was $87. `drifted` in lib/payout-statement.js is
	// computed as monthShare − lossCarriedIn vs amount, so it is the page's own
	// does-this-add-up test and the right thing to assert on.
	const frozen = {
		revenue: 35161.76, driverPay: 9000, fixedCosts: 6149.16, tripExpenses: 2431.72,
		maintFundCost: 0, complianceCost: 0, netProfit: 17580.88, splitPct: 50, monthShare: 8790,
	};
	const render = (lossCarriedIn) => buildPayoutStatementHtml({
		investorName: "Test Investor", period: "2026-06", periodLabel: "June 2026",
		status: "paid", paidAt: "2026-07-31T00:00:00.000Z", dueDate: "2026-07-31",
		breakdown: frozen, lossCarriedIn, lossDeferred: 0,
		adjustment: 0, amount: 8703, effectiveAmount: 8703,
		detail: {}, statementNo: "202606-1", generatedAt: new Date("2026-08-14T00:00:00Z"),
	});

	// BEFORE: a live carry recomputed months later. 8790 − 1563 = 7227, printed
	// directly above "Settled amount $8,703" — the page the client complained about.
	const live = render(1563);
	ok(/now computes to/.test(live), "§4 a LIVE carry against a frozen top half trips the drift disclosure");
	ok(/\$7,227/.test(live), "§4 …and the printed composition lands on $7,227, not the $8,703 beside it");
	ok(/Earlier loss applied/.test(live) && /\$1,563/.test(live), "§4 …with the orphaned −$1,563 line");

	// AFTER: the carry frozen at close alongside the composition.
	const frozenCarry = render(87);
	ok(!/now computes to/.test(frozenCarry), "§4 the FROZEN carry makes the page foot — no drift disclosure");
	ok(/\$8,703/.test(frozenCarry), "§4 …and the settled amount is printed");

	// A month with no carry at all must be unaffected in either direction.
	const clean = render(0);
	ok(!/Earlier loss applied/.test(clean), "§4 a zero carry prints no carry row");

	// The losing-month half: nothing payable, and the deferral is disclosed.
	const losing = buildPayoutStatementHtml({
		investorName: "T", period: "2025-07", periodLabel: "July 2025", status: "owed",
		finalizedAt: "2025-08-08T00:00:00.000Z", dueDate: "2025-08-29",
		breakdown: { ...frozen, netProfit: -1940, monthShare: -970 },
		lossCarriedIn: 0, lossDeferred: 970, adjustment: 0, amount: 0, effectiveAmount: 0,
		detail: {}, statementNo: "202507-1", generatedAt: new Date(),
	});
	ok(/Loss carried forward/.test(losing) && /\$970/.test(losing),
		"§4 a losing month discloses the deferral it pushes forward");
}

// ==================== §5 the resolver: frozen wins, and ZERO is a value
console.log("\n§5 frozen-vs-live resolution — `??`, never `||`");
{
	// Extracted from the shipped statement route, not retyped.
	const line = (key) => {
		const re = new RegExp(`\\n\\s*${key}: (frozenBreakdown[^,]+),`);
		const hits = CODE.match(new RegExp(re.source, "g")) || [];
		if (hits.length !== 1) throw new Error(`expected exactly 1 \`${key}:\` resolution in server.js, found ${hits.length}`);
		return CODE.match(re)[1];
	};
	const carriedInExpr = line("lossCarriedIn");
	const deferredExpr = line("lossDeferred");
	ok(/\?\?/.test(carriedInExpr) && /\?\?/.test(deferredExpr), "§5 both resolutions use `??`");
	ok(!/\|\|/.test(carriedInExpr) && !/\|\|/.test(deferredExpr), "§5 neither resolution uses `||`");

	const resolve = new Function("frozenBreakdown", "p", `return [${carriedInExpr}, ${deferredExpr}];`);
	// The `||` mutant, built from the same shipped text so the two differ by
	// exactly one operator.
	const mutant = new Function("frozenBreakdown", "p",
		`return [${carriedInExpr.replace("??", "||")}, ${deferredExpr.replace("??", "||")}];`);

	const live = { lossCarriedIn: 1563, lossDeferred: 400 };

	// THE case. A frozen zero is the common one — most months carry nothing in.
	eq(resolve({ lossCarriedIn: 0, lossDeferred: 0 }, live), [0, 0],
		"§5 a frozen ZERO wins over a non-zero live value");
	eq(mutant({ lossCarriedIn: 0, lossDeferred: 0 }, live), [1563, 400],
		"§5 …and the `||` mutant leaks the live value (so this test can fail)");

	eq(resolve({ lossCarriedIn: 87, lossDeferred: 0 }, live), [87, 0], "§5 a frozen non-zero wins");

	// BACKWARD COMPATIBILITY. Every finalized_breakdown row written before this
	// change has the 9 composition keys and neither carry key; production carries
	// 20 such rows across 2025-05…2026-07, several already PAID. They must keep
	// printing exactly as they did.
	const legacy = {
		revenue: 1, driverPay: 1, fixedCosts: 1, tripExpenses: 1, maintFundCost: 0,
		complianceCost: 0, netProfit: 1, splitPct: 50, monthShare: 1,
	};
	eq(resolve(legacy, live), [1563, 400], "§5 a LEGACY snapshot (no carry keys) falls through to live — old behaviour, unchanged");
	eq(resolve(null, live), [1563, 400], "§5 no snapshot at all falls through to live");
	eq(resolve(undefined, live), [1563, 400], "§5 an unparseable snapshot falls through to live");
	// A null-valued key is still "absent" for our purposes and must not print null.
	eq(resolve({ lossCarriedIn: null, lossDeferred: null }, live), [1563, 400], "§5 explicit nulls fall through to live");
}

// ============================ §6 what finalizePeriods actually snapshots
console.log("\n§6 the snapshot carries the carry — but never invents a composition");
{
	const finalize = extractFn("finalizePeriods");
	const m = finalize.match(/const breakdown = JSON\.stringify\(([\s\S]*?)\n\t\t\t\);/);
	ok(!!m, "§6 the finalized_breakdown snapshot expression is where it is expected");
	const snapshot = new Function("p", `return JSON.stringify(${m[1]});`);

	const p = {
		breakdown: { revenue: 10, driverPay: 1, fixedCosts: 2, tripExpenses: 3, maintFundCost: 0, complianceCost: 0, netProfit: 4, splitPct: 50, monthShare: 2 },
		lossCarriedIn: 87, lossDeferred: 0,
	};
	const out = JSON.parse(snapshot(p));
	eq(out.lossCarriedIn, 87, "§6 lossCarriedIn is snapshotted");
	eq(out.lossDeferred, 0, "§6 lossDeferred is snapshotted — including a legitimate ZERO");
	eq(out.monthShare, 2, "§6 the existing composition keys survive untouched");
	eq(Object.keys(out).length, 11, "§6 the snapshot is the 9 composition keys plus exactly 2 carry keys");

	// A month that has aged out of the live earnings window has NO composition.
	// The statement deliberately prints "no longer available to re-derive" rather
	// than a waterfall of blanks, and that null check must survive: a bare
	// {lossCarriedIn, lossDeferred} object would be truthy and defeat it.
	eq(snapshot({ breakdown: null, lossCarriedIn: 5, lossDeferred: 0 }), "null",
		"§6 a null breakdown stays null — a carry-only object would render an all-zero waterfall");
	const aged = buildPayoutStatementHtml({
		investorName: "T", period: "2024-01", periodLabel: "January 2024", status: "paid",
		paidAt: "2024-02-23T00:00:00.000Z", breakdown: null, lossCarriedIn: 0, lossDeferred: 0,
		adjustment: 0, amount: 500, effectiveAmount: 500, detail: {}, statementNo: "202401-9",
		generatedAt: new Date(),
	});
	ok(/no longer available to re-derive/.test(aged), "§6 …and that month still prints its honest 'no composition' note");
}

// ============================================ §7 idempotency of the write
console.log("\n§7 re-finalizing an already-closed period rewrites nothing");
{
	// The claim under test is that the snapshot cannot change on a repeat call for
	// an already-finalized period. That rests entirely on the guards in the two
	// shipped UPDATEs, so run THEM — extracted from source — against a scratch DB.
	const finalize = extractFn("finalizePeriods");
	const grab = (label, re) => {
		const hits = finalize.match(new RegExp(re.source, "g")) || [];
		if (hits.length !== 1) throw new Error(`expected exactly 1 ${label} statement, found ${hits.length}`);
		return finalize.match(re)[1].replace(/\s+/g, " ").trim();
	};
	const stampOwedSql = grab("stampOwed", /const stampOwed = db\.prepare\(\s*`([\s\S]*?)`\s*\);/);
	const stampSettledSql = grab("stampSettled", /const stampSettled = db\.prepare\(\s*`([\s\S]*?)`\s*\);/);
	// The owners query builds its IN list at runtime (`${ph}` = one `?` per
	// period); bind a single period here. The substitution is asserted so a
	// rewrite that drops the placeholder fails rather than silently testing a
	// different query.
	const ownersRaw = grab("owners", /const owners = db\.prepare\(\s*`([\s\S]*?)`\s*\)/);
	ok(ownersRaw.includes("${ph}"), "§7 the owners query still builds its IN list from a placeholder");
	const ownersSql = ownersRaw.replace("${ph}", "?");

	for (const [label, sql] of [["stampOwed", stampOwedSql], ["stampSettled", stampSettledSql], ["owners", ownersSql]]) {
		ok(/COALESCE\(finalized_at,''\) = ''/.test(sql), `§7 ${label} is guarded on an unstamped row`);
	}

	let Database;
	try { Database = require("better-sqlite3"); } catch { Database = null; }
	if (!Database) {
		console.log("  (skipping the live SQLite leg — better-sqlite3 not installed)");
	} else {
		const file = path.join(os.tmpdir(), `carry-freeze-${process.pid}-${Date.now()}.db`);
		const db = new Database(file);
		try {
			db.exec(`CREATE TABLE investor_payouts (
				id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, period TEXT, amount REAL,
				status TEXT DEFAULT 'owed', finalized_at TEXT DEFAULT '', finalized_amount REAL,
				finalized_breakdown TEXT DEFAULT '')`);
			const ins = db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, status) VALUES (?,?,?,?)");
			ins.run(42, "2026-06", 8703, "owed");
			ins.run(43, "2026-06", 5000, "paid");

			const owed = db.prepare(stampOwedSql);
			const settled = db.prepare(stampSettledSql);
			const first = JSON.stringify({ monthShare: 8790, lossCarriedIn: 87, lossDeferred: 0 });
			const second = JSON.stringify({ monthShare: 9999, lossCarriedIn: 4321, lossDeferred: 0 });

			const n1 = owed.run(8703, "2026-08-14T00:00:00Z", 8703, first, 42, "2026-06").changes
				+ settled.run("2026-08-14T00:00:00Z", first, 43, "2026-06").changes;
			eq(n1, 2, "§7 the first close stamps both rows");

			// A later run with DIFFERENT numbers — a drifted recompute — must not land.
			const n2 = owed.run(1, "2026-09-01T00:00:00Z", 1, second, 42, "2026-06").changes
				+ settled.run("2026-09-01T00:00:00Z", second, 43, "2026-06").changes;
			eq(n2, 0, "§7 a repeat close changes ZERO rows");

			for (const owner of [42, 43]) {
				const row = db.prepare("SELECT * FROM investor_payouts WHERE owner_id = ?").get(owner);
				eq(row.finalized_breakdown, first, `§7 owner ${owner}: the snapshot still holds the figures frozen at close`);
				eq(row.finalized_at, "2026-08-14T00:00:00Z", `§7 owner ${owner}: finalized_at is not re-timed`);
			}
			eq(db.prepare("SELECT amount FROM investor_payouts WHERE owner_id = 43").get().amount, 5000,
				"§7 a settled row's amount is never rewritten");

			// The owners pre-filter: with both rows stamped, the period yields no
			// owner to reconcile at all, so the repeat run does no work upstream either.
			eq(db.prepare(ownersSql).all("2026-06").length, 0,
				"§7 an already-stamped period selects no owners on the next sweep");
		} finally {
			db.close();
			for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(file + suffix); } catch {} }
		}
	}
}

// ================================================================ §8 MUTANTS
// Each reintroduces one half of one of the two bugs, against the SHIPPED source
// text. Every one must be caught, or the sections above are decorative.
console.log("\n§8 mutants — each must be caught");
{
	const stripComments = (s) => s
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n").map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1")).join("\n");

	// Rebuilds the statement route's carry resolver out of a (possibly mutated)
	// source. Throws when the frozen-preferring form is absent — which is itself a
	// catch, since that is what the pre-fix code looks like.
	const resolverFrom = (src) => {
		const code = stripComments(src);
		const expr = (key) => {
			const re = new RegExp(`\\n\\s*${key}: (frozenBreakdown[^,]+),`);
			const hits = code.match(new RegExp(re.source, "g")) || [];
			if (hits.length !== 1) throw new Error(`no single frozen-preferring ${key}`);
			return code.match(re)[1];
		};
		return new Function("frozenBreakdown", "p", `return [${expr("lossCarriedIn")}, ${expr("lossDeferred")}];`);
	};

	// Rebuilds finalizePeriods' snapshot expression out of a (possibly mutated) source.
	const snapshotFrom = (src) => {
		const needle = "\nasync function finalizePeriods(";
		const start = src.indexOf(needle) + 1;
		let depth = 0, body = "";
		for (let j = src.indexOf("{", start); j < src.length; j++) {
			if (src[j] === "{") depth++;
			else if (src[j] === "}") { depth--; if (depth === 0) { body = src.slice(start, j + 1); break; } }
		}
		const m = body.match(/const breakdown = JSON\.stringify\(([\s\S]*?)\n\t\t\t\);/)
			|| body.match(/const breakdown = JSON\.stringify\(([^;]*?)\);/);
		if (!m) throw new Error("no snapshot expression");
		return new Function("p", `return JSON.stringify(${m[1]});`);
	};

	const LIVE = { lossCarriedIn: 1563, lossDeferred: 400 };
	const P = {
		breakdown: { revenue: 1, driverPay: 0, fixedCosts: 0, tripExpenses: 0, maintFundCost: 0, complianceCost: 0, netProfit: 1, splitPct: 50, monthShare: 8790 },
		lossCarriedIn: 87, lossDeferred: 0,
	};

	const MUTANTS = [
		{
			name: "M1 statement route reverts to an unconditionally LIVE carry (the original bug 1)",
			mutate: (s) => s
				.replace("lossCarriedIn: frozenBreakdown?.lossCarriedIn ?? p.lossCarriedIn,", "lossCarriedIn: p.lossCarriedIn,")
				.replace("lossDeferred: frozenBreakdown?.lossDeferred ?? p.lossDeferred,", "lossDeferred: p.lossDeferred,"),
			// Caught by the resolver simply not existing any more.
			caught: (s) => { try { resolverFrom(s); return false; } catch { return true; } },
		},
		{
			name: "M2 `??` becomes `||` — a frozen ZERO leaks back to the live value",
			mutate: (s) => s
				.replace("frozenBreakdown?.lossCarriedIn ?? p.lossCarriedIn", "frozenBreakdown?.lossCarriedIn || p.lossCarriedIn")
				.replace("frozenBreakdown?.lossDeferred ?? p.lossDeferred", "frozenBreakdown?.lossDeferred || p.lossDeferred"),
			caught: (s) => {
				const [ci, ld] = resolverFrom(s)({ lossCarriedIn: 0, lossDeferred: 0 }, LIVE);
				return ci !== 0 || ld !== 0;
			},
		},
		{
			name: "M3 finalizePeriods stops snapshotting the carry (the other half of bug 1)",
			mutate: (s) => s.replace(
				/const breakdown = JSON\.stringify\(\n\t\t\t\tp\.breakdown[\s\S]*?\n\t\t\t\);/,
				"const breakdown = JSON.stringify(p.breakdown || null);"),
			caught: (s) => {
				const out = JSON.parse(snapshotFrom(s)(P));
				return out.lossCarriedIn === undefined || out.lossDeferred === undefined;
			},
		},
		{
			name: "M4 snapshot drops the null guard — an aged-out month gets a carry-only object",
			mutate: (s) => s.replace(
				/const breakdown = JSON\.stringify\(\n\t\t\t\tp\.breakdown[\s\S]*?\n\t\t\t\);/,
				"const breakdown = JSON.stringify({ ...p.breakdown, lossCarriedIn: p.lossCarriedIn, lossDeferred: p.lossDeferred });"),
			// A truthy stand-in defeats the statement's `breakdown ? … : null` branch,
			// so the PDF renders an all-zero waterfall instead of its honest note.
			caught: (s) => {
				const snap = JSON.parse(snapshotFrom(s)({ breakdown: null, lossCarriedIn: 5, lossDeferred: 0 }));
				if (snap === null) return false;
				const html = buildPayoutStatementHtml({
					investorName: "T", period: "2024-01", periodLabel: "January 2024", status: "paid",
					paidAt: "2024-02-23T00:00:00.000Z", breakdown: snap, lossCarriedIn: 5, lossDeferred: 0,
					adjustment: 0, amount: 500, effectiveAmount: 500, detail: {}, statementNo: "x", generatedAt: new Date(),
				});
				return !/no longer available to re-derive/.test(html);
			},
		},
		{
			name: "M5 reconcileInvestorPayouts re-inlines its own copy of the walk",
			mutate: (s) => s.replace(
				"const carryByPeriod = computeLossCarryForward(monthlyEarnings);\n\n\t// Reconcile completed PAST months",
				"const carryByPeriod = {};\n\t{ let deficit = 0; for (const m of monthlyEarnings) { const raw = Math.round(m.investorEarnings); carryByPeriod[m.month] = { raw, payable: Math.max(0, raw), carriedIn: 0, deferred: 0 }; } }\n\n\t// Reconcile completed PAST months"),
			caught: (s) => (stripComments(s).match(/let deficit = 0;/g) || []).length !== 1,
		},
		{
			name: "M6 GET /api/investor stops publishing the carry (bug 2)",
			mutate: (s) => s
				.replace("m.lossCarriedIn = c.carriedIn;", "")
				.replace("m.lossDeferred = c.deferred;", "")
				.replace("m.payable = c.payable;", ""),
			caught: (s) => !/m\.payable = c\./.test(stripComments(s)),
		},
	];

	for (const m of MUTANTS) {
		let caught = false;
		try { caught = !!m.caught(m.mutate(SRC)); }
		catch { caught = true; } // a mutant that cannot even be built is caught
		ok(caught, `§8 mutant NOT caught: ${m.name}`);
		// A mutation that changed nothing would be "caught" vacuously.
		ok(m.mutate(SRC) !== SRC, `§8 mutant ${m.name.slice(0, 2)} actually altered the source`);
	}
}

// ---------------------------------------------------------------- verdict
console.log(`\n${failures.length ? "FAIL" : "PASS"} — ${pass} assertions passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.error(` - ${f}`)); process.exit(1); }
