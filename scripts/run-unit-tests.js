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
 * is production on the VPS** — and whatever sheet its target server uses is the
 * one it writes (it refuses the production sheet by ID, but cannot see which
 * sheet a running server holds). Running it from CI could write to the
 * customer's real books. It lives at the repo root, outside
 * `scripts/`, so the glob below cannot reach it even by accident. Keep it that
 * way: do not "helpfully" widen the pattern to the repo root.
 *
 * Every runner in scope is hermetic — `new Database(":memory:")` or a fresh
 * `mkdtemp`, no network, no fixtures, and it does not read the real `app.db`.
 *
 * SEVERAL AT A TIME, SO EVERY RUNNER MUST BE ISOLATED
 * ---------------------------------------------------
 * Runners run CONCURRENCY at a time (below), so no runner may share
 * anything with another: temp files and directories come from `mkdtemp` (or
 * carry the pid), databases are `:memory:` or inside that temp directory,
 * servers listen on port 0, and nothing is written into the repo tree.
 * Audited 2026-10-08 (the 182 runners that existed then): every node process each runner
 * started was traced for file writes, SQLite opens, listen() calls and child
 * processes, the repo tree was checked for new files afterwards, and the
 * runners were grepped for fixed temp paths and ports. No shared file, port or
 * database was found; the suite then passed 3/3 at 4 at a time. Serial it took
 * ~240 s on an M-series Mac, 4 at a time ~70 s.
 *
 * IN PARTS, FOR CI
 * ----------------
 * UNIT_TEST_SHARD=i/n runs part i of n, and CI runs the parts as parallel jobs.
 * The runners, in sorted order, are dealt round-robin (the 1st, the n+1st, …
 * to part 1), so every runner is in exactly one part and the slow ones spread
 * out. `--list` prints the runners a run would start and starts none;
 * scripts/test-release-gate.js §4 reads it to prove the parts cover every
 * runner once.
 *
 * PRE-PUSH MODE
 * -------------
 * .githooks/pre-push runs this file inside its sandbox (sandbox-exec, a
 * scrubbed environment) as
 *   node scripts/run-unit-tests.js --lint --changed-list <file>
 *     --changed-count <n> --server-diff <file> --budget-ms <ms> [--full]
 * --lint runs package.json's lint script first. --changed-list is the push's
 * changed files (NUL-separated, written by the hook from git, outside the
 * sandbox), --changed-count how many the hook wrote, --server-diff
 * `git diff -U0 <merge-base> -- server.js`. scripts/lib/test-selection.js
 * picks the runners those files reach and runs them in tiers inside
 * --budget-ms: tier 0 (changed runners, the timing-sensitive ones) always
 * finishes; a tier 1-3 runner that doesn't fit is "not run for time" and one
 * still going at the budget is "cut off", neither a failure (CI runs them).
 * --full runs every runner with no budget. Workers: the cores less one, less
 * the 1-minute load average, at least 2 (UNIT_TEST_CONCURRENCY overrides).
 * Each run saves its runners' times to $TMPDIR/logisx-prepush-times-<repo>.json
 * (numbers only) for the next run's estimates; an estimate is never more than
 * the runner's timeout (twice that for the runner allowed a retry).
 * The last line is the verdict the hook reads:
 *   pre-push verdict: lint=<pass|fail|skipped> selection=<...> runners=<...>
 * and the exit code is 0 only when nothing in it failed. UNIT_TEST_SHARD and
 * UNIT_TEST_SKIP_TIMING mean nothing here and are ignored.
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPTS_DIR = path.join(__dirname);
const REPO_ROOT = path.join(__dirname, "..");

// Generous enough for the slowest real runner (test-pdf-cold-start.js measured
// ~10.4 s because it launches Chromium) with room to spare, tight enough that a
// hung runner fails the build in a minute instead of burning the job's timeout.
const TIMEOUT_MS = Number(process.env.UNIT_TEST_TIMEOUT_MS) || 60_000;

