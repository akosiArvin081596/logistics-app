#!/usr/bin/env node
/**
 * The shared Job Tracking cache must never be WRITTEN by a reader.
 *
 * WHY THIS EXISTS. getJobTrackingCached() hands every caller the SAME object for
 * up to 60 s. Four routes — /api/dashboard, /api/driver/:driverName,
 * /api/investor and /api/financials — each ran
 *
 *     jobTracking.data = excludeDroppedLoads(jobTracking.data, jobTracking.headers);
 *
 * on that shared object. For up to a minute after any of them, cancelled and
 * soft-deleted loads vanished for every other caller, including the ones that
 * deliberately keep them: reconcileRateCons() says in so many words that
 * filtering them out "would re-report every cancelled load as missing". And the
 * dashboard's _pickupLocation / the driver view's _docCount / _queuePosition
 * annotations were written onto cached ROWS, leaking between surfaces and
 * surviving — the conditional ones stale — until the cache turned over.
 *
 * The four routes now read through liveJobTrackingView(): live rows only, fresh
 * arrays, every row a shallow copy.
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 liveJobTrackingView() executed for real on a DEEP-FROZEN cache in strict
 *      mode — any write that reaches the cache throws
 *   §2 the four routes: their binding statement extracted and executed
 *   §3 SOURCE SWEEP over every getJobTrackingCached() caller in server.js — no
 *      write to the cached object, its arrays, or (by the `_x` annotation
 *      convention and by direct loops) its rows; and no READ of a `_x`
 *      annotation off a cached row, since only another route could have put it
 *      there (the completed export read the dashboard's until 2026-09-23)
 *   §4 the incident, replayed: the old statement hides a cancelled load from a
 *      second reader; the view does not
 *   §5 the readers that must NOT see dropped loads now filter them themselves
 *      (they used to lean, unknowingly, on another route's in-place filter)
 *   §6 DISCRIMINATION — mutants of the helper, and of server.js for the sweep
 *
 * ⚠️ §3 is a HEURISTIC over source text. It catches the shapes this bug has
 * actually taken and the obvious variants; it cannot follow a row into a helper
 * in another function. The rule it enforces is the simple one: a route that
 * annotates or rearranges Job Tracking rows reads them through
 * liveJobTrackingView().
 *
 * Pure: no server, no app.db, no network, no fixtures.
 *
 * Run: node scripts/test-jt-cache-isolation.js
 */

// ⚠️ LOAD-BEARING. In sloppy mode a write to a frozen object is silently
// IGNORED, not thrown — and every "the cache was not written" probe below
// would pass against a helper that tried to write it.
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}

// --- lifting ---------------------------------------------------------------
// ⚠️ Brace counting starts at the BODY, after the parameter list is paren-matched:
// tryGeofenceAdvance({ latitude, … }) destructures, and counting from the first
// `{` would return the parameter list alone.
function liftFn(name, src = SRC) {
	let a = src.indexOf(`function ${name}(`);
	if (a < 0) { console.error(`FAIL  could not locate ${name} in server.js`); process.exit(1); }
	if (src.slice(a - 6, a) === "async ") a -= 6;
	let p = src.indexOf("(", src.indexOf(`function ${name}(`)), pd = 0;
	for (; p < src.length; p++) {
		if (src[p] === "(") pd++;
		else if (src[p] === ")") { pd--; if (pd === 0) break; }
	}
	let depth = 0, seen = false;
	for (let i = src.indexOf("{", p); i < src.length; i++) {
		if (src[i] === "{") { depth++; seen = true; }
		else if (src[i] === "}") { depth--; if (seen && depth === 0) return src.slice(a, i + 1); }
	}
	throw new Error(`unbalanced braces in ${name}`);
}
// ⚠️ Anchored at a line start: comments QUOTE route registrations (one above
// /api/driver/:driverName reads `app.get("/api/driver/:driverName")`), and a
// bare indexOf lands in the comment instead of the route.
function routeSource(verb, routePath, src = SRC) {
	const nl = src.indexOf(`\napp.${verb}("${routePath}"`);
	const at = nl < 0 ? -1 : nl + 1;
	if (at < 0) { console.error(`FAIL  route not found: ${verb.toUpperCase()} ${routePath}`); process.exit(1); }
	let depth = 0;
	for (let j = src.indexOf("(", at); j < src.length; j++) {
		if (src[j] === "(") depth++;
		else if (src[j] === ")") { depth--; if (depth === 0) return src.slice(at, j + 1); }
	}
	throw new Error(`unbalanced parens extracting ${routePath}`);
}

