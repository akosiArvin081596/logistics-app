"use strict";

// The weekly performance page on a driver's weekly invoice (server.js, behind the page's own switch,
// which nothing here reads): his own Performance week for the invoice's week, in the words his own
// tab gives it (client/src/lib/driverPerformance.js), on one page after the invoice. The invoice keeps
// these lines, not the figures (render_data.performance), so every redraw prints the page as it read
// when the invoice was made, whatever the words or the hours switch say later. Display only: no pay
// figure reads it. "This week" in its lines is the week the page names.
// Pure: no network, database, file, setting or clock. The moment and the zone are handed in, and
// lib/app-time.js gives only the zone's short name. scripts/test-driver-performance-client.mjs pins
// each line equal to the tab's own for the same answer.

const appTime = require("./app-time");

// The page's own words, new with it.
const HEADING = "WEEKLY PERFORMANCE";
const TITLE = "What counted";
// The tab's words.
const LOWER_TARGET_LINE = "Your target is lower this week for your approved time off.";
const NO_LOADS_LINE = "Nothing has counted yet this week.";
const DRIVE_HOURS_LINE = "Driving hours: coming soon";
const NO_DRIVING_HOURS_LINE = "No driving hours for this truck";
const PICKUP_NOTES = Object.freeze({
	"last-week": "Pickup counted last week",
	"another-week": "Pickup counted in another week",
	"not-counted": "Pickup not counted this week",
});

// What a stored page may hold, here and at the renderer's sink: its lines in print order, each at most
// LINE_MAX characters, and at most ROWS_MAX rows, more loads than any week holds.
const PAGE_KEYS = Object.freeze(["heading", "week", "asOf", "count", "requirement", "rule", "lowered", "title", "rows", "empty", "hours"]);
const LINE_MAX = 200;
const ROWS_MAX = 60;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_DATE_RE = /^[A-Z][a-z]{2} \d{1,2}$/;
const isNumber = (n) => typeof n === "number" && Number.isFinite(n);
const own = (o, key) => (Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined);

