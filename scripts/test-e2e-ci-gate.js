#!/usr/bin/env node
/**
 * The browser e2e harness's CI run (.github/workflows/e2e.yml, scripts/e2e/ci-run.sh)
 * fails when a section fails, and runs on made-up data with no Keychain or secret.
 *
 *   §1 ci-gate.cjs reads e2e.mjs's results table: a FAIL row (an aborted block is
 *      one), a SKIP not on the part's allow list, no PASS, a run never stamped
 *      finished, a verdict e2e.mjs never writes, a missing file or a file with no
 *      table each fail it; PASS, PASS (vacuous), INFO and allowed SKIPs pass it.
 *      Escaped pipes and backslashes stay inside their cell. The job summary gets
 *      the verdict. e2e.mjs still writes the table this parser reads (pinned).
 *   §2 ci-keychain.cjs, keychain.cjs's stand-in for macOS's `security`: a password
 *      stored through keychain.cjs reads back, the store is 0600 inside the work dir,
 *      a missing item answers like the Keychain (exit 44), any service but
 *      logisx-e2e-ci and a store outside the work dir are refused, and a damaged
 *      store is reported without its contents.
 *   §3 ci-run.sh refuses SOURCE_DB, a missing or non-empty work dir and an unknown
 *      part before it builds anything; it runs every part it lists (never names,
 *      eldlink, invoice or report), with the stand-in Keychain; paths.cjs's
 *      E2E_BROWSER takes only "playwright".
 *   §4 e2e.yml: its own workflow (ci.yml unchanged), read-only token, no
 *      pull_request_target, no secret or environment, only ci.yml's pinned actions,
 *      no artifact upload, Playwright's Chromium, ci-run.sh on a runner.temp work dir.
 *
 * Hermetic: mkdtemp folders, stub lsof/curl on PATH, no server, browser or network.
 * Run: node scripts/test-e2e-ci-gate.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const E2E = path.join(ROOT, "scripts", "e2e");
const GATE = path.join(E2E, "ci-gate.cjs");
const STANDIN = path.join(E2E, "ci-keychain.cjs");
const CI_RUN = path.join(E2E, "ci-run.sh");
const WF = path.join(ROOT, ".github", "workflows", "e2e.yml");
const CI_YML = path.join(ROOT, ".github", "workflows", "ci.yml");

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "logisx-e2e-ci-gate.")));
fs.chmodSync(SANDBOX, 0o700);
process.on("exit", () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ } });

let pass = 0, fail = 0;
function ok(cond, label, detail) {
	if (cond) { pass++; console.log(`  ok    ${label}`); }
	else { fail++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	ok(g === w, label, `got ${g}, want ${w}`);
}

// ---------------------------------------------------------------- §1 the gate
console.log("§1 ci-gate.cjs");
const gate = require(GATE);
// A results file shaped as e2e.mjs's writeResults() writes it (pinned below).
const cell = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
function resultsMd(rows, { finished = true } = {}) {
	return [
		"# LogisX E2E — trucks (steps 1-12, R1-R16) — AFTER",
		"",
		"- Base URL: `http://127.0.0.1:3181`",
		`- Started: 2026-10-23T10:00:00.000Z${finished ? " · finished 2026-10-23T10:01:30.000Z" : " · (in progress)"}`,
		"- Browser: Chrome for Testing via playwright-core, headless, slowMo 0 ms, caption pause 0 ms",
		"- Discovered ids: —",
		"- Verdicts are judged against the AFTER-the-fix expectation. Totals: PASS 2",
		"",
		"| Step | What | Expected (after the fix) | Observed | Verdict | Screenshot |",
		"|---|---|---|---|---|---|",
		...rows.map(([step, verdict, observed = "as expected", title = `made-up step ${step}`]) =>
			`| ${cell(step)} | ${cell(title)} | ${cell("expected")} | ${cell(observed)} | ${cell(verdict)} | [${step}.png](/work/shots/x/${step}.png) |`),
		"",
	].join("\n");
}
let n = 0;
function runGate(md, args = [], env = {}) {
	const file = path.join(SANDBOX, `results-${++n}.md`);
	if (md !== null) fs.writeFileSync(file, md);
	const r = spawnSync(process.execPath, [GATE, file, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const good = [["1", "PASS"], ["2", "PASS (vacuous)"], ["3", "INFO"]];
eq("a run with PASS, PASS (vacuous) and INFO rows passes", runGate(resultsMd(good)).status, 0);
{
	const r = runGate(resultsMd([...good, ["R5", "FAIL", "made-up refusal missing"]]));
	ok(r.status === 1 && /FAIL R5 /.test(r.out) && /made-up refusal missing/.test(r.out), "a FAIL row fails the part and is printed", r.out);
}
{
	const r = runGate(resultsMd([...good, ["!", "FAIL", "Error: boom at truckSteps", "Run aborted"]]));
	ok(r.status === 1 && /FAIL ! Run aborted/.test(r.out), "an aborted block (its FAIL row) fails the part", r.out);
}
{
	const r = runGate(resultsMd([...good, ["F1", "SKIP", "needs the Google API"]]));
	ok(r.status === 1 && /SKIP F1 /.test(r.out) && /not on this part's allow list/.test(r.out), "a SKIP not on the allow list fails the part", r.out);
	eq("…and passes once the step is on it (case-insensitive)", runGate(resultsMd([...good, ["F1", "SKIP"]]), ["--allow-skip", "f1,RC1"]).status, 0);
}
{
	const r = runGate(resultsMd([...good]), ["--allow-skip", "RC1"]);
	ok(r.status === 0 && /note: RC1 is on the allow list but did not SKIP/.test(r.out), "an allowed step that ran is noted, not failed", r.out);
}
eq("a run with no PASS row fails (everything skipped or informative)", runGate(resultsMd([["1", "INFO"], ["2", "SKIP"]]), ["--allow-skip", "2"]).status, 1);
eq("a run never stamped finished fails", runGate(resultsMd(good, { finished: false })).status, 1);
{
	const r = runGate(resultsMd([...good, ["4", "WARN"]]));
	ok(r.status === 1 && /verdicts e2e.mjs does not write: 4 "WARN"/.test(r.out), "a verdict e2e.mjs never writes fails the part", r.out);
}
eq("a missing results file fails (exit 2)", runGate(null).status, 2);
eq("a file with no results table fails (exit 2)", runGate("# nothing here\n").status, 2);
eq("no arguments is a usage error", spawnSync(process.execPath, [GATE], { encoding: "utf8" }).status, 2);
eq("an unknown option is a usage error", runGate(resultsMd(good), ["--bogus"]).status, 2);
{
	const parsed = gate.parseResults(resultsMd([["R14", "PASS", "unit QA|TEST\\x with a | pipe", "a title | with a pipe"]]));
	eq("escaped pipes and backslashes stay inside their cells", [parsed.rows.length, parsed.rows[0].title, parsed.rows[0].observed, parsed.rows[0].verdict],
		[1, "a title | with a pipe", "unit QA|TEST\\x with a | pipe", "PASS"]);
}
{
	const summary = path.join(SANDBOX, "summary.md");
	runGate(resultsMd([...good, ["S3", "FAIL", "made-up | observed"]]), ["--label", "signout"], { GITHUB_STEP_SUMMARY: summary });
	const md = fs.readFileSync(summary, "utf8");
	ok(/^### e2e part signout: FAILED \(PASS 2 · INFO 1 · FAIL 1\)/m.test(md) && /\| S3 \| made-up step S3 \| made-up \\\| observed \| FAIL \|/.test(md),
		"the job summary gets the part's verdict and its FAIL rows", md);
}
{
	// A backslash before a pipe must not turn the pipe's escape into a literal backslash and end the cell.
	const md = gate.report("x", { ok: false, counts: { FAIL: 1 }, fails: [{ step: "S4", title: "made-up", observed: "a\\|b", verdict: "FAIL" }], unexpectedSkips: [], problems: [], notes: [] }).md;
	ok(md.includes("| S4 | made-up | a\\\\\\|b | FAIL |"), "the job summary escapes a backslash as well as a pipe", md);
}
{
	// The table e2e.mjs writes is the one parsed here.
	const src = fs.readFileSync(path.join(E2E, "e2e.mjs"), "utf8");
	ok(src.includes("'| Step | What | Expected (after the fix) | Observed | Verdict | Screenshot |',"), "e2e.mjs: the table header the gate looks for");
	ok(src.includes("`| ${cell(r.step)} | ${cell(r.title)} | ${cell(r.expected)} | ${cell(r.observed)} | ${cell(r.verdict)} | ${r.shot ?"), "e2e.mjs: six cells per row, the verdict fifth");
	ok(src.includes(String.raw`.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')`), "e2e.mjs: cells escape a backslash and a pipe as the gate unescapes them");
	ok(src.includes("` · finished ${new Date().toISOString()}`") && src.includes("' · (in progress)'"), "e2e.mjs: the finished stamp the gate requires");
	ok(src.includes("const verdict = (ok) => (ok ? 'PASS' : 'FAIL')"), "e2e.mjs: PASS and FAIL are the scored verdicts");
}

// ---------------------------------------------------------------- §2 the Keychain stand-in
console.log("§2 ci-keychain.cjs");
ok((fs.statSync(STANDIN).mode & 0o111) === 0o111, "ci-keychain.cjs is executable (keychain.cjs runs it as `security`)");
const WORK = path.join(SANDBOX, "work");
const STORE = path.join(WORK, "ci-keychain.json");
const kcEnv = { E2E_WORK_DIR: WORK, E2E_CI_KEYCHAIN_FILE: STORE, E2E_SECURITY_BIN: STANDIN, E2E_KEYCHAIN_SERVICE: "logisx-e2e-ci" };
const saved = {};
for (const [k, v] of Object.entries(kcEnv)) { saved[k] = process.env[k]; process.env[k] = v; }
const keychain = require(path.join(E2E, "keychain.cjs"));
const standin = (args, env = {}, input) => spawnSync(STANDIN, args, { encoding: "utf8", input, env: { PATH: process.env.PATH, ...kcEnv, ...env } });
try {
	keychain.requireSecurity();
	ok(true, "keychain.cjs takes the stand-in as `security` (help)");
} catch (e) { ok(false, "keychain.cjs takes the stand-in as `security` (help)", e.message); }
const item = keychain.itemFor("driver", null);
eq("keychain.cjs addresses the CI service", item, { service: "logisx-e2e-ci", account: "driver" });
eq("a missing item reads as none", keychain.readPassword(item), null);
eq("…which the stand-in answers like the Keychain (exit 44)", standin(["find-generic-password", "-s", "logisx-e2e-ci", "-a", "driver", "-w"]).status, 44);
try {
	keychain.storePassword(item, "made-up-ci-pw-1");
	keychain.storePassword(keychain.itemFor("superAdmin", null), "made-up-ci-pw-2");
	keychain.storePassword(item, "made-up-ci-pw-3");
	ok(true, "keychain.cjs stores through the stand-in (each read back)");
} catch (e) { ok(false, "keychain.cjs stores through the stand-in (each read back)", e.message); }
eq("a replaced password reads back, the other item kept", [keychain.readPassword(item), keychain.readPassword(keychain.itemFor("superAdmin", null))], ["made-up-ci-pw-3", "made-up-ci-pw-2"]);
eq("the store is 0600 inside the 0700 work dir", [(fs.statSync(STORE).mode & 0o777).toString(8), (fs.statSync(WORK).mode & 0o777).toString(8)], ["600", "700"]);
{
	const r = standin(["find-generic-password", "-s", "logisx-e2e-local", "-a", "driver", "-w"]);
	ok(r.status === 1 && /answers logisx-e2e-ci only/.test(r.stderr) && r.stdout === "", "the local Keychain service is refused", `${r.status} ${r.stderr}`);
	const s = standin(["-i"], {}, 'add-generic-password -U -s "logisx-staging" -a "x" -w "made-up-ci-pw-4"\n');
	ok(s.status === 1 && !JSON.stringify(JSON.parse(fs.readFileSync(STORE, "utf8"))).includes("logisx-staging"), "a staging item is refused and not stored", `${s.status} ${s.stderr}`);
}
{
	const outside = path.join(SANDBOX, "outside.json");
	const r = standin(["find-generic-password", "-s", "logisx-e2e-ci", "-a", "driver", "-w"], { E2E_CI_KEYCHAIN_FILE: outside });
	ok(r.status === 1 && /not inside the work dir/.test(r.stderr), "a store outside the work dir is refused", `${r.status} ${r.stderr}`);
	const link = path.join(WORK, "linked.json");
	fs.symlinkSync(outside, link);
	const l = standin(["find-generic-password", "-s", "logisx-e2e-ci", "-a", "driver", "-w"], { E2E_CI_KEYCHAIN_FILE: link });
	ok(l.status === 1 && /symlink/.test(l.stderr), "a symlinked store is refused", `${l.status} ${l.stderr}`);
}
{
	const damaged = path.join(WORK, "damaged.json");
	fs.writeFileSync(damaged, '[{"service":"logisx-e2e-ci","account":"driver","password":"made-up-ci-pw-5"', { mode: 0o600 });
	const r = standin(["find-generic-password", "-s", "logisx-e2e-ci", "-a", "driver", "-w"], { E2E_CI_KEYCHAIN_FILE: damaged });
	ok(r.status === 1 && !/made-up-ci-pw-5/.test(r.stdout + r.stderr), "a damaged store is reported without its contents", r.stderr);
}
eq("an unsupported command is refused", standin(["delete-generic-password", "-s", "logisx-e2e-ci"]).status, 1);
for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

// ---------------------------------------------------------------- §3 ci-run.sh and paths.cjs
console.log("§3 ci-run.sh");
const STUBS = path.join(SANDBOX, "stubs");
fs.mkdirSync(STUBS);
for (const tool of ["lsof", "curl"]) fs.writeFileSync(path.join(STUBS, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
const runCi = (env) => spawnSync("bash", [CI_RUN], { encoding: "utf8", env: { PATH: `${STUBS}:${process.env.PATH}`, HOME: SANDBOX, ...env } });
const fresh = () => path.join(SANDBOX, `ci-work-${++n}`);
{
	const r = runCi({ E2E_WORK_DIR: fresh(), SOURCE_DB: path.join(SANDBOX, "real.db") });
	ok(r.status === 2 && /SOURCE_DB is set/.test(r.stderr), "SOURCE_DB is refused (made-up data only)", r.stderr);
}
{
	const r = runCi({});
	ok(r.status === 2 && /set E2E_WORK_DIR/.test(r.stderr), "a missing work dir is refused", r.stderr);
}
{
	const used = fresh();
	fs.mkdirSync(used, { mode: 0o700 });
	fs.writeFileSync(path.join(used, "ci.db"), "");
	const r = runCi({ E2E_WORK_DIR: used });
	ok(r.status === 2 && /is not empty/.test(r.stderr), "a work dir that holds files is refused", r.stderr);
}
{
	const r = runCi({ E2E_WORK_DIR: fresh(), E2E_CI_PARTS: "trucks-dispatcher,eldlink" });
	ok(r.status === 2 && /E2E_CI_PARTS names "eldlink"/.test(r.stderr), "a part the run does not have is refused", r.stderr);
}
{
	const src = fs.readFileSync(CI_RUN, "utf8");
	const all = ((/^ALL_PARTS="([^"]+)"$/m.exec(src) || [])[1] || "").split(" ");
	const called = [...src.matchAll(/^part ([a-z0-9-]+) /gm)].map((m) => m[1]);
	eq("ci-run.sh runs each part it lists, in order", called, all);
	ok(all.length >= 1 && ["names", "eldlink", "invoice", "report"].every((s) => !all.includes(s)), "names, eldlink, invoice and report are not parts (the seed cannot hold what they need)");
	ok(/^part moneypath moneypath P1,E1,N1,B1 ""$/m.test(src), "the money path runs P1, E1, N1 and B1 only (F1 and RC1 always SKIP; E2 reads a table the page no longer has)");
	ok(/^export E2E_SECURITY_BIN="\$HERE\/ci-keychain\.cjs"$/m.test(src) && /^export E2E_KEYCHAIN_SERVICE=logisx-e2e-ci$/m.test(src),
		"ci-run.sh keeps the logins' passwords in the stand-in, never the Keychain");
	ok(/"\$NODE_BIN" "\$HERE\/setup-db\.cjs" "\$DB"$/m.test(src) && !/SOURCE_DB=/.test(src), "ci-run.sh builds the made-up database and never names a SOURCE_DB");
}
(async () => {
	console.log("§3 paths.cjs chromePath()");
	const paths = require(path.join(E2E, "paths.cjs"));
	const env0 = { CHROME_PATH: process.env.CHROME_PATH, E2E_BROWSER: process.env.E2E_BROWSER };
	try {
		delete process.env.CHROME_PATH;
		process.env.E2E_BROWSER = "firefox";
		let msg = "";
		try { await paths.chromePath(); } catch (e) { msg = e.message; }
		ok(/E2E_BROWSER takes only "playwright"/.test(msg), "E2E_BROWSER refuses anything but playwright", msg);
		process.env.CHROME_PATH = process.execPath;
		eq("CHROME_PATH still wins over E2E_BROWSER", await paths.chromePath(), process.execPath);
		delete process.env.CHROME_PATH;
		process.env.E2E_BROWSER = "playwright";
		let got = "";
		try { got = await paths.chromePath(); } catch (e) { got = e.message; }
		ok(fs.existsSync(got) || /playwright-core could not be loaded|Playwright's Chromium is not installed/.test(got),
			"E2E_BROWSER=playwright gives playwright-core's Chromium, or says how to install it", got);
	} finally {
		for (const [k, v] of Object.entries(env0)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
	}

	// ---------------------------------------------------------------- §4 the workflow
	console.log("§4 .github/workflows/e2e.yml");
	const wf = fs.readFileSync(WF, "utf8");
	const code = wf.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
	const ci = fs.readFileSync(CI_YML, "utf8");
	ok(/^permissions:\n {2}contents: read\n/m.test(code) && (code.match(/permissions:/g) || []).length === 1 && !/:\s*write\b/.test(code),
		"the token reads the repo and nothing else");
	ok(!/pull_request_target/.test(code) && /^ {2}pull_request:\n {4}branches: \[main\]$/m.test(code), "it runs on pull_request, never pull_request_target");
	ok(!/secrets\./.test(code) && !/^\s+environment:/m.test(code), "no secret and no environment");
	const uses = [...code.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);
	const ciUses = new Set([...ci.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]));
	ok(uses.length >= 2 && uses.every((u) => ciUses.has(u)), "only the actions ci.yml uses, at ci.yml's pinned SHAs", uses.join(", "));
	ok(!/upload-artifact/.test(code), "no artifact upload (screenshots stay on the runner)");
	ok(/persist-credentials: false/.test(code), "the checkout keeps no token");
	ok(/node-version-file: \.nvmrc/.test(code), "Node from .nvmrc");
	ok(/playwright-core install --with-deps chromium$/m.test(code) && /^ {10}E2E_BROWSER: playwright$/m.test(code), "Playwright's Chromium is installed and driven");
	ok(/^ {10}E2E_WORK_DIR: \$\{\{ runner\.temp \}\}\/logisx-e2e$/m.test(code) && /^ {8}run: bash scripts\/e2e\/ci-run\.sh$/m.test(code), "ci-run.sh runs on a work dir under runner.temp");
	ok(!/SOURCE_DB/.test(code) && !/prep-worktree/.test(code), "no SOURCE_DB and no prep script");
	const minutes = Number((/^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(code) || [])[1]);
	ok(minutes > 0 && minutes <= 45, `the job has its own timeout (${minutes} min)`);
	ok(!/scripts\/e2e/.test(ci.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n")), "ci.yml (production's gate) does not run the browser harness");

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
