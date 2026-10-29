#!/usr/bin/env node
/**
 * scripts/backup-trees.sh (nightly on-box copies of uploads/, storage/ and
 * evidence-archive/) and its call from backup.sh, run for real on made-up trees
 * in a mkdtemp folder. df and today's date are stubbed; rsync is this machine's
 * own, and the first lines say which one ran.
 *
 *   §1 the first night copies everything, byte for byte, modes kept, the two
 *      receipt caches left out and voice notes in.
 *   §2 an unchanged file is one inode with the night before; a changed one isn't.
 *   §3 a deleted file stays in the older nights.
 *   §4 pruning keeps the newest N, never fewer than the newest 3, and leaves
 *      every other name alone (other folders, a file or a link with a night's
 *      name, and what a link points at).
 *   §5 the free-space floor, max(5 GiB, 10% of the disk), skips the night
 *      (stubbed df), also when a full copy would cross it: exit 1, nothing changed.
 *   §6 backups/trees/ and each night are 0700, a reused .in-progress included.
 *   §7 without the switch file nothing runs: no output, nothing written, and
 *      backup.sh prints what it printed before; no --app-dir is exit 2.
 *   §8 backup.sh: when only the tree step fails it exits non-zero and keeps the
 *      database snapshot, and the freshness check still reads the database run
 *      as good; when the database step fails (or no node loads better-sqlite3)
 *      it keeps that exit code and the tree copies still run.
 *   §9 backup-db.js's retention leaves backups/trees/ and the switch file alone.
 *   §10 a linked backups/, backups/trees/ or .in-progress is refused: exit 1,
 *      nothing changed on either side of the link.
 *   §11 the script's header holds the restore steps and says a deleted file
 *      stays in the copies up to the keep window.
 *   §12 a second run the same day leaves tonight's copy as it is; a clock
 *      behind the newest names never prunes tonight's copy; an rsync failure
 *      keeps no night and prunes nothing, and the next run finishes it; a bad
 *      keep line or a missing tree changes nothing.
 *   §13 mutants: each safety part, broken on purpose, must turn a case red.
 *
 * Cases that need GNU tools are skipped, by name, where they are missing (the
 * box and CI run GNU rsync and coreutils).
 *
 *   node scripts/test-backup-trees.js     # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "backup-trees.sh");
const BACKUP_SH = path.join(ROOT, "backup.sh");
const BACKUP_DB = path.join(ROOT, "scripts", "backup-db.js");
const CHECK = path.join(ROOT, "scripts", "deploy", "remote-backup-check.sh");

const T = fs.mkdtempSync(path.join(os.tmpdir(), "backup-trees-"));
process.on("exit", () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* temp space */ } });

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const ino = (p) => { try { return fs.statSync(p).ino; } catch { return null; } };
const mode = (p) => { try { return (fs.statSync(p).mode & 0o777).toString(8); } catch { return null; } };
const put = (p, body, m) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); if (m) fs.chmodSync(p, m); };

// ------------------------------------------------------------------ runner
let pass = 0;
const failures = [];
const skipped = [];
const R = {
	ok(cond, label) {
		if (cond) { pass++; console.log(`  ok    ${label}`); return; }
		failures.push(label); console.log(`  FAIL  ${label}`);
	},
	eq(actual, expected, label) {
		const a = JSON.stringify(actual), e = JSON.stringify(expected);
		R.ok(a === e, a === e ? label : `${label}\n          expected ${e}\n          actual   ${a}`);
	},
	skip(label) { skipped.push(label); console.log(`  SKIP  ${label}`); },
};
// A silent recorder for the mutants: counts the assertions a mutant breaks.
function recorder() {
	let bad = 0, skips = 0;
	return {
		ok(cond) { if (!cond) bad++; },
		eq(a, e) { if (JSON.stringify(a) !== JSON.stringify(e)) bad++; },
		skip() { skips++; },
		bad: () => bad,
		skips: () => skips,
	};
}

// ------------------------------------------------------------------ tools
const which = (cmd) => {
	const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : "";
};
const RSYNC = which("rsync");
const RSYNC_VERSION = RSYNC ? (spawnSync(RSYNC, ["--version"], { encoding: "utf8" }).stdout || "").split("\n")[0].trim() : "";
const OPENRSYNC = /openrsync/i.test(RSYNC_VERSION);
const GNU_STAT = spawnSync("stat", ["-c", "%Y", T], { encoding: "utf8" }).status === 0;
const BASH_VERSION = (spawnSync("bash", ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).stdout || "").split("\n")[0].trim();
const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

// Stubs first on PATH: df reports the disk the case asks for, date answers the
// night the case asks for (anything else goes to the real date), and pm2 lists
// no process, so backup.sh never reaches a real pm2.
const STUB = path.join(T, "stub-bin");
put(path.join(STUB, "df"), [
	"#!/bin/sh",
	"echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
	'echo "stubfs $STUB_DF_TOTAL_KIB $((STUB_DF_TOTAL_KIB - STUB_DF_AVAIL_KIB)) $STUB_DF_AVAIL_KIB 50% /"',
	"",
].join("\n"), 0o755);
put(path.join(STUB, "date"), [
	"#!/bin/sh",
	'if [ "$#" -eq 2 ] && [ "$1" = "-u" ] && [ "$2" = "+%Y%m%d" ] && [ -n "${STUB_NIGHT:-}" ]; then echo "$STUB_NIGHT"; exit 0; fi',
	'exec /bin/date "$@"',
	"",
].join("\n"), 0o755);
put(path.join(STUB, "pm2"), "#!/bin/sh\necho '[]'\n", 0o755);
if (RSYNC) fs.symlinkSync(RSYNC, path.join(STUB, "rsync"));

