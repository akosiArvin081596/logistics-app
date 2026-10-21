#!/usr/bin/env node
/**
 * B12 runner B: the trip-timestamp work-day rule on the three pay paths (plan
 * section 4.1(2)-(8), cases B1-B14; B15-B21 for the owner's late-day rule of
 * 2026-10-14; B22 for its floor, FROM's first week, of 2026-10-15; B23-B24 for
 * a week invoiced before the switch-on), behind
 * TRIP_WORK_DAYS_ENABLED and TRIP_WORK_DAYS_FROM
 * (FROM=2026-09 unless a case says otherwise).
 * Written before the fix, which they failed. On main the flags are ignored, so the
 * new-rule cases fail with today's days (the reproduction); B7, B8 and B11 pin
 * today's behaviour and pass on main.
 *
 * The weekly invoice (generateInvoiceHandler()), the investor view (GET
 * /api/investor) and the payout ledger (computeInvestorMonthlyEarnings()) run as
 * the server runs them, lifted from server.js (lib/work-days-world.js beside this runner),
 * on one in-memory SQLite and one Job Tracking sheet. Investor 5 owns every truck;
 * daily rate $260 unless stated. Weeks: W39 Sat 9/26-Fri 10/2, W40 10/3-10/9.
 *
 * What the cases expect from the fix (from the plan):
 *   - a completed load settling in FROM or later (its Assigned month, or the day's
 *     own month with no Assigned Date) pays its trip days (lib/trip-work-days.js),
 *     with no ELD intersection and no pre-dispatch filter, on all three paths,
 *     even with blank appointments or Assigned Date;
 *   - a load settling before FROM pays exactly as today;
 *   - ledger and investor view: a day in a bucket month that is FROM or later is
 *     dropped when a load with an earlier Assigned month pays it (earliest wins);
 *   - invoice: the week pays every trip day of the driver's completed loads that
 *     falls in it; Total Due is the sum of each day's own rate (pay_rate_history);
 *   - a day that became payable after its week's invoice was made NEVER goes on a
 *     later week's invoice (the owner's rule, 2026-10-14, replacing the plan's
 *     "earlier days"): a Super Admin's run (the Friday batch included) puts it on
 *     that week's own invoice in place while it is not approved (Draft,
 *     Submitted, Rejected; status kept), or on a separate correction invoice for
 *     that week, a Draft, once it is approved or when its week touches a closed
 *     month; a day in a closed month is not carried and is named in `warnings`.
 * Each daily-rate case also checks that the invoices, the investor view and the
 * ledger pay the same driver-days (as days: the invoice grid names every load
 * behind a day, the ledger the first). B11 is percentage pay (no day grid); a day
 * refused for a closed month (B12's add row, B14) is paid by no invoice by design.
 *
 * [Qn] in a title: the expected days follow the plan's recommended answer to open
 * question n. Made-up data only. Pure: no server, no app.db, no network.
 *
 * Rule d (pay plan 2026-10-21, sections 1 and "Added 2026-10-21"): P1 runs the
 * rule-d shapes of scripts/test-trip-work-days-rule-d.js through the three paths
 * (the same days on each), P2 pins the flags-off paths, P3 (a control) the late-day
 * settle never adding a day a live manual invoice holds. M1 keeps a day named on a
 * manual invoice a Super Admin deleted (the MR 10/2 shape) out of every automatic
 * correction; M2-M4 make the weekly invoice, the flag on or off, leave off a day a
 * live manual invoice already pays (a line dated that day, or its paidDays). B10's
 * no-trip load and B20's soft-deleted manual invoice follow those rules (the rule
 * changed, not the case; each title says how).
 * Run: node scripts/test-trip-work-days-pay-paths.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const path = require("path");
const W = require("./lib/work-days-world");
const { loadRow, et, etMs, daysFrom } = W;

const TRIP = (from = "2026-09") => ({ TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: from });
const W39 = "2026-10-02";
const W40 = "2026-10-09";
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
const s = (lid, status, at, source = "manual", actor = "") => [lid, status, source, at, actor];
const invDays = (g, weekEnd) => [...W.gridDays(g.data, weekEnd), ...W.earlierDays(g.data)].map((e) => e.day).sort();
const uniq = (a) => [...new Set(a)].sort();

// The driver's paid days on the ledger and the investor view, as "YYYY-MM day".
async function monthViews(world, driver) {
	const led = await W.ledger(world);
	const inv = await W.investorDays(world);
	return { ledger: W.monthDays(led.pay, norm(driver)), investor: W.monthDays(inv.days, norm(driver)), led, inv };
}
const daysOnly = (pairs) => uniq(pairs.map((x) => x.split(" ")[1]));
// The three paths pay the same driver-days (within `scope` days, minus `except`).
function parity(eq, invoiceDays, views, scope, except = []) {
	const keep = (d) => scope.includes(d) && !except.includes(d);
	eq("parity: invoice days = ledger days", uniq(invoiceDays).filter(keep), daysOnly(views.ledger).filter(keep));
	eq("parity: ledger days = investor-view days", daysOnly(views.ledger).filter(keep), daysOnly(views.investor).filter(keep));
}
const WEEK39 = daysFrom("2026-09-26", "2026-10-02");
const WEEK40 = daysFrom("2026-10-03", "2026-10-09");

// The owner's rule for a late day (2026-10-14): it goes on its own week's
// invoice (in place while that invoice is not approved) or on a correction
// invoice for that week, never on a later week's invoice.
const invoiceRow = (w, id) => w.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
// The paid grid days of a stored invoice: [{ day, loads, total }].
const storedGrid = (w, id, weekEnd) => W.gridDays(JSON.parse(invoiceRow(w, id).render_data || "{}"), weekEnd);
// The work-day correction invoices (manual rows correcting a weekly invoice).
const corrections = (w) => w.db.prepare("SELECT * FROM invoices WHERE is_manual = 1 AND correction_of IS NOT NULL AND deleted_at = '' ORDER BY id").all();
const paidDaysOf = (row) => JSON.parse(row.render_data || "{}").paidDays || [];
const claimRows = (w) => w.db.prepare("SELECT day, invoice_id FROM invoice_paid_days ORDER BY day").all().map((r) => [r.day, r.invoice_id]);
// W39 has a Mon-Tue load; a load At Shipper Thu 10/1 is still In Transit when
// W39 is made (Fri 10/2 20:00 ET) and is delivered Mon 10/5.
function boundaryWorld(D, extra = {}) {
	return W.startWorld({
		env: TRIP(),
		drivers: [{ name: D }],
		rows: [
			loadRow({ id: "Q301", driver: D, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
			loadRow({ id: "Q302", driver: D, pickup: "2026-10-01 9:00", dropoff: "2026-10-05 14:00", assigned: "2026-10-01", done: "", status: "In Transit", truck: "T1" }),
		],
		status: [
			s("Q301", "At Shipper", "2026-09-28 12:00:00"), s("Q301", "Delivered", "2026-09-29 21:00:00"),
			s("Q302", "At Shipper", "2026-10-01 14:00:00"), s("Q302", "In Transit", "2026-10-01 18:00:00"),
		],
		now: etMs("2026-10-02 20:00"),
		...extra,
	});
}
function deliverBoundaryLoad(w) {
	w.addStatus([s("Q302", "At Receiver", "2026-10-05 15:00:00"), s("Q302", "Delivered", "2026-10-05 17:00:00")]);
	w.setRow("Q302", { "Job Status": "Delivered", "Status Update Date": "10/5/2026", "Completion Date": "10/5/2026" });
	w.clock.ms = etMs("2026-10-09 20:00");
}

// Rule d's shapes (scripts/test-trip-work-days-rule-d.js), one driver and truck
// each, in week W41 (Sat 10/10-Fri 10/16), with each truck's ELD feed (P1, P2).
// `want` is each driver's paid days under rule d.
const W41 = "2026-10-16";
const RECEIVER = { lat: 29.4, lng: -98.4 }; // every load's drop-off in load_coordinates
function ruleDWorld(env) {
	const [SAT, SUN, MON, TUE, WED, THU, FRI] = daysFrom("2026-10-10", W41);
	const shapes = [
		{ driver: "Abe Heading", pickup: TUE, dropoff: WED, assigned: MON, done: WED, want: [MON, TUE, WED], // D01
			status: [["Dispatched", MON, "08:00"], ["Heading to Shipper", MON, "09:30"], ["At Shipper", TUE, "08:00"], ["Loading", TUE, "09:00"], ["In Transit", TUE, "13:00"], ["At Receiver", WED, "10:00"], ["Delivered", WED, "11:30"]],
			feed: (f) => f.drive(MON, { miles: 200 }).drive(TUE, { miles: 250 }).drive(WED, { miles: 150 }) },
		{ driver: "Bea Walk", pickup: TUE, dropoff: WED, assigned: SAT, done: WED, want: [SUN, MON, TUE, WED], // D03
			status: [["Dispatched", SAT, "12:00"], ["At Shipper", MON, "16:00"], ["Loading", TUE, "08:00"], ["In Transit", TUE, "11:00"], ["At Receiver", WED, "09:00"], ["Delivered", WED, "10:00"]],
			feed: (f) => f.park(SAT).drive(SUN, { miles: 300 }).drive(MON, { miles: 300 }).drive(TUE, { miles: 200 }).drive(WED, { miles: 100 }) },
		{ driver: "Cy Wait", pickup: MON, dropoff: THU, assigned: MON, done: THU, want: [MON, WED, THU], // D07
			status: [["At Shipper", MON, "10:00"], ["Loading", WED, "08:00"], ["In Transit", WED, "12:00"], ["At Receiver", THU, "14:00"], ["Delivered", THU, "15:00"]],
			feed: (f) => f.drive(MON, { miles: 200 }).park(TUE).drive(WED, { miles: 200 }).drive(THU, { miles: 200 }) },
		{ driver: "Dee Dock", pickup: MON, dropoff: TUE, assigned: MON, done: THU, want: [MON, TUE, THU], coords: true, // D08: leaves the receiver Thu 11:00 ET
			status: [["At Shipper", MON, "08:00"], ["Loading", MON, "09:00"], ["In Transit", MON, "12:00"], ["At Receiver", TUE, "16:00"], ["Delivered", THU, "10:00"]],
			feed: (f) => f.drive(MON, { miles: 300 }).drive(TUE, { miles: 250, to: 14 }).drive(TUE, { from: 15, to: 18, at: RECEIVER })
				.drive(WED, { at: RECEIVER }).drive(THU, { from: 7, to: 9, at: RECEIVER }).drive(THU, { miles: 100, from: 10, to: 16 }) },
		{ driver: "Eli Rest", pickup: MON, dropoff: WED, assigned: MON, done: WED, want: [MON, WED], // D10
			status: [["At Shipper", MON, "08:00"], ["Loading", MON, "09:00"], ["In Transit", MON, "12:00"], ["At Receiver", WED, "15:00"], ["Delivered", WED, "16:00"]],
			feed: (f) => f.drive(MON, { miles: 300 }).park(TUE).drive(WED, { miles: 300 }) },
		{ driver: "Fay Appt", pickup: MON, dropoff: THU, assigned: MON, done: THU, want: [MON, TUE, THU], status: [], // D11: no status rows
			feed: (f) => f.park(MON).drive(TUE, { miles: 300 }).park(WED).park(THU) },
		{ driver: "Gil Part", pickup: MON, dropoff: WED, assigned: MON, done: WED, want: [MON, TUE, WED], status: [["Delivered", WED, "14:00"]], // D13
			feed: (f) => f.park(MON).drive(TUE, { miles: 300 }).park(WED) },
		{ driver: "Hal Late", pickup: MON, dropoff: TUE, assigned: MON, done: FRI, want: [MON, TUE, FRI], // D27: Delivered tapped 3 days late, no receiver coordinates
			status: [["At Shipper", MON, "09:00"], ["Loading", MON, "10:00"], ["In Transit", MON, "12:00"], ["At Receiver", TUE, "15:00"], ["Delivered", FRI, "10:00"]],
			feed: (f) => f.drive(MON, { miles: 300 }).drive(TUE, { miles: 200, to: 13 }).park(WED).drive(THU, { miles: 10, from: 9, to: 11 }).park(FRI) },
		{ driver: "Ivy Multi", pickup: MON, dropoff: FRI, assigned: MON, done: FRI, want: [MON, WED, THU, FRI], // D28
			status: [["At Shipper", MON, "08:00"], ["Loading", MON, "09:00"], ["In Transit", MON, "12:00"], ["At Shipper", WED, "08:00"], ["Loading", WED, "09:00"], ["In Transit", WED, "11:00"],
				["At Receiver", THU, "09:00"], ["At Receiver", THU, "09:20"], ["In Transit", THU, "11:00"], ["At Receiver", FRI, "09:00"], ["Delivered", FRI, "10:00"]],
			feed: (f) => f.drive(MON, { miles: 300 }).park(TUE).park(WED).park(THU).park(FRI) },
		{ driver: "Jay NoEld", pickup: MON, dropoff: WED, assigned: MON, done: WED, want: [MON, TUE, WED], noTruckFeed: true, // D14
			status: [["At Shipper", MON, "09:00"], ["Loading", MON, "10:00"], ["In Transit", MON, "13:00"], ["At Receiver", WED, "10:00"], ["Delivered", WED, "11:00"]] },
	];
	const rows = [];
	const status = [];
	const pings = {};
	const coords = {};
	const trucks = [];
	shapes.forEach((x, i) => {
		const id = `R0${i}`;
		const unit = `T${i + 1}`;
		const vid = x.noTruckFeed ? null : `V${i + 1}`;
		trucks.push({ unit, driver: x.driver, vid });
		if (vid) pings[vid] = x.feed(W.feed(100000 * (i + 1))).pings;
		if (x.coords) coords[id] = W.PICKUP;
		rows.push(loadRow({ id, driver: x.driver, pickup: `${x.pickup} 8:00`, dropoff: `${x.dropoff} 18:00`, assigned: x.assigned, done: x.done, truck: unit }));
		for (const [st, day, hm] of x.status) status.push(s(id, st, et(`${day} ${hm}`), st === "Dispatched" ? "dispatch" : "manual", st === "Dispatched" ? "super_admin" : ""));
	});
	const w = W.startWorld({ env, drivers: shapes.map((x) => ({ name: x.driver })), trucks, rows, status, pings, coords, now: etMs(`${W41} 20:00`) });
	return { w, want: Object.fromEntries(shapes.map((x) => [x.driver, x.want])) };
}

// SK's shape (added 2026-10-21 item 1): a load worked Thu 10/15 and completed Sat
// 10/17 left W41 with no weekly invoice, so a missed-week Draft pays Thu; then the
// load's completion date is edited into W41 (M2-M4). `manual` changes the Draft:
// its lines, paidDays, status, a soft delete or the Personal correction flag.
async function skWorld(env, status = [], manual = {}) {
	const D = "Sol Kane";
	const w = W.startWorld({
		env, status,
		drivers: [{ name: D }],
		rows: [
			loadRow({ id: "Q4101", driver: D, pickup: "2026-10-12 8:00", dropoff: "2026-10-12 18:00", assigned: "2026-10-12", done: "2026-10-12", truck: "T1" }),
			loadRow({ id: "Q4102", driver: D, pickup: "2026-10-15 8:00", dropoff: "2026-10-15 18:00", assigned: "2026-10-15", done: "2026-10-17", truck: "T1" }),
		],
		now: etMs("2026-10-21 12:00"),
	});
	const lineItems = manual.lineItems || [{ date: "2026-10-15", description: "Missed week 2026-10-10 to 2026-10-16: Thursday, October 15, 2026, $260", amount: 260 }];
	const m = await W.route(w, "POST /api/invoices/manual", { body: { payee: D, periodStart: "2026-10-10", periodEnd: W41, lineItems } });
	if (m.status !== 200) throw new Error(`the manual invoice was refused: ${JSON.stringify(m.body)}`);
	const id = m.body.invoice.id;
	if (manual.paidDays) {
		const rd = JSON.parse(invoiceRow(w, id).render_data || "{}");
		w.db.prepare("UPDATE invoices SET render_data = ? WHERE id = ?").run(JSON.stringify({ ...rd, paidDays: manual.paidDays }), id);
	}
	if (manual.status) w.db.prepare("UPDATE invoices SET status = ? WHERE id = ?").run(manual.status, id);
	if (manual.deleted) w.db.prepare("UPDATE invoices SET deleted_at = '2026-10-18T00:00:00.000Z', deleted_by = 'super_admin' WHERE id = ?").run(id);
	if (manual.isCorrection) w.db.prepare("UPDATE invoices SET is_correction = 1 WHERE id = ?").run(id);
	w.setRow("Q4102", { "Status Update Date": "10/16/2026", "Completion Date": "10/16/2026" });
	return { w, number: m.body.invoice.invoice_number };
}

// Case a: four loads in W39 (B1, B8).
const ADA = "Ada Quill";
function caseA(env) {
	return W.startWorld({
		env,
		drivers: [{ name: ADA }],
		rows: [
			loadRow({ id: "Q101", driver: ADA, assigned: "2026-09-30", done: "2026-09-28", truck: "T1" }),
			loadRow({ id: "Q102", driver: ADA, pickup: "2026-09-29 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-29", done: "2026-09-29", truck: "T1" }),
			loadRow({ id: "Q103", driver: ADA, pickup: "2026-09-29 15:00", dropoff: "2026-10-01 0:01", assigned: "2026-10-01", done: "2026-09-30", truck: "T1" }),
			loadRow({ id: "Q104", driver: ADA, pickup: "2026-09-30 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-10-04", done: "2026-10-02", truck: "T1" }),
		],
		status: [
			s("Q101", "At Shipper", "2026-09-28 18:12:00"), s("Q101", "Delivered", "2026-09-29 00:35:00"), // Mon 14:12 - Mon 20:35 ET
			s("Q102", "At Shipper", "2026-09-29 17:19:00"), s("Q102", "Delivered", "2026-09-29 23:58:00"), // Tue 13:19 - Tue 19:58
			s("Q103", "At Shipper", "2026-09-29 23:21:00"), s("Q103", "In Transit", "2026-09-30 12:25:00"), s("Q103", "Delivered", "2026-10-01 00:09:00"), // Tue 19:21 - Wed 20:09
			s("Q104", "Heading to Shipper", "2026-10-01 00:49:00"), s("Q104", "At Shipper", "2026-10-01 16:26:00"), s("Q104", "In Transit", "2026-10-02 03:28:00"),
			s("Q104", "At Receiver", "2026-10-02 16:10:00"), s("Q104", "Delivered", "2026-10-02 16:53:00"), // Thu 12:26 - Fri 12:53
		],
	});
}

const R = W.createRunner("B12 B: trip work days on the weekly invoice, the investor view and the payout ledger");

(async () => {
	await R.test("B1 [Q4, Q9] Case a, week 9/26-10/2 at $260: a load with no appointments (Mon), two loads on Tue, Heading to Shipper Wed is no start: the invoice pays Mon-Fri ($1,300); ledger and investor view Sep {9/28, 9/29}, Oct {9/30, 10/1, 10/2}, the Oct load's 9/29 dropped (the earliest Assigned month wins). Base: Tue-Thu, $780, 9/29 in both months", async ({ eq }) => {
		const w = caseA(TRIP());
		const g = await W.generate(w, ADA, W39);
		eq("invoice status", g.status, 200);
		eq("invoice days", invDays(g, W39), WEEK39.slice(2));
		eq("Total Due", g.data && g.data.totalDue, 1300);
		const v = await monthViews(w, ADA);
		const want = ["2026-09 2026-09-28", "2026-09 2026-09-29", "2026-10 2026-09-30", "2026-10 2026-10-01", "2026-10 2026-10-02"];
		eq("ledger", v.ledger, want);
		eq("investor view", v.investor, want);
		parity(eq, invDays(g, W39), v, WEEK39);
	});

	await R.test("B2 [Q1, Q2] Late Delivered tap and a Sunday local move (no override row): a load arriving Fri 9/25 20:33 ET with Delivered tapped Mon ends Fri; the next load (Pickup Appointment Sun 15:15, no At Shipper, In Transit Mon 18:44 ET) starts Mon although the truck made a 10-mile move Sun: Sat 9/26 and Sun 9/27 unpaid, Mon-Fri paid on all paths. Base: Sun paid", async ({ eq }) => {
		const D = "Bo Crane";
		const V = W.feed(100000).drive("2026-09-24", { miles: 300 }).drive("2026-09-25", { miles: 250 }).park("2026-09-26")
			.drive("2026-09-27", { miles: 10, from: 9, to: 11 }).drive("2026-09-28", { miles: 200 }).drive("2026-09-29", { miles: 250 })
			.drive("2026-09-30", { miles: 200 }).drive("2026-10-01", { miles: 250 }).drive("2026-10-02", { miles: 150 }).park("2026-10-03").pings;
		const w = W.startWorld({
			env: TRIP(),
			drivers: [{ name: D }],
			trucks: [{ unit: "T1", driver: D, vid: "V21" }],
			pings: { V21: V },
			rows: [
				loadRow({ id: "Q201", driver: D, pickup: "2026-09-24 8:00", dropoff: "2026-09-25 17:00", assigned: "2026-09-23", done: "2026-09-28", truck: "T1" }),
				loadRow({ id: "Q202", driver: D, pickup: "2026-09-27 15:15", dropoff: "2026-09-29 12:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
				loadRow({ id: "Q203", driver: D, pickup: "2026-09-30 8:00", dropoff: "2026-10-02 12:00", assigned: "2026-09-30", done: "2026-10-02", truck: "T1" }),
			],
			status: [
				s("Q201", "At Shipper", "2026-09-25 05:14:00"), s("Q201", "At Receiver", "2026-09-26 00:33:00"), s("Q201", "Delivered", "2026-09-28 17:27:00"),
				s("Q202", "Dispatched", "2026-09-28 19:53:00", "dispatch", "super_admin"), s("Q202", "In Transit", "2026-09-28 22:44:00"),
				s("Q202", "At Receiver", "2026-09-29 16:58:00"), s("Q202", "Delivered", "2026-09-29 20:01:00"),
				s("Q203", "At Shipper", "2026-09-30 13:00:00"), s("Q203", "Delivered", "2026-10-02 16:00:00"),
			],
		});
		const g = await W.generate(w, D, W39);
		eq("invoice days", invDays(g, W39), WEEK39.slice(2));
		const v = await monthViews(w, D);
		eq("ledger, week days", W.onlyDays(v.ledger, WEEK39), ["2026-09 2026-09-28", "2026-09 2026-09-29", "2026-09 2026-09-30", "2026-09 2026-10-01", "2026-09 2026-10-02"]);
		eq("investor view, week days", W.onlyDays(v.investor, WEEK39), W.onlyDays(v.ledger, WEEK39));
		parity(eq, invDays(g, W39), v, WEEK39);
	});

	await R.test("B3 [Q8, revised 2026-10-14] Week boundary: a load At Shipper Thu 10/1, Delivered Mon 10/5. W39, made Fri 10/2 20:00 ET, pays nothing from it (not completed). When W40 is made, Thu 10/1 and Fri 10/2 go onto W39 itself (still a Draft: updated in place, its status kept), never onto W40; W40 pays Sat-Mon; ledger and investor view Thu-Mon in its Assigned month; no day paid twice. Base: Thu and Fri paid by no invoice", async ({ eq }) => {
		const D = "Bea Lark";
		const w = boundaryWorld(D);
		const g39 = await W.generate(w, D, W39);
		eq("W39 days (nothing from the open load)", invDays(g39, W39), ["2026-09-28", "2026-09-29"]);
		deliverBoundaryLoad(w);
		const g40 = await W.generate(w, D, W40);
		eq("W40 grid", W.dayList(W.gridDays(g40.data, W40)), ["2026-10-03", "2026-10-04", "2026-10-05"]);
		eq("W40 carries no earlier days", g40.data && g40.data.earlierDays, undefined);
		const w39 = invoiceRow(w, g39.invoice.id);
		eq("W39 now pays Thu and Fri too, from the boundary load, at $260 each", storedGrid(w, g39.invoice.id, W39).map((e) => [e.day, e.loads, e.total]),
			[["2026-09-28", ["Q301"], 260], ["2026-09-29", ["Q301"], 260], ["2026-10-01", ["Q302"], 260], ["2026-10-02", ["Q302"], 260]]);
		eq("W39 keeps its number and status; its total and day count follow", [w39.invoice_number, w39.status, w39.total_earnings, w39.loads_count], [g39.invoice.invoice_number, "Draft", 1040, 4]);
		eq("the W40 response reports the update", g40.body && g40.body.lateWorkDays && g40.body.lateWorkDays.updated.map((u) => [u.invoiceNumber, u.days]), [[g39.invoice.invoice_number, ["2026-10-01", "2026-10-02"]]]);
		eq("no correction invoice", corrections(w).length, 0);
		const all = [...W.dayList(storedGrid(w, g39.invoice.id, W39)), ...invDays(g40, W40)];
		eq("no day paid twice", all.length, uniq(all).length);
		const v = await monthViews(w, D);
		const want = ["2026-09 2026-09-28", "2026-09 2026-09-29", ...daysFrom("2026-10-01", "2026-10-05").map((d) => `2026-10 ${d}`)];
		eq("ledger", v.ledger, want);
		eq("investor view", v.investor, want);
		parity(eq, all, v, [...WEEK39, ...WEEK40]);
	});

	await R.test("B4 Blank Pickup Appointment and no Assigned Date, with timestamps (At Shipper Tue, Delivered Wed): paid on all three paths, in the days' own month. Base: the invoice and the ledger skip it", async ({ eq }) => {
		const D = "Cal Reed";
		const w = W.startWorld({
			env: TRIP(),
			drivers: [{ name: D }],
			rows: [loadRow({ id: "Q401", driver: D, done: "2026-09-30", truck: "T1" })],
			status: [s("Q401", "At Shipper", "2026-09-29 14:00:00"), s("Q401", "Delivered", "2026-09-30 19:00:00")],
		});
		const g = await W.generate(w, D, W39);
		eq("invoice days", invDays(g, W39), ["2026-09-29", "2026-09-30"]);
		const v = await monthViews(w, D);
		eq("ledger", v.ledger, ["2026-09 2026-09-29", "2026-09 2026-09-30"]);
		eq("investor view", v.investor, ["2026-09 2026-09-29", "2026-09 2026-09-30"]);
		parity(eq, invDays(g, W39), v, WEEK39);
	});

	await R.test("B5 [revised 2026-10-14] A completed load with blank Status Update and Completion Date (At Shipper Tue, Delivered Wed): the invoice pays Tue and Wed. And a load delivered Fri 22:00 ET, after its week's invoice was made: the next week, which holds none of its days, answers 400 \"No completed loads\" for itself, while the run puts Thu and Fri onto the earlier week's own invoice. Base: 400, and Thu and Fri paid by no invoice", async ({ eq }) => {
		const D = "Dee Moss";
		const w = W.startWorld({
			env: TRIP(),
			drivers: [{ name: D }],
			rows: [loadRow({ id: "Q501", driver: D, pickup: "2026-09-29 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-29", done: "", truck: "T1" })],
			status: [s("Q501", "At Shipper", "2026-09-29 13:00:00"), s("Q501", "Delivered", "2026-09-30 21:00:00")],
		});
		const g = await W.generate(w, D, W39);
		eq("undated load: invoice status", g.status, 200);
		eq("undated load: invoice days", invDays(g, W39), ["2026-09-29", "2026-09-30"]);
		parity(eq, invDays(g, W39), await monthViews(w, D), WEEK39);

		const E = "Eli Fogg";
		const w2 = W.startWorld({
			env: TRIP(),
			drivers: [{ name: E }],
			rows: [
				loadRow({ id: "Q511", driver: E, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
				loadRow({ id: "Q512", driver: E, pickup: "2026-10-01 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-01", done: "", status: "In Transit", truck: "T1" }),
			],
			status: [s("Q511", "At Shipper", "2026-09-28 12:00:00"), s("Q511", "Delivered", "2026-09-29 21:00:00"), s("Q512", "At Shipper", "2026-10-01 13:00:00")],
			now: etMs("2026-10-02 20:00"),
		});
		const a = await W.generate(w2, E, W39);
		w2.addStatus([s("Q512", "Delivered", "2026-10-03 02:00:00")]); // Fri 22:00 ET
		w2.setRow("Q512", { "Job Status": "Delivered", "Status Update Date": "10/2/2026", "Completion Date": "10/2/2026" });
		w2.clock.ms = etMs("2026-10-09 20:00");
		const b = await W.generate(w2, E, W40);
		eq("W40 holds no day of its own: 400", b.status, 400);
		eq("…and the run put Thu and Fri onto W39", b.body && b.body.lateWorkDays && b.body.lateWorkDays.updated.map((u) => [u.invoiceNumber, u.days]), [[a.invoice.invoice_number, ["2026-10-01", "2026-10-02"]]]);
		eq("W39 now pays Mon, Tue, Thu, Fri", W.dayList(storedGrid(w2, a.invoice.id, W39)), ["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02"]);
		parity(eq, W.dayList(storedGrid(w2, a.invoice.id, W39)), await monthViews(w2, E), [...WEEK39, ...WEEK40]);
	});

	await R.test("B6 FROM=2026-10: two drivers on the same trip (At Shipper Tue 9/29, Delivered Fri 10/2; appointments 9/28-10/1). Assigned Sep: today's rule on all paths, Sep bucket; Assigned Oct: trip days 9/29-10/2 on all paths, Oct bucket; the boundary week pays each its own way. Base: the Oct load pays its appointment window", async ({ eq }) => {
		const P = "Fay Pine";
		const Q = "Gus Hale";
		const stamps = (lid) => [s(lid, "At Shipper", "2026-09-29 13:00:00"), s(lid, "Delivered", "2026-10-02 20:00:00")];
		const w = W.startWorld({
			env: TRIP("2026-10"),
			drivers: [{ name: P }, { name: Q }],
			rows: [
				loadRow({ id: "Q601", driver: P, pickup: "2026-09-28 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-09-28", done: "2026-10-02", truck: "T1" }),
				loadRow({ id: "Q602", driver: Q, pickup: "2026-09-28 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T2" }),
			],
			status: [...stamps("Q601"), ...stamps("Q602")],
		});
		const gp = await W.generate(w, P, W39);
		const gq = await W.generate(w, Q, W39);
		eq("Sep-assigned: invoice (today's rule)", invDays(gp, W39), daysFrom("2026-09-28", "2026-10-01"));
		eq("Oct-assigned: invoice (trip days)", invDays(gq, W39), daysFrom("2026-09-29", "2026-10-02"));
		const vp = await monthViews(w, P);
		const vq = await monthViews(w, Q);
		eq("Sep-assigned: ledger", vp.ledger, daysFrom("2026-09-28", "2026-10-01").map((d) => `2026-09 ${d}`));
		eq("Oct-assigned: ledger", vq.ledger, daysFrom("2026-09-29", "2026-10-02").map((d) => `2026-10 ${d}`));
		eq("investor view = ledger, both drivers", [vp.investor, vq.investor], [vp.ledger, vq.ledger]);
		parity(eq, invDays(gq, W39), vq, WEEK39);
	});

	await R.test("B7 FROM=2026-10: a load settling before FROM (Assigned Sep) pays exactly as today on all three paths, with September open or closed (no lock read)", async ({ eq }) => {
		const D = "Hal Moor";
		const fixture = (env, locks = []) => W.startWorld({
			env, locks,
			drivers: [{ name: D }],
			rows: [loadRow({ id: "Q701", driver: D, pickup: "2026-09-28 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-09-28", done: "2026-10-02", truck: "T1" })],
			status: [s("Q701", "At Shipper", "2026-09-29 13:00:00"), s("Q701", "Delivered", "2026-10-02 20:00:00")],
		});
		const snap = async (w) => { const g = await W.generate(w, D, W39); const v = await monthViews(w, D); return { invoice: invDays(g, W39), total: g.data && g.data.totalDue, ledger: v.ledger, investor: v.investor }; };
		const today = await snap(fixture({}));
		eq("today's days (the appointment window, Sep bucket)", today.ledger, daysFrom("2026-09-28", "2026-10-01").map((d) => `2026-09 ${d}`));
		eq("flag on, September open: as today", await snap(fixture(TRIP("2026-10"))), today);
		eq("flag on, September closed: as today", await snap(fixture(TRIP("2026-10"), ["2026-09"])), today);
	});

	await R.test("B8 Flags off: all three paths are today's (case a: invoice Tue-Thu $780; Sep {9/29, 9/30}, Oct {9/29, 9/30, 10/1}), also with TRIP_WORK_DAYS_FROM set and the flag off", async ({ eq }) => {
		const want = ["2026-09 2026-09-29", "2026-09 2026-09-30", "2026-10 2026-09-29", "2026-10 2026-09-30", "2026-10 2026-10-01"];
		for (const [label, env] of [["no flags", {}], ["FROM set, flag off", { TRIP_WORK_DAYS_FROM: "2026-09" }]]) {
			const w = caseA(env);
			const g = await W.generate(w, ADA, W39);
			eq(`${label}: invoice days`, invDays(g, W39), ["2026-09-29", "2026-09-30", "2026-10-01"]);
			eq(`${label}: Total Due`, g.data && g.data.totalDue, 780);
			eq(`${label}: no earlier days`, g.data && g.data.earlierDays === undefined, true);
			const v = await monthViews(w, ADA);
			eq(`${label}: ledger`, v.ledger, want);
			eq(`${label}: investor view`, v.investor, want);
			parity(eq, invDays(g, W39), v, WEEK39);
		}
	});

	await R.test("B9 FROM=2026-10: 9/29 claimed by a Sep- and an Oct-assigned load counts in Sep only; 8/31 claimed by Aug- and Sep-assigned loads stays counted in both (before FROM); closing September changes nothing. Base: 9/29 in both Sep and Oct", async ({ eq }) => {
		const X = "Ida Rowe";
		const Y = "Jo Vance";
		const fixture = (locks) => W.startWorld({
			env: TRIP("2026-10"), locks,
			drivers: [{ name: X }, { name: Y }],
			rows: [
				loadRow({ id: "Q901", driver: X, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
				loadRow({ id: "Q902", driver: X, pickup: "2026-09-29 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-10-01", done: "2026-09-30", truck: "T1" }),
				loadRow({ id: "Q911", driver: Y, pickup: "2026-08-30 8:00", dropoff: "2026-08-31 18:00", assigned: "2026-08-30", done: "2026-08-31", truck: "T2" }),
				loadRow({ id: "Q912", driver: Y, pickup: "2026-08-31 8:00", dropoff: "2026-09-01 18:00", assigned: "2026-09-01", done: "2026-09-01", truck: "T2" }),
			],
			status: [
				s("Q901", "At Shipper", "2026-09-28 13:00:00"), s("Q901", "Delivered", "2026-09-29 20:00:00"),
				s("Q902", "At Shipper", "2026-09-29 22:00:00"), s("Q902", "Delivered", "2026-09-30 21:00:00"),
			],
		});
		const wantX = ["2026-09 2026-09-28", "2026-09 2026-09-29", "2026-10 2026-09-30"];
		const wantY = ["2026-08 2026-08-30", "2026-08 2026-08-31", "2026-09 2026-08-31", "2026-09 2026-09-01"];
		for (const [label, locks] of [["September open", []], ["September closed", ["2026-09"]]]) {
			const w = fixture(locks);
			const vx = await monthViews(w, X);
			const vy = await monthViews(w, Y);
			eq(`${label}: ledger, Sep/Oct driver`, vx.ledger, wantX);
			eq(`${label}: investor view, Sep/Oct driver`, vx.investor, wantX);
			eq(`${label}: ledger and investor view, Aug/Sep driver (before FROM, unchanged)`, [vy.ledger, vy.investor], [wantY, wantY]);
			const g = await W.generate(w, X, W39);
			parity(eq, invDays(g, W39), vx, WEEK39);
		}
	});

	await R.test("B10 [rule d, Q3] Pre-dispatch flag and trip flag both on (FROM=2026-10): a load with a full trip ignores the pre-dispatch filter (its idle 12 km day before dispatch pays, At Shipper that day); a load with only Dispatched and Delivered now follows rule d too, each anchor on its own, so its Pickup Appointment day (Wed) is paid as decision d's appointment day and the pre-dispatch filter, a window-rule filter, no longer reads it. Base: both lose the idle day", async ({ eq }) => {
		const K = "Kit Lane";
		const L = "Lou Penn";
		const track = (odo) => W.feed(odo).park("2026-09-25").drive("2026-09-30", { miles: 7.5 })
			.drive("2026-10-01", { miles: 200, visit: W.PICKUP }).drive("2026-10-02", { miles: 300 }).park("2026-10-03").pings;
		const w = W.startWorld({
			env: { ...TRIP("2026-10"), PRE_DISPATCH_PAY_DAY_RULE_ENABLED: "true", PRE_DISPATCH_PAY_DAY_RULE_FROM: "2026-10" },
			drivers: [{ name: K }, { name: L }],
			trucks: [{ unit: "T1", driver: K, vid: "V1" }, { unit: "T2", driver: L, vid: "V2" }],
			pings: { V1: track(100000), V2: track(200000) },
			coords: { Q1001: W.PICKUP, Q1002: W.PICKUP },
			rows: [
				loadRow({ id: "Q1001", driver: K, pickup: "2026-09-30 8:00", dropoff: "2026-10-02 10:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T1" }),
				loadRow({ id: "Q1002", driver: L, pickup: "2026-09-30 8:00", dropoff: "2026-10-02 10:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T2" }),
			],
			status: [
				s("Q1001", "Dispatched", "2026-10-01 14:00:00", "dispatch", "super_admin"), s("Q1001", "At Shipper", "2026-09-30 15:00:00"), s("Q1001", "Delivered", "2026-10-02 20:00:00"),
				s("Q1002", "Dispatched", "2026-10-01 14:00:00", "dispatch", "super_admin"), s("Q1002", "Delivered", "2026-10-02 20:00:00"),
			],
		});
		const gk = await W.generate(w, K, W39);
		const gl = await W.generate(w, L, W39);
		eq("full trip: invoice", invDays(gk, W39), ["2026-09-30", "2026-10-01", "2026-10-02"]);
		eq("Dispatched and Delivered only: invoice (rule d: the appointment day Wed, Thu driving, Fri unloading)", invDays(gl, W39), ["2026-09-30", "2026-10-01", "2026-10-02"]);
		const vk = await monthViews(w, K);
		const vl = await monthViews(w, L);
		eq("full trip: ledger and investor view", [vk.ledger, vk.investor], [["2026-10 2026-09-30", "2026-10 2026-10-01", "2026-10 2026-10-02"], ["2026-10 2026-09-30", "2026-10 2026-10-01", "2026-10 2026-10-02"]]);
		eq("Dispatched and Delivered only: ledger and investor view", [vl.ledger, vl.investor], [["2026-10 2026-09-30", "2026-10 2026-10-01", "2026-10 2026-10-02"], ["2026-10 2026-09-30", "2026-10 2026-10-01", "2026-10 2026-10-02"]]);
		parity(eq, invDays(gk, W39), vk, WEEK39);
		parity(eq, invDays(gl, W39), vl, WEEK39);
	});

	await R.test("B11 Percentage (owner-operator) driver: the invoice and the ledger are identical with the flag on and off (trip times that differ from the appointments change nothing)", async ({ eq }) => {
		const D = "Max Quay";
		const fixture = (env) => W.startWorld({
			env,
			drivers: [{ name: D, payType: "percentage", payPct: 30, payDaily: 0 }],
			rows: [
				loadRow({ id: "Q1101", driver: D, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1", payment: "$3,000.00" }),
				loadRow({ id: "Q1102", driver: D, pickup: "2026-09-30 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-09-30", done: "2026-10-01", truck: "T1", payment: "$2,500.00" }),
			],
			status: [
				s("Q1101", "At Shipper", "2026-09-29 13:00:00"), s("Q1101", "Delivered", "2026-09-30 20:00:00"),
				s("Q1102", "At Shipper", "2026-10-01 13:00:00"), s("Q1102", "Delivered", "2026-10-02 20:00:00"),
			],
		});
		const snap = async (w) => {
			const g = await W.generate(w, D, W39);
			const led = await W.ledger(w);
			return { status: g.status, render: g.data, ledger: led.pay.filter((i) => i.driver === norm(D)) };
		};
		const off = await snap(fixture({}));
		eq("percentage template", off.render && off.render.totalEarnings, 1650);
		eq("flag on: identical invoice render and ledger items", await snap(fixture(TRIP())), off);
	});

	await R.test("B12 [revised 2026-10-14] Overrides: a remove row removes a rule day in the grid (Sun 10/4) and among the late days (Fri 10/2); an add row adds a day (Wed 10/7); an add row in a closed month (9/30, September closed) goes on no invoice. With September closed, W39 (its week touches September) is left as made and the late Thu 10/1 goes on a correction invoice for that week, a Draft dated 10/1-10/2 in the open month, never on W40. Base: Thu paid by no invoice", async ({ eq, ok }) => {
		const D = "Ned Ross";
		const w = W.startWorld({
			env: TRIP(),
			drivers: [{ name: D }],
			rows: [
				loadRow({ id: "Q1201", driver: D, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
				loadRow({ id: "Q1202", driver: D, pickup: "2026-10-01 8:00", dropoff: "2026-10-05 14:00", assigned: "2026-10-01", done: "", status: "In Transit", truck: "T1" }),
			],
			status: [s("Q1201", "At Shipper", "2026-09-28 13:00:00"), s("Q1201", "Delivered", "2026-09-29 20:00:00"), s("Q1202", "At Shipper", "2026-10-01 13:00:00")],
			now: etMs("2026-10-02 20:00"),
		});
		const g39 = await W.generate(w, D, W39);
		w.addOverrides([{ driver: D, day: "2026-10-02", action: "remove" }, { driver: D, day: "2026-10-04", action: "remove" }, { driver: D, day: "2026-10-07", action: "add" }, { driver: D, day: "2026-09-30", action: "add" }]);
		w.lock(["2026-09"]);
		w.addStatus([s("Q1202", "At Receiver", "2026-10-05 15:00:00"), s("Q1202", "Delivered", "2026-10-05 17:00:00")]);
		w.setRow("Q1202", { "Job Status": "Delivered", "Status Update Date": "10/5/2026", "Completion Date": "10/5/2026" });
		w.clock.ms = etMs("2026-10-09 20:00");
		const g40 = await W.generate(w, D, W40);
		eq("W40 grid: Sat, Mon (Sun removed), Wed (added)", W.dayList(W.gridDays(g40.data, W40)), ["2026-10-03", "2026-10-05", "2026-10-07"]);
		eq("W40 carries no earlier days", g40.data && g40.data.earlierDays, undefined);
		eq("W39 is left as made", W.dayList(storedGrid(w, g39.invoice.id, W39)), ["2026-09-28", "2026-09-29"]);
		const cs = corrections(w);
		eq("one correction: a Draft for Thu only (Fri removed), $260, correcting W39, dated in the open month",
			cs.map((c) => [c.status, c.correction_of, c.week_start, c.week_end, c.total_earnings, paidDaysOf(c)]),
			[["Draft", g39.invoice.id, "2026-10-01", "2026-10-02", 260, ["2026-10-01"]]]);
		eq("the correction holds Thu", claimRows(w).filter(([d]) => d === "2026-10-01"), [["2026-10-01", cs[0] && cs[0].id]]);
		const paid = [...W.dayList(storedGrid(w, g39.invoice.id, W39)), ...invDays(g40, W40), ...cs.flatMap(paidDaysOf)];
		ok("the closed-month add day (9/30) is on no invoice", !paid.includes("2026-09-30"));
		parity(eq, paid, await monthViews(w, D), [...WEEK39, ...WEEK40], ["2026-09-30"]);
	});

	await R.test("B13 [Q13; revised 2026-10-21, one pricing rule] Rate $280, then $320 from Wed 9/30 (pay_rate_history), a full week worked. The trip rule alone reads no dated rate: the invoice and the ledger both pay 7 x $320 = $2,240. With the daily-rate rule on too (DRIVER_RATE_ONLY from 2026-09) both price each day at its dated rate, Sat-Tue $280 and Wed-Fri $320: $2,080 on both. Before: the invoice read the dated rates with the trip rule alone ($2,080) while the ledger paid $2,240", async ({ eq }) => {
		const D = "Ola Stone";
		const weekAt = (env) => W.startWorld({
			env,
			drivers: [{ name: D, payDaily: 320 }],
			payRates: [{ subject: "driver", key: norm(D), rate: 280, from: "2026-09-01T12:00:00.000Z" }, { subject: "driver", key: norm(D), rate: 320, from: "2026-09-30T13:00:00.000Z" }],
			rows: [loadRow({ id: "Q1301", driver: D, pickup: "2026-09-26 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-09-26", done: "2026-10-02", truck: "T1" })],
			status: [s("Q1301", "At Shipper", "2026-09-26 12:00:00"), s("Q1301", "Delivered", "2026-10-02 22:00:00")],
		});
		const ledgerCents = async (w) => (await W.ledger(w)).pay.filter((i) => i.driver === norm(D)).reduce((a, i) => a + i.cents, 0);
		const alone = weekAt(TRIP());
		const g = await W.generate(alone, D, W39);
		eq("trip rule alone: each grid day at $320", W.gridDays(g.data, W39).map((e) => [e.day, e.total]), WEEK39.map((d) => [d, 320]));
		eq("trip rule alone: Total Due and the row's total", [g.data && g.data.totalDue, g.invoice && g.invoice.total_earnings], [2240, 2240]);
		eq("trip rule alone: the ledger pays the same", await ledgerCents(alone), 224000);
		parity(eq, invDays(g, W39), await monthViews(alone, D), WEEK39);
		const both = weekAt({ ...TRIP(), DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-09" });
		const g2 = await W.generate(both, D, W39);
		eq("with the daily-rate rule: each grid day at its dated rate", W.gridDays(g2.data, W39).map((e) => [e.day, e.total]), WEEK39.map((d) => [d, d < "2026-09-30" ? 280 : 320]));
		eq("with the daily-rate rule: Total Due", g2.data && g2.data.totalDue, 2080);
		eq("with the daily-rate rule: the ledger pays the same", await ledgerCents(both), 208000);
	});

	await R.test("B14 Late-known day (FROM=2026-10): a load Assigned Oct, At Shipper and delivered Fri 10/30, is marked Delivered on the sheet only after October closed. Its 10/30 is not carried onto the November invoice (closed month) and is listed in `warnings`; October's frozen ledger items are untouched", async ({ eq, ok }) => {
		const D = "Pia Tate";
		const w = W.startWorld({
			env: TRIP("2026-10"),
			drivers: [{ name: D }],
			rows: [
				loadRow({ id: "Q1400", driver: D, pickup: "2026-10-26 8:00", dropoff: "2026-10-27 18:00", assigned: "2026-10-26", done: "2026-10-27", truck: "T1" }),
				loadRow({ id: "Q1401", driver: D, pickup: "2026-10-30 8:00", dropoff: "2026-10-30 20:00", assigned: "2026-10-29", done: "", status: "In Transit", truck: "T1" }),
			],
			status: [s("Q1400", "At Shipper", "2026-10-26 12:00:00"), s("Q1400", "Delivered", "2026-10-27 21:00:00"), s("Q1401", "At Shipper", "2026-10-30 12:00:00")],
			now: etMs("2026-10-30 19:00"),
		});
		const g43 = await W.generate(w, D, "2026-10-30");
		eq("W43 pays Mon and Tue", invDays(g43, "2026-10-30"), ["2026-10-26", "2026-10-27"]);
		w.addStatus([s("Q1401", "Delivered", "2026-10-31 00:00:00")]);
		w.lock(["2026-10"]);
		w.db.prepare(`INSERT INTO financials_ledger_items (period, owner_id, kind, day, cents, load_id, driver, truck, pay_type, freeze_id, frozen_at)
			VALUES ('2026-10', 5, 'driver_pay', '2026-10-26', 26000, 'Q1400', ?, 'T1', 'fixed', 'freeze-oct', '2026-11-08T05:00:00.000Z')`).run(norm(D));
		const frozenBefore = W.tableHashes(w.db).financials_ledger_items;
		w.setRow("Q1401", { "Job Status": "Delivered", "Status Update Date": "11/10/2026", "Completion Date": "11/10/2026" });
		w.clock.ms = etMs("2026-11-13 20:00");
		const g45 = await W.generate(w, D, "2026-11-13");
		ok("10/30 is on no November invoice", !invDays(g45, "2026-11-13").includes("2026-10-30"), JSON.stringify(invDays(g45, "2026-11-13")));
		eq("…nor on W43, which is left as made, nor on a correction", [W.dayList(storedGrid(w, g43.invoice.id, "2026-10-30")), corrections(w).length], [["2026-10-26", "2026-10-27"], 0]);
		ok("10/30 is listed in warnings", (g45.warnings || []).some((x) => /2026-10-30|10\/30/.test(String(x))), JSON.stringify(g45.warnings));
		eq("October's frozen items untouched", W.tableHashes(w.db).financials_ledger_items, frozenBefore);
		// The refused 10/30 is paid by no invoice by design (a person decides it).
		parity(eq, [...invDays(g43, "2026-10-30"), ...invDays(g45, "2026-11-13")], await monthViews(w, D),
			[...daysFrom("2026-10-24", "2026-10-30"), ...daysFrom("2026-11-07", "2026-11-13")], ["2026-10-30"]);
	});

	await R.test("B15 [Q8, 2026-10-14] Late days for a week whose invoice is Submitted (not approved): that invoice is updated in place and stays Submitted, its admin adjustment (a deduction, which cannot be paying a missed day) kept and printed; W40 carries none of them; W39 holds Thu and Fri", async ({ eq }) => {
		const D = "Cy Dunn";
		const w = boundaryWorld(D);
		const g39 = await W.generate(w, D, W39);
		w.db.prepare("UPDATE invoices SET status = 'Submitted', submitted_at = '2026-10-03T00:00:00.000Z', adjustment = -25, adjustment_note = 'advance', adjusted_by = 'super_admin', adjusted_at = '2026-10-03T01:00:00.000Z' WHERE id = ?").run(g39.invoice.id);
		deliverBoundaryLoad(w);
		const g40 = await W.generate(w, D, W40);
		const row = invoiceRow(w, g39.invoice.id);
		eq("W39 still Submitted, adjustment kept, Thu and Fri added", [row.status, row.adjustment, row.adjustment_note, row.total_earnings, W.dayList(storedGrid(w, row.id, W39))],
			["Submitted", -25, "advance", 1040, ["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02"]]);
		eq("the redrawn W39 prints the adjustment and the new total", [JSON.parse(row.render_data).adjustment, JSON.parse(row.render_data).totalDue], [-25, 1040]);
		eq("W40 carries none of them", [g40.status, g40.data && g40.data.earlierDays, W.dayList(W.gridDays(g40.data, W40))], [200, undefined, ["2026-10-03", "2026-10-04", "2026-10-05"]]);
		eq("Thu and Fri are held by W39", claimRows(w).filter(([d]) => d === "2026-10-01" || d === "2026-10-02").map(([, id]) => id), [row.id, row.id]);
	});

	await R.test("B16 [Q8, 2026-10-14] Late days for a week whose invoice is Approved: a separate correction invoice for that same week, a Draft for the owner to approve, one $260 line per day naming the approved invoice (an INV-M- number); the approved invoice and W40 are left alone; regenerating W40 adds nothing more (the correction holds the days)", async ({ eq, ok }) => {
		const D = "Di Earl";
		const w = boundaryWorld(D);
		const g39 = await W.generate(w, D, W39);
		w.db.prepare("UPDATE invoices SET status = 'Approved', approved_at = '2026-10-04T00:00:00.000Z', approved_by = 'super_admin' WHERE id = ?").run(g39.invoice.id);
		const before = invoiceRow(w, g39.invoice.id);
		deliverBoundaryLoad(w);
		const g40 = await W.generate(w, D, W40);
		const after = invoiceRow(w, g39.invoice.id);
		eq("the approved W39 is unchanged", [after.status, after.total_earnings, after.render_data], [before.status, before.total_earnings, before.render_data]);
		const cs = corrections(w);
		eq("one correction for W39's week: Draft, $520, Thu and Fri", cs.map((c) => [c.status, c.correction_of, c.week_start, c.week_end, c.total_earnings, paidDaysOf(c)]),
			[["Draft", before.id, "2026-09-26", "2026-10-02", 520, ["2026-10-01", "2026-10-02"]]]);
		const lines = cs[0] ? JSON.parse(cs[0].render_data).lineItems : [];
		ok("each line names the approved invoice and its day, at $260", lines.length === 2 && lines.every((l) => l.description.startsWith(`Correction for ${before.invoice_number}:`) && l.amount === 260), JSON.stringify(lines));
		ok("an INV-M- number, is_correction left for Personal corrections", cs[0] && /^INV-M-/.test(cs[0].invoice_number) && cs[0].is_correction === 0, JSON.stringify(cs[0] && [cs[0].invoice_number, cs[0].is_correction]));
		eq("the W40 response reports it", g40.body && g40.body.lateWorkDays && g40.body.lateWorkDays.corrections.map((c) => [c.correctionOf, c.days]), [[before.invoice_number, ["2026-10-01", "2026-10-02"]]]);
		eq("W40 carries none of them", g40.data && g40.data.earlierDays, undefined);
		await W.generate(w, D, W40);
		eq("regenerating W40: still one correction", corrections(w).length, 1);
	});

	await R.test("B17 A driver generating his own invoice settles no late day (only a Super Admin's run does, the Friday batch included); the next Super Admin run does", async ({ eq }) => {
		const D = "Ed Fox";
		const w = boundaryWorld(D);
		const g39 = await W.generate(w, D, W39);
		deliverBoundaryLoad(w);
		const own = await W.call(w.api.generateInvoiceHandler, { session: { user: { id: 9, role: "Driver", username: "efox", driverName: D } }, headers: {}, query: {}, params: {}, body: { weekEnd: W40 } });
		eq("the driver's own W40: 200, W39 untouched, no late-day report", [own.status, W.dayList(storedGrid(w, g39.invoice.id, W39)), own.body && own.body.lateWorkDays],
			[200, ["2026-09-28", "2026-09-29"], undefined]);
		const admin = await W.generate(w, D, W40);
		eq("a Super Admin's run puts Thu and Fri onto W39", [admin.status, W.dayList(storedGrid(w, g39.invoice.id, W39))], [200, ["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02"]]);
	});

	await R.test("B18 R3: a Personal line on an invoice that late days are added to stays on it and printed; pay is the four days ($1,040), the line $50", async ({ eq }) => {
		const D = "Flo Gale";
		const w = boundaryWorld(D);
		w.db.exec(require(path.join(W.ROOT, "lib", "personal-expense.js")).SCHEMA_SQL);
		const g39 = await W.generate(w, D, W39);
		const exp = w.db.prepare("INSERT INTO expenses (driver, date, timestamp, amount, type, status) VALUES (?, '2026-09-29', '2026-09-29T15:00:00.000Z', 50, 'Other', 'Approved')").run(D).lastInsertRowid;
		const line = w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, invoice_id, created_at, created_by, created_by_id, created_role)
			VALUES (?, 'deduct', 5000, 5000, 'Corner Store', '2026-09-29', '2026-09', 1, '2026-09-29', '2026-09-26', ?, '2026-10-03T00:00:00.000Z', 'super_admin', 1, 'Super Admin')`).run(exp, g39.invoice.id).lastInsertRowid;
		w.db.prepare("UPDATE invoices SET personal_total = 50 WHERE id = ?").run(g39.invoice.id);
		deliverBoundaryLoad(w);
		await W.generate(w, D, W40);
		const row = invoiceRow(w, g39.invoice.id);
		const data = JSON.parse(row.render_data);
		eq("the line is still on W39, not voided", w.db.prepare("SELECT invoice_id, voided_at FROM expense_personal WHERE id = ?").get(line), { invoice_id: row.id, voided_at: "" });
		eq("W39: four days, pay $1,040, the Personal line printed, $50", [W.dayList(storedGrid(w, row.id, W39)).length, row.total_earnings, data.personalTotal, Array.isArray(data.personalLines) && data.personalLines.length > 0, row.personal_total],
			[4, 1040, 50, true, 50]);
	});

	await R.test("B19 (review M1) A late day that may already be paid is not carried, and is named in warnings: a manual invoice with a line dated Thu 10/1 (as scripts/create-correction-invoice-draft.js writes) keeps Thu off W39 while Fri goes on; a manual invoice with an undated line covers every day of its period; a positive adjustment on W39 keeps both days off it and makes no correction", async ({ eq, ok }) => {
		const warned = (g, day) => (g.warnings || []).some((x) => String(x).includes(day));
		const manualFor = (w, D, lines, period) => W.route(w, "POST /api/invoices/manual", { body: { payee: D, periodStart: period[0], periodEnd: period[1], lineItems: lines } });
		{
			const D = "Gus Holt";
			const w = boundaryWorld(D);
			const g39 = await W.generate(w, D, W39);
			const m = await manualFor(w, D, [{ date: "2026-10-01", description: "Missed day, Thursday", amount: 260 }], ["2026-10-01", "2026-10-01"]);
			eq("dated line: the manual invoice is made", m.status, 200);
			deliverBoundaryLoad(w);
			const g40 = await W.generate(w, D, W40);
			eq("dated line: W39 gains Fri only", W.dayList(storedGrid(w, g39.invoice.id, W39)), ["2026-09-28", "2026-09-29", "2026-10-02"]);
			ok("dated line: Thu named in warnings, with the manual invoice", warned(g40, "2026-10-01") && (g40.warnings || []).some((x) => x.includes(m.body.invoice.invoice_number)), JSON.stringify(g40.warnings));
		}
		{
			const D = "Hal Iver";
			const w = boundaryWorld(D);
			const g39 = await W.generate(w, D, W39);
			const m = await manualFor(w, D, [{ description: "Catch-up pay", amount: 520 }], ["2026-10-01", "2026-10-02"]);
			eq("undated line: the manual invoice is made", m.status, 200);
			deliverBoundaryLoad(w);
			const g40 = await W.generate(w, D, W40);
			eq("undated line: W39 gains neither day", W.dayList(storedGrid(w, g39.invoice.id, W39)), ["2026-09-28", "2026-09-29"]);
			ok("undated line: both named in warnings", warned(g40, "2026-10-01") && warned(g40, "2026-10-02"), JSON.stringify(g40.warnings));
		}
		{
			const D = "Ike Jory";
			const w = boundaryWorld(D);
			const g39 = await W.generate(w, D, W39);
			w.db.prepare("UPDATE invoices SET adjustment = 260, adjustment_note = 'missed day', adjusted_by = 'super_admin', adjusted_at = '2026-10-03T01:00:00.000Z' WHERE id = ?").run(g39.invoice.id);
			deliverBoundaryLoad(w);
			const g40 = await W.generate(w, D, W40);
			eq("positive adjustment: W39 unchanged, no correction", [W.dayList(storedGrid(w, g39.invoice.id, W39)), corrections(w).length], [["2026-09-28", "2026-09-29"], 0]);
			ok("positive adjustment: both named in warnings, with the adjustment", warned(g40, "2026-10-01") && warned(g40, "2026-10-02") && (g40.warnings || []).some((x) => /adjustment/.test(x)), JSON.stringify(g40.warnings));
		}
	});

	await R.test("B20 (re-review M1, L2; added 2026-10-21 item 2) A manual invoice that names the week's invoice in a line or its notes blocks that week's late days, whatever date it carries; an adjustment under one day's pay (a $25 bonus) does not block; nor do a Rejected manual invoice, a Personal correction (is_correction) or a manual invoice that names its days. A soft-deleted manual invoice blocks nothing but the day it dates: a Super Admin deleted it, so that day is never carried again automatically (M1), the other day is", async ({ eq, ok }) => {
		const run = async (D, prepare) => {
			const w = boundaryWorld(D);
			const g39 = await W.generate(w, D, W39);
			const made = await prepare(w, g39);
			if (made && "status" in made) eq(`${D}: the manual invoice is made`, made.status, 200);
			deliverBoundaryLoad(w);
			const g40 = await W.generate(w, D, W40);
			return { w, g39, g40, grid: W.dayList(storedGrid(w, g39.invoice.id, W39)) };
		};
		const manualFor = (w, D, body) => W.route(w, "POST /api/invoices/manual", { body: { payee: D, lineItems: [{ date: "2026-10-20", description: "Catch-up", amount: 260 }], periodStart: "2026-10-20", periodEnd: "2026-10-20", ...body } });
		const BOTH = ["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02"];
		{
			const r = await run("Jo Kerr", (w, g39) => manualFor(w, "Jo Kerr", { lineItems: [{ date: "2026-10-20", description: `Missed Thu Oct 1 (${g39.invoice.invoice_number})`, amount: 260 }] }));
			eq("a line naming W39, dated 10/20: W39 gains nothing", r.grid, ["2026-09-28", "2026-09-29"]);
			ok("…and the warning names the manual invoice", (r.g40.warnings || []).some((x) => /names INV-/.test(x)), JSON.stringify(r.g40.warnings));
		}
		{
			const r = await run("Kai Lowe", (w, g39) => manualFor(w, "Kai Lowe", { notes: `Correction to ${g39.invoice.invoice_number}` }));
			eq("notes naming W39: W39 gains nothing", r.grid, ["2026-09-28", "2026-09-29"]);
		}
		{
			const r = await run("Lu Mars", (w, g39) => { w.db.prepare("UPDATE invoices SET adjustment = 25, adjustment_note = 'bonus' WHERE id = ?").run(g39.invoice.id); });
			eq("a $25 bonus: Thu and Fri go on W39", r.grid, BOTH);
		}
		{
			const r = await run("Mo Nash", async (w, g39) => {
				const m = await manualFor(w, "Mo Nash", { lineItems: [{ date: "2026-10-01", description: `Missed day (${g39.invoice.invoice_number})`, amount: 260 }], periodStart: "2026-10-01", periodEnd: "2026-10-01" });
				w.db.prepare("UPDATE invoices SET status = 'Rejected' WHERE id = ?").run(m.body.invoice.id);
				return m;
			});
			eq("a Rejected manual invoice does not block", r.grid, BOTH);
		}
		{
			const r = await run("Ned Oaks", async (w, g39) => {
				const m = await manualFor(w, "Ned Oaks", { lineItems: [{ date: "2026-10-01", description: `Missed day (${g39.invoice.invoice_number})`, amount: 260 }], periodStart: "2026-10-01", periodEnd: "2026-10-01" });
				w.db.prepare("UPDATE invoices SET deleted_at = '2026-10-05T00:00:00.000Z', deleted_by = 'super_admin' WHERE id = ?").run(m.body.invoice.id);
				return m;
			});
			eq("a soft-deleted manual invoice dated Thu: Thu is not carried, Fri is", r.grid, ["2026-09-28", "2026-09-29", "2026-10-02"]);
			ok("…and Thu is named in warnings with the deleted invoice", (r.g40.warnings || []).some((x) => x.includes("2026-10-01") && /deleted/.test(x)), JSON.stringify(r.g40.warnings));
		}
		{
			const r = await run("Oli Pratt", async (w, g39) => {
				const m = await manualFor(w, "Oli Pratt", { lineItems: [{ date: "2026-10-01", description: `Personal line (${g39.invoice.invoice_number})`, amount: 20 }], periodStart: "2026-10-01", periodEnd: "2026-10-01" });
				w.db.prepare("UPDATE invoices SET is_correction = 1 WHERE id = ?").run(m.body.invoice.id);
				return m;
			});
			eq("a Personal correction does not block", r.grid, BOTH);
		}
		{
			const r = await run("Pam Quin", (w, g39) => manualFor(w, "Pam Quin", { days: ["2026-10-20"], notes: `Follows ${g39.invoice.invoice_number}` }));
			eq("a manual invoice naming its days (another day) does not block, though its notes name W39", r.grid, BOTH);
		}
	});

	await R.test("B21 (round-three review) The checks run again inside the write, after the render: a manual invoice naming W39 written while W39's update renders, a manual invoice dated Thu written while an Approved W39's correction renders, and a $260 adjustment put on the Approved W39 meanwhile each refuse the write (INVOICE_DAY_MAY_BE_PAID): nothing written, no day claimed, the refusal in warnings", async ({ eq, ok }) => {
		const insertManual = (w, D, { lines, period, notes = "" }) => w.db.prepare(
			`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name, load_ids, expense_ids, render_data, is_manual, created_by)
			 VALUES (?, ?, ?, ?, 1, 0, 260, 0, 'Draft', ?, '[]', '[]', ?, 1, 'super_admin')`
		).run(`INV-M-T${Math.floor(Math.random() * 1e9)}`, norm(D), period[0], period[1], `m${Math.floor(Math.random() * 1e9)}.pdf`, JSON.stringify({ __templateName: "service_invoice_manual", lineItems: lines, notes }));
		const claimsFor = (w) => claimRows(w).filter(([d]) => d === "2026-10-01" || d === "2026-10-02");
		const refusedIn = (g) => (g.warnings || []).some((x) => /may already (be paid|pay them)/.test(x));
		{
			const D = "Quinn Ray";
			const w = boundaryWorld(D);
			const g39 = await W.generate(w, D, W39);
			deliverBoundaryLoad(w);
			const before = invoiceRow(w, g39.invoice.id);
			w.renderHook = () => { w.renderHook = null; insertManual(w, D, { lines: [{ date: "2026-10-20", description: `Missed days (${before.invoice_number})`, amount: 520 }], period: ["2026-10-20", "2026-10-20"] }); };
			const g40 = await W.generate(w, D, W40);
			const after = invoiceRow(w, g39.invoice.id);
			eq("Draft W39: the update refused, W39 as it was, Thu and Fri unclaimed", [after.render_data === before.render_data, after.total_earnings, claimsFor(w)], [true, 520, []]);
			ok("…and the refusal is in warnings", refusedIn(g40), JSON.stringify(g40.warnings));
		}
		{
			const D = "Rae Sloan";
			const w = boundaryWorld(D);
			const g39 = await W.generate(w, D, W39);
			w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(g39.invoice.id);
			deliverBoundaryLoad(w);
			w.renderHook = () => { w.renderHook = null; insertManual(w, D, { lines: [{ date: "2026-10-01", description: "Missed Thursday", amount: 260 }], period: ["2026-10-01", "2026-10-01"] }); };
			const g40 = await W.generate(w, D, W40);
			eq("Approved W39, a dated manual invoice written during the correction's render: no correction, nothing claimed", [corrections(w).length, claimsFor(w)], [0, []]);
			ok("…and the refusal is in warnings", refusedIn(g40), JSON.stringify(g40.warnings));
		}
		{
			const D = "Sid Tate";
			const w = boundaryWorld(D);
			const g39 = await W.generate(w, D, W39);
			w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(g39.invoice.id);
			deliverBoundaryLoad(w);
			w.renderHook = () => { w.renderHook = null; w.db.prepare("UPDATE invoices SET adjustment = 260, adjustment_note = 'missed day' WHERE id = ?").run(g39.invoice.id); };
			const g40 = await W.generate(w, D, W40);
			eq("Approved W39, a $260 adjustment put on it during the correction's render: no correction, nothing claimed", [corrections(w).length, claimsFor(w)], [0, []]);
			ok("…and the refusal is in warnings", refusedIn(g40), JSON.stringify(g40.warnings));
		}
	});

	await R.test("B22 (the owner's decision of 2026-10-15) Late days start at FROM's first week, not at the rule's first invoice: with FROM=2026-10, W40 (10/3-10/9) made before the rule's first invoice week (the stored marker says 10/10) still takes the late Thu 10/8 and Fri 10/9 of a load delivered after it, in place; W41 pays its own Sat-Mon. Base: refused as before the floor", async ({ eq, ok }) => {
		const D = "Tam Vale";
		const w = W.startWorld({
			env: TRIP("2026-10"),
			drivers: [{ name: D }],
			rows: [
				loadRow({ id: "Q2201", driver: D, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T1" }),
				loadRow({ id: "Q2202", driver: D, pickup: "2026-10-08 9:00", dropoff: "2026-10-12 14:00", assigned: "2026-10-08", done: "", status: "In Transit", truck: "T1" }),
			],
			status: [
				s("Q2201", "At Shipper", "2026-10-05 12:00:00"), s("Q2201", "Delivered", "2026-10-06 21:00:00"),
				s("Q2202", "At Shipper", "2026-10-08 13:00:00"), s("Q2202", "In Transit", "2026-10-08 18:00:00"),
			],
			now: etMs("2026-10-09 20:00"),
		});
		const g40 = await W.generate(w, D, W40);
		eq("W40 as made: Mon and Tue", W.dayList(W.gridDays(g40.data, W40)), ["2026-10-05", "2026-10-06"]);
		// As if the rule's first invoice had been the next week's: W40 came before the switch-on.
		w.db.prepare("UPDATE app_settings SET value = '2026-10-10' WHERE key = 'trip_work_days_started_at'").run();
		w.addStatus([s("Q2202", "At Receiver", "2026-10-12 15:00:00"), s("Q2202", "Delivered", "2026-10-12 17:00:00")]);
		w.setRow("Q2202", { "Job Status": "Delivered", "Status Update Date": "10/12/2026", "Completion Date": "10/12/2026" });
		w.clock.ms = etMs("2026-10-16 20:00");
		const g41 = await W.generate(w, D, "2026-10-16");
		eq("W40 now pays Thu and Fri too, in place", W.dayList(storedGrid(w, g40.invoice.id, W40)), ["2026-10-05", "2026-10-06", "2026-10-08", "2026-10-09"]);
		eq("the W41 response reports the update", g41.body && g41.body.lateWorkDays && g41.body.lateWorkDays.updated.map((u) => [u.invoiceNumber, u.days]), [[g40.invoice.invoice_number, ["2026-10-08", "2026-10-09"]]]);
		eq("W41 pays its own Sat-Mon", W.dayList(W.gridDays(g41.data, "2026-10-16")), ["2026-10-10", "2026-10-11", "2026-10-12"]);
		ok("no day is refused as before the floor", !(g41.warnings || []).some((x) => /before 20\d\d-\d\d-\d\d/.test(x)), JSON.stringify(g41.warnings));
	});

	await R.test("B23 (money review of 1cf2c20) An Approved W39 made while the rule was off has no paid-day rows (the start-up backfill did not run); with the rule on, its correction carries only the late Thu and Fri ($520), never the Mon and Tue already on its own grid", async ({ eq }) => {
		const D = "Vic Wynn";
		const w = boundaryWorld(D);
		const g39 = await W.generate(w, D, W39);
		// As made with the rule off: no invoice_paid_days row holds its days.
		w.db.prepare("DELETE FROM invoice_paid_days").run();
		w.db.prepare("UPDATE invoices SET status = 'Approved', approved_at = '2026-10-04T00:00:00.000Z', approved_by = 'super_admin' WHERE id = ?").run(g39.invoice.id);
		deliverBoundaryLoad(w);
		await W.generate(w, D, W40);
		eq("one correction for W39: Thu and Fri only, $520", corrections(w).map((c) => [c.correction_of, paidDaysOf(c), c.total_earnings]), [[g39.invoice.id, ["2026-10-01", "2026-10-02"], 520]]);
	});

	await R.test("B24 (re-review of 410ae4f) The Mon and Tue left out because the Approved W39's own grid already shows them are recorded as paid by W39 (invoice_paid_days), its amount and grid unchanged, so no later check reads them as unrecorded", async ({ eq }) => {
		const D = "Vic Wynn";
		const w = boundaryWorld(D);
		const g39 = await W.generate(w, D, W39);
		w.db.prepare("DELETE FROM invoice_paid_days").run();
		w.db.prepare("UPDATE invoices SET status = 'Approved', approved_at = '2026-10-04T00:00:00.000Z', approved_by = 'super_admin' WHERE id = ?").run(g39.invoice.id);
		const before = invoiceRow(w, g39.invoice.id);
		deliverBoundaryLoad(w);
		await W.generate(w, D, W40);
		const fix = corrections(w)[0] || {};
		eq("W39's days are held: Mon and Tue by W39, Thu and Fri by its correction", claimRows(w).filter(([d]) => WEEK39.includes(d)), [["2026-09-28", g39.invoice.id], ["2026-09-29", g39.invoice.id], ["2026-10-01", fix.id], ["2026-10-02", fix.id]]);
		const after = invoiceRow(w, g39.invoice.id);
		eq("W39's amount, status and grid are as approved", [after.total_earnings, after.status, after.render_data], [before.total_earnings, before.status, before.render_data]);
	});

	await R.test("P1 [rule d] The shapes of D01, D03, D07, D08, D10, D11, D13, D14, D27 and D28, one driver each, week 10/10-10/16, ELD from each truck's feed: the weekly invoice, the ledger and the investor view pay each driver the same days, rule d's", async ({ eq }) => {
		const { w, want } = ruleDWorld(TRIP("2026-10"));
		for (const [driver, days] of Object.entries(want)) {
			const g = await W.generate(w, driver, W41);
			eq(`${driver}: invoice`, invDays(g, W41), days);
			const v = await monthViews(w, driver);
			eq(`${driver}: ledger`, v.ledger, days.map((d) => `2026-10 ${d}`));
			eq(`${driver}: investor view`, v.investor, days.map((d) => `2026-10 ${d}`));
		}
	});

	await R.test("P2 (control) Flags off, and TRIP_WORK_DAYS_FROM set with the flag off: the same world pays today's window rule on all three paths (window days the truck's ELD shows travel on, the full window without a feed), and reads nothing the trip rule reads (the device-link table gone changes nothing)", async ({ eq }) => {
		const today = {
			"Abe Heading": ["2026-10-13", "2026-10-14"], "Bea Walk": ["2026-10-13", "2026-10-14"], "Cy Wait": ["2026-10-12", "2026-10-14", "2026-10-15"],
			"Dee Dock": ["2026-10-12", "2026-10-13"], "Eli Rest": ["2026-10-12", "2026-10-14"], "Fay Appt": ["2026-10-13"], "Gil Part": ["2026-10-13"],
			"Hal Late": ["2026-10-12", "2026-10-13"], "Ivy Multi": ["2026-10-12"], "Jay NoEld": ["2026-10-12", "2026-10-13", "2026-10-14"],
		};
		for (const [label, env, drop] of [["no flags", {}, false], ["FROM set, flag off", { TRIP_WORK_DAYS_FROM: "2026-10" }, false], ["no flags, no device-link table", {}, true]]) {
			const { w } = ruleDWorld(env);
			if (drop) w.db.exec("DROP TABLE eld_device_assignments");
			for (const [driver, days] of Object.entries(today)) {
				const g = await W.generate(w, driver, W41);
				eq(`${label}, ${driver}: invoice`, invDays(g, W41), days);
				const v = await monthViews(w, driver);
				eq(`${label}, ${driver}: ledger and investor view`, [v.ledger, v.investor], [days.map((d) => `2026-10 ${d}`), days.map((d) => `2026-10 ${d}`)]);
			}
		}
	});

	await R.test("P3 (control; the MR 10/2 shape) FROM=2026-10, W39 Approved without Thu and Fri, a live correction Draft dating Thu 10/1 and Fri 10/2: the late-day settle adds neither (no second correction), both named in warnings as possibly paid", async ({ eq, ok }) => {
		const D = "Mo Reyes";
		const w = boundaryWorld(D, { env: TRIP("2026-10") });
		const g39 = await W.generate(w, D, W39);
		w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(g39.invoice.id);
		const m = await W.route(w, "POST /api/invoices/manual", { body: { payee: D, periodStart: "2026-09-26", periodEnd: "2026-10-02", lineItems: [
			{ date: "2026-10-01", description: `Correction for ${g39.invoice.invoice_number}: Thursday, October 1, 2026, $260`, amount: 260 },
			{ date: "2026-10-02", description: `Correction for ${g39.invoice.invoice_number}: Friday, October 2, 2026, $260`, amount: 260 },
		] } });
		eq("the correction Draft is made", m.status, 200);
		deliverBoundaryLoad(w);
		const g40 = await W.generate(w, D, W40);
		eq("no correction made by the settle; W39 as approved", [corrections(w).length, W.dayList(storedGrid(w, g39.invoice.id, W39))], [0, ["2026-09-28", "2026-09-29"]]);
		ok("both named in warnings", ["2026-10-01", "2026-10-02"].every((d) => (g40.warnings || []).some((x) => x.includes(d) && x.includes(m.body.invoice.invoice_number))), JSON.stringify(g40.warnings));
	});

	await R.test("M1 (added 2026-10-21 item 2; the MR 10/2 shape as it stands) The correction Draft for Thu 10/1 and Fri 10/2 was deleted by a Super Admin: neither day is carried again automatically (no correction), each named in warnings with the deleted invoice; a deleted manual invoice dating another day (10/20) holds nothing. Base: a correction for both", async ({ eq, ok }) => {
		const D = "Mo Reyes";
		const setup = async (lines) => {
			const w = boundaryWorld(D, { env: TRIP("2026-10") });
			const g39 = await W.generate(w, D, W39);
			w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(g39.invoice.id);
			const m = await W.route(w, "POST /api/invoices/manual", { body: { payee: D, periodStart: lines[0].date, periodEnd: lines[lines.length - 1].date, lineItems: lines } });
			const del = await W.route(w, "DELETE /api/invoices/:id", { params: { id: String(m.body.invoice.id) }, query: { reason: "not valid" } });
			eq("the draft is deleted", [m.status, del.status], [200, 200]);
			deliverBoundaryLoad(w);
			const g40 = await W.generate(w, D, W40);
			return { w, g39, g40, number: m.body.invoice.invoice_number };
		};
		const a = await setup([{ date: "2026-10-01", description: "Correction: Thursday, October 1, 2026, $260", amount: 260 }, { date: "2026-10-02", description: "Correction: Friday, October 2, 2026, $260", amount: 260 }]);
		eq("no correction; W39 as approved", [corrections(a.w).length, W.dayList(storedGrid(a.w, a.g39.invoice.id, W39))], [0, ["2026-09-28", "2026-09-29"]]);
		ok("both named in warnings with the deleted invoice", ["2026-10-01", "2026-10-02"].every((d) => (a.g40.warnings || []).some((x) => x.includes(d) && x.includes(a.number) && /deleted/.test(x))), JSON.stringify(a.g40.warnings));
		eq("…reported as refused, kind deletedDraft", (a.g40.body && a.g40.body.lateWorkDays && a.g40.body.lateWorkDays.refused || []).map((r) => [r.day, r.kind]), [["2026-10-01", "deletedDraft"], ["2026-10-02", "deletedDraft"]]);
		const b = await setup([{ date: "2026-10-20", description: "Bonus", amount: 100 }]);
		eq("a deleted invoice dating 10/20: Thu and Fri go on a correction", corrections(b.w).map(paidDaysOf), [["2026-10-01", "2026-10-02"]]);
	});

	await R.test("M2 (added 2026-10-21 item 1; flag off) A missed-week Draft pays Thu 10/15 of a week with no weekly invoice (W41); the load's completion date is then edited into W41 and W41 generated: the weekly invoice leaves Thu off (named in warnings with the manual invoice) and bills Mon. Base: Thu billed twice", async ({ eq, ok }) => {
		const { w, number } = await skWorld({});
		const g = await W.generate(w, "Sol Kane", W41);
		eq("W41 bills Mon only", [g.status, invDays(g, W41)], [200, ["2026-10-12"]]);
		eq("Total Due", g.data && g.data.totalDue, 260);
		ok("Thu named in warnings with the manual invoice", (g.warnings || []).some((x) => x.includes("2026-10-15") && x.includes(number)), JSON.stringify(g.warnings));
	});

	await R.test("M3 (added 2026-10-21 item 1; TRIP_WORK_DAYS on, FROM=2026-10) The same: the weekly invoice is made (no 409), leaves Thu off and claims only Mon. Base: Thu billed twice and claimed by the weekly invoice", async ({ eq }) => {
		const { w } = await skWorld(TRIP("2026-10"), [s("Q4102", "At Shipper", "2026-10-15 13:00:00"), s("Q4102", "Delivered", "2026-10-15 21:00:00"), s("Q4101", "At Shipper", "2026-10-12 13:00:00"), s("Q4101", "Delivered", "2026-10-12 21:00:00")]);
		const g = await W.generate(w, "Sol Kane", W41);
		eq("W41: 200, Mon only", [g.status, invDays(g, W41)], [200, ["2026-10-12"]]);
		eq("the weekly invoice claims Mon only", claimRows(w).filter(([, id]) => id === (g.invoice && g.invoice.id)).map(([d]) => d), ["2026-10-12"]);
	});

	await R.test("M4 (added 2026-10-21 item 1; flag off) What holds a day for the weekly invoice: a live manual invoice's paidDays (no dated line) holds Thu; a Rejected one, a soft-deleted one and a Personal correction dating Thu hold nothing (Thu billed); an undated line over the week holds nothing but is named in warnings as possibly paying the week", async ({ eq, ok }) => {
		const line = { date: "2026-10-15", description: "Thursday", amount: 260 };
		const cases = [
			["paidDays only", { lineItems: [{ description: "Missed Thursday", amount: 260 }], paidDays: ["2026-10-15"] }, ["2026-10-12"]],
			["Rejected", { lineItems: [line], status: "Rejected" }, ["2026-10-12", "2026-10-15"]],
			["soft-deleted", { lineItems: [line], deleted: true }, ["2026-10-12", "2026-10-15"]],
			["Personal correction", { lineItems: [line], isCorrection: true }, ["2026-10-12", "2026-10-15"]],
			["undated line", { lineItems: [{ description: "Catch-up", amount: 260 }] }, ["2026-10-12", "2026-10-15"]],
		];
		for (const [label, manual, want] of cases) {
			const { w, number } = await skWorld({}, [], manual);
			const g = await W.generate(w, "Sol Kane", W41);
			eq(`${label}: W41 days`, invDays(g, W41), want);
			if (label === "undated line") ok("undated line: named in warnings", (g.warnings || []).some((x) => x.includes(number)), JSON.stringify(g.warnings));
		}
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
