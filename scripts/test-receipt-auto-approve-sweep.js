#!/usr/bin/env node
/**
 * Receipts auto-approve, the pass (plan §8 PR 3). The <receipt-auto-approve-wiring>
 * block is lifted from server.js and run with lib/receipt-auto-approve-pass.js and
 * the rules (lib/receipt-auto-approve.js) as shipped, beside every server.js helper
 * the block and the two status routes use (scripts/lib/server-lift.js): the
 * fuel-event detect and matcher and their latch, the month locks, the close's grace
 * rule, the price band, the Personal-line check, logAudit. The database is in memory
 * (or a temp file for the undo tool), built from server.js's own DDL. Only the outside
 * world is made up: the receipt reader (Gemini), the timers, and the drivers, trucks,
 * receipts and fills.
 *
 *   §1  flags off: no timer, no row, no audit; the matcher's default query as today
 *   §2  shadow: review rows only, no receipt written, the summary row, the timer
 *   §3  on: exactly the passing receipt approved, its record and one audit row
 *   §4  the write-set (plan §4.8), on and shadow; the in-memory match writes nothing
 *   §5  a closed month: not judged, no read
 *   §6  a person's write between the judge and the write wins
 *   §7  a person's Undo is never re-approved; both status routes mark the review undone
 *   §8  on mode never writes a Rejected or an Approved receipt
 *   §9  a Personal mark between the judge and the write: one approval, not two
 *   §10 the scanner down, the 6 failed reads, the day latch, the caps, the deadline
 *   §11 baselines
 *   §12 the undo tool (M3, NL1, NL2)
 *   §13 the hourly pass leaves alerts and the odometer to the 6-hourly sweep (NL7)
 *   §14 a receipt rejected before the pass judged it (M2, NL8)
 *   §15 SHADOW=false with the recorder off runs as shadow (M1)
 *   §16 PERSON_DECIDED (M1, NL3)
 *   §17 owner-operators (L17)
 *   §18 the close, the grace rule, the latch before the read, a quiet pass (L1, L8, L9)
 *   §19 rule 8 past the 200th group (L4)
 *   §20 the input shapes PR 2's review named; the report route
 *   §21 the report script, read-only, ids and counts only
 *
 * Made-up data only ("Sample Driver", T-1xx, example values). No network; never
 * reads app.db. Fails on a tree without the block.
 * Run: node scripts/test-receipt-auto-approve-sweep.js    # exits 1 on failure
 */
"use strict";

// A zone that is neither UTC nor the app's, so a day read on the wrong clock shows.
process.env.TZ = "Asia/Manila";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();
const { closure, codeIdentifiers, indexDeclarations } = require("./lib/server-lift");
const appTime = require(path.join(ROOT, "lib", "app-time.js"));
const { normalizeVendor } = require(path.join(ROOT, "lib", "expense-analytics.js"));
const personalExpense = require(path.join(ROOT, "lib", "personal-expense.js"));

let Database;
try { Database = require("better-sqlite3"); } catch (e) {
	console.error(`SETUP FAILED: better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`);
	process.exit(1);
}
const optional = (p) => {
	try { return require(p); } catch { return null; }
};
const passLib = optional(path.join(ROOT, "lib", "receipt-auto-approve-pass.js"));

// ------------------------------------------------------------------ checks
let passed = 0;
const failures = [];
function ok(cond, label, detail = "") {
	if (cond) { passed++; console.log(`  ok    ${label}`); return; }
	failures.push(label);
	console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	ok(a === e, label, `expected ${e}, got ${a}`);
}
async function section(title, fn) {
	console.log(`\n§ ${title}`);
	try {
		await fn();
	} catch (e) {
		ok(false, `${title}: the section ran`, (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e)));
	}
}

// ------------------------------------------------------------------ server.js, lifted
const BLOCK_START = "// <receipt-auto-approve-wiring>";
const BLOCK_END = "// </receipt-auto-approve-wiring>";
const STATUS_HEAD = 'app.put("/api/expenses/:id/status", requireRole("Super Admin", "Dispatcher"), (req, res) => {';
const BULK_HEAD = 'app.put("/api/expenses/bulk-status", requireRole("Super Admin", "Dispatcher"), (req, res) => {';
const OWN = ["receiptAutoApprovePass", "receiptAutoApproveConfig", "receiptAutoApprove"];
const PROVIDED = ["db", "app", "requireRole", "console", "require", "process", "startsJob", "setTimeout", "setInterval", "notifyChange",
	"runReceiptOcr", "RECEIPTS_DIR", "emitDispatchNotice", "insertDispatchNotification", "io"];
const EXTRA_ROOTS = ["maybeSweepFuelEvents", "fuelEventsHealth", "duplicateReceiptGroups", "matchFuelEventsToReceipts", "logAudit",
	"detectAndPersistFuelEvents", "expenseRowPeriodLocked", "isPastGrace", "settlementGraceDays", "expensePostedPeriod",
	"fuelCpgBandFromFleet", "personalLiveExpenseIds", "receiptDataUriForOcr", "normalizeDriverName", "periodLocksReadable"];
const RETURNED = ["maybeSweepFuelEvents", "fuelEventsHealth", "duplicateReceiptGroups", "matchFuelEventsToReceipts", "logAudit",
	"detectAndPersistFuelEvents", "expenseRowPeriodLocked", "isPastGrace", "settlementGraceDays", "expensePostedPeriod",
	"fuelCpgBandFromFleet", "personalLiveExpenseIds", "receiptDataUriForOcr", "normalizeDriverName", "periodLocksReadable"];

let LIFT = null;
function lift() {
	if (LIFT) return LIFT;
	const a = SRC.indexOf(BLOCK_START);
	const b = SRC.indexOf(BLOCK_END);
	if (a < 0 || b < a || SRC.split(BLOCK_START).length !== 2) throw new Error("server.js has no single <receipt-auto-approve-wiring> block");
	const block = SRC.slice(a, b + BLOCK_END.length);
	const { decls } = indexDeclarations(SRC);
	const roots = [...new Set(codeIdentifiers(block))].filter((n) => decls.has(n) && !OWN.includes(n) && !PROVIDED.includes(n));
	const lifted = closure(SRC, {
		roots: [...new Set([...roots, ...EXTRA_ROOTS])],
		routes: [STATUS_HEAD, BULK_HEAD],
		provided: [...PROVIDED, ...OWN],
		denied: ["server", "sheets", "getSheets", "getDrive", "SPREADSHEET_ID", "getJobTrackingCached", "sendEmail"],
	});
	LIFT = { block, text: lifted.text };
	return LIFT;
}

function createSql(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) throw new Error(`server.js creates no ${name} table`);
	return `CREATE TABLE ${name} (${m[1]}\n)`;
}
const altersFor = (t) => [...SRC.matchAll(new RegExp(`ALTER TABLE ${t} ADD COLUMN [^"\`]+`, "g"))].map((m) => m[0]);
const SERVER_TABLES = ["expenses", "trucks", "truck_assignments", "fuel_events", "fuel_event_alerts", "routemate_telemetry",
	"audit_trail", "period_locks", "investor_payouts", "users", "dispatch_notifications"];

function buildSchema(db) {
	for (const t of SERVER_TABLES) db.exec(createSql(t));
	for (const t of ["expenses", "trucks", "routemate_telemetry"]) {
		for (const sql of altersFor(t)) {
			try { db.exec(sql); } catch { /* a duplicate, or the text of a comment: the columns are checked below */ }
		}
	}
	const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
	for (const [t, need] of [["trucks", ["owner_id", "routemate_vehicle_id"]], ["expenses", ["owner_id", "truck_unit", "gallons", "status_by_role", "location_source", "vendor_normalized", "receipt_details", "posted_period"]]]) {
		const missing = need.filter((c) => !cols(t).includes(c));
		if (missing.length) throw new Error(`${t} lacks ${missing.join(", ")} after server.js's ALTERs`);
	}
	db.exec("CREATE TABLE investor_config (owner_id INTEGER NOT NULL DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (owner_id, key))");
	db.exec(personalExpense.SCHEMA_SQL);
}

