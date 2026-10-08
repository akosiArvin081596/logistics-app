#!/usr/bin/env node
"use strict";
/**
 * The gate on a MANUAL production deploy (deploy.yml, workflow_dispatch with
 * target=production). Runs ON THE GITHUB RUNNER, before the deploy.
 *
 * WHY IT EXISTS
 * -------------
 * A push deploys production only after its own staging job passed: the deploy
 * to staging, the staging smoke and CI on main (deploy.yml). A manual dispatch
 * runs the production job alone, and with no reviewer on the production
 * environment nothing else stands in front of it. So it asks GitHub the same
 * question the drift heal asks (drift-gate.js's lookupStaging): did THIS EXACT
 * commit pass the `staging` job of a push-triggered Deploy run? Only "yes"
 * deploys. A rollback to any commit main has deployed before passes, because
 * each of those passed staging in its own push run.
 *
 * `override` deploys anyway, for the case a human has decided on (a commit that
 * never ran through a push run, say), and records the decision as a warning
 * annotation on the run.
 *
 * It also pins the deploy to the commit it checked. `ref` is resolved to a SHA
 * here, and the deploy gets exactly that SHA: `main` deploys as ref=main plus
 * that SHA (so main moving on meanwhile changes nothing), and any other ref as
 * the SHA itself (a pin, as a non-main ref always was).
 *
 * USAGE (deploy.yml)
 *   REF=<the dispatch's ref> OVERRIDE=<true|false> GITHUB_REPOSITORY=owner/repo
 *   GITHUB_TOKEN=<token with actions: read and checks: read>
 *   node scripts/deploy/dispatch-gate.js
 * Writes `ref` and `sha` to $GITHUB_OUTPUT when it lets the deploy through, and
 * exits 1 with an ::error:: when it does not.
 */
const gate = require("./drift-gate.js");

const SHA_RE = /^[0-9a-f]{40}$/;
// The same shape .github/actions/vps-deploy accepts for a ref.
const REF_RE = /^[A-Za-z0-9._/-]{1,100}$/;

async function resolveRef({ repo, ref, token, apiBase, fetchImpl, sleepImpl, backoffMs }) {
	const base = apiBase.replace(/\/+$/, "");
	const refPath = ref.split("/").map(encodeURIComponent).join("/");
	const body = await gate.getJson(`${base}/repos/${repo}/commits/${refPath}`, { token, fetchImpl, sleepImpl, backoffMs });
	const sha = body && body.sha;
	if (!SHA_RE.test(String(sha || ""))) throw new Error(`GitHub answered no commit SHA for '${ref}'`);
	return sha;
}

/** The whole decision, with the network injected. Never throws. */
async function decideDispatch({
	repo,
	ref,
	override = false,
	token,
	apiBase = "https://api.github.com",
	fetchImpl = globalThis.fetch,
	sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
	backoffMs,
}) {
	const refused = (reason) => ({ ok: false, reason });
	if (!REF_RE.test(String(ref || "")) || String(ref).startsWith("-")) {
		return refused(`the ref '${ref}' is not a plain branch, tag or commit name`);
	}
	if (!repo) return refused("GITHUB_REPOSITORY is not set");
	let sha;
	try {
		sha = await resolveRef({ repo, ref, token, apiBase, fetchImpl, sleepImpl, backoffMs });
	} catch (err) {
		// Not even override deploys a ref that names no commit.
		return refused(`cannot resolve '${ref}' to a commit: ${err && err.message ? err.message : err}`);
	}
	let verdict;
	try {
		// A Deploy run exists long before anyone dispatches its commit by hand, so
		// no re-look after a short wait (missingRetryMs: 0).
		verdict = await gate.lookupStaging({ repo, sha, token, apiBase, fetchImpl, sleepImpl, backoffMs, missingRetryMs: 0 });
	} catch (err) {
		verdict = { verdict: "unverified", detail: `GitHub API lookup failed: ${err && err.message ? err.message : err}`, url: "" };
	}
	const deploy = ref === "main" ? { ref: "main", sha } : { ref: sha, sha: "" };
	const seen = { commit: sha, verdict: verdict.verdict, detail: verdict.detail, url: verdict.url || "" };
	if (verdict.verdict === "passed") return { ok: true, override: false, ...deploy, ...seen };
	if (override) return { ok: true, override: true, ...deploy, ...seen };
	return {
		...refused(`${sha} has not passed the staging job of a push-triggered Deploy run (verdict '${verdict.verdict}': ${verdict.detail})`),
		...seen,
	};
}

const oneLine = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim();

async function main() {
	const retryEnv = process.env.DISPATCH_GATE_RETRY_MS;
	const r = await decideDispatch({
		repo: process.env.GITHUB_REPOSITORY || "",
		ref: (process.env.REF || "").trim(),
		override: /^true$/i.test(String(process.env.OVERRIDE || "").trim()),
		token: process.env.GITHUB_TOKEN || "",
		apiBase: process.env.GITHUB_API_URL || "https://api.github.com",
		backoffMs: retryEnv === undefined ? undefined : retryEnv.split(",").filter(Boolean).map(Number),
	});
	if (!r.ok) {
		console.log(`::error title=Manual production deploy refused::${oneLine(r.reason)}. Deploy a commit that passed staging, or re-run with override=true to deploy it anyway.`);
		process.exit(1);
	}
	if (r.override) {
		console.log(`::warning title=Staging gate overridden::production deploys ${r.commit} by hand with override=true although it has not passed staging (verdict '${oneLine(r.verdict)}': ${oneLine(r.detail)})`);
	} else {
		console.log(`${r.commit} passed staging: ${oneLine(r.detail)} ${oneLine(r.url)}`.trim());
	}
	console.log(`deploying ref=${r.ref} sha=${r.sha || "(the ref itself)"}`);
	if (process.env.GITHUB_OUTPUT) {
		require("fs").appendFileSync(process.env.GITHUB_OUTPUT, `ref=${r.ref}\nsha=${r.sha}\n`);
	}
}

module.exports = { decideDispatch, resolveRef };

if (require.main === module) {
	main().catch((err) => {
		console.error(`::error::dispatch-gate crashed: ${err && err.stack ? err.stack : err}`);
		process.exit(1);
	});
}
