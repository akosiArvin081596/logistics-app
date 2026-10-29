// Singleton Puppeteer browser instance for HTML → PDF rendering.
// One Chromium process is spawned on first use and reused across every sign request,
// preview render, and weekly invoice generation. If Chromium crashes or gets killed
// (OOM, SIGKILL), the next render re-launches it transparently.
//
// A mutex serializes page creation so concurrent requests don't race on the browser
// during a relaunch.


// ===========================================================================
// ONE CONCURRENCY GATE OVER THE ONE BROWSER
// ===========================================================================
// The singleton above is a singleton BROWSER, not a singleton renderer: every
// caller reached b.newPage() unserialized, so the number of Chromium tabs open
// at once was bounded by nothing. Two routes carried their own in-flight caps,
// which between them covered 2 of ~14 render paths; the invoice draft, the
// payout statement, every onboarding signature and the Friday invoice batch
// were all outside them.
//
// ⚠️ THIS BOUNDS OPEN PAGES, NOT CALLS. The slot is held until the page is
// CLOSED, not until openPageWithContent() returns — it hands back a live page
// the caller owns, and it is the open page that holds the memory.
//
// ⚠️ ACQUIRED OUTSIDE THE RETRY LOOP, and that is a correctness requirement,
// not tidiness. Each attempt starts an event-loop stall sampler BEFORE
// getBrowser()/newPage() (see the comment on that loop), and retries only when
// it measured ≥ LOOP_STALL_BUDGET_MS of blocked loop. Acquire inside, and time
// spent waiting for a slot is charged as event-loop stall — so contention would
// masquerade as the cold-start bug and every queued render would do the work
// twice. The wait happens before the sampler exists.
//
// ⚠️ BRIEF WAIT, THEN REFUSE — never an unbounded queue. server.js records the
// trap beside the onboarding sign routes: the client aborts at 20 s while the
// server allows 30 s, so a request queued past the client's budget produces a
// visible failure the user answers by RETRYING, which enqueues a second render
// behind the first. The tightest budget is POST /api/public/investor-apply,
// which renders three documents sequentially inside one 20 s request — so the
// wait is short by default and the refusal is fast.
const PDF_MAX_INFLIGHT = Math.max(1, Math.min(8, Number(process.env.PDF_MAX_INFLIGHT || 3)));
const PDF_QUEUE_WAIT_MS = Math.max(0, Math.min(15000, Number(process.env.PDF_QUEUE_WAIT_MS || 3000)));
let renderInflight = 0;
const renderWaiters = [];

function rendererBusyError() {
	const err = new Error("PDF renderer busy");
	err.code = "PDF_RENDERER_BUSY";
	err.status = 503;
	return err;
}

function acquireRenderSlot() {
	if (renderInflight < PDF_MAX_INFLIGHT) {
		renderInflight++;
		return Promise.resolve();
	}
	if (PDF_QUEUE_WAIT_MS <= 0) return Promise.reject(rendererBusyError());
	return new Promise((resolve, reject) => {
		const waiter = { resolve, reject, timer: null };
		waiter.timer = setTimeout(() => {
			const i = renderWaiters.indexOf(waiter);
			if (i >= 0) renderWaiters.splice(i, 1);
			reject(rendererBusyError());
		}, PDF_QUEUE_WAIT_MS);
		// ⚠️ NOT unref'd, unlike the stall sampler. That interval is a passive
		// observer and must never hold the process open; THIS timer is the only
		// thing keeping the loop alive while a caller awaits a slot. unref it and
		// a CLI render (scripts/docs/generate-docs.js, regenerate-invoice-pdfs)
		// can exit mid-queue with its work silently unfinished — which is exactly
		// what this suite caught on the first run.
		renderWaiters.push(waiter);
	});
}

function releaseRenderSlot() {
	// Hand the slot straight to the next waiter rather than decrementing and
	// letting it re-race: a decrement-then-notify leaves a window a fresh caller
	// can win, which is how a queue starves under sustained load.
	const waiter = renderWaiters.shift();
	if (waiter) {
		clearTimeout(waiter.timer);
		waiter.resolve();
		return;
	}
	if (renderInflight > 0) renderInflight--;
}

