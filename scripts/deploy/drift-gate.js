#!/usr/bin/env node
"use strict";
/**
 * The STAGING GATE on deploy-drift.yml's heal. Runs ON THE GITHUB RUNNER.
 *
 * WHY IT EXISTS
 * -------------
 * deploy.yml lets production take a push only after staging went green
 * (`needs: staging`). A drift heal must honour the same prerequisite, and the
 * box cannot see staging's verdict. So before any heal, this asks GitHub one
 * question: did THIS EXACT commit pass the `staging` job of a push-triggered
 * Deploy run? Only "yes" heals. Every other answer is a state of its own, and
 * every one of them is FAIL-CLOSED. None heals, and all but "still running"
 * and "staging never reached the VPS" raise an alarm.
 *
 * "Staging never reached the VPS" is the one "no" that is not a verdict at
 * all: the runner could not open an ssh connection, so staging neither
 * deployed nor rejected the commit. That Deploy run is re-run ONCE instead
 * (action `rerun`), and staging still decides: the re-run deploys and
 * smoke-checks staging first, and production follows only if it passes.
 *
 * It also owns the state → action table, so the workflow YAML only branches
 * on one value (`action`) and the table is unit-tested
 * (scripts/test-drift-gate.js) instead of spread across `if:` expressions.
 *
 * USAGE (deploy-drift.yml)
 *   BOX_STATE=<state from remote-drift-check.sh> TARGET_SHA=<origin/main sha>
 *   GITHUB_REPOSITORY=owner/repo
 *   GITHUB_TOKEN=<workflow token, actions: read + checks: read>
 *   node scripts/deploy/drift-gate.js
 * Prints DRIFT_STATE / DRIFT_ACTION / GATE_VERDICT / GATE_DETAIL lines (plus
 * GATE_URL / GATE_RUN_ID / GATE_RUN_ATTEMPT when known) and, when
 * $GITHUB_OUTPUT is set, appends state, action, verdict, detail, url, hint,
 * run_id and run_attempt.
 */

// ⚠️ deploy.yml's staging job is looked up BY NAME. Renaming it (the `name:`,
// not the job id) makes every heal fail closed as unverified until this moves
// with it. scripts/test-drift-gate.js pins the two together.
const DEPLOY_WORKFLOW_FILE = "deploy.yml";
const STAGING_JOB_NAME = "staging";

const SHA_RE = /^[0-9a-f]{40}$/;

// ⚠️ How a staging job that NEVER REACHED THE VPS is told apart from one that
// failed for real. scripts/deploy/ssh-retry.sh prints this ::error:: line only
// after every one of its transport retries has failed, so a staging job whose
// deploy or smoke script actually said no never carries it and still alarms.
// Either rule is enough:
//   - the title, which ssh-retry.sh prints from 2026-09-24 on;
//   - the message prefix, because before that ssh-retry.sh printed the SAME
//     message without a title, and runs from then must classify too.
// scripts/test-deploy-scripts.js runs ssh-retry.sh and feeds the line it
// prints back through neverReachedVps(), so the two cannot drift apart.
// An annotation is a hint, not proof; that is enough here because acting on
// it only ever re-runs the Deploy run once, and the re-run still goes through
// staging before production.
const UNREACHED_TITLE = "VPS unreachable";
const UNREACHED_MESSAGE_PREFIX = "ssh failed to connect after ";

// What the workflow does with each state. Anything not listed (an unknown or
// empty state, e.g. unparseable ssh output) must ALARM, never heal.
const ACTIONS = Object.freeze({
	"in-sync": "none",
	"behind-healable": "heal",
	"behind-staging-pending": "notice",
	"behind-staging-unreached": "rerun",
	"behind-already-attempted": "alarm",
	"behind-and-unhealthy": "alarm",
	"behind-staging-failed": "alarm",
	"behind-staging-unverified": "alarm",
	"behind-staging-unreached-retried": "alarm",
	"verified-record-inconsistent": "alarm",
});

