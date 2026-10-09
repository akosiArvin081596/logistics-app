#!/usr/bin/env node
/**
 * lib/kpi-schedule.js: when the KPI bot's nightly snapshot and weekly digest
 * are due, on the business clock (APP_TIMEZONE), whatever zone the server runs
 * in.
 *
 * §1 snapshotSlot(): 04:00 business time on the business day; 04:00 Eastern is
 *    03:00 Central in winter and in summer; due at the slot instant itself.
 * §2 snapshotDue(): due once a day after 04:00, caught up later the same
 *    business day, never before 04:00, never twice; across both DST Sundays.
 * §3 digestSlot(): Monday 09:00 of the business week (09:00 Eastern = 08:00
 *    Central in both regimes); a late-Sunday instant belongs to the week that
 *    started the Monday before, across 2026-03-08 and 2026-11-01.
 * §4 digestDue(): due from 09:00 for 6 hours, then missed; a decided slot is
 *    never due again.
 * §5 nextSnapshotAt() / nextDigestAt().
 * §6 every check above, run again in child processes under TZ=UTC and
 *    TZ=Asia/Tokyo: identical answers (the server's own zone never leaks in).
 * §7 MUTANTS: the server's getDay(); "minus 24 h" day stepping (backwards for
 *    the digest week, forwards for the next snapshot); `>` for `>=` at the
 *    slot; the 6-hour catch-up limit removed; the slot computed in the
 *    server's zone. Each mutant is compiled from the module's source and run in
 *    process and in both child zones; at least one check must fail.
 *
 * Pure: no server, no database, no network; children get the module source on
 * stdin and write nothing.
 *
 * Run: node scripts/test-kpi-schedule.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "lib", "kpi-schedule.js");
const NY = "America/New_York";
const CHI = "America/Chicago";

function loadFrom(src) {
	const m = new Module(LIB, module);
	m.filename = LIB;
	m.paths = Module._nodeModulePaths(path.dirname(LIB));
	m._compile(src, LIB);
	return m.exports;
}

// Every assertion, as data: [{ ok, name }]. Run in this process and in children.
function checks(s) {
	const appTime = require(path.join(ROOT, "lib", "app-time.js"));
	const out = [];
	const t = (cond, name) => out.push({ ok: !!cond, name });
	const at = (iso) => Date.parse(iso);
	const wall = (tz, y, mo, d, h) => appTime.wallClockToMs(tz, y, mo, d, h, 0, 0);

	// §1
	const winter = s.snapshotSlot(at("2026-01-15T12:00:00Z"), NY);
	t(winter.day === "2026-01-15" && winter.slotMs === at("2026-01-15T09:00:00Z"), "§1 winter: the slot is 04:00 EST (09:00 UTC) on the business day");
	t(winter.slotMs === wall(CHI, 2026, 1, 15, 3), "§1 winter: 04:00 Eastern is 03:00 Central");
	const summer = s.snapshotSlot(at("2026-07-15T12:00:00Z"), NY);
	t(summer.slotMs === at("2026-07-15T08:00:00Z"), "§1 summer: the slot is 04:00 EDT (08:00 UTC)");
	t(summer.slotMs === wall(CHI, 2026, 7, 15, 3), "§1 summer: 04:00 Eastern is 03:00 Central");
	t(s.snapshotSlot(at("2026-07-15T08:00:00Z"), NY).due === true, "§1 due AT the slot instant (>=)");
	t(s.snapshotSlot(at("2026-07-15T07:59:59.999Z"), NY).due === false, "§1 not due a millisecond before");
	const lateEvening = s.snapshotSlot(at("2026-07-15T03:30:00Z"), NY);
	t(lateEvening.day === "2026-07-14" && lateEvening.due === true, "§1 23:30 EDT is still the business day before (the UTC date is already the next)");

	// §2
	const afterSlot = at("2026-07-15T10:00:00Z");
	t(s.snapshotDue({ nowMs: afterSlot, tz: NY, lastSnapshotDay: null }).due === true, "§2 never run: due after 04:00");
	t(s.snapshotDue({ nowMs: afterSlot, tz: NY, lastSnapshotDay: "2026-07-15" }).due === false, "§2 already taken today: not due");
	t(s.snapshotDue({ nowMs: at("2026-07-15T06:00:00Z"), tz: NY, lastSnapshotDay: "2026-07-13" }).due === false, "§2 02:00, yesterday missed: not due (no back-dated run)");
	const catchUp = s.snapshotDue({ nowMs: at("2026-07-15T19:00:00Z"), tz: NY, lastSnapshotDay: "2026-07-14" });
	t(catchUp.due === true && catchUp.day === "2026-07-15", "§2 15:00, today's slot missed: caught up for today");
	t(s.snapshotSlot(at("2026-03-08T12:00:00Z"), NY).slotMs === at("2026-03-08T08:00:00Z"), "§2 2026-03-08 (clocks forward at 02:00): 04:00 EDT");
	t(s.snapshotSlot(at("2026-11-01T12:00:00Z"), NY).slotMs === at("2026-11-01T09:00:00Z"), "§2 2026-11-01 (clocks back at 02:00): 04:00 EST");
	t(s.snapshotDue({ nowMs: at("2026-11-01T08:30:00Z"), tz: NY, lastSnapshotDay: "2026-10-31" }).due === false, "§2 2026-11-01 03:30 EST: not yet due");

	// §3
	const monWinter = s.digestSlot(at("2026-01-12T20:00:00Z"), NY);
	t(monWinter.slotKey === "digest:2026-01-12" && monWinter.slotMs === at("2026-01-12T14:00:00Z"), "§3 winter Monday: 09:00 EST");
	t(monWinter.slotMs === wall(CHI, 2026, 1, 12, 8), "§3 winter: Monday 09:00 Eastern is 08:00 Central");
	const monSummer = s.digestSlot(at("2026-07-13T20:00:00Z"), NY);
	t(monSummer.slotMs === at("2026-07-13T13:00:00Z") && monSummer.slotMs === wall(CHI, 2026, 7, 13, 8), "§3 summer Monday: 09:00 EDT is 08:00 CDT");
	t(s.digestSlot(at("2026-10-12T02:00:00Z"), NY).slotKey === "digest:2026-10-05", "§3 Sunday 22:00 EDT (Monday in UTC) is the week of Monday Oct 5");
	t(s.digestSlot(at("2026-10-14T15:00:00Z"), NY).slotKey === "digest:2026-10-12", "§3 a Wednesday is the week of that Monday");
	t(s.digestSlot(at("2026-11-02T04:30:00Z"), NY).slotKey === "digest:2026-10-26", "§3 Sunday 2026-11-01 23:30 EST (after clocks went back): week of Oct 26");
	t(s.digestSlot(at("2026-03-09T03:30:00Z"), NY).slotKey === "digest:2026-03-02", "§3 Sunday 2026-03-08 23:30 EDT (after clocks went forward): week of Mar 2");

	// §4
	const slot = at("2026-10-12T13:00:00Z");
	t(s.digestDue({ nowMs: slot, tz: NY, lastSlotKey: "digest:2026-10-05" }).due === true, "§4 due AT Monday 09:00");
	t(s.digestDue({ nowMs: slot - 1, tz: NY, lastSlotKey: "digest:2026-10-05" }).due === false, "§4 not due at 08:59:59.999");
	t(s.digestDue({ nowMs: slot + 6 * 3600000, tz: NY, lastSlotKey: "digest:2026-10-05" }).due === true, "§4 still due 6 h after");
	const late = s.digestDue({ nowMs: slot + 6 * 3600000 + 1, tz: NY, lastSlotKey: "digest:2026-10-05" });
	t(late.due === false && late.missed === true, "§4 more than 6 h after: missed, not due");
	const tuesday = s.digestDue({ nowMs: at("2026-10-13T14:00:00Z"), tz: NY, lastSlotKey: "digest:2026-10-05" });
	t(tuesday.due === false && tuesday.missed === true && tuesday.slotKey === "digest:2026-10-12", "§4 Tuesday: this week's slot is missed");
	const decided = s.digestDue({ nowMs: slot + 3600000, tz: NY, lastSlotKey: "digest:2026-10-12" });
	t(decided.due === false && decided.missed === false, "§4 a slot already recorded is neither due nor missed");
	t(s.digestDue({ nowMs: slot + 3600000, tz: NY, lastSlotKey: null }).due === true, "§4 no slot recorded yet: due");

	// §5
	t(s.nextSnapshotAt(at("2026-03-08T04:30:00Z"), NY) === "2026-03-08T08:00:00.000Z", "§5 Saturday 23:30 EST: next snapshot is Sunday 04:00 EDT (2026-03-08)");
	t(s.nextSnapshotAt(at("2026-07-15T07:00:00Z"), NY) === "2026-07-15T08:00:00.000Z", "§5 03:00: next snapshot is today's");
	t(s.nextSnapshotAt(at("2026-10-31T13:00:00Z"), NY) === "2026-11-01T09:00:00.000Z", "§5 the day before clocks go back: next is 04:00 EST");
	t(s.nextDigestAt(at("2026-10-26T14:00:00Z"), NY) === "2026-11-02T14:00:00.000Z", "§5 Monday 10:00 EDT: next digest is Monday 09:00 EST");
	t(s.nextDigestAt(at("2026-10-12T12:00:00Z"), NY) === "2026-10-12T13:00:00.000Z", "§5 Monday 08:00: next digest is today's");
	return out;
}

if (process.argv[2] === "--child") {
	const src = fs.readFileSync(0, "utf8");
	process.stdout.write(JSON.stringify(checks(loadFrom(src))));
	process.exit(0);
}

function inZone(src, tz) {
	const r = spawnSync(process.execPath, [__filename, "--child"], { input: src, env: { ...process.env, TZ: tz }, encoding: "utf8", timeout: 20000 });
	if (r.status !== 0) return [{ ok: false, name: `child under TZ=${tz} exited ${r.status}: ${(r.stderr || "").trim().split("\n")[0]}` }];
	try { return JSON.parse(r.stdout); } catch { return [{ ok: false, name: `child under TZ=${tz} wrote no result` }]; }
}

let pass = 0;
const failures = [];
function record(results, label) {
	for (const x of results) { if (x.ok) pass++; else failures.push(`${label ? `[${label}] ` : ""}${x.name}`); }
	console.log(`  ${results.filter((x) => x.ok).length}/${results.length} checks${label ? ` (${label})` : ""}`);
}
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }

const SRC = fs.readFileSync(LIB, "utf8");

console.log("\n§1–§5 lib/kpi-schedule.js, in this process");
record(checks(loadFrom(SRC)));

console.log("\n§6 the same checks under other server zones");
for (const tz of ["UTC", "Asia/Tokyo"]) {
	const results = inZone(SRC, tz);
	record(results, `TZ=${tz}`);
}

console.log("\n§7 MUTANTS");
{
	const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };
	const caught = (src) => {
		const all = [...checks(loadFrom(src)), ...inZone(src, "UTC"), ...inZone(src, "Asia/Tokyo")];
		return all.some((x) => !x.ok);
	};
	const mutants = [
		["the server's getDay() instead of the business day's weekday",
			swap(SRC, "const sinceMonday = (weekdayOf(today) + 6) % 7;", "const sinceMonday = (new Date(nowMs).getDay() + 6) % 7;")],
		["the digest week found by stepping the instant back 24 h a day",
			swap(SRC, "const monday = addDays(today, -sinceMonday);", "const monday = dayInZone(new Date(nowMs - sinceMonday * 86400000), tz);")],
		["the next snapshot day found by stepping the instant on 24 h",
			swap(SRC, "const next = addDays(slot.day, 1);", "const next = dayInZone(new Date(nowMs + 86400000), tz);")],
		["`>` instead of `>=` at the snapshot slot",
			swap(SRC, "due: nowMs >= slotMs", "due: nowMs > slotMs")],
		["`<=` instead of `<` before the digest slot",
			swap(SRC, "if (decided || nowMs < slot.slotMs)", "if (decided || nowMs <= slot.slotMs)")],
		["the digest's 6-hour catch-up limit removed",
			swap(SRC, "if (nowMs - slot.slotMs > DIGEST_CATCH_UP_MS)", "if (false)")],
		["the slot computed in the server's own zone",
			swap(SRC, "return wallClockToMs(tz, y, m, d, hour, 0, 0);", "return new Date(y, m - 1, d, hour).getTime();")],
	];
	const r = mutants.map(([name, src]) => ({ ok: caught(src), name: `MUTANT ${name}: caught` }));
	record(r);
}

if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`\n✓ ${pass} assertions passed`);
