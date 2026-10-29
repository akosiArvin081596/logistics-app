#!/usr/bin/env node
/**
 * The AppArmor profile that lets the PDF renderer's Chrome start its own sandbox
 * where unprivileged user namespaces are restricted
 * (scripts/deploy/apparmor/logisx-chromium), and the workflow that proves it
 * (.github/workflows/chromium-sandbox.yml).
 *
 *   §1 the profile: AppArmor 4's abi and the global tunables, then one profile,
 *      logisx-chromium, in unconfined mode, whose only rules are userns and the
 *      site-local include. It attaches to exactly the Chrome that Puppeteer
 *      computes in each folder the renderer runs it from (the shared cache, and
 *      each app account's own cache), for any build id, and to nothing else: not
 *      the headless shell, Chrome's helpers, root's own cache, another home, a
 *      look-alike folder, a deeper path or an Arm build.
 *   §2 the workflow: its own file (ci.yml runs none of it); pull_request and
 *      push to main on the paths that can change the proof, and by hand; never
 *      pull_request_target or workflow_run; every job skips a fork's pull
 *      request (the expression evaluated) and runs on ubuntu-24.04 with its own
 *      timeout; a read-only token the checkout doesn't keep; no secret,
 *      environment or cache; no install scripts; only ci.yml's pinned actions;
 *      the restriction on, then load, the run with the profile, unload, the run
 *      without it, each profile change naming the one file.
 *   §3 --privileged refuses (exit 2, before anything else runs) anywhere but a
 *      GitHub-hosted Linux runner, as root, with its state and account named.
 *   §4 (the workflow, profile loaded) from each folder, Chrome started as the
 *      account through setpriv (no new privileges, no groups) runs under the
 *      profile with its own sandbox: every renderer in its own user namespace
 *      with seccomp on, and a page prints to PDF. lib/pdf-browser.js's own
 *      launch, unchanged, through root's cache link, runs under the profile and
 *      prints.
 *   §5 (the workflow, profile unloaded) the same start fails with Chrome's
 *      sandbox error and leaves no process; lib/pdf-browser.js's own launch runs
 *      unconfined and still prints.
 *
 * §4 and §5 need root on a runner the workflow set up, so anywhere else they
 * skip with one line. The workflow runs this file under sudo; this file never
 * calls sudo itself, and loads, unloads and installs nothing.
 *   node scripts/test-chromium-apparmor.js
 *   (workflow) node scripts/test-chromium-apparmor.js --privileged loaded|unloaded --account <name>
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PROFILE = path.join(ROOT, "scripts", "deploy", "apparmor", "logisx-chromium");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "chromium-sandbox.yml");
const CI_YML = path.join(ROOT, ".github", "workflows", "ci.yml");
const PROFILE_NAME = "logisx-chromium";
const INSTALLED = `/etc/apparmor.d/${PROFILE_NAME}`;
// Every folder the renderer runs Chrome from: the shared cache root's Puppeteer
// cache links to, and each app account's own cache once the app runs as it.
const CACHE_DIRS = ["/var/cache/logisx-puppeteer", "/home/logisx-prd/.cache/puppeteer", "/home/logisx-stg/.cache/puppeteer"];
const WORKFLOW_PATHS = [
	"lib/pdf-browser.js",
	"lib/chromium-drop.sh",
	"scripts/deploy/apparmor/**",
	"scripts/test-chromium-apparmor.js",
	"scripts/test-chromium-drop.js",
	".github/workflows/chromium-sandbox.yml",
	"package-lock.json",
];
const FORK_SKIP = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";
// Chrome's two ways of saying its sandbox can't start; which one depends on the
// helper binary beside it.
const SANDBOX_ERROR = /No usable sandbox!|The SUID sandbox helper binary was found, but is not configured correctly/;
const ACCOUNT_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><style>body{font:14px sans-serif;margin:1in}</style></head>"
	+ "<body><h1>Made-up statement</h1><p>Load 0000, a made-up carrier, one made-up line.</p></body></html>";

let pass = 0, fail = 0;
function ok(cond, label, detail) {
	if (cond) { pass++; console.log(`  ok    ${label}`); }
	else { fail++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	ok(g === w, label, `got ${g}, want ${w}`);
}
const readOr = (f, dflt = "") => { try { return fs.readFileSync(f, "utf8"); } catch { return dflt; } };
const realOr = (p) => { try { return fs.realpathSync(p); } catch (e) { return `unresolved (${e.code})`; } };

// ---------------------------------------------------------------- the profile, as apparmor_parser reads it
// Comments go, except `#include`, which apparmor_parser reads as a rule.
function profileLines(text) {
	return text.split("\n")
		.map((l) => (/^\s*#include\b/.test(l) ? l : l.replace(/(^|\s)#.*$/, "")))
		.map((l) => l.trim())
		.filter(Boolean);
}
function parseProfile(text) {
	const lines = profileLines(text);
	const at = lines.findIndex((l) => /^profile\s/.test(l));
	const m = at >= 0 ? /^profile\s+(\S+)\s+(\/\S+)\s+flags=\(([^)]*)\)\s*\{$/.exec(lines[at]) : null;
	const close = at >= 0 ? lines.indexOf("}", at + 1) : -1;
	return {
		head: at >= 0 ? lines.slice(0, at) : lines,
		// A profile, a hat or any other block opens with "{".
		blocks: lines.filter((l) => /^profile\s|\{$/.test(l)).length,
		name: m && m[1],
		attach: m && m[2],
		flags: m ? m[3].split(/[\s,]+/).filter(Boolean) : [],
		body: close > at ? lines.slice(at + 1, close) : null,
		after: close > at ? lines.slice(close + 1) : null,
	};
}

// apparmor_parser's globbing, as far as an attachment here uses it: * (within
// one folder), ** (across folders), ? and {a,b}. Anything else is refused, so
// this can't quietly read a pattern differently from the parser.
function aareToRegExp(glob) {
	let re = "";
	let depth = 0;
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; }
		else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else if (c === "{") { re += "(?:"; depth++; }
		else if (c === "}" && depth > 0) { re += ")"; depth--; }
		else if (c === "," && depth > 0) re += "|";
		else if (/[[\]\\@$]/.test(c)) throw new Error(`unsupported in an attachment here: ${c}`);
		else re += c.replace(/[.+^()|/]/g, "\\$&");
	}
	if (depth !== 0) throw new Error("unbalanced {}");
	return new RegExp(`^${re}$`);
}
// Every pattern a {a,b} alternation stands for.
function expandBraces(glob) {
	const open = glob.indexOf("{");
	if (open < 0) return [glob];
	let depth = 0, close = -1;
	const cuts = [];
	for (let i = open; i < glob.length && close < 0; i++) {
		if (glob[i] === "{") depth++;
		else if (glob[i] === "}" && --depth === 0) close = i;
		else if (glob[i] === "," && depth === 1) cuts.push(i);
	}
	if (close < 0) throw new Error("unbalanced {}");
	const parts = [];
	let from = open + 1;
	for (const c of [...cuts, close]) { parts.push(glob.slice(from, c)); from = c + 1; }
	return parts.flatMap((p) => expandBraces(glob.slice(0, open) + p + glob.slice(close + 1)));
}

// ---------------------------------------------------------------- the workflow, by indentation
const stripComments = (text) => text.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
const indentOf = (l) => l.search(/\S/);
// The lines under line i that are indented deeper than it, up to the next that isn't.
function under(lines, i) {
	const ind = indentOf(lines[i]);
	const out = [];
	for (let k = i + 1; k < lines.length; k++) {
		if (lines[k].trim() && indentOf(lines[k]) <= ind) break;
		out.push(lines[k]);
	}
	return out;
}
// The keys at the shallowest indentation of `lines`, as { key: { value, lines } }.
function keysOf(lines) {
	const filled = lines.filter((l) => l.trim());
	if (!filled.length) return {};
	const ind = Math.min(...filled.map(indentOf));
	const out = {};
	lines.forEach((l, k) => {
		const m = indentOf(l) === ind && /^\s*([\w-]+):(.*)$/.exec(l);
		if (m) out[m[1]] = { value: m[2].trim(), lines: under(lines, k) };
	});
	return out;
}
const listItems = (lines) => lines.map((l) => /^\s*-\s+(.+?)\s*$/.exec(l)).filter(Boolean).map((m) => m[1].replace(/^(['"])(.*)\1$/, "$2"));
// A job's steps, each as its keys (the leading "- " read as indentation).
function stepsOf(lines) {
	const filled = lines.filter((l) => l.trim());
	if (!filled.length) return [];
	const ind = Math.min(...filled.map(indentOf));
	const steps = [];
	for (const l of lines) {
		if (indentOf(l) === ind && /^\s*-\s/.test(l)) steps.push([l.replace(/-\s/, "  ")]);
		else if (steps.length) steps[steps.length - 1].push(l);
	}
	return steps.map(keysOf);
}
// A run: step's script, a one-liner or a | block, dedented.
function runOf(step) {
	if (!step.run) return "";
	if (!/^[|>]/.test(step.run.value)) return step.run.value;
	const filled = step.run.lines.filter((l) => l.trim());
	const ind = filled.length ? Math.min(...filled.map(indentOf)) : 0;
	return step.run.lines.map((l) => l.slice(ind)).join("\n").trim();
}

// GitHub's expression rules, as far as this workflow's if: and concurrency use
// them: context paths, 'strings', == and != (case-insensitive), && and || that
// return an operand, and ().
function evalExpr(src, ctx) {
	const toks = src.match(/'[^']*'|==|!=|&&|\|\||[()]|[A-Za-z_][A-Za-z0-9_.-]*/g) || [];
	let i = 0;
	const primary = () => {
		const t = toks[i++];
		if (t === "(") { const v = or(); i++; return v; }
		if (t[0] === "'") return t.slice(1, -1);
		if (t === "true" || t === "false") return t === "true";
		const v = t.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
		return v == null ? null : v;
	};
	const cmp = () => {
		let v = primary();
		while (toks[i] === "==" || toks[i] === "!=") {
			const op = toks[i++];
			const w = primary();
			const same = String(v ?? "").toLowerCase() === String(w ?? "").toLowerCase();
			v = op === "==" ? same : !same;
		}
		return v;
	};
	const and = () => { let v = cmp(); while (toks[i] === "&&") { i++; const w = cmp(); v = v ? w : v; } return v; };
	const or = () => { let v = and(); while (toks[i] === "||") { i++; const w = and(); v = v || w; } return v; };
	return or();
}
const evalTemplate = (s, ctx) => s.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, e) => String(evalExpr(e, ctx)));

