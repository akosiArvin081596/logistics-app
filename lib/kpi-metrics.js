"use strict";
// THE KPI BOT'S FORMULAS: every company KPI in lib/kpi-catalog.js, computed from
// the records the nightly job gathers, and the GET /api/admin/kpis response built
// from what that job stored.
//
//   computeKpis(inputs)        -> { metrics: MetricResult[], derived, errors }
//   buildKpiResponse({...})    -> the GET /api/admin/kpis JSON
//
// The inputs are gathered by server.js (one Job Tracking read, the Financials
// ledger, SQLite aggregates); this file only computes. Every figure it returns
// carries its display string, so neither the browser nor the digest does
// arithmetic, and every output is an aggregate: a load id, a driver key or a
// truck id goes in, and never comes out in any field, label or note.
//
// PERIODS. Each metric has a monthly series from KPI_SERIES_START (April 2025)
// to the month of asOfDay; "current" is the last COMPLETE month before asOfDay's
// month (trucks in fleet, a point-in-time count, is today instead); totals are
// "All time" and "Month to date". Every period is a range of days measured the
// same way, so a ratio over three months is the ratio of the sums, not the
// average of three ratios.
//
// MISSING IS NOT ZERO. A month before a metric's records begin reads "No data";
// a month after they begin with no source rows at all reads "No records" (loads:
// December 2025 to March 2026). Both have value null, and a comparison against
// either is 'missing', never a 100% rise from nothing. A comparison against a
// real zero is 'missing' too: a rise from zero has no percentage.
//
// BEFORE AND AFTER. Truck utilization and paid-mile share are compared before
// and after two dates (AI dispatch start, dedicated contracts start). The windows
// are equal in length, at most 90 days, never overlap (the date itself counts as
// "after"), and the "before" window must lie inside the metric's records: when
// records begin on or after the date there is no "before" ('missing'), and fewer
// than 14 truck-days or loads on either side is 'insufficient'.
//
// HISTORY NEVER READS TODAY'S STATUS. A truck's status (Inactive) has no date,
// so past months count trucks by their service dates alone
// (truckServiceBounds(t, "stop") in lib/investor-payout-basis.js); only today's
// fleet count applies the status.
//
// CONFIDENCE. high: a real measurement with coverage of at least 80%. medium: a
// real measurement with lower coverage, or a proxy. low: an estimate, or any
// warning. none: missing or not tracked.
//
// Dates: a 'YYYY-MM-DD' is a calendar date; day arithmetic runs on keys anchored
// at 12:00 UTC and never through a zone. Money is formatted with
// toLocaleString("en-US"), never the runtime's locale.
//
// Pure: no I/O, no environment reads. Requires the catalog, the weight parser,
// the appointment judge, and truckServiceBounds() / truckInFleet() from
// lib/investor-payout-basis.js, all pure.

