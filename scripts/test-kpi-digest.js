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
 *
 * Pure: no server, no database, no network.
 *
 * Run: node scripts/test-kpi-digest.js    # exits 1 on failure
 */
"use strict";

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
