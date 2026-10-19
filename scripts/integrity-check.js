#!/usr/bin/env node
// scripts/integrity-check.js — the daily integrity check (lib/integrity-check.js)
// run once by hand, READ-ONLY: it prints what the server's 8:00 AM run would find
// and the email it would send, and sends nothing.
//
//   - the database is opened read-only (checked); the job's state table is read
//     when it exists and never created or written;
//   - Job Tracking is read with the spreadsheets.readonly scope
//     (scripts/lib/ledger-world.js sheetFor()), or from a saved values.get;
//   - the rate-con mailbox is read only with --mailbox (EXAMINE and BODY.PEEK,
//     the app's GMAIL_USER / GMAIL_APP_PASSWORD from the app's .env), for check 3;
//   - no email: the recipient (ADMIN_NOTIFY_EMAIL from the app's .env) is printed.
// parseSheet(), deduplicateLoads(), EXPENSE_PERIOD_EXPR and excludeDroppedLoads()
// are lifted from this checkout's server.js (scripts/lib/server-lift.js), so the
// checks read the sheet, book receipts and leave out cancelled loads exactly as
// the server does.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/integrity-check.js --print --db=app.db --sheet-id=<id> [--key=service-account-key.json] [--mailbox]
//   --sheet-id=env           the SPREADSHEET_ID the app's .env sets (refused when it sets none)
//   --values-json=<file>     a saved values.get of Job Tracking, in place of --sheet-id
//   --emails-json=<file>     saved rate-con emails ([{ subject, date }]), in place of --mailbox
//   --env-file=<file>        with a copy of the database under the temp directory
//                            only: read the settings from this file
// The database is this checkout's own app.db or a copy under the temp directory;
// any other is refused. There is no default sheet. Exit codes: 0 done, 1 error,
// 2 refused.

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { parseArgs, sheetFor, envFor, buildLedgerWorld } = require("./lib/ledger-world");
const { closure } = require("./lib/server-lift");
const integrityCheck = require("../lib/integrity-check");
const ledgerDayOnce = require("../lib/ledger-day-once");
const driverRateOnly = require("../lib/driver-rate-only");
const appTime = require("../lib/app-time");

const ROOT = path.join(__dirname, "..");

function refuse(message) {
	console.error(`REFUSED: ${message}`);
	process.exit(2);
}

// The server's own sheet reader, expense month rule, accounting-month rule and
// live-load rule (excludeDroppedLoads(), check 9), from this checkout. The
// lifted code resolves `require` as server.js does. excludeDroppedLoads() asks
// the server's own getDeletedLoadIds(), lifted on its own and handed this
// script's read-only database handle: the one lifted function given the
// database, which it only reads; nothing else lifted here can reach it.
function liftFromServer(appRequire, db) {
	const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	const deletedReader = closure(SRC, { roots: ["getDeletedLoadIds"], provided: ["db"] });
	const getDeletedLoadIds = new Function("db", `"use strict";\n${deletedReader.text}\nreturn getDeletedLoadIds;`)(db);
	const lifted = closure(SRC, {
		roots: ["parseSheet", "deduplicateLoads", "EXPENSE_PERIOD_EXPR", "loadRowAccountingMonths", "excludeDroppedLoads"],
		provided: ["getDeletedLoadIds"],
		denied: ["db", "getSheets", "sheets", "sendEmail", "transporter", "app", "io", "server", "SPREADSHEET_ID"],
	});
	return new Function("require", "getDeletedLoadIds",
		`"use strict";\n${lifted.text}\nreturn { parseSheet, deduplicateLoads, EXPENSE_PERIOD_EXPR, loadRowAccountingMonths, excludeDroppedLoads };`)(appRequire, getDeletedLoadIds);
}