// ---------------------------------------------------------------- --privileged's own gate
function parseArgs(argv) {
	const out = { privileged: undefined, account: undefined, unknown: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--privileged") out.privileged = argv[++i] ?? "";
		else if (argv[i] === "--account") out.account = argv[++i] ?? "";
		else out.unknown.push(argv[i]);
	}
	return out;
}
// It runs Chrome as another account and reads every process: only on a
// throwaway GitHub-hosted runner, as root, and only when told which state and
// which account.
function privilegedRefusal({ platform, uid, env, args }) {
	const why = [];
	if (args.unknown.length) why.push(`unknown argument ${args.unknown.join(" ")}`);
	if (platform !== "linux") why.push(`not Linux (${platform})`);
	if (uid !== 0) why.push(`not root (uid ${uid})`);
	if (env.RUNNER_ENVIRONMENT !== "github-hosted") why.push("not a GitHub-hosted runner (RUNNER_ENVIRONMENT)");
	if (args.privileged !== "loaded" && args.privileged !== "unloaded") why.push("--privileged takes loaded or unloaded");
	if (!ACCOUNT_RE.test(args.account || "") || args.account === "root") why.push("--account names the unprivileged account Chrome runs as");
	return why.length ? why.join("; ") : null;
}

// ---------------------------------------------------------------- /proc, for §4 and §5
function status(pid) {
	const out = {};
	for (const line of readOr(`/proc/${pid}/status`).split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
	}
	return out;
}
const uidsOf = (pid) => (status(pid).Uid || "").split(/\s+/).filter(Boolean).map(Number);
// Read as one line: a process Chrome's zygote forks rewrites its title into a
// single space-separated string.
const cmdline = (pid) => readOr(`/proc/${pid}/cmdline`).split("\0").filter(Boolean).join(" ");
const hasArg = (pid, arg) => cmdline(pid).split(/\s+/).includes(arg);
function userNs(pid) {
	try { return fs.readlinkSync(`/proc/${pid}/ns/user`); } catch (e) { return `unreadable (${e.code})`; }
}
function exeOf(pid) {
	try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch (e) { return `unreadable (${e.code})`; }
}
function label(pid) {
	for (const f of [`/proc/${pid}/attr/apparmor/current`, `/proc/${pid}/attr/current`]) {
		try { return fs.readFileSync(f, "utf8").replace(/\0/g, "").trim(); } catch { /* the older file next */ }
	}
	return null;
}
const pids = () => fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
function descendants(root) {
	const children = new Map();
	for (const pid of pids()) {
		const ppid = Number(status(pid).PPid);
		if (!children.has(ppid)) children.set(ppid, []);
		children.get(ppid).push(pid);
	}
	const out = [];
	for (const queue = [root]; queue.length;) {
		for (const c of children.get(queue.shift()) || []) { out.push(c); queue.push(c); }
	}
	return out;
}
const runningFrom = (exe) => pids().filter((pid) => exeOf(pid) === exe);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The processes started from exe that weren't running before, once they have had ms to go.
async function waitGone(exe, before, ms) {
	const fresh = () => runningFrom(exe).filter((pid) => !before.has(pid));
	const until = Date.now() + ms;
	let left = fresh();
	while (left.length && Date.now() < until) { await sleep(200); left = fresh(); }
	return left;
}
function account(name) {
	const r = spawnSync("/usr/bin/getent", ["passwd", name], { encoding: "utf8" });
	const f = r.status === 0 ? r.stdout.trim().split(":") : [];
	return f.length >= 7 ? { name, uid: Number(f[2]), gid: Number(f[3]) } : null;
}
const isPdf = (bytes) => !!bytes && Buffer.from(bytes).subarray(0, 5).toString("latin1") === "%PDF-" && bytes.length > 1000;
const tail = (file) => readOr(file).trim().split("\n").slice(-12).join(" ⏎ ") || "(Chrome wrote nothing)";

