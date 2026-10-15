#!/usr/bin/env node
/**
 * B12 runner D: the invoice's "Earlier days" section (plan section 4.1(7), M3,
 * cases D1-D4). FAILING TESTS WRITTEN BEFORE THE FIX: on main no invoice has
 * earlier days and every day is priced at one rate. D4 pins today's rendering and
 * passes on main.
 *
 * The contract (from the plan):
 *   - render_data.earlierDays: [{ day, loadBol, total }], apart from the Sat-Fri
 *     grid (which buckets by weekday name, so an earlier Thursday must not land
 *     in this week's Thursday); the invoice template prints "Earlier days";
 *   - Total Due = the sum over grid days and earlier days of each day's own rate
 *     (pay_rate_history); each day row carries its rate;
 *   - PUT /api/invoices/:id/adjust re-renders from the stored render_data and
 *     keeps the section;
 *   - an invoice with no earlier days renders exactly as today.
 * The driver app's invoice view (plan F10) is not located, so these cases check
 * render_data, the stored row and the PDF field map (lib/policy-field-maps.js),
 * not that view.
 *
 * Shipping code lifted from server.js (lib/work-days-world.js beside this runner);
 * the PDF render is stubbed and its input captured. TRIP_WORK_DAYS_ENABLED on,
 * FROM=2026-09. Made-up data only. Pure: no server, no app.db, no network.
 * Run: node scripts/pending/test-invoice-earlier-days-render.js    # exits 1 on failure (scripts/test-invoice-earlier-days-render.js once enabled)
 */
"use strict";
process.env.TZ = "UTC";
const fs = require("fs");
const path = require("path");
const W = require("./lib/work-days-world");
const { loadRow, etMs, daysFrom } = W;

const TRIP = { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-09" };
const W39 = "2026-10-02";
const W40 = "2026-10-09";
const s = (lid, status, at, source = "manual", actor = "") => [lid, status, source, at, actor];
const norm = (x) => x.trim().toLowerCase().replace(/\s+/g, " ");
const fieldMap = (data) => require(path.join(W.ROOT, "lib", "policy-field-maps.js")).service_invoice(data);

// W39 pays a Mon-Tue load; a load At Shipper Thu 10/1 is delivered Mon 10/5,
// after W39 was made, so W40 carries Thu and Fri as earlier days.
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
	await W.generate(w, driver, W39);
	w.addStatus([s("D102", "At Receiver", "2026-10-05 15:00:00"), s("D102", "Delivered", "2026-10-05 17:00:00")]);
	w.setRow("D102", { "Job Status": "Delivered", "Status Update Date": "10/5/2026", "Completion Date": "10/5/2026" });
	w.clock.ms = etMs("2026-10-09 20:00");
	const g = await W.generate(w, driver, W40);
	return { w, g, driver };
}

const R = W.createRunner("B12 D: the invoice's Earlier days section");

(async () => {
	await R.test("D1 render_data.earlierDays is its own section beside the Sat-Fri grid: W40 carries Thu 10/1 and Fri 10/2 there (load D102, $260 each) while its grid shows Sat-Mon and leaves its own Thu and Fri empty; the invoice template prints \"Earlier days\"", async ({ eq, ok }) => {
		const { g } = await boundaryWeek();
		eq("earlierDays", g.data && g.data.earlierDays, [{ day: "2026-10-01", loadBol: "D102", total: 260 }, { day: "2026-10-02", loadBol: "D102", total: 260 }]);
		eq("grid days", W.dayList(W.gridDays(g.data, W40)), ["2026-10-03", "2026-10-04", "2026-10-05"]);
		eq("this week's Thursday and Friday stay empty", [g.data && g.data.days.Thursday.completed, g.data && g.data.days.Friday.completed], [false, false]);
		const template = fs.readFileSync(path.join(W.ROOT, "onboarding-templates", "policy", "service-invoice.html"), "utf8");
		const map = fs.readFileSync(path.join(W.ROOT, "lib", "policy-field-maps.js"), "utf8");
		ok("the template (or its field map) prints \"Earlier days\"", /Earlier days/i.test(template) || /Earlier days/i.test(map));
	});

	await R.test("D2 Total Due is the sum of each day's own rate over grid and earlier days: one rate all week is days x rate (5 x $260 = $1,300); $280 until Fri 10/2 then $320 gives 2 x $280 earlier + 3 x $320 grid = $1,520, each row at its rate; the runner-B B13 week gives $2,080", async ({ eq }) => {
		const one = await boundaryWeek();
		eq("one rate: Total Due and the stored total", [one.g.data && one.g.data.totalDue, one.g.invoice && one.g.invoice.total_earnings], [1300, 1300]);
		const key = norm("Sue Kemp");
		const two = await boundaryWeek({
			driver: "Sue Kemp", payDaily: 320,
			payRates: [{ subject: "driver", key, rate: 280, from: "2026-09-01T12:00:00.000Z" }, { subject: "driver", key, rate: 320, from: "2026-10-03T13:00:00.000Z" }],
		});
		eq("two rates: earlier days at $280", W.earlierDays(two.g.data).map((e) => [e.day, e.total]), [["2026-10-01", 280], ["2026-10-02", 280]]);
		eq("two rates: grid days at $320", W.gridDays(two.g.data, W40).map((e) => [e.day, e.total]), [["2026-10-03", 320], ["2026-10-04", 320], ["2026-10-05", 320]]);
		eq("two rates: Total Due", two.g.data && two.g.data.totalDue, 1520);
		eq("two rates: the PDF's Saturday row", fieldMap(two.g.data || {}).text["Saturday total"], "320.00");
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

	await R.test("D3 The adjust re-render (PUT /api/invoices/:id/adjust) keeps the earlier-days section, with the adjustment layered on", async ({ eq, ok }) => {
		const { w, g } = await boundaryWeek();
		const before = g.data && g.data.earlierDays;
		ok("the invoice has earlier days to keep", Array.isArray(before) && before.length === 2, JSON.stringify(before));
		const n = w.rendered.length;
		const r = await W.route(w, "PUT /api/invoices/:id/adjust", { params: { id: String(g.invoice && g.invoice.id) }, body: { adjustment: 50, adjustmentNote: "fuel advance" } });
		eq("adjust: 200", r.status, 200);
		const again = w.rendered.length > n ? w.rendered[w.rendered.length - 1].data : null;
		eq("re-rendered with the same earlier days and the adjustment", again && [again.earlierDays, again.adjustment], [before, 50]);
		const stored = JSON.parse(w.db.prepare("SELECT render_data FROM invoices WHERE id = ?").get(g.invoice.id).render_data);
		eq("the stored snapshot keeps them", stored.earlierDays, before);
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
