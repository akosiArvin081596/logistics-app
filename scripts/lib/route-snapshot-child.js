#!/usr/bin/env node
/**
 * scripts/lib/route-snapshot-child.js: the import half of
 * scripts/test-route-snapshot.js (its header explains the snapshot). Not a
 * runner; only that runner starts it, with a scrubbed environment and an empty
 * scratch folder as its working folder:
 *
 *   node scripts/lib/route-snapshot-child.js <input.json>
 *   input.json: { server, sources, out }
 *     server   the server file to import (absolute path)
 *     sources  the files whose text counts as app code (the server file, lib/*.js)
 *     out      where the report (JSON) is written
 *
 * Before the import it installs recorders, so importing starts nothing and
 * every attempt is reported with the code that made it: listen is a no-op;
 * timers are recorded and never scheduled; signal handlers are recorded and not
 * installed; connections, DNS lookups, fetch and process launches are refused;
 * a write outside the scratch folder (a folder, a file, a delete) is refused; a
 * listing of the temp folder is recorded. It also records each registration
 * call on the Express app (method, arguments, calling file and line), so every
 * layer on the app's stack is traced to the source text that registered it.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const dns = require("dns");
const childProcesses = require("child_process");
const timersModule = require("timers");
const { createHash } = require("crypto");
const { fileURLToPath } = require("url");

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const TARGET = fs.realpathSync(input.server);
const BASE = path.dirname(TARGET);
const LIB_REAL = fs.realpathSync(path.join(BASE, "lib"));
const SCRATCH = fs.realpathSync(process.cwd());
const SELF = fs.realpathSync(__filename);
const sourceTexts = input.sources.map((f) => fs.readFileSync(f, "utf8"));
const targetText = sourceTexts[0];

// --- reading JavaScript text ---------------------------------------------------
// A small tokenizer: enough to drop comments, keep strings, templates and regex
// literals whole, and find the arguments of a call. Deterministic, never exact.
const BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const OPENERS = "([{";
const CLOSERS = ")]}";

function regexEnd(text, at) {
	let j = at + 1;
	let inClass = false;
	while (j < text.length) {
		const c = text[j];
		if (c === "\n") return -1;
		if (c === "\\") { j += 2; continue; }
		if (inClass) { if (c === "]") inClass = false; }
		else if (c === "[") inClass = true;
		else if (c === "/") {
			j++;
			while (j < text.length && /[a-z]/i.test(text[j])) j++;
			return j;
		}
		j++;
	}
	return -1;
}

// Tokens from `from` on; with `closer` it stops at the first unmatched one.
function tokenize(text, from = 0, closer = null) {
	const tokens = [];
	const n = text.length;
	let i = from;
	let depth = 0;
	let prev = null;
	const regexAllowed = () => !prev
		|| (prev.type === "punct" && !CLOSERS.includes(prev.text))
		|| (prev.type === "word" && BEFORE_REGEX.has(prev.text));
	const push = (type, end) => {
		const t = { type, text: text.slice(i, end), start: i, end };
		tokens.push(t);
		if (type !== "space" && type !== "comment") prev = t;
		i = end;
	};
	while (i < n) {
		const c = text[i];
		const d = text[i + 1] || "";
		if (closer && depth === 0 && c === closer) break;
		if (/\s/.test(c)) {
			let j = i + 1;
			while (j < n && /\s/.test(text[j])) j++;
			push("space", j);
		} else if (c === "/" && d === "/") {
			const j = text.indexOf("\n", i);
			push("comment", j === -1 ? n : j);
		} else if (c === "/" && d === "*") {
			const j = text.indexOf("*/", i + 2);
			push("comment", j === -1 ? n : j + 2);
		} else if (c === "'" || c === "\"") {
			let j = i + 1;
			while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
			push("string", Math.min(j + 1, n));
		} else if (c === "`") {
			let j = i + 1;
			while (j < n && text[j] !== "`") {
				if (text[j] === "\\") j += 2;
				else if (text[j] === "$" && text[j + 1] === "{") j = tokenize(text, j + 2, "}").end + 1;
				else j++;
			}
			push("string", Math.min(j + 1, n));
		} else if (c === "/" && regexAllowed() && regexEnd(text, i) !== -1) {
			push("regex", regexEnd(text, i));
		} else if (/[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127) {
			let j = i + 1;
			while (j < n && (/[\w$]/.test(text[j]) || text.charCodeAt(j) > 127)) j++;
			push("word", j);
		} else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(d))) {
			let j = i + 1;
			while (j < n && /[\w.]/.test(text[j])) j++;
			push("number", j);
		} else if (text.startsWith("...", i)) {
			push("punct", i + 3);
		} else if (c === "=" && d === ">") {
			push("punct", i + 2);
		} else {
			if (OPENERS.includes(c)) depth++;
			else if (CLOSERS.includes(c)) depth--;
			push("punct", i + 1);
		}
	}
	return { tokens, end: i };
}

