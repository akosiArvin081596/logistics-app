#!/usr/bin/env node
/**
 * Nothing but production's own process falls back to the production sheet
 * (lib/sheet-id.js). An unset SPREADSHEET_ID used to mean the live Dispatch
 * Management book everywhere: a local server, test-suite.js and one-off
 * scripts read and wrote it without anyone naming it.
 *
 *   §1 lib/sheet-id.js: SPREADSHEET_ID wins; without it only the process
 *      ecosystem.config.js defines (pm2 `logistics-app` in /var/www/logistics-app)
 *      gets the production sheet; staging's pm2 name, a look-alike name in
 *      another folder, or no pm2 at all get an error. Scripts always need one.
 *   §2 server.js refuses to boot without SPREADSHEET_ID, before the database
 *      opens and before any Google call, including under a pm2 name of
 *      `logistics-app` outside /var/www/logistics-app.
 *   §3 each script that reads or writes the sheet refuses without
 *      SPREADSHEET_ID before loading the Google client; with one it uses it.
 *   §4 test-suite.js refuses without SPREADSHEET_ID, and refuses the
 *      production sheet, before any request.
 *   §5 no fallback is left: no `SPREADSHEET_ID || "<id>"` in server.js, lib/ or
 *      scripts/, and the production ID appears in scripts/ only where a script
 *      compares against it to refuse production.
 *   §6 the readers of production's own resolution: the replica's Sheets export
 *      and ensure-automation-user.js read lib/sheet-id.js; replica:start hands
 *      the server the IDs its own Sheets copy holds.
 *
 * Hermetic: every child runs in a fresh mkdtemp folder (no .env, no service
 * account key) with googleapis replaced by a recording stub and every outbound
 * connection refused, so nothing reaches Google or the network even if a check
 * regresses.
 *   node scripts/test-sheet-id-required.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PROD_ID = "1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo";
const TEST_ID = "sheet-under-test-c1";
let pass = 0;
const failures = [];
function check(label, cond) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.log(`  FAIL  ${label}`);
}
const readSource = (...parts) => { try { return fs.readFileSync(path.join(ROOT, ...parts), "utf8"); } catch { return ""; } };
const requireOrNull = (p) => { try { return require(p); } catch { return null; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-sheet-id-"));
const log = path.join(tmp, "calls.log");
const stub = path.join(tmp, "no-network.js");
fs.writeFileSync(stub, `"use strict";
const Module = require("module");
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const note = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
const rows = [["Load ID", "Driver", "Job Status", "Truck", "Owner ID"], ["L-1", "Quinn Testdriver", "Dispatched", "T-9", "7"]];
const op = (name) => async (params) => { note("sheets " + name + " " + (params && params.spreadsheetId)); return { data: { values: rows, sheets: [] } }; };
const google = {
	auth: { GoogleAuth: class { constructor() { note("google auth"); } async getClient() { return {}; } } },
	sheets: () => ({ spreadsheets: { get: op("get"), batchUpdate: op("batchUpdate"), values: {
		get: op("values.get"), batchGet: op("values.batchGet"), update: op("values.update"),
		batchUpdate: op("values.batchUpdate"), append: op("values.append"), clear: op("values.clear") } } }),
};
const real = Module._load;
Module._load = function (request, ...rest) { return request === "googleapis" ? { google } : real.call(this, request, ...rest); };
const refuse = (what) => function () { note("network " + what); throw new Error("test: no network (" + what + ")"); };
net.Socket.prototype.connect = refuse("connect");
dns.lookup = refuse("dns.lookup");
`);

// A child: node <script> in its own empty folder, the stub preloaded, and no
// SPREADSHEET_ID unless the case gives one.
function run(script, args, { env = {}, timeout = 20_000 } = {}) {
	const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
	fs.rmSync(log, { force: true });
	const base = { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd, NODE_OPTIONS: `--require ${JSON.stringify(stub)}` };
	const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd, env: { ...base, ...env }, encoding: "utf8", timeout });
	const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, calls, cwd, timedOut: !!(r.error && r.error.code === "ETIMEDOUT") };
}

try {
	console.log("§1 lib/sheet-id.js");
	const lib = requireOrNull(path.join(ROOT, "lib", "sheet-id.js"));
	check("§1 lib/sheet-id.js loads", !!lib);
	if (lib) {
		const prodEnv = { name: "logistics-app", pm_cwd: "/var/www/logistics-app" };
		const server = (env, cwd = "/var/www/logistics-app") => lib.resolveServerSpreadsheetId(env, cwd);
		check("§1 the production ID lives in the lib", lib.PRODUCTION_SPREADSHEET_ID === PROD_ID);
		check("§1 SPREADSHEET_ID wins, trimmed", server({ SPREADSHEET_ID: `  ${TEST_ID} ` }).id === TEST_ID);
		check("§1 …even inside production's process", server({ ...prodEnv, SPREADSHEET_ID: TEST_ID }).id === TEST_ID);
		check("§1 production's own process without one gets the production sheet", server(prodEnv).id === PROD_ID);
		for (const [label, env, cwd] of [
			["no environment at all", {}, "/var/www/logistics-app"],
			["a blank SPREADSHEET_ID", { SPREADSHEET_ID: "   " }, "/tmp/x"],
			["staging's pm2 process", { name: "logisx-staging", pm_cwd: "/var/www/logisx-staging" }, "/var/www/logisx-staging"],
			["pm2 name logistics-app in another folder", { name: "logistics-app", pm_cwd: "/Users/someone/logistics-app" }, "/Users/someone/logistics-app"],
			["production's folder without pm2", {}, "/var/www/logistics-app"],
			["production's pm2 identity, started from another folder", prodEnv, "/tmp/elsewhere"],
		]) {
			const r = server(env, cwd);
			check(`§1 ${label}: no sheet, and an error naming SPREADSHEET_ID`, r.id === "" && /SPREADSHEET_ID is not set/.test(r.error || ""));
		}
		const s = (env, opts) => lib.scriptSpreadsheetId(env, opts);
		check("§1 a script without SPREADSHEET_ID gets an error", s({}, { script: "x.js" }).id === "" && /x\.js needs SPREADSHEET_ID/.test(s({}, { script: "x.js" }).error));
		check("§1 …even in production's process (scripts never fall back)", s({ name: "logistics-app", pm_cwd: "/var/www/logistics-app" }).id === "");
		check("§1 a script with one uses it", s({ SPREADSHEET_ID: TEST_ID }).id === TEST_ID);
		check("§1 the production sheet, named, is allowed by default", s({ SPREADSHEET_ID: PROD_ID }).id === PROD_ID);
		check("§1 …and refused where the script writes test data", s({ SPREADSHEET_ID: PROD_ID }, { refuseProduction: true }).id === "");
	}

	console.log("§2 server.js boot");
	{
		const src = readSource("server.js");
		check("§2 server.js carries no production sheet ID", !src.includes(PROD_ID));
		check("§2 the sheet is resolved through lib/sheet-id.js right after dotenv",
			/require\("dotenv"\)\.config\(\);[\s\S]{0,600}require\("\.\/lib\/sheet-id"\)\.resolveServerSpreadsheetId\(process\.env, process\.cwd\(\)\)/.test(src));
		const env = { DATABASE_PATH: "", PORT: "0", SESSION_SECRET: "s".repeat(48), NODE_ENV: "development" };
		for (const [label, extra] of [["no SPREADSHEET_ID", {}], ["pm2 name logistics-app outside /var/www/logistics-app", { name: "logistics-app", pm_cwd: "/var/www/logistics-app", pm_id: "0" }]]) {
			const dbDir = fs.mkdtempSync(path.join(tmp, "db-"));
			const r = run("server.js", [], { env: { ...env, ...extra, DATABASE_PATH: path.join(dbDir, "app.db") } });
			check(`§2 ${label}: refuses to start (exit ${r.code}${r.timedOut ? ", still running at 20 s" : ""})`, r.code === 1 && /SPREADSHEET_ID is not set/.test(r.out));
			check(`§2 ${label}: …before the database opens`, !fs.existsSync(path.join(dbDir, "app.db")));
			check(`§2 ${label}: …and before any Google call or connection (${r.calls.join("; ") || "none"})`, r.calls.length === 0);
		}
	}

	console.log("§3 scripts");
	const scripts = [
		["scripts/lookup-load.js", ["L-1"], true],
		["scripts/delete-load-row.js", ["2", "L-1"], true],
		["scripts/return-driver-loads.js", ["Quinn Testdriver"], true],
		["scripts/regenerate-invoice-pdfs.js", [], false],
		["scripts/measure-load-distance-accuracy.js", ["--dry-run"], false],
		["scripts/audit-job-tracking-damage.js", [], false],
	];
	for (const [script, args, positive] of scripts) {
		const name = path.basename(script);
		const r = run(script, args);
		check(`§3 ${name} without SPREADSHEET_ID: refuses (exit ${r.code}), naming it`, r.code === 2 && /needs SPREADSHEET_ID/.test(r.out));
		check(`§3 ${name}: …before loading the Google client (${r.calls.join("; ") || "none"})`, r.calls.length === 0);
		check(`§3 ${name}: the production ID is not in the script`, !readSource(script).includes(PROD_ID));
		if (positive) {
			const ok = run(script, args, { env: { SPREADSHEET_ID: TEST_ID } });
			const sheetCalls = ok.calls.filter((c) => c.startsWith("sheets "));
			check(`§3 ${name} with SPREADSHEET_ID: every sheet call uses it (${sheetCalls.join("; ") || "no calls"})`,
				sheetCalls.length > 0 && sheetCalls.every((c) => c.endsWith(` ${TEST_ID}`)));
		}
	}
	{
		const r = run("scripts/audit-job-tracking-damage.js", ["--sheet-id=named-on-the-command-line"]);
		check(`§3 audit-job-tracking-damage.js: an explicit --sheet-id still passes the gate (exit ${r.code})`, !/needs SPREADSHEET_ID/.test(r.out));
	}

	console.log("§4 test-suite.js");
	for (const [label, env, want] of [["without SPREADSHEET_ID", {}, /needs SPREADSHEET_ID/], ["with the production sheet", { SPREADSHEET_ID: PROD_ID }, /refuses the production sheet/]]) {
		const r = run("test-suite.js", [], { env: { ...env, TEST_PORT: "9" } });
		check(`§4 ${label}: refuses (exit ${r.code})`, r.code === 2 && want.test(r.out));
		check(`§4 ${label}: …before any request (${r.calls.join("; ") || "none"})`, r.calls.length === 0 && !/PASS|FAIL\b/.test(r.out));
	}

	console.log("§5 no fallback left");
	{
		const files = [];
		const walk = (dir) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				if (e.name === "node_modules") continue;
				const p = path.join(dir, e.name);
				if (e.isDirectory()) walk(p);
				else if (/\.(c?js|mjs|sh)$/.test(e.name)) files.push(path.relative(ROOT, p));
			}
		};
		walk(path.join(ROOT, "scripts"));
		walk(path.join(ROOT, "lib"));
		files.push("server.js", "test-suite.js");
		// The main sheet only: ARCHIVE_SPREADSHEET_ID names a separate read-only book.
		const fallback = /(?<![A-Z_])SPREADSHEET_ID\b[^\n;]{0,40}\|\|\s*["'`][A-Za-z0-9_-]{20,}/;
		// This runner's §6 fixture carries an older server.js's line on purpose.
		const withFallback = files.filter((f) => f !== "scripts/test-sheet-id-required.js" && fallback.test(readSource(f)));
		check(`§5 no SPREADSHEET_ID fallback to a literal ID (${withFallback.join(", ") || "none"})`, withFallback.length === 0);
		// Scripts that name the production ID to refuse it (or, in a test, to
		// prove the refusal). Anything else has no business knowing it.
		const GUARDS = new Set([
			"lib/sheet-id.js",
			"scripts/refresh-local.sh", "scripts/refresh-staging.sh", "scripts/refresh-env.js",
			"scripts/rename-job-details-output-column.js",
			"scripts/e2e/boot-server.sh", "scripts/e2e/e2e.mjs", "scripts/e2e/payout-parity.mjs",
			"scripts/test-sanitize-before-transfer.js", "scripts/test-sheet-id-required.js",
		]);
		const naming = files.filter((f) => !GUARDS.has(f) && readSource(f).includes(PROD_ID));
		check(`§5 the production ID appears only in the lib and in production guards (${naming.join(", ") || "none"})`, naming.length === 0);
	}

	console.log("§6 readers of production's resolution");
	{
		const exp = requireOrNull(path.join(ROOT, "scripts", "replica", "remote", "sheets-export.js"));
		const dotenv = require("dotenv");
		const app = (files) => {
			const d = fs.mkdtempSync(path.join(tmp, "app-"));
			for (const [f, body] of Object.entries(files)) {
				fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
				fs.writeFileSync(path.join(d, f), body);
			}
			return d;
		};
		const ARCHIVE = 'const ARCHIVE_SPREADSHEET_ID = process.env.ARCHIVE_SPREADSHEET_ID || "archive-literal-id-0123456789";\n';
		const LIB = readSource("lib", "sheet-id.js");
		// Production's own folder: the PRODUCTION_DIR its lib/sheet-id.js names.
		const productionApp = (env) => {
			const d = app({ "server.js": ARCHIVE, ".env": env });
			fs.mkdirSync(path.join(d, "lib"));
			fs.writeFileSync(path.join(d, "lib", "sheet-id.js"),
				LIB.replace(/^const PRODUCTION_DIR = "[^"]+";$/m, `const PRODUCTION_DIR = ${JSON.stringify(d)};`));
			return d;
		};
		const production = productionApp("");
		const productionNamed = productionApp(`SPREADSHEET_ID=${TEST_ID}\n`);
		const other = app({ "server.js": ARCHIVE, "lib/sheet-id.js": LIB, ".env": "" });
		const older = app({ "server.js": `const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "older-literal-id-0123456789";\n${ARCHIVE}`, ".env": "" });
		const named = app({ "server.js": ARCHIVE, "lib/sheet-id.js": LIB, ".env": `SPREADSHEET_ID=${TEST_ID}\n` });
		const ids = (d) => { try { return exp.spreadsheetIds(d, dotenv); } catch (e) { return { error: e.message, exitCode: e.exitCode }; } };
		check("§6 the replica export reads production's sheets in production's own folder (lib/sheet-id.js's PRODUCTION_DIR)",
			!!exp && LIB.includes("const PRODUCTION_DIR = ") && ids(production).main === PROD_ID && ids(production).archive === "archive-literal-id-0123456789");
		check("§6 …production's folder still takes its own SPREADSHEET_ID first", !!exp && ids(productionNamed).main === TEST_ID);
		check("§6 …any other folder that names no SPREADSHEET_ID is refused with exit 2",
			!!exp && ids(other).exitCode === 2 && !ids(other).main && !String(ids(other).error).includes(PROD_ID));
		check("§6 …and an older server.js's literal is no default outside production's folder", !!exp && ids(older).exitCode === 2);
		check("§6 …an app's own SPREADSHEET_ID comes first, and an unnamed archive gets no default",
			!!exp && ids(named).main === TEST_ID && ids(named).archive === "");
		fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(other, "node_modules"));
		const out = path.join(tmp, "sheets-refused.json");
		const refused = run(path.join("scripts", "replica", "remote", "sheets-export.js"), [`--app=${other}`, `--out=${out}`]);
		check("§6 the export run against another folder exits 2, writes nothing and calls nothing",
			refused.code === 2 && refused.calls.length === 0 && !fs.existsSync(out)
			&& /SPREADSHEET_ID/.test(refused.out) && !refused.out.includes(PROD_ID));

		const C = requireOrNull(path.join(ROOT, "scripts", "replica", "common.js"));
		const sheetsJson = path.join(tmp, "sheets.json");
		fs.writeFileSync(sheetsJson, JSON.stringify({ format: 1, spreadsheets: { "copy-main-id": { role: "main" }, "copy-archive-id": { role: "archive" } } }));
		const got = C && typeof C.replicaSheetIds === "function" ? C.replicaSheetIds(sheetsJson) : null;
		check("§6 replica:start reads the IDs its Sheets copy holds, by role",
			!!got && got.SPREADSHEET_ID === "copy-main-id" && got.ARCHIVE_SPREADSHEET_ID === "copy-archive-id");
		fs.writeFileSync(sheetsJson, JSON.stringify({ format: 1, spreadsheets: { "copy-archive-id": { role: "archive" } } }));
		let threw = false;
		try { C.replicaSheetIds(sheetsJson); } catch { threw = true; }
		check("§6 …and refuses a copy with no main sheet", threw);
		check("§6 replica:start passes them to the server", /\.\.\.C\.replicaSheetIds\(path\.join\(work, "sheets\.json"\)\)/.test(readSource("scripts", "replica", "start.js")));
		check("§6 ensure-automation-user.js takes the production ID from lib/sheet-id.js",
			/require\("\.\.\/lib\/sheet-id"\)\.PRODUCTION_SPREADSHEET_ID/.test(readSource("scripts", "ensure-automation-user.js")));
	}
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
