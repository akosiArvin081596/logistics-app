#!/usr/bin/env node
// Locks sanitizeBrokerColumns() against the ORDERING bug that inverted it.
//
// THE BUG. The function picked one column per role with two loose regexes over
// the whole header row:
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
// to the same column and the function did the exact inverse of its job:
//
//   • `brokerCol` → sanitizeBrokerContact(), a no-op on a plain string, so
//     nothing happened there;
//   • `phoneCol`  → the SAME column, non-JSON, so it took the else branch and
//     the broker's NAME was blanked;
//   • "Phone Number" and "Email" were referenced by NO lookup at all and were
//     served in full to every non-Super-Admin caller.
//
// It redacted the harmless column and published the two it exists to protect.
//
// ⚠️ THE FIXTURE IS THE TEST. This bug is entirely about header ORDER, so a
// synthetic list like ["Broker", "Phone"] reproduces nothing and would pass on
// the broken code. Every case below runs against the verbatim 26-column
// production header row (identical to the fixture in test-put-load-guard.js),
// and the order-sensitive assertions are called out as such.
//
// ⚠️ READER AND WRITER SHARE ONE RESOLVER, and that is a data-loss guard, not
// tidiness. PUT /api/data/:rowIndex splices the real values back in so a
// non-Super-Admin's save cannot overwrite the full record with the redacted copy
// they were served. It used its own hardcoded /broker|phone|contact/i, which
// does NOT match "Email" — so redacting Email without fixing the writer would
// have turned a disclosure bug into a Dispatcher blanking the stored address on
// every save. The writer half is exercised here for exactly that reason.
//
// Both functions are EXTRACTED from server.js — testing a re-implementation
// would prove nothing about the code that serves the rows. No network, no
// database, no sheet.
//
//   node scripts/test-broker-column-redaction.js     # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return true; }
	fail++; failures.push(`${name}\n     expected ${e}\n     actual   ${a}`);
	console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
	return false;
}

// ---------------------------------------------------------------- extraction
// Terminates on the first `}` in COLUMN 0 rather than by counting braces.
// sanitizeBrokerContact() tests `trimmed.startsWith("{")`, and a brace counter
// reads that string literal as a real block — the extractor in
// test-truck-retirement.js would throw "unbalanced braces" here. All four
// targets are top-level declarations, so the closing brace is unindented.
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
const reMatch = SRC.match(/const BROKER_WITHHELD_RE = (\/.*\/[a-z]*);/);
if (!reMatch) throw new Error("BROKER_WITHHELD_RE not found in server.js");

const REAL = ["sanitizeBrokerContact", "resolveBrokerWithheldColumns", "sanitizeBrokerColumns", "rowObjectFromCells"];
const G = new Function(
	`const BROKER_WITHHELD_RE = ${reMatch[1]};\n${REAL.map(extract).join("\n")}\nreturn { ${REAL.join(", ")} };`
)();

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
const served = (cells) => G.sanitizeBrokerColumns(HEADERS, [G.rowObjectFromCells(HEADERS, cells)])[0];

// ---------------------------------------------------------------------------
// THE LEAK — the two columns the function exists to protect.
// ---------------------------------------------------------------------------
{
	const out = served(row());
	check("Phone Number is withheld", out["Phone Number"], "");
	check("Email is withheld", out["Email"], "");
	check("Broker Contact Name is withheld (deliberately, as it already was)", out["Broker Contact Name"], "");
}

// The pre-fix resolver, verbatim, as the oracle. Any assertion above that this
// reproduces is an assertion the suite is NOT actually making.
function preFixSanitize(headers, rows) {
	const brokerCol = (headers || []).find((h) => /broker/i.test(h)) || null;
	const phoneCol = (headers || []).find((h) => /phone|contact/i.test(h)) || null;
	if (!brokerCol && !phoneCol) return rows;
	return rows.map((r) => {
		const cleaned = { ...r };
		if (brokerCol && cleaned[brokerCol]) cleaned[brokerCol] = G.sanitizeBrokerContact(cleaned[brokerCol]);
		if (phoneCol && cleaned[phoneCol]) {
			const val = (cleaned[phoneCol] || "").trim();
			cleaned[phoneCol] = val.startsWith("{") ? G.sanitizeBrokerContact(val) : "";
		}
		return cleaned;
	});
}
{
	const old = preFixSanitize(HEADERS, [G.rowObjectFromCells(HEADERS, row())])[0];
	check("PRE-FIX: Phone Number was served in full (the leak)", old["Phone Number"], "555-0142");
	check("PRE-FIX: Email was served in full (the leak)", old["Email"], "danna.garcia@example.invalid");
	check("PRE-FIX: the harmless name column was the one blanked", old["Broker Contact Name"], "");
}

