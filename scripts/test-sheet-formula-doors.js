#!/usr/bin/env node
// Locks the formula refusal on the routes, besides the two PUTs, that write a
// non-Super-Admin's text into Google Sheets. Every one of them writes with
// valueInputOption "USER_ENTERED", which stores a value starting with "=", or
// with "+" before anything but a plain number, as a formula, and only a Super
// Admin enters formulas. It also locks the two dispatch routes' refusal of a
// driver name that reads as a built-in property name (400 DRIVER_NAME_RESERVED,
// every role, before the sheet is read), and that from-ratecon writes no driver
// name at all.
//
//   • POST /api/loads/from-ratecon (Super Admin, Dispatcher). Check 1 refuses a
//     field in RATECON_SHEET_FIELDS that starts with "=", before the load is
//     claimed and before any sheet is read. Check 2 refuses a cell as it will be
//     written to Job Tracking, the Payments Table or Job Details, before the
//     first write. Check 2 is the one a BUILT cell needs: Job Details' "Details"
//     is two cityStateZip() results, and either can begin mid-address.
//   • POST /api/dispatch and POST /api/dispatch/reassign (Super Admin,
//     Dispatcher): the driver name is written as sent whenever it names no
//     Driver account.
//
// All of them answer 400 FORMULA_NOT_ALLOWED through formulaCellRefusal(), the
// rule scripts/test-broker-column-redaction.js runs for the two PUTs (and where
// the POST /api/data gate is run), and a Super Admin is never refused.
//
// RATECON_SHEET_FIELDS IS DERIVED HERE, NOT TRUSTED. §2 runs the shipped route
// with a distinct marker in every field the extractor returns and collects the
// fields whose marker reaches a written cell. If buildJobTrackingRow() or an
// upsert mapping starts writing another field, that set and the list part, and
// this file fails until the list is updated.
//
// Each route is lifted whole out of server.js and run against a fake sheet: no
// network, no database, no real sheet. Every refusal has a mutant in §5.
//
// THE UPSERTS (§4b). from-ratecon's upsertByKey() reads the Payments Table and
// Job Details with valueRenderOption FORMULA. For a row whose key matches, it
// writes only the cells that differ, in ONE values.batchUpdate
// (sheetRowCellWrites()), and nothing when none does; a new row is still one
// whole-row values.update at an anchored A{lastRow+1}. The fake sheet serves a
// FORMULA read as the API does (a formula as the formula, a number as a
// number, text as its value) and applies a write as USER_ENTERED does, so a
// whole-row rewrite shows up as what it did to the row: text cells came back
// re-parsed (text holding 00123 as a number). Mutant MU in
// §5 restores the whole-row values.update.
//
//   node scripts/test-sheet-formula-doors.js     # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");
const rateconLoad = require("../lib/ratecon-load");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return true; }
	fail++; failures.push(`${name}\n     expected ${e}\n     actual   ${a}`);
	console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
	return false;
}
// Sections collect into a list, so §5 can run them against a mutant and count
// what they catch; record() tallies a list.
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
}

// ---------------------------------------------------------------- extraction
// A top-level declaration, from its line to the first `}` in COLUMN 0 (a brace
// counter would read a "{" inside a string literal as a block).
function extract(name) {
	for (const prefix of ["function ", "async function "]) {
		const needle = `\n${prefix}${name}(`;
		const hits = SRC.split(needle).length - 1;
		if (hits === 0) continue;
		if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
		const start = SRC.indexOf(needle) + 1;
		const end = SRC.indexOf("\n}\n", start);
		if (end < 0) throw new Error(`could not find the top-level end of ${name}()`);
		const body = SRC.slice(start, end + 3);
		if (/\n(async )?function /.test(body)) throw new Error(`extraction of ${name}() spanned more than one declaration`);
		return body;
	}
	throw new Error(`no definition of ${name}() in server.js`);
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
// The initializer of a top-level `const NAME = …;`.
function extractConst(name) {
	const m = SRC.match(new RegExp(`\\nconst ${name} = ([\\s\\S]*?);\\n`));
	if (!m) throw new Error(`const ${name} not found in server.js`);
	return m[1];
}
// Replace exactly one occurrence, or fail loudly: a mutant whose target is gone
// would run the ORIGINAL code and "pass", proving nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) throw new Error(`mutant target found ${n}x (expected 1): ${from.slice(0, 70)}`);
	return src.replace(from, () => to);
}

const H = new Function(`
const ADDRESS_MAX_CHARS = ${extractConst("ADDRESS_MAX_CHARS")};
${extract("boundAddressForStorage")}
${extract("parseSheet")}
${extract("findCol")}
${extract("formulaCellRefusal")}
${extract("normalizeDriverName")}
${extract("isBuiltInPropertyName")}
${extract("reservedDriverNameRefusal")}
${extract("colLetter")}
${extract("sheetRowToObject")}
${extract("resolveSheetDataRow")}
${extract("a1SheetPrefix")}
${extract("a1ColumnLetter")}
${extract("sheetRowAfterUpdate")}
${extract("sheetRowCellWrites")}
return { ADDRESS_MAX_CHARS, boundAddressForStorage, parseSheet, findCol, formulaCellRefusal, reservedDriverNameRefusal, colLetter, sheetRowToObject, resolveSheetDataRow,
	a1SheetPrefix, sheetRowAfterUpdate, sheetRowCellWrites };
`)();
const RATECON_SHEET_FIELDS = new Function(`return ${extractConst("RATECON_SHEET_FIELDS")};`)();
const RATECON_GEMINI_FIELDS = new Function(`return ${extractConst("RATECON_GEMINI_FIELDS")};`)();
const QUIET = { error() {}, log() {}, warn() {} };
const readJobTrackingSnapshot = new Function("SPREADSHEET_ID", "console",
	`${extract("readJobTrackingSnapshot")}\nreturn readJobTrackingSnapshot;`)("sheet-under-test", QUIET);

