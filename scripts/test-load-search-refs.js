#!/usr/bin/env node
// lib/load-search-refs.js: the reference numbers a dashboard row can be found
// by besides its Load ID (B19).
//
// WHY THIS EXISTS. The dashboard's three load tabs matched the Load ID only, so a
// load stored under one number (a broker's LEG number, say) could not be found by
// the Order #, PO, move or reference number its broker and its paperwork use.
// GET /api/dashboard now attaches `_refs: [{ label, value }]` to each row it
// serves and the browser matches them (client/src/lib/loadSearch.js).
//
// What this runner pins, against the shipped module and a real in-memory SQLite:
//   §1 normalization: one rule ("#", whitespace, "-" and "." dropped, case
//      ignored), shared with the client (scripts/test-load-search-client.mjs).
//   §2 Pickup Info / Drop-off Info: only a value right after a label ending in
//      ":" or "#"; lists split on ";" and ","; unlabelled numbers (dock, store,
//      year, phone, ZIP, "PO Box") never indexed; a value needs 4+ characters
//      with a digit.
//   §3 Documents (BOL #), and the order-number rule: "$" amounts removed, only
//      tokens with a digit kept, never the order text.
//   §4 annotate: aliases for every role; draft numbers only when
//      includeDraftRefs is exactly true, and then the draft query is the only
//      place they come from (poNumber / moveNumber only out of overrides_json);
//      one prepare per table; "#X" and "X" match; a load not among the rows gets
//      nothing; shape, de-duplication, own Load ID dropped, cap of 20; a failing
//      query leaves the sheet references and throws nothing.
//
// Every number below is made up (public repo). No network, no app.db.
//   node scripts/test-load-search-refs.js      # exits 1 on any failure

"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const MOD_PATH = path.join(__dirname, "..", "lib", "load-search-refs.js");
let refs;
try {
	refs = require(MOD_PATH);
} catch (err) {
	console.log(`FAIL  lib/load-search-refs.js loads (${err.message.split("\n")[0]})`);
	console.log("\n0 passed, 1 failed");
	process.exit(1);
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
}
const values = (list) => (list || []).map((r) => r.value);
const pairs = (list) => (list || []).map((r) => `${r.label}=${r.value}`);

// The verbatim 26-column Job Tracking header row (as in
// scripts/test-broker-column-redaction.js).
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver",
	"Pickup Info", "Pickup Address", "Pickup Appointment", "Drop-off Info",
	"Drop-off Address", "Drop-off Appointment", "Job Status", "Phase of Progress",
	"Carrier Stage", "Broker Contact Name", "Phone Number", "Email",
	"Assigned Date", "Status Update Date", "Completion Date", "Location Link",
	"Documents", "  Payment  ", "Truck", "Owner ID", "output",
];
function row(fields) {
	const r = { _rowIndex: 2 };
	for (const h of HEADERS) r[h] = "";
	return Object.assign(r, fields);
}

// ---------------------------------------------------------------------------
console.log("§1 normalization");
// ---------------------------------------------------------------------------
check("normalizeRef drops #, whitespace, - and ., lowercases",
	["#540000001", " 004-0123456 ", "AB.12 34", "Ref\t#9", null, undefined, 77].map(refs.normalizeRef),
	["540000001", "0040123456", "ab1234", "ref9", "", "", "77"]);
check("isSearchableValue: 4+ characters, a digit, letters and digits only once normalized",
	["4000", "400", "ABCD", "ab12", "004-0123456", "9/15", "12 34", "$700", "2700011", "1,234"].map(refs.isSearchableValue),
	[true, false, false, true, true, false, true, false, true, false]);
check("isSearchableValue: a calendar date is never a value",
	["2030-09-15", "09-15-2030", "9.15.30", "12-31", "13-45"].map(refs.isSearchableValue),
	[false, false, false, false, true]);

// ---------------------------------------------------------------------------
console.log("§2 Pickup Info / Drop-off Info: labelled values only");
// ---------------------------------------------------------------------------
check("REF/PU# value, with its label",
	pairs(refs.labelledRefs("Example Foods DC - REF/PU#: 41000017")), ["REF/PU #=41000017"]);
check("DEL# list split on ';'",
	pairs(refs.labelledRefs("Sample Receiver - DEL#: 2700011; 2700012")), ["DEL #=2700011", "DEL #=2700012"]);
check("APPT and XID on one line, split on ','",
	pairs(refs.labelledRefs("APPT: 20100003, XID: 200000045")), ["APPT #=20100003", "XID=200000045"]);
check("the other labels: PU#, Delivery#, Appointment#, PO, REF (':' or '#', any case)",
	pairs(refs.labelledRefs("pu# 51000001 / Delivery #: 52000002 / appointment#53000003 / PO: 54000004 / ref: AB55000005")),
	["PU #=51000001", "Delivery #=52000002", "Appointment #=53000003", "PO #=54000004", "REF #=AB55000005"]);
