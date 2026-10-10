#!/usr/bin/env node
// npm run replica:login -- <username> [--task <name>] [--headless]
//                          [--screens <dir>] [--visit <path>]... [--dwell <seconds>]
// npm run replica:login -- --mcp-state <username> [--task <name>] [...]
//
// Signs in to a running replica (npm run replica:start) as a copied account, so
// you see the app as that person sees it.
//
// 1. Sets a LOCAL password on that account in the task's working copy only
//    (~/LogisX-replica/work/<task>/app.db), and clears its must-change-password
//    flag there so the sign-in is not stopped at the change-password page. The
//    clean snapshot, staging and production are never touched. The password is
//    the macOS Keychain item service "logisx-replica" (account "local-copy"),
//    generated once when missing; it is never printed, written to a file or
//    passed on a command line (scripts/e2e/keychain.cjs).
// 2. Opens Chrome for Testing (Playwright), headed unless --headless, and signs
//    in through the login page. The browser may reach the replica and nothing
//    else: every other request is refused and counted.
// 3. --visit <path> opens each page in turn (--dwell seconds each, default 4);
//    --screens <dir> saves a screenshot of the landing page and of each visit
//    (they show real people's data: kept outside the repo, Documents and Desktop).
//    Headless: signs out at the end. Headed: stays open until you close it.
// 4. --mcp-state <username> (headless) keeps the session instead of signing out:
//    its cookies go to ~/LogisX-replica/mcp/<username>.json (600) and
//    active.json, the file the Playwright MCP loads, points at them
//    (mcp-state.js). Signing out in that browser, saving the account again, or
//    replica:clean ends it. A save it would refuse is checked before signing in.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const C = require("./common.js");
const M = require("./mcp-state.js");
const REPO = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const keychain = require(path.join(REPO, "scripts", "e2e", "keychain.cjs"));
const KEYCHAIN_ITEM = { service: "logisx-replica", account: "local-copy" };

const argv = process.argv.slice(2);
const flags = new Set(["--headless"]);
const valued = new Set(["--task", "--screens", "--visit", "--dwell", "--mcp-state"]);
let username = null;
let mcpUser = null;
const visits = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (flags.has(a)) continue;
	if (valued.has(a)) {
		const v = argv[i + 1];
		if (a === "--visit") visits.push(v);
		if (a === "--mcp-state") {
			if (!v || v.startsWith("-")) C.fail("--mcp-state takes the username to sign in as");
			if (mcpUser) C.fail("one --mcp-state, please");
			mcpUser = v;
		}
		i++;
		continue;
	}
	if (a.startsWith("-")) C.fail(`unknown option ${a}`);
	if (username) C.fail("one username, please");
	username = a;
}
if (mcpUser && username && mcpUser.toLowerCase() !== username.toLowerCase()) C.fail(`--mcp-state ${mcpUser} and ${username} name two accounts`);
username = username || mcpUser;
if (!username) C.fail("usage: npm run replica:login -- <username> [--task <name>] [--headless] [--screens <dir>] [--visit <path>]... | --mcp-state <username>");
for (const v of visits) if (!/^\/[A-Za-z0-9/_?=&.-]*$/.test(String(v || ""))) C.fail(`--visit takes an app path such as /financials, not ${v}`);
const task = C.taskArg(argv);
const headless = argv.includes("--headless") || Boolean(mcpUser);
const screens = C.optionValue(argv, "--screens");
const dwellMs = Math.max(0, Number(C.optionValue(argv, "--dwell") || 4)) * 1000;

const server = C.runningServer(task);
if (!server) C.fail(`no replica is running for task ${task}; start one with npm run replica:start -- --task ${task}`);
const BASE = `http://127.0.0.1:${server.port}`;
const dbPath = path.join(C.paths.work(task), "app.db");
if (!fs.realpathSync(dbPath).startsWith(fs.realpathSync(path.join(C.ROOT, "work")) + path.sep)) C.fail("the working copy is not under ~/LogisX-replica/work");
if (screens) {
	const real = C.realOf(screens);
	const synced = ["Documents", "Desktop"].map((d) => C.realOf(path.join(process.env.HOME, d)));
	if ([REPO, ...synced].some((d) => real === d || real.startsWith(d + path.sep))) {
		C.fail("--screens must be outside the repo and outside Documents and Desktop (the screenshots show real people's data)");
	}
	fs.mkdirSync(real, { recursive: true, mode: 0o700 });
}