// Every page is gone when the browser dies, so the count must go with it —
// otherwise a crash mid-render ratchets the gate down permanently, which is the
// leak the two route-local caps warn about in their own finally blocks.
function resetRenderSlots() {
	renderInflight = 0;
	while (renderWaiters.length) {
		const w = renderWaiters.shift();
		clearTimeout(w.timer);
		w.resolve();
	}
}

function renderSlotStats() {
	return { max: PDF_MAX_INFLIGHT, inflight: renderInflight, waiting: renderWaiters.length, waitMs: PDF_QUEUE_WAIT_MS };
}

const puppeteer = require("puppeteer");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let browser = null;
let launching = null; // in-flight launch promise (acts as a mutex)
// What each browser was launched with: its controls and, under the fixed
// environment, the profile folder this module made for it.
const launchedWith = new WeakMap();

// ===========================================================================
// CHROMIUM'S CONTROLS: three flags, each on only when exactly "true"
// ===========================================================================
// With all three off, the launch is the one before them (scripts/test-chromium-launch.js).
// CHROMIUM_UNPRIVILEGED_ENABLED: a fixed environment (PATH, LANG, TZ, and HOME
//   set to a fresh profile folder); while the app is root, Chromium also runs
//   under CHROMIUM_RUN_AS's account (no default) through lib/chromium-drop.sh,
//   and a check after launch closes a browser not running as that account.
// CHROMIUM_REQUEST_ALLOWLIST_ENABLED: pages opened by openPageWithContent()
//   reach only data: and the two Google Fonts hosts.
// CHROMIUM_SANDBOX_ENABLED: Chromium's own sandbox. It won't start as root, so
//   as root it applies only with the uid drop, and is otherwise ignored.
// Read at each launch, so a script that loads its settings after requiring
// this file gets them. A failed launch is never retried with fewer controls.
const DROP_WRAPPER = path.join(__dirname, "chromium-drop.sh");
// Puppeteer's own profile-folder prefix; lib/chromium-drop.sh accepts only it.
const PROFILE_PREFIX = "puppeteer_dev_chrome_profile-";
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const ACCOUNT_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SANDBOX_FLAGS = ["--no-sandbox", "--disable-setuid-sandbox"];

function processUid() {
	return typeof process.getuid === "function" ? process.getuid() : null;
}

function chromiumControls(env = process.env, uid = processUid()) {
	const unprivileged = env.CHROMIUM_UNPRIVILEGED_ENABLED === "true";
	const root = uid === 0;
	const drop = unprivileged && root;
	const sandboxWanted = env.CHROMIUM_SANDBOX_ENABLED === "true";
	const sandbox = sandboxWanted && (!root || drop);
	return {
		unprivileged,
		drop,
		root,
		allowlist: env.CHROMIUM_REQUEST_ALLOWLIST_ENABLED === "true",
		sandbox,
		sandboxIgnored: sandboxWanted && !sandbox,
		runAs: String(env.CHROMIUM_RUN_AS ?? "").trim(),
	};
}

// The app's start line, or "" when every control is off.
function describeChromiumControls(env = process.env, uid = processUid()) {
	const c = chromiumControls(env, uid);
	if (!c.unprivileged && !c.allowlist && !c.sandbox && !c.sandboxIgnored) return "";
	const on = [];
	if (c.drop) on.push(c.runAs ? `its own account (${c.runAs}) with a fixed environment` : "its own account, but CHROMIUM_RUN_AS is not set, so Chromium will not start");
	else if (c.unprivileged) on.push("a fixed environment");
	if (c.allowlist) on.push("requests limited to data: and the two Google Fonts hosts");
	if (c.sandbox) on.push("its own sandbox");
	let line = `[pdf-browser] Chromium runs with ${on.length ? on.join(", ") : "none of its controls"}.`;
	if (c.sandboxIgnored) line += " CHROMIUM_SANDBOX_ENABLED is ignored: the app runs as root without the uid drop (CHROMIUM_UNPRIVILEGED_ENABLED), and Chromium won't start as root with its sandbox.";
	// Whether a launch that fails closed reaches a person, said where the
	// controls are read back before production's are switched on.
	line += env.CHROMIUM_LAUNCH_ALERT_SEND === "true"
		? " Its first launch failure is logged and alerted."
		: " Its first launch failure is logged only: CHROMIUM_LAUNCH_ALERT_SEND is not on.";
	return line;
}