const GIB = 1024 * 1024; // in KiB, the unit df -Pk reports
const ROOMY = { total: 100 * GIB, avail: 80 * GIB };

function env(night, df, extraPath = "") {
	return {
		PATH: `${STUB}${extraPath ? `:${extraPath}` : ""}:/usr/bin:/bin`,
		HOME: T, TMPDIR: T, LANG: "C", LC_ALL: "C",
		STUB_NIGHT: night, STUB_DF_TOTAL_KIB: String(df.total), STUB_DF_AVAIL_KIB: String(df.avail),
	};
}
function runTrees(script, app, { night = "20261001", df = ROOMY, args, umask } = {}) {
	const argv = args || [`--app-dir=${app}`];
	const r = umask
		? spawnSync("bash", ["-c", `umask ${umask}; exec bash "$0" "$@"`, script, ...argv], { env: env(night, df), encoding: "utf8", timeout: 60000 })
		: spawnSync("bash", [script, ...argv], { env: env(night, df), encoding: "utf8", timeout: 60000 });
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

// Every path under `dir` with its type, mode, inode, size and mtime: equal
// before and after means the run changed nothing there.
function snapshot(dir) {
	const r = spawnSync("find", [dir], { encoding: "utf8" });
	if (r.status !== 0) return `find failed: ${r.stderr}`;
	return r.stdout.split("\n").filter(Boolean).sort().map((p) => {
		try {
			const s = fs.lstatSync(p);
			const kind = s.isSymbolicLink() ? "l" : s.isDirectory() ? "d" : "f";
			return `${path.relative(dir, p)} ${kind} ${(s.mode & 0o7777).toString(8)} ${s.ino} ${s.size} ${s.mtimeMs}`;
		} catch { return `${p} vanished`; }
	}).join("\n");
}

// ------------------------------------------------------------------ fixtures
let seq = 0;
const fresh = (tag) => { const d = path.join(T, `${tag}-${++seq}`); fs.mkdirSync(d, { recursive: true }); return d; };
const FILES = {
	"uploads/expense-receipts/receipt-0001.jpg": "made-up receipt 1",
	"uploads/chat/chat-0001.txt": "made-up chat file",
	"uploads/onboarding-signed/w9-sample-0001.pdf": "%PDF-1.4 made-up signed form",
	"storage/voice-notes/vn_1_0123456789abcdef.m4a": "made-up voice note",
	"storage/statements/statement-0001.pdf": "%PDF-1.4 made-up statement",
	"evidence-archive/signed-artifacts/artifact-0001.json": "{\"sample\":true}",
};
const CACHES = {
	"storage/receipt-images/cache-0001.jpg": "made-up cache",
	"storage/receipt-pdfs/cache-0001.pdf": "made-up cache",
};
const enable = (app, body = "") => put(path.join(app, "backups", ".trees-enabled"), body, 0o600);
const treesOf = (app) => path.join(app, "backups", "trees");
const nightOf = (app, d) => path.join(treesOf(app), d);
function makeApp(tag, { keep } = {}) {
	const app = fresh(tag);
	for (const [rel, body] of Object.entries({ ...FILES, ...CACHES })) put(path.join(app, rel), body);
	fs.mkdirSync(path.join(app, "backups"), { mode: 0o700 });
	if (keep !== undefined) enable(app, keep === null ? "" : `keep=${keep}\n`);
	return app;
}
function oldNights(dir, names) {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const d of names) put(path.join(dir, d, "marker.txt"), d);
}
const SEPT = Array.from({ length: 10 }, (_, i) => `202609${String(i + 1).padStart(2, "0")}`);

// ------------------------------------------------------------------ §1
function caseFirstNight(script, c) {
	const app = makeApp("first", { keep: null });
	fs.chmodSync(path.join(app, "uploads/onboarding-signed/w9-sample-0001.pdf"), 0o640);
	const r = runTrees(script, app, { night: "20261001" });
	const n = nightOf(app, "20261001");
	c.eq(r.code, 0, "§1 the first night exits 0");
	c.ok(Object.entries(FILES).every(([rel, body]) => read(path.join(n, rel)) === body),
		"§1 every file of uploads/, storage/ (voice notes included) and evidence-archive/ is in the night, byte for byte");
	c.ok(!exists(path.join(n, "storage/receipt-images")) && !exists(path.join(n, "storage/receipt-pdfs")),
		"§1 storage/receipt-images/ and storage/receipt-pdfs/ are left out");
	c.eq(mode(path.join(n, "uploads/onboarding-signed/w9-sample-0001.pdf")), "640", "§1 -a keeps a file's mode");
	c.ok(!exists(path.join(treesOf(app), ".in-progress")), "§1 nothing is left in .in-progress");
	c.ok(/ keep 14 /.test(r.out), "§1 an empty switch file keeps 14 nights");
	c.ok(/OK: night 20261001/.test(r.out), "§1 the log ends OK");
	c.ok(Object.entries({ ...FILES, ...CACHES }).every(([rel, body]) => read(path.join(app, rel)) === body),
		"§1 the trees themselves are untouched");
}

