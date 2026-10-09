#!/usr/bin/env node
/**
 * The KPI bot's job: what it gathers, what it stores, when it runs, and the
 * emails it sends.
 *
 * WHAT IS REAL. The whole KPI block is lifted out of server.js (from its
 * "KPI BOT" banner to the SPA catch-all banner) and executed on a fresh
 * in-memory SQLite: its own CREATE TABLE statements make the kpi_* tables, and
 * the tables it reads come from server.js's own DDL. Lifted with it: findCol(),
 * sheetDayKey(), liveJobTrackingView() and the soft-delete filter, logAudit().
 * Real libraries: lib/kpi-schedule.js, lib/kpi-digest.js, lib/app-time.js,
 * lib/broker-invoice.js extractPdfText() (the test PDFs are deflate streams
 * built here), lib/ratecon-drive-index.js. Fakes: the clock (a Date whose "now"
 * the test moves), the sheet (a deep-frozen cache object), Drive,
 * fetchDocumentBytes(), sendEmail(), the timers the scheduler starts, and
 * Backend A's lib/kpi-catalog.js / kpi-metrics.js / kpi-weight.js
 * (contract-shaped fakes, so this runner does not depend on them).
 *
 * §1 storage: the six tables with the contract's columns and keys; a run left
 *    'running' by a stopped process is closed as INTERRUPTED; the kill
 *    switches' shape (default on, only false/0/no/off turn them off).
 * §2 kpiGatherDbInputs(): ELD miles per (day, truck); trucks with their service
 *    days (an instant read on the business clock) and ELD presence; fleet
 *    history before the day; fuel receipts with their raw status; AI and
 *    automation work by business day (the autogen baseline marker excluded);
 *    receiver arrivals, load miles, destination longitude. Named columns only:
 *    no SELECT *, never photo_data, never receipt_details as a column.
 * §3 kpiSheetLoads() over liveJobTrackingView(): cancelled and soft-deleted
 *    loads gone; the day is Completion, else Drop-off, else Pickup; Contract ID
 *    blank; caps of 2000 / 200 characters; keys lowercased; arrivals are
 *    delivered loads; the shared cache is never written (it is deep-frozen and
 *    the run is strict).
 * §4 revenue: kpiSheetLoads() reads each load's Payment cell with
 *    brokerInvoice.parseMoney(); no Payment column, no revenue.
 * §5 a nightly run end to end: the run row, the inputs computeKpis() gets, the
 *    day's snapshot rows, the series, the derived date; an earlier day's rows
 *    untouched, the same day's replaced; kpis:changed emitted.
 * §6 the weight phase: at most 40 loads a night, newest first, Details weights
 *    skipped; the stored rate-con before Drive; one Drive list and the newest
 *    file only, too-large files never downloaded; not_found / error kept for 30
 *    days; no Drive without the folder setting, none on a manual run; a Drive
 *    failure stored as a code, never its message.
 * §7 the time box: the Drive phase stops at 2 minutes, the run at 4;
 *    kpiWithin() rejects with TIME_LIMIT.
 * §8 emails: the one-time preview to ADMIN_NOTIFY_EMAIL only, sent only when
 *    sendEmail() says so and never retried; the Monday digest to the page's
 *    recipients (else ADMIN_NOTIFY_EMAIL), from the same object GET returns;
 *    a claimed slot is never sent again (a restart between claim and send); a
 *    slot more than 6 h late is missed; a first start mid-week seeds the week's
 *    slot; KPI_DIGEST_ENABLED off sends nothing.
 * §9 the scheduler: nothing starts unless startsJob("KPI snapshot") says so;
 *    the boot run at 10 minutes, then the 1-minute tick; the start-up line; a
 *    run at 04:00 business time, once a day; a failed run retried after 30
 *    minutes, three times a day at most; single flight.
 * §10 aggregates only: sentinel driver and broker names, load IDs, file names,
 *    receipt photos and error text appear in no kpi table, no stored payload,
 *    no email, no log line and no GET answer.
 * §11 MUTANTS: claim-before-send dropped; the preview latch set although the
 *    send failed; the preview sent to the page's recipients; no first-start
 *    digest marker; a 41st Drive load; the not-found cache ignored; the time
 *    limits ignored; the startsJob gate removed; raw error text stored;
 *    SELECT * on expenses.
 *
 * Hermetic: :memory: SQLite, no network, no port, nothing written to disk.
 *
 * Run: node scripts/test-kpi-job.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

// ── lift the shipped code ───────────────────────────────────────────────────
const BANNER = "// ============================================================\n";
const START_MARK = `${BANNER}// KPI BOT —`;
const END_MARK = `${BANNER}// SPA Catch-All`;
const BLOCK = (() => {
	const a = SRC.indexOf(START_MARK);
	const b = SRC.indexOf(END_MARK);
	if (a < 0 || b < a || SRC.split(START_MARK).length !== 2) die("could not locate the KPI block above the SPA catch-all");
	return SRC.slice(a, b);
})();
function liftFrom(text, name) {
	const needle = `\nfunction ${name}(`;
	if (text.split(needle).length !== 2) die(`expected exactly 1 definition of ${name}()`);
	const a = text.indexOf(needle) + 1;
	return text.slice(a, text.indexOf("\n}\n", a) + 2);
}
function liftConst(head) {
	const needle = `\n${head}`;
	if (SRC.split(needle).length !== 2) die(`expected exactly 1 statement starting ${JSON.stringify(head)}`);
	const a = SRC.indexOf(needle) + 1;
	return SRC.slice(a, SRC.indexOf(";\n", a) + 1);
}
const HELPERS = [
	liftConst("const RFC2822_MONTHS = "), liftFrom(SRC, "appDay"), liftFrom(SRC, "findCol"), liftFrom(SRC, "sheetDayKey"),
	liftConst("const CANCELED_STATUS_RE = "), liftFrom(SRC, "getDeletedLoadIds"), liftFrom(SRC, "loadKeySet"),
	liftFrom(SRC, "excludeDroppedLoads"), liftFrom(SRC, "liveJobTrackingView"),
	liftFrom(SRC, "scrubPurgeMarker"), liftFrom(SRC, "auditText"), liftFrom(SRC, "logAudit"),
	liftConst("const RATECON_DOC_TYPES = "),
].join("\n");

function tableDdl(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${name}`);
	return `CREATE TABLE ${name} (${m[1]}\n)`;
}
function alterDdl(table, col) {
	const m = SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN ${col} [^"\`]*`));
	if (!m) die(`could not locate the ${table}.${col} migration`);
	return m[0];
}
const DEP_DDL = [
	tableDdl("trucks"), alterDdl("trucks", "in_service_date"), alterDdl("trucks", "retired_at"), alterDdl("trucks", "routemate_vehicle_id"),
	tableDdl("eld_miles_daily"), tableDdl("eld_device_assignments"),
	tableDdl("expenses"), alterDdl("expenses", "gallons"), alterDdl("expenses", "receipt_details"),
	tableDdl("audit_trail"), tableDdl("load_status_history"), tableDdl("invoice_autogen_runs"),
	tableDdl("load_eld_miles"), tableDdl("load_coordinates"), tableDdl("documents"), alterDdl("documents", "deleted_at"),
	tableDdl("app_settings"), tableDdl("server_state"), tableDdl("deleted_loads"),
];

// ── fixtures ────────────────────────────────────────────────────────────────
const DRIVER = "Quinn Sentinel";
const BROKER = "Zed Sentinel Freight";
const PHOTO = "PHOTO-SENTINEL-BYTES";
const RECEIPT_TEXT = "RECEIPT-SENTINEL-TEXT";
const ADMIN = "admin@example.test";
const METRIC_KEYS = [
	"freight_tons_stated", "freight_tons_estimated", "loads_delivered", "revenue", "miles_driven", "on_time_rate",
	"fleet_trucks", "active_units", "fuel_mpg", "fuel_savings", "co2_tonnes", "ai_tasks", "automated_tasks",
	"dispatch_calls", "truck_utilization", "paid_mile_share",
];
const HEADERS = ["Contract ID", "Load ID", "Status", "Driver", "Truck", "Details", "Pickup Appointment", "Drop-off Appointment", "Completion Date", "  Payment  "];
function row(i, cells) {
	const r = { _rowIndex: i + 2 };
	for (const h of HEADERS) r[h] = "";
	return Object.assign(r, cells);
}
function baseSheet() {
	return {
		headers: HEADERS,
		data: [
			row(0, { "Load ID": "#L-1001", Status: "Delivered", Driver: ` ${DRIVER} `, Truck: "101", Details: `${BROKER}, 42,000 lbs`, "Completion Date": "2026-09-10", "Drop-off Appointment": "09/10/2026 08:00" }),
			row(1, { "Contract ID": BROKER, "Load ID": "L-1002", Status: "Completed", Driver: DRIVER, Truck: "102", Details: "frozen goods", "Drop-off Appointment": "09/12/2026 14:00", "Pickup Appointment": "09/11/2026" }),
			row(2, { "Contract ID": BROKER, "Load ID": "L-1003", Status: "POD Received", Details: "no weight here", "Pickup Appointment": "2026-09-01" }),
			row(3, { "Load ID": "L-1004", Status: "Cancelled", "Completion Date": "2026-09-05" }),
			row(4, { "Load ID": "L-1005", Status: "Delivered", "Completion Date": "2026-09-06" }),
			row(5, { "Contract ID": BROKER, "Load ID": "L-1006", Status: "In Transit", "Pickup Appointment": "2026-10-08" }),
			row(6, { "Contract ID": BROKER, "Load ID": "L-1007", Status: "Delivered", Details: "x".repeat(3000), "Drop-off Appointment": "y".repeat(500), "Completion Date": "2026-09-20" }),
			row(7, { "Contract ID": BROKER, "Load ID": "L-1008", Status: "delivered" }),
		],
	};
}
// n delivered loads with numeric ids (a file name carries the id as digits), no
// weight in Details, delivered on consecutive days from 2026-08-01.
function weightSheet(n, start = 512000001) {
	const data = [];
	for (let i = 0; i < n; i++) {
		const day = new Date(Date.UTC(2026, 7, 1 + i, 12)).toISOString().slice(0, 10);
		data.push(row(i, { "Contract ID": BROKER, "Load ID": String(start + i), Status: "Delivered", Driver: DRIVER, Details: "General freight", "Completion Date": day }));
	}
	return { headers: HEADERS, data };
}
function deepFreeze(o) {
	if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
	return o;
}
function pdfWith(text) {
	return Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n"), zlib.deflateSync(Buffer.from(`BT (${text}) Tj ET`)), Buffer.from("\nendstream\nendobj\n%%EOF\n")]);
}

function seed(db) {
	const truck = db.prepare("INSERT INTO trucks (id, unit_number, status, created_at, in_service_date, retired_at, routemate_vehicle_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
	truck.run(1, "101", "Active", "2026-04-10 02:30:00", "", "", "rv-1");
	truck.run(2, "102", "Inactive", "2026-05-01 12:00:00", "2026-05-03", "2026-08-31", "");
	truck.run(3, "103", "Active", "2026-06-01 15:00:00", "not a date", "", "");
	db.prepare("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_until) VALUES (2, 'rv-2', '2026-05-03', '2026-08-31')").run();
	const eld = db.prepare("INSERT INTO eld_miles_daily (routemate_vehicle_id, local_day, driver_key, driver_name, truck_id, miles) VALUES (?, ?, ?, ?, ?, ?)");
	eld.run("rv-1", "2026-09-10", "a", DRIVER, 1, 100);
	eld.run("rv-1", "2026-09-10", "b", DRIVER, 1, 50.5);
	eld.run("rv-2", "2026-08-11", "", "", 2, 80);
	const exp = db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, photo_data, status, gallons, receipt_details, created_at) VALUES ('t', ?, ?, ?, ?, ?, ?, ?, ?, ?)");
	exp.run(DRIVER, "Fuel", 500, "2026-09-10", PHOTO, "Approved", 100, `[{"label":"Vendor","value":"${BROKER} ${RECEIPT_TEXT}"}]`, "2026-09-11 01:00:00");
	exp.run(DRIVER, "FUEL", 80, "2026-09-12", PHOTO, "Rejected", 0, "", "2026-09-12 15:00:00");
	exp.run(DRIVER, "fuel", 60, "bad", PHOTO, null, 12.5, "", "2026-09-13 15:00:00");
	exp.run(DRIVER, "Tolls", 20, "2026-09-14", PHOTO, "Pending", 0, `[{"label":"x","value":"${RECEIPT_TEXT}"}]`, "2026-09-14T03:00:00.000Z");
	const audit = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 1, 'super_admin', 'Super Admin', ?, 'expense', '0', ?)");
	audit.run("2026-09-15T02:00:00.000Z", "expense_ai_insights", "generated 3 insights");
	audit.run("2026-09-16T15:00:00.000Z", "expense_ai_query", DRIVER);
	audit.run("2026-09-16T15:00:00.000Z", "update_sheet_row", "x");
	const lsh = db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, changed_at) VALUES (?, ?, ?, ?, ?, ?)");
	lsh.run("l-1002", "In Transit", "At Receiver", "geofence", DRIVER, "2026-09-12 13:05:00");
	lsh.run("l-1001", "In Transit", "At Receiver", "manual", DRIVER, "2026-09-10 12:00:00");
	lsh.run("l-1002", "Dispatched", "At Shipper", "geofence", DRIVER, "2026-09-11 03:30:00");
	const runs = db.prepare("INSERT INTO invoice_autogen_runs (week_end, ran_at, attempts, failed, summary) VALUES (?, ?, 1, 0, ?)");
	runs.run("2026-09-12", "2026-09-12T23:30:00.000Z", "baseline (feature enabled — no retroactive run)");
	runs.run("2026-09-19", "2026-09-19T23:00:05.000Z", "3 created");
	const lem = db.prepare("INSERT INTO load_eld_miles (load_id, loaded_miles, deadhead_miles, basis, loaded_basis, deadhead_basis, dest_arrive_ms, overlap_load_ids, in_progress) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	lem.run("l-1002", 400, 50, "eld", "eld", "eld", Date.parse("2026-09-12T13:00:00Z"), "", 0);
	lem.run("l-1003", null, 20, "partial", "no-data", "eld", 0, "l-1002", 0);
	lem.run("l-1004", 300, 30, "eld", "eld", "eld", 0, "", 0);
	db.prepare("INSERT INTO load_coordinates (load_id, dest_lat, dest_lng) VALUES ('#L-1002', 29.7, -95.3)").run();
	db.prepare("INSERT INTO deleted_loads (load_id) VALUES ('l-1005')").run();
}

// ── contract-shaped fakes of Backend A's modules ───────────────────────────
const SETTINGS_USED = { fuel_savings: ["baselineMpg"], truck_utilization: ["aiDispatchStart", "dedicatedStart"], paid_mile_share: ["dedicatedStart"] };
function fakeLibs(log) {
	const METRICS = METRIC_KEYS.map((key) => ({
		key, label: `Label ${key}`, unit: "count", kind: key === "fuel_savings" || key === "freight_tons_estimated" ? "estimate" : "real", group: "ops",
		definition: "A sentence.", definitionVersion: 1, assumptions: key === "freight_tons_estimated" ? ["An assumption."] : [], source: null, settingsUsed: SETTINGS_USED[key] || [],
	}));
	const metricByKey = (k) => METRICS.find((m) => m.key === k) || null;
	const settingsHashFor = (k, s) => { const m = metricByKey(k); return m && m.settingsUsed.length ? JSON.stringify(m.settingsUsed.map((u) => s[u] ?? null)) : ""; };
	const approvalIsValid = (r, k, s) => !!r && r.approved === 1 && r.definition_version === metricByKey(k).definitionVersion && r.settings_hash === settingsHashFor(k, s);
	const catalog = { METRICS, METRIC_KEYS, metricByKey, settingsHashFor, approvalIsValid, KPI_SERIES_START: "2025-04" };
	const metrics = {
		computeKpis(inputs) {
			log.inputs.push(inputs);
			if (log.computeThrows) throw new Error(`compute failed for ${BROKER}`);
			const n = log.inputs.length;
			return {
				metrics: METRIC_KEYS.map((key) => ({
					key, status: key === "dispatch_calls" ? "not_tracked" : "ok", missingReason: null, value: n, display: String(n),
					current: { from: "2026-09-01", to: "2026-09-30", value: n, display: String(n), label: "September 2026" },
					totals: [], series: [{ period: "2026-08", value: n, display: String(n), coverage: 1 }, { period: "2026-09", value: n, display: String(n), coverage: 0.5 }],
					comparisons: [], beforeAfter: [], coverage: { num: 1, den: 1, ratio: 1, what: "loads", from: null, to: null },
					confidence: "high", warnings: [], assumptions: [], breakdown: key === "ai_tasks" && log.bigBreakdown ? [{ label: "x".repeat(5000), value: 1, display: "1" }] : [{ label: "AI rate-cons", value: n, display: String(n) }],
				})),
				derived: { aiDispatchStart: { value: "2026-04-09", evidence: "First delivered load through the AI email path; 5 such loads in the 14 days from 2026-04-09." } },
				errors: log.computeErrors || [],
			};
		},
		buildKpiResponse(args) {
			log.builds.push(args);
			return {
				asOfDay: args.asOfDay, timeZone: args.timeZone, generatedAt: new Date().toISOString(), job: args.job,
				settings: { aiDispatchStart: { value: args.derived.aiDispatchStart.value, source: "derived", evidence: args.derived.aiDispatchStart.evidence },
					dedicatedStart: { value: args.settings.dedicatedStart, source: null }, baselineMpg: args.settings.baselineMpg, recipients: args.settings.recipients,
					defaultRecipientConfigured: args.defaultRecipientConfigured },
				metrics: METRICS.map((m) => {
					const s = args.snapshots.find((r) => r.metric_key === m.key);
					const a = args.approvals.find((r) => r.metric_key === m.key);
					return {
						key: m.key, label: m.label, kind: m.kind, status: s ? s.status : "missing", missingReason: s ? null : "No snapshot yet",
						display: s ? s.display : "", current: s ? JSON.parse(s.payload).current : null, comparisons: [], confidence: s ? s.confidence : "none",
						assumptions: m.assumptions, warnings: [], computedDay: s ? s.day : null,
						approval: { approved: approvalIsValid(a, m.key, args.settings), by: null, at: null, stale: false },
					};
				}),
			};
		},
	};
	const weight = {
		MAX_PDF_BYTES: 3 * 1024 * 1024,
		parseWeight: (text) => {
			const all = [...String(text || "").slice(0, 200000).matchAll(/(\d{1,3}),(\d{3})\s{0,2}lbs/gi)].map((m) => Number(m[1] + m[2]));
			if (!all.length) return { status: "none", weightLb: null, evidence: "" };
			return new Set(all).size > 1 ? { status: "conflict", weightLb: null, evidence: "" } : { status: "ok", weightLb: all[0], evidence: "" };
		},
		classifyPdfText: (text, n) => (n > 3 * 1024 * 1024 ? "too_large" : (String(text || "").trim() ? "ok" : "no_text")),
	};
	return { catalog, metrics, weight };
}

// ── the world ───────────────────────────────────────────────────────────────
// opts: block, env, now (ISO), startsJob, folder, admin, sheet, drive
// ({ files(safe) -> [...], advanceMs, throws, bytes(fileId), metaSize(fileId) }),
// localDocs (file name under DATA_DIR/uploads -> Buffer, or a byte count for a
// sparse file), sendResult, db (reuse a database: a restart), seed.
const tmpDirs = [];
process.on("exit", () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function world(opts = {}) {
	const clock = { ms: Date.parse(opts.now || "2026-10-09T08:30:00Z") };
	class FakeDate extends Date {
		constructor(...a) { if (a.length) super(...a); else super(clock.ms); }
		static now() { return clock.ms; }
	}
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kpi-job-"));
	tmpDirs.push(dataDir);
	fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
	for (const [name, content] of Object.entries(opts.localDocs || {})) {
		const file = path.join(dataDir, "uploads", name);
		if (typeof content === "number") { fs.writeFileSync(file, ""); fs.truncateSync(file, content); } else fs.writeFileSync(file, content);
	}
	const log = { inputs: [], builds: [], sheetReads: 0, drive: [], mails: [], events: [], logs: [], timeouts: [], intervals: [], computeThrows: false, bigBreakdown: false };
	const libs = fakeLibs(log);
	const db = opts.db || new Database(":memory:");
	if (!opts.db) {
		for (const sql of DEP_DDL) db.exec(sql);
		if (opts.seed !== false) seed(db);
	}
	if (opts.before) opts.before(db);
	const cache = deepFreeze(opts.sheet || baseSheet());
	const drive = opts.drive || {};
	const control = { sheetThrows: false, sheetAdvanceMs: 0, sendResult: opts.sendResult === undefined ? true : opts.sendResult };
	const deps = {
		require: (p) => {
			const map = {
				"./lib/kpi-catalog": libs.catalog, "./lib/kpi-metrics": libs.metrics, "./lib/kpi-weight": libs.weight,
				"./lib/kpi-schedule": require(path.join(ROOT, "lib", "kpi-schedule.js")), "./lib/kpi-digest": require(path.join(ROOT, "lib", "kpi-digest.js")),
			};
			if (!(p in map)) throw new Error(`the KPI block required an unexpected module: ${p}`);
			return map[p];
		},
		process: { env: opts.env || {} },
		console: { log: (...a) => log.logs.push(a.join(" ")), warn: (...a) => log.logs.push(a.join(" ")), error: (...a) => log.logs.push(a.join(" ")) },
		Date: FakeDate,
		setTimeout: (fn, ms) => { const h = { fn, ms, fake: true }; log.timeouts.push(h); return h; },
		clearTimeout: (h) => { if (h && h.fake) h.cleared = true; },
		setInterval: (fn, ms) => { const h = { fn, ms }; log.intervals.push(h); return h; },
		setImmediate,
		db, app: { get() {}, put() {}, post() {} },
		appTime: require(path.join(ROOT, "lib", "app-time.js")),
		APP_TIMEZONE: "America/New_York",
		publicFormInput: require(path.join(ROOT, "lib", "public-form-input.js")),
		normalizeLoadId: require(path.join(ROOT, "lib", "ratecon-load.js")).normalizeLoadId,
		getJobTrackingCached: async () => { log.sheetReads++; clock.ms += control.sheetAdvanceMs; if (control.sheetThrows) throw new Error(`Sheets down near ${BROKER}`); return cache; },
		fs, path, DATA_DIR: dataDir,
		getDrive: async () => ({
			files: {
				list: async (params, options) => {
					log.drive.push({ op: "list", q: params.q, fields: params.fields, timeout: options && options.timeout });
					clock.ms += drive.advanceMs || 0;
					if (drive.throws) throw new Error(drive.throws);
					const safe = (params.q.match(/name contains '([^']*)'/) || [])[1] || "";
					return { data: { files: drive.files ? drive.files(safe) : [] } };
				},
				get: async (params, options) => {
					if (params.alt !== "media") {
						log.drive.push({ op: "meta", fileId: params.fileId, fields: params.fields, timeout: options && options.timeout });
						return { data: { id: params.fileId, size: drive.metaSize ? drive.metaSize(params.fileId) : "1200" } };
					}
					const marked = db.prepare("SELECT status FROM kpi_load_weights WHERE load_id = ?").get(String(params.fileId).replace(/^[a-z]+-/, ""));
					log.drive.push({ op: "get", fileId: params.fileId, timeout: options && options.timeout, maxContentLength: options && options.maxContentLength, markedAtFetch: marked ? marked.status : null });
					clock.ms += drive.advanceMs || 0;
					return { data: drive.bytes ? drive.bytes(params.fileId) : pdfWith("Weight: 42,000 lbs") };
				},
			},
		}),
		RATECON_DRIVE_FOLDER_ID: opts.folder === undefined ? "folder-under-test" : opts.folder,
		rcIndexShared: require(path.join(ROOT, "lib", "ratecon-drive-index.js")),
		brokerInvoice: require(path.join(ROOT, "lib", "broker-invoice.js")),
		notifyChange: (d) => log.events.push(d),
		sendEmail: async (to, subject, html) => { log.mails.push({ to, subject, html }); return control.sendResult; },
		ADMIN_NOTIFY_EMAIL: opts.admin === undefined ? ADMIN : opts.admin,
		startsJob: opts.startsJob || (() => false),
		requireRole: () => (req, res, next) => next(), refuseCrossOrigin: (req, res, next) => next(),
		rateLimit: () => (req, res, next) => next(), ipKeyGenerator: (ip) => ip,
	};
	const names = Object.keys(deps);
	const body = `"use strict";\n${HELPERS}\n${opts.block || BLOCK}\nreturn { runKpiSnapshot, kpiTick, kpiResponse, kpiClaimAndSend, kpiMaybeSendPreview, kpiMaybeSendDigest, kpiGatherDbInputs, kpiSheetLoads, liveJobTrackingView, state: () => ({ kpiRunning, kpiCurrentRunId, kpiJobStarted }) };`;
	const k = new Function(...names, body)(...names.map((n) => deps[n]));
	const at = (iso) => { clock.ms = Date.parse(iso); };
	return { db, k, log, clock, at, control, cache, settings: (s) => db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kpi.settings', ?)").run(JSON.stringify(s)) };
}
const all = (w, sql, ...a) => w.db.prepare(sql).all(...a);
const one = (w, sql, ...a) => w.db.prepare(sql).get(...a);

function section(fn) {
	return async (...args) => {
		const r = [];
		const t = (cond, name) => r.push({ ok: !!cond, name });
		try { await fn(t, ...args); } catch (e) { t(false, `section threw: ${e && e.message}`); }
		return r;
	};
}

// ─────────────────────────────────────────── §1 storage
const storageSection = section(async (t, block = BLOCK) => {
	const w = world({ block, before: (db) => {
		db.exec("CREATE TABLE kpi_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, day TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL DEFAULT 'running', duration_ms INTEGER, errors TEXT NOT NULL DEFAULT '[]', drive_fetches INTEGER NOT NULL DEFAULT 0)");
		db.prepare("INSERT INTO kpi_runs (kind, day, started_at, status) VALUES ('nightly', '2026-10-08', '2026-10-08T08:00:00.000Z', 'running')").run();
	} });
	const cols = (tbl) => all(w, `PRAGMA table_info(${tbl})`).map((c) => c.name).join(",");
	const pk = (tbl) => all(w, `PRAGMA table_info(${tbl})`).filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name).join(",");
	t(cols("kpi_runs") === "id,kind,day,started_at,finished_at,status,duration_ms,errors,drive_fetches" && pk("kpi_runs") === "id", "§1 kpi_runs: the contract's columns, id the key");
	t(cols("kpi_snapshots") === "day,metric_key,value,display,status,confidence,definition_version,payload,computed_at" && pk("kpi_snapshots") === "day,metric_key", "§1 kpi_snapshots: the contract's columns, (day, metric_key) the key");
	t(cols("kpi_series") === "metric_key,period,value,display,coverage,computed_at" && pk("kpi_series") === "metric_key,period", "§1 kpi_series: (metric_key, period) the key");
	t(cols("kpi_metric_approvals") === "metric_key,approved,definition_version,settings_hash,approved_by,approved_at" && pk("kpi_metric_approvals") === "metric_key", "§1 kpi_metric_approvals: metric_key the key");
	t(cols("kpi_load_weights") === "load_id,weight_lb,source,status,file_id,file_size,checked_at,text_rule" && pk("kpi_load_weights") === "load_id", "§1 kpi_load_weights: load_id the key, no column for a name or text");
	t(cols("kpi_digest_sends") === "slot_key,status,recipients_count,claimed_at,sent_at" && pk("kpi_digest_sends") === "slot_key", "§1 kpi_digest_sends: slot_key the key");
	const dflt = all(w, "PRAGMA table_info(kpi_metric_approvals)").find((c) => c.name === "approved").dflt_value;
	t(dflt === "0", "§1 an approval row defaults to not approved");
	const closed = one(w, "SELECT status, errors FROM kpi_runs WHERE day = '2026-10-08'");
	t(closed.status === "failed" && JSON.parse(closed.errors)[0].code === "INTERRUPTED", "§1 a run left 'running' by a stopped process is closed as INTERRUPTED");
	const again = world({ block, db: w.db });
	t(again.k && all(w, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kpi_%'").length === 6, "§1 the DDL runs again on an existing database (a restart)");
	const shape = (name) => new RegExp(`^const ${name} = !/\\^\\(false\\|0\\|no\\|off\\)\\$/i\\.test\\(String\\(process\\.env\\.${name} \\?\\? ""\\)\\.trim\\(\\)\\);$`, "m").test(block);
	t(shape("KPI_SNAPSHOT_ENABLED") && shape("KPI_DIGEST_ENABLED"), "§1 both switches have the kill-switch shape");
	for (const [v, on] of [[undefined, true], ["", true], ["true", true], ["yes", true], ["false", false], ["0", false], ["no", false], [" OFF ", false]]) {
		const x = world({ block, env: v === undefined ? {} : { KPI_SNAPSHOT_ENABLED: v }, startsJob: () => true });
		t(x.k.state().kpiJobStarted === on, `§1 KPI_SNAPSHOT_ENABLED=${JSON.stringify(v)}: the job ${on ? "starts" : "does not start"}`);
	}
});

// ─────────────────────────────────────────── §2 gathering
const gatherSection = section(async (t, block = BLOCK) => {
	const w = world({ block, before: (db) => {
		db.exec("CREATE TABLE IF NOT EXISTS kpi_snapshots (day TEXT NOT NULL, metric_key TEXT NOT NULL, value REAL, display TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, confidence TEXT NOT NULL DEFAULT 'none', definition_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}', computed_at TEXT NOT NULL, PRIMARY KEY (day, metric_key))");
		const s = db.prepare("INSERT INTO kpi_snapshots (day, metric_key, value, status, computed_at) VALUES (?, ?, ?, 'ok', 'x')");
		s.run("2026-10-07", "fleet_trucks", 6); s.run("2026-10-08", "fleet_trucks", 7); s.run("2026-10-09", "fleet_trucks", 8); s.run("2026-10-08", "loads_delivered", 5);
	} });
	const g = w.k.kpiGatherDbInputs(w.db, { asOfDay: "2026-10-09", timeZone: "America/New_York" });
	t(JSON.stringify(g.eldDaily.find((e) => e.day === "2026-09-10")) === JSON.stringify({ day: "2026-09-10", truckId: "1", miles: 150.5 }) && g.eldDaily.length === 2, "§2 ELD miles summed per (day, truck)");
	const [t1, t2, t3] = ["1", "2", "3"].map((id) => g.trucks.find((x) => x.id === id));
	t(t1.createdDay === "2026-04-09" && t1.inServiceDay === null && t1.retiredDay === null && t1.hasEld === true, "§2 created_at 02:30 UTC is the business day before; a linked device is ELD");
	t(t2.inServiceDay === "2026-05-03" && t2.retiredDay === "2026-08-31" && t2.status === "Inactive" && t2.hasEld === true, "§2 service days as recorded; a past device assignment is ELD; status as stored");
	t(t3.inServiceDay === null && t3.hasEld === false, "§2 an unreadable in-service date is none; no device, no ELD");
	t(JSON.stringify(g.fleetHistory) === JSON.stringify([{ day: "2026-10-07", value: 6 }, { day: "2026-10-08", value: 7 }]), "§2 fleet history: earlier days' fleet_trucks only");
	t(g.fuelReceipts.length === 3 && g.fuelReceipts.some((f) => f.status === "Rejected" && f.gallons === null) && g.fuelReceipts.some((f) => f.day === null && f.gallons === 12.5 && f.status === ""),
		"§2 fuel receipts: every case of 'fuel', status raw (Rejected kept), 0 gallons none, a bad date none");
	t(JSON.stringify(g.activity.aiReceipts.sort()) === JSON.stringify(["2026-09-10", "2026-09-13"]), `§2 AI-read receipts by business day (${g.activity.aiReceipts})`);
	t(JSON.stringify(g.activity.aiExpenseInsights.sort()) === JSON.stringify(["2026-09-14", "2026-09-16"]), "§2 AI insights and queries by business day");
	t(JSON.stringify(g.activity.geofenceStatuses.sort()) === JSON.stringify(["2026-09-10", "2026-09-12"]), "§2 geofence status changes by business day");
	t(JSON.stringify(g.activity.invoiceAutogenRuns) === JSON.stringify(["2026-09-19"]), "§2 invoice auto-generation runs, the baseline marker excluded");
	t(g.receiverEvents.get("l-1002").length === 1 && g.receiverEvents.get("l-1002")[0].at === "2026-09-12 13:05:00" && g.receiverEvents.get("l-1001")[0].source === "manual", "§2 At Receiver events with their source, the stored timestamp as is");
	t(g.loadEld.get("l-1002").eldArriveMs === Date.parse("2026-09-12T13:00:00Z") && g.loadEld.get("l-1003").eldArriveMs === null && g.loadEld.get("l-1003").loadedMiles === null && g.loadEld.get("l-1003").overlap === true,
		"§2 load miles: dest_arrive_ms 0 is none, a NULL leg stays null, overlaps flagged");
	t(g.destLng.get("l-1002") === -95.3, "§2 destination longitude keyed by the normalised load id");
	const json = JSON.stringify(g, (k, v) => (v instanceof Map ? [...v] : v));
	t(!json.includes(PHOTO) && !json.includes(RECEIPT_TEXT), "§2 no receipt photo and no receipt text in what was gathered");
	const fn = liftFrom(block, "kpiGatherDbInputs");
	const sqls = fn.match(/"SELECT [^"]+"/g) || [];
	t(sqls.length >= 9, `§2 the gather's SQL statements found (${sqls.length})`);
	const columnsOf = (q) => q.slice(7, q.search(/ FROM /));
	t(sqls.every((q) => !/\*/.test(columnsOf(q))), "§2 no SELECT * anywhere in the gather");
	t(!/photo_data/.test(fn) && sqls.every((q) => !/receipt_details/.test(columnsOf(q))), "§2 photo_data is never named; receipt_details is never selected");
});

