#!/usr/bin/env node
// A row save writes only the cells it changes: PUT /api/data/:rowIndex and
// PUT /api/load/:loadId.
//
// THE BUG. Both routes read the row as the sheet DISPLAYS it (the Sheets API's
// default FORMATTED_VALUE), and their callers — the Active Loads editor and the
// Data Manager — send every column back as displayed. Both routes then rewrote
// the WHOLE row from column A with valueInputOption USER_ENTERED, so on every
// save, whichever cell was edited:
//   • a formula cell was rewritten as its displayed value, and the formula lost.
// Each route now writes one values.batchUpdate of single-cell ranges, one per
// cell whose value as it will be written differs from the value as read
// (sheetRowCellWrites()), and nothing at all when no cell differs.
//
// THE BASELINE. That still wrote a cell the user never touched when the sheet
// had changed under the editor's view, which can be ~60 s old: the stale copy
// differs from the row as read. So the Active Loads editor now also sends
// `baseline`, the row as its modal opened it, and PUT /api/data/:rowIndex sets
// every cell sent equal to its baseline back to the row as read
// (restoreUntouchedCells()) before any guard judges the row. A save without a
// baseline, or with a malformed one, is judged as before.
//
// THE ROW THAT MOVED. A row number is a position: after a sort, or a row
// deleted above, the editor's row number holds another load. The restore sets
// the Load ID cell (never edited) to the row as read, so without a check the
// edit would be written onto that other load. So on Job Tracking the baseline's
// Load ID is compared with the row as read first (rowMovedRefusal()), and a
// mismatch, or a Load ID blank on either side, is 409 ROW_MOVED, nothing written.
//
// WHAT RUNS. Both routes are lifted whole out of server.js and run against a
// fake sheet that behaves as the real one does where it matters here: it stores
// a formula and serves the value it displays, stores text entered with a leading
// apostrophe and serves it without, and applies a write as USER_ENTERED does (a
// value starting with "=" becomes a formula). The broker restore, the formula
// refusal, the row diff, the column letters, the cell writes and the audit
// builder are the shipped code. The period guard, the Owner ID check and the
// tab resolver are stubbed (the stubs record what they were asked to judge);
// their own runners cover them.
//   §1 PUT /api/data/:rowIndex
//   §1b PUT /api/data/:rowIndex with a baseline, on a sheet that moved under
//      the view: untouched cells are not written; with no baseline or a
//      malformed one, the save is judged as before. A row that now holds
//      another load: 409 ROW_MOVED with a baseline, DUPLICATE_LOAD without
//   §2 PUT /api/load/:loadId
//   §3 sheetRowCellWrites(), restoreUntouchedCells() and rowMovedRefusal() on
//      their own, where each route calls them, and the Active Loads editor
//      sending its baseline
//   §4 MUTANTS: back to a whole-row write (it must fail checks in §1 and in
//      §2); the baseline ignored (it must fail checks in §1b); the identity
//      check removed (it must fail checks in §1b).
//
// No network, no database, no sheet.
//   node scripts/test-row-save-cell-writes.js     # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0, fail = 0;
const failures = [];
function collector() {
	const results = [];
	const t = (name, actual, expected) => {
		const a = JSON.stringify(actual), e = JSON.stringify(expected);
		results.push({ ok: a === e, name, a, e });
	};
	return { results, t };
}
function record(results) {
	for (const r of results) {
		if (r.ok) { pass++; continue; }
		fail++; failures.push(`${r.name}\n     expected ${r.e}\n     actual   ${r.a}`);
		console.log(`  FAIL  ${r.name}\n          expected ${r.e}\n          actual   ${r.a}`);
	}
	console.log(`  ${results.filter((r) => r.ok).length}/${results.length} checks`);
}

// ---------------------------------------------------------------- extraction
// A top-level function, from its declaration to the first `}` in column 0.
function extract(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", start);
	if (end < 0) throw new Error(`could not find the top-level end of ${name}()`);
	const body = SRC.slice(start, end + 3);
	if (body.split("\nfunction ").length - 1 !== 0) throw new Error(`extraction of ${name}() spanned more than one declaration`);
	return body;
}
// A one-line `const NAME = …;`, or a block from its head to `close`.
function extractConst(head, close = null) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 statement starting ${JSON.stringify(head)}, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	const end = close ? SRC.indexOf(close, start) : SRC.indexOf(";\n", start);
	if (end < 0) throw new Error(`no end found after ${head}`);
	return SRC.slice(start, end + (close ? close.length : 1));
}
// A route registration, from its line to the first column-0 "});".
function extractRoute(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n});", start);
	if (end < 0) throw new Error(`no column-0 "});" after ${head}`);
	return SRC.slice(start, end + "\n});".length);
}
// Replace exactly one occurrence, or fail loudly: a mutant whose target is gone
// would run the shipped code and "pass", proving nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) throw new Error(`mutant target found ${n}x (expected 1): ${from.slice(0, 70)}`);
	return src.replace(from, () => to);
}
// Source without its whole-line comments, so a wiring check reads code only.
const decomment = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

const reMatch = SRC.match(/const BROKER_WITHHELD_RE = (\/.*\/[a-z]*);/);
if (!reMatch) throw new Error("BROKER_WITHHELD_RE not found in server.js");
const CONSTS = [
	`const BROKER_WITHHELD_RE = ${reMatch[1]};`,
	extractConst("const SHEET_ROW_AUDIT_DETAILS_MAX = "),
	extractConst("const SHEET_ROW_AUDIT_MAX_CHANGES = "),
	extractConst("const JT_MONEY_COLUMN_PATTERNS = [", "\n];"),
].join("\n");
const HELPERS = [
	"resolveBrokerWithheldColumns", "sanitizeBrokerColumns", "restoreWithheldBrokerCells", "formulaCellRefusal",
	"sheetRowAfterUpdate", "a1SheetPrefix", "a1ColumnLetter", "sheetRowCellWrites", "restoreUntouchedCells",
	"baselineApplies", "rowMovedRefusal",
	"guardedColumnReason", "changedGuardedCells", "scrubPurgeMarker", "capAuditField", "buildSheetUpdateAudit",
];
const HELPER_SRC = Object.fromEntries(HELPERS.map((n) => [n, extract(n)]));
// The load-id comparison key server.js imports, the shipped module.
const { normalizeLoadId } = require("../lib/ratecon-load");
// The shipped helpers, with `overrides` swapping one source for a mutant.
function buildHelpers(overrides = {}) {
	const s = { ...HELPER_SRC, ...overrides };
	return new Function("normalizeLoadId", `"use strict";\n${CONSTS}\n${HELPERS.map((n) => s[n]).join("\n")}\nreturn { ${HELPERS.join(", ")} };`)(normalizeLoadId);
}
const H = buildHelpers();

const DATA_HEAD = 'app.put("/api/data/:rowIndex", requireRole("Super Admin", "Dispatcher"), async (req, res) => {';
const LOAD_HEAD = 'app.put("/api/load/:loadId", requireRole("Super Admin", "Dispatcher"), async (req, res) => {';
const DATA_PUT_SRC = extractRoute(DATA_HEAD);
const LOAD_PUT_SRC = extractRoute(LOAD_HEAD);

