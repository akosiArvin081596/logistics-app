"use strict";
// THE WEEKLY KPI DIGEST: one email, built from the same object
// GET /api/admin/kpis returns (lib/kpi-metrics.js buildKpiResponse()).
//
// What it prints, per metric and nothing else: the label, the figure with its
// period, the comparisons, a whole-month before/after line (only for a
// month-mode entry: paid-mile share's "Before: 65.3% (July-August 2026).
// Contract month: 92.9% (September 2026). After: no full month yet." and its
// month-to-date note; equal-window entries are never printed), what kind of
// figure it is (an estimate or a proxy with every assumption), its confidence,
// its notes, and whether it is approved for public use. It never prints a
// breakdown, a coverage description or count, the settings or the job state:
// the digest is read outside the app and forwarded, so it carries only the
// fields a person needs to decide what may be published, all of them
// aggregated figures.
//
// THE LAYOUT, the same in every form of the email: a header ("LogisX", "Weekly
// KPIs", the weeks compared, then the as-of line and the week rule in small
// grey), each section one table in one style, and a two-line footer.
//   - Figures and changes are the server's strings, right-aligned, on
//     alternating rows. A change's arrow is read off the sign the server
//     already wrote; nothing is worked out here. lib/kpi-catalog.js says of no
//     metric which way is better, so no change is coloured.
//   - An estimate or a proxy carries a marker and a numbered note under its
//     table with every assumption; a measured figure carries none.
//   - Approval is one "Public use" column, or, when no row of the table reads
//     Yes, one sentence above it. A row's Yes is that row's own approval (K29's
//     on the weekly table), so the sentence never stands in for a Yes.
//   - Rows with no figure by nature (monthly only, not tracked) sit muted at
//     the bottom of their table.
//   - Email-safe: tables and inline styles only, no image, font or link, at
//     most 640 px wide, dark text on light backgrounds only, so a mail app's
//     dark mode inverts each pair together. The text body mirrors each table
//     in aligned columns.
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
// against the week before leads; the month table comes only on the first
// Monday of a month. Without those fields the email holds the month table alone
// under "Week of <Monday>", as it did before weekly figures existed.
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
const FOOTER = "Aggregated figures only. Only figures marked “Public use: Yes” may be published.";
// The Monday slot as product-decisions.md writes it; lib/kpi-schedule.js sends at
// that moment in either business zone (8:00 Central is 9:00 Eastern).
const SEND_TIME = "Sent automatically every Monday at 8:00 AM Central.";
const BRAND = "LogisX";
const HEADING = "Weekly KPIs";
const WEEKLY_HEADING = "Weekly figures";
const MONTH_HEADING = "Monthly figures";
const NOTES_HEADING = "Notes";
const MONTHLY_LATER = "Monthly figures come in the first Monday's email of each month.";
const WEEKLY_UNAVAILABLE = "Weekly figures are not available this week.";
const WEEKLY_ALL_NO = "None of these weekly figures is approved for public use yet; approve them on the KPI page.";
const MONTH_ALL_NO = "None of these monthly figures is approved for public use yet; approve them on the KPI page.";
const NOT_AVAILABLE = "Not available";
const NOT_SHOWN = "Not shown";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Neutral colours only: dark text on white or light grey, never light text and
// never meaning carried by colour alone.
const INK = "#1f2933";
const GREY = "#52606d";
const RULE = "#d9e0e8";
const HEAD_BG = "#eef2f6";
const ZEBRA = "#f7f9fb";
const PAGE_BG = "#f2f4f7";
const CARD_BG = "#ffffff";
const BRAND_INK = "#1f3a5f";
const FONT = "Helvetica,Arial,sans-serif";
const CELL_PAD = "padding:6px";
const SMALL = `margin:2px 0 0;font-size:12px;line-height:1.45;color:${GREY}`;

// Arrows with no emoji form, so no mail app swaps them for a picture.
const ARROWS = Object.freeze({ up: "↑", down: "↓", flat: "→" });

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
	return line(m.display, 80) || line(current.display, 80) || "No data";
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

