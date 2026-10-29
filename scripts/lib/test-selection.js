// Picks the unit runners a push's changed files reach, for the pre-push hook
// (.githooks/pre-push runs scripts/run-unit-tests.js --changed-list ... inside
// its sandbox), and runs them in priority tiers inside a time budget.
//
// Pure: every input is passed in. It reads no file and starts no process; a
// reader that returns null means "not readable" and is never an error.
//
// THE MAP is built from the tree on every push, so no committed map can go
// stale. A runner is scripts/(test|check)-*.(js|mjs).
//   a. A changed runner picks itself (tier 0).
//   b. Code edges: relative require()/import specifiers, followed
//      transitively through lib/, scripts/, scripts/lib/ and client/.
//   c. Text edges: a repo file a runner (or a module it reaches) names in a
//      string literal: a path, a distinctive basename, or a distinctive
//      code-file name without its extension (require(path.join(__dirname,
//      "..", "lib", "x"))). Any file type: .vue, .json, .html, .sh, .yml, ...
//      A named code file is followed like a required one.
//   d. server.js, by declaration. No runner requires server.js; runners lift
//      pieces of it as text (scripts/lib/server-lift.js) from the virtual
//      source (scripts/lib/server-source.js: each mounted routes/<name>.js
//      body spliced in at its mount line), and the model is built from the
//      same splice. A runner's server.js world is the declarations it names
//      and the routes whose path it names, closed over the declarations those
//      pieces use (the walk closure() does), plus the lib/ file behind a lifted
//      `const x = require("./lib/x")`. A changed server.js line (mapped onto
//      the splice) picks the runners whose world holds the piece it falls in;
//      a comment or blank line belongs to what is directly below it. A changed
//      routes/<name>.js touches every piece of that module (file granularity).
//   e. A changed top-level statement of server.js (anything outside a
//      declaration or route, a removed declaration or route, a mount line)
//      picks every runner that names server.js (tier 3), as does a routes/
//      file the splice doesn't hold, or a tree it can't splice.
//   i. EVERY_SERVER_CHANGE runners check server.js and routes/ as a whole:
//      any change to either picks them (tier 2).
//   f. Folder scanners (readdirSync, git ls-files, a glob) run when a changed
//      file sits under a folder they name, and on any change when the folder
//      can't be read statically (tier 3).
//   g. RUN_ALL files pick every runner (tier 3).
//   h. A file no runner reaches picks none: lint covers it, CI runs everything.
//
// TIERS (lowest wins): 0 changed runners and the timing-sensitive runners the
// harness names; 1 dependents of changed non-server files; 2 server.js
// declaration matches; 3 top-level server.js, scanners, run-all.
//
// runTiered() runs them: timing-sensitive tier-0 runners first, alone; then a
// pool in tier order, shortest estimate first within a tier. Tier 0 always
// runs to the end. A tier 1-3 runner starts only if its estimate fits before
// the target (the budget less up to 10 s); at the budget, tier 1-3 runners
// still going are stopped and reported "cut off". Neither is a failure.

"use strict";

const path = require("path");
const lift = require("./server-lift");
const source = require("./server-source");

const RUNNER_RE = /^scripts\/(?:test|check)-[^/]*\.(?:js|mjs)$/;
const HARNESS = "scripts/run-unit-tests.js";
const CODE_RE = /\.(?:js|mjs|cjs)$/;
const SERVER = "server.js";
const ROUTE_FILE_RE = /^routes\/[^/]+\.js$/;
// They import the app or check the mount block as a whole, so no piece names them.
const EVERY_SERVER_CHANGE = ["scripts/test-route-snapshot.js", "scripts/test-route-modules.js"];