// ---------------------------------------------------------------------------
// COLLATERAL — the columns that must NOT be touched.
// `Payment` carries real surrounding spaces and is matched on h.trim()
// elsewhere; `Owner ID` scopes investor money; `Contract ID` is a reference,
// and note "Contract" is not "Contact" — the near-miss that makes /contact/i
// safe to keep in the union.
// ---------------------------------------------------------------------------
{
	const out = served(row());
	for (const h of HEADERS) {
		if (["Broker Contact Name", "Phone Number", "Email"].includes(h)) continue;
		check(`untouched: ${JSON.stringify(h)}`, out[h], G.rowObjectFromCells(HEADERS, row())[h]);
	}
	check("  Payment   keeps its exact spacing and value", out["  Payment  "], "$1,800.00");
	check("Owner ID survives", out["Owner ID"], "5");
	check("Contract ID survives — 'Contract' is not 'Contact'", out["Contract ID"], "29284990");
	check("resolver does not match Contract ID",
		G.resolveBrokerWithheldColumns(HEADERS).includes("Contract ID"), false);
}

// ---------------------------------------------------------------------------
// THE RESOLVER — a union, so no column can shadow another.
// ---------------------------------------------------------------------------
{
	check("resolver returns all three columns, in header order",
		G.resolveBrokerWithheldColumns(HEADERS), ["Broker Contact Name", "Phone Number", "Email"]);
	check("resolver is total over the fixture (nothing else matches)",
		G.resolveBrokerWithheldColumns(HEADERS).length, 3);
	check("resolver tolerates missing headers", G.resolveBrokerWithheldColumns(null), []);
	check("resolver tolerates null cells in the header row",
		G.resolveBrokerWithheldColumns([null, "Phone Number", undefined]), ["Phone Number"]);

	// STRICTLY NARROWING: every column the old code redacted must still be
	// redacted, on any header row. This is the property that makes the change
	// safe to ship without an inventory of every `?sheet=` layout.
	const layouts = [
		HEADERS,
		["Broker", "Phone", "Notes"],
		["Contact Number", "Load ID"],
		["Broker Info", "Load ID"],
		["Phone", "Broker Contact Name", "Load ID"],   // reversed order
		["Load ID", "Driver", "Truck"],                 // nothing to redact
	];
	for (const hs of layouts) {
		const cells = hs.map((h) => `v:${h}`);
		const nowOut = G.sanitizeBrokerColumns(hs, [G.rowObjectFromCells(hs, cells)])[0];
		const oldOut = preFixSanitize(hs, [G.rowObjectFromCells(hs, cells)])[0];
		const widened = hs.filter((h) => oldOut[h] !== G.rowObjectFromCells(hs, cells)[h] && nowOut[h] === G.rowObjectFromCells(hs, cells)[h]);
		check(`strictly narrowing on ${JSON.stringify(hs.slice(0, 3))}…`, widened, []);
	}
}

// ---------------------------------------------------------------------------
// LEGACY JSON BLOB — a single cell carrying {"Name":…,"Phone":…} still degrades
// to just the name rather than vanishing. Production carries no such cell, so
// this branch is compatibility for other sheets and must not change.
// ---------------------------------------------------------------------------
{
	const blob = JSON.stringify({ Name: "Danna Garcia", Phone: "555-0142", Email: "d@example.invalid" });
	const out = served(row({ "Broker Contact Name": blob }));
	check("JSON blob degrades to just the name", out["Broker Contact Name"], JSON.stringify({ Name: "Danna Garcia" }));
	check("JSON blob does not leak the phone", /555-0142/.test(out["Broker Contact Name"]), false);
	check("JSON blob does not leak the email", /example\.invalid/.test(out["Broker Contact Name"]), false);
	const malformed = served(row({ "Broker Contact Name": "{not json" }));
	check("malformed blob is returned as-is, not crashed on", malformed["Broker Contact Name"], "{not json");
}