// ---------------------------------------------------------------------------
// THE FIXTURE — production's 26-column Job Tracking header row, verbatim, and a
// load whose row carries what a real one does: three formula cells (the
// payment, a HYPERLINK to the POD, the `output` rate per mile) and a text cell
// that starts with "=" (entered with a leading apostrophe, so it is text).
// ---------------------------------------------------------------------------
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver",
	"Pickup Info", "Pickup Address", "Pickup Appointment", "Drop-off Info",
	"Drop-off Address", "Drop-off Appointment", "Job Status", "Phase of Progress",
	"Carrier Stage", "Broker Contact Name", "Phone Number", "Email",
	"Assigned Date", "Status Update Date", "Completion Date", "Location Link",
	"Documents", "  Payment  ", "Truck", "Owner ID", "output",
];
const IDX = Object.fromEntries(HEADERS.map((h, i) => [h.trim(), i]));
const WITHHELD = ["Broker Contact Name", "Phone Number", "Email"];
const PAYMENT_F = "=1500+300";
// The payment formula after an input to it changed: it shows another value.
const PAYMENT_F2 = "=1500+400";
const DOCS_F = '=HYPERLINK("https://example.invalid/pod/111.pdf","POD")';
const OUTPUT_F = "=ROUND(1800/950,2)";
const TEXT_EQ = "'=starts with an equals sign";
// What the sheet displays for each formula the fixture stores.
const SHOWS = { [PAYMENT_F]: "$1,800.00", [PAYMENT_F2]: "$1,900.00", [DOCS_F]: "POD", [OUTPUT_F]: "1.89" };
function storedRow(over = {}) {
	const r = new Array(HEADERS.length).fill("");
	Object.assign(r, {
		[IDX["Contract ID"]]: "29284990", [IDX["Load ID"]]: "111", [IDX["Details"]]: "Frozen",
		[IDX["Driver"]]: "Shorn King", [IDX["Pickup Address"]]: "1 Main St, Houston, TX 77002",
		[IDX["Job Status"]]: "Delivered", [IDX["Broker Contact Name"]]: "Danna Garcia",
		[IDX["Phone Number"]]: "555-0142", [IDX["Email"]]: "danna.garcia@example.invalid",
		[IDX["Assigned Date"]]: "9/1/2026", [IDX["Location Link"]]: TEXT_EQ, [IDX["Documents"]]: DOCS_F,
		[IDX["Payment"]]: PAYMENT_F, [IDX["Truck"]]: "33", [IDX["Owner ID"]]: "5", [IDX["output"]]: OUTPUT_F,
	});
	for (const [k, v] of Object.entries(over)) r[IDX[k]] = v;
	return r;
}
const STORED = () => [HEADERS.slice(), storedRow(), storedRow({ "Load ID": "222", Details: "Dry van", "Location Link": "" })];
// The same load after the sheet moved under the editor's view: another user
// re-weighed it and marked it Completed, an input to the payment formula
// changed (so it shows another value), the "=…" text was replaced by a link,
// and the Owner ID was corrected. The editor opened DISPLAYED(), the row
// before any of it.
const MOVED = {
	Details: "Frozen - re-weighed", "Job Status": "Completed", Payment: PAYMENT_F2,
	"Location Link": "https://maps.example.invalid/111", "Owner ID": "42",
};
const MOVED_COLS = Object.keys(MOVED);
const MOVED_STORE = () => [HEADERS.slice(), storedRow(MOVED), storedRow({ "Load ID": "222", Details: "Dry van", "Location Link": "" })];

// ---------------------------------------------------------------------------
// THE FAKE SHEET. Each stored cell is in the sheet's own terms:
//   "=…"  a formula, displayed as SHOWS[it] ("#ERROR!" for one it does not
//         know, which is what a sentence entered as a formula displays);
//   "'…"  text entered with a leading apostrophe, displayed without it;
//   else  a plain value, displayed as itself.
// Reads serve what is DISPLAYED, trailing empty cells dropped, as the API
// serves FORMATTED_VALUE. A write is applied as USER_ENTERED applies it: the
// value is stored as given, so one starting with "=" is now a formula.
// ---------------------------------------------------------------------------
function display(c) {
	const s = c == null ? "" : String(c);
	if (s.startsWith("=")) return Object.prototype.hasOwnProperty.call(SHOWS, s) ? SHOWS[s] : "#ERROR!";
	if (s.startsWith("'")) return s.slice(1);
	return s;
}
function shown(row) {
	const out = (row || []).map(display);
	while (out.length && out[out.length - 1] === "") out.pop();
	return out;
}
const DISPLAYED = () => HEADERS.map((h, i) => display(storedRow()[i]));
function fakeSheet(stored, { batchGetFails = false } = {}) {
	const rows = stored.map((r) => r.slice());
	const calls = [];
	const rowNo = (range) => { const m = /!(\d+):\1$/.exec(range); return m ? Number(m[1]) : null; };
	const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
	const values = {
		get: async ({ range }) => {
			const n = rowNo(range);
			if (n) return { data: { values: [shown(rows[n - 1])] } };
			// A whole column ("…!B:B"), as the DUPLICATE_LOAD check reads it: one
			// row per sheet row, an empty cell as [], trailing empty rows dropped.
			const col = /!([A-Z]+):\1$/.exec(range);
			if (col) {
				const i = colIndex(col[1]);
				const out = rows.map((r) => { const v = display((r || [])[i]); return v === "" ? [] : [v]; });
				while (out.length && !out[out.length - 1].length) out.pop();
				return { data: { values: out } };
			}
			return { data: { values: rows.map(shown) } };
		},
		batchGet: async ({ ranges }) => {
			if (batchGetFails) throw new Error("fake sheet: read failed");
			return { data: { valueRanges: ranges.map((x) => ({ values: [shown(rows[rowNo(x) - 1])] })) } };
		},
		batchUpdate: async ({ requestBody }) => {
			const { valueInputOption, data } = requestBody;
			calls.push({ verb: "batchUpdate", valueInputOption, ranges: data.map((d) => d.range), values: data.map((d) => d.values) });
			let cells = 0;
			for (const d of data) {
				const m = /!([A-Z]+)(\d+)$/.exec(d.range);
				if (!m) throw new Error(`fake sheet: unreadable range ${d.range}`);
				const r = rows[Number(m[2]) - 1] || (rows[Number(m[2]) - 1] = []);
				d.values[0].forEach((v, j) => {
					const i = colIndex(m[1]) + j;
					while (r.length <= i) r.push("");
					r[i] = v == null ? "" : String(v);
				});
				cells += d.values[0].length;
			}
			return { data: { totalUpdatedCells: cells } };
		},
	};
	return { getSheets: async () => ({ spreadsheets: { values } }), rows, calls };
}

