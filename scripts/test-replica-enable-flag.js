#!/usr/bin/env node
// replica:start --enable <NAME> (scripts/replica/start.js, the rule in
// lib/replica-rules.js): one replica task's server gets a business flag set to
// "true", and nothing that reaches outside this machine can be switched on.
//
//   §1 the rule: each name on the allowlist is accepted; each refused name is
//      refused with its own reason; a name with a value, in lower case, not
//      ending in _ENABLED, secret-named, a runtime key or unknown is refused;
//      every _ENABLED name server.js or lib/ reads is classified exactly once
//      (a new flag fails this runner until someone decides), every allowed
//      name is read by the app, and every line that reads it has a
//      default-off shape (=== "true", !== "true", the true|1|yes|on test, or
//      toLowerCase() === "true"); a made-up default-on read is caught
//   §2 replica:start with two allowed flags: exits 0, its banner says
//      "enabled for this task: ..." with both names, the server's environment
//      holds exactly those two _ENABLED names set to "true", the record lists
//      them, and the settings file is byte-for-byte unchanged
//   §3 without --enable: no such banner line and no _ENABLED name in the
//      server's environment
//   §4 refusals: an outbound switch, a credential, a name with a value, a
//      lower-case name, an unknown flag, a missing value, and an allowed flag
//      next to a refused one each exit 1 naming the reason, before anything
//      starts (no working copy, no record); a value typed after "=", and a
//      word in the name's place that looks like a key, are never printed
//   §5 --from-month YYYY-MM: LEDGER_DAY_ONCE_ENABLED,
//      PRE_DISPATCH_PAY_DAY_RULE_ENABLED and TRIP_WORK_DAYS_ENABLED do nothing
//      without their first month, so any of them without --from-month is
//      refused, --from-month without one is refused, and a month that isn't
//      YYYY-MM (2000-2099, 01-12) or
//      a second --from-month is refused, each before anything starts; with
//      one, the matching *_FROM is in the server's environment only, shown in
//      the banner and recorded
//   §6 --help lists --enable and --from-month
//
// The start.js under test runs from scripts/replica/ of a throwaway folder,
// beside this checkout's common.js and lib/replica-rules.js. HOME is a
// temporary folder, so ~/LogisX-replica is a throwaway one too. The server is a
// stand-in server.js that writes the _ENABLED and _FROM names of its
// environment to its log, answers replica:start's readiness check once and
// exits (at 10 s by itself at the latest).
//
// Standalone: node scripts/test-replica-enable-flag.js. Temporary folders only,
// free local ports, no network.
"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const rules = require(path.join(ROOT, "lib", "replica-rules.js"));
const RUNS_UNTIL = Date.now() + 45000;

let failures = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`  ok   ${name}`);
	else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
