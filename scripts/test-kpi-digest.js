#!/usr/bin/env node
/**
 * lib/kpi-digest.js buildDigest(): the weekly KPI email, built from a
 * GET /api/admin/kpis response. The bodies are read back into tables by
 * scripts/lib/kpi-email-read.js.
 *
 * §1 subject: "LogisX weekly KPIs: week of <Monday>"; the preview's subject
 *    starts "PREVIEW – not approved for public use: " (EN DASH), the weekly
 *    one never does.
 * §2 the preview banner opens the HTML and the text, above the header; the
 *    weekly digest has none.
 * §3 approval: one "Public use" column, each row its own Yes or No (Yes only
 *    when approval.approved is exactly true); when no row reads Yes, one
 *    sentence above the table and no column; the text body the same.
 * §4 missing and not-tracked metrics say so and are never shown as 0; a
 *    not-tracked row sits muted at the bottom.
 * §5 an estimate and a proxy carry a marker and a numbered note under the
 *    table with every assumption; a measured figure carries no marker.
 * §6 the figure with its period, the comparisons with arrows from the
 *    server's sign, the notes, the confidence, the as-of line.
 * §7 every value is HTML-escaped (a made-up value with <, & and quotes in
 *    every field that reaches the email), by an escape that behaves exactly
 *    like server.js escHtml(); the footer's two lines, verbatim.
 * §8 nothing outside the printed fields leaks: sentinel names placed in the
 *    breakdown, coverage, definition, source, settings and job state of the
 *    response appear in neither the subject, the HTML nor the text.
 * §9 the module is pure: no require, no process.env.
 * §10 MUTANTS: one-change copies of the module, each caught by a check here.
 * §11 R10 hold: the five mile metrics are absent from both bodies while
 *    DIGEST_HOLD is on (the default), every other metric's row unchanged,
 *    truck utilization included; the held list is exactly those five.
 * §12 a month-mode before/after entry: one line (months named, the
 *    contract-month label or the two exact-date rows) and the month-to-date
 *    note, in a numbered note the metric's row points to; an equal-window
 *    entry prints none; no coverage line or count.
 * §13 with no weekly fields on the answer (KPI_WEEKLY_ENABLED off): the
 *    header names the week of the Monday and the month table stands alone,
 *    the same table a first Monday's month section is; weekly blocks on the
 *    metrics without the answer's weekly fields change nothing.
 * §14 R4, the weekly Monday email (the answer's weekly fields present): the
 *    subject names last week's dates; the header's "<last week> vs <week
 *    before>"; one table, Metric | Last week | Week before | Change, every
 *    figure, label and change the server's string, a withheld change shown as
 *    "Not shown" with the server's note, "No records" never a 0; monthly-only
 *    and not-tracked rows muted at the bottom; the held metrics in neither
 *    section; K29's weekly approval per metric (through the real
 *    buildKpiResponse(): an approval at, before and after kpi.weekly_since,
 *    and an invalid one); the month table only on a Monday dated the 1st to
 *    the 7th, the same rows as §13's; no last week prints the month table and
 *    one line; the preview carries both sections.
 * §15 layout: the email opens with its own viewport tag; tables and inline
 *    styles only, no image, link, font, script or style block, at most 640 px;
 *    figures right-aligned on alternating rows, kept whole while words may
 *    wrap; arrows only from the server's sign; neutral colours only
 *    (lib/kpi-catalog.js gives no metric a better direction), dark text on
 *    light backgrounds at 4.5:1 or more; the text body mirrors each HTML table
 *    in aligned columns.
 * §16 the footer's send time is the schedule's own words for the business
 *    zone (job.digestSchedule from lib/kpi-schedule.js scheduleText()): 8:00 AM
 *    Central on the Central clock, 9:00 AM Eastern on the Eastern one, the
 *    same moment; none of its own without them; the one-time preview says it
 *    is sent once.
 *
 * Pure: no server, no database, no network.
 *
 * Run: node scripts/test-kpi-digest.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");
const read = require("./lib/kpi-email-read");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "lib", "kpi-digest.js");
const SRC = fs.readFileSync(LIB, "utf8");
const SERVER = require("./lib/server-source").serverSource();
const SCHEDULE = require(path.join(ROOT, "lib", "kpi-schedule.js"));

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
const FOOTER_TEXT = "Aggregated figures only. Only figures marked “Public use: Yes” may be published.";
// The send time in the schedule's words for each business zone (lib/kpi-schedule.js scheduleText()).
const EASTERN_SEND = "Sent automatically every Monday at 9:00 AM Eastern.";
const CENTRAL_SEND = "Sent automatically every Monday at 8:00 AM Central.";
const CENTRAL_PREVIEW_SEND = "This preview is sent once, after the first snapshot; the weekly email goes out every Monday at 8:00 AM Central.";
const VIEWPORT_TAG = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">";
const MONTH_ALL_NO = "None of these monthly figures is approved for public use yet; approve them on the KPI page.";
const WEEKLY_ALL_NO = "None of these weekly figures is approved for public use yet; approve them on the KPI page.";
const GREY = "#52606d";
const ZERO_RE = /(^|[^0-9.,[])0([^0-9.,%\]]|$)/;

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
		job: { enabled: { snapshot: true, digest: true }, digestSchedule: SCHEDULE.scheduleText("America/New_York").digest, lastRun: { id: 1, kind: "nightly", status: "ok", errors: [{ metric: null, code: "Quinn Sentinel" }] } },
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

let pass = 0;
const failures = [];
function record(results) {
	for (const x of results) { if (x.ok) pass++; else failures.push(x.name); }
	console.log(`  ${results.filter((x) => x.ok).length}/${results.length} checks`);
}
// A check function that throws counts as one failed check, so a body the
// readers cannot parse fails instead of stopping the run.
function guarded(name, fn) {
	try {
		return fn();
	} catch (e) {
		return [{ ok: false, name: `${name} threw: ${String(e && e.message).split("\n")[0]}` }];
	}
}
// The meta line under a row's name (its first cell's second line), or "".
const metaOf = (row) => (row ? (row[0].text.split("\n")[1] || "") : "");
// The note number a part of a meta line or cell points to ("Estimate [2]" -> "2").
const refOf = (s, word) => ((new RegExp(`${word} \\[(\\d+)\\]`).exec(s || "") || [])[1] || "");

// §1-§8 on the email with weekly figures off.
function checks(d) {
	const out = [];
	const t = (cond, name) => out.push({ ok: !!cond, name });
	const weekly = d.buildDigest({ response: fixture(), preview: false, asOfDay: "2026-10-14" });
	const preview = d.buildDigest({ response: fixture(), preview: true, asOfDay: "2026-10-14" });
	const month = read.htmlSection(weekly.html, "Monthly figures");
	const tmonth = read.textSection(weekly.text, "Monthly figures");
	const notes = read.htmlNotes(weekly.html, "Monthly figures");
	const tnotes = read.textNotes(weekly.text, "Monthly figures");

	// §1
	t(weekly.subject === "LogisX weekly KPIs: week of Oct 12, 2026", `§1 weekly subject names the Monday of the week (got ${JSON.stringify(weekly.subject)})`);
	t(preview.subject === `${PREVIEW}: LogisX weekly KPIs: week of Oct 12, 2026`, "§1 preview subject starts with the EN-DASH preview marker");
	t(!/PREVIEW/.test(weekly.subject + weekly.html + weekly.text), "§1 the weekly digest carries no preview marker anywhere");
	t(d.buildDigest({ response: fixture(), preview: false, asOfDay: "2026-10-12" }).subject.endsWith("week of Oct 12, 2026"), "§1 on the Monday itself: that Monday");
	t(d.buildDigest({ response: fixture(), preview: false, asOfDay: "2026-10-18" }).subject.endsWith("week of Oct 12, 2026"), "§1 on the Sunday: the Monday before");

	// §2
	const firstP = preview.html.indexOf("<p");
	const brand = preview.html.indexOf(">LogisX</p>");
	t(firstP >= 0 && brand > firstP && preview.html.slice(firstP, preview.html.indexOf("</p>", firstP)).includes(PREVIEW), "§2 preview HTML opens with the banner, above the LogisX header");
	t(preview.text.split("\n")[0].startsWith(PREVIEW) && preview.text.split("\n")[2] === "LogisX", "§2 preview text opens with the banner, then the header");
	t(!weekly.html.includes("#fef3c7"), "§2 the weekly digest has no banner");

	// §3
	t(month && month.head.map((c) => c.text.split("\n")[0]).join("|") === "Metric|Figure|Compared with|Public use", `§3 the month table's columns, Public use last when a row reads Yes (${month ? month.head.map((c) => c.text).join("|") : "no table"})`);
	t(read.htmlCell(month, "Loads delivered", "Public use") === "Yes", "§3 an approved metric reads Yes");
	t(read.htmlCell(month, "Gross load revenue", "Public use") === "No", "§3 approval \"true\" (a string) reads No");
	t(read.htmlCell(month, "Freight moved (estimated, all loads)", "Public use") === "No", "§3 an unapproved metric reads No");
	t(month && month.rows.length === fixture().metrics.length && month.rows.every((r) => ["Yes", "No"].includes(r[r.length - 1].text)), "§3 every row carries its own Yes or No, the missing and not-tracked ones too");
	t(!weekly.html.includes(MONTH_ALL_NO) && !weekly.text.includes(MONTH_ALL_NO), "§3 a Yes in the table: no all-No sentence");
	t(read.textCell(tmonth, "Loads delivered", "Public use") === "Yes" && read.textCell(tmonth, "Gross load revenue", "Public use") === "No", "§3 the text body: the same column and marks");
	const none = fixture();
	for (const m of none.metrics) m.approval = { approved: false, by: null, at: null, stale: false };
	const nd = d.buildDigest({ response: none, preview: false, asOfDay: "2026-10-14" });
	const nm = read.htmlSection(nd.html, "Monthly figures");
	t(nm && !nm.head.some((c) => c.text === "Public use") && nm.rows.every((r) => !["Yes", "No"].includes(r[r.length - 1].text)), "§3 no row reads Yes: no Public use column");
	t(nm && nd.html.slice(nd.html.indexOf(">Monthly figures</h2>"), nm.at).includes(`>${MONTH_ALL_NO}</p>`), "§3 ...and the sentence above the table instead");
	const ntext = read.textSection(nd.text, "Monthly figures");
	t(ntext && nd.text.includes(`\nMonthly figures\n\n${MONTH_ALL_NO}\n\n`) && !ntext.head[0].includes("Public use"), "§3 ...in the text body too");

	// §4
	const savings = read.htmlRow(month, "Diesel dollars saved vs baseline");
	t(savings && savings[1].span === 2 && savings[1].text === "Missing data — No baseline MPG set", "§4 a missing metric says Missing data with its reason, across the figure columns");
	t(savings && !ZERO_RE.test(savings.slice(0, 2).map((c) => c.text).join(" ")), "§4 ...and shows no 0");
	const last = month && month.rows[month.rows.length - 1];
	t(last && last[0].text === "Dispatch calls handled by AI" && last[1].text === "Not tracked — No call or voice system records dispatch calls." && last.every((c) => c.style.includes(`color:${GREY}`)),
		"§4 a not-tracked metric says Not tracked, muted, in the last row");
	t(last && !ZERO_RE.test(last.slice(0, 2).map((c) => c.text).join(" ")), "§4 ...and shows no 0");
	t((read.textRow(tmonth, "Diesel dollars saved vs baseline") || { cols: [] }).cols[1] === "Missing data — No baseline MPG set", "§4 the text says Missing data too");

	// §5
	const freight = read.htmlRow(month, "Freight moved (estimated, all loads)");
	const fn = refOf(metaOf(freight), "Estimate");
	t(fn && notes[fn] === "Freight moved (estimated, all loads) — Estimate: Loads with no stated weight are assumed to weigh the average of loads that state one.",
		`§5 an estimate: its marker and a numbered note with its assumption (${JSON.stringify(metaOf(freight))})`);
	const cn = refOf(metaOf(read.htmlRow(month, "Carbon output (tailpipe CO2)")), "Estimate");
	t(cn && notes[cn] === "Carbon output (tailpipe CO2) — Estimate: no assumption is recorded.", "§5 an estimate with no assumption says so");
	t(fn && tnotes[fn] === notes[fn] && read.textRow(tmonth, "Freight moved (estimated, all loads)") && read.textRow(tmonth, "Freight moved (estimated, all loads)").lines[1].trim().startsWith(`Estimate [${fn}]`), "§5 the text shows the marker and the note too");
	t(metaOf(read.htmlRow(month, "Loads delivered")) === "Confidence: High" && !/Measured|Estimate|Proxy/.test(read.htmlRow(month, "Loads delivered").map((c) => c.text).join(" ")), "§5 a measured figure carries no marker");
	const px = fixture();
	px.metrics.push(metric("active_units", "Active units (drivers with a delivered load)", { kind: "proxy", confidence: "medium", display: "9 units", assumptions: ["Stands in for fleet size.", "Some entries may be partner carriers."] }));
	const pd = d.buildDigest({ response: px, preview: false, asOfDay: "2026-10-14" });
	const pn = refOf(metaOf(read.htmlRow(read.htmlSection(pd.html, "Monthly figures"), "Active units (drivers with a delivered load)")), "Proxy");
	t(pn && read.htmlNotes(pd.html, "Monthly figures")[pn] === "Active units (drivers with a delivered load) — Proxy: Stands in for fleet size. Some entries may be partner carriers.", "§5 a proxy: its marker and a note with every assumption");

	// §6
	t(read.htmlCell(month, "Loads delivered", "Figure") === "50\nSeptember 2026", "§6 the current figure with its period under it");
	t(read.htmlCell(month, "Loads delivered", "Compared with") === "Year over year: ↑ +31.6% (vs 38)\nMonth over month: Missing data", "§6 the comparisons, an arrow from the server's sign, a missing one said as such");
	const on = read.htmlRow(month, XSS);
	const nn = refOf(metaOf(on), "Note");
	t(nn && notes[nn] === `${XSS} — Note: Recorded appointments are not updated when a load is rescheduled; review before publishing.`, "§6 the notes, numbered under the table");
	t(weekly.html.includes(">Figures as of Oct 9, 2026 (America/New_York).</p>"), "§6 the as-of day");
	t(metaOf(freight).endsWith("Confidence: Low") && metaOf(savings).endsWith("Confidence: None"), "§6 the month's confidence on each row");

	// §7
	t(weekly.html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;quotes&#39;") && !weekly.html.includes("<script>"), "§7 a label is HTML-escaped");
	const escServer = new Function(`${SERVER.match(/\nfunction escHtml\(s\) \{[\s\S]*?\n\}\n/)[0]}\nreturn escHtml;`)();
	const samples = [XSS, `"a" <b> & 'c'`, null, undefined, 0, "plain", "–“”"];
	t(samples.every((v) => d.escHtml(v) === escServer(v)), "§7 its escape behaves exactly like server.js escHtml()");
	t(d.FOOTER === FOOTER_TEXT && weekly.html.includes(`>${d.escHtml(FOOTER_TEXT)}<br>${d.escHtml(EASTERN_SEND)}</p>`)
		&& weekly.text.endsWith(`\n${FOOTER_TEXT}\n${EASTERN_SEND}`), "§7 the footer's two lines, verbatim, last in both bodies (an Eastern business zone's words)");

	// §8
	for (const s of SENTINELS) {
		const leaks = [["subject", weekly.subject + preview.subject], ["html", weekly.html + preview.html], ["text", weekly.text + preview.text]]
			.filter(([, v]) => v.toLowerCase().includes(s.toLowerCase())).map(([k]) => k);
		t(leaks.length === 0, `§8 "${s}" appears nowhere (${leaks.join(", ") || "clean"})`);
	}
	t(!/@example\.test/.test(weekly.html + weekly.text), "§8 the settings (recipients) are not printed");
	return out;
}

// §7 every field that reaches the email carries a made-up value with <, & and
// quotes: each is escaped in the HTML and plain in the text.
const X = (n) => `Q${n}<b>&"'`;
function escapeChecks(d) {
	const out = [];
	const t = (cond, name) => out.push({ ok: !!cond, name });
	const f = weeklyFixture({
		asOfDay: "2026-12-07",
		weekly: { weekRule: `Rule ${X(1)}`, lastWeek: { ...LW, label: `Nov 14-20, 2026 ${X(2)}`, shortLabel: `Nov 14-20 ${X(3)}` }, weekBefore: { ...WB, label: `Nov 7-13, 2026 ${X(4)}`, shortLabel: `Nov 7-13 ${X(5)}` } },
	});
	f.timeZone = `America/Chicago ${X(6)}`;
	const by = (k) => f.metrics.find((m) => m.key === k);
	const loads = by("loads_delivered");
	loads.label = `Loads ${X(7)}`;
	loads.display = `50 ${X(8)}`;
	loads.current = { ...loads.current, label: `September 2026 ${X(9)}` };
	loads.comparisons = [{ kind: "mom", label: `vs August ${X(10)}`, display: `+1.0% ${X(11)}`, status: "ok" }];
	loads.warnings = [`Warning ${X(12)}`];
	loads.weekly.current.display = `14 ${X(13)}`;
	loads.weekly.previous.display = `12 ${X(14)}`;
	loads.weekly.comparison = { ...loads.weekly.comparison, display: `+16.7% ${X(15)}` };
	by("freight_tons_estimated").assumptions = [`Assumed ${X(16)}`];
	by("fuel_savings").missingReason = `No baseline ${X(17)}`;
	by("fuel_savings").weekly.reason = `Monthly only: ${X(18)}`;
	by("revenue").weekly.comparison.note = `Held back ${X(19)}`;
	by("dispatch_calls").missingReason = `No source ${X(20)}`;
	by("truck_utilization").beforeAfter = [{ ...MONTH_MODE, before: { ...MONTH_MODE.before, label: `July-August 2026 ${X(21)}` } }];
	const mail = d.buildDigest({ response: f, preview: false, asOfDay: "2026-12-07" });
	const ns = Array.from({ length: 21 }, (_, i) => i + 1);
	const missing = ns.filter((n) => !mail.html.includes(d.escHtml(X(n))));
	t(missing.length === 0, `§7 every made-up value is in the HTML, escaped (missing: ${missing.join() || "none"})`);
	const raw = ns.filter((n) => mail.html.includes(`Q${n}<b>`) || mail.html.includes(`Q${n}&lt;b&gt;&"`));
	t(raw.length === 0 && !/<b\b/i.test(mail.html), `§7 ...and none unescaped (${raw.join() || "none"})`);
	const plain = ns.filter((n) => !mail.text.includes(X(n)));
	t(plain.length === 0, `§7 the text body carries each as written (missing: ${plain.join() || "none"})`);
	return out;
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
	const month = read.htmlSection(digest.html, "Monthly figures");
	t(read.htmlCell(month, "Truck utilization (active days)", "Figure") === "71.0%\nSeptember 2026", "§11 truck utilization is not held");
	t(month && month.rows.length === fixture().metrics.length + 1, "§11 every other metric keeps its row");
	const pm = read.htmlSection(plain.html, "Monthly figures");
	const tm = read.textSection(digest.text, "Monthly figures");
	const tp = read.textSection(plain.text, "Monthly figures");
	const same = fixture().metrics.every((m) => {
		const a = read.htmlRow(month, m.label);
		const b = read.htmlRow(pm, m.label);
		const ta = read.textRow(tm, m.label);
		const tb = read.textRow(tp, m.label);
		return a && b && JSON.stringify(a.map((c) => c.text)) === JSON.stringify(b.map((c) => c.text))
			&& ta && tb && JSON.stringify(ta.lines.map((l) => l.trim().split(/ {2,}/))) === JSON.stringify(tb.lines.map((l) => l.trim().split(/ {2,}/)));
	});
	t(same && JSON.stringify(read.htmlNotes(digest.html, "Monthly figures")) === JSON.stringify(read.htmlNotes(plain.html, "Monthly figures")), "§11 the other metrics' rows and notes are unchanged");
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
	const f = holdFixture();
	f.metrics.push(metric("zed_month_mode", "Zed month-mode metric", { display: "92.9%", beforeAfter: [MONTH_MODE] }));
	const digest = d.buildDigest({ response: f, preview: false, asOfDay: "2026-10-14" });
	const month = read.htmlSection(digest.html, "Monthly figures");
	const row = read.htmlRow(month, "Zed month-mode metric");
	const n = refOf(metaOf(row), "Before and after");
	const note = read.htmlNotes(digest.html, "Monthly figures")[n] || "";
	t(note === "Zed month-mode metric — Before: 65.3% (July-August 2026). Contract month: 92.9% (September 2026). After: no full month yet. Month to date (October 1-14, 2026): 75.0%. Loads still under way are in the total miles but not yet in the paid miles.",
		`§12 buildDigest: the row points to a note with the line and the month-to-date note (${JSON.stringify(metaOf(row))})`);
	t(row && read.textNotes(digest.text, "Monthly figures")[n] === note, "§12 ...in the text body too");
	t(!/Before and after/.test(metaOf(read.htmlRow(month, "Truck utilization (active days)"))), "§12 an equal-window entry adds no marker and no note");
	t(row && !/coverage|of 52|49|nothing on file|loaded leg/i.test(row.map((c) => c.text).join(" ") + note), "§12 no coverage line and no counts in the digest");
	return out;
}

// §13 With no weekly fields on the answer (KPI_WEEKLY_ENABLED off): the header
// names the week of the Monday, and the month table stands alone, the same
// table a first Monday's month section is.
function offChecks(d) {
	const out = [];
	const t = (cond, name) => out.push({ ok: !!cond, name });
	const off = d.buildDigest({ response: holdFixture(), preview: false, asOfDay: "2026-10-14" });
	const head = off.text.split("\n");
	t(JSON.stringify(head.slice(0, 5)) === JSON.stringify(["LogisX", "Weekly KPIs", "Week of Oct 12, 2026", "Figures as of Oct 9, 2026 (America/New_York).", ""]),
		`§13 weekly off: the header names the week of the Monday (${JSON.stringify(head.slice(0, 5))})`);
	t(off.html.includes(">Week of Oct 12, 2026</p>") && read.htmlTables(off.html).length === 1 && read.htmlSection(off.html, "Monthly figures"), "§13 ...and one table, the month's");
	t(!/Weekly figures|Last week|Week before|first Monday|not available this week/.test(off.html + off.text), "§13 ...with no weekly section and no weekly line");
	// The same month table as a first Monday's, from the same metrics.
	const on = weeklyFixture({ asOfDay: "2027-02-01", generatedAt: "2027-02-02T03:00:00.000Z" });
	const bare = JSON.parse(JSON.stringify(on));
	delete bare.weekly;
	const first = d.buildDigest({ response: on, preview: false, asOfDay: "2027-02-01" });
	const alone = d.buildDigest({ response: bare, preview: false, asOfDay: "2027-02-01" });
	const tableOf = (m) => { const s = read.htmlSection(m.html, "Monthly figures"); return s ? s.html : ""; };
	const textOf = (m) => { const s = read.textSection(m.text, "Monthly figures"); return s ? [...s.head, s.dashLine, ...s.rows.flatMap((r) => r.lines)].join("\n") : ""; };
	t(tableOf(alone) && tableOf(alone) === tableOf(first) && textOf(alone) === textOf(first)
		&& JSON.stringify(read.htmlNotes(alone.html, "Monthly figures")) === JSON.stringify(read.htmlNotes(first.html, "Monthly figures")),
	"§13 the month table with weekly figures off is a first Monday's month table, byte for byte, notes included");
	// Weekly blocks on the metrics without the answer's weekly fields change nothing.
	const blocksOnly = weeklyFixture();
	delete blocksOnly.weekly;
	const stripped = JSON.parse(JSON.stringify(blocksOnly));
	for (const m of stripped.metrics) delete m.weekly;
	const a = d.buildDigest({ response: stripped, preview: false, asOfDay: "2026-11-23" });
	const b = d.buildDigest({ response: blocksOnly, preview: false, asOfDay: "2026-11-23" });
	t(a.subject === b.subject && a.html === b.html && a.text === b.text && b.subject === "LogisX weekly KPIs: week of Nov 23, 2026",
		"§13 weekly blocks without the answer's weekly fields: the email with weekly figures off, no weekly section");
	return out;
}

// §14 R4: the Monday email with weekly figures on.
const RULE = "Weeks run Saturday to Friday, the same week as the drivers' turns and their invoices. Load dates use the US Central calendar <b>&</b> ELD miles use each truck's local day.";
const WEEK_NOTE = "A weekly comparison is shown only where at least 90% of each week's loads have the figure; last week or the week before falls short, so it is not shown.";
const LW = { weekStart: "2026-11-14", weekEnd: "2026-11-20", label: "Nov 14-20, 2026", shortLabel: "Nov 14-20" };
const WB = { weekStart: "2026-11-07", weekEnd: "2026-11-13", label: "Nov 7-13, 2026", shortLabel: "Nov 7-13" };
const MONTHLY_LATER = "Monthly figures come in the first Monday's email of each month.";
const NOT_AVAILABLE_LINE = "Weekly figures are not available this week.";
// The week in progress: never printed; the email compares complete weeks only.
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
	f.job = { ...f.job, digestSchedule: SCHEDULE.scheduleText("America/Chicago").digest };
	f.generatedAt = o.generatedAt || `${f.asOfDay}T14:00:00.000Z`;
	f.weekly = { weekRule: RULE, approvalNote: "This approval also covers its weekly figures.", since: "2026-11-19T22:00:00.000Z", lastWeek: LW, weekBefore: WB, ...(o.weekly || {}) };
	const blocks = {
		loads_delivered: weeklyOf([14, "14"], [12, "12"], ok("+16.7%")),
		revenue: weeklyOf([27250, "$27,250"], [21000, "$21,000"], { kind: "wow", label: "vs Nov 7-13", display: "Not available", status: "withheld", note: WEEK_NOTE }),
		fuel_savings: { mode: "monthly_only", weekRule: RULE, reason: "Monthly only: fuel receipts don't line up with weeks." },
		dispatch_calls: { mode: "not_tracked", weekRule: RULE, reason: "Not tracked, so there are no weekly figures." },
		freight_tons_estimated: weeklyOf([120.5, "120.5 t"], [null, "No records"], { kind: "wow", label: "vs Nov 7-13", display: "Not available", status: "missing", note: "" }),
		co2_tonnes: weeklyOf([2.7, "2.7 t CO2"], [2.9, "2.9 t CO2"], ok("-6.9%")),
		on_time_rate: weeklyOf([80, "<i>80.0%</i>"], [74, "74.0% & up"], ok("+6.0 pts")),
		truck_utilization: weeklyOf([65.2, "65.2%"], [65.2, "65.2%"], ok("0.0 pts")),
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
const cellsOf = (row) => (row ? row.map((c) => c.text) : null);

function mondayChecks(d, lib) {
	const out = [];
	const t = (cond, name) => out.push({ ok: !!cond, name });
	const f = weeklyFixture();
	const mail = d.buildDigest({ response: f, preview: false, asOfDay: "2026-11-23" });
	const wt = read.htmlSection(mail.html, "Weekly figures");
	const tw = read.textSection(mail.text, "Weekly figures");
	const wnotes = read.htmlNotes(mail.html, "Weekly figures");

	// The subject and the header.
	t(mail.subject === "LogisX weekly KPIs: Nov 14-20, 2026", `§14 the subject names last week as the server labels it (got ${JSON.stringify(mail.subject)})`);
	const yearEnd = weeklyFixture({ asOfDay: "2027-01-04", weekly: { lastWeek: { weekStart: "2026-12-26", weekEnd: "2027-01-01", label: "Dec 26, 2026-Jan 1, 2027", shortLabel: "Dec 26-Jan 1" }, weekBefore: { weekStart: "2026-12-19", weekEnd: "2026-12-25", label: "Dec 19-25, 2026", shortLabel: "Dec 19-25" } } });
	const ye = d.buildDigest({ response: yearEnd, preview: false, asOfDay: "2027-01-04" });
	const yt = read.htmlSection(ye.html, "Weekly figures");
	t(ye.subject === "LogisX weekly KPIs: Dec 26, 2026-Jan 1, 2027" && ye.text.split("\n")[2] === "Dec 26, 2026-Jan 1, 2027 vs Dec 19-25, 2026"
		&& yt && yt.head[1].text === "Last week\nDec 26-Jan 1" && yt.head[2].text === "Week before\nDec 19-25",
	`§14 a week across the year end: both years in the header, the short labels on the columns (got ${JSON.stringify(ye.text.split("\n")[2])})`);
	t(!/week of/i.test(mail.subject + mail.text + mail.html), "§14 the Monday-to-Sunday \"week of\" wording is gone");
	const pv = d.buildDigest({ response: f, preview: true, asOfDay: "2026-11-23" });
	t(pv.subject === `${PREVIEW}: LogisX weekly KPIs: Nov 14-20, 2026`, "§14 the preview mark and the \"LogisX weekly KPIs: \" start stay");
	const head = mail.text.split("\n");
	t(JSON.stringify(head.slice(0, 6)) === JSON.stringify(["LogisX", "Weekly KPIs", "Nov 14-20 vs Nov 7-13, 2026", "Figures as of Nov 23, 2026 (America/Chicago).", RULE, ""]),
		`§14 the header: LogisX, Weekly KPIs, the weeks, the as-of line and the server's week rule (${JSON.stringify(head.slice(0, 5))})`);
	const at = (s) => mail.html.indexOf(s);
	const small = (s) => { const i = at(`>${s}</p>`); const open = mail.html.lastIndexOf("<p ", i); return i > 0 && /font-size:12px/.test(mail.html.slice(open, i)) && mail.html.slice(open, i).includes(`color:${GREY}`); };
	t(at(">LogisX</p>") > 0 && at(">LogisX</p>") < at(">Weekly KPIs</h1>") && at(">Weekly KPIs</h1>") < at(">Nov 14-20 vs Nov 7-13, 2026</p>")
		&& at(">Nov 14-20 vs Nov 7-13, 2026</p>") < at(">Figures as of Nov 23, 2026 (America/Chicago).</p>") && small("Figures as of Nov 23, 2026 (America/Chicago).") && small(d.escHtml(RULE)),
	"§14 the HTML header in that order, the as-of line and the week rule small and grey");
	t(!/<img\b/i.test(mail.html) && mail.html.includes(">LogisX</p>"), "§14 LogisX is text, not an image");

	// The weekly table: its columns, the server's strings only.
	t(wt && wt.head.map((c) => c.text).join("|") === "Metric|Last week\nNov 14-20|Week before\nNov 7-13|Change|Public use", `§14 the weekly table's columns (${wt ? JSON.stringify(wt.head.map((c) => c.text)) : "no table"})`);
	t(JSON.stringify(cellsOf(read.htmlRow(wt, "Loads delivered"))) === JSON.stringify(["Loads delivered", "14", "12", "↑ +16.7%", "Yes"]),
		`§14 a weekly row: last week, the week before, the change with its arrow, the weekly approval (${JSON.stringify(cellsOf(read.htmlRow(wt, "Loads delivered")))})`);
	const rev = cellsOf(read.htmlRow(wt, "Gross load revenue")) || [];
	const rn = refOf(rev[3], "Not shown");
	t(JSON.stringify(rev) === JSON.stringify(["Gross load revenue", "$27,250", "$21,000", `Not shown [${rn}]`, "No"]) && wnotes[rn] === WEEK_NOTE,
		`§14 a change withheld for coverage: "Not shown" and the server's note under the table (${JSON.stringify(rev)})`);
	const est = cellsOf(read.htmlRow(wt, "Freight moved (estimated, all loads)")) || [];
	const en = refOf(est[0], "Estimate");
	t(JSON.stringify(est) === JSON.stringify([`Freight moved (estimated, all loads)\nEstimate [${en}]`, "120.5 t", "No records", "Not available", "No"])
		&& wnotes[en] === "Freight moved (estimated, all loads) — Estimate: Loads with no stated weight are assumed to weigh the average of loads that state one.",
	`§14 "No records" as the server says it; an estimate's marker and its note (${JSON.stringify(est)})`);
	t(est.length && !ZERO_RE.test(est.slice(1).join(" ")), "§14 ...and no week shows a 0 for a missing figure");
	const co2 = cellsOf(read.htmlRow(wt, "Carbon output (tailpipe CO2)")) || [];
	t(co2[3] === "↓ -6.9%" && wnotes[refOf(co2[0], "Estimate")] === "Carbon output (tailpipe CO2) — Estimate: no assumption is recorded.", `§14 a fall reads ↓; an estimate with no assumption says so (${JSON.stringify(co2)})`);
	t((cellsOf(read.htmlRow(wt, "Truck utilization (active days)")) || [])[3] === "→ 0.0 pts" && (cellsOf(read.htmlRow(wt, XSS)) || [])[3] === "↑ +6.0 pts", "§14 no change reads →, a rise ↑");
	t(wt && !/Confidence:|Measured/.test(wt.html), "§14 the weekly table carries no confidence and no marker for a measured figure");
	const quiet = wt ? wt.rows.slice(-2) : [];
	t(JSON.stringify(quiet.map(cellsOf)) === JSON.stringify([["Diesel dollars saved vs baseline", "Monthly only: fuel receipts don't line up with weeks."], ["Dispatch calls handled by AI", "Not tracked"]])
		&& quiet.every((r) => r[1].span === 4 && r.every((c) => c.style.includes(`color:${GREY}`))), "§14 Monthly only and Not tracked: muted rows at the bottom, their words across the columns");
	t(wt && wt.rows.length > 2 && !wt.rows.slice(0, -2).some((r) => r.some((c) => c.style.includes(`color:${GREY}`))), "§14 ...and no other row is muted");
	t(!(mail.subject + mail.text + mail.html).includes(TO_DATE) && !/Nov 21-23/.test(mail.text), "§14 the week in progress is never printed");
	t(read.htmlCell(wt, "Truck utilization (active days)", "Public use") === "No", "§14 K29: a monthly approval given before weekly figures began reads No on the weekly table");
	t(read.htmlCell(wt, "Carbon output (tailpipe CO2)", "Public use") === "No", "§14 K29: weekly Yes needs the monthly approval too");
	const order = wt ? wt.rows.map((r) => r[0].text.split("\n")[0]) : [];
	t(JSON.stringify(order) === JSON.stringify(["Loads delivered", "Gross load revenue", "Freight moved (estimated, all loads)", "Carbon output (tailpipe CO2)", XSS, "Truck utilization (active days)", "Diesel dollars saved vs baseline", "Dispatch calls handled by AI"]),
		`§14 one weekly row per metric not on hold, in today's order, the muted ones last (${JSON.stringify(order)})`);
	t(tw && JSON.stringify(read.textRow(tw, "Loads delivered").cols) === JSON.stringify(["Loads delivered", "14", "12", "↑ +16.7%", "Yes"]), "§14 the text body's weekly row");

	// The all-No sentence (K29: no weekly figure approved).
	const allNo = weeklyFixture();
	allNo.metrics.find((m) => m.key === "loads_delivered").approval.coversWeekly = false;
	const an = d.buildDigest({ response: allNo, preview: false, asOfDay: "2026-11-23" });
	const anTable = read.htmlSection(an.html, "Weekly figures");
	t(anTable && anTable.head.length === 4 && anTable.rows.every((r) => !r.some((c) => ["Yes", "No"].includes(c.text)))
		&& an.html.slice(an.html.indexOf(">Weekly figures</h2>"), anTable.at).includes(`>${WEEKLY_ALL_NO}</p>`), "§14 every weekly row No: the sentence above the table, no Public use column");
	t(an.text.includes(`\nWeekly figures\n\n${WEEKLY_ALL_NO}\n\n`) && !mail.html.includes(WEEKLY_ALL_NO) && !mail.text.includes(WEEKLY_ALL_NO), "§14 ...in the text too; one Yes and there is no sentence");

	// The hold.
	const held = ["Loaded miles", "Paid miles (rate confirmations)", "Deadhead miles", "Unloaded miles", "Paid-mile share", "17,164", "20,669", "3,505", "Zed held reason"];
	t(wt && held.every((s) => !mail.text.includes(s) && !mail.html.includes(s)), "§14 the five held metrics are in neither section");
	const firstMon = d.buildDigest({ response: weeklyFixture({ asOfDay: "2027-02-01" }), preview: false, asOfDay: "2027-02-01" });
	t(read.htmlSection(firstMon.html, "Weekly figures") && held.every((s) => !firstMon.text.includes(s) && !firstMon.html.includes(s)), "§14 ...on a first Monday too");

	// The month table: only on the first Monday of a month.
	t(!read.htmlSection(mail.html, "Monthly figures") && !mail.text.split("\n").includes("Monthly figures") && mail.text.includes(`\n${MONTHLY_LATER}\n`) && mail.html.includes(`>${d.escHtml(MONTHLY_LATER)}</p>`),
		"§14 Monday the 23rd: no month table, one line in its place");
	const bare = (o) => { const x = weeklyFixture(o); delete x.weekly; return x; };
	for (const [day, gen] of [["2027-02-01", "2027-02-02T03:00:00.000Z"], ["2026-12-07", "2026-12-08T04:00:00.000Z"]]) {
		const g = d.buildDigest({ response: weeklyFixture({ asOfDay: day, generatedAt: gen }), preview: false, asOfDay: day });
		const alone = d.buildDigest({ response: bare({ asOfDay: day, generatedAt: gen }), preview: false, asOfDay: day });
		const gm = read.htmlSection(g.html, "Monthly figures");
		t(read.htmlSection(g.html, "Weekly figures") && gm && gm.at > read.htmlSection(g.html, "Weekly figures").at && gm.html === read.htmlSection(alone.html, "Monthly figures").html
			&& gm.rows.length === 8 && !g.text.includes(MONTHLY_LATER), `§14 Monday ${day}: the month table after the weekly one, the month's rows as ever`);
		t(read.textSection(g.text, "Monthly figures") && JSON.stringify(read.textSection(g.text, "Monthly figures").rows) === JSON.stringify(read.textSection(alone.text, "Monthly figures").rows), `§14 Monday ${day}: the text month table too`);
		t(read.htmlCell(gm, "Truck utilization (active days)", "Public use") === "Yes" && read.htmlCell(read.htmlSection(g.html, "Weekly figures"), "Truck utilization (active days)", "Public use") === "No",
			`§14 Monday ${day}: each table keeps its own approval rule (monthly Yes, weekly No under K29)`);
	}
	for (const [day, why] of [["2027-02-08", "the 8th"], ["2026-12-01", "a Tuesday the 1st"]]) {
		const g = d.buildDigest({ response: weeklyFixture({ asOfDay: day, generatedAt: `${day}T14:00:00.000Z` }), preview: false, asOfDay: day });
		t(!read.htmlSection(g.html, "Monthly figures") && g.text.includes(MONTHLY_LATER), `§14 ${why} (${day}): no month table`);
	}
	const lateUtc = d.buildDigest({ response: weeklyFixture({ asOfDay: "2027-02-08", generatedAt: "2027-02-01T23:00:00.000Z" }), preview: false, asOfDay: "2027-02-08" });
	t(read.htmlSection(lateUtc.html, "Weekly figures") && !read.htmlSection(lateUtc.html, "Monthly figures"), "§14 the first Monday is the business day passed in, never another clock's day");

	// No current weekly figures.
	const stale = weeklyFixture({ weekly: { lastWeek: null, weekBefore: null } });
	const sm = d.buildDigest({ response: stale, preview: false, asOfDay: "2026-11-23" });
	const sh = sm.text.split("\n");
	t(sm.subject === "LogisX weekly KPIs: weekly figures not available" && JSON.stringify(sh.slice(0, 4)) === JSON.stringify(["LogisX", "Weekly KPIs", "Figures as of Nov 23, 2026 (America/Chicago).", ""])
		&& sm.text.includes(`\n${NOT_AVAILABLE_LINE}\n`) && sm.html.includes(`>${NOT_AVAILABLE_LINE}</p>`) && read.htmlSection(sm.html, "Monthly figures")
		&& !read.htmlSection(sm.html, "Weekly figures") && !/Last week/.test(sm.text + sm.html) && !sm.text.includes(MONTHLY_LATER),
	`§14 no current weekly figures: the line and the month table, never an empty Monday (${JSON.stringify(sh.slice(0, 4))})`);
	t(sm.html.indexOf(NOT_AVAILABLE_LINE) < sm.html.indexOf(">Monthly figures</h2>"), "§14 ...the line above the month table");

	// The preview carries both sections.
	t(read.htmlSection(pv.html, "Weekly figures") && read.htmlSection(pv.html, "Monthly figures") && pv.text.split("\n")[0].startsWith(PREVIEW), "§14 the preview carries both sections");

	// HTML escaping of the weekly strings.
	const xss = weeklyFixture({ weekly: { lastWeek: { ...LW, label: "Nov 14-20, 2026 <s>", shortLabel: "Nov 14-20 <s>" } } });
	xss.metrics.find((m) => m.key === "fuel_savings").weekly.reason = "Monthly only: <script>x</script>";
	xss.metrics.find((m) => m.key === "revenue").weekly.comparison.note = "Held <b>back</b> & 'why'";
	const xm = d.buildDigest({ response: xss, preview: true, asOfDay: "2026-11-23" });
	const lowerHtml = xm.html.toLowerCase();
	t(!["<script", "<s>", "<b>", "<i>"].some((tag) => lowerHtml.includes(tag)) && xm.html.includes("&lt;script&gt;x&lt;/script&gt;") && xm.html.includes("Held &lt;b&gt;back&lt;/b&gt; &amp; &#39;why&#39;")
		&& xm.html.includes("&lt;i&gt;80.0%&lt;/i&gt;") && xm.html.includes("74.0% &amp; up") && xm.html.includes("Nov 14-20 &lt;s&gt;") && xm.html.includes("&lt;b&gt;&amp;&lt;/b&gt;"),
	"§14 every weekly string is HTML-escaped (the week rule, labels, figures, reasons, notes)");

	// K29 end to end: the real buildKpiResponse() over stored rows and approvals.
	if (lib) {
		const since = "2026-11-19T22:00:00.000Z";
		const rows = [];
		const keys = ["loads_delivered", "revenue", "miles_driven", "active_units"];
		for (const key of keys) {
			const base = { metric_key: key, coverage: 1, vs_label: null, vs_display: null, vs_status: null, computed_at: "2026-11-23T09:00:00.000Z" };
			rows.push({ ...base, week_start: "2026-11-07", week_end: "2026-11-13", to_day: "2026-11-13", partial: 0, label: "Nov 7-13, 2026", value: 5, display: "5" });
			// Revenue's change is held back for coverage: the server's own note stands in for it.
			const vs = key === "revenue" ? { vs_display: "Not available", vs_status: "withheld" } : { vs_display: "+20.0%", vs_status: "ok" };
			rows.push({ ...base, week_start: "2026-11-14", week_end: "2026-11-20", to_day: "2026-11-20", partial: 0, label: "Nov 14-20, 2026", value: 6, display: "6", vs_label: "vs Nov 7-13", ...vs });
			rows.push({ ...base, week_start: "2026-11-21", week_end: "2026-11-27", to_day: "2026-11-23", partial: 1, label: "Nov 21-23, 2026 (to date)", value: 1, display: "1" });
		}
		const approval = (key, stamp, version = 1) => ({ metric_key: key, approved: 1, definition_version: version, settings_hash: "", approved_by: "super_admin", approved_at: stamp });
		const answer = lib.buildKpiResponse({
			asOfDay: "2026-11-23", timeZone: "America/Chicago", generatedAt: "2026-11-23T14:00:00.000Z", settings: { recipients: [] }, snapshots: [], series: [],
			approvals: [approval("loads_delivered", since), approval("revenue", "2026-11-19T21:59:59.000Z"), approval("miles_driven", "2026-11-20T15:00:00.000Z"), approval("active_units", "2026-11-21T15:00:00.000Z", 0)],
			weekly: true, weeklyRows: rows, weeklySince: since,
		});
		const k = d.buildDigest({ response: answer, preview: false, asOfDay: "2026-11-23" });
		const kt = read.htmlSection(k.html, "Weekly figures");
		t(k.subject === "LogisX weekly KPIs: Nov 14-20, 2026" && JSON.stringify((cellsOf(read.htmlRow(kt, "Loads delivered")) || []).slice(1, 4)) === JSON.stringify(["6", "5", "↑ +20.0%"]),
			`§14 through the real answer: last week and the week before from the stored rows (${JSON.stringify(cellsOf(read.htmlRow(kt, "Loads delivered")))})`);
		t(read.htmlCell(kt, "Loads delivered", "Public use") === "Yes", "§14 K29: an approval given at kpi.weekly_since covers the weekly figures");
		t(read.htmlCell(kt, "Gross load revenue", "Public use") === "No", "§14 K29: an approval given before kpi.weekly_since reads No");
		t(read.htmlCell(kt, "Miles driven (ELD)", "Public use") === "Yes", "§14 K29: an approval given after kpi.weekly_since reads Yes");
		t(read.htmlCell(kt, "Active units (drivers with a delivered load)", "Public use") === "No", "§14 K29: an invalid approval (an earlier definition) reads No");
		// The email compares last week with the week before, so the note names those two weeks.
		const heldRev = cellsOf(read.htmlRow(kt, "Gross load revenue")) || [];
		const hn = refOf(heldRev[3], "Not shown");
		const heldNote = read.htmlNotes(k.html, "Weekly figures")[hn] || "";
		t(JSON.stringify(heldRev.slice(1, 3)) === JSON.stringify(["6", "5"]) && heldNote === WEEK_NOTE && !heldNote.toLowerCase().includes("this week"),
			`§14 the server's held-back note names last week and the week before, never "this week" (${JSON.stringify(heldNote)})`);
	}
	return out;
}

// §15 layout, over every form of the email.
function hexRgb(h) {
	const s = h.length === 4 ? h.slice(1).split("").map((c) => c + c).join("") : h.slice(1);
	return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
function luminance(h) {
	const [r, g, b] = hexRgb(h).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
// Red or green: a saturated colour whose hue is near 0 or 120 degrees.
function redOrGreen(h) {
	const [r, g, b] = hexRgb(h).map((v) => v / 255);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
	if (s < 0.3) return false;
	let hue = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
	hue = (hue * 60 + 360) % 360;
	return hue < 15 || hue > 340 || (hue > 80 && hue < 170);
}
function forms(d) {
	return {
		off: d.buildDigest({ response: holdFixture(), preview: false, asOfDay: "2026-10-14" }),
		monday: d.buildDigest({ response: weeklyFixture(), preview: false, asOfDay: "2026-11-23" }),
		first: d.buildDigest({ response: weeklyFixture({ asOfDay: "2026-12-07", generatedAt: "2026-12-07T14:00:00.000Z" }), preview: false, asOfDay: "2026-12-07" }),
		unavailable: d.buildDigest({ response: weeklyFixture({ weekly: { lastWeek: null, weekBefore: null } }), preview: false, asOfDay: "2026-11-23" }),
	};
}
function layoutChecks(d) {
	const out = [];
	const t = (cond, name) => out.push({ ok: !!cond, name });
	const all = forms(d);
	const preview = d.buildDigest({ response: weeklyFixture(), preview: true, asOfDay: "2026-11-23" });
	for (const [name, m] of [...Object.entries(all), ["preview", preview]]) {
		const h = m.html;
		t(!/<img\b|<link\b|<style\b|<script\b|<iframe\b|<form\b|<svg\b|@import|@font-face|url\(|\bclass=|\bsrc=|\bhref=/i.test(h) && !/http/i.test(h), `§15 ${name}: no image, link, font, script, style block or class; no "http" anywhere`);
		const widths = [...h.matchAll(/width="(\d+)"/g), ...h.matchAll(/width:(\d+)px/g)].map((x) => Number(x[1]));
		t(h.includes("max-width:640px") && widths.every((w) => w <= 640), `§15 ${name}: at most 640 px wide (${widths.join(",")})`);
		t((h.match(/<table\b/g) || []).length === (h.match(/<\/table>/g) || []).length && (h.match(/<tr\b/g) || []).length === (h.match(/<\/tr>/g) || []).length, `§15 ${name}: every table and row closed`);
		t(h.startsWith(`${VIEWPORT_TAG}\n`), `§15 ${name}: the email itself opens with the viewport tag, so a phone lays it out at its own width`);
	}
	// Colours: neutral, dark text on light backgrounds, 4.5:1 or more.
	const html = Object.values(all).map((m) => m.html).join("\n");
	const hexes = [...new Set((html.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || []).map((x) => x.toLowerCase()))];
	t(hexes.length > 0 && !hexes.some(redOrGreen), `§15 no green or red anywhere: the catalog says of no metric which way is better (${hexes.filter(redOrGreen).join(",") || "none"})`);
	const texts = [...new Set([...html.matchAll(/(?<![-\w])color:(#[0-9a-fA-F]{3,6})\b/g)].map((x) => x[1].toLowerCase()))];
	const backs = [...new Set([...html.matchAll(/background-color:(#[0-9a-fA-F]{3,6})\b/g)].map((x) => x[1].toLowerCase()))];
	t(texts.every((c) => luminance(c) <= 0.2) && backs.every((c) => luminance(c) >= 0.8), `§15 dark text on light backgrounds only, so a dark mode inverts them as pairs (text ${texts.join(",")}; backgrounds ${backs.join(",")})`);
	const worst = Math.min(...texts.flatMap((c) => backs.map((b) => (luminance(b) + 0.05) / (luminance(c) + 0.05))));
	t(worst >= 4.5, `§15 every text colour on every background at 4.5:1 or more (lowest ${worst.toFixed(2)})`);
	// The weekly table: right-aligned figures, alternating rows, changes uncoloured.
	const wt = read.htmlSection(all.monday.html, "Weekly figures");
	t(wt && wt.head.map((c) => c.align).join() === "left,right,right,right,left" && wt.rows.filter((r) => r.length === 5).every((r) => r.map((c) => c.align).join() === "left,right,right,right,left"),
		"§15 the weekly table: figures and changes right-aligned, names and Public use left");
	const backOf = (c) => (/background-color:(#[0-9a-fA-F]{3,6})/.exec(c.style) || [])[1] || "";
	t(wt && wt.rows.length > 2 && wt.rows.every((r, i) => r.every((c) => backOf(c) === backOf(wt.rows[i % 2][0]))) && backOf(wt.rows[0][0]) !== backOf(wt.rows[1][0]), "§15 ...on alternating rows");
	t(wt && wt.rows.every((r) => !r[3] || !/color:#(?!52606d)/i.test(r[3].html)), "§15 ...a change in neutral text, grey only for words");
	const mt = read.htmlSection(all.first.html, "Monthly figures");
	t(mt && mt.head.map((c) => c.align).join() === "left,right,left,left" && mt.rows.length > 2 && backOf(mt.rows[0][0]) !== backOf(mt.rows[1][0]), "§15 the month table in the same style: its figure right-aligned, alternating rows");
	// L5: a figure never breaks from its unit; words ("No records", "No data") may wrap on a phone.
	const isFigure = (s) => /^[+\-−]?\$?\d/.test(s);
	const figureCells = [
		...(wt ? wt.rows.filter((r) => r.length === 5).flatMap((r) => [r[1], r[2]]) : []),
		...(mt ? mt.rows.filter((r) => r.length === 4 && r[1].span === 1).map((r) => r[1]) : []),
	].map((c) => ({ text: c.text.split("\n")[0], nowrap: /white-space:nowrap/.test(c.html.split("<br>")[0]) }));
	const words = figureCells.filter((c) => !isFigure(c.text));
	t(words.length > 0 && figureCells.length > words.length && figureCells.every((c) => c.nowrap === isFigure(c.text)),
		`§15 figures kept whole, words free to wrap (words: ${JSON.stringify(words.map((c) => [c.text, c.nowrap]))})`);
	// The text body mirrors each HTML table, in aligned columns.
	for (const [name, m, heading] of [["weekly", all.monday, "Weekly figures"], ["first Monday's month", all.first, "Monthly figures"], ["off", all.off, "Monthly figures"]]) {
		const ht = read.htmlSection(m.html, heading);
		const tt = read.textSection(m.text, heading);
		const mirrored = ht && tt && ht.rows.length === tt.rows.length && ht.rows.every((r, i) => {
			const firsts = r.map((c) => c.text.split("\n")[0]).filter(Boolean);
			const rest = r.flatMap((c) => c.text.split("\n").slice(1)).filter(Boolean).sort();
			const trest = tt.rows[i].lines.slice(1).flatMap((l) => l.trim().split(/ {2,}/)).filter(Boolean).sort();
			return JSON.stringify(tt.rows[i].cols) === JSON.stringify(firsts) && JSON.stringify(trest) === JSON.stringify(rest);
		});
		t(mirrored, `§15 the text body mirrors the ${name} table, row for row and cell for cell`);
		t(tt && JSON.stringify(tt.head[0].trim().split(/ {2,}/)) === JSON.stringify(ht.head.map((c) => c.text.split("\n")[0])), `§15 ...under the same column heads (${tt ? JSON.stringify(tt.head[0]) : "no table"})`);
	}
	const tw = read.textSection(all.monday.text, "Weekly figures");
	const slots = ["Last week", "Week before", "Change"].map((c) => read.textSlot(tw, "Loads delivered", c));
	t(slots.every((s) => s && s.trim() && !s.endsWith(" ")) && read.textSlot(tw, "Loads delivered", "Public use").startsWith("Yes"),
		`§15 the text columns: figures and changes flush right under their heads, Public use flush left (${JSON.stringify(slots)})`);
	const headSlot = (i) => (tw && tw.head[1] ? tw.head[1].padEnd(tw.starts[i] + tw.widths[i]).slice(tw.starts[i], tw.starts[i] + tw.widths[i]) : "");
	t(headSlot(1).trim() === "Nov 14-20" && !headSlot(1).endsWith(" ") && headSlot(2).trim() === "Nov 7-13" && !headSlot(2).endsWith(" "),
		`§15 ...the week dates flush right under their heads (${JSON.stringify([headSlot(1), headSlot(2)])})`);
	return out;
}

// §16 the footer's send time is the schedule's own words for the business zone.
function sendTimeChecks(d) {
	const out = [];
	const t = (cond, name) => out.push({ ok: !!cond, name });
	const central = SCHEDULE.scheduleText("America/Chicago").digest;
	const eastern = SCHEDULE.scheduleText("America/New_York").digest;
	t(central === "Mondays at 8:00 AM Central" && eastern === "Mondays at 9:00 AM Eastern", `§16 the schedule's words (${JSON.stringify([central, eastern])})`);
	const on = (job, preview = false) => d.buildDigest({ response: { ...weeklyFixture(), job }, preview, asOfDay: "2026-11-23" });
	const last = (m) => m.text.split("\n").pop();
	const c = on({ digestSchedule: central });
	t(last(c) === CENTRAL_SEND && c.html.includes(`<br>${d.escHtml(CENTRAL_SEND)}</p>`), `§16 a Central business zone (production): "${CENTRAL_SEND}" (got ${JSON.stringify(last(c))})`);
	const e = on({ digestSchedule: eastern });
	t(last(e) === EASTERN_SEND && e.html.includes(`<br>${d.escHtml(EASTERN_SEND)}</p>`), `§16 an Eastern business zone: "${EASTERN_SEND}" (got ${JSON.stringify(last(e))})`);
	t(last(on({})) === "Sent automatically every Monday.", "§16 no schedule words: no time of the email's own");
	const pv = on({ digestSchedule: central }, true);
	t(last(pv) === CENTRAL_PREVIEW_SEND && pv.html.includes(`<br>${d.escHtml(CENTRAL_PREVIEW_SEND)}</p>`) && !/Sent automatically/.test(pv.html + pv.text),
		`§16 L4: the one-time preview says it is sent once, not that it went out on the Monday schedule (got ${JSON.stringify(last(pv))})`);
	const same = ["2026-11-23T12:00:00Z", "2027-07-05T12:00:00Z"].every((iso) => {
		const ms = Date.parse(iso);
		return SCHEDULE.digestSlot(ms, "America/New_York").slotMs === SCHEDULE.digestSlot(ms, "America/Chicago").slotMs;
	});
	t(same, "§16 the two zones' words name the same moment, in winter and in summer");
	return out;
}

function allChecks(d, lib) {
	return [
		...guarded("§1-§8", () => checks(d)),
		...guarded("§7", () => escapeChecks(d)),
		...guarded("§11", () => holdChecks(d)),
		...guarded("§12", () => beforeAfterChecks(d)),
		...guarded("§13", () => offChecks(d)),
		...guarded("§14", () => mondayChecks(d, lib)),
		...guarded("§15", () => layoutChecks(d)),
		...guarded("§16", () => sendTimeChecks(d)),
	];
}

const LIB_METRICS = require(path.join(ROOT, "lib", "kpi-metrics.js"));
const D = loadFrom(SRC);
console.log("\n§1–§8 buildDigest()");
record(guarded("§1-§8", () => checks(D)));
console.log("\n§7 every value escaped");
record(guarded("§7", () => escapeChecks(D)));
console.log("\n§11 the hold");
record(guarded("§11", () => holdChecks(D)));
console.log("\n§12 before and after");
record(guarded("§12", () => beforeAfterChecks(D)));
console.log("\n§13 weekly off");
record(guarded("§13", () => offChecks(D)));
console.log("\n§14 R4 the Monday email");
record(guarded("§14", () => mondayChecks(D, LIB_METRICS)));
console.log("\n§15 layout");
record(guarded("§15", () => layoutChecks(D)));
console.log("\n§16 the send time");
record(guarded("§16", () => sendTimeChecks(D)));

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
	// A one-change copy of the module; null when the anchor is not in the source.
	const swap = (src, from, to) => (src.includes(from) ? src.replace(from, to) : null);
	// The first check a mutant fails; "" when it passes them all or does not load.
	const caughtBy = (src) => {
		let d;
		try {
			d = loadFrom(src);
		} catch {
			return "";
		}
		const miss = allChecks(d, LIB_METRICS).find((x) => !x.ok);
		return miss ? miss.name.split(" (")[0] : "";
	};
	const verdict = ([name, src]) => {
		const by = src === null ? "" : caughtBy(src);
		return { ok: !!by, name: `MUTANT ${name}: ${src === null ? "anchor not found" : by ? `caught by "${by}"` : "NOT caught"}` };
	};
	const mutants = [
		["the preview marker with a hyphen instead of the en dash",
			swap(SRC, "const PREVIEW_MARK = \"PREVIEW – not approved for public use\";", "const PREVIEW_MARK = \"PREVIEW - not approved for public use\";")],
		["the monthly approval inverted",
			swap(SRC, "const approved = !!(m.approval && m.approval.approved === true);", "const approved = !(m.approval && m.approval.approved === true);")],
		["every cell unescaped",
			swap(SRC, "const body = `${escHtml(p.text)}", "const body = `${p.text}")],
		["one cell unescaped (the week under a column head)",
			swap(SRC, "`<br><span style=\"font-weight:400\">${escHtml(h)}</span>`", "`<br><span style=\"font-weight:400\">${h}</span>`")],
		["a note unescaped",
			swap(SRC, "${i + 1}. ${escHtml(n)}</p>", "${i + 1}. ${n}</p>")],
		["missing data shown as 0",
			swap(SRC, "if (m.status === \"missing\") return reason ? `Missing data — ${reason}` : \"Missing data\";", "if (m.status === \"missing\") return String(Number(m.value) || 0);")],
		["an estimate without its assumption",
			swap(SRC, "assumptions.length ? assumptions.join(\" \") : \"no assumption is recorded.\"", "assumptions.length ? \"see the KPI page.\" : \"no assumption is recorded.\"")],
		["a note missing for an estimate",
			swap(SRC, "return part(name, { ref: notes.ref(", "return part(name, { ref: 0 && notes.ref(")],
		["the breakdown printed (sentinel names leak)",
			swap(SRC, "const ba = beforeAfterLines(m);", "const ba = [...beforeAfterLines(m), ...(Array.isArray(m.breakdown) ? m.breakdown : []).map((b) => `${b.label}: ${b.display}`)];")],
		["the hold switched off", swap(SRC, "\tenabled: true,\n\tkeys: Object.freeze([", "\tenabled: false,\n\tkeys: Object.freeze([")],
		["a mile metric missing from the held list", swap(SRC, "\"loaded_miles\", \"paid_miles\", \"deadhead_miles\", \"unloaded_miles\", \"paid_mile_share\"", "\"loaded_miles\", \"paid_miles\", \"unloaded_miles\", \"paid_mile_share\"")],
		["truck utilization held too", swap(SRC, "\"unloaded_miles\", \"paid_mile_share\"]),", "\"unloaded_miles\", \"paid_mile_share\", \"truck_utilization\"]),")],
		["equal-window entries printed", swap(SRC, "(b.precision !== \"month\" && b.precision !== \"day\")) continue;", "false) continue;")],
		["the month-to-date note dropped", swap(SRC, "if (mtd && line(mtd.label, 60)) out.push(", "if (false) out.push(")],
		["the confidence dropped from the month table", swap(SRC, "meta.push(part(`Confidence: ${CONFIDENCE_TEXT[m.confidence] || \"None\"}`));", "void 0;")],
		["the all-No sentence shown when one weekly figure is Yes", swap(SRC, "sentence: approval ? \"\" : WEEKLY_ALL_NO,", "sentence: WEEKLY_ALL_NO,")],
		["the weekly approval column dropped when approvals are mixed", swap(SRC, "const approval = rows.some((x) => x.approved === true);", "const approval = rows.every((x) => x.approved === true);")],
		["the month approval column dropped when approvals are mixed", swap(SRC, "const approval = [...rows, ...quiet].some((x) => x.approved === true);", "const approval = [...rows, ...quiet].every((x) => x.approved === true);")],
		["the monthly approval on the weekly table (K29 ignored)", swap(SRC, "m.approval.approved === true && m.approval.coversWeekly === true", "m.approval.approved === true")],
		["the arrow reversed", swap(SRC, "return m[1] === \"+\" ? ARROWS.up : m[1] ? ARROWS.down : ARROWS.flat;", "return m[1] === \"+\" ? ARROWS.down : m[1] ? ARROWS.up : ARROWS.flat;")],
		["green on a fall, which the catalog never calls better", swap(SRC, "p.nowrap ? \"white-space:nowrap\" : \"\"]", "p.nowrap ? \"white-space:nowrap\" : \"\", p.text.startsWith(ARROWS.down) ? \"color:#15803d\" : \"\"]")],
		["a fixed send time instead of the schedule's words", swap(SRC, "const at = (/^Mondays at (.+)$/.exec(words) || [])[1] || \"\";", "const at = \"9:00 AM Eastern\";")],
		["the preview footer claiming the Monday schedule (L4)", swap(SRC, "if (preview) return `This preview", "if (false) return `This preview")],
		["the footer's figures line dropped", swap(SRC, "${escHtml(FOOTER)}<br>${escHtml(send)}", "${escHtml(send)}")],
		["words kept from wrapping like figures (L5)", swap(SRC, "textCell(f, { nowrap: FIGURE_RE.test(f) })", "textCell(f, { nowrap: true })")],
		["the email without its viewport tag (M1)", swap(SRC, "const html = [\n\t\tVIEWPORT,\n", "const html = [\n")],
		["no alternating rows", swap(SRC, "`background-color:${i % 2 ? ZEBRA : CARD_BG}`", "`background-color:${CARD_BG}`")],
		["last week's figures left-aligned", swap(SRC, "{ head: [\"Last week\", short(lastWeek)].filter(Boolean), align: \"right\" },", "{ head: [\"Last week\", short(lastWeek)].filter(Boolean), align: \"left\" },")],
		["the muted rows not muted", swap(SRC, "...quiet.map((x) => ({ quiet: true, cells: [metricCell(x.label, []), cellOf([lineOf([part(x.text)])], rest)] })),", "...quiet.map((x) => ({ quiet: false, cells: [metricCell(x.label, []), cellOf([lineOf([part(x.text)])], rest)] })),")],
		["a monthly-only row in place, not at the bottom", swap(SRC, "if (w && w.mode === \"monthly_only\") { quiet.push(", "if (w && w.mode === \"monthly_only\") { rows.push(")],
		["the text columns padded on the wrong side", swap(SRC, "const pad = (s, w, align) => (align === \"right\" ?", "const pad = (s, w, align) => (align === \"none\" ?")],
		["a wider email", swap(SRC, "max-width:640px", "max-width:680px")],
		["a remote logo", swap(SRC, "p(BRAND, `margin:0;font-size:13px;font-weight:700;letter-spacing:1px;color:${BRAND_INK}`),", "`<img src=\"https://logo.example.test/logo.png\" alt=\"LogisX\">`,")],
		["the year said twice in the header", swap(SRC, "return /^, \\d{4}$/.test(year) && before.endsWith(year)", "return false && before.endsWith(year)")],
	];
	const results = mutants.map(verdict);
	record(results);

	// §13 and §14's own.
	const monday = [
		["a Monday-based week in the subject", swap(SRC, "(lastWeek ? `LogisX weekly KPIs: ${line(lastWeek.label, 60)}`", "(lastWeek ? `LogisX weekly KPIs: week of ${weekOf}`")],
		["the month table every Monday", swap(SRC, "const showMonth = !lastWeek || !!preview || isFirstMonday(day);", "const showMonth = true;")],
		["the first Monday read off the UTC day", swap(SRC, "const showMonth = !lastWeek || !!preview || isFirstMonday(day);", "const showMonth = !lastWeek || !!preview || isFirstMonday(String(r.generatedAt || \"\").slice(0, 10));")],
		["a held metric in the weekly table", swap(SRC, "table: weeklyTable(metrics, lastWeek, weekBefore)", "table: weeklyTable((Array.isArray(r.metrics) ? r.metrics : []).filter((m) => m && typeof m === \"object\"), lastWeek, weekBefore)")],
		["the week-before figure worked out in the email", swap(SRC, "figures: [shown(cur), shown(prev)]", "figures: [shown(cur), prev && Number.isFinite(prev.value) ? String(prev.value) : NOT_AVAILABLE]")],
		["a withheld change printed as a change", swap(SRC, "const change = c && c.status === \"withheld\" && line(c.note)", "const change = false")],
		["the week in progress printed as last week", swap(SRC, "const cur = w.current && w.current.weekStart === lastWeek.weekStart ? w.current : null;", "const cur = w.toDate || w.current;")],
		["no month table when last week is missing", swap(SRC, "const showMonth = !lastWeek || !!preview || isFirstMonday(day);", "const showMonth = !!preview || isFirstMonday(day);")],
		["the preview without the month table", swap(SRC, "const showMonth = !lastWeek || !!preview || isFirstMonday(day);", "const showMonth = !lastWeek || isFirstMonday(day);")],
		["the week rule not escaped", swap(SRC, "...(rule ? [p(rule, SMALL)] : []),", "...(rule ? [`<p style=\"${SMALL}\">${rule}</p>`] : []),")],
		["the not-available line with weekly figures off", swap(SRC, "...(weekly && !lastWeek ? [{ say: WEEKLY_UNAVAILABLE", "...(!lastWeek ? [{ say: WEEKLY_UNAVAILABLE")],
		["no week line with weekly figures off", swap(SRC, "const dateLine = !weekly ? `Week of ${weekOf || \"this week\"}`", "const dateLine = !weekly ? \"\"")],
	];
	const mondayResults = monday.map(([name, src]) => verdict([`§13/§14 ${name}`, src]));
	record(mondayResults);
	for (const x of [...results, ...mondayResults]) console.log(`    ${x.ok ? "✓" : "✗"} ${x.name}`);
}

if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`\n✓ ${pass} assertions passed`);
