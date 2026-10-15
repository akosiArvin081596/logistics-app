#!/usr/bin/env node
// scripts/ledger-day-once-dry-run.js — what the ledger day-once rule
// (LEDGER_DAY_ONCE_ENABLED and LEDGER_DAY_ONCE_FROM, lib/ledger-day-once.js)
// would change, run on the server with no login before the flag goes on. It
// lifts the payout ledger from this checkout's server.js twice
// (scripts/lib/ledger-world.js), each on its own read-only handle of app.db:
// once with the rule off (today) and once with it on from --from, every other
// setting as the app's .env has it. It compares the two and writes nothing.
//
// It reports:
//   - droppedDays: each driver-day the rule would drop, with its scope (owner
//     id; 0 is the company), the driver (a per-run label unless --names), the
//     month it leaves and that month's
//     load, and the earlier month that keeps it and that month's load
//     ("" for an admin-added day). keptMonthFrozen says whether the earlier
//     month has frozen line items (a closed month's settled record);
//     inKeptMonthFrozenItems whether they hold this day (null when the earlier
//     month has none). A day missing there was never settled in the earlier
//     month. That is a report for a person: it changes nothing;
//   - driverMonths: per scope, driver and month, the days dropped and the
//     driver-pay change. A percentage driver is paid on revenue, not days, so
//     their dropped days show as a count with no pay change;
//   - investorMonths: per investor and open month, the payable today and with
//     the rule (the loss carried forward included), and the difference;
//   - closedMonthsUnchanged: whether every closed month's figures and payable
//     are identical with and without the rule. They must be; the run exits 1
//     after printing if they are not.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/ledger-day-once-dry-run.js --from=YYYY-MM --db=app.db --sheet-id=<id> [--key=service-account-key.json] [--names] [--json]
//   --from=YYYY-MM         the LEDGER_DAY_ONCE_FROM to try. Refused unless it is
//                          after the latest closed month, so the rule never
//                          starts in a closed month
//   --sheet-id=env         the SPREADSHEET_ID the .env sets (refused when it sets none)
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      with a copy of the database under the temp directory
//                          only: read the other settings from this file
//   --names                name the drivers and investors. Without it drivers show
//                          as "driver 1", "driver 2", … (numbered per run, so
//                          rows still group) and investors by owner id only
//   --json                 print the whole result as JSON (default: a text report)
// The database is this checkout's own app.db or a copy under the temp
// directory; any other is refused (it may be another deployment's).
// There is no default sheet. Exit codes: 0 done, 1 error, 2 refused.

"use strict";

const path = require("path");
const { createRequire } = require("module");
const { buildLedgerWorld, parseArgs, sheetFor, envFor } = require("./lib/ledger-world");
const ledgerDayOnce = require("../lib/ledger-day-once");

const ROOT = path.join(__dirname, "..");
const FIGURES = ["revenue", "driverPay", "fixedCosts", "tripExpenses", "maintFundCost", "complianceCost"];
const round2 = (x) => Math.round(x * 100) / 100;
const usd = (x) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

// The latest closed month of the database, read before the sheet is: "" when
// none is closed. A database without the month-lock table is refused, since
// which months are closed cannot be told.
function latestClosedOf(dbFile) {
	const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");
	const probe = new Database(dbFile, { readonly: true, fileMustExist: true });
	try {
		const hasLocks = probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'period_locks'").get();
		if (!hasLocks) refuse("the database has no period_locks table, so its closed months cannot be told");
		return ledgerDayOnce.latestClosedMonth(probe);
	} finally {
		probe.close();
	}
}

// { "driver\tmonth\tday": item } for the fixed-rate driver-pay items (one per
// paid day), and { "driver\tmonth": item } for the percentage ones (one per month).
function payItems(items) {
	const days = new Map();
	const months = new Map();
	for (const it of items) {
		if (it.kind !== "driver_pay") continue;
		if (it.day) days.set(`${it.driver}\t${it.month}\t${it.day}`, it);
		else months.set(`${it.driver}\t${it.month}`, it);
	}
	return { days, months };
}

