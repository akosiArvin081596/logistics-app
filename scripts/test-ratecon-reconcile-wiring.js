#!/usr/bin/env node
// The server-side half of the rate-con reconcile window fix, tested against
// source EXTRACTED FROM server.js (same pattern as test-truck-retirement.js) so
// a rename or a silent edit fails the run rather than passing a stale copy.
//
// What is actually at risk here is not the arithmetic — that lives in
// lib/ratecon-reconcile.js and has its own suite — but the GLUE:
//
//   * `ratecon_reconcile_runs.ran_at` is a SQLite CURRENT_TIMESTAMP-shaped
//     value. It is UTC but serializes ZONE-LESS, so `new Date(t)` reads it as
//     LOCAL time. On the UTC VPS that is harmless; on a Houston laptop it is a
//     5-6 hour error, always in the direction of a SHORTER window. A high-water
//     mark that silently under-reads is the original bug wearing a new hat.
//   * the mark must advance only on a real sweep, and only after one succeeds.
//
// Uses a scratch in-memory database. Touches no real app.db, no sheet, no
// mailbox, no network.
//
//   node scripts/test-ratecon-reconcile-wiring.js
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const R = require("../lib/ratecon-reconcile.js");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => { if (c) { pass++; return true; } fail++; failures.push(label + (extra ? "  --> " + extra : "")); return false; };
const eq = (a, b, label) => ok(a === b, label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ------------------------------------------------------------- extraction ---
// `rateconLastRunAt` is an arrow const, not a `function`, so it is lifted by a
// bounded source match that asserts exactly one definition.
function extractConst(name) {
	const re = new RegExp(`\\nconst ${name} = \\(([^)]*)\\) => \\{`, "g");
	const hits = SRC.match(re);
	if (!hits || hits.length !== 1) {
		throw new Error(`expected exactly 1 definition of ${name} in server.js, found ${hits ? hits.length : 0}`);
	}
	const start = SRC.indexOf(hits[0]) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start + name.length); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1) + ";"; }
	}
	throw new Error(`unbalanced braces extracting ${name}`);
}

const db = new Database(":memory:");
db.exec(`
	CREATE TABLE ratecon_reconcile_runs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ran_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		mode TEXT DEFAULT '',
		since_days INTEGER DEFAULT 0,
		scanned INTEGER DEFAULT 0,
		gaps INTEGER DEFAULT 0,
		newly_alerted INTEGER DEFAULT 0,
		note TEXT DEFAULT ''
	)
`);

const rateconLastRunAt = new Function("db", `${extractConst("rateconLastRunAt")}\nreturn rateconLastRunAt;`)(db);

console.log("\n1. the run table and its reader");
eq(typeof rateconLastRunAt, "function", "1.1 rateconLastRunAt extracted from server.js");
eq(rateconLastRunAt(null), null, "1.2 an empty table has no high-water mark");
eq(rateconLastRunAt("deep"), null, "1.3 ...and no deep mark either");
{
	const w = R.resolveSweepWindow({ now: Date.now(), lastSweepAt: rateconLastRunAt(null), lastDeepSweepAt: rateconLastRunAt("deep") });
	eq(w.deep, true, "1.4 a fresh install therefore starts with a deep sweep");
	ok(!rateconLastRunAt(null), "1.5 ...and it qualifies as the baseline run");
}

