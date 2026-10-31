#!/usr/bin/env node
// Chromium's controls in lib/pdf-browser.js: three flags, each on only when
// exactly "true" (CHROMIUM_UNPRIVILEGED_ENABLED, CHROMIUM_REQUEST_ALLOWLIST_ENABLED,
// CHROMIUM_SANDBOX_ENABLED), and the first-launch-failure line and alert.
//
//   §1 flags off (or set to anything but "true"): the launch options are
//      exactly the ones before the controls, as root or not, in a replica or
//      not; no profile folder, no account check, no request handling
//   §2 the fixed environment, not root: Chromium's environment is PATH, HOME
//      (its own fresh, empty profile folder), LANG and TZ, nothing else, no
//      made-up secret from the app's environment; no wrapper; the folder is
//      removed when the browser goes
//   §3 as root: Chromium starts through lib/chromium-drop.sh with the resolved
//      binary and CHROMIUM_RUN_AS; without a plain account name, or without
//      the binary, nothing starts
//   §4 the sandbox flag: both sandbox flags are gone, and can't come back
//      through Puppeteer's defaults; a browser that started with one anyway is
//      closed
//   §5 the request allowlist: every page gets request handling before its
//      content; data: and https on the two Google Fonts hosts go through,
//      anything else is refused and counted by host name only
//   §6 the check after launch: on Linux the browser must run as the expected
//      account (a mismatch closes it and fails); off Linux it is skipped, said
//      once
//   §7 as root with the uid drop off, the sandbox flag is ignored, both flags
//      stay, and the start line says so; server.js prints that line
//   §8 the first launch failure: one log line per process, and the alert only
//      when CHROMIUM_LAUNCH_ALERT_SEND is "true": then each stubbed channel
//      gets exactly one call per process; the alert carries no setting value;
//      server.js hands it the admin alert's two channels
//   §9 real launches with stand-ins (no Chromium): a made-up secret in the
//      app's environment reaches neither the wrapper's arguments nor
//      Chromium's arguments or environment, and nothing but the fixed
//      environment reaches Chromium, as root (through a copy of the wrapper
//      with a stand-in setpriv) and not; as root the profile folder is then
//      removed through setpriv as the account
//   §10 on a local replica: the three flags may be switched on for one task;
//      CHROMIUM_RUN_AS and CHROMIUM_LAUNCH_ALERT_SEND are never taken
//   §11 the profile folder's removal: under the uid drop, at shutdown, when the
//      browser exits and when the launch fails, it is handed to the wrapper as
//      CHROMIUM_RUN_AS's account and the app never removes it itself; without
//      the drop a failed launch's folder is removed by the app
//
// Every case that can send stubs both alert channels; nothing reaches a real
// mailbox, notification or network. Temp folders only.
//
//   node scripts/test-chromium-launch.js      # exits 1 on any failure

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC_PATH = path.join(ROOT, "lib", "pdf-browser.js");
const ALERT_PATH = path.join(ROOT, "lib", "chromium-launch-alert.js");
const WRAPPER = path.join(ROOT, "lib", "chromium-drop.sh");
const SECRET = "made-up-sentinel-4f1c9e";
const ADMIN = "admin@example.test";
const FLAGS = ["CHROMIUM_UNPRIVILEGED_ENABLED", "CHROMIUM_REQUEST_ALLOWLIST_ENABLED", "CHROMIUM_SANDBOX_ENABLED", "CHROMIUM_RUN_AS", "CHROMIUM_LAUNCH_ALERT_SEND"];
const PROFILE_RE = /^puppeteer_dev_chrome_profile-[A-Za-z0-9]{6}$/;

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
	if (cond) { pass++; return; }
	failures.push(name);
	console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}
function eq(name, got, want) {
	ok(name, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-chromium-launch-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Today's launch options, written out by hand: what every flag-off launch must
// still pass.
function todaysOptions(replica, platform = process.platform) {
	return {
		headless: "new",
		pipe: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			...(platform === "darwin" ? [] : ["--disable-gpu"]),
			"--font-render-hinting=medium",
			...(replica ? require("../lib/replica-rules").CHROMIUM_OFFLINE_ARGS : []),
		],
	};
}
// A temp folder of its own for a case, so the profile folders it makes can be
// counted without anyone else's.
const privateTmp = () => fs.mkdtempSync(path.join(TMP, "tmpdir-"));
const profilesIn = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith("puppeteer_dev_chrome_profile-"));

// ---- a stand-in Puppeteer --------------------------------------------------
function fakePage(log) {
	const handlers = { request: [], close: [] };
	const page = {
		interception: [],
		setRequestInterception: async (v) => { page.interception.push(v); log.push(`interception:${v}`); },
		on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
		once: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
		setContent: async () => { log.push("setContent"); },
		evaluateHandle: async () => {},
		pdf: async () => new Uint8Array([37, 80, 68, 70]),
		close: async () => { for (const f of handlers.close.splice(0)) f(); },
		request: (url) => {
			let outcome = null;
			const req = {
				url: () => url,
				isInterceptResolutionHandled: () => outcome !== null,
				continue: async () => { outcome = "continue"; },
				abort: async (reason) => { outcome = `abort:${reason}`; },
			};
			for (const h of handlers.request) h(req);
			return outcome;
		},
	};
	return page;
}
function fakePuppeteer({ fail = null, proc = null, binary = "/made-up/chrome" } = {}) {
	const state = { calls: [], pages: [], log: [], binaryAsked: 0 };
	state.puppeteer = {
		executablePath: async () => { state.binaryAsked++; return binary; },
		launch: async (opts) => {
			state.calls.push(opts);
			if (fail) throw fail;
			return {
				connected: true,
				process: () => proc,
				on: () => {},
				close: async () => {},
				newPage: async () => { const p = fakePage(state.log); state.pages.push(p); return p; },
			};
		},
	};
	return state;
}

