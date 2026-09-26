#!/usr/bin/env node
// Locks the broker-contact redaction: which columns a non-Super-Admin is served
// blank, that every cell in them is served blank whatever its format, and that
// PUT /api/data/:rowIndex still puts the stored value back when the redacted
// copy is saved.
//
// THE ORDERING BUG (the reason this file exists). sanitizeBrokerColumns() used
// to pick one column per role with two loose regexes over the whole header row:
//
//     const brokerCol = headers.find((h) => /broker/i.test(h));
//     const phoneCol  = headers.find((h) => /phone|contact/i.test(h));
//
// Production's Job Tracking header row carries, in this order:
//
//     … "Broker Contact Name", "Phone Number", "Email" …
//
// `/phone|contact/i` matches "Broker **Contact** Name", and `.find()` returns
// the FIRST match — which sorts before "Phone Number". So both lookups resolved
// to the same column and the function did the exact inverse of its job: the
// broker's NAME was blanked, and "Phone Number" and "Email" were referenced by no
// lookup at all and served in full to every non-Super-Admin caller.
//
// THE OWNER'S DECISION, 2026-09-26: a non-Super-Admin gets NO broker contact
// data, names included, whatever the cell's format. Until then a cell holding a
// JSON contact blob ({"Name":…,"Phone":…}) was reduced to its name rather than
// blanked, on the belief that production held no such cell. A read of a copy of
// production's sheet that day found "Broker Contact Name" at 183 JSON cells and
// 158 plain ones, and "Phone Number" at 254 JSON cells — so a Dispatcher saw the
// agent's name on some loads and a blank on others. Every such cell is blank now,
// and the helper that did the reducing (sanitizeBrokerContact) is gone.
//
// ⚠️ THE FIXTURE IS THE TEST. The ordering bug is entirely about header ORDER, so
// a synthetic list like ["Broker", "Phone"] reproduces nothing. Every case runs
// against the verbatim 26-column production header row (identical to the fixture
// in test-put-load-guard.js).
//
// ⚠️ READER AND WRITER SHARE ONE RESOLVER, and that is a data-loss guard, not
// tidiness. PUT /api/data/:rowIndex puts the real values back so a
// non-Super-Admin's save cannot overwrite the record with the redacted copy they
// were served. When the writer carried its own column list it missed "Email", so
// redacting Email would have had a Dispatcher blank the stored address on every
// save. The writer is restoreWithheldBrokerCells(), extracted and run here — the
// shipped code, not a re-implementation — including the copy a page loaded
// before 2026-09-26 still holds for a JSON cell.
//
// Everything is EXTRACTED from server.js: testing a re-implementation would prove
// nothing about the code that serves the rows. No network, no database, no sheet.
//
//   node scripts/test-broker-column-redaction.js     # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

let pass = 0, fail = 0;
const failures = [];
const asyncChecks = [];   // awaited before the summary
function check(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return true; }
	fail++; failures.push(`${name}\n     expected ${e}\n     actual   ${a}`);
	console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
	return false;
}

// ---------------------------------------------------------------- extraction
// Terminates on the first `}` in COLUMN 0 rather than by counting braces.
// legacyServedBrokerCell() tests `trimmed.startsWith("{")`, and a brace counter
// reads that string literal as a real block. Every target is a top-level
// declaration, so its closing brace is unindented.
function extract(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", start);
	if (end < 0) throw new Error(`could not find the top-level end of ${name}()`);
	const body = SRC.slice(start, end + 3);
	// Guard the assumption: `body` starts AT the declaration, so a second
	// `\nfunction ` inside it means the slice ran past this function's end.
	if (body.split("\nfunction ").length - 1 !== 0) throw new Error(`extraction of ${name}() spanned more than one declaration`);
	return body;
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
// would run the ORIGINAL code and "pass", proving nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) throw new Error(`mutant target found ${n}x (expected 1): ${from.slice(0, 70)}`);
	return src.replace(from, to);
}
const reMatch = SRC.match(/const BROKER_WITHHELD_RE = (\/.*\/[a-z]*);/);
if (!reMatch) throw new Error("BROKER_WITHHELD_RE not found in server.js");