// ------------------------------------------------------------------ made-up world
const NOW = Date.now();
const H = 3600 * 1000;
const D = 24 * H;
const sqlStamp = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const bday = (ms) => appTime.appDay(new Date(ms));
const shiftDay = (key, n) => {
	const d = new Date(`${key}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
};
const photoOf = (id) => `data:image/png;base64,${Buffer.from(`made-up-receipt-${id}`).toString("base64")}`;
const idFromUri = (uri) => Number(/made-up-receipt-(\d+)/.exec(Buffer.from(String(uri).split(",")[1] || "", "base64").toString())?.[1]);
const LAT = 35.2;
const LNG = -97.4;
const ADMIN = Object.freeze({ id: 1, username: "made_up_admin", role: "Super Admin" });
const DISPATCHER = Object.freeze({ id: 2, username: "made_up_dispatcher", role: "Dispatcher" });
const SHADOW_ENV = Object.freeze({ RECEIPT_AUTO_APPROVE_ENABLED: "true", FUEL_EVENTS_ENABLED: "true", GEMINI_API_KEY: "made-up-gemini-key" });
const ON_ENV = Object.freeze({ ...SHADOW_ENV, RECEIPT_AUTO_APPROVE_SHADOW: "false", RECEIPT_STATUS_RECORDER_ENABLED: "true" });
const OFF_ENV = Object.freeze({ FUEL_EVENTS_ENABLED: "true", GEMINI_API_KEY: "made-up-gemini-key" });

function world({ env = SHADOW_ENV, file = null, startsJobAnswer = true, baselineDaysAgo = 5 } = {}) {
	const L = lift();
	const db = new Database(file || ":memory:");
	buildSchema(db);
	const w = { db, env: { ...env }, logs: [], startsJob: [], timeouts: [], intervals: [], routes: {}, reads: [], readFn: null, readHook: null };
	db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (1, 'made_up_admin', 'x', 'Super Admin', ''), (2, 'made_up_dispatcher', 'x', 'Dispatcher', '')").run();

	const app = {};
	for (const verb of ["get", "put", "post", "patch", "delete"]) app[verb] = (p, ...h) => { w.routes[`${verb.toUpperCase()} ${p}`] = h; };
	app.use = () => {};
	const requireRole = (...roles) => (req, res, next) => (req.session && req.session.user && roles.includes(req.session.user.role)
		? next() : res.status(403).json({ error: "forbidden" }));
	const quiet = { log: (...a) => w.logs.push(a.join(" ")), info: () => {}, warn: (...a) => w.logs.push(a.join(" ")), error: (...a) => w.logs.push(a.join(" ")) };
	const rootRequire = (m) => require(m.startsWith("./") ? path.join(ROOT, m) : m);
	const proc = Object.create(process, { env: { value: w.env } });
	const runReceiptOcr = async (uri) => {
		const id = idFromUri(uri);
		w.reads.push(id);
		if (w.readHook) await w.readHook(id);
		if (w.readFn) return w.readFn(id);
		return goodOcr(db, id);
	};
	const values = {
		db, app, requireRole, console: quiet, require: rootRequire, process: proc,
		startsJob: (name) => { w.startsJob.push(name); return startsJobAnswer; },
		setTimeout: (fn, ms) => { w.timeouts.push({ fn, ms }); return 0; },
		setInterval: (fn, ms) => { w.intervals.push({ fn, ms }); return 0; },
		notifyChange: () => {},
		runReceiptOcr,
		RECEIPTS_DIR: path.join(os.tmpdir(), "made-up-receipts-none"),
		emitDispatchNotice: () => {},
		insertDispatchNotification: { run: () => ({ changes: 1 }) },
		io: null,
	};
	const body = `"use strict";\n${L.text}\n${L.block}\nreturn { receiptAutoApprove, receiptAutoApproveConfig, ${RETURNED.join(", ")},
		setFuelLatch: (v) => { fuelEventsRunning = v; }, fuelLatch: () => fuelEventsRunning,
		setCloseRunning: (v) => { periodCloseRunning = v; } };`;
	w.S = new Function(...PROVIDED, body)(...PROVIDED.map((p) => values[p]));
	w.pass = w.S.receiptAutoApprove;
	if (baselineDaysAgo != null) {
		const at = new Date(NOW - baselineDaysAgo * D).toISOString();
		db.prepare("INSERT INTO receipt_auto_meta (key, value) VALUES ('shadow_baseline_at', ?), ('on_baseline_at', ?)").run(at, at);
	}
	w.call = (method, route, req, user = ADMIN) => {
		const hs = w.routes[`${method} ${route}`];
		if (!hs) throw new Error(`no route ${method} ${route}`);
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		const rq = { session: { user }, query: {}, params: {}, body: {}, headers: {}, ...req };
		let i = 0;
		const next = () => { const h = hs[i++]; if (h) h(rq, res, next); };
		next();
		return out;
	};
	return w;
}

// The reader's answer for a stored receipt: what its row says, read cleanly.
function goodOcr(db, id) {
	const r = db.prepare("SELECT amount, date, vendor, gallons, location_state FROM expenses WHERE id = ?").get(id);
	return {
		amount: r.amount, date: r.date, vendor: r.vendor, gallons: r.gallons, state: r.location_state, confidence: "high",
		details: [{ label: "Price/Gal", value: (r.amount / r.gallons).toFixed(3) }, { label: "Auth Code", value: `AC${id}9` }, { label: "Pump", value: "7" }],
	};
}

// Driver n holds truck T-n (owner 100 + n) from 60 days back; receipt n on it, with a
// fill the matcher pairs with it that day. `fill: false` leaves the fill out.
function fixture(w, n, { receipt = {}, fill = {}, assignment = {}, noFill = false, createdMs = NOW - 30 * H } = {}) {
	const { db } = w;
	const unit = `T-${n}`;
	const vid = `VID-${n}`;
	db.prepare("INSERT INTO trucks (id, unit_number, owner_id, routemate_vehicle_id) VALUES (?, ?, ?, ?)").run(n, unit, 100 + n, vid);
	const a = { truck_id: n, driver_name: `Sample Driver ${n}`, start_date: bday(NOW - 60 * D), end_date: "", ...assignment };
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (@truck_id, @driver_name, @start_date, @end_date)").run(a);
	addReceipt(w, { id: n, driver: `Sample Driver ${n}`, truck_unit: unit, owner_id: 100 + n, createdMs, ...receipt });
	const day = db.prepare("SELECT date FROM expenses WHERE id = ?").get(n).date;
	if (!noFill) addFill(w, { id: n, vid, day, ...fill });
	return { unit, vid, day };
}
function addReceipt(w, over) {
	const createdMs = over.createdMs != null ? over.createdMs : NOW - 30 * H;
	const vendor = over.vendor != null ? over.vendor : "Pilot";
	const row = {
		timestamp: new Date(createdMs).toISOString(), driver: "Sample Driver", load_id: "", type: "Fuel", amount: 400, description: "",
		date: bday(createdMs), photo_data: photoOf(over.id), status: "Pending", created_at: sqlStamp(createdMs), gallons: 100, odometer: 0,
		owner_id: 100, truck_unit: "", location_city: "Sample City", location_state: "OK", location_lat: LAT, location_lng: LNG,
		location_source: "geocode", vendor, vendor_normalized: normalizeVendor(vendor), receipt_details: "", posted_period: "",
		...over,
	};
	delete row.createdMs;
	const cols = Object.keys(row);
	w.db.prepare(`INSERT INTO expenses (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
}
function addFill(w, { id, vid, day, before = 30, after = 80, lat = LAT + 0.05, lng = LNG, odometer = 0 }) {
	const start = Date.parse(`${day}T16:00:00Z`);
	w.db.prepare(`INSERT INTO fuel_events (id, routemate_vehicle_id, start_ms, end_ms, local_day, pct_before, pct_after, odometer, odo_span, latitude, longitude)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(id, vid, start, start + 10 * 60 * 1000, day, before, after, odometer, lat, lng);
}

const rowsOf = (db, sql, ...p) => db.prepare(sql).all(...p);
const review = (w, id) => w.db.prepare("SELECT * FROM receipt_auto_reviews WHERE expense_id = ?").get(id);
const expense = (w, id) => w.db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
const audits = (w, action) => rowsOf(w.db, "SELECT * FROM audit_trail WHERE action = ? ORDER BY id", action);
const reasonsOf = (w, id) => JSON.parse((review(w, id) || {}).reasons || "null");
function dump(db) {
	const out = {};
	for (const { name } of rowsOf(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
		out[name] = rowsOf(db, `SELECT * FROM "${name}" ORDER BY rowid`);
	}
	return out;
}
const STATUS_COLS = new Set(["status", "status_by_role", "status_by_id", "status_by_name", "status_at"]);
// Every expenses column that changed, as "id.column".
function expenseChanges(before, after) {
	const out = [];
	const byId = new Map(after.map((r) => [r.id, r]));
	for (const b of before) {
		const a = byId.get(b.id) || {};
		for (const k of Object.keys(b)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(`${b.id}.${k}`);
	}
	if (after.length !== before.length) out.push("row count");
	return out;
}

// ------------------------------------------------------------------ the cases
async function main() {
	await section("1. flags off (unset, \"1\", \"TRUE\"): no timer, no row, no audit", async () => {
		for (const [label, value] of [["unset", undefined], ["'1'", "1"], ["'TRUE'", "TRUE"]]) {
			const env = { ...OFF_ENV };
			if (value !== undefined) env.RECEIPT_AUTO_APPROVE_ENABLED = value;
			const w = world({ env, baselineDaysAgo: null });
			fixture(w, 101);
			const before = dump(w.db);
			const r = await w.pass.run();
			eq(r, { skipped: "off" }, `${label}: a pass does nothing`);
			ok(w.logs.includes("[receipt-auto-approve] RECEIPT_AUTO_APPROVE_ENABLED off"), `${label}: the start-up line says off`, JSON.stringify(w.logs));
			eq([w.startsJob.filter((n) => /receipt auto-approve/.test(n)), w.timeouts.length, w.intervals.length], [[], 0, 0], `${label}: no timer is asked for or set`);
			eq(w.reads, [], `${label}: no read`);
			eq(JSON.stringify(dump(w.db)) === JSON.stringify(before), true, `${label}: nothing in the database changed`);
			const tables = rowsOf(w.db, "SELECT name FROM sqlite_master WHERE name IN ('receipt_auto_reviews', 'receipt_auto_meta') ORDER BY name").map((t) => t.name);
			eq(tables, ["receipt_auto_meta", "receipt_auto_reviews"], `${label}: the two tables exist, empty (created at boot whatever the flags)`);
			const got = w.call("GET", "/api/admin/receipt-auto-approve", {});
			eq([got.status, got.body && got.body.mode, got.body && "receipts" in got.body], [200, "off", false], `${label}: the report route answers mode off, counts only`);
			// The status routes prepare nothing for the pass's table.
			const seen = [];
			const prep = w.db.prepare.bind(w.db);
			w.db.prepare = (sql) => { seen.push(sql); return prep(sql); };
			w.call("PUT", "/api/expenses/:id/status", { params: { id: "101" }, body: { status: "Rejected" } });
			w.call("PUT", "/api/expenses/bulk-status", { body: { ids: [101], status: "Pending" } });
			w.db.prepare = prep;
			eq(seen.filter((s) => /receipt_auto/.test(s)), [], `${label}: the status routes touch no review row`);
		}
		// The matcher's default call builds today's receipts query, byte for byte.
		const w = world({ env: OFF_ENV });
		const seen = [];
		const prep = w.db.prepare.bind(w.db);
		w.db.prepare = (sql) => { seen.push(sql); return prep(sql); };
		w.S.matchFuelEventsToReceipts({ persist: false, writeReceipts: false });
		w.db.prepare = prep;
		const today = "\t\tSELECT id, date, truck_unit, gallons, amount, vendor, odometer,\n\t\t       location_lat AS lat, location_lng AS lng, receipt_details,\n"
			+ "\t\t       posted_period, created_at\n\t\tFROM expenses\n\t\tWHERE type = 'Fuel' AND COALESCE(date,'') <> '' AND date >= ?\n"
			+ "\t\t  AND COALESCE(status, '') != 'Rejected'\n\t\tORDER BY date ASC, id ASC\n\t";
		ok(seen.includes(`\n${today}`), "the matcher's default receipts query is today's exactly", JSON.stringify(seen.filter((s) => /FROM expenses/.test(s))));
	});

	await section("2. shadow: review rows only, no receipt written, the summary row, the timer", async () => {
		const w = world({ env: SHADOW_ENV });
		fixture(w, 101);
		fixture(w, 102, { fill: { lat: LAT + 0.6 } });
		const before = dump(w.db);
		await w.pass.run();
		const after = dump(w.db);
		eq(expenseChanges(before.expenses, after.expenses), [], "no expenses column changed");
		eq([review(w, 101).verdict, review(w, 101).mode], ["approve", "shadow"], "the passing receipt: would approve, in shadow");
		eq([review(w, 102).verdict, reasonsOf(w, 102)], ["hold", ["PLACE_FAR"]], "the receipt whose fill is 67 km away: held PLACE_FAR");
		eq(w.reads, [101], "only the receipt that passed rules 1-10 was read");
		eq(audits(w, "receipt_auto_approve_pass").length, 1, "one summary audit row");
		ok(/^shadow pass, rules v1: 2 judged, 1 would approve, 0 approved, 1 held/.test(audits(w, "receipt_auto_approve_pass")[0].details), "the summary row gives counts only", audits(w, "receipt_auto_approve_pass")[0].details);
		eq(audits(w, "update_expense_status").length, 0, "no status audit row");
		ok(w.logs.includes("[receipt-auto-approve] shadow, every 60 min; reads 20 a pass, 30 a day"), "the start-up line says shadow", JSON.stringify(w.logs));
		eq(w.startsJob.includes("receipt auto-approve pass"), true, "the timer asks startsJob()");
		eq(w.timeouts.map((t) => t.ms), [7 * 60 * 1000], "the first pass waits 7 minutes after boot (off the 6-hourly sweep's hour)");
		w.timeouts[0].fn();
		eq(w.intervals.map((t) => t.ms), [60 * 60 * 1000], "then every 60 minutes");
		const repl = world({ env: SHADOW_ENV, startsJobAnswer: false });
		eq([repl.timeouts.length, repl.intervals.length], [0, 0], "a replica or an import (startsJob() no) sets no timer");
	});

	await section("3. on: exactly the passing receipt approved, its record, one audit row", async () => {
		const w = world({ env: ON_ENV });
		fixture(w, 101);
		fixture(w, 102, { fill: { lat: LAT + 0.6 } });
		await w.pass.run();
		const e = expense(w, 101);
		const rv = review(w, 101);
		eq([e.status, e.status_by_role, e.status_by_id, e.status_by_name], ["Approved", "system", 0, "receipt-auto-approve"], "101 approved by the system actor");
		ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.status_at) && e.status_at === rv.applied_at, "its status_at is the review row's applied_at", `${e.status_at} vs ${rv.applied_at}`);
		eq([expense(w, 102).status, expense(w, 102).status_by_role], ["Pending", ""], "102 (held) left as it was");
		const a = audits(w, "update_expense_status");
		eq(a.map((x) => [x.entity_id, x.username, x.role, x.user_id]), [["101", "receipt-auto-approve", "system", 0]], "one status audit row, the system actor's, on 101");
		ok(/^status Pending -> Approved \(automatic, rules v1: ELD fill #101 same day, \d+(\.\d)? km; receipt reads \$400\.00, \d{4}-\d{2}-\d{2}, 100 gal, OK; no duplicate; period \d{4}-\d{2}\)$/.test(a[0] && a[0].details),
			"its text carries the evidence and the period, no name", a[0] && a[0].details);
		eq(audits(w, "receipt_auto_approve_pass").length, 1, "one summary row");
		const snap = JSON.parse(rv.applied_row || "{}");
		eq([snap.amount, snap.truck_unit, snap.owner_id, snap.location_city, snap.location_state, snap.vendor, snap.gallons], [400, "T-101", 201, "Sample City", "OK", "Pilot", 100],
			"the row's own values at approval are kept (NL1)");
		ok(String(snap.photo).startsWith("sha256:"), "an inline image is kept as its digest, never the image", String(snap.photo).slice(0, 20));
		ok(w.logs.includes("[receipt-auto-approve] on, every 60 min; reads 20 a pass, 30 a day"), "the start-up line says on", JSON.stringify(w.logs));
	});

	await section("4. the write-set (plan §4.8)", async () => {
		const build = (env) => {
			const w = world({ env });
			fixture(w, 101);
			fixture(w, 102, { fill: { lat: LAT + 0.6 } });
			fixture(w, 103, { receipt: { status: "Rejected" } });
			addReceipt(w, { id: 104, type: "Other", amount: 12.5, gallons: 0, truck_unit: "T-101", driver: "Sample Driver 101" });
			w.db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2025-01', 'locked', '2025-02-15T05:00:00.000Z')").run();
			w.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date) VALUES (201, '2025-01', 1234.5, '2025-02-15')").run();
			w.db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata) VALUES ('made-up', 'A made-up notice', '', '{}')").run();
			w.db.prepare("INSERT INTO fuel_event_alerts (event_key, routemate_vehicle_id, local_day, rise_pct) VALUES ('VID-9@1', 'VID-9', '2025-01-02', 40)").run();
			w.S.logAudit({ session: { user: ADMIN } }, "made_up_action", "expense", "104", "an earlier made-up row");
			return w;
		};
		for (const env of [ON_ENV, SHADOW_ENV]) {
			const mode = env === ON_ENV ? "on" : "shadow";
			const w = build(env);
			// The detect-and-match step alone: fuel_events only.
			const b0 = dump(w.db);
			w.S.detectAndPersistFuelEvents();
			w.S.matchFuelEventsToReceipts({ persist: true, writeReceipts: false });
			const b1 = dump(w.db);
			eq(Object.keys(b0).filter((t) => t !== "fuel_events" && JSON.stringify(b0[t]) !== JSON.stringify(b1[t])), [], `${mode}: detect and match change no table but fuel_events`);
			const before = dump(w.db);
			await w.pass.run();
			const after = dump(w.db);
			const allowed = new Set(["expenses", "receipt_auto_reviews", "receipt_auto_meta", "audit_trail", "fuel_events"]);
			eq(Object.keys(before).filter((t) => !allowed.has(t) && JSON.stringify(before[t]) !== JSON.stringify(after[t])), [], `${mode}: every other table byte-identical`);
			const fe = (rows) => rows.map(({ expense_id, match_basis, match_distance_km, matched_gallons, ...rest }) => rest);
			eq(JSON.stringify(fe(after.fuel_events)) === JSON.stringify(fe(before.fuel_events)), true, `${mode}: fuel_events keeps every fill; only links may move`);
			const changed = expenseChanges(before.expenses, after.expenses);
			if (mode === "on") {
				eq(changed.every((c) => c.startsWith("101.") && STATUS_COLS.has(c.split(".")[1])), true, "on: expenses changes only 101's status and its record", JSON.stringify(changed));
				eq(changed.length, 5, "on: exactly those five columns", JSON.stringify(changed));
			} else {
				eq(changed, [], "shadow: no expenses column changes");
			}
			eq(JSON.stringify(after.audit_trail.slice(0, before.audit_trail.length)) === JSON.stringify(before.audit_trail), true, `${mode}: earlier audit rows untouched`);
			const added = after.audit_trail.slice(before.audit_trail.length).map((a) => `${a.action}:${a.entity_id}`);
			eq(added, mode === "on" ? ["update_expense_status:101", "receipt_auto_approve_pass:"] : ["receipt_auto_approve_pass:"], `${mode}: the audit rows added are the approvals and one summary`);
			// The in-memory match that includes Rejected receipts writes nothing at all, even asked to persist.
			const m0 = dump(w.db);
			const mem = w.S.matchFuelEventsToReceipts({ persist: false, writeReceipts: false, includeRejected: true });
			w.S.matchFuelEventsToReceipts({ persist: true, writeReceipts: true, includeRejected: true });
			eq(JSON.stringify(dump(w.db)) === JSON.stringify(m0), true, `${mode}: the in-memory match including Rejected receipts writes nothing`);
			eq(mem.matched.some((m) => m.r.id === 103), true, `${mode}: …and it does pair the Rejected receipt with its fill`);
		}
	});

	await section("5. a closed month: not judged, no read", async () => {
		for (const env of [SHADOW_ENV, ON_ENV]) {
			const w = world({ env });
			// The longest grace, so the lock (not the close's due date) is what keeps it out.
			w.db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'settlement_grace_days', '28')").run();
			const lastMonth = shiftDay(`${bday(NOW).slice(0, 7)}-01`, -1).slice(0, 7);
			fixture(w, 101, { receipt: { date: `${lastMonth}-15` }, fill: {} });
			w.db.prepare("UPDATE fuel_events SET local_day = ? WHERE id = 101").run(`${lastMonth}-15`);
			w.db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, 'locked', ?)").run(lastMonth, new Date(NOW - D).toISOString());
			fixture(w, 102);
			await w.pass.run();
			eq([review(w, 101), w.reads.includes(101)], [undefined, false], `${env === ON_ENV ? "on" : "shadow"}: the closed-month receipt has no review row and no read`);
			eq(review(w, 102) && review(w, 102).verdict, "approve", `${env === ON_ENV ? "on" : "shadow"}: the open-month receipt beside it is judged`);
		}
		const w = world({ env: ON_ENV });
		fixture(w, 101);
		w.db.exec("DROP TABLE period_locks");
		await w.pass.run();
		eq([review(w, 101), w.reads, expense(w, 101).status], [undefined, [], "Pending"], "an unreadable lock table: nothing judged, read or written (fails closed)");

		// A receipt dated after the day it was filed is never a candidate.
		const f = world({ env: ON_ENV });
		fixture(f, 101, { receipt: { date: shiftDay(bday(NOW - 30 * H), 1) } });
		f.db.prepare("UPDATE fuel_events SET local_day = ? WHERE id = 101").run(shiftDay(bday(NOW - 30 * H), 1));
		await f.pass.run();
		eq([review(f, 101), f.reads], [undefined, []], "a future-dated receipt is not judged");
	});

	await section("6. a person's write between the judge and the write wins", async () => {
		const w = world({ env: ON_ENV });
		for (const n of [101, 102, 103, 104, 105]) fixture(w, n);
		w.readHook = async (id) => {
			const at = new Date().toISOString();
			if (id === 101) w.call("PUT", "/api/expenses/:id/status", { params: { id: "101" }, body: { status: "Rejected" } });
			if (id === 102) w.db.prepare("UPDATE expenses SET status = 'Approved', status_by_role = 'Dispatcher', status_by_id = 2, status_by_name = 'made_up_dispatcher', status_at = ? WHERE id = 102").run(at);
			if (id === 103) w.call("PUT", "/api/expenses/:id/status", { params: { id: "103" }, body: { status: "Approved" } }, DISPATCHER);
			// Each clause of the compare-and-set alone: a status moved with no record, a record with the status still Pending.
			if (id === 104) w.db.prepare("UPDATE expenses SET status = 'Rejected' WHERE id = 104").run();
			if (id === 105) w.db.prepare("UPDATE expenses SET status_by_role = 'Super Admin', status_by_id = 1, status_by_name = 'made_up_admin', status_at = ? WHERE id = 105").run(at);
		};
		await w.pass.run();
		eq([expense(w, 101).status, expense(w, 101).status_by_role, review(w, 101).applied_at, review(w, 101).not_applied], ["Rejected", "Super Admin", "", "person_decided"], "a person's Reject during the read stands; the pass writes nothing");
		eq([expense(w, 102).status_by_name, review(w, 102).applied_at, review(w, 102).not_applied], ["made_up_dispatcher", "", "taken_by_person"], "a person's write with no audit row: the compare-and-set changes nothing");
		eq([expense(w, 103).status_by_name, review(w, 103).not_applied], ["made_up_dispatcher", "person_decided"], "a person's Approve during the read: theirs, not the pass's");
		eq([expense(w, 104).status, expense(w, 104).status_by_role, review(w, 104).not_applied], ["Rejected", "", "taken_by_person"], "a status that is no longer Pending: not written");
		eq([expense(w, 105).status, expense(w, 105).status_by_name, review(w, 105).not_applied], ["Pending", "made_up_admin", "taken_by_person"], "a record a person set, status still Pending: not written");
		eq(audits(w, "update_expense_status").filter((a) => a.username === "receipt-auto-approve").length, 0, "no status audit row by the pass");

		// The month closes while the receipt is being read: the write's own re-check refuses it.
		const m = world({ env: ON_ENV });
		fixture(m, 101);
		m.readHook = async () => {
			m.db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, 'locked', ?)").run(expense(m, 101).date.slice(0, 7), new Date().toISOString());
		};
		await m.pass.run();
		eq([expense(m, 101).status, expense(m, 101).status_by_role, review(m, 101).not_applied], ["Pending", "", "month_closed"], "a month locked between the judge and the write: nothing written");
	});

	await section("7. a person's Undo is never re-approved; both routes mark the review undone", async () => {
		const w = world({ env: ON_ENV });
		fixture(w, 101);
		fixture(w, 102);
		fixture(w, 103);
		await w.pass.run();
		eq([101, 102, 103].map((n) => expense(w, n).status), ["Approved", "Approved", "Approved"], "the pass approved all three");
		w.call("PUT", "/api/expenses/:id/status", { params: { id: "101" }, body: { status: "Pending" } });
		w.call("PUT", "/api/expenses/bulk-status", { body: { ids: [102], status: "Rejected" } }, DISPATCHER);
		eq([review(w, 101).undone_by, !!review(w, 101).undone_at], ["made_up_admin", true], "the single route marks 101's review undone, by the account");
		eq([review(w, 102).undone_by, !!review(w, 102).undone_at], ["made_up_dispatcher", true], "the bulk route marks 102's");
		await w.pass.run();
		eq([expense(w, 101).status, expense(w, 101).status_by_role], ["Pending", "Super Admin"], "101 stays the person's Pending after another pass");
		w.db.prepare("DELETE FROM receipt_auto_reviews WHERE expense_id = 101").run();
		await w.pass.run();
		eq([expense(w, 101).status, review(w, 101)], ["Pending", undefined], "even with its review row gone, 101 is no candidate (a person set it)");
		eq(audits(w, "update_expense_status").filter((a) => a.username === "receipt-auto-approve").length, 3, "the pass's status rows are its three first approvals only");
		const approve = w.call("PUT", "/api/expenses/:id/status", { params: { id: "103" }, body: { status: "Approved" } });
		eq([approve.status, review(w, 103).undone_at], [200, ""], "a person's Approve marks nothing undone");
	});

	await section("8. on mode never writes a Rejected or an Approved receipt", async () => {
		const w = world({ env: ON_ENV });
		fixture(w, 101, { receipt: { status: "Rejected" } });
		fixture(w, 102, { receipt: { status: "Approved" } });
		const before = dump(w.db).expenses;
		await w.pass.run();
		eq([review(w, 101), review(w, 102), w.reads], [undefined, undefined, []], "neither is a candidate, neither is read");
		eq(expenseChanges(before, dump(w.db).expenses), [], "both rows unchanged");
	});

	await section("9. a Personal mark between the judge and the write: one approval, not two", async () => {
		const w = world({ env: ON_ENV });
		fixture(w, 101);
		w.readHook = async (id) => {
			if (id !== 101) return;
			// What the mark does in its transaction: the line, the implied approval with the marker's record, its audit row.
			const now = new Date().toISOString();
			w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
				VALUES (101, 'deduct', 40000, 40000, ?, 1, ?, ?, ?, 'made_up_admin', 1, 'Super Admin')`).run(bday(NOW).slice(0, 7), bday(NOW), bday(NOW), now);
			w.db.prepare("UPDATE expenses SET status = 'Approved', status_by_role = 'Super Admin', status_by_id = 1, status_by_name = 'made_up_admin', status_at = ? WHERE id = 101").run(now);
			w.S.logAudit({ session: { user: ADMIN } }, "update_expense_status", "expense", 101, "status Pending -> Approved (marked Personal; period made-up)");
		};
		await w.pass.run();
		eq([expense(w, 101).status_by_name, review(w, 101).applied_at, review(w, 101).not_applied], ["made_up_admin", "", "person_decided"], "the pass writes nothing over the mark");
		eq(audits(w, "update_expense_status").filter((a) => a.entity_id === "101").length, 1, "one approval row on 101: the mark's");
		const s = w.pass.status();
		eq([s.counts.applied, s.counts.approve], [0, 1], "the report counts no approval by the pass (the verdict alone)");

		// A live Personal line with no status change: the write's own re-check refuses it.
		const p = world({ env: ON_ENV });
		fixture(p, 101);
		p.readHook = async () => {
			p.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
				VALUES (101, 'deduct', 1000, 40000, ?, 1, ?, ?, ?, 'made_up_admin', 1, 'Super Admin')`).run(bday(NOW).slice(0, 7), bday(NOW), bday(NOW), new Date().toISOString());
		};
		await p.pass.run();
		eq([expense(p, 101).status, review(p, 101).not_applied], ["Pending", "personal_line"], "a Personal line placed during the read: not written");
		// In shadow, a receipt that already has a live Personal line is no candidate.
		const sh = world({ env: SHADOW_ENV });
		fixture(sh, 101, { receipt: { status: "Approved" } });
		sh.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
			VALUES (101, 'deduct', 1000, 40000, ?, 1, ?, ?, ?, 'made_up_admin', 1, 'Super Admin')`).run(bday(NOW).slice(0, 7), bday(NOW), bday(NOW), new Date(NOW - D).toISOString());
		await sh.pass.run();
		eq([review(sh, 101), sh.reads], [undefined, []], "shadow: a receipt with a live Personal line is not judged");
	});

	await section("10. the scanner down, 6 failed reads, the day latch, the caps, the deadline", async () => {
		const w = world({ env: SHADOW_ENV });
		fixture(w, 101);
		w.readFn = () => { throw Object.assign(new Error("made-up: timed out"), { kind: "transient" }); };
		const seen = [];
		for (let i = 1; i <= 7; i++) {
			await w.pass.run();
			const rv = review(w, 101);
			seen.push(`${rv.verdict}:${rv.failed_reads}:${JSON.parse(rv.evidence).wait}`);
		}
		eq(seen, ["wait:1:READ_FAILED", "wait:2:READ_FAILED", "wait:3:READ_FAILED", "wait:4:READ_FAILED", "wait:5:READ_FAILED", "wait:6:READ_FAILED", "hold:7:"],
			"failed reads wait, counted; the 7th holds");
		eq(reasonsOf(w, 101), ["OCR_UNREAD"], "…as OCR_UNREAD");
		await w.pass.run();
		eq(w.reads.length, 7, "a held receipt is never read again");
		eq(expense(w, 101).status, "Pending", "and nothing was written to it");

		const q = world({ env: ON_ENV });
		fixture(q, 101);
		fixture(q, 102);
		fixture(q, 103);
		q.readFn = (id) => { throw Object.assign(new Error("made-up: quota"), { kind: "unavailable", status: 429 }); };
		await q.pass.run();
		eq(q.reads, [101], "a quota or credential refusal stops the pass's reads");
		eq([101, 102, 103].map((id) => `${review(q, id).verdict}:${review(q, id).failed_reads}`), ["wait:1", "wait:0", "wait:0"], "the refused read counts; the others wait uncounted (NL5)");
		await q.pass.run();
		eq(q.reads, [101], "…and no read for the rest of the business day");
		eq(q.db.prepare("SELECT value FROM receipt_auto_meta WHERE key = 'read_latch_day'").get().value, bday(Date.now()), "the latch names today's business day");

		const c = world({ env: { ...ON_ENV, RECEIPT_AUTO_APPROVE_MAX_READS_PER_PASS: "1", RECEIPT_AUTO_APPROVE_MAX_READS_PER_DAY: "2" } });
		fixture(c, 101);
		fixture(c, 102);
		fixture(c, 103);
		await c.pass.run();
		eq([c.reads, review(c, 102).verdict, review(c, 102).failed_reads], [[101], "wait", 0], "one read a pass; the rest wait, uncounted");
		await c.pass.run();
		await c.pass.run();
		eq(c.reads, [101, 102], "two reads a day, then none");
		eq(readCaps(c), [1, 2], "the caps read from their settings");
		const big = world({ env: { ...ON_ENV, RECEIPT_AUTO_APPROVE_MAX_READS_PER_PASS: "99", RECEIPT_AUTO_APPROVE_MAX_READS_PER_DAY: "999", RECEIPT_AUTO_APPROVE_INTERVAL_MIN: "5" } });
		eq([...readCaps(big), big.pass.config.intervalMin], [40, 100, 60], "caps clamp at 40 and 100; the interval at 60 minutes");

		// The 5-minute deadline: a clock that moves 6 minutes during the first read.
		const d = world({ env: ON_ENV });
		fixture(d, 101);
		fixture(d, 102);
		let t = Date.now();
		const pass = secondPass(d, {
			clock: () => new Date(t),
			readReceipt: async (uri) => { t += 6 * 60 * 1000; d.reads.push(idFromUri(uri)); return goodOcr(d.db, idFromUri(uri)); },
		});
		await pass.run();
		eq([d.reads, review(d, 102).verdict, JSON.parse(review(d, 102).evidence).wait], [[101], "wait", "READ_DEFERRED"], "past the 5-minute deadline the rest wait for the next pass");

		// No stored file: held NO_PHOTO with no call, even when the reads are spent.
		const np = world({ env: { ...ON_ENV, RECEIPT_AUTO_APPROVE_MAX_READS_PER_PASS: "1" } });
		fixture(np, 101);
		fixture(np, 102, { receipt: { photo_data: "" } });
		await np.pass.run();
		eq([np.reads, review(np, 102).verdict, reasonsOf(np, 102)], [[101], "hold", ["NO_PHOTO"]], "a receipt with no stored file is held NO_PHOTO, unread");
	});

	await section("11. baselines", async () => {
		const w = world({ env: SHADOW_ENV, baselineDaysAgo: null });
		fixture(w, 101);
		await w.pass.run();
		const shadowAt = w.db.prepare("SELECT value FROM receipt_auto_meta WHERE key = 'shadow_baseline_at'").get();
		ok(shadowAt && Date.parse(shadowAt.value) >= NOW, "the first shadow pass records its baseline", JSON.stringify(shadowAt));
		eq(review(w, 101), undefined, "a receipt filed before the shadow's first pass is never judged");
		fixture(w, 102, { createdMs: Date.now() + 2000 });
		await w.pass.run();
		eq(review(w, 102) && review(w, 102).verdict, "approve", "one filed after it is");

		const on = world({ env: ON_ENV, baselineDaysAgo: null });
		on.db.prepare("INSERT INTO receipt_auto_meta (key, value) VALUES ('shadow_baseline_at', ?)").run(new Date(NOW - 5 * D).toISOString());
		fixture(on, 101);
		await on.pass.run();
		ok(!!on.db.prepare("SELECT value FROM receipt_auto_meta WHERE key = 'on_baseline_at'").get(), "the first on pass records its own baseline");
		eq([review(on, 101), expense(on, 101).status], [undefined, "Pending"], "a receipt filed before on began is never approved by the pass");
	});

	await section("12. the undo tool (M3, NL1, NL2)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-undo-"));
		const file = path.join(dir, "made-up.db");
		try {
			const w = world({ env: ON_ENV, file });
			for (const n of [101, 102, 103, 104, 105, 106, 107, 108]) fixture(w, n);
			await w.pass.run();
			eq([101, 102, 103, 104, 105, 106, 107, 108].map((n) => expense(w, n).status_by_name), Array(8).fill("receipt-auto-approve"), "the pass approved all eight");
			const later = new Date(Date.now() + 1000).toISOString();
			const deduct = w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role, voided_at)
				VALUES (?, 'deduct', 1000, 40000, ?, 1, ?, ?, ?, 'made_up_admin', 1, 'Super Admin', ?)`);
			deduct.run(102, bday(NOW).slice(0, 7), bday(NOW), bday(NOW), later, "");
			deduct.run(103, bday(NOW).slice(0, 7), bday(NOW), bday(NOW), later, later);
			const row = w.db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, 'expense', ?, ?)");
			row.run(later, 1, "made_up_admin", "Super Admin", "update_expense_vendor", "104", "vendor -> Made-up Fuel");
			row.run(later, 2, "made_up_dispatcher", "Dispatcher", "bulk_update_expense_status", "1", "status -> Approved on 1 of 1 expense(s): 105");
			row.run(later, 2, "made_up_dispatcher", "Dispatcher", "expense_duplicate_override", "999", "Logged despite matching expense #106 (made-up)");
			w.db.prepare("UPDATE expenses SET location_city = 'Other Sample City' WHERE id = 107").run();
			w.db.prepare("UPDATE expenses SET status_by_role = 'Super Admin', status_by_id = 1, status_by_name = 'made_up_admin', status_at = ? WHERE id = 108").run(later);
			const deps = undoDeps(w);
			const plan = passLib.undoPlan(deps, { since: bday(NOW - 2 * D) });
			eq(plan.map((p) => `${p.id}:${p.action === "undo" ? "undo" : p.reason}`),
				["101:undo", "102:personal_line", "103:personal_line", "104:touched_since", "105:touched_since", "106:touched_since", "107:evidence_changed", "108:touched_since"],
				"the dry run: only the untouched one; each other skipped with its reason");
			const lockMonth = expense(w, 101).date.slice(0, 7);
			w.db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, 'locked', ?)").run(lockMonth, later);
			eq(passLib.undoPlan(deps, {}).find((p) => p.id === 101).reason, "month_closed", "a closed month is skipped");
			w.db.prepare("DELETE FROM period_locks WHERE period = ?").run(lockMonth);
			eq(passLib.undoPlan({ ...deps, monthDue: () => true }, {}).find((p) => p.id === 101).reason, "month_closing", "a month due for close is skipped");
			w.db.close();

			const hash = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
			const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "receipt-auto-approve-undo.js"), `--db=${file}`, `--since=${bday(NOW - 2 * D)}`, ...args],
				{ encoding: "utf8", env: { PATH: process.env.PATH, TZ: process.env.TZ, ...env } });
			const h0 = hash();
			const dry = cli([]);
			eq(dry.status, 0, "the script's dry run exits 0");
			ok(/^would change 1: 101$/m.test(dry.stdout) && /^skipped touched_since 4: 104,105,106,108$/m.test(dry.stdout) && /dry run: nothing written/.test(dry.stdout),
				"…prints what it would change and skip, ids and counts only", dry.stdout + dry.stderr);
			eq(hash(), h0, "…and writes nothing");
			const onEnv = cli(["--apply"], { RECEIPT_AUTO_APPROVE_ENABLED: "true" });
			eq([onEnv.status, /RECEIPT_AUTO_APPROVE_ENABLED/.test(onEnv.stderr)], [2, true], "--apply is refused while the pass flag is on here");
			const recent = cli(["--apply"]);
			eq([recent.status, /on-mode pass within its last interval/.test(recent.stderr)], [2, true], "--apply is refused while the database shows an on-mode pass within its interval (NL2)");
			eq(hash(), h0, "the refusals wrote nothing");

			const db = new Database(file);
			db.prepare("UPDATE receipt_auto_meta SET value = ? WHERE key = 'last_pass_at'").run(new Date(NOW - 3 * H).toISOString());
			const before = dump(db);
			db.close();
			const flagOnly = cli(["--apply"], { RECEIPT_AUTO_APPROVE_ENABLED: "true" });
			eq([flagOnly.status, /^changed/m.test(flagOnly.stdout)], [2, false], "with the database quiet, the pass flag on here still refuses --apply");
			const applied = cli(["--apply"]);
			eq([applied.status, /^changed 1: 101$/m.test(applied.stdout)], [0, true], "--apply changes the one", applied.stdout + applied.stderr);
			const db2 = new Database(file);
			const after = dump(db2);
			const e101 = after.expenses.find((e) => e.id === 101);
			eq([e101.status, e101.status_by_role, e101.status_by_id, e101.status_by_name], ["Pending", "system", 0, "receipt-auto-approve-undo"], "101 back to Pending, recorded by the undo actor");
			eq(expenseChanges(before.expenses, after.expenses).filter((c) => !c.startsWith("101.") || !STATUS_COLS.has(c.split(".")[1])), [], "only 101's status and record changed");
			const rv = after.receipt_auto_reviews.find((r) => r.expense_id === 101);
			eq([!!rv.undone_at, rv.undone_by], [true, "receipt-auto-approve-undo"], "its review row is marked undone");
			const added = after.audit_trail.slice(before.audit_trail.length);
			eq(added.map((a) => [a.action, a.entity_id, a.username, a.role]), [["update_expense_status", "101", "receipt-auto-approve-undo", "system"], ["receipt_auto_approve_undo", "", "receipt-auto-approve-undo", "system"]],
				"one system row per change and one summary row");
			ok(/^status Approved -> Pending \(undo of an automatic approval, rules v1; period \d{4}-\d{2}\)$/.test(added[0].details), "the change row's text", added[0].details);
			eq(JSON.stringify(after.audit_trail.slice(0, before.audit_trail.length)) === JSON.stringify(before.audit_trail), true, "no earlier audit row is edited");
			const other = Object.keys(before).filter((t) => !["expenses", "receipt_auto_reviews", "audit_trail"].includes(t) && JSON.stringify(before[t]) !== JSON.stringify(after[t]));
			eq(other, [], "no other table changed");
			db2.close();
			const again = cli(["--apply"]);
			eq([again.status, /^changed 0: none$/m.test(again.stdout)], [0, true], "a re-run finds none", again.stdout + again.stderr);

			const w2 = new Database(file);
			w2.exec("DROP TABLE period_locks");
			w2.close();
			const broken = cli([]);
			eq([broken.status, /lock table can't be read/.test(broken.stderr)], [2, true], "it refuses to run when the lock table can't be read");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		// The pass never re-approves what the tool undid; a Personal line placed after the
		// plan is caught by the write's own re-check.
		const w = world({ env: ON_ENV });
		fixture(w, 101);
		fixture(w, 102);
		await w.pass.run();
		const plan = passLib.undoPlan(undoDeps(w), {});
		w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
			VALUES (102, 'deduct', 1000, 40000, ?, 1, ?, ?, ?, 'made_up_admin', 1, 'Super Admin')`).run(bday(NOW).slice(0, 7), bday(NOW), bday(NOW), new Date().toISOString());
		const out = passLib.undoApply(undoDeps(w), plan, new Date().toISOString());
		eq([out.changed, out.skipped], [[101], { personal_line: 1 }], "the tool undoes 101 and leaves 102, marked Personal after its plan");
		eq(expense(w, 102).status_by_name, "receipt-auto-approve", "102 is left as the pass set it");
		w.db.prepare("DELETE FROM receipt_auto_reviews").run();
		const readsBefore = w.reads.length;
		await w.pass.run();
		eq([expense(w, 101).status, review(w, 101), w.reads.length - readsBefore], ["Pending", undefined, 0],
			"the next pass neither judges nor reads it: its record names the undo");
	});

	await section("13. the hourly pass leaves alerts and the odometer to the 6-hourly sweep (NL7)", async () => {
		const w = world({ env: SHADOW_ENV });
		fixture(w, 101, { fill: { odometer: 123456 } });
		fixture(w, 102, { noFill: true });
		addFill(w, { id: 900, vid: "VID-102", day: bday(NOW - 6 * D), before: 10, after: 90 });
		await w.pass.run();
		eq([rowsOf(w.db, "SELECT * FROM fuel_event_alerts").length, expense(w, 101).odometer, audits(w, "fuel_odometer_backfill").length], [0, 0, 0],
			"the pass writes no alert row, no odometer and no backfill row");
		eq(w.db.prepare("SELECT expense_id FROM fuel_events WHERE id = 101").get().expense_id, 101, "…but keeps the links fresh");
		// Both due at once: the pass releases the latch before its first read, so the sweep runs.
		let latchDuringRead = null;
		fixture(w, 103, { createdMs: Date.now() + 1000 });
		w.readHook = async () => { latchDuringRead = w.S.fuelLatch(); };
		const passRun = w.pass.run();
		const sweepRun = w.S.maybeSweepFuelEvents();
		await Promise.all([passRun, sweepRun]);
		eq(latchDuringRead, false, "the latch is free while the pass reads");
		ok(!!w.S.fuelEventsHealth.lastRun && !w.S.fuelEventsHealth.lastError, "the sweep ran beside the pass", JSON.stringify(w.S.fuelEventsHealth));
		eq([expense(w, 101).odometer, rowsOf(w.db, "SELECT event_key FROM fuel_event_alerts").length], [123456, 1], "…and did its odometer backfill and its one alert");
		w.S.setFuelLatch(true);
		const r = await w.pass.run();
		w.S.setFuelLatch(false);
		eq(r, { skipped: "sweep_running" }, "a pass while the sweep holds the latch skips");
	});

	await section("14. a receipt rejected before the pass judged it (M2, NL8)", async () => {
		const w = world({ env: SHADOW_ENV });
		fixture(w, 101, { receipt: { status: "Rejected" } });
		w.S.logAudit({ session: { user: ADMIN } }, "update_expense_status", "expense", 101, "status Pending -> Rejected (made-up, period made-up)");
		fixture(w, 102, { receipt: { status: "Approved" } });
		w.S.logAudit({ session: { user: ADMIN } }, "update_expense_status", "expense", 102, "status Pending -> Approved (made-up, period made-up)");
		const before = dump(w.db).expenses;
		await w.pass.run();
		const r1 = review(w, 101);
		eq([r1.verdict, r1.status_seen, r1.person_first, JSON.parse(r1.evidence).link.fill], ["approve", "Rejected", 1, 101], "shadow's verdict is a would-approve, from the in-memory match");
		eq(w.db.prepare("SELECT COUNT(*) AS n FROM fuel_events WHERE expense_id = 101").get().n, 0, "no stored link for the Rejected receipt");
		eq([review(w, 102).verdict, review(w, 102).person_first], ["approve", 1], "the already-approved one is judged from its stored link");
		eq(expenseChanges(before, dump(w.db).expenses), [], "nothing written to either");
		const s = passLib.summary(w.db, { detail: true });
		eq([s.counts.s3, s.counts.decidedBefore, s.counts.rejectedJudged], [1, 2, 1], "S3 is 1; both listed as decided before the pass could judge");
		const fr = w.pass.freeRules({ inMemory: w.S.matchFuelEventsToReceipts({ persist: false, writeReceipts: false, includeRejected: true }).matched });
		eq(fr.receipts.filter((x) => x.id === 101).map((x) => x.verdict), ["read"], "the free-rules report passes it on rules 1-10 too");
		const held = world({ env: SHADOW_ENV });
		fixture(held, 101, { receipt: { status: "Rejected" } });
		addReceipt(held, { id: 150, type: "Other", truck_unit: "T-101", driver: "Sample Driver 101", amount: 400, gallons: 100, status: "Pending" });
		await held.pass.run();
		ok((reasonsOf(held, 101) || []).includes("DUPLICATE"), "a Rejected receipt is judged by rule 8 with itself included (NL8)", JSON.stringify(reasonsOf(held, 101)));
	});

	await section("15. SHADOW=false with the recorder off runs as shadow (M1)", async () => {
		const env = { ...SHADOW_ENV, RECEIPT_AUTO_APPROVE_SHADOW: "false" };
		const w = world({ env });
		fixture(w, 101);
		await w.pass.run();
		eq([w.pass.config.mode, review(w, 101).mode, review(w, 101).verdict, expense(w, 101).status], ["shadow", "shadow", "approve", "Pending"], "it judges in shadow and writes no receipt");
		ok(w.logs.includes("[receipt-auto-approve] shadow, every 60 min; reads 20 a pass, 30 a day; on refused: RECEIPT_STATUS_RECORDER_ENABLED is off"), "the start-up line says why", JSON.stringify(w.logs));
		const missing = world({ env: { RECEIPT_AUTO_APPROVE_ENABLED: "true", GEMINI_API_KEY: "made-up-gemini-key" } });
		ok(missing.logs.includes("[receipt-auto-approve] not started: FUEL_EVENTS_ENABLED is off"), "without the fuel sweep it doesn't start, and says so", JSON.stringify(missing.logs));
		eq([missing.timeouts.length, (await missing.pass.run()).skipped], [0, "off"], "…no timer, no pass");
		const nokey = world({ env: { RECEIPT_AUTO_APPROVE_ENABLED: "true", FUEL_EVENTS_ENABLED: "true" } });
		ok(nokey.logs.includes("[receipt-auto-approve] not started: no Gemini key is set"), "without a Gemini key it doesn't start", JSON.stringify(nokey.logs));
	});

	await section("16. PERSON_DECIDED (M1, NL3)", async () => {
		const w = world({ env: ON_ENV });
		for (const n of [101, 102, 103, 104, 105, 106]) fixture(w, n);
		const row = w.db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, 'expense', ?, ?)");
		const t = new Date(NOW - 20 * H).toISOString();
		row.run(t, 1, "made_up_admin", "Super Admin", "update_expense_status", "101", "status Approved -> Pending (made-up)");
		row.run(t, 2, "made_up_dispatcher", "Dispatcher", "bulk_update_expense_status", "2", "status -> Approved on 2 of 2 expense(s): 99,102");
		row.run(t, 2, "made_up_dispatcher", "Dispatcher", "bulk_update_expense_status", "1", "garbled made-up text naming 103");
		row.run(t, 0, "made-up-job", "system", "update_expense_status", "104", "status Pending -> Pending (made-up system row)");
		row.run(t, 2, "made_up_dispatcher", "Dispatcher", "bulk_update_expense_status", "1", "status -> Rejected on 1 of 1 expense(s): 105 — reason: a made-up twin of 106");
		await w.pass.run();
		eq([101, 102, 103, 104, 105, 106].map((n) => `${n}:${review(w, n) ? review(w, n).verdict : "-"}:${expense(w, n).status}`),
			["101:-:Pending", "102:-:Pending", "103:-:Pending", "104:approve:Approved", "105:-:Pending", "106:approve:Approved"],
			"a person's single, bulk or unparseable row keeps a receipt from the pass; a system row doesn't, nor does a reason's text");
		eq(passLib.bulkIds("status -> Pending on 2 of 2 expense(s): 7,8 — reason: see 9"), [7, 8], "a bulk row's list ends where its reason begins");
	});

	await section("17. owner-operators (L17)", async () => {
		const OO_DDL = `CREATE TABLE owner_operators (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, application_id INTEGER,
			status TEXT NOT NULL DEFAULT 'onboarding' CHECK(status IN ('onboarding', 'active', 'ended')), source TEXT NOT NULL DEFAULT 'direct',
			business_name TEXT NOT NULL DEFAULT '', fee_bps INTEGER NOT NULL DEFAULT 1800, escrow_target_cents INTEGER NOT NULL DEFAULT 250000,
			escrow_weekly_cents INTEGER NOT NULL DEFAULT 50000, installment_cents INTEGER NOT NULL DEFAULT 0, end_week_start TEXT NOT NULL DEFAULT '',
			final_invoice_id INTEGER, created_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '')`;
		const w = world({ env: SHADOW_ENV });
		for (const n of [101, 102, 103]) fixture(w, n);
		w.db.exec(OO_DDL);
		const user = w.db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (?, ?, 'x', 'Driver', ?)");
		user.run(11, "oo_driver", "Sample  driver 102");
		user.run(12, "twin_a", "Sample Driver 103");
		user.run(13, "twin_b", "sample driver 103");
		w.db.prepare("INSERT INTO owner_operators (user_id, status, created_at) VALUES (11, 'ended', ?)").run(new Date(NOW).toISOString());
		await w.pass.run();
		eq([101, 102, 103].map((n) => !!review(w, n)), [true, false, false], "his receipt is skipped whatever his status; a name on two accounts is skipped");
		const u = world({ env: SHADOW_ENV });
		fixture(u, 101);
		u.db.exec("CREATE TABLE owner_operators (id INTEGER PRIMARY KEY)");
		await u.pass.run();
		eq(review(u, 101), undefined, "a table that can't be read skips every receipt");
		const none = world({ env: SHADOW_ENV });
		fixture(none, 101);
		await none.pass.run();
		eq(!!review(none, 101), true, "no table: the check finds none");
	});

	await section("18. the close, the grace rule, the latch before the read, a quiet pass (L1, L8, L9)", async () => {
		const w = world({ env: ON_ENV });
		fixture(w, 101);
		w.S.setCloseRunning(true);
		const before = dump(w.db);
		eq(await w.pass.run(), { skipped: "close_running" }, "no pass while the automatic close runs");
		eq(JSON.stringify(dump(w.db)) === JSON.stringify(before), true, "…and nothing written");
		w.S.setCloseRunning(false);

		const g = world({ env: ON_ENV });
		const lastMonth = `${shiftDay(`${bday(NOW).slice(0, 7)}-01`, -1).slice(0, 7)}-15`;
		fixture(g, 101, { receipt: { date: lastMonth } });
		g.db.prepare("UPDATE fuel_events SET local_day = ? WHERE id = 101").run(lastMonth);
		g.db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'settlement_grace_days', '0')").run();
		await g.pass.run();
		eq([review(g, 101), g.reads], [undefined, []], "a month due by the grace setting gives no candidates");

		const q = world({ env: ON_ENV });
		fixture(q, 101);
		fixture(q, 102, { noFill: true, createdMs: NOW - 10 * H });
		let latch = null;
		q.readHook = async () => { latch = q.S.fuelLatch(); };
		await q.pass.run();
		eq(latch, false, "the latch is released before the first read");
		const n = audits(q, "receipt_auto_approve_pass").length;
		await q.pass.run();
		eq([review(q, 102).verdict, audits(q, "receipt_auto_approve_pass").length], ["wait", n], "a pass with only a wait writes no audit row");

		// Two passes on one database judge the same receipt at once: the first verdict stands.
		const two = world({ env: ON_ENV });
		fixture(two, 101);
		let open;
		const gate = new Promise((r) => { open = r; });
		two.readHook = async () => { await gate; };
		const other = secondPass(two, { readReceipt: async (uri) => { await gate; return goodOcr(two.db, idFromUri(uri)); } });
		const runs = [two.pass.run(), other.run()];
		open();
		await Promise.all(runs);
		eq([expense(two, 101).status_by_name, review(two, 101).not_applied, !!review(two, 101).applied_at], ["receipt-auto-approve", "", true], "the first pass's approval and record stand");
		eq([audits(two, "update_expense_status").length, audits(two, "receipt_auto_approve_pass").length], [1, 1], "one approval row and one summary row, not two");
	});

	await section("19. rule 8 past the 200th group (L4)", async () => {
		const w = world({ env: SHADOW_ENV });
		fixture(w, 101);
		addReceipt(w, { id: 150, type: "Other", truck_unit: "T-101", driver: "Sample Driver 101", amount: 400, gallons: 100 });
		// The queue lists the costliest groups first; these 205 each cost more than 101's.
		const today = bday(NOW);
		for (let i = 0; i < 205; i++) {
			for (const k of [0, 1]) addReceipt(w, { id: 1000 + i * 2 + k, type: "Other", truck_unit: "T-900", driver: "Sample Driver 900", amount: 1000 + i, gallons: 0, date: today, vendor: "Made-up Mart" });
		}
		const listed = w.S.duplicateReceiptGroups().groups;
		ok(listed.length === 200 && !listed.some((g) => g.truckUnit === "T-101"), "the duplicate queue lists 200 groups, not 101's", `${listed.length}`);
		await w.pass.run();
		ok((reasonsOf(w, 101) || []).includes("DUPLICATE"), "the pass still holds 101 as DUPLICATE", JSON.stringify(reasonsOf(w, 101)));
	});

	await section("20. the input shapes PR 2's review named; the report route", async () => {
		const w = world({ env: SHADOW_ENV });
		fixture(w, 101);
		w.S.logAudit({ session: { user: ADMIN } }, "expense_duplicate_override", "expense", "101", "Logged despite matching expense #77 (made-up)");
		fixture(w, 102, { assignment: { end_date: null } });
		const r = bday(NOW - 30 * H);
		// A change at 23:30 Eastern the day after the receipt: the next UTC day, but within a business day of it.
		const late = new Date(Date.parse(`${shiftDay(r, 1)}T23:30:00-04:00`)).toISOString();
		fixture(w, 103, { assignment: { end_date: late } });
		w.db.prepare("INSERT INTO trucks (id, unit_number, owner_id) VALUES (9, 'T-9', 109)").run();
		w.db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (9, 'Sample Driver 103', ?, '')").run(late);
		await w.pass.run();
		eq(reasonsOf(w, 101), ["OVERRIDDEN"], "an override's id read as text still holds (ids in the sets are numbers)");
		ok((reasonsOf(w, 102) || []).includes("TRUCK_CHANGE_DAY") && (reasonsOf(w, 102) || []).includes("TRUCK_NOT_HELD"), "a NULL end date is no open assignment: held", JSON.stringify(reasonsOf(w, 102)));
		ok((reasonsOf(w, 103) || []).includes("TRUCK_CHANGE_DAY"), "an assignment instant is read as its business day", JSON.stringify(reasonsOf(w, 103)));

		const sa = w.call("GET", "/api/admin/receipt-auto-approve", {});
		eq([sa.status, sa.body.mode, sa.body.counts.judged, "receipts" in sa.body], [200, "shadow", 3, false], "shadow: Super Admin gets counts only");
		eq(w.call("GET", "/api/admin/receipt-auto-approve", {}, DISPATCHER).status, 403, "a Dispatcher is refused");
		const on = world({ env: ON_ENV });
		fixture(on, 101);
		await on.pass.run();
		const got = on.call("GET", "/api/admin/receipt-auto-approve", {});
		eq(got.body.receipts.map((x) => [x.id, x.verdict, !!x.appliedAt]), [[101, "approve", true]], "on: the receipts are listed, ids only");
		ok(!JSON.stringify(got.body).includes("Sample Driver"), "no driver name in the report");
	});

	await section("21. the report script: read-only, ids and counts only", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-report-"));
		const file = path.join(dir, "made-up.db");
		try {
			const w = world({ env: SHADOW_ENV, file });
			fixture(w, 101);
			fixture(w, 102, { fill: { lat: LAT + 0.6 } });
			fixture(w, 103, { receipt: { status: "Rejected" } });
			await w.pass.run();
			w.db.close();
			const hash = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
			const h0 = hash();
			const cli = (args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "receipt-auto-approve-report.js"), `--db=${file}`, ...args],
				{ encoding: "utf8", env: { PATH: process.env.PATH, TZ: process.env.TZ } });
			const rec = cli([]);
			eq(rec.status, 0, "the record report exits 0");
			ok(/would approve 2 of 3/.test(rec.stdout) && /S3 \(a would-approve that a person rejected or undid\): 1/.test(rec.stdout) && /#102 .* hold \(PLACE_FAR\)/.test(rec.stdout),
				"…gives would-approve of judged, S3 and each hold's reasons", rec.stdout + rec.stderr);
			ok(/owner 201 \d{4}-\d{2}: 1 receipt\(s\), \$400\.00/.test(rec.stdout), "…and the per-owner, per-month sums", rec.stdout);
			const free = cli(["--free-rules"]);
			eq(free.status, 0, "the free-rules report exits 0");
			ok(/judged 3: pass rules 1-10 2, held 1/.test(free.stdout) && /#103 .* Rejected: read/.test(free.stdout), "…judges every receipt on rules 1-10, the Rejected one from the in-memory match", free.stdout + free.stderr);
			ok(!/Sample Driver/.test(rec.stdout + free.stdout), "no driver name in either");
			eq(hash(), h0, "the database file is unchanged");
			const bad = cli(["--since=last-week"]);
			eq(bad.status, 2, "a malformed --since is refused");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
}

