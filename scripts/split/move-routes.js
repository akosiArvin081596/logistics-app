#!/usr/bin/env node
// Moves route registrations out of server.js into routes/<module>.js, verbatim
// and in their original order, and (re)generates the mount block above the SPA
// catch-all: ROUTE_CONTEXT (every top-level function, and every const above the
// block) and one require line per module. A dev tool: a reviewer re-runs it on
// the base and compares trees, so its output depends only on its input.
//
//   node scripts/split/move-routes.js maps kpi          modules from the spec
//   node scripts/split/move-routes.js --module maps --about "…" --route "GET /api/route" …
//   node scripts/split/move-routes.js --context         regenerate the mount block only
//
// Options: --root <dir> (default: this checkout), --spec <file> (default:
// scripts/split/modules.json under the root), --map <file> (write the move
// map: each route's old server.js lines and its new file and lines),
// --dry-run (report, write nothing).
//
// A head is "METHOD path" as the registration writes it ("GET /api/route",
// `POST ["/a", "/b"]`, "POST investorRfi.INVESTOR_RFI_PATH"). Each route is cut
// from its `app.<method>(` line to the line its own parenthesis closes on, with
// the contiguous column-0 comment block directly above it.
//
// It refuses (exit 1, writes nothing) a route that touches a top-level let, a
// const declared below the mount block, a timer or job, this, arguments,
// __dirname, __filename, module or exports; a middleware (`use`) layer; and a
// move that changes the order of two routes that can match one request.
// Exit 2: usage, or a tree it can't read.

"use strict";

const fs = require("fs");
const path = require("path");
const rc = require("./route-context");

const LIB_MOUNT_RE = /^(?:([A-Za-z_$][\w$]*)|require\("(\.\/lib\/[^"]+)"\))\.mount\(app\b/;
const DECL_LINE_RE = /^(?:async\s+function|function|const|let|var|class)\b/;

