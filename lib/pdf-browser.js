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
				// ⚠️ macOS ONLY: this flag makes Puppeteer's networkidle0 never settle, so
				// every render times out after 30s. Bisected 2026-08-14 on Chrome 146/arm64 —
				// base args render in ~3s, +--disable-gpu times out, and it alone is the cause.
				// It stays ON for Linux (the VPS), where it is load-bearing for headless
				// Chromium and where production has always rendered fine. Dropping it locally
				// is what makes invoice drafts, payout statements and onboarding PDFs
				// testable on a dev machine at all.
				...(process.platform === "darwin" ? [] : ["--disable-gpu"]),
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

// ===========================================================================
// THE COLD-START FAILURE, AND WHY THE ERROR MESSAGE LIES ABOUT ITS OWN CAUSE
// ===========================================================================
// Symptom, reproduced on `main` and seen in production after every deploy: the
// FIRST PDF of any kind after a process restart 500s at ~33 s with
// "Navigation timeout of 30000 ms exceeded". A retry succeeds immediately and
// every later render takes ~2-3 s. Because this module is shared, that hit
// payout statements, broker invoice drafts, weekly driver invoices AND
// onboarding documents alike — a dispatcher drafting an invoice right after a
// release got the same 500.
//
// ⚠️ IT IS NOT THE FONTS, and that was the obvious-but-wrong answer. The
// templates pull Open Sans from fonts.googleapis.com over the live network, so
// "networkidle0 never settles on a cold DNS/TLS handshake" reads as the whole
// story. Measured, it is not:
//   • A cold Chromium in a bare process fetches those fonts and settles
//     networkidle0 in ~990 ms (launch 2.0 s, setContent 0.99 s, total 3.5 s).
//   • Render #2 in the SAME browser still issues both font requests and still
//     takes ~930 ms — there is no "first render pays, the rest ride a cache"
//     asymmetry to explain the first-only failure.
//   • With both font hosts blackholed (--host-resolver-rules to TEST-NET-3),
//     BOTH renders time out at 30 s. So if egress were the problem, every
//     render would fail — yet production's retry succeeds. Egress is healthy.
// The logo is likewise exonerated: it is an inline data: URI whenever logo.png
// exists (it is tracked, so always), never a fetch.
//
// ⚠️ IT IS ALSO NOT THE BROWSER LAUNCH, so pre-warming Chromium at boot does
// not fix it. getBrowser() resolves BEFORE setContent starts, so launch time is
// not inside the navigation budget at all — measured 1.4-2.4 s of a ~33 s
// failure. Holding a resident Chromium would buy ~2 s and cost RAM 24/7.
//
// THE ACTUAL CAUSE: Puppeteer's `timeout` is a NODE-SIDE WALL-CLOCK TIMER. When
// the event loop is blocked, Chromium's CDP replies sit unread in the socket
// and that timer keeps burning, so a page Chromium finished in under a second
// is reported as a navigation timeout. Proven directly by blocking the loop
// with a busy-wait during an otherwise healthy render:
//     block    0 ms -> setContent   918 ms  ok
//     block 5000 ms -> setContent  5165 ms  ok
//     block 31000 ms -> setContent 31155 ms  "Navigation timeout of 30000 ms exceeded"
// The last line is the production error, produced with no font, network or
// Chromium problem whatsoever.
//
// WHY ONLY THE FIRST ONE: right after a restart every in-process cache and memo
// is cold — the 60 s Job Tracking cache, the active-days memo over ~933k
// telemetry rows, the Sheets tab-id map — so the first dashboard / investor /
// financials requests each do their most expensive synchronous SQLite+JS pass,
// on top of module-eval and the boot migrations. Measured on a 124 MB copy of
// production's DB: a 1.9 s block during module init, and a single 7.2 s block
// when a dashboard + two investor portals + financials load concurrently, which
// is exactly the shape of a real deploy. Production's DB is ~313 MB on a VPS
// shared with 20+ other processes, which is how 7 s becomes 30+. Whenever one
// of those blocks overlaps an in-flight setContent, its whole duration is
// charged to the navigation budget.
//
// THE FIX: retry once, but only when we can SHOW the loop stalled. A blind
// retry would turn a genuinely unsettleable template into a doubled 60 s hang,
// which is the one thing this must not do. So we sample event-loop lag for the
// duration of the attempt and retry only if we actually observed the stall that
// would explain the timeout; a timeout with a healthy loop is a real page
// problem and is rethrown immediately, as fast as it fails today. Costs one
// unref'd 50 ms interval while a render is in flight and nothing at all at idle.
// ===========================================================================
const NAV_TIMEOUT_MS = Number(process.env.PDF_NAV_TIMEOUT_MS || 30000);
// A tick has to overshoot by more than this to count as a stall rather than
// ordinary timer jitter.
const LOOP_STALL_TICK_MS = 100;
// Total observed stall within one attempt that justifies a retry. Healthy
// renders measure ~0; the blocks that cause this bug measured 1.9-7.2 s.
const LOOP_STALL_BUDGET_MS = 1000;

