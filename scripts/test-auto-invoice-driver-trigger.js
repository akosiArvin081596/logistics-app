#!/usr/bin/env node
// The driver's Delivered starts the invoice (AUTO_INVOICE_DRIVER_TRIGGER_ENABLED, a kill
// switch; lib/auto-invoice-job.js, lib/auto-invoice-trigger.js), on made-up loads, with a
// made-up engine, Gmail and SMTP sender on an in-memory database. The route itself runs in
// scripts/test-auto-invoice-wiring.js.
//
//   §1  the flag: on unless it says off, in real-draft mode only; no sweep, tick or work
//   §2  a Driver's Delivered: the record before the sheet write, one run after it: one SMTP
//       call to a listed domain, a Gmail draft for any other broker, Bison's draft
//   §3  nothing else starts one: another role, a repeat tap, a process that may not run
//       jobs, the flag off, and the claims a tap leaves alone
//   §4  a sheet write that reports failure (R-H1): it landed, it didn't, it can't be read
//   §5  the run starts after the answer (R-M1), and a throw after the write can't lose it
//   §6  start-up, one case per place the app can stop: at most one SMTP call across it
//   §7  the FIRST start-up on a made-up copy of production's state: nothing already
//       completed is built, appended or sent (R-M2, the baseline, a send in flight)
//   §8  no claim is left queued or working after a run, for every way a run can end (R-M3)
//   §9  the send rules that stay: one at a time, the caps, the Stop, factoring last, a hand
//       draft, a press in flight
//   §10 Try again looks first (R-H2): a hit, a failed search, the Payments Table; a restart
//       between the press and the run; both branches; a clean look sends once
//   §11 a stuck run (R-M4): past its limit it can't write, send or hold the line
//   §12 the watching: a dashboard read at most once a minute, a POD event at once
//   §13 going back (R-M5): the sweep's first tick after the trigger sends nothing
//   §14 `waiting` is no dead end (R-M2): a person, Try again, or a later tap
//   §15 the "No automatic invoice" chip
//   §16 the rules on their own, and the send's commit reaching the disk
//
// No network, no files, never reads app.db.
//   node scripts/test-auto-invoice-driver-trigger.js      # exits 1 on any failure
"use strict";

const path = require("path");

const ROOT = path.join(__dirname, "..");
// A tree without the module fails by name, not by a stack trace.
const optional = (p) => {
	try {
		return require(p);
	} catch {
		return null;
	}
};
const jobLib = require(path.join(ROOT, "lib", "auto-invoice-job.js"));
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const ledger = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const sendLib = require(path.join(ROOT, "lib", "auto-invoice-send.js"));
const factoring = require(path.join(ROOT, "lib", "factoring-store.js"));
const trigger = optional(path.join(ROOT, "lib", "auto-invoice-trigger.js"));
const { textPdf } = require(path.join(ROOT, "scripts", "lib", "made-up-pdf.js"));
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { console.log(`\n${t}`); }

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-20T14:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const HEADERS = Object.freeze(["Load ID", "Trailer Number", "Driver", "Job Status", "Email", "Status Update Date", "Completion Date", "  Payment  "]);
const BROKER = "ops@example-broker.test";
const OTHER = "ops@example-other.test";
const SEND_DOMAIN = "example-broker.test";
const BILLING = `billing@${SEND_DOMAIN}`;
const MAILBOX = Object.freeze({ user: "drafts@example.com", pass: "made-up" });
const PAYMENTS_HEADERS = Object.freeze([" Job ID", "Contract ID", "Payment Amount", "Invoice Number", "Payment Date", "Payment Status"]);
const DRAFTS = "[Gmail]/Drafts";
const SENT = "[Gmail]/Sent Mail";

const turn = () => new Promise((r) => setImmediate(r));
const never = () => new Promise(() => {});
async function until(cond, label) {
	for (let i = 0; i < 400; i++) {
		if (cond()) return true;
		await turn();
	}
	failures.push(`${label}: the condition was never met`);
	return false;
}
function gate() {
	let open = null;
	const p = new Promise((r) => { open = r; });
	return { p, open };
}

function makeWorld() {
	const w = {
		now: T0,
		rows: [],
		files: new Set(),
		rateCons: new Map(),
		gmail: [], // Message-IDs in Drafts
		sent: [], // Message-IDs in Sent Mail
		smtp: [],
		smtpBehaviors: [],
		appends: [],
		appendBehaviors: [],
		calls: { prepare: 0, render: 0, record: 0, mint: 0, search: 0, searchBoxes: [], look: [], payments: 0, readBack: 0, reads: 0, sleep: [] },
		audits: [],
		notices: [],
		logs: [],
		payments: [[...PAYMENTS_HEADERS]],
		lookAnswer: { verdict: "clean", mailboxes: {} },
		mailbox: MAILBOX,
		closed: () => [],
		ids: 0,
		invalidated: 0,
	};
	w.db = new Database(":memory:");
	w.db.exec(`
		CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, driver TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
			file_name TEXT NOT NULL, drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_at DATETIME DEFAULT NULL);
		CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, recipient_source TEXT,
			total TEXT, broker_name TEXT, order_number TEXT, via TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), created_by TEXT,
			edited INTEGER DEFAULT 0, edited_fields TEXT DEFAULT '');
		CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME, deleted_by TEXT DEFAULT '');
		CREATE TABLE broker_invoice_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, load_key TEXT NOT NULL, voided_at TEXT);
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
		CREATE TABLE bison_invoice_seq (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
	`);
	w.db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?)").run(JSON.stringify({ optOutDomains: [], confirmedBrokerDomains: [SEND_DOMAIN, "example-other.test"] }));

	w.row = (id) => w.rows.find((r) => rules.loadKey(r["Load ID"]) === rules.loadKey(id)) || null;
	w.setRow = (id, over = {}) => {
		const was = w.row(id);
		const row = Object.freeze({ ...(was || { "Load ID": id, "Trailer Number": "TR-1", Driver: "Made-up Driver", "Job Status": "At Receiver", Email: BROKER,
			"Status Update Date": "10/20/2026 9:00:00", "Completion Date": "10/20/2026 9:00:00", "  Payment  ": "$1,000.00" }), ...over });
		const i = w.rows.indexOf(was);
		if (i >= 0) w.rows[i] = row; else w.rows.push(row);
	};
	w.addPod = (id, { file = true, at = "2026-10-20 13:00:00" } = {}) => {
		const name = `pod-${rules.loadKey(id)}-${w.db.prepare("SELECT COUNT(*) n FROM documents").get().n}.pdf`;
		const r = w.db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'POD', ?, ?, ?)").run(id, name, `/uploads/${name}`, at);
		if (file) w.files.add(name);
		return r.lastInsertRowid;
	};
	// A load ready to be delivered: its POD on file, a rate con naming a billing email on
	// the broker's own domain, and still At Receiver on the sheet.
	w.ready = (id, over = {}, docEmail = BILLING) => {
		w.setRow(id, over);
		w.addPod(id);
		w.rateCons.set(rules.loadKey(id), docEmail);
	};
	w.handDraft = (id, invoiceId = "10202026-50") => w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', 'imap', 'made-up-admin')").run(id, invoiceId, BILLING);
	w.engine = {
		async prepare({ loadId }) {
			w.calls.prepare++;
			if (w.prepareHook) {
				const r = await w.prepareHook(loadId);
				if (r) return r;
			}
			const key = rules.loadKey(loadId);
			const row = w.row(key);
			if (!row) return { ok: false, http: 404, code: "LOAD_NOT_FOUND" };
			if (!w.rateCons.has(key)) return { ok: false, http: 422, code: "RATECON_MISSING" };
			const rule = rules.recipientRule({ brokerEmail: row.Email, bisonRecipient: "ap@example-bison-ap.test", documentsEmail: w.rateCons.get(key), confirmedDomains: ledger.readSettings(w.db).confirmedBrokerDomains });
			if (!rule.ok) return { ok: false, http: 422, code: rule.code };
			return { ok: true, ctx: { loadId: row["Load ID"], to: rule.to } };
		},
		async render(ctx, opts) {
			w.calls.render++;
			if (w.renderHook) await w.renderHook(ctx);
			const ref = String(ctx.loadId).replace(/^#/, "");
			const [y, m, d] = String(opts.invoiceDate).split("-");
			const printed = `INVOICE Invoice ID # : ${opts.invoiceId} Date: ${m}/${d}/${y} Made-up Co. Load ID# ${ref} Total $1,000.00`;
			return {
				to: ctx.to,
				subject: `Example Broker Order #${ref}`,
				html: `<p>Please see the attached documents for load number ${ref}.</p>`,
				attachments: [
					{ filename: `Example Broker Invoice Order #${ref}.pdf`, content: textPdf(printed), contentType: "application/pdf" },
					{ filename: `${ref}_POD.pdf`, content: Buffer.from(`%PDF-1.4 made-up POD for ${ref}`), contentType: "application/pdf" },
					{ filename: `${ref}.pdf`, content: Buffer.from(`%PDF-1.4 made-up rate con for ${ref}`), contentType: "application/pdf" },
				],
				total: "$1,000.00",
			};
		},
		async record(ctx, rendered, opts) {
			w.calls.record++;
			if (w.recordHook) await w.recordHook();
			const r = w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', ?, ?)")
				.run(ctx.loadId, opts.invoiceId, rendered.to, opts.via, opts.actor.username);
			return { recorded: true, draftRowId: r.lastInsertRowid };
		},
	};
	w.deps = (extra = {}) => ({
		db: w.db,
		env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false" },
		now: () => new Date(w.now),
		readJobTracking: async () => {
			w.calls.reads++;
			if (w.readFails) throw new Error("made-up Sheets outage");
			return Object.freeze({ headers: HEADERS, data: Object.freeze([...w.rows]) });
		},
		closedMonthsOf: (headers, row) => w.closed(row),
		dayKeyOf: (cell) => {
			const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(cell || ""));
			return m ? `${m[3]}-${m[1]}-${m[2]}` : "";
		},
		uploadsRoot: path.join(path.sep, "made-up", "uploads"),
		fileExists: (p) => w.files.has(path.basename(p)),
		engine: w.engine,
		nextInvoiceNumber: () => {
			w.calls.mint++;
			return `10202026-${w.calls.mint}`;
		},
		async appendGmailDraft(o) {
			w.appends.push({ to: o.to, messageId: o.messageId });
			const b = w.appendBehaviors.shift() || "OK";
			if (b === "OK") { w.gmail.push(o.messageId); return { ok: true }; }
			if (b === "LOGIN") throw Object.assign(new Error("IMAP LOGIN failed"), { stage: "login", answered: true });
			if (b === "LOST") throw Object.assign(new Error("IMAP timeout"), { stage: "literal", answered: false });
			if (b === "LANDED_LOST") { w.gmail.push(o.messageId); throw Object.assign(new Error("IMAP timeout"), { stage: "literal", answered: false }); }
			throw new Error(`unknown append behaviour ${b}`);
		},
		async findDraftByMessageId({ messageId, mailboxes }) {
			const boxes = mailboxes || [DRAFTS, SENT];
			w.calls.search++;
			w.calls.searchBoxes.push([...boxes]);
			if (w.searchFails) throw new Error("made-up search failure");
			const held = (box) => (box === DRAFTS ? w.gmail : w.sent).filter((id) => id === messageId).length;
			const hit = boxes.find((b) => held(b) > 0);
			return { found: Boolean(hit), count: hit ? held(hit) : 0, mailbox: hit || "" };
		},
		newMessageId: () => `<made-up-${++w.ids}.auto-invoice@example.com>`,
		mailbox: () => w.mailbox,
		bisonRecipient: () => "ap@example-bison-ap.test",
		logAudit: (req, action, entity, id, details) => w.audits.push({ who: req.session.user.username, action, id, details }),
		notify: (n) => w.notices.push(n),
		geminiUnavailableAt: () => w.geminiDownAt || null,
		log: { warn: (m) => w.logs.push(m), error: (m) => w.logs.push(m) },
		timeZone: "America/New_York",
		workerId: "worker-1",
		send: { enabled: true, domains: [SEND_DOMAIN], settleMinutes: 0 },
		async sendMail(o) {
			const b = w.smtpBehaviors.shift() || "OK";
			w.smtp.push({ to: o.to, subject: o.subject, messageId: o.messageId, attachments: o.attachments.map((a) => a.filename) });
			if (w.smtpHook) await w.smtpHook();
			if (b === "OK") { w.sent.push(o.messageId); return { ok: true }; }
			if (b === "REFUSED") throw Object.assign(new Error("made-up refusal"), { code: "EENVELOPE", outcome: "refused" });
			if (b === "LOST") throw Object.assign(new Error("made-up lost answer"), { code: "CONN", outcome: "unknown" });
			if (b === "LANDED_LOST") { w.sent.push(o.messageId); throw Object.assign(new Error("made-up lost answer"), { code: "CONN", outcome: "unknown" }); }
			throw new Error(`unknown SMTP behaviour ${b}`);
		},
		invalidateJobTracking: () => { w.invalidated++; },
		readPaymentsTable: async () => {
			w.calls.payments++;
			if (w.paymentsFail) throw new Error("made-up Sheets failure");
			return w.payments;
		},
		lookInMailbox: async (o) => {
			w.calls.look.push(o);
			if (w.lookHook) await w.lookHook();
			if (w.lookFails) throw new Error("made-up IMAP failure");
			return w.lookAnswer;
		},
		sleep: async (ms) => { w.calls.sleep.push(ms); },
		...extra,
	});
	w.job = (extra = {}) => jobLib.create(w.deps(extra));
	w.claim = (id) => w.db.prepare("SELECT * FROM auto_invoice_claims WHERE load_key = ?").get(rules.loadKey(id)) || null;
	w.state = (id) => {
		const c = w.claim(id);
		return c ? [c.state, c.reason_code] : null;
	};
	w.open = () => w.db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims WHERE state IN ('queued', 'working')").get().n;
	w.draftRows = (id) => w.db.prepare("SELECT invoice_id, via FROM load_invoice_drafts WHERE LOWER(TRIM(load_id)) IN (?, ?) ORDER BY id").all(rules.loadKey(id), `#${rules.loadKey(id)}`);
	w.actions = (action) => w.audits.filter((a) => a.action === action);
	// A claim as a run or the sweep left it.
	w.seed = (id, fields) => {
		ledger.ensureSchema(w.db);
		ledger.insertClaim(w.db, { key: rules.loadKey(id), loadId: id, state: fields.state, code: fields.reason_code || "", nowIso: iso(w.now - MIN) });
		const { state: _s, ...rest } = fields;
		const cols = Object.keys(rest);
		if (cols.length) w.db.prepare(`UPDATE auto_invoice_claims SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE load_key = ?`).run(...cols.map((c) => rest[c]), rules.loadKey(id));
	};
	w.meta = (key, value) => {
		ledger.ensureSchema(w.db);
		ledger.setMeta(w.db, key, value);
	};
	// A process on a database already past its first start-up.
	w.started = async (extra = {}) => {
		w.meta("baseline_at", iso(T0 - 24 * HOUR));
		w.meta("trigger_on_at", iso(T0 - HOUR));
		const job = w.job(extra);
		job.startTrigger();
		await job.finishStartUp();
		return job;
	};
	return w;
}

