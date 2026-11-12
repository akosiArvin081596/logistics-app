#!/usr/bin/env node
// scripts/test-deleted-load-restore-what-would-change.js: the read-only report run before
// DELETED_LOAD_RESTORE_ENABLED goes on (scripts/deleted-load-restore-what-would-change.js), on the made-up world
// in scripts/lib/deleted-load-restore-report-world.js.
//
//   §1  the command line: every refused argument exits 2 before anything is opened, names no sheet ID, and makes
//       no file; production's app directory takes production's sheet only, and production's sheet takes
//       production's database or a copy only
//   §2  read-only: the handle is read-only with query_only on, so a write throws; the database's bytes and its
//       folder are the same after runs; a database without row_digests is refused and still has none
//   §3  no network on a --values-json run: googleapis is never loaded, no connection or lookup is made
//   §4  the hand-worked world: every count, group, month and press, each record in exactly one group (a report
//       built on de-duplicated rows fails it), from the module and from the command line; the module is
//       mounted with the helpers server.js hands it
//   §6  what it prints: by default none of the world's load numbers, people, drivers, places, amounts, reasons
//       or settings; --ids prints exactly the P1 and P2 load numbers, in one block, none from a closed month
//   §7  the after-check's shape: the flag on, two notices told, one audited restore and one new delete with
//       recorded rows; the state counts say so, and only the deletes not told yet are predicted
// §5, the report against the app's own module and restore route, is
// scripts/test-deleted-load-restore-what-would-change-parity.js.
//
// Made-up data only, in a fresh temp folder. It never reads app.db, the app's settings or the network.
//   node scripts/test-deleted-load-restore-what-would-change.js      # exits 1 on any failure
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "deleted-load-restore-what-would-change.js");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const WORLD = require("./lib/deleted-load-restore-report-world");
const sheetIds = require("../lib/sheet-id");

let pass = 0;
const failures = [];
// Objects compare whatever their key order; arrays in order.
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
	? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
