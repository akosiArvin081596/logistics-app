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
 * raise an alarm.
 *
 * It also owns the state → action table, so the workflow YAML only branches
 * on one value (`action`) and the table is unit-tested
 * (scripts/test-drift-gate.js) instead of spread across `if:` expressions.
 *
 * USAGE (deploy-drift.yml)
 *   BOX_STATE=<state from remote-drift-check.sh> TARGET_SHA=<origin/main sha>
 *   GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=<workflow token, actions: read>
 *   node scripts/deploy/drift-gate.js
 * Prints DRIFT_STATE / DRIFT_ACTION / GATE_VERDICT / GATE_DETAIL lines and,
 * when $GITHUB_OUTPUT is set, appends state, action, verdict, detail, url, hint.
 */

// ⚠️ deploy.yml's staging job is looked up BY NAME. Renaming it (the `name:`,
// not the job id) makes every heal fail closed as unverified until this moves
// with it. scripts/test-drift-gate.js pins the two together.
const DEPLOY_WORKFLOW_FILE = "deploy.yml";
const STAGING_JOB_NAME = "staging";

const SHA_RE = /^[0-9a-f]{40}$/;

// What the workflow does with each state. Anything not listed (an unknown or
// empty state, e.g. unparseable ssh output) must ALARM, never heal.
const ACTIONS = Object.freeze({
	"in-sync": "none",
	"behind-healable": "heal",
	"behind-staging-pending": "notice",
	"behind-already-attempted": "alarm",
	"behind-and-unhealthy": "alarm",
	"behind-staging-failed": "alarm",
	"behind-staging-unverified": "alarm",
});

const HINTS = Object.freeze({
	"in-sync": "production is on main.",
	"behind-healable":
		"production is behind main but serving, and main's commit PASSED staging: the shape of a deploy that failed on transport. Healing once, with the same smoke check and auto-rollback as deploy.yml.",
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
 */
function refineState(boxState, verdict) {
	if (boxState !== "behind-healable") return boxState;
	switch (verdict) {
		case "passed":
			return "behind-healable";
		case "pending":
			return "behind-staging-pending";
		case "failed":
			return "behind-staging-failed";
		default:
			return "behind-staging-unverified";
	}
}

/**
 * Pure. `runs` = workflow_runs from the list-runs API; `jobsByRun` = { [runId]:
 * jobs[] } from the list-jobs API (filter=latest, i.e. the newest attempt).
 *
 * Only the NEWEST push-triggered run for the SHA counts. A newer attempt at the
 * same commit supersedes an older one: if it failed, an older success must not
 * sneak a heal through.
 */
function stagingVerdict(runs, jobsByRun, sha) {
	const candidates = (Array.isArray(runs) ? runs : [])
		.filter((r) => r && r.event === "push" && (!sha || r.head_sha === sha))
		.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
	if (candidates.length === 0) {
		return { verdict: "unverified", detail: "no push-triggered Deploy run exists for this commit", url: "" };
	}
	const run = candidates[0];
	const jobs = (jobsByRun && jobsByRun[run.id]) || [];
	const staging = jobs.find((j) => j && j.name === STAGING_JOB_NAME);
	const url = (staging && staging.html_url) || run.html_url || "";
	if (staging && staging.status === "completed") {
		if (staging.conclusion === "success") {
			return { verdict: "passed", detail: `staging succeeded in Deploy run ${run.id}`, url };
		}
		return { verdict: "failed", detail: `staging concluded '${staging.conclusion}' in Deploy run ${run.id}`, url };
	}
	if (staging || PENDING.has(run.status)) {
		return {
			verdict: "pending",
			detail: `Deploy run ${run.id} is '${run.status}', staging job ${staging ? `'${staging.status}'` : "not started"}`,
			url,
		};
	}
	// Completed run, no staging job at all: an invalid workflow file, a
	// startup failure, a run cancelled before its first job, or a renamed job.
	return {
		verdict: "failed",
		detail: `Deploy run ${run.id} completed ('${run.conclusion}') without a '${STAGING_JOB_NAME}' job`,
		url,
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
	if (newest) {
		const jobsBody = await getJson(
			`${base}/repos/${repo}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`,
			opts
		);
		jobsByRun[newest.id] = Array.isArray(jobsBody && jobsBody.jobs) ? jobsBody.jobs : [];
	}
	return stagingVerdict(runs, jobsByRun, sha);
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
	const state = refineState(boxState || "", gate.verdict);
	return { state, action: actionFor(state), hint: hintFor(state), ...gate };
}

function oneLine(s) {
	return String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim();
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
	};
	console.log(`DRIFT_STATE=${out.state}`);
	console.log(`DRIFT_ACTION=${out.action}`);
	console.log(`GATE_VERDICT=${out.verdict}`);
	console.log(`GATE_DETAIL=${out.detail}`);
	if (out.url) console.log(`GATE_URL=${out.url}`);
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
	DEPLOY_WORKFLOW_FILE,
	STAGING_JOB_NAME,
	actionFor,
	hintFor,
	refineState,
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