// ------------------------------------------------------------------ §2
function caseInodes(script, c) {
	const app = makeApp("inodes", { keep: 14 });
	const same = "uploads/expense-receipts/receipt-0001.jpg";
	const changed = "storage/statements/statement-0001.pdf";
	const r1 = runTrees(script, app, { night: "20261001" });
	put(path.join(app, changed), "%PDF-1.4 made-up statement, corrected");
	const r2 = runTrees(script, app, { night: "20261002" });
	const n1 = nightOf(app, "20261001"), n2 = nightOf(app, "20261002");
	c.ok(r1.code === 0 && r2.code === 0, `§2 two nights run (exit ${r1.code}, ${r2.code})`);
	c.ok(ino(path.join(n1, same)) !== null && ino(path.join(n1, same)) === ino(path.join(n2, same)),
		"§2 an unchanged file is one inode in both nights (a hard link)");
	c.ok(ino(path.join(n1, changed)) !== null && ino(path.join(n2, changed)) !== null
		&& ino(path.join(n1, changed)) !== ino(path.join(n2, changed)), "§2 a changed file is a new inode");
	c.eq(read(path.join(n1, changed)), FILES[changed], "§2 the older night keeps the file as it was");
	c.eq(read(path.join(n2, changed)), "%PDF-1.4 made-up statement, corrected", "§2 tonight holds the new content");
	c.ok(/hard-linked to 20261001/.test(r2.out), "§2 the log names the night it linked to");
}

// ------------------------------------------------------------------ §3
function caseDeleted(script, c) {
	const app = makeApp("deleted", { keep: 14 });
	const voice = "storage/voice-notes/vn_1_0123456789abcdef.m4a";
	const upload = "uploads/chat/chat-0001.txt";
	const r1 = runTrees(script, app, { night: "20261001" });
	fs.unlinkSync(path.join(app, voice));
	fs.unlinkSync(path.join(app, upload));
	const r2 = runTrees(script, app, { night: "20261002" });
	const n1 = nightOf(app, "20261001"), n2 = nightOf(app, "20261002");
	c.ok(r1.code === 0 && r2.code === 0, `§3 two nights run (exit ${r1.code}, ${r2.code})`);
	c.ok(exists(n2) && !exists(path.join(n2, voice)) && !exists(path.join(n2, upload)),
		"§3 tonight's copy matches the tree: the deleted files are not in it");
	c.ok(read(path.join(n1, voice)) === FILES[voice] && read(path.join(n1, upload)) === FILES[upload],
		"§3 the older night still holds the deleted voice note and upload");
}

// ------------------------------------------------------------------ §4
function casePrune(script, c) {
	const app = makeApp("prune", { keep: 5 });
	const trees = treesOf(app);
	oldNights(trees, SEPT);
	const OTHER = ["notes", "2026-09-01", "20261332", "202609011", "0-old"];
	oldNights(trees, OTHER);
	put(path.join(trees, "20260815"), "a file with a night's name");
	const outside = fresh("prune-outside");
	put(path.join(outside, "marker.txt"), "outside");
	fs.symlinkSync(outside, path.join(trees, "20260816"));
	const othersIntact = () => OTHER.every((d) => read(path.join(trees, d, "marker.txt")) === d)
		&& read(path.join(trees, "20260815")) === "a file with a night's name"
		&& isLink(path.join(trees, "20260816")) && read(path.join(outside, "marker.txt")) === "outside";

	const r = runTrees(script, app, { night: "20261010" });
	c.eq(r.code, 0, "§4 keep=5: the night exits 0");
	c.ok(["20261010", "20260910", "20260909", "20260908", "20260907"].every((d) => exists(path.join(trees, d))),
		"§4 keep=5: tonight and the 4 newest older nights are kept");
	c.ok(SEPT.slice(0, 6).every((d) => !exists(path.join(trees, d))), "§4 keep=5: the 6 older nights are pruned");
	c.ok(othersIntact(), "§4 other folders, a file and a link with a night's name, and the link's target, are left alone");
	c.ok(/left alone \(not a night folder\):/.test(r.out) && OTHER.every((d) => r.out.includes(d)),
		"§4 the names left alone are listed in the log");

	enable(app, "keep=1\n");
	const r2 = runTrees(script, app, { night: "20261011" });
	c.eq(r2.code, 0, "§4 keep=1: the night exits 0");
	c.ok(["20261011", "20261010", "20260910"].every((d) => exists(path.join(trees, d))),
		"§4 keep=1: the newest 3 are kept all the same");
	c.ok(["20260909", "20260908", "20260907"].every((d) => !exists(path.join(trees, d))),
		"§4 keep=1: nights older than the newest 3 are pruned");
	c.ok(othersIntact(), "§4 keep=1: the other names are still left alone");
}

