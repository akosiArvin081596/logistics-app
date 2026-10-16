#!/usr/bin/env node
// R11 follow-up: what the staff panel is told it may change agrees with what the
// server accepts. GET /api/drivers-directory/:id/availability sends each row's
// `editable` ("full" | "end_early" | "none") and `limits` ({ fromMin, toMin,
// toMax, maxDays }, null = no limit; null on "none"), and `createLimits`
// ({ fromMin, toMin: null, maxDays, dispatcherBackDays }) for the add form, from
// lib/driver-availability.js availabilityEditScope(), availabilityEditLimits()
// and availabilityCreateLimits(). validateAvailability() stays the authority.
// This runner checks the two agree:
//
//   §1 the cases the client was built against (the contract's table), both roles
//   §2 every edit over a grid of calendar days: today fixed, every live row and
//      every candidate (from, to) with both ends in today-35..today+5 (every
//      to >= from, and one reversed range per first day), both roles, plus, per
//      row, an edit to 60 and to 61 days from its first day (the cap), a kind
//      change, a reason change and a cancel: "allowed by editable and limits"
//      equals validateAvailability(...).ok, case by case. Run for 2026-10-15,
//      across a year end (2027-01-03) and after a leap day (2028-03-01), those two
//      over today-32..today+1 (still both sides of the floor and of yesterday)
//   §3 every create over the same grid (and 60 and 61 days from each first
//      day), by createLimits
//   §4 a cancelled row, and a today that can't be read
//   §5 the real panel code: client/src/lib/availabilityText.js canSaveEdit(),
//      rowActions() and datesWithinBounds(createDateBounds()), on the rows as
//      served, against the validator given the body the panel would send
//      (editPatch()), over the 2026-10-15 grid
//
// "Allowed by editable and limits" is what the panel lets a caller send: on
// "full" any field, the first day from fromMin, the last day from the later of
// the first day and toMin, up to toMax; on "end_early" only the last day, from
// toMin to toMax; on "none" nothing; a cancel only on "full"; and never more
// than maxDays days.
//
// Pure: no server, database or network. Every date is a calendar day.
// Run: node scripts/test-availability-edit-scope.js

"use strict";

const path = require("path");
const { pathToFileURL } = require("url");
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
const tooLong = (limits, from, to) => limits.maxDays != null && span(from, to) > limits.maxDays;
const row = (from, to, extra = {}) => ({ id: 1, kind: "vacation", from_date: from, to_date: to, reason: "Family", cancelled_at: null, ...extra });
const ROLES = [["Super Admin", true], ["Dispatcher", false]];

// What the panel lets a caller send for `cand` ({ kind, from, to, reason }) on `r`.
function panelAllows(r, mode, limits, cand) {
	if (mode === "none" || !limits) return false;
	if (tooLong(limits, cand.from, cand.to)) return false;
	if (mode === "end_early") {
		if (cand.kind !== r.kind || cand.from !== r.from_date || cand.reason !== r.reason) return false;
		return cand.to >= later(r.from_date, limits.toMin) && (limits.toMax == null || cand.to <= limits.toMax);
	}
	if (mode !== "full") return false;
	if (limits.fromMin != null && cand.from < limits.fromMin) return false;
	if (cand.to < later(cand.from, limits.toMin)) return false;
	return limits.toMax == null || cand.to <= limits.toMax;
}

// The grid of one `today`: every live row, and for each the candidate edits.
function gridOf(today, [lo, hi] = [-35, 5]) {
	const days = [];
	for (let n = lo; n <= hi; n++) days.push(shift(today, n));
	const rows = [];
	for (let i = 0; i < days.length; i++) for (let j = i; j < days.length; j++) rows.push(row(days[i], days[j]));
	// Every (from, to) with to >= from, plus one reversed range per first day
	// (the day before it): both sides refuse every reversed range alike.
	const ranges = [];
	for (let f = 0; f < days.length; f++) for (let t = Math.max(0, f - 1); t < days.length; t++) ranges.push([days[f], days[t]]);
	const capped = (from) => [[from, shift(from, A.AVAILABILITY_MAX_DAYS - 1)], [from, shift(from, A.AVAILABILITY_MAX_DAYS)]];
	return { days, rows, ranges, capped };
}

function counter() {
	const misses = [];
	let cases = 0;
	const check = (label, allowed, valid) => {
		cases++;
		if (allowed !== valid && misses.length < 8) misses.push(`${label}: panel ${allowed ? "allows" : "refuses"}, server ${valid ? "accepts" : "refuses"}`);
	};
	return { check, result: () => ({ cases, misses }) };
}