// Each month's figures in cents, from a scope's months.
function monthCents(months) {
	const out = new Map();
	for (const m of months) out.set(m.month, Object.fromEntries(FIGURES.map((k) => [k, Math.round((m[k] || 0) * 100)])));
	return out;
}

// A problem the run found: { ownerId, driver?, issue, closed } (closed: a closed
// month moved).
async function scopeChanges({ off, on, db, isLocked }) {
	const frozen = ledgerDayOnce.frozenDriverDays(db);
	const onByOwner = new Map(on.scopes.map((s) => [s.ownerId, s]));
	const droppedDays = [];
	const driverMonths = new Map();
	const problems = [];
	const tally = (ownerId, driver, month, days, cents, payType) => {
		const key = `${ownerId}\t${driver}\t${month}`;
		const row = driverMonths.get(key) || { ownerId, driver, month, payType, droppedDays: 0, driverPayChangeCents: 0 };
		row.droppedDays += days;
		row.driverPayChangeCents += cents;
		driverMonths.set(key, row);
	};
	for (const base of off.scopes) {
		const next = onByOwner.get(base.ownerId);
		if (!next) { problems.push({ ownerId: base.ownerId, issue: "the scope is missing with the rule on", closed: false }); continue; }
		const a = payItems(base.items);
		const b = payItems(next.items);
		// The earliest month that pays each driver-day today, and its load.
		const firstPay = new Map();
		for (const it of [...a.days.values()].sort((x, y) => (x.month < y.month ? -1 : x.month > y.month ? 1 : 0))) {
			const k = `${it.driver}\t${it.day}`;
			if (!firstPay.has(k)) firstPay.set(k, it);
		}
		for (const [key, it] of a.days) {
			if (b.days.has(key)) continue;
			const kept = firstPay.get(`${it.driver}\t${it.day}`);
			if (!kept || kept.month >= it.month) {
				problems.push({ ownerId: base.ownerId, driver: it.driver, issue: `${it.day} left ${it.month} with no earlier month paying it`, closed: false });
				continue;
			}
			const keptMonthFrozen = frozen.hasMonth(kept.month, base.ownerId);
			droppedDays.push({
				ownerId: base.ownerId, driver: it.driver, day: it.day,
				month: it.month, loadId: it.loadId || "", added: !!it.added, cents: it.cents,
				keptMonth: kept.month, keptLoadId: kept.loadId || "", keptAdded: !!kept.added,
				keptMonthFrozen,
				inKeptMonthFrozenItems: keptMonthFrozen ? frozen.holds(kept.month, base.ownerId, it.driver, it.day) : null,
			});
			tally(base.ownerId, it.driver, it.month, 1, -it.cents, "fixed");
		}
		for (const [key, it] of b.days) {
			if (!a.days.has(key)) problems.push({ ownerId: base.ownerId, driver: it.driver, issue: `${it.month} ${it.day} is paid only with the rule on`, closed: false });
		}
		for (const [key, it] of a.months) {
			const now = b.months.get(key);
			const daysGone = (it.days || 0) - ((now && now.days) || 0);
			const cents = ((now && now.cents) || 0) - it.cents;
			if (daysGone || cents) tally(base.ownerId, it.driver, it.month, daysGone, cents, "percentage");
		}
		const was = monthCents(base.months);
		const is = monthCents(next.months);
		for (const mk of new Set([...was.keys(), ...is.keys()])) {
			const x = was.get(mk) || {};
			const y = is.get(mk) || {};
			const moved = FIGURES.filter((k) => (x[k] || 0) !== (y[k] || 0));
			if (!moved.length) continue;
			if (isLocked(mk)) problems.push({ ownerId: base.ownerId, issue: `closed month ${mk} changed: ${moved.join(", ")}`, closed: true });
			else if (moved.some((k) => k !== "driverPay")) problems.push({ ownerId: base.ownerId, issue: `open month ${mk}: ${moved.filter((k) => k !== "driverPay").join(", ")} changed besides driver pay`, closed: false });
		}
	}
	droppedDays.sort((x, y) => x.ownerId - y.ownerId || x.driver.localeCompare(y.driver) || x.month.localeCompare(y.month) || x.day.localeCompare(y.day));
	const months = [...driverMonths.values()]
		.map((r) => ({ ...r, driverPayChange: r.driverPayChangeCents / 100 }))
		.sort((x, y) => x.ownerId - y.ownerId || x.driver.localeCompare(y.driver) || x.month.localeCompare(y.month));
	for (const r of months) delete r.driverPayChangeCents;
	return { droppedDays, driverMonths: months, problems };
}

