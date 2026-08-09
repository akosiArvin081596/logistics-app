#!/usr/bin/env node
// scripts/backup-db.js — consistent, verified, compressed snapshot of app.db.
//
// WHY THIS REPLACED `cp`:
//
//   backup.sh used to do `cp app.db backups/app.db.<ts>`. app.db runs in WAL
//   mode, where committed transactions live in `app.db-wal` until a checkpoint
//   folds them back. A plain cp copies the main file only — not `-wal`, not
//   `-shm` — so the snapshot can be BOTH stale and internally inconsistent.
//   At the time this was written `app.db-wal` was 89 MB, i.e. every nightly
//   backup was missing up to 89 MB of committed data. Nothing surfaces that
//   until a restore, which is the worst possible moment to find out.
//
//   better-sqlite3's db.backup() uses SQLite's Online Backup API: it reads a
//   consistent snapshot of a LIVE database (WAL included), page by page, without
//   blocking writers. sqlite3(1) is not installed on the VPS; Node and
//   better-sqlite3 already are, so this needs no new dependency.
//
// It also VERIFIES the snapshot (PRAGMA integrity_check) BEFORE keeping it, so a
// corrupt backup fails loudly at 02:00 instead of silently sitting there looking
// like a backup.
//
// Usage:
//   node scripts/backup-db.js [--db PATH] [--out DIR] [--keep-days N] [--keep-min N] [--no-gzip]
//   node scripts/backup-db.js --out DIR --prune-only --dry-run     # retention report, deletes nothing
//
// Exits non-zero on any failure so cron records it in backups/backup.log.

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP_DIR = path.resolve(__dirname, "..");
const SRC = path.resolve(arg("--db", path.join(APP_DIR, "app.db")));
const OUT_DIR = path.resolve(arg("--out", path.join(APP_DIR, "backups")));
const KEEP_DAYS = Math.max(1, parseInt(arg("--keep-days", "30"), 10) || 30);
const KEEP_MIN = Math.max(1, parseInt(arg("--keep-min", "7"), 10) || 7);
const GZIP = !process.argv.includes("--no-gzip");
const DRY_RUN = process.argv.includes("--dry-run");
const PRUNE_ONLY = process.argv.includes("--prune-only");

const log = (m) => console.log(`[backup] ${m}`);
const fail = (m) => { console.error(`[backup] FAILED: ${m}`); process.exit(1); };

// Opening the snapshot to verify it makes SQLite create -shm/-wal sidecars next
// to it (the copy inherits WAL journal_mode). Removing only the .tmp leaves those
// behind, one pair per night. Always clear all three together. (Retention now
// also collects strays — see planRetention — but not creating them is cheaper.)
function rmTmp(tmp) {
	for (const p of [tmp, `${tmp}-shm`, `${tmp}-wal`]) {
		try { fs.unlinkSync(p); } catch { /* already gone */ }
	}
}

