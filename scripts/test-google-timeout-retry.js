#!/usr/bin/env node
/**
 * Locks the ONE behaviour that makes `google.options({ timeout })` in server.js
 * worth having: a Google API request that times out must be RETRIED, not failed.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * On 2026-08-06 the dashboard stalled ~150 s because a request was handed to a
 * half-open pooled socket and nothing bounded it but the kernel's retransmission
 * budget. The fix was `google.options({ timeout: GOOGLE_API_TIMEOUT_MS })`, and
 * it only works because of an implementation detail two layers down:
 *
 *   gaxios 6  ->  node-fetch v2  ->  `timeout` raises a plain FetchError
 *                                    ('network timeout at: ...')
 *   gaxios classifies that as a NO-RESPONSE error and retries it.
 *
 * ⚠️ THIS IS NOT PORTABLE ACROSS A googleapis MAJOR. Measured 2026-08-25 against
 * a server that accepts the connection and never responds:
 *
 *   gaxios 6.7.1 (googleapis 128, current)  -> 4 requests  = retried
 *   gaxios 7.3.1 (googleapis 176, "the fix") -> 1 request  = NOT retried
 *
 * gaxios 7 moved to node-fetch v3, which removed `timeout`, and reimplemented it
 * as `AbortSignal.timeout()`. The resulting abort is not classified as a
 * retryable no-response error. So bumping googleapis would leave the timeout
 * *looking* configured while silently converting "retry three times" into "fail
 * the user's page on the first blip" — the opposite of what the option is for,
 * and a quiet return of the 150 s hang class of bug.
 *
 * That is why `package.json` pins uuid through `overrides` instead of taking
 * npm's advised `googleapis 128 -> 176`: all four moderate advisories traced to
 * uuid alone, and gaxios only ever calls `uuid.v4()`.
 *
 * If this test fails, someone bumped googleapis (or gaxios) and the timeout
 * layer needs rewriting BEFORE the bump lands — do not just delete the test.
 *
 * Hermetic: binds a throwaway server on 127.0.0.1:0. No network, no
 * credentials, no Google, no app.db.
 */

const http = require("http");
const assert = require("assert");

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
	if (cond) {
		passed++;
		console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`);
	} else {
		failed++;
		console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`);
	}
}

async function main() {
	console.log("\n§1  a timed-out Google request must be RETRIED, not failed\n");

	let hits = 0;
	const server = http.createServer(() => {
		hits++; // accept the connection, never respond — the half-open socket shape
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;

	const { request } = require("gaxios");
	const started = Date.now();
	let err = null;
	try {
		await request({
			url: `http://127.0.0.1:${port}/probe`,
			timeout: 300,
			// Mirror gaxios' own defaults for a no-response failure; the point of
			// the test is the CLASSIFICATION of the error, not the retry count.
			retryConfig: { retry: 3, noResponseRetries: 3, retryDelay: 20 },
		});
	} catch (e) {
		err = e;
	}
	const elapsed = Date.now() - started;
	server.close();

	check("the request failed (the server never responds)", err !== null);

	// The load-bearing assertion. >1 hit means gaxios treated the timeout as a
	// retryable no-response error and issued fresh requests.
	check(
		"the timeout was RETRIED, not surfaced on the first attempt",
		hits > 1,
		`${hits} request(s) reached the server` +
			(hits <= 1
				? "  <-- googleapis/gaxios changed its timeout classification; read this file's header"
				: "")
	);

	// node-fetch v2 raises 'network timeout at: <url>'. gaxios 7 / node-fetch v3
	// raises 'The operation was aborted'. Assert on the shape so the diagnosis is
	// in the failure output rather than something to rediscover.
	const msg = String((err && err.message) || "");
	check(
		"the error is a no-response timeout, not an abort",
		/network timeout/i.test(msg),
		JSON.stringify(msg.slice(0, 60))
	);
	if (/abort/i.test(msg)) {
		console.log(
			"       ^ 'aborted' means AbortSignal.timeout() — the gaxios 7+ shape, which is NOT retried."
		);
	}

	check("it spent real time retrying", elapsed > 300, `${elapsed} ms`);

	console.log("\n§2  the uuid override is actually in effect\n");

	// All four moderate advisories on this package traced to uuid <11.1.1.
	const uuidVersion = require("uuid/package.json").version;
	const major = Number(uuidVersion.split(".")[0]);
	const minor = Number(uuidVersion.split(".")[1]);
	const patch = Number(uuidVersion.split(".")[2]);
	const patched =
		major > 11 || (major === 11 && (minor > 1 || (minor === 1 && patch >= 1)));
	check("uuid resolves to a patched version (>= 11.1.1)", patched, uuidVersion);

	// gaxios uses uuid for exactly one thing: the multipart boundary. If the
	// override ever broke that entry point, multipart uploads would fail.
	const uuid = require("uuid");
	check("uuid still exports v4() for CommonJS", typeof uuid.v4 === "function");
	check(
		"v4() returns a well-formed uuid",
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid.v4())
	);

	console.log(`\n${passed} passed, ${failed} failed\n`);
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	console.error("harness error:", e);
	process.exit(1);
});
