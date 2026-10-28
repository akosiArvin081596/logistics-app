// The shared reader for the route split: route modules (routes/<name>.js) that
// server.js mounts through ROUTE_CONTEXT, directly above the SPA catch-all.
// scripts/split/move-routes.js writes them with it and
// scripts/test-route-modules.js checks them with it, so the two can't disagree.
//
// Pure: text in, facts out; it reads no file. A `readLib(rel)` callback, where
// one is taken, returns a lib/ file's text or null.
//
// Spans and names come from one scanner that knows strings, templates (regex
// literals inside `${…}` included), comments and regex literals, and stops on a
// string that crosses a line; the JS parser then re-checks every registration
// it cuts (compiled, never called): the call must parse as one expression and
// close on its last line, so a scanner slip stops the tool instead of cutting
// the wrong text or missing a name.

"use strict";

const CONTEXT = "ROUTE_CONTEXT";
const ROUTE_DIR = "routes";
const METHODS = ["get", "post", "put", "patch", "delete", "all"];
const HEAD_RE = /^app\.(get|post|put|patch|delete|use|all)\(/;
const MODULE_HEAD_RE = /^app\.(get|post|put|patch|delete|all)\(/;
const CATCH_ALL_RE = /^app\.get\(\s*"\*"/;
const MOUNT_RE = /^require\("\.\/routes\/([a-z0-9]+(?:-[a-z0-9]+)*)"\)\(ROUTE_CONTEXT\);$/;
const SIGNATURE_RE = /^module\.exports = function mount\(\{ ([A-Za-z_$][\w$]*(?:, [A-Za-z_$][\w$]*)*) \}\) \{$/;
const MODULE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DECL_RE = /^(?:(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|(const|let|var)\s+\{([^}]*)\}\s*=|class\s+([A-Za-z_$][\w$]*))/;
const INDENTED_DECL_RE = /^\s+(?:async\s+function|function|const|let|var|class)\b/;

const MOUNT_COMMENT = [
	"// Route modules (routes/): mounted here, below every const they read and above the SPA catch-all,",
	"// so each route keeps its place in the match order. Generated with the require lines below by",
	"// scripts/split/move-routes.js (--context after a top-level function or const changes).",
];
const moduleHeader = (about) => [
	`// ${about}`,
	"// Mounted by server.js above the SPA catch-all; the parameters are server.js's own functions and",
	"// consts, passed in ROUTE_CONTEXT. No strict-mode directive: the code keeps server.js's sloppy mode.",
];

// Names a moved route or a module must not use, and why. Timers and jobs stay
// in server.js behind its job gate; the rest resolve to the module file's own
// CommonJS scope instead of server.js's.
const FORBIDDEN = new Map([
	["startsJob", "starts a background job (jobs stay in server.js, behind its job gate)"],
	["setInterval", "starts a timer (timers stay in server.js, behind its job gate)"],
	["__dirname", "resolves to routes/, not the repo root"],
	["__filename", "resolves to the module file, not server.js"],
	["module", "names the route module's own CommonJS module"],
	["exports", "names the route module's own CommonJS exports"],
]);
// The move tool also refuses these: their meaning at the top of a handler
// depends on the scope the code sits in.
const MOVE_FORBIDDEN = new Map([
	...FORBIDDEN,
	["this", "reads `this`, which is bound differently inside the mount function"],
	["arguments", "reads `arguments`, which is bound differently inside the mount function"],
]);

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function parses(text) {
	try {
		// A syntax check only (compiled, never called).
		new Function(text);
		return true;
	} catch {
		return false;
	}
}

// ------------------------------------------------------------------ scanner
const CODE = 0;
const LINE_COMMENT = 1;
const BLOCK_COMMENT = 2;
const STRING = 3;
const TEMPLATE = 4;
const REGEX = 5;
const PAIR = { ")": "(", "]": "[", "}": "{" };
// After these a "/" starts a regex literal; after a name, a number, ")" or "]"
// it divides.
const REGEX_AFTER = new Set(["", "kw", "...", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const WORDS_BEFORE_EXPRESSION = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "else", "do", "instanceof", "yield", "await"]);
// The code tokens after which a line can start a statement of its own: after
// ")" or "else" it would be the body of an if, else or loop.
const STATEMENT_AFTER = new Set(["", ";", "}"]);

// For every line: its start offset, whether it starts in code at bracket depth
// 0 (a top-level statement can start there) and the code token before it. For
// every bracket opened at depth 0: where it closes and where its first depth-1
// comma is. Every name used in code ({ name, at }; property names after "."
// are not uses).
function scanSource(src) {
	const lineStart = [0];
	const lineTop = [true];
	const prevAtLine = [""];
	const opens = new Map();
	const ids = [];
	const stack = [];
	let mode = CODE;
	let quote = "";
	let inClass = false;
	let prev = "";
	const fail = (what) => { throw new Error(`source scan: ${what} (line ${lineStart.length})`); };
	const newline = (i) => {
		lineStart.push(i + 1);
		lineTop.push(mode === CODE && stack.length === 0);
		prevAtLine.push(prev);
	};
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (mode === LINE_COMMENT) {
			if (ch === "\n") { mode = CODE; newline(i); }
			continue;
		}
		if (mode === BLOCK_COMMENT) {
			if (ch === "\n") newline(i);
			else if (ch === "*" && src[i + 1] === "/") { mode = CODE; i++; }
			continue;
		}
		if (mode === STRING) {
			if (ch === "\\") { i++; if (src[i] === "\n") newline(i); continue; }
			if (ch === "\n") fail("a string runs past the end of its line");
			if (ch === quote) { mode = CODE; prev = "lit"; }
			continue;
		}
		if (mode === TEMPLATE) {
			if (ch === "\\") { i++; if (src[i] === "\n") newline(i); continue; }
			if (ch === "\n") { newline(i); continue; }
			if (ch === "`") { mode = CODE; prev = "lit"; continue; }
			if (ch === "$" && src[i + 1] === "{") { stack.push({ ch: "${", at: i }); mode = CODE; prev = "("; i++; }
			continue;
		}
		if (mode === REGEX) {
			if (ch === "\n") fail("a regex literal runs past the end of its line");
			if (ch === "\\") { i++; continue; }
			if (inClass) { if (ch === "]") inClass = false; continue; }
			if (ch === "[") { inClass = true; continue; }
			if (ch === "/") {
				mode = CODE;
				while (/[A-Za-z]/.test(src[i + 1] || "")) i++;
				prev = "lit";
			}
			continue;
		}
		if (ch === "\n") { newline(i); continue; }
		if (ch === " " || ch === "\t" || ch === "\r") continue;
		if (ch === "/") {
			if (src[i + 1] === "/") { mode = LINE_COMMENT; i++; continue; }
			if (src[i + 1] === "*") { mode = BLOCK_COMMENT; i++; continue; }
			if (REGEX_AFTER.has(prev)) { mode = REGEX; inClass = false; continue; }
			prev = "/";
			continue;
		}
		if (ch === '"' || ch === "'") { mode = STRING; quote = ch; continue; }
		if (ch === "`") { mode = TEMPLATE; continue; }
		if (ch === "(" || ch === "[" || ch === "{") {
			if (stack.length === 0) opens.set(i, { close: -1, firstComma: -1 });
			stack.push({ ch, at: i });
			prev = ch;
			continue;
		}
		if (ch === ")" || ch === "]" || ch === "}") {
			const top = stack.pop();
			if (!top) fail(`an unmatched "${ch}"`);
			if (top.ch === "${") {
				if (ch !== "}") fail(`a template expression closed by "${ch}"`);
				mode = TEMPLATE;
				continue;
			}
			if (top.ch !== PAIR[ch]) fail(`"${top.ch}" closed by "${ch}"`);
			if (stack.length === 0) opens.get(top.at).close = i;
			prev = ch;
			continue;
		}
		if (ch === ",") {
			if (stack.length === 1 && stack[0].ch !== "${") {
				const o = opens.get(stack[0].at);
				if (o.firstComma === -1) o.firstComma = i;
			}
			prev = ",";
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			let j = i + 1;
			while (j < src.length && /[\w$]/.test(src[j])) j++;
			const word = src.slice(i, j);
			if (prev === ".") prev = "w";
			else {
				ids.push({ name: word, at: i });
				prev = WORDS_BEFORE_EXPRESSION.has(word) ? "kw" : "w";
			}
			i = j - 1;
			continue;
		}
		if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] || ""))) {
			let j = i + 1;
			while (j < src.length && /[\w.]/.test(src[j])) j++;
			prev = "w";
			i = j - 1;
			continue;
		}
		if (ch === "." && src[i + 1] === "." && src[i + 2] === ".") { prev = "..."; i += 2; continue; }
		prev = ch;
	}
	if (mode !== CODE && mode !== LINE_COMMENT) fail("the text ends inside a string, template, regex or comment");
	if (stack.length) fail(`"${stack[stack.length - 1].ch}" never closes`);
	return { lineStart, lineTop, prevAtLine, opens, ids };
}

