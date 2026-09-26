#!/usr/bin/env node
// A row save writes only the cells it changes: PUT /api/data/:rowIndex and
// PUT /api/load/:loadId.
//
// THE BUG. Both routes read the row as the sheet DISPLAYS it (the Sheets API's
// default FORMATTED_VALUE), and their callers — the Active Loads editor and the
// Data Manager — send every column back as displayed. Both routes then rewrote
// the WHOLE row from column A with valueInputOption USER_ENTERED, so on every
// save, whichever cell was edited:
//   • a formula cell was rewritten as its displayed value, and the formula lost;
//   • a text cell displaying "=…" was read back in as a formula.
// Each route now writes one values.batchUpdate of single-cell ranges, one per
// cell whose value as it will be written differs from the value as read
// (sheetRowCellWrites()), and nothing at all when no cell differs.
//
// WHAT RUNS. Both routes are lifted whole out of server.js and run against a
// fake sheet that behaves as the real one does where it matters here: it stores
// a formula and serves the value it displays, stores text entered with a leading
// apostrophe and serves it without, and applies a write as USER_ENTERED does (a
// value starting with "=" becomes a formula). The broker restore, the formula
// refusal, the row diff, the column letters, the cell writes and the audit
// builder are the shipped code. The period guard, the Owner ID check and the
// tab resolver are stubbed; their own runners cover them.
//   §1 PUT /api/data/:rowIndex
//   §2 PUT /api/load/:loadId
//   §3 sheetRowCellWrites() on its own, and where each route calls it
//   §4 MUTANT: back to a whole-row write. It must fail checks in §1 and in §2.
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
	"sheetRowAfterUpdate", "a1SheetPrefix", "a1ColumnLetter", "sheetRowCellWrites",
	"guardedColumnReason", "changedGuardedCells", "scrubPurgeMarker", "capAuditField", "buildSheetUpdateAudit",
];
const HELPER_SRC = Object.fromEntries(HELPERS.map((n) => [n, extract(n)]));
// The shipped helpers, with `overrides` swapping one source for a mutant.
function buildHelpers(overrides = {}) {
	const s = { ...HELPER_SRC, ...overrides };
	return new Function(`"use strict";\n${CONSTS}\n${HELPERS.map((n) => s[n]).join("\n")}\nreturn { ${HELPERS.join(", ")} };`)();
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
const DOCS_F = '=HYPERLINK("https://example.invalid/pod/111.pdf","POD")';
const OUTPUT_F = "=ROUND(1800/950,2)";
const TEXT_EQ = "'=starts with an equals sign";
// What the sheet displays for each formula the fixture stores.
const SHOWS = { [PAYMENT_F]: "$1,800.00", [DOCS_F]: "POD", [OUTPUT_F]: "1.89" };
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
			return { data: { values: n ? [shown(rows[n - 1])] : rows.map(shown) } };
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
	let invalidations = 0;
	let handler = null;
	const env = {
		...helpers,
		app: { put: (p, gate, h) => { handler = h; } },
		requireRole: () => null,
		getSheets: sheet.getSheets,
		SPREADSHEET_ID: "sheet-under-test",
		SHEET_ROW_MAX_CELLS: 20000,
		PERIOD_GUARDED_SHEETS: ["Job Tracking"],
		getSheetName: (req) => (req.query && req.query.sheet) || "Job Tracking",
		resolveSheetTargetForWrite: async () => ({ resolved: true, metaUnreadable: false, title, guarded }),
		validateOwnerIdCell: () => null,
		sheetRowUpdateBlocker: () => null,
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
	return { run, rows: sheet.rows, calls: sheet.calls, audits, invalidations: () => invalidations };
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

(async () => {
	console.log("§1 PUT /api/data/:rowIndex");
	record(await dataSection(H));
	console.log("§2 PUT /api/load/:loadId");
	record(await loadSection(H));
	console.log("§3 sheetRowCellWrites()");
	record(helperSection(H));

	console.log("§4 mutant");
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
