"use strict";
// The Financials range quick picks on the server: which dates "Today", "Last
// week", "Last month" ... cover on the business day (APP_TIMEZONE), so a CSV
// link or a later server route resolves a preset to the same dates the page shows.
//
// The client keeps its own copy (client/src/lib/financialsView.js RANGE_PRESETS,
// presetRange()); scripts/test-financials-view.mjs pins the two equal, keys,
// labels and dates, for every day of 2024-2027. Change both together.
//
// No money is computed here. Pure apart from appDay() reading APP_TIMEZONE.

const { appDay } = require("./app-time");
const { weekStart } = require("./financials-report");

// In the order the page shows them. "ytd" keeps its key so saved links still open.
const RANGE_PRESETS = Object.freeze([
	{ key: "today", label: "Today" },
	{ key: "lastWeek", label: "Last week" },
	{ key: "thisMonth", label: "This month" },
	{ key: "lastMonth", label: "Last month" },
	{ key: "thisQuarter", label: "This quarter" },
	{ key: "lastQuarter", label: "Last quarter" },
	{ key: "ytd", label: "This year" },
	{ key: "lastYear", label: "Last year" },
	{ key: "last12", label: "Last 12 months" },
	{ key: "custom", label: "Custom" },
]);
const PRESET_KEYS = Object.freeze(RANGE_PRESETS.map((p) => p.key));

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const pad2 = (n) => String(n).padStart(2, "0");
// Calendar arithmetic on noon UTC, so no clock zone can shift a day.
const dayMs = (d) => Date.parse(`${d}T12:00:00Z`);
const addDays = (d, n) => new Date(dayMs(d) + n * 86400000).toISOString().slice(0, 10);

function isCalendarDay(v) {
	if (typeof v !== "string" || !DAY_RE.test(v)) return false;
	const y = Number(v.slice(0, 4));
	if (y < MIN_YEAR || y > MAX_YEAR) return false;
	const ms = dayMs(v);
	return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
}

const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// Month arithmetic on (year, month) pairs; month is 1-12.
function shiftMonth(y, m, delta) {
	const idx = y * 12 + (m - 1) + delta;
	return [Math.floor(idx / 12), (idx % 12) + 1];
}
const firstOf = (y, m) => `${y}-${pad2(m)}-01`;
const lastOf = (y, m) => `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}`;

/**
 * The dates a quick pick covers on `today` ('YYYY-MM-DD', the business day),
 * ending today where the period is still running. "Last week" is the last
 * complete house week (Saturday to Friday). Null for 'custom' or an unknown key.
 */
function presetRange(preset, today) {
	if (!isCalendarDay(today)) return null;
	const y = Number(today.slice(0, 4));
	const m = Number(today.slice(5, 7));
	const q0 = Math.floor((m - 1) / 3) * 3 + 1; // first month of this quarter
	switch (preset) {
		case "today":
			return { from: today, to: today };
		case "lastWeek": {
			const start = addDays(weekStart(today), -7);
			return { from: start, to: addDays(start, 6) };
		}
		case "thisMonth":
			return { from: firstOf(y, m), to: today };
		case "lastMonth": {
			const [py, pm] = shiftMonth(y, m, -1);
			return { from: firstOf(py, pm), to: lastOf(py, pm) };
		}
		case "thisQuarter":
			return { from: firstOf(y, q0), to: today };
		case "lastQuarter": {
			const [sy, sm] = shiftMonth(y, q0, -3);
			const [ey, em] = shiftMonth(y, q0, -1);
			return { from: firstOf(sy, sm), to: lastOf(ey, em) };
		}
		case "ytd":
			return { from: `${y}-01-01`, to: today };
		case "lastYear":
			return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
		case "last12": {
			const [sy, sm] = shiftMonth(y, m, -11);
			return { from: firstOf(sy, sm), to: today };
		}
		default:
			return null;
	}
}

/** A preset's dates on the business day an instant falls on (now by default). */
function presetRangeAt(preset, instant = new Date()) {
	return presetRange(preset, appDay(instant));
}

function presetLabel(preset) {
	const p = RANGE_PRESETS.find((x) => x.key === preset);
	return p ? p.label : "";
}

module.exports = {
	RANGE_PRESETS,
	PRESET_KEYS,
	presetRange,
	presetRangeAt,
	presetLabel,
};