// ------------------------------------------------------------------ §5
function caseFloor(script, c) {
	const trial = (label, df) => {
		const app = makeApp("floor", { keep: 3 });
		oldNights(treesOf(app), SEPT.slice(0, 5));
		const before = snapshot(app);
		const r = runTrees(script, app, { night: "20261001", df });
		c.eq(r.code, 1, `§5 ${label}: exit 1`);
		c.ok(/\[backup-trees\] night FAILED: .*night skipped/.test(r.out), `§5 ${label}: the log says the night FAILED and was skipped`);
		c.ok(snapshot(app) === before, `§5 ${label}: nothing changed (no night, no .in-progress, nothing pruned)`);
	};
	trial("free space under 10% of a 100 GiB disk", { total: 100 * GIB, avail: 9 * GIB });
	trial("free space under the 5 GiB minimum on a 40 GiB disk (10% would be 4 GiB)", { total: 40 * GIB, avail: 4.5 * GIB });
	trial("a full copy would cross the floor", { total: 100 * GIB, avail: 10 * GIB + 1 });
	const app = makeApp("floor-ok", { keep: 3 });
	const ok = runTrees(script, app, { night: "20261001", df: { total: 100 * GIB, avail: 11 * GIB } });
	c.ok(ok.code === 0 && exists(nightOf(app, "20261001")), "§5 control: 1 GiB above the floor, the night runs");
}

// ------------------------------------------------------------------ §6
function caseModes(script, c) {
	const app = makeApp("modes", { keep: 14 });
	const trees = treesOf(app);
	fs.mkdirSync(trees, { mode: 0o755 });
	fs.chmodSync(trees, 0o755);
	const work = path.join(trees, ".in-progress");
	put(path.join(work, "uploads", "stale-from-an-earlier-run.txt"), "stale");
	fs.chmodSync(work, 0o755);
	const r = runTrees(script, app, { night: "20261001", umask: "022" });
	const n = nightOf(app, "20261001");
	c.eq(r.code, 0, "§6 the night exits 0");
	c.eq(mode(trees), "700", "§6 backups/trees/ is 0700 (it was 0755)");
	c.eq(mode(n), "700", "§6 the night's folder is 0700 (its .in-progress was 0755)");
	c.ok(/reusing backups\/trees\/\.in-progress/.test(r.out) && !exists(path.join(n, "uploads", "stale-from-an-earlier-run.txt"))
		&& read(path.join(n, "uploads/chat/chat-0001.txt")) === FILES["uploads/chat/chat-0001.txt"],
	"§6 a reused .in-progress ends up matching the tree");

	const app2 = makeApp("modes-new", { keep: 14 });
	const r2 = runTrees(script, app2, { night: "20261001", umask: "022" });
	c.eq(r2.code, 0, "§6 a first run under umask 022 exits 0");
	c.eq([mode(treesOf(app2)), mode(nightOf(app2, "20261001"))], ["700", "700"],
		"§6 a first run under umask 022 creates backups/trees/ and the night at 0700");
}

// ------------------------------------------------------------------ §7
function caseSwitch(script, c, backupSh) {
	const app = makeApp("off");
	const before = snapshot(app);
	const r = runTrees(script, app, { night: "20261001" });
	c.eq(r.code, 0, "§7 no switch file: exit 0");
	c.eq(r.out, "", "§7 no switch file: no output");
	c.ok(snapshot(app) === before && !exists(treesOf(app)), "§7 no switch file: nothing written, no backups/trees/");

	const usage = runTrees(script, app, { args: [] });
	c.ok(usage.code === 2 && /--app-dir/.test(usage.out), "§7 no --app-dir: exit 2, naming --app-dir");

	const b = makeBackupApp("off-backup", { script, backupSh, switchOn: false });
	if (!b) { c.ok(false, "§7 backup.sh's APP_DIR line was found to point it at the temp folder"); return; }
	const run = runBackupSh(b, { night: "20261001" });
	const lines = run.out.trim().split("\n");
	c.eq(run.code, 0, "§7 backup.sh with no switch file: exit 0");
	c.ok(!/backup-trees|tree copies/.test(run.out) && /^\[backup\] completed: /.test(lines[lines.length - 1] || ""),
		"§7 backup.sh with no switch file prints what it printed before: no tree line, completed last");
	c.ok(!!snapshotFile(b) && !exists(treesOf(b)), "§7 backup.sh with no switch file: the database snapshot, no backups/trees/");
}