// ---- loading the module against the stand-ins ------------------------------
// Keeps the stand-ins in place while `fn` runs (the module reads replica mode,
// the uid and the platform at launch, not at load).
async function withModule({ fake, replica = false, uid = null, gid = null, platform = null, env = {}, childProcess = null }, fn) {
	const origRequire = Module.prototype.require;
	Module.prototype.require = function (id) {
		if (id === "puppeteer") return fake.puppeteer;
		if (id === "./replica-mode") return { active: () => replica };
		if (id === "child_process" && childProcess) return childProcess;
		return origRequire.apply(this, arguments);
	};
	const saved = { getuid: process.getuid, getgid: process.getgid, platform: Object.getOwnPropertyDescriptor(process, "platform") };
	if (uid !== null) process.getuid = () => uid;
	if (gid !== null) process.getgid = () => gid;
	if (platform !== null) Object.defineProperty(process, "platform", { value: platform, configurable: true });
	const savedEnv = {};
	for (const k of [...FLAGS, ...Object.keys(env)]) savedEnv[k] = process.env[k];
	for (const k of FLAGS) delete process.env[k];
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	const lines = [];
	const origConsole = { log: console.log, warn: console.warn, error: console.error };
	for (const k of Object.keys(origConsole)) console[k] = (...a) => lines.push(a.map(String).join(" "));
	delete require.cache[require.resolve(SRC_PATH)];
	try {
		const m = require(SRC_PATH);
		return await fn(m, lines);
	} finally {
		for (const k of Object.keys(origConsole)) console[k] = origConsole[k];
		Module.prototype.require = origRequire;
		process.getuid = saved.getuid;
		process.getgid = saved.getgid;
		Object.defineProperty(process, "platform", saved.platform);
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		delete require.cache[require.resolve(SRC_PATH)];
	}
}

// Both alert channels, stubbed; every case that can send gets them. Without
// lib/chromium-launch-alert.js (a tree from before it) the stub channels are
// still the only ones, so each case fails for its own reason, not a crash.
let alertLib = null;
try { alertLib = require(ALERT_PATH); } catch { alertLib = null; }
function stubChannels(m, { to = ADMIN } = {}) {
	const sent = { email: [], notify: [] };
	const channels = {
		sendEmail: async (...a) => { sent.email.push(a); return true; },
		to,
		emailHtml: ({ heading, bodyHtml }) => `<h2>${heading}</h2>${bodyHtml}`,
		notify: (notice) => { sent.notify.push(notice); },
		log: { error: () => {} },
	};
	const alert = alertLib ? alertLib.create(channels) : async () => ({});
	if (typeof m.setLaunchFailureAlert === "function") m.setLaunchFailureAlert(alert);
	return sent;
}

async function launchOnce(m) {
	try { await m.getBrowser(); return null; } catch (err) { return err; }
}
// A launch a case needs: a failure is reported as one, not a crash.
async function launched(m) {
	const err = await launchOnce(m);
	ok("a launch the case needs goes ahead", err === null, err && (err.code || err.message));
	return err === null;
}
const settle = () => delay(20);