function gridAgreement(today, window) {
	const { days, rows, ranges, capped } = gridOf(today, window);
	const { check, result } = counter();
	for (const [role, isSuperAdmin] of ROLES) {
		const ctx = { todayKey: today, isSuperAdmin };
		for (const r of rows) {
			const mode = A.availabilityEditScope(r, ctx);
			const limits = A.availabilityEditLimits(r, ctx);
			const tag = `${role} row ${r.from_date}..${r.to_date} (${mode})`;
			if ((mode === "none") !== (limits === null)) check(`${tag}: limits null exactly on "none"`, true, false);
			for (const [from, to] of [...ranges, ...capped(r.from_date)]) {
				const cand = { kind: r.kind, from, to, reason: r.reason };
				check(`${tag} -> ${from}..${to}`, panelAllows(r, mode, limits, cand), A.validateAvailability({ from, to }, { ...ctx, existing: r }).ok);
			}
			const kind = { kind: "off_duty", from: r.from_date, to: r.to_date, reason: r.reason };
			check(`${tag} kind -> off_duty`, panelAllows(r, mode, limits, kind), A.validateAvailability({ kind: "off_duty" }, { ...ctx, existing: r }).ok);
			const reason = { kind: r.kind, from: r.from_date, to: r.to_date, reason: "Personal" };
			check(`${tag} reason -> Personal`, panelAllows(r, mode, limits, reason), A.validateAvailability({ reason: "Personal" }, { ...ctx, existing: r }).ok);
			check(`${tag} cancel`, mode === "full", A.validateAvailability({}, { ...ctx, existing: r }).ok);
		}
		const create = A.availabilityCreateLimits(ctx);
		for (const [from, to] of [...days.flatMap((f) => days.map((t) => [f, t])), ...days.flatMap(capped)]) {
			const allowed = !!create && (create.fromMin == null || from >= create.fromMin) && to >= later(from, create.toMin) && !tooLong(create, from, to);
			check(`${role} create ${from}..${to}`, allowed, A.validateAvailability({ kind: "vacation", from, to, reason: "" }, ctx).ok);
		}
	}
	return result();
}

// §5: the panel's own functions on a row as the staff GET serves it.
function clientAgreement(T, today) {
	const { days, rows, ranges, capped } = gridOf(today);
	const { check, result } = counter();
	for (const [role, isSuperAdmin] of ROLES) {
		const ctx = { todayKey: today, isSuperAdmin };
		for (const r of rows) {
			const served = { id: r.id, kind: r.kind, from: r.from_date, to: r.to_date, reason: r.reason,
				editable: A.availabilityEditScope(r, ctx), limits: A.availabilityEditLimits(r, ctx) };
			const tag = `${role} row ${r.from_date}..${r.to_date} (${served.editable})`;
			const forms = [...ranges, ...capped(r.from_date)].map(([from, to]) => ({ kind: r.kind, from, to, reason: r.reason }));
			forms.push({ kind: "off_duty", from: r.from_date, to: r.to_date, reason: r.reason }, { kind: r.kind, from: r.from_date, to: r.to_date, reason: "Personal" });
			for (const form of forms) {
				const patch = T.editPatch(served, form);
				const accepted = Object.keys(patch).length > 0 && A.validateAvailability(patch, { ...ctx, existing: r }).ok;
				check(`${tag} Save for ${JSON.stringify(form)}`, T.canSaveEdit(served, form), accepted);
			}
			check(`${tag} Cancel button`, T.rowActions(served).cancel, A.validateAvailability({}, { ...ctx, existing: r }).ok);
		}
		const create = A.availabilityCreateLimits(ctx);
		for (const [from, to] of [...days.flatMap((f) => days.map((t) => [f, t])), ...days.flatMap(capped)]) {
			const form = { kind: "vacation", from, to, reason: "" };
			check(`${role} Add for ${from}..${to}`, T.datesWithinBounds(form, T.createDateBounds(create, form)), A.validateAvailability(form, ctx).ok);
		}
	}
	return result();
}