// ─────────────────────────────────────────── §3 the sheet
const sheetSection = section(async (t, block = BLOCK) => {
	const w = world({ block });
	const before = JSON.stringify(w.cache);
	const { loads, arrivals } = w.k.kpiSheetLoads(w.k.liveJobTrackingView(w.cache));
	const by = (id) => loads.find((l) => l.loadId === id);
	t(loads.length === 6 && !by("l-1004") && !by("l-1005"), "§3 cancelled and soft-deleted loads are gone");
	t(by("l-1001").day === "2026-09-10" && by("l-1002").day === "2026-09-12" && by("l-1003").day === "2026-09-01" && by("l-1008").day === null, "§3 day: Completion, else Drop-off, else Pickup, else none");
	t(by("l-1001").contractIdBlank === true && by("l-1002").contractIdBlank === false, "§3 Contract ID blank is the AI path");
	t(by("l-1001").driverKey === "quinn sentinel" && by("l-1001").truckKey === "101", "§3 driver and truck keys trimmed and lower-cased");
	t(by("l-1007").detailsText.length === 2000 && arrivals.find((a) => a.loadId === "l-1007").appointmentText.length === 200, "§3 Details capped at 2000, the appointment at 200");
	t(arrivals.map((a) => a.loadId).sort().join() === "l-1001,l-1002,l-1003,l-1007,l-1008", "§3 arrivals: delivered loads only");
	t(arrivals.find((a) => a.loadId === "l-1002").appointmentText === "09/12/2026 14:00" && arrivals.find((a) => a.loadId === "l-1002").deliveredDay === "2026-09-12", "§3 an arrival carries its appointment text and day");
	t(JSON.stringify(w.cache) === before && Object.isFrozen(w.cache.data[0]), "§3 the shared cache is untouched");
	const noContract = w.k.kpiSheetLoads({ headers: ["Load ID", "Status"], data: [{ "Load ID": "9", Status: "Delivered" }] }).loads[0];
	t(noContract.contractIdBlank === false, "§3 no Contract ID column: no load counts as the AI path");
});

