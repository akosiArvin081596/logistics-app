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
// does to the loop. setTimeout so it lands mid-navigation.
function blockLoopIn(delayMs, forMs) {
	setTimeout(() => {
		const end = Date.now() + forMs;
		while (Date.now() < end) { /* spin */ }
	}, delayMs);
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
		await getBrowser();

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
		blockLoopIn(150, NAV + 1200);
		const cap = captureRenderLogs();
		const t = Date.now();
		let pdf = null;
		let err = null;
		try { pdf = await renderHtmlToPdf(PLAIN_HTML); } catch (e) { err = e; }
		const ms = Date.now() - t;
		const logs = cap.stop();
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
	await shutdownBrowser();

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
	console.error("harness error:", e);
	try { await shutdownBrowser(); } catch { /* ignore */ }
	process.exit(1);
});