// "Nov 14-20 vs Nov 7-13, 2026": the server's labels, the year said once when
// both end in it ("Dec 26, 2026-Jan 1, 2027 vs Dec 19-25, 2026" otherwise).
function weeksLine(lastWeek, weekBefore) {
	const last = line(lastWeek.label, 60);
	if (!weekBefore) return last;
	const before = line(weekBefore.label, 60);
	const short = line(lastWeek.shortLabel, 40);
	const year = short && last.startsWith(short) ? last.slice(short.length) : "";
	return /^, \d{4}$/.test(year) && before.endsWith(year) ? `${short} vs ${before}` : `${last} vs ${before}`;
}

// A change's arrow, read off the sign the server wrote ("+16.7%", "-3.2%",
// "0.0 pts"); none for words ("Not available").
function arrowOf(display) {
	const m = /^([+\-−]?)\d/.exec(display);
	if (!m) return "";
	return m[1] === "+" ? ARROWS.up : m[1] ? ARROWS.down : ARROWS.flat;
}

// THE TABLE MODEL both bodies are drawn from. A part is a run of text with an
// optional note number (ref); a line is parts, `small` for the grey line under a
// name or a figure; a cell is lines spanning `span` columns; a table is
// { cols: [{ head: [title, sub?], align }], rows: [{ cells, quiet }], notes,
// sentence }.
const part = (text, o = {}) => ({ text: String(text), ref: o.ref || 0, grey: !!o.grey, nowrap: !!o.nowrap });
const lineOf = (parts, small = false) => ({ parts, small });
const cellOf = (lines, span = 1) => ({ lines, span });
const textCell = (text, o) => cellOf([lineOf([part(text, o)])]);

// The notes under one table, numbered in order of first use; a repeated note
// keeps its number.
function notesBook() {
	const list = [];
	return { list, ref: (text) => (list.includes(text) ? list.indexOf(text) + 1 : list.push(text)) };
}

// An estimate's or a proxy's marker; its note carries every assumption.
function kindPart(m, label, notes) {
	if (m.kind !== "estimate" && m.kind !== "proxy") return null;
	const assumptions = (Array.isArray(m.assumptions) ? m.assumptions : []).map((a) => line(a)).filter(Boolean);
	const name = KIND_TEXT[m.kind];
	return part(name, { ref: notes.ref(`${label} — ${name}: ${assumptions.length ? assumptions.join(" ") : "no assumption is recorded."}`) });
}

// The metric's name, and under it the small line of markers.
function metricCell(label, meta) {
	const lines = [lineOf([part(label)])];
	if (meta.length) lines.push(lineOf(meta.flatMap((p, i) => (i ? [part(" · "), p] : [p])), true));
	return cellOf(lines);
}

// A change: the arrow and the server's figure, or its words in grey.
function changePart(shown, ok) {
	const arrow = ok ? arrowOf(shown) : "";
	return arrow ? part(`${arrow} ${shown}`, { nowrap: true }) : part(shown, { grey: true });
}

const approvalCell = (yes) => textCell(yes ? "Yes" : "No");

// The weekly table: last week against the week before, every figure and change
// the server's own string; a figure for another week than the answer's is never
// printed.
function weeklyTable(metrics, lastWeek, weekBefore) {
	const notes = notesBook();
	const rows = [];
	const quiet = [];
	for (const m of metrics) {
		const label = line(m.label, 120) || "Unnamed metric";
		const w = m.weekly && typeof m.weekly === "object" ? m.weekly : null;
		if (w && w.mode === "monthly_only") { quiet.push({ label, text: line(w.reason) || "Monthly only" }); continue; }
		if (w && w.mode === "not_tracked") { quiet.push({ label, text: KIND_TEXT.not_tracked }); continue; }
		if (!w || w.mode !== "weekly") { rows.push({ label, text: NOT_AVAILABLE }); continue; }
		const cur = w.current && w.current.weekStart === lastWeek.weekStart ? w.current : null;
		const prev = weekBefore && w.previous && w.previous.weekStart === weekBefore.weekStart ? w.previous : null;
		const shown = (x) => line(x && x.display, 80) || NOT_AVAILABLE;
		const kind = kindPart(m, label, notes);
		const c = cur && w.comparison && typeof w.comparison === "object" ? w.comparison : null;
		const change = c && c.status === "withheld" && line(c.note)
			? part(NOT_SHOWN, { grey: true, ref: notes.ref(line(c.note)) })
			: changePart((c && line(c.display, 40)) || NOT_AVAILABLE, !!c && c.status === "ok");
		rows.push({
			label, meta: kind ? [kind] : [], figures: [shown(cur), shown(prev)], change,
			// K29: the server says whether the approval was given after weekly figures began.
			approved: !!(m.approval && m.approval.approved === true && m.approval.coversWeekly === true),
		});
	}
	const approval = rows.some((x) => x.approved === true);
	const short = (w) => line(w.shortLabel, 40);
	const cols = [
		{ head: ["Metric"], align: "left" },
		{ head: ["Last week", short(lastWeek)].filter(Boolean), align: "right" },
		{ head: ["Week before", weekBefore ? short(weekBefore) : ""].filter(Boolean), align: "right" },
		{ head: ["Change"], align: "right" },
		...(approval ? [{ head: ["Public use"], align: "left" }] : []),
	];
	const rest = cols.length - 1;
	return {
		cols,
		sentence: approval ? "" : WEEKLY_ALL_NO,
		rows: [
			...rows.map((x) => (x.figures
				? { cells: [metricCell(x.label, x.meta), ...x.figures.map((f) => textCell(f, { nowrap: true })), cellOf([lineOf([x.change])]), ...(approval ? [approvalCell(x.approved)] : [])] }
				: { cells: [metricCell(x.label, []), cellOf([lineOf([part(x.text, { grey: true })])], rest)] })),
			...quiet.map((x) => ({ quiet: true, cells: [metricCell(x.label, []), cellOf([lineOf([part(x.text)])], rest)] })),
		],
		notes: notes.list,
	};
}

