#!/usr/bin/env node
/**
 * The box's record of the commit it last VERIFIED (refs/logisx/verified-deploy):
 * who writes it, who reads it, and how a missing or inconsistent one fails
 * safe. Runs the REAL scripts/deploy/*.sh against the throwaway sandbox from
 * scripts/deploy-test-sandbox.js, which it shares with
 * scripts/test-deploy-scripts.js (§1–§11, §15) and scripts/test-deploy-live.js
 * (§13–§14: the started mark, the LIVE commit and the action). Each is a
 * runner of its own, so each keeps its own time budget.
 *
 * WHY IT EXISTS. HEAD moves at checkout, before install, build and restart,
 * so HEAD alone cannot say which commit the app runs. Each property below is
 * a way a deploy could act on a commit that never ran:
 *   §12 THE VERIFIED RECORD. Written only by remote-record-verified.sh (which
 *       the action runs once the deploy's checks passed, and which refuses a
 *       commit HEAD is not on) and by a rollback that serves again from a
 *       consistent record with a clean install and build, and whose target is
 *       not the commit that failed (whose drift marker it writes regardless).
 *       "Serves again" means the app: a rollback whose API answers but whose
 *       / is the 503 "being updated" page (no client/dist/index.html), or any
 *       page without the SPA's mount point, fails like one that never serves
 *       (ROLLBACK FAILED, exit 1) and records nothing. "The app" means the
 *       target's own client too: every build is stamped with its commit and
 *       the build a swap replaces is kept, so a rollback whose own client
 *       build fails serves the target's build (the one in place, or the kept
 *       one, put back), and with neither it ends ROLLBACK FAILED naming the
 *       client that serves; either way it records nothing. After a deploy
 *       that was never built (DEPLOY_RESULT=unbuilt), a rollback whose own
 *       install or native module fails restarts nothing and ends ROLLBACK
 *       FAILED: the old process never stopped serving.
 *       remote-deploy.sh never records its own deploy. With the record, a half-finished deploy
 *       (HEAD moved, nothing restarted) is never a no-op floor or a rollback
 *       target, and main moves back over it; the drift check and the heal prep
 *       read production as the record. A missing record falls back to HEAD
 *       with no no-op and no move back; an inconsistent one is trusted by
 *       nothing, and the drift check alarms.
 *   §8  mutants: each property above, broken on purpose, must turn this
 *       runner red.
 *
 * Hermetic, like the core runner: a mkdtemp sandbox, local git only, and
 * stubbed pm2/npm/curl/sleep. No network, no VPS, no secrets.
 *
 * Run: node scripts/test-deploy-record.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
	REAL, SMOKE, record, finish, crash,
	D, ENV, git,
	C1, C2, C3, S1, head, onMain, marker, log, pageAsks, VERIFIED_REF, verified, started,
	servedIndex, keptIndex, stampOf, seedBuild, buildLeftovers,
	resetBox, runSh, deployEnv, field, lastField, swap, expectCaught, M,
	short, runCases, reflog, checkOut, recordVerified, result, deployedFrom, didFullDeploy, isNoop,
	rollback, leaveHalfFinished, healExpect, boxSeen,
} = require("./deploy-test-sandbox.js");

// A deploy that dies AFTER its checkout: HEAD moves to `sha`, the build fails,
// nothing restarts and nothing is recorded (DEPLOY_RESULT=unbuilt). On
// production the action then rolls back (test-deploy-live.js §14); this is the
// box as it stays when no rollback follows (staging, or a job that lost its
// connection or timed out before the rollback).
const halfFinished = (S, sha) => runSh(S.deploy, deployEnv({ SHA: sha, STUB_BUILD_FAIL: "1", STUB_TAG: "half" }));

// A rollback handed a deploy's RECORD_STATE other than ok: PREV was only HEAD,
// never verified, so it is not recorded however well the rollback goes.
function rollbackRecordState(S, tag, states = ["missing", "inconsistent", ""]) {
	return states.map((state) => {
		resetBox(C3, { verified: C1 });
		const x = rollback(S, C2, { RECORD_STATE: state });
		return [x.code === 0 && /ROLLBACK OK/.test(x.out) && head() === C2 && verified() === C1
			&& /::warning::not recording .* the deploy reported the verified-deploy record as/.test(x.out),
		`${tag}§12 a rollback with RECORD_STATE=${state || "(unset)"} serves again but records nothing (record ${short(verified())}, code ${x.code})`];
	});
}

// A rollback's own install or build that did not complete cleanly, three ways:
// it still restarts and serves TARGET's own client, and records nothing. Here
// the box already serves C2's build, stamped C2, as it does after a deploy of
// C3 that was never built (DEPLOY_RESULT=unbuilt). A client build that fails,
// part-way (emptying its output folder, as Vite does) or with no index.html,
// leaves client/dist as it was (client_build), so that build serves on. An
// install that fails is followed by a build that succeeds, stamped C2. A
// client that is NOT the target's is rollbackRestoresKeptBuild and
// rollbackClientNotTarget, below.
const C1_BUILD = '<!doctype html><div id="app"></div><!-- the build of C1 -->\n';
const C2_BUILD = '<!doctype html><div id="app"></div><!-- the build of C2 -->\n';
const BUILD_NOT_CLEAN = {
	install: ["npm install failed", { STUB_INSTALL_FAIL: "1" }, () => servedIndex().includes(`build of ${C2}`), "a new build of C2"],
	build: ["client build died part-way, emptying its output folder,", { STUB_BUILD_FAIL: "1" }, () => servedIndex() === C2_BUILD, "C2's build that was there"],
	index: ["client build left no index.html", { STUB_BUILD_EMPTY: "1" }, () => servedIndex() === C2_BUILD, "C2's build that was there"],
};
function rollbackBuildNotClean(S, tag, which = Object.keys(BUILD_NOT_CLEAN)) {
	return which.flatMap((k) => {
		const [what, env, servesOk, serving] = BUILD_NOT_CLEAN[k];
		resetBox(C3, { verified: C1 });
		seedBuild("dist", C2_BUILD, C2);
		const x = rollback(S, C2, { RECORD_STATE: "ok", ...env });
		return [
			[x.code === 0 && /ROLLBACK OK/.test(x.out) && /^restart /m.test(log("pm2")) && verified() === C1
				&& /::warning::not recording .* install or build did not complete cleanly/.test(x.out),
			`${tag}§12 a rollback whose ${what} still restarts and serves, but records nothing (record ${short(verified())}, code ${x.code})`],
			[servesOk() && stampOf() === C2 && buildLeftovers().length === 0,
				`${tag}§12 …serving ${serving}, stamped C2, with nothing half-built left beside it (stamp ${short(stampOf())}, leftovers ${JSON.stringify(buildLeftovers())})`],
		];
	});
}

// After a deploy of C2 that swapped its build in and then failed (its checks,
// or a restart pm2 did not prove), from a box serving C1's build stamped C1.
function deployedC2OverC1(S) {
	resetBox(C1, { verified: C1, started: C1 });
	seedBuild("dist", C1_BUILD, C1);
	return runSh(S.deploy, deployEnv({ SHA: C2 }));
}

// After a deploy that was never built (DEPLOY_RESULT=unbuilt) the old process
// never stopped serving. A rollback whose own install, or native module,
// fails must not restart it onto that.
const ROLLBACK_INSTALL_FAILS = {
	install: ["npm install", { STUB_INSTALL_FAIL: "1" }],
	native: ["better-sqlite3, still unable to open a database after its rebuild,", { STUB_BSQL: "broken" }],
};

// Named cases, small enough that a mutant re-runs only the one that targets it.
const RECORD_CASES = {
	halfFinishedDeploy(S, tag) {
		const r = [];
		resetBox(C1, { verified: C1 });
		const x = halfFinished(S, C3);
		r.push([result(x) === "unbuilt" && head() === C3 && onMain() && git(D.box, "rev-parse", "main") === C3,
			`${tag}§12 a deploy whose build fails after its checkout reports DEPLOY_RESULT=unbuilt with HEAD (and main) already on C3, the state a deploy no rollback follows leaves (code ${x.code}, result ${result(x) || "none"})`]);
		r.push([!/^restart /m.test(log("pm2")) && verified() === C1 && started() === "",
			`${tag}§12 …restarts nothing, marks nothing started, and the verified record stays C1`]);
		// (B) The drift check must see it: HEAD is main's tip, the old code serves.
		let out = checkOut(S);
		r.push([field(out, "DRIFT_STATE") === "behind-healable",
			`${tag}§12 the drift check reads a half-finished deploy of main's tip as behind-healable, NOT in-sync (got ${field(out, "DRIFT_STATE")})`]);
		r.push([field(out, "DRIFT_LOCAL") === C1 && field(out, "DRIFT_HEAD") === C3 && field(out, "DRIFT_RECORD") === "ok",
			`${tag}§12 …reporting production as the verified C1, with HEAD C3 beside it`]);
		out = checkOut(S, { STUB_HTTP_CODE: "503" });
		r.push([field(out, "DRIFT_STATE") === "behind-and-unhealthy", `${tag}§12 …and as behind-and-unhealthy when it does not serve (a restart that died)`]);
		return r;
	},
	sameCommitAfterHalf(S, tag) {
		// (A) After it died halfway, the SAME commit again: a full deploy.
		resetBox(C1, { verified: C1 });
		leaveHalfFinished(C3);
		const x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		const dropped = new RegExp(`^::warning::a rollback of this deploy returns to ${C1} and drops these commits HEAD holds past it: [0-9a-f]{7,} c3;[0-9a-f]{7,} c2$`, "m");
		return [
			[x.code === 0 && head() === C3 && onMain(), `${tag}§12 re-deploying the SAME commit after a half-finished deploy lands on C3 (code ${x.code})`],
			[didFullDeploy(x), `${tag}§12 …as a FULL deploy: install, build and restart, DEPLOY_RESULT=deployed`],
			[deployedFrom(x) === C1 && lastField(x.stdout, "DEPLOYED_TO") === C3,
				`${tag}§12 …with the last VERIFIED commit C1 as rollback target, not the never-run HEAD (got ${short(deployedFrom(x))})`],
			[dropped.test(x.out), `${tag}§12 …warning that a rollback to C1 would drop c3 and c2, which HEAD holds past it`],
			[verified() === C1, `${tag}§12 …and remote-deploy.sh itself records nothing`],
		];
	},
	ancestorAfterHalf(S, tag) {
		// (A) An ANCESTOR of the half-finished HEAD: before the record, a no-op
		// whose smoke check passed on the old process. Now a full deploy of it.
		resetBox(C1, { verified: C1 });
		leaveHalfFinished(C3);
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [
			[x.code === 0 && head() === C2 && onMain() && git(D.box, "rev-parse", "main") === C2,
				`${tag}§12 deploying C2, an ancestor of the half-finished HEAD C3, lands on EXACTLY C2 on main (code ${x.code}, HEAD ${short(head())})`],
			[didFullDeploy(x), `${tag}§12 …as a FULL deploy, not a no-op against a HEAD that never ran`],
			[/moving main back to/.test(x.out), `${tag}§12 …moving main back only over commits past the last live deploy, and saying so`],
			[deployedFrom(x) === C1, `${tag}§12 …with the last VERIFIED commit C1 as rollback target, not the never-run HEAD C3 (got ${short(deployedFrom(x))})`],
		];
	},
	verifiedNoop(S, tag) {
		// A newer VERIFIED commit is live: still a no-op, even with HEAD moved past it.
		resetBox(C2, { verified: C2 });
		leaveHalfFinished(C3);
		const x = runSh(S.deploy, deployEnv({ SHA: C1 }));
		return [
			[isNoop(x) && field(x.out, "DEPLOY_NOOP") === "1", `${tag}§12 a commit older than the VERIFIED C2 is a no-op, even with HEAD moved on to C3 (code ${x.code}, result ${result(x) || "none"})`],
			[deployedFrom(x) === C2 && lastField(x.stdout, "DEPLOYED_TO") === C2, `${tag}§12 …reporting the verified C2 as what is live`],
		];
	},
	missingRecordAncestor(S, tag) {
		// Fail SAFE with no record (the first deploy after the record shipped): an
		// ancestor of HEAD is no no-op, and main is not moved back either.
		resetBox(C3);
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [
			[result(x) === "" && x.code !== 0 && head() === C3 && !/restart/.test(log("pm2")),
				`${tag}§12 no record: an ancestor of HEAD is NOT a no-op, and with no proof HEAD never ran main is not moved back either: refused, nothing changed (code ${x.code})`],
			[/cannot prove main's extra commits never ran/.test(x.out) && /run Deploy with ref=main;/.test(x.out) && x.out.includes(`run Deploy with ref=${C2} (a pin)`),
				`${tag}§12 …saying why, and how to deploy main's tip or pin exactly this commit instead`],
		];
	},
	missingRecordOther(S, tag) {
		const r = [];
		resetBox(C3);
		let x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		r.push([x.code === 0 && didFullDeploy(x) && deployedFrom(x) === C3, `${tag}§12 no record: HEAD's own commit again is a full deploy, rolling back to HEAD as before`]);
		resetBox(C3);
		let out = checkOut(S);
		r.push([field(out, "DRIFT_STATE") === "in-sync" && field(out, "DRIFT_RECORD") === "missing" && field(out, "DRIFT_LOCAL") === C3,
			`${tag}§12 no record: the drift check compares HEAD, as before, so the first tick does not alarm (got ${field(out, "DRIFT_STATE")})`]);
		resetBox(C2);
		out = checkOut(S);
		r.push([field(out, "DRIFT_STATE") === "behind-healable", `${tag}§12 …and still sees a HEAD behind main as behind-healable`]);
		x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		r.push([x.code === 0 && didFullDeploy(x) && head() === C3, `${tag}§12 no record: a newer commit deploys in full, as always`]);
		// …which is exactly the first deploy after the record shipped: once
		// verified, it writes the first record, and drift reads it from then on.
		x = recordVerified(S, C3);
		out = checkOut(S);
		r.push([x.code === 0 && field(out, "DRIFT_RECORD") === "ok" && field(out, "DRIFT_STATE") === "in-sync",
			`${tag}§12 the first verified deploy writes the first record, and the drift check reads it (in-sync)`]);
		return r;
	},
	inconsistentRecordAlarms(S, tag) {
		// A record naming a commit HEAD does not contain.
		resetBox(C2, { verified: S1 });
		const out = checkOut(S);
		return [[field(out, "DRIFT_STATE") === "verified-record-inconsistent" && field(out, "DRIFT_RECORD") === "inconsistent",
			`${tag}§12 a record naming a commit HEAD does not contain → verified-record-inconsistent (got ${field(out, "DRIFT_STATE")})`]];
	},
	inconsistentOther(S, tag) {
		const r = [];
		// A record naming no commit at all.
		resetBox(C3);
		const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: D.box, env: ENV, input: "not a commit\n", encoding: "utf8" }).stdout.trim();
		git(D.box, "update-ref", VERIFIED_REF, blob);
		let out = checkOut(S);
		r.push([/^[0-9a-f]{40}$/.test(blob) && field(out, "DRIFT_STATE") === "verified-record-inconsistent", `${tag}§12 a record naming no commit at all (a blob) → verified-record-inconsistent`]);
		// A manual deploy of an OLDER ref that dies after its checkout: HEAD went
		// back past the verified commit, which still serves. A human's call.
		resetBox(C3, { verified: C3 });
		const pin = runSh(S.deploy, deployEnv({ REF: C1, STUB_BUILD_FAIL: "1" }));
		out = checkOut(S);
		r.push([result(pin) === "unbuilt" && head() === C1 && verified() === C3 && field(out, "DRIFT_STATE") === "verified-record-inconsistent",
			`${tag}§12 a manual deploy of an older ref that died after its checkout → verified-record-inconsistent, never a heal (got ${field(out, "DRIFT_STATE")})`]);
		return r;
	},
	inconsistentHeal(S, tag) {
		resetBox(C2, { verified: S1 });
		const h = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C2, ...boxSeen() });
		return [[field(h.out, "HEAL_READY") === "no" && marker() === "", `${tag}§12 an inconsistent record: the heal prep refuses and writes no marker, so it never heals`]];
	},
	inconsistentDeploy(S, tag) {
		// The deploy trusts it no more than the drift check does, and the started
		// mark does not stand in for it.
		const r = [];
		resetBox(C3, { verified: S1, started: C3 });
		let x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		r.push([result(x) === "" && x.code !== 0 && head() === C3, `${tag}§12 an inconsistent record never makes a no-op, nor moves main back, whatever the started mark says (code ${x.code})`]);
		resetBox(C2, { verified: S1 });
		x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		r.push([x.code === 0 && didFullDeploy(x) && deployedFrom(x) === C2 && lastField(x.stdout, "DEPLOY_RECORD_STATE") === "inconsistent"
			&& /::warning::the verified-deploy record does not match/.test(x.out),
		`${tag}§12 …a newer commit still deploys in full, rolling back to HEAD, with a warning, reporting the record inconsistent`]);
		return r;
	},
	recordScript(S, tag) {
		const r = [];
		resetBox(C2);
		let x = recordVerified(S, C2);
		r.push([x.code === 0 && verified() === C2 && field(x.out, "VERIFIED_RECORDED") === C2, `${tag}§12 remote-record-verified.sh records the commit HEAD is on (code ${x.code})`]);
		r.push([/logisx: deploy verified/.test(reflog(VERIFIED_REF)), `${tag}§12 …with a reflog entry, so every verified deploy is listed`]);
		r.push([git(D.box, "status", "--porcelain") === "", `${tag}§12 …and the record never shows in git status (it lives inside .git)`]);
		resetBox(C2, { verified: C1 });
		x = recordVerified(S, C3);
		r.push([x.code !== 0 && verified() === C1, `${tag}§12 it refuses a commit HEAD is not on (the box moved since): the record stays C1 (code ${x.code})`]);
		for (const bad of ["", C2.slice(0, 7), C2.toUpperCase()]) {
			x = recordVerified(S, bad);
			r.push([x.code !== 0 && verified() === C1, `${tag}§12 …and a SHA that is not 40 lowercase hex (${JSON.stringify(bad.slice(0, 8))})`]);
		}
		return r;
	},
	onlyVerifiedWrites(S, tag) {
		// Neither the deploy nor the smoke check records: only the record step,
		// which the action runs after both (and after the edge check).
		const r = [];
		resetBox(C1, { verified: C1 });
		let x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		r.push([x.code === 0 && head() === C2 && verified() === C1, `${tag}§12 a SUCCESSFUL remote-deploy.sh records nothing: a restart is not a verification`]);
		x = runSh(SMOKE, { DIR: D.box, PM2: "logistics-app" });
		r.push([x.code === 0 && verified() === C1, `${tag}§12 …nor does a passing smoke check`]);
		x = recordVerified(S, C2);
		r.push([x.code === 0 && verified() === C2, `${tag}§12 …the record step, run once they passed, records C2`]);
		const out = checkOut(S);
		r.push([field(out, "DRIFT_LOCAL") === C2 && field(out, "DRIFT_STATE") === "behind-healable", `${tag}§12 …and the drift check then reads production as the verified C2`]);
		return r;
	},
	healPrepReadsTheRecord(S, tag) {
		// The heal prep compares what the drift check reported as DRIFT_LOCAL: the
		// record, here with a half-finished HEAD past it.
		resetBox(C1, { verified: C1 });
		leaveHalfFinished(C2);
		const out = checkOut(S);
		const local = field(out, "DRIFT_LOCAL");
		const h = runSh(S.heal, { DIR: D.box, TARGET: C3, ...healExpect(out) });
		return [[local === C1 && field(h.out, "HEAL_READY") === "yes" && marker() === C3,
			`${tag}§12 with a verified record and a half-finished HEAD past it, the heal prep reads production exactly as the drift check reported it (${short(local)}) and is ready`]];
	},
	healPrepOther(S, tag) {
		const r = [];
		resetBox(C2);
		let out = checkOut(S);
		const local = field(out, "DRIFT_LOCAL");
		let h = runSh(S.heal, { DIR: D.box, TARGET: C3, ...healExpect(out) });
		r.push([local === C2 && field(h.out, "HEAL_READY") === "yes" && marker() === C3, `${tag}§12 with no record, the heal prep reads HEAD, as the drift check did, and is ready`]);
		resetBox(C1, { verified: C1 });
		leaveHalfFinished(C2);
		out = checkOut(S);
		git(D.box, "update-ref", VERIFIED_REF, C2);
		h = runSh(S.heal, { DIR: D.box, TARGET: C3, ...healExpect(out) });
		r.push([field(h.out, "HEAL_READY") === "no" && marker() === "", `${tag}§12 a deploy verified between the check and the prep → not ready (production moved)`]);
		return r;
	},
	manualPinRecords(S, tag) {
		// Rollback by hand (a manual deploy of an older ref): once verified, the
		// record names what actually serves.
		const r = [];
		resetBox(C3, { verified: C3 });
		let x = runSh(S.deploy, deployEnv({ REF: C1 }));
		r.push([x.code === 0 && head() === C1 && deployedFrom(x) === C3 && lastField(x.stdout, "DEPLOYED_TO") === C1,
			`${tag}§12 a manual pin to C1 deploys it, with the verified C3 as rollback target`]);
		x = recordVerified(S, C1);
		r.push([x.code === 0 && verified() === C1, `${tag}§12 …verified, the pin is recorded: the record names what serves`]);
		const out = checkOut(S);
		r.push([field(out, "DRIFT_LOCAL") === C1 && field(out, "DRIFT_STATE") === "behind-already-attempted", `${tag}§12 …and drift still alarms over the pin, never deploying main over it`]);
		return r;
	},
	rollbackWrites(S, tag) {
		// Serving again at C2, from a consistent record and a clean build, the
		// rollback records C2 and marks it started (it restarted it).
		resetBox(C3, { verified: C1, started: C3 });
		const x = rollback(S, C2, { RECORD_STATE: "ok" });
		return [
			[x.code === 0 && /ROLLBACK OK/.test(x.out) && verified() === C2 && /logisx: rollback verified/.test(reflog(VERIFIED_REF)),
				`${tag}§12 a rollback that serves again from a consistent record and a clean build records C2 as the verified deploy (record ${short(verified())}, code ${x.code})`],
			[started() === C2, `${tag}§12 …and marks C2, which it restarted, as started (started ${short(started())})`],
		];
	},
	rollbackRecordState(S, tag) {
		return rollbackRecordState(S, tag);
	},
	rollbackBuildNotClean(S, tag) {
		return rollbackBuildNotClean(S, tag);
	},
	rollbackRestoresKeptBuild(S, tag) {
		// The deploy of C2 swaps C2's build in and KEEPS C1's, stamped, beside
		// it. The rollback to C1, whose own client build fails, puts C1's kept
		// build back: C1's server never serves C2's client.
		const d = deployedC2OverC1(S);
		const kept = result(d) === "deployed" && servedIndex().includes(`build of ${C2}`) && stampOf() === C2 && keptIndex() === C1_BUILD && stampOf("dist.prev") === C1;
		const x = rollback(S, C1, { RECORD_STATE: "ok", STUB_BUILD_FAIL: "1" });
		return [
			[kept, `${tag}§12 a deploy of C2 swaps in its build stamped C2 and keeps C1's, stamped C1, in client/dist.prev (result ${result(d)}, stamps ${short(stampOf())}/${short(stampOf("dist.prev"))})`],
			[x.code === 0 && /ROLLBACK OK/.test(x.out) && servedIndex() === C1_BUILD && stampOf() === C1
				&& new RegExp(`put the build of ${C1} kept in client/dist\\.prev back in place`).test(x.out),
			`${tag}§12 …and the rollback to C1 whose own client build fails puts C1's kept build back and serves it (code ${x.code}, serving stamp ${short(stampOf())})`],
			[verified() === C1 && !/verified deploy recorded/.test(x.out), `${tag}§12 …recording nothing: its own build was not clean (record ${short(verified())})`],
		];
	},
	rollbackClientNotTarget(S, tag) {
		// …but with no build of C1 kept (here, one kept from before builds were
		// stamped), the rollback must not say ROLLBACK OK while C1's server
		// serves C2's client: it fails, naming the client that serves.
		const d = deployedC2OverC1(S);
		fs.rmSync(path.join(D.box, "client", "dist.prev", ".build-commit"), { force: true });
		const x = rollback(S, C1, { RECORD_STATE: "ok", STUB_BUILD_FAIL: "1" });
		const errors = x.out.split("\n").filter((l) => l.startsWith("::error"));
		return [
			[result(d) === "deployed" && x.code === 1 && !/ROLLBACK OK/.test(x.out) && servedIndex().includes(`build of ${C2}`),
				`${tag}§12 a rollback to C1 whose own client build fails, with no build of C1 kept, never says ROLLBACK OK over C2's client (exit ${x.code})`],
			[errors.length === 1 && errors[0].includes(`with the client build of ${C2}, not ${C1}'s`) && /^::error::ROLLBACK FAILED — .* MANUAL INTERVENTION REQUIRED\.$/.test(errors[0]),
				`${tag}§12 …its one alert names C2's client as the one serving (got ${JSON.stringify(errors)})`],
			[verified() === C1, `${tag}§12 …and it records nothing (record ${short(verified())})`],
		];
	},
	rollbackAfterUnbuiltInstallFails(S, tag) {
		return Object.values(ROLLBACK_INSTALL_FAILS).flatMap(([what, env]) => {
			resetBox(C1, { verified: C1, started: C1 });
			leaveHalfFinished(C2);
			const x = rollback(S, C1, { RECORD_STATE: "ok", DEPLOY_RESULT: "unbuilt", ...env });
			return [
				[x.code === 1 && !/ROLLBACK OK/.test(x.out)
					&& /^::error::ROLLBACK FAILED — the deploy of [0-9a-f]{40} was never built, so logistics-app still runs the code from before it, .* Not restarting: .* MANUAL INTERVENTION REQUIRED\.$/m.test(x.out),
				`${tag}§12 after an unbuilt deploy, a rollback whose own ${what} fails ends ROLLBACK FAILED, saying it does not restart (exit ${x.code})`],
				[!/^restart /m.test(log("pm2")) && !/^build /m.test(log("npm")) && started() === C1 && verified() === C1 && marker() === C2,
					`${tag}§12 …restarting and building nothing, marking and recording nothing, and still writing the drift marker for C2 (started ${short(started())}, marker ${short(marker())})`],
			];
		});
	},
	rollbackAfterRestartInstallFails(S, tag) {
		// The same failed install after a deploy that DID restart (here, one
		// pm2 did not prove): the failed commit may be what runs, so the
		// rollback still restarts what it has, and records nothing.
		resetBox(C1, { verified: C1, started: C1 });
		leaveHalfFinished(C2);
		const x = rollback(S, C1, { RECORD_STATE: "ok", DEPLOY_RESULT: "unproven", STUB_INSTALL_FAIL: "1" });
		return [[x.code === 0 && /ROLLBACK OK/.test(x.out) && /^restart /m.test(log("pm2")) && verified() === C1,
			`${tag}§12 after a deploy that restarted, a rollback whose own install fails still restarts and serves, recording nothing (exit ${x.code})`]];
	},
	rollbackFailedRecordsNothing(S, tag) {
		resetBox(C2, { verified: C1 });
		leaveHalfFinished(C3);
		const x = rollback(S, C2, { RECORD_STATE: "ok", STUB_HTTP_CODE: "503" });
		return [[x.code !== 0 && /ROLLBACK FAILED/.test(x.out) && verified() === C1,
			`${tag}§12 a rollback that never serves records nothing, even from a consistent record (the record stays C1)`]];
	},
	rollbackServesUpdatingPage(S, tag) {
		// A box with no client build at all, and a rollback whose build leaves
		// no index.html either: the restarted app answers its API, and every
		// page with the 503 "being updated" page. That is the app down, so it
		// ends exactly like a rollback that never serves: ROLLBACK FAILED,
		// exit 1, nothing recorded.
		resetBox(C3, { verified: C1 });
		fs.rmSync(path.join(D.box, "client", "dist"), { recursive: true, force: true });
		let x = rollback(S, C2, { RECORD_STATE: "ok", STUB_BUILD_EMPTY: "1" });
		const errors = x.out.split("\n").filter((l) => l.startsWith("::error"));
		const r = [
			[x.code === 1 && /^restart /m.test(log("pm2")) && head() === C2 && !/ROLLBACK OK/.test(x.out),
				`${tag}§12 a rollback that restarts C2 but serves the 503 "being updated" page fails (exit ${x.code}), never "ROLLBACK OK"`],
			[errors.length === 1 && /^::error::ROLLBACK FAILED — .* gave 503 .*"being updated" page.* MANUAL INTERVENTION REQUIRED\.$/.test(errors[0]),
				`${tag}§12 …with the failed rollback's one alert, naming the "being updated" page (got ${JSON.stringify(errors)})`],
			[verified() === C1 && !/verified deploy recorded/.test(x.out),
				`${tag}§12 …and records nothing, from a consistent record (record ${short(verified())})`],
		];
		// A clean build, but / answers 200 with a page that is not the app.
		resetBox(C3, { verified: C1 });
		x = rollback(S, C2, { RECORD_STATE: "ok", STUB_PAGE: "other" });
		r.push([x.code === 1 && /ROLLBACK FAILED — .* gave 200 without the app's page/.test(x.out) && verified() === C1,
			`${tag}§12 a rollback whose / answers 200 without the app's mount point fails too, recording nothing (exit ${x.code}, record ${short(verified())})`]);
		return r;
	},
	rollbackPageStall(S, tag) {
		// A stall right after the API's 200: the page gives no answer on the first
		// try and the app's page on the second. A healthy rollback, recorded.
		resetBox(C3, { verified: C1 });
		const x = rollback(S, C2, { RECORD_STATE: "ok", STUB_PAGE_SILENT: "1" });
		return [[x.code === 0 && /ROLLBACK OK/.test(x.out) && verified() === C2 && pageAsks() === 2,
			`${tag}§12 a rollback whose page answers only on the second try serves again and records C2 (exit ${x.code}, record ${short(verified())}, ${pageAsks()} asks)`]];
	},
	rollbackToFailedCommit(S, tag) {
		// A rollback handed the very commit that failed (HEAD): a deploy with no
		// record to return to, or a deploy script from before remote-deploy.sh
		// stopped naming it. It restarts that commit and serves, from a
		// consistent record and a clean build, yet records nothing, and it still
		// writes the drift marker for it.
		resetBox(C3, { verified: C2, started: C3 });
		const x = rollback(S, C3, { RECORD_STATE: "ok" });
		return [
			[x.code === 0 && /ROLLBACK OK/.test(x.out) && head() === C3 && verified() === C2
				&& /::warning::not recording .* it is the commit that just failed verification/.test(x.out),
			`${tag}§12 a rollback to the commit that failed serves again but never records it as verified (record ${short(verified())}, code ${x.code})`],
			[marker() === C3, `${tag}§12 …and still writes the drift marker for it (marker ${short(marker())})`],
		];
	},
};

// ──────────────────────────────────────────────────────────────── §8 mutants
function mutants() {
	const deployWith = (from, to) => ({ ...REAL, deploy: swap(REAL.deploy, from, to) });
	const rollbackWith = (from, to) => ({ ...REAL, rollback: swap(REAL.rollback, from, to) });

	// The deploy's readers of the record.
	expectCaught("the no-op check reads HEAD again", RECORD_CASES.ancestorAfterHalf(deployWith(
		'if [ -n "$LIVE" ] && [ "$SHA" != "$LIVE" ] && git merge-base --is-ancestor "$SHA" "$LIVE" \\\n\t\t&& git merge-base --is-ancestor "$LIVE" origin/main; then',
		'if [ "$SHA" != "$PREV" ] && git merge-base --is-ancestor "$SHA" "$PREV" \\\n\t\t&& git merge-base --is-ancestor "$PREV" origin/main; then'), M));
	expectCaught("a missing record counts as HEAD", RECORD_CASES.missingRecordAncestor(deployWith(
		'if ! git show-ref --verify -q "$VERIFIED_REF"; then\n\tVERIFIED_STATE=missing',
		'if ! git show-ref --verify -q "$VERIFIED_REF"; then\n\tVERIFIED=$(git rev-parse HEAD); VERIFIED_STATE=ok'), M));
	const rollbackToHead = deployWith("else\n\tROLLBACK_TO=$LIVE\nfi", "else\n\tROLLBACK_TO=$PREV\nfi");
	expectCaught("the rollback target is HEAD, not the live commit", [
		...RECORD_CASES.sameCommitAfterHalf(rollbackToHead, M),
		...RECORD_CASES.ancestorAfterHalf(rollbackToHead, M),
	]);
	expectCaught("no warning names the commits a rollback would drop", RECORD_CASES.sameCommitAfterHalf(deployWith(
		'if [ -n "$DROPPED" ]; then', "if false; then"), M));
	expectCaught("main moves back with no proof its commits never ran", RECORD_CASES.missingRecordAncestor(deployWith(
		'elif [ -n "$LIVE" ] && git merge-base --is-ancestor "$LIVE" "$SHA" \\\n\t\t&& { [ -z "$STARTED" ] || ! git merge-base --is-ancestor "$STARTED" HEAD || git merge-base --is-ancestor "$STARTED" "$SHA"; } \\\n\t\t&& git merge-base --is-ancestor main origin/main; then',
		"elif git merge-base --is-ancestor main origin/main; then"), M));

	// The drift check, the heal prep and the record script.
	expectCaught("the drift check compares HEAD again", RECORD_CASES.healPrepReadsTheRecord({
		...REAL,
		check: swap(REAL.check, 'if [ "$VERIFIED_STATE" = ok ]; then LOCAL=$VERIFIED; else LOCAL=$HEAD_SHA; fi', "LOCAL=$HEAD_SHA"),
	}, M));
	expectCaught("the drift check trusts an inconsistent record", RECORD_CASES.inconsistentRecordAlarms({
		...REAL,
		check: swap(REAL.check, 'if [ "$VERIFIED_STATE" = inconsistent ]; then', "if false; then"),
	}, M));
	expectCaught("the heal prep compares HEAD", RECORD_CASES.healPrepReadsTheRecord({
		...REAL,
		heal: swap(REAL.heal, "\tok) NOW=$VERIFIED ;;", "\tok) NOW=$(git rev-parse HEAD) ;;"),
	}, M));
	expectCaught("the heal prep heals an inconsistent record", RECORD_CASES.inconsistentHeal({
		...REAL,
		heal: swap(REAL.heal, "\t*) not_ready \"the verified-deploy record does not match this clone's history; a human decides\" ;;", "\t*) NOW=$(git rev-parse HEAD) ;;"),
	}, M));
	expectCaught("the record script records whatever it is given", RECORD_CASES.recordScript({
		...REAL,
		record: swap(REAL.record, 'if [ "$NOW" != "$SHA" ]; then', "if false; then"),
	}, M));

	// The rollback's record and started mark, and when it may record.
	expectCaught("the rollback records nothing", RECORD_CASES.rollbackWrites(rollbackWith(
		'if git update-ref --create-reflog -m "logisx: rollback verified" refs/logisx/verified-deploy "$TARGET"; then', "if true; then"), M));
	expectCaught("the rollback marks nothing started", RECORD_CASES.rollbackWrites(rollbackWith(
		'git update-ref --create-reflog -m "logisx: started (rollback)" refs/logisx/started-deploy "$TARGET"', "true"), M));
	expectCaught("the rollback records before it serves", RECORD_CASES.rollbackFailedRecordsNothing(rollbackWith(
		"PORT=$(grep -oE '^PORT=[0-9]+' \"$DIR/.env\" 2>/dev/null | head -1 | cut -d= -f2 || true)",
		"git update-ref refs/logisx/verified-deploy \"$TARGET\"\nPORT=$(grep -oE '^PORT=[0-9]+' \"$DIR/.env\" 2>/dev/null | head -1 | cut -d= -f2 || true)"), M));
	expectCaught("the rollback records whatever the deploy's record state", rollbackRecordState(rollbackWith(
		'if [ "$RECORD_STATE" != ok ]; then', "if false; then"), M, ["missing"]));
	expectCaught("the rollback ignores a failed install", rollbackBuildNotClean(rollbackWith(
		"npm install --silent --no-audit --no-fund || BUILD_OK=0", "npm install --silent --no-audit --no-fund"), M, ["install"]));
	expectCaught("the rollback ignores a failed build", rollbackBuildNotClean(rollbackWith(
		"client_build || BUILD_OK=0", "client_build || true"), M, ["build"]));
	expectCaught("the rollback ignores a missing index.html", rollbackBuildNotClean(rollbackWith(
		"\telif [ ! -f client/dist.next/index.html ]; then", "\telif false; then"), M, ["index"]));
	expectCaught("the rollback builds straight into client/dist", rollbackBuildNotClean(rollbackWith(
		"client_build || BUILD_OK=0", "npm run build:client --silent || BUILD_OK=0"), M, ["build"]));
	// The client a rollback serves must be its target's own build.
	expectCaught("the rollback serves whatever client is there", RECORD_CASES.rollbackClientNotTarget(rollbackWith(
		'if [ "$CLIENT_AT" != "$TARGET" ]; then', "if false; then"), M));
	expectCaught("the rollback never puts the kept build back", RECORD_CASES.rollbackRestoresKeptBuild(rollbackWith(
		'if [ "$(client_stamp client/dist)" != "$TARGET" ] && [ "$(client_stamp client/dist.prev)" = "$TARGET" ]; then', "if false; then"), M));
	expectCaught("the deploy deletes the build it replaces", RECORD_CASES.rollbackRestoresKeptBuild(deployWith(
		"\telse\n\t\treturn 0\n", "\telse\n\t\trm -rf client/dist.prev\n\t\treturn 0\n"), M));
	expectCaught("a build is swapped in without its stamp", RECORD_CASES.rollbackRestoresKeptBuild({ ...REAL,
		deploy: swap(REAL.deploy, "\telif ! git rev-parse HEAD > client/dist.next/.build-commit; then", "\telif false; then") }, M));
	// After an unbuilt deploy, a rollback whose own install fails restarts nothing.
	expectCaught("the rollback restarts after an unbuilt deploy's failed install", RECORD_CASES.rollbackAfterUnbuiltInstallFails(rollbackWith(
		'if [ "$DEPLOY_RESULT" = unbuilt ] && [ "$BUILD_OK" != 1 ]; then', "if false; then"), M));
	expectCaught("the rollback trusts a rebuild it never probed", RECORD_CASES.rollbackAfterUnbuiltInstallFails(rollbackWith(
		"\tnode -e \"new (require('better-sqlite3'))(':memory:').close()\" >/dev/null 2>&1 || BUILD_OK=0\n", ""), M));
	expectCaught("the rollback skips the app-page check", RECORD_CASES.rollbackServesUpdatingPage(rollbackWith(
		'if [ "$PAGE_OK" != 1 ]; then', "if false; then"), M));
	expectCaught("the rollback's page check passes without the app's mount point", RECORD_CASES.rollbackServesUpdatingPage(rollbackWith(
		"if [ \"$PAGE_CODE\" = \"200\" ] && grep -q 'id=\"app\"' \"$PAGE_BODY\"; then", 'if [ "$PAGE_CODE" = "200" ]; then'), M));
	expectCaught("the rollback's page check never asks again", RECORD_CASES.rollbackPageStall(rollbackWith(
		'if [ "$PAGE_CODE" != "000" ] || [ "$PAGE_TRY" = 3 ]; then break; fi', "break"), M));
}

(async () => {
	record(runCases(RECORD_CASES, REAL));
	mutants();
})()
	.catch(crash)
	.finally(finish);