const HINTS = Object.freeze({
	"in-sync": "production is on main.",
	"behind-healable":
		"production's last verified deploy is behind main but it is serving, and main's commit PASSED staging: the shape of a deploy that failed on transport, or one that died after its checkout (HEAD moved, never verified). Healing once, a full deploy of main's commit with the same smoke check, edge check and auto-rollback as deploy.yml.",
	"behind-staging-pending":
		"production is behind main, but the Deploy run for main's commit has not finished its staging job yet. The deploy is still on its way; the next tick re-checks.",
	"behind-already-attempted":
		"an automatic attempt at main's commit is already recorded on the box: an earlier heal, a production auto-rollback, or a manual pin to another ref. Not retrying. Fix main, or deploy it by hand once it is safe (Actions → Deploy → production, ref=main).",
	"behind-and-unhealthy":
		"production is behind main AND not serving 200. That is an incident, not a missed deploy; healing would paper over it.",
	"behind-staging-failed":
		"staging REJECTED main's commit, so production must not get it. Fix main; the next green staging deploys production normally.",
	"behind-staging-unverified":
		"no staging verdict exists for main's commit (no push-triggered Deploy run, e.g. [skip ci], or the GitHub API lookup failed). Not healing without one.",
	"behind-staging-unreached":
		"production is behind main because main's staging job never reached the VPS: every ssh attempt exited 255 and ssh-retry.sh gave up, so staging produced no verdict at all. Re-running that Deploy run's failed jobs once. Staging deploys and smoke-checks the same commit again, and production follows only if staging passes.",
	"behind-staging-unreached-retried":
		"main's staging job never reached the VPS (every ssh attempt exited 255), and its Deploy run is already past its first attempt (a re-run, automatic or by hand, already happened) or reports no attempt number. Not re-running it again. 255 is not only the network: a refused deploy key, a changed host key and a dropped session end the same way. Check those, then re-run it by hand: gh run rerun <run-id> --failed.",
	"verified-record-inconsistent":
		"production's record of its last verified deploy (git ref refs/logisx/verified-deploy) names a commit HEAD does not contain, or no commit at all: HEAD was moved back past it outside the deploy scripts, a manual deploy of an older ref died after its checkout, or a verified pin off main was followed by a deploy of main that died after its checkout. Which commit serves is unknown, so nothing heals. Check the box, then deploy main by hand (Actions → Deploy → production, ref=main); a verified deploy rewrites the record.",
});

const PENDING = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

function actionFor(state) {
	return Object.prototype.hasOwnProperty.call(ACTIONS, state) ? ACTIONS[state] : "alarm";
}

function hintFor(state) {
	return HINTS[state] || `unrecognised drift state '${state}' — treated as an alarm.`;
}

/**
 * The box's verdict (remote-drift-check.sh) refined by the staging verdict.
 * Only `behind-healable` can change. The box's own alarms always win, and an
 * in-sync box never needs the API at all.
 *
 * `runAttempt` (the Deploy run's own `run_attempt`) matters only for
 * `unreached`. It is GitHub's count of how many times that run has been run,
 * automatic or by hand, so exactly 1 means nobody has re-run it yet and one
 * re-run is allowed. That counter is the "once": unlike the heal, the re-run
 * needs no marker on the box. Anything else alarms, including a missing or
 * non-numeric value, because a re-run that has already failed to reach the VPS
 * needs a human, not a loop.
 */
function refineState(boxState, verdict, runAttempt) {
	if (boxState !== "behind-healable") return boxState;
	switch (verdict) {
		case "passed":
			return "behind-healable";
		case "pending":
			return "behind-staging-pending";
		case "failed":
			return "behind-staging-failed";
		case "unreached":
			return runAttempt === 1 ? "behind-staging-unreached" : "behind-staging-unreached-retried";
		default:
			return "behind-staging-unverified";
	}
}

// One copy of "which job is staging", for the verdict and for the lookup that
// decides whether to fetch its annotations.
function findStagingJob(jobs) {
	return (Array.isArray(jobs) ? jobs : []).find((j) => j && j.name === STAGING_JOB_NAME);
}

/**
 * Pure. `annotations` = a failed staging job's check-run annotations. True
 * when one of them is ssh-retry.sh's give-up line (see UNREACHED_TITLE).
 *
 * ⚠️ Failure level only. ssh-retry.sh prints a warning on every retry it
 * survives, so a job that reconnected and then failed for real carries
 * warnings too; only the error it prints after the LAST attempt means the
 * runner never got through.
 */