// One lifted route over one fake sheet.
function mount(routeSrc, helpers, stored, { guarded = true, title = "Job Tracking", batchGetFails = false } = {}) {
	const sheet = fakeSheet(stored, { batchGetFails });
	const audits = [];
	// What the stubbed Owner ID check and period guard were asked to judge: the
	// Owner ID cell, and the changed guarded cells as [column, from, to].
	const ownerSeen = [];
	const guardCalls = [];
	let invalidations = 0;
	let handler = null;
	const env = {
		...helpers,
		normalizeLoadId,
		app: { put: (p, gate, h) => { handler = h; } },
		requireRole: () => null,
		getSheets: sheet.getSheets,
		SPREADSHEET_ID: "sheet-under-test",
		SHEET_ROW_MAX_CELLS: 20000,
		PERIOD_GUARDED_SHEETS: ["Job Tracking"],
		getSheetName: (req) => (req.query && req.query.sheet) || "Job Tracking",
		resolveSheetTargetForWrite: async () => ({ resolved: true, metaUnreadable: false, title, guarded }),
		validateOwnerIdCell: (sheetName, hs, row) => {
			const i = hs.findIndex((h) => /^owner.?id$/i.test(String(h)));
			ownerSeen.push(i < 0 ? null : row[i]);
			return null;
		},
		sheetRowUpdateBlocker: (g, hs, before, after, changes) => {
			guardCalls.push(changes.map((c) => [c.column, c.from, c.to]));
			return null;
		},
		sheetAuditWithCode: (d, code) => `${d} [${code}]`,
		logAudit: (req, action, entity, entityId, details) => { audits.push({ action, entityId, details }); },
		logAuditRefusal: (req, action, entity, entityId, details) => { audits.push({ action, entityId, details }); },
		jtCacheInvalidate: () => { invalidations++; },
		console: { error() {}, log() {}, warn() {} },
	};
	const names = Object.keys(env);
	new Function(...names, routeSrc)(...names.map((k) => env[k]));
	if (typeof handler !== "function") throw new Error("a lifted PUT route did not register a handler");
	const run = async (role, params, body, query = { sheet: title }) => {
		const out = { code: 200, body: null };
		const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
		await handler({ params, query, body, session: { user: { id: role === "Super Admin" ? 1 : 2, role, username: role === "Super Admin" ? "super_admin" : "kevin" } } }, res);
		return out;
	};
	return { run, rows: sheet.rows, calls: sheet.calls, audits, ownerSeen, guardCalls, invalidations: () => invalidations };
}
// The columns the success audit line names as changed, from the shipped builder.
function auditedColumns(app) {
	const line = app.audits.find((a) => a.action === "update_sheet_row");
	return line ? JSON.parse(line.details).changed.map((c) => c.column) : null;
}
const R = (cell) => `'Job Tracking'!${cell}`;
const FORMULAS_KEPT = (rows) => [rows[1][IDX["Payment"]], rows[1][IDX["Documents"]], rows[1][IDX["output"]]];

// ---------------------------------------------------------------------------
// §1 PUT /api/data/:rowIndex — the Data Manager (Super Admin) and the Active
// Loads editor both send every column back as displayed.
// ---------------------------------------------------------------------------
async function dataSection(helpers, routeSrc = DATA_PUT_SRC) {
	const { results, t } = collector();
	const P = { rowIndex: "2" };
	{
		const app = mount(routeSrc, helpers, STORED());
		const values = DISPLAYED();
		values[IDX["Details"]] = "Frozen - 2 pallets rolled";
		const r = await app.run("Super Admin", P, { values });
		t("§1 Super Admin edits Details: 200 { success, updatedCells: 1 }", [r.code, r.body], [200, { success: true, updatedCells: 1 }]);
		t("§1 Super Admin edits Details: one values.batchUpdate, USER_ENTERED, the Details cell alone",
			app.calls, [{ verb: "batchUpdate", valueInputOption: "USER_ENTERED", ranges: [R("C2")], values: [[["Frozen - 2 pallets rolled"]]] }]);
		t("§1 Super Admin edits Details: the three formula cells are still formulas", FORMULAS_KEPT(app.rows), [PAYMENT_F, DOCS_F, OUTPUT_F]);
		t("§1 Super Admin edits Details: the text cell showing \"=…\" is still text", app.rows[1][IDX["Location Link"]], TEXT_EQ);
		t("§1 Super Admin edits Details: the audit line names the cell written, and only it", auditedColumns(app), ["Details"]);
		t("§1 Super Admin edits Details: the Job Tracking cache is invalidated once", app.invalidations(), 1);
	}
	{
		const app = mount(routeSrc, helpers, STORED());
		const values = DISPLAYED();
		values[IDX["Job Status"]] = "Completed";
		values[IDX["Trailer Number"]] = "TR-9";
		const r = await app.run("Super Admin", P, { values });
		t("§1 Super Admin edits two cells: one write of exactly those two ranges, in column order, one cell each",
			[r.code, app.calls.length, app.calls[0] && app.calls[0].ranges, app.calls[0] && app.calls[0].values],
			[200, 1, [R("D2"), R("L2")], [[["TR-9"]], [["Completed"]]]]);
		// buildSheetUpdateAudit() lists the guarded cells first, so compare as a set.
		t("§1 Super Admin edits two cells: the audit names both", (auditedColumns(app) || []).slice().sort(), ["Job Status", "Trailer Number"]);
	}
	{
		const app = mount(routeSrc, helpers, STORED());
		const r = await app.run("Super Admin", P, { values: DISPLAYED() });
		t("§1 a save that changes nothing: 200 { success, updatedCells: 0, unchanged: true }", [r.code, r.body], [200, { success: true, updatedCells: 0, unchanged: true }]);
		t("§1 a save that changes nothing: no write, no audit line, no cache invalidation",
			[app.calls.length, app.audits.length, app.invalidations()], [0, 0, 0]);
		t("§1 a save that changes nothing: the row is exactly as stored", app.rows[1], storedRow());
	}
	{
		// The Active Loads editor's save: the withheld columns come back blank.
		const app = mount(routeSrc, helpers, STORED());
		const values = DISPLAYED().map((v, i) => (WITHHELD.includes(HEADERS[i]) ? "" : v));
		values[IDX["Details"]] = "Frozen - 2 pallets rolled";
		values[IDX["Email"]] = "someone.else@example.invalid";
		const r = await app.run("Dispatcher", P, { values });
		t("§1 Dispatcher edits Details (withheld sent blank, Email typed): 200, the Details cell alone written",
			[r.code, app.calls.map((c) => c.ranges)], [200, [[R("C2")]]]);
		t("§1 Dispatcher: the stored contacts are untouched", WITHHELD.map((c) => app.rows[1][IDX[c]]), WITHHELD.map((c) => storedRow()[IDX[c]]));
		t("§1 Dispatcher: the formulas and the \"=…\" text are untouched", [...FORMULAS_KEPT(app.rows), app.rows[1][IDX["Location Link"]]], [PAYMENT_F, DOCS_F, OUTPUT_F, TEXT_EQ]);
	}
	{
		const app = mount(routeSrc, helpers, STORED());
		const values = DISPLAYED().map((v, i) => (WITHHELD.includes(HEADERS[i]) ? "" : v));
		values[IDX["Details"]] = "=O2";
		const r = await app.run("Dispatcher", P, { values });
		t("§1 Dispatcher, Details \"=O2\": 400 FORMULA_NOT_ALLOWED naming Details, nothing written or audited",
			[r.code, (r.body || {}).code, (r.body || {}).field, app.calls.length, app.audits.length], [400, "FORMULA_NOT_ALLOWED", "Details", 0, 0]);
	}
	{
		// The "=…" text sent back as displayed is no change, so it is neither
		// refused nor rewritten, and the edit beside it goes through.
		const app = mount(routeSrc, helpers, STORED());
		const values = DISPLAYED().map((v, i) => (WITHHELD.includes(HEADERS[i]) ? "" : v));
		values[IDX["Trailer Number"]] = "TR-9";
		const r = await app.run("Dispatcher", P, { values });
		t("§1 Dispatcher resends the \"=…\" text as displayed and edits Trailer Number: 200, only that cell written, the text still text",
			[r.code, app.calls.map((c) => c.ranges), app.rows[1][IDX["Location Link"]]], [200, [[R("D2")]], TEXT_EQ]);
	}
	{
		// A formula cell the user did edit is written, as asked.
		const app = mount(routeSrc, helpers, STORED());
		const values = DISPLAYED();
		values[IDX["Payment"]] = "$1,900.00";
		const r = await app.run("Super Admin", P, { values });
		t("§1 Super Admin edits the payment cell itself: that cell alone written, with the typed value",
			[r.code, app.calls.map((c) => [c.ranges, c.values]), app.rows[1][IDX["Payment"]], app.rows[1][IDX["output"]]],
			[200, [[[R("W2")], [[["$1,900.00"]]]]], "$1,900.00", OUTPUT_F]);
	}
	{
		// A short values array leaves the tail alone: it equals the row as read.
		const app = mount(routeSrc, helpers, STORED());
		const values = DISPLAYED().slice(0, 5);
		values[IDX["Details"]] = "Frozen - short";
		const r = await app.run("Super Admin", P, { values });
		t("§1 a short values array: only the changed cell written, the formulas past its end untouched",
			[r.code, app.calls.map((c) => c.ranges), FORMULAS_KEPT(app.rows)], [200, [[R("C2")]], [PAYMENT_F, DOCS_F, OUTPUT_F]]);
	}
	{
		// null reads as "" to the guard and the audit, so it is written as "".
		const app = mount(routeSrc, helpers, STORED());
		const values = DISPLAYED();
		values[IDX["Pickup Address"]] = null;
		const r = await app.run("Super Admin", P, { values });
		t("§1 a null sent for a filled cell: written as \"\", the value the audit records",
			[r.code, app.calls.map((c) => [c.ranges, c.values]), app.rows[1][IDX["Pickup Address"]], JSON.parse(app.audits[0].details).changed[0].to],
			[200, [[[R("G2")], [[[""]]]]], "", ""]);
	}
	{
		// A tab wider than Z: the column letters come from a1ColumnLetter().
		const wide = [HEADERS.concat(["Extra A", "Extra B"]), storedRow().concat(["x", "y"])];
		const app = mount(routeSrc, helpers, wide);
		const values = DISPLAYED().concat(["x", "y2"]);
		const r = await app.run("Super Admin", P, { values });
		t("§1 a 28-column tab: the 28th column is written as AB", [r.code, app.calls.map((c) => c.ranges)], [200, [[R("AB2")]]]);
	}
	{
		// Another tab, not period-guarded: the same rule, under that tab's name.
		const app = mount(routeSrc, helpers, STORED(), { guarded: false, title: "Carrier History" });
		const values = DISPLAYED();
		values[IDX["Details"]] = "note";
		const r = await app.run("Super Admin", P, { values });
		t("§1 a tab that is not period-guarded: only the changed cell written, under that tab's name",
			[r.code, app.calls.map((c) => c.ranges), app.invalidations()], [200, [["'Carrier History'!C2"]], 0]);
	}
	{
		// A row that could not be read cannot be diffed, so nothing is written.
		const app = mount(routeSrc, helpers, STORED(), { guarded: false, title: "Carrier History", batchGetFails: true });
		const r = await app.run("Super Admin", P, { values: DISPLAYED() });
		t("§1 a Super Admin's save when the row could not be read: 409 ROW_READ_FAILED, nothing written",
			[r.code, (r.body || {}).code, app.calls.length], [409, "ROW_READ_FAILED", 0]);
	}
	return results;
}