// lib/pdf-browser.js's own launch options, read through a stand-in puppeteer.
async function pdfBrowserLaunchOptions() {
	const SRC = path.join(ROOT, "lib", "pdf-browser.js");
	const calls = [];
	const stand = { launch: async (o) => { calls.push(o); return { connected: true, process: () => null, on: () => {}, close: async () => {} }; } };
	const orig = Module.prototype.require;
	Module.prototype.require = function (id) { return id === "puppeteer" ? stand : orig.apply(this, arguments); };
	delete require.cache[require.resolve(SRC)];
	try {
		const m = require(SRC);
		await m.getBrowser();
		await m.shutdownBrowser();
	} finally {
		Module.prototype.require = orig;
		delete require.cache[require.resolve(SRC)];
	}
	return calls[0];
}

// Stands in for the renderer's own wrapper with the same setpriv line, which
// execs in place: the pid and the control pipe (fds 3 and 4) stay Puppeteer's.
// Chrome's stderr goes to a file, so a refused start can be read.
const dropScript = (exe, acct, log) => [
	"#!/bin/sh",
	`exec 2>>'${log}'`,
	`exec /usr/bin/setpriv --reuid=${acct.uid} --regid=${acct.gid} --clear-groups --no-new-privs --inh-caps=-all '${exe}' "$@"`,
	"",
].join("\n");

