#!/usr/bin/env node
/**
 * The box's record of the commit it last VERIFIED (refs/logisx/verified-deploy):
 * who writes it, who reads it, and how a missing or inconsistent one fails
 * safe. Runs the REAL scripts/deploy/*.sh against the throwaway sandbox from
 * scripts/deploy-test-sandbox.js, which it shares with
 * scripts/test-deploy-scripts.js (§1–§11) and scripts/test-deploy-live.js
 * (§13–§14: the started mark, the LIVE commit and the action). Each is a
 * runner of its own, so each keeps its own time budget.
 *
 * WHY IT EXISTS. HEAD moves at checkout, before install, build and restart,
 * so HEAD alone cannot say which commit the app runs. Each property below is
 * a way a deploy could act on a commit that never ran:
 *   §12 THE VERIFIED RECORD. Written only by remote-record-verified.sh (which
 *       the action runs once the deploy's checks passed, and which refuses a
 *       commit HEAD is not on) and by a rollback that serves again from a
 *       consistent record with a clean install and build. remote-deploy.sh
 *       never records its own deploy. With the record, a half-finished deploy
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
	C1, C2, C3, S1, head, onMain, marker, log, VERIFIED_REF, verified, started,
	resetBox, runSh, deployEnv, field, lastField, swap, expectCaught, M,
	short, runCases, reflog, checkOut, recordVerified, result, deployedFrom, didFullDeploy, isNoop,
	rollback, leaveHalfFinished,
} = require("./deploy-test-sandbox.js");

// A deploy that dies AFTER its checkout: HEAD moves to `sha`, the build fails,
// nothing restarts and nothing is recorded.
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

// A rollback's own install or build that did not complete cleanly, three ways.
const BUILD_NOT_CLEAN = {
	install: ["npm install failed", { STUB_INSTALL_FAIL: "1" }],
	build: ["build failed, with the old bundle still in place,", { STUB_BUILD_FAIL: "keep" }],
	index: ["build left no index.html", { STUB_BUILD_EMPTY: "1" }],
};
function rollbackBuildNotClean(S, tag, which = Object.keys(BUILD_NOT_CLEAN)) {
	return which.map((k) => {
		const [what, env] = BUILD_NOT_CLEAN[k];
		resetBox(C3, { verified: C1 });
		fs.mkdirSync(path.join(D.box, "client", "dist"), { recursive: true });
		fs.writeFileSync(path.join(D.box, "client", "dist", "index.html"), "<old/>\n");
		const x = rollback(S, C2, { RECORD_STATE: "ok", ...env });
		return [x.code === 0 && /ROLLBACK OK/.test(x.out) && /^restart /m.test(log("pm2")) && verified() === C1
			&& /::warning::not recording .* install or build did not complete cleanly/.test(x.out),
		`${tag}§12 a rollback whose ${what} still restarts and serves, but records nothing (record ${short(verified())}, code ${x.code})`];
	});
}

// Named cases, small enough that a mutant re-runs only the one that targets it.
const RECORD_CASES = {
	halfFinishedDeploy(S, tag) {
		const r = [];
		resetBox(C1, { verified: C1 });
		const x = halfFinished(S, C3);
		r.push([x.code !== 0 && head() === C3 && onMain() && git(D.box, "rev-parse", "main") === C3,
			`${tag}§12 a deploy whose build fails after its checkout exits non-zero with HEAD (and main) already on C3 (code ${x.code})`]);
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
		r.push([pin.code !== 0 && head() === C1 && verified() === C3 && field(out, "DRIFT_STATE") === "verified-record-inconsistent",
			`${tag}§12 a manual deploy of an older ref that died after its checkout → verified-record-inconsistent, never a heal (got ${field(out, "DRIFT_STATE")})`]);
		return r;
	},
	inconsistentHeal(S, tag) {
		resetBox(C2, { verified: S1 });
		const h = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C2 });
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
		const local = field(checkOut(S), "DRIFT_LOCAL");
		const h = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: local });
		return [[local === C1 && field(h.out, "HEAL_READY") === "yes" && marker() === C3,
			`${tag}§12 with a verified record and a half-finished HEAD past it, the heal prep reads production exactly as the drift check reported it (${short(local)}) and is ready`]];
	},
	healPrepOther(S, tag) {
		const r = [];
		resetBox(C2);
		let local = field(checkOut(S), "DRIFT_LOCAL");
		let h = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: local });
		r.push([local === C2 && field(h.out, "HEAL_READY") === "yes" && marker() === C3, `${tag}§12 with no record, the heal prep reads HEAD, as the drift check did, and is ready`]);
		resetBox(C1, { verified: C1 });
		leaveHalfFinished(C2);
		local = field(checkOut(S), "DRIFT_LOCAL");
		git(D.box, "update-ref", VERIFIED_REF, C2);
		h = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: local });
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
	rollbackFailedRecordsNothing(S, tag) {
		resetBox(C2, { verified: C1 });
		leaveHalfFinished(C3);
		const x = rollback(S, C2, { RECORD_STATE: "ok", STUB_HTTP_CODE: "503" });
		return [[x.code !== 0 && /ROLLBACK FAILED/.test(x.out) && verified() === C1,
			`${tag}§12 a rollback that never serves records nothing, even from a consistent record (the record stays C1)`]];
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
	expectCaught("the rollback target is HEAD, not the live commit", RECORD_CASES.sameCommitAfterHalf(deployWith(
		"if [ -n \"$LIVE\" ]; then ROLLBACK_TO=$LIVE; else ROLLBACK_TO=$PREV; fi", "ROLLBACK_TO=$PREV"), M));
	expectCaught("no warning names the commits a rollback would drop", RECORD_CASES.sameCommitAfterHalf(deployWith(
		'if [ -n "$DROPPED" ]; then', "if false; then"), M));
	expectCaught("main moves back with no proof its commits never ran", RECORD_CASES.missingRecordAncestor(deployWith(
		'elif [ -n "$LIVE" ] && git merge-base --is-ancestor "$LIVE" "$SHA" \\\n\t\t&& git merge-base --is-ancestor main origin/main; then',
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
		"npm run build:client --silent || BUILD_OK=0", "npm run build:client --silent || true"), M, ["build"]));
	expectCaught("the rollback ignores a missing index.html", rollbackBuildNotClean(rollbackWith(
		"test -f client/dist/index.html || BUILD_OK=0", "true"), M, ["index"]));
}

(async () => {
	record(runCases(RECORD_CASES, REAL));
	mutants();
})()
	.catch(crash)
	.finally(finish);
