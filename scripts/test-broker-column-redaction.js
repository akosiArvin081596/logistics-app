#!/usr/bin/env node
// Locks the broker-contact redaction: which columns a non-Super-Admin is served
// blank, that every cell in them is served blank whatever its format, that
// neither PUT writes them for a non-Super-Admin nor takes a formula from one,
// and that GET /api/data is Super Admin only.
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
// THE WRITERS, 2026-09-26. For every caller but a Super Admin, both
// PUT /api/data/:rowIndex and PUT /api/load/:loadId:
//   • write every withheld column back exactly as stored, whatever the request
//     sent (restoreWithheldBrokerCells()), and name none of them in the answer;
//   • refuse a CHANGED cell whose trimmed value starts with "=", 400
//     FORMULA_NOT_ALLOWED naming the column, before anything is written
//     (formulaCellRefusal()) — both write with valueInputOption USER_ENTERED. A
//     cell equal to its stored value is never refused.
// Both routes are run here, lifted whole out of server.js, against a fake sheet.
//
// GET /api/data IS SUPER ADMIN ONLY (2026-09-26): it answers any tab, and its
// `duplicates` and `?search=` over every column, as stored. So is POST
// /api/data: it appends a caller-built row with USER_ENTERED, so it would store
// a Dispatcher's "=…" as a formula. Both gates are run here through the shipped
// requireRole(). The other routes that refuse a formula from a non-Super-Admin
// (from-ratecon, dispatch, reassign) are run by scripts/test-sheet-formula-doors.js.
//
// ⚠️ THE FIXTURE IS THE TEST. The ordering bug is entirely about header ORDER, so
// a synthetic list like ["Broker", "Phone"] reproduces nothing. Every case runs
// against the verbatim 26-column production header row (identical to the fixture
// in test-put-load-guard.js).
//
// ⚠️ READER AND WRITER SHARE ONE RESOLVER, and that is a data-loss guard, not
// tidiness. When the PUT's restore carried its own column list it missed
// "Email", so redacting Email would have had a Dispatcher blank the stored
// address on every save. The writer is restoreWithheldBrokerCells(), extracted
// and run here — the shipped code, not a re-implementation.
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
// The sections §5–§7 collect into a list instead, so § mutants can run them
// against a broken copy and count what they catch; record() tallies a list.
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
// Terminates on the first `}` in COLUMN 0 rather than by counting braces: a
// brace counter reads a "{" inside a string literal as a real block. Every
// target is a top-level declaration, so its closing brace is unindented.
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
	return src.replace(from, () => to);
}
const reMatch = SRC.match(/const BROKER_WITHHELD_RE = (\/.*\/[a-z]*);/);
if (!reMatch) throw new Error("BROKER_WITHHELD_RE not found in server.js");

const REAL = ["resolveBrokerWithheldColumns", "sanitizeBrokerColumns", "restoreWithheldBrokerCells", "formulaCellRefusal"];
const REAL_SRC = Object.fromEntries(REAL.map((n) => [n, extract(n)]));
function buildModule(overrides = {}, reSrc = reMatch[1]) {
	const s = { ...REAL_SRC, ...overrides };
	return new Function(
		`const BROKER_WITHHELD_RE = ${reSrc};\n${REAL.map((n) => s[n]).join("\n")}\nreturn { ${REAL.join(", ")} };`
	)();
}
const G = buildModule();

// The two PUT routes, lifted whole, and the two small pure helpers they call.
const LOAD_PUT_SRC = extractRoute('app.put("/api/load/:loadId", requireRole("Super Admin", "Dispatcher"), async (req, res) => {');
const DATA_PUT_SRC = extractRoute('app.put("/api/data/:rowIndex", requireRole("Super Admin", "Dispatcher"), async (req, res) => {');
const ROUTE_HELPERS = new Function(
	`${extract("sheetRowAfterUpdate")}\n${extract("a1SheetPrefix")}\n${extract("a1ColumnLetter")}\n${extract("sheetRowCellWrites")}\n` +
	"return { sheetRowAfterUpdate, a1SheetPrefix, a1ColumnLetter, sheetRowCellWrites };")();
// GET and POST /api/data and the shipped role gate.
const GET_DATA_HEAD = 'app.get("/api/data", requireRole("Super Admin"), async (req, res) => {';
const GET_DATA_SRC = extractRoute(GET_DATA_HEAD);
const POST_DATA_HEAD = 'app.post("/api/data", requireRole("Super Admin"), async (req, res) => {';
const POST_DATA_SRC = extractRoute(POST_DATA_HEAD);
const REQUIRE_ROLE_SRC = extract("requireRole");

