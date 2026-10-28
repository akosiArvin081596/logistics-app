#!/usr/bin/env node
// lib/auto-invoice-job.js: the automatic invoice-draft job, on made-up loads,
// with a fake engine (the prepare / render / record contract of
// lib/broker-invoice-draft.js), a fake Gmail and the server's invoice-number
// sequence on an in-memory database. The plan's cases:
//
//   §1  Delivered seen twice and on every sweep: one claim, one engine call, one
//       draft row, one number; the draft goes where the recipient rule says
//   §2  set back from Delivered after the draft: "changed" (status), one notice,
//       nothing voided; Delivered again: still one draft
//   §3  no POD: waiting, then drafted when it arrives; a POD row with no file:
//       a person (POD_UNREADABLE)
//   §4  the recipient rule: no billing email, another domain, a subdomain, a
//       sheet Email with no domain, Bison with no setting: a person, zero
//       numbers, zero Gmail; the job's own check catches an engine that lets one by
//   §5  Gmail says NO: retries at 15 min, 1 h, 4 h with the same number and date
//       (past midnight too), then DRAFT_FAILED; a hand draft then voids the number
//   §6  an append that times out after the message was sent: the search finds it
//       (recorded, no second append), or doesn't (same number again), or fails
//       (MAYBE_IN_GMAIL; "Try again" searches first)
//   §7  two workers on one database file; a crash at each stage, then a restart:
//       one append and one draft row each time
//   §8  flag off: no tables, no timers' work, no engine, routes 404 FEATURE_OFF
//   §9  the off gap: OFF_GAP for loads completed while off, ALREADY_DRAFTED for
//       one drafted by hand, one audit row, baseline untouched; a 30-minute
//       restart is no gap; a sheet outage is no gap
//   §10 the first baseline (soft-deleted and old loads included); closed or
//       unknown month; opted out; drafted by hand first; Gemini down (a wait,
//       not a person); RATECON_MISSING re-checks; Gmail login refused (a pause);
//       caps; a sheet outage uses no attempt; the cache is never written
//   §11 what Super Admins see: _autoInvoice in on mode only, never for a
//       Dispatcher; the routes (status, settings, checked, retry)
//
// No network, no files outside a temp folder, never reads app.db.
//   node scripts/test-auto-invoice-job.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const jobLib = require(path.join(ROOT, "lib", "auto-invoice-job.js"));
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const appTime = require(path.join(ROOT, "lib", "app-time.js"));
const { liftSheetHelpers } = require(path.join(ROOT, "scripts", "auto-invoice-shadow-report.js"));
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

const ET = "America/New_York";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-20T14:00:00Z"); // 10:00 Eastern
const { sheetDayKey } = liftSheetHelpers();
const UPLOADS = path.join(path.sep, "made-up", "uploads");
const HEADERS = Object.freeze(["Load ID", "Trailer Number", "Driver", "Drop-off Appointment", "Job Status", "Broker Contact Name", "Email",
	"Status Update Date", "Completion Date", "  Payment  "]);
const BROKER = "ops@example-broker.test";
const BISON = "ops-test@bisontransport.com";
const BISON_AP = "ap@example-bison-ap.test";
const MAILBOX = Object.freeze({ user: "drafts@example.com", pass: "made-up" });

