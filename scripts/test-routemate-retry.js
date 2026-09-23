#!/usr/bin/env node
/**
 * Locks two properties of lib/routemate-client.js `request()` that are pure cost
 * control — they change no result, so nothing else would ever notice them break.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * (1) NO BACKOFF AFTER THE FINAL ATTEMPT. The 5xx path used to run
 *     `await sleep(500 * 2**attempt)` and *then* re-test the loop condition, so
 *     an exhausted call slept a full 2 s and threw anyway. That is dead time on
 *     EVERY Routemate call that exhausts its retries — the telemetry 408/503
 *     flapping paid it too, not just the vehicles list.
 *
 * (2) `listVehicles()` PASSES retries: 0. GET /api/v0/assets/vehicles has
 *     returned a deterministic 500 for this account since at least 2026-05-06.
 *     The default 3 attempts spend three requests and 3.5 s of backoff to reach
 *     a failure we already know is coming, on every boot and every daily tick.
 *     The call is kept (it self-heals if Routemate fixes the endpoint) but it
 *     must cost one request, not three.
 *
 * ⚠️ TIMING ASSERTIONS ARE BOUNDED, NOT EXACT. The bands are wide and the
 * midpoint between the fixed and broken behaviour is ~2 s, so this is not a race
 * the way scripts/test-pdf-cold-start.js is. Each timing claim is ALSO backed by
 * a request COUNT, which is deterministic, and by a source assertion — so a
 * loaded machine cannot turn a real regression green or a green run red.
 *
 * Hermetic: a throwaway localhost server, no credentials, no network.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const LIB = path.join(__dirname, "..", "lib", "routemate-client.js");
const SRC = fs.readFileSync(LIB, "utf8");
const rm = require(LIB);

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
	const ok = Object.is(actual, expected);
	if (ok) { pass++; return; }
	fail++;
	failures.push(`${name}\n     expected ${JSON.stringify(expected)}\n     actual   ${JSON.stringify(actual)}`);
	console.log(`  FAIL  ${name}\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`);
}
function within(name, actual, lo, hi) {
	const ok = actual >= lo && actual <= hi;
	if (ok) { pass++; return; }
	fail++;
	failures.push(`${name}\n     expected ${lo}..${hi} ms\n     actual   ${actual} ms`);
	console.log(`  FAIL  ${name}\n          expected ${lo}..${hi} ms\n          actual   ${actual} ms`);
}

// ── §1  the source, so a timing flake can never be the only signal ──────────
console.log("\n§1  the shipped source carries both guards");
check("request() accepts a per-call `retries` override", /async function request\([^)]*\{ query, body, retries \} = \{\}\)/.test(SRC), true);
check("the loop bound honours it", /const maxRetries = Number\.isInteger\(retries\)/.test(SRC), true);
check("isLastAttempt is computed", /const isLastAttempt = attempt === maxRetries;/.test(SRC), true);
check("the 5xx path breaks instead of sleeping", (SRC.match(/if \(isLastAttempt\) break;/g) || []).length, 2);
check("listVehicles asks for no retries", /\/api\/v0\/assets\/vehicles", \{ query, retries: 0 \}/.test(SRC), true);

// ── §2  executed against a server that always 500s ─────────────────────────
const srv = http.createServer((req, res) => { srv.hits++; res.writeHead(500); res.end("boom"); });
srv.hits = 0;
srv.listen(0, "127.0.0.1", async () => {
	console.log("\n§2  a permanently-500 endpoint, executed");
	const creds = { apiKey: "test-key", baseUrl: `http://127.0.0.1:${srv.address().port}` };

	srv.hits = 0;
	let t = Date.now();
	let threw = false;
	try { await rm.listVehicles(creds); } catch { threw = true; }
	const vehiclesMs = Date.now() - t;
	check("listVehicles still throws on 500", threw, true);
	check("listVehicles costs exactly ONE request", srv.hits, 1);
	within("listVehicles does not back off at all", vehiclesMs, 0, 900);

	srv.hits = 0;
	t = Date.now();
	try { await rm.listFaultCodes(creds); } catch { /* expected */ }
	const defaultMs = Date.now() - t;
	check("a default caller still makes 3 attempts", srv.hits, 3);
	// 500 + 1000 = 1500 ms of real backoff. The old code added a trailing 2000.
	within("...and pays ~1.5 s of backoff, not ~3.5 s", defaultMs, 900, 2600);

	// ── §3  the mutant: put the trailing sleep back ────────────────────────
	// Rebuild the lib from source with the guard defanged and confirm the timing
	// assertion above is actually load-bearing rather than always-true.
	console.log("\n§3  mutant — restore the trailing backoff");
	const mutantSrc = SRC.replace(/if \(isLastAttempt\) break;/g, "if (false) break;");
	check("mutant really did defang the guard", /if \(false\) break;/.test(mutantSrc), true);
	const mod = { exports: {} };
	new Function("module", "exports", "require", mutantSrc)(mod, mod.exports, require);

	srv.hits = 0;
	t = Date.now();
	try { await mod.exports.listFaultCodes(creds); } catch { /* expected */ }
	const mutantMs = Date.now() - t;
	check("mutant makes the same 3 requests", srv.hits, 3);
	within("mutant pays the trailing 2 s the fix removed", mutantMs, 3000, 5000);
	check("mutant is materially slower than the shipped build", mutantMs > defaultMs + 1200, true);

	srv.close();
	if (failures.length) {
		console.log("\n─── failures ───");
		for (const f of failures) console.log("  " + f);
	}
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail === 0 ? 0 : 1);
});