const REAL = ["resolveBrokerWithheldColumns", "sanitizeBrokerColumns", "legacyServedBrokerCell", "rowObjectFromCells", "restoreWithheldBrokerCells"];
const REAL_SRC = Object.fromEntries(REAL.map((n) => [n, extract(n)]));
function buildModule(overrides = {}, reSrc = reMatch[1]) {
	const s = { ...REAL_SRC, ...overrides };
	return new Function(
		`const BROKER_WITHHELD_RE = ${reSrc};\n${REAL.map((n) => s[n]).join("\n")}\nreturn { ${REAL.join(", ")} };`
	)();
}
const G = buildModule();

// ------------------------------------------------------------- CLIENT MIRROR
// BROKER_WITHHELD_RE is DUPLICATED in ActiveLoadsTab.vue, and the duplication is
// deliberate: the dispatcher's edit form renders the withheld columns read-only
// rather than as inputs that accept typing and silently round-trip to the stored
// value, and it derives that set with the same regex instead of a hardcoded name
// list — a hardcoded list is precisely how the reader and the writer came to
// disagree about "Email" (see the header of this file).
//
// Both copies fail CLOSED, so the duplication itself is safe. What was not safe
// is that nothing enforced the mirror: the two could drift apart silently, and
// the client half is the one with no server-side backstop behind it. Narrowing
// the client to literal column names is NOT the fix — that re-creates the
// original data-loss bug, which is why both files carry a comment saying so.
//
// Extracted from source text exactly like the server's copy above, and compared
// as a STRING: character-identical, not merely equivalent.
//
// ⚠️ The client declaration carries NO trailing semicolon (Vue SFC style) while
// server.js does. Reusing the `;`-anchored pattern above matches nothing here and
// would throw rather than assert, so this one anchors on end-of-line with the
// semicolon optional.
const CLIENT_MIRROR = path.join(__dirname, "..", "client", "src", "components", "dashboard", "ActiveLoadsTab.vue");
const clientMatch = fs.readFileSync(CLIENT_MIRROR, "utf8").match(/^const BROKER_WITHHELD_RE = (\/.*\/[a-z]*);?\s*$/m);
if (!clientMatch) throw new Error("BROKER_WITHHELD_RE not found in client/src/components/dashboard/ActiveLoadsTab.vue");
check("client BROKER_WITHHELD_RE mirrors server.js character-for-character", clientMatch[1], reMatch[1]);

// ---------------------------------------------------------------------------
// THE FIXTURE — production's Job Tracking header row, verbatim and in order.
// ---------------------------------------------------------------------------
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver",
	"Pickup Info", "Pickup Address", "Pickup Appointment", "Drop-off Info",
	"Drop-off Address", "Drop-off Appointment", "Job Status", "Phase of Progress",
	"Carrier Stage", "Broker Contact Name", "Phone Number", "Email",
	"Assigned Date", "Status Update Date", "Completion Date", "Location Link",
	"Documents", "  Payment  ", "Truck", "Owner ID", "output",
];
check("fixture is the real 26-column header row", HEADERS.length, 26);
// The ordering fact the bug depended on. If these ever stop holding, the
// regression this file guards has changed shape and the suite must be revisited.
check("ordering: Broker Contact Name precedes Phone Number",
	HEADERS.indexOf("Broker Contact Name") < HEADERS.indexOf("Phone Number"), true);
check("ordering: Phone Number precedes Email",
	HEADERS.indexOf("Phone Number") < HEADERS.indexOf("Email"), true);
check("ordering: /phone|contact/i matches the NAME column first (the bug)",
	HEADERS.find((h) => /phone|contact/i.test(h)), "Broker Contact Name");