// The month table: each metric's figure with its period and its comparisons;
// its kind, notes, before/after line and confidence on the line under its name.
function monthTable(metrics) {
	const notes = notesBook();
	const rows = [];
	const quiet = [];
	for (const m of metrics) {
		const label = line(m.label, 120) || "Unnamed metric";
		const approved = !!(m.approval && m.approval.approved === true);
		if (m.status === "not_tracked") { quiet.push({ label, text: valueText(m), approved }); continue; }
		const meta = [];
		const kind = kindPart(m, label, notes);
		if (kind) meta.push(kind);
		for (const w of (Array.isArray(m.warnings) ? m.warnings : []).map((x) => line(x)).filter(Boolean)) {
			meta.push(part("Note", { ref: notes.ref(`${label} — Note: ${w}`) }));
		}
		const ba = beforeAfterLines(m);
		if (ba.length) meta.push(part("Before and after", { ref: notes.ref(`${label} — ${ba.join(" ")}`) }));
		meta.push(part(`Confidence: ${CONFIDENCE_TEXT[m.confidence] || "None"}`));
		if (m.status === "missing") { rows.push({ label, meta, text: valueText(m), approved }); continue; }
		const current = m.current && typeof m.current === "object" ? m.current : {};
		const period = line(current.label, 60);
		const compared = [];
		for (const c of Array.isArray(m.comparisons) ? m.comparisons : []) {
			if (!c || typeof c !== "object") continue;
			const name = line(c.label, 80);
			if (!name) continue;
			const shown = c.status === "missing" ? "Missing data" : (line(c.display, 80) || "Missing data");
			compared.push(lineOf([part(`${name}: `, { grey: true }), changePart(shown, c.status === "ok")]));
		}
		rows.push({ label, meta, figure: valueText(m), period, compared, approved });
	}
	const approval = [...rows, ...quiet].some((x) => x.approved === true);
	const cols = [
		{ head: ["Metric"], align: "left" },
		{ head: ["Figure"], align: "right" },
		{ head: ["Compared with"], align: "left" },
		...(approval ? [{ head: ["Public use"], align: "left" }] : []),
	];
	const yes = (x) => (approval ? [approvalCell(x.approved)] : []);
	return {
		cols,
		sentence: approval ? "" : MONTH_ALL_NO,
		rows: [
			...rows.map((x) => (x.figure
				? { cells: [metricCell(x.label, x.meta), cellOf([lineOf([part(x.figure, { nowrap: true })]), ...(x.period ? [lineOf([part(x.period)], true)] : [])]), cellOf(x.compared), ...yes(x)] }
				: { cells: [metricCell(x.label, x.meta), cellOf([lineOf([part(x.text, { grey: true })])], 2), ...yes(x)] })),
			...quiet.map((x) => ({ quiet: true, cells: [metricCell(x.label, []), cellOf([lineOf([part(x.text)])], 2), ...yes(x)] })),
		],
		notes: notes.list,
	};
}

