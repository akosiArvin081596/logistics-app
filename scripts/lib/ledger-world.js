// The payout ledger and the Financials freeze, run in a script exactly as the
// server runs them: their code is lifted from this checkout's server.js at run
// time (lib/server-lift.js), so a script always computes what the deployed
// endpoint would. Used by scripts/payout-rules-dry-run.js and
// scripts/freeze-closed-months.js, which run on the server over ssh, with no
// login.
//
// What the lifted code gets in place of the server's process:
//   - db: its own better-sqlite3 handle on the given app.db (read-only for a
//     dry run; checked);
//   - getJobTrackingCached(): one snapshot of the Job Tracking tab, read with
//     the spreadsheets.readonly scope (or a saved values.get, for tests), put
//     through the server's own parseSheet() and deduplicateLoads();
//   - process.env: the app directory's .env, as the server loads it;
//   - app / requireRole / refuseCrossOrigin: enough to register the freeze
//     route so its handler runs as written;
//   - notifyChange: nothing (a script has no sockets).
// The server's HTTP server, sockets, Sheets writer and sheet ID are never
// lifted (lib/server-lift.js refuses).

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./server-lift");

const FREEZE_HEAD = 'app.post("/api/admin/financials/freeze-closed-months", requireRole("Super Admin"), refuseCrossOrigin, async (req, res) => {';
const ROOTS = ["payoutRulesDryRun", "closedMonthFreezePlan", "buildFinancialsLedger", "installPeriodLockTriggers", "parseSheet", "deduplicateLoads"];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "app", "requireRole", "refuseCrossOrigin", "notifyChange", "getJobTrackingCached"];
const DENIED = ["getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "jtCacheInvalidate"];

// The Job Tracking tab as values.get returns it: { values: [[header…], [row…]] }.
async function readJobTracking({ sheetId, keyFile, appRequire }) {
	const { google } = appRequire("googleapis");
	const auth = new google.auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
	const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
	const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Job Tracking" });
	return res.data;
}

// The app directory's .env, parsed the way dotenv parses it, without touching
// this process's environment.
function readEnv(root, appRequire) {
	const file = path.join(root, ".env");
	if (!fs.existsSync(file)) return {};
	return appRequire("dotenv").parse(fs.readFileSync(file));
}

// `envFile`: the .env to read in place of the app directory's (tests pass an
// empty one, so a developer's flags never reach them).
function buildLedgerWorld({ root, dbPath, readonly, sheetData, env = null, envFile = null }) {
	const SRC = fs.readFileSync(path.join(root, "server.js"), "utf8");
	const appRequire = createRequire(path.join(root, "server.js"));
	const Database = appRequire("better-sqlite3");
	const db = new Database(dbPath, { readonly, fileMustExist: true });
	if (readonly && !db.readonly) throw new Error("refusing: the dry run's SQLite handle is not read-only");
	db.pragma("busy_timeout = 10000");

	const lifted = closure(SRC, { roots: ROOTS, routes: [FREEZE_HEAD], provided: PROVIDED, denied: DENIED });
	const routes = {};
	const register = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
	const app = { get: register("GET"), post: register("POST"), put: register("PUT"), delete: register("DELETE") };
	const pass = () => (req, res, next) => next && next();
	const fileEnv = envFile ? appRequire("dotenv").parse(fs.readFileSync(envFile)) : readEnv(root, appRequire);
	const scriptProcess = { env: { ...(env || fileEnv) }, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } };
	const body = [
		'"use strict";',
		lifted.text,
		"let _scriptJobTracking = null;",
		"async function getJobTrackingCached() {",
		"\tif (!_scriptJobTracking) {",
		"\t\tconst parsed = parseSheet(__sheetData);",
		"\t\tparsed.data = deduplicateLoads(parsed.data, parsed.headers);",
		"\t\t_scriptJobTracking = parsed;",
		"\t}",
		"\treturn _scriptJobTracking;",
		"}",
		"return { payoutRulesDryRun, closedMonthFreezePlan, buildFinancialsLedger, installPeriodLockTriggers, logAudit, financialsCalc };",
	].join("\n");
	const api = new Function("db", "require", "console", "process", "__dirname", "app", "requireRole", "refuseCrossOrigin", "notifyChange", "__sheetData", body)(
		db, appRequire, console, scriptProcess, root, app, pass, pass(), () => {}, sheetData,
	);
	const call = async (route, req) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		await routes[route](req, res);
		return out;
	};
	return { db, api, call, liftedNames: lifted.names };
}

// --flag=value / --flag value / --flag, for the scripts.
function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const eq = a.indexOf("=");
		if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
		else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
		else out[a.slice(2)] = true;
	}
	return out;
}

// The sheet for a script: --values-json (a saved values.get) or --sheet-id
// (read-only). --sheet-id=env takes the SPREADSHEET_ID the app directory's .env
// sets, and refuses when it sets none (production sets none, so production's
// sheet is always named on the command line). There is no default sheet: a
// script that fell back to one is how local runs reached production before.
async function sheetFor(args, root) {
	if (args["values-json"]) return JSON.parse(fs.readFileSync(args["values-json"], "utf8"));
	if (!args["sheet-id"] || args["sheet-id"] === true) throw new Error("--sheet-id (or --values-json) is required; there is no default sheet");
	const appRequire = createRequire(path.join(root, "server.js"));
	let sheetId = args["sheet-id"];
	if (sheetId === "env") {
		sheetId = readEnv(root, appRequire).SPREADSHEET_ID || "";
		if (!sheetId) throw new Error("--sheet-id=env: the app's .env sets no SPREADSHEET_ID; name the sheet");
	}
	const keyFile = args.key || path.join(root, "service-account-key.json");
	return readJobTracking({ sheetId, keyFile, appRequire });
}

module.exports = { buildLedgerWorld, parseArgs, sheetFor, FREEZE_HEAD };