(async () => {
	let T = null;
	try { T = await import(pathToFileURL(path.join(__dirname, "..", "client", "src", "lib", "availabilityText.js")).href); } catch { T = null; }
	ok("§0 client/src/lib/availabilityText.js loads", !!T);
	if (HAS) {
		const started = Date.now();
		console.log("\n── §1 the contract's cases (today 2026-10-15: floor Sep 15, yesterday Oct 14)");
		{
			const TODAY = "2026-10-15";
			const SA = { todayKey: TODAY, isSuperAdmin: true };
			const DISP = { todayKey: TODAY, isSuperAdmin: false };
			const NONE = { fromMin: null, toMin: null, toMax: null, maxDays: 60 };
			const both = (r, ctx) => [A.availabilityEditScope(r, ctx), A.availabilityEditLimits(r, ctx)];
			for (const [label, r] of [["a recent row", row("2026-10-05", "2026-10-25")], ["an old live row", row("2026-09-10", "2026-10-25")],
				["an old ended row", row("2026-09-01", "2026-09-12")], ["a row two years back", row("2024-10-01", "2024-10-02")]]) {
				eq(`§1.1 Super Admin, ${label}: "full", no limits but the 60-day cap`, both(r, SA), ["full", NONE]);
			}
			eq("§1.2 Dispatcher, a row starting on the floor (Sep 15 - Oct 25): \"full\", toMin yesterday",
				both(row("2026-09-15", "2026-10-25"), DISP), ["full", { fromMin: "2026-09-15", toMin: "2026-10-14", toMax: null, maxDays: 60 }]);
			eq("§1.3 Dispatcher, a recent row that ended (Sep 20 - Oct 2): \"full\", toMin its own end (toMin never folds in the start)",
				both(row("2026-09-20", "2026-10-02"), DISP), ["full", { fromMin: "2026-09-15", toMin: "2026-10-02", toMax: null, maxDays: 60 }]);
			eq("§1.4 Dispatcher, an upcoming row (Nov 1-3): \"full\", toMin yesterday",
				both(row("2026-11-01", "2026-11-03"), DISP), ["full", { fromMin: "2026-09-15", toMin: "2026-10-14", toMax: null, maxDays: 60 }]);
			eq("§1.5 Dispatcher, a row starting the day before the floor and running past today (Sep 14 - Oct 25): \"end_early\"",
				both(row("2026-09-14", "2026-10-25"), DISP), ["end_early", { fromMin: null, toMin: "2026-10-14", toMax: "2026-10-24", maxDays: 60 }]);
			eq("§1.6 Dispatcher, an old row ending today (Sep 10 - Oct 15): \"end_early\", only yesterday left",
				both(row("2026-09-10", "2026-10-15"), DISP), ["end_early", { fromMin: null, toMin: "2026-10-14", toMax: "2026-10-14", maxDays: 60 }]);
			eq("§1.7 Dispatcher, an old row that ended yesterday (Sep 10 - Oct 14): \"none\"", both(row("2026-09-10", "2026-10-14"), DISP), ["none", null]);
			eq("§1.8 createLimits: Super Admin none but the cap; Dispatcher from the floor; both told the Dispatcher's 30-day window",
				[A.availabilityCreateLimits(SA), A.availabilityCreateLimits(DISP)],
				[{ fromMin: null, toMin: null, maxDays: 60, dispatcherBackDays: 30 }, { fromMin: "2026-09-15", toMin: null, maxDays: 60, dispatcherBackDays: 30 }]);
			eq("§1.9 maxDays and dispatcherBackDays are the validator's own constants",
				[A.availabilityEditLimits(row("2026-10-05", "2026-10-25"), DISP).maxDays, A.availabilityCreateLimits(DISP).maxDays, A.availabilityCreateLimits(DISP).dispatcherBackDays],
				[A.AVAILABILITY_MAX_DAYS, A.AVAILABILITY_MAX_DAYS, A.AVAILABILITY_BACKDATE_DAYS]);
		}

		console.log("\n── §2 / §3 every edit and every create over the grid, both roles");
		for (const today of ["2026-10-15", "2027-01-03", "2028-03-01"]) {
			const { cases, misses } = gridAgreement(today, today === "2026-10-15" ? [-35, 5] : [-32, 1]);
			eq(`§2 today ${today}: the panel's limits and the validator agree on all ${cases} cases`, misses, []);
		}

		console.log("\n── §4 a cancelled row, and a today that can't be read");
		{
			const cancelled = row("2026-10-14", "2026-10-20", { cancelled_at: "2026-10-12T12:00:00Z" });
			for (const [role, isSuperAdmin] of ROLES) {
				const ctx = { todayKey: "2026-10-15", isSuperAdmin };
				eq(`§4.1 ${role}, a cancelled row: "none", limits null`, [A.availabilityEditScope(cancelled, ctx), A.availabilityEditLimits(cancelled, ctx)], ["none", null]);
				eq("§4.2 ...and the validator refuses it (409 AVAILABILITY_CANCELLED)", A.validateAvailability({}, { ...ctx, existing: cancelled }).code, "AVAILABILITY_CANCELLED");
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
				["full", { fromMin: null, toMin: null, maxDays: 60, dispatcherBackDays: 30 }]);
		}

		if (T) {
			console.log("\n── §5 the panel's own code, on the rows as served (today 2026-10-15)");
			const { cases, misses } = clientAgreement(T, "2026-10-15");
			eq(`§5 canSaveEdit(), rowActions() and the add form's bounds agree with the validator on all ${cases} cases`, misses, []);
		}
		console.log(`  (${Date.now() - started} ms)`);
	}

	console.log(`\ntest-availability-edit-scope: ${passed} passed, ${failures.length} failed`);
	if (failures.length) {
		for (const f of failures) console.log(`  ✗ ${f}`);
		process.exit(1);
	}
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