// ── The HTML body ────────────────────────────────────────────────────────────
function partHtml(p) {
	const style = [p.grey ? `color:${GREY}` : "", p.nowrap ? "white-space:nowrap" : ""].filter(Boolean).join(";");
	const body = `${escHtml(p.text)}${p.ref ? `<sup style="font-size:10px;line-height:0">${escHtml(p.ref)}</sup>` : ""}`;
	return style ? `<span style="${style}">${body}</span>` : body;
}
function lineHtml(l) {
	const body = l.parts.map(partHtml).join("");
	return l.small ? `<span style="font-size:11px;line-height:1.5;color:${GREY}">${body}</span>` : body;
}
function tableHtml(t) {
	const th = (c) => `<th scope="col" align="${c.align}" style="${CELL_PAD};text-align:${c.align};vertical-align:bottom;font-size:12px;font-weight:700;color:${GREY};background-color:${HEAD_BG};border-bottom:1px solid ${RULE}">`
		+ `${c.head.map((h, i) => (i ? `<br><span style="font-weight:400">${escHtml(h)}</span>` : escHtml(h))).join("")}</th>`;
	const rows = t.rows.map((r, i) => {
		let col = 0;
		const tds = r.cells.map((c) => {
			const align = c.span > 1 ? "left" : t.cols[col].align;
			col += c.span;
			const style = [CELL_PAD, `text-align:${align}`, "vertical-align:top", `background-color:${i % 2 ? ZEBRA : CARD_BG}`, `border-bottom:1px solid ${RULE}`, ...(r.quiet ? [`color:${GREY}`] : [])].join(";");
			return `<td${c.span > 1 ? ` colspan="${c.span}"` : ""} align="${align}" style="${style}">${c.lines.map(lineHtml).join("<br>")}</td>`;
		});
		return `<tr>${tds.join("")}</tr>`;
	});
	return [
		`<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;width:100%;font-family:${FONT};font-size:13px;line-height:1.4;color:${INK}">`,
		`<thead><tr>${t.cols.map(th).join("")}</tr></thead>`,
		"<tbody>",
		...rows,
		"</tbody>",
		"</table>",
	];
}
function sectionHtml(heading, t) {
	return [
		`<h2 style="margin:24px 0 8px;font-size:16px;line-height:1.3;font-weight:700;color:${INK}">${escHtml(heading)}</h2>`,
		...(t.sentence ? [`<p style="margin:0 0 8px;font-size:13px;line-height:1.45;color:${INK}">${escHtml(t.sentence)}</p>`] : []),
		...tableHtml(t),
		...(t.notes.length ? [
			`<p style="margin:12px 0 4px;font-size:12px;font-weight:700;color:${GREY}">${escHtml(NOTES_HEADING)}</p>`,
			...t.notes.map((n, i) => `<p style="margin:0 0 4px;font-size:12px;line-height:1.45;color:${GREY}">${i + 1}. ${escHtml(n)}</p>`),
		] : []),
	];
}

