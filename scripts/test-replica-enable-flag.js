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
//      name is read by the app and defaults off where it is read
//   §2 replica:start with two allowed flags: exits 0, its banner says
//      "enabled for this task: ..." with both names, the server's environment
//      holds exactly those two _ENABLED names set to "true", the record lists
//      them, and the settings file is byte-for-byte unchanged
//   §3 without --enable: no such banner line and no _ENABLED name in the
//      server's environment
//   §4 refusals: an outbound switch, a credential, a name with a value, a
//      lower-case name, an unknown flag, a missing value, and an allowed flag
//      next to a refused one each exit 1 naming the reason, before anything
//      starts (no working copy, no record); a value typed after "=" is never
//      printed
//   §5 --help lists --enable
//
// The start.js under test runs from scripts/replica/ of a throwaway folder,
// beside this checkout's common.js and lib/replica-rules.js. HOME is a
// temporary folder, so ~/LogisX-replica is a throwaway one too. The server is a
// stand-in server.js that writes the _ENABLED names of its environment to its
// log, answers replica:start's readiness check once and exits (at 10 s by
// itself at the latest).
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
for (const name of ["PERSONAL_EXPENSE_DEDUCTIONS_ENABLED", "PAYOUT_RULES_V2_ENABLED", "INVESTOR_LEASE_PAYOUTS_ENABLED", "LEDGER_DAY_ONCE_ENABLED", "PRE_DISPATCH_PAY_DAY_RULE_ENABLED"]) {
	eq(`${name} is accepted`, refusal(name), null);
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
const sources = [fs.readFileSync(path.join(ROOT, "server.js"), "utf8"),
	...fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(ROOT, "lib", f), "utf8"))];
const readNames = new Set();
for (const src of sources) for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*_ENABLED)\b/g)) readNames.add(m[1]);
ok("(fixture) the app reads at least 20 _ENABLED names", readNames.size >= 20, [...readNames]);
const undecided = [...readNames].filter((n) => !ALLOWED.includes(n) && !Object.prototype.hasOwnProperty.call(REFUSED, n)).sort();
eq("every _ENABLED name server.js or lib/ reads is on the allowlist or the refused list (decide a new one in lib/replica-rules.js)", undecided, []);
eq("no name is on both lists", ALLOWED.filter((n) => Object.prototype.hasOwnProperty.call(REFUSED, n)), []);
eq("every allowed name is one the app reads", ALLOWED.filter((n) => !readNames.has(n)), []);
eq("every allowed name passes the export's business-setting rule", ALLOWED.filter((n) => !rules.classifySetting(n, "true").copy), []);
// A kill switch (on unless set to false/0/no/off) is never allowed: "true" is
// already its value, so --enable could only override production's own "off".
const killSwitches = ALLOWED.filter((n) => sources.some((src) => src.split("\n").some((l) => l.includes(`env.${n}`) && /!\/\^\(false\|0\|no\|off\)\$\/i/.test(l))));
eq("no allowed name is a kill switch (defaults on where it is read)", killSwitches, []);

// ---- §2-§5 replica:start ---------------------------------------------------------------------
const STAND_IN_SERVER = `"use strict";
// Stand-in for the app: logs the _ENABLED names it was given, answers replica:start's readiness check once, then exits.
const http = require("http");
const flags = Object.keys(process.env).filter((k) => /_ENABLED$/.test(k)).sort().map((k) => k + "=" + process.env[k]);
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
	]) {
		const task = `refused-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "").slice(0, 30)}`;
		const r = await start(fx, task, extra);
		eq(`${label}: replica:start exits 1`, r.status, 1);
		ok("...naming the reason", why.test(r.out), tail(r.out));
		ok("...with no working copy made and no server recorded", !r.workExists && r.record === null);
		ok("...and never prints a value typed after \"=\"", !r.out.includes("typedvalue7"), tail(r.out));
	}
	eq("the settings file is still byte-for-byte unchanged", fs.readFileSync(settingsFile, "utf8"), SETTINGS);

	console.log("§5 --help");
	{
		const r = spawnSync(process.execPath, [path.join(fx.repo, "scripts", "replica", "start.js"), "--help"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: fx.home } });
		eq("--help exits 0", r.status, 0);
		ok("...and lists --enable <NAME>", /--enable <NAME>/.test(r.stdout), tail(r.stdout));
		ok("...and stops at the end of the usage comment (no code)", !/use strict/.test(r.stdout) && !/require\(/.test(r.stdout), tail(r.stdout));
	}

	console.log(failures ? `\n${failures} FAILED` : "\nall passed");
	process.exit(failures ? 1 : 0);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