function neverReachedVps(annotations) {
	return (Array.isArray(annotations) ? annotations : []).some(
		(a) =>
			!!a &&
			a.annotation_level === "failure" &&
			(a.title === UNREACHED_TITLE || String(a.message || "").startsWith(UNREACHED_MESSAGE_PREFIX))
	);
}

/**
 * Pure. `runs` = workflow_runs from the list-runs API; `jobsByRun` = { [runId]:
 * jobs[] } from the list-jobs API (filter=latest, i.e. the newest attempt);
 * `annotationsByJob` = { [jobId]: annotations[] } for a staging job that
 * concluded `failure`, or { [jobId]: { error } } when they could not be read.
 *
 * Only the NEWEST push-triggered run for the SHA counts. A newer attempt at the
 * same commit supersedes an older one: if it failed, an older success must not
 * sneak a heal through.
 *
 * Every verdict about a run carries its id and run_attempt (runId, runAttempt):
 * refineState() needs the attempt, and deploy-drift.yml's rerun job the id.
 */
function stagingVerdict(runs, jobsByRun, sha, annotationsByJob) {
	const candidates = (Array.isArray(runs) ? runs : [])
		.filter((r) => r && r.event === "push" && (!sha || r.head_sha === sha))
		.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
	if (candidates.length === 0) {
		return { verdict: "unverified", detail: "no push-triggered Deploy run exists for this commit", url: "" };
	}
	const run = candidates[0];
	const jobs = (jobsByRun && jobsByRun[run.id]) || [];
	const staging = findStagingJob(jobs);
	const url = (staging && staging.html_url) || run.html_url || "";
	const ids = { runId: run.id, runAttempt: run.run_attempt };
	// ⚠️ PENDING FIRST, before any job is read. A run that is not completed
	// has not given its answer yet. A re-run still waiting in the queue lists
	// its PREVIOUS attempt's jobs, finished and maybe failed, and reading
	// those as its verdict would alarm on (or re-run, or heal) a run that is
	// about to answer for itself. While a drift run executes it holds the
	// shared concurrency group, so any Deploy run it sees is either completed
	// or queued behind it, and a queued one is on its way.
	// Never key this on the staging JOB's run_attempt instead: after a re-run
	// of production alone, staging keeps attempt 1 in a run on attempt 2, and
	// its pass must still count (the heal).
	if (PENDING.has(run.status)) {
		const attempt = Number.isSafeInteger(run.run_attempt) ? run.run_attempt : "unknown";
		return {
			verdict: "pending",
			detail: `Deploy run ${run.id} (attempt ${attempt}) is '${run.status}': its jobs are not its final answer yet`,
			// The run, not a job: the job listed may be a previous attempt's.
			url: run.html_url || url,
			...ids,
		};
	}
	if (staging && staging.status === "completed") {
		if (staging.conclusion === "success") {
			return { verdict: "passed", detail: `staging succeeded in Deploy run ${run.id}`, url, ...ids };
		}
		// Only `failure` can be a job that never got through: ssh-retry.sh gives
		// up with exit 255, which fails the step. A cancelled or timed-out
		// staging job stays `failed` whatever its annotations say.
		const notes =
			staging.conclusion === "failure" && annotationsByJob && Object.prototype.hasOwnProperty.call(annotationsByJob, staging.id)
				? annotationsByJob[staging.id]
				: undefined;
		if (Array.isArray(notes) && neverReachedVps(notes)) {
			const attempt = Number.isSafeInteger(run.run_attempt) ? run.run_attempt : "unknown";
			return { verdict: "unreached", detail: `staging never reached the VPS in Deploy run ${run.id} (attempt ${attempt})`, url, ...ids };
		}
		// ⚠️ Annotations that could not be read leave the verdict at `failed`,
		// exactly as before they were consulted: without them a transport
		// failure cannot be told from a real one, and only a real one is safe
		// to assume.
		const unread = notes && !Array.isArray(notes) && notes.error
			? `; its annotations could not be read (${notes.error}), so a transport failure cannot be told from a real one`
			: "";
		return { verdict: "failed", detail: `staging concluded '${staging.conclusion}' in Deploy run ${run.id}${unread}`, url, ...ids };
	}
	if (staging) {
		return {
			verdict: "pending",
			detail: `Deploy run ${run.id} is '${run.status}', staging job '${staging.status}'`,
			url,
			...ids,
		};
	}
	// Completed run, no staging job at all: an invalid workflow file, a
	// startup failure, a run cancelled before its first job, or a renamed job.
	return {
		verdict: "failed",
		detail: `Deploy run ${run.id} completed ('${run.conclusion}') without a '${STAGING_JOB_NAME}' job`,
		url,
		...ids,
	};
}