// ── The text body: each table in aligned columns ─────────────────────────────
function lineText(l) {
	return l.parts.map((p) => `${p.text}${p.ref ? ` [${p.ref}]` : ""}`).join("");
}
function tableText(t) {
	const GAP = "  ";
	const len = (s) => [...s].length;
	const cellsOf = (r) => {
		let col = 0;
		return r.cells.map((c) => {
			const at = col;
			col += c.span;
			const align = c.span > 1 ? "left" : t.cols[at].align;
			// A small line under a name is indented, so every row starts at the margin.
			return { at, span: c.span, align, lines: c.lines.map((l) => `${l.small && align === "left" ? "  " : ""}${lineText(l)}`) };
		});
	};
	const head = t.cols.map((c, at) => ({ at, span: 1, align: c.align, lines: c.head }));
	const body = t.rows.map(cellsOf);
	const width = t.cols.map(() => 0);
	for (const row of [head, ...body]) for (const c of row) if (c.span === 1) width[c.at] = Math.max(width[c.at], ...c.lines.map(len));
	const pad = (s, w, align) => (align === "right" ? `${" ".repeat(Math.max(0, w - len(s)))}${s}` : `${s}${" ".repeat(Math.max(0, w - len(s)))}`);
	const draw = (row) => {
		const out = [];
		const height = Math.max(...row.map((c) => c.lines.length));
		for (let i = 0; i < height; i++) {
			out.push(row.map((c) => pad(c.lines[i] || "", width.slice(c.at, c.at + c.span).reduce((a, b) => a + b, 0) + GAP.length * (c.span - 1), c.align)).join(GAP).trimEnd());
		}
		return out;
	};
	return [...draw(head), width.map((w) => "-".repeat(w)).join(GAP), ...body.flatMap(draw)];
}
function sectionText(heading, t) {
	return [
		heading, "",
		...(t.sentence ? [t.sentence, ""] : []),
		...tableText(t), "",
		...(t.notes.length ? [NOTES_HEADING, ...t.notes.map((n, i) => `${i + 1}. ${n}`), ""] : []),
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

	// The month table: every email without a last week (weekly figures off, or
	// not current, so none goes out empty), the preview's, and the first
	// Monday's of each month.
	const showMonth = !lastWeek || !!preview || isFirstMonday(day);
	const dateLine = !weekly ? `Week of ${weekOf || "this week"}` : (lastWeek ? weeksLine(lastWeek, weekBefore) : "");
	const rule = lastWeek ? line(weekly.weekRule, 600) : "";
	const blocks = [
		...(lastWeek ? [{ heading: WEEKLY_HEADING, table: weeklyTable(metrics, lastWeek, weekBefore) }] : []),
		...(weekly && !lastWeek ? [{ say: WEEKLY_UNAVAILABLE, style: `margin:24px 0 0;font-size:13px;line-height:1.45;color:${INK}` }] : []),
		...(showMonth ? [{ heading: MONTH_HEADING, table: monthTable(metrics) }] : [{ say: MONTHLY_LATER, style: `margin:16px 0 0;font-size:12px;line-height:1.45;color:${GREY}` }]),
	];

	const p = (text, style) => `<p style="${style}">${escHtml(text)}</p>`;
	const html = [
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;background-color:${PAGE_BG}">`,
		`<tr><td align="center" style="padding:16px 4px;background-color:${PAGE_BG}">`,
		`<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;width:100%;max-width:640px;background-color:${CARD_BG};border:1px solid ${RULE};border-radius:8px">`,
		`<tr><td align="left" style="padding:20px 12px;font-family:${FONT};font-size:13px;line-height:1.45;color:${INK};background-color:${CARD_BG};text-align:left">`,
		...(preview ? [p(banner, "margin:0 0 16px;padding:10px 12px;background-color:#fef3c7;border:1px solid #f59e0b;border-radius:6px;font-size:13px;font-weight:700;color:#92400e")] : []),
		p(BRAND, `margin:0;font-size:13px;font-weight:700;letter-spacing:1px;color:${BRAND_INK}`),
		`<h1 style="margin:4px 0 0;font-size:22px;line-height:1.25;font-weight:700;color:${INK}">${escHtml(HEADING)}</h1>`,
		...(dateLine ? [p(dateLine, `margin:2px 0 0;font-size:15px;line-height:1.4;color:${INK}`)] : []),
		p(asOfLine, `margin:10px 0 0;font-size:12px;line-height:1.45;color:${GREY}`),
		...(rule ? [p(rule, SMALL)] : []),
		...blocks.flatMap((b) => (b.table ? sectionHtml(b.heading, b.table) : [p(b.say, b.style)])),
		`<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid ${RULE};font-size:12px;line-height:1.45;color:${GREY}">${escHtml(FOOTER)}<br>${escHtml(SEND_TIME)}</p>`,
		"</td></tr>",
		"</table>",
		"</td></tr>",
		"</table>",
	].join("\n");
	const text = [
		...(preview ? [banner, ""] : []),
		BRAND,
		HEADING,
		...(dateLine ? [dateLine] : []),
		asOfLine,
		...(rule ? [rule] : []),
		"",
		...blocks.flatMap((b) => (b.table ? sectionText(b.heading, b.table) : [b.say, ""])),
		FOOTER,
		SEND_TIME,
	].join("\n");
	return { subject, html, text };
}

module.exports = { buildDigest, beforeAfterLines, escHtml, isFirstMonday, PREVIEW_MARK, FOOTER, SEND_TIME, DIGEST_HOLD };
