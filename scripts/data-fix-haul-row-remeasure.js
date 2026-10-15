#!/usr/bin/env node
// scripts/data-fix-haul-row-remeasure.js — hands one load's final load_eld_miles
// row back to the app to measure again.
//
// A row the load-detail haul view wrote while the load was still running could be
// stored as final, measured off another load's visit to the same shipper (the
// replay's 7-day lookback), and a final row is never measured again. The fix in
// lib/load-haul.js and measureLoadEldMiles() stops new ones; this re-opens one
// existing row so the app's own background sweep measures it again.
//
// What it changes: in_progress 0 -> 1 on that one row, nothing else. Every other
// column stays as it is until the sweep's next run (every 6 hours, or 10 minutes
// after a restart) measures the closed-out load through measureLoadEldMiles(),
// whose closed-out result replaces an in-progress row. Meanwhile the per-load
// miles index skips an in-progress row, so Financials and the investor views show
// the load's rate-con miles instead of the stale figure. Not a delete: the row and
// its values stay on record until the app replaces them, and the audit row holds
// every column as it was.
//
// Refused (exit 2, nothing written) when: this checkout lacks the fix (run it only
// after that release is deployed: the old rules could measure the row wrong again
// or refuse the new figure); the load is not on exactly one Job Tracking row; any
// month the app books the load into is closed, or can't be told
// (loadRowAccountingMonths() and periodWriteLocked(), lifted from this checkout's
// server.js, the check the app's own writes use); the load has no load_eld_miles
// row; the row is not final. Idempotent: once this script's audit row for the load
// exists, a run writes nothing, whatever the row holds since.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/data-fix-haul-row-remeasure.js --db=app.db --sheet-id=<id> --load-id=<id> --dry-run
//   node scripts/data-fix-haul-row-remeasure.js --db=app.db --sheet-id=<id> --load-id=<id> --apply
//   --sheet-id=<id>       the app's own Job Tracking sheet (read-only); no default
//   --values-json=<file>  tests: a saved values.get of Job Tracking instead
//   --key=<file>          the service account key (default service-account-key.json)
//   --db                  app.db in this app directory, or a copy under the temp
//                         directory (scripts/lib/ledger-world.js dbScope())
// The dry run opens the database read-only and prints the row's every column with
// what would change. The apply re-checks the row inside one transaction, changes
// it only if it is still exactly what the plan read, and logs the change in
// audit_trail as a system change (user 0, username this script, role "system").
// Exit codes: 0 done (or already done), 1 error, 2 refused.
// Required as a module (by its test runner) it runs nothing and exports its parts.

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { parseArgs, sheetFor, envFor, dbScope } = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");
const ACTOR = "script:data-fix-haul-row-remeasure";
const REF = "HAUL-REMEASURE-2026-10";
const OPTIONS = ["db", "sheet-id", "values-json", "key", "load-id", "dry-run", "apply"];
const ROOTS = ["loadRowAccountingMonths", "periodWriteLocked", "periodLocksReadable", "normLoadKey"];
const DENIED = ["getSheets", "sheets", "SPREADSHEET_ID", "sendEmail", "io", "server"];

class Refusal extends Error {}

// The app's own closed-month check and load key, lifted from `root`'s server.js
// over `db`.
function liftChecks(root, db) {
	const src = fs.readFileSync(path.join(root, "server.js"), "utf8");
	const lifted = closure(src, { roots: ROOTS, provided: ["db"], denied: DENIED });
	return new Function("db", `"use strict";\n${lifted.text}\nreturn { ${ROOTS.join(", ")} };`)(db);
}

// The fix this script relies on: the release that ships it exports the stale-visit
// rule from lib/load-haul.js, and server.js's final-replaces-in-progress rule ships
// in the same release.
function fixDeployed(loadHaul) {
	return !!loadHaul && Number.isFinite(loadHaul.STALE_VISIT_BEFORE_DISPATCH_MS);
}

function audited(db, key) {
	return db.prepare("SELECT 1 FROM audit_trail WHERE username = ? AND user_id = 0 AND role = 'system' AND entity = 'load_eld_miles' AND entity_id = ? AND details LIKE ? LIMIT 1")
		.get(ACTOR, key, `%[${REF}]%`);
}

// What a run would do: { done: line } or { key, before, after, months }. Throws
// Refusal for anything it must not touch.
function plan({ db, values, loadId, checks }) {
	const key = checks.normLoadKey(loadId);
	if (!key) throw new Refusal("--load-id is empty");
	if (audited(db, key)) return { done: `${key}: re-opened by this script already (its audit row is on record); nothing to write` };

	const rows = values || [];
	const headers = (rows[0] || []).map((h) => String(h == null ? "" : h));
	const iLoad = headers.findIndex((h) => /load.?id|job.?id/i.test(h));
	if (iLoad === -1) throw new Refusal("Job Tracking has no Load ID column");
	const hits = rows.slice(1).filter((r) => checks.normLoadKey((r || [])[iLoad]) === key);
	if (hits.length !== 1) throw new Refusal(`${hits.length} Job Tracking rows carry load ${key}, not one`);

	if (!checks.periodLocksReadable()) throw new Refusal("the closed months can't be read (period_locks)");
	const months = checks.loadRowAccountingMonths(headers, hits[0]);
	if (!months || !months.length) throw new Refusal(`load ${key}'s months can't be told from its Job Tracking row`);
	const closed = months.filter((mk) => checks.periodWriteLocked(mk));
	if (closed.length) throw new Refusal(`load ${key} books into a closed month (${closed.join(", ")}); closed months stay as recorded`);

	const before = db.prepare("SELECT * FROM load_eld_miles WHERE load_id = ?").get(key);
	if (!before) throw new Refusal(`load ${key} has no load_eld_miles row`);
	if (Number(before.in_progress) !== 0) throw new Refusal(`load ${key}'s load_eld_miles row is not final (in_progress = ${before.in_progress}); the app measures it already`);
	return { key, before, after: { ...before, in_progress: 1 }, months };
}

