#!/usr/bin/env node
// Read-only check of the month-end business clock: are the payout ledger, the
// Financials books and the all-time fixed-cost month count the same at 18:00
// and at 23:00 business time (APP_TIMEZONE) on a month's last day?
//
// Why: the ledger's month loop and the fixed-cost count once read the server's
// own clock, which on the UTC production server is already next month from
// 8 PM EDT / 7 PM EST on a month's last day, while "the current month" is the
// business month. For those hours every scope gained a month that had not begun
// and the investor dashboard's totals moved (fixed by reading the business
// month: appMonthStart() in server.js). 18:00 is before that window in both
// daylight and standard time; 23:00 is inside it in both.
//
// Run it the way the server runs: in the server's own process zone (UTC on
// production); the zone is printed. It writes nothing: the database is opened
// through scripts/lib/ledger-world.js's read-only handle (refused if it is not
// read-only), the sheet is read with the spreadsheets.readonly scope or taken
// from a saved values.get, and the two worlds differ only in their clock.
//
//   node scripts/month-end-clock-report.js --db=app.db --sheet-id=<id> [--day=YYYY-MM-DD] [--json]
//   node scripts/month-end-clock-report.js --db=<copy> --values-json=<file> --env-file=<file> [--day=...]
//
// --day: a calendar date, the last day of a month (default: the last day of the
// current business month). Exit 0 when nothing differs, 1 when something does,
// 2 on a refused argument.

"use strict";

const path = require("path");
const { buildLedgerWorld, parseArgs, sheetFor } = require("./lib/ledger-world");
const appTime = require("../lib/app-time");

const ROOT = path.join(__dirname, "..");
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

// The last calendar day of the month "YYYY-MM" (no zone: a date).
function lastDayOf(month) {
	const [y, m] = month.split("-").map(Number);
	return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

// What the clock could move, as of one instant.
async function snapshot(world) {
	const { api, db } = world;
	const fleet = await api.computeFleetLedger();
	const books = await api.buildFinancialsLedger();
	const carrierDB = api.getCarrierDBFromSQLite();
	const driverCol = api.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
	const carrierCol = api.findCol(carrierDB.headers, /carrier/i);
	const globalConfig = {};
	db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all().forEach((r) => (globalConfig[r.key] = r.value));
	const investors = [];
	for (const inv of api.listSettlableInvestors()) {
		const config = { ...globalConfig };
		db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(inv.ownerId).forEach((r) => (config[r.key] = r.value));
		const { monthlyEarnings, currentMonthKey } = await api.computeInvestorMonthlyEarnings({
			user: { id: inv.ownerId }, isSuperAdmin: false,
			investorDriverSet: api.getInvestorDriverSet(inv.ownerId, carrierDB.data, driverCol, carrierCol), investorOwnerId: inv.ownerId, config,
		});
		investors.push({ ownerId: inv.ownerId, currentMonthKey, months: monthlyEarnings.map((m) => m.month) });
	}
	const trucks = db.prepare("SELECT * FROM trucks ORDER BY id").all()
		.map((t) => ({ truckId: t.id, billedMonths: api.truckBilledMonthCount(t, new Date(world.now)) }));
	return {
		fleetCurrentMonth: fleet.currentMonthKey,
		scopes: fleet.scopes.map((s) => ({ ownerId: s.ownerId, months: s.months.map((m) => m.month) })),
		booksMonths: books.months,
		investors,
		trucks,
	};
}

// Every place the two snapshots disagree.
function differences(a, b) {
	const out = [];
	const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
	if (a.fleetCurrentMonth !== b.fleetCurrentMonth) out.push({ what: "current month", before: a.fleetCurrentMonth, after: b.fleetCurrentMonth });
	const byOwner = (list) => new Map(list.map((x) => [x.ownerId, x]));
	for (const [label, x, y] of [["ledger scope", a.scopes, b.scopes], ["investor ledger", a.investors, b.investors]]) {
		const later = byOwner(y);
		for (const s of x) {
			const t = later.get(s.ownerId);
			if (!t || !same(s.months, t.months)) out.push({ what: `${label} months`, ownerId: s.ownerId, before: s.months, after: t ? t.months : null });
		}
	}
	if (!same(a.booksMonths, b.booksMonths)) out.push({ what: "Financials months", before: a.booksMonths, after: b.booksMonths });
	const laterTrucks = new Map(b.trucks.map((t) => [t.truckId, t]));
	for (const t of a.trucks) {
		const u = laterTrucks.get(t.truckId);
		if (!u || u.billedMonths !== t.billedMonths) out.push({ what: "fixed-cost months", truckId: t.truckId, before: t.billedMonths, after: u ? u.billedMonths : null });
	}
	return out;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.db || args.db === true) refuse("--db is required");
	const zone = appTime.appTimeZone();
	const day = typeof args.day === "string" ? args.day.trim() : lastDayOf(appTime.appDay().slice(0, 7));
	const m = DAY_RE.exec(day);
	if (!m || lastDayOf(day.slice(0, 7)) !== day) refuse("--day must be YYYY-MM-DD, the last day of a month");
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const before = appTime.wallClockToMs(zone, y, mo, d, 18, 0, 0);
	const after = appTime.wallClockToMs(zone, y, mo, d, 23, 0, 0);
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	const sheetData = await sheetFor(args, ROOT);
	const world = (now) => {
		const w = buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile, extraRoots: ["truckBilledMonthCount"], now });
		w.now = now;
		return w;
	};
	const early = world(before);
	const late = world(after);
	try {
		const a = await snapshot(early);
		const b = await snapshot(late);
		const diff = differences(a, b);
		const result = {
			day, appTimeZone: zone, processZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			before: new Date(before).toISOString(), after: new Date(after).toISOString(),
			scopes: a.scopes.length, investors: a.investors.length, trucks: a.trucks.length,
			currentMonth: { before: a.fleetCurrentMonth, after: b.fleetCurrentMonth },
			differences: diff,
		};
		if (args.json === true) console.log(JSON.stringify(result, null, 1));
		else {
			console.log(`Month-end clock check, ${day} (${zone}; this process runs in ${result.processZone}). Nothing was written.`);
			console.log(`18:00 = ${result.before}, 23:00 = ${result.after}; ${result.scopes} ledger scopes, ${result.investors} investors, ${result.trucks} trucks.`);
			if (!diff.length) console.log("No difference: every scope, the Financials months and every truck's fixed-cost months are the same at both times.");
			for (const x of diff) console.log(`DIFFERENT: ${x.what}${x.ownerId !== undefined ? ` (owner ${x.ownerId})` : ""}${x.truckId !== undefined ? ` (truck ${x.truckId})` : ""}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`);
		}
		if (diff.length) process.exitCode = 1;
	} finally {
		early.db.close();
		late.db.close();
	}
}

main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