// ─────────────────────────────────────────── §4 revenue
const revenueSection = section(async (t, block = BLOCK) => {
	const w = world({ block, sheet: { headers: HEADERS, data: [
		row(0, { "Load ID": "R-1", Status: "Delivered", "Completion Date": "2026-09-10", "  Payment  ": " $ 1,834.50 " }),
		row(1, { "Load ID": "R-2", Status: "Delivered", "Completion Date": "2026-09-11", "  Payment  ": "" }),
		row(2, { "Load ID": "R-3", Status: "Delivered", "Completion Date": "2026-09-12", "  Payment  ": "n/a" }),
	] } });
	const { loads } = w.k.kpiSheetLoads(w.k.liveJobTrackingView(w.cache));
	const by = (id) => loads.find((l) => l.loadId === id);
	t(by("r-1").revenue === 1834.5, `§4 the Payment cell read as money (${by("r-1").revenue})`);
	t(by("r-2").revenue === 0 && by("r-3").revenue === 0, "§4 a blank or unreadable Payment is 0 (lib/kpi-metrics.js counts only a figure above 0)");
	const none = w.k.kpiSheetLoads({ headers: ["Load ID", "Status"], data: [{ "Load ID": "9", Status: "Delivered" }] }).loads[0];
	t(none.revenue === null, "§4 no Payment column: no revenue figure at all");
});