const WITHHELD = ["Broker Contact Name", "Phone Number", "Email"];
const IDX = Object.fromEntries(HEADERS.map((h, i) => [h.trim(), i]));
function row(overrides) {
	const r = new Array(HEADERS.length).fill("");
	r[IDX["Load ID"]] = "550448673";
	r[IDX["Job Status"]] = "Delivered";
	r[IDX["Payment"]] = "$1,800.00";
	r[IDX["Owner ID"]] = "5";
	r[IDX["Contract ID"]] = "29284990";
	r[IDX["Broker Contact Name"]] = "Danna Garcia";
	r[IDX["Phone Number"]] = "555-0142";
	r[IDX["Email"]] = "danna.garcia@example.invalid";
	for (const [k, v] of Object.entries(overrides || {})) r[IDX[k]] = v;
	return r;
}
const served = (cells, M = G) => M.sanitizeBrokerColumns(HEADERS, [G.rowObjectFromCells(HEADERS, cells)])[0];

// The contact blobs production carries in these cells (a JSON object per cell).
const NAME_BLOB = JSON.stringify({ Name: "Danna Garcia", Phone: "555-0142", Email: "d@example.invalid" });
const PHONE_BLOB = JSON.stringify({ Name: "Danna Garcia", Phone: "555-0142", Ext: "12" });

// ---------------------------------------------------------------------------
// THE ORACLES — the code as it stood at each earlier point, verbatim.
// ---------------------------------------------------------------------------
// The helper that reduced a JSON contact cell to its name (removed 2026-09-26).
function oldSanitizeBrokerContact(value) {
	if (!value || typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed.startsWith("{")) return value;
	try {
		const parsed = JSON.parse(trimmed);
		return JSON.stringify({ Name: parsed.Name || parsed.name || "" });
	} catch {
		return value;
	}
}
// Before the union: one column per role, first match wins (the ordering bug).
function preFixSanitize(headers, rows) {
	const brokerCol = (headers || []).find((h) => /broker/i.test(h)) || null;
	const phoneCol = (headers || []).find((h) => /phone|contact/i.test(h)) || null;
	if (!brokerCol && !phoneCol) return rows;
	return rows.map((r) => {
		const cleaned = { ...r };
		if (brokerCol && cleaned[brokerCol]) cleaned[brokerCol] = oldSanitizeBrokerContact(cleaned[brokerCol]);
		if (phoneCol && cleaned[phoneCol]) {
			const val = (cleaned[phoneCol] || "").trim();
			cleaned[phoneCol] = val.startsWith("{") ? oldSanitizeBrokerContact(val) : "";
		}
		return cleaned;
	});
}
// The union, with the JSON cell reduced to its name (until 2026-09-26).
function nameDegradingSanitize(headers, rows) {
	const withheld = G.resolveBrokerWithheldColumns(headers);
	if (!withheld.length) return rows;
	return rows.map((r) => {
		const cleaned = { ...r };
		for (const col of withheld) {
			if (!cleaned[col]) continue;
			const val = String(cleaned[col]).trim();
			cleaned[col] = val.startsWith("{") ? oldSanitizeBrokerContact(val) : "";
		}
		return cleaned;
	});
}

// ---------------------------------------------------------------------------
// §1 THE LEAK — the two columns the function exists to protect, and the name.
// ---------------------------------------------------------------------------
{
	const out = served(row());
	check("Phone Number is withheld", out["Phone Number"], "");
	check("Email is withheld", out["Email"], "");
	check("Broker Contact Name is withheld", out["Broker Contact Name"], "");
}
{
	const old = preFixSanitize(HEADERS, [G.rowObjectFromCells(HEADERS, row())])[0];
	check("PRE-FIX: Phone Number was served in full (the leak)", old["Phone Number"], "555-0142");
	check("PRE-FIX: Email was served in full (the leak)", old["Email"], "danna.garcia@example.invalid");
	check("PRE-FIX: the harmless name column was the one blanked", old["Broker Contact Name"], "");
}