// ---------------------------------------------------------------------------
// §1b PUT /api/data/:rowIndex with a baseline. The sheet is MOVED_STORE(): five
// cells changed since the editor opened DISPLAYED(), none by this user.
// ---------------------------------------------------------------------------
async function baselineSection(helpers, routeSrc = DATA_PUT_SRC) {
	const { results, t } = collector();
	const P = { rowIndex: "2" };
	const MOVED_ROW = storedRow(MOVED);
	const asMoved = (rows) => MOVED_COLS.map((c) => rows[1][IDX[c]]);
	const ranges = (app) => app.calls.map((c) => c.ranges);
	// The editor's save: every column as it opened, one edited.
	const edit = (col, value, opened = DISPLAYED()) => { const v = opened.slice(); v[IDX[col]] = value; return v; };
	// Today's behaviour, and what a save without a usable baseline still does:
	// every moved cell written back as the stale view had it, beside the edit.
	const STALE_WITH_D2 = [["C2", "D2", "L2", "U2", "W2", "Y2"].map(R)];
	{
		const app = mount(routeSrc, helpers, MOVED_STORE());
		const r = await app.run("Super Admin", P, { values: edit("Trailer Number", "TR-9"), baseline: DISPLAYED() });
		t("§1b Super Admin edits Trailer Number, with a baseline: 200 { success, updatedCells: 1 }", [r.code, r.body], [200, { success: true, updatedCells: 1 }]);
		t("§1b ...one write, the Trailer Number cell alone, as typed",
			app.calls.map((c) => [c.ranges, c.values]), [[[R("D2")], [[["TR-9"]]]]]);
		t("§1b ...the five cells that moved on the sheet are as the sheet holds them (the payment formula included)",
			asMoved(app.rows), MOVED_COLS.map((c) => MOVED_ROW[IDX[c]]));
		t("§1b ...the audit names Trailer Number alone", auditedColumns(app), ["Trailer Number"]);
		t("§1b ...the period guard is handed no moved cell (Trailer Number moves no money)", app.guardCalls, [[]]);
		t("§1b ...the Owner ID check sees the Owner ID as it will stand: the sheet's", app.ownerSeen, ["42"]);
	}
	{
		const app = mount(routeSrc, helpers, MOVED_STORE());
		const r = await app.run("Super Admin", P, { values: edit("Trailer Number", "TR-9") });
		t("§1b the same save without a baseline (today's behaviour): every moved cell written back stale, the payment formula flattened, the status reverted",
			[r.code, ranges(app), app.rows[1][IDX["Payment"]], app.rows[1][IDX["Job Status"]], app.rows[1][IDX["Owner ID"]]],
			[200, STALE_WITH_D2, "$1,800.00", "Delivered", "5"]);
		t("§1b ...and the period guard is handed the stale cells as changes",
			app.guardCalls.map((call) => call.map((c) => c[0])), [["Job Status", "Payment", "Owner ID"]]);
	}
	{
		// An edited cell is written, even one that also moved on the sheet.
		const app = mount(routeSrc, helpers, MOVED_STORE());
		const r = await app.run("Super Admin", P, { values: edit("Details", "Frozen - 3 pallets"), baseline: DISPLAYED() });
		t("§1b Super Admin edits Details, which also moved on the sheet: the edit is written, and nothing else",
			[r.code, app.calls.map((c) => [c.ranges, c.values]), app.rows[1][IDX["Details"]]],
			[200, [[[R("C2")], [[["Frozen - 3 pallets"]]]]], "Frozen - 3 pallets"]);
	}
	{
		// An edited guarded cell: the guard judges it, from the row as read.
		const app = mount(routeSrc, helpers, MOVED_STORE());
		const r = await app.run("Super Admin", P, { values: edit("Job Status", "Invoiced"), baseline: DISPLAYED() });
		t("§1b Super Admin edits Job Status: L2 alone written, and the period guard judges it from the sheet's value",
			[r.code, ranges(app), app.guardCalls], [200, [[R("L2")]], [[["Job Status", "Completed", "Invoiced"]]]]);
	}
	{
		// Edited to exactly what the sheet now holds: nothing to write.
		const app = mount(routeSrc, helpers, MOVED_STORE());
		const r = await app.run("Super Admin", P, { values: edit("Details", MOVED.Details), baseline: DISPLAYED() });
		t("§1b Super Admin edits Details to the value the sheet already holds: nothing written, no audit, unchanged",
			[r.code, r.body, app.calls.length, app.audits.length], [200, { success: true, updatedCells: 0, unchanged: true }, 0, 0]);
	}
	{
		// Saved without an edit: nothing written, though five cells differ.
		const app = mount(routeSrc, helpers, MOVED_STORE());
		const r = await app.run("Super Admin", P, { values: DISPLAYED(), baseline: DISPLAYED() });
		t("§1b a save with no edit, five cells stale: nothing written, no audit, no cache invalidation, the row as the sheet holds it",
			[r.code, r.body, app.calls.length, app.audits.length, app.invalidations(), app.rows[1]],
			[200, { success: true, updatedCells: 0, unchanged: true }, 0, 0, 0, MOVED_ROW]);
	}
	{
		// A baseline that is not an array of values.length cells is ignored.
		const opened = DISPLAYED();
		const malformed = [
			["one cell short", opened.slice(0, -1)],
			["one cell long", opened.concat([""])],
			["a string", opened.join(",")],
			["an object", Object.assign({}, opened)],
			["null", null],
		];
		for (const [label, baseline] of malformed) {
			const app = mount(routeSrc, helpers, MOVED_STORE());
			const r = await app.run("Super Admin", P, { values: edit("Trailer Number", "TR-9"), baseline });
			t(`§1b a malformed baseline (${label}) is ignored: judged as before, every moved cell written back`, [r.code, ranges(app)], [200, STALE_WITH_D2]);
		}
	}
	{
		// The Active Loads editor as a Dispatcher sends it: the withheld contact
		// columns blank in both values and baseline. The stale "=…" text in the
		// view is not the user's, so it is neither judged nor written.
		// The route updates `values` in place, as it may a parsed request body, so
		// each run gets its own arrays.
		const blankWithheld = (row) => row.map((v, i) => (WITHHELD.includes(HEADERS[i]) ? "" : v));
		const opened = blankWithheld(DISPLAYED());
		const values = () => edit("Trailer Number", "TR-9", opened);
		const app = mount(routeSrc, helpers, MOVED_STORE());
		const r = await app.run("Dispatcher", P, { values: values(), baseline: opened.slice() });
		t("§1b Dispatcher edits Trailer Number, with a baseline: 200, D2 alone written, the contacts and the moved cells as the sheet holds them",
			[r.code, ranges(app), WITHHELD.map((c) => app.rows[1][IDX[c]]), asMoved(app.rows)],
			[200, [[R("D2")]], WITHHELD.map((c) => MOVED_ROW[IDX[c]]), MOVED_COLS.map((c) => MOVED_ROW[IDX[c]])]);
		const old = mount(routeSrc, helpers, MOVED_STORE());
		const o = await old.run("Dispatcher", P, { values: values() });
		t("§1b ...without a baseline (today's behaviour): refused 400 FORMULA_NOT_ALLOWED for the stale \"=…\" text in Location Link, a cell the user never touched",
			[o.code, (o.body || {}).code, (o.body || {}).field, old.calls.length], [400, "FORMULA_NOT_ALLOWED", "Location Link", 0]);
		const typed = mount(routeSrc, helpers, MOVED_STORE());
		const f = await typed.run("Dispatcher", P, { values: edit("Details", "=O2", opened), baseline: opened.slice() });
		t("§1b ...and a formula the Dispatcher types is still refused, with a baseline",
			[f.code, (f.body || {}).code, (f.body || {}).field, typed.calls.length], [400, "FORMULA_NOT_ALLOWED", "Details", 0]);
	}

	// The row moved under the view: the editor opened load 111 at row 2, then
	// the sheet was sorted, so row 2 now holds load 222 and load 111 is on row 3
	// (SHIFTED()). The user sets the payment to 2500.
	const SHIFTED = () => [HEADERS.slice(), storedRow({ "Load ID": "222", Details: "Dry van", "Location Link": "" }), storedRow()];
	const payment = (opened = DISPLAYED()) => edit("Payment", "2500", opened);
	// The refusal's audit details: the JSON before the stubbed " [CODE]" suffix.
	const auditOf = (app) => {
		const a = app.audits.find((x) => x.action === "update_sheet_row_blocked");
		const m = a && /^([\s\S]*) \[[A-Z_]+\]$/.exec(a.details);
		try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
	};
	{
		const app = mount(routeSrc, helpers, SHIFTED());
		const r = await app.run("Super Admin", P, { values: payment(), baseline: DISPLAYED() });
		const b = r.body || {};
		t("§1b the row moved (row 2 now holds load 222), with a baseline: 409 ROW_MOVED naming the load opened and the load found",
			[r.code, b.code, b.rowIndex, b.expectedLoadId, b.foundLoadId], [409, "ROW_MOVED", 2, "111", "222"]);
		t("§1b ...nothing written: no write call, every row as stored", [app.calls.length, app.rows], [0, SHIFTED()]);
		t("§1b ...refused before any check judged the row: the Owner ID check and the period guard never ran",
			[app.ownerSeen, app.guardCalls], [[], []]);
		t("§1b ...one audit line: update_sheet_row_blocked on Job Tracking!2, coded ROW_MOVED",
			app.audits.map((a) => [a.action, a.entityId, a.details.endsWith(" [ROW_MOVED]")]), [["update_sheet_row_blocked", "Job Tracking!2", true]]);
		const d = auditOf(app);
		t("§1b ...the audit names both loads and the edit asked for (as the form opened it, and as sent)",
			d && [d.outcome, d.code, d.expectedLoadId, d.foundLoadId, d.changed.map((c) => [c.column, c.from, c.to]), d.guardedColumns],
			["blocked", "ROW_MOVED", "111", "222", [["Payment", "$1,800.00", "2500"]], ["Payment"]]);
		t("§1b ...and the cached Job Tracking rows are dropped, so the next dashboard read shows the rows where they are now",
			app.invalidations(), 1);
	}
	{
		const app = mount(routeSrc, helpers, SHIFTED());
		const r = await app.run("Super Admin", P, { values: payment() });
		t("§1b the same save without a baseline (today's behaviour): 409 DUPLICATE_LOAD, load 111 found on row 3, nothing written",
			[r.code, (r.body || {}).code, (r.body || {}).conflictRowIndex, app.calls.length, app.rows], [409, "DUPLICATE_LOAD", 3, 0, SHIFTED()]);
	}
	{
		const app = mount(routeSrc, helpers, STORED());
		const r = await app.run("Super Admin", P, { values: payment(), baseline: DISPLAYED() });
		t("§1b the same save with a baseline on the row that did not move: 200, W2 alone written, as typed",
			[r.code, r.body, app.calls.map((c) => [c.ranges, c.values]), auditedColumns(app)],
			[200, { success: true, updatedCells: 1 }, [[[R("W2")], [[["2500"]]]]], ["Payment"]]);
	}
	{
		// Identity is judged on the baseline, not on what is sent: a caller that
		// edits the Load ID itself, with a baseline, reaches the DUPLICATE_LOAD
		// check as before.
		const renamed = (lid) => edit("Load ID", lid);
		const fresh = mount(routeSrc, helpers, STORED());
		const r1 = await fresh.run("Super Admin", P, { values: renamed("333"), baseline: DISPLAYED() });
		t("§1b a baseline save that renames load 111 to an unused id: 200, B2 alone written",
			[r1.code, fresh.calls.map((c) => [c.ranges, c.values])], [200, [[[R("B2")], [[["333"]]]]]]);
		const taken = mount(routeSrc, helpers, STORED());
		const r2 = await taken.run("Super Admin", P, { values: renamed("222"), baseline: DISPLAYED() });
		t("§1b a baseline save that renames load 111 to 222, which row 3 holds: 409 DUPLICATE_LOAD, nothing written",
			[r2.code, (r2.body || {}).code, (r2.body || {}).conflictRowIndex, taken.calls.length], [409, "DUPLICATE_LOAD", 3, 0]);
	}
	{
		// Identity is confirmed only by a Load ID on both sides, equal as the
		// DUPLICATE_LOAD check compares them (normalizeLoadId()).
		const opening = (lid) => { const v = DISPLAYED(); v[IDX["Load ID"]] = lid; return v; };
		const blankRow = () => [HEADERS.slice(), storedRow({ "Load ID": "" })];
		const cases = [
			["the form opened a row with no Load ID, and row 2 holds load 111", STORED(), "", [409, "ROW_MOVED", "", "111", []]],
			["the form opened load 111, and row 2 has no Load ID", blankRow(), "111", [409, "ROW_MOVED", "111", "", []]],
			["neither carries a Load ID, so the row cannot be confirmed", blankRow(), "", [409, "ROW_MOVED", "", "", []]],
			["row 2 holds \"#111 \" and the form opened \"111\": one load, as the DUPLICATE_LOAD check reads it",
				[HEADERS.slice(), storedRow({ "Load ID": "#111 " })], "111", [200, null, null, null, [[R("W2")]]]],
		];
		for (const [label, store, lid, want] of cases) {
			const app = mount(routeSrc, helpers, store);
			const opened = opening(lid);
			const r = await app.run("Super Admin", P, { values: payment(opened), baseline: opened.slice() });
			const b = r.body || {};
			t(`§1b ${label}: ${want[0] === 409 ? "409 ROW_MOVED, nothing written" : "200, W2 alone written"}`,
				[r.code, b.code || null, b.code ? b.expectedLoadId : null, b.code ? b.foundLoadId : null, app.calls.map((c) => c.ranges)], want);
		}
	}
	{
		// The Active Loads editor as a Dispatcher sends it, on the moved row: the
		// refusal comes before the broker restore and the formula refusal.
		const opened = DISPLAYED().map((v, i) => (WITHHELD.includes(HEADERS[i]) ? "" : v));
		const app = mount(routeSrc, helpers, SHIFTED());
		const r = await app.run("Dispatcher", P, { values: edit("Trailer Number", "TR-9", opened), baseline: opened.slice() });
		t("§1b a Dispatcher's save on the moved row, with a baseline: 409 ROW_MOVED, nothing written",
			[r.code, (r.body || {}).code, app.calls.length], [409, "ROW_MOVED", 0]);
	}
	{
		// Where the check does not apply, the baseline save is judged as before:
		// a layout with no load-id column carries no identity to compare, and a
		// tab the guards do not cover is not judged.
		const NO_LID = HEADERS.map((h) => (h === "Load ID" ? "Reference" : h));
		const noLid = mount(routeSrc, helpers, [NO_LID, ...SHIFTED().slice(1)]);
		const r1 = await noLid.run("Super Admin", P, { values: payment(), baseline: DISPLAYED() });
		t("§1b no load-id column: judged as before, 200, W2 alone written", [r1.code, noLid.calls.map((c) => c.ranges)], [200, [[R("W2")]]]);
		const other = mount(routeSrc, helpers, SHIFTED(), { guarded: false, title: "Carrier History" });
		const r2 = await other.run("Super Admin", P, { values: payment(), baseline: DISPLAYED() });
		t("§1b a tab the guards do not cover: judged as before, 200, W2 alone written", [r2.code, other.calls.map((c) => c.ranges)], [200, [["'Carrier History'!W2"]]]);
	}
	return results;
}