const NO_SPACE_AFTER = new Set(["(", "[", "."]);
const NO_SPACE_BEFORE = new Set([")", "]", ",", ";", "."]);
// Comments dropped; a run of whitespace becomes one space, or none next to a
// bracket, comma or dot, so a rewrapped line or a removed comment reads the same.
function normalize(text) {
	let out = "";
	let gap = false;
	let last = null;
	for (const t of tokenize(text).tokens) {
		if (t.type === "space" || t.type === "comment") { gap = true; continue; }
		if (gap && last && !NO_SPACE_AFTER.has(last.text) && !NO_SPACE_BEFORE.has(t.text)) out += " ";
		out += t.text;
		last = t;
		gap = false;
	}
	return out;
}

const fingerprint = (text) => createHash("sha256").update(normalize(text)).digest("hex").slice(0, 12);

const significant = (ts) => ts.filter((t) => t.type !== "space" && t.type !== "comment");
const isOpen = (t) => t.type === "punct" && OPENERS.includes(t.text);
const isClose = (t) => t.type === "punct" && CLOSERS.includes(t.text);
function matching(ts, at) {
	let depth = 0;
	for (let k = at; k < ts.length; k++) {
		if (isOpen(ts[k])) depth++;
		else if (isClose(ts[k]) && --depth === 0) return k;
	}
	return -1;
}

// The arguments of the call whose "(" is at `open`, as written.
function callArguments(text, open) {
	const { tokens } = tokenize(text, open + 1, ")");
	const groups = [[]];
	let depth = 0;
	for (const t of tokens) {
		if (isOpen(t)) depth++;
		else if (isClose(t)) depth--;
		else if (t.type === "punct" && t.text === "," && depth === 0) { groups.push([]); continue; }
		groups[groups.length - 1].push(t);
	}
	return groups.map(significant).filter((ts) => ts.length).map((ts) => {
		const raw = text.slice(ts[0].start, ts[ts.length - 1].end);
		const first = ts[0].text;
		const inline = first === "function" || first === "async"
			|| (ts[0].type === "word" && ts[1] && ts[1].text === "=>")
			|| (first === "(" && matching(ts, 0) !== -1 && ts[matching(ts, 0) + 1] && ts[matching(ts, 0) + 1].text === "=>");
		const many = first === "..." || (first === "[" && matching(ts, 0) === ts.length - 1);
		return { raw, text: normalize(raw), inline, many };
	});
}