// Chromium's whole environment under the flag: these four names, no others.
// TZ stays so rendered dates can't shift.
function chromiumEnv(env, home) {
	const out = {};
	if (env.PATH) out.PATH = env.PATH;
	out.HOME = home;
	if (env.LANG) out.LANG = env.LANG;
	if (env.TZ) out.TZ = env.TZ;
	return out;
}

function launchControlError(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

function removeProfile(dir) {
	if (!dir) return Promise.resolve();
	return fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}

// An account's uid and primary gid, as the drop's wrapper reads them.
function accountIds(name) {
	return new Promise((resolve, reject) => {
		execFile("/usr/bin/id", ["--", name], { timeout: 5000 }, (err, stdout) => {
			const uid = /\buid=(\d+)/.exec(String(stdout || ""));
			const gid = /\bgid=(\d+)/.exec(String(stdout || ""));
			if (err || !uid || !gid) reject(launchControlError("CHROMIUM_ACCOUNT_UNKNOWN", "CHROMIUM_RUN_AS names no account this server knows"));
			else resolve({ uid: Number(uid[1]), gid: Number(gid[1]) });
		});
	});
}

// /proc exists on Linux only; elsewhere (a developer's Mac) the uid check is
// skipped, said once per process.
let uidCheckSkipNoted = false;

// After launch, before the browser is used: the sandbox flags really are gone
// when the sandbox is on, and under the uid drop's flag the browser runs as the
// expected account (no groups, no new privileges) or as the app itself.
async function checkLaunchedBrowser(b, controls) {
	const proc = typeof b.process === "function" ? b.process() : null;
	const pid = proc && proc.pid;
	if (!pid) throw launchControlError("CHROMIUM_IDENTITY_UNCHECKED", "the browser has no process to check");
	if (controls.sandbox && (proc.spawnargs || []).some((a) => SANDBOX_FLAGS.includes(a))) {
		throw launchControlError("CHROMIUM_SANDBOX_FLAGS", "the sandbox is on, but the browser started with a flag that turns it off");
	}
	if (!controls.unprivileged) return;
	if (process.platform !== "linux") {
		if (!uidCheckSkipNoted) {
			uidCheckSkipNoted = true;
			console.log("[pdf-browser] the check of Chromium's account after launch runs on Linux only; skipped here.");
		}
		return;
	}
	const want = controls.drop
		? await accountIds(controls.runAs)
		: { uid: processUid(), gid: typeof process.getgid === "function" ? process.getgid() : null };
	const status = await fs.promises.readFile(`/proc/${pid}/status`, "utf8");
	const ids = (label) => (new RegExp(`^${label}:\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*$`, "m").exec(status) || []).slice(1).map(Number);
	const uids = ids("Uid");
	const gids = ids("Gid");
	const field = (label) => {
		const m = new RegExp(`^${label}:[ \\t]*(.*)$`, "m").exec(status);
		return m ? m[1].trim() : null;
	};
	const ok = uids.length === 4 && uids.every((u) => u === want.uid)
		&& (!controls.drop || (want.uid !== 0
			&& gids.length === 4 && gids.every((g) => g === want.gid)
			&& field("Groups") === ""
			&& field("NoNewPrivs") === "1"));
	if (!ok) throw launchControlError("CHROMIUM_IDENTITY_MISMATCH", "the browser was not running as the expected account, so it was closed");
}

// A browser that failed its check is closed at once: its whole process group.
function killBrowser(b) {
	const proc = typeof b.process === "function" ? b.process() : null;
	if (!proc || !proc.pid) return;
	try { process.kill(-proc.pid, "SIGKILL"); } catch { /* not a group leader, or gone */ }
	try { process.kill(proc.pid, "SIGKILL"); } catch { /* already gone */ }
}

async function launchBrowser(controls) {
	const extra = {};
	let profile = null;
	if (controls.unprivileged) {
		if (controls.drop && !controls.runAs) throw launchControlError("CHROMIUM_RUN_AS_UNSET", "CHROMIUM_RUN_AS is not set, so Chromium is not started as root");
		if (controls.drop && !ACCOUNT_RE.test(controls.runAs)) throw launchControlError("CHROMIUM_RUN_AS_INVALID", "CHROMIUM_RUN_AS is not a plain account name");
		profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), PROFILE_PREFIX));
		extra.userDataDir = profile;
		extra.env = chromiumEnv(process.env, profile);
		if (controls.drop) {
			let binary;
			try {
				binary = await fs.promises.realpath(await puppeteer.executablePath());
			} catch {
				await removeProfile(profile);
				throw launchControlError("CHROMIUM_BINARY_MISSING", "Chromium's binary was not found where Puppeteer expects it");
			}
			extra.executablePath = DROP_WRAPPER;
			extra.env.LOGISX_CHROMIUM_BINARY = binary;
			extra.env.LOGISX_CHROMIUM_ACCOUNT = controls.runAs;
		}
	}
	// A PUPPETEER_* setting can't put the sandbox flags back.
	if (controls.sandbox) extra.ignoreDefaultArgs = [...SANDBOX_FLAGS];
	let b;
	try {
		b = await puppeteer.launch({
			...extra,
			headless: "new",
			// Control Chromium over a pipe (--remote-debugging-pipe), not a local
			// debugging port. Pinned by scripts/test-pdf-browser-pipe.js.
			pipe: true,
			args: [
				...(controls.sandbox ? [] : SANDBOX_FLAGS),
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
				// In a local replica of production (as replica-mode's boot decided,
				// never the environment, which a .env file may change): Chromium is
				// a separate process, beyond the app's network guard, so it starts
				// unable to reach anything (lib/replica-rules.js).
				...(require("./replica-mode").active() ? require("./replica-rules").CHROMIUM_OFFLINE_ARGS : []),
			],
		});
	} catch (err) {
		await removeProfile(profile);
		throw err;
	}
	if (profile) {
		const proc = typeof b.process === "function" ? b.process() : null;
		if (proc && typeof proc.once === "function") proc.once("exit", () => { removeProfile(profile); });
	}
	if (controls.unprivileged || controls.sandbox) {
		try {
			await checkLaunchedBrowser(b, controls);
		} catch (err) {
			killBrowser(b);
			await removeProfile(profile);
			throw err;
		}
	}
	return { b, profile };
}