const RATECON_HEAD = 'app.post("/api/loads/from-ratecon", requireRole("Super Admin", "Dispatcher"), rateConLimiter, async (req, res) => {';
const DISPATCH_HEAD = 'app.post("/api/dispatch", requireRole("Super Admin", "Dispatcher"), async (req, res) => {';
const REASSIGN_HEAD = 'app.post("/api/dispatch/reassign", requireRole("Super Admin", "Dispatcher"), async (req, res) => {';
const RATECON_SRC = extractRoute(RATECON_HEAD);
const DISPATCH_SRC = extractRoute(DISPATCH_HEAD);
const REASSIGN_SRC = extractRoute(REASSIGN_HEAD);

// ---------------------------------------------------------------- fixtures
// Production's Job Tracking header row, verbatim and in order (the same fixture
// as test-broker-column-redaction.js).
const JT_HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver",
	"Pickup Info", "Pickup Address", "Pickup Appointment", "Drop-off Info",
	"Drop-off Address", "Drop-off Appointment", "Job Status", "Phase of Progress",
	"Carrier Stage", "Broker Contact Name", "Phone Number", "Email",
	"Assigned Date", "Status Update Date", "Completion Date", "Location Link",
	"Documents", "  Payment  ", "Truck", "Owner ID", "output",
];
const JT_IDX = Object.fromEntries(JT_HEADERS.map((h, i) => [h.trim(), i]));
function jtRow(loadId, over) {
	const r = new Array(JT_HEADERS.length).fill("");
	r[JT_IDX["Load ID"]] = loadId;
	r[JT_IDX["Job Status"]] = "Unassigned";
	r[JT_IDX["Broker Contact Name"]] = "Della Garcia";
	for (const [k, v] of Object.entries(over || {})) r[JT_IDX[k]] = v;
	return r;
}
// The key column really is " Job ID"; Job Details' column A header is blank.
const PAYMENTS_HEADERS = [" Job ID", "Contract ID", "Payment Amount", "Invoice Number", "Payment Status"];
const JOB_DETAILS_HEADERS = ["", "Distance", "Rate Per Mile", "Details", "Payment", "output (retired)"];

// A clean rate-con, every key the extractor returns.
const LEGIT = {
	"Load Number": "RC-5001", "Broker Name": "Della Garcia", "Broker Phone": "555-0142",
	"Broker Email": "della.garcia@example.invalid", "Driver Name": "Kevin",
	"Pickup Company Information": "Acme Cold Storage", "Pickup Address": "4528 W Royal Ln, Irving, TX 75063",
	"Pickup Appointment Time": "2026-09-27 08:00", "P/U Reference Number": "PU-29284990",
	"Pickup Notes/Instructions": "Call ahead", "Drop-off Company Information": "Border Foods",
	"Drop-off Address": "818 Hallmark Dr, Laredo, TX 78045", "Delivery Appointment Time": "2026-09-28 14:00",
	"Delivery Reference Number": "DEL-5512", "Delivery Notes/Instructions": "Dock 4",
	"Rate": "$1,500.00", "BOL Number": "BOL-9", "Details": "48,000 lbs frozen poultry",
	"Order Number": "ORD-1", "PO Number": "PO-1", "Move Number": "MV-1", "Trailer Number": "TR-77",
	"Total Rate": "$1,650.00", "Documents Email": "docs@example.invalid",
};
// The one Distance Matrix answer every run gets: 500 miles, OK.
const DM_OK = { rows: [{ elements: [{ status: "OK", distance: { value: 804670, text: "500 mi" } }] }] };

