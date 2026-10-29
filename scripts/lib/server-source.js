// The text a script reads as server.js: server.js with each route module's body
// spliced in at its mount line, `require("./routes/<name>")(ROUTE_CONTEXT);`,
// which is where its routes register when the server runs. Every column-0
// anchor a script lifts by (declarations, route heads, "\n});") stays as it was
// before the routes moved. With no mount line it is server.js byte for byte.
//
//   const { serverSource } = require("./lib/server-source");
//   const SRC = serverSource();
//
// Which server.js: SERVER_JS names one file (a base from before routes/
// existed); SERVER_ROOT names a full checkout of a base (for instance
// `git worktree add <dir> <base>`: runners read lib/ from it too). A
// caller's own { file } or { root } wins over both; setting both is an error.
// Following either prints one line on stderr per process.
//
// A module is found by its mount line only (no folder scan) and is spliced only
// in the shape the move tool writes; any other shape throws, so a script never
// lifts from a source it misread. virtualServer() adds a line map back to the
// real file and line.
//
// Pure apart from reading server.js and the modules it mounts.

"use strict";

const fs = require("fs");
const path = require("path");
const { DECL_START_RE } = require("./server-lift");

const REPO_ROOT = path.join(__dirname, "..", "..");
const SERVER_FILE = "server.js";
const MOUNT_RE = /^require\("\.\/routes\/([a-z0-9]+(?:-[a-z0-9]+)*)"\)\(ROUTE_CONTEXT\);$/;
// A require of anything under routes/, as a literal or a built path, so a mount
// in another form is refused rather than left out of the splice.
const ROUTE_REF_RE = /\brequire\s*\(\s*(?:["'`]\.\/routes\b|path\.(?:join|resolve)\([^)]*["'`]\.?\/?routes\b)/;
const CONTEXT_NAME_RE = /^\t[A-Za-z_$][\w$]*,$/;
const CATCH_ALL_HEAD = 'app.get("*", ';
const MODULE_HEAD = "module.exports = function mount({";
const MODULE_HEAD_END = "}) {";
const MODULE_END = "};";
const ROUTE_CONTEXT_HEAD = "const ROUTE_CONTEXT = {";
const REGISTRATION_RE = /^app\.(?:get|post|put|patch|delete|use|all)\(/;
const CLOSER_RE = /^[\]})`]/;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const USE_STRICT_RE = /^\s*(["'])use strict\1/;
const isComment = (l) => /^\s*\/\//.test(l);

// The base override in the environment: "SERVER_JS", "SERVER_ROOT" or null.
function serverOverride() {
	const envFile = process.env.SERVER_JS;
	const envRoot = process.env.SERVER_ROOT;
	if (envFile && envRoot) throw new Error("server-source: set SERVER_JS or SERVER_ROOT, not both");
	return envRoot ? "SERVER_ROOT" : envFile ? "SERVER_JS" : null;
}

// One line per process, so a run that follows an exported override says so.
let overrideNoticed = false;
function resolveServerFile({ file, root } = {}) {
	if (file && root) throw new Error("server-source: pass { file } or { root }, not both");
	if (file) return path.resolve(file);
	if (root) return path.join(path.resolve(root), SERVER_FILE);
	const override = serverOverride();
	if (!override) return path.join(REPO_ROOT, SERVER_FILE);
	const resolved = override === "SERVER_ROOT" ? path.join(path.resolve(process.env.SERVER_ROOT), SERVER_FILE) : path.resolve(process.env.SERVER_JS);
	if (!overrideNoticed) {
		overrideNoticed = true;
		process.stderr.write(`server-source: ${override} is set; reading ${resolved} and the route modules beside it\n`);
	}
	return resolved;
}

// A route module in the one shape the move tool writes:
//   <header: "//" comment or blank lines>
//   module.exports = function mount({ a, b, c }) {      (or the list over lines,
//   <body>                                                 closed by "}) {")
//   };
// The body's column-0 lines are registration heads, "//" comments and closers
// only (no declaration, which server-lift would index as a duplicate of
// server.js's), and no "use strict" (server.js is sloppy mode).
function checkModule(text, rel) {
	const fail = (line, why) => { throw new Error(`server-source: ${rel}${line ? `:${line}` : ""} ${why}`); };
	if (text.includes("\r")) fail(0, "has a carriage return (LF line ends only)");
	if (!text.endsWith(`\n${MODULE_END}\n`)) fail(0, `does not end with a "${MODULE_END}" line and one newline`);
	const lines = text.slice(0, -1).split("\n");
	const strict = lines.findIndex((l) => USE_STRICT_RE.test(l));
	if (strict >= 0) fail(strict + 1, "has \"use strict\" (route modules run as sloppy mode, like server.js)");
	let h = 0;
	while (h < lines.length && (lines[h] === "" || lines[h].startsWith("//"))) h++;
	if (h >= lines.length || !lines[h].startsWith(MODULE_HEAD)) fail(h + 1, `does not start with "${MODULE_HEAD}" after its header comment`);
	let headEnd = h;
	while (headEnd < lines.length - 1 && !lines[headEnd].endsWith(MODULE_HEAD_END)) headEnd++;
	if (headEnd >= lines.length - 1) fail(h + 1, `has no "${MODULE_HEAD_END}" closing the mount() parameter list`);
	if (headEnd > h && lines[headEnd] !== MODULE_HEAD_END) fail(headEnd + 1, `closes the parameter list with anything but a "${MODULE_HEAD_END}" line`);
	const params = lines.slice(h, headEnd + 1).join("\n").slice(MODULE_HEAD.length, -MODULE_HEAD_END.length);
	const names = params.split(",").map((n) => n.trim()).filter(Boolean);
	if (!names.length) fail(h + 1, "destructures no names");
	const bad = names.find((n) => !IDENT_RE.test(n));
	if (bad !== undefined) fail(h + 1, `destructures ${JSON.stringify(bad)}: plain names only (no rename, default or nesting)`);
	if (new Set(names).size !== names.length) fail(h + 1, "destructures a name twice");
	const bodyFrom = headEnd + 1;
	const body = lines.slice(bodyFrom, -1);
	let registrations = 0;
	let first = true;
	body.forEach((l, i) => {
		if (l === "" || /^\s/.test(l) || l.startsWith("//")) return;
		const at = bodyFrom + i + 1;
		if (DECL_START_RE.test(l)) fail(at, `declares at column 0 (${JSON.stringify(l.slice(0, 60))}); a module's code lives in server.js or inside a route`);
		if (REGISTRATION_RE.test(l)) { registrations++; first = false; return; }
		if (first) fail(at, `starts its body with ${JSON.stringify(l.slice(0, 60))}, not a route registration`);
		if (!CLOSER_RE.test(l)) fail(at, `has a column-0 line that is no registration, comment or closer (${JSON.stringify(l.slice(0, 60))})`);
	});
	const nested = body.findIndex((l) => ROUTE_REF_RE.test(l));
	if (nested >= 0) fail(bodyFrom + nested + 1, "mounts another route module");
	if (!registrations) fail(0, "registers no route");
	return { names, bodyFrom: bodyFrom + 1, body };
}

