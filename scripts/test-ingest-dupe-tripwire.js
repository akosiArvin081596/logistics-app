#!/usr/bin/env node
/**
 * Tests the duplicate-row tripwire on POST /api/n8n/load-distance — the reader
 * that says the 2026-08-21 ingestion fix stayed fixed — and, above all, its
 * WIRING.
 *
 * WHY IT EXISTS. C.H. Robinson sends each load as TWO emails. When both land in
 * one Gmail poll the workflow runs once with two items, and the Sheets
 * appendOrUpdate node cannot dedupe inside its own batch — neither item sees the
 * row the other just appended, so BOTH append. Execution 2501 on 2026-08-21 put
 * load 564446669 on rows 433 and 434, after which it could not be dispatched at
 * all. 87 of 308 load ids already carried a historical duplicate and nobody
 * noticed until one landed on a live load. The cause is fixed upstream in n8n;
 * this tripwire is what would notice it coming back.
 *
 * ⚠️ THE PREVIOUS VERSION OF THIS FILE PASSED WHILE THE TRIPWIRE WAS DEAD. It
 * exercised deduplicateLoads(…, true) on raw rows — which works — while the route
 * fed it getJobTrackingCached(), whose rows deduplicateLoads() has ALREADY
 * collapsed. A second row could never be seen, so the tripwire could never fire.
 * Testing the helper and not what it is fed is exactly the gap, so §3 pins the
 * feed and §2 executes the real reader end to end.
 *
 *   §1 sheetRowsCarryingLoad() on RAW rows: the ingested load only; id forms
 *   §2 ingestDuplicateTripwire() executed over a fake Sheets read: it alerts on
 *      the 2501 shape, stays silent on a clean sheet AND on other loads' historical
 *      duplicates, and a failure anywhere inside it is logged, never thrown
 *   §3 THE WIRING: a fresh raw read, never the deduplicated cache
 *   §4 observe-only and off the critical path: no sheet write, scheduled after
 *      the response, response body unchanged
 *   §5 DISCRIMINATION — each defanged clause must flip an assertion
 *
 * Tolerant lifting: on code without ingestDuplicateTripwire() this reports FAILs
 * (and the dead wiring in §3) rather than crashing, so it fails for the reason.
 *
 * Pure: no server, no app.db, no network. Run: node scripts/test-ingest-dupe-tripwire.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}

// --- lifting ---------------------------------------------------------------
// Body-first brace count (the parameter list is paren-matched first); keeps a
// leading `async `. Returns "" when the function does not exist.
function liftFn(name, src = SRC) {
	let a = src.indexOf(`\nfunction ${name}(`);
	if (a < 0) a = src.indexOf(`\nasync function ${name}(`);
	if (a < 0) return "";
	a += 1;
	let p = src.indexOf("(", src.indexOf(`function ${name}(`, a));
	for (let d = 0; p < src.length; p++) {
		if (src[p] === "(") d++;
		else if (src[p] === ")" && --d === 0) break;
	}
	let depth = 0, seen = false;
	for (let i = src.indexOf("{", p); i < src.length; i++) {
		if (src[i] === "{") { depth++; seen = true; }
		else if (src[i] === "}") { depth--; if (seen && depth === 0) return src.slice(a, i + 1); }
	}
	throw new Error(`unbalanced braces in ${name}`);
}
function routeBody(src = SRC) {
	const at = src.indexOf('\napp.post("/api/n8n/load-distance"');
	if (at < 0) return "";
	let depth = 0;
	for (let j = src.indexOf("(", at + 1); j < src.length; j++) {
		if (src[j] === "(") depth++;
		else if (src[j] === ")" && --depth === 0) return src.slice(at + 1, j + 1);
	}
	return "";
}

const NORM_SRC = (SRC.match(/^const normLoadKey = [^\n]+;$/m) || [""])[0];
const ROWS_SRC = liftFn("sheetRowsCarryingLoad");
const TRIP_SRC = liftFn("ingestDuplicateTripwire");
const DEDUP_SRC = liftFn("deduplicateLoads");
const ROUTE = routeBody();
ok("(normLoadKey, deduplicateLoads and the route are present)", !!NORM_SRC && !!DEDUP_SRC && !!ROUTE);
ok("the tripwire has an executable reader: sheetRowsCarryingLoad() + ingestDuplicateTripwire()",
	!!ROWS_SRC && !!TRIP_SRC);

function buildRows(rowsSrc = ROWS_SRC) {
	if (!rowsSrc || !NORM_SRC) return null;
	return new Function(`"use strict";\n${NORM_SRC}\n${rowsSrc}\nreturn sheetRowsCarryingLoad;`)();
}
// A tripwire whose Sheets read returns `values` (RAW, header row first), or throws.
function buildTrip({ tripSrc = TRIP_SRC, rowsSrc = ROWS_SRC, values = [], readThrows = null, auditThrows = null } = {}) {
	if (!tripSrc || !rowsSrc || !NORM_SRC) return null;
	const seen = { warns: [], errors: [], audits: [], reads: [] };
	const sheets = {
		spreadsheets: {
			// ONLY a read exists: a write attempt is a TypeError the tripwire logs.
			values: {
				get: async (args) => {
					seen.reads.push(args);
					if (readThrows) throw readThrows;
					return { data: { values } };
				},
			},
		},
	};
	const fakeConsole = { log() {}, warn: (...a) => seen.warns.push(a.join(" ")), error: (...a) => seen.errors.push(a.join(" ")) };
	const logAudit = (req, action, entity, entityId, details) => {
		if (auditThrows) throw auditThrows;
		seen.audits.push({ user: req && req.session && req.session.user && req.session.user.username, action, entity, entityId, details });
	};
	const fn = new Function("getSheets", "SPREADSHEET_ID", "logAudit", "console",
		`"use strict";\n${NORM_SRC}\n${rowsSrc}\n${tripSrc}\nreturn ingestDuplicateTripwire;`)(
		async () => sheets, "sheet-under-test", logAudit, fakeConsole);
	return { fn, seen };
}

// --- fixtures: RAW values, exactly as values.get returns them ---------------
const H = ["Load ID", "Details", "Job Status"];
const raw = (...ids) => [H, ...ids.map((id) => [id, "x", ""])];
const EXEC_2501 = raw("565089380", "565211673", "564446669", "564446669");     // rows 2..5
const WITH_HISTORY = raw("111111", "111111", "222222", "564446669");          // others duplicated

(async () => {
	// =========================================================================
	console.log("\n§1  sheetRowsCarryingLoad() — RAW rows, the ingested load only");
	// =========================================================================
	const rowsOf = buildRows();
	if (rowsOf) {
		const [hdr, ...body] = EXEC_2501;
		ok("the 2501 shape: load 564446669 is on sheet rows 4 and 5",
			JSON.stringify(rowsOf(hdr, body, "564446669")) === "[4,5]");
		ok("a load written once is on one row", JSON.stringify(rowsOf(hdr, body, "565211673")) === "[3]");
		const [h2, ...b2] = WITH_HISTORY;
		ok("other loads' historical duplicates are not attributed to the ingested load",
			rowsOf(h2, b2, "564446669").length === 1 && rowsOf(h2, b2, "222222").length === 1);
		ok("'#564446669' and '564446669' are one load (the sheet holds both forms)",
			rowsOf(H, [["#564446669"], ["564446669"]], "564446669").length === 2 &&
			rowsOf(H, [["564446669"]], "#564446669").length === 1);
		ok("case and whitespace do not hide a row",
			rowsOf(H, [[" ABC123 "], ["abc123"]], "ABC123").length === 2);
		ok("a blank load id matches nothing — not even blank rows",
			rowsOf(H, [[""], [""]], "").length === 0 && rowsOf(H, [[""], ["7"]], "7").length === 1);
		ok("the Load ID column is found by name, wherever it sits",
			JSON.stringify(rowsOf(["Details", "Load ID"], [["x", "9"], ["y", "9"]], "9")) === "[2,3]");
		ok("no Load ID column → nothing counted (no guess)", rowsOf(["Driver"], [["9"], ["9"]], "9").length === 0);
		ok("ragged / missing rows do not throw", rowsOf(H, [undefined, [], ["9"]], "9").length === 1);
	}

	// =========================================================================
	console.log("\n§2  ingestDuplicateTripwire() — executed over a fake Sheets read");
	// =========================================================================
	const dup = buildTrip({ values: EXEC_2501 });
	if (dup) {
		const r = await dup.fn("564446669");
		ok("it resolves (never throws)", r === undefined);
		ok("the 2501 shape ALERTS: one warning naming the load and its rows",
			dup.seen.warns.length === 1 && /load "564446669" is on 2 rows of Job Tracking \(rows 4, 5\)/.test(dup.seen.warns[0]));
		ok("...and one audit row, as the system n8n actor",
			dup.seen.audits.length === 1 && dup.seen.audits[0].action === "ingest_duplicate_row" &&
			dup.seen.audits[0].entityId === "564446669" && dup.seen.audits[0].user === "n8n");
		ok("it reads the WHOLE Job Tracking tab once, fresh",
			dup.seen.reads.length === 1 && dup.seen.reads[0].range === "Job Tracking" &&
			dup.seen.reads[0].spreadsheetId === "sheet-under-test");
		ok("nothing failed inside it", dup.seen.errors.length === 0);
	}
	const clean = buildTrip({ values: raw("1", "2", "3") });
	if (clean) {
		await clean.fn("2");
		ok("a clean sheet: silent — no warning, no audit row",
			clean.seen.warns.length === 0 && clean.seen.audits.length === 0 && clean.seen.errors.length === 0);
	}
	const history = buildTrip({ values: WITH_HISTORY });
	if (history) {
		await history.fn("564446669");
		ok("the ~87 historical duplicates of OTHER loads never alert an ingestion",
			history.seen.warns.length === 0 && history.seen.audits.length === 0);
	}
	const readFails = buildTrip({ readThrows: new Error("socket hang up") });
	if (readFails) {
		const r = await readFails.fn("564446669");
		ok("a failed Sheets read is logged, not thrown",
			r === undefined && readFails.seen.errors.some((l) => /duplicate check failed \(ingestion unaffected\).*socket hang up/.test(l)));
	}
	const auditFails = buildTrip({ values: EXEC_2501, auditThrows: new Error("SQLITE_BUSY") });
	if (auditFails) {
		const r = await auditFails.fn("564446669");
		ok("a failed audit write is swallowed; the warning still goes out",
			r === undefined && auditFails.seen.warns.length === 1 && auditFails.seen.errors.length === 0);
	}
	const longId = buildTrip({ values: [H, ["9".repeat(64) + "\nX"], ["9".repeat(64) + "\nX"]] });
	if (longId) {
		await longId.fn("9".repeat(64) + "\nX");
		ok("a caller-supplied id is capped and quoted in the log line",
			longId.seen.warns.length === 1 && !longId.seen.warns[0].includes("\nX"));
	}

	// =========================================================================
	console.log("\n§3  THE WIRING — a fresh raw read, never the deduplicated cache");
	// =========================================================================
	const dedupe = new Function(`"use strict";\n${DEDUP_SRC}\nreturn deduplicateLoads;`)();
	const objRows = EXEC_2501.slice(1).map(([id]) => ({ "Load ID": id, Details: "x", "Job Status": "" }));
	const cachedView = dedupe(objRows, H);
	ok("WHY: deduplicateLoads() — what getJobTrackingCached() returns — keeps load 564446669 ONCE, " +
		"so nothing reading the cache can ever count its second row",
		cachedView.filter((r) => r["Load ID"] === "564446669").length === 1 &&
		dedupe(cachedView, H, true).duplicates.length === 0);
	ok("the tripwire does NOT read getJobTrackingCached() and does not deduplicate",
		!!TRIP_SRC && !/getJobTrackingCached|deduplicateLoads/.test(TRIP_SRC));
	ok("...it does a fresh values.get of the whole tab",
		/spreadsheets\.values\.get\(\{ spreadsheetId: SPREADSHEET_ID, range: "Job Tracking" \}\)/.test(TRIP_SRC));
	// ⚠️ COMMENTS STRIPPED FIRST: the note above the call explains the old bug BY
	// NAME, so a raw match would fail the fixed code and prove nothing.
	const codeOnly = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	const tripBlock = codeOnly(ROUTE.slice(ROUTE.indexOf("⚠️ DUPLICATE-ROW TRIPWIRE"), ROUTE.indexOf("return res.json({")));
	ok("the route's tripwire block no longer reads the deduplicated cache",
		ROUTE.includes("⚠️ DUPLICATE-ROW TRIPWIRE") && !/getJobTrackingCached\(|deduplicateLoads\(/.test(tripBlock));

	// =========================================================================
	console.log("\n§4  observe-only, and off the critical path");
	// =========================================================================
	ok("the tripwire never WRITES the sheet — an unattended ingestion path does not edit rows",
		!!TRIP_SRC && !/deleteDimension|batchUpdate|values\.(update|append|clear|batchUpdate)/.test(TRIP_SRC));
	ok("the route SCHEDULES it (setImmediate) and never awaits it — n8n's response does not wait on a full-tab read",
		/setImmediate\(\(\) => \{ ingestDuplicateTripwire\(loadId\); \}\);/.test(ROUTE) && !/await ingestDuplicateTripwire/.test(ROUTE));
	ok("...scheduled just before the response, inside the route's success path",
		ROUTE.indexOf("ingestDuplicateTripwire(loadId)") > -1 &&
		ROUTE.indexOf("ingestDuplicateTripwire(loadId)") < ROUTE.indexOf("return res.json({"));
	// The response body's top-level keys are Job Details column names. A new key
	// there is the trap that dumped 151 JSON blobs into a column named `output`.
	const resp = ROUTE.slice(ROUTE.indexOf('return res.json({\n\t\t\t"Load ID": loadId,'));
	const keys = (resp.slice(0, resp.indexOf("_meta:")).match(/^\t\t\t"?[A-Za-z ]+"?:/gm) || [])
		.map((k) => k.trim().replace(/[":]/g, "").trim());
	ok(`the flat response body is unchanged (${keys.join(",")})`,
		keys.join(",") === "Load ID,Distance,Rate Per Mile,Details,Payment");

	// =========================================================================
	console.log("\n§5  DISCRIMINATION — each mutant must be caught");
	// =========================================================================
	async function alertsOn2501(tripSrc, rowsSrc) {
		const t = buildTrip({ tripSrc, rowsSrc, values: EXEC_2501 });
		if (!t) return null;
		await t.fn("564446669");
		return t.seen.warns.length === 1;
	}
	const FEED = "all.slice(1)";
	ok("(mutation anchors present)", !!TRIP_SRC && TRIP_SRC.includes(FEED) && ROWS_SRC.includes("found.push(i + 2)"));
	if (TRIP_SRC && TRIP_SRC.includes(FEED)) {
		// The original bug, reproduced: feed it a deduplicated view.
		const deduped = TRIP_SRC.replace(FEED,
			"all.slice(1).filter((r, i, a) => a.findIndex((x) => normLoadKey((x || [])[0]) === normLoadKey((r || [])[0])) === i)");
		ok("MUTANT fed deduplicated rows (the original bug): the 2501 shape no longer alerts — §2 flips",
			(await alertsOn2501(deduped, ROWS_SRC)) === false);
		const everyRow = ROWS_SRC.replace("if (normLoadKey((row || [])[idIdx]) === key) found.push(i + 2);", "found.push(i + 2);");
		const t = buildTrip({ rowsSrc: everyRow, values: raw("1", "2", "3") });
		await t.fn("2");
		ok("MUTANT counting every row, not the ingested load's: a clean sheet alerts — §2 flips",
			t.seen.warns.length === 1);
		const rawCompare = ROWS_SRC.replace("normLoadKey((row || [])[idIdx]) === key", "String((row || [])[idIdx]) === String(loadId)");
		ok("MUTANT comparing raw ids: '#564446669' is missed — §1 flips",
			buildRows(rawCompare)(H, [["#564446669"], ["564446669"]], "564446669").length === 1);
		const offByOne = TRIP_SRC.replace("if (onRows.length < 2) return;", "if (onRows.length < 1) return;");
		const t2 = buildTrip({ tripSrc: offByOne, values: raw("1", "2", "3") });
		await t2.fn("2");
		ok("MUTANT alerting at ONE row: every ingestion alerts — §2 flips", t2.seen.warns.length === 1);
	}

	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  runner crashed:", (err && err.stack) || err);
	process.exit(1);
});