// A sheet that records every read and write and applies each write to its own
// copy of `tabs` (a tab name → its rows), served afterwards as `store`.
//
// Each stored cell is in the sheet's own terms, as in
// scripts/test-row-save-cell-writes.js:
//   a number  a number;
//   "=…"      a formula, shown as SHOWS[it] ("#ERROR!" for one it does not know);
//   "'…"      text entered with a leading apostrophe; its value is the text
//             after it ("'00123" is the text 00123, "'=QA" the text =QA);
//   else      text, its value itself.
// A read serves each cell as its valueRenderOption asks: FORMULA gives a formula
// as the formula and a number as a number, the default FORMATTED_VALUE gives
// what the cell shows, and text is its value either way. Like the API, a read
// drops each row's trailing empty cells and the tab's trailing empty rows.
// A write is applied as USER_ENTERED applies it: a value starting with "=" is
// stored as a formula, "'…" as text, a plain numeral as a number (so text
// holding 00123, written back as read, becomes 123), and other text as given
// (this fake does not parse currency or dates). A null leaves its cell alone.
const SHOWS = { "=1+1": "2", '=IF(FALSE,"x","")': "" };
function cellAs(c, render) {
	if (c == null) return "";
	if (typeof c === "number") return render === "FORMULA" ? c : String(c);
	const s = String(c);
	if (s.startsWith("=")) return render === "FORMULA" ? s : (Object.prototype.hasOwnProperty.call(SHOWS, s) ? SHOWS[s] : "#ERROR!");
	if (s.startsWith("'")) return s.slice(1);
	return s;
}
function userEntered(v) {
	if (typeof v === "number") return v;
	const s = String(v);
	return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s) ? Number(s) : s;
}
function fakeSheets(tabs) {
	const store = JSON.parse(JSON.stringify(tabs));
	// `reads` and `writes` keep the shape the sections above read; `calls` has
	// one entry per API call, for the sections that count calls.
	const log = { reads: [], writes: [], calls: [] };
	// The tab a range names, unquoted ("'Payments Table'!C3" → Payments Table).
	const tabOf = (range) => {
		const t = String(range).split("!")[0];
		return /^'.*'$/.test(t) ? t.slice(1, -1).replace(/''/g, "'") : t;
	};
	const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
	// Where a written range starts: its tab, 0-based column and 1-based row.
	const startOf = (range) => {
		const m = /!([A-Z]+)(\d+)/.exec(String(range));
		if (!m) throw new Error(`fake sheet: no start cell in ${range}`);
		return { tab: tabOf(range), col: colIndex(m[1]), row: Number(m[2]) };
	};
	const rowsOf = (tab) => {
		if (!store[tab]) throw new Error(`fake sheet has no tab ${tab}`);
		return store[tab];
	};
	const put = (tab, rowNo, col, cells) => {
		const rows = rowsOf(tab);
		while (rows.length < rowNo) rows.push([]);
		const r = rows[rowNo - 1];
		cells.forEach((v, j) => {
			if (v == null) return;
			while (r.length <= col + j) r.push("");
			r[col + j] = userEntered(v);
		});
	};
	const values = {
		get: async ({ range, valueRenderOption }) => {
			log.reads.push(range);
			const render = valueRenderOption || "FORMATTED_VALUE";
			log.calls.push({ verb: "get", tabs: [tabOf(range)], range, valueRenderOption: render });
			const rows = rowsOf(tabOf(range)).map((r) => {
				const out = r.map((c) => cellAs(c, render));
				while (out.length && out[out.length - 1] === "") out.pop();
				return out;
			});
			while (rows.length && !rows[rows.length - 1].length) rows.pop();
			return { data: { values: rows } };
		},
		append: async ({ range, valueInputOption, requestBody }) => {
			const tab = tabOf(range);
			const row = requestBody.values[0].slice();
			log.writes.push({ op: "append", tab, valueInputOption, row });
			log.calls.push({ verb: "append", tabs: [tab], range, valueInputOption, row });
			const n = rowsOf(tab).length + 1;
			put(tab, n, 0, row);
			return { data: { updates: { updatedRange: `${tab}!A${n}:Z${n}` } } };
		},
		update: async ({ range, valueInputOption, requestBody }) => {
			const at = startOf(range);
			const row = requestBody.values[0].slice();
			log.writes.push({ op: "update", tab: at.tab, range, valueInputOption, row });
			log.calls.push({ verb: "update", tabs: [at.tab], range, valueInputOption, row });
			requestBody.values.forEach((cells, k) => put(at.tab, at.row + k, at.col, cells));
			return { data: {} };
		},
		batchUpdate: async ({ requestBody }) => {
			const { valueInputOption, data } = requestBody;
			for (const d of data) {
				log.writes.push({ op: "batch", tab: tabOf(d.range), range: d.range, valueInputOption, row: d.values[0].slice() });
			}
			log.calls.push({
				verb: "batchUpdate", tabs: [...new Set(data.map((d) => tabOf(d.range)))], valueInputOption,
				ranges: data.map((d) => d.range), values: data.map((d) => d.values),
			});
			for (const d of data) {
				const at = startOf(d.range);
				d.values.forEach((cells, k) => put(at.tab, at.row + k, at.col, cells));
			}
			return { data: {} };
		},
	};
	return { getSheets: async () => ({ spreadsheets: { values } }), log, store };
}
// Runs a lifted handler as `role`; answers { code, body } and, like a real
// response, fires the "close" listeners once it has answered.
function runAs(getHandler) {
	return async (role, body) => {
		const out = { code: 200, body: null };
		const closers = [];
		const res = {
			status(c) { out.code = c; return this; },
			json(b) { out.body = b; return this; },
			on(ev, fn) { if (ev === "close") closers.push(fn); return this; },
		};
		const user = { id: role === "Super Admin" ? 1 : 2, role, username: role === "Super Admin" ? "super_admin" : "kevin" };
		await getHandler()({ body, session: { user } }, res);
		for (const fn of closers) fn();
		return out;
	};
}
const written = (log) => log.writes.flatMap((w) => w.row.map((c) => (c == null ? "" : String(c))));
const bodyKeys = (r) => Object.keys((r && r.body) || {});

// ---------------------------------------------------------------------------
// POST /api/loads/from-ratecon, lifted whole. Everything past the sheet is
// stubbed: no PDF is sent, so the archive (fs, db, Drive) is never reached, and
// geocodeAddress() answers null, so load_coordinates is skipped too. The row
// diff, the A1 quoting and the cell writes are the shipped helpers.
// ---------------------------------------------------------------------------
// The tabs every section but §4b runs on: one other load on Job Tracking, and
// the two upsert tabs holding their header rows only, so both upserts append.
const RATECON_TABS = () => ({
	"Job Tracking": [JT_HEADERS.slice(), jtRow("RC-1000")],
	"Payments Table": [PAYMENTS_HEADERS.slice()],
	"Job Details": [JOB_DETAILS_HEADERS.slice()],
});
function mountRatecon(routeSrc, tabs = RATECON_TABS()) {
	const sheet = fakeSheets(tabs);
	const claims = [];
	const inFlight = new (class extends Set { add(v) { claims.push(v); return super.add(v); } })();
	let dmCalls = 0;
	const audits = [];
	let handler = null;
	const unreached = (what) => () => { throw new Error(`${what} is not reached by this fixture`); };
	const env = {
		app: { post: (p, gate, limiter, h) => { handler = h; } },
		requireRole: () => null,
		rateConLimiter: null,
		formulaCellRefusal: H.formulaCellRefusal,
		RATECON_SHEET_FIELDS,
		boundAddressForStorage: H.boundAddressForStorage,
		ADDRESS_MAX_CHARS: H.ADDRESS_MAX_CHARS,
		rateconLoad,
		rateConCreateInFlight: inFlight,
		getSheets: sheet.getSheets,
		SPREADSHEET_ID: "sheet-under-test",
		parseSheet: H.parseSheet,
		findCol: H.findCol,
		deduplicateLoads: (data) => data,
		getDeletedLoadIds: () => new Set(),
		GOOGLE_MAPS_API_KEY: "key-under-test",
		fetch: async () => { dmCalls++; return { json: async () => DM_OK }; },
		geocodeAddress: async () => null,
		houstonDay: () => "2026-09-26",
		validateOwnerIdCell: () => null,
		jtCacheInvalidate: () => {},
		sheetRowCellWrites: H.sheetRowCellWrites,
		sheetRowAfterUpdate: H.sheetRowAfterUpdate,
		a1SheetPrefix: H.a1SheetPrefix,
		path,
		fs: { existsSync: unreached("fs"), mkdirSync: unreached("fs"), writeFileSync: unreached("fs") },
		__dirname: "/nonexistent",
		db: { prepare: unreached("the database") },
		getDrive: unreached("Drive"),
		RATECON_DRIVE_FOLDER_ID: "",
		logAudit: (req, action) => { audits.push(action); },
		insertDispatchNotification: { run: () => ({}) },
		io: { to: () => ({ emit: () => {} }) },
		notifyChange: () => {},
		console: QUIET,
		Buffer,
		require,
	};
	const names = Object.keys(env);
	new Function(...names, routeSrc)(...names.map((k) => env[k]));
	if (typeof handler !== "function") throw new Error("the lifted from-ratecon route did not register a handler");
	return { run: runAs(() => handler), log: sheet.log, store: sheet.store, claims, audits, dm: () => dmCalls };
}

