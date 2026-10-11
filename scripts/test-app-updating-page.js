#!/usr/bin/env node
/**
 * scripts/test-app-updating-page.js — what a page request gets with and
 * without the app's build.
 *
 * server.js serves the Vue SPA from client/dist. The legacy pages in public/
 * that used to stand in when client/dist was missing are gone, so with no
 * client/dist/index.html every page request gets a plain 503 "being updated"
 * page (lib/app-updating-page.js) instead. With the build in place nothing
 * changes.
 *
 *   §1 the page: self-contained (no script, stylesheet, image or link to load),
 *      says the app is being updated and to try again in a minute, and never
 *      carries id="app", the SPA's mount point in client/index.html that every
 *      deploy check reads to tell the app from this page
 *      (scripts/deploy/remote-smoke.sh, remote-rollback.sh, staging-smoke.sh).
 *   §2 with the build: the static block and the SPA catch-all, lifted from
 *      server.js, answer exactly as a plain express.static + sendFile of
 *      index.html does (status, headers that describe the body, body), for
 *      "/", an SPA route, a bundle file and HEAD; an API route is untouched.
 *      The replica banner line is pinned exactly, and with a build a replica's
 *      page carries the banner (CI boots server.js before it builds the
 *      client, so test-replica-mode.js §7 sees only the 503 page there).
 *   §3 without it: every page request, HEAD included, is the 503 page with
 *      Cache-Control: no-store and Retry-After; so is a client/dist that holds
 *      no index.html (a build in progress), and a build removed while the
 *      server runs. An API route is untouched, and a replica's banner
 *      middleware passes the request on to the same page.
 *   §4 the legacy pages are gone: no public/ file, and server.js names no
 *      public/ folder.
 *   §5 discrimination: a catch-all that sends index.html without looking, and
 *      a page sent with 200, each turn a §3 assertion red.
 *
 * Pure: no server.js boot, no app.db, no network beyond 127.0.0.1 port 0.
 * SERVER_JS=<path> checks another copy of server.js (e.g. main's, to watch
 * this fail there).
 *
 * Run: node scripts/test-app-updating-page.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const SERVER = process.env.SERVER_JS || path.join(ROOT, "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");
const express = require(path.join(ROOT, "node_modules", "express"));
const { APP_UPDATING_HTML, APP_UPDATING_RETRY_AFTER_S, sendAppUpdating } = require(path.join(ROOT, "lib", "app-updating-page"));
const replicaMode = require(path.join(ROOT, "lib", "replica-mode"));

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}${detail === undefined ? "" : `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`); }
}
function fatal(msg) { console.error(`FAIL  ${msg}`); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "app-updating-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
let tmpN = 0;
const tmpDir = () => { const d = path.join(TMP, `app-${++tmpN}`); fs.mkdirSync(d); return d; };

// --- lifting ---------------------------------------------------------------
// The static block: from `const clientDistPath =` to the first blank line.
function staticBlock(src) {
	const a = src.indexOf("\nconst clientDistPath = ");
	if (a < 0) fatal("could not locate `const clientDistPath =` in server.js");
	const b = src.indexOf("\n\n", a + 1);
	if (b < 0) fatal("could not locate the end of the static block in server.js");
	return src.slice(a + 1, b + 1);
}
// The SPA catch-all, anchored at a line start: comments quote routes.
function catchAll(src) {
	const nl = src.indexOf('\napp.get("*"');
	if (nl < 0) fatal('could not locate the SPA catch-all (app.get("*") in server.js');
	let depth = 0;
	for (let j = src.indexOf("(", nl + 1); j < src.length; j++) {
		if (src[j] === "(") depth++;
		else if (src[j] === ")") { depth--; if (depth === 0) return src.slice(nl + 1, j + 2); }
	}
	return fatal("unbalanced parens extracting the SPA catch-all");
}
// Replace exactly one occurrence, or fail loudly: a mutant whose target is gone
// would run the original code and "pass", proving nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) fatal(`mutant target found ${n}x (expected 1): ${from.slice(0, 70)}`);
	return src.replace(from, to);
}

const STATIC_SRC = staticBlock(SRC);
const CATCH_ALL_SRC = catchAll(SRC);

// An app as server.js builds it for pages: an API route registered before the
// static block (every route is), then the static block, then the catch-all.
// `appDir` stands in for __dirname.
// Express's "test" env only keeps its default error handler from logging the
// ENOENT a mutant's sendFile ends in; nothing else here depends on it.
function buildApp(appDir, { replica = null, catchAllSrc = CATCH_ALL_SRC, send = sendAppUpdating } = {}) {
	const app = express();
	app.set("env", "test");
	app.get("/api/thing", (req, res) => res.json({ ok: true }));
	const REPLICA = replica ? { bannerMiddleware: replicaMode.bannerMiddleware } : null;
	new Function("app", "express", "fs", "path", "__dirname", "REPLICA", "sendAppUpdating", `${STATIC_SRC}\n${catchAllSrc}`)(
		app, express, fs, path, appDir, REPLICA, send);
	return app;
}
// lib/app-updating-page.js evaluated from (possibly mutated) source text.
const LIB_SRC = fs.readFileSync(path.join(ROOT, "lib", "app-updating-page.js"), "utf8");
function libFrom(src) {
	const module = { exports: {} };
	new Function("module", "exports", "require", src)(module, module.exports, require);
	return module.exports;
}
// The plain reference: the build served the way Express serves a folder and a file.
function referenceApp(appDir) {
	const dist = path.join(appDir, "client", "dist");
	const app = express();
	app.set("env", "test");
	app.get("/api/thing", (req, res) => res.json({ ok: true }));
	app.use(express.static(dist));
	app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
	return app;
}

async function listen(app) {
	const srv = http.createServer(app);
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	return srv;
}
function ask(srv, p, method = "GET") {
	return new Promise((resolve) => {
		const req = http.request({ host: "127.0.0.1", port: srv.address().port, path: p, method }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.on("error", (e) => resolve({ status: 0, headers: {}, body: e.message }));
		req.end();
	});
}
// The headers that describe the body, which must match between two servers
// answering from the same file. Date and Connection describe the exchange.
const DESCRIBE = ["content-type", "content-length", "cache-control", "etag", "last-modified", "accept-ranges", "retry-after"];
const described = (r) => ({ status: r.status, body: r.body, ...Object.fromEntries(DESCRIBE.map((h) => [h, r.headers[h]])) });

const INDEX = '<!doctype html><html><head><script type="module" src="/assets/index-a1.js"></script></head><body><div id="app"></div></body></html>\n';
function withBuild(dir, { index = true } = {}) {
	const dist = path.join(dir, "client", "dist");
	fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
	if (index) fs.writeFileSync(path.join(dist, "index.html"), INDEX);
	fs.writeFileSync(path.join(dist, "assets", "index-a1.js"), "export {};\n");
	return dir;
}

const isUpdatingPage = (r) => r.status === 503
	&& r.headers["cache-control"] === "no-store"
	&& r.headers["retry-after"] === String(APP_UPDATING_RETRY_AFTER_S)
	&& /^text\/html/.test(r.headers["content-type"] || "")
	&& r.body === APP_UPDATING_HTML;

// §3's page answers, for one way of building the app; reused by §5's mutants.
async function noBuildAnswers(opts = {}) {
	const srv = await listen(buildApp(tmpDir(), opts));
	try {
		const pages = await Promise.all(["/", "/login", "/dashboard/loads/7", "/index.html"].map((p) => ask(srv, p)));
		return { pages, head: await ask(srv, "/", "HEAD"), api: await ask(srv, "/api/thing") };
	} finally {
		srv.close();
	}
}

(async () => {
	// =========================================================================
	console.log("§1 the page");
	// =========================================================================
	const page = APP_UPDATING_HTML;
	ok("it is an HTML document", /^<!doctype html>/i.test(page) && /<\/html>\s*$/i.test(page));
	ok("it says the app is being updated", /being updated/i.test(page));
	ok("…and to try again in a minute", /try again in a minute/i.test(page));
	ok("it loads nothing: no script, stylesheet link, image, frame or URL", !/<script|<link|<img|<iframe|\bsrc=|\bhref=|url\(|@import|https?:\/\//i.test(page));
	ok('it never carries id="app" (how every deploy check tells the app from it)', !/id\s*=\s*["']?app\b/i.test(page));
	const clientIndex = fs.readFileSync(path.join(ROOT, "client", "index.html"), "utf8");
	ok('client/index.html carries the SPA mount point id="app" exactly once', (clientIndex.match(/id="app"/g) || []).length === 1);
	for (const f of ["remote-smoke.sh", "remote-rollback.sh", "staging-smoke.sh"]) {
		const t = fs.readFileSync(path.join(ROOT, "scripts", "deploy", f), "utf8");
		ok(`scripts/deploy/${f} tells the app's page by that same mount point`, t.includes("grep -q 'id=\"app\"'"));
	}
	ok("Retry-After is a minute, as the page says", APP_UPDATING_RETRY_AFTER_S === 60);
	ok("it reloads itself after that minute (a meta refresh to itself, no script)",
		(page.match(/<meta http-equiv="refresh"[^>]*>/gi) || []).join() === `<meta http-equiv="refresh" content="${APP_UPDATING_RETRY_AFTER_S}">`);

	// =========================================================================
	console.log("\n§2 with the build: exactly as Express serves it");
	// =========================================================================
	{
		const dir = withBuild(tmpDir());
		const [srv, ref] = await Promise.all([listen(buildApp(dir)), listen(referenceApp(dir))]);
		try {
			for (const [p, method] of [["/", "GET"], ["/login", "GET"], ["/dashboard/loads/7", "GET"], ["/index.html", "GET"], ["/assets/index-a1.js", "GET"], ["/login", "HEAD"], ["/", "HEAD"]]) {
				const [a, b] = await Promise.all([ask(srv, p, method), ask(ref, p, method)]);
				ok(`${method} ${p}: the same answer as express.static + sendFile(index.html)`, JSON.stringify(described(a)) === JSON.stringify(described(b)), { got: described(a), want: described(b) });
			}
			const page1 = await ask(srv, "/login");
			ok("an SPA route is the build's index.html, 200", page1.status === 200 && page1.body === INDEX, page1.status);
			const js = await ask(srv, "/assets/index-a1.js");
			ok("a bundle file is itself", js.status === 200 && /javascript/.test(js.headers["content-type"] || "") && js.body === "export {};\n", js.headers["content-type"]);
			const api = await ask(srv, "/api/thing");
			ok("an API route is untouched", api.status === 200 && api.body === JSON.stringify({ ok: true }));
		} finally {
			srv.close();
			ref.close();
		}
	}
	{
		// A replica with the build: the banner half, which CI's boot of server.js
		// (test-replica-mode.js §7, run before CI builds the client) never reaches.
		const BANNER_LINE = "if (REPLICA) app.use(REPLICA.bannerMiddleware(clientDistPath));";
		ok("server.js mounts the replica banner on client/dist, exactly", SRC.split("\n").filter((l) => l === BANNER_LINE).length === 1);
		const srv = await listen(buildApp(withBuild(tmpDir()), { replica: true }));
		try {
			const page1 = await ask(srv, "/login");
			ok("in a replica with the build, a page is the build's index.html with the banner in it, once",
				page1.status === 200 && page1.body === replicaMode.withBanner(INDEX) && (page1.body.match(/logisx-replica-banner/g) || []).length === 1, page1.status);
			const js = await ask(srv, "/assets/index-a1.js");
			ok("…and a bundle file is untouched", js.status === 200 && js.body === "export {};\n", js.status);
		} finally {
			srv.close();
		}
	}

	// =========================================================================
	console.log("\n§3 without it: the 503 page");
	// =========================================================================
	{
		const r = await noBuildAnswers();
		for (const [i, p] of ["/", "/login", "/dashboard/loads/7", "/index.html"].entries()) {
			ok(`GET ${p}: 503, no-store, Retry-After ${APP_UPDATING_RETRY_AFTER_S}, the page`, isUpdatingPage(r.pages[i]), { status: r.pages[i].status, headers: r.pages[i].headers, body: r.pages[i].body.slice(0, 80) });
		}
		ok("HEAD /: 503 and the same headers, no body", r.head.status === 503 && r.head.headers["cache-control"] === "no-store" && r.head.headers["retry-after"] === String(APP_UPDATING_RETRY_AFTER_S) && r.head.body === "", r.head.status);
		ok("an API route is untouched", r.api.status === 200 && r.api.body === JSON.stringify({ ok: true }), r.api.status);
	}
	{
		// A client/dist with no index.html yet (a build in progress at startup).
		const srv = await listen(buildApp(withBuild(tmpDir(), { index: false })));
		try {
			const r = await ask(srv, "/login");
			ok("a client/dist that holds no index.html: the 503 page", isUpdatingPage(r), r.status);
			const js = await ask(srv, "/assets/index-a1.js");
			ok("…while a bundle file that is there is still served", js.status === 200 && js.body === "export {};\n", js.status);
		} finally {
			srv.close();
		}
	}
	{
		// Built at startup, then index.html removed while the server runs (a
		// rebuild empties client/dist first).
		const dir = withBuild(tmpDir());
		const srv = await listen(buildApp(dir));
		try {
			const before = await ask(srv, "/login");
			fs.rmSync(path.join(dir, "client", "dist", "index.html"));
			const after = await ask(srv, "/login");
			ok("a build removed while the server runs: the 503 page, from the next request", before.status === 200 && isUpdatingPage(after), { before: before.status, after: after.status });
		} finally {
			srv.close();
		}
	}
	{
		const srv = await listen(buildApp(tmpDir(), { replica: true }));
		try {
			const r = await ask(srv, "/login");
			ok("in a replica with no build, the banner middleware passes the request on to the same page", isUpdatingPage(r), r.status);
		} finally {
			srv.close();
		}
	}

	// =========================================================================
	console.log("\n§4 the legacy pages are gone");
	// =========================================================================
	const LEGACY = ["index.html", "login.html", "dashboard.html", "driver.html", "investor.html", "users.html", path.join("js", "layout.js"), path.join("css", "shared.css")];
	const left = LEGACY.filter((f) => fs.existsSync(path.join(ROOT, "public", f)));
	ok("no legacy public/ page, script or stylesheet is left", left.length === 0, left.join(", "));
	ok("server.js names no public/ folder", !/path\.join\(__dirname, "public"\)|\bpublicPath\b/.test(SRC));

	// =========================================================================
	console.log("\n§5 discrimination: each mutant turns a §3 assertion red");
	// =========================================================================
	{
		const blind = await noBuildAnswers({ catchAllSrc: mutate(CATCH_ALL_SRC, "if (fs.existsSync(spaIndex)) {", "if (true) {") });
		ok("MUTANT (the catch-all sends index.html without looking): GET / is no longer the 503 page", !isUpdatingPage(blind.pages[0]), blind.pages[0].status);
		const as200 = await noBuildAnswers({ send: libFrom(mutate(LIB_SRC, "res.status(503)", "res.status(200)")).sendAppUpdating });
		ok("MUTANT (the page sent with 200): GET / is no longer the 503 page", !isUpdatingPage(as200.pages[0]), as200.pages[0].status);
		const cached = await noBuildAnswers({ send: libFrom(mutate(LIB_SRC, '"Cache-Control": "no-store", ', "")).sendAppUpdating });
		ok("MUTANT (no Cache-Control: no-store): GET / is no longer the 503 page", !isUpdatingPage(cached.pages[0]), cached.pages[0].headers["cache-control"]);
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error(err && err.stack ? err.stack : err);
	process.exit(1);
});