// Each investor's payable per month, as payoutRulesDryRun() reads it: the
// payout ledger's months with the loss carried forward.
async function payables(world) {
	const { api, db } = world;
	const carrierDB = api.getCarrierDBFromSQLite();
	const driverCol = api.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
	const carrierCol = api.findCol(carrierDB.headers, /carrier/i);
	const globalConfig = {};
	db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all().forEach((r) => (globalConfig[r.key] = r.value));
	const out = new Map();
	for (const inv of api.listSettlableInvestors()) {
		const config = { ...globalConfig };
		db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(inv.ownerId).forEach((r) => (config[r.key] = r.value));
		const investorDriverSet = api.getInvestorDriverSet(inv.ownerId, carrierDB.data, driverCol, carrierCol);
		const { monthlyEarnings } = await api.computeInvestorMonthlyEarnings({
			user: { id: inv.ownerId }, isSuperAdmin: false, investorDriverSet, investorOwnerId: inv.ownerId, config,
		});
		const carry = api.computeLossCarryForward(monthlyEarnings);
		const months = new Map(monthlyEarnings.map((m) => [m.month, { payable: carry[m.month].payable, driverPay: m.exact.driverPay }]));
		out.set(inv.ownerId, { name: inv.name, months });
	}
	return out;
}

function investorChanges(was, is, { db, isLocked, names }) {
	const statusOf = db.prepare("SELECT status FROM investor_payouts WHERE owner_id = ? AND period = ?");
	const rows = [];
	const problems = [];
	for (const [ownerId, a] of was) {
		const b = is.get(ownerId) || { months: new Map() };
		for (const period of [...new Set([...a.months.keys(), ...b.months.keys()])].sort()) {
			const x = a.months.get(period) || { payable: 0, driverPay: 0 };
			const y = b.months.get(period) || { payable: 0, driverPay: 0 };
			const delta = round2(y.payable - x.payable);
			const driverPayChange = round2(y.driverPay - x.driverPay);
			if (!delta && !driverPayChange) continue;
			if (isLocked(period)) { problems.push({ ownerId, issue: `closed month ${period} changed its payable or driver pay`, closed: true }); continue; }
			const status = statusOf.get(ownerId, period);
			rows.push({
				ownerId, ...(names ? { investor: a.name } : {}), period, payoutStatus: status ? status.status : "no row yet",
				current: round2(x.payable), withRule: round2(y.payable), delta, driverPayChange,
			});
		}
	}
	return { rows, problems };
}

