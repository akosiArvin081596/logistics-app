#!/usr/bin/env node
/**
 * The site's Content-Security-Policy may gain exactly one thing for the driver
 * training videos: the YouTube no-cookie origin in the list that governs frames.
 * nginx sets the header, not the app; this is the check on that edit.
 *
 * The rule, on a header before and after the edit:
 *   - the frame list is frame-src, else child-src, else default-src (directive
 *     names in any case; a repeated directive is ignored, the first one counts);
 *   - where that list restricts frames, frame-src (added if it was missing,
 *     copying the list it replaces) gains exactly the origin client/src/lib/
 *     driverVideos.js frames (YOUTUBE_FRAME_ORIGIN), written exactly so: no
 *     wildcard, scheme, other host, http, port or path, and nothing else;
 *   - every other directive is unchanged, none added or removed, and the
 *     header holds as many policies as before;
 *   - frames not restricted at all (or no header): nothing changes.
 *
 * Default run, offline: §0 the origin comes from the client lib; §1 the parser;
 * §2 the frame list; §3 accepted edits; §4 refused edits; §5 the arguments;
 * §6 the live check against a server in this process on 127.0.0.1 only.
 *
 * After the nginx edit (plan §5.3), the lead checks a live host with one
 * signed-out GET (no cookie, 10 s timeout, body discarded):
 *   node scripts/test-csp-frame-src.js --live https://staging-app.logisx.com/ --before <file>
 * <file> holds the header value saved before the edit (optionally prefixed
 * "Content-Security-Policy:"), or nothing when there was no header.
 * Exit: 0 PASS, 1 FAIL, 2 a usage, file or network problem.
 *
 * Made-up policies only. Run: node scripts/test-csp-frame-src.js
 */
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "client", "src", "lib", "driverVideos.js");
const MAX_POLICY_CHARS = 16384;
const DIRECTIVE_NAME_RE = /^[a-z0-9-]{1,64}$/;
const FRAME_LIST_ORDER = ["frame-src", "child-src", "default-src"];

// A header value as policies, each a Map of directive name to its source list.
// Commas separate policies, semicolons directives, whitespace sources.
function parsePolicyList(text) {
	if (typeof text !== "string") throw new Error("a policy must be text");
	if (text.length > MAX_POLICY_CHARS) throw new Error(`a policy over ${MAX_POLICY_CHARS} characters is refused`);
	const policies = [];
	for (const raw of text.split(",")) {
		const policy = new Map();
		for (const part of raw.split(";")) {
			const tokens = part.split(/[ \t\n\r\f]/).filter(Boolean);
			if (!tokens.length) continue;
			const name = tokens[0].toLowerCase();
			if (!DIRECTIVE_NAME_RE.test(name) || policy.has(name)) continue;
			policy.set(name, tokens.slice(1));
		}
		if (policy.size) policies.push(policy);
	}
	return policies;
}

// The directive that governs frames in one policy, or null when none does.
function frameList(policy) {
	for (const name of FRAME_LIST_ORDER) if (policy.has(name)) return { directive: name, sources: policy.get(name) };
	return null;
}

const lower = (list) => list.map((s) => s.toLowerCase());
const sameSources = (a, b) => JSON.stringify(lower(a).sort()) === JSON.stringify(lower(b).sort());
const onlyNone = (list) => list.length === 1 && list[0].toLowerCase() === "'none'";

