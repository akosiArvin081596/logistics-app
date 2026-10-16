#!/usr/bin/env node
/**
 * The weekly invoice PDF's Daily Rate column (the user's go-ahead, 2026-10-16):
 * each worked day shows the rate that day was priced at, not a fixed "$300.00"
 * (onboarding-templates/policy/service-invoice.html printed it for every driver
 * since #338, whatever he was paid).
 *
 *   - POST /api/invoices/generate stores each paid day's rate in the day grid
 *     (render_data.days[<weekday>].rate), and a late day added in place
 *     carries its rate the same way;
 *   - lib/policy-field-maps.js service_invoice() fills "<weekday> daily rate"
 *     from it: "$150.00" for a $150 driver, "$350.00" for a $350 one, each day
 *     its own rate in a week with two rates (the daily-rate rule,
 *     DRIVER_RATE_ONLY); a day not worked shows nothing;
 *   - an invoice stored before the rate was recorded, if something re-renders
 *     it, shows each worked day's own total, which is that day's one rate;
 *     issued invoices are never regenerated or rewritten by this;
 *   - the template has no fixed rate left, and its rate cell carries the label
 *     the field map fills; the owner-operator and manual invoices have no Daily
 *     Rate column and are unchanged.
 *
 * Every case but L8 (the control) fails on the base, which stores no rate and
 * fills no Daily Rate label.
 *
 * Made-up data only: investor 5 owns T1 ($150 a day on the truck) and T2
 * ($300). Hal Reed has no rate of his own and drives T1; Ana Moss has her own
 * $350 and drives T2. Pure: no server, no app.db, no network, no browser.
 *
 * Run: node scripts/test-invoice-daily-rate-label.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC"; // production's clock zone

const fs = require("fs");
const path = require("path");
function findRoot(dir) {
	while (!fs.existsSync(path.join(dir, "server.js"))) {
		const up = path.dirname(dir);
		if (up === dir) throw new Error("server.js not found above this runner");
		dir = up;
	}
	return dir;
}
const ROOT = findRoot(__dirname);
const M = require(path.join(ROOT, "scripts", "lib", "money-plans-world.js"));
const FIELD_MAPS = require(path.join(ROOT, "lib", "policy-field-maps.js"));
const TEMPLATE = fs.readFileSync(path.join(ROOT, "onboarding-templates", "policy", "service-invoice.html"), "utf8");
const { loadRow, et } = M;

const HAL = "Hal Reed";
const ANA = "Ana Moss";
const WEEK = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const ON = { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" };
const TRIP_OCT = { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-10" };
const W39 = "2026-10-02"; // Sat 9/26 - Fri 10/2
const W40 = "2026-10-09"; // Sat 10/3 - Fri 10/9
const s = (lid, status, wall) => [lid, status, "manual", et(wall), ""];

function world({ env = {}, rows = null, status = [], now = Date.parse("2026-10-16T17:00:00Z") } = {}) {
	return M.startWorld({
		env, status, now,
		drivers: [{ name: HAL, payDaily: 0 }, { name: ANA, payDaily: 350 }],
		trucks: [{ unit: "T1", driver: HAL, payDaily: 150 }, { unit: "T2", driver: ANA, payDaily: 300 }],
		rows: rows || [
			loadRow({ id: "H902", driver: HAL, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" }),
			loadRow({ id: "A901", driver: ANA, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T2" }),
		],
	});
}
// The Daily Rate column the PDF would print, Saturday to Friday.
const rateColumn = (data) => WEEK.map((d) => FIELD_MAPS.service_invoice(data).text[`${d} daily rate`]);
const storedGrid = (w, id) => JSON.parse(w.db.prepare("SELECT render_data FROM invoices WHERE id = ?").get(id).render_data || "{}").days || {};

const R = M.createRunner("The weekly invoice PDF's Daily Rate column shows each day's own rate, not a fixed $300.00");

(async () => {
	await R.test("L1 A $150 driver (no rate of his own, on a $150 truck): Mon-Wed print $150.00 in the Daily Rate column, the other days nothing. Base: no Daily Rate figure is filled (the template's fixed $300.00 shows)", async ({ eq }) => {
		const g = await M.generate(world(), HAL, W40);
		eq("status", g.status, 200);
		eq("Daily Rate column", rateColumn(g.data), ["", "", "$150.00", "$150.00", "$150.00", "", ""]);
	});

	await R.test("L2 A $350 driver (her own rate over her $300 truck): Mon-Tue print $350.00. Base: no Daily Rate figure is filled", async ({ eq }) => {
		const g = await M.generate(world(), ANA, W40);
		eq("Daily Rate column", rateColumn(g.data), ["", "", "$350.00", "$350.00", "", "", ""]);
	});

	await R.test("L3 The stored invoice (render_data) keeps each paid day's rate beside its total, so a later re-render prints the same. Base: no rate stored", async ({ eq }) => {
		const w = world();
		const g = await M.generate(w, HAL, W40);
		const days = storedGrid(w, g.invoice.id);
		eq("Monday-Wednesday", ["Monday", "Tuesday", "Wednesday"].map((d) => [days[d].total, days[d].rate]), [[150, 150], [150, 150], [150, 150]]);
		eq("a day not worked has none", days.Saturday.rate, undefined);
	});

	await R.test("L4 The template prints no fixed rate: its rate cell carries the \"<weekday> daily rate\" label the field map fills, and $300.00 / DAILY_RATE = 300 are gone. Base: a fixed $300.00", async ({ eq, ok }) => {
		ok("the rate cell is labelled", TEMPLATE.includes('<td class="rate-cell" aria-label="${day} daily rate"></td>'));
		eq("no fixed rate", [TEMPLATE.includes("$300.00"), /DAILY_RATE\s*=\s*300/.test(TEMPLATE)], [false, false]);
		const labels = Object.keys(FIELD_MAPS.service_invoice({ days: {} }).text).filter((k) => / daily rate$/.test(k));
		eq("the field map fills each weekday's", labels, WEEK.map((d) => `${d} daily rate`));
	});

	await R.test("L5 An invoice stored before the rate was recorded, re-rendered: each worked day shows its own total as its rate; a day not worked nothing. Base: no Daily Rate figure is filled", async ({ eq }) => {
		const old = { days: { Monday: { loadBol: "H902", total: 150, completed: true }, Tuesday: { loadBol: "H902", total: 150, completed: true }, Friday: { loadBol: "", total: 0, completed: false } } };
		eq("Daily Rate column", rateColumn(old), ["", "", "$150.00", "$150.00", "", "", ""]);
	});

	await R.test("L6 Flag on (DRIVER_RATE_ONLY, FROM 2026-10), a week straddling FROM: the September-assigned load's days print $150.00, the October load's Friday $250.00. Base: Friday priced and printed nowhere as $250.00", async ({ eq }) => {
		const w = world({
			env: ON,
			rows: [
				loadRow({ id: "S901", driver: HAL, pickup: "2026-09-29 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-09-29", done: "2026-10-01", truck: "T1" }),
				loadRow({ id: "S902", driver: HAL, pickup: "2026-10-02 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-02", done: "2026-10-02", truck: "T1" }),
			],
		});
		const g = await M.generate(w, HAL, W39);
		eq("Daily Rate column", rateColumn(g.data), ["", "", "", "$150.00", "$150.00", "$150.00", "$250.00"]);
	});

	await R.test("L7 A late day added to a Draft in place (the trip work-day rule) carries its rate: W39's Thursday and Friday, on an October load, print $250.00 with the rule on. Base: no rate stored", async ({ eq }) => {
		const w = world({
			env: { ...ON, ...TRIP_OCT }, now: M.etMs("2026-10-02 20:00"),
			rows: [
				loadRow({ id: "Q301", driver: HAL, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
				loadRow({ id: "Q302", driver: HAL, pickup: "2026-10-01 9:00", dropoff: "2026-10-05 14:00", assigned: "2026-10-01", done: "", status: "In Transit", truck: "T1" }),
			],
			status: [
				s("Q301", "At Shipper", "2026-09-28 08:00"), s("Q301", "Delivered", "2026-09-29 17:00"),
				s("Q302", "At Shipper", "2026-10-01 10:00"), s("Q302", "In Transit", "2026-10-01 14:00"),
			],
		});
		const g39 = await M.generate(w, HAL, W39);
		w.addStatus([s("Q302", "At Receiver", "2026-10-05 11:00"), s("Q302", "Delivered", "2026-10-05 13:00")]);
		w.setRow("Q302", { "Job Status": "Delivered", "Status Update Date": "10/5/2026", "Completion Date": "10/5/2026" });
		w.clock.ms = M.etMs("2026-10-09 20:00");
		await M.generate(w, HAL, W40);
		eq("W39's Daily Rate column after the late days", rateColumn({ days: storedGrid(w, g39.invoice.id) }), ["", "", "$150.00", "$150.00", "", "$250.00", "$250.00"]);
	});

	await R.test("L8 Control: the owner-operator and manual invoices have no Daily Rate column, and their field maps fill no such label", async ({ eq }) => {
		const ownerOp = Object.keys(FIELD_MAPS.service_invoice_owner_op({}).text || {}).filter((k) => /daily rate/i.test(k));
		const manual = FIELD_MAPS.service_invoice_manual ? Object.keys(FIELD_MAPS.service_invoice_manual({ lineItems: [], deductions: [] }).text || {}).filter((k) => /daily rate/i.test(k)) : [];
		eq("labels", [ownerOp, manual], [[], []]);
	});

	R.finish();
})();
