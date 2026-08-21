#!/usr/bin/env node
/**
 * Tests the duplicate-row tripwire on POST /api/n8n/load-distance, and the
 * property it depends on: deduplicateLoads(..., true) reports the extra rows.
 *
 * WHY IT EXISTS. C.H. Robinson sends each load as TWO emails. When both land in
 * one Gmail poll the workflow runs once with two items, and the Sheets
 * appendOrUpdate node cannot dedupe inside its own batch — neither item sees the
 * row the other just appended, so BOTH append. Execution 2501 on 2026-08-21 put
 * load 564446669 on rows 433 and 434, after which it could not be dispatched at
 * all. 87 of 308 load ids already carried a historical duplicate and nobody
 * noticed until one landed on a live load.
 *
 * The cause is fixed upstream in n8n. This pins the tripwire that proves it
 * stayed fixed:
 *   §1 duplicates are detected, and the ONE load asked about is the one reported
 *   §2 the "#" / case / whitespace forms of a load id are the same load
 *   §3 a clean sheet reports nothing (no false alarm on every ingestion)
 *   §4 the tripwire only OBSERVES — the response body must stay flat, and the
 *      route must not gain a key, or it re-creates the `output`-column trap
 *   §5 a failure inside the tripwire cannot fail the ingestion
 *
 * Run: node scripts/test-ingest-dupe-tripwire.js
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const failures = [];
let pass = 0;
const ok = (c, m) => { if (c) pass++; else failures.push(m); };

// Lift deduplicateLoads out of server.js — the helper the tripwire reuses.
function lift(head) {
	const a = SRC.indexOf(head);
	if (a < 0) throw new Error(`missing ${head}`);
	let d = 0;
	for (let j = SRC.indexOf("{", a); j < SRC.length; j++) {
		if (SRC[j] === "{") d++;
		else if (SRC[j] === "}" && --d === 0) return SRC.slice(a, j + 1);
	}
	throw new Error("unbalanced");
}
const deduplicateLoads = new Function(lift("function deduplicateLoads(data, headers, returnDuplicates = false) {") + "\nreturn deduplicateLoads;")();

const H = ["Load ID", "Details", "Job Status"];
const row = (id, det = "x", st = "") => ({ "Load ID": id, Details: det, "Job Status": st });
// `mine` mirrors the route: which duplicates belong to the load just ingested.
const mineFor = (data, loadId) => {
	const { duplicates } = deduplicateLoads(data, H, true);
	const key = String(loadId).trim().toLowerCase().replace(/^#/, "");
	return duplicates.filter((d) => String(d["Load ID"] || "").trim().toLowerCase().replace(/^#/, "") === key);
};

// ───────────────────────────── §1 the real shape from execution 2501
{
	const sheet = [row("565089380"), row("565211673"), row("564446669"), row("564446669")];
	ok(mineFor(sheet, "564446669").length === 1,
		"§1 the load written twice in one batch must be reported as duplicated");
	ok(mineFor(sheet, "565211673").length === 0,
		"§1 a load written ONCE must not be reported — the tripwire names one load, not the sheet's whole backlog");
	// 87 historical duplicates exist; an ingestion must not shout about them.
	const withHistory = [row("111111"), row("111111"), row("222222"), row("564446669"), row("564446669")];
	ok(mineFor(withHistory, "564446669").length === 1 && mineFor(withHistory, "222222").length === 0,
		"§1 unrelated historical duplicates must not be attributed to the load being ingested");
}

// ───────────────────────────── §2 id forms
{
	ok(mineFor([row("#564446669"), row("564446669")], "564446669").length === 1,
		"§2 '#564446669' and '564446669' are the same load — the sheet holds both forms");
	ok(mineFor([row(" ABC123 "), row("abc123")], "ABC123").length === 1,
		"§2 case and whitespace must not hide a duplicate");
}

// ───────────────────────────── §3 no false alarm
{
	ok(mineFor([row("1"), row("2"), row("3")], "2").length === 0, "§3 a clean sheet must report nothing");
	ok(mineFor([], "2").length === 0, "§3 an empty sheet must not throw or report");
	ok(mineFor([row(""), row("")], "").length === 0,
		"§3 blank load ids are not duplicates of each other — deduplicateLoads skips them");
}

// ───────────────────────────── §4 the route must stay OBSERVE-ONLY
{
	const i = SRC.indexOf("[ingest-dupe]");
	ok(i > 0, "§4 the tripwire should exist");
	const block = SRC.slice(i - 3000, i + 3000);
	ok(!/deleteDimension|batchUpdate|values\.(update|append|clear)/.test(block),
		"§4 the tripwire must never WRITE to the sheet — an unattended ingestion path does not delete rows");
	// The response body's top-level keys are Job Details column names. A new key
	// there is the trap that dumped 151 JSON blobs into a column named `output`.
	const resp = SRC.slice(SRC.indexOf('return res.json({\n\t\t\t"Load ID": loadId,'));
	const keys = (resp.slice(0, resp.indexOf("_meta:")).match(/^\t\t\t"?[A-Za-z ]+"?:/gm) || [])
		.map((k) => k.trim().replace(/[":]/g, "").trim());
	ok(keys.join(",") === "Load ID,Distance,Rate Per Mile,Details,Payment",
		`§4 the flat response body changed — top-level keys must stay the Job Details column names (got ${keys.join(",")})`);
}

// ───────────────────────────── §5 the tripwire cannot fail the ingestion
{
	const i = SRC.indexOf("[ingest-dupe] duplicate check failed");
	ok(i > 0, "§5 the tripwire must catch its own failure");
	const before = SRC.slice(SRC.indexOf("⚠️ DUPLICATE-ROW TRIPWIRE"), i);
	ok(/try \{/.test(before), "§5 …inside a try, so a Sheets hiccup cannot 500 an ingestion that already succeeded");
	ok(/catch \{ \/\* observation must never fail the ingestion \*\/ \}/.test(before),
		"§5 …and the audit write must be separately guarded");
}

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