// The first launch failure in a process: one log line, and one alert where
// CHROMIUM_LAUNCH_ALERT_SEND is "true" (the alert's channels are the app's:
// setLaunchFailureAlert()). Never a retry with fewer controls.
let launchFailureReported = false;
let launchFailureAlert = null;
function setLaunchFailureAlert(fn) {
	launchFailureAlert = typeof fn === "function" ? fn : null;
}

// What failed, in words fit for an alert: setting names, never their values.
// A launch over the control pipe reports no output from Chromium, so a failure
// after it started is named by the controls that were on.
function launchFailureCause(err, controls) {
	const known = {
		CHROMIUM_RUN_AS_UNSET: "CHROMIUM_RUN_AS is not set, so Chromium is not started as root",
		CHROMIUM_RUN_AS_INVALID: "CHROMIUM_RUN_AS is not a plain account name",
		CHROMIUM_ACCOUNT_UNKNOWN: "CHROMIUM_RUN_AS names no account this server knows",
		CHROMIUM_BINARY_MISSING: "Chromium's binary was not found where Puppeteer expects it",
		CHROMIUM_IDENTITY_UNCHECKED: "the started browser could not be checked, so it was closed",
		CHROMIUM_IDENTITY_MISMATCH: "the started browser was not running as the expected account, so it was closed",
		CHROMIUM_SANDBOX_FLAGS: "the sandbox is on, but the browser started with a flag that turns it off, so it was closed",
	};
	if (err && Object.hasOwn(known, err.code)) return known[err.code];
	const on = [];
	if (controls.drop) on.push("the switch to CHROMIUM_RUN_AS's account (lib/chromium-drop.sh)");
	if (controls.sandbox) on.push("Chromium's own sandbox (CHROMIUM_SANDBOX_ENABLED)");
	if (on.length) return `the browser exited during launch, with ${on.join(" and ")} on; either refuses at once when it can't start`;
	return "the browser process did not start";
}