// ---------------------------------------------------------------------------
// §2 PUT /api/load/:loadId — addressed by load id; the body names the columns.
// ---------------------------------------------------------------------------
async function loadSection(helpers, routeSrc = LOAD_PUT_SRC) {
	const { results, t } = collector();
	const P = { loadId: "111" };
	{
		const app = mount(routeSrc, helpers, STORED());
		const r = await app.run("Super Admin", P, { Details: "Frozen - 2 pallets rolled" });
		t("§2 Super Admin sends Details: 200 { success, load }, the Details cell alone written, USER_ENTERED",
			[r.code, Object.keys(r.body || {}), app.calls.map((c) => [c.valueInputOption, c.ranges, c.values])],
			[200, ["success", "load"], [["USER_ENTERED", [R("C2")], [[["Frozen - 2 pallets rolled"]]]]]]);
		t("§2 Super Admin sends Details: the formulas and the \"=…\" text are untouched",
			[...FORMULAS_KEPT(app.rows), app.rows[1][IDX["Location Link"]]], [PAYMENT_F, DOCS_F, OUTPUT_F, TEXT_EQ]);
		t("§2 Super Admin sends Details: the audit names the cell written, and only it", auditedColumns(app), ["Details"]);
		t("§2 Super Admin sends Details: the answer carries the new value", ((r.body || {}).load || {}).Details, "Frozen - 2 pallets rolled");
	}
	{
		// Every column as displayed, one edited.
		const app = mount(routeSrc, helpers, STORED());
		const body = Object.fromEntries(HEADERS.map((h, i) => [h, DISPLAYED()[i]]));
		body["Trailer Number"] = "TR-9";
		const r = await app.run("Super Admin", P, body);
		t("§2 Super Admin sends every column as displayed, one edited: only that cell written, the formulas kept",
			[r.code, app.calls.map((c) => c.ranges), FORMULAS_KEPT(app.rows), app.rows[1][IDX["Location Link"]]],
			[200, [[R("D2")]], [PAYMENT_F, DOCS_F, OUTPUT_F], TEXT_EQ]);
	}
	{
		const app = mount(routeSrc, helpers, STORED());
		const r = await app.run("Super Admin", P, { "  Payment  ": "$1,800.00", Details: "Frozen", "Location Link": "=starts with an equals sign" });
		t("§2 a save that changes nothing: 200 { success, load, unchanged: true }",
			[r.code, Object.keys(r.body || {}), (r.body || {}).unchanged], [200, ["success", "load", "unchanged"], true]);
		t("§2 a save that changes nothing: no write, no audit line, no cache invalidation, the row as stored",
			[app.calls.length, app.audits.length, app.invalidations(), app.rows[1]], [0, 0, 0, storedRow()]);
	}
	{
		const app = mount(routeSrc, helpers, STORED());
		const r = await app.run("Dispatcher", P, { Email: "someone.else@example.invalid", "Phone Number": "", Details: "Frozen - 2 pallets rolled" });
		t("§2 Dispatcher sends two withheld columns and Details: 200, the Details cell alone written",
			[r.code, app.calls.map((c) => c.ranges)], [200, [[R("C2")]]]);
		t("§2 Dispatcher: the stored contacts are untouched, and the answer serves them blank",
			[WITHHELD.map((c) => app.rows[1][IDX[c]]), WITHHELD.map((c) => ((r.body || {}).load || {})[c])],
			[WITHHELD.map((c) => storedRow()[IDX[c]]), ["", "", ""]]);
	}
	{
		const app = mount(routeSrc, helpers, STORED());
		const r = await app.run("Dispatcher", P, { Details: "=O2" });
		t("§2 Dispatcher, Details \"=O2\": 400 FORMULA_NOT_ALLOWED naming Details, nothing written or audited",
			[r.code, (r.body || {}).code, (r.body || {}).field, app.calls.length, app.audits.length], [400, "FORMULA_NOT_ALLOWED", "Details", 0, 0]);
	}
	{
		const app = mount(routeSrc, helpers, STORED());
		const r = await app.run("Dispatcher", P, { "Location Link": "=starts with an equals sign", "Trailer Number": "TR-9" });
		t("§2 Dispatcher resends the \"=…\" text as displayed and edits Trailer Number: 200, only that cell written, the text still text",
			[r.code, app.calls.map((c) => c.ranges), app.rows[1][IDX["Location Link"]]], [200, [[R("D2")]], TEXT_EQ]);
	}
	return results;
}

