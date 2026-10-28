#!/usr/bin/env node
/**
 * scripts/test-route-snapshot.js: every request path the app answers, what runs
 * in front of each, in what order, and what importing the server starts.
 *
 * It imports server.js in a child (scripts/lib/route-snapshot-child.js) with
 * LOGISX_IMPORT_ONLY=1 and a scrubbed environment (PATH plus the made-up values
 * in scripts/fixtures/route-snapshot-import.json; the database, temp and home
 * folders inside a fresh scratch folder that is also the working folder, so no
 * settings file loads), with recorders that keep the import from listening,
 * scheduling, connecting or writing outside that folder. The child walks the
 * app's Express 4 stack and traces every layer to the call that registered it.
 * The result is compared with scripts/fixtures/route-snapshot.txt.
 *
 *   §1 the import: the child ran, found one app and Express's own first layers.
 *   §2 runtime and source agree: every layer came from an app registration
 *      call; each one in server.js is a column-0 `app.<method>(` line and every
 *      such line ran; the handlers as written match the handlers registered in
 *      number (a spread or an array takes the rest), and an inline handler's
 *      text is the registered function's text. Registrations from lib/ files
 *      are shown by runtime name only, marked "(lib mount)".
 *   §3 middleware that sees every path (no mount path, or a "*" route) sits
 *      before every route it can meet, or after all of them.
 *   §4 importing starts nothing: require() returns { app, server, io } (the
 *      app and server the import built), and every recorded side effect is on
 *      the fixture JSON's importAllowlist: no listener, signal handler, job
 *      timer, connection, process launch or outside write. Every allowlist
 *      entry must still be needed.
 *   §5 an import is refused without DATABASE_PATH (before any database opens)
 *      and with NODE_ENV=production. Both run on a scratch copy of server.js,
 *      so an older copy that ignores the flag opens a scratch database only.
 *   §6 the fixture matches.
 *
 * The fixture, one line per registration:
 *   [routes] routes and path-scoped middleware, sorted by path then method, so
 *     a regroup leaves it unchanged and parallel additions merge:
 *       METHOD path · handler · handler … | after: earlier registrations that
 *       can match the same request
 *     A handler reads `as written=runtime name@fingerprint`: the runtime name
 *     only when it differs, the fingerprint (12 hex of the sha256 of the text,
 *     comments dropped, whitespace collapsed) only for app code, i.e. a function
 *     whose text is in server.js or a lib/ file, so a dependency bump does not
 *     change the file. An inline handler reads `inline@fingerprint`; a rate
 *     limiter's runtime name is "limiter".
 *     Overlap (Express 4, path-to-regexp 0.1): same number of segments, each
 *     pair equal ignoring case or either a ":param"; a "*" (or a regex path)
 *     meets everything; middleware meets by prefix; a GET route also answers
 *     HEAD; static files answer only GET and HEAD.
 *   [middleware] middleware that sees every path, in registration order, with
 *     "first" (no route or path-scoped middleware it meets comes before it),
 *     "last" (none comes after it) or the path-scoped middleware before it.
 *   [import] what the import started or tried to start, in order, each with
 *     the code that asked: a package, a function, or the calling line's text.
 *     A package's timers are listed once per kind, with no delay or count (a
 *     rate limiter's store starts one per limiter): they say nothing of the app.
 *
 *   --update        rewrite the fixture (only when §1-§5 pass).
 *   --print-order   print the registrations in stack order, with their lines.
 *   SERVER_JS=<file> import another copy of server.js (its lib/ folder and
 *                   node_modules beside it), e.g. a base copy, to see it fail.
 *
 * Starts no server and touches no network; the import writes only its scratch
 * folder. Run: node scripts/test-route-snapshot.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TARGET = path.resolve(process.env.SERVER_JS || path.join(ROOT, "server.js"));
const BASE = path.dirname(TARGET);
const LIB = path.join(BASE, "lib");
const CHILD = path.join(__dirname, "lib", "route-snapshot-child.js");
const FIXTURE = path.join(__dirname, "fixtures", "route-snapshot.txt");
const IMPORT_SETUP = path.join(__dirname, "fixtures", "route-snapshot-import.json");
const UPDATE = process.argv.includes("--update");
const PRINT_ORDER = process.argv.includes("--print-order");

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}${detail === undefined ? "" : `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
function fatal(msg) { console.error(`FAIL  ${msg}`); process.exit(1); }
const section = (title) => console.log(`\n§ ${title}`);

// --- the import, in a child ------------------------------------------------------
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "route-snapshot-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
const setup = JSON.parse(fs.readFileSync(IMPORT_SETUP, "utf8"));
const libFiles = fs.readdirSync(LIB).filter((f) => f.endsWith(".js")).sort().map((f) => path.join(LIB, f));

// One import of `target` in its own run folder; `changes` sets (or, with
// undefined, removes) variables, and `settingsFile` is written as that folder's
// .env, the file dotenv reads from the working folder.
function importServer(target, changes = {}, settingsFile = null) {
	const dir = fs.mkdtempSync(path.join(scratch, "run-"));
	for (const d of ["tmp", "home"]) fs.mkdirSync(path.join(dir, d));
	if (settingsFile !== null) fs.writeFileSync(path.join(dir, ".env"), settingsFile(dir));
	const inputFile = path.join(dir, "input.json");
	const reportFile = path.join(dir, "report.json");
	fs.writeFileSync(inputFile, JSON.stringify({ server: target, sources: [target, ...libFiles], out: reportFile }));
	const env = {
		PATH: process.env.PATH || "/usr/bin:/bin",
		...setup.env,
		LOGISX_IMPORT_ONLY: "1",
		DATABASE_PATH: path.join(dir, "import.db"),
		TMPDIR: path.join(dir, "tmp"),
		HOME: path.join(dir, "home"),
		...changes,
	};
	for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
	const run = spawnSync(process.execPath, [CHILD, inputFile], { cwd: dir, env, encoding: "utf8", timeout: 50000, maxBuffer: 64 * 1024 * 1024 });
	const output = `${run.stdout || ""}${run.stderr || ""}`.trim().split("\n").slice(-30).join("\n");
	let report = null;
	try { report = JSON.parse(fs.readFileSync(reportFile, "utf8")); } catch { /* the caller reports it */ }
	return { run, report, output };
}
// server.js copied into a scratch folder, with lib/ and node_modules linked
// beside it: its own folder is the scratch one.
function scratchCopy() {
	const dir = fs.mkdtempSync(path.join(scratch, "copy-"));
	fs.copyFileSync(TARGET, path.join(dir, "server.js"));
	fs.symlinkSync(LIB, path.join(dir, "lib"));
	fs.symlinkSync(path.join(BASE, "node_modules"), path.join(dir, "node_modules"));
	return path.join(dir, "server.js");
}