const libRel = (spec) => (spec.endsWith(".js") ? spec : `${spec}.js`).replace(/^\.\//, "");

// Where each route sits in the match order: server.js routes by line, module
// routes at their mount block (modules by name, then file order), lib-mounted
// routes at their mount call.
function orderOf(entries) {
	return [...entries].sort((a, b) => a.anchor - b.anchor || a.sub - b.sub || (a.id < b.id ? -1 : 1)).map((e) => e.id);
}

// The move, on text: { serverSrc, modules: { name: text }, spec, targets:
// [{ name, about, routes }], readLib(rel) -> text | null }. Returns
// { refusals } or { serverSrc, modules, spec, moveMap, summary }.
function planMove({ serverSrc, modules = {}, spec = {}, targets, readLib = () => null }) {
	const refusals = [];
	const lines = serverSrc.split("\n");
	const scan = rc.scanSource(serverSrc);
	const regs = rc.registrations(serverSrc, scan);
	const { decls } = rc.topLevelDeclarations(serverSrc, scan);
	const block = rc.mountBlock(serverSrc, scan);
	if (block && block.error) throw new Error(`server.js: ${block.error}`);
	const all = rc.catchAll(serverSrc, scan);
	if (all.error) throw new Error(`server.js: ${all.error}`);
	const mountLine = block ? block.from : all.commentFrom;
	const lets = new Set(decls.filter((d) => d.kind === "let" || d.kind === "var").map((d) => d.name));
	const late = new Set(decls.filter((d) => (d.kind === "const" || d.kind === "class") && d.line >= mountLine && d.name !== rc.CONTEXT).map((d) => d.name));

	// Static path resolution, for the order check.
	const serverConsts = rc.stringConsts(serverSrc);
	const libConsts = new Map();
	const constsOf = (rel) => {
		if (!libConsts.has(rel)) { const t = readLib(rel); libConsts.set(rel, t === null ? null : rc.stringConsts(t)); }
		return libConsts.get(rel);
	};
	const requireOf = (name) => {
		const m = new RegExp(`^const ${name.replace(/\$/g, "\\$")} = require\\("(\\./lib/[^"]+)"\\)`, "m").exec(serverSrc);
		return m ? libRel(m[1]) : null;
	};
	const member = (obj, prop) => {
		const rel = requireOf(obj);
		const c = rel && constsOf(rel);
		return c ? c.get(prop) || null : null;
	};
	const pathsOf = (argText, consts) => rc.resolvePaths(argText, { consts: (n) => consts.get(n) || null, member });

	const entries = [];
	for (const r of regs) entries.push({ id: `s:${r.line}`, method: r.method, key: r.key, paths: pathsOf(r.argText, serverConsts), anchor: r.line, sub: 0, reg: r });
	lines.forEach((l, k) => {
		if (!scan.lineTop[k]) return;
		const m = LIB_MOUNT_RE.exec(l);
		if (!m) return;
		const rel = m[2] ? libRel(m[2]) : requireOf(m[1]);
		const text = rel ? readLib(rel) : null;
		if (text === null) {
			entries.push({ id: `l:${k + 1}:0`, method: "all", key: `(lib mount at server.js:${k + 1})`, paths: null, anchor: k + 1, sub: 0 });
			return;
		}
		const consts = rc.stringConsts(text);
		let i = 0;
		for (const x of text.matchAll(/\bapp\.(get|post|put|patch|delete|all)\(\s*([^,]+?)\s*,/g)) {
			entries.push({ id: `l:${k + 1}:${i}`, method: x[1], key: `${x[1].toUpperCase()} ${x[2]} (${rel})`, paths: rc.resolvePaths(x[2], { consts: (n) => consts.get(n) || null }), anchor: k + 1, sub: i++ });
		}
	});

	// The modules already mounted, and their routes.
	const mounted = block ? block.modules.map((m) => m.name) : [];
	const parsed = new Map();
	const keyHome = new Map();
	for (const name of mounted) {
		if (modules[name] === undefined) throw new Error(`server.js mounts routes/${name}.js, which does not exist`);
		const mod = rc.parseModule(modules[name]);
		if (mod.error) throw new Error(`routes/${name}.js: ${mod.error}`);
		const mregs = rc.registrations(mod.body);
		parsed.set(name, { mod, regs: mregs });
		for (const r of mregs) keyHome.set(r.key, name);
	}

	// What each target moves.
	const wanted = new Map();
	const moves = new Map();
	for (const t of targets) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t.name)) { refusals.push(`${t.name}: a module name is lowercase words joined by "-"`); continue; }
		if (modules[t.name] !== undefined && !parsed.has(t.name)) { refusals.push(`${t.name}: routes/${t.name}.js exists but server.js does not mount it`); continue; }
		const list = [];
		for (const head of t.routes) {
			if (wanted.has(head)) { refusals.push(`${head}: asked for by ${wanted.get(head)} and ${t.name}`); continue; }
			wanted.set(head, t.name);
			const hits = regs.filter((r) => r.key === head);
			if (hits.length === 1) { list.push(hits[0]); continue; }
			if (hits.length > 1) { refusals.push(`${head}: ${hits.length} registrations in server.js (lines ${hits.map((h) => h.line).join(", ")})`); continue; }
			if (keyHome.get(head) === t.name) continue;
			refusals.push(keyHome.has(head) ? `${head}: already in routes/${keyHome.get(head)}.js` : `${head}: no such registration in server.js`);
		}
		moves.set(t.name, list.sort((a, b) => a.line - b.line));
	}

	for (const [name, list] of moves) {
		for (const r of list) {
			const where = `${name}: ${r.key} (server.js:${r.line})`;
			if (r.method === "use") { refusals.push(`${where}: a middleware layer; layers stay in server.js`); continue; }
			const text = lines.slice(r.line - 1, r.end).join("\n");
			const ids = new Set(rc.usedNames(text));
			for (const id of [...ids].sort(rc.byCodeUnit)) {
				if (rc.MOVE_FORBIDDEN.has(id)) refusals.push(`${where}: ${rc.MOVE_FORBIDDEN.get(id)}`);
				else if (lets.has(id)) refusals.push(`${where}: touches the let ${id} (a module would hold a copy, not the binding)`);
				else if (late.has(id)) refusals.push(`${where}: uses ${id}, declared below the mount block`);
			}
			const decl = lines.slice(r.from - 1, r.end).findIndex((l) => DECL_LINE_RE.test(l));
			if (decl !== -1) refusals.push(`${where}: line ${r.from + decl} starts at column 0 like a declaration`);
		}
	}

	// The order check: every pair that can match one request keeps its order.
	const movedLines = new Set([...moves.values()].flat().map((r) => r.line));
	const finalNames = [...new Set([...mounted, ...[...moves].filter(([, list]) => list.length).map(([name]) => name)])].sort(rc.byCodeUnit);
	if (!finalNames.length && !refusals.length) refusals.push("nothing to move");
	const moduleEntries = (names, withMoves) => {
		const out = [];
		names.forEach((name, mi) => {
			let i = 0;
			if (parsed.has(name)) for (const r of parsed.get(name).regs) out.push({ id: `m:${name}:${i}`, method: r.method, key: r.key, paths: pathsOf(r.argText, serverConsts), anchor: mountLine - 0.5, sub: mi * 100000 + i++ });
			if (withMoves && moves.has(name)) for (const r of moves.get(name)) out.push({ id: `s:${r.line}`, anchor: mountLine - 0.5, sub: mi * 100000 + i++ });
		});
		return out;
	};
	const beforeEntries = [...entries, ...moduleEntries([...mounted].sort(rc.byCodeUnit), false)];
	const afterEntries = [
		...entries.filter((e) => !(e.id.startsWith("s:") && movedLines.has(e.reg.line))),
		...moduleEntries(finalNames, true),
	];
	const routes = beforeEntries.map((e) => ({ id: e.id, method: e.method, key: e.key, paths: e.paths }));
	for (const [a, b] of rc.brokenPairs(routes, orderOf(beforeEntries), orderOf(afterEntries))) {
		refusals.push(`${a.key} and ${b.key} can match the same request; this move would change which is registered first`);
	}
	if (refusals.length) return { refusals };

	// New module texts.
	const contextAfter = new Set(rc.contextNames(decls, mountLine));
	const outModules = {};
	const moveMap = [];
	for (const [name, list] of moves) {
		if (!list.length) continue;
		const target = targets.find((t) => t.name === name);
		const existing = parsed.get(name);
		const header = existing ? existing.mod.header : rc.moduleHeader(target.about);
		const bodyParts = existing ? [existing.mod.body] : [];
		let at = header.length + 2 + (existing ? existing.mod.body.split("\n").length + 1 : 0);
		for (const r of list) {
			const text = lines.slice(r.from - 1, r.end).join("\n");
			moveMap.push({
				route: r.key,
				from: { file: "server.js", lines: [r.from, r.end], head: r.line },
				to: { file: `${rc.ROUTE_DIR}/${name}.js`, lines: [at, at + (r.end - r.from)], head: at + (r.line - r.from) },
			});
			bodyParts.push(text);
			at += r.end - r.from + 2;
		}
		const body = bodyParts.join("\n\n");
		const ids = new Set(rc.usedNames(body));
		const names = [...ids].filter((id) => contextAfter.has(id) || id === "require").sort(rc.byCodeUnit);
		outModules[name] = rc.renderModule({ header, names, body });
	}

	// server.js without the moved spans; where a cut leaves two blank lines
	// together, the one after it goes too.
	const cut = new Set();
	for (const list of moves.values()) for (const r of list) for (let l = r.from; l <= r.end; l++) cut.add(l);
	const runs = [];
	for (let l = 1; l <= lines.length; l++) {
		if (!cut.has(l)) continue;
		if (runs.length && runs[runs.length - 1][1] === l - 1) runs[runs.length - 1][1] = l; else runs.push([l, l]);
	}
	for (const [a, b] of runs) if ((a === 1 || lines[a - 2] === "") && lines[b] === "") cut.add(b + 1);
	const kept = lines.filter((_, k) => !cut.has(k + 1));
	let newSrc = kept.join("\n");

	// The mount block: regenerated in place, or put above the catch-all's comment.
	const keptScan = rc.scanSource(newSrc);
	const keptBlock = rc.mountBlock(newSrc, keptScan);
	const keptDecls = rc.topLevelDeclarations(newSrc, keptScan).decls;
	let blockFrom;
	if (keptBlock) {
		blockFrom = keptBlock.from;
		const names = rc.contextNames(keptDecls, keptBlock.from);
		kept.splice(keptBlock.from - 1, keptBlock.end - keptBlock.from + 1, ...rc.renderMountBlock(names, finalNames));
	} else {
		const at = rc.catchAll(newSrc, keptScan).commentFrom;
		blockFrom = at;
		const names = rc.contextNames(keptDecls, at);
		kept.splice(at - 1, 0, ...rc.renderMountBlock(names, finalNames), "");
	}
	newSrc = kept.join("\n");

	const outSpec = JSON.parse(JSON.stringify(spec));
	for (const t of targets) {
		const entry = outSpec[t.name] || (outSpec[t.name] = { about: t.about, moved: false, routes: [] });
		for (const head of t.routes) if (!entry.routes.includes(head)) entry.routes.push(head);
		if (outModules[t.name] || parsed.has(t.name)) entry.moved = true;
	}

	const allModules = { ...modules, ...outModules };
	const check = rc.checkTree({ serverSrc: newSrc, modules: allModules, spec: outSpec });
	if (check.errors.length) throw new Error(`the moved tree fails the module checks (a bug in this tool):\n  ${check.errors.join("\n  ")}`);

	const summary = [];
	for (const [name, list] of moves) {
		const n = list.reduce((s, r) => s + (r.end - r.from + 1), 0);
		summary.push(`${name}: ${list.length} route(s), ${n} line(s) -> ${rc.ROUTE_DIR}/${name}.js`);
	}
	summary.push(`server.js: ${lines.length} -> ${newSrc.split("\n").length} lines; mount block at line ${blockFrom}`);
	return { serverSrc: newSrc, modules: outModules, spec: outSpec, moveMap, summary };
}

