#!/usr/bin/env node
// Regression test for the cold-start PDF navigation timeout.
//
// The bug: the first PDF render after a process restart 500s at ~33 s with
// "Navigation timeout of 30000 ms exceeded", because Puppeteer's timeout is a
// NODE-SIDE wall-clock timer and the boot burst blocks the event loop long
// enough to spend the whole navigation budget while Chromium sits idle and
// ready. Full diagnosis in the header of lib/pdf-browser.js.
//
// This locks the two halves that make the fix safe, and they pull in opposite
// directions — which is the point:
//
//   §0  baseline — a healthy render still works, on the FIRST attempt.
//   §1  a timeout WITH a measured event-loop stall  -> retried once, succeeds.
//   §2  a timeout with a HEALTHY event loop         -> NOT retried, fails in
//                                                      ONE budget, never two.
//
// §2 is the guard the whole design rests on: a blind retry would turn a
// genuinely unsettleable template into a doubled 60 s hang in production.
//
// Chromium's controls (lib/pdf-browser.js), each in a child process of its own
// with the normal navigation budget:
//   §3  the render check: with the request allowlist and the fixed environment
//       on, a payout statement, a broker invoice and every onboarding and
//       invoice template render on made-up data with no request refused; a
//       control page's loopback stylesheet and image are refused, logged by
//       host name only, and never reach their server.
//   §4  the render comparison: one statement and one invoice, rendered with
//       the controls off and on, have the same pages, the same text on each
//       page and the same embedded fonts. Chromium's own sandbox is left off
//       here: it changes isolation, not layout, and its render is proven where
//       its account and profile exist.
//
// ⚠️ EVERY SECTION ASSERTS ON THE MODULE'S OWN RETRY/NO-RETRY DECISION, NOT ON
// WALL-CLOCK. Elapsed time is reported, and bounded only in §1/§2 where the
// bound is a genuine property of the design (one budget vs two) rather than a
// property of the hardware. §0 originally compared a TOTAL render — Chromium
// launch included — against NAV, a navigation-only budget, and so failed on the
// production VPS at 3524 ms with a perfectly healthy render. Launch is not in
// that budget (getBrowser resolves before setContent starts), so §0 now warms
// the browser outside its timed region and asks the only hardware-independent
// question that matters: did the navigation settle without needing the retry?
//
// Runs with a deliberately tiny PDF_NAV_TIMEOUT_MS so the whole thing takes
// seconds. Exits 1 on any failure.
//
//   node scripts/test-pdf-cold-start.js

const http = require("http");

// Set BEFORE requiring the module — NAV_TIMEOUT_MS is read at module scope.
process.env.PDF_NAV_TIMEOUT_MS = process.env.PDF_NAV_TIMEOUT_MS || "3000";
const NAV = Number(process.env.PDF_NAV_TIMEOUT_MS);

const { getBrowser, openPageWithContent, renderHtmlToPdf, shutdownBrowser } = require("../lib/pdf-browser");

let pass = 0;
let fail = 0;
function ok(cond, label, detail) {
	if (cond) { pass++; console.log(`  ok   ${label}${detail ? "  — " + detail : ""}`); }
	else { fail++; console.log(`  FAIL ${label}${detail ? "  — " + detail : ""}`); }
}

// openPageWithContent() announces which branch it took — console.warn "Retrying
// once on a fresh page." for the stall retry, console.error "Not retrying." for
// a healthy-loop timeout. Those lines are DIRECT evidence of the decision under
// test; wall-clock is only a proxy for it, and a bad one on slow hardware. Lines
// are still passed through to stdout so a run reads the same as before.
function captureRenderLogs() {
	const lines = [];
	const orig = { warn: console.warn, error: console.error };
	const tap = (fn) => (...args) => {
		const s = args.map(String).join(" ");
		if (s.includes("renderHtmlToPdf:")) lines.push(s);
		fn(...args);
	};
	console.warn = tap(orig.warn);
	console.error = tap(orig.error);
	return {
		stop() {
			console.warn = orig.warn;
			console.error = orig.error;
			return lines;
		},
	};
}

// Busy-wait: precisely what a long synchronous SQLite scan or a big JS reduce
// does to the loop. setTimeout so it lands mid-navigation. `onDone` runs in the
// same callback, the moment the loop is free again.
function blockLoopIn(delayMs, forMs, onDone) {
	setTimeout(() => {
		const end = Date.now() + forMs;
		while (Date.now() < end) { /* spin */ }
		if (onDone) onDone();
	}, delayMs);
}

