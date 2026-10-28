#!/usr/bin/env node
// The route modules: routes/<name>.js files that server.js mounts through its
// generated context block, directly above the SPA catch-all
// (scripts/split/route-context.js holds the rules; scripts/split/move-routes.js
// writes the modules).
//
//   §1 the tree: every module has the generated shape, takes every server.js
//      name it uses (a forgotten `fetch` or `crypto` would silently be the
//      global one), touches no top-level let, has no strict-mode directive, no
//      column-0 declaration, no timer or job, and is mounted exactly once in the
//      block above the catch-all; the context block equals the generated one;
//      the spec (scripts/split/modules.json) agrees with routes/. Before the
//      first move there is nothing to check.
//   §2 the scanner: spans by the paren rule, regex and template literals,
//      comment blocks, the names a piece uses, top-level declarations
//   §3 the checker on made-up trees: a moved tree passes; each broken rule
//      fails with its own message
//   §4 the move tool on made-up trees: same input, same tree; refusals; the
//      order of routes that can match one request; appending to a module;
//      regenerating the block
//
// Reads files only. SERVER_ROOT=<dir> checks that folder's server.js and
// routes/ against this checkout's spec: a base without a module the spec marks
// moved fails, which is a move's "fails on the old code" test.

"use strict";

const fs = require("fs");
const path = require("path");
const rc = require("./split/route-context");
const { planMove, regenerateContext, specText } = require("./split/move-routes");