function reportLaunchFailure(err, controls) {
	if (launchFailureReported) return;
	launchFailureReported = true;
	const cause = launchFailureCause(err, controls);
	const detail = String((err && err.message) || err || "").split("\n")[0].slice(0, 300);
	console.error(`[pdf-browser] Chromium failed to start: ${cause}. No PDF renders until it starts; each render tries again, never with fewer controls. (${detail})`);
	if (process.env.CHROMIUM_LAUNCH_ALERT_SEND !== "true" || !launchFailureAlert) return;
	const alert = launchFailureAlert;
	Promise.resolve()
		.then(() => alert({ cause }))
		.catch((e) => console.error(`[pdf-browser] the launch-failure alert failed: ${(e && e.message) || e}`));
}

// The request allowlist on one page: data: and https on the two Google Fonts
// hosts go through; anything else is refused. When the page closes, one line
// counts what was refused, by host name only, never a full address.
async function allowListedRequestsOnly(page) {
	const refused = new Map();
	await page.setRequestInterception(true);
	page.on("request", (req) => {
		if (req.isInterceptResolutionHandled()) return;
		const url = req.url();
		let host = "";
		let allowed = url.startsWith("data:");
		if (!allowed) {
			try {
				const u = new URL(url);
				allowed = u.protocol === "https:" && u.port === "" && FONT_HOSTS.has(u.hostname);
				host = u.hostname || u.protocol;
			} catch {
				host = "(unreadable address)";
			}
		}
		if (allowed) {
			req.continue().catch(() => {});
			return;
		}
		refused.set(host, (refused.get(host) || 0) + 1);
		req.abort("blockedbyclient").catch(() => {});
	});
	page.once("close", () => {
		if (!refused.size) return;
		const total = [...refused.values()].reduce((a, n) => a + n, 0);
		const hosts = [...refused.keys()].slice(0, 10).map((h) => h.slice(0, 100));
		console.warn(`[pdf-browser] request allowlist: refused ${total} request(s) to ${hosts.join(", ")}${refused.size > hosts.length ? ", …" : ""}`);
	});
}

// ⚠️ Puppeteer renamed this between majors and the break is SILENT on the happy
// path. Up to and including v24 a Browser exposed `isConnected()` (a method);
// from v25 it is `connected` (a boolean property) and `isConnected` is
// `undefined`. Calling the old form throws `TypeError: browser.isConnected is
// not a function`.
//
// What makes it nasty: `getBrowser()` only reaches this check when a browser is
// ALREADY cached, so the FIRST render of a process succeeds and every
// subsequent one throws. A one-render smoke test passes; invoices, onboarding
// documents and investor statements all break from the second PDF onward.
// Caught by scripts/test-pdf-cold-start.js during the v24 -> v25 bump, which
// renders more than once.
//
// Handles both shapes so this file is not welded to one puppeteer major.
function browserAlive(b) {
	if (!b) return false;
	if (typeof b.connected === "boolean") return b.connected;      // puppeteer >= 25
	if (typeof b.isConnected === "function") return b.isConnected(); // puppeteer <= 24
	return false;
}