// ---------------------------------------------------------------------------
// §2 JSON CONTACT CELLS — blank for a non-Super-Admin, whatever the format.
// ---------------------------------------------------------------------------
{
	const out = served(row({ "Broker Contact Name": NAME_BLOB, "Phone Number": PHONE_BLOB }));
	check("a JSON blob in Broker Contact Name is served blank", out["Broker Contact Name"], "");
	check("a JSON blob in Phone Number is served blank", out["Phone Number"], "");
	check("a JSON blob with surrounding whitespace is served blank",
		served(row({ "Broker Contact Name": `  ${NAME_BLOB}\n` }))["Broker Contact Name"], "");
	check("a lower-case name key is served blank",
		served(row({ "Broker Contact Name": JSON.stringify({ name: "Danna Garcia" }) }))["Broker Contact Name"], "");
	check("a blob that does not parse is served blank (it used to be served in full)",
		served(row({ "Broker Contact Name": "{not json" }))["Broker Contact Name"], "");
	check("a whitespace-only cell is served blank", served(row({ "Phone Number": "   " }))["Phone Number"], "");
	check("an empty cell stays empty", served(row({ Email: "" }))["Email"], "");
	const absent = G.sanitizeBrokerColumns(HEADERS, [{ "Load ID": "1" }])[0];
	check("an absent withheld key is not added", Object.keys(absent), ["Load ID"]);

	// Production's mix: "Broker Contact Name" 183 JSON + 158 plain, "Phone Number"
	// 254 JSON. Under the name-degrading reader a Dispatcher saw a name on every
	// JSON cell and a blank on every plain one; now every cell is blank.
	const rows = [];
	for (let i = 0; i < 341; i++) {
		rows.push(G.rowObjectFromCells(HEADERS, row({
			"Load ID": String(900000 + i),
			"Broker Contact Name": i < 183 ? JSON.stringify({ Name: `Agent ${i}`, Phone: `555-${1000 + i}` }) : `Agent ${i}`,
			"Phone Number": i < 254 ? JSON.stringify({ Name: `Agent ${i}`, Phone: `555-${1000 + i}` }) : `555-${1000 + i}`,
		})));
	}
	const namesBefore = nameDegradingSanitize(HEADERS, rows).filter((r) => r["Broker Contact Name"] !== "").length;
	check("ORACLE: the name-degrading reader showed a name on exactly the 183 JSON cells", namesBefore, 183);
	const nonBlankNow = G.sanitizeBrokerColumns(HEADERS, rows)
		.reduce((n, r) => n + WITHHELD.filter((c) => r[c] !== "").length, 0);
	check("production's mix: every withheld cell of all 341 rows is served blank", nonBlankNow, 0);
}

// ---------------------------------------------------------------------------
// §3 COLLATERAL — the columns that must NOT be touched.
// `Payment` carries real surrounding spaces and is matched on h.trim()
// elsewhere; `Owner ID` scopes investor money; `Contract ID` is a reference,
// and note "Contract" is not "Contact" — the near-miss that makes /contact/i
// safe to keep in the union.
// ---------------------------------------------------------------------------
{
	const out = served(row({ "Broker Contact Name": NAME_BLOB }));
	const orig = G.rowObjectFromCells(HEADERS, row({ "Broker Contact Name": NAME_BLOB }));
	for (const h of HEADERS) {
		if (WITHHELD.includes(h)) continue;
		check(`untouched: ${JSON.stringify(h)}`, out[h], orig[h]);
	}
	check("  Payment   keeps its exact spacing and value", out["  Payment  "], "$1,800.00");
	check("Owner ID survives", out["Owner ID"], "5");
	check("Contract ID survives — 'Contract' is not 'Contact'", out["Contract ID"], "29284990");
	check("resolver does not match Contract ID",
		G.resolveBrokerWithheldColumns(HEADERS).includes("Contract ID"), false);
	check("the caller's row object is not mutated", orig["Broker Contact Name"], NAME_BLOB);
}

