#!/usr/bin/env node
/**
 * Runs the REAL scripts/deploy/*.sh against a throwaway git sandbox, the way
 * the workflows run them: each script text is fed to `bash -s` on stdin, which
 * is exactly what ssh does on the VPS.
 *
 * WHY IT EXISTS. These scripts deploy production unattended on every merge.
 * Each property below is a way they could fail silently or by racing:
 *   §1 THE BOX LOCK: two deploys of one directory must never overlap (two
 *      pulls, two installs, two builds into one client/dist). The second fails
 *      fast with exit 75 and changes nothing, and a deploy and a rollback
 *      share the one lock.
 *   §2 EXACT-SHA DEPLOYS: with SHA set the box lands on exactly that commit,
 *      stays on branch main, never moves backwards, and refuses a commit that
 *      main does not contain. Without SHA, REF=main keeps its old meaning.
 *   §3 CHECKED GIT STEPS: a failed pull, fast-forward or checkout fails the
 *      deploy, with nothing rebuilt or restarted.
 *   §4 THE DRIFT MARKER'S THREE WRITERS: the heal prep, an auto-rollback, and a
 *      manual pin. After any of them the drift check must ALARM
 *      (behind-already-attempted), never heal: a rolled-back commit, or main
 *      over a human's pin, is a human's call.
 *   §5 remote-drift-check.sh's four box states, and the heal prep's
 *      compare-and-swap (it refuses when the box moved since the check).
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
 * Run: node scripts/test-deploy-scripts.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const {
	DEPLOY_DIR, readScript, REAL, SMOKE, ok, record, finish, crash,
	T, D, ENV, git, tryGit, writeExec, hasRealFlock,
	C1, C2, C3, S1, MARKER, LOCK_FILE, head, onMain, marker, log, VERIFIED_REF, verified, STARTED_REF,
	resetBox, runSh, deployEnv, field, waitFor, swap, cut, expectCaught, M,
} = require("./deploy-test-sandbox.js");

// ───────────────────────────────────────────────── §1 the box lock (async)
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
		const R = runSh(S.rollback, { DIR: D.box, PM2: "logistics-app", PREV: C1, STUB_TAG: "R" });
		// A has checked out C2 and is still installing: C2 is NOT verified. The
		// record step shares the lock, so it can never record a deploy mid-flight.
		const V = runSh(S.record, { DIR: D.box, SHA: C2, STUB_TAG: "V" });
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
	healPrep(S, tag) {
		// Heal prep: compare-and-swap against what the check saw.
		const r = [];
		let x;
		resetBox(C2);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C2 });
		r.push([x.code === 0 && field(x.out, "HEAL_READY") === "yes" && marker() === C3, `${tag}§5 heal prep: box as the check saw it → ready, marker = target`]);
		x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		r.push([x.code === 0 && head() === C3 && checkState(S) === "in-sync", `${tag}§5 the heal's exact-SHA deploy brings the box in sync`]);
		resetBox(C2);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C1 });
		r.push([field(x.out, "HEAL_READY") === "no" && marker() === "", `${tag}§5 heal prep: the box moved since the check → not ready, NO marker written`]);
		fs.writeFileSync(MARKER, C3);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C2 });
		r.push([field(x.out, "HEAL_READY") === "no", `${tag}§5 heal prep: already attempted → not ready`]);
		fs.rmSync(MARKER, { force: true });
		x = runSh(S.heal, { DIR: D.box, TARGET: S1, EXPECT: C2 });
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
const runCases = (cases, S, tag = "") => Object.values(cases).flatMap((fn) => fn(S, tag));

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
async function mutants() {
	const M = "[mutant] ";
	expectCaught("no box lock", await lockScenario({ ...REAL, deploy: cut(REAL.deploy), rollback: cut(REAL.rollback) }, M));
	expectCaught("SHA ignored", PIN_CASES.exact({ ...REAL, deploy: swap(REAL.deploy, 'if [ -n "$SHA" ]; then\n\tif ! git cat-file', 'if false; then\n\tif ! git cat-file') }, M));
	expectCaught("no-op check removed (deploys backwards)", PIN_CASES.noop({ ...REAL, deploy: swap(REAL.deploy, '[ "$SHA" != "$LIVE" ] && git merge-base', 'false && git merge-base') }, M));
	expectCaught("the rollback takes any PREV", PIN_CASES.badInput({ ...REAL, rollback: swap(REAL.rollback, 'if ! [[ "$PREV" =~ ^[0-9a-f]{40}$ ]]; then', "if false; then") }, M));
	expectCaught("the fast-forward merge keeps the lock FD", gitFdPins({ ...REAL, deploy: swap(REAL.deploy, 'git merge --ff-only "$SHA" 9>&-', 'git merge --ff-only "$SHA"') }, M));
	expectCaught("the deploy writes the verified record at restart", refPins({
		...REMOTE_SCRIPTS,
		"remote-deploy.sh": swap(REMOTE_SCRIPTS["remote-deploy.sh"], 'refs/logisx/started-deploy "$NEW"', 'refs/logisx/verified-deploy "$NEW"'),
	}, M));
	expectCaught("the smoke check marks a commit started", refPins({
		...REMOTE_SCRIPTS,
		"remote-smoke.sh": `${REMOTE_SCRIPTS["remote-smoke.sh"]}git update-ref refs/logisx/started-deploy HEAD\n`,
	}, M));
	expectCaught("failed pull ignored", PIN_CASES.pullFails({
		...REAL,
		deploy: swap(REAL.deploy, "if ! { git checkout main && git pull --ff-only origin main 9>&-; }; then", "if ! { git checkout main && git pull --ff-only origin main 9>&- || true; }; then"),
	}, M));
	expectCaught("pm2 inherits the lock FD", PIN_CASES.exact({ ...REAL, deploy: swap(REAL.deploy, 'pm2 restart "$PM2" --silent 9>&-', 'pm2 restart "$PM2" --silent') }, M));
	expectCaught("rollback leaves no marker", DRIFT_CASES.rollbackMarker({ ...REAL, rollback: swap(REAL.rollback, 'printf \'%s\' "$FAILED" > "$DIR/.drift-heal-attempted"', "true") }, M));
	expectCaught("manual pin leaves no marker", DRIFT_CASES.manualPin({ ...REAL, deploy: swap(REAL.deploy, 'printf \'%s\' "$PIN_MAIN" > "$DIR/.drift-heal-attempted"', "true") }, M));
	expectCaught("heal prep skips its compare-and-swap", DRIFT_CASES.healPrep({ ...REAL, heal: swap(REAL.heal, '[ "$NOW" = "$EXPECT" ] ||', "true ||") }, M));
	expectCaught("deploy probe only require()s the module (passes under the wrong Node)", PROBE_CASES.lazyAbi({ ...REAL, deploy: swap(REAL.deploy, DB_PROBE, REQUIRE_ONLY_PROBE) }, M));
	expectCaught("rollback probe only require()s the module", PROBE_CASES.rollbackLazyAbi({ ...REAL, rollback: swap(REAL.rollback, DB_PROBE, REQUIRE_ONLY_PROBE) }, M));
	expectCaught("deploy restarts even when the rebuild did not help", PROBE_CASES.stillBroken({
		...REAL,
		deploy: swap(REAL.deploy, `|| { echo "::error::better-sqlite3 still fails to load after rebuild"; exit 1; }`, `|| echo "better-sqlite3 still fails to load after rebuild"`),
	}, M));
	// ssh-retry.sh's give-up line (§6): the title, the message and the level
	// are each pinned. Each mutant runs as a real script in the sandbox.
	const retryText = fs.readFileSync(RETRY, "utf8");
	for (const [name, from, to] of [
		["ssh-retry drops the give-up title", "::error title=VPS unreachable::", "::error::"],
		["ssh-retry rewords the give-up message", "ssh failed to connect after $total attempts", "could not reach the VPS after $total attempts"],
		["ssh-retry gives up with a warning, not an error", 'echo "::error title=VPS unreachable::', 'echo "::warning title=VPS unreachable::'],
	]) {
		const mutated = path.join(T, `ssh-retry-mutant-${Math.random().toString(36).slice(2)}.sh`);
		fs.writeFileSync(mutated, swap(retryText, from, to));
		expectCaught(name, giveUpPins(runRetry([255, 255, 255], "0 0", mutated), M));
	}
	// §10: the smoke check's log tail with workflow commands left on.
	expectCaught("the smoke check prints the pm2 log with commands on", smokeLogPins(
		swap(swap(SMOKE, 'echo "::stop-commands::$tok"', ":"), 'echo "::$tok::"', ":"), M));
	// §11: a remote script that exits 255 itself, or lets errexit do it.
	expectCaught("remote-deploy.sh ends with exit 255", exitPins({ ...REMOTE_SCRIPTS, "remote-deploy.sh": `${REMOTE_SCRIPTS["remote-deploy.sh"]}exit 255\n` }, M));
	expectCaught("remote-rollback.sh turns on errexit", exitPins({ ...REMOTE_SCRIPTS, "remote-rollback.sh": swap(REMOTE_SCRIPTS["remote-rollback.sh"], "set -uo pipefail", "set -euo pipefail") }, M));
	expectCaught("remote-drift-check.sh gets a bare exit", exitPins({ ...REMOTE_SCRIPTS, "remote-drift-check.sh": swap(REMOTE_SCRIPTS["remote-drift-check.sh"], 'cd "$DIR" || exit 1', 'cd "$DIR" || exit') }, M));

	expectCaught("the record script skips the deploy lock", await lockScenario({ ...REAL, record: cut(REAL.record) }, M));
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

(async () => {
	console.log(`flock: ${hasRealFlock ? "real flock(1) from PATH" : "perl flock(2) shim (no flock(1) on this machine)"}`);
	record(await lockScenario(REAL));
	record(runCases(PIN_CASES, REAL));
	record(runCases(DRIFT_CASES, REAL));
	record(runCases(PROBE_CASES, REAL));
	sshScenarios();
	sourcePins();
	probePins();
	record(smokeLogPins(SMOKE));
	smokeStaticPins();
	exitScannerSelfCheck();
	record(exitPins(REMOTE_SCRIPTS));
	await mutants();
})()
	.catch(crash)
	.finally(finish);