// The names a piece of code uses, in order (with repeats).
function usedNames(text) {
	return scanSource(text).ids.map((t) => t.name);
}

function lineOfOffset(scan, off) {
	let lo = 0;
	let hi = scan.lineStart.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (scan.lineStart[mid] <= off) lo = mid; else hi = mid - 1;
	}
	return lo;
}

// --------------------------------------------------------- path expressions
const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };

// A quoted literal's value from the text between its quotes, decoding
// JavaScript's escapes one by one (never by re-escaping into another format);
// null for an escape it can't read (a legacy octal, a bad \x or \u).
function unescapeLiteral(body) {
	let out = "";
	for (let i = 0; i < body.length; i++) {
		if (body[i] !== "\\") { out += body[i]; continue; }
		const e = body[++i];
		if (e === undefined) return null;
		if (e === "x" || (e === "u" && body[i + 1] !== "{")) {
			const n = e === "x" ? 2 : 4;
			const hex = body.slice(i + 1, i + 1 + n);
			if (hex.length !== n || !/^[0-9a-fA-F]+$/.test(hex)) return null;
			out += String.fromCharCode(parseInt(hex, 16));
			i += n;
		} else if (e === "u") {
			const close = body.indexOf("}", i);
			const hex = close === -1 ? "" : body.slice(i + 2, close);
			if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null;
			out += String.fromCodePoint(parseInt(hex, 16));
			i = close;
		} else if (e === "0" && !/[0-9]/.test(body[i + 1] || "")) out += "\0";
		else if (/[0-9]/.test(e)) return null;
		else if (e === "\n") continue;
		else out += Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, e) ? SIMPLE_ESCAPES[e] : e;
	}
	return out;
}