async function rateconSection(routeSrc = RATECON_SRC) {
	const { results, t } = collector();
	const run = async (role, over) => {
		const m = mountRatecon(routeSrc);
		const r = await m.run(role, { fields: { ...LEGIT, ...over } });
		return { r, m };
	};

	// A clean load from a Dispatcher: one append, two upserts, all USER_ENTERED.
	{
		const { r, m } = await run("Dispatcher", {});
		t("from-ratecon, Dispatcher, a clean load: 200, one append and two upserts, all USER_ENTERED",
			[r.code, m.log.writes.map((w) => `${w.op} ${w.tab}`), m.log.writes.every((w) => w.valueInputOption === "USER_ENTERED")],
			[200, ["append Job Tracking", "update Payments Table", "update Job Details"], true]);
	}
	// CHECK 1: every field this route writes to a sheet. The Load Number is left
	// out here: its own whitelist refuses an "=" before check 1 runs (below).
	for (const key of RATECON_SHEET_FIELDS.filter((k) => k !== "Load Number")) {
		const { r, m } = await run("Dispatcher", { [key]: "=1+1" });
		t(`from-ratecon, Dispatcher, ${JSON.stringify(key)} = "=1+1": 400 FORMULA_NOT_ALLOWED naming the field; no claim, no read, no Distance Matrix, no write`,
			[r.code, r.body && r.body.code, r.body && r.body.field, bodyKeys(r), m.claims.length, m.log.reads.length, m.dm(), m.log.writes.length],
			[400, "FORMULA_NOT_ALLOWED", key, ["error", "code", "field"], 0, 0, 0, 0]);
	}
	for (const [label, key, value] of [
		["leading spaces", "Broker Name", "  =SUM(A1:A2)"],
		["a leading tab and newline", "Details", "\t\n=A1"],
		["a lone \"=\"", "Trailer Number", "="],
		// USER_ENTERED stores a value starting with "+" as a formula too.
		["a \"+\" before a cell reference", "Trailer Number", "+A1"],
		["a \"+\" before a function", "Broker Name", "+SUM(A1:A2)"],
		["a \"+\" before an expression", "Details", "+1+1"],
		["a \"+\" before a spaced phone number", "Broker Phone", "+1 800 555 1234"],
	]) {
		const { r, m } = await run("Dispatcher", { [key]: value });
		t(`from-ratecon, Dispatcher, ${label}: refused by check 1 too`,
			[r.code, r.body && r.body.code, r.body && r.body.field, m.log.reads.length], [400, "FORMULA_NOT_ALLOWED", key, 0]);
	}
	{
		const { r } = await run("Dispatcher", { "Trailer Number": "+A1" });
		t("from-ratecon, Dispatcher, a leading \"+\": the text names the \"+\" to remove",
			/starts with "\+".*remove the leading "\+"/.test((r.body || {}).error || ""), true);
	}
	{
		const { r } = await run("Dispatcher", { "Load Number": "=1" });
		t("from-ratecon, Dispatcher, a Load Number starting with \"=\": its whitelist refuses it first (400, no code)",
			[r.code, r.body && r.body.code, /unsupported characters/.test((r.body || {}).error || "")], [400, undefined, true]);
	}
	// Not refused: an "=" that does not lead, a plain number after "+", a leading
	// "-" or "@" (stored as text or a number), and a field no sheet gets.
	for (const [label, over, absent] of [
		["an \"=\" inside the text", { Details: "a=b pallets" }, null],
		["a plain number after \"+\"", { "Trailer Number": "+7" }, null],
		["a plain decimal after \"+\"", { Rate: "+1500.50" }, null],
		["a leading \"-\"", { "Trailer Number": "-1+1" }, null],
		["a leading \"@\"", { Details: "@SUM(1,1)" }, null],
		["a field that reaches no sheet (Pickup Notes)", { "Pickup Notes/Instructions": "=== LIVE LOAD ===" }, "=== LIVE LOAD ==="],
		["a field that reaches no sheet (Total Rate)", { "Total Rate": "=1650" }, "=1650"],
		// The route takes no driver name in: the extracted Driver Name reaches no sheet.
		["a built-in property name in Driver Name, a field that reaches no sheet", { "Driver Name": "__proto__" }, "__proto__"],
	]) {
		const { r, m } = await run("Dispatcher", over);
		t(`from-ratecon, Dispatcher, ${label}: 200, three writes${absent ? ", the value in none of them" : ""}`,
			[r.code, m.log.writes.length, absent ? written(m.log).some((c) => c.includes(absent)) : false], [200, 3, false]);
	}
	for (const role of ["Dispatcher", "Super Admin"]) {
		const { r, m } = await run(role, { "Driver Name": "Constructor" });
		const jt = m.log.writes.find((w) => w.tab === "Job Tracking") || { row: [] };
		t(`from-ratecon, ${role}: the new Job Tracking row's Driver cell is blank whatever Driver Name says`,
			[r.code, jt.row[JT_IDX["Driver"]]], [200, ""]);
	}
	// CHECK 2: a built cell. Neither address starts with "=", but cityStateZip()
	// of the pickup does, so Job Details' "Details" would.
	{
		const pickup = "Dock 4, =1+1, TX 75063";
		const csz = rateconLoad.cityStateZip(pickup);
		t("fixture: the pickup does not start with \"=\", its cityStateZip() does", [pickup.trim().startsWith("="), csz], [false, "=1+1, TX 75063"]);
		const { r, m } = await run("Dispatcher", { "Pickup Address": pickup });
		t("from-ratecon, Dispatcher, a built Job Details cell starting with \"=\": 400 FORMULA_NOT_ALLOWED naming Details on Job Details, nothing written",
			[r.code, r.body && r.body.code, r.body && r.body.field, r.body && r.body.sheet, bodyKeys(r), m.log.writes.length, m.audits.length],
			[400, "FORMULA_NOT_ALLOWED", "Details", "Job Details", ["error", "code", "field", "sheet"], 0, 0]);
		t("from-ratecon, Dispatcher, the built cell: check 1 passed it (the dedupe read and the Distance Matrix ran), and the claim is released",
			[m.log.reads, m.dm(), m.claims.length], [["Job Tracking"], 1, 1]);
	}
	// A Super Admin is never refused: written as sent, formulas included.
	{
		const f = "=SUM(A1:A2)";
		const { r, m } = await run("Super Admin", { "Broker Name": f });
		const jt = m.log.writes.find((w) => w.tab === "Job Tracking") || { row: [] };
		const pay = m.log.writes.find((w) => w.tab === "Payments Table") || { row: [] };
		t("from-ratecon, Super Admin, a formula in Broker Name: 200, written to Job Tracking and the Payments Table as sent",
			[r.code, jt.row[JT_IDX["Broker Contact Name"]], pay.row[PAYMENTS_HEADERS.indexOf("Contract ID")]], [200, f, f]);
		const b = await run("Super Admin", { "Pickup Address": "Dock 4, =1+1, TX 75063" });
		const jd = b.m.log.writes.find((w) => w.tab === "Job Details") || { row: [] };
		t("from-ratecon, Super Admin, the built Job Details cell: 200, written",
			[b.r.code, jd.row[JOB_DETAILS_HEADERS.indexOf("Details")]], [200, "=1+1, TX 75063 - Laredo, TX 78045"]);
	}
	return results;
}

