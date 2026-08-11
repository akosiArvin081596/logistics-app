#!/usr/bin/env node
// Deterministic check on scripts/backup-db.js retention — classifyEntry(),
// stampFromName() and planRetention().
//
// WHY THIS EXISTS. Every file in backups/ is a full plaintext copy of every SSN,
// EIN and bank routing/account number in the business. Retention is therefore
// not housekeeping, it is the only thing that puts a bound on how long that
// plaintext exists. A retention policy that silently fails to apply to some of
// its own output is worse than no policy, because it reports success.
//
// THE BUG THIS LOCKS OUT. Retention used to select with a NAME PATTERN:
//
//     if (!/^app\.db\.\d{8}_\d{6}(\.gz)?$/.test(name)) continue;
//
// and delete only what matched. Anything named differently was not "skipped for
// safety" — it was INVISIBLE, and therefore IMMORTAL. On production that was six
// hand-made pre-surgery snapshots (1.54 GiB) plus eight orphaned -shm/-wal
// sidecars, kept forever because of a punctuation mismatch: a `.`/`-` where the
// pattern wanted `_`, and a label between `app.db.` and the timestamp. All six
// filenames below are verbatim from the production backup directory.
//
// The fix inverted selection: EVERYTHING under the `app.db.` prefix is a
// candidate, and the timestamp patterns only REFINE the age, always falling back
// to mtime. So the worst a future naming change can do is age a file by mtime —
// it can no longer make one immortal.
//
// A test that only asserted "old files get pruned" would pass on the broken
// code, because the broken code pruned the plainly-named files perfectly well.
// Every case is therefore paired with the property that actually failed:
// NOTHING THE BACKUP SCRIPT CAN PRODUCE MAY CLASSIFY AS `foreign`.
//
// The MUTANTS section at the end is the proof that this suite fails against the
// pre-fix code: it re-implements the historical rule (and four other plausible
// regressions) and requires the battery to reject each one. If a mutant passes,
// this file is not testing what it claims to.
//
// No network, no database, no filesystem — planRetention is pure over a
// directory listing, so this is safe to run anywhere.
//
//   node scripts/test-backup-retention.js     # exits 1 on any failure

"use strict";

const path = require("path");
const { classifyEntry, stampFromName, planRetention } = require(path.join(__dirname, "backup-db.js"));

const DAY = 86400000;
// A fixed "now" so the suite is time-independent. Local-time construction
// matches backup-db.js's stamp()/buildDate(), which are both local — so this
// test is timezone-independent too.
const NOW = new Date(2026, 7, 11, 10, 19, 0).getTime();   // 2026-08-11 10:19 local

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return true; }
	fail++; failures.push(`${name}\n     expected ${e}\n     actual   ${a}`);
	console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
	return false;
}
function ok(name, cond) { return check(name, !!cond, true); }