function eq(actual, expected, label) {
	const a = canon(actual);
	const e = canon(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) {
	if (cond) { pass++; return; }
	failures.push(label);
}
// A section that throws (the script missing, a function gone) fails as a whole.
async function section(title, fn) {
	console.log(title);
	try {
		await fn();
	} catch (err) {
		failures.push(`${title}\n      threw: ${String(err && err.message).split("\n")[0]}`);
	}
}

let report = null;
let loadError = null;
try { report = require(SCRIPT); } catch (err) { loadError = err; }
ok(report, `scripts/deleted-load-restore-what-would-change.js loads${loadError ? ` (${String(loadError.message).split("\n")[0]})` : ""}`);

// ── the made-up worlds ────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-dlr-report-"));
const NOW = Date.now();
const base = WORLD.buildWorld({ dir: path.join(TMP, "base"), now: NOW });
const after = WORLD.buildWorld({ dir: path.join(TMP, "after"), now: NOW, variant: "after" });
const bare = WORLD.buildWorld({ dir: path.join(TMP, "bare"), now: NOW, digests: false });
const fileArgs = (w) => ["--dry-run", `--db=${w.dbFile}`, `--values-json=${w.valuesFile}`, `--env-file=${w.flagsFile}`];

const TEST_SHEET = "made-up-sheet-id-0123456789";
const PROD_SHEET = sheetIds.PRODUCTION_SPREADSHEET_ID;
const PROD_DIR = sheetIds.PRODUCTION_DIR;
const KEY = path.join(TMP, "made-up-key.json");
const MISSING = path.join(TMP, "base", "missing.db");
const OUTSIDE = path.join(path.dirname(ROOT), `made-up-outside-${process.pid}.db`);
const IN_ROOT = path.join(ROOT, `made-up-not-there-${process.pid}.db`);
// A copy whose settings name production's sheet, for --sheet-id=env.
const prodNamed = path.join(TMP, "prod-named-settings", "made-up-flags.txt");
fs.mkdirSync(path.dirname(prodNamed), { recursive: true });
fs.writeFileSync(prodNamed, `SPREADSHEET_ID=${PROD_SHEET}\n`);

const listing = (dir) => fs.readdirSync(dir).sort().map((f) => {
	const st = fs.statSync(path.join(dir, f));
	return `${f}:${st.isDirectory() ? "dir" : st.size}:${st.mtimeMs}`;
});
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const BEFORE = { list: listing(path.dirname(base.dbFile)), sha: sha(base.dbFile) };

// The child's environment: this one's, without anything that names a sheet or another server.js.
function childEnv(extra = {}) {
	const env = { ...process.env };
	for (const k of ["SPREADSHEET_ID", "SERVER_JS", "SERVER_ROOT", "NODE_OPTIONS", "APP_TIMEZONE"]) delete env[k];
	return { ...env, ...extra };
}
function cli(args, { env = {}, preload = null } = {}) {
	const r = spawnSync(process.execPath, [...(preload ? ["--require", preload] : []), SCRIPT, ...args],
		{ cwd: TMP, env: childEnv(env), encoding: "utf8", timeout: 60_000 });
	return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}
const runIn = (args) => report.run(args, { env: {} });
const strip = (o) => {
	if (!o || typeof o !== "object") return o;
	const { cost: _cost, ...rest } = o;
	return rest;
};

(async () => {
	// ── §1 ──────────────────────────────────────────────────────────────────────
	await section("§1  the command line", () => {
		const refusals = [
			["no --dry-run", [`--db=${base.dbFile}`, `--values-json=${base.valuesFile}`, `--env-file=${base.flagsFile}`], /--dry-run is required/],
			["no --db", ["--dry-run", `--values-json=${base.valuesFile}`, `--env-file=${base.flagsFile}`], /--db=<app\.db> is required/],
			["a --db naming no file", ["--dry-run", `--db=${MISSING}`, `--values-json=${base.valuesFile}`, `--env-file=${base.flagsFile}`], /--db names no file/],
			["a database outside the app directory and the temp folder", ["--dry-run", `--db=${OUTSIDE}`, `--values-json=${base.valuesFile}`], /own app directory's database .* or a copy under the temp directory/],
			["neither sheet argument, and no SPREADSHEET_ID", ["--dry-run", `--db=${base.dbFile}`, `--env-file=${base.flagsFile}`], /needs SPREADSHEET_ID/],
			["both sheet arguments", [...fileArgs(base), `--sheet-id=${TEST_SHEET}`], /name the sheet once/],
			["a sheet argument and SPREADSHEET_ID", fileArgs(base), /name the sheet once/, { SPREADSHEET_ID: TEST_SHEET }],
			["--sheet-id with no value", ["--dry-run", `--db=${base.dbFile}`, "--sheet-id"], /--sheet-id needs a value/],
			["--sheet-id= with nothing after it", ["--dry-run", `--db=${base.dbFile}`, "--sheet-id="], /--sheet-id needs a value/],
			["--sheet-id that isn't an ID", ["--dry-run", `--db=${base.dbFile}`, "--sheet-id=not a sheet id", `--key=${KEY}`], /name the sheet by its ID/],
			["production's sheet with an app directory's own database that isn't production's", ["--dry-run", `--db=${IN_ROOT}`, `--sheet-id=${PROD_SHEET}`, `--key=${KEY}`], /production's sheet is read only for production's own database/],
			["…the same, production's sheet named by SPREADSHEET_ID", ["--dry-run", `--db=${IN_ROOT}`, `--key=${KEY}`], /production's sheet is read only for production's own database/, { SPREADSHEET_ID: PROD_SHEET }],
			["a live sheet without --key", ["--dry-run", `--db=${base.dbFile}`, `--sheet-id=${TEST_SHEET}`, `--env-file=${base.flagsFile}`], /--key=<the service account's key file> is required/],
			["--key on a --values-json run", [...fileArgs(base), `--key=${KEY}`], /--key is for reading the live sheet/],
			["--key naming no file", ["--dry-run", `--db=${base.dbFile}`, `--sheet-id=${TEST_SHEET}`, `--key=${KEY}`, `--env-file=${base.flagsFile}`], /--key names no file/],
			["--sheet-id=env when the copy's settings name no sheet", ["--dry-run", `--db=${base.dbFile}`, "--sheet-id=env", `--key=${KEY}`, `--env-file=${base.flagsFile}`], /needs SPREADSHEET_ID/],
			["--sheet-id=env naming production's sheet, a copy: past the sheet checks, stopped at the key", ["--dry-run", `--db=${base.dbFile}`, "--sheet-id=env", `--key=${KEY}`, `--env-file=${prodNamed}`], /--key names no file/],
			["--env-file for an app directory's own database", ["--dry-run", `--db=${IN_ROOT}`, `--values-json=${base.valuesFile}`, `--env-file=${base.flagsFile}`], /--env-file is only for a copy/],
			["an unknown argument", [...fileArgs(base), "--since=2026-01-01"], /unknown argument --since/],
			["a bare word", [...fileArgs(base), "made-up-positional"], /unknown argument/],
			["--json with a value", [...fileArgs(base), "--json=yes"], /--json takes no value/],
			["--ids with a value", [...fileArgs(base), "--ids=all"], /--ids takes no value/],
			["--db given twice", [...fileArgs(base), `--db=${base.dbFile}`], /--db is given twice/],
		];
		for (const [label, args, want, env] of refusals) {
			const r = cli(args, { env: env || {} });
			ok(r.code === 2 && want.test(r.err) && r.out === "",
				`§1 ${label}: refused with exit 2 (${want})${r.code === 2 && want.test(r.err) ? "" : `: exit ${r.code} ${JSON.stringify(r.err.split(TMP).join("<tmp>").slice(0, 200))}`}`);
			ok(!r.err.includes(PROD_SHEET) && !r.err.includes(TEST_SHEET), `§1 ${label}: the refusal names no sheet ID`);
		}
		for (const [what, f] of [["the missing database", MISSING], ["the database outside", OUTSIDE], ["the app directory's database", IN_ROOT], ["the key file", KEY]]) {
			ok(!fs.existsSync(f), `§1 ${what} is never created`);
		}

		// Production's own directory can't be run here, so the rule is asked directly, with lib/sheet-id.js's values.
		const prod = { dir: PROD_DIR, sheetId: PROD_SHEET };
		const tr = (o) => report.targetRefusal({ production: prod, ...o });
		ok(!!PROD_DIR && !!PROD_SHEET, "§1 production's app directory and sheet are readable from lib/sheet-id.js");
		ok(!!tr({ root: PROD_DIR, scope: "app", live: true, sheetId: TEST_SHEET }), "§1 production's app directory with another sheet: refused");
		ok(!!tr({ root: PROD_DIR, scope: "app", live: false, sheetId: null }), "§1 production's app directory with a saved values file: refused");
		ok(!!tr({ root: PROD_DIR, scope: "copy", live: true, sheetId: TEST_SHEET }), "§1 production's app directory, a copy, another sheet: refused");
		ok(tr({ root: PROD_DIR, scope: "app", live: true, sheetId: PROD_SHEET }) === null, "§1 production's app directory with production's sheet: run");
		ok(tr({ root: PROD_DIR, scope: "copy", live: true, sheetId: PROD_SHEET }) === null, "§1 production's app directory, a copy, production's sheet: run");
		ok(!!tr({ root: "/srv/made-up-staging", scope: "app", live: true, sheetId: PROD_SHEET }), "§1 production's sheet with another app directory's own database: refused");
		ok(tr({ root: "/srv/made-up-staging", scope: "copy", live: true, sheetId: PROD_SHEET }) === null, "§1 production's sheet with a copy under the temp folder: run");
		ok(tr({ root: "/srv/made-up-staging", scope: "app", live: true, sheetId: TEST_SHEET }) === null, "§1 another app directory with its own sheet: run");
		ok(tr({ root: "/srv/made-up-staging", scope: "copy", live: false, sheetId: null }) === null, "§1 a copy with a saved values file: run");
	});

	// ── §2 ──────────────────────────────────────────────────────────────────────
	await section("§2  read-only", async () => {
		const db = report.openReadOnly(base.dbFile);
		try {
			ok(db.readonly === true, "§2 the handle is read-only");
			eq(db.pragma("query_only", { simple: true }), 1, "§2 query_only is on");
			let threw = "";
			try { db.prepare("UPDATE deleted_loads SET row_index = 0 WHERE id = 1").run(); } catch (e) { threw = e.code || "threw"; }
			ok(threw !== "", "§2 a write through the handle throws");
		} finally {
			db.close();
		}
		const r = cli(fileArgs(base));
		eq(r.code, 0, `§2 a run on the made-up world finishes${r.code ? ` (${r.err.slice(0, 160)})` : ""}`);
		await runIn([...fileArgs(base), "--json"]);
		eq(sha(base.dbFile), BEFORE.sha, "§2 the database's SHA-256 is the same after the runs");
		eq(listing(path.dirname(base.dbFile)), BEFORE.list, "§2 its folder holds the same files, sizes and times after the runs");

		const refused = cli(fileArgs(bare));
		ok(refused.code === 2 && /row_digests/.test(refused.err) && /never/.test(refused.err), `§2 a database without row_digests is refused (exit ${refused.code})`);
		const check = new Database(bare.dbFile, { readonly: true, fileMustExist: true });
		const cols = check.prepare("SELECT name FROM pragma_table_info('deleted_loads')").all().map((c) => c.name);
		check.close();
		ok(cols.length > 0 && !cols.includes("row_digests"), "§2 …and still has no row_digests column afterwards");
	});

	// ── §3 ──────────────────────────────────────────────────────────────────────
	await section("§3  no network", () => {
		const log = path.join(TMP, "network.log");
		const preload = path.join(TMP, "no-network.js");
		fs.writeFileSync(preload, `"use strict";
const Module = require("module");
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const note = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
const load = Module._load;
Module._load = function (request, ...rest) {
	if (/^(googleapis|google-auth-library|gaxios)(\\/|$)/.test(String(request))) { note("require " + request); throw new Error("no Google client on a file run"); }
	return load.call(this, request, ...rest);
};
const refuse = (what) => function () { note(what); throw new Error("no network on a file run"); };
net.Socket.prototype.connect = refuse("connect");
dns.lookup = refuse("lookup");
globalThis.fetch = refuse("fetch");
`);
		const r = cli([...fileArgs(base), "--json"], { preload });
		eq(r.code, 0, `§3 a --values-json run finishes with every way out refused${r.code ? ` (${r.err.slice(0, 160)})` : ""}`);
		eq(fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [], [], "§3 …and loads no Google client, opens no connection, looks up no host");
		const src = fs.readFileSync(SCRIPT, "utf8");
		ok(!/require\(\s*["'`]googleapis/.test(src) && !/\bfetch\s*\(/.test(src), "§3 the script itself requires no Google client and calls no fetch");
		ok(!/\.env\b|service-account|settings\.env/.test(src), "§3 the script names no settings or key file of its own");
	});

	// ── §4 ──────────────────────────────────────────────────────────────────────
	await section("§4  the hand-worked world", async () => {
		const r = await runIn([...fileArgs(base), "--json"]);
		eq(strip(r.out), WORLD.EXPECTED.base, "§4 every count, group, month and press");
		ok(r.out.cost && r.out.cost.runs === 5 && Number.isFinite(r.out.cost.medianMs) && r.out.cost.medianMs >= 0 &&
			r.out.cost.records === 21 && r.out.cost.rows === 25, "§4 the dashboard check is timed, median of 5 runs, over every record and row");

		const groups = { none: [], banner: [], closedOnly: [], notShown: [] };
		for (const rec of r.model.records) groups[rec.group].push(rec.id);
		eq(groups, WORLD.GROUPS.base, "§4 each record lands in exactly one group, the hand-worked one");
		for (const rec of r.model.records) {
			eq([rec.restore.code, rec.createNew.code], WORLD.PRESS[rec.id], `§4 record ${rec.id}: what Restore and Create it as new would answer`);
		}
		// The traps a report on de-duplicated rows falls into: each fails alone if the rows are de-duplicated.
		const byId = new Map(r.model.records.map((x) => [x.id, x]));
		ok(r.out.banner.records.includes(17), "§4 record 17 is on the banner: its live top copy counts, though the dedupe keeps its cancelled bottom copy");
		eq(r.out.notShown.p2.moreThanOneLiveRow, 1, "§4 record 7's two live rows are both seen (the dedupe keeps one)");
		eq(byId.get(9) && byId.get(9).restore.code, "PERIOD_FINALIZED", "§4 record 9's Restore reads its closed-month row too (the dedupe drops it)");
		eq(byId.get(2) && byId.get(2).restore, { code: "OK", months: ["2026-10"], remaining: 0, liveRows: 0 }, "§4 record 2's Restore reads its cancelled row: it restores, and no figure moves");
		eq(byId.get(12) && byId.get(12).restore.remaining, 1, "§4 a load deleted twice: a press on one record leaves the other");
		eq(r.model.notices.length, 13, "§4 the module's own first read would write 13 notices");
		eq(r.model.notices.map((n) => `${n.kind}:${n.tombstoneId}`).sort(), r.model.predictedNotices.map((n) => `${n.kind}:${n.tombstoneId}`).sort(),
			"§4 the notices the report predicts are the module's");

		const c = cli([...fileArgs(base), "--json"]);
		let viaCli = null;
		try { viaCli = JSON.parse(c.out); } catch { viaCli = null; }
		eq(c.code, 0, "§4 the command line runs");
		eq(strip(viaCli), WORLD.EXPECTED.base, "§4 the command line gives the same answer");

		// The helpers the report mounts the module with are the ones server.js mounts it with.
		const src = require("./lib/server-source").serverSource({ root: ROOT });
		const head = "deletedLoadRestore.mount(app, {";
		const start = src.indexOf(`\n${head}\n`);
		const block = start === -1 ? "" : src.slice(start + head.length + 2, src.indexOf("\n});\n", start));
		const serverKeys = [];
		for (const line of block.split("\n")) {
			if (!/^\t[^\t]/.test(line) || /^\t\/\//.test(line)) continue;
			const named = /^\t([A-Za-z_$][\w$]*):/.exec(line);
			if (named) serverKeys.push(named[1]);
			else serverKeys.push(...line.split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s)));
		}
		const helpers = { auditText() {} };
		for (const k of serverKeys) helpers[k] = () => {};
		const mounted = report.mountHelpers(helpers, { headers: [], data: [] }, []);
		eq(Object.keys(mounted).sort(), [...serverKeys].sort(), "§4 the report hands the module the helpers server.js hands it, by name");
		const lifted = Object.keys(mounted).filter((k) => !report.STAND_INS.includes(k));
		ok(lifted.length === 8 && lifted.every((k) => mounted[k] === helpers[k]), "§4 …each lifted one passed as it is, the rest stand-ins that reach nothing");
	});

	// ── §6 ──────────────────────────────────────────────────────────────────────
	await section("§6  what it prints", () => {
		const outputs = [
			["the text", cli(fileArgs(base))],
			["the JSON", cli([...fileArgs(base), "--json"])],
			["the after-check's text", cli(fileArgs(after))],
			["the after-check's JSON", cli([...fileArgs(after), "--json"])],
		];
		for (const [what, r] of outputs) {
			eq(r.code, 0, `§6 ${what}: the run finishes`);
			eq(WORLD.PLANTED.filter((re) => re.test(r.out) || re.test(r.err)).map(String), [],
				`§6 ${what} holds none of the world's load numbers, people, drivers, places, amounts, reasons or settings`);
			ok(!r.out.includes(TMP), `§6 ${what} names no file it read`);
		}
		const text = outputs[0][1].out;
		console.log(text.split("\n").map((l) => `    ${l}`).join("\n"));
		for (const want of [
			"DRY RUN (nothing written, nothing sent): what DELETED_LOAD_RESTORE_ENABLED would change",
			"  flag in the app's settings: off; trip work-day cover: off; Job Tracking rows 25 (22 after the dedupe)",
			"  months named below: 2026-08 closed, 2026-09 closed, 2026-10 open, 2026-11 open",
			"  1a. on the banner: 11 (records 3, 4, 6, 9, 11, 12, 14, 15, 16, 17, 18)",
			"      a press now: Create it as new clears it 7; only Restore, bringing the deleted row back 2; neither 2",
			"      months: 2026-09 closed 1; 2026-10 open 6; 2026-11 open 4; no month 1",
			"      may be the deleted row itself, Create it as new offered (P1): 3 (no row number at an older delete 2; dates moved, one live row 1)",
			"  1b. closed months only (off the banner, one notice each): 2 (2026-08 1, 2026-09 1)",
			"  1c. not shown: 6 (audit names its months 4; no audit row 1; audit names no month 1)",
			"      for a person, open months (P2): more than one live row 1; none at the stored row number 1",
			"2. notices the next Super Admin dashboard read would write: 13 (hidden 11, hidden_closed 2); already stored: hidden 0, hidden_closed 0",
			"load numbers for a person: 5 (not printed; run with --ids)",
		]) ok(text.split("\n").includes(want), `§6 the text says: ${want.trim()}`);
		ok(!/REAL DATA/.test(text), "§6 without --ids there is no real-data block");

		const ids = cli([...fileArgs(base), "--ids"]);
		eq(ids.code, 0, "§6 --ids runs");
		const lines = ids.out.split("\n");
		const from = lines.findIndex((l) => /^REAL DATA/.test(l));
		const to = lines.findIndex((l) => /^END OF REAL DATA/.test(l));
		ok(from > 0 && to > from, "§6 --ids prints its load numbers in one block headed as real data");
		const inside = lines.slice(from + 1, to).join("\n");
		const outside = [...lines.slice(0, from), ...lines.slice(to + 1)].join("\n");
		eq([...inside.matchAll(/MU-DLR-\d{4}/g)].map((m) => m[0]), WORLD.PERSON_IDS, "§6 --ids prints exactly the P1 and P2 load numbers, P1 first");
		ok(!/MU-DLR-\d{4}/.test(outside), "§6 …and none outside the block");
		for (const closed of ["MU-DLR-0105", "MU-DLR-0110", "MU-DLR-0119"]) ok(!ids.out.includes(closed), `§6 --ids never prints ${closed}, a closed month's`);
		eq(WORLD.PLANTED.slice(1).filter((re) => re.test(ids.out)).map(String), [], "§6 …and the block holds no people, drivers, places, amounts, reasons or settings");
		ok(/^load numbers for a person: 5 \(printed below, as real data\)$/m.test(ids.out), "§6 --ids says the load numbers are printed below");
		const idsJson = cli([...fileArgs(base), "--ids", "--json"]);
		let parsed = null;
		try { parsed = JSON.parse(idsJson.out); } catch { parsed = null; }
		eq(parsed && parsed.person && parsed.person.ids && parsed.person.ids.map((x) => x.loadId), WORLD.PERSON_IDS, "§6 --ids --json lists the same load numbers");
	});

	// ── §7 ──────────────────────────────────────────────────────────────────────
	await section("§7  the after-check's shape", async () => {
		const r = await runIn([...fileArgs(after), "--json"]);
		eq(strip(r.out), WORLD.EXPECTED.after, "§7 every count after the switch-on");
		const groups = { none: [], banner: [], closedOnly: [], notShown: [] };
		for (const rec of r.model.records) groups[rec.group].push(rec.id);
		eq(groups, WORLD.GROUPS.after, "§7 the same records sit in the same groups, with the new delete on the banner");
		const told = r.model.predictedNotices.map((n) => `${n.kind}:${n.tombstoneId}`);
		ok(!told.includes("hidden:3") && !told.includes("hidden_closed:5") && told.includes("hidden:22") && told.includes("hidden_closed:10"),
			"§7 only the deletes not told yet are predicted: record 3 and record 5 are told, record 22 is new");
		const text = cli(fileArgs(after)).out;
		for (const want of [
			"  flag in the app's settings: on; trip work-day cover: off; Job Tracking rows 26 (23 after the dedupe)",
			"  delete records 21 (20 Load IDs); with recorded rows 1; stored notices: load-hidden-by-delete 2 (hidden 1, hidden_closed 1, refused_create 0), deleted-load-restored 1; restore_load 1; clear_load_delete 0",
			"2. notices the next Super Admin dashboard read would write: 12 (hidden 11, hidden_closed 1); already stored: hidden 1, hidden_closed 1",
		]) ok(text.split("\n").includes(want), `§7 the text says: ${want.trim()}`);
	});

	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		for (const f of failures) console.log(`  ✗ ${f}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} passed, 0 failed`);
})();
