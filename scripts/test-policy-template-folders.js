#!/usr/bin/env node
/**
 * Three onboarding documents read from a folder on the server:
 * lib/policy-template-folders.js, the renderer's use of it
 * (prepareTemplateHtml() in lib/policy-renderer.js) and the apply page's
 * substance policy PDF route, mounted in server.js ahead of the client build.
 *
 *   §1 the settings: one per document, for exactly the contractor agreement,
 *      the substance policy and the vehicle lease; each file name is the
 *      renderer's DOC_FILES entry; the example settings file lists each one
 *      unset; the module names no folder of its own
 *   §2 unset (absent, blank or spaces): every document reads the repo's file,
 *      byte for byte as before
 *   §3 set: each of the three reads its own folder and only its own; every
 *      other document ignores the settings
 *   §4 refusals: a relative path, a missing folder, a file named as the
 *      folder, a missing file, a folder where the file should be, an
 *      unreadable folder or file: each is refused (POLICY_TEMPLATE_UNAVAILABLE)
 *      with the setting and the file named, never the folder, one log line,
 *      and nothing read in its place
 *   §5 escape: a link in the folder to a file outside it is refused; a linked
 *      folder and a link to a file inside are read; a name with a folder part
 *      is refused
 *   §6 the route, on a made-up app (the route, then express.static on a
 *      made-up build): unset or blank, every answer equals the static mount's
 *      alone; set, every spelling the static mount resolves to the build's
 *      copy gets the folder's PDF (GET, HEAD, a range, a revalidation), any
 *      other path or method is answered as without the route, and a PDF that
 *      can't be served is a 503 that never carries the build's copy
 *   §7 the start log: nothing while unset; where each document is read from
 *      and what can't be read, never a folder
 *   §8 server.js mounts the route once, after the replica banner and right
 *      before the static mount, and names no folder setting itself
 *   §9 renders with a stand-in page (no browser; the fill code runs on a stub
 *      document): each document read from a folder of copies of the repo's
 *      templates fills its required labels, the folder's text is what reaches
 *      the page, and a copy that lost a required label is refused
 *   §10 mutants: each guard removed or loosened flips a case above
 *
 * Made-up data only; folders and files under a fresh mkdtemp folder; the
 * made-up apps listen on port 0 of the loopback. No browser, database or
 * outside network.
 *
 * Run: node scripts/test-policy-template-folders.js   # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");
const express = require("express");
const { serverSource } = require("./lib/server-source");

const ROOT = path.join(__dirname, "..");
const FOLDERS_PATH = path.join(ROOT, "lib", "policy-template-folders.js");
const RENDERER_PATH = path.join(ROOT, "lib", "policy-renderer.js");
const TREE = path.join(ROOT, "onboarding-templates", "policy");
const EXAMPLE_SETTINGS = path.join(ROOT, ".env.example");
const POLICY_FIELD_MAPS = require(path.join(ROOT, "lib", "policy-field-maps.js"));
const { applyPaymentTermsToHtml } = require(path.join(ROOT, "lib", "investor-payment-terms.js"));

const DOCS = Object.freeze({
	contractor_agreement: { setting: "POLICY_TEMPLATE_DIR_CONTRACTOR_AGREEMENT", file: "contractor-agreement.html" },
	substance_policy: { setting: "POLICY_TEMPLATE_DIR_SUBSTANCE_POLICY", file: "substance-policy.html" },
	vehicle_lease: { setting: "POLICY_TEMPLATE_DIR_VEHICLE_LEASE", file: "vehicle-lease.html" },
});
const SETTINGS = Object.values(DOCS).map((d) => d.setting);
const SUB = DOCS.substance_policy.setting;
const PDF = "LogisX-Substance-Policy.pdf";
const LINK = `/policies/${PDF}`;
const REFUSED = "POLICY_TEMPLATE_UNAVAILABLE";
const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const FOLDERS_SRC = fs.existsSync(FOLDERS_PATH) ? fs.readFileSync(FOLDERS_PATH, "utf8") : null;
const RENDERER_SRC = fs.readFileSync(RENDERER_PATH, "utf8");

// The shell's own values never reach a case.
for (const s of SETTINGS) delete process.env[s];

// --- output and logs -------------------------------------------------------------
let passed = 0;
let failed = 0;
let skipped = 0;
const out = (s) => process.stdout.write(`${s}\n`);
function ok(name, cond, detail) {
	if (cond) { passed++; out(`ok    ${name}`); }
	else { failed++; out(`FAIL  ${name}${detail === undefined ? "" : `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`); }
}
function skip(name) { skipped++; out(`skip  ${name} (run as root, which reads any file)`); }
const section = (title) => out(`\n§ ${title}`);

// Every console line the code under test writes, while the cases run.
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let logLines = [];
function collectLogs() {
	logLines = [];
	for (const k of Object.keys(realConsole)) console[k] = (...a) => { logLines.push(a.map(String).join(" ")); };
}
function takeLogs() { const lines = logLines; logLines = []; return lines; }
function restoreLogs() { Object.assign(console, realConsole); }
const policyLines = (lines) => lines.filter((l) => l.startsWith("[policy-templates]"));

// --- made-up folders ---------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "policy-folders-"));
const locked = new Set();
function lock(p) { fs.chmodSync(p, 0o000); locked.add(p); }
function unlock(p) { fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o755 : 0o644); locked.delete(p); }
process.on("exit", () => {
	for (const p of locked) { try { fs.chmodSync(p, 0o755); } catch { /* already gone */ } }
	fs.rmSync(TMP, { recursive: true, force: true });
});