// The verdict on an edit: { ok, added, reasons, note }.
function checkFrameSrcChange(beforeText, afterText, origin) {
	const reasons = [];
	const added = [];
	let before;
	let after;
	try {
		before = parsePolicyList(beforeText);
		after = parsePolicyList(afterText);
	} catch (err) {
		return { ok: false, added, reasons: [err.message], note: "" };
	}
	if (before.length !== after.length) {
		return { ok: false, added, reasons: [`the header holds ${after.length} policies after and ${before.length} before`], note: "" };
	}
	let restricted = 0;
	let allowedBefore = 0;
	before.forEach((b, p) => {
		const a = after[p];
		const tag = before.length > 1 ? `policy ${p + 1}: ` : "";
		for (const name of new Set([...b.keys(), ...a.keys()])) {
			if (name === "frame-src") continue;
			if (!b.has(name)) reasons.push(`${tag}${name} was added`);
			else if (!a.has(name)) reasons.push(`${tag}${name} was removed`);
			else if (!sameSources(b.get(name), a.get(name))) reasons.push(`${tag}${name} changed`);
		}
		const governs = frameList(b);
		if (!governs) {
			if (a.has("frame-src")) reasons.push(`${tag}frame-src was added where frames were not restricted`);
			return;
		}
		restricted++;
		const was = governs.sources;
		if (lower(was).includes(origin.toLowerCase())) {
			allowedBefore++;
			const now = a.get("frame-src");
			if (b.has("frame-src") ? !now || !sameSources(was, now) : a.has("frame-src")) reasons.push(`${tag}frame-src changed though the origin was already allowed`);
			return;
		}
		if (!a.has("frame-src")) {
			reasons.push(`${tag}no frame-src: the frame is still refused by ${governs.directive}`);
			return;
		}
		const now = a.get("frame-src");
		// 'none' stands alone: it gives way to the origin rather than sitting beside it.
		const kept = onlyNone(was) ? [] : was;
		const keptLower = new Set(lower(kept));
		const nowLower = new Set(lower(now));
		const dropped = kept.filter((s) => !nowLower.has(s.toLowerCase()));
		if (dropped.length) reasons.push(`${tag}frame-src dropped ${dropped.join(" ")}`);
		const gained = now.filter((s) => !keptLower.has(s.toLowerCase()));
		if (JSON.stringify(gained) !== JSON.stringify([origin])) reasons.push(`${tag}frame-src gained ${JSON.stringify(gained)}; only ${origin} may be added, once`);
		added.push(...gained);
	});
	let note = "";
	if (!before.length) note = "no Content-Security-Policy: frames are not restricted, nothing to change";
	else if (!restricted) note = "no directive restricts frames: nothing to change";
	else if (allowedBefore === restricted) note = "the origin was already allowed: nothing to change";
	return { ok: reasons.length === 0, added: [...new Set(added)], reasons, note };
}

// The saved "before" header: one line, optionally "Content-Security-Policy: <value>".
function beforeValue(text) {
	const s = String(text).trim();
	if (s.includes("\n") || s.includes("\r")) throw new Error("the before file must hold one header line");
	const prefix = "content-security-policy:";
	return (s.toLowerCase().startsWith(prefix) ? s.slice(prefix.length) : s).trim();
}

// --live <url> --before <file>, or nothing (the offline run). Throws on anything else.
function parseArgs(argv) {
	if (!argv.length) return { live: null, before: null };
	const out = { live: null, before: null };
	for (let i = 0; i < argv.length; i += 2) {
		const [flag, value] = [argv[i], argv[i + 1]];
		if ((flag !== "--live" && flag !== "--before") || value === undefined || value.startsWith("--")) {
			throw new Error("usage: test-csp-frame-src.js [--live <https url> --before <file>]");
		}
		if (out[flag.slice(2)] !== null) throw new Error(`${flag} given twice`);
		out[flag.slice(2)] = value;
	}
	if (!out.live || !out.before) throw new Error("--live and --before go together");
	let url;
	try { url = new URL(out.live); } catch { throw new Error(`--live: not a URL: ${out.live}`); }
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("--live takes an https URL (http only for 127.0.0.1 or localhost)");
	if (url.username || url.password) throw new Error("--live: no credentials in the URL");
	return { live: url.href, before: out.before };
}

async function liveCheck({ live, before }, origin) {
	let beforeText;
	try {
		const st = fs.statSync(before);
		if (!st.isFile() || st.size > MAX_POLICY_CHARS) throw new Error("not a file of at most 16 KB");
		beforeText = beforeValue(fs.readFileSync(before, "utf8"));
	} catch (err) {
		console.error(`test-csp-frame-src: --before ${before}: ${err.message}`);
		return 2;
	}
	let status;
	let header;
	try {
		const res = await fetch(live, { method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10000) });
		status = res.status;
		header = res.headers.get("content-security-policy") || "";
		try { await res.body?.cancel(); } catch { /* the body is not needed */ }
	} catch (err) {
		console.error(`test-csp-frame-src: GET ${live} failed: ${err.message}`);
		return 2;
	}
	const v = checkFrameSrcChange(beforeText, header, origin);
	const frames = parsePolicyList(header).map((p) => frameList(p)).map((f) => (f ? `${f.directive} ${f.sources.join(" ")}` : "(frames not restricted)"));
	console.log(`GET ${live}: ${status}`);
	console.log(`frame list now: ${frames.length ? frames.join(" | ") : "(no Content-Security-Policy)"}`);
	console.log(`added: ${v.added.length ? v.added.join(" ") : "nothing"}`);
	if (v.note) console.log(`note: ${v.note}`);
	for (const r of v.reasons) console.log(`  - ${r}`);
	console.log(`verdict: ${v.ok ? "PASS" : "FAIL"}`);
	return v.ok ? 0 : 1;
}

