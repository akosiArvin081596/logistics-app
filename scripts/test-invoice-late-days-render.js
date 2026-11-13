#!/usr/bin/env node
/**
 * B12 runner D: how late days print (plan section 4.1(7), M3, cases D1-D4),
 * revised for the owner's rule of 2026-10-14 (Q8): a day found after its week's
 * invoice was generated NEVER goes on a later week's invoice. While that week's
 * invoice is not approved it is updated in place, so the day prints in its own
 * week's Saturday-Friday grid; once approved, a correction invoice for that week
 * carries it. There is no "Earlier days" section any more. Written before the
 * fix, which they failed: on main no invoice takes a late day and every day is
 * priced at one rate. D4 pins today's rendering and passed on main too.
 *
 * The contract:
 *   - a late day fills its own weekday in its week's grid ({ completed, total,
 *     loadBol }); the later week's render data has no earlierDays and leaves
 *     that weekday empty;
 *   - Total Due = the sum of each day's own rate; each grid day carries its
 *     rate. Dated rates (pay_rate_history) price days only under the daily-rate
 *     rule (DRIVER_RATE_ONLY; revised 2026-10-21: the trip rule alone reads none,
 *     so D2's two-rate weeks run with both rules on);
 *   - PUT /api/invoices/:id/adjust re-renders from the stored render_data and
 *     keeps the added days;
 *   - an invoice without late days renders exactly as today;
 *   - the weekly performance page (D5, D6): a snapshot with one redraws it as
 *     stored, on a late-day update and an adjust; one without never gains one.
 * The driver app's invoice view (plan F10) is not located, so these cases check
 * render_data, the stored row and the PDF field map (lib/policy-field-maps.js).
 *
 * Shipping code lifted from server.js (lib/work-days-world.js beside this runner);
 * the PDF render is stubbed and its input captured. TRIP_WORK_DAYS_ENABLED on,
 * FROM=2026-09. Made-up data only. Pure: no server, no app.db, no network.
 * Run: node scripts/test-invoice-late-days-render.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const path = require("path");
const W = require("./lib/work-days-world");
const { loadRow, etMs, daysFrom } = W;

const TRIP = { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-09" };
// The daily-rate rule from the same month: the rule that reads dated rates.
const DATED = { ...TRIP, DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-09" };
const W39 = "2026-10-02";
const W40 = "2026-10-09";
const s = (lid, status, at, source = "manual", actor = "") => [lid, status, source, at, actor];
const norm = (x) => x.trim().toLowerCase().replace(/\s+/g, " ");
const fieldMap = (data) => require(path.join(W.ROOT, "lib", "policy-field-maps.js")).service_invoice(data);
const stored = (w, id) => JSON.parse(w.db.prepare("SELECT render_data FROM invoices WHERE id = ?").get(id).render_data || "{}");

// W39 pays a Mon-Tue load; a load At Shipper Thu 10/1 is delivered Mon 10/5,
// after W39 was made, so W40's run puts Thu and Fri onto W39 (a Draft).
// `expose`, `setup(w)` before W39 is made and `between(w, g39)` after: D5 and D6.
async function boundaryWeek({ driver = "Rex Ames", payDaily = 260, payRates = [], env = TRIP, expose = [], setup = null, between = null } = {}) {
	const w = W.startWorld({
		env,
		expose,
		drivers: [{ name: driver, payDaily }],
		payRates,
		rows: [
			loadRow({ id: "D101", driver, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
			loadRow({ id: "D102", driver, pickup: "2026-10-01 9:00", dropoff: "2026-10-05 14:00", assigned: "2026-10-01", done: "", status: "In Transit", truck: "T1" }),
		],
		status: [s("D101", "At Shipper", "2026-09-28 12:00:00"), s("D101", "Delivered", "2026-09-29 21:00:00"), s("D102", "At Shipper", "2026-10-01 14:00:00")],
		now: etMs("2026-10-02 20:00"),
	});
	if (setup) setup(w);
	const g39 = await W.generate(w, driver, W39);
	if (between) between(w, g39);
	w.addStatus([s("D102", "At Receiver", "2026-10-05 15:00:00"), s("D102", "Delivered", "2026-10-05 17:00:00")]);
	w.setRow("D102", { "Job Status": "Delivered", "Status Update Date": "10/5/2026", "Completion Date": "10/5/2026" });
	w.clock.ms = etMs("2026-10-09 20:00");
	const g = await W.generate(w, driver, W40);
	return { w, g, g39, driver };
}

const R = W.createRunner("B12 D: late days print in their own week's invoice");

(async () => {
	await R.test("D1 [revised 2026-10-14] Late days fill their own weekdays in their own week's grid: W39's Thursday and Friday (load D102, $260 each); W40's render data has no earlierDays and leaves its own Thursday and Friday empty", async ({ eq }) => {
		const { w, g, g39 } = await boundaryWeek();
		const d39 = stored(w, g39.invoice.id);
		eq("W39 Thursday and Friday", [d39.days && d39.days.Thursday, d39.days && d39.days.Friday],
			// `rate`: the day's Daily Rate column figure, stored with it (test-invoice-daily-rate-label.js);
			// `date`, `listed` and `scheduled`: the row's day and the loads its PDF row
			// names, stored with every row (test-invoice-day-rows.js).
			[{ date: "2026-10-01", loadBol: "D102", total: 260, completed: true, listed: ["D102"], scheduled: [], rate: 260 },
				{ date: "2026-10-02", loadBol: "D102", total: 260, completed: true, listed: ["D102"], scheduled: [], rate: 260 }]);
		eq("W39 grid days", W.dayList(W.gridDays(d39, W39)), ["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02"]);
		eq("W40: no earlierDays, grid Sat-Mon, its own Thursday and Friday empty",
			[g.data && g.data.earlierDays, W.dayList(W.gridDays(g.data, W40)), g.data && g.data.days.Thursday.completed, g.data && g.data.days.Friday.completed],
			[undefined, ["2026-10-03", "2026-10-04", "2026-10-05"], false, false]);
		eq("no invoice stores an earlierDays section", w.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE render_data LIKE '%earlierDays%'").get().n, 0);
	});

	await R.test("D2 [revised 2026-10-21] Total Due is the sum of each day's own rate: one rate all week is days x rate (W39 4 x $260 = $1,040, W40 3 x $260 = $780); with the daily-rate rule on too, $280 until Fri 10/2 then $320 prices W39's late Thursday and Friday at $280 (W39 $1,120) and W40's grid at $320 ($960), each row at its rate; the runner-B B13 week gives $2,080", async ({ eq }) => {
		const one = await boundaryWeek();
		const row39 = one.w.db.prepare("SELECT total_earnings FROM invoices WHERE id = ?").get(one.g39.invoice.id);
		eq("one rate: W39 and W40 totals", [row39.total_earnings, stored(one.w, one.g39.invoice.id).totalDue, one.g.data && one.g.data.totalDue, one.g.invoice && one.g.invoice.total_earnings], [1040, 1040, 780, 780]);
		const key = norm("Sue Kemp");
		const two = await boundaryWeek({
			driver: "Sue Kemp", payDaily: 320, env: DATED,
			payRates: [{ subject: "driver", key, rate: 280, from: "2026-09-01T12:00:00.000Z" }, { subject: "driver", key, rate: 320, from: "2026-10-03T13:00:00.000Z" }],
		});
		const d39 = stored(two.w, two.g39.invoice.id);
		eq("two rates: W39 days, each at its rate", W.gridDays(d39, W39).map((e) => [e.day, e.total]), [["2026-09-28", 280], ["2026-09-29", 280], ["2026-10-01", 280], ["2026-10-02", 280]]);
		eq("two rates: W39 Total Due", d39.totalDue, 1120);
		eq("two rates: W40 grid days at $320", W.gridDays(two.g.data, W40).map((e) => [e.day, e.total]), [["2026-10-03", 320], ["2026-10-04", 320], ["2026-10-05", 320]]);
		eq("two rates: W40 Total Due", two.g.data && two.g.data.totalDue, 960);
		eq("two rates: the PDF's Saturday row (W40)", fieldMap(two.g.data || {}).text["Saturday total"], "320.00");
		eq("two rates: the PDF's Thursday row (W39)", fieldMap(d39).text["Thursday total"], "280.00");
		const D = "Ola Stone";
		const w = W.startWorld({
			env: DATED,
			drivers: [{ name: D, payDaily: 320 }],
			payRates: [{ subject: "driver", key: norm(D), rate: 280, from: "2026-09-01T12:00:00.000Z" }, { subject: "driver", key: norm(D), rate: 320, from: "2026-09-30T13:00:00.000Z" }],
			rows: [loadRow({ id: "D201", driver: D, pickup: "2026-09-26 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-09-26", done: "2026-10-02", truck: "T1" })],
			status: [s("D201", "At Shipper", "2026-09-26 12:00:00"), s("D201", "Delivered", "2026-10-02 22:00:00")],
		});
		const b13 = await W.generate(w, D, W39);
		eq("the B13 week: Total Due", b13.data && b13.data.totalDue, 2080);
	});

	await R.test("D3 The adjust re-render (PUT /api/invoices/:id/adjust) of the updated W39 keeps the added days, with the adjustment layered on", async ({ eq, ok }) => {
		const { w, g39 } = await boundaryWeek();
		const before = W.gridDays(stored(w, g39.invoice.id), W39);
		ok("W39 has the added days to keep", before.length === 4, JSON.stringify(before));
		const n = w.rendered.length;
		const r = await W.route(w, "PUT /api/invoices/:id/adjust", { params: { id: String(g39.invoice.id) }, body: { adjustment: 50, adjustmentNote: "fuel advance" } });
		eq("adjust: 200", r.status, 200);
		const again = w.rendered.length > n ? w.rendered[w.rendered.length - 1].data : null;
		eq("re-rendered with the same days and the adjustment", again && [W.gridDays(again, W39), again.adjustment], [before, 50]);
		eq("the stored snapshot keeps them", W.gridDays(stored(w, g39.invoice.id), W39), before);
	});

	await R.test("D4 An invoice with no earlier days renders exactly as today: the same render data, stored row and PDF fields with the flag on as off", async ({ eq }) => {
		const D = "Tom Vick";
		const snap = async (env) => {
			const w = W.startWorld({
				env,
				drivers: [{ name: D }],
				rows: [loadRow({ id: "D401", driver: D, pickup: "2026-09-29 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-29", done: "2026-09-30", truck: "T1" })],
				status: [s("D401", "At Shipper", "2026-09-29 13:00:00"), s("D401", "Delivered", "2026-09-30 20:00:00")],
			});
			const g = await W.generate(w, D, W39);
			const data = { ...(g.data || {}) };
			if (Array.isArray(data.earlierDays) && data.earlierDays.length === 0) delete data.earlierDays;
			const row = g.invoice ? { total: g.invoice.total_earnings, days: g.invoice.loads_count, rate: g.invoice.rate_per_load } : null;
			return { status: g.status, data, row, fields: fieldMap(g.data || {}) };
		};
		const off = await snap({});
		eq("today: two days at $260", [off.row, W.dayList(W.gridDays(off.data, W39))], [{ total: 520, days: 2, rate: 260 }, daysFrom("2026-09-29", "2026-09-30")]);
		eq("flag on: identical", await snap(TRIP), off);
	});

	// The weekly performance page (INVOICE_PERFORMANCE_COPY_ENABLED): a page is the words a snapshot was
	// made with, so every redraw prints it as stored, and a snapshot without one never gains one.
	const PAGE_ON = { ...TRIP, INVOICE_PERFORMANCE_COPY_ENABLED: "true" };
	const rules = require(path.join(W.ROOT, "lib", "driver-performance.js"));
	// His week for each invoice's week, as invoiceWeek() answers it: made-up figures through the real rules.
	const answerFor = (weekStart) => ({
		week: rules.personalWeek({
			id: "this-week", start: weekStart, end: rules.addDays(weekStart, 6), today: rules.addDays(weekStart, 6), deliveries: weekStart === "2026-09-26" ? 2 : 1, pickups: 1, offDays: [], openLoad: true,
			loads: [rules.countedLoad({ loadId: weekStart === "2026-09-26" ? "D101" : "D102", pickupDay: rules.addDays(weekStart, 2), deliveryDay: rules.addDays(weekStart, 3) })],
		}),
		weights: { ...rules.CREDIT_WEIGHTS },
		hours: null,
	});
	const withPages = (w) => { w.api.invoicePerformance.week = async ({ weekStart }) => answerFor(weekStart); };
	const rendersOf = (w, invoice) => w.rendered.filter((r) => r.data && `INV-${r.data.invoiceNumberSuffix}` === invoice.invoice_number).map((r) => r.data);
	const pageOf = (data) => (data && Object.prototype.hasOwnProperty.call(data, "performance") ? data.performance : "(none)");

	await R.test("D5 [the weekly performance page] With its switch on, a snapshot made without the page (an invoice from before the switch) redraws with none: its late-day update and its adjust print no page, the field map gives the renderer none, and the stored snapshot never gains one. Passes on the base too", async ({ eq }) => {
		const { w, g39 } = await boundaryWeek({
			env: PAGE_ON,
			expose: W.SRC.includes("\nconst invoicePerformance = ") ? ["invoicePerformance"] : [],
			setup: (x) => { if (x.api.invoicePerformance) withPages(x); },
			// W39 as an invoice made before the switch went on: its snapshot holds no page.
			between: (x, g) => {
				const row = x.db.prepare("SELECT render_data FROM invoices WHERE id = ?").get(g.invoice.id);
				const snap = JSON.parse(row.render_data);
				delete snap.performance;
				x.db.prepare("UPDATE invoices SET render_data = ? WHERE id = ?").run(JSON.stringify(snap), g.invoice.id);
			},
		});
		const late = rendersOf(w, g39.invoice);
		eq("(the scene) W39 drawn twice: made, then its late days", late.length, 2);
		eq("the late-day update draws no page", pageOf(late[1]), "(none)");
		await W.route(w, "PUT /api/invoices/:id/adjust", { params: { id: String(g39.invoice.id) }, body: { adjustment: 25, adjustmentNote: "made-up" } });
		const again = rendersOf(w, g39.invoice);
		eq("and its adjust draws none", pageOf(again[again.length - 1]), "(none)");
		eq("the field map hands the renderer no page", fieldMap(again[again.length - 1] || {}).performancePage || null, null);
		eq("the stored snapshot gains none", pageOf(stored(w, g39.invoice.id)), "(none)");
	});

	await R.test("D6 [the weekly performance page] A snapshot with the page redraws it as stored: W39's late-day update and its adjust print the page W39 was made with (as of Fri Oct 2, 8:00 PM ET), and W40 keeps its own (Fri Oct 9). Base: no page", async ({ eq, ok }) => {
		const { w, g, g39 } = await boundaryWeek({ env: PAGE_ON, expose: ["invoicePerformance"], setup: withPages });
		const made = pageOf(stored(w, g39.invoice.id));
		ok("(the scene) W39 was made with a page, as of its own generate", made && made.asOf === "As of Fri Oct 2, 8:00 PM ET", JSON.stringify(made));
		const draws = rendersOf(w, g39.invoice);
		eq("(the scene) W39 drawn twice: made, then its late days, Thursday and Friday added", [draws.length, W.gridDays(stored(w, g39.invoice.id), W39).length], [2, 4]);
		eq("the late-day update draws the page as made", pageOf(draws[1]), made);
		eq("and stores it as made", pageOf(stored(w, g39.invoice.id)), made);
		eq("W40 keeps its own page, as of its own generate", pageOf(stored(w, g.invoice.id)).asOf, "As of Fri Oct 9, 8:00 PM ET");
		await W.route(w, "PUT /api/invoices/:id/adjust", { params: { id: String(g39.invoice.id) }, body: { adjustment: 25, adjustmentNote: "made-up" } });
		const again = rendersOf(w, g39.invoice);
		eq("its adjust draws the page as made", pageOf(again[again.length - 1]), made);
		eq("and the field map hands it to the renderer whole", JSON.stringify(fieldMap(again[again.length - 1] || {}).performancePage), JSON.stringify(made));
		eq("the stored snapshot keeps it", pageOf(stored(w, g39.invoice.id)), made);
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
