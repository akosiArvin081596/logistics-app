#!/usr/bin/env node
/**
 * Which Google Maps key each response carries.
 *
 * The app holds two keys: GOOGLE_MAPS_API_KEY (the server key, used only for
 * the app's own calls to Google) and GOOGLE_MAPS_BROWSER_KEY (the browser key,
 * the one value GET /api/config/maps-key hands to visitors). This runner proves
 * the contract between them by executing the real code lifted from server.js:
 *
 *   browser key set   -> the public endpoint answers with the browser key, and
 *                        no browser-reachable path (endpoint, admin report,
 *                        Google proxy routes, their error paths) answers with
 *                        the server key;
 *   browser key unset -> today's behaviour: the endpoint answers with the
 *                        server key, and exactly one warning is logged at
 *                        startup, never one per request.
 *
 * "Set" means set to a non-blank value that does not contain the server key
 * once surrounding whitespace is ignored. A blank value, or one holding the
 * server key (a copy, padded or not, or two keys pasted together), counts as
 * unset: the warning is logged and the admin report says the keys are not
 * distinct.
 *
 * WHAT IS ASSERTED
 *   §1 key resolution and the startup warning, per configuration (executed)
 *   §2 GET /api/config/maps-key, per configuration (executed)
 *   §3 the warning is logged once per start, not per request (executed)
 *   §4 GET /api/admin/maps-key-usage carries no key (executed)
 *   §5 the Google proxy routes and helpers never answer with the server key,
 *      even when Google errors or the network error names the request (executed)
 *   §6 inventory: every server.js reference to a Maps key is a known shape, so a
 *      new reference (a response, a socket payload, a log line) fails here
 *   §7 the browser side: every Maps loader gets its key from the endpoint;
 *      no build-time Maps key; the legacy pages load no map
 *   §8 discrimination: each guarded behaviour, broken on purpose, is caught
 *
 * Fake key values only. No server, no network, no .env, no app.db.
 *
 * Run: node scripts/test-maps-browser-key.js
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

const FAKE_SERVER = "fake-server-key-c3";
const FAKE_BROWSER = "fake-browser-key-c3";

// Failure details never print a key value, not even a fake one.
const redact = (s) => String(s).split(FAKE_SERVER).join("<server key>").split(FAKE_BROWSER).join("<browser key>");

let failed = 0;
function ok(name, cond, detail) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}${detail ? `\n      ${redact(detail)}` : ""}`); failed++; }
}

// --- lifting ----------------------------------------------------------------

function balancedFrom(src, openAt, open, close) {
	let depth = 0;
	for (let i = openAt; i < src.length; i++) {
		if (src[i] === open) depth++;
		else if (src[i] === close) { depth--; if (depth === 0) return i; }
	}
	throw new Error(`unbalanced ${open}${close} from offset ${openAt}`);
}
function liftFn(name) {
	let at = SRC.indexOf(`\nasync function ${name}(`);
	if (at < 0) at = SRC.indexOf(`\nfunction ${name}(`);
	if (at < 0) { console.error(`FAIL  could not locate ${name} in server.js`); process.exit(1); }
	const bodyOpen = SRC.indexOf(") {", at) + 2;
	return SRC.slice(at + 1, balancedFrom(SRC, bodyOpen, "{", "}") + 1);
}
// A top-level route registration ends at the first "});" in column 0 (its body
// is indented). Counting parentheses instead would trip on comments such as
// "4) Append the row".
function routeSource(verb, routePath, src = SRC) {
	const at = src.indexOf(`app.${verb}("${routePath}"`);
	const end = at < 0 ? -1 : src.indexOf("\n});", at);
	if (at < 0 || end < 0) { console.error(`FAIL  route not found: ${verb.toUpperCase()} ${routePath}`); process.exit(1); }
	return src.slice(at, end + 4);
}
// The declarations of both keys through the end of the startup warning: the
// exact text server.js runs at boot.
function keyBlockSource(src = SRC) {
	const start = src.indexOf("const GOOGLE_MAPS_API_KEY =");
	const warnAt = src.indexOf("\"[maps] ⚠️ GOOGLE_MAPS_BROWSER_KEY", start);
	const ifAt = src.lastIndexOf("\nif (", warnAt);
	if (start < 0 || warnAt < 0 || ifAt < start) { console.error("FAIL  could not locate the Maps key block"); process.exit(1); }
	return src.slice(start, balancedFrom(src, src.indexOf("{", ifAt), "{", "}") + 1);
}
const KEY_BLOCK = keyBlockSource();

function inject(src, deps, tail) {
	const names = Object.keys(deps);
	return new Function(...names, `${src}\n${tail}`)(...names.map((n) => deps[n]));
}
function captureConsole() {
	const lines = [];
	const rec = (level) => (...a) => lines.push({ level, text: a.map(String).join(" ") });
	return { lines, console: { log: rec("log"), info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") } };
}
function boot(env, block = KEY_BLOCK) {
	const cap = captureConsole();
	const keys = inject(block, { process: { env: { ...env } }, console: cap.console },
		"return { GOOGLE_MAPS_API_KEY, GOOGLE_MAPS_BROWSER_KEY, GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT };");
	return { keys, cap };
}
const mapsWarnings = (cap) => cap.lines.filter((l) => /\[maps\]/.test(l.text) && l.level === "warn");

function buildRoute(verb, routePath, deps, src) {
	let handler = null;
	const app = { [verb]: (...args) => { handler = args[args.length - 1]; } };
	inject(src || routeSource(verb, routePath), { app, ...deps }, "");
	return handler;
}
function fakeRes() {
	const r = { statusCode: 200, headers: {}, body: undefined };
	r.status = (c) => { r.statusCode = c; return r; };
	r.set = r.setHeader = r.header = (k, v) => {
		if (k && typeof k === "object") Object.assign(r.headers, k); else r.headers[k] = v;
		return r;
	};
	r.json = r.send = (b) => { r.body = b; return r; };
	r.end = (b) => { if (b !== undefined) r.body = b; return r; };
	r.type = () => r;
	return r;
}
// Everything a client receives from a response.
const wire = (res) => JSON.stringify({ status: res.statusCode, headers: res.headers, body: res.body });

// A fetch that fails in the worst way for a leak: the network error, the
// Google error body, or the "denied" message repeats the request it was given
// (URL and headers, so the key whether it went in the query or a header).
function hostileFetch(mode, calls) {
	return async (url, init = {}) => {
		calls.push({ url: String(url), headers: JSON.stringify(init.headers || {}) });
		const echo = `${url} ${JSON.stringify(init.headers || {})}`;
		if (mode === "throw") {
			const err = new TypeError(`fetch failed: ${echo}`);
			err.cause = new Error(echo);
			throw err;
		}
		const status = mode === "http-error" ? 403 : 200;
		const payload = mode === "http-error"
			? { error: { code: 403, message: `denied: ${echo}`, status: "PERMISSION_DENIED" } }
			: { status: "REQUEST_DENIED", error_message: `denied: ${echo}` };
		const text = JSON.stringify(payload);
		return { ok: status < 300, status, json: async () => JSON.parse(text), text: async () => text };
	};
}
const FETCH_MODES = ["throw", "http-error", "ok-denied"];

// --- configurations -----------------------------------------------------------

const CONFIGS = {
	set: { GOOGLE_MAPS_API_KEY: FAKE_SERVER, GOOGLE_MAPS_BROWSER_KEY: FAKE_BROWSER },
	setPadded: { GOOGLE_MAPS_API_KEY: FAKE_SERVER, GOOGLE_MAPS_BROWSER_KEY: `  ${FAKE_BROWSER}\n` },
	unset: { GOOGLE_MAPS_API_KEY: FAKE_SERVER },
	empty: { GOOGLE_MAPS_API_KEY: FAKE_SERVER, GOOGLE_MAPS_BROWSER_KEY: "" },
	blank: { GOOGLE_MAPS_API_KEY: FAKE_SERVER, GOOGLE_MAPS_BROWSER_KEY: "   " },
	sameAsServer: { GOOGLE_MAPS_API_KEY: FAKE_SERVER, GOOGLE_MAPS_BROWSER_KEY: FAKE_SERVER },
	sameAsServerPadded: { GOOGLE_MAPS_API_KEY: FAKE_SERVER, GOOGLE_MAPS_BROWSER_KEY: ` ${FAKE_SERVER} ` },
	serverWithZeroWidth: { GOOGLE_MAPS_API_KEY: FAKE_SERVER, GOOGLE_MAPS_BROWSER_KEY: `​${FAKE_SERVER}` },
	bothKeys: { GOOGLE_MAPS_API_KEY: FAKE_SERVER, GOOGLE_MAPS_BROWSER_KEY: `${FAKE_SERVER} ${FAKE_BROWSER}` },
	none: {},
};

function configRoute(keys, cap, src) {
	return buildRoute("get", "/api/config/maps-key", {
		mapsKeyLimiter: null,
		bumpMapsKeyHandout: () => {},
		console: cap.console,
		GOOGLE_MAPS_API_KEY: keys.GOOGLE_MAPS_API_KEY,
		GOOGLE_MAPS_BROWSER_KEY: keys.GOOGLE_MAPS_BROWSER_KEY,
	}, src);
}
function askConfig(env) {
	const { keys, cap } = boot(env);
	const res = fakeRes();
	configRoute(keys, cap)({ query: {}, headers: {} }, res);
	return { keys, cap, res };
}

// ===========================================================================
console.log("\n§1  key resolution and the startup warning");
// ===========================================================================
{
	const { keys, cap } = boot(CONFIGS.set);
	ok("browser key set: it is the key served to browsers", keys.GOOGLE_MAPS_BROWSER_KEY === FAKE_BROWSER);
	ok("browser key set: the keys are reported distinct", keys.GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT === true);
	ok("browser key set: no warning", mapsWarnings(cap).length === 0);
	ok("browser key set: the server key is still the one for outbound calls", keys.GOOGLE_MAPS_API_KEY === FAKE_SERVER);
}
{
	const { keys, cap } = boot(CONFIGS.unset);
	ok("browser key unset: browsers get the server key (today's behaviour)", keys.GOOGLE_MAPS_BROWSER_KEY === FAKE_SERVER);
	ok("browser key unset: the keys are reported NOT distinct", keys.GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT === false);
	ok("browser key unset: exactly one warning at startup", mapsWarnings(cap).length === 1);
	ok("the warning names neither key value",
		cap.lines.every((l) => !l.text.includes(FAKE_SERVER) && !l.text.includes(FAKE_BROWSER)));
}
for (const [name, label] of [["empty", "set to an empty string"], ["blank", "set to spaces only"]]) {
	const { keys, cap } = boot(CONFIGS[name]);
	ok(`browser key ${label}: treated as unset (server key served, one warning, not distinct)`,
		keys.GOOGLE_MAPS_BROWSER_KEY === FAKE_SERVER && mapsWarnings(cap).length === 1 &&
		keys.GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT === false,
		`served ${JSON.stringify(keys.GOOGLE_MAPS_BROWSER_KEY === FAKE_SERVER ? "<server key>" : keys.GOOGLE_MAPS_BROWSER_KEY)}, ` +
		`warnings ${mapsWarnings(cap).length}, distinct ${keys.GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT}`);
}
for (const [name, label] of [
	["sameAsServer", "set to the server key"],
	["sameAsServerPadded", "set to the server key padded with spaces"],
	["serverWithZeroWidth", "set to the server key behind a zero-width space"],
	["bothKeys", "set to both keys pasted together"],
]) {
	const { keys, cap } = boot(CONFIGS[name]);
	ok(`browser key ${label}: one warning and reported NOT distinct`,
		mapsWarnings(cap).length === 1 && keys.GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT === false,
		`warnings ${mapsWarnings(cap).length}, distinct ${keys.GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT}`);
}
{
	const { keys, cap } = boot(CONFIGS.setPadded);
	ok("browser key set with surrounding whitespace: served trimmed, distinct, no warning",
		keys.GOOGLE_MAPS_BROWSER_KEY === FAKE_BROWSER && keys.GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT === true &&
		mapsWarnings(cap).length === 0,
		`served ${JSON.stringify(keys.GOOGLE_MAPS_BROWSER_KEY)}`);
}
{
	const { keys, cap } = boot(CONFIGS.none);
	ok("no Maps key at all: nothing to serve and nothing to warn about",
		keys.GOOGLE_MAPS_BROWSER_KEY === "" && mapsWarnings(cap).length === 0);
}

// ===========================================================================
console.log("\n§2  GET /api/config/maps-key");
// ===========================================================================
{
	const { res } = askConfig(CONFIGS.set);
	ok("browser key set: answers with the browser key", res.body && res.body.key === FAKE_BROWSER);
	ok("browser key set: the server key is nowhere in the response", !wire(res).includes(FAKE_SERVER));
	ok("the answer is never cached (a rotation takes effect on the next page load)",
		res.headers["Cache-Control"] === "no-store");
}
{
	const { res } = askConfig(CONFIGS.setPadded);
	ok("browser key set with whitespace: answers with exactly the trimmed browser key",
		res.body && res.body.key === FAKE_BROWSER && !wire(res).includes(FAKE_SERVER));
}
for (const name of ["unset", "empty", "blank"]) {
	const { res } = askConfig(CONFIGS[name]);
	ok(`browser key ${name}: answers with the server key, as today`, res.body && res.body.key === FAKE_SERVER,
		redact(`answered ${JSON.stringify(res.body)}`));
}
{
	const { res } = askConfig(CONFIGS.none);
	ok("no Maps key at all: answers with an empty key", res.body && res.body.key === "");
}

// ===========================================================================
console.log("\n§3  the warning is logged once per start, never per request");
// ===========================================================================
{
	const { keys, cap } = boot(CONFIGS.unset);
	const handler = configRoute(keys, cap);
	for (let i = 0; i < 25; i++) handler({ query: {}, headers: {} }, fakeRes());
	ok("25 requests after startup: still exactly one warning", mapsWarnings(cap).length === 1,
		`saw ${mapsWarnings(cap).length}`);
	ok("the endpoint itself logs nothing", cap.lines.length === 1);
}

// ===========================================================================
console.log("\n§4  GET /api/admin/maps-key-usage (Super Admin) carries no key");
// ===========================================================================
const houstonDay = inject(liftFn("houstonDay"), {}, "return houstonDay;");
for (const name of ["set", "unset"]) {
	const { keys, cap } = boot(CONFIGS[name]);
	const db = new Database(":memory:");
	db.exec("CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)");
	db.prepare("INSERT INTO server_state (key, value) VALUES (?, '3')").run(`maps_key_handouts:${houstonDay()}`);
	const handler = buildRoute("get", "/api/admin/maps-key-usage", {
		requireRole: () => null, db, houstonDay, console: cap.console,
		MAPS_KEY_HANDOUT_PREFIX: "maps_key_handouts:", MAPS_DYNAMIC_LOAD_USD_PER_1K: 7,
		GOOGLE_MAPS_API_KEY: keys.GOOGLE_MAPS_API_KEY,
		GOOGLE_MAPS_BROWSER_KEY: keys.GOOGLE_MAPS_BROWSER_KEY,
		GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT: keys.GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT,
	});
	const res = fakeRes();
	handler({ query: {}, headers: {} }, res);
	ok(`browser key ${name}: the report answers (todayHandouts 3)`, res.body && res.body.todayHandouts === 3);
	ok(`browser key ${name}: neither key value is in the report`,
		!wire(res).includes(FAKE_SERVER) && !wire(res).includes(FAKE_BROWSER));
	ok(`browser key ${name}: browserKeyDistinct is ${name === "set"}`, res.body.browserKeyDistinct === (name === "set"));
	db.close();
}

// ===========================================================================
console.log("\n§5  Google proxy routes and helpers never answer with the server key");
// Each one, with the browser key set, against a fetch that throws an error
// naming the request, answers 403 with a body repeating it, or answers 200 with
// Google's REQUEST_DENIED repeating it. The response (or return value) must
// not carry the server key; the outbound call must carry it (the server key
// is the only key for outbound calls) and must never carry the browser key.
// ===========================================================================
const SET_KEYS = boot(CONFIGS.set).keys;
function outboundCheck(label, calls) {
	ok(`${label}: the outbound call used the server key`,
		calls.length > 0 && calls.every((c) => (c.url + c.headers).includes(FAKE_SERVER)));
	ok(`${label}: the outbound call never used the browser key`,
		calls.every((c) => !(c.url + c.headers).includes(FAKE_BROWSER)));
}
async function proxyRoute(label, routePath, extraDeps, req, routeSrc) {
	for (const mode of FETCH_MODES) {
		const calls = [];
		const cap = captureConsole();
		const handler = buildRoute("get", routePath, {
			REPLICA: null, console: cap.console, fetch: hostileFetch(mode, calls),
			GOOGLE_MAPS_API_KEY: SET_KEYS.GOOGLE_MAPS_API_KEY,
			GOOGLE_MAPS_BROWSER_KEY: SET_KEYS.GOOGLE_MAPS_BROWSER_KEY,
			...extraDeps,
		}, routeSrc);
		const res = fakeRes();
		await handler(req, res);
		ok(`${label} [${mode}]: the response carries no server key`, res.body !== undefined && !wire(res).includes(FAKE_SERVER));
		outboundCheck(`${label} [${mode}]`, calls);
	}
}
async function helper(label, name, extraDeps, call) {
	for (const mode of FETCH_MODES) {
		const calls = [];
		const cap = captureConsole();
		const fn = inject(liftFn(name), {
			REPLICA: null, console: cap.console, fetch: hostileFetch(mode, calls),
			GOOGLE_MAPS_API_KEY: SET_KEYS.GOOGLE_MAPS_API_KEY, ...extraDeps,
		}, `return ${name};`);
		let out, threw = null;
		try { out = await call(fn); } catch (e) { threw = e; }
		ok(`${label} [${mode}]: never throws, so no caller can echo its error`, threw === null,
			threw && redact(threw.message));
		ok(`${label} [${mode}]: the return value carries no server key`, !JSON.stringify(out ?? null).includes(FAKE_SERVER));
		outboundCheck(`${label} [${mode}]`, calls);
	}
}

async function section5() {
	await proxyRoute("GET /api/geocode (public)", "/api/geocode", { geocodeLimiter: null },
		{ query: { lat: "29.7604", lng: "-95.3698" }, headers: {} });
	await proxyRoute("GET /api/geocode/search (public)", "/api/geocode/search",
		{ geocodeLimiter: null, ADDRESS_MAX_CHARS: 500 },
		{ query: { q: "1600 Main St, Houston, TX" }, headers: {} });
	await proxyRoute("GET /api/weather (signed in)", "/api/weather", { requireAuth: null },
		{ query: { lat: "29.7604", lng: "-95.3698" }, headers: {} });

	const stubDb = { prepare: () => ({ get: () => undefined, run: () => ({}), all: () => [] }) };
	await helper("geocodeAddress()", "geocodeAddress", { db: stubDb, ADDRESS_MAX_CHARS: 500 },
		(fn) => fn("1600 Main St, Houston, TX 77002"));
	await helper("geocodeReverse()", "geocodeReverse", {},
		(fn) => fn(29.7604, -95.3698));
	const routeDeps = {
		geolib: { getDistance: () => 1000 }, routeCache: new Map(), routeCacheKey: () => "k",
		ROUTE_CACHE_TTL: 1, routeCacheStore: () => {}, ROUTE_POINTS_MAX: 1500,
		parseRichRoute: () => null, scoreRoutes: () => 0, decodePolyline: () => [], downsamplePoints: (p) => p,
	};
	const from = { latitude: 29.76, longitude: -95.37 };
	const to = { latitude: 32.78, longitude: -96.8 };
	await helper("getRoute() (tracker, dashboard, /api/route)", "getRoute", routeDeps, (fn) => fn(from, to, {}, 0));
	await helper("getRoute({ alternatives })", "getRoute", routeDeps, (fn) => fn(from, to, { alternatives: true }, 0));

	// GET /api/poi/fuel-stops answers err.message on a 500, so what
	// lib/poi-fuel-stops.js throws or returns must never carry the key it was given.
	const { findFuelStopsAlongRoute } = require(path.join(ROOT, "lib", "poi-fuel-stops.js"));
	for (const mode of ["http-error", "ok-denied"]) {
		const calls = [];
		let out, threw = null;
		try {
			out = await findFuelStopsAlongRoute({
				originLat: 29.76, originLng: -95.37, destLat: 30.27, destLng: -97.74,
				apiKey: SET_KEYS.GOOGLE_MAPS_API_KEY, fetchImpl: hostileFetch(mode, calls),
			});
		} catch (e) { threw = e; }
		ok(`findFuelStopsAlongRoute [${mode}]: no server key in what it returns or throws`,
			!JSON.stringify(out ?? null).includes(FAKE_SERVER) && !(threw && String(threw.message).includes(FAKE_SERVER)));
		outboundCheck(`findFuelStopsAlongRoute [${mode}]`, calls);
	}
	ok("lib/poi-fuel-stops.js never puts its apiKey into a string",
		!/\$\{\s*apiKey\b|\+\s*apiKey\b|apiKey\s*\+/.test(fs.readFileSync(path.join(ROOT, "lib", "poi-fuel-stops.js"), "utf8")));

	// The two Distance Matrix callers are not reachable from a browser session
	// (n8n's secret; a Super Admin/Dispatcher upload whose errors only log), but
	// their error text must still stay out of every response.
	const distance = routeSource("post", "/api/n8n/load-distance");
	const bodies = [];
	for (let at = distance.indexOf(".json("); at >= 0; at = distance.indexOf(".json(", at + 1)) {
		if (/\bres(?:\.status\(\d+\))?$/.test(distance.slice(Math.max(0, at - 20), at))) {
			bodies.push(distance.slice(at, balancedFrom(distance, at + ".json".length, "(", ")") + 1));
		}
	}
	ok("POST /api/n8n/load-distance: no response body carries the Distance Matrix error text",
		bodies.length >= 3 && bodies.every((b) => !/lookupError|\.message|GOOGLE_MAPS/.test(b)),
		`checked ${bodies.length} response bodies`);
	ok("POST /api/loads/from-ratecon: a Distance Matrix failure is logged, never answered",
		/catch \(e\) \{\s*console\.error\("Rate-con load: Distance Matrix failed:", e\.message\);\s*\}/.test(
			routeSource("post", "/api/loads/from-ratecon")));
}

// ===========================================================================
// §6  inventory of every server.js reference to a Maps key
// ===========================================================================
const KEY_BLOCK_START = SRC.indexOf(KEY_BLOCK);
const KEY_BLOCK_LINES = (() => {
	const first = SRC.slice(0, KEY_BLOCK_START).split("\n").length;
	return { first, last: first + KEY_BLOCK.split("\n").length - 1 };
})();
// [name, pattern, allowed on a line that also writes a response, a socket
// payload or a log line]. A shape is consumed from the line; whatever key
// reference is left over makes the line unknown.
const SHAPES = [
	["an outbound URL query parameter", /`[^`]*key=\$\{(?:encodeURIComponent\()?GOOGLE_MAPS_API_KEY\)?\}[^`]*`/, false],
	["an outbound X-Goog-Api-Key header", /^\s*"X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,\s*$/, false],
	["the apiKey option of lib/poi-fuel-stops.js", /^\s*apiKey: GOOGLE_MAPS_API_KEY, /, false],
	["a guard on the server key being configured", /\bif \(!?GOOGLE_MAPS_API_KEY\b(?! *[=!]=)/, true],
	["the one response that carries a key: GET /api/config/maps-key", /^\s*res\.json\(\{ key: GOOGLE_MAPS_BROWSER_KEY \}\);\s*$/, true],
	["the admin report's distinctness boolean", /^\s*browserKeyDistinct: GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT,\s*$/, false],
];
const SINK = /\b(?:console\.\w+|res\.\w+|\w+\.emit|\w+\.send|\w+\.write|\w+\.end)\(/;
const KEY_REF = /\bGOOGLE_MAPS_(API|BROWSER)_KEY/;
function classify(code) {
	let rest = code;
	let shape = null;
	for (const [name, re, sinkOk] of SHAPES) {
		if (!re.test(rest) || (!sinkOk && SINK.test(code))) continue;
		rest = rest.replace(re, "");
		shape = shape || name;
	}
	return KEY_REF.test(rest) ? null : shape;
}
// A key's name inside a "..." string is a name, not its value.
const stripStrings = (line) => line.replace(/"(?:[^"\\\n]|\\.)*"/g, (s) => (KEY_REF.test(s) ? "\"\"" : s));
function inventory(src) {
	const lines = src.split("\n");
	const kb = src === SRC ? KEY_BLOCK_LINES : (() => {
		const s = src.indexOf(keyBlockSource(src));
		const first = src.slice(0, s).split("\n").length;
		return { first, last: first + keyBlockSource(src).split("\n").length - 1 };
	})();
	const unknown = [];
	const counts = {};
	lines.forEach((raw, i) => {
		const n = i + 1;
		const trimmed = raw.trim();
		if (/^(\/\/|\*|\/\*)/.test(trimmed)) return;
		const code = stripStrings(raw);
		if (!KEY_REF.test(code)) return;
		const shape = n >= kb.first && n <= kb.last ? "the key declarations and startup warning" : classify(code);
		if (!shape) { unknown.push(`server.js:${n}: ${trimmed.slice(0, 140)}`); return; }
		counts[shape] = (counts[shape] || 0) + 1;
	});
	return { unknown, counts };
}
function section6() {
	console.log("\n§6  inventory: every server.js reference to a Maps key is a known shape");
	const { unknown, counts } = inventory(SRC);
	ok("no reference outside the known shapes (a response, socket payload or log line would land here)",
		unknown.length === 0, unknown.join("\n      "));
	for (const [shape, n] of Object.entries(counts)) console.log(`      ${String(n).padStart(2)} x ${shape}`);
	ok("exactly one response carries a key", counts["the one response that carries a key: GET /api/config/maps-key"] === 1);
	ok("the browser key is never used for an outbound call",
		!/key=\$\{(?:encodeURIComponent\()?GOOGLE_MAPS_BROWSER_KEY|"X-Goog-Api-Key": GOOGLE_MAPS_BROWSER_KEY|apiKey: GOOGLE_MAPS_BROWSER_KEY/.test(SRC));
	ok("server.js reads the two Maps keys from the environment only in the key block",
		(SRC.match(/process\.env\.GOOGLE_MAPS_(API|BROWSER)_KEY/g) || []).length ===
		(KEY_BLOCK.match(/process\.env\.GOOGLE_MAPS_(API|BROWSER)_KEY/g) || []).length);
	const libDir = path.join(ROOT, "lib");
	const libReaders = fs.readdirSync(libDir).filter((f) => /\.(c|m)?js$/.test(f))
		.filter((f) => /process\.env\.GOOGLE_MAPS_/.test(fs.readFileSync(path.join(libDir, f), "utf8")));
	ok("no lib/ module reads a Maps key from the environment", libReaders.length === 0, libReaders.join(", "));
}

// ===========================================================================
// §7  the browser side
// ===========================================================================
function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === "dist") continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out); else if (/\.(vue|js|mjs|ts|html)$/.test(e.name)) out.push(p);
	}
	return out;
}
function section7() {
	console.log("\n§7  the browser side");
	const clientFiles = walk(path.join(ROOT, "client", "src")).concat([path.join(ROOT, "client", "index.html")]);
	const loaders = clientFiles.filter((f) => /maps\.googleapis\.com\/maps\/api\/js/.test(fs.readFileSync(f, "utf8")));
	ok("the client has Maps loaders to check", loaders.length >= 3, `found ${loaders.length}`);
	const strays = loaders.filter((f) => !/\/api\/config\/maps-key/.test(fs.readFileSync(f, "utf8")));
	ok("every Maps loader gets its key from GET /api/config/maps-key", strays.length === 0,
		strays.map((f) => path.relative(ROOT, f)).join(", "));
	const baked = clientFiles.filter((f) => /import\.meta\.env\.[A-Z_]*(MAP|GOOGLE)/i.test(fs.readFileSync(f, "utf8")));
	ok("no build-time Maps key (import.meta.env) in the client", baked.length === 0,
		baked.map((f) => path.relative(ROOT, f)).join(", "));
	const vite = fs.readFileSync(path.join(ROOT, "client", "vite.config.js"), "utf8");
	ok("vite.config.js defines no constant and widens no env prefix", !/\bdefine\s*:|envPrefix/.test(vite));
	const legacy = walk(path.join(ROOT, "public"));
	const legacyMaps = legacy.filter((f) => /maps\.googleapis\.com|\/api\/config\/maps-key|GOOGLE_MAPS/.test(fs.readFileSync(f, "utf8")));
	ok("the legacy public/ pages load no map and fetch no key", legacyMaps.length === 0,
		legacyMaps.map((f) => path.relative(ROOT, f)).join(", "));
}

// ===========================================================================
// §8  discrimination
// ===========================================================================
async function section8() {
	console.log("\n§8  DISCRIMINATION: break each guarded behaviour, require the check to catch it");
	{
		const { keys, cap } = boot(CONFIGS.set);
		const mutant = routeSource("get", "/api/config/maps-key").replace(
			"{ key: GOOGLE_MAPS_BROWSER_KEY }", "{ key: GOOGLE_MAPS_API_KEY }");
		const res = fakeRes();
		configRoute(keys, cap, mutant)({ query: {}, headers: {} }, res);
		ok("MUTANT: an endpoint serving the server key is caught by §2", wire(res).includes(FAKE_SERVER));
	}
	{
		const { keys, cap } = boot(CONFIGS.unset);
		const mutant = routeSource("get", "/api/config/maps-key").replace(
			"res.set(", "console.warn(\"[maps] per-request\");\n\tres.set(");
		const handler = configRoute(keys, cap, mutant);
		for (let i = 0; i < 5; i++) handler({ query: {}, headers: {} }, fakeRes());
		ok("MUTANT: a warning logged per request is caught by §3", mutant !== routeSource("get", "/api/config/maps-key") &&
			mapsWarnings(cap).length === 6);
	}
	{
		const mutant = routeSource("get", "/api/weather").replace(
			"} catch {\n\t\tres.json({ error: \"unavailable\" });",
			"} catch (e) {\n\t\tres.json({ error: e.message });");
		const calls = [];
		const handler = buildRoute("get", "/api/weather", {
			requireAuth: null, REPLICA: null, console: captureConsole().console, fetch: hostileFetch("throw", calls),
			GOOGLE_MAPS_API_KEY: FAKE_SERVER, GOOGLE_MAPS_BROWSER_KEY: FAKE_BROWSER,
		}, mutant);
		const res = fakeRes();
		await handler({ query: { lat: "1", lng: "2" }, headers: {} }, res);
		ok("MUTANT: a proxy route answering the upstream error text is caught by §5",
			mutant !== routeSource("get", "/api/weather") && wire(res).includes(FAKE_SERVER));
	}
	{
		const withLeaks = SRC + "\nio.emit(\"maps:key\", { key: GOOGLE_MAPS_API_KEY });\n" +
			"\tres.json({ key: GOOGLE_MAPS_API_KEY, other: 1 });\n" +
			"console.log(`maps key ${GOOGLE_MAPS_API_KEY}`);\n" +
			"console.error(`upstream https://maps.googleapis.com/x?key=${GOOGLE_MAPS_API_KEY}`);\n" +
			"if (GOOGLE_MAPS_API_KEY) res.set(\"X-Maps\", GOOGLE_MAPS_API_KEY);\n";
		const caught = inventory(withLeaks).unknown.length - inventory(SRC).unknown.length;
		ok("MUTANT: a socket payload, a second response, a header and log lines carrying the key are all caught by §6",
			caught === 5, `caught ${caught} of 5`);
	}
	{
		// The comparison as it stood before whitespace was ignored.
		const untrimmed = KEY_BLOCK
			.replace(/const GOOGLE_MAPS_BROWSER_KEY_SETTING =[\s\S]*?;\n/, "")
			.replace(/const GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT =[\s\S]*?;\n/,
				"const GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT =\n\t!!process.env.GOOGLE_MAPS_BROWSER_KEY &&\n" +
				"\tprocess.env.GOOGLE_MAPS_BROWSER_KEY !== GOOGLE_MAPS_API_KEY;\n")
			.replace(/const GOOGLE_MAPS_BROWSER_KEY =[\s\S]*?;\n/,
				"const GOOGLE_MAPS_BROWSER_KEY =\n\tprocess.env.GOOGLE_MAPS_BROWSER_KEY || GOOGLE_MAPS_API_KEY;\n");
		let distinct = null;
		try { distinct = boot(CONFIGS.sameAsServerPadded, untrimmed).keys.GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT; } catch { distinct = null; }
		ok("MUTANT: comparing untrimmed values reads a padded copy of the server key as distinct (caught by §1)",
			untrimmed !== KEY_BLOCK && distinct === true);
	}
}

(async () => {
	await section5();
	section6();
	section7();
	await section8();
	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((e) => {
	console.error(`FAIL  runner crashed: ${redact(e && e.stack ? e.stack : e)}`);
	process.exit(1);
});
