#!/usr/bin/env node
/**
 * scripts/test-driver-page-role-gate.js — who may read GET /api/driver/:driverName.
 *
 * The route is the driver app's payload: one driver's loads, messages, expenses,
 * invoice totals, carrier-directory row and documents. It is Super Admin (any
 * driver) or the named Driver, and nothing else:
 *
 *   layer A  requireRole("Super Admin", "Driver") at the mount answers a
 *            Dispatcher or an Investor 403 "Forbidden" before the handler runs;
 *   layer B  inside the handler, every caller but Super Admin must be the named
 *            driver: normalizeDriverName() on both sides, and a blank session
 *            name is refused rather than compared.
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 the SHIPPED registration, lifted whole and executed over the real
 *      requireRole / requireAuth / normalizeDriverName / findCol and broker
 *      sanitizer: every role against its own name and another driver's name.
 *      Only the data reads are stubbed (a recording db and a canned Job
 *      Tracking), so "refused before any read" is asserted, not assumed.
 *   §2 what an admitted caller receives: a Driver's own read ships no rate
 *      columns, blanked broker contacts and no roster; Super Admin's is whole.
 *   §3 the callers the gate was sized against: only the driver app and the
 *      legacy driver page ask for this route, and both admit Driver and Super
 *      Admin only. A new caller fails here and points at the note above the route.
 *   §4 DISCRIMINATION: one mutant per layer, each required to flip.
 *
 * Pure: no server, no port, no app.db, no network, no fixtures.
 *
 * Run: node scripts/test-driver-page-role-gate.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
}
function fatal(msg) { console.error(`FAIL  ${msg}`); process.exit(1); }

// --- lifting ---------------------------------------------------------------
// A top-level `function name(` up to the first line that is exactly "}". Not a
// brace count: sanitizeBrokerContact tests `startsWith("{")`, and a brace inside
// a string literal throws a naive counter off.
function liftFn(name) {
	const a = SRC.indexOf(`\nfunction ${name}(`);
	if (a < 0) fatal(`could not locate function ${name} in server.js`);
	const b = SRC.indexOf("\n}\n", a);
	if (b < 0) fatal(`could not locate the end of function ${name} in server.js`);
	return SRC.slice(a + 1, b + 2);
}
function liftConstLine(name) {
	const m = SRC.match(new RegExp(`^const ${name} = .*;$`, "m"));
	if (!m) fatal(`could not locate const ${name} in server.js`);
	return m[0];
}
// Anchored at a line start: comments quote this route's registration.
function routeSource(verb, routePath) {
	const nl = SRC.indexOf(`\napp.${verb}("${routePath}"`);
	if (nl < 0) fatal(`route not found: ${verb.toUpperCase()} ${routePath}`);
	let depth = 0;
	for (let j = SRC.indexOf("(", nl + 1); j < SRC.length; j++) {
		if (SRC[j] === "(") depth++;
		else if (SRC[j] === ")") { depth--; if (depth === 0) return SRC.slice(nl + 1, j + 1); }
	}
	throw new Error(`unbalanced parens extracting ${routePath}`);
}
// Replace exactly one occurrence, or fail loudly: a mutant whose target is gone
// would run the ORIGINAL code and "pass", proving nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) fatal(`mutant target found ${n}x (expected 1): ${from.slice(0, 70)}`);
	return src.replace(from, to);
}

const ROUTE_SRC = routeSource("get", "/api/driver/:driverName");
// The guards are self-contained by design (see the CSRF note in server.js), so
// each lifts into a bare Function with nothing injected.
const requireRole = new Function(`${liftFn("requireRole")}\nreturn requireRole;`)();
const requireAuth = new Function(`${liftFn("requireAuth")}\nreturn requireAuth;`)();
const helpers = new Function([
	liftFn("normalizeDriverName"),
	liftFn("findCol"),
	liftFn("sanitizeBrokerContact"),
	liftConstLine("BROKER_WITHHELD_RE"),
	liftFn("resolveBrokerWithheldColumns"),
	liftFn("sanitizeBrokerColumns"),
	"return { normalizeDriverName, findCol, sanitizeBrokerColumns };",
].join("\n"))();

// --- fixtures --------------------------------------------------------------
const JT = {
	headers: ["Load ID", "Driver", "Job Status", "Rate", "  Payment  ", "Broker Contact Name", "Phone Number", "Pickup Address", "Drop-off Address"],
	data: [
		{ _rowIndex: 2, "Load ID": "L-100", Driver: "Deshorn King", "Job Status": "In Transit", Rate: "2000", "  Payment  ": "2000",
			"Broker Contact Name": "Pat Broker", "Phone Number": "555-0100", "Pickup Address": "1 A St", "Drop-off Address": "2 B St" },
		{ _rowIndex: 3, "Load ID": "L-200", Driver: "Shorn King", "Job Status": "Assigned", Rate: "1500", "  Payment  ": "1500",
			"Broker Contact Name": "Sam Broker", "Phone Number": "555-0200", "Pickup Address": "3 C St", "Drop-off Address": "4 D St" },
	],
};
const CARRIER = {
	headers: ["Driver", "PhoneNumber", "Email", "Address"],
	data: [
		{ Driver: "Deshorn King", PhoneNumber: "555-0111", Email: "dk@example.test", Address: "10 Home Rd" },
		{ Driver: "Shorn King", PhoneNumber: "555-0222", Email: "sk@example.test", Address: "20 Home Rd" },
	],
};
const TABLES = {
	messages: [
		{ id: 1, from: "Deshorn King", to: "dispatch", message: "on my way" },
		{ id: 2, from: "dispatch", to: "Shorn King", message: "call me" },
	],
	notifications: [{ id: 1, driver_name: "deshorn king", title: "Assigned" }],
	expenses: [
		{ id: 1, driver: "Deshorn King", amount: 120 },
		{ id: 2, driver: "Shorn King", amount: 80 },
		{ id: 3, driver: "", amount: 55 },
	],
	invoices: [
		{ id: 1, driver: "deshorn king", total_earnings: 1800 },
		{ id: 2, driver: "shorn king", total_earnings: 1500 },
		{ id: 3, driver: "", total_earnings: 999 },
	],
	trucks: [{ id: 7, unit_number: "33", assigned_driver: "Deshorn King" }],
	drivers_directory: [{ id: 11, driver_name: "Deshorn King" }, { id: 12, driver_name: "Shorn King" }],
};

// A recording db: every read is logged, and rows come back filtered by the
// bound name the way the real WHERE clauses filter them.
function makeDeps() {
	const reads = [];
	const lower = (v) => String(v == null ? "" : v).toLowerCase();
	const pick = (sql, args) => {
		const who = typeof args[0] === "string" ? args[0] : null;
		if (who === null) return [];
		if (/FROM messages/.test(sql)) return TABLES.messages.filter((m) => lower(m.from) === who || lower(m.to) === who);
		if (/FROM notifications/.test(sql)) return TABLES.notifications.filter((n) => n.driver_name === who);
		if (/FROM expenses/.test(sql)) return TABLES.expenses.filter((e) => lower(e.driver) === who);
		if (/FROM invoices/.test(sql)) return TABLES.invoices.filter((i) => lower(i.driver) === who);
		if (/FROM trucks/.test(sql)) return TABLES.trucks.filter((t) => lower(t.assigned_driver) === who);
		if (/FROM drivers_directory/.test(sql)) return TABLES.drivers_directory.filter((d) => lower(d.driver_name) === who);
		return [];
	};
	const db = {
		prepare(sql) {
			reads.push(sql);
			return { all: (...a) => pick(sql, a), get: (...a) => pick(sql, a)[0] };
		},
	};
	const deps = {
		requireRole, requireAuth, ...helpers, db,
		getJobTrackingCached: async () => { reads.push("getJobTrackingCached"); return JT; },
		liveJobTrackingView: (jt) => ({ ...jt, headers: [...jt.headers], data: jt.data.map((r) => ({ ...r })) }),
		getCarrierDBFromSQLite: () => { reads.push("getCarrierDBFromSQLite"); return CARRIER; },
		computeDriverQueues: () => ({}),
		withExpenseWindows: (rows) => rows.map((r) => ({ ...r })),
		stripSigningEvidence: (rows) => rows,
		ONBOARDING_DOCS: [],
	};
	return { deps, reads };
}

// Execute the registration against a capturing `app`, returning its chain.
function buildRoute(routeSrc = ROUTE_SRC) {
	const { deps, reads } = makeDeps();
	const names = Object.keys(deps);
	let captured = null;
	const app = { get: (p, ...chain) => { captured = { path: p, chain }; } };
	new Function("app", ...names, `${routeSrc};`)(app, ...names.map((n) => deps[n]));
	if (!captured || captured.path !== "/api/driver/:driverName") fatal("the lifted registration did not register the route");
	return { chain: captured.chain, reads };
}

// Run the chain the way Express does: each middleware must call next() to
// hand on. `name` is req.params.driverName as Express delivers it (decoded).
async function call(route, user, name) {
	route.reads.length = 0;
	const req = {
		method: "GET",
		url: `/api/driver/${encodeURIComponent(name)}`,
		originalUrl: `/api/driver/${encodeURIComponent(name)}`,
		params: { driverName: name },
		headers: {},
		route: { path: "/api/driver/:driverName" },
		session: user ? { user: { ...user } } : {},
	};
	const res = {
		statusCode: 200, body: undefined,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
		setHeader() {},
	};
	for (const mw of route.chain) {
		let next = false;
		await mw(req, res, () => { next = true; });
		if (!next) break;
	}
	return { status: res.statusCode, body: res.body, reads: route.reads.length };
}
// Call ONLY the handler, skipping the mount (layer B on its own).
async function callHandler(route, user, name) {
	const handlerOnly = { chain: [route.chain[route.chain.length - 1]], reads: route.reads };
	return call(handlerOnly, user, name);
}

const SUPER = { id: 1, role: "Super Admin", username: "super_admin", driverName: "" };
const DK = { id: 2, role: "Driver", username: "LogisX-1001", driverName: "Deshorn King" };
const SK = { id: 3, role: "Driver", username: "LogisX-1002", driverName: "Shorn King" };
const DISPATCH = { id: 4, role: "Dispatcher", username: "dispatch1", driverName: "" };
const INVESTOR = { id: 5, role: "Investor", username: "investor1", driverName: "" };
const NAMELESS = { id: 6, role: "Driver", username: "LogisX-1003", driverName: "" };
// Sessions that carry a driver name on a role this page does not serve. The
// mount is what refuses these; layer B alone would admit them by name.
const DISPATCH_NAMED = { ...DISPATCH, driverName: "Deshorn King" };
const INVESTOR_NAMED = { ...INVESTOR, driverName: "Deshorn King" };

const forbidden = (r) => r.status === 403 && r.body && r.body.error === "Forbidden";
const brief = (r) => `status ${r.status}, reads ${r.reads}${r.status === 500 ? `, ${JSON.stringify(r.body)}` : ""}`;

(async () => {
	const route = buildRoute();

	// =========================================================================
	console.log("\n§1  every role, against its own name and another driver's name");
	// =========================================================================
	let r;
	r = await call(route, null, "Deshorn King");
	ok("no session: 401 before any read", r.status === 401 && r.reads === 0, brief(r));

	r = await call(route, SUPER, "super_admin");
	ok("Super Admin, own name: 200", r.status === 200, brief(r));
	r = await call(route, SUPER, "Deshorn King");
	ok("Super Admin, another driver: 200", r.status === 200 && r.body.loads.length === 1, brief(r));

	r = await call(route, DK, "Deshorn King");
	ok("Driver, own name: 200 with only their own load", r.status === 200
		&& r.body.loads.length === 1 && r.body.loads[0]["Load ID"] === "L-100", brief(r));
	r = await call(route, DK, "  deshorn   KING ");
	ok("Driver, own name in another case and spacing: 200 (normalizeDriverName on both sides)",
		r.status === 200 && r.body.loads.length === 1, brief(r));
	r = await call(route, DK, "Shorn King");
	ok("Driver, another driver: 403 Forbidden before any read", forbidden(r) && r.reads === 0, brief(r));
	r = await call(route, SK, "Deshorn King");
	ok('Driver "Shorn King" reading "Deshorn King": 403 (whole-name match, no substring)', forbidden(r), brief(r));

	for (const [label, user] of [["Dispatcher", DISPATCH], ["Investor", INVESTOR]]) {
		r = await call(route, user, user.username);
		ok(`${label}, own name: 403 Forbidden before any read`, forbidden(r) && r.reads === 0, brief(r));
		r = await call(route, user, "Deshorn King");
		ok(`${label}, a driver's name: 403 Forbidden before any read`, forbidden(r) && r.reads === 0, brief(r));
	}
	r = await call(route, DISPATCH_NAMED, "Deshorn King");
	ok("Dispatcher whose session carries the requested driver name: still 403 at the mount",
		forbidden(r) && r.reads === 0, brief(r));
	r = await call(route, INVESTOR_NAMED, "Deshorn King");
	ok("Investor whose session carries the requested driver name: still 403 at the mount",
		forbidden(r) && r.reads === 0, brief(r));

	r = await call(route, NAMELESS, "Deshorn King");
	ok("Driver with a blank session name, any driver: 403", forbidden(r) && r.reads === 0, brief(r));
	r = await call(route, NAMELESS, " ");
	ok('Driver with a blank session name, a blank name: 403 ("" never matches "")',
		forbidden(r) && r.reads === 0, brief(r));

	// =========================================================================
	console.log("\n§2  what an admitted caller receives");
	// =========================================================================
	const own = await call(route, DK, "Deshorn King");
	const ownHeaders = own.body.headers.jobTracking;
	const ownLoad = own.body.loads[0];
	ok("Driver: no rate or payment column in the headers or on the load",
		!ownHeaders.includes("Rate") && !ownHeaders.includes("  Payment  ")
		&& !("Rate" in ownLoad) && !("  Payment  " in ownLoad));
	ok("Driver: broker contact columns are blanked",
		ownLoad["Broker Contact Name"] === "" && ownLoad["Phone Number"] === "");
	ok("Driver: no roster of other drivers", Array.isArray(own.body.drivers) && own.body.drivers.length === 0);
	ok("Driver: only their own invoices, expenses and messages",
		own.body.invoices.map((i) => i.id).join() === "1"
		&& own.body.expenses.map((e) => e.id).join() === "1"
		&& own.body.messages.map((m) => m.id).join() === "1");

	const admin = await call(route, SUPER, "Deshorn King");
	const adminLoad = admin.body.loads[0];
	ok("Super Admin: rate columns and broker contacts intact",
		admin.body.headers.jobTracking.includes("Rate") && adminLoad.Rate === "2000"
		&& adminLoad["Broker Contact Name"] === "Pat Broker");
	ok("Super Admin: the roster and the driver's invoice totals",
		admin.body.drivers.join() === "Deshorn King,Shorn King"
		&& admin.body.invoices.length === 1 && admin.body.invoices[0].total_earnings === 1800);

	// Layer B alone: if the mount is ever widened, the handler still treats every
	// non-Super-Admin caller as the driver.
	r = await callHandler(route, DISPATCH_NAMED, "Deshorn King");
	ok("handler alone, a non-Super-Admin caller it admits by name: rates stripped, no roster",
		r.status === 200 && !r.body.headers.jobTracking.includes("Rate") && r.body.drivers.length === 0, brief(r));
	r = await callHandler(route, INVESTOR, "Deshorn King");
	ok("handler alone, a nameless non-Super-Admin caller: 403 before any read", forbidden(r) && r.reads === 0, brief(r));

	// =========================================================================
	console.log("\n§3  the callers the gate was sized against");
	// =========================================================================
	const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : walk(p);
		return /\.(vue|js|ts|html)$/.test(e.name) ? [p] : [];
	});
	// `/api/driver/${...}` — a name interpolated straight after the prefix. The
	// sibling routes (`/api/driver/me/...`, `/api/driver/truck-documents/...`)
	// have a literal segment first and do not match.
	const callers = [...walk(path.join(ROOT, "client", "src")), ...walk(path.join(ROOT, "public"))]
		.filter((f) => /\/api\/driver\/\$\{/.test(fs.readFileSync(f, "utf8")))
		.map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
		.sort();
	ok("only the driver store and the legacy driver page call this route",
		callers.join() === "client/src/stores/driver.js,public/driver.html", callers.join() || "none");
	const router = fs.readFileSync(path.join(ROOT, "client", "src", "router", "index.js"), "utf8");
	const m = router.match(/path:\s*'\/driver',[\s\S]{0,200}?roles:\s*\[([^\]]*)\]/);
	const roles = m ? m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean).sort() : [];
	ok("the /driver view (the store's only entry) admits Driver and Super Admin only",
		roles.join() === "Driver,Super Admin", roles.join() || "route not found");
	const legacy = fs.readFileSync(path.join(ROOT, "public", "driver.html"), "utf8");
	ok("the legacy driver page admits Driver and Super Admin only",
		/requiredRoles:\s*\['Driver',\s*'Super Admin'\]/.test(legacy));

	// =========================================================================
	console.log("\n§4  DISCRIMINATION: defang each layer, require an assertion to flip");
	// =========================================================================
	// Layer B refuses a NAMELESS Dispatcher or Investor on its own, so that case
	// cannot show the mount matters. A session that carries a driver name can.
	const m1 = buildRoute(mutate(ROUTE_SRC, 'requireRole("Super Admin", "Driver")', "requireAuth"));
	r = await call(m1, INVESTOR_NAMED, "Deshorn King");
	ok("MUTANT 1 (mount is requireAuth): the §1 named-Investor assertion flips",
		r.status === 200 && r.body.invoices.length === 1, brief(r));

	const m2 = buildRoute(mutate(ROUTE_SRC,
		"if (!sessionName || normalizeDriverName(driverName) !== sessionName) {",
		"if (normalizeDriverName(driverName) !== sessionName) {"));
	r = await call(m2, NAMELESS, " ");
	ok("MUTANT 2 (blank-name refusal dropped): the §1 blank-name assertion flips",
		r.status === 200 && r.body.invoices.map((i) => i.id).join() === "3", brief(r));

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
