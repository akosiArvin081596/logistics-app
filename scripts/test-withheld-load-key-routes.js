#!/usr/bin/env node
// A Dispatcher opens, edits, assigns and overrides a load whose Load ID holds
// broker contact by an opaque key, and never receives the ID text (the
// Dispatcher raw Load ID plan, PR 2; WITHHELD_LOAD_REFS_ENABLED, off by default).
//
// Written before the change: on main every section fails (no gate, no
// loadIdFor(), no keys served), except the Super Admin and flag-off pins.
//
//   §1 the route list: every route that reads a load ID from its path, its query,
//      its body or X-Message-Load-Id either reads it through loadIdFor() (or
//      messageLoadIdFor()) or is listed here with why it needs no key; a new
//      such route fails this runner until it is one or the other. The gate is
//      mounted above every route.
//   §2 the gate (withheldLoadKeyGate()): a key in the path, a load field of the
//      query or the body, or X-Message-Load-Id reads as its load and leaves the
//      request as sent; an unknown key in one of those answers 404
//      LOAD_KEY_UNKNOWN before any handler; key-shaped text elsewhere, a
//      /api/public path, a Super Admin, a Driver, the flag off and value
//      redaction off are left alone.
//   §3 the reply guard as the gate installs it: it keeps the status code,
//      swaps the stored ID and its phone, counts the hit and logs the route only.
//   §4 keys served: the dashboard rows, the Fleet chips and queues, the load
//      detail and a stored notice carry a key beside each withheld ID, to a
//      Dispatcher only; never to a Super Admin, never on the Driver page, never
//      with the flag off.
//   §5 every route a Dispatcher opens a withheld load by, run through the gate
//      with its key: success and error branches (LOAD_NOT_ON_SHEET,
//      AMBIGUOUS_LOAD, ROW_LOAD_MISMATCH, the override's 404, period refusals)
//      act on the stored ID, name it as shown, and the reply guard counts no hit;
//      documents are listed closed; a message names the load as stored only to
//      its own driver; a row save of an ID that is only contact is confirmed by
//      the key.
//
// Every route is lifted whole out of server.js and run with only its I/O
// stubbed (sheet reads, SQLite, sockets); any other name it touches is the
// shipped top-level function or constant. THE FIXTURE IS MADE UP: QA- load
// numbers, 555-01xx numbers, example.invalid addresses.
//
//   node scripts/test-withheld-load-key-routes.js     # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const { normalizeLoadId } = require(path.join(ROOT, "lib", "ratecon-load"));
const bc = require(path.join(ROOT, "lib", "broker-contact"));
let keyLib = null;
try { keyLib = require(path.join(ROOT, "lib", "withheld-load-key")); } catch { keyLib = null; }

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return true; }
	fail++; failures.push(name);
	console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`.slice(0, 1600));
	return false;
}

// ------------------------------------------------------------------ extraction
function extractRoute(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n});", start);
	return SRC.slice(start, end + "\n});".length);
}
const TOP_FUNCTION_STARTS = new Map();
for (const m of SRC.matchAll(/\n(?:async )?function ([A-Za-z_$][\w$]*)\(/g)) {
	const starts = TOP_FUNCTION_STARTS.get(m[1]) || [];
	starts.push(m.index + 1);
	TOP_FUNCTION_STARTS.set(m[1], starts);
}
const TOP_CONST_STARTS = new Map();
for (const m of SRC.matchAll(/^const ([A-Za-z_$][\w$]*) = /gm)) {
	if (!TOP_CONST_STARTS.has(m[1])) TOP_CONST_STARTS.set(m[1], m.index);
}
const FUNCTION_SRC = new Map();
const CONST_SRC = new Map();
function topLevelFunction(name) {
	if (FUNCTION_SRC.has(name)) return FUNCTION_SRC.get(name);
	const starts = TOP_FUNCTION_STARTS.get(name) || [];
	if (starts.length > 1) throw new Error(`${starts.length} top-level definitions of ${name}()`);
	let out = null;
	if (starts.length === 1) out = SRC.slice(starts[0], SRC.indexOf("\n}\n", starts[0]) + 3);
	FUNCTION_SRC.set(name, out);
	return out;
}
function topLevelConst(name) {
	if (CONST_SRC.has(name)) return CONST_SRC.get(name);
	let out = null;
	if (TOP_CONST_STARTS.has(name)) {
		const lineStart = TOP_CONST_STARTS.get(name);
		const lineEnd = SRC.indexOf("\n", lineStart);
		const line = SRC.slice(lineStart, lineEnd < 0 ? SRC.length : lineEnd);
		const start = lineStart + `const ${name} = `.length;
		const one = /^(.+);[ \t]*$/.exec(line.slice(`const ${name} = `.length));
		if (one) {
			out = one[1];
		} else {
			const close = /\n([\]})]+);[ \t]*\n/g;
			close.lastIndex = start;
			const m = close.exec(SRC);
			out = m ? SRC.slice(start, m.index + 1 + m[1].length) : null;
		}
	}
	CONST_SRC.set(name, out);
	return out;
}
// A lifted route runs inside `with (scope)`: a stub is the stub, a top-level
// function or const of server.js is that shipped code compiled in the same
// scope, a JS global stays the global; anything else throws "unstubbed".
function makeScope(stubs) {
	const cache = Object.create(null);
	let proxy = null;
	const resolveTop = (key) => {
		if (key in cache) return { found: true, value: cache[key] };
		const fn = topLevelFunction(key);
		if (fn) {
			cache[key] = new Function("__scope", `with (__scope) { ${fn}\n return ${key}; }`)(proxy);
			return { found: true, value: cache[key] };
		}
		const expr = topLevelConst(key);
		if (expr != null) {
			cache[key] = new Function("__scope", `with (__scope) { return (${expr}); }`)(proxy);
			return { found: true, value: cache[key] };
		}
		return { found: false };
	};
	proxy = new Proxy(Object.create(null), {
		has(_, key) {
			if (typeof key !== "string" || key === "__scope") return false;
			if (Object.prototype.hasOwnProperty.call(stubs, key) || key in cache) return true;
			if (topLevelFunction(key) || topLevelConst(key) != null) return true;
			return !(key in globalThis);
		},
		get(_, key) {
			if (key === Symbol.unscopables) return undefined;
			if (Object.prototype.hasOwnProperty.call(stubs, key)) return stubs[key];
			const top = resolveTop(key);
			if (top.found) return top.value;
			if (key in globalThis) return globalThis[key];
			throw new ReferenceError(`unstubbed in the lifted route: ${String(key)}`);
		},
		set(_, key, value) { cache[key] = value; return true; },
	});
	return proxy;
}
const realRequire = (p) => (/^\.\/lib\//.test(p) ? require(path.join(ROOT, p)) : require(p));
// The handler a route registration registers, compiled in a scope from `stubs`.
function liftHandler(head, stubs) {
	const src = extractRoute(head);
	let handler = null;
	const register = (...args) => { handler = args[args.length - 1]; };
	const driverInstructions = { annotateDashboardRows() {}, annotateDriverLoads() {}, afterDropzone() { return null; } };
	const scope = makeScope({ app: { get: register, put: register, post: register, delete: register }, require: realRequire, driverInstructions, ...stubs });
	new Function("__scope", `with (__scope) { ${src} }`)(scope);
	if (typeof handler !== "function") throw new Error(`no handler registered by ${head}`);
	return handler;
}
function liftFunction(name, stubs) {
	if (!topLevelFunction(name)) throw new Error(`no top-level function ${name}() in server.js`);
	return makeScope({ require: realRequire, ...stubs })[name];
}
const session = (role, extra = {}) => ({ user: { id: role === "Super Admin" ? 1 : 2, role, username: role === "Super Admin" ? "super_admin" : "u2", ...extra } });
const quietConsole = (errors) => ({ error: (...a) => errors.push(a.join(" ")), log() {}, warn() {}, info() {} });
function fakeIo(emitted) {
	const emitter = (room, except) => ({
		emit: (event, payload) => emitted.push({ room, except, event, payload }),
		except: (other) => emitter(room, other),
	});
	return { to: (room) => emitter(room, null) };
}
// A fake Google Sheets client over `rows` (header row first): reads by range,
// records batchUpdate and update writes into the rows.
function fakeSheets(rows, { failReads = false } = {}) {
	const writes = [];
	const rowAt = (range) => {
		const m = /!(\d+):\1$/.exec(range || "");
		return m ? (rows[Number(m[1]) - 1] || []) : null;
	};
	const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
	const write = (range, value) => {
		const m = /!([A-Z]+)(\d+)$/.exec(range);
		if (!m) return;
		const r = rows[Number(m[2]) - 1];
		const i = colIndex(m[1]);
		while (r.length <= i) r.push("");
		r[i] = value;
	};
	const values = {
		get: async ({ range }) => {
			if (failReads) throw new Error("made-up read failure");
			if (/!1:1$/.test(range || "")) return { data: { values: [rows[0].slice()] } };
			const r = rowAt(range);
			return { data: { values: r ? [r.slice()] : rows.map((x) => x.slice()) } };
		},
		batchGet: async ({ ranges }) => ({ data: { valueRanges: ranges.map((x) => ({ values: rowAt(x) ? [rowAt(x).slice()] : rows.map((y) => y.slice()) })) } }),
		batchUpdate: async ({ requestBody }) => {
			const data = requestBody.data || [];
			for (const d of data) write(d.range, d.values[0][0]);
			writes.push(data.map((d) => d.range));
			return { data: { totalUpdatedCells: data.length } };
		},
		update: async ({ range, requestBody }) => { write(range, requestBody.values[0][0]); writes.push([range]); return { data: {} }; },
	};
	return { getSheets: async () => ({ spreadsheets: { values } }), writes };
}

// ------------------------------------------------------------------ the fixture
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info",
	"Pickup Appointment", "Pickup Address", "Drop-off Info", "Drop-off Appointment",
	"Drop-off Address", "Job Status", "Phase of Progress", "Carrier Stage", "  Payment  ",
	"Broker Contact Name", "Phone Number", "Email", "Location Link", "Documents",
	"Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output", "",
];
const WITHHELD = "[contact withheld]";
const TD = "Test Driver";
const OD = "Other Driver";
const ROW = (o) => ({
	Driver: TD, "Pickup Address": "100 Main St, Dallas, TX 75201", "Drop-off Address": "200 Oak Ave, Tulsa, OK 74103",
	"Pickup Appointment": "1/14/2030 08:00", "Drop-off Appointment": "1/15/2030 09:00", "Assigned Date": "2030-01-14",
	Truck: "92", "Owner ID": "5", "  Payment  ": "$1,000.00", Details: "Dry van", ...o,
});
// N1 a normal load; H1 a phone inside the ID; H2 the row's own broker phone as
// bare digits; H4 an ID that is only contact (an email); H3 a second ID that
// reads as H1 does once withheld.
const N1 = ROW({ "Load ID": "80000031", "Job Status": "Assigned" });
const H1 = ROW({ "Load ID": "QA-555-010-0161", "Job Status": "In Transit", "Phone Number": "555-010-0170", Email: "agent.h1@example.invalid" });
const H2 = ROW({ "Load ID": "5550100163", "Job Status": "Dispatched", "Phone Number": "555-010-0163" });
const H4 = ROW({ "Load ID": "agent.h4@example.invalid", Driver: OD, "Job Status": "Unassigned" });
const H3 = ROW({ "Load ID": "QA-555-010-0162", Driver: OD, "Job Status": "Dispatched" });
// A real Load ID with a key's shape: it is that load's ID, never a key.
const KEY_SHAPED_ID = "wk-AAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KS = ROW({ "Load ID": KEY_SHAPED_ID, Driver: OD, "Job Status": "Assigned" });
const FIX = [N1, H1, H2, H4, H3, KS]; // rows 2..7
const ROWNO = (o) => FIX.indexOf(o) + 2;
const cells = (o) => HEADERS.map((h) => (o[h] == null ? "" : String(o[h])));
const rowObject = (o, rowIndex) => {
	const r = {};
	HEADERS.forEach((h) => { r[h] = o[h] == null ? "" : String(o[h]); });
	if (rowIndex) r._rowIndex = rowIndex;
	return r;
};
const SHEET = (fix = FIX) => [HEADERS.slice(), ...fix.map(cells)];
const JT = { headers: HEADERS.slice(), data: FIX.map((o, i) => rowObject(o, i + 2)) };
const WITHHELD_RE = /broker|phone|e-?mail|contact|\bfax\b|mobile|\bcell\b/i;
const INDEX = bc.buildShownLoadIdIndex(HEADERS, JT.data, { withheldRe: WITHHELD_RE });
const KEYS = keyLib ? keyLib.createLoadKeys({ secret: Buffer.from("made-up-runner-secret-routes") }) : { keyFor: () => "" };
const K1 = KEYS.keyFor(H1["Load ID"]);
const K2 = KEYS.keyFor(H2["Load ID"]);
const K4 = KEYS.keyFor(H4["Load ID"]);
const K3 = KEYS.keyFor(H3["Load ID"]);
const KN = KEYS.keyFor(N1["Load ID"]);
const STRANGER = keyLib ? keyLib.createLoadKeys({ secret: Buffer.from("another-process") }).keyFor(H1["Load ID"]) : "wk-BBBBBBBBBBBBBBBBBBBBBBBBBBB";
// Every withheld ID as text (any letter case) and as the digits of its phone.
const HIDDEN = ["qa-555-010-0161", "5550100161", "5550100163", "agent.h4@example.invalid", "qa-555-010-0162", "5550100162"];
function hiddenIn(body, list = HIDDEN) {
	const text = typeof body === "string" ? body : JSON.stringify(body == null ? null : body);
	const low = text.toLowerCase();
	const digits = text.replace(/[^0-9]/g, "");
	return list.filter((p) => (/^\d+$/.test(p) ? digits.includes(p) : low.includes(p)));
}

// The stubs every lifted piece shares: the flag on, the runner's keys, the read.
const keyStubs = (state, errors, more = {}) => ({
	WITHHELD_LOAD_REFS_ENABLED: true, WITHHELD_LOAD_KEYS: KEYS, WITHHELD_LOAD_KEY_STATE: state,
	getJobTrackingCached: async () => JT, currentShownLoadIdIndex: () => INDEX, normalizeLoadId,
	console: quietConsole(errors), ...more,
});
// The request through the shipped gate, then the handler, with one response.
async function call(gate, handler, req) {
	const out = { code: 200, body: null, nexted: false };
	const res = {
		headersSent: false,
		status(c) { out.code = c; return this; },
		json(b) { out.body = b; return this; },
		send(b) { out.body = b; return this; },
		setHeader() {}, set() { return this; }, on() {}, end() { return this; },
	};
	const full = { method: "GET", query: {}, params: {}, body: {}, headers: {}, path: "/api/test", ...req };
	await gate(full, res, () => { out.nexted = true; });
	if (out.nexted && handler) await handler(full, res);
	return { ...out, req: full };
}

const sections = [];
function section(name, fn) { sections.push([name, fn]); }

// ================================================================== §1 the routes
section("§1 every route that reads a load ID reads a key through loadIdFor()", async () => {
	const ROUTE_RE = /\napp\.(get|post|put|patch|delete)\("([^"]+)",([^\n]*)/g;
	const reading = [];
	for (const m of SRC.matchAll(ROUTE_RE)) {
		const head = `app.${m[1]}("${m[2]}",${m[3]}`;
		const src = extractRoute(head);
		const mids = (m[3].match(/\b[a-zA-Z]+(?=,)/g) || []).map((n) => topLevelFunction(n) || "").join("\n");
		const body = `${src}\n${mids}`;
		const reads = /:loadId\b/.test(m[2])
			|| /req\.(body|query)\.(loadId|load_id)\b/.test(body)
			|| /\{[^}]*\b(loadId|load_id)\b[^}]*\}\s*=\s*req\.(body|query)/.test(body)
			|| /\bbody\.(loadId|load_id)\b/.test(body)
			|| /x-message-load-id/i.test(body);
		if (!reads) continue;
		reading.push({ route: `${m[1].toUpperCase()} ${m[2]}`, resolved: /\b(loadIdFor|messageLoadIdFor)\(req,/.test(body) });
	}
	// Routes that take a load ID but need no key, and why.
	const EXEMPT = {
		"GET /api/public/track/:loadId": "public: the gate never reads /api/public",
		"PUT /api/load-ratings/:loadId": "Super Admin only (served every ID as stored)",
		"DELETE /api/loads/:loadId": "Super Admin only",
		"GET /api/loads/:loadId/invoice-draft": "Super Admin only",
		"GET /api/loads/:loadId/invoice-lines": "Super Admin only",
		"POST /api/loads/:loadId/invoice-lines": "Super Admin only",
		"POST /api/loads/:loadId/invoice-lines/:id/void": "Super Admin only",
		"POST /api/dispatch/cancel": "Super Admin only",
		"POST /api/n8n/job": "n8n, on its secret, no session",
		"POST /api/n8n/keep-stored-values": "n8n, on its secret, no session",
		"POST /api/n8n/load-distance": "n8n, on its secret, no session",
	};
	const RESOLVED = [
		"GET /api/load-ratings/:loadId", "PUT /api/loads/:loadId/status-override", "GET /api/loads/:loadId/status-history",
		"GET /api/documents/:loadId", "GET /api/load/:loadId", "PUT /api/load/:loadId", "GET /api/loads/:loadId/haul",
		"GET /api/geocode/load/:loadId", "POST /api/dispatch", "POST /api/dispatch/reassign", "POST /api/driver/respond",
		"PUT /api/driver/status", "POST /api/messages", "POST /api/messages/voice", "GET /api/messages/:driverName",
		"POST /api/expenses", "POST /api/documents/upload", "GET /api/locations/trail", "GET /api/fuel/trip-plan",
		"GET /api/poi/fuel-stops", "POST /api/loads/pickup-confirmed",
	];
	const found = reading.map((r) => r.route);
	const listed = [...RESOLVED, ...Object.keys(EXEMPT)];
	check("§1 the routes that read a load ID are exactly the listed ones (a new one must be listed or resolve keys): unlisted, then gone",
		[found.filter((r) => !listed.includes(r)).sort(), listed.filter((r) => !found.includes(r)).sort()], [[], []]);
	check("§1 every listed route reads its load ID through loadIdFor() or messageLoadIdFor()",
		reading.filter((r) => RESOLVED.includes(r.route) && !r.resolved).map((r) => r.route), []);
	check("§1 no exempt route resolves keys (each is Super Admin only, public or n8n)",
		reading.filter((r) => EXEMPT[r.route] && r.resolved).map((r) => r.route), []);
	const lines = SRC.split("\n");
	const at = (re) => lines.findIndex((l) => re.test(l));
	const gateAt = at(/^app\.use\(withheldLoadKeyGate\);/);
	const firstApi = at(/^app\.(get|post|put|patch|delete)\("\/api/);
	check("§1 the gate is mounted once, below the session and the password-change refresh, above every route",
		[lines.filter((l) => /^app\.use\(withheldLoadKeyGate\)/.test(l)).length, gateAt > at(/^app\.use\(refreshPasswordChangeFlag\);/), gateAt >= 0 && gateAt < firstApi],
		[1, true, true]);
	check("§1 the flag is off unless set (WITHHELD_LOAD_REFS_ENABLED reads true/1/yes/on only)",
		/^const WITHHELD_LOAD_REFS_ENABLED = \/\^\(true\|1\|yes\|on\)\$\/i\.test\(String\(process\.env\.WITHHELD_LOAD_REFS_ENABLED \?\? ""\)\.trim\(\)\);$/m.test(SRC), true);
});

// ================================================================== §2 the gate
section("§2 the gate reads a key and leaves the request as sent", async () => {
	const errors = [];
	const state = { replyGuardHits: 0 };
	const gate = liftFunction("withheldLoadKeyGate", keyStubs(state, errors));
	const D = session("Dispatcher");
	const p = await call(gate, null, { path: `/api/load/${K1}`, params: {}, session: D });
	check("§2 a key in the path: its load (stored ID, shown text, drivers), the path as sent",
		[p.nexted, p.req.withheldLoad && p.req.withheldLoad.raw, p.req.withheldLoad && p.req.withheldLoad.shown,
			p.req.withheldLoad && [...p.req.withheldLoad.drivers], p.req.path],
		[true, "QA-555-010-0161", `QA-${WITHHELD}`, ["test driver"], `/api/load/${K1}`]);
	const q = await call(gate, null, { path: "/api/fuel/trip-plan", query: { loadId: K2 }, session: D });
	const b = await call(gate, null, { method: "POST", path: "/api/dispatch", body: { loadId: K4, rowIndex: 5 }, session: D });
	const b2 = await call(gate, null, { method: "POST", path: "/api/expenses", body: { load_id: K1 }, session: D });
	const h = await call(gate, null, { method: "POST", path: "/api/messages/voice", headers: { "x-message-load-id": K3 }, session: D });
	check("§2 a key in the query's loadId, the body's loadId or load_id, or X-Message-Load-Id: its load, the field as sent",
		[q.req.withheldLoad && q.req.withheldLoad.raw, q.req.query.loadId === K2, b.req.withheldLoad && b.req.withheldLoad.raw, b.req.body.loadId === K4,
			b2.req.withheldLoad && b2.req.withheldLoad.raw, h.req.withheldLoad && h.req.withheldLoad.raw],
		["5550100163", true, "agent.h4@example.invalid", true, "QA-555-010-0161", "QA-555-010-0162"]);
	const unknownBody = await call(gate, null, { method: "POST", path: "/api/dispatch", body: { loadId: STRANGER }, session: D });
	const unknownPath = await call(gate, null, { path: `/api/load/${STRANGER}`, session: D });
	const normalKey = await call(gate, null, { path: `/api/load/${KN}`, session: D });
	const two = await call(gate, null, { path: `/api/load/${K1}`, query: { loadId: K2 }, session: D });
	check("§2 an unknown key (another process's, a normal load's, or two loads at once): 404 LOAD_KEY_UNKNOWN before any handler",
		[unknownBody, unknownPath, normalKey, two].map((r) => [r.code, r.body && r.body.code, r.nexted]),
		[[404, "LOAD_KEY_UNKNOWN", false], [404, "LOAD_KEY_UNKNOWN", false], [404, "LOAD_KEY_UNKNOWN", false], [404, "LOAD_KEY_UNKNOWN", false]]);
	check("§2 the 404 names no load", hiddenIn([unknownBody.body, unknownPath.body]), []);
	const other = await call(gate, null, { method: "POST", path: "/api/messages", body: { message: K1, note: K2 }, session: D });
	const pub = await call(gate, null, { path: `/api/public/track/${K1}`, session: D });
	const real = await call(gate, null, { path: `/api/load/${KEY_SHAPED_ID}`, session: D });
	check("§2 key-shaped text in another field, a /api/public path, a real Load ID with a key's shape: passed on, nothing read",
		[other, pub, real].map((r) => [r.nexted, r.req.withheldLoad === undefined]), [[true, true], [true, true], [true, true]]);
	const roles = [];
	for (const role of ["Super Admin", "Driver", "Investor"]) {
		const r = await call(gate, null, { path: `/api/load/${K1}`, session: session(role, { driverName: TD }) });
		roles.push([role, r.nexted, r.req.withheldLoad === undefined]);
	}
	check("§2 a Super Admin, a Driver or an Investor naming a key: passed on, never read (keys are for Dispatchers)",
		roles, [["Super Admin", true, true], ["Driver", true, true], ["Investor", true, true]]);
	const off = liftFunction("withheldLoadKeyGate", keyStubs(state, errors, { WITHHELD_LOAD_REFS_ENABLED: false }));
	const valueOff = liftFunction("withheldLoadKeyGate", keyStubs(state, errors, { BROKER_CONTACT_VALUE_REDACTION_ENABLED: false }));
	const flagged = await call(gate, null, { path: `/api/load/${STRANGER}`, session: session("Dispatcher", { mustChangePassword: true }) });
	const signedOut = await call(gate, null, { path: `/api/load/${STRANGER}`, session: {} });
	check("§2 the flag off, value redaction off, a forced password change, signed out: passed on, nothing read",
		[await call(off, null, { path: `/api/load/${STRANGER}`, session: D }), await call(valueOff, null, { path: `/api/load/${STRANGER}`, session: D }), flagged, signedOut]
			.map((r) => [r.code, r.nexted, r.req.withheldLoad === undefined]),
		[[200, true, true], [200, true, true], [200, true, true], [200, true, true]]);
	const down = liftFunction("withheldLoadKeyGate", keyStubs(state, errors, { getJobTrackingCached: async () => { throw new Error("made-up outage"); } }));
	const r503 = await call(down, null, { path: `/api/load/${K1}`, session: D });
	check("§2 Job Tracking unreadable: 503 LOAD_KEY_UNVERIFIED (retryable), no handler", [r503.code, r503.body && r503.body.code, r503.nexted], [503, "LOAD_KEY_UNVERIFIED", false]);
});

// ================================================================== §3 the guard
section("§3 the reply guard the gate installs", async () => {
	const errors = [];
	const state = { replyGuardHits: 0 };
	const gate = liftFunction("withheldLoadKeyGate", keyStubs(state, errors));
	const leaky = (req, res) => res.status(409).json({ error: `Load ${req.withheldLoad.raw} is held; call 555.010.0161`, code: "MADE_UP", rowIndex: 3, lat: 35.5550100161 });
	const r = await call(gate, leaky, { method: "PUT", path: `/api/load/${K1}`, route: { path: "/api/load/:loadId" }, session: session("Dispatcher") });
	check("§3 a leak: status kept, the ID and its phone swapped, the rest kept, the hit counted, the route logged (no ID)",
		[r.code, r.body, state.replyGuardHits, errors.length === 1 && /reply guard.*PUT \/api\/load\/:loadId/.test(errors[0]), hiddenIn(errors)],
		[409, { error: `Load QA-${WITHHELD} is held; call ${WITHHELD}`, code: "MADE_UP", rowIndex: 3, lat: 35.5550100161 }, 2, true, []]);
	const text = await call(gate, (req, res) => res.send(`ok ${req.withheldLoad.raw}`), { path: `/api/load/${K1}`, session: session("Dispatcher") });
	const buf = Buffer.from("QA-555-010-0161");
	const bin = await call(gate, (req, res) => res.send(buf), { path: `/api/load/${K1}`, session: session("Dispatcher") });
	check("§3 a string res.send is swept; a Buffer is not touched", [text.body, bin.body === buf], [`ok QA-${WITHHELD}`, true]);
	const clean = await call(gate, (req, res) => res.json({ success: true, id: 7 }), { path: `/api/load/${K1}`, session: session("Dispatcher") });
	check("§3 a clean reply is passed as is", clean.body, { success: true, id: 7 });
});

// ================================================================== §4 keys served
section("§4 keys are served beside each withheld ID, to a Dispatcher only", async () => {
	const errors = [];
	const state = { replyGuardHits: 0 };
	const Database = require("better-sqlite3");
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, assigned_driver TEXT DEFAULT '');
		CREATE TABLE ratecon_load_aliases (alias TEXT PRIMARY KEY, load_id TEXT NOT NULL, source TEXT DEFAULT '', drive_file_id TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, order_number TEXT, overrides_json TEXT DEFAULT '');`);
	const dashStubs = (more = {}) => keyStubs(state, errors, {
		requireRole: () => null, getDeletedLoadIds: () => new Set(),
		getCarrierDBFromSQLite: () => ({ headers: ["Driver", "Truck", "Status"], data: [{ Driver: TD, Truck: "92", Status: "active" }, { Driver: OD, Truck: "93", Status: "active" }] }),
		appDay: () => "2030-01-15", db, findTruckForDriver: () => null, ...more,
	});
	const head = 'app.get("/api/dashboard", requireRole("Super Admin", "Dispatcher"), async (req, res) => {';
	const run = async (role, more) => {
		const out = { code: 200, body: null };
		const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; }, set() { return this; }, setHeader() {} };
		await liftHandler(head, dashStubs(more))({ query: {}, params: {}, body: {}, headers: {}, session: session(role) }, res);
		return out;
	};
	const disp = await run("Dispatcher");
	const rows = (r) => [...((r.body || {}).unassignedJobs || []), ...((r.body || {}).activeJobs || []), ...((r.body || {}).completedJobs || [])];
	const keyed = rows(disp).filter((x) => x._loadKey).map((x) => [x["Load ID"], x._loadKey]).sort();
	// An ID that is only contact is served blank (the client shows it withheld).
	check("§4 dashboard, Dispatcher: each row with a withheld ID carries its key, and no other row does",
		[disp.code, keyed], [200, [["", K4], [`QA-${WITHHELD}`, K1], [`QA-${WITHHELD}`, K3], ["", K2]].sort()]);
	const fleet = ((disp.body || {}).fleet || []).find((f) => f.Driver === TD) || {};
	check("§4 dashboard, Dispatcher: the Fleet entry's keys sit beside its chips, position for position",
		[fleet.CurrentLoad, fleet.CurrentLoadKey, fleet.QueuedLoadIds, fleet.QueuedLoadKeys],
		[`QA-${WITHHELD}`, K1, fleet.QueuedLoadIds, (fleet.QueuedLoadIds || []).map((id) => (id === "80000031" ? "" : id === WITHHELD ? K2 : "?"))]);
	const queue = (((disp.body || {}).driverQueues || {})["test driver"]) || [];
	check("§4 dashboard, Dispatcher: driverQueues carries load_key beside a withheld load_id only",
		queue.map((x) => [x.load_id, x.load_key || ""]).sort(), queue.map((x) => [x.load_id, x.load_id === "80000031" ? "" : K2]).sort());
	check("§4 dashboard, Dispatcher: no withheld ID anywhere in the answer", hiddenIn(disp.body), []);
	const admin = await run("Super Admin");
	const off = await run("Dispatcher", { WITHHELD_LOAD_REFS_ENABLED: false });
	const anyKey = (body) => {
		const text = JSON.stringify(body || {});
		return [K1, K2, K3, K4].some((k) => k && text.includes(k)) || /_loadKey|LoadKey|load_key/.test(text);
	};
	check("§4 dashboard: a Super Admin and, with the flag off, a Dispatcher get no key anywhere",
		[admin.code, anyKey(admin.body), off.code, anyKey(off.body)], [200, false, 200, false]);
	// The load detail.
	const sheet = fakeSheets(SHEET());
	const detail = liftHandler('app.get("/api/load/:loadId", requireRole("Super Admin", "Dispatcher"), async (req, res) => {', keyStubs(state, errors, {
		requireRole: () => null, getSheets: sheet.getSheets, SPREADSHEET_ID: "sheet-under-test",
	}));
	const gate = liftFunction("withheldLoadKeyGate", keyStubs(state, errors));
	const d = await call(gate, detail, { path: `/api/load/${K1}`, params: { loadId: K1 }, session: session("Dispatcher") });
	check("§4 load detail by its key: 200, the ID as shown, its key, no hit", [d.code, d.body && d.body.load && d.body.load["Load ID"], d.body && d.body.load && d.body.load._loadKey, state.replyGuardHits, hiddenIn(d.body)],
		[200, `QA-${WITHHELD}`, K1, 0, []]);
	// The Driver page never carries a key (sanitizeBrokerColumns() is shared with it).
	const driverPage = liftHandler('app.get("/api/driver/:driverName", requireRole("Super Admin", "Driver"), async (req, res) => {', keyStubs(state, errors, {
		requireRole: () => null, getDeletedLoadIds: () => new Set(), db: { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({}) }) },
	}));
	const out = { code: 200, body: null };
	const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; }, set() { return this; }, setHeader() {} };
	try {
		await driverPage({ query: {}, params: { driverName: TD }, body: {}, headers: {}, session: session("Driver", { driverName: TD, driver_name: TD }) }, res);
	} catch (e) { errors.push(`driver page: ${e.message}`); }
	check("§4 the Driver page: no key on any of his loads", JSON.stringify(out.body || {}).includes("_loadKey"), false);
	// A stored notice naming a withheld load carries its key in the metadata.
	const notice = liftFunction("withNoticeLoadKey", keyStubs(state, errors));
	const stored = { id: 1, type: "load-assigned", title: "Assigned Test Driver to Load QA-555-010-0161", body: "", metadata: JSON.stringify({ loadId: "QA-555-010-0161", rowIndex: 3 }) };
	const served = { ...stored, title: `Assigned Test Driver to Load QA-${WITHHELD}`, metadata: JSON.stringify({ loadId: `QA-${WITHHELD}`, rowIndex: 3 }) };
	check("§4 a stored notice: metadata.loadKey beside the shown loadId for a Dispatcher; none for a Super Admin or a normal load",
		[JSON.parse(notice(session("Dispatcher") && { session: session("Dispatcher") }, stored, served, INDEX).metadata),
			notice({ session: session("Super Admin") }, stored, served, INDEX).metadata,
			notice({ session: session("Dispatcher") }, { ...stored, metadata: JSON.stringify({ loadId: "80000031" }) }, { ...served, metadata: JSON.stringify({ loadId: "80000031" }) }, INDEX).metadata],
		[{ loadId: `QA-${WITHHELD}`, rowIndex: 3, loadKey: K1 }, served.metadata, JSON.stringify({ loadId: "80000031" })]);
	check("§4 no error logged", errors.filter((e) => !/driver page/.test(e)), []);
});