// Another pass on the same database, wired as the block wires its own (a second server
// process, say), with the clock or the reader replaced.
function secondPass(w, over = {}) {
	const S = w.S;
	return passLib.create({
		db: w.db, config: w.pass.config,
		fuel: { take: () => true, release: () => {}, detectAndMatch: () => S.matchFuelEventsToReceipts({ persist: true, writeReceipts: false }), matchWithRejected: () => [] },
		closeRunning: () => false, expenseRowPeriodLocked: S.expenseRowPeriodLocked, periodLocksReadable: S.periodLocksReadable,
		monthDue: (p) => S.isPastGrace(p, S.settlementGraceDays()), expensePostedPeriod: S.expensePostedPeriod, band: S.fuelCpgBandFromFleet,
		personalLiveIds: S.personalLiveExpenseIds, receiptUri: S.receiptDataUriForOcr,
		readReceipt: async (uri) => goodOcr(w.db, idFromUri(uri)),
		normalizeDriverName: S.normalizeDriverName, logAudit: S.logAudit, matchDays: 45, log: { error() {}, log() {} },
		...over,
	});
}
function undoDeps(w) {
	const S = w.S;
	return {
		db: w.db, expenseRowPeriodLocked: S.expenseRowPeriodLocked, monthDue: (p) => S.isPastGrace(p, S.settlementGraceDays()),
		expensePostedPeriod: S.expensePostedPeriod, personalLiveIds: S.personalLiveExpenseIds, logAudit: S.logAudit,
	};
}
function readCaps(w) {
	return [w.pass.config.maxReadsPerPass, w.pass.config.maxReadsPerDay];
}

main().then(() => {
	console.log(failures.length ? `\n${passed} passed, ${failures.length} failed` : `\n${passed} passed, 0 failed`);
	process.exit(failures.length ? 1 : 0);
}, (e) => {
	console.error(e);
	process.exit(1);
});