// ---------------------------------------------------------------------------
// §4 THE RESOLVER — a union, so no column can shadow another — and the change
// only ever NARROWS what is served.
// ---------------------------------------------------------------------------
{
	check("resolver returns all three columns, in header order",
		G.resolveBrokerWithheldColumns(HEADERS), WITHHELD);
	check("resolver is total over the fixture (nothing else matches)",
		G.resolveBrokerWithheldColumns(HEADERS).length, 3);
	check("resolver tolerates missing headers", G.resolveBrokerWithheldColumns(null), []);
	check("resolver tolerates null cells in the header row",
		G.resolveBrokerWithheldColumns([null, "Phone Number", undefined]), ["Phone Number"]);

	// STRICTLY NARROWING against both earlier readers: a cell either reader
	// withheld (served other than stored) is withheld now, on any header row, and
	// no withheld cell is served anything but "".
	const layouts = [
		HEADERS,
		["Broker", "Phone", "Notes"],
		["Contact Number", "Load ID"],
		["Broker Info", "Load ID"],
		["Phone", "Broker Contact Name", "Load ID"],   // reversed order
		["Load ID", "Driver", "Truck"],                 // nothing to redact
	];
	for (const hs of layouts) {
		for (const shape of ["plain", "json"]) {
			const cells = hs.map((h) => shape === "json" ? JSON.stringify({ Name: `n:${h}`, Phone: `p:${h}` }) : `v:${h}`);
			const orig = G.rowObjectFromCells(hs, cells);
			const nowOut = G.sanitizeBrokerColumns(hs, [orig])[0];
			const widened = [preFixSanitize, nameDegradingSanitize].flatMap((old) => {
				const oldOut = old(hs, [orig])[0];
				return hs.filter((h) => oldOut[h] !== orig[h] && nowOut[h] !== "");
			});
			check(`strictly narrowing (${shape}) on ${JSON.stringify(hs.slice(0, 3))}…`, widened, []);
			check(`nothing outside the withheld set changes (${shape}) on ${JSON.stringify(hs.slice(0, 3))}…`,
				hs.filter((h) => !G.resolveBrokerWithheldColumns(hs).includes(h) && nowOut[h] !== orig[h]), []);
		}
	}
}