function stringLiteral(t) {
	if (/^"(?:[^"\\\n]|\\.)*"$/.test(t) || /^'(?:[^'\\\n]|\\.)*'$/.test(t)) return unescapeLiteral(t.slice(1, -1));
	if (/^`[^`\\$]*`$/.test(t)) return t.slice(1, -1);
	return null;
}

function splitTopLevelCommas(t) {
	const out = [];
	let depth = 0;
	let q = "";
	let from = 0;
	for (let i = 0; i < t.length; i++) {
		const ch = t[i];
		if (q) { if (ch === "\\") i++; else if (ch === q) q = ""; continue; }
		if (ch === '"' || ch === "'" || ch === "`") q = ch;
		else if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) depth--;
		else if (ch === "," && depth === 0) { out.push(t.slice(from, i).trim()); from = i + 1; }
	}
	const last = t.slice(from).trim();
	if (last) out.push(last);
	return out;
}

// The key a registration is named by: "METHOD path" for a literal path, the
// array as JSON-style text for several, else the argument as written.
function pathKey(argText) {
	const t = argText.replace(/\s+/g, " ").trim();
	const one = stringLiteral(t);
	if (one !== null) return one;
	if (/^\[.*\]$/.test(t)) {
		const parts = splitTopLevelCommas(t.slice(1, -1)).map(stringLiteral);
		if (parts.length && parts.every((p) => p !== null)) return `[${parts.map((p) => JSON.stringify(p)).join(", ")}]`;
	}
	return t;
}