// ------------------------------------------------------------------ the world
function serverTables(db) {
	db.exec(`
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
}

const never = () => new Promise(() => {});
const tick = () => new Promise((r) => setImmediate(r));
async function until(cond, label) {
	for (let i = 0; i < 200; i++) {
		if (cond()) return true;
		await tick();
	}
	failures.push(`${label}: the condition was never met`);
	return false;
}
const imapError = (message, stage, answered) => Object.assign(new Error(message), answered ? { stage, answered } : { stage });

function makeWorld({ dbFile = null } = {}) {
	const w = {
		now: T0,
		rows: [],
		files: new Set(),
		rateCons: new Map(), // load key -> the rate con's documents email ("" for none)
		gmail: [], // Message-IDs of the drafts in Gmail
		appendBehaviors: [],
		calls: { prepare: [], render: [], record: [], append: [], search: [], mint: [] },
		audits: [],
		notices: [],
		logs: [],
		bisonRecipient: BISON_AP,
		mailbox: MAILBOX,
		geminiDownAt: null,
		closed: () => [],
		searchFails: false,
		renderHang: false,
		recordHang: "",
		overrideTo: "",
		readFails: false,
		ids: 0,
	};
	w.db = dbFile ? new Database(dbFile) : new Database(":memory:");
	if (dbFile) w.db.pragma("busy_timeout = 2000");
	if (!dbFile || !w.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'documents'").get()) serverTables(w.db);
	w.jt = () => {
		w.reads = (w.reads || 0) + 1;
		if (w.readFails) throw new Error("made-up Sheets outage");
		return Object.freeze({ headers: HEADERS, data: Object.freeze([...w.rows]) });
	};
	w.setRow = (id, over = {}) => {
		const row = Object.freeze({
			"Load ID": id, "Trailer Number": "TR-1", Driver: "Made-up Driver", "Drop-off Appointment": "10/20/2026 8:00",
			"Job Status": "Delivered", "Broker Contact Name": "Made-up Agent", Email: BROKER,
			"Status Update Date": "10/20/2026 9:00:00", "Completion Date": "10/20/2026 9:00:00", "  Payment  ": "$1,000.00", ...over,
		});
		const i = w.rows.findIndex((r) => rules.loadKey(r["Load ID"]) === rules.loadKey(id));
		if (i >= 0) w.rows[i] = row; else w.rows.push(row);
	};
	w.addPod = (id, { file = true } = {}) => {
		const name = `pod-${rules.loadKey(id)}-${w.db.prepare("SELECT COUNT(*) n FROM documents").get().n}.pdf`;
		w.db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'POD', ?, ?, ?)").run(id, name, `/uploads/${name}`, "2026-10-20 13:00:00");
		if (file) w.files.add(name);
	};
	// A load ready to draft: delivered, its POD on file, a rate con naming a
	// billing email on the broker's own domain.
	w.ready = (id, over = {}, docEmail = "billing@example-broker.test") => {
		w.setRow(id, over);
		w.addPod(id);
		w.rateCons.set(rules.loadKey(id), docEmail);
	};
	w.handDraft = (id, invoiceId = "10202026-50") =>
		w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', 'imap', 'made-up-admin')")
			.run(id, invoiceId, "billing@example-broker.test");
	w.engine = {
		async prepare({ loadId, body, dryRun, mode }) {
			w.calls.prepare.push({ loadId, body, dryRun, mode });
			if (w.prepareHook) {
				const r = w.prepareHook(loadId);
				if (r) return r;
			}
			const key = rules.loadKey(loadId);
			const row = w.rows.find((r) => rules.loadKey(r["Load ID"]) === key);
			if (!row) return { ok: false, http: 404, code: "LOAD_NOT_FOUND" };
			if (!w.rateCons.has(key)) return { ok: false, http: 422, code: "RATECON_MISSING" };
			const rule = rules.recipientRule({ brokerEmail: row.Email, bisonRecipient: w.bisonRecipient, documentsEmail: w.rateCons.get(key) });
			if (!rule.ok) return { ok: false, http: 422, code: rule.code };
			return { ok: true, ctx: { loadId: row["Load ID"], to: w.overrideTo || rule.to } };
		},
		async render(ctx, opts) {
			w.calls.render.push({ loadId: ctx.loadId, ...opts });
			if (w.renderHang) return never();
			return { to: ctx.to, subject: `Made-up invoice ${opts.invoiceId}`, html: "<p>made-up</p>", attachments: [] };
		},
		async record(ctx, rendered, opts) {
			w.calls.record.push({ loadId: ctx && ctx.loadId, via: opts.via, invoiceId: opts.invoiceId, actor: opts.actor.username });
			if (w.recordHang === "before") return never();
			const r = w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', ?, ?)")
				.run(ctx.loadId, opts.invoiceId, rendered.to, opts.via, opts.actor.username);
			w.audits.push({ who: opts.actor.username, action: "invoice_draft_created", id: ctx.loadId, details: `${opts.invoiceId} (${opts.via})` });
			if (w.recordHang === "after") return never();
			return { draftRowId: r.lastInsertRowid };
		},
	};
	w.deps = (extra = {}) => ({
		db: w.db,
		env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", ...(extra.env || {}) },
		now: () => new Date(w.now),
		readJobTracking: async () => w.jt(),
		closedMonthsOf: (headers, row) => w.closed(row),
		dayKeyOf: sheetDayKey,
		uploadsRoot: UPLOADS,
		fileExists: (p) => w.files.has(path.basename(p)),
		engine: w.engine,
		nextInvoiceNumber: (date) => {
			w.calls.mint.push(date.toISOString());
			const [y, m, d] = appTime.dayInZone(date, ET).split("-");
			const day = `${m}${d}${y}`;
			const n = w.db.prepare("INSERT INTO bison_invoice_seq (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 RETURNING n").get(day).n;
			return `${day}-${n}`;
		},
		async appendGmailDraft(o) {
			w.calls.append.push({ to: o.to, subject: o.subject, messageId: o.messageId, user: o.user });
			const b = w.appendBehaviors.shift() || "OK";
			if (b === "OK") { w.gmail.push(o.messageId); return { ok: true }; }
			if (b === "NO") throw imapError("IMAP APPEND failed: a2 NO made-up", "literal", true);
			if (b === "LOGIN") throw imapError("IMAP LOGIN failed", "login", true);
			if (b === "BEFORE_LITERAL") throw imapError("IMAP timeout at stage 2", "append", false);
			if (b === "SENT_NO_ANSWER") { w.gmail.push(o.messageId); throw imapError("IMAP timeout at stage 3", "literal", false); }
			if (b === "LOST") throw imapError("IMAP timeout at stage 3", "literal", false);
			if (b === "CRASH_AFTER") { w.gmail.push(o.messageId); return never(); }
			if (b === "CRASH_BEFORE") return never();
			throw new Error(`unknown behaviour ${b}`);
		},
		async findDraftByMessageId({ messageId }) {
			w.calls.search.push(messageId);
			if (w.searchFails) throw imapError("IMAP SEARCH failed: made-up", "search", true);
			const n = w.gmail.filter((id) => id === messageId).length;
			return { found: n > 0, count: n };
		},
		newMessageId: () => `<made-up-${++w.ids}.auto-invoice@example.com>`,
		mailbox: () => w.mailbox,
		bisonRecipient: () => w.bisonRecipient,
		logAudit: (req, action, entity, id, details) => w.audits.push({ who: req.session.user.username, action, id, details }),
		notify: (n) => w.notices.push(n),
		geminiUnavailableAt: () => w.geminiDownAt,
		log: { warn: (m) => w.logs.push(m), error: (m) => w.logs.push(m) },
		timeZone: ET,
		workerId: "worker-1",
		...extra,
		...(extra.env ? { env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", ...extra.env } } : {}),
	});
	w.job = (extra = {}) => jobLib.create(w.deps(extra));
	w.claim = (id) => w.db.prepare("SELECT * FROM auto_invoice_claims WHERE load_key = ?").get(rules.loadKey(id)) || null;
	w.state = (id) => {
		const c = w.claim(id);
		return c ? [c.state, c.reason_code] : null;
	};
	w.draftRows = (id) => w.db.prepare("SELECT invoice_id, via FROM load_invoice_drafts WHERE LOWER(TRIM(load_id)) IN (?, ?) ORDER BY id").all(rules.loadKey(id), `#${rules.loadKey(id)}`);
	w.actions = (action) => w.audits.filter((a) => a.action === action);
	// A job past its first baseline (which leaves every load already delivered
	// to people), the clock moved on 5 minutes.
	w.started = async (extra = {}) => {
		const job = w.job(extra);
		await job.tick();
		w.now += 5 * MIN;
		return job;
	};
	return w;
}

// A tiny Express stand-in: the guard and handler chain of each route.
function fakeApp() {
	const routes = {};
	const add = (method) => (p, ...handlers) => { routes[`${method} ${p}`] = handlers; };
	const app = { get: add("GET"), put: add("PUT"), post: add("POST"), delete: add("DELETE") };
	const requireRole = (role) => (req, res, next) => (req.session && req.session.user && req.session.user.role === role ? next() : res.status(403).json({ error: "Forbidden" }));
	const call = async (method, p, { role = "Super Admin", params = {}, body = undefined } = {}) => {
		const handlers = routes[`${method} ${p}`];
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		const req = { params, body, session: { user: { id: 7, username: "made-up-admin", role } } };
		if (!handlers) return { status: 0, body: null };
		for (const h of handlers) {
			let nextCalled = false;
			await h(req, res, () => { nextCalled = true; });
			if (!nextCalled) break;
		}
		return out;
	};
	return { app, routes, requireRole, call };
}

async function main() {
	// ---------------------------------------------------------------- §1
	section("§1  one claim, one engine call, one draft, one number");
	{
		const w = makeWorld();
		w.ready("LD-TEST-0000"); // delivered before the switch-on: baseline
		const job = await w.started();
		eq(w.state("LD-TEST-0000"), ["baseline", ""], "§1 a load delivered before the first sweep is left to people");
		w.ready("LD-TEST-0001");
		w.rows.push(Object.freeze({ ...w.rows[w.rows.length - 1], "Load ID": "#LD-TEST-0001" })); // the sheet spells it twice
		await job.tick();
		await job.tick();
		w.now += 6 * MIN;
		await job.tick();
		eq(w.state("LD-TEST-0001"), ["drafted", ""], "§1 drafted");
		eq(w.calls.prepare.length, 1, "§1 one engine prepare across three sweeps");
		eq(w.calls.prepare[0], { loadId: "#LD-TEST-0001", body: {}, dryRun: false, mode: "auto" }, "§1 prepare in auto mode, no edits, not a dry run");
		eq(w.calls.mint.length, 1, "§1 one invoice number");
		eq(w.gmail.length, 1, "§1 one Gmail draft");
		eq(w.draftRows("LD-TEST-0001"), [{ invoice_id: "10202026-1", via: "auto-imap" }], "§1 one draft row, via auto-imap");
		const c = w.claim("LD-TEST-0001");
		eq([c.invoice_id, c.invoice_date, c.stage, c.message_id === w.gmail[0], c.lease_owner], ["10202026-1", "2026-10-20", "recorded", true, ""], "§1 the claim records the number, its day and the Message-ID");
		eq(w.calls.append[0] && [w.calls.append[0].to, w.calls.append[0].user], ["billing@example-broker.test", MAILBOX.user], "§1 the draft goes to the rate con's billing email on the broker's domain");
		eq(w.actions("invoice_draft_created").map((a) => a.who), ["auto-invoice"], "§1 the draft is audited as the auto-invoice system actor");
		ok(!w.logs.some((l) => /@/.test(l)), "§1 no email address in the logs");
	}

	// ---------------------------------------------------------------- §2
	section("§2  set back from Delivered after the draft");
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0002");
		await job.tick();
		eq(w.state("LD-TEST-0002"), ["drafted", ""], "§2 drafted");
		w.setRow("LD-TEST-0002", { "Job Status": "In Transit", "Completion Date": "" });
		await job.tick();
		await job.tick();
		const c = w.claim("LD-TEST-0002");
		eq([c.state, c.changed_fields], ["drafted", "status"], "§2 changed: status");
		eq(w.notices.length, 1, "§2 one notice, however many sweeps");
		eq(w.actions("auto_invoice_load_changed").length, 1, "§2 one audit row");
		eq(w.actions("auto_invoice_number_void").length, 0, "§2 nothing voided");
		w.setRow("LD-TEST-0002", { "Job Status": "Delivered" });
		w.setRow("LD-TEST-0002", { "  Payment  ": "$1,250.00" });
		await job.tick();
		eq([w.claim("LD-TEST-0002").changed_fields, w.notices.length], ["payment", 2], "§2 a new set of changes: one more notice");
		eq([w.calls.prepare.length, w.gmail.length, w.draftRows("LD-TEST-0002").length], [1, 1, 1], "§2 Delivered again: still one draft");
	}

	// ---------------------------------------------------------------- §3
	section("§3  the POD");
	{
		const w = makeWorld();
		const job = await w.started();
		w.setRow("LD-TEST-0003");
		w.rateCons.set("ld-test-0003", "billing@example-broker.test");
		await job.tick();
		eq(w.state("LD-TEST-0003"), ["waiting", "WAITING_POD"], "§3 no POD: waiting");
		eq(w.calls.prepare.length, 0, "§3 nothing spent while waiting");
		w.addPod("LD-TEST-0003");
		await job.tick();
		eq(w.state("LD-TEST-0003"), ["drafted", ""], "§3 the POD arrives: drafted");
		w.setRow("LD-TEST-0004");
		w.addPod("LD-TEST-0004", { file: false });
		await job.tick();
		eq(w.state("LD-TEST-0004"), ["needs_attention", "POD_UNREADABLE"], "§3 a POD row with no readable file: a person");
		w.setRow("LD-TEST-0005");
		w.db.prepare("INSERT INTO documents (load_id, type, file_name, drive_file_id) VALUES (?, 'POD', 'remote.pdf', 'drv-made-up')").run("LD-TEST-0005");
		w.rateCons.set("ld-test-0005", "billing@example-broker.test");
		await job.tick();
		eq(w.state("LD-TEST-0005"), ["drafted", ""], "§3 a POD only in Drive counts as readable (the engine fetches it)");
	}

	// ---------------------------------------------------------------- §4
	section("§4  the recipient rule");
	{
		const w = makeWorld();
		const job = await w.started();
		const cases = [
			["LD-TEST-0041", {}, "", "NO_BILLING_EMAIL"],
			["LD-TEST-0042", {}, "ap@example-factor.test", "RECIPIENT_DOMAIN_MISMATCH"],
			["LD-TEST-0043", {}, "billing@ap.example-broker.test", "RECIPIENT_DOMAIN_MISMATCH"],
			["LD-TEST-0044", { Email: "Ops desk" }, "billing@example-broker.test", "NO_BROKER_EMAIL"],
		];
		for (const [id, over, docEmail] of cases) w.ready(id, over, docEmail);
		w.bisonRecipient = "";
		w.ready("LD-TEST-0045", { Email: BISON }, "");
		w.ready("LD-TEST-0046", {}, "billing@example-broker.test");
		w.now += MIN;
		for (let i = 0; i < 4; i++) await job.tick();
		for (const [id, , , code] of cases) eq(w.state(id), ["needs_attention", code], `§4 ${id.slice(-4)}: ${code}`);
		eq(w.state("LD-TEST-0045"), ["needs_attention", "RECIPIENT_UNCONFIGURED"], "§4 Bison with no recipient setting: a person");
		eq(w.state("LD-TEST-0046"), ["drafted", ""], "§4 the broker's own domain: drafted");
		eq([w.calls.mint.length, w.gmail.length], [1, 1], "§4 refused loads used no number and reached no Gmail");
		w.bisonRecipient = BISON_AP;
		w.ready("LD-TEST-0047", { Email: BISON }, "billing@example-factor.test");
		await job.tick();
		eq(w.state("LD-TEST-0047"), ["drafted", ""], "§4 Bison with its setting: drafted");
		eq(w.calls.append[w.calls.append.length - 1].to, BISON_AP, "§4 to Bison's setting, never the rate con's address");
		w.overrideTo = "ap@example-factor.test";
		w.ready("LD-TEST-0048");
		await job.tick();
		eq(w.state("LD-TEST-0048"), ["needs_attention", "RECIPIENT_DOMAIN_MISMATCH"], "§4 an engine that resolved another domain is caught by the job's own check");
		eq([w.calls.mint.length, w.gmail.length], [2, 2], "§4 and no number or Gmail draft was spent on it");
	}

	// ---------------------------------------------------------------- §5
	section("§5  Gmail says NO");
	{
		const w = makeWorld();
		w.now = Date.parse("2026-10-20T22:00:00Z"); // 18:00 Eastern
		const job = await w.started();
		w.ready("LD-TEST-0050");
		w.appendBehaviors = ["NO", "NO", "NO", "NO"];
		await job.tick();
		const c1 = w.claim("LD-TEST-0050");
		eq([c1.state, c1.reason_code, c1.attempts, c1.next_attempt_at], ["queued", "RETRY_LATER", 1, new Date(w.now + 15 * MIN).toISOString()], "§5 1st NO: again in 15 min");
		w.now += 15 * MIN;
		await job.tick();
		eq([w.claim("LD-TEST-0050").attempts, w.claim("LD-TEST-0050").next_attempt_at], [2, new Date(w.now + HOUR).toISOString()], "§5 2nd NO: again in 1 h");
		w.now += HOUR;
		await job.tick();
		eq([w.claim("LD-TEST-0050").attempts, w.claim("LD-TEST-0050").next_attempt_at], [3, new Date(w.now + 4 * HOUR).toISOString()], "§5 3rd NO: again in 4 h (past midnight)");
		w.now += 4 * HOUR;
		await job.tick();
		eq(w.state("LD-TEST-0050"), ["needs_attention", "DRAFT_FAILED"], "§5 4th NO: a person");
		eq(w.calls.mint.length, 1, "§5 one number for all four tries");
		eq([...new Set(w.calls.render.map((r) => `${r.invoiceId} ${r.invoiceDate}`))], ["10202026-1 2026-10-20"], "§5 every try printed the same number and date, the last one after midnight");
		eq(w.gmail.length, 0, "§5 no draft in Gmail");
		w.handDraft("LD-TEST-0050", "10212026-1");
		await job.tick();
		eq(w.state("LD-TEST-0050"), ["skipped", "DRAFTED_BY_HAND"], "§5 drafted by hand: skipped");
		eq(w.actions("auto_invoice_number_void").map((a) => a.details), ["10202026-1 was reserved for this load and never used (DRAFTED_BY_HAND)"], "§5 the reserved number is audited void");
		ok(w.claim("LD-TEST-0050").number_voided_at, "§5 and marked void on the claim");
	}

	// ---------------------------------------------------------------- §6
	section("§6  an append with no answer after the message was sent");
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0061");
		w.appendBehaviors = ["SENT_NO_ANSWER"];
		await job.tick();
		eq(w.state("LD-TEST-0061"), ["drafted", ""], "§6 the search finds the draft: drafted");
		eq([w.calls.append.length, w.calls.search.length, w.gmail.length, w.draftRows("LD-TEST-0061").length], [1, 1, 1, 1], "§6 recorded without a second append");

		w.ready("LD-TEST-0062");
		w.appendBehaviors = ["LOST"];
		await job.tick();
		const lost = w.claim("LD-TEST-0062");
		eq([lost.state, lost.stage, lost.attempts], ["queued", "reserved", 1], "§6 not found: queued again, number kept");
		w.now += 15 * MIN;
		await job.tick();
		eq(w.state("LD-TEST-0062"), ["drafted", ""], "§6 the retry drafts it");
		const tries = w.calls.render.filter((r) => r.loadId === "LD-TEST-0062").map((r) => r.invoiceId);
		eq([tries.length, new Set(tries).size, w.draftRows("LD-TEST-0062").length], [2, 1, 1], "§6 with the same number, one draft row");

		w.ready("LD-TEST-0063");
		w.appendBehaviors = ["LOST"];
		w.searchFails = true;
		await job.tick();
		const maybe = w.claim("LD-TEST-0063");
		eq([maybe.state, maybe.reason_code, maybe.stage], ["needs_attention", "MAYBE_IN_GMAIL", "appending"], "§6 the search fails: a person (MAYBE_IN_GMAIL)");
		const { app, requireRole, call } = fakeApp();
		job.mount(app, { requireRole });
		w.searchFails = false;
		const retry = await call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "LD-TEST-0063" } });
		eq(retry.status, 200, "§6 Try again");
		const appendsBefore = w.calls.append.length;
		await job.tick();
		eq(w.calls.search.slice(-1)[0], maybe.message_id, "§6 Try again searches Gmail first");
		eq(w.state("LD-TEST-0063"), ["drafted", ""], "§6 then, not found, drafts it");
		eq([w.calls.append.length - appendsBefore, w.claim("LD-TEST-0063").invoice_id], [1, maybe.invoice_id], "§6 one more append, the same number");
	}

	// ---------------------------------------------------------------- §7
	section("§7  two workers, and a crash at each stage");
	const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "auto-invoice-job-"));
	try {
		const file = path.join(TMP, "app.db");
		const w = makeWorld({ dbFile: file });
		w.db.pragma("journal_mode = WAL");
		const jobA = await w.started({ workerId: "worker-a" });
		const dbB = new Database(file);
		dbB.pragma("busy_timeout = 2000");
		const jobB = jobLib.create({ ...w.deps({ workerId: "worker-b" }), db: dbB });
		w.ready("LD-TEST-0070");
		w.ready("LD-TEST-0071");
		await Promise.all([jobA.tick(), jobB.tick(), jobA.tick(), jobB.tick()]);
		eq([w.state("LD-TEST-0070"), w.state("LD-TEST-0071")], [["drafted", ""], ["drafted", ""]], "§7 two workers: both loads drafted");
		eq([w.gmail.length, w.draftRows("LD-TEST-0070").length, w.draftRows("LD-TEST-0071").length, w.calls.mint.length], [2, 1, 1, 2], "§7 one append, one draft row and one number per load");
		dbB.close();
		w.db.close();
	} finally {
		fs.rmSync(TMP, { recursive: true, force: true });
	}
	const crash = async (label, setup, wantStage, check) => {
		const w = makeWorld();
		const before = await w.started({ workerId: "before-crash" });
		w.ready("LD-TEST-0072");
		setup(w);
		before.tick();
		await until(() => (w.claim("LD-TEST-0072") || {}).stage === wantStage && (w.claim("LD-TEST-0072") || {}).state === "working", `§7 ${label}: the claim reaches ${wantStage}`);
		await tick();
		w.renderHang = false;
		w.recordHang = "";
		w.now += 16 * MIN; // the lease has run out
		const after = w.job({ workerId: "after-restart" });
		await after.tick();
		eq(w.state("LD-TEST-0072"), ["drafted", ""], `§7 crash at ${label}: drafted after the restart`);
		eq([w.gmail.length, w.draftRows("LD-TEST-0072").length, new Set(w.calls.render.map((r) => r.invoiceId)).size], [1, 1, 1], `§7 crash at ${label}: one append, one draft row, one number`);
		if (check) check(w);
	};
	await crash("reserved (the render never returned)", (w) => { w.renderHang = true; }, "reserved");
	await crash("appending, the draft made", (w) => { w.appendBehaviors = ["CRASH_AFTER"]; }, "appending",
		(w) => eq([w.calls.search.length, w.calls.append.length], [1, 1], "§7 appending, made: found by the search, never appended again"));
	await crash("appending, the draft not made", (w) => { w.appendBehaviors = ["CRASH_BEFORE"]; }, "appending",
		(w) => eq([w.calls.search.length, w.calls.append.length], [1, 2], "§7 appending, not made: searched, then appended once more"));
	await crash("appended (record never ran)", (w) => { w.recordHang = "before"; }, "appended",
		(w) => eq(w.calls.prepare.length, 2, "§7 appended: the engine rebuilt what it records"));
	await crash("recorded (the row written, then the crash)", (w) => { w.recordHang = "after"; }, "appended",
		(w) => eq(w.calls.record.length, 1, "§7 recorded: the row already there is used, record isn't called again"));

	// ---------------------------------------------------------------- §8
	section("§8  flag off");
	for (const env of [{}, { AUTO_INVOICE_DRAFTS_ENABLED: "1", AUTO_INVOICE_DRAFTS_SHADOW: "false" }]) {
		const w = makeWorld();
		const tablesBefore = w.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all();
		w.ready("LD-TEST-0080");
		const job = jobLib.create({ ...w.deps(), env });
		eq(job.mode, "off", `§8 ${JSON.stringify(env)}: off`);
		const out = await job.tick();
		eq(out, { mode: "off" }, "§8 a tick does nothing");
		eq(w.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all(), tablesBefore, "§8 no table was created");
		eq([w.reads || 0, w.calls.prepare.length, w.calls.mint.length, w.calls.append.length], [0, 0, 0, 0], "§8 no sheet read, engine, number or Gmail");
		const rows = [{ "Load ID": "LD-TEST-0080" }];
		job.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: true });
		eq(rows, [{ "Load ID": "LD-TEST-0080" }], "§8 the dashboard rows are untouched");
		const { app, requireRole, call } = fakeApp();
		job.mount(app, { requireRole });
		for (const [m, p] of [["GET", "/api/auto-invoice/status"], ["GET", "/api/auto-invoice/settings"], ["PUT", "/api/auto-invoice/settings"],
			["POST", "/api/auto-invoice/loads/:loadKey/checked"], ["POST", "/api/auto-invoice/loads/:loadKey/retry"]]) {
			const r = await call(m, p, { params: { loadKey: "LD-TEST-0080" }, body: { optOutDomains: [] } });
			eq([r.status, r.body && r.body.code], [404, "FEATURE_OFF"], `§8 ${m} ${p}: 404 FEATURE_OFF`);
		}
	}

	// ---------------------------------------------------------------- §9
	section("§9  the off gap");
	{
		const w = makeWorld();
		const job = await w.started();
		const baselineAt = w.db.prepare("SELECT value FROM auto_invoice_meta WHERE key = 'baseline_at'").get().value;
		await job.tick();
		w.now += 3 * HOUR; // off for 3 hours
		w.ready("LD-TEST-0090");
		w.ready("LD-TEST-0091");
		w.handDraft("LD-TEST-0091");
		const back = w.job();
		await back.tick();
		eq(w.state("LD-TEST-0090"), ["needs_attention", "OFF_GAP"], "§9 completed while off: draft by hand (OFF_GAP)");
		eq(w.state("LD-TEST-0091"), ["skipped", "ALREADY_DRAFTED"], "§9 already drafted by hand: skipped, before OFF_GAP");
		eq(w.actions("auto_invoice_off_gap").length, 1, "§9 one off-gap audit row");
		ok(/^1 load completed while automatic drafts were off \(\S+ to \S+\): draft by hand$/.test((w.actions("auto_invoice_off_gap")[0] || {}).details || ""), "§9 with its count and the gap's start and end");
		eq(w.notices.length, 1, "§9 one notice");
		eq([w.db.prepare("SELECT COUNT(*) n FROM auto_invoice_claims WHERE state = 'baseline'").get().n,
			w.db.prepare("SELECT value FROM auto_invoice_meta WHERE key = 'baseline_at'").get().value], [0, baselineAt], "§9 no new baseline rows; baseline_at unchanged");
		eq(w.calls.prepare.length, 0, "§9 nothing drafted for them");
		w.now += 30 * MIN; // a 30-minute restart
		w.ready("LD-TEST-0092");
		await w.job().tick();
		eq(w.state("LD-TEST-0092"), ["drafted", ""], "§9 a 30-minute restart is no gap: drafted");
		w.now += 5 * MIN;
		w.readFails = true;
		const outage = w.job();
		for (let i = 0; i < 30; i++) { await outage.tick(); w.now += 5 * MIN; }
		w.readFails = false;
		w.ready("LD-TEST-0093");
		await outage.tick();
		eq(w.state("LD-TEST-0093"), ["drafted", ""], "§9 a 2.5-hour sheet outage while on is no gap");
		await makeWorldShadowThenOn(w);
	}

	// ---------------------------------------------------------------- §10
	section("§10 baseline, months, opt-outs, Gemini, rate cons, pauses, caps");
	{
		const w = makeWorld();
		w.ready("LD-TEST-0100");
		w.ready("LD-TEST-0101", { "Job Status": "Delivered" });
		w.db.prepare("INSERT INTO deleted_loads (load_id) VALUES ('#ld-test-0101')").run();
		w.setRow("LD-TEST-0102", { "Job Status": "In Transit" });
		const job = await w.started();
		eq([w.state("LD-TEST-0100"), w.state("LD-TEST-0101"), w.state("LD-TEST-0102")], [["baseline", ""], ["baseline", ""], null], "§10 the first baseline: every completed load, soft-deleted too; not the open ones");
		eq(w.actions("auto_invoice_baseline").map((a) => a.details), ["2 completed loads left to people (baseline)"], "§10 one baseline audit row with its count");
		w.ready("LD-TEST-0103", { "Completion Date": "10/01/2026 9:00:00" });
		w.setRow("LD-TEST-0102", { "Job Status": "Delivered", "Completion Date": "10/20/2026 9:00:00" });
		w.addPod("LD-TEST-0102");
		w.rateCons.set("ld-test-0102", "billing@example-broker.test");
		w.closed = (row) => (row["Load ID"] === "LD-TEST-0104" ? ["2026-09"] : row["Load ID"] === "LD-TEST-0105" ? null : []);
		w.ready("LD-TEST-0104");
		w.ready("LD-TEST-0105");
		w.ready("LD-TEST-0106", { Email: "ap@example-optout.test" }, "billing@example-optout.test");
		w.db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?)").run(JSON.stringify({ optOutDomains: ["example-optout.test"] }));
		w.ready("LD-TEST-0107");
		w.handDraft("LD-TEST-0107");
		w.ready("LD-TEST-0108");
		w.db.prepare("INSERT INTO broker_invoice_lines (load_id, load_key) VALUES ('LD-TEST-0108', 'ld-test-0108')").run();
		w.ready("LD-TEST-0109", { "Status Update Date": "", "Completion Date": "", "Drop-off Appointment": "" });
		await job.tick();
		eq(w.state("LD-TEST-0103"), ["baseline", ""], "§10 completed on a day before the baseline: baseline");
		eq(w.state("LD-TEST-0102"), ["drafted", ""], "§10 a load open at the baseline and delivered after it: drafted");
		eq(w.state("LD-TEST-0104"), ["needs_attention", "CLOSED_MONTH"], "§10 a closed month: a person");
		eq(w.state("LD-TEST-0105"), ["needs_attention", "MONTH_UNKNOWN"], "§10 a month that can't be told: a person");
		eq(w.state("LD-TEST-0106"), ["skipped", "BROKER_OPTED_OUT"], "§10 an opted-out broker: skipped");
		eq(w.state("LD-TEST-0107"), ["skipped", "ALREADY_DRAFTED"], "§10 drafted by hand first: skipped");
		eq(w.state("LD-TEST-0108"), ["needs_attention", "ADVANCE_LINES"], "§10 an advance line: a person");
		eq(w.state("LD-TEST-0109"), ["needs_attention", "NO_DELIVERY_DATE"], "§10 no delivery date: a person");
	}
	{
		const w = makeWorld();
		const job = await w.started();
		w.geminiDownAt = w.now - 10 * MIN;
		w.ready("LD-TEST-0110");
		w.ready("LD-TEST-0111", { Email: BISON }, "");
		await job.tick();
		const g = w.claim("LD-TEST-0110");
		eq([g.state, g.reason_code, g.attempts, g.next_attempt_at], ["queued", "GEMINI_DOWN", 0, new Date(w.now + 30 * MIN).toISOString()], "§10 Gemini down: a non-Bison load waits 30 min, no attempt used");
		eq(w.state("LD-TEST-0111"), ["drafted", ""], "§10 a Bison load is drafted meanwhile");
		eq(w.calls.prepare.map((p) => p.loadId), ["LD-TEST-0111"], "§10 the waiting load cost nothing");
		w.geminiDownAt = null;
		w.prepareHook = (id) => (id === "LD-TEST-0110" ? { ok: false, http: 422, code: "TOTAL_MISMATCH", geminiUnavailable: true } : null);
		w.now += 30 * MIN;
		await job.tick();
		eq([w.claim("LD-TEST-0110").state, w.claim("LD-TEST-0110").reason_code, w.claim("LD-TEST-0110").attempts], ["queued", "GEMINI_DOWN", 0], "§10 a refusal reached while Gemini was down is temporary");
		w.prepareHook = null;
		w.now += 30 * MIN;
		await job.tick();
		eq(w.state("LD-TEST-0110"), ["drafted", ""], "§10 then drafted");
	}
	{
		const w = makeWorld();
		const job = await w.started();
		w.setRow("LD-TEST-0120");
		w.addPod("LD-TEST-0120");
		const seen = [];
		for (let i = 0; i < 4; i++) {
			await job.tick();
			const c = w.claim("LD-TEST-0120");
			seen.push([c.state, c.reason_code, c.ratecon_checks]);
			w.now += 2 * HOUR;
		}
		eq(seen, [["waiting", "RATECON_MISSING", 1], ["waiting", "RATECON_MISSING", 2], ["waiting", "RATECON_MISSING", 3], ["needs_attention", "RATECON_MISSING", 4]],
			"§10 no rate con: re-checked every 2 hours, three times, then a person");
		eq(w.calls.mint.length, 0, "§10 no number for it");
		w.now -= 2 * HOUR;
		w.setRow("LD-TEST-0121");
		w.addPod("LD-TEST-0121");
		await job.tick();
		w.now += HOUR;
		await job.tick();
		eq([w.claim("LD-TEST-0121").ratecon_checks, w.calls.prepare.filter((p) => p.loadId === "LD-TEST-0121").length], [1, 1], "§10 no re-check before its 2 hours");
	}
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0130");
		w.appendBehaviors = ["LOGIN"];
		await job.tick();
		const meta = () => Object.fromEntries(w.db.prepare("SELECT key, value FROM auto_invoice_meta").all().map((r) => [r.key, r.value]));
		eq([meta().paused_until, meta().pause_reason], [new Date(w.now + HOUR).toISOString(), "IMAP_LOGIN_REFUSED"], "§10 Gmail refuses the login: paused 1 h");
		eq([w.claim("LD-TEST-0130").state, w.claim("LD-TEST-0130").reason_code, w.claim("LD-TEST-0130").attempts], ["queued", "MAILBOX_PAUSED", 0], "§10 the load waits, no attempt used");
		eq(w.notices.map((n) => n.title), ["Automatic invoice drafts paused"], "§10 one notice");
		w.now += 30 * MIN;
		const out = await job.tick();
		eq([out.work.started, out.work.paused], [0, "IMAP_LOGIN_REFUSED"], "§10 nothing tried while paused");
		w.now += 31 * MIN;
		w.appendBehaviors = ["LOGIN"];
		await job.tick();
		eq(meta().paused_until, new Date(w.now + 2 * HOUR).toISOString(), "§10 refused again: 2 h");
		w.now += 2 * HOUR + MIN;
		await job.tick();
		eq([w.state("LD-TEST-0130"), meta().pause_ms], [["drafted", ""], ""], "§10 then drafted, and the pause resets");
		w.mailbox = { user: "", pass: "" };
		w.ready("LD-TEST-0131");
		const noBox = await job.tick();
		eq([noBox.work.paused, w.state("LD-TEST-0131")], ["NO_MAILBOX", ["queued", ""]], "§10 no mailbox: nothing drafted, the load stays queued");
		eq(w.logs.filter((l) => /no mailbox/.test(l)).length, 1, "§10 logged once");
		await job.tick();
		eq(w.logs.filter((l) => /no mailbox/.test(l)).length, 1, "§10 still once");
	}
	{
		const w = makeWorld();
		const job = await w.started({ env: { AUTO_INVOICE_MAX_PER_HOUR: "1" } });
		for (const id of ["LD-TEST-0140", "LD-TEST-0141"]) w.ready(id);
		await job.tick();
		eq(w.db.prepare("SELECT COUNT(*) n FROM auto_invoice_claims WHERE state = 'drafted'").get().n, 1, "§10 one an hour: one drafted");
		w.now += 61 * MIN;
		await job.tick();
		eq(w.db.prepare("SELECT COUNT(*) n FROM auto_invoice_claims WHERE state = 'drafted'").get().n, 2, "§10 the next an hour later");
		const w2 = makeWorld();
		const job2 = await w2.started();
		for (const id of ["LD-TEST-0142", "LD-TEST-0143", "LD-TEST-0144"]) w2.ready(id);
		await job2.tick();
		eq(w2.db.prepare("SELECT COUNT(*) n FROM auto_invoice_claims WHERE state = 'drafted'").get().n, 2, "§10 two a sweep");
		w2.readFails = true;
		w2.now += 5 * MIN;
		const r = await job2.tick();
		eq([r.sweep.error, r.work], ["SWEEP_FAILED", undefined], "§10 the sheet can't be read: no sweep and no drafting");
		eq(w2.claim("LD-TEST-0144").attempts, 0, "§10 and no attempt used");
		w2.readFails = false;
		await job2.tick();
		eq(w2.state("LD-TEST-0144"), ["drafted", ""], "§10 drafted once the sheet is back");
	}

	// ---------------------------------------------------------------- §11
	section("§11 what Super Admins see");
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0150");
		w.setRow("LD-TEST-0151");
		w.ready("LD-TEST-0152", {}, "ap@example-factor.test");
		await job.tick();
		const rowsFor = () => w.rows.map((r) => ({ ...r }));
		const dispatcher = rowsFor();
		job.annotateCompletedRows({ rows: dispatcher, headers: HEADERS, isSuperAdmin: false });
		ok(dispatcher.every((r) => !("_autoInvoice" in r)), "§11 a Dispatcher's rows get nothing");
		const admin = rowsFor();
		job.annotateCompletedRows({ rows: admin, headers: HEADERS, isSuperAdmin: true });
		const by = Object.fromEntries(admin.map((r) => [r["Load ID"], r._autoInvoice]));
		eq(by["LD-TEST-0150"], { state: "drafted", code: "", invoiceId: "10202026-1", changed: [] }, "§11 drafted, with its number");
		eq(by["LD-TEST-0151"], { state: "waiting", code: "WAITING_POD", invoiceId: "", changed: [] }, "§11 waiting for the POD");
		eq(by["LD-TEST-0152"], { state: "needs_attention", code: "RECIPIENT_DOMAIN_MISMATCH", invoiceId: "", changed: [] }, "§11 needs attention, with its code");
		ok(w.rows.every((r) => !("_autoInvoice" in r)), "§11 the cached rows are never written");
		const shadowJob = jobLib.create({ ...w.deps(), env: { AUTO_INVOICE_DRAFTS_ENABLED: "true" } });
		const shadowRows = rowsFor();
		shadowJob.annotateCompletedRows({ rows: shadowRows, headers: HEADERS, isSuperAdmin: true });
		ok(shadowRows.every((r) => !("_autoInvoice" in r)), "§11 shadow mode shows nothing");

		const { app, routes, requireRole, call } = fakeApp();
		job.mount(app, { requireRole, refuseCrossSite: (req, res, next) => next() });
		eq(Object.keys(routes).sort(), ["GET /api/auto-invoice/settings", "GET /api/auto-invoice/status", "POST /api/auto-invoice/loads/:loadKey/checked",
			"POST /api/auto-invoice/loads/:loadKey/retry", "PUT /api/auto-invoice/settings"], "§11 five routes");
		for (const [m, p] of Object.keys(routes).map((k) => k.split(" "))) {
			const r = await call(m, p, { role: "Dispatcher", params: { loadKey: "LD-TEST-0150" }, body: {} });
			eq(r.status, 403, `§11 ${m} ${p}: a Dispatcher is refused`);
		}
		const st = await call("GET", "/api/auto-invoice/status");
		eq([st.status, st.body.mode, st.body.counts.drafted, st.body.counts.needs_attention, st.body.mailbox], [200, "on", 1, 1, true], "§11 status: mode and counts");
		ok(!JSON.stringify(st.body).includes("@"), "§11 status carries no address");
		const bad = await call("PUT", "/api/auto-invoice/settings", { body: { optOutDomains: ["not a domain"] } });
		eq([bad.status, bad.body.code], [400, "OPT_OUT_INVALID"], "§11 a bad opt-out list is refused");
		const put = await call("PUT", "/api/auto-invoice/settings", { body: { optOutDomains: ["Example-Factor.test"] } });
		eq([put.status, put.body], [200, { optOutDomains: ["example-factor.test"] }], "§11 opt-outs saved");
		eq((await call("GET", "/api/auto-invoice/settings")).body, { optOutDomains: ["example-factor.test"] }, "§11 and read back");
		eq(w.actions("update_auto_invoice_settings").map((a) => [a.who, a.details]), [["made-up-admin", "opted out: example-factor.test (was: none)"]], "§11 audited as the Super Admin");

		w.setRow("LD-TEST-0150", { "  Payment  ": "$1,100.00" });
		await job.tick();
		eq(w.claim("LD-TEST-0150").changed_fields, "payment", "§11 the drafted load changed");
		const notDrafted = await call("POST", "/api/auto-invoice/loads/:loadKey/checked", { params: { loadKey: "LD-TEST-0152" } });
		eq([notDrafted.status, notDrafted.body.code], [409, "AUTO_INVOICE_NOT_DRAFTED"], "§11 Mark checked needs a draft");
		const missing = await call("POST", "/api/auto-invoice/loads/:loadKey/checked", { params: { loadKey: "LD-TEST-9999" } });
		eq([missing.status, missing.body.code], [404, "AUTO_INVOICE_NOT_FOUND"], "§11 an unknown load: 404");
		const checked = await call("POST", "/api/auto-invoice/loads/:loadKey/checked", { params: { loadKey: "%23LD-TEST-0150" } });
		eq(checked.status, 200, "§11 Mark checked ('#id' works too)");
		const cc = w.claim("LD-TEST-0150");
		eq([cc.changed_fields, cc.changed_at, cc.checked_by], ["", "", "made-up-admin"], "§11 the flag clears");
		await job.tick();
		eq(w.claim("LD-TEST-0150").changed_fields, "", "§11 and that point is the new reference");
		eq(w.actions("auto_invoice_checked").map((a) => a.details), ["10202026-1: checked (changed: payment)"], "§11 audited");
		const notAttention = await call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "LD-TEST-0150" } });
		eq([notAttention.status, notAttention.body.code], [409, "AUTO_INVOICE_NOT_ATTENTION"], "§11 Try again needs a load that needs attention");
		w.rateCons.set("ld-test-0152", "billing@example-broker.test");
		const again = await call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "LD-TEST-0152" } });
		eq(again.status, 200, "§11 Try again");
		eq(w.actions("auto_invoice_retry").map((a) => a.details), ["try again (was: RECIPIENT_DOMAIN_MISMATCH)"], "§11 audited with what it was");
		await job.tick();
		eq(w.state("LD-TEST-0152"), ["drafted", ""], "§11 and it drafts");
		const badKey = await call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "%E0%A4%A" } });
		eq([badKey.status, badKey.body.code], [400, "LOAD_KEY_INVALID"], "§11 an undecodable key is refused");
		const shadowApp = fakeApp();
		shadowJob.mount(shadowApp.app, { requireRole: shadowApp.requireRole });
		eq((await shadowApp.call("GET", "/api/auto-invoice/status")).body.mode, "shadow", "§11 shadow: status answers");
		eq((await shadowApp.call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "LD-TEST-0152" } })).status, 404, "§11 shadow: the load routes are off");
	}
}

// Shadow is off for the off-gap rule: on, then shadow for 3 hours, then on.
async function makeWorldShadowThenOn(w) {
	const shadow = jobLib.create({ ...w.deps(), env: { AUTO_INVOICE_DRAFTS_ENABLED: "true" } });
	w.ready("LD-TEST-0094");
	for (let i = 0; i < 37; i++) { await shadow.tick(); w.now += 5 * MIN; }
	eq(w.state("LD-TEST-0094"), null, "§9 shadow ticks make no claim");
	await w.job().tick();
	eq(w.state("LD-TEST-0094"), ["needs_attention", "OFF_GAP"], "§9 back from shadow after 3 hours: OFF_GAP (shadow counts as off)");
}

main()
	.catch((e) => failures.push(`the run threw: ${e && e.stack}`))
	.then(() => {
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