const catalog = require("./kpi-catalog");
const { parseWeight, isPlausibleLb } = require("./kpi-weight");
const { judgeArrival } = require("./kpi-appointments");
const { truckServiceBounds, truckInFleet } = require("./investor-payout-basis");

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
// The delivered statuses, exactly: the dashboard, the invoice week and dispatch
// read the same three. "Delivery Scheduled" is not delivered.
const DELIVERED_STATUS_RE = /^(delivered|completed|pod received)$/i;
// server.js's CANCELED_STATUS_RE. The gatherer passes live rows only
// (liveJobTrackingView()); this is the second check, for the metrics that count
// loads of any status.
const DROPPED_STATUS_RE = /^(cancel|canceled|cancelled)$/i;
const SERIES_START_DAY = `${catalog.KPI_SERIES_START}-01`;
const COVERAGE_OK = 0.8;
const MIN_SIDE_N = 14;
const BEFORE_AFTER_MAX_DAYS = 90;
const ESTIMATE_MIN_WEIGHTED = 20;
// A truck-day counts as active above this many ELD miles (yard moves and GPS
// drift are not work).
const ACTIVE_DAY_MILES = 1;
// The derived AI dispatch start: the first delivered email-path load that opens
// a 14-day window holding at least 3 of them (one stray early load is not a start).
const AI_START_WINDOW_DAYS = 14;
const AI_START_MIN_LOADS = 3;
const NO_DATA = "No data";
const NO_RECORDS = "No records";
const NOT_AVAILABLE = "Not available";
const ON_TIME_WARNING = "Recorded appointments are not updated when a load is rescheduled; review before publishing.";
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ── small helpers ──────────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, "0");
const arr = (v) => (Array.isArray(v) ? v : []);
const trimmed = (v) => String(v == null ? "" : v).trim();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function isDay(v) {
	if (typeof v !== "string" || !DAY_RE.test(v)) return false;
	const y = +v.slice(0, 4);
	const mo = +v.slice(5, 7);
	const d = +v.slice(8, 10);
	const t = new Date(Date.UTC(y, mo - 1, d, 12));
	return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
function noon(day) {
	return Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), 12);
}
function addDays(day, n) {
	return new Date(noon(day) + n * DAY_MS).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
	return Math.round((noon(b) - noon(a)) / DAY_MS);
}
function monthOf(day) {
	return day.slice(0, 7);
}
function addMonths(month, n) {
	const total = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1) + n;
	return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
}
function monthStart(month) {
	return `${month}-01`;
}
function monthEnd(month) {
	return addDays(monthStart(addMonths(month, 1)), -1);
}
// Every month from `from` to `to`, inclusive ('YYYY-MM').
function monthSeries(from, to) {
	const out = [];
	if (!MONTH_RE.test(String(from)) || !MONTH_RE.test(String(to))) return out;
	for (let m = from; m <= to && out.length < 1200; m = addMonths(m, 1)) out.push(m);
	return out;
}
function monthLabel(month) {
	return `${MONTH_NAMES[+month.slice(5, 7) - 1]} ${month.slice(0, 4)}`;
}
function dayLabel(day) {
	return `${MONTH_NAMES[+day.slice(5, 7) - 1]} ${+day.slice(8, 10)}, ${day.slice(0, 4)}`;
}
// "Jul–Sep 2026", or "Nov 2025–Jan 2026" across a year end.
function rangeLabel(fromMonth, toMonth) {
	const short = (m) => MONTH_NAMES[+m.slice(5, 7) - 1].slice(0, 3);
	return fromMonth.slice(0, 4) === toMonth.slice(0, 4)
		? `${short(fromMonth)}–${short(toMonth)} ${toMonth.slice(0, 4)}`
		: `${short(fromMonth)} ${fromMonth.slice(0, 4)}–${short(toMonth)} ${toMonth.slice(0, 4)}`;
}
// The same calendar day a year earlier (29 February -> 28 February).
function dayYearBefore(day) {
	const y = +day.slice(0, 4) - 1;
	const mo = +day.slice(5, 7);
	let d = +day.slice(8, 10);
	while (d > 28 && !isDay(`${y}-${pad2(mo)}-${pad2(d)}`)) d--;
	return `${y}-${pad2(mo)}-${pad2(d)}`;
}
function minDay(days) {
	let best = null;
	for (const d of days) if (d && (best == null || d < best)) best = d;
	return best;
}
function sum(list, f) {
	let t = 0;
	for (const x of list) t += f(x);
	return t;
}
function countWithin(days, from, to) {
	let n = 0;
	for (const d of days) if (d >= from && d <= to) n++;
	return n;
}
function within(list, from, to) {
	return list.filter((x) => x.day >= from && x.day <= to);
}
// A load id as both sides spell it: trimmed, without a leading "#", lower case.
function loadKey(id) {
	return String(id == null ? "" : id).trim().replace(/^#/, "").toLowerCase();
}
function lbToTons(lb) {
	return lb / catalog.LB_PER_TON;
}

function isDeliveredStatus(status) {
	return DELIVERED_STATUS_RE.test(trimmed(status));
}

// ── display ────────────────────────────────────────────────────────────────────
const DIGITS_BY_UNIT = { count: 0, usd: 2, lb_tons: 1, miles: 1, pct: 1, trucks: 0, units: 0, mpg: 2, gallons: 1, t_co2: 1 };

// A value as stored: rounded to the precision its unit is shown at, or a little finer.
function roundValue(unit, value) {
	if (!isNum(value)) return null;
	const digits = Object.prototype.hasOwnProperty.call(DIGITS_BY_UNIT, unit) ? DIGITS_BY_UNIT[unit] : 2;
	const f = 10 ** digits;
	return (Math.round(value * f) / f) || 0;
}

function fixed(value, digits) {
	return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// The display string for a value of a unit: "$53,344", "1,953 t", "30.0%",
// "8.0 mpg", "22,245 mi", "122 t CO2". null (or not a number) reads "No data".
function formatDisplay(unit, value) {
	if (!isNum(value)) return NO_DATA;
	const whole = Math.round(value) || 0;
	switch (unit) {
		case "usd": return `${whole < 0 ? "-" : ""}$${fixed(Math.abs(whole), 0)}`;
		case "lb_tons": return `${fixed(value, Math.abs(value) < 100 ? 1 : 0)} t`;
		case "miles": return `${fixed(whole, 0)} mi`;
		case "pct": return `${fixed(value, 1)}%`;
		case "mpg": return `${fixed(value, 1)} mpg`;
		case "gallons": return `${fixed(whole, 0)} gal`;
		case "t_co2": return `${fixed(value, Math.abs(value) < 100 ? 1 : 0)} t CO2`;
		case "trucks": return `${fixed(whole, 0)} ${whole === 1 ? "truck" : "trucks"}`;
		case "units": return `${fixed(whole, 0)} ${whole === 1 ? "unit" : "units"}`;
		default: return fixed(whole, 0);
	}
}
function signed(value, digits) {
	const r = Math.round(value * 10 ** digits) / 10 ** digits || 0;
	return `${r > 0 ? "+" : r < 0 ? "-" : ""}${fixed(Math.abs(r), digits)}`;
}

// One comparison. deltaPct is the relative change in percent for every unit; the
// display of a rate (pct) is its change in percentage points, which is how a
// rate's change reads ("30% -> 36%" is "+6.0 pts", not "+20%"). A missing value
// or a missing or zero base is 'missing'.
function compare({ kind, label, basePeriod, value, baseValue, unit }) {
	const v = isNum(value) ? value : null;
	const b = isNum(baseValue) ? baseValue : null;
	if (v == null || b == null || b === 0) {
		return { kind, label, basePeriod, value: v, baseValue: b, deltaPct: null, display: NOT_AVAILABLE, status: "missing" };
	}
	const deltaPct = Math.round(((v - b) / Math.abs(b)) * 1000) / 10 || 0;
	const display = unit === "pct" ? `${signed(v - b, 1)} pts` : `${signed(deltaPct, 1)}%`;
	return { kind, label, basePeriod, value: v, baseValue: b, deltaPct, display, status: "ok" };
}

function confidenceFor(kind, status, ratio, warnings) {
	if (status === "missing" || status === "not_tracked") return "none";
	if (kind === "estimate" || (warnings && warnings.length)) return "low";
	if (kind === "proxy" || status === "partial") return "medium";
	if (kind === "real" && (ratio == null || ratio >= COVERAGE_OK)) return "high";
	return "medium";
}

function coverageOf(num, den, what, from, to) {
	const n = isNum(num) ? num : 0;
	const d = isNum(den) ? den : 0;
	return { num: n, den: d, ratio: d > 0 ? Math.round((n / d) * 10000) / 10000 : null, what, from: from || null, to: to || null };
}

// ── before / after ─────────────────────────────────────────────────────────────
// `measure(from, to)` -> { value, n }. `date` is the event day ('YYYY-MM-DD') or null.
function beforeAfterFor({ event, date, dataStart, asOfDay, measure, unit, sampleWord, notSetNote }) {
	const head = { event, date: date || null };
	const side = (from, to) => {
		const m = measure(from, to);
		const value = isNum(m.value) ? roundValue(unit, m.value) : null;
		return { value, n: m.n || 0, display: value == null ? NO_DATA : formatDisplay(unit, m.value) };
	};
	if (!date) return { ...head, status: "date_not_set", before: null, after: null, deltaPct: null, display: "Date not set", note: notSetNote };
	if (date > asOfDay) {
		return { ...head, status: "missing", before: null, after: null, deltaPct: null, display: NOT_AVAILABLE, note: `The date ${date} is after the last day measured.` };
	}
	if (!dataStart || dataStart >= date) {
		const afterTo = addDays(date, BEFORE_AFTER_MAX_DAYS - 1) < asOfDay ? addDays(date, BEFORE_AFTER_MAX_DAYS - 1) : asOfDay;
		return {
			...head, status: "missing",
			before: { value: null, n: 0, display: NO_DATA },
			after: dataStart ? side(date, afterTo) : { value: null, n: 0, display: NO_DATA },
			deltaPct: null, display: "No data before the date",
			note: dataStart ? `Records begin ${dataStart}, so there is nothing before ${date} to compare with.` : "No records yet.",
		};
	}
	const length = Math.min(daysBetween(dataStart, date), daysBetween(date, asOfDay) + 1, BEFORE_AFTER_MAX_DAYS);
	const beforeFrom = addDays(date, -length);
	const beforeTo = addDays(date, -1);
	const afterTo = addDays(date, length - 1);
	const before = side(beforeFrom, beforeTo);
	const after = side(date, afterTo);
	const windowNote = `${length} days on each side of ${date} (${beforeFrom} to ${beforeTo}, and ${date} to ${afterTo}).`;
	if (before.n < MIN_SIDE_N || after.n < MIN_SIDE_N) {
		return {
			...head, status: "insufficient", before, after, deltaPct: null, display: "Too few to compare",
			note: `Needs at least ${MIN_SIDE_N} ${sampleWord} on each side; has ${before.n} before and ${after.n} after. ${windowNote}`,
		};
	}
	const c = compare({ kind: "before_after", label: "", basePeriod: "", value: after.value, baseValue: before.value, unit });
	return {
		...head, status: c.status === "ok" ? "ok" : "missing", before, after, deltaPct: c.deltaPct,
		display: `${before.display} → ${after.display}${c.status === "ok" ? ` (${c.display})` : ""}`,
		note: windowNote,
	};
}

// ── result builders ────────────────────────────────────────────────────────────
function emptySeries(ctx, display) {
	return monthSeries(catalog.KPI_SERIES_START, ctx.asOfMonth).map((period) => ({ period, value: null, display, coverage: null }));
}
function currentShell(ctx, display) {
	const cm = ctx.currentMonth;
	return { from: monthStart(cm), to: monthEnd(cm), value: null, display, label: monthLabel(cm) };
}

// A metric that cannot be computed: no baseline, too few weights, a failure.
function missingResult(key, reason, ctx, extra) {
	const e = extra || {};
	const current = currentShell(ctx, NOT_AVAILABLE);
	return {
		key, status: "missing", missingReason: reason,
		value: null, display: NOT_AVAILABLE,
		current,
		totals: [
			{ label: "All time", from: SERIES_START_DAY, to: ctx.asOfDay, value: null, display: NOT_AVAILABLE },
			{ label: "Month to date", from: monthStart(ctx.asOfMonth), to: ctx.asOfDay, value: null, display: NOT_AVAILABLE },
		],
		series: emptySeries(ctx, NOT_AVAILABLE),
		comparisons: [],
		beforeAfter: [],
		coverage: e.coverage || coverageOf(0, 0, "", null, null),
		confidence: "none",
		warnings: e.warnings || [],
		assumptions: e.assumptions || [],
		breakdown: e.breakdown || null,
	};
}

function notTrackedResult(key, reason, ctx) {
	return {
		...missingResult(key, reason, ctx),
		status: "not_tracked",
		display: "Not tracked",
		current: currentShell(ctx, "Not tracked"),
		totals: [
			{ label: "All time", from: SERIES_START_DAY, to: ctx.asOfDay, value: null, display: "Not tracked" },
			{ label: "Month to date", from: monthStart(ctx.asOfMonth), to: ctx.asOfDay, value: null, display: "Not tracked" },
		],
		series: emptySeries(ctx, "Not tracked"),
	};
}

// The common shape: a metric measured over day ranges.
//   spec.dataStart   first day of the metric's records ('YYYY-MM-DD') or null
//   spec.measure(from, to) -> { value, rows, n, covNum, covDen, emptyDisplay }
//        rows: source rows in the range (0 = "No records"); n: the sample size
//   spec.coverage    { num, den, what } over the metric's whole record
//   spec.seriesCoverage  report each month's covNum / covDen
//   spec.beforeAfter [{ event, date, notSetNote }], spec.sampleWord
//   spec.dataEnd     last day the source has reported (default asOfDay): the
//                    before/after windows end there, so neither counts days
//                    the source has not reported yet
//   spec.warnings, spec.assumptions, spec.breakdown, spec.noDataReason
function assemble(key, spec, ctx) {
	const def = catalog.metricByKey(key);
	const unit = def.unit;
	const { asOfDay, asOfMonth, currentMonth } = ctx;
	const dataStart = spec.dataStart && spec.dataStart <= asOfDay ? spec.dataStart : null;

	const cell = (from, to) => {
		if (!dataStart || to < dataStart) return { value: null, display: NO_DATA, coverage: null, present: false };
		const m = spec.measure(from < dataStart ? dataStart : from, to);
		const coverage = spec.seriesCoverage && m.covDen ? Math.round((m.covNum / m.covDen) * 10000) / 10000 : null;
		if (!m.rows) return { value: null, display: NO_RECORDS, coverage, present: false };
		if (!isNum(m.value)) return { value: null, display: m.emptyDisplay || NO_DATA, coverage, present: false };
		return { value: roundValue(unit, m.value), display: formatDisplay(unit, m.value), coverage, present: true };
	};
	const monthCell = (month) => cell(monthStart(month), monthEnd(month) < asOfDay ? monthEnd(month) : asOfDay);

	const series = monthSeries(catalog.KPI_SERIES_START, asOfMonth).map((period) => {
		const c = monthCell(period);
		return { period, value: c.value, display: c.display, coverage: c.coverage };
	});

	const cur = monthCell(currentMonth);
	const current = { from: monthStart(currentMonth), to: monthEnd(currentMonth), value: cur.value, display: cur.display, label: monthLabel(currentMonth) };

	const allFrom = dataStart && dataStart > SERIES_START_DAY ? dataStart : SERIES_START_DAY;
	const all = cell(allFrom, asOfDay);
	const mtd = cell(monthStart(asOfMonth), asOfDay);
	const totals = [
		{ label: "All time", from: allFrom, to: asOfDay, value: all.value, display: all.display },
		{ label: "Month to date", from: monthStart(asOfMonth), to: asOfDay, value: mtd.value, display: mtd.display },
	];

	// Each comparison needs every month on both sides present (a gap month or a
	// month before the records begin makes it 'missing').
	const windowValue = (fromMonth, toMonth) => {
		const months = monthSeries(fromMonth, toMonth);
		if (!months.every((m) => monthCell(m).present)) return null;
		return cell(monthStart(fromMonth), monthEnd(toMonth)).value;
	};
	const prev = addMonths(currentMonth, -1);
	const lastYear = addMonths(currentMonth, -12);
	const t3From = addMonths(currentMonth, -2);
	const comparisons = [
		compare({ kind: "mom", label: `vs ${monthLabel(prev)}`, basePeriod: prev, value: windowValue(currentMonth, currentMonth), baseValue: windowValue(prev, prev), unit }),
		compare({ kind: "yoy", label: `vs ${monthLabel(lastYear)}`, basePeriod: lastYear, value: windowValue(currentMonth, currentMonth), baseValue: windowValue(lastYear, lastYear), unit }),
		compare({
			kind: "t3m_yoy",
			label: `${rangeLabel(t3From, currentMonth)} vs ${rangeLabel(addMonths(t3From, -12), lastYear)}`,
			basePeriod: `${addMonths(t3From, -12)}..${lastYear}`,
			value: windowValue(t3From, currentMonth),
			baseValue: windowValue(addMonths(t3From, -12), lastYear),
			unit,
		}),
	];

	const measuredTo = spec.dataEnd && spec.dataEnd < asOfDay ? spec.dataEnd : asOfDay;
	const beforeAfter = arr(spec.beforeAfter).map((ev) => beforeAfterFor({
		event: ev.event, date: ev.date, dataStart, asOfDay: measuredTo, unit,
		measure: spec.measure, sampleWord: spec.sampleWord || "records", notSetNote: ev.notSetNote,
	}));

	const cv = spec.coverage || {};
	const coverage = coverageOf(cv.num, cv.den, cv.what || "", dataStart ? allFrom : null, dataStart ? asOfDay : null);
	let status = "ok";
	let missingReason = null;
	if (!dataStart) {
		status = "missing";
		missingReason = spec.noDataReason || "No records yet.";
	} else if (coverage.ratio != null && coverage.ratio < COVERAGE_OK) {
		status = "partial";
	}
	const warnings = arr(spec.warnings);
	return {
		key, status, missingReason,
		value: current.value, display: current.display,
		current, totals, series, comparisons, beforeAfter, coverage,
		confidence: confidenceFor(def.kind, status, coverage.ratio, warnings),
		warnings,
		assumptions: arr(spec.assumptions),
		breakdown: spec.breakdown || null,
	};
}

function row(label, unit, value) {
	return { label, value: isNum(value) ? roundValue(unit, value) : null, display: formatDisplay(unit, value) };
}
function countRow(label, value, noun) {
	return { label, value, display: `${fixed(value, 0)} ${value === 1 ? noun : `${noun}s`}` };
}

// ── weights ────────────────────────────────────────────────────────────────────
// A delivered load's stated weight: the load details first (what dispatch saw
// and kept), then the rate confirmation's (kpi_load_weights, status 'ok'); null
// when neither states one. A details text with a conflict falls through to the
// rate con, which is a separate document.
function statedWeight(detailsText, rateconRow) {
	const details = parseWeight(detailsText);
	const fromDetails = details.status === "ok" ? { lb: details.weightLb, source: "details" } : null;
	const fromRatecon = rateconRow && rateconRow.status === "ok" && isPlausibleLb(rateconRow.weightLb)
		? { lb: rateconRow.weightLb, source: "ratecon" }
		: null;
	return fromDetails || fromRatecon;
}

// ── the derived AI dispatch start ──────────────────────────────────────────────
// The first delivered email-path load (blank Contract ID) that opens a 14-day
// window holding at least 3 such loads. `days` are those loads' dated days.
function deriveAiDispatchStart(days) {
	const sorted = days.filter(Boolean).sort();
	for (let i = 0; i < sorted.length; i++) {
		const end = addDays(sorted[i], AI_START_WINDOW_DAYS - 1);
		let n = 0;
		for (let j = i; j < sorted.length && sorted[j] <= end; j++) n++;
		if (n >= AI_START_MIN_LOADS) {
			return {
				value: sorted[i],
				evidence: `First delivered load through the AI email path; ${n} such loads in the ${AI_START_WINDOW_DAYS} days from ${sorted[i]}.`,
			};
		}
	}
	return { value: null, evidence: `No ${AI_START_WINDOW_DAYS}-day window has ${AI_START_MIN_LOADS} delivered loads through the AI email path yet.` };
}

// ── computeKpis ────────────────────────────────────────────────────────────────
function computeKpis(inputs) {
	const input = inputs && typeof inputs === "object" ? inputs : {};
	const asOfDay = input.asOfDay;
	if (!isDay(asOfDay)) throw new TypeError("computeKpis: asOfDay must be a calendar date 'YYYY-MM-DD'");
	const asOfMonth = monthOf(asOfDay);
	const ctx = { asOfDay, asOfMonth, currentMonth: addMonths(asOfMonth, -1) };
	const settings = input.settings && typeof input.settings === "object" ? input.settings : {};
	const inWindow = (day) => isDay(day) && day >= SERIES_START_DAY && day <= asOfDay;

	// Loads. `live` drops cancelled rows again; a load's day outside April 2025
	// to asOfDay (or none) is "undated": counted, reported, kept out of the months.
	const rateconByLoad = new Map();
	for (const r of arr(input.ratecon)) if (r) rateconByLoad.set(loadKey(r.loadId), r);
	const live = arr(input.loads).filter((l) => l && !DROPPED_STATUS_RE.test(trimmed(l.status)));
	const loadRows = live.map((l) => {
		const delivered = isDeliveredStatus(l.status);
		return {
			day: inWindow(l.day) ? l.day : null,
			delivered,
			ai: l.contractIdBlank === true,
			driver: trimmed(l.driverKey).toLowerCase(),
			weight: delivered ? statedWeight(l.detailsText, rateconByLoad.get(loadKey(l.loadId))) : null,
		};
	});
	const datedLoads = loadRows.filter((r) => r.day);
	const deliveredDated = datedLoads.filter((r) => r.delivered);
	const undatedDelivered = live.filter((l) => isDeliveredStatus(l.status) && !inWindow(l.day));
	const loadsStart = minDay(datedLoads.map((r) => r.day));

	const derivedAi = deriveAiDispatchStart(deliveredDated.filter((r) => r.ai).map((r) => r.day));
	const aiDispatchDate = isDay(settings.aiDispatchStart) ? settings.aiDispatchStart : derivedAi.value;
	const dedicatedDate = isDay(settings.dedicatedStart) ? settings.dedicatedStart : null;

	// ELD miles per (truck, day), summed: two rows for one truck-day (two
	// providers, a re-run) are one truck-day.
	const eldRows = arr(input.eldDaily)
		.filter((r) => r && inWindow(r.day) && isNum(r.miles) && r.miles >= 0 && trimmed(r.truckId) !== "")
		.map((r) => ({ truckId: trimmed(r.truckId), day: r.day, miles: r.miles }));
	const truckDays = new Map();
	const milesByDay = new Map();
	for (const r of eldRows) {
		const k = `${r.truckId}\u0000${r.day}`;
		const td = truckDays.get(k);
		if (td) td.miles += r.miles; else truckDays.set(k, { truckId: r.truckId, day: r.day, miles: r.miles });
		milesByDay.set(r.day, (milesByDay.get(r.day) || 0) + r.miles);
	}
	const eldStart = minDay(milesByDay.keys());

	// Trucks by their service dates (start = in service, else created; stop =
	// retired, inclusive). Status is today's and is read only for today, through
	// truckInFleet(), the one fleet rule (every status but Inactive).
	const trucks = arr(input.trucks).filter(Boolean).map((t) => {
		const start = isDay(t.inServiceDay) ? t.inServiceDay : (isDay(t.createdDay) ? t.createdDay : "");
		const b = truckServiceBounds({ in_service_date: start, retired_at: isDay(t.retiredDay) ? t.retiredDay : "" }, "stop");
		return { id: trimmed(t.id), from: b.from, until: b.until, inactive: !truckInFleet(t), hasEld: t.hasEld === true };
	});

	// Fuel receipts that count: not Rejected (EXPENSE_PNL_FILTER's rule), dated.
	const receipts = arr(input.fuelReceipts)
		.filter((r) => r && String(r.status == null ? "" : r.status) !== "Rejected" && inWindow(r.day))
		.map((r) => ({ day: r.day, amount: isNum(r.amount) ? r.amount : 0, gallons: isNum(r.gallons) && r.gallons > 0 ? r.gallons : null }));

	const builders = {
		freight_tons_stated: () => freightStated(),
		freight_tons_estimated: () => freightEstimated(),
		loads_delivered: () => loadsDelivered(),
		revenue: () => revenue(),
		miles_driven: () => milesDriven(),
		on_time_rate: () => onTimeRate(),
		fleet_trucks: () => fleetTrucks(),
		active_units: () => activeUnits(),
		fuel_mpg: () => fuelMpg(),
		fuel_savings: () => fuelSavings(),
		co2_tonnes: () => co2Tonnes(),
		ai_tasks: () => taskCounts("ai_tasks", aiTaskFacts()),
		automated_tasks: () => taskCounts("automated_tasks", automatedTaskFacts()),
		dispatch_calls: () => notTrackedResult("dispatch_calls", "No call or voice system records dispatch calls.", ctx),
		truck_utilization: () => truckUtilization(),
		paid_mile_share: () => paidMileShare(),
	};

	const metrics = [];
	const errors = [];
	for (const key of catalog.METRIC_KEYS) {
		try {
			metrics.push(builders[key]());
		} catch (_e) {
			errors.push({ metric: key, code: "KPI_COMPUTE_FAILED" });
			metrics.push(missingResult(key, "This metric could not be computed on this run.", ctx));
		}
	}
	return { metrics, derived: { aiDispatchStart: derivedAi }, errors };

	// ── loads ──
	function loadsDelivered() {
		return assemble("loads_delivered", {
			dataStart: loadsStart,
			measure(from, to) {
				const rows = within(datedLoads, from, to);
				const n = rows.filter((r) => r.delivered).length;
				return { value: n, rows: rows.length, n };
			},
			coverage: { num: deliveredDated.length, den: deliveredDated.length + undatedDelivered.length, what: "delivered loads with a usable date" },
			breakdown: [
				countRow("Delivered loads with a usable date", deliveredDated.length, "load"),
				{ label: "Undated (left out of the months)", value: undatedDelivered.length, display: formatDisplay("count", undatedDelivered.length) },
			],
			sampleWord: "loads",
		}, ctx);
	}

	function weightTotals(rows) {
		const delivered = rows.filter((r) => r.delivered);
		const weighted = delivered.filter((r) => r.weight);
		return { delivered, weighted, lb: sum(weighted, (r) => r.weight.lb) };
	}

	function freightStated() {
		const all = weightTotals(datedLoads);
		const fromDetails = all.weighted.filter((r) => r.weight.source === "details").length;
		return assemble("freight_tons_stated", {
			dataStart: loadsStart,
			measure(from, to) {
				const rows = within(datedLoads, from, to);
				const w = weightTotals(rows);
				return {
					value: w.weighted.length ? lbToTons(w.lb) : (w.delivered.length ? null : 0),
					rows: rows.length, n: w.delivered.length, covNum: w.weighted.length, covDen: w.delivered.length,
					emptyDisplay: "No stated weights",
				};
			},
			seriesCoverage: true,
			coverage: { num: all.weighted.length, den: all.delivered.length, what: "delivered loads that state a weight" },
			breakdown: [
				countRow("Weight from the load details", fromDetails, "load"),
				countRow("Weight from the rate confirmation", all.weighted.length - fromDetails, "load"),
				countRow("No stated weight", all.delivered.length - all.weighted.length, "load"),
				{ label: "Stated weight in pounds", value: all.lb, display: `${fixed(all.lb, 0)} lb` },
			],
			sampleWord: "loads",
		}, ctx);
	}

	function freightEstimated() {
		const all = weightTotals(datedLoads);
		const coverage = coverageOf(all.weighted.length, all.delivered.length, "delivered loads that state a weight", null, null);
		if (all.weighted.length < ESTIMATE_MIN_WEIGHTED) {
			return missingResult("freight_tons_estimated",
				`Fewer than ${ESTIMATE_MIN_WEIGHTED} delivered loads state a weight (${all.weighted.length}), too few to estimate the rest.`,
				ctx, { coverage });
		}
		const avgLb = all.lb / all.weighted.length;
		return assemble("freight_tons_estimated", {
			dataStart: loadsStart,
			measure(from, to) {
				const rows = within(datedLoads, from, to);
				const w = weightTotals(rows);
				return {
					value: lbToTons(w.lb + (w.delivered.length - w.weighted.length) * avgLb),
					rows: rows.length, n: w.delivered.length, covNum: w.weighted.length, covDen: w.delivered.length,
				};
			},
			seriesCoverage: true,
			coverage: { num: all.weighted.length, den: all.delivered.length, what: "delivered loads that state a weight" },
			assumptions: [`Average stated weight: ${fixed(Math.round(avgLb), 0)} lb per load, from ${fixed(all.weighted.length, 0)} loads.`],
			breakdown: [
				row("Stated", "lb_tons", lbToTons(all.lb)),
				row("Estimated for loads with no stated weight", "lb_tons", lbToTons((all.delivered.length - all.weighted.length) * avgLb)),
			],
			sampleWord: "loads",
		}, ctx);
	}

	function activeUnits() {
		const drivers = new Set(deliveredDated.map((r) => r.driver).filter(Boolean));
		return assemble("active_units", {
			dataStart: loadsStart,
			measure(from, to) {
				const rows = within(datedLoads, from, to);
				const delivered = rows.filter((r) => r.delivered);
				const named = delivered.filter((r) => r.driver);
				return { value: new Set(named.map((r) => r.driver)).size, rows: rows.length, n: delivered.length, covNum: named.length, covDen: delivered.length };
			},
			coverage: { num: deliveredDated.filter((r) => r.driver).length, den: deliveredDated.length, what: "delivered loads that name a driver" },
			breakdown: [
				{ label: "Different drivers, all time", value: drivers.size, display: formatDisplay("units", drivers.size) },
			],
			sampleWord: "loads",
		}, ctx);
	}

	// ── revenue ──
	function revenue() {
		const byMonth = new Map();
		for (const r of arr(input.revenueByMonth)) {
			if (!r || !MONTH_RE.test(String(r.period)) || !isNum(r.value)) continue;
			if (r.period < catalog.KPI_SERIES_START || r.period > asOfMonth) continue;
			byMonth.set(r.period, (byMonth.get(r.period) || 0) + r.value);
		}
		const first = [...byMonth.keys()].sort()[0];
		const deliveredMonths = new Set(deliveredDated.map((r) => monthOf(r.day)));
		const covered = [...deliveredMonths].filter((m) => byMonth.has(m)).length;
		return assemble("revenue", {
			dataStart: first ? monthStart(first) : null,
			measure(from, to) {
				const months = monthSeries(monthOf(from), monthOf(to)).filter((m) => byMonth.has(m));
				return { value: sum(months, (m) => byMonth.get(m)), rows: months.length, n: months.length };
			},
			coverage: { num: covered, den: deliveredMonths.size, what: "months with delivered loads that have revenue recorded" },
			noDataReason: "No revenue recorded yet.",
			sampleWord: "months",
		}, ctx);
	}

	// ── ELD miles ──
	function milesDriven() {
		const days = [...milesByDay.keys()];
		return assemble("miles_driven", {
			dataStart: eldStart,
			measure(from, to) {
				let miles = 0;
				let rows = 0;
				for (const d of days) if (d >= from && d <= to) { miles += milesByDay.get(d); rows++; }
				return { value: miles, rows, n: rows };
			},
			coverage: { num: days.length, den: eldStart ? daysBetween(eldStart, asOfDay) + 1 : 0, what: "days with ELD mileage since ELD records began" },
			noDataReason: "No ELD mileage recorded yet.",
			sampleWord: "days",
		}, ctx);
	}

	// ── on time ──
	function onTimeRate() {
		const judged = arr(input.arrivals).filter(Boolean).map((a) => ({
			day: inWindow(a.deliveredDay) ? a.deliveredDay : null,
			v: judgeArrival({
				appointmentText: a.appointmentText, destLng: a.destLng, eldArriveMs: a.eldArriveMs,
				receiverEvents: a.receiverEvents, deliveredDay: a.deliveredDay,
			}),
		}));
		const dated = judged.filter((j) => j.day);
		const strict = (j) => j.v.status === "judged" && j.v.strictOnTime != null;
		const start = minDay(dated.filter(strict).map((j) => j.day));
		const scope = start ? dated.filter((j) => j.day >= start) : [];
		const judgedAll = scope.filter((j) => j.v.status === "judged");
		const strictAll = scope.filter(strict);
		const byStatus = (s) => scope.filter((j) => j.v.status === s).length;
		const byDayRate = judgedAll.length ? (judgedAll.filter((j) => j.v.dayOnTime).length / judgedAll.length) * 100 : null;
		return assemble("on_time_rate", {
			dataStart: start,
			measure(from, to) {
				const rows = within(dated, from, to);
				const s = rows.filter(strict);
				const on = s.filter((j) => j.v.strictOnTime).length;
				return {
					value: s.length ? (on / s.length) * 100 : null, rows: rows.length, n: s.length,
					covNum: s.length, covDen: rows.length, emptyDisplay: "No judged arrivals",
				};
			},
			seriesCoverage: true,
			coverage: { num: strictAll.length, den: scope.length, what: "delivered loads with a timed appointment and a recorded arrival" },
			warnings: [ON_TIME_WARNING],
			breakdown: [
				row("On time by day (arrived on or before the appointment day)", "pct", byDayRate),
				countRow("Verdicts that change if the appointment moves by 1 hour", strictAll.filter((j) => j.v.flipsWithin1h).length, "load"),
				countRow("Judged by day only (date-only or first-come appointment)", judgedAll.length - strictAll.length, "load"),
				countRow("Left out: no arrival recorded", byStatus("no_arrival"), "load"),
				countRow("Left out: no receiver location or written time zone", byStatus("no_zone"), "load"),
				countRow("Left out: appointment unreadable", byStatus("unparseable"), "load"),
				countRow("Left out: appointment more than 3 days from the arrival", byStatus("implausible"), "load"),
			],
			noDataReason: "No delivered load has both a timed appointment and a recorded arrival yet.",
			sampleWord: "loads",
		}, ctx);
	}

	// ── fleet ──
	function covers(t, day) {
		return (!t.from || day >= t.from) && (!t.until || day <= t.until);
	}
	function fleetCount(day, statusNow) {
		return trucks.filter((t) => covers(t, day) && (!statusNow || !t.inactive)).length;
	}
	function fleetTrucks() {
		const def = catalog.metricByKey("fleet_trucks");
		if (trucks.length === 0) return missingResult("fleet_trucks", "No trucks recorded yet.", ctx);
		const unbounded = trucks.some((t) => !t.from);
		const firstFrom = minDay(trucks.map((t) => t.from));
		const dataStart = unbounded || !firstFrom || firstFrom < SERIES_START_DAY ? SERIES_START_DAY : firstFrom;
		const snapshots = new Map();
		for (const h of arr(input.fleetHistory)) if (h && isDay(h.day) && isNum(h.value)) snapshots.set(h.day, h.value);
		// A past day's fleet: the snapshot taken that day when there is one, else
		// the trucks whose service dates cover it (today's status not applied).
		const fleetOnDay = (day) => {
			if (day < dataStart) return null;
			return snapshots.has(day) ? snapshots.get(day) : fleetCount(day, false);
		};
		const today = fleetCount(asOfDay, true);
		const pt = (value) => ({ value: value == null ? null : roundValue("trucks", value), display: value == null ? NO_DATA : formatDisplay("trucks", value) });
		const series = monthSeries(catalog.KPI_SERIES_START, asOfMonth).map((period) => {
			const v = period === asOfMonth ? today : (monthEnd(period) < dataStart ? null : fleetOnDay(monthEnd(period)));
			return { period, ...pt(v), coverage: null };
		});
		const everIn = (from, to) => trucks.filter((t) => (!t.from || t.from <= to) && (!t.until || t.until >= from)).length;
		const allFrom = dataStart;
		const current = { from: asOfDay, to: asOfDay, ...pt(today), label: dayLabel(asOfDay) };
		const lastMonthEnd = monthEnd(ctx.currentMonth);
		const yearBefore = dayYearBefore(asOfDay);
		const comparisons = [
			compare({ kind: "mom", label: `vs end of ${monthLabel(ctx.currentMonth)}`, basePeriod: ctx.currentMonth, value: today, baseValue: fleetOnDay(lastMonthEnd), unit: "trucks" }),
			compare({ kind: "yoy", label: `vs ${dayLabel(yearBefore)}`, basePeriod: monthOf(yearBefore), value: today, baseValue: fleetOnDay(yearBefore), unit: "trucks" }),
		];
		const coverage = coverageOf(trucks.filter((t) => t.from).length, trucks.length, "trucks with a service start date", allFrom, asOfDay);
		const status = coverage.ratio != null && coverage.ratio < COVERAGE_OK ? "partial" : "ok";
		return {
			key: "fleet_trucks", status, missingReason: null,
			value: current.value, display: current.display,
			current,
			totals: [
				{ label: "All time", from: allFrom, to: asOfDay, ...pt(everIn(allFrom, asOfDay)) },
				{ label: "Month to date", from: monthStart(asOfMonth), to: asOfDay, ...pt(everIn(monthStart(asOfMonth), asOfDay)) },
			],
			series, comparisons, beforeAfter: [], coverage,
			confidence: confidenceFor(def.kind, status, coverage.ratio, []),
			warnings: [],
			assumptions: ["All time counts every truck that was in the fleet on any day; month to date, every truck in the fleet on any day this month."],
			breakdown: [
				countRow("In the fleet today", today, "truck"),
				countRow("Marked Inactive", trucks.filter((t) => t.inactive).length, "truck"),
				countRow("With an ELD", trucks.filter((t) => t.hasEld).length, "truck"),
			],
		};
	}

	// ── fuel ──
	// Miles, gallons and spend over a range, counting only the months in it that
	// have both ELD miles and receipt gallons, from the first ELD day on.
	function fuelWindow(from, to) {
		const months = new Map();
		const m = (key) => {
			let x = months.get(key);
			if (!x) months.set(key, (x = { miles: 0, gal: 0, spendGal: 0, spendAll: 0, receipts: 0, withGal: 0 }));
			return x;
		};
		let rows = 0;
		let covNum = 0;
		if (eldStart) {
			for (const r of receipts) {
				if (r.day < eldStart || r.day < from || r.day > to) continue;
				const x = m(monthOf(r.day));
				rows++;
				x.receipts++;
				x.spendAll += r.amount;
				if (r.gallons != null) {
					covNum++;
					x.withGal++;
					x.gal += r.gallons;
					x.spendGal += r.amount;
				}
			}
			for (const [d, miles] of milesByDay) if (d >= from && d <= to) m(monthOf(d)).miles += miles;
		}
		const t = { miles: 0, gal: 0, spendGal: 0, spendAll: 0, n: 0, rows, covNum, covDen: rows };
		for (const x of months.values()) {
			if (!(x.miles > 0 && x.gal > 0)) continue;
			t.miles += x.miles;
			t.gal += x.gal;
			t.spendGal += x.spendGal;
			t.spendAll += x.spendAll;
			t.n += x.withGal;
		}
		return t;
	}
	function fuelStart() {
		if (!eldStart) return null;
		for (const month of monthSeries(monthOf(eldStart), asOfMonth)) {
			const from = monthStart(month) < eldStart ? eldStart : monthStart(month);
			if (fuelWindow(from, monthEnd(month)).gal > 0) return from;
		}
		return null;
	}
	function fuelCoverage() {
		const all = eldStart ? receipts.filter((r) => r.day >= eldStart) : [];
		return { num: all.filter((r) => r.gallons != null).length, den: all.length, what: "fuel receipts since ELD records began that show gallons" };
	}

	function fuelMpg() {
		const all = fuelWindow(SERIES_START_DAY, asOfDay);
		return assemble("fuel_mpg", {
			dataStart: fuelStart(),
			measure(from, to) {
				const w = fuelWindow(from, to);
				return { value: w.gal > 0 ? w.miles / w.gal : null, rows: w.rows, n: w.n, covNum: w.covNum, covDen: w.covDen, emptyDisplay: "No miles and gallons together" };
			},
			seriesCoverage: true,
			coverage: fuelCoverage(),
			breakdown: [row("ELD miles", "miles", all.miles), row("Receipt gallons", "gallons", all.gal)],
			noDataReason: "No month has both ELD miles and fuel receipt gallons yet.",
			sampleWord: "receipts",
		}, ctx);
	}

	function fuelSavings() {
		const baseline = Number(settings.baselineMpg);
		const hasBaseline = settings.baselineMpg != null && Number.isFinite(baseline) && baseline > 0;
		const fc = fuelCoverage();
		if (!hasBaseline) return missingResult("fuel_savings", "No baseline MPG set", ctx, { coverage: coverageOf(fc.num, fc.den, fc.what, null, null) });
		const savingsOf = (fw) => {
			if (!(fw.gal > 0)) return null;
			const pricePerGallon = fw.spendGal / fw.gal;
			return (fw.miles / baseline - fw.gal) * pricePerGallon;
		};
		const all = fuelWindow(SERIES_START_DAY, asOfDay);
		return assemble("fuel_savings", {
			dataStart: fuelStart(),
			measure(from, to) {
				const w = fuelWindow(from, to);
				return { value: savingsOf(w), rows: w.rows, n: w.n, covNum: w.covNum, covDen: w.covDen, emptyDisplay: "No miles and gallons together" };
			},
			seriesCoverage: true,
			coverage: fc,
			assumptions: [`Baseline: ${fixed(baseline, 1)} mpg.`],
			breakdown: [
				row("ELD miles", "miles", all.miles),
				row("Receipt gallons", "gallons", all.gal),
				row("Gallons at the baseline MPG", "gallons", all.miles / baseline),
				{ label: "Average price paid per gallon", value: all.gal > 0 ? Math.round((all.spendGal / all.gal) * 1000) / 1000 : null, display: all.gal > 0 ? `$${fixed(all.spendGal / all.gal, 3)}` : NO_DATA },
			],
			noDataReason: "No month has both ELD miles and fuel receipt gallons yet.",
			sampleWord: "receipts",
		}, ctx);
	}

	function co2Tonnes() {
		const kgPerGallon = catalog.CO2_KG_PER_GALLON_DIESEL;
		const allGal = sum(receipts, (r) => r.gallons || 0);
		return assemble("co2_tonnes", {
			dataStart: minDay(receipts.map((r) => r.day)),
			measure(from, to) {
				const rows = within(receipts, from, to);
				const withGal = rows.filter((r) => r.gallons != null);
				const gal = sum(withGal, (r) => r.gallons);
				return {
					value: withGal.length ? (gal * kgPerGallon) / 1000 : null, rows: rows.length, n: withGal.length,
					covNum: withGal.length, covDen: rows.length, emptyDisplay: "No gallons recorded",
				};
			},
			seriesCoverage: true,
			coverage: { num: receipts.filter((r) => r.gallons != null).length, den: receipts.length, what: "fuel receipts that show gallons" },
			breakdown: [row("Receipt gallons", "gallons", allGal)],
			noDataReason: "No fuel receipts recorded yet.",
			sampleWord: "receipts",
		}, ctx);
	}

	// ── tasks ──
	function aiTaskFacts() {
		return [
			...live.filter((l) => l.contractIdBlank === true).map((l) => ({ day: inWindow(l.day) ? l.day : null, kind: "Rate confirmations read from email" })),
			...arr(input.activity && input.activity.aiReceipts).map((d) => ({ day: inWindow(d) ? d : null, kind: "Receipts read by AI" })),
			...arr(input.activity && input.activity.aiExpenseInsights).map((d) => ({ day: inWindow(d) ? d : null, kind: "Expense insights and questions" })),
		];
	}
	function automatedTaskFacts() {
		return [
			...arr(input.activity && input.activity.geofenceStatuses).map((d) => ({ day: inWindow(d) ? d : null, kind: "Load statuses set by the geofence" })),
			...arr(input.activity && input.activity.invoiceAutogenRuns).map((d) => ({ day: inWindow(d) ? d : null, kind: "Automatic invoice runs" })),
		];
	}
	function taskCounts(key, facts) {
		const dated = facts.filter((f) => f.day);
		const kinds = [...new Set(facts.map((f) => f.kind))];
		return assemble(key, {
			dataStart: minDay(dated.map((f) => f.day)),
			measure(from, to) {
				const n = countWithin(dated.map((f) => f.day), from, to);
				return { value: n, rows: n, n };
			},
			coverage: { num: dated.length, den: facts.length, what: "tasks with a usable date" },
			breakdown: kinds.map((k) => ({ label: k, value: dated.filter((f) => f.kind === k).length, display: formatDisplay("count", dated.filter((f) => f.kind === k).length) })),
			noDataReason: "No tasks recorded yet.",
			sampleWord: "tasks",
		}, ctx);
	}

	// ── utilization ──
	function truckUtilization() {
		const firstEld = new Map();
		for (const r of eldRows) if (!firstEld.has(r.truckId) || r.day < firstEld.get(r.truckId)) firstEld.set(r.truckId, r.day);
		// Each ELD truck's days in the fleet: from its first ELD day, within its
		// service dates, through the latest day the ELD feed has reported for any
		// truck. A day the feed has not reported yet (the run's own day, at 04:00)
		// is not an idle day.
		const lastEld = eldRows.reduce((m, r) => (r.day > m ? r.day : m), "");
		const windows = new Map();
		for (const t of trucks) {
			if (!t.hasEld || !t.id || !firstEld.has(t.id)) continue;
			const start = t.from && t.from > firstEld.get(t.id) ? t.from : firstEld.get(t.id);
			const end = t.until && t.until < lastEld ? t.until : lastEld;
			if (start <= end) windows.set(t.id, { start, end });
		}
		const fleetDays = [];
		for (const w of windows.values()) for (let d = w.start; d <= w.end; d = addDays(d, 1)) fleetDays.push(d);
		const activeDays = [];
		for (const td of truckDays.values()) {
			const w = windows.get(td.truckId);
			if (w && td.day >= w.start && td.day <= w.end && td.miles > ACTIVE_DAY_MILES) activeDays.push(td.day);
		}
		const start = minDay([...windows.values()].map((w) => w.start));
		const eraTrucks = start ? trucks.filter((t) => (!t.from || t.from <= asOfDay) && (!t.until || t.until >= start)).length : 0;
		return assemble("truck_utilization", {
			dataStart: start,
			dataEnd: lastEld || null,
			measure(from, to) {
				const total = countWithin(fleetDays, from, to);
				const active = countWithin(activeDays, from, to);
				return { value: total ? (active / total) * 100 : null, rows: total, n: total };
			},
			coverage: { num: windows.size, den: eraTrucks, what: "trucks in the fleet since ELD records began that have ELD mileage" },
			beforeAfter: [
				{ event: "ai_dispatch", date: aiDispatchDate, notSetNote: "No AI dispatch start was found in the data; set one on this page." },
				{ event: "dedicated", date: dedicatedDate, notSetNote: "Set the dedicated contracts start date on this page." },
			],
			breakdown: [
				countRow("Truck-days in the fleet", fleetDays.length, "truck-day"),
				countRow("Active truck-days (more than 1 ELD mile)", activeDays.length, "truck-day"),
			],
			noDataReason: "No truck with an ELD has mileage yet.",
			sampleWord: "truck-days",
		}, ctx);
	}

	// ── paid miles ──
	function paidMileShare() {
		const measured = (v) => isNum(v) && v >= 0;
		const rows = arr(input.loadMiles).filter((r) => r && inWindow(r.day));
		const eligible = [];
		for (const r of rows) {
			if (r.loadedBasis !== "eld" || r.deadheadBasis !== "eld" || r.inProgress || r.overlap) continue;
			const loaded = r.loadedMiles;
			const empty = r.deadheadMiles;
			if (!measured(loaded) || !measured(empty)) continue;
			eligible.push({ day: r.day, loaded: +loaded, empty: +empty });
		}
		const start = minDay(eligible.map((e) => e.day));
		const scope = start ? rows.filter((r) => r.day >= start && !r.inProgress) : [];
		return assemble("paid_mile_share", {
			dataStart: start,
			measure(from, to) {
				const e = within(eligible, from, to);
				const loaded = sum(e, (x) => x.loaded);
				const total = loaded + sum(e, (x) => x.empty);
				return {
					value: total > 0 ? (loaded / total) * 100 : null, rows: within(rows, from, to).length, n: e.length,
					covNum: e.length, covDen: within(scope, from, to).length, emptyDisplay: "No fully measured loads",
				};
			},
			seriesCoverage: true,
			coverage: { num: eligible.length, den: scope.length, what: "finished loads whose loaded and empty legs the ELD measured in full" },
			beforeAfter: [
				{ event: "dedicated", date: dedicatedDate, notSetNote: "Set the dedicated contracts start date on this page." },
			],
			noDataReason: "No load has both legs measured by the ELD yet.",
			sampleWord: "loads",
		}, ctx);
	}
}

// ── buildKpiResponse ───────────────────────────────────────────────────────────
const DEFAULT_JOB = Object.freeze({
	enabled: { snapshot: false, digest: false },
	snapshotSchedule: "Daily at 4:00 AM Eastern (3:00 AM Central)",
	digestSchedule: "Mondays at 9:00 AM Eastern (8:00 AM Central)",
	lastRun: null,
	nextSnapshotAt: null,
	nextDigestAt: null,
	preview: { status: "pending", at: null },
	lastDigest: null,
});
function parsePayload(text) {
	if (text && typeof text === "object") return text;
	try {
		const p = JSON.parse(String(text == null ? "" : text));
		return p && typeof p === "object" && !Array.isArray(p) ? p : {};
	} catch (_e) {
		return {};
	}
}
// A SQLite stamp ("YYYY-MM-DD HH:MM:SS", UTC) as ISO; ISO stays as it is.
function isoStamp(v) {
	if (v == null || v === "") return null;
	const s = String(v);
	return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
}

// The GET /api/admin/kpis response from stored rows. `settings` is the saved
// kpi.settings object ({ aiDispatchStart, dedicatedStart, baselineMpg,
// recipients }, null = not set); `derived` is computeKpis()'s `derived` from the
// last run. `defaultRecipientConfigured` (whether the admin notify address is
// set) may come on settings or as its own field. `generatedAt` defaults to now.
function buildKpiResponse(args) {
	const a = args && typeof args === "object" ? args : {};
	const asOfDay = isDay(a.asOfDay) ? a.asOfDay : null;
	const settings = a.settings && typeof a.settings === "object" ? a.settings : {};
	const derivedAi = a.derived && a.derived.aiDispatchStart ? a.derived.aiDispatchStart : { value: null, evidence: "Not derived yet: no snapshot has run." };
	const adminAi = isDay(settings.aiDispatchStart) ? settings.aiDispatchStart : null;
	const ctxMonth = asOfDay ? addMonths(monthOf(asOfDay), -1) : null;

	const snapshotByKey = new Map();
	for (const r of arr(a.snapshots)) if (r && r.metric_key) snapshotByKey.set(String(r.metric_key), r);
	const seriesByKey = new Map();
	for (const r of arr(a.series)) {
		if (!r || !r.metric_key) continue;
		const k = String(r.metric_key);
		if (!seriesByKey.has(k)) seriesByKey.set(k, []);
		seriesByKey.get(k).push(r);
	}
	const approvalByKey = new Map();
	for (const r of arr(a.approvals)) if (r && r.metric_key) approvalByKey.set(String(r.metric_key), r);

	const metrics = catalog.METRICS.map((def) => {
		const snap = snapshotByKey.get(def.key);
		// Only the payload's named fields are read (current, totals, comparisons,
		// beforeAfter, coverage, warnings, assumptions, breakdown, missingReason);
		// anything else a row holds never reaches the response.
		const payload = snap ? parsePayload(snap.payload) : {};
		const approvalRow = approvalByKey.get(def.key) || null;
		const valid = catalog.approvalIsValid(approvalRow, def.key, settings);
		const stale = !!approvalRow && (approvalRow.definition_version !== def.definitionVersion
			|| approvalRow.settings_hash !== catalog.settingsHashFor(def.key, settings));
		const approvedRow = approvalRow && approvalRow.approved === 1;
		const approval = {
			approved: valid,
			by: approvedRow && approvalRow.approved_by != null ? String(approvalRow.approved_by) : null,
			at: approvedRow ? isoStamp(approvalRow.approved_at) : null,
			stale,
		};
		const series = (seriesByKey.get(def.key) || [])
			.filter((r) => MONTH_RE.test(String(r.period)))
			.sort((x, y) => (x.period < y.period ? -1 : x.period > y.period ? 1 : 0))
			.map((r) => ({
				period: r.period,
				value: isNum(r.value) ? r.value : null,
				display: r.display == null ? NO_DATA : String(r.display),
				coverage: isNum(r.coverage) ? r.coverage : null,
			}));
		const base = {
			key: def.key, label: def.label, unit: def.unit, kind: def.kind, group: def.group,
			definition: def.definition, definitionVersion: def.definitionVersion, source: def.source,
			approval,
		};
		if (!snap) {
			return {
				...base,
				status: "missing", missingReason: "No snapshot yet",
				assumptions: def.assumptions.slice(), warnings: [],
				value: null, display: "No snapshot yet",
				current: ctxMonth
					? { from: monthStart(ctxMonth), to: monthEnd(ctxMonth), value: null, display: "No snapshot yet", label: monthLabel(ctxMonth) }
					: { from: null, to: null, value: null, display: "No snapshot yet", label: "" },
				totals: [], series, comparisons: [], beforeAfter: [],
				coverage: coverageOf(0, 0, "", null, null),
				confidence: "none", breakdown: null, computedDay: null,
			};
		}
		const warnings = arr(payload.warnings).map(String);
		if (snap.definition_version !== def.definitionVersion) {
			warnings.push("Computed under an earlier definition of this metric; the next snapshot uses the current one.");
		}
		return {
			...base,
			status: String(snap.status || "missing"),
			missingReason: payload.missingReason == null ? null : String(payload.missingReason),
			assumptions: [...def.assumptions, ...arr(payload.assumptions).map(String)],
			warnings,
			value: isNum(snap.value) ? snap.value : null,
			display: snap.display == null ? NO_DATA : String(snap.display),
			current: payload.current || null,
			totals: arr(payload.totals),
			series,
			comparisons: arr(payload.comparisons),
			beforeAfter: arr(payload.beforeAfter),
			coverage: payload.coverage || coverageOf(0, 0, "", null, null),
			confidence: String(snap.confidence || "none"),
			breakdown: Array.isArray(payload.breakdown) ? payload.breakdown : null,
			computedDay: isDay(snap.day) ? snap.day : null,
		};
	});

	const job = a.job && typeof a.job === "object" ? a.job : {};
	return {
		asOfDay,
		timeZone: a.timeZone == null ? null : String(a.timeZone),
		generatedAt: a.generatedAt ? String(a.generatedAt) : new Date().toISOString(),
		job: { ...DEFAULT_JOB, ...job },
		settings: {
			aiDispatchStart: adminAi
				? { value: adminAi, source: "admin", evidence: "Set by an admin on this page." }
				: { value: derivedAi.value || null, source: "derived", evidence: String(derivedAi.evidence || "") },
			dedicatedStart: isDay(settings.dedicatedStart) ? { value: settings.dedicatedStart, source: "admin" } : { value: null, source: null },
			baselineMpg: isNum(settings.baselineMpg) ? settings.baselineMpg : null,
			recipients: arr(settings.recipients).map(String),
			defaultRecipientConfigured: !!(a.defaultRecipientConfigured != null ? a.defaultRecipientConfigured : settings.defaultRecipientConfigured),
		},
		metrics,
	};
}

module.exports = {
	DELIVERED_STATUS_RE,
	MIN_SIDE_N,
	ON_TIME_WARNING,
	isDeliveredStatus,
	monthSeries,
	monthLabel,
	addMonths,
	addDays,
	formatDisplay,
	compare,
	beforeAfter: beforeAfterFor,
	confidenceFor,
	statedWeight,
	deriveAiDispatchStart,
	computeKpis,
	buildKpiResponse,
};