function printText(r) {
	const lines = [];
	lines.push(`Ledger day-once dry run: LEDGER_DAY_ONCE_FROM=${r.from} (latest closed month: ${r.latestClosedMonth || "none"}). Nothing was written.`);
	lines.push(`Dropped driver-days: ${r.summary.droppedDays}; driver pay ${usd(r.summary.driverPayChange)}; investor payable ${usd(r.summary.investorPayableChange)}.`);
	lines.push("", "Dropped days (scope, driver, month left, day, load; kept in month, load; kept month frozen / day in its frozen items):");
	for (const d of r.droppedDays) {
		const frozen = d.keptMonthFrozen ? (d.inKeptMonthFrozenItems ? "frozen, day settled" : "frozen, DAY MISSING from its frozen items") : "not frozen";
		lines.push(`  owner ${d.ownerId}  ${d.driver}  ${d.month}  ${d.day}  ${d.added ? "added day" : `load ${d.loadId}`}; kept in ${d.keptMonth}, ${d.keptAdded ? "added day" : `load ${d.keptLoadId}`}; ${frozen}`);
	}
	lines.push("", "Driver pay by scope, driver and month:");
	for (const m of r.driverMonths) lines.push(`  owner ${m.ownerId}  ${m.driver}  ${m.month}  ${m.payType}  -${m.droppedDays} day(s)  ${usd(m.driverPayChange)}`);
	lines.push("", "Investor payable by open month:");
	for (const i of r.investorMonths) lines.push(`  owner ${i.ownerId}${i.investor ? ` (${i.investor})` : ""}  ${i.period}  ${i.payoutStatus}  ${usd(i.current)} -> ${usd(i.withRule)}  (${usd(i.delta)}; driver pay ${usd(i.driverPayChange)})`);
	lines.push("", `Closed months unchanged: ${r.closedMonthsUnchanged ? "yes" : "NO"}`);
	for (const p of r.problems) lines.push(`PROBLEM: owner ${p.ownerId}${p.driver ? `, ${p.driver}` : ""}: ${p.issue}`);
	console.log(lines.join("\n"));
}

// Without --names, each driver becomes "driver 1", "driver 2", … in the order
// they first appear, numbered for this run only, so rows still group by driver
// but name nobody.
function labelDrivers(result) {
	const labels = new Map();
	const label = (name) => {
		if (!labels.has(name)) labels.set(name, `driver ${labels.size + 1}`);
		return labels.get(name);
	};
	for (const list of [result.droppedDays, result.driverMonths, result.problems]) {
		for (const row of list) if (row.driver) row.driver = label(row.driver);
	}
	return result;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const from = typeof args.from === "string" ? args.from.trim() : "";
	if (!ledgerDayOnce.FROM_MONTH_RE.test(from)) refuse("--from=YYYY-MM is required: the LEDGER_DAY_ONCE_FROM to try");
	if (!args.db || args.db === true) throw new Error("--db is required");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let dbFile;
	try {
		dbFile = envFor({ root: ROOT, dbPath: args.db, envFile }).file;
	} catch (err) {
		refuse(err.message);
	}
	const latestClosed = latestClosedOf(dbFile);
	if (latestClosed && from <= latestClosed) {
		refuse(`--from=${from} is at or before ${latestClosed}, the latest closed month. The rule may only start in an open month: closed months are final as recorded.`);
	}
	const sheetData = await sheetFor(args, ROOT);
	const world = (overrides) => buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile, envOverrides: overrides });
	const off = world({ LEDGER_DAY_ONCE_ENABLED: "false", LEDGER_DAY_ONCE_FROM: "" });
	const on = world({ LEDGER_DAY_ONCE_ENABLED: "true", LEDGER_DAY_ONCE_FROM: from });
	try {
		const isLocked = (mk) => off.api.isLocked(mk);
		const fleet = await scopeChanges({ off: await off.api.computeFleetLedger(), on: await on.api.computeFleetLedger(), db: off.db, isLocked });
		const inv = investorChanges(await payables(off), await payables(on), { db: off.db, isLocked, names: args.names === true });
		const problems = [...fleet.problems, ...inv.problems];
		const result = {
			from, latestClosedMonth: latestClosed, baseline: "LEDGER_DAY_ONCE off; every other setting as the app's .env has it",
			droppedDays: fleet.droppedDays, driverMonths: fleet.driverMonths, investorMonths: inv.rows,
			closedMonthsUnchanged: !problems.some((p) => p.closed), problems,
			summary: {
				droppedDays: fleet.droppedDays.length,
				driverPayChange: round2(fleet.driverMonths.reduce((s, m) => s + m.driverPayChange, 0)),
				investorPayableChange: round2(inv.rows.reduce((s, i) => s + i.delta, 0)),
			},
			generatedAt: new Date().toISOString(),
		};
		if (args.names !== true) labelDrivers(result);
		if (args.json === true) console.log(JSON.stringify(result, null, 1));
		else printText(result);
		if (problems.length) process.exitCode = 1;
	} finally {
		off.db.close();
		on.db.close();
	}
}

main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