// --- 1. the local password, on the working copy only ---------------------------
keychain.requireSecurity();
let password = keychain.readPassword(KEYCHAIN_ITEM);
if (!password) {
	keychain.storePassword(KEYCHAIN_ITEM, crypto.randomBytes(24).toString("base64url"));
	password = keychain.readPassword(KEYCHAIN_ITEM);
	console.log(`replica: created the Keychain item ${KEYCHAIN_ITEM.service}/${KEYCHAIN_ITEM.account} (a generated password, never shown)`);
}
const Database = require(path.join(REPO, "node_modules", "better-sqlite3"));
const bcrypt = require(path.join(REPO, "node_modules", "bcryptjs"));
const db = new Database(dbPath, { fileMustExist: true });
const users = db.prepare("SELECT id, username, role FROM users WHERE LOWER(username) = LOWER(?)").all(username.trim());
if (users.length !== 1) { db.close(); C.fail(users.length ? `${users.length} accounts are named ${username}` : `no account named ${username} in the working copy`); }
const user = users[0];
if (mcpUser) {
	try { M.preflight({ task, user: user.username }); } catch (e) { db.close(); C.fail(e.message); }
}
db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(bcrypt.hashSync(password, 10), user.id);
db.close();
console.log(`replica: local password set on ${user.username} (${user.role}) in ${dbPath} only`);

// --- 2. sign in -------------------------------------------------------------------
const { chromium } = require(path.join(REPO, "scripts", "e2e", "node_modules", "playwright-core"));
async function chromePath() {
	if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
	const p = require(path.join(REPO, "node_modules", "puppeteer"));
	const api = typeof p.executablePath === "function" ? p : p.default;
	return await api.executablePath();
}
// The same isolation as the replica's PDF browser, with the replica itself let
// through: every request but one to 127.0.0.1 goes to a closed proxy, and no
// host name resolves. The route below refuses (and counts) them as well.
const ISOLATION = [
	"--proxy-server=http://127.0.0.1:9",
	"--proxy-bypass-list=127.0.0.1",
	"--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
];
const browser = await chromium.launch({ executablePath: await chromePath(), headless, args: [...ISOLATION, ...(headless ? [] : ["--window-size=1400,900"])] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
let blocked = 0;
const blockedHosts = new Set();
await context.route("**/*", (route) => {
	const u = new URL(route.request().url());
	if (u.protocol === "data:" || u.protocol === "blob:" || u.origin === BASE) return route.continue();
	blocked++;
	blockedHosts.add(u.host || u.protocol);
	return route.abort("blockedbyclient");
});
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
const slug = (s) => s.replace(/^\/+/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/, "") || "home";
const shot = async (name) => {
	if (!screens) return null;
	const file = path.join(path.resolve(screens), `${slug(user.username)}-${name}.png`);
	await page.screenshot({ path: file });
	fs.chmodSync(file, 0o600);
	return file;
};
const saved = [];
try {
	await page.goto(`${BASE}/login`);
	const form = page.locator("form.login-form");
	await form.waitFor({ state: "visible", timeout: 30000 });
	await form.locator('input[autocomplete="username"]').fill(user.username);
	await form.locator('input[autocomplete="current-password"]').fill(password);
	const [resp] = await Promise.all([
		page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/login" && r.request().method() === "POST", { timeout: 30000 }),
		form.locator('button[type="submit"]').click(),
	]);
	if (resp.status() !== 200) throw new Error(`the sign-in answered ${resp.status()}`);
	await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45000 });
	await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
	await page.waitForTimeout(1500);
	console.log(`replica: signed in as ${user.username} (${user.role}); landed on ${new URL(page.url()).pathname}`);
	const home = await shot("home");
	if (home) saved.push(home);
	for (const v of visits) {
		await page.goto(`${BASE}${v}`);
		await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
		await page.waitForTimeout(dwellMs);
		const f = await shot(slug(v));
		if (f) saved.push(f);
		console.log(`replica: opened ${v}`);
	}
	if (mcpUser) {
		let file;
		try {
			file = M.save({ task, user: user.username, state: await context.storageState(), base: BASE });
		} catch (e) {
			await page.evaluate(() => fetch("/api/auth/logout", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" } }));
			throw new Error(`${e.message} (signed out)`);
		}
		console.log(`replica: session kept for the Playwright MCP: ${file} (cookies only); ${M.activeOf(C.ROOT)} points at it`);
		console.log(`replica: it ends when that browser signs out, or with npm run replica:clean -- --task ${task}`);
	} else if (headless) {
		await page.evaluate(() => fetch("/api/auth/logout", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" } }));
		console.log("replica: signed out");
	}
} finally {
	for (const f of saved) console.log(`replica: screenshot ${f}`);
	console.log(`replica: browser requests to anything but the replica: ${blocked} (refused)${blocked ? `: ${[...blockedHosts].join(", ")}` : ""}`);
	console.log(`replica: browser console errors: ${consoleErrors.length}${consoleErrors.length ? ` (first: ${consoleErrors[0]})` : ""}`);
	if (headless) await browser.close();
}
if (!headless) {
	console.log("replica: the browser stays open; close it when you are done");
	await new Promise((resolve) => browser.on("disconnected", resolve));
}