const treeText = (file) => fs.readFileSync(path.join(TREE, file), "utf8");
const marker = (tag) => `\n<!-- made-up folder copy: ${tag} -->\n`;
function folderOf(name, files = {}) {
	const dir = path.join(TMP, name);
	fs.mkdirSync(dir, { recursive: true });
	for (const [f, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
		fs.writeFileSync(path.join(dir, f), content);
	}
	return dir;
}
// The repo's three templates, each with a made-up marker appended, and a made-up PDF.
function copiesFolder(name) {
	const files = {};
	for (const [key, d] of Object.entries(DOCS)) files[d.file] = treeText(d.file) + marker(`${name} ${key}`);
	files[PDF] = `%PDF-1.4\n% made-up folder copy ${name}\n`;
	return folderOf(name, files);
}
const readIn = (folder, file) => fs.readFileSync(path.join(folder, file), "utf8");

function docFilesOf(src) {
	const block = /const DOC_FILES = \{([\s\S]*?)\n\};/.exec(src);
	const files = {};
	if (block) for (const m of block[1].matchAll(/^\t([a-z_]+): "([^"]+)",/gm)) files[m[1]] = m[2];
	return files;
}
const DOC_FILES = docFilesOf(RENDERER_SRC);
const OTHER_DOCS = Object.keys(DOC_FILES).filter((k) => !DOCS[k]);

const FX = {};
FX.a = copiesFolder("folder-a");
FX.b = copiesFolder("folder-b");
FX.c = copiesFolder("folder-c");
FX.empty = folderOf("empty");
FX.notFolder = path.join(TMP, "a-file-not-a-folder");
fs.writeFileSync(FX.notFolder, "made-up file\n");
FX.missing = path.join(TMP, "no-such-folder");
FX.relative = path.relative(process.cwd(), FX.a);
FX.dirAsFile = folderOf("dir-as-file");
for (const f of [...Object.values(DOCS).map((d) => d.file), PDF]) fs.mkdirSync(path.join(FX.dirAsFile, f));
FX.outside = folderOf("outside", { "outside.html": "<p>made-up file outside every folder</p>\n" });
FX.outsideText = readIn(FX.outside, "outside.html");
FX.linkOut = folderOf("link-out");
for (const f of [...Object.values(DOCS).map((d) => d.file), PDF]) fs.symlinkSync(path.join(FX.outside, "outside.html"), path.join(FX.linkOut, f));
FX.linkedFolder = path.join(TMP, "linked-folder");
fs.symlinkSync(FX.a, FX.linkedFolder);
FX.linkIn = copiesFolder("link-in");
fs.writeFileSync(path.join(FX.linkIn, "real-substance.html"), treeText(DOCS.substance_policy.file) + marker("link-in target"));
fs.rmSync(path.join(FX.linkIn, DOCS.substance_policy.file));
fs.symlinkSync("real-substance.html", path.join(FX.linkIn, DOCS.substance_policy.file));
FX.sub = copiesFolder("with-sub");
fs.mkdirSync(path.join(FX.sub, "sub"));
fs.writeFileSync(path.join(FX.sub, "sub", "inner.html"), "<p>made-up inner file</p>\n");
FX.lockedFolder = copiesFolder("locked-folder");
FX.lockedFile = copiesFolder("locked-file");
FX.htmlOnly = folderOf("html-only", { [DOCS.substance_policy.file]: treeText(DOCS.substance_policy.file) });
// The other documents' files, doctored, where the three settings point.
FX.others = folderOf("others", Object.fromEntries(OTHER_DOCS.map((k) => [DOC_FILES[k], "<p>made-up doctored copy</p>\n"])));
// A made-up client build, and the route's folder (each file's bytes distinct).
FX.dist = folderOf("dist", {
	[`policies/${PDF}`]: "%PDF-1.4\n% made-up BUILD copy of the substance policy\n",
	"policies/LogisX-Mobile-Policy.pdf": "%PDF-1.4\n% made-up build copy of another policy\n",
	"index.html": "<!doctype html><title>made-up app page</title>\n",
});
FX.route = folderOf("route", {
	[PDF]: "%PDF-1.4\n% made-up FOLDER copy of the substance policy, a little longer than the build's\n",
	[DOCS.substance_policy.file]: "<p>made-up substance template</p>\n",
	[DOCS.contractor_agreement.file]: "<p>made-up contractor template</p>\n",
	[DOCS.vehicle_lease.file]: "<p>made-up lease template</p>\n",
	"made-up-other.txt": "made-up other file\n",
	[`sub/${PDF}`]: "%PDF-1.4\n% made-up inner copy\n",
});
FX.routeLocked = folderOf("route-locked", { [PDF]: "%PDF-1.4\n% made-up locked copy\n" });

// --- loading the code under test (or a mutant of it) ------------------------------
function compileAt(file, src, overrides = {}) {
	const realRequire = Module.prototype.require;
	Module.prototype.require = function (id) {
		if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
		return realRequire.apply(this, arguments);
	};
	try {
		const m = new Module(file, null);
		m.filename = file;
		m.paths = Module._nodeModulePaths(path.dirname(file));
		m._compile(src, file);
		return m.exports;
	} finally {
		Module.prototype.require = realRequire;
	}
}

// CSS.escape for the labels the fill code looks up, and its inverse for the stub.
const cssEscape = (value) => String(value).replace(/[^A-Za-z0-9_\u0080-￿-]/g, (c) => `\\${c}`);
const cssUnescape = (s) => s.replace(/\\([\s\S])/g, "$1");
function parseSelector(sel) {
	const m = /^([a-z]*)((?:\[[a-z-]+(?:="(?:[^"\\]|\\[\s\S])*")?\])*)$/i.exec(sel);
	if (!m) throw new Error(`stub document: unsupported selector ${sel}`);
	const attrs = [...m[2].matchAll(/\[([a-z-]+)(?:="((?:[^"\\]|\\[\s\S])*)")?\]/gi)]
		.map((a) => [a[1].toLowerCase(), a[2] === undefined ? undefined : cssUnescape(a[2])]);
	return { tag: m[1].toUpperCase(), attrs };
}
// Every element of the page that carries an aria-label or a data- attribute
// (all the fill code looks up), in document order, with its own text.
function stubDocument(html) {
	const nodes = [];
	function makeNode(tagName, attrs, initialText) {
		let value = tagName === "INPUT" ? (attrs.get("value") ?? "") : "";
		let text = initialText;
		const node = {
			tagName,
			style: {},
			getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
			setAttribute: (k, v) => { attrs.set(k, String(v)); },
			removeAttribute: (k) => { attrs.delete(k); },
			hasAttribute: (k) => attrs.has(k),
			get value() { return value; },
			set value(v) { value = String(v); },
			get textContent() { return text; },
			set textContent(v) { text = v == null ? "" : String(v); },
			get src() { return attrs.get("src") ?? ""; },
			set src(v) { attrs.set("src", String(v)); },
			replaceWith(other) {
				const at = nodes.indexOf(node);
				if (at < 0) throw new Error("stub document: replaceWith on a node not in the document");
				nodes.splice(at, 1, other);
			},
		};
		return node;
	}
	const doc = {
		querySelectorAll(sel) {
			const q = parseSelector(sel);
			return nodes.filter((n) => (!q.tag || n.tagName === q.tag) &&
				q.attrs.every(([k, v]) => (v === undefined ? n.hasAttribute(k) : n.getAttribute(k) === v)));
		},
		querySelector(sel) { return doc.querySelectorAll(sel)[0] || null; },
		getElementById: () => null,
		createElement: (tag) => makeNode(String(tag).toUpperCase(), new Map(), ""),
	};
	for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g)) {
		const attrs = new Map();
		for (const a of m[2].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g)) {
			attrs.set(a[1].toLowerCase(), (a[2] ?? "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&"));
		}
		if (!attrs.has("aria-label") && ![...attrs.keys()].some((k) => k.startsWith("data-"))) continue;
		const tagName = m[1].toUpperCase();
		const after = m.index + m[0].length;
		nodes.push(makeNode(tagName, attrs, tagName === "INPUT" ? "" : html.slice(after, html.indexOf("<", after))));
	}
	return doc;
}
// A stand-in for ./pdf-browser: the page runs the renderer's in-page functions
// on the stub document, from their source and a JSON copy of their argument, as
// Puppeteer does.
function fakeBrowser(rec) {
	return {
		openPageWithContent: async (html) => {
			rec.html.push(html);
			const doc = stubDocument(html);
			return {
				async evaluate(fn, arg) {
					const inPage = new Function("document", "CSS", `return (${fn.toString()});`)(doc, { escape: cssEscape });
					const result = await inPage(arg === undefined ? undefined : JSON.parse(JSON.stringify(arg)));
					const back = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
					rec.results.push(back);
					return back;
				},
				async pdf() { return new Uint8Array(Buffer.from("%PDF-1.7\n% made-up stand-in for the browser's output\n")); },
				async close() { rec.closed++; },
			};
		},
	};
}
const newRecord = () => ({ html: [], results: [], closed: 0 });

function contextFor({ Fsrc, Rsrc }, check, skipCase) {
	const F = Fsrc == null ? null : compileAt(FOLDERS_PATH, Fsrc);
	const R = (rec = newRecord()) => {
		const overrides = { "./pdf-browser": fakeBrowser(rec), puppeteer: {} };
		if (F) overrides["./policy-template-folders"] = F;
		return compileAt(RENDERER_PATH, Rsrc, overrides);
	};
	return { F, Fsrc, Rsrc, R, check, skipCase };
}

function setEnv(vars) {
	for (const s of SETTINGS) delete process.env[s];
	for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}
const clearEnv = () => setEnv({});
function prepared(R, docKey) {
	try { return { html: R.prepareTemplateHtml(docKey, {}), error: null }; }
	catch (error) { return { html: null, error }; }
}
// A template's text as prepareTemplateHtml() hands it on with no payment terms:
// its slots at their default lines and the logo filled in, as before this change.
const LOGO = path.join(ROOT, "logo.png");
const LOGO_URI = fs.existsSync(LOGO) ? `data:image/png;base64,${fs.readFileSync(LOGO).toString("base64")}` : "";
const asRendered = (docKey, text) => applyPaymentTermsToHtml(text, docKey, null).replace(/\{\{LOGO_SRC\}\}/g, LOGO_URI);
const shortError = (e) => (e ? `${e.code || ""} ${e.message}`.trim() : "no error");

// --- §1 the settings ---------------------------------------------------------------
function g1Settings({ F, Fsrc, check }) {
	check("§1 the renderer lists the three documents under the module's file names",
		Object.entries(DOCS).every(([k, d]) => DOC_FILES[k] === d.file), DOC_FILES);
	const example = fs.readFileSync(EXAMPLE_SETTINGS, "utf8").split("\n");
	for (const s of SETTINGS) {
		check(`§1 the example settings file lists ${s}, unset`, example.filter((l) => l === `# ${s}=`).length === 1);
		check(`§1 ...and never sets it`, !example.some((l) => l.startsWith(`${s}=`)));
	}
	const text = example.join("\n");
	check("§1 the example names each folder's files", [...Object.values(DOCS).map((d) => d.file), PDF].every((f) => text.includes(f)));
	if (!F) { check("§1 lib/policy-template-folders.js exists", false); return; }
	check("§1 one setting for each of the three documents, and no other",
		JSON.stringify(Object.keys(F.FOLDER_DOCUMENTS).sort()) === JSON.stringify(Object.keys(DOCS).sort()), Object.keys(F.FOLDER_DOCUMENTS));
	for (const [k, d] of Object.entries(DOCS)) {
		const got = F.FOLDER_DOCUMENTS[k] || {};
		check(`§1 ${k}: ${d.setting}, ${d.file}`, got.env === d.setting && got.file === d.file, got);
	}
	const named = [...new Set([...Fsrc.matchAll(/"(POLICY_TEMPLATE_DIR_[A-Z_]+)"/g)].map((m) => m[1]))].sort();
	check("§1 the module reads these three settings and no other of the kind", JSON.stringify(named) === JSON.stringify([...SETTINGS].sort()), named);
	check("§1 the module names no folder of its own (no default)", !/["'`]\/(?:var|srv|opt|home|root|etc|usr|tmp|mnt|data|Users|private)\b/.test(Fsrc));
	check("§1 the PDF it serves is the apply page's file", F.SUBSTANCE_POLICY_PDF === PDF);
}

// --- §2 unset ----------------------------------------------------------------------
function g2Unset({ R: loadR, check }) {
	const R = loadR();
	for (const [label, value] of [["absent", null], ["blank", ""], ["spaces", "   "]]) {
		setEnv(value === null ? {} : Object.fromEntries(SETTINGS.map((s) => [s, value])));
		try {
			for (const [key, file] of Object.entries(DOC_FILES)) {
				const r = prepared(R, key);
				check(`§2 ${label}: ${key} is the repo's ${file}, as before`, r.html === asRendered(key, treeText(file)), shortError(r.error));
			}
		} finally { clearEnv(); }
	}
}

// --- §3 set ------------------------------------------------------------------------
function g3Set({ R: loadR, check }) {
	const R = loadR();
	const own = { contractor_agreement: FX.a, substance_policy: FX.b, vehicle_lease: FX.c };
	setEnv(Object.fromEntries(Object.entries(DOCS).map(([k, d]) => [d.setting, own[k]])));
	try {
		for (const [k, d] of Object.entries(DOCS)) {
			const r = prepared(R, k);
			check(`§3 ${k} is read from the folder ${d.setting} names, and only that one`, r.html === asRendered(k, readIn(own[k], d.file)), shortError(r.error));
		}
	} finally { clearEnv(); }
	setEnv({ [SUB]: FX.b });
	try {
		check("§3 only the substance policy set: it reads its folder", prepared(R, "substance_policy").html === asRendered("substance_policy", readIn(FX.b, DOCS.substance_policy.file)));
		for (const k of ["contractor_agreement", "vehicle_lease"]) {
			check(`§3 ...and ${k} stays on the repo`, prepared(R, k).html === asRendered(k, treeText(DOCS[k].file)));
		}
	} finally { clearEnv(); }
	setEnv(Object.fromEntries(SETTINGS.map((s) => [s, FX.others])));
	try {
		for (const k of OTHER_DOCS) {
			const r = prepared(R, k);
			check(`§3 ${k} ignores the three settings, even with its file in the folder`, r.html === asRendered(k, treeText(DOC_FILES[k])), shortError(r.error));
		}
	} finally { clearEnv(); }
}

// --- §4 refusals -------------------------------------------------------------------
const REFUSAL_CASES = [
	{ label: "a relative path", folder: () => FX.relative, reason: "the setting is not an absolute folder path" },
	{ label: "a missing folder", folder: () => FX.missing, reason: "the folder is missing" },
	{ label: "a file named as the folder", folder: () => FX.notFolder, reason: "the setting does not name a folder" },
	{ label: "a folder without the file", folder: () => FX.empty, reason: "the file is missing" },
	{ label: "a folder where the file should be", folder: () => FX.dirAsFile, reason: "the file is not a regular file" },
	{ label: "an unreadable folder", folder: () => FX.lockedFolder, lockPath: () => FX.lockedFolder, reason: "the folder can't be read", needsNonRoot: true },
	{ label: "an unreadable file", folder: () => FX.lockedFile, lockPath: (d) => path.join(FX.lockedFile, d.file), reason: "the file can't be read", needsNonRoot: true },
];
function g4Refusals({ R: loadR, check, skipCase }) {
	const R = loadR();
	const plan = [];
	for (const c of REFUSAL_CASES) plan.push(["substance_policy", c]);
	for (const k of ["contractor_agreement", "vehicle_lease"]) plan.push([k, REFUSAL_CASES[3]], [k, REFUSAL_CASES[1]]);
	for (const [k, c] of plan) {
		const d = DOCS[k];
		const name = `§4 ${k}, ${c.label}`;
		if (c.needsNonRoot && AS_ROOT) { skipCase(name); continue; }
		const folder = c.folder();
		const lockAt = c.lockPath ? c.lockPath(d) : null;
		setEnv({ [d.setting]: folder });
		takeLogs();
		let r;
		try {
			if (lockAt) lock(lockAt);
			r = prepared(R, k);
		} finally {
			if (lockAt) unlock(lockAt);
			clearEnv();
		}
		const lines = policyLines(takeLogs());
		const msg = r.error ? String(r.error.message) : "";
		check(`${name}: refused (${REFUSED}), nothing read in its place`, r.html === null && r.error && r.error.code === REFUSED, r.html === null ? shortError(r.error) : "it handed back a template");
		check(`${name}: the reason reads "${c.reason}"`, msg.includes(c.reason), msg);
		check(`${name}: the refusal names ${d.setting} and ${d.file}, never the folder`, msg.includes(d.setting) && msg.includes(d.file) && !msg.includes(folder) && !msg.includes(TMP), msg);
		check(`${name}: one log line naming the setting and the file, never the folder`,
			lines.length === 1 && lines[0].includes(d.setting) && lines[0].includes(d.file) && !lines[0].includes(TMP), lines);
	}
}

// --- §5 escape ---------------------------------------------------------------------
function g5Escape({ F, R: loadR, check }) {
	const R = loadR();
	for (const [k, d] of Object.entries(DOCS)) {
		setEnv({ [d.setting]: FX.linkOut });
		takeLogs();
		let r;
		try { r = prepared(R, k); } finally { clearEnv(); }
		takeLogs();
		check(`§5 ${k}: a link in the folder to a file outside it is refused`, r.html === null && r.error && r.error.code === REFUSED && /resolves outside the folder/.test(r.error.message), shortError(r.error));
		check(`§5 ${k}: ...and the outside file's text is never handed back`, r.html !== FX.outsideText);
	}
	setEnv({ [SUB]: FX.linkedFolder });
	try {
		check("§5 a folder that is itself a link is read", prepared(R, "substance_policy").html === asRendered("substance_policy", readIn(FX.a, DOCS.substance_policy.file)));
	} finally { clearEnv(); }
	setEnv({ [SUB]: FX.linkIn });
	try {
		check("§5 a link to another file inside the folder is read", prepared(R, "substance_policy").html === asRendered("substance_policy", readIn(FX.linkIn, "real-substance.html")));
	} finally { clearEnv(); }
	if (!F) { check("§5 locateFolderFile exists", false); return; }
	const names = [
		["a name that climbs out", "../outside/outside.html"],
		["a name inside a subfolder", "sub/inner.html"],
		["an absolute name", path.join(FX.outside, "outside.html")],
		["\".\"", "."],
		["\"..\"", ".."],
		["an empty name", ""],
		["a name with a NUL", "made\u0000up.html"],
	];
	for (const [label, name] of names) {
		const r = F.locateFolderFile(FX.sub, name);
		check(`§5 ${label} is refused`, Boolean(r.reason) && !r.file, r);
	}
	check("§5 a plain name in the folder is found, by its real path",
		F.locateFolderFile(FX.sub, DOCS.substance_policy.file).file === fs.realpathSync(path.join(FX.sub, DOCS.substance_policy.file)));
}

// --- §6 the route --------------------------------------------------------------------
function request(port, method, reqPath, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method, path: reqPath, headers, agent: false }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
}
// Status, body and every header but the clock.
const view = (r) => JSON.stringify([r.status, r.body.toString("latin1"), Object.entries(r.headers).filter(([k]) => k !== "date").sort()]);

// Spellings of the link, each with whether the route serves the folder's PDF
// for it: every spelling the static mount resolves to the file (decoded and
// normalized; any letter case, as a case-insensitive disk would), and no other.
const SPELLINGS = [
	[LINK, true],
	["/POLICIES/LOGISX-SUBSTANCE-POLICY.PDF", true],
	["/policies/logisx-substance-policy.pdf", true],
	["/policies//LogisX-Substance-Policy.pdf", true],
	["//policies/LogisX-Substance-Policy.pdf", true],
	["/policies/./LogisX-Substance-Policy.pdf", true],
	["/made-up/../policies/LogisX-Substance-Policy.pdf", true],
	["/policies/LogisX%2DSubstance-Policy.pdf", true],
	["/policies%2FLogisX-Substance-Policy.pdf", true],
	["/%70olicies/LogisX-Substance-Policy.pdf", true],
	["/policies/%2e/LogisX-Substance-Policy.pdf", true],
	["/policies/%2E%2E/policies/LogisX-Substance-Policy.pdf", true],
	["/.%2Fpolicies/LogisX-Substance-Policy.pdf", true],
	["/policies/LogisX-Substance-Policy.pdf/.", true],
	["/policies/LogisX-Substance-Policy.pdf%2F.", true],
	[`${LINK}?download=1`, true],
	[`${LINK}/`, false],
	[`${LINK}%00`, false],
	[`${LINK};x`, false],
	["/policies\\LogisX-Substance-Policy.pdf", false],
];
const OTHERS = [
	"/policies/substance-policy.html",
	"/policies/contractor-agreement.html",
	"/policies/vehicle-lease.html",
	"/policies/made-up-other.txt",
	"/policies/sub/LogisX-Substance-Policy.pdf",
	"/substance-policy.html",
	"/LogisX-Substance-Policy.pdf",
	"/policies/LogisX-Substance-Policy.pdf/../substance-policy.html",
	"/policies/..%2Fsubstance-policy.html",
	"/policies/LogisX-Mobile-Policy.pdf",
	"/policies/LogisX-Substance-Policy.pdfx",
	"/policies/LogisX-Substance-Policy",
	"/policies/",
	"/policies",
	"/",
	"/api/made-up",
];

async function g6Route({ F, check, skipCase }) {
	if (!F || typeof F.substancePolicyPdf !== "function") { check("§6 the route exists (substancePolicyPdf)", false); return; }
	const servers = [];
	const passOn = (req, res) => res.status(404).type("text").send("passed on");
	const start = (app) => new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s.address().port));
		servers.push(s);
	});
	const staticOnly = () => { const app = express(); app.use(express.static(FX.dist)); app.use(passOn); return app; };
	const withRoute = (env) => { const app = express(); app.use(F.substancePolicyPdf({ env })); app.use(express.static(FX.dist)); app.use(passOn); return app; };
	const BUILD = fs.readFileSync(path.join(FX.dist, "policies", PDF));
	const FOLDER = fs.readFileSync(path.join(FX.route, PDF));
	const folderFiles = [PDF, DOCS.substance_policy.file, DOCS.contractor_agreement.file, DOCS.vehicle_lease.file, "made-up-other.txt", `sub/${PDF}`]
		.map((f) => fs.readFileSync(path.join(FX.route, f)));
	try {
		const base = await start(staticOnly());
		const unset = await start(withRoute({}));
		const blank = await start(withRoute({ [SUB]: "   " }));
		const set = await start(withRoute({ [SUB]: FX.route }));
		takeLogs();

		// Unset or blank: exactly the static mount alone.
		const paths = [...SPELLINGS.map(([p]) => p), ...OTHERS];
		let same = 0;
		const differ = [];
		for (const p of paths) {
			for (const method of ["GET", "HEAD"]) {
				const want = view(await request(base, method, p));
				for (const [label, port] of [["unset", unset], ["blank", blank]]) {
					if (view(await request(port, method, p)) === want) same++;
					else differ.push(`${label} ${method} ${p}`);
				}
			}
		}
		for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
			const want = view(await request(base, method, LINK));
			for (const [label, port] of [["unset", unset], ["blank", blank]]) {
				if (view(await request(port, method, LINK)) === want) same++;
				else differ.push(`${label} ${method} ${LINK}`);
			}
		}
		check(`§6 unset or blank: all ${same + differ.length} answers equal the static mount's alone (status, body, headers)`, differ.length === 0, differ.slice(0, 5));
		check("§6 unset: the build's copy is still what the link serves", (await request(unset, "GET", LINK)).body.equals(BUILD));

		// Set: every spelling the static mount resolves to the build's copy gets the folder's.
		for (const [p, servesFolder] of SPELLINGS) {
			const was = await request(base, "GET", p);
			const got = await request(set, "GET", p);
			if (was.status === 200 && was.body.equals(BUILD)) {
				check(`§6 the static mount serves the build's copy for ${p}, so the table has the route serve the folder's`, servesFolder);
			}
			if (servesFolder) {
				check(`§6 set: ${p} gets the folder's PDF`,
					got.status === 200 && got.body.equals(FOLDER) && got.headers["content-type"] === "application/pdf", [got.status, got.body.toString("latin1").slice(0, 40)]);
			} else {
				check(`§6 set: ${p} is answered as without the route`, view(got) === view(was));
			}
			check(`§6 set: ${p} never gets the build's copy`, !got.body.equals(BUILD));
		}

		const was = await request(base, "GET", LINK);
		const got = await request(set, "GET", LINK);
		check("§6 set: the same caching headers as the build's copy (Cache-Control, Accept-Ranges, Content-Type)",
			["cache-control", "accept-ranges", "content-type"].every((h) => got.headers[h] === was.headers[h]) && Boolean(got.headers.etag) && Boolean(got.headers["last-modified"]),
			[got.headers["cache-control"], was.headers["cache-control"]]);
		const head = await request(set, "HEAD", LINK);
		check("§6 set: HEAD answers 200 with the folder PDF's length and no body", head.status === 200 && Number(head.headers["content-length"]) === FOLDER.length && head.body.length === 0, [head.status, head.headers["content-length"]]);
		const range = await request(set, "GET", LINK, { Range: "bytes=0-5" });
		check("§6 set: a range request gets those bytes of the folder's PDF (206)", range.status === 206 && range.body.equals(FOLDER.subarray(0, 6)), range.status);
		const again = await request(set, "GET", LINK, { "If-None-Match": got.headers.etag });
		check("§6 set: a revalidation with its ETag answers 304", again.status === 304, again.status);

		// Set: any other path or method is answered as without the route.
		for (const p of OTHERS) {
			const w = await request(base, "GET", p);
			const g = await request(set, "GET", p);
			check(`§6 set: ${p} is answered as without the route`, view(g) === view(w));
			check(`§6 set: ${p} carries no file of the folder`, !folderFiles.some((b) => g.body.equals(b)));
		}
		for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
			const w = await request(base, method, LINK);
			const g = await request(set, method, LINK);
			check(`§6 set: ${method} on the link is answered as without the route`, view(g) === view(w) && !g.body.equals(FOLDER));
		}
		check("§6 set and served: no log line", policyLines(takeLogs()).length === 0);

		// Set, but the PDF can't be served: a 503, never the build's copy.
		const refusals = [
			["the folder has no PDF", FX.htmlOnly, "the file is missing"],
			["a missing folder", FX.missing, "the folder is missing"],
			["the PDF is a link to a file outside the folder", FX.linkOut, "the file resolves outside the folder"],
			["a folder where the PDF should be", FX.dirAsFile, "the file is not a regular file"],
			["a relative path", FX.relative, "the setting is not an absolute folder path"],
		];
		for (const [label, folder, reason] of refusals) {
			const port = await start(withRoute({ [SUB]: folder }));
			takeLogs();
			for (const method of ["GET", "HEAD"]) {
				const r = await request(port, method, LINK);
				const body = r.body.toString("latin1");
				check(`§6 set, ${label}: ${method} answers 503, not cached, with no file in it`,
					r.status === 503 && r.headers["cache-control"] === "no-store" && /^text\/plain/.test(r.headers["content-type"] || "") &&
					!r.body.equals(BUILD) && !body.includes(FX.outsideText) && !r.headers.location && !body.includes(TMP),
					[r.status, r.headers["cache-control"], r.headers.location, body.slice(0, 60)]);
			}
			const lines = policyLines(takeLogs());
			check(`§6 set, ${label}: one log line per request, naming the setting, the PDF and "${reason}", never the folder`,
				lines.length === 2 && lines.every((l) => l.includes(SUB) && l.includes(PDF) && l.includes(reason) && !l.includes(TMP)), lines);
		}
		// A PDF found but unreadable fails inside the send itself.
		if (AS_ROOT) skipCase("§6 set, an unreadable PDF");
		else {
			const port = await start(withRoute({ [SUB]: FX.routeLocked }));
			const at = path.join(FX.routeLocked, PDF);
			takeLogs();
			let r;
			try { lock(at); r = await request(port, "GET", LINK); } finally { unlock(at); }
			const lines = policyLines(takeLogs());
			check("§6 set, an unreadable PDF: 503, never the build's copy", r.status === 503 && !r.body.equals(BUILD) && r.headers["cache-control"] === "no-store", r.status);
			check("§6 set, an unreadable PDF: one log line naming the setting, never the folder", lines.length === 1 && lines[0].includes(SUB) && !lines[0].includes(TMP), lines);
		}
	} finally {
		for (const s of servers) s.close();
	}
}