// Accumulates how long the event loop was blocked while a render was waiting.
// ⚠️ unref() is load-bearing: this must never be the handle that keeps a CLI
// script (scripts/docs/generate-docs.js) or a shutting-down server alive.
function startLoopStallSampler() {
	const TICK = 50;
	let blockedMs = 0;
	let last = Date.now();
	const iv = setInterval(() => {
		const now = Date.now();
		const over = now - last - TICK;
		if (over > LOOP_STALL_TICK_MS) blockedMs += over;
		last = now;
	}, TICK);
	if (typeof iv.unref === "function") iv.unref();
	return { stop: () => { clearInterval(iv); return blockedMs; } };
}

function isNavTimeout(err) {
	// Puppeteer throws TimeoutError; match on the class name AND the message so
	// a version that renames the class still lands here.
	return err && (err.name === "TimeoutError" || /timeout of \d+ ms exceeded/i.test(err.message || ""));
}

// Open a page and load `html` into it, surviving an event-loop stall.
//
// Exported because lib/policy-renderer.js needs the same treatment but cannot
// call renderHtmlToPdf() — it fills the DOM between setContent and page.pdf().
// It used to carry its OWN copy of this setContent + document.fonts.ready pair,
// so fixing only renderHtmlToPdf would have left every onboarding and policy
// document with the original bug. One implementation, both callers.
//
// Returns a live page the caller owns and must close.
async function openPageWithContent(html) {
	let lastErr = null;
	// attempt 0 = normal; attempt 1 = the stall retry, and only ever one.
	for (let attempt = 0; attempt < 2; attempt++) {
		// ⚠️ The sampler starts BEFORE getBrowser()/newPage(), not just around
		// setContent, and that is a measured requirement rather than tidiness. A
		// stall that lands while the page is being CREATED leaves the subsequent
		// setContent unable to settle inside its budget — reproduced in
		// scripts/test-pdf-cold-start.js §1, where a 4.2 s block spanning
		// newPage() produced a timeout that a setContent-only sampler scored as
		// "0 ms blocked, healthy loop" and therefore refused to retry. The window
		// that must be watched is the whole attempt.
		const sampler = startLoopStallSampler();
		// `page` is declared out here so the catch can close it, and stays null
		// when the failure was the launch itself — a browser that would not start
		// leaves nothing to close and must not throw a second time on the way out.
		let page = null;
		try {
			const b = await getBrowser();
			page = await b.newPage();
			await page.setContent(html, { waitUntil: "networkidle0", timeout: NAV_TIMEOUT_MS });
			// Wait for Google Fonts (loaded via <link>) to finish fetching before rendering.
			// Without this, the first render uses Arial fallback and the second uses Open Sans.
			await page.evaluateHandle(() => document.fonts.ready);
			sampler.stop();
			return page;
		} catch (err) {
			const blockedMs = sampler.stop();
			if (page) await page.close().catch(() => {});
			lastErr = err;
			const stalled = blockedMs >= LOOP_STALL_BUDGET_MS;
			// Rethrow at once unless this is the one case a retry actually
			// addresses: a TIMEOUT that a measured stall explains. A broken
			// template (healthy loop, still no settle) must fail in one budget,
			// never two, and a non-timeout error is never retried at all.
			if (attempt === 1 || !isNavTimeout(err) || !stalled) {
				if (isNavTimeout(err) && !stalled) {
					console.error(
						`renderHtmlToPdf: navigation timed out after ${NAV_TIMEOUT_MS} ms with a HEALTHY event loop ` +
						`(blocked only ${blockedMs} ms) — this is a page/template problem, not the cold-start stall. Not retrying.`
					);
				}
				throw err;
			}
			console.warn(
				`renderHtmlToPdf: navigation timed out after ${NAV_TIMEOUT_MS} ms, but the event loop was blocked ` +
				`${blockedMs} ms of it (cold-start contention) — Chromium was almost certainly fine. Retrying once on a fresh page.`
			);
		}
	}
	throw lastErr;
}

async function renderHtmlToPdf(html) {
	const page = await openPageWithContent(html);
	try {
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

module.exports = { getBrowser, openPageWithContent, renderHtmlToPdf, shutdownBrowser };