// ---------------------------------------------------------------------------
// §3 sheetRowCellWrites() on its own, and where each route calls it.
// ---------------------------------------------------------------------------
function helperSection(helpers) {
	const { results, t } = collector();
	const W = (before, after) => helpers.sheetRowCellWrites("'T'", 7, before, after);
	t("§3 nothing changed: no writes", W(["a", "b", ""], ["a", "b"]), []);
	t("§3 one range per changed cell, in column order, the value as it will be written",
		W(["a", "b", "c", "d"], ["a", "B", "c", "D"]), [{ range: "'T'!B7", values: [["B"]] }, { range: "'T'!D7", values: [["D"]] }]);
	t("§3 compared as text: 5 and \"5\" are the same cell, \"\" and null too",
		W(["5", "", "x"], [5, null, "x"]), []);
	t("§3 null for a filled cell is written as \"\"", W(["x"], [null]), [{ range: "'T'!A7", values: [[""]] }]);
	t("§3 a number that changed is written as the number", W(["5"], [6]), [{ range: "'T'!A7", values: [[6]] }]);
	t("§3 a cell past the end of the stored row", W(["a"], ["a", "", "new"]), [{ range: "'T'!C7", values: [["new"]] }]);
	const at = (i) => { const after = []; after[i] = "v"; return W([], after).map((w) => w.range); };
	t("§3 column letters past Z: 25 Z, 26 AA, 27 AB, 701 ZZ, 702 AAA", [at(25), at(26), at(27), at(701), at(702)],
		[["'T'!Z7"], ["'T'!AA7"], ["'T'!AB7"], ["'T'!ZZ7"], ["'T'!AAA7"]]);
	t("§3 surrounding whitespace is a change (compared exactly, untrimmed)", W(["Delivered"], ["Delivered "]).length, 1);

	// restoreUntouchedCells(before, values, baseline): mutates values, answers
	// whether the baseline was applied.
	const U = (before, values, baseline) => { const v = values.slice(); const applied = helpers.restoreUntouchedCells(before, v, baseline); return [applied, v]; };
	t("§3 restoreUntouchedCells(): a cell sent as opened takes the row as read; an edited cell is kept",
		U(["now-a", "now-b", "now-c"], ["was-a", "edited", "was-c"], ["was-a", "was-b", "was-c"]), [true, ["now-a", "edited", "now-c"]]);
	t("§3 restoreUntouchedCells(): compared as text, null and absent as \"\"; a cell past the row as read takes \"\"",
		U(["x"], [5, null, "", "y"], ["5", "", null, "y"]), [true, ["x", "", "", ""]]);
	t("§3 restoreUntouchedCells(): an edit back to the opened value is no edit",
		U(["sheet"], ["opened"], ["opened"]), [true, ["sheet"]]);
	for (const [label, baseline] of [["absent", undefined], ["null", null], ["a string", "a,b"], ["an object", { 0: "a", 1: "b", length: 2 }], ["one short", ["a"]], ["one long", ["a", "b", "c"]]]) {
		t(`§3 restoreUntouchedCells(): a baseline that is ${label} is ignored, values untouched`,
			U(["s1", "s2"], ["a", "b"], baseline), [false, ["a", "b"]]);
	}

	// PUT /api/data/:rowIndex takes the baseline and applies it once, right
	// after the row read and before every check that judges the row: the Owner
	// ID check, the broker restore, the formula refusal and the diff the period
	// guard and the audit read. PUT /api/load/:loadId takes none.
	{
		const c = decomment(DATA_PUT_SRC);
		const foldAt = c.indexOf("restoreUntouchedCells(before, values, baseline);");
		const order = [c.indexOf("if (rowUnread)"), foldAt, c.indexOf("validateOwnerIdCell("), c.indexOf("restoreWithheldBrokerCells(headers, before, values);"),
			c.indexOf("formulaCellRefusal(headers, before, values);"), c.indexOf("sheetRowAfterUpdate(before, values)")];
		t("§3 PUT /api/data/:rowIndex: reads `baseline` beside `values`, and applies it once",
			[c.includes("const { values, baseline } = req.body || {};"), c.split("restoreUntouchedCells(").length - 1], [true, 1]);
		t("§3 PUT /api/data/:rowIndex: after the row read, before the Owner ID check, the broker restore, the formula refusal and the diff",
			order.every((at, i) => at > 0 && (i === 0 || order[i - 1] < at)), true);
		t("§3 PUT /api/load/:loadId: takes no baseline (its body names the columns it changes)",
			[decomment(LOAD_PUT_SRC).includes("restoreUntouchedCells("), /\bbaseline\b/.test(decomment(LOAD_PUT_SRC))], [false, false]);
	}

	// rowMovedRefusal(headers, rowIndex, before, values, baseline): null when the
	// row as read holds the load the form opened, or when there is nothing to
	// compare; otherwise the 409 ROW_MOVED body and the cells the form edited.
	{
		const HS = ["Contract ID", "Load ID", "  Payment  "];
		const M = (before, values, baseline, headers = HS) => {
			const r = helpers.rowMovedRefusal(headers, 7, before, values, baseline);
			return r && [r.body.code, r.body.rowIndex, r.body.expectedLoadId, r.body.foundLoadId, r.edited.map((c) => [c.column, c.from, c.to, !!c.why])];
		};
		t("§3 rowMovedRefusal(): the row holds the load the form opened: null", M(["c", "111", "$5"], ["c", "111", "$6"], ["c", "111", "$5"]), null);
		t("§3 rowMovedRefusal(): compared as normalizeLoadId() compares, so \" #111 \" and \"111\" are one load",
			M(["c", " #111 ", "$5"], ["c", "111", "$6"], ["c", "111", "$5"]), null);
		t("§3 rowMovedRefusal(): another load: ROW_MOVED naming both, and the edit as the form opened it and as sent",
			M(["c", "222", "$9"], ["c", "111", "$6"], ["c", "111", "$5"]), ["ROW_MOVED", 7, "111", "222", [["Payment", "$5", "$6", true]]]);
		t("§3 rowMovedRefusal(): a Load ID blank on either side, or on both (\"#\" alone is blank), is refused",
			[M(["c", "111"], ["c", "", "x"], ["c", "", "y"]), M(["c"], ["c", "111", "x"], ["c", "111", "y"]), M(["c", "#"], ["c", "", "x"], ["c", "", "y"])].map((r) => r && r.slice(0, 4)),
			[["ROW_MOVED", 7, "", "111"], ["ROW_MOVED", 7, "111", ""], ["ROW_MOVED", 7, "", ""]]);
		t("§3 rowMovedRefusal(): nothing to compare: no load-id column, or a baseline restoreUntouchedCells() ignores",
			[M(["c", "222"], ["c", "111"], ["c", "111"], ["Contract ID", "Reference"]), M(["c", "222"], ["c", "111"], ["c", "111", ""]),
				M(["c", "222"], ["c", "111"], null), M(["c", "222"], ["c", "111"], "c,111")], [null, null, null, null]);
	}
	// PUT /api/data/:rowIndex compares the Load ID on the guarded tabs, after the
	// row read and before the baseline is applied; its DUPLICATE_LOAD check
	// compares with the same normalizeLoadId(); and the two helpers decide
	// whether a baseline applies on one test.
	{
		const c = decomment(DATA_PUT_SRC);
		const checkAt = c.indexOf("const moved = rowMovedRefusal(headers, rowIndex, before, values, baseline);");
		t("§3 PUT /api/data/:rowIndex: rowMovedRefusal() is called once, in `if (guarded)`, after the row read and before restoreUntouchedCells()",
			[c.split("rowMovedRefusal(").length - 1, checkAt > c.indexOf("if (rowUnread)"), checkAt < c.indexOf("restoreUntouchedCells(before, values, baseline);"),
				/if \(guarded\) \{\s*const moved = rowMovedRefusal\(/.test(c)], [1, true, true, true]);
		t("§3 PUT /api/data/:rowIndex: the DUPLICATE_LOAD check compares with normalizeLoadId(), and no inline copy of it is left",
			[/const target = normalizeLoadId\(lidChange\.to\);/.test(c), c.includes("if (normalizeLoadId(cells[i]) === target)"), c.includes('.trim().toLowerCase().replace(/^#/, "")')],
			[true, true, false]);
		t("§3 rowMovedRefusal() and restoreUntouchedCells() decide on baselineApplies(), and rowMovedRefusal() compares with normalizeLoadId()",
			[HELPER_SRC.rowMovedRefusal.includes("if (!baselineApplies(values, baseline)) return null;"),
				HELPER_SRC.restoreUntouchedCells.includes("if (!baselineApplies(values, baseline)) return false;"),
				/normalizeLoadId\(baseline\[col\]\)[\s\S]*normalizeLoadId\(b\[col\]\)/.test(HELPER_SRC.rowMovedRefusal)], [true, true, true]);
	}
	// The Active Loads editor records the row its modal opened with and sends it
	// as `baseline`, in the order of `values`: a column it did not edit is sent
	// as opened in both, so the server leaves it as the sheet holds it.
	{
		const vue = fs.readFileSync(path.join(__dirname, "..", "client", "src", "components", "dashboard", "ActiveLoadsTab.vue"), "utf8");
		const fn = (head) => { const at = vue.indexOf(head); const end = at < 0 ? -1 : vue.indexOf("\n}\n", at); return end < 0 ? "" : vue.slice(at, end); };
		const open = fn("function openEdit() {");
		const submit = fn("async function submitEdit() {");
		t("§3 ActiveLoadsTab.vue: openEdit() records every column as the modal opens it",
			open.includes("editBaseline = Object.fromEntries(props.headers.map(col => [col, selectedJob.value[col] || '']))"), true);
		t("§3 ActiveLoadsTab.vue: submitEdit() builds values and baseline over props.headers, an unedited column from the record in both, and sends both",
			[submit.includes("const values = props.headers.map(col => (has(editForm, col) ? editForm[col] : opened(col)))"),
				submit.includes("const baseline = props.headers.map(opened)"), submit.includes("{ values, baseline }")], [true, true, true]);
	}

	// Where each route calls it: once, with the row as read and the row as it
	// will be written, after the re-read and before the one write; and no
	// whole-row values.update is left in either route.
	const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	for (const [label, src] of [["PUT /api/data/:rowIndex", DATA_PUT_SRC], ["PUT /api/load/:loadId", LOAD_PUT_SRC]]) {
		const c = code(src);
		const callAt = c.indexOf("sheetRowCellWrites(a1, rowIndex, before, after)");
		const writeAt = c.indexOf(".values.batchUpdate(");
		t(`§3 ${label}: calls sheetRowCellWrites(a1, rowIndex, before, after) once and writes through one values.batchUpdate of its answer`,
			[c.split("sheetRowCellWrites(").length - 1, c.split(".values.batchUpdate(").length - 1,
				/requestBody: \{ valueInputOption: "USER_ENTERED", data: cellWrites \}/.test(c)], [1, 1, true]);
		t(`§3 ${label}: no whole-row values.update is left`, c.includes(".values.update("), false);
		t(`§3 ${label}: the cells are worked out after the re-read that proves the row unchanged, and before the write`,
			c.lastIndexOf('"SHEET_CHANGED"') < callAt && callAt < writeAt, true);
	}
	return results;
}

// ---------------------------------------------------------------------------
// §4 MUTANT — back to a whole-row write: sheetRowCellWrites() answering the
// whole row as it will be written, from column A, whatever changed (the write
// both routes made before). Built outside the probe's try, so a mutation
// target that has vanished fails the run instead of reading as "caught".
// ---------------------------------------------------------------------------
const WHOLE_ROW = buildHelpers({
	sheetRowCellWrites: mutate(HELPER_SRC.sheetRowCellWrites,
		"\tconst out = [];\n",
		"\treturn [{ range: `${a1}!A${rowIndex}`, values: [a.map((v) => (v == null ? \"\" : v))] }];\n\tconst out = [];\n"),
});
// §4 MUTANT — the baseline ignored: restoreUntouchedCells() applying none, so
// every cell sent is compared with the row as read, as before the baseline.
const NO_BASELINE = buildHelpers({
	restoreUntouchedCells: mutate(HELPER_SRC.restoreUntouchedCells,
		"\tif (!baselineApplies(values, baseline)) return false;",
		"\treturn false;\n\tif (!baselineApplies(values, baseline)) return false;"),
});
// §4 MUTANT — the identity check removed: PUT /api/data/:rowIndex applying a
// baseline without first comparing its Load ID with the row as read, as it did
// before rowMovedRefusal().
const NO_IDENTITY_SRC = mutate(DATA_PUT_SRC,
	"const moved = rowMovedRefusal(headers, rowIndex, before, values, baseline);",
	"const moved = null;");

(async () => {
	console.log("§1 PUT /api/data/:rowIndex");
	record(await dataSection(H));
	console.log("§1b PUT /api/data/:rowIndex with a baseline");
	record(await baselineSection(H));
	console.log("§2 PUT /api/load/:loadId");
	record(await loadSection(H));
	console.log("§3 sheetRowCellWrites(), restoreUntouchedCells() and the wiring");
	record(helperSection(H));

	console.log("§4 mutants");
	{
		let data = [], load = [], detail = "";
		try {
			data = (await dataSection(WHOLE_ROW)).filter((r) => !r.ok);
			load = (await loadSection(WHOLE_ROW)).filter((r) => !r.ok);
		} catch (e) {
			detail = ` — the probe threw: ${e && e.message ? e.message : e}`;
		}
		const caught = data.length > 0 && load.length > 0;
		if (caught) pass++;
		else { fail++; failures.push(`mutant not caught: back to a whole-row write (§1 failed ${data.length}, §2 failed ${load.length})${detail}`); }
		console.log(`  ${caught ? "caught " : "MISSED "} M1 back to a whole-row write — §1 failed ${data.length} check(s), §2 failed ${load.length}` +
			`${data[0] ? `, e.g. ✗ ${data[0].name}` : ""}${detail}`.slice(0, 260));
	}
	{
		let failed = [], detail = "";
		try {
			failed = (await baselineSection(NO_BASELINE)).filter((r) => !r.ok);
		} catch (e) {
			detail = ` — the probe threw: ${e && e.message ? e.message : e}`;
		}
		const caught = failed.length > 0;
		if (caught) pass++;
		else { fail++; failures.push(`mutant not caught: the baseline ignored (§1b failed ${failed.length})${detail}`); }
		console.log(`  ${caught ? "caught " : "MISSED "} M2 the baseline ignored — §1b failed ${failed.length} check(s)` +
			`${failed[0] ? `, e.g. ✗ ${failed[0].name}` : ""}${detail}`.slice(0, 260));
	}
	{
		let failed = [], detail = "";
		try {
			failed = (await baselineSection(H, NO_IDENTITY_SRC)).filter((r) => !r.ok);
		} catch (e) {
			detail = ` — the probe threw: ${e && e.message ? e.message : e}`;
		}
		const caught = failed.length > 0;
		if (caught) pass++;
		else { fail++; failures.push(`mutant not caught: the identity check removed (§1b failed ${failed.length})${detail}`); }
		console.log(`  ${caught ? "caught " : "MISSED "} M3 the identity check removed — §1b failed ${failed.length} check(s)` +
			`${failed[0] ? `, e.g. ✗ ${failed[0].name}` : ""}${detail}`.slice(0, 260));
	}

	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail) {
		console.log("\nFailures:");
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
