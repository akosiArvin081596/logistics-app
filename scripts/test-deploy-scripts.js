#!/usr/bin/env node
/**
 * Runs the REAL scripts/deploy/*.sh against a throwaway git sandbox, the way
 * the workflows run them: each script text is fed to `bash -s` on stdin, which
 * is exactly what ssh does on the VPS.
 *
 * WHY IT EXISTS. These scripts deploy production unattended on every approved merge.
 * Each property below is a way they could fail silently or by racing:
 *   §1 THE BOX LOCK: two deploys of one directory must never overlap (two
 *      pulls, two installs, two builds into one client/dist). The second fails
 *      fast with exit 75 and changes nothing, and a deploy and a rollback
 *      share the one lock. The bounded waits: a rollback and the record step
 *      wait for any holder, a deploy only for the drift check's read; a deploy
 *      meeting another deploy still fails at once, and every wait ends in 75.
 *   §2 EXACT-SHA DEPLOYS: with SHA set the box lands on exactly that commit,
 *      stays on branch main, never moves backwards, and refuses a commit that
 *      main does not contain. Without SHA, REF=main keeps its old meaning.
 *   §3 CHECKED GIT STEPS: a failed pull, fast-forward or checkout fails the
 *      deploy, with nothing rebuilt or restarted.
 *   §4 THE DRIFT MARKER'S THREE WRITERS: the heal prep, an auto-rollback, and a
 *      manual pin. After any of them the drift check must ALARM
 *      (behind-already-attempted), never heal: a rolled-back commit, or main
 *      over a human's pin, is a human's call.
 *   §5 remote-drift-check.sh's four box states, plus deploy-in-progress while
 *      a deploy holds the box lock, and the heal prep's compare-and-swap (it
 *      refuses when production's record, HEAD or the marker moved since the
 *      check).
 *   §6 ssh-retry.sh retries ONLY transport failures (255); a remote failure
 *      and the lock's 75 pass straight through. Its give-up line is pinned
 *      exactly, and drift-gate.js must read it back as "never reached the
 *      VPS" (deploy-drift.yml re-runs such a staging job once). ssh-setup.sh
 *      refuses an empty pinned host key (a file-size test cannot see one).
 *   §7 source pins: the three lock copies are byte-identical, the lock is
 *      taken before anything is touched (and SHA/PREV validated before it),
 *      every pm2 call and every git fetch/pull/merge closes the lock FD, and
 *      each of the box's two refs has only its named writers.
 *   §8 mutants: each property above, broken on purpose, must turn this runner
 *      red.
 *   §9 THE NATIVE-MODULE PROBE OPENS A DATABASE. require('better-sqlite3')
 *      passes under an ABI-mismatched Node because the binding loads lazily, on
 *      the first `new Database()`. A module that requires fine but cannot open
 *      a database must trigger the rebuild, in the deploy AND the rollback;
 *      one that still cannot after the rebuild fails the deploy unrestarted.
 *      backup.sh's probe is pinned to the same shape.
 *   §10 THE SMOKE CHECK'S LOG TAIL prints with workflow commands switched off
 *      (a random ::stop-commands:: token), so no line of the app's log becomes
 *      an annotation. Run for real against a stub pm2 whose log is full of
 *      command-shaped lines.
 *   §11 NO REMOTE SCRIPT EXITS 255 ITSELF: ssh-retry.sh reads 255 as its own
 *      transport failure. Literal exit codes only, no bare exit, no errexit.
 *   §15 THE RESTART IS PROVEN. pm2 must exit 0 AND the process's pm_uptime,
 *      read BY NAME from `pm2 jlist` (the stub lists another tenant first),
 *      must move. A restart that fails either marks and records nothing, so
 *      the old process can never pass for the new commit. The deploy reports
 *      DEPLOY_RESULT=unproven (the action checks, rolls back and fails the
 *      job; test-deploy-live.js §14 runs that), and the rollback fails. §7
 *      pins the shared restart block byte-identical, with nothing marked
 *      started before its gate.
 *   §16 THE INSTALL LEAVES THE LOCKFILES ALONE. The deploy and the rollback
 *      each install once, with npm_config_save=false, and that line, run for
 *      real (offline), leaves a nested client lockfile as committed while the
 *      bare command rewrites it.
 *
 * The verified-deploy record is tested by scripts/test-deploy-record.js (§12),
 * and the started mark, the LIVE commit and the vps-deploy action by
 * scripts/test-deploy-live.js (§13–§14): runners of their own, so each keeps
 * its own time budget. All three build the same sandbox from
 * scripts/deploy-test-sandbox.js.
 *
 * Hermetic: a mkdtemp sandbox, local git only (the "origin" is a bare repo in
 * the sandbox), and stubbed pm2/npm/curl/ssh. No network, no VPS, no secrets.
 * macOS ships no flock(1): there a perl flock(2) shim stands in (same syscall,
 * same fd-inheritance semantics). CI and the VPS use the real util-linux one.
 *
 * Run: node scripts/test-deploy-scripts.js. It runs its cases in up to 8
 * worker processes at once, each with a sandbox of its own ("running it", at
 * the end).
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork, spawn, spawnSync } = require("child_process");

const {
	DEPLOY_DIR, readScript, REAL, SMOKE, ok, record, finish, crash, removeSandbox, tally, absorb,
	T, D, ENV, git, tryGit, writeExec, STUB_EXEC, hasRealFlock,
	C1, C2, C3, S1, MARKER, LOCK_FILE, head, onMain, marker, log, VERIFIED_REF, verified, STARTED_REF, started,
	resetBox, runSh, deployEnv, field, lastField, waitFor, swap, cut, expectCaught, M,
	short, rollback, boxSeen, withLockHeld, holdLock, holderNote,
} = require("./deploy-test-sandbox.js");

// A unit of work for one worker process (see "running it" at the end). `secs`:
// roughly how long it takes, for the jobs that take a second or more (most of
// them sit out a held lock). The longest are handed out first.
const job = (name, fn, secs = 0) => ({ name, fn, secs });

// ───────────────────────────────────────────────── §1 the box lock (async)
// runSh without blocking, for contenders that run side by side.
function runShAsync(text, env = {}) {
	return new Promise((resolve) => {
		const c = spawn("bash", ["-s"], { cwd: T, env: { ...ENV, ...env }, timeout: 60000 });
		let stdout = "";
		let stderr = "";
		c.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
		c.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
		c.on("close", (code) => resolve({ code, out: `${stdout}${stderr}`, stdout }));
		c.stdin.end(text);
	});
}

async function lockScenario(S, tag = "") {
	const r = [];
	resetBox(C1);
	const hold = path.join(T, `release-${Math.random().toString(36).slice(2)}`);
	const A = spawn("bash", ["-s"], { cwd: T, env: { ...ENV, ...deployEnv({ SHA: C2, STUB_TAG: "A", STUB_HOLD_FILE: hold }) } });
	let aOut = "";
	A.stdout.on("data", (c) => (aOut += c));
	A.stderr.on("data", (c) => (aOut += c));
	const aDone = new Promise((res) => A.on("close", (code) => res(code)));
	A.stdin.end(S.deploy);
	let aExited = null;
	aDone.then((code) => (aExited = code));
	try {
		await waitFor(() => /install-start tag=A/.test(log("npm")) || aExited !== null, 20000, "deploy A to reach npm install");
		if (!/install-start tag=A/.test(log("npm"))) {
			throw new Error(`deploy A exited (${aExited}) before reaching npm install:\n${aOut}`);
		}
		const B = runSh(S.deploy, deployEnv({ SHA: C2, STUB_TAG: "B" }));
		// The rollback and the record step each wait out their bounded wait for
		// A, side by side. A has checked out C2 and is still installing: C2 is
		// NOT verified. The record step shares the lock, so it can never record a
		// deploy mid-flight.
		const [R, V] = await Promise.all([
			runShAsync(S.rollback, { DIR: D.box, PM2: "logistics-app", PREV: C1, STUB_TAG: "R" }),
			runShAsync(S.record, { DIR: D.box, SHA: C2, STUB_TAG: "V" }),
		]);
		r.push([V.code === 75 && verified() === "", `${tag}§1 recording a verified deploy while a deploy runs is refused (75) and records nothing (got ${V.code}, record '${verified().slice(0, 7)}')`]);
		r.push([B.code === 75, `${tag}§1 a second deploy while one runs must exit 75 (got ${B.code})`]);
		r.push([/lock .* is held/.test(B.out) && B.out.includes(LOCK_FILE), `${tag}§1 the refusal names the held lock file`]);
		r.push([/lock holder: pid=\d+ since=\S+ by=remote-deploy\.sh ref=main sha=/.test(B.out), `${tag}§1 the refusal says who holds it`]);
		r.push([!/current HEAD:/.test(B.out), `${tag}§1 the refused deploy never reached the repo`]);
		r.push([R.code === 75, `${tag}§1 a ROLLBACK during a deploy is refused too — one lock for both (got ${R.code})`]);
		r.push([!/tag=[BR]\b/.test(log("npm") + log("pm2")), `${tag}§1 the refused runs installed, built and restarted nothing`]);
	} finally {
		fs.writeFileSync(hold, "");
	}
	const aCode = await aDone;
	r.push([aCode === 0 && head() === C2, `${tag}§1 the lock holder finishes normally (code ${aCode}, HEAD ${head().slice(0, 7)})`]);
	const C = runSh(S.deploy, deployEnv({ SHA: C2, STUB_TAG: "C" }));
	r.push([C.code === 0, `${tag}§1 the lock is released when the holder exits (next deploy got ${C.code})`]);
	r.push([fs.existsSync(LOCK_FILE) && !LOCK_FILE.startsWith(D.box + path.sep), `${tag}§1 the lock file lives outside the repo tree`]);
	return r;
}

// ─────────────────────────────────────── §2/§3 exact-SHA deploys, checked git
// Named cases, so a mutant re-runs only the case that targets it.
const PIN_CASES = {
	exact(S, tag) {
		const r = [];
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({ SHA: C2, STUB_TAG: "p" }));
		r.push([x.code === 0 && head() === C2, `${tag}§2 SHA=c2 with origin/main at c3 lands on EXACTLY c2 (code ${x.code}, HEAD ${head().slice(0, 7)})`]);
		r.push([onMain(), `${tag}§2 an exact-SHA deploy stays on branch main (not detached)`]);
		r.push([field(x.out, "DEPLOYED_FROM") === C1 && field(x.out, "DEPLOYED_TO") === C2, `${tag}§2 DEPLOYED_FROM/TO report c1 → c2 (the rollback target is read from this)`]);
		r.push([/^restart tag=p fd9=closed/m.test(log("pm2")), `${tag}§7 pm2 restart runs with the lock FD CLOSED (a pm2 daemon spawned with it would hold the lock forever)`]);
		r.push([!/fd9=open/.test(log("pm2")), `${tag}§7 no pm2 call inherits the lock FD`]);
		return r;
	},
	tip(S, tag) {
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({}));
		return [[x.code === 0 && head() === C3, `${tag}§2 without SHA, REF=main still means origin/main's tip (HEAD ${head().slice(0, 7)})`]];
	},
	noop(S, tag) {
		// A newer VERIFIED main commit is live: the only no-op there is.
		resetBox(C3, { verified: C3 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [
			[x.code === 0 && field(x.out, "DEPLOY_NOOP") === "1" && head() === C3, `${tag}§2 a newer VERIFIED main commit is live → no-op, never backwards (code ${x.code}, HEAD ${head().slice(0, 7)})`],
			[!/restart/.test(log("pm2")) && !/install/.test(log("npm")), `${tag}§2 the no-op restarts and installs nothing`],
			[field(x.out, "DEPLOYED_FROM") === C3 && field(x.out, "DEPLOYED_TO") === C3, `${tag}§2 the no-op still reports DEPLOYED_FROM/TO (the verified commit) for the smoke/rollback steps`],
		];
	},
	redeploy(S, tag) {
		resetBox(C2);
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [[x.code === 0 && head() === C2 && /restart/.test(log("pm2")), `${tag}§2 re-deploying the live SHA rebuilds and restarts it (what a re-run is for)`]];
	},
	offMain(S, tag) {
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({ SHA: S1 }));
		return [
			[x.code !== 0 && /not on origin\/main/.test(x.out) && head() === C1, `${tag}§2 a commit main does not contain is refused, box untouched (code ${x.code})`],
			[!/restart/.test(log("pm2")), `${tag}§2 …and nothing is restarted`],
		];
	},
	badInput(S, tag) {
		resetBox(C1);
		const a = runSh(S.deploy, deployEnv({ SHA: C2.slice(0, 7) }));
		const b = runSh(S.deploy, deployEnv({ REF: "side", SHA: C2 }));
		const r = [
			[a.code === 1 && /full 40-character/.test(a.out) && head() === C1, `${tag}§2 an abbreviated SHA is refused`],
			[b.code === 1 && /REF must be main/.test(b.out) && head() === C1, `${tag}§2 SHA with REF other than main is refused`],
		];
		// The rollback's PREV comes from the deploy's output: anything but a full
		// commit id is refused before the lock, with nothing checked out or run.
		resetBox(C2);
		for (const bad of [C1.slice(0, 7), C1.toUpperCase(), `${C1}'`, "HEAD~1"]) {
			const x = runSh(S.rollback, { DIR: D.box, PM2: "logistics-app", PREV: bad });
			r.push([x.code === 1 && /PREV must be a full 40-character/.test(x.out) && head() === C2 && !/ROLLING BACK/.test(x.out) && log("pm2") === "" && log("npm") === "",
				`${tag}§2 the rollback refuses PREV=${JSON.stringify(bad.slice(0, 9))}: not a full commit id, nothing touched (code ${x.code})`]);
		}
		return r;
	},
	mainAhead(S, tag) {
		// Local main already past SHA while HEAD is detached elsewhere: the ff would
		// "succeed" on the wrong commit. Must refuse BEFORE moving HEAD.
		resetBox(C3, { detachAt: C1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [[x.code !== 0 && head() === C1, `${tag}§2 local main past SHA → refused with HEAD unmoved (code ${x.code}, HEAD ${head().slice(0, 7)})`]];
	},
	pullFails(S, tag) {
		// §3 a failed pull must fail the deploy, with nothing rebuilt or restarted.
		resetBox(C1);
		fs.writeFileSync(path.join(D.box, "app.txt"), "box-only\n");
		git(D.box, "commit", "-q", "-am", "diverged on the box");
		const diverged = head();
		const x = runSh(S.deploy, deployEnv({}));
		return [
			[x.code !== 0 && /could not fast-forward/.test(x.out), `${tag}§3 a failed pull FAILS the deploy (code ${x.code})`],
			[head() === diverged && !/restart/.test(log("pm2")), `${tag}§3 …and does not restart the old commit as if it were new`],
		];
	},
	unknownRef(S, tag) {
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({ REF: "no-such-ref" }));
		return [[x.code !== 0 && /cannot check out/.test(x.out) && !/restart/.test(log("pm2")), `${tag}§3 an unknown ref fails instead of redeploying the current commit`]];
	},
	hotfix(S, tag) {
		resetBox(C1);
		fs.writeFileSync(path.join(D.box, "app.txt"), "hand-applied hotfix\n");
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		git(D.box, "checkout", "--", "app.txt");
		return [[x.code === 1 && /local modifications/.test(x.out) && head() === C1, `${tag}§3 a hand-applied hotfix is still never deployed over`]];
	},
};

// ─────────────────────────── §4/§5 marker writers, drift check, heal prep
const checkState = (S, env = {}) => field(runSh(S.check, { DIR: D.box, PM2: "logistics-app", ...env }).out, "DRIFT_STATE");
// ─────────────────────────── §1b who waits for a held lock, and who fails fast
// A holder that lets go after half a second; the contender is given 10 s.
// Each case waits, at its end, for any holder it left (one a mutant failed
// fast against lets go by itself) so the next case starts with the lock free.
const timed = (fn) => { const t0 = Date.now(); const x = fn(); return { ...x, ms: Date.now() - t0 }; };
const settle = () => holdLock().release();
const DRIFT_CASES = {
	checkStates(S, tag) {
		const r = [];
		resetBox(C3);
		r.push([checkState(S) === "in-sync", `${tag}§5 box at origin/main → in-sync`]);
		resetBox(C2);
		r.push([checkState(S) === "behind-healable", `${tag}§5 behind + serving + no marker → behind-healable (the box's view)`]);
		fs.writeFileSync(MARKER, C3);
		r.push([checkState(S) === "behind-already-attempted", `${tag}§5 marker = main → behind-already-attempted`]);
		fs.writeFileSync(MARKER, C1);
		r.push([checkState(S, { STUB_HTTP_CODE: "503" }) === "behind-and-unhealthy", `${tag}§5 behind + not serving → behind-and-unhealthy`]);
		return r;
	},
	checkLocked(S, tag) {
		// The drift check no longer waits in the production deploy queue, so it
		// can meet a deploy mid-flight. Under the deploy's lock it reads nothing.
		const r = [];
		resetBox(C2);
		const x = withLockHeld(() => runSh(S.check, { DIR: D.box, PM2: "logistics-app", STUB_HTTP_CODE: "503" }));
		r.push([x.code === 0 && field(x.out, "DRIFT_STATE") === "deploy-in-progress" && field(x.out, "DRIFT_REMOTE") === C3,
			`${tag}§5 a held deploy lock → deploy-in-progress, never behind-and-unhealthy from a restart in progress (got ${field(x.out, "DRIFT_STATE")}, exit ${x.code})`]);
		r.push([!/^DRIFT_(LOCAL|HEAD|MARKER|HTTP)=/m.test(x.out), `${tag}§5 …and reports nothing it would have read under the lock`]);
		r.push([checkState(S) === "behind-healable", `${tag}§5 once the lock is free the check reads the box again`]);
		const d = runSh(S.deploy, deployEnv({ SHA: C3 }));
		r.push([d.code === 0 && head() === C3, `${tag}§5 the check lets go of the lock: a deploy right after it runs (exit ${d.code})`]);
		return r;
	},
	checkLockStuck(S, tag) {
		// A holder whose note is over 30 minutes old is stuck, not deploying.
		const r = [];
		resetBox(C2);
		const stuck = withLockHeld(() => {
			const old = new Date(Date.now() - 31 * 60 * 1000);
			fs.utimesSync(LOCK_FILE, old, old);
			return runSh(S.check, { DIR: D.box, PM2: "logistics-app" });
		}, { note: holderNote("remote-deploy.sh") });
		r.push([field(stuck.out, "DRIFT_STATE") === "deploy-lock-stuck", `${tag}§5 a lock held for over 30 minutes → deploy-lock-stuck, an alarm (got ${field(stuck.out, "DRIFT_STATE")})`]);
		const fresh = withLockHeld(() => runSh(S.check, { DIR: D.box, PM2: "logistics-app" }), { note: holderNote("remote-deploy.sh") });
		r.push([field(fresh.out, "DRIFT_STATE") === "deploy-in-progress", `${tag}§5 …and a fresh one is still deploy-in-progress (got ${field(fresh.out, "DRIFT_STATE")})`]);
		return r;
	},
	checkReadsOnly(S, tag) {
		// main's tip comes from origin without a fetch: the clone's refs stay as
		// they were, even a stale origin/main.
		const r = [];
		resetBox(C2);
		git(D.box, "update-ref", "refs/remotes/origin/main", C1);
		const before = git(D.box, "for-each-ref");
		const fetchHead = path.join(D.box, ".git", "FETCH_HEAD");
		const fhBefore = fs.existsSync(fetchHead) ? fs.statSync(fetchHead).mtimeMs : null;
		const x = runSh(S.check, { DIR: D.box, PM2: "logistics-app" });
		const fhAfter = fs.existsSync(fetchHead) ? fs.statSync(fetchHead).mtimeMs : null;
		r.push([field(x.out, "DRIFT_REMOTE") === C3, `${tag}§5 the check reads main's tip from origin itself, not the clone's stale origin/main (got ${short(field(x.out, "DRIFT_REMOTE"))})`]);
		r.push([git(D.box, "for-each-ref") === before && fhBefore === fhAfter, `${tag}§5 …and writes nothing into the clone: no ref moves, no FETCH_HEAD`]);
		git(D.box, "update-ref", "refs/remotes/origin/main", C3);
		return r;
	},
	checkExactMain(S, tag) {
		// ls-remote matches ref TAILS: a branch named a/refs/heads/main also
		// matches "refs/heads/main", and sorts first.
		resetBox(C2);
		git(D.seed, "push", "-q", "origin", `${C1}:refs/heads/a/refs/heads/main`);
		let x;
		try {
			x = runSh(S.check, { DIR: D.box, PM2: "logistics-app" });
		} finally {
			git(D.seed, "push", "-q", "origin", ":refs/heads/a/refs/heads/main");
		}
		return [[field(x.out, "DRIFT_REMOTE") === C3, `${tag}§5 main's tip is refs/heads/main exactly, never a branch whose name ends in it (got ${short(field(x.out, "DRIFT_REMOTE"))})`]];
	},
	checkRemoteUnreadable(S, tag) {
		// No stand-in for main's tip: the clone's last-fetched origin/main would
		// read a box that cannot reach origin as in-sync while main moved on.
		resetBox(C3);
		git(D.box, "remote", "set-url", "origin", path.join(T, "no-such-origin"));
		let x;
		try {
			x = runSh(S.check, { DIR: D.box, PM2: "logistics-app" });
		} finally {
			git(D.box, "remote", "set-url", "origin", D.origin);
		}
		return [[x.code === 0 && field(x.out, "DRIFT_STATE") === "remote-unreadable" && field(x.out, "DRIFT_REMOTE") === "",
			`${tag}§5 an origin the box cannot read → remote-unreadable, never in-sync from a stale origin/main (got ${field(x.out, "DRIFT_STATE")}, exit ${x.code})`]];
	},
	recordWaits(S, tag) {
		resetBox(C2);
		holdLock({ note: holderNote("someone-else"), seconds: 0.5 });
		const x = timed(() => runSh(S.record, { DIR: D.box, SHA: C2, DEPLOY_LOCK_WAIT_S: "10" }));
		settle();
		return [[x.code === 0 && verified() === C2 && /waiting up to 10s/.test(x.out),
			`${tag}§1 the record step waits (bounded) for any holder, then records (exit ${x.code}, ${x.ms} ms)`]];
	},
	rollbackWaits(S, tag) {
		resetBox(C3);
		holdLock({ note: holderNote("someone-else"), seconds: 0.5 });
		const x = timed(() => rollback(S, C2, { DEPLOY_LOCK_WAIT_S: "10" }));
		settle();
		return [[x.code === 0 && head() === C2 && /waiting up to 10s/.test(x.out),
			`${tag}§1 a rollback waits (bounded) for any holder, then rolls back (exit ${x.code}, ${x.ms} ms)`]];
	},
	deployWaitsForCheck(S, tag) {
		resetBox(C2);
		holdLock({ note: holderNote("remote-drift-check.sh"), seconds: 0.5 });
		const x = timed(() => runSh(S.deploy, deployEnv({ SHA: C3, DEPLOY_LOCK_WAIT_S: "10" })));
		settle();
		return [[x.code === 0 && head() === C3 && /waiting up to 10s/.test(x.out),
			`${tag}§1 a deploy waits for the drift check's read, then deploys (exit ${x.code}, ${x.ms} ms)`]];
	},
	deployFailsFast(S, tag) {
		resetBox(C2);
		const h = holdLock({ note: holderNote("remote-deploy.sh") });
		let x;
		try {
			x = timed(() => runSh(S.deploy, deployEnv({ SHA: C3, DEPLOY_LOCK_WAIT_S: "3" })));
		} finally {
			h.release();
		}
		return [[x.code === 75 && x.ms < 2500 && !/waiting up to/.test(x.out) && head() === C2,
			`${tag}§1 a deploy never waits for another deploy: 75 at once (exit ${x.code}, ${x.ms} ms)`]];
	},
	waitBounded(S, tag) {
		resetBox(C2);
		const h = holdLock({ note: holderNote("remote-deploy.sh") });
		let x;
		try {
			x = timed(() => runSh(S.record, { DIR: D.box, SHA: C2, DEPLOY_LOCK_WAIT_S: "1" }));
		} finally {
			h.release();
		}
		return [[x.code === 75 && verified() === "" && /lock .* is held/.test(x.out) && x.ms >= 900,
			`${tag}§1 the record step's wait is bounded: a holder that stays past it → 75, nothing recorded (exit ${x.code}, ${x.ms} ms)`]];
	},
	healPrep(S, tag) {
		// Heal prep: compare-and-swap against what the check saw: production's
		// record, HEAD and the marker.
		const r = [];
		let x;
		resetBox(C2);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C2, ...boxSeen() });
		r.push([x.code === 0 && field(x.out, "HEAL_READY") === "yes" && marker() === C3, `${tag}§5 heal prep: box as the check saw it → ready, marker = target`]);
		x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		r.push([x.code === 0 && head() === C3 && checkState(S) === "in-sync", `${tag}§5 the heal's exact-SHA deploy brings the box in sync`]);
		resetBox(C2);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C1, ...boxSeen() });
		r.push([field(x.out, "HEAL_READY") === "no" && marker() === "", `${tag}§5 heal prep: the box moved since the check → not ready, NO marker written`]);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C2, EXPECT_HEAD: C1, EXPECT_MARKER: "none" });
		r.push([field(x.out, "HEAL_READY") === "no" && /HEAD moved/.test(field(x.out, "HEAL_REASON")) && marker() === "",
			`${tag}§5 heal prep: HEAD moved since the check → not ready, NO marker written (got ${field(x.out, "HEAL_REASON")})`]);
		fs.writeFileSync(MARKER, C1);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C2, EXPECT_HEAD: C2, EXPECT_MARKER: "none" });
		r.push([field(x.out, "HEAL_READY") === "no" && /marker changed/.test(field(x.out, "HEAL_REASON")) && marker() === C1,
			`${tag}§5 heal prep: the marker changed since the check → not ready, the marker left as it is (got ${field(x.out, "HEAL_REASON")})`]);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C2, EXPECT_HEAD: C2, EXPECT_MARKER: C1 });
		r.push([field(x.out, "HEAL_READY") === "yes" && marker() === C3, `${tag}§5 heal prep: an old marker the check also saw → ready`]);
		resetBox(C2);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C2 });
		r.push([x.code !== 0 && field(x.out, "HEAL_READY") === "" && marker() === "", `${tag}§5 heal prep: without HEAD and marker from the check it refuses to run (exit ${x.code})`]);
		fs.writeFileSync(MARKER, C3);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C2, ...boxSeen() });
		r.push([field(x.out, "HEAL_READY") === "no", `${tag}§5 heal prep: already attempted → not ready`]);
		fs.rmSync(MARKER, { force: true });
		x = runSh(S.heal, { DIR: D.box, TARGET: S1, EXPECT: C2, ...boxSeen() });
		r.push([field(x.out, "HEAL_READY") === "no" && marker() === "", `${tag}§5 heal prep: a target main does not contain → not ready`]);
		return r;
	},
	rollbackMarker(S, tag) {
		// §4 writer 2: an auto-rollback records the rejected commit; drift must
		// alarm, and never deploy it again by itself.
		const r = [];
		resetBox(C2);
		runSh(S.deploy, deployEnv({ SHA: C3 }));
		const x = runSh(S.rollback, { DIR: D.box, PM2: "logistics-app", PREV: C2 });
		r.push([x.code === 0 && /ROLLBACK OK/.test(x.out) && head() === C2, `${tag}§4 rollback returns the box to PREV (code ${x.code})`]);
		r.push([marker() === C3, `${tag}§4 rollback records the REJECTED commit in the drift marker (got '${marker().slice(0, 7)}')`]);
		r.push([checkState(S) === "behind-already-attempted", `${tag}§4 after an auto-rollback the drift check ALARMS, it does not re-deploy the rejected commit`]);
		r.push([/^restart tag= fd9=closed/m.test(log("pm2")), `${tag}§7 the rollback's pm2 restart closes the lock FD too`]);
		return r;
	},
	pinRollbackKeepsPinMarker(S, tag) {
		// A pin to the commit already live (C2, main at C3) fails its checks and
		// rolls back to that same C2. The pin's marker, main's tip C3, stays: the
		// rejected C2 is not main's tip, so drift could never deploy it anyway,
		// and replacing the marker would let drift deploy C3 over the pin.
		const r = [];
		resetBox(C3, { detachAt: C2, verified: C2, started: C2 });
		const d = runSh(S.deploy, deployEnv({ REF: C2 }));
		r.push([d.code === 0 && marker() === C3 && lastField(d.stdout, "DEPLOYED_FROM") === C2,
			`${tag}§4 a pin to the live C2 sets the marker to main's tip C3 and names C2 as its rollback target (code ${d.code}, marker ${short(marker())})`]);
		const x = rollback(S, lastField(d.stdout, "DEPLOYED_FROM"), { RECORD_STATE: lastField(d.stdout, "DEPLOY_RECORD_STATE") });
		r.push([x.code === 0 && /ROLLBACK OK/.test(x.out) && head() === C2 && marker() === C3 && verified() === C2,
			`${tag}§4 …its rollback to that same C2 keeps the marker on main's tip C3 and records nothing new (marker ${short(marker())}, record ${short(verified())})`]);
		r.push([checkState(S) === "behind-already-attempted", `${tag}§4 …so drift still alarms over the pin; it never deploys C3 over it`]);
		return r;
	},
	manualPin(S, tag) {
		// §4 writer 3: a manual pin off main (the documented rollback path).
		const r = [];
		resetBox(C3);
		let x = runSh(S.deploy, deployEnv({ REF: C1 }));
		r.push([x.code === 0 && head() === C1 && !onMain(), `${tag}§4 a manual REF=<sha> deploy pins the box, detached (code ${x.code})`]);
		r.push([marker() === C3, `${tag}§4 a manual pin records main's tip in the drift marker`]);
		r.push([checkState(S) === "behind-already-attempted", `${tag}§4 drift ALARMS over a manual pin; it never deploys main over it by itself`]);
		x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		r.push([x.code === 0 && head() === C3 && onMain() && checkState(S) === "in-sync", `${tag}§4 deploying main again ends the pin`]);
		return r;
	},
};

// ─────────────────────────────────── §9 the native-module probe opens a DB
// Measured on the VPS 2026-09-19: /usr/bin/node v20 passes
// require('better-sqlite3') and fails `new Database()`. A probe that only
// requires the module therefore waves a wrong-ABI build through to a restart
// that dies on boot.
const PROBE_CASES = {
	healthy(S, tag) {
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [[x.code === 0 && !/rebuild/.test(log("npm")), `${tag}§9 a module that opens a database is not rebuilt (code ${x.code})`]];
	},
	lazyAbi(S, tag) {
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({ SHA: C2, STUB_BSQL: "lazy-abi" }));
		return [
			[/rebuild/.test(log("npm")) && /native ABI mismatch detected/.test(x.out), `${tag}§9 require() OK but new Database() throws → the deploy REBUILDS better-sqlite3`],
			[x.code === 0 && head() === C2 && /restart/.test(log("pm2")), `${tag}§9 …and once rebuilt it builds and restarts normally (code ${x.code})`],
		];
	},
	stillBroken(S, tag) {
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({ SHA: C2, STUB_BSQL: "broken" }));
		return [[x.code !== 0 && /still fails to load after rebuild/.test(x.out) && !/restart/.test(log("pm2")),
			`${tag}§9 still unable to open a database after the rebuild → the deploy fails and restarts nothing (code ${x.code})`]];
	},
	rollbackLazyAbi(S, tag) {
		resetBox(C2);
		const x = runSh(S.rollback, { DIR: D.box, PM2: "logistics-app", PREV: C1, STUB_BSQL: "lazy-abi" });
		return [[x.code === 0 && /rebuild/.test(log("npm")), `${tag}§9 the rollback's probe opens a database too: require() OK + construction throws → rebuild (code ${x.code})`]];
	},
};

// ─────────────────────────────────────────── §15 the restart is proven
// `pm2 restart` can fail, or "succeed" without restarting anything, while the
// OLD process keeps serving, and every check after it would read that old
// process. So the deploy and the rollback each prove the restart took: pm2
// exits 0 AND this process's pm_uptime, read BY NAME from `pm2 jlist` (the
// stub lists another tenant's process first), moved. Otherwise nothing is
// marked started or recorded, and the deploy (or the rollback) fails.
const RESTART_CASES = {
	deployProven(S, tag) {
		resetBox(C1, { verified: C1, started: C1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [[x.code === 0 && started() === C2 && /^restarting logistics-app: pm2 returned 0, start time 1000 -> 1001, status online/m.test(x.out),
			`${tag}§15 a restart pm2 answers 0 for, whose start time moved (1000 → 1001, read by name past another tenant's process), marks C2 started (code ${x.code}, started ${short(started())})`]];
	},
	deployProvenThroughNotice(S, tag) {
		// pm2's CLI prints its out-of-date notice on stdout ahead of jlist's JSON.
		// The deploy still reads the JSON line: it builds with pm2's interpreter
		// (off the PATH here, as /opt/node22 is on the box), and proves the restart.
		resetBox(C1, { verified: C1, started: C1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2, STUB_PM2_JLIST_NOISE: "1" }));
		return [
			[x.code === 0 && started() === C2 && /^restarting logistics-app: pm2 returned 0, start time 1000 -> 1001, status online/m.test(x.out),
				`${tag}§15 with pm2's out-of-date notice ahead of jlist's JSON, the restart is still proven and C2 marked started (code ${x.code}, started ${short(started())})`],
			[x.out.split("\n").includes(`pm2 interpreter: ${ENV.STUB_NODE}`) && x.out.split("\n").some((l) => l.startsWith(`building with:   ${ENV.STUB_NODE} `)),
				`${tag}§15 …and it builds with pm2's own interpreter, never PATH's node`],
		];
	},
	rollbackThroughNotice(S, tag) {
		resetBox(C3, { verified: C1, started: C3 });
		const x = rollback(S, C2, { RECORD_STATE: "ok", STUB_PM2_JLIST_NOISE: "1" });
		return [[x.code === 0 && /ROLLBACK OK/.test(x.out) && x.out.split("\n").includes(`pm2 interpreter: ${ENV.STUB_NODE}`) && started() === C2 && verified() === C2,
			`${tag}§15 a rollback with pm2's notice ahead of jlist's JSON builds with pm2's interpreter, proves its restart and records C2 (code ${x.code}, record ${short(verified())})`]];
	},
	deployNoInterpreter(S, tag) {
		// jlist does not list the process: no guess at PATH's node.
		resetBox(C1, { verified: C1, started: C1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2, STUB_PM2_MISSING: "1" }));
		return [[x.code === 1 && /::error::cannot read the interpreter pm2 runs logistics-app with/.test(x.out)
			&& !/install-start/.test(log("npm")) && !/^restart /m.test(log("pm2")) && started() === C1 && lastField(x.stdout, "DEPLOY_RESULT") === "",
		`${tag}§15 a deploy that cannot read pm2's interpreter refuses to build: nothing installed, built or restarted (code ${x.code})`]];
	},
	rollbackNoInterpreter(S, tag) {
		resetBox(C3, { verified: C1, started: C3 });
		const x = rollback(S, C2, { RECORD_STATE: "ok", STUB_PM2_MISSING: "1" });
		return [[x.code === 1 && /ROLLBACK FAILED — cannot read the interpreter/.test(x.out) && head() === C3
			&& !/install-start/.test(log("npm")) && !/^restart /m.test(log("pm2")) && marker() === C3 && verified() === C1,
		`${tag}§15 a rollback that cannot read pm2's interpreter refuses before its checkout: HEAD stays C3, nothing built or restarted, the marker still names C3 (code ${x.code}, HEAD ${short(head())})`]];
	},
	deployRestartFails(S, tag) {
		// pm2 answers 1. Its start time moved all the same, so only the exit
		// code can catch this one.
		resetBox(C1, { verified: C1, started: C1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2, STUB_PM2_RESTART_RC: "1" }));
		return [[x.code === 0 && /^restart /m.test(log("pm2")) && /::error::pm2 exited 1 restarting logistics-app/.test(x.out)
			&& started() === C1 && verified() === C1 && lastField(x.stdout, "DEPLOY_RESULT") === "unproven",
		`${tag}§15 a restart pm2 answers 1 for is reported as DEPLOY_RESULT=unproven, with C2 not marked started, so the action checks, rolls back and never records it (code ${x.code}, result ${lastField(x.stdout, "DEPLOY_RESULT") || "none"}, started ${short(started())})`]];
	},
	deployRestartNoop(S, tag) {
		// pm2 answers 0, but the start time never moved: the old process serves.
		resetBox(C1, { verified: C1, started: C1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2, STUB_PM2_RESTART_NOOP: "1" }));
		return [[x.code === 0 && /::error::the restart of logistics-app did not take/.test(x.out)
			&& started() === C1 && verified() === C1 && lastField(x.stdout, "DEPLOY_RESULT") === "unproven",
		`${tag}§15 a restart whose start time never moved is reported as DEPLOY_RESULT=unproven, with C2 not marked started (code ${x.code}, result ${lastField(x.stdout, "DEPLOY_RESULT") || "none"}, started ${short(started())})`]];
	},
	rollbackRestartFails(S, tag) {
		resetBox(C3, { verified: C1, started: C3 });
		const x = rollback(S, C2, { RECORD_STATE: "ok", STUB_PM2_RESTART_RC: "1" });
		return [[x.code === 1 && /ROLLBACK FAILED — the restart of logistics-app at [0-9a-f]{40} is not proven/.test(x.out) && !/ROLLBACK OK/.test(x.out)
			&& started() === C3 && verified() === C1 && marker() === C3,
		`${tag}§15 a rollback whose restart pm2 answers 1 for fails without polling: C2 not marked started, not recorded, and the marker still names C3 (code ${x.code}, started ${short(started())}, record ${short(verified())})`]];
	},
	rollbackRestartNoop(S, tag) {
		resetBox(C3, { verified: C1, started: C3 });
		const x = rollback(S, C2, { RECORD_STATE: "ok", STUB_PM2_RESTART_NOOP: "1" });
		return [[x.code === 1 && /::error::the restart of logistics-app did not take/.test(x.out) && !/ROLLBACK OK/.test(x.out)
			&& started() === C3 && verified() === C1 && marker() === C3,
		`${tag}§15 a rollback whose restart never moved the start time fails without polling the old process: nothing marked started or recorded (code ${x.code}, started ${short(started())}, record ${short(verified())})`]];
	},
};

// The block that restarts and proves it, byte-identical in both scripts that
// restart, and nothing marked started before the proof.
function restartBlock(text) {
	const a = text.indexOf("# >>> pm2-restart");
	const b = text.indexOf("# <<< pm2-restart");
	return a >= 0 && b > a ? text.slice(a, b) : null;
}
function restartPins(scripts, tag = "") {
	const d = restartBlock(scripts.deploy);
	const r = restartBlock(scripts.rollback);
	const startedAfterProof = (t) => {
		const end = t.indexOf("# <<< pm2-restart");
		const mark = t.indexOf("refs/logisx/started-deploy \"$");
		const gate = t.indexOf('if [ "$RESTART_OK" != 1 ]; then', end);
		return end > 0 && gate > end && mark > gate;
	};
	return [
		[d && r && d === r, `${tag}§7 the pm2-restart block is byte-identical in remote-deploy.sh and remote-rollback.sh`],
		[startedAfterProof(scripts.deploy) && startedAfterProof(scripts.rollback),
			`${tag}§7 both scripts mark a commit started only after the pm2-restart block, behind its RESTART_OK gate`],
	];
}

// The probe's exact text, shared by the static pin and the mutants below.
const DB_PROBE = `node -e "new (require('better-sqlite3'))(':memory:').close()"`;
const REQUIRE_ONLY_PROBE = `node -e "require('better-sqlite3')"`;
function probePins() {
	const scripts = [
		["remote-deploy.sh", REAL.deploy],
		["remote-rollback.sh", REAL.rollback],
		["backup.sh", fs.readFileSync(path.join(__dirname, "..", "backup.sh"), "utf8")],
	];
	for (const [name, text] of scripts) {
		// Every `-e '...require(better-sqlite3)...'` line outside a comment is a
		// capability probe, whichever quote style it uses.
		const probes = text.split("\n").filter((l) => !/^\s*#/.test(l) && /-e\s+["'][^"']*require\(\s*["']better-sqlite3["']\s*\)/.test(l));
		const opens = probes.filter((l) => /new \(require\(\s*["']better-sqlite3["']\s*\)\)\(\s*["']:memory:["']\s*\)\.close\(\)/.test(l));
		ok(probes.length > 0 && opens.length === probes.length,
			`§9 every better-sqlite3 probe in ${name} opens a database, not just require()s it (${opens.length} of ${probes.length})`);
	}
	ok(REAL.deploy.split(DB_PROBE).length - 1 === 2 && REAL.rollback.split(DB_PROBE).length - 1 === 1,
		"§9 the deploy probes before and after its rebuild, the rollback once — all with the same text the mutants swap");
}

// ─────────────────────────────── §16 the install leaves the lockfiles alone
// The root install's postinstall runs `npm install` in client/, and the box's
// npm rewrote client/package-lock.json on every deploy, leaving the server
// checkouts modified. Each script's install line is run for real with the npm
// on PATH, offline, in a root + client/ layout whose client lockfile is valid
// but not in npm's own layout, so any write to it shows. The bare command is
// the control: it must rewrite the file, or this check proves nothing. The
// three installs run side by side, each in a directory of its own.
async function installPins() {
	const INSTALL = /^\s*(?:npm_config_\w+=\S+\s+)*npm\s+(?:install|i|ci)\b/;
	const lockAfter = (cmd) => new Promise((resolve) => {
		const d = fs.mkdtempSync(path.join(T, "install-"));
		fs.mkdirSync(path.join(d, "client"));
		fs.writeFileSync(path.join(d, "package.json"),
			JSON.stringify({ name: "root", version: "1.0.0", scripts: { postinstall: "cd client && npm install --no-audit --no-fund" } }));
		fs.writeFileSync(path.join(d, "client", "package.json"), JSON.stringify({ name: "client", version: "1.0.0" }));
		const lock = JSON.stringify({ name: "client", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "client", version: "1.0.0" } } });
		fs.writeFileSync(path.join(d, "client", "package-lock.json"), lock);
		spawn("sh", ["-c", cmd.replace(/\s*\|\|.*$/, "")], {
			cwd: d, stdio: "ignore", timeout: 60000,
			env: { ...process.env, npm_config_offline: "true", npm_config_update_notifier: "false" },
		}).on("close", (code) => resolve({ code, rewritten: fs.readFileSync(path.join(d, "client", "package-lock.json"), "utf8") !== lock }));
	});
	const scripts = [["remote-deploy.sh", REAL.deploy], ["remote-rollback.sh", REAL.rollback]].map(([name, text]) =>
		[name, text.split("\n").filter((l) => !/^\s*#/.test(l) && INSTALL.test(l))]);
	const [control, ...runs] = await Promise.all([
		lockAfter("npm install --silent --no-audit --no-fund"),
		...scripts.map(([, installs]) => (installs.length === 1 ? lockAfter(installs[0].trim()) : null)),
	]);
	ok(control.code === 0 && control.rewritten,
		`§16 control: a bare npm install rewrites the client lockfile through the postinstall (code ${control.code}, rewritten ${control.rewritten})`);
	scripts.forEach(([name, installs], i) => {
		ok(installs.length === 1 && /^\s*npm_config_save=false npm install\b/.test(installs[0]),
			`§16 ${name} installs once, with npm_config_save=false (got ${JSON.stringify(installs.map((l) => l.trim()))})`);
		if (installs.length !== 1) return;
		ok(runs[i].code === 0 && !runs[i].rewritten,
			`§16 ${name}'s install line leaves the client lockfile as committed (code ${runs[i].code}, rewritten ${runs[i].rewritten})`);
	});
}

// ───────────────────────────────────────── §6 runner-side ssh helpers
const RETRY = path.join(DEPLOY_DIR, "ssh-retry.sh");
function runRetry(codes, backoff, script = RETRY) {
	for (const f of fs.readdirSync(D.logs)) fs.rmSync(path.join(D.logs, f), { force: true });
	const codesFile = path.join(T, "ssh-codes");
	const countFile = path.join(T, "ssh-count");
	fs.writeFileSync(codesFile, codes.join("\n") + "\n");
	fs.rmSync(countFile, { force: true });
	const env = { ...ENV, STUB_SSH_CODES: codesFile, STUB_SSH_COUNT: countFile };
	if (backoff !== undefined) env.SSH_RETRY_BACKOFF = backoff;
	const r = spawnSync("bash", [script, "root@203.0.113.9", "DIR='/x' bash -s"], { input: "echo payload\nexit 0", env, encoding: "utf8", timeout: 30000 });
	const n = Number((fs.existsSync(countFile) && fs.readFileSync(countFile, "utf8").trim()) || 0);
	const payloads = Array.from({ length: n }, (_, i) => fs.readFileSync(path.join(D.logs, `ssh-payload.${i + 1}`), "utf8"));
	const args = n ? fs.readFileSync(path.join(D.logs, "ssh-args.1"), "utf8") : "";
	return { code: r.status, out: `${r.stdout}${r.stderr}`, n, payloads, args };
}

// What the runner makes of a workflow command: `::error title=T::M` becomes a
// check-run annotation with level "failure", title T and message M. Enough of
// it to hand ssh-retry.sh's REAL output to drift-gate.js.
function annotationsFrom(out) {
	const unescape = (s) => s.replace(/%0D/gi, "\r").replace(/%0A/gi, "\n").replace(/%3A/gi, ":").replace(/%2C/gi, ",").replace(/%25/g, "%");
	return out.split("\n").map((l) => /^::(error|warning|notice)(?: ([^:]*))?::(.*)$/.exec(l)).filter(Boolean).map(([, level, props = "", message]) => ({
		annotation_level: level === "error" ? "failure" : level,
		title: unescape((/(?:^|,)title=([^,]*)/.exec(props) || [])[1] || ""),
		message: unescape(message),
	}));
}

// ⚠️ ssh-retry.sh's give-up line is a contract with scripts/deploy/drift-gate.js,
// which reads it back as an annotation to tell a staging job that never reached
// the VPS (deploy-drift.yml re-runs it once) from one that failed (alarm).
// Title and message are both pinned: the gate matches either, and Deploy runs
// from before the title carry only the message.
const GIVE_UP = "::error title=VPS unreachable::ssh failed to connect after 3 attempts — runner→VPS network, not the deploy";
function giveUpPins(x, tag = "") {
	const gate = require("./deploy/drift-gate.js");
	const notes = annotationsFrom(x.out);
	return [
		[x.out.split("\n").includes(GIVE_UP), `${tag}§6 ssh-retry: gives up with exactly ${JSON.stringify(GIVE_UP)} (got ${JSON.stringify(x.out.split("\n").filter((l) => /^::error/.test(l)))})`],
		[x.out.split("\n").filter((l) => /^::error/.test(l)).length === 1, `${tag}§6 ssh-retry: one error line, printed once, after the LAST attempt`],
		[gate.neverReachedVps(notes), `${tag}§6 drift-gate.js reads that line, as the annotation GitHub makes of it, as "never reached the VPS"`],
		[!gate.neverReachedVps(notes.filter((a) => a.annotation_level !== "failure")), `${tag}§6 …and never the per-attempt warnings on their own`],
	];
}

function sshScenarios() {
	let x = runRetry([255, 255, 0], "0 0 0 0");
	ok(x.code === 0 && x.n === 3, `§6 ssh-retry: two transport failures then success → exit 0 after 3 attempts (code ${x.code}, n ${x.n})`);
	ok(x.payloads.every((p) => p === "echo payload\nexit 0"), "§6 ssh-retry: the full payload is replayed on every attempt");
	ok(/root@203\.0\.113\.9/.test(x.args) && /DIR='\/x' bash -s/.test(x.args) && /deploy_key/.test(x.args), "§6 ssh-retry: destination, remote command and the deploy key are passed to ssh");
	const recovered = annotationsFrom(x.out);
	ok(recovered.length === 2 && recovered.every((a) => a.annotation_level === "warning") && !require("./deploy/drift-gate.js").neverReachedVps(recovered),
		"§6 ssh-retry: a connection that recovered leaves warnings only, which the gate never reads as unreached");
	x = runRetry([3], "0 0 0 0");
	ok(x.code === 3 && x.n === 1, `§6 ssh-retry: a REMOTE failure passes straight through, no retry (code ${x.code}, n ${x.n})`);
	ok(!/^::error/m.test(x.out), "§6 ssh-retry: …and prints no give-up line: a deploy that connected and failed must still alarm");
	x = runRetry([75], "0 0 0 0");
	ok(x.code === 75 && x.n === 1, `§6 ssh-retry: the lock's 75 is NOT retried (code ${x.code}, n ${x.n})`);
	x = runRetry([255, 255, 255], "0 0");
	ok(x.code === 255 && x.n === 3 && /after 3 attempts/.test(x.out), `§6 ssh-retry: gives up after backoff+1 attempts with exit 255 (code ${x.code}, n ${x.n})`);
	record(giveUpPins(x));
	ok(/SSH_RETRY_BACKOFF-15 30 60 90\}/.test(fs.readFileSync(RETRY, "utf8")), "§6 ssh-retry: the production budget is still 5 attempts over 15/30/60/90 s (sized from a measured outage)");

	const setup = path.join(DEPLOY_DIR, "ssh-setup.sh");
	const home2 = fs.mkdtempSync(path.join(T, "home-"));
	const runSetup = (key, known) => spawnSync("bash", [setup], { env: { PATH: ENV.PATH, HOME: home2, VPS_SSH_KEY: key, VPS_SSH_KNOWN_HOSTS: known }, encoding: "utf8" });
	let s = runSetup("KEY", "");
	ok(s.status === 1 && /VPS_SSH_KNOWN_HOSTS is empty/.test(s.stdout + s.stderr), "§6 ssh-setup: an EMPTY pinned host key is refused (a file-size test cannot see one)");
	s = runSetup("KEY", " \n\t ");
	ok(s.status === 1, "§6 ssh-setup: a whitespace-only host key is refused too");
	s = runSetup("", "203.0.113.9 ssh-ed25519 AAAA");
	ok(s.status === 1 && /VPS_SSH_KEY is empty/.test(s.stdout + s.stderr), "§6 ssh-setup: an empty deploy key is refused");
	s = runSetup("KEY", "203.0.113.9 ssh-ed25519 AAAA");
	const kf = path.join(home2, ".ssh", "known_hosts");
	const df = path.join(home2, ".ssh", "deploy_key");
	ok(s.status === 0 && fs.readFileSync(kf, "utf8") === "203.0.113.9 ssh-ed25519 AAAA\n" && fs.readFileSync(df, "utf8") === "KEY\n", "§6 ssh-setup: writes the key and the pinned host key");
	ok((fs.statSync(df).mode & 0o777) === 0o600 && (fs.statSync(kf).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(kf)).mode & 0o777) === 0o700, "§6 ssh-setup: 600 files in a 700 directory");
}

// ─────────────────────────────────────────────────────────── §7 source pins
function lockBlock(text) {
	const a = text.indexOf("# >>> deploy-lock");
	const b = text.indexOf("# <<< deploy-lock");
	return a >= 0 && b > a ? text.slice(a, b) : null;
}
function verifiedBlock(text) {
	const a = text.indexOf("# >>> verified-record");
	const b = text.indexOf("# <<< verified-record");
	return a >= 0 && b > a ? text.slice(a, b) : null;
}
// The box's two refs and the only scripts allowed to write each. The record
// (verified-deploy): the record step, after verification, and a rollback that
// serves again. The started mark: the deploy once pm2 reports the app online,
// and a rollback after its restart. Never the smoke check or the drift path.
const REF_WRITERS = {
	[VERIFIED_REF]: ["remote-record-verified.sh", "remote-rollback.sh"],
	[STARTED_REF]: ["remote-deploy.sh", "remote-rollback.sh"],
};
function refPins(scripts, tag = "") {
	const r = [];
	const code = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l));
	const named = new Set(Object.values(scripts).flatMap((t) => t.match(/refs\/logisx\/[A-Za-z0-9._-]+/g) || []));
	r.push([JSON.stringify([...named].sort()) === JSON.stringify(Object.keys(REF_WRITERS).sort()),
		`${tag}§7 the remote scripts name exactly the two refs ${Object.keys(REF_WRITERS).join(" and ")} (got ${[...named].join(", ")})`]);
	// Every update-ref names its ref literally, so each write can be attributed.
	const writes = Object.entries(scripts).flatMap(([n, t]) => code(t).filter((l) => /\bupdate-ref\b/.test(l)).map((l) => [n, (/refs\/logisx\/[A-Za-z0-9._-]+/.exec(l) || [""])[0]]));
	r.push([writes.length >= 4 && writes.every(([, ref]) => ref),
		`${tag}§7 every update-ref in a remote script names its ref literally (${writes.length} found; unattributed in: ${writes.filter(([, ref]) => !ref).map(([n]) => n).join(", ") || "none"})`]);
	for (const [ref, want] of Object.entries(REF_WRITERS)) {
		const got = [...new Set(writes.filter(([, x]) => x === ref).map(([n]) => n))].sort();
		r.push([JSON.stringify(got) === JSON.stringify(want), `${tag}§7 only ${want.join(" and ")} write ${ref} (writers: ${got.join(", ") || "none"})`]);
	}
	return r;
}
// Every git fetch, pull and merge in a script that holds the lock runs with
// the lock FD closed: git may start a credential-cache daemon, which would
// inherit FD 9 and hold the lock after the script has exited.
function gitFdPins(S, tag = "") {
	return [["remote-deploy.sh", S.deploy], ["remote-rollback.sh", S.rollback], ["remote-record-verified.sh", S.record]].map(([name, text]) => {
		const lines = text.split("\n").filter((l) => !/^\s*#/.test(l) && /\bgit (fetch|pull|merge)(?=\s|$)/.test(l));
		const open = lines.filter((l) => !/9>&-/.test(l));
		return [open.length === 0 && (name !== "remote-deploy.sh" || lines.length >= 3),
			`${tag}§7 every git fetch/pull/merge in ${name} closes the lock FD (9>&-) (${lines.length} found; open: ${JSON.stringify(open.map((l) => l.trim()))})`];
	});
}
// The drift check reads the box under the deploy's own lock: the same file,
// computed the same way, taken with -n after ls-remote and before any read,
// released once the refs and the marker are read and before the HTTP probe.
// It never fetches. Who waits for a held lock is set per script.
function checkLockPins(S, tag = "") {
	const lockLines = (text) => text.split("\n").filter((l) => /^LOCK_(DIR|FILE)=/.test(l)).join("\n");
	const code = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
	const c = code(S.check);
	const flockAt = c.indexOf("if ! flock -n 9; then");
	const releaseAt = c.indexOf("exec 9>&-");
	return [
		[lockLines(S.deploy) !== "" && lockLines(S.check) === lockLines(S.deploy),
			`${tag}§7 remote-drift-check.sh computes the deploy lock file exactly as remote-deploy.sh does (got ${JSON.stringify(lockLines(S.check))})`],
		[flockAt > c.indexOf("git ls-remote origin refs/heads/main") && flockAt < c.indexOf("HEAD_SHA=$(git rev-parse HEAD)"),
			`${tag}§7 remote-drift-check.sh takes the lock (flock -n) after ls-remote and before it reads HEAD`],
		[releaseAt > c.indexOf('LAST=$(cat "$MARKER"') && releaseAt < c.indexOf("CODE=$(curl") && releaseAt < c.indexOf('echo "DRIFT_LOCAL='),
			`${tag}§7 remote-drift-check.sh lets go of the lock once refs and the marker are read, before the HTTP probe`],
		[!/\bgit fetch\b/.test(c), `${tag}§7 remote-drift-check.sh never fetches: it writes nothing into the clone`],
		[/by=remote-drift-check\.sh/.test(c), `${tag}§7 remote-drift-check.sh writes a holder note naming itself, which a deploy reads to decide to wait`],
		[/^LOCK_WAITS_FOR=drift-check$/m.test(S.deploy) && /^LOCK_WAITS_FOR=any$/m.test(S.rollback) && /^LOCK_WAITS_FOR=any$/m.test(S.record),
			`${tag}§7 a deploy waits only for the drift check; a rollback and the record step wait for any holder (bounded)`],
		[/^LOCK_WAIT_S=\$\{DEPLOY_LOCK_WAIT_S:-(1[5-9]|2\d|30)\}$/m.test(S.deploy), `${tag}§7 the bounded wait defaults to 15–30 s`],
	];
}

function sourcePins() {
	const ld = lockBlock(REAL.deploy);
	const lr = lockBlock(REAL.rollback);
	const lv = lockBlock(REAL.record);
	ok(ld && lr && lv && ld === lr && ld === lv, "§7 the deploy-lock block is byte-identical in remote-deploy.sh, remote-rollback.sh and remote-record-verified.sh");
	const lockAtRecord = REAL.record.indexOf("# >>> deploy-lock");
	ok(lockAtRecord > 0 && REAL.record.indexOf('cd "$DIR"') > lockAtRecord && REAL.record.indexOf("git rev-parse HEAD") > lockAtRecord,
		"§7 remote-record-verified.sh takes the lock before it reads the repo");
	ok(REAL.record.indexOf("SHA must be the full") > 0 && REAL.record.indexOf("SHA must be the full") < lockAtRecord, "§7 remote-record-verified.sh validates SHA before it takes the lock");
	// The verified-deploy record: one reading of it, in every script that reads it.
	const vd = verifiedBlock(REAL.deploy);
	ok(vd && vd === verifiedBlock(REAL.check) && vd === verifiedBlock(REAL.heal),
		"§7 the verified-record block is byte-identical in remote-deploy.sh, remote-drift-check.sh and remote-drift-heal.sh");
	record(checkLockPins(REAL));
	record(refPins(REMOTE_SCRIPTS));
	for (const [name, text] of [["remote-deploy.sh", REAL.deploy], ["remote-rollback.sh", REAL.rollback]]) {
		const lockAt = text.indexOf("# >>> deploy-lock");
		const cdAt = text.indexOf('cd "$DIR"');
		ok(lockAt > 0 && cdAt > lockAt, `§7 ${name} takes the lock before it touches the repo`);
		const pm2Lines = text.split("\n").filter((l) => /^\s*[^#]*\bpm2 (restart|jlist|start|reload)\b/.test(l));
		ok(pm2Lines.length > 0 && pm2Lines.every((l) => /9>&-/.test(l)), `§7 every pm2 call in ${name} closes the lock FD (9>&-)`);
		const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
		ok(!/pm2 (restart|reload|stop|delete) all\b/.test(code), `§7 ${name} never restarts ALL pm2 processes (23 other clients share the box)`);
	}
	record(gitFdPins(REAL));
	ok(REAL.deploy.indexOf("SHA must be a full") < REAL.deploy.indexOf("# >>> deploy-lock"), "§7 SHA is validated before the lock is even taken");
	ok(REAL.rollback.indexOf("PREV must be a full") > 0 && REAL.rollback.indexOf("PREV must be a full") < REAL.rollback.indexOf("# >>> deploy-lock"),
		"§7 the rollback validates PREV before the lock is even taken");
	for (const name of ["deploy", "rollback", "check", "heal"]) {
		ok(/\.drift-heal-attempted/.test(REAL[name]), `§7 ${name} uses the one marker filename, .drift-heal-attempted`);
	}
	const gi = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
	ok(/^\.drift-heal-attempted$/m.test(gi), "§7 the marker stays gitignored (the dirty-tree check must not trip on it)");
}

// ──────────────────────────────────────────────────────────────── §8 mutants
// One job each (see "running it" below).
const mutant = (name, results, secs = 0) => job(`${M}${name}`, async () => expectCaught(name, await results()), secs);
function mutants() {
	// ssh-retry.sh's give-up line (§6): the title, the message and the level
	// are each pinned. Each mutant runs as a real script in the sandbox.
	const retryMutant = ([name, from, to]) => mutant(name, () => {
		const mutated = path.join(T, `ssh-retry-mutant-${Math.random().toString(36).slice(2)}.sh`);
		fs.writeFileSync(mutated, swap(fs.readFileSync(RETRY, "utf8"), from, to));
		return giveUpPins(runRetry([255, 255, 255], "0 0", mutated), M);
	});
	return [
		mutant("no box lock", () => lockScenario({ ...REAL, deploy: cut(REAL.deploy), rollback: cut(REAL.rollback) }, M), 2),
		mutant("SHA ignored", () => PIN_CASES.exact({ ...REAL, deploy: swap(REAL.deploy, 'if [ -n "$SHA" ]; then\n\tif ! git cat-file', 'if false; then\n\tif ! git cat-file') }, M)),
		mutant("no-op check removed (deploys backwards)", () => PIN_CASES.noop({ ...REAL, deploy: swap(REAL.deploy, '[ "$SHA" != "$LIVE" ] && git merge-base', 'false && git merge-base') }, M)),
		mutant("the rollback takes any PREV", () => PIN_CASES.badInput({ ...REAL, rollback: swap(REAL.rollback, 'if ! [[ "$PREV" =~ ^[0-9a-f]{40}$ ]]; then', "if false; then") }, M)),
		mutant("the fast-forward merge keeps the lock FD", () => gitFdPins({ ...REAL, deploy: swap(REAL.deploy, 'git merge --ff-only "$SHA" 9>&-', 'git merge --ff-only "$SHA"') }, M)),
		mutant("the deploy writes the verified record at restart", () => refPins({
			...REMOTE_SCRIPTS,
			"remote-deploy.sh": swap(REMOTE_SCRIPTS["remote-deploy.sh"], 'refs/logisx/started-deploy "$NEW"', 'refs/logisx/verified-deploy "$NEW"'),
		}, M)),
		mutant("the smoke check marks a commit started", () => refPins({
			...REMOTE_SCRIPTS,
			"remote-smoke.sh": `${REMOTE_SCRIPTS["remote-smoke.sh"]}git update-ref refs/logisx/started-deploy HEAD\n`,
		}, M)),
		mutant("failed pull ignored", () => PIN_CASES.pullFails({
			...REAL,
			deploy: swap(REAL.deploy, "if ! { git checkout main && git pull --ff-only origin main 9>&-; }; then", "if ! { git checkout main && git pull --ff-only origin main 9>&- || true; }; then"),
		}, M)),
		mutant("pm2 inherits the lock FD", () => PIN_CASES.exact({ ...REAL, deploy: swap(REAL.deploy, 'pm2 restart "$PM2" --silent 9>&-', 'pm2 restart "$PM2" --silent') }, M)),
		mutant("rollback leaves no marker", () => DRIFT_CASES.rollbackMarker({ ...REAL, rollback: swap(REAL.rollback, 'printf \'%s\' "$FAILED" > "$DIR/.drift-heal-attempted"', "true") }, M)),
		mutant("manual pin leaves no marker", () => DRIFT_CASES.manualPin({ ...REAL, deploy: swap(REAL.deploy, 'printf \'%s\' "$PIN_MAIN" > "$DIR/.drift-heal-attempted"', "true") }, M)),
		mutant("heal prep skips its compare-and-swap", () => DRIFT_CASES.healPrep({ ...REAL, heal: swap(REAL.heal, '[ "$NOW" = "$EXPECT" ] ||', "true ||") }, M), 1),
		mutant("heal prep skips its HEAD compare", () => DRIFT_CASES.healPrep({ ...REAL, heal: swap(REAL.heal, '[ "$HEAD_NOW" = "$EXPECT_HEAD" ] ||', "true ||") }, M), 1),
		mutant("heal prep skips its marker compare", () => DRIFT_CASES.healPrep({ ...REAL, heal: swap(REAL.heal, '[ "${SEEN:-none}" = "$EXPECT_MARKER" ] ||', "true ||") }, M), 1),
		mutant("the drift check ignores a held deploy lock", () => DRIFT_CASES.checkLocked({ ...REAL, check: swap(REAL.check, "if ! flock -n 9; then", "if false; then") }, M)),
		mutant("the drift check never calls a lock stuck", () => DRIFT_CASES.checkLockStuck({ ...REAL, check: swap(REAL.check, "-mmin +30", "-mmin +999999") }, M)),
		mutant("the drift check holds the lock through its HTTP probe", () => checkLockPins({
			...REAL,
			check: swap(swap(REAL.check, "# Refs and the marker are read: let a deploy have the box before the probe.\nexec 9>&-\n", ""),
				'echo "DRIFT_LOCAL=$LOCAL"', 'exec 9>&-\necho "DRIFT_LOCAL=$LOCAL"'),
		}, M)),
		mutant("ls-remote takes the first ref whose tail matches", () => DRIFT_CASES.checkExactMain({
			...REAL,
			check: swap(REAL.check, "awk '$2==\"refs/heads/main\"{print $1}'", "cut -f1 | head -1"),
		}, M)),
		mutant("an unreadable origin falls back to the clone's origin/main", () => DRIFT_CASES.checkRemoteUnreadable({
			...REAL,
			check: swap(REAL.check, '\techo "could not read main\'s tip from origin (git ls-remote)"\n\techo "DRIFT_STATE=remote-unreadable"\n\texit 0\n', "\tREMOTE=$(git rev-parse origin/main)\n"),
		}, M)),
		mutant("the drift check fetches again", () => DRIFT_CASES.checkReadsOnly({
			...REAL,
			check: swap(REAL.check, "REMOTE=$(ls_main 2>/dev/null | awk '$2==\"refs/heads/main\"{print $1}')", "git fetch --quiet origin; REMOTE=$(git rev-parse origin/main)"),
		}, M)),
		mutant("a rollback fails fast on the drift check's read", () => DRIFT_CASES.rollbackWaits({ ...REAL, rollback: swap(REAL.rollback, "LOCK_WAITS_FOR=any", "LOCK_WAITS_FOR=drift-check") }, M), 1),
		mutant("the record step fails fast on the drift check's read", () => DRIFT_CASES.recordWaits({ ...REAL, record: swap(REAL.record, "LOCK_WAITS_FOR=any", "LOCK_WAITS_FOR=drift-check") }, M), 1),
		mutant("a deploy waits for another deploy", () => DRIFT_CASES.deployFailsFast({ ...REAL, deploy: swap(REAL.deploy, "LOCK_WAITS_FOR=drift-check", "LOCK_WAITS_FOR=any") }, M), 3),
		mutant("a deploy ignores the holder's note", () => DRIFT_CASES.deployWaitsForCheck({ ...REAL, deploy: swap(REAL.deploy, ' || [[ "$LOCK_HOLDER" == *"by=remote-drift-check.sh"* ]]', "") }, M), 1),
		mutant("deploy probe only require()s the module (passes under the wrong Node)", () => PROBE_CASES.lazyAbi({ ...REAL, deploy: swap(REAL.deploy, DB_PROBE, REQUIRE_ONLY_PROBE) }, M)),
		mutant("rollback probe only require()s the module", () => PROBE_CASES.rollbackLazyAbi({ ...REAL, rollback: swap(REAL.rollback, DB_PROBE, REQUIRE_ONLY_PROBE) }, M)),
		mutant("deploy restarts even when the rebuild did not help", () => PROBE_CASES.stillBroken({
			...REAL,
			deploy: swap(REAL.deploy, `|| { echo "::error::better-sqlite3 still fails to load after rebuild"; exit 1; }`, `|| echo "better-sqlite3 still fails to load after rebuild"`),
		}, M)),
		...[
			["ssh-retry drops the give-up title", "::error title=VPS unreachable::", "::error::"],
			["ssh-retry rewords the give-up message", "ssh failed to connect after $total attempts", "could not reach the VPS after $total attempts"],
			["ssh-retry gives up with a warning, not an error", 'echo "::error title=VPS unreachable::', 'echo "::warning title=VPS unreachable::'],
		].map(retryMutant),
		// §10: the smoke check's log tail with workflow commands left on.
		mutant("the smoke check prints the pm2 log with commands on", () => smokeLogPins(
			swap(swap(SMOKE, 'echo "::stop-commands::$tok"', ":"), 'echo "::$tok::"', ":"), M), 1),
		// §11: a remote script that exits 255 itself, or lets errexit do it.
		mutant("remote-deploy.sh ends with exit 255", () => exitPins({ ...REMOTE_SCRIPTS, "remote-deploy.sh": `${REMOTE_SCRIPTS["remote-deploy.sh"]}exit 255\n` }, M)),
		mutant("remote-rollback.sh turns on errexit", () => exitPins({ ...REMOTE_SCRIPTS, "remote-rollback.sh": swap(REMOTE_SCRIPTS["remote-rollback.sh"], "set -uo pipefail", "set -euo pipefail") }, M)),
		mutant("remote-drift-check.sh gets a bare exit", () => exitPins({ ...REMOTE_SCRIPTS, "remote-drift-check.sh": swap(REMOTE_SCRIPTS["remote-drift-check.sh"], 'cd "$DIR" || exit 1', 'cd "$DIR" || exit') }, M)),

		mutant("the record script skips the deploy lock", () => lockScenario({ ...REAL, record: cut(REAL.record) }, M), 2),

		// §15: the restart is proven.
		mutant("the deploy ignores whether the start time moved", () => RESTART_CASES.deployRestartNoop({ ...REAL, deploy: swap(REAL.deploy,
			'elif [ "$UPTIME_AFTER" = "$UPTIME_BEFORE" ]; then', "elif false; then") }, M)),
	];
}

// ─────────────────────── §10 the smoke check's log tail, commands switched off

// The runner's reading of a job log: `::stop-commands::TOKEN` pauses workflow
// commands until a line that is exactly `::TOKEN::`. What is left is what can
// become an annotation.
function commandLines(out) {
	const kept = [];
	let paused = null;
	for (const l of out.split("\n")) {
		if (paused !== null) {
			if (l === `::${paused}::`) paused = null;
			continue;
		}
		const m = /^::stop-commands::(.+)$/.exec(l);
		if (m) { paused = m[1]; continue; }
		kept.push(l);
	}
	return kept.join("\n");
}

// A pm2 error log holding lines shaped like workflow commands, one of them
// behind a carriage return.
const COMMAND_SHAPED_LOG = [
	"2026-09-24T10:00:00Z Error: listen EADDRINUSE",
	"::error title=VPS unreachable::ssh failed to connect after 5 attempts — runner→VPS network, not the deploy",
	"::warning::a line from the app",
	"progress 50%\r::error::after a carriage return",
].join("\n");
// Its own stub dir, first on PATH: a pm2 that prints that log, and a sleep
// that returns at once (the real smoke loop waits up to 60 s).
let smokeBin = null;
function smokeBinDir() {
	if (smokeBin) return smokeBin;
	smokeBin = path.join(T, "smoke-bin");
	fs.mkdirSync(smokeBin);
	writeExec(path.join(smokeBin, "sleep"), "#!/bin/bash\nexit 0\n");
	writeExec(path.join(smokeBin, "pm2"), "#!/bin/bash\nif [ \"$1\" = logs ]; then printf '%s\\n' \"$STUB_PM2_LOG\"; fi\nexit 0\n");
	return smokeBin;
}
function runFailingSmoke(text) {
	return runSh(text, { DIR: D.box, PM2: "logistics-app", STUB_HTTP_CODE: "503", STUB_PM2_LOG: COMMAND_SHAPED_LOG, PATH: `${smokeBinDir()}:${ENV.PATH}` });
}
const pausedBetween = (out) => {
	const lines = out.split("\n");
	const start = lines.findIndex((l) => /^::stop-commands::[0-9a-f]{32}$/.test(l));
	const tok = start >= 0 ? lines[start].slice("::stop-commands::".length) : null;
	const end = tok ? lines.indexOf(`::${tok}::`) : -1;
	return { lines, start, end, tok };
};
function smokeLogPins(text, tag = "") {
	const r = [];
	const gate = require("./deploy/drift-gate.js");
	const x = runFailingSmoke(text);
	const p = pausedBetween(x.out);
	r.push([x.code === 1, `${tag}§10 a failed smoke check still exits 1 (got ${x.code})`]);
	r.push([p.start >= 0 && p.end > p.start, `${tag}§10 the pm2 log tail prints between ::stop-commands::<32 hex chars> and ::<that token>:: (start ${p.start}, end ${p.end})`]);
	r.push([p.lines.slice(p.start + 1, p.end).some((l) => l.includes("ssh failed to connect after 5 attempts")), `${tag}§10 …and the log's lines really are inside that pause`]);
	const notes = annotationsFrom(commandLines(x.out));
	r.push([!gate.neverReachedVps(notes), `${tag}§10 a log line shaped like ssh-retry.sh's give-up line never becomes an annotation (got ${JSON.stringify(notes)})`]);
	r.push([notes.length === 1 && /^smoke check failed/.test(notes[0].message), `${tag}§10 the only annotation left is the smoke check's own error`]);
	r.push([!x.out.includes("\r"), `${tag}§10 carriage returns are stripped from the log`]);
	const y = pausedBetween(runFailingSmoke(text).out);
	r.push([!!p.tok && !!y.tok && p.tok !== y.tok, `${tag}§10 the token is new on every run`]);
	return r;
}
function smokeStaticPins() {
	// The reviewed shape, line for line and in order.
	const shape = [
		"tok=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')",
		'echo "::stop-commands::$tok"',
		"pm2 logs \"$PM2\" --nostream --lines 40 --err 2>/dev/null | tr -d '\\r' || true",
		'echo "::$tok::"',
	];
	const lines = SMOKE.split("\n");
	const at = shape.map((s) => lines.indexOf(s));
	ok(at.every((i, k) => i >= 0 && (k === 0 || i === at[k - 1] + 1)), `§10 remote-smoke.sh prints the pm2 log with the exact reviewed shape, in order (at lines ${at.map((i) => i + 1)})`);
	// And no remote script prints pm2 logs any other way.
	for (const f of fs.readdirSync(DEPLOY_DIR).filter((n) => /^remote-.*\.sh$/.test(n))) {
		const t = readScript(f).split("\n");
		t.forEach((l, i) => {
			if (!/^\s*[^#]*\bpm2 logs\b/.test(l)) return;
			const before = t.slice(0, i).reverse().find((x) => /::stop-commands::|echo "::\$tok::"/.test(x)) || "";
			ok(/::stop-commands::\$tok/.test(before) && /^\s*echo "::\$tok::"\s*$/.test(t[i + 1] || ""), `§10 ${f}:${i + 1} prints pm2 logs only inside a stop-commands pause`);
		});
	}
}

// ─────────────────────── §11 no remote script takes exit 255 itself
// ssh returns the remote command's status unchanged, and ssh-retry.sh reads 255
// as ssh's own transport failure: it retries, then prints the give-up line that
// deploy-drift.yml re-runs a staging job on. So the remote scripts' own exits
// stay off 255: literal codes only, no bare `exit` (it returns the last
// command's status), and no errexit (which would pass any failing command's
// status out as the script's own).

// The script with comments removed, quote-aware (a `#` inside quotes is text),
// and every quoted string KEPT, so an exit inside a quoted trap is still seen.
function stripShellComments(text) {
	let out = "";
	let q = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (q === "'") { out += c; if (c === "'") q = null; continue; }
		if (q === '"') {
			out += c;
			if (c === "\\" && i + 1 < text.length) { out += text[++i]; continue; }
			if (c === '"') q = null;
			continue;
		}
		if (c === "\\" && i + 1 < text.length) { out += c + text[++i]; continue; }
		if (c === "'" || c === '"') { q = c; out += c; continue; }
		if (c === "#" && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
			while (i < text.length && text[i] !== "\n") i++;
			if (i < text.length) out += "\n";
			continue;
		}
		out += c;
	}
	return out;
}
// Every shell `exit` (a word of its own, so JavaScript's process.exit() in a
// `node -e` string is not one), with its literal code or null.
function exitFindings(text) {
	const code = stripShellComments(text);
	const re = /(^|[\s;&|({!])exit(?=$|[\s;&|)}])/gm;
	const found = [];
	let m;
	while ((m = re.exec(code))) {
		const lit = /^[ \t]+([0-9]+)(?=$|[\s;&|)}])/m.exec(code.slice(m.index + m[0].length));
		const line = code.slice(0, m.index + m[1].length).split("\n").length;
		found.push({ line, literal: lit ? Number(lit[1]) : null });
	}
	const errexit = /(^|[\s;&|(])set[ \t]+(-[A-Za-z]*e[A-Za-z]*(?=[ \t;]|$)|-o[ \t]+errexit\b)/m.test(code);
	return { found, errexit };
}
function exitPins(scripts, tag = "") {
	const r = [];
	let total = 0;
	for (const [name, text] of Object.entries(scripts)) {
		const { found, errexit } = exitFindings(text);
		total += found.length;
		const bad = found.filter((f) => f.literal === null || f.literal === 255);
		r.push([bad.length === 0,
			`${tag}§11 ${name}: every exit the script itself takes is a literal other than 255, and none is bare, so an ssh 255 is never the script's own. This covers the scripts' own exits only, not a signal death or a dropped session (offending: ${JSON.stringify(bad)})`]);
		r.push([!errexit, `${tag}§11 ${name}: no errexit (set -e would pass any failing command's status, 255 included, out as the script's own)`]);
	}
	r.push([total >= 20, `${tag}§11 the scan saw the scripts' exits (found ${total}); a scan that matched nothing would pass vacuously`]);
	return r;
}
const REMOTE_SCRIPTS = Object.fromEntries(
	fs.readdirSync(DEPLOY_DIR).filter((n) => /^remote-.*\.sh$/.test(n)).sort().map((n) => [n, readScript(n)])
);
function exitScannerSelfCheck() {
	const fx = exitFindings([
		"cd x || exit 1",
		"{ echo hi; exit 75; }",
		"if a; then exit 255; fi",
		"[ -n x ] || exit",
		"exit \"$rc\"",
		"# exit 255 in a comment",
		"node -e 'process.exit(255)'",
		"echo \"a # inside quotes\"; exit 3",
		"x=1 # a trailing comment: exit 255",
	].join("\n"));
	const lits = fx.found.map((f) => f.literal);
	ok(JSON.stringify(lits) === JSON.stringify([1, 75, 255, null, null, 3]),
		`§11 the exit scanner reads literal, bare and variable exits, and skips comments and process.exit() (got ${JSON.stringify(lits)})`);
	ok(exitFindings("set -euo pipefail\n").errexit && exitFindings("set -o errexit\n").errexit && exitFindings("set -e\n").errexit
		&& !exitFindings("set -uo pipefail\n").errexit && !exitFindings("# set -e\n").errexit && !exitFindings("set +e\n").errexit,
	"§11 the errexit check sees -e in any flag cluster and -o errexit, and not set +e or a comment");
	const names = Object.keys(REMOTE_SCRIPTS);
	ok(["remote-backup-check.sh", "remote-deploy.sh", "remote-drift-check.sh", "remote-drift-heal.sh", "remote-rollback.sh", "remote-smoke.sh"].every((n) => names.includes(n)),
		`§11 the scan covers every scripts/deploy/remote-*.sh (got ${names.join(", ")})`);
}

// ─────────────────────────────────────────────────────────────── running it
// Run one after another, these checks took ~45 s on a Mac: some 730 processes,
// a few hundred ms per real deploy, and lock waits that only time can prove.
// So each case is a job, and WORKERS processes run the jobs side by side, each
// in a sandbox of its own (deploy-test-sandbox.js builds one per process). This
// process hands the jobs out, one at a time as each worker finishes its last,
// then adds up every worker's counts and reports. The longest jobs go first,
// so the short ones fill in around them.
const WORKER_ENV = "DEPLOY_SCRIPTS_TEST_WORKER";
const WORKERS = Math.max(2, Math.min(8, os.availableParallelism()));
const caseJobs = (section, cases, secs = {}) => Object.entries(cases).map(([name, fn]) => job(`${section} ${name}`, () => record(fn(REAL, "")), secs[name]));
const ALL_JOBS = [
	job("§1 the box lock", async () => record(await lockScenario(REAL)), 2),
	...caseJobs("§2/§3", PIN_CASES),
	...caseJobs("§4/§5", DRIFT_CASES, { recordWaits: 1, rollbackWaits: 1, deployWaitsForCheck: 1, waitBounded: 1, healPrep: 1 }),
	...caseJobs("§9", PROBE_CASES),
	...caseJobs("§15", RESTART_CASES),
	job("§7 restart pins", () => record(restartPins(REAL))),
	job("§6 ssh helpers", sshScenarios),
	job("§7 source pins", sourcePins),
	job("§9 probe pins", probePins),
	job("§16 install pins", installPins, 1),
	job("§10 smoke log tail", () => record(smokeLogPins(SMOKE)), 1),
	job("§10 smoke static pins", smokeStaticPins),
	job("§11 exit scanner", exitScannerSelfCheck),
	job("§11 exit pins", () => record(exitPins(REMOTE_SCRIPTS))),
	...mutants(),
];
const JOBS = [...ALL_JOBS].sort((a, b) => b.secs - a.secs);

// A worker: runs each job it is handed; on `end`, removes its sandbox and
// hands back its counts.
function work() {
	let ended = false;
	process.on("message", async (m) => {
		if (m.end) {
			ended = true;
			removeSandbox();
			process.send({ tally: tally() }, () => process.disconnect());
			return;
		}
		const { name, fn } = JOBS[m.job];
		try {
			await fn();
		} catch (err) {
			ok(false, `${name}: crashed: ${err && err.stack ? err.stack : err}`);
		}
		process.send({ done: m.job });
	});
	// The process that reports is gone (killed by its own timeout): stop too.
	process.on("disconnect", () => {
		if (ended) return;
		removeSandbox();
		process.exit(1);
	});
	process.send({ ready: true });
}

function runWorker(i, nextJob) {
	return new Promise((resolve) => {
		const env = { ...process.env, [WORKER_ENV]: String(i), DEPLOY_TEST_STUB_EXEC: STUB_EXEC };
		const w = fork(__filename, [], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
		let out = "";
		let counts = null;
		let current = null;
		w.stdout.on("data", (c) => (out += c));
		w.stderr.on("data", (c) => (out += c));
		w.on("message", (m) => {
			if (m.tally) {
				counts = m.tally;
				return;
			}
			current = nextJob();
			w.send(current === null ? { end: true } : { job: current });
		});
		w.on("close", (code, signal) => {
			if (counts) absorb(counts);
			else ok(false, `worker ${i} exited (${code === null ? signal : code}) before handing back its counts${current === null ? "" : `, during ${JOBS[current].name}`}:\n${out}`);
			resolve();
		});
	});
}

async function coordinate() {
	console.log(`flock: ${hasRealFlock ? "real flock(1) from PATH" : "perl flock(2) shim (no flock(1) on this machine)"}`);
	console.log(`${JOBS.length} jobs in ${WORKERS} worker processes`);
	let next = 0;
	const nextJob = () => (next < JOBS.length ? next++ : null);
	await Promise.all(Array.from({ length: WORKERS }, (_, i) => runWorker(i, nextJob)));
}

if (process.send && process.env[WORKER_ENV]) {
	work();
} else {
	coordinate().catch(crash).finally(finish);
}