// Starts that stall `delayMs` after Puppeteer arms its navigation timer, not
// after the render call: the timer is a plain Node setTimeout of NAV ms (the
// premise of the production bug), so the stall always lands inside the budget,
// however long Chromium takes to open the page first. One shot: the retry's own
// timer is left alone. armed() says whether the timer was ever seen.
function blockLoopAfterNavTimerArmed(delayMs, forMs, onDone) {
	const realSetTimeout = global.setTimeout;
	let armed = false;
	global.setTimeout = function (fn, ms, ...rest) {
		const id = realSetTimeout.call(this, fn, ms, ...rest);
		if (ms === NAV) {
			armed = true;
			global.setTimeout = realSetTimeout;
			blockLoopIn(delayMs, forMs, onDone);
		}
		return id;
	};
	return {
		armed: () => armed,
		restore: () => { global.setTimeout = realSetTimeout; },
	};
}

const PLAIN_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>@page{margin:1in}body{font-family:Arial,sans-serif}</style></head>
<body><h1>cold start regression</h1><p>body text</p></body></html>`;

async function main() {
	// A local server that accepts the connection and then NEVER responds. A page
	// referencing it can never reach networkidle0, so it is a faithful stand-in
	// for a genuinely broken template — with no dependency on the public network.
	const hang = http.createServer(() => { /* deliberately never respond */ });
	await new Promise((r) => hang.listen(0, "127.0.0.1", r));
	const hangPort = hang.address().port;
	const UNSETTLEABLE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link href="http://127.0.0.1:${hangPort}/never.css" rel="stylesheet"></head>
<body><h1>never settles</h1></body></html>`;

	// §1's page waits on a stylesheet this server holds until the stall is over,
	// then serves at once (see §1 for why).
	let stallOver = false;
	const held = [];
	const holding = http.createServer((req, res) => {
		const send = () => res.writeHead(200, { "Content-Type": "text/css" }).end("h1{margin:0}");
		if (stallOver) send();
		else held.push(send);
	});
	await new Promise((r) => holding.listen(0, "127.0.0.1", r));
	const releaseHeld = () => {
		stallOver = true;
		for (const send of held.splice(0)) send();
	};
	const HELD_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link href="http://127.0.0.1:${holding.address().port}/held.css" rel="stylesheet"></head>
