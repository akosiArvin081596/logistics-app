#!/usr/bin/env node
/**
 * Tests for the date resolution in GET /api/investor/load-report.
 *
 * THE BUG THIS LOCKS DOWN. The handler defined its own `parseSheetDate` — ISO
 * and US-slash only, `return null` for everything else — and then did
 * `if (!dt) continue;` under the comment "un-dateable rows can't be bucketed".
 * The rows were not un-dateable. n8n copies the rate-con email's own `Date:`
 * header into Assigned Date, so 205 of production's 421 Job Tracking rows are
 * RFC 2822 and that parser returned null for every one. The report silently
 * rendered 162 loads out of 267 bucketable ones and hid $68,801 of gross.
 *
 * WHY IT LOADS THE HANDLER OUT OF server.js SOURCE. Same reasoning as
 * scripts/test-money-date.js: server.js opens SQLite, reads a service account
 * key and starts listening on import, so it cannot be required. Reading the
 * source keeps the test honest about THE CODE THAT SHIPS — in particular
 * sections 1 and 2 below are structural assertions that would fail if someone
 * reintroduced a local parser, which is the actual regression risk here.
 *
 * SECTION 4 IS THE DISCRIMINATOR. It replays the shipped bucketing loop over a
 * corpus of real production cell shapes under both the old and the new
 * resolver. If it passed against the old code the test would be worthless, so
 * it asserts explicitly that the old resolver DROPS rows the new one keeps.
 *
 * Run: node scripts/test-load-report-dates.js
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  FAIL:", msg); } };
const eq = (got, want, msg) => ok(got === want, `${msg} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// --------------------------------------------------------------- extraction
function extract(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}
const RFC2822_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const { moneySheetDate } = new Function("RFC2822_MONTHS",
	`${extract("moneySheetDate")}\nreturn { moneySheetDate };`)(RFC2822_MONTHS);

// The exact slice of source that is the load-report handler.
const HANDLER_START = SRC.indexOf('app.get("/api/investor/load-report"');
if (HANDLER_START < 0) throw new Error("load-report handler not found in server.js");
const HANDLER_END = SRC.indexOf('\napp.get("/api/investor/report"', HANDLER_START);
if (HANDLER_END < 0) throw new Error("could not bound the load-report handler");
const HANDLER = SRC.slice(HANDLER_START, HANDLER_END);

const fmtDay = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const day = (v) => { const d = moneySheetDate(v); return d && !isNaN(d) ? fmtDay(d) : null; };
const month = (v) => { const d = day(v); return d ? d.slice(0, 7) : null; };

// The resolver the handler used to carry, kept ONLY as the discriminator
// reference. This is the code that shipped before the fix, verbatim.
function oldParseSheetDate(val) {
	if (!val) return null;
	const s = String(val).trim();
	const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
	if (iso) { const d = new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3])); return isNaN(d) ? null : d; }
	const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
	if (!m) return null;
	let yr = parseInt(m[3]); if (yr < 100) yr += 2000;
	const d = new Date(yr, parseInt(m[1]) - 1, parseInt(m[2]));
	return isNaN(d) ? null : d;
}

// =========================================================== 1. structural
console.log("1. structural — the handler must not carry its own date parser");
ok(!/function\s+parseSheetDate\s*\(/.test(HANDLER),
	"load-report handler still defines a local parseSheetDate() — the shadowing parser is the bug; use moneySheetDate()");
ok(!/const\s+parseSheetDate\s*=/.test(HANDLER),
	"load-report handler defines parseSheetDate as a const — same shadowing bug in arrow form");
ok(!/\bparseSheetDate\s*\(/.test(HANDLER),
	"load-report handler still CALLS parseSheetDate — it must resolve dates through moneySheetDate()");

// =========================================================== 2. wiring
console.log("2. wiring — the bucketing loop resolves through moneySheetDate()");
ok(/const dt = dateCol \? moneySheetDate\(r\[dateCol\]\) : null;/.test(HANDLER),
	"the period-bucketing line does not read `moneySheetDate(r[dateCol])`");
// A null still has to skip; the fix is to stop MANUFACTURING nulls, not to stop guarding.
ok(/if \(!dt \|\| isNaN\(dt\)\) continue;/.test(HANDLER),
	"the null guard after resolution is missing or changed shape — a genuinely undateable cell must still skip");
// isNaN matters: moneySheetDate's last branch is `new Date(s)`, which can return
// an Invalid Date object (truthy). Without isNaN that reaches getFullYear() and
// buckets the row under "NaN-NaN".
ok(HANDLER.indexOf("moneySheetDate(r[dateCol])") < HANDLER.indexOf("if (!dt || isNaN(dt)) continue;"),
	"guard must follow the resolution");

// =========================================================== 3. resolution
console.log("3. resolution — every production cell shape resolves to its literal day");
// Real shapes taken from the production Assigned Date column (census 2026-08-09:
// 106 RFC 2822 / 73 ISO / 96 US-slash among the 275 rows this route can see).
eq(day("Date: Tue, 13 May 2025 11:56:47 -0500"), "2025-05-13", "RFC 2822 with Date: prefix, -0500");
eq(day("Date: Wed, 14 May 2025 10:42:04 -0500"), "2025-05-14", "RFC 2822, -0500");
eq(day("Tue, 13 May 2025 11:56:47 -0500"), "2025-05-13", "RFC 2822 without the Date: prefix");
eq(day("Date: Wed, 31 Dec 2025 20:00:00 -0600"), "2025-12-31", "RFC 2822 -0600 late on new year's eve stays in December");
eq(day("2026-04-09"), "2026-04-09", "ISO");
eq(day("4/9/2026"), "2026-04-09", "US slash");
eq(day("5/16/25"), "2025-05-16", "US slash, 2-digit year");
eq(day(""), null, "blank resolves to null");
eq(day(null), null, "null resolves to null");
eq(day("   "), null, "whitespace resolves to null");

// The offsets present in production are Houston's own, so the literal day and
// the Houston day are the same day. This is the property that makes reading the
// stamp literally safe — assert it rather than trusting the comment.
console.log("   ...and the resolved day must not depend on the server's timezone");
const CORPUS = [
	"Date: Tue, 13 May 2025 11:56:47 -0500",
	"Date: Wed, 30 Apr 2025 19:35:06 -0500",
	"Date: Thu, 31 Jul 2025 23:59:00 -0500",
	"Date: Wed, 31 Dec 2025 20:00:00 -0600",
	"2026-04-09", "4/9/2026", "5/16/25",
];
const probe = (tz) => execFileSync(process.execPath, ["-e", `
const fs=require("fs");
const SRC=fs.readFileSync(${JSON.stringify(SERVER)},"utf8");
function extract(n){const nd="\\nfunction "+n+"(";const s=SRC.indexOf(nd)+1;let d=0;
for(let j=SRC.indexOf("{",s);j<SRC.length;j++){if(SRC[j]==="{")d++;else if(SRC[j]==="}"){d--;if(!d)return SRC.slice(s,j+1);}}}
const M=["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const {moneySheetDate}=new Function("RFC2822_MONTHS",extract("moneySheetDate")+"\\nreturn {moneySheetDate};")(M);
const f=(d)=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
console.log(JSON.stringify(${JSON.stringify(CORPUS)}.map(v=>{const d=moneySheetDate(v);return d&&!isNaN(d)?f(d):null;})));
`], { env: { ...process.env, TZ: tz }, encoding: "utf8" }).trim();
const utc = probe("UTC"), chi = probe("America/Chicago"), kol = probe("Asia/Kolkata");
eq(utc, chi, "TZ=UTC and TZ=America/Chicago must resolve the corpus identically");
eq(utc, kol, "TZ=UTC and TZ=Asia/Kolkata must resolve the corpus identically");

// =========================================================== 4. discriminator
console.log("4. discriminator — replay the bucketing loop, old resolver vs new");
// A miniature of the shipped loop. Rates and statuses mirror the real column
// shapes ("  Payment  " carries "$1,234.00" strings).
const ROWS = [
	{ lid: "562620213", date: "Date: Tue, 13 May 2025 11:56:47 -0500", status: "Delivered", rate: "$1,850.00" },
	{ lid: "562787563", date: "Date: Wed, 14 May 2025 10:42:04 -0500", status: "Delivered", rate: "$2,100.00" },
	{ lid: "563593554", date: "Date: Mon, 07 Jul 2025 08:15:00 -0500", status: "In Transit", rate: "$900.00" },
	{ lid: "521716147", date: "2025-07-15", status: "Delivered", rate: "$580.00" },
	{ lid: "523642943", date: "8/4/2025", status: "Delivered", rate: "$500.00" },
	{ lid: "999999999", date: "", status: "Delivered", rate: "$100.00" },      // genuinely undateable
	{ lid: "", date: "2025-07-15", status: "Delivered", rate: "$777.00" },      // no load id
];
const completedStatuses = /^(delivered|completed|pod received)$/i;
function bucket(resolve) {
	const periods = new Map();
	let dropped = 0;
	for (const r of ROWS) {
		if (!r.lid) continue;
		const dt = resolve(r.date);
		if (!dt || isNaN(dt)) { dropped++; continue; }
		const key = fmtDay(dt).slice(0, 7);
		if (!periods.has(key)) periods.set(key, { loadCount: 0, completedCount: 0, grossRevenue: 0 });
		const b = periods.get(key);
		b.loadCount++;
		if (completedStatuses.test(r.status)) {
			b.completedCount++;
			b.grossRevenue += parseFloat(String(r.rate).replace(/[$,]/g, "")) || 0;
		}
	}
	return { periods, dropped };
}
const before = bucket(oldParseSheetDate);
const after = bucket(moneySheetDate);

// The old resolver drops the three RFC 2822 rows; only the blank survives as a
// legitimate drop under the new one.
eq(before.dropped, 4, "old resolver should drop 3 RFC 2822 rows + 1 blank");
eq(after.dropped, 1, "new resolver should drop only the genuinely blank row");
ok(before.dropped > after.dropped, "TEST IS NOT DISCRIMINATING: old and new resolvers drop the same rows");

eq(before.periods.has("2025-05"), false, "old resolver loses May 2025 entirely");
eq(after.periods.get("2025-05").loadCount, 2, "new resolver buckets both May loads");
eq(after.periods.get("2025-05").completedCount, 2, "both May loads are delivered");
eq(after.periods.get("2025-05").grossRevenue, 3950, "May gross = 1850 + 2100");

eq(before.periods.get("2025-07").loadCount, 1, "old resolver saw only the ISO July load");
eq(after.periods.get("2025-07").loadCount, 2, "new resolver adds the RFC 2822 July load");
eq(before.periods.get("2025-07").grossRevenue, 580, "old July gross");
eq(after.periods.get("2025-07").grossRevenue, 580, "July gross unchanged — the added load is In Transit, so it earns nothing yet");
eq(after.periods.get("2025-07").completedCount, 1, "July completedCount unchanged");

eq(after.periods.get("2025-08").grossRevenue, 500, "August unaffected (US slash parsed by both)");
eq(before.periods.get("2025-08").grossRevenue, 500, "August identical before and after");

// The no-load-id row must stay excluded by BOTH — that guard is not what changed.
ok(![...after.periods.values()].some(b => b.grossRevenue === 777), "row without a load id stays excluded");

// Nothing that the old resolver could read may MOVE. This is the no-restatement
// property: the fix adds rows, it never re-dates one.
console.log("5. no-restatement — a cell both resolvers can read must resolve identically");
for (const r of ROWS) {
	const b = oldParseSheetDate(r.date), a = moneySheetDate(r.date);
	if (!b || isNaN(b)) continue;
	ok(a && !isNaN(a) && fmtDay(a) === fmtDay(b), `"${r.date}" must not move (was ${b && fmtDay(b)}, now ${a && fmtDay(a)})`);
}
// Same property over the wider corpus of shapes the old parser accepted.
for (const v of ["2026-04-09", "4/9/2026", "5/16/25", "12/31/2025", "1/1/2026", "2025-12-31"]) {
	const b = oldParseSheetDate(v), a = moneySheetDate(v);
	ok(b && a && fmtDay(a) === fmtDay(b), `"${v}" must resolve identically before and after (${b && fmtDay(b)} vs ${a && fmtDay(a)})`);
	ok(month(v) === fmtDay(b).slice(0, 7), `"${v}" must not change month`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