// ---------------------------------------------------------------------------
// §4b THE UPSERTS — an existing row is updated cell by cell, a new row is
// written whole. A Dispatcher drops the clean rate-con (LEGIT, load RC-5001:
// broker "Della Garcia", rate "$1,500.00") on each fixture.
// ---------------------------------------------------------------------------
// A Payments Table wider than the three columns the route maps, as production's
// is, and a Job Details tab WITH a Load ID column, which production's lacks
// (there it always appends): the one way to reach that tab's update branch.
const PAY_HEADERS = [" Job ID", "Contract ID", "Payment Amount", "Invoice Number", "Payment Status", "Payment Date", "Check Number", "Notes"];
const JD_ID_HEADERS = ["", "Load ID", "Distance", "Rate Per Mile", "Details", "Payment", "output (retired)"];
// Row 2: another load, filled in. Nothing this route does may touch it.
const PAY_OTHER = () => ["RC-4000", "Other Broker", 900, "'00077", "Paid", 46200, "'00001", "ok"];
// The load's own row: its broker already booked as another name (kept, and
// warned about), its Payment Amount blank (filled in), and in the columns the
// route does not map a formula, a number (a date's serial, as a FORMULA read
// returns it), text holding 00123, text starting with "=", and a cell past
// the last header.
const PAY_ROW = () => ["RC-5001", "Old Broker LLC", "", "'00123", "=1+1", 46291, "", "'=QA", "stray"];
const upsertTabs = (payRows, jobDetails = [JOB_DETAILS_HEADERS.slice()]) => ({
	"Job Tracking": [JT_HEADERS.slice(), jtRow("RC-1000")],
	"Payments Table": [PAY_HEADERS.slice(), PAY_OTHER(), ...payRows],
	"Job Details": jobDetails,
});

