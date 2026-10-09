#!/usr/bin/env node
/**
 * scripts/data-fix-october-later-emails.js: its plan, its check before writing,
 * and its command line.
 *
 *   §1 plan() on a stand-in Job Tracking: a cell still holding what the later
 *      email wrote is restored to the first email's value; one already restored
 *      is done; one changed by someone since is skipped, never guessed; a load on
 *      two rows or on none is skipped; a blank Broker Contact Name is restored only
 *      from a supplied value whose hash matches (another value refuses, none
 *      skips), and one filled in since is left alone; every fix keeps Assigned
 *      Date inside October; ranges are explicit A1 cells on the load's own row;
 *   §2 unchanged(): passes when the sheet still holds every planned value, names
 *      a moved row or a changed cell;
 *   §3 the command line refuses (exit 2): an unknown option, neither or both of
 *      --dry-run and --apply, no --db, no sheet, an apply without --expect-cells,
 *      a rehearsal apply without --values-out, a database outside the app
 *      directory and the temp directory, and a finalized October; a rehearsal
 *      apply restores the cells, writes one audit row per cell, and a second apply
 *      writes nothing; bad or wrong names on stdin refuse without printing a name;
 *      a rehearsal apply with the app's own database refuses;
 *   §4 main() in process: ten cells with the names (no name in output or audit);
 *      a read-back that doesn't confirm (re-formatted, short count) exits 5 with
 *      the audit rows already written; a read-back that fails after the write
 *      leaves the audit rows; a re-run adds audit rows for cells found restored
 *      without one, once; the app's own database ties the sheet to the app.
 *
 * Pure: a temp directory, child processes of the script itself, no network.
 * Run: node scripts/test-data-fix-october-later-emails.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "data-fix-october-later-emails.js");
const fix = require(SCRIPT);

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

// A name whose hash stands in for the real one in these tests.
const NAME = "Test Contact";
const HASH = crypto.createHash("sha256").update(NAME).digest("hex");
const HEADER = ["Contract ID", "Load ID", "Details", "Broker Contact Name", "Phone Number", "Assigned Date", "  Payment  "];
// Job Tracking as the later emails left it: every fixed load's Assigned Date is
// what the later email wrote, and the broker contact blank where it blanked it.
function sheet(mutate) {
	const rows = [[...HEADER], ["", "100", "other load", "Someone", "", "10/2/2026, 1:00:00 PM", "$1"]];
	for (const f of fix.FIXES) rows.push(["", f.load, "d", "", "555", f.wrote, "$2"]);
	if (mutate) mutate(rows);
	return rows;
}
const rowOf = (rows, load) => rows.findIndex((r) => r[1] === load);
// The fixes with the test name's hash in place of the real one.
const withHash = () => fix.FIXES.map((f) => ({ ...f, broker: f.broker ? HASH : null }));
function planWith(rows, names) {
	try { return { p: fix.plan(rows, names, withHash()) }; } catch (err) { return { err }; }
}
const NAMES = Object.fromEntries(fix.FIXES.filter((f) => f.broker).map((f) => [f.load, NAME]));

// ── §1 plan() ─────────────────────────────────────────────────────────────────
{
	check("§1 every fix stays inside October", fix.FIXES.every((f) => fix.monthOf(f.original) === "2026-10" && fix.monthOf(f.wrote) === "2026-10"));
	check("§1 six loads, four broker contacts", fix.FIXES.length === 6 && fix.FIXES.filter((f) => f.broker).length === 4);
	check("§1 A1 letters", fix.colLetter(0) === "A" && fix.colLetter(25) === "Z" && fix.colLetter(26) === "AA" && fix.colLetter(53) === "BB");
	const rows = sheet();
	const { p, err } = planWith(rows, NAMES);
	check("§1 a fresh plan", p && p.cells.length === 10 && p.skipped.length === 0 && p.done.length === 0, err ? err.message : JSON.stringify(p && p.skipped));
	if (p) {
		const ad = p.cells.filter((c) => c.column === "Assigned Date");
		check("§1 each Assigned Date goes back to the first email's", ad.length === 6 && ad.every((c) => c.after === fix.FIXES.find((f) => f.load === c.load).original && c.before === fix.FIXES.find((f) => f.load === c.load).wrote));
		check("§1 each range is the load's own row and column", p.cells.every((c) => c.range === `'Job Tracking'!${c.column === "Assigned Date" ? "F" : "D"}${rowOf(rows, c.load) + 1}`), p.cells.map((c) => c.range).join(","));
		check("§1 broker contacts come from the supplied names", p.cells.filter((c) => c.column === "Broker Contact Name").every((c) => c.after === NAME && c.before === "" && c.secret === true));
	}
	const noNames = planWith(sheet(), {});
	check("§1 without names: the Assigned Dates only, broker contacts skipped and said", noNames.p && noNames.p.cells.length === 6 && noNames.p.skipped.filter((s) => /not supplied/.test(s)).length === 4);
	const wrong = planWith(sheet(), { ...NAMES, [fix.FIXES[0].load]: "Someone Else" });
	check("§1 a supplied name with another hash refuses", wrong.err instanceof fix.Refusal && /hash differs/.test(wrong.err.message), wrong.err ? wrong.err.message : "planned");
	const restored = sheet((r) => { const i = rowOf(r, fix.FIXES[0].load); r[i][5] = fix.FIXES[0].original; r[i][3] = NAME; });
	const d = planWith(restored, NAMES);
	check("§1 already restored cells are done", d.p && d.p.cells.length === 8 && d.p.done.length === 2, JSON.stringify(d.p && d.p.done));
	const edited = sheet((r) => { const i = rowOf(r, fix.FIXES[1].load); r[i][5] = "10/9/2026, 8:00:00 AM"; r[i][3] = "Another Contact"; });
	const e = planWith(edited, NAMES);
	check("§1 cells changed since are skipped, never guessed", e.p && e.p.cells.length === 8 && e.p.skipped.length === 2 && e.p.skipped.some((s) => /neither the later email's/.test(s)) && e.p.skipped.some((s) => /filled in since/.test(s)), JSON.stringify(e.p && e.p.skipped));
	const twice = sheet((r) => r.push(["", fix.FIXES[2].load, "dup", "", "", fix.FIXES[2].wrote, ""]));
	const t = planWith(twice, NAMES);
	check("§1 a load on two rows is skipped", t.p && t.p.skipped.some((s) => s.startsWith(`${fix.FIXES[2].load}: 2 rows`)));
	const gone = sheet((r) => { r.splice(rowOf(r, fix.FIXES[3].load), 1); });
	const g = planWith(gone, NAMES);
	check("§1 a load on no row is skipped", g.p && g.p.skipped.some((s) => s.startsWith(`${fix.FIXES[3].load}: 0 rows`)));
	const noCol = planWith([["Load ID", "Details"]], NAMES);
	check("§1 a sheet without the columns refuses", noCol.err instanceof fix.Refusal);
}

// ── §2 unchanged() ────────────────────────────────────────────────────────────
{
	const rows = sheet();
	const { p } = planWith(rows, NAMES);
	check("§2 the same sheet passes", fix.unchanged(rows, p).length === 0);
	const shifted = sheet((r) => r.splice(1, 0, ["", "999", "", "", "", "", ""]));
	check("§2 a row inserted above names the moved row", fix.unchanged(shifted, p).some((s) => /carries load "999"|carries load/.test(s)));
	const changed = sheet((r) => { r[rowOf(r, fix.FIXES[4].load)][5] = "10/9/2026, 9:00:00 AM"; });
	check("§2 a changed cell is named", fix.unchanged(changed, p).some((s) => s.includes(`${fix.FIXES[4].load}'s Assigned Date is "10/9/2026, 9:00:00 AM"`)), JSON.stringify(fix.unchanged(changed, p)));
	const leftCol = sheet((r) => r.forEach((row) => row.splice(2, 0, row === r[0] ? "Inserted" : "")));
	check("§2 a column inserted to the left is named", fix.unchanged(leftCol, p).some((s) => /column F is now "Phone Number", not Assigned Date/.test(s)), JSON.stringify(fix.unchanged(leftCol, p).slice(0, 2)));
	const twoRows = sheet((r) => r.push(["", `#${fix.FIXES[0].load}`, "", "", "", fix.FIXES[0].wrote, ""]));
	const t2 = planWith(twoRows, NAMES);
	check("§2 a second row spelled \"#X\" counts as the same load (skipped)", t2.p && t2.p.skipped.some((x) => x.startsWith(`${fix.FIXES[0].load}: 2 rows`)));
}

// ── §3 the command line ───────────────────────────────────────────────────────
{
	const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "oct-restore-test-"));
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	const dbFile = path.join(tmp, "app.db");
	const db = new Database(dbFile);
	db.exec("CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '');");
	db.exec("CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked', finalized_at TEXT NOT NULL DEFAULT '');");
	db.close();
	const values = path.join(tmp, "jt.json");
	fs.writeFileSync(values, JSON.stringify({ values: sheet() }));
	const out = path.join(tmp, "out.json");
	const run = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", input, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || "" } });
	const refusals = [
		["an unknown option", ["--db", dbFile, "--dry-run", "--force"], /unknown option/],
		["neither --dry-run nor --apply", ["--db", dbFile, "--values-json", values], /--dry-run or --apply/],
		["both --dry-run and --apply", ["--db", dbFile, "--values-json", values, "--dry-run", "--apply"], /--dry-run or --apply/],
		["no --db", ["--values-json", values, "--dry-run"], /--db is required/],
		["no sheet", ["--db", dbFile, "--dry-run"], /--sheet-id \(or --values-json\) is required/],
		["an apply without --expect-cells", ["--db", dbFile, "--values-json", values, "--values-out", out, "--apply"], /--apply needs --expect-cells/],
		["a rehearsal apply without --values-out", ["--db", dbFile, "--values-json", values, "--apply", "--expect-cells", "6"], /needs --values-out/],
		["a database outside the app directory and the temp directory", ["--db", path.join(ROOT, "scripts", "app.db"), "--values-json", values, "--dry-run"], /opens its own app directory's database/],
	];
	for (const [name, args, re] of refusals) {
		const r = run(args);
		check(`§3 refuses ${name}`, r.status === 2 && re.test(r.stderr), `exit ${r.status}: ${r.stderr.trim().slice(0, 200)}`);
	}
	// The real hashes are not the test name's, so this rehearsal restores the six
	// Assigned Dates and skips the broker contacts (no names supplied).
	const dry = run(["--db", dbFile, "--values-json", values, "--dry-run"]);
	check("§3 a dry run plans six cells and writes nothing", dry.status === 0 && /6 cell\(s\) would be written/.test(dry.stdout) && !fs.existsSync(out), dry.stderr || dry.stdout.slice(-300));
	const wrongCount = run(["--db", dbFile, "--values-json", values, "--values-out", out, "--apply", "--expect-cells", "5"]);
	check("§3 a wrong --expect-cells refuses and writes nothing", wrongCount.status === 2 && !fs.existsSync(out));
	const apply = run(["--db", dbFile, "--values-json", values, "--values-out", out, "--apply", "--expect-cells", "6"]);
	check("§3 a rehearsal apply restores the cells", apply.status === 0 && /Read back: each of the 6 cell/.test(apply.stdout), apply.stderr || apply.stdout.slice(-300));
	const after = JSON.parse(fs.readFileSync(out, "utf8")).values;
	check("§3 every Assigned Date is the first email's", fix.FIXES.every((f) => after[rowOf(after, f.load)][5] === f.original));
	check("§3 the other load is untouched", JSON.stringify(after[1]) === JSON.stringify(sheet()[1]));
	const rows = new Database(dbFile, { readonly: true }).prepare("SELECT * FROM audit_trail").all();
	check("§3 one audit row per cell, as a system change", rows.length === 6 && rows.every((r) => r.username === fix.ACTOR && r.role === "system" && r.user_id === 0 && r.details.includes(`[${fix.REF}]`)));
	const again = run(["--db", dbFile, "--values-json", out, "--values-out", path.join(tmp, "out2.json"), "--apply", "--expect-cells", "6"]);
	check("§3 a second apply without the names writes nothing and says the broker cells are skipped (exit 2)", again.status === 2 && /NOTHING WRITTEN: 4 fix/.test(again.stderr) && new Database(dbFile, { readonly: true }).prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n === 6, `${again.status} ${again.stderr}`);
	const badJson = run(["--db", dbFile, "--values-json", values, "--dry-run", "--names-stdin"], "not json");
	check("§3 --names-stdin with bad JSON refuses", badJson.status === 2 && /not a JSON object/.test(badJson.stderr));
	const wrongName = run(["--db", dbFile, "--values-json", values, "--dry-run", "--names-stdin"], JSON.stringify({ [fix.FIXES[0].load]: "Not The Contact" }));
	check("§3 --names-stdin with a name whose hash differs refuses, and prints no name", wrongName.status === 2 && /hash differs/.test(wrongName.stderr) && !/Not The Contact/.test(wrongName.stdout + wrongName.stderr));
	const appDb = run(["--db", path.join(ROOT, "app.db"), "--values-json", values, "--values-out", out, "--apply", "--expect-cells", "6"]);
	check("§3 a rehearsal apply with the app's own database refuses", appDb.status === 2 && /only with a copy of the database/.test(appDb.stderr), appDb.stderr);
	const lockDb = new Database(dbFile);
	lockDb.prepare("INSERT INTO period_locks (period, status) VALUES ('2026-10', 'locked')").run();
	lockDb.close();
	const locked = run(["--db", dbFile, "--values-json", values, "--dry-run"]);
	check("§3 a finalized October refuses", locked.status === 2 && /2026-10 is finalized/.test(locked.stderr));
	fs.rmSync(tmp, { recursive: true, force: true });
}

// ── §4 main() in process: names, the read-back, the audit rows ────────────────
(async () => {
	const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "oct-restore-main-"));
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	const freshDb = (name) => {
		const f = path.join(tmp, name);
		const d = new Database(f);
		d.exec("CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '');");
		d.exec("CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked', finalized_at TEXT NOT NULL DEFAULT '');");
		d.close();
		return f;
	};
	const audits = (f) => new Database(f, { readonly: true }).prepare("SELECT * FROM audit_trail ORDER BY id").all();
	const capture = () => { const lines = []; return { lines, log: (x) => lines.push(String(x)), err: (x) => lines.push(String(x)) }; };
	const opts = (c, extra) => ({ fixes: withHash(), stdin: JSON.stringify(NAMES), log: c.log, err: c.err, ...extra });
	// A rehearsal with the names: all ten cells.
	{
		const db = freshDb("a.db");
		const values = path.join(tmp, "a.json");
		fs.writeFileSync(values, JSON.stringify({ values: sheet() }));
		const c = capture();
		const code = await fix.main(["--db", db, "--values-json", values, "--values-out", path.join(tmp, "a-out.json"), "--apply", "--expect-cells", "10", "--names-stdin"], opts(c));
		const rows = audits(db);
		check("§4 ten cells with the names: written and confirmed", code === 0 && rows.length === 10 && c.lines.some((l) => /each of the 10 cell/.test(l)), c.lines.slice(-3).join(" | "));
		check("§4 no name in the output or the audit rows", !c.lines.join("\n").includes(NAME) && rows.every((r) => !r.details.includes(NAME)));
		const out = JSON.parse(fs.readFileSync(path.join(tmp, "a-out.json"), "utf8")).values;
		check("§4 the broker contacts are restored", fix.FIXES.filter((f) => f.broker).every((f) => out[rowOf(out, f.load)][3] === NAME));
	}
	// Against a stand-in Sheets client: what the sheet reads back.
	const stub = (rows, { afterWrite = null, getFailsAfterWrite = false, updated = null } = {}) => {
		let wrote = false;
		let current = rows;
		return {
			spreadsheets: { values: {
				get: async () => { if (wrote && getFailsAfterWrite) throw new Error("rate limited"); return { data: { values: current } }; },
				batchUpdate: async (q) => {
					wrote = true;
					current = afterWrite ? afterWrite(current, q) : current;
					return { data: { totalUpdatedCells: updated == null ? q.requestBody.data.length : updated } };
				},
			} },
		};
	};
	const reformat = (rows) => rows.map((r, i) => (i === 0 ? r : r.map((v, j) => (j === 5 && /,/.test(v) ? v.replace(",", "") : v))));
	{
		const db = freshDb("b.db");
		const c = capture();
		const code = await fix.main(["--db", db, "--sheet-id", "test-sheet", "--apply", "--expect-cells", "10", "--names-stdin"], opts(c, { sheets: stub(sheet(), { afterWrite: (rows) => reformat(rows) }) }));
		check("§4 a read-back that doesn't hold the restored value exits 5 and names the cells", code === 5 && c.lines.some((l) => /READ BACK does not confirm/.test(l) && /Assigned Date is "/.test(l)), c.lines.slice(-2).join(" | "));
		check("§4 the audit rows record what was written, before the read-back", audits(db).length === 10);
	}
	{
		const db = freshDb("c.db");
		const c = capture();
		let threw = null;
		try { await fix.main(["--db", db, "--sheet-id", "test-sheet", "--apply", "--expect-cells", "10", "--names-stdin"], opts(c, { sheets: stub(sheet(), { getFailsAfterWrite: true }) })); } catch (err) { threw = err; }
		check("§4 a read-back that fails after the write: the error surfaces, the audit rows are already written", threw && /rate limited/.test(threw.message) && audits(db).length === 10);
	}
	{
		const db = freshDb("d.db");
		const c = capture();
		const code = await fix.main(["--db", db, "--sheet-id", "test-sheet", "--apply", "--expect-cells", "10", "--names-stdin"], opts(c, { sheets: stub(sheet(), { updated: 9 }) }));
		check("§4 a write reporting fewer updated cells exits 5", code === 5 && c.lines.some((l) => /reported 9 updated cell/.test(l)));
	}
	{
		// Cells restored by an earlier run whose audit rows are missing get them.
		const db = freshDb("e.db");
		const restored = sheet((r) => { for (const f of fix.FIXES) { const i = rowOf(r, f.load); r[i][5] = f.original; if (f.broker) r[i][3] = NAME; } });
		const c = capture();
		const code = await fix.main(["--db", db, "--sheet-id", "test-sheet", "--apply", "--expect-cells", "0"], opts(c, { sheets: stub(restored) }));
		const rows = audits(db);
		check("§4 a re-run adds an audit row for each cell found restored without one", code === 0 && rows.length === 10 && rows.every((r) => /found restored with no audit row/.test(r.details)), `${code} ${rows.length}`);
		const again = await fix.main(["--db", db, "--sheet-id", "test-sheet", "--apply", "--expect-cells", "0"], opts(capture(), { sheets: stub(restored) }));
		check("§4 and not twice", again === 0 && audits(db).length === 10);
	}
	{
		// The app's own database ties the sheet to the app (a stand-in app root).
		const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "oct-restore-root-"));
		fs.mkdirSync(path.join(root, "lib"));
		fs.copyFileSync(path.join(ROOT, "lib", "sheet-id.js"), path.join(root, "lib", "sheet-id.js"));
		fs.writeFileSync(path.join(root, "server.js"), "");
		fs.writeFileSync(path.join(root, ".env"), "SPREADSHEET_ID=own-sheet\n");
		fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(root, "node_modules"));
		fs.copyFileSync(freshDb("f.db"), path.join(root, "app.db"));
		let err = null;
		try { await fix.main(["--db", path.join(root, "app.db"), "--sheet-id", "another-sheet", "--dry-run"], opts(capture(), { root, sheets: stub(sheet()) })); } catch (e) { err = e; }
		check("§4 with the app's own database, another app's sheet refuses", err instanceof fix.Refusal && /not this app's own sheet/.test(err.message), err && err.message);
		const ok = await fix.main(["--db", path.join(root, "app.db"), "--sheet-id", "own-sheet", "--dry-run"], opts(capture(), { root, sheets: stub(sheet()) }));
		check("§4 and its own sheet runs", ok === 0);
		fs.rmSync(root, { recursive: true, force: true });
	}
	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(`test-data-fix-october-later-emails: ${passes} passed, ${failures} failed`);
	process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
