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
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-personal-expense-routes.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const { buildPersonalWorld, makeChecker, SRC } = require("./lib/personal-world");
const { check, section, finish } = makeChecker();

const ON = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" };
const world = (env = ON, opts = {}) => buildPersonalWorld({ env, ...opts });

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

	finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