// ---------------------------------------------------------------------------
// THE WRITER — PUT /api/data/:rowIndex splice. Reproduces the shipped loop
// against the same resolver, so a reader/writer divergence shows up here.
// ---------------------------------------------------------------------------
function splice(before, submitted) {
	const values = submitted.slice();
	const servedRow = G.sanitizeBrokerColumns(HEADERS, [G.rowObjectFromCells(HEADERS, before)])[0] || {};
	const withheldCols = new Set(G.resolveBrokerWithheldColumns(HEADERS));
	const preserved = [];
	HEADERS.forEach((h, i) => {
		if (!withheldCols.has(h) || !before[i] || i >= values.length) return;
		const stored = String(before[i]);
		const servedVal = servedRow[h] === undefined ? stored : String(servedRow[h]);
		if (servedVal === stored) return;
		if (String(values[i] == null ? "" : values[i]) === servedVal) {
			values[i] = before[i];
			preserved.push(String(h).trim() || `col${i + 1}`);
		}
	});
	return { values, preserved };
}
{
	const before = row();
	// A Dispatcher saves the row back exactly as they were served it.
	const servedCells = HEADERS.map((h) => served(before)[h]);
	const { values, preserved } = splice(before, servedCells);
	check("writer: the stored Phone Number is restored", values[IDX["Phone Number"]], "555-0142");
	check("writer: the stored Email is restored", values[IDX["Email"]], "danna.garcia@example.invalid");
	check("writer: the stored Broker Contact Name is restored", values[IDX["Broker Contact Name"]], "Danna Garcia");
	check("writer: it reports what it preserved", preserved.sort(), ["Broker Contact Name", "Email", "Phone Number"]);
	check("writer: an untouched column is written through", values[IDX["Job Status"]], "Delivered");

	// A genuine edit must still land — the splice restores only the exact
	// redacted copy, never every matching column.
	const edited = servedCells.slice();
	edited[IDX["Phone Number"]] = "555-9999";
	check("writer: a genuine edit to a withheld column is NOT reverted",
		splice(before, edited).values[IDX["Phone Number"]], "555-9999");
}
{
	// THE DATA-LOSS REGRESSION, stated directly: the writer's old hardcoded
	// candidate filter did not match "Email", so a save would have written ""
	// over the stored address the moment the reader began redacting it.
	const before = row();
	const servedCells = HEADERS.map((h) => served(before)[h]);
	const oldFilterValues = servedCells.slice();
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
		splice(before, servedCells).values[IDX["Email"]], "danna.garcia@example.invalid");
}

// ---------------------------------------------------------------------------
// MUTANTS — proof this suite fails against the pre-fix code.
// ---------------------------------------------------------------------------
function withResolver(reSrc, fn) {
	const M = new Function(
		`const BROKER_WITHHELD_RE = ${reSrc};\n${["sanitizeBrokerContact", "resolveBrokerWithheldColumns", "sanitizeBrokerColumns"].map(extract).join("\n")}\nreturn { resolveBrokerWithheldColumns, sanitizeBrokerColumns };`
	)();
	return fn(M);
}
const mutants = [
	["M1 pre-fix first-match resolver (Phone + Email leak)", () => {
		const old = preFixSanitize(HEADERS, [G.rowObjectFromCells(HEADERS, row())])[0];
		return old["Phone Number"] !== "" || old["Email"] !== "";
	}],
	["M2 union without /phone/ (Phone Number leaks)", () => withResolver("/broker|e-?mail|contact/i", (M) => {
		const out = M.sanitizeBrokerColumns(HEADERS, [G.rowObjectFromCells(HEADERS, row())])[0];
		return out["Phone Number"] !== "";
	})],
	["M3 union without /e-?mail/ (Email leaks)", () => withResolver("/broker|phone|contact/i", (M) => {
		const out = M.sanitizeBrokerColumns(HEADERS, [G.rowObjectFromCells(HEADERS, row())])[0];
		return out["Email"] !== "";
	})],
	["M4 over-broad union blanks Payment/Owner ID", () => withResolver("/broker|phone|e-?mail|contact|payment|owner/i", (M) => {
		const out = M.sanitizeBrokerColumns(HEADERS, [G.rowObjectFromCells(HEADERS, row())])[0];
		return out["  Payment  "] !== "$1,800.00" || out["Owner ID"] !== "5";
	})],
	["M5 union matching 'Contract ID' via a loose /contac/", () => withResolver("/broker|phone|e-?mail|contrac?t/i", (M) =>
		M.resolveBrokerWithheldColumns(HEADERS).includes("Contract ID"))],
];
for (const [label, probe] of mutants) {
	let detected = false;
	try { detected = probe(); } catch { detected = true; }
	check(`mutant detected — ${label}`, detected, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