async function getBrowser() {
	if (browserAlive(browser)) return browser;
	if (launching) return launching;

	const controls = chromiumControls(process.env);
	launching = launchBrowser(controls)
		.then(({ b, profile }) => {
			browser = b;
			launchedWith.set(b, { controls, profile });
			launching = null;
			// If Chromium dies, null out the reference so the next call relaunches
			b.on("disconnected", () => {
				if (browser === b) browser = null;
				// Every page died with it — release the gate or it ratchets shut.
				resetRenderSlots();
			});
			return b;
		})
		.catch((err) => {
			launching = null;
			reportLaunchFailure(err, controls);
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
	// ⚠️ OUTSIDE the attempt loop — see the gate's own comment. Waiting here is
	// invisible to the stall sampler, which is the whole point.
	await acquireRenderSlot();
	let releasedSlot = false;
	const releaseSlot = () => {
		if (releasedSlot) return;
		releasedSlot = true;
		releaseRenderSlot();
	};
	try {
		return await openPageWithContentGated(html, releaseSlot);
	} catch (err) {
		// A failure never returns a page, so nothing downstream can release it.
		releaseSlot();
		throw err;
	}
}

// The original body, unchanged apart from handing the slot's release to the
// page it returns. Split out so the acquire above cannot accidentally end up
// inside the retry loop when this function is next edited.
async function openPageWithContentGated(html, releaseSlot) {
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
			const launch = launchedWith.get(b);
			if (launch && launch.controls.allowlist) await allowListedRequestsOnly(page);
			await page.setContent(html, { waitUntil: "networkidle0", timeout: NAV_TIMEOUT_MS });
			// Wait for Google Fonts (loaded via <link>) to finish fetching before rendering.
			// Without this, the first render uses Arial fallback and the second uses Open Sans.
			await page.evaluateHandle(() => document.fonts.ready);
			sampler.stop();
			// ⚠️ THE SLOT IS HELD UNTIL THE PAGE CLOSES, not until this returns.
			// Both callers close in a finally (renderHtmlToPdf below,
			// lib/policy-renderer.js), and the "close" event also fires when the
			// browser dies — so the release cannot be skipped by a throw on the
			// caller's side, which is how an in-flight cap ratchets to a
			// permanent refusal.
			page.once("close", releaseSlot);
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

// ⚠️ close() ALONE ORPHANS CHROMIUM, measured on production. Two browser
// processes started 2026-08-01 were still alive on 2026-08-19 with ppid=1, having
// outlived ~150 app restarts and holding 293 MB — while this handler had logged
// "shutting down Puppeteer browser" 220 times. So it fires and still loses the
// race: pm2 sends SIGINT, browser.close() is asynchronous, and SIGKILL arrives
// before it finishes. Node dies, Chromium is reparented to init, and nothing
// ever reaps it. Nothing in the app notices, because the next boot just launches
// a fresh one — the cost is invisible until the box is counted.
//
// So: bound the graceful close, then kill the process outright if it is still
// there. Killing a browser whose pages are already gone costs nothing; leaving
// one behind costs a process forever.
const BROWSER_CLOSE_TIMEOUT_MS = Math.max(250, Math.min(10000, Number(process.env.PDF_CLOSE_TIMEOUT_MS || 3000)));

async function shutdownBrowser() {
	const b = browser;
	// Null it FIRST so a render landing during shutdown relaunches rather than
	// attaching to the instance being torn down.
	browser = null;
	resetRenderSlots();
	if (!b) return;
	const proc = typeof b.process === "function" ? b.process() : null;
	try {
		await Promise.race([
			b.close(),
			// Also not unref'd: exiting before this fires is precisely how the
			// browser gets orphaned, which is the bug this function exists to fix.
			new Promise((resolve) => setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS)),
		]);
	} catch {
		/* ignore — the kill below is the backstop */
	}
	if (proc && proc.pid && !proc.killed) {
		try {
			process.kill(proc.pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
	// The app exits right after this, before the browser's exit event would
	// remove the profile folder this module made for it.
	const launch = launchedWith.get(b);
	if (launch) await removeProfile(launch.profile);
}

module.exports = {
	getBrowser,
	openPageWithContent,
	renderHtmlToPdf,
	shutdownBrowser,
	// Exported for the health surface and the tests — reading the gate must not
	// require reaching into module state.
	renderSlotStats,
	// Chromium's controls: the start line, and the app's alert for the first
	// launch failure in a process.
	describeChromiumControls,
	setLaunchFailureAlert,
};
