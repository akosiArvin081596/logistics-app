#!/usr/bin/env node
// Locks the formula refusal on the routes, besides the two PUTs, that write a
// non-Super-Admin's text into Google Sheets. Every one of them writes with
// valueInputOption "USER_ENTERED", which stores a value starting with "=" as a
// formula, and only a Super Admin enters formulas.
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
${extract("colLetter")}
${extract("sheetRowToObject")}
${extract("resolveSheetDataRow")}
return { ADDRESS_MAX_CHARS, boundAddressForStorage, parseSheet, findCol, formulaCellRefusal, colLetter, sheetRowToObject, resolveSheetDataRow };
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
	r[JT_IDX["Broker Contact Name"]] = "Danna Garcia";
	for (const [k, v] of Object.entries(over || {})) r[JT_IDX[k]] = v;
	return r;
}
// The key column really is " Job ID"; Job Details' column A header is blank.
const PAYMENTS_HEADERS = [" Job ID", "Contract ID", "Payment Amount", "Invoice Number", "Payment Status"];
const JOB_DETAILS_HEADERS = ["", "Distance", "Rate Per Mile", "Details", "Payment", "output (retired)"];

// A clean rate-con, every key the extractor returns.
const LEGIT = {
	"Load Number": "RC-5001", "Broker Name": "Danna Garcia", "Broker Phone": "555-0142",
	"Broker Email": "danna.garcia@example.invalid", "Driver Name": "Kevin",
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

// A sheet that records every read and write; `tabs` maps a tab to its rows.
function fakeSheets(tabs) {
	const log = { reads: [], writes: [] };
	const tabOf = (range) => String(range).split("!")[0];
	const values = {
		get: async ({ range }) => {
			log.reads.push(range);
			const rows = tabs[tabOf(range)];
			if (!rows) throw new Error(`fake sheet has no tab ${tabOf(range)}`);
			return { data: { values: rows.map((r) => r.slice()) } };
		},
		append: async ({ range, valueInputOption, requestBody }) => {
			log.writes.push({ op: "append", tab: tabOf(range), valueInputOption, row: requestBody.values[0].slice() });
			const n = tabs[tabOf(range)].length + 1;
			return { data: { updates: { updatedRange: `${tabOf(range)}!A${n}:Z${n}` } } };
		},
		update: async ({ range, valueInputOption, requestBody }) => {
			log.writes.push({ op: "update", tab: tabOf(range), range, valueInputOption, row: requestBody.values[0].slice() });
			return { data: {} };
		},
		batchUpdate: async ({ requestBody }) => {
			for (const d of requestBody.data) {
				log.writes.push({ op: "batch", tab: tabOf(d.range), range: d.range, valueInputOption: requestBody.valueInputOption, row: d.values[0].slice() });
			}
			return { data: {} };
		},
	};
	return { getSheets: async () => ({ spreadsheets: { values } }), log };
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
// geocodeAddress() answers null, so load_coordinates is skipped too.
// ---------------------------------------------------------------------------
function mountRatecon(routeSrc) {
	const sheet = fakeSheets({
		"Job Tracking": [JT_HEADERS.slice(), jtRow("RC-1000")],
		"Payments Table": [PAYMENTS_HEADERS.slice()],
		"Job Details": [JOB_DETAILS_HEADERS.slice()],
	});
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
	return { run: runAs(() => handler), log: sheet.log, claims, audits, dm: () => dmCalls };
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
	]) {
		const { r, m } = await run("Dispatcher", { [key]: value });
		t(`from-ratecon, Dispatcher, ${label}: refused by check 1 too`,
			[r.code, r.body && r.body.field, m.log.reads.length], [400, key, 0]);
	}
	{
		const { r } = await run("Dispatcher", { "Load Number": "=1" });
		t("from-ratecon, Dispatcher, a Load Number starting with \"=\": its whitelist refuses it first (400, no code)",
			[r.code, r.body && r.body.code, /unsupported characters/.test((r.body || {}).error || "")], [400, undefined, true]);
	}
	// Not refused: an "=" that does not lead, a "+", and a field no sheet gets.
	for (const [label, over, absent] of [
		["an \"=\" inside the text", { Details: "a=b pallets" }, null],
		["a leading \"+\"", { "Trailer Number": "+A1" }, null],
		["a field that reaches no sheet (Pickup Notes)", { "Pickup Notes/Instructions": "=== LIVE LOAD ===" }, "=== LIVE LOAD ==="],
		["a field that reaches no sheet (Total Rate)", { "Total Rate": "=1650" }, "=1650"],
	]) {
		const { r, m } = await run("Dispatcher", over);
		t(`from-ratecon, Dispatcher, ${label}: 200, three writes${absent ? ", the value in none of them" : ""}`,
			[r.code, m.log.writes.length, absent ? written(m.log).some((c) => c.includes(absent)) : false], [200, 3, false]);
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
		for (const [what, name] of [["=SUM(A1:A2)", "=SUM(A1:A2)"], ["\"  =B2\" (leading spaces)", "  =B2"]]) {
			const m = mountDispatch(src);
			const r = await m.run("Dispatcher", body(name));
			t(`${label}, Dispatcher, ${key} ${what}: 400 FORMULA_NOT_ALLOWED naming Driver, nothing written or audited`,
				[r.code, r.body && r.body.code, r.body && r.body.field, bodyKeys(r), m.log.writes.length, m.audits.length],
				[400, "FORMULA_NOT_ALLOWED", "Driver", ["error", "code", "field"], 0, 0]);
		}
		for (const [what, role, name, account, expected] of [
			["a name with no account", "Dispatcher", "Pat Newhire", null, "Pat Newhire"],
			["a name matching an account", "Dispatcher", "kevin driver", "Kevin Driver", "Kevin Driver"],
			["an \"=\" inside the name", "Dispatcher", "Kevin=Driver", null, "Kevin=Driver"],
			["a formula from a Super Admin", "Super Admin", "=B2", null, "=B2"],
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
const caughtBy = (results) => results.filter((r) => !r.ok);
const mutants = [
	["MR1 from-ratecon without check 1 (the field check before the claim and the reads)", async () => caughtBy(await rateconSection(MR1))],
	["MR2 from-ratecon without check 2 (the cells as written)", async () => caughtBy(await rateconSection(MR2))],
	["MD POST /api/dispatch without the refusal", async () => caughtBy(await dispatchSection({ dispatch: MD, reassign: REASSIGN_SRC }))],
	["MA POST /api/dispatch/reassign without the refusal", async () => caughtBy(await dispatchSection({ dispatch: DISPATCH_SRC, reassign: MA }))],
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