// A raw cell array as the header-keyed row object the readers serve.
function rowObject(headers, cells) {
	const obj = {};
	(headers || []).forEach((h, i) => { obj[h] = (cells || [])[i] == null ? "" : String(cells[i]); });
	return obj;
}

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
const served = (cells, M = G) => M.sanitizeBrokerColumns(HEADERS, [rowObject(HEADERS, cells)])[0];
const servedCells = (before) => HEADERS.map((h) => served(before)[h]);

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
	const old = preFixSanitize(HEADERS, [rowObject(HEADERS, row())])[0];
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
		rows.push(rowObject(HEADERS, row({
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
	const orig = rowObject(HEADERS, row({ "Broker Contact Name": NAME_BLOB }));
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
			const orig = rowObject(hs, cells);
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
// §5 THE WRITER — restoreWithheldBrokerCells(): for every caller but a Super
// Admin, every withheld column is written back exactly as stored, whatever was
// sent, and nothing is reported.
// ---------------------------------------------------------------------------
function writerSection(M = G) {
	const { results, t } = collector();
	const splice = (before, submitted) => {
		const values = submitted.slice();
		const out = M.restoreWithheldBrokerCells(HEADERS, before, values);
		return { values, out };
	};
	const withheldOf = (cells) => WITHHELD.map((c) => cells[IDX[c]]);
	const OTHERS = HEADERS.map((h, i) => i).filter((i) => !WITHHELD.includes(HEADERS[i]));
	{
		const before = row();
		// A Dispatcher saves the row back exactly as they were served it.
		const r = splice(before, servedCells(before));
		t("writer: the served (blank) copy saved back restores every stored contact", withheldOf(r.values), withheldOf(before));
		t("writer: it returns nothing, so an answer has nothing to name", r.out, undefined);
		t("writer: every other column is written as sent", OTHERS.map((i) => r.values[i]), OTHERS.map((i) => servedCells(before)[i]));

		// A value sent for a withheld column is never written, whatever it is.
		const sent = servedCells(before);
		sent[IDX["Phone Number"]] = "555-9999";
		sent[IDX["Email"]] = "someone.else@example.invalid";
		sent[IDX["Broker Contact Name"]] = "Pat Replacement";
		sent[IDX["Details"]] = "rolled pallets";
		const e = splice(before, sent);
		t("writer: a value sent for any withheld column is not written — the stored value is", withheldOf(e.values), withheldOf(before));
		t("writer: ...while an edit to a column that is not withheld goes through", e.values[IDX["Details"]], "rolled pallets");
		// The stored copy sent back exactly is written back unchanged too.
		t("writer: the stored values sent back are written unchanged", withheldOf(splice(before, before.slice()).values), withheldOf(before));
	}
	{
		// JSON contact cells: the blank copy, the name-only copy a page loaded
		// before 2026-09-26 still holds, and any other value all restore the blob.
		const before = row({ "Broker Contact Name": NAME_BLOB, "Phone Number": PHONE_BLOB });
		const legacy = HEADERS.map((h) => nameDegradingSanitize(HEADERS, [rowObject(HEADERS, before)])[0][h]);
		t("ORACLE: a pre-change page holds the name-only copy", legacy[IDX["Broker Contact Name"]], JSON.stringify({ Name: "Danna Garcia" }));
		const other = servedCells(before);
		other[IDX["Broker Contact Name"]] = JSON.stringify({ Name: "Someone Else" });
		other[IDX["Phone Number"]] = "Pat Replacement";
		for (const [label, cells] of [["the blank copy", servedCells(before)], ["the pre-2026-09-26 name-only copy", legacy], ["any other value", other]]) {
			const r = splice(before, cells);
			t(`writer: ${label} sent for a JSON cell restores the stored blob`,
				[r.values[IDX["Broker Contact Name"]], r.values[IDX["Phone Number"]]], [NAME_BLOB, PHONE_BLOB]);
		}
		const malformed = row({ "Broker Contact Name": "{not json" });
		t("writer: a malformed blob is restored as stored",
			splice(malformed, servedCells(malformed)).values[IDX["Broker Contact Name"]], "{not json");
	}
	{
		// An empty stored cell stays empty: nothing is filled in by these callers.
		const empty = row({ Email: "" });
		const sent = servedCells(empty);
		sent[IDX["Email"]] = "new@example.invalid";
		t("writer: an empty withheld cell stays empty whatever is sent", splice(empty, sent).values[IDX["Email"]], "");
		// Sheets drops trailing empty cells, so the stored row can be shorter than
		// the header row: a withheld cell past its end is empty, and written so.
		const short = row().slice(0, IDX["Phone Number"]);
		const sent2 = servedCells(row());
		sent2[IDX["Phone Number"]] = "555-0000";
		sent2[IDX["Email"]] = "x@example.invalid";
		const r2 = splice(short, sent2);
		t("writer: a withheld cell past the end of the stored row is written empty",
			[r2.values[IDX["Phone Number"]], r2.values[IDX["Email"]]], ["", ""]);
		// A short values array: cells past its end are not written at all, so it
		// is not extended; the withheld cells inside it are restored.
		const s = splice(row(), servedCells(row()).slice(0, IDX["Phone Number"]));
		t("writer: a short values array is not extended", s.values.length, IDX["Phone Number"]);
		t("writer: ...and a withheld cell inside it is restored", s.values[IDX["Broker Contact Name"]], "Danna Garcia");
		// No withheld column on the header row: nothing changes.
		const vals = ["1", "x", "y"];
		M.restoreWithheldBrokerCells(["Load ID", "Driver", "Truck"], ["1", "a", "b"], vals);
		t("writer: a header row with no withheld column leaves the values as sent", vals, ["1", "x", "y"]);
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
		t("PRE-FIX writer: Email would have been blanked on save (data loss)", oldFilterValues[IDX["Email"]], "");
		t("FIXED writer: Email survives the same save", splice(before, sent).values[IDX["Email"]], "danna.garcia@example.invalid");
	}
	return results;
}

// ---------------------------------------------------------------------------
// §6 NO FORMULAS — formulaCellRefusal(): for every caller but a Super Admin, a
// CHANGED cell whose trimmed value starts with "=" is refused; an unchanged one
// never is.
// ---------------------------------------------------------------------------
function formulaSection(M = G) {
	const { results, t } = collector();
	const before = row();
	const sent = (base, over) => {
		const v = base.slice();
		for (const [k, x] of Object.entries(over)) v[IDX[k]] = x;
		return v;
	};
	const refuse = (base, over) => M.formulaCellRefusal(HEADERS, base, sent(base, over));
	const r = refuse(before, { Details: "=O2" });
	t("formula: a changed cell starting with \"=\" is refused: code and field",
		[r && r.code, r && r.field, Object.keys(r || {})], ["FORMULA_NOT_ALLOWED", "Details", ["error", "code", "field"]]);
	t("formula: ...the text names the column and who may enter formulas",
		/^"Details" starts with "="/.test((r || {}).error || "") && /Super Admin/.test((r || {}).error || ""), true);
	for (const [label, v] of [["leading spaces", "   =1+1"], ["a leading tab and newline", "\t\n=A1"], ["a lone \"=\"", "="]]) {
		t(`formula: ${label} is refused too`, (refuse(before, { Details: v }) || {}).code, "FORMULA_NOT_ALLOWED");
	}
	for (const [label, v] of [["an \"=\" inside the text", "a=b"], ["plain text", "rolled pallets"], ["an emptied cell", ""],
		["a number", 5], ["null", null], ["a full-width equals sign", String.fromCharCode(0xFF1D) + "A1"], ["a leading \"+\"", "+A1"]]) {
		t(`formula: ${label} is not refused`, refuse(before, { Details: v }), null);
	}
	// Unchanged cells are never judged: a stored value starting with "=", resent
	// as stored, does not block an unrelated edit.
	const stored = row({ "Location Link": "=starts with an equals sign" });
	t("formula: a stored value starting with \"=\" resent unchanged does not block an unrelated edit",
		refuse(stored, { Details: "rolled pallets" }), null);
	t("formula: ...but changing that cell to another formula is refused",
		(refuse(stored, { "Location Link": "=B2" }) || {}).field, "Location Link");
	t("formula: the first changed formula in column order is named",
		(refuse(before, { "Pickup Info": "=B2", Details: "=C2" }) || {}).field, "Details");
	t("formula: field is the header exactly as the sheet holds it",
		(refuse(before, { Payment: "=1" }) || {}).field, "  Payment  ");
	const unnamed = M.formulaCellRefusal(["Load ID", ""], ["1", ""], ["1", "=A1"]);
	t("formula: a blank header is named (unnamed), and the text gives its position",
		[unnamed && unnamed.field, /^"Column 2"/.test((unnamed || {}).error || "")], ["(unnamed)", true]);
	t("formula: a cell past the header row is judged too",
		(M.formulaCellRefusal(["Load ID"], ["1"], ["1", "=A1"]) || {}).field, "(unnamed)");
	return results;
}

// ---------------------------------------------------------------------------
// §7 THE ROUTES — PUT /api/load/:loadId and PUT /api/data/:rowIndex, lifted
// whole and run against a fake sheet. The period guard, the Owner ID check and
// the audit writers are stubbed (their own runners cover them); the two rules
// above and the reader are the shipped code.
// ---------------------------------------------------------------------------
function fakeSheet(rows) {
	const writes = [];
	const rowAt = (range) => {
		const m = /!(\d+):\1$/.exec(range);
		return m ? (rows[Number(m[1]) - 1] || []) : null;
	};
	const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
	const values = {
		get: async ({ range }) => {
			const r = rowAt(range);
			return { data: { values: r ? [r.slice()] : rows.map((x) => x.slice()) } };
		},
		batchGet: async ({ ranges }) => ({ data: { valueRanges: ranges.map((x) => ({ values: [(rowAt(x) || []).slice()] })) } }),
		// Both routes write the cells a save changes, one single-cell range each,
		// in one values.batchUpdate (sheetRowCellWrites(); its own runner is
		// scripts/test-row-save-cell-writes.js). The write is applied to the sheet
		// and recorded as the ranges written and the row as it then stands, so a
		// column the save left alone reads as stored.
		batchUpdate: async ({ requestBody }) => {
			const data = requestBody.data || [];
			let rowNo = 0;
			for (const d of data) {
				const m = /!([A-Z]+)(\d+)$/.exec(d.range);
				if (!m) throw new Error(`fake sheet: not a single-cell range: ${d.range}`);
				rowNo = Number(m[2]);
				const r = rows[rowNo - 1] || (rows[rowNo - 1] = []);
				const i = colIndex(m[1]);
				while (r.length <= i) r.push("");
				r[i] = d.values[0][0];
			}
			writes.push({ ranges: data.map((d) => d.range), row: rowNo ? rows[rowNo - 1].slice() : [] });
			return { data: { totalUpdatedCells: data.length } };
		},
	};
	return { getSheets: async () => ({ spreadsheets: { values } }), writes };
}
function mountPut(routeSrc, M, rows) {
	const sheet = fakeSheet(rows);
	const audits = [];
	let handler = null;
	const env = {
		app: { put: (p, gate, h) => { handler = h; } },
		requireRole: () => null,
		getSheets: sheet.getSheets,
		SPREADSHEET_ID: "sheet-under-test",
		SHEET_ROW_MAX_CELLS: 20000,
		PERIOD_GUARDED_SHEETS: ["Job Tracking"],
		getSheetName: (req) => (req.query && req.query.sheet) || "Job Tracking",
		resolveSheetTargetForWrite: async () => ({ resolved: true, metaUnreadable: false, title: "Job Tracking", guarded: true }),
		a1SheetPrefix: ROUTE_HELPERS.a1SheetPrefix,
		a1ColumnLetter: ROUTE_HELPERS.a1ColumnLetter,
		sheetRowAfterUpdate: ROUTE_HELPERS.sheetRowAfterUpdate,
		sheetRowCellWrites: ROUTE_HELPERS.sheetRowCellWrites,
		changedGuardedCells: () => [],
		guardedColumnReason: () => "",
		validateOwnerIdCell: () => null,
		sheetRowUpdateBlocker: () => null,
		buildSheetUpdateAudit: (o) => o,
		sheetAuditWithCode: (d) => d,
		logAudit: (req, action) => { audits.push(action); },
		logAuditRefusal: (req, action) => { audits.push(action); },
		jtCacheInvalidate: () => {},
		restoreWithheldBrokerCells: M.restoreWithheldBrokerCells,
		formulaCellRefusal: M.formulaCellRefusal,
		sanitizeBrokerColumns: M.sanitizeBrokerColumns,
		console: { error() {}, log() {}, warn() {} },
	};
	const names = Object.keys(env);
	new Function(...names, routeSrc)(...names.map((k) => env[k]));
	if (typeof handler !== "function") throw new Error("a lifted PUT route did not register a handler");
	const run = async (role, params, body, query = {}) => {
		const out = { code: 200, body: null };
		const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
		await handler({ params, query, body, session: { user: { id: role === "Super Admin" ? 1 : 2, role, username: role === "Super Admin" ? "super_admin" : "kevin" } } }, res);
		return out;
	};
	return { run, writes: sheet.writes, audits };
}
async function routeSection(M = G, routes = { load: LOAD_PUT_SRC, data: DATA_PUT_SRC }) {
	const { results, t } = collector();
	// The load being edited carries a JSON contact cell and a stored value that
	// starts with "=" in a column nobody edits.
	const STORED = row({ "Load ID": "111", "Broker Contact Name": NAME_BLOB, "Location Link": "=starts with an equals sign" });
	const ROWS = () => [HEADERS.slice(), STORED.slice(), row({ "Load ID": "222" })];
	const storedWithheld = WITHHELD.map((c) => STORED[IDX[c]]);
	const writtenWithheld = (w) => (w ? WITHHELD.map((c) => w.row[IDX[c]]) : null);

	// ── PUT /api/load/:loadId ──
	{
		const app = mountPut(routes.load, M, ROWS());
		const r = await app.run("Dispatcher", { loadId: "111" },
			{ Email: "someone.else@example.invalid", "Phone Number": "", "Broker Contact Name": "Pat Replacement", Details: "rolled pallets" });
		const w = app.writes[0];
		t("PUT /api/load/:loadId, Dispatcher: 200, one write", [r.code, app.writes.length], [200, 1]);
		t("PUT /api/load/:loadId, Dispatcher: every withheld column is left as stored (the row after the write)", writtenWithheld(w), storedWithheld);
		t("PUT /api/load/:loadId, Dispatcher: the rest of the edit is written", w && w.row[IDX["Details"]], "rolled pallets");
		t("PUT /api/load/:loadId, Dispatcher: the answer is { success, load }, every withheld column blank",
			[Object.keys(r.body || {}), WITHHELD.map((c) => ((r.body || {}).load || {})[c])], [["success", "load"], ["", "", ""]]);
	}
	{
		const app = mountPut(routes.load, M, ROWS());
		const r = await app.run("Super Admin", { loadId: "111" }, { Email: "new@example.invalid", "Phone Number": "", Details: "=O2" });
		const w = app.writes[0] || { row: [] };
		t("PUT /api/load/:loadId, Super Admin: 200, written as sent, a formula included",
			[r.code, w.row[IDX["Email"]], w.row[IDX["Phone Number"]], w.row[IDX["Details"]]], [200, "new@example.invalid", "", "=O2"]);
		t("PUT /api/load/:loadId, Super Admin: the answer carries the stored contact", ((r.body || {}).load || {})["Broker Contact Name"], NAME_BLOB);
	}
	for (const [label, value] of [["=O2", "=O2"], ["\"  =O2\" (leading spaces)", "  =O2"]]) {
		const app = mountPut(routes.load, M, ROWS());
		const r = await app.run("Dispatcher", { loadId: "111" }, { Details: value });
		t(`PUT /api/load/:loadId, Dispatcher, Details ${label}: 400 FORMULA_NOT_ALLOWED naming Details, nothing written or audited`,
			[r.code, (r.body || {}).code, (r.body || {}).field, app.writes.length, app.audits.length], [400, "FORMULA_NOT_ALLOWED", "Details", 0, 0]);
	}
	{
		// A formula sent for a withheld column is not judged: it is not written.
		// The restore leaves the row as stored, so the save changes nothing and
		// nothing is written at all.
		const rows = ROWS();
		const app = mountPut(routes.load, M, rows);
		const r = await app.run("Dispatcher", { loadId: "111" }, { Email: "=O2" });
		t("PUT /api/load/:loadId, Dispatcher, a formula sent for a withheld column: 200 unchanged, nothing written, the stored values kept",
			[r.code, (r.body || {}).unchanged, app.writes.length, WITHHELD.map((c) => rows[1][IDX[c]])], [200, true, 0, storedWithheld]);
	}
	{
		// A stored value starting with "=" resent as stored is no change.
		const app = mountPut(routes.load, M, ROWS());
		const r = await app.run("Dispatcher", { loadId: "111" }, { "Trailer Number": "TR-9", "Location Link": STORED[IDX["Location Link"]] });
		t("PUT /api/load/:loadId, Dispatcher, a stored \"=\" value resent unchanged: 200, the edit written",
			[r.code, app.writes.length, app.writes[0] && app.writes[0].row[IDX["Trailer Number"]]], [200, 1, "TR-9"]);
	}

	// ── PUT /api/data/:rowIndex ── (the Active Loads editor sends every column,
	// the withheld ones as served: blank)
	const editorRow = (over) => {
		const v = STORED.map((c, i) => (WITHHELD.includes(HEADERS[i]) ? "" : c));
		for (const [k, x] of Object.entries(over)) v[IDX[k]] = x;
		return v;
	};
	const Q = { sheet: "Job Tracking" };
	{
		const app = mountPut(routes.data, M, ROWS());
		const r = await app.run("Dispatcher", { rowIndex: "2" }, { values: editorRow({ Email: "someone.else@example.invalid", Details: "rolled pallets" }) }, Q);
		const w = app.writes[0];
		t("PUT /api/data/:rowIndex, Dispatcher: 200 { success, updatedCells }, no other field",
			[r.code, Object.keys(r.body || {})], [200, ["success", "updatedCells"]]);
		t("PUT /api/data/:rowIndex, Dispatcher: every withheld column is left as stored (the row after the write)", writtenWithheld(w), storedWithheld);
		t("PUT /api/data/:rowIndex, Dispatcher: the rest of the edit is written", w && w.row[IDX["Details"]], "rolled pallets");
	}
	{
		const app = mountPut(routes.data, M, ROWS());
		const r = await app.run("Dispatcher", { rowIndex: "2" }, { values: editorRow({ Details: "=O2" }) }, Q);
		t("PUT /api/data/:rowIndex, Dispatcher, Details =O2: 400 FORMULA_NOT_ALLOWED naming Details, nothing written or audited",
			[r.code, (r.body || {}).code, (r.body || {}).field, app.writes.length, app.audits.length], [400, "FORMULA_NOT_ALLOWED", "Details", 0, 0]);
	}
	{
		const app = mountPut(routes.data, M, ROWS());
		const r = await app.run("Dispatcher", { rowIndex: "2" }, { values: editorRow({ "Trailer Number": "TR-9" }) }, Q);
		t("PUT /api/data/:rowIndex, Dispatcher, the stored \"=\" value resent unchanged: 200, written",
			[r.code, app.writes.length], [200, 1]);
	}
	{
		const app = mountPut(routes.data, M, ROWS());
		const values = STORED.slice();
		values[IDX["Email"]] = "new@example.invalid";
		values[IDX["Details"]] = "=O2";
		const r = await app.run("Super Admin", { rowIndex: "2" }, { values }, Q);
		const w = app.writes[0] || { row: [] };
		t("PUT /api/data/:rowIndex, Super Admin: 200, written as sent, a formula included",
			[r.code, w.row[IDX["Email"]], w.row[IDX["Details"]]], [200, "new@example.invalid", "=O2"]);
	}
	return results;
}

// ---------------------------------------------------------------------------
// §8 THE CALLERS AND THE GATES
// ---------------------------------------------------------------------------
{
	// Every call of the reader and the two writer rules, apart from their
	// definitions and mentions in comments, sits behind
	// `role !== "Super Admin"` in the same statement or the `if` around it.
	const calls = [];
	for (const re of [/sanitizeBrokerColumns\(/g, /restoreWithheldBrokerCells\(/g, /formulaCellRefusal\(/g]) {
		let m;
		while ((m = re.exec(SRC))) {
			const at = m.index;
			const prefix = SRC.slice(SRC.lastIndexOf("\n", at) + 1, at);
			if (prefix === "function ") continue;              // the definition
			if (prefix.includes("//")) continue;               // a mention in a comment
			calls.push(at);
		}
	}
	const unguarded = calls.filter((at) => !/req\.session\.user\.role !== "Super Admin"/.test(SRC.slice(Math.max(0, at - 160), at)));
	check("every route call of the reader or the two writer rules is for a non-Super-Admin only",
		unguarded.map((at) => SRC.slice(at, SRC.indexOf("\n", at)).trim()), []);
	check("the call sites are the ones this file was sized against (reader: dashboard x3, driver page, load GET/PUT; restore: data PUT, load PUT; formula rule: data PUT, load PUT, from-ratecon x2, dispatch, reassign)",
		calls.length, 14);
	const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	for (const [label, src, rowVar] of [["PUT /api/data/:rowIndex", DATA_PUT_SRC, "values"], ["PUT /api/load/:loadId", LOAD_PUT_SRC, "updatedRow"]]) {
		const c = code(src);
		const restoreAt = c.indexOf(`restoreWithheldBrokerCells(headers, before, ${rowVar});`);
		const formulaAt = c.indexOf(`formulaCellRefusal(headers, before, ${rowVar});`);
		const writeAt = c.indexOf(".values.batchUpdate(");
		check(`${label}: the restore, then the formula rule, each once, both before the write and before any audit line`,
			[c.split("restoreWithheldBrokerCells(").length - 1, c.split("formulaCellRefusal(").length - 1,
				restoreAt > 0 && restoreAt < formulaAt && formulaAt < writeAt && formulaAt < c.indexOf("logAudit")],
			[1, 1, true]);
		check(`${label}: no answer names a withheld column`, /\bpreserved\b/.test(c), false);
	}
	check("no function reduces a contact cell to its name any more",
		[/\nfunction sanitizeBrokerContact\(/.test(SRC), /\nfunction legacyServedBrokerCell\(/.test(SRC)], [false, false]);
}
{
	// GET /api/data is Super Admin only: one registration, gated by the shipped
	// requireRole(), and it serves the row as stored.
	check("GET /api/data: one registration, Super Admin only",
		[SRC.split('\napp.get("/api/data", ').length - 1, SRC.includes('app.get("/api/data", requireRole("Super Admin", "Dispatcher")')], [1, false]);
	asyncChecks.push(getDataGate(GET_DATA_SRC).then((out) => {
		check("GET /api/data, the shipped gate: Dispatcher, Investor and Driver refused 403, no session 401, Super Admin through",
			out.gate, { Dispatcher: 403, Investor: 403, Driver: 403, none: 401, "Super Admin": "next" });
		check("GET /api/data, Super Admin: the stored contact in full", out.superAdminRow, ["Danna Garcia", "555-0142", "danna.garcia@example.invalid"]);
	}));
}
{
	// POST /api/data is Super Admin only too: one registration, gated by the
	// shipped requireRole(). Only the gate is run — every request below carries
	// X-Requested-With, so the role is the one thing that differs.
	check("POST /api/data: one registration, Super Admin only",
		[SRC.split('\napp.post("/api/data", ').length - 1, SRC.includes('app.post("/api/data", requireRole("Super Admin", "Dispatcher")')], [1, false]);
	check("POST /api/data, the shipped gate: Dispatcher, Investor and Driver refused 403, no session 401, Super Admin through",
		postDataGate(POST_DATA_SRC), { Dispatcher: 403, Investor: 403, Driver: 403, none: 401, "Super Admin": "next" });
}
// The gate of a POST /api/data registration, run for each role.
function postDataGate(routeSrc) {
	const requireRole = new Function(`${REQUIRE_ROLE_SRC}\nreturn requireRole;`)();
	let gate = null;
	new Function("app", "requireRole", routeSrc)({ post: (p, g) => { gate = g; } }, requireRole);
	const out = {};
	for (const [key, user] of [["Dispatcher", { id: 2, role: "Dispatcher" }], ["Investor", { id: 5, role: "Investor" }],
		["Driver", { id: 3, role: "Driver" }], ["none", undefined], ["Super Admin", { id: 1, role: "Super Admin" }]]) {
		let passed = false;
		const res = { code: 200, status(c) { this.code = c; return this; }, json() { return this; } };
		gate({ method: "POST", headers: { "x-requested-with": "XMLHttpRequest" }, session: { user } }, res, () => { passed = true; });
		out[key] = passed ? "next" : res.code;
	}
	return out;
}
// The gate and the handler of a GET /api/data registration, run.
async function getDataGate(routeSrc) {
	const requireRole = new Function(`${REQUIRE_ROLE_SRC}\nreturn requireRole;`)();
	let gate = null, handler = null;
	new Function("app", "requireRole", "getSheetName", "getSheets", "SPREADSHEET_ID", "deduplicateLoads", "console", routeSrc)(
		{ get: (p, g, h) => { gate = g; handler = h; } }, requireRole,
		(req) => (req.query && req.query.sheet) || "Job Tracking",
		async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: [HEADERS.slice(), row({ "Load ID": "111" })] } }) } } }),
		"sheet-under-test", (data, headers, ret) => (ret ? { data, duplicates: [] } : data), { error() {} });
	const through = (user) => {
		let passed = false;
		const res = { code: 200, status(c) { this.code = c; return this; }, json() { return this; } };
		gate({ method: "GET", headers: {}, session: { user } }, res, () => { passed = true; });
		return passed ? "next" : res.code;
	};
	const out = { gate: {}, superAdminRow: null };
	for (const [key, user] of [["Dispatcher", { id: 2, role: "Dispatcher" }], ["Investor", { id: 5, role: "Investor" }],
		["Driver", { id: 3, role: "Driver" }], ["none", undefined], ["Super Admin", { id: 1, role: "Super Admin" }]]) {
		out.gate[key] = through(user);
	}
	const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
	await handler({ query: { sheet: "Job Tracking" }, session: { user: { id: 1, role: "Super Admin" } } }, res);
	const first = ((res.body || {}).data || [])[0] || {};
	out.superAdminRow = WITHHELD.map((c) => first[c]);
	return out;
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
	check("PUT /api/load/:loadId answers a non-Super-Admin with the row redacted",
		/\n\t\tres\.json\(\{\n\t\t\tsuccess: true,\n\t\t\tload: req\.session\.user\.role !== "Super Admin" \? sanitizeBrokerColumns\(headers, \[result\]\)\[0\] : result,\n/.test(LOAD_PUT_SRC), true);
}

// ---------------------------------------------------------------------------
// §9 MUTANTS — proof this suite fails against the earlier code.
// ---------------------------------------------------------------------------
const withResolver = (reSrc, fn) => fn(buildModule({}, reSrc));
// Built OUTSIDE the probes' try: a mutation target that has vanished must fail
// the run, not read as "detected".
// M6: the pre-2026-09-26 reader — a JSON cell served as its name, a malformed
// one in full, a plain one blank.
const M6 = buildModule({
	sanitizeBrokerColumns: mutate(REAL_SRC.sanitizeBrokerColumns,
		'if (cleaned[col]) cleaned[col] = "";',
		'if (cleaned[col]) { const val = String(cleaned[col]).trim(); let out = ""; if (val.startsWith("{")) { try { const p = JSON.parse(val); out = JSON.stringify({ Name: p.Name || p.name || "" }); } catch { out = val; } } cleaned[col] = out; }'),
});
const m6Out = served(row({ "Broker Contact Name": NAME_BLOB, "Phone Number": PHONE_BLOB }), M6);
check("M6 really is the old reader: it serves the JSON cell as its name",
	m6Out["Broker Contact Name"], JSON.stringify({ Name: "Danna Garcia" }));
// M7: the restore only for a blank round trip, as before 2026-09-26 — any
// other value sent for a withheld column is written.
const M7 = buildModule({
	restoreWithheldBrokerCells: mutate(REAL_SRC.restoreWithheldBrokerCells,
		'values[i] = before[i] == null ? "" : before[i];',
		'if (String(values[i] == null ? "" : values[i]) === "") values[i] = before[i] == null ? "" : before[i];'),
});
// M8: PUT /api/load/:loadId without the restore.
const M8_LOAD = mutate(LOAD_PUT_SRC, "restoreWithheldBrokerCells(headers, before, updatedRow);", "");
// M9: the formula rule keyed on the value alone, not on a change.
const M9 = buildModule({
	formulaCellRefusal: mutate(REAL_SRC.formulaCellRefusal,
		'if (to === from || !to.trim().startsWith("=")) continue;',
		'if (!to.trim().startsWith("=")) continue;'),
});
// M10: PUT /api/data/:rowIndex without the formula refusal.
const M10_DATA = mutate(DATA_PUT_SRC, "if (formula) return res.status(400).json(formula);", "");
// M11: GET /api/data re-opened to Dispatchers.
const M11_GET = mutate(GET_DATA_SRC, GET_DATA_HEAD, 'app.get("/api/data", requireRole("Super Admin", "Dispatcher"), async (req, res) => {');
// M12: POST /api/data re-opened to Dispatchers (the gate before 2026-09-26).
const M12_POST = mutate(POST_DATA_SRC, POST_DATA_HEAD, 'app.post("/api/data", requireRole("Super Admin", "Dispatcher"), async (req, res) => {');
// The checks a mutant fails, from the §5–§7 sections run against it.
const caughtBy = (results) => results.filter((r) => !r.ok);
const mutants = [
	["M1 pre-fix first-match resolver (Phone + Email leak)", () => {
		const old = preFixSanitize(HEADERS, [rowObject(HEADERS, row())])[0];
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
	// Caught by §2's first two checks, run against the mutant.
	["M6 the name degradation re-introduced (a JSON cell served as its name)", () =>
		m6Out["Broker Contact Name"] !== "" || m6Out["Phone Number"] !== ""],
	// The four below answer the list of checks that caught them, printed beside
	// the verdict, so a mutant can be seen to fail the check written for it.
	["M7 the restore only for a blank round trip (a sent value written over a withheld column)", async () =>
		caughtBy([...writerSection(M7), ...await routeSection(M7)])],
	["M8 PUT /api/load/:loadId without the restore", async () =>
		caughtBy(await routeSection(G, { load: M8_LOAD, data: DATA_PUT_SRC }))],
	["M9 the formula rule keyed on the value, not on a change (a stored \"=\" value blocks an unrelated edit)", async () =>
		caughtBy([...formulaSection(M9), ...await routeSection(M9)])],
	["M10 PUT /api/data/:rowIndex without the formula refusal", async () =>
		caughtBy(await routeSection(G, { load: LOAD_PUT_SRC, data: M10_DATA }))],
	["M11 GET /api/data re-opened to Dispatchers", async () => {
		const out = await getDataGate(M11_GET);
		return out.gate.Dispatcher !== 403;
	}],
	["M12 POST /api/data re-opened to Dispatchers", () => postDataGate(M12_POST).Dispatcher !== 403],
];

(async () => {
	record(writerSection());
	record(formulaSection());
	record(await routeSection());
	await Promise.all(asyncChecks);
	console.log("\n§9 mutants");
	for (const [label, probe] of mutants) {
		// A probe that throws has proved nothing about the mutant: it is a failure
		// of this runner, not a detection.
		let detected = false;
		let detail = "";
		try {
			const out = await probe();
			if (Array.isArray(out)) {
				detected = out.length > 0;
				if (detected) detail = `caught by ${out.length} check(s), e.g. ✗ ${out[0].name}`;
			} else {
				detected = out === true;
			}
		} catch (e) {
			detail = `the probe threw: ${e && e.message ? e.message : e}`;
		}
		check(`mutant detected — ${label}`, detected, true);
		console.log(`  ${detected ? "caught " : "MISSED "} ${label}${detail ? ` — ${detail}` : ""}`.slice(0, 240));
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