// ─────────────────────────────────────────── §5 a nightly run
const runSection = section(async (t, block = BLOCK) => {
	const w = world({ block, before: (db) => {
		db.exec("CREATE TABLE IF NOT EXISTS kpi_snapshots (day TEXT NOT NULL, metric_key TEXT NOT NULL, value REAL, display TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, confidence TEXT NOT NULL DEFAULT 'none', definition_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}', computed_at TEXT NOT NULL, PRIMARY KEY (day, metric_key))");
		db.prepare("INSERT INTO kpi_snapshots (day, metric_key, value, display, status, computed_at) VALUES ('2026-10-08', 'loads_delivered', 7, '7', 'ok', '2026-10-08T08:01:00.000Z')").run();
	} });
	w.settings({ baselineMpg: 8, aiDispatchStart: "2026-04-01", dedicatedStart: null, recipients: [] });
	const out = await w.k.runKpiSnapshot("nightly");
	const run = one(w, "SELECT * FROM kpi_runs WHERE id = ?", out.runId);
	t(out.status === "ok" && run.status === "ok" && run.kind === "nightly" && run.day === "2026-10-09" && run.errors === "[]" && run.finished_at && run.duration_ms >= 0, `§5 the run row: ok, nightly, the business day (${run && run.status} ${run && run.errors})`);
	t(/Z$/.test(run.started_at) && /Z$/.test(run.finished_at), "§5 timestamps are ISO Z");
	const inputs = w.log.inputs[0];
	t(inputs && ["asOfDay", "settings", "loads", "ratecon", "eldDaily", "trucks", "fleetHistory", "fuelReceipts", "arrivals", "loadMiles", "activity"].every((k) => k in inputs), "§5 computeKpis() gets every input the contract names");
	t(inputs.asOfDay === "2026-10-09" && JSON.stringify(inputs.settings) === JSON.stringify({ aiDispatchStart: "2026-04-01", dedicatedStart: null, baselineMpg: 8 }), "§5 asOfDay and the settings (no recipients)");
	t(inputs.loads.find((l) => l.loadId === "l-1002").revenue === 0 && !("revenueByMonth" in inputs), "§5 revenue rides on each load; no books are read");
	const a2 = inputs.arrivals.find((a) => a.loadId === "l-1002");
	t(a2 && a2.destLng === -95.3 && a2.eldArriveMs === Date.parse("2026-09-12T13:00:00Z") && a2.receiverEvents.length === 1 && a2.receiverEvents[0].source === "geofence", "§5 an arrival joined to its coordinates, ELD arrival and receiver events");
	t(inputs.loadMiles.map((m) => m.loadId).sort().join() === "l-1002,l-1003" && inputs.loadMiles.find((m) => m.loadId === "l-1002").day === "2026-09-12", "§5 load miles for live loads only (a cancelled load's dropped), with the load's day");
	const snaps = all(w, "SELECT * FROM kpi_snapshots WHERE day = '2026-10-09'");
	t(snaps.length === 16 && snaps.every((s) => s.definition_version === 1 && /Z$/.test(s.computed_at)), "§5 sixteen snapshot rows for the day");
	t(snaps.every((s) => Buffer.byteLength(s.payload) <= 4096), "§5 every payload within 4 KB");
	const payload = JSON.parse(snaps.find((s) => s.metric_key === "ai_tasks").payload);
	t(["current", "totals", "comparisons", "beforeAfter", "coverage", "warnings", "assumptions", "breakdown", "missingReason"].every((k) => k in payload) && payload.breakdown[0].label === "AI rate-cons",
		"§5 the payload carries current, totals, comparisons, beforeAfter, coverage, warnings, assumptions, breakdown, missingReason");
	t(one(w, "SELECT COUNT(*) AS n FROM kpi_series").n === 32 && one(w, "SELECT coverage FROM kpi_series WHERE metric_key = 'revenue' AND period = '2026-09'").coverage === 0.5, "§5 the series stored");
	t(JSON.parse(one(w, "SELECT value FROM server_state WHERE key = 'kpi.derived'").value).aiDispatchStart.value === "2026-04-09", "§5 the derived AI dispatch start stored");
	const old = one(w, "SELECT value, computed_at FROM kpi_snapshots WHERE day = '2026-10-08' AND metric_key = 'loads_delivered'");
	t(old.value === 7 && old.computed_at === "2026-10-08T08:01:00.000Z", "§5 the earlier day's row is untouched");
	t(w.log.events.filter((e) => e === "kpis").length >= 2, "§5 kpis:changed emitted at start and end");
	w.clock.ms += 3600000;
	await w.k.runKpiSnapshot("manual");
	t(one(w, "SELECT value FROM kpi_snapshots WHERE day = '2026-10-09' AND metric_key = 'revenue'").value === 2 && one(w, "SELECT value FROM kpi_snapshots WHERE day = '2026-10-08'").value === 7,
		"§5 a later run the same day replaces that day's rows, and only those");
	t(JSON.stringify(w.cache) === JSON.stringify(deepFreeze(baseSheet())), "§5 the shared Job Tracking cache was never written");
	w.control.sheetThrows = true;
	w.clock.ms += 3600000;
	const failed = await w.k.runKpiSnapshot("nightly");
	const fr = one(w, "SELECT status, errors FROM kpi_runs WHERE id = ?", failed.runId);
	t(fr.status === "failed" && JSON.parse(fr.errors).some((e) => e.code === "SHEET_READ_FAILED") && one(w, "SELECT value FROM kpi_snapshots WHERE day = '2026-10-09' AND metric_key = 'revenue'").value === 2,
		"§5 a failed sheet read fails the run as SHEET_READ_FAILED and writes nothing");
	w.control.sheetThrows = false;
	w.log.bigBreakdown = true;
	w.clock.ms += 3600000;
	const big = await w.k.runKpiSnapshot("manual");
	const bigRun = one(w, "SELECT status, errors FROM kpi_runs WHERE id = ?", big.runId);
	const trimmed = JSON.parse(one(w, "SELECT payload FROM kpi_snapshots WHERE day = '2026-10-09' AND metric_key = 'ai_tasks'").payload);
	t(bigRun.status === "partial" && bigRun.errors === JSON.stringify([{ metric: "ai_tasks", code: "PAYLOAD_TRIMMED" }]) && trimmed.breakdown === null && trimmed.current && trimmed.current.label === "September 2026",
		"§5 a payload over 4 KB loses its breakdown first, keeps its figure, and the run says PAYLOAD_TRIMMED");
	w.log.bigBreakdown = false;
	w.log.computeErrors = [{ metric: "on_time_rate", code: "KPI_COMPUTE_FAILED" }, { metric: DRIVER, code: `failed near ${BROKER}` }];
	w.clock.ms += 3600000;
	const partial = await w.k.runKpiSnapshot("manual");
	const pr = one(w, "SELECT status, errors FROM kpi_runs WHERE id = ?", partial.runId);
	t(pr.status === "partial" && pr.errors === JSON.stringify([{ metric: "on_time_rate", code: "KPI_COMPUTE_FAILED" }, { metric: null, code: "KPI_COMPUTE_FAILED" }]) &&
		one(w, "SELECT COUNT(*) AS n FROM kpi_snapshots WHERE day = '2026-10-09'").n === 16,
		`§5 computeKpis() error codes join the run (partial), an unknown metric or a code that is not one kept out (${pr.errors})`);
	w.log.computeErrors = [];
	w.log.computeThrows = true;
	const cf = await w.k.runKpiSnapshot("manual");
	t(one(w, "SELECT status, errors FROM kpi_runs WHERE id = ?", cf.runId).errors === JSON.stringify([{ metric: null, code: "COMPUTE_FAILED" }]), "§5 a compute failure: COMPUTE_FAILED, nothing else");
});