const VIEW_SRC = liftFn("liveJobTrackingView");
const EXCLUDE_SRC = liftFn("excludeDroppedLoads");
const FINDCOL_SRC = liftFn("findCol");
const CANCELED_RE_SRC = (SRC.match(/const CANCELED_STATUS_RE = [^\n]+;/) || [""])[0];
if (!CANCELED_RE_SRC) { console.error("FAIL  could not locate CANCELED_STATUS_RE"); process.exit(1); }

const DELETED_ID = "209875716";
const CANCELLED_ID = "564446669";
function buildView(viewSrc = VIEW_SRC) {
	const getDeletedLoadIds = () => new Set([DELETED_ID]);
	return new Function("getDeletedLoadIds",
		`"use strict";\n${CANCELED_RE_SRC}\n${FINDCOL_SRC}\n${EXCLUDE_SRC}\n${viewSrc}\n` +
		"return { liveJobTrackingView, excludeDroppedLoads };")(getDeletedLoadIds);
}
const { liveJobTrackingView, excludeDroppedLoads } = buildView();

// --- fixtures --------------------------------------------------------------
const HEADERS = ["Load ID", "Driver", "Job Status", "Pickup Address"];
function makeCache() {
	return {
		headers: [...HEADERS],
		data: [
			{ _rowIndex: 2, "Load ID": "564157463", Driver: "Deshorn King", "Job Status": "In Transit", "Pickup Address": "4528 W Royal Ln, Irving, TX 75063" },
			{ _rowIndex: 3, "Load ID": CANCELLED_ID, Driver: "", "Job Status": "Cancelled", "Pickup Address": "" },
			{ _rowIndex: 4, "Load ID": DELETED_ID, Driver: "", "Job Status": "Unassigned", "Pickup Address": "" },
			{ _rowIndex: 5, "Load ID": "30080873", Driver: "Shorn King", "Job Status": "Delivered", "Pickup Address": "" },
		],
	};
}
function deepFreeze(o) {
	Object.freeze(o);
	for (const v of Object.values(o)) if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
	return o;
}
const idsOf = (rows) => rows.map((r) => r["Load ID"]);

