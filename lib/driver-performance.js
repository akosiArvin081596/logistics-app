"use strict";

// Driver Performance rules: periods, load credits, a driver's own week and its
// pacing on loads, the Run Efficiency Index, unit labels, and the ranking the
// Super Admin's board shows.
// Pure apart from lib/app-time.js's one read of APP_TIMEZONE: no network,
// database or file access. lib/driver-performance-routes.js gathers the facts
// and serves these answers; every figure is computed here, on the server.

const appTime = require("./app-time");

// ── D's open answers, each at the plan's default. A changed answer changes
// only its own line here.
// Q-A1: what a load earns toward the week (a delivery, and its pickup).
const CREDIT_WEIGHTS = Object.freeze({ delivery: 1.0, pickup: 0.5 });
// Q-A2: who is on the board: "company-day-rate" or "all-drivers".
const WHO_IS_IN = "company-day-rate";
// Q-A3: what a driver sees: "full" (every unit) or "top3-you" (the top 3 and his own row).
const BOARD_VIEW = "full";

// D's weekly targets and daily guides.
const CREDIT_TARGET = 7.5;
const HOURS_TARGET = 42.5;
const DAILY_CREDITS_GUIDE = 1.5;
const DAILY_HOURS_GUIDE = 8.5;
const TARGET_DAYS = 5;
// The federal 11-hour driving limit: one truck-local day never credits more.
const DAILY_HOURS_CAP = 11;
// "Ahead of Pace" and "Needs Focus" sit this many points from the expected figure.
const PACE_BAND = 10;
// Pacing on loads alone, the one reading of a rule the owner's spec names but doesn't give. A week
// has more days than its target asks for, so what he should have by this morning is what still
// finishes the target at creditsPerDay: a rest weekend never reads behind. A day off lowers the target.
const LOADS_PACE = Object.freeze({ creditsPerDay: DAILY_CREDITS_GUIDE, aheadBy: DAILY_CREDITS_GUIDE, targetFloor: 4.5, hideLabelAtDaysOff: 3 });
const LOADS_PACE_WORDS = Object.freeze(["ahead", "on-track", "needs-focus"]);
// A truck whose ELD sent nothing for this long counts as having no ELD, so a
// device dead for weeks doesn't cost its driver every pickup credit.
const ELD_REPORTING_LOOKBACK_DAYS = 14;

// The board's categories. Only "most-loads" is live in Phase A; the others
// answer "coming-soon" with no rows. Safety shows the rank only, never a figure.
const CATEGORIES = Object.freeze([
	Object.freeze({ id: "most-loads", live: true, better: "higher", display: (v) => `${v} load${v === 1 ? "" : "s"}` }),
	Object.freeze({ id: "least-fuel-cost", live: false, better: "lower", display: (v) => `$${v.toFixed(2)}/mi` }),
	Object.freeze({ id: "safety", live: false, better: "lower", display: null }),
	Object.freeze({ id: "lowest-idle", live: false, better: "lower", display: (v) => `${Math.round(v)}% idle` }),
]);
const NOT_RANKED = "Not ranked";
// The only keys a board row carries (plan §2.3 rule 7).
const ROW_KEYS = Object.freeze(["rank", "unitLabel", "value", "display", "isYou"]);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EPS = 1e-9;

// ── Days and periods ────────────────────────────────────────────────────────

