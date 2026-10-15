#!/usr/bin/env node
/**
 * B12 runner D: how late days print (plan section 4.1(7), M3, cases D1-D4),
 * revised for the owner's rule of 2026-10-14 (Q8): a day found after its week's
 * invoice was generated NEVER goes on a later week's invoice. While that week's
 * invoice is not approved it is updated in place, so the day prints in its own
 * week's Saturday-Friday grid; once approved, a correction invoice for that week
 * carries it. There is no "Earlier days" section any more. FAILING TESTS
 * WRITTEN BEFORE THE FIX: on main no invoice takes a late day and every day is
 * priced at one rate. D4 pins today's rendering and passes on main.
 *
 * The contract:
 *   - a late day fills its own weekday in its week's grid ({ completed, total,
 *     loadBol }); the later week's render data has no earlierDays and leaves
 *     that weekday empty;
 *   - Total Due = the sum of each day's own rate (pay_rate_history); each grid
 *     day carries its rate;
 *   - PUT /api/invoices/:id/adjust re-renders from the stored render_data and
 *     keeps the added days;
 *   - an invoice without late days renders exactly as today.
 * The driver app's invoice view (plan F10) is not located, so these cases check
 * render_data, the stored row and the PDF field map (lib/policy-field-maps.js).
 *
 * Shipping code lifted from server.js (lib/work-days-world.js beside this runner);
 * the PDF render is stubbed and its input captured. TRIP_WORK_DAYS_ENABLED on,
 * FROM=2026-09. Made-up data only. Pure: no server, no app.db, no network.
 * Run: node scripts/pending/test-invoice-earlier-days-render.js    # exits 1 on failure (scripts/test-invoice-earlier-days-render.js once enabled)
 */
"use strict";
process.env.TZ = "UTC";
const path = require("path");
const W = require("./lib/work-days-world");
const { loadRow, etMs, daysFrom } = W;

const TRIP = { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-09" };
const W39 = "2026-10-02";
const W40 = "2026-10-09";
const s = (lid, status, at, source = "manual", actor = "") => [lid, status, source, at, actor];
const norm = (x) => x.trim().toLowerCase().replace(/\s+/g, " ");
const fieldMap = (data) => require(path.join(W.ROOT, "lib", "policy-field-maps.js")).service_invoice(data);
const stored = (w, id) => JSON.parse(w.db.prepare("SELECT render_data FROM invoices WHERE id = ?").get(id).render_data || "{}");

// W39 pays a Mon-Tue load; a load At Shipper Thu 10/1 is delivered Mon 10/5,
// after W39 was made, so W40's run puts Thu and Fri onto W39 (a Draft).
async function boundaryWeek({ driver = "Rex Ames", payDaily = 260, payRates = [] } = {}) {
	const w = W.startWorld({
		env: TRIP,
		drivers: [{ name: driver, payDaily }],
		payRates,
		rows: [
			loadRow({ id: "D101", driver, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
			loadRow({ id: "D102", driver, pickup: "2026-10-01 9:00", dropoff: "2026-10-05 14:00", assigned: "2026-10-01", done: "", status: "In Transit", truck: "T1" }),
		],
		status: [s("D101", "At Shipper", "2026-09-28 12:00:00"), s("D101", "Delivered", "2026-09-29 21:00:00"), s("D102", "At Shipper", "2026-10-01 14:00:00")],
		now: etMs("2026-10-02 20:00"),
	});
	const g39 = await W.generate(w, driver, W39);
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
			[{ loadBol: "D102", total: 260, completed: true }, { loadBol: "D102", total: 260, completed: true }]);
		eq("W39 grid days", W.dayList(W.gridDays(d39, W39)), ["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02"]);
		eq("W40: no earlierDays, grid Sat-Mon, its own Thursday and Friday empty",
			[g.data && g.data.earlierDays, W.dayList(W.gridDays(g.data, W40)), g.data && g.data.days.Thursday.completed, g.data && g.data.days.Friday.completed],
			[undefined, ["2026-10-03", "2026-10-04", "2026-10-05"], false, false]);
		eq("no invoice stores an earlierDays section", w.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE render_data LIKE '%earlierDays%'").get().n, 0);
	});

	await R.test("D2 Total Due is the sum of each day's own rate: one rate all week is days x rate (W39 4 x $260 = $1,040, W40 3 x $260 = $780); $280 until Fri 10/2 then $320 prices W39's late Thursday and Friday at $280 (W39 $1,120) and W40's grid at $320 ($960), each row at its rate; the runner-B B13 week gives $2,080", async ({ eq }) => {
		const one = await boundaryWeek();
		const row39 = one.w.db.prepare("SELECT total_earnings FROM invoices WHERE id = ?").get(one.g39.invoice.id);
		eq("one rate: W39 and W40 totals", [row39.total_earnings, stored(one.w, one.g39.invoice.id).totalDue, one.g.data && one.g.data.totalDue, one.g.invoice && one.g.invoice.total_earnings], [1040, 1040, 780, 780]);
		const key = norm("Sue Kemp");
		const two = await boundaryWeek({
			driver: "Sue Kemp", payDaily: 320,
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
			env: TRIP,
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

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