// --- where a call came from ------------------------------------------------------
const realCache = new Map();
function realFile(file) {
	if (!realCache.has(file)) {
		let r = file;
		try { r = fs.realpathSync(file); } catch { /* keep the name V8 gave */ }
		realCache.set(file, r);
	}
	return realCache.get(file);
}
function callerFrame() {
	const savedPrepare = Error.prepareStackTrace;
	const savedLimit = Error.stackTraceLimit;
	Error.prepareStackTrace = (_, frames) => frames;
	Error.stackTraceLimit = 50;
	const holder = {};
	Error.captureStackTrace(holder, callerFrame);
	const frames = holder.stack;
	Error.prepareStackTrace = savedPrepare;
	Error.stackTraceLimit = savedLimit;
	for (const f of frames || []) {
		const file = f.getFileName();
		if (!file || file.startsWith("node:") || !path.isAbsolute(file)) continue;
		const real = realFile(file);
		if (real === SELF) continue;
		return { real, line: f.getLineNumber(), fn: f.getFunctionName() || null };
	}
	return null;
}
const inside = (dir, p) => p === dir || p.startsWith(dir + path.sep);
function appRelative(real) {
	if (real === TARGET) return "server.js";
	if (inside(LIB_REAL, real)) return `lib/${path.relative(LIB_REAL, real).split(path.sep).join("/")}`;
	if (inside(BASE, real)) return path.relative(BASE, real).split(path.sep).join("/");
	return null;
}
const lineCache = new Map();
function lineOf(real, line) {
	if (!lineCache.has(real)) lineCache.set(real, real === TARGET ? targetText.split("\n") : fs.readFileSync(real, "utf8").split("\n"));
	return lineCache.get(real)[line - 1] || "";
}
// A label that survives unrelated edits: a package name, a function name, or
// the text of the calling line; never a line number or an absolute path.
function siteLabel(frame) {
	if (!frame) return "(no caller)";
	const pkg = /.*[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(frame.real);
	if (pkg) return `node_modules/${pkg[1].replace(/\\/g, "/")}`;
	const where = appRelative(frame.real) || "(outside the app)";
	if (frame.fn) return `${where} ${frame.fn}()`;
	return `${where}: ${normalize(lineOf(frame.real, frame.line))}`;
}

// --- recorders -------------------------------------------------------------------
const effects = [];
let importing = true;
function record(kind, detail) {
	effects.push({ kind, detail: detail === undefined || detail === "" ? "" : String(detail), site: siteLabel(callerFrame()) });
}

const createdServers = [];
const originalCreateServer = http.createServer;
http.createServer = function recordedCreateServer(...args) {
	const created = originalCreateServer.apply(this, args);
	createdServers.push({ created, handler: args.find((a) => typeof a === "function") || null });
	return created;
};
// The prototype every HTTP, HTTPS and TCP listener shares (an unbound
// instance's prototype: it opens nothing).
const listenerProto = Object.getPrototypeOf(net.createServer());
const originalListen = listenerProto.listen;
listenerProto.listen = function recordedListen(...args) {
	if (!importing) return originalListen.apply(this, args);
	record("listen", args.filter((a) => typeof a === "number" || typeof a === "string").join(" "));
	return this;
};

const fakeTimer = () => {
	const t = { hasRef: () => false, ref: () => t, unref: () => t, refresh: () => t, close: () => t, [Symbol.toPrimitive]: () => 0 };
	return t;
};
const delayText = (delay) => (typeof delay === "number" ? String(delay) : delay === undefined ? "(no delay)" : JSON.stringify(String(delay)));
for (const kind of ["setTimeout", "setInterval", "setImmediate"]) {
	const original = globalThis[kind];
	const replacement = function recordedTimer(callback, delay, ...rest) {
		if (!importing) return original.call(this, callback, delay, ...rest);
		record(kind, kind === "setImmediate" ? "" : delayText(delay));
		return fakeTimer();
	};
	globalThis[kind] = replacement;
	timersModule[kind] = replacement;
}

for (const method of ["on", "addListener", "once", "prependListener", "prependOnceListener"]) {
	const original = process[method];
	process[method] = function recordedProcessListener(event, ...rest) {
		if (importing && typeof event === "string" && /^SIG[A-Z0-9]+$/.test(event)) {
			record(`process.${method}`, event);
			return this;
		}
		return original.call(this, event, ...rest);
	};
}

const refusal = (what) => Object.assign(new Error(`route snapshot: ${what} refused while importing`), { code: "EACCES" });
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function refusedConnect(...args) {
	if (!importing) return originalConnect.apply(this, args);
	const a = Array.isArray(args[0]) ? args[0] : args;
	const o = a[0];
	const where = o && typeof o === "object" ? (o.path ? "a local socket" : `${o.host || "localhost"}:${o.port}`)
		: typeof o === "number" ? `${typeof a[1] === "string" ? a[1] : "localhost"}:${o}` : "a local socket";
	record("connect", where);
	const socket = this;
	process.nextTick(() => socket.destroy(refusal("a connection")));
	return this;
};
const originalLookup = dns.lookup;
dns.lookup = function refusedLookup(hostname, options, callback) {
	if (!importing) return originalLookup.apply(this, arguments);
	record("dns.lookup", hostname);
	const cb = typeof options === "function" ? options : callback;
	if (typeof cb === "function") process.nextTick(cb, refusal("a DNS lookup"));
	return {};
};
const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function refusedPromiseLookup(hostname) {
	if (!importing) return originalPromiseLookup.apply(this, arguments);
	record("dns.lookup", hostname);
	return Promise.reject(refusal("a DNS lookup"));
};
const originalFetch = globalThis.fetch;
globalThis.fetch = function refusedFetch(resource) {
	if (!importing) return originalFetch.apply(this, arguments);
	let host = "(unparsed)";
	try { host = new URL(String(resource && resource.url ? resource.url : resource)).host; } catch { /* keep the placeholder */ }
	record("fetch", host);
	return Promise.reject(refusal("fetch"));
};
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
	const original = childProcesses[name];
	childProcesses[name] = function refusedLaunch(command) {
		if (!importing) return original.apply(this, arguments);
		record(`child_process.${name}`, path.basename(String(command)));
		throw refusal("a process launch");
	};
}