// One runner per core, less one for the harness and the processes runners
// start, and never fewer than 4: CI's 4-vCPU runner keeps the 4 at a time the
// audit above ran at, and a machine with more cores uses them. Not more than
// the cores: measured 2026-10-21 on 4 cores, 6 and 8 at a time took longer than 4
// (198 s against 193 s) and the deploy runners hit TIMEOUT_MS.
// UNIT_TEST_CONCURRENCY=1 runs them one by one. Each runner's output is
// buffered and printed whole, so parallel runs never interleave.
// Timing-sensitive runners (below) never share the machine: they run alone,
// one by one, after every other runner has finished.
const CONCURRENCY = Math.max(1, Number(process.env.UNIT_TEST_CONCURRENCY) || Math.max(4, os.availableParallelism() - 1));

// .githooks/pre-push checks for this exact line before it uses the PRE-PUSH
// MODE flags; a harness without it gets the whole suite instead (a worktree
// branched before the mode existed).
const PREPUSH_PROTOCOL = 1;
const PREPUSH_FLAGS = new Set(["--lint", "--full", "--changed-list", "--changed-count", "--server-diff", "--budget-ms"]);
const PREPUSH = process.argv.slice(2).some((a) => PREPUSH_FLAGS.has(a));

// UNIT_TEST_SHARD=i/n (see IN PARTS, above). Unset or empty: every runner.
// Anything else that is not i/n with 1 <= i <= n stops the run: a typo must not
// quietly run the wrong part, or none.
function shardOf(value) {
	const raw = String(value ?? "").trim();
	if (!raw) return null;
	const m = /^(\d+)\/(\d+)$/.exec(raw);
	const i = m ? Number(m[1]) : 0;
	const n = m ? Number(m[2]) : 0;
	if (!(n >= 1 && i >= 1 && i <= n)) {
		console.error(`FAIL: UNIT_TEST_SHARD must be i/n with 1 <= i <= n (got ${JSON.stringify(raw)})`);
		process.exit(1);
	}
	return { i, n };
}
const SHARD = PREPUSH ? null : shardOf(process.env.UNIT_TEST_SHARD);

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
 * It launches Chromium and asserts on wall-clock budgets (a 3 s navigation
 * budget, "one budget, not two") around an induced event-loop stall, which a
 * GitHub-hosted runner's two shared cores can't be trusted to keep.
 *
 * Its old flake was a race inside its §1, not machine load (diagnosed
 * 2026-10-11; this note used to blame load). "The stall retry is what saved it
 * — no retry log emitted" failed at ~4390 ms, the stall's end: the trivial page
 * had settled during the stall, so when the loop came back the overdue
 * navigation timer and Chromium's queued "settled" message raced, and the
 * message won. No timeout, so no retry: the module was right, the test wasn't.
 * Measured before the fix on a 15-core Mac: 10/14 pass idle, 14/14 beside 30
 * CPU-spinning processes. §1 now holds its page's stylesheet until the stall
 * ends and starts the stall from Puppeteer's own timer: 12/12 idle, 12/12
 * beside the 30 spinners.
 *
 * The test itself is good and locks a real 2026-08 production bug: the first
 * PDF after a restart 500'd because Puppeteer's navigation timeout is a
 * Node-side wall-clock timer, so a blocked event loop ate the whole budget. To
 * assert that, the test must deliberately induce an event-loop stall and catch
 * the recovery.
 *
 * ⚠️ Run `npm run test:unit` locally (which does NOT skip) before touching
 * `lib/pdf-browser.js` or anything in the PDF render path. CI does not cover it.
 */
const TIMING_SENSITIVE = new Map([
	[
		"test-pdf-cold-start.js",
		"launches Chromium and asserts on wall-clock budgets around an induced event-loop stall; CI's two shared cores can't be trusted to keep them",
	],
]);

const SKIP_TIMING = !PREPUSH &&
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

/**
 * Runners that can only run on some machines and skip themselves elsewhere.
 * Such a runner prints a line starting "SKIP (platform):" and exits 0. The
 * harness then reports it as SKIP, not ok, and repeats it after the summary
 * like the timing skip: a run that covered less must not read as complete.
 * Only the runners named here may skip; anyone else printing the line still
 * counts as a plain pass.
 */
