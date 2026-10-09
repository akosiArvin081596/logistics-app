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
 *      writes nothing.
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
	const rows = [HEADER, ["", "100", "other load", "Someone", "", "10/2/2026, 1:00:00 PM", "$1"]];
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
	check("§2 a row inserted above names the moved row", fix.unchanged(shifted, p).some((s) => /no longer carries load/.test(s)));
	const changed = sheet((r) => { r[rowOf(r, fix.FIXES[4].load)][5] = "10/9/2026, 9:00:00 AM"; });
	check("§2 a changed cell is named", fix.unchanged(changed, p).some((s) => s === `${fix.FIXES[4].load}'s Assigned Date changed since the plan`));
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
	check("§3 a rehearsal apply restores the cells", apply.status === 0 && /Read back: every planned cell/.test(apply.stdout), apply.stderr || apply.stdout.slice(-300));
	const after = JSON.parse(fs.readFileSync(out, "utf8")).values;
	check("§3 every Assigned Date is the first email's", fix.FIXES.every((f) => after[rowOf(after, f.load)][5] === f.original));
	check("§3 the other load is untouched", JSON.stringify(after[1]) === JSON.stringify(sheet()[1]));
	const rows = new Database(dbFile, { readonly: true }).prepare("SELECT * FROM audit_trail").all();
	check("§3 one audit row per cell, as a system change", rows.length === 6 && rows.every((r) => r.username === fix.ACTOR && r.role === "system" && r.user_id === 0 && r.details.includes(`[${fix.REF}]`)));
	const again = run(["--db", dbFile, "--values-json", out, "--values-out", path.join(tmp, "out2.json"), "--apply", "--expect-cells", "6"]);
	check("§3 a second apply writes nothing", again.status === 0 && /Nothing to write/.test(again.stdout) && new Database(dbFile, { readonly: true }).prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n === 6);
	const lockDb = new Database(dbFile);
	lockDb.prepare("INSERT INTO period_locks (period, status) VALUES ('2026-10', 'locked')").run();
	lockDb.close();
	const locked = run(["--db", dbFile, "--values-json", values, "--dry-run"]);
	check("§3 a finalized October refuses", locked.status === 2 && /2026-10 is finalized/.test(locked.stderr));
	fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`test-data-fix-october-later-emails: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