const { run, report, output: childOutput } = importServer(TARGET);

section("1. the import");
if (!report) fatal(`the child wrote no report (exit ${run.status}${run.signal ? `, ${run.signal}` : ""}${run.error ? `, ${run.error.message}` : ""}). Its last output:\n${childOutput}`);
if (report.error) fatal(`${report.error}. The child's last output:\n${childOutput}`);
ok("the child imported the server and exited 0", run.status === 0, `exit ${run.status}`);
ok("Express 4 (the walker reads its router)", /^4\./.test(report.express), report.express);
ok("registrations found", report.entries.length > 0, report.entries.length);

const entries = report.entries;
if (PRINT_ORDER) {
	console.log("");
	for (const e of entries) console.log(`${String(e.order).padStart(4)}  ${e.label}  [${e.where}]  ${e.chain.join(" · ")}`);
	process.exit(failed ? 1 : 0);
}

section("2. runtime and source agree");
ok("every layer traced to the source that registered it", report.problems.length === 0, `${report.problems.length} problem(s)`);
for (const p of report.problems.slice(0, 40)) console.log(`      ${p}`);

// --- overlap ---------------------------------------------------------------------
const wild = (p) => p === null || /[*?+()]/.test(p);
const segments = (p) => p.split("/").filter(Boolean);
const segmentsMeet = (a, b) => a.toLowerCase() === b.toLowerCase() || a.startsWith(":") || b.startsWith(":");
function pathsMeet(p, pPrefix, q, qPrefix) {
	if (wild(p) || wild(q)) return true;
	const x = segments(p);
	const y = segments(q);
	if (!pPrefix && !qPrefix && x.length !== y.length) return false;
	if (pPrefix && !qPrefix && x.length > y.length) return false;
	if (qPrefix && !pPrefix && y.length > x.length) return false;
	for (let k = 0; k < Math.min(x.length, y.length); k++) if (!segmentsMeet(x[k], y[k])) return false;
	return true;
}
const methodsMeet = (a, b) => !a || !b || a.some((m) => b.includes(m));
const meet = (e, f) => methodsMeet(e.methods, f.methods)
	&& e.paths.some((p) => f.paths.some((q) => pathsMeet(p, e.kind === "use", q, f.kind === "use")));