const PLATFORM_SKIP = new Map([
	[
		"test-prepush-sandbox.js",
		"needs macOS and runs /usr/bin/sandbox-exec itself, which no sandbox around it allows (CI runs Linux; the pre-push hook and Claude's Bash sandbox are sandboxes). Run it from a plain terminal: node scripts/test-prepush-sandbox.js",
	],
]);
const PLATFORM_SKIP_LINE = /^SKIP \(platform\): /m;
const skippedForPlatform = (r) => r.ok && PLATFORM_SKIP.has(r.file) && PLATFORM_SKIP_LINE.test(r.out || "");

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
	return startOne(file).done;
}

// One runner, with a way to stop it early (the pre-push budget's cut-off).
function startOne(file) {
	let child = null;
	const done = new Promise((resolve) => {
		const started = Date.now();
		child = spawn(process.execPath, [path.join(SCRIPTS_DIR, file)], {
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
	return { done, kill: () => child && child.kill("SIGKILL") };
}

async function main() {
	const started = Date.now();
	const all = discover();
	// Dealt before the timing skip, so a part holds the same runners whatever
	// the environment.
	const files = SHARD ? all.filter((_, k) => k % SHARD.n === SHARD.i - 1) : all;
	if (files.length === 0) {
		// A glob that matches nothing must fail loudly. A silent zero-test pass is
		// the single worst outcome here: the pipeline goes green having verified
		// nothing, which is a stronger false signal than having no pipeline.
		console.error(SHARD
			? `FAIL: part ${SHARD.i} of ${SHARD.n} holds no runners (${all.length} found in all)`
			: "FAIL: no runners matched scripts/{test,check}-*.{js,mjs}");
		process.exit(1);
	}

	const skipped = SKIP_TIMING ? files.filter((f) => TIMING_SENSITIVE.has(f)) : [];
	const toRun = files.filter((f) => !skipped.includes(f));

	// Never process.exit() after printing more than one short line: once the
	// pipe to a slow reader is full, Node holds the rest of stdout, and exit
	// drops it. (The error exits here print one short line, which fits.) On a
	// loaded CI machine that cut this list short (release-gate §4 read 189 of
	// 328, 2026-10-21). Returning lets Node flush stdout before the process ends.
	if (process.argv.includes("--list")) {
		process.stdout.write(toRun.map((f) => `${f}\n`).join(""));
		return;
	}

	console.log(
		`Running ${toRun.length} standalone runners` +
			(SHARD ? ` (part ${SHARD.i} of ${SHARD.n}; ${all.length} in all)` : "") +
			`, ${CONCURRENCY} at a time (timeout ${TIMEOUT_MS / 1000}s each)` +
			(skipped.length ? `, skipping ${skipped.length} timing-sensitive` : "") +
			"\n"
	);
	for (const f of skipped) {
		console.log(`SKIP        —  ${f}\n            reason: ${TIMING_SENSITIVE.get(f)}`);
	}

	const results = [];
	// The timing-sensitive runners wait for the pool to drain, then run alone:
	// their assertions measure the event loop, and three other runners beside
	// them is exactly the load that breaks them.
	const alone = toRun.filter((f) => TIMING_SENSITIVE.has(f));
	let queue = toRun.filter((f) => !TIMING_SENSITIVE.has(f));

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
			console.log(resultLine(r));
		}
	}

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, worker));
	queue = alone;
	await worker();

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

	// Both clocks: the runners' own times added up, and how long this run took.
	const total = results.reduce((a, r) => a + r.ms, 0);
	console.log(
		`\n${results.length - failed.length}/${results.length} passed in ${(total / 1000).toFixed(1)}s of runner time, ${((Date.now() - started) / 1000).toFixed(1)}s wall` +
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
	printPlatformSkips(results);

	// exitCode, not process.exit(): the failure output above must reach the log
	// whole (see --list).
	process.exitCode = failed.length ? 1 : 0;
}

function resultLine(r) {
	const mark = r.cut ? "CUT " : skippedForPlatform(r) ? "SKIP" : r.ok ? (r.retried ? "FLKY" : "ok  ") : r.timedOut ? "TIME" : "FAIL";
	const note = r.cut ? "  (cut off at the time budget; CI runs it)"
		: skippedForPlatform(r) ? `  (${r.out.split("\n").find((l) => PLATFORM_SKIP_LINE.test(l))})`
			: r.ok && r.retried ? "  (failed once, passed on retry)" : "";
	return `${mark}  ${String(r.ms).padStart(6)}ms  ${r.file}${note}`;
}

// Repeated after the summary, like the timing skip.
function printPlatformSkips(results) {
	const skippedHere = results.filter(skippedForPlatform);
	if (!skippedHere.length) return;
	console.log(
		`\n⚠️  ${skippedHere.length} runner(s) skipped themselves on this machine, NOT covered by this run:` +
			skippedHere.map((r) => `\n    ${r.file}: ${PLATFORM_SKIP.get(r.file)}`).join("")
	);
}

// ─────────────────────────────────────────────── PRE-PUSH MODE (see header)
function parsePrepushArgs(argv) {
	const a = { lint: false, full: false, changedList: null, changedCount: null, serverDiff: null, budgetMs: 115000 };
	const value = (i, flag) => {
		const v = argv[i + 1];
		if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
		return v;
	};
	for (let i = 0; i < argv.length; i++) {
		const f = argv[i];
		if (f === "--lint") a.lint = true;
		else if (f === "--full") a.full = true;
		else if (f === "--changed-list") a.changedList = value(i++, f);
		else if (f === "--server-diff") a.serverDiff = value(i++, f);
		else if (f === "--changed-count" || f === "--budget-ms") {
			const n = Number(value(i++, f));
			if (!Number.isInteger(n) || n < 0) throw new Error(`${f} must be a whole number (got ${JSON.stringify(argv[i])})`);
			if (f === "--changed-count") a.changedCount = n; else a.budgetMs = n;
		} else throw new Error(`unknown argument ${JSON.stringify(f)}`);
	}
	if (!a.full && a.changedList === null) throw new Error("--changed-list is required unless --full");
	if (!a.full && a.changedCount === null) throw new Error("--changed-count is required with --changed-list");
	return a;
}

// package.json's lint script, run as npm would run it (sh -c), without npm:
// one definition of what lint covers.
function runLint() {
	return new Promise((resolve) => {
		const started = Date.now();
		let script;
		try {
			script = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).scripts.lint;
		} catch (err) {
			resolve({ ok: false, ms: 0, out: `can't read package.json's lint script: ${err.message}` });
			return;
		}
		if (typeof script !== "string" || !script.trim()) {
			resolve({ ok: false, ms: 0, out: "package.json has no lint script" });
			return;
		}
		const child = spawn("/bin/sh", ["-c", script], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env });
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (out += c));
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, ms: Date.now() - started, out }); });
		child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, ms: Date.now() - started, out: String(err) }); });
	});
}