const tempDirs = [];
process.on("exit", () => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
	tempDirs.push(d);
	return d;
};
const tail = (text) => text.trim().split("\n").slice(-6).join(" | ");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---- §1 the rule -----------------------------------------------------------------------------
console.log("§1 which names --enable takes");
const ALLOWED = Array.isArray(rules.ENABLE_ALLOWED) ? rules.ENABLE_ALLOWED : [];
const REFUSED = rules.ENABLE_REFUSED && typeof rules.ENABLE_REFUSED === "object" ? rules.ENABLE_REFUSED : {};
const refusal = typeof rules.enableRefusal === "function" ? rules.enableRefusal : () => "enableRefusal() is missing";
ok("replica-rules exports ENABLE_ALLOWED, ENABLE_REFUSED and enableRefusal()", ALLOWED.length > 0 && Object.keys(REFUSED).length > 0 && typeof rules.enableRefusal === "function");
ok("...frozen, so nothing at run time adds to them", Object.isFrozen(rules.ENABLE_ALLOWED) && Object.isFrozen(rules.ENABLE_REFUSED));
for (const name of ["PERSONAL_EXPENSE_DEDUCTIONS_ENABLED", "PAYOUT_RULES_V2_ENABLED", "INVESTOR_LEASE_PAYOUTS_ENABLED", "LEDGER_DAY_ONCE_ENABLED", "PRE_DISPATCH_PAY_DAY_RULE_ENABLED", "TRIP_WORK_DAYS_ENABLED", "BROKER_INVOICE_LINES_ENABLED"]) {
	eq(`${name} is accepted`, refusal(name), null);
}
// B20 advance lines: an allowed flag the app reads in a default-off shape (the
// generic checks below), and one that needs no first month.
ok("BROKER_INVOICE_LINES_ENABLED needs no --from-month", !Object.prototype.hasOwnProperty.call(rules.ENABLE_FROM || {}, "BROKER_INVOICE_LINES_ENABLED"));
// The owner-operator flags: rows in the task's own database and its own PDFs; nothing sent.
for (const name of ["OWNER_OPERATOR_ONBOARDING_ENABLED", "OWNER_OPERATOR_LOAD_PAY_ENABLED", "OWNER_OPERATOR_SETTLEMENTS_ENABLED", "OWNER_OPERATOR_ESCROW_ENABLED"]) {
	eq(`${name} is accepted`, refusal(name), null);
	ok(`...and needs no --from-month`, !Object.prototype.hasOwnProperty.call(rules.ENABLE_FROM || {}, name));
}
for (const name of ALLOWED) eq(`allowlisted ${name} is accepted`, refusal(name), null);
// The switches that reach outside this machine, by what they reach.
const OUTBOUND = {
	ROUTEMATE_ENABLED: /ELD|outside/i,
	LINXUP_ENABLED: /ELD|outside/i,
	SCANKIT_ENABLED: /OCR|outside/i,
	RATECON_RECONCILE_ENABLED: /Gmail/i,
	RATECON_INDEX_APPLY_ENABLED: /Drive/i,
	FUEL_GALLONS_RECOVERY_ENABLED: /Gemini/i,
	KPI_DEADHEAD_ROUTES_ENABLED: /Routes/i,
	KPI_DIGEST_ENABLED: /email/i,
	INTEGRITY_CHECK_ENABLED: /email/i,
	ELD_STALE_ALERT_ENABLED: /email/i,
	EXPENSE_DUPLICATE_ALERT_ENABLED: /email/i,
	FUEL_LOW_ALERT_ENABLED: /email/i,
	INVOICE_UNDATED_ALERT_ENABLED: /email/i,
	RATECON_EXTRACT_ALERT_ENABLED: /email/i,
	INVOICE_AUTOGEN_ENABLED: /scheduled job/i,
	FUEL_EVENTS_ENABLED: /scheduled job/i,
	CHAT_ORPHAN_SWEEP_ENABLED: /scheduled job/i,
	// The automatic invoice render shadow: Drive and Gemini, behind the job's timer.
	AUTO_INVOICE_SHADOW_RENDERS_ENABLED: /render shadow reads Drive and calls Gemini/i,
};
for (const [name, why] of Object.entries(OUTBOUND)) {
	const r = refusal(name);
	ok(`${name} is refused, saying why`, typeof r === "string" && why.test(r), r);
	ok(`...and is not on the allowlist`, !ALLOWED.includes(name));
}
for (const [name, reason] of Object.entries(REFUSED)) {
	ok(`refused ${name} has a reason and is refused with it`, typeof reason === "string" && reason.length > 10 && String(refusal(name)).includes(reason), refusal(name));
}
for (const bad of ["PAYOUT_RULES_V2_ENABLED=true", "PAYOUT_RULES_V2_ENABLED=", "payout_rules_v2_enabled", "Payout_Rules_V2_Enabled", "PAYOUT_RULES_V2", "_ENABLED", "1_ENABLED", " PAYOUT_RULES_V2_ENABLED", "PAYOUT_RULES_V2_ENABLED ", "", undefined, null, 1]) {
	const r = refusal(bad);
	ok(`${JSON.stringify(bad)} is refused (a plain upper-case name ending in _ENABLED only)`, typeof r === "string" && r.length > 0, r);
}
for (const [name, why] of [["GMAIL_APP_PASSWORD", /secret|_ENABLED/i], ["WEBHOOK_ENABLED", /secret: name contains WEBHOOK/], ["SMTP_ENABLED", /secret: name contains SMTP/], ["AUTH_TOKEN_ENABLED", /secret/], ["MADE_UP_ENABLED", /allowlist/]]) {
	const r = refusal(name);
	ok(`${name} is refused (${why})`, typeof r === "string" && why.test(r), r);
}

