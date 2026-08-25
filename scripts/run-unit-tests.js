#!/usr/bin/env node
/**
 * Runs the standalone assertion runners — `scripts/test-*.js`, `scripts/test-*.mjs`
 * and `scripts/check-*.js` — and exits 1 if any of them does.
 *
 * WHY THIS EXISTS AS NODE AND NOT A SHELL LOOP
 * --------------------------------------------
 * The obvious version is `for f in scripts/test-*.js; do timeout 45 node "$f"; done`.
 * That is silently broken on a developer Mac: **macOS ships no `timeout`** (it is
 * GNU coreutils, i.e. `gtimeout` and only if brew installed it). The shell then
 * exits **127 — "command not found" — for every single test**, which reads as
 * "45 failures" and not as "the harness itself never ran". This file was written
 * after exactly that happened. Node's child_process is on every machine that can
 * run this repo at all, so the harness behaves identically on the Mac you develop
 * on and the Ubuntu runner CI uses.
 *
 * WHY IT GLOBS INSTEAD OF LISTING
 * -------------------------------
 * A hardcoded list rots — a new `scripts/test-thing.js` would be written, pass
 * locally, and never run in CI, which is worse than having no CI for it because
 * the green check implies it was covered. Anything matching the pattern is picked
 * up automatically. The cost is that a badly-behaved new runner can hang the
 * pipeline, which is what TIMEOUT_MS is for.
 *
 * WHAT IT DELIBERATELY DOES **NOT** RUN
 * ------------------------------------
 * `test-suite.js` at the repo root. That one is an HTTP harness: it needs a live
 * server, it WRITES (test 46 logs an expense), it defaults to **port 3000 — which
 * is production on the VPS** — and with no SPREADSHEET_ID override `server.js`
 * falls through to the **live Dispatch Management sheet**. Running it from CI
 * would write to the customer's real books. It lives at the repo root, outside
 * `scripts/`, so the glob below cannot reach it even by accident. Keep it that
 * way: do not "helpfully" widen the pattern to the repo root.
 *
 * Every runner in scope is hermetic — `new Database(":memory:")` or a fresh
 * `mkdtemp`, no network, no fixtures, and it does not read the real `app.db`.
 * Verified on a clean checkout with no `app.db` present: 45/45 pass in ~17 s.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const SCRIPTS_DIR = path.join(__dirname);
const REPO_ROOT = path.join(__dirname, "..");

// Generous enough for the slowest real runner (test-pdf-cold-start.js measured
// ~10.4 s because it launches Chromium) with room to spare, tight enough that a
// hung runner fails the build in a minute instead of burning the job's timeout.
const TIMEOUT_MS = Number(process.env.UNIT_TEST_TIMEOUT_MS) || 60_000;

// Serial by default. These are cheap (~17 s for all 45) and several of them
// shell out or spawn a child of their own, so a wide fan-out buys little and
// makes an interleaved failure log much harder to read.
const CONCURRENCY = Math.max(1, Number(process.env.UNIT_TEST_CONCURRENCY) || 1);

/**
 * Runners whose assertions are TIMING-SENSITIVE and therefore cannot give a
 * trustworthy signal on a contended shared CI runner.
 *
 * They still run locally — that is the point. They are skipped ONLY when
 * UNIT_TEST_SKIP_TIMING is set (CI sets it), and the skip is printed, counted
 * and repeated in the summary. It is never silent: a bounded run that reads as
 * "everything passed" is a worse lie than a red build.
 *
 * ── Why `test-pdf-cold-start.js` is here ────────────────────────────────────
 * Measured, not guessed. On an 8-core Mac:
 *   • idle machine ............ 6/6 pass
 *   • load average ~11 ........ 3/6 pass, and 4/4 fail at peak load
 *   • the failure tracked the DECAYING load average as it recovered
 * The one assertion that breaks is "the stall retry is what saved it — no retry
 * log emitted", while the timing assertions beside it still pass (render took
 * 4405 ms against a 3000 ms budget, which proves the retry did happen). So the
 * behaviour under test is correct; only the observation of it is racy.
 *
 * The test itself is good and locks a real 2026-08 production bug: the first
 * PDF after a restart 500'd because Puppeteer's navigation timeout is a
 * Node-side wall-clock timer, so a blocked event loop ate the whole budget. To
 * assert that, the test must deliberately induce an event-loop stall and catch
 * the recovery — inherently a race, and a GitHub-hosted runner is 2 shared
 * cores, i.e. more contended than the Mac where it already failed half the time.
 *
 * ⚠️ Run `npm run test:unit` locally (which does NOT skip) before touching
 * `lib/pdf-browser.js` or anything in the PDF render path. CI does not cover it.
 */
const TIMING_SENSITIVE = new Map([
	[
		"test-pdf-cold-start.js",
		"asserts on induced event-loop-stall timing; fails under CPU contention (measured 3/6 at load ~11, 6/6 idle)",
	],
]);

const SKIP_TIMING =
	/^(1|true|yes|on)$/i.test(String(process.env.UNIT_TEST_SKIP_TIMING ?? "").trim());

/**
 * Runners allowed ONE retry before they count as failed.
 *
 * ⚠️ An explicit allow-list, never a blanket retry, and the difference is the
 * whole point. Retrying everything converts a real, reproducible regression
 * into a test that "passes sometimes", which is strictly worse than no CI —
 * green stops meaning anything. A retry that succeeds is still REPORTED (as
 * FLKY) so a runner that quietly needs its retry every time cannot rot into
 * permanent failure unnoticed.
 *
 * The timing-sensitive runner above gets a retry too, for the local runs where
 * it is not skipped.
 */
