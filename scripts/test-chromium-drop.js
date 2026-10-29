#!/usr/bin/env node
// lib/chromium-drop.sh: Chromium under its own account while the app is root
// (CHROMIUM_UNPRIVILEGED_ENABLED, lib/pdf-browser.js).
//
//   §1 the file: executable, privileged-mode bash, setpriv by absolute path
//      with the account's ids, no groups, no new privileges and no inheritable
//      capabilities, in place (exec), and never sudo
//   §2 as the user running this, with a stand-in setpriv and a stand-in
//      Chromium: the arguments pass through unchanged, fds 3 and 4 (the
//      control pipe) arrive and carry data both ways, setpriv gets the
//      account's ids and the flags, the two hand-over variables are gone from
//      Chromium's environment and the rest arrive as given
//   §3 refusals: a bad profile folder, account or browser path exits 1 at
//      once, before setpriv runs and with the folder's owner unchanged
//   §4 the root case, as root on Linux only (CI runs it under sudo in its own
//      workflow; this runner never calls sudo): the stand-in runs as the
//      account with no groups, NoNewPrivs set and no capabilities, and a
//      process-group SIGKILL reaches it and a child it started
//
// §2 and §3 run a copy of the wrapper whose setpriv path points at the
// stand-in; the copy differs from lib/chromium-drop.sh in that one line only.
// Temp folders only, removed at the end. No network.
//
//   node scripts/test-chromium-drop.js                       # exits 1 on any failure
//   sudo "$(command -v node)" scripts/test-chromium-drop.js  # adds §4 (Linux; account: nobody, or --account <name>)

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const WRAPPER = path.join(ROOT, "lib", "chromium-drop.sh");
const SETPRIV_LINE = "SETPRIV=/usr/bin/setpriv";
const ROOT_CASE_WORKFLOW = ".github/workflows/chromium-sandbox.yml";

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-chromium-drop-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

const ME = os.userInfo();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let wrapperText = "";
try { wrapperText = fs.readFileSync(WRAPPER, "utf8"); } catch { /* reported in §1 */ }

// Lines that are code, not comments.
const codeLines = (text) => text.split("\n").filter((l) => l.trim() && !/^\s*#/.test(l));

// A stand-in Chromium: records what it got (into `recordDir`, or its HOME when
// that is writable), echoes one line from fd 3 to fd 4 when asked, and then
// exits, or waits to be killed.
function writeFakeChromium(dir, recordDir) {
	const file = path.join(dir, "fake-chromium");
	fs.writeFileSync(file, `#!${process.execPath}
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const out = { pid: process.pid, argv: process.argv.slice(2), env: process.env, uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), fd3: false, fd4: false, status: null };
try { fs.fstatSync(3); out.fd3 = true; } catch {}
try { fs.fstatSync(4); out.fd4 = true; } catch {}
try { out.status = fs.readFileSync("/proc/self/status", "utf8"); } catch {}
const mode = (process.argv.find((a) => a.startsWith("--fake-mode=")) || "").slice(12);
let child = null;
if (mode === "wait") {
	child = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
	out.childPid = child.pid;
}
let dir = ${JSON.stringify(recordDir || "")};
if (!dir) dir = process.env.HOME;
fs.writeFileSync(path.join(dir, "fake-chromium-record.json"), JSON.stringify(out));
if (mode === "echo") {
	let buf = "";
	fs.createReadStream(null, { fd: 3 }).on("data", (d) => {
		buf += d;
		const nl = buf.indexOf("\\n");
		if (nl >= 0) { fs.writeSync(4, "echo:" + buf.slice(0, nl) + "\\n"); process.exit(0); }
	});
} else if (mode === "wait") {
	setInterval(() => {}, 1000);
} else {
	process.exit(Number((process.argv.find((a) => a.startsWith("--fake-exit=")) || "--fake-exit=0").slice(12)));
}
`);
	fs.chmodSync(file, 0o755);
	return file;
}

// A stand-in setpriv: records its arguments and environment, then runs what
// follows "--" with the same environment and fds 0-4 (the real one replaces
// itself; for §2 and §3 only what reaches Chromium matters).
function writeFakeSetpriv(dir) {
	const file = path.join(dir, "fake-setpriv");
	fs.writeFileSync(file, `#!${process.execPath}
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const args = process.argv.slice(2);
fs.writeFileSync(path.join(${JSON.stringify(dir)}, "setpriv-record.json"), JSON.stringify({ argv: args, env: process.env }));
const at = args.indexOf("--");
const target = args.slice(at + 1);
const c = spawn(target[0], target.slice(1), { stdio: ["inherit", "inherit", "inherit", 3, 4], env: process.env });
c.on("exit", (code, signal) => process.exit(signal ? 1 : code));
`);
	fs.chmodSync(file, 0o755);
	return file;
}

// The wrapper with its setpriv path pointed at `fakeSetpriv`; nothing else
// differs.
function wrapperCopy(dir, fakeSetpriv) {
	const file = path.join(dir, "chromium-drop.sh");
	fs.writeFileSync(file, wrapperText.replace(SETPRIV_LINE, `SETPRIV=${fakeSetpriv}`));
	fs.chmodSync(file, 0o755);
	return file;
}

// A fresh profile folder of Puppeteer's shape, as lib/pdf-browser.js makes it.
const freshProfile = (parent = os.tmpdir()) => fs.mkdtempSync(path.join(parent, "puppeteer_dev_chrome_profile-"));

// Runs the wrapper the way Puppeteer does (its own process group, fds 0-4
// piped). Resolves with the exit, the output, and what the stand-ins recorded.
function runWrapper(wrapper, { args, env, echo = null, timeoutMs = 15000 }) {
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn(wrapper, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
		let out = "";
		let fd4 = "";
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", (d) => { out += d; });
		child.stdio[4].on("data", (d) => { fd4 += d; });
		child.stdio[3].on("error", () => {});
		if (echo !== null) child.stdio[3].write(`${echo}\n`);
		const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, timeoutMs);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, out, fd4, ms: Date.now() - started });
		});
	});
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

