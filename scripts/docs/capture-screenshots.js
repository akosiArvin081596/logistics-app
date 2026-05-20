#!/usr/bin/env node
// Capture every screenshot listed in screenshot-manifest.js by driving a
// headless browser against a locally-running LogisX dev server.
//
// Prerequisites:
//   1. npm run build:client     (so Express can serve client/dist/)
//   2. node scripts/truncate-and-seed.js   (super_admin + clean state)
//   3. node scripts/seed-staging.js        (multi-role test users + trucks)
//   4. npm start                (Express on :3000) — leave running in another shell
//
// Usage:
//   node scripts/docs/capture-screenshots.js
//   node scripts/docs/capture-screenshots.js --filter driver       (only "driver" role)
//   node scripts/docs/capture-screenshots.js --base http://localhost:3000
//
// All screenshots land in docs/manual/assets/screenshots/. Existing files
// are overwritten — re-running is safe.

const fs = require("fs");
const path = require("path");
const { getBrowser, shutdownBrowser } = require("../../lib/pdf-browser");
const manifest = require("./screenshot-manifest");

const BASE =
	(process.argv.find((a) => a.startsWith("--base="))?.split("=")[1]) ||
	"http://localhost:3000";

const FILTER =
	process.argv.find((a) => a.startsWith("--filter="))?.split("=")[1] || null;

const OUT_DIR = path.join(__dirname, "..", "..", "docs", "manual", "assets", "screenshots");

// Default credentials match scripts/seed-staging.js. For ad-hoc captures
// (e.g. against a production snapshot with reset passwords), override via
// the CAPTURE_CREDS env var: a JSON object with the same shape as below.
const DEFAULT_CREDENTIALS = {
	super_admin: { username: "super_admin", password: "Password123!" },
	dispatcher: { username: "dispatch1", password: "investor123" },
	driver: { username: "lesline", password: "investor123" },
	investor: { username: "kevin", password: "investor123" },
	public: null,
};
const CREDENTIALS = process.env.CAPTURE_CREDS
	? { ...DEFAULT_CREDENTIALS, ...JSON.parse(process.env.CAPTURE_CREDS) }
	: DEFAULT_CREDENTIALS;

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

function ensureOutDir() {
	if (!fs.existsSync(OUT_DIR)) {
		fs.mkdirSync(OUT_DIR, { recursive: true });
	}
}

// Hit /api/auth/login and pull connect.sid from Set-Cookie.
async function loginAndGetCookie(creds) {
	const res = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(creds),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Login failed for ${creds.username}: ${res.status} ${body}`);
	}
	const setCookie = res.headers.getSetCookie?.() || res.headers.raw?.()["set-cookie"] || [];
	const sid = setCookie.find((c) => /^connect\.sid=/.test(c));
	if (!sid) {
		throw new Error(`No connect.sid cookie returned for ${creds.username}`);
	}
	const [pair] = sid.split(";");
	const [, value] = pair.split("=");
	return decodeURIComponent(value);
}

async function captureOne(browser, item, sessionCookie) {
	const page = await browser.newPage();
	try {
		const viewport = item.viewport || DESKTOP_VIEWPORT;
		await page.setViewport({ ...viewport, deviceScaleFactor: 2 });

		// Make the customer tracker think this is a "modern" UA so any UA sniffing works
		await page.setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
				"(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
		);

		if (sessionCookie) {
			const url = new URL(BASE);
			await page.setCookie({
				name: "connect.sid",
				value: sessionCookie,
				domain: url.hostname,
				path: "/",
				httpOnly: true,
				secure: false,
				sameSite: "Lax",
			});
		}

		const dest = `${BASE}${item.route}`;
		await page.goto(dest, { waitUntil: "networkidle0", timeout: 30000 }).catch((err) => {
			console.warn(`  goto warning: ${err.message}`);
		});

		if (item.wait) {
			await page.waitForSelector(item.wait, { timeout: 10000 }).catch(() => {});
		}

		if (item.prep) {
			await item.prep(page);
		}

		if (item.delay) {
			await new Promise((r) => setTimeout(r, item.delay));
		}

		const outPath = path.join(OUT_DIR, item.filename);
		await page.screenshot({
			path: outPath,
			fullPage: false,
			type: "png",
		});

		const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
		console.log(`  ✓ ${item.filename}  (${kb} KB, ${viewport.width}×${viewport.height})`);
	} finally {
		await page.close().catch(() => {});
	}
}

async function checkServer() {
	try {
		const res = await fetch(`${BASE}/api/auth/setup-check`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) throw new Error(`status ${res.status}`);
		return true;
	} catch (err) {
		console.error(`\n✗ Cannot reach dev server at ${BASE}`);
		console.error(`  ${err.message}`);
		console.error("\n  Start the server first:");
		console.error("    npm run build:client && npm start");
		return false;
	}
}

async function main() {
	ensureOutDir();

	if (!(await checkServer())) {
		process.exit(2);
	}

	const items = FILTER ? manifest.filter((m) => m.role === FILTER) : manifest;
	if (items.length === 0) {
		console.log(`No screenshots match filter "${FILTER}"`);
		process.exit(0);
	}

	console.log(`Capturing ${items.length} screenshots → ${path.relative(process.cwd(), OUT_DIR)}\n`);

	const cookieCache = {};
	const browser = await getBrowser();

	let captured = 0;
	let failed = 0;
	for (const item of items) {
		console.log(`[${item.role}] ${item.route}`);
		try {
			let cookie = null;
			if (item.role !== "public") {
				if (!cookieCache[item.role]) {
					const creds = CREDENTIALS[item.role];
					cookieCache[item.role] = await loginAndGetCookie(creds);
					console.log(`  (logged in as ${creds.username})`);
				}
				cookie = cookieCache[item.role];
			}
			await captureOne(browser, item, cookie);
			captured++;
		} catch (err) {
			console.error(`  ✗ ${item.filename} — ${err.message}`);
			failed++;
		}
	}

	console.log(`\nDone. ${captured} captured, ${failed} failed.`);
	await shutdownBrowser();
	if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
	main().catch((err) => {
		console.error("Fatal:", err);
		process.exit(1);
	});
}