// ================================================================== §5 the routes, by key
// POST /api/dispatch and its siblings: I/O stubbed, guards shipped.
function dispatchStubs(state, errors, sheet, more = {}) {
	return keyStubs(state, errors, {
		requireRole: () => null, getSheets: sheet.getSheets, SPREADSHEET_ID: "sheet-under-test",
		db: { prepare: () => ({ get: () => undefined, run: () => ({ changes: 0 }), all: () => [] }) },
		findTruckForDriverStamp: () => null, dispatchWriteBlocker: () => null, tripDayLockCover: () => null,
		DRIVER_AVAILABILITY_ENABLED: false, insertNotification: { run: () => ({ lastInsertRowid: 1 }) },
		insertDispatchNotification: { run: () => ({ lastInsertRowid: 1 }) }, io: fakeIo([]), emitDispatchNotice: () => {},
		emitLoadEventToDispatch: () => {}, logAudit: () => {}, logAuditRefusal: () => {}, recordPeriodRefusal: () => {},
		recordStatusChange: () => {}, notifyChange: () => {}, jtCacheInvalidate: () => {}, ...more,
	});
}
section("§5 POST /api/dispatch and /api/dispatch/reassign by key: every branch acts on the stored ID and names it as shown", async () => {
	const errors = [];
	const state = { replyGuardHits: 0 };
	const gate = liftFunction("withheldLoadKeyGate", keyStubs(state, errors));
	const head = 'app.post("/api/dispatch", requireRole("Super Admin", "Dispatcher"), async (req, res) => {';
	const D = session("Dispatcher");
	const send = async (fix, body, more = {}) => {
		const sheet = fakeSheets(SHEET(fix), more.sheet || {});
		const handler = liftHandler(head, dispatchStubs(state, errors, sheet, more.stubs || {}));
		const r = await call(gate, handler, { method: "POST", path: "/api/dispatch", body, session: D });
		return { ...r, rows: SHEET(fix), sheet };
	};
	const ok = await send(FIX, { loadId: K1, rowIndex: ROWNO(H1), driver: "New Driver" });
	check("§5 dispatch by key: 200, the driver written onto the load's own row", [ok.code, ok.body, ok.sheet.writes.length > 0], [200, { success: true }, true]);
	const gone = await send(FIX.filter((o) => o !== H1), { loadId: K1, rowIndex: ROWNO(H1), driver: "New Driver" });
	const dup = await send([...FIX, { ...H1, Driver: OD }], { loadId: K1, rowIndex: ROWNO(H1), driver: "New Driver" });
	const moved = await send(FIX, { loadId: K1, rowIndex: ROWNO(N1), driver: "New Driver" });
	const unread = await send(FIX, { loadId: K1, rowIndex: ROWNO(H1), driver: "New Driver" }, { sheet: { failReads: true } });
	const closed = await send(FIX, { loadId: K1, rowIndex: ROWNO(H1), driver: "New Driver" }, { stubs: { dispatchWriteBlocker: () => ({ code: "PERIOD_FINALIZED", periods: ["2030-01"] }) } });
	const all = [gone, dup, moved, unread, closed];
	check("§5 dispatch by key, refused: LOAD_NOT_ON_SHEET, AMBIGUOUS_LOAD, ROW_LOAD_MISMATCH, PERIOD_UNRESOLVED, PERIOD_FINALIZED",
		all.map((r) => [r.code, r.body && r.body.code]),
		[[404, "LOAD_NOT_ON_SHEET"], [409, "AMBIGUOUS_LOAD"], [409, "ROW_LOAD_MISMATCH"], [409, "PERIOD_UNRESOLVED"], [409, "PERIOD_FINALIZED"]]);
	check("§5 dispatch by key, refused: each names the load as shown (where it names it)",
		[gone.body.error.includes(`Load QA-${WITHHELD} is not on Job Tracking`), dup.body.error.includes(`Load QA-${WITHHELD} appears on 2 rows`),
			moved.body.error.includes(`does not hold load QA-${WITHHELD}`), unread.body.error.includes(`load QA-${WITHHELD} cannot be attributed`),
			closed.body.error.includes(`load QA-${WITHHELD} would restate`)],
		[true, true, true, true, true]);
	check("§5 dispatch by key: no reply holds the stored ID, and the reply guard counted no hit", [hiddenIn([ok.body, ...all.map((r) => r.body)]), state.replyGuardHits], [[], 0]);
	const reassign = liftHandler('app.post("/api/dispatch/reassign", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
		dispatchStubs(state, errors, fakeSheets(SHEET())));
	const rOk = await call(gate, reassign, { method: "POST", path: "/api/dispatch/reassign", body: { loadId: K3, rowIndex: ROWNO(H3), newDriver: TD, oldDriver: OD }, session: D });
	const rMoved = await call(gate, liftHandler('app.post("/api/dispatch/reassign", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
		dispatchStubs(state, errors, fakeSheets(SHEET()))), { method: "POST", path: "/api/dispatch/reassign", body: { loadId: K3, rowIndex: ROWNO(N1), newDriver: TD }, session: D });
	check("§5 reassign by key: 200 on its own row; ROW_LOAD_MISMATCH elsewhere naming it as shown; no hit",
		[rOk.code, rMoved.code, rMoved.body && rMoved.body.code, String(rMoved.body && rMoved.body.error).includes(`load QA-${WITHHELD}`), hiddenIn([rOk.body, rMoved.body]), state.replyGuardHits],
		[200, 409, "ROW_LOAD_MISMATCH", true, [], 0]);
	check("§5 dispatch: no error logged (beside the made-up read failure)", errors.filter((e) => !/made-up read failure/.test(e)), []);
});