// ===========================================================================
console.log("\n§1  liveJobTrackingView() on a deep-frozen cache (strict mode)");
// ===========================================================================
{
	const cache = deepFreeze(makeCache());
	const before = JSON.stringify(cache);
	let view, threw = null;
	try { view = liveJobTrackingView(cache); } catch (e) { threw = e; }
	ok("building the view writes nothing to the cache (a write would throw here)", threw === null);
	ok("the view drops the cancelled and the soft-deleted load",
		idsOf(view.data).join() === ["564157463", "30080873"].join());
	ok("...by the same rule as excludeDroppedLoads() (one rule, not a copy)",
		idsOf(view.data).join() === idsOf(excludeDroppedLoads(cache.data, cache.headers)).join());
	ok("fresh object, fresh arrays", view !== cache && view.data !== cache.data && view.headers !== cache.headers);
	ok("every row is a COPY, equal in content",
		view.data.every((r) => !cache.data.includes(r)) &&
		JSON.stringify(view.data[0]) === JSON.stringify(cache.data[0]));
	let mutateErr = null;
	try {
		view.data[0]._pickupLocation = "Irving, TX 75063";   // the dashboard's annotation
		view.data[0]._queuePosition = 1;                    // the driver view's annotation
		delete view.data[0]["Pickup Address"];              // the Driver-role column strip
		view.data.sort((a, b) => (a["Load ID"] < b["Load ID"] ? -1 : 1));
		view.data.push({ "Load ID": "x" });
		view.headers.push("Extra");
	} catch (e) { mutateErr = e; }
	ok("a route may annotate, strip, sort and extend its view freely", mutateErr === null);
	ok("...and the cache is byte-identical afterwards", JSON.stringify(cache) === before);
	ok("the next caller's view is clean (no annotation carried over)",
		liveJobTrackingView(cache).data.every((r) => !("_pickupLocation" in r) && !("_queuePosition" in r)));
	const empty = liveJobTrackingView(undefined);
	ok("a missing / empty cache yields an empty view rather than throwing",
		Array.isArray(empty.data) && empty.data.length === 0 && Array.isArray(empty.headers) &&
		liveJobTrackingView({ headers: [], data: [] }).data.length === 0);
}