function prepareStart(ctx, target, n) {
	const profileDir = path.join(ctx.work, `profile-${n}`);
	fs.mkdirSync(profileDir, { mode: 0o700 });
	fs.chownSync(profileDir, ctx.acct.uid, ctx.acct.gid);
	const log = path.join(ctx.work, `chrome-${n}.log`);
	fs.writeFileSync(log, "", { mode: 0o644 });
	const wrapper = path.join(ctx.work, `drop-${n}.sh`);
	fs.writeFileSync(wrapper, dropScript(target.exe, ctx.acct, log), { mode: 0o755 });
	return { profileDir, log, wrapper };
}

// The sandboxed launch: lib/pdf-browser.js's options with its two sandbox flags
// left out, run as the account with only PATH, HOME and LANG.
function startSandboxed(ctx, start) {
	return ctx.puppeteer.launch({
		headless: ctx.opts.headless,
		pipe: true,
		args: ctx.args,
		executablePath: start.wrapper,
		userDataDir: start.profileDir,
		env: { PATH: "/usr/bin:/bin", HOME: start.profileDir, LANG: "C.UTF-8" },
		timeout: 30000,
	});
}

async function sandboxStarts(ctx, target, n) {
	const where = `${ctx.tag} ${target.cacheDir}`;
	const start = prepareStart(ctx, target, n);
	let browser;
	try {
		browser = await startSandboxed(ctx, start);
	} catch (e) {
		ok(false, `${where}: Chrome starts with its own sandbox as ${ctx.acct.name}`, `${e.message} | ${tail(start.log)}`);
		return;
	}
	try {
		const pid = browser.process().pid;
		eq(`${where}: Chrome runs under the profile`, label(pid), `${PROFILE_NAME} (unconfined)`);
		eq(`${where}: as ${ctx.acct.name}, every uid`, uidsOf(pid), [ctx.acct.uid, ctx.acct.uid, ctx.acct.uid, ctx.acct.uid]);
		eq(`${where}: with no supplementary groups`, status(pid).Groups || "", "");
		eq(`${where}: with no new privileges, attached all the same`, status(pid).NoNewPrivs, "1");
		ok(cmdline(pid).length > 0 && !hasArg(pid, "--no-sandbox"), `${where}: without --no-sandbox`);
		eq(`${where}: from this folder`, exeOf(pid), target.exe);
		const page = await browser.newPage();
		await page.setContent(HTML, { waitUntil: "load" });
		const renderers = descendants(pid).filter((p) => hasArg(p, "--type=renderer"));
		ok(renderers.length > 0, `${where}: a renderer is running`, JSON.stringify(descendants(pid).map((p) => [p, cmdline(p).slice(0, 120)])));
		const own = userNs(pid);
		for (const r of renderers) {
			const ns = userNs(r);
			ok(/^user:\[\d+\]$/.test(ns) && ns !== own, `${where}: renderer ${r} runs in its own user namespace`, `${ns}, the browser's ${own}`);
			eq(`${where}: renderer ${r} has seccomp on`, status(r).Seccomp, "2");
		}
		ok(isPdf(await page.pdf({ format: "Letter", printBackground: true })), `${where}: a page prints to PDF`);
	} catch (e) {
		ok(false, `${where}: the sandboxed Chrome answered`, `${e.message} | ${tail(start.log)}`);
	} finally {
		await browser.close().catch(() => {});
	}
}

async function sandboxRefused(ctx, target, n) {
	const where = `${ctx.tag} ${target.cacheDir}`;
	const start = prepareStart(ctx, target, n);
	const already = new Set(runningFrom(target.exe));
	let browser = null, err = null;
	try { browser = await startSandboxed(ctx, start); } catch (e) { err = e; }
	if (browser) await browser.close().catch(() => {});
	ok(!browser && !!err, `${where}: without the profile, Chrome doesn't start as ${ctx.acct.name}`, browser ? "it started" : "");
	const said = (readOr(start.log).split("\n").find((l) => SANDBOX_ERROR.test(l)) || "").trim();
	ok(!!said, `${where}: …because its sandbox can't start`, tail(start.log));
	if (said) console.log(`        Chrome: ${said.slice(0, 160)}`);
	eq(`${where}: …and no process of it is left`, await waitGone(target.exe, already, 5000), []);
}