// File writes: which arguments name a target. Inside the scratch folder they go
// through; anywhere else (the app folder above all) they are refused.
const WRITE_TARGETS = {
	mkdir: [0], mkdtemp: [0], writeFile: [0], appendFile: [0], copyFile: [1], cp: [1], rename: [0, 1],
	unlink: [0], rm: [0], rmdir: [0], truncate: [0], symlink: [1], link: [1], chmod: [0], utimes: [0],
};
const asPath = (a) => (typeof a === "string" ? a : a instanceof URL ? fileURLToPath(a) : Buffer.isBuffer(a) ? a.toString() : null);
// The real path of the deepest folder that exists, plus the rest as given.
function realish(p) {
	let head = path.resolve(p);
	const rest = [];
	while (!fs.existsSync(head) && path.dirname(head) !== head) {
		rest.unshift(path.basename(head));
		head = path.dirname(head);
	}
	return path.join(realFile(head), ...rest);
}
function outsideScratch(args, indexes) {
	for (const k of indexes) {
		const p = asPath(args[k]);
		if (p !== null && !inside(SCRATCH, realish(p))) return realish(p);
	}
	return null;
}
const shownPath = (real) => (inside(BASE, real) ? path.relative(BASE, real).split(path.sep).join("/") || "." : `(outside the app) ${path.basename(real)}`);
const opensForWrite = (flags) => (typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0);
function guard(owner, name, indexes, style, label) {
	const original = owner[name];
	if (typeof original !== "function") return;
	owner[name] = function refusedWrite(...args) {
		if (!importing) return original.apply(this, args);
		const target = name.startsWith("open") ? (opensForWrite(args[1]) ? outsideScratch(args, [0]) : null) : outsideScratch(args, indexes);
		if (target === null) return original.apply(this, args);
		record(label, shownPath(target));
		const err = refusal("a write outside the scratch folder");
		if (style === "sync") throw err;
		if (style === "promise") return Promise.reject(err);
		const cb = args.reverse().find((a) => typeof a === "function");
		if (cb) process.nextTick(cb, err);
		return undefined;
	};
}
for (const [name, indexes] of Object.entries(WRITE_TARGETS)) {
	guard(fs, `${name}Sync`, indexes, "sync", `fs.${name}Sync`);
	guard(fs, name, indexes, "callback", `fs.${name}`);
	guard(fs.promises, name, indexes, "promise", `fs.promises.${name}`);
}
guard(fs, "openSync", [0], "sync", "fs.openSync (write)");
guard(fs, "open", [0], "callback", "fs.open (write)");
guard(fs.promises, "open", [0], "promise", "fs.promises.open (write)");
guard(fs, "createWriteStream", [0], "sync", "fs.createWriteStream");

const tempFolder = () => realish(os.tmpdir());
for (const name of ["readdirSync", "readdir"]) {
	const original = fs[name];
	fs[name] = function recordedListing(dir, ...rest) {
		if (importing && asPath(dir) !== null && realish(asPath(dir)) === tempFolder()) record(`fs.${name}`, "the temp folder");
		return original.call(this, dir, ...rest);
	};
}

// --- registrations on the app ----------------------------------------------------
const expressMain = require.resolve("express", { paths: [BASE] });
const express = require(expressMain);
const expressVersion = require(path.join(path.dirname(expressMain), "package.json")).version;
const httpVerbs = require(require.resolve("methods", { paths: [path.dirname(expressMain)] }));
const registrations = [];
const registrationOf = new Map();
for (const verb of [...httpVerbs, "all", "use"]) {
	const original = express.application[verb];
	if (typeof original !== "function") continue;
	express.application[verb] = function recordedRegistration(...args) {
		if (verb === "get" && args.length === 1) return original.apply(this, args);
		const frame = callerFrame();
		const had = Boolean(this._router);
		const before = had ? this._router.stack.length : 0;
		const out = original.apply(this, args);
		const reg = { owner: this, verb, args, frame, layers: this._router ? this._router.stack.slice(had ? before : 2) : [] };
		registrations.push(reg);
		for (const layer of reg.layers) registrationOf.set(layer, reg);
		return out;
	};
}

