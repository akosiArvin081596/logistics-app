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
 *   §5 the driver's own drivers_directory row is found when it is stored under
 *      another spacing of the name (findDirectoryRowForDriver()), with directory
 *      reads on an in-memory SQLite, and the lookup's mutant flips it.
 *   §6 the driver's truck is found the same way (findTruckForDriver()), and the
 *      routes the app calls for what the page lists answer for the same driver:
 *      GET /api/driver/me/truck-photo, GET /api/driver/truck-documents/:id/view,
 *      GET /api/driver/shared-documents/:id/download and
 *      POST /api/drivers-directory/:id/profile-picture (another driver and a
 *      blank session name still refused). Two mutants: the truck lookup and the
 *      truck-document check back to their old comparisons.
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
// brace count: a brace inside a string literal (legacyServedBrokerCell tests
// `startsWith("{")`) throws a naive counter off.
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
	liftConstLine("BROKER_WITHHELD_RE"),
	liftFn("resolveBrokerWithheldColumns"),
	liftFn("sanitizeBrokerColumns"),
	"return { normalizeDriverName, findCol, sanitizeBrokerColumns };",
].join("\n"))();
// The route finds the driver's directory row through findDirectoryRowForDriver(),
// which reads `db`, so it is built over whichever db a route runs on.
const DIRECTORY_LOOKUP_SRC = [liftFn("normalizeDriverName"), liftFn("findDriverNameClashes"), liftFn("findDirectoryRowForDriver")].join("\n");
const directoryLookup = (db, src = DIRECTORY_LOOKUP_SRC) =>
	new Function("db", `"use strict";\n${src}\nreturn findDirectoryRowForDriver;`)(db);
