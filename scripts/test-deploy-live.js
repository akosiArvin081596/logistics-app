#!/usr/bin/env node
/**
 * What a deploy reports as LIVE, and what the vps-deploy action does with the
 * deploy's report. Runs the REAL scripts/deploy/*.sh against the throwaway
 * sandbox from scripts/deploy-test-sandbox.js (shared with
 * scripts/test-deploy-scripts.js, §1–§11 and §15, and
 * scripts/test-deploy-record.js, §12: the verified record), and the REAL steps
 * of .github/actions/vps-deploy/action.yml against stubs. Each is a runner of
 * its own, so each keeps its own time budget.
 *
 * WHY IT EXISTS. The verified record lags a deploy whose checks passed but
 * whose separate record step then failed: that commit serves while the record
 * still names the one before. Each property below is a way a deploy could
 * roll back past code that ran, or act on a report it misread:
 *   §13 THE LIVE COMMIT. remote-deploy.sh marks every commit it restarts
 *       (refs/logisx/started-deploy, only once pm2 has proven the restart and
 *       reports the app online), as does a rollback after its proven restart.
 *       LIVE is that mark while it follows the record and HEAD contains it;
 *       otherwise the record. LIVE is the no-op floor and the floor main may
 *       move back to, whatever the app answers: a started commit that misses
 *       the check is never moved back over, nor one HEAD holds through a
 *       merge. Each clause of the no-op and the move back is exercised: (D) a
 *       commit only this clone has, (E) a verified pin off main, (F) a live
 *       commit off main. THE ROLLBACK TARGET is LIVE only while it is the
 *       record or the app answers, and never the commit a run's checks judge
 *       unless it is the record: a heal of a started commit that failed and
 *       whose rollback never ran rolls back to the record, and so does a
 *       no-op after a half-finished deploy. The deploy's stdout ends with
 *       DEPLOY_RESULT, each value printed once, and DEPLOY_HANDSHAKE_GUARD says
 *       whether the commit now serving has the live-update Origin check.
 *   §14 THE ACTION. The record step runs only after the deploy, the smoke
 *       check and the edge check all passed, never for a no-op, and a failed
 *       record fails production's job only. The deploy step lets only a plain
 *       ref and a full SHA reach the box, and reads each value from the LAST
 *       whole line of its kind. The edge check retries only an unanswered or
 *       5xx request, and asks a foreign Origin for its 403 unless the deploy
 *       reported that the commit now serving predates that check. The WHOLE
 *       action also runs end to end against the real remote scripts, every
 *       `if:` evaluated: a restart pm2 did not prove (DEPLOY_RESULT=unproven)
 *       still gets the smoke and edge checks, is never recorded, rolls
 *       production back, and ends the job red.
 *   §8  mutants: each property above, broken on purpose, must turn this
 *       runner red.
 *
 * Hermetic, like the core runner: a mkdtemp sandbox, local git only, and
 * stubbed pm2/npm/curl/ssh/sleep. No network, no VPS, no secrets.
 *
 * Run: node scripts/test-deploy-live.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
	REAL, SMOKE, ok, record, finish, crash,
	T, D, ENV, git, writeExec,
	C1, C2, C3, S1, head, onMain, marker, log, verified, STARTED_REF, started,
	resetBox, runSh, deployEnv, field, lastField, swap, expectCaught, M,
	short, runCases, clearLogs, reflog, checkOut, result, deployedFrom, didFullDeploy, isNoop, rollback,
	fastBinDir, leaveHalfFinished,
} = require("./deploy-test-sandbox.js");

// The deploy's stdout, as the action reads it.
const lastStdoutLine = (x) => x.stdout.trimEnd().split("\n").pop();
const VALUE_KEYS = ["DEPLOYED_FROM", "DEPLOYED_TO", "DEPLOY_RECORD_STATE", "DEPLOY_HANDSHAKE_GUARD", "DEPLOY_RESULT"];
const valuesOnce = (x) => VALUE_KEYS.every((k) => (x.stdout.match(new RegExp(`^${k}=`, "gm")) || []).length === 1);
// A deploy whose app does not answer asks 3 times, 2 s apart, before it
// changes anything. The fast sleep keeps that instant.
const deployFast = (S, env) => runSh(S.deploy, deployEnv({ PATH: `${fastBinDir()}:${ENV.PATH}`, ...env }));
const mainAt = () => git(D.box, "rev-parse", "main");

// ─────────────────────── §13 THE LIVE COMMIT
// Named cases, small enough that a mutant re-runs only the one that targets it.
const LIVE_CASES = {
	startedMark(S, tag) {
		// A deploy whose restart pm2 reports online marks its commit STARTED.
		// It never records it as verified: a restart is not a verification.
		resetBox(C1, { verified: C1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [
			[x.code === 0 && started() === C2 && /^logisx: started$/m.test(reflog(STARTED_REF)),
				`${tag}§13 a restart pm2 reports online marks C2 started, with a reflog entry (code ${x.code}, started ${short(started())})`],
			[verified() === C1, `${tag}§13 …and remote-deploy.sh records nothing as verified (record ${short(verified())})`],
		];
	},
	startedButUnrecorded(S, tag) {
		// C2 deployed, restarted and passed its checks, but its record step never
		// ran (ssh gave up after the checks): started C2, recorded C1, the state
		// startedMark shows a real deploy leaves. C2 is what serves.
		resetBox(C2, { verified: C1, started: C2 });
		const x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		return [
			[x.code === 0 && deployedFrom(x) === C2,
				`${tag}§13 C2 restarted but unrecorded: the next deploy's rollback target is C2, what serves, not the recorded C1 (got ${short(deployedFrom(x))})`],
			[new RegExp(`^live commit: +${C2}$`, "m").test(x.out), `${tag}§13 …and its pre-deploy state names C2 as the live commit`],
		];
	},
	startedAncestorNoop(S, tag) {
		resetBox(C2, { verified: C1, started: C2 });
		const x = runSh(S.deploy, deployEnv({ SHA: C1 }));
		return [[isNoop(x) && head() === C2 && onMain() && lastField(x.stdout, "DEPLOYED_TO") === C2 && deployedFrom(x) === C1,
			`${tag}§13 C2 restarted but unrecorded: deploying C1, an ancestor of it, is a no-op on the live C2, not a move back over code that ran; if the checks after it fail, the rollback returns to the recorded C1 (code ${x.code}, HEAD ${short(head())}, result ${result(x) || "none"}, rollback target ${short(deployedFrom(x))})`]];
	},
	startedNotServing(S, tag) {
		resetBox(C2, { verified: C1, started: C2 });
		const x = deployFast(S, { SHA: C3, STUB_HTTP_CODE: "503" });
		return [[x.code === 0 && deployedFrom(x) === C1 && new RegExp(`^live commit: +${C2}$`, "m").test(x.out),
			`${tag}§13 the started C2 is the rollback target only while the app answers: with the app not serving, the rollback target is the recorded C1, though C2 stays the live commit (got ${short(deployedFrom(x))})`]];
	},
	startedNotInHead(S, tag) {
		// HEAD was moved back past the started C3 by hand: what runs is unknown.
		// Deploying HEAD's own C2 is a full deploy, never a no-op under C3.
		resetBox(C2, { verified: C1, started: C3 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [[x.code === 0 && didFullDeploy(x) && deployedFrom(x) === C1,
			`${tag}§13 a started mark HEAD does not contain is ignored: deploying HEAD's own C2 is a full deploy, not a no-op under C3, and the rollback target is the recorded C1 (result ${result(x) || "none"}, rollback target ${short(deployedFrom(x))})`]];
	},
	// ── N-2: whether the app answers never lets main move back over a started commit.
	checkMissedNoop(S, tag) {
		// C3 was started (pm2 proved the restart and reported it online) and never
		// recorded, and the app misses the check now. Deploying C2, an older
		// commit, is a no-op on C3: the check chooses only the rollback target.
		resetBox(C3, { verified: C1, started: C3 });
		const x = deployFast(S, { SHA: C2, STUB_HTTP_CODE: "503" });
		return [
			[isNoop(x) && mainAt() === C3 && head() === C3 && lastField(x.stdout, "DEPLOYED_TO") === C3,
				`${tag}§13 the started C3 misses the check: deploying C2 is a no-op that never moves main back over C3 (code ${x.code}, result ${result(x) || "none"}, main ${short(mainAt())})`],
			[deployedFrom(x) === C1, `${tag}§13 …and the missed check only makes the recorded C1 the rollback target (got ${short(deployedFrom(x))})`],
		];
	},
	checkMissedPin(S, tag) {
		// A pin, S1, started and never recorded, with main at C3, and the app
		// missing the check. Deploying C2 would move main back from C3 (which may
		// have run before the pin) and replace the S1 that ran. Refused.
		resetBox(C3, { detachAt: S1, verified: C1, started: S1 });
		const x = deployFast(S, { SHA: C2, STUB_HTTP_CODE: "503" });
		return [[x.code === 1 && /cannot prove main's extra commits never ran/.test(x.out) && mainAt() === C3 && head() === S1 && !/restart/.test(log("pm2")),
			`${tag}§13 a started pin S1 that misses the check: deploying C2 is refused, main stays C3 and HEAD S1, nothing restarted (code ${x.code}, main ${short(mainAt())}, HEAD ${short(head())})`]];
	},
	startedHeldThroughMerge(S, tag) {
		// HEAD holds a started commit that does not follow the record, through a
		// merge made on the box (-s ours, so no conflict) of the verified C2 and
		// the started S1. Moving main back from C3 to C2 would drop S1, which ran:
		// $SHA must contain every started commit HEAD holds.
		resetBox(C3, { detachAt: C2, verified: C2, started: S1 });
		git(D.box, "merge", "-q", "-s", "ours", "--no-ff", "-m", "box merge", S1);
		const merged = head();
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [[x.code === 1 && /cannot prove main's extra commits never ran/.test(x.out) && mainAt() === C3 && head() === merged && !/restart/.test(log("pm2")),
			`${tag}§13 HEAD holds the started S1 through a merge: deploying C2 is refused, main stays C3 and nothing restarts (code ${x.code}, main ${short(mainAt())})`]];
	},
	// ── N-1: a rollback never targets the commit whose checks just failed.
	healOfFailedStarted(S, tag) {
		const r = [];
		// C3 deployed and started, its checks failed, and its rollback never ran
		// (ssh gave up): started C3, recorded C2, the app still answering. That is
		// the state startedMark shows a real deploy leaves, set up directly.
		resetBox(C3, { verified: C2, started: C3 });
		// Drift reads it as behind-healable; the heal prep writes the marker.
		let out = checkOut(S);
		const h = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: field(out, "DRIFT_LOCAL") });
		r.push([field(out, "DRIFT_STATE") === "behind-healable" && field(h.out, "HEAL_READY") === "yes" && marker() === C3,
			`${tag}§13 (setup) drift heals it once: behind-healable, marker C3 (got ${field(out, "DRIFT_STATE")})`]);
		// The heal deploys C3 again. LIVE is C3, the very commit it restarts.
		const x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		const prev = deployedFrom(x);
		r.push([x.code === 0 && didFullDeploy(x) && prev === C2 && /a rollback of this deploy returns to [0-9a-f]{40} instead, and drops: [0-9a-f]{7,} c3$/m.test(x.out),
			`${tag}§13 a heal of the started C3 names the verified C2 as its rollback target, never C3 itself, and says what that drops (got ${short(prev)})`]);
		// Its checks fail again: the action rolls back to what the deploy reported.
		const y = rollback(S, prev, { RECORD_STATE: lastField(x.stdout, "DEPLOY_RECORD_STATE") });
		r.push([y.code === 0 && /ROLLBACK OK/.test(y.out) && head() === C2 && verified() === C2 && started() === C2 && marker() === C3,
			`${tag}§13 …failing again, it rolls back to C2: C3 is never recorded, and the drift marker names C3 (HEAD ${short(head())}, record ${short(verified())}, marker ${short(marker())})`]);
		out = checkOut(S);
		r.push([field(out, "DRIFT_STATE") === "behind-already-attempted",
			`${tag}§13 …so drift alarms on C3 instead of reading in-sync (got ${field(out, "DRIFT_STATE")})`]);
		return r;
	},
	noopAfterHalfFinished(S, tag) {
		// The started C2 is live and unrecorded, and a later deploy died after
		// checking out C3. Deploying C1 is a no-op whose checks judge C2. If they
		// fail, the rollback returns to the recorded C1: a rollback to C2 would
		// record C2 as verified right after it failed (HEAD, C3, is not C2).
		resetBox(C2, { verified: C1, started: C2 });
		leaveHalfFinished(C3);
		const x = runSh(S.deploy, deployEnv({ SHA: C1 }));
		const r = [[isNoop(x) && deployedFrom(x) === C1 && lastField(x.stdout, "DEPLOYED_TO") === C2,
			`${tag}§13 a no-op on the started C2 names the recorded C1 as its rollback target, never C2 (result ${result(x) || "none"}, rollback target ${short(deployedFrom(x))})`]];
		const y = rollback(S, deployedFrom(x), { RECORD_STATE: lastField(x.stdout, "DEPLOY_RECORD_STATE") });
		r.push([y.code === 0 && head() === C1 && verified() === C1 && marker() === C3,
			`${tag}§13 …so failing its checks returns the box to C1, and C2 is never recorded (record ${short(verified())}, marker ${short(marker())})`]);
		return r;
	},
	notOnlineNotStarted(S, tag) {
		resetBox(C1, { verified: C1, started: C1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2, STUB_PM2_STATUS: "errored" }));
		return [[x.code === 0 && /^restart /m.test(log("pm2")) && /pm2 reports status=errored/.test(x.out) && started() === C1,
			`${tag}§13 a restart pm2 does not report online is reported, not fatal (the smoke check decides), and marks nothing started (code ${x.code}, started ${short(started())})`]];
	},
	startedOlderThanRecord(S, tag) {
		// …and when such a deploy's checks passed anyway, the record step records
		// it: the record is newer than the mark, and the mark does not win.
		resetBox(C2, { verified: C2, started: C1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		return [[x.code === 0 && deployedFrom(x) === C2,
			`${tag}§13 a started mark older than the record never wins: the rollback target is the recorded C2, not the started C1 (got ${short(deployedFrom(x))})`]];
	},
	boxOnlyCommit(S, tag) {
		// (D) Local main holds a commit only this clone has (made by hand): main
		// moves back only when origin/main contains all of it.
		resetBox(C2, { verified: C1 });
		fs.writeFileSync(path.join(D.box, "app.txt"), "box-only\n");
		git(D.box, "commit", "-q", "-am", "box-only commit");
		const boxCommit = head();
		const x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		const main = git(D.box, "rev-parse", "main");
		return [[x.code === 1 && /cannot prove main's extra commits never ran/.test(x.out) && main === boxCommit && head() === boxCommit && !/restart/.test(log("pm2")),
			`${tag}§13 (D) main holds a commit only this clone has: deploying C3 is refused, and that commit stays on main (code ${x.code}, main ${short(main)})`]];
	},
	verifiedOffMainPin(S, tag) {
		// (E) A verified pin off main (S1) with main at C3: C3 may have run before
		// the pin, so main is not moved back to C2 over it.
		resetBox(C3, { detachAt: S1, verified: S1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		const main = git(D.box, "rev-parse", "main");
		return [[x.code === 1 && main === C3 && head() === S1 && !/restart/.test(log("pm2")),
			`${tag}§13 (E) with a verified pin off main (S1) and main at C3, deploying C2 is refused and main stays C3 (code ${x.code}, main ${short(main)})`]];
	},
	offMainLiveNoNoop(S, tag) {
		// (F) The verified S1 contains C1, but a no-op needs a live commit ON main.
		resetBox(C1, { detachAt: S1, verified: S1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C1 }));
		return [[x.code === 0 && didFullDeploy(x) && head() === C1 && onMain(),
			`${tag}§13 (F) with the verified S1 pinned off main, deploying C1 (an ancestor of S1) is a full deploy onto main, not a no-op (code ${x.code}, result ${result(x) || "none"}, HEAD ${short(head())})`]];
	},
	resultLastLineDeployed(S, tag) {
		// The action takes the LAST line of each kind, and DEPLOY_RESULT is the
		// final line of the deploy's stdout on both paths.
		resetBox(C1, { verified: C1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [
			[lastStdoutLine(x) === "DEPLOY_RESULT=deployed" && valuesOnce(x),
				`${tag}§13 a deploy's stdout ends with DEPLOY_RESULT=deployed, each value printed once (last line ${JSON.stringify(lastStdoutLine(x))})`],
			// The sandbox's main commits carry no server.js, so none has the check.
			[lastField(x.stdout, "DEPLOY_HANDSHAKE_GUARD") === "0", `${tag}§13 …and reports DEPLOY_HANDSHAKE_GUARD=0 for a commit without the live-update Origin check`],
		];
	},
	resultLastLineNoop(S, tag) {
		resetBox(C3, { verified: C3 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [[lastStdoutLine(x) === "DEPLOY_RESULT=noop" && valuesOnce(x),
			`${tag}§13 a no-op's stdout ends with DEPLOY_RESULT=noop, each value printed once (last line ${JSON.stringify(lastStdoutLine(x))})`]];
	},
	handshakeGuard(S, tag) {
		// A commit whose server.js has the live-update Origin check reports 1.
		resetBox(C3, { verified: C3 });
		git(D.box, "checkout", "-q", "--detach", C3);
		fs.writeFileSync(path.join(D.box, "server.js"), "const io = new Server(httpServer, {\n\tallowRequest: liveUpdateHandshakeAllowed,\n});\n");
		git(D.box, "add", "server.js");
		git(D.box, "commit", "-q", "-m", "guarded");
		const guarded = head();
		git(D.box, "checkout", "-q", "main");
		const x = runSh(S.deploy, deployEnv({ REF: guarded }));
		const guard = lastField(x.stdout, "DEPLOY_HANDSHAKE_GUARD");
		return [[x.code === 0 && head() === guarded && guard === "1",
			`${tag}§13 a commit whose server.js has the live-update Origin check reports DEPLOY_HANDSHAKE_GUARD=1 (code ${x.code}, guard ${guard || "none"})`]];
	},
	rollbackToLive(S, tag) {
		// The whole chain: C2 restarted but never recorded; C3's deploy then fails
		// verification and rolls back with what that deploy reported.
		const r = [];
		resetBox(C2, { verified: C1, started: C2 });
		const d = runSh(S.deploy, deployEnv({ SHA: C3 }));
		const prev = deployedFrom(d);
		const state = lastField(d.stdout, "DEPLOY_RECORD_STATE");
		const x = rollback(S, prev, { RECORD_STATE: state });
		r.push([prev === C2 && state === "ok" && x.code === 0 && /ROLLBACK OK/.test(x.out) && head() === C2,
			`${tag}§13 C3's deploy reports the started C2 and a consistent record, and its rollback returns the box to C2 (prev ${short(prev)}, state ${state || "none"}, code ${x.code})`]);
		r.push([verified() === C2 && started() === C2 && /logisx: started \(rollback\)/.test(reflog(STARTED_REF)),
			`${tag}§13 …serving again, it records C2 as verified and marks it started (record ${short(verified())}, started ${short(started())})`]);
		const out = checkOut(S);
		r.push([field(out, "DRIFT_RECORD") === "ok" && field(out, "DRIFT_LOCAL") === C2 && field(out, "DRIFT_STATE") === "behind-already-attempted",
			`${tag}§13 …consistent with the rolled-back HEAD, and drift still alarms on the rejected C3 (got ${field(out, "DRIFT_STATE")})`]);
		return r;
	},
};

// ─────────────────────── §14 THE ACTION
// .github/actions/vps-deploy is the one path every deploy takes (deploy.yml's
// staging and production jobs, the drift heal). Its steps are read from the
// real file; the deploy step and the edge check are run for real against stubs.
const ACTION = fs.readFileSync(path.join(__dirname, "..", ".github/actions/vps-deploy/action.yml"), "utf8");
const SERVER = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
// The composite action's steps in order, as { name, text }.
function actionSteps(yaml) {
	const steps = [];
	for (const l of yaml.split("\n")) {
		const m = /^ {4}- name:\s*(.*)$/.exec(l);
		if (m) { steps.push({ name: m[1].trim(), text: `${l}\n` }); continue; }
		if (steps.length) steps[steps.length - 1].text += `${l}\n`;
	}
	return steps;
}
// A step key's value: a one-liner as a string, a `|` block as its lines.
function stepValue(stepText, key) {
	const lines = stepText.split("\n");
	const i = lines.findIndex((l) => l.startsWith(`      ${key}:`));
	if (i < 0) return null;
	const first = lines[i].slice(`      ${key}:`.length).trim();
	if (!/^[|>][-+]?$/.test(first)) return first;
	const body = [];
	for (let j = i + 1; j < lines.length && (!lines[j].trim() || /^ {8}/.test(lines[j])); j++) body.push(lines[j]);
	return body;
}
const collapse = (v) => (Array.isArray(v) ? v.join(" ") : String(v || "")).replace(/\s+/g, " ").trim();
// A step's `run:` script, as bash gets it (a `|` block, or a one-liner).
const stepRun = (step) => {
	const body = step ? stepValue(step.text, "run") : null;
	if (Array.isArray(body)) return `${body.map((l) => l.slice(8)).join("\n")}\n`;
	return body ? `${body}\n` : "";
};

const RECORD_IF = "steps.deploy.outcome == 'success' && steps.deploy.outputs.result == 'deployed' && steps.smoke.outcome == 'success' && (inputs.public_url == '' || steps.edge.outcome == 'success')";
const RECORD_CONTINUE = "${{ inputs.rollback_on_failure != 'true' }}";
function actionPins(yaml, tag = "") {
	const r = [];
	const steps = actionSteps(yaml);
	const at = (re) => steps.findIndex((s) => re.test(s.text));
	const iDeploy = at(/< scripts\/deploy\/remote-deploy\.sh/);
	const iSmoke = at(/< scripts\/deploy\/remote-smoke\.sh/);
	const iEdge = steps.findIndex((s) => s.name === "Public edge check");
	const iRecord = at(/< scripts\/deploy\/remote-record-verified\.sh/);
	const iRollback = at(/< scripts\/deploy\/remote-rollback\.sh/);
	r.push([iDeploy >= 0 && iSmoke > iDeploy && iEdge > iSmoke && iRecord > iEdge,
		`${tag}§14 the action records the deploy only after the deploy, the smoke check and the edge check (steps ${iDeploy}, ${iSmoke}, ${iEdge}, ${iRecord})`]);
	const cond = iRecord >= 0 ? collapse(stepValue(steps[iRecord].text, "if")) : "";
	r.push([cond === RECORD_IF, `${tag}§14 …and only when the deploy succeeded with DEPLOY_RESULT=deployed, the smoke check passed, and the edge check passed where the job has one (got ${JSON.stringify(cond)})`]);
	const coe = iRecord >= 0 ? collapse(stepValue(steps[iRecord].text, "continue-on-error")) : "";
	r.push([coe === RECORD_CONTINUE, `${tag}§14 …a failed record fails production's job, never staging's (continue-on-error: ${coe || "absent"})`]);
	r.push([steps.filter((s) => /remote-record-verified\.sh/.test(s.text)).length === 1, `${tag}§14 exactly one step records`]);
	r.push([iRecord >= 0 && /^\s*SHA:\s*\$\{\{\s*steps\.deploy\.outputs\.to\s*\}\}\s*$/m.test(steps[iRecord].text), `${tag}§14 …the commit the deploy reported as DEPLOYED_TO`]);
	r.push([[iDeploy, iSmoke, iEdge].every((i) => i >= 0 && !/update-ref|remote-record-verified/.test(steps[i].text)), `${tag}§14 nothing before verification writes the record`]);
	r.push([iEdge >= 0 && /^\s*HANDSHAKE_GUARD:\s*\$\{\{\s*steps\.deploy\.outputs\.handshake_guard\s*\}\}\s*$/m.test(steps[iEdge].text),
		`${tag}§14 the edge check is told the deploy's handshake_guard`]);
	r.push([iRollback >= 0 && /^\s*RECORD_STATE:\s*\$\{\{\s*steps\.deploy\.outputs\.record_state\s*\}\}\s*$/m.test(steps[iRollback].text)
		&& /PREV='\$PREV' RECORD_STATE='\$RECORD_STATE' bash -s/.test(steps[iRollback].text),
	`${tag}§14 the rollback is handed the deploy's record_state beside PREV`]);
	return r;
}

// The deploy step, run for real in a scratch directory whose
// scripts/deploy/ssh-retry.sh is a stub: it logs the remote command and prints
// a canned deploy output.
const deployStepScript = (yaml) => stepRun(actionSteps(yaml).find((s) => /< scripts\/deploy\/remote-deploy\.sh/.test(s.text)));
let stepCwd = null;
function runDeployStep(script, { REF = "main", SHA = "", out = "" } = {}) {
	if (!stepCwd) {
		stepCwd = path.join(T, "step-cwd");
		fs.mkdirSync(path.join(stepCwd, "scripts", "deploy"), { recursive: true });
		fs.writeFileSync(path.join(stepCwd, "scripts", "deploy", "ssh-retry.sh"),
			"#!/bin/bash\ncat > /dev/null\nprintf '%s\\n' \"$2\" >> \"$STUB_LOG_DIR/step-ssh.log\"\nprintf '%s' \"$STUB_DEPLOY_OUT\"\n");
		fs.writeFileSync(path.join(stepCwd, "scripts", "deploy", "remote-deploy.sh"), "# stands in for the real script: the stub never runs it\n");
	}
	clearLogs();
	const x = spawnStep(script, stepCwd, { PATH: process.env.PATH, HOME: D.home, HOST: "203.0.113.9", USER: "deploy", DIR: "/srv/app", PM2: "logistics-app", REF, SHA, STUB_LOG_DIR: D.logs, STUB_DEPLOY_OUT: out });
	return { ...x, calls: log("step-ssh") };
}
// Runs a step's script as the runner does, and returns its exit code, its
// output and what it wrote to $GITHUB_OUTPUT.
function spawnStep(script, cwd, env) {
	const outputs = path.join(T, "step-github-output");
	fs.writeFileSync(outputs, "");
	// ⚠️ stderr goes to a real FILE, as it does on a GitHub runner. The step
	// pipes the deploy's output through `tee /dev/stderr`, and Node's default
	// stdio "pipes" are UNIX sockets on Linux, where opening /dev/stderr on a
	// socket fails (ENXIO): tee exits non-zero and pipefail ends the step with
	// no outputs. macOS opens it either way, so only CI ever saw this.
	const errPath = path.join(T, "step-stderr");
	const errFd = fs.openSync(errPath, "w");
	let x;
	try {
		x = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
			cwd,
			encoding: "utf8",
			stdio: ["pipe", "pipe", errFd],
			env: { ...env, GITHUB_OUTPUT: outputs },
		});
	} finally {
		fs.closeSync(errFd);
	}
	const got = {};
	for (const l of fs.readFileSync(outputs, "utf8").split("\n").filter(Boolean)) got[l.slice(0, l.indexOf("="))] = l.slice(l.indexOf("=") + 1);
	return { code: x.status, out: `${x.stdout}${fs.readFileSync(errPath, "utf8")}`, outputs: got };
}
// End to end: here the ssh-retry.sh stand-in runs the remote command locally,
// so the REAL remote scripts (or mutants of them) deploy, check, record and
// roll back the sandbox box, and each step parses what they really printed.
let realStepCwd = null;
function realCwd(S) {
	if (!realStepCwd) {
		realStepCwd = path.join(T, "real-step-cwd");
		fs.mkdirSync(path.join(realStepCwd, "scripts", "deploy"), { recursive: true });
		fs.writeFileSync(path.join(realStepCwd, "scripts", "deploy", "ssh-retry.sh"), '#!/bin/bash\nexec bash -c "$2"\n');
		fs.writeFileSync(path.join(realStepCwd, "scripts", "deploy", "ssh-setup.sh"), "#!/bin/bash\nexit 0\n");
	}
	const put = (name, text) => fs.writeFileSync(path.join(realStepCwd, "scripts", "deploy", name), text);
	put("remote-deploy.sh", S.deploy);
	put("remote-smoke.sh", SMOKE);
	put("remote-record-verified.sh", S.record);
	put("remote-rollback.sh", S.rollback);
	return realStepCwd;
}
function runRealDeployStep(script, S, env = {}) {
	return spawnStep(script, realCwd(S), { ...ENV, HOST: "203.0.113.9", USER: "deploy", DIR: D.box, PM2: "logistics-app", REF: "main", ...env });
}
// Named, so a mutant re-runs only the scenario that targets it.
const REAL_STEP_CASES = {
	restartProven(script, S, tag) {
		resetBox(C1, { verified: C1, started: C1 });
		const x = runRealDeployStep(script, S, { SHA: C2 });
		return [[x.code === 0 && x.outputs.result === "deployed" && x.outputs.prev === C1 && x.outputs.to === C2 && started() === C2,
			`${tag}§14 end to end, a proven restart: the deploy step succeeds and hands the record step C2 with result=deployed (code ${x.code}, outputs ${JSON.stringify(x.outputs)})`]];
	},
};
const realStepPins = (script, S, tag = "", names = Object.keys(REAL_STEP_CASES)) => names.flatMap((n) => REAL_STEP_CASES[n](script, S, tag));

// A GitHub expression, in the shapes action.yml uses: 'strings', dotted
// context paths, true/false, == != && || and parentheses, and the status
// functions. It returns values the way GitHub does (`a || b` gives an operand).
function evalExpr(expr, ctx) {
	const toks = String(expr).match(/\(|\)|&&|\|\||==|!=|'(?:[^']|'')*'|[A-Za-z_][\w.-]*(?:\(\))?/g) || [];
	let i = 0;
	const prim = () => {
		const t = toks[i++];
		if (t === "(") { const v = or(); i++; return v; }
		if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
		if (t.endsWith("()")) return ctx.status[t.slice(0, -2)]();
		if (t === "true" || t === "false") return t === "true";
		const v = t.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
		return v == null ? "" : v;
	};
	const cmp = () => { let l = prim(); while (toks[i] === "==" || toks[i] === "!=") { const op = toks[i++]; const r = prim(); l = (String(l) === String(r)) === (op === "=="); } return l; };
	const and = () => { let l = cmp(); while (toks[i] === "&&") { i++; const r = cmp(); l = l && r; } return l; };
	const or = () => { let l = and(); while (toks[i] === "||") { i++; const r = and(); l = l || r; } return l; };
	return or();
}
// Whether a step runs: its `if:` with GitHub's implicit success() when it
// names no status function, and success() when it has no `if:` at all.
const stepRuns = (cond, ctx) => {
	const c = cond || "success()";
	return Boolean(evalExpr(/\b(success|failure|always|cancelled)\(\)/.test(c) ? c : `success() && (${c})`, ctx));
};
// A step's `env:`, each ${{ … }} evaluated.
function stepEnvOf(stepText, ctx) {
	const lines = stepText.split("\n");
	const at = lines.findIndex((l) => /^ {6}env:\s*$/.test(l));
	const env = {};
	for (let j = at + 1; at >= 0 && j < lines.length && /^ {8}\S/.test(lines[j]); j++) {
		const m = /^ {8}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(lines[j]);
		if (m) env[m[1]] = m[2].replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, e) => String(evalExpr(e, ctx)));
	}
	return env;
}
// The WHOLE action, step by step, as a runner runs it: each `if:` evaluated,
// each `env:` resolved, each `run:` executed, continue-on-error honoured. It
// returns each step's outcome by name, the steps context, and whether the job
// ended red.
function runAction(yaml, S, inputs, env = {}) {
	const cwd = realCwd(S);
	let failed = false;
	const ctx = { inputs, steps: {}, status: { success: () => !failed, failure: () => failed, always: () => true, cancelled: () => false } };
	const ran = {};
	for (const s of actionSteps(yaml)) {
		const id = collapse(stepValue(s.text, "id"));
		if (!stepRuns(collapse(stepValue(s.text, "if")), ctx)) {
			ran[s.name] = "skipped";
			if (id) ctx.steps[id] = { outcome: "skipped", conclusion: "skipped", outputs: {} };
			continue;
		}
		const x = spawnStep(stepRun(s), cwd, { ...ENV, PATH: `${fastBinDir()}:${ENV.PATH}`, GITHUB_STEP_SUMMARY: path.join(T, "step-summary"), ...env, ...stepEnvOf(s.text, ctx) });
		const outcome = x.code === 0 ? "success" : "failure";
		const coe = collapse(stepValue(s.text, "continue-on-error"));
		const keepGoing = /^\$\{\{/.test(coe) ? Boolean(evalExpr(coe.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), ctx)) : coe === "true";
		if (outcome === "failure" && !keepGoing) failed = true;
		ran[s.name] = outcome;
		if (id) ctx.steps[id] = { outcome, conclusion: outcome === "failure" && keepGoing ? "success" : outcome, outputs: x.outputs };
	}
	return { ran, steps: ctx.steps, failed };
}
const PROD_INPUTS = {
	dir: D.box, pm2: "logistics-app", ref: "main", sha: C2, rollback_on_failure: "true",
	public_url: "https://app.example.test/api/config/maintenance", ssh_key: "k", known_hosts: "h", host: "203.0.113.9", user: "deploy",
};
// Named, so a mutant re-runs only the scenario that targets it.
const ACTION_RUN_CASES = {
	unprovenRollsBack(yaml, S, tag) {
		// pm2 answers 0 but the deploy's restart never moves the start time: the
		// old process may still serve. The deploy reports unproven; the smoke and
		// edge checks still run (and pass, reading whatever serves); nothing
		// records C2; production rolls back to C1, whose own restart pm2 does
		// prove; and the job still ends red.
		resetBox(C1, { verified: C1, started: C1 });
		const a = runAction(yaml, S, PROD_INPUTS, { STUB_PM2_RESTART_NOOP: "once" });
		const out = (a.steps.deploy || {}).outputs || {};
		return [
			[a.ran.Deploy === "success" && out.result === "unproven" && out.prev === C1 && out.to === C2,
				`${tag}§14 the whole action, a restart that did not take: the deploy step reports result=unproven with rollback target C1 (outputs ${JSON.stringify(out)})`],
			[a.ran["Smoke check"] === "success" && a.ran["Public edge check"] === "success" && a.ran["Record the verified deploy"] === "skipped",
				`${tag}§14 …the smoke and edge checks still run, and the record step never does (${JSON.stringify(a.ran)})`],
			[a.ran["Auto-rollback"] === "success" && head() === C1 && started() === C1 && verified() === C1 && marker() === C2,
				`${tag}§14 …production rolls back to C1: C2 is never recorded, and the drift marker names C2 (HEAD ${short(head())}, record ${short(verified())}, marker ${short(marker())})`],
			[a.ran["Fail the job if verification failed"] === "failure" && a.failed,
				`${tag}§14 …and the job still ends red`],
		];
	},
};
const actionRunPins = (yaml, S, tag = "", names = Object.keys(ACTION_RUN_CASES)) => names.flatMap((n) => ACTION_RUN_CASES[n](yaml, S, tag));
const deployOut = (o = {}) => `${[
	`DEPLOYED_FROM=${o.from ?? C1}`,
	`DEPLOYED_TO=${o.to ?? C2}`,
	`DEPLOY_RECORD_STATE=${o.state ?? "ok"}`,
	`DEPLOY_HANDSHAKE_GUARD=${o.guard ?? "1"}`,
	`DEPLOY_RESULT=${o.result ?? "deployed"}`,
].join("\n")}\n`;
const DEPLOY_STEP_WANT = { prev: C1, to: C2, record_state: "ok", handshake_guard: "1", result: "deployed" };
const sameOutputs = (got) => Object.entries(DEPLOY_STEP_WANT).every(([k, v]) => got[k] === v);
// Named, so a mutant re-runs only the scenarios that target it.
const DEPLOY_STEP_CASES = {
	plain(script, tag) {
		const x = runDeployStep(script, { out: deployOut() });
		return [[x.code === 0 && sameOutputs(x.outputs) && x.calls === "DIR='/srv/app' PM2='logistics-app' REF='main' SHA='' bash -s\n",
			`${tag}§14 the deploy step runs the box's deploy once and outputs prev, to, record_state, handshake_guard and result (got ${JSON.stringify(x.outputs)}, code ${x.code})`]];
	},
	earlierLines(script, tag) {
		// Lines of the same shape printed EARLIER (by git, npm, the app) never stand in.
		const x = runDeployStep(script, { out: `DEPLOY_RESULT=noop\nDEPLOYED_FROM=${S1}\nDEPLOYED_TO=${S1}\nDEPLOY_HANDSHAKE_GUARD=0\nDEPLOY_RECORD_STATE=missing\n${deployOut()}` });
		return [[x.code === 0 && sameOutputs(x.outputs), `${tag}§14 …each from the LAST line of its kind, so an earlier line of the same shape never stands in (got ${JSON.stringify(x.outputs)})`]];
	},
	wholeLines(script, tag) {
		const x = runDeployStep(script, { out: `${deployOut()}  DEPLOY_RESULT=noop\nDEPLOY_RESULT=noop; x\nDEPLOYED_FROM=${S1} \nDEPLOY_HANDSHAKE_GUARD=0x\nDEPLOY_RECORD_STATE=okay\n` });
		return [[x.code === 0 && sameOutputs(x.outputs), `${tag}§14 …and only from a whole line of the exact shape: an indented, suffixed or padded one never counts (got ${JSON.stringify(x.outputs)})`]];
	},
	shortFrom(script, tag) {
		const x = runDeployStep(script, { out: deployOut({ from: C1.slice(0, 7) }) });
		return [[x.code === 0 && x.outputs.prev === "", `${tag}§14 a DEPLOYED_FROM that is not a full commit id gives no rollback target at all (prev ${JSON.stringify(x.outputs.prev)})`]];
	},
	refRefused(script, tag) {
		return ["main'; touch pwned; '", "-x", "--upload-pack=x", "", "a".repeat(101), "main\nx", "feat x", "main$(id)", "a@{1}"].map((bad) => {
			const x = runDeployStep(script, { REF: bad, out: deployOut() });
			return [x.code === 1 && x.calls === "" && /the ref to deploy is not a plain branch, tag or commit name/.test(x.out) && (bad.length < 3 || !x.out.includes(bad)),
				`${tag}§14 the deploy step refuses REF=${JSON.stringify(bad.slice(0, 24))} before any ssh, without echoing it (code ${x.code})`];
		});
	},
	refTaken(script, tag) {
		return ["main", "feat/x.y_z-1", C1, "a".repeat(100)].map((good) => {
			const x = runDeployStep(script, { REF: good, out: deployOut() });
			return [x.code === 0 && x.calls.includes(`REF='${good}'`), `${tag}§14 …and takes REF=${JSON.stringify(good.slice(0, 24))}`];
		});
	},
	shaRefused(script, tag) {
		return ["abc", C1.toUpperCase(), `${C1} `, `${C1}'`].map((bad) => {
			const x = runDeployStep(script, { SHA: bad, out: deployOut() });
			return [x.code === 1 && x.calls === "" && /the sha to deploy is not a full 40-character commit id/.test(x.out),
				`${tag}§14 the deploy step refuses SHA=${JSON.stringify(bad.slice(0, 12))} before any ssh (code ${x.code})`];
		});
	},
	shaTaken(script, tag) {
		const x = runDeployStep(script, { SHA: C2, out: deployOut() });
		return [[x.code === 0 && x.calls.includes(`SHA='${C2}'`), `${tag}§14 …and takes a full SHA`]];
	},
};
const deployStepPins = (script, tag = "", names = Object.keys(DEPLOY_STEP_CASES)) => names.flatMap((n) => DEPLOY_STEP_CASES[n](script, tag));

// The edge check's own script, run against a stub curl (each kind of request
// answers from its own comma-separated sequence, one entry per call, the last
// repeating) and a stub sleep that returns at once and logs how long it was asked.
const edgeScript = (yaml) => stepRun(actionSteps(yaml).find((s) => s.name === "Public edge check"));
let edgeBin = null;
function edgeBinDir() {
	if (edgeBin) return edgeBin;
	edgeBin = path.join(T, "edge-bin");
	fs.mkdirSync(edgeBin);
	writeExec(path.join(edgeBin, "curl"), [
		"#!/bin/bash",
		"case \"$*\" in",
		"\t*'Origin: https://example.invalid'*) kind=foreign; seq=$STUB_FOREIGN ;;",
		"\t*'Origin: '*) kind=own; seq=$STUB_OWN ;;",
		"\t*) kind=edge; seq=$STUB_EDGE ;;",
		"esac",
		"printf '%s %s\\n' \"$kind\" \"$*\" >> \"$STUB_LOG_DIR/edge-curl.log\"",
		"n=$(grep -c \"^$kind \" \"$STUB_LOG_DIR/edge-curl.log\")",
		"IFS=, read -r -a codes <<<\"$seq\"",
		"i=$(( n <= ${#codes[@]} ? n - 1 : ${#codes[@]} - 1 ))",
		"printf '%s' \"${codes[$i]}\"",
		"",
	].join("\n"));
	writeExec(path.join(edgeBin, "sleep"), "#!/bin/bash\nprintf '%s\\n' \"$*\" >> \"$STUB_LOG_DIR/edge-sleep.log\"\n");
	return edgeBin;
}
function runEdge(script, { edge = "200", own = "200", foreign = "403", guard = "1" } = {}) {
	clearLogs();
	const x = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
		encoding: "utf8",
		env: { PATH: `${edgeBinDir()}:${process.env.PATH}`, PUBLIC_URL: "https://app.example.test/api/config/maintenance", HANDSHAKE_GUARD: guard, STUB_LOG_DIR: D.logs, STUB_EDGE: edge, STUB_OWN: own, STUB_FOREIGN: foreign },
	});
	const calls = log("edge-curl");
	const count = (kind) => (calls.match(new RegExp(`^${kind} `, "gm")) || []).length;
	return { code: x.status, out: `${x.stdout}${x.stderr}`, calls, edge: count("edge"), own: count("own"), foreign: count("foreign"), sleeps: log("edge-sleep").split("\n").filter(Boolean) };
}
const edgeErr = (x) => (x.out.match(/^::error::.*$/m) || [""])[0];
const edgeCounts = (x) => `edge ${x.edge}, own ${x.own}, foreign ${x.foreign}, sleeps ${JSON.stringify(x.sleeps)}`;
// Named, so a mutant re-runs only the scenarios that target it.
const EDGE_CASES = {
	allGood(script, tag) {
		const x = runEdge(script);
		return [
			[x.code === 0 && x.edge === 1 && x.own === 1 && x.foreign === 1 && x.sleeps.length === 0,
				`${tag}§14 edge 200, own Origin 200, foreign Origin 403 → the edge check passes, one request each, no waiting (code ${x.code}, ${edgeCounts(x)})`],
			[/^own .*-H Origin: https:\/\/app\.example\.test https:\/\/app\.example\.test\/socket\.io\/\?EIO=4&transport=polling$/m.test(x.calls)
				&& /^foreign .*-H Origin: https:\/\/example\.invalid https:\/\/app\.example\.test\/socket\.io\/\?EIO=4&transport=polling$/m.test(x.calls),
			`${tag}§14 …asking the live-update handshake on the public host, once as the app's own Origin and once as a foreign one`],
		];
	},
	// No answer yet, or a 5xx: retried, 10 s apart, up to 3 tries.
	ownRecovers(script, tag) {
		const x = runEdge(script, { own: "000,200" });
		return [[x.code === 0 && x.own === 2 && x.sleeps.join(" ") === "10", `${tag}§14 the handshake unanswered (000) once, then 200 → retried after 10 s, and passes (code ${x.code}, ${edgeCounts(x)})`]];
	},
	edgeRecovers(script, tag) {
		const x = runEdge(script, { edge: "502,503,200" });
		return [[x.code === 0 && x.edge === 3 && x.sleeps.join(" ") === "10 10", `${tag}§14 the public edge 502, 503, then 200 → passes on the third try (code ${x.code}, ${edgeCounts(x)})`]];
	},
	edgeGivesUp(script, tag) {
		const x = runEdge(script, { edge: "502" });
		return [[x.code !== 0 && x.edge === 3 && x.own === 0 && /public edge returned 502/.test(edgeErr(x)), `${tag}§14 the public edge 502 three times → fails after 3 tries, asking nothing else (code ${x.code}, ${edgeCounts(x)})`]];
	},
	ownGivesUp(script, tag) {
		const x = runEdge(script, { own: "000" });
		return [[x.code !== 0 && x.own === 3 && x.foreign === 0 && /own Origin gave 000/.test(edgeErr(x)), `${tag}§14 the handshake never answering → fails after 3 tries (code ${x.code}, ${edgeCounts(x)})`]];
	},
	// A definite answer is never retried.
	foreignLetIn(script, tag) {
		const x = runEdge(script, { foreign: "200" });
		return [[x.code !== 0 && x.foreign === 1 && x.sleeps.length === 0 && /a foreign Origin gave 200/.test(edgeErr(x)),
			`${tag}§14 a foreign Origin let in (200) → fails at once, no retry, so production rolls back (code ${x.code}, ${edgeCounts(x)})`]];
	},
	ownRefused(script, tag) {
		const x = runEdge(script, { own: "403" });
		return [[x.code !== 0 && x.own === 1 && x.foreign === 0 && x.sleeps.length === 0 && /own Origin gave 403/.test(edgeErr(x)),
			`${tag}§14 the app's own Origin refused (403) → fails at once, no retry (code ${x.code}, ${edgeCounts(x)})`]];
	},
	edgeNotFound(script, tag) {
		const x = runEdge(script, { edge: "404" });
		return [[x.code !== 0 && x.edge === 1 && x.sleeps.length === 0, `${tag}§14 the public edge answering 404 → fails at once, no retry (code ${x.code}, ${edgeCounts(x)})`]];
	},
	// The foreign Origin is asked unless the deploy said the commit predates the check.
	guardOff(script, tag) {
		const x = runEdge(script, { guard: "0", foreign: "200" });
		return [[x.code === 0 && x.foreign === 0 && /predates the live-update Origin check/.test(x.out),
			`${tag}§14 a commit that predates the Origin check (guard 0): the foreign Origin is not asked, and the check passes (code ${x.code}, ${edgeCounts(x)})`]];
	},
	guardUnknown(script, tag) {
		const x = runEdge(script, { guard: "", foreign: "200" });
		return [[x.code !== 0 && x.foreign === 1, `${tag}§14 an unknown guard asks the foreign Origin anyway, so a 200 fails the check (code ${x.code}, ${edgeCounts(x)})`]];
	},
};
const edgePins = (script, tag = "", names = Object.keys(EDGE_CASES)) => names.flatMap((n) => EDGE_CASES[n](script, tag));
// What the deploy looks for is what server.js has: a rename there would make
// every commit read as predating the check, and the foreign Origin would never
// be asked again.
function guardPins(deployText, serverText, tag = "") {
	const needles = [...deployText.matchAll(/git grep -q '([^']+)' "\$(NEW|LIVE)" -- server\.js/g)].map((m) => m[1]);
	return [[needles.length === 2 && needles[0] === needles[1] && serverText.includes(needles[0]),
		`${tag}§14 the deploy looks for one text on both paths (${needles.length} found), and this repo's server.js has it (${JSON.stringify(needles[0] || "")})`]];
}

// ──────────────────────────────────────────────────────────────── §8 mutants
function mutants() {
	const deployWith = (from, to) => ({ ...REAL, deploy: swap(REAL.deploy, from, to) });

	// §13: the started mark and LIVE.
	expectCaught("remote-deploy.sh records its own deploy", LIVE_CASES.startedMark(deployWith(
		'echo "DEPLOYED_FROM=$ROLLBACK_TO"', 'git update-ref refs/logisx/verified-deploy "$NEW"\necho "DEPLOYED_FROM=$ROLLBACK_TO"'), M));
	expectCaught("the deploy never marks a commit started", LIVE_CASES.startedMark(deployWith(
		'git update-ref --create-reflog -m "logisx: started" refs/logisx/started-deploy "$NEW"', "true"), M));
	const ignoreStarted = deployWith("\t\tLIVE=$STARTED\n", "\t\tLIVE=$VERIFIED\n");
	expectCaught("LIVE ignores the started mark", [
		...LIVE_CASES.startedButUnrecorded(ignoreStarted, M),
		...LIVE_CASES.startedAncestorNoop(ignoreStarted, M),
	]);
	expectCaught("the rollback target is a started commit the app does not answer for", LIVE_CASES.startedNotServing(deployWith(
		'elif [ "$LIVE" != "$VERIFIED" ] && [ "$SERVING" != "200" ]; then', "elif false; then"), M));
	expectCaught("a started mark counts though HEAD does not contain it", LIVE_CASES.startedNotInHead(deployWith(
		' && git merge-base --is-ancestor "$STARTED" HEAD; then', "; then"), M));
	expectCaught("a started mark older than the record wins", LIVE_CASES.startedOlderThanRecord(deployWith(
		'git merge-base --is-ancestor "$VERIFIED" "$STARTED" && ', ""), M));
	expectCaught("a restart pm2 does not report online is marked started", LIVE_CASES.notOnlineNotStarted(deployWith(
		'if [ "$PM2_STATUS" = online ]; then', "if true; then"), M));

	// §13 N-2: whether the app answers never moves main back over a started commit.
	expectCaught("LIVE counts a started commit only while the app answers", LIVE_CASES.checkMissedNoop(deployWith(
		'if [ -n "$STARTED" ] && git merge-base --is-ancestor "$VERIFIED" "$STARTED"',
		'if [ -n "$STARTED" ] && [ "$SERVING" = "200" ] && git merge-base --is-ancestor "$VERIFIED" "$STARTED"'), M));

	// §13 N-1: a rollback never targets the commit whose checks just failed.
	expectCaught("a deploy's rollback target is the commit it restarts", LIVE_CASES.healOfFailedStarted(deployWith(
		'if [ "$ROLLBACK_TO" = "$NEW" ] && [ -n "$VERIFIED" ] && [ "$VERIFIED" != "$NEW" ]; then', "if false; then"), M));

	// §13 (D), (E), (F): each clause of the no-op and the move back.
	expectCaught("(D) main moves back over a commit only this clone has", LIVE_CASES.boxOnlyCommit(deployWith(
		" \\\n\t\t&& git merge-base --is-ancestor main origin/main; then", "; then"), M));
	expectCaught("(E) main moves back though the live commit is not below SHA", LIVE_CASES.verifiedOffMainPin(deployWith(
		'elif [ -n "$LIVE" ] && git merge-base --is-ancestor "$LIVE" "$SHA" \\\n\t\t&& ', 'elif [ -n "$LIVE" ] && '), M));
	expectCaught("(F) a live commit off main makes a no-op", LIVE_CASES.offMainLiveNoNoop(deployWith(
		' \\\n\t\t&& git merge-base --is-ancestor "$LIVE" origin/main; then', "; then"), M));

	// §13: the deploy's output.
	expectCaught("DEPLOY_RESULT is not the last line", LIVE_CASES.resultLastLineDeployed(deployWith(
		'echo "DEPLOY_RESULT=$RESULT"\n', 'echo "DEPLOY_RESULT=$RESULT"\necho "deploy finished"\n'), M));
	expectCaught("the handshake guard is read from the commit before the deploy", LIVE_CASES.handshakeGuard(deployWith(
		'"$NEW" -- server.js', '"$PREV" -- server.js'), M));
	expectCaught("the deploy looks for text server.js does not have", guardPins(swap(REAL.deploy,
		"'allowRequest: liveUpdateHandshakeAllowed'", "'allowRequest: liveUpdateOriginCheck'"), SERVER, M));

	// §14: the action's record step, and what it hands the edge check and the rollback.
	expectCaught("the action records without the smoke check", actionPins(swap(ACTION,
		"steps.smoke.outcome == 'success' &&\n        (inputs.public_url", "(inputs.public_url"), M));
	expectCaught("the action records without the edge check", actionPins(swap(ACTION,
		"steps.smoke.outcome == 'success' &&\n        (inputs.public_url == '' || steps.edge.outcome == 'success')", "steps.smoke.outcome == 'success'"), M));
	expectCaught("the action records a no-op", actionPins(swap(ACTION, " && steps.deploy.outputs.result == 'deployed' &&", " &&"), M));
	{
		const a = ACTION.indexOf("    - name: Record the verified deploy\n");
		const b = ACTION.indexOf("    - name: Auto-rollback\n");
		const step = ACTION.slice(a, b);
		const moved = `${ACTION.slice(0, a)}${ACTION.slice(b)}`.replace("    - name: Smoke check\n", `${step}    - name: Smoke check\n`);
		ok(a > 0 && b > a && moved !== ACTION, "§8 mutant 'the action records before the smoke check' must change the action");
		expectCaught("the action records before the smoke check", actionPins(moved, M));
	}
	expectCaught("staging's failed record fails the job", actionPins(swap(ACTION,
		"      continue-on-error: ${{ inputs.rollback_on_failure != 'true' }}\n", ""), M));
	expectCaught("the edge check is never told the handshake guard", actionPins(swap(ACTION,
		"        HANDSHAKE_GUARD: ${{ steps.deploy.outputs.handshake_guard }}\n", ""), M));
	expectCaught("the rollback is not told the record state", actionPins(swap(ACTION,
		" RECORD_STATE='$RECORD_STATE' bash -s", " bash -s"), M));

	// §14: the deploy step's input checks and output parsing.
	const step = deployStepScript(ACTION);
	expectCaught("the deploy step reads the first line of its kind", deployStepPins(swap(step, "| tail -1 |", "| head -1 |"), M, ["earlierLines"]));
	expectCaught("the deploy step matches inside a line", deployStepPins(swap(step, 'grep -E "^$1=($2)\\$"', 'grep -E "$1=($2)"'), M, ["wholeLines"]));
	expectCaught("any ref reaches the box", deployStepPins(swap(step,
		'if ! [[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || [[ "$REF" == -* ]]; then', "if false; then"), M, ["refRefused"]));
	expectCaught("a ref may start with a dash", deployStepPins(swap(step, ' || [[ "$REF" == -* ]]', ""), M, ["refRefused"]));
	expectCaught("any SHA reaches the box", deployStepPins(swap(step,
		'if [ -n "$SHA" ] && ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then', "if false; then"), M, ["shaRefused"]));
	expectCaught("the rollback target takes any hex length", deployStepPins(swap(step,
		"last_line DEPLOYED_FROM '[0-9a-f]{40}'", "last_line DEPLOYED_FROM '[0-9a-f]+'"), M, ["shortFrom"]));
	// §14: an unproven restart rolls production back.
	expectCaught("an unproven restart does not roll production back", actionRunPins(swap(ACTION,
		" ||\n         steps.deploy.outputs.result == 'unproven')", ")"), REAL, M));

	// §14: the edge check.
	const edge = edgeScript(ACTION);
	expectCaught("the edge check lets a foreign Origin through", edgePins(swap(edge, '[ "$foreign" = "403" ]', "true"), M, ["foreignLetIn"]));
	expectCaught("the edge check accepts the app's own Origin refused", edgePins(swap(edge, '[ "$own" = "200" ] ||', "true ||"), M, ["ownRefused"]));
	expectCaught("the edge check retries a definite answer", edgePins(swap(edge, "000|5??)", "*)"), M, ["foreignLetIn"]));
	expectCaught("the edge check never retries", edgePins(swap(edge, 'if [ "$try" -lt 3 ]; then sleep 10; fi ;;', "break ;;"), M, ["ownRecovers"]));
	expectCaught("the edge check asks a foreign Origin of every commit", edgePins(swap(edge, 'if [ "$HANDSHAKE_GUARD" != "0" ]; then', "if true; then"), M, ["guardOff"]));
	expectCaught("the edge check skips the foreign Origin when the guard is unknown", edgePins(swap(edge,
		'[ "$HANDSHAKE_GUARD" != "0" ]', '[ "$HANDSHAKE_GUARD" = "1" ]'), M, ["guardUnknown"]));
}

(async () => {
	record(runCases(LIVE_CASES, REAL));
	record(actionPins(ACTION));
	record(deployStepPins(deployStepScript(ACTION)));
	record(realStepPins(deployStepScript(ACTION), REAL));
	record(actionRunPins(ACTION, REAL));
	record(edgePins(edgeScript(ACTION)));
	record(guardPins(REAL.deploy, SERVER));
	mutants();
})()
	.catch(crash)
	.finally(finish);
