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
// Usage:  node scripts/backup-db.js [--db PATH] [--out DIR] [--keep-days N] [--no-gzip]
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
const GZIP = !process.argv.includes("--no-gzip");

const log = (m) => console.log(`[backup] ${m}`);
const fail = (m) => { console.error(`[backup] FAILED: ${m}`); process.exit(1); };

// Opening the snapshot to verify it makes SQLite create -shm/-wal sidecars next
// to it (the copy inherits WAL journal_mode). Removing only the .tmp leaves those
// behind, one pair per night, and they do not match the prune pattern — so they
// would accumulate forever. Always clear all three together.
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

(async () => {
	if (!fs.existsSync(SRC)) fail(`source database not found: ${SRC}`);
	fs.mkdirSync(OUT_DIR, { recursive: true });

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
			await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 9 }), fs.createWriteStream(finalPath));
			rmTmp(tmp);
		} catch (e) {
			try { fs.unlinkSync(finalPath); } catch {}
			try { fs.renameSync(tmp, base); } catch {}   // keep the good uncompressed copy
			fail(`gzip failed (uncompressed snapshot kept at ${base}): ${e.message}`);
		}
	} else {
		fs.renameSync(tmp, base);
		rmTmp(tmp);            // rename moves the db; the sidecars remain
	}
	const outSize = fs.statSync(finalPath).size;
	log(`kept ${path.basename(finalPath)} ${human(outSize)}${GZIP ? ` (${Math.round((outSize / srcSize) * 100)}% of source)` : ""}`);

	// 4. Prune. Matches BOTH the new .gz names and the legacy uncompressed ones so
	//    pre-existing backups still age out. Never prunes the file just written.
	const cutoff = Date.now() - KEEP_DAYS * 86400000;
	let removed = 0, freed = 0;
	for (const name of fs.readdirSync(OUT_DIR)) {
		if (!/^app\.db\.\d{8}_\d{6}(\.gz)?$/.test(name)) continue;   // leave backup.log and anything unexpected alone
		const p = path.join(OUT_DIR, name);
		if (p === finalPath) continue;
		try {
			const st = fs.statSync(p);
			if (st.mtimeMs < cutoff) { freed += st.size; fs.unlinkSync(p); removed++; }
		} catch { /* skip unreadable entries */ }
	}
	if (removed) log(`pruned ${removed} backup(s) older than ${KEEP_DAYS}d, freed ${human(freed)}`);

	const remaining = fs.readdirSync(OUT_DIR).filter((n) => /^app\.db\.\d{8}_\d{6}(\.gz)?$/.test(n));
	log(`retained ${remaining.length} backup(s)`);
	log("OK");
})().catch((e) => fail(e && e.message ? e.message : String(e)));