console.log("\n2. ⚠️ the zone-less CURRENT_TIMESTAMP trap");
{
	// Write a row exactly as SQLite's CURRENT_TIMESTAMP would: UTC, zone-less.
	const nowUtc = new Date(Date.now() - 3 * 3600000);          // 3 hours ago, UTC
	const sqliteShape = nowUtc.toISOString().replace("T", " ").slice(0, 19);
	db.prepare("INSERT INTO ratecon_reconcile_runs (ran_at, mode, since_days) VALUES (?, 'incremental', 14)").run(sqliteShape);

	const read = rateconLastRunAt(null);
	ok(/Z$/.test(String(read)), "2.1 the reader stamps the zone back on", String(read));
	const drift = Math.abs(Date.parse(read) - nowUtc.getTime());
	ok(drift < 2000, "2.2 the parsed instant matches the instant written", drift + "ms drift");

	// The bug this guards: parsing the raw zone-less string as local time.
	const naive = Date.parse(sqliteShape);
	const localOffsetMs = new Date().getTimezoneOffset() * 60000;
	if (localOffsetMs !== 0) {
		ok(Math.abs(naive - nowUtc.getTime()) > 3000,
			"2.3 MUTANT: parsing the raw value really is wrong off-UTC",
			"offset " + localOffsetMs);
		const wNaive = R.resolveSweepWindow({ now: Date.now(), lastSweepAt: sqliteShape, lastDeepSweepAt: sqliteShape });
		const wReal = R.resolveSweepWindow({ now: Date.now(), lastSweepAt: read, lastDeepSweepAt: read });
		ok(typeof wNaive.sinceDays === "number" && typeof wReal.sinceDays === "number",
			"2.4 both parse to a usable window (the naive one is just wrong)");
	} else {
		pass += 2;
		console.log("   (running on UTC — the local-time divergence is unobservable here)");
	}
}

console.log("\n3. the high-water mark drives the window");
{
	db.exec("DELETE FROM ratecon_reconcile_runs");
	const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
	db.prepare("INSERT INTO ratecon_reconcile_runs (ran_at, mode, since_days) VALUES (?, 'deep', 365)").run(iso(2 * 86400000));
	db.prepare("INSERT INTO ratecon_reconcile_runs (ran_at, mode, since_days) VALUES (?, 'incremental', 14)").run(iso(31 * 86400000));

	// MAX(ran_at) is a STRING max — which is why the format must be zero-padded
	// and fixed-width. It is, so lexical order is chronological order.
	const last = rateconLastRunAt(null);
	ok(Date.now() - Date.parse(last) < 3 * 86400000, "3.1 MAX(ran_at) picks the most recent run, not the last inserted");

	const w = R.resolveSweepWindow({
		now: Date.now(), lastSweepAt: last, lastDeepSweepAt: rateconLastRunAt("deep"),
		floorDays: 14, maxDays: 400, deepDays: 365, deepEveryHours: 168,
	});
	eq(w.deep, false, "3.2 a 2-day-old deep sweep is not yet due again");
	eq(w.sinceDays, 14, "3.3 a 2-day-old sweep reads the 14-day floor");
}
{
	db.exec("DELETE FROM ratecon_reconcile_runs");
	const iso = (d) => new Date(Date.now() - d * 86400000).toISOString().replace("T", " ").slice(0, 19);
	db.prepare("INSERT INTO ratecon_reconcile_runs (ran_at, mode, since_days) VALUES (?, 'deep', 365)").run(iso(3));
	db.prepare("INSERT INTO ratecon_reconcile_runs (ran_at, mode, since_days) VALUES (?, 'incremental', 14)").run(iso(3));
	// Simulate a 3-day outage: nothing has run since.
	const w = R.resolveSweepWindow({
		now: Date.now(), lastSweepAt: rateconLastRunAt(null), lastDeepSweepAt: rateconLastRunAt("deep"),
		floorDays: 14, maxDays: 400,
	});
	eq(w.sinceDays, 14, "3.4 a 3-day outage is still covered by the floor");

	// A 45-DAY OUTAGE. Nothing has run at all since — which is what an outage
	// means — so BOTH marks are 45 days old.
	db.exec("DELETE FROM ratecon_reconcile_runs");
	db.prepare("INSERT INTO ratecon_reconcile_runs (ran_at, mode, since_days) VALUES (?, 'deep', 365)").run(iso(45));
	db.prepare("INSERT INTO ratecon_reconcile_runs (ran_at, mode, since_days) VALUES (?, 'incremental', 14)").run(iso(45));

	// (a) the incremental path in isolation — deep deliberately not yet due, so
	//     only the high-water arithmetic can be answering.
	const wInc = R.resolveSweepWindow({
		now: Date.now(), lastSweepAt: rateconLastRunAt(null), lastDeepSweepAt: rateconLastRunAt("deep"),
		floorDays: 14, maxDays: 400, deepEveryHours: 24 * 3650,
	});
	// ⚠️ THE WHOLE POINT. Under the shipped fixed lookback a 45-day outage still
	// read 14 days and permanently lost 31 days of mail.
	eq(wInc.reason, "high-water", "3.5 a 45-day outage is answered by the high-water mark");
	ok(wInc.sinceDays >= 45, "3.6 ...with a >=45-day window", "got " + wInc.sinceDays);
	ok(wInc.sinceDays !== 14, "3.7 MUTANT: it does NOT collapse back to the fixed 14");

	// (b) the realistic case — after 45 days the deep sweep is also overdue, so
	//     the period is re-covered twice over.
	const wReal = R.resolveSweepWindow({
		now: Date.now(), lastSweepAt: rateconLastRunAt(null), lastDeepSweepAt: rateconLastRunAt("deep"),
		floorDays: 14, maxDays: 400, deepDays: 365, deepEveryHours: 168,
	});
	eq(wReal.deep, true, "3.8 in practice the deep sweep is overdue too");
	ok(wReal.sinceDays >= 45, "3.9 ...so the outage window is covered either way", "got " + wReal.sinceDays);
}