// A real calendar day "YYYY-MM-DD", read on the UTC calendar, which no zone can shift.
function isDay(text) {
	if (typeof text !== "string" || !DAY_RE.test(text)) return false;
	const [y, m, d] = text.split("-").map(Number);
	const t = new Date(Date.UTC(y, m - 1, d));
	return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const monthDay = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

// "Nov 7 to Nov 13", as the invoice words its billing period; both years across a year end.
function weekLine(start, end) {
	if (!isDay(start) || !isDay(end)) return "";
	if (start.slice(0, 4) !== end.slice(0, 4)) return `${monthDay(start)}, ${start.slice(0, 4)} to ${monthDay(end)}, ${end.slice(0, 4)}`;
	return `${monthDay(start)} to ${monthDay(end)}`;
}

// "As of Fri Nov 13, 7:00 PM ET": the moment on the business clock, named by its zone's short word
// ("ET", "CT"), or by the zone itself for any other. Throws for a zone the runtime doesn't know.
function asOfLine(ms, zone) {
	const parts = {};
	const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
	for (const p of format.formatToParts(new Date(ms))) parts[p.type] = p.value;
	const words = appTime.zoneWords(zone);
	return `As of ${parts.weekday} ${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${words ? words.short : zone}`;
}

// His week's driving hours, as his tab words a past week's: coming soon with none sent (their switch
// off) and for anything it can't trust, so a wrong figure never prints, and what's missing is named.
function hoursLine(hours) {
	if (!hours || typeof hours !== "object") return DRIVE_HOURS_LINE;
	if (hours.state === "estimate" && isNumber(hours.value) && hours.value >= 0) return `Driving: ${hours.value} h (estimate)`;
	if (hours.state === "none") return NO_DRIVING_HOURS_LINE;
	if (hours.state === "starts" && typeof hours.day === "string" && WEEK_DATE_RE.test(hours.day)) return `Driving hours start ${hours.day}`;
	return DRIVE_HOURS_LINE;
}

// One counted load as the tab words it, "Load 4400123: Picked up Mon 0.5 · Delivered Tue 0.5", or null
// when a part of it can't be trusted.
function rowLine(load) {
	if (!load || typeof load !== "object") return null;
	const counted = (part) => part && typeof part.day === "string" && isNumber(part.credits);
	const { pickup, delivery } = load;
	if (delivery && !counted(delivery)) return null;
	let parts = delivery ? [`Delivered ${delivery.day} ${delivery.credits}`] : [];
	if (counted(pickup)) parts = [`Picked up ${pickup.day} ${pickup.credits}`, ...parts];
	else if (pickup && typeof pickup.note === "string" && Object.prototype.hasOwnProperty.call(PICKUP_NOTES, pickup.note)) parts = [...parts, PICKUP_NOTES[pickup.note]];
	else if (pickup) return null;
	if (!parts.length) return null;
	const id = typeof load.loadId === "string" ? load.loadId : "";
	return `${id ? `Load ${id}` : "Load"}: ${parts.join(" · ")}`;
}

const capped = (text) => (typeof text === "string" ? text.slice(0, LINE_MAX) : "");

// The page for his week. answer: lib/driver-performance-routes.js invoiceWeek()'s { week, weights,
// hours }; asOfMs: the moment it is made; zone: the business clock's. null when the answer doesn't hold
// the week whole, so the page never prints a wrong number.
function pageOf(answer, { asOfMs, zone } = {}) {
	const week = answer && typeof answer === "object" ? answer.week : null;
	const weights = answer && typeof answer === "object" ? answer.weights : null;
	const credits = week && typeof week === "object" ? week.credits : null;
	if (!credits || !isNumber(credits.value) || !isNumber(credits.target)) return null;
	if (!weights || !isNumber(weights.pickup) || !isNumber(weights.delivery)) return null;
	if (!Array.isArray(week.loads)) return null;
	const rows = week.loads.map(rowLine);
	if (rows.includes(null)) return null;
	const range = weekLine(week.start, week.end);
	let asOf = "";
	try {
		asOf = typeof zone === "string" && isNumber(asOfMs) ? asOfLine(asOfMs, zone) : "";
	} catch {
		asOf = "";
	}
	if (!range || !asOf) return null;
	const { value, target, required } = credits;
	return {
		heading: HEADING,
		week: range,
		asOf,
		count: `${value} of ${target} loads`,
		requirement: isNumber(required) ? `${target} is the target. ${required} is required.` : `${target} is the target.`,
		rule: `Each pickup counts ${weights.pickup} and each delivery ${weights.delivery}.`,
		lowered: week.targetLowered === true ? LOWER_TARGET_LINE : "",
		title: TITLE,
		rows: rows.slice(0, ROWS_MAX).map(capped),
		empty: rows.length ? "" : NO_LOADS_LINE,
		hours: hoursLine(answer.hours),
	};
}

// A stored page as the renderer may print it: its own lines only, each text within LINE_MAX, and at
// most ROWS_MAX rows of text; null for anything that isn't a page (no heading). The field map and the
// renderer's sink both check it here.
function safePage(page) {
	if (!page || typeof page !== "object" || Array.isArray(page)) return null;
	if (!capped(own(page, "heading"))) return null;
	const out = {};
	for (const key of PAGE_KEYS) {
		const value = own(page, key);
		out[key] = key === "rows"
			? (Array.isArray(value) ? value : []).filter((r) => typeof r === "string" && r !== "").slice(0, ROWS_MAX).map(capped)
			: capped(value);
	}
	return out;
}

module.exports = { pageOf, safePage, asOfLine, weekLine, hoursLine, PAGE_KEYS, LINE_MAX, ROWS_MAX, HEADING, TITLE };