// Sees every path: middleware with no mount path, or anything on a "*" path.
const seesEverything = (e) => e.paths.some((p) => wild(p) || (e.kind === "use" && segments(p).length === 0));

const scoped = entries.filter((e) => !seesEverything(e));
const everywhere = entries.filter(seesEverything);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

section("3. middleware that sees every path");
const middlewareLines = [];
for (const m of everywhere) {
	const before = scoped.filter((e) => e.order < m.order && meet(m, e));
	const after = scoped.filter((e) => e.order > m.order && meet(m, e));
	const routesBefore = before.filter((e) => e.kind === "route");
	ok(`${m.label} · ${m.chain.join(" · ")}: before every route it meets, or after all of them`, routesBefore.length === 0 || after.length === 0,
		routesBefore.slice(0, 5).map((e) => e.label).join(", "));
	const position = before.length === 0 ? "first" : after.length === 0 ? "last" : `after: ${before.map((e) => e.label).sort(byText).join(", ")}`;
	middlewareLines.push(`${m.label} · ${m.chain.join(" · ")} | ${position}`);
}

const routeLines = scoped.map((e) => {
	const earlier = scoped.filter((f) => f.order < e.order && meet(e, f)).map((f) => f.label).sort(byText);
	const line = `${e.label} · ${e.chain.join(" · ")}${e.lib ? " · (lib mount)" : ""}${earlier.length ? ` | after: ${earlier.join(", ")}` : ""}`;
	const at = e.label.indexOf(" ");
	return { line, key: [e.label.slice(at + 1), e.label.slice(0, at)] };
}).sort((a, b) => byText(a.key[0], b.key[0]) || byText(a.key[1], b.key[1]) || byText(a.line, b.line)).map((r) => r.line);
const effectLines = [];
for (const x of report.effects) {
	const fromPackage = x.site.startsWith("node_modules/");
	const detail = fromPackage && /^set(Timeout|Interval|Immediate)$/.test(x.kind) ? "" : x.detail;
	const line = `${x.kind}${detail ? ` ${detail}` : ""} · ${x.site}`;
	if (!fromPackage || !effectLines.includes(line)) effectLines.push(line);
}

const HEADER = [
	"# Written by `node scripts/test-route-snapshot.js --update`; never edit by hand. Its header",
	"# describes each section. A change here is a change in what a request reaches, in what runs",
	"# in front of it, or in what importing the server starts: say why in the PR.",
];
const current = [...HEADER, "", "[routes]", ...routeLines, "", "[middleware]", ...middlewareLines, "", "[import]", ...effectLines, ""].join("\n");
console.log(`      ${routeLines.length} route line(s), ${middlewareLines.length} middleware line(s), ${effectLines.length} import side effect(s)`);