// What PUT /api/driver/status does around its sheet write (the route's own lines run in the
// wiring runner). `landed`: a write that failed still reached the sheet.
function tap(w, job, id, { role = "Driver", fails = false, landed = false, readBack = null, oldStatus = null } = {}) {
	const row = w.row(id);
	const before = oldStatus !== null ? oldStatus : row ? row["Job Status"] : "";
	const start = job.driverDelivered({
		role, loadId: id, oldStatus: before, newStatus: "Delivered",
		readBack: readBack || (async () => {
			w.calls.readBack++;
			const r = w.row(id);
			return r ? r["Job Status"] : "";
		}),
	});
	const atWrite = w.claim(id);
	if (fails) {
		if (landed) w.setRow(id, { "Job Status": "Delivered" });
		let thrown = null;
		try {
			start.writeFailed(new Error("made-up: no answer in 15 seconds"));
		} catch (e) {
			thrown = e;
		}
		return { atWrite, thrown };
	}
	w.setRow(id, { "Job Status": "Delivered" });
	start.written();
	return { atWrite };
}
const drained = (w, label) => until(() => w.open() === 0, `${label}: every claim settled`);
function markFactored(w, id) {
	factoring.ensureSchema(w.db);
	w.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES (?, ?, 1, 'person', ?, ?)").run(rules.loadKey(id), id, iso(w.now), iso(w.now));
}

// A tiny Express stand-in: the guard and handler chain of each route.
function fakeApp() {
	const routes = {};
	const add = (method) => (p, ...handlers) => { routes[`${method} ${p}`] = handlers; };
	const app = { get: add("GET"), put: add("PUT"), post: add("POST"), delete: add("DELETE") };
	const requireRole = () => (req, res, next) => next();
	const call = async (method, p, { params = {}, body = {} } = {}) => {
		const handlers = routes[`${method} ${p}`];
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		const req = { params, body, session: { user: { id: 7, username: "made-up-admin", role: "Super Admin" } } };
		for (const h of handlers) {
			let next = false;
			await h(req, res, () => { next = true; });
			if (!next) break;
		}
		return out;
	};
	return { app, requireRole, call };
}
function tryAgain(job, id) {
	const f = fakeApp();
	job.mount(f.app, { requireRole: f.requireRole });
	return f.call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: id } });
}
const served = (job, ids, over = {}) => {
	const rows = ids.map((id) => ({ "Load ID": id, "Job Status": "Delivered", Email: BROKER, "Completion Date": "10/20/2026 9:00:00", ...over }));
	job.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: true });
	return rows.map((r) => r._autoInvoice || null);
};