// --- the import --------------------------------------------------------------------
const report = { express: expressVersion, problems: [], entries: [], effects, exportKeys: [], exportsMatch: false };
const finish = (code) => {
	importing = false;
	fs.writeFileSync(input.out, JSON.stringify(report));
	process.exit(code);
};
let exported;
try {
	exported = require(TARGET);
} catch (err) {
	report.error = `the import threw: ${err && err.message ? err.message : String(err)}`;
	finish(1);
}
importing = false;

const apps = createdServers.filter((s) => s.handler && typeof s.handler.handle === "function" && typeof s.handler.set === "function");
if (apps.length !== 1) {
	report.error = `expected one HTTP server created around an Express app at import, found ${apps.length}`;
	finish(1);
}
// The exported app when there is one; the app the HTTP server was built
// around must be that same object (exportsMatch).
const theApp = exported && exported.app ? exported.app : apps[0].handler;
report.exportKeys = exported && typeof exported === "object" ? Object.keys(exported) : [];
report.exportsMatch = Boolean(exported && exported.app === apps[0].handler && exported.server === apps[0].created);
if (!theApp._router || !Array.isArray(theApp._router.stack)) {
	report.error = `the app has no _router.stack: the walker reads Express 4's router, and this is Express ${expressVersion}`;
	finish(1);
}

const problems = report.problems;
const appStack = theApp._router.stack;
if (appStack.length < 2 || appStack[0].name !== "query" || appStack[1].name !== "expressInit") {
	problems.push("the stack does not start with Express's own query and expressInit layers");
}