// The paths a first argument stands for, or null when it can't be read
// statically. `consts` resolves a bare name, `member` an `x.NAME` reference.
function resolvePaths(argText, { consts = () => null, member = () => null } = {}) {
	const t = argText.replace(/\s+/g, " ").trim();
	const one = (x) => {
		const lit = stringLiteral(x);
		if (lit !== null) return lit;
		if (/^`[^`\\]*`$/.test(x)) {
			let ok = true;
			const s = x.slice(1, -1).replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (_, n) => {
				const v = consts(n);
				if (typeof v !== "string") ok = false;
				return v || "";
			});
			return ok && !s.includes("${") ? s : null;
		}
		if (/^[A-Za-z_$][\w$]*$/.test(x)) { const v = consts(x); return typeof v === "string" ? v : null; }
		const m = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(x);
		if (m) { const v = member(m[1], m[2]); return typeof v === "string" ? v : null; }
		return null;
	};
	if (/^\[.*\]$/.test(t)) {
		const parts = splitTopLevelCommas(t.slice(1, -1)).map(one);
		return parts.length && parts.every((p) => p !== null) ? parts : null;
	}
	const v = one(t);
	return v === null ? null : [v];
}

// `const NAME = "literal"` anywhere in a file (indented or not), as a lookup.
function stringConsts(text) {
	const map = new Map();
	for (const m of text.matchAll(/^\s*const ([A-Za-z_$][\w$]*) = ("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`\\$\n]*`);/gm)) {
		if (!map.has(m[1])) map.set(m[1], stringLiteral(m[2]));
	}
	return map;
}

// ------------------------------------------------------------ registrations
// Every top-level `app.<method>(` registration: its head line, the line its own
// parenthesis closes on, the contiguous column-0 comment block above it, and
// `after`, the code token before it (a statement of its own follows "", ";" or
// "}"; anything else makes it part of an if, else, loop or expression).
// Lines are 1-based.
function registrations(src, scan = scanSource(src), { headRe = HEAD_RE } = {}) {
	const lines = src.split("\n");
	const out = [];
	for (let k = 0; k < lines.length; k++) {
		if (!scan.lineTop[k]) continue;
		const m = headRe.exec(lines[k]);
		if (!m) continue;
		const startOff = scan.lineStart[k];
		const open = startOff + m[0].length - 1;
		const o = scan.opens.get(open);
		if (!o || o.close === -1) throw new Error(`registration at line ${k + 1}: its parenthesis never closes`);
		const endK = lineOfOffset(scan, o.close);
		const rest = lines[endK].slice(o.close - scan.lineStart[endK] + 1);
		if (!/^;?[ \t]*(?:\/\/.*)?$/.test(rest)) throw new Error(`registration at line ${k + 1}: code follows its closing parenthesis on line ${endK + 1}`);
		if (!parses(`return (\n${src.slice(startOff, o.close + 1)}\n);`)) throw new Error(`registration at line ${k + 1}: lines ${k + 1}-${endK + 1} do not parse as one expression`);
		let from = k;
		while (from > 0 && scan.lineTop[from - 1] && lines[from - 1].startsWith("//")) from--;
		const argText = src.slice(open + 1, o.firstComma === -1 ? o.close : o.firstComma);
		const method = m[1];
		const key = `${method.toUpperCase()} ${pathKey(argText)}`;
		const after = scan.prevAtLine[k];
		const inner = src.slice(open + 1, o.close);
		out.push({ method, key, argText, inner, from: from + 1, line: k + 1, end: endK + 1, startOff, closeOff: o.close, after, standalone: STATEMENT_AFTER.has(after) });
	}
	return out;
}

// --------------------------------------------------------- top-level names
// Every top-level declaration (column 0, depth 0, in code): name, kind
// ("function" | "const" | "let" | "var" | "class") and 1-based line.
function topLevelDeclarations(src, scan = scanSource(src)) {
	const lines = src.split("\n");
	const out = [];
	const indented = [];
	for (let k = 0; k < lines.length; k++) {
		if (!scan.lineTop[k]) continue;
		const l = lines[k];
		if (INDENTED_DECL_RE.test(l)) { indented.push(k + 1); continue; }
		const m = DECL_RE.exec(l);
		if (!m) continue;
		if (m[2]) out.push({ name: m[2], kind: "function", line: k + 1 });
		else if (m[4]) out.push({ name: m[4], kind: m[3], line: k + 1 });
		else if (m[6] !== undefined) {
			for (const b of m[6].split(",")) {
				const n = b.split(":").pop().split("=")[0].trim();
				if (n) out.push({ name: n, kind: m[5], line: k + 1 });
			}
		} else if (m[7]) out.push({ name: m[7], kind: "class", line: k + 1 });
	}
	return { decls: out, indented };
}

// The names ROUTE_CONTEXT holds for a mount block starting at `mountLine`:
// every top-level function (hoisted), and every const declared above the
// block; never a let (a module would get a copy, not the binding).
function contextNames(decls, mountLine) {
	const names = new Set();
	for (const d of decls) {
		if (d.name === CONTEXT) continue;
		if (d.kind === "function" || ((d.kind === "const" || d.kind === "class") && d.line < mountLine)) names.add(d.name);
	}
	return [...names].sort(byCodeUnit);
}

// The line the mount block goes above when there is none yet: the first line
// of the catch-all's own comment block.
function catchAll(src, scan = scanSource(src)) {
	const lines = src.split("\n");
	const hits = [];
	for (let k = 0; k < lines.length; k++) if (scan.lineTop[k] && CATCH_ALL_RE.test(lines[k])) hits.push(k);
	if (hits.length !== 1) return { error: `expected one SPA catch-all app.get("*", …), found ${hits.length}` };
	let from = hits[0];
	while (from > 0 && scan.lineTop[from - 1] && lines[from - 1].startsWith("//")) from--;
	return { line: hits[0] + 1, commentFrom: from + 1 };
}

// The mount block, or null: its comment, the ROUTE_CONTEXT const and the
// require lines after it (1-based, inclusive).
function mountBlock(src, scan = scanSource(src)) {
	const lines = src.split("\n");
	const at = [];
	for (let k = 0; k < lines.length; k++) if (lines[k] === `const ${CONTEXT} = {`) at.push(k);
	if (!at.length) return null;
	if (at.length > 1) return { error: `${CONTEXT} is declared ${at.length} times` };
	const c = at[0];
	if (!scan.lineTop[c]) return { error: `${CONTEXT} is not a top-level declaration` };
	// The block starts at its generated comment; any other comment touching it
	// is refused rather than rewritten away by --context.
	const from = c - MOUNT_COMMENT.length;
	if (from < 0 || lines.slice(from, c).join("\n") !== MOUNT_COMMENT.join("\n")) return { error: `the comment directly above ${CONTEXT} (line ${c + 1}) is not the generated one; restore it, keeping other comments apart with a blank line` };
	if (from > 0 && lines[from - 1].startsWith("//")) return { error: `a comment touches the mount block (line ${from}); keep it apart with a blank line` };
	const names = [];
	let k = c + 1;
	for (; k < lines.length && lines[k] !== "};"; k++) {
		const m = /^\t([A-Za-z_$][\w$]*),$/.exec(lines[k]);
		if (!m) return { error: `${CONTEXT} line ${k + 1} is not one "<name>," entry` };
		names.push(m[1]);
	}
	if (k === lines.length) return { error: `${CONTEXT} never closes` };
	const contextEnd = k;
	const modules = [];
	let end = contextEnd;
	for (k = contextEnd + 1; k < lines.length; k++) {
		if (lines[k] === "") continue;
		const m = MOUNT_RE.exec(lines[k]);
		if (!m) break;
		modules.push({ name: m[1], line: k + 1 });
		end = k;
	}
	return { from: from + 1, contextLine: c + 1, contextEnd: contextEnd + 1, end: end + 1, names: names.filter((n) => n !== "require"), modules, comment: lines.slice(from, c) };
}

function renderMountBlock(names, modules) {
	const out = [...MOUNT_COMMENT, `const ${CONTEXT} = {`];
	for (const n of names) out.push(`\t${n},`);
	out.push("\trequire,", "};");
	for (const m of [...modules].sort(byCodeUnit)) out.push("", `require("./${ROUTE_DIR}/${m}")(${CONTEXT});`);
	return out;
}

// ------------------------------------------------------------- module files
function renderModule({ header, names, body }) {
	return [...header, `module.exports = function mount({ ${names.join(", ")} }) {`, body, "};", ""].join("\n");
}

// A module file's parts; `error` when its shape is not the generated one.
function parseModule(text) {
	if (!text.endsWith("};\n")) return { error: "does not end with the mount function's \"};\" and a newline" };
	const lines = text.split("\n");
	let k = 0;
	while (k < lines.length && lines[k].startsWith("//")) k++;
	const sig = SIGNATURE_RE.exec(lines[k] || "");
	if (!sig) return { error: `line ${k + 1} is not "module.exports = function mount({ … }) {"` };
	const body = lines.slice(k + 1, lines.length - 2).join("\n");
	if (!body.trim()) return { error: "holds no registration" };
	return { header: lines.slice(0, k), names: sig[1].split(", "), body, bodyLine: k + 2 };
}

// ---------------------------------------------------------- overlap order
// Order entries are { id, method, paths, prefix }: method "use" for a
// middleware layer (every method), paths null when they can't be read (every
// path), prefix true for a layer (it matches its path and everything below).
const isMethodRoute = (r) => r.method !== "use";
const METHOD_SET = (m) => (m === "get" ? ["get", "head"] : [m]);
function methodsOverlap(a, b) {
	if (a === "all" || b === "all" || a === "use" || b === "use") return true;
	const s = new Set(METHOD_SET(a));
	return METHOD_SET(b).some((m) => s.has(m));
}
// Express 4 (path-to-regexp 0.1): case-insensitive, trailing slash optional, a
// segment holding a ":param" can take any segment, "*" takes anything; a layer
// matches its own path as a prefix.
function pathsOverlap(a, b, aPrefix = false, bPrefix = false) {
	const wild = (p) => p === null || /[*?()+]/.test(p);
	if (wild(a) || wild(b)) return true;
	const sa = a.replace(/\/+$/, "").split("/");
	const sb = b.replace(/\/+$/, "").split("/");
	if (sa.length !== sb.length && !(sa.length < sb.length ? aPrefix : bPrefix)) return false;
	const n = Math.min(sa.length, sb.length);
	for (let i = 0; i < n; i++) {
		if (!(sa[i].includes(":") || sb[i].includes(":") || sa[i].toLowerCase() === sb[i].toLowerCase())) return false;
	}
	return true;
}
function routesOverlap(a, b) {
	if (!methodsOverlap(a.method, b.method)) return false;
	const pa = a.paths || [null];
	const pb = b.paths || [null];
	return pa.some((x) => pb.some((y) => pathsOverlap(x, y, Boolean(a.prefix), Boolean(b.prefix))));
}

// Pairs (by id) whose relative order differs between two orders of the same
// entries, among the pairs that can match one request.
function brokenPairs(routes, before, after) {
	const pos = (order) => new Map(order.map((id, i) => [id, i]));
	const pb = pos(before);
	const pa = pos(after);
	const out = [];
	const list = routes;
	for (let i = 0; i < list.length; i++) {
		for (let j = i + 1; j < list.length; j++) {
			const a = list[i];
			const b = list[j];
			if (!routesOverlap(a, b)) continue;
			if (Math.sign(pb.get(a.id) - pb.get(b.id)) !== Math.sign(pa.get(a.id) - pa.get(b.id))) out.push([a, b]);
		}
	}
	return out;
}

function overlappingPairs(routes, order) {
	const pos = new Map(order.map((id, i) => [id, i]));
	const list = routes.filter(isMethodRoute).sort((a, b) => pos.get(a.id) - pos.get(b.id));
	const out = [];
	for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (routesOverlap(list[i], list[j])) out.push([list[i], list[j]]);
	return out;
}

// -------------------------------------------------------------- the checker
// Checks a tree: server.js text, the route module texts by name (every file in
// routes/), and the spec (scripts/split/modules.json, parsed). Returns
// { errors, notes }; no errors means it passes.
function checkTree({ serverSrc, modules = {}, spec = null }) {
	const errors = [];
	const notes = [];
	let scan;
	try {
		scan = scanSource(serverSrc);
	} catch (e) {
		return { errors: [`server.js: ${e.message}`], notes };
	}
	const { decls, indented } = topLevelDeclarations(serverSrc, scan);
	for (const l of indented) errors.push(`server.js:${l}: an indented top-level declaration (ROUTE_CONTEXT lists column-0 declarations only)`);
	const kinds = new Map();
	for (const d of decls) {
		if (kinds.has(d.name) && !(kinds.get(d.name).kind === "function" && d.kind === "function")) errors.push(`server.js:${d.line}: ${d.name} is declared twice at the top level`);
		if (!kinds.has(d.name)) kinds.set(d.name, d);
	}
	const lines = serverSrc.split("\n");
	const all = catchAll(serverSrc, scan);
	if (all.error) errors.push(`server.js: ${all.error}`);
	const block = mountBlock(serverSrc, scan);
	if (block && block.error) {
		errors.push(`server.js: ${block.error}`);
		return { errors, notes };
	}
	const moduleNames = Object.keys(modules).sort(byCodeUnit);
	for (let k = 0; k < lines.length; k++) {
		if (lines[k].includes(`./${ROUTE_DIR}/`) && !(block && k + 1 > block.contextEnd && k + 1 <= block.end && MOUNT_RE.test(lines[k]))) {
			errors.push(`server.js:${k + 1}: names a route module outside the mount block`);
		}
	}
	if (!block) {
		if (moduleNames.length) errors.push(`routes/ holds ${moduleNames.join(", ")} but server.js has no mount block (node scripts/split/move-routes.js --context)`);
	} else {
		if (!all.error && block.end >= all.line) errors.push(`server.js:${block.from}: the mount block must sit above the SPA catch-all (line ${all.line})`);
		const names = contextNames(decls, block.from);
		const want = renderMountBlock(names, block.modules.map((m) => m.name)).join("\n");
		const have = lines.slice(block.from - 1, block.end).join("\n");
		if (want !== have) {
			const got = new Set(block.names);
			const exp = new Set(names);
			const missing = names.filter((n) => !got.has(n));
			const extra = block.names.filter((n) => !exp.has(n));
			const detail = [missing.length ? `missing ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""}` : "", extra.length ? `extra ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? ", …" : ""}` : ""].filter(Boolean).join("; ");
			errors.push(`server.js:${block.from}: ${CONTEXT} or the mount lines differ from the generated block${detail ? ` (${detail})` : ""}: run node scripts/split/move-routes.js --context`);
		}
		const seen = new Map();
		for (const m of block.modules) {
			if (seen.has(m.name)) errors.push(`server.js:${m.line}: routes/${m.name}.js is mounted twice`);
			seen.set(m.name, m.line);
			if (!modules[m.name]) errors.push(`server.js:${m.line}: mounts routes/${m.name}.js, which does not exist`);
		}
		for (const n of moduleNames) if (!seen.has(n)) errors.push(`routes/${n}.js is never mounted`);
		if (!block.modules.length) errors.push(`server.js:${block.from}: a mount block that mounts no module`);
	}

	const contextSet = new Set(block ? contextNames(decls, block.from) : []);
	const lets = new Set(decls.filter((d) => d.kind === "let" || d.kind === "var").map((d) => d.name));
	const late = new Set(block ? decls.filter((d) => d.kind !== "function" && d.kind !== "let" && d.kind !== "var" && d.line >= block.from && d.name !== CONTEXT).map((d) => d.name) : []);
	const serverNames = new Set(decls.map((d) => d.name));
	const keysAt = new Map();
	const addKey = (key, where) => { if (!keysAt.has(key)) keysAt.set(key, []); keysAt.get(key).push(where); };
	for (const r of registrations(serverSrc, scan)) if (isMethodRoute(r)) addKey(r.key, `server.js:${r.line}`);

	for (const name of moduleNames) {
		const file = `${ROUTE_DIR}/${name}.js`;
		const text = modules[name];
		if (!MODULE_NAME_RE.test(name)) errors.push(`${file}: a module name is lowercase words joined by "-"`);
		if (/^\s*(["'])use strict\1;?\s*$/m.test(text)) errors.push(`${file}: a strict-mode directive (server.js is sloppy mode; the moved code must stay so)`);
		const mod = parseModule(text);
		if (mod.error) { errors.push(`${file}: ${mod.error}`); continue; }
		const bodyLines = mod.body.split("\n");
		bodyLines.forEach((l, i) => {
			if (/^(?:async\s+function|function|const|let|var|class)\b/.test(l)) errors.push(`${file}:${mod.bodyLine + i}: a column-0 declaration (it would read as a server.js top-level name)`);
		});
		let bodyScan;
		try {
			bodyScan = scanSource(mod.body);
		} catch (e) {
			errors.push(`${file}: ${e.message}`);
			continue;
		}
		let regs;
		try {
			regs = registrations(mod.body, bodyScan, { headRe: MODULE_HEAD_RE });
		} catch (e) {
			errors.push(`${file}: ${e.message}`);
			continue;
		}
		const covered = new Set();
		for (const r of regs) for (let l = r.line; l <= r.end; l++) covered.add(l);
		bodyLines.forEach((l, i) => {
			if (!bodyScan.lineTop[i] || covered.has(i + 1) || l === "" || l.startsWith("//")) return;
			errors.push(`${file}:${mod.bodyLine + i}: only route registrations (app.get/post/put/patch/delete/all) sit in a module body`);
		});
		if (!regs.length) errors.push(`${file}: registers no route`);
		for (const r of regs) {
			addKey(r.key, `${file}:${mod.bodyLine + r.line - 1}`);
			if (!r.standalone) errors.push(`${file}:${mod.bodyLine + r.line - 1}: ${r.key} is not a statement of its own (it follows "${r.after}")`);
		}
		// Read per registration, so one piece the scanner stops on can't hide the rest.
		const ids = new Set();
		for (const r of regs) for (const n of usedNames(mod.body.slice(r.startOff, r.closeOff + 1))) ids.add(n);
		const given = new Set(mod.names);
		if (given.size !== mod.names.length) errors.push(`${file}: a parameter is listed twice`);
		const sorted = [...mod.names].sort(byCodeUnit);
		if (sorted.join(",") !== mod.names.join(",")) errors.push(`${file}: the parameters are not sorted`);
		for (const id of [...ids].sort(byCodeUnit)) {
			if (FORBIDDEN.has(id)) { errors.push(`${file}: uses ${id}: ${FORBIDDEN.get(id)}`); continue; }
			if (lets.has(id)) { errors.push(`${file}: touches server.js's let ${id} (a module would hold a copy, not the binding)`); continue; }
			if (late.has(id)) { errors.push(`${file}: uses ${id}, which server.js declares below the mount block`); continue; }
			if ((serverNames.has(id) || id === "require") && !given.has(id)) {
				const shadow = id in globalThis || id === "require" ? ` (without it the module silently gets the ${id === "require" ? "module's own require, which resolves from routes/" : `global ${id}`})` : "";
				errors.push(`${file}: uses server.js's ${id} without taking it from ${CONTEXT}${shadow}`);
			}
		}
		for (const n of mod.names) {
			if (n !== "require" && !contextSet.has(n)) errors.push(`${file}: takes ${n}, which ${CONTEXT} does not hold (it would be undefined)`);
		}
	}
	for (const [key, where] of keysAt) if (where.length > 1) errors.push(`${key} is registered ${where.length} times (${where.join(", ")})`);

	if (spec) {
		for (const [name, entry] of Object.entries(spec)) {
			if (!MODULE_NAME_RE.test(name)) { errors.push(`spec: ${name} is not a module name`); continue; }
			const has = Object.prototype.hasOwnProperty.call(modules, name);
			if (entry.moved && !has) errors.push(`spec: ${name} is marked moved, but routes/${name}.js does not exist`);
			if (!entry.moved && has) errors.push(`spec: routes/${name}.js exists, but ${name} is not marked moved`);
			// A moved module owns every route the spec lists for it (it may hold more).
			if (entry.moved && has) {
				for (const head of entry.routes || []) {
					if (!(keysAt.get(head) || []).some((w) => w.startsWith(`${ROUTE_DIR}/${name}.js:`))) errors.push(`spec: ${head} is listed for ${name}, but routes/${name}.js does not register it`);
				}
			}
		}
		for (const name of moduleNames) if (!spec[name]) errors.push(`routes/${name}.js is not in the spec (scripts/split/modules.json)`);
	}
	if (!block && !moduleNames.length) notes.push("no route modules yet: nothing to check in the tree");
	return { errors, notes };
}

module.exports = {
	CONTEXT,
	ROUTE_DIR,
	METHODS,
	FORBIDDEN,
	MOVE_FORBIDDEN,
	byCodeUnit,
	parses,
	scanSource,
	usedNames,
	lineOfOffset,
	pathKey,
	resolvePaths,
	stringConsts,
	splitTopLevelCommas,
	registrations,
	topLevelDeclarations,
	contextNames,
	catchAll,
	mountBlock,
	renderMountBlock,
	moduleHeader,
	renderModule,
	parseModule,
	pathsOverlap,
	routesOverlap,
	brokenPairs,
	overlappingPairs,
	checkTree,
};