check("a dashed value keeps its dashes and leading zeros as written",
	pairs(refs.labelledRefs("PO#: 004-0123456.")), ["PO #=004-0123456"]);
check("nothing unlabelled: dock, store, year, phone, ZIP, 'PO Box'",
	refs.labelledRefs("Dock 4471, Store 99881, 2026, (555) 010-4477, Dallas TX 75001, PO Box 1234"), []);
check("a label without ':' or '#' is not a label",
	refs.labelledRefs("PO 2700011 REF 41000017 APPT 20100003"), []);
check("a label inside a word is not a label",
	refs.labelledRefs("XREF: 41000017 TAPPO: 2700011"), []);
check("a value too short or without a digit is dropped; the list stops at the next label",
	pairs(refs.labelledRefs("PU#: 123; ABCD; 41000018, XID: 200000046")), ["PU #=41000018", "XID=200000046"]);
check("a date or time after APPT is not a value",
	refs.labelledRefs("APPT: 10/15/2030 08:00, APPT: 2030-10-15"), []);
check("a value longer than 40 characters is dropped, not cut",
	refs.labelledRefs(`PO#: ${"1".repeat(41)}`), []);
check("blank, null and non-string cells give nothing",
	[refs.labelledRefs(""), refs.labelledRefs(null), refs.labelledRefs(undefined), refs.labelledRefs({})], [[], [], [], []]);
{
	// Bounded work on any cell: every pattern runs on the first 2000 characters
	// only, so a reference further in is not read, and long runs of spaces,
	// labels or separators give nothing and throw nothing.
	check("a reference past the first 2000 characters of a cell is not read",
		[refs.labelledRefs(`${" ".repeat(1990)}PO#: 2700011`), refs.labelledRefs(`${" ".repeat(1970)}PO#: 2700011`).length], [[], 1]);
	check("long hostile cells give nothing",
		[refs.labelledRefs(`PO#:${" ".repeat(200000)}x`), refs.labelledRefs("PO#: 1;".repeat(50000)), refs.labelledRefs(`${"REF".repeat(60000)}#`),
			refs.documentRefs(`${"9/".repeat(100000)}`), refs.draftValues(`${"$".repeat(100000)}1`)], [[], [], [], [], []]);
}

// ---------------------------------------------------------------------------
console.log("§3 Documents and draft numbers");
// ---------------------------------------------------------------------------
check("Documents: a BOL number is indexed as BOL #", pairs(refs.documentRefs("61000001")), ["BOL #=61000001"]);
check("Documents: a 'BOL#' prefix is not part of the value", pairs(refs.documentRefs("BOL# 61000002")), ["BOL #=61000002"]);
check("Documents: a date or a word gives nothing",
	[refs.documentRefs("9/15"), refs.documentRefs("9/15/2030"), refs.documentRefs("POD"), refs.documentRefs("Received")], [[], [], [], []]);
check("order number '7000001-$700 ADV' gives 7000001 only", refs.draftValues("7000001-$700 ADV"), ["7000001"]);
check("order number '7000001  -' gives 7000001 only", refs.draftValues("7000001  -"), ["7000001"]);
check("order number '$1,500 ADV' gives nothing", refs.draftValues("$1,500 ADV"), []);
check("draft values: an invoice id keeps its dash; a number from JSON is read as text",
	[refs.draftValues("09012030-3"), refs.draftValues(2700031), refs.draftValues(null)], [["09012030-3"], ["2700031"], []]);

