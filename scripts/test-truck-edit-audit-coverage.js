#!/usr/bin/env node
// Every consequential column PUT /api/trucks/:id writes must leave an audit row.
//
// WHY THIS EXISTS. `trucks.fuel_tank_gallons` has been wrong three separate
// times — #33 300→198→203 and #91 240→189 — and every investigation stalled on
// the same question: who set this, and on what basis? Nobody could answer,
// because this route wrote the column silently. It audited status, in-service
// date, retirement and owner, so the omission looked like a decision rather
// than an oversight, and each correction re-derived the number from scratch.
//
// It is not a cosmetic field. On the ESTIMATED range basis — the fallback for a
// truck without enough tank-to-tank legs to measure miles-per-gauge-point —
// range is tank × mpg, derated. #91 sat on that basis with a hand-entered 240
// against a real ~189, so its driver was shown ~25% more range than the truck
// could deliver. That truck ran dry on 2026-08-17.
//
// ⚠️ THE FAILURE MODE THIS LOCKS IS DRIFT, NOT A BUG. Auditing a truck edit
// stopped being systematic: four fields got a trail as someone noticed each one
// mattered, and the two that feed the fuel range were simply never noticed. A
// test that checked only today's six fields would pass on the exact regression
// it exists to catch — the SEVENTH field, added later, written silently.
//
// So it works the way scripts/test-refusal-audit-coverage.js does: it EXTRACTS
// the columns the route actually writes from server.js source, and fails when a
// consequential one can be written without recording it. Adding a new column
// that moves money or moves a number a driver plans against will fail this test
// until it is either audited or explicitly declared cosmetic below.
//
// No network, no database, no server — it reads source text.
//
//   node scripts/test-truck-edit-audit-coverage.js      # exits 1 on any failure

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

// --- isolate the handler -----------------------------------------------------
const START = 'app.put("/api/trucks/:id"';
const startIdx = SRC.indexOf(START);
if (startIdx === -1) {
	console.error("FAIL  could not find PUT /api/trucks/:id — did the route move or get renamed?");
	process.exit(1);
}
// The next top-level `\napp.` registration ends this handler.
const endRel = SRC.slice(startIdx + START.length).search(/\napp\.(get|post|put|delete|use)\(/);
const ROUTE = endRel === -1 ? SRC.slice(startIdx) : SRC.slice(startIdx, startIdx + START.length + endRel);
check("the handler was isolated and is a plausible size", ROUTE.length > 2000 && ROUTE.length < 60000, true);

// --- what does it write? -----------------------------------------------------
const written = new Set();
for (const m of ROUTE.matchAll(/updates\.push\(\s*[`"']\s*([a-z_]+)\s*=/g)) written.add(m[1]);
check("columns were actually extracted (the scan still matches)", written.size > 5, true);

// --- what must be audited, and why -------------------------------------------
// A column belongs here when changing it moves money OR moves a number a human
// plans against. Everything else is descriptive and is listed as cosmetic below,
// so the two sets together must cover every column the route writes.
const MUST_AUDIT = {
	status: "decides whether ~$3k/mo of fixed costs hits the P&L at all",
	in_service_date: "re-books fixed costs across whole months",
	retired_at: "removes or restores whole months from an investor's ledger",
	owner_id: "moves a truck's whole fixed-cost history between investors",
	driver_pay_daily: "drives invoices and P&L",
	fuel_tank_gallons: "drives the range a driver plans against on the estimated basis",
	avg_mpg: "the other half of that same product",
};

// Descriptive only: wrong values here are visible and harmless.
const COSMETIC = new Set([
	"unit_number", "make", "model", "year", "vin", "license_plate", "notes", "photo",
	"insurance_monthly", "eld_monthly", "truck_payment_monthly", "hvut_annual",
	"irp_annual", "admin_fee_pct", "purchase_price", "title_status",
	"maintenance_fund_monthly", "assigned_driver", "routemate_vehicle_id",
]);

// --- 1. every must-audit column has a logAudit -------------------------------
for (const [col, why] of Object.entries(MUST_AUDIT)) {
	if (!written.has(col)) continue;   // not written here; nothing to audit
	const audited = new RegExp(`logAudit\\([^)]*?["'\`]update_truck_[a-z_]*["'\`]`, "g");
	const calls = [...ROUTE.matchAll(/logAudit\(\s*req,\s*["'`]([a-z_]+)["'`]/g)].map((m) => m[1]);
	const hit = calls.some((a) => a.includes(col.replace(/_gallons$/, "").replace(/^owner_id$/, "owner")))
		|| calls.some((a) => a === `update_truck_${col}`)
		|| (col === "driver_pay_daily" && calls.includes("update_driver_pay"))
		|| (col === "fuel_tank_gallons" && calls.includes("update_truck_fuel_tank"))
		|| (col === "owner_id" && calls.includes("update_truck_owner"));
	check(`${col} is audited — ${why}`, hit, true);
}

// --- 2. THE PAIRED CASE: the scan must be able to FAIL ------------------------
// A coverage test that cannot detect a missing audit is theatre. Strip the fuel
// tank's logAudit out of a copy and confirm the same check goes red.
const sabotaged = ROUTE.replace(/logAudit\(req, "update_truck_fuel_tank"[\s\S]*?\);/, "/* removed */");
check("sabotage actually removed the call (the control is valid)",
	sabotaged.includes("update_truck_fuel_tank"), false);
const sabotagedCalls = [...sabotaged.matchAll(/logAudit\(\s*req,\s*["'`]([a-z_]+)["'`]/g)].map((m) => m[1]);
check("with the audit removed, the scan reports it MISSING",
	sabotagedCalls.includes("update_truck_fuel_tank"), false);

// --- 3. no column is silently unclassified -----------------------------------
// This is what catches the NEXT field. A new column that is neither audited nor
// declared cosmetic fails here rather than shipping silently.
const unclassified = [...written].filter((c) => !MUST_AUDIT[c] && !COSMETIC.has(c)).sort();
check("every written column is either audited or declared cosmetic", unclassified, []);

// --- 4. the two fuel fields specifically -------------------------------------
check("fuel_tank_gallons is written by this route", written.has("fuel_tank_gallons"), true);
check("avg_mpg is written by this route", written.has("avg_mpg"), true);
check("the fuel tank audit names the truck and both values",
	/Fuel tank for \$\{truck\.unit_number\}: \$\{fmtTank\(before\)\} → \$\{fmtTank\(after\)\}/.test(ROUTE), true);
// An unset tank must not read as "0 gal" — it falls back to the fleet default,
// and the audit line should say which.
check("an unset tank is described, not written as 0", /fleet default/.test(ROUTE), true);
// A no-op edit must not write a row, or the log fills with noise and the real
// changes become unfindable.
check("the tank audit is guarded by an actual change", /if \(before !== after\)/.test(ROUTE), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