// Every flag the app reads is decided: allowed or refused, never both, never neither.
const sources = [require("./lib/server-source").serverSource(),
	...fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(ROOT, "lib", f), "utf8"))];
const readNames = new Set();
for (const src of sources) for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*_ENABLED)\b/g)) readNames.add(m[1]);
ok("(fixture) the app reads at least 20 _ENABLED names", readNames.size >= 20, [...readNames]);
const undecided = [...readNames].filter((n) => !ALLOWED.includes(n) && !Object.prototype.hasOwnProperty.call(REFUSED, n)).sort();
eq("every _ENABLED name server.js or lib/ reads is on the allowlist or the refused list (decide a new one in lib/replica-rules.js)", undecided, []);
eq("no name is on both lists", ALLOWED.filter((n) => Object.prototype.hasOwnProperty.call(REFUSED, n)), []);
eq("every allowed name is one the app reads", ALLOWED.filter((n) => !readNames.has(n)), []);
eq("every allowed name passes the export's business-setting rule", ALLOWED.filter((n) => !rules.classifySetting(n, "true").copy), []);
// Every allowed flag defaults off where it is read: each line that reads it has
// one of the default-off shapes, so a kill switch (on unless set to false) or
// any other default-on read is never allowed ("true" would only override
// production's own "off").
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function readsDefaultOff(name, srcs) {
	const n = esc(name);
	const shapes = [
		new RegExp(`env\\.${n}\\s*===\\s*"true"`),
		new RegExp(`env\\.${n}\\s*!==\\s*"true"`),
		// process.env, or an `env` a lib function is handed (lib/trip-work-days.js ruleFromEnv()).
		new RegExp(`/\\^\\(true\\|1\\|yes\\|on\\)\\$/i\\.test\\(String\\((?:process\\.)?env\\.${n} \\?\\? ""\\)\\.trim\\(\\)\\)`),
		new RegExp(`String\\(process\\.env\\.${n} \\|\\| ""\\)\\.toLowerCase\\(\\) === "true"`),
	];
	const reads = srcs.flatMap((src) => src.split("\n")).filter((l) => new RegExp(`env\\.${n}\\b`).test(l));
	return reads.length > 0 && reads.every((l) => shapes.some((rx) => rx.test(l)));
}
eq("every allowed name defaults off on every line that reads it", ALLOWED.filter((n) => !readsDefaultOff(n, sources)), []);
eq("(check) a made-up default-on read is caught: !== \"false\", the false|0|no|off kill switch, a bare truthy read, no read",
	["const A = process.env.A_ENABLED !== \"false\";",
		"const A = !/^(false|0|no|off)$/i.test(String(process.env.A_ENABLED ?? \"\").trim());",
		"if (process.env.A_ENABLED) on();",
		"const B = 1;"].map((l) => readsDefaultOff("A_ENABLED", [l])),
	[false, false, false, false]);
