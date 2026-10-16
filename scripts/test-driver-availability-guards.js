#!/usr/bin/env node
// Driver availability (R11) never touches money. Availability is about the
// DRIVER (who can be dispatched, whether a quiet truck is expected); it creates
// and removes no pay day, and no fixed cost, fee, reserve, payout, projection,
// Financials figure or invoice reads it. These guards pass before and after the
// feature: they pin that it stays out of the money paths.
//
//   §1 behaviour: a month with the driver recorded off all month gives the same
//      weekly invoice, investor view and payout ledger (fixed costs included)
//      as the same month with no row, with DRIVER_AVAILABILITY_ENABLED on
//   §2 the money modules in lib/ never name a tracked name
//   §3 in server.js every mention of a tracked name sits inside an allowlisted
//      declaration or route: the migration and the availability routes, the
//      directory list and delete, eldFeedSnapshot(), the helpers themselves, the
//      five assign routes, the dashboard and the trucks list. So the payout
//      builders, Financials, the fixed-cost and projection queries and the
//      invoice generator can neither read the table nor call a helper that does.
//      The driver app's payload (GET /api/driver/:driverName) is NOT allowlisted:
//      it carries invoiceTotalDue. There a tracked name may stand only on the one
//      line of its res.json({...}) that spreads `timeOff` behind
//      DRIVER_TIME_OFF_SCREEN_ENABLED (R11 follow-up), and nowhere else in it.
//   §4 every call of the off-duty check sits inside
//      `if (DRIVER_AVAILABILITY_ENABLED) {`; DRIVER_TIME_OFF_SCREEN_ENABLED folds
//      in the main flag and gates only that spread
//
// Tracked names: the table, the module path, the module's binding in server.js,
// every name lib/driver-availability.js exports (read from the module, so a new
// export is tracked on its own), and the server.js helpers that read the table,
// listed by name below.
// Run: node scripts/test-driver-availability-guards.js

"use strict";