// Local timestamp, matching the previous naming so old and new files sort and
// prune together.
function stamp() {
	const d = new Date();
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const human = (b) => b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + " GB" : (b / (1 << 20)).toFixed(1) + " MB";
const days = (ms) => (ms / 86400000).toFixed(1) + "d";

// ---------------------------------------------------------------------------
// RETENTION
//
// The bug this replaces: retention matched `^app\.db\.\d{8}_\d{6}(\.gz)?$` and
// deleted only what matched. Anything named differently was not "skipped for
// safety" — it was INVISIBLE, and therefore immortal. On production that was
// six hand-made pre-surgery snapshots (app.db.pre-datefix.20260801-013137,
// pre-dupe-removal, pre-expense-backfill, pre-hash-backfill, pre-june-revert,
// pre-restore-661 — 1.54 GiB) plus eight orphaned -shm/-wal sidecars. Each is a
// full plaintext copy of every SSN, EIN and bank account in the system, kept
// forever because of a punctuation mismatch (`.` and `-` where the regex wanted
// `_`, and a label between `app.db.` and the timestamp).
//
// THE INVERSION THAT MATTERS: selection is now a PREFIX test over the directory
// listing, and age comes from the listing too. Everything under `app.db.` is a
// candidate; the timestamp patterns below only REFINE the age and always fall
// back to mtime. So no pattern miss can make a file immortal again — the worst
// a future naming change can do is fall back to mtime, which still ages out.
//
// The guards that keep a prefix rule safe:
//   - only `app.db.*` is ever considered (backup.log, *.json, .env.* are left
//     alone, and are reported so their presence is at least visible);
//   - the newest KEEP_MIN snapshots are never pruned, whatever the clock says;
//   - the snapshot just written is never pruned;
//   - `backups/.retention-keep` pins named files forever (explicit + auditable,
//     unlike a name pattern nobody remembers writing);
//   - --dry-run prints the plan and deletes nothing.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// File permissions.
//
// A snapshot is a full copy of every SSN, EIN and bank routing/account number in
// the business. Production runs with four non-root login accounts (ubuntu,
// nodeapp, deploy, postgres) and these files were 644 in a 755 directory, so any
// of them could read the lot with `cp` — no exploit required.
//
// Scope, deliberately: this restricts only files THIS script creates. Existing
// modes and the directory itself belong to scripts/secure-backups.sh, which is
// explicit, has a dry run and is run by a human. A cron job that silently
// re-permissions a production directory at 02:00 is a surprise waiting to
// happen, and the one-time remediation is a decision, not a default.
// ---------------------------------------------------------------------------
const FILE_MODE = 0o600;
function restrict(p) {
	try { fs.chmodSync(p, FILE_MODE); } catch (e) { log(`WARNING: could not chmod ${path.basename(p)}: ${e.message}`); }
}
function warnIfDirIsReadable(dir) {
	try {
		const mode = fs.statSync(dir).mode & 0o777;
		if (mode & 0o077) {
			log(`WARNING: ${dir} is mode 0${mode.toString(8)} — group/other can list every snapshot.`);
			log("WARNING:   new files are written 0600, but the existing ones keep their modes.");
			log("WARNING:   fix once with: scripts/secure-backups.sh --apply   (dry run by default)");
		}
	} catch { /* not worth failing a backup over */ }
}

const BACKUP_PREFIX = "app.db.";
const SIDECAR_RE = /(-shm|-wal)$/;
const TMP_RE = /\.tmp$/;
const TMP_MAX_AGE_MS = 24 * 3600 * 1000;   // a .tmp older than this is a crashed run
const PIN_FILE = ".retention-keep";

// Timestamp inside the filename, most specific first. Only used to sharpen the
// age; a miss falls through to mtime, never to "immortal".
const STAMP_PATTERNS = [
	/(\d{4})(\d{2})(\d{2})[_\-T](\d{2})(\d{2})(\d{2})/g,        // 20260801-144037 / 20260806_063921
	/(\d{4})-(\d{2})-(\d{2})[T_\- ](\d{2})-(\d{2})-(\d{2})/g,   // 2026-08-01T01-31-37
	/(\d{4})(\d{2})(\d{2})/g,                                    // 20260807 (date only)
	/(\d{4})-(\d{2})-(\d{2})/g,                                  // 2026-08-07 (date only)
];

function buildDate(y, mo, d, h, mi, s) {
	if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	if (h > 23 || mi > 59 || s > 59) return null;
	const dt = new Date(y, mo - 1, d, h, mi, s);
	// Rejects 20260231 and friends, which Date silently rolls forward.
	if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
	return dt;
}

// Returns epoch ms parsed out of `name`, or null. Takes the LAST match so a
// label containing digits ("pre-restore-661.20260801-144037") cannot win.
function stampFromName(name) {
	for (const re of STAMP_PATTERNS) {
		re.lastIndex = 0;
		const all = [...name.matchAll(re)];
		if (!all.length) continue;
		const m = all[all.length - 1].map(Number);
		const dt = buildDate(m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0);
		if (dt) return dt.getTime();
	}
	return null;
}

// snapshot | sidecar (-shm/-wal of some snapshot) | tmp | foreign (never touched)
function classifyEntry(name) {
	if (name === "app.db" || !name.startsWith(BACKUP_PREFIX)) return { kind: "foreign" };
	let base = name;
	const sc = name.match(SIDECAR_RE);
	if (sc) base = name.slice(0, -sc[1].length);
	if (TMP_RE.test(base)) return { kind: "tmp", parent: sc ? base : null };
	if (sc) return { kind: "sidecar", parent: base };
	return { kind: "snapshot" };
}

function readPins(dir) {
	try {
		return new Set(
			fs.readFileSync(path.join(dir, PIN_FILE), "utf8")
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter((l) => l && !l.startsWith("#"))
		);
	} catch { return new Set(); }
}

function readEntries(dir) {
	const out = [];
	for (const name of fs.readdirSync(dir)) {
		try {
			const st = fs.statSync(path.join(dir, name));
			if (!st.isFile()) continue;
			out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
		} catch { /* vanished or unreadable — skip */ }
	}
	return out;
}

/**
 * Pure over a directory listing: decides what retention WOULD do.
 * @param {{entries:Array, keepDays:number, keepMin:number, now:number, protect?:Set<string>, pins?:Set<string>}} o
 */
function planRetention({ entries, keepDays, keepMin, now, protect = new Set(), pins = new Set() }) {
	const cutoff = now - keepDays * 86400000;
	const snapshots = [], sidecars = [], tmps = [], foreign = [];

	for (const e of entries) {
		const c = classifyEntry(e.name);
		const nameStamp = stampFromName(e.name);
		// A stamp in the future (clock skew, typo'd year) is not evidence of age.
		const useStamp = nameStamp !== null && nameStamp <= now;
		const row = {
			...e,
			timeMs: useStamp ? nameStamp : e.mtimeMs,
			timeSource: useStamp ? "filename" : "mtime",
			mtimeMs: e.mtimeMs,
			parent: c.parent || null,
		};
		if (c.kind === "snapshot") snapshots.push(row);
		else if (c.kind === "sidecar") sidecars.push(row);
		else if (c.kind === "tmp") tmps.push(row);
		else foreign.push(row);
	}

	// Newest first; the top keepMin are untouchable regardless of age.
	snapshots.sort((a, b) => b.timeMs - a.timeMs);
	const byName = new Map(snapshots.map((s) => [s.name, s]));

	snapshots.forEach((s, i) => {
		s.ageMs = now - s.timeMs;
		if (protect.has(s.name)) { s.verdict = "keep"; s.reason = "just written"; return; }
		if (pins.has(s.name)) { s.verdict = "keep"; s.reason = `pinned in ${PIN_FILE}`; return; }
		if (i < keepMin) { s.verdict = "keep"; s.reason = `newest ${keepMin} (floor)`; return; }
		if (s.timeMs < cutoff) { s.verdict = "prune"; s.reason = `older than ${keepDays}d (${days(s.ageMs)}, by ${s.timeSource})`; return; }
		s.verdict = "keep"; s.reason = `within ${keepDays}d (${days(s.ageMs)})`;
	});

	// A sidecar is worthless without its snapshot, so it simply follows it.
	// Deliberately NOT aged independently: these carry the mtime of whoever last
	// opened the backup, which is unrelated to the data's age.
	for (const s of sidecars) {
		s.ageMs = now - s.timeMs;
		const parent = byName.get(s.parent);
		if (!parent) { s.verdict = "prune"; s.reason = `orphan — no ${s.parent}`; continue; }
		if (parent.verdict === "prune") { s.verdict = "prune"; s.reason = `sidecar of pruned ${s.parent}`; continue; }
		s.verdict = "keep"; s.reason = `sidecar of retained ${s.parent}`;
	}

	for (const t of tmps) {
		t.ageMs = now - t.timeMs;
		if (protect.has(t.name)) { t.verdict = "keep"; t.reason = "in flight"; continue; }
		if (t.ageMs > TMP_MAX_AGE_MS) { t.verdict = "prune"; t.reason = `abandoned .tmp (${days(t.ageMs)})`; continue; }
		t.verdict = "keep"; t.reason = "recent .tmp — may be in flight";
	}

	for (const f of foreign) { f.verdict = "keep"; f.reason = "not a backup artifact"; }

	const prune = [...snapshots, ...sidecars, ...tmps].filter((r) => r.verdict === "prune");
	return {
		cutoff, keepDays, keepMin,
		snapshots, sidecars, tmps, foreign, prune,
		prunedBytes: prune.reduce((n, r) => n + r.size, 0),
		retainedSnapshots: snapshots.filter((s) => s.verdict === "keep").length,
		retainedBytes: [...snapshots, ...sidecars, ...tmps].filter((r) => r.verdict === "keep").reduce((n, r) => n + r.size, 0),
	};
}

function reportPlan(plan, { dryRun }) {
	const verb = dryRun ? "WOULD PRUNE" : "PRUNE";
	log(`retention: keep-days=${plan.keepDays} keep-min=${plan.keepMin} cutoff=${new Date(plan.cutoff).toISOString()}`);
	log(`scanned ${plan.snapshots.length} snapshot(s), ${plan.sidecars.length} sidecar(s), ${plan.tmps.length} tmp, ${plan.foreign.length} non-backup entr(ies)`);
	if (!plan.prune.length) { log("nothing to prune"); return; }
	for (const r of plan.prune) log(`  ${verb}  ${r.name}  ${human(r.size)}  — ${r.reason}`);
	log(`${verb}: ${plan.prune.length} file(s), ${human(plan.prunedBytes)}`);
}

function applyPlan(dir, plan, { dryRun }) {
	if (dryRun) return { removed: 0, freed: 0 };
	let removed = 0, freed = 0;
	for (const r of plan.prune) {
		try { fs.unlinkSync(path.join(dir, r.name)); removed++; freed += r.size; }
		catch (e) { log(`  WARN could not remove ${r.name}: ${e.message}`); }
	}
	return { removed, freed };
}

function runRetention(dir, { keepDays, keepMin, protect, dryRun }) {
	const plan = planRetention({
		entries: readEntries(dir),
		keepDays, keepMin,
		now: Date.now(),
		protect: new Set(protect || []),
		pins: readPins(dir),
	});
	reportPlan(plan, { dryRun });
	const { removed, freed } = applyPlan(dir, plan, { dryRun });
	if (!dryRun && removed) log(`pruned ${removed} file(s), freed ${human(freed)}`);
	log(`retained ${plan.retainedSnapshots} snapshot(s), ${human(plan.retainedBytes)} on disk`);
	if (plan.foreign.length) {
		log(`left alone (not app.db.*): ${plan.foreign.map((f) => f.name).join(", ")}`);
	}
	return plan;
}

// ---------------------------------------------------------------------------

async function main() {
	if (PRUNE_ONLY) {
		if (!fs.existsSync(OUT_DIR)) fail(`backup dir not found: ${OUT_DIR}`);
		log(`prune-only${DRY_RUN ? " (DRY RUN — nothing will be deleted)" : ""} on ${OUT_DIR}`);
		runRetention(OUT_DIR, { keepDays: KEEP_DAYS, keepMin: KEEP_MIN, protect: [], dryRun: DRY_RUN });
		log("OK");
		return;
	}

	if (!fs.existsSync(SRC)) fail(`source database not found: ${SRC}`);
	// 0700 applies only when this call CREATES the directory. An existing one is
	// deliberately left alone: changing the mode of a live production directory
	// from inside a cron job, at 02:00, unattended, is not this script's call.
	// scripts/secure-backups.sh does that, explicitly and with a dry run.
	fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
	warnIfDirIsReadable(OUT_DIR);

	let Database;
	try { Database = require("better-sqlite3"); }
	catch { fail("better-sqlite3 not available — run from the app directory so node_modules resolves"); }

	const base = path.join(OUT_DIR, `app.db.${stamp()}`);
	const tmp = `${base}.tmp`;
	const srcSize = fs.statSync(SRC).size;
	const walPath = `${SRC}-wal`;
	const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
	log(`source ${path.basename(SRC)} ${human(srcSize)} (+${human(walSize)} in -wal, which a plain cp would have missed)`);

	// 1. Consistent online snapshot of the LIVE database.
	let src;
	try {
		src = new Database(SRC, { readonly: true, fileMustExist: true });
		await src.backup(tmp);
	} catch (e) {
		rmTmp(tmp);
		fail(`snapshot failed: ${e.message}`);
	} finally {
		try { src && src.close(); } catch {}
	}
	if (!fs.existsSync(tmp)) fail("snapshot produced no file");
	// Before anything else touches it. This file is a complete copy of every SSN,
	// EIN and bank account number in the system; better-sqlite3 created it at
	// 0644 & ~umask, and the rename/gzip below preserve whatever it starts with.
	// Restricting NEW files needs no sign-off — it changes no existing mode and
	// it is what stops tomorrow's run undoing secure-backups.sh.
	restrict(tmp);
	log(`snapshot written ${human(fs.statSync(tmp).size)}`);

	// 2. Verify BEFORE keeping it. A backup nobody has opened is a guess.
	try {
		const check = new Database(tmp, { readonly: true, fileMustExist: true });
		const integrity = check.pragma("integrity_check", { simple: true });
		const tables = check.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
		check.close();
		if (String(integrity).toLowerCase() !== "ok") throw new Error(`integrity_check = ${integrity}`);
		log(`verified: integrity_check ok, ${tables} tables`);
	} catch (e) {
		rmTmp(tmp);
		fail(`verification failed, snapshot discarded: ${e.message}`);
	}

	// 3. Compress. SQLite compresses well; this is what keeps 30 days affordable.
	let finalPath = base;
	if (GZIP) {
		finalPath = `${base}.gz`;
		try {
			await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 9 }), fs.createWriteStream(finalPath, { mode: 0o600 }));
			restrict(finalPath);
			rmTmp(tmp);
		} catch (e) {
			try { fs.unlinkSync(finalPath); } catch {}
			try { fs.renameSync(tmp, base); } catch {}   // keep the good uncompressed copy
			fail(`gzip failed (uncompressed snapshot kept at ${base}): ${e.message}`);
		}
	} else {
		fs.renameSync(tmp, base);
		restrict(base);        // rename preserves the mode; assert it anyway
		rmTmp(tmp);            // rename moves the db; the sidecars remain
	}
	const outSize = fs.statSync(finalPath).size;
	log(`kept ${path.basename(finalPath)} ${human(outSize)}${GZIP ? ` (${Math.round((outSize / srcSize) * 100)}% of source)` : ""}`);

	// 4. Retention. Never prunes the file just written.
	runRetention(OUT_DIR, {
		keepDays: KEEP_DAYS,
		keepMin: KEEP_MIN,
		protect: [path.basename(finalPath), path.basename(tmp)],
		dryRun: DRY_RUN,
	});
	log("OK");
}

if (require.main === module) {
	main().catch((e) => fail(e && e.message ? e.message : String(e)));
} else {
	// Importable for tests / ad-hoc reporting without taking a snapshot.
	module.exports = { classifyEntry, stampFromName, planRetention, readEntries, readPins, human, days };
}