eq("(check) the default-off shapes pass",
	["const A = process.env.A_ENABLED === \"true\";", "if (!env || env.A_ENABLED !== \"true\") return null;",
		"const A = /^(true|1|yes|on)$/i.test(String(process.env.A_ENABLED ?? \"\").trim());",
		"const A = String(process.env.A_ENABLED || \"\").toLowerCase() === \"true\";"].map((l) => readsDefaultOff("A_ENABLED", [l])),
	[true, true, true, true]);

// ---- §2-§5 replica:start ---------------------------------------------------------------------
const STAND_IN_SERVER = `"use strict";
// Stand-in for the app: logs the _ENABLED and _FROM names it was given, answers replica:start's readiness check once, then exits.
const http = require("http");
const flags = Object.keys(process.env).filter((k) => /_(ENABLED|FROM)$/.test(k)).sort().map((k) => k + "=" + process.env[k]);
console.log("stand-in enabled: " + JSON.stringify(flags));
const server = http.createServer((req, res) => {
	const ready = req.url === "/api/auth/session";
	res.writeHead(ready ? 200 : 404, { "content-type": "application/json", connection: "close" });
	res.end("{}", () => { if (ready) process.exit(0); });
});
server.listen(Number(process.env.PORT), process.env.BIND_HOST);
setTimeout(() => process.exit(3), 10000);
`;
const SETTINGS = "TZ=America/New_York\nAPP_TIMEZONE=America/New_York\n";

function write(dir, rel, text) {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), text);
}

function fixture() {
	const base = tmp("replica-enable-");
	const repo = path.join(base, "repo");
	write(repo, "server.js", STAND_IN_SERVER);
	write(repo, "client/dist/index.html", "<!doctype html><title>stand-in</title>\n");
	fs.mkdirSync(path.join(repo, "scripts", "replica"), { recursive: true });
	fs.mkdirSync(path.join(repo, "lib"), { recursive: true });
	fs.copyFileSync(path.join(ROOT, "scripts", "replica", "start.js"), path.join(repo, "scripts", "replica", "start.js"));
	fs.copyFileSync(path.join(ROOT, "scripts", "replica", "common.js"), path.join(repo, "scripts", "replica", "common.js"));
	fs.copyFileSync(path.join(ROOT, "lib", "replica-rules.js"), path.join(repo, "lib", "replica-rules.js"));
	fs.mkdirSync(path.join(repo, "node_modules"));
	fs.mkdirSync(path.join(repo, "client", "node_modules"));
	const home = path.join(base, "home");
	const root = path.join(home, "LogisX-replica");
	const clean = path.join(root, "clean");
	fs.mkdirSync(clean, { recursive: true });
	fs.writeFileSync(path.join(clean, "app.db"), "");
	fs.writeFileSync(path.join(clean, "sheets.json"), JSON.stringify({ format: 1, spreadsheets: { "replica-test-main": { role: "main" } } }));
	fs.writeFileSync(path.join(clean, "manifest.json"), JSON.stringify({
		format: 1,
		snapshotAt: "2026-01-02T03:04:05.000Z",
		production: { commit: "0123456789abcdef0123456789abcdef01234567", node: process.version, timeZone: "America/New_York" },
	}));
	fs.writeFileSync(path.join(root, "settings.env"), SETTINGS, { mode: 0o600 });
	for (const d of ["uploads", "storage", "evidence-archive"]) fs.mkdirSync(path.join(root, d));
	return { base, repo, home, root };
}

