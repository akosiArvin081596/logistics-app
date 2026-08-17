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
//   §1  a timeout WITH a measured event-loop stall  -> retried once, succeeds.
//   §2  a timeout with a HEALTHY event loop         -> NOT retried, fails in
//                                                      ONE budget, never two.
//
// §2 is the guard the whole design rests on: a blind retry would turn a
// genuinely unsettleable template into a doubled 60 s hang in production.
//
// Runs with a deliberately tiny PDF_NAV_TIMEOUT_MS so the whole thing takes
// seconds. Exits 1 on any failure.
//
//   node scripts/test-pdf-cold-start.js

const http = require("http");

// Set BEFORE requiring the module — NAV_TIMEOUT_MS is read at module scope.
process.env.PDF_NAV_TIMEOUT_MS = process.env.PDF_NAV_TIMEOUT_MS || "3000";
const NAV = Number(process.env.PDF_NAV_TIMEOUT_MS);

const { openPageWithContent, renderHtmlToPdf, shutdownBrowser } = require("../lib/pdf-browser");

let pass = 0;
let fail = 0;
function ok(cond, label, detail) {
	if (cond) { pass++; console.log(`  ok   ${label}${detail ? "  — " + detail : ""}`); }
	else { fail++; console.log(`  FAIL ${label}${detail ? "  — " + detail : ""}`); }
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
		const t = Date.now();
		const pdf = await renderHtmlToPdf(PLAIN_HTML);
		const ms = Date.now() - t;
		ok(Buffer.isBuffer(pdf), "returns a Buffer");
		ok(pdf.slice(0, 4).toString() === "%PDF", "bytes are a PDF", `${pdf.length} bytes`);
		ok(ms < NAV, "completes inside one navigation budget", `${ms} ms`);
	}

	console.log(`\n§1  timeout WITH an event-loop stall -> retried once, succeeds`);
	{
		// Block for longer than the whole budget, so attempt 1 cannot help but
		// time out even though Chromium has the (trivial, local) page ready.
		blockLoopIn(150, NAV + 1200);
		const t = Date.now();
		let pdf = null;
		let err = null;
		try { pdf = await renderHtmlToPdf(PLAIN_HTML); } catch (e) { err = e; }
		const ms = Date.now() - t;
		ok(!err, "render SUCCEEDS despite the stall", err ? err.message.split("\n")[0] : `${ms} ms`);
		ok(pdf && pdf.slice(0, 4).toString() === "%PDF", "and the bytes are a real PDF");
		// It must have actually spent a first budget then recovered — proving the
		// retry ran, not that the stall was too short to matter.
		ok(ms > NAV, "did consume the first budget before retrying", `${ms} ms > ${NAV} ms`);
	}

	console.log(`\n§2  timeout with a HEALTHY loop -> NOT retried (no doubled hang)`);
	{
		const t = Date.now();
		let err = null;
		try { await openPageWithContent(UNSETTLEABLE_HTML); } catch (e) { err = e; }
		const ms = Date.now() - t;
		ok(!!err, "an unsettleable page still fails", err ? err.name : "no error thrown");
		// THE load-bearing assertion. One budget (plus launch/newPage slack),
		// never two. At 2x it would be the 60 s production hang.
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