// --- §7 the start log -----------------------------------------------------------------
function g7StartLog({ F, check }) {
	if (!F) { check("§7 the start log exists", false); return; }
	takeLogs();
	F.logFolderSettings({});
	F.substancePolicyPdf({ env: { [SUB]: "  " } });
	check("§7 unset or blank: no start line at all", takeLogs().length === 0);
	F.substancePolicyPdf({ env: { [SUB]: FX.a } });
	let lines = takeLogs();
	check("§7 building the route logs each document once while one is set", lines.length === 3, lines);
	check("§7 ...the substance policy: read from the folder its setting names",
		lines.some((l) => l === `[policy-templates] substance_policy: read from the folder ${SUB} names`), lines);
	check("§7 ...the other two: read from the repo, their settings unset",
		["contractor_agreement", "vehicle_lease"].every((k) => lines.some((l) => l === `[policy-templates] ${k}: read from the repo (${DOCS[k].setting} is unset)`)), lines);
	F.logFolderSettings({ [SUB]: FX.htmlOnly, [DOCS.vehicle_lease.setting]: FX.missing });
	lines = takeLogs();
	check("§7 what can't be read is named: the substance PDF missing from its folder",
		lines.some((l) => l.includes(SUB) && l.includes(PDF) && l.includes("the file is missing")), lines);
	check("§7 ...and the lease's folder missing", lines.some((l) => l.includes(DOCS.vehicle_lease.setting) && l.includes(DOCS.vehicle_lease.file) && l.includes("the folder is missing")), lines);
	check("§7 no start line names a folder", !lines.some((l) => l.includes(TMP)), lines);
	const report = F.folderSettingsReport({ [SUB]: FX.a });
	check("§7 the report: set and clean for the substance policy, unset for the other two",
		report.length === 3 && report.every((r) => r.set === (r.docKey === "substance_policy") && r.problems.length === 0), report);
}