// lib/pdf-browser.js's own launch, unchanged, run by root as the workflow runs
// this file, with Chrome found through root's Puppeteer cache.
async function productionLaunch(ctx) {
	const { tag, state, puppeteer, browsers, buildId } = ctx;
	const where = `${tag} lib/pdf-browser.js's own launch`;
	const exe = await puppeteer.executablePath({ headless: "new" });
	eq(`${where}: Puppeteer finds Chrome through root's cache`, exe,
		browsers.computeExecutablePath({ cacheDir: "/root/.cache/puppeteer", browser: browsers.Browser.CHROME, buildId }));
	eq(`${where}: which links into the shared cache, where the profile attaches`, realOr(exe),
		browsers.computeExecutablePath({ cacheDir: CACHE_DIRS[0], browser: browsers.Browser.CHROME, buildId }));
	const pdfBrowser = require(path.join(ROOT, "lib", "pdf-browser.js"));
	try {
		const pdf = await pdfBrowser.renderHtmlToPdf(HTML);
		const b = await pdfBrowser.getBrowser();
		const pid = b.process().pid;
		eq(`${where}: runs ${state === "loaded" ? "under the profile" : "unconfined"}`, label(pid),
			state === "loaded" ? `${PROFILE_NAME} (unconfined)` : "unconfined");
		eq(`${where}: run by root, as the workflow runs this file`, uidsOf(pid), [0, 0, 0, 0]);
		ok(hasArg(pid, "--no-sandbox"), `${where}: with its own flags unchanged`);
		eq(`${where}: from the shared cache`, exeOf(pid), realOr(exe));
		ok(isPdf(pdf), `${where}: prints a page to PDF`);
	} catch (e) {
		ok(false, `${where}: prints a page to PDF`, e.message);
	} finally {
		await pdfBrowser.shutdownBrowser().catch(() => {});
	}
}

