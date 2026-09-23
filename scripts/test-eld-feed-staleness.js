#!/usr/bin/env node
/**
 * Tests for ELD FEED SILENCE detection — the sweep that notices when a truck's
 * ELD stops reporting.
 *
 * WHY IT LOADS THE FUNCTIONS OUT OF server.js SOURCE INSTEAD OF require()-ING IT.
 * Same reason as scripts/test-truck-retirement.js and test-investor-expense-scoping.js:
 * server.js opens SQLite, reads a service account key and starts listening on
 * import. Extracting the text keeps this honest in the way that matters — it
 * exercises THE CODE THAT SHIPS, not a copy that can quietly drift. Every
 * extraction asserts the function is found exactly once, so a rename or a second
 * definition fails the run loudly rather than silently testing nothing.
 *
 * WHAT WENT WRONG, measured on production 2026-09-19. Nothing detected a dead
 * feed, and three different shapes of silence were live simultaneously:
 *
 *   LogisX-#2372  x78f4qtVukzwiF6ur7D04A   last fix 2026-08-11  (39 days)
 *   LogisX-#302   18000505841 (Linxup)     last fix 2026-07-27  (54 days)
 *   (orphan)      18000507597 (Linxup)     linked to NO truck, degraded to
 *                                          exactly 1 ping/day from 2026-09-06
 *
 * THE PROPERTY UNDER TEST is not "a silent truck alerts". It is that SILENCE
 * CANNOT BE LAUNDERED — not by a process restart, not by a device that keeps a
 * single daily heartbeat alive, not by an alert that already fired once and is
 * therefore never mentioned again, and not by an email that failed to send. Each
 * of those is a way for the detector to look present and report nothing, which
 * is indistinguishable from the bug it replaces.
 *
 * It matters because this is a MONEY path, not a dashboard. getEldTravelDaysByVehicle()
 * is coverage-aware: a load window with NO pings falls back to the FULL scheduled
 * window, moving the load onto the `estimated` basis — more driver days than were
 * worked, so more driver pay and less investor profit, with nothing logged.
 *
 * Proved five ways, and all five are required:
 *
 *   §1 TEXTUAL. Assertions against the shipped source: the flag really is
 *      CLAUDE.md's THIRD shape (default ON), the ledger really is the
 *      standing-condition shape and not fuel_event_alerts' point-event shape,
 *      alerted_at really is stamped only after delivery, and the last-fix query
 *      exists exactly ONCE in the file. A behavioural test cannot catch a second
 *      hand-rolled copy of a query — the copy simply would not be exercised.
 *
 *   §2 PURE. lib/eld-feed-health.js driven directly, including the "" retirement
 *      inversion that has already been shipped backwards twice in the money math
 *      (PR #205, PR #216).
 *
 *   §3 BEHAVIOURAL, against a REAL SQLite database seeded with the production
 *      shape above. The shipped queries are EXECUTED, not inspected, so a sweep
 *      that emits syntactically valid nonsense fails here.
 *
 *   §4 LIFECYCLE. alert -> dedupe -> resolve -> re-open, with first_seen
 *      preserved across the whole round trip.
 *
 *   §5 MUTANTS. Each deliberately reintroduces one plausible mistake and must be
 *      caught, including the two that would make this feature silently useless:
 *      fuel_event_alerts' bare `alerted_at` short-circuit, and stamping
 *      alerted_at before the send.
 *
 * ⚠️ THE SCRATCH DATABASE IS A mkdtemp, NEVER THE REPO'S app.db. It also creates
 * routemate_vehicles with the EXACT production column list — which has no
 * `source` column, whatever CLAUDE.md's Linxup paragraph implies. §1 and §3 both
 * pin that: `source` lives on routemate_telemetry, and querying it on the mirror
 * throws `no such column`.
 *
 * Run: node scripts/test-eld-feed-staleness.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");
const feedLib = require(path.join(ROOT, "lib", "eld-feed-health.js"));

// ------------------------------------------------------------------ harness
let passed = 0;
const failures = [];
function ok(name, cond, detail) {
	if (cond) { passed++; return; }
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name, actual, expected) {
	ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log(`\n── ${t}`); }

// ---------------------------------------------------------------- extraction
// ⚠️ COMMENTS ARE STRIPPED BEFORE ANY "this text must/must not appear" MATCH.
// The repo has already been bitten by this once: ci.yml's test-suite tripwire
// matched its OWN comment text and failed 100% of runs. Here the same shape bit
// twice — §1.27 asserts the alert metadata carries no `loadId`, and the code
// carries a comment explaining WHY it carries no loadId; §1.30 counts call sites
// of a function whose name appears in the comment above its one refactored
// caller. Both would have "failed" against correct code.
function stripComments(s) {
	return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function extract(name) {
	const needle = `\nfunction ${name}(`;
	const asyncNeedle = `\nasync function ${name}(`;
	const hits = SRC.split(needle).length - 1 + SRC.split(asyncNeedle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const isAsync = SRC.includes(asyncNeedle);
	const start = SRC.indexOf(isAsync ? asyncNeedle : needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}

// The shipped ledger DDL, taken out of server.js rather than retyped — see the
// note at its use in freshDb(). Asserts it appears exactly once so a second
// CREATE (or a rename) fails the run loudly.
const LEDGER_DDL = (() => {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS eld_feed_alerts \([\s\S]*?\n\t\)/g);
	if (!m || m.length !== 1) throw new Error(`expected exactly 1 eld_feed_alerts DDL in server.js, found ${m ? m.length : 0}`);
	return m[0];
})();

// The whole shipped surface. Extracted together so they close over one injected
// `db` and one set of injected constants — i.e. the real call graph, not stubs
// of each other.
const FNS = [
	"eldLatestCleanFixByVehicle",
	"eldFixCountsByVehicle",
	"eldFeedSnapshot",
	"eldFeedVerdicts",
	"eldFeedHealthReport",
	"alertEldFeedSilence",
	"sweepEldFeedSilence",
	"maybeSweepEldFeedSilence",
	"escHtml",
];

// Build the shipped functions against a real fixture DB and recording stubs.
// ONLY the outside world is stubbed: mail, sockets, the notification INSERT and
// the business-day clock. Every query, the ledger and all of the decision logic
// are the shipped ones.
function loadShipped(db, opts = {}, mutate = (s) => s) {
	const env = {
		ELD_STALE_ALERT_ENABLED: opts.enabled === undefined ? true : opts.enabled,
		ELD_STALE_HOURS: opts.staleHours || feedLib.DEFAULT_STALE_HOURS,
		ELD_STALE_MIN_FIXES: opts.minFixes || feedLib.DEFAULT_MIN_FIXES_24H,
		ELD_UNLINKED_LOOKBACK_HOURS: opts.lookbackHours || feedLib.DEFAULT_UNLINKED_LOOKBACK_HOURS,
		ELD_STALE_ALERT_MAX_PER_DAY: opts.maxPerDay === undefined ? 25 : opts.maxPerDay,
	};
	const rec = { emails: [], emits: [], notifications: [], logs: [] };
	const sendEmail = async (to, subject, html) => {
		rec.emails.push({ to, subject, html });
		return opts.mailFails ? false : true;
	};
	const insertDispatchNotification = {
		run: (type, title, body, metadata) => {
			if (opts.notifyThrows) throw new Error("notification channel down");
			rec.notifications.push({ type, title, body, metadata });
			db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata) VALUES (?,?,?,?)")
				.run(type, title, body, metadata);
			return { lastInsertRowid: rec.notifications.length };
		},
	};
	const io = { to: () => ({ emit: (ev, payload) => rec.emits.push({ ev, payload }) }) };
	const quiet = { log: () => {}, warn: () => {}, error: (...a) => rec.logs.push(a.join(" ")) };

	const preamble =
		`const ELD_STALE_ALERT_ENABLED = ${JSON.stringify(env.ELD_STALE_ALERT_ENABLED)};\n` +
		`const ELD_STALE_HOURS = ${env.ELD_STALE_HOURS};\n` +
		`const ELD_STALE_MIN_FIXES = ${env.ELD_STALE_MIN_FIXES};\n` +
		`const ELD_UNLINKED_LOOKBACK_HOURS = ${env.ELD_UNLINKED_LOOKBACK_HOURS};\n` +
		`const ELD_STALE_ALERT_MAX_PER_DAY = ${env.ELD_STALE_ALERT_MAX_PER_DAY};\n` +
		`const eldFeedSweepHealth = { lastRun: null, lastError: null, lastFeeds: 0, lastAlerted: 0, lastResolved: 0 };\n` +
		`let eldFeedSweepRunning = false;\n`;

	const body = FNS.map(extract).join("\n\n");
	const src = mutate(`${preamble}${body}\nreturn { ${FNS.join(", ")}, eldFeedSweepHealth };`);
	const built = new Function(
		"db", "eldFeedHealth", "todayKeyCT", "sendEmail", "insertDispatchNotification", "io", "console", "process",
		src,
	)(db, feedLib, () => opts.todayKey || "2026-09-19", sendEmail, insertDispatchNotification, io, quiet,
		{ env: { GMAIL_USER: "ops@example.invalid" } });
	return { ...built, rec, db };
}

// ------------------------------------------------------------------ fixtures
// Production shape as read on 2026-09-19. Seeded RELATIVE TO NOW so the fixture
// cannot rot into a different verdict as the calendar moves — the gaps are the
// property under test, not the absolute dates.
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function freshDb() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eld-feed-test-"));
	const db = new Database(path.join(dir, "scratch.db"));
	db.exec(`
		CREATE TABLE trucks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			unit_number TEXT NOT NULL UNIQUE,
			status TEXT NOT NULL DEFAULT 'Active',
			routemate_vehicle_id TEXT DEFAULT '',
			retired_at TEXT DEFAULT ''
		);
		CREATE TABLE routemate_telemetry (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			routemate_vehicle_id TEXT NOT NULL,
			latitude REAL, longitude REAL, speed REAL DEFAULT 0,
			bearing TEXT DEFAULT '', odometer REAL DEFAULT 0, engine_hours REAL DEFAULT 0,
			fuel_pct INTEGER, geocoded_location TEXT DEFAULT '',
			location_date_ms INTEGER DEFAULT 0,
			fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			dropped_reason TEXT DEFAULT '',
			source TEXT DEFAULT ''
		);
		CREATE TABLE dispatch_notifications (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL, title TEXT NOT NULL, body TEXT DEFAULT '',
			metadata TEXT DEFAULT '{}', read INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`);
	// ⚠️ THE LEDGER IS CREATED FROM THE **SHIPPED** DDL, lifted verbatim out of
	// server.js — never a copy typed here. A hand-written fixture schema is a
	// second definition of the table, and the moment the shipped one gains a
	// column or a constraint the tests keep passing against a table production
	// does not have. It also means this run is the only thing proving the shipped
	// DDL is valid SQLite at all: `node --check` parses JavaScript, not the SQL
	// string inside it, so a typo there would otherwise surface on boot in prod.
	db.exec(LEDGER_DDL);
	// ⚠️ EXACT PRODUCTION COLUMN LIST — there is deliberately NO `source` column
	// here. CLAUDE.md's Linxup paragraph reads as if routemate_vehicles gained
	// one in PR #351; it did not, the ALTER landed on routemate_telemetry. Any
	// code that queries routemate_vehicles.source therefore throws `no such
	// column` in §3 instead of silently working against a forgiving fixture.
	db.exec(`
		CREATE TABLE routemate_vehicles (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			routemate_vehicle_id TEXT NOT NULL UNIQUE,
			vehicle_id TEXT DEFAULT '', vin TEXT DEFAULT '', make TEXT DEFAULT '',
			model TEXT DEFAULT '', year INTEGER DEFAULT 0, fuel_type TEXT DEFAULT '',
			license_num TEXT DEFAULT '', eld_id TEXT DEFAULT '', gps_ids TEXT DEFAULT '[]',
			state TEXT DEFAULT '', active INTEGER DEFAULT 1, raw_json TEXT DEFAULT '',
			last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`);
	return db;
}

const VID = {
	t2372: "x78f4qtVukzwiF6ur7D04A",   // Routemate, dark 39 days
	t302: "18000505841",               // Linxup, dark 54 days
	t33: "2Y_aT-AYiR1Yek5krywLVQ",     // healthy
	t91: "wL8e55NU0KjcB2ynE2wf1g",     // healthy
	orphan: "18000507597",             // Linxup, no truck, 1 ping/day
	retired: "retired-device-01",
	trickle: "trickle-device-01",
};

function seedProduction(db, now) {
	const truck = db.prepare("INSERT INTO trucks (unit_number, status, routemate_vehicle_id, retired_at) VALUES (?,?,?,?)");
	truck.run("LogisX-#2372", "Active", VID.t2372, "");
	truck.run("LogisX-#302", "Active", VID.t302, "");
	truck.run("LogisX-#33", "Active", VID.t33, "");
	truck.run("Logisx-#91", "Active", VID.t91, "");
	truck.run("INV-24-A", "Active", "", "");                       // never linked
	truck.run("LogisX-#RETIRED", "Active", VID.retired, "2026-06-30"); // retired, still Active
	truck.run("LogisX-#TRICKLE", "Active", VID.trickle, "");       // fresh but starved

	const ins = db.prepare(
		"INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms, dropped_reason, source) VALUES (?,?,?,?,?,?,?)",
	);
	const many = (vid, count, spanMs, endMs, source) => {
		for (let i = 0; i < count; i++) ins.run(vid, 29.7 + i * 1e-5, -95.4, 20, Math.round(endMs - (i * spanMs) / count), "", source);
	};

	// Healthy: ~5,760/day in production. 300 over the last 24 h is far above the
	// 10-fix floor and keeps the fixture fast.
	many(VID.t33, 300, DAY, now - 5 * 60 * 1000, "routemate");
	many(VID.t91, 300, DAY, now - 5 * 60 * 1000, "routemate");
	// Dark trucks: their history is real, it just stops.
	many(VID.t2372, 50, DAY, now - 39 * DAY, "routemate");
	many(VID.t302, 50, DAY, now - 54 * DAY, "");     // '' = pre-source-column Linxup
	// Retired truck: also dark, and must NOT alert.
	many(VID.retired, 20, DAY, now - 60 * DAY, "routemate");
	// (c) TRICKLE: fresh enough that (a) can never fire — last fix 3 h ago — but
	// only one fix a day, which is 18000507597's degraded shape.
	for (let d = 0; d < 6; d++) ins.run(VID.trickle, 29.7, -95.4, 0, now - 3 * HOUR - d * DAY, "", "");
	// (b) ORPHAN: 1 ping/day, last seen 4 days ago, linked to no truck at all.
	for (let d = 4; d < 12; d++) ins.run(VID.orphan, 29.7, -95.4, 0, now - d * DAY, "", "");
	// A dropped row must never count as the feed being alive: this is the most
	// recent row for #302 by id, and it is tagged, so last-fix must ignore it.
	ins.run(VID.t302, 0, 0, 0, now - 60 * 1000, "invalid_coords", "");
	return db;
}

function openAlerts(db) {
	return db.prepare("SELECT * FROM eld_feed_alerts WHERE resolved_at IS NULL ORDER BY alert_key").all();
}
function alertRow(db, vid) {
	return db.prepare("SELECT * FROM eld_feed_alerts WHERE alert_key = ?").get(`vid:${vid}`);
}

// ═══════════════════════════════════════════════════ §1 TEXTUAL (shipped source)
section("§1 textual — the shipped source says what this test assumes");

{
	// THE FLAG. CLAUDE.md documents three shapes and warns that only the middle
	// one is self-describing, so the name proves nothing — this pins the shape at
	// the definition site, which is the only place that decides the default.
	const flagLine = SRC.match(/const ELD_STALE_ALERT_ENABLED\s*=\s*([\s\S]*?);\n/);
	ok("§1.1 ELD_STALE_ALERT_ENABLED is defined", !!flagLine);
	const expr = flagLine ? flagLine[1].replace(/\s+/g, " ").trim() : "";
	eq("§1.2 flag is CLAUDE.md's THIRD shape (default ON)",
		expr, `!/^(false|0|no|off)$/i.test(String(process.env.ELD_STALE_ALERT_ENABLED ?? "").trim())`);
	ok("§1.3 flag is NOT the '=== \"true\"' default-off shape", !/=== *"true"/.test(expr));
	ok("§1.4 flag is NOT the '/^(true|1|yes|on)$/' default-off shape", !/\^\(true/.test(expr));
	eq("§1.5 exactly one definition of the flag",
		(SRC.match(/const ELD_STALE_ALERT_ENABLED\s*=/g) || []).length, 1);

	// Evaluate the SHIPPED expression against every value that matters, rather
	// than re-typing the regex here — a test that re-types it proves nothing.
	if (expr) {
		const evalFlag = (v) => new Function("process", `return ${expr};`)({ env: v === undefined ? {} : { ELD_STALE_ALERT_ENABLED: v } });
		eq("§1.6 unset -> ON", evalFlag(undefined), true);
		eq("§1.7 'true' -> ON", evalFlag("true"), true);
		eq("§1.8 '' -> ON", evalFlag(""), true);
		eq("§1.9 'false' -> OFF", evalFlag("false"), false);
		eq("§1.10 '0' -> OFF", evalFlag("0"), false);
		eq("§1.11 'no' -> OFF", evalFlag("no"), false);
		eq("§1.12 'off' -> OFF", evalFlag("off"), false);
		eq("§1.13 'OFF' (case) -> OFF", evalFlag("OFF"), false);
		eq("§1.14 ' false ' (whitespace) -> OFF", evalFlag(" false "), false);
		eq("§1.15 'yes' -> ON (kill switch, not an enable switch)", evalFlag("yes"), true);
	}
}

{
	// THE LEDGER. Standing-condition shape, copied from expense_duplicate_alerts.
	eq("§1.16 eld_feed_alerts created exactly once",
		(SRC.match(/CREATE TABLE IF NOT EXISTS eld_feed_alerts/g) || []).length, 1);
	for (const col of ["alert_key TEXT PRIMARY KEY", "first_seen DATETIME", "alerted_at DATETIME", "resolved_at DATETIME"]) {
		ok(`§1.17 ledger has \`${col}\``, SRC.includes(col));
	}
	ok("§1.18 ledger column is alert_condition, never bare `condition`",
		/alert_condition TEXT DEFAULT/.test(SRC) && !/\n\t\t+condition TEXT/.test(SRC));

	const alertFn = extract("alertEldFeedSilence");
	// ⚠️ THE HALF THAT SEPARATES THIS FROM fuel_event_alerts. A bare alerted_at
	// short-circuit silences a feed forever after its first ping — including
	// after it was repaired and died again, which is the failure nobody watches for.
	ok("§1.19 dedupe is guarded by `&& !seen.resolved_at` (standing condition, not point event)",
		/seen\.alerted_at\s*&&\s*!seen\.resolved_at/.test(alertFn));
	ok("§1.20 first_seen preserved across re-open via COALESCE", /COALESCE\(\(SELECT first_seen FROM eld_feed_alerts/.test(alertFn));
	ok("§1.21 re-open clears resolved_at", /resolved_at\s*=\s*NULL/.test(alertFn));
	// ⚠️ alerted_at is stamped ONLY after confirmed delivery, and the source order
	// is what proves it: the UPDATE must come after `delivered` is computed.
	const deliveredAt = alertFn.indexOf("const delivered = emailed || notified");
	const stampAt = alertFn.indexOf("UPDATE eld_feed_alerts SET alerted_at");
	ok("§1.22 alerted_at is stamped only on confirmed delivery", deliveredAt > -1 && stampAt > deliveredAt);
	ok("§1.23 the stamp is idempotent (`alerted_at IS NULL` guard)", /WHERE alert_key = \? AND alerted_at IS NULL/.test(alertFn));
	ok("§1.24 emit triple: dispatch notification row", /insertDispatchNotification\.run\(/.test(alertFn));
	ok("§1.25 emit triple: socket to the dispatch room", /io\.to\("dispatch"\)\.emit\(/.test(alertFn));
	ok("§1.26 emit triple: email", /sendEmail\(/.test(alertFn));
	// A feed alert is not about a load; inventing a loadId sends a dispatcher to
	// an arbitrary load's modal (NotificationsView routes on metadata.loadId).
	ok("§1.27 metadata carries NO loadId", !/loadId/.test(stripComments(alertFn)));
}

{
	// THE LAST-FIX QUERY. Shared with /api/admin/fleet-health — one copy, or the
	// panel and the alerter drift apart about what "last fix" means.
	const CODE = stripComments(SRC);
	eq("§1.28 last-fix query exists exactly once in server.js",
		(CODE.match(/MAX\(id\) AS max_id/g) || []).length, 1);
	eq("§1.29 eldLatestCleanFixByVehicle defined once",
		(CODE.match(/function eldLatestCleanFixByVehicle\(/g) || []).length, 1);
	eq("§1.30 fleet-health calls the shared helper (2 call sites total)",
		(CODE.match(/eldLatestCleanFixByVehicle\(/g) || []).length, 3); // 1 def + 2 calls
	ok("§1.31 last-fix ignores dropped rows", /MAX\(id\) AS max_id[\s\S]{0,200}dropped_reason = ''/.test(CODE));
	// ⚠️ THE TWO CLOCKS. MAX(id) is RECEIVE ORDER; MAX(location_date_ms) is the
	// newest moment the device reported. They agree only while rows arrive in
	// time order, so a silence detector built on MAX(id) calls a healthy truck
	// dark after any out-of-order delivery, re-ingest or backfill.
	ok("§1.32 the query also selects MAX(location_date_ms) as last_fix_ms",
		/MAX\(location_date_ms\) AS last_fix_ms/.test(CODE));
	const snapFn = stripComments(extract("eldFeedSnapshot"));
	ok("§1.33 the staleness clock reads last_fix_ms, never location_date_ms",
		/tel\.last_fix_ms/.test(snapFn) && !/tel\.location_date_ms/.test(snapFn));
	eq("§1.34 both snapshot legs use it", (snapFn.match(/tel\.last_fix_ms/g) || []).length, 2);

	// ⚠️ THE routemate_vehicles.source TRAP. CLAUDE.md's Linxup paragraph reads as
	// if the mirror gained a `source` column in PR #351. It did not — the ALTER
	// landed on routemate_telemetry. Querying it on the mirror throws in prod.
	const badMirror = /FROM routemate_vehicles[\s\S]{0,400}?\bsource\b/.test(SRC)
		|| /SELECT[^;]{0,200}\brv\.source\b/.test(SRC);
	ok("§1.35 nothing selects routemate_vehicles.source (it does not exist)", !badMirror);
	ok("§1.36 provenance is read from routemate_telemetry.source", /rt\.source/.test(SRC));
}

{
	// HEALTH ENDPOINTS. DB-derived, so a restart cannot launder a silence.
	eq("§1.37 eldFeedHealthReport defined once", (SRC.match(/function eldFeedHealthReport\(/g) || []).length, 1);
	eq("§1.38 both health endpoints call it", (SRC.match(/eldFeedHealthReport\(Date\.now\(\)\)/g) || []).length, 2);
	const report = extract("eldFeedHealthReport");
	ok("§1.39 ledger timestamps served as explicit ISO-8601 Z",
		(report.match(/strftime\('%Y-%m-%dT%H:%M:%SZ'/g) || []).length >= 3);
	ok("§1.40 health report never reads a token/secret", !/TOKEN|API_KEY|SECRET/.test(report));
	// The sweep is hourly and its boot run is delayed past the boot burst.
	ok("§1.41 sweep is registered on an interval", /setInterval\(eldFeedTick, ELD_STALE_SWEEP_MS\)/.test(SRC));
	ok("§1.42 boot run is delayed, not immediate", /setTimeout\(eldFeedTick, 5 \* 60 \* 1000\)/.test(SRC));
	ok("§1.43 sweep default cadence is hourly", /ELD_STALE_SWEEP_MINUTES \?\? "60"/.test(SRC));
	// Parameterized SQL only — no interpolation of a vehicle id into a query.
	const sweepSrc = [extract("eldFeedSnapshot"), extract("eldLatestCleanFixByVehicle"), extract("eldFixCountsByVehicle"), extract("alertEldFeedSilence")].join("\n");
	ok("§1.44 no vehicle id is interpolated into SQL", !/\$\{\s*vid\s*\}|\$\{\s*vehicleId\s*\}/.test(sweepSrc));
	ok("§1.45 IN() lists are built from placeholders", /map\(\(\) => "\?"\)\.join\(","\)/.test(sweepSrc));
}

{
	// .env.example documents the flag WITH the default-ON reasoning.
	const envExample = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
	ok("§1.46 .env.example documents ELD_STALE_ALERT_ENABLED", /ELD_STALE_ALERT_ENABLED/.test(envExample));
	ok("§1.47 .env.example documents ELD_STALE_HOURS", /ELD_STALE_HOURS/.test(envExample));
	ok("§1.48 .env.example documents ELD_STALE_MIN_FIXES", /ELD_STALE_MIN_FIXES/.test(envExample));
	ok("§1.49 .env.example spells out that it DEFAULTS ON", /ELD_STALE[\s\S]{0,1200}DEFAULT[S]? \*\*ON\*\*|DEFAULTS \*\*ON\*\*[\s\S]{0,1200}ELD_STALE/.test(envExample));
}

// ═══════════════════════════════════════════════════════ §2 PURE decision logic
section("§2 pure — lib/eld-feed-health.js");

{
	// ⚠️ THE "" INVERSION. Every production truck has retired_at = '', so reading
	// it as "retired long ago" silences the entire fleet at once. This is the same
	// inversion already shipped backwards twice in the money math (PR #205, #216).
	eq("§2.1 '' is NOT retired", feedLib.isRetiredOn("", "2026-09-19"), false);
	eq("§2.2 null is NOT retired", feedLib.isRetiredOn(null, "2026-09-19"), false);
	eq("§2.3 past date IS retired", feedLib.isRetiredOn("2026-06-30", "2026-09-19"), true);
	eq("§2.4 today IS retired (inclusive)", feedLib.isRetiredOn("2026-09-19", "2026-09-19"), true);
	eq("§2.5 tomorrow is NOT retired yet", feedLib.isRetiredOn("2026-09-20", "2026-09-19"), false);
	eq("§2.6 far-future is NOT retired", feedLib.isRetiredOn("2027-01-01", "2026-09-19"), false);
	// Malformed -> keep monitoring. The conservative direction for a detector is
	// the OPPOSITE of the conservative direction for billing, and both are "not
	// retired" here only by coincidence — assert it so nobody 'simplifies' it.
	eq("§2.7 '2026-13-01' (impossible month) -> NOT retired", feedLib.isRetiredOn("2026-13-01", "2026-09-19"), false);
	eq("§2.8 '2026-06' (month only) -> NOT retired", feedLib.isRetiredOn("2026-06", "2026-09-19"), false);
	eq("§2.9 'yesterday' (garbage) -> NOT retired", feedLib.isRetiredOn("yesterday", "2026-09-19"), false);
	eq("§2.10 unknown clock -> NOT retired", feedLib.isRetiredOn("2026-01-01", ""), false);

	// The alert key is validated, not merely trimmed — it reaches a PRIMARY KEY,
	// a mail Subject and a pm2 log line from free text and a webhook body.
	eq("§2.11 valid Routemate id keys directly", feedLib.feedAlertKey("x78f4qtVukzwiF6ur7D04A", 0), "vid:x78f4qtVukzwiF6ur7D04A");
	eq("§2.12 valid Linxup id keys directly", feedLib.feedAlertKey("18000505841", 0), "vid:18000505841");
	eq("§2.13 newline collapses to a daily bucket", feedLib.feedAlertKey("abc\nSubject: x", 0), "vid:unkeyed:1970-01-01");
	eq("§2.14 overlong collapses to a daily bucket", feedLib.feedAlertKey("x".repeat(65), 0), "vid:unkeyed:1970-01-01");
	eq("§2.15 empty collapses to a daily bucket", feedLib.feedAlertKey("", 0), "vid:unkeyed:1970-01-01");
	eq("§2.16 a 64-char id is still accepted", feedLib.feedAlertKey("x".repeat(64), 0), `vid:${"x".repeat(64)}`);

	const NOW = Date.parse("2026-09-19T12:00:00Z");
	const O = { nowMs: NOW, staleHours: 24, minFixes24h: 10, unlinkedLookbackHours: 168, todayKey: "2026-09-19" };
	const truck = (over) => feedLib.judgeTruckFeed({
		truckId: 1, unitNumber: "T", status: "Active", retiredAt: "", vehicleId: "v1",
		lastFixMs: NOW - 60 * 1000, fixes24h: 300, ...over,
	}, O);

	eq("§2.17 healthy feed -> ok", truck().state, "ok");
	eq("§2.18 healthy feed does not alert", truck().alert, false);
	// (a)
	eq("§2.19 54-day silence -> stale", truck({ lastFixMs: NOW - 54 * DAY, fixes24h: 0 }).state, "stale");
	eq("§2.20 54-day silence alerts", truck({ lastFixMs: NOW - 54 * DAY, fixes24h: 0 }).alert, true);
	eq("§2.21 39-day silence -> stale", truck({ lastFixMs: NOW - 39 * DAY, fixes24h: 0 }).state, "stale");
	eq("§2.22 exactly at the threshold -> stale", truck({ lastFixMs: NOW - 24 * HOUR, fixes24h: 0 }).state, "stale");
	eq("§2.23 just inside the threshold -> not stale", truck({ lastFixMs: NOW - 23.9 * HOUR }).state, "ok");
	eq("§2.24 linked but never reported -> never_reported", truck({ lastFixMs: null, fixes24h: 0 }).state, "never_reported");
	eq("§2.25 never_reported alerts", truck({ lastFixMs: null, fixes24h: 0 }).alert, true);
	// (c) — the case (a) is structurally blind to.
	const trickle = truck({ lastFixMs: NOW - 3 * HOUR, fixes24h: 1 });
	eq("§2.26 1 ping/day -> trickle", trickle.state, "trickle");
	eq("§2.27 trickle alerts", trickle.alert, true);
	ok("§2.28 ⚠️ (a) ALONE WOULD NOT FIRE on the trickle — proving (c) is load-bearing",
		trickle.silentHours < O.staleHours);
	eq("§2.29 exactly at the fix floor -> ok", truck({ fixes24h: 10 }).state, "ok");
	eq("§2.30 one below the fix floor -> trickle", truck({ fixes24h: 9 }).state, "trickle");
	// Precedence: a stale feed reports stale, not both.
	eq("§2.31 stale wins over trickle", truck({ lastFixMs: NOW - 54 * DAY, fixes24h: 0 }).state, "stale");
	// Deliberate non-alerts.
	eq("§2.32 retired truck -> retired", truck({ retiredAt: "2026-06-30", lastFixMs: NOW - 60 * DAY, fixes24h: 0 }).state, "retired");
	eq("§2.33 retired truck does NOT alert", truck({ retiredAt: "2026-06-30", lastFixMs: NOW - 60 * DAY, fixes24h: 0 }).alert, false);
	eq("§2.34 unlinked truck -> no_device", truck({ vehicleId: "", lastFixMs: null }).state, "no_device");
	eq("§2.35 unlinked truck does NOT alert", truck({ vehicleId: "", lastFixMs: null }).alert, false);
	eq("§2.36 Inactive truck -> inactive", truck({ status: "Inactive", lastFixMs: NOW - 54 * DAY }).state, "inactive");
	eq("§2.37 OOS truck does NOT alert", truck({ status: "OOS", lastFixMs: NOW - 54 * DAY }).alert, false);
	eq("§2.38 retirement is checked before the link", truck({ retiredAt: "2026-06-30", vehicleId: "" }).state, "retired");

	// (b)
	const orph = (over) => feedLib.judgeOrphanFeed({ vehicleId: "18000507597", lastFixMs: NOW - 4 * DAY, fixes24h: 1, ...over }, O);
	eq("§2.39 orphan with recent telemetry -> orphan", orph().state, "orphan");
	eq("§2.40 orphan alerts", orph().alert, true);
	ok("§2.41 ⚠️ the orphan is 4 days silent — a 24 h window would have MISSED it",
		orph().silentHours > O.staleHours && orph().alert === true);
	eq("§2.42 orphan outside the lookback -> orphan_idle", orph({ lastFixMs: NOW - 200 * DAY }).state, "orphan_idle");
	eq("§2.43 orphan outside the lookback does NOT alert", orph({ lastFixMs: NOW - 200 * DAY }).alert, false);
	eq("§2.44 orphan with no telemetry at all -> orphan_idle", orph({ lastFixMs: null }).state, "orphan_idle");

	// Whole-fleet roll-up, ordered worst-first.
	const judged = feedLib.judgeEldFeeds({
		trucks: [
			{ truckId: 1, unitNumber: "a", status: "Active", retiredAt: "", vehicleId: "a", lastFixMs: NOW - 2 * DAY, fixes24h: 0 },
			{ truckId: 2, unitNumber: "b", status: "Active", retiredAt: "", vehicleId: "b", lastFixMs: NOW - 54 * DAY, fixes24h: 0 },
			{ truckId: 3, unitNumber: "c", status: "Active", retiredAt: "", vehicleId: "c", lastFixMs: NOW - 60 * 1000, fixes24h: 300 },
		],
		orphans: [{ vehicleId: "z", lastFixMs: NOW - 4 * DAY, fixes24h: 1 }],
	}, O);
	eq("§2.45 every feed is judged", judged.feeds.length, 4);
	eq("§2.46 three alert", judged.alerts.length, 3);
	eq("§2.47 worst (longest silence) sorts first", judged.alerts[0].vehicleId, "b");
	const sum = feedLib.summarizeFeeds(judged.feeds);
	eq("§2.48 summary counts alerting", sum.alerting, 3);
	eq("§2.49 summary counts ok", sum.ok, 1);
	eq("§2.50 summary counts total", sum.total, 4);
}

// ════════════════════════════════════ §3 BEHAVIOURAL — real DB, shipped queries
section("§3 behavioural — the shipped sweep against a real SQLite database");

async function run() {
	{
		const now = Date.now();
		const db = seedProduction(freshDb(), now);
		const S = loadShipped(db);

		// The shipped snapshot query — executed, not inspected.
		const snap = S.eldFeedSnapshot(now);
		eq("§3.1 snapshot sees every truck", snap.trucks.length, 7);
		eq("§3.2 snapshot finds the orphan device", snap.orphans.filter((o) => o.vehicleId === VID.orphan).length, 1);
		const t302 = snap.trucks.find((t) => t.vehicleId === VID.t302);
		ok("§3.3 ⚠️ a dropped row does NOT count as the feed being alive",
			t302.lastFixMs < now - 50 * DAY, `last fix was ${Math.round((now - t302.lastFixMs) / DAY)}d ago`);

		const r = await S.sweepEldFeedSilence();

		// (a) — the 54-day gap.
		const a302 = alertRow(db, VID.t302);
		ok("§3.4 #302's 54-day gap produced a ledger row", !!a302);
		eq("§3.5 #302 is recorded as `stale`", a302 && a302.alert_condition, "stale");
		eq("§3.6 #302 carries its unit number", a302 && a302.truck_unit, "LogisX-#302");
		ok("§3.7 #302 was delivered (alerted_at stamped)", !!(a302 && a302.alerted_at));
		eq("§3.8 exactly ONE notification for #302",
			db.prepare("SELECT COUNT(*) c FROM dispatch_notifications WHERE metadata LIKE ?").get(`%${VID.t302}%`).c, 1);
		eq("§3.9 exactly ONE email for #302", S.rec.emails.filter((e) => e.html.includes(VID.t302)).length, 1);
		eq("§3.10 exactly ONE socket emit for #302", S.rec.emits.filter((e) => e.payload.metadata.vehicleId === VID.t302).length, 1);

		// (a) — #2372's 39-day gap, the Routemate half of the same condition.
		ok("§3.11 #2372's 39-day gap also alerts", !!alertRow(db, VID.t2372));
		// (b)
		const orphanRow = alertRow(db, VID.orphan);
		ok("§3.12 (b) the unlinked device alerts", !!orphanRow);
		eq("§3.13 (b) is recorded as `orphan`", orphanRow && orphanRow.alert_condition, "orphan");
		// (c)
		const trickleRow = alertRow(db, VID.trickle);
		ok("§3.14 (c) the 1-ping/day trickle alerts", !!trickleRow);
		eq("§3.15 (c) is recorded as `trickle`", trickleRow && trickleRow.alert_condition, "trickle");
		ok("§3.16 ⚠️ (c)'s feed is FRESH — condition (a) could never have caught it",
			trickleRow && trickleRow.silent_hours < feedLib.DEFAULT_STALE_HOURS);

		// Deliberate non-alerts.
		ok("§3.17 the retired truck does NOT alert", !alertRow(db, VID.retired));
		ok("§3.18 healthy #33 does NOT alert", !alertRow(db, VID.t33));
		ok("§3.19 healthy #91 does NOT alert", !alertRow(db, VID.t91));
		eq("§3.20 INV-24-A (no device) does NOT alert",
			db.prepare("SELECT COUNT(*) c FROM eld_feed_alerts WHERE truck_unit = 'INV-24-A'").get().c, 0);

		eq("§3.21 exactly four feeds alert in total", openAlerts(db).length, 4);
		eq("§3.22 sweep reports what it did", r.alerted, 4);
		eq("§3.23 sweep resolved nothing on a first run", r.resolved, 0);

		// INV-24-A is SURFACED even though it never alerts — being absent from the
		// health view is how it stayed unnoticed in the first place.
		const health = S.eldFeedHealthReport(now);
		const inv = health.feeds.find((f) => f.unitNumber === "INV-24-A");
		ok("§3.24 INV-24-A appears in the feeds array", !!inv);
		eq("§3.25 INV-24-A is reported as no_device", inv && inv.state, "no_device");
		eq("§3.26 INV-24-A is not flagged alerting", inv && inv.alerting, false);
		db.close();
	}

	// ─────────────────────────────────────────────── §4 lifecycle
	section("§4 lifecycle — dedupe, resolve, re-open, first_seen");
	{
		const now = Date.now();
		const db = seedProduction(freshDb(), now);
		const S = loadShipped(db);

		await S.sweepEldFeedSilence();
		const first = alertRow(db, VID.t302);
		const firstSeen = first.first_seen;
		const alertedAt = first.alerted_at;
		const notifCount1 = db.prepare("SELECT COUNT(*) c FROM dispatch_notifications").get().c;
		const mail1 = S.rec.emails.length;

		// DEDUPE — the same unresolved condition must not ping again.
		await S.sweepEldFeedSilence();
		await S.sweepEldFeedSilence();
		eq("§4.1 no second alert while still unresolved", S.rec.emails.length, mail1);
		eq("§4.2 no second notification while still unresolved",
			db.prepare("SELECT COUNT(*) c FROM dispatch_notifications").get().c, notifCount1);
		eq("§4.3 still exactly one ledger row for #302",
			db.prepare("SELECT COUNT(*) c FROM eld_feed_alerts WHERE alert_key = ?").get(`vid:${VID.t302}`).c, 1);
		eq("§4.4 alerted_at is not restamped", alertRow(db, VID.t302).alerted_at, alertedAt);

		// RESOLVE — a fresh ping arrives.
		const fresh = db.prepare(
			"INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms, dropped_reason, source) VALUES (?,?,?,?,?,?,?)",
		).run(VID.t302, 29.7, -95.4, 20, Date.now() - 60 * 1000, "", "linxup");
		// One ping is enough to clear (a) but not (c), so top the feed up past the
		// fix floor — otherwise this would resolve `stale` and immediately re-open
		// as `trickle`, which is correct behaviour but tests a different thing.
		for (let i = 1; i < 40; i++) {
			db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms, dropped_reason, source) VALUES (?,?,?,?,?,?,?)")
				.run(VID.t302, 29.7, -95.4, 20, Date.now() - i * 60 * 1000, "", "linxup");
		}
		const r2 = await S.sweepEldFeedSilence();
		const resolvedRow = alertRow(db, VID.t302);
		ok("§4.5 a fresh ping RESOLVES the alert", !!resolvedRow.resolved_at);
		ok("§4.6 the sweep counted the resolution", r2.resolved >= 1);
		eq("§4.7 first_seen is untouched by resolution", resolvedRow.first_seen, firstSeen);

		// RE-OPEN — the device dies a second time. This is the case a bare
		// `alerted_at` short-circuit would silence forever.
		db.prepare("DELETE FROM routemate_telemetry WHERE routemate_vehicle_id = ? AND location_date_ms > ?")
			.run(VID.t302, Date.now() - DAY);
		const mail2 = S.rec.emails.length;
		await S.sweepEldFeedSilence();
		const reopened = alertRow(db, VID.t302);
		eq("§4.8 re-silence clears resolved_at (the row re-opens)", reopened.resolved_at, null);
		eq("§4.9 ⚠️ first_seen SURVIVES the round trip", reopened.first_seen, firstSeen);
		ok("§4.10 the re-open alerts again", S.rec.emails.length > mail2);
		eq("§4.11 still exactly one ledger row (upsert, not a second row)",
			db.prepare("SELECT COUNT(*) c FROM eld_feed_alerts WHERE alert_key = ?").get(`vid:${VID.t302}`).c, 1);
		ok("§4.12 alerted_at is restamped on the re-open", alertRow(db, VID.t302).alerted_at !== alertedAt);
		void fresh;
		db.close();
	}

	// Resolution by RETIREMENT and by going Inactive — both are legitimate
	// closures and both must clear the row, or a recurrence can never re-open.
	{
		const now = Date.now();
		const db = seedProduction(freshDb(), now);
		const S = loadShipped(db);
		await S.sweepEldFeedSilence();
		ok("§4.13 #2372 is open before retirement", !alertRow(db, VID.t2372).resolved_at);
		db.prepare("UPDATE trucks SET retired_at = '2026-09-01' WHERE routemate_vehicle_id = ?").run(VID.t2372);
		await S.sweepEldFeedSilence();
		ok("§4.14 retiring the truck resolves its alert", !!alertRow(db, VID.t2372).resolved_at);
		db.prepare("UPDATE trucks SET retired_at = '', status = 'Inactive' WHERE routemate_vehicle_id = ?").run(VID.t2372);
		await S.sweepEldFeedSilence();
		ok("§4.15 an Inactive truck stays resolved", !!alertRow(db, VID.t2372).resolved_at);
		db.close();
	}

	// DELIVERY GATING. An alert that never went out must not look, in this table,
	// exactly like one that did.
	{
		const now = Date.now();
		const db = seedProduction(freshDb(), now);
		const S = loadShipped(db, { mailFails: true, notifyThrows: true });
		await S.sweepEldFeedSilence();
		const row = alertRow(db, VID.t302);
		ok("§4.16 an undelivered alert still records the sighting", !!row);
		eq("§4.17 ⚠️ alerted_at stays NULL when nothing was delivered", row.alerted_at, null);
		// ... and therefore retries rather than going quiet forever.
		const S2 = loadShipped(db, {});
		await S2.sweepEldFeedSilence();
		ok("§4.18 the next sweep RETRIES the undelivered alert", S2.rec.emails.length > 0);
		ok("§4.19 the retry stamps alerted_at", !!alertRow(db, VID.t302).alerted_at);
		eq("§4.20 first_seen was never lost across the retry", alertRow(db, VID.t302).first_seen, row.first_seen);
		db.close();
	}

	// The in-app notification alone counts as delivery — it is the channel that
	// still works with no GMAIL_* configured at all.
	{
		const db = seedProduction(freshDb(), Date.now());
		const S = loadShipped(db, { mailFails: true });
		await S.sweepEldFeedSilence();
		ok("§4.21 a dispatch notification alone counts as delivery", !!alertRow(db, VID.t302).alerted_at);
		db.close();
	}

	// ─────────────────────────────────────────────── §5 flag + health + mutants
	section("§5 flag, health endpoints, and mutants");
	{
		const db = seedProduction(freshDb(), Date.now());
		const S = loadShipped(db, { enabled: false });
		await S.maybeSweepEldFeedSilence();
		eq("§5.1 ELD_STALE_ALERT_ENABLED=false writes no ledger row",
			db.prepare("SELECT COUNT(*) c FROM eld_feed_alerts").get().c, 0);
		eq("§5.2 ELD_STALE_ALERT_ENABLED=false sends no mail", S.rec.emails.length, 0);
		eq("§5.3 ELD_STALE_ALERT_ENABLED=false sends no notification",
			db.prepare("SELECT COUNT(*) c FROM dispatch_notifications").get().c, 0);
		// ...and ON is the default, proven against the same fixture.
		const S2 = loadShipped(db, {});
		await S2.maybeSweepEldFeedSilence();
		ok("§5.4 with the flag ON the same fixture alerts", db.prepare("SELECT COUNT(*) c FROM eld_feed_alerts").get().c > 0);
		db.close();
	}

	{
		// HEALTH REPORT — DB-derived, so it survives a restart. Simulated by
		// throwing the whole closure away and rebuilding it from source against
		// the SAME database, which is exactly what pm2 does.
		const now = Date.now();
		const db = seedProduction(freshDb(), now);
		const S = loadShipped(db);
		await S.sweepEldFeedSilence();
		const before = S.eldFeedHealthReport(now);

		const S2 = loadShipped(db);   // "restart": all in-memory state is gone
		const after = S2.eldFeedHealthReport(now);
		eq("§5.5 ⚠️ the feeds array SURVIVES a restart", JSON.stringify(after.feeds), JSON.stringify(before.feeds));
		eq("§5.6 feed count matches the fleet + orphans", after.feeds.length, 8);
		const f302 = after.feeds.find((f) => f.vehicleId === VID.t302);
		eq("§5.7 the silent feed is still reported as stale after a restart", f302.state, "stale");
		ok("§5.8 its ledger first_seen survived the restart", !!f302.firstSeen);
		ok("§5.9 its alertedAt survived the restart", !!f302.alertedAt);
		ok("§5.10 lastFixAt is an explicit ISO-8601 Z string", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(f302.lastFixAt));
		ok("§5.11 firstSeen is an explicit ISO-8601 Z string", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(f302.firstSeen));
		ok("§5.12 the report echoes no token or key", !/token|secret|api_?key/i.test(JSON.stringify(after)));
		eq("§5.13 thresholds are published so the number is not a mystery", after.thresholds.staleHours, feedLib.DEFAULT_STALE_HOURS);
		eq("§5.14 summary agrees with the feeds array", after.summary.total, after.feeds.length);
		eq("§5.15 four feeds are alerting", after.summary.alerting, 4);
		// Provenance is reported, never branched on — and '' is the COMMON case.
		ok("§5.16 provenance is surfaced per feed", after.feeds.every((f) => typeof f.source === "string"));
		eq("§5.17 ⚠️ a pre-source-column Linxup feed reports source '' and is STILL listed", f302.source, "");
		db.close();
	}

	{
		// ⚠️ MUTANT 1 — fuel_event_alerts' bare `alerted_at` short-circuit. Correct
		// for a point event (a refuel cannot recur), catastrophic here: the feed is
		// silenced forever after its first ping, including after a repair-and-die.
		const db = seedProduction(freshDb(), Date.now());
		const S = loadShipped(db, {}, (s) => s.replace(
			"if (seen && seen.alerted_at && !seen.resolved_at) return",
			"if (seen && seen.alerted_at) return",
		));
		await S.sweepEldFeedSilence();
		for (let i = 1; i < 40; i++) {
			db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms, dropped_reason, source) VALUES (?,?,?,?,?,?,?)")
				.run(VID.t302, 29.7, -95.4, 20, Date.now() - i * 60 * 1000, "", "linxup");
		}
		await S.sweepEldFeedSilence();                                   // resolves
		db.prepare("DELETE FROM routemate_telemetry WHERE routemate_vehicle_id = ? AND location_date_ms > ?").run(VID.t302, Date.now() - DAY);
		const before = S.rec.emails.length;
		await S.sweepEldFeedSilence();                                   // re-silence
		ok("§5.18 MUTANT (bare alerted_at short-circuit) is CAUGHT — the re-open goes silent",
			S.rec.emails.length === before);
		db.close();
	}

	{
		// ⚠️ MUTANT 2 — stamp alerted_at before the send. A transient Gmail 4xx then
		// suppresses the feed forever, and the table cannot tell the two apart.
		const db = seedProduction(freshDb(), Date.now());
		const S = loadShipped(db, { mailFails: true, notifyThrows: true }, (s) =>
			s.replace("const delivered = emailed || notified;", "const delivered = true;"));
		await S.sweepEldFeedSilence();
		ok("§5.19 MUTANT (stamp before send) is CAUGHT — an undelivered alert looks delivered",
			!!alertRow(db, VID.t302).alerted_at);
		db.close();
	}

	{
		// ⚠️ MUTANT 3 — drop condition (c). The trickle stops being reported and the
		// detector silently becomes "stale only", which is where this started.
		const db = seedProduction(freshDb(), Date.now());
		const S = loadShipped(db, { minFixes: 1 });   // floor of 1 ⇒ (c) can never fire
		await S.sweepEldFeedSilence();
		ok("§5.20 MUTANT (no trickle floor) is CAUGHT — the 1-ping/day feed goes unreported",
			!alertRow(db, VID.trickle));
		db.close();
	}

	{
		// ⚠️ MUTANT 4 — judge retirement with new Date() instead of a string compare,
		// and read '' as "retired long ago". That silences the WHOLE fleet, because
		// every production row has retired_at = ''.
		const inverted = (retiredAt) => String(retiredAt || "").trim() === "" ? true : false;
		ok("§5.21 MUTANT (empty retired_at read as retired) is CAUGHT — it silences every truck",
			inverted("") === true && feedLib.isRetiredOn("", "2026-09-19") === false);
	}

	{
		// ⚠️ MUTANT 5 — count clean rows with COUNT(*) instead of
		// COUNT(DISTINCT location_date_ms). A device re-pushing one timestamp then
		// reads as a healthy feed.
		// ⚠️ THE TIMESTAMP IS HOISTED OUT OF THE LOOP AND THAT IS THE WHOLE POINT.
		// Calling Date.now() inside the loop makes the 50 rows differ by a
		// millisecond or two, which is 50 DISTINCT timestamps — i.e. it quietly
		// builds a HEALTHY feed and the assertion below "fails" against correct
		// code. This test made exactly that mistake on its first run.
		const dupTs = Date.now() - 3 * HOUR;
		const db = seedProduction(freshDb(), Date.now());
		const dup = (target) => {
			for (let i = 0; i < 50; i++) {
				target.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms, dropped_reason, source) VALUES (?,?,?,?,?,?,?)")
					.run(VID.trickle, 29.7, -95.4, 0, dupTs, "", "");
			}
		};
		dup(db);
		const S = loadShipped(db);
		await S.sweepEldFeedSilence();
		ok("§5.22 50 copies of ONE timestamp is still a trickle (COUNT DISTINCT holds)", !!alertRow(db, VID.trickle));
		const mutant = loadShipped(freshDb(), {}, (s) => s.replace("COUNT(DISTINCT location_date_ms)", "COUNT(*)"));
		seedProduction(mutant.db, Date.now());
		dup(mutant.db);
		await mutant.sweepEldFeedSilence();
		ok("§5.23 MUTANT (COUNT(*) instead of COUNT DISTINCT) is CAUGHT — duplicates read as healthy",
			!alertRow(mutant.db, VID.trickle));
		db.close();
		mutant.db.close();
	}

	{
		// ⚠️ MUTANT 6 — ask routemate_vehicles for a `source` column. CLAUDE.md
		// implies it exists; production says otherwise, and the fixture is built to
		// the production column list so this throws exactly as it would on the box.
		const db = seedProduction(freshDb(), Date.now());
		let threw = "";
		try { db.prepare("SELECT source FROM routemate_vehicles LIMIT 1").get(); }
		catch (e) { threw = e.message; }
		ok("§5.24 MUTANT (routemate_vehicles.source) is CAUGHT — `no such column`", /no such column/.test(threw), threw);
		// ...while the column DOES exist on routemate_telemetry.
		let telOk = false;
		try { db.prepare("SELECT source FROM routemate_telemetry LIMIT 1").get(); telOk = true; } catch { /* noop */ }
		ok("§5.25 routemate_telemetry.source is the real column", telOk);
		db.close();
	}

	{
		// The daily cap is independent of the per-feed dedupe — the backstop that
		// still holds if the key space is ever wrong. sendEmail is SHARED with
		// onboarding, outreach and the invoice batch.
		const db = seedProduction(freshDb(), Date.now());
		const S = loadShipped(db, { maxPerDay: 2 });
		await S.sweepEldFeedSilence();
		const stamped = db.prepare("SELECT COUNT(*) c FROM eld_feed_alerts WHERE alerted_at IS NOT NULL").get().c;
		eq("§5.26 the daily cap bounds delivered alerts", stamped, 2);
		ok("§5.27 capped feeds are still RECORDED, not lost",
			db.prepare("SELECT COUNT(*) c FROM eld_feed_alerts").get().c >= 2);
		db.close();
	}

	// ---------------------------------------------------------------- report
	console.log(`\n${"─".repeat(60)}`);
	if (failures.length) {
		console.error(`FAIL — ${failures.length} failed, ${passed} passed\n`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		process.exit(1);
	}
	console.log(`PASS — ${passed} assertions, 0 failures`);
}

run().catch((e) => {
	console.error("test run threw:", e && e.stack || e);
	process.exit(1);
});
