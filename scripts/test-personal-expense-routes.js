#!/usr/bin/env node
/**
 * "Personal" receipts: the routes. POST/DELETE /api/expenses/:id/personal,
 * POST /api/expenses/:id/personal/reverse and POST /api/invoices/personal-corrections
 * run lifted from server.js with their real guards (requireRole,
 * refuseCrossOrigin, the X-Requested-With check), on the world in
 * scripts/lib/personal-world.js (made-up data; clock Thu 2026-10-15 12:00 ET).
 *
 *   §1 roles: Super Admin only. Dispatcher, Driver and Investor 403, signed out
 *      401, no X-Requested-With 403, a cross-site request 403, on every route
 *   §2 T1 flag off (PERSONAL_EXPENSE_DEDUCTIONS_ENABLED unset, or anything but
 *      "true"): a new mark is 403 PERSONAL_DISABLED, nothing written, no audit
 *   §3 T3 amounts: 0, -5, 200.01, 12.345, "abc" refused; absent = the receipt
 *   §4 T4 a mark: the row (cents, month in place, the open week, no invoice
 *      yet), the receipt untouched, one audit row naming the account
 *   §5 T14 idempotent: the same mark twice is one row (200 alreadyMarked); a
 *      different amount or account 409; a lost race 409, never 500
 *   §6 T15 status: a marked receipt cannot be Rejected or set Pending (409
 *      EXPENSE_PERSONAL; the bulk route withholds it and reports it); a
 *      Rejected receipt cannot be marked; marking a Pending receipt in an open
 *      month approves it, with two audit rows
 *   §7 undo of a line on no invoice voids it (the row stays), audited; nothing
 *      to undo is 404; reverse of a line that can still be undone is refused
 *   §8 the user delete refuses while a Personal line points at the driver's
 *      receipts (409 EXPENSE_PERSONAL_LINES); none without one
 *   §9 hooks for the screens: GET /api/expenses/all carries each receipt's
 *      Personal state and personalEnabled; the investor's receipt list hides a
 *      fully personal receipt and shows a partial one at the company's share;
 *      the driver payload reads the same summary (personalSummaryByExpense)
 *   §10 every Personal route is rate limited, after its gate
 * The receipt's week (PERSONAL_RECEIPT_WEEK_ENABLED, on only when exactly "true"):
 *   §11 W1 a receipt dated Oct 7, marked Thu Oct 15, is keyed to the week of
 *      Oct 3, not the week it is marked in
 *   §12 pins: no date, a date after today, or the flag not exactly "true":
 *      the week it is marked in
 *   §13 W10 once its invoice is approved the line is final: Undo 409 without
 *      "Use Reverse", Reverse 409 PERSONAL_LOCKED, the corrections route 410,
 *      the status refusal offers no reversal; pin: Undo of a line carried off
 *      its approved week voids it
 *   §14 W17 the mark's audit row says why the week is the one it is marked in:
 *      no receipt date, or a date after today
 *   §15 W18 GET /api/expenses/all carries personalReceiptWeek (the flag), for
 *      the Mark dialog's text
 * The status recorder (RECEIPT_STATUS_RECORDER_ENABLED, on only when exactly "true"):
 *   §16 off: the mark prepares today's one status write exactly, writes no
 *      recorder column and audits its approval as today
 *   §17 on: a mark on a Pending receipt records the marker and approves it; on
 *      an Approved one it records the marker and writes no "Pending -> Approved"
 *      row; on a closed-month receipt the row is left byte for byte; on one dated
 *      in a closed month but booked to an open one it approves as today and
 *      records nothing; a person's approval during the mark's render gets no
 *      second audit row; a person's Undo during it is left as the person set it;
 *      a refused status write records nothing; never stamped unless in place
 * The Personal tab's list (GET /api/expenses/personal/lines, read only):
 *   §18 Super Admin only: Dispatcher, Driver and Investor 403, signed out 401,
 *      and nothing is read before the gate refuses; its own read-sized limiter,
 *      per user, after the gate
 *   §19 with the receipt's week on: one row per Personal line (a receipt marked
 *      again after a reversal lists both), newest receipt date first, each with
 *      its driver, receipt date, merchant and the summary the receipts get
 *      (personalSummaryByExpense()); the total counts every state but reversed;
 *      voided lines are not listed; the driver box matches any spelling
 *      (normalizeDriverName()); from/to on the line's receipt date
 *   §20 refusals: a date that is not a real YYYY-MM-DD, a driver that is not one
 *      string of at most 100 characters (400); more than 5,000 lines in the
 *      dates (422), never a cut list with a wrong total
 *   §21 the marks switched off, and the receipt's week off: the lines still list
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-personal-expense-routes.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const { buildPersonalWorld, makeChecker, SRC } = require("./lib/personal-world");
const { check, section, finish } = makeChecker();

const ON = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" };
const WEEK_ON = { ...ON, PERSONAL_RECEIPT_WEEK_ENABLED: "true" };
const RECORDER_ON = { ...ON, RECEIPT_STATUS_RECORDER_ENABLED: "true" };
const world = (env = ON, opts = {}) => buildPersonalWorld({ env, ...opts });
// The recorder's four columns on a receipt, or the error reading them.
const STAMP_COLS = ["status_by_role", "status_by_id", "status_by_name", "status_at"];
const EMPTY_STAMP = ["", null, "", ""];
function stampOf(w, id) {
	try {
		const r = w.db.prepare(`SELECT ${STAMP_COLS.join(", ")} FROM expenses WHERE id = ?`).get(id);
		return r ? STAMP_COLS.map((c) => r[c]) : "row missing";
	} catch (e) {
		return `unreadable: ${e.message}`;
	}
}
const MARKER = ["Super Admin", 1, "super_admin"];
const statusOf = (w, id) => w.db.prepare("SELECT status FROM expenses WHERE id = ?").get(id).status;
// A person's status write as the recorder makes it, for the races below.
const personSets = (w, id, status) => w.db.prepare("UPDATE expenses SET status = ?, status_by_role = 'Dispatcher', status_by_id = 2, status_by_name = 'dispatch_a', status_at = '2026-10-15T16:00:00.000Z' WHERE id = ?").run(status, id);
// A receipt of the runner's own, beyond the world's eleven (made up, Approved).
function addReceipt(w, { id, driver = "Test Driver A", type = "Food", amount = 45.5, date, vendor = "EXAMPLE DINER #3", truck = "T-1", owner = 7 }) {
	const day = date || "2026-10-15";
	w.db.prepare(`INSERT INTO expenses (id, timestamp, driver, type, amount, date, status, vendor, truck_unit, owner_id, created_at, description)
		VALUES (?, ?, ?, ?, ?, ?, 'Approved', ?, ?, ?, ?, '')`).run(id, `${day}T15:00:00.000Z`, driver, type, amount, date, vendor, truck, owner, `${day} 15:00:00`);
}

// The Personal tab's list, lifted beside the world's routes. A build without it
// answers "no route", so each of its checks fails instead of the runner.
const LINES_HEAD = 'app.get("/api/expenses/personal/lines", requireRole("Super Admin"), personalLinesLimiter, (req, res) => {';
const LINES_EXTRA = { routes: { personalLines: LINES_HEAD }, tag: "personal-lines" };
async function readLines(w, query = {}, as = "admin") {
	try {
		return await w.call("GET", "/api/expenses/personal/lines", { as, query });
	} catch (e) {
		return { status: `no route (${e.message})`, body: null };
	}
}
const listed = (r) => ((r.body && r.body.lines) || []).map((l) => [l.expense_id, l.personal && l.personal.state]);
const totalsOf = (r) => (r.body && r.body.totals) || null;
const totals = (cents, text, lines, reversedCents, reversedText, reversedLines) =>
	({ cents, text, lines, reversed_cents: reversedCents, reversed_text: reversedText, reversed_lines: reversedLines });
// A reversal as the reverse route leaves one (made-up): a 'reverse' row naming the
// receipt's live charge, and the charge pointing back at it. Neither is on an invoice.
function reverseByHand(w, expenseId) {
	const d = w.lines("expense_id = ? AND kind = 'deduct' AND voided_at = '' AND reversed_by_id IS NULL", expenseId)[0];
	const id = Number(w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, reverses_id, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
		VALUES (?, 'reverse', ?, ?, ?, ?, ?, ?, ?, ?, ?, 't', 'super_admin', 1, 'Super Admin')`)
		.run(expenseId, d.id, d.cents, d.receipt_cents, d.merchant, d.receipt_date, d.cost_period, d.in_place, d.book_date, d.week_start).lastInsertRowid);
	w.db.prepare("UPDATE expense_personal SET reversed_by_id = ? WHERE id = ?").run(id, d.id);
}
// The tab's made-up lines, the receipt's week on (clock Thu 2026-10-15):
//   A   R1 $200 and R5 $50 marked, then on A's Draft for the week of Oct 10;
//       R50 $25 marked and reversed, then marked again for $10 (on the same Draft)
//   B   R11 $30 waiting; R51 $80 dated Sep 28 (closed September), carried
//   Op  R8 marked, then undone (voided)
async function seedLines(w) {
	addReceipt(w, { id: 50, type: "Food", amount: 25, date: "2026-10-12" });
	addReceipt(w, { id: 51, driver: "Test Driver B", type: "Fuel", amount: 80, date: "2026-09-28", vendor: "EXAMPLE FUEL #12", truck: "T-3", owner: 0 });
	const out = [];
	out.push(await w.call("POST", "/api/expenses/1/personal", { body: {} }));
	out.push(await w.call("POST", "/api/expenses/5/personal", { body: { amount: 50 } }));
	out.push(await w.call("POST", "/api/expenses/50/personal", { body: {} }));
	reverseByHand(w, 50);
	out.push(await w.call("POST", "/api/expenses/11/personal", { body: {} }));
	out.push(await w.call("POST", "/api/expenses/51/personal", { body: {} }));
	out.push(await w.call("POST", "/api/expenses/8/personal", { body: {} }));
	out.push(await w.call("DELETE", "/api/expenses/8/personal", { body: {} }));
	const g = await w.generate("Test Driver A");
	out.push(await w.call("POST", "/api/expenses/50/personal", { body: { amount: 10 } }));
	return { statuses: out.map((r) => r.status), generated: g.status };
}

(async () => {
	section("§1 roles: Super Admin only, on every route");
	{
		const w = world();
		const routes = [
			["POST", "/api/expenses/5/personal", {}],
			["DELETE", "/api/expenses/5/personal", {}],
			["POST", "/api/expenses/5/personal/reverse", {}],
			["POST", "/api/invoices/personal-corrections", { driver: "Test Driver A", weekStart: "2026-10-10" }],
		];
		for (const [method, url, body] of routes) {
			const got = [];
			for (const as of ["dispatcher", "driverA", "investor"]) got.push((await w.call(method, url, { as, body })).status);
			got.push((await w.call(method, url, { as: null, body })).status);
			const noHeader = await w.call(method, url, { body, headers: { "sec-fetch-site": "same-origin", host: "app.test" } });
			got.push([noHeader.status, noHeader.body && noHeader.body.code]);
			const crossSite = await w.call(method, url, { body, headers: { "x-requested-with": "XMLHttpRequest", "sec-fetch-site": "cross-site", origin: "https://evil.test", host: "app.test" } });
			got.push([crossSite.status, crossSite.body && crossSite.body.code]);
			check(`${method} ${url}: Dispatcher, Driver, Investor 403; signed out 401; no header 403; cross-site 403`,
				got, [403, 403, 403, 401, [403, "CSRF_HEADER_REQUIRED"], [403, "CROSS_SITE_REFUSED"]]);
		}
		check("…and none of them wrote a line", w.lines().length, 0);
		const ok = await w.call("POST", "/api/expenses/5/personal", { body: {} });
		check("Super Admin marks: 201", ok.status, 201);
		w.cleanup();
	}

	section("§2 T1 flag off: new marks refused, nothing written");
	for (const [label, env] of [["unset", {}], ["'1'", { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "1" }], ["'TRUE'", { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "TRUE" }]]) {
		const w = world(env);
		const r = await w.call("POST", "/api/expenses/1/personal", { body: {} });
		check(`flag ${label}: 403 PERSONAL_DISABLED`, [r.status, r.body && r.body.code], [403, "PERSONAL_DISABLED"]);
		check(`flag ${label}: no row, no audit row`, [w.lines().length, w.audits("mark_expense_personal").length], [0, 0]);
		w.cleanup();
	}

	section("§3 T3 amounts");
	{
		const w = world();
		for (const [label, amount, code] of [["0", 0, "PERSONAL_AMOUNT_INVALID"], ["-5", -5, "PERSONAL_AMOUNT_INVALID"],
			["200.01", 200.01, "PERSONAL_AMOUNT_TOO_LARGE"], ["12.345", 12.345, "PERSONAL_AMOUNT_INVALID"], ["'abc'", "abc", "PERSONAL_AMOUNT_INVALID"]]) {
			const r = await w.call("POST", "/api/expenses/1/personal", { body: { amount } });
			check(`${label}: 400 ${code}`, [r.status, r.body && r.body.code], [400, code]);
		}
		check("nothing written by a refused amount", w.lines().length, 0);
		const r = await w.call("POST", "/api/expenses/1/personal", { body: {} });
		check("absent: the whole receipt (20000 cents)", [r.status, w.lines()[0] && w.lines()[0].cents], [201, 20000]);
		w.cleanup();
	}

	section("§4 T4 a mark");
	{
		const w = world();
		const r = await w.call("POST", "/api/expenses/1/personal", { body: { reason: "Snacks and a phone charger" } });
		const [row] = w.lines();
		check("201", r.status, 201);
		check("the row: 20000 cents of a 20000-cent receipt, October in place, week of 2026-10-10, on no invoice yet",
			row && [row.kind, row.cents, row.receipt_cents, row.cost_period, row.in_place, row.week_start, row.invoice_id, row.book_date],
			["deduct", 20000, 20000, "2026-10", 1, "2026-10-10", null, "2026-10-12"]);
		check("the row snapshots the merchant and the receipt date", row && [row.merchant, row.receipt_date], ["Pilot #123", "2026-10-12"]);
		check("the row names the account", row && [row.created_by, row.created_by_id, row.created_role], ["super_admin", 1, "Super Admin"]);
		check("the receipt is untouched (amount, status)", w.db.prepare("SELECT amount, status FROM expenses WHERE id = 1").get(), { amount: 200, status: "Approved" });
		const audits = w.audits("mark_expense_personal");
		check("one mark_expense_personal audit row on the receipt", audits.map((a) => [a.entity, a.entity_id, a.username]), [["expense", "1", "super_admin"]]);
		check("…naming the amount, the receipt and the week", !!audits[0] && /\$200\.00/.test(audits[0].details) && /2026-10-10/.test(audits[0].details) && /Pilot #123/.test(audits[0].details), true);
		check("the response says where the line stands", r.body && r.body.personal && [r.body.personal.state, r.body.personal.week_start], ["pending", "2026-10-10"]);
		check("expenses and invoices are told to refresh", w.notifications.includes("expenses"), true);
		w.cleanup();
	}

	section("§5 T14 idempotent");
	{
		const w = world();
		await w.call("POST", "/api/expenses/1/personal", { body: { amount: 150 } });
		const again = await w.call("POST", "/api/expenses/1/personal", { body: { amount: 150 } });
		check("the same mark again: 200 alreadyMarked, still one row", [again.status, again.body && again.body.alreadyMarked, w.lines().length], [200, true, 1]);
		const other = await w.call("POST", "/api/expenses/1/personal", { as: "admin2", body: { amount: 150 } });
		check("the same amount by another account: 409 EXPENSE_ALREADY_PERSONAL", [other.status, other.body && other.body.code], [409, "EXPENSE_ALREADY_PERSONAL"]);
		const diff = await w.call("POST", "/api/expenses/1/personal", { body: { amount: 100 } });
		check("a different amount: 409 EXPENSE_ALREADY_PERSONAL, with the line on file", [diff.status, diff.body && diff.body.code, diff.body && diff.body.personal && diff.body.personal.cents], [409, "EXPENSE_ALREADY_PERSONAL", 15000]);
		w.cleanup();
	}
	{
		// The race: W41's invoice is Submitted, so the mark renders before it writes;
		// another mark of the same receipt lands during that render.
		const w = world();
		const g = await w.generate("Test Driver A");
		w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(g.body.invoice.id);
		w.hooks.render = async (t, d, def) => {
			w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
				VALUES (5, 'deduct', 1000, 30000, 'Pilot #123', '2026-10-11', '2026-10', 1, '2026-10-11', '2026-10-10', 't', 'ops_admin', 2, 'Super Admin')`).run();
			return def(t, d);
		};
		const r = await w.call("POST", "/api/expenses/5/personal", { body: {} });
		check("a mark that loses the race: 409, not 500", r.status, 409);
		check("…and only the winner's row exists", w.lines().map((l) => l.created_by), ["ops_admin"]);
		w.cleanup();
	}

	section("§6 T15 status interplay");
	{
		const w = world();
		const r2 = await w.call("POST", "/api/expenses/2/personal", { body: {} });
		check("marking Pending R2 (open month): 201, R2 now Approved", [r2.status, w.db.prepare("SELECT status FROM expenses WHERE id = 2").get().status], [201, "Approved"]);
		check("…two audit rows: the mark and the status change", [w.audits("mark_expense_personal").length, w.audits("update_expense_status").length], [1, 1]);
		await w.call("POST", "/api/expenses/1/personal", { body: {} });
		const rej = await w.call("PUT", "/api/expenses/1/status", { body: { status: "Rejected" } });
		check("Reject a marked receipt: 409 EXPENSE_PERSONAL", [rej.status, rej.body && rej.body.code], [409, "EXPENSE_PERSONAL"]);
		const pend = await w.call("PUT", "/api/expenses/1/status", { body: { status: "Pending" } });
		check("Set it Pending: 409 EXPENSE_PERSONAL", [pend.status, pend.body && pend.body.code], [409, "EXPENSE_PERSONAL"]);
		check("…R1 still Approved", w.db.prepare("SELECT status FROM expenses WHERE id = 1").get().status, "Approved");
		const appr = await w.call("PUT", "/api/expenses/1/status", { body: { status: "Approved" } });
		check("Approving it again is allowed", appr.status, 200);
		const bulk = await w.call("PUT", "/api/expenses/bulk-status", { body: { ids: [1, 5], status: "Rejected" } });
		check("bulk Reject [R1, R5]: R1 withheld and reported, R5 rejected",
			[bulk.status, bulk.body && bulk.body.updated, bulk.body && bulk.body.skippedPersonal, bulk.body && bulk.body.personalIds,
				w.db.prepare("SELECT status FROM expenses WHERE id = 1").get().status, w.db.prepare("SELECT status FROM expenses WHERE id = 5").get().status],
			[200, 1, 1, [1], "Approved", "Rejected"]);
		const r4 = await w.call("POST", "/api/expenses/4/personal", { body: {} });
		check("marking Rejected R4: 409 EXPENSE_REJECTED, nothing written", [r4.status, r4.body && r4.body.code, w.lines("expense_id = 4").length], [409, "EXPENSE_REJECTED", 0]);
		const r3 = await w.call("POST", "/api/expenses/3/personal", { body: {} });
		check("marking Pending R3 in closed August: 201, R3 keeps its status", [r3.status, w.db.prepare("SELECT status FROM expenses WHERE id = 3").get().status], [201, "Pending"]);
		check("…booked as a credit in the open month", w.lines("expense_id = 3").map((l) => [l.in_place, l.cost_period, l.book_date]), [[0, "2026-10", "2026-10-15"]]);
		const missing = await w.call("POST", "/api/expenses/999/personal", { body: {} });
		check("no such receipt: 404", missing.status, 404);
		w.cleanup();
	}

	section("§7 undo and reverse on a line not yet invoiced");
	{
		const w = world();
		await w.call("POST", "/api/expenses/1/personal", { body: {} });
		const rev = await w.call("POST", "/api/expenses/1/personal/reverse", { body: { reason: "x" } });
		check("reverse while it can still be undone: 409 PERSONAL_USE_UNDO", [rev.status, rev.body && rev.body.code], [409, "PERSONAL_USE_UNDO"]);
		const undo = await w.call("DELETE", "/api/expenses/1/personal", { body: { reason: "Marked by mistake" } });
		check("undo: 200", undo.status, 200);
		check("the row stays, voided, by the account", w.lines().map((l) => [l.voided_by, !!l.voided_at, l.void_reason]), [["super_admin", true, "Marked by mistake"]]);
		check("one undo_expense_personal audit row", w.audits("undo_expense_personal").map((a) => a.entity_id), ["1"]);
		const again = await w.call("DELETE", "/api/expenses/1/personal", { body: {} });
		check("nothing left to undo: 404", again.status, 404);
		const remark = await w.call("POST", "/api/expenses/1/personal", { body: { amount: 20 } });
		check("the receipt can be marked again after an undo", [remark.status, w.lines("voided_at = ''").map((l) => l.cents)], [201, [2000]]);
		w.cleanup();
	}

	section("§8 the user delete refuses while a Personal line points at the driver's receipts");
	{
		const w = world();
		const before = w.api.userDeleteLockBlockers ? null : "userDeleteLockBlockers not lifted";
		check("setup", before, null);
		await w.call("POST", "/api/expenses/11/personal", { body: {} });
		const del = await w.call("DELETE", "/api/users/8", { body: {} });
		check("DELETE /api/users/:id for driver B: 409 EXPENSE_PERSONAL_LINES", [del.status, del.body && del.body.code], [409, "EXPENSE_PERSONAL_LINES"]);
		check("…the user is still there", !!w.db.prepare("SELECT 1 FROM users WHERE id = 8").get(), true);
		w.cleanup();
		const w2 = world();
		const blockers = w2.api.userDeleteLockBlockers({ id: 8, role: "Driver", driver_name: "Test Driver B" }, "test driver b").blockers;
		check("without a line there is no such blocker", blockers.filter((b) => b.code === "EXPENSE_PERSONAL_LINES").length, 0);
		w2.cleanup();
	}

	section("§9 hooks for the screens");
	{
		const w = world();
		const off = buildPersonalWorld({ env: {} });
		check("GET /api/expenses/all: personalEnabled follows the flag",
			[(await w.call("GET", "/api/expenses/all")).body.personalEnabled, (await off.call("GET", "/api/expenses/all")).body.personalEnabled], [true, false]);
		off.cleanup();
		await w.call("POST", "/api/expenses/1/personal", { body: {} });
		await w.call("POST", "/api/expenses/5/personal", { body: { amount: 50 } });
		const all = (await w.call("GET", "/api/expenses/all")).body.expenses;
		const byId = Object.fromEntries(all.map((e) => [e.id, e]));
		check("a marked receipt carries its Personal state", byId[1].personal && [byId[1].personal.cents, byId[1].personal.week_start, byId[1].personal.state, byId[1].personal.invoice_number],
			[20000, "2026-10-10", "pending", ""]);
		check("…the receipt's own amount is unchanged in the admin list", byId[1].amount, 200);
		check("an unmarked receipt carries personal: null", byId[7].personal, null);
		const inv = (await w.call("GET", "/api/investor/expenses", { as: "investor", query: {} })).body.expenses;
		const invById = Object.fromEntries(inv.map((e) => [e.id, e]));
		check("T21 investor list: a fully personal receipt (open month) is hidden", 1 in invById, false);
		check("T21 …a partial one shows the company's share ($250.00 of $300.00)", invById[5] && invById[5].amount, 250);
		const summary = w.api.personalSummaryByExpense([1, 5, 7]);
		check("T22 the driver payload's summary: R1 and R5 carry their lines, R7 none",
			[summary[1] && summary[1].cents, summary[5] && summary[5].cents, summary[7] || null], [20000, 5000, null]);
		const driverRoute = SRC.slice(SRC.indexOf('\napp.get("/api/driver/:driverName", requireRole("Super Admin", "Driver"), async (req, res) => {') + 1);
		check("T22 GET /api/driver/:driverName adds each receipt's personal summary", /personalSummaryByExpense\(/.test(driverRoute.slice(0, driverRoute.indexOf("\n});\n"))), true);
		const asDriver = w.api.personalSummaryForRole(summary[1], "Driver");
		check("…driver-shaped: the state, amount, week and invoice; no share or books (in_place, cost_period)",
			[Object.keys(asDriver || {}).sort(), asDriver && asDriver.amount_text, asDriver && asDriver.week_label],
			[["amount_text", "cents", "invoice_number", "line_id", "state", "week_label", "week_start"], "$200.00", "Oct 10-16, 2026"]);
		check("…and the driver route passes each summary through personalSummaryForRole(…, \"Driver\")",
			/personalSummaryForRole\(personal\[e\.id\], "Driver"\)/.test(driverRoute.slice(0, driverRoute.indexOf("\n});\n"))), true);
		w.cleanup();
	}

	section("§10 every Personal route is rate limited, after its gate");
	{
		const heads = [
			'app.post("/api/expenses/:id/personal", requireRole("Super Admin"), refuseCrossOrigin, personalRouteLimiter, async (req, res) => {',
			'app.delete("/api/expenses/:id/personal", requireRole("Super Admin"), refuseCrossOrigin, personalRouteLimiter, async (req, res) => {',
			'app.post("/api/expenses/:id/personal/reverse", requireRole("Super Admin"), refuseCrossOrigin, personalRouteLimiter, async (req, res) => {',
			'app.post("/api/invoices/personal-corrections", requireRole("Super Admin"), refuseCrossOrigin, personalRouteLimiter, async (req, res) => {',
			'app.get("/api/expenses/personal/waiting-corrections", requireRole("Super Admin"), personalListLimiter, (req, res) => {',
			'app.get("/api/invoices/:id/personal-receipts/:lineId", requireAuth, personalReceiptLimiter, async (req, res) => {',
		];
		check("mark, undo, reverse, the correction: personalRouteLimiter; the waiting list its own personalListLimiter; the receipt: personalReceiptLimiter",
			heads.map((h) => SRC.split(`\n${h}\n`).length - 1), [1, 1, 1, 1, 1, 1]);
		const NAMES = ["personalRouteLimiter", "personalListLimiter", "personalReceiptLimiter"];
		const limiter = (name) => {
			const at = SRC.indexOf(`\nconst ${name} = rateLimit({`);
			return at < 0 ? "" : SRC.slice(at, SRC.indexOf("\n});", at));
		};
		check("…each an express-rate-limit with a window and a cap, declared before its first route",
			NAMES.map((n) => [/windowMs: [\d* ]+,/.test(limiter(n)), /max: \d+,/.test(limiter(n)), SRC.indexOf(`\nconst ${n} = rateLimit(`) < SRC.indexOf(`, ${n}, `)]),
			[[true, true, true], [true, true, true], [true, true, true]]);
		// One office shares one IP: each signed-in user has his own count, the IP
		// only for a request with no session (the gate has refused it by then).
		check("…each keyed per signed-in user, falling back to the IP",
			NAMES.map((n) => /keyGenerator: \(req\) => \{\s*const id = req\.session\?\.user\?\.id;\s*return id \? `u:\$\{id\}` : `ip:\$\{ipKeyGenerator\(req\.ip\)\}`;\s*\},/.test(limiter(n))),
			[true, true, true]);
		const cap = (n) => Number((limiter(n).match(/max: (\d+),/) || [])[1]);
		check("…the waiting list (re-read on every expenses or invoices change) has a read-sized cap, above the writes'",
			cap("personalListLimiter") > cap("personalRouteLimiter"), true);
	}

	section("§11 W1 the receipt's week: dated Oct 7, marked Thu Oct 15");
	{
		const w = world(WEEK_ON);
		addReceipt(w, { id: 20, date: "2026-10-07" });
		const r = await w.call("POST", "/api/expenses/20/personal", { body: {} });
		const row = w.lines()[0] || {};
		check("201; the line is keyed to the week of 2026-10-03 (the receipt's), not 2026-10-10 (the mark's)",
			[r.status, row.week_start, r.body && r.body.personal && r.body.personal.week_start], [201, "2026-10-03", "2026-10-03"]);
		const audit = w.audits("mark_expense_personal")[0];
		check("…and the mark's audit row names that week", !!audit && /week 2026-10-03/.test(audit.details), true);
		w.cleanup();
	}

	section("§12 pins: the week it is marked in, for no date, a date after today, or the flag not exactly \"true\"");
	{
		const w = world(WEEK_ON);
		addReceipt(w, { id: 21, type: "Fuel", vendor: "EXAMPLE FUEL #12", date: "" });
		addReceipt(w, { id: 22, type: "Fuel", vendor: "EXAMPLE FUEL #12", date: "2026-11-20" });
		const dateless = await w.call("POST", "/api/expenses/21/personal", { body: {} });
		const future = await w.call("POST", "/api/expenses/22/personal", { body: {} });
		check("a receipt with no date: 201, the week of 2026-10-10", [dateless.status, (w.lines("expense_id = 21")[0] || {}).week_start], [201, "2026-10-10"]);
		check("one dated 2026-11-20: 201, this week, never a future one", [future.status, (w.lines("expense_id = 22")[0] || {}).week_start], [201, "2026-10-10"]);
		w.cleanup();
	}
	for (const [label, env] of [["unset", ON], ["'1'", { ...ON, PERSONAL_RECEIPT_WEEK_ENABLED: "1" }], ["'TRUE'", { ...ON, PERSONAL_RECEIPT_WEEK_ENABLED: "TRUE" }]]) {
		const w = world(env);
		addReceipt(w, { id: 20, date: "2026-10-07" });
		await w.call("POST", "/api/expenses/20/personal", { body: {} });
		check(`PERSONAL_RECEIPT_WEEK_ENABLED ${label}: the Oct 7 receipt marked Thu Oct 15 keeps the week of 2026-10-10`, (w.lines()[0] || {}).week_start, "2026-10-10");
		w.cleanup();
	}

	section("§13 W10 once its invoice is approved the line is final");
	{
		const w = world(WEEK_ON);
		await w.call("POST", "/api/expenses/1/personal", { body: {} });
		const g = await w.generate("Test Driver A");
		const invoiceId = g.body.invoice.id;
		const number = g.body.invoice.invoice_number;
		w.db.prepare("UPDATE invoices SET status = 'Approved', approved_at = 't', approved_by = 'super_admin' WHERE id = ?").run(invoiceId);
		const listed = ((await w.call("GET", "/api/expenses/all")).body.expenses || []).find((e) => e.id === 1) || {};
		const p = listed.personal || {};
		check("Super Admin's summary: on the approved invoice, final, neither Undo nor Reverse",
			[p.state, p.invoice_number, p.final, p.can_undo, p.can_reverse], ["invoiced", number, true, false, false]);
		// Each refusal below writes nothing, so they run in an order today's code
		// cannot disturb either (its Reverse writes, so it goes last).
		const corr = await w.call("POST", "/api/invoices/personal-corrections", { body: { driver: "Test Driver A", weekStart: "2026-10-10" } });
		check("the corrections route: 410 PERSONAL_CORRECTIONS_RETIRED",
			[corr.status, corr.body && corr.body.code, corr.body && corr.body.error],
			[410, "PERSONAL_CORRECTIONS_RETIRED", "Correction invoices for Personal lines are retired: a line waits for the driver's next weekly invoice."]);
		const undo = await w.call("DELETE", "/api/expenses/1/personal", { body: {} });
		check("Undo: 409 PERSONAL_INVOICE_APPROVED, locked, with no \"Use Reverse\"",
			[undo.status, undo.body && undo.body.code, undo.body && undo.body.error],
			[409, "PERSONAL_INVOICE_APPROVED", `${number} is Approved, so this Personal line stays on it. Approved invoices are locked.`]);
		const status = await w.call("PUT", "/api/expenses/1/status", { body: { status: "Rejected" } });
		check("the receipt's status refusal offers no reversal",
			[status.status, status.body && status.body.code, /revers/i.test((status.body && status.body.error) || "")], [409, "EXPENSE_PERSONAL", false]);
		const rev = await w.call("POST", "/api/expenses/1/personal/reverse", { body: { reason: "not personal after all" } });
		check("Reverse: 409 PERSONAL_LOCKED",
			[rev.status, rev.body && rev.body.code, rev.body && rev.body.error], [409, "PERSONAL_LOCKED", "The invoice is approved, and approved invoices are locked."]);
		check("…nothing written: the one line on the approved invoice, no reversal, no correction invoice",
			[w.lines().map((l) => [l.kind, l.invoice_id === invoiceId, l.reversed_by_id]), w.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE is_correction = 1").get().n],
			[[["deduct", true, null]], 0]);
		w.cleanup();
	}
	{
		const w = world(WEEK_ON);
		const g = await w.generate("Test Driver A");
		w.db.prepare("UPDATE invoices SET status = 'Approved', approved_at = 't', approved_by = 'super_admin' WHERE id = ?").run(g.body.invoice.id);
		await w.call("POST", "/api/expenses/1/personal", { body: {} });
		const undo = await w.call("DELETE", "/api/expenses/1/personal", { body: { reason: "Marked by mistake" } });
		check("pin: a line marked on an approved week, still on no approved invoice: Undo 200, voided, on no invoice",
			[undo.status, w.lines().map((l) => [!!l.voided_at, l.invoice_id])], [200, [[true, null]]]);
		w.cleanup();
	}

	section("§14 W17 the mark's audit row says why it keeps the week it is marked in");
	{
		const w = world(WEEK_ON);
		addReceipt(w, { id: 21, type: "Fuel", vendor: "EXAMPLE FUEL #12", date: "" });
		addReceipt(w, { id: 22, type: "Fuel", vendor: "EXAMPLE FUEL #12", date: "2026-11-20" });
		await w.call("POST", "/api/expenses/21/personal", { body: {} });
		await w.call("POST", "/api/expenses/22/personal", { body: {} });
		const details = (id) => (w.audits("mark_expense_personal").find((a) => a.entity_id === String(id)) || {}).details || "";
		check("no receipt date: \"week 2026-10-10 (no receipt date: the week it was marked in)\"",
			/week 2026-10-10 \(no receipt date: the week it was marked in\)/.test(details(21)), true);
		check("dated 2026-11-20: \"week 2026-10-10 (dated after today: this week)\"",
			/week 2026-10-10 \(dated after today: this week\)/.test(details(22)), true);
		w.cleanup();
	}

	section("§15 W18 personalReceiptWeek follows the flag, for the Mark dialog");
	{
		const got = [];
		for (const env of [WEEK_ON, ON, { ...ON, PERSONAL_RECEIPT_WEEK_ENABLED: "1" }]) {
			const w = world(env);
			got.push((await w.call("GET", "/api/expenses/all")).body.personalReceiptWeek);
			w.cleanup();
		}
		check("GET /api/expenses/all: personalReceiptWeek true only when the flag is exactly \"true\"", got, [true, false, false]);
	}

	section("§16 the status recorder off: the mark's write is today's");
	for (const [label, env] of [["unset", ON], ["'1'", { ...ON, RECEIPT_STATUS_RECORDER_ENABLED: "1" }], ["'TRUE'", { ...ON, RECEIPT_STATUS_RECORDER_ENABLED: "TRUE" }]]) {
		const w = world(env);
		const seen = [];
		const prepare = w.db.prepare.bind(w.db);
		w.db.prepare = (sql) => { seen.push(sql); return prepare(sql); };
		const r = await w.call("POST", "/api/expenses/2/personal", { body: {} });
		w.db.prepare = prepare;
		check(`recorder ${label}: marking Pending R2 approves it, as today`, [r.status, statusOf(w, 2)], [201, "Approved"]);
		check(`recorder ${label}: its one status write is today's statement exactly`,
			seen.filter((s) => /^\s*UPDATE expenses\b/.test(s)), ["UPDATE expenses SET status = 'Approved' WHERE id = ? AND status = 'Pending'"]);
		check(`recorder ${label}: no statement names a recorder column`, seen.filter((s) => /status_by_|status_at/.test(s)), []);
		check(`recorder ${label}: R2 keeps the four columns empty`, stampOf(w, 2), EMPTY_STAMP);
		check(`recorder ${label}: the approval's audit row, as today`, w.audits("update_expense_status").map((a) => a.entity_id), ["2"]);
		w.cleanup();
	}

	section("§17 the status recorder on: the mark records the marker, in open months only");
	{
		const w = world(RECORDER_ON);
		const r2 = await w.call("POST", "/api/expenses/2/personal", { body: {} });
		const s2 = stampOf(w, 2);
		check("a mark on Pending R2 (open month): 201, approved, the marker recorded", [r2.status, statusOf(w, 2), Array.isArray(s2) ? s2.slice(0, 3) : s2], [201, "Approved", MARKER]);
		// The world's clock: the stamp is taken at the write, no earlier than the line it placed.
		const line2 = w.lines("expense_id = 2")[0] || {};
		check("…at the write, ISO-8601 UTC", Array.isArray(s2) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s2[3]) && s2[3] >= String(line2.created_at || "~"), true);
		check("…and its implied approval audited once", w.audits("update_expense_status").map((a) => [a.entity_id, /Pending -> Approved \(marked Personal/.test(a.details)]), [["2", true]]);

		const r1 = await w.call("POST", "/api/expenses/1/personal", { body: {} });
		const s1 = stampOf(w, 1);
		check("a mark on Approved R1: 201, still Approved, the marker recorded", [r1.status, statusOf(w, 1), Array.isArray(s1) ? s1.slice(0, 3) : s1], [201, "Approved", MARKER]);
		check("…and no \"Pending -> Approved\" row for R1", w.audits("update_expense_status").filter((a) => a.entity_id === "1").length, 0);

		const rej = await w.call("PUT", "/api/expenses/1/status", { as: "dispatcher", body: { status: "Rejected" } });
		check("a status write refused for the Personal line (409 EXPENSE_PERSONAL) records nothing", [rej.status, rej.body && rej.body.code, stampOf(w, 1)], [409, "EXPENSE_PERSONAL", s1]);

		const before3 = w.db.prepare("SELECT * FROM expenses WHERE id = 3").get();
		const r3 = await w.call("POST", "/api/expenses/3/personal", { body: {} });
		check("a mark on Pending R3 in closed August: 201, a credit in the open month", [r3.status, w.lines("expense_id = 3").map((l) => l.in_place)], [201, [0]]);
		check("…and R3's row is byte for byte as it was", w.db.prepare("SELECT * FROM expenses WHERE id = 3").get(), before3);

		addReceipt(w, { id: 30, type: "Fuel", vendor: "EXAMPLE FUEL #12", date: "2026-08-20" });
		w.db.prepare("UPDATE expenses SET status = 'Pending', posted_period = '2026-10' WHERE id = 30").run();
		const r30 = await w.call("POST", "/api/expenses/30/personal", { body: {} });
		check("a mark on a receipt dated in closed August, booked to October: approved as today, nothing recorded",
			[r30.status, statusOf(w, 30), stampOf(w, 30), w.audits("update_expense_status").filter((a) => a.entity_id === "30").length], [201, "Approved", EMPTY_STAMP, 1]);
		w.cleanup();
	}
	{
		// Pending when marked; a person approves it while the invoice is drawn.
		const w = world(RECORDER_ON);
		addReceipt(w, { id: 40, type: "Fuel", vendor: "EXAMPLE FUEL #12", date: "2026-10-12", amount: 45.5 });
		w.db.prepare("UPDATE expenses SET status = 'Pending' WHERE id = 40").run();
		const g = await w.generate("Test Driver A");
		w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(g.body.invoice.id);
		let drawn = 0;
		w.hooks.render = async (t, d, def) => { drawn++; personSets(w, 40, "Approved"); return def(t, d); };
		const r = await w.call("POST", "/api/expenses/40/personal", { body: {} });
		const s = stampOf(w, 40);
		check("a person approves during the mark's render: 201, Approved, the marker recorded last",
			[r.status, drawn > 0, statusOf(w, 40), Array.isArray(s) ? s.slice(0, 3) : s], [201, true, "Approved", MARKER]);
		check("…and the mark writes no \"Pending -> Approved\" row (it approved nothing)", w.audits("update_expense_status").filter((a) => a.entity_id === "40").length, 0);
		w.cleanup();
	}
	{
		// Approved when marked; a person undoes it to Pending while the invoice is drawn.
		const w = world(RECORDER_ON);
		addReceipt(w, { id: 41, type: "Fuel", vendor: "EXAMPLE FUEL #12", date: "2026-10-12", amount: 45.5 });
		const g = await w.generate("Test Driver A");
		w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(g.body.invoice.id);
		let drawn = 0;
		w.hooks.render = async (t, d, def) => { drawn++; personSets(w, 41, "Pending"); return def(t, d); };
		const r = await w.call("POST", "/api/expenses/41/personal", { body: {} });
		check("a person's Undo during the mark's render stands: Pending, the person still recorded, no audit row",
			[r.status, drawn > 0, statusOf(w, 41), stampOf(w, 41), w.audits("update_expense_status").filter((a) => a.entity_id === "41").length],
			[201, true, "Pending", ["Dispatcher", 2, "dispatch_a", "2026-10-15T16:00:00.000Z"], 0]);
		w.cleanup();
	}
	{
		// Dated in closed August, booked to October, Approved when marked; a person
		// undoes it while the invoice is drawn. The mark approves only what it found Pending.
		const w = world(RECORDER_ON);
		addReceipt(w, { id: 42, type: "Fuel", vendor: "EXAMPLE FUEL #12", date: "2026-08-20", amount: 45.5 });
		w.db.prepare("UPDATE expenses SET posted_period = '2026-10' WHERE id = 42").run();
		const g = await w.generate("Test Driver A");
		w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(g.body.invoice.id);
		let drawn = 0;
		w.hooks.render = async (t, d, def) => { drawn++; personSets(w, 42, "Pending"); return def(t, d); };
		const r = await w.call("POST", "/api/expenses/42/personal", { body: {} });
		check("…the same Undo on a receipt booked out of a closed month stands too: Pending, the person recorded, no audit row",
			[r.status, drawn > 0, statusOf(w, 42), stampOf(w, 42), w.audits("update_expense_status").filter((a) => a.entity_id === "42").length],
			[201, true, "Pending", ["Dispatcher", 2, "dispatch_a", "2026-10-15T16:00:00.000Z"], 0]);
		w.cleanup();
	}
	{
		// The rule itself: no stamp unless the line is placed in place, whatever the row's months.
		const w = world(RECORDER_ON);
		let out;
		try {
			const recorder = require("../lib/receipt-status-recorder");
			out = recorder.markPersonalWrite(w.db, { id: 1, user: { id: 1, username: "super_admin", role: "Super Admin" }, at: "2026-10-15T17:00:00.000Z", inPlace: false, approve: false, rowLocked: () => false });
		} catch (e) {
			out = `unavailable: ${e.message}`;
		}
		check("a line not placed in place stamps nothing, even on an Approved receipt in an open month",
			[out, stampOf(w, 1), statusOf(w, 1)], [{ approved: false, stamped: false }, EMPTY_STAMP, "Approved"]);
		w.cleanup();
	}

	section("§18 the Personal tab's list: Super Admin only, refused before any read");
	{
		const w = world(WEEK_ON, { extra: LINES_EXTRA });
		await w.call("POST", "/api/expenses/1/personal", { body: {} });
		const seen = [];
		const prepare = w.db.prepare.bind(w.db);
		w.db.prepare = (sql) => { seen.push(sql); return prepare(sql); };
		const got = [];
		for (const as of ["dispatcher", "driverA", "investor", null]) {
			const r = await readLines(w, {}, as);
			got.push([r.status, r.body && r.body.lines !== undefined]);
		}
		w.db.prepare = prepare;
		check("Dispatcher, Driver, Investor 403; signed out 401; none gets a list", got, [[403, false], [403, false], [403, false], [401, false]]);
		check("…and nothing was read for them", seen, []);
		const ok = await readLines(w);
		check("Super Admin: 200 with the one line", [ok.status, listed(ok)], [200, [[1, "pending"]]]);
		check("the route is mounted with requireRole(\"Super Admin\") first, then its own limiter", SRC.split(`\n${LINES_HEAD}\n`).length - 1, 1);
		const at = SRC.indexOf("\nconst personalLinesLimiter = rateLimit({");
		const decl = at < 0 ? "" : SRC.slice(at, SRC.indexOf("\n});", at));
		check("…a read-sized express-rate-limit, per signed-in user (the IP only without a session), declared before the route",
			[/windowMs: [\d* ]+,/.test(decl), Number((decl.match(/max: (\d+),/) || [])[1]) >= 600,
				/keyGenerator: \(req\) => \{\s*const id = req\.session\?\.user\?\.id;\s*return id \? `u:\$\{id\}` : `ip:\$\{ipKeyGenerator\(req\.ip\)\}`;\s*\},/.test(decl),
				at >= 0 && at < SRC.indexOf(`\n${LINES_HEAD}`)],
			[true, true, true, true]);
		w.cleanup();
	}

	section("§19 the Personal tab's list, the receipt's week on: each line, its state, and the total");
	{
		const w = world(WEEK_ON, { extra: LINES_EXTRA });
		const seeded = await seedLines(w);
		check("setup: the marks, the undo, the generation and the second mark of R50 all went through", seeded, { statuses: [201, 201, 201, 201, 201, 201, 200, 201], generated: 200 });
		const all = await readLines(w);
		check("all drivers: one row per line, newest receipt date first (R50's reversed line and its new one both listed; R8's voided line not)",
			[all.status, listed(all)], [200, [[11, "pending"], [50, "invoiced"], [50, "reversed"], [1, "invoiced"], [5, "invoiced"], [51, "carried"]]]);
		check("…the total counts every line but the reversed one: $30 + $10 + $200 + $50 + $80",
			totalsOf(all), totals(37000, "$370.00", 5, 2500, "$25.00", 1));
		check("…the driver box lists each driver with a line (Op's only line is voided)", all.body && all.body.drivers, ["Test Driver A", "Test Driver B"]);
		const byLine = (r, expenseId, state) => ((r.body && r.body.lines) || []).find((l) => l.expense_id === expenseId && l.personal && l.personal.state === state) || {};
		check("each row names the receipt's driver, its date and the line's merchant",
			[[1, "invoiced"], [51, "carried"]].map(([id, s]) => { const l = byLine(all, id, s); return [l.driver, l.receipt_date, l.merchant]; }),
			[["Test Driver A", "2026-10-12", "Pilot #123"], ["Test Driver B", "2026-09-28", "EXAMPLE FUEL #12"]]);
		const carried = byLine(all, 51, "carried").personal || {};
		check("the carried line says why, in the server's words",
			[carried.amount_text, carried.wait_text], ["$80.00", "the week of Sep 26 - Oct 2, 2026 touches closed September; it goes on the next weekly invoice"]);
		const onDraft = byLine(all, 1, "invoiced").personal || {};
		check("a line on the Draft names its invoice and is not final", [/^\S+$/.test(String(onDraft.invoice_number || "")), onDraft.final], [true, false]);
		const rows = Object.fromEntries(((await w.call("GET", "/api/expenses/all")).body.expenses || []).map((e) => [e.id, e]));
		const strip = (p) => { if (!p) return null; const { can_undo, can_reverse, ...rest } = p; return rest; };
		check("each live line carries exactly the summary its receipt shows on All Expenses (less the Undo and Reverse buttons' fields)",
			[[1, "invoiced"], [5, "invoiced"], [50, "invoiced"], [11, "pending"], [51, "carried"]].map(([id, s]) => JSON.stringify(byLine(all, id, s).personal) === JSON.stringify(strip(rows[id] && rows[id].personal))),
			[true, true, true, true, true]);
		const wire = JSON.parse(JSON.stringify(all.body || {}));
		check("…and on the wire no row carries the ledger row behind it", (wire.lines || []).some((l) => "row" in (l.personal || {}) || "created_by" in l || "created_by" in (l.personal || {})), false);

		const a = await readLines(w, { driver: "Test Driver A" });
		check("Test Driver A: his four lines, $260.00 over 3 (the reversed $25.00 apart)",
			[listed(a), totalsOf(a)], [[[50, "invoiced"], [50, "reversed"], [1, "invoiced"], [5, "invoiced"]], totals(26000, "$260.00", 3, 2500, "$25.00", 1)]);
		const spelled = await readLines(w, { driver: "  test   DRIVER a " });
		check("…any spelling of his name finds the same lines", [listed(spelled), totalsOf(spelled)], [listed(a), totalsOf(a)]);
		const b = await readLines(w, { driver: "Test Driver B" });
		check("Test Driver B: waiting and carried, $110.00 over 2, nothing reversed", [listed(b), totalsOf(b)], [[[11, "pending"], [51, "carried"]], totals(11000, "$110.00", 2, 0, "$0.00", 0)]);
		const bOct = await readLines(w, { driver: "Test Driver B", from: "2026-10-01", to: "2026-10-31" });
		check("…from Oct 1 to Oct 31 on the receipt date: R11 only, $30.00", [listed(bOct), totalsOf(bOct)], [[[11, "pending"]], totals(3000, "$30.00", 1, 0, "$0.00", 0)]);
		const bEdges = await readLines(w, { driver: "Test Driver B", from: "2026-09-28", to: "2026-10-13" });
		check("…from Sep 28 to Oct 13, the two receipt dates themselves: both lines (each end counts)", listed(bEdges), [[11, "pending"], [51, "carried"]]);
		const sep = await readLines(w, { to: "2026-09-30" });
		check("all drivers to Sep 30: R51 only", [listed(sep), totalsOf(sep)], [[[51, "carried"]], totals(8000, "$80.00", 1, 0, "$0.00", 0)]);
		const op = await readLines(w, { driver: "Test Owner Op" });
		check("Test Owner Op (his one line undone): no rows, $0.00", [op.status, listed(op), totalsOf(op)], [200, [], totals(0, "$0.00", 0, 0, "$0.00", 0)]);
		const before = JSON.stringify(w.db.prepare("SELECT * FROM expense_personal ORDER BY id").all());
		const auditsBefore = w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n;
		const n = w.notifications.length;
		await readLines(w);
		await readLines(w, { driver: "Test Driver A" });
		check("reading writes nothing: the ledger, the audit trail and the notifications as they were",
			[JSON.stringify(w.db.prepare("SELECT * FROM expense_personal ORDER BY id").all()) === before, w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n, w.notifications.length],
			[true, auditsBefore, n]);
		w.cleanup();
	}

	section("§20 the Personal tab's list: refusals");
	{
		const w = world(WEEK_ON, { extra: LINES_EXTRA });
		await w.call("POST", "/api/expenses/1/personal", { body: {} });
		const refused = [];
		for (const query of [{ from: "2026-13-01" }, { to: "2026-02-30" }, { from: "10/01/2026" }, { from: ["2026-10-01", "2026-10-02"] }]) {
			const r = await readLines(w, query);
			refused.push([r.status, r.body && r.body.code]);
		}
		check("a date that is not a real YYYY-MM-DD: 400 INVALID_DATE", refused, [[400, "INVALID_DATE"], [400, "INVALID_DATE"], [400, "INVALID_DATE"], [400, "INVALID_DATE"]]);
		const drivers = [];
		for (const driver of [["Test Driver A", "Test Driver B"], "x".repeat(101), { a: 1 }]) {
			const r = await readLines(w, { driver });
			drivers.push([r.status, r.body && r.body.code]);
		}
		check("a driver that is not one string of at most 100 characters: 400 INVALID_DRIVER", drivers, [[400, "INVALID_DRIVER"], [400, "INVALID_DRIVER"], [400, "INVALID_DRIVER"]]);
		const fits = await readLines(w, { driver: "x".repeat(100) });
		check("…100 characters is a driver with no lines", [fits.status, listed(fits)], [200, []]);
		// Made-up reversed $1.00 lines dated Jan 5 (reversed, so no live-line index stands in the way).
		const ins = w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, reversed_by_id, created_at, created_by, created_by_id, created_role)
			VALUES (5, 'deduct', 100, 30000, 'Pilot #123', '2026-01-05', '2026-01', 1, '2026-01-05', '2026-01-03', 999999, 't', 'super_admin', 1, 'Super Admin')`);
		w.db.transaction(() => { for (let i = 0; i < 4999; i++) ins.run(); })();
		const full = await readLines(w);
		check("exactly 5,000 lines in the dates: 200, all listed, R1's $200.00 counted and the 4,999 reversed apart",
			[full.status, ((full.body && full.body.lines) || []).length, totalsOf(full)], [200, 5000, totals(20000, "$200.00", 1, 499900, "$4,999.00", 4999)]);
		ins.run();
		const many = await readLines(w);
		check("more than 5,000 lines in the dates: 422 PERSONAL_LINES_TOO_MANY, no list and no total",
			[many.status, many.body && many.body.code, many.body && many.body.lines, many.body && many.body.totals], [422, "PERSONAL_LINES_TOO_MANY", undefined, undefined]);
		const narrowed = await readLines(w, { from: "2026-10-01" });
		check("…narrowed to October: 200, R1's line", [narrowed.status, listed(narrowed)], [200, [[1, "pending"]]]);
		w.cleanup();
	}

	section("§21 the marks switched off, and the receipt's week off: the lines still list");
	{
		const w = world({}, { extra: LINES_EXTRA });
		w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
			VALUES (1, 'deduct', 1500, 20000, 'Pilot #123', '2026-10-12', '2026-10', 1, '2026-10-12', '2026-10-10', 't', 'super_admin', 1, 'Super Admin')`).run();
		const r = await readLines(w);
		check("marks off: a line marked before still lists, with its total", [r.status, listed(r), totalsOf(r)], [200, [[1, "pending"]], totals(1500, "$15.00", 1, 0, "$0.00", 0)]);
		w.cleanup();
		const w2 = world(ON, { extra: LINES_EXTRA });
		await w2.call("POST", "/api/expenses/1/personal", { body: {} });
		const r2 = await readLines(w2);
		const p = (r2.body && r2.body.lines && r2.body.lines[0] && r2.body.lines[0].personal) || {};
		check("the receipt's week off: the line lists as the receipts show it (no wait_text or final)", [r2.status, p.state, "wait_text" in p, "final" in p], [200, "pending", false, false]);
		w2.cleanup();
	}

	finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