// ...and its truck through findTruckForDriver(), found the same two ways.
const TRUCK_LOOKUP_SRC = [liftFn("normalizeDriverName"), liftFn("findTruckForDriver")].join("\n");
const truckLookup = (db, src = TRUCK_LOOKUP_SRC) =>
	new Function("db", `"use strict";\n${src}\nreturn findTruckForDriver;`)(db);

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
		// The route reads every live invoice and matches the driver in JS through
		// normalizeDriverName() (any stored spelling), so that query binds no name.
		if (/FROM invoices/.test(sql) && who === null) return TABLES.invoices.map((i) => ({ deleted_at: "", ...i }));
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
		findDirectoryRowForDriver: directoryLookup(db),
		findTruckForDriver: truckLookup(db),
		getJobTrackingCached: async () => { reads.push("getJobTrackingCached"); return JT; },
		liveJobTrackingView: (jt) => ({ ...jt, headers: [...jt.headers], data: jt.data.map((r) => ({ ...r })) }),
		getCarrierDBFromSQLite: () => { reads.push("getCarrierDBFromSQLite"); return CARRIER; },
		computeDriverQueues: () => ({}),
		withExpenseWindows: (rows) => rows.map((r) => ({ ...r })),
		stripSigningEvidence: (rows) => rows,
		// Which stored files exist, from their bytes (its own subject is
		// scripts/test-stored-file-serving.js).
		storedFileKind: new Function("imageLimits", `${liftFn("storedFileKind")}\nreturn storedFileKind;`)(require(path.join(ROOT, "lib", "image-size"))),
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

	// =========================================================================
	console.log("\n§5  the driver's own directory row, stored under another spacing");
	// =========================================================================
	// The page finds its drivers_directory row (profile picture, shared documents)
	// through findDirectoryRowForDriver(): the row equal to the name case aside,
	// else the one normalizeDriverName() matches. Only the directory reads go to a
	// real SQLite here, so the lookup's SQL runs as written; every other read
	// keeps the canned fixture.
	let Database;
	try { Database = require("better-sqlite3"); } catch (e) { fatal(`better-sqlite3 did not load (${e.message}); run under the .nvmrc Node`); }
	function routeWithDirectory(rows, lookupSrc = DIRECTORY_LOOKUP_SRC) {
		const dir = new Database(":memory:");
		dir.exec("CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL UNIQUE COLLATE NOCASE, profile_picture_url TEXT DEFAULT '')");
		const ins = dir.prepare("INSERT INTO drivers_directory (id, driver_name, profile_picture_url) VALUES (?, ?, ?)");
		for (const [id, name, pic] of rows) ins.run(id, name, pic);
		const { deps, reads } = makeDeps();
		const canned = deps.db;
		deps.db = { prepare(sql) { if (/\bdrivers_directory\b/.test(sql)) { reads.push(sql); return dir.prepare(sql); } return canned.prepare(sql); } };
		deps.findDirectoryRowForDriver = directoryLookup(deps.db, lookupSrc);
		const names = Object.keys(deps);
		let captured = null;
		const app = { get: (p, ...chain) => { captured = { path: p, chain }; } };
		new Function("app", ...names, `${ROUTE_SRC};`)(app, ...names.map((n) => deps[n]));
		return { chain: captured.chain, reads };
	}
	const SK_PIC = "/uploads/profile-pictures/sk.png";
	const found = (res, id, pic) => res.status === 200 && res.body.driverDirectoryId === id && res.body.profilePictureUrl === pic;
	for (const [label, stored] of [["a doubled space", "Shorn  King"], ["edge spaces", " Shorn King "]]) {
		r = await call(routeWithDirectory([[11, "Deshorn King", ""], [12, stored, SK_PIC]]), SK, "Shorn King");
		ok(`Driver, own page, their directory row stored with ${label}: found (its id and profile picture)`,
			found(r, 12, SK_PIC), brief(r));
	}
	r = await call(routeWithDirectory([[12, "Shorn  King", "/a.png"], [13, "SHORN KING", "/b.png"]]), SK, "Shorn King");
	ok("the row equal to the name case aside is still preferred to a spacing variant", found(r, 13, "/b.png"), brief(r));
	r = await call(routeWithDirectory([[11, "Deshorn King", "/d.png"]]), SK, "Shorn King");
	ok("no row of their own: no directory id and no picture (Deshorn King is another driver)", found(r, 0, ""), brief(r));
	const routeCode = ROUTE_SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	ok("the route resolves its directory row through findDirectoryRowForDriver(), with no LOWER() lookup of its own",
		routeCode.includes("findDirectoryRowForDriver(driverName)") && !/FROM drivers_directory WHERE LOWER\(/.test(routeCode));

	// The one mutant for this lookup: findDirectoryRowForDriver() back to LOWER()
	// equality alone. The directory sync shares it; scripts/test-directory-spacing-match.js
	// catches the same mutant there.
	const LOWER_ONLY = mutate(DIRECTORY_LOOKUP_SRC,
		"const hit = findDriverNameClashes(trimmed, { users: false })[0];", "const hit = null;");
	r = await call(routeWithDirectory([[11, "Deshorn King", ""], [12, "Shorn  King", SK_PIC]], LOWER_ONLY), SK, "Shorn King");
	ok("MUTANT 3 (the directory lookup back to LOWER() equality): the §5 doubled-space assertion flips",
		found(r, 0, ""), brief(r));

	// =========================================================================
	console.log("\n§6  the driver's truck, and the files the page lists, under another spacing");
	// =========================================================================
	// The page finds the driver's truck through findTruckForDriver() (the truck
	// naming them case aside, else the one normalizeDriverName() matches), and
	// the routes the driver app then calls for what the page lists — the truck
	// photo, a truck document, a shared document, the profile-picture upload —
	// must answer for the same driver. Trucks, assignments, legal documents and
	// the directory are a real SQLite here; each route is the shipped handler.
	function makeFilesDb() {
		const fdb = new Database(":memory:");
		fdb.exec(`CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, make TEXT DEFAULT '', model TEXT DEFAULT '',
			year INTEGER DEFAULT 0, vin TEXT DEFAULT '', license_plate TEXT DEFAULT '', status TEXT DEFAULT 'Active', assigned_driver TEXT DEFAULT '', photo TEXT DEFAULT '')`);
		fdb.exec("CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '')");
		fdb.exec(`CREATE TABLE legal_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER DEFAULT 0, driver_id INTEGER DEFAULT 0, investor_id INTEGER DEFAULT 0,
			visible_to_driver INTEGER DEFAULT 0, doc_type TEXT DEFAULT '', file_name TEXT DEFAULT '', file_url TEXT DEFAULT '', notes TEXT DEFAULT '',
			uploaded_by TEXT DEFAULT '', uploaded_at TEXT DEFAULT '2026-09-01')`);
		fdb.exec("CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL UNIQUE COLLATE NOCASE, profile_picture_url TEXT DEFAULT '')");
		const truck = fdb.prepare("INSERT INTO trucks (id, unit_number, assigned_driver, photo) VALUES (?, ?, ?, ?)");
		truck.run(7, "33", "Deshorn King", "");
		truck.run(8, "101", "Shorn  King", "P101"); // Shorn King's truck, stored with a doubled space
		fdb.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (8, 'Shorn  King', '2026-09-01')").run();
		fdb.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (7, 'Deshorn King', '2026-09-01')").run();
		// file_url "" keeps every admitted request off the disk: it answers 404
		// "File missing" after the ownership check, a refusal 403 before it.
		const doc = fdb.prepare("INSERT INTO legal_documents (id, truck_id, driver_id, visible_to_driver, file_name) VALUES (?, ?, ?, 1, 'x.pdf')");
		doc.run(50, 8, 0); doc.run(51, 7, 0); doc.run(60, 0, 12); doc.run(61, 0, 11);
		fdb.prepare("INSERT INTO drivers_directory (id, driver_name) VALUES (11, 'Deshorn King'), (12, 'Shorn  King')").run();
		return fdb;
	}
	const FILES_TABLES = /\b(trucks|truck_assignments|legal_documents|drivers_directory)\b/;
	function pageOverFiles(fdb, truckSrc = TRUCK_LOOKUP_SRC) {
		const { deps, reads } = makeDeps();
		const canned = deps.db;
		deps.db = { prepare(sql) { if (FILES_TABLES.test(sql)) { reads.push(sql); return fdb.prepare(sql); } return canned.prepare(sql); } };
		deps.findDirectoryRowForDriver = directoryLookup(deps.db);
		deps.findTruckForDriver = truckLookup(deps.db, truckSrc);
		const names = Object.keys(deps);
		let captured = null;
		const app = { get: (p, ...chain) => { captured = { path: p, chain }; } };
		new Function("app", ...names, `${ROUTE_SRC};`)(app, ...names.map((n) => deps[n]));
		return { chain: captured.chain, reads };
	}
	// A sibling route, lifted and run with the gate at its mount passed through
	// (each keeps its own role and ownership checks inside, the subject here).
	function sibling(verb, routePath, fdb, extra = {}, src = null) {
		const deps = {
			db: fdb, requireAuth: (req, res, next) => next(), truckDocViewLimiter: (req, res, next) => next(),
			normalizeDriverName: helpers.normalizeDriverName, findTruckForDriver: truckLookup(fdb),
			storedFileForServing: (v) => (v ? { contentType: "image/png", body: Buffer.from(String(v)) } : null),
			storedFileETag: () => '"etag"', ifNoneMatchIncludes: () => false,
			setUploadServeHeaders: () => {}, fs: { existsSync: () => false }, path, __dirname: ROOT,
			saveProfilePicture: () => { throw new Error("no file is written in this runner"); },
			...extra,
		};
		const names = Object.keys(deps);
		let handler = null;
		const app = { [verb]: (p, ...chain) => { handler = chain[chain.length - 1]; } };
		new Function("app", ...names, `${src || routeSource(verb, routePath)};`)(app, ...names.map((n) => deps[n]));
		return async (user, params = {}, body = {}) => {
			const res = {
				statusCode: 200, body: undefined,
				status(c) { this.statusCode = c; return this; },
				json(b) { this.body = b; return this; },
				setHeader() {}, end(b) { this.body = b; return this; }, sendFile() { this.body = "<file>"; return this; },
			};
			await handler({ method: verb.toUpperCase(), params, body, headers: {}, session: user ? { user: { ...user } } : {} }, res);
			return { status: res.statusCode, body: res.body };
		};
	}
	const admitted = (x) => x.status === 404 && x.body && x.body.error === "File missing";
	const said = (x) => `${x.status} ${JSON.stringify(x.body)}`.slice(0, 120);
	{
		const fdb = makeFilesDb();
		r = await call(pageOverFiles(fdb), SK, "Shorn King");
		ok("GET /api/driver/:driverName: a driver whose truck is stored with a doubled space gets that truck",
			r.status === 200 && r.body.truck && r.body.truck.id === 8 && r.body.truck.unit_number === "101", brief(r));
		ok("...and the driver-visible documents of that truck listed",
			r.status === 200 && r.body.truck && r.body.truckDocuments.map((d) => d.id).join() === "50",
			`truck ${JSON.stringify(r.body && r.body.truck)}, docs ${JSON.stringify(r.body && r.body.truckDocuments)}`);
		r = await call(pageOverFiles(fdb), DK, "Deshorn King");
		ok("...and Deshorn King still gets his own truck", r.status === 200 && r.body.truck && r.body.truck.id === 7, brief(r));
		fdb.prepare("UPDATE trucks SET assigned_driver = 'SHORN KING' WHERE id = 7").run();
		r = await call(pageOverFiles(fdb), SK, "Shorn King");
		ok("the truck naming the driver case aside is still preferred to a spacing variant", r.status === 200 && r.body.truck.id === 7, brief(r));
	}
	{
		const fdb = makeFilesDb();
		const photo = sibling("get", "/api/driver/me/truck-photo", fdb);
		let x = await photo(SK);
		ok("GET /api/driver/me/truck-photo: the same driver gets that truck's photo",
			x.status === 200 && Buffer.isBuffer(x.body) && x.body.toString() === "P101", said(x));
		x = await photo(DK);
		ok("...and Deshorn King, whose truck has none, gets 404", x.status === 404, said(x));
	}
	{
		const fdb = makeFilesDb();
		const view = sibling("get", "/api/driver/truck-documents/:id/view", fdb);
		let x = await view(SK, { id: "50" });
		ok("GET /api/driver/truck-documents/:id/view: the driver on the truck (assignment stored with a doubled space) is admitted", admitted(x), said(x));
		x = await view(DK, { id: "50" });
		ok("...another driver is refused 403", x.status === 403, said(x));
		x = await view(NAMELESS, { id: "50" });
		ok("...a blank session name is refused 403", x.status === 403, said(x));
		x = await view(SK, { id: "51" });
		ok("...and the driver is refused another truck's document", x.status === 403, said(x));
		fdb.prepare("DELETE FROM truck_assignments").run();
		x = await view(SK, { id: "50" });
		ok("...with no assignment row, admitted through the truck's own assigned_driver (doubled space)", admitted(x), said(x));
	}
	{
		const fdb = makeFilesDb();
		const shared = sibling("get", "/api/driver/shared-documents/:id/download", fdb);
		let x = await shared(SK, { id: "60" });
		ok("GET /api/driver/shared-documents/:id/download: the driver whose directory row has a doubled space is admitted", admitted(x), said(x));
		x = await shared(DK, { id: "60" });
		ok("...another driver is refused 403", x.status === 403, said(x));
		x = await shared(SK, { id: "61" });
		ok("...and the driver is refused another driver's document", x.status === 403, said(x));
		x = await shared(NAMELESS, { id: "60" });
		ok("...a blank session name is refused 403", x.status === 403, said(x));
	}
	{
		const fdb = makeFilesDb();
		const pic = sibling("post", "/api/drivers-directory/:id/profile-picture", fdb);
		let x = await pic(SK, { id: "12" });
		ok("POST /api/drivers-directory/:id/profile-picture: the driver may upload to their own row (doubled space) — past the check to 400 fileData required",
			x.status === 400 && x.body && x.body.error === "fileData required", said(x));
		x = await pic(SK, { id: "11" });
		ok("...and is refused another driver's row", x.status === 403, said(x));
		x = await pic(DK, { id: "12" });
		ok("...as another driver is refused theirs", x.status === 403, said(x));
		x = await pic(NAMELESS, { id: "12" });
		ok("...a blank session name is refused 403", x.status === 403, said(x));
	}
	{
		// MUTANT 4: findTruckForDriver() back to LOWER() equality alone — the lookup
		// the page and the photo route made before.
		const TRUCK_LOWER_ONLY = mutate(TRUCK_LOOKUP_SRC,
			'return hit ? { id: hit.id, unit_number: hit.unit_number, matchedBy: "normalized" } : null;', "return null;");
		r = await call(pageOverFiles(makeFilesDb(), TRUCK_LOWER_ONLY), SK, "Shorn King");
		ok("MUTANT 4 (the truck lookup back to LOWER() equality): the §6 doubled-space truck assertion flips",
			r.status === 200 && r.body.truck === null, brief(r));
		// MUTANT 5: the truck-document check comparing trimmed, lowercased names
		// again, as it did before.
		const viewSrc = routeSource("get", "/api/driver/truck-documents/:id/view");
		const oldCompare = mutate(mutate(viewSrc,
			".some((a) => normalizeDriverName(a.driver_name) === sessionDriver);",
			'.some((a) => (a.driver_name || "").trim().toLowerCase() === sessionDriver);'),
			"normalizeDriverName(truck.assigned_driver) !== sessionDriver",
			'(truck.assigned_driver || "").trim().toLowerCase() !== sessionDriver');
		const x = await sibling("get", "/api/driver/truck-documents/:id/view", makeFilesDb(), {}, oldCompare)(SK, { id: "50" });
		ok("MUTANT 5 (the truck-document check back to trim + lowercase): the §6 admission flips to 403", x.status === 403, said(x));
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
