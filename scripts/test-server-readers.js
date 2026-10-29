#!/usr/bin/env node
/**
 * Scripts read server.js as text only through scripts/lib/server-source.js.
 *
 * Route registrations are moving out of server.js into routes/<module>.js,
 * mounted by `require("./routes/<name>")(ROUTE_CONTEXT);`. A script that lifts
 * from server.js's own file would miss every moved route, and a scan would
 * quietly stop covering it. server-source.js hands scripts the virtual
 * server.js: server.js with each module's body spliced in at its mount line.
 *
 *   §1 server-source: server.js byte for byte while nothing is mounted; the
 *      splice, the line map and the base overrides on a made-up tree; every
 *      shape it refuses
 *   §2 the reader detector, on made-up snippets
 *   §3 every file under scripts/ that reads server.js reads it through the
 *      helper, or ALLOW (until the first move) or REAL_FILE (for good) names
 *      it with its reason; no list entry is stale
 *   §4 a folder scanner that takes server.js and lib/ as code roots covers
 *      routes/ too: it names routes/ or reads server.js only through the
 *      helper (allowlisted files included; BEFORE_FIRST_MOVE names the ones
 *      this change may not edit)
 *   §5 ALLOW and BEFORE_FIRST_MOVE are empty before server.js mounts a module
 *
 * The detector is a heuristic over source text (comments dropped, literals
 * tokenized). A read is readFileSync() of a server.js path, directly, through
 * a variable or a list holding one, or through a local function that reads.
 * A file on LABELS that takes the text from the helper may keep a server.js
 * name in a list or a local reader's call as a label.
 *
 * --list prints every scripts/ file that names server.js: file, class, how.
 *
 * Pure: reads files; its fixtures live in a mkdtemp folder.
 *
 * Run: node scripts/test-server-readers.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const source = require("./lib/server-source");
const { closure, indexDeclarations } = require("./lib/server-lift");

const ROOT = path.join(__dirname, "..");

// Files that still read server.js directly, each with why. Remove an entry
// when its file moves to the helper; a stale entry fails §3.
const owned = (branch) => `changed by open work on ${branch}: its owner moves it to the helper when that lands`;
const ADMIN = "admin or operator script run on production data: moves to the helper with ledger-world, in its own change";const ALLOW = new Map([
	["scripts/audit-job-tracking-damage.js", ADMIN],
	["scripts/correct-weekly-invoice.js", ADMIN],
	["scripts/count-load-closeout.js", ADMIN],
	["scripts/create-correction-invoice-draft.js", ADMIN],
	["scripts/create-missed-week-invoice-draft.js", ADMIN],
	["scripts/data-fix-driver-rates.js", ADMIN],
	["scripts/data-fix-haul-row-remeasure.js", ADMIN],
	["scripts/data-fix-september-sunday-invoices.js", ADMIN],
	["scripts/data-fix-sunday-pay-days.js", ADMIN],
	["scripts/data-fix-w39-receipts.js", ADMIN],
	["scripts/driver-instructions-backfill.js", ADMIN],
	["scripts/integrity-check.js", ADMIN],
	["scripts/october-flags-report.js", ADMIN],
	["scripts/repair-job-tracking-addresses.js", ADMIN],
	["scripts/set-settlement-grace-days.js", ADMIN],
	["scripts/time-off-loads-report.js", ADMIN],
	["scripts/lib/ledger-world.js", "the admin scripts' shared world: moves to the helper in its own change, with them"],
	["scripts/replica/remote/settings.js", "replica tool that reads a deployed app's own files on its host: moves with the admin scripts"],
	["scripts/replica/remote/sheets-export.js", "replica tool that reads a deployed app's own files on its host: moves with the admin scripts"],
	["scripts/docs/_patch-indexes.js", "one-off tool that rewrites server.js's own file, so it reads the file itself"],
	["scripts/test-route-snapshot.js", "imports server.js in a child and maps its stack frames to the real file, which the virtual source can't stand in for; the first move gives it routes/"],
	["scripts/personal-expenses-dry-run.js", owned("fix/personal-receipt-week")],
	["scripts/test-invoice-driver-name-matching.js", owned("fix/personal-receipt-week")],
	["scripts/test-invoice-week-selection.js", owned("fix/personal-receipt-week")],
	["scripts/test-account-directory-row-lock.js", owned("feat/ratecon-pdf-viewer-gate")],
	["scripts/test-driver-rename-clash.js", owned("feat/ratecon-pdf-viewer-gate")],
	["scripts/test-investor-company-lock.js", owned("feat/ratecon-pdf-viewer-gate")],
	["scripts/test-invoice-email-body.js", owned("feat/ratecon-pdf-viewer-gate")],
	["scripts/test-invoice-lines-routes.js", owned("feat/ratecon-pdf-viewer-gate")],
	["scripts/test-no-production-defaults.js", owned("feat/ratecon-pdf-viewer-gate")],
	["scripts/test-password-change-notice.js", owned("feat/ratecon-pdf-viewer-gate")],
	["scripts/test-ratecon-pdf-route.js", owned("feat/ratecon-pdf-viewer-gate")],
	["scripts/test-session-sockets.js", owned("feat/ratecon-pdf-viewer-gate")],
	["scripts/test-uploads-root-guard.js", owned("feat/ratecon-pdf-viewer-gate")],
	["scripts/test-driver-instructions-routes.js", owned("feat/db-download-listed-only")],
	["scripts/test-refusal-audit-coverage.js", owned("feat/db-download-listed-only")],
	["scripts/test-broker-column-redaction.js", owned("feat/restore-deleted-loads")],
	["scripts/test-csrf-guard.js", owned("feat/restore-deleted-loads")],
	["scripts/test-deleted-loads-route.js", owned("feat/restore-deleted-loads")],
	["scripts/test-driver-availability-guards.js", owned("feat/restore-deleted-loads")],
	["scripts/test-jt-cache-isolation.js", owned("feat/restore-deleted-loads")],
	["scripts/test-invoice-draft-bol.js", owned("feat/broker-invoice-engine")],
	["scripts/test-invoice-notes.js", owned("feat/broker-invoice-engine")],
	["scripts/test-invoice-overrides.js", owned("feat/broker-invoice-engine")],
]);

// Files that must read server.js's own file for good, each with why: they
// rewrite it, or check it beside the routes/ files the virtual source splices in.
const REAL_FILE = new Map([
	["scripts/split/move-routes.js", "the move tool: it rewrites server.js's own file and writes routes/"],
	["scripts/test-route-modules.js", "checks server.js's mount lines and ROUTE_CONTEXT beside the routes/ files, which the virtual source replaces; it follows SERVER_ROOT itself"],
]);

// Files the detector flags that read no server.js text, each with why. They
// still run §4.
const NOT_READERS = new Map([
	["scripts/test-release-gate.js", "its lint path list names server.js; it reads package.json, not server.js"],
	["scripts/test-test-selection.js", "its server.js lists and fixture runners are made-up trees for test-selection"],
]);

// Files that take server.js's text from the helper and also keep a server.js
// name in a list or a call to a local reader: each reason says why that name
// is only a label (the reader hands back the helper's text for it).
const LABELS = new Map([
	["scripts/test-closed-month-refusal-wording.js", "its file list keeps server.js as a path; the loop reads that entry through the helper"],
	["scripts/test-kpi-schedule.js", "its two-file list keeps server.js as a name; the filter reads that entry through the helper"],
	["scripts/test-pdf-browser-pipe.js", "its source-file list keeps server.js as a path; both sweeps read that entry through the helper"],
	["scripts/test-ratecon-drive-folder-required.js", "its scan list keeps server.js as a name; readSource() hands back the helper's text for it"],
	["scripts/test-replica-snapshot.js", "its source list keeps server.js as a name; the map reads that entry through the helper"],
	["scripts/test-sheet-id-required.js", "its scan list keeps server.js as a name; readSource() hands back the helper's text for it, and run() boots the file"],
	["scripts/test-truck-cost-amounts.js", "a [label, text] pair names server.js beside the helper's text"],
]);

// Folder scanners that would miss routes/ and that this change may not edit,
// each with what it waits for. §5 fails while any is left once a module is mounted.
const BEFORE_FIRST_MOVE = new Map([
	["scripts/replica/remote/settings.js", "replica tool that scans a deployed app's server.js and lib/: covers routes/ with the admin scripts' change"],
	["scripts/test-driver-instructions-routes.js", "scans server.js and lib/; changed by open work on feat/db-download-listed-only, whose owner adds routes/ or the helper"],
	["scripts/test-no-production-defaults.js", "scans server.js and lib/; changed by open work on feat/ratecon-pdf-viewer-gate, whose owner adds routes/ or the helper"],
	["scripts/test-release-gate.js", "pins the lint list, which gains routes/ with package.json's lint script"],
	["scripts/test-route-snapshot.js", "maps the imported app's stack frames to server.js and lib/ files; its sources gain routes/ with the first move, which also decides how a moved route is shown"],
]);

// ── the detector ──────────────────────────────────────────────────────────────
// A literal naming server.js (":" for a git ref). An absolute one names some
// other machine's copy, never this checkout's.
const PATH_RE = /^(?!\/)(?:.*[/:])?server\.js$/;
const READ_CALLEES = new Set(["readFileSync", "readFile"]);
const NON_READ_CALLEES = new Set([
	"createRequire", "existsSync", "statSync", "lstatSync", "writeFileSync", "copyFileSync", "appendFileSync",
	"spawn", "spawnSync", "fork", "execFile", "execFileSync", "exec", "execSync",
]);
const LIST_CALLEES = new Set(["push", "unshift", "concat", "add", "Set"]);
const WORLD_RE = /(?:^|\/)(?:availability|personal|money-plans|work-days|ledger)-world(?:\.js)?$/;
const HELPER_RE = /(?:^|\/)server-source(?:\.js)?$/;
const SCANNER_RE = /\breaddirSync\b|\breaddir\s*\(|\bopendirSync\b|\bglobSync\b|\bglob\s*\(/;
const KEYWORD_RE = /^(?:return|typeof|case|in|of|new|delete|void|throw|else|do|await|yield)$/;
const CONTINUES_RE = /[,([{=+\-*/|&?:.!]\s*$/;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Code with comments dropped and each string, template and regex literal
// replaced by a \0<n>\0 token; lits[n] holds its raw text.
function tokenize(text) {
	const lits = [];
	let code = "";
	let i = text.startsWith("#!") ? Math.max(0, text.indexOf("\n")) : 0;
	let prev = "";
	const n = text.length;
	const lit = (value, kind) => { code += `\0${lits.length}\0`; lits.push({ value, kind }); prev = "a"; };
	const quoted = (q) => {
		const s = ++i;
		while (i < n && text[i] !== q && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
		return text.slice(s, i++);
	};
	const template = () => {
		const s = ++i;
		while (i < n && text[i] !== "`") {
			if (text[i] === "\\") { i += 2; continue; }
			if (text[i] === "$" && text[i + 1] === "{") {
				i += 2;
				let depth = 1;
				while (i < n) {
					const c = text[i];
					if (c === "`") { template(); continue; }
					if (c === '"' || c === "'") { quoted(c); continue; }
					if (c === "{") depth++;
					else if (c === "}" && !--depth) break;
					i++;
				}
			}
			i++;
		}
		return text.slice(s, i++);
	};
	while (i < n) {
		const c = text[i];
		if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; continue; }
		if (c === "/" && text[i + 1] === "*") {
			const e = text.indexOf("*/", i + 2);
			const end = e < 0 ? n : e + 2;
			code += text.slice(i, end).replace(/[^\n]/g, "");
			i = end;
			continue;
		}
		if (c === '"' || c === "'") { lit(quoted(c), "string"); continue; }
		if (c === "`") { lit(template(), "template"); continue; }
		if (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) {
			const s = i++;
			let inClass = false;
			while (i < n && (inClass || text[i] !== "/") && text[i] !== "\n") {
				if (text[i] === "\\") { i += 2; continue; }
				if (text[i] === "[") inClass = true;
				else if (text[i] === "]") inClass = false;
				i++;
			}
			i++;
			while (/[a-z]/.test(text[i] || "")) i++;
			lit(text.slice(s, i), "regex");
			continue;
		}
		if (/[A-Za-z_$]/.test(c)) {
			const w = /[A-Za-z_$][\w$]*/y;
			w.lastIndex = i;
			const word = w.exec(text)[0];
			code += word;
			i += word.length;
			prev = KEYWORD_RE.test(word) ? "=" : "a";
			continue;
		}
		code += c;
		if (!/\s/.test(c)) prev = c;
		i++;
	}
	return { code, lits };
}

