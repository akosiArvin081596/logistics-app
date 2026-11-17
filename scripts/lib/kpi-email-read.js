"use strict";
// Reads the Monday KPI email's two bodies (lib/kpi-digest.js buildDigest()) back
// into tables, for the runners that check it. In the HTML, the data tables are
// the innermost tables (the layout tables hold them); in the text body, a table
// is the aligned block under its heading, its columns set by the dashed line. A
// note number reads " [n]" in both, as the text body writes it.
//
// Pure: no I/O.

function decode(s) {
	return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// A cell's text: lines at <br>, a note number as " [n]", tags dropped.
function cellText(h) {
	return decode(h.replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/g, " [$1]").replace(/<br>/g, "\n").replace(/<[^>]*>/g, ""));
}

// Every data table: { at, end, html, head: [cell], rows: [[cell]] }, a cell being
// { tag, style, html, text, align, span }.
function htmlTables(html) {
	const out = [];
	for (const t of String(html).matchAll(/<table\b[^>]*>(?:(?!<table\b)[\s\S])*?<\/table>/g)) {
		const rows = [...t[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((tr) => [...tr[1].matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/g)].map((c) => ({
			tag: c[1],
			style: (/style="([^"]*)"/.exec(c[2]) || [])[1] || "",
			html: c[3],
			text: cellText(c[3]),
			align: (/text-align:(left|right|center)/.exec(c[2]) || [])[1] || "",
			span: Number((/colspan="(\d+)"/.exec(c[2]) || [])[1] || 1),
		})));
		const hasHead = rows.length > 0 && rows[0].length > 0 && rows[0].every((c) => c.tag === "h");
		out.push({ at: t.index, end: t.index + t[0].length, html: t[0], head: hasHead ? rows[0] : [], rows: hasHead ? rows.slice(1) : rows });
	}
	return out;
}

// The data table under the <h2> `heading`, or null.
function htmlSection(html, heading) {
	const at = String(html).search(new RegExp(`<h2\\b[^>]*>${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h2>`));
	if (at < 0) return null;
	return htmlTables(html).find((t) => t.at > at) || null;
}

// The row whose name (its first cell's first line) is `label`, or null.
function htmlRow(table, label) {
	return (table && table.rows.find((r) => r.length && r[0].text.split("\n")[0] === label)) || null;
}

// The text of `label`'s cell in the column headed `name` (the head's first
// line); null when the row, the column or a cell starting there is missing.
function htmlCell(table, label, name) {
	const row = htmlRow(table, label);
	const at = table ? table.head.findIndex((c) => c.text.split("\n")[0] === name) : -1;
	if (!row || at < 0) return null;
	let col = 0;
	for (const c of row) {
		if (col === at) return c.span === 1 ? c.text : null;
		col += c.span;
	}
	return null;
}

// The numbered notes under the section's table, as { [n]: text }.
function htmlNotes(html, heading) {
	const t = htmlSection(html, heading);
	const out = {};
	if (!t) return out;
	const after = String(html).slice(t.end).split("\n").filter(Boolean);
	let i = 0;
	if (after[i] && /^<p\b[^>]*>Notes<\/p>$/.test(after[i])) i++;
	else return out;
	for (; i < after.length; i++) {
		const m = /^<p\b[^>]*>(\d+)\. ([\s\S]*)<\/p>$/.exec(after[i]);
		if (!m) break;
		out[m[1]] = decode(m[2]);
	}
	return out;
}

// The text table under the line `heading`: { head: [line], widths, starts,
// rows: [{ lines, cols }] }; a row starts at a line that does not start with a
// space, and `cols` is its first line split at runs of two or more spaces.
function textSection(text, heading) {
	const lines = String(text).split("\n");
	const h = lines.indexOf(heading);
	if (h < 0) return null;
	let dash = -1;
	for (let i = h + 1; i < lines.length && dash < 0; i++) {
		if (/^-+( {2}-+)*$/.test(lines[i])) dash = i;
		else if (i > h + 1 && lines[i] === heading) break;
	}
	if (dash < 0) return null;
	let top = dash;
	while (top - 1 > h && lines[top - 1] !== "") top--;
	const widths = lines[dash].split("  ").map((d) => d.length);
	const starts = widths.map((_, i) => widths.slice(0, i).reduce((a, b) => a + b, 0) + 2 * i);
	const end = lines.indexOf("", dash);
	const rows = [];
	for (const l of lines.slice(dash + 1, end < 0 ? undefined : end)) {
		if (!l.startsWith(" ") || !rows.length) rows.push([l]);
		else rows[rows.length - 1].push(l);
	}
	return {
		head: lines.slice(top, dash),
		dashLine: lines[dash],
		widths,
		starts,
		rows: rows.map((r) => ({ lines: r, cols: r[0].split(/ {2,}/) })),
		after: lines.slice(end < 0 ? lines.length : end + 1),
	};
}

function textRow(table, label) {
	return (table && table.rows.find((r) => r.cols[0] === label)) || null;
}

// The raw slice of `label`'s first line under the column headed `name`, as
// padded (so a right-aligned value has no space at its end); null when missing.
function textSlot(table, label, name) {
	const row = textRow(table, label);
	if (!row || !table.head.length) return null;
	const at = table.starts.findIndex((s, i) => table.head[0].slice(s, s + table.widths[i]).trim() === name);
	if (at < 0) return null;
	return row.lines[0].padEnd(table.starts[at] + table.widths[at]).slice(table.starts[at], table.starts[at] + table.widths[at]);
}

function textCell(table, label, name) {
	const slot = textSlot(table, label, name);
	return slot == null ? null : slot.trim();
}

// The numbered notes right after the text table, as { [n]: text }.
function textNotes(text, heading) {
	const t = textSection(text, heading);
	const out = {};
	if (!t || t.after[0] !== "Notes") return out;
	for (const l of t.after.slice(1)) {
		const m = /^(\d+)\. (.*)$/.exec(l);
		if (!m) break;
		out[m[1]] = m[2];
	}
	return out;
}

module.exports = { decode, cellText, htmlTables, htmlSection, htmlRow, htmlCell, htmlNotes, textSection, textRow, textSlot, textCell, textNotes };
