// The Google Sheets API, answered from a local working copy: what a replica
// (lib/replica-mode.js) uses in place of the googleapis client, so it never
// constructs a Google client, never reads a key file and never opens a
// connection for a sheet.
//
// The working copy is the JSON `npm run replica:pull` exports from production
// (scripts/replica/remote/sheets-export.js): every tab of the spreadsheets the
// app reads, as Google displays them (FORMATTED_VALUE), plus each formula and
// each tab's properties. Reads and writes both go to that copy; every write is
// saved back to its file (write to a temporary file, then rename), so a
// restarted replica sees what it wrote. Nothing else is ever touched.
//
// It implements the calls server.js and lib/ make (scripts/test-replica-sheets.js
// fails when the app starts using one it does not):
//   spreadsheets.get, spreadsheets.batchUpdate (deleteDimension, insertDimension)
//   spreadsheets.values.get / batchGet / update / append / batchUpdate
// with the shapes googleapis returns ({ data: … }) and errors shaped like
// gaxios's ({ code, status, response: { status }, message }).
//
// Not reproduced, on purpose: number and date formats (a value written is
// stored and read back as the text written, where Google would re-format it),
// formula evaluation (a formula written is read back as its text), and quota.
"use strict";

const fs = require("fs");
const path = require("path");

const FORMAT = 1;

function sheetsError(status, message) {
	const err = new Error(message);
	err.code = status;
	err.status = status;
	err.response = { status, data: { error: { code: status, message } } };
	return err;
}

// --- A1 notation -----------------------------------------------------------------

