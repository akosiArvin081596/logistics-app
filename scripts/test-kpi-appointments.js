#!/usr/bin/env node
/**
 * The KPI bot's on-time judge (lib/kpi-appointments.js): reading a drop-off
 * appointment and judging the truck's arrival against it.
 *
 * §1 kinds: timed (24-hour and AM/PM; 12 PM is noon, 12 AM midnight), window
 *    (judged at its end, including one past midnight), date only, FCFS,
 *    unparseable; prefixes stripped; the 200-character cap.
 * §2 zones: a zone written in the text wins, else the receiver's longitude band,
 *    never the business zone; no zone and no longitude is 'no_zone'.
 * §3 years: 2-digit is 20YY, a missing year takes the year nearest the arrival,
 *    and an appointment more than 3 days from the arrival is 'implausible'.
 * §4 arrivals: the ELD arrival when it is a real instant (0 is none), else the
 *    earliest geofence event read as UTC; a manual status is never an arrival.
 * §5 verdicts: strict (at or before the deadline), by day, and the ±1 h flip;
 *    both DST changes.
 * §6 the same battery in child processes under TZ=UTC, Asia/Tokyo and
 *    America/Los_Angeles: no answer may depend on the server's zone.
 * §7 MUTANTS, each run in all three zones: business zone for the receiver's,
 *    the written zone ignored, event stamps read as local time, a date-only
 *    appointment read as midnight, 12 PM read as 00:xx, a window's start for its
 *    end, `<=` turned into `<`, an ELD arrival of 0 accepted, the implausible
 *    guard removed, a manual "At Receiver" counted as an arrival.
 *
 * Fixtures are fake. Pure: no server, no files written.
 *
 * Run: node scripts/test-kpi-appointments.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "lib");
const SRC = fs.readFileSync(path.join(LIB, "kpi-appointments.js"), "utf8");
const CHILD = process.env.KPI_APPOINTMENTS_CHILD === "1";
const ZONES = ["UTC", "Asia/Tokyo", "America/Los_Angeles"];

function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function compileLib(src) {
	const filename = path.join(LIB, "kpi-appointments.js");
	const req = Module.createRequire(filename);
	const m = { exports: {} };
	new Function("module", "exports", "require", "__filename", "__dirname", src)(m, m.exports, req, filename, LIB);
	return m.exports;
}
function swap(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) die(`mutant anchor not found exactly once (${n}): ${from}`);
	return src.replace(from, () => to);
}

const MUTANTS = [
	["business zone used instead of the receiver's", "§2", "return usTzForLongitude(destLng);", "return \"America/New_York\";"],
	["zone written in the text ignored", "§2", "const fromText = zoneInText(s);", "const fromText = null;"],
	["event stamp read as local time", "§4", "const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));", "const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();"],
	["date-only read as midnight", "§1", "if (times.length === 0) return finish(\"date_only\");", "if (times.length === 0) times.push({ h: 0, mi: 0, start: 0, end: 0 });"],
	["12 PM read as 00:xx", "§1", "if (h === 12) return ap === \"a\" ? 0 : 12;", "if (h === 12) return 0;"],
	["window start instead of end", "§5", "const t = k === \"window\" ? windowEnd(times) : times[0];", "const t = times[0];"],
	["`<=` turned into `<`", "§5", "return arrival <= deadline;", "return arrival < deadline;"],
	["ELD arrival of 0 accepted", "§4", "eldArriveMs > 0) return eldArriveMs;", "eldArriveMs >= 0) return eldArriveMs;"],
	["implausible guard removed", "§3", "if (refDay && Math.abs(daysApart(refDay, day)) > PLAUSIBLE_DAYS) return fail(\"implausible\", k, zone, day);", ""],
	["manual \"At Receiver\" counted as an arrival", "§4", "if (!e || String(e.source == null ? \"\" : e.source).trim().toLowerCase() !== \"geofence\") continue;", "if (!e) continue;"],
];
// The event-stamp mutant reads "YYYY-MM-DD HH:MM:SS" in the process zone, which
// is UTC on the production server: only the other two zones can see it. That is
// why §6 exists.
const ZONE_BLIND = { "event stamp read as local time": ["UTC"] };

// ── fixtures ─────────────────────────────────────────────────────────────────
const LNG = { atlanta: -84.4, dallas: -96.8, denver: -104.99, losAngeles: -118.2, miami: -80.2 };
const Z = (iso) => Date.parse(iso);
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const geo = (at) => ({ at, source: "geofence" });

// ── the battery ──────────────────────────────────────────────────────────────
function battery(A) {
	const r = [];
	const t = (cond, name, detail) => r.push({ ok: !!cond, name: detail === undefined ? name : `${name} (${detail})` });
	const P = (text, lng, refDay) => A.parseAppointment(text, { destLng: lng, refDay });
	const J = (text, lng, arrival, extra) => A.judgeArrival({ appointmentText: text, destLng: lng, eldArriveMs: arrival, receiverEvents: [], deliveredDay: null, ...(extra || {}) });
	const parsed = (text, lng, kind, deadlineIso, day) => {
		const p = P(text, lng);
		t(p.status === "ok" && p.kind === kind && iso(p.deadlineMs) === deadlineIso && (!day || p.day === day),
			`§1 ${JSON.stringify(text)} -> ${kind}${deadlineIso ? ` by ${deadlineIso}` : ""}`, JSON.stringify({ ...p, deadline: iso(p.deadlineMs) }));
	};
	const unparseable = (text) => {
		const p = P(text, LNG.dallas);
		const j = J(text, LNG.dallas, Z("2026-10-01T12:00:00Z"));
		t(p.status === "unparseable" && p.kind === "unparseable" && j.status === "unparseable" && j.strictOnTime === null && j.dayOnTime === null && j.flipsWithin1h === false,
			`§1 ${JSON.stringify(text)} is unparseable`, JSON.stringify(p));
	};
	const verdict = (tag, j, status, strict, day, flips) => {
		t(j.status === status && j.strictOnTime === strict && j.dayOnTime === day && j.flipsWithin1h === flips, tag, JSON.stringify(j));
	};

	// §1 kinds
	parsed("10/1/2026 08:00", LNG.dallas, "timed", "2026-10-01T13:00:00.000Z", "2026-10-01");
	parsed("Appt: 10/2/2026 12:30 PM", LNG.dallas, "timed", "2026-10-02T17:30:00.000Z");
	parsed("10/3/2026 12:00 AM", LNG.dallas, "timed", "2026-10-03T05:00:00.000Z");
	parsed("10/3/2026 12:15 a.m.", LNG.dallas, "timed", "2026-10-03T05:15:00.000Z");
	parsed("10/3/2026 1:05 pm", LNG.dallas, "timed", "2026-10-03T18:05:00.000Z");
	parsed("8 AM 10/12/2026", LNG.dallas, "timed", "2026-10-12T13:00:00.000Z");
	parsed("Delivery: 10/5/2026 08:00-14:00", LNG.dallas, "window", "2026-10-05T19:00:00.000Z");
	parsed("10/6/2026 8:00 AM - 2:00 PM", LNG.dallas, "window", "2026-10-06T19:00:00.000Z");
	parsed("10/7/2026 0800-1600", LNG.dallas, "window", "2026-10-07T21:00:00.000Z");
	parsed("10/7/2026 08:00 to 16:00", LNG.dallas, "window", "2026-10-07T21:00:00.000Z");
	parsed("10/10/2026 22:00-02:00", LNG.dallas, "window", "2026-10-11T07:00:00.000Z");
	parsed("10/8/2026", LNG.dallas, "date_only", null, "2026-10-08");
	parsed("Date: 10/8/2026", LNG.dallas, "date_only", null, "2026-10-08");
	parsed("10/9/2026 FCFS 07:00-15:00", LNG.dallas, "fcfs", null, "2026-10-09");
	parsed("10/9/2026 First come, first served", LNG.dallas, "fcfs", null, "2026-10-09");
	parsed("2026-09-28 14:00", LNG.dallas, "timed", "2026-09-28T19:00:00.000Z");
	parsed("10/1/26 08:00", LNG.dallas, "timed", "2026-10-01T13:00:00.000Z");
	for (const u of ["TBD", "", null, "Call for appointment", "10/32/2026 08:00", "13/1/2026 08:00", "08:00", "10/1/2026 08:00 09:00 10:00", "10/1/2026 25:00", "10/1/2026 13:00 PM", "10/1/2026 08:00 11:00"]) {
		unparseable(u);
	}
	parsed(`10/1/2026 08:00${" ".repeat(300)}PST`, LNG.dallas, "timed", "2026-10-01T13:00:00.000Z");
	{
		const long = "1:1:1/1/1 ".repeat(20000);
		const t0 = Date.now();
		A.judgeArrival({ appointmentText: long, destLng: LNG.dallas, eldArriveMs: 1, receiverEvents: [] });
		t(Date.now() - t0 < 50, "§1 a 200,000-character appointment is cut to 200 first");
	}
	{
		const d = J("10/8/2026", LNG.dallas, Z("2026-10-08T20:00:00Z"));
		verdict("§1 a date-only appointment is judged by day, never against midnight", d, "judged", null, true, false);
		t(d.kind === "date_only", "§1 ...and stays date_only", d.kind);
		const noon = J("Appt: 10/2/2026 12:30 PM", LNG.losAngeles, Z("2026-10-02T19:15:00Z"));
		verdict("§1 12:15 PDT for a 12:30 PM appointment is on time", noon, "judged", true, true, true);
	}

	// §2 zones
	{
		const p = P("10/1/2026 08:00 CST", LNG.losAngeles);
		t(p.zone === "America/Chicago" && iso(p.deadlineMs) === "2026-10-01T13:00:00.000Z", "§2 CST in the text beats a Los Angeles receiver (and follows daylight time)", JSON.stringify(p));
		t(P("10/1/2026 08:00 Eastern", LNG.losAngeles).zone === "America/New_York", "§2 'Eastern' in the text");
		const pt = P("10/1/2026 08:00 PT", null);
		t(pt.status === "ok" && pt.zone === "America/Los_Angeles" && iso(pt.deadlineMs) === "2026-10-01T15:00:00.000Z", "§2 a written zone needs no receiver longitude", JSON.stringify(pt));
		t(P("10/1/2026 08:00 dock appt", LNG.dallas).zone === "America/Chicago", "§2 'appt' is not PT");
		t(P("10/1/2026 08:00", LNG.atlanta).zone === "America/New_York" && P("10/1/2026 08:00", LNG.dallas).zone === "America/Chicago"
			&& P("10/1/2026 08:00", LNG.denver).zone === "America/Denver" && P("10/1/2026 08:00", LNG.losAngeles).zone === "America/Los_Angeles", "§2 longitude bands");
		const nz = J("10/1/2026 08:00", null, Z("2026-10-01T12:00:00Z"));
		verdict("§2 no written zone and no longitude: no_zone", nz, "no_zone", null, null, false);
		t(P("10/1/2026 08:00", null).status === "no_zone" && P("10/1/2026 08:00", NaN).status === "no_zone", "§2 parseAppointment says no_zone too");
		const la = J("10/1/2026 08:00", LNG.losAngeles, Z("2026-10-01T14:30:00Z"));
		verdict("§2 07:30 PDT at a Los Angeles receiver is on time for 08:00 (not judged on Eastern time)", la, "judged", true, true, true);
		const cst = J("10/1/2026 08:00 CST", LNG.losAngeles, Z("2026-10-01T14:00:00Z"));
		verdict("§2 09:00 CDT is late for '08:00 CST', whatever the receiver's longitude", cst, "judged", false, true, true);
	}

	// §3 years
	{
		verdict("§3 an invented 2020 year is implausible", J("10/1/2020 08:00", LNG.dallas, Z("2026-10-01T12:00:00Z")), "implausible", null, null, false);
		verdict("§3 4 days after the arrival is implausible", J("10/5/2026 08:00", LNG.dallas, Z("2026-10-01T12:00:00Z")), "implausible", null, null, false);
		verdict("§3 3 days after is judged", J("10/4/2026 08:00", LNG.dallas, Z("2026-10-01T12:00:00Z")), "judged", true, true, false);
		verdict("§3 3 days before is judged (late)", J("9/28/2026 08:00", LNG.dallas, Z("2026-10-01T12:00:00Z")), "judged", false, false, false);
		verdict("§3 no year: the year nearest the arrival", J("10/1 08:00", LNG.dallas, Z("2026-10-01T12:30:00Z")), "judged", true, true, true);
		verdict("§3 no year across New Year: 12/31 is the day before a January 1 arrival", J("12/31 08:00", LNG.dallas, Z("2027-01-01T15:00:00Z")), "judged", false, false, false);
		t(P("1/1/27 08:00", LNG.dallas).day === "2027-01-01", "§3 a 2-digit year is 20YY");
		t(P("10/1 08:00", LNG.dallas).status === "unparseable", "§3 no year and no arrival day to anchor it: unparseable");
		const anchoredByDelivery = A.judgeArrival({ appointmentText: "10/1 08:00", destLng: LNG.dallas, eldArriveMs: null, receiverEvents: [], deliveredDay: "2026-10-01" });
		verdict("§3 no arrival: the delivered day anchors the year, the load is no_arrival", anchoredByDelivery, "no_arrival", null, null, false);
	}

	// §4 arrivals
	{
		t(A.utcStampMs("2026-10-01 12:50:00") === Date.UTC(2026, 9, 1, 12, 50) && A.utcStampMs("2026-10-01T12:50:00Z") === Date.UTC(2026, 9, 1, 12, 50)
			&& A.utcStampMs("2026-10-01 12:50") === Date.UTC(2026, 9, 1, 12, 50) && A.utcStampMs("yesterday") === null && A.utcStampMs(null) === null,
			"§4 event stamps are UTC with or without the Z");
		t(A.arrivalMs(Z("2026-10-01T12:00:00Z"), [geo("2026-10-01 10:00:00")]) === Z("2026-10-01T12:00:00Z"), "§4 the ELD arrival wins over a geofence event");
		t(A.arrivalMs(0, []) === null && A.arrivalMs(null, []) === null && A.arrivalMs(NaN, []) === null, "§4 an ELD arrival of 0, null or NaN is no arrival");
		verdict("§4 ELD arrival 0 and no events: no_arrival", J("10/1/2026 08:00", LNG.dallas, 0), "no_arrival", null, null, false);
		verdict("§4 ELD arrival 0: the geofence event is the arrival", J("10/1/2026 08:00", LNG.dallas, 0, { receiverEvents: [geo("2026-10-01 12:30:00")] }), "judged", true, true, true);
		const early = J("10/1/2026 08:00", LNG.dallas, null, { receiverEvents: [geo("2026-10-01 12:50:00")] });
		verdict("§4 a geofence stamp of 12:50 is 12:50 UTC (07:50 CDT): on time", early, "judged", true, true, true);
		const late = J("10/1/2026 08:00", LNG.dallas, null, { receiverEvents: [geo("2026-10-01 13:20:00")] });
		verdict("§4 a geofence stamp of 13:20 is 13:20 UTC (08:20 CDT): late", late, "judged", false, true, true);
		const manual = J("10/1/2026 08:00", LNG.dallas, null, { receiverEvents: [{ at: "2026-10-01 12:00:00", source: "manual" }, geo("2026-10-01 14:10:00")] });
		verdict("§4 a manual status before the geofence arrival is not the arrival", manual, "judged", false, true, false);
		verdict("§4 a manual status alone is no arrival", J("10/1/2026 08:00", LNG.dallas, null, { receiverEvents: [{ at: "2026-10-01 12:00:00", source: "manual" }] }), "no_arrival", null, null, false);
		verdict("§4 the earliest geofence event counts", J("10/1/2026 08:00", LNG.dallas, null, { receiverEvents: [geo("2026-10-01 15:00:00"), geo("2026-10-01 12:40:00"), geo("bad")] }), "judged", true, true, true);
		t(A.arrivalMs(null, [{ at: "2026-10-01 12:40:00", source: " Geofence " }]) === Z("2026-10-01T12:40:00Z"), "§4 the source is read trimmed, any case");
	}

	// §5 verdicts
	{
		const at = (isoTime) => J("10/1/2026 08:00", LNG.dallas, Z(isoTime));
		verdict("§5 15 minutes early: on time, and an hour earlier deadline would flip it", at("2026-10-01T12:45:00Z"), "judged", true, true, true);
		verdict("§5 exactly at the deadline is on time", at("2026-10-01T13:00:00Z"), "judged", true, true, true);
		verdict("§5 one minute late", at("2026-10-01T13:01:00Z"), "judged", false, true, true);
		verdict("§5 exactly an hour early does not flip", at("2026-10-01T12:00:00Z"), "judged", true, true, false);
		verdict("§5 3.5 hours late, same day", at("2026-10-01T16:30:00Z"), "judged", false, true, false);
		verdict("§5 the next morning: late by day too", at("2026-10-02T14:00:00Z"), "judged", false, false, false);
		verdict("§5 inside an 08:00-14:00 window is on time (judged at its end)", J("Delivery: 10/5/2026 08:00-14:00", LNG.dallas, Z("2026-10-05T17:00:00Z")), "judged", true, true, false);
		verdict("§5 after the window's end is late", J("Delivery: 10/5/2026 08:00-14:00", LNG.dallas, Z("2026-10-05T19:30:00Z")), "judged", false, true, true);
		verdict("§5 01:30 inside a 22:00-02:00 window: on time, but the next day", J("10/10/2026 22:00-02:00", LNG.dallas, Z("2026-10-11T06:30:00Z")), "judged", true, false, true);
		verdict("§5 FCFS is judged by day", J("10/9/2026 FCFS 07:00-15:00", LNG.atlanta, Z("2026-10-10T01:00:00Z")), "judged", null, true, false);
		verdict("§5 FCFS a day late", J("10/9/2026 FCFS", LNG.atlanta, Z("2026-10-10T15:00:00Z")), "judged", null, false, false);
		verdict("§5 fall back (2026-11-01): 08:30 EST is on time for 09:00", J("11/1/2026 09:00", LNG.miami, Z("2026-11-01T13:30:00Z")), "judged", true, true, true);
		verdict("§5 spring forward (2026-03-08): 08:45 CDT is on time for 09:00", J("3/8/2026 09:00", LNG.dallas, Z("2026-03-08T13:45:00Z")), "judged", true, true, true);
		verdict("§5 spring forward: 09:15 CDT is late", J("3/8/2026 09:00", LNG.dallas, Z("2026-03-08T14:15:00Z")), "judged", false, true, true);
	}
	return r;
}

function runAll() {
	const real = battery(compileLib(SRC));
	const mutants = {};
	for (const [name, section, from, to] of MUTANTS) {
		let results;
		try {
			results = battery(compileLib(swap(SRC, from, to)));
		} catch (e) {
			results = [{ ok: false, name: `${section} the mutant threw: ${e && e.message}` }];
		}
		mutants[name] = results.filter((x) => !x.ok && x.name.startsWith(section)).map((x) => x.name);
	}
	return { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, real, mutants };
}

if (CHILD) {
	process.stdout.write(`${JSON.stringify(runAll())}\n`);
	process.exit(0);
}

// ── parent ───────────────────────────────────────────────────────────────────
const started = Date.now();
let pass = 0;
const failures = [];
const ok = (cond, name) => { if (cond) pass++; else failures.push(name); };

const here = runAll();
const bySection = new Map();
for (const x of here.real) {
	const s = (x.name.match(/^§\d+/) || ["§?"])[0];
	if (!bySection.has(s)) bySection.set(s, { ok: 0, n: 0 });
	bySection.get(s).n++;
	if (x.ok) bySection.get(s).ok++;
	ok(x.ok, x.name);
}
for (const [s, e] of bySection) console.log(`${s}: ${e.ok}/${e.n} checks (TZ ${here.zone})`);

console.log("\n§6 the same checks in three process zones");
const children = {};
for (const zone of ZONES) {
	const res = spawnSync(process.execPath, [__filename], {
		env: { ...process.env, TZ: zone, KPI_APPOINTMENTS_CHILD: "1" }, encoding: "utf8", timeout: 20000,
	});
	let parsed = null;
	try {
		parsed = JSON.parse(String(res.stdout || "").trim());
	} catch (_e) {
		parsed = null;
	}
	ok(parsed && res.status === 0, `§6 TZ=${zone}: the child ran (${res.status} ${String(res.stderr || "").slice(0, 200)})`);
	if (!parsed) continue;
	children[zone] = parsed;
	const bad = parsed.real.filter((x) => !x.ok);
	ok(bad.length === 0, `§6 TZ=${zone}: every check passes (${bad.map((x) => x.name).join("; ")})`);
	const sameAsHere = JSON.stringify(parsed.real.map((x) => x.name)) === JSON.stringify(here.real.map((x) => x.name));
	ok(sameAsHere, `§6 TZ=${zone}: the same answers as this process`);
	console.log(`  TZ=${zone.padEnd(19)} ${parsed.real.length - bad.length}/${parsed.real.length} checks${sameAsHere ? ", identical answers" : ""}`);
}

console.log("\n§7 mutants (caught in: UTC / Asia/Tokyo / America/Los_Angeles)");
for (const [name, section] of MUTANTS) {
	const blind = ZONE_BLIND[name] || [];
	const row = ZONES.map((zone) => {
		const c = children[zone];
		const caught = !!(c && c.mutants[name] && c.mutants[name].length);
		const expected = !blind.includes(zone);
		ok(caught === expected, `§7 MUTANT ${name}: ${expected ? "not caught" : "unexpectedly caught"} by ${section} under TZ=${zone}`);
		return caught ? "caught" : (expected ? "MISSED" : "blind (expected)");
	});
	console.log(`  ${name}: ${row.join(" / ")}`);
}

const ms = Date.now() - started;
if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed (${ms} ms)`);
	process.exit(1);
}
console.log(`\n✓ ${pass} assertions passed (${ms} ms)`);