// ===========================================================================
console.log("\n§2  the four filtering routes read through the view");
// ===========================================================================
const pending = [];   // async checks; the exit waits for every one
const BINDING = "const jobTracking = liveJobTrackingView(await getJobTrackingCached());";
for (const [verb, route] of [
	["get", "/api/dashboard"], ["get", "/api/driver/:driverName"],
	["get", "/api/investor"], ["get", "/api/financials"],
]) {
	const body = routeSource(verb, route);
	ok(`${route}: binds jobTracking through liveJobTrackingView()`, body.includes(BINDING));
	ok(`${route}: never assigns jobTracking.data / .headers`,
		!/\bjobTracking\s*\.\s*(data|headers)\s*=(?!=)/.test(body));
	ok(`${route}: reads the cache exactly once (no second, raw read to annotate)`,
		(body.match(/getJobTrackingCached\(/g) || []).length === 1);
	const cache = deepFreeze(makeCache());
	const run = new Function("liveJobTrackingView", "getJobTrackingCached",
		`"use strict";\nreturn (async () => { ${BINDING} return jobTracking; })();`);
	pending.push(run(liveJobTrackingView, async () => cache).then((jt) => {
		ok(`${route}: the extracted binding, executed, yields live copies and leaves the cache alone`,
			idsOf(jt.data).join() === "564157463,30080873" && jt.data[0] !== cache.data[0]);
	}, (e) => ok(`${route}: the extracted binding executes (${e.message})`, false)));
}

// ===========================================================================
// §3 source sweep — shared with §5 so the mutants run the very same code.
// ===========================================================================
const TOP_RE = /^(app\.(get|post|put|delete|patch|use)\(|async function |function |const [A-Za-z_$][\w$]* = (async )?\(|setInterval\(|setTimeout\()/;
const MUTATORS = "sort|reverse|splice|push|pop|shift|unshift|fill|copyWithin";
// Underscore writes that are NOT on Job Tracking rows, each with the reason.
const ANNOTATION_ALLOW = [
	{ fn: "routemateSyncTelemetry", write: "t._droppedReason =", why: "t is a telemetry fix being filtered, not a sheet row" },
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function matchClose(text, openIdx, open, close) {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		if (text[i] === open) depth++;
		else if (text[i] === close) { depth--; if (depth === 0) return i; }
	}
	return text.length - 1;
}

function sweep(src) {
	const lines = src.split("\n");
	const tops = [];
	lines.forEach((l, i) => { if (TOP_RE.test(l)) tops.push(i); });
	const blockOf = (i) => {
		let s = 0;
		for (const t of tops) { if (t <= i) s = t; else break; }
		const nxt = tops.find((t) => t > s);
		return { start: s, header: lines[s], text: lines.slice(s, nxt === undefined ? lines.length : nxt).join("\n") };
	};
	const findings = [];
	const sites = [];
	lines.forEach((l, i) => {
		if (!l.includes("getJobTrackingCached()") || /^\s*(\/\/|\*)/.test(l) || /function getJobTrackingCached/.test(l)) return;
		const block = blockOf(i);
		const where = `server.js:${i + 1} (${block.header.trim().slice(0, 60)})`;
		if (/liveJobTrackingView\(\s*await getJobTrackingCached\(\)\s*\)/.test(l)) { sites.push({ where, kind: "view" }); return; }
		const bound = l.match(/\b([A-Za-z_$][\w$]*)\s*=\s*await getJobTrackingCached\(\)/);
		if (!bound) {
			if (/^\s*await getJobTrackingCached\(\);\s*(\/\/.*)?$/.test(l)) { sites.push({ where, kind: "prime" }); return; }
			findings.push(`${where}: unrecognised use of getJobTrackingCached() — bind it, prime it, or wrap it in liveJobTrackingView()`);
			return;
		}
		const X = bound[1], x = esc(X), t = block.text;
		sites.push({ where, kind: "raw", name: X });
		const hit = (re, what) => { const m = t.match(re); if (m) findings.push(`${where}: ${what} — \`${m[0].trim().slice(0, 80)}\``); };
		// (a) the cached object and its arrays
		hit(new RegExp(`\\b${x}\\s*\\.\\s*(data|headers)\\s*=(?!=)`), `reassigns ${X}.data/.headers on the SHARED cache`);
		hit(new RegExp(`\\b${x}\\.(data|headers)\\.(${MUTATORS})\\(`), `mutates the cached ${X} array in place`);
		hit(new RegExp(`Object\\.assign\\(\\s*${x}\\b`), `Object.assign onto the cached ${X}`);
		hit(new RegExp(`\\bdelete\\s+${x}\\.`), `deletes from the cached ${X}`);
		// (b) a bare alias of a cached array, mutated in place
		for (const m of t.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\(?\\s*${x}\\.(?:data|headers)(?:\\s*\\|\\|\\s*\\[\\s*\\])?\\s*\\)?\\s*;`, "g"))) {
			hit(new RegExp(`\\b${esc(m[1])}\\.(${MUTATORS})\\(`), `mutates ${m[1]} (an alias of the cached ${X} array) in place`);
		}
		// (c) rows reached by a direct loop over the cached array
		const loops = [
			...[...t.matchAll(new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+\\(?\\s*${x}\\.data\\b`, "g"))].map((m) => ({ m, kind: "for" })),
			...[...t.matchAll(new RegExp(`${x}\\.data\\.(?:forEach|map|filter|some|every|find|findIndex)\\(\\s*(?:async\\s*)?(?:function\\s*)?\\(?\\s*([A-Za-z_$][\\w$]*)`, "g"))].map((m) => ({ m, kind: "cb" })),
		];
		for (const { m, kind } of loops) {
			const R = esc(m[1]);
			let body;
			if (kind === "for") {
				const close = matchClose(t, t.indexOf("(", m.index), "(", ")");
				const rest = t.slice(close + 1);
				const lead = rest.match(/^\s*/)[0].length;
				body = rest[lead] === "{" ? rest.slice(lead, matchClose(rest, lead, "{", "}") + 1) : rest.slice(0, rest.indexOf(";") + 1);
			} else {
				const open = t.indexOf("(", m.index + m[0].indexOf("("));
				body = t.slice(open, matchClose(t, open, "(", ")") + 1);
			}
			const w = body.match(new RegExp(`\\b${R}(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]\\n]+\\])\\s*(?:=(?!=)|\\+=|-=|\\+\\+|--)|\\bdelete\\s+${R}[.\\[]`));
			if (w) findings.push(`${where}: writes to a CACHED ROW (${m[1]}) — \`${w[0].trim().slice(0, 80)}\``);
		}
		// (d) the `_x` annotation convention: a raw-cache function must not write one
		const fnName = (block.header.match(/function ([A-Za-z_$][\w$]*)/) || [])[1] || "";
		for (const m of t.matchAll(/\b([A-Za-z_$][\w$]*)\._[A-Za-z]\w*\s*=(?!=)/g)) {
			const allowed = ANNOTATION_ALLOW.some((a) => a.fn === fnName && m[0].startsWith(a.write.replace(/ =$/, "")));
			if (!allowed) findings.push(`${where}: writes a \`_\` annotation (\`${m[0].trim()}\`) while holding the RAW cache — read through liveJobTrackingView()`);
		}
		// (e) ...nor READ one. A cached row carries only its sheet cells plus
		// parseSheet()'s `_rowIndex`; any other `_x` on it could only have been left
		// there by another route's write — the coupling (d) forbids. The completed
		// export read the dashboard's `_pickupLocation` this way until 2026-09-23.
		for (const m of t.matchAll(/\b(r|row|jtRow|loadObj|match)\._(?!rowIndex\b)[A-Za-z]\w*\b(?!\s*=(?!=))/g)) {
			findings.push(`${where}: reads \`${m[0]}\` off a RAW cached row — no route may rely on another route's annotations`);
		}
	});
	return { findings, sites };
}

console.log("\n§3  source sweep — every getJobTrackingCached() caller in server.js");
const live = sweep(SRC);
for (const f of live.findings) console.log(`      ${f}`);
ok("no caller writes to the shared cache, its arrays or its rows — or reads another route's annotations off them",
	live.findings.length === 0);
const kinds = live.sites.reduce((a, s) => ((a[s.kind] = (a[s.kind] || 0) + 1), a), {});
ok(`found the callers (${live.sites.length}: ${kinds.raw || 0} raw, ${kinds.view || 0} view, ${kinds.prime || 0} prime) — ` +
	"a sweep that finds nothing proves nothing", live.sites.length >= 25 && (kinds.view || 0) === 4);
ok("every allow-listed annotation still exists (a stale allow-list hides nothing but lies)",
	ANNOTATION_ALLOW.every((a) => liftFn(a.fn).includes(a.write)));

// ===========================================================================
console.log("\n§4  the incident, replayed");
// ===========================================================================
{
	const shared = makeCache();
	// The pre-fix statement, verbatim, as /api/dashboard ran it on the shared object.
	(function dashboardBefore() {
		const jobTracking = shared;
		jobTracking.data = excludeDroppedLoads(jobTracking.data, jobTracking.headers);
		for (const r of jobTracking.data) r._pickupLocation = "Irving, TX 75063";
	})();
	// What reconcileRateCons() then read from the "same" cache.
	ok("BEFORE: one dashboard load and the cancelled load is gone for reconcileRateCons()",
		!idsOf(shared.data).includes(CANCELLED_ID) && !idsOf(shared.data).includes(DELETED_ID));
	ok("BEFORE: and the dashboard's annotation is stuck to the cached row", "_pickupLocation" in shared.data[0]);

	const shared2 = makeCache();
	(function dashboardAfter() {
		const jobTracking = liveJobTrackingView(shared2);
		for (const r of jobTracking.data) r._pickupLocation = "Irving, TX 75063";
	})();
	ok("AFTER: reconcileRateCons() still sees the cancelled and the soft-deleted load",
		idsOf(shared2.data).includes(CANCELLED_ID) && idsOf(shared2.data).includes(DELETED_ID));
	ok("AFTER: and no annotation reached the cache", shared2.data.every((r) => !("_pickupLocation" in r)));
}

// ===========================================================================
console.log("\n§5  readers that must NOT see dropped loads now filter them themselves");
// Before liveJobTrackingView() these leaned, unknowingly, on some other route
// having filtered the shared cache in place — usually true, never guaranteed.
// A soft-deleted load keeps its active status on the sheet, so a status test
// alone does not exclude it.
// ===========================================================================
const SKIP_DELETED = 'if (deletedIds.has(lid.toLowerCase().replace(/^#/, ""))) continue;';
{
	const tele = liftFn("routemateSyncTelemetry");
	const linx = liftFn("ingestLinxupPosition");
	ok("routemateSyncTelemetry(): a soft-deleted load cannot win a driver's slot",
		tele.includes("const deletedIds = getDeletedLoadIds();") && tele.includes(SKIP_DELETED) &&
		tele.indexOf(SKIP_DELETED) < tele.indexOf("if (!loadIdByDriver[d]) loadIdByDriver[d] = lid;"));
	ok("ingestLinxupPosition(): same, before activeLoadId picks the public tracker room",
		linx.includes("const deletedIds = getDeletedLoadIds();") && linx.includes(SKIP_DELETED) &&
		linx.indexOf(SKIP_DELETED) < linx.indexOf("if (!activeLoadId) activeLoadId = lid;"));
	const trucks = routeSource("get", "/api/trucks");
	ok("/api/trucks counts completed loads over excludeDroppedLoads(), not the raw cache (investor-visible)",
		/excludeDroppedLoads\(jt\.data, jt\.headers\)\.forEach\(/.test(trucks) && !/\bjt\.data\.forEach\(/.test(trucks));
}
const GEO_SRC = liftFn("tryGeofenceAdvance");
function geofenceReads(geoSrc, loadId) {
	let reads = 0;
	const geo = new Function("getDeletedLoadIds", "getJobTrackingCached", "console",
		`"use strict";\n${geoSrc}\nreturn tryGeofenceAdvance;`)(
		() => new Set([DELETED_ID]),
		async () => { reads++; throw new Error("sheet read"); },
		{ error() {}, warn() {}, log() {} });
	return geo({ latitude: 32.85, longitude: -96.95, driverName: "Deshorn King", loadId, speedMps: 20 })
		.then((r) => ({ r, reads }));
}
pending.push(Promise.all([
	geofenceReads(GEO_SRC, "#" + DELETED_ID),
	geofenceReads(GEO_SRC, "564157463"),
]).then(([deleted, liveLoad]) => {
	ok("tryGeofenceAdvance() never touches a soft-deleted load — returns before reading the sheet ('#' spelling too)",
		deleted.r === null && deleted.reads === 0);
	ok("...and still reads the sheet for a live one", liveLoad.reads === 1);
}));

// ===========================================================================
console.log("\n§6  DISCRIMINATION — each mutant must be caught");
// ===========================================================================
function strictAnnotateThrows(viewSrc) {
	const { liveJobTrackingView: v } = buildView(viewSrc);
	const cache = deepFreeze(makeCache());
	try {
		const view = v(cache);
		view.data[0]._pickupLocation = "x";
		view.headers.push("Extra");
		return JSON.stringify(cache) !== JSON.stringify(deepFreeze(makeCache()));
	} catch { return true; }
}
ok("(the real helper passes this probe)", strictAnnotateThrows(VIEW_SRC) === false);
const ROW_COPY = ".map((r) => ({ ...r }))";
ok("MUTANT view without the row copy: annotating a view row reaches the frozen cache",
	VIEW_SRC.includes(ROW_COPY) && strictAnnotateThrows(VIEW_SRC.replace(ROW_COPY, "")) === true);
ok("MUTANT view sharing the headers array: extending the view's headers reaches the cache",
	strictAnnotateThrows(VIEW_SRC.replace("headers: [...headers],", "headers,")) === true);
const reassigning = VIEW_SRC.replace(/\{\n\tconst headers[\s\S]*\n\}$/,
	"{\n\tjt.data = excludeDroppedLoads(jt.data, jt.headers);\n\treturn jt;\n}");
ok("MUTANT the old in-place statement inside the helper: caught",
	reassigning !== VIEW_SRC && strictAnnotateThrows(reassigning) === true);

const reverted = SRC.replace(
	"const jobTracking = liveJobTrackingView(await getJobTrackingCached());",
	"const jobTracking = await getJobTrackingCached();\n\t\tjobTracking.data = excludeDroppedLoads(jobTracking.data, jobTracking.headers);");
const revertedSweep = sweep(reverted);
ok("MUTANT server.js with /api/dashboard reverted to the pre-fix pattern: the sweep flags it",
	reverted !== SRC && revertedSweep.findings.some((f) => /reassigns jobTracking\.data/.test(f)));
ok("...and flags the _pickupLocation annotation it would then write onto cached rows",
	revertedSweep.findings.some((f) => /_pickupLocation/.test(f)));

const TRY_GEO = "const jt = await getJobTrackingCached();";
const geoAt = SRC.indexOf("async function tryGeofenceAdvance(");
const geoCall = SRC.indexOf(TRY_GEO, geoAt);
function injectAfterGeoRead(extra) {
	return SRC.slice(0, geoCall + TRY_GEO.length) + extra + SRC.slice(geoCall + TRY_GEO.length);
}
ok("(mutation anchor present)", geoAt > 0 && geoCall > geoAt);
ok("MUTANT an in-place sort of the cached array: flagged",
	sweep(injectAfterGeoRead("\n\tjt.data.sort(() => 0);")).findings.some((f) => /mutates the cached jt array/.test(f)));
ok("MUTANT a sort through a bare alias (`const rows = jt.data || [];`): flagged",
	sweep(injectAfterGeoRead("\n\tconst rows = jt.data || [];\n\trows.reverse();")).findings.some((f) => /alias of the cached jt/.test(f)));
ok("MUTANT a non-underscore write to a cached row in a for-of loop: flagged",
	sweep(injectAfterGeoRead("\n\tfor (const row of jt.data) { row.seen = true; }")).findings.some((f) => /CACHED ROW \(row\)/.test(f)));
ok("MUTANT a write to a cached row in a forEach callback: flagged",
	sweep(injectAfterGeoRead("\n\tjt.data.forEach((r) => { r[\"Driver\"] = \"\"; });")).findings.some((f) => /CACHED ROW \(r\)/.test(f)));
ok("MUTANT a `_x` annotation in a raw-cache function: flagged",
	sweep(injectAfterGeoRead("\n\tconst m = jt.data[0]; if (m) m._touched = 1;")).findings.some((f) => /_touched/.test(f)));
const EXPORT_PICKUP = 'const pickup = resolveAddressParts(r, "pickup", lid, pickupRaw).cityStateZip';
ok("(export anchor present)", SRC.includes(EXPORT_PICKUP));
ok("MUTANT the completed export reading the dashboard's `r._pickupLocation` again: flagged",
	sweep(SRC.replace(EXPORT_PICKUP, 'const pickup = r._pickupLocation || resolveAddressParts(r, "pickup", lid, pickupRaw).cityStateZip'))
		.findings.some((f) => /reads `r\._pickupLocation` off a RAW cached row/.test(f)));

const GEO_SKIP_RE = /\n\tif \(getDeletedLoadIds\(\)\.has\([^\n]+\n/;
ok("(geofence mutation anchor present)", GEO_SKIP_RE.test(GEO_SRC));
pending.push(geofenceReads(GEO_SRC.replace(GEO_SKIP_RE, "\n"), DELETED_ID).then(({ reads }) => {
	ok("MUTANT geofence without its soft-delete check: it reads the deleted load's row — §5 flips", reads === 1);
}));

Promise.allSettled(pending).then((results) => {
	for (const r of results) if (r.status === "rejected") ok(`async check did not throw (${r.reason && r.reason.message})`, false);
	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
});