// ------------------------------------------------------------------ §8
// backup.sh points at a production folder, so it runs from a copy whose APP_DIR
// line is the temp app (the only change); without that line it does not run.
function makeBackupApp(tag, { script, backupSh, switchOn = true, modules = true, db = true }) {
	const app = makeApp(tag, switchOn ? { keep: 14 } : {});
	const sh = String(backupSh || "").replace(/^APP_DIR="[^"\n]*"$/m, () => `APP_DIR="${app}"`);
	if (sh === String(backupSh || "")) return null;
	put(path.join(app, "backup.sh"), sh, 0o755);
	fs.mkdirSync(path.join(app, "scripts"));
	fs.copyFileSync(BACKUP_DB, path.join(app, "scripts", "backup-db.js"));
	if (exists(script)) fs.copyFileSync(script, path.join(app, "scripts", "backup-trees.sh"));
	if (modules) fs.symlinkSync(fs.realpathSync(path.join(ROOT, "node_modules")), path.join(app, "node_modules"));
	if (db) {
		const Database = require("better-sqlite3");
		const d = new Database(path.join(app, "app.db"));
		d.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO sample (note) VALUES ('made-up row');");
		d.close();
		fs.chmodSync(path.join(app, "app.db"), 0o600);
	}
	return app;
}
function runBackupSh(app, { night, df = ROOMY }) {
	const r = spawnSync("bash", ["-c", 'exec bash "$0" 2>&1', path.join(app, "backup.sh")],
		{ env: env(night, df, path.dirname(process.execPath)), encoding: "utf8", timeout: 60000 });
	put(path.join(app, "backups", "backup.log"), r.stdout || "", 0o600);
	return { code: r.status, out: r.stdout || "" };
}
function snapshotFile(app) {
	const r = spawnSync("find", [path.join(app, "backups"), "-maxdepth", "1", "-name", "app.db.*.gz"], { encoding: "utf8" });
	return (r.stdout || "").split("\n").filter(Boolean)[0] || null;
}
const isSqliteGz = (p) => { try { return zlib.gunzipSync(fs.readFileSync(p)).subarray(0, 16).toString("latin1") === "SQLite format 3\u0000"; } catch { return false; } };
const FAILED_RE = ((read(CHECK) || "").match(/^FAILED_RE='([^']+)'$/m) || [])[1] || "";
const failedLines = (text) => {
	const r = spawnSync("grep", ["-E", FAILED_RE || "^$"], { input: text, encoding: "utf8" });
	return (r.stdout || "").split("\n").filter(Boolean);
};
function freshness(app) {
	const r = spawnSync("bash", [CHECK], { env: { PATH: "/usr/bin:/bin", DIR: app, MIN_BYTES: "1", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 30000 });
	const get = (k) => ((r.stdout || "").match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1];
	return { lastOk: get("BACKUP_LAST_RUN_OK"), fails: get("BACKUP_TOTAL_FAILURES"), state: get("BACKUP_STATE") };
}

function caseBackupTreesFail(script, c, backupSh) {
	const app = makeBackupApp("bk-trees-fail", { script, backupSh });
	if (!app) { c.ok(false, "§8 backup.sh's APP_DIR line was found to point it at the temp folder"); return; }
	const run = runBackupSh(app, { night: "20261001", df: { total: 100 * GIB, avail: 9 * GIB } });
	const gz = snapshotFile(app);
	c.eq(run.code, 1, "§8 only the tree step fails: backup.sh exits 1");
	c.ok(!!gz && isSqliteGz(gz), "§8 …and the database snapshot is kept, a gzipped SQLite file");
	c.ok(/^\[backup\] completed: /m.test(run.out) && /^\[backup-trees\] night FAILED: /m.test(run.out)
		&& /^\[backup\] tree copies FAILED with exit code 1 /m.test(run.out),
	"§8 …the log says the database completed and the tree copies FAILED");
	c.ok(!!FAILED_RE && failedLines(run.out).length === 0,
		"§8 …and no line matches remote-backup-check.sh's database-failure pattern");
	const f = freshness(app);
	c.ok(f.lastOk === "yes" && f.fails === "0", `§8 …so the freshness check reads the database run as good (last ok ${f.lastOk}, failures ${f.fails})`);
	if (GNU_STAT) c.eq(f.state, "fresh", "§8 …and calls the snapshot fresh");
	else c.skip("§8 the freshness check calls the snapshot fresh (needs GNU stat; CI runs it)");
}
function caseBackupDbFail(script, c, backupSh) {
	const app = makeBackupApp("bk-db-fail", { script, backupSh, db: false });
	if (!app) { c.ok(false, "§8 backup.sh's APP_DIR line was found to point it at the temp folder"); return; }
	// An earlier night's snapshot, so the freshness check gets as far as the log.
	put(path.join(app, "backups", "app.db.20261001_000000.gz"), zlib.gzipSync("made-up earlier snapshot"), 0o600);
	const run = runBackupSh(app, { night: "20261001" });
	c.eq(run.code, 1, "§8 the database step fails: backup.sh keeps its exit code (1)");
	c.ok(/^\[backup\] backup FAILED with exit code 1$/m.test(run.out), "§8 …and says so as before");
	c.ok(exists(nightOf(app, "20261001")) && /OK: night 20261001/.test(run.out), "§8 …and the tree copies still ran");
	const f = freshness(app);
	c.eq(f.lastOk, "no", "§8 …and the freshness check still reads the run as failed");
}
function caseBackupNoNode(script, c, backupSh) {
	const app = makeBackupApp("bk-no-node", { script, backupSh, modules: false });
	if (!app) { c.ok(false, "§8 backup.sh's APP_DIR line was found to point it at the temp folder"); return; }
	const run = runBackupSh(app, { night: "20261001" });
	c.eq(run.code, 1, "§8 no node loads better-sqlite3: backup.sh exits 1 as before");
	c.ok(/^\[backup\] FAILED: no node on this box can load better-sqlite3/m.test(run.out), "§8 …and says so as before");
	c.ok(exists(nightOf(app, "20261001")), "§8 …and the tree copies still ran (they need no node)");
}

// ------------------------------------------------------------------ §9
function caseRetention(script, c) {
	const app = makeApp("retention", { keep: 14 });
	const r1 = runTrees(script, app, { night: "20261001" });
	put(path.join(app, "uploads/chat/chat-0002.txt"), "made-up chat file 2");
	const r2 = runTrees(script, app, { night: "20261002" });
	c.ok(r1.code === 0 && r2.code === 0 && exists(nightOf(app, "20261001")) && exists(nightOf(app, "20261002")),
		"§9 the script made two nights");
	put(path.join(app, "backups", "app.db.20200101_020000.gz"), "made-up old snapshot", 0o600);
	put(path.join(app, "backups", "app.db.20200102_020000.gz"), "made-up old snapshot", 0o600);
	const before = snapshot(treesOf(app));
	const r = spawnSync(process.execPath, [BACKUP_DB, "--out", path.join(app, "backups"), "--prune-only", "--keep-days", "30", "--keep-min", "1"],
		{ encoding: "utf8", timeout: 30000 });
	c.ok(r.status === 0 && !exists(path.join(app, "backups", "app.db.20200101_020000.gz"))
		&& exists(path.join(app, "backups", "app.db.20200102_020000.gz")),
	"§9 control: backup-db.js's retention ran and pruned the older database snapshot");
	c.ok(before.split("\n").length > 10 && snapshot(treesOf(app)) === before, "§9 backups/trees/ is untouched by it");
	c.ok(exists(path.join(app, "backups", ".trees-enabled")), "§9 the switch file is untouched by it");
}

// ------------------------------------------------------------------ §10
function caseSymlinks(script, c) {
	{
		const app = makeApp("link-backups");
		const real = fresh("link-backups-target");
		fs.rmSync(path.join(app, "backups"), { recursive: true });
		put(path.join(real, ".trees-enabled"), "keep=3\n", 0o600);
		oldNights(path.join(real, "trees"), SEPT.slice(0, 5));
		fs.symlinkSync(real, path.join(app, "backups"));
		const before = snapshot(real), beforeApp = snapshot(app);
		const r = runTrees(script, app, { night: "20261001" });
		c.eq(r.code, 1, "§10 backups/ is a link: exit 1");
		c.ok(/night FAILED: refused: backups\/ is a symbolic link/.test(r.out), "§10 backups/ is a link: the log says it was refused");
		c.ok(snapshot(real) === before && snapshot(app) === beforeApp, "§10 backups/ is a link: nothing changed on either side");
	}
	{
		const app = makeApp("link-trees", { keep: 3 });
		const real = fresh("link-trees-target");
		oldNights(real, SEPT.slice(0, 5));
		fs.symlinkSync(real, treesOf(app));
		const before = snapshot(real), beforeApp = snapshot(app);
		const r = runTrees(script, app, { night: "20261001" });
		c.eq(r.code, 1, "§10 backups/trees/ is a link: exit 1");
		c.ok(/night FAILED: refused: backups\/trees\/ is a symbolic link/.test(r.out), "§10 backups/trees/ is a link: the log says it was refused");
		c.ok(snapshot(real) === before && snapshot(app) === beforeApp, "§10 backups/trees/ is a link: nothing changed on either side");
	}
	{
		const app = makeApp("link-work", { keep: 3 });
		const real = fresh("link-work-target");
		put(path.join(real, "marker.txt"), "outside");
		fs.mkdirSync(treesOf(app), { mode: 0o700 });
		fs.symlinkSync(real, path.join(treesOf(app), ".in-progress"));
		const before = snapshot(real), beforeApp = snapshot(app);
		const r = runTrees(script, app, { night: "20261001" });
		c.ok(r.code === 1 && /refused: backups\/trees\/\.in-progress is a symbolic link/.test(r.out)
			&& snapshot(real) === before && snapshot(app) === beforeApp, "§10 .in-progress is a link: refused, nothing changed");
	}
}

// ------------------------------------------------------------------ §11
function caseHeader(c) {
	const text = read(SCRIPT) || "";
	const header = text.slice(0, Math.max(0, text.indexOf("\nset -uo pipefail")));
	c.ok(header.includes("cp -a backups/trees/<date>/<tree>/<path> <tree>/<path>")
		&& /never move it/.test(header) && /never edit a file inside a night/.test(header) && /share inodes/.test(header),
	"§11 the header restores one file by copying it, never moving it or editing inside a night");
	c.ok(/rsync -a backups\/trees\/<date>\/<tree>\/ <scratch>\/<tree>\//.test(header) && /compare file counts and sizes/.test(header)
		&& /pre-restore copy/.test(header) && /window/.test(header),
	"§11 the header restores a tree into a scratch folder, compares counts and sizes, and swaps in a window after a pre-restore copy");
	c.ok(/A DELETED FILE IS NOT GONE AT ONCE/.test(header) && /voice note/.test(header) && /keep window/.test(header),
		"§11 the header says a deleted file (a voice note included) stays in the copies up to the keep window");
	c.ok(/scripts\/backup-trees\.sh/.test(read(BACKUP_SH) || ""), "§11 backup.sh's header names scripts/backup-trees.sh");
}

// ------------------------------------------------------------------ §12
function caseSameDay(script, c) {
	const app = makeApp("same-day", { keep: 14 });
	const f = "uploads/expense-receipts/receipt-0001.jpg";
	const r1 = runTrees(script, app, { night: "20261001" });
	const before = snapshot(treesOf(app));
	put(path.join(app, f), "damaged later the same day");
	const r2 = runTrees(script, app, { night: "20261001" });
	c.ok(r1.code === 0 && r2.code === 0, `§12 a second run the same day exits 0 (exit ${r1.code}, ${r2.code})`);
	c.ok(/already there; left as it is/.test(r2.out) && snapshot(treesOf(app)) === before
		&& read(path.join(nightOf(app, "20261001"), f)) === FILES[f],
	"§12 …and leaves tonight's copy exactly as it was");
}
function caseClockBehind(script, c) {
	const app = makeApp("clock-behind", { keep: 1 });
	oldNights(treesOf(app), ["20261101", "20261102", "20261103", ...SEPT.slice(0, 2)]);
	const r = runTrees(script, app, { night: "20261011" });
	c.ok(r.code === 0 && exists(nightOf(app, "20261011"))
		&& ["20261101", "20261102", "20261103"].every((d) => exists(nightOf(app, d)))
		&& SEPT.slice(0, 2).every((d) => !exists(nightOf(app, d))),
	"§12 a clock behind the newest names: tonight's copy is kept, the newest 3 are kept, older ones pruned");
}
function caseRsyncFail(script, c) {
	if (AS_ROOT) { c.skip("§12 an rsync failure keeps no night (an unreadable file is readable to root)"); return; }
	const app = makeApp("rsync-fail", { keep: 1 });
	oldNights(treesOf(app), SEPT.slice(0, 5));
	const locked = path.join(app, "uploads/chat/chat-0001.txt");
	fs.chmodSync(locked, 0o000);
	const r = runTrees(script, app, { night: "20261001" });
	fs.chmodSync(locked, 0o644);
	c.eq(r.code, 1, "§12 an rsync failure: exit 1");
	c.ok(/night FAILED: rsync of uploads\/ exited/.test(r.out) && !exists(nightOf(app, "20261001"))
		&& exists(path.join(treesOf(app), ".in-progress")), "§12 …no night is kept, .in-progress is left for the next run");
	c.ok(SEPT.slice(0, 5).every((d) => exists(nightOf(app, d))), "§12 …and nothing is pruned");
	const r2 = runTrees(script, app, { night: "20261001" });
	c.ok(r2.code === 0 && /reusing/.test(r2.out) && read(path.join(nightOf(app, "20261001"), "uploads/chat/chat-0001.txt")) === FILES["uploads/chat/chat-0001.txt"]
		&& !exists(path.join(treesOf(app), ".in-progress")), "§12 …and the next run finishes the night from .in-progress");
}
function caseBadConfig(script, c) {
	for (const body of ["keep=abc\n", "keep=0\n", "keep=30days\n"]) {
		const app = makeApp("bad-keep");
		enable(app, body);
		oldNights(treesOf(app), SEPT.slice(0, 5));
		const before = snapshot(app);
		const r = runTrees(script, app, { night: "20261001" });
		c.ok(r.code === 1 && /night FAILED: the keep line/.test(r.out) && snapshot(app) === before,
			`§12 ${JSON.stringify(body.trim())}: exit 1, nothing changed`);
	}
	const app = makeApp("missing-tree", { keep: 3 });
	fs.rmSync(path.join(app, "evidence-archive"), { recursive: true });
	oldNights(treesOf(app), SEPT.slice(0, 5));
	const before = snapshot(app);
	const r = runTrees(script, app, { night: "20261001" });
	c.ok(r.code === 1 && /night FAILED: evidence-archive\/ is missing/.test(r.out) && snapshot(app) === before,
		"§12 a missing tree: exit 1, nothing changed");
}

// ------------------------------------------------------------------ main
const CASES = [
	["§1 the first night", caseFirstNight],
	["§2 inodes", caseInodes],
	["§3 a deleted file", caseDeleted],
	["§4 pruning", casePrune],
	["§5 the free-space floor", caseFloor],
	["§6 0700", caseModes],
	["§7 the switch file", caseSwitch],
	["§8 backup.sh: only the tree step fails", caseBackupTreesFail],
	["§8 backup.sh: the database step fails", caseBackupDbFail],
	["§8 backup.sh: no node loads better-sqlite3", caseBackupNoNode],
	["§9 backup-db.js's retention", caseRetention],
	["§10 links refused", caseSymlinks],
	["§12 a second run the same day", caseSameDay],
	["§12 a clock behind the newest names", caseClockBehind],
	["§12 an rsync failure", caseRsyncFail],
	["§12 a bad keep line or a missing tree", caseBadConfig],
];

// Each mutation must apply exactly once, and the cases named must catch it.
const MUTANTS = [
	{ name: "the switch file is ignored", file: "trees", edits: [['[ -f "$APP_DIR/backups/.trees-enabled" ] || exit 0', "true || exit 0"]], cases: [caseSwitch] },
	{ name: "the free-space floor is not checked", file: "trees", edits: [['if [ "$avail_kib" -lt "$floor_kib" ]; then', "if false; then"], ['if [ $((avail_kib - est_kib)) -lt "$floor_kib" ]; then', "if false; then"]], cases: [caseFloor] },
	{ name: "the 5 GiB minimum floor is dropped", file: "trees", edits: [['if [ "$floor_kib" -lt "$FLOOR_MIN_KIB" ]; then floor_kib=$FLOOR_MIN_KIB; fi', ""]], cases: [caseFloor] },
	{ name: "the prune name filter takes any name", file: "trees", edits: [["NIGHT_RE='^20[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])$'", "NIGHT_RE='.'"]], cases: [casePrune] },
	{ name: "a link with a night's name counts as a night", file: "trees", edits: [['[[ "$n" =~ $NIGHT_RE ]] && [ -d "$p" ] && [ ! -L "$p" ]; then echo "$n"; fi', '[[ "$n" =~ $NIGHT_RE ]] && [ -d "$p" ]; then echo "$n"; fi']], cases: [casePrune] },
	{ name: "the newest-3 floor is dropped", file: "trees", edits: [['if [ "$keep_n" -lt "$MIN_KEEP" ]; then keep_n=$MIN_KEEP; fi', ""]], cases: [casePrune] },
	{ name: "tonight's copy can be pruned", file: "trees", edits: [['[ "$n" = "$NIGHT" ] && continue', ""]], cases: [caseClockBehind] },
	{ name: "a linked backups/ is not refused", file: "trees", edits: [['if [ -L "$BACKUPS" ]; then', "if false; then"]], cases: [caseSymlinks] },
	{ name: "a linked backups/trees/ is not refused", file: "trees", edits: [['if [ -L "$TREES" ]; then', "if false; then"]], cases: [caseSymlinks] },
	{ name: "folders are 0755, not 0700", file: "trees", edits: [["DIR_MODE=700", "DIR_MODE=755"]], cases: [caseModes] },
	{ name: "a second run the same day redoes tonight's copy", file: "trees", edits: [['if [ -e "$TREES/$NIGHT" ] || [ -L "$TREES/$NIGHT" ]; then\n  say "tonight', 'if false; then\n  say "tonight']], cases: [caseSameDay] },
	{ name: "the receipt caches are copied", file: "trees", edits: [['if [ "$t" = "storage" ]; then args+=(--exclude=/receipt-images/ --exclude=/receipt-pdfs/); fi', ""]], cases: [caseFirstNight] },
	{ name: "an rsync failure is ignored", file: "trees", edits: [['if [ "$rc" -ne 0 ] && [ "$rc" -ne 24 ]; then', "if false; then"]], cases: [caseRsyncFail] },
	{ name: "a tree failure is logged as \"] FAILED\" (read as a database failure)", file: "trees", edits: [['fail() { echo "[backup-trees] night FAILED: $*"; exit 1; }', 'fail() { echo "[backup-trees] FAILED: $*"; exit 1; }']], cases: [caseBackupTreesFail] },
	{ name: "backup.sh ignores a tree failure", file: "backup", edits: [["exit $trees_rc", "exit 0"]], cases: [caseBackupTreesFail] },
	{ name: "backup.sh runs the tree step only after a good database step", file: "backup", edits: [['bash "$APP_DIR/scripts/backup-trees.sh"', '[ $db_rc -eq 0 ] && bash "$APP_DIR/scripts/backup-trees.sh"']], cases: [caseBackupDbFail, caseBackupNoNode] },
];

function main() {
	console.log("backup tree copies: scripts/backup-trees.sh and backup.sh\n");
	console.log(`rsync: ${RSYNC || "NOT FOUND"}${RSYNC_VERSION ? ` (${RSYNC_VERSION})` : ""}${OPENRSYNC ? " (macOS openrsync; the box and CI run GNU rsync)" : ""}`);
	console.log(`bash:  ${BASH_VERSION || "unknown"}`);
	console.log(`stat:  ${GNU_STAT ? "GNU" : "BSD (cases that need GNU stat are skipped by name)"}${AS_ROOT ? "; running as root" : ""}\n`);
	R.ok(!!RSYNC, "rsync is on PATH");
	const BSH = read(BACKUP_SH) || "";

	for (const [title, fn] of CASES) {
		console.log(title);
		try { fn(SCRIPT, R, BSH); } catch (e) { R.ok(false, `${title}: threw ${e && e.message}`); }
	}
	console.log("§11 the header");
	caseHeader(R);

	console.log("\n§13 mutants (each MUST be caught)");
	const src = { trees: read(SCRIPT) || "", backup: BSH };
	MUTANTS.forEach((m, i) => {
		let text = src[m.file];
		const applied = m.edits.every(([from]) => text.split(from).length === 2);
		for (const [from, to] of m.edits) text = text.split(from).join(to);
		R.ok(applied && text !== src[m.file], `§13 '${m.name}': the mutation applies once (update it if the code moved)`);
		if (!applied) return;
		const dir = fresh(`mutant-${i + 1}`);
		const script = m.file === "trees" ? path.join(dir, "backup-trees.sh") : SCRIPT;
		if (m.file === "trees") put(script, text, 0o755);
		const rec = recorder();
		for (const fn of m.cases) {
			try { fn(script, rec, m.file === "backup" ? text : BSH); } catch { rec.ok(false); }
		}
		if (!rec.bad() && rec.skips()) { R.skip(`§13 '${m.name}': its case was skipped here`); return; }
		R.ok(rec.bad() > 0, `§13 '${m.name}' is caught (${rec.bad()} assertion(s))`);
	});

	console.log(`\n${pass} passed, ${failures.length} failed, ${skipped.length} skipped`);
	if (skipped.length) { console.log("skipped:"); for (const s of skipped) console.log(`  - ${s}`); }
	if (failures.length) { console.log("failures:"); for (const f of failures) console.log(`  - ${f.split("\n")[0]}`); }
	process.exit(failures.length ? 1 : 0);
}
main();