function colToIndex(letters) {
	let n = 0;
	for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

function indexToCol(idx) {
	let s = "";
	let n = idx;
	while (n >= 0) {
		s = String.fromCharCode(65 + (n % 26)) + s;
		n = Math.floor(n / 26) - 1;
	}
	return s;
}

// "Sheet", "'My Sheet'!A1:B2", "Sheet!A:A", "Sheet!2:2", "Sheet!A2:Z".
// Returns { sheet, r0, c0, r1, c1 } with 0-based inclusive bounds; r1/c1 are
// Infinity when the range is open on that side.
function parseA1(range) {
	const s = String(range == null ? "" : range).trim();
	let sheet;
	let rest;
	if (s.startsWith("'")) {
		let i = 1;
		let name = "";
		for (; i < s.length; i++) {
			if (s[i] === "'") {
				if (s[i + 1] === "'") { name += "'"; i++; continue; }
				break;
			}
			name += s[i];
		}
		if (i >= s.length) throw sheetsError(400, `Unable to parse range: ${s}`);
		sheet = name;
		rest = s.slice(i + 1);
		if (rest && !rest.startsWith("!")) throw sheetsError(400, `Unable to parse range: ${s}`);
		rest = rest.slice(1);
	} else {
		const bang = s.lastIndexOf("!");
		if (bang === -1) { sheet = s; rest = ""; } else { sheet = s.slice(0, bang); rest = s.slice(bang + 1); }
	}
	if (!sheet) throw sheetsError(400, `Unable to parse range: ${s}`);
	if (!rest) return { sheet, r0: 0, c0: 0, r1: Infinity, c1: Infinity };
	const m = rest.match(/^([A-Za-z]*)(\d*)(?::([A-Za-z]*)(\d*))?$/);
	if (!m || (!m[1] && !m[2])) throw sheetsError(400, `Unable to parse range: ${s}`);
	const [, sc, sr, ec, er] = m;
	const single = m[3] === undefined && m[4] === undefined;
	const c0 = sc ? colToIndex(sc) : 0;
	const r0 = sr ? Number(sr) - 1 : 0;
	if (single) {
		// "A1" is one cell; "A" alone is the whole column; "2" alone, the row.
		return { sheet, r0, c0, r1: sr ? r0 : Infinity, c1: sc ? c0 : Infinity };
	}
	const c1 = ec ? colToIndex(ec) : Infinity;
	const r1 = er ? Number(er) - 1 : Infinity;
	return { sheet, r0, c0, r1, c1 };
}

function quoteSheet(name) {
	return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

function a1(sheet, r0, c0, r1, c1) {
	return `${quoteSheet(sheet)}!${indexToCol(c0)}${r0 + 1}:${indexToCol(c1)}${r1 + 1}`;
}

// --- Cell values --------------------------------------------------------------

// What a written value reads back as. null/undefined: the cell is skipped, as
// the API skips a null in a write.
function cellText(v) {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
	return String(v);
}

function trimRow(row) {
	let end = row.length;
	while (end > 0 && (row[end - 1] === "" || row[end - 1] === undefined || row[end - 1] === null)) end--;
	return row.slice(0, end).map((c) => (c === undefined || c === null ? "" : c));
}

function trimRows(rows) {
	const out = rows.map(trimRow);
	let end = out.length;
	while (end > 0 && out[end - 1].length === 0) end--;
	return out.slice(0, end);
}

// --- The fake -----------------------------------------------------------------

function createFakeSheets({ file }) {
	const doc = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!doc || doc.format !== FORMAT || !doc.spreadsheets || typeof doc.spreadsheets !== "object") {
		throw new Error(`${file} is not a LogisX replica Sheets working copy (format ${FORMAT})`);
	}

	function save() {
		const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
		fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
		fs.renameSync(tmp, file);
	}

	function book(spreadsheetId) {
		const b = doc.spreadsheets[String(spreadsheetId || "")];
		if (!b) throw sheetsError(404, "Requested entity was not found.");
		return b;
	}

	function tab(b, name) {
		const t = b.sheets.find((s) => s.properties.title === name)
			|| b.sheets.find((s) => s.properties.title.toLowerCase() === String(name).toLowerCase());
		if (!t) throw sheetsError(400, `Unable to parse range: ${name}`);
		if (!Array.isArray(t.values)) t.values = [];
		if (!t.formulas || typeof t.formulas !== "object") t.formulas = {};
		return t;
	}

	function readRange(b, range, render) {
		const r = parseA1(range);
		const t = tab(b, r.sheet);
		const lastRow = Math.min(r.r1, t.values.length - 1);
		const rows = [];
		let maxCol = -1;
		for (let i = r.r0; i <= lastRow; i++) {
			const src = t.values[i] || [];
			const lastCol = Math.min(r.c1, src.length - 1);
			const row = [];
			for (let j = r.c0; j <= lastCol; j++) {
				let v = src[j] === undefined || src[j] === null ? "" : src[j];
				if (render === "FORMULA" && t.formulas[`${i}:${j}`] !== undefined) v = t.formulas[`${i}:${j}`];
				row.push(v);
			}
			if (row.length) maxCol = Math.max(maxCol, r.c0 + row.length - 1);
			rows.push(row);
		}
		const values = trimRows(rows);
		const shownEndRow = Number.isFinite(r.r1) ? r.r1 : Math.max(r.r0, t.properties.gridProperties ? t.properties.gridProperties.rowCount - 1 : lastRow);
		const shownEndCol = Number.isFinite(r.c1) ? r.c1 : Math.max(r.c0, maxCol, t.properties.gridProperties ? t.properties.gridProperties.columnCount - 1 : 0);
		const out = { range: a1(t.properties.title, r.r0, r.c0, shownEndRow, shownEndCol), majorDimension: "ROWS" };
		if (values.length) out.values = values;
		return out;
	}

	function grow(t, rowCount, colCount) {
		const gp = t.properties.gridProperties || (t.properties.gridProperties = { rowCount: 0, columnCount: 0 });
		if (rowCount > gp.rowCount) gp.rowCount = rowCount;
		if (colCount > gp.columnCount) gp.columnCount = colCount;
	}

	function writeAt(t, r0, c0, values) {
		let cells = 0;
		let maxCol = c0 - 1;
		(values || []).forEach((rowVals, i) => {
			const ri = r0 + i;
			while (t.values.length <= ri) t.values.push([]);
			const row = t.values[ri];
			(rowVals || []).forEach((v, j) => {
				const text = cellText(v);
				if (text === undefined) return;
				const ci = c0 + j;
				while (row.length <= ci) row.push("");
				row[ci] = text;
				const key = `${ri}:${ci}`;
				if (text.startsWith("=")) t.formulas[key] = text; else delete t.formulas[key];
				cells++;
				if (ci > maxCol) maxCol = ci;
			});
		});
		const rows = (values || []).length;
		grow(t, r0 + rows, maxCol + 1);
		return { rows, cols: Math.max(0, maxCol - c0 + 1), cells };
	}

	function updateRange(b, range, values) {
		const r = parseA1(range);
		const t = tab(b, r.sheet);
		const w = writeAt(t, r.r0, r.c0, values);
		const endRow = r.r0 + Math.max(w.rows, 1) - 1;
		const endCol = r.c0 + Math.max(w.cols, 1) - 1;
		return { updatedRange: a1(t.properties.title, r.r0, r.c0, endRow, endCol), updatedRows: w.rows, updatedColumns: w.cols, updatedCells: w.cells };
	}

	function body(params) {
		return (params && (params.requestBody || params.resource)) || {};
	}

	function deleteRows(t, start, end) {
		const n = Math.max(0, end - start);
		t.values.splice(start, n);
		const shifted = {};
		for (const [k, v] of Object.entries(t.formulas)) {
			const [ri, ci] = k.split(":").map(Number);
			if (ri < start) shifted[k] = v;
			else if (ri >= end) shifted[`${ri - n}:${ci}`] = v;
		}
		t.formulas = shifted;
		const gp = t.properties.gridProperties;
		if (gp) gp.rowCount = Math.max(0, gp.rowCount - n);
	}

	function insertRows(t, start, end) {
		const n = Math.max(0, end - start);
		while (t.values.length < start) t.values.push([]);
		t.values.splice(start, 0, ...Array.from({ length: n }, () => []));
		const shifted = {};
		for (const [k, v] of Object.entries(t.formulas)) {
			const [ri, ci] = k.split(":").map(Number);
			shifted[ri < start ? k : `${ri + n}:${ci}`] = v;
		}
		t.formulas = shifted;
		grow(t, ((t.properties.gridProperties && t.properties.gridProperties.rowCount) || 0) + n, 0);
	}

	const values = {
		async get(params) {
			const b = book(params.spreadsheetId);
			return { data: readRange(b, params.range, params.valueRenderOption) };
		},
		async batchGet(params) {
			const b = book(params.spreadsheetId);
			const ranges = Array.isArray(params.ranges) ? params.ranges : [params.ranges];
			return { data: { spreadsheetId: params.spreadsheetId, valueRanges: ranges.map((r) => readRange(b, r, params.valueRenderOption)) } };
		},
		async update(params) {
			const b = book(params.spreadsheetId);
			const res = updateRange(b, params.range, body(params).values);
			save();
			return { data: { spreadsheetId: params.spreadsheetId, ...res } };
		},
		async batchUpdate(params) {
			const b = book(params.spreadsheetId);
			const data = body(params).data || [];
			const responses = data.map((d) => ({ spreadsheetId: params.spreadsheetId, ...updateRange(b, d.range, d.values) }));
			save();
			return {
				data: {
					spreadsheetId: params.spreadsheetId,
					totalUpdatedRows: responses.reduce((n, r) => n + r.updatedRows, 0),
					totalUpdatedColumns: responses.reduce((n, r) => Math.max(n, r.updatedColumns), 0),
					totalUpdatedCells: responses.reduce((n, r) => n + r.updatedCells, 0),
					totalUpdatedSheets: new Set(data.map((d) => parseA1(d.range).sheet)).size,
					responses,
				},
			};
		},
		async append(params) {
			const b = book(params.spreadsheetId);
			const r = parseA1(params.range);
			const t = tab(b, r.sheet);
			// The table ends at the last row with anything in the range's columns.
			let last = -1;
			for (let i = 0; i < t.values.length; i++) {
				const row = t.values[i] || [];
				const lastCol = Math.min(r.c1, row.length - 1);
				for (let j = r.c0; j <= lastCol; j++) {
					if (row[j] !== "" && row[j] !== undefined && row[j] !== null) { last = i; break; }
				}
			}
			const start = Math.max(last + 1, r.r0);
			const w = writeAt(t, start, r.c0, body(params).values);
			save();
			const endCol = r.c0 + Math.max(w.cols, 1) - 1;
			return {
				data: {
					spreadsheetId: params.spreadsheetId,
					tableRange: last >= 0 ? a1(t.properties.title, r.r0, r.c0, last, endCol) : undefined,
					updates: {
						spreadsheetId: params.spreadsheetId,
						updatedRange: a1(t.properties.title, start, r.c0, start + Math.max(w.rows, 1) - 1, endCol),
						updatedRows: w.rows,
						updatedColumns: w.cols,
						updatedCells: w.cells,
					},
				},
			};
		},
	};

	const spreadsheets = {
		values,
		async get(params) {
			const b = book(params.spreadsheetId);
			return {
				data: {
					spreadsheetId: params.spreadsheetId,
					properties: { ...(b.properties || {}) },
					sheets: b.sheets.map((s) => ({ properties: JSON.parse(JSON.stringify(s.properties)) })),
				},
			};
		},
		async batchUpdate(params) {
			const b = book(params.spreadsheetId);
			const requests = body(params).requests || [];
			const replies = [];
			for (const req of requests) {
				const kind = Object.keys(req || {})[0];
				const spec = req[kind] || {};
				const range = spec.range || {};
				const t = b.sheets.find((s) => s.properties.sheetId === range.sheetId);
				if ((kind === "deleteDimension" || kind === "insertDimension") && range.dimension === "ROWS") {
					if (!t) throw sheetsError(400, `No grid with id: ${range.sheetId}`);
					tab(b, t.properties.title);
					if (kind === "deleteDimension") deleteRows(t, range.startIndex, range.endIndex);
					else insertRows(t, range.startIndex, range.endIndex);
					replies.push({});
					continue;
				}
				throw sheetsError(400, `The local replica's Sheets copy does not support the request ${kind}${range.dimension ? ` (${range.dimension})` : ""}`);
			}
			save();
			return { data: { spreadsheetId: params.spreadsheetId, replies } };
		},
	};

	return { spreadsheets, file };
}

module.exports = { createFakeSheets, parseA1, quoteSheet, a1, colToIndex, indexToCol, FORMAT };