const FLAKY_ALLOWED_ONE_RETRY = new Set(["test-pdf-cold-start.js"]);

function discover() {
	return fs
		.readdirSync(SCRIPTS_DIR)
		.filter((f) => /^(test|check)-.*\.(js|mjs)$/.test(f))
		// This file is the harness, not a test. Without this guard it would
		// recurse into itself — it does not match `test-`/`check-`, but say so
		// explicitly so a future rename cannot introduce a fork bomb.
		.filter((f) => f !== path.basename(__filename))
		.sort();
}

function runOne(file) {
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, file)], {
			cwd: REPO_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "test" },
		});

		let out = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (out += c));

		const timer = setTimeout(() => {
			// SIGKILL, not SIGTERM: a runner blocked on a stuck child (Chromium,
			// a socket) may never service a catchable signal, and a timeout that
			// itself hangs is indistinguishable from the hang it was meant to cap.
			child.kill("SIGKILL");
		}, TIMEOUT_MS);

		child.on("close", (code, signal) => {
			clearTimeout(timer);
			const ms = Date.now() - started;
			const timedOut = signal === "SIGKILL" && ms >= TIMEOUT_MS - 250;
			resolve({
				file,
				ms,
				timedOut,
				ok: code === 0 && !timedOut,
				code: code === null ? `signal:${signal}` : code,
				out,
			});
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({
				file,
				ms: Date.now() - started,
				timedOut: false,
				ok: false,
				code: "spawn-error",
				out: String(err && err.stack ? err.stack : err),
			});
		});
	});
}

async function main() {
	const files = discover();
	if (files.length === 0) {
		// A glob that matches nothing must fail loudly. A silent zero-test pass is
		// the single worst outcome here: the pipeline goes green having verified
		// nothing, which is a stronger false signal than having no pipeline.
		console.error("FAIL: no runners matched scripts/{test,check}-*.{js,mjs}");
		process.exit(1);
	}

	const skipped = SKIP_TIMING ? files.filter((f) => TIMING_SENSITIVE.has(f)) : [];
	const toRun = files.filter((f) => !skipped.includes(f));

	console.log(
		`Running ${toRun.length} standalone runners (timeout ${TIMEOUT_MS / 1000}s each)` +
			(skipped.length ? `, skipping ${skipped.length} timing-sensitive` : "") +
			"\n"
	);
	for (const f of skipped) {
		console.log(`SKIP        —  ${f}\n            reason: ${TIMING_SENSITIVE.get(f)}`);
	}

	const results = [];
	const queue = [...toRun];

	async function worker() {
		while (queue.length) {
			const file = queue.shift();
			let r = await runOne(file);

			// One retry, and only for a runner on the measured allow-list above.
			if (!r.ok && FLAKY_ALLOWED_ONE_RETRY.has(file)) {
				const first = r;
				r = await runOne(file);
				// Keep the first failure's output either way: if the retry passes,
				// this is the only record of what the flake actually looked like,
				// and if the retry also fails it is the evidence that it was not
				// a flake at all.
				r.firstAttempt = first;
				r.retried = true;
			}

			results.push(r);
			const mark = r.ok ? (r.retried ? "FLKY" : "ok  ") : r.timedOut ? "TIME" : "FAIL";
			const note = r.ok && r.retried ? "  (failed once, passed on retry)" : "";
			console.log(`${mark}  ${String(r.ms).padStart(6)}ms  ${r.file}${note}`);
		}
	}

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

	const failed = results.filter((r) => !r.ok);

	if (failed.length) {
		console.log(`\n${"=".repeat(64)}\nFAILURE OUTPUT\n${"=".repeat(64)}`);
		for (const r of failed) {
			const why = r.timedOut ? `TIMED OUT after ${TIMEOUT_MS / 1000}s` : `exit ${r.code}`;
			console.log(`\n--- ${r.file} (${why}) ---`);
			console.log(r.out.trimEnd() || "(no output)");
		}
	}

	// A flake that passed on retry is still surfaced. It does not fail the build,
	// but it is never silent — a runner quietly needing its retry every single
	// time has stopped being flaky and started being broken, and the only way to
	// notice that is to keep printing it.
	const flaked = results.filter((r) => r.ok && r.retried);
	if (flaked.length) {
		console.log(`\n${"-".repeat(64)}`);
		for (const r of flaked) {
			console.log(`FLAKY: ${r.file} failed once, passed on retry. First-attempt output:`);
			console.log((r.firstAttempt.out || "").trimEnd().split("\n").slice(-12).join("\n"));
		}
	}

	const total = results.reduce((a, r) => a + r.ms, 0);
	console.log(
		`\n${results.length - failed.length}/${results.length} passed in ${(total / 1000).toFixed(1)}s` +
			(flaked.length ? ` — ${flaked.length} flaky (passed on retry)` : "") +
			(failed.length ? ` — ${failed.length} FAILED` : "")
	);

	// Repeat the skip at the END too. The header scrolls off in a CI log and the
	// last line is the one anyone actually reads — a bounded run must not be
	// able to look like a complete one.
	if (skipped.length) {
		console.log(
			`\n⚠️  ${skipped.length} timing-sensitive runner(s) NOT covered by this run: ${skipped.join(", ")}` +
				`\n    They are skipped because UNIT_TEST_SKIP_TIMING is set (CI sets it). Run` +
				`\n    \`npm run test:unit\` locally — without that variable — to cover them.`
		);
	}

	process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