// The brackets around `at`, innermost first ({ open, callee, at }), and where
// its statement starts.
function enclosing(code, at) {
	const chain = [];
	let depth = 0;
	let i = at - 1;
	for (; i >= 0; i--) {
		const c = code[i];
		if (c === ")" || c === "]" || c === "}") { depth++; continue; }
		if (c === "(" || c === "[" || c === "{") {
			if (depth) { depth--; continue; }
			const before = code.slice(Math.max(0, i - 80), i);
			if (c === "(") {
				const m = /([A-Za-z_$][\w$]*)\s*$/.exec(before);
				chain.push({ open: "(", callee: m ? m[1] : null, at: i });
			} else if (c === "[") {
				chain.push({ open: /[\w$\])\0]\s*$/.test(before) ? "index" : "[", at: i });
			} else if (/(?:\)|=>|\belse|\btry|\bdo|\bfinally|^|[;{}])\s*$/.test(before)) {
				break;
			} else {
				chain.push({ open: "{", at: i });
			}
			continue;
		}
		if (depth) continue;
		if (c === ";") break;
		if (c === "\n" && !CONTINUES_RE.test(code.slice(Math.max(0, i - 80), i)) && !/^\s*(?:[.?:|&+\-*/,)\]]|=>)/.test(code.slice(i + 1, i + 40))) break;
	}
	return { chain, start: i + 1 };
}