// ---------------------------------------------------------------------------
console.log("§4 annotateLoadSearchRefs()");
// ---------------------------------------------------------------------------
function makeDb() {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE ratecon_load_aliases (alias TEXT PRIMARY KEY, load_id TEXT NOT NULL, source TEXT DEFAULT '', drive_file_id TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT,
			recipient_source TEXT, total TEXT, broker_name TEXT, order_number TEXT, via TEXT, created_at TEXT, created_by TEXT,
			edited INTEGER DEFAULT 0, edited_fields TEXT DEFAULT '', overrides_json TEXT DEFAULT '', total_source TEXT DEFAULT '',
			sheet_total TEXT DEFAULT '', ratecon_total TEXT DEFAULT '', invoice_id_minted TEXT DEFAULT '', notes TEXT DEFAULT '');
	`);
	return db;
}
// A db whose prepare() calls are counted per table, optionally failing one.
function spy(db, failTable) {
	const prepared = [];
	return {
		prepared,
		prepare(sql) {
			const table = /ratecon_load_aliases/.test(sql) ? "aliases" : /load_invoice_drafts/.test(sql) ? "drafts" : "other";
			prepared.push(table);
			if (table === failTable) throw new Error(`no such table: ${failTable}`);
			return db.prepare(sql);
		},
	};
}
const silent = { errors: [], error(msg) { this.errors.push(String(msg)); } };
const freshLogger = () => ({ errors: [], error(msg) { this.errors.push(String(msg)); } });

const db = makeDb();
db.prepare("INSERT INTO ratecon_load_aliases (alias, load_id, source) VALUES (?, ?, ?)").run("7000002", "#80000001", "drive-content");
db.prepare("INSERT INTO ratecon_load_aliases (alias, load_id, source) VALUES (?, ?, ?)").run("7000009", "89999999", "drive-content");
const insDraft = db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, total, broker_name, order_number, overrides_json, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
insDraft.run("80000001", "09012030-1", "ap@example.invalid", "$900.00", "Example Broker 3141", "7000002-$700 ADV",
	JSON.stringify({ poNumber: "2700021", moveNumber: "20100021", invoiceNumber: "9100001", billToName: "Example Co 4455", notes: "Note 8800123" }), "Note 8800124");
insDraft.run("#80000002", "09012030-2", "ap2@example.invalid", "$1,500 ADV", "Example Broker 3142", "$1,500 ADV", "", "");
insDraft.run("80000002", "09012030-3", "", "", "", "7000003  -", "{not json", "");
insDraft.run("89999998", "09012030-4", "", "", "", "7000008", JSON.stringify({ poNumber: "2700028" }), "");

function rows() {
	return [
		row({ "Load ID": "80000001", "Pickup Info": "Example Foods DC - REF/PU#: 41000017", "Drop-off Info": "DEL#: 2700011; 2700012", Documents: "61000001",
			"Broker Contact Name": "PO#: 9900001", "Phone Number": "REF#: 9900002", Email: "XID: 9900003" }),
		row({ "Load ID": "#80000002", "Pickup Info": "APPT: 20100003, XID: 200000045", Documents: "POD" }),
		row({ "Load ID": "80000003", "Pickup Info": "Dock 4471, Store 99881", Documents: "9/15" }),
	];
}
{
	const list = rows();
	const out = refs.annotateLoadSearchRefs({ db, headers: HEADERS, rows: list, includeDraftRefs: false, logger: silent });
	check("returns the same rows, annotated in place", out === list && out[0] === list[0], true);
	check("Dispatcher view (includeDraftRefs false): alias Order # first, then Pickup, Drop-off, BOL #",
		pairs(list[0]._refs), ["Order #=7000002", "REF/PU #=41000017", "DEL #=2700011", "DEL #=2700012", "BOL #=61000001"]);
	check("no draft value without includeDraftRefs (order, PO, move, invoice id)",
		values(list[0]._refs).some((v) => /^(2700021|20100021|09012030-\d|7000003)$/.test(v)), false);
	check("nothing read from the broker contact columns", values(list[0]._refs).some((v) => /^99000/.test(v)), false);
	check("'#X' row matched to an alias / labelled refs on the '#' spelling",
		pairs(list[1]._refs), ["APPT #=20100003", "XID=200000045"]);
	check("a row with no reference gets no _refs key", "_refs" in list[2], false);
	check("an alias whose load is not among the rows attaches nowhere",
		list.some((r) => values(r._refs).includes("7000009")), false);
	check("entries are exactly { label, value } strings",
		list[0]._refs.every((e) => Object.keys(e).join() === "label,value" && typeof e.label === "string" && typeof e.value === "string"), true);
}
{
	const list = rows();
	const s = spy(db);
	refs.annotateLoadSearchRefs({ db: s, headers: HEADERS, rows: list, includeDraftRefs: false, logger: silent });
	check("includeDraftRefs false never prepares the draft query", s.prepared, ["aliases"]);
	for (const flag of ["true", 1, "Super Admin", {}]) {
		const t = spy(db);
		refs.annotateLoadSearchRefs({ db: t, headers: HEADERS, rows: rows(), includeDraftRefs: flag, logger: silent });
		check(`includeDraftRefs ${JSON.stringify(flag)} (not exactly true) never prepares the draft query`, t.prepared, ["aliases"]);
	}
}
{
	const list = rows();
	const s = spy(db);
	refs.annotateLoadSearchRefs({ db: s, headers: HEADERS, rows: list, includeDraftRefs: true, logger: silent });
	check("Super Admin: one prepare per table", s.prepared, ["aliases", "drafts"]);
	check("Super Admin: draft Order #, PO #, Move #, Invoice # added, numbers only",
		pairs(list[0]._refs),
		["Order #=7000002", "PO #=2700021", "Move #=20100021", "Invoice #=09012030-1",
			"REF/PU #=41000017", "DEL #=2700011", "DEL #=2700012", "BOL #=61000001"]);
	check("Super Admin: no recipient, broker name, total, notes, other override keys, or order text",
		JSON.stringify(list).match(/example\.invalid|Example Broker|\$|ADV|9100001|4455|8800123|8800124/g), null);
	check("Super Admin: drafts match '#X' and 'X' both ways; '' and malformed overrides give nothing and throw nothing",
		pairs(list[1]._refs), ["Order #=7000003", "Invoice #=09012030-3", "Invoice #=09012030-2", "APPT #=20100003", "XID=200000045"]);
	check("Super Admin: a draft whose load is not among the rows attaches nowhere",
		list.some((r) => values(r._refs).some((v) => v === "7000008" || v === "2700028")), false);
	check("Super Admin: the draft SQL selects only the needed columns",
		[/recipient|broker_name|\btotal\b|notes|SELECT \*/.test(refs.DRAFT_SQL), /json_extract\(overrides_json, '\$\.poNumber'\)/.test(refs.DRAFT_SQL),
			/json_extract\(overrides_json, '\$\.moveNumber'\)/.test(refs.DRAFT_SQL), (refs.DRAFT_SQL.match(/json_extract/g) || []).length,
			(refs.DRAFT_SQL.match(/json_valid\(overrides_json\)/g) || []).length],
		[false, true, true, 2, 2]);
}
{
	// One prepare per table whatever the row count.
	const many = [];
	for (let i = 0; i < 600; i++) many.push(row({ "Load ID": String(81000000 + i), "Pickup Info": `PU#: ${82000000 + i}` }));
	const s = spy(db);
	refs.annotateLoadSearchRefs({ db: s, headers: HEADERS, rows: many, includeDraftRefs: true, logger: silent });
	check("600 rows: still one prepare per table", s.prepared, ["aliases", "drafts"]);
	check("600 rows: each row has its own labelled value", many.every((r, i) => values(r._refs)[0] === String(82000000 + i)), true);
}
{
	// De-duplication on the normalized form, own Load ID dropped, cap of 20.
	const r = row({ "Load ID": "#83000001",
		"Pickup Info": "PO#: 2700-041; 2700041, REF#: 83000001, XID: 004-0123456",
		"Drop-off Info": Array.from({ length: 25 }, (_, i) => `DEL#: ${84000000 + i}`).join(" "),
		Documents: "BOL# 2700041" });
	refs.annotateLoadSearchRefs({ db: makeDb(), headers: HEADERS, rows: [r], includeDraftRefs: true, logger: silent });
	check("de-duplicated on the normalized form (first spelling kept)", values(r._refs).filter((v) => refs.normalizeRef(v) === "2700041"), ["2700-041"]);
	check("a value equal to the row's own Load ID is dropped", values(r._refs).includes("83000001"), false);
	check("leading zeros kept as written", values(r._refs).includes("004-0123456"), true);
	check("at most 20 per row", r._refs.length, 20);
}
{
	// A failing query: one console.error, the sheet references stay, no throw.
	for (const failTable of ["aliases", "drafts"]) {
		const list = rows();
		const logger = freshLogger();
		let threw = null;
		try {
			refs.annotateLoadSearchRefs({ db: spy(db, failTable), headers: HEADERS, rows: list, includeDraftRefs: true, logger });
		} catch (e) { threw = e; }
		check(`${failTable} query fails: no throw, one error logged`, [threw === null, logger.errors.length], [true, 1]);
		check(`${failTable} query fails: the sheet references are still there`,
			values(list[0]._refs).filter((v) => ["41000017", "2700011", "2700012", "61000001"].includes(v)), ["41000017", "2700011", "2700012", "61000001"]);
	}
	const list = rows();
	let threw = null;
	try {
		refs.annotateLoadSearchRefs({ db: null, headers: HEADERS, rows: list, includeDraftRefs: true, logger: freshLogger() });
		refs.annotateLoadSearchRefs({ db, headers: undefined, rows: list, logger: freshLogger() });
		refs.annotateLoadSearchRefs({ db, headers: HEADERS, rows: undefined, logger: freshLogger() });
		refs.annotateLoadSearchRefs();
	} catch (e) { threw = e; }
	check("no db, no headers, no rows, no argument: nothing thrown", threw === null, true);
	check("no db: the sheet references still attach", values(list[0]._refs).includes("41000017"), true);
}
{
	// Strict mode: a frozen row (a cached one) is refused loudly, never half-written.
	const frozen = Object.freeze(row({ "Load ID": "85000001", "Pickup Info": "PU#: 85000002" }));
	const logger = freshLogger();
	refs.annotateLoadSearchRefs({ db: makeDb(), headers: HEADERS, rows: [frozen], logger });
	check("a frozen row is left alone and the failure is logged, not thrown", ["_refs" in frozen, logger.errors.length > 0], [false, true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