(async () => {
	console.log("§1 the file");
	ok("§1 lib/chromium-drop.sh exists", !!wrapperText);
	let mode = 0;
	try { mode = fs.statSync(WRAPPER).mode; } catch { /* reported */ }
	ok("§1 it is executable (Puppeteer runs it as the browser)", (mode & 0o111) === 0o111, (mode & 0o777).toString(8));
	ok("§1 it runs as privileged-mode bash (no BASH_ENV, no functions or shell options from the environment)", wrapperText.startsWith("#!/bin/bash -p\n"));
	ok("§1 setpriv is called by its absolute path, from one line", wrapperText.split(SETPRIV_LINE).length === 2);
	const code = codeLines(wrapperText);
	const execLines = code.filter((l) => /\bexec\b/.test(l));
	eq("§1 one exec: setpriv in place, with the account's ids, no groups, no new privileges, no inheritable capabilities",
		execLines.map((l) => l.trim()),
		['exec "$SETPRIV" --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs --inh-caps=-all -- "$binary" "$@"']);
	ok("§1 never sudo (it closes the control pipe's fds 3 and 4)", !code.some((l) => /\bsudo\b/.test(l)));
	ok("§1 the hand-over variables are removed before Chromium starts",
		code.some((l) => l.trim() === "unset LOGISX_CHROMIUM_BINARY LOGISX_CHROMIUM_ACCOUNT"));
	ok("§1 the only owner change is the profile folder's, not recursive",
		code.filter((l) => /\bchown\b/.test(l)).map((l) => l.trim()).join("|") === 'command -p chown "$uid:$gid" "$profile" || die "the profile folder\'s owner could not be set"');

	const fakeDir = fs.mkdtempSync(path.join(TMP, "fakes-"));
	const recordDir = fs.mkdtempSync(path.join(TMP, "records-"));
	const fakeChromium = writeFakeChromium(fakeDir, recordDir);
	const fakeSetpriv = writeFakeSetpriv(fakeDir);
	const copy = wrapperText ? wrapperCopy(fakeDir, fakeSetpriv) : "";
	const copyText = copy ? fs.readFileSync(copy, "utf8") : "";
	const changedLines = copyText.split("\n").filter((l, i) => l !== wrapperText.split("\n")[i]);
	eq("§2 the copy differs from the wrapper in its setpriv line only", changedLines, copy ? [`SETPRIV=${fakeSetpriv}`] : []);

	const setprivRecord = path.join(fakeDir, "setpriv-record.json");
	const chromiumRecord = path.join(recordDir, "fake-chromium-record.json");
	const clearRecords = () => { fs.rmSync(setprivRecord, { force: true }); fs.rmSync(chromiumRecord, { force: true }); };
	const baseEnv = (profile, extra = {}) => ({
		PATH: "/usr/bin:/bin",
		HOME: profile,
		LANG: "en_US.UTF-8",
		TZ: "America/New_York",
		LOGISX_CHROMIUM_BINARY: fakeChromium,
		LOGISX_CHROMIUM_ACCOUNT: ME.username,
		...extra,
	});
	const chromiumArgs = (profile, more = []) => ["--disable-dev-shm-usage", "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--font-render-hinting=medium", ...more, "about:blank"];

	console.log("§2 as this user, with stand-ins");
	if (!copy) {
		ok("§2 not run: the wrapper is missing", false);
	} else {
		clearRecords();
		const profile = freshProfile();
		const args = chromiumArgs(profile, ["--fake-mode=echo"]);
		const r = await runWrapper(copy, { args, env: baseEnv(profile), echo: "ping-made-up-0001" });
		const sp = readJson(setprivRecord);
		const ch = readJson(chromiumRecord);
		eq("§2 the run ends as the stand-in Chromium ends (exit 0)", [r.code, r.signal], [0, null]);
		ok("§2 fds 3 and 4 arrive", !!ch && ch.fd3 === true && ch.fd4 === true, JSON.stringify(ch && { fd3: ch.fd3, fd4: ch.fd4 }));
		eq("§2 ...and carry the control pipe's data: written to fd 3, answered on fd 4", r.fd4, "echo:ping-made-up-0001\n");
		eq("§2 the arguments pass through unchanged, in order", ch && ch.argv, args);
		const want = ["--reuid=" + ME.uid, "--regid=" + ME.gid, "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--", fakeChromium, ...args];
		eq("§2 setpriv gets the account's uid and gid, no groups, no new privileges, no inheritable capabilities, then the browser", sp && sp.argv, want);
		const names = ch ? Object.keys(ch.env).sort() : [];
		ok("§2 the two hand-over variables are gone from Chromium's environment",
			!!ch && !("LOGISX_CHROMIUM_BINARY" in ch.env) && !("LOGISX_CHROMIUM_ACCOUNT" in ch.env), names.join(" "));
		ok("§2 PATH, HOME, LANG and TZ arrive as given",
			!!ch && ch.env.PATH === "/usr/bin:/bin" && ch.env.HOME === profile && ch.env.LANG === "en_US.UTF-8" && ch.env.TZ === "America/New_York");
		// macOS adds __CF_USER_TEXT_ENCODING to every process it starts.
		const ownNames = ["SHLVL", "_", ...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [])];
		const extra = names.filter((n) => !["PATH", "HOME", "LANG", "TZ"].includes(n));
		ok("§2 nothing else arrives but bash's own SHLVL and _ (no PWD)", extra.every((n) => ownNames.includes(n)), extra.join(" "));
		fs.rmSync(profile, { recursive: true, force: true });
	}

	console.log("§3 refusals");
	if (!copy) {
		ok("§3 not run: the wrapper is missing", false);
	} else {
		// Each case names the check that must stop it, so every check is shown to
		// be reached, not just some earlier one.
		const refusal = async (label, why, setup) => {
			clearRecords();
			const profile = freshProfile();
			const s = setup(profile) || {};
			const profileArg = s.profile === undefined ? profile : s.profile;
			const before = fs.existsSync(profile) ? fs.statSync(profile).uid : null;
			const args = s.args || chromiumArgs(profileArg);
			const r = await runWrapper(copy, { args, env: s.env || baseEnv(profileArg) });
			ok(`§3 ${label}: exits 1`, r.code === 1, `exit ${r.code}${r.signal ? ` ${r.signal}` : ""}: ${r.out.trim()}`);
			ok(`§3 ${label}: at once (${r.ms} ms)`, r.ms < 5000);
			ok(`§3 ${label}: says why, on stderr (${why})`, r.out.trim() === `chromium-drop: ${why}`, r.out.trim());
			ok(`§3 ${label}: setpriv never ran`, !fs.existsSync(setprivRecord) && !fs.existsSync(chromiumRecord));
			if (before !== null && fs.existsSync(profile)) eq(`§3 ${label}: the folder's owner is unchanged`, fs.statSync(profile).uid, before);
			if (s.cleanup) s.cleanup();
			fs.rmSync(profile, { recursive: true, force: true });
		};
		const noUserDataDir = (p) => chromiumArgs(p).filter((a) => !a.startsWith("--user-data-dir="));
		await refusal("no --user-data-dir", "expected exactly one --user-data-dir", (p) => ({ args: noUserDataDir(p) }));
		await refusal("two --user-data-dir", "expected exactly one --user-data-dir", (p) => ({ args: [...chromiumArgs(p), `--user-data-dir=${p}`] }));
		await refusal("a relative profile folder", "the profile folder is not an absolute path", (p) => ({ profile: path.relative(process.cwd(), p) }));
		await refusal("a profile path with ..", "the profile folder is not a plain path", (p) => ({ profile: `${path.dirname(p)}/../${path.basename(path.dirname(p))}/${path.basename(p)}` }));
		await refusal("HOME is not the profile folder", "HOME is not the profile folder", (p) => ({ env: baseEnv(p, { HOME: os.tmpdir() }) }));
		await refusal("a folder not named like Puppeteer's profile", "the profile folder is not a Puppeteer profile folder", () => {
			const other = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-not-a-profile-"));
			return { profile: other, cleanup: () => fs.rmSync(other, { recursive: true, force: true }) };
		});
		await refusal("a link to a profile folder", "the profile folder is not a real folder", (p) => {
			const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-link-"));
			const link = path.join(linkParent, "puppeteer_dev_chrome_profile-AbC123");
			fs.symlinkSync(p, link);
			return { profile: link, cleanup: () => fs.rmSync(linkParent, { recursive: true, force: true }) };
		});
		await refusal("a profile folder whose parent is a link", "the profile folder is not a real folder", (p) => {
			const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-link-"));
			const link = path.join(linkParent, "parent");
			fs.symlinkSync(path.dirname(p), link);
			return { profile: path.join(link, path.basename(p)), cleanup: () => fs.rmSync(linkParent, { recursive: true, force: true }) };
		});
		await refusal("a profile folder that is not empty", "the profile folder is not empty", (p) => { fs.writeFileSync(path.join(p, ".made-up"), "x"); });
		await refusal("a profile folder that does not exist", "the profile folder is not a real folder", (p) => ({ profile: path.join(path.dirname(p), "puppeteer_dev_chrome_profile-Zz9Zz9") }));
		await refusal("no account", "the account is missing or is not a plain account name", (p) => ({ env: baseEnv(p, { LOGISX_CHROMIUM_ACCOUNT: "" }) }));
		await refusal("an account that is not a plain name", "the account is missing or is not a plain account name", (p) => ({ env: baseEnv(p, { LOGISX_CHROMIUM_ACCOUNT: "-made-up" }) }));
		await refusal("an account that does not exist", "the account does not exist", (p) => ({ env: baseEnv(p, { LOGISX_CHROMIUM_ACCOUNT: "logisx-made-up-nobody-zz" }) }));
		await refusal("root as the account", "the account is root", (p) => ({ env: baseEnv(p, { LOGISX_CHROMIUM_ACCOUNT: "root" }) }));
		await refusal("no browser path", "the browser path is missing or not absolute", (p) => ({ env: baseEnv(p, { LOGISX_CHROMIUM_BINARY: "" }) }));
		await refusal("a relative browser path", "the browser path is missing or not absolute", (p) => ({ env: baseEnv(p, { LOGISX_CHROMIUM_BINARY: path.relative(process.cwd(), fakeChromium) }) }));
		await refusal("a browser path that is a link", "the browser path is not an executable file", (p) => {
			const link = path.join(fakeDir, `link-${path.basename(p)}`);
			fs.symlinkSync(fakeChromium, link);
			return { env: baseEnv(p, { LOGISX_CHROMIUM_BINARY: link }), cleanup: () => fs.rmSync(link, { force: true }) };
		});
		await refusal("a browser path that is not executable", "the browser path is not an executable file", (p) => {
			const plain = path.join(fakeDir, `plain-${path.basename(p)}`);
			fs.writeFileSync(plain, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
			return { env: baseEnv(p, { LOGISX_CHROMIUM_BINARY: plain }), cleanup: () => fs.rmSync(plain, { force: true }) };
		});
	}

	console.log("§4 the root case");
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
	if (!isRoot || process.platform !== "linux") {
		console.log(`  skip  §4 needs root on Linux: CI runs it under sudo in ${ROOT_CASE_WORKFLOW}; this runner never calls sudo itself`);
	} else {
		const at = process.argv.indexOf("--account");
		const account = at > 0 ? process.argv[at + 1] : "nobody";
		const id = (flag) => Number(spawnSync("/usr/bin/id", [flag, account], { encoding: "utf8" }).stdout.trim());
		const uid = id("-u");
		const gid = id("-g");
		ok(`§4 the account (${account}) exists and is not root`, uid > 0 && gid > 0, `${uid}:${gid}`);
		// The stand-in must be reachable by the account: a 0755 folder outside
		// this runner's 0700 temp folder.
		const shared = fs.mkdtempSync(path.join("/tmp", "logisx-chromium-drop-root-"));
		fs.chmodSync(shared, 0o755);
		const rootFake = writeFakeChromium(shared, "");
		const profile = freshProfile("/tmp");
		const args = chromiumArgs(profile, ["--fake-mode=wait"]);
		const env = { PATH: "/usr/bin:/bin", HOME: profile, LOGISX_CHROMIUM_BINARY: rootFake, LOGISX_CHROMIUM_ACCOUNT: account };
		const child = spawn(WRAPPER, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", (d) => { out += d; });
		const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
		const recordFile = path.join(profile, "fake-chromium-record.json");
		const deadline = Date.now() + 15000;
		while (!fs.existsSync(recordFile) && child.exitCode === null && Date.now() < deadline) await delay(50);
		await delay(100);
		const rec = readJson(recordFile);
		ok("§4 the stand-in Chromium started", !!rec, out.trim());
		if (rec) {
			const field = (label) => ((rec.status || "").match(new RegExp(`^${label}:[ \\t]*(.*)$`, "m")) || [])[1];
			eq("§4 it runs as the account (uid)", rec.uid, uid);
			eq("§4 ...with the account's group (gid)", rec.gid, gid);
			eq("§4 ...and no supplementary groups", rec.groups, []);
			eq("§4 ...with NoNewPrivs set", String(field("NoNewPrivs")).trim(), "1");
			eq("§4 ...and no effective, permitted or inheritable capabilities",
				["CapEff", "CapPrm", "CapInh"].map((c) => String(field(c)).trim()), ["0000000000000000", "0000000000000000", "0000000000000000"]);
			eq("§4 the profile folder now belongs to the account", fs.statSync(profile).uid, uid);
			eq("§4 it kept the wrapper's pid (setpriv replaced it in place)", rec.pid, child.pid);
		}
		try { process.kill(-child.pid, "SIGKILL"); } catch (e) { ok("§4 the process group could be signalled", false, e.message); }
		const end = await Promise.race([exited, delay(5000).then(() => null)]);
		eq("§4 a process-group SIGKILL reaches it", end && end.signal, "SIGKILL");
		if (rec && rec.childPid) {
			let gone = false;
			for (let i = 0; i < 40 && !gone; i++) {
				try { process.kill(rec.childPid, 0); await delay(50); } catch { gone = true; }
			}
			ok("§4 ...and the child it started", gone);
		}
		fs.rmSync(profile, { recursive: true, force: true });
		fs.rmSync(shared, { recursive: true, force: true });
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((err) => {
	console.error("test-chromium-drop: crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