// The column-0 registration lines of the server file, by line number.
const targetLines = targetText.split("\n");
const lineStart = [];
{
	let at = 0;
	for (const l of targetLines) { lineStart.push(at); at += l.length + 1; }
}
const wrappedVerbs = new Set([...httpVerbs, "all", "use"]);
const columnZero = new Map();
targetLines.forEach((l, k) => {
	const m = /^app\.([a-z]+)\(/.exec(l);
	if (m && wrappedVerbs.has(m[1])) columnZero.set(k + 1, { verb: m[1], open: lineStart[k] + m[0].length - 1 });
});
const seenLines = new Set();

function describeHandler(fn) {
	const text = Function.prototype.toString.call(fn);
	const appCode = !text.includes("[native code]") && sourceTexts.some((s) => s.includes(text));
	const label = typeof fn.resetKey === "function" && typeof fn.getKey === "function" ? "limiter" : (fn.name || "anon");
	return { label, fp: appCode ? fingerprint(text) : null, arity: fn.length, isStatic: fn.name === "serveStatic" };
}
const shown = (h) => `${h.label}${h.fp ? `@${h.fp}` : ""}`;
const pathText = (p) => (typeof p === "string" ? p : p instanceof RegExp ? String(p) : JSON.stringify(p, (k, v) => (v instanceof RegExp ? String(v) : v)));
const pathList = (p) => (Array.isArray(p) ? p.flat(Infinity) : [p]).map((x) => (typeof x === "string" ? x : null));

let order = 0;
const done = new Set();
appStack.forEach((layer, index) => {
	if (index < 2) return;
	const reg = registrationOf.get(layer);
	if (!reg) { problems.push(`stack layer ${index} (${layer.name}) was not added by an app registration call`); return; }
	if (done.has(reg)) return;
	done.add(reg);
	if (reg.owner !== theApp) problems.push(`stack layer ${index} was registered on another app`);
	for (const l of reg.layers) {
		if (typeof l.handle === "function" && Array.isArray(l.handle.stack)) problems.push(`stack layer ${index} mounts a router; the walker does not descend into one`);
		if (l.handle && l.handle.name === "mounted_app") problems.push(`stack layer ${index} mounts an app; the walker does not descend into one`);
	}
	const isUse = reg.verb === "use";
	let shownMethods;
	let methodSet;
	let thePath;
	let handlers;
	let pathGiven = true;
	if (isUse) {
		let first = reg.args[0];
		while (Array.isArray(first) && first.length) first = first[0];
		pathGiven = typeof first !== "function";
		thePath = pathGiven ? reg.args[0] : "/";
		handlers = reg.layers.map((l) => l.handle);
		shownMethods = "USE";
		methodSet = handlers.every((h) => h.name === "serveStatic") ? ["get", "head"] : null;
	} else {
		const route = layer.route;
		if (!route) { problems.push(`stack layer ${index} (${reg.verb}) has no route`); return; }
		thePath = route.path;
		const verbsOn = Object.keys(route.methods).filter((m) => route.methods[m]);
		const firstVerb = route.stack.length ? route.stack[0].method : undefined;
		handlers = route.stack.filter((l) => l.method === firstVerb).map((l) => l.handle);
		for (const v of verbsOn) {
			const same = route.stack.filter((l) => l.method === v).map((l) => l.handle);
			if (same.length !== handlers.length || same.some((h, k) => h !== handlers[k])) problems.push(`${v.toUpperCase()} ${pathText(thePath)}: its methods do not share one handler chain`);
		}
		if (verbsOn.length === httpVerbs.length) { shownMethods = "ALL"; methodSet = null; }
		else {
			shownMethods = verbsOn.map((v) => v.toUpperCase()).sort().join(",");
			methodSet = verbsOn.includes("get") && !verbsOn.includes("head") ? [...verbsOn, "head"] : verbsOn;
		}
	}
	const described = handlers.map(describeHandler);
	const entry = {
		order: order++,
		kind: isUse ? "use" : "route",
		label: `${shownMethods} ${pathText(thePath)}`,
		methods: methodSet,
		paths: pathList(thePath),
		errorOnly: described.length > 0 && described.every((h) => h.arity === 4),
		lib: false,
		where: "",
		chain: [],
	};
	const frame = reg.frame;
	const where = frame ? appRelative(frame.real) : null;
	entry.where = `${where || siteLabel(frame)}${frame ? `:${frame.line}` : ""}`;
	if (where !== "server.js") {
		entry.lib = true;
		entry.chain = described.map(shown);
		if (!where || !where.startsWith("lib/")) problems.push(`${entry.label} was registered from ${entry.where}, neither the server file nor lib/`);
		report.entries.push(entry);
		return;
	}
	seenLines.add(frame.line);
	const head = columnZero.get(frame.line);
	if (!head || head.verb !== reg.verb) {
		problems.push(`${entry.label} was registered at server.js:${frame.line}, which is not a column-0 app.${reg.verb}( line`);
		report.entries.push(entry);
		return;
	}
	const written = callArguments(targetText, head.open);
	const handlerArgs = isUse && !pathGiven ? written : written.slice(1);
	const spreads = handlerArgs.filter((a) => a.many).length;
	const spreadSize = described.length - (handlerArgs.length - spreads);
	if (spreads > 1 || (spreads === 0 && handlerArgs.length !== described.length) || (spreads === 1 && spreadSize < 0)) {
		problems.push(`${entry.label} (server.js:${frame.line}): ${handlerArgs.length} handler argument(s) as written, ${described.length} at runtime`);
		entry.chain = described.map(shown);
		report.entries.push(entry);
		return;
	}
	let k = 0;
	for (const a of handlerArgs) {
		if (a.many) {
			entry.chain.push(`${a.text}=[${described.slice(k, k + spreadSize).map(shown).join(", ")}]`);
			k += spreadSize;
			continue;
		}
		const h = described[k++];
		if (a.inline) {
			if (fingerprint(a.raw) !== h.fp) problems.push(`${entry.label} (server.js:${frame.line}): an inline handler's text differs from the function registered`);
			entry.chain.push(`inline@${fingerprint(a.raw)}`);
		} else {
			entry.chain.push(`${a.text}${a.text === h.label ? "" : `=${h.label}`}${h.fp ? `@${h.fp}` : ""}`);
		}
	}
	report.entries.push(entry);
});
for (const [line, head] of columnZero) {
	if (!seenLines.has(line)) problems.push(`server.js:${line} (app.${head.verb}) is a column-0 registration that did not run at import`);
}
finish(0);