async function upsertSection(routeSrc = RATECON_SRC) {
	const { results, t } = collector();
	const run = async (tabs, over = {}) => {
		const m = mountRatecon(routeSrc, tabs);
		const r = await m.run("Dispatcher", { fields: { ...LEGIT, ...over } });
		return { r, m };
	};
	// Every call that touched `tab`, in order, as "get <render>",
	// "batchUpdate <range> <range>…" or "<verb> <range>".
	const callsOn = (m, tab) => m.log.calls.filter((c) => c.tabs.includes(tab)).map((c) =>
		(c.verb === "get" ? `get ${c.valueRenderOption}` : c.verb === "batchUpdate" ? `batchUpdate ${c.ranges.join(" ")}` : `${c.verb} ${c.range}`));
	const callOn = (m, verb, tab) => m.log.calls.find((c) => c.verb === verb && c.tabs.includes(tab)) || {};
	const payWarnings = (r) => ((r.body && r.body.warnings) || []).filter((w) => /Payments Table/.test(w));
	const withCell = (rows, rowNo, col, v) => { const out = JSON.parse(JSON.stringify(rows)); out[rowNo - 1][col] = v; return out; };
	const rpm = rateconLoad.calculateRatePerMile(DM_OK, LEGIT);

	// An existing Payments Table row (row 3).
	{
		const tabs = upsertTabs([PAY_ROW()]);
		const { r, m } = await run(tabs);
		const batch = callOn(m, "batchUpdate", "Payments Table");
		t("§4b an existing Payments Table row: read once as FORMULA, then ONE values.batchUpdate of the blank mapped cell alone (Payment Amount, C3); no whole-row values.update",
			[r.code, callsOn(m, "Payments Table")], [200, ["get FORMULA", "batchUpdate 'Payments Table'!C3"]]);
		t("§4b an existing Payments Table row: the cell sent as built, USER_ENTERED",
			[batch.values, batch.valueInputOption], [[[["$1,500.00"]]], "USER_ENTERED"]);
		t("§4b an existing Payments Table row: the broker already there is kept, and warned about once",
			payWarnings(r), ["The Payments Table already had a row for RC-5001 with a different Contract ID — the existing value was kept. Reconcile it manually."]);
		t("§4b an existing Payments Table row: afterwards only C3 has changed; the formula, the number, the text 00123 and =QA, the kept broker, the cell past the last header and the other load's row are as they were",
			m.store["Payments Table"], withCell(tabs["Payments Table"], 3, 2, "$1,500.00"));
	}
	// A short row: the API drops trailing blank cells, so the row as read is
	// the key alone and both other mapped cells lie past its end.
	{
		const { r, m } = await run(upsertTabs([["RC-5001"]]));
		t("§4b a short existing row (the key alone): the two mapped cells past its end, in ONE values.batchUpdate, and no conflict",
			[r.code, callsOn(m, "Payments Table"), callOn(m, "batchUpdate", "Payments Table").values, payWarnings(r), m.store["Payments Table"][2]],
			[200, ["get FORMULA", "batchUpdate 'Payments Table'!B3 'Payments Table'!C3"], [[["Della Garcia"]], [["$1,500.00"]]], [], ["RC-5001", "Della Garcia", "$1,500.00"]]);
	}
	// A row already holding every mapped value, its key and amount stored as
	// numbers: a FORMULA read returns 5001 and 1500, and the route builds
	// "5001" and "1500". Compared as text, they are the same cells.
	{
		const tabs = upsertTabs([[5001, "Della Garcia", 1500, "'00123", "=1+1"]]);
		const { r, m } = await run(tabs, { "Load Number": "5001", Rate: "1500" });
		t("§4b an existing row already holding every mapped value (key and amount stored as numbers): read, then no call at all, no warning, the tab as it was",
			[r.code, callsOn(m, "Payments Table"), payWarnings(r), m.store["Payments Table"]],
			[200, ["get FORMULA"], [], tabs["Payments Table"]]);
	}
	// A formula in a MAPPED cell that shows nothing. Read as FORMULA it is
	// filled, so it is kept and warned about; read as displayed it would be ""
	// and overwritten.
	{
		const { r, m } = await run(upsertTabs([["RC-5001", '=IF(FALSE,"x","")', "", "'00123"]]));
		t("§4b a formula that shows nothing in a mapped cell (Contract ID): kept and warned about; only the blank Payment Amount is written",
			[r.code, callsOn(m, "Payments Table"), payWarnings(r).length, m.store["Payments Table"][2]],
			[200, ["get FORMULA", "batchUpdate 'Payments Table'!C3"], 1, ["RC-5001", '=IF(FALSE,"x","")', "$1,500.00", "'00123"]]);
	}
	// An existing Job Details row, the update without preserveFilled: Distance
	// as built, Payment stored as the number 1500 (the route builds "1500"), an
	// older Rate Per Mile (the number 2.5) and Details, and junk in the column
	// the route does not map.
	{
		const jd = [JD_ID_HEADERS.slice(), ["", "RC-5001", `${rpm.distance_miles} Miles`, 2.5, "old lane", 1500, '{"junk":1}']];
		const tabs = upsertTabs([], jd);
		const { r, m } = await run(tabs);
		t("§4b an existing Job Details row: ONE values.batchUpdate of the two mapped cells that differ (Rate Per Mile D2, Details E2); the equal Distance and Payment, the key and the junk cell are not written",
			[r.code, callsOn(m, "Job Details"), callOn(m, "batchUpdate", "Job Details").values],
			[200, ["get FORMULA", "batchUpdate 'Job Details'!D2 'Job Details'!E2"], [[[`$${rpm.rate_per_mile}`]], [[rpm.details]]]]);
		t("§4b an existing Job Details row: afterwards only D2 and E2 have changed",
			m.store["Job Details"], withCell(withCell(jd, 2, 3, `$${rpm.rate_per_mile}`), 2, 4, rpm.details));
	}
	// No row for the load: the new-row write, unchanged.
	{
		const { r, m } = await run(RATECON_TABS());
		t("§4b no row for the load (header rows only): each tab read as FORMULA, then written whole by ONE values.update at an anchored A2, USER_ENTERED; no values.batchUpdate",
			[r.code, callsOn(m, "Payments Table"), callsOn(m, "Job Details"), m.log.calls.filter((c) => c.verb === "batchUpdate").length,
				[callOn(m, "update", "Payments Table").valueInputOption, callOn(m, "update", "Job Details").valueInputOption]],
			[200, ["get FORMULA", "update Payments Table!A2"], ["get FORMULA", "update Job Details!A2"], 0, ["USER_ENTERED", "USER_ENTERED"]]);
		t("§4b no row for the load: each row written is one cell per header, as built",
			[callOn(m, "update", "Payments Table").row, callOn(m, "update", "Job Details").row],
			[["RC-5001", "Della Garcia", "$1,500.00", "", ""], ["", `${rpm.distance_miles} Miles`, `$${rpm.rate_per_mile}`, rpm.details, String(rpm.payment), ""]]);
	}
	{
		const tabs = upsertTabs([PAY_ROW()]);
		const { r, m } = await run(tabs, { "Load Number": "RC-7000" });
		t("§4b no row for the load, rows for others: ONE whole-row values.update at A{lastRow+1} (A4), the rows above as they were",
			[r.code, callsOn(m, "Payments Table"), callOn(m, "update", "Payments Table").row, m.store["Payments Table"].slice(0, 3)],
			[200, ["get FORMULA", "update Payments Table!A4"], ["RC-7000", "Della Garcia", "$1,500.00", "", "", "", "", ""], tabs["Payments Table"]]);
	}
	return results;
}

// ---------------------------------------------------------------------------
// POST /api/dispatch and POST /api/dispatch/reassign, lifted whole. The load
// binding, the period guard and the refusal senders are stubbed (their own
// runners cover them); the snapshot read, the formula rule and the writes are
// the shipped code.
// ---------------------------------------------------------------------------
function mountDispatch(routeSrc, { account = null } = {}) {
	const sheet = fakeSheets({ "Job Tracking": [JT_HEADERS.slice(), jtRow("111", { Driver: "Old Driver", "Job Status": "Dispatched", Truck: "LogisX-#33", "Owner ID": "0" }), jtRow("222")] });
	const audits = [];
	let handler = null;
	const env = {
		app: { post: (p, gate, h) => { handler = h; } },
		requireRole: () => null,
		resolveSheetDataRow: H.resolveSheetDataRow,
		db: { prepare: (sql) => ({
			get: () => (/FROM users/.test(sql) ? (account ? { driver_name: account } : undefined)
				: /FROM trucks|truck_assignments/.test(sql) ? { unit_number: "LogisX-#91", owner_id: 5 } : undefined),
			run: () => ({ changes: 0 }),
		}) },
		// The Truck / Owner ID lookup (its own subject is
		// scripts/test-truck-stamp-spacing.js): the driver's truck, as before.
		findTruckForDriverStamp: () => ({ unit_number: "LogisX-#91", owner_id: 5, matchedBy: "case" }),
		getSheets: sheet.getSheets,
		readJobTrackingSnapshot,
		sendDispatchRefusal: (req, res, blocked) => res.status(409).json({ code: blocked.code }),
		resolveLoadBinding: () => null,
		sendLoadBindRefusal: (req, res) => res.status(409).json({ code: "LOAD_ROW_MISMATCH" }),
		dispatchWriteBlocker: () => null,
		sheetRowToObject: H.sheetRowToObject,
		colLetter: H.colLetter,
		formulaCellRefusal: H.formulaCellRefusal,
		reservedDriverNameRefusal: H.reservedDriverNameRefusal,
		SPREADSHEET_ID: "sheet-under-test",
		insertNotification: { run: () => ({ lastInsertRowid: 1 }) },
		insertDispatchNotification: { run: () => ({}) },
		io: { to: () => ({ emit: () => {} }) },
		driverRoom: (n) => `driver:${String(n).toLowerCase()}`,
		logAudit: (req, action) => { audits.push(action); },
		recordStatusChange: () => {},
		notifyChange: () => {},
		jtCacheInvalidate: () => {},
		console: QUIET,
	};
	const names = Object.keys(env);
	new Function(...names, routeSrc)(...names.map((k) => env[k]));
	if (typeof handler !== "function") throw new Error("a lifted dispatch route did not register a handler");
	return { run: runAs(() => handler), log: sheet.log, audits };
}

