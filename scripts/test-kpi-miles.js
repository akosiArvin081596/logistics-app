#!/usr/bin/env node
/**
 * The KPI bot's R10 mile metrics (lib/kpi-metrics.js over lib/kpi-miles.js and
 * lib/kpi-deadhead.js; catalog in lib/kpi-catalog.js): loaded_miles,
 * paid_miles, deadhead_miles, unloaded_miles, and paid_mile_share v2 with its
 * whole-month before/after.
 *
 * 12. whole months: before = up to the 3 complete months just before the
 *     contract month, a month under 90% dropped and not replaced; after = up to
 *     the first 3 complete months after; the contract month on its own; the
 *     current month as month to date and never on a side; an exact date splits
 *     the contract month into two rows, neither on a side; a side is summed
 *     miles over summed miles; each side carries its months, coverage,
 *     loaded-leg-only and nothing-on-file counts; the payload fits in 4,096
 *     bytes untrimmed.
 * 13. paid_mile_share v2 = paid / every ELD mile; null under 90% fully known,
 *     never scaled; a no_miles load adds its lane miles and is not covered; a
 *     load with nothing on file adds nothing; the assumption line carries both
 *     counts.
 * 14. from the contract month, no_miles is uncovered and none_stated is 0.
 * 15. unloaded_miles is never negative; a negative difference adds a warning.
 * 16. a dedicatedStart change lapses the approvals of paid_miles,
 *     paid_mile_share and truck_utilization only; versions 2 / 1 / 1.
 * 17. aggregates only: no load id, truck id or driver key in any output.
 * 28. dedicatedStart unset: paid_miles and paid_mile_share missing with the
 *     reason, no value, series, comparisons or before/after; the other three
 *     compute.
 * 29. comparisons gated for each of the five (89% missing with the note, 90%
 *     compares); deadhead at 69% never compares.
 * 30. truck_utilization with "2026-09" uses equal windows around 2026-09-01:
 *     the same figure as "2026-09-01", no month-mode fields.
 * 31. month-end dating: a load picked up Aug 30 with Completion Date Sep 2 puts
 *     its paid miles in September and its ELD miles in both months; the
 *     assumption line names the Completion Date.
 * 32. the paid-share assumption line carries both counts and the lane-miles
 *     sentence, and never says the share "can only read low".
 * H1 rule 6: a truck-month whose deadhead exceeds its empty miles warns.
 * The settings response: dedicatedStart carries its precision.
 *
 * Fixtures are made up ("zed sentinel" keys and names). Pure: no server, no
 * database, no network.
 *
 * Run: node scripts/test-kpi-miles.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const LIB = path.join(__dirname, "..", "lib");
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
for (const f of ["kpi-miles.js", "kpi-deadhead.js"]) if (!fs.existsSync(path.join(LIB, f))) die(`lib/${f} does not exist`);
const SOURCES = {
	metrics: fs.readFileSync(path.join(LIB, "kpi-metrics.js"), "utf8"),
	miles: fs.readFileSync(path.join(LIB, "kpi-miles.js"), "utf8"),
	catalog: fs.readFileSync(path.join(LIB, "kpi-catalog.js"), "utf8"),
};
function compileLib(file, src, overrides) {
	const filename = path.join(LIB, file);
	const req = Module.createRequire(filename);
	const localRequire = (id) => (overrides && Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : req(id));
	const m = { exports: {} };
	new Function("module", "exports", "require", "__filename", "__dirname", src)(m, m.exports, localRequire, filename, LIB);
	return m.exports;
}
function swap(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) die(`mutant anchor not found exactly once (${n}): ${from}`);
	return src.replace(from, () => to);
}
function build(edits) {
	const e = edits || {};
	let cat = SOURCES.catalog;
	let mil = SOURCES.miles;
	let met = SOURCES.metrics;
	for (const [a, b] of e.catalog || []) cat = swap(cat, a, b);
	for (const [a, b] of e.miles || []) mil = swap(mil, a, b);
	for (const [a, b] of e.metrics || []) met = swap(met, a, b);
	const catalog = compileLib("kpi-catalog.js", cat);
	const miles = compileLib("kpi-miles.js", mil, { "./kpi-catalog": catalog });
	const metrics = compileLib("kpi-metrics.js", met, { "./kpi-catalog": catalog, "./kpi-miles": miles });
	return { catalog, metrics };
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const TZ = "America/New_York";
const DAY_MS = 86400000;
const dayAdd = (day, n) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), 12) + n * DAY_MS).toISOString().slice(0, 10);
function eachDay(from, to, f) { for (let d = from; d <= to; d = dayAdd(d, 1)) f(d); }

let seq = 0;
// A delivered load on `day`. kinds: none (none_stated, loaded L), empty (ok,
// loaded L, empty E), flat (no_miles, lane L), nothing (no_text, no lane).
function load(day, kind, o) {
	const x = o || {};
	const n = ++seq;
	const L = x.L == null ? 1000 : x.L;
	const base = {
		key: `zed-sentinel-load-${n}`, status: "Delivered", day, driverKey: "zed sentinel driver", truckKey: "zed sentinel unit",
		pickupText: "", dropoffText: "", completionText: "",
		eldTruckId: x.truck || "1", pickupArriveMs: Date.parse(`${day}T11:00:00Z`) + (n % 5) * 60000, destArriveMs: Date.parse(`${day}T20:00:00Z`) + (n % 5) * 60000,
		originLat: 30, originLng: -95, destLat: 31, destLng: -96,
		laneMiles: null, rateconStatus: null, statedLoadedMiles: null, statedEmptyMiles: null,
	};
	if (kind === "none") Object.assign(base, { rateconStatus: "none_stated", statedLoadedMiles: L, statedEmptyMiles: 0, laneMiles: L });
	else if (kind === "empty") Object.assign(base, { rateconStatus: "ok", statedLoadedMiles: L, statedEmptyMiles: x.E == null ? 300 : x.E, laneMiles: L });
	else if (kind === "flat") Object.assign(base, { rateconStatus: "no_miles", laneMiles: L });
	else if (kind === "nothing") Object.assign(base, { rateconStatus: "no_text" });
	return Object.assign(base, x.extra || {});
}
// `count` loads of a kind, one a day from the month's first day (or `from`).
function loadsIn(month, count, kind, o) {
	const out = [];
	const first = (o && o.from) || `${month}-01`;
	for (let i = 0; i < count; i++) out.push(load(dayAdd(first, i), kind, o));
	return out;
}
// ELD rows: `perDay(day)` miles a day for a truck, from..to.
function eld(from, to, perDay, truck) {
	const rows = [];
	eachDay(from, to, (d) => rows.push({ day: d, truckId: truck || "1", miles: typeof perDay === "function" ? perDay(d) : perDay }));
	return rows;
}
function inputs(o) {
	return {
		asOfDay: o.asOfDay,
		timeZone: TZ,
		settings: { aiDispatchStart: null, dedicatedStart: o.dedicatedStart === undefined ? "2026-09" : o.dedicatedStart, baselineMpg: null },
		loads: [], ratecon: [], fleetHistory: [], fuelReceipts: [], arrivals: [], loadMiles: [], activity: {},
		eldDaily: o.eld,
		trucks: (o.trucks || ["1"]).map((id) => ({ id, status: "Active", createdDay: "2026-01-01", inServiceDay: "2026-01-01", retiredDay: null, hasEld: true })),
		milesLoads: o.loads,
		truckIdByUnit: new Map(),
		deadheadRoutes: o.routes || new Map(),
		truckAt: null,
	};
}
const PAYLOAD = (m) => JSON.stringify({ current: m.current, totals: m.totals, comparisons: m.comparisons, beforeAfter: m.beforeAfter,
	coverage: m.coverage, warnings: m.warnings, assumptions: m.assumptions, breakdown: m.breakdown, missingReason: m.missingReason });

// The year of the whole-month scenario (asOf 2027-01-10, contract 2026-09).
function yearWorld(o) {
	seq = 0;
	const x = o || {};
	const perDay = (d) => (d.slice(0, 7) === "2026-08" ? 100 : 1000);
	const loads = [
		...loadsIn("2026-05", 10, "none"),
		...loadsIn("2026-06", 5, "none"), ...loadsIn("2026-06", 5, "nothing", { from: "2026-06-10" }),
		...loadsIn("2026-07", 10, "none", { L: 1550 }),
		...loadsIn("2026-08", 10, "none", { L: 310 }),
		...(x.splitSeptember
			? [...loadsIn("2026-09", 5, "empty", { L: 2000, E: 500 }), ...loadsIn("2026-09", 5, "empty", { L: 2000, E: 500, from: "2026-09-16" })]
			: loadsIn("2026-09", 10, "empty", { L: 2000, E: 500 })),
		...loadsIn("2026-10", 20, "empty", { L: 1000, E: 300 }),
		...loadsIn("2026-11", 10, "none", { L: 2400 }), ...loadsIn("2026-11", 1, "flat", { L: 600, from: "2026-11-20" }),
		...loadsIn("2026-12", 9, "none", { L: 3000 }), ...loadsIn("2026-12", 1, "nothing", { from: "2026-12-20" }),
		...loadsIn("2027-01", 5, "none", { L: 1000 }),
	];
	return inputs({ asOfDay: x.asOfDay || "2027-01-10", dedicatedStart: "dedicatedStart" in x ? x.dedicatedStart : "2026-09", eld: eld("2026-05-01", dayAdd(x.asOfDay || "2027-01-10", -1), perDay), loads });
}

// ── the battery ──────────────────────────────────────────────────────────────
function battery(mods) {
	const r = [];
	const t = (cond, name, detail) => r.push({ ok: !!cond, name: detail === undefined ? name : `${name} (${detail})` });
	const M = mods.metrics;
	const C = mods.catalog;
	const get = (out, key) => out.metrics.find((m) => m.key === key);
	const ser = (m, p) => m.series.find((s) => s.period === p);
	const mom = (m) => m.comparisons.find((c) => c.kind === "mom");
	let out;
	try {
		out = M.computeKpis(yearWorld());
	} catch (e) {
		t(false, "§0 computeKpis runs on the fixtures", e && e.stack);
		return r;
	}
	t(out.errors.length === 0, "§0 no metric failed", JSON.stringify(out.errors));

	// 12. whole months
	{
		const share = get(out, "paid_mile_share");
		const ba = share.beforeAfter[0];
		t(share.beforeAfter.length === 1 && ba.event === "dedicated" && ba.precision === "month" && ba.date === "2026-09", "12 one month-mode entry for the contract start", JSON.stringify(ba && { e: ba.event, p: ba.precision, d: ba.date }));
		t(JSON.stringify(ba.before.months) === JSON.stringify(["2026-07", "2026-08"]) && JSON.stringify(ba.before.dropped) === JSON.stringify(["2026-06"]),
			"12 before: up to 3 complete months just before; June (50%) dropped and not replaced by May", JSON.stringify(ba.before));
		t(ba.before.value === 54.5 && ba.before.display === "54.5%", "12 a side is summed miles over summed miles (18,600 / 34,100), not the average of 50% and 100%", JSON.stringify(ba.before));
		t(ba.before.label === "July-August 2026", "12 the side names its months", ba.before.label);
		t(ba.before.coverage.num === 20 && ba.before.coverage.den === 20 && ba.before.loadedLegOnly === 0 && ba.before.nothingOnFile === 0 && ba.before.n === 20,
			"12 the before side's coverage and counts (over its months)", JSON.stringify(ba.before));
		t(JSON.stringify(ba.after.months) === JSON.stringify(["2026-10", "2026-11", "2026-12"]) && ba.after.value === 84.3,
			"12 after: the first 3 complete months after (77,600 / 92,000)", JSON.stringify(ba.after));
		t(ba.after.coverage.num === 39 && ba.after.coverage.den === 41 && ba.after.loadedLegOnly === 1 && ba.after.nothingOnFile === 1,
			"12 the after side carries its loaded-leg-only and nothing-on-file counts", JSON.stringify(ba.after));
		t(ba.contractMonth.length === 1 && ba.contractMonth[0].label === "September 2026" && ba.contractMonth[0].value === 83.3,
			"12 the contract month on its own (25,000 / 30,000)", JSON.stringify(ba.contractMonth));
		t(ba.monthToDate && ba.monthToDate.label === "January 1-10, 2027" && ba.monthToDate.value === 55.6,
			"12 the current month as month to date (5,000 / 9,000), on neither side", JSON.stringify(ba.monthToDate));
		t(ba.status === "ok" && ba.deltaPct !== null && /54\.5% → 84\.3%/.test(ba.display), "12 both sides: ok, with the change", ba.display);
		t(Buffer.byteLength(PAYLOAD(share), "utf8") <= 4096, "12 the whole payload fits in 4,096 bytes untrimmed", `${Buffer.byteLength(PAYLOAD(share), "utf8")} bytes`);

		const dec = get(M.computeKpis(yearWorld({ asOfDay: "2026-12-10" })), "paid_mile_share").beforeAfter[0];
		t(JSON.stringify(dec.after.months) === JSON.stringify(["2026-10", "2026-11"]) && dec.monthToDate.label === "December 1-10, 2026",
			"12 the current month is never on a side", JSON.stringify(dec.after.months));
		const oct = get(M.computeKpis(yearWorld({ asOfDay: "2026-10-14" })), "paid_mile_share").beforeAfter[0];
		t(oct.status === "insufficient" && oct.after.value === null && oct.after.display === "No full month yet" && oct.after.months.length === 0,
			"12 no complete month after the contract month yet: No full month yet", JSON.stringify(oct.after));

		const exact = get(M.computeKpis(yearWorld({ dedicatedStart: "2026-09-15", splitSeptember: true })), "paid_mile_share").beforeAfter[0];
		t(exact.precision === "day" && exact.date === "2026-09-15", "12 an exact date: precision day", JSON.stringify({ p: exact.precision, d: exact.date }));
		t(exact.contractMonth.length === 2 && exact.contractMonth[0].label === "September 1-14, before the start" && exact.contractMonth[1].label === "September 15-30, from the start",
			"12 the contract month is split into two rows", JSON.stringify(exact.contractMonth.map((x) => x.label)));
		t(exact.contractMonth[0].n === 5 && exact.contractMonth[1].n === 5, "12 each row counts its own loads", JSON.stringify(exact.contractMonth.map((x) => x.n)));
		t(JSON.stringify(exact.before.months) === JSON.stringify(["2026-07", "2026-08"]) && JSON.stringify(exact.after.months) === JSON.stringify(["2026-10", "2026-11", "2026-12"]),
			"12 neither split row joins a side: every side is whole months", JSON.stringify([exact.before.months, exact.after.months]));
		const exactShare = get(M.computeKpis(yearWorld({ dedicatedStart: "2026-09-15", splitSeptember: true })), "paid_mile_share");
		t(Buffer.byteLength(PAYLOAD(exactShare), "utf8") <= 4096, "12 the exact-date payload fits in 4,096 bytes too", `${Buffer.byteLength(PAYLOAD(exactShare), "utf8")} bytes`);
	}

	// 13. paid_mile_share v2
	{
		seq = 0;
		const loads = [...loadsIn("2026-09", 9, "none", { L: 2000 }), ...loadsIn("2026-09", 1, "flat", { L: 1500, from: "2026-09-20" })];
		const w = inputs({ asOfDay: "2026-10-05", dedicatedStart: "2026-09", eld: [...eld("2026-09-01", "2026-10-04", 1000), ...eld("2026-09-01", "2026-10-04", 500, "2")], trucks: ["1", "2"], loads });
		const share = get(M.computeKpis(w), "paid_mile_share");
		t(share.value === 43.3, "13 paid / every ELD mile, the idle truck's miles included: 19,500 / 45,000", share.value);
		t(ser(share, "2026-09").coverage === 0.9, "13 coverage: 9 of 10 fully known", JSON.stringify(ser(share, "2026-09")));
		const paid = get(M.computeKpis(w), "paid_miles");
		t(paid.value === 19500 && paid.coverage.num === 9 && paid.coverage.den === 10, "13 a no_miles load adds its lane miles and is not covered", JSON.stringify({ v: paid.value, c: paid.coverage }));
		seq = 0;
		const low = [...loadsIn("2026-09", 8, "none", { L: 2000 }), ...loadsIn("2026-09", 1, "nothing", { from: "2026-09-20" })];
		const lowShare = get(M.computeKpis(inputs({ asOfDay: "2026-10-05", eld: eld("2026-09-01", "2026-10-04", 1000), loads: low })), "paid_mile_share");
		t(lowShare.value === null && lowShare.display === "Not enough data", "13 under 90% fully known (8 of 9): no value, never scaled up", JSON.stringify({ v: lowShare.value, d: lowShare.display }));
		const lowPaid = get(M.computeKpis(inputs({ asOfDay: "2026-10-05", eld: eld("2026-09-01", "2026-10-04", 1000), loads: low })), "paid_miles");
		t(lowPaid.value === 16000, "13 a load with nothing on file adds nothing", lowPaid.value);
		const line = share.assumptions.find((a) => /only (its|their) loaded miles/.test(a)) || "";
		t(/September 2026: 1 load adds only its loaded miles \(empty leg unknown\) and 0 loads with no miles on file add nothing; both pull the share down\./.test(line),
			"13 the assumption line carries both counts", line);
	}

	// 14. from the contract month
	{
		seq = 0;
		const loads = [
			...loadsIn("2026-08", 1, "flat", { L: 700, from: "2026-08-20" }),
			...loadsIn("2026-09", 1, "flat", { L: 700, from: "2026-09-20" }),
			...loadsIn("2026-09", 1, "none", { L: 900, from: "2026-09-22" }),
		];
		const o = M.computeKpis(inputs({ asOfDay: "2026-10-05", eld: eld("2026-08-01", "2026-10-04", 1000), loads }));
		const paid = get(o, "paid_miles");
		t(ser(paid, "2026-08").value === 700 && ser(paid, "2026-08").coverage === 1, "14 before the contract month a flat-rate load counts its lane miles, fully known", JSON.stringify(ser(paid, "2026-08")));
		t(ser(paid, "2026-09").value === 1600 && ser(paid, "2026-09").coverage === 0.5, "14 from the contract month no_miles adds its lane miles but is not covered; none_stated is fully known with 0 empty", JSON.stringify(ser(paid, "2026-09")));
		const bd = paid.breakdown.find((b) => /loaded leg only/i.test(b.label));
		t(bd && bd.value === 1, "14 the breakdown counts the loaded-leg-only load", JSON.stringify(paid.breakdown));
	}

	// 15. unloaded never negative
	{
		seq = 0;
		const loads = [...loadsIn("2026-08", 10, "none", { L: 1000 }), ...loadsIn("2026-09", 10, "none", { L: 1000 })];
		const o = M.computeKpis(inputs({ asOfDay: "2026-10-05", eld: eld("2026-08-01", "2026-10-04", (d) => (d.slice(0, 7) === "2026-09" ? 10 : 1000)), loads }));
		const u = get(o, "unloaded_miles");
		t(ser(u, "2026-09").value === 0 && ser(u, "2026-08").value === 21000, "15 loaded miles over the ELD total show 0, never a negative", JSON.stringify([ser(u, "2026-08"), ser(u, "2026-09")]));
		t(u.warnings.some((w) => /September 2026/.test(w) && /exceed/.test(w)), "15 ...and the month is reported in a warning", JSON.stringify(u.warnings));
		seq = 0;
		const thin = [...loadsIn("2026-09", 8, "none"), ...loadsIn("2026-09", 1, "nothing", { from: "2026-09-20" })];
		const tu = get(M.computeKpis(inputs({ asOfDay: "2026-10-05", eld: eld("2026-09-01", "2026-10-04", 1000), loads: thin })), "unloaded_miles");
		t(tu.value === null && ser(tu, "2026-09").value === null, "15 shown only when loaded miles pass 90%", JSON.stringify(ser(tu, "2026-09")));
	}

	// 16. approvals and versions
	{
		const v = (k) => C.metricByKey(k).definitionVersion;
		t(v("paid_mile_share") === 2 && v("truck_utilization") === 1 && ["loaded_miles", "paid_miles", "deadhead_miles", "unloaded_miles"].every((k) => v(k) === 1),
			"16 versions: paid_mile_share 2, truck_utilization 1, the new four 1");
		const before = { dedicatedStart: "2026-09" };
		const after = { dedicatedStart: "2026-09-01" };
		const lapses = (k) => {
			const row = { approved: 1, definition_version: v(k), settings_hash: C.settingsHashFor(k, before) };
			return C.approvalIsValid(row, k, before) && !C.approvalIsValid(row, k, after);
		};
		t(["paid_miles", "paid_mile_share", "truck_utilization"].every(lapses), "16 '2026-09' -> '2026-09-01' lapses paid_miles, paid_mile_share and truck_utilization");
		t(!["loaded_miles", "deadhead_miles", "unloaded_miles"].some(lapses), "16 ...and not loaded_miles, deadhead_miles or unloaded_miles");
		const keys = C.METRIC_KEYS;
		t(keys.slice(-5).join() === "paid_mile_share,loaded_miles,paid_miles,deadhead_miles,unloaded_miles", "16 the four new keys follow paid_mile_share", keys.join());
	}

	// 17. aggregates only
	{
		seq = 0;
		const loads = loadsIn("2026-09", 10, "empty", { truck: "TRUCK-SENTINEL-1" });
		const o = M.computeKpis(inputs({ asOfDay: "2026-10-05", eld: eld("2026-09-01", "2026-10-04", 1000, "TRUCK-SENTINEL-1"), trucks: ["TRUCK-SENTINEL-1"], loads }));
		const text = JSON.stringify(o.metrics.filter((m) => ["loaded_miles", "paid_miles", "deadhead_miles", "unloaded_miles", "paid_mile_share"].includes(m.key)));
		t(!/sentinel/i.test(text), "17 no load id, truck id or driver key in any mile metric");
		t(!/sentinel/i.test(JSON.stringify(out)), "17 nor anywhere in the run's output");
	}

	// 28. dedicatedStart unset
	{
		const o = M.computeKpis(yearWorld({ dedicatedStart: null }));
		for (const k of ["paid_miles", "paid_mile_share"]) {
			const m = get(o, k);
			t(m.status === "missing" && m.missingReason === "Set the contract start month on the KPI page; paid miles depend on it." && m.value === null
				&& m.series.every((s) => s.value === null && s.display === "Not available") && m.comparisons.length === 0 && m.beforeAfter.length === 0,
				`28 unset: ${k} is missing with the reason, no value, series, comparisons or before/after`, JSON.stringify({ s: m.status, r: m.missingReason, b: m.beforeAfter.length }));
		}
		for (const k of ["loaded_miles", "deadhead_miles", "unloaded_miles"]) t(get(o, k).status !== "missing" && get(o, k).totals[0].value !== null, `28 unset: ${k} still computes`, get(o, k).status);
	}

	// 29. comparisons gated
	{
		const gate = (sepFull, sepNothing, sepNone) => {
			seq = 0;
			const loads = [
				...loadsIn("2026-08", 10, "empty"),
				...loadsIn("2026-09", sepFull, "empty"),
				...loadsIn("2026-09", sepNothing, "nothing", { from: "2026-09-15" }),
				...loadsIn("2026-09", sepNone, "none", { from: "2026-09-20" }),
			];
			return M.computeKpis(inputs({ asOfDay: "2026-10-14", dedicatedStart: "2026-06", eld: eld("2026-08-01", "2026-10-13", 1000), loads }));
		};
		const at90 = gate(9, 1, 0);
		const at89 = gate(8, 1, 0);
		for (const k of ["loaded_miles", "paid_miles", "unloaded_miles", "paid_mile_share", "deadhead_miles"]) {
			const ok = get(at90, k);
			const no = get(at89, k);
			t(mom(ok).status === "ok", `29 ${k}: September at 90% compares with August`, JSON.stringify({ c: mom(ok), s: ser(ok, "2026-09") }));
			t(mom(no).status === "missing" && no.assumptions.some((a) => /at least 90%/.test(a)), `29 ${k}: September at 89% does not, and says why`, JSON.stringify({ c: mom(no), a: no.assumptions }));
		}
		const dh = get(gate(9, 0, 4), "deadhead_miles");
		t(ser(dh, "2026-09").coverage === 0.6923 && mom(dh).status === "missing" && dh.status === "partial", "29 deadhead at 69%: never compares, marked partial", JSON.stringify({ c: ser(dh, "2026-09"), m: mom(dh), s: dh.status }));
		const others = gate(9, 0, 4);
		t(["loaded_miles", "paid_miles"].every((k) => mom(get(others, k)).status === "ok"), "29 ...while the fully known metrics compare");
	}

	// 30. truck_utilization stays on equal windows
	{
		const u1 = get(M.computeKpis(yearWorld({ dedicatedStart: "2026-09" })), "truck_utilization").beforeAfter.find((b) => b.event === "dedicated");
		const u2 = get(M.computeKpis(yearWorld({ dedicatedStart: "2026-09-01" })), "truck_utilization").beforeAfter.find((b) => b.event === "dedicated");
		t(u1.date === "2026-09-01" && JSON.stringify(u1) === JSON.stringify(u2), "30 '2026-09' gives the same equal windows as '2026-09-01'", JSON.stringify([u1, u2]));
		t(!("precision" in u1) && !("contractMonth" in u1), "30 no month-mode fields on truck_utilization");
	}

	// 31. month-end dating
	{
		seq = 0;
		const edge = load("2026-09-02", "none", { L: 500, extra: { pickupArriveMs: Date.parse("2026-08-30T14:00:00Z"), destArriveMs: Date.parse("2026-09-01T18:00:00Z") } });
		const o = M.computeKpis(inputs({ asOfDay: "2026-10-05", eld: eld("2026-08-25", "2026-09-05", 400), loads: [edge] }));
		const paid = get(o, "paid_miles");
		t(ser(paid, "2026-09").value === 500 && ser(paid, "2026-08").value === null, "31 all its paid miles in the month of its Completion Date", JSON.stringify([ser(paid, "2026-08"), ser(paid, "2026-09")]));
		const share = get(o, "paid_mile_share");
		t(ser(share, "2026-09").value === 25, "31 its ELD miles stay in both months: September's share is 500 / 2,000 (Sep 1-5), August's miles not in it", JSON.stringify(ser(share, "2026-09")));
		t(ser(share, "2026-08").display === "No records" && ser(get(o, "miles_driven"), "2026-08").value === 2800, "31 ...and August keeps its own ELD miles (Aug 25-31)", JSON.stringify(ser(share, "2026-08")));
		for (const k of ["loaded_miles", "paid_miles", "unloaded_miles", "paid_mile_share"]) {
			t(C.metricByKey(k).assumptions.some((a) => a.startsWith("Paid and loaded miles are dated by the load's Completion Date (else its drop-off, else its pickup appointment), ELD miles by the day driven.")),
				`31 ${k}: the dating line names the Completion Date`);
		}
	}

	// 32. the paid-share assumption line
	{
		seq = 0;
		const loads = [...loadsIn("2026-09", 18, "none", { L: 2000 }), ...loadsIn("2026-09", 2, "flat", { L: 1500, from: "2026-09-25" })];
		const share = get(M.computeKpis(inputs({ asOfDay: "2026-10-05", eld: eld("2026-09-01", "2026-10-04", 1000), loads })), "paid_mile_share");
		const all = share.assumptions.join(" ");
		t(/2 loads add only their loaded miles \(empty leg unknown\) and 0 loads with no miles on file add nothing; both pull the share down\./.test(all), "32 both counts", all);
		t(/Some loaded legs are Google's lane distance between the stated addresses \(flat-rate loads before the contract, and these 2 loads\)\. Lane miles can differ from the miles the broker paid in either direction\./.test(all), "32 the lane-miles sentence", all);
		const everything = `${all} ${C.metricByKey("paid_mile_share").assumptions.join(" ")}`;
		t(!/can only read low/i.test(everything), "32 never 'can only read low'");
	}

	// H1 rule 6: deadhead over the ELD's empty miles warns.
	{
		seq = 0;
		const loads = loadsIn("2026-09", 10, "empty", { L: 2500, E: 600 });
		const dh = get(M.computeKpis(inputs({ asOfDay: "2026-10-05", eld: eld("2026-09-01", "2026-10-04", 1000), loads })), "deadhead_miles");
		t(dh.value === 6000 && dh.warnings.some((w) => /September 2026/.test(w) && /empty miles/.test(w)), "rule 6: 6,000 deadhead over 5,000 empty miles (30,000 - 25,000) warns, naming the month only", JSON.stringify({ v: dh.value, w: dh.warnings }));
		seq = 0;
		const fine = loadsIn("2026-09", 10, "empty", { L: 2000, E: 600 });
		const dh2 = get(M.computeKpis(inputs({ asOfDay: "2026-10-05", eld: eld("2026-09-01", "2026-10-04", 1000), loads: fine })), "deadhead_miles");
		t(dh2.warnings.length === 0, "rule 6: within the empty miles, no warning", JSON.stringify(dh2.warnings));
	}

	// The settings response: dedicatedStart's precision.
	{
		const resp = (v) => M.buildKpiResponse({ asOfDay: "2026-10-14", settings: { dedicatedStart: v }, snapshots: [], series: [], approvals: [] }).settings.dedicatedStart;
		t(JSON.stringify(resp("2026-09")) === JSON.stringify({ value: "2026-09", source: "admin", precision: "month" }), "settings: a month", JSON.stringify(resp("2026-09")));
		t(JSON.stringify(resp("2026-09-15")) === JSON.stringify({ value: "2026-09-15", source: "admin", precision: "day" }), "settings: a day");
		t(JSON.stringify(resp(null)) === JSON.stringify({ value: null, source: null, precision: null }) && resp("2026-13").value === null, "settings: unset or unreadable");
	}
	return r;
}

// ── run ──────────────────────────────────────────────────────────────────────
let pass = 0;
const failures = [];
for (const x of battery(build())) {
	if (x.ok) pass++;
	else failures.push(x.name);
}

const MUTANTS = [
	["sides averaged month by month", "12 a side is summed miles", { metrics: [["const value = sumEld > 0 ? (sumPaid / sumEld) * 100 : null;", "const value = passing.length ? passing.reduce((s, x) => s + x.share, 0) / passing.length : null;"]] }],
	["a failing month replaced by an earlier one", "12 before: up to 3 complete months", { metrics: [["const beforeMonths = [addMonths(cm, -3), addMonths(cm, -2), addMonths(cm, -1)];", "const beforeMonths = [addMonths(cm, -4), addMonths(cm, -3), addMonths(cm, -2), addMonths(cm, -1)];"]] }],
	["the current month on the after side", "12 the current month is never on a side", { metrics: [["const afterMonths = [addMonths(cm, 1), addMonths(cm, 2), addMonths(cm, 3)].filter((m) => m < asOfMonth);", "const afterMonths = [addMonths(cm, 1), addMonths(cm, 2), addMonths(cm, 3)].filter((m) => m <= asOfMonth);"]] }],
	["the share shown under 90%", "13 under 90% fully known", { metrics: [["if (!(s.n > 0 && s.fullyN / s.n >= COMPARE_MIN_COVERAGE)) return null;", "if (!(s.n > 0)) return null;"]] }],
	["loaded-leg-only loads counted as fully known", "14 from the contract month", { miles: [["if (lane != null || empty != null) return { kind: \"loaded_leg_only\", full: null, partial: (lane || 0) + (empty || 0) };", "if (lane != null || empty != null) return { kind: \"flat_lane\", full: (lane || 0) + (empty || 0), partial: null };"]] }],
	["unloaded shown below 0", "15 loaded miles over the ELD total", { metrics: [["const unloaded = Math.max(0, s.eldTotal - s.loadedSum);", "const unloaded = s.eldTotal - s.loadedSum;"]] }],
	["paid miles computed without the contract start", "28 unset: paid_miles", { metrics: [["if (!contract) return missingResult(\"paid_miles\", CONTRACT_NOT_SET, ctx);", "if (false) return missingResult(\"paid_miles\", CONTRACT_NOT_SET, ctx);"]] }],
	["the new metrics compare on any month", "29 loaded_miles: September at 89%", { metrics: [["\t\tminCompareCoverage: COMPARE_MIN_COVERAGE,\n\t\tcompareCoverageNote: MILES_COMPARE_NOTE,", "\t\tcompareCoverageNote: MILES_COMPARE_NOTE,"]] }],
	["utilization moved to month mode", "30 '2026-09' gives the same equal windows", { metrics: [["const dedicatedDate = contract ? contract.startDay : null;", "const dedicatedDate = contract && contract.precision === \"day\" ? contract.startDay : null;"]] }],
	["paid miles dated by the pickup", "31 all its paid miles in the month", { miles: [["\t\t\tday: l.day,\n\t\t\ttruckId,", "\t\t\tday: new Date(l.pickupArriveMs).toISOString().slice(0, 10),\n\t\t\ttruckId,"]] }],
	["the deadhead warning dropped", "rule 6:", { metrics: [["if (t.deadhead > Math.max(0, t.eld - t.loaded)) over.add(monthOf(t.day));", "if (false) over.add(monthOf(t.day));"]] }],
	["dedicatedStart not part of paid_miles' approval", "16 '2026-09' -> '2026-09-01' lapses", { catalog: [["\t], [\"dedicatedStart\"], null, 1),\n\tentry(\"deadhead_miles\"", "\t], [], null, 1),\n\tentry(\"deadhead_miles\""]] }],
];
for (const [name, expect, edits] of MUTANTS) {
	let res;
	try {
		res = battery(build(edits));
	} catch (e) {
		res = [{ ok: false, name: `${expect} (the mutant threw: ${e && e.message})` }];
	}
	const caught = res.some((x) => !x.ok && x.name.includes(expect));
	if (caught) pass++;
	else failures.push(`MUTANT ${name}: not caught by "${expect}"`);
}

if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed (${MUTANTS.length} mutants caught)`);
