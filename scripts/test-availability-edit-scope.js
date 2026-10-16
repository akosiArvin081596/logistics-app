#!/usr/bin/env node
// R11 follow-up: what the staff panel is told it may change agrees with what the
// server accepts. GET /api/drivers-directory/:id/availability sends each row's
// `editable` ("full" | "end_early" | "none") and `limits` ({ fromMin, toMin,
// toMax }, null = no limit; null on "none"), and `createLimits` ({ fromMin,
// toMin: null }) for the add form, from lib/driver-availability.js
// availabilityEditScope(), availabilityEditLimits() and availabilityCreateLimits().
// validateAvailability() stays the authority. This runner checks the two agree:
//
//   §1 the cases the client was built against (the contract's table), both roles
//   §2 every edit over a grid of calendar days: today fixed, every live row and
//      every candidate (from, to) with both ends in today-35..today+5, both
//      roles, plus a kind change, a reason change and a cancel per row:
//      "allowed by editable and limits" equals validateAvailability(...).ok,
//      case by case. Run for 2026-10-15, across a year end (2027-01-03) and
//      after a leap day (2028-03-01)
//   §3 every create over the same grid, by createLimits
//   §4 a cancelled row, and a today that can't be read
//
// "Allowed by editable and limits" is what the panel lets a caller send: on
// "full" any field, the first day from fromMin, the last day from the later of
// the first day and toMin, up to toMax; on "end_early" only the last day, from
// toMin to toMax; on "none" nothing; a cancel only on "full". Plus the one rule
// limits don't carry, which the server answers in words: at most 60 days (the
// grid's ranges are at most 41 days, so it never decides a case here).
//
// Pure: no server, database or network. Every date is a calendar day.
// Run: node scripts/test-availability-edit-scope.js

"use strict";

const path = require("path");
const A = require(path.join(__dirname, "..", "lib", "driver-availability"));