console.log("\n4. the reader fails safe");
{
	const db2 = new Database(":memory:");            // table does not exist
	const reader2 = new Function("db", `${extractConst("rateconLastRunAt")}\nreturn rateconLastRunAt;`)(db2);
	eq(reader2(null), null, "4.1 a missing run table reads as 'no mark', not a throw");
	const w = R.resolveSweepWindow({ now: Date.now(), lastSweepAt: reader2(null), lastDeepSweepAt: reader2("deep") });
	eq(w.deep, true, "4.2 ...which lands on a deep sweep — fail WIDE, never narrow");
}

console.log("\n5. server.js wiring invariants (textual)");
{
	const fn = SRC.slice(SRC.indexOf("async function reconcileRateCons"), SRC.indexOf("async function maybeReconcileRateCons"));
	ok(/resolveSweepWindow\(/.test(fn), "5.1 the sweep asks resolveSweepWindow for its window");
	// The FETCH call site specifically — the floor constant legitimately appears
	// in the forceFloorWindow branch, so grep the fetch options, not the file.
	const fetchCall = fn.slice(fn.indexOf("await fetchRateConSubjects("), fn.indexOf("});", fn.indexOf("await fetchRateConSubjects(")));
	ok(!/sinceDays:\s*RATECON_RECONCILE_DAYS/.test(fetchCall), "5.2 MUTANT: the fixed-days fetch call site is gone", fetchCall.replace(/\s+/g, " ").slice(0, 120));
	ok(/sinceDays:\s*win\.sinceDays/.test(fn), "5.3 ...replaced by the resolved window");
	// ⚠️ The dry-run guard. A read-only admin GET that advanced the mark would
	// make the diagnostic cause the blind spot it diagnoses.
	const marker = fn.slice(fn.indexOf("INSERT INTO ratecon_reconcile_runs") - 400, fn.indexOf("INSERT INTO ratecon_reconcile_runs"));
	ok(/if \(alert\) \{/.test(marker), "5.4 the run marker is written only when alert is true");
	ok(fn.indexOf("INSERT INTO ratecon_reconcile_runs") > fn.indexOf("await sendEmail"),
		"5.5 the mark advances AFTER the sweep succeeds, so a throw re-covers the period");
	ok(/getArchiveLoadIdsCached/.test(fn), "5.6 the archive is consulted");
	ok(/catch[\s\S]{0,120}archive unreadable/.test(fn), "5.7 ...best-effort — an unreadable archive cannot fail the sweep");
	ok(/scanFilenames:\s*RATECON_RECONCILE_SCAN_FILENAMES/.test(fn), "5.8 filename scanning is wired");
	ok(/scanBody:\s*RATECON_RECONCILE_SCAN_BODY/.test(fn), "5.9 body scanning is wired");
	ok(/planReconcileAlert\(/.test(fn), "5.10 the alert is batched through planReconcileAlert");
	ok(/isBaseline/.test(fn), "5.11 the first deep sweep is distinguished as a baseline");
}
{
	const m = SRC.match(/const RATECON_RECONCILE_DAYS = Math\.max\(1, Math\.min\((\d+),/);
	ok(!!m, "5.12 the days constant is still bounded");
	ok(m && parseInt(m[1], 10) > 60, "5.13 MUTANT: the 60-day cap is raised", m && m[1]);
	ok(/RATECON_RECONCILE_MAX_DAYS/.test(SRC), "5.14 an explicit max-days knob exists");
	ok(/RATECON_RECONCILE_DEEP_EVERY_HOURS/.test(SRC), "5.15 the deep-sweep cadence is configurable");
}
{
	// The archive read must stay read-only.
	const a = SRC.slice(SRC.indexOf("async function getArchiveLoadIdsCached"), SRC.indexOf("const rateconLastRunAt"));
	ok(/values\.get\(/.test(a), "5.16 the archive is read with values.get");
	ok(!/values\.(update|append|clear|batchUpdate)/.test(a), "5.17 ...and never written");
}

console.log("\n6. security review follow-ups (2026-08-11)");
{
	const fn = SRC.slice(SRC.indexOf("async function reconcileRateCons"), SRC.indexOf("async function maybeReconcileRateCons"));
	// L1 — detect and retire must share ONE extractor. Subject-only retire logic
	// beside staged detection widens selfOnlyNums, so a real gap found via the
	// filename or body stage could be closed as 'self_sent' and never mentioned
	// again. The asymmetry fails toward under-detection, which is the one
	// direction this module exists to prevent.
	ok(/inboundNums[\s\S]{0,200}extractMessageLoadNumbers\(/.test(fn),
		"6.1 the retire path uses the staged extractor, not subject-only");
	ok(!/for \(const n of extractLoadNumbers\(em\.subject\)\) inboundNums/.test(fn),
		"6.2 MUTANT: the subject-only retire loop is gone");
	ok(/selfOnlyNums[\s\S]{0,220}extractMessageLoadNumbers\(/.test(fn),
		"6.3 ...on both halves of the split");
}
{
	const http = SRC.slice(SRC.indexOf("async function rateConReconcileHttp"), SRC.indexOf("// Fuel events"));
	// M5 — the admin routes ran an unbounded sweep with no limiter and no
	// concurrency guard. The GET is the more expensive of the two: it never
	// advances the high-water mark, so every call resolves to a full deep sweep.
	ok(/rateconReconcileRunning/.test(http), "6.4 the HTTP path shares the in-flight guard");
	ok(/RECONCILE_IN_PROGRESS/.test(http), "6.5 ...and refuses a concurrent sweep with 409");
	ok(/finally \{[\s\S]{0,80}rateconReconcileRunning = false/.test(http),
		"6.6 ...releasing it in a finally, so a throw cannot wedge the feature off");
	ok(/rateconReconcileLimiter/.test(http), "6.7 a rate limiter is mounted");
	// requireRole BEFORE the limiter, matching fuelEventsLimiter/fuelGallonsLimiter:
	// an unauthenticated caller must not be able to spend the budget on 403s.
	// ⚠️ Slice to the handler, not to the first ")" — that lands inside
	// requireRole("Super Admin") and hides every middleware after it.
	for (const verb of ["get", "post"]) {
		const at = http.indexOf(`app.${verb}("/api/admin/ratecon-reconcile`);
		const end = http.indexOf("rateConReconcileHttp(req, res,", at);
		const mw = at >= 0 && end > at ? http.slice(at, end) : "";
		ok(!!mw, `6.8/${verb} the ${verb.toUpperCase()} route was located`);
		if (mw) {
			ok(mw.indexOf("requireRole") >= 0 && mw.indexOf("rateconReconcileLimiter") >= 0
				&& mw.indexOf("requireRole") < mw.indexOf("rateconReconcileLimiter"),
				`6.9/${verb} requireRole is mounted BEFORE the limiter`, mw.replace(/\s+/g, " ").trim());
			ok(/refuseCrossOrigin/.test(mw), `6.10/${verb} refuseCrossOrigin is still mounted`);
		}
	}
}
{
	const lib = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "ratecon-reconcile.js"), "utf8");
	ok(/illegal character in IMAP argument/.test(lib), "6.11 imapQuote refuses CR/LF/NUL (L2)");
	ok(/MAX_READER_BYTES/.test(lib), "6.12 the IMAP reader caps its buffering (M4)");
	ok(/MAX_MIME_TEXT_BYTES/.test(lib), "6.13 decodeMimeText caps its input (M3)");
	ok(/\(\?:\^\|\\r\\n\)\\\* \(\\d\+\) FETCH/.test(lib), "6.14 the FETCH boundary is anchored to a line start (M1)");
	ok(/const proto = \(b\) =>/.test(lib), "6.15 protocol text is sentinel-stripped (M2)");
}

console.log("\n7. security re-review follow-ups");
{
	const fn = SRC.slice(SRC.indexOf("async function reconcileRateCons"), SRC.indexOf("async function maybeReconcileRateCons"));
	const http = SRC.slice(SRC.indexOf("async function rateConReconcileHttp"), SRC.indexOf("// Fuel events"));
	// M5 — the admin GET never advances the mark, so without this it resolves to
	// a 365-day sweep on a 15-minute budget while DataIssuesView.vue waits 60 s.
	ok(/forceFloorWindow/.test(fn), "7.1 the sweep accepts a forced floor window");
	ok(/forceFloorWindow[\s\S]{0,200}RATECON_RECONCILE_DAYS/.test(fn),
		"7.2 ...and it resolves to the floor, not the deep window");
	ok(/const forceFloorWindow = !alert/.test(http), "7.3 the read-only GET forces it by default");
	ok(/req\.query\.deep/.test(http), "7.4 ...with ?deep=true as the explicit opt-in");
	ok(/reconcileRateCons\(\{ alert, forceFloorWindow \}\)/.test(http), "7.5 ...and passes it through");
	// The POST must NOT be floored — it is the deliberate "sweep now" verb.
	ok(/!alert &&/.test(http), "7.6 the POST keeps the resolved window");
	// Middleware order: refuse before spending a budget of 4.
	for (const verb of ["get", "post"]) {
		const at = http.indexOf(`app.${verb}("/api/admin/ratecon-reconcile`);
		const end = http.indexOf("rateConReconcileHttp(req, res,", at);
		const mw = at >= 0 && end > at ? http.slice(at, end) : "";
		ok(mw.indexOf("refuseCrossOrigin") < mw.indexOf("rateconReconcileLimiter"),
			`7.7/${verb} refuseCrossOrigin is mounted BEFORE the limiter`, mw.replace(/\s+/g, " ").trim());
	}
	// A deep sweep that times out writes no marker, so the next run is another
	// doomed first-deep. The budget must scale with the window it was given.
	ok(/timeoutMs: Math\.min\([\s\S]{0,80}win\.sinceDays/.test(fn),
		"7.8 the IMAP budget scales with the resolved window, not a flat constant");
}
{
	const lib = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "ratecon-reconcile.js"), "utf8");
	ok(/function stripHtmlTags/.test(lib), "7.9 the tag strip is a linear scan, not a regex");
	// Judge code, not the comments that document the retired forms.
	const libCode = lib.replace(/^\s*\/\/.*$/gm, "");
	ok(!/<\[\^>\]\{1,\d+\}>/.test(libCode), "7.10 MUTANT: the bounded-regex tag strip is gone");
	ok(!/<\[\^>\]\*>/.test(libCode) && !/<\[\^>\]\+>/.test(libCode), "7.11 MUTANT: the unbounded-regex tag strips are gone");
	ok(!/<style\\b\[\^>\]/.test(libCode), "7.12 MUTANT: the dedicated style/script body rules are gone");
	ok(/maxReaderBytes/.test(lib), "7.13 the reader ceiling is reachable from fetchRateConSubjects (M4)");
	ok(/accBytes \+ pend\.length > maxBytes/.test(lib), "7.14 the ceiling covers pend, not just acc");
}

console.log("\n" + "=".repeat(64));
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFAILURES:"); for (const f of failures) console.log("  ✗ " + f); }
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