// The mount lines of a server.js text: [{ index (0-based line), name }]. Every
// code line naming ./routes/ must be an exact mount line; the mounts sit in one
// block (blank and comment lines between) above the SPA catch-all.
function mountLines(lines, rel = SERVER_FILE) {
	const fail = (i, why) => { throw new Error(`server-source: ${rel}:${i + 1} ${why}`); };
	const mounts = [];
	const seen = new Set();
	lines.forEach((l, i) => {
		if (isComment(l) || !ROUTE_REF_RE.test(l)) return;
		const m = MOUNT_RE.exec(l);
		if (!m) fail(i, `names a route module in any form but \`require("./routes/<name>")(ROUTE_CONTEXT);\` at column 0 (${JSON.stringify(l.slice(0, 80))})`);
		if (seen.has(m[1])) fail(i, `mounts routes/${m[1]}.js a second time`);
		seen.add(m[1]);
		mounts.push({ index: i, name: m[1] });
	});
	if (!mounts.length) return mounts;
	const first = mounts[0].index;
	const last = mounts[mounts.length - 1].index;
	for (let i = first; i <= last; i++) {
		if (lines[i] !== "" && !isComment(lines[i]) && !MOUNT_RE.test(lines[i])) fail(i, "sits inside the route-module mount block");
	}
	const catchAll = lines.findIndex((l) => l.startsWith(CATCH_ALL_HEAD));
	if (catchAll < 0) fail(last, `mounts route modules but has no SPA catch-all (${CATCH_ALL_HEAD}...) below them`);
	if (catchAll < last) fail(last, "mounts a route module below the SPA catch-all");
	return mounts;
}