// What a server.js path at `at` is used for.
function contextOf(code, at, readers) {
	// A key in an object literal ({ "server.js": text }) names a made-up tree's file.
	if (/[{,]\s*$/.test(code.slice(Math.max(0, at - 40), at)) && /^\0\d+\0\s*:/.test(code.slice(at, at + 40))) return { kind: "object key", read: false, by: "boot" };
	const { chain, start } = enclosing(code, at);
	for (const b of chain) {
		if (b.open !== "(" || !b.callee) continue;
		if (READ_CALLEES.has(b.callee)) return { kind: "readFileSync", read: true, by: "direct" };
		if (readers.has(b.callee)) return { kind: `local ${b.callee}()`, read: true, by: "local" };
		if (NON_READ_CALLEES.has(b.callee)) return { kind: `${b.callee}()`, read: false, by: "boot" };
	}
	if (chain.some((b) => b.open === "[" || b.open === "{" || (b.open === "(" && LIST_CALLEES.has(b.callee)))) return { kind: "list", read: null, by: "list" };
	const head = code.slice(start, chain.length ? chain[chain.length - 1].at : at);
	const m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(head) || /^\s*([A-Za-z_$][\w$]*)\s*=(?![=>])/.exec(head);
	if (m) return { kind: "assign", name: m[1], read: null, by: "assign" };
	return { kind: "other", read: false, by: "boot" };
}

// Where the statement starting at `from` ends.
function statementEnd(code, from) {
	let depth = 0;
	for (let i = from; i < code.length; i++) {
		const c = code[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") { if (--depth < 0) return i; }
		else if (!depth && c === ";") return i;
		else if (!depth && c === "\n" && !CONTINUES_RE.test(code.slice(Math.max(from, i - 80), i)) && !/^\s*(?:[.?:|&+\-*/,)\]]|=>)/.test(code.slice(i + 1, i + 40))) return i;
	}
	return code.length;
}

