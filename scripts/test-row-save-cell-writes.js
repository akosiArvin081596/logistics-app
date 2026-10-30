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
//   §5 THE CANCEL REFUSAL (ROW_EDITOR_CANCEL_GUARD_ENABLED). On: both saves
//      refuse a status changed TO cancelled (excludeDroppedLoads()'s own test,
//      any case, trimmed), 400 CANCEL_NOT_A_ROW_EDIT naming POST
//      /api/dispatch/cancel, nothing written, the refusal audited; a row
//      already cancelled, a change away from cancelled and every other status
//      edit save, and POST /api/dispatch/cancel, lifted onto the same fake
//      sheet, still cancels. Off: each save as today. Then the wiring, from
//      source, and rowEditCancelRefusal()'s column rule on its own.
//   §6 MUTANTS of §5: either save without the refusal, the cell judged
//      untrimmed, a row already cancelled refused, the flag ignored. Each must
//      fail §5's behaviour checks.
//
// No network, no database, no sheet.
//   node scripts/test-row-save-cell-writes.js     # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");

const SRC = require("./lib/server-source").serverSource();

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
// A top-level function (or async function), from its declaration to the first
// `}` in column 0.
function extract(name) {
	const plain = `\nfunction ${name}(`;
	const needle = SRC.includes(plain) ? plain : `\nasync function ${name}(`;
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
	// The Load ID rule a non-Super-Admin's ROW_MOVED check reads
	// (staffRowMovedRefusal()), and the sheet it reads again.
	extractConst("const SHOWN_LOAD_ID_INDEX = "),
	extractConst("const SHOWN_LOAD_ID_INDEXES = "),
	extractConst("const SHOWN_LOAD_ID_STATE = "),
	'const SPREADSHEET_ID = "sheet-under-test";',
	// The money filter's cancelled test, which the cancel refusal judges with.
	extractConst("const CANCELED_STATUS_RE = "),
].join("\n");
const HELPERS = [
	"resolveBrokerWithheldColumns", "sanitizeBrokerColumns", "restoreWithheldBrokerCells", "formulaCellRefusal",
	"normalizeDriverName", "isBuiltInPropertyName", "reservedDriverNameRefusal", "driverCellRefusal",
	"sheetRowAfterUpdate", "a1SheetPrefix", "a1ColumnLetter", "sheetRowCellWrites", "restoreUntouchedCells",
	"baselineApplies", "rowMovedRefusal",
	"shownLoadIdIndex", "currentShownLoadIdIndex", "loadIdWithheldFor", "shownLoadId", "staffRowMovedRefusal",
	"guardedColumnReason", "changedGuardedCells", "scrubPurgeMarker", "capAuditField", "buildSheetUpdateAudit",
	"findCol",
];
// The cancel refusal's helper, lifted only when server.js has it, so a base
// copy without it still runs every section (and fails §5, as it must).
const GUARD_HELPERS = SRC.includes("\nfunction rowEditCancelRefusal(") ? ["rowEditCancelRefusal"] : [];
const ALL_HELPERS = [...HELPERS, ...GUARD_HELPERS];
const HELPER_SRC = Object.fromEntries(ALL_HELPERS.map((n) => [n, extract(n)]));
// The load-id comparison key server.js imports, the shipped module.
const { normalizeLoadId } = require("../lib/ratecon-load");
// The WITHHELD LOAD KEYS helpers PUT /api/load/:loadId reads its load ID
// through, as shipped (flag off, no key named: the ID as sent).
const KEY_HELPERS = require("./lib/withheld-load-key-lift").withheldLoadKeyHelpers(SRC);
// The shipped helpers, with `overrides` swapping one source for a mutant.
// The broker contact value rule the reader and both saves apply: the shipped
// module and kill switch, handed to the routes with the helpers.
const BROKER_CONTACT_SRC = [
	extractConst("const brokerContact = "),
	extractConst("const BROKER_CONTACT_VALUE_REDACTION_ENABLED = "),
].join("\n");
const libRequire = (p) => require(/^\.\/lib\//.test(p) ? path.join(__dirname, "..", p) : p);
function buildHelpers(overrides = {}) {
	const s = { ...HELPER_SRC, ...overrides };
	return new Function("normalizeLoadId", "require",
		`"use strict";\n${CONSTS}\n${BROKER_CONTACT_SRC}\n${ALL_HELPERS.map((n) => s[n]).join("\n")}\n` +
		`return { ${ALL_HELPERS.join(", ")}, BROKER_WITHHELD_RE, brokerContact, BROKER_CONTACT_VALUE_REDACTION_ENABLED };`)(normalizeLoadId, libRequire);
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
		[IDX["Driver"]]: "Soren King", [IDX["Pickup Address"]]: "1 Main St, Houston, TX 77002",
		[IDX["Job Status"]]: "Delivered", [IDX["Broker Contact Name"]]: "Della Garcia",
		[IDX["Phone Number"]]: "555-0142", [IDX["Email"]]: "della.garcia@example.invalid",
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
function fakeSheet(stored, { batchGetFails = false, allowUpdate = false } = {}) {
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
		// One cell, as POST /api/dispatch/cancel writes; only a sheet made for it
		// takes one, so a row save reaching for it still fails.
		update: async ({ range, valueInputOption, requestBody }) => {
			if (!allowUpdate) throw new Error("fake sheet: values.update is not expected here");
			const m = /!([A-Z]+)(\d+)$/.exec(range);
			if (!m) throw new Error(`fake sheet: unreadable range ${range}`);
			calls.push({ verb: "update", valueInputOption, ranges: [range], values: [requestBody.values] });
			const r = rows[Number(m[2]) - 1] || (rows[Number(m[2]) - 1] = []);
			const i = colIndex(m[1]);
			while (r.length <= i) r.push("");
			const v = requestBody.values[0][0];
			r[i] = v == null ? "" : String(v);
			return { data: { updatedCells: 1 } };
		},
	};
	return { getSheets: async () => ({ spreadsheets: { values } }), rows, calls };
}

// One lifted route over one fake sheet (`sheet`: one already made, shared by
// several routes). `cancelGuard` is ROW_EDITOR_CANCEL_GUARD_ENABLED, off as on
// a server that does not set it.
function mount(routeSrc, helpers, stored, { guarded = true, title = "Job Tracking", batchGetFails = false, cancelGuard = false, sheet: shared = null } = {}) {
	const sheet = shared || fakeSheet(stored, { batchGetFails });
	const audits = [];
	// What the stubbed Owner ID check and period guard were asked to judge: the
	// Owner ID cell, and the changed guarded cells as [column, from, to].
	const ownerSeen = [];
	const guardCalls = [];
	// PERSON EDIT HOLD: what each successful save handed recordPersonCellEdits()
	// (its own runner, scripts/test-keep-stored-person-hold.js, covers what it records).
	const personCalls = [];
	let invalidations = 0;
	let handler = null;
	const env = {
		...helpers,
		...KEY_HELPERS,
		normalizeLoadId,
		app: { put: (p, gate, h) => { handler = h; } },
		requireRole: () => null,
		DRIVER_AVAILABILITY_ENABLED: false,
		ROW_EDITOR_CANCEL_GUARD_ENABLED: cancelGuard,
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
		// `code` is what logAuditRefusal() coalesces a refusal under.
		logAuditRefusal: (req, action, entity, entityId, details, code) => { audits.push({ action, entityId, details, code }); },
		jtCacheInvalidate: () => { invalidations++; },
		recordPersonCellEdits: (req, sheetName, hs, before, after) => {
			personCalls.push({ role: req.session.user.role, sheetName, pickup: [before[IDX["Pickup Appointment"]] || "", after[IDX["Pickup Appointment"]] || ""], headers: hs.length });
		},
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
	return { run, rows: sheet.rows, calls: sheet.calls, audits, ownerSeen, guardCalls, personCalls, invalidations: () => invalidations };
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
		t("§1 a save that changes nothing: no person record", app.personCalls.length, 0);
		t("§1 a save that changes nothing: the row is exactly as stored", app.rows[1], storedRow());
	}
	{
		// PERSON EDIT HOLD: a Dispatcher's date edit is handed to the person record, after the write.
		const app = mount(routeSrc, helpers, STORED());
		const values = DISPLAYED().map((v, i) => (WITHHELD.includes(HEADERS[i]) ? "" : v));
		values[IDX["Pickup Appointment"]] = "10/13/2026 09:00";
		const r = await app.run("Dispatcher", P, { values });
		t("§1 Dispatcher edits the Pickup Appointment: written, and handed to the person record once, with the row before and after",
			[r.code, app.calls.map((c) => c.ranges), app.personCalls],
			[200, [[R("H2")]], [{ role: "Dispatcher", sheetName: "Job Tracking", pickup: ["", "10/13/2026 09:00"], headers: HEADERS.length }]]);
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
		// PERSON EDIT HOLD: a Dispatcher's date edit through this route is handed to the person record.
		const app = mount(routeSrc, helpers, STORED());
		const r = await app.run("Dispatcher", P, { "Pickup Appointment": "10/13/2026 09:00" });
		t("§2 Dispatcher sends a Pickup Appointment: written, and handed to the person record once, on Job Tracking",
			[r.code, app.calls.map((c) => c.ranges), app.personCalls],
			[200, [[R("H2")]], [{ role: "Dispatcher", sheetName: "Job Tracking", pickup: ["", "10/13/2026 09:00"], headers: HEADERS.length }]]);
		const none = mount(routeSrc, helpers, STORED());
		await none.run("Super Admin", P, { Details: "Frozen" });
		t("§2 a save that writes nothing: no person record", none.personCalls.length, 0);
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
// §5 THE CANCEL REFUSAL (ROW_EDITOR_CANCEL_GUARD_ENABLED). Load 111 on row 2,
// load 222 on row 3; every case builds its save from the row as displayed.
// ---------------------------------------------------------------------------
const OTHER_ROW = () => storedRow({ "Load ID": "222", Details: "Dry van", "Location Link": "" });
const STORE_AT = (status, over = {}) => [HEADERS.slice(), storedRow({ "Job Status": status, ...over }), OTHER_ROW()];
// A stored row as the sheet displays it, every column (what the editors send).
const shownRow = (row) => HEADERS.map((h, i) => display(row[i]));
// The same, as served to a Dispatcher: the withheld contact columns blank.
const asStaff = (row) => row.map((v, i) => (WITHHELD.includes(HEADERS[i]) ? "" : v));
// Every spelling the money filter reads as cancelled, in any case and with
// surrounding whitespace (a no-break space included: String#trim() strips it).
const CANCEL_SPELLINGS = ["Cancelled", "cancelled", "CANCELLED", "Canceled", "canceled", "CANCELED", "Cancel", "cancel", "CANCEL",
	"cAnCeLlEd", " Cancelled ", "\tcanceled\n", " Cancel "];
// Statuses the money filter does not read as cancelled, so neither may the refusal.
const NOT_CANCELLED = ["Delivered", "", "Cancellation requested", "Not cancelled", "Cancelled - rebooked", "Cancelledd", "Can celled", "Canceled?", "Cancel led"];
// The money filter as shipped: does excludeDroppedLoads() drop load 111 with `status`?
const MONEY = new Function("normalizeLoadId",
	`"use strict";\n${extractConst("const CANCELED_STATUS_RE = ")}\n${extract("findCol")}\n${extract("loadKeySet")}\n${extract("excludeDroppedLoads")}\n` +
	"return { excludeDroppedLoads };")(normalizeLoadId);
function moneyDrops(status) {
	const row = storedRow({ "Job Status": status });
	return MONEY.excludeDroppedLoads([Object.fromEntries(HEADERS.map((h, i) => [h, row[i]]))], HEADERS, new Set()).length === 0;
}

// POST /api/dispatch/cancel lifted whole, with the helpers it reads (the row
// read, the row-number check, the load binding, the completed-load check and
// the binding refusal) as shipped; what it writes beyond the sheet is recorded.
const CANCEL_SRC = extractRoute('app.post("/api/dispatch/cancel", requireRole("Super Admin"), async (req, res) => {');
const CANCEL_HELPERS_SRC = [extractConst("const normLoadKey = "),
	...["colLetter", "identityRoomKey", "driverRoom", "scrubPurgeMarker", "resolveSheetDataRow", "readJobTrackingSnapshot",
		"resolveLoadBinding", "completedLoadCancelRefusal", "sendLoadBindRefusal"].map(extract)].join("\n");
function mountCancel(sheet, { cancelGuard = true } = {}) {
	const audits = [], history = [], driverNotices = [];
	let handler = null;
	const env = {
		app: { post: (p, gate, h) => { handler = h; } },
		requireRole: () => null,
		getSheets: sheet.getSheets,
		SPREADSHEET_ID: "sheet-under-test",
		ROW_EDITOR_CANCEL_GUARD_ENABLED: cancelGuard,
		recordStatusChange: (rec) => { history.push(rec); },
		logAudit: (req, action, entity, entityId, details) => { audits.push({ action, entityId, details }); },
		logAuditRefusal: (req, action, entity, entityId, details, code) => { audits.push({ action, entityId, details, code }); },
		insertNotification: { run: (driver) => { driverNotices.push(driver); return { lastInsertRowid: 1 }; } },
		io: { to: () => ({ emit() {} }) },
		insertDispatchNotification: { run: () => ({}) },
		emitDispatchNotice: () => {},
		notifyChange: () => {},
		jtCacheInvalidate: () => {},
		console: { error() {}, log() {}, warn() {} },
	};
	const names = Object.keys(env);
	new Function(...names, `${CANCEL_HELPERS_SRC}\n${CANCEL_SRC}`)(...names.map((k) => env[k]));
	if (typeof handler !== "function") throw new Error("the lifted cancel route did not register a handler");
	const run = async (body) => {
		const out = { code: 200, body: null };
		const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
		await handler({ body, session: { user: { id: 1, role: "Super Admin", username: "super_admin" } } }, res);
		return out;
	};
	return { run, audits, history, driverNotices };
}

// The behaviour. `dataSrc` / `loadSrc` / `helpers` take a mutant (§6).
async function cancelSection(helpers, { dataSrc = DATA_PUT_SRC, loadSrc = LOAD_PUT_SRC } = {}) {
	const { results, t } = collector();
	const P = { rowIndex: "2" };
	const L = { loadId: "111" };
	const on = { cancelGuard: true };
	const CODE = "CANCEL_NOT_A_ROW_EDIT";
	const ranges = (app) => app.calls.map((c) => c.ranges);
	// A refusal: 400, the code, the column, a message naming the cancel route, and no write.
	const refused = (r, app) => {
		const b = r.body || {};
		return [r.code, b.code || null, b.field || null, /POST \/api\/dispatch\/cancel/.test(String(b.error || "")), app.calls.length];
	};
	const REFUSED = [400, CODE, "Job Status", true, 0];
	// What the refusal leaves on the audit trail: one update_sheet_row_blocked row
	// on the row, coalesced under the code.
	const trail = (app) => app.audits.map((a) => [a.action, a.entityId, a.code || null, a.details.endsWith(` [${CODE}]`)]);
	const TRAIL = [["update_sheet_row_blocked", "Job Tracking!2", CODE, true]];
	// That row's details: the JSON before the stubbed " [CODE]" suffix.
	const trailJson = (app) => {
		const a = app.audits.find((x) => x.action === "update_sheet_row_blocked");
		const m = a && /^([\s\S]*) \[[A-Z_]+\]$/.exec(a.details);
		try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
	};
	// A save of the row as displayed with Job Status set to `status`: a Super
	// Admin's Data Manager save (every column, no baseline), or a Dispatcher's
	// save in the Active Loads editor's shape (withheld columns blank, with a
	// baseline).
	const statusSave = (store, status, { staff = false } = {}) => {
		const opened = staff ? asStaff(shownRow(store[1])) : shownRow(store[1]);
		const values = opened.slice();
		values[IDX["Job Status"]] = status;
		return staff ? { values, baseline: opened.slice() } : { values };
	};

	// PUT /api/data/:rowIndex, flag on.
	{
		const store = STORE_AT("Dispatched");
		const app = mount(dataSrc, helpers, store, on);
		const r = await app.run("Super Admin", P, statusSave(store, "Cancelled"));
		t("§5 PUT /api/data, flag on: a Super Admin setting Job Status to Cancelled gets 400 CANCEL_NOT_A_ROW_EDIT naming the column and POST /api/dispatch/cancel; nothing written",
			refused(r, app), REFUSED);
		t("§5 ...the row is exactly as stored, the cache kept, no person record", [app.rows[1], app.invalidations(), app.personCalls.length], [store[1], 0, 0]);
		t("§5 ...one audit row: update_sheet_row_blocked on Job Tracking!2, coalesced under CANCEL_NOT_A_ROW_EDIT", trail(app), TRAIL);
		const d = trailJson(app);
		t("§5 ...naming the cell asked for, as read and as sent", d && [d.outcome, d.code, d.changed.map((c) => [c.column, c.from, c.to])],
			["blocked", CODE, [["Job Status", "Dispatched", "Cancelled"]]]);
		t("§5 ...refused before the period guard judged the row", app.guardCalls, []);
	}
	{
		const store = STORE_AT("Dispatched");
		const app = mount(dataSrc, helpers, store, on);
		const r = await app.run("Dispatcher", P, statusSave(store, "Cancelled", { staff: true }));
		t("§5 PUT /api/data, flag on: a Dispatcher's save with a baseline setting Job Status to Cancelled is refused the same way", refused(r, app), REFUSED);
		t("§5 ...and audited the same way", trail(app), TRAIL);
	}
	{
		const store = STORE_AT("Dispatched");
		const app = mount(dataSrc, helpers, store, on);
		const save = statusSave(store, "Cancelled");
		save.values[IDX["Details"]] = "Broker called it off";
		const r = await app.run("Super Admin", P, save);
		t("§5 PUT /api/data, flag on: a save that also edits Details is refused whole: Details not written either",
			[...refused(r, app), app.rows[1][IDX["Details"]]], [...REFUSED, "Frozen"]);
	}

	// PUT /api/load/:loadId, flag on.
	{
		const store = STORE_AT("Dispatched");
		const app = mount(loadSrc, helpers, store, on);
		const r = await app.run("Super Admin", L, { "Job Status": "Cancelled" });
		t("§5 PUT /api/load, flag on: a Super Admin setting Job Status to Cancelled gets 400 CANCEL_NOT_A_ROW_EDIT naming the column and POST /api/dispatch/cancel; nothing written",
			refused(r, app), REFUSED);
		t("§5 ...the row is exactly as stored, the cache kept", [app.rows[1], app.invalidations()], [store[1], 0]);
		t("§5 ...one audit row: update_sheet_row_blocked on Job Tracking!2, coalesced under CANCEL_NOT_A_ROW_EDIT", trail(app), TRAIL);
		const d = trailJson(app);
		t("§5 ...naming the load, the door and the cell asked for", d && [d.outcome, d.code, d.loadId, d.via, d.changed.map((c) => [c.column, c.from, c.to])],
			["blocked", CODE, "111", "PUT /api/load/:loadId", [["Job Status", "Dispatched", "Cancelled"]]]);
		t("§5 ...refused before the period guard judged the row", app.guardCalls, []);
	}
	{
		const store = STORE_AT("Dispatched");
		const app = mount(loadSrc, helpers, store, on);
		const r = await app.run("Dispatcher", L, { Details: "Frozen - 2 pallets rolled", "Job Status": "canceled" });
		t("§5 PUT /api/load, flag on: a Dispatcher's body with Details and a cancelled status is refused whole: Details not written either",
			[...refused(r, app), app.rows[1][IDX["Details"]]], [...REFUSED, "Frozen"]);
	}

	// Every spelling, on both saves; and nothing the money filter keeps live.
	{
		const verdicts = [];
		for (const s of [...CANCEL_SPELLINGS, ...NOT_CANCELLED]) {
			const store = STORE_AT("Dispatched");
			const a = mount(dataSrc, helpers, store, on);
			const ra = await a.run("Super Admin", P, statusSave(store, s));
			const b = mount(loadSrc, helpers, store, on);
			const rb = await b.run("Dispatcher", L, { "Job Status": s });
			const isRefusal = (r, app) => r.code === 400 && (r.body || {}).code === CODE && app.calls.length === 0;
			const isSave = (r, app) => r.code === 200 && JSON.stringify(ranges(app)) === JSON.stringify([[R("L2")]]) && app.rows[1][IDX["Job Status"]] === s;
			verdicts.push({ s, drops: moneyDrops(s), dataRefused: isRefusal(ra, a), loadRefused: isRefusal(rb, b), dataSaved: isSave(ra, a), loadSaved: isSave(rb, b) });
		}
		const show = (list) => list.map((v) => v.s);
		t("§5 flag on: every cancelled spelling (any case, surrounding whitespace) is refused by PUT /api/data, nothing written",
			show(verdicts.filter((v) => CANCEL_SPELLINGS.includes(v.s) && !v.dataRefused)), []);
		t("§5 flag on: ...and by PUT /api/load", show(verdicts.filter((v) => CANCEL_SPELLINGS.includes(v.s) && !v.loadRefused)), []);
		t("§5 flag on: a status the money filter keeps live saves on PUT /api/data (L2 written as sent)",
			show(verdicts.filter((v) => NOT_CANCELLED.includes(v.s) && !v.dataSaved)), []);
		t("§5 flag on: ...and on PUT /api/load", show(verdicts.filter((v) => NOT_CANCELLED.includes(v.s) && !v.loadSaved)), []);
		t("§5 flag on: both saves refuse a status exactly when excludeDroppedLoads() would drop the load for it",
			show(verdicts.filter((v) => v.dataRefused !== v.drops || v.loadRefused !== v.drops)), []);
		t("§5 (fixture) the money filter drops every spelling listed as cancelled, and none of the others",
			[CANCEL_SPELLINGS.filter((s) => !moneyDrops(s)), NOT_CANCELLED.filter(moneyDrops)], [[], []]);
	}

	// Flag off: today's saves.
	{
		const store = STORE_AT("Dispatched");
		const a = mount(dataSrc, helpers, store);
		const ra = await a.run("Super Admin", P, statusSave(store, "Cancelled"));
		t("§5 PUT /api/data, flag off: setting Job Status to Cancelled saves as today: 200 { success, updatedCells: 1 }, L2 written, audited update_sheet_row",
			[ra.code, ra.body, a.calls.map((c) => [c.ranges, c.values]), a.audits.map((x) => [x.action, x.code || null]), auditedColumns(a)],
			[200, { success: true, updatedCells: 1 }, [[[R("L2")], [[["Cancelled"]]]]], [["update_sheet_row", null]], ["Job Status"]]);
		const l = mount(loadSrc, helpers, store);
		const rl = await l.run("Super Admin", L, { "Job Status": " canceled " });
		t("§5 PUT /api/load, flag off: saves as today: 200, L2 written, the answer carries it",
			[rl.code, ranges(l), ((rl.body || {}).load || {})["Job Status"], l.audits.map((x) => x.action)], [200, [[R("L2")]], " canceled ", ["update_sheet_row"]]);
	}

	// Other status edits, flag on.
	for (const [from, to] of [["Dispatched", "In Transit"], ["In Transit", "Delivered"], ["Delivered", "Completed"], ["Dispatched", "Unassigned"]]) {
		const store = STORE_AT(from);
		const a = mount(dataSrc, helpers, store, on);
		const ra = await a.run("Super Admin", P, statusSave(store, to));
		const d = mount(dataSrc, helpers, store, on);
		const rd = await d.run("Dispatcher", P, statusSave(store, to, { staff: true }));
		const b = mount(loadSrc, helpers, store, on);
		const rb = await b.run("Dispatcher", L, { "Job Status": to });
		t(`§5 flag on: ${from} → ${to} saves on PUT /api/data (both editors) and PUT /api/load, L2 written`,
			[ra.code, ranges(a), rd.code, ranges(d), rb.code, ranges(b)], [200, [[R("L2")]], 200, [[R("L2")]], 200, [[R("L2")]]]);
	}

	// A row already cancelled, flag on.
	{
		const store = STORE_AT("Cancelled", { Driver: "" });
		const opened = asStaff(shownRow(store[1]));
		const values = opened.slice();
		values[IDX["Details"]] = "Broker re-sent the BOL";
		const a = mount(dataSrc, helpers, store, on);
		const ra = await a.run("Dispatcher", P, { values, baseline: opened.slice() });
		t("§5 flag on, a row already cancelled: a Dispatcher's Details edit saves, its status sent back as shown (C2 alone written)",
			[ra.code, ranges(a)], [200, [[R("C2")]]]);
		const b = mount(dataSrc, helpers, store, on);
		const rb = await b.run("Super Admin", P, statusSave(store, "canceled"));
		t("§5 ...respelling Cancelled as \"canceled\" saves: the row was cancelled already", [rb.code, ranges(b)], [200, [[R("L2")]]]);
		const c = mount(dataSrc, helpers, store, on);
		const rc = await c.run("Super Admin", P, statusSave(store, "Dispatched"));
		t("§5 ...Cancelled → Dispatched saves: a change away from cancelled is not judged", [rc.code, ranges(c)], [200, [[R("L2")]]]);
		const e = mount(loadSrc, helpers, store, on);
		const re = await e.run("Dispatcher", L, { "Job Status": "Unassigned", Details: "Back on the board" });
		t("§5 ...and through PUT /api/load: Cancelled → Unassigned with Details saves", [re.code, ranges(e)], [200, [[R("C2"), R("L2")]]]);
		const odd = STORE_AT("  CANCEL ");
		const f = mount(loadSrc, helpers, odd, on);
		const rf = await f.run("Super Admin", L, { "Job Status": "Cancelled" });
		t("§5 ...a row stored as \"  CANCEL \" is cancelled already to the money filter: setting it to Cancelled saves", [rf.code, ranges(f)], [200, [[R("L2")]]]);
	}

	// What the refusal does not judge, flag on.
	{
		const store = STORE_AT("Dispatched");
		const a = mount(dataSrc, helpers, store, { ...on, guarded: false, title: "Carrier History" });
		const ra = await a.run("Super Admin", P, statusSave(store, "Cancelled"));
		t("§5 flag on, a tab the guards do not cover: its status column set to Cancelled saves", [ra.code, ranges(a)], [200, [["'Carrier History'!L2"]]]);
		const b = mount(dataSrc, helpers, store, on);
		const values = shownRow(store[1]);
		values[IDX["Status Update Date"]] = "Cancelled";
		const rb = await b.run("Super Admin", P, { values });
		t("§5 flag on: \"Cancelled\" typed into Status Update Date is not a status change (S2 written)", [rb.code, ranges(b)], [200, [[R("S2")]]]);
	}

	// POST /api/dispatch/cancel still cancels, flag on, on the same fake sheet.
	{
		const sheet = fakeSheet(STORE_AT("Dispatched"), { allowUpdate: true });
		const cancel = mountCancel(sheet);
		const r = await cancel.run({ rowIndex: 2, loadId: "111", reason: "Broker called it off" });
		t("§5 POST /api/dispatch/cancel, flag on: 200 { success: true }, row 2's Job Status Cancelled and Driver blank, row 3 untouched",
			[r.code, r.body, sheet.rows[1][IDX["Job Status"]], sheet.rows[1][IDX["Driver"]], sheet.rows[2]], [200, { success: true }, "Cancelled", "", OTHER_ROW()]);
		t("§5 ...with its record: the history row (account and reason), the cancel_load audit row, the driver told",
			[cancel.history, cancel.audits.map((a) => [a.action, a.entityId, / — reason: Broker called it off$/.test(a.details)]), cancel.driverNotices],
			[[{ loadId: "111", newStatus: "Cancelled", source: "cancel", actor: "super_admin", reason: "Broker called it off" }], [["cancel_load", "111", true]], ["soren king"]]);
	}
	// One load end to end, flag on: the row edit is refused, the cancel route
	// cancels, a later edit of the cancelled row saves, and a row edit revives it.
	{
		const store = STORE_AT("Dispatched");
		const sheet = fakeSheet(store, { allowUpdate: true });
		const r1 = await mount(dataSrc, helpers, null, { ...on, sheet }).run("Dispatcher", P, statusSave(store, "Cancelled", { staff: true }));
		const r2 = await mountCancel(sheet).run({ rowIndex: 2, loadId: "111", reason: "Shipper closed for the day" });
		const reopened = asStaff(shownRow(sheet.rows[1]));
		const edit = reopened.slice();
		edit[IDX["Details"]] = "Rebook next week";
		const r3 = await mount(dataSrc, helpers, null, { ...on, sheet }).run("Dispatcher", P, { values: edit, baseline: reopened.slice() });
		const revive = shownRow(sheet.rows[1]);
		revive[IDX["Job Status"]] = "Dispatched";
		const r4 = await mount(dataSrc, helpers, null, { ...on, sheet }).run("Super Admin", P, { values: revive });
		t("§5 flag on, one load end to end: the Dispatcher's row edit to Cancelled 400, the cancel route 200, a Details edit of the cancelled row 200, a Super Admin's revive 200",
			[r1.code, (r1.body || {}).code || null, r2.code, r3.code, r4.code, sheet.rows[1][IDX["Details"]], sheet.rows[1][IDX["Job Status"]]],
			[400, CODE, 200, 200, 200, "Rebook next week", "Dispatched"]);
	}
	return results;
}

// The wiring, from source, and the helper's column rule on its own.
function cancelWiringSection(helpers) {
	const { results, t } = collector();
	const CODE = "CANCEL_NOT_A_ROW_EDIT";
	const flagLines = SRC.split("\n").filter((l) => /^const ROW_EDITOR_CANCEL_GUARD_ENABLED\b/.test(l));
	t("§5 wiring: the flag is defined once, at column 0, read once from the environment",
		flagLines, ['const ROW_EDITOR_CANCEL_GUARD_ENABLED = process.env.ROW_EDITOR_CANCEL_GUARD_ENABLED === "true";']);
	const flagOn = (v) => {
		try {
			return new Function("process", `${flagLines[0] || ""}\nreturn typeof ROW_EDITOR_CANCEL_GUARD_ENABLED === "undefined" ? null : ROW_EDITOR_CANCEL_GUARD_ENABLED;`)(
				{ env: v === undefined ? {} : { ROW_EDITOR_CANCEL_GUARD_ENABLED: v } });
		} catch { return null; }
	};
	t("§5 wiring: on only for exactly \"true\": unset, \"\", \"false\", \"TRUE\", \"1\", \"yes\" and \" true\" leave it off",
		[undefined, "", "false", "TRUE", "1", "yes", " true", "true"].map(flagOn), [false, false, false, false, false, false, false, true]);

	// Each save asks once, inside the flag, on the row as it will be written:
	// after the restores and refusals that shape it, before the Load ID check,
	// the period guard and the write.
	const CALL = "const cancel = rowEditCancelRefusal(headers, before, after);";
	const ordered = (c, marks) => marks.every((m, i) => c.indexOf(m) > -1 && (i === 0 || c.indexOf(marks[i - 1]) < c.indexOf(m)));
	for (const [label, src, marks] of [
		["PUT /api/data/:rowIndex", DATA_PUT_SRC, ["restoreUntouchedCells(before, values, baseline);", "formulaCellRefusal(headers, before, values);",
			"driverCellRefusal(headers, before, values);", "const after = sheetRowAfterUpdate(before, values);", "const auditDetails = ", CALL,
			"const lidChange = ", "sheetRowUpdateBlocker(", ".values.batchUpdate("]],
		["PUT /api/load/:loadId", LOAD_PUT_SRC, ["formulaCellRefusal(headers, before, updatedRow);", "driverCellRefusal(headers, before, updatedRow);",
			"const after = sheetRowAfterUpdate(before, updatedRow);", "validateOwnerIdCell(sheetName, headers, updatedRow);", "const auditDetails = ", CALL,
			"const lidChange = ", "sheetRowUpdateBlocker(", ".values.batchUpdate("]],
	]) {
		const c = decomment(src);
		t(`§5 wiring, ${label}: asks rowEditCancelRefusal(headers, before, after) once, inside \`if (ROW_EDITOR_CANCEL_GUARD_ENABLED && guarded)\``,
			[c.split("rowEditCancelRefusal(").length - 1, /if \(ROW_EDITOR_CANCEL_GUARD_ENABLED && guarded\) \{\s*const cancel = rowEditCancelRefusal\(headers, before, after\);/.test(c)], [1, true]);
		t(`§5 wiring, ${label}: on the row as it will be written, before the Load ID check, the period guard and the write`, ordered(c, marks), true);
		t(`§5 wiring, ${label}: a refusal is audited update_sheet_row_blocked under its own code (coalesced), then answered 400`,
			/if \(cancel\) \{\s*logAuditRefusal\(req, "update_sheet_row_blocked", "sheet_row", `\$\{sheetName\}!\$\{rowIndex\}`, sheetAuditWithCode\(auditDetails\("blocked", \{ code: cancel\.code \}\), cancel\.code\), cancel\.code\);\s*return res\.status\(400\)\.json\(cancel\);/.test(c),
			true);
	}
	const code = decomment(SRC);
	t("§5 wiring: rowEditCancelRefusal() is defined once and asked by the two row saves only", code.split("rowEditCancelRefusal(").length - 1, 3);
	t("§5 wiring: POST /api/dispatch/cancel neither reads the flag nor asks the refusal (it is the way to cancel)",
		/ROW_EDITOR_CANCEL_GUARD_ENABLED|rowEditCancelRefusal|CANCEL_NOT_A_ROW_EDIT/.test(decomment(CANCEL_SRC)), false);
	const helperSrc = decomment(HELPER_SRC.rowEditCancelRefusal || "");
	// Its code with the string and template literals emptied: any regex literal
	// left that names a cancel spelling would be a second copy of the pattern.
	const helperCode = helperSrc.replace(/`[^`]*`/g, "``").replace(/"[^"]*"/g, '""');
	t("§5 wiring: the helper judges with the money filter's own CANCELED_STATUS_RE on trimmed cells, with no copy of the spellings",
		[/CANCELED_STATUS_RE\.test\(/.test(helperSrc), /\.trim\(\)/.test(helperSrc), /\/[^/\n]*cancel[^/\n]*\/[a-z]*/i.test(helperCode)],
		[true, true, false]);
	t("§5 wiring: CANCELED_STATUS_RE is still the one pattern the money filter reads",
		SRC.split("\n").filter((l) => /^const CANCELED_STATUS_RE\b/.test(l)), ["const CANCELED_STATUS_RE = /^(cancel|canceled|cancelled)$/i;"]);

	if (typeof helpers.rowEditCancelRefusal !== "function") {
		t("§5 rowEditCancelRefusal() exists in server.js", false, true);
		return results;
	}
	const G = (hs, before, after) => { const r = helpers.rowEditCancelRefusal(hs, before, after); return r && [r.code, r.field]; };
	t("§5 helper: production's layout judges Job Status, and Status Update Date is not a status",
		[G(HEADERS, storedRow(), storedRow({ "Job Status": "Cancelled" })), G(HEADERS, storedRow(), storedRow({ "Status Update Date": "Cancelled" }))],
		[[CODE, "Job Status"], null]);
	const SPLIT = ["Load ID", "Status Notes", "Job Status"];
	t("§5 helper: when they differ, the first /status/i column (the one the cancel writes) and excludeDroppedLoads()'s column are both judged",
		[G(SPLIT, ["1", "", "Dispatched"], ["1", "Cancelled", "Dispatched"]), G(SPLIT, ["1", "", "Dispatched"], ["1", "", "Cancelled"])],
		[[CODE, "Status Notes"], [CODE, "Job Status"]]);
	t("§5 helper: with the status header twice, the second copy (the one a parsed row keeps) is judged too",
		G(["Load ID", "Job Status", "Details", "Job Status"], ["1", "Dispatched", "", "Dispatched"], ["1", "Dispatched", "", "cancel"]), [CODE, "Job Status"]);
	t("§5 helper: a padded header is judged, and named as the sheet holds it",
		G(["Load ID", "  Job Status  "], ["1", "Dispatched"], ["1", "Cancelled"]), [CODE, "  Job Status  "]);
	t("§5 helper: no status column, nothing judged", G(["Load ID", "Details"], ["1", "x"], ["1", "Cancelled"]), null);
	t("§5 helper: a status cell past the end of the stored row is judged from \"\"", G(["Load ID", "Job Status"], ["1"], ["1", "Cancelled"]), [CODE, "Job Status"]);
	t("§5 helper: numbers, null and rows that are not arrays answer null without throwing",
		[G(HEADERS, null, null), G(null, ["1"], ["Cancelled"]), G(HEADERS, storedRow({ "Job Status": 5 }), storedRow({ "Job Status": null }))], [null, null, null]);
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
	console.log("§5 the cancel refusal (ROW_EDITOR_CANCEL_GUARD_ENABLED)");
	record(await cancelSection(H));
	console.log("§5 the cancel refusal: wiring and column rule");
	record(cancelWiringSection(H));

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

	console.log("§6 mutants of the cancel refusal");
	{
		// Built inside the run: on a base copy, which has no refusal, a missing
		// target fails the run as "not caught" instead of stopping it.
		const CALL = "const cancel = rowEditCancelRefusal(headers, before, after);";
		const FLAG = "if (ROW_EDITOR_CANCEL_GUARD_ENABLED && guarded) {";
		const helperMutant = (from, to) => ({ helpers: buildHelpers({ rowEditCancelRefusal: mutate(HELPER_SRC.rowEditCancelRefusal || "", from, to) }) });
		const mutants = [
			["M4 PUT /api/data without the refusal", () => ({ dataSrc: mutate(DATA_PUT_SRC, CALL, "const cancel = null;") })],
			["M5 PUT /api/load without the refusal", () => ({ loadSrc: mutate(LOAD_PUT_SRC, CALL, "const cancel = null;") })],
			["M6 the status cell judged untrimmed", () => helperMutant(': "").trim();', ': "");')],
			["M7 a row already cancelled refused too", () => helperMutant(" || CANCELED_STATUS_RE.test(cell(before, i))", "")],
			["M8 the flag ignored by both saves", () => ({ dataSrc: mutate(DATA_PUT_SRC, FLAG, "if (guarded) {"), loadSrc: mutate(LOAD_PUT_SRC, FLAG, "if (guarded) {") })],
		];
		for (const [label, build] of mutants) {
			let failed = [], detail = "";
			try {
				const m = build();
				failed = (await cancelSection(m.helpers || H, m)).filter((r) => !r.ok);
			} catch (e) {
				detail = ` — ${e && e.message ? e.message : e}`;
			}
			const caught = !detail && failed.length > 0;
			if (caught) pass++;
			else { fail++; failures.push(`mutant not caught: ${label} (§5 failed ${failed.length})${detail}`); }
			console.log(`  ${caught ? "caught " : "MISSED "} ${label} — §5 failed ${failed.length} check(s)` +
				`${failed[0] ? `, e.g. ✗ ${failed[0].name}` : ""}${detail}`.slice(0, 260));
		}
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
