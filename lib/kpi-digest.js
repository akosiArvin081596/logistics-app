"use strict";
// THE WEEKLY KPI DIGEST: one email, built from the same object
// GET /api/admin/kpis returns (lib/kpi-metrics.js buildKpiResponse()).
//
// What it prints, per metric and nothing else: the label, the current figure
// with its period, the comparisons, a whole-month before/after line (only for a
// month-mode entry: paid-mile share's "Before: 65.3% (July-August 2026).
// Contract month: 92.9% (September 2026). After: no full month yet." and its
// month-to-date note; equal-window entries are never printed), what kind of
// figure it is (with every assumption whenever it is an estimate), its
// confidence, its notes, and whether it is approved for public use. It never
// prints a breakdown, a coverage description or count, the settings or the job
// state: the digest is read outside the app and forwarded, so it carries only
// the fields a person needs to decide what may be published, all of them
// aggregated figures.
//
// THE HOLD (R10). DIGEST_HOLD keeps the five mile metrics (loaded, paid,
// deadhead and unloaded miles, and paid-mile share v2) out of both bodies while
// it is on, which it is by default: their figures wait for production's tables
// to fill and for the user's review of them. The admin page still shows them,
// unapproved. Lifting the hold is a one-line change here, by the user's decision.
//
// A metric with no data says so ("Missing data", "Not tracked"); it is never
// shown as 0, because a 0 in a forwarded email reads as a measured zero.
//
// The preview (sent once, after the first successful snapshot) is marked in the
// subject and in a banner at the top of both bodies, with an EN DASH:
// "PREVIEW – not approved for public use".
//
// WEEKLY (R4, the answer's `weekly` fields, KPI_WEEKLY_ENABLED): last week
// against the week before leads; the month rows above come only on the first
// Monday of a month. Without those fields the email is exactly as before.
//
// Every value is HTML-escaped in the HTML body (escHtml() below behaves exactly
// like server.js escHtml()); the text body is plain text.
//
// Pure: no I/O and no requires.

const PREVIEW_MARK = "PREVIEW – not approved for public use";
const DIGEST_HOLD = Object.freeze({
	enabled: true,
	keys: Object.freeze(["loaded_miles", "paid_miles", "deadhead_miles", "unloaded_miles", "paid_mile_share"]),
});
const MONTH_TO_DATE_NOTE = "Loads still under way are in the total miles but not yet in the paid miles.";
const FOOTER = "Aggregated figures only. Do not publish a metric marked “Approved for public use: No”.";
const MONTH_HEADING = "Month";
const MONTHLY_LATER = "Monthly figures come in the first Monday's email of each month.";
const WEEKLY_UNAVAILABLE = "Weekly figures are not available this week.";
const NOT_AVAILABLE = "Not available";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same behaviour as escHtml() in server.js.
function escHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// A string field as one short line ("" for anything else).
function line(v, max = 300) {
	return typeof v === "string" ? v.slice(0, max + 1).replace(/[\r\n\t]/g, " ").trim().slice(0, max) : "";
}