// ── the offline run ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`  ok    ${name}`); return; }
	failed++;
	console.log(`  FAIL  ${name}${detail !== undefined ? `\n          ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const asObject = (policies) => policies.map((p) => Object.fromEntries(p));

async function offline() {
	console.log("§0 the origin, from the client lib");
	let origin = null;
	try {
		origin = (await import(pathToFileURL(LIB).href)).YOUTUBE_FRAME_ORIGIN;
	} catch (err) {
		ok("§0 client/src/lib/driverVideos.js loads", false, err.message);
	}
	eq("§0 YOUTUBE_FRAME_ORIGIN is the no-cookie host's https origin", origin, "https://www.youtube-nocookie.com");
	if (typeof origin !== "string") return;
	eq("§0 ...an origin and nothing more (no path, port or trailing slash)", new URL(origin).origin, origin);

	console.log("\n§1 the parser");
	eq("§1 directives by name in any case; sources split on whitespace; empty parts skipped",
		asObject(parsePolicyList("Default-Src 'self';  IMG-SRC 'self'   data:\thttps://img.example.test ;;frame-ancestors 'none';")),
		[{ "default-src": ["'self'"], "img-src": ["'self'", "data:", "https://img.example.test"], "frame-ancestors": ["'none'"] }]);
	eq("§1 a repeated directive is ignored: the first one counts", asObject(parsePolicyList("frame-src 'self'; FRAME-SRC *; frame-src https:")), [{ "frame-src": ["'self'"] }]);
	eq("§1 commas separate policies", asObject(parsePolicyList("default-src 'self', frame-src 'none'")), [{ "default-src": ["'self'"] }, { "frame-src": ["'none'"] }]);
	eq("§1 a name with other characters is skipped; an empty header is no policy",
		[asObject(parsePolicyList("fr@me-src *; img-src 'self'")), parsePolicyList(""), parsePolicyList(" ; , ;")], [[{ "img-src": ["'self'"] }], [], []]);
	let threw = null;
	try { parsePolicyList("a".repeat(MAX_POLICY_CHARS + 1)); } catch (err) { threw = err.message; }
	ok("§1 a header over 16 KB is refused, not parsed", typeof threw === "string" && /refused/.test(threw), threw);

	console.log("\n§2 the list that governs frames");
	const fl = (t) => frameList(parsePolicyList(t)[0]);
	eq("§2 frame-src first, then child-src, then default-src, else none", [
		fl("default-src 'self'; child-src blob:; frame-src 'self' blob:"), fl("default-src 'self'; child-src 'self' blob:"), fl("default-src 'self'; img-src *"), fl("img-src *; script-src 'self'"),
	], [{ directive: "frame-src", sources: ["'self'", "blob:"] }, { directive: "child-src", sources: ["'self'", "blob:"] }, { directive: "default-src", sources: ["'self'"] }, null]);

	console.log("\n§3 accepted edits");
	const BASE = "default-src 'self'; script-src 'self' 'unsafe-inline' https://maps.example.test; img-src 'self' data: blob: https:; connect-src 'self' wss:; object-src 'none'; frame-ancestors 'self'";
	const accept = (label, before, after) => {
		const v = checkFrameSrcChange(before, after, origin);
		ok(`§3 ${label}`, v.ok && JSON.stringify(v.added) === JSON.stringify([origin]), v);
	};
	accept("frame-src present: the origin appended", `${BASE}; frame-src 'self' blob:`, `${BASE}; frame-src 'self' blob: ${origin}`);
	accept("no frame-src but child-src: frame-src added as child-src's list plus the origin; child-src kept",
		`${BASE}; child-src 'self' blob:`, `${BASE}; child-src 'self' blob:; frame-src 'self' blob: ${origin}`);
	accept("neither, default-src restricts: frame-src added as default-src's list plus the origin", BASE, `${BASE}; frame-src 'self' ${origin}`);
	accept("names in another case, sources reordered, spacing and a trailing semicolon changed",
		`DEFAULT-SRC 'self'; IMG-SRC 'self' data:; FRAME-SRC 'self' blob:`, `default-src  'self' ;img-src data: 'self';frame-src blob: ${origin} 'self';`);
	accept("frame-src 'none': the origin replaces it", `${BASE}; frame-src 'none'`, `${BASE}; frame-src ${origin}`);
	accept("two policies, each restricting frames: each gains the origin",
		`default-src 'self', frame-src 'self'`, `default-src 'self'; frame-src 'self' ${origin}, frame-src 'self' ${origin}`);
	const none = checkFrameSrcChange("", "", origin);
	eq("§3 no header before or after: passes, nothing added, and says frames are not restricted", [none.ok, none.added, /not restricted/.test(none.note)], [true, [], true]);
	const open = checkFrameSrcChange("img-src 'self'", "img-src 'self'", origin);
	eq("§3 a policy that restricts no frames, unchanged: passes, nothing to change", [open.ok, open.added, /nothing to change/.test(open.note)], [true, [], true]);
	const already = checkFrameSrcChange(`${BASE}; frame-src 'self' ${origin}`, `${BASE}; frame-src 'self' ${origin}`, origin);
	eq("§3 the origin already allowed and nothing changed: passes", [already.ok, already.added, /already allowed/.test(already.note)], [true, [], true]);

	console.log("\n§4 refused edits");
	const refuse = (label, before, after, why) => {
		const v = checkFrameSrcChange(before, after, origin);
		ok(`§4 ${label}`, !v.ok && v.reasons.some((r) => why.test(r)), v);
	};
	const FR = `${BASE}; frame-src 'self' blob:`;
	for (const [label, source] of [
		["a wildcard", "*"], ["any https", "https:"], ["a subdomain wildcard", "https://*.youtube-nocookie.com"], ["www.youtube.com", "https://www.youtube.com"],
		["*.youtube.com", "https://*.youtube.com"], ["the bare domain", "https://youtube-nocookie.com"], ["http", "http://www.youtube-nocookie.com"],
		["no scheme", "www.youtube-nocookie.com"], ["a path", `${origin}/embed/`], ["a trailing slash", `${origin}/`], ["a port", `${origin}:443`],
		["capitals", "https://WWW.youtube-nocookie.com"], ["data:", "data:"],
	]) {
		refuse(`frame-src gains ${label} (${source})`, FR, `${FR} ${source}`, /only https:\/\/www\.youtube-nocookie\.com may be added/);
	}
	refuse("the origin and something else", FR, `${FR} ${origin} https://www.youtube.com`, /only .* may be added/);
	refuse("the origin twice", FR, `${FR} ${origin} ${origin}`, /only .* may be added, once/);
	refuse("frame-src drops a source", FR, `${BASE}; frame-src 'self' ${origin}`, /dropped blob:/);
	refuse("'none' kept beside the origin", `${BASE}; frame-src 'none'`, `${BASE}; frame-src 'none' ${origin}`, /gained/);
	refuse("the origin added to script-src too", FR, `${BASE.replace("script-src 'self'", `script-src 'self' ${origin}`)}; frame-src 'self' blob: ${origin}`, /script-src changed/);
	refuse("img-src widened", FR, `${BASE.replace("img-src 'self'", "img-src *")}; frame-src 'self' blob: ${origin}`, /img-src changed/);
	refuse("a directive removed", FR, `${BASE.replace("; object-src 'none'", "")}; frame-src 'self' blob: ${origin}`, /object-src was removed/);
	refuse("a directive added (media-src)", FR, `${FR} ${origin}; media-src 'self'`, /media-src was added/);
	refuse("child-src changed while frame-src is added", `${BASE}; child-src 'self'`, `${BASE}; child-src 'self' ${origin}; frame-src 'self' ${origin}`, /child-src changed/);
	refuse("default-src widened instead of adding frame-src", BASE, `${BASE.replace("default-src 'self'", `default-src 'self' ${origin}`)}`, /default-src changed/);
	refuse("frames not restricted, frame-src added anyway", "img-src 'self'", `img-src 'self'; frame-src ${origin}`, /not restricted/);
	refuse("nothing changed: the frame is still refused", FR, FR, /gained \[\]/);
	refuse("frame-src restricted only by default-src and left unset", BASE, BASE, /still refused by default-src/);
	refuse("the header removed", FR, "", /policies after/);
	refuse("a second policy added", FR, `${FR} ${origin}, img-src 'self'`, /policies after/);
	refuse("two policies, only the first gains the origin", `default-src 'self', frame-src 'self'`, `default-src 'self'; frame-src 'self' ${origin}, frame-src 'self'`, /policy 2: frame-src gained \[\]/);
	refuse("the origin already allowed, frame-src changed anyway", `${BASE}; frame-src 'self' ${origin}`, `${BASE}; frame-src 'self' ${origin} blob:`, /already allowed/);
	refuse("a header over 16 KB", FR, `${FR} ${origin}; img-src ${"a".repeat(MAX_POLICY_CHARS)}`, /refused/);

	console.log("\n§5 the arguments");
	const args = (a) => { try { return parseArgs(a); } catch (err) { return `refused: ${err.message}`; } };
	eq("§5 no arguments: the offline run", args([]), { live: null, before: null });
	eq("§5 --live with --before, either order", [args(["--live", "https://staging.example.test/", "--before", "/tmp/x.txt"]), args(["--before", "/tmp/x.txt", "--live", "http://127.0.0.1:3191/"])],
		[{ live: "https://staging.example.test/", before: "/tmp/x.txt" }, { live: "http://127.0.0.1:3191/", before: "/tmp/x.txt" }]);
	for (const [label, a] of [
		["--live alone", ["--live", "https://staging.example.test/"]], ["--before alone", ["--before", "/tmp/x.txt"]], ["http to another host", ["--live", "http://staging.example.test/", "--before", "x"]],
		["credentials in the URL", ["--live", "https://u:p@staging.example.test/", "--before", "x"]], ["not a URL", ["--live", "staging", "--before", "x"]],
		["another flag", ["--live", "https://staging.example.test/", "--before", "x", "--cookie", "y"]], ["a flag with no value", ["--live", "--before", "x"]],
		["a flag twice", ["--live", "https://a.example.test/", "--live", "https://b.example.test/", "--before", "x"]], ["file: scheme", ["--live", "file:///etc/hosts", "--before", "x"]],
	]) {
		ok(`§5 refused: ${label}`, /^refused: /.test(String(args(a))), args(a));
	}
	eq("§5 the before file: the header value, with or without its name", [beforeValue("Content-Security-Policy: frame-src 'self'\n"), beforeValue("  frame-src 'self' "), beforeValue("")],
		["frame-src 'self'", "frame-src 'self'", ""]);
	let multi = null;
	try { beforeValue("frame-src 'self'\nimg-src *"); } catch (err) { multi = err.message; }
	ok("§5 a before file with two lines is refused", /one header line/.test(String(multi)), multi);

	console.log("\n§6 the live check, against a server in this process on 127.0.0.1");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csp-frame-src-"));
	const beforeFile = path.join(dir, "csp-before.txt");
	fs.writeFileSync(beforeFile, `Content-Security-Policy: ${FR}\n`);
	let answer = "";
	const seen = [];
	const server = http.createServer((req, res) => {
		seen.push({ method: req.method, cookie: req.headers.cookie || null, authorization: req.headers.authorization || null });
		res.writeHead(200, { "content-type": "text/html", "content-security-policy": answer });
		res.end("<!doctype html><title>made-up</title>");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${server.address().port}/`;
	try {
		answer = `${FR} ${origin}`;
		eq("§6 the edited header: PASS (exit 0)", await liveCheck({ live: url, before: beforeFile }, origin), 0);
		answer = `${FR} https:`;
		eq("§6 a header widened another way: FAIL (exit 1)", await liveCheck({ live: url, before: beforeFile }, origin), 1);
		eq("§6 one signed-out GET each: no cookie, no authorization", seen, [
			{ method: "GET", cookie: null, authorization: null }, { method: "GET", cookie: null, authorization: null }]);
		eq("§6 a before file that is missing: exit 2", await liveCheck({ live: url, before: path.join(dir, "missing.txt") }, origin), 2);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	eq("§6 nothing answering: exit 2", await liveCheck({ live: url, before: beforeFile }, origin), 2);
	fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`test-csp-frame-src: ${err.message}`);
		process.exit(2);
	}
	if (opts.live) {
		let origin;
		try {
			origin = (await import(pathToFileURL(LIB).href)).YOUTUBE_FRAME_ORIGIN;
		} catch (err) {
			console.error(`test-csp-frame-src: client/src/lib/driverVideos.js: ${err.message}`);
			process.exit(2);
		}
		process.exit(await liveCheck(opts, origin));
	}
	await offline();
	console.log(`\ntest-csp-frame-src: ${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