// The mount block alone, from the current server.js and its mount lines.
function regenerateContext(serverSrc) {
	const scan = rc.scanSource(serverSrc);
	const block = rc.mountBlock(serverSrc, scan);
	if (!block) return { serverSrc, changed: false, note: "no mount block yet: nothing to regenerate" };
	if (block.error) throw new Error(`server.js: ${block.error}`);
	const { decls } = rc.topLevelDeclarations(serverSrc, scan);
	const lines = serverSrc.split("\n");
	lines.splice(block.from - 1, block.end - block.from + 1, ...rc.renderMountBlock(rc.contextNames(decls, block.from), block.modules.map((m) => m.name)));
	const out = lines.join("\n");
	return { serverSrc: out, changed: out !== serverSrc };
}

const specText = (spec) => `${JSON.stringify(spec, null, "\t")}\n`;

function readTree(root) {
	const serverSrc = fs.readFileSync(path.join(root, "server.js"), "utf8");
	const modules = {};
	const dir = path.join(root, rc.ROUTE_DIR);
	if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) if (f.endsWith(".js")) modules[f.slice(0, -3)] = fs.readFileSync(path.join(dir, f), "utf8");
	return { serverSrc, modules };
}

function main(argv) {
	const args = { names: [], routes: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const val = () => {
			if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
			return argv[++i];
		};
		if (a === "--root") args.root = val();
		else if (a === "--spec") args.spec = val();
		else if (a === "--map") args.map = val();
		else if (a === "--module") args.module = val();
		else if (a === "--about") args.about = val();
		else if (a === "--route") args.routes.push(val());
		else if (a === "--dry-run") args.dryRun = true;
		else if (a === "--context") args.context = true;
		else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
		else args.names.push(a);
	}
	const root = path.resolve(args.root || path.join(__dirname, "..", ".."));
	const specFile = path.resolve(args.spec || path.join(root, "scripts", "split", "modules.json"));
	const tree = readTree(root);

	if (args.context) {
		if (args.names.length || args.module || args.routes.length) throw new Error("--context takes no module");
		const r = regenerateContext(tree.serverSrc);
		if (r.note) console.log(r.note);
		else console.log(r.changed ? "mount block regenerated" : "mount block already current");
		if (r.changed && !args.dryRun) fs.writeFileSync(path.join(root, "server.js"), r.serverSrc);
		return 0;
	}

	const spec = fs.existsSync(specFile) ? JSON.parse(fs.readFileSync(specFile, "utf8")) : {};
	const targets = [];
	if (args.module) {
		if (args.names.length) throw new Error("--module and module names can't be combined");
		if (!args.routes.length) throw new Error("--module needs at least one --route");
		const about = args.about || (spec[args.module] && spec[args.module].about);
		if (!about) throw new Error(`--about is needed for a module the spec doesn't hold (${args.module})`);
		targets.push({ name: args.module, about, routes: args.routes });
	} else {
		if (args.routes.length || args.about) throw new Error("--route and --about go with --module");
		if (!args.names.length) throw new Error("name at least one module, or use --module, or --context");
		for (const name of args.names) {
			const entry = spec[name];
			if (!entry) throw new Error(`${name} is not in ${path.relative(root, specFile)}`);
			targets.push({ name, about: entry.about, routes: entry.routes });
		}
	}
	const readLib = (rel) => {
		const f = path.join(root, rel);
		return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
	};
	const out = planMove({ ...tree, spec, targets, readLib });
	if (out.refusals) {
		console.error(`refused (${out.refusals.length}); nothing written:`);
		for (const r of out.refusals) console.error(`  ${r}`);
		return 1;
	}
	for (const s of out.summary) console.log(s);
	if (args.map) fs.writeFileSync(path.resolve(args.map), `${JSON.stringify(out.moveMap, null, "\t")}\n`);
	if (args.dryRun) { console.log("dry run: nothing written"); return 0; }
	fs.mkdirSync(path.join(root, rc.ROUTE_DIR), { recursive: true });
	for (const [name, text] of Object.entries(out.modules)) fs.writeFileSync(path.join(root, rc.ROUTE_DIR, `${name}.js`), text);
	fs.writeFileSync(path.join(root, "server.js"), out.serverSrc);
	fs.writeFileSync(specFile, specText(out.spec));
	return 0;
}

if (require.main === module) {
	let code;
	try {
		code = main(process.argv.slice(2));
	} catch (e) {
		console.error(`move-routes: ${e.message}`);
		code = 2;
	}
	process.exit(code);
}

module.exports = { planMove, regenerateContext, specText, readTree };
