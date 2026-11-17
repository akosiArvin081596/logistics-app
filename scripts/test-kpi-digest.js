#!/usr/bin/env node
/**
 * lib/kpi-digest.js buildDigest(): the weekly KPI email, built from a
 * GET /api/admin/kpis response.
 *
 * §1 subject: "LogisX weekly KPIs: week of <Monday>"; the preview's subject
 *    starts "PREVIEW – not approved for public use: " (EN DASH), the weekly
 *    one never does.
 * §2 the preview banner opens the HTML and the text; the weekly digest has none.
 * §3 one row per metric, each with "Approved for public use: Yes" only when
 *    approval.approved is exactly true, otherwise "No".
 * §4 missing and not-tracked metrics say so and are never shown as 0.
 * §5 an estimate always shows "Estimate — " with its assumptions.
 * §6 the current figure with its period, the comparisons, the notes.
 * §7 every value is HTML-escaped, by an escape that behaves exactly like
 *    server.js escHtml(); the footer is there verbatim.
 * §8 nothing outside the printed fields leaks: sentinel names placed in the
 *    breakdown, coverage, definition, source, settings and job state of the
 *    response appear in neither the subject, the HTML nor the text.
 * §9 the module is pure: no require, no process.env.
 * §10 MUTANTS: the preview marker with a hyphen, the approved mark inverted,
 *    escaping removed, missing data shown as 0, an estimate without its
 *    assumption, the breakdown printed (sentinels leak), the hold off or
 *    missing a key or holding truck utilization, equal-window entries printed,
 *    the month-to-date note dropped.
 * §11 R10 hold: the five mile metrics are absent from both bodies while
 *    DIGEST_HOLD is on (the default), every other metric's lines unchanged,
 *    truck utilization included; the held list is exactly those five.
 * §12 a month-mode before/after entry prints one line (months named, the
 *    contract-month label or the two exact-date rows) and the month-to-date
 *    note, after the comparisons; an equal-window entry prints none; no
 *    coverage line or count.
 * §13 with no weekly fields on the answer (KPI_WEEKLY_ENABLED off), the
 *    subject, the HTML and the text are byte for byte a693dbe2's (pinned).
 * §14 R4, the Monday email as D said (the answer's weekly fields present):
 *    the subject names last week's dates; last week against the week before,
 *    each figure, label and change the server's string, a withheld change
 *    replaced by its note, "No records" never a 0; monthly-only and not-tracked
 *    lines; the held metrics in neither section; K29's weekly approval line
 *    (through the real buildKpiResponse(): an approval at, before and after
 *    kpi.weekly_since, and an invalid one); the month section, byte for byte
 *    today's rows, only on a Monday dated the 1st to the 7th; no last week
 *    prints the month section and one line; the preview carries both
 *    sections; every new string HTML-escaped. Its MUTANTS: a Monday-based week
 *    in the subject, the month section every Monday, the first Monday read off
 *    the UTC day, the monthly approval on a weekly line, a held metric in the
 *    weekly section, the week-before figure worked out in the email.
 *
 * Pure: no server, no database, no network.
 *
 * Run: node scripts/test-kpi-digest.js    # exits 1 on failure
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "lib", "kpi-digest.js");
const SRC = fs.readFileSync(LIB, "utf8");
const SERVER = require("./lib/server-source").serverSource();

function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function loadFrom(src) {
	const m = new Module(LIB, module);
	m.filename = LIB;
	m.paths = [];
	m._compile(src, LIB);
	return m.exports;
}

const PREVIEW = "PREVIEW – not approved for public use";
const SENTINELS = ["Zed Sentinel Freight", "Quinn Sentinel"];
const XSS = "<script>alert(1)</script> & 'quotes'";

function metric(key, label, over = {}) {
	return {
		key, label, unit: "count", kind: "real", group: "ops", status: "ok", missingReason: null,
		definition: `${label}: Zed Sentinel Freight is never named here`, definitionVersion: 1,
		assumptions: [], source: { label: "Quinn Sentinel source", url: null }, warnings: [],
		value: 50, display: "50",
		current: { from: "2026-09-01", to: "2026-09-30", value: 50, display: "50", label: "September 2026" },
		totals: [{ label: "All time Quinn Sentinel", from: "2025-04-01", to: "2026-10-09", value: 478, display: "478" }],
		series: [{ period: "2026-09", value: 50, display: "50", coverage: 1 }],
		comparisons: [
			{ kind: "yoy", label: "Year over year", basePeriod: "2025-09", value: 50, baseValue: 38, deltaPct: 31.6, display: "+31.6% (vs 38)", status: "ok" },
			{ kind: "mom", label: "Month over month", basePeriod: "2026-08", value: 50, baseValue: null, deltaPct: null, display: "", status: "missing" },
		],
		beforeAfter: [],
		coverage: { num: 1, den: 1, ratio: 1, what: "loads of Zed Sentinel Freight", from: null, to: null },
		confidence: "high",
		breakdown: [{ label: "Quinn Sentinel", value: 9, display: "9" }, { label: "Zed Sentinel Freight", value: 3, display: "3" }],
		computedDay: "2026-10-09",
		approval: { approved: false, by: null, at: null, stale: false },
		...over,
	};
}

function fixture() {
	return {
		asOfDay: "2026-10-09", timeZone: "America/New_York", generatedAt: "2026-10-09T12:00:00.000Z",
		job: { enabled: { snapshot: true, digest: true }, lastRun: { id: 1, kind: "nightly", status: "ok", errors: [{ metric: null, code: "Quinn Sentinel" }] } },
		settings: { aiDispatchStart: { value: "2026-04-09", source: "derived", evidence: "Zed Sentinel Freight" }, recipients: ["quinn.sentinel@example.test"] },
		metrics: [
			metric("loads_delivered", "Loads delivered", { approval: { approved: true, by: "super_admin", at: "2026-10-08T00:00:00.000Z", stale: false } }),
			metric("revenue", "Gross load revenue", { display: "$53,344", current: { from: "2026-09-01", to: "2026-09-30", value: 53344, display: "$53,344", label: "September 2026" }, approval: { approved: "true" } }),
			metric("fuel_savings", "Diesel dollars saved vs baseline", { kind: "estimate", status: "missing", missingReason: "No baseline MPG set", value: null, display: "0", confidence: "none", assumptions: ["Compared with a truck at the baseline MPG set on this page."] }),
			metric("dispatch_calls", "Dispatch calls handled by AI", { kind: "not_tracked", status: "not_tracked", missingReason: "No call or voice system records dispatch calls.", value: null, display: "0", confidence: "none" }),
			metric("freight_tons_estimated", "Freight moved (estimated, all loads)", { kind: "estimate", confidence: "low", display: "8,270 t", assumptions: ["Loads with no stated weight are assumed to weigh the average of loads that state one."] }),
			metric("co2_tonnes", "Carbon output (tailpipe CO2)", { kind: "estimate", confidence: "low", display: "122 t CO2", assumptions: [] }),
			metric("on_time_rate", XSS, { display: "30.0%", warnings: ["Recorded appointments are not updated when a load is rescheduled; review before publishing."] }),
		],
	};
}

// [{ ok, name }] for one build of the module.
function checks(d) {
	const out = [];
	const t = (cond, name) => out.push({ ok: !!cond, name });
	const weekly = d.buildDigest({ response: fixture(), preview: false, asOfDay: "2026-10-14" });
	const preview = d.buildDigest({ response: fixture(), preview: true, asOfDay: "2026-10-14" });
	const rowOf = (html, label) => {
		const i = html.indexOf(`>${label}</td>`);
		return i < 0 ? "" : html.slice(i, html.indexOf("</tr>", i));
	};
	const textRow = (text, label) => {
		const lines = text.split("\n");
		const i = lines.indexOf(label);
		if (i < 0) return "";
		const j = lines.indexOf("", i);
		return lines.slice(i, j < 0 ? undefined : j).join("\n");
	};

	// §1
	t(weekly.subject === "LogisX weekly KPIs: week of Oct 12, 2026", `§1 weekly subject names the Monday of the week (got ${JSON.stringify(weekly.subject)})`);
	t(preview.subject === `${PREVIEW}: LogisX weekly KPIs: week of Oct 12, 2026`, "§1 preview subject starts with the EN-DASH preview marker");
	t(!/PREVIEW/.test(weekly.subject + weekly.html + weekly.text), "§1 the weekly digest carries no preview marker anywhere");
	t(d.buildDigest({ response: fixture(), preview: false, asOfDay: "2026-10-12" }).subject.endsWith("week of Oct 12, 2026"), "§1 on the Monday itself: that Monday");
	t(d.buildDigest({ response: fixture(), preview: false, asOfDay: "2026-10-18" }).subject.endsWith("week of Oct 12, 2026"), "§1 on the Sunday: the Monday before");

	// §2
	const firstTag = preview.html.indexOf("<p");
	t(firstTag >= 0 && preview.html.slice(firstTag, preview.html.indexOf("</p>", firstTag)).includes(PREVIEW) && firstTag < preview.html.indexOf("<h2"), "§2 preview HTML opens with the banner, above the title");
	t(preview.text.split("\n")[0].startsWith(PREVIEW), "§2 preview text opens with the banner");
	t(!weekly.html.includes("#fef3c7"), "§2 the weekly digest has no banner");

	// §3
	const rows = (weekly.html.match(/<tr>/g) || []).length;
	t(rows === fixture().metrics.length, `§3 one row per metric (${rows})`);
	t(rowOf(weekly.html, "Loads delivered").includes("Approved for public use: Yes"), "§3 an approved metric reads Yes");
	t(rowOf(weekly.html, "Gross load revenue").includes("Approved for public use: No"), "§3 approval \"true\" (a string) reads No");
	t(rowOf(weekly.html, "Freight moved (estimated, all loads)").includes("Approved for public use: No"), "§3 an unapproved metric reads No");
	t((weekly.text.match(/^ {2}Approved for public use: (Yes|No)$/gm) || []).length === rows, "§3 the text has the mark on every metric too");

	// §4
	const savings = rowOf(weekly.html, "Diesel dollars saved vs baseline");
	t(savings.includes("Missing data — No baseline MPG set"), "§4 a missing metric says Missing data with its reason");
	t(!/(^|[^0-9.,])0([^0-9.,%]|$)/.test(savings.replace(/<[^>]{0,200}>/g, " ").replace(/Approved for public use: (Yes|No)/, "")), "§4 ...and shows no 0");
	const calls = rowOf(weekly.html, "Dispatch calls handled by AI");
	t(calls.includes("Not tracked — No call or voice system records dispatch calls."), "§4 a not-tracked metric says Not tracked");
	t(!/(^|[^0-9.,])0([^0-9.,%]|$)/.test(calls.replace(/<[^>]{0,200}>/g, " ")), "§4 ...and shows no 0");
	t(textRow(weekly.text, "Diesel dollars saved vs baseline").includes("Missing data"), "§4 the text says Missing data too");

	// §5
	t(rowOf(weekly.html, "Freight moved (estimated, all loads)").includes("Estimate — Loads with no stated weight are assumed to weigh the average of loads that state one."), "§5 an estimate shows Estimate — and its assumption");
	t(rowOf(weekly.html, "Carbon output (tailpipe CO2)").includes("Estimate — no assumption is recorded"), "§5 an estimate with no assumption says so");
	t(textRow(weekly.text, "Freight moved (estimated, all loads)").includes("Estimate — Loads with no stated weight"), "§5 the text shows it too");

	// §6
	const loads = rowOf(weekly.html, "Loads delivered");
	t(loads.includes("50 (September 2026)"), "§6 the current figure with its period");
	t(loads.includes("Year over year: +31.6% (vs 38)") && loads.includes("Month over month: Missing data"), "§6 comparisons, a missing one said as such");
	t(weekly.html.includes("Note: Recorded appointments are not updated when a load is rescheduled; review before publishing."), "§6 the notes");
	t(weekly.html.includes("Figures as of Oct 9, 2026 (America/New_York)."), "§6 the as-of day");

	// §7
	t(weekly.html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;quotes&#39;") && !weekly.html.includes("<script>"), "§7 a label is HTML-escaped");
	const escServer = new Function(`${SERVER.match(/\nfunction escHtml\(s\) \{[\s\S]*?\n\}\n/)[0]}\nreturn escHtml;`)();
	const samples = [XSS, `"a" <b> & 'c'`, null, undefined, 0, "plain", "–“”"];
	t(samples.every((v) => d.escHtml(v) === escServer(v)), "§7 its escape behaves exactly like server.js escHtml()");
	t(weekly.html.includes(d.escHtml("Aggregated figures only. Do not publish a metric marked “Approved for public use: No”.")) &&
		weekly.text.includes("Aggregated figures only. Do not publish a metric marked “Approved for public use: No”."), "§7 the footer, verbatim");

	// §8
	for (const s of SENTINELS) {
		const leaks = [["subject", weekly.subject + preview.subject], ["html", weekly.html + preview.html], ["text", weekly.text + preview.text]]
			.filter(([, v]) => v.toLowerCase().includes(s.toLowerCase())).map(([k]) => k);
		t(leaks.length === 0, `§8 "${s}" appears nowhere (${leaks.join(", ") || "clean"})`);
	}
	t(!/@example\.test/.test(weekly.html + weekly.text), "§8 the settings (recipients) are not printed");
	return out.concat(holdChecks(d), beforeAfterChecks(d));
}

// R10: the five mile metrics are held out of the digest until the user lifts
// the hold; truck utilization (its figure unchanged) is not.
const HELD = ["loaded_miles", "paid_miles", "deadhead_miles", "unloaded_miles", "paid_mile_share"];
const MONTH_MODE = {
	event: "dedicated", date: "2026-09", precision: "month", status: "insufficient",
	before: { value: 65.3, n: 52, display: "65.3%", months: ["2026-07", "2026-08"], label: "July-August 2026", dropped: ["2026-06"], coverage: { num: 49, den: 52 }, loadedLegOnly: 0, nothingOnFile: 3 },
	after: { value: null, n: 0, display: "No full month yet", months: [], label: "", dropped: [], coverage: { num: 0, den: 0 }, loadedLegOnly: 0, nothingOnFile: 0 },
	contractMonth: [{ label: "September 2026", from: "2026-09-01", to: "2026-09-30", value: 92.9, display: "92.9%", n: 50, coverage: { num: 49, den: 50 }, loadedLegOnly: 1, nothingOnFile: 0 }],
	monthToDate: { label: "October 1-14, 2026", from: "2026-10-01", to: "2026-10-14", value: 75, display: "75.0%", n: 29, coverage: { num: 27, den: 29 }, loadedLegOnly: 2, nothingOnFile: 0 },
	deltaPct: null, display: "65.3% → No full month yet", note: "Whole months.",
};
const EXACT = {
	...MONTH_MODE, date: "2026-09-15", precision: "day",
	contractMonth: [
		{ label: "September 1-14, before the start", from: "2026-09-01", to: "2026-09-14", value: 90.1, display: "90.1%", n: 20, coverage: { num: 19, den: 20 }, loadedLegOnly: 0, nothingOnFile: 1 },
		{ label: "September 15-30, from the start", from: "2026-09-15", to: "2026-09-30", value: null, display: "Not enough data", n: 30, coverage: { num: 25, den: 30 }, loadedLegOnly: 3, nothingOnFile: 2 },
	],
};
const EQUAL_WINDOWS = { event: "dedicated", date: "2026-09-01", status: "ok", before: { value: 80, n: 80, display: "80.0%" }, after: { value: 85, n: 80, display: "85.0%" }, deltaPct: 6.3, display: "80.0% → 85.0% (+5.0 pts)", note: "40 days on each side." };
function holdFixture() {
	const f = fixture();
	f.metrics.push(
		metric("truck_utilization", "Truck utilization (active days)", { display: "71.0%", beforeAfter: [EQUAL_WINDOWS] }),
		metric("paid_mile_share", "Paid-mile share (paid ÷ total ELD miles)", { display: "92.9%", beforeAfter: [MONTH_MODE] }),
		metric("loaded_miles", "Loaded miles", { display: "17,164 mi" }),
		metric("paid_miles", "Paid miles (rate confirmations)", { display: "20,669 mi" }),
		metric("deadhead_miles", "Deadhead miles", { display: "3,505 mi", status: "partial" }),
		metric("unloaded_miles", "Unloaded miles (ELD total minus loaded)", { display: "5,081 mi" }),
	);
	return f;
}
function holdChecks(d) {
	const out = [];
	const t = (cond, name) => out.push({ ok: !!cond, name });
	t(d.DIGEST_HOLD && d.DIGEST_HOLD.enabled === true && Object.isFrozen(d.DIGEST_HOLD) && Object.isFrozen(d.DIGEST_HOLD.keys), "§11 the hold is on by default, and frozen");
	t(d.DIGEST_HOLD && JSON.stringify([...d.DIGEST_HOLD.keys].sort()) === JSON.stringify([...HELD].sort()) && d.DIGEST_HOLD.keys.length === 5, "§11 the held list is exactly the five mile metrics");
	const digest = d.buildDigest({ response: holdFixture(), preview: false, asOfDay: "2026-10-14" });
	const plain = d.buildDigest({ response: fixture(), preview: false, asOfDay: "2026-10-14" });
	for (const label of ["Loaded miles", "Paid miles (rate confirmations)", "Deadhead miles", "Unloaded miles", "Paid-mile share"]) {
		t(!digest.html.includes(label) && !digest.text.includes(label), `§11 "${label}" is in neither body while the hold is on`);
	}
	t(!/17,164|20,669|3,505|5,081|92\.9%/.test(digest.html + digest.text), "§11 no held figure is printed");
	t(digest.html.includes("Truck utilization (active days)") && digest.html.includes("71.0% (September 2026)"), "§11 truck utilization is not held");
	t((digest.html.match(/<tr>/g) || []).length === fixture().metrics.length + 1, "§11 every other metric keeps its row");
	const rest = (s) => s.replace(/<tr><td[^>]*>Truck utilization \(active days\)<\/td>[\s\S]*?<\/tr>\n?/, "").replace(/Truck utilization \(active days\)\n(?: {2}.*\n)*\n/, "");
	t(rest(digest.html) === plain.html && rest(digest.text) === plain.text, "§11 the other metrics' lines are unchanged");
	return out;
}
function beforeAfterChecks(d) {
	const out = [];
	const t = (cond, name) => out.push({ ok: !!cond, name });
	const lines = typeof d.beforeAfterLines === "function" ? d.beforeAfterLines({ beforeAfter: [MONTH_MODE] }) : [];
	t(lines[0] === "Before: 65.3% (July-August 2026). Contract month: 92.9% (September 2026). After: no full month yet.", `§12 a month-mode entry: its before/after line, months named (${JSON.stringify(lines[0])})`);
	t(lines[1] === "Month to date (October 1-14, 2026): 75.0%. Loads still under way are in the total miles but not yet in the paid miles.", `§12 the month-to-date note (${JSON.stringify(lines[1])})`);
	const exact = typeof d.beforeAfterLines === "function" ? d.beforeAfterLines({ beforeAfter: [EXACT] }) : [];
	t(exact[0] === "Before: 65.3% (July-August 2026). September 1-14, before the start: 90.1%. September 15-30, from the start: not enough data. After: no full month yet.", `§12 an exact date: the two contract-month rows (${JSON.stringify(exact[0])})`);
	const equal = typeof d.beforeAfterLines === "function" ? d.beforeAfterLines({ beforeAfter: [EQUAL_WINDOWS] }) : ["x"];
	t(equal.length === 0, "§12 an equal-window entry prints no before/after line");
	// Through buildDigest, on a metric the hold does not cover.
	const f = fixture();
	f.metrics.push(metric("zed_month_mode", "Zed month-mode metric", { display: "92.9%", beforeAfter: [MONTH_MODE] }));
	const digest = d.buildDigest({ response: f, preview: false, asOfDay: "2026-10-14" });
	const row = digest.text.split("\n\n").find((b) => b.startsWith("Zed month-mode metric")) || "";
	t(/Before: 65\.3% \(July-August 2026\)\. Contract month: 92\.9% \(September 2026\)\. After: no full month yet\./.test(row) && /Month to date \(October 1-14, 2026\)/.test(row), "§12 buildDigest prints the line after the comparisons");
	t(row.indexOf("Before:") > row.indexOf("Year over year") && row.indexOf("Before:") < row.indexOf("Measured."), "§12 ...between the comparisons and the kind");
	t(!/coverage|of 52|49|nothing on file|loaded leg/i.test(row), "§12 no coverage line and no counts in the digest");
	return out;
}

let pass = 0;
const failures = [];
function record(results) {
	for (const x of results) { if (x.ok) pass++; else failures.push(x.name); }
	console.log(`  ${results.filter((x) => x.ok).length}/${results.length} checks`);
}

console.log("\n§1–§8 buildDigest()");
record(checks(loadFrom(SRC)));

// §13 With no weekly fields on the answer (KPI_WEEKLY_ENABLED off) the email is
// a693dbe2's, byte for byte: sha256 of its subjects, HTML and text on these
// fixtures, taken from that commit's lib/kpi-digest.js. Weekly blocks on the
// metrics without the answer's weekly fields change nothing either.
const OFF_DIGEST = "1aca0cf61000abe88f618c5b302ba1874a544cbfe72fd3603d7fbfa91806c601";
function offChecks(d) {
	const outs = [];
	for (const f of [fixture(), holdFixture()]) {
		for (const preview of [false, true]) {
			for (const asOfDay of ["2026-10-14", "2027-02-01", "2026-12-07"]) outs.push(d.buildDigest({ response: f, preview, asOfDay }));
		}
	}
	const sha = crypto.createHash("sha256").update(JSON.stringify(outs)).digest("hex");
	const blocksOnly = weeklyFixture();
	delete blocksOnly.weekly;
	const bare = JSON.parse(JSON.stringify(blocksOnly));
	for (const m of bare.metrics) delete m.weekly;
	const a = d.buildDigest({ response: bare, preview: false, asOfDay: "2026-11-23" });
	const b = d.buildDigest({ response: blocksOnly, preview: false, asOfDay: "2026-11-23" });
	return [
		{ ok: sha === OFF_DIGEST, name: `§13 weekly off: subject, HTML and text are a693dbe2's, byte for byte (${sha})` },
		{ ok: a.subject === b.subject && a.html === b.html && a.text === b.text && b.subject === "LogisX weekly KPIs: week of Nov 23, 2026",
			name: "§13 weekly blocks without the answer's weekly fields: today's email, no weekly section" },
	];
}

// §14 R4: the Monday email as D said.
const RULE = "Weeks run Saturday to Friday, the same week as the drivers' turns and their invoices. Load dates use the US Central calendar <b>&</b> ELD miles use each truck's local day.";
const WEEK_NOTE = "A weekly comparison is shown only where at least 90% of each week's loads have the figure; this week or the week before falls short, so it is not shown.";
const LW = { weekStart: "2026-11-14", weekEnd: "2026-11-20", label: "Nov 14-20, 2026", shortLabel: "Nov 14-20" };
const WB = { weekStart: "2026-11-07", weekEnd: "2026-11-13", label: "Nov 7-13, 2026", shortLabel: "Nov 7-13" };
const WEEK_HEAD = "Last week (Nov 14-20) against the week before (Nov 7-13)";
const MONTHLY_LATER = "Monthly figures come in the first Monday's email of each month.";
const NOT_AVAILABLE_LINE = "Weekly figures are not available this week.";
// The week in progress: never printed (D: last week against the week before).
const TO_DATE = "99,991 Zed to date";
function weekRow(w, value, display) {
	return { weekStart: w.weekStart, weekEnd: w.weekEnd, to: w.weekEnd, label: w.label, value, display, coverage: 1, partial: false };
}
function weeklyOf(cur, prev, comparison, weeks = { lw: LW, wb: WB }) {
	const current = cur ? weekRow(weeks.lw, cur[0], cur[1]) : null;
	const previous = prev ? weekRow(weeks.wb, prev[0], prev[1]) : null;
	const toDate = { weekStart: "2026-11-21", weekEnd: "2026-11-27", to: "2026-11-23", label: "Nov 21-23, 2026 (to date)", value: 99991, display: TO_DATE, coverage: null, partial: true };
	return { mode: "weekly", weekRule: RULE, series: [previous, current, toDate].filter(Boolean), current, previous, toDate, comparison };
}
const ok = (display) => ({ kind: "wow", label: "vs Nov 7-13", display, status: "ok", note: "" });
function weeklyFixture(o = {}) {
	const f = holdFixture();
	f.asOfDay = o.asOfDay || "2026-11-23";
	f.timeZone = "America/Chicago";
	f.generatedAt = o.generatedAt || `${f.asOfDay}T14:00:00.000Z`;
	f.weekly = { weekRule: RULE, approvalNote: "This approval also covers its weekly figures.", since: "2026-11-19T22:00:00.000Z", lastWeek: LW, weekBefore: WB, ...(o.weekly || {}) };
	const blocks = {
		loads_delivered: weeklyOf([14, "14"], [12, "12"], ok("+16.7%")),
		revenue: weeklyOf([27250, "$27,250"], [21000, "$21,000"], { kind: "wow", label: "vs Nov 7-13", display: "Not available", status: "withheld", note: WEEK_NOTE }),
		fuel_savings: { mode: "monthly_only", weekRule: RULE, reason: "Monthly only: fuel receipts don't line up with weeks." },
		dispatch_calls: { mode: "not_tracked", weekRule: RULE, reason: "Not tracked, so there are no weekly figures." },
		freight_tons_estimated: weeklyOf([120.5, "120.5 t"], [null, "No records"], { kind: "wow", label: "vs Nov 7-13", display: "Not available", status: "missing", note: "" }),
		co2_tonnes: weeklyOf([3.1, "3.1 t CO2"], [2.9, "2.9 t CO2"], ok("+6.9%")),
		on_time_rate: weeklyOf([80, "<i>80.0%</i>"], [74, "74.0% & up"], ok("+6.0 pts")),
		truck_utilization: weeklyOf([71, "71.4%"], [65, "65.2%"], ok("+6.2 pts")),
		loaded_miles: weeklyOf([1, "17,164 mi"], [1, "16,001 mi"], ok("+7.3%")),
		paid_miles: weeklyOf([1, "20,669 mi"], [1, "19,002 mi"], ok("+8.8%")),
		deadhead_miles: weeklyOf([1, "3,505 mi"], [1, "3,003 mi"], ok("+16.7%")),
		paid_mile_share: { mode: "monthly_only", weekRule: RULE, reason: "Monthly only: Zed held reason." },
		unloaded_miles: { mode: "monthly_only", weekRule: RULE, reason: "Monthly only: Zed held reason." },
	};
	for (const m of f.metrics) {
		m.weekly = blocks[m.key];
		m.approval = { ...m.approval, coversWeekly: false };
	}
	const by = (k) => f.metrics.find((m) => m.key === k);
	by("loads_delivered").approval = { approved: true, by: "super_admin", at: "2026-11-20T00:00:00.000Z", stale: false, coversWeekly: true };
	// Approved for its monthly figure before weekly figures began: weekly reads No.
	by("truck_utilization").approval = { approved: true, by: "super_admin", at: "2026-11-01T00:00:00.000Z", stale: false, coversWeekly: false };
	// A malformed answer: covers weekly without a monthly approval reads No.
	by("co2_tonnes").approval = { approved: false, by: null, at: null, stale: false, coversWeekly: true };
	return f;
}
// The block of lines under `label` inside `part` (a section of the text body).
function blockOf(part, label) {
	const lines = part.split("\n");
	const i = lines.indexOf(label);
	if (i < 0) return "";
	const j = lines.indexOf("", i);
	return lines.slice(i, j < 0 ? undefined : j).join("\n");
}
// The text body cut into its parts: head, weekly section, month section.
function partsOf(text) {
	const w = text.indexOf(`\n${WEEK_HEAD}\n`);
	const m = text.indexOf("\nMonth\n");
	const f = text.indexOf(`\n${FOOTER_TEXT}`);
	const end = (from) => [m, f].filter((x) => x > from).sort((a, b) => a - b)[0];
	return {
		weekly: w >= 0 ? text.slice(w + 1, end(w)) : "",
		month: m >= 0 ? text.slice(m + 1, f) : "",
	};
}
const FOOTER_TEXT = "Aggregated figures only. Do not publish a metric marked “Approved for public use: No”.";
// Today's rows (§1-§12's email) for the same metrics: the month section's body.
function todaysRows(d, response) {
	const plain = JSON.parse(JSON.stringify(response));
	delete plain.weekly;
	const today = d.buildDigest({ response: plain, preview: false, asOfDay: "2026-10-14" });
	const lines = today.text.split("\n");
	const from = lines.indexOf("", lines.findIndex((l) => l.startsWith("Figures as of") || l.startsWith("No snapshot"))) + 1;
	return { text: lines.slice(from, lines.lastIndexOf(FOOTER_TEXT)).join("\n"), trs: today.html.split("\n").filter((l) => l.startsWith("<tr>")) };
}
function monthTrs(html) {
	const at = html.indexOf(">Month</h3>");
	return at < 0 ? [] : html.slice(at).split("\n").filter((l) => l.startsWith("<tr>"));
}

function mondayChecks(d, lib) {
	const out = [];
	const t = (cond, name) => out.push({ ok: !!cond, name });
	const f = weeklyFixture();
	const mail = d.buildDigest({ response: f, preview: false, asOfDay: "2026-11-23" });
	const p = partsOf(mail.text);

	// The subject and the head.
	t(mail.subject === "LogisX weekly KPIs: Nov 14-20, 2026", `§14 the subject names last week as the server labels it (got ${JSON.stringify(mail.subject)})`);
	const yearEnd = weeklyFixture({ asOfDay: "2027-01-04", weekly: { lastWeek: { weekStart: "2026-12-26", weekEnd: "2027-01-01", label: "Dec 26, 2026-Jan 1, 2027", shortLabel: "Dec 26-Jan 1" }, weekBefore: { weekStart: "2026-12-19", weekEnd: "2026-12-25", label: "Dec 19-25, 2026", shortLabel: "Dec 19-25" } } });
	const ye = d.buildDigest({ response: yearEnd, preview: false, asOfDay: "2027-01-04" });
	t(ye.subject === "LogisX weekly KPIs: Dec 26, 2026-Jan 1, 2027" && ye.text.includes("\nLast week (Dec 26-Jan 1) against the week before (Dec 19-25)\n"),
		`§14 a week across the year end, in the subject and the section (got ${JSON.stringify(ye.subject)})`);
	t(!/week of/.test(mail.subject + mail.text + mail.html), "§14 the Monday-to-Sunday \"week of\" wording is gone");
	const pv = d.buildDigest({ response: f, preview: true, asOfDay: "2026-11-23" });
	t(pv.subject === `${PREVIEW}: LogisX weekly KPIs: Nov 14-20, 2026`, "§14 the preview mark and the \"LogisX weekly KPIs: \" start stay");
	const head = mail.text.split("\n");
	t(head[0] === "LogisX weekly KPIs: Nov 14-20, 2026" && head[1] === "Figures as of Nov 23, 2026 (America/Chicago)." && head[2] === RULE,
		`§14 title, as-of line, then the server's week rule (${JSON.stringify(head.slice(0, 3))})`);
	t(mail.text.includes(`\n${WEEK_HEAD}\n`) && mail.html.includes(`>${WEEK_HEAD}</h3>`), "§14 the section names last week and the week before, from the answer");

	// Each weekly row, the server's strings only.
	t(blockOf(p.weekly, "Loads delivered") === "Loads delivered\n  Last week (Nov 14-20): 14. Week before (Nov 7-13): 12. Change: +16.7%.\n  Measured.\n  Approved for public use (weekly figures): Yes",
		`§14 a weekly row: the three figures and the change, the kind, the weekly approval (${JSON.stringify(blockOf(p.weekly, "Loads delivered"))})`);
	t(blockOf(p.weekly, "Gross load revenue") === `Gross load revenue\n  Last week (Nov 14-20): $27,250. Week before (Nov 7-13): $21,000. ${WEEK_NOTE}\n  Measured.\n  Approved for public use (weekly figures): No`,
		"§14 a change withheld for coverage prints the server's note in its place");
	const est = blockOf(p.weekly, "Freight moved (estimated, all loads)");
	t(est === "Freight moved (estimated, all loads)\n  Last week (Nov 14-20): 120.5 t. Week before (Nov 7-13): No records. Change: Not available.\n  Estimate — Loads with no stated weight are assumed to weigh the average of loads that state one.\n  Approved for public use (weekly figures): No",
		`§14 "No records" prints as the server says, an estimate carries its assumption (${JSON.stringify(est)})`);
	t(est && !/(^|[^0-9.,])0([^0-9.,%]|$)/.test(est.replace(/Approved for public use \(weekly figures\): (Yes|No)/, "")), "§14 ...and no week shows a 0 for a missing figure");
	t(blockOf(p.weekly, "Carbon output (tailpipe CO2)").includes("\n  Estimate — no assumption is recorded.\n"), "§14 an estimate with no assumption says so");
	t(p.weekly && !/Confidence:/.test(p.weekly), "§14 the weekly section carries no confidence line");
	t(blockOf(p.weekly, "Diesel dollars saved vs baseline") === "Diesel dollars saved vs baseline\n  Monthly only: fuel receipts don't line up with weeks.",
		"§14 a monthly-only metric: the server's reason, nothing else");
	t(blockOf(p.weekly, "Dispatch calls handled by AI") === "Dispatch calls handled by AI\n  Not tracked", "§14 a not-tracked metric: Not tracked");
	t(p.weekly && !(mail.subject + mail.text + mail.html).includes(TO_DATE) && !/Nov 21-23/.test(mail.text), "§14 the week in progress is never printed");
	t(blockOf(p.weekly, "Truck utilization (active days)").endsWith("\n  Approved for public use (weekly figures): No"),
		"§14 K29: a monthly approval given before weekly figures began reads No on the weekly line");
	t(blockOf(p.weekly, "Carbon output (tailpipe CO2)").endsWith("\n  Approved for public use (weekly figures): No"), "§14 K29: weekly Yes needs the monthly approval too");
	const at = f.metrics.filter((m) => !["loaded_miles", "paid_miles", "deadhead_miles", "unloaded_miles", "paid_mile_share"].includes(m.key))
		.map((m) => p.weekly.indexOf(`\n${m.label}\n`));
	t(at.length === 8 && at.every((x, i) => x > 0 && (i === 0 || x > at[i - 1])), `§14 one weekly row per metric not on hold, in today's order (${at.join()})`);

	// The hold.
	const held = ["Loaded miles", "Paid miles (rate confirmations)", "Deadhead miles", "Unloaded miles", "Paid-mile share", "17,164", "20,669", "3,505", "Zed held reason"];
	t(p.weekly && held.every((s) => !mail.text.includes(s) && !mail.html.includes(s)), "§14 the five held metrics are in neither section");
	const firstMon = d.buildDigest({ response: weeklyFixture({ asOfDay: "2027-02-01" }), preview: false, asOfDay: "2027-02-01" });
	t(partsOf(firstMon.text).weekly && held.every((s) => !firstMon.text.includes(s) && !firstMon.html.includes(s)), "§14 ...on a first Monday too");

	// The month section: only on the first Monday of a month.
	t(!p.month && mail.text.includes(`\n${MONTHLY_LATER}\n`) && !mail.html.includes(">Month</h3>"), "§14 Monday the 23rd: no month section, one line in its place");
	const today = todaysRows(d, f);
	for (const [day, gen] of [["2027-02-01", "2027-02-02T03:00:00.000Z"], ["2026-12-07", "2026-12-08T04:00:00.000Z"]]) {
		const g = d.buildDigest({ response: weeklyFixture({ asOfDay: day, generatedAt: gen }), preview: false, asOfDay: day });
		const gp = partsOf(g.text);
		t(gp.weekly && gp.month === `Month\n\n${today.text}` && !g.text.includes(MONTHLY_LATER), `§14 Monday ${day}: the month section, byte for byte today's rows`);
		t(JSON.stringify(monthTrs(g.html)) === JSON.stringify(today.trs) && today.trs.length === 8, `§14 Monday ${day}: the HTML month rows are today's`);
	}
	for (const [day, why] of [["2027-02-08", "the 8th"], ["2026-12-01", "a Tuesday the 1st"]]) {
		const g = d.buildDigest({ response: weeklyFixture({ asOfDay: day, generatedAt: `${day}T14:00:00.000Z` }), preview: false, asOfDay: day });
		t(!partsOf(g.text).month && g.text.includes(MONTHLY_LATER), `§14 ${why} (${day}): no month section`);
	}
	const lateUtc = d.buildDigest({ response: weeklyFixture({ asOfDay: "2027-02-08", generatedAt: "2027-02-01T23:00:00.000Z" }), preview: false, asOfDay: "2027-02-08" });
	t(partsOf(lateUtc.text).weekly && !partsOf(lateUtc.text).month, "§14 the first Monday is the business day passed in, never another clock's day");

	// No current weekly figures.
	const stale = weeklyFixture({ weekly: { lastWeek: null, weekBefore: null } });
	const sm = d.buildDigest({ response: stale, preview: false, asOfDay: "2026-11-23" });
	const sp = partsOf(sm.text);
	t(sm.subject === "LogisX weekly KPIs: weekly figures not available" && sm.text.includes(`\n${NOT_AVAILABLE_LINE}\n`) && sp.month === `Month\n\n${today.text}`
		&& !sm.text.includes("Last week (") && !sm.text.includes(MONTHLY_LATER), "§14 no current weekly figures: the month section and one line, never an empty Monday");

	// The preview carries both sections.
	const pp = partsOf(pv.text);
	t(pp.weekly && pp.month === `Month\n\n${today.text}` && pv.text.split("\n")[0].startsWith(PREVIEW), "§14 the preview carries both sections");

	// HTML escaping of every new string.
	const xss = weeklyFixture({ weekly: { lastWeek: { ...LW, label: "Nov 14-20, 2026 <s>", shortLabel: "Nov 14-20 <s>" } } });
	xss.metrics.find((m) => m.key === "fuel_savings").weekly.reason = "Monthly only: <script>x</script>";
	xss.metrics.find((m) => m.key === "revenue").weekly.comparison.note = "Held <b>back</b> & 'why'";
	const xm = d.buildDigest({ response: xss, preview: true, asOfDay: "2026-11-23" });
	t(!/<script>|<s>|<b>|<i>/.test(xm.html) && xm.html.includes("&lt;script&gt;x&lt;/script&gt;") && xm.html.includes("Held &lt;b&gt;back&lt;/b&gt; &amp; &#39;why&#39;")
		&& xm.html.includes("&lt;i&gt;80.0%&lt;/i&gt;") && xm.html.includes("74.0% &amp; up") && xm.html.includes("Nov 14-20 &lt;s&gt;") && xm.html.includes("&lt;b&gt;&amp;&lt;/b&gt;"),
	"§14 every new string is HTML-escaped (the week rule, labels, figures, reasons, notes)");

	// K29 end to end: the real buildKpiResponse() over stored rows and approvals.
	if (lib) {
		const since = "2026-11-19T22:00:00.000Z";
		const rows = [];
		const keys = ["loads_delivered", "revenue", "miles_driven", "active_units"];
		for (const key of keys) {
			const base = { metric_key: key, coverage: 1, vs_label: null, vs_display: null, vs_status: null, computed_at: "2026-11-23T09:00:00.000Z" };
			rows.push({ ...base, week_start: "2026-11-07", week_end: "2026-11-13", to_day: "2026-11-13", partial: 0, label: "Nov 7-13, 2026", value: 5, display: "5" });
			rows.push({ ...base, week_start: "2026-11-14", week_end: "2026-11-20", to_day: "2026-11-20", partial: 0, label: "Nov 14-20, 2026", value: 6, display: "6", vs_label: "vs Nov 7-13", vs_display: "+20.0%", vs_status: "ok" });
			rows.push({ ...base, week_start: "2026-11-21", week_end: "2026-11-27", to_day: "2026-11-23", partial: 1, label: "Nov 21-23, 2026 (to date)", value: 1, display: "1" });
		}
		const approval = (key, at, version = 1) => ({ metric_key: key, approved: 1, definition_version: version, settings_hash: "", approved_by: "super_admin", approved_at: at });
		const answer = lib.buildKpiResponse({
			asOfDay: "2026-11-23", timeZone: "America/Chicago", generatedAt: "2026-11-23T14:00:00.000Z", settings: { recipients: [] }, snapshots: [], series: [],
			approvals: [approval("loads_delivered", since), approval("revenue", "2026-11-19T21:59:59.000Z"), approval("miles_driven", "2026-11-20T15:00:00.000Z"), approval("active_units", "2026-11-21T15:00:00.000Z", 0)],
			weekly: true, weeklyRows: rows, weeklySince: since,
		});
		const k = d.buildDigest({ response: answer, preview: false, asOfDay: "2026-11-23" });
		const kp = partsOf(k.text);
		const weeklyYes = (label) => blockOf(kp.weekly, label).endsWith("Approved for public use (weekly figures): Yes");
		t(k.subject === "LogisX weekly KPIs: Nov 14-20, 2026" && blockOf(kp.weekly, "Loads delivered").includes("Last week (Nov 14-20): 6. Week before (Nov 7-13): 5. Change: +20.0%."),
			`§14 through the real answer: last week and the week before from the stored rows (${JSON.stringify(k.subject)})`);
		t(weeklyYes("Loads delivered"), "§14 K29: an approval given at kpi.weekly_since covers the weekly figures");
		t(!weeklyYes("Gross load revenue") && blockOf(kp.weekly, "Gross load revenue").endsWith(": No"), "§14 K29: an approval given before kpi.weekly_since reads No");
		t(weeklyYes("Miles driven (ELD)"), "§14 K29: an approval given after kpi.weekly_since reads Yes");
		t(blockOf(kp.weekly, "Active units (drivers with a delivered load)").endsWith("Approved for public use (weekly figures): No"), "§14 K29: an invalid approval (an earlier definition) reads No");
	}
	return out;
}

console.log("\n§13 weekly off");
record(offChecks(loadFrom(SRC)));
console.log("\n§14 R4 the Monday email");
const LIB_METRICS = require(path.join(ROOT, "lib", "kpi-metrics.js"));
record(mondayChecks(loadFrom(SRC), LIB_METRICS));

console.log("\n§9 purity");
{
	const code = SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	record([
		{ ok: !/\brequire\(/.test(code), name: "§9 lib/kpi-digest.js requires nothing" },
		{ ok: !/process\.env/.test(code), name: "§9 ...and reads no environment" },
	]);
}

console.log("\n§10 MUTANTS");
{
	const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };
	const caught = (src) => checks(loadFrom(src)).some((x) => !x.ok);
	const mutants = [
		["the preview marker with a hyphen instead of the en dash",
			swap(SRC, `const PREVIEW_MARK = "PREVIEW – not approved for public use";`, `const PREVIEW_MARK = "PREVIEW - not approved for public use";`)],
		["the approved mark inverted",
			swap(SRC, `m.approval.approved === true ? "Yes" : "No"`, `m.approval.approved === true ? "No" : "Yes"`)],
		["escaping removed from the metric label",
			swap(SRC, "${escHtml(row.label)}", "${row.label}")],
		["missing data shown as 0",
			swap(SRC, `if (m.status === "missing") return reason ? \`Missing data — \${reason}\` : "Missing data";`, `if (m.status === "missing") return String(Number(m.value) || 0);`)],
		["an estimate without its assumption",
			swap(SRC, "return `Estimate — ${why} Confidence: ${confidence}.`;", "return `Estimate. Confidence: ${confidence}.`;")],
		["the breakdown printed (sentinel names leak)",
			swap(SRC, "details: [valueText(m), ...comparisonLines(m), ...beforeAfterLines(m), kindText(m), ...noteLines(m), approvedText(m)],",
				"details: [valueText(m), ...comparisonLines(m), ...beforeAfterLines(m), kindText(m), ...noteLines(m), ...(m.breakdown || []).map((b) => `${b.label}: ${b.display}`), approvedText(m)],")],
		["the hold switched off", swap(SRC, "\tenabled: true,\n\tkeys: Object.freeze([", "\tenabled: false,\n\tkeys: Object.freeze([")],
		["a mile metric missing from the held list", swap(SRC, "\"loaded_miles\", \"paid_miles\", \"deadhead_miles\", \"unloaded_miles\", \"paid_mile_share\"", "\"loaded_miles\", \"paid_miles\", \"unloaded_miles\", \"paid_mile_share\"")],
		["truck utilization held too", swap(SRC, "\"unloaded_miles\", \"paid_mile_share\"]),", "\"unloaded_miles\", \"paid_mile_share\", \"truck_utilization\"]),")],
		["equal-window entries printed", swap(SRC, "(b.precision !== \"month\" && b.precision !== \"day\")) continue;", "false) continue;")],
		["the month-to-date note dropped", swap(SRC, "if (mtd && line(mtd.label, 60)) out.push(", "if (false) out.push(")],
	];
	record(mutants.map(([name, src]) => ({ ok: caught(src), name: `MUTANT ${name}: caught` })));
}

if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`\n✓ ${pass} assertions passed`);