<body><h1>cold start regression</h1><p>body text</p></body></html>`;

	console.log(`\n§0  baseline — a healthy render still works (nav timeout ${NAV} ms)`);
	{
		// ⚠️ Warm the browser OUTSIDE the timed region. Chromium launch is
		// ~1.5-2.5 s and is NOT part of the navigation budget — getBrowser()
		// resolves before setContent starts, which is the very measurement that
		// ruled out pre-warming as a fix for the production bug. This section
		// originally timed launch + newPage + navigate + page.pdf and compared
		// that total against NAV, a navigation-only budget, so it was asserting
		// something it never measured: on the production VPS it reported
		// "completes inside one navigation budget — 3524 ms" and FAILED at
		// NAV=3000 while the render was perfectly healthy (valid PDF, no retry).
		// A test that cries wolf gets ignored, and the two assertions that matter
		// are §1 and §2.
		const warm = await getBrowser();

		// The real Chromium's own arguments: controlled over a pipe, with no
		// debugging port (the launch options are pinned hermetically in
		// scripts/test-pdf-browser-pipe.js; this is the spawned process).
		const proc = typeof warm.process === "function" ? warm.process() : null;
		const spawnargs = (proc && proc.spawnargs) || [];
		ok(spawnargs.includes("--remote-debugging-pipe"), "Chromium is controlled over a pipe");
		ok(!spawnargs.some((a) => /^--remote-debugging-(port|address)/.test(a)), "Chromium gets no debugging port argument");

		const cap = captureRenderLogs();
		const t = Date.now();
		const pdf = await renderHtmlToPdf(PLAIN_HTML);
		const ms = Date.now() - t;
		const logs = cap.stop();

		ok(Buffer.isBuffer(pdf), "returns a Buffer");
		ok(pdf.slice(0, 4).toString() === "%PDF", "bytes are a PDF", `${pdf.length} bytes`);
		// What this section is actually for: the navigation settled on the FIRST
		// attempt, so the fix has not made the healthy path depend on its own
		// retry. Asserted on the module's own decision log, not on elapsed time,
		// so it means the same thing on a fast laptop and a loaded VPS. Render
		// time is REPORTED and deliberately NOT asserted — there is no honest
		// hardware-independent bound for it, and inventing one is what broke this.
		ok(
			logs.length === 0,
			"navigation settled on the first attempt (no stall retry)",
			`render ${ms} ms${logs.length ? " | " + logs[0] : ""}`
		);
	}

	console.log(`\n§1  timeout WITH an event-loop stall -> retried once, succeeds`);
	{
		// Block for longer than the whole budget, so attempt 1 cannot help but
		// time out even though Chromium has the (trivial, local) page ready.
		//
		// ⚠️ This section used to fail about 1 run in 3 on an idle machine (4 of
		// 14, measured 2026-10-11): the page settled by itself during the
		// stall, so when the loop came back the overdue timer and Chromium's
		// queued "settled" message raced, and the message won. The render then
		// passed at ~4390 ms (the stall's end) with no retry. Its stylesheet is
		// now held until the stall is over, so Chromium cannot have settled and
		// the overdue timer fires first, every time; the retry gets the
		// stylesheet at once. And the stall starts 150 ms after Puppeteer arms
		// its navigation timer, not after the call, so a slow newPage() can't
		// let it pass before the budget begins.
		const stall = blockLoopAfterNavTimerArmed(150, NAV + 1200, releaseHeld);
		const cap = captureRenderLogs();
		const t = Date.now();
		let pdf = null;
		let err = null;
		try { pdf = await renderHtmlToPdf(HELD_HTML); } catch (e) { err = e; } finally { stall.restore(); }
		const ms = Date.now() - t;
		const logs = cap.stop();
		ok(stall.armed(), "the stall landed inside the navigation budget", stall.armed() ? `started 150 ms after the ${NAV} ms timer was armed` : `no ${NAV} ms timer was armed: Puppeteer no longer times navigation with a Node setTimeout, so this section tests nothing`);
		ok(!err, "render SUCCEEDS despite the stall", err ? err.message.split("\n")[0] : `${ms} ms`);
		ok(pdf && pdf.slice(0, 4).toString() === "%PDF", "and the bytes are a real PDF");
		// The retry DEMONSTRABLY ran — read off the module's own decision, so this
		// cannot pass on a render that simply happened to be slow.
		ok(
			logs.some((l) => l.includes("Retrying once")),
			"the stall retry is what saved it",
			logs[0] ? logs[0].slice(logs[0].indexOf("but the event loop")) : "no retry log emitted"
		);
		// It must also have actually spent a first budget then recovered — proving
		// the stall was not simply too short to matter.
		ok(ms > NAV, "did consume the first budget before retrying", `${ms} ms > ${NAV} ms`);
	}

	console.log(`\n§2  timeout with a HEALTHY loop -> NOT retried (no doubled hang)`);
	{
		const cap = captureRenderLogs();
		const t = Date.now();
		let err = null;
		try { await openPageWithContent(UNSETTLEABLE_HTML); } catch (e) { err = e; }
		const ms = Date.now() - t;
		const logs = cap.stop();
		ok(!!err, "an unsettleable page still fails", err ? err.name : "no error thrown");
		// THE load-bearing assertion, in the two forms it can be checked. The
		// module's own decision first — it refused to retry — and then the elapsed
		// consequence: one budget (plus launch/newPage slack), never two. At 2x
		// this would be the 60 s production hang the design exists to prevent.
		ok(
			logs.some((l) => l.includes("Not retrying")),
			"the module explicitly declined to retry",
			logs.length ? "healthy-loop timeout recognised" : "no decision log emitted"
		);
		ok(ms < NAV * 2, "fails within ONE budget, not two", `${ms} ms (2x would be ${NAV * 2} ms)`);
	}

	await new Promise((r) => hang.close(r));
	await new Promise((r) => holding.close(r));
	await shutdownBrowser();

	await controlsSections();

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
}

// ── §3 and §4: Chromium's controls, each mode in a child process ─────────────
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const ROOT = path.join(__dirname, "..");

// Made-up documents: one investor statement, one broker invoice.
const CHILD_SRC = `"use strict";
const fs = require("fs");
const path = require("path");
const [root, outDir, mode, controlPort] = process.argv.slice(2);
const lines = [];
for (const k of ["log", "warn", "error"]) {
	const orig = console[k].bind(console);
	console[k] = (...a) => { lines.push(a.map(String).join(" ")); orig(...a); };
}
const { renderHtmlToPdf, shutdownBrowser } = require(path.join(root, "lib", "pdf-browser.js"));
const { buildPayoutStatementHtml } = require(path.join(root, "lib", "payout-statement.js"));
const { buildInvoiceHtml } = require(path.join(root, "lib", "broker-invoice.js"));
const { renderPolicy, prepareTemplateHtml } = require(path.join(root, "lib", "policy-renderer.js"));
const STATEMENT = {
	investorName: "Made-Up Investor", investorCompany: "Made-Up Holdings LLC", period: "2026-06", periodLabel: "June 2026",
	statementNo: "202606-7", generatedAt: new Date("2026-08-14T17:00:00Z"),
	status: "paid", paidAt: "2026-07-31T15:00:00.000Z", paidBy: "made-up-admin", dueDate: "2026-07-31",
	breakdown: { revenue: 35161.76, driverPay: 9000, fixedCosts: 6149.16, tripExpenses: 2431.72, maintFundCost: 0, complianceCost: 0, netProfit: 17580.88, splitPct: 50, monthShare: 8790 },
	lossCarriedIn: 0, lossDeferred: 0, adjustment: 0, amount: 8790, effectiveAmount: 8790,
	detail: {
		revenueLoads: [{ loadId: "MADE-UP-1", date: "2026-06-03", driver: "Driver One", truck: "91", pickup: "Laredo, TX", dropoff: "Irving, TX", amount: 20161.76 }],
		driverPayRows: [{ driver: "Driver One", payType: "daily", activeDays: 20, dailyRate: 250, pay: 5000 }],
		fixedCostItems: [{ truck: "91", insurance: 1800, eld: 45, truckPayment: 3800, irp: 300.16, hvut: 204, total: 6149.16 }],
		tripExpenseItems: [{ date: "2026-06-05", type: "Fuel", description: "Diesel", driver: "Driver One", city: "Laredo", state: "TX", truck: "91", amount: 1931.72 }],
	},
};
const INVOICE = {
	invoiceId: "MADE-UP-INV-1", invoiceDate: "09/30/2026", brokerName: "Acme Freight",
	invoiceTo: { name: "Acme Freight", email: "ap@example.test" }, orderNumber: "ORD-1", poNumber: "", deliveryDate: "09/29/2026", total: "$1,500.00",
};
(async () => {
	const save = (name, pdf) => fs.writeFileSync(path.join(outDir, name + ".pdf"), pdf);
	save("statement", await renderHtmlToPdf(buildPayoutStatementHtml(STATEMENT)));
	save("invoice", await renderHtmlToPdf(buildInvoiceHtml(INVOICE)));
	const rendered = ["statement", "invoice"];
	if (mode === "on") {
		const keys = fs.readdirSync(path.join(root, "onboarding-templates", "policy")).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5).replace(/-/g, "_")).sort();
		for (const key of keys) {
			try { prepareTemplateHtml(key, {}); } catch (e) { if (/Unknown onboarding doc/.test(e.message)) continue; throw e; }
			save("policy-" + key, await renderPolicy(key, {}));
			rendered.push("policy-" + key);
		}
		lines.push("--- control page ---");
		await renderHtmlToPdf('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="http://127.0.0.1:' + controlPort + '/made-up.css"></head><body><p>control</p><img src="http://127.0.0.1:' + controlPort + '/made-up.png"></body></html>');
	}
	await shutdownBrowser();
	fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({ rendered, lines }));
	process.exit(0);
})().catch((e) => { fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({ error: String(e && e.stack || e), lines })); process.exit(1); });
`;

function renderIn(mode, outDir, childFile, controlPort, extraEnv) {
	return new Promise((resolve) => {
		const env = { ...process.env };
		delete env.PDF_NAV_TIMEOUT_MS; // the child keeps the app's own budget
		for (const k of ["CHROMIUM_UNPRIVILEGED_ENABLED", "CHROMIUM_REQUEST_ALLOWLIST_ENABLED", "CHROMIUM_SANDBOX_ENABLED", "CHROMIUM_RUN_AS"]) delete env[k];
		Object.assign(env, extraEnv);
		const child = spawn(process.execPath, [childFile, ROOT, outDir, mode, String(controlPort)], { env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", (d) => { out += d; });
		const timer = setTimeout(() => child.kill("SIGKILL"), 50000);
		child.on("close", (code) => {
			clearTimeout(timer);
			let result = null;
			try { result = JSON.parse(fs.readFileSync(path.join(outDir, "result.json"), "utf8")); } catch { /* reported by the caller */ }
			resolve({ code, out, result });
		});
	});
}

async function controlsSections() {
	const { pdfReport, compareRenders } = require("./lib/pdf-text");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-pdf-controls-"));
	const childFile = path.join(tmp, "render-child.js");
	fs.writeFileSync(childFile, CHILD_SRC);
	const offDir = path.join(tmp, "off");
	const onDir = path.join(tmp, "on");
	fs.mkdirSync(offDir);
	fs.mkdirSync(onDir);
	// The control page's server: anything that reaches it went past the allowlist.
	const reached = [];
	const control = http.createServer((req, res) => { reached.push(req.url); res.writeHead(200, { "Content-Type": "text/css" }).end(""); });
	await new Promise((r) => control.listen(0, "127.0.0.1", r));
	const port = control.address().port;
	try {
		const [off, on] = await Promise.all([
			renderIn("off", offDir, childFile, port, {}),
			renderIn("on", onDir, childFile, port, { CHROMIUM_UNPRIVILEGED_ENABLED: "true", CHROMIUM_REQUEST_ALLOWLIST_ENABLED: "true" }),
		]);

		console.log(`\n§3  the render check: the request allowlist with a real Chromium`);
		ok(on.code === 0 && on.result && !on.result.error, "every document rendered with the controls on", on.result && on.result.error ? on.result.error.split("\n")[0] : `exit ${on.code}`);
		const rendered = (on.result && on.result.rendered) || [];
		ok(rendered.length >= 4 && rendered.some((r) => r.startsWith("policy-service_invoice")), "the statement, the invoice and the onboarding and invoice templates", rendered.join(", "));
		const lines = (on.result && on.result.lines) || [];
		const cut = lines.indexOf("--- control page ---");
		const before = cut >= 0 ? lines.slice(0, cut) : lines;
		const after = cut >= 0 ? lines.slice(cut + 1) : [];
		const refusedBefore = before.filter((l) => l.includes("request allowlist"));
		ok(refusedBefore.length === 0, "no request from any real template is refused", refusedBefore.join(" | ") || "none");
		const refusedControl = after.filter((l) => l.includes("request allowlist"));
		ok(refusedControl.length === 1 && /refused 2 request\(s\) to 127\.0\.0\.1$/.test(refusedControl[0]), "the control page's two loopback requests are refused, logged by host name", refusedControl.join(" | ") || "no line");
		ok(!refusedControl.some((l) => /made-up\.(css|png)|https?:\/\//.test(l)), "the line carries no path or full address");
		ok(reached.length === 0, "nothing reached the control page's server", reached.join(", ") || "nothing");

		console.log(`\n§4  the render comparison: controls off against controls on`);
		ok(off.code === 0 && off.result && !off.result.error, "every document rendered with the controls off", off.result && off.result.error ? off.result.error.split("\n")[0] : `exit ${off.code}`);
		for (const name of ["statement", "invoice"]) {
			let a = null;
			let b = null;
			try {
				a = await pdfReport(fs.readFileSync(path.join(offDir, `${name}.pdf`)));
				b = await pdfReport(fs.readFileSync(path.join(onDir, `${name}.pdf`)));
			} catch (e) {
				ok(false, `${name}: both PDFs read`, e.message);
				continue;
			}
			// scripts/lib/pdf-text.js's comparison: nothing holds by being empty
			// (scripts/test-pdf-text.js pins it on made-up PDFs).
			const diff = compareRenders(a, b);
			ok(diff.pages === null, `${name}: the same number of pages`, diff.pages || `${a.pages.length} page(s)`);
			ok(diff.text === null, `${name}: the same text on every page`, diff.text || `${a.pages.reduce((n, t) => n + t.length, 0)} glyphs`);
			ok(diff.fonts === null, `${name}: the same embedded fonts, by name and glyph program`, diff.fonts || `${a.fonts.length}: ${a.fonts.map((f) => f.replace(/ #[0-9a-f]{12}$/, "")).join(", ")}`);
			ok(diff.drawing === null, `${name}: neither text nor fonts would mean comparing what the pages draw`, diff.drawing || "not needed");
		}
	} finally {
		await new Promise((r) => control.close(r));
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

main().catch(async (e) => {
	console.error("harness error:", e);
	try { await shutdownBrowser(); } catch { /* ignore */ }
	process.exit(1);
});