// ---------------------------------------------------------------------------
// §5 THE WRITER — restoreWithheldBrokerCells(), the shipped splice.
// ---------------------------------------------------------------------------
function splice(before, submitted, M = G) {
	const values = submitted.slice();
	const preserved = M.restoreWithheldBrokerCells(HEADERS, before, values);
	return { values, preserved };
}
const servedCells = (before) => HEADERS.map((h) => served(before)[h]);
{
	const before = row();
	// A Dispatcher saves the row back exactly as they were served it.
	const { values, preserved } = splice(before, servedCells(before));
	check("writer: the stored Phone Number is restored", values[IDX["Phone Number"]], "555-0142");
	check("writer: the stored Email is restored", values[IDX["Email"]], "danna.garcia@example.invalid");
	check("writer: the stored Broker Contact Name is restored", values[IDX["Broker Contact Name"]], "Danna Garcia");
	check("writer: it reports what it preserved", preserved.sort(), ["Broker Contact Name", "Email", "Phone Number"]);
	check("writer: an untouched column is written through", values[IDX["Job Status"]], "Delivered");

	// A genuine edit must still land — the splice restores only the exact
	// redacted copy, never every matching column.
	const edited = servedCells(before);
	edited[IDX["Phone Number"]] = "555-9999";
	check("writer: a genuine edit to a withheld column is NOT reverted",
		splice(before, edited).values[IDX["Phone Number"]], "555-9999");
}
{
	// THE DATA-LOSS CHECK FOR THIS CHANGE: a JSON contact cell is now served
	// blank, and the blank copy saved back must restore the stored blob — never
	// overwrite it.
	const before = row({ "Broker Contact Name": NAME_BLOB, "Phone Number": PHONE_BLOB });
	const sent = servedCells(before);
	check("writer: the Dispatcher's copy of the JSON cells is blank", [sent[IDX["Broker Contact Name"]], sent[IDX["Phone Number"]]], ["", ""]);
	const { values, preserved } = splice(before, sent);
	check("writer: a blanked JSON Broker Contact Name restores the stored blob", values[IDX["Broker Contact Name"]], NAME_BLOB);
	check("writer: a blanked JSON Phone Number restores the stored blob", values[IDX["Phone Number"]], PHONE_BLOB);
	check("writer: both are reported as preserved", preserved.sort(), ["Broker Contact Name", "Email", "Phone Number"]);

	// A page loaded before 2026-09-26 still holds the name-only copy of a JSON
	// cell, and the Active Loads editor sends a withheld column back as the value
	// its row holds. That copy is a round trip too, not an edit.
	const legacy = HEADERS.map((h) => nameDegradingSanitize(HEADERS, [G.rowObjectFromCells(HEADERS, before)])[0][h]);
	check("ORACLE: a pre-change page holds the name-only copy", legacy[IDX["Broker Contact Name"]], JSON.stringify({ Name: "Danna Garcia" }));
	const fromOldPage = splice(before, legacy);
	check("writer: the name-only copy from a pre-change page restores the stored blob (Broker Contact Name)",
		fromOldPage.values[IDX["Broker Contact Name"]], NAME_BLOB);
	check("writer: the name-only copy from a pre-change page restores the stored blob (Phone Number)",
		fromOldPage.values[IDX["Phone Number"]], PHONE_BLOB);
	check("legacyServedBrokerCell: the old copy for a blob, null for a plain or malformed cell",
		[G.legacyServedBrokerCell(` ${NAME_BLOB} `), G.legacyServedBrokerCell("Danna Garcia"), G.legacyServedBrokerCell("{not json"), G.legacyServedBrokerCell(null)],
		[JSON.stringify({ Name: "Danna Garcia" }), null, null, null]);

	// A different value is still an edit, even on a JSON cell.
	const edited = sent.slice();
	edited[IDX["Broker Contact Name"]] = "Pat Replacement";
	check("writer: a genuine edit to a JSON cell is NOT reverted",
		splice(before, edited).values[IDX["Broker Contact Name"]], "Pat Replacement");
}
{
	// A malformed blob is served blank now; its blank round trip restores it too.
	const before = row({ "Broker Contact Name": "{not json" });
	check("writer: a malformed blob's blank copy restores the stored text",
		splice(before, servedCells(before)).values[IDX["Broker Contact Name"]], "{not json");
	// An empty stored cell hid nothing, so a value sent for it is an edit.
	const empty = row({ Email: "" });
	const sent = servedCells(empty);
	sent[IDX["Email"]] = "new@example.invalid";
	const r = splice(empty, sent);
	check("writer: an empty withheld cell can be filled in", r.values[IDX["Email"]], "new@example.invalid");
	check("writer: ...and is not reported as preserved", r.preserved.includes("Email"), false);
	// A shorter values array than the header row: cells past its end are left
	// alone, never read as blanked.
	const short = splice(row(), servedCells(row()).slice(0, IDX["Phone Number"]));
	check("writer: a short values array is not extended", short.values.length, IDX["Phone Number"]);
}
{
	// THE DATA-LOSS REGRESSION of the reader/writer split, stated directly: the
	// writer's old hardcoded candidate filter did not match "Email", so a save
	// would have written "" over the stored address once the reader redacted it.
	const before = row();
	const sent = servedCells(before);
	const oldFilterValues = sent.slice();
	HEADERS.forEach((h, i) => {
		if (!/broker|phone|contact/i.test(h) || !before[i]) return;
		const servedRow = served(before);
		if (String(servedRow[h]) !== String(before[i]) && String(oldFilterValues[i]) === String(servedRow[h])) {
			oldFilterValues[i] = before[i];
		}
	});
	check("PRE-FIX writer: Email would have been blanked on save (data loss)",
		oldFilterValues[IDX["Email"]], "");
	check("FIXED writer: Email survives the same save",
		splice(before, sent).values[IDX["Email"]], "danna.garcia@example.invalid");
}