let passed = 0;
const failures = [];
const ok = (name, cond, detail) => {
	if (cond) { passed++; return; }
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (name, a, e) => ok(name, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

const HAS = ["availabilityEditScope", "availabilityEditLimits", "availabilityCreateLimits"].every((n) => typeof A[n] === "function");
ok("§0 lib/driver-availability.js exports availabilityEditScope(), availabilityEditLimits() and availabilityCreateLimits()", HAS);

const shift = A.shiftAvailabilityDay;
const later = (a, b) => (a == null ? b : b == null ? a : a > b ? a : b);
const span = (from, to) => (Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86400000 + 1;
const row = (from, to, extra = {}) => ({ id: 1, kind: "vacation", from_date: from, to_date: to, reason: "Family", cancelled_at: null, ...extra });
const ROLES = [["Super Admin", true], ["Dispatcher", false]];

// What the panel lets a caller send for `cand` ({ kind, from, to, reason }) on `r`.
function panelAllows(r, mode, limits, cand) {
	if (mode === "none" || !limits) return false;
	if (span(cand.from, cand.to) > A.AVAILABILITY_MAX_DAYS) return false;
	if (mode === "end_early") {
		if (cand.kind !== r.kind || cand.from !== r.from_date || cand.reason !== r.reason) return false;
		return cand.to >= later(r.from_date, limits.toMin) && (limits.toMax == null || cand.to <= limits.toMax);
	}
	if (mode !== "full") return false;
	if (limits.fromMin != null && cand.from < limits.fromMin) return false;
	if (cand.to < later(cand.from, limits.toMin)) return false;
	return limits.toMax == null || cand.to <= limits.toMax;
}

function gridAgreement(today) {
	const days = [];
	for (let n = -35; n <= 5; n++) days.push(shift(today, n));
	const misses = [];
	let cases = 0;
	const check = (label, allowed, valid) => {
		cases++;
		if (allowed !== valid && misses.length < 8) misses.push(`${label}: panel ${allowed ? "allows" : "refuses"}, server ${valid ? "accepts" : "refuses"}`);
	};
	for (const [role, isSuperAdmin] of ROLES) {
		const ctx = { todayKey: today, isSuperAdmin };
		for (let i = 0; i < days.length; i++) {
			for (let j = i; j < days.length; j++) {
				const r = row(days[i], days[j]);
				const mode = A.availabilityEditScope(r, ctx);
				const limits = A.availabilityEditLimits(r, ctx);
				const tag = `${role} row ${r.from_date}..${r.to_date} (${mode})`;
				if ((mode === "none") !== (limits === null)) check(`${tag}: limits null exactly on "none"`, true, false);
				for (const from of days) {
					for (const to of days) {
						const cand = { kind: r.kind, from, to, reason: r.reason };
						check(`${tag} -> ${from}..${to}`, panelAllows(r, mode, limits, cand),
							A.validateAvailability({ from, to }, { ...ctx, existing: r }).ok);
					}
				}
				const kind = { kind: "off_duty", from: r.from_date, to: r.to_date, reason: r.reason };
				check(`${tag} kind -> off_duty`, panelAllows(r, mode, limits, kind), A.validateAvailability({ kind: "off_duty" }, { ...ctx, existing: r }).ok);
				const reason = { kind: r.kind, from: r.from_date, to: r.to_date, reason: "Personal" };
				check(`${tag} reason -> Personal`, panelAllows(r, mode, limits, reason), A.validateAvailability({ reason: "Personal" }, { ...ctx, existing: r }).ok);
				check(`${tag} cancel`, mode === "full", A.validateAvailability({}, { ...ctx, existing: r }).ok);
			}
		}
		const create = A.availabilityCreateLimits(ctx);
		for (const from of days) {
			for (const to of days) {
				const allowed = !!create && (create.fromMin == null || from >= create.fromMin) && to >= later(from, create.toMin) && span(from, to) <= A.AVAILABILITY_MAX_DAYS;
				check(`${role} create ${from}..${to}`, allowed, A.validateAvailability({ kind: "vacation", from, to, reason: "" }, ctx).ok);
			}
		}
	}
	return { cases, misses };
}

if (HAS) {
	const started = Date.now();
	console.log("\n── §1 the contract's cases (today 2026-10-15: floor Sep 15, yesterday Oct 14)");
	{
		const TODAY = "2026-10-15";
		const SA = { todayKey: TODAY, isSuperAdmin: true };
		const DISP = { todayKey: TODAY, isSuperAdmin: false };
		const NONE = { fromMin: null, toMin: null, toMax: null };
		const both = (r, ctx) => [A.availabilityEditScope(r, ctx), A.availabilityEditLimits(r, ctx)];
		for (const [label, r] of [["a recent row", row("2026-10-05", "2026-10-25")], ["an old live row", row("2026-09-10", "2026-10-25")],
			["an old ended row", row("2026-09-01", "2026-09-12")], ["a row two years back", row("2024-10-01", "2024-10-02")]]) {
			eq(`§1.1 Super Admin, ${label}: "full", no limits`, both(r, SA), ["full", NONE]);
		}
		eq("§1.2 Dispatcher, a row starting on the floor (Sep 15 - Oct 25): \"full\", toMin yesterday",
			both(row("2026-09-15", "2026-10-25"), DISP), ["full", { fromMin: "2026-09-15", toMin: "2026-10-14", toMax: null }]);
		eq("§1.3 Dispatcher, a recent row that ended (Sep 20 - Oct 2): \"full\", toMin its own end (toMin never folds in the start)",
			both(row("2026-09-20", "2026-10-02"), DISP), ["full", { fromMin: "2026-09-15", toMin: "2026-10-02", toMax: null }]);
		eq("§1.4 Dispatcher, an upcoming row (Nov 1-3): \"full\", toMin yesterday",
			both(row("2026-11-01", "2026-11-03"), DISP), ["full", { fromMin: "2026-09-15", toMin: "2026-10-14", toMax: null }]);
		eq("§1.5 Dispatcher, a row starting the day before the floor and running past today (Sep 14 - Oct 25): \"end_early\"",
			both(row("2026-09-14", "2026-10-25"), DISP), ["end_early", { fromMin: null, toMin: "2026-10-14", toMax: "2026-10-24" }]);
		eq("§1.6 Dispatcher, an old row ending today (Sep 10 - Oct 15): \"end_early\", only yesterday left",
			both(row("2026-09-10", "2026-10-15"), DISP), ["end_early", { fromMin: null, toMin: "2026-10-14", toMax: "2026-10-14" }]);
		eq("§1.7 Dispatcher, an old row that ended yesterday (Sep 10 - Oct 14): \"none\"", both(row("2026-09-10", "2026-10-14"), DISP), ["none", null]);
		eq("§1.8 createLimits: Super Admin none; Dispatcher from the floor",
			[A.availabilityCreateLimits(SA), A.availabilityCreateLimits(DISP)], [{ fromMin: null, toMin: null }, { fromMin: "2026-09-15", toMin: null }]);
	}

	console.log("\n── §2 / §3 every edit and every create over the grid, both roles");
	for (const today of ["2026-10-15", "2027-01-03", "2028-03-01"]) {
		const { cases, misses } = gridAgreement(today);
		eq(`§2 today ${today}: the panel's limits and the validator agree on all ${cases} cases`, misses, []);
	}

	console.log("\n── §4 a cancelled row, and a today that can't be read");
	{
		const cancelled = row("2026-10-14", "2026-10-20", { cancelled_at: "2026-10-12T12:00:00Z" });
		for (const [role, isSuperAdmin] of ROLES) {
			const ctx = { todayKey: "2026-10-15", isSuperAdmin };
			eq(`§4.1 ${role}, a cancelled row: "none", limits null`, [A.availabilityEditScope(cancelled, ctx), A.availabilityEditLimits(cancelled, ctx)], ["none", null]);
			eq(`§4.2 ...and the validator refuses it (409 AVAILABILITY_CANCELLED)`, A.validateAvailability({}, { ...ctx, existing: cancelled }).code, "AVAILABILITY_CANCELLED");
		}
		const blind = { todayKey: "", isSuperAdmin: false };
		eq("§4.3 Dispatcher, today unreadable: every row \"none\", limits and createLimits null",
			[A.availabilityEditScope(row("2026-10-14", "2026-10-20"), blind), A.availabilityEditLimits(row("2026-10-14", "2026-10-20"), blind), A.availabilityCreateLimits(blind)],
			["none", null, null]);
		eq("§4.4 ...as the validator refuses him every write (BACKDATE_LIMIT)",
			[A.validateAvailability({}, { ...blind, existing: row("2026-10-14", "2026-10-20") }).code, A.validateAvailability({ kind: "vacation", from: "2026-10-14", to: "2026-10-20" }, blind).code],
			["BACKDATE_LIMIT", "BACKDATE_LIMIT"]);
		eq("§4.5 Super Admin, today unreadable: still \"full\" (the validator never reads today for him)",
			[A.availabilityEditScope(row("2026-10-14", "2026-10-20"), { todayKey: "", isSuperAdmin: true }), A.availabilityCreateLimits({ todayKey: "", isSuperAdmin: true })],
			["full", { fromMin: null, toMin: null }]);
	}
	console.log(`  (${Date.now() - started} ms)`);
}

console.log(`\ntest-availability-edit-scope: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exit(1);
}