// "Oct 5, 2026" for a calendar date, read as written (no zone).
function dateText(day) {
	if (typeof day !== "string" || !DAY_RE.test(day)) return "";
	const [y, m, d] = day.split("-").map(Number);
	return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// The Monday of the Monday-to-Sunday week `day` falls in.
function mondayOf(day) {
	const [y, m, d] = day.split("-").map(Number);
	const noon = new Date(Date.UTC(y, m - 1, d, 12));
	const sinceMonday = (noon.getUTCDay() + 6) % 7;
	return new Date(noon.getTime() - sinceMonday * 86400000).toISOString().slice(0, 10);
}

const KIND_TEXT = { real: "Measured", estimate: "Estimate", proxy: "Proxy", not_tracked: "Not tracked" };
const CONFIDENCE_TEXT = { high: "High", medium: "Medium", low: "Low", none: "None" };

// The figure, or what stands in its place.
function valueText(m) {
	const reason = line(m.missingReason);
	if (m.status === "not_tracked") return reason ? `Not tracked — ${reason}` : "Not tracked";
	if (m.status === "missing") return reason ? `Missing data — ${reason}` : "Missing data";
	const current = m.current && typeof m.current === "object" ? m.current : {};
	const shown = line(m.display, 80) || line(current.display, 80) || "No data";
	const period = line(current.label, 60);
	return period ? `${shown} (${period})` : shown;
}

function comparisonLines(m) {
	const out = [];
	for (const c of Array.isArray(m.comparisons) ? m.comparisons : []) {
		if (!c || typeof c !== "object") continue;
		const label = line(c.label, 80);
		if (!label) continue;
		const shown = c.status === "missing" ? "Missing data" : (line(c.display, 80) || "Missing data");
		out.push(`${label}: ${shown}`);
	}
	return out;
}

// A whole-month before/after entry (precision 'month' or 'day') as one line,
// plus its month-to-date note. Equal-window entries print nothing.
function beforeAfterLines(m) {
	const out = [];
	for (const b of Array.isArray(m.beforeAfter) ? m.beforeAfter : []) {
		if (!b || typeof b !== "object" || (b.precision !== "month" && b.precision !== "day")) continue;
		const figure = (x) => {
			const shown = line(x && x.display, 40);
			if (x && typeof x.value === "number" && Number.isFinite(x.value) && shown) return shown;
			return shown === "No full month yet" ? "no full month yet" : "not enough data";
		};
		const sideText = (name, s) => {
			if (!s || typeof s !== "object") return `${name}: no full month yet.`;
			const months = line(s.label, 80);
			const shown = figure(s);
			return `${name}: ${shown}${months && /\d/.test(shown) ? ` (${months})` : ""}.`;
		};
		const rows = (Array.isArray(b.contractMonth) ? b.contractMonth : []).filter((r) => r && typeof r === "object");
		const contract = b.precision === "month" && rows.length === 1
			? [`Contract month: ${figure(rows[0])}${line(rows[0].label, 60) ? ` (${line(rows[0].label, 60)})` : ""}.`]
			: rows.map((r) => `${line(r.label, 60)}: ${figure(r)}.`);
		out.push([sideText("Before", b.before), ...contract, sideText("After", b.after)].join(" "));
		const mtd = b.monthToDate && typeof b.monthToDate === "object" ? b.monthToDate : null;
		if (mtd && line(mtd.label, 60)) out.push(`Month to date (${line(mtd.label, 60)}): ${figure(mtd)}. ${MONTH_TO_DATE_NOTE}`);
	}
	return out;
}

// What kind of figure it is. An estimate always carries its assumptions.
function kindText(m) {
	const confidence = CONFIDENCE_TEXT[m.confidence] || "None";
	if (m.kind === "estimate") {
		const assumptions = (Array.isArray(m.assumptions) ? m.assumptions : []).map((a) => line(a)).filter(Boolean);
		const why = assumptions.length ? assumptions.join(" ") : "no assumption is recorded";
		return `Estimate — ${why} Confidence: ${confidence}.`;
	}
	return `${KIND_TEXT[m.kind] || "Measured"}. Confidence: ${confidence}.`;
}

function approvedText(m) {
	return `Approved for public use: ${m.approval && m.approval.approved === true ? "Yes" : "No"}`;
}

function noteLines(m) {
	return (Array.isArray(m.warnings) ? m.warnings : []).map((w) => line(w)).filter(Boolean).map((w) => `Note: ${w}`);
}

// R4: a Monday dated the 1st to the 7th, read off the business day passed in
// (a calendar date: never the clock's day, never through a zone).
function isFirstMonday(day) {
	if (typeof day !== "string" || !DAY_RE.test(day)) return false;
	const [y, m, d] = day.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() === 1 && d <= 7;
}

// A complete week as the answer names it ({ weekStart, label, shortLabel }).
function weekOfAnswer(w) {
	return w && typeof w === "object" && DAY_RE.test(String(w.weekStart || "")) && line(w.label, 60) ? w : null;
}

// The kind without a confidence line: the stored confidence is the month's.
function weeklyKindText(m) {
	if (m.kind === "estimate") {
		const assumptions = (Array.isArray(m.assumptions) ? m.assumptions : []).map((a) => line(a)).filter(Boolean);
		return assumptions.length ? `Estimate — ${assumptions.join(" ")}` : "Estimate — no assumption is recorded.";
	}
	return `${KIND_TEXT[m.kind] || "Measured"}.`;
}

// One metric's weekly lines, every figure, label and change the server's own
// string; a figure for another week than the answer's is never printed.
function weeklyLines(m, lastWeek, weekBefore) {
	const w = m.weekly && typeof m.weekly === "object" ? m.weekly : null;
	if (w && w.mode === "monthly_only") return [line(w.reason) || "Monthly only"];
	if (w && w.mode === "not_tracked") return [KIND_TEXT.not_tracked];
	if (!w || w.mode !== "weekly") return [NOT_AVAILABLE];
	const cur = w.current && w.current.weekStart === lastWeek.weekStart ? w.current : null;
	const prev = weekBefore && w.previous && w.previous.weekStart === weekBefore.weekStart ? w.previous : null;
	const shown = (x) => line(x && x.display, 80) || NOT_AVAILABLE;
	const c = cur && w.comparison && typeof w.comparison === "object" ? w.comparison : null;
	const change = c && c.status === "withheld" && line(c.note) ? line(c.note) : `Change: ${(c && line(c.display, 40)) || NOT_AVAILABLE}.`;
	const before = weekBefore ? `Week before (${line(weekBefore.shortLabel, 40)})` : "Week before";
	return [
		`Last week (${line(lastWeek.shortLabel, 40)}): ${shown(cur)}. ${before}: ${shown(prev)}. ${change}`,
		weeklyKindText(m),
		// K29: the server says whether the approval was given after weekly figures began.
		`Approved for public use (weekly figures): ${m.approval && m.approval.approved === true && m.approval.coversWeekly === true ? "Yes" : "No"}`,
	];
}

// { response, preview, asOfDay } -> { subject, html, text }. asOfDay is the
// business day the digest is built on (the Monday it goes out).
function buildDigest({ response, preview, asOfDay }) {
	const r = response && typeof response === "object" ? response : {};
	const day = typeof asOfDay === "string" && DAY_RE.test(asOfDay) ? asOfDay : (DAY_RE.test(String(r.asOfDay || "")) ? r.asOfDay : "");
	const weekly = r.weekly && typeof r.weekly === "object" ? r.weekly : null;
	const lastWeek = weekly ? weekOfAnswer(weekly.lastWeek) : null;
	const weekBefore = lastWeek ? weekOfAnswer(weekly.weekBefore) : null;
	const weekOf = day ? dateText(mondayOf(day)) : "";
	const title = !weekly
		? `LogisX weekly KPIs: week of ${weekOf || "this week"}`
		: (lastWeek ? `LogisX weekly KPIs: ${line(lastWeek.label, 60)}` : "LogisX weekly KPIs: weekly figures not available");
	const subject = preview ? `${PREVIEW_MARK}: ${title}` : title;
	const asOf = dateText(r.asOfDay);
	const zone = line(r.timeZone, 60);
	const asOfLine = asOf ? `Figures as of ${asOf}${zone ? ` (${zone})` : ""}.` : "No snapshot has been taken yet.";
	const banner = `${PREVIEW_MARK}. This is a one-time preview of the weekly digest; review every figure before anything is shared.`;

	const metrics = (Array.isArray(r.metrics) ? r.metrics : [])
		.filter((m) => m && typeof m === "object")
		.filter((m) => !(DIGEST_HOLD.enabled && DIGEST_HOLD.keys.includes(m.key)));
	const rows = metrics.map((m) => ({
		label: line(m.label, 120) || "Unnamed metric",
		details: [valueText(m), ...comparisonLines(m), ...beforeAfterLines(m), kindText(m), ...noteLines(m), approvedText(m)],
	}));

	const cell = "padding:8px 10px;border:1px solid #e2e8f0;text-align:left;vertical-align:top";
	const tableHtml = (list) => [
		`<table style="border-collapse:collapse;font-size:13px;width:100%">`,
		...list.map((row) => `<tr><td style="${cell};font-weight:700;width:34%">${escHtml(row.label)}</td>` +
			`<td style="${cell}">${row.details.map((d) => escHtml(d)).join("<br>")}</td></tr>`),
		`</table>`,
	];
	const head = [
		`<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:680px;margin:0 auto;color:#1e293b">`,
		preview ? `<p style="margin:0 0 16px;padding:12px 16px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;font-weight:700;color:#92400e">${escHtml(banner)}</p>` : "",
		`<h2 style="margin:0 0 8px;font-size:20px;color:#0f172a">${escHtml(title)}</h2>`,
		`<p style="margin:0 0 16px;color:#475569">${escHtml(asOfLine)}</p>`,
	];
	const foot = [`<p style="margin:16px 0 0;color:#64748b;font-size:12px">${escHtml(FOOTER)}</p>`, `</div>`];
	const textRows = (list) => list.flatMap((row) => [row.label, ...row.details.map((d) => `  ${d}`), ""]);

	if (!weekly) {
		const html = [...head, ...tableHtml(rows), ...foot].join("\n");
		const text = [...(preview ? [banner, ""] : []), title, asOfLine, "", ...textRows(rows), FOOTER].join("\n");
		return { subject, html, text };
	}

	// The month rows: the first Monday's email of each month, the preview, and
	// any Monday whose weekly figures aren't current, so none goes out empty.
	const showMonth = !lastWeek || !!preview || isFirstMonday(day);
	const short = (w) => line(w.shortLabel, 40);
	const weekHead = lastWeek ? `Last week (${short(lastWeek)}) against the week before${weekBefore ? ` (${short(weekBefore)})` : ""}` : "";
	const rule = lastWeek ? line(weekly.weekRule, 600) : "";
	const weeklyRows = lastWeek ? metrics.map((m) => ({ label: line(m.label, 120) || "Unnamed metric", details: weeklyLines(m, lastWeek, weekBefore) })) : [];
	const h3 = (s) => `<h3 style="margin:20px 0 8px;font-size:16px;color:#0f172a">${escHtml(s)}</h3>`;
	const p = (s) => `<p style="margin:16px 0 0;color:#475569">${escHtml(s)}</p>`;
	const html = [
		...head,
		...(rule ? [`<p style="margin:0 0 16px;color:#475569">${escHtml(rule)}</p>`] : []),
		...(lastWeek ? [h3(weekHead), ...tableHtml(weeklyRows)] : [p(WEEKLY_UNAVAILABLE)]),
		...(showMonth ? [h3(MONTH_HEADING), ...tableHtml(rows)] : [p(MONTHLY_LATER)]),
		...foot,
	].join("\n");
	const text = [
		...(preview ? [banner, ""] : []),
		title,
		asOfLine,
		...(rule ? [rule] : []),
		"",
		...(lastWeek ? [weekHead, "", ...textRows(weeklyRows)] : [WEEKLY_UNAVAILABLE, ""]),
		...(showMonth ? [MONTH_HEADING, "", ...textRows(rows)] : [MONTHLY_LATER, ""]),
		FOOTER,
	].join("\n");
	return { subject, html, text };
}

module.exports = { buildDigest, beforeAfterLines, escHtml, isFirstMonday, PREVIEW_MARK, FOOTER, DIGEST_HOLD };