// ---------------------------------------------------------------------------
// §6 THE CALLERS — only non-Super-Admin paths redact, and every path that
// serves Job Tracking rows to one of them does.
// ---------------------------------------------------------------------------
{
	// Every call of the reader or the writer, apart from their definitions and the
	// writer's own read of the reader, sits behind `role !== "Super Admin"` in the
	// same statement or the `if` around it.
	const writerStart = SRC.indexOf("\nfunction restoreWithheldBrokerCells(") + 1;
	const writerEnd = SRC.indexOf("\n}\n", writerStart);
	const calls = [];
	for (const re of [/sanitizeBrokerColumns\(/g, /restoreWithheldBrokerCells\(/g]) {
		let m;
		while ((m = re.exec(SRC))) {
			const at = m.index;
			const prefix = SRC.slice(SRC.lastIndexOf("\n", at) + 1, at);
			if (prefix === "function ") continue;              // the definition
			if (prefix.includes("//")) continue;               // a mention in a comment
			if (at > writerStart && at < writerEnd) continue;  // the writer's own read
			calls.push(at);
		}
	}
	const unguarded = calls.filter((at) => !/req\.session\.user\.role !== "Super Admin"/.test(SRC.slice(Math.max(0, at - 160), at)));
	check("every route call of the reader or the writer is for a non-Super-Admin only",
		unguarded.map((at) => SRC.slice(at, SRC.indexOf("\n", at)).trim()), []);
	check("the call sites are the ones this file was sized against (data, dashboard x3, driver page, load GET/PUT, the PUT splice)",
		calls.length, 8);
	check("no function reduces a contact cell to its name any more",
		/\nfunction sanitizeBrokerContact\(/.test(SRC), false);
	const readerSrc = extract("sanitizeBrokerColumns");
	check("the reader never serves the pre-change copy", /legacyServedBrokerCell/.test(readerSrc), false);
}
{
	// GET /api/load/:loadId, the shipped handler: it admits a Dispatcher and
	// returns the whole row, so it serves them the row the way every other
	// reader does.
	const ROUTE = extractRoute('app.get("/api/load/:loadId", requireRole("Super Admin", "Dispatcher"), async (req, res) => {');
	const ROWS = [HEADERS, row({ "Load ID": "111", "Broker Contact Name": NAME_BLOB }), row({ "Load ID": "222" })];
	const getSheets = async () => ({ spreadsheets: { values: {
		get: async ({ range }) => ({ data: { values: /!1:1$/.test(range) ? [HEADERS] : ROWS } }),
	} } });
	let handler = null;
	const app = { get: (p, gate, h) => { handler = h; } };
	new Function("app", "requireRole", "getSheets", "SPREADSHEET_ID", "sanitizeBrokerColumns", "console", ROUTE)(
		app, () => null, getSheets, "sheet-under-test", G.sanitizeBrokerColumns, { error() {} });
	const run = async (role, loadId) => {
		const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
		await handler({ params: { loadId }, session: { user: { role, username: "u" } } }, res);
		return res;
	};
	asyncChecks.push((async () => {
		const disp = await run("Dispatcher", "111");
		check("GET /api/load/:loadId, Dispatcher: 200 with every withheld column blank",
			[disp.code, ...WITHHELD.map((c) => disp.body.load[c])], [200, "", "", ""]);
		check("GET /api/load/:loadId, Dispatcher: the rest of the row intact",
			[disp.body.load["Load ID"], disp.body.load["  Payment  "], disp.body.load._rowIndex], ["111", "$1,800.00", 2]);
		const admin = await run("Super Admin", "111");
		check("GET /api/load/:loadId, Super Admin: the stored contact in full",
			[admin.body.load["Broker Contact Name"], admin.body.load["Phone Number"], admin.body.load["Email"]],
			[NAME_BLOB, "555-0142", "danna.garcia@example.invalid"]);
		const miss = await run("Dispatcher", "999");
		check("GET /api/load/:loadId, an unknown load: 404", miss.code, 404);
	})());
	// PUT /api/load/:loadId answers with the updated row too.
	const PUT = extractRoute('app.put("/api/load/:loadId", requireRole("Super Admin", "Dispatcher"), async (req, res) => {');
	check("PUT /api/load/:loadId answers a non-Super-Admin with the row redacted",
		/res\.json\(\{ success: true, load: req\.session\.user\.role !== "Super Admin" \? sanitizeBrokerColumns\(headers, \[result\]\)\[0\] : result \}\);/.test(PUT), true);
}

// ---------------------------------------------------------------------------
// §7 MUTANTS — proof this suite fails against the earlier code.
// ---------------------------------------------------------------------------
const withResolver = (reSrc, fn) => fn(buildModule({}, reSrc));
// Built OUTSIDE the probe's try: a mutation target that has vanished must fail
// the run, not read as "detected".
const M6 = buildModule({
	sanitizeBrokerColumns: mutate(REAL_SRC.sanitizeBrokerColumns,
		'if (cleaned[col]) cleaned[col] = "";',
		'if (cleaned[col]) { const val = String(cleaned[col]).trim(); cleaned[col] = val.startsWith("{") ? (legacyServedBrokerCell(val) || val) : ""; }'),
});
const m6Out = served(row({ "Broker Contact Name": NAME_BLOB, "Phone Number": PHONE_BLOB }), M6);
check("M6 really is the old reader: it serves the JSON cell as its name",
	m6Out["Broker Contact Name"], JSON.stringify({ Name: "Danna Garcia" }));
const mutants = [
	["M1 pre-fix first-match resolver (Phone + Email leak)", () => {
		const old = preFixSanitize(HEADERS, [G.rowObjectFromCells(HEADERS, row())])[0];
		return old["Phone Number"] !== "" || old["Email"] !== "";
	}],
	["M2 union without /phone/ (Phone Number leaks)", () => withResolver("/broker|e-?mail|contact/i", (M) =>
		served(row(), M)["Phone Number"] !== "")],
	["M3 union without /e-?mail/ (Email leaks)", () => withResolver("/broker|phone|contact/i", (M) =>
		served(row(), M)["Email"] !== "")],
	["M4 over-broad union blanks Payment/Owner ID", () => withResolver("/broker|phone|e-?mail|contact|payment|owner/i", (M) => {
		const out = served(row(), M);
		return out["  Payment  "] !== "$1,800.00" || out["Owner ID"] !== "5";
	})],
	["M5 union matching 'Contract ID' via a loose /contac/", () => withResolver("/broker|phone|e-?mail|contrac?t/i", (M) =>
		M.resolveBrokerWithheldColumns(HEADERS).includes("Contract ID"))],
	// The one this change adds: the reader reducing a JSON contact cell to its
	// name again, instead of blanking it.
	// It is caught by §2's first two checks, run against the mutant.
	["M6 the name degradation re-introduced (a JSON cell served as its name)", () =>
		m6Out["Broker Contact Name"] !== "" || m6Out["Phone Number"] !== ""],
];
for (const [label, probe] of mutants) {
	let detected = false;
	try { detected = probe(); } catch { detected = true; }
	check(`mutant detected — ${label}`, detected, true);
}

Promise.all(asyncChecks).then(() => {
	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail) {
		console.log("\nFailures:");
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
}, (err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