(async () => {
	// ─────────────────────────────────────────────── §1 flags off
	console.log("§1 flags off");
	for (const replica of [false, true]) {
		for (const uid of [1000, 0]) {
			const fake = fakePuppeteer();
			await withModule({ fake, replica, uid, env: { CHROMIUM_RUN_AS: "made-up-account" } }, async (m) => {
				stubChannels(m);
				await launched(m);
				const page = await m.openPageWithContent("<p>x</p>");
				await page.close();
				await m.shutdownBrowser();
			});
			const label = `${replica ? "replica" : "normal"}, ${uid === 0 ? "root" : "not root"}`;
			eq(`§1 ${label}: the launch options are today's, key for key`, fake.calls, [todaysOptions(replica)]);
			eq(`§1 ${label}: Puppeteer's binary is never asked for (no wrapper)`, fake.binaryAsked, 0);
			eq(`§1 ${label}: no request handling on the page`, fake.log, ["setContent"]);
		}
	}
	for (const value of ["1", "TRUE", "yes", "on", " true"]) {
		const fake = fakePuppeteer();
		await withModule({ fake, uid: 0, env: { CHROMIUM_UNPRIVILEGED_ENABLED: value, CHROMIUM_REQUEST_ALLOWLIST_ENABLED: value, CHROMIUM_SANDBOX_ENABLED: value, CHROMIUM_RUN_AS: "made-up-account" } }, async (m) => {
			stubChannels(m);
			await launched(m);
			await m.shutdownBrowser();
		});
		eq(`§1 the flags read ${JSON.stringify(value)} as off (the shape is === "true")`, fake.calls, [todaysOptions(false)]);
	}
	{
		const fake = fakePuppeteer();
		let line = null;
		await withModule({ fake, uid: 0 }, async (m) => { line = typeof m.describeChromiumControls === "function" ? m.describeChromiumControls() : null; });
		eq("§1 with every flag off the start line is empty (nothing new is printed)", line, "");
	}

	// ─────────────────────────────────────────────── §2 the fixed environment, not root
	console.log("§2 the fixed environment, not root");
	{
		const fake = fakePuppeteer({ proc: { pid: 0 } });
		const tmpdir = privateTmp();
		const env = { CHROMIUM_UNPRIVILEGED_ENABLED: "true", LANG: "en_US.UTF-8", TZ: "America/New_York", LOGISX_MADE_UP_TOKEN: SECRET, GMAIL_APP_PASSWORD: SECRET, TMPDIR: tmpdir };
		let profileGone = null;
		await withModule({ fake, uid: 1000, platform: "darwin", env }, async (m) => {
			stubChannels(m);
			fake.puppeteer.launch = (orig => async (opts) => {
				const b = await orig(opts);
				const proc = new (require("events"))();
				proc.pid = 424242;
				proc.spawnargs = ["/made-up/chrome"];
				b.process = () => proc;
				fake.proc = proc;
				return b;
			})(fake.puppeteer.launch);
			await launched(m);
			const opts = fake.calls[0] || {};
			ok("§2 one launch", fake.calls.length === 1);
			const dir = opts.userDataDir;
			ok("§2 the profile folder is a fresh Puppeteer-shaped folder in the temp folder", typeof dir === "string" && PROFILE_RE.test(path.basename(dir)) && path.dirname(dir) === tmpdir, dir);
			ok("§2 ...that exists and is empty at launch", !!dir && fs.existsSync(dir) && fs.readdirSync(dir).length === 0);
			eq("§2 Chromium's environment is exactly PATH, HOME (the profile folder), LANG and TZ", opts.env, { PATH: process.env.PATH, HOME: dir, LANG: "en_US.UTF-8", TZ: "America/New_York" });
			ok("§2 the made-up secret is in no launch option", !JSON.stringify(opts).includes(SECRET));
			ok("§2 not root: no wrapper, Puppeteer's own binary", opts.executablePath === undefined && fake.binaryAsked === 0);
			eq("§2 the sandbox flags stay while the sandbox flag is off", (opts.args || []).slice(0, 2), ["--no-sandbox", "--disable-setuid-sandbox"]);
			fake.proc.emit("exit", 0, null);
			await delay(300);
			profileGone = !!dir && !fs.existsSync(dir);
			await m.shutdownBrowser();
		});
		ok("§2 the profile folder is removed when the browser exits", profileGone === true);
	}
	{
		const fake = fakePuppeteer({ proc: { pid: 424243, spawnargs: [] } });
		await withModule({ fake, uid: 1000, platform: "darwin", env: { CHROMIUM_UNPRIVILEGED_ENABLED: "true", LANG: undefined, TZ: undefined, TMPDIR: privateTmp() } }, async (m) => {
			stubChannels(m);
			await launched(m);
			const opts = fake.calls[0] || {};
			eq("§2 LANG and TZ are left out when the app has none", Object.keys(opts.env || {}).sort(), ["HOME", "PATH"]);
			const dir = opts.userDataDir;
			await m.shutdownBrowser();
			ok("§2 shutdown removes the profile folder too (the app exits before the browser's exit event)", !!dir && !fs.existsSync(dir));
		});
	}

	// ─────────────────────────────────────────────── §3 as root
	console.log("§3 as root: the uid drop");
	{
		const realDir = fs.mkdtempSync(path.join(TMP, "binary-"));
		const real = path.join(realDir, "chrome");
		fs.writeFileSync(real, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const link = path.join(realDir, "chrome-link");
		fs.symlinkSync(real, link);
		const fake = fakePuppeteer({ proc: { pid: 424244, spawnargs: [] }, binary: link });
		await withModule({ fake, uid: 0, platform: "darwin", env: { CHROMIUM_UNPRIVILEGED_ENABLED: "true", CHROMIUM_RUN_AS: "made-up-account", LOGISX_MADE_UP_TOKEN: SECRET } }, async (m) => {
			stubChannels(m);
			await launched(m);
			const opts = fake.calls[0] || {};
			eq("§3 the browser Puppeteer starts is the wrapper", opts.executablePath, WRAPPER);
			eq("§3 the wrapper gets the real binary, resolved through links", opts.env && opts.env.LOGISX_CHROMIUM_BINARY, fs.realpathSync(real));
			eq("§3 ...and the account", opts.env && opts.env.LOGISX_CHROMIUM_ACCOUNT, "made-up-account");
			const fixed = ["HOME", "PATH", ...["LANG", "TZ"].filter((k) => process.env[k])];
			eq("§3 ...and the fixed environment, nothing else",
				Object.keys(opts.env || {}).sort(), [...fixed, "LOGISX_CHROMIUM_ACCOUNT", "LOGISX_CHROMIUM_BINARY"].sort());
			eq("§3 HOME is the profile folder it is given", opts.env && opts.env.HOME, opts.userDataDir);
			ok("§3 the made-up secret is in no launch option", !JSON.stringify(opts).includes(SECRET));
			await m.shutdownBrowser();
		});
		for (const [label, runAs, code] of [
			["CHROMIUM_RUN_AS unset", undefined, "CHROMIUM_RUN_AS_UNSET"],
			["CHROMIUM_RUN_AS blank", "   ", "CHROMIUM_RUN_AS_UNSET"],
			["CHROMIUM_RUN_AS not a plain account name", "made up; id", "CHROMIUM_RUN_AS_INVALID"],
		]) {
			const f = fakePuppeteer({ proc: { pid: 424245, spawnargs: [] } });
			const tmpdir = privateTmp();
			let err = null;
			await withModule({ fake: f, uid: 0, platform: "darwin", env: { CHROMIUM_UNPRIVILEGED_ENABLED: "true", CHROMIUM_RUN_AS: runAs, TMPDIR: tmpdir } }, async (m) => {
				stubChannels(m);
				err = await launchOnce(m);
			});
			eq(`§3 ${label}: nothing starts`, f.calls.length, 0);
			eq(`§3 ${label}: the launch fails with ${code}`, err && err.code, code);
			eq(`§3 ${label}: no profile folder is made`, profilesIn(tmpdir), []);
		}
		{
			const f = fakePuppeteer({ proc: { pid: 424246, spawnargs: [] }, binary: path.join(realDir, "missing-chrome") });
			const tmpdir = privateTmp();
			const removals = [];
			const childProcess = { ...require("child_process"), execFile: (file, args, opts, cb) => { removals.push([file, ...args]); setImmediate(() => cb(null, "", "")); } };
			let err = null;
			await withModule({ fake: f, uid: 0, platform: "darwin", env: { CHROMIUM_UNPRIVILEGED_ENABLED: "true", CHROMIUM_RUN_AS: "made-up-account", TMPDIR: tmpdir }, childProcess }, async (m) => {
				stubChannels(m);
				err = await launchOnce(m);
			});
			eq("§3 a binary that isn't there: nothing starts", f.calls.length, 0);
			eq("§3 ...and the launch fails with CHROMIUM_BINARY_MISSING", err && err.code, "CHROMIUM_BINARY_MISSING");
			const made = profilesIn(tmpdir);
			eq("§3 ...and its profile folder's removal goes to the wrapper (the folder is the account's under the drop)",
				removals, made.length === 1 ? [[WRAPPER, "--remove-profile", path.join(tmpdir, made[0])]] : ["one folder"]);
		}
	}

	// ─────────────────────────────────────────────── §4 the sandbox flag
	console.log("§4 the sandbox flag");
	for (const [label, uid, extraEnv] of [
		["not root", 1000, {}],
		["root, with the uid drop", 0, { CHROMIUM_UNPRIVILEGED_ENABLED: "true", CHROMIUM_RUN_AS: "made-up-account" }],
	]) {
		const fake = fakePuppeteer({ proc: { pid: 424247, spawnargs: ["/made-up/chrome", "--headless=new"] } });
		await withModule({ fake, uid, platform: "darwin", env: { CHROMIUM_SANDBOX_ENABLED: "true", ...extraEnv } }, async (m) => {
			stubChannels(m);
			fake.puppeteer.executablePath = async () => process.execPath;
			await launched(m);
			await m.shutdownBrowser();
		});
		const opts = fake.calls[0] || {};
		ok(`§4 ${label}: neither sandbox flag is passed`, !(opts.args || []).some((a) => a === "--no-sandbox" || a === "--disable-setuid-sandbox"), JSON.stringify(opts.args));
		eq(`§4 ${label}: and Puppeteer's defaults can't add them back`, opts.ignoreDefaultArgs, ["--no-sandbox", "--disable-setuid-sandbox"]);
		eq(`§4 ${label}: the rest of the arguments are today's`, opts.args, todaysOptions(false, "darwin").args.slice(2));
	}
	{
		const fake = fakePuppeteer({ proc: { pid: 424248, spawnargs: ["/made-up/chrome", "--no-sandbox"] } });
		let err = null;
		const kills = [];
		const realKill = process.kill;
		await withModule({ fake, uid: 1000, platform: "darwin", env: { CHROMIUM_SANDBOX_ENABLED: "true" } }, async (m) => {
			stubChannels(m);
			process.kill = (pid, sig) => { kills.push([pid, sig]); };
			try { err = await launchOnce(m); } finally { process.kill = realKill; }
		});
		eq("§4 a browser that started with a sandbox flag anyway is refused", err && err.code, "CHROMIUM_SANDBOX_FLAGS");
		ok("§4 ...and killed, its process group included", kills.some(([p, s]) => p === -424248 && s === "SIGKILL") && kills.some(([p, s]) => p === 424248 && s === "SIGKILL"), JSON.stringify(kills));
	}

	// ─────────────────────────────────────────────── §5 the request allowlist
	console.log("§5 the request allowlist");
	{
		const fake = fakePuppeteer();
		let lines = [];
		await withModule({ fake, uid: 1000, env: { CHROMIUM_REQUEST_ALLOWLIST_ENABLED: "true" } }, async (m, captured) => {
			stubChannels(m);
			const page = await m.openPageWithContent("<p>x</p>");
			const p = fake.pages[0];
			eq("§5 request handling is turned on before the content is set", fake.log.slice(0, 2), ["interception:true", "setContent"]);
			const cases = [
				["data:image/png;base64,iVBORw0KGgo=", "continue"],
				["https://fonts.googleapis.com/css2?family=Open+Sans:wght@400&display=swap", "continue"],
				["https://fonts.gstatic.com/s/opensans/v40/made-up.woff2", "continue"],
				["http://fonts.googleapis.com/css2?family=Open+Sans", "abort:blockedbyclient"],
				["https://fonts.googleapis.com:8443/css2", "abort:blockedbyclient"],
				["https://fonts.googleapis.com.example.test/css2", "abort:blockedbyclient"],
				["https://made-up-images.example.test/logo.png?who=someone", "abort:blockedbyclient"],
				["http://127.0.0.1:9/made-up.css", "abort:blockedbyclient"],
				["ftp://example.test/made-up.txt", "abort:blockedbyclient"],
				["https://made-up-images.example.test/second.png", "abort:blockedbyclient"],
			];
			for (const [url, want] of cases) eq(`§5 ${url.slice(0, 60)}: ${want}`, p.request(url), want);
			await page.close();
			lines = captured.slice();
			await m.shutdownBrowser();
		});
		const refusedLines = lines.filter((l) => l.includes("request allowlist"));
		eq("§5 one line when the page closes", refusedLines.length, 1);
		const line = refusedLines[0] || "";
		ok("§5 ...with the count", /refused 7 request\(s\)/.test(line), line);
		ok("§5 ...and the host names", ["fonts.googleapis.com", "made-up-images.example.test", "127.0.0.1", "example.test"].every((h) => line.includes(h)), line);
		ok("§5 ...never a path, query or full address", !/logo\.png|who=|made-up\.css|css2|second\.png|https?:\/\//.test(line), line);
	}
	{
		const fake = fakePuppeteer();
		let lines = [];
		await withModule({ fake, uid: 1000, env: { CHROMIUM_REQUEST_ALLOWLIST_ENABLED: "true" } }, async (m, captured) => {
			stubChannels(m);
			const page = await m.openPageWithContent("<p>x</p>");
			fake.pages[0].request("https://fonts.gstatic.com/s/made-up.woff2");
			await page.close();
			lines = captured.slice();
			await m.shutdownBrowser();
		});
		eq("§5 nothing refused: no line", lines.filter((l) => l.includes("request allowlist")).length, 0);
	}

	// ─────────────────────────────────────────────── §6 the check after launch
	console.log("§6 the check after launch");
	{
		const fake = fakePuppeteer({ proc: { pid: 424249, spawnargs: [] } });
		let lines = [];
		await withModule({ fake, uid: 1000, platform: "darwin", env: { CHROMIUM_UNPRIVILEGED_ENABLED: "true" } }, async (m, captured) => {
			stubChannels(m);
			ok("§6 off Linux the launch goes ahead", (await launchOnce(m)) === null);
			await m.shutdownBrowser();
			ok("§6 ...and again", (await launchOnce(m)) === null);
			await m.shutdownBrowser();
			lines = captured.slice();
		});
		eq("§6 off Linux the check is skipped, said once per process", lines.filter((l) => /runs on Linux only; skipped here/.test(l)).length, 1);
	}
	if (process.platform !== "linux") {
		console.log("  skip  §6 the /proc cases need Linux; CI's unit job runs them");
	} else {
		// A real process stands in for the browser, so /proc/<pid>/status is real.
		const standIn = () => spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
		const me = os.userInfo();
		const run = async (label, env, want) => {
			const child = standIn();
			const fake = fakePuppeteer({ proc: { pid: child.pid, spawnargs: ["/made-up/chrome"] } });
			let err = null;
			const uid = env.CHROMIUM_RUN_AS ? 0 : process.getuid();
			await withModule({ fake, uid, env: { CHROMIUM_UNPRIVILEGED_ENABLED: "true", ...env } }, async (m) => {
				stubChannels(m);
				fake.puppeteer.executablePath = async () => process.execPath;
				err = await launchOnce(m);
				if (!err) await m.shutdownBrowser();
			});
			await delay(100);
			let alive = true;
			try { process.kill(child.pid, 0); } catch { alive = false; }
			if (want === null) {
				ok(`§6 ${label}: the launch goes ahead`, err === null, err && err.message);
			} else {
				eq(`§6 ${label}: the launch fails with ${want}`, err && err.code, want);
				ok(`§6 ${label}: ...and the browser is killed`, !alive);
			}
			try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
		};
		await run("not root, running as the app", {}, null);
		await run("as root, running as another account than CHROMIUM_RUN_AS", { CHROMIUM_RUN_AS: "nobody" }, "CHROMIUM_IDENTITY_MISMATCH");
		await run(`as root, the right uid but with groups and without NoNewPrivs (${me.username})`, { CHROMIUM_RUN_AS: me.username }, "CHROMIUM_IDENTITY_MISMATCH");
		await run("as root, an account this server doesn't know", { CHROMIUM_RUN_AS: "logisx-made-up-nobody-zz" }, "CHROMIUM_ACCOUNT_UNKNOWN");
	}

	// ─────────────────────────────────────────────── §7 root without the uid drop
	console.log("§7 root without the uid drop");
	{
		const fake = fakePuppeteer();
		let line = null;
		await withModule({ fake, uid: 0, env: { CHROMIUM_SANDBOX_ENABLED: "true" } }, async (m) => {
			stubChannels(m);
			await launched(m);
			line = typeof m.describeChromiumControls === "function" ? m.describeChromiumControls() : null;
			await m.shutdownBrowser();
		});
		eq("§7 the sandbox flag is ignored and the two flags stay: today's options", fake.calls, [todaysOptions(false)]);
		ok("§7 the start line says the sandbox setting is ignored, and why", typeof line === "string" && /CHROMIUM_SANDBOX_ENABLED is ignored/.test(line) && /CHROMIUM_UNPRIVILEGED_ENABLED/.test(line), line);
	}
	{
		let line = null;
		await withModule({ fake: fakePuppeteer(), uid: 1000, env: { CHROMIUM_SANDBOX_ENABLED: "true" } }, async (m) => { line = m.describeChromiumControls ? m.describeChromiumControls() : null; });
		ok("§7 not root: the sandbox setting applies, and the line doesn't say it is ignored", typeof line === "string" && /its own sandbox/.test(line) && !/ignored/.test(line), line);
		ok("§7 the start line says a launch failure is logged only while the send setting is off", typeof line === "string" && /logged only: CHROMIUM_LAUNCH_ALERT_SEND is not on/.test(line), line);
	}
	{
		let line = null;
		await withModule({ fake: fakePuppeteer(), uid: 0, env: { CHROMIUM_UNPRIVILEGED_ENABLED: "true", CHROMIUM_RUN_AS: "made-up-account", CHROMIUM_LAUNCH_ALERT_SEND: "true" } }, async (m) => { line = m.describeChromiumControls ? m.describeChromiumControls() : null; });
		ok("§7 ...and that it is alerted while it is on", typeof line === "string" && /logged and alerted/.test(line) && /made-up-account/.test(line), line);
	}
	{
		const src = require("./lib/server-source").serverSource();
		ok("§7 server.js prints the start line when it isn't empty",
			/const chromiumControlsLine = require\("\.\/lib\/pdf-browser"\)\.describeChromiumControls\(\);\nif \(chromiumControlsLine\) console\.log\(chromiumControlsLine\);/.test(src));
	}

	// ─────────────────────────────────────────────── §8 the first launch failure
	console.log("§8 the first launch failure");
	ok("§8 lib/chromium-launch-alert.js loads, and builds the alert from the channels it is handed", !!alertLib && typeof alertLib.create === "function");
	const failure = () => Object.assign(new Error("Protocol error (Target.setDiscoverTargets): Target closed"), { name: "TargetCloseError" });
	for (const send of [undefined, "false", "1", "true"]) {
		const fake = fakePuppeteer({ fail: failure() });
		let sent = null;
		let lines = [];
		const errs = [];
		await withModule({ fake, uid: 1000, env: { CHROMIUM_LAUNCH_ALERT_SEND: send } }, async (m, captured) => {
			sent = stubChannels(m);
			for (let i = 0; i < 3; i++) errs.push(await launchOnce(m));
			await settle();
			lines = captured.slice();
		});
		const label = send === undefined ? "send setting unset" : `send setting ${JSON.stringify(send)}`;
		ok(`§8 ${label}: every render's launch fails (none is retried with fewer controls)`, errs.every((e) => e && e.name === "TargetCloseError") && fake.calls.length === 3);
		eq(`§8 ${label}: one log line for the process`, lines.filter((l) => l.startsWith("[pdf-browser] Chromium failed to start")).length, 1);
		if (send === "true") {
			eq(`§8 ${label}: exactly one email, to the admin inbox`, sent.email.map((a) => a[0]), [ADMIN]);
			eq(`§8 ${label}: exactly one in-app notification`, sent.notify.map((n) => n.type), ["pdf-renderer-launch-failed"]);
		} else {
			eq(`§8 ${label}: neither channel is called`, [sent.email.length, sent.notify.length], [0, 0]);
		}
	}
	{
		// A new process sends again: one per process, not one ever.
		let total = { email: 0, notify: 0 };
		for (let i = 0; i < 2; i++) {
			const fake = fakePuppeteer({ fail: failure() });
			await withModule({ fake, uid: 1000, env: { CHROMIUM_LAUNCH_ALERT_SEND: "true" } }, async (m) => {
				const sent = stubChannels(m);
				await launchOnce(m);
				await launchOnce(m);
				await settle();
				total = { email: total.email + sent.email.length, notify: total.notify + sent.notify.length };
			});
		}
		eq("§8 two processes: one alert each", total, { email: 2, notify: 2 });
	}
	{
		const fake = fakePuppeteer({ fail: failure() });
		let sent = null;
		await withModule({ fake, uid: 1000, env: { CHROMIUM_LAUNCH_ALERT_SEND: "true" } }, async (m) => {
			sent = stubChannels(m, { to: "" });
			await launchOnce(m);
			await settle();
		});
		eq("§8 no admin inbox set: no email, the in-app notification only", [sent.email.length, sent.notify.length], [0, 1]);
	}
	{
		// The alert names settings, never their values.
		const fake = fakePuppeteer({ proc: { pid: 0 } });
		let sent = null;
		let lines = [];
		await withModule({ fake, uid: 0, platform: "darwin", env: { CHROMIUM_UNPRIVILEGED_ENABLED: "true", CHROMIUM_RUN_AS: "made-up-acct; " + SECRET, CHROMIUM_LAUNCH_ALERT_SEND: "true", LOGISX_MADE_UP_TOKEN: SECRET } }, async (m, captured) => {
			sent = stubChannels(m);
			await launchOnce(m);
			await settle();
			lines = captured.slice();
		});
		const all = JSON.stringify(sent);
		ok("§8 the alert says what failed by setting name", /CHROMIUM_RUN_AS/.test(all), all.slice(0, 300));
		ok("§8 ...never a setting's value or a secret", !all.includes(SECRET) && !all.includes("made-up-acct"), all.slice(0, 300));
		ok("§8 ...nor does the log line", !lines.join("\n").includes(SECRET), lines.join(" | "));
	}
	{
		const fake = fakePuppeteer({ fail: failure() });
		let lines = [];
		await withModule({ fake, uid: 1000, env: { CHROMIUM_SANDBOX_ENABLED: "true", CHROMIUM_LAUNCH_ALERT_SEND: "true" } }, async (m, captured) => {
			stubChannels(m);
			await launchOnce(m);
			await settle();
			lines = captured.slice();
		});
		ok("§8 with the sandbox on, the line names the sandbox as what refuses at once", lines.some((l) => /Chromium failed to start/.test(l) && /CHROMIUM_SANDBOX_ENABLED/.test(l)), lines.join(" | "));
	}
	{
		const src = require("./lib/server-source").serverSource();
		const at = src.indexOf('require("./lib/pdf-browser").setLaunchFailureAlert(');
		const block = at >= 0 ? src.slice(at, src.indexOf("\n}));", at) + 5) : "";
		ok("§8 server.js hands pdf-browser.js the alert, built by lib/chromium-launch-alert.js", at >= 0 && block.includes('require("./lib/chromium-launch-alert").create({'));
		ok("§8 ...with the app's sendEmail and the admin inbox setting (no new sendEmail() call)",
			/\n\tsendEmail,\n\tto: ADMIN_NOTIFY_EMAIL,\n/.test(block) && !/sendEmail\(/.test(block));
		ok("§8 ...and the in-app channel: a stored dispatch notification, pushed to the dispatch room",
			block.includes("insertDispatchNotification.run(notice.type, notice.title, notice.body, JSON.stringify(notice.metadata || {}));") && block.includes("emitDispatchNotice(notice);"));
		ok("§8 server.js reads no CHROMIUM_LAUNCH_ALERT_SEND itself: pdf-browser.js alone decides", !/CHROMIUM_LAUNCH_ALERT_SEND/.test(src.replace(/\/\/[^\n]*/g, "")));
	}

	// ─────────────────────────────────────────────── §9 real launches with stand-ins
	console.log("§9 real launches with stand-ins");
	{
		const dir = fs.mkdtempSync(path.join(TMP, "spawn-"));
		const recordDir = path.join(dir, "records");
		fs.mkdirSync(recordDir);
		const fakeChromium = path.join(dir, "fake-chromium");
		fs.writeFileSync(fakeChromium, `#!${process.execPath}
"use strict";
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(recordDir)} + "/chromium-" + process.pid + ".json", JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
process.exit(1);
`, { mode: 0o755 });
		// Records its arguments and replaces itself with what follows "--", as the
		// real setpriv does (bash's own PWD and OLDPWD left out, as the wrapper does).
		const fakeSetpriv = path.join(dir, "fake-setpriv");
		fs.writeFileSync(fakeSetpriv, `#!/bin/bash
printf '%s\\0' "$@" > ${JSON.stringify(recordDir)}/setpriv-$$.args
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
unset PWD OLDPWD
exec "$@"
`, { mode: 0o755 });
		// A copy of lib/ whose wrapper runs the stand-in setpriv: the drop path,
		// end to end, without root.
		const tree = path.join(dir, "tree");
		fs.cpSync(path.join(ROOT, "lib"), path.join(tree, "lib"), { recursive: true });
		fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tree, "node_modules"));
		const copyWrapper = path.join(tree, "lib", "chromium-drop.sh");
		const wrapperText = fs.existsSync(copyWrapper) ? fs.readFileSync(copyWrapper, "utf8") : "";
		if (wrapperText) {
			fs.writeFileSync(copyWrapper, wrapperText.replace("SETPRIV=/usr/bin/setpriv", `SETPRIV=${fakeSetpriv}`));
			fs.chmodSync(copyWrapper, 0o755);
		}
		const child = path.join(dir, "child.js");
		fs.writeFileSync(child, `"use strict";
const [modulePath, asRoot] = process.argv.slice(2);
if (asRoot === "root") process.getuid = () => 0;
const m = require(modulePath);
m.getBrowser().then(() => { console.log("LAUNCHED"); process.exit(3); }, (err) => { console.log("FAILED " + (err && err.name)); process.exit(0); });
`);
		const runChild = (modulePath, asRoot) => spawnSync(process.execPath, [child, modulePath, asRoot], {
			encoding: "utf8",
			timeout: 30000,
			env: {
				PATH: process.env.PATH,
				HOME: dir,
				TMPDIR: process.env.TMPDIR || os.tmpdir(),
				LANG: "en_US.UTF-8",
				PUPPETEER_EXECUTABLE_PATH: fakeChromium,
				CHROMIUM_UNPRIVILEGED_ENABLED: "true",
				CHROMIUM_RUN_AS: os.userInfo().username,
				LOGISX_MADE_UP_TOKEN: SECRET,
				SESSION_SECRET: SECRET,
			},
		});
		const records = (prefix) => fs.readdirSync(recordDir).filter((f) => f.startsWith(prefix)).map((f) => {
			const text = fs.readFileSync(path.join(recordDir, f), "latin1");
			return f.endsWith(".args") ? { argv: text.split("\0").slice(0, -1) } : JSON.parse(text);
		});
		const allowed = new Set(["PATH", "HOME", "LANG", "TZ", "SHLVL", "_", ...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [])]);

		// Not root: Puppeteer starts the stand-in Chromium itself.
		const a = runChild(SRC_PATH, "user");
		ok("§9 not root: the stand-in Chromium ran, and the launch failed as it exits", /FAILED/.test(a.stdout || ""), `${a.stdout}${a.stderr}`);
		const chA = records("chromium-");
		eq("§9 not root: one Chromium start", chA.length, 1);
		if (chA[0]) {
			ok("§9 not root: the made-up secret is in neither Chromium's arguments nor its environment", !JSON.stringify(chA[0]).includes(SECRET));
			const names = Object.keys(chA[0].env);
			ok("§9 not root: Chromium's environment is the fixed one", names.every((n) => allowed.has(n)) && names.includes("HOME") && names.includes("PATH"), names.join(" "));
			const udd = (chA[0].argv.find((x) => x.startsWith("--user-data-dir=")) || "").slice(16);
			eq("§9 not root: HOME is Chromium's profile folder", chA[0].env.HOME, udd);
		}
		for (const f of fs.readdirSync(recordDir)) fs.rmSync(path.join(recordDir, f));

		// As root (the uid stubbed): through the wrapper copy and the stand-in setpriv.
		const b = runChild(path.join(tree, "lib", "pdf-browser.js"), "root");
		ok("§9 as root: the launch went through the wrapper and failed as the stand-in exits", /FAILED/.test(b.stdout || ""), `${b.stdout}${b.stderr}`);
		const sp = records("setpriv-");
		const chB = records("chromium-");
		// setpriv runs twice: Chromium, then the profile folder's removal as the account.
		const launchRun = sp.find((r) => r.argv.some((x) => x.startsWith("--user-data-dir=")));
		const removalRun = sp.find((r) => r.argv.includes("/bin/rm"));
		eq("§9 as root: setpriv ran twice (Chromium, then the removal), and Chromium once", [sp.length, !!launchRun, !!removalRun, chB.length], [2, true, true, 1]);
		if (launchRun) {
			const wrapperArgs = launchRun.argv.slice(launchRun.argv.indexOf("--") + 2);
			ok("§9 as root: the made-up secret is not in the wrapper's arguments", !JSON.stringify(wrapperArgs).includes(SECRET));
			ok("§9 as root: setpriv's own arguments carry no secret either", !JSON.stringify(sp.map((r) => r.argv)).includes(SECRET));
			const profile = (launchRun.argv.find((x) => x.startsWith("--user-data-dir=")) || "").slice(16);
			const me = os.userInfo();
			eq("§9 as root: the profile folder is removed through setpriv as the account, recursively only there",
				removalRun && removalRun.argv, [`--reuid=${me.uid}`, `--regid=${me.gid}`, "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--", "/bin/rm", "-rf", "--", profile]);
			ok("§9 as root: ...and it is gone", !!profile && !fs.existsSync(profile), profile);
		}
		if (chB[0]) {
			ok("§9 as root: the made-up secret is in neither Chromium's arguments nor its environment", !JSON.stringify(chB[0]).includes(SECRET));
			const names = Object.keys(chB[0].env);
			ok("§9 as root: Chromium's environment is the fixed one, the hand-over variables gone", names.every((n) => allowed.has(n)) && !names.some((n) => n.startsWith("LOGISX_")), names.join(" "));
		}
	}

	// ─────────────────────────────────────────────── §11 removing the profile folder
	console.log("§11 removing the profile folder");
	{
		// Under the drop the folder is the account's: the app hands its removal to
		// the wrapper, as that account, and never walks it itself. The stand-in
		// child_process records the call and removes nothing, so a folder still
		// there afterwards shows the app's own removal never ran.
		const recordingChildProcess = (calls) => ({
			...require("child_process"),
			execFile: (file, args, opts, cb) => { calls.push({ file, args, env: opts && opts.env }); setImmediate(() => cb(null, "", "")); },
		});
		const removalAsAccount = (calls, dir) => calls.filter((c) => c.file === WRAPPER && JSON.stringify(c.args) === JSON.stringify(["--remove-profile", dir])
			&& c.env && c.env.LOGISX_CHROMIUM_ACCOUNT === "made-up-account" && Object.keys(c.env).length === 1).length;
		const dropEnv = (tmpdir) => ({ CHROMIUM_UNPRIVILEGED_ENABLED: "true", CHROMIUM_RUN_AS: "made-up-account", TMPDIR: tmpdir });
		for (const [label, run] of [
			["at shutdown", async (m) => { await launched(m); await m.shutdownBrowser(); }],
			["when the browser exits", async (m, fake) => { await launched(m); fake.proc.emit("exit", 0, null); await delay(50); }],
			["when the launch fails", async (m) => { await launchOnce(m); }],
		]) {
			const tmpdir = privateTmp();
			const calls = [];
			const failing = label === "when the launch fails";
			const fake = fakePuppeteer({ fail: failing ? new Error("made-up launch failure") : null, binary: process.execPath });
			if (!failing) {
				fake.puppeteer.launch = (orig => async (opts) => {
					const b = await orig(opts);
					const proc = new (require("events"))();
					proc.pid = 424250;
					proc.spawnargs = [WRAPPER];
					b.process = () => proc;
					fake.proc = proc;
					return b;
				})(fake.puppeteer.launch);
			}
			await withModule({ fake, uid: 0, platform: "darwin", env: dropEnv(tmpdir), childProcess: recordingChildProcess(calls) }, async (m) => {
				stubChannels(m);
				await run(m, fake);
				await settle();
			});
			const made = profilesIn(tmpdir);
			eq(`§11 under the drop, ${label}: one profile folder was made`, made.length, 1);
			const dir = path.join(tmpdir, made[0] || "");
			ok(`§11 under the drop, ${label}: its removal is handed to the wrapper, as CHROMIUM_RUN_AS's account, with nothing else in its environment`,
				removalAsAccount(calls, dir) >= 1, JSON.stringify(calls));
			ok(`§11 under the drop, ${label}: the app never removes it itself`, made.length === 1 && fs.existsSync(dir));
			fs.rmSync(tmpdir, { recursive: true, force: true });
		}
		// The wrapper can't be started (the process fails to start): on the exit
		// path nothing is left to reject unhandled, and the folder stays.
		{
			const tmpdir = privateTmp();
			const throwing = { ...require("child_process"), execFile: () => { throw Object.assign(new Error("made-up start failure"), { code: "ENOMEM" }); } };
			const fake = fakePuppeteer({ binary: process.execPath });
			fake.puppeteer.launch = (orig => async (opts) => {
				const b = await orig(opts);
				const proc = new (require("events"))();
				proc.pid = 424251;
				proc.spawnargs = [WRAPPER];
				b.process = () => proc;
				fake.proc = proc;
				return b;
			})(fake.puppeteer.launch);
			const unhandled = [];
			const onUnhandled = (reason) => unhandled.push(String((reason && reason.message) || reason));
			process.on("unhandledRejection", onUnhandled);
			try {
				await withModule({ fake, uid: 0, platform: "darwin", env: dropEnv(tmpdir), childProcess: throwing }, async (m) => {
					stubChannels(m);
					await launched(m);
					fake.proc.emit("exit", 0, null);
					await delay(50);
				});
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
			eq("§11 under the drop, the browser exits and the wrapper can't be started: no unhandled rejection", unhandled, []);
			eq("§11 ...and the folder stays (the app never removes it itself)", profilesIn(tmpdir).length, 1);
			fs.rmSync(tmpdir, { recursive: true, force: true });
		}
		// Without the drop the folder is the app's own: a failed launch removes it.
		{
			const tmpdir = privateTmp();
			const calls = [];
			const fake = fakePuppeteer({ fail: new Error("made-up launch failure") });
			await withModule({ fake, uid: 1000, platform: "darwin", env: { CHROMIUM_UNPRIVILEGED_ENABLED: "true", TMPDIR: tmpdir }, childProcess: recordingChildProcess(calls) }, async (m) => {
				stubChannels(m);
				await launchOnce(m);
				await settle();
			});
			eq("§11 not root, a launch that fails: its profile folder is removed", profilesIn(tmpdir), []);
			eq("§11 ...by the app itself, with no wrapper", calls.filter((c) => c.file === WRAPPER).length, 0);
			ok("§11 ...and the launch was tried with one", fake.calls.length === 1 && typeof (fake.calls[0] || {}).userDataDir === "string");
		}
	}

	// ─────────────────────────────────────────────── §10 on a local replica
	console.log("§10 on a local replica (lib/replica-rules.js)");
	{
		const rules = require("../lib/replica-rules");
		for (const n of ["CHROMIUM_UNPRIVILEGED_ENABLED", "CHROMIUM_REQUEST_ALLOWLIST_ENABLED", "CHROMIUM_SANDBOX_ENABLED"]) {
			eq(`§10 replica:start --enable takes ${n}: it only narrows the task's own Chromium`, rules.enableRefusal(n), null);
		}
		// replica-mode.js refuses a settings file holding any name the export skips.
		for (const [n, rule] of [["CHROMIUM_RUN_AS", "production only: names a production target"], ["CHROMIUM_LAUNCH_ALERT_SEND", "production only: switches on an alert that sends"]]) {
			const v = rules.classifySetting(n, "made-up", { readByApp: new Set([n]) });
			eq(`§10 ${n} is never copied to a replica, nor taken from its settings file`, [v.copy, v.rule], [false, rule]);
		}
	}

	// Repeated here: a case checked while the module's console was captured
	// printed its FAIL line into the capture.
	for (const f of failures) console.log(`  FAILED  ${f}`);
	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((err) => {
	console.error("test-chromium-launch: crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