section("4. importing starts nothing");
eq("require() returns { app, server, io }", [...report.exportKeys].sort(), ["app", "io", "server"]);
ok("...the app, the HTTP server and the Socket.IO server attached to it, as the import built them", report.exportsMatch);
const allowlist = setup.importAllowlist || [];
const onList = (x) => allowlist.some((a) => a.kind === x.kind && a.site === x.site);
const unlisted = report.effects.filter((x) => !onList(x));
const shownEffect = (x) => `${x.kind}${x.detail ? ` ${x.detail}` : ""} · ${x.site}`;
const EFFECT_KINDS = [
	["no listener", /^listen$/],
	["no signal handler", /^process\./],
	["no timer beyond the allowlist", /^set(Timeout|Interval|Immediate)$/],
	["no connection, DNS lookup or fetch", /^(connect$|dns\.|fetch$)/],
	["no process launch", /^child_process\./],
	["no write outside the scratch folder", /^fs\.(?!readdir)/],
	["no temp-folder listing beyond the allowlist", /^fs\.readdir/],
];
for (const [label, re] of EFFECT_KINDS) {
	const found = unlisted.filter((x) => re.test(x.kind));
	ok(`import-only: ${label}`, found.length === 0, found.slice(0, 8).map(shownEffect).join("; "));
}
const otherKinds = unlisted.filter((x) => !EFFECT_KINDS.some(([, re]) => re.test(x.kind)));
ok("import-only: no other kind of side effect", otherKinds.length === 0, otherKinds.slice(0, 8).map(shownEffect).join("; "));
const unused = allowlist.filter((a) => !report.effects.some((x) => x.kind === a.kind && x.site === a.site));
ok("every allowlist entry is still needed (drop the ones a gate made unused)", unused.length === 0, unused.map((a) => `${a.kind} · ${a.site}`).join("; "));

section("5. refused without a scratch database, and in production");
{
	const copy = scratchCopy();
	const why = (r) => (r.report ? r.report.error || "it imported" : `no report: ${r.output.slice(-300)}`);
	const noDatabase = importServer(copy, { DATABASE_PATH: undefined });
	ok("without DATABASE_PATH the import stops, naming it", Boolean(noDatabase.report && /needs DATABASE_PATH/.test(noDatabase.report.error || "")), why(noDatabase));
	ok("...before a database opens beside the server file", !fs.existsSync(path.join(path.dirname(copy), "app.db")));
	// A settings file in the folder the import runs from names a database: only
	// the importer's own environment may, so the import still refuses.
	const named = importServer(copy, { DATABASE_PATH: undefined }, (dir) => `DATABASE_PATH=${path.join(dir, "named-by-settings.db")}\n`);
	ok("a DATABASE_PATH from a settings file in the working folder does not count: refused", Boolean(named.report && /needs DATABASE_PATH/.test(named.report.error || "")), why(named));
	ok("...and that database is never opened", !fs.readdirSync(scratch).some((d) => d.startsWith("run-") && fs.existsSync(path.join(scratch, d, "named-by-settings.db"))));
	const production = importServer(copy, { NODE_ENV: "production" });
	ok("with NODE_ENV=production the import is refused", Boolean(production.report && /refused with NODE_ENV=production/.test(production.report.error || "")), why(production));
}

if (UPDATE) {
	if (failed) fatal(`not writing the fixture: ${failed} check(s) above failed`);
	fs.writeFileSync(FIXTURE, current);
	console.log(`\nwrote ${path.relative(ROOT, FIXTURE)}`);
	process.exit(0);
}

section("6. the fixture");
const stored = fs.existsSync(FIXTURE) ? fs.readFileSync(FIXTURE, "utf8") : null;
ok("the fixture exists", stored !== null, "run with --update to write it");
if (stored !== null) {
	const same = stored === current;
	ok("routes, middleware and import side effects match the fixture", same, "lines below: - in the fixture only, + now only; if the change is intended, run with --update and say why in the PR");
	if (!same) {
		const a = stored.split("\n");
		const b = current.split("\n");
		const inA = new Set(a);
		const inB = new Set(b);
		const gone = a.filter((l) => !inB.has(l));
		const added = b.filter((l) => !inA.has(l));
		for (const l of gone.slice(0, 25)) console.log(`      - ${l}`);
		for (const l of added.slice(0, 25)) console.log(`      + ${l}`);
		if (!gone.length && !added.length) console.log("      (same lines, different order)");
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
