#!/usr/bin/env node
/**
 * Locks the STAGING GATE on deploy-drift.yml's heal (scripts/deploy/drift-gate.js).
 *
 * WHY IT EXISTS. A drift heal may deploy only a commit whose own staging job
 * passed, and the box cannot see staging's verdict, so the gate asks GitHub.
 * Each property below is a way the gate could quietly stop gating:
 *
 *   §1 the state → action table: only `behind-healable` heals, only
 *      `behind-staging-unreached` re-runs, and anything unknown (unparseable
 *      ssh output) ALARMS rather than heals; every state has its own hint
 *   §2 refineState(): the staging verdict can only narrow a heal, never create
 *      one, and never override the box's own alarms; a staging job that never
 *      reached the VPS is re-run only on its Deploy run's FIRST attempt
 *   §3 stagingVerdict(): success is the ONLY passing verdict; the newest run
 *      wins; a run for some OTHER commit can never approve this one; only a
 *      failed staging job carrying ssh-retry.sh's give-up annotation (the REAL
 *      shapes, untitled and titled) reads as `unreached`
 *   §4 lookupStaging(): the exact API calls, retry on 5xx/429 only, fatal on
 *      4xx; annotations are read only for a FAILED staging job, and when they
 *      cannot be read the verdict stays `failed`
 *   §5 decide(): every failure path is fail-closed (unverified), never a heal
 *   §6 the CLI end to end against a local fake GitHub API, including the
 *      $GITHUB_OUTPUT contract deploy-drift.yml reads
 *   §7 source pins — the workflow files and the gate agree (job name,
 *      concurrency group, queue: max, the heal's rollback, the retry helper);
 *      no workflow or action puts an expression inside a run: script or uses a
 *      bare `ssh -i`; backup-freshness.yml uses the shared ssh helpers under
 *      its OWN concurrency group and its remote half never takes the deploy
 *      lock; every action the gate can emit is acted on; only the rerun job
 *      may write, and the workflow reads checks; every box state
 *      remote-drift-check.sh can print has its own entry in the gate
 *   §8 mutants — a gate that heals on a staging failure, trusts a run for
 *      another commit, re-runs every staging failure or ignores the attempt
 *      count, and a rerun job without its guards, must all be caught above
 *   §9 the rerun job's own script, run against a stub `gh`: one re-run
 *      request, and none when the run moved since the check or the id is
 *      not a number
 *
 * Hermetic: no network beyond a 127.0.0.1 server it starts itself, no secrets.
 * Run: node scripts/test-drift-gate.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const GATE_PATH = path.join(__dirname, "deploy", "drift-gate.js");
const gate = require(GATE_PATH);

const failures = [];
let pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const run = (id, extra = {}) => ({ id, event: "push", head_sha: SHA, status: "completed", conclusion: "success", run_attempt: 1, html_url: `https://x/runs/${id}`, ...extra });
const job = (name, status, conclusion, extra = {}) => ({ name, status, conclusion, html_url: `https://x/jobs/${name}`, ...extra });

// ── Check-run annotations, in the REAL shape. REAL_UNREACHED_UNTITLED is the
// staging job of Deploy run 35893362159, attempt 1 (check run 107291060814),
// read 2026-09-24. Run 35889318742's staging job (107277471140) carried the
// identical set. It is the form ssh-retry.sh printed before its give-up line
// had a title, so a Deploy run from before the title must still classify.
const ann = (level, message, line, title = "") => ({ path: ".github", start_line: line, end_line: line, annotation_level: level, title, message, raw_details: "" });
const REAL_UNREACHED_UNTITLED = [
	ann("failure", "Process completed with exit code 255.", 52),
	ann("failure", "ssh failed to connect after 5 attempts — runner→VPS network, not the deploy", 51),
	ann("warning", "ssh transport failure (255), attempt 4/5 — retrying in 90s", 49),
	ann("warning", "ssh transport failure (255), attempt 3/5 — retrying in 60s", 47),
	ann("warning", "ssh transport failure (255), attempt 2/5 — retrying in 30s", 45),
	ann("warning", "ssh transport failure (255), attempt 1/5 — retrying in 15s", 43),
	ann("notice", "\"The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026. For more information, see https://github.com/actions/runner-images/issues/14748\"", 1),
];
// The same job as ssh-retry.sh reports it now: the give-up line carries a title.
const REAL_UNREACHED_TITLED = REAL_UNREACHED_UNTITLED.map((a) => (a.message.startsWith("ssh failed to connect") ? { ...a, title: "VPS unreachable" } : a));
// A staging job that failed for a REAL reason: the deploy or smoke script said no.
const REAL_FAILURE = [ann("failure", "Process completed with exit code 1.", 40), REAL_UNREACHED_UNTITLED[6]];
// ssh dropped twice, got through on the third attempt, then the deploy failed
// for real. Its warnings are not the give-up line.
const RETRIED_THEN_FAILED = [
	ann("failure", "Process completed with exit code 1.", 44),
	REAL_UNREACHED_UNTITLED[4],
	REAL_UNREACHED_UNTITLED[5],
];
const STAGING_ID = 501;
const failedStaging = (conclusion = "failure") => [job("staging", "completed", conclusion, { id: STAGING_ID }), job("production", "completed", "skipped", { id: STAGING_ID + 1 })];

// Comment-stripped workflow text. A `#` only starts a comment at the start of
// a line or after whitespace, which is how YAML and bash both read it.
function noComments(s) {
	return s.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
}

// ────────────────────────────────────────────────────── §1 state → action table
function checkActionTable(g, tag = "") {
	const r = [];
	const expect = {
		"in-sync": "none",
		"behind-healable": "heal",
		"behind-staging-pending": "notice",
		"behind-already-attempted": "alarm",
		"behind-and-unhealthy": "alarm",
		"behind-staging-failed": "alarm",
		"behind-staging-unverified": "alarm",
		"behind-staging-unreached": "rerun",
		"behind-staging-unreached-retried": "alarm",
		// The box's record of its last verified deploy contradicts its HEAD.
		"verified-record-inconsistent": "alarm",
	};
	for (const [state, action] of Object.entries(expect)) {
		r.push([g.actionFor(state) === action, `${tag}§1 ${state} must map to '${action}' (got '${g.actionFor(state)}')`]);
	}
	r.push([Object.keys(g.ACTIONS).sort().join() === Object.keys(expect).sort().join(), `${tag}§1 the table holds exactly the states above (got ${Object.keys(g.ACTIONS).join(", ")})`]);
	for (const junk of ["", "behind", "BEHIND-HEALABLE", "behind-healable ", "toString", "__proto__", "constructor", "behind-staging-unreached "]) {
		r.push([g.actionFor(junk) === "alarm", `${tag}§1 unknown state ${JSON.stringify(junk)} must ALARM, never heal (got '${g.actionFor(junk)}')`]);
	}
	const heals = Object.keys(g.ACTIONS).filter((s) => g.ACTIONS[s] === "heal");
	r.push([heals.length === 1 && heals[0] === "behind-healable", `${tag}§1 exactly one state may heal (got ${JSON.stringify(heals)})`]);
	const reruns = Object.keys(g.ACTIONS).filter((s) => g.ACTIONS[s] === "rerun");
	r.push([reruns.length === 1 && reruns[0] === "behind-staging-unreached", `${tag}§1 exactly one state may re-run a Deploy run (got ${JSON.stringify(reruns)})`]);
	return r;
}
for (const [c, m] of checkActionTable(gate)) ok(c, m);
// ⚠️ hintFor() falls back to a generic "unrecognised state" line, which is
// long enough to pass a length check. So check the table itself: a state with
// no hint of its own would tell the operator it is unknown.
for (const s of Object.keys(gate.ACTIONS)) {
	ok(Object.prototype.hasOwnProperty.call(gate.HINTS, s) && gate.hintFor(s) === gate.HINTS[s] && gate.HINTS[s].length > 20,
		`§1 state ${s} must carry its own operator hint`);
}
for (const s of Object.keys(gate.HINTS)) ok(Object.prototype.hasOwnProperty.call(gate.ACTIONS, s), `§1 hint for '${s}' belongs to a state in ACTIONS`);
ok(/gh run rerun <run-id> --failed/.test(gate.HINTS["behind-staging-unreached-retried"]), "§1 the retried alarm tells the operator how to re-run by hand");

// ────────────────────────────────────────────────────── §2 refineState
function checkRefine(g, tag = "") {
	const r = [];
	r.push([g.refineState("behind-healable", "passed") === "behind-healable", `${tag}§2 healable + passed stays healable`]);
	r.push([g.refineState("behind-healable", "failed") === "behind-staging-failed", `${tag}§2 healable + staging FAILED must become behind-staging-failed — a rejected commit never heals`]);
	r.push([g.refineState("behind-healable", "pending") === "behind-staging-pending", `${tag}§2 healable + pending must wait, not heal`]);
	for (const v of ["unverified", "", undefined, null, "PASSED", "success", "UNREACHED"]) {
		r.push([g.refineState("behind-healable", v) === "behind-staging-unverified", `${tag}§2 healable + verdict ${JSON.stringify(v)} must fail closed as unverified`]);
	}
	for (const box of ["in-sync", "behind-already-attempted", "behind-and-unhealthy", "verified-record-inconsistent", ""]) {
		for (const v of ["passed", "failed", "pending", "unverified", "unreached"]) {
			r.push([g.refineState(box, v, 1) === box, `${tag}§2 box state '${box}' must not be changed by verdict '${v}'`]);
		}
	}
	// Staging never reached the VPS. GitHub's run_attempt is the "once".
	r.push([g.refineState("behind-healable", "unreached", 1) === "behind-staging-unreached",
		`${tag}§2 healable + unreached on the Deploy run's FIRST attempt → re-run it`]);
	for (const a of [2, 3, 17]) {
		r.push([g.refineState("behind-healable", "unreached", a) === "behind-staging-unreached-retried",
			`${tag}§2 healable + unreached on attempt ${a} → alarm: it was re-run already and staging still did not get through`]);
	}
	for (const a of [undefined, null, 0, -1, 1.5, NaN, "1", "", "one"]) {
		r.push([g.refineState("behind-healable", "unreached", a) === "behind-staging-unreached-retried",
			`${tag}§2 healable + unreached with a missing or unusable attempt (${typeof a} ${String(a)}) → alarm, never a re-run`]);
	}
	for (const v of ["passed", "failed", "pending"]) {
		for (const a of [1, 2, undefined]) {
			r.push([g.refineState("behind-healable", v, a) === g.refineState("behind-healable", v),
				`${tag}§2 the attempt changes nothing for verdict '${v}' (attempt ${String(a)})`]);
		}
	}
	return r;
}
for (const [c, m] of checkRefine(gate)) ok(c, m);

// ────────────────────────────────────────────────────── §3 stagingVerdict
function checkVerdicts(g, tag = "") {
	const r = [];
	const V = (runs, jobs, sha = SHA) => g.stagingVerdict(runs, jobs, sha).verdict;
	r.push([V([], {}) === "unverified", `${tag}§3 no run at all → unverified`]);
	r.push([V(undefined, undefined) === "unverified", `${tag}§3 garbage input → unverified`]);
	r.push([V([run(1)], { 1: [job("staging", "completed", "success"), job("production", "completed", "failure")] }) === "passed",
		`${tag}§3 staging success passes even when PRODUCTION failed — the transport-failure case must stay healable`]);
	for (const c of ["failure", "cancelled", "timed_out", "skipped", "action_required", "neutral", "stale", null]) {
		r.push([V([run(1)], { 1: [job("staging", "completed", c)] }) === "failed", `${tag}§3 staging concluded ${JSON.stringify(c)} → failed (only 'success' passes)`]);
	}
	r.push([V([run(1, { status: "in_progress", conclusion: null })], { 1: [job("staging", "in_progress", null)] }) === "pending", `${tag}§3 staging still running → pending`]);
	r.push([V([run(1, { status: "queued", conclusion: null })], { 1: [] }) === "pending", `${tag}§3 run queued, no jobs yet → pending`]);
	// ⚠️ #359 read this as `failed`. It is `pending` now, on purpose: while a
	// drift run executes it holds the shared concurrency group, so a Deploy run
	// it sees can only be completed or queued, and a run that is not completed
	// shows jobs that are not its final answer (a queued re-run still lists its
	// previous attempt's jobs).
	r.push([V([run(1, { status: "in_progress", conclusion: null })], { 1: [job("staging", "completed", "failure")] }) === "pending",
		`${tag}§3 staging failed but the RUN is not completed → pending: its jobs are not its final answer yet`]);
	r.push([V([run(1, { conclusion: "failure" })], { 1: [] }) === "failed", `${tag}§3 completed run with NO staging job (invalid workflow / startup failure) → failed`]);
	r.push([V([run(1)], { 1: [job("Staging", "completed", "success")] }) === "failed", `${tag}§3 the staging job is matched by its exact name`]);
	r.push([V([run(1)], { 1: [job("deploy staging", "completed", "success")] }) === "failed", `${tag}§3 a job merely CONTAINING 'staging' must not count`]);
	r.push([V([run(1, { event: "workflow_dispatch" })], { 1: [job("staging", "completed", "success")] }) === "unverified",
		`${tag}§3 a manual dispatch run is not a staging verdict for this commit`]);
	r.push([V([run(1, { head_sha: OTHER })], { 1: [job("staging", "completed", "success")] }) === "unverified",
		`${tag}§3 a run for ANOTHER commit must never approve this one`]);
	// Newest run wins, in both directions.
	r.push([V([run(1), run(2)], { 1: [job("staging", "completed", "success")], 2: [job("staging", "completed", "failure")] }) === "failed",
		`${tag}§3 an older success must not outvote a newer staging failure for the same commit`]);
	r.push([V([run(2), run(1)], { 1: [job("staging", "completed", "failure")], 2: [job("staging", "completed", "success")] }) === "passed",
		`${tag}§3 a newer success supersedes an older failure (and input order does not matter)`]);
	const detail = g.stagingVerdict([run(7)], { 7: [job("staging", "completed", "failure")] }, SHA);
	r.push([/7/.test(detail.detail) && /failure/.test(detail.detail) && detail.url === "https://x/jobs/staging", `${tag}§3 the verdict names the run, the conclusion and the job URL`]);

	// ── A FAILED staging job: failed, or never reached the VPS? Only
	// ssh-retry.sh's give-up annotation says the latter.
	const VA = (notes, { conclusion = "failure", runExtra = {} } = {}) =>
		g.stagingVerdict([run(1, runExtra)], { 1: failedStaging(conclusion) }, SHA, notes === undefined ? undefined : { [STAGING_ID]: notes }).verdict;
	r.push([VA(REAL_UNREACHED_UNTITLED) === "unreached", `${tag}§3 the REAL untitled give-up annotation (Deploy runs from before the title) → unreached`]);
	r.push([VA(REAL_UNREACHED_TITLED) === "unreached", `${tag}§3 the titled give-up annotation → unreached`]);
	r.push([VA([ann("failure", "the wording changed some day", 51, "VPS unreachable")]) === "unreached", `${tag}§3 the title alone is enough`]);
	r.push([VA([ann("failure", "ssh failed to connect after 5 attempts — runner→VPS network, not the deploy", 51)]) === "unreached", `${tag}§3 the message prefix alone is enough`]);
	r.push([VA(REAL_FAILURE) === "failed", `${tag}§3 a staging failure with only "Process completed with exit code 1." → failed`]);
	r.push([VA(RETRIED_THEN_FAILED) === "failed", `${tag}§3 ssh retried, got through, then the deploy failed for real → failed (a retry warning is not the give-up line)`]);
	r.push([VA([ann("warning", "ssh failed to connect after 5 attempts — runner→VPS network, not the deploy", 51, "VPS unreachable")]) === "failed",
		`${tag}§3 only a FAILURE-level annotation counts, whatever a warning says`]);
	r.push([VA([ann("failure", "remote said: ssh failed to connect after 5 attempts", 51)]) === "failed", `${tag}§3 the prefix must START the message`]);
	r.push([VA([ann("failure", "ssh failed to connect", 51, "VPS Unreachable")]) === "failed", `${tag}§3 the title must match exactly`]);
	r.push([VA([]) === "failed" && VA(undefined) === "failed" && VA([null, 7, "x"]) === "failed", `${tag}§3 no (usable) annotations → failed`]);
	r.push([VA({ error: "HTTP 403 from x" }) === "failed", `${tag}§3 annotations that could not be read → failed`]);
	const unread = g.stagingVerdict([run(1)], { 1: failedStaging() }, SHA, { [STAGING_ID]: { error: "HTTP 403 from x" } });
	r.push([/could not be read/.test(unread.detail) && /HTTP 403/.test(unread.detail), `${tag}§3 …and the detail says why the verdict could not be refined`]);
	for (const c of ["cancelled", "timed_out", "action_required"]) {
		r.push([VA(REAL_UNREACHED_TITLED, { conclusion: c }) === "failed", `${tag}§3 a '${c}' staging job stays failed even with the give-up annotation`]);
	}
	r.push([g.stagingVerdict([run(1)], { 1: failedStaging() }, SHA, { [STAGING_ID + 1]: REAL_UNREACHED_TITLED }).verdict === "failed",
		`${tag}§3 another job's annotations never classify the staging job`]);
	r.push([VA(REAL_UNREACHED_TITLED, { runExtra: { run_attempt: 2 } }) === "unreached", `${tag}§3 the verdict is the job's; the attempt count is refineState()'s business`]);
	const u = g.stagingVerdict([run(3, { run_attempt: 1 })], { 3: failedStaging() }, SHA, { [STAGING_ID]: REAL_UNREACHED_TITLED });
	r.push([u.runId === 3 && u.runAttempt === 1 && /never reached the VPS/.test(u.detail) && /Deploy run 3 \(attempt 1\)/.test(u.detail) && u.url === "https://x/jobs/staging",
		`${tag}§3 an unreached verdict names the run and its attempt, and links the job (got ${JSON.stringify(u)})`]);
	const noAttempt = g.stagingVerdict([run(4, { run_attempt: undefined })], { 4: failedStaging() }, SHA, { [STAGING_ID]: REAL_UNREACHED_TITLED });
	r.push([noAttempt.verdict === "unreached" && noAttempt.runAttempt === undefined && /attempt unknown/.test(noAttempt.detail), `${tag}§3 a missing attempt is reported as unknown, not invented`]);
	// Pass and pending carry the run's id and attempt too, and ignore annotations.
	const p = g.stagingVerdict([run(8, { run_attempt: 2 })], { 8: [job("staging", "completed", "success", { id: STAGING_ID })] }, SHA, { [STAGING_ID]: REAL_UNREACHED_TITLED });
	r.push([p.verdict === "passed" && p.runId === 8 && p.runAttempt === 2, `${tag}§3 a passing staging job passes whatever its annotations say, and carries run id + attempt`]);
	const q = g.stagingVerdict([run(9, { status: "in_progress", conclusion: null })], { 9: [job("staging", "in_progress", null, { id: STAGING_ID })] }, SHA, { [STAGING_ID]: REAL_UNREACHED_TITLED });
	r.push([q.verdict === "pending" && q.runId === 9, `${tag}§3 a running staging job is pending, whatever annotations exist`]);

	// ── PENDING FIRST. The run's own status is read before any job's.
	// A re-run still queued behind this drift run: the jobs API lists attempt
	// 1's FAILED staging job. Its verdict is not in yet.
	const staleAttempt1 = (conclusion) => failedStaging(conclusion).map((j) => ({ ...j, run_attempt: 1 }));
	const queuedRerun = { status: "queued", conclusion: null, run_attempt: 2 };
	for (const [name, notes] of [["the give-up annotation", REAL_UNREACHED_TITLED], ["a real failure's annotations", REAL_FAILURE]]) {
		const v = g.stagingVerdict([run(1, queuedRerun)], { 1: staleAttempt1("failure") }, SHA, { [STAGING_ID]: notes });
		r.push([v.verdict === "pending", `${tag}§3 a QUEUED re-run whose jobs are still attempt 1's failed staging job (${name}) → pending, not ${v.verdict}`]);
		r.push([v.url === "https://x/runs/1", `${tag}§3 …linking the run, not the stale attempt-1 job (got ${v.url})`]);
	}
	for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
		const v = g.stagingVerdict([run(1, { status, conclusion: null, run_attempt: 2 })], { 1: [job("staging", "completed", "success", { run_attempt: 1 })] }, SHA);
		r.push([v.verdict === "pending", `${tag}§3 run status '${status}' → pending whatever its jobs say (got ${v.verdict})`]);
	}
	// A re-run of PRODUCTION alone, still queued: staging's pass is carried
	// from attempt 1, production waits in attempt 2. The re-run is on its way;
	// a heal now would deploy production twice.
	const prodOnlyJobs = (prod) => [job("staging", "completed", "success", { id: STAGING_ID, run_attempt: 1 }), job("production", ...prod, { id: STAGING_ID + 1, run_attempt: 2 })];
	r.push([V([run(1, queuedRerun)], { 1: prodOnlyJobs(["queued", null]) }) === "pending", `${tag}§3 a queued re-run of production alone → pending`]);
	// …and once it has COMPLETED, production failing on transport again: the
	// staging job is still attempt 1's, in a run on attempt 2, and its pass
	// must count. Keying on the job's attempt would silently stop this heal.
	const carried = g.stagingVerdict([run(1, { run_attempt: 2, conclusion: "failure" })], { 1: prodOnlyJobs(["completed", "failure"]) }, SHA);
	r.push([carried.verdict === "passed" && carried.runAttempt === 2,
		`${tag}§3 a COMPLETED attempt-2 run whose staging job is attempt 1's success → passed, so production can still be healed (got ${carried.verdict})`]);
	return r;
}
for (const [c, m] of checkVerdicts(gate)) ok(c, m);

// ────────────────────────────────────────────────────── §4 lookupStaging
function fakeFetch(routes) {
	const calls = [];
	const fn = async (url, opts) => {
		calls.push({ url, headers: (opts && opts.headers) || {} });
		for (const [re, handler] of routes) {
			if (re.test(url)) {
				const res = typeof handler === "function" ? handler(url, calls.length) : handler;
				if (res instanceof Error) throw res;
				return {
					status: res.status || 200,
					ok: (res.status || 200) >= 200 && (res.status || 200) < 300,
					json: async () => res.body,
				};
			}
		}
		return { status: 404, ok: false, json: async () => ({}) };
	};
	fn.calls = calls;
	return fn;
}
const noSleep = async () => {};

// §4 for the annotations call, as a suite a mutant can be run through (§8).
async function checkAnnotationLookup(g, tag = "") {
	const r = [];
	const serve = (annotations, { attempt = 1, jobs, runExtra = {} } = {}) => fakeFetch([
		[/\/actions\/workflows\/deploy\.yml\/runs\?/, { body: { workflow_runs: [run(61, { conclusion: "failure", run_attempt: attempt, ...runExtra })] } }],
		[/\/actions\/runs\/61\/jobs\?/, { body: { jobs: jobs || failedStaging() } }],
		[/\/check-runs\/\d+\/annotations\?/, annotations],
	]);
	const look = (f) => g.lookupStaging({ repo: "o/r", sha: SHA, token: "tkn", apiBase: "https://api.example", fetchImpl: f, sleepImpl: noSleep });
	{
		const f = serve({ body: REAL_UNREACHED_UNTITLED });
		const v = await look(f);
		r.push([v.verdict === "unreached" && v.runId === 61 && v.runAttempt === 1, `${tag}§4 failed staging + the real give-up annotations → unreached, run 61 attempt 1 (got ${JSON.stringify(v)})`]);
		r.push([f.calls.length === 3, `${tag}§4 a failed staging job costs exactly ONE more call (got ${f.calls.length})`]);
		const u = f.calls[2] ? new URL(f.calls[2].url) : null;
		r.push([!!u && u.pathname === `/repos/o/r/check-runs/${STAGING_ID}/annotations` && u.searchParams.get("per_page") === "100",
			`${tag}§4 it reads the STAGING job's annotations by its id, which is its check-run id (got ${f.calls[2] && f.calls[2].url})`]);
		r.push([!!f.calls[2] && f.calls[2].headers.Authorization === "Bearer tkn", `${tag}§4 …with the workflow token`]);
	}
	{
		const v = await look(serve({ body: REAL_FAILURE }));
		r.push([v.verdict === "failed", `${tag}§4 failed staging + only "exit code 1" → failed`]);
	}
	{
		// ⚠️ Fail closed: annotations that cannot be read leave `failed`, never
		// `unreached`. A 500 is retried like every call; the 403 after it is fatal.
		let n = 0;
		const f = serve(() => (++n === 1 ? { status: 500, body: {} } : { status: 403, body: {} }));
		const v = await look(f);
		r.push([v.verdict === "failed" && n === 2, `${tag}§4 annotations 500 then 403 → retried once, then failed (verdict ${v.verdict}, annotation calls ${n})`]);
		r.push([/could not be read/.test(v.detail) && /HTTP 403/.test(v.detail), `${tag}§4 …and the detail names the lookup failure (got ${v.detail})`]);
	}
	{
		const f = serve(new Error("socket hang up"));
		const v = await look(f);
		r.push([v.verdict === "failed" && f.calls.filter((c) => /annotations/.test(c.url)).length === 3, `${tag}§4 annotations unreachable → retried, then failed`]);
	}
	{
		const v = await look(serve({ body: { message: "not a list" } }));
		r.push([v.verdict === "failed", `${tag}§4 an annotations body that is not a list → failed`]);
	}
	{
		const f = serve({ body: REAL_UNREACHED_TITLED }, { jobs: [job("staging", "completed", "failure", { id: "7; x" })] });
		const v = await look(f);
		r.push([v.verdict === "failed" && f.calls.length === 2, `${tag}§4 a staging job without a numeric id is never looked up, and stays failed`]);
	}
	{
		// The race pending-first closes: a re-run of the run is queued behind
		// this drift run, and the jobs API still lists attempt 1's failed
		// staging job. Its annotations are not even read.
		const stale = failedStaging().map((j) => ({ ...j, run_attempt: 1 }));
		const f = serve({ body: REAL_UNREACHED_TITLED }, { attempt: 2, jobs: stale, runExtra: { status: "queued", conclusion: null } });
		const v = await look(f);
		r.push([v.verdict === "pending" && v.runAttempt === 2, `${tag}§4 a QUEUED re-run with attempt 1's failed staging job → pending (got ${v.verdict})`]);
		r.push([f.calls.length === 2 && !f.calls.some((c) => /annotations/.test(c.url)), `${tag}§4 …and no annotations call for a run that is not completed (calls ${f.calls.length})`]);
	}
	for (const [name, jobs, runExtra] of [
		["passed", [job("staging", "completed", "success", { id: STAGING_ID }), job("production", "completed", "failure", { id: 9 })], {}],
		["pending", [job("staging", "in_progress", null, { id: STAGING_ID })], { status: "in_progress", conclusion: null }],
		["cancelled", [job("staging", "completed", "cancelled", { id: STAGING_ID })], {}],
	]) {
		const f = fakeFetch([
			[/\/runs\?/, { body: { workflow_runs: [run(62, runExtra)] } }],
			[/\/runs\/62\/jobs\?/, { body: { jobs } }],
			[/\/annotations\?/, { body: REAL_UNREACHED_TITLED }],
		]);
		await g.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep });
		r.push([f.calls.length === 2 && !f.calls.some((c) => /annotations/.test(c.url)), `${tag}§4 a ${name} staging job reads no annotations (calls ${f.calls.length})`]);
	}
	return r;
}

(async () => {
	{
		const f = fakeFetch([
			[/\/actions\/workflows\/deploy\.yml\/runs\?/, { body: { workflow_runs: [run(42)] } }],
			[/\/actions\/runs\/42\/jobs\?/, { body: { jobs: [job("staging", "completed", "success")] } }],
		]);
		const v = await gate.lookupStaging({ repo: "o/r", sha: SHA, token: "tkn", apiBase: "https://api.example/", fetchImpl: f, sleepImpl: noSleep });
		ok(v.verdict === "passed", `§4 happy path passes (got ${v.verdict})`);
		const u = new URL(f.calls[0].url);
		ok(u.origin === "https://api.example" && u.pathname === "/repos/o/r/actions/workflows/deploy.yml/runs", `§4 lists runs of deploy.yml (got ${f.calls[0].url})`);
		ok(u.searchParams.get("head_sha") === SHA, "§4 filters by head_sha = the target commit");
		ok(u.searchParams.get("event") === "push", "§4 filters to push-triggered runs");
		ok(/\/actions\/runs\/42\/jobs\?/.test(f.calls[1].url) && new URL(f.calls[1].url).searchParams.get("filter") === "latest",
			"§4 reads the newest attempt's jobs (filter=latest)");
		ok(f.calls[0].headers.Authorization === "Bearer tkn", "§4 authenticates with the workflow token");
		ok(f.calls.length === 2, `§4 exactly two API calls (got ${f.calls.length})`);
	}
	{
		// The API ignoring head_sha must not let another commit's success through.
		const f = fakeFetch([
			[/\/runs\?/, { body: { workflow_runs: [run(9, { head_sha: OTHER })] } }],
			[/\/runs\/9\/jobs/, { body: { jobs: [job("staging", "completed", "success")] } }],
		]);
		const v = await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep });
		ok(v.verdict === "unverified", `§4 a run for another commit is filtered client-side (got ${v.verdict})`);
		ok(!f.calls.some((c) => /\/jobs\?/.test(c.url)), "§4 …and its jobs are never even fetched");
	}
	{
		// The race the re-look exists for: the drift run reads the box seconds
		// after a push, before GitHub has created that push's Deploy run.
		let lists = 0;
		const slept = [];
		const f = fakeFetch([
			[/\/runs\?/, () => (++lists === 1 ? { body: { workflow_runs: [] } } : { body: { workflow_runs: [run(21)] } })],
			[/\/runs\/21\/jobs/, { body: { jobs: [job("staging", "completed", "success")] } }],
		]);
		const v = await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: async (ms) => { slept.push(ms); } });
		ok(v.verdict === "passed" && lists === 2, `§4 no run on the first look, one on the re-look → passed (verdict ${v.verdict}, looks ${lists})`);
		ok(slept.length === 1 && slept[0] === 20000, `§4 the re-look waits 20 s by default (slept ${JSON.stringify(slept)})`);
	}
	{
		let lists = 0;
		const f = fakeFetch([[/\/runs\?/, () => { lists++; return { body: { workflow_runs: [] } }; }]]);
		const v = await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep });
		ok(v.verdict === "unverified" && lists === 2, `§4 still no run after ONE re-look → unverified (looks ${lists})`);
		lists = 0;
		await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep, missingRetryMs: 0 });
		ok(lists === 1, "§4 missingRetryMs: 0 disables the re-look");
	}
	{
		let n = 0;
		const f = fakeFetch([
			[/\/runs\?/, () => (++n < 3 ? { status: n === 1 ? 502 : 429, body: {} } : { body: { workflow_runs: [run(5)] } })],
			[/\/runs\/5\/jobs/, { body: { jobs: [job("staging", "completed", "success")] } }],
		]);
		const v = await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep });
		ok(v.verdict === "passed" && n === 3, `§4 5xx and 429 are retried (passed after ${n} calls)`);
	}
	{
		let n = 0;
		const f = fakeFetch([[/\/runs\?/, () => { n++; return { status: 403, body: {} }; }]]);
		let threw = false;
		try { await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep }); } catch { threw = true; }
		ok(threw && n === 1, `§4 a 4xx is fatal and NOT retried (calls=${n})`);
	}
	{
		const f = fakeFetch([[/\/runs\?/, new Error("socket hang up")]]);
		let threw = false;
		try { await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep }); } catch { threw = true; }
		ok(threw && f.calls.length === 3, `§4 a network error is retried, then surfaces (calls=${f.calls.length})`);
	}
	for (const [c, m] of await checkAnnotationLookup(gate)) ok(c, m);

	// ──────────────────────────────────────────────────── §5 decide(): fail-closed
	{
		// Staging never reached the VPS: re-run on the first attempt, alarm after.
		const serve = (attempt, annotations) => fakeFetch([
			[/\/runs\?/, { body: { workflow_runs: [run(71, { conclusion: "failure", run_attempt: attempt })] } }],
			[/\/runs\/71\/jobs\?/, { body: { jobs: failedStaging() } }],
			[/\/annotations\?/, annotations],
		]);
		const d = (attempt, annotations = { body: REAL_UNREACHED_TITLED }, boxState = "behind-healable") =>
			gate.decide({ boxState, targetSha: SHA, repo: "o/r", fetchImpl: serve(attempt, annotations), sleepImpl: noSleep });
		const first = await d(1);
		ok(first.state === "behind-staging-unreached" && first.action === "rerun" && first.runId === 71 && first.runAttempt === 1,
			`§5 unreached on attempt 1 → rerun, naming run 71 attempt 1 (got ${JSON.stringify({ state: first.state, action: first.action, runId: first.runId, runAttempt: first.runAttempt })})`);
		const historical = await d(1, { body: REAL_UNREACHED_UNTITLED });
		ok(historical.action === "rerun", "§5 …the untitled annotation of a run from before the title re-runs too");
		const again = await d(2);
		ok(again.state === "behind-staging-unreached-retried" && again.action === "alarm", `§5 unreached on attempt 2 → alarm, never a second re-run (got ${again.state})`);
		const unknown = await d(undefined);
		ok(unknown.action === "alarm", "§5 unreached with no attempt number → alarm");
		const unreadable = await d(1, { status: 403, body: {} });
		ok(unreadable.state === "behind-staging-failed" && unreadable.action === "alarm", `§5 annotations unreadable → behind-staging-failed alarm, as before (got ${unreadable.state})`);
		const real = await d(1, { body: REAL_FAILURE });
		ok(real.state === "behind-staging-failed" && real.action === "alarm", "§5 a real staging failure on attempt 1 still alarms, never re-runs");
		for (const box of ["behind-already-attempted", "behind-and-unhealthy", "in-sync"]) {
			const boxWins = await d(1, { body: REAL_UNREACHED_TITLED }, box);
			ok(boxWins.state === box && boxWins.action !== "rerun", `§5 the box's own state '${box}' wins over an unreached staging job`);
		}
	}
	{
		// A re-run of PRODUCTION alone (staging passed, production lost its
		// connection). Staging's job stays attempt 1's in a run on attempt 2.
		const serve = (runExtra, prod) => fakeFetch([
			[/\/runs\?/, { body: { workflow_runs: [run(81, { run_attempt: 2, ...runExtra })] } }],
			[/\/runs\/81\/jobs\?/, { body: { jobs: [
				job("staging", "completed", "success", { id: 8101, run_attempt: 1 }),
				job("production", ...prod, { id: 8102, run_attempt: 2 }),
			] } }],
		]);
		const d = (runExtra, prod) => gate.decide({ boxState: "behind-healable", targetSha: SHA, repo: "o/r", fetchImpl: serve(runExtra, prod), sleepImpl: noSleep });
		const queued = await d({ status: "queued", conclusion: null }, ["queued", null]);
		ok(queued.state === "behind-staging-pending" && queued.action === "notice", `§5 a queued re-run of production alone → notice: it is on its way, no heal on top of it (got ${queued.state})`);
		const done = await d({ conclusion: "failure" }, ["completed", "failure"]);
		ok(done.state === "behind-healable" && done.action === "heal",
			`§5 that re-run completed and production failed again → heal: staging's attempt-1 pass still counts (got ${done.state})`);
	}
	{
		const never = fakeFetch([[/./, () => { throw new Error("must not be called"); }]]);
		for (const box of ["in-sync", "behind-already-attempted", "behind-and-unhealthy"]) {
			const d = await gate.decide({ boxState: box, targetSha: SHA, repo: "o/r", fetchImpl: never, sleepImpl: noSleep });
			ok(d.state === box && never.calls.length === 0, `§5 box state ${box} needs no API call and is passed through`);
		}
		const bad = await gate.decide({ boxState: "behind-healable", targetSha: "abc", repo: "o/r", fetchImpl: never, sleepImpl: noSleep });
		ok(bad.action === "alarm" && bad.state === "behind-staging-unverified", "§5 no usable target SHA → unverified alarm, not a heal");
		const norepo = await gate.decide({ boxState: "behind-healable", targetSha: SHA, repo: "", fetchImpl: never, sleepImpl: noSleep });
		ok(norepo.action === "alarm", "§5 no repository → unverified alarm");
		const boom = await gate.decide({ boxState: "behind-healable", targetSha: SHA, repo: "o/r", fetchImpl: fakeFetch([[/./, { status: 500, body: {} }]]), sleepImpl: noSleep });
		ok(boom.action === "alarm" && /API lookup failed/.test(boom.detail), "§5 an API outage → unverified alarm, never a heal");
		const empty = await gate.decide({ boxState: "", targetSha: SHA, repo: "o/r", fetchImpl: never, sleepImpl: noSleep });
		ok(empty.action === "alarm", "§5 an empty box state (unparseable ssh output) alarms");
	}

	// ──────────────────────────────────────────────────── §6 the CLI, end to end
	await cliScenarios();

	// ──────────────────────────────────────────────────── §7 source pins
	sourcePins();

	// ──────────────────────────────────────────────────── §9 the rerun job's script
	const script = rerunScript();
	ok(/rerun-failed-jobs/.test(script), "§9 found the rerun job's one run: script");
	for (const [c, m] of checkRerunScript(script)) ok(c, m);

	// ──────────────────────────────────────────────────── §8 mutants
	await mutants();

	report();
})().catch((err) => {
	console.error(err);
	process.exit(1);
});

async function cliScenarios() {
	const scenarios = {
		passed: { runs: [run(11)], jobs: { 11: [job("staging", "completed", "success"), job("production", "completed", "failure")] } },
		failed: {
			runs: [run(12, { conclusion: "failure" })],
			jobs: { 12: [job("staging", "completed", "failure", { id: 9012 }), job("production", "completed", "skipped", { id: 9013 })] },
			annotations: { 9012: REAL_FAILURE },
		},
		pending: { runs: [run(13, { status: "in_progress", conclusion: null })], jobs: { 13: [job("staging", "in_progress", null)] } },
		none: { runs: [], jobs: {} },
		unreached: {
			runs: [run(14, { conclusion: "failure", run_attempt: 1 })],
			jobs: { 14: [job("staging", "completed", "failure", { id: 9014 }), job("production", "completed", "skipped", { id: 9015 })] },
			annotations: { 9014: REAL_UNREACHED_TITLED },
		},
		unreachedAgain: {
			runs: [run(15, { conclusion: "failure", run_attempt: 2 })],
			jobs: { 15: [job("staging", "completed", "failure", { id: 9016 }), job("production", "completed", "skipped", { id: 9017 })] },
			annotations: { 9016: REAL_UNREACHED_UNTITLED },
		},
		// GitHub's ids are numbers. One that is not must never reach the rerun
		// job, which builds an API path from it.
		oddId: {
			runs: [run("14; x", { conclusion: "failure", run_attempt: 1 })],
			jobs: { "14; x": [job("staging", "completed", "failure", { id: 9018 }), job("production", "completed", "skipped", { id: 9019 })] },
			annotations: { 9018: REAL_UNREACHED_TITLED },
		},
	};
	let current = "passed";
	const seen = [];
	const server = http.createServer((req, res) => {
		seen.push({ url: req.url, auth: req.headers.authorization || "" });
		const sc = scenarios[current];
		let body = null;
		if (/^\/repos\/o\/r\/actions\/workflows\/deploy\.yml\/runs\?/.test(req.url)) body = { workflow_runs: sc.runs };
		const m = /^\/repos\/o\/r\/actions\/runs\/([^/?]+)\/jobs\?/.exec(req.url);
		if (m) body = { jobs: sc.jobs[decodeURIComponent(m[1])] || [] };
		const a = /^\/repos\/o\/r\/check-runs\/(\d+)\/annotations\?/.exec(req.url);
		if (a) body = (sc.annotations || {})[a[1]] || null;
		res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
		res.end(JSON.stringify(body || { message: "Not Found" }));
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const api = `http://127.0.0.1:${server.address().port}`;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drift-gate-"));
	try {
		const cli = async (box, target, scenario) => {
			current = scenario;
			const outFile = path.join(tmp, `out-${Math.random().toString(36).slice(2)}`);
			fs.writeFileSync(outFile, "");
			const env = {
				PATH: process.env.PATH,
				BOX_STATE: box,
				TARGET_SHA: target,
				GITHUB_REPOSITORY: "o/r",
				GITHUB_TOKEN: "cli-token",
				GITHUB_API_URL: api,
				GITHUB_OUTPUT: outFile,
				DRIFT_GATE_MISSING_RETRY_MS: "0",
			};
			const r = await new Promise((resolve) => {
				const child = spawn(process.execPath, [GATE_PATH], { env });
				let out = "";
				child.stdout.on("data", (c) => (out += c));
				child.stderr.on("data", (c) => (out += c));
				child.on("close", (code) => resolve({ code, out }));
			});
			const outputs = Object.fromEntries(
				fs.readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
			);
			return { ...r, outputs };
		};
		let r = await cli("behind-healable", SHA, "passed");
		ok(r.code === 0 && r.outputs.action === "heal" && r.outputs.state === "behind-healable",
			`§6 CLI: staging passed → heal (got ${JSON.stringify(r.outputs)})`);
		ok(seen.some((s) => s.auth === "Bearer cli-token"), "§6 CLI sends GITHUB_TOKEN to the API");
		r = await cli("behind-healable", SHA, "failed");
		ok(r.code === 0 && r.outputs.action === "alarm" && r.outputs.state === "behind-staging-failed",
			`§6 CLI: staging failed → behind-staging-failed alarm (got ${JSON.stringify(r.outputs)})`);
		ok(seen.some((s) => /^\/repos\/o\/r\/check-runs\/9012\/annotations\?/.test(s.url)), "§6 CLI: a failed staging job's annotations are read before calling it failed");
		r = await cli("behind-healable", SHA, "pending");
		ok(r.outputs.action === "notice" && r.outputs.state === "behind-staging-pending", "§6 CLI: staging pending → quiet notice");
		r = await cli("behind-healable", SHA, "none");
		ok(r.outputs.action === "alarm" && r.outputs.state === "behind-staging-unverified", "§6 CLI: no run → unverified alarm");
		ok(r.outputs.run_id === "" && r.outputs.run_attempt === "", "§6 CLI: no run → run_id and run_attempt are empty, not invented");
		r = await cli("behind-healable", SHA, "unreached");
		ok(r.code === 0 && r.outputs.action === "rerun" && r.outputs.state === "behind-staging-unreached" && r.outputs.verdict === "unreached",
			`§6 CLI: staging never reached the VPS, first attempt → rerun (got ${JSON.stringify(r.outputs)})`);
		ok(r.outputs.run_id === "14" && r.outputs.run_attempt === "1", "§6 CLI: …and hands the rerun job run_id=14, run_attempt=1");
		ok(/^GATE_RUN_ID=14$/m.test(r.out) && /^GATE_RUN_ATTEMPT=1$/m.test(r.out), `§6 CLI prints GATE_RUN_ID and GATE_RUN_ATTEMPT (got: ${r.out.trim().split("\n").join(" | ")})`);
		r = await cli("behind-healable", SHA, "unreachedAgain");
		ok(r.code === 0 && r.outputs.action === "alarm" && r.outputs.state === "behind-staging-unreached-retried" && r.outputs.run_attempt === "2",
			`§6 CLI: still unreached on attempt 2 → alarm (got ${JSON.stringify(r.outputs)})`);
		r = await cli("behind-healable", SHA, "oddId");
		ok(r.code === 0 && r.outputs.verdict === "unreached" && Object.prototype.hasOwnProperty.call(r.outputs, "run_id") && r.outputs.run_id === "" && r.outputs.run_attempt === "1",
			`§6 CLI: a run id that is not all digits ('14; x') leaves run_id EMPTY in $GITHUB_OUTPUT, and the rerun job refuses an empty id (§9) (got ${JSON.stringify(r.outputs)})`);
		ok(!/^GATE_RUN_ID=/m.test(r.out) && /Deploy run 14; x/.test(r.outputs.detail || ""), "§6 CLI: …and prints no GATE_RUN_ID line, though the detail still names the run");
		const before = seen.length;
		r = await cli("in-sync", SHA, "passed");
		ok(r.outputs.action === "none" && seen.length === before, "§6 CLI: in-sync makes no API call");
		r = await cli("behind-already-attempted", SHA, "passed");
		ok(r.outputs.action === "alarm" && r.outputs.state === "behind-already-attempted", "§6 CLI: the box's own alarm survives a passing staging");
		r = await cli("behind-already-attempted", SHA, "unreached");
		ok(r.outputs.action === "alarm" && r.outputs.state === "behind-already-attempted", "§6 CLI: the box's own alarm survives a staging job that never reached the VPS");
		for (const k of ["state", "action", "verdict", "detail", "hint", "run_id", "run_attempt"]) {
			ok(Object.prototype.hasOwnProperty.call(r.outputs, k), `§6 CLI writes '${k}' to $GITHUB_OUTPUT (deploy-drift.yml reads it)`);
		}
		ok(Object.values(r.outputs).every((v) => !/[\r\n]/.test(v)), "§6 every output value is single-line");
		// API unreachable: the CLI still exits 0 (the workflow branches on action) and alarms.
		const dead = await new Promise((resolve) => {
			const child = spawn(process.execPath, [GATE_PATH], {
				env: { PATH: process.env.PATH, BOX_STATE: "behind-healable", TARGET_SHA: SHA, GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "http://127.0.0.1:9", DRIFT_GATE_RETRY_MS: "0,0", DRIFT_GATE_MISSING_RETRY_MS: "0" },
			});
			let out = "";
			child.stdout.on("data", (c) => (out += c));
			child.on("close", (code) => resolve({ code, out }));
		});
		ok(dead.code === 0 && /DRIFT_ACTION=alarm/.test(dead.out) && /DRIFT_STATE=behind-staging-unverified/.test(dead.out),
			`§6 CLI: API unreachable → unverified alarm (got: ${dead.out.trim().split("\n").join(" | ")})`);
	} finally {
		server.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

// Every run: script in a workflow or action file, as { line, text }. Indentation
// aware: a script is the run: line's own value plus every following line that
// is blank or indented deeper than the `run` key, which covers `run: |`,
// `run: >-` and a plain one-liner alike. The text is NOT comment-stripped on
// purpose: GitHub substitutes an expression before bash runs, so one inside a
// shell comment is substituted too.
function runScripts(yaml) {
	const lines = yaml.split("\n");
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^(\s*)(-\s+)?run:(.*)$/.exec(lines[i]);
		if (!m) continue;
		const keyCol = m[1].length + (m[2] ? m[2].length : 0);
		const body = [m[3]];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const l = lines[j];
			if (l.trim() !== "" && l.length - l.trimStart().length <= keyCol) break;
			body.push(l);
		}
		out.push({ line: i + 1, text: body.join("\n") });
		i = j - 1;
	}
	return out;
}

// Each job under `jobs:` as { id: text }, by indentation like runScripts(). A
// column-0 comment does not end the section; any other column-0 key does.
function jobBlocks(yaml) {
	const lines = yaml.split("\n");
	const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
	const out = {};
	let id = null;
	for (let i = start + 1; start >= 0 && i < lines.length; i++) {
		const l = lines[i];
		if (/^[^\s#]/.test(l)) break;
		const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
		if (m) { id = m[1]; out[id] = ""; continue; }
		if (id) out[id] += `${l}\n`;
	}
	return out;
}

// Each step of a job's text, split on the `- ` items under `steps:`.
function stepBlocks(jobText) {
	const out = [];
	for (const l of jobText.split("\n")) {
		if (/^ {6}- /.test(l)) out.push("");
		if (out.length) out[out.length - 1] += `${l}\n`;
	}
	return out;
}

// The permissions block whose key sits at `indent` spaces, as { scope: level },
// or null when there is none. Reads the block form this repo uses and the
// inline `{ a: b }` and `write-all` forms, so neither can slip past a check.
function permissionsAt(text, indent) {
	const lines = noComments(text).split("\n");
	const key = `${" ".repeat(indent)}permissions:`;
	const i = lines.findIndex((l) => l.startsWith(key));
	if (i < 0) return null;
	const inline = lines[i].slice(key.length).trim();
	if (/^\{.*\}$/.test(inline)) {
		return Object.fromEntries(inline.slice(1, -1).split(",").map((kv) => kv.split(":").map((s) => s.trim())).filter(([k]) => k));
	}
	if (inline) return { "*": inline };
	const out = {};
	for (let j = i + 1; j < lines.length; j++) {
		const l = lines[j];
		if (!l.trim()) continue;
		if (l.length - l.trimStart().length <= indent) break;
		const m = /^\s*([a-z-]+):\s*(\S+)\s*$/.exec(l);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

// A key's value at `indent` spaces, whitespace-collapsed: a plain one-liner or
// a `|` / `>` block. null when the key is absent.
function yamlScalar(text, key, indent) {
	const lines = text.split("\n");
	const prefix = `${" ".repeat(indent)}${key}:`;
	const i = lines.findIndex((l) => l.startsWith(prefix));
	if (i < 0) return null;
	const head = lines[i].slice(prefix.length).trim();
	let body = [head];
	if (/^[|>][-+]?$/.test(head)) {
		body = [];
		for (let j = i + 1; j < lines.length; j++) {
			const l = lines[j];
			if (l.trim() && l.length - l.trimStart().length <= indent) break;
			body.push(l);
		}
	}
	return body.join(" ").replace(/\s+/g, " ").trim();
}

// deploy.yml's own gate, read-only. On a push, production runs only after
// staging SUCCEEDED. The drift heal and the drift re-run both lean on that
// ("production follows staging"), so the whole `if:` is pinned exactly: the
// only other way in is a manual dispatch that targets production.
const PRODUCTION_IF =
	"always() && ( (github.event_name == 'push' && needs.staging.result == 'success') || " +
	"(github.event_name == 'workflow_dispatch' && github.event.inputs.target == 'production') )";
function checkProductionGate(deployText, tag = "") {
	const prod = jobBlocks(deployText).production || "";
	const cond = yamlScalar(prod, "if", 4);
	return [
		[/^ {4}needs:\s*(\[\s*staging\s*\]|staging)\s*$/m.test(noComments(prod)), `${tag}§7 deploy.yml's production job has needs: [staging]`],
		[cond === PRODUCTION_IF,
			`${tag}§7 deploy.yml's production if: is exactly "${PRODUCTION_IF}" — on a push staging must have SUCCEEDED, and the only other way in is a manual dispatch targeting production (got ${JSON.stringify(cond)})`],
	];
}

// A run: script as bash receives it: the `|` header dropped, the block
// dedented. A one-liner is returned as is.
function scriptOf(s) {
	const [head, ...body] = s.text.split("\n");
	if (!/^\s*[|>][-+]?\s*$/.test(head)) return head.trim();
	const indents = body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
	const lead = indents.length ? Math.min(...indents) : 0;
	return `${body.map((l) => l.slice(lead)).join("\n").replace(/\s+$/, "")}\n`;
}

function sourcePins() {
	const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
	const deploy = read(".github/workflows/deploy.yml");
	const drift = read(".github/workflows/deploy-drift.yml");
	const action = read(".github/actions/vps-deploy/action.yml");

	const stagingName = /\n {2}staging:\n(?:.*\n)*? {4}name:\s*(\S+)/.exec(deploy);
	ok(stagingName && stagingName[1] === gate.STAGING_JOB_NAME,
		`§7 deploy.yml's staging job must be named '${gate.STAGING_JOB_NAME}' — drift-gate.js finds it by name (got ${stagingName && stagingName[1]})`);
	ok(gate.DEPLOY_WORKFLOW_FILE === "deploy.yml" && fs.existsSync(path.join(ROOT, ".github/workflows", gate.DEPLOY_WORKFLOW_FILE)),
		"§7 the gate queries the workflow file that actually exists");

	// ── The box's states, as remote-drift-check.sh can print them. Each one has
	// its own entry in the gate's table: a state the gate does not know would
	// still alarm (actionFor's default), but under a hint that calls it
	// unrecognised. Only `behind-healable` is ever refined by the staging gate;
	// a half-finished deploy (HEAD moved, the verified record did not) is
	// reported as `behind-healable` too, so the same gate decides it.
	const boxStates = [...new Set((read("scripts/deploy/remote-drift-check.sh").match(/DRIFT_STATE=([a-z-]+)/g) || []).map((s) => s.slice("DRIFT_STATE=".length)))];
	ok(boxStates.length >= 5 && ["in-sync", "behind-healable", "behind-already-attempted", "behind-and-unhealthy", "verified-record-inconsistent"].every((s) => boxStates.includes(s)),
		`§7 remote-drift-check.sh prints the box states the gate expects (got ${boxStates.join(", ")})`);
	for (const s of boxStates) {
		ok(Object.prototype.hasOwnProperty.call(gate.ACTIONS, s) && Object.prototype.hasOwnProperty.call(gate.HINTS, s),
			`§7 box state '${s}' from remote-drift-check.sh has its own action and hint in drift-gate.js`);
		ok(s === "behind-healable" || ["passed", "failed", "pending", "unreached"].every((v) => gate.refineState(s, v, 1) === s),
			`§7 box state '${s}' is never changed by a staging verdict (only behind-healable is)`);
	}
	ok(gate.actionFor("verified-record-inconsistent") === "alarm", "§7 an inconsistent verified-deploy record alarms; it never heals");

	const conc = (s) => {
		const m = /\nconcurrency:\n((?: {2}.*\n)+)/.exec(noComments(s));
		const block = m ? m[1] : "";
		const g = /group:\s*(\S+)/.exec(block);
		return { group: g && g[1], queueMax: /\bqueue:\s*max\b/.test(block), noCancel: /cancel-in-progress:\s*false/.test(block) };
	};
	const cd = conc(deploy);
	const cr = conc(drift);
	ok(cd.group && cd.group === cr.group, `§7 deploy.yml and deploy-drift.yml must share ONE concurrency group (got ${cd.group} vs ${cr.group})`);
	ok(cd.group && !/\$\{\{/.test(cd.group), "§7 the shared group is a literal, not an expression that could resolve differently per workflow");
	ok(cd.queueMax && cr.queueMax, "§7 both workflows set queue: max — the default cancels a pending run, so a drift tick could cancel a queued deploy");
	ok(cd.noCancel && cr.noCancel, "§7 neither workflow may cancel an in-progress deploy");

	const d = noComments(drift);
	ok(/node scripts\/deploy\/drift-gate\.js/.test(d), "§7 deploy-drift.yml runs the gate");
	ok(/permissions:\s*\n(?: {2}.*\n)*? {2}actions:\s*read/.test(d), "§7 deploy-drift.yml grants actions: read (the gate reads Deploy runs)");
	ok(/uses:\s*\.\/\.github\/actions\/vps-deploy/.test(d), "§7 the heal uses the shared vps-deploy action");
	ok(/rollback_on_failure:\s*"true"/.test(d), "§7 the heal auto-rolls-back on failed verification");
	ok(/sha:\s*\$\{\{\s*needs\.check\.outputs\.remote\s*\}\}/.test(d), "§7 the heal deploys EXACTLY the gated commit");
	ok(/if:\s*needs\.check\.outputs\.action == 'heal'/.test(d), "§7 the heal job runs only on action == heal");
	ok(/environment:\s*\n\s+name:\s*production/.test(d), "§7 the heal runs in the production environment (a re-armed reviewer gates it)");
	ok(/if:\s*steps\.prep\.outputs\.ready == 'yes'/.test(d), "§7 the deploy waits for the heal prep's HEAL_READY=yes");
	ok(!/\bssh\s+-i\b/.test(d) && !/\bssh\s+-i\b/.test(noComments(action)), "§7 no bare `ssh -i` left in a workflow — every connection goes through ssh-retry.sh");
	ok(!/ssh_retry\.sh|RUNNER_TEMP/.test(noComments(action)), "§7 the action no longer carries its own heredoc copy of the retry helper");
	ok((d.match(/scripts\/deploy\/ssh-retry\.sh/g) || []).length >= 2, "§7 the drift check and the heal prep both use ssh-retry.sh");

	// ── The rerun job, and who may write.
	const jobs = jobBlocks(drift);
	ok(["check", "heal", "rerun"].every((j) => Object.prototype.hasOwnProperty.call(jobs, j)),
		`§7 deploy-drift.yml has its check, heal and rerun jobs (got ${Object.keys(jobs).join(", ")})`);
	// ⚠️ An action the gate can emit that no job branches on is a silent no-op:
	// production sits behind main under a GREEN drift run.
	for (const a of [...new Set(Object.values(gate.ACTIONS))].filter((x) => x !== "none")) {
		ok(new RegExp(`outputs\\.action == '${a}'`).test(d), `§7 deploy-drift.yml acts on the gate's action '${a}'`);
	}
	const rerunJob = noComments(jobs.rerun || "");
	ok(/^ {4}needs:\s*check\s*$/m.test(rerunJob) && /^ {4}if:\s*needs\.check\.outputs\.action == 'rerun'\s*$/m.test(rerunJob),
		"§7 the rerun job runs after check, and only on action == 'rerun'");
	const top = permissionsAt(drift, 0);
	ok(!!top && top.contents === "read" && top.actions === "read" && top.checks === "read" && Object.keys(top).length === 3,
		`§7 workflow-level permissions are exactly contents, actions and checks, all read — checks: the gate reads a failed staging job's annotations (got ${JSON.stringify(top)})`);
	const rerunPerms = permissionsAt(jobs.rerun || "", 4);
	ok(JSON.stringify(rerunPerms) === JSON.stringify({ actions: "write" }),
		`§7 the rerun job's own permissions are exactly { actions: write }, which replace the workflow's for that job (got ${JSON.stringify(rerunPerms)})`);
	for (const [id, text] of Object.entries(jobs)) {
		if (id === "rerun") continue;
		const p = permissionsAt(text, 4);
		ok(!p || !Object.values(p).some((v) => /write/.test(v)), `§7 job '${id}' holds no write permission — only the rerun job may (got ${JSON.stringify(p)})`);
	}
	ok(!/write-all/.test(d), "§7 nothing in deploy-drift.yml asks for write-all");
	ok(!/^\s*(-\s+)?uses:/m.test(rerunJob), "§7 the rerun job checks nothing out and runs no action: only its own script ever holds the write token");
	ok(/gh api -X POST "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$RUN_ID\/rerun-failed-jobs"/.test(rerunJob),
		"§7 the rerun job asks GitHub to re-run the failed jobs (and their dependents) of exactly that run");
	// The §9 stub answers whatever it is told, so the two reads' --jq text is
	// pinned here (both checked against the live API on 2026-09-24).
	ok(rerunJob.includes(`gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID" --jq '"\\(.run_attempt) \\(.status) \\(.event) \\(.head_branch) \\(.path) \\(.head_sha)"'`),
		"§7 the rerun job reads attempt, status, event, branch, workflow and commit back in ONE call");
	ok(rerunJob.includes(`gh api "repos/$GITHUB_REPOSITORY/actions/workflows/deploy.yml/runs?branch=main&event=push&per_page=1" --jq '.workflow_runs[0].id'`),
		"§7 …and then main's newest push-triggered Deploy run");
	const checkJob = jobs.check || "";
	ok(/^ {6}run_id:\s*\$\{\{\s*steps\.gate\.outputs\.run_id\s*\}\}\s*$/m.test(checkJob)
		&& /^ {6}run_attempt:\s*\$\{\{\s*steps\.gate\.outputs\.run_attempt\s*\}\}\s*$/m.test(checkJob),
	"§7 the check job exports the gate's run_id and run_attempt");
	ok(/^\s*RUN_ID:\s*\$\{\{\s*needs\.check\.outputs\.run_id\s*\}\}\s*$/m.test(rerunJob)
		&& /^\s*ATTEMPT:\s*\$\{\{\s*needs\.check\.outputs\.run_attempt\s*\}\}\s*$/m.test(rerunJob)
		&& /^\s*GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}\s*$/m.test(rerunJob),
	"§7 the rerun job receives the run id, the attempt and the token through env:");
	ok(/^\s*RUN_ID:\s*\$\{\{\s*steps\.gate\.outputs\.run_id\s*\}\}\s*$/m.test(checkJob) && /^\s*RUN_ATTEMPT:\s*\$\{\{\s*steps\.gate\.outputs\.run_attempt\s*\}\}\s*$/m.test(checkJob)
		&& /\| Deploy run \|/.test(checkJob) && /\| attempt \|/.test(checkJob),
	"§7 the check job's summary table shows the Deploy run and its attempt");
	// The check job fails ONLY on an alarm. A `rerun` must leave it green, or
	// every automatic re-run would page someone as an alarm.
	const failing = stepBlocks(checkJob).filter((s) => /\bexit 1\b/.test(noComments(s)));
	ok(failing.length === 1 && /^\s*if:\s*steps\.gate\.outputs\.action == 'alarm'\s*$/m.test(failing[0]),
		`§7 the check job's one failing step runs only on action == 'alarm' (found ${failing.length})`);
	// The deploy key leaves the disk as soon as the box has been read: the
	// staging gate (node, the GitHub API) runs without it. The always() step at
	// the end stays as the backstop.
	const checkSteps = stepBlocks(checkJob);
	const at = (re) => checkSteps.findIndex((s) => re.test(s));
	const shreds = checkSteps.map((s, i) => (/shred -u ~\/\.ssh\/deploy_key/.test(noComments(s)) ? i : -1)).filter((i) => i >= 0);
	const iCheck = at(/- name: Check for drift\s*\n/);
	const iGate = at(/- name: Staging gate\s*\n/);
	// No `if:` of any kind on that step: it must run whenever the check did.
	ok(iCheck >= 0 && shreds.includes(iCheck + 1) && iGate === iCheck + 2 && !/^\s*if:/m.test(noComments(checkSteps[iCheck + 1] || "")),
		`§7 the check job shreds the deploy key, unconditionally, in the step right after 'Check for drift' and before 'Staging gate' (check ${iCheck}, shreds ${shreds}, gate ${iGate})`);
	ok(shreds.some((i) => i > iGate && /^\s*if:\s*always\(\)\s*$/m.test(checkSteps[i])), "§7 …and still shreds it in an always() step at the end");

	for (const [c, m] of checkProductionGate(deploy)) ok(c, m);

	const pd = noComments(deploy);
	const shaPins = pd.match(/sha:\s*\$\{\{\s*github\.event_name == 'push' && github\.sha \|\| '' \}\}/g) || [];
	ok(shaPins.length === 2, `§7 both deploy.yml jobs pin a push to github.sha (found ${shaPins.length})`);
	ok(/SHA='\$SHA'/.test(action), "§7 the action forwards SHA to remote-deploy.sh");

	// ── The run: scanner checks itself first. A scanner that silently matches
	// nothing would make every rule below pass vacuously — the quiet inverse of
	// ci.yml's tripwire, which once matched its own comment text.
	const fixture = [
		"jobs:",
		"  j:",
		"    steps:",
		"      - name: bad",
		"        run: |",
		"          echo \"${{ secrets.X }}\"",
		"      - name: good",
		"        env:",
		"          X: ${{ secrets.X }}",
		"        if: steps.a.outputs.b != 'c'",
		"        run: |",
		"          echo \"$X\"",
		"      - run: echo ${{ github.head_ref }}",
		"      - uses: ./x",
		"        with:",
		"          k: ${{ secrets.K }}",
	].join("\n");
	const fxRuns = runScripts(fixture);
	const fxHits = fxRuns.filter((s) => /\$\{\{/.test(s.text)).map((s) => s.line).join(",");
	ok(fxRuns.length === 3 && fxHits === "5,13",
		`§7 the run: scanner flags an expression in a block script and in a one-liner, and nothing in env:/with:/if: (got ${fxRuns.length} scripts, hits at ${fxHits})`);

	// ── Every workflow and composite action. ⚠️ An expression inside a run:
	// script is pasted into the script TEXT before bash parses it: a secret with
	// a quote in it breaks the step, and a value read off the box runs as shell
	// on the runner. Secrets and step outputs reach the shell through env: only.
	const wfFiles = fs.readdirSync(path.join(ROOT, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);
	const actionFiles = fs.readdirSync(path.join(ROOT, ".github/actions"))
		.map((a) => `.github/actions/${a}/action.yml`)
		.filter((p) => fs.existsSync(path.join(ROOT, p)));
	const allFiles = [...wfFiles, ...actionFiles];
	ok(allFiles.includes(".github/workflows/backup-freshness.yml") && allFiles.includes(".github/actions/vps-deploy/action.yml") && allFiles.length >= 5,
		`§7 the workflow scan sees every workflow and action (got ${allFiles.join(", ")})`);
	for (const f of allFiles) {
		const text = read(f);
		const hits = runScripts(text).filter((s) => /\$\{\{/.test(s.text)).map((s) => s.line);
		ok(hits.length === 0, `§7 ${f}: no expression inside a run: script — pass it through env: (run: at line ${hits.join(", ")})`);
		ok(!/\bssh\s+-i\b/.test(noComments(text)), `§7 ${f}: no bare \`ssh -i\` — every connection goes through scripts/deploy/ssh-retry.sh`);
	}

	// ── backup-freshness.yml: read-only, so it must never share the deploy
	// queue or the box's deploy lock, and it reaches the box exactly the way a
	// deploy does.
	const backup = read(".github/workflows/backup-freshness.yml");
	const cb = conc(backup);
	ok(cb.group && cb.group !== cd.group && !/\$\{\{/.test(cb.group),
		`§7 backup-freshness.yml keeps its OWN literal concurrency group, never deploy.yml's (got ${cb.group}; deploy group ${cd.group})`);
	ok(cb.noCancel, "§7 backup-freshness.yml never cancels an in-progress check");
	const bRuns = runScripts(backup);
	const bNoComments = noComments(backup);
	ok(/VPS_SSH_KEY:\s*\$\{\{\s*secrets\.VPS_SSH_KEY\s*\}\}/.test(bNoComments)
		&& /VPS_SSH_KNOWN_HOSTS:\s*\$\{\{\s*secrets\.VPS_SSH_KNOWN_HOSTS\s*\}\}/.test(bNoComments)
		&& bRuns.some((s) => /^\s*bash scripts\/deploy\/ssh-setup\.sh\s*$/.test(s.text)),
		"§7 backup-freshness.yml writes its key through ssh-setup.sh, secrets in env: (the host key is pinned and an empty one is refused)");
	const sshRun = bRuns.find((s) => /scripts\/deploy\/ssh-retry\.sh/.test(s.text));
	ok(sshRun && /<\s*scripts\/deploy\/remote-backup-check\.sh/.test(sshRun.text),
		"§7 backup-freshness.yml reaches the box through ssh-retry.sh, piping remote-backup-check.sh");
	ok(!bRuns.some((s) => />\s*~\/\.ssh\//.test(s.text)), "§7 backup-freshness.yml never writes ~/.ssh itself — only ssh-setup.sh does");
	ok(/if:\s*always\(\)\s*\n\s*run:\s*shred -u ~\/\.ssh\/deploy_key/.test(bNoComments), "§7 backup-freshness.yml always shreds the deploy key");
	const remoteCheck = noComments(read("scripts/deploy/remote-backup-check.sh"));
	ok(!/\bflock\b|deploy-lock|DEPLOY_LOCK_DIR|logisx-deploy/.test(remoteCheck),
		"§7 remote-backup-check.sh never takes the deploy lock (a read-only check must not block or queue a deploy)");
	ok(!/\bpm2\b|\bgit\b|(^|[;&|(]\s*|\s)(rm|mv|cp|truncate|tee)\s/m.test(remoteCheck),
		"§7 remote-backup-check.sh stays read-only: no pm2, git, rm, mv, cp, truncate or tee");

	// ── remote-backup-check.sh reads backup.sh's failures, all of them. backup.sh
	// writes two shapes — "[backup] backup FAILED with exit code N" when the
	// snapshot fails, "[backup] FAILED: <why>" when it cannot start — and the check
	// used to grep for the first only, so a run that never started read as fine.
	// The pattern is taken out of the script and run through real `grep -E`.
	const failedRe = (remoteCheck.match(/^FAILED_RE='([^']+)'$/m) || [])[1];
	ok(!!failedRe, "§7 remote-backup-check.sh names its failure pattern once (FAILED_RE)");
	const grepCount = (line) => {
		const r = require("child_process").spawnSync("grep", ["-cE", failedRe || "^$"], { input: `${line}\n`, encoding: "utf8" });
		return Number(String(r.stdout).trim());
	};
	ok(grepCount("[backup] backup FAILED with exit code 1") === 1, "§7 the check sees '[backup] backup FAILED with exit code N'");
	ok(grepCount("[backup] FAILED: no node on this box can load better-sqlite3") === 1, "§7 the check sees '[backup] FAILED: <why>' (a run that never started)");
	ok(grepCount("[backup] completed: Tue Sep 23 02:03:11 UTC 2026") === 0, "§7 …and not a completed run");
	ok(!/\\\]/.test(failedRe || ""), "§7 the pattern spells ']' as []], never \\] (newer GNU grep warns on a stray backslash)");
	// The failure COUNT is per run: a failed snapshot writes backup-db.js's
	// "[backup] FAILED: <why>" AND backup.sh's "backup FAILED with exit code N" into
	// the same run, and counting lines made one bad night read as two.
	const countProg = (remoteCheck.match(/^COUNT_FAILED_RUNS='([^']+)'$/m) || [])[1];
	ok(!!countProg && countProg.includes(failedRe || "\u0000"), "§7 the failed-run count groups by run header and uses the same failure pattern");
	ok(/^FAILS=\$\(awk "\$COUNT_FAILED_RUNS" backup\.log/m.test(remoteCheck), "§7 BACKUP_TOTAL_FAILURES comes from that per-run count");
	const runLog = [
		"[backup] ---- 2026-09-20 02:00:00 UTC ----", "[backup] completed: ok",
		"[backup] ---- 2026-09-21 02:00:00 UTC ----", "[backup] FAILED: integrity_check failed", "[backup] backup FAILED with exit code 1",
		"[backup] ---- 2026-09-22 02:00:00 UTC ----", "[backup] completed: ok",
		"[backup] ---- 2026-09-23 02:00:00 UTC ----", "[backup] FAILED: no node on this box can load better-sqlite3", "[backup]   tried pm2 exec_interpreter",
		"[backup] ---- 2026-09-24 02:00:00 UTC ----", "[backup] backup FAILED with exit code 3",
	].join("\n") + "\n";
	const awkCount = (prog, input) => Number(String(require("child_process").spawnSync("awk", [prog || "BEGIN{print -1}"], { input, encoding: "utf8" }).stdout).trim());
	// Each shape has a night to itself (09-23, 09-24), so missing either one shows.
	ok(awkCount(countProg, runLog) === 3, `§7 three bad nights count 3, not the 4 failure lines they wrote (got ${awkCount(countProg, runLog)})`);
	ok(awkCount(countProg, "[backup] ---- 2026-09-23 02:00:00 UTC ----\n[backup] completed: ok\n") === 0, "§7 …and a clean log counts 0");
	// Age is floored to whole hours. At the 04:00 check a missed 02:00 run is ~25h59m
	// old (25) and the newest healthy one at most ~24 h (a check just before 02:00).
	const maxAge = Number((remoteCheck.match(/^MAX_AGE_H=\$\{MAX_AGE_H:-(\d+)\}[ \t]*$/m) || [])[1]);
	ok(maxAge <= Math.floor((25 * 3600 + 59 * 60) / 3600),
		`§7 a missed night is stale at the very next 04:00 check (limit ${maxAge} h must be ≤ 25)`);
	ok(maxAge > Math.floor((23 * 3600 + 59 * 60) / 3600) && maxAge >= 24,
		`§7 …while a snapshot from last night never is (limit ${maxAge} h must be ≥ 24)`);
}

async function mutants() {
	// The shebang is legal only at the top of a FILE, not inside a function body.
	const src = fs.readFileSync(GATE_PATH, "utf8").replace(/^#!.*\n/, "\n");
	const load = (code) => {
		const m = { exports: {} };
		new Function("module", "exports", "require", code)(m, m.exports, require);
		return m.exports;
	};
	const cases = [
		["heals on a staging failure", src.replace('case "failed":\n\t\t\treturn "behind-staging-failed";', 'case "failed":\n\t\t\treturn "behind-healable";'), checkRefine],
		["unknown states heal", src.replace(': "alarm";\n}', ': "heal";\n}'), checkActionTable],
		["trusts runs for other commits", src.replace('(!sha || r.head_sha === sha)', "true"), checkVerdicts],
		["any conclusion passes", src.replace('if (staging.conclusion === "success") {', "if (true) {"), checkVerdicts],
		["oldest run wins", src.replace(".sort((a, b) => Number(b.id || 0) - Number(a.id || 0));\n\tif (candidates", ".sort((a, b) => Number(a.id || 0) - Number(b.id || 0));\n\tif (candidates"), checkVerdicts],
		// The two this gate's re-run rests on.
		["every staging failure reads as never reaching the VPS", src.replace("if (Array.isArray(notes) && neverReachedVps(notes)) {", "if (true) {"), checkVerdicts],
		["the attempt count is ignored (re-runs a Deploy run forever)", src.replace('return runAttempt === 1 ? "behind-staging-unreached"', 'return true ? "behind-staging-unreached"'), checkRefine],
		["a warning counts as the give-up line", src.replace('a.annotation_level === "failure" &&', ""), checkVerdicts],
		["the title rule is dropped", src.replace("(a.title === UNREACHED_TITLE || ", "(false || "), checkVerdicts],
		["the message-prefix rule is dropped (older runs stop classifying)", src.replace(' || String(a.message || "").startsWith(UNREACHED_MESSAGE_PREFIX))', ")"), checkVerdicts],
		// Pending first, and never keyed on the staging job's own attempt.
		["the pending-first precheck is dropped", src.replace("if (PENDING.has(run.status)) {\n\t\tconst attempt", "if (false) {\n\t\tconst attempt"), checkVerdicts],
		["the verdict requires the staging job's attempt to equal the run's",
			src.replace('if (staging && staging.status === "completed") {', 'if (staging && staging.status === "completed" && staging.run_attempt === run.run_attempt) {'), checkVerdicts],
	];
	for (const [name, code, suite] of cases) {
		ok(code !== src, `§8 mutant '${name}' must actually differ from the source (update the mutant if the code moved)`);
		const results = suite(load(code), "[mutant] ");
		ok(results.some(([c]) => !c), `§8 mutant '${name}' must be caught by the assertions above`);
	}
	// Fail-open on an unreadable lookup: a transport failure assumed, not seen.
	const failOpen = src.replace(
		"annotationsByJob[staging.id] = { error: err && err.message ? err.message : String(err) };",
		'annotationsByJob[staging.id] = [{ annotation_level: "failure", title: UNREACHED_TITLE, message: "" }];'
	);
	ok(failOpen !== src, "§8 mutant 'unreadable annotations read as unreached' must actually differ from the source");
	ok((await checkAnnotationLookup(load(failOpen), "[mutant] ")).some(([c]) => !c), "§8 mutant 'unreadable annotations read as unreached' must be caught by §4");
	const readsQueued = src.replace("\t\t\tnewest.status === \"completed\" &&\n", "");
	ok(readsQueued !== src, "§8 mutant 'annotations read for a run that is not completed' must actually differ from the source");
	ok((await checkAnnotationLookup(load(readsQueued), "[mutant] ")).some(([c]) => !c), "§8 mutant 'annotations read for a run that is not completed' must be caught by §4");

	// deploy.yml's staging-before-production gate (§7), mutated in memory only.
	const deployText = fs.readFileSync(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8");
	for (const [name, from, to] of [
		["production no longer needs staging to SUCCEED", " && needs.staging.result == 'success'", ""],
		["production no longer needs staging at all", "    needs: [staging]\n", ""],
	]) {
		const m = deployText.split(from).join(to);
		ok(m !== deployText, `§8 mutant '${name}' must actually differ from deploy.yml (update it if the job moved)`);
		ok(checkProductionGate(m, "[mutant] ").some(([c]) => !c), `§8 mutant '${name}' must be caught by §7`);
	}

	// The rerun job's own guards (§9).
	const script = rerunScript();
	for (const [name, from, to] of [
		["the rerun job skips its compare-and-swap", 'if [ "$run_attempt $run_status" != "1 completed" ]; then', "if false; then"],
		["the rerun job skips the identity check", 'if [ "$run_event $run_branch $run_path $run_sha" != "push main .github/workflows/deploy.yml $MAIN" ]; then', "if false; then"],
		["the rerun job skips the newest-run check (re-runs after main moved on)", 'if [ "$newest" != "$RUN_ID" ]; then', "if false; then"],
		["the rerun job trusts its inputs", 'if ! [[ "$RUN_ID" =~ ^[0-9]+$ && "$ATTEMPT" == "1" && "$MAIN" =~ ^[0-9a-f]{40}$ ]]; then', "if false; then"],
		["the rerun job re-runs the whole run, not its failed jobs", "/rerun-failed-jobs\"", "/rerun\""],
	]) {
		const m = script.split(from).join(to);
		ok(m !== script, `§8 mutant '${name}' must actually differ from the script (update it if the step moved)`);
		ok(checkRerunScript(m, "[mutant] ").some(([c]) => !c), `§8 mutant '${name}' must be caught by §9`);
	}
}

// ─────────────────────────────────────────── §9 the rerun job's own script
// Runs the REAL step text from deploy-drift.yml under bash, with `gh` stubbed
// on PATH. The stub logs every call and answers the two reads the step makes:
// the run itself (STUB_GH_RUN, the six fields its --jq prints) and main's
// newest push-triggered Deploy run (STUB_GH_NEWEST).
function rerunScript() {
	const drift = fs.readFileSync(path.join(ROOT, ".github/workflows/deploy-drift.yml"), "utf8");
	const scripts = runScripts(jobBlocks(drift).rerun || "");
	return scripts.length === 1 ? scriptOf(scripts[0]) : "";
}

// ⚠️ ONE stub for the whole process, never one per run. macOS vets every newly
// written executable the first time it runs (~150 ms each), and a fresh stub
// per run made this runner 30× slower. The stub takes everything that varies
// from its environment instead.
let ghStub = null;
function ghStubDir() {
	if (ghStub) return ghStub;
	ghStub = fs.mkdtempSync(path.join(os.tmpdir(), "drift-gh-stub-"));
	const dir = ghStub;
	process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "gh"), [
		"#!/bin/bash",
		"printf '%s|token=%s\\n' \"$*\" \"${GH_TOKEN:+set}\" >> \"$STUB_GH_LOG\"",
		"if [ \"$2\" = \"-X\" ]; then exit \"$STUB_GH_POST_CODE\"; fi",
		"case \"$2\" in",
		"\t*/actions/workflows/*) [ \"$STUB_GH_NEWEST_CODE\" = 0 ] || exit \"$STUB_GH_NEWEST_CODE\"; printf '%s\\n' \"$STUB_GH_NEWEST\" ;;",
		"\t*) [ \"$STUB_GH_GET_CODE\" = 0 ] || exit \"$STUB_GH_GET_CODE\"; printf '%s\\n' \"$STUB_GH_RUN\" ;;",
		"esac",
		"",
	].join("\n"), { mode: 0o755 });
	return dir;
}

// What the step's first read prints for run 123 when all is well, with any
// field overridden.
function runAnswer(over = {}) {
	const f = { attempt: "1", status: "completed", event: "push", branch: "main", path: ".github/workflows/deploy.yml", sha: SHA, ...over };
	return `${f.attempt} ${f.status} ${f.event} ${f.branch} ${f.path} ${f.sha}`;
}

function runRerun(script, { runId = "123", attempt = "1", main = SHA, ghRun = runAnswer(), ghNewest = "123", getCode = 0, newestCode = 0, postCode = 0 } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-rerun-"));
	try {
		const log = path.join(dir, "gh.log");
		const summary = path.join(dir, "summary.md");
		fs.writeFileSync(summary, "");
		const step = path.join(dir, "step.sh");
		fs.writeFileSync(step, script);
		// bash -e {0} is how the runner executes a run: step with no shell: set.
		const r = spawnSync("bash", ["-e", step], {
			encoding: "utf8",
			timeout: 20000,
			env: {
				PATH: `${ghStubDir()}:${process.env.PATH}`,
				GH_TOKEN: "stub-token",
				RUN_ID: runId,
				ATTEMPT: attempt,
				MAIN: main,
				GITHUB_REPOSITORY: "o/r",
				GITHUB_SERVER_URL: "https://github.example",
				GITHUB_STEP_SUMMARY: summary,
				STUB_GH_LOG: log,
				STUB_GH_RUN: ghRun,
				STUB_GH_NEWEST: ghNewest,
				STUB_GH_GET_CODE: String(getCode),
				STUB_GH_NEWEST_CODE: String(newestCode),
				STUB_GH_POST_CODE: String(postCode),
			},
		});
		const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
		return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, calls, summary: fs.readFileSync(summary, "utf8") };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function checkRerunScript(script, tag = "") {
	const r = [];
	const posts = (x) => x.calls.filter((c) => /^api -X POST /.test(c));
	// All is well: read the run back, read main's newest Deploy run, ONE POST.
	let x = runRerun(script);
	r.push([x.code === 0 && posts(x).length === 1 && posts(x)[0] === "api -X POST repos/o/r/actions/runs/123/rerun-failed-jobs|token=set",
		`${tag}§9 main's own run, attempt 1, completed, still newest → exactly one POST to repos/o/r/actions/runs/123/rerun-failed-jobs, with the token (code ${x.code}, calls ${JSON.stringify(x.calls)})`]);
	r.push([x.calls.length === 3
		&& x.calls[0].startsWith("api repos/o/r/actions/runs/123 --jq ")
		&& x.calls[1].startsWith("api repos/o/r/actions/workflows/deploy.yml/runs?branch=main&event=push&per_page=1 --jq "),
	`${tag}§9 …only after reading the run back and then main's newest Deploy run (calls ${JSON.stringify(x.calls)})`]);
	r.push([/^::warning::.*never reached the VPS/m.test(x.out) && /runs\/123/.test(x.out), `${tag}§9 …warns what it re-runs and why, with a link`]);
	r.push([/\[123\]\(https:\/\/github\.example\/o\/r\/actions\/runs\/123\)/.test(x.summary) && /requested/.test(x.summary), `${tag}§9 …and writes a step-summary row`]);

	// Identity: the run must still be main's push-triggered Deploy run for the
	// checked commit. Each mismatch is an error, and nothing is re-run.
	for (const [what, over] of [
		["a workflow_dispatch run", { event: "workflow_dispatch" }],
		["a run on another branch", { branch: "feature" }],
		["a run of another workflow", { path: ".github/workflows/ci.yml" }],
		["a run for another commit", { sha: OTHER }],
	]) {
		x = runRerun(script, { ghRun: runAnswer(over) });
		r.push([x.code !== 0 && posts(x).length === 0 && /^::error::run 123 is not main's push-triggered Deploy run/m.test(x.out),
			`${tag}§9 the run reads back as ${what} → error, ZERO re-runs (code ${x.code}, posts ${posts(x).length})`]);
	}

	// Re-run since the check: that was its one re-run. Notice, no failure.
	for (const [attempt, status] of [["2", "completed"], ["2", "in_progress"], ["2", "queued"], ["1", "in_progress"]]) {
		x = runRerun(script, { ghRun: runAnswer({ attempt, status }) });
		r.push([x.code === 0 && posts(x).length === 0 && x.calls.length === 1,
			`${tag}§9 the run reads attempt ${attempt} '${status}' now: re-run since the check → ZERO re-runs, no failure (code ${x.code}, calls ${x.calls.length})`]);
	}
	x = runRerun(script, { ghRun: runAnswer({ attempt: "2" }) });
	r.push([/^::notice::.*re-run since the check/m.test(x.out) && /re-run since the check/.test(x.summary), `${tag}§9 …it says so, in the log and the summary`]);

	// Main moved on: a newer push-triggered Deploy run exists, and it decides.
	x = runRerun(script, { ghNewest: "124" });
	r.push([x.code === 0 && posts(x).length === 0 && /^::notice::main moved on/m.test(x.out) && /main moved on/.test(x.summary),
		`${tag}§9 main's newest Deploy run is 124, not 123 → ZERO re-runs, a notice and a summary row (code ${x.code}, posts ${posts(x).length})`]);

	// Answers that are not the expected shape fail loudly, re-running nothing.
	for (const garbled of ["", `null completed push main .github/workflows/deploy.yml ${SHA}`, "1 completed", `${runAnswer()} extra`]) {
		x = runRerun(script, { ghRun: garbled });
		r.push([x.code !== 0 && posts(x).length === 0, `${tag}§9 a run answer shaped unlike the six fields (${JSON.stringify(garbled.slice(0, 40))}) → fails loudly (code ${x.code})`]);
	}
	for (const garbled of ["", "null", "12x"]) {
		x = runRerun(script, { ghNewest: garbled });
		r.push([x.code !== 0 && posts(x).length === 0, `${tag}§9 a newest-run answer of ${JSON.stringify(garbled)} → fails loudly, ZERO re-runs (code ${x.code})`]);
	}

	// Inputs from the check job, refused before any gh call.
	for (const bad of ["", "12a", "123 ", "1;rm -rf /", "../123", "$(id)"]) {
		x = runRerun(script, { runId: bad });
		r.push([x.code !== 0 && x.calls.length === 0, `${tag}§9 run id ${JSON.stringify(bad)} → refused before any gh call (code ${x.code}, calls ${x.calls.length})`]);
	}
	for (const bad of ["", "2", "0", "01", "1 "]) {
		x = runRerun(script, { attempt: bad });
		r.push([x.code !== 0 && x.calls.length === 0, `${tag}§9 attempt ${JSON.stringify(bad)} → refused: the gate only ever re-runs attempt 1 (code ${x.code})`]);
	}
	for (const bad of ["", "abc", SHA.slice(0, 7), SHA.toUpperCase(), `${SHA}0`, `${SHA} `]) {
		x = runRerun(script, { main: bad });
		r.push([x.code !== 0 && x.calls.length === 0, `${tag}§9 main ${JSON.stringify(bad.length > 12 ? `${bad.slice(0, 8)}…(${bad.length})` : bad)} → refused: a full lowercase SHA only (code ${x.code})`]);
	}

	// A call that fails fails the job; nothing is re-run on half an answer.
	x = runRerun(script, { getCode: 1 });
	r.push([x.code !== 0 && posts(x).length === 0, `${tag}§9 reading the run back fails → the job fails and re-runs nothing`]);
	x = runRerun(script, { newestCode: 1 });
	r.push([x.code !== 0 && posts(x).length === 0, `${tag}§9 reading main's newest Deploy run fails → the job fails and re-runs nothing`]);
	x = runRerun(script, { postCode: 1 });
	r.push([x.code !== 0, `${tag}§9 the re-run request fails → the job fails loudly`]);
	return r;
}

function report() {
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
}