// ─────────────────────────────────────────── §6 the weight phase
const driveFiles = (safe) => [
	{ id: `old-${safe}`, name: `Subject: ${BROKER} Order #${safe} (older).pdf`, size: "900", createdTime: "2026-01-01T00:00:00.000Z" },
	{ id: `f-${safe}`, name: `Subject: ${BROKER} Order #${safe}.pdf`, size: "1200", createdTime: "2026-09-01T00:00:00.000Z" },
	{ id: `other-${safe}`, name: "Subject: another load.pdf", size: "1200", createdTime: "2026-10-01T00:00:00.000Z" },
];
const weightSection = section(async (t, block = BLOCK) => {
	const w = world({ block, sheet: weightSheet(50), drive: { files: driveFiles } });
	await w.k.runKpiSnapshot("nightly");
	const lists = w.log.drive.filter((d) => d.op === "list");
	const gets = w.log.drive.filter((d) => d.op === "get");
	t(lists.length === 40 && gets.length === 40, `§6 at most 40 loads a night: 40 lists, 40 downloads (${lists.length}, ${gets.length})`);
	t(one(w, "SELECT drive_fetches AS n FROM kpi_runs").n === 80, "§6 the run counts its Drive requests");
	const rows = all(w, "SELECT * FROM kpi_load_weights ORDER BY load_id");
	t(rows.length === 40 && rows[0].load_id === "512000011" && rows[39].load_id === "512000050", "§6 newest loads first");
	t(rows.every((r) => r.status === "ok" && r.weight_lb === 42000 && r.source === "ratecon_pdf" && r.file_id === `f-${r.load_id}` && r.file_size > 0 && /Z$/.test(r.checked_at)), "§6 the newest matching file read: weight, file id and size, no name");
	t(lists.every((l) => l.fields === "files(id,name,size,createdTime)" && l.timeout === 20000) && gets.every((g) => g.timeout === 20000), "§6 one list by name (id, name, size, createdTime), 20 s timeouts");
	t(lists.every((l) => /^'folder-under-test' in parents and trashed = false and name contains '\d+'$/.test(l.q)), "§6 the list is by file name in the configured folder, never by content");
	w.clock.ms += 86400000;
	w.log.drive.length = 0;
	await w.k.runKpiSnapshot("nightly");
	t(w.log.drive.filter((d) => d.op === "list").length === 10 && one(w, "SELECT COUNT(*) AS n FROM kpi_load_weights").n === 50, "§6 the next night takes the remaining 10, and no load twice");
	w.clock.ms += 86400000;
	w.log.drive.length = 0;
	await w.k.runKpiSnapshot("manual");
	t(w.log.drive.length === 0, "§6 nothing left to read: no Drive request");
});
const weightCacheSection = section(async (t, block = BLOCK) => {
	const sheet = weightSheet(6);
	sheet.data[5].Details = "Paper rolls, 38,500 lbs";
	const day = 86400000;
	const nowMs = Date.parse("2026-10-09T08:30:00Z");
	const w = world({ block, sheet, drive: { files: (safe) => (safe === "512000002" ? [{ id: "big", name: `Order ${safe}.pdf`, size: String(4 * 1024 * 1024), createdTime: "x" }] : []) },
		localDocs: { [`${BROKER} rate con.pdf`]: pdfWith("Gross weight 41,250 lbs") },
		before: (db) => {
			db.exec("CREATE TABLE IF NOT EXISTS kpi_load_weights (load_id TEXT PRIMARY KEY, weight_lb REAL, source TEXT NOT NULL DEFAULT 'ratecon_pdf', status TEXT NOT NULL, file_id TEXT NOT NULL DEFAULT '', file_size INTEGER, checked_at TEXT NOT NULL)");
			const ins = db.prepare("INSERT INTO kpi_load_weights (load_id, status, checked_at) VALUES (?, ?, ?)");
			ins.run("512000003", "not_found", new Date(nowMs - 5 * day).toISOString());
			ins.run("512000004", "not_found", new Date(nowMs - 31 * day).toISOString());
			ins.run("512000005", "error", new Date(nowMs - 2 * day).toISOString());
			db.prepare("INSERT INTO documents (id, load_id, driver, type, file_name, uploaded_at) VALUES (9, '512000001', 'x', 'RateCon', ?, '2026-09-01 00:00:00')").run(`${BROKER} rate con.pdf`);
		} });
	await w.k.runKpiSnapshot("nightly");
	const listed = w.log.drive.filter((d) => d.op === "list").map((d) => d.q.match(/'(\d+)'$/)[1]).sort();
	t(listed.join() === "512000002,512000004", `§6 Drive listed only for the load with no stored rate-con and the 31-day-old not_found (${listed})`);
	t(!w.log.drive.some((d) => /512000001/.test(String(d.q || d.fileId))), "§6 the stored RATECON document (on disk) read first: no Drive request for that load");
	const r = (id) => one(w, "SELECT * FROM kpi_load_weights WHERE load_id = ?", id);
	t(r("512000001").status === "ok" && r("512000001").weight_lb === 41250 && r("512000001").file_id === "document:9", "§6 ...and its weight taken, with no Drive request");
	t(r("512000002").status === "too_large" && r("512000002").file_size === 4 * 1024 * 1024 && !w.log.drive.some((d) => d.op === "get"), "§6 a file over the size limit: too_large, never downloaded");
	t(r("512000003").checked_at === new Date(nowMs - 5 * day).toISOString() && r("512000005").status === "error", "§6 not_found and error answers younger than 30 days stand");
	t(r("512000004").status === "not_found" && r("512000004").checked_at === new Date(nowMs).toISOString(), "§6 an older not_found is tried again");
	t(!r("512000006"), "§6 a load whose Details state a weight is not looked up");
	t(!JSON.stringify(all(w, "SELECT * FROM kpi_load_weights")).includes("rate con.pdf"), "§6 no file name stored");

	const noFolder = world({ block, sheet: weightSheet(3), folder: "", drive: { files: driveFiles } });
	await noFolder.k.runKpiSnapshot("nightly");
	t(noFolder.log.drive.length === 0 && all(noFolder, "SELECT status FROM kpi_load_weights").every((x) => x.status === "not_found"), "§6 no folder setting: no Drive request; not_found");
	const manual = world({ block, sheet: weightSheet(3), drive: { files: driveFiles } });
	await manual.k.runKpiSnapshot("manual");
	t(manual.log.drive.length === 0 && one(manual, "SELECT COUNT(*) AS n FROM kpi_load_weights").n === 0, "§6 a manual run never calls Drive");

	const secret = `${BROKER} at /srv/private/ratecons/${BROKER}.pdf`;
	const broken = world({ block, sheet: weightSheet(2), drive: { files: driveFiles, throws: secret } });
	const out = await broken.k.runKpiSnapshot("nightly");
	const run = one(broken, "SELECT status, errors FROM kpi_runs WHERE id = ?", out.runId);
	t(run.status === "partial" && run.errors === JSON.stringify([{ metric: "freight_tons_stated", code: "RATECON_FETCH_FAILED" }]), `§6 a Drive failure: the run is partial with a code (${run.errors})`);
	t(all(broken, "SELECT status FROM kpi_load_weights").every((x) => x.status === "error"), "§6 ...and the loads are marked error, to be tried again later");
	const everything = JSON.stringify(all(broken, "SELECT * FROM kpi_runs")) + JSON.stringify(all(broken, "SELECT * FROM kpi_load_weights")) + broken.log.logs.join("\n");
	t(!everything.includes("/srv/private") && !everything.includes(BROKER), "§6 ...and the error's text is stored and logged nowhere");
});