// Check 5's closed-month rule, read as the server reads it: the row's accounting
// months that period_locks marks 'locked'. A lock table that can't be read
// answers null for every row, as the server's integrityClosedMonthsOf() does:
// the check counts those loads and says the closed months can't be read.
function closedMonthsRule(db, loadRowAccountingMonths) {
	let locked = null;
	try {
		locked = new Set(db.prepare("SELECT period FROM period_locks WHERE status = 'locked'").all().map((r) => r.period));
	} catch {
		locked = null;
	}
	return (headers, row) => {
		if (locked === null) return null;
		const months = loadRowAccountingMonths(headers, headers.map((h) => row[h]));
		if (months === null) return null;
		return months.filter((mk) => locked.has(mk));
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.print !== true) refuse("--print is required: this script only prints what the daily integrity check would find and send");
	if (typeof args.db !== "string") refuse("--db=<app.db> is required: the app directory's own app.db or a copy under the temp directory");
	if (typeof args["values-json"] !== "string" && typeof args["sheet-id"] !== "string") {
		refuse("--sheet-id=<id> (or --values-json=<file>) is required; there is no default sheet");
	}
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let env;
	let dbFile;
	try {
		({ env, file: dbFile } = envFor({ root: ROOT, dbPath: args.db, envFile }));
	} catch (err) {
		refuse(err.message);
	}
	// sheetFor() reads the same settings; without a sheet there is nothing to
	// check, which is a refusal, not an error.
	if (typeof args["values-json"] !== "string" && args["sheet-id"] === "env" && !String(env.SPREADSHEET_ID || "").trim()) {
		refuse("--sheet-id=env: the app's settings name no SPREADSHEET_ID; name the sheet with --sheet-id=<id>");
	}

	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const Database = appRequire("better-sqlite3");
	const db = new Database(dbFile, { readonly: true, fileMustExist: true });
	if (!db.readonly) throw new Error("refusing: the SQLite handle is not read-only");
	db.pragma("busy_timeout = 10000");

	const server = liftFromServer(appRequire, db);
	const sheetData = await sheetFor(args, ROOT);
	const parsed = server.parseSheet(sheetData);
	parsed.data = server.deduplicateLoads(parsed.data, parsed.headers);

	let readRateConEmails = null;
	let mailboxNote = "not read (pass --mailbox to read the rate-con label read-only)";
	if (typeof args["emails-json"] === "string") {
		const saved = JSON.parse(fs.readFileSync(args["emails-json"], "utf8"));
		readRateConEmails = async () => saved;
		mailboxNote = `saved emails from ${args["emails-json"]}`;
	} else if (args.mailbox === true) {
		readRateConEmails = integrityCheck.rateConEmailReader({
			user: env.GMAIL_USER,
			pass: env.GMAIL_APP_PASSWORD,
			mailbox: String(env.RATECON_RECONCILE_MAILBOX || "").trim(),
		});
		mailboxNote = readRateConEmails ? "the rate-con label, read-only (EXAMINE, BODY.PEEK)" : "not read (the app's .env sets no GMAIL_USER / GMAIL_APP_PASSWORD)";
	}

	// Check 7, only while the app's settings switch the ledger day-once rule on:
	// the payout ledger lifted from this checkout's server.js on its own
	// read-only handle (scripts/lib/ledger-world.js).
	const dayOnceFrom = ledgerDayOnce.ruleFromEnv(env);
	let ledgerWorld = null;
	const readFleetLedger = dayOnceFrom
		? async () => {
			ledgerWorld = buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile });
			return ledgerWorld.api.computeFleetLedger();
		}
		: null;

	// Check 8 day by day, only while the app's settings switch the daily-rate
	// rule on (lib/driver-rate-only.js): the server's driverRateOnlyDayRule(),
	// lifted on its own read-only handle (a month closed before this run keeps
	// the old rule unless the server's start record says otherwise).
	let rateWorld = null;
	const dailyRateRuleFor = driverRateOnly.ruleFromEnv(env)
		? (jt) => {
			rateWorld = buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile, extraRoots: ["driverRateOnlyDayRule"] });
			return rateWorld.api.driverRateOnlyDayRule(jt);
		}
		: null;

	const lines = [];
	const log = { log: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
	const to = String(env.ADMIN_NOTIFY_EMAIL || "").trim();
	const result = await integrityCheck.runIntegrityCheck({
		db,
		write: false,
		readJobTracking: async () => parsed,
		readRateConEmails,
		expensePeriodExpr: server.EXPENSE_PERIOD_EXPR,
		to,
		log,
		appZone: appTime.resolveAppTimeZone(env.APP_TIMEZONE, (m) => console.error(m)),
		closedMonthsOf: closedMonthsRule(db, server.loadRowAccountingMonths),
		// Check 9: cancelled and soft-deleted loads left out, as the server leaves
		// them out.
		liveLoadRows: (sheet) => server.excludeDroppedLoads(sheet.data, sheet.headers),
		dayOnceFrom,
		readFleetLedger,
		dailyRateRuleFor,
	});
	db.close();
	if (ledgerWorld) ledgerWorld.db.close();
	if (rateWorld) rateWorld.db.close();

	const lastRun = result.baseline ? "none yet: the server's first run would take the baseline" : "from the job's state table";
	console.log("Daily integrity check, read-only (nothing written, nothing sent)");
	console.log(`  database: ${dbFile} (read-only)`);
	console.log(`  Job Tracking: ${typeof args["values-json"] === "string" ? args["values-json"] : "read with the spreadsheets.readonly scope"}`);
	console.log(`  rate-con mailbox: ${mailboxNote}`);
	console.log(`  previous values: ${lastRun}`);
	console.log("");
	for (const l of lines) console.log(l);
	console.log("");
	if (!result.mail) {
		console.log("Nothing to send.");
		return;
	}
	console.log("Email it would send (not sent):");
	console.log(`To: ${to || "(ADMIN_NOTIFY_EMAIL is not set: the server would send nothing)"}`);
	console.log(`Subject: ${result.mail.subject}`);
	console.log("");
	console.log(result.mail.text);
}

main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