async function dispatchSection(routes = { dispatch: DISPATCH_SRC, reassign: REASSIGN_SRC }) {
	const { results, t } = collector();
	const DRIVER_CELL = `Job Tracking!${H.colLetter(JT_IDX["Driver"])}2`;
	for (const [label, src, key] of [["POST /api/dispatch", routes.dispatch, "driver"], ["POST /api/dispatch/reassign", routes.reassign, "newDriver"]]) {
		const body = (name) => ({ rowIndex: 2, loadId: "111", [key]: name });
		for (const [what, name] of [["=SUM(A1:A2)", "=SUM(A1:A2)"], ["\"  =B2\" (leading spaces)", "  =B2"], ["\"+A1\" (a leading \"+\")", "+A1"]]) {
			const m = mountDispatch(src);
			const r = await m.run("Dispatcher", body(name));
			t(`${label}, Dispatcher, ${key} ${what}: 400 FORMULA_NOT_ALLOWED naming Driver, nothing written or audited`,
				[r.code, r.body && r.body.code, r.body && r.body.field, bodyKeys(r), m.log.writes.length, m.audits.length],
				[400, "FORMULA_NOT_ALLOWED", "Driver", ["error", "code", "field"], 0, 0]);
		}
		// A driver name that reads as a built-in property name: refused for every
		// role, before the sheet is read, naming the request field.
		for (const role of ["Dispatcher", "Super Admin"]) {
			for (const name of ["__proto__", " Constructor ", "toString"]) {
				const m = mountDispatch(src);
				const r = await m.run(role, body(name));
				t(`${label}, ${role}, ${key} ${JSON.stringify(name)}: 400 DRIVER_NAME_RESERVED naming ${key}; nothing read, written or audited`,
					[r.code, r.body && r.body.code, r.body && r.body.field, bodyKeys(r), m.log.reads.length, m.log.writes.length, m.audits.length],
					[400, "DRIVER_NAME_RESERVED", key, ["error", "code", "field"], 0, 0, 0]);
			}
		}
		{
			const m = mountDispatch(src, { account: "constructor" });
			const r = await m.run("Dispatcher", body("CONSTRUCTOR"));
			t(`${label}, Dispatcher, a name an existing account already spells as a built-in property name: refused all the same`,
				[r.code, r.body && r.body.code, m.log.writes.length], [400, "DRIVER_NAME_RESERVED", 0]);
		}
		for (const [what, role, name, account, expected] of [
			["a name with no account", "Dispatcher", "Pat Newhire", null, "Pat Newhire"],
			["a name matching an account", "Dispatcher", "kevin driver", "Kevin Driver", "Kevin Driver"],
			["an \"=\" inside the name", "Dispatcher", "Kevin=Driver", null, "Kevin=Driver"],
			["a formula from a Super Admin", "Super Admin", "=B2", null, "=B2"],
			["a name containing a built-in property name", "Dispatcher", "Tostring Smith", null, "Tostring Smith"],
			["...from a Super Admin", "Super Admin", "Constructor Jones", null, "Constructor Jones"],
		]) {
			const m = mountDispatch(src, { account });
			const r = await m.run(role, body(name));
			const cell = m.log.writes.find((w) => w.range === DRIVER_CELL);
			t(`${label}, ${role}, ${what}: 200, the Driver cell written as ${JSON.stringify(expected)}, USER_ENTERED`,
				[r.code, cell && cell.row[0], cell && cell.valueInputOption], [200, expected, "USER_ENTERED"]);
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// §2 RATECON_SHEET_FIELDS, DERIVED — which extracted fields reach a written cell.
// A Super Admin run (never refused), every field carrying its own marker.
// ---------------------------------------------------------------------------
async function derivedSheetFields() {
	const marker = (i) => `ZQ${i}ZQ`;   // passes the Load Number whitelist
	const fields = Object.fromEntries(RATECON_GEMINI_FIELDS.map((k, i) => [k, marker(i)]));
	const m = mountRatecon(RATECON_SRC);
	const r = await m.run("Super Admin", { fields });
	if (r.code !== 200) throw new Error(`the marker run answered ${r.code}: ${JSON.stringify(r.body)}`);
	const cells = written(m.log);
	return RATECON_GEMINI_FIELDS.filter((k, i) => cells.some((c) => c.includes(marker(i))));
}

// ---------------------------------------------------------------------------
// §3 ORDER — each check before what it must precede, in the route's own text.
// ---------------------------------------------------------------------------
function orderChecks() {
	const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	const c = code(RATECON_SRC);
	const check1 = c.indexOf("formulaCellRefusal(RATECON_SHEET_FIELDS, [], RATECON_SHEET_FIELDS.map((k) => fields[k]));");
	const claim = c.indexOf("rateConCreateInFlight.add(");
	const firstRead = c.indexOf(".values.get(");
	const check2 = c.indexOf("formulaCellRefusal(columns, [], cells);");
	const firstWrite = c.indexOf(".values.append(");
	check("from-ratecon: check 1 precedes the claim, which precedes the first sheet read",
		[check1 > 0, check1 < claim, claim < firstRead], [true, true, true]);
	check("from-ratecon: check 2 precedes the first write, the Job Tracking append",
		[check2 > 0, check2 < firstWrite], [true, true]);
	check("from-ratecon: the two upserts are handed the mappings check 2 judged",
		[c.split('upsertByKey("Payments Table", " Job ID", paymentsMapping, { preserveFilled: true })').length - 1,
			c.split('upsertByKey("Job Details", "Load ID", jobDetailsMapping)').length - 1,
			/\["Payments Table", Object\.keys\(paymentsMapping\), Object\.values\(paymentsMapping\)\]/.test(c),
			/\["Job Details", Object\.keys\(jobDetailsMapping\), Object\.values\(jobDetailsMapping\)\]/.test(c)],
		[1, 1, true, true]);
	for (const [label, src, v] of [["POST /api/dispatch", DISPATCH_SRC, "driver"], ["POST /api/dispatch/reassign", REASSIGN_SRC, "newDriver"]]) {
		const d = code(src);
		const at = d.indexOf(`], [${v}]);`);
		const writes = [".values.update(", ".values.batchUpdate("].map((w) => d.indexOf(w)).filter((i) => i >= 0);
		check(`${label}: the refusal precedes every write and the period guard`,
			[at > 0, writes.length === 2 && writes.every((w) => at < w), at < d.indexOf("dispatchWriteBlocker(")], [true, true, true]);
		const reservedAt = d.indexOf(`reservedDriverNameRefusal(${v}, "${v}")`);
		check(`${label}: the driver-name refusal precedes the first sheet read`,
			[reservedAt > 0, reservedAt < d.indexOf("getSheets()")], [true, true]);
	}
}

// ---------------------------------------------------------------------------
// §5 MUTANTS — one per refusal. Built OUTSIDE the probes' try: a mutation
// target that has vanished must fail the run, not read as "detected".
// ---------------------------------------------------------------------------
const MR1 = mutate(RATECON_SRC, "if (formula) return res.status(400).json(formula);", "");
const MR2 = mutate(RATECON_SRC, "if (formula) return res.status(400).json({ ...formula, sheet });", "");
const MD = mutate(DISPATCH_SRC, "if (formula) return res.status(400).json(formula);", "");
const MA = mutate(REASSIGN_SRC, "if (formula) return res.status(400).json(formula);", "");
const MDR = mutate(DISPATCH_SRC, "if (reservedDriver) return res.status(400).json(reservedDriver);", "");
const MAR = mutate(REASSIGN_SRC, "if (reservedDriver) return res.status(400).json(reservedDriver);", "");
// MU: a matched row written as it was before sheetRowCellWrites(), the whole
// row from column A in one values.update, whatever changed. The target runs
// from the cell diff to the branch's return, cut from the shipped route.
const MU = (() => {
	const head = "const cellWrites = sheetRowCellWrites(a1SheetPrefix(tabName), matchRow, existingRow,";
	const tail = 'return { action: cellWrites.length ? "updated" : "unchanged", row: matchRow, conflicts };';
	const from = RATECON_SRC.indexOf(head);
	const to = from < 0 ? -1 : RATECON_SRC.indexOf(tail, from);
	if (from < 0 || to < 0) throw new Error("mutant target MU (the matched-row cell writes in upsertByKey) not found in the from-ratecon route");
	return mutate(RATECON_SRC, RATECON_SRC.slice(from, to + tail.length),
		"await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!A${matchRow}`, " +
		"valueInputOption: \"USER_ENTERED\", requestBody: { values: [rowValues] } });\n" +
		"\t\t\t\treturn { action: \"updated\", row: matchRow, conflicts };");
})();
const caughtBy = (results) => results.filter((r) => !r.ok);
const mutants = [
	["MR1 from-ratecon without check 1 (the field check before the claim and the reads)", async () => caughtBy(await rateconSection(MR1))],
	["MR2 from-ratecon without check 2 (the cells as written)", async () => caughtBy(await rateconSection(MR2))],
	["MU from-ratecon's upsert back to a whole-row values.update of a matched row", async () => caughtBy(await upsertSection(MU))],
	["MD POST /api/dispatch without the refusal", async () => caughtBy(await dispatchSection({ dispatch: MD, reassign: REASSIGN_SRC }))],
	["MA POST /api/dispatch/reassign without the refusal", async () => caughtBy(await dispatchSection({ dispatch: DISPATCH_SRC, reassign: MA }))],
	["MDR POST /api/dispatch without the driver-name refusal", async () => caughtBy(await dispatchSection({ dispatch: MDR, reassign: REASSIGN_SRC }))],
	["MAR POST /api/dispatch/reassign without the driver-name refusal", async () => caughtBy(await dispatchSection({ dispatch: DISPATCH_SRC, reassign: MAR }))],
];

(async () => {
	// §1 the list itself
	check("RATECON_SHEET_FIELDS: no duplicates, every entry a field the extractor returns",
		[new Set(RATECON_SHEET_FIELDS).size === RATECON_SHEET_FIELDS.length, RATECON_SHEET_FIELDS.filter((k) => !RATECON_GEMINI_FIELDS.includes(k))],
		[true, []]);
	check("fixture: LEGIT carries every field the extractor returns", Object.keys(LEGIT).sort(), RATECON_GEMINI_FIELDS.slice().sort());
	// §2 derived
	check("RATECON_SHEET_FIELDS is exactly the set of fields the shipped route writes to a sheet",
		(await derivedSheetFields()).sort(), RATECON_SHEET_FIELDS.slice().sort());
	// §3 order
	orderChecks();
	// §4 the routes
	record(await rateconSection());
	// §4b the upserts
	record(await upsertSection());
	record(await dispatchSection());

	console.log("\n§5 mutants");
	for (const [label, probe] of mutants) {
		// A probe that throws has proved nothing about the mutant: it is a failure
		// of this runner, not a detection.
		let detected = false;
		let detail = "";
		try {
			const out = await probe();
			detected = out.length > 0;
			if (detected) detail = `caught by ${out.length} check(s), e.g. ✗ ${out[0].name}`;
		} catch (e) {
			detail = `the probe threw: ${e && e.message ? e.message : e}`;
		}
		check(`mutant detected — ${label}`, detected, true);
		console.log(`  ${detected ? "caught " : "MISSED "} ${label}${detail ? ` — ${detail}` : ""}`.slice(0, 260));
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