// ─────────────────────────────────────────── §6c a 'no_text' from an earlier text rule
const textRuleSection = section(async (t, block = BLOCK) => {
	const yesterday = new Date(Date.parse("2026-10-08T12:00:00Z")).toISOString();
	const w = world({ block, sheet: weightSheet(3), drive: { files: driveFiles } });
	// Runs the block once so its DDL (the text_rule column included) exists.
	await w.k.runKpiSnapshot("manual");
	const ins = w.db.prepare("INSERT OR REPLACE INTO kpi_load_weights (load_id, status, checked_at, text_rule) VALUES (?, 'no_text', ?, ?)");
	ins.run("512000001", yesterday, 1);
	ins.run("512000002", yesterday, 2);
	ins.run("512000003", yesterday, 2);
	await w.k.runKpiSnapshot("nightly");
	const listed = w.log.drive.filter((d) => d.op === "list").map((d) => d.q.match(/'(\d+)'$/)[1]);
	t(listed.join() === "512000001", `§6c a 'no_text' judged under the earlier rule is read again; one under the current rule is not (${listed})`);
	const r = w.db.prepare("SELECT status, weight_lb, text_rule FROM kpi_load_weights WHERE load_id = '512000001'").get();
	t(r.status === "ok" && r.weight_lb === 42000 && r.text_rule === 2, "§6c ...and its new answer is stored under the current rule");
});

// ─────────────────────────────────────────── §6b the weight phase's limits
// A rate-con that inflates far past the text cap (8 MB), from a few dozen kilobytes.
function bombPdf() {
	return Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n"), zlib.deflateSync(Buffer.from("(Weight: 42,000 lbs) Tj\n".repeat(400000))), Buffer.from("\nendstream\nendobj\n%%EOF\n")]);
}
const weightLimitsSection = section(async (t, block = BLOCK) => {
	const w = world({ block, sheet: weightSheet(50), drive: { files: driveFiles } });
	await w.k.runKpiSnapshot("nightly");
	const gets = w.log.drive.filter((d) => d.op === "get");
	t(gets.length === 40 && gets.every((g) => g.markedAtFetch === "error"), "§6b each load is recorded (error) before its rate-con is fetched, so a crash is not retried nightly");
	t(gets.every((g) => g.maxContentLength === 3 * 1024 * 1024), "§6b every download is capped at 3 MB");
	w.log.drive.length = 0;
	w.clock.ms += 3600000;
	await w.k.runKpiSnapshot("nightly");
	t(w.log.drive.length === 0 && one(w, "SELECT COUNT(*) AS n FROM kpi_load_weights").n === 40, "§6b a second run the same business day reads no more: 40 loads a day, not a run");

	const stored = world({ block, sheet: weightSheet(3), drive: { files: () => [], metaSize: (id) => (id === "drive-big" ? String(4 * 1024 * 1024) : "1200"), bytes: () => pdfWith("Weight: 39,000 lbs") },
		localDocs: { "big.pdf": 4 * 1024 * 1024 },
		before: (db) => {
			const ins = db.prepare("INSERT INTO documents (id, load_id, driver, type, file_name, drive_file_id, uploaded_at) VALUES (?, ?, 'x', 'RATECON', ?, ?, '2026-09-01 00:00:00')");
			ins.run(11, "512000001", "big.pdf", null);
			ins.run(12, "512000002", "not-on-disk.pdf", "drive-ok");
			ins.run(13, "512000003", "not-on-disk-either.pdf", "drive-big");
		} });
	await stored.k.runKpiSnapshot("nightly");
	const r = (id) => one(stored, "SELECT * FROM kpi_load_weights WHERE load_id = ?", id);
	t(r("512000001").status === "too_large" && r("512000001").file_size === 4 * 1024 * 1024, "§6b a stored file over 3 MB on disk: too_large, never read");
	t(r("512000002").status === "ok" && r("512000002").weight_lb === 39000 && r("512000002").file_id === "document:12", "§6b a stored Drive file: its size first, then the download");
	const ops = (id) => stored.log.drive.filter((d) => d.fileId === id).map((d) => d.op).join();
	t(ops("drive-ok") === "meta,get" && ops("drive-big") === "meta" && r("512000003").status === "too_large", "§6b ...and one over 3 MB is never downloaded");
	t(stored.log.drive.filter((d) => d.fileId === "drive-ok").every((d) => d.timeout === 20000), "§6b ...within the 20 s timeout");
	t(one(stored, "SELECT drive_fetches AS n FROM kpi_runs").n === 3, "§6b ...and each of those requests is counted");

	const names = world({ block, sheet: { headers: HEADERS, data: [
		row(0, { "Load ID": "1234", Status: "Delivered", Details: "General freight", "Completion Date": "2026-09-01" }),
		row(1, { "Load ID": "512000001", Status: "Delivered", Details: "General freight", "Completion Date": "2026-09-02" }),
	] }, drive: { files: (safe) => [{ id: `look-${safe}`, name: `Order 9${safe}7.pdf`, size: "1200", createdTime: "2026-09-01T00:00:00.000Z" }] } });
	await names.k.runKpiSnapshot("nightly");
	const lists = names.log.drive.filter((d) => d.op === "list");
	t(lists.length === 1 && /512000001/.test(lists[0].q), "§6b a load id under 5 characters is never looked up by file name");
	t(one(names, "SELECT status FROM kpi_load_weights WHERE load_id = '512000001'").status === "not_found" && !names.log.drive.some((d) => d.op === "get"),
		"§6b a file whose name holds the id inside a longer number is not that load's");

	const bomb = world({ block, sheet: weightSheet(1), drive: { files: driveFiles, bytes: () => bombPdf() } });
	await bomb.k.runKpiSnapshot("nightly");
	const b = one(bomb, "SELECT status, weight_lb FROM kpi_load_weights");
	t(b && b.status !== "ok" && b.weight_lb === null, `§6b a rate-con that inflates past 8 MB is not read past the cap (${b && b.status})`);
});

// ─────────────────────────────────────────── §7 the time box
const timeSection = section(async (t, block = BLOCK) => {
	const slow = world({ block, sheet: weightSheet(40), drive: { files: driveFiles, advanceMs: 20000 } });
	const out = await slow.k.runKpiSnapshot("nightly");
	const lists = slow.log.drive.filter((d) => d.op === "list").length;
	const run = one(slow, "SELECT status, errors FROM kpi_runs WHERE id = ?", out.runId);
	t(lists === 3 && run.status === "partial" && JSON.parse(run.errors).some((e) => e.code === "RATECON_TIME_LIMIT"), `§7 the Drive phase stops at 2 minutes (${lists} loads at 40 s each), RATECON_TIME_LIMIT`);
	t(one(slow, "SELECT COUNT(*) AS n FROM kpi_snapshots").n === 16, "§7 ...and the run still stores its figures");
	const late = world({ block });
	late.control.sheetAdvanceMs = 5 * 60 * 1000;
	const o2 = await late.k.runKpiSnapshot("nightly");
	const r2 = one(late, "SELECT status, errors FROM kpi_runs WHERE id = ?", o2.runId);
	t(r2.status === "failed" && JSON.parse(r2.errors).some((e) => e.code === "TIME_LIMIT") && late.log.inputs.length === 0 && one(late, "SELECT COUNT(*) AS n FROM kpi_snapshots").n === 0,
		"§7 past 4 minutes: TIME_LIMIT, nothing computed, nothing stored");
	const within = new Function("setTimeout", "clearTimeout", `${liftFrom(block, "kpiWithin")}\nreturn kpiWithin;`)(setTimeout, clearTimeout);
	let code = null;
	try { await within(new Promise(() => {}), 5); } catch (e) { code = e.kpiCode; }
	t(code === "TIME_LIMIT", "§7 kpiWithin(): a promise that never settles is cut off with TIME_LIMIT");
	t((await within(Promise.resolve(7), 1000)) === 7, "§7 kpiWithin(): a prompt answer passes through");
});