section("§5 PUT /api/loads/:loadId/status-override by key", async () => {
	const errors = [];
	const state = { replyGuardHits: 0 };
	const gate = liftFunction("withheldLoadKeyGate", keyStubs(state, errors));
	const head = 'app.put("/api/loads/:loadId/status-override", requireRole("Super Admin", "Dispatcher"), async (req, res) => {';
	const run = async (fix, key, more = {}) => {
		const sheet = fakeSheets(SHEET(fix));
		const handler = liftHandler(head, dispatchStubs(state, errors, sheet, { statusOverrideBlocker: () => null, ...more }));
		return call(gate, handler, { method: "PUT", path: `/api/loads/${key}/status-override`, params: { loadId: key }, body: { newStatus: "In Transit", reason: "made-up reason" }, session: session("Dispatcher") });
	};
	const ok = await run(FIX, K2);
	const gone = await run(FIX.filter((o) => o !== H2), K2);
	// statusOverrideBlocker() answers AMBIGUOUS_LOAD for copies it can't tell apart.
	const dup = await run([...FIX, { ...H2 }], K2, { statusOverrideBlocker: () => ({ code: "AMBIGUOUS_LOAD", periods: [] }) });
	const closed = await run(FIX, K2, { statusOverrideBlocker: () => ({ code: "PERIOD_FINALIZED", periods: ["2030-01"] }) });
	const unresolved = await run(FIX, K2, { statusOverrideBlocker: () => ({ code: "PERIOD_UNRESOLVED", periods: [] }) });
	check("§5 override by key: 200; the 404; duplicates 409; PERIOD_FINALIZED; PERIOD_UNRESOLVED",
		[ok, gone, dup, closed, unresolved].map((r) => [r.code, (r.body && r.body.code) || (r.body && r.body.success ? "ok" : r.body && r.body.error && "error")]),
		[[200, "ok"], [404, "error"], [409, "AMBIGUOUS_LOAD"], [409, "PERIOD_FINALIZED"], [409, "PERIOD_UNRESOLVED"]]);
	check("§5 override by key: the 404 and the refusals name the load as shown",
		[gone.body.error, String(dup.body.error).startsWith(`Load ${WITHHELD} appears on 2 rows`), String(closed.body.error).includes(`load ${WITHHELD} would restate`), String(unresolved.body.error).startsWith(`Load ${WITHHELD} cannot be attributed`)],
		[`Load ${WITHHELD} not found`, true, true, true]);
	check("§5 override by key: no reply holds the stored ID, no hit", [hiddenIn([ok.body, gone.body, dup.body, closed.body, unresolved.body]), state.replyGuardHits], [[], 0]);
	check("§5 override: no error logged", errors, []);
});