async function main() {
	section("§1  the flag");
	ok(trigger, "§1 FAILS ON THE OLD CODE: lib/auto-invoice-trigger.js exists");
	if (!trigger) return;
	for (const [v, want] of [[undefined, true], ["", true], ["true", true], ["1", true], ["anything", true], ["false", false], ["FALSE", false], [" false ", false], ["0", false], ["no", false], ["off", false], ["Off", false]]) {
		eq(trigger.enabled({ AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: v }), want, `§1 AUTO_INVOICE_DRIVER_TRIGGER_ENABLED=${JSON.stringify(v)}: ${want ? "on" : "off"} (a kill switch: only an explicit off)`);
	}
	{
		const w = makeWorld();
		eq(w.job().triggerMode, true, "§1 FAILS ON THE OLD CODE: real drafts, the setting unnamed: on");
		eq(w.job({ env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "off" } }).triggerMode, false, "§1 ...an explicit off: the sweep");
		eq(w.job({ env: { AUTO_INVOICE_DRAFTS_ENABLED: "true" } }).triggerMode, false, "§1 ...shadow mode: nothing to start");
		eq(w.job({ env: {} }).triggerMode, false, "§1 ...the job off: nothing");
		const job = w.job();
		w.ready("LD-TEST-0001");
		w.setRow("LD-TEST-0001", { "Job Status": "Delivered" });
		const before = JSON.stringify(w.calls);
		eq([await job.tick(), await job.sweep(), await job.work(), await job.recover()],
			[{ mode: "on", trigger: true }, { mode: "on", trigger: true }, { mode: "on", started: 0, trigger: true }, { mode: "on", recovered: 0, trigger: true }],
			"§1 no tick, sweep, work or recovery on the invoice path, even if something called them");
		eq([JSON.stringify(w.calls) === before, w.claim("LD-TEST-0001")], [true, null], "§1 ...and nothing was read or claimed");
	}

	section("§2  a Driver's Delivered");
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0101");
		const { atWrite } = tap(w, job, "LD-TEST-0101");
		eq([atWrite.state, atWrite.reason_code], ["waiting", "DRIVER_PENDING"], "§2 FAILS ON THE OLD CODE: the record is there before the sheet write, and no worker can take it yet");
		eq(w.smtp.length, 0, "§2 ...nothing leaves in the route's own turn, so the phone gets its answer first");
		await drained(w, "§2");
		const c = w.claim("LD-TEST-0101");
		eq([c.state, c.reason_code, c.stage, c.delivery], ["drafted", "", "recorded", "send"], "§2 FAILS ON THE OLD CODE: the run finishes with no tick: sent");
		eq(w.smtp.map((m) => [m.to, m.attachments]), [[BILLING, ["Example Broker Invoice Order #LD-TEST-0101.pdf", "LD-TEST-0101_POD.pdf", "LD-TEST-0101.pdf"]]], "§2 FAILS ON THE OLD CODE: one SMTP call: the invoice, the POD and the rate con");
		eq([w.appends.length, w.draftRows("LD-TEST-0101").map((r) => r.via), w.actions("auto_invoice_sent").length], [0, ["auto-smtp"], 1], "§2 no Gmail draft; one row, one audit row");
		await job.runLine();
		tap(w, job, "LD-TEST-0101", { oldStatus: "Delivered" });
		await drained(w, "§2 again");
		eq(w.smtp.length, 1, "§2 a repeat tap on the load sent sends nothing");

		w.ready("LD-TEST-0102", { Email: OTHER }, "billing@example-other.test");
		tap(w, job, "LD-TEST-0102");
		await drained(w, "§2 other");
		eq([w.state("LD-TEST-0102"), w.smtp.length, w.appends.map((a) => a.to)], [["drafted", ""], 1, ["billing@example-other.test"]], "§2 FAILS ON THE OLD CODE: any other broker: a Gmail draft, as today, no SMTP");

		w.ready("LD-TEST-0103", { Email: "ops-test@bisontransport.com" });
		tap(w, job, "LD-TEST-0103");
		await drained(w, "§2 Bison");
		eq([w.state("LD-TEST-0103"), w.smtp.length, w.appends.length], [["drafted", ""], 1, 2], "§2 FAILS ON THE OLD CODE: Bison keeps its automatic draft");
		ok(w.calls.reads > 0 && w.logs.every((l) => !l.includes("@")), "§2 no email address in the logs");

		// A double tap, or a retried request while the first is still writing: one record, one run.
		const twice = makeWorld();
		const tj = await twice.started();
		twice.ready("LD-TEST-0104");
		const first = tj.driverDelivered({ role: "Driver", loadId: "LD-TEST-0104", oldStatus: "At Receiver", newStatus: "Delivered" });
		const second = tj.driverDelivered({ role: "Driver", loadId: "#ld-test-0104", oldStatus: "At Receiver", newStatus: "Delivered" });
		twice.setRow("LD-TEST-0104", { "Job Status": "Delivered" });
		first.written();
		second.written();
		await drained(twice, "§2 double tap");
		eq([twice.state("LD-TEST-0104"), twice.smtp.length, twice.calls.mint, twice.db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims").get().n], [["drafted", ""], 1, 1, 1], "§2 FAILS ON THE OLD CODE: a double tap, either spelling of the ID: one record, one SMTP call");
	}

	section("§3  nothing else starts one");
	{
		const w = makeWorld();
		const job = await w.started();
		for (const [role, id] of [["Dispatcher", "LD-TEST-0201"], ["Super Admin", "LD-TEST-0202"], ["", "LD-TEST-0203"]]) {
			w.ready(id);
			const { atWrite } = tap(w, job, id, { role });
			eq(atWrite, null, `§3 ${role || "no role"} on the same route: no record`);
		}
		w.ready("LD-TEST-0204");
		w.setRow("LD-TEST-0204", { "Job Status": "Delivered" });
		const repeat = tap(w, job, "LD-TEST-0204", { oldStatus: "Delivered" });
		eq(repeat.atWrite, null, "§3 a retried request on a load already Delivered with no record: no record");
		const notCompleted = job.driverDelivered({ role: "Driver", loadId: "LD-TEST-0205", oldStatus: "At Shipper", newStatus: "In Transit" });
		notCompleted.written();
		eq(w.claim("LD-TEST-0205"), null, "§3 a Driver's other statuses: no record");
		await turn();
		await job.runLine();
		eq([w.smtp.length, w.appends.length, w.calls.prepare, w.calls.mint], [0, 0, 0, 0], "§3 no send, no draft, no engine, no number");

		// A process that may not run jobs: a replica or an import never starts the trigger.
		const notStarted = makeWorld();
		const inert = notStarted.job();
		notStarted.ready("LD-TEST-0206");
		const start = inert.driverDelivered({ role: "Driver", loadId: "LD-TEST-0206", oldStatus: "At Receiver", newStatus: "Delivered" });
		start.written();
		await turn();
		await inert.finishStartUp();
		eq([notStarted.claim("LD-TEST-0206"), notStarted.smtp.length, notStarted.calls.prepare], [null, 0, 0], "§3 startsJob() said no (a replica, an import): no record, no run");
		let threw = null;
		try { start.writeFailed(new Error("made-up")); } catch (e) { threw = e; }
		eq(threw && threw.message, "made-up", "§3 ...and a failed write still reaches the route as it was");

		// The flag off: the route's call does nothing.
		const off = makeWorld();
		const offJob = off.job({ env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" } });
		eq(offJob.startTrigger(), false, "§3 the flag off: the trigger doesn't start");
		off.ready("LD-TEST-0207");
		offJob.driverDelivered({ role: "Driver", loadId: "LD-TEST-0207", oldStatus: "At Receiver", newStatus: "Delivered" }).written();
		eq(off.claim("LD-TEST-0207"), null, "§3 ...and a driver's tap makes no record: the sweep finds it, as today");

		// The claims a tap leaves alone.
		for (const state of ["baseline", "queued", "drafted", "needs_attention", "skipped"]) {
			const x = makeWorld();
			const j = await x.started();
			x.ready("LD-TEST-0210");
			x.seed("LD-TEST-0210", { state, reason_code: state === "needs_attention" ? "TOTAL_MISMATCH" : "", next_attempt_at: iso(x.now + HOUR) });
			tap(x, j, "LD-TEST-0210");
			await turn();
			await turn();
			eq([x.claim("LD-TEST-0210").state, x.smtp.length], [state, 0], `§3 a ${state} claim: left alone`);
		}
	}

	section("§4  a sheet write that reports failure (R-H1)");
	{
		// It landed: the answer was lost, and the row reads Delivered.
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0301");
		const r = tap(w, job, "LD-TEST-0301", { fails: true, landed: true });
		eq(r.thrown && r.thrown.message, "made-up: no answer in 15 seconds", "§4 the route answers as it always did");
		eq(w.state("LD-TEST-0301"), ["waiting", "DRIVER_PENDING"], "§4 ...and the record stays until the row is read back");
		await drained(w, "§4 landed");
		await until(() => w.smtp.length > 0, "§4 landed: the send");
		await drained(w, "§4 landed");
		eq([w.calls.readBack, w.invalidated, w.state("LD-TEST-0301"), w.smtp.length], [1, 1, ["drafted", ""], 1],
			"§4 FAILS ON THE OLD DESIGN: a write that reports failure but landed isn't lost: read back once, the cache dropped, one SMTP call");

		// It didn't land: no send, and a later tap arms the record.
		const x = makeWorld();
		const j = await x.started();
		x.ready("LD-TEST-0302");
		tap(x, j, "LD-TEST-0302", { fails: true });
		await until(() => x.calls.readBack === 1 && x.claim("LD-TEST-0302").reason_code === "NOT_COMPLETED", "§4 not landed: read back");
		eq([x.state("LD-TEST-0302"), x.smtp.length], [["waiting", "NOT_COMPLETED"], 0], "§4 reads anything but Delivered: no send, the record says so");
		tap(x, j, "LD-TEST-0302");
		await drained(x, "§4 later tap");
		eq([x.state("LD-TEST-0302"), x.smtp.length], [["drafted", ""], 1], "§4 ...and a later tap arms it: one SMTP call");

		// It can't be read: the row may read Delivered by the driver's next tap.
		const y = makeWorld();
		const k = await y.started();
		y.ready("LD-TEST-0303");
		tap(y, k, "LD-TEST-0303", { fails: true, landed: true, readBack: async () => { y.calls.readBack++; return null; } });
		await until(() => y.calls.readBack === 1, "§4 unreadable: read back");
		await turn();
		eq([y.state("LD-TEST-0303"), y.smtp.length], [["waiting", "DRIVER_PENDING"], 0], "§4 the read back fails: the record stays, for a later tap or the next start-up");
		const chips = served(k, ["LD-TEST-0303"]);
		eq(chips[0] && [chips[0].state, chips[0].code], ["needs_attention", "NOT_BY_DRIVER"], "§4 FAILS ON THE OLD DESIGN: ...and the row isn't silent meanwhile: the chip, counted by the toggle");
		eq((await tryAgain(k, "LD-TEST-0303")).status, 409, "§4 ...Try again has nothing to retry yet");
		tap(y, k, "LD-TEST-0303", { oldStatus: "Delivered" });
		await drained(y, "§4 second tap");
		eq([y.state("LD-TEST-0303"), y.smtp.length], [["drafted", ""], 1], "§4 FAILS ON THE OLD DESIGN: the driver's next tap arms it though the row already reads Delivered: one SMTP call");

		// Nobody taps again: the next start-up finishes it.
		const z = makeWorld();
		const m = await z.started();
		z.ready("LD-TEST-0304");
		tap(z, m, "LD-TEST-0304", { fails: true, landed: true, readBack: async () => null });
		await turn();
		await turn();
		const next = z.job({ workerId: "worker-2" });
		next.startTrigger();
		await next.finishStartUp();
		await drained(z, "§4 start-up");
		eq([z.state("LD-TEST-0304"), z.smtp.length], [["drafted", ""], 1], "§4 ...or the next start-up does: one SMTP call");

		// A record that can't be written never blocks the driver.
		const bad = makeWorld();
		const b = await bad.started();
		bad.ready("LD-TEST-0305");
		const realPrepare = bad.db.prepare.bind(bad.db);
		bad.db.prepare = (sql) => { if (/INSERT OR IGNORE INTO auto_invoice_claims/.test(sql)) throw Object.assign(new Error("made-up"), { code: "SQLITE_BUSY" }); return realPrepare(sql); };
		const noRecord = tap(bad, b, "LD-TEST-0305");
		bad.db.prepare = realPrepare;
		eq([noRecord.atWrite, bad.logs.some((l) => /wasn't recorded: SQLITE_BUSY/.test(l))], [null, true], "§4 a record that can't be written: logged by its code, and the driver's write goes on");
		const shown = served(b, ["LD-TEST-0305"]);
		eq(shown[0] && shown[0].code, "NOT_BY_DRIVER", "§4 ...and the load shows as not started");
	}

	section("§5  the run starts after the answer (R-M1)");
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0401");
		tap(w, job, "LD-TEST-0401");
		eq([w.state("LD-TEST-0401"), w.calls.prepare], [["queued", ""], 0], "§5 FAILS ON THE OLD DESIGN: written() moves the claim in the route's own turn and starts nothing there");
		// A throw in the route's lines after written(): the run was already on its way.
		await drained(w, "§5");
		eq(w.smtp.length, 1, "§5 FAILS ON THE OLD DESIGN: whatever throws after that (a notification insert) can't lose the run: one SMTP call");
		const nope = makeWorld();
		const n = await nope.started();
		nope.ready("LD-TEST-0402");
		const start = n.driverDelivered({ role: "Driver", loadId: "LD-TEST-0402", oldStatus: "At Receiver", newStatus: "Delivered" });
		const realPrepare = nope.db.prepare.bind(nope.db);
		nope.db.prepare = (sql) => {
			if (/^UPDATE auto_invoice_claims/.test(sql)) throw Object.assign(new Error("made-up"), { code: "SQLITE_BUSY" });
			return realPrepare(sql);
		};
		let threw = false;
		try { start.written(); } catch { threw = true; }
		nope.db.prepare = realPrepare;
		await turn();
		ok(!threw, "§5 a database error moving the record never throws into the route");
		eq([nope.state("LD-TEST-0402"), nope.logs.some((l) => /the run wasn't queued: SQLITE_BUSY/.test(l))], [["waiting", "DRIVER_PENDING"], true], "§5 ...the record stays for a later tap or the next start-up, and the log says why");
	}

	section("§6  start-up, by where the app stopped (a later start, not the first)");
	{
		const ready = (w, id) => {
			w.ready(id);
			w.setRow(id, { "Job Status": "Delivered" });
		};
		const restart = async (w, extra = {}) => {
			const j = w.job({ workerId: "worker-2", ...extra });
			j.startTrigger();
			await j.finishStartUp();
			await drained(w, "§6 restart");
			return j;
		};
		const on = (w) => {
			w.meta("baseline_at", iso(T0 - 24 * HOUR));
			w.meta("trigger_on_at", iso(T0 - HOUR));
		};
		const fresh = () => iso(T0 - MIN);
		{
			const w = makeWorld();
			on(w);
			ready(w, "LD-TEST-0501");
			w.seed("LD-TEST-0501", { state: "waiting", reason_code: "DRIVER_PENDING", updated_at: fresh() });
			await restart(w);
			eq([w.state("LD-TEST-0501"), w.smtp.length], [["drafted", ""], 1], "§6 after the record, the write landed: run once");
			const n = makeWorld();
			on(n);
			n.ready("LD-TEST-0502");
			n.seed("LD-TEST-0502", { state: "waiting", reason_code: "DRIVER_PENDING", updated_at: fresh() });
			await restart(n);
			eq([n.state("LD-TEST-0502"), n.smtp.length], [["waiting", "NOT_COMPLETED"], 0], "§6 after the record, the write never landed: freeVerdict ends it as NOT_COMPLETED, nothing sent");
		}
		{
			const w = makeWorld();
			on(w);
			ready(w, "LD-TEST-0503");
			w.seed("LD-TEST-0503", { state: "queued", next_attempt_at: iso(w.now + HOUR), updated_at: fresh() });
			await restart(w);
			eq([w.state("LD-TEST-0503"), w.smtp.length], [["drafted", ""], 1], "§6 queued, nothing started: run once, whatever its time says");
		}
		for (const [label, fields] of [
			["building, no number", { stage: "" }],
			["building, a number", { stage: "reserved", invoice_id: "10202026-77", invoice_date: "2026-10-20", reserved_at: iso(T0 - MIN), message_id: "<made-up-77@example.com>" }],
			["rendered", { stage: "rendered", invoice_id: "10202026-77", invoice_date: "2026-10-20", reserved_at: iso(T0 - MIN), message_id: "<made-up-77@example.com>" }],
		]) {
			const w = makeWorld();
			on(w);
			ready(w, "LD-TEST-0504");
			// A lease not yet run out: this process is the only worker, so it's taken over.
			w.seed("LD-TEST-0504", { state: "working", lease_owner: "old-process", lease_until: iso(w.now + 10 * MIN), updated_at: fresh(), ...fields });
			await restart(w);
			eq([w.state("LD-TEST-0504"), w.smtp.length], [["drafted", ""], 1], `§6 ${label}: taken over with its lease running, built and sent once`);
			if (fields.invoice_id) eq(w.claim("LD-TEST-0504").invoice_id, fields.invoice_id, `§6 ${label}: the same number`);
			if (fields.message_id) eq(w.calls.searchBoxes[0], [SENT], `§6 ${label}: Sent Mail is looked in first`);
		}
		{
			// The box lost its power after the send's commit: the claim reads as never sent, and Sent Mail holds it.
			const w = makeWorld();
			on(w);
			ready(w, "LD-TEST-0505");
			w.sent.push("<made-up-78@example.com>");
			w.seed("LD-TEST-0505", { state: "working", stage: "rendered", invoice_id: "10202026-78", invoice_date: "2026-10-20", reserved_at: iso(T0 - MIN), message_id: "<made-up-78@example.com>", updated_at: fresh(), lease_owner: "old-process", lease_until: iso(w.now + 10 * MIN) });
			await restart(w);
			const c = w.claim("LD-TEST-0505");
			eq([c.delivery, w.smtp.length, w.calls.mint], ["send", 0, 0], "§6 the look finds the message: it's recorded as sent, never built again");
			ok(["drafted", "needs_attention"].includes(c.state) && (c.state === "drafted" || c.reason_code === "IN_GMAIL_UNRECORDED"), "§6 ...drafted, or for a person if it can't be recorded");
			const f = makeWorld();
			on(f);
			ready(f, "LD-TEST-0506");
			f.searchFails = true;
			f.seed("LD-TEST-0506", { state: "working", stage: "rendered", invoice_id: "10202026-79", invoice_date: "2026-10-20", reserved_at: iso(T0 - MIN), message_id: "<made-up-79@example.com>", updated_at: fresh() });
			await restart(f);
			eq([f.state("LD-TEST-0506"), f.smtp.length], [["needs_attention", "MAILBOX_UNREAD"], 0], "§6 the look fails: a person, nothing sent");
		}
		{
			// beginSend() committed, SMTP's answer unknown.
			const w = makeWorld();
			on(w);
			ready(w, "LD-TEST-0507");
			w.seed("LD-TEST-0507", { state: "working", stage: "appending", delivery: "send", invoice_id: "10202026-80", invoice_date: "2026-10-20", message_id: "<made-up-80@example.com>", sent_json: JSON.stringify({ to: BILLING, subject: "s", total: "t" }), updated_at: iso(T0 - 2 * HOUR), lease_owner: "old-process", lease_until: iso(w.now + 10 * MIN) });
			await restart(w);
			eq([w.state("LD-TEST-0507"), w.smtp.length, w.calls.searchBoxes, Boolean(ledger.getSendStop(w.db))], [["needs_attention", "MAYBE_SENT"], 0, [[SENT]], true], "§6 a send that started, not found: searched only, MAYBE_SENT and the stop, never sent again");
			const f = makeWorld();
			on(f);
			ready(f, "LD-TEST-0508");
			f.sent.push("<made-up-81@example.com>");
			f.seed("LD-TEST-0508", { state: "working", stage: "appending", delivery: "send", invoice_id: "10202026-81", invoice_date: "2026-10-20", message_id: "<made-up-81@example.com>", sent_json: JSON.stringify({ to: BILLING, subject: "Example Broker Order #LD-TEST-0508", total: "$1,000.00" }), updated_at: fresh() });
			await restart(f);
			eq([f.state("LD-TEST-0508"), f.claim("LD-TEST-0508").delivery, f.smtp.length, Boolean(ledger.getSendStop(f.db))], [["drafted", ""], "send", 0, false], "§6 ...found: recorded, one send in all");
		}
		{
			// SMTP answered, not recorded.
			const w = makeWorld();
			on(w);
			ready(w, "LD-TEST-0509");
			w.seed("LD-TEST-0509", { state: "working", stage: "appended", delivery: "send", invoice_id: "10202026-82", invoice_date: "2026-10-20", message_id: "<made-up-82@example.com>", sent_json: JSON.stringify({ to: BILLING, subject: "Example Broker Order #LD-TEST-0509", total: "$1,000.00" }), updated_at: fresh() });
			await restart(w);
			eq([w.state("LD-TEST-0509"), w.claim("LD-TEST-0509").stage, w.smtp.length, w.calls.mint], [["drafted", ""], "recorded", 0, 0], "§6 SMTP answered, not recorded: recorded, nothing sent");
		}
		{
			// A Gmail draft in flight.
			const held = { state: "working", stage: "appending", delivery: "", invoice_id: "10202026-83", invoice_date: "2026-10-20", reserved_at: iso(T0 - MIN), message_id: "<made-up-83@example.com>", sent_json: JSON.stringify({ to: "billing@example-other.test", subject: "Example Broker Order #LD-TEST-0510", total: "$1,000.00" }), updated_at: fresh() };
			const w = makeWorld();
			on(w);
			w.ready("LD-TEST-0510", { Email: OTHER, "Job Status": "Delivered" }, "billing@example-other.test");
			w.gmail.push("<made-up-83@example.com>");
			w.seed("LD-TEST-0510", held);
			await restart(w);
			eq([w.state("LD-TEST-0510"), w.appends.length], [["drafted", ""], 0], "§6 a draft in flight, found: recorded, not appended again");
			const a = makeWorld();
			on(a);
			a.ready("LD-TEST-0510", { Email: OTHER, "Job Status": "Delivered" }, "billing@example-other.test");
			a.seed("LD-TEST-0510", held);
			await restart(a);
			eq([a.state("LD-TEST-0510"), a.appends.length, a.smtp.length], [["drafted", ""], 1, 0], "§6 ...absent: appended once, with its own number");
			const u = makeWorld();
			on(u);
			u.ready("LD-TEST-0510", { Email: OTHER, "Job Status": "Delivered" }, "billing@example-other.test");
			u.searchFails = true;
			u.seed("LD-TEST-0510", held);
			await restart(u);
			eq([u.state("LD-TEST-0510"), u.appends.length], [["needs_attention", "MAYBE_IN_GMAIL"], 0], "§6 ...the search fails: MAYBE_IN_GMAIL, not appended");
		}
		{
			// Past the hand-off, however the claim got back in line: recorded, never built.
			const sentJson = (id) => JSON.stringify({ to: BILLING, subject: `Example Broker Order #${id}`, total: "$1,000.00" });
			const q = makeWorld();
			on(q);
			ready(q, "LD-TEST-0517");
			q.seed("LD-TEST-0517", { state: "queued", stage: "appended", delivery: "send", invoice_id: "10202026-86", invoice_date: "2026-10-20", message_id: "<made-up-86@example.com>", sent_json: sentJson("LD-TEST-0517"), updated_at: fresh() });
			await restart(q);
			eq([q.state("LD-TEST-0517"), q.smtp.length, q.calls.mint], [["drafted", ""], 0, 0], "§6 a queued claim past the hand-off, at start-up: recorded, nothing sent");
			const t = makeWorld();
			const tj = await t.started();
			ready(t, "LD-TEST-0518");
			t.seed("LD-TEST-0518", { state: "waiting", reason_code: "NOT_COMPLETED", stage: "appended", delivery: "send", invoice_id: "10202026-87", invoice_date: "2026-10-20", message_id: "<made-up-87@example.com>", sent_json: sentJson("LD-TEST-0518") });
			tap(t, tj, "LD-TEST-0518", { oldStatus: "Delivered" });
			await drained(t, "§6 past the hand-off, armed");
			eq([t.state("LD-TEST-0518"), t.smtp.length, t.calls.mint], [["drafted", ""], 0, 0], "§6 FAILS ON THE OLD CODE: ...or armed by a tap: the run records it, and never builds a sent load again");
		}
		{
			const w = makeWorld();
			on(w);
			ready(w, "LD-TEST-0511");
			w.seed("LD-TEST-0511", { state: "drafted", stage: "recorded", delivery: "send", invoice_id: "10202026-84" });
			await restart(w);
			eq([w.state("LD-TEST-0511"), w.smtp.length, w.calls.prepare], [["drafted", ""], 0, 0], "§6 done: nothing");
		}
		{
			// An open record older than an hour: somebody may have billed the load since.
			for (const fields of [{ state: "waiting", reason_code: "DRIVER_PENDING" }, { state: "queued" }, { state: "working", stage: "" }]) {
				const w = makeWorld();
				on(w);
				ready(w, "LD-TEST-0512");
				w.seed("LD-TEST-0512", { ...fields, updated_at: iso(T0 - 2 * HOUR) });
				await restart(w);
				eq([w.state("LD-TEST-0512"), w.smtp.length], [["needs_attention", "RETRY_LATER"], 0], `§6 a ${fields.state} record over an hour old goes to a person, whose Try again looks first`);
			}
		}
		{
			// A first half that fails (the database busy at boot): the second half tries it
			// once more, and nothing runs until it has.
			const w = makeWorld();
			on(w);
			ready(w, "LD-TEST-0514");
			w.seed("LD-TEST-0514", { state: "queued", updated_at: fresh() });
			const j = w.job({ workerId: "worker-2" });
			const realTx = w.db.transaction.bind(w.db);
			w.db.transaction = () => { throw Object.assign(new Error("made-up"), { code: "SQLITE_BUSY" }); };
			eq(j.startTrigger(), false, "§6 the first half fails on a busy database: logged, the process stays up");
			ok(w.logs.some((l) => /did not start: SQLITE_BUSY/.test(l)), "§6 ...by its code");
			const inert = j.driverDelivered({ role: "Driver", loadId: "LD-TEST-0514", oldStatus: "At Receiver", newStatus: "Delivered" });
			inert.written();
			eq(w.state("LD-TEST-0514"), ["queued", ""], "§6 ...and nothing has moved");
			w.db.transaction = realTx;
			await j.finishStartUp();
			await drained(w, "§6 retried");
			eq([w.state("LD-TEST-0514"), w.smtp.length], [["drafted", ""], 1], "§6 ...the second half tries it again, and the record runs once");
		}
		{
			// The settings' notice, the daily prune: at start-up, with no tick to do them.
			const w = makeWorld();
			on(w);
			w.db.prepare("UPDATE app_settings SET value = 'not json' WHERE key = 'auto_invoice.settings'").run();
			w.db.prepare("INSERT INTO auto_invoice_shadow (load_key, load_id, first_seen_at, verdict, render_digest_json, updated_at) VALUES ('ld-test-0515', 'LD-TEST-0515', ?, 'WOULD_ATTEMPT', ?, ?)")
				.run(iso(T0), JSON.stringify({ renderedAt: iso(T0 - 90 * 24 * HOUR) }), iso(T0));
			const j = w.job({ workerId: "worker-2" });
			j.startTrigger();
			await j.finishStartUp();
			ok(w.notices.some((n) => /settings/.test(n.title)), "§6 unreadable settings at start-up: one Super Admin notice");
			eq(w.db.prepare("SELECT render_digest_json FROM auto_invoice_shadow WHERE load_key = 'ld-test-0515'").get().render_digest_json, "", "§6 the daily prune runs at start-up");
		}
		{
			// The line stopped on a database error: the next read gives a queued claim its run.
			const w = makeWorld();
			const j = await w.started({ readCheckMs: 0 });
			ready(w, "LD-TEST-0516");
			w.seed("LD-TEST-0516", { state: "queued", next_attempt_at: iso(w.now), updated_at: iso(w.now) });
			served(j, ["LD-TEST-0516"]);
			await drained(w, "§6 the read wakes the line");
			eq([w.state("LD-TEST-0516"), w.smtp.length], [["drafted", ""], 1], "§6 a claim left queued gets its run at a Super Admin's next read");
		}
		{
			// A live request in flight: the first half of start-up runs before the app
			// listens, so a record made after it is never taken for a leftover.
			const w = makeWorld();
			on(w);
			w.ready("LD-TEST-0513");
			const j = w.job({ workerId: "worker-2" });
			j.startTrigger();
			const finish = j.finishStartUp();
			const live = j.driverDelivered({ role: "Driver", loadId: "LD-TEST-0513", oldStatus: "At Receiver", newStatus: "Delivered" });
			await finish;
			await turn();
			eq(w.state("LD-TEST-0513"), ["waiting", "DRIVER_PENDING"], "§6 a tap whose write is still in flight during start-up keeps its record");
			w.setRow("LD-TEST-0513", { "Job Status": "Delivered" });
			live.written();
			await drained(w, "§6 live");
			eq([w.state("LD-TEST-0513"), w.smtp.length], [["drafted", ""], 1], "§6 ...and runs once when it's written");
		}
	}

	section("§7  the FIRST start-up on a made-up copy of production's state");
	{
		// As production stands: real drafts on, sending to one domain, settle 0, a baseline
		// written, the sweep's last tick a minute ago, the flag named nowhere.
		const w = makeWorld();
		const deps = { send: { enabled: true, domains: [SEND_DOMAIN], settleMinutes: 0 } };
		w.meta("baseline_at", iso(T0 - 24 * HOUR));
		w.meta("last_on_tick_at", iso(T0 - MIN));
		w.meta("last_sweep_at", iso(T0 - MIN));
		const delivered = (id, over = {}) => {
			w.ready(id, { "Job Status": "Delivered", ...over });
		};
		// The baseline: old loads left to people.
		for (let i = 0; i < 5; i++) {
			delivered(`LD-OLD-${i}`);
			w.seed(`LD-OLD-${i}`, { state: "baseline" });
		}
		// Sent, drafted, closed.
		delivered("LD-SENT");
		w.seed("LD-SENT", { state: "drafted", stage: "recorded", delivery: "send", invoice_id: "10202026-1", fingerprint_json: "" });
		delivered("LD-DRAFT");
		w.seed("LD-DRAFT", { state: "drafted", stage: "recorded", invoice_id: "10202026-2" });
		delivered("LD-SKIPPED");
		w.seed("LD-SKIPPED", { state: "skipped", reason_code: "DRAFTED_BY_HAND" });
		// A person's already.
		delivered("LD-ATTENTION");
		w.seed("LD-ATTENTION", { state: "needs_attention", reason_code: "TOTAL_MISMATCH" });
		delivered("LD-OFFGAP");
		w.seed("LD-OFFGAP", { state: "needs_attention", reason_code: "OFF_GAP" });
		// What the sweep left on its way.
		delivered("LD-QUEUED");
		w.seed("LD-QUEUED", { state: "queued", next_attempt_at: iso(T0 - MIN) });
		delivered("LD-RETRY");
		w.seed("LD-RETRY", { state: "queued", reason_code: "RETRY_LATER", attempts: 1, stage: "reserved", invoice_id: "10202026-3", next_attempt_at: iso(T0 + 4 * HOUR) });
		delivered("LD-GEMINI");
		w.seed("LD-GEMINI", { state: "queued", reason_code: "GEMINI_DOWN", next_attempt_at: iso(T0 + 30 * MIN) });
		delivered("LD-PAUSED");
		w.seed("LD-PAUSED", { state: "queued", reason_code: "MAILBOX_PAUSED", stage: "reserved", invoice_id: "10202026-4", next_attempt_at: iso(T0 + 6 * HOUR) });
		delivered("LD-WAITPOD");
		w.seed("LD-WAITPOD", { state: "waiting", reason_code: "WAITING_POD" });
		delivered("LD-WAITRC");
		w.seed("LD-WAITRC", { state: "waiting", reason_code: "RATECON_MISSING", ratecon_checks: 1, next_attempt_at: iso(T0 + 2 * HOUR) });
		delivered("LD-SETTLING");
		w.seed("LD-SETTLING", { state: "waiting", reason_code: "SEND_SETTLING", next_attempt_at: iso(T0 + 10 * MIN) });
		w.setRow("LD-NOTDONE", { "Job Status": "In Transit" });
		w.seed("LD-NOTDONE", { state: "waiting", reason_code: "NOT_COMPLETED" });
		delivered("LD-DROPPED");
		w.seed("LD-DROPPED", { state: "waiting", reason_code: "LOAD_DROPPED" });
		// Caught by the restart, each with its lease still running.
		const leased = { lease_owner: "old-process", lease_until: iso(T0 + 10 * MIN) };
		delivered("LD-BUILDING");
		w.seed("LD-BUILDING", { state: "working", stage: "rendered", invoice_id: "10202026-5", message_id: "<made-up-5@example.com>", ...leased });
		delivered("LD-INFLIGHT");
		w.seed("LD-INFLIGHT", { state: "working", stage: "appending", delivery: "send", invoice_id: "10202026-6", message_id: "<made-up-6@example.com>", sent_json: "{}", ...leased });
		delivered("LD-UNCONFIRMED");
		w.seed("LD-UNCONFIRMED", { state: "queued", reason_code: "SEND_UNCONFIRMED", stage: "appending", delivery: "send", send_checks: 1, invoice_id: "10202026-7", message_id: "<made-up-7@example.com>", sent_json: "{}", next_attempt_at: iso(T0 + 15 * MIN) });
		delivered("LD-INSENT", {});
		w.sent.push("<made-up-8@example.com>");
		w.seed("LD-INSENT", { state: "working", stage: "appending", delivery: "send", invoice_id: "10202026-8", message_id: "<made-up-8@example.com>", sent_json: JSON.stringify({ to: BILLING, subject: "Example Broker Order #LD-INSENT", total: "$1,000.00" }), ...leased });
		delivered("LD-DRAFTING", { Email: OTHER });
		w.seed("LD-DRAFTING", { state: "working", stage: "appending", invoice_id: "10202026-9", message_id: "<made-up-9@example.com>", sent_json: "{}", ...leased });
		// Delivered in the sweep's last five minutes, with no claim yet.
		delivered("LD-NEW");
		// Every load the runner's rate cons would make sendable.
		const before = { rows: w.draftRows("LD-OLD-0").length };
		const claimsBefore = w.db.prepare("SELECT load_key, state, reason_code, invoice_id FROM auto_invoice_claims WHERE state IN ('baseline', 'drafted', 'skipped')").all();
		const attentionBefore = w.db.prepare("SELECT load_key, state, reason_code FROM auto_invoice_claims WHERE state = 'needs_attention'").all();

		const job = w.job(deps);
		ok(job.triggerMode, "§7 the deploy itself is the switch-on: on, with the setting unnamed");
		eq(job.startTrigger(), true, "§7 start-up's first half");
		// The first half alone: nothing built, nothing in flight but searches.
		eq(w.state("LD-QUEUED"), ["needs_attention", "HANDED_OVER"], "§7 FAILS ON THE OLD DESIGN (R-M2): queued, due now: a person, not a send");
		eq(w.state("LD-RETRY"), ["needs_attention", "RETRY_LATER"], "§7 queued for later (no timer would wake it): a person, its code kept");
		eq(w.state("LD-GEMINI"), ["needs_attention", "GEMINI_DOWN"], "§7 ...");
		eq(w.state("LD-PAUSED"), ["needs_attention", "MAILBOX_PAUSED"], "§7 ...");
		eq(w.claim("LD-RETRY").invoice_id, "10202026-3", "§7 ...its number kept for a person's Try again");
		eq(w.state("LD-WAITPOD"), ["needs_attention", "WAITING_POD"], "§7 waiting on a POD (the office marked it): a person; nothing would move it");
		eq(w.state("LD-WAITRC"), ["needs_attention", "RATECON_MISSING"], "§7 waiting on a rate con: a person");
		eq(w.state("LD-SETTLING"), ["needs_attention", "HANDED_OVER"], "§7 waiting on a settle: a person");
		eq(w.state("LD-NOTDONE"), ["waiting", "NOT_COMPLETED"], "§7 NOT_COMPLETED stays: a later tap arms it");
		eq(w.state("LD-DROPPED"), ["waiting", "LOAD_DROPPED"], "§7 LOAD_DROPPED stays");
		eq(w.state("LD-BUILDING"), ["needs_attention", "HANDED_OVER"], "§7 building, its lease still running: a person, not built again");
		eq(w.state("LD-DRAFTING"), ["needs_attention", "MAYBE_IN_GMAIL"], "§7 a draft in flight: a person, who looks; never appended");
		eq(w.claim("LD-BUILDING").lease_owner, "", "§7 the old process holds nothing now");
		ok(ledger.getMeta(w.db).trigger_on_at === iso(T0), "§7 trigger_on_at is written, with the handing over, in one transaction");

		await job.finishStartUp();
		await drained(w, "§7");
		eq(w.state("LD-INFLIGHT"), ["needs_attention", "MAYBE_SENT"], "§7 a send in flight, not in Sent Mail: searched only, MAYBE_SENT");
		eq(w.state("LD-UNCONFIRMED"), ["needs_attention", "MAYBE_SENT"], "§7 FAILS ON THE OLD DESIGN (R-M2): SEND_UNCONFIRMED: searched only, MAYBE_SENT, never sent");
		eq(w.claim("LD-INSENT").delivery, "send", "§7 a send in flight found in Sent Mail: it stays a send");
		ok(["drafted", "needs_attention"].includes(w.claim("LD-INSENT").state), "§7 ...recorded, or for a person");
		eq(w.claim("LD-NEW"), null, "§7 delivered just before the deploy, no claim: none is made");
		eq(w.claim("LD-NEW") === null && served(job, ["LD-NEW"])[0].code, "NOT_BY_DRIVER", "§7 ...it reads \"No automatic invoice\", counted by the toggle");
		eq(w.db.prepare("SELECT load_key, state, reason_code, invoice_id FROM auto_invoice_claims WHERE state IN ('baseline', 'skipped') OR (state = 'drafted' AND load_key IN ('ld-sent', 'ld-draft'))").all().length,
			claimsBefore.length, "§7 the baseline, sent, drafted and skipped claims stand");
		eq(attentionBefore.map((c) => w.state(c.load_key)), attentionBefore.map((c) => [c.state, c.reason_code]), "§7 a person's claims stand as they were");

		eq([w.smtp.length, w.appends.length, w.calls.mint], [0, 0, 0], "§7 NOTHING SENT, NOTHING APPENDED, NO NUMBER: no load already completed goes out because of the change");
		ok(w.calls.prepare <= 1 && w.calls.render <= 1, "§7 ...the engine runs at most to rebuild the record of the one send found in Sent Mail");
		eq(w.draftRows("LD-OLD-0").length, before.rows, "§7 ...no row on an old load");
		eq(w.open(), 0, "§7 no claim is left queued or working");
		eq(w.actions("auto_invoice_trigger_on").length, 1, "§7 one audit row says what happened");
		ok(/went to a person/.test(w.actions("auto_invoice_trigger_on")[0].details), "§7 ...and how many went to a person");
		ok(w.notices.some((n) => /only from the driver's Delivered/.test(n.body)), "§7 ...and a Super Admin is told");

		// Ticks don't run; a second start-up changes nothing.
		const stateNow = JSON.stringify(w.db.prepare("SELECT load_key, state, reason_code FROM auto_invoice_claims ORDER BY load_key").all());
		const again = w.job({ ...deps, workerId: "worker-2" });
		again.startTrigger();
		await again.finishStartUp();
		await drained(w, "§7 again");
		eq(JSON.stringify(w.db.prepare("SELECT load_key, state, reason_code FROM auto_invoice_claims ORDER BY load_key").all()), stateNow, "§7 the next start-up isn't a first: nothing moves");
		eq([w.smtp.length, w.appends.length, w.actions("auto_invoice_trigger_on").length], [0, 0, 1], "§7 ...nothing sent, and no second audit row");

		// The deploy's own failure case: no baseline yet (a fresh database, never production's).
		const fresh = makeWorld();
		fresh.ready("LD-TEST-0601", { "Job Status": "Delivered" });
		const freshJob = fresh.job();
		freshJob.startTrigger();
		await freshJob.finishStartUp();
		eq([fresh.state("LD-TEST-0601"), fresh.smtp.length], [["baseline", ""], 0], "§7 a database with no baseline: written at start-up, nothing sent (R L6)");
		eq(served(freshJob, ["LD-TEST-0601"]), [null], "§7 ...so an old row carries no chip");

		// With sending stopped, or the job off, nothing changes the answer.
		const off = makeWorld();
		off.ready("LD-TEST-0602", { "Job Status": "Delivered" });
		const offJob = off.job({ env: {} });
		eq([offJob.startTrigger(), offJob.mode], [false, "off"], "§7 the job off: nothing");
		await offJob.finishStartUp();
		eq([off.smtp.length, off.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'auto_invoice_claims'").get()], [0, undefined], "§7 ...not even a table");
	}

	section("§8  no claim left queued or working, for every way a run can end (R-M3)");
	{
		const runCase = async (label, setup, want, more = () => {}) => {
			const w = makeWorld();
			const job = await w.started(setup.extra || {});
			w.ready("LD-TEST-0701", setup.over || {}, setup.docEmail || BILLING);
			if (setup.before) await setup.before(w, job);
			tap(w, job, "LD-TEST-0701");
			await until(() => w.open() === 0 && w.claim("LD-TEST-0701").reason_code !== "DRIVER_PENDING", `§8 ${label}: settled`);
			await turn();
			eq([w.state("LD-TEST-0701"), w.open()], [want, 0], `§8 FAILS ON THE OLD DESIGN: ${label}: ${want.join(" ")}, nothing left queued or working`);
			await more(w, job);
			return w;
		};
		await runCase("no rate con yet", { before: (w) => w.rateCons.delete("ld-test-0701") }, ["needs_attention", "RATECON_MISSING"]);
		await runCase("the engine answers 500", { before: (w) => { w.prepareHook = () => ({ ok: false, http: 500, code: "DRAFT_ERROR" }); } }, ["needs_attention", "RETRY_LATER"]);
		await runCase("the engine throws", { before: (w) => { w.prepareHook = () => { throw Object.assign(new Error("made-up"), { code: "ECONNRESET" }); }; } }, ["needs_attention", "RETRY_LATER"]);
		await runCase("Gemini seen down", { before: (w) => { w.geminiDownAt = w.now; } }, ["needs_attention", "GEMINI_DOWN"]);
		await runCase("the renderer busy", { before: (w) => { w.renderHook = () => { throw Object.assign(new Error("made-up"), { code: "RENDERER_BUSY" }); }; } }, ["needs_attention", "RENDERER_BUSY"]);
		await runCase("the sheet down", { before: (w) => { w.readFails = true; } }, ["needs_attention", "RETRY_LATER"]);
		await runCase("settings unreadable", { before: (w) => { w.db.prepare("UPDATE app_settings SET value = 'not json' WHERE key = 'auto_invoice.settings'").run(); } }, ["needs_attention", "SETTINGS_UNREADABLE"]);
		await runCase("no mailbox", { before: (w) => { w.mailbox = { user: "", pass: "" }; } }, ["needs_attention", "NO_MAILBOX"]);
		await runCase("the mailbox paused", { before: (w) => { ledger.setMeta(w.db, "paused_until", iso(w.now + HOUR)); } }, ["needs_attention", "MAILBOX_PAUSED"]);
		await runCase("the engine sees no POD", { before: (w) => { w.prepareHook = () => ({ ok: false, http: 422, code: "POD_NOT_FOUND" }); } }, ["needs_attention", "POD_UNREADABLE"]);
		await runCase("a press in flight", {
			before: (w) => {
				factoring.ensureSchema(w.db);
				w.db.prepare("INSERT INTO invoice_draft_inflight (load_key, load_id, invoice_id, path, state, started_at, updated_at) VALUES ('ld-test-0701', 'LD-TEST-0701', '10202026-99', 'imap', 'in_flight', ?, ?)").run(iso(w.now), iso(w.now));
			},
		}, ["needs_attention", "HAND_DRAFT_IN_FLIGHT"], async (w) => {
			eq([w.smtp.length, w.appends.length], [0, 0], "§8 ...a press in flight refuses the send: neither sent nor drafted");
		});
		await runCase("Gmail refuses the login", { over: { Email: OTHER }, docEmail: "billing@example-other.test", before: (w) => w.appendBehaviors.push("LOGIN") }, ["needs_attention", "MAILBOX_PAUSED"], async (w) => {
			ok(!/will try again then/.test(w.notices.map((n) => n.body).join(" ")), "§8 ...its notice promises no retry");
		});
		await runCase("an append with no answer, not found", { over: { Email: OTHER }, docEmail: "billing@example-other.test", before: (w) => w.appendBehaviors.push("LOST") }, ["needs_attention", "MAYBE_IN_GMAIL"], async (w) => {
			eq([w.calls.search, w.calls.sleep], [2, [2 * MIN]], "§8 ...searched at once and once more 2 minutes later, inside the run");
		});
		await runCase("an append with no answer, found", { over: { Email: OTHER }, docEmail: "billing@example-other.test", before: (w) => w.appendBehaviors.push("LANDED_LOST") }, ["drafted", ""]);
		await runCase("an unanswered send, not found", { before: (w) => w.smtpBehaviors.push("LOST") }, ["needs_attention", "MAYBE_SENT"], async (w) => {
			eq([w.smtp.length, w.calls.search, w.calls.sleep, w.calls.searchBoxes.every((b) => b[0] === SENT)], [1, 2, [2 * MIN], true], "§8 ...one SMTP call, searched at once and 2 minutes later in Sent Mail only");
			ok(ledger.getSendStop(w.db), "§8 ...and the stop stands, as today");
		});
		await runCase("an unanswered send, found", { before: (w) => w.smtpBehaviors.push("LANDED_LOST") }, ["drafted", ""], async (w) => {
			eq([w.smtp.length, w.claim("LD-TEST-0701").delivery], [1, "send"], "§8 ...one SMTP call, recorded as sent");
		});
		await runCase("SMTP refused: the same run makes the draft", { before: (w) => w.smtpBehaviors.push("REFUSED") }, ["drafted", ""], async (w) => {
			eq([w.smtp.length, w.appends.length, w.claim("LD-TEST-0701").delivery, ledger.getSendStop(w.db).reason], [1, 1, "", "SMTP_REFUSED"], "§8 FAILS ON THE OLD DESIGN: ...one refused SMTP call, then one draft, and the stop");
		});
		{
			// SMTP refused and the stop can't be written: nothing makes the next try a draft,
			// and no timer would space the tries out. It goes to a person after one more.
			const w = makeWorld();
			const job = await w.started();
			w.ready("LD-TEST-0706");
			w.smtpBehaviors.push("REFUSED", "REFUSED", "REFUSED", "REFUSED");
			const realStop = ledger.setSendStop;
			ledger.setSendStop = () => { throw Object.assign(new Error("made-up"), { code: "SQLITE_BUSY" }); };
			tap(w, job, "LD-TEST-0706");
			await drained(w, "§8 refused twice");
			ledger.setSendStop = realStop;
			eq([w.state("LD-TEST-0706"), w.smtp.length, w.appends.length], [["needs_attention", "RETRY_LATER"], 2, 0], "§8 FAILS ON THE OLD DESIGN: SMTP refused with no stop written: one more try, then a person, never a loop");
		}
		{
			// A throw at stage appended: the record can't be made after the send went.
			const w = makeWorld();
			const job = await w.started();
			w.ready("LD-TEST-0702");
			w.recordHook = () => { throw Object.assign(new Error("made-up"), { code: "SQLITE_BUSY" }); };
			tap(w, job, "LD-TEST-0702");
			await drained(w, "§8 record");
			eq([w.state("LD-TEST-0702"), w.smtp.length, w.claim("LD-TEST-0702").stage], [["needs_attention", "IN_GMAIL_UNRECORDED"], 1, "appended"], "§8 a send whose record fails: IN_GMAIL_UNRECORDED, sent once");
			w.recordHook = null;
			eq((await tryAgain(job, "LD-TEST-0702")).status, 200, "§8 ...Try again");
			await drained(w, "§8 record again");
			eq([w.state("LD-TEST-0702"), w.smtp.length, w.draftRows("LD-TEST-0702").length], [["drafted", ""], 1, 1], "§8 ...records it, never sends again");
		}
		{
			// R-M3's failing case: settings unreadable, Try again on a load that may be in Gmail.
			const w = makeWorld();
			const job = await w.started();
			w.ready("LD-TEST-0703", { "Job Status": "Delivered" });
			w.seed("LD-TEST-0703", { state: "needs_attention", reason_code: "MAYBE_IN_GMAIL", stage: "appending", invoice_id: "10202026-85", message_id: "<made-up-85@example.com>" });
			w.db.prepare("UPDATE app_settings SET value = 'not json' WHERE key = 'auto_invoice.settings'").run();
			eq((await tryAgain(job, "LD-TEST-0703")).status, 200, "§8 Try again with the settings unreadable");
			await drained(w, "§8 unreadable");
			eq(w.state("LD-TEST-0703"), ["needs_attention", "MAYBE_IN_GMAIL"], "§8 FAILS ON THE OLD DESIGN (R-M3): not stuck `working`: back to a person, Try again still works");
		}
		{
			// The caps: over one reads CAP_REACHED; one in flight just waits its turn.
			const w = makeWorld();
			const job = await w.started({ env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_MAX_PER_HOUR: "1" } });
			w.ready("LD-TEST-0704");
			tap(w, job, "LD-TEST-0704");
			await drained(w, "§8 cap first");
			w.ready("LD-TEST-0705");
			tap(w, job, "LD-TEST-0705");
			await until(() => w.claim("LD-TEST-0705").state === "needs_attention", "§8 cap second");
			eq([w.state("LD-TEST-0704"), w.state("LD-TEST-0705"), w.smtp.length], [["drafted", ""], ["needs_attention", "CAP_REACHED"], 1], "§9 FAILS ON THE OLD DESIGN: over the hourly cap: CAP_REACHED, no send");
		}
	}

	section("§9  the send rules that stay");
	{
		// One at a time: two taps during a build run in turn.
		const w = makeWorld();
		const job = await w.started();
		const held = gate();
		let renders = 0;
		w.renderHook = async () => { renders++; if (renders === 1) await held.p; };
		w.ready("LD-TEST-0801");
		w.ready("LD-TEST-0802");
		tap(w, job, "LD-TEST-0801");
		await until(() => renders === 1, "§9 first build");
		tap(w, job, "LD-TEST-0802");
		await turn();
		await turn();
		eq([w.claim("LD-TEST-0801").state, w.claim("LD-TEST-0802").state, w.smtp.length, renders], ["working", "queued", 0, 1], "§9 a second tap during a build waits its turn");
		held.open();
		await drained(w, "§9 both");
		eq([w.state("LD-TEST-0801"), w.state("LD-TEST-0802"), w.smtp.length], [["drafted", ""], ["drafted", ""], 2], "§9 ...then each goes once");

		// The Stop.
		const s = makeWorld();
		const sj = await s.started();
		ledger.setSendStop(s.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(s.now) });
		s.ready("LD-TEST-0803");
		tap(s, sj, "LD-TEST-0803");
		await drained(s, "§9 stop");
		eq([s.state("LD-TEST-0803"), s.smtp.length, s.appends.length], [["drafted", ""], 0, 1], "§9 stopped: a Gmail draft, nothing sent");

		// A domain not listed: a draft.
		const n = makeWorld();
		const nj = await n.started({ send: { enabled: true, domains: ["example-listed.test"] } });
		n.ready("LD-TEST-0804");
		tap(n, nj, "LD-TEST-0804");
		await drained(n, "§9 not listed");
		eq([n.state("LD-TEST-0804"), n.smtp.length, n.appends.length], [["drafted", ""], 0, 1], "§9 a domain not on the list: a draft");

		// Sending off.
		const o = makeWorld();
		const oj = await o.started({ send: { enabled: false, domains: [SEND_DOMAIN] } });
		o.ready("LD-TEST-0805");
		tap(o, oj, "LD-TEST-0805");
		await drained(o, "§9 sending off");
		eq([o.state("LD-TEST-0805"), o.smtp.length, o.appends.length], [["drafted", ""], 0, 1], "§9 sending off: a draft");

		// A person's draft wins: at the run's start, and in the render's window.
		const h = makeWorld();
		const hj = await h.started();
		h.ready("LD-TEST-0806");
		h.handDraft("LD-TEST-0806");
		tap(h, hj, "LD-TEST-0806");
		await drained(h, "§9 hand draft");
		eq([h.state("LD-TEST-0806"), h.smtp.length, h.calls.mint], [["skipped", "DRAFTED_BY_HAND"], 0, 0], "§9 a person's draft row: skipped, nothing sent, no number");
		const hl = makeWorld();
		const hlj = await hl.started();
		hl.ready("LD-TEST-0807");
		hl.renderHook = () => { hl.handDraft("LD-TEST-0807"); };
		tap(hl, hlj, "LD-TEST-0807");
		await drained(hl, "§9 hand draft in the build");
		eq([hl.state("LD-TEST-0807"), hl.smtp.length], [["skipped", "DRAFTED_BY_HAND"], 0], "§9 ...made during the build: the same");

		// Factoring is read last: a mark made during the build.
		const f = makeWorld();
		const fj = await f.started();
		f.ready("LD-TEST-0808");
		f.renderHook = () => markFactored(f, "LD-TEST-0808");
		tap(f, fj, "LD-TEST-0808");
		await drained(f, "§9 factored");
		eq([f.state("LD-TEST-0808"), f.smtp.length, f.appends.length], [["skipped", "LOAD_FACTORED"], 0, 0], "§9 factored during the build: nothing sent or drafted");

		// ...and read last: marked in the one step between the render's checks and the commit.
		const f2 = makeWorld();
		const f2j = await f2.started();
		f2.ready("LD-TEST-0813");
		const realCheck = sendLib.outgoingCheck;
		sendLib.outgoingCheck = (...a) => {
			markFactored(f2, "LD-TEST-0813");
			return realCheck(...a);
		};
		tap(f2, f2j, "LD-TEST-0813");
		await drained(f2, "§9 factored last");
		sendLib.outgoingCheck = realCheck;
		eq([f2.state("LD-TEST-0813"), f2.smtp.length, f2.appends.length], [["needs_attention", "LOAD_FACTORED"], 0, 0], "§9 factoring is read last, inside the send's commit: nothing sent");

		// The last check on the message.
		const c = makeWorld();
		const cj = await c.started();
		c.ready("LD-TEST-0809");
		const realRender = c.engine.render;
		c.engine.render = async (ctx, opts) => {
			const r = await realRender(ctx, opts);
			return { ...r, attachments: r.attachments.slice(0, 2) };
		};
		tap(c, cj, "LD-TEST-0809");
		await drained(c, "§9 last check");
		eq([c.state("LD-TEST-0809"), c.smtp.length], [["needs_attention", "SEND_REFUSED"], 0], "§9 a message missing its rate con fails its last check: nothing sent");

		// A POD time that can't be read still never sends.
		const t = makeWorld();
		const tj = await t.started();
		t.ready("LD-TEST-0810");
		t.db.prepare("UPDATE documents SET uploaded_at = 'not a time'").run();
		tap(t, tj, "LD-TEST-0810");
		await drained(t, "§9 POD time");
		eq([t.state("LD-TEST-0810"), t.smtp.length, t.appends.length], [["drafted", ""], 0, 1], "§9 a POD time that can't be read: drafted, never sent");
		const a = makeWorld();
		const aj = await a.started();
		a.ready("LD-TEST-0811");
		a.db.prepare("UPDATE documents SET uploaded_at = ?").run(new Date(a.now + 2 * MIN).toISOString().slice(0, 19).replace("T", " "));
		tap(a, aj, "LD-TEST-0811");
		await drained(a, "§9 POD time ahead");
		eq([a.state("LD-TEST-0811"), a.smtp.length, a.appends.length], [["drafted", ""], 0, 1], "§9 a POD time a little ahead of the clock: drafted; no wait in this mode");

		// No settle in this mode, whatever the setting says.
		const z = makeWorld();
		const zj = await z.started({ send: { enabled: true, domains: [SEND_DOMAIN], settleMinutes: 60 } });
		z.ready("LD-TEST-0812");
		z.db.prepare("UPDATE documents SET uploaded_at = ?").run(new Date(z.now - MIN).toISOString().slice(0, 19).replace("T", " "));
		tap(z, zj, "LD-TEST-0812");
		await drained(z, "§9 settle");
		eq([z.state("LD-TEST-0812"), z.smtp.length], [["drafted", ""], 1], "§9 AUTO_INVOICE_SEND_SETTLE_MINUTES isn't read: no wait, one send");
	}

	section("§10 Try again looks first (R-H2)");
	{
		const heldForAPerson = (w, id, code = "TOTAL_MISMATCH", more = {}) => {
			w.ready(id, { "Job Status": "Delivered" });
			w.seed(id, { state: "needs_attention", reason_code: code, ...more });
		};
		// A clean look: the Payments Table, then the mailbox, then one send.
		const w = makeWorld();
		const job = await w.started();
		heldForAPerson(w, "LD-TEST-0901");
		eq((await tryAgain(job, "LD-TEST-0901")).status, 200, "§10 Try again answers at once");
		ok(w.claim("LD-TEST-0901").look_first, "§10 FAILS ON THE OLD DESIGN: the claim itself asks for the look, so a restart can't lose it");
		await drained(w, "§10 clean");
		eq([w.state("LD-TEST-0901"), w.smtp.length, w.calls.payments, w.calls.look.length, w.claim("LD-TEST-0901").look_first], [["drafted", ""], 1, 1, 1, ""], "§10 FAILS ON THE OLD CODE: a clean look: one SMTP call, the look cleared");
		eq([w.calls.look[0].loadNumber, w.calls.look[0].lastCheck], ["LD-TEST-0901", true], "§10 ...searched by the load number, as the send's last look");
		ok(w.calls.look[0].invoiceNumbers.every((n) => /^\d{8}-\d+$/.test(n)), "§10 ...and any invoice number on file");
		// The terms: every number the load's rows and its claim hold.
		const terms = makeWorld();
		const tj = await terms.started();
		heldForAPerson(terms, "LD-TEST-0912", "TOTAL_MISMATCH", { invoice_id: "10202026-31", invoice_date: "2026-10-20", reserved_at: iso(T0 - MIN), stage: "reserved", message_id: "<made-up-31@example.com>" });
		terms.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, order_number, via, created_by) VALUES ('LD-TEST-0912', '10192026-4', 'ORD-5501', 'imap', 'made-up')").run();
		terms.lookAnswer = { verdict: "invoice", mailboxes: {} };
		ok(!(await tryAgain(tj, "LD-TEST-0912")).body.error, "§10 Try again on a load with rows");
		await drained(terms, "§10 terms");
		// A person's row closes the claim first, as today: the terms are read from the row the search would need.
		eq(terms.state("LD-TEST-0912"), ["skipped", "DRAFTED_BY_HAND"], "§10 ...a person's row closes the claim first: no look is spent");
		eq(ledger.draftRefsFor(terms.db, "ld-test-0912"), { invoiceNumbers: ["10192026-4"], orderNumbers: ["ORD-5501"] }, "§10 FAILS ON THE OLD CODE: ...the rows' invoice and order numbers are there for a search (a Bison invoice carries its own Order #)");

		for (const [label, set, code] of [
			["an invoice in the mailbox", (x) => { x.lookAnswer = { verdict: "invoice", mailboxes: {} }; }, "MAILBOX_HIT"],
			["a mention in the mailbox", (x) => { x.lookAnswer = { verdict: "mention", mailboxes: {} }; }, "MAILBOX_HIT"],
			["a search that fails", (x) => { x.lookFails = true; }, "MAILBOX_UNREAD"],
			["an unreadable answer", (x) => { x.lookAnswer = { found: 0 }; }, "MAILBOX_UNREAD"],
			["no search on this tree", (x, extra) => { extra.lookInMailbox = null; }, "MAILBOX_UNREAD"],
			["a filled Payments Table row", (x) => { x.payments = [[...PAYMENTS_HEADERS], ["LD-TEST-0902", "Example Broker", "$1,000.00", "", "", "Paid"]]; }, "PAYMENTS_TABLE_HIT"],
			["the same row spelled #LD", (x) => { x.payments = [[...PAYMENTS_HEADERS], ["#ld-test-0902", "Example Broker", "$1,000.00", "INV-7", "", ""]]; }, "PAYMENTS_TABLE_HIT"],
			["a Payments Table that can't be read", (x) => { x.paymentsFail = true; }, "PAYMENTS_UNREAD"],
			["a Payments Table without its columns", (x) => { x.payments = [[" Job ID", "Payment Amount"]]; }, "PAYMENTS_UNREAD"],
		]) {
			const x = makeWorld();
			const extra = {};
			set(x, extra);
			const j = await x.started(extra);
			heldForAPerson(x, "LD-TEST-0902");
			eq((await tryAgain(j, "LD-TEST-0902")).status, 200, `§10 ${label}: Try again answers`);
			await drained(x, `§10 ${label}`);
			eq([x.state("LD-TEST-0902"), x.smtp.length, x.calls.mint, x.appends.length], [["needs_attention", code], 0, 0, 0], `§10 FAILS ON THE OLD CODE: ${label}: ${code}, nothing sent, no number used`);
			ok(x.claim("LD-TEST-0902").look_first, `§10 ...${label}: the look stays asked for`);
		}
		// A blank row on the table is no hit; another load's row is none either.
		const b = makeWorld();
		b.payments = [[...PAYMENTS_HEADERS], ["LD-TEST-0903", "Example Broker", "$1,000.00", "  ", "", ""], ["LD-TEST-9999", "", "", "INV-1", "", ""]];
		const bj = await b.started();
		heldForAPerson(b, "LD-TEST-0903");
		await tryAgain(bj, "LD-TEST-0903");
		await drained(b, "§10 blank row");
		eq([b.state("LD-TEST-0903"), b.smtp.length], [["drafted", ""], 1], "§10 a blank row, and another load's row: no hit");

		// R-H2 (b): a restart between the press and the run.
		const r = makeWorld();
		const rj = await r.started();
		heldForAPerson(r, "LD-TEST-0904");
		r.lookAnswer = { verdict: "invoice", mailboxes: {} };
		const f = fakeApp();
		rj.mount(f.app, { requireRole: f.requireRole });
		await f.call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "LD-TEST-0904" } });
		// The same database, a new process, before that run began.
		const next = r.job({ workerId: "worker-2" });
		next.startTrigger();
		await next.finishStartUp();
		await drained(r, "§10 restart");
		eq([r.state("LD-TEST-0904"), r.smtp.length], [["needs_attention", "MAILBOX_HIT"], 0], "§10 FAILS ON THE OLD DESIGN (R-H2 b): a restart between the press and the run: the look still runs, nothing sent");

		// R-H2 (b), the second branch: a draft looked for, absent, queued again.
		const a = makeWorld();
		const aj = await a.started();
		a.ready("LD-TEST-0905", { "Job Status": "Delivered" });
		a.seed("LD-TEST-0905", { state: "needs_attention", reason_code: "MAYBE_IN_GMAIL", stage: "appending", invoice_id: "10202026-90", invoice_date: "2026-10-20", reserved_at: iso(T0 - MIN), message_id: "<made-up-90@example.com>", sent_json: "{}" });
		a.lookAnswer = { verdict: "invoice", mailboxes: {} };
		await tryAgain(aj, "LD-TEST-0905");
		await drained(a, "§10 second branch");
		eq([a.state("LD-TEST-0905"), a.smtp.length, a.appends.length], [["needs_attention", "MAILBOX_HIT"], 0, 0], "§10 FAILS ON THE OLD DESIGN (R-H2 b): a draft absent from Gmail, queued again: the look still runs");

		// A send that may have gone: Try again only ever searches.
		const m = makeWorld();
		const mj = await m.started();
		m.ready("LD-TEST-0906", { "Job Status": "Delivered" });
		m.seed("LD-TEST-0906", { state: "needs_attention", reason_code: "MAYBE_SENT", stage: "appending", delivery: "send", invoice_id: "10202026-91", message_id: "<made-up-91@example.com>", sent_json: "{}" });
		await tryAgain(mj, "LD-TEST-0906");
		await drained(m, "§10 maybe sent");
		eq([m.state("LD-TEST-0906"), m.smtp.length, m.calls.look.length], [["needs_attention", "MAYBE_SENT"], 0, 0], "§10 MAYBE_SENT: searched only; never sends");

		// A load that couldn't be sent: no look, its draft as before.
		const d = makeWorld();
		const dj = await d.started();
		d.ready("LD-TEST-0907", { "Job Status": "Delivered", Email: OTHER }, "billing@example-other.test");
		d.seed("LD-TEST-0907", { state: "needs_attention", reason_code: "TOTAL_MISMATCH" });
		await tryAgain(dj, "LD-TEST-0907");
		await drained(d, "§10 no look");
		eq([d.state("LD-TEST-0907"), d.appends.length, d.calls.look.length, d.calls.payments], [["drafted", ""], 1, 0, 0], "§10 a broker not on the send list: no look, a draft");

		// OFF_GAP and saved evidence: refused before anything runs.
		const o = makeWorld();
		const oj = await o.started();
		heldForAPerson(o, "LD-TEST-0908", "OFF_GAP");
		const off = await tryAgain(oj, "LD-TEST-0908");
		eq([off.status, off.body.code, o.state("LD-TEST-0908"), o.smtp.length], [409, "AUTO_INVOICE_RETRY_REFUSED", ["needs_attention", "OFF_GAP"], 0], "§10 FAILS ON THE OLD CODE: OFF_GAP: 409, nothing runs");
		const e = makeWorld();
		const ej = await e.started({ savedInvoiceEvidence: () => true });
		heldForAPerson(e, "LD-TEST-0909");
		eq((await tryAgain(ej, "LD-TEST-0909")).status, 409, "§10 FAILS ON THE OLD CODE: saved evidence of an invoice: 409");

		// No send can commit while the look is asked for, whatever the path.
		const l = makeWorld();
		ledger.ensureSchema(l.db);
		l.seed("LD-TEST-0910", { state: "working", stage: "rendered", lease_owner: "me", look_first: iso(l.now), invoice_id: "10202026-92" });
		eq(ledger.beginSend(l.db, "ld-test-0910", "me", { nowIso: iso(l.now) }), { ok: false, reason: "look" }, "§10 FAILS ON THE OLD CODE: beginSend() refuses while the look is asked for");
		l.db.prepare("UPDATE auto_invoice_claims SET look_first = ''").run();
		eq(ledger.beginSend(l.db, "ld-test-0910", "me", { nowIso: iso(l.now) }), { ok: true }, "§10 ...and goes once it's clear");

		// The route, with the sweep: nothing changes.
		const sw = makeWorld();
		const swj = sw.job({ env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" } });
		heldForAPerson(sw, "LD-TEST-0911", "OFF_GAP");
		eq((await tryAgain(swj, "LD-TEST-0911")).status, 200, "§10 the sweep's Try again on OFF_GAP: as today");
		eq(sw.claim("LD-TEST-0911").look_first, "", "§10 ...and it asks for no look");
	}

	section("§11 a stuck run (R-M4)");
	{
		// A attempt stuck in its build, past the limit; a person presses Try again; A wakes.
		const w = makeWorld();
		const job = await w.started({ runLimitMs: 5 });
		w.ready("LD-TEST-1001");
		const stuck = gate();
		let renders = 0;
		w.renderHook = async () => { renders++; if (renders === 1) await stuck.p; };
		tap(w, job, "LD-TEST-1001");
		await until(() => w.claim("LD-TEST-1001").state === "needs_attention", "§11 past the limit");
		const c1 = w.claim("LD-TEST-1001");
		eq([c1.state, c1.reason_code, c1.lease_owner], ["needs_attention", "DRAFT_FAILED", ""], "§11 FAILS ON THE OLD DESIGN: past the limit, by its stage: a person");
		w.ready("LD-TEST-1002");
		tap(w, job, "LD-TEST-1002");
		await until(() => w.claim("LD-TEST-1002").state === "drafted", "§11 the next load");
		eq(w.smtp.map((m) => m.subject), ["Example Broker Order #LD-TEST-1002"], "§11 FAILS ON THE OLD DESIGN: the next load goes on");
		// Attempt B, by a person's Try again, holds its own build open while A wakes.
		const secondBuild = gate();
		w.renderHook = async () => { await secondBuild.p; };
		eq((await tryAgain(job, "LD-TEST-1001")).status, 200, "§11 a person presses Try again");
		await until(() => w.calls.look.length === 1 && w.claim("LD-TEST-1001").state === "working", "§11 attempt B runs");
		const tokenB = w.claim("LD-TEST-1001").lease_owner;
		// Any SMTP call is held open, so an attempt A that reached one is still in it when B's build ends.
		const inSmtpCall = gate();
		w.smtpHook = () => inSmtpCall.p;
		stuck.open();
		for (let i = 0; i < 20; i++) await turn();
		eq(w.claim("LD-TEST-1001").stage === "appending", false, "§11 FAILS ON THE OLD DESIGN: attempt A wakes: every write it tries fails, nothing commits a send");
		eq(w.claim("LD-TEST-1001").lease_owner, tokenB, "§11 FAILS ON THE OLD DESIGN: ...attempt B still holds the claim");
		secondBuild.open();
		await until(() => w.smtp.some((m) => m.subject === "Example Broker Order #LD-TEST-1001"), "§11 attempt B reaches its send");
		for (let i = 0; i < 20; i++) await turn();
		inSmtpCall.open();
		w.smtpHook = null;
		await drained(w, "§11 attempt B");
		const sends = w.smtp.filter((m) => m.subject === "Example Broker Order #LD-TEST-1001").length;
		eq([sends, w.state("LD-TEST-1001"), w.draftRows("LD-TEST-1001").length], [1, ["drafted", ""], 1], "§11 FAILS ON THE OLD DESIGN (R-M4's case): an abandoned attempt plus Try again: ONE SMTP call, one row");
		ok(job.workerId === "worker-1" && !/^worker-1$/.test(tokenB) && tokenB.startsWith("worker-1#"), "§11 each run holds its claim under its own token");

		// Stuck at the SMTP call itself: a send that started is only ever searched for.
		const s = makeWorld();
		const sj = await s.started({ runLimitMs: 5 });
		s.ready("LD-TEST-1003");
		const inSmtp = gate();
		s.smtpHook = () => inSmtp.p;
		tap(s, sj, "LD-TEST-1003");
		await until(() => s.claim("LD-TEST-1003").state === "needs_attention", "§11 stuck in SMTP");
		const c3 = s.claim("LD-TEST-1003");
		eq([c3.state, c3.reason_code, c3.stage, c3.delivery, Boolean(ledger.getSendStop(s.db))], ["needs_attention", "MAYBE_SENT", "appending", "send", true], "§11 FAILS ON THE OLD DESIGN: stuck in SMTP: MAYBE_SENT and the stop");
		s.smtpHook = null;
		await tryAgain(sj, "LD-TEST-1003");
		await drained(s, "§11 searched");
		eq([s.smtp.length, s.state("LD-TEST-1003")], [1, ["needs_attention", "MAYBE_SENT"]], "§11 ...Try again only searches");
		inSmtp.open();
		await turn();
		await turn();
		eq([s.smtp.length, s.state("LD-TEST-1003")], [1, ["needs_attention", "MAYBE_SENT"]], "§11 ...and the stuck call finishing changes nothing");
		s.sent.push(c3.message_id);
		await tryAgain(sj, "LD-TEST-1003");
		await drained(s, "§11 found");
		eq([s.smtp.length, s.claim("LD-TEST-1003").delivery, s.claim("LD-TEST-1003").state === "drafted" || s.claim("LD-TEST-1003").reason_code === "IN_GMAIL_UNRECORDED"], [1, "send", true], "§11 ...once Sent Mail holds it, it's recorded: one SMTP call in all");

		// A run past the limit at a draft's append.
		const d = makeWorld();
		const dj = await d.started({ runLimitMs: 5 });
		d.ready("LD-TEST-1004", { Email: OTHER }, "billing@example-other.test");
		const inAppend = gate();
		d.recordHook = () => inAppend.p;
		tap(d, dj, "LD-TEST-1004");
		await until(() => d.claim("LD-TEST-1004").state === "needs_attention", "§11 stuck recording");
		eq([d.state("LD-TEST-1004"), d.appends.length], [["needs_attention", "IN_GMAIL_UNRECORDED"], 1], "§11 stuck recording a draft: IN_GMAIL_UNRECORDED");
		inAppend.open();
	}

	section("§12 the watching");
	{
		// A change after a send, at a Super Admin's read: as today, the stop included.
		const w = makeWorld();
		const job = await w.started({ readCheckMs: MIN });
		w.ready("LD-TEST-1101");
		tap(w, job, "LD-TEST-1101");
		await drained(w, "§12 sent");
		w.now += 5 * MIN;
		served(job, ["LD-TEST-1101"]);
		await until(() => w.calls.reads >= 2, "§12 read");
		await turn();
		eq([w.claim("LD-TEST-1101").changed_fields, ledger.getSendStop(w.db)], ["", null], "§12 a read with nothing changed: nothing");
		const reads = w.calls.reads;
		w.setRow("LD-TEST-1101", { "  Payment  ": "$1,200.00" });
		served(job, ["LD-TEST-1101"]);
		await turn();
		eq([w.calls.reads, w.claim("LD-TEST-1101").changed_fields], [reads, ""], "§12 FAILS ON THE OLD DESIGN: within the minute: no second check");
		w.now += MIN + 1;
		served(job, ["LD-TEST-1101"]);
		await until(() => w.claim("LD-TEST-1101").changed_fields === "payment", "§12 changed");
		eq([w.claim("LD-TEST-1101").changed_fields, ledger.getSendStop(w.db).reason, w.actions("auto_invoice_load_changed").length, w.smtp.length], ["payment", "LOAD_CHANGED_AFTER_SEND", 1, 1], "§12 FAILS ON THE OLD DESIGN: a change after a send, at the next read: the mark, the stop, one notice, never re-sent");
		ok(w.notices.some((n) => n.title === "Sent invoice: load changed"), "§12 ...the notice, as today");

		// A POD row added: that load, at once.
		const p = makeWorld();
		const pj = await p.started();
		p.ready("LD-TEST-1102");
		tap(p, pj, "LD-TEST-1102");
		await drained(p, "§12 POD");
		p.now += MIN;
		p.addPod("LD-TEST-1102");
		pj.podChanged("LD-TEST-1102");
		await until(() => p.claim("LD-TEST-1102").changed_fields === "pods", "§12 POD change");
		eq([p.claim("LD-TEST-1102").changed_fields, ledger.getSendStop(p.db).reason, p.smtp.length], ["pods", "LOAD_CHANGED_AFTER_SEND", 1], "§12 FAILS ON THE OLD DESIGN: a POD upload checks that load at once: the stop, as today, never re-sent");

		// A stopped job still drafts the next driver's load.
		p.ready("LD-TEST-1103");
		tap(p, pj, "LD-TEST-1103");
		await drained(p, "§12 stopped");
		eq([p.state("LD-TEST-1103"), p.smtp.length, p.appends.length], [["drafted", ""], 1, 1], "§12 ...and the next driver's Delivered makes a Gmail draft");

		// A sheet failure at the check: no throw, and the next read catches it.
		const f = makeWorld();
		const fj = await f.started();
		f.ready("LD-TEST-1104");
		tap(f, fj, "LD-TEST-1104");
		await drained(f, "§12 failure");
		f.now += MIN;
		f.readFails = true;
		f.addPod("LD-TEST-1104");
		fj.podChanged("LD-TEST-1104");
		await until(() => f.logs.some((l) => /the check of the claims failed/.test(l)), "§12 logged");
		eq(f.claim("LD-TEST-1104").changed_fields, "", "§12 a sheet failure at the check: logged, nothing changed");
		f.readFails = false;
		f.now += 2 * MIN;
		served(fj, ["LD-TEST-1104"]);
		await until(() => f.claim("LD-TEST-1104").changed_fields === "pods", "§12 caught next");
		ok(true, "§12 ...and the next read catches the miss");

		// A person's draft closes an open claim at the read.
		const h = makeWorld();
		const hj = await h.started();
		h.ready("LD-TEST-1105", { "Job Status": "Delivered" });
		h.seed("LD-TEST-1105", { state: "needs_attention", reason_code: "HAND_DRAFT_IN_FLIGHT" });
		h.handDraft("LD-TEST-1105");
		served(hj, ["LD-TEST-1105"]);
		await until(() => h.state("LD-TEST-1105")[0] === "skipped", "§12 hand draft");
		eq(h.state("LD-TEST-1105"), ["skipped", "DRAFTED_BY_HAND"], "§12 FAILS ON THE OLD DESIGN: a person's draft closes the claim at the read");
		// A send that may have gone isn't closed while it is still being searched for.
		const m = makeWorld();
		const mj = await m.started();
		m.ready("LD-TEST-1106", { "Job Status": "Delivered" });
		m.seed("LD-TEST-1106", { state: "queued", reason_code: "SEND_UNCONFIRMED", stage: "appending", delivery: "send", invoice_id: "10202026-93", next_attempt_at: iso(m.now + HOUR) });
		m.handDraft("LD-TEST-1106");
		await mj.checkClaims();
		eq(m.claim("LD-TEST-1106").state, "queued", "§12 ...but never one a send is still being searched for");

		// L3: a check that began before a run finished reads a stale row, and must not stop sending.
		const r = makeWorld();
		const rj = await r.started();
		r.ready("LD-TEST-1107");
		const slow = gate();
		const staleRead = { headers: HEADERS, data: Object.freeze([Object.freeze({ ...r.row("LD-TEST-1107") })]) };
		const checking = (async () => {
			const job2 = r.job({ workerId: "worker-3", readJobTracking: async () => { await slow.p; return staleRead; } });
			job2.startTrigger();
			return job2.checkClaims();
		})();
		await turn();
		r.now += MIN;
		tap(r, rj, "LD-TEST-1107");
		await drained(r, "§12 run during the check");
		slow.open();
		await checking;
		eq([r.claim("LD-TEST-1107").changed_fields, ledger.getSendStop(r.db)], ["", null], "§12 FAILS ON THE OLD DESIGN (L3): a check begun before the tap reads the old status: no false change, no stop");

		// The read isn't a Super Admin's, or the mode isn't this one: nothing.
		const n = makeWorld();
		const nj = await n.started();
		const before = n.calls.reads;
		const rows = [{ "Load ID": "LD-TEST-1108", "Job Status": "Delivered" }];
		nj.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: false });
		await turn();
		eq([n.calls.reads, rows[0]._autoInvoice], [before, undefined], "§12 a Dispatcher's read: no check, no status");
	}

	section("§13 going back (R-M5)");
	{
		const OFF = { env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" } };
		const w = makeWorld();
		const job = await w.started();
		// A driver's tap that went out, and the loads the trigger left to people.
		w.ready("LD-TEST-1201");
		tap(w, job, "LD-TEST-1201");
		await drained(w, "§13 sent");
		// Marked by the office while the trigger ran: no claim.
		w.ready("LD-TEST-1202", { "Job Status": "Delivered" });
		// R-M5's case: a tap's write failed, the office marked it Delivered, a person billed it from Gmail.
		w.ready("LD-TEST-1203");
		tap(w, job, "LD-TEST-1203", { fails: true });
		await until(() => w.claim("LD-TEST-1203").reason_code === "NOT_COMPLETED", "§13 not landed");
		w.setRow("LD-TEST-1203", { "Job Status": "Delivered" });
		// The same, with no POD: no verdict would queue it on this tick, but a POD on a later one would.
		w.setRow("LD-TEST-1206", { "Job Status": "Delivered" });
		w.rateCons.set("ld-test-1206", BILLING);
		w.seed("LD-TEST-1206", { state: "waiting", reason_code: "NOT_COMPLETED" });
		// Only 30 minutes later: a restart this short is no gap for the sweep's own heartbeat.
		w.now += 30 * MIN;
		ledger.setMeta(w.db, "last_on_tick_at", iso(w.now - 10 * MIN));
		const smtpBefore = w.smtp.length;
		const sweep = w.job({ ...OFF, workerId: "worker-2" });
		eq([sweep.triggerMode, sweep.startTrigger()], [false, false], "§13 the flag off: the sweep is back");
		const out = await sweep.tick();
		ok(out.sweep && out.sweep.offGap === 3, "§13 FAILS ON THE OLD CODE: the first tick reads the loads it never claimed as OFF_GAP, whatever the time gap");
		eq(w.state("LD-TEST-1202"), ["needs_attention", "OFF_GAP"], "§13 FAILS ON THE OLD CODE: a completed load with no claim: a person, not a send");
		eq(w.state("LD-TEST-1203"), ["needs_attention", "OFF_GAP"], "§13 FAILS ON THE OLD DESIGN (R-M5's case): a `waiting` claim on a completed load: a person, never re-queued, not a send");
		eq(w.state("LD-TEST-1206"), ["needs_attention", "OFF_GAP"], "§13 FAILS ON THE OLD DESIGN (R-M5's case): ...with no POD yet too, so a later POD can't re-queue it");
		eq([w.smtp.length - smtpBefore, w.appends.length, ledger.getMeta(w.db).trigger_on_at, ledger.getMeta(w.db).back_from_trigger_at, ledger.getMeta(w.db).off_gap_since], [0, 0, "", "", ""], "§13 none is sent; the markers are cleared");
		ok(w.actions("auto_invoice_off_gap").length === 1, "§13 one audit row");
		// From the next tick on, the sweep is as it was.
		w.now += 5 * MIN;
		w.ready("LD-TEST-1204");
		w.setRow("LD-TEST-1204", { "Job Status": "Delivered" });
		await sweep.tick();
		eq([w.state("LD-TEST-1204"), w.smtp.length - smtpBefore], [["drafted", ""], 1], "§13 ...the next delivered load goes by the sweep, as before");
		// And switching on again is a first start again.
		w.seed("LD-TEST-1205", { state: "queued", next_attempt_at: iso(w.now) });
		w.ready("LD-TEST-1205", { "Job Status": "Delivered" });
		const again = w.job({ workerId: "worker-3" });
		again.startTrigger();
		eq(w.state("LD-TEST-1205"), ["needs_attention", "HANDED_OVER"], "§13 on again: a first start, the sweep's queue handed to a person");
	}

	section("§14 `waiting` is no dead end (R-M2)");
	{
		// A load that reads completed comes back `waiting` from the run: a person, with Try again.
		const w = makeWorld();
		const job = await w.started();
		w.setRow("LD-TEST-1301", { "Job Status": "At Receiver" });
		w.rateCons.set("ld-test-1301", BILLING);
		w.setRow("LD-TEST-1301", { "Job Status": "Delivered" });
		w.seed("LD-TEST-1301", { state: "queued", next_attempt_at: iso(w.now) });
		await job.runLine();
		await drained(w, "§14");
		eq(w.state("LD-TEST-1301"), ["needs_attention", "WAITING_POD"], "§14 FAILS ON THE OLD DESIGN: completed with no POD: a person, not `waiting`");
		w.addPod("LD-TEST-1301");
		eq((await tryAgain(job, "LD-TEST-1301")).status, 200, "§14 ...the POD uploaded, Try again works");
		await drained(w, "§14 again");
		eq([w.state("LD-TEST-1301"), w.smtp.length], [["drafted", ""], 1], "§14 ...one send");
		// A load off Delivered stays waiting, and a later tap arms it.
		const n = makeWorld();
		const nj = await n.started();
		n.ready("LD-TEST-1302");
		n.seed("LD-TEST-1302", { state: "queued", next_attempt_at: iso(n.now) });
		await nj.runLine();
		await drained(n, "§14 not completed");
		eq([n.state("LD-TEST-1302"), n.smtp.length], [["waiting", "NOT_COMPLETED"], 0], "§14 a load that doesn't read completed: `waiting`, nothing sent");
		tap(n, nj, "LD-TEST-1302");
		await drained(n, "§14 tap");
		eq([n.state("LD-TEST-1302"), n.smtp.length], [["drafted", ""], 1], "§14 ...a later tap arms it");
		// The sweep's own waits are as they were with the flag off (scripts/test-auto-invoice-job.js).
		eq(trigger.startUpAction({ state: "waiting", reason_code: "LOAD_DROPPED", updated_at: iso(T0) }, { first: true, nowMs: T0 }).action, "none", "§14 LOAD_DROPPED: left");
	}

	section("§15 the \"No automatic invoice\" chip");
	{
		const w = makeWorld();
		const job = await w.started();
		w.setRow("LD-TEST-1401", { "Job Status": "Delivered" });
		const chip = served(job, ["LD-TEST-1401"])[0];
		eq(chip, { state: "needs_attention", code: "NOT_BY_DRIVER", invoiceId: "", changed: [], trigger: true, retry: "none" }, "§15 FAILS ON THE OLD CODE: completed with no claim and no row: the chip, as Needs attention so the toggle counts it");
		w.handDraft("LD-TEST-1401");
		eq(served(job, ["LD-TEST-1401"]), [null], "§15 FAILS ON THE OLD CODE: ...it clears when a person drafts");
		w.setRow("LD-TEST-1402", { "Job Status": "Delivered" });
		w.seed("LD-TEST-1402", { state: "baseline" });
		eq(served(job, ["LD-TEST-1402"]), [null], "§15 never on a baseline row");
		w.seed("LD-TEST-1403", { state: "skipped", reason_code: "DRAFTED_BY_HAND" });
		eq(served(job, ["LD-TEST-1403"]), [null], "§15 ...nor a skipped one");
		// R L1: a load nobody bills by email.
		markFactored(w, "LD-TEST-1404");
		eq(served(job, ["LD-TEST-1404"]), [null], "§15 ...nor a factored load (the press is refused there)");
		w.db.prepare("UPDATE app_settings SET value = ? WHERE key = 'auto_invoice.settings'").run(JSON.stringify({ optOutDomains: [SEND_DOMAIN], confirmedBrokerDomains: [SEND_DOMAIN] }));
		eq(served(job, ["LD-TEST-1405"]), [null], "§15 ...nor an opted-out broker's");
		w.db.prepare("UPDATE app_settings SET value = ? WHERE key = 'auto_invoice.settings'").run(JSON.stringify({ optOutDomains: [], confirmedBrokerDomains: [SEND_DOMAIN] }));
		eq(served(job, ["LD-TEST-1406"], { "Completion Date": "01/05/2026 9:00:00" }), [null], "§15 ...nor a load from before the baseline's day");
		w.closed = () => ["2026-09"];
		eq(served(job, ["LD-TEST-1407"]), [null], "§15 ...nor a closed month's");
		w.closed = () => [];
		// R-H1: a `waiting` claim on a completed row.
		w.seed("LD-TEST-1408", { state: "waiting", reason_code: "NOT_COMPLETED" });
		eq(served(job, ["LD-TEST-1408"])[0].code, "NOT_BY_DRIVER", "§15 FAILS ON THE OLD DESIGN: a `waiting` claim on a completed row: the chip");
		// The other rows carry what Try again would do.
		w.seed("LD-TEST-1409", { state: "needs_attention", reason_code: "TOTAL_MISMATCH" });
		eq(served(job, ["LD-TEST-1409"])[0].retry, "send", "§15 Try again would send");
		ledger.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(w.now) });
		eq(served(job, ["LD-TEST-1409"])[0].retry, "draft", "§15 ...stopped, it would draft");
		w.seed("LD-TEST-1410", { state: "needs_attention", reason_code: "MAYBE_SENT", stage: "appending", delivery: "send" });
		eq(served(job, ["LD-TEST-1410"])[0].retry, "search", "§15 ...MAYBE_SENT, it only searches");
		w.seed("LD-TEST-1411", { state: "needs_attention", reason_code: "OFF_GAP" });
		eq(served(job, ["LD-TEST-1411"])[0].retry, "none", "§15 ...OFF_GAP: refused");

		// Off, shadow, or another role: no chip.
		const off = makeWorld();
		off.setRow("LD-TEST-1412", { "Job Status": "Delivered" });
		const offJob = off.job({ env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" } });
		eq(served(offJob, ["LD-TEST-1412"]), [null], "§15 the flag off: no chip, as today");
		off.seed("LD-TEST-1413", { state: "needs_attention", reason_code: "OFF_GAP" });
		eq(served(offJob, ["LD-TEST-1413"]), [{ state: "needs_attention", code: "OFF_GAP", invoiceId: "", changed: [] }], "§15 ...and a row's status as today, to the byte");
		const shadow = makeWorld();
		eq(served(shadow.job({ env: { AUTO_INVOICE_DRAFTS_ENABLED: "true" } }), ["LD-TEST-1414"]), [null], "§15 shadow: none");
	}

	section("§16 the module's own rules");
	{
		const t = trigger;
		eq([t.arms({ role: "Driver", oldStatus: "At Receiver", newStatus: "Delivered", claim: null }), t.arms({ role: "Driver", oldStatus: "Delivered", newStatus: "Delivered", claim: null }), t.arms({ role: "Driver", oldStatus: "Delivered", newStatus: "Delivered", claim: { state: "waiting" } }),
			t.arms({ role: "Dispatcher", oldStatus: "At Receiver", newStatus: "Delivered", claim: null }), t.arms({ role: "Driver", oldStatus: "At Receiver", newStatus: "In Transit", claim: null }), t.arms({ role: "Driver", oldStatus: "At Receiver", newStatus: "Delivered", claim: { state: "baseline" } })],
		[true, false, true, false, false, false], "§16 who arms it");
		for (const s of ["baseline", "drafted", "needs_attention", "skipped"]) eq(t.startUpAction({ state: s, updated_at: iso(T0) }, { first: true, nowMs: T0 }).action, "none", `§16 ${s}: start-up never touches it`);
		const SENDING = Object.freeze({ state: "working", delivery: "send", stage: "appending", updated_at: iso(T0 - 9 * HOUR) });
		eq([t.startUpAction(SENDING, { first: true, nowMs: T0 }).action, t.startUpAction(SENDING, { first: false, nowMs: T0 }).action, t.codeByStage(SENDING)], ["recover", "recover", "MAYBE_SENT"], "§16 a send that started only ever goes to recovery, however old");
		eq(t.codeByStage({ stage: "rendered" }), "DRAFT_FAILED", "§16 by stage: building");
		eq(t.codeByStage({ stage: "appending" }), "MAYBE_IN_GMAIL", "§16 by stage: a draft in flight");
		eq(t.codeByStage({ stage: "appended" }), "IN_GMAIL_UNRECORDED", "§16 by stage: appended");
		eq(t.overCap({ lastHour: 12, lastDay: 0, caps: rules.readCaps({}) }), true, "§16 the hourly cap");
		eq(t.overCap({ lastHour: 0, lastDay: 60, caps: rules.readCaps({}) }), true, "§16 the daily cap");
		eq(t.overCap({ lastHour: 11, lastDay: 59, caps: rules.readCaps({}) }), false, "§16 under both");
		eq([t.mailboxVerdict({ verdict: "clean" }), t.mailboxVerdict({ verdict: "invoice" }), t.mailboxVerdict({ verdict: "mention" })], [null, "MAILBOX_HIT", "MAILBOX_HIT"], "§16 clean only when the search says clean; any hit is doubt");
		for (const bad of [null, {}, { verdict: "" }, { verdict: "CLEAN" }, { invoice: 0, mention: 0 }]) eq(t.mailboxVerdict(bad), "MAILBOX_UNREAD", `§16 ${JSON.stringify(bad)}: unreadable, never "nothing found"`);
		ok(sendLib.claimSent({ delivery: "send", stage: "appending" }), "§16 a claim holding a send reads as sent (the Draft Invoice button's refusal)");

		// The send's commit is on disk before the SMTP call, whatever the connection's setting.
		const w = makeWorld();
		ledger.ensureSchema(w.db);
		w.seed("LD-TEST-1501", { state: "working", stage: "rendered", lease_owner: "me", invoice_id: "10202026-94" });
		const seen = [];
		const realPragma = w.db.pragma.bind(w.db);
		const realPrepare = w.db.prepare.bind(w.db);
		const realTx = w.db.transaction.bind(w.db);
		w.db.pragma = (text, opts) => { seen.push(text); return realPragma(text, opts); };
		w.db.transaction = (fn) => { seen.push("transaction"); return realTx(fn); };
		const answer = ledger.beginSend(w.db, "ld-test-1501", "me", { nowIso: iso(w.now) });
		w.db.prepare = realPrepare;
		w.db.pragma = realPragma;
		w.db.transaction = realTx;
		eq(answer, { ok: true }, "§16 beginSend() commits");
		eq(seen.filter((s) => /synchronous|transaction/.test(s)).slice(0, 3), ["synchronous", "synchronous = FULL", "transaction"], "§16 FAILS ON THE OLD CODE: FULL is set before the transaction opens (it can't change inside one)");
		ok(/^synchronous = \d$/.test(seen[seen.length - 1]), "§16 FAILS ON THE OLD CODE: ...and the connection's own setting is back after it");
		const noPragma = makeWorld();
		ledger.ensureSchema(noPragma.db);
		noPragma.seed("LD-TEST-1502", { state: "working", stage: "rendered", lease_owner: "me", invoice_id: "10202026-95" });
		noPragma.db.pragma = () => { throw new Error("made-up"); };
		eq(ledger.beginSend(noPragma.db, "ld-test-1502", "me", { nowIso: iso(noPragma.now) }), { ok: true }, "§16 a setting that can't be changed never holds a send up");
	}
}

main().catch((e) => failures.push(`threw: ${e && e.stack}`)).then(() => {
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
	process.exit(0);
});
