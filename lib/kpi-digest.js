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

// { response, preview, asOfDay } -> { subject, html, text }. asOfDay is the
// business day the digest is built on; the subject names the Monday of its week.
function buildDigest({ response, preview, asOfDay }) {
	const r = response && typeof response === "object" ? response : {};
	const day = typeof asOfDay === "string" && DAY_RE.test(asOfDay) ? asOfDay : (DAY_RE.test(String(r.asOfDay || "")) ? r.asOfDay : "");
	const weekOf = day ? dateText(mondayOf(day)) : "";
	const title = `LogisX weekly KPIs: week of ${weekOf || "this week"}`;
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
	const html = [
		`<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:680px;margin:0 auto;color:#1e293b">`,
		preview ? `<p style="margin:0 0 16px;padding:12px 16px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;font-weight:700;color:#92400e">${escHtml(banner)}</p>` : "",
		`<h2 style="margin:0 0 8px;font-size:20px;color:#0f172a">${escHtml(title)}</h2>`,
		`<p style="margin:0 0 16px;color:#475569">${escHtml(asOfLine)}</p>`,
		`<table style="border-collapse:collapse;font-size:13px;width:100%">`,
		...rows.map((row) => `<tr><td style="${cell};font-weight:700;width:34%">${escHtml(row.label)}</td>` +
			`<td style="${cell}">${row.details.map((d) => escHtml(d)).join("<br>")}</td></tr>`),
		`</table>`,
		`<p style="margin:16px 0 0;color:#64748b;font-size:12px">${escHtml(FOOTER)}</p>`,
		`</div>`,
	].join("\n");

	const text = [
		...(preview ? [banner, ""] : []),
		title,
		asOfLine,
		"",
		...rows.flatMap((row) => [row.label, ...row.details.map((d) => `  ${d}`), ""]),
		FOOTER,
	].join("\n");

	return { subject, html, text };
}

module.exports = { buildDigest, beforeAfterLines, escHtml, PREVIEW_MARK, FOOTER, DIGEST_HOLD };