// ---------------------------------------------------------------------------
// The names backup-db.js can actually produce.
//
// stamp() is `${YYYY}${MM}${DD}_${HH}${mm}${ss}` in LOCAL time. One run emits a
// final artifact plus transients, and — because verifying the snapshot opens it
// with better-sqlite3, which creates WAL sidecars next to it — a kept
// uncompressed snapshot can carry `-shm`/`-wal` too. Production holds exactly
// that shape (app.db.20260727_020001-shm), which is why they are generated here
// rather than imagined.
// ---------------------------------------------------------------------------
function stampOf(d) {
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function producibleNames(d) {
	const s = `app.db.${stampOf(d)}`;
	return {
		gz:        `${s}.gz`,        // --gzip  (default) final artifact
		plain:     s,                // --no-gzip        final artifact
		tmp:       `${s}.tmp`,       // in-flight snapshot
		tmpShm:    `${s}.tmp-shm`,   // sidecar of the in-flight snapshot
		tmpWal:    `${s}.tmp-wal`,
		keptShm:   `${s}-shm`,       // sidecar of a KEPT uncompressed snapshot
		keptWal:   `${s}-wal`,
	};
}

// Verbatim from the production backup directory (2026-08-11). These six are the
// files the old pattern could not see.
const PRODUCTION_ESCAPEES = [
	"app.db.pre-datefix.20260801-013137",
	"app.db.pre-dupe-removal.20260801-003833",
	"app.db.pre-expense-backfill-20260708-055919",
	"app.db.pre-hash-backfill.20260801-050245",
	"app.db.pre-june-revert.20260801-141155",
	"app.db.pre-restore-661.20260801-144037",
];

// The historical selection rule, quoted exactly from 035ab87^.
const LEGACY_RE = /^app\.db\.\d{8}_\d{6}(\.gz)?$/;

// The glob both recovery consumers use to find a snapshot:
//   scripts/refresh-local.sh:166   ls -1t $PROD_BACKUPS/app.db.*.gz | head -1
//   scripts/refresh-staging.sh:60  ls -1t $PROD_BACKUPS/app.db.*.gz | head -1
const RECOVERY_GLOB = /^app\.db\..*\.gz$/;

const E = (name, ageDays, size = 1 << 20) => ({ name, size, mtimeMs: NOW - ageDays * DAY });

// ---------------------------------------------------------------------------
// THE BATTERY — parameterized on a plan function so the mutants below can be
// run through the identical assertions.
// ---------------------------------------------------------------------------
function battery(plan, record) {
	const c = record;

	// (1) THE PROPERTY THAT ACTUALLY FAILED. Nothing the backup script can
	// produce may be invisible to retention.
	{
		const d = new Date(2025, 11, 31, 2, 0, 1);           // 2025-12-31 02:00:01
		const n = producibleNames(d);
		const entries = Object.values(n).map((name) => E(name, 400));
		const p = plan({ entries, keepDays: 30, keepMin: 0, now: NOW });
		c("producible names: none classify as foreign", p.foreign.map((f) => f.name), []);
		c("producible names: every one is a prune candidate at 400d old",
			p.prune.length, entries.length);
	}

	// (2) The six real production escapees.
	//
	// NOTE the fixture: mtime is set to 400 days old while every FILENAME says
	// Jul/Aug 2026 — i.e. ~10-35 days before NOW. That disagreement is
	// deliberate and it is the assertion. It is also the production state: on
	// the VPS several of these carry mtimes from a later day, because somebody
	// opened them. Age must come from the name, so a touched file does not get
	// a fresh lease.
	{
		const entries = PRODUCTION_ESCAPEES.map((name) => E(name, 400));

		const p = plan({ entries, keepDays: 1, keepMin: 0, now: NOW });
		c("escapees: all six are snapshots, none foreign", p.foreign.length, 0);
		c("escapees: all six prune once past the cutoff, unpinned",
			p.prune.map((r) => r.name).sort(), [...PRODUCTION_ESCAPEES].sort());
		c("escapees: age is read from the filename, not the 400d-old mtime",
			p.prune.every((r) => r.timeSource === "filename"), true);

		// At the real 30-day policy only the genuinely old one goes. If age came
		// from mtime, all six would prune here — so this is the precedence test.
		const p30 = plan({ entries, keepDays: 30, keepMin: 0, now: NOW });
		c("escapees: at keep-days=30 only the one past 30d by NAME prunes",
			p30.prune.map((r) => r.name), ["app.db.pre-expense-backfill-20260708-055919"]);
	}

	// (3) Pins keep a file that is otherwise past the cutoff. This is the
	// mechanism that currently, deliberately, keeps those six alive.
	{
		const entries = PRODUCTION_ESCAPEES.map((name) => E(name, 400));
		const p = plan({ entries, keepDays: 30, keepMin: 0, now: NOW, pins: new Set(PRODUCTION_ESCAPEES) });
		c("pins: a pinned file is never pruned", p.prune.length, 0);
	}

	// (4) keep-min floor: the newest N survive whatever the clock says. Without
	// it, a stalled cron plus an old clock empties the directory.
	{
		const entries = [];
		for (let i = 0; i < 20; i++) {
			const p2 = (n) => String(n).padStart(2, "0");
			entries.push(E(`app.db.202001${p2((i % 28) + 1)}_0200${i % 10}0.gz`, 400 + i));
		}
		const p = plan({ entries, keepDays: 30, keepMin: 7, now: NOW });
		c("keep-min: 7 newest survive even at 400d", p.snapshots.filter((s) => s.verdict === "keep").length, 7);
	}

	// (5) The snapshot just written is never pruned, even with a broken clock.
	{
		const fresh = "app.db.20200101_020000.gz";           // stamp says 2020
		const p = plan({ entries: [E(fresh, 0)], keepDays: 30, keepMin: 0, now: NOW, protect: new Set([fresh]) });
		c("protect: the file just written is never pruned", p.prune.length, 0);
	}

	// (6) A sidecar follows its parent — never aged on its own mtime, which is
	// the mtime of whoever last OPENED the backup and says nothing about the
	// data's age. Production carries four such pairs, and in every one the
	// sidecar's mtime is NEWER than the parent's (Aug 6, vs a Jul 27 parent).
	// Aged independently they would outlive the snapshot they describe.
	{
		const recent = "app.db.20260727_020001";               // 15d before NOW
		const entries = [E(recent, 400), E(`${recent}-shm`, 0), E(`${recent}-wal`, 0)];
		const p = plan({ entries, keepDays: 30, keepMin: 0, now: NOW });
		c("sidecar: retained parent keeps its sidecars", p.prune.length, 0);

		const stale = "app.db.20250101_020000";                // well past any cutoff
		const old = [E(stale, 0), E(`${stale}-shm`, 0), E(`${stale}-wal`, 0)];
		const p2 = plan({ entries: old, keepDays: 30, keepMin: 0, now: NOW });
		c("sidecar: pruned parent takes its sidecars with it",
			p2.prune.map((r) => r.name).sort(), [stale, `${stale}-shm`, `${stale}-wal`].sort());
	}

	// (7) An orphaned sidecar (parent already gone) is worthless and goes, even
	// though its own mtime is recent.
	{
		const p = plan({ entries: [E("app.db.20260101_020000-shm", 0)], keepDays: 30, keepMin: 0, now: NOW });
		c("sidecar: orphan is pruned regardless of mtime", p.prune.length, 1);
	}

	// (8) Non-backup files are never touched. backup.log, the JSON exports and —
	// critically — the .env snapshots, which hold SESSION_SECRET and API keys.
	{
		const foreign = ["backup.log", ".retention-keep", ".env.pre-fuel-events-20260807",
			"expenses-dupes-2026-08-01T00-38-35-087Z.json", "app.db"];
		const p = plan({ entries: foreign.map((n) => E(n, 400)), keepDays: 30, keepMin: 0, now: NOW });
		c("foreign: non-backup files are never pruned", p.prune.length, 0);
		c("foreign: the live app.db is never a candidate",
			p.foreign.some((f) => f.name === "app.db"), true);
	}

	// (9) An unparseable name falls back to mtime — it ages, it does not become
	// immortal. This is the whole inversion in one assertion.
	{
		const p = plan({ entries: [E("app.db.no-timestamp-here", 400)], keepDays: 30, keepMin: 0, now: NOW });
		c("no parseable stamp: falls back to mtime and still ages out", p.prune.length, 1);
		c("no parseable stamp: timeSource reports mtime",
			p.prune.map((r) => r.timeSource), ["mtime"]);
	}

	// (10) A stamp in the future is not evidence of age (clock skew, typo'd
	// year); fall back to mtime rather than granting immortality.
	{
		const p = plan({ entries: [E("app.db.20991231_020000.gz", 400)], keepDays: 30, keepMin: 0, now: NOW });
		c("future stamp: ignored, ages by mtime", p.prune.length, 1);
	}

	// (11) An impossible date (Date rolls 20260231 forward to March 3) must not
	// be trusted as a timestamp.
	{
		const p = plan({ entries: [E("app.db.20260231_020000.gz", 400)], keepDays: 30, keepMin: 0, now: NOW });
		c("impossible date: rejected, ages by mtime", p.prune.map((r) => r.timeSource), ["mtime"]);
	}

	// (12) A digit-bearing label must not beat the real trailing timestamp.
	// "pre-restore-661" is a live production name.
	{
		const entries = [E("app.db.pre-restore-661.20260801-144037", 400)];
		const p = plan({ entries, keepDays: 3000, keepMin: 0, now: NOW });
		c("label digits: the trailing stamp wins, file is inside a wide window", p.prune.length, 0);
	}
}

// ---------------------------------------------------------------------------
(function main() {
	console.log("backup retention — scripts/backup-db.js\n");

	// --- pure helpers, asserted directly -------------------------------------
	console.log("classifyEntry / stampFromName");
	{
		const n = producibleNames(new Date(2026, 7, 11, 2, 0, 3));
		check("classify: .gz final artifact", classifyEntry(n.gz).kind, "snapshot");
		check("classify: uncompressed final artifact", classifyEntry(n.plain).kind, "snapshot");
		check("classify: in-flight .tmp", classifyEntry(n.tmp).kind, "tmp");
		check("classify: .tmp-shm sidecar", classifyEntry(n.tmpShm).kind, "tmp");
		check("classify: .tmp-wal sidecar", classifyEntry(n.tmpWal).kind, "tmp");
		check("classify: -shm of a kept snapshot", classifyEntry(n.keptShm).kind, "sidecar");
		check("classify: -shm names its parent", classifyEntry(n.keptShm).parent, "app.db.20260811_020003");
		check("classify: the live database is foreign", classifyEntry("app.db").kind, "foreign");
		check("classify: backup.log is foreign", classifyEntry("backup.log").kind, "foreign");
		check("classify: an .env snapshot is foreign", classifyEntry(".env.pre-fuel-events-20260807").kind, "foreign");

		// Every escapee parses to the instant its name states.
		check("stamp: pre-datefix", stampFromName("app.db.pre-datefix.20260801-013137"),
			new Date(2026, 7, 1, 1, 31, 37).getTime());
		check("stamp: pre-expense-backfill (hyphen label, hyphen stamp)",
			stampFromName("app.db.pre-expense-backfill-20260708-055919"),
			new Date(2026, 6, 8, 5, 59, 19).getTime());
		check("stamp: nightly underscore form", stampFromName("app.db.20260811_020003.gz"),
			new Date(2026, 7, 11, 2, 0, 3).getTime());
		check("stamp: digit-bearing label does not win",
			stampFromName("app.db.pre-restore-661.20260801-144037"),
			new Date(2026, 7, 1, 14, 40, 37).getTime());
		check("stamp: unparseable returns null", stampFromName("app.db.no-timestamp-here"), null);
	}

	// --- a year of generated nightly names ------------------------------------
	console.log("\ngenerated names — a year of nightly runs");
	{
		let foreignCount = 0, globMisses = 0, stampMisses = 0;
		const entries = [];
		for (let i = 0; i < 365; i++) {
			const d = new Date(2026, 0, 1 + i, 2, 0, (i % 5) + 1);
			const n = producibleNames(d);
			for (const name of Object.values(n)) {
				if (classifyEntry(name).kind === "foreign") foreignCount++;
				entries.push(E(name, 400));
			}
			if (!RECOVERY_GLOB.test(n.gz)) globMisses++;
			if (stampFromName(n.gz) !== new Date(d.getFullYear(), d.getMonth(), d.getDate(), 2, 0, (i % 5) + 1).getTime()) stampMisses++;
		}
		check("365 nights x 7 artifacts: zero classify as foreign", foreignCount, 0);
		check("365 nights: every .gz matches the recovery glob refresh-*.sh uses", globMisses, 0);
		check("365 nights: every .gz stamp parses to the right instant", stampMisses, 0);

		const p = planRetention({ entries, keepDays: 30, keepMin: 7, now: NOW });
		check("365 nights: nothing is left invisible to retention", p.foreign.length, 0);
		ok("365 nights: the bulk is pruned", p.prune.length > 2000);
	}

	// --- the shipped implementation must pass the whole battery ---------------
	console.log("\nretention semantics (shipped implementation)");
	battery(planRetention, check);

	// --- the historical bug, stated as a fact about the old rule --------------
	console.log("\nthe pre-fix rule, for the record");
	{
		const missed = PRODUCTION_ESCAPEES.filter((n) => !LEGACY_RE.test(n));
		check("legacy pattern: could not see any of the six", missed.length, 6);
		check("legacy pattern: could not see a -shm sidecar either",
			LEGACY_RE.test("app.db.20260727_020001-shm"), false);
		check("legacy pattern: DID match the plainly-named nightlies (why it looked fine)",
			LEGACY_RE.test("app.db.20260811_020003.gz"), true);
	}

	// -----------------------------------------------------------------------
	// MUTANTS — the proof this suite fails against the pre-fix code.
	//
	// Each mutant is a plausible retention implementation. Every one must be
	// REJECTED by the battery above. A mutant that survives means the battery
	// is not actually constraining that behaviour.
	// -----------------------------------------------------------------------
	console.log("\nmutants (each MUST be caught)");

	// M1 — the historical rule, re-implemented faithfully: select by name
	// pattern, age by mtime, delete only what matched.
	const mutantLegacy = ({ entries, keepDays, keepMin = 0, now, protect = new Set(), pins = new Set() }) => {
		const cutoff = now - keepDays * DAY;
		const snapshots = [], foreign = [];
		for (const e of entries) {
			if (!LEGACY_RE.test(e.name)) { foreign.push({ ...e, verdict: "keep", reason: "unmatched" }); continue; }
			snapshots.push({ ...e, timeMs: e.mtimeMs, timeSource: "mtime" });
		}
		snapshots.sort((a, b) => b.timeMs - a.timeMs);
		snapshots.forEach((s, i) => {
			if (protect.has(s.name) || pins.has(s.name) || i < keepMin) { s.verdict = "keep"; return; }
			s.verdict = s.timeMs < cutoff ? "prune" : "keep";
		});
		const prune = snapshots.filter((s) => s.verdict === "prune");
		return { snapshots, sidecars: [], tmps: [], foreign, prune,
			prunedBytes: prune.reduce((n, r) => n + r.size, 0),
			retainedSnapshots: snapshots.length - prune.length, retainedBytes: 0 };
	};

	// M2 — prefix selection, but pins ignored.
	const mutantNoPins = (o) => planRetention({ ...o, pins: new Set() });
	// M3 — prefix selection, but no keep-min floor.
	const mutantNoKeepMin = (o) => planRetention({ ...o, keepMin: 0 });
	// M4 — prefix selection, but the "just written" protection dropped.
	const mutantNoProtect = (o) => planRetention({ ...o, protect: new Set() });
	// M5 — filename stamp only, no mtime fallback: an unparseable name is
	// immortal. This is the bug re-introduced in a subtler shape.
	const mutantStampOnly = (o) => {
		const p = planRetention(o);
		for (const r of [...p.snapshots, ...p.sidecars, ...p.tmps]) {
			if (r.timeSource === "mtime" && r.verdict === "prune") { r.verdict = "keep"; r.reason = "no stamp"; }
		}
		const prune = [...p.snapshots, ...p.sidecars, ...p.tmps].filter((r) => r.verdict === "prune");
		return { ...p, prune, prunedBytes: prune.reduce((n, r) => n + r.size, 0) };
	};

	const MUTANTS = [
		["M1 legacy name-pattern selection (the shipped bug)", mutantLegacy],
		["M2 pins ignored", mutantNoPins],
		["M3 keep-min floor removed", mutantNoKeepMin],
		["M4 just-written protection removed", mutantNoProtect],
		["M5 filename stamp only, no mtime fallback", mutantStampOnly],
	];
	for (const [label, fn] of MUTANTS) {
		let caught = 0;
		const silent = () => { caught++; };
		try { battery(fn, (n, a, e) => { if (JSON.stringify(a) !== JSON.stringify(e)) silent(); }); }
		catch { caught++; }                    // a mutant that throws is also caught
		if (caught > 0) { pass++; console.log(`  ok    ${label} — caught by ${caught} assertion(s)`); }
		else { fail++; failures.push(`MUTANT SURVIVED: ${label}`); console.log(`  FAIL  MUTANT SURVIVED: ${label}`); }
	}

	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail) { console.log("\nfailures:"); for (const f of failures) console.log(`  - ${f}`); }
	process.exit(fail === 0 ? 0 : 1);
})();