async function privileged(state, accountName, browsers, buildId) {
	const tag = state === "loaded" ? "§4" : "§5";
	console.log(`${tag} on this runner, profile ${state}`);
	const watchdog = setTimeout(() => { console.error(`  FAIL  ${tag} took over 6 minutes`); process.exit(1); }, 6 * 60 * 1000);
	watchdog.unref();
	const puppeteer = require("puppeteer");
	const failedBefore = fail;
	eq(`${tag} AppArmor is enabled`, readOr("/sys/module/apparmor/parameters/enabled").trim(), "Y");
	eq(`${tag} kernel.apparmor_restrict_unprivileged_userns is 1, as on the box`, readOr("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").trim(), "1");
	const listed = readOr("/sys/kernel/security/apparmor/profiles").split("\n").filter((l) => l.startsWith(`${PROFILE_NAME} `));
	eq(`${tag} the profile is ${state === "loaded" ? "loaded, in unconfined mode" : "not loaded"}`, listed,
		state === "loaded" ? [`${PROFILE_NAME} (unconfined)`] : []);
	eq(`${tag} ${state === "loaded" ? "its" : "no"} file in /etc/apparmor.d`, fs.existsSync(INSTALLED), state === "loaded");
	eq(`${tag} Puppeteer looks for Chrome as the app does (HOME /root, no PUPPETEER_CACHE_DIR)`,
		[process.env.HOME, process.env.PUPPETEER_CACHE_DIR ?? null], ["/root", null]);
	eq(`${tag} Puppeteer's platform here is linux, the build the profile names`, browsers.detectBrowserPlatform(), "linux");
	const acct = account(accountName);
	ok(!!acct && acct.uid > 0 && acct.gid > 0, `${tag} the account ${accountName} exists and isn't root`, JSON.stringify(acct));
	const targets = [];
	for (const cacheDir of CACHE_DIRS) {
		const exe = browsers.computeExecutablePath({ cacheDir, browser: browsers.Browser.CHROME, buildId });
		process.env.PUPPETEER_CACHE_DIR = cacheDir;
		let named;
		try { named = await puppeteer.executablePath({ headless: "new" }); } finally { delete process.env.PUPPETEER_CACHE_DIR; }
		eq(`${tag} ${cacheDir}: puppeteer.executablePath() names this Chrome`, named, exe);
		ok(fs.existsSync(exe), `${tag} ${cacheDir}: Chrome is installed there`, exe);
		eq(`${tag} ${cacheDir}: no link on the way, so this is the path AppArmor matches`, realOr(exe), exe);
		ok(SAFE_PATH.test(exe), `${tag} ${cacheDir}: a plain path`, exe);
		targets.push({ cacheDir, exe });
	}
	if (fail > failedBefore) {
		console.error(`  ${tag} stops here: a start on this runner would prove nothing`);
		return;
	}

	const work = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-chromium-aa-"));
	ok(SAFE_PATH.test(work), `${tag} a plain work folder`, work);
	if (!SAFE_PATH.test(work)) return;
	// The account reaches its profile folder through this one.
	fs.chmodSync(work, 0o755);
	const opts = await pdfBrowserLaunchOptions();
	const args = (opts && opts.args) || [];
	ok(args.includes("--no-sandbox") && args.includes("--disable-setuid-sandbox"),
		`${tag} lib/pdf-browser.js's options carry the two sandbox flags this start leaves out`, JSON.stringify(args));
	const ctx = {
		tag, state, puppeteer, browsers, buildId, acct, work, opts: opts || {},
		args: args.filter((a) => a !== "--no-sandbox" && a !== "--disable-setuid-sandbox"),
	};
	try {
		for (const [n, target] of targets.entries()) {
			if (state === "loaded") await sandboxStarts(ctx, target, n);
			else await sandboxRefused(ctx, target, n);
		}
		await productionLaunch(ctx);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

module.exports = { parseProfile, aareToRegExp, expandBraces, evalExpr, privilegedRefusal, pdfBrowserLaunchOptions, dropScript, descendants, label, userNs, status };

if (require.main === module) (async () => {
	const args = parseArgs(process.argv.slice(2));
	if (args.privileged !== undefined || args.account !== undefined || args.unknown.length) {
		const why = privilegedRefusal({ platform: process.platform, uid: process.getuid ? process.getuid() : -1, env: process.env, args });
		if (why) {
			console.error(`refused: ${why}`);
			process.exit(2);
		}
	}

	// ---------------------------------------------------------------- §1
	console.log("§1 the profile");
	const browsers = require("@puppeteer/browsers");
	const { PUPPETEER_REVISIONS } = require("puppeteer-core/internal/revisions.js");
	const buildId = PUPPETEER_REVISIONS.chrome;
	const text = readOr(PROFILE, null);
	ok(text !== null, "§1 scripts/deploy/apparmor/logisx-chromium exists");
	const p = parseProfile(text || "");
	eq("§1 AppArmor 4's abi, then the global tunables, before the profile", p.head, ["abi <abi/4.0>,", "include <tunables/global>"]);
	eq("§1 one profile, named logisx-chromium, and no other block", [p.blocks, p.name], [1, PROFILE_NAME]);
	eq("§1 in unconfined mode: it changes nothing about how Chrome runs", p.flags, ["unconfined"]);
	eq("§1 its only rules: user namespaces, and the site-local include", p.body, ["userns,", `include if exists <local/${PROFILE_NAME}>`]);
	eq("§1 nothing after it", p.after, []);

	const linux = (browser, cacheDir, id, platform = browsers.BrowserPlatform.LINUX) =>
		browsers.computeExecutablePath({ cacheDir, browser, buildId: id, platform });
	const chrome = (cacheDir, id) => linux(browsers.Browser.CHROME, cacheDir, id);
	let attach = null;
	try { attach = p.attach ? aareToRegExp(p.attach) : null; } catch (e) { ok(false, "§1 the attachment reads", e.message); }
	ok(aareToRegExp("/a/*/c").test("/a/b/c") && !aareToRegExp("/a/*/c").test("/a/b/x/c")
		&& aareToRegExp("/{x,y/z}/w").test("/y/z/w") && !aareToRegExp("/{x,y/z}/w").test("/q/w") && aareToRegExp("/a/**").test("/a/b/c")
		&& aareToRegExp("/a/?").test("/a/b") && !aareToRegExp("/a/?").test("/a/bc") && !aareToRegExp("/a.b").test("/axb"),
	"§1 the glob reader agrees with apparmor_parser on *, **, ?, {a,b} and a plain dot");
	let refusedOther = 0;
	for (const g of ["/a/[bc]", "/a/@{HOME}", "/a/{b"]) { try { aareToRegExp(g); } catch { refusedOther++; } }
	eq("§1 …and refuses what it doesn't model", refusedOther, 3);
	let alternatives = [];
	try { alternatives = p.attach ? expandBraces(p.attach).sort() : []; } catch (e) { ok(false, "§1 the attachment's alternatives read", e.message); }
	eq("§1 it attaches to Chrome in exactly the three folders the renderer runs it from", alternatives,
		CACHE_DIRS.map((d) => `${d}/chrome/linux-*/chrome-linux64/chrome`).sort());
	for (const cacheDir of CACHE_DIRS) {
		for (const id of [buildId, "131.0.6778.204", "160.0.8100.0"]) {
			const exe = chrome(cacheDir, id);
			ok(!!attach && attach.test(exe), `§1 it attaches to the Chrome Puppeteer computes for ${id === buildId ? "the pinned build" : id} in ${cacheDir}`, exe);
		}
	}
	const dir = path.dirname(chrome(CACHE_DIRS[0], buildId));
	for (const [what, other] of [
		["the headless shell", linux(browsers.Browser.CHROMEHEADLESSSHELL, CACHE_DIRS[0], buildId)],
		["Chrome's crash handler", path.join(dir, "chrome_crashpad_handler")],
		["the setuid helper beside it", path.join(dir, "chrome_sandbox")],
		["root's own cache, before the move", chrome("/root/.cache/puppeteer", buildId)],
		["another account's home", chrome("/home/logisx-other/.cache/puppeteer", buildId)],
		["a look-alike folder", chrome(`${CACHE_DIRS[0]}-old`, buildId)],
		["a deeper folder", path.join(CACHE_DIRS[0], "chrome", `linux-${buildId}`, "x", "chrome-linux64", "chrome")],
		["an Arm build", linux(browsers.Browser.CHROME, CACHE_DIRS[0], "160.0.8100.0", browsers.BrowserPlatform.LINUX_ARM)],
	]) {
		ok(!!attach && !attach.test(other), `§1 it doesn't attach to ${what}`, attach ? other : "no attachment to read");
	}

	// ---------------------------------------------------------------- §2
	console.log("§2 .github/workflows/chromium-sandbox.yml");
	const wfText = readOr(WORKFLOW, null);
	// Each "no …" below also needs the file: a missing workflow is never a pass.
	const has = wfText !== null;
	ok(has, "§2 the workflow exists");
	const code = stripComments(wfText || "");
	const top = keysOf(code.split("\n"));
	eq("§2 top-level keys: name, on, concurrency, permissions, jobs, nothing else", Object.keys(top).sort(), ["concurrency", "jobs", "name", "on", "permissions"]);
	const on = keysOf(top.on ? top.on.lines : []);
	eq("§2 it runs on pull_request, push and by hand, and on nothing else", Object.keys(on).sort(), ["pull_request", "push", "workflow_dispatch"]);
	for (const ev of ["pull_request", "push"]) {
		const body = keysOf(on[ev] ? on[ev].lines : []);
		eq(`§2 ${ev}: branches and paths only`, Object.keys(body).sort(), ["branches", "paths"]);
		eq(`§2 ${ev}: to main`, body.branches && body.branches.value, "[main]");
		eq(`§2 ${ev}: on the paths that can change the proof`, listItems(body.paths ? body.paths.lines : []).sort(), [...WORKFLOW_PATHS].sort());
	}
	ok(!!on.workflow_dispatch && on.workflow_dispatch.value === "" && !on.workflow_dispatch.lines.some((l) => l.trim()), "§2 workflow_dispatch takes no inputs");
	ok(has && !/pull_request_target|workflow_run/.test(code), "§2 never pull_request_target or workflow_run: a fork's code never runs with this repo's privileges");
	const perms = keysOf(top.permissions ? top.permissions.lines : []);
	eq("§2 permissions: contents: read, set once, for the whole workflow",
		[Object.keys(perms), perms.contents && perms.contents.value, (code.match(/permissions:/g) || []).length], [["contents"], "read", 1]);
	ok(has && !/secrets\./.test(code) && !/^\s*environment:/m.test(code), "§2 no secret and no environment");
	ok(has && !/github\.token|GITHUB_TOKEN/.test(code), "§2 no step is handed the token");
	ok(has && !/actions\/cache/.test(code) && !/^\s*cache:/m.test(code), "§2 no Actions cache: nothing a root step touches is restored by another workflow");

	const jobs = keysOf(top.jobs ? top.jobs.lines : []);
	ok(Object.keys(jobs).length >= 1, "§2 it has jobs", Object.keys(jobs).join(", "));
	for (const [id, job] of Object.entries(jobs)) {
		const k = keysOf(job.lines);
		eq(`§2 job '${id}' skips a fork's pull request`, k.if && k.if.value, FORK_SKIP);
		eq(`§2 job '${id}' runs on ubuntu-24.04`, k["runs-on"] && k["runs-on"].value, "ubuntu-24.04");
		const minutes = Number(k["timeout-minutes"] && k["timeout-minutes"].value);
		ok(minutes >= 1 && minutes <= 45, `§2 job '${id}' has its own timeout (1–45 min)`, String(minutes));
		ok(!k.permissions && !k.environment && !k.container && !k.services, `§2 job '${id}' adds no permission, environment, container or service`);
		for (const s of stepsOf(k.steps ? k.steps.lines : [])) {
			if (!s.uses || !/^actions\/checkout@/.test(s.uses.value)) continue;
			eq(`§2 job '${id}': the checkout keeps no token`, keysOf(s.with ? s.with.lines : [])["persist-credentials"]?.value, "false");
		}
	}
	const ctxOf = (event_name, head, ref, sha) => ({
		github: { event_name, ref, sha, repository: "owner/repo", event: event_name === "pull_request" ? { pull_request: { head: { repo: { full_name: head } } } } : {} },
	});
	const A = "a".repeat(40), B = "b".repeat(40);
	eq("§2 the fork skip, evaluated: a fork's pull request skips; this repo's pull request, a push and a manual run go",
		[ctxOf("pull_request", "someone/repo", "refs/pull/7/merge", A), ctxOf("pull_request", "owner/repo", "refs/pull/7/merge", A),
			ctxOf("push", null, "refs/heads/main", A), ctxOf("workflow_dispatch", null, "refs/heads/main", A)].map((c) => !!evalExpr(FORK_SKIP, c)),
		[false, true, true, true]);
	const conc = keysOf(top.concurrency ? top.concurrency.lines : []);
	const group = (c) => evalTemplate((conc.group && conc.group.value) || "", c);
	const cancel = (c) => evalTemplate((conc["cancel-in-progress"] && conc["cancel-in-progress"].value) || "", c);
	const pr1 = ctxOf("pull_request", "owner/repo", "refs/pull/7/merge", A), pr2 = ctxOf("pull_request", "owner/repo", "refs/pull/7/merge", B);
	const push1 = ctxOf("push", null, "refs/heads/main", A), push2 = ctxOf("push", null, "refs/heads/main", B);
	const manual = ctxOf("workflow_dispatch", null, "refs/heads/main", A);
	ok(group(pr1) === group(pr2) && cancel(pr1) === "true" && group(push1) !== group(push2) && group(manual) !== group(push1)
		&& cancel(push1) === "false" && cancel(manual) === "false" && group(pr1).startsWith("chromium-sandbox-"),
	"§2 concurrency as e2e.yml: a PR's new push cancels its last run; a push or manual run never shares a group or cancels", JSON.stringify([group(pr1), group(push1), group(manual)]));

	const ci = readOr(CI_YML);
	const ciUses = new Set([...stripComments(ci).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]));
	const uses = [...code.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);
	ok(uses.length >= 2 && uses.every((u) => ciUses.has(u)), "§2 only the actions ci.yml uses, at ci.yml's pinned SHAs", uses.join(", "));
	const allSteps = Object.values(jobs).flatMap((j) => stepsOf(keysOf(j.lines).steps ? keysOf(j.lines).steps.lines : []));
	const runs = allSteps.map(runOf);
	ok(runs.some((r) => /\bnpm ci\b/.test(r)) && runs.filter((r) => /\bnpm ci\b/.test(r)).every((r) => /--ignore-scripts/.test(r)) && !runs.some((r) => /\bnpm (install|i|rebuild)\b|\bnpx\b/.test(r)),
		"§2 dependencies install without their install scripts");
	const parserCalls = runs.flatMap((r) => r.match(/apparmor_parser[^\n]*/g) || []);
	ok(parserCalls.length >= 3 && parserCalls.every((c) => c === "apparmor_parser --version" || c === `apparmor_parser -r ${INSTALLED}` || c === `apparmor_parser -R ${INSTALLED}`)
		&& !runs.some((r) => /\bsystemctl\b|\bservice apparmor\b|\baa-(teardown|disable|enforce|complain)\b/.test(r)),
	"§2 each profile change names the one file (-r to load, -R to unload); nothing reloads every profile", parserCalls.join(" | "));
	const stepAt = (re) => runs.map((r, k) => (re.test(r) ? k : -1)).filter((k) => k >= 0);
	const order = [
		stepAt(/sysctl -w kernel\.apparmor_restrict_unprivileged_userns=1\b/),
		stepAt(new RegExp(`apparmor_parser -r ${INSTALLED}`)),
		stepAt(/scripts\/test-chromium-apparmor\.js --privileged loaded --account \S+/),
		stepAt(new RegExp(`apparmor_parser -R ${INSTALLED}`)),
		stepAt(/scripts\/test-chromium-apparmor\.js --privileged unloaded --account \S+/),
	];
	ok(order.every((o) => o.length === 1) && order.every((o, k) => k === 0 || o[0] > order[k - 1][0]),
		"§2 in order, once each: the restriction on, load, the run with the profile, unload, the run without it", JSON.stringify(order));
	const ciCode = stripComments(ci);
	ok(has && ci.length > 0 && !/apparmor|\bsudo\b|--privileged|chromium-sandbox/.test(ciCode), "§2 ci.yml (production's gate) runs none of this");

	// ---------------------------------------------------------------- §3
	console.log("§3 --privileged's own gate");
	const good = { platform: "linux", uid: 0, env: { RUNNER_ENVIRONMENT: "github-hosted" }, args: { privileged: "loaded", account: "logisx-ci-chrome", unknown: [] } };
	eq("§3 a GitHub-hosted Linux runner, as root, with its state and account: goes", privilegedRefusal(good), null);
	eq("§3 …and the unloaded state too", privilegedRefusal({ ...good, args: { ...good.args, privileged: "unloaded" } }), null);
	for (const [what, change, reason] of [
		["a Mac", { platform: "darwin" }, /not Linux/],
		["not root", { uid: 1001 }, /not root/],
		["no runner environment (a laptop, the box)", { env: {} }, /GitHub-hosted/],
		["a self-hosted runner", { env: { RUNNER_ENVIRONMENT: "self-hosted" } }, /GitHub-hosted/],
		["no state", { args: { ...good.args, privileged: "" } }, /loaded or unloaded/],
		["an unknown state", { args: { ...good.args, privileged: "both" } }, /loaded or unloaded/],
		["no account", { args: { ...good.args, account: undefined } }, /--account/],
		["root as the account", { args: { ...good.args, account: "root" } }, /--account/],
		["an account that isn't a name", { args: { ...good.args, account: "a b" } }, /--account/],
		["an unknown argument", { args: { ...good.args, unknown: ["--keep"] } }, /unknown argument/],
	]) {
		const why = privilegedRefusal({ ...good, ...change });
		ok(!!why && reason.test(why), `§3 refused: ${what}`, why);
	}
	const cli = spawnSync(process.execPath, [__filename, "--privileged", "loaded", "--account", "logisx-ci-chrome"],
		{ encoding: "utf8", env: { PATH: process.env.PATH || "/usr/bin:/bin" }, timeout: 20000 });
	ok(cli.status === 2 && /^refused: .*GitHub-hosted/.test(cli.stderr) && cli.stdout === "",
		"§3 from the command line: exit 2 with the reason, before anything else runs", `exit ${cli.status}: ${(cli.stderr || "").trim().slice(0, 200)} | ${(cli.stdout || "").slice(0, 80)}`);

	// ---------------------------------------------------------------- §4 / §5
	if (args.privileged) await privileged(args.privileged, args.account, browsers, buildId);
	else console.log("skip: §4 and §5 (Chrome under the profile, and without it) need root on a runner set up by .github/workflows/chromium-sandbox.yml, which runs this file with --privileged");

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