class FatalHttpError extends Error {}

async function getJson(url, { token, fetchImpl, sleepImpl, backoffMs = [2000, 5000], timeoutMs = 15000 }) {
	const headers = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "logisx-deploy-drift",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	let lastErr;
	for (const wait of [0, ...backoffMs]) {
		if (wait) await sleepImpl(wait);
		try {
			const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
			if (res.status === 429 || res.status >= 500) {
				lastErr = new Error(`HTTP ${res.status} from ${url}`);
				continue;
			}
			// Any other non-2xx will not fix itself on a retry (401/403/404).
			if (!res.ok) throw new FatalHttpError(`HTTP ${res.status} from ${url}`);
			return await res.json();
		} catch (err) {
			if (err instanceof FatalHttpError) throw err;
			lastErr = err;
		}
	}
	throw lastErr;
}

async function lookupStaging({
	repo,
	sha,
	token,
	apiBase = "https://api.github.com",
	fetchImpl = globalThis.fetch,
	sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
	backoffMs,
	missingRetryMs = 20000,
}) {
	const opts = { token, fetchImpl, sleepImpl, backoffMs };
	const base = apiBase.replace(/\/+$/, "");
	const runsUrl =
		`${base}/repos/${repo}/actions/workflows/${DEPLOY_WORKFLOW_FILE}/runs` +
		`?head_sha=${encodeURIComponent(sha)}&event=push&per_page=20`;
	// ⚠️ Filtered again client-side. If the API ever ignored head_sha, the
	// newest run for SOME OTHER commit could otherwise approve this one.
	const listRuns = async () => {
		const body = await getJson(runsUrl, opts);
		const all = Array.isArray(body && body.workflow_runs) ? body.workflow_runs : [];
		const newestRun = all
			.filter((r) => r && r.event === "push" && r.head_sha === sha)
			.sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
		return { all, newestRun };
	};
	let { all: runs, newestRun: newest } = await listRuns();
	// A push's Deploy run appears a few seconds after the push. A drift run that
	// reads the box in that gap would find no run and raise a false alarm, so
	// look once more after a short wait. Waiting a fixed time on each lookup
	// does not depend on how often the schedule fires; a commit time would.
	if (!newest && missingRetryMs > 0) {
		await sleepImpl(missingRetryMs);
		({ all: runs, newestRun: newest } = await listRuns());
	}
	const jobsByRun = {};
	const annotationsByJob = {};
	if (newest) {
		const jobsBody = await getJson(
			`${base}/repos/${repo}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`,
			opts
		);
		jobsByRun[newest.id] = Array.isArray(jobsBody && jobsBody.jobs) ? jobsBody.jobs : [];
		// A FAILED staging job's annotations say whether it failed or never got
		// through (neverReachedVps). A job's id is its check-run id. Only a
		// COMPLETED run's failed staging job costs this third call: a pass, a
		// run still queued or running (whose jobs may be a previous attempt's,
		// see stagingVerdict) and an in-sync box never make it.
		const staging = findStagingJob(jobsByRun[newest.id]);
		if (
			newest.status === "completed" &&
			staging && staging.status === "completed" && staging.conclusion === "failure" &&
			/^\d+$/.test(String(staging.id))
		) {
			try {
				const notes = await getJson(`${base}/repos/${repo}/check-runs/${staging.id}/annotations?per_page=100`, opts);
				annotationsByJob[staging.id] = Array.isArray(notes) ? notes : { error: "the annotations response was not a list" };
			} catch (err) {
				// Fail closed: the verdict stays `failed` (an alarm), as it was
				// before annotations were read at all.
				annotationsByJob[staging.id] = { error: err && err.message ? err.message : String(err) };
			}
		}
	}
	return stagingVerdict(runs, jobsByRun, sha, annotationsByJob);
}