// --- §8 server.js -----------------------------------------------------------------------
function g8Server() {
	const src = serverSource();
	const lines = src.split("\n");
	const gate = lines.indexOf("app.use(withheldLoadKeyGate);");
	const required = lines.indexOf("const policyTemplateFolders = require(\"./lib/policy-template-folders\");");
	const mount = lines.indexOf("app.use(policyTemplateFolders.substancePolicyPdf());");
	const staticMount = lines.indexOf("app.use(express.static(clientDistPath));");
	const firstRoute = lines.findIndex((l) => /^app\.(get|post|put|patch|delete|all)\(/.test(l));
	ok("§8 server.js mounts the route below the last middleware every request passes (the load-key gate)",
		gate >= 0 && required > gate && mount === required + 1 && lines.slice(gate + 1, required).every((l) => /^\s*\/\//.test(l)), { gate, required, mount });
	ok("§8 ...above every route, as middleware that sees every path must be (test-route-snapshot.js §3)",
		mount >= 0 && firstRoute > mount, { mount, firstRoute });
	ok("§8 ...and ahead of the static mount that serves the build's copy", mount >= 0 && staticMount > mount, { mount, staticMount });
	ok("§8 the route is built once", src.split("substancePolicyPdf(").length - 1 === 1);
	ok("§8 server.js names none of the folder settings (the module reads them)", !/POLICY_TEMPLATE_DIR_/.test(src));
}

// --- §9 renders with a stand-in page ----------------------------------------------------
const DATA = Object.freeze({
	substance_policy: { fullName: "Made-Up Driver Seven", signatureText: "Made-Up Driver Seven", effectiveDate: "October 31, 2026" },
	contractor_agreement: {
		fullName: "Made-Up Driver Seven", address: "100 Made-Up Way, Testville, TX 75000", signatureText: "Made-Up Driver Seven",
		effectiveDate: "October 31, 2026", paymentMethod: "check", checkName: "Made-Up Driver Seven",
	},
	vehicle_lease: {
		legalName: "Made-Up Hauling LLC", signatureText: "Made-Up Investor Nine", address: "200 Made-Up Road, Testville, TX 75000",
		email: "investor@example.test", signedAt: "October 31, 2026, 9:00 AM",
		vehicles: [{ year: "2020", make: "Made-Up", model: "M7", vin: "1MADEUP7TEST00007", unitNumber: "MU-7" }],
	},
});
FX.broken = {};
for (const [k, d] of Object.entries(DOCS)) {
	const first = POLICY_FIELD_MAPS[k](DATA[k]).requiredText[0];
	const text = readIn(FX.a, d.file);
	FX.broken[k] = folderOf(`broken-${k}`, { [d.file]: text.split(`aria-label="${first}"`).join(`aria-label="${first} (made-up rename)"`) });
}

async function g9Renders({ R: loadR, check }) {
	for (const [k, d] of Object.entries(DOCS)) {
		const required = POLICY_FIELD_MAPS[k](DATA[k]).requiredText;
		const rec = newRecord();
		const R = loadR(rec);
		setEnv({ [d.setting]: FX.a });
		let pdf = null;
		let error = null;
		try { pdf = await R.renderPolicy(k, DATA[k]); } catch (e) { error = e; } finally { clearEnv(); }
		check(`§9 ${k}: renders from the folder's copy of the repo's template`, !error && Buffer.isBuffer(pdf), shortError(error));
		check(`§9 ${k}: the folder's text is what reached the page`, rec.html[0] === asRendered(k, readIn(FX.a, d.file)));
		const report = rec.results[0] || {};
		check(`§9 ${k}: every required label filled (${required.join(", ")})`, required.every((l) => (report.verified || []).includes(l)), report.verified);
		check(`§9 ${k}: the page was closed`, rec.closed === 1, rec.closed);

		const brokenText = readIn(FX.broken[k], d.file);
		check(`§9 ${k}: the made-up broken copy differs from the copy`, brokenText !== readIn(FX.a, d.file));
		const rec2 = newRecord();
		const R2 = loadR(rec2);
		setEnv({ [d.setting]: FX.broken[k] });
		let error2 = null;
		try { await R2.renderPolicy(k, DATA[k]); } catch (e) { error2 = e; } finally { clearEnv(); }
		check(`§9 ${k}: a folder copy that lost "${required[0]}" is refused (DOCUMENT_FIELDS_UNFILLED)`, Boolean(error2) && error2.code === "DOCUMENT_FIELDS_UNFILLED", shortError(error2));
		check(`§9 ${k}: ...and it was that copy, not the repo's, on the page`, rec2.html[0] === asRendered(k, brokenText));
	}
}

// --- §10 mutants -----------------------------------------------------------------------
const MUTANTS = [
	{ name: "the absolute-path check dropped", edits: [["if (typeof folder !== \"string\" || !path.isAbsolute(folder)) return", "if (typeof folder !== \"string\") return"]] },
	{ name: "the plain-name check dropped", edits: [["if (!isPlainFileName(fileName)) return { reason: \"the file name has a folder part\" };", ""]] },
	{ name: "the folder check dropped", edits: [["if (!fs.statSync(realFolder).isDirectory()) return { reason: \"the setting does not name a folder\" };", ""]] },
	{ name: "the folder access check dropped", edits: [["fs.accessSync(realFolder, fs.constants.X_OK);", ""]], needsNonRoot: true },
	{ name: "the inside-the-folder check after links dropped", edits: [["if (!isInside(realFolder, realFile)) return { reason: \"the file resolves outside the folder\" };", ""]] },
	{ name: "isInside() always true", edits: [["return rel !== \"\" && rel !== \"..\" && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);", "return true;"]] },
	{ name: "the regular-file check dropped", edits: [["if (!fs.statSync(realFile).isFile()) return { reason: \"the file is not a regular file\" };", ""]] },
	{ name: "a refusal falls back to the repo", edits: [["if (found.reason) return refuse(doc.env, doc.file, found.reason);", "if (found.reason) return null;"]] },
	{ name: "a refusal names the folder", edits: [["if (found.reason) return refuse(doc.env, doc.file, found.reason);", "if (found.reason) return refuse(doc.env, folder, found.reason);"]] },
	{ name: "a blank setting counts as set", edits: [["return value === \"\" ? null : value;", "return raw == null ? null : value;"]] },
	{ name: "documents outside the table read a folder too", edits: [["if (!Object.prototype.hasOwnProperty.call(FOLDER_DOCUMENTS, docKey)) return null;", ""]] },
	{ name: "the route acts while unset", edits: [["if (folder === null) return next();", ""]] },
	{ name: "the route takes any method", edits: [["(req.method !== \"GET\" && req.method !== \"HEAD\") || ", ""]] },
	{ name: "the route answers every path", edits: [["|| !isSubstancePolicyPdfPath(req.path)) return next();", ") return next();"]] },
	{ name: "the route serves the file the request names", edits: [
		["|| !isSubstancePolicyPdfPath(req.path)) return next();", "|| !/^\\/policies\\//i.test(req.path)) return next();"],
		["const found = locateFolderFile(folder, SUBSTANCE_POLICY_PDF);", "const found = locateFolderFile(folder, path.basename(req.path));"],
	] },
	{ name: "the route passes a refusal on to the build's copy", edits: [["if (found.reason) return substancePdfUnavailable(res, setting, found.reason);", "if (found.reason) return next();"]] },
	{ name: "the route passes a failed send on to the build's copy", edits: [["substancePdfUnavailable(res, setting, err.code === \"ENOENT\" ? \"the file is missing\" : \"the file can't be read\");", "next();"]], needsNonRoot: true },
	{ name: "the 503 may be cached", edits: [["res.status(503).set(\"Cache-Control\", \"no-store\")", "res.status(503)"]] },
	{ name: "the link match without decoding", edits: [["decoded = decodeURIComponent(String(requestPath));", "decoded = String(requestPath);"]] },
	{ name: "the link match without normalizing", edits: [["path.posix.normalize(`./${decoded}`).toLowerCase()", "decoded.replace(/^\\//, \"\").toLowerCase()"]] },
	{ name: "the link match in one letter case", edits: [[".toLowerCase() === SUBSTANCE_POLICY_PDF_LINK", " === \"policies/LogisX-Substance-Policy.pdf\""]] },
	{ name: "the start log while nothing is set", edits: [["if (!report.some((r) => r.set)) return report;", ""]] },
	{ name: "the renderer ignores the folder", renderer: true, edits: [["let html = readFolderTemplate(docKey);", "let html = null;"]] },
];

async function runGroups(ctx) {
	g1Settings(ctx);
	g2Unset(ctx);
	g3Set(ctx);
	g4Refusals(ctx);
	g5Escape(ctx);
	await g6Route(ctx);
	g7StartLog(ctx);
	await g9Renders(ctx);
}

async function g10Mutants() {
	if (!FOLDERS_SRC) { ok("§10 mutants: lib/policy-template-folders.js exists", false); return; }
	for (const m of MUTANTS) {
		let src = m.renderer ? RENDERER_SRC : FOLDERS_SRC;
		const counts = m.edits.map(([find]) => src.split(find).length - 1);
		if (counts.some((n) => n !== 1)) { ok(`§10 ${m.name}: each edit applies once`, false, counts); continue; }
		for (const [find, replace] of m.edits) src = src.replace(find, () => replace);
		if (m.needsNonRoot && AS_ROOT) { skip(`§10 ${m.name}`); continue; }
		const flipped = [];
		let ctx;
		try {
			ctx = contextFor(m.renderer ? { Fsrc: FOLDERS_SRC, Rsrc: src } : { Fsrc: src, Rsrc: RENDERER_SRC }, (name, cond) => { if (!cond) flipped.push(name); }, () => {});
		} catch (e) {
			ok(`§10 ${m.name}: the mutant compiles`, false, e.message);
			continue;
		}
		await runGroups(ctx);
		takeLogs();
		ok(`§10 ${m.name}: caught (${flipped.length} case${flipped.length === 1 ? "" : "s"} flip${flipped.length === 1 ? "s" : ""}${flipped.length ? `, first: ${flipped[0]}` : ""})`, flipped.length > 0);
	}
}

// --- run ---------------------------------------------------------------------------------
(async () => {
	collectLogs();
	try {
		const real = contextFor({ Fsrc: FOLDERS_SRC, Rsrc: RENDERER_SRC }, ok, skip);
		section("1. the settings"); g1Settings(real);
		section("2. unset: the repo, as before"); g2Unset(real);
		section("3. set: each document's own folder"); g3Set(real);
		section("4. refusals"); g4Refusals(real);
		section("5. escape"); g5Escape(real);
		section("6. the apply page's substance policy PDF"); await g6Route(real);
		section("7. the start log"); g7StartLog(real);
		section("8. server.js"); g8Server();
		section("9. renders with a stand-in page"); await g9Renders(real);
		section("10. mutants"); await g10Mutants();
	} finally {
		restoreLogs();
	}
	out(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
	process.exit(failed ? 1 : 0);
})().catch((e) => {
	restoreLogs();
	out(`FAIL  the runner stopped: ${e && e.stack ? e.stack : e}`);
	process.exit(1);
});