// A string as a literal inside a RegExp: every metacharacter escaped,
// backslash included.
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A change to any of these can change any runner's result.
const RUN_ALL = [
	/^scripts\/run-unit-tests\.js$/,
	/^scripts\/lib\/test-selection\.js$/,
	/^scripts\/lib\/server-source\.js$/,
	/^package\.json$/,
	/^package-lock\.json$/,
	/^client\/package\.json$/,
	/^client\/package-lock\.json$/,
	/^\.nvmrc$/,
	/^\.githooks\//,
];

// Names too common to tie a literal to one file.
const GENERIC_BASENAMES = new Set([
	"index.js", "index.mjs", "index.html", "package.json", "package-lock.json", "README.md",
	"main.js", "config.js", "utils.js", "app.js", "App.vue", "style.css",
]);
const GENERIC_STEMS = new Set([
	"index", "main", "config", "utils", "app", "server", "test", "lib", "client", "package",
	"readme", "setup", "start", "clean", "scripts", "src", "docs", "node", "path", "util",
]);
const MAX_CANDIDATES = 3;

const SPEC_RE = /(?:\brequire\s*\(\s*|\brequire\.resolve\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)(["'`])(\.{1,2}\/[^"'`\n]+)\1/g;
const LIT_RE = /(["'`])([A-Za-z0-9_./@-]{2,200})\1/g;
const SPEC_EXT = ["", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.mjs"];
const SCANNER_RE = /\breaddirSync\b|\breaddir\s*\(|\bopendirSync\b|["'`]ls-files["'`]|\bls-files\b|\bglobSync\b|\bglob\s*\(/;
const ROUTE_RE = /^(?:app|router|[A-Za-z_$][\w$]*Router)\.(?:get|post|put|patch|delete|use|all)\(\s*(["'`])([^"'`]+)\1/;
const DECL_HEAD_RE = /^(?:(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|(?:const|let|var)\s+\{([^}]*)\}\s*=|class\s+([A-Za-z_$][\w$]*))/;
const QUIET_RE = /^\s*(?:$|\/\/|\/\*|\*)/;
const WORD_RE = /[A-Za-z_$][\w$]*/g;
// Words every runner uses for its own reasons: as a root they would tie every
// runner to the declaration of the same name. Still followed as dependencies.
const ROOT_STOPWORDS = new Set([
	"app", "server", "path", "http", "https", "express", "router", "crypto", "util", "url",
	"zlib", "net", "child_process", "require", "process", "console", "module", "exports",
	"Buffer", "Date", "Math", "JSON", "Object", "Array", "String", "Number", "Promise",
	"Error", "Map", "Set", "Database", "fetch",
]);

const isRunner = (f) => RUNNER_RE.test(f) && f !== HARNESS;
const dirsOf = (f) => {
	const out = [];
	for (let d = path.posix.dirname(f); d !== "." && d !== "/"; d = path.posix.dirname(d)) out.push(d);
	return out;
};

// Every "/"-boundary suffix of a path: a/b/c.js -> a/b/c.js, b/c.js, c.js.
function suffixes(p) {
	const parts = p.split("/");
	return parts.map((_, i) => parts.slice(i).join("/"));
}

function addTo(map, key, value) {
	let s = map.get(key);
	if (!s) map.set(key, (s = new Set()));
	s.add(value);
}

// The server.js model: declarations (server-lift's own index) and route
// registrations, the line each starts and ends on, and what each depends on.
function serverModel(src) {
	const lines = src.split("\n");
	const offsets = [];
	let at = 0;
	for (const l of lines) { offsets.push(at); at += l.length + 1; }
	const lineOf = (off) => {
		let lo = 0;
		let hi = offsets.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (offsets[mid] <= off) lo = mid; else hi = mid - 1;
		}
		return lo + 1;
	};
	const { decls } = lift.indexDeclarations(src);
	const regions = [];
	const seen = new Set();
	for (const d of decls.values()) {
		if (seen.has(d)) continue;
		seen.add(d);
		regions.push({ kind: "decl", names: d.name.split(", "), from: lineOf(d.start), to: lineOf(Math.max(d.start, d.end - 1)), text: d.text });
	}
	for (let i = 0; i < lines.length; i++) {
		const m = ROUTE_RE.exec(lines[i]);
		if (!m) continue;
		let j = i;
		if (!/\);\s*$/.test(lines[i])) {
			j = i + 1;
			while (j < lines.length && lines[j] !== "});") j++;
			if (j === lines.length) j = i;
		}
		regions.push({ kind: "route", routePath: m[2], head: lines[i], from: i + 1, to: j + 1, text: lines.slice(i, j + 1).join("\n") });
	}
	regions.sort((x, y) => x.from - y.from || y.to - x.to);
	regions.forEach((r, k) => (r.id = k));

	// Line -> the region that starts closest above it and still covers it.
	const owner = new Int32Array(lines.length + 2).fill(-1);
	for (const r of regions) for (let l = r.from; l <= r.to && l <= lines.length; l++) owner[l] = r.id;

	const declared = new Map();
	for (const r of regions) if (r.kind === "decl") for (const n of r.names) declared.set(n, r.id);
	const routeHeads = new Set(regions.filter((r) => r.kind === "route").map((r) => r.head));
	const deps = regions.map((r) => {
		const out = new Set();
		for (const id of lift.codeIdentifiers(r.text)) {
			const k = declared.get(id);
			if (k !== undefined && k !== r.id) out.add(k);
		}
		return out;
	});
	// The lib/ files a piece lifts with it: `require("./lib/x")`.
	const libOf = regions.map((r) => {
		const out = new Set();
		for (const m of r.text.matchAll(SPEC_RE)) out.add(path.posix.normalize(m[2]));
		return out;
	});
	const quiet = (l) => l >= 1 && l <= lines.length && QUIET_RE.test(lines[l - 1]);
	// What a line belongs to: its region, or for a comment or blank line
	// outside every region, whatever is directly below it. null = top-level.
	const belongsTo = (l) => {
		let k = l;
		while (k <= lines.length && owner[k] === -1 && quiet(k)) k++;
		if (k > lines.length) return { region: null, top: false };
		if (owner[k] !== -1) return { region: owner[k], top: false };
		return { region: null, top: true };
	};
	const ownerOf = (l) => (l >= 1 && l <= lines.length && owner[l] !== -1 ? owner[l] : -1);
	return { regions, deps, libOf, declared, routeHeads, belongsTo, ownerOf, nLines: lines.length };
}

// The hunks of a `git diff -U0` of server.js, in the new file's numbering.
function parseUnifiedDiff(text) {
	const hunks = [];
	let cur = null;
	for (const line of String(text || "").split("\n")) {
		const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (h) {
			cur = { newStart: Number(h[3]), newCount: h[4] === undefined ? 1 : Number(h[4]), removed: [], added: [] };
			hunks.push(cur);
			continue;
		}
		if (!cur) continue;
		if (line.startsWith("-") && !line.startsWith("---")) cur.removed.push(line.slice(1));
		else if (line.startsWith("+") && !line.startsWith("+++")) cur.added.push(line.slice(1));
	}
	return hunks;
}

function declNames(line) {
	const m = DECL_HEAD_RE.exec(line);
	if (!m) return [];
	if (m[3] !== undefined) return m[3].split(",").map((b) => b.split(":").pop().split("=")[0].trim()).filter(Boolean);
	return [m[1] || m[2] || m[4]].filter(Boolean);
}

// Which pieces of server.js a diff touches, and whether it touches anything
// outside every piece (or removes a declaration or route the new file lacks).
// `toVirtual` maps a server.js line onto the model's lines (null: a mount line).
function touchedPieces(model, diffText, toVirtual = (l) => l) {
	const touched = new Set();
	let top = false;
	const why = [];
	const hunks = parseUnifiedDiff(diffText);
	const mark = (l) => {
		const v = toVirtual(l);
		if (v === null) { top = true; why.push(`mount line ${l}`); return; }
		const a = model.belongsTo(v);
		if (a.region !== null) touched.add(a.region);
		else if (a.top) { top = true; why.push(`line ${l}`); }
	};
	const ownerAt = (l) => {
		const v = toVirtual(l);
		return v === null ? -1 : model.ownerOf(v);
	};
	for (const h of hunks) {
		for (let k = 0; k < h.newCount; k++) mark(h.newStart + k);
		if (h.newCount === 0 && h.removed.length) {
			// A pure deletion sits between new lines newStart and newStart + 1:
			// inside one piece when both neighbours are in it.
			const above = ownerAt(h.newStart);
			const below = ownerAt(h.newStart + 1);
			if (above !== -1 && above === below) touched.add(above);
			else if (h.removed.every((l) => QUIET_RE.test(l))) mark(h.newStart + 1);
			else { top = true; why.push(`deletion after line ${h.newStart}`); }
		}
		for (const l of h.removed) {
			for (const n of declNames(l)) if (!model.declared.has(n)) { top = true; why.push(`removed declaration ${n}`); }
			if (ROUTE_RE.test(l) && !model.routeHeads.has(l)) { top = true; why.push("removed route"); }
			if (source.MOUNT_RE.test(l)) { top = true; why.push("removed mount line"); }
		}
	}
	return { touched, top, why, hunks: hunks.length };
}

/**
 * Builds the map from a file list and a reader.
 * files: repo-relative POSIX paths (tracked and untracked, not ignored).
 * read(rel): the file's text, or null when it can't be read.
 */
function buildMap({ files, read }) {
	const all = [...new Set(files)].sort();
	const fileSet = new Set(all);
	const runners = all.filter(isRunner);
	const bySuffix = new Map();
	const byStem = new Map();
	const dirSet = new Set();
	const dirBySuffix = new Map();
	for (const f of all) {
		for (const s of suffixes(f)) addTo(bySuffix, s, f);
		if (CODE_RE.test(f) && f !== SERVER) addTo(byStem, path.posix.basename(f).replace(CODE_RE, ""), f);
		for (const d of dirsOf(f)) dirSet.add(d);
	}
	for (const d of dirSet) for (const s of suffixes(d)) addTo(dirBySuffix, s, d);

	const srcCache = new Map();
	const src = (f) => {
		if (!srcCache.has(f)) {
			let t = null;
			try { t = read(f); } catch { t = null; }
			srcCache.set(f, typeof t === "string" ? t : null);
		}
		return srcCache.get(f);
	};

	// Edges out of one file, cached: code (resolved specifiers), text (files
	// named by path or distinctive basename), stems (code files named without
	// their extension, kebab or snake case only: "driver-availability", never
	// a plain word like "driver"), unresolved (what a specifier or a named
	// path would have been, for files a change deletes), and whether it names
	// server.js.
	const edgeCache = new Map();
	function edgesOf(f) {
		if (edgeCache.has(f)) return edgeCache.get(f);
		const e = { code: new Set(), text: new Set(), stems: new Set(), unresolved: new Set(), server: false };
		edgeCache.set(f, e);
		const s = src(f);
		if (s === null) return e;
		const fromDir = path.posix.dirname(f);
		for (const m of s.matchAll(SPEC_RE)) {
			const base = path.posix.normalize(path.posix.join(fromDir, m[2]));
			const hit = SPEC_EXT.map((x) => path.posix.normalize(base + x)).find((c) => fileSet.has(c));
			if (hit) e.code.add(hit);
			else for (const x of SPEC_EXT) e.unresolved.add(path.posix.normalize(base + x));
		}
		for (const m of s.matchAll(LIT_RE)) {
			const lit = m[2].replace(/^(?:\.{1,2}\/)+/, "").replace(/\/+$/, "");
			if (!lit || lit === "." || lit === "..") continue;
			if (lit === SERVER || lit.endsWith(`/${SERVER}`)) { e.server = true; continue; }
			if (lit.includes("/")) {
				for (const c of bySuffix.get(lit) || []) if (c !== SERVER) e.text.add(c);
				if (!bySuffix.has(lit) && !dirBySuffix.has(lit) && /\.[A-Za-z0-9]{1,5}$/.test(lit)) e.unresolved.add(lit);
				continue;
			}
			if (/\.[A-Za-z0-9]{1,5}$/.test(lit)) {
				const cands = bySuffix.get(lit);
				if (cands && cands.size <= MAX_CANDIDATES && !GENERIC_BASENAMES.has(lit)) for (const c of cands) if (c !== SERVER) e.text.add(c);
				if (!cands && !GENERIC_BASENAMES.has(lit)) e.unresolved.add(`*/${lit}`);
				continue;
			}
			if (/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/.test(lit) && !GENERIC_STEMS.has(lit.toLowerCase())) {
				const cands = byStem.get(lit);
				if (cands && cands.size <= MAX_CANDIDATES) for (const c of cands) e.stems.add(c);
			}
		}
		return e;
	}

	// The folders a scanner reads: path.join()/path.resolve() literal segments
	// spelling a repo folder, and multi-segment literals naming one, in the
	// runner's own file.
	function scannedDirs(s) {
		const dirs = new Set();
		for (const m of s.matchAll(/\bpath\.(?:join|resolve)\(([^()]*)\)/g)) {
			const segs = [...m[1].matchAll(/(["'`])([A-Za-z0-9_.@-][A-Za-z0-9_./@-]*)\1/g)].map((x) => x[2]);
			for (let i = 0; i < segs.length; i++) {
				const joined = path.posix.normalize(segs.slice(i).join("/")).replace(/^(?:\.{1,2}\/)+/, "").replace(/\/+$/, "");
				if (dirSet.has(joined)) { dirs.add(joined); break; }
				const parent = path.posix.dirname(joined);
				if (fileSet.has(joined) && dirSet.has(parent)) break;
			}
		}
		for (const m of s.matchAll(LIT_RE)) {
			const lit = m[2].replace(/^(?:\.{1,2}\/)+/, "").replace(/\/+$/, "");
			if (lit.includes("/") && dirSet.has(lit)) dirs.add(lit);
		}
		return dirs;
	}

	const reach = new Map(); // runner -> Set of files it reaches (code or text)
	const helpers = new Map(); // runner -> its own file plus the scripts/lib helpers it reaches
	const unresolvedOf = new Map(); // candidate path -> Set of runners
	const scanners = new Map(); // runner -> { dirs: Set, unknown: bool }
	const serverRunners = new Set();
	for (const r of runners) {
		const seen = new Set([r]);
		const stack = [r];
		const own = [r];
		let names = false;
		while (stack.length) {
			const f = stack.pop();
			if (!CODE_RE.test(f) || f === SERVER) continue;
			const e = edgesOf(f);
			// A runner and the scripts/ code it runs: every kind of edge. A
			// client/ module: code and text edges (an .mjs runner reaching an SFC
			// through the client's own modules). An app module (lib/): code only.
			const ownSide = f === r || f.startsWith("scripts/");
			if (ownSide) {
				if (e.server) names = true;
				if (f !== r && f.startsWith("scripts/lib/")) own.push(f);
			}
			const next = [...e.code];
			if (ownSide || f.startsWith("client/")) next.push(...e.text);
			if (ownSide) next.push(...e.stems);
			if (ownSide || f.startsWith("client/")) for (const u of e.unresolved) addTo(unresolvedOf, u, r);
			for (const n of next) {
				if (seen.has(n)) continue;
				seen.add(n);
				stack.push(n);
			}
		}
		reach.set(r, seen);
		helpers.set(r, own);
		if (names) serverRunners.add(r);
		const s = src(r);
		if (s !== null && SCANNER_RE.test(s)) {
			const dirs = scannedDirs(s);
			scanners.set(r, { dirs, unknown: dirs.size === 0 });
		}
	}

	// server.js worlds, on the splice the runners lift from. A tree it can't
	// splice (an unreadable or misshapen module) has no model.
	let server = null;
	let splice = null;
	const serverSrc = fileSet.has(SERVER) && serverRunners.size ? src(SERVER) : null;
	if (serverSrc !== null) {
		try {
			splice = source.spliceModules(serverSrc, (rel) => {
				const t = src(rel);
				if (t === null) throw new Error(`can't read ${rel}`);
				return t;
			});
		} catch { splice = null; }
	}
	if (splice !== null) {
		const model = serverModel(splice.text);
		const worlds = new Map();
		const wholeFile = new Set();
		for (const r of serverRunners) {
			const text = helpers.get(r).map((f) => src(f) || "").join("\n");
			const words = new Set(text.match(WORD_RE) || []);
			// Names the runner supplies itself (closure()'s `provided`): never
			// lifted, so never followed.
			const provided = new Set();
			for (const m of text.matchAll(/\bprovided\s*:\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)/g)) {
				let list = m[1];
				if (!list.startsWith("[")) {
					const def = new RegExp(`\\b(?:const|let|var)\\s+${reEscape(list)}\\s*=\\s*(\\[[^\\]]*\\])`).exec(text);
					list = def ? def[1] : "";
				}
				for (const x of list.matchAll(/(["'`])([A-Za-z_$][\w$]*)\1/g)) provided.add(x[2]);
			}
			const providedIds = new Set([...provided].map((n) => model.declared.get(n)).filter((k) => k !== undefined));
			const roots = [];
			for (const reg of model.regions) {
				if (providedIds.has(reg.id)) continue;
				if (reg.kind === "decl" ? reg.names.some((n) => n.length > 2 && !ROOT_STOPWORDS.has(n) && words.has(n)) : reg.routePath.length > 4 && text.includes(reg.routePath)) roots.push(reg.id);
			}
			if (!roots.length) { wholeFile.add(r); continue; }
			const world = new Set(roots);
			const q = [...roots];
			while (q.length) for (const k of model.deps[q.shift()]) if (!world.has(k) && !providedIds.has(k)) (world.add(k), q.push(k));
			worlds.set(r, world);
			// The lib/ files behind lifted requires, and what they reach.
			const seen = reach.get(r);
			const stack = [];
			for (const k of world) for (const spec of model.libOf[k]) {
				const hit = SPEC_EXT.map((x) => path.posix.normalize(spec + x)).find((c) => fileSet.has(c));
				if (hit && !seen.has(hit)) (seen.add(hit), stack.push(hit));
			}
			while (stack.length) {
				const e = edgesOf(stack.pop());
				for (const next of e.code) if (next !== SERVER && !seen.has(next)) (seen.add(next), stack.push(next));
			}
		}
		// Each route module's pieces, by the file they live in.
		const moduleRegions = new Map();
		for (const reg of model.regions) {
			const at = splice.where(reg.from).file;
			if (at !== SERVER) addTo(moduleRegions, at, reg.id);
		}
		const modules = new Set(splice.modules.map((m) => m.file));
		server = { model, worlds, wholeFile, moduleRegions, modules, toVirtual: (l) => splice.toVirtual(SERVER, l) };
	}

	const reverse = new Map();
	for (const [r, files] of reach) for (const f of files) if (f !== r) addTo(reverse, f, r);
	return { files: fileSet, runners, reach, reverse, unresolvedOf, scanners, serverRunners, server };
}

/**
 * Which runners a change picks, and at which tier.
 * changed: repo-relative paths (deleted ones included).
 * serverDiff: `git diff -U0 <base> -- server.js` against the working tree.
 * tierZero: runners that run in tier 0 whenever they are picked.
 */
function select(map, { changed, serverDiff = "", tierZero = [] }) {
	const picked = new Map();
	const why = new Map();
	const pick = (r, tier, reason) => {
		if (!map.runners.includes(r)) return;
		if (!picked.has(r) || tier < picked.get(r)) { picked.set(r, tier); why.set(r, reason); }
	};
	const files = [...new Set(changed)].filter(Boolean);
	const runAll = files.find((f) => RUN_ALL.some((re) => re.test(f))) || null;
	if (runAll) for (const r of map.runners) pick(r, 3, `run-all: ${runAll}`);
	for (const f of files) {
		if (isRunner(f)) pick(f, 0, "changed");
		if (f === SERVER) continue;
		for (const r of map.reverse.get(f) || []) pick(r, 1, `reaches ${f}`);
		if (!map.files.has(f)) {
			for (const r of map.unresolvedOf.get(f) || []) pick(r, 1, `named ${f}, now gone`);
			for (const r of map.unresolvedOf.get(`*/${path.posix.basename(f)}`) || []) pick(r, 1, `named ${f}, now gone`);
		}
	}
	if (files.length) {
		for (const [r, s] of map.scanners) {
			if (s.unknown) { pick(r, 3, "scans a folder it builds at run time"); continue; }
			const hit = files.find((f) => dirsOf(f).some((d) => s.dirs.has(d)));
			if (hit) pick(r, 3, `scans the folder of ${hit}`);
		}
	}
	let serverInfo = null;
	const routeFiles = files.filter((f) => ROUTE_FILE_RE.test(f));
	if (files.includes(SERVER) || routeFiles.length) {
		for (const r of EVERY_SERVER_CHANGE) pick(r, 2, "server.js or routes/ changed");
	}
	if (files.includes(SERVER)) {
		if (!map.server) {
			for (const r of map.serverRunners) pick(r, 3, "server.js changed (no model)");
		} else {
			const t = touchedPieces(map.server.model, serverDiff, map.server.toVirtual);
			serverInfo = { pieces: t.touched.size, top: t.top, hunks: t.hunks, why: t.why };
			if (t.top || t.hunks === 0) {
				for (const r of map.serverRunners) pick(r, 3, `server.js top-level (${t.why[0] || "no hunk read"})`);
			}
			for (const r of map.server.wholeFile) pick(r, 2, "server.js changed (names no piece)");
			for (const [r, world] of map.server.worlds) {
				for (const k of t.touched) if (world.has(k)) { pick(r, 2, "server.js piece it lifts"); break; }
			}
		}
	}
	if (routeFiles.length) {
		const stray = map.server ? routeFiles.find((f) => !map.server.modules.has(f)) : routeFiles[0];
		if (stray) {
			for (const r of map.serverRunners) pick(r, 3, map.server ? `${stray} is not a mounted module` : `${stray} changed (no model)`);
		} else {
			const touched = new Set();
			for (const f of routeFiles) for (const k of map.server.moduleRegions.get(f) || []) touched.add(k);
			for (const r of map.server.wholeFile) pick(r, 2, "routes/ changed (names no piece)");
			for (const [r, world] of map.server.worlds) {
				for (const k of touched) if (world.has(k)) { pick(r, 2, "routes/ piece it lifts"); break; }
			}
		}
	}
	for (const r of tierZero) if (picked.has(r)) pick(r, 0, `${why.get(r)}; timing-sensitive`);
	return { picked, why, runAll, server: serverInfo };
}

// Workers for a pushed run: the cores less one, less the 1-minute load
// average, never fewer than 2 (or 1 on a one- or two-core machine).
function workersFor(cores, load1) {
	const max = Math.max(1, cores - 1);
	const want = cores - 1 - Math.round(Number.isFinite(load1) ? load1 : 0);
	return Math.min(max, Math.max(2, want));
}

// Tier order, shortest estimate first within a tier.
function order(items) {
	return [...items].sort((a, b) => a.tier - b.tier || a.est - b.est || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * Runs picked runners in tiers inside a budget.
 * items: [{ file, tier, est }]
 * start(file): { done: Promise<result>, kill(): void } where result has ok.
 * alone: files that run one at a time before the pool (timing-sensitive).
 * retryOnce: files allowed one retry.
 * onResult(result): called as each finishes.
 */
async function runTiered({ items, workers, budgetMs = Infinity, startedAt = Date.now(), start, alone = new Set(), retryOnce = new Set(), onResult = () => {}, now = Date.now }) {
	const slack = Number.isFinite(budgetMs) ? Math.min(10000, Math.round(budgetMs * 0.1)) : 0;
	const target = startedAt + budgetMs - slack;
	const deadline = startedAt + budgetMs;
	const results = [];
	const notRun = [];
	const running = new Set();
	let pastDeadline = false;

	async function runItem(it) {
		const job = start(it.file);
		const entry = { it, job, cut: false };
		running.add(entry);
		let r = await job.done;
		running.delete(entry);
		if (entry.cut) r = { ...r, ok: false, cut: true };
		if (!r.ok && !r.cut && retryOnce.has(it.file)) {
			const first = r;
			r = await runItem(it);
			r.firstAttempt = first;
			r.retried = true;
			return r;
		}
		return r;
	}
	const finish = (it, r) => {
		const out = { ...r, file: it.file, tier: it.tier };
		results.push(out);
		onResult(out);
	};

	const sorted = order(items);
	for (const it of sorted.filter((x) => alone.has(x.file))) {
		if (it.tier > 0 && now() + it.est > target) { notRun.push(it); continue; }
		finish(it, await runItem(it));
	}
	const queue = sorted.filter((x) => !alone.has(x.file));
	let timer = null;
	if (Number.isFinite(budgetMs)) {
		timer = setTimeout(() => {
			pastDeadline = true;
			for (const e of running) if (e.it.tier > 0) { e.cut = true; e.job.kill(); }
		}, Math.max(0, deadline - now()));
	}
	async function worker() {
		while (queue.length) {
			const it = queue.shift();
			if (it.tier > 0 && (pastDeadline || now() + it.est > target)) { notRun.push(it); continue; }
			finish(it, await runItem(it));
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, queue.length || 1)) }, worker));
	if (timer) clearTimeout(timer);
	return { results, notRun, cut: results.filter((r) => r.cut) };
}

// What a tiered run comes to. A runner cut off at the budget, or never
// started for time, is not a failure: CI runs it. Only one that ran and
// failed (or timed out) is.
function tally({ results, notRun }) {
	const cut = results.filter((r) => r.cut);
	const ran = results.filter((r) => !r.cut);
	const failed = ran.filter((r) => !r.ok);
	return { ran: ran.length, cut: cut.length, notRun: notRun.length, failed: failed.length, failedResults: failed, passed: failed.length === 0 };
}

// The summary line a pushed run ends with (before the verdict).
function summaryLine({ ran, picked, seconds, notRun, cut, failed }) {
	const cutPart = cut ? `, ${cut} cut off` : "";
	const failPart = failed ? `; ${failed} FAILED` : "";
	return `Ran ${ran} of ${picked} picked runners in ${seconds.toFixed(1)} s; ${notRun} not run for time${cutPart} (CI runs them)${failPart}. Full suite: npm run check.`;
}

const VERDICT_PREFIX = "pre-push verdict:";
function verdictLine({ lint, selection, runners }) {
	return `${VERDICT_PREFIX} lint=${lint} selection=${selection} runners=${runners}`;
}

module.exports = {
	RUNNER_RE, RUN_ALL, HARNESS, EVERY_SERVER_CHANGE,
	buildMap, select, serverModel, parseUnifiedDiff, touchedPieces,
	workersFor, order, runTiered, tally, summaryLine, verdictLine, VERDICT_PREFIX,
};