function timesCachePath() {
	let name = path.basename(REPO_ROOT);
	const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	});
	if (r.status === 0 && r.stdout.trim()) name = path.basename(path.dirname(r.stdout.trim()));
	return path.join(os.tmpdir(), `logisx-prepush-times-${name.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

// Estimates only: an unreadable cache is a note, never a failure.
function readTimes(file, notes) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (err.code !== "ENOENT") notes.push(`times cache unreadable (${err.code || err.message}); every runner counts as the median`);
		return new Map();
	}
	try {
		const obj = JSON.parse(raw);
		const out = new Map();
		for (const [k, v] of Object.entries(obj && typeof obj === "object" ? obj : {})) {
			if (/^(?:test|check)-[^/]*\.(?:js|mjs)$/.test(k) && Number.isFinite(v) && v >= 0) out.set(k, v);
		}
		return out;
	} catch (err) {
		notes.push(`times cache unreadable (${err.message}); every runner counts as the median`);
		return new Map();
	}
}

// The longest a runner can take: it is killed at TIMEOUT_MS, and the one
// allowed a retry gets two tries. No estimate is longer, whatever the cache
// says.
function estimateCap(file) {
	return (FLAKY_ALLOWED_ONE_RETRY.has(file) ? 2 : 1) * TIMEOUT_MS;
}

function writeTimes(file, times, notes) {
	try {
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries([...times].sort())));
		fs.renameSync(tmp, file);
	} catch (err) {
		notes.push(`times cache not saved (${err.code || err.message})`);
	}
}

function changedFromList(args) {
	let raw;
	try {
		raw = fs.readFileSync(args.changedList);
	} catch (err) {
		throw new Error(`can't read the changed list ${args.changedList} (${err.code || err.message})`);
	}
	const changed = raw.toString("utf8").split("\0").filter(Boolean);
	if (changed.length !== args.changedCount) {
		throw new Error(`the changed list holds ${changed.length} file(s), the hook wrote ${args.changedCount}`);
	}
	let serverDiff = "";
	if (args.serverDiff !== null) {
		try {
			serverDiff = fs.readFileSync(args.serverDiff, "utf8");
		} catch (err) {
			throw new Error(`can't read the server.js diff ${args.serverDiff} (${err.code || err.message})`);
		}
	}
	return { changed: [...new Set(changed)], serverDiff };
}