let fails = 0;
let passes = 0;
const ok = (cond, label, detail = "") => {
	if (cond) { passes++; console.log(`ok   ${label}`); } else { fails++; console.log(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`); }
};
const eq = (actual, expected, label) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	ok(a === e, label, `got ${a}, want ${e}`);
};
const section = (title) => console.log(`\n§ ${title}`);
const hasError = (res, needle) => res.errors.some((e) => e.includes(needle));

// ------------------------------------------------------------------ §1 tree
section("1 the tree");
const repo = path.resolve(__dirname, "..");
const root = process.env.SERVER_ROOT ? path.resolve(process.env.SERVER_ROOT) : repo;
const specFile = path.join(repo, "scripts", "split", "modules.json");
const specRaw = fs.readFileSync(specFile, "utf8");
const spec = JSON.parse(specRaw);
eq(specRaw === specText(spec), true, "the spec is in the form the move tool writes");
for (const [name, entry] of Object.entries(spec)) {
	const shapeOk = typeof entry.about === "string" && entry.about.length > 0 && typeof entry.moved === "boolean" &&
		Array.isArray(entry.routes) && entry.routes.length > 0 && entry.routes.every((h) => /^(GET|POST|PUT|PATCH|DELETE|ALL) \S/.test(h));
	ok(shapeOk, `spec ${name}: about, moved and "METHOD path" routes`);
}
const live = {};
const dir = path.join(root, rc.ROUTE_DIR);
if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) live[f.replace(/\.js$/, "")] = fs.readFileSync(path.join(dir, f), "utf8");
const liveRes = rc.checkTree({ serverSrc: fs.readFileSync(path.join(root, "server.js"), "utf8"), modules: live, spec });
for (const n of liveRes.notes) console.log(`note ${n}`);
ok(liveRes.errors.length === 0, `${Object.keys(live).length} route module(s) check clean`, liveRes.errors.join("\n     "));

// --------------------------------------------------------------- fixtures
const SERVER = [
	'const express = require("express");',
	"const app = express();",
	"const fetch = globalThis.fetch;",
	'const crypto = require("crypto");',
	"const FX_LIMIT = 3;",
	"let fxHits = 0;",
	"function fxGate(req, res, next) { next(); }",
	"",
	"app.use((req, res, next) => next());",
	"",
	"// GET /fx/alpha: the first made-up route.",
	'app.get("/fx/alpha", fxGate, async (req, res) => {',
	"\tconst made = fetch && crypto ? FX_LIMIT : 0;",
	"\tres.json({ made });",
	"});",
	"",
	"// A comment that ends with a full stop.",
	'app.post("/fx/:id", fxGate, (req, res) => res.json({ id: req.params.id, n: fxHelper() }));',
	"",
	'app.post("/fx/special", fxGate, (req, res) => res.json({ special: true }));',
	"",
	'app.get("/fx/gamma", (req, res) => res.json({ gamma: fxHelper() }));',
	"",
	'app.get("/fx/counter", (req, res) => res.json({ n: ++fxHits }));',
	"",
	"function fxHelper() { return FX_LIMIT; }",
	"",
	"// The SPA catch-all.",
	'app.get("*", (req, res) => res.end());',
	"",
	"const FX_LATE = 1;",
	'app.get("/fx/late", (req, res) => res.json({ late: FX_LATE }));',
	"",
].join("\n");
const SPEC = {
	"fx-one": { about: "Made-up routes, one.", moved: false, routes: ["GET /fx/alpha", "POST /fx/:id", "POST /fx/special"] },
	"fx-two": { about: "Made-up routes, two.", moved: false, routes: ["GET /fx/gamma"] },
};
const move = (serverSrc, targets, { modules = {}, spec: s = SPEC, readLib } = {}) => planMove({ serverSrc, modules, spec: s, targets, readLib });
const target = (name, routes, s = SPEC) => ({ name, about: (s[name] || { about: "Made-up." }).about, routes: routes || s[name].routes });

// ---------------------------------------------------------------- §2 scanner
section("2 the scanner");
{
	const src = [
		"// above",
		'app.get("/fx/a", h,',
		"\t(req, res) => x(req, res));",
		"const later = 1;",
		"fxCall(() => {",
		"\treturn 2;",
		"});",
		"",
		'app.get("/fx/b", (req, res) => {',
		'\tconst re = /[)"]+\\)/;',
		"\tconst t = `a ${req.query.q || \")\"} b",
		"});",
		"`;",
		"\t/* ) */",
		"\tres.json({ re: String(re), t });",
		"});",
		"",
		"// detached",
		"",
		'app.post(["/fx/c", "/fx/d"], (req, res) => res.end()); // trailing',
		"const tpl = `",
		"const notTopLevel = 1;",
		"`;",
		"",
	].join("\n");
	const regs = rc.registrations(src);
	eq(regs.map((r) => [r.key, r.from, r.line, r.end]), [
		["GET /fx/a", 1, 2, 3],
		["GET /fx/b", 9, 9, 16],
		['POST ["/fx/c", "/fx/d"]', 20, 20, 20],
	], "spans end where their own parenthesis closes (not at the next \"});\"), with the comment block directly above");
	eq(rc.topLevelDeclarations(src).decls.map((d) => `${d.kind} ${d.name}`), ["const later", "const tpl"],
		"a column-0 line inside a template literal is no top-level declaration");
	let threw = "";
	try { rc.registrations('app.get("/fx/x", (req, res) => {\n});\nfoo(\n'); } catch (e) { threw = e.message; }
	ok(/never closes|source scan/.test(threw), "an unbalanced text stops the scanner instead of cutting a guess", threw);
	eq(rc.usedNames("// ends with a stop.\nfxHelper();\n// x.\n\tother.prop;").sort(), ["fxHelper", "other"],
		"a name on the line after a comment that ends in \".\" is a use, not a property");
	const after = (names) => names.filter((n) => /^(fx[A-Z]\w*|fetch|crypto|this)$/.test(n));
	eq(after(rc.usedNames("const q = `'${String(s).replace(/'/g, \"''\")}'`;\nfxA(fetch, crypto.randomUUID(), fxHits++, this);")), ["fxA", "fetch", "crypto", "fxHits", "this"],
		"a quote in a regex inside ${…} opens no string: the names after it are read");
	eq(after(rc.usedNames("const q = `${s.replace(/}/g, \"\")}`;\nfxB(fetch);")), ["fxB", "fetch"], "a } in a regex inside ${…} doesn't end the expression");
	eq(after(rc.usedNames("const q = `${s.replace(/`/g, \"\")}`;\nfxC(crypto);")), ["fxC", "crypto"], "a backtick in a regex inside ${…} opens no template");
	eq(after(rc.usedNames("fxD(...fxE, a?.fxF, b\n\t.fxG, 1.5, .5);")), ["fxD", "fxE"], "spread names are uses; names after \".\" or \"?.\" are properties");
	threw = "";
	try { rc.usedNames("const s = 'open\nfxH();"); } catch (e) { threw = e.message; }
	ok(/runs past the end of its line/.test(threw), "a string that crosses a line stops the reader instead of swallowing code", threw);
	eq(rc.registrations('const FX_ON = 1;\nif (FX_ON)\napp.get("/fx/a", h);\napp.get("/fx/b", h);\n').map((r) => [r.key, r.standalone, r.after]),
		[["GET /fx/a", false, ")"], ["GET /fx/b", true, ";"]], "a registration after \")\" is the body of an if, not a statement of its own");
	ok(rc.pathsOverlap("/fx/report.:format", "/fx/report.csv"), "a segment holding a :param can take a literal segment");
	ok(rc.pathsOverlap("/fx", "/fx/alpha", true) && rc.pathsOverlap("/", "/fx/alpha", true), "a layer matches its own path and everything below it");
	ok(!rc.pathsOverlap("/fx/al", "/fx/alpha", true) && !rc.pathsOverlap("/fx", "/fx/alpha"), "a layer matches whole segments; a route matches its own length only");
	eq(rc.pathKey(' [ "/fx/a",\n "/fx/b" ] '), '["/fx/a", "/fx/b"]', "an array path keys as written, whitespace folded");
	eq([
		String.raw`'/fx/it\'s'`, String.raw`'/fx/say\"hi'`, String.raw`"/fx/back\\slash"`, String.raw`'/fx/\x41B\u{43}\t'`,
		String.raw`'/fx/^$.*+?()[]{}|\q'`, String.raw`"/fx/\0"`,
	].map(rc.pathKey), ["/fx/it's", '/fx/say"hi', "/fx/back\\slash", "/fx/ABC\t", "/fx/^$.*+?()[]{}|q", "/fx/\0"],
	"quoted paths decode every escape (backslash, quotes, \\x, \\u, \\u{}) and keep regex specials as text");
	eq([String.raw`'/fx/\1'`, String.raw`'/fx/\x4'`].map(rc.pathKey), [String.raw`'/fx/\1'`, String.raw`'/fx/\x4'`],
		"an escape it can't read leaves the argument as written instead of guessing");
	eq(rc.pathKey(String.raw`[ "/fx/a\\b", '/fx/c"d' ]`), String.raw`["/fx/a\\b", "/fx/c\"d"]`, "an array of such paths keys as JSON-style text");
	eq(rc.resolvePaths("`${BASE}/x`", { consts: (n) => (n === "BASE" ? "/fx" : null) }), ["/fx/x"], "a template path resolves through a const");
}

// ---------------------------------------------------------------- §3 checker
section("3 the checker on made-up trees");
const moved = move(SERVER, [target("fx-one")]);
ok(!moved.refusals, "the made-up move is allowed", (moved.refusals || []).join("; "));
const base = { serverSrc: moved.serverSrc, modules: moved.modules, spec: moved.spec };
const check = (over = {}) => rc.checkTree({ ...base, ...over });
const withModule = (text) => ({ modules: { "fx-one": text } });
const modText = moved.modules["fx-one"];
const block = rc.mountBlock(moved.serverSrc);
{
	const res = check();
	ok(res.errors.length === 0, "the moved made-up tree passes", res.errors.join("; "));
	eq(block.names, ["FX_LIMIT", "app", "crypto", "express", "fetch", "fxGate", "fxHelper"],
		"the context holds every function and every const above the block; no let, nothing below it");
	ok(moved.serverSrc.includes(`\trequire,\n};\n\nrequire("./routes/fx-one")(${rc.CONTEXT});\n\n// The SPA catch-all.`), "require closes the context; the block sits above the catch-all's comment");
	eq(rc.parseModule(modText).names, ["FX_LIMIT", "app", "crypto", "fetch", "fxGate", "fxHelper"],
		"the module takes exactly the server.js names it uses, sorted (fetch and crypto included)");
	eq(moved.spec["fx-one"].moved, true, "the spec marks the module moved");
	ok(rc.checkTree({ serverSrc: SERVER, modules: {}, spec: SPEC }).notes.some((n) => n.includes("nothing to check")), "no modules and no block: nothing to check");
}
let threwRegen = "";
const sigOf = (text) => text.split("\n").find((l) => l.startsWith("module.exports"));
const replaceSig = (names) => modText.replace(sigOf(modText), `module.exports = function mount({ ${names.join(", ")} }) {`);
const without = (name) => rc.parseModule(modText).names.filter((n) => n !== name);
{
	for (const g of ["fetch", "crypto"]) {
		const res = check(withModule(replaceSig(without(g))));
		ok(hasError(res, `uses server.js's ${g} without taking it`) && hasError(res, `global ${g}`), `a module that forgets ${g} fails, naming the global it would get`);
	}
	ok(hasError(check(withModule(replaceSig(without("app")))), "uses server.js's app without taking it"), "a module that forgets app fails (the name sits right after a comment)");
	ok(hasError(check(withModule(replaceSig([...rc.parseModule(modText).names, "fxGhost"].sort(rc.byCodeUnit)))), "takes fxGhost, which"), "a name the context lacks fails (it would be undefined)");
	ok(hasError(check(withModule(replaceSig([...rc.parseModule(modText).names].reverse()))), "not sorted"), "unsorted parameters fail");
	const body = (extra) => modText.replace("\tres.json({ made });", `\tres.json({ made });\n${extra}`);
	ok(hasError(check(withModule(body("\tfxHits++;"))), "touches server.js's let fxHits"), "a module touching a top-level let fails");
	ok(hasError(check(withModule(body("\tres.json({ late: FX_LATE });"))), "declares below the mount block"), "a module using a const declared below the block fails");
	for (const [name, why] of rc.FORBIDDEN) {
		ok(hasError(check(withModule(body(`\tconst probe = typeof ${name};`))), why), `a module using ${name} fails`);
	}
	ok(hasError(check(withModule(modText.replace("module.exports", '"use strict";\nmodule.exports'))), "strict-mode directive"), "a strict-mode directive fails");
	ok(hasError(check(withModule(modText.replace("\n};\n", "\nconst fxStray = 1;\n};\n"))), "column-0 declaration"), "a column-0 declaration in a module fails");
	ok(hasError(check(withModule(modText.replace("\n};\n", "\napp.set(\"x\", 1);\n};\n"))), "only route registrations"), "a statement that is no registration fails");
	ok(hasError(check(withModule(modText.replace("\n};\n", "\napp.use((req, res, next) => next());\n};\n"))), "only route registrations"), "a middleware layer in a module fails");
	const mountLine = `require("./routes/fx-one")(${rc.CONTEXT});`;
	ok(hasError(check({ serverSrc: moved.serverSrc.replace(mountLine, `${mountLine}\n\n${mountLine}`) }), "mounted twice"), "a module mounted twice fails");
	ok(hasError(check({ serverSrc: `${moved.serverSrc}${mountLine}\n` }), "outside the mount block"), "a mount line outside the block fails");
	const lines = moved.serverSrc.split("\n");
	const blockLines = lines.slice(block.from - 1, block.end);
	const below = [...lines.slice(0, block.from - 1), ...lines.slice(block.end + 1)];
	below.splice(below.findIndex((l) => l.startsWith('app.get("*"')) + 1, 0, "", ...blockLines);
	ok(hasError(check({ serverSrc: below.join("\n") }), "above the SPA catch-all"), "a block below the catch-all fails");
	ok(hasError(check({ modules: { ...moved.modules, "fx-two": modText } }), "is never mounted"), "a module file that is never mounted fails");
	ok(hasError(check({ modules: {} }), "which does not exist"), "a mount line for a missing file fails");
	ok(hasError(check({ serverSrc: moved.serverSrc.replace("function fxHelper()", "function fxNew() {}\nfunction fxHelper()") }), "missing fxNew"), "a new top-level function makes the context stale (regenerate)");
	ok(hasError(check({ serverSrc: moved.serverSrc.replace("\tfetch,\n", "") }), "differ from the generated block"), "a hand-edited context fails");
	ok(hasError(check({ modules: {}, serverSrc: SERVER }), "marked moved, but routes/fx-one.js does not exist"), "the base tree fails against a spec that marks the module moved");
	ok(hasError(check({ spec: SPEC }), "is not marked moved"), "a module the spec doesn't mark moved fails");
	ok(hasError(check({ spec: { "fx-two": SPEC["fx-two"] } }), "is not in the spec"), "a module missing from the spec fails");
	const dup = moved.serverSrc.replace("// The SPA catch-all.", 'app.get("/fx/alpha", (req, res) => res.end());\n\n// The SPA catch-all.');
	ok(hasError(check({ serverSrc: dup }), "GET /fx/alpha is registered 2 times"), "a route registered in server.js and in its module fails");
	const quoted = replaceSig(without("fetch")).replace("\tconst made = fetch", "\tconst q = `'${String(req.query.s).replace(/'/g, \"''\")}'`;\n\tconst made = fetch");
	ok(hasError(check(withModule(quoted)), "uses server.js's fetch without taking it"), "a forgotten fetch after a quote in a regex inside ${…} still fails");
	ok(hasError(check(withModule(modText.replace("\n};\n", "\nif (fxGate)\napp.get(\"/fx/zz\", (req, res) => res.end());\n};\n"))), "GET /fx/zz is not a statement of its own"), "a registration that is the body of an if fails");
	ok(hasError(check({ spec: { ...moved.spec, "fx-one": { ...moved.spec["fx-one"], routes: [...moved.spec["fx-one"].routes, "GET /fx/gamma"] } } }), "GET /fx/gamma is listed for fx-one, but routes/fx-one.js does not register it"),
		"a moved module that lacks one of its spec routes fails");
	const touching = moved.serverSrc.replace("// Route modules (routes/)", "// A note someone wrote.\n// Route modules (routes/)");
	ok(hasError(check({ serverSrc: touching }), "a comment touches the mount block"), "a comment touching the mount block fails");
	threwRegen = "";
	try { regenerateContext(touching); } catch (e) { threwRegen = e.message; }
	ok(/a comment touches the mount block/.test(threwRegen), "--context stops on it instead of deleting the comment", threwRegen);
	ok(hasError(check({ serverSrc: moved.serverSrc.replace("so each route keeps its place", "so each route keeps a place") }), "is not the generated one"), "an edited mount comment fails");
}

// ------------------------------------------------------------------- §4 tool
section("4 the move tool on made-up trees");
{
	const again = move(SERVER, [target("fx-one")]);
	eq(JSON.stringify(again), JSON.stringify(moved), "the same input gives the same tree, spec and move map");
	const both = move(SERVER, [target("fx-one"), target("fx-two")]);
	const stepwise = move(moved.serverSrc, [target("fx-two", null, moved.spec)], { modules: moved.modules, spec: moved.spec });
	ok(!both.refusals && !stepwise.refusals, "moving the two modules together, or one after the other, is allowed");
	eq(stepwise.serverSrc, both.serverSrc, "one after the other gives the same server.js as both at once");
	eq(stepwise.modules["fx-two"], both.modules["fx-two"], "...and the same module");
	ok(!/\n\n\n/.test(both.serverSrc) && !SERVER.includes("\n\n\n"), "a cut never leaves two blank lines together");
	const map = moved.moveMap.find((m) => m.route === "POST /fx/:id");
	eq(modText.split("\n")[map.to.head - 1], SERVER.split("\n")[map.from.head - 1], "the move map points at the head line in the module");
	eq(map.from.lines, [17, 18], "the move map's old span holds the comment block above the head");

	const refused = (res) => (res.refusals || []).join(" | ");
	ok(/touches the let fxHits/.test(refused(move(SERVER, [target("fx-x", ["GET /fx/counter"])]))), "a route touching a let is refused");
	ok(/declared below the mount block/.test(refused(move(SERVER, [target("fx-x", ["GET /fx/late"])]))), "a route using a const below the block is refused");
	ok(/a middleware layer/.test(refused(move(SERVER, [target("fx-x", ["USE (req, res, next) => next()"])]))), "a middleware layer is refused");
	ok(/no such registration/.test(refused(move(SERVER, [target("fx-x", ["GET /fx/none"])]))), "an unknown head is refused");
	ok(/asked for by fx-x and fx-y/.test(refused(move(SERVER, [target("fx-x", ["GET /fx/alpha"]), target("fx-y", ["GET /fx/alpha"])]))), "a head two modules ask for is refused");
	ok(/nothing to move/.test(refused(move(SERVER, [target("fx-x", [])]))), "a move with no route is refused");
	for (const [name] of rc.MOVE_FORBIDDEN) {
		const src = SERVER.replace("\tres.json({ made });", `\tres.json({ made, probe: typeof ${name} });`);
		ok(refused(move(src, [target("fx-one")])).includes(rc.MOVE_FORBIDDEN.get(name)), `a route using ${name} is refused`);
	}
	const pair = /POST \/fx\/:id and POST \/fx\/special can match the same request/;
	ok(pair.test(refused(move(SERVER, [target("fx-x", ["POST /fx/:id"])]))), "moving the first of two routes that can match one request is refused");
	ok(!move(SERVER, [target("fx-x", ["POST /fx/special"])]).refusals, "moving only the second keeps their order, so it is allowed");
	ok(!move(SERVER, [target("fx-x", ["POST /fx/:id", "POST /fx/special"])]).refusals, "moving both into one module keeps their order");
	ok(pair.test(refused(move(SERVER, [target("fx-b", ["POST /fx/:id"]), target("fx-a", ["POST /fx/special"])]))), "two modules whose mount order would flip the pair are refused");
	const lib = SERVER.replace("function fxHelper()", 'require("./lib/fx-mounted").mount(app);\n\nfunction fxHelper()');
	const libText = 'const BASE = "/fx";\nfunction mount(app) {\n\tapp.get(`${BASE}/:any`, (req, res) => res.end());\n}\n';
	const readLib = (rel) => (rel === "lib/fx-mounted.js" ? libText : null);
	ok(/GET \/fx\/alpha and GET `\$\{BASE\}\/:any`/.test(refused(move(lib, [target("fx-one")], { readLib }))), "a route moved past a lib-mounted route it overlaps is refused");
	ok(/can match the same request/.test(refused(move(lib, [target("fx-one")], { readLib: () => null }))), "an unreadable lib mount is taken to overlap everything");
	const libByName = SERVER.replace("function fxHelper()", 'const fx$lib = require("./lib/fx-mounted");\nfx$lib.mount(app);\n\nfunction fxHelper()');
	ok(/GET \/fx\/alpha and GET `\$\{BASE\}\/:any`/.test(refused(move(libByName, [target("fx-one")], { readLib }))), "a lib mounted through a const whose name holds a $ is found by its require line");

	const layer = (line) => SERVER.replace("function fxHelper()", `${line}\n\nfunction fxHelper()`);
	const runsFirst = /can match the same request; this move would change which runs first/;
	ok(runsFirst.test(refused(move(layer('app.use("/fx", fxGate);'), [target("fx-one")]))), "a route moved past a layer on its path prefix is refused");
	ok(!move(layer('app.use("/fx/alpha/deep", fxGate);'), [target("fx-one")]).refusals, "...a layer deeper than every moved path is not in the way");
	ok(runsFirst.test(refused(move(layer('app.use("/fx/al", fxGate);'), [target("fx-one")]))), "...a layer that a :param segment can reach is (POST /fx/al meets both)");
	ok(!move(layer('app.use("/other", fxGate);'), [target("fx-one")]).refusals, "...nor a layer on another path");
	ok(runsFirst.test(refused(move(layer("app.use(fxGate);"), [target("fx-one")]))), "a route moved past a path-less layer is refused");
	ok(!move(layer('app.use(express.static("dist"));'), [target("fx-x", ["POST /fx/:id", "POST /fx/special"])]).refusals, "POST routes may pass a static layer (it answers GET and HEAD only)");
	ok(runsFirst.test(refused(move(layer('app.use(express.static("dist"));'), [target("fx-x", ["GET /fx/alpha"])]))), "...a GET route may not");
	ok(/inside the statement at server\.js:\d+ can match the same request/.test(refused(move(layer("if (fxGate) app.use(fxGate);"), [target("fx-one")]))),
		"a layer inside another statement can't be read, so moving past it is refused");
	const braceless = SERVER.replace("function fxHelper()", 'if (FX_LIMIT)\napp.get("/fx/debug", (req, res) => res.json({ debug: true }));\n\nfunction fxHelper()');
	ok(/not a statement of its own \(it follows "\)"\)/.test(refused(move(braceless, [target("fx-x", ["GET /fx/debug"])]))), "a registration that is the body of a brace-less if is refused");
	const blind = SERVER.replace("\tconst made = fetch", "\tconst q = `'${String(req.query.s).replace(/'/g, \"''\")}'`;\n\tconst made = fetch");
	const blindMoved = move(blind, [target("fx-one")]);
	eq(blindMoved.modules && rc.parseModule(blindMoved.modules["fx-one"]).names, ["FX_LIMIT", "app", "crypto", "fetch", "fxGate", "fxHelper"],
		"after a quote in a regex inside ${…}, the module still takes fetch and crypto");
	const blindState = blind.replace("\tres.json({ made });", "\tfxHits++;\n\tres.json({ made, self: this === undefined });");
	const blindRefusals = refused(move(blindState, [target("fx-one")]));
	ok(/touches the let fxHits/.test(blindRefusals) && /reads `this`/.test(blindRefusals), "...and a let and `this` after it are still refused", blindRefusals);

	ok(/the spec lists POST \/fx\/:id for it, which this move leaves behind/.test(refused(move(SERVER, [target("fx-one", ["GET /fx/alpha"])]))), "a move that leaves one of the module's spec routes in server.js is refused");
	const specAlpha = { ...SPEC, "fx-one": { ...SPEC["fx-one"], routes: ["GET /fx/alpha"] } };
	const first = move(SERVER, [target("fx-one", ["GET /fx/alpha"], specAlpha)], { spec: specAlpha });
	ok(!first.refusals, "a module can move part of the plan when its spec lists only that part", refused(first));
	const appended = move(first.serverSrc, [target("fx-one", ["POST /fx/:id", "POST /fx/special"], first.spec)], { modules: first.modules, spec: first.spec });
	const regs = rc.registrations(rc.parseModule(appended.modules["fx-one"]).body).map((r) => r.key);
	eq(regs, ["GET /fx/alpha", "POST /fx/:id", "POST /fx/special"], "a second move appends to the module in order");
	ok(rc.checkTree({ serverSrc: appended.serverSrc, modules: appended.modules, spec: appended.spec }).errors.length === 0, "...and the tree still checks clean");
	eq(appended.serverSrc, moved.serverSrc, "...and gives the same server.js as moving them together");
	eq(appended.modules["fx-one"], modText, "...and the same module");
	eq(appended.spec["fx-one"].routes, SPEC["fx-one"].routes, "...and the spec lists all three");

	const stale = moved.serverSrc.replace("function fxHelper()", "function fxNew() {}\nfunction fxHelper()");
	const regen = regenerateContext(stale);
	ok(regen.changed && rc.checkTree({ ...base, serverSrc: regen.serverSrc }).errors.length === 0, "--context regenerates a stale block");
	eq(regenerateContext(regen.serverSrc).changed, false, "...and a current block is left as it is");
	eq(regenerateContext(SERVER).changed, false, "--context on a tree without a block changes nothing");
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