// { text, file, modules, where(line), toVirtual(file, line) }: `where` takes a
// 1-based line of `text` and answers { file, line } in the real files
// ("server.js" or "routes/<name>.js", relative to the server.js folder);
// `toVirtual` goes the other way (null for a mount line, which the splice replaces).
function virtualServer(opts) {
	const file = resolveServerFile(opts);
	const raw = fs.readFileSync(file, "utf8");
	const readModule = (rel, mountLine) => {
		try {
			return fs.readFileSync(path.join(path.dirname(file), rel), "utf8");
		} catch (err) {
			throw new Error(`server-source: ${SERVER_FILE}:${mountLine} mounts ${rel}, which can't be read beside ${file} (${err.code || err.message}); a base with routes/ needs SERVER_ROOT, not SERVER_JS`);
		}
	};
	return { ...spliceModules(raw, readModule), file };
}

// The splice on text alone: `readModule(rel, mountLine)` hands back a mounted
// module's text or throws. It reads nothing itself, so the pre-push picker
// (scripts/lib/test-selection.js) splices through the reader it is given.
function spliceModules(raw, readModule) {
	const lines = raw.split("\n");
	const mounts = mountLines(lines);
	const segments = [];
	const modules = [];
	let at = 0;
	const out = [];
	const push = (rel, from, chunk) => {
		if (chunk.length) segments.push({ rel, from, virtualFrom: out.length + 1, count: chunk.length });
		out.push(...chunk);
	};
	for (const m of mounts) {
		const rel = `routes/${m.name}.js`;
		const mod = checkModule(readModule(rel, m.index + 1), rel);
		push(SERVER_FILE, at + 1, lines.slice(at, m.index));
		push(rel, mod.bodyFrom, mod.body);
		modules.push({ name: m.name, file: rel, mountLine: m.index + 1, names: mod.names });
		at = m.index + 1;
	}
	if (!mounts.length) {
		segments.push({ rel: SERVER_FILE, from: 1, virtualFrom: 1, count: lines.length });
		return { text: raw, modules, where: whereIn(segments), toVirtual: toVirtualIn(segments) };
	}
	push(SERVER_FILE, at + 1, lines.slice(at));
	return { text: out.join("\n"), modules, where: whereIn(segments), toVirtual: toVirtualIn(segments) };
}

function whereIn(segments) {
	return (line) => {
		const s = segments.find((g) => line >= g.virtualFrom && line < g.virtualFrom + g.count);
		if (!s) throw new Error(`server-source: line ${line} is outside the source (1-${segments.reduce((n, g) => n + g.count, 0)})`);
		return { file: s.rel, line: s.from + (line - s.virtualFrom) };
	};
}

function toVirtualIn(segments) {
	return (file, line) => {
		const s = segments.find((g) => g.rel === file && line >= g.from && line < g.from + g.count);
		return s ? s.virtualFrom + (line - s.from) : null;
	};
}

function serverSource(opts) {
	return virtualServer(opts).text;
}

// The 1-based lines { first, last } of the ROUTE_CONTEXT block in `text` (its
// `const ROUTE_CONTEXT = {` line through the `};` closing it), or null. An
// inventory of where a name is used skips the block, so it must list plain
// names only (one per line, as generated): anything else throws.
function routeContextLines(text) {
	const lines = text.split("\n");
	const heads = lines.reduce((out, l, i) => (l.startsWith(ROUTE_CONTEXT_HEAD) ? [...out, i] : out), []);
	if (!heads.length) return null;
	if (heads.length > 1) throw new Error("server-source: ROUTE_CONTEXT is declared twice");
	const head = heads[0];
	const notName = (i, l) => new Error(`server-source: ROUTE_CONTEXT line ${i + 1} is not a plain name (${JSON.stringify(l.slice(0, 80))}); the block lists names only`);
	if (lines[head].endsWith(MODULE_END)) {
		const inner = lines[head].slice(ROUTE_CONTEXT_HEAD.length, -MODULE_END.length);
		const bad = inner.split(",").map((n) => n.trim()).find((n, k, all) => (n ? !IDENT_RE.test(n) : k < all.length - 1));
		if (bad !== undefined) throw notName(head, lines[head]);
		return { first: head + 1, last: head + 1 };
	}
	const end = lines.indexOf(MODULE_END, head + 1);
	if (end < 0) throw new Error("server-source: the ROUTE_CONTEXT block never closes");
	for (let i = head + 1; i < end; i++) if (!CONTEXT_NAME_RE.test(lines[i])) throw notName(i, lines[i]);
	return { first: head + 1, last: end + 1 };
}

module.exports = { serverSource, virtualServer, spliceModules, checkModule, mountLines, resolveServerFile, serverOverride, routeContextLines, MOUNT_RE };
