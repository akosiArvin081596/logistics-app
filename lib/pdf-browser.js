// Singleton Puppeteer browser instance for HTML → PDF rendering.
// One Chromium process is spawned on first use and reused across every sign request,
// preview render, and weekly invoice generation. If Chromium crashes or gets killed
// (OOM, SIGKILL), the next render re-launches it transparently.
//
// A mutex serializes page creation so concurrent requests don't race on the browser
// during a relaunch.

const puppeteer = require("puppeteer");

let browser = null;
let launching = null; // in-flight launch promise (acts as a mutex)

async function getBrowser() {
	if (browser && browser.isConnected()) return browser;
	if (launching) return launching;

	launching = puppeteer
		.launch({
			headless: "new",
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				"--font-render-hinting=medium",
			],
		})
		.then((b) => {
			browser = b;
			launching = null;
			// If Chromium dies, null out the reference so the next call relaunches
			b.on("disconnected", () => {
				if (browser === b) browser = null;
			});
			return b;
		})
		.catch((err) => {
			launching = null;
			throw err;
		});

	return launching;
}

async function renderHtmlToPdf(html) {
	const b = await getBrowser();
	const page = await b.newPage();
	try {
		await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
		// Wait for Google Fonts (loaded via <link>) to finish fetching before rendering.
		// Without this, the first render uses Arial fallback and the second uses Open Sans.
		await page.evaluateHandle(() => document.fonts.ready);
		const pdf = await page.pdf({
			format: "Letter",
			printBackground: true,
			// HTML templates use `@page { margin: 1in }` — set Puppeteer's margin to 0
			// so the template's own margin is the source of truth.
			margin: { top: 0, bottom: 0, left: 0, right: 0 },
			preferCSSPageSize: true,
		});
		// Puppeteer >=22 returns a Uint8Array. Express's res.send() checks Buffer.isBuffer()
		// and falls through to JSON serialization for plain Uint8Arrays — that's why
		// response bodies were coming back as {"0":37,"1":80,...} instead of raw PDF bytes.
		// Always wrap in Buffer so every call site (res.send, fs.writeFileSync) gets a Buffer.
		return Buffer.from(pdf);
	} finally {
		await page.close().catch(() => {});
	}
}

async function shutdownBrowser() {
	if (browser) {
		try {
			await browser.close();
		} catch {
			/* ignore */
		}
		browser = null;
	}
}

module.exports = { getBrowser, renderHtmlToPdf, shutdownBrowser };