// ─────────────────────────────────────────── §8 emails
const MONDAY_0930 = "2026-10-12T13:30:00Z";
const emailSection = section(async (t, block = BLOCK) => {
	const w = world({ block, now: "2026-10-09T08:30:00Z" });
	w.settings({ recipients: ["ops@example.test", "owner@example.test"] });
	t((await w.k.kpiMaybeSendPreview(Date.now())) === null && w.log.mails.length === 0, "§8 no successful run yet: no preview");
	await w.k.runKpiSnapshot("nightly");
	await w.k.kpiMaybeSendPreview(w.clock.ms);
	t(w.log.mails.length === 1 && w.log.mails[0].to === ADMIN && w.log.mails[0].subject.startsWith("PREVIEW – not approved for public use: LogisX weekly KPIs: week of Oct 5, 2026"),
		`§8 the preview: one email, to ADMIN_NOTIFY_EMAIL only, marked (${w.log.mails[0] && w.log.mails[0].to})`);
	const p = one(w, "SELECT * FROM kpi_digest_sends WHERE slot_key = 'preview'");
	t(p.status === "sent" && /Z$/.test(p.sent_at) && p.recipients_count === 1, "§8 ...recorded as sent");
	await w.k.kpiMaybeSendPreview(w.clock.ms);
	t(w.log.mails.length === 1, "§8 ...and never sent again");
	const g = w.k.kpiResponse(w.clock.ms);
	t(g.metrics.every((m) => w.log.mails[0].html.includes(m.label)) && g.job.preview.status === "sent", "§8 built from the same object GET returns");

	const failing = world({ block, sendResult: false });
	await failing.k.runKpiSnapshot("nightly");
	await failing.k.kpiMaybeSendPreview(failing.clock.ms);
	const fp = one(failing, "SELECT status, sent_at FROM kpi_digest_sends WHERE slot_key = 'preview'");
	t(failing.log.mails.length === 1 && fp.status === "failed" && fp.sent_at === null, "§8 sendEmail() false: the preview is failed, not sent");
	await failing.k.kpiMaybeSendPreview(failing.clock.ms);
	t(failing.log.mails.length === 1, "§8 ...and not retried");
	const noAdmin = world({ block, admin: "" });
	noAdmin.settings({ recipients: ["ops@example.test"] });
	await noAdmin.k.runKpiSnapshot("nightly");
	await noAdmin.k.kpiMaybeSendPreview(noAdmin.clock.ms);
	t(noAdmin.log.mails.length === 0 && one(noAdmin, "SELECT status FROM kpi_digest_sends WHERE slot_key = 'preview'").status === "no_recipient", "§8 no ADMIN_NOTIFY_EMAIL: no preview to anyone else; no_recipient");

	const d = world({ block, now: MONDAY_0930, before: (db) => {
		db.exec("CREATE TABLE IF NOT EXISTS kpi_digest_sends (slot_key TEXT PRIMARY KEY, status TEXT NOT NULL, recipients_count INTEGER NOT NULL DEFAULT 0, claimed_at TEXT NOT NULL, sent_at TEXT)");
		db.prepare("INSERT INTO kpi_digest_sends (slot_key, status, claimed_at) VALUES ('digest:2026-10-05', 'sent', 'x')").run();
	} });
	d.settings({ recipients: ["ops@example.test", "owner@example.test"] });
	await d.k.kpiMaybeSendDigest(d.clock.ms);
	t(d.log.mails.length === 1 && d.log.mails[0].to === "ops@example.test, owner@example.test" && d.log.mails[0].subject === "LogisX weekly KPIs: week of Oct 12, 2026",
		`§8 Monday 09:30: the digest to the page's recipients (${d.log.mails[0] && d.log.mails[0].to})`);
	t(one(d, "SELECT status, recipients_count FROM kpi_digest_sends WHERE slot_key = 'digest:2026-10-12'").recipients_count === 2, "§8 ...recorded with its recipient count");
	await d.k.kpiMaybeSendDigest(d.clock.ms + 60000);
	t(d.log.mails.length === 1, "§8 ...once");
	const dflt = world({ block, now: MONDAY_0930 });
	await dflt.k.kpiMaybeSendDigest(dflt.clock.ms);
	t(dflt.log.mails.length === 1 && dflt.log.mails[0].to === ADMIN, "§8 no recipients set: the digest goes to ADMIN_NOTIFY_EMAIL");
	const nobody = world({ block, now: MONDAY_0930, admin: "" });
	await nobody.k.kpiMaybeSendDigest(nobody.clock.ms);
	t(nobody.log.mails.length === 0 && one(nobody, "SELECT status FROM kpi_digest_sends WHERE slot_key = 'digest:2026-10-12'").status === "no_recipient", "§8 nobody to send to: no_recipient");

	const restart = world({ block, now: MONDAY_0930, before: (db) => {
		db.exec("CREATE TABLE IF NOT EXISTS kpi_digest_sends (slot_key TEXT PRIMARY KEY, status TEXT NOT NULL, recipients_count INTEGER NOT NULL DEFAULT 0, claimed_at TEXT NOT NULL, sent_at TEXT)");
		db.prepare("INSERT INTO kpi_digest_sends (slot_key, status, recipients_count, claimed_at) VALUES ('digest:2026-10-12', 'claimed', 1, '2026-10-12T13:00:01.000Z')").run();
		db.prepare("INSERT INTO kpi_digest_sends (slot_key, status, recipients_count, claimed_at) VALUES ('preview', 'claimed', 1, '2026-10-12T13:00:01.000Z')").run();
	} });
	const st = await restart.k.kpiClaimAndSend({ slotKey: "digest:2026-10-12", recipients: [ADMIN], preview: false, nowMs: restart.clock.ms });
	await restart.k.runKpiSnapshot("nightly");
	await restart.k.kpiMaybeSendPreview(restart.clock.ms);
	await restart.k.kpiMaybeSendDigest(restart.clock.ms);
	t(st === "already_claimed" && restart.log.mails.length === 0, "§8 a restart between claim and send: the claimed slot is never sent again");

	const tuesday = world({ block, now: "2026-10-13T14:00:00Z", before: (db) => {
		db.exec("CREATE TABLE IF NOT EXISTS kpi_digest_sends (slot_key TEXT PRIMARY KEY, status TEXT NOT NULL, recipients_count INTEGER NOT NULL DEFAULT 0, claimed_at TEXT NOT NULL, sent_at TEXT)");
		db.prepare("INSERT INTO kpi_digest_sends (slot_key, status, claimed_at) VALUES ('digest:2026-10-05', 'sent', 'x')").run();
	} });
	await tuesday.k.kpiMaybeSendDigest(tuesday.clock.ms);
	t(tuesday.log.mails.length === 0 && one(tuesday, "SELECT status FROM kpi_digest_sends WHERE slot_key = 'digest:2026-10-12'").status === "missed", "§8 Tuesday, Monday's digest unsent: missed, not sent late");

	const off = world({ block, now: MONDAY_0930, env: { KPI_DIGEST_ENABLED: "false" } });
	off.at("2026-10-12T08:30:00Z");
	await off.k.kpiTick("nightly");
	off.at(MONDAY_0930);
	await off.k.kpiTick("nightly");
	t(off.log.inputs.length === 1 && off.log.mails.length === 0, "§8 KPI_DIGEST_ENABLED off: the snapshot runs, no email at all (not even the preview)");
});
const seedSection = section(async (t, block = BLOCK) => {
	const midday = world({ block, now: "2026-10-12T15:00:00Z", startsJob: () => true });
	t((one(midday, "SELECT status FROM kpi_digest_sends WHERE slot_key = 'digest:2026-10-12'") || {}).status === "seeded", "§8 first start on Monday 11:00: this week's slot seeded");
	midday.at("2026-10-12T15:01:00Z");
	await midday.k.kpiTick("nightly");
	t(midday.log.inputs.length === 1 && midday.log.mails.filter((m) => !m.subject.startsWith("PREVIEW")).length === 0, "§8 ...so the tick runs the snapshot but sends no late Monday digest");
	const early = world({ block, now: "2026-10-12T12:00:00Z", startsJob: () => true });
	t(!one(early, "SELECT 1 AS x FROM kpi_digest_sends WHERE slot_key LIKE 'digest:%'"), "§8 first start on Monday 08:00: nothing seeded");
	early.at("2026-10-12T13:05:00Z");
	await early.k.kpiTick("nightly");
	t(early.log.mails.filter((m) => m.subject.startsWith("LogisX weekly KPIs")).length === 1, "§8 ...and that 09:00 digest goes out");
});

// ─────────────────────────────────────────── §9 the scheduler
const schedulerSection = section(async (t, block = BLOCK) => {
	const gateLine = 'if (KPI_SNAPSHOT_ENABLED && startsJob("KPI snapshot")) {';
	t(block.split(`\n${gateLine}\n`).length === 2, "§9 the scheduler is gated by startsJob(\"KPI snapshot\") (source)");
	const replica = world({ block, startsJob: () => false });
	t(replica.log.timeouts.length === 0 && replica.log.intervals.length === 0 && !replica.log.logs.some((l) => l.startsWith("[kpi] enabled")), "§9 startsJob() says no: no timer, no start-up line");
	const live = world({ block, startsJob: (name) => name === "KPI snapshot" });
	t(live.log.timeouts.length === 1 && live.log.timeouts[0].ms === 10 * 60 * 1000 && live.log.intervals.length === 0, "§9 started: the boot run in 10 minutes, no tick before it");
	t(live.log.logs.includes("[kpi] enabled — snapshot daily at 04:00 America/New_York (03:00 US Central), digest Mondays at 09:00 America/New_York (08:00 US Central)"), "§9 the start-up line");
	live.at("2026-10-09T19:00:00Z");
	live.log.timeouts[0].fn();
	await new Promise((r) => setTimeout(r, 20));
	t(live.log.intervals.length === 1 && live.log.intervals[0].ms === 60000, "§9 after the boot run, the 1-minute tick");
	t(one(live, "SELECT kind, day FROM kpi_runs").kind === "boot" && one(live, "SELECT day FROM kpi_runs").day === "2026-10-09", "§9 the boot run catches up today's missed slot");
	const offSwitch = world({ block, env: { KPI_SNAPSHOT_ENABLED: "off" }, startsJob: () => true });
	t(offSwitch.log.timeouts.length === 0 && offSwitch.log.logs.some((l) => l.startsWith("[kpi] off (KPI_SNAPSHOT_ENABLED)")), "§9 KPI_SNAPSHOT_ENABLED off: nothing scheduled, one line saying so");

	const w = world({ block, now: "2026-10-09T07:59:00Z" });
	await w.k.kpiTick("nightly");
	t(w.log.inputs.length === 0, "§9 03:59 Eastern: no run");
	w.at("2026-10-09T08:00:00Z");
	await w.k.kpiTick("nightly");
	t(w.log.inputs.length === 1 && one(w, "SELECT kind FROM kpi_runs").kind === "nightly", "§9 04:00 Eastern (03:00 Central): the nightly run");
	w.at("2026-10-09T08:01:00Z");
	await w.k.kpiTick("nightly");
	t(w.log.inputs.length === 1, "§9 the next tick that day: no second run");
	w.at("2026-10-10T08:00:30Z");
	await w.k.kpiTick("nightly");
	t(w.log.inputs.length === 2, "§9 the next day at 04:00: the next run");

	const f = world({ block, now: "2026-10-09T08:00:00Z" });
	f.control.sheetThrows = true;
	const runsAt = async (iso) => { f.at(iso); await f.k.kpiTick("nightly"); return one(f, "SELECT COUNT(*) AS n FROM kpi_runs").n; };
	t(await runsAt("2026-10-09T08:00:00Z") === 1, "§9 a run fails");
	t(await runsAt("2026-10-09T08:10:00Z") === 1, "§9 ...no retry within 30 minutes");
	t(await runsAt("2026-10-09T08:31:00Z") === 2 && await runsAt("2026-10-09T09:02:00Z") === 3, "§9 ...then retried every 30 minutes");
	t(await runsAt("2026-10-09T12:00:00Z") === 3, "§9 ...three failures a day at most");

	const s = world({ block });
	const [a, b] = await Promise.all([s.k.runKpiSnapshot("manual"), s.k.runKpiSnapshot("nightly")]);
	t(a && a.status === "ok" && b === null && one(s, "SELECT COUNT(*) AS n FROM kpi_runs").n === 1, "§9 single flight: a second run while one runs does not start");
});

