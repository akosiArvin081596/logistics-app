#!/usr/bin/env node
// scripts/freeze-closed-months.js — the one-time freeze of Financials' closed
// months, run on the server with no login. It runs the code of POST
// /api/admin/financials/freeze-closed-months, lifted from this checkout's
// server.js (scripts/lib/ledger-world.js), so the plan and its fingerprint are
// the endpoint's.
//
// Dry run (the default): opens app.db read-only and prints the plan — each
// closed month not yet frozen, its figures, its Settlement adjustments and what
// it lists for review — with the fingerprint, and checks it against what was
// settled:
//   - settledTotals: each investor-month the plan freezes adds up to the
//     breakdown its payout row settled at, figure by figure (the Settlement
//     adjustment lines are what bridge any difference);
//   - financialsUnchanged: each month's figures are what Financials shows for
//     it now (the freeze changes no figure);
//   - payoutRows: the freeze writes no payout row (checked again after an apply).
//
// Apply: --apply --fingerprint=<the dry run's> --include-unverified. Refuses
// unless both are given, and refuses (writing nothing) when the plan no longer
// has that fingerprint. Before writing it backs the database up next to app.db
// (app.db.pre-freeze-<UTC time>, SQLite's online backup, integrity-checked) and
// refuses if that fails or the disk lacks room for it. It then runs the
// endpoint's apply with every month included, installs the closed-month TEMP
// triggers on its own connection first, and writes an audit row naming this
// script as the actor; each frozen month gets the endpoint's own audit row.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/freeze-closed-months.js --db=app.db --sheet-id=<id> [--key=service-account-key.json]
//   node scripts/freeze-closed-months.js --db=app.db --sheet-id=<id> --apply --fingerprint=<hex> --include-unverified
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      read the flags from this file, not the app directory's .env
// There is no default sheet. Exit codes: 0 done, 1 error, 2 refused.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildLedgerWorld, parseArgs, sheetFor } = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");
const ACTOR = "script:freeze-closed-months";

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

function payoutRowsHash(db) {
	const rows = db.prepare("SELECT * FROM investor_payouts ORDER BY id").all();
	return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

// Each investor-month the plan freezes, against the breakdown it settled at;
// and each month against what Financials shows for it now.
function checks(world, plan, books) {
	const { db, api } = world;
	const figures = api.financialsCalc.SETTLED_FIGURES;
	const cents = (v) => Math.round(Number(v || 0) * 100);
	const booksFigures = api.financialsCalc.monthFiguresFromItems(books.items);
	const out = [];
	for (const p of plan.periods) {
		const mismatches = [];
		for (const r of db.prepare("SELECT owner_id, finalized_breakdown FROM investor_payouts WHERE period = ?").all(p.period)) {
			let b = null;
			try { b = JSON.parse(r.finalized_breakdown || "null"); } catch { b = null; }
			if (!b || typeof b !== "object") continue;
			const mine = api.financialsCalc.monthFiguresFromItems(p.items.filter((i) => (i.ownerId || 0) === r.owner_id))[p.period] || {};
			for (const k of figures) if (cents(mine[k]) !== cents(b[k])) mismatches.push({ ownerId: r.owner_id, figure: k, frozen: mine[k] || 0, settled: b[k] || 0 });
		}
		const now = booksFigures[p.period] || {};
		const planned = p.figures || {};
		const financialsUnchanged = [...figures, "netProfit"].every((k) => cents(now[k]) === cents(planned[k]));
		out.push({ period: p.period, settledTotalsMatch: mismatches.length === 0, mismatches, financialsUnchanged });
	}
	return out;
}

function summary(plan) {
	return plan.periods.map((p) => ({
		period: p.period,
		itemCount: p.itemCount,
		figures: p.figures,
		adjustments: p.adjustments,
		unverifiedOwners: p.unverifiedOwners,
		ownersWithoutPayoutRow: p.ownersWithoutPayoutRow,
		ambiguousLoads: p.ambiguousLoads.map((l) => ({ loadId: l.loadId, day: l.day, amount: l.amount, countedFor: l.countedFor, truckHeldBy: l.truckHeldBy })),
	}));
}

// SQLite's online backup of the live database to a dated file next to it,
// integrity-checked before anything is written.
async function backupNextTo(dbPath, db) {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	const target = `${dbPath}.pre-freeze-${stamp}`;
	const size = fs.statSync(dbPath).size + (fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0);
	const free = (() => { const s = fs.statfsSync(path.dirname(path.resolve(dbPath))); return s.bavail * s.bsize; })();
	if (free < size * 2) refuse(`not enough free disk for the backup (${free} bytes free, the database is ${size})`);
	await db.backup(target);
	const Database = require("better-sqlite3");
	const copy = new Database(target, { readonly: true, fileMustExist: true });
	const ok = copy.pragma("integrity_check", { simple: true });
	copy.close();
	if (ok !== "ok") refuse(`the backup at ${target} failed its integrity check (${ok}); nothing was frozen`);
	return target;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.db) refuse("--db is required");
	const apply = args.apply === true;
	if (apply && (typeof args.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(args.fingerprint))) refuse("--apply needs --fingerprint=<the dry run's 64-hex fingerprint>");
	if (apply && args["include-unverified"] !== true) refuse("--apply needs --include-unverified (every closed month is frozen as recorded)");
	const sheetData = await sheetFor(args, ROOT);
	const world = buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: !apply, sheetData, envFile: args["env-file"] || null });
	const { db, api, call } = world;

	const plan = await api.closedMonthFreezePlan();
	const books = await api.buildFinancialsLedger();
	const report = { mode: apply ? "apply" : "dry-run", fingerprint: plan.fingerprint, periods: summary(plan), overlaps: plan.overlaps.length, checks: checks(world, plan, books) };
	if (!apply) {
		console.log(JSON.stringify(report, null, 1));
		db.close();
		return;
	}

	if (plan.fingerprint !== args.fingerprint) refuse(`the plan's fingerprint is now ${plan.fingerprint}, not the one given; run the dry run again`);
	const before = payoutRowsHash(db);
	const backup = await backupNextTo(args.db, db);
	api.installPeriodLockTriggers(db);
	const res = await call("POST /api/admin/financials/freeze-closed-months", {
		body: { apply: true, fingerprint: args.fingerprint, includeUnverified: true },
		session: { user: { username: ACTOR, role: "script" } },
	});
	if (res.status !== 200) refuse(`the freeze answered ${res.status}: ${JSON.stringify(res.body)}`);
	const after = payoutRowsHash(db);
	api.logAudit({ session: { user: { username: ACTOR, role: "script" } } }, "financials_freeze_script", "period", res.body.frozenPeriods.join(","),
		`one-time freeze applied by ${ACTOR} (fingerprint ${args.fingerprint}, backup ${path.basename(backup)}): ` +
		`${res.body.frozenPeriods.length} month(s) frozen [${res.body.frozenPeriods.join(", ")}], ${res.body.leftForReview.length} left for review`);
	console.log(JSON.stringify({ ...report, applied: res.body, backup, payoutRowsUnchanged: before === after }, null, 1));
	db.close();
	if (before !== after) process.exit(1);
}

main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