function showRow(row) {
	return Object.entries(row).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`).join("\n");
}

// The app's own sheet for an app directory's own database (lib/sheet-id.js).
function appSheetId(env, root) {
	const sheetIds = require(path.join(root, "lib", "sheet-id"));
	const named = String((env && env.SPREADSHEET_ID) || "").trim();
	if (named) return named;
	return path.resolve(root) === sheetIds.PRODUCTION_DIR ? sheetIds.PRODUCTION_SPREADSHEET_ID : "";
}

// `opts` (tests): root (the app directory), loadHaul (its lib/load-haul.js),
// log / err (output).
async function main(argv = process.argv.slice(2), opts = {}) {
	const root = opts.root || ROOT;
	const say = opts.log || ((s) => console.log(s));
	const args = parseArgs(argv);
	const unknown = Object.keys(args).filter((k) => !OPTIONS.includes(k));
	if (unknown.length) throw new Refusal(`unknown option(s): ${unknown.map((k) => `--${k}`).join(", ")}`);
	const dryRun = args["dry-run"] === true;
	const apply = args.apply === true;
	if (dryRun === apply) throw new Refusal("say --dry-run or --apply (one of them)");
	if (typeof args.db !== "string") throw new Refusal("--db is required");
	if (typeof args["load-id"] !== "string") throw new Refusal("--load-id=<id> is required");
	if (typeof args["sheet-id"] !== "string" && typeof args["values-json"] !== "string") throw new Refusal("--sheet-id (or --values-json) is required; there is no default sheet");

	const appRequire = createRequire(path.join(root, "server.js"));
	const loadHaul = opts.loadHaul !== undefined ? opts.loadHaul : appRequire("./lib/load-haul");
	if (!fixDeployed(loadHaul)) throw new Refusal("this checkout does not have the haul-row fix; run this only after that release is deployed");

	let scope;
	let dbFile;
	try { ({ scope, file: dbFile } = dbScope(args.db, root)); } catch (err) { throw new Refusal(err.message); }
	if (scope === "app" && typeof args["sheet-id"] === "string") {
		const own = appSheetId(envFor({ root, dbPath: args.db }).env, root);
		if (!own || own !== args["sheet-id"]) throw new Refusal("--sheet-id is not this app's own sheet; the closed-month check must read the load's own row");
	}
	const sheet = await sheetFor({ "sheet-id": args["sheet-id"], "values-json": args["values-json"], key: args.key }, root);

	const Database = appRequire("better-sqlite3");
	const db = new Database(dbFile, { readonly: !apply, fileMustExist: true });
	if (dryRun && !db.readonly) throw new Refusal("the dry run's handle on the database is not read-only");
	db.pragma("busy_timeout = 10000");
	try {
		const checks = liftChecks(root, db);
		say(`Data fix ${REF}: re-open one final load_eld_miles row for the app to measure again. Mode: ${dryRun ? "dry run (nothing is written)" : "apply"}.`);
		const p = plan({ db, values: sheet.values, loadId: args["load-id"], checks });
		if (p.done) { say(`done: ${p.done}`); return 0; }
		say(`load ${p.key}: months ${p.months.join(", ")}, all open. One row matches.`);
		say(`  before:\n${showRow(p.before)}`);
		say(`  ${dryRun ? "would change" : "change"}: in_progress 0 -> 1 (every other column stays until the sweep measures the load again)`);
		if (dryRun) { say("1 row would change. Nothing written."); return 0; }

		const update = db.prepare("UPDATE load_eld_miles SET in_progress = 1 WHERE load_id = ? AND in_progress = 0");
		const insert = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'system', 'remeasure_haul_row', 'load_eld_miles', ?, ?)");
		db.transaction(() => {
			const now = db.prepare("SELECT * FROM load_eld_miles WHERE load_id = ?").get(p.key);
			if (JSON.stringify(now) !== JSON.stringify(p.before)) throw new Refusal(`load ${p.key}'s row changed since it was read; nothing written`);
			if (audited(db, p.key)) throw new Refusal(`load ${p.key} was re-opened by another run meanwhile; nothing written`);
			const r = update.run(p.key);
			if (r.changes !== 1) throw new Refusal(`${r.changes} rows would change, not one; nothing written`);
			insert.run(new Date().toISOString(), ACTOR, p.key,
				`Final haul row re-opened (in_progress 0 -> 1) for the app's sweep to measure again: it was written while the load was running and measured another load's visit to the same shipper. Row as it was: ${JSON.stringify(p.before)} [${REF}]`);
		})();
		say("Written: 1 row (in_progress 0 -> 1) and 1 audit row. The sweep measures the load on its next run.");
		return 0;
	} finally {
		db.close();
	}
}

if (require.main === module) {
	main().then((code) => process.exit(code)).catch((err) => {
		if (err instanceof Refusal) { console.error(`REFUSED: ${err.message}`); process.exit(2); }
		console.error(`ERROR: ${err.stack || err.message}`);
		process.exit(1);
	});
}

module.exports = { ACTOR, REF, ROOTS, plan, liftChecks, fixDeployed, main, Refusal };