/** The whole decision, with the network injected. Never throws. */
async function decide({ boxState, targetSha, repo, token, apiBase, fetchImpl, sleepImpl, backoffMs, missingRetryMs }) {
	let gate = { verdict: "", detail: "not needed", url: "" };
	if (boxState === "behind-healable") {
		if (!SHA_RE.test(targetSha || "")) {
			gate = { verdict: "unverified", detail: `the drift check reported no usable main SHA ('${targetSha || ""}')`, url: "" };
		} else if (!repo) {
			gate = { verdict: "unverified", detail: "GITHUB_REPOSITORY is not set", url: "" };
		} else {
			try {
				gate = await lookupStaging({ repo, sha: targetSha, token, apiBase, fetchImpl, sleepImpl, backoffMs, missingRetryMs });
			} catch (err) {
				gate = { verdict: "unverified", detail: `GitHub API lookup failed: ${err && err.message ? err.message : err}`, url: "" };
			}
		}
	}
	const state = refineState(boxState || "", gate.verdict, gate.runAttempt);
	return { state, action: actionFor(state), hint: hintFor(state), ...gate };
}

function oneLine(s) {
	return String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim();
}

// run_id and run_attempt reach deploy-drift.yml's rerun job, the one job that
// holds a write token and builds an API path from them. Digits or nothing.
function digitsOnly(v) {
	const s = String(v == null ? "" : v);
	return /^\d+$/.test(s) ? s : "";
}

async function main() {
	// DRIFT_GATE_RETRY_MS (comma-separated waits) and DRIFT_GATE_MISSING_RETRY_MS
	// are for tests only. Defaults: two HTTP retries after 2 s and 5 s, and one
	// re-look 20 s after finding no Deploy run at all.
	const retryEnv = process.env.DRIFT_GATE_RETRY_MS;
	const backoffMs = retryEnv === undefined ? undefined : retryEnv.split(",").filter(Boolean).map(Number);
	const missingEnv = process.env.DRIFT_GATE_MISSING_RETRY_MS;
	const result = await decide({
		boxState: (process.env.BOX_STATE || "").trim(),
		targetSha: (process.env.TARGET_SHA || "").trim(),
		repo: process.env.GITHUB_REPOSITORY || "",
		token: process.env.GITHUB_TOKEN || "",
		apiBase: process.env.GITHUB_API_URL || "https://api.github.com",
		backoffMs,
		missingRetryMs: missingEnv === undefined ? undefined : Number(missingEnv),
	});
	const out = {
		state: result.state,
		action: result.action,
		verdict: result.verdict || "n/a",
		detail: oneLine(result.detail),
		url: oneLine(result.url),
		hint: oneLine(result.hint),
		run_id: digitsOnly(result.runId),
		run_attempt: digitsOnly(result.runAttempt),
	};
	console.log(`DRIFT_STATE=${out.state}`);
	console.log(`DRIFT_ACTION=${out.action}`);
	console.log(`GATE_VERDICT=${out.verdict}`);
	console.log(`GATE_DETAIL=${out.detail}`);
	if (out.url) console.log(`GATE_URL=${out.url}`);
	if (out.run_id) console.log(`GATE_RUN_ID=${out.run_id}`);
	if (out.run_attempt) console.log(`GATE_RUN_ATTEMPT=${out.run_attempt}`);
	if (process.env.GITHUB_OUTPUT) {
		const fs = require("fs");
		fs.appendFileSync(
			process.env.GITHUB_OUTPUT,
			Object.entries(out)
				.map(([k, v]) => `${k}=${v}\n`)
				.join("")
		);
	}
}

module.exports = {
	ACTIONS,
	HINTS,
	DEPLOY_WORKFLOW_FILE,
	STAGING_JOB_NAME,
	UNREACHED_TITLE,
	UNREACHED_MESSAGE_PREFIX,
	actionFor,
	hintFor,
	refineState,
	neverReachedVps,
	stagingVerdict,
	lookupStaging,
	decide,
};

if (require.main === module) {
	main().catch((err) => {
		// decide() never throws, so this is a bug in the plumbing itself. Fail the
		// step: a gate that cannot run must not be read as a pass.
		console.error(`::error::drift-gate crashed: ${err && err.stack ? err.stack : err}`);
		process.exit(1);
	});
}