const freePort = () => new Promise((resolve, reject) => {
	const s = net.createServer();
	s.once("error", reject);
	s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function exited(pid) {
	for (let i = 0; i < 50; i++) {
		try { process.kill(pid, 0); } catch (err) { if (err.code === "ESRCH") return true; }
		sleep(100);
	}
	return false;
}

async function start(fx, task, extra) {
	const port = await freePort();
	const env = { PATH: process.env.PATH, HOME: fx.home, TMPDIR: os.tmpdir(), LC_ALL: "C", GIT_CEILING_DIRECTORIES: fx.base };
	const r = spawnSync(process.execPath, [path.join(fx.repo, "scripts", "replica", "start.js"), "--task", task, "--port", String(port), ...extra],
		{ cwd: fx.repo, env, encoding: "utf8", timeout: Math.max(1, Math.min(12000, RUNS_UNTIL - Date.now())) });
	const recFile = path.join(fx.root, "work", task, "server.json");
	const record = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, "utf8")) : null;
	const log = record && record.log && fs.existsSync(record.log) ? fs.readFileSync(record.log, "utf8") : "";
	const m = log.match(/^stand-in enabled: (.*)$/m);
	return {
		status: r.status,
		out: `${r.stdout || ""}${r.stderr || ""}`,
		record,
		serverFlags: m ? JSON.parse(m[1]) : null,
		serverExited: record && Number.isInteger(record.pid) ? exited(record.pid) : true,
		workExists: fs.existsSync(path.join(fx.root, "work", task)),
	};
}

// A made-up key shape (mixed case, digits, 32 characters): never printed back.
const KEYLIKE = "Zq8xW2mN4pR6tY1uI3oP5aS7dF9gH0jK";
const taskFor = (label) => `refused-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "").slice(0, 30).replace(/-$/, "")}`;