async function prepushMain() {
	const started = Date.now();
	const verdict = { lint: "skipped", selection: "skipped", runners: "skipped" };
	const notes = [];
	let sel = null;
	const say = (line) => console.log(line);
	const finish = () => {
		for (const n of notes) say(`note: ${n}`);
		const line = sel ? sel.verdictLine(verdict) : `pre-push verdict: lint=${verdict.lint} selection=${verdict.selection} runners=${verdict.runners}`;
		say(line);
		process.exitCode = Object.values(verdict).some((v) => v === "fail") ? 1 : 0;
	};

	let args;
	try {
		args = parsePrepushArgs(process.argv.slice(2));
	} catch (err) {
		say(`pre-push mode: ${err.message}`);
		verdict.selection = "fail";
		finish();
		return;
	}

	if (args.lint) {
		const lint = await runLint();
		verdict.lint = lint.ok ? "pass" : "fail";
		say(`lint: ${lint.ok ? "passed" : "FAILED"} in ${(lint.ms / 1000).toFixed(1)} s`);
		if (!lint.ok) {
			say(lint.out.trimEnd() || "(no output)");
			say("Runners not started: the push is blocked on lint alone.");
			finish();
			return;
		}
	}

	const all = discover();
	let items;
	try {
		sel = require("./lib/test-selection");
		if (args.full) {
			items = all.map((f) => ({ file: f, tier: 0 }));
			say(`Full run: every runner (${all.length}), no time budget.`);
		} else {
			const { changed, serverDiff } = changedFromList(args);
			const ls = spawnSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard"], {
				cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			});
			if (ls.status !== 0) throw new Error(`git ls-files failed: ${(ls.stderr || "").trim() || `exit ${ls.status}`}`);
			const read = (rel) => {
				try { return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"); } catch { return null; }
			};
			const map = sel.buildMap({ files: ls.stdout.split("\0").filter(Boolean), read });
			const s = sel.select(map, { changed, serverDiff, tierZero: [...TIMING_SENSITIVE.keys()].map((f) => `scripts/${f}`) });
			items = [...s.picked].map(([rel, tier]) => ({ file: path.basename(rel), tier }));
			const missing = items.filter((it) => !all.includes(it.file));
			if (missing.length) throw new Error(`picked runner(s) not on disk: ${missing.map((it) => it.file).join(", ")}`);
			const perTier = [0, 1, 2, 3].map((t) => items.filter((it) => it.tier === t).length);
			say(`${changed.length} changed file(s) pick ${items.length} of ${all.length} runners (tier 0: ${perTier[0]}, 1: ${perTier[1]}, 2: ${perTier[2]}, 3: ${perTier[3]})` +
				(s.runAll ? `; ${s.runAll} changed, so every runner is picked` : "") +
				(s.server && s.server.top ? `; a top-level server.js change (${s.server.why[0] || "unread"}) picks every runner that names server.js` : ""));
		}
		verdict.selection = "pass";
	} catch (err) {
		verdict.selection = "fail";
		say(`selection FAILED: ${err && err.message ? err.message : err}`);
		say("The push is blocked: nothing can say which runners this push needs. LOGISX_PREPUSH=full git push runs every runner instead.");
		finish();
		return;
	}

	const cacheFile = timesCachePath();
	const times = readTimes(cacheFile, notes);
	const known = [...times.values()].sort((x, y) => x - y);
	const median = known.length ? known[Math.floor(known.length / 2)] : 1000;
	for (const it of items) it.est = Math.min(times.has(it.file) ? times.get(it.file) : median, estimateCap(it.file));
	const explicit = Number(process.env.UNIT_TEST_CONCURRENCY);
	const workers = explicit >= 1 ? Math.floor(explicit) : sel.workersFor(os.availableParallelism(), os.loadavg()[0]);
	const budgetMs = args.full ? Infinity : args.budgetMs;
	const tier0 = items.filter((it) => it.tier === 0).reduce((a, it) => a + it.est, 0);
	if (!args.full && tier0 / Math.max(1, workers) > 120000) {
		say(`Tier 0 alone is estimated at ${Math.round(tier0 / Math.max(1, workers) / 1000)} s, over the 2-minute budget; it runs to the end anyway.`);
	}
	say(`Running ${items.length} runner(s), ${workers} at a time (timeout ${TIMEOUT_MS / 1000}s each)` +
		(Number.isFinite(budgetMs) ? `, budget ${Math.round(budgetMs / 1000)} s for tiers 1-3` : "") + "\n");

	const run = await sel.runTiered({
		items,
		workers,
		budgetMs,
		startedAt: started,
		start: startOne,
		alone: new Set([...TIMING_SENSITIVE.keys()]),
		retryOnce: FLAKY_ALLOWED_ONE_RETRY,
		onResult: (r) => say(resultLine(r)),
	});
	const t = sel.tally(run);

	if (t.failedResults.length) {
		say(`\n${"=".repeat(64)}\nFAILURE OUTPUT\n${"=".repeat(64)}`);
		for (const r of t.failedResults) {
			say(`\n--- ${r.file} (${r.timedOut ? `TIMED OUT after ${TIMEOUT_MS / 1000}s` : `exit ${r.code}`}) ---`);
			say(r.out.trimEnd() || "(no output)");
		}
	}
	for (const r of run.results.filter((x) => x.ok && x.retried)) {
		say(`\nFLAKY: ${r.file} failed once, passed on retry. First-attempt output:`);
		say((r.firstAttempt.out || "").trimEnd().split("\n").slice(-12).join("\n"));
	}
	if (run.notRun.length) say(`\nNot run for time (CI runs them): ${run.notRun.map((it) => it.file).join(", ")}`);
	if (run.cut.length) say(`Cut off at the budget (CI runs them): ${run.cut.map((r) => r.file).join(", ")}`);
	printPlatformSkips(run.results);

	for (const r of run.results) times.set(r.file, r.cut ? Math.max(times.get(r.file) || 0, r.ms) : r.ms);
	writeTimes(cacheFile, times, notes);

	verdict.runners = t.passed ? "pass" : "fail";
	say("\n" + sel.summaryLine({ ran: t.ran, picked: items.length, seconds: (Date.now() - started) / 1000, notRun: t.notRun, cut: t.cut, failed: t.failed }));
	finish();
}

(PREPUSH ? prepushMain() : main()).catch((err) => {
	console.error(err);
	if (PREPUSH) console.log("pre-push verdict: lint=fail selection=fail runners=fail");
	process.exit(1);
});
