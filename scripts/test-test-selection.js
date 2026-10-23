#!/usr/bin/env node
/**
 * Pins how the pre-push hook picks and runs "the runners this push needs":
 * scripts/lib/test-selection.js, and run-unit-tests.js's pre-push mode.
 *
 *   §1 a changed runner picks itself (tier 0); a timing-sensitive runner a
 *      change reaches runs in tier 0
 *   §2 a lib file picks every runner that requires it, directly or through
 *      another lib, and none that doesn't; a scripts/lib helper picks only
 *      its users (D3); a deleted file picks the runners that still name it
 *   §3 a file a runner names in a string literal picks it, any file type:
 *      a .vue by full path and through path.join, a .json fixture, an .html
 *      and a .sh; a code file named without its extension; an SFC named by a
 *      client module an .mjs runner imports. A different .vue, or a plain
 *      word that happens to be a file name, picks nothing
 *   §4 server.js by piece: a change inside a function picks the runners that
 *      lift it and those whose lifted code calls it, and no others; a comment
 *      line above a function counts as that function; a route change picks
 *      the runners naming its path; a lifted `const x = require("./lib/x")`
 *      ties lib/x to the runner; a name the runner provides itself is not
 *      followed
 *   §5 a top-level statement, or a removed declaration, picks every runner
 *      that names server.js (tier 3)
 *   §6 each run-all file picks every runner
 *   §7 a file no runner reaches picks none; a folder scanner runs for a
 *      change in its folder and not elsewhere, and on any change when its
 *      folder can't be read
 *   §8 the budget: tier order and shortest first; a runner whose estimate
 *      doesn't fit is "not run", never passed; a cut-off is not a failure;
 *      tier 0 finishes past the deadline while a tier-3 runner behind it is
 *      not run; the summary and verdict lines; the worker count
 *   §9 the real tree: the map builds, every runner reaches another file or a
 *      folder (apart from the self-contained ones named below), and the
 *      runners that read .vue files reach theirs
 *   §10 run-unit-tests.js's pre-push mode, run for real in a fixture repo:
 *      the verdict line is last and the exit code agrees; lint failing, a
 *      missing or short changed list, a throwing selector, an unknown flag
 *      or a failing runner each fail it; an unreadable times cache is only a
 *      note; --full runs everything; tier 0 finishes past the budget; a
 *      platform skip is reported as SKIP; --list is unchanged
 *   mutants of the selector, each caught above: the closure walk dropped,
 *      the comment rule dropped, scripts/lib helpers unmapped, text edges
 *      limited to code files
 *
 * Hermetic: §1-§8 build trees in memory; §9 reads the repo; §10 works in a
 * mkdtemp git repository with its own TMPDIR. No network.
 * Run: node scripts/test-test-selection.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SELECTION = path.join(__dirname, "lib", "test-selection.js");
const SELECTION_SRC = fs.readFileSync(SELECTION, "utf8");

const failures = [];
let pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

function load(code) {
	const m = { exports: {} };
	new Function("module", "exports", "require", "__filename", "__dirname", code)(m, m.exports, Module.createRequire(SELECTION), SELECTION, path.dirname(SELECTION));
	return m.exports;
}

// ── The fixture tree.
const SERVER = [
	'"use strict";',
	'const express = require("express");',
	'const { helperX } = require("./lib/x");',
	"const app = express();",
	"",
	"// Totals for a week.",
	"function weekTotal(rows) {",
	"\treturn rows.reduce((a, r) => a + r.n, 0);",
	"}",
	"",
	"function report(rows) {",
	"\treturn `total ${weekTotal(rows)}`;",
	"}",
	"",
	"function unrelated() {",
	"\treturn helperX(1);",
	"}",
	"",
	'app.get("/api/report/week", (req, res) => {',
	"\tres.json({ t: report([]) });",
	"});",
	"",
	"app.use(express.json());",
	"",
].join("\n");
const LINE = (text) => SERVER.split("\n").indexOf(text) + 1;
const lift = (roots, extra = "") => `const fs = require("fs");\nconst path = require("path");\nconst { closure } = require("./lib/server-lift");\nconst src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");\nclosure(src, { roots: ${JSON.stringify(roots)}${extra} });\n`;
const TREE = {
	"server.js": SERVER,
	"package.json": "{}\n",
	"lib/x.js": "exports.helperX = (n) => n;\n",
	"lib/a.js": 'module.exports = require("./b");\n',
	"lib/b.js": "module.exports = 1;\n",
	"lib/c.js": "module.exports = 2;\n",
	"lib/pdf.js": "module.exports = 3;\n",
	"lib/driver-availability.js": "module.exports = 4;\n",
	"lib/driver.js": "module.exports = 5;\n",
	"scripts/lib/server-lift.js": "module.exports = {};\n",
	"scripts/lib/world.js": "module.exports = {};\n",
	"scripts/test-week.js": lift(["weekTotal"]),
	"scripts/test-report.js": lift(["report"]),
	"scripts/test-unrelated.js": lift(["unrelated"]),
	"scripts/test-provided.js": lift(["report"], ', provided: ["weekTotal"]'),
	"scripts/test-route.js": `const fs = require("fs");\nconst path = require("path");\nconst { liftRoute } = require("./lib/server-lift");\nconst src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");\nliftRoute(src, 'app.get("/api/report/week", (req, res) => {');\n`,
	"scripts/test-a.js": 'require("../lib/a");\n',
	"scripts/test-c.js": 'require("../lib/c");\n',
	"scripts/test-helper.js": 'require("./lib/world");\n',
	"scripts/test-gone.js": 'require("../lib/gone");\n',
	"scripts/test-pdf-cold-start.js": 'require("../lib/pdf");\n',
	"client/src/components/x/Widget.vue": "<template><div/></template>\n",
	"client/src/components/x/Other.vue": "<template><div/></template>\n",
	"client/src/views/PanelView.vue": "<template><div/></template>\n",
	"client/src/lib/panel.js": 'export const VIEW = "PanelView.vue";\n',
	"scripts/test-widget-a.js": 'const fs = require("fs");\nfs.readFileSync("client/src/components/x/Widget.vue", "utf8");\n',
	"scripts/test-widget-b.js": 'const path = require("path");\nconst ROOT = path.join(__dirname, "..");\npath.join(ROOT, "client", "src", "components", "x", "Widget.vue");\n',
	"scripts/fixtures/sample-rates.json": "{}\n",
	"scripts/test-json.js": 'const path = require("path");\nrequire(path.join(__dirname, "fixtures", "sample-rates.json"));\n',
	"onboarding-templates/welcome-letter.html": "<p>hi</p>\n",
	"scripts/test-html.js": 'const path = require("path");\npath.join(__dirname, "..", "onboarding-templates", "welcome-letter.html");\n',
	"scripts/deploy/do-thing.sh": "#!/bin/sh\n",
	"scripts/test-sh.js": 'const p = "scripts/deploy/do-thing.sh";\n',
	"scripts/test-stem.js": 'const path = require("path");\nrequire(path.join(__dirname, "..", "lib", "driver-availability"));\n',
	"scripts/test-word.js": 'const role = "driver";\n',
	"scripts/test-client.mjs": 'import { VIEW } from "../client/src/lib/panel.js";\nconsole.log(VIEW);\n',
	"docs/notes.md": "notes\n",
	"docs/n8n/flow.json": "{}\n",
	"scripts/test-scan.js": 'const fs = require("fs");\nconst path = require("path");\nconst ROOT = path.join(__dirname, "..");\nfs.readdirSync(path.join(ROOT, "docs", "n8n"));\n',
};
const buildFrom = (sel, tree) => sel.buildMap({ files: Object.keys(tree), read: (f) => (f in tree ? tree[f] : null) });
const S = (name) => `scripts/${name}`;
const hunk = (line, from, to) => `@@ -${line} +${line} @@\n-${from}\n+${to}\n`;
const TIER0 = [S("test-pdf-cold-start.js")];

function checks(sel, tag = "") {
	const r = [];
	const map = buildFrom(sel, TREE);
	const pick = (changed, serverDiff = "") => sel.select(map, { changed, serverDiff, tierZero: TIER0 }).picked;
	const names = (p) => [...p.keys()].sort().join(",");
	const same = (p, want) => names(p) === [...want].map(S).sort().join(",");

	// §1
	const self = pick([S("test-c.js")]);
	r.push([same(self, ["test-c.js"]) && self.get(S("test-c.js")) === 0, `${tag}§1 a changed runner picks itself, tier 0 (got ${names(self)})`]);
	const pdf = pick(["lib/pdf.js"]);
	r.push([pdf.get(S("test-pdf-cold-start.js")) === 0, `${tag}§1 the timing-sensitive runner a change reaches runs in tier 0 (got ${pdf.get(S("test-pdf-cold-start.js"))})`]);

	// §2
	const viaLib = pick(["lib/b.js"]);
	r.push([same(viaLib, ["test-a.js"]) && viaLib.get(S("test-a.js")) === 1, `${tag}§2 a lib file picks the runner that requires it through another lib, tier 1, and nothing else (got ${names(viaLib)})`]);
	r.push([same(pick(["lib/a.js"]), ["test-a.js"]), `${tag}§2 …and the one that requires it directly`]);
	const helper = pick(["scripts/lib/world.js"]);
	r.push([same(helper, ["test-helper.js"]), `${tag}§2 a scripts/lib helper picks only the runners that require it (D3) (got ${names(helper)})`]);
	r.push([same(pick(["lib/gone.js"]), ["test-gone.js"]), `${tag}§2 a deleted file picks the runner that still requires it (got ${names(pick(["lib/gone.js"]))})`]);

	// §3
	const widget = pick(["client/src/components/x/Widget.vue"]);
	r.push([same(widget, ["test-widget-a.js", "test-widget-b.js"]), `${tag}§3 a .vue named by full path and through path.join picks both runners (got ${names(widget)})`]);
	r.push([pick(["client/src/components/x/Other.vue"]).size === 0, `${tag}§3 …and a different .vue picks none`]);
	r.push([same(pick(["scripts/fixtures/sample-rates.json"]), ["test-json.js"]), `${tag}§3 a .json fixture picks the runner that reads it (got ${names(pick(["scripts/fixtures/sample-rates.json"]))})`]);
	r.push([same(pick(["onboarding-templates/welcome-letter.html"]), ["test-html.js"]), `${tag}§3 an .html picks the runner naming it`]);
	r.push([same(pick(["scripts/deploy/do-thing.sh"]), ["test-sh.js"]), `${tag}§3 a .sh picks the runner naming it`]);
	r.push([same(pick(["lib/driver-availability.js"]), ["test-stem.js"]), `${tag}§3 a code file required through path.join without its extension picks the runner (got ${names(pick(["lib/driver-availability.js"]))})`]);
	r.push([pick(["lib/driver.js"]).size === 0, `${tag}§3 a plain word that is also a file's name picks nothing (got ${names(pick(["lib/driver.js"]))})`]);
	r.push([same(pick(["client/src/views/PanelView.vue"]), ["test-client.mjs"]), `${tag}§3 an SFC named by a client module an .mjs runner imports picks it (got ${names(pick(["client/src/views/PanelView.vue"]))})`]);

	// §4
	const body = LINE("\treturn rows.reduce((a, r) => a + r.n, 0);");
	const inFn = pick(["server.js"], hunk(body, "\treturn 0;", "\treturn rows.reduce((a, r) => a + r.n, 0);"));
	r.push([same(inFn, ["test-week.js", "test-report.js", "test-route.js"]) && [...inFn.values()].every((t) => t === 2),
		`${tag}§4 a change inside weekTotal picks the runners that lift it or call it (week, report, route), tier 2, and no others (got ${names(inFn)})`]);
	const comment = LINE("// Totals for a week.");
	const cm = pick(["server.js"], hunk(comment, "// Totals.", "// Totals for a week."));
	r.push([same(cm, ["test-week.js", "test-report.js", "test-route.js"]), `${tag}§4 a comment line above weekTotal counts as weekTotal (got ${names(cm)})`]);
	const routeBody = LINE("\tres.json({ t: report([]) });");
	const rt = pick(["server.js"], hunk(routeBody, "\tres.json({});", "\tres.json({ t: report([]) });"));
	r.push([same(rt, ["test-route.js"]), `${tag}§4 a change inside a route picks the runner naming its path (got ${names(rt)})`]);
	r.push([same(pick(["lib/x.js"]), ["test-unrelated.js"]), `${tag}§4 a lifted const x = require("./lib/x") ties lib/x to the runner lifting it (got ${names(pick(["lib/x.js"]))})`]);
	r.push([!inFn.has(S("test-provided.js")), `${tag}§4 a name the runner provides itself is not followed`]);

	// §5
	const top = pick(["server.js"], hunk(LINE("app.use(express.json());"), "app.use(x);", "app.use(express.json());"));
	r.push([same(top, ["test-week.js", "test-report.js", "test-unrelated.js", "test-provided.js", "test-route.js"]) && [...top.values()].every((t) => t === 3),
		`${tag}§5 a top-level statement picks every runner that names server.js, tier 3 (got ${names(top)})`]);
	const removed = pick(["server.js"], `@@ -15,3 +14,0 @@\n-function gone() {\n-\treturn 1;\n-}\n`);
	r.push([removed.size === 5, `${tag}§5 a removed declaration picks every runner that names server.js (got ${names(removed)})`]);

	// §6
	for (const f of ["scripts/run-unit-tests.js", "scripts/lib/test-selection.js", "package.json", "package-lock.json", "client/package.json", "client/package-lock.json", ".nvmrc", ".githooks/pre-push"]) {
		r.push([pick([f]).size === map.runners.length, `${tag}§6 ${f} picks every runner (${pick([f]).size} of ${map.runners.length})`]);
	}

	// §7
	r.push([pick(["docs/notes.md"]).size === 0, `${tag}§7 a file no runner reaches picks none (got ${names(pick(["docs/notes.md"]))})`]);
	const scan = pick(["docs/n8n/flow.json"]);
	r.push([same(scan, ["test-scan.js"]) && scan.get(S("test-scan.js")) === 3, `${tag}§7 a scanner runs, tier 3, for a change in the folder it reads (got ${names(scan)})`]);
	const dyn = buildFrom(sel, { ...TREE, "scripts/test-scan-dyn.js": 'const fs = require("fs");\nconst dir = process.argv[2];\nfs.readdirSync(dir);\n' });
	r.push([sel.select(dyn, { changed: ["docs/notes.md"] }).picked.get(S("test-scan-dyn.js")) === 3, `${tag}§7 a scanner whose folder can't be read runs, tier 3, on any change`]);
	r.push([sel.select(dyn, { changed: [] }).picked.size === 0, `${tag}§7 …and nothing runs when nothing changed`]);
	return r;
}

// §8 the budget, with fake runners on real timers.
function fakeStart(plan, log) {
	return (file) => {
		const p = plan[file];
		log.push(file);
		let resolve;
		const done = new Promise((res) => (resolve = res));
		const started = Date.now();
		const t = setTimeout(() => resolve({ ok: !p.fail, ms: Date.now() - started, out: "" }), p.ms);
		return { done, kill: () => { clearTimeout(t); resolve({ ok: false, ms: Date.now() - started, out: "", code: "signal:SIGKILL" }); } };
	};
}
async function budgetChecks(sel) {
	const r = [];
	const ord = sel.order([{ file: "b", tier: 1, est: 50 }, { file: "a", tier: 0, est: 900 }, { file: "c", tier: 1, est: 10 }, { file: "d", tier: 3, est: 1 }]).map((x) => x.file).join("");
	r.push([ord === "acbd", `§8 tier order, shortest first within a tier (got ${ord})`]);

	let log = [];
	let run = await sel.runTiered({
		items: [{ file: "fast", tier: 1, est: 100 }, { file: "big", tier: 1, est: 5000 }, { file: "small", tier: 3, est: 50 }],
		workers: 1, budgetMs: 1000, start: fakeStart({ fast: { ms: 100 }, big: { ms: 10 }, small: { ms: 50 } }, log),
	});
	r.push([log.join(",") === "fast,small" && run.notRun.map((x) => x.file).join() === "big" && !run.results.some((x) => x.file === "big"),
		`§8 a runner whose estimate doesn't fit is not run, never passed, and a later one that fits still runs (started ${log}, not run ${run.notRun.map((x) => x.file)})`]);

	log = [];
	run = await sel.runTiered({ items: [{ file: "hang", tier: 2, est: 10 }], workers: 2, budgetMs: 300, start: fakeStart({ hang: { ms: 5000 } }, log) });
	let t = sel.tally(run);
	r.push([run.cut.length === 1 && t.cut === 1 && t.failed === 0 && t.passed, `§8 a runner still going at the budget is cut off, and a cut-off is not a failure (cut ${t.cut}, failed ${t.failed})`]);

	log = [];
	run = await sel.runTiered({
		items: [{ file: "zero", tier: 0, est: 10 }, { file: "three", tier: 3, est: 10 }],
		workers: 1, budgetMs: 300, start: fakeStart({ zero: { ms: 700 }, three: { ms: 10 } }, log),
	});
	const zero = run.results.find((x) => x.file === "zero");
	r.push([zero && zero.ok && !zero.cut && run.notRun.map((x) => x.file).join() === "three",
		`§8 tier 0 finishes past the deadline and the tier-3 runner behind it is not run (zero ${zero && zero.ok}, not run ${run.notRun.map((x) => x.file)})`]);

	run = await sel.runTiered({ items: [{ file: "bad", tier: 1, est: 10 }], workers: 1, budgetMs: 5000, start: fakeStart({ bad: { ms: 10, fail: true } }, []) });
	t = sel.tally(run);
	r.push([t.failed === 1 && !t.passed, `§8 a runner that ran and failed fails the run (failed ${t.failed})`]);

	log = [];
	await sel.runTiered({
		items: [{ file: "pool", tier: 0, est: 1 }, { file: "timing", tier: 0, est: 50 }],
		workers: 4, budgetMs: 5000, alone: new Set(["timing"]), start: fakeStart({ pool: { ms: 10 }, timing: { ms: 30 } }, log),
	});
	r.push([log.join(",") === "timing,pool", `§8 a timing-sensitive runner runs alone before the pool (started ${log})`]);

	let calls = 0;
	run = await sel.runTiered({
		items: [{ file: "flaky", tier: 0, est: 1 }], workers: 1, budgetMs: 5000, retryOnce: new Set(["flaky"]),
		start: () => { calls++; return { done: Promise.resolve({ ok: calls > 1, ms: 1, out: "" }), kill() {} }; },
	});
	r.push([run.results[0].ok && run.results[0].retried && calls === 2, "§8 a runner on the retry list gets one retry, reported as retried"]);

	const line = sel.summaryLine({ ran: 3, picked: 5, seconds: 1.25, notRun: 1, cut: 1, failed: 0 });
	r.push([line === "Ran 3 of 5 picked runners in 1.3 s; 1 not run for time, 1 cut off (CI runs them). Full suite: npm run check.", `§8 the summary line names the counts (got ${line})`]);
	r.push([sel.summaryLine({ ran: 2, picked: 2, seconds: 2, notRun: 0, cut: 0, failed: 0 }) === "Ran 2 of 2 picked runners in 2.0 s; 0 not run for time (CI runs them). Full suite: npm run check.", "§8 …in the plan's words when nothing was cut"]);
	r.push([sel.verdictLine({ lint: "pass", selection: "pass", runners: "pass" }) === "pre-push verdict: lint=pass selection=pass runners=pass", "§8 the verdict line"]);
	const w = [sel.workersFor(15, 2.7), sel.workersFor(15, 20), sel.workersFor(4, 0), sel.workersFor(2, 0), sel.workersFor(15, NaN)].join(",");
	r.push([w === "11,2,3,1,14", `§8 workers: cores less one, less the load, at least 2, never more than cores less one (got ${w})`]);
	return r;
}

// §9 the real tree.
const SELF_CONTAINED = new Set(["scripts/test-google-timeout-retry.js"]);
const VUE_EDGES = {
	"test-invoice-fields-client.mjs": ["InvoiceDraftPreviewModal.vue", "CompletedLoadsTab.vue"],
	"test-driver-instructions-client.mjs": ["ActiveLoadsTab.vue", "JobBoardTab.vue", "DriverInstructionsSection.vue", "DriverInstructionsPayload.vue"],
	"test-payout-due-client.mjs": ["PayoutsSection.vue", "PayoutsView.vue"],
	"test-w9-input-checks.js": ["InvestorApplyView.vue"],
	"test-broker-column-redaction.js": ["ActiveLoadsTab.vue"],
	"test-investor-accept-vehicles.js": ["InvestorApplicationsView.vue"],
	"test-routemate-vehicle-sync.js": ["AdminToolsView.vue"],
	"test-driver-header-fuel-range.mjs": ["DriverHeader.vue"],
};
function realTreeChecks(sel) {
	const r = [];
	const ls = spawnSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
	if (ls.status !== 0) return [[`§9 git ls-files in the repo (exit ${ls.status})`, false]];
	const started = Date.now();
	const map = sel.buildMap({ files: ls.stdout.split("\0").filter(Boolean), read: (f) => { try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { return null; } } });
	const ms = Date.now() - started;
	r.push([map.runners.length > 300 && map.server && map.server.model.regions.length > 1000, `§9 the map builds on the real tree (${map.runners.length} runners, ${map.server ? map.server.model.regions.length : 0} server.js pieces, ${ms} ms)`]);
	const lonely = map.runners.filter((x) => map.reach.get(x).size <= 1 && !map.serverRunners.has(x) && !(map.scanners.has(x) && map.scanners.get(x).dirs.size) && !SELF_CONTAINED.has(x));
	r.push([lonely.length === 0, `§9 every runner reaches another file or a folder, apart from the self-contained ones (reach nothing: ${lonely.join(", ")})`]);
	for (const [runner, vues] of Object.entries(VUE_EDGES)) {
		const reach = map.reach.get(S(runner));
		const missing = reach ? vues.filter((v) => ![...reach].some((f) => f.endsWith(`/${v}`))) : vues;
		r.push([missing.length === 0, `§9 ${runner} reaches ${vues.join(", ")} (missing ${missing.join(", ")})`]);
	}
	return r;
}

// §10 the harness, for real, in a fixture repository.
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-selection-")));
process.on("exit", () => fs.rmSync(T, { recursive: true, force: true }));
const GIT_ENV = {
	...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && !k.startsWith("UNIT_TEST_"))),
	GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(T, "gitconfig"), GIT_CEILING_DIRECTORIES: T,
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
fs.writeFileSync(path.join(T, "gitconfig"), "");
let fixtureN = 0;
function harnessFixture(runners, { selection = SELECTION_SRC, extra = {} } = {}) {
	const dir = path.join(T, `repo-${++fixtureN}`);
	const files = {
		"package.json": JSON.stringify({ scripts: { lint: "git ls-files -z -c -o --exclude-standard -- 'lib/*.js' 'scripts/*.js' | xargs -0 -r -n 1 -P 8 node --check --" } }),
		"scripts/run-unit-tests.js": fs.readFileSync(path.join(__dirname, "run-unit-tests.js"), "utf8"),
		"scripts/lib/test-selection.js": selection,
		"scripts/lib/server-lift.js": fs.readFileSync(path.join(__dirname, "lib", "server-lift.js"), "utf8"),
		"lib/ok.js": "module.exports = 1;\n",
		...runners,
		...extra,
	};
	for (const [f, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
		fs.writeFileSync(path.join(dir, f), text);
	}
	spawnSync("git", ["init", "-q", dir], { env: GIT_ENV });
	spawnSync("git", ["add", "."], { cwd: dir, env: GIT_ENV });
	const tmp = path.join(dir, "..", `tmp-${fixtureN}`);
	fs.mkdirSync(tmp);
	return { dir, tmp };
}
function harness(fx, args, env = {}) {
	const r = spawnSync(process.execPath, [path.join(fx.dir, "scripts/run-unit-tests.js"), ...args], {
		cwd: fx.dir, encoding: "utf8", timeout: 60000, env: { ...GIT_ENV, TMPDIR: fx.tmp, ...env },
	});
	const out = `${r.stdout || ""}${r.stderr || ""}`;
	return { code: r.status, out, last: out.trimEnd().split("\n").pop() };
}
function listFile(fx, files) {
	const p = path.join(fx.tmp, `list-${Math.random().toString(36).slice(2)}`);
	fs.writeFileSync(p, files.map((f) => `${f}\0`).join(""));
	return p;
}
const PASS = "pre-push verdict: lint=pass selection=pass runners=pass";
const RUNNERS = {
	"scripts/test-pass.js": "process.exitCode = 0;\n",
	"scripts/test-also.js": "process.exitCode = 0;\n",
};
function harnessChecks() {
	const r = [];
	const pre = (fx, changed, more = [], env = {}) => harness(fx, ["--lint", "--changed-list", listFile(fx, changed), "--changed-count", String(changed.length), "--budget-ms", "20000", ...more], env);

	const fx = harnessFixture(RUNNERS);
	const good = pre(fx, ["scripts/test-pass.js"]);
	r.push([good.code === 0 && good.last === PASS && /Ran 1 of 1 picked runners/.test(good.out), `§10 a passing push ends on the PASS verdict with exit 0 (exit ${good.code}, last ${JSON.stringify(good.last)})`]);
	r.push([/lint: passed/.test(good.out) && /ok\s+\d+ms\s+test-pass\.js/.test(good.out) && !/test-also\.js/.test(good.out), "§10 …after lint, running only the picked runner"]);
	r.push([fs.readdirSync(fx.tmp).some((f) => /^logisx-prepush-times-.*\.json$/.test(f)), "§10 …and saves the runners' times in TMPDIR"]);

	const cache = fs.readdirSync(fx.tmp).find((f) => /^logisx-prepush-times-.*\.json$/.test(f));
	if (cache) fs.writeFileSync(path.join(fx.tmp, cache), "{not json");
	const garbled = pre(fx, ["scripts/test-pass.js"]);
	r.push([garbled.code === 0 && garbled.last === PASS && /note: times cache unreadable/.test(garbled.out), `§10 an unreadable times cache is a note, never a failure (exit ${garbled.code})`]);

	const missing = harness(fx, ["--lint", "--changed-list", path.join(fx.tmp, "nope"), "--changed-count", "1"]);
	r.push([missing.code === 1 && missing.last === "pre-push verdict: lint=pass selection=fail runners=skipped", `§10 a missing changed list fails selection (exit ${missing.code}, last ${JSON.stringify(missing.last)})`]);
	const short = harness(fx, ["--lint", "--changed-list", listFile(fx, []), "--changed-count", "2"]);
	r.push([short.code === 1 && /selection=fail/.test(short.last) && /holds 0 file\(s\), the hook wrote 2/.test(short.out), `§10 an empty list when the hook wrote two fails selection (exit ${short.code})`]);
	const unknown = harness(fx, ["--lint", "--changed-list", listFile(fx, []), "--changed-count", "0", "--no-sandbox"]);
	r.push([unknown.code === 1 && /selection=fail/.test(unknown.last) && /unknown argument/.test(unknown.out), `§10 an unknown flag fails (exit ${unknown.code})`]);

	const thrower = harnessFixture(RUNNERS, { selection: SELECTION_SRC.replace("function buildMap({ files, read }) {", 'function buildMap({ files, read }) {\n\tthrow new Error("selector boom");') });
	const thrown = pre(thrower, ["scripts/test-pass.js"]);
	r.push([thrown.code === 1 && thrown.last === "pre-push verdict: lint=pass selection=fail runners=skipped" && /selector boom/.test(thrown.out), `§10 a throwing selector fails selection (exit ${thrown.code}, last ${JSON.stringify(thrown.last)})`]);

	const linty = harnessFixture(RUNNERS, { extra: { "lib/broken.js": "module.exports = (;\n" } });
	const lint = pre(linty, ["scripts/test-pass.js"]);
	r.push([lint.code === 1 && lint.last === "pre-push verdict: lint=fail selection=skipped runners=skipped" && !/test-pass\.js/.test(lint.out.split("lint: FAILED")[1] || ""),
		`§10 lint failing blocks before any runner starts (exit ${lint.code}, last ${JSON.stringify(lint.last)})`]);

	const failing = harnessFixture({ ...RUNNERS, "scripts/test-fail.js": 'console.log("boom");\nprocess.exitCode = 1;\n' });
	const failed = pre(failing, ["scripts/test-fail.js"]);
	r.push([failed.code === 1 && failed.last === "pre-push verdict: lint=pass selection=pass runners=fail" && /FAILURE OUTPUT/.test(failed.out), `§10 a failing picked runner fails the run (exit ${failed.code})`]);

	const full = harness(fx, ["--lint", "--full"]);
	r.push([full.code === 0 && full.last === PASS && /test-pass\.js/.test(full.out) && /test-also\.js/.test(full.out), `§10 --full runs every runner (exit ${full.code})`]);

	const slow = harnessFixture({ ...RUNNERS, "scripts/test-slow.js": "setTimeout(() => {}, 1200);\n" });
	const tier = harness(slow, ["--lint", "--changed-list", listFile(slow, ["scripts/test-slow.js", "package.json"]), "--changed-count", "2", "--budget-ms", "400"], { UNIT_TEST_CONCURRENCY: "1" });
	r.push([tier.code === 0 && tier.last === PASS && /ok\s+\d+ms\s+test-slow\.js/.test(tier.out) && /Not run for time \(CI runs them\): .*test-(also|pass)\.js/.test(tier.out),
		`§10 tier 0 finishes past the budget and the rest is listed not run for time (exit ${tier.code}): ${tier.out.slice(-300)}`]);

	const skipper = harnessFixture({ "scripts/test-prepush-sandbox.js": 'console.log("SKIP (platform): not here");\n' });
	const skipped = harness(skipper, []);
	r.push([skipped.code === 0 && /^SKIP\s+\d+ms\s+test-prepush-sandbox\.js/m.test(skipped.out) && /skipped themselves on this machine, NOT covered/.test(skipped.out),
		`§10 a platform skip reads SKIP and is repeated after the summary (exit ${skipped.code})`]);

	const list = harness(fx, ["--list"]);
	r.push([list.code === 0 && list.out === "test-also.js\ntest-pass.js\n", `§10 --list is unchanged (got ${JSON.stringify(list.out)})`]);
	return r;
}

(async () => {
	try {
		const sel = load(SELECTION_SRC);
		for (const [c, m] of checks(sel)) ok(c, m);
		for (const [c, m] of await budgetChecks(sel)) ok(c, m);
		for (const [c, m] of realTreeChecks(sel)) ok(c, m);
		for (const [c, m] of harnessChecks()) ok(c, m);

		// Mutants: each must change the source and be caught by §2-§4.
		for (const [name, from, to] of [
			["the closure walk dropped", "while (q.length) for (const k of model.deps[q.shift()]) if (!world.has(k) && !providedIds.has(k)) (world.add(k), q.push(k));", ""],
			["the comment rule dropped", "while (k <= lines.length && owner[k] === -1 && quiet(k)) k++;", ""],
			["scripts/lib helpers unmapped", "const next = [...e.code];", 'const next = [...e.code].filter((n) => !n.startsWith("scripts/lib/"));'],
			["text edges limited to code files", "if (ownSide || f.startsWith(\"client/\")) next.push(...e.text);", "if (ownSide || f.startsWith(\"client/\")) next.push(...[...e.text].filter((t) => CODE_RE.test(t)));"],
		]) {
			const code = SELECTION_SRC.split(from).join(to);
			ok(code !== SELECTION_SRC, `mutant '${name}' must change test-selection.js`);
			let caught = true;
			try { caught = checks(load(code), "[mutant] ").some(([c]) => !c); } catch { caught = true; }
			ok(caught, `mutant '${name}' must be caught`);
		}
	} catch (e) {
		failures.push(`crashed: ${e.stack || e}`);
	}
	console.log(`${pass} passed, ${failures.length} failed`);
	if (failures.length) {
		console.log("\nFailures:");
		for (const f of failures) console.log(`  - ${f}`);
		process.exitCode = 1;
	}
})();