(async () => {
	const fx = fixture();
	const settingsFile = path.join(fx.root, "settings.env");

	console.log("§2 two allowed flags: on for this task's server only");
	{
		const r = await start(fx, "flags", ["--enable", "PERSONAL_EXPENSE_DEDUCTIONS_ENABLED", "--enable", "PAYOUT_RULES_V2_ENABLED"]);
		eq("replica:start exits 0", r.status, 0);
		ok("...and says it is serving", /is serving at http:\/\/127\.0\.0\.1:\d+/.test(r.out), tail(r.out));
		ok("its banner says \"enabled for this task: PAYOUT_RULES_V2_ENABLED, PERSONAL_EXPENSE_DEDUCTIONS_ENABLED\"",
			r.out.includes("enabled for this task: PAYOUT_RULES_V2_ENABLED, PERSONAL_EXPENSE_DEDUCTIONS_ENABLED"), tail(r.out));
		eq("the server's environment holds exactly those two _ENABLED names, each \"true\"", r.serverFlags,
			["PAYOUT_RULES_V2_ENABLED=true", "PERSONAL_EXPENSE_DEDUCTIONS_ENABLED=true"]);
		eq("the record lists them", r.record && r.record.enabled, ["PAYOUT_RULES_V2_ENABLED", "PERSONAL_EXPENSE_DEDUCTIONS_ENABLED"]);
		eq("the settings file is byte-for-byte unchanged", fs.readFileSync(settingsFile, "utf8"), SETTINGS);
		ok("the stand-in server has exited", r.serverExited);
	}

	console.log("§3 without --enable: nothing enabled");
	{
		const r = await start(fx, "plain", []);
		eq("replica:start exits 0", r.status, 0);
		ok("no \"enabled for this task\" line", !r.out.includes("enabled for this task"), tail(r.out));
		eq("no _ENABLED name in the server's environment", r.serverFlags, []);
		eq("the record lists none", r.record && r.record.enabled, []);
		ok("the stand-in server has exited", r.serverExited);
	}

	console.log("§4 refused before anything starts");
	for (const [label, extra, why] of [
		["an outbound switch (ROUTEMATE_ENABLED)", ["--enable", "ROUTEMATE_ENABLED"], /ROUTEMATE_ENABLED.*ELD/],
		["a Gmail switch (RATECON_RECONCILE_ENABLED)", ["--enable", "RATECON_RECONCILE_ENABLED"], /RATECON_RECONCILE_ENABLED.*Gmail/],
		["a credential (GMAIL_APP_PASSWORD)", ["--enable", "GMAIL_APP_PASSWORD"], /GMAIL_APP_PASSWORD/],
		["a name with a value", ["--enable", "PAYOUT_RULES_V2_ENABLED=typedvalue7"], /PAYOUT_RULES_V2_ENABLED=\.\.\.: --enable takes one setting name/],
		["a lower-case name", ["--enable", "payout_rules_v2_enabled"], /payout_rules_v2_enabled/],
		["an unknown flag", ["--enable", "MADE_UP_ENABLED"], /MADE_UP_ENABLED.*allowlist/],
		["a missing value", ["--enable"], /--enable needs a setting name/],
		["an option where the value should be", ["--enable", "--fresh"], /--enable needs a setting name/],
		["an allowed flag next to a refused one", ["--enable", "PAYOUT_RULES_V2_ENABLED", "--enable", "KPI_DIGEST_ENABLED"], /KPI_DIGEST_ENABLED.*email/],
		["a key typed in the name's place", ["--enable", KEYLIKE], /--enable \(not shown: it looks like a key\): --enable takes one setting name/],
		["a key typed in the name's place, with a value", ["--enable", `${KEYLIKE}=x`], /--enable \(not shown: it looks like a key\): --enable takes one setting name/],
	]) {
		const r = await start(fx, taskFor(label), extra);
		eq(`${label}: replica:start exits 1`, r.status, 1);
		ok("...naming the reason", why.test(r.out), tail(r.out));
		ok("...with no working copy made and no server recorded", !r.workExists && r.record === null);
		ok("...and never prints a value typed after \"=\" or a word that looks like a key", !r.out.includes("typedvalue7") && !r.out.includes(KEYLIKE), tail(r.out));
	}
	eq("the settings file is still byte-for-byte unchanged", fs.readFileSync(settingsFile, "utf8"), SETTINGS);

	console.log("§5 --from-month: the first month of the rules that need one");
	for (const [label, extra, why] of [
		["LEDGER_DAY_ONCE_ENABLED without --from-month", ["--enable", "LEDGER_DAY_ONCE_ENABLED"], /LEDGER_DAY_ONCE_ENABLED does nothing without its first month.*--from-month YYYY-MM/],
		["TRIP_WORK_DAYS_ENABLED without --from-month", ["--enable", "TRIP_WORK_DAYS_ENABLED"], /TRIP_WORK_DAYS_ENABLED does nothing without its first month.*--from-month YYYY-MM/],
		["PRE_DISPATCH_PAY_DAY_RULE_ENABLED without --from-month", ["--enable", "PAYOUT_RULES_V2_ENABLED", "--enable", "PRE_DISPATCH_PAY_DAY_RULE_ENABLED"],
			/PRE_DISPATCH_PAY_DAY_RULE_ENABLED does nothing without its first month.*--from-month YYYY-MM/],
		["--from-month without either rule", ["--from-month", "2026-10"], /--from-month sets the first month of LEDGER_DAY_ONCE_ENABLED or PRE_DISPATCH_PAY_DAY_RULE_ENABLED/],
		["--from-month with another flag only", ["--enable", "PAYOUT_RULES_V2_ENABLED", "--from-month", "2026-10"], /--from-month sets the first month of/],
		...["2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", "1999-12", "2100-01", "2026/10", " 2026-10", "abcd-ef", KEYLIKE].map((m) =>
			[`--from-month ${JSON.stringify(m).slice(0, 14)}`, ["--enable", "LEDGER_DAY_ONCE_ENABLED", "--from-month", m], /--from-month needs a month, YYYY-MM/]),
		["--from-month with no value", ["--enable", "LEDGER_DAY_ONCE_ENABLED", "--from-month"], /--from-month needs a month, YYYY-MM/],
		["--from-month followed by an option", ["--enable", "LEDGER_DAY_ONCE_ENABLED", "--from-month", "--fresh"], /--from-month needs a month, YYYY-MM/],
		["--from-month twice", ["--enable", "LEDGER_DAY_ONCE_ENABLED", "--from-month", "2026-10", "--from-month", "2026-11"], /--from-month once/],
	]) {
		const r = await start(fx, taskFor(label), extra);
		eq(`${label}: replica:start exits 1`, r.status, 1);
		ok("...naming the reason", why.test(r.out), tail(r.out));
		ok("...with no working copy made and no server recorded", !r.workExists && r.record === null);
		ok("...and never prints a word that looks like a key", !r.out.includes(KEYLIKE), tail(r.out));
	}
	{
		const r = await start(fx, "from-one", ["--enable", "PRE_DISPATCH_PAY_DAY_RULE_ENABLED", "--from-month", "2026-10"]);
		eq("one rule with --from-month 2026-10: replica:start exits 0", r.status, 0);
		eq("...the server's environment holds the flag and its first month", r.serverFlags,
			["PRE_DISPATCH_PAY_DAY_RULE_ENABLED=true", "PRE_DISPATCH_PAY_DAY_RULE_FROM=2026-10"]);
		ok("...the banner shows the month", r.out.includes("first month for this task: PRE_DISPATCH_PAY_DAY_RULE_FROM=2026-10"), tail(r.out));
		eq("...the record holds it", r.record && r.record.fromMonth, "2026-10");
		ok("the stand-in server has exited", r.serverExited);
	}
	{
		const r = await start(fx, "from-both", ["--enable", "LEDGER_DAY_ONCE_ENABLED", "--from-month", "2026-11", "--enable", "PRE_DISPATCH_PAY_DAY_RULE_ENABLED"]);
		eq("both rules with one --from-month: replica:start exits 0", r.status, 0);
		eq("...each gets that first month", r.serverFlags, ["LEDGER_DAY_ONCE_ENABLED=true", "LEDGER_DAY_ONCE_FROM=2026-11",
			"PRE_DISPATCH_PAY_DAY_RULE_ENABLED=true", "PRE_DISPATCH_PAY_DAY_RULE_FROM=2026-11"]);
		ok("...the banner shows both", r.out.includes("first month for this task: LEDGER_DAY_ONCE_FROM=2026-11, PRE_DISPATCH_PAY_DAY_RULE_FROM=2026-11"), tail(r.out));
		ok("the stand-in server has exited", r.serverExited);
	}
	{
		const r = await start(fx, "from-trip", ["--enable", "TRIP_WORK_DAYS_ENABLED", "--from-month", "2026-11"]);
		eq("TRIP_WORK_DAYS_ENABLED with --from-month 2026-11: replica:start exits 0", r.status, 0);
		eq("...the server's environment holds the flag and TRIP_WORK_DAYS_FROM", r.serverFlags, ["TRIP_WORK_DAYS_ENABLED=true", "TRIP_WORK_DAYS_FROM=2026-11"]);
		ok("...the banner shows the month", r.out.includes("first month for this task: TRIP_WORK_DAYS_FROM=2026-11"), tail(r.out));
		ok("the stand-in server has exited", r.serverExited);
	}
	eq("the settings file is still byte-for-byte unchanged after --from-month", fs.readFileSync(settingsFile, "utf8"), SETTINGS);

	console.log("§6 --help");
	{
		const r = spawnSync(process.execPath, [path.join(fx.repo, "scripts", "replica", "start.js"), "--help"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: fx.home } });
		eq("--help exits 0", r.status, 0);
		ok("...and lists --enable <NAME>", /--enable <NAME>/.test(r.stdout), tail(r.stdout));
		ok("...and --from-month YYYY-MM", /--from-month YYYY-MM/.test(r.stdout), tail(r.stdout));
		ok("...and stops at the end of the usage comment (no code)", !/use strict/.test(r.stdout) && !/require\(/.test(r.stdout), tail(r.stdout));
	}

	console.log(failures ? `\n${failures} FAILED` : "\nall passed");
	process.exit(failures ? 1 : 0);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