// Local functions whose body reads a file: called with a server.js path, they
// read server.js.
function localReaders(code) {
	const out = new Set();
	const defs = /(?:^|[^\w$.])(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/g;
	for (const m of code.matchAll(defs)) {
		const body = code.slice(m.index, statementEnd(code, m.index + 1));
		if (/\b(?:readFileSync|readFile)\s*\(/.test(body)) out.add(m[1] || m[2]);
	}
	return out;
}

// path.join()/path.resolve() literal segments, joined: the repo folders a file
// names ("lib", "routes", "scripts/lib/x").
function joinedPaths(code, lits) {
	const out = [];
	for (const m of code.matchAll(/\bpath\.(?:join|resolve)\(/g)) {
		let depth = 1;
		let i = m.index + m[0].length;
		const s = i;
		for (; i < code.length && depth; i++) {
			if (code[i] === "(") depth++;
			else if (code[i] === ")") depth--;
		}
		const segs = [...code.slice(s, i - 1).matchAll(/\0(\d+)\0/g)].map((x) => lits[Number(x[1])]).filter((l) => l.kind === "string").map((l) => l.value);
		if (segs.length) out.push(path.posix.normalize(segs.join("/")).replace(/^(?:\.{1,2}\/)+/, ""));
	}
	return out;
}

// `labels`: the file is on LABELS, so where it takes the text from the helper,
// a server.js name in a list or handed to a local function is a label.
function classify(text, { labels = false } = {}) {
	const { code, lits } = tokenize(text);
	const readers = localReaders(code);
	const uses = [];
	for (const m of code.matchAll(/\0(\d+)\0/g)) {
		const l = lits[Number(m[1])];
		if (l.kind === "regex" || !PATH_RE.test(l.value)) continue;
		const c = contextOf(code, m.index, readers);
		if (c.kind !== "assign") { uses.push(c); continue; }
		const re = new RegExp(`(?<![\\w$.\\0])${reEscape(c.name)}(?![\\w$])`, "g");
		const via = [];
		for (const u of code.matchAll(re)) {
			const v = contextOf(code, u.index, readers);
			if (v.kind === "assign" || v.kind === "other") continue;
			via.push(v);
		}
		const read = via.find((v) => v.read) || via.find((v) => v.by === "list");
		uses.push(read ? { kind: `${c.name} -> ${read.kind}`, read: read.read, by: read.by === "direct" ? "variable" : read.by } : { kind: `${c.name} (not read)`, read: false, by: "boot" });
	}
	const readsFiles = /\b(?:readFileSync|readFile)\s*\(/.test(code);
	const helper = lits.some((l) => l.kind === "string" && HELPER_RE.test(l.value));
	const raw = uses.filter((u) => u.read === true || (u.read === null && readsFiles));
	const isLabel = (u) => labels && helper && (u.by === "list" || u.by === "local");
	const reads = raw.filter((u) => !isLabel(u));
	const folders = joinedPaths(code, lits);
	// A quoted glob ("'lib/*.js'", a shell argument) names the folder too.
	const strs = lits.filter((l) => l.kind !== "regex").map((l) => l.value.replace(/^(['"])(.*)\1$/, "$2").replace(/^\.\//, ""));
	const res = lits.filter((l) => l.kind === "regex").map((l) => l.value);
	// lib/ as a folder (path.join(ROOT, "lib"), "lib/", "lib/*.js", /^lib\//),
	// not one file in it; routes/ named in any form.
	const namesLib = folders.includes("lib") || strs.some((v) => /^lib\/(?:\*|$)/.test(v)) || res.some((r) => /\^lib\\?\//.test(r));
	const namesRoutes = folders.some((f) => f === "routes" || f.startsWith("routes/")) || strs.some((v) => v.startsWith("routes/")) || res.some((r) => /routes\\?\//.test(r));
	return {
		reads,
		labelled: raw.length - reads.length,
		uses,
		helper,
		worlds: [...new Set(lits.filter((l) => l.kind === "string" && WORLD_RE.test(l.value)).map((l) => path.posix.basename(l.value).replace(/\.js$/, "")))],
		scanner: SCANNER_RE.test(code) || strs.some((v) => /\bls-files\b/.test(v)),
		namesLib,
		namesRoutes,
		codeNamesServer: uses.length > 0 || res.some((r) => /server\\\.js/.test(r)),
	};
}

// A folder scanner that takes server.js and lib/ as code roots but would miss
// routes/: it names no routes/ and reads server.js other than only through the helper.
const scansWithoutRoutes = (c) => c.scanner && c.namesLib && c.codeNamesServer && !c.namesRoutes && (!c.helper || c.reads.length > 0);

// The lists (name, Map) that still hold entries once `serverText` mounts a route
// module: each waits for "nothing mounted yet".
function mountGate(serverText, lists) {
	if (!source.mountLines(serverText.split("\n")).length) return [];
	return lists.filter(([, m]) => m.size).map(([name, m]) => `${name} (${m.size})`);
}

// The class of a file for --list and §3: how it reaches server.js's text.
function classOf(text, c) {
	if (c.reads.length) {
		const cls = { direct: "direct", variable: "path-variable", local: "local-read-helper", list: "list" }[c.reads[0].by];
		return { cls, how: [...new Set(c.reads.map((r) => r.kind))].join("; ") };
	}
	if (c.helper) return { cls: "server-source", how: "scripts/lib/server-source.js" };
	if (c.worlds.length) return { cls: "world-helper", how: c.worlds.join(", ") };
	if (c.uses.length) return { cls: "boot-or-path", how: [...new Set(c.uses.map((u) => u.kind))].join("; ") };
	return { cls: "mention", how: /server\.js/.test(text) ? "comment or prose only" : "" };
}

function scriptFiles(dir = path.join(ROOT, "scripts"), rel = "scripts") {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (e.name.startsWith(".") || e.name === "node_modules") continue;
		const r = `${rel}/${e.name}`;
		if (e.isDirectory()) out.push(...scriptFiles(path.join(dir, e.name), r));
		else if (/\.(?:js|mjs|cjs)$/.test(e.name)) out.push(r);
	}
	return out;
}

function list() {
	const rows = [];
	for (const f of scriptFiles()) {
		const text = fs.readFileSync(path.join(ROOT, f), "utf8");
		const c = classify(text, { labels: LABELS.has(f) });
		if (!/server\.js/.test(text) && !c.worlds.length && !c.helper) continue;
		const { cls, how } = NOT_READERS.has(f) ? { cls: "boot-or-path", how: NOT_READERS.get(f) } : classOf(text, c);
		rows.push(`${f}\t${cls}\t${how}${ALLOW.has(f) ? `\tallowed: ${ALLOW.get(f)}` : ""}`);
	}
	process.stdout.write(rows.map((r) => `${r}\n`).join(""));
}

let failed = 0;
function ok(name, cond, detail) {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}${detail === undefined ? "" : `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); }
}
function eq(name, got, want) {
	ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function throwsLike(name, fn, re) {
	try {
		fn();
		ok(name, false, "did not throw");
	} catch (err) {
		ok(name, re.test(err.message), err.message);
	}
}

function main() {
// ── §1 server-source ──────────────────────────────────────────────────────────
console.log("§1 server-source");
{
	const raw = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	const saved = { SERVER_JS: process.env.SERVER_JS, SERVER_ROOT: process.env.SERVER_ROOT };
	delete process.env.SERVER_JS;
	delete process.env.SERVER_ROOT;
	const mounted = source.mountLines(raw.split("\n")).length;
	if (!mounted) {
		ok("§1.1 nothing mounted: the virtual source is server.js byte for byte", source.serverSource() === raw);
	} else {
		const kept = raw.split("\n").filter((l) => !source.MOUNT_RE.test(l));
		let j = 0;
		for (const l of source.serverSource().split("\n")) if (j < kept.length && l === kept[j]) j++;
		ok(`§1.1 ${mounted} module(s) mounted: the virtual source holds every other line of server.js, in order`, j === kept.length);
	}

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "server-readers-"));
	const write = (rel, text) => {
		fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
		fs.writeFileSync(path.join(tmp, rel), text);
		return path.join(tmp, rel);
	};
	const SERVER = [
		'const express = require("express");',
		"const app = express();",
		"function shout(s) {",
		"\treturn String(s).toUpperCase();",
		"}",
		'app.get("/api/ping", (req, res) => {',
		'\tres.json({ ok: shout("pong") });',
		"});",
		"",
		"// Route modules (routes/).",
		"const ROUTE_CONTEXT = { app, shout, require };",
		'require("./routes/alpha")(ROUTE_CONTEXT);',
		"",
		'require("./routes/beta-two")(ROUTE_CONTEXT);',
		'app.get("*", (req, res) => {',
		'\tres.send("page");',
		"});",
		"",
	].join("\n");
	const ALPHA = [
		"// Made-up routes for the reader's own test.",
		"module.exports = function mount({ app, shout }) {",
		"// The first alpha route.",
		'app.get("/api/alpha", (req, res) => {',
		"\tres.json({ a: shout(1) });",
		"});",
		"",
		'app.post("/api/alpha", (req, res) => {',
		"\tres.json({ b: 2 });",
		"});",
		"};",
		"",
	].join("\n");
	const BETA = [
		"module.exports = function mount({",
		"\tapp,",
		"\tshout,",
		"}) {",
		'app.get("/api/beta", (req, res) => {',
		"\tres.json({ c: shout(3) });",
		"});",
		"};",
		"",
	].join("\n");
	write("base/server.js", SERVER);
	write("base/routes/alpha.js", ALPHA);
	write("base/routes/beta-two.js", BETA);
	write("lone/server.js", SERVER);

	const v = source.virtualServer({ root: path.join(tmp, "base") });
	const L = v.text.split("\n");
	eq("§1.2 the modules, in mount order", v.modules.map((m) => [m.name, m.file, m.mountLine]), [["alpha", "routes/alpha.js", 12], ["beta-two", "routes/beta-two.js", 14]]);
	eq("§1.2 the mount lines are replaced by the module bodies, verbatim", L.slice(10, 21), [
		"const ROUTE_CONTEXT = { app, shout, require };",
		"// The first alpha route.",
		'app.get("/api/alpha", (req, res) => {',
		"\tres.json({ a: shout(1) });",
		"});",
		"",
		'app.post("/api/alpha", (req, res) => {',
		"\tres.json({ b: 2 });",
		"});",
		"",
		'app.get("/api/beta", (req, res) => {',
	]);
	ok("§1.2 no mount line is left, and server.js's own lines are all there in order",
		!L.some((l) => source.MOUNT_RE.test(l)) && v.text.startsWith(SERVER.split("\n").slice(0, 11).join("\n")) && v.text.endsWith(SERVER.split("\n").slice(14).join("\n")));
	eq("§1.2 the line map: server.js, a module body, server.js again", [1, 11, 12, 14, 19, 21, 23, 24].map((n) => v.where(n)), [
		{ file: "server.js", line: 1 }, { file: "server.js", line: 11 }, { file: "routes/alpha.js", line: 3 },
		{ file: "routes/alpha.js", line: 5 }, { file: "routes/alpha.js", line: 10 }, { file: "routes/beta-two.js", line: 5 },
		{ file: "routes/beta-two.js", line: 7 }, { file: "server.js", line: 15 },
	]);
	eq("§1.2 the line map: the blank line between the mounts", v.where(20), { file: "server.js", line: 13 });
	throwsLike("§1.2 a line outside the source is an error", () => v.where(L.length + 1), /outside the source/);
	eq("§1.2 a module records the names it destructures", v.modules.map((m) => m.names), [["app", "shout"], ["app", "shout"]]);

	const lifted = closure(v.text, { routes: ['app.get("/api/beta", (req, res) => {'], provided: ["app"] });
	ok("§1.3 server-lift lifts a moved route and what it uses from the virtual source", lifted.names.includes("shout") && lifted.text.includes('app.get("/api/beta"'));
	eq("§1.3 the virtual source declares nothing twice", [...indexDeclarations(v.text).dupes], []);
	eq("§1.3 routeContextLines: a one-line ROUTE_CONTEXT", source.routeContextLines(v.text), { first: 11, last: 11 });
	eq("§1.3 routeContextLines: one over lines, through its \"};\"", source.routeContextLines("a;\nconst ROUTE_CONTEXT = {\n\tapp,\n\trequire,\n};\nb;\n"), { first: 2, last: 5 });
	eq("§1.3 routeContextLines: none", source.routeContextLines("const a = 1;\n"), null);
	throwsLike("§1.3 routeContextLines: one that never closes is an error", () => source.routeContextLines("const ROUTE_CONTEXT = {\n\tapp,\n"), /never closes/);

	eq("§1.4 serverOverride: none set", source.serverOverride(), null);
	process.env.SERVER_ROOT = path.join(tmp, "base");
	const notes = [];
	const stderrWrite = process.stderr.write;
	process.stderr.write = (s) => { notes.push(String(s)); return true; };
	let fromRoot;
	try {
		fromRoot = source.serverSource();
		source.serverSource();
	} finally {
		process.stderr.write = stderrWrite;
	}
	eq("§1.4 SERVER_ROOT names a base folder", fromRoot, v.text);
	eq("§1.4 serverOverride: SERVER_ROOT", source.serverOverride(), "SERVER_ROOT");
	ok("§1.4 following an override prints one stderr line per process, naming it and the file",
		notes.length === 1 && /^server-source: SERVER_ROOT is set; reading .*server\.js/.test(notes[0]), notes);
	delete process.env.SERVER_ROOT;
	process.env.SERVER_JS = path.join(tmp, "base", "server.js");
	eq("§1.4 SERVER_JS names one file; its routes/ beside it splice in", source.serverSource(), v.text);
	process.env.SERVER_JS = path.join(tmp, "lone", "server.js");
	throwsLike("§1.4 SERVER_JS without routes/ beside it: an error that names SERVER_ROOT", () => source.serverSource(), /SERVER_ROOT, not SERVER_JS/);
	process.env.SERVER_ROOT = path.join(tmp, "base");
	throwsLike("§1.4 SERVER_JS and SERVER_ROOT both set: an error", () => source.serverSource(), /SERVER_JS or SERVER_ROOT, not both/);
	eq("§1.4 the caller's { root } wins over both", source.serverSource({ root: path.join(tmp, "base") }), v.text);
	delete process.env.SERVER_JS;
	delete process.env.SERVER_ROOT;
	throwsLike("§1.4 { file } and { root } together: an error", () => source.serverSource({ file: "a", root: "b" }), /not both/);
	const plain = write("plain/server.js", "const a = 1;\r\n// require(\"./routes/x\")(ROUTE_CONTEXT);\n");
	eq("§1.4 a server.js with no mount line is returned as read, byte for byte", source.serverSource({ file: plain }), "const a = 1;\r\n// require(\"./routes/x\")(ROUTE_CONTEXT);\n");

	// Each refused shape, on a copy of the base with one change.
	let caseNo = 0;
	const refuses = (name, server, modules, re) => {
		const dir = path.join(tmp, `case${++caseNo}`);
		write(path.join(`case${caseNo}`, "server.js"), server);
		for (const [m, text] of Object.entries(modules)) write(path.join(`case${caseNo}`, "routes", `${m}.js`), text);
		throwsLike(`§1.5 refuses ${name}`, () => source.serverSource({ root: dir }), re);
	};
	const both = (alpha) => ({ alpha, "beta-two": BETA });
	refuses("\"use strict\" in a module", SERVER, both(`"use strict";\n${ALPHA}`), /use strict/);
	refuses("a column-0 declaration in a module body", SERVER, both(ALPHA.replace("// The first alpha route.", "const LIMIT = 3;")), /declares at column 0/);
	refuses("a column-0 function in a module body", SERVER, both(ALPHA.replace("// The first alpha route.", "function helper() { return 1; }")), /declares at column 0/);
	refuses("a body that starts with code, not a registration", SERVER, both(ALPHA.replace("// The first alpha route.", "setInterval(() => {}, 1000);")), /not a route registration/);
	refuses("a stray column-0 statement between routes", SERVER, both(ALPHA.replace('app.post("/api/alpha"', 'startsJob("x");\napp.post("/api/alpha"')), /no registration, comment or closer/);
	refuses("a module that registers nothing", SERVER, both("module.exports = function mount({ app }) {\n// nothing yet\n};\n"), /registers no route/);
	refuses("a module that does not end with \"};\"", SERVER, both(ALPHA.replace(/};\n$/, "}\n")), /does not end with/);
	refuses("trailing text after the closing \"};\"", SERVER, both(`${ALPHA}module.exports.x = 1;\n`), /does not end with/);
	refuses("CRLF line ends", SERVER, both(ALPHA.replace(/\n/g, "\r\n")), /carriage return/);
	refuses("another export shape", SERVER, both(ALPHA.replace("module.exports = function mount({ app, shout }) {", "module.exports = (ctx) => {")), /does not start with/);
	refuses("code before the mount() head", SERVER, both(`const x = 1;\n${ALPHA}`), /does not start with/);
	refuses("a renamed or defaulted parameter", SERVER, both(ALPHA.replace("{ app, shout }", "{ app, shout: yell }")), /plain names only/);
	refuses("a parameter named twice", SERVER, both(ALPHA.replace("{ app, shout }", "{ app, app }")), /a name twice/);
	refuses("a multi-line head closed on a name line", SERVER, { alpha: ALPHA, "beta-two": BETA.replace("\tshout,\n}) {", "\tshout }) {") }, /parameter list/);
	refuses("a module that mounts another", SERVER, both(ALPHA.replace("\tres.json({ b: 2 });", '\trequire("./routes/beta-two")(ROUTE_CONTEXT);')), /mounts another route module/);
	refuses("a mount line that is not at column 0", SERVER.replace('require("./routes/alpha")', '\trequire("./routes/alpha")'), both(ALPHA), /in any form but/);
	refuses("a mount with another argument", SERVER.replace('require("./routes/alpha")(ROUTE_CONTEXT);', 'require("./routes/alpha")({ app });'), both(ALPHA), /in any form but/);
	refuses("a module mounted twice", SERVER.replace('require("./routes/beta-two")', 'require("./routes/alpha")'), both(ALPHA), /a second time/);
	refuses("code inside the mount block", SERVER.replace('\nrequire("./routes/beta-two")', '\nshout(1);\nrequire("./routes/beta-two")'), both(ALPHA), /inside the route-module mount block/);
	refuses("a mount below the SPA catch-all", `${SERVER.replace(/^require\("\.\/routes\/.*\n/gm, "")}require("./routes/alpha")(ROUTE_CONTEXT);\n`, { alpha: ALPHA }, /below the SPA catch-all/);
	refuses("mounts with no SPA catch-all", SERVER.replace('app.get("*", ', 'app.get("/x", '), both(ALPHA), /no SPA catch-all/);
	refuses("a mounted module that is missing", SERVER, { alpha: ALPHA }, /can't be read/);
	refuses("an upper-case module name", SERVER.replace("./routes/alpha", "./routes/Alpha"), both(ALPHA), /in any form but/);

	fs.rmSync(tmp, { recursive: true, force: true });
	for (const [k, val] of Object.entries(saved)) if (val !== undefined) process.env[k] = val;
}

// ── §2 the detector ───────────────────────────────────────────────────────────
console.log("\n§2 the reader detector");
{
	const cls = (text) => classOf(text, classify(text)).cls;
	const cases = [
		["a direct read", 'const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");', "direct"],
		["a direct read over lines", 'const SRC = fs.readFileSync(\n\tprocess.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "server.js"),\n\t"utf8",\n);', "direct"],
		["a read inside a function", 'function lift(root) {\n\tconst src = fs.readFileSync(path.join(root, "server.js"), "utf8");\n\treturn src;\n}', "direct"],
		["a path variable", 'const SERVER = process.env.SERVER_JS || path.join(ROOT, "server.js");\nconst SRC = fs.readFileSync(SERVER, "utf8");', "path-variable"],
		["a path variable kept for createRequire only", 'const SERVER = path.join(ROOT, "server.js");\nconst appRequire = createRequire(SERVER);', "boot-or-path"],
		["a local read helper", 'const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");\nconst s = read("server.js");', "local-read-helper"],
		["a local read helper, no semicolons", "const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')\nconst server = read('server.js')\nok('x', server.length > 0)", "local-read-helper"],
		["a function declaration that reads", 'function readSource(rel) {\n\treturn fs.readFileSync(path.join(ROOT, rel), "utf8");\n}\nconst src = readSource("server.js");', "local-read-helper"],
		["a list of code roots", 'const files = [path.join(ROOT, "server.js"), ...fs.readdirSync(path.join(ROOT, "lib"))];\nfor (const f of files) fs.readFileSync(f, "utf8");', "list"],
		["a pushed name", 'const files = [];\nfiles.push("server.js");\nfor (const f of files) fs.readFileSync(path.join(ROOT, f), "utf8");', "list"],
		["a list in a file that reads nothing", 'const LINT = ["server.js", "lib/*.js"];\nok("x", LINT.length === 2);', "boot-or-path"],
		["a boot", 'spawn(process.execPath, ["server.js"], { cwd: WT });', "boot-or-path"],
		["a boot by path", 'const child = spawn(process.execPath, [path.join(__dirname, "server.js")]);', "boot-or-path"],
		["createRequire beside server.js", 'const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");', "boot-or-path"],
		["the repo root finder", 'while (!fs.existsSync(path.join(dir, "server.js"))) dir = path.dirname(dir);', "boot-or-path"],
		["a stand-in written for a test", 'fs.writeFileSync(path.join(APP, "server.js"), "");', "boot-or-path"],
		["a comment and prose", '// reads server.js\nthrow new Error(`expected exactly 1 ${name} in server.js, found ${hits}`);', "mention"],
		["a fixture held in a template", 'const fixture = `const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");`;', "mention"],
		["a block comment", '/* fs.readFileSync(path.join(ROOT, "server.js")) */\nconst a = 1;', "mention"],
		["a regex before the read", 'const re = /"/g;\nconst SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");', "direct"],
		["the helper", 'const { serverSource } = require("./lib/server-source");\nconst SRC = serverSource();', "server-source"],
		["the helper from an .mjs", "import { serverSource } from './lib/server-source.js'\nconst SRC = serverSource()", "server-source"],
		["a world helper", 'const W = require("./lib/work-days-world");', "world-helper"],
		["a made-up tree's file", 'const tree = { "server.js": "process.exit(3)\\n", ".env": "" };\nfs.readFileSync(f);', "boot-or-path"],
		["another machine's copy", 'const rec = { pm_exec_path: `/var/www/${name}/server.js` };\nfs.readFileSync(f);', "mention"],
		["a raw local read beside the helper", 'const { serverSource } = require("./lib/server-source");\nconst SRC = serverSource();\nconst read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");\nconst raw = read("server.js");', "local-read-helper"],
		["a raw pushed list beside the helper", 'const SRC = require("./lib/server-source").serverSource();\nconst files = [];\nfiles.push("server.js");\nfor (const f of files) fs.readFileSync(path.join(ROOT, f), "utf8");', "list"],
		["a list label beside the helper, not on LABELS", 'const { serverSource } = require("./lib/server-source");\nconst files = ["server.js", "lib/a.js"];\nfor (const f of files) { const t = f === "server.js" ? serverSource() : fs.readFileSync(path.join(ROOT, f), "utf8"); }', "list"],
		["a direct read beside the helper", 'const { serverSource } = require("./lib/server-source");\nconst raw = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");', "direct"],
		["a path variable beside the helper", 'const { serverSource } = require("./lib/server-source");\nconst SERVER = path.join(ROOT, "server.js");\nconst raw = fs.readFileSync(SERVER, "utf8");', "path-variable"],
	];
	for (const [name, text, want] of cases) eq(`§2 ${name}: ${want}`, cls(text), want);
	const labelled = (text) => classOf(text, classify(text, { labels: true })).cls;
	eq("§2 on LABELS, a list label beside the helper: server-source", labelled('const { serverSource } = require("./lib/server-source");\nconst files = ["server.js", "lib/a.js"];\nfor (const f of files) { const t = f === "server.js" ? serverSource() : fs.readFileSync(path.join(ROOT, f), "utf8"); }'), "server-source");
	eq("§2 on LABELS, a local reader that routes server.js to the helper: server-source", labelled('const read = (rel) => (rel === "server.js" ? require("./lib/server-source").serverSource() : fs.readFileSync(path.join(ROOT, rel), "utf8"));\nconst s = read("server.js");'), "server-source");
	eq("§2 on LABELS, a direct read beside the helper is still a read: direct", labelled('const { serverSource } = require("./lib/server-source");\nconst raw = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");'), "direct");
	eq("§2 on LABELS without the helper, a pushed list is still a read: list", labelled('const files = [];\nfiles.push("server.js");\nfor (const f of files) fs.readFileSync(path.join(ROOT, f), "utf8");'), "list");
	const scan = (text) => scansWithoutRoutes(classify(text));
	ok("§2 a scanner of server.js and lib/ only is caught", scan('const files = execFileSync("git", ["ls-files"]).toString().split("\\n").filter((f) => f === "server.js" || f.startsWith("lib/"));'));
	ok("§2 the same scanner naming routes/ passes", !scan('const files = execFileSync("git", ["ls-files"]).toString().split("\\n").filter((f) => f === "server.js" || f.startsWith("lib/") || f.startsWith("routes/"));'));
	ok("§2 a readdir scanner of lib/ that reads server.js through the helper passes", !scan('const { serverSource } = require("./lib/server-source");\nconst texts = [serverSource(), ...fs.readdirSync(path.join(ROOT, "lib")).map((f) => fs.readFileSync(path.join(ROOT, "lib", f), "utf8"))];'));
	ok("§2 scripts/lib and one lib/ file are not the lib/ folder", !classify('const x = require(path.join(ROOT, "scripts", "lib", "server-lift"));\nconst y = require(path.join(ROOT, "lib", "app-time.js"));\nfs.readdirSync(path.join(ROOT, "docs"));\nfs.existsSync(path.join(ROOT, "server.js"));').namesLib);
	ok("§2 a lib/ glob and a /^lib\\// filter are the lib/ folder", classify('const a = ["lib/*.js"];').namesLib && classify("const b = files.filter((f) => /^lib\\//.test(f));").namesLib);
	ok("§2 a quoted glob (a shell argument) is the lib/ folder", classify("const LINT = [\"server.js\", \"'lib/*.js'\"];").namesLib);
	ok("§2 a scanner that reads server.js raw beside the helper is caught",
		scan('const { serverSource } = require("./lib/server-source");\nconst files = ["server.js", ...fs.readdirSync(path.join(ROOT, "lib"))];\nfor (const f of files) fs.readFileSync(path.join(ROOT, f), "utf8");'));
	const MOUNTED = 'require("./routes/alpha")(ROUTE_CONTEXT);\napp.get("*", (req, res) => {\n});\n';
	eq("§2 the mount gate: nothing mounted, every list may hold entries", mountGate("const a = 1;\n", [["ALLOW", new Map([["x", "y"]])]]), []);
	eq("§2 the mount gate: a module mounted, a list with entries fails", mountGate(MOUNTED, [["ALLOW", new Map([["x", "y"]])], ["EMPTY", new Map()]]), ["ALLOW (1)"]);
}

// ── §3 and §4 the tree ────────────────────────────────────────────────────────
console.log("\n§3 every scripts/ reader of server.js goes through scripts/lib/server-source.js");
{
	const direct = [];
	const scanners = [];
	const reading = new Set();
	const scanning = new Set();
	const labelled = new Set();
	for (const f of scriptFiles()) {
		if (f === "scripts/lib/server-source.js" || f === "scripts/test-server-readers.js") continue;
		const text = fs.readFileSync(path.join(ROOT, f), "utf8");
		const c = classify(text, { labels: LABELS.has(f) });
		if (c.reads.length) reading.add(f);
		if (c.labelled) labelled.add(f);
		if (scansWithoutRoutes(c)) scanning.add(f);
		if (c.reads.length && !ALLOW.has(f) && !REAL_FILE.has(f) && !NOT_READERS.has(f)) direct.push(`${f} (${classOf(text, c).how})`);
		if (scanning.has(f) && !BEFORE_FIRST_MOVE.has(f)) scanners.push(f);
	}
	ok(`§3 no script reads server.js but through the helper (${ALLOW.size} on ALLOW still do)`, !direct.length,
		`read server.js directly; use serverSource() from scripts/lib/server-source.js:\n      ${direct.join("\n      ")}`);
	const stale = [
		...[...ALLOW.keys(), ...REAL_FILE.keys(), ...NOT_READERS.keys()].filter((f) => !reading.has(f)),
		...[...LABELS.keys()].filter((f) => !labelled.has(f)),
		...[...BEFORE_FIRST_MOVE.keys()].filter((f) => !scanning.has(f)),
	];
	ok("§3 every ALLOW, REAL_FILE, NOT_READERS, LABELS and BEFORE_FIRST_MOVE entry is still needed (remove the ones that aren't)", !stale.length, stale.join(", "));
	ok("§3 every entry has its reason", [ALLOW, REAL_FILE, NOT_READERS, LABELS, BEFORE_FIRST_MOVE].every((m) => [...m.values()].every((r) => typeof r === "string" && r.length > 10)));
	console.log("\n§4 folder scanners of server.js and lib/ cover routes/");
	ok("§4 every scanner that takes server.js and lib/ as code roots names routes/ or reads only through the helper", !scanners.length,
		`add routes/ to its roots or read server.js through serverSource():\n      ${scanners.join("\n      ")}`);
	console.log("\n§5 the lists wait for nothing mounted");
	const waiting = mountGate(fs.readFileSync(path.join(ROOT, "server.js"), "utf8"), [["ALLOW", ALLOW], ["BEFORE_FIRST_MOVE", BEFORE_FIRST_MOVE]]);
	ok("§5 server.js mounts no route module while ALLOW or BEFORE_FIRST_MOVE holds an entry", !waiting.length,
		`a module is mounted; move these files to the helper (or routes/) first: ${waiting.join(", ")}`);
}

console.log(failed ? `\ntest-server-readers: ${failed} failed` : "\ntest-server-readers: all passed");
process.exit(failed ? 1 : 0);
}

if (process.argv.includes("--list")) list();
else main();