// ─────────────────────────────────────────── §10 aggregates only
const aggregateSection = section(async (t, block = BLOCK) => {
	const w = world({ block, now: "2026-10-12T08:00:00Z", sheet: (() => { const s = baseSheet(); s.data.push(...weightSheet(3).data.map((r, i) => ({ ...r, _rowIndex: 50 + i }))); return s; })(),
		drive: { files: driveFiles } });
	w.settings({ recipients: ["ops@example.test"] });
	await w.k.kpiTick("nightly");
	w.at(MONDAY_0930);
	await w.k.kpiTick("nightly");
	const g = JSON.stringify(w.k.kpiResponse(w.clock.ms));
	t(w.log.mails.length === 2, "§10 the run, the preview and the digest all happened");
	const tables = ["kpi_runs", "kpi_snapshots", "kpi_series", "kpi_digest_sends", "kpi_metric_approvals"].map((x) => JSON.stringify(all(w, `SELECT * FROM ${x}`))).join("\n") +
		JSON.stringify(all(w, "SELECT * FROM server_state WHERE key = 'kpi.derived'"));
	const weights = JSON.stringify(all(w, "SELECT * FROM kpi_load_weights"));
	const mails = w.log.mails.map((m) => `${m.subject}\n${m.html}`).join("\n");
	const logs = w.log.logs.join("\n");
	for (const [what, text] of [["the kpi tables", tables + weights], ["the emails", mails], ["the log", logs], ["the GET answer", g]]) {
		const names = [DRIVER, BROKER, PHOTO, RECEIPT_TEXT, "Order #", ".pdf"].filter((s) => text.toLowerCase().includes(s.toLowerCase()));
		t(names.length === 0, `§10 no name, file name, photo or receipt text in ${what} (${names.join(", ") || "clean"})`);
	}
	for (const [what, text] of [["the snapshots and series", tables], ["the emails", mails], ["the log", logs], ["the GET answer", g]]) {
		const ids = ["l-1001", "L-1002", "512000001", "512000003"].filter((s) => text.toLowerCase().includes(s.toLowerCase()));
		t(ids.length === 0, `§10 no load ID in ${what} (${ids.join(", ") || "clean"})`);
	}
	t(!JSON.stringify(w.log.inputs).includes(PHOTO) && !JSON.stringify(w.log.inputs).includes(RECEIPT_TEXT), "§10 computeKpis() never sees a receipt photo or receipt text");
});

// ─────────────────────────────────────────── runner
let pass = 0;
const failures = [];
function record(results) {
	for (const x of results) { if (x.ok) pass++; else failures.push(x.name); }
	console.log(`  ${results.filter((x) => x.ok).length}/${results.length} checks`);
}
const failed = (results) => results.some((x) => !x.ok);

(async () => {
	const sections = [
		["§1 storage", storageSection], ["§2 gathering", gatherSection], ["§3 the sheet", sheetSection], ["§4 revenue", revenueSection],
		["§5 a nightly run", runSection], ["§6 the weight phase", weightSection], ["§6 the weight cache and sources", weightCacheSection], ["§6b the weight phase's limits", weightLimitsSection], ["§6c an earlier text rule's no_text", textRuleSection],
		["§7 the time box", timeSection], ["§8 emails", emailSection], ["§8 the first-start digest marker", seedSection],
		["§9 the scheduler", schedulerSection], ["§10 aggregates only", aggregateSection],
	];
	for (const [title, fn] of sections) {
		console.log(`\n${title}`);
		record(await fn(BLOCK));
	}

	console.log("\n§11 MUTANTS");
	const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };
	const swapAll = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.split(from).join(to); };
	const mutants = [
		["claim-before-send dropped", emailSection, swap(BLOCK, `if (!claim.changes) return "already_claimed";`, "")],
		["the preview latch set although sendEmail() returned false", emailSection, swap(BLOCK, `const status = finish(sent ? "sent" : "failed", sent ? new Date().toISOString() : null);`, `const status = finish("sent", new Date().toISOString());`)],
		["the preview sent to the page's recipients", emailSection, swap(BLOCK, "const recipients = ADMIN_NOTIFY_EMAIL ? [ADMIN_NOTIFY_EMAIL] : [];\n\treturn kpiClaimAndSend({ slotKey: \"preview\"", "const recipients = kpiReadSettings().recipients;\n\treturn kpiClaimAndSend({ slotKey: \"preview\"")],
		["no first-start digest marker", seedSection, swap(BLOCK, "\t\tkpiSeedDigestMarker(Date.now());\n", "")],
		["a no_text from an earlier text rule never read again", textRuleSection, swap(BLOCK, "\n\t\t\t\t|| (row.status === \"no_text\" && (Number(row.text_rule) || 1) < KPI_TEXT_RULE);", ";")],
		["a 41st Drive load", weightSection, swap(BLOCK, "candidates.slice(0, budget)", "candidates.slice(0, budget + 1)")],
		["the 40 counted per run, not per business day", weightLimitsSection, swap(BLOCK, "KPI_WEIGHT_MAX_PER_RUN - checkedToday", "KPI_WEIGHT_MAX_PER_RUN - 0")],
		["a load not recorded before its rate-con is fetched", weightLimitsSection, swap(BLOCK, "upsert.run(load.loadId, null, \"error\", \"\", null, new Date().toISOString());\n", "")],
		["a Drive download not capped", weightLimitsSection, swap(BLOCK, "{ responseType: \"arraybuffer\", timeout, maxContentLength: kpiWeight.MAX_PDF_BYTES }", "{ responseType: \"arraybuffer\", timeout }")],
		["a stored Drive file downloaded before its size is checked", weightLimitsSection, swap(BLOCK, "if (size > max) return { status: \"too_large\", fileSize: size };\n\tcounter.driveFetches++;", "counter.driveFetches++;")],
		["the PDF text not capped", weightLimitsSection, swap(BLOCK, "extractPdfText(buffer, { maxInflatedBytes: KPI_PDF_TEXT_MAX_BYTES })", "extractPdfText(buffer)")],
		["a short load id looked up by file name", weightLimitsSection, swap(BLOCK, "if (safe.length < rcIndexShared.MIN_LOAD_ID_LEN) return", "if (false) return")],
		["a file name matched inside a longer number", weightLimitsSection, swap(BLOCK, "\n\t\t\t\t&& rcIndexShared.textHasToken(String(f.name || \"\").toLowerCase(), safe.toLowerCase()))", ")")],
		["the not-found cache ignored", weightCacheSection, swap(BLOCK, " && !(nowMs - Date.parse(row.checked_at) < KPI_WEIGHT_RETRY_MS)", "")],
		["the Drive phase's time limit ignored", timeSection, swap(BLOCK, "if (Date.now() >= deadlineMs) {\n\t\t\tout.codes.add(\"RATECON_TIME_LIMIT\");", "if (false) {\n\t\t\tout.codes.add(\"RATECON_TIME_LIMIT\");")],
		["the run's time limit ignored", timeSection, swapAll(BLOCK, `if (Date.now() >= deadlineMs) throw kpiStop("TIME_LIMIT");`, "")],
		["the startsJob gate removed", schedulerSection, swap(BLOCK, 'if (KPI_SNAPSHOT_ENABLED && startsJob("KPI snapshot")) {', "if (KPI_SNAPSHOT_ENABLED) {")],
		["raw error text stored", weightCacheSection, swap(BLOCK, "result = { status: \"error\", weightLb: null, fileId: \"\", fileSize: null };\n\t\t\tout.codes.add(e && e.kpiCode === \"TIME_LIMIT\" ? \"RATECON_TIME_LIMIT\" : \"RATECON_FETCH_FAILED\");",
			"result = { status: \"error\", weightLb: null, fileId: String(e.message), fileSize: null };\n\t\t\tout.codes.add(String(e.message));")],
		["SELECT * on expenses", gatherSection, swap(BLOCK, `"SELECT date, amount, gallons, status FROM expenses WHERE LOWER(type) = 'fuel'"`, `"SELECT * FROM expenses WHERE LOWER(type) = 'fuel'"`)],
	];
	const results = [];
	for (const [name, fn, src] of mutants) results.push({ ok: failed(await fn(src)), name: `MUTANT ${name}: caught` });
	record(results);

	if (failures.length) {
		console.error(`\nFAILURES (${failures.length}):`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n✓ ${pass} assertions passed`);
	process.exit(0);
})().catch((e) => die(e && e.stack ? e.stack : String(e)));