const fs = require("fs");
const path = require("path");
const WD = require("./lib/work-days-world");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let passed = 0;
const failures = [];
const ok = (name, cond, detail) => {
	if (cond) { passed++; return; }
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (name, a, e) => ok(name, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

// ── tracked names ──────────────────────────────────────────────────────────────
const SERVER_HELPERS = ["driverAvailabilityByName", "truckDriverAvailability", "driverOffDutyRefusal", "cancelDirectoryAvailability",
	"availabilityRowWithDriver", "availabilityOverlap", "availabilityOverlapBody", "recordOffDutyConfirmation", "sheetRowOffDutyDriver",
	"availabilityRowView", "driverOwnTimeOff"];
let libExports = [];
try { libExports = Object.keys(require("../lib/driver-availability")); } catch { libExports = []; }
const TRACKED = ["driver_availability", "driver_availability_confirmations", "driver-availability", "driverAvailability", ...SERVER_HELPERS, ...libExports];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A tracked name as a whole word ("driver_availability_create", an audit
// action, is not the table).
const TRACKED_RE = new RegExp(`(?<![\\w$-])(?:${TRACKED.map(escapeRe).join("|")})(?![\\w$])`);

// Comments blanked, line structure kept, so a comment saying "never reads
// driver_availability" is not a mention.
function blankComments(src) {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

// ── §1 behaviour: the money paths with and without a month off ──────────────────
const AMY = "Amy Birch";
const PLAN_DDL = `CREATE TABLE IF NOT EXISTS driver_availability (
	id INTEGER PRIMARY KEY AUTOINCREMENT, directory_id INTEGER NOT NULL, driver_name TEXT NOT NULL,
	kind TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
	created_by TEXT NOT NULL, created_by_user_id INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
	updated_at TEXT, cancelled_at TEXT, cancelled_by TEXT)`;
function moneyWorld(withRow) {
	const w = WD.startWorld({
		env: { DRIVER_AVAILABILITY_ENABLED: "true" },
		now: Date.parse("2026-10-12T16:00:00Z"),
		drivers: [{ name: AMY, payDaily: 300 }],
		rows: [
			WD.loadRow({ id: "G101", driver: AMY, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" }),
			WD.loadRow({ id: "G102", driver: AMY, pickup: "2026-10-08 8:00", dropoff: "2026-10-08 18:00", assigned: "2026-10-08", done: "2026-10-08", truck: "T1" }),
		],
	});
	w.db.prepare("UPDATE trucks SET insurance_monthly = 1680, truck_payment_monthly = 1210, eld_monthly = 50, hvut_annual = 749, irp_annual = 1840, maintenance_fund_monthly = 800").run();
	if (withRow) {
		// The shipped table when server.js has it, else the plan's shape: the
		// guard holds before the feature exists, too.
		w.db.exec(PLAN_DDL);
		const dir = w.db.prepare("SELECT id FROM drivers_directory WHERE driver_name = ?").get(AMY).id;
		w.db.prepare(`INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, reason, created_by, created_at)
			VALUES (?, ?, 'vacation', '2026-10-01', '2026-10-30', 'Vacation', 'super_admin', '2026-09-30T12:00:00Z')`).run(dir, AMY);
	}
	return w;
}
async function moneyViews(withRow) {
	const w = moneyWorld(withRow);
	const excludedBefore = w.db.prepare("SELECT COUNT(*) AS n FROM excluded_driver_days").get().n;
	const gen = await WD.generate(w, AMY, "2026-10-09");
	const led = await WD.ledger(w);
	const inv = await WD.investorDays(w);
	const out = {
		invoiceStatus: gen.status,
		invoiceDays: WD.gridDays(gen.data, "2026-10-09"),
		invoiceTotal: gen.invoice ? gen.invoice.total : null,
		ledgerItems: led.items.map((i) => ({ kind: i.kind, month: i.month, amount: i.amount, label: i.label })),
		ledgerMonths: led.monthlyEarnings,
		investorMonths: inv.months,
		excluded: w.db.prepare("SELECT COUNT(*) AS n FROM excluded_driver_days").get().n - excludedBefore,
		availabilityRows: withRow ? w.db.prepare("SELECT COUNT(*) AS n FROM driver_availability").get().n : 0,
	};
	return out;
}

(async () => {
	console.log("\n── §1 the money paths with and without a month off");
	try {
		const base = await moneyViews(false);
		const offAllMonth = await moneyViews(true);
		eq("§1.0 the fixture invoices Oct 5-8 and the row covers the month", [base.invoiceStatus, base.invoiceDays.map((d) => d.day), offAllMonth.availabilityRows],
			[200, ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"], 1]);
		ok("§1.0b the ledger has fixed-cost items to compare", base.ledgerItems.some((i) => /fixed|insurance|payment/i.test(`${i.kind} ${i.label}`)));
		eq("§1.1 the weekly invoice's days are the same", offAllMonth.invoiceDays, base.invoiceDays);
		eq("§1.2 ...and its total", offAllMonth.invoiceTotal, base.invoiceTotal);
		eq("§1.3 the payout ledger's items (driver pay, fixed costs, fees) are the same", offAllMonth.ledgerItems, base.ledgerItems);
		eq("§1.4 ...and its months", JSON.stringify(offAllMonth.ledgerMonths), JSON.stringify(base.ledgerMonths));
		eq("§1.5 the investor view's months are the same", JSON.stringify(offAllMonth.investorMonths), JSON.stringify(base.investorMonths));
		eq("§1.6 no excluded day is written", [base.excluded, offAllMonth.excluded], [0, 0]);
	} catch (err) {
		ok("§1 ran", false, `threw: ${err && err.message}`);
	}

	console.log("\n── §2 the money modules in lib/ never name a tracked name");
	for (const f of ["load-pay-days.js", "financials-calc.js", "investor-payout-basis.js", "financials-report.js"]) {
		const text = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
		const hit = text.split("\n").findIndex((l) => TRACKED_RE.test(l));
		ok(`§2 lib/${f} names none of them`, hit < 0, hit < 0 ? "" : `line ${hit + 1}`);
	}
	ok("§2.0 the tracked names include the module's exports when it exists",
		!fs.existsSync(path.join(ROOT, "lib", "driver-availability.js")) || libExports.length > 0);

	console.log("\n── §3 server.js: every mention sits in an allowlisted place");
	{
		const code = blankComments(SRC).split("\n");
		const ALLOW_HEADS = [
			'const driverAvailability = require("./lib/driver-availability");',
			"const DRIVER_AVAILABILITY_ENABLED =",
			"function availabilityFlagGate(",
			...SERVER_HELPERS.map((n) => `function ${n}(`),
			"function eldFeedSnapshot(",
			'app.get("/api/drivers-directory/:id/availability",',
			'app.post("/api/drivers-directory/:id/availability",',
			'app.put("/api/driver-availability/:id",',
			'app.post("/api/driver-availability/:id/cancel",',
			'app.get("/api/driver/me/availability",',
			'app.get("/api/driver-availability",',
			'app.get("/api/drivers-directory",',
			'app.delete("/api/drivers-directory/:id",',
			'app.post("/api/dispatch",',
			'app.post("/api/dispatch/reassign",',
			'app.put("/api/data/:rowIndex",',
			'app.put("/api/load/:loadId",',
			'app.post("/api/data",',
			'app.get("/api/dashboard",',
			'app.get("/api/trucks",',
		];
		const isHead = (l) => /^[^\s}\])`/]/.test(l);
		const headOf = (i) => { for (let j = i; j >= 0; j--) if (isHead(code[j])) return j; return -1; };
		const statementText = (j) => { let k = j + 1; while (k < code.length && !isHead(code[k])) k++; return code.slice(j, k).join("\n"); };
		// The driver app's payload: one exempt line, the `timeOff` spread, as a
		// property of the route's res.json({ ... }).
		const PAYLOAD_HEAD = 'app.get("/api/driver/:driverName",';
		const TIME_OFF_SPREAD_RE = /^\.\.\.\(DRIVER_TIME_OFF_SCREEN_ENABLED \? \{ timeOff: driverOwnTimeOff\([^()]*\) \} : \{\}\),$/;
		const inReply = (j, i) => {
			for (let k = i - 1; k > j; k--) {
				const t = code[k].trim();
				if (t === "res.json({") return true;
				if (t === "});" || /^(if|for|while|const|let|return|try|await)\b|^\} catch\b/.test(t)) return false;
			}
			return false;
		};
		const stray = [];
		const spreads = [];
		let mentions = 0;
		code.forEach((l, i) => {
			if (!TRACKED_RE.test(l)) return;
			mentions++;
			const j = headOf(i);
			const head = j < 0 ? "" : code[j];
			const allowed = ALLOW_HEADS.some((h) => head.startsWith(h))
				|| (head.startsWith("db.exec(") && statementText(j).includes("CREATE TABLE IF NOT EXISTS driver_availability"));
			if (allowed) return;
			if (head.startsWith(PAYLOAD_HEAD) && TIME_OFF_SPREAD_RE.test(l.trim()) && inReply(j, i)) { spreads.push(i + 1); return; }
			stray.push(`line ${i + 1} (in ${head.slice(0, 70) || "?"}): ${l.trim().slice(0, 90)}`);
		});
		eq("§3.1 no tracked name outside the allowlist", stray, []);
		console.log(`  (${mentions} mention(s) checked)`);
		ok("§3.1b the driver app's payload route is not on the allowlist", !ALLOW_HEADS.some((h) => PAYLOAD_HEAD.startsWith(h) || h.startsWith(PAYLOAD_HEAD)));
		ok("§3.1c ...and holds at most one exempt line, the timeOff spread in its res.json", spreads.length <= 1, `lines ${spreads.join(", ")}`);
		// The money paths, by name: none is on the allowlist, so §3.1 covers them;
		// asserted directly as well so a rename cannot slip one onto it.
		const money = ["computeInvestorMonthlyEarnings", "buildFinancialsLedger", "buildFinancialsReport", "generateInvoiceHandler", "truckMonthlyFixed",
			"financialsExtraItems", "computeFleetLedger", "computeLossCarryForward"];
		for (const fn of money) {
			const at = SRC.indexOf(`\nfunction ${fn}(`) >= 0 ? SRC.indexOf(`\nfunction ${fn}(`) : SRC.indexOf(`\nasync function ${fn}(`);
			if (at < 0) { ok(`§3.2 ${fn}() is in server.js`, false); continue; }
			const end = SRC.indexOf("\n}\n", at);
			ok(`§3.2 ${fn}() names no tracked name`, !TRACKED_RE.test(blankComments(SRC.slice(at, end))));
		}
	}

	console.log("\n── §4 every off-duty check sits inside the flag");
	{
		const lines = SRC.split("\n");
		const calls = [];
		lines.forEach((l, i) => { if (/\bdriverOffDutyRefusal\(/.test(l) && !/^function driverOffDutyRefusal\(/.test(l) && !/^\s*\/\//.test(l)) calls.push(i); });
		const unguarded = calls.filter((i) => {
			for (let j = i - 1; j >= 0; j--) {
				const t = lines[j].trim();
				if (!t || t.startsWith("//")) continue;
				return t !== "if (DRIVER_AVAILABILITY_ENABLED) {";
			}
			return true;
		}).map((i) => `line ${i + 1}`);
		eq(`§4.1 every call (${calls.length}) is inside if (DRIVER_AVAILABILITY_ENABLED)`, unguarded, []);
		// The screen sub-flag works only while the main flag is on, and gates the
		// driver app's timeOff spread and nothing else.
		const code = blankComments(SRC).split("\n");
		const defs = code.filter((l) => l.startsWith("const DRIVER_TIME_OFF_SCREEN_ENABLED ="));
		ok("§4.2 DRIVER_TIME_OFF_SCREEN_ENABLED, where defined, is defined once and folds in DRIVER_AVAILABILITY_ENABLED first",
			defs.length <= 1 && defs.every((l) => l.startsWith("const DRIVER_TIME_OFF_SCREEN_ENABLED = DRIVER_AVAILABILITY_ENABLED && /^(true|1|yes|on)$/i.test(")), defs.join(" | "));
		const uses = code.map((l, i) => [l, i + 1]).filter(([l]) => /\bDRIVER_TIME_OFF_SCREEN_ENABLED\b/.test(l) && !l.startsWith("const DRIVER_TIME_OFF_SCREEN_ENABLED ="));
		ok("§4.3 ...and every other mention is the timeOff spread", uses.every(([l]) => l.trim().startsWith("...(DRIVER_TIME_OFF_SCREEN_ENABLED ? { timeOff: driverOwnTimeOff(")),
			uses.map(([l, n]) => `line ${n}: ${l.trim().slice(0, 80)}`).join(" | "));
	}

	WD.cleanup();
	console.log(`\ntest-driver-availability-guards: ${passed} passed, ${failures.length} failed`);
	if (failures.length) {
		for (const f of failures) console.log(`  ✗ ${f}`);
		process.exit(1);
	}
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