// Calendar arithmetic on a bare "YYYY-MM-DD": no zone is involved.
function addDays(day, n) {
	const [y, m, d] = String(day).split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function lastDayOfMonth(day) {
	const [y, m] = String(day).split("-").map(Number);
	return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
	const out = [];
	if (!DAY_RE.test(String(from)) || !DAY_RE.test(String(to))) return out;
	for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
	return out;
}

// The business day (APP_TIMEZONE, US Eastern) of an instant: every event is
// placed by its Eastern instant, whatever zone the truck was in.
function businessDayOf(ms) {
	const n = Number(ms);
	if (!Number.isFinite(n) || n <= 0) return "";
	return appTime.appDay(new Date(n));
}

// The boards a period kind shows. "week" is this week and last week, so a
// Saturday never opens on an empty board; "month" is the calendar month.
// weekRangeOf is server.js's getWeekRange() (Sat-Fri on the business calendar).
// lastDay stops a current period at today, so no future day counts.
function boardPeriods(kind, today, weekRangeOf) {
	if (!DAY_RE.test(String(today))) return null;
	if (kind === "week") {
		const cur = weekRangeOf(today);
		const prev = weekRangeOf(addDays(cur.weekStart, -1));
		return [
			{ id: "this-week", start: cur.weekStart, end: cur.weekEnd, lastDay: today < cur.weekEnd ? today : cur.weekEnd },
			{ id: "last-week", start: prev.weekStart, end: prev.weekEnd, lastDay: prev.weekEnd },
		];
	}
	if (kind === "month") {
		return [{ id: "this-month", start: `${today.slice(0, 7)}-01`, end: lastDayOfMonth(today), lastDay: today }];
	}
	return null;
}

// ── Who is on the board ─────────────────────────────────────────────────────

// Why a driver is off the board, or null when he is on it (Q-A2).
function boardExclusion({ status, payType, ownerOperator }, rule = WHO_IS_IN) {
	if (String(status || "").trim().toLowerCase() !== "active") return "inactive";
	if (rule === "company-day-rate") {
		if (String(payType || "").trim().toLowerCase() === "percentage") return "percentage-driver";
		if (ownerOperator) return "owner-operator";
	}
	return null;
}

// Why a driver has no week of his own, or null when he may have one. Wider than
// the board's rule: a personal count touches no pay, so any pay type is in.
function personalExclusion({ status, ownerOperator }) {
	if (String(status || "").trim().toLowerCase() !== "active") return "inactive";
	if (ownerOperator) return "owner-operator";
	return null;
}

// Test units (e.g. "LogisX-TEST") are never on the board.
function isTestUnit(unit) {
	return /(^|[^a-z0-9])test([^a-z0-9]|$)/i.test(String(unit || ""));
}

// ── Load credits ────────────────────────────────────────────────────────────

// When a load was picked up, and how we know, or null when it earns no pickup
// credit. A truck with an ELD earns it only from its own record (the geofence
// departure, else the ELD replay); a tap counts only on a truck without one,
// so tapping "In Transit" early banks nothing.
function pickupEvidence({ geofenceMs, eldDepartMs, tapMs, tapSource, truckHasEld }) {
	if (Number(geofenceMs) > 0) return { ms: Number(geofenceMs), source: "geofence" };
	if (Number(eldDepartMs) > 0) return { ms: Number(eldDepartMs), source: "eld" };
	if (Number(tapMs) > 0 && !truckHasEld) return { ms: Number(tapMs), source: tapSource === "dispatch" ? "dispatch" : "driver" };
	return null;
}

// Did the truck's ELD report within the lookback ending on `day`?
// reportedDays: Set of "YYYY-MM-DD" days the truck's ELD sent data.
function eldReportingOn(reportedDays, day) {
	if (!reportedDays || !DAY_RE.test(String(day))) return false;
	for (let i = 0; i < ELD_REPORTING_LOOKBACK_DAYS; i++) {
		if (reportedDays.has(addDays(day, -i))) return true;
	}
	return false;
}

function loadCredits(deliveries, pickups, weights = CREDIT_WEIGHTS) {
	return (Number(deliveries) || 0) * weights.delivery + (Number(pickups) || 0) * weights.pickup;
}

// ── Hours, the REI and pacing (not shown to drivers in Phase A) ─────────────

// A week's credited drive hours: each day capped at the 11-hour limit; days
// without data add nothing, and a week with no day of data is null, never 0.
function creditedHours(dailyHours) {
	let sum = 0;
	let any = false;
	for (const h of dailyHours || []) {
		if (h === null || h === undefined || h === "" || !Number.isFinite(Number(h))) continue;
		any = true;
		sum += Math.min(Math.max(Number(h), 0), DAILY_HOURS_CAP);
	}
	return any ? sum : null;
}

// 0-100 from unrounded values; each half is capped, so extra loads never make
// up for hours or the other way round. null without hours data.
function rei(credits, hours, targets = {}) {
	if (hours === null || hours === undefined || !Number.isFinite(Number(hours))) return null;
	const ct = targets.credits || CREDIT_TARGET;
	const ht = targets.hours || HOURS_TARGET;
	return 50 * Math.min(Math.max(Number(credits) || 0, 0) / ct, 1) + 50 * Math.min(Math.max(Number(hours), 0) / ht, 1);
}

// A week is met on the unrounded values, both targets reached.
function weekMet(credits, hours, targets = {}) {
	if (hours === null || hours === undefined || !Number.isFinite(Number(hours))) return false;
	return Number(credits) >= (targets.credits || CREDIT_TARGET) && Number(hours) >= (targets.hours || HOURS_TARGET);
}

// Rounded DOWN to one decimal, and never 100.0 unless the week is met
// (42.47 h reads 99.9%, not 100%).
function reiDisplay(value, met) {
	if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
	const down = Math.floor(Math.round(Number(value) * 1e6) / 1e5) / 10;
	return !met && down >= 100 ? 99.9 : down;
}

// Mid-week pacing (plan §3.4), or null without hours data.
//   completedWorkedDays  past days of the week with ELD movement or a load event
//   todayHours           today's driving so far
//   calendarDaysLeft     calendar days left in the week, today included, less approved days off
//   approvedDaysOff      the week's approved days off
// expected rises through the day (today's share), so it never jumps 20 points
// each morning; days left never exceed the target days not yet worked.
function pace({ credits, hours, completedWorkedDays, todayHours, calendarDaysLeft, approvedDaysOff }, targets = {}) {
	const score = rei(credits, hours, targets);
	if (score === null) return null;
	const ct = targets.credits || CREDIT_TARGET;
	const ht = targets.hours || HOURS_TARGET;
	const worked = Math.max(0, Number(completedWorkedDays) || 0);
	const targetDays = Math.max(0, TARGET_DAYS - (Number(approvedDaysOff) || 0));
	const todayShare = Math.min(1, Math.max(0, Number(todayHours) || 0) / DAILY_HOURS_GUIDE);
	const expected = targetDays > 0 ? 100 * Math.min(1, (worked + todayShare) / targetDays) : 100;
	const daysLeft = Math.max(0, Math.min(Number(calendarDaysLeft) || 0, targetDays - worked));
	const creditsLeft = Math.max(0, ct - (Number(credits) || 0));
	const hoursLeft = Math.max(0, ht - Number(hours));
	const reachable = creditsLeft <= DAILY_CREDITS_GUIDE * daysLeft + EPS && hoursLeft <= DAILY_HOURS_GUIDE * daysLeft + EPS;
	let word;
	if (!reachable) word = "out-of-reach";
	else if (score >= expected + PACE_BAND - EPS) word = "ahead";
	else if (score >= expected - PACE_BAND - EPS) word = "on-track";
	else word = "needs-focus";
	return {
		expected,
		word,
		reachable,
		gap: reachable && (creditsLeft > 0 || hoursLeft > 0) ? { credits: creditsLeft, hours: hoursLeft } : null,
	};
}

// ── The driver's own week ───────────────────────────────────────────────────

// The days of start..end his approved time off covers, each once.
// rows: driverAvailabilityByName()'s rows for him.
function offDaysInWeek(rows, start, end) {
	return daysBetween(start, end).filter((day) => (rows || []).some((r) => r.from_date <= day && day <= r.to_date));
}

// His target for a week: lower for each approved day off, so time off never reads as falling short.
function personalTarget(daysOff, rule = LOADS_PACE) {
	return Math.max(rule.targetFloor, CREDIT_TARGET - rule.creditsPerDay * Math.max(0, Number(daysOff) || 0));
}

// The days from today through the week's end he can still work, no more than
// the target needs: a day off isn't one, and a past one has already lowered the target.
function workDaysLeft(today, end, offDays, target, rule = LOADS_PACE) {
	const off = new Set(offDays || []);
	const open = daysBetween(today, end).filter((day) => !off.has(day)).length;
	return Math.min(open, target / rule.creditsPerDay);
}

// One of LOADS_PACE_WORDS, from unrounded values.
function loadsPaceWord(credits, target, daysLeft, rule = LOADS_PACE) {
	const value = Number(credits) || 0;
	const expected = Math.max(0, target - rule.creditsPerDay * daysLeft);
	if (value >= target - EPS || value >= expected + rule.aheadBy - EPS) return "ahead";
	if (value >= expected - EPS) return "on-track";
	return "needs-focus";
}

// One counted load as its own driver sees it, three named keys and nothing else
// of the sheet's row. An uncounted pickup says what became of it, so the row explains
// its figure; "not-counted" is all that holds whichever way the pickup was made.
function countedLoad({ loadId, pickupDay, deliveryDay, pickupNote }, weights = CREDIT_WEIGHTS) {
	return {
		loadId: String(loadId === null || loadId === undefined ? "" : loadId).trim(),
		pickup: pickupDay ? { day: weekdayOf(pickupDay), credits: weights.pickup } : { note: pickupNote || "not-counted" },
		delivery: deliveryDay ? { day: weekdayOf(deliveryDay), credits: weights.delivery } : null,
	};
}

// A driver's own week, from his own figures alone: nothing here can see another
// driver or a rank. Hours, the REI, the gap and "out of reach" are never here,
// whatever data exists. A closed week is its final figure, with no label.
// A label needs something he can act on: no load in his name yet at 0 is dispatch's
// to give, and a week with 3 days off, or none left to work, asks nothing of him.
function personalWeek({ id, start, end, today, deliveries, pickups, loads, offDays, openLoad }, rule = LOADS_PACE) {
	const d = Number(deliveries) || 0;
	const p = Number(pickups) || 0;
	const value = loadCredits(d, p);
	const off = offDays || [];
	const target = personalTarget(off.length, rule);
	const week = { id, start, end, credits: { value, target, deliveries: d, pickups: p } };
	const percent = Math.min(100, Math.floor((100 * value) / target + EPS));
	if (today > end) return { ...week, left: null, percent, pace: null, newWeekNote: false, targetLowered: false, loads };
	const daysLeft = workDaysLeft(today, end, off, target, rule);
	const left = Math.max(0, target - value);
	const met = left <= EPS;
	const labelled = off.length < rule.hideLabelAtDaysOff && (value > 0 || !!openLoad) && (met || daysLeft > 0);
	return {
		...week,
		left,
		percent,
		pace: labelled ? loadsPaceWord(value, target, daysLeft, rule) : null,
		newWeekNote: left > rule.creditsPerDay * daysLeft + EPS,
		targetLowered: target < CREDIT_TARGET - EPS,
		loads,
	};
}

// ── Unit labels ─────────────────────────────────────────────────────────────

// trucks.unit_number is free text several roles type, and this label reaches
// every driver with nobody reading it first. So only a unit's shape passes;
// anything else reads UNIT_NOT_SHOWN, and the Super Admin report says why.
const UNIT_NOT_SHOWN = "Unit not shown";
const UNIT_RAW_MAX = 50;
const UNIT_MAX = 12;
const UNIT_PREFIX_RE = /^logisx[\s_-]{0,8}/i;
const UNIT_SHAPE_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
// A longer word is more likely a name than a unit ("INV" is the longest in use).
const UNIT_LETTER_RUN_MAX = 3;
// More digits than a unit has: a phone number, a load number or a date.
const UNIT_DIGITS_MAX = 5;

// Each name's parts and initials, lower case, for unitLabel().
function unitNameParts(names) {
	const parts = new Set();
	const initials = new Set();
	for (const name of names || []) {
		const words = String(name || "").toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
		for (const w of words) parts.add(w);
		if (words.length > 1) {
			initials.add(words.map((w) => w[0]).join(""));
			initials.add(words[0][0] + words[words.length - 1][0]);
		}
	}
	return { parts: [...parts], initials };
}

// The one place a stored unit becomes a label: { text, refused }, where text is
// one plain form ("LogisX-#101" and "101" both read "#101") or UNIT_NOT_SHOWN, and
// refused is null or why. names: unitNameParts(); a letter run that is a name's
// part, the start of one, or its initials is refused.
function unitLabel(raw, names) {
	const refuse = (refused) => ({ text: UNIT_NOT_SHOWN, refused });
	const stored = String(raw === null || raw === undefined ? "" : raw).trim();
	if (stored.length > UNIT_RAW_MAX) return refuse("length");
	const body = stored.replace(UNIT_PREFIX_RE, "").replace(/^#/, "");
	if (!body) return refuse("empty");
	if (!UNIT_SHAPE_RE.test(body)) return refuse("characters");
	if (body.length > UNIT_MAX) return refuse("length");
	const digits = body.replace(/[^0-9]/g, "").length;
	if (digits === 0) return refuse("no-digit");
	const runs = body.toLowerCase().match(/[a-z]+/g) || [];
	if (runs.some((r) => r.length > UNIT_LETTER_RUN_MAX)) return refuse("letters");
	if (digits > UNIT_DIGITS_MAX) return refuse("number");
	if (names && runs.some((r) => r.length > 1 && (names.initials.has(r) || names.parts.some((p) => p.startsWith(r))))) return refuse("name");
	return { text: `#${body.toUpperCase()}`, refused: null };
}

function shortDay(day) {
	const [, m, d] = String(day).split("-").map(Number);
	return `${MONTHS[m - 1]} ${d}`;
}

// Calendar arithmetic again: the weekday of a bare day, which no zone can shift.
function weekdayOf(day) {
	const [y, m, d] = String(day).split("-").map(Number);
	return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

const naturalCompare = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });

// The unit a driver is shown under: the one he held on the most days of the
// period; a tie goes to the one he held later.
// holdings: [{ truckId, unit, days, firstDay, lastDay }]
function chooseUnit(holdings) {
	let best = null;
	for (const h of holdings || []) {
		if (!best
			|| h.days > best.days
			|| (h.days === best.days && (h.lastDay > best.lastDay
				|| (h.lastDay === best.lastDay && (h.firstDay > best.firstDay
					|| (h.firstDay === best.firstDay && naturalCompare(h.unit, best.unit) > 0)))))) best = h;
	}
	return best;
}

// Labels for every listed driver. Two drivers shown under one unit (a
// handover) read "#703 (1)" and "#703 (2)" in the order they held it, with no
// dates; the dates go on the driver's own row only (ownLabel).
// chosen: Map(driverId -> holding); period: { start, lastDay }; names: unitNameParts().
function boardLabels(chosen, period, names) {
	const byTruck = new Map();
	for (const [driverId, h] of chosen) {
		if (!byTruck.has(h.truckId)) byTruck.set(h.truckId, []);
		byTruck.get(h.truckId).push({ driverId, h });
	}
	const out = new Map();
	for (const group of byTruck.values()) {
		if (group.length === 1) {
			const label = unitLabel(group[0].h.unit, names).text;
			out.set(group[0].driverId, { label, ownLabel: label });
			continue;
		}
		group.sort((a, b) => (a.h.firstDay < b.h.firstDay ? -1 : a.h.firstDay > b.h.firstDay ? 1
			: a.h.lastDay < b.h.lastDay ? -1 : a.h.lastDay > b.h.lastDay ? 1 : a.driverId - b.driverId));
		const text = unitLabel(group[0].h.unit, names).text;
		group.forEach(({ driverId, h }, i) => {
			const n = i + 1;
			const from = period && h.firstDay > period.start ? shortDay(h.firstDay) : "";
			const to = period && h.lastDay < period.lastDay ? shortDay(h.lastDay) : "";
			const dates = from && to ? `${from} to ${to}` : from ? `from ${from}` : to ? `to ${to}` : "";
			out.set(driverId, {
				label: `${text} (${n})`,
				ownLabel: `${text} (${n}${dates ? `, ${dates}` : ""})`,
			});
		});
	}
	return out;
}

// ── Ranking and the driver-safe projection ─────────────────────────────────

function categoryById(id) {
	return CATEGORIES.find((c) => c.id === id) || null;
}

// Ranked entries first, best first; ties share the place (1, 1, 3) and sort by
// unit label. An entry without a value (null: no data, or excluded for any
// reason) is "not ranked", never 0, and sorts after them by unit label.
// entries: [{ driverId, label, ownLabel, value }]
function rankEntries(category, entries) {
	const sign = category.better === "lower" ? 1 : -1;
	const valued = [];
	const unvalued = [];
	for (const e of entries || []) {
		const v = e.value;
		if (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) unvalued.push({ ...e, value: null, rank: null });
		else valued.push({ ...e, value: Number(v) });
	}
	valued.sort((a, b) => sign * (a.value - b.value) || naturalCompare(a.label, b.label));
	for (let i = 0; i < valued.length; i++) {
		valued[i].rank = i > 0 && valued[i].value === valued[i - 1].value ? valued[i - 1].rank : i + 1;
	}
	unvalued.sort((a, b) => naturalCompare(a.label, b.label));
	return [...valued, ...unvalued];
}

// One board row as a driver sees it: exactly ROW_KEYS. A not-ranked row is
// built from the label alone, so no reason can ever reach it.
function projectRow(category, entry, viewerId) {
	const isYou = viewerId !== null && viewerId !== undefined && entry.driverId === viewerId;
	const unitLabel = isYou ? entry.ownLabel || entry.label : entry.label;
	if (entry.rank === null || entry.rank === undefined) {
		return { rank: null, unitLabel, value: null, display: NOT_RANKED, isYou };
	}
	if (!category.display) return { rank: entry.rank, unitLabel, value: null, display: "", isYou };
	return { rank: entry.rank, unitLabel, value: entry.value, display: category.display(entry.value), isYou };
}

// A category's rows for one viewer. viewerId is the session's own driver,
// applied per request; null for a Super Admin.
function projectCategory(category, ranked, viewerId, view = BOARD_VIEW) {
	if (!category.live) return { id: category.id, status: "coming-soon", listed: null, rows: [] };
	let shown = ranked;
	if (view === "top3-you") {
		shown = ranked.filter((e) => (e.rank !== null && e.rank <= 3) || (viewerId !== null && viewerId !== undefined && e.driverId === viewerId));
	}
	return { id: category.id, status: "live", listed: ranked.length, rows: shown.map((e) => projectRow(category, e, viewerId)) };
}

module.exports = {
	CREDIT_WEIGHTS,
	WHO_IS_IN,
	BOARD_VIEW,
	CREDIT_TARGET,
	HOURS_TARGET,
	DAILY_CREDITS_GUIDE,
	DAILY_HOURS_GUIDE,
	DAILY_HOURS_CAP,
	TARGET_DAYS,
	PACE_BAND,
	LOADS_PACE,
	LOADS_PACE_WORDS,
	ELD_REPORTING_LOOKBACK_DAYS,
	CATEGORIES,
	NOT_RANKED,
	ROW_KEYS,
	addDays,
	daysBetween,
	businessDayOf,
	boardPeriods,
	boardExclusion,
	personalExclusion,
	isTestUnit,
	pickupEvidence,
	eldReportingOn,
	loadCredits,
	creditedHours,
	rei,
	weekMet,
	reiDisplay,
	pace,
	offDaysInWeek,
	personalTarget,
	countedLoad,
	personalWeek,
	UNIT_NOT_SHOWN,
	unitNameParts,
	unitLabel,
	chooseUnit,
	boardLabels,
	categoryById,
	rankEntries,
	projectRow,
	projectCategory,
};