section("§5 the load's own pages by key: detail 404, status history, documents (closed), POD upload, receipt", async () => {
	const errors = [];
	const state = { replyGuardHits: 0 };
	const gate = liftFunction("withheldLoadKeyGate", keyStubs(state, errors));
	const D = session("Dispatcher");
	const detail = liftHandler('app.get("/api/load/:loadId", requireRole("Super Admin", "Dispatcher"), async (req, res) => {', keyStubs(state, errors, {
		requireRole: () => null, getSheets: fakeSheets(SHEET(FIX.filter((o) => o !== H1))).getSheets, SPREADSHEET_ID: "sheet-under-test",
	}));
	const miss = await call(gate, detail, { path: `/api/load/${K1}`, params: { loadId: K1 }, session: D });
	check("§5 load detail by key, the load gone from the sheet: 404 naming it as shown", [miss.code, miss.body], [404, { error: `Load QA-${WITHHELD} not found` }]);
	const asked = [];
	const history = liftHandler('app.get("/api/loads/:loadId/status-history", requireAuth, async (req, res) => {', keyStubs(state, errors, {
		requireAuth: null, computeStatusPhases: (id) => { asked.push(id); return [{ status: "Dispatched", source: "dispatch" }]; },
	}));
	const h = await call(gate, history, { path: `/api/loads/${K1}/status-history`, params: { loadId: K1 }, session: D });
	check("§5 status history by key: the stored load's phases, the answer naming it as shown, no hit",
		[h.code, asked, h.body && h.body.loadId, state.replyGuardHits], [200, ["QA-555-010-0161"], `QA-${WITHHELD}`, 0]);
	// Documents: rows whose file names and links begin with the stored ID.
	const Database = require("better-sqlite3");
	const db = new Database(":memory:");
	const ddl = /CREATE TABLE IF NOT EXISTS documents \([\s\S]*?\n\t\)/.exec(SRC);
	db.exec(ddl[0]);
	for (const m of SRC.matchAll(/ALTER TABLE documents ADD COLUMN ([^"`;]+)/g)) { try { db.exec(`ALTER TABLE documents ADD COLUMN ${m[1]}`); } catch { /* there */ } }
	db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_url, ocr_text) VALUES (?, ?, ?, ?, ?, ?)")
		.run("QA-555-010-0161", TD, "POD", "QA-555-010-0161_POD_1.pdf", "/uploads/QA-555-010-0161_POD_1.pdf", "Signed. Questions: 555-010-0170");
	db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_url, ocr_text) VALUES (?, ?, ?, ?, ?, ?)")
		.run("80000031", TD, "POD", "80000031_POD_1.pdf", "/uploads/80000031_POD_1.pdf", "");
	const docs = (role) => liftHandler('app.get("/api/documents/:loadId", requireRole("Super Admin", "Dispatcher", "Driver"), async (req, res) => {', keyStubs(state, errors, {
		requireRole: () => null, db, loadBelongsToDriver: async () => true,
	}));
	const closed = await call(gate, docs(), { path: `/api/documents/${K1}`, params: { loadId: K1 }, session: D });
	const normal = await call(gate, docs(), { path: "/api/documents/80000031", params: { loadId: "80000031" }, session: D });
	const admin = await call(gate, docs(), { path: "/api/documents/QA-555-010-0161", params: { loadId: "QA-555-010-0161" }, session: session("Super Admin") });
	check("§5 documents by key: listed by type and upload time only, for a Super Admin to open; no hit",
		[closed.code, (closed.body.documents || []).map((d) => Object.keys(d).sort()), closed.body.documentsWithheld, closed.body.note, hiddenIn(closed.body), state.replyGuardHits],
		[200, [["id", "type", "uploaded_at"]], true, "A Super Admin can open these documents.", [], 0]);
	check("§5 documents: a normal load as before; a Super Admin gets the withheld load's in full",
		[(normal.body.documents || [])[0] && (normal.body.documents || [])[0].file_name, normal.body.documentsWithheld, (admin.body.documents || [])[0] && (admin.body.documents || [])[0].file_name],
		["80000031_POD_1.pdf", undefined, "QA-555-010-0161_POD_1.pdf"]);
	// A POD upload by key: stored under the stored ID, the answer without its link,
	// and the POD cell's update still deferred after the answer.
	const stored = [];
	const deferred = [];
	const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 a made-up POD").toString("base64")}`;
	const upload = liftHandler('app.post("/api/documents/upload", requireRole("Super Admin", "Dispatcher", "Driver"), driverWriteLimiter, async (req, res) => {', keyStubs(state, errors, {
		requireRole: () => null, driverWriteLimiter: null, loadBelongsToDriver: async () => true,
		db: { prepare: (sql) => ({ run: (...a) => { if (/INSERT INTO documents/i.test(sql)) stored.push(a); return { lastInsertRowid: 9, changes: 1 }; }, get: () => undefined, all: () => [] }) },
		fs: { existsSync: () => true, mkdirSync() {}, writeFileSync() {} }, DATA_DIR: path.join(ROOT, "no-such-dir"),
		setImmediate: (fn) => { deferred.push(fn); }, queueReceiptOcr: () => {}, io: fakeIo([]), emitLoadEventToDispatch: () => {}, emitDispatchNotice: () => {},
		insertDispatchNotification: { run: () => ({}) }, logAudit: () => {}, notifyChange: () => {},
	}));
	const up = await call(gate, upload, { method: "POST", path: "/api/documents/upload", body: { loadId: K1, rowIndex: ROWNO(H1), docType: "POD", photoData: pdf, fileType: "document", fileName: "pod.pdf", driverName: TD }, session: D });
	check("§5 POD upload by key: 200 without its link, filed under the stored ID, the POD cell's update deferred, no hit",
		[up.code, up.body, stored.length === 1 && stored[0].includes("QA-555-010-0161"), deferred.length, state.replyGuardHits], [200, { success: true }, true, 1, 0]);
	check("§5 the load's pages: no error logged", errors, []);
});

section("§5 a message by key names the load as stored only to its own driver", async () => {
	const errors = [];
	const state = { replyGuardHits: 0 };
	const gate = liftFunction("withheldLoadKeyGate", keyStubs(state, errors));
	const sent = [];
	// The made-up Driver accounts resolveChatParties() looks the recipient up in
	// (one per fixture driver, no Investor): the users table is the route's only read.
	const ACCOUNTS = [{ id: 21, name: TD }, { id: 22, name: OD }];
	const usersDb = {
		prepare: (sql) => {
			const rows = (name) => (/role = 'Driver'/.test(sql) ? ACCOUNTS : [])
				.filter((a) => name === undefined || a.name.toLowerCase() === String(name).trim().toLowerCase())
				.map((a) => ({ id: a.id, name: a.name, driver_name: a.name }));
			return { all: (name) => rows(name), get: (name) => rows(name)[0] };
		},
	};
	const handler = liftHandler('app.post("/api/messages", requireAuth, driverWriteLimiter, (req, res) => {', keyStubs(state, errors, {
		requireAuth: null, driverWriteLimiter: null, db: usersDb, chatFiles: { chatAttachmentRefusal: () => null },
		sendChatMessage: (m) => { sent.push(m); return { id: sent.length }; },
	}));
	const D = session("Dispatcher");
	const own = await call(gate, handler, { method: "POST", path: "/api/messages", body: { to: TD, from: "Dispatch", message: "Gate code 12", loadId: K1 }, session: D });
	const other = await call(gate, handler, { method: "POST", path: "/api/messages", body: { to: OD, from: "Dispatch", message: "Heads up", loadId: K1 }, session: D });
	const plain = await call(gate, handler, { method: "POST", path: "/api/messages", body: { to: OD, from: "Dispatch", message: "Hi", loadId: "80000031" }, session: D });
	check("§5 message by key: to the load's driver as stored; to another driver as shown; a normal load as sent; no hit",
		[[own.code, other.code, plain.code], sent.map((m) => m.loadId), state.replyGuardHits],
		[[200, 200, 200], ["QA-555-010-0161", `QA-${WITHHELD}`, "80000031"], 0]);
	const voice = liftFunction("messageLoadIdFor", keyStubs(state, errors));
	check("§5 the voice note's load (X-Message-Load-Id) follows the same rule",
		[voice(own.req, K1, "test  DRIVER"), voice(own.req, K1, OD), voice({}, K1, TD)], ["QA-555-010-0161", `QA-${WITHHELD}`, K1]);
	// The voice route's own header checks (voiceNoteSendChecks()), through the
	// gate: the recipient as the chat rule resolves it, then the load by that name.
	const voiceChecks = liftFunction("voiceNoteSendChecks", keyStubs(state, errors, {
		db: { prepare: (sql) => (/FROM messages/.test(sql) ? { get: () => undefined } : usersDb.prepare(sql)) },
		voiceNoteBytesToday: () => 0, voiceNoteDiskLow: () => false, VOICE_NOTE_DAILY_BYTES: 1024, logAuditRefusal: () => {},
	}));
	const voiceTo = async (to, loadId, n) => {
		let nexted = false;
		const r = await call(gate, (req, res) => voiceChecks(req, res, () => { nexted = true; }), {
			method: "POST", path: "/api/messages/voice", session: D,
			headers: { "idempotency-key": `qa-voice-note-${n}`, "x-message-to": encodeURIComponent(to), "x-message-load-id": loadId },
		});
		return [r.code, nexted, r.req.voiceNote ? r.req.voiceNote.loadId : null];
	};
	check("§5 voice note by key: to the load's driver as stored; to another driver as shown; a normal load as sent; no hit",
		[await voiceTo(TD, K1, 1), await voiceTo(OD, K1, 2), await voiceTo(OD, "80000031", 3), state.replyGuardHits],
		[[200, true, "QA-555-010-0161"], [200, true, `QA-${WITHHELD}`], [200, true, "80000031"], 0]);
	check("§5 message by key: no error logged", errors, []);
});

section("§5 a receipt and a row save by key", async () => {
	const errors = [];
	const state = { replyGuardHits: 0 };
	const gate = liftFunction("withheldLoadKeyGate", keyStubs(state, errors));
	const D = session("Dispatcher");
	// PUT /api/data/:rowIndex on H4, whose ID is only contact (served blank): the
	// baseline's blank Load ID cannot confirm the row; the key does.
	const served = { ...rowObject(H4), "Load ID": "" };
	const save = async (body) => {
		const rows = SHEET();
		const sheet = fakeSheets(rows);
		const handler = liftHandler('app.put("/api/data/:rowIndex", requireRole("Super Admin", "Dispatcher"), async (req, res) => {', keyStubs(state, errors, {
			requireRole: () => null, getSheets: sheet.getSheets, SPREADSHEET_ID: "sheet-under-test",
			SHEET_ROW_MAX_CELLS: 20000, PERIOD_GUARDED_SHEETS: ["Job Tracking"],
			getSheetName: (req) => (req.query && req.query.sheet) || "Job Tracking",
			resolveSheetTargetForWrite: async () => ({ resolved: true, metaUnreadable: false, title: "Job Tracking", guarded: true }),
			changedGuardedCells: () => [], guardedColumnReason: () => "", validateOwnerIdCell: () => null,
			sheetRowUpdateBlocker: () => null, buildSheetUpdateAudit: (o) => o, sheetAuditWithCode: (d) => d,
			logAudit: () => {}, logAuditRefusal: () => {}, jtCacheInvalidate: () => {}, notifyChange: () => {}, recordPersonCellEdits: () => {},
		}));
		const r = await call(gate, handler, { method: "PUT", path: `/api/data/${ROWNO(H4)}`, params: { rowIndex: String(ROWNO(H4)) }, query: { sheet: "Job Tracking" }, body, session: D });
		return { ...r, rows };
	};
	const values = HEADERS.map((h) => (h === "Trailer Number" ? "TR-7" : served[h] == null ? "" : String(served[h])));
	const baseline = HEADERS.map((h) => (served[h] == null ? "" : String(served[h])));
	const without = await save({ values, baseline });
	const withKey = await save({ values, baseline, loadId: K4 });
	check("§5 row save of an ID that is only contact: refused ROW_MOVED without the key; with it, saved, the stored ID kept, no hit",
		[without.code, without.body && without.body.code, withKey.code, withKey.rows[ROWNO(H4) - 1][HEADERS.indexOf("Trailer Number")], withKey.rows[ROWNO(H4) - 1][HEADERS.indexOf("Load ID")], hiddenIn([without.body, withKey.body]), state.replyGuardHits],
		[409, "ROW_MOVED", 200, "TR-7", "agent.h4@example.invalid", [], 0]);
	const other = await save({ values, baseline, loadId: K1 });
	check("§5 row save with another load's key: still refused ROW_MOVED, naming no stored ID", [other.code, other.body && other.body.code, hiddenIn(other.body)], [409, "ROW_MOVED", []]);
	check("§5 receipt and row save: no error logged", errors, []);
});

(async () => {
	for (const [name, fn] of sections) {
		try {
			await fn();
		} catch (e) {
			fail++; failures.push(name);
			console.log(`  FAIL  ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
		}
	}
	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail) {
		console.log(`Failed:\n  - ${failures.join("\n  - ")}`);
		process.exit(1);
	}
})();
