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
//   §12 the first review's fixes: endless engine waits, numbers, recovery,
//       timeouts, unreadable settings, logs
//   §13 the recipient anchor: a non-Bison draft only to a broker domain a person
//       confirmed (never free mail, refused by the settings); the job's own
//       re-checks use the same rule
//   §15 a draft a person sends from Drafts before the job looks again (after a
//       lost answer, or a crash): found in Sent Mail, recorded, never appended
//       a second time
//   §16 a refusal the engine throws instead of returning is classed like a
//       returned one: a person, a counted wait or the rate-con re-check, never
//       an uncounted retry with a paid call each time
//   §17 the render shadow (AUTO_INVOICE_SHADOW_RENDERS_ENABLED): a WOULD_ATTEMPT
//       load gets a render digest, built again when its fingerprint changes and
//       kept once a person drafts it; refusals keep their code; caps, the Friday
//       evening quiet window, Gemini's latch, a busy renderer; nextInvoiceNumber,
//       reserveNumber(), appendGmailDraft, engine.record() and the SMTP sender
//       stay at 0
//   §17b the render shadow off (or in real-draft mode): the shadow rows, the
//       sweep's answer and the meta rows exactly as today
//   §18 the claim's draft digest equals messageDigest() of the MIME the fake IMAP
//       server received; the render shadow's digest (placeholder number, one day)
//       equals it (the real number, the next day), and the report's six
//       conditions hold on it; mutants of the render shadow are caught
//   §19 the render records' keeping time: the decision plus 30 days, 45 days at
//       most, pruned once a day, and at start while the job is off
//   §20 one builder and one digest (a source check, with mutants)
//   §21 a load a person drafted before the render shadow built it (delivered in
//       the Friday evening quiet window, drafted at 7 PM): nothing is built after
//       midnight, no engine call, and its record says so; a draft made while a
//       load is being built: nothing built is kept, and a render made before
//       stays with the change noted; mutants of each check
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
const ledgerLib = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const imapDraft = require(path.join(ROOT, "lib", "imap-draft.js"));
const appTime = require(path.join(ROOT, "lib", "app-time.js"));
const { liftSheetHelpers } = require(path.join(ROOT, "scripts", "auto-invoice-shadow-report.js"));
// Absent from a tree before the render shadow: the sections that need them fail
// by name instead of the whole run.
const optional = (p) => {
	try {
		return require(p);
	} catch {
		return null;
	}
};
const mimeRead = optional(path.join(ROOT, "lib", "mime-read.js"));
const trialReport = optional(path.join(ROOT, "scripts", "auto-invoice-send-trial-report.js"));
const { textPdf } = require(path.join(ROOT, "scripts", "lib", "made-up-pdf.js"));
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const Module = require("module");

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
	// The made-up broker's domain is confirmed by a person, as a switch-on would.
	setSettings(db, { optOutDomains: [], confirmedBrokerDomains: ["example-broker.test"] });
}

function setSettings(db, value) {
	db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.run(typeof value === "string" ? value : JSON.stringify(value));
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
		sent: [], // Message-IDs in Sent Mail: drafts a person sent
		appendBehaviors: [],
		calls: { prepare: [], render: [], record: [], append: [], search: [], searchBoxes: [], mint: [] },
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
		mimes: [],
		shadowMessages: [],
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
	// A person sends a draft from Gmail Drafts: it leaves Drafts for Sent Mail.
	w.sendFromDrafts = (messageId) => {
		const i = w.gmail.indexOf(messageId);
		if (i >= 0) { w.gmail.splice(i, 1); w.sent.push(messageId); }
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
			const rule = rules.recipientRule({ brokerEmail: row.Email, bisonRecipient: w.bisonRecipient, documentsEmail: w.rateCons.get(key),
				confirmedDomains: ledgerLib.readSettings(w.db).confirmedBrokerDomains });
			if (!rule.ok) return { ok: false, http: 422, code: rule.code };
			return { ok: true, ctx: { loadId: row["Load ID"], to: w.overrideTo || rule.to } };
		},
		async render(ctx, opts) {
			w.calls.render.push({ loadId: ctx.loadId, ...opts });
			if (w.renderHook) w.renderHook(ctx);
			if (w.renderHang) return never();
			if (w.renderThrows) throw w.renderThrows;
			if (!w.richRender) return { to: ctx.to, subject: `Made-up invoice ${opts.invoiceId}`, html: "<p>made-up</p>", attachments: [], total: w.total || "$1,000.00" };
			// The engine's shapes: "<Broker> Order #<ref>", the invoice PDF first (its
			// number, date and total printed), then the POD and the rate con.
			const row = w.rows.find((r) => rules.loadKey(r["Load ID"]) === rules.loadKey(ctx.loadId)) || {};
			const ref = String(ctx.loadId).replace(/^#/, "");
			const total = row["  Payment  "] || "$1,000.00";
			const [y, m, d] = String(opts.invoiceDate).split("-");
			const printed = `INVOICE Invoice ID # : ${opts.invoiceId} Date: ${m}/${d}/${y} Made-up Co. Invoice To Example Broker ${ctx.to} Load ID# Delivery Date Total Example Broker Order: #${ref} 10/20/2026 ${total} SUB-TOTAL ${total} Total ${total}`;
			let out = {
				to: ctx.to,
				subject: `Example Broker Order #${ref}`,
				html: `<div style="font-family:Arial"><p>Hello,</p><p>Please see the attached documents for load number ${ref}: the rate confirmation, the signed POD, and the invoice.</p><p>Thank you,</p></div>`,
				attachments: [
					{ filename: `Example Broker Invoice Order #${ref}.pdf`, content: textPdf(printed), contentType: "application/pdf" },
					{ filename: `${ref}_POD.pdf`, content: Buffer.from(`%PDF-1.4 made-up POD for ${ref}`), contentType: "application/pdf" },
					{ filename: `${ref}.pdf`, content: Buffer.from(`%PDF-1.4 made-up rate con for ${ref}`), contentType: "application/pdf" },
				],
				total,
			};
			// A mutant render shadow: only the shadow's calls carry the placeholder number.
			if (w.mutateShadow && opts.invoiceId === rules.SHADOW_INVOICE_ID) out = w.mutateShadow(out);
			if (w.keepShadowMessage && opts.invoiceId === rules.SHADOW_INVOICE_ID) w.shadowMessages.push(out);
			return out;
		},
		async record(ctx, rendered, opts) {
			w.calls.record.push({ loadId: ctx && ctx.loadId, via: opts.via, invoiceId: opts.invoiceId, actor: opts.actor.username });
			if (w.recordThrows) throw Object.assign(new Error(`made-up failure for ${BROKER}`), { code: "SQLITE_BUSY" });
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
			// What a Gmail IMAP server would receive: lib/imap-draft.js's own MIME.
			if (w.captureMime) w.mimes.push(await imapDraft.buildMime({ from: o.from, to: o.to, subject: o.subject, html: o.html, attachments: o.attachments, messageId: o.messageId }));
			const b = w.appendBehaviors.shift() || "OK";
			if (b === "OK") { w.gmail.push(o.messageId); return { ok: true }; }
			if (b === "NO") throw imapError("IMAP APPEND failed: a2 NO made-up", "literal", true);
			if (b === "LOGIN") throw imapError("IMAP LOGIN failed", "login", true);
			if (b === "BEFORE_LITERAL") throw imapError("IMAP timeout at stage 2", "append", false);
			if (b === "SENT_NO_ANSWER") { w.gmail.push(o.messageId); throw imapError("IMAP timeout at stage 3", "literal", false); }
			// The answer is lost and the message lands only after the next search.
			if (b === "LANDS_LATE") { w.pendingLanding = o.messageId; throw imapError("IMAP timeout at stage 3", "literal", false); }
			if (b === "LOST") throw imapError("IMAP timeout at stage 3", "literal", false);
			if (b === "CRASH_AFTER") { w.gmail.push(o.messageId); return never(); }
			if (b === "CRASH_BEFORE") return never();
			throw new Error(`unknown behaviour ${b}`);
		},
		// Searches what lib/imap-draft.js would: the mailboxes asked for, else the
		// library's own list (Drafts alone for a library that names none), and
		// stops at the first that holds the Message-ID.
		async findDraftByMessageId({ messageId, mailboxes }) {
			const boxes = mailboxes || imapDraft.SEARCH_MAILBOXES || ["[Gmail]/Drafts"];
			w.calls.search.push(messageId);
			w.calls.searchBoxes.push([...boxes]);
			if (w.searchFails) throw imapError("IMAP SEARCH failed: made-up", "search", true);
			let hit = { found: false, count: 0, mailbox: "" };
			for (const box of boxes) {
				const held = box === "[Gmail]/Drafts" ? w.gmail : box === "[Gmail]/Sent Mail" ? w.sent : [];
				const n = held.filter((id) => id === messageId).length;
				if (n) { hit = { found: true, count: n, mailbox: box }; break; }
			}
			if (w.pendingLanding) { w.gmail.push(w.pendingLanding); w.pendingLanding = null; }
			return hit;
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
		eq([lost.state, lost.stage, lost.attempts], ["queued", "appending", 1], "§6 not found yet: queued again at stage appending (it may still land), number kept");
		const searches62 = w.calls.search.length;
		w.now += 15 * MIN;
		await job.tick();
		eq(w.calls.search.length - searches62, 1, "§6 the retry searches Gmail before appending again");
		eq(w.state("LD-TEST-0062"), ["drafted", ""], "§6 still absent: the retry drafts it");
		const tries = w.calls.render.filter((r) => r.loadId === "LD-TEST-0062").map((r) => r.invoiceId);
		eq([tries.length, new Set(tries).size, w.draftRows("LD-TEST-0062").length], [2, 1, 1], "§6 with the same number, one draft row");

		// The review's reproduction: the message lands just after the first search.
		w.ready("LD-TEST-0064");
		w.appendBehaviors = ["LANDS_LATE", "OK"];
		const gmailBefore = w.gmail.length;
		const appendsBefore64 = w.calls.append.length;
		await job.tick();
		eq([w.claim("LD-TEST-0064").stage, w.gmail.length - gmailBefore], ["appending", 1], "§6 late landing: missed by the first search, the draft is in Gmail anyway");
		w.now += 16 * MIN;
		await job.tick();
		eq(w.state("LD-TEST-0064"), ["drafted", ""], "§6 late landing: the retry finds it and records it");
		eq([w.calls.append.length - appendsBefore64, w.gmail.length - gmailBefore, w.draftRows("LD-TEST-0064").length], [1, 1, 1], "§6 late landing: one append, one Gmail draft, one draft row");

		w.ready("LD-TEST-0065");
		w.appendBehaviors = ["LANDS_LATE"];
		await job.tick();
		w.handDraft("LD-TEST-0065");
		await job.tick();
		eq(w.state("LD-TEST-0065"), ["skipped", "DRAFTED_BY_HAND"], "§6 a hand draft after a lost answer: skipped");
		eq(w.actions("auto_invoice_number_void").filter((a) => a.id === "LD-TEST-0065").length, 0, "§6 and its number is not called unused: it may be in Gmail");

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
		setSettings(w.db, { optOutDomains: ["example-optout.test"], confirmedBrokerDomains: ["example-broker.test", "example-optout.test"] });
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

		// No rate-con total read (Gemini failed or timed out): a person, never a retry.
		w.ready("LD-TEST-0112");
		w.prepareHook = (id) => (id === "LD-TEST-0112" ? { ok: false, http: 503, code: "RATECON_TOTAL_UNREAD", geminiUnavailable: true } : null);
		await job.tick();
		w.now += 60 * MIN;
		await job.tick();
		eq([w.state("LD-TEST-0112"), w.calls.prepare.filter((p) => p.loadId === "LD-TEST-0112").length, w.calls.mint.length],
			[["needs_attention", "RATECON_TOTAL_UNREAD"], 1, 2], "§10 RATECON_TOTAL_UNREAD, even with Gemini down: a person after one engine call, no number, no retry");
		w.prepareHook = null;
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
		eq([put.status, put.body], [200, { optOutDomains: ["example-factor.test"], confirmedBrokerDomains: ["example-broker.test"] }], "§11 opt-outs saved; the confirmed list left out is kept");
		eq((await call("GET", "/api/auto-invoice/settings")).body, { optOutDomains: ["example-factor.test"], confirmedBrokerDomains: ["example-broker.test"], unreadable: false, dropped: [] }, "§11 and read back");
		eq(w.actions("update_auto_invoice_settings").map((a) => [a.who, a.details]),
			[["made-up-admin", "opted out: example-factor.test (was: none); confirmed: example-broker.test (was: example-broker.test)"]], "§11 audited as the Super Admin");
		eq((await call("PUT", "/api/auto-invoice/settings", { body: {} })).body.code, "SETTINGS_INVALID", "§11 a body with neither list is refused");

		w.setRow("LD-TEST-0150", { "  Payment  ": "$1,100.00" });
		await job.tick();
		eq(w.claim("LD-TEST-0150").changed_fields, "payment", "§11 the drafted load changed");
		const notDrafted = await call("POST", "/api/auto-invoice/loads/:loadKey/checked", { params: { loadKey: "LD-TEST-0152" } });
		eq([notDrafted.status, notDrafted.body.code], [409, "AUTO_INVOICE_NOT_DRAFTED"], "§11 Mark checked needs a draft");
		const missing = await call("POST", "/api/auto-invoice/loads/:loadKey/checked", { params: { loadKey: "LD-TEST-9999" } });
		eq([missing.status, missing.body.code], [404, "AUTO_INVOICE_NOT_FOUND"], "§11 an unknown load: 404");
		const checked = await call("POST", "/api/auto-invoice/loads/:loadKey/checked", { params: { loadKey: "#LD-TEST-0150" } });
		eq(checked.status, 200, "§11 Mark checked ('#id', as Express decodes it, works too)");
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
		const badKey = await call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "x".repeat(101) } });
		eq([badKey.status, badKey.body.code], [400, "LOAD_KEY_INVALID"], "§11 an over-long key is refused");
		const encoded = await call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "%23LD-TEST-0152" } });
		eq(encoded.status, 404, "§11 the key is not decoded a second time");
		const shadowApp = fakeApp();
		shadowJob.mount(shadowApp.app, { requireRole: shadowApp.requireRole });
		eq((await shadowApp.call("GET", "/api/auto-invoice/status")).body.mode, "shadow", "§11 shadow: status answers");
		eq((await shadowApp.call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "LD-TEST-0152" } })).status, 404, "§11 shadow: the load routes are off");
	}

	// ---------------------------------------------------------------- §12
	section("§12 review fixes: endless waits, numbers, recovery, timeouts, settings, logs");
	{
		// The review's pod-loop: a POD only in Drive that the engine can't fetch.
		const w = makeWorld();
		const job = await w.started();
		w.setRow("LD-TEST-0160");
		w.db.prepare("INSERT INTO documents (load_id, type, file_name, drive_file_id) VALUES (?, 'POD', 'pod-drive.pdf', 'drv-made-up')").run("LD-TEST-0160");
		w.rateCons.set("ld-test-0160", "billing@example-broker.test");
		w.prepareHook = () => ({ ok: false, http: 400, code: "POD_NOT_FOUND" });
		const seen = [];
		for (let i = 0; i < 12; i++) { await job.tick(); seen.push(w.state("LD-TEST-0160").join("/")); w.now += 5 * MIN; }
		eq(w.state("LD-TEST-0160"), ["needs_attention", "POD_UNREADABLE"], "§12 M1: the engine can't find the POD the free check sees: a person after 3 tries");
		eq([w.calls.prepare.length, w.claim("LD-TEST-0160").attempts, w.calls.mint.length], [3, 3, 0], "§12 M1: three engine calls in 12 sweeps, counted as attempts, no number");
		ok(seen.slice(-8).every((s) => s === "needs_attention/POD_UNREADABLE"), "§12 M1: and it stays there");
	}
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0161");
		w.prepareHook = (id) => (id === "LD-TEST-0161" ? { ok: true, ctx: { loadId: id } } : null);
		await job.tick();
		eq([w.state("LD-TEST-0161"), w.calls.mint.length, w.calls.render.length], [["needs_attention", "NO_BILLING_EMAIL"], 0, 0], "§12 L1: an engine answer with no recipient: a person, no number minted");
		w.prepareHook = null;

		w.ready("LD-TEST-0162");
		w.renderHook = (ctx) => { if (ctx.loadId === "LD-TEST-0162") w.handDraft("LD-TEST-0162", "10202026-77"); };
		await job.tick();
		w.renderHook = null;
		eq(w.state("LD-TEST-0162"), ["skipped", "DRAFTED_BY_HAND"], "§12 L3: a hand draft made during the render: skipped before Gmail");
		eq([w.gmail.length, w.actions("auto_invoice_number_void").map((a) => a.id)], [0, ["LD-TEST-0162"]], "§12 L3: no Gmail draft, and the number it reserved is void");
	}
	{
		// L2: a crash after the append; on restart the engine rebuilds a different draft.
		for (const [label, change] of [["recipient", (w) => { w.rateCons.set("ld-test-0163", "ap@example-factor.test"); }], ["total", (w) => { w.total = "$1,100.00"; }]]) {
			const w = makeWorld();
			const before = await w.started({ workerId: "before-crash" });
			w.ready("LD-TEST-0163");
			w.recordHang = "before";
			before.tick();
			await until(() => (w.claim("LD-TEST-0163") || {}).stage === "appended", `§12 L2 ${label}: the claim reaches appended`);
			w.recordHang = "";
			const recordsBefore = w.calls.record.length;
			change(w);
			w.now += 16 * MIN;
			await w.job({ workerId: "after-restart" }).tick();
			const c = w.claim("LD-TEST-0163");
			eq([c.state, c.reason_code, c.stage], ["needs_attention", "IN_GMAIL_UNRECORDED", "appended"], `§12 L2: the rebuilt ${label} differs from what went to Gmail: a person, nothing recorded`);
			eq([w.calls.record.length - recordsBefore, w.draftRows("LD-TEST-0163").length, w.gmail.length], [0, 0, 1], `§12 L2 ${label}: no draft row with a ${label} that isn't in Gmail`);
		}
	}
	{
		const w = makeWorld();
		const job = await w.started({ engineTimeoutMs: 30 });
		w.ready("LD-TEST-0164");
		w.prepareHook = () => never();
		const out = await job.tick();
		eq([out.work.started, w.claim("LD-TEST-0164").state, w.claim("LD-TEST-0164").reason_code, w.claim("LD-TEST-0164").attempts], [1, "queued", "RETRY_LATER", 1], "§12 L4: a hung engine call times out as a counted failure");
		w.prepareHook = null;
		w.now += 15 * MIN;
		await job.tick();
		eq(w.state("LD-TEST-0164"), ["drafted", ""], "§12 L4: and drafting goes on (nothing left in flight)");
	}
	{
		// L5: Try again on a number reserved more than a day ago.
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0165");
		w.appendBehaviors = ["NO", "NO", "NO", "NO"];
		for (const wait of [0, 15 * MIN, HOUR, 4 * HOUR]) { w.now += wait; await job.tick(); }
		const failed = w.claim("LD-TEST-0165");
		eq([failed.state, failed.reason_code, failed.invoice_id, failed.invoice_date], ["needs_attention", "DRAFT_FAILED", "10202026-1", "2026-10-20"], "§12 L5: given up, number reserved on Oct 20");
		w.now += 2 * 24 * HOUR;
		const { app, requireRole, call } = fakeApp();
		job.mount(app, { requireRole });
		eq((await call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "LD-TEST-0165" } })).status, 200, "§12 L5: Try again two days later");
		await job.tick();
		const fresh = w.claim("LD-TEST-0165");
		eq([fresh.state, fresh.invoice_id, fresh.invoice_date], ["drafted", "10222026-1", "2026-10-22"], "§12 L5: drafted with a fresh number and today's date");
		eq(w.actions("auto_invoice_number_void").map((a) => a.details), ["10202026-1 was reserved on 2026-10-20 and never used (a fresh number replaces it)"], "§12 L5: the old number is audited void");

		w.ready("LD-TEST-0166");
		w.appendBehaviors = ["LOST"];
		w.searchFails = true;
		await job.tick();
		w.db.prepare("UPDATE auto_invoice_claims SET attempts = 3 WHERE load_key = 'ld-test-0166'").run();
		w.searchFails = false;
		await call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "LD-TEST-0166" } });
		eq([w.claim("LD-TEST-0166").state, w.claim("LD-TEST-0166").attempts], ["working", 0], "§12 L5: Try again on a draft that may be in Gmail resets its attempts too");
	}
	{
		// L6: an unreadable opt-out list drafts nothing until it is saved again.
		const w = makeWorld();
		const job = await w.started();
		setSettings(w.db, "{broken");
		w.ready("LD-TEST-0167");
		const out = await job.tick();
		eq([out.sweep.paused, out.work.paused, w.state("LD-TEST-0167"), w.calls.prepare.length, w.calls.mint.length], ["SETTINGS_UNREADABLE", "SETTINGS_UNREADABLE", null, 0, 0],
			"§12 L6: the settings can't be read: nothing claimed or drafted (fails closed, and nothing is stuck at a verdict made without them)");
		const { app, requireRole, call } = fakeApp();
		job.mount(app, { requireRole });
		eq((await call("GET", "/api/auto-invoice/settings")).body, { optOutDomains: [], confirmedBrokerDomains: [], unreadable: true, dropped: [] }, "§12 L6: the settings route says so");
		eq((await call("PUT", "/api/auto-invoice/settings", { body: { optOutDomains: [], confirmedBrokerDomains: ["example-broker.test"] } })).status, 200, "§12 L6: saving the lists again");
		await job.tick();
		eq(w.state("LD-TEST-0167"), ["drafted", ""], "§12 L6: then it drafts");
		w.setRow("LD-TEST-50%");
		w.addPod("LD-TEST-50%");
		w.rateCons.set("ld-test-50%", "billing@example-broker.test");
		w.appendBehaviors = ["NO", "NO", "NO", "NO"];
		for (const wait of [0, 15 * MIN, HOUR, 4 * HOUR]) { w.now += wait; await job.tick(); }
		eq((await call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "LD-TEST-50%" } })).status, 200, "§12 L6: a Load ID with '%' (already decoded by Express) is found");
	}
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0168");
		w.recordThrows = true;
		await job.tick();
		eq(w.state("LD-TEST-0168"), ["needs_attention", "IN_GMAIL_UNRECORDED"], "§12 logs: a record that throws leaves the draft for a person");
		ok(w.logs.some((l) => /recording the draft failed: SQLITE_BUSY$/.test(l)), "§12 logs: the failure is logged by its code");
		ok(!w.logs.some((l) => /@|made-up failure/.test(l)), "§12 logs: never by its message");
	}

	// ---------------------------------------------------------------- §13
	section("§13 the recipient anchor: a domain a person confirmed, never free mail");
	{
		const w = makeWorld();
		const job = await w.started();
		const { app, requireRole, call } = fakeApp();
		job.mount(app, { requireRole });
		w.ready("LD-TEST-0170", { Email: "ops@example-other.test" }, "billing@example-other.test");
		w.ready("LD-TEST-0171", { Email: "made-up-dispatch@gmail.com" }, "made-up-billing@gmail.com");
		w.ready("LD-TEST-0172", { Email: "" }, "billing@example-other.test");
		w.ready("LD-TEST-0173", { Email: BISON }, "");
		w.ready("LD-TEST-0174");
		await job.tick();
		eq(w.state("LD-TEST-0170"), ["needs_attention", "BROKER_DOMAIN_UNCONFIRMED"], "§13 the rate con's billing email matches the broker's domain, but nobody confirmed it: a person");
		eq(w.state("LD-TEST-0171"), ["needs_attention", "BROKER_EMAIL_FREEMAIL"], "§13 a free-mail broker Email: a person");
		eq(w.state("LD-TEST-0172"), ["needs_attention", "NO_BROKER_EMAIL"], "§13 no broker Email: a person");
		eq([w.state("LD-TEST-0173"), w.state("LD-TEST-0174")], [["drafted", ""], ["drafted", ""]], "§13 Bison (its setting) and a confirmed domain: drafted");
		eq(w.calls.prepare.map((p) => p.loadId).sort(), ["LD-TEST-0173", "LD-TEST-0174"], "§13 nothing is spent on the others (no engine call, no number)");
		const refused = await call("PUT", "/api/auto-invoice/settings", { body: { confirmedBrokerDomains: ["example-broker.test", "gmail.com"] } });
		eq([refused.status, refused.body.code], [400, "CONFIRMED_DOMAIN_FREEMAIL"], "§13 the settings refuse to confirm a free-mail domain");
		eq(ledgerLib.readSettings(w.db).confirmedBrokerDomains, ["example-broker.test"], "§13 and nothing is saved");
		const ok200 = await call("PUT", "/api/auto-invoice/settings", { body: { confirmedBrokerDomains: ["example-broker.test", "Example-Other.test"] } });
		eq([ok200.status, ok200.body.confirmedBrokerDomains], [200, ["example-broker.test", "example-other.test"]], "§13 a Super Admin confirms the domain");
		ok(/confirmed: example-broker\.test, example-other\.test \(was: example-broker\.test\)$/.test(w.actions("update_auto_invoice_settings").slice(-1)[0].details), "§13 audited with the list before and after");
		eq((await call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "LD-TEST-0170" } })).status, 200, "§13 then Try again");
		await job.tick();
		eq(w.state("LD-TEST-0170"), ["drafted", ""], "§13 drafted to the confirmed domain's billing email");
		eq(w.calls.append.find((a) => a.subject.includes(w.claim("LD-TEST-0170").invoice_id)).to, "billing@example-other.test", "§13 the recipient is the rate con's documents email on that domain");
		w.ready("LD-TEST-0175", { Email: "ops@example-other.test" }, "billing@sub.example-other.test");
		await job.tick();
		eq(w.state("LD-TEST-0175"), ["needs_attention", "RECIPIENT_DOMAIN_MISMATCH"], "§13 a confirmed domain still needs the billing email on exactly that domain");
	}
	{
		// The job's own re-check uses the same rule: a draft recovered after the
		// domain was taken off the list is not recorded on the engine's word.
		const w = makeWorld();
		const before = await w.started({ workerId: "before-crash" });
		w.ready("LD-TEST-0176");
		w.recordHang = "before";
		before.tick();
		await until(() => (w.claim("LD-TEST-0176") || {}).stage === "appended", "§13 the claim reaches appended");
		w.recordHang = "";
		setSettings(w.db, { optOutDomains: [], confirmedBrokerDomains: [] });
		w.now += 16 * MIN;
		w.prepareHook = (id) => ({ ok: true, ctx: { loadId: id, to: "billing@example-broker.test" } });
		await w.job({ workerId: "after-restart" }).tick();
		const c = w.claim("LD-TEST-0176");
		eq([c.state, c.reason_code, w.draftRows("LD-TEST-0176").length], ["needs_attention", "IN_GMAIL_UNRECORDED", 0], "§13 recovery re-checks the confirmed list: nothing recorded, a person checks Gmail");
	}

	// ---------------------------------------------------------------- §14
	section("§14 settings robustness: a stored entry a newer rule refuses, an unreadable row; Bison lookalikes");
	{
		// The review's PoC: an opt-out, and a confirmed domain since listed as free mail.
		const w = makeWorld();
		const job = await w.started();
		setSettings(w.db, { optOutDomains: ["example-optout.test"], confirmedBrokerDomains: ["example-broker.test", "comcast.net"] });
		const { app, requireRole, call } = fakeApp();
		job.mount(app, { requireRole });
		const got = (await call("GET", "/api/auto-invoice/settings")).body;
		eq(got, { optOutDomains: ["example-optout.test"], confirmedBrokerDomains: ["example-broker.test"], unreadable: false,
			dropped: [{ list: "confirmedBrokerDomains", domain: "comcast.net", code: "CONFIRMED_DOMAIN_FREEMAIL" }] }, "§14 GET: each list read on its own; only the refused entry is dropped, and reported");
		w.ready("LD-TEST-0180");
		w.ready("LD-TEST-0181", { Email: "ops@example-optout.test" }, "billing@example-optout.test");
		await job.tick();
		await job.tick();
		eq([w.state("LD-TEST-0180"), w.state("LD-TEST-0181")], [["drafted", ""], ["skipped", "BROKER_OPTED_OUT"]], "§14 drafting goes on with what is readable; the opt-out still holds");
		const st = job.status();
		eq([st.settings.problem, st.settings.unreadable, st.settings.dropped.map((x) => x.domain), st.paused], ["SETTINGS_ENTRIES_DROPPED", false, ["comcast.net"], null], "§14 status() shows the dropped entry");
		eq(w.notices.filter((n) => /settings/.test(n.title)).map((n) => n.body), [
			"Some automatic-draft settings no longer pass the rules and are ignored: comcast.net (confirmed, CONFIRMED_DOMAIN_FREEMAIL). Save the lists again to remove them.",
		], "§14 one Super Admin notice, however many sweeps");
		const put = await call("PUT", "/api/auto-invoice/settings", { body: { confirmedBrokerDomains: ["example-broker.test"] } });
		eq([put.status, put.body], [200, { optOutDomains: ["example-optout.test"], confirmedBrokerDomains: ["example-broker.test"] }], "§14 saving only the confirmed list keeps the opt-outs");
		eq(JSON.parse(w.db.prepare("SELECT value FROM app_settings WHERE key = 'auto_invoice.settings'").get().value).optOutDomains, ["example-optout.test"], "§14 and stores them");
		eq(w.actions("update_auto_invoice_settings").slice(-1)[0].details,
			"opted out: example-optout.test (was: example-optout.test); confirmed: example-broker.test (was: example-broker.test); ignored before: comcast.net (confirmed)", "§14 the audit names what was ignored");
		await job.tick();
		eq(job.status().settings.problem, "", "§14 once saved, the problem is gone");

		// An unreadable row: everything stops, visibly, and nothing is lost on save.
		setSettings(w.db, "{broken");
		for (let i = 0; i < 3; i++) { w.now += 5 * MIN; await job.tick(); }
		const st2 = job.status();
		eq([st2.settings.problem, st2.paused && st2.paused.reason], ["SETTINGS_UNREADABLE", "SETTINGS_UNREADABLE"], "§14 status() shows SETTINGS_UNREADABLE");
		eq(w.notices.filter((n) => /settings/.test(n.title)).length, 2, "§14 one more notice for it, not one a sweep");
		const partial = await call("PUT", "/api/auto-invoice/settings", { body: { confirmedBrokerDomains: ["example-broker.test"] } });
		eq([partial.status, partial.body.code], [409, "SETTINGS_UNREADABLE"], "§14 a one-list save while the row is unreadable is refused (the other list would be lost)");
		eq(w.db.prepare("SELECT value FROM app_settings WHERE key = 'auto_invoice.settings'").get().value, "{broken", "§14 and nothing is written");
		const both = await call("PUT", "/api/auto-invoice/settings", { body: { optOutDomains: ["example-optout.test"], confirmedBrokerDomains: ["example-broker.test"] } });
		eq(both.status, 200, "§14 saving both lists works");
		eq(w.actions("update_auto_invoice_settings").slice(-1)[0].details,
			"opted out: example-optout.test (was: unreadable); confirmed: example-broker.test (was: unreadable)", "§14 audited as replacing an unreadable row");
	}
	{
		// Recovery waits for readable settings instead of recording without them.
		const w = makeWorld();
		const before = await w.started({ workerId: "before-crash" });
		w.ready("LD-TEST-0182");
		w.recordHang = "before";
		before.tick();
		await until(() => (w.claim("LD-TEST-0182") || {}).stage === "appended", "§14 the claim reaches appended");
		w.recordHang = "";
		setSettings(w.db, "{broken");
		w.now += 16 * MIN;
		const after = w.job({ workerId: "after-restart" });
		const out = await after.tick();
		const held = w.claim("LD-TEST-0182");
		eq([out.recover.paused, held.state, held.stage, held.reason_code], ["SETTINGS_UNREADABLE", "working", "appended", ""], "§14 recovery is held while the settings can't be read (no IN_GMAIL_UNRECORDED)");
		setSettings(w.db, { optOutDomains: [], confirmedBrokerDomains: ["example-broker.test"] });
		w.now += 5 * MIN;
		await after.tick();
		eq([w.state("LD-TEST-0182"), w.draftRows("LD-TEST-0182").length, w.gmail.length], [["drafted", ""], 1, 1], "§14 then it is recorded, once");
	}
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0183", { Email: "ops@notbisontransport.com" }, "billing@notbisontransport.com");
		w.ready("LD-TEST-0184", { Email: "ops@ap.bisontransport.com" }, "");
		await job.tick();
		eq(w.state("LD-TEST-0183"), ["needs_attention", "BROKER_DOMAIN_UNCONFIRMED"], "§14 a Bison lookalike is not Bison: it needs a confirmed domain");
		eq([w.state("LD-TEST-0184"), w.calls.append.map((a) => a.to)], [["drafted", ""], [BISON_AP]], "§14 a Bison subdomain is Bison: its configured inbox");
	}

	// ---------------------------------------------------------------- §15
	section("§15 a draft a person sends from Drafts before the job looks again");
	{
		// The review's case: the answer is lost, the draft lands after the search,
		// and a person sends it from Drafts within the 15 minutes before the retry.
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0190");
		w.appendBehaviors = ["LANDS_LATE", "OK"];
		await job.tick();
		const lost = w.claim("LD-TEST-0190");
		eq([lost.state, lost.stage, w.gmail, w.calls.append.length], ["queued", "appending", [lost.message_id], 1], "§15 the answer was lost and the draft landed after the search");
		w.sendFromDrafts(lost.message_id);
		eq([w.gmail.length, w.sent], [0, [lost.message_id]], "§15 a person sends it from Drafts: it is in Sent Mail now");
		w.now += 16 * MIN;
		await job.tick();
		eq(w.state("LD-TEST-0190"), ["drafted", ""], "§15 the retry finds it in Sent Mail and records it");
		eq([w.calls.append.length, w.gmail.length, w.sent.length, w.draftRows("LD-TEST-0190").length], [1, 0, 1, 1], "§15 one append in all: the sent invoice is never appended again");
		eq(w.calls.searchBoxes.slice(-1)[0], ["[Gmail]/Drafts", "[Gmail]/Sent Mail"], "§15 the retry looked in Drafts, then in Sent Mail");
		eq([w.claim("LD-TEST-0190").invoice_id, w.calls.mint.length], [lost.invoice_id, 1], "§15 one invoice number");
	}
	{
		// A crash while the draft was being appended; a person sends it before the restart.
		const w = makeWorld();
		const before = await w.started({ workerId: "before-crash" });
		w.ready("LD-TEST-0191");
		w.appendBehaviors = ["CRASH_AFTER"];
		before.tick();
		await until(() => (w.claim("LD-TEST-0191") || {}).stage === "appending" && w.gmail.length === 1, "§15 the claim reaches appending, the draft made");
		await tick();
		w.sendFromDrafts(w.claim("LD-TEST-0191").message_id);
		w.now += 16 * MIN; // the lease has run out
		await w.job({ workerId: "after-restart" }).tick();
		eq(w.state("LD-TEST-0191"), ["drafted", ""], "§15 after a crash: the recovery finds the sent draft in Sent Mail and records it");
		eq([w.calls.append.length, w.gmail.length, w.sent.length, w.draftRows("LD-TEST-0191").length], [1, 0, 1, 1], "§15 after a crash: one append, never a second draft of a sent invoice");
	}
	{
		// Absent from both mailboxes: the retry may append (the number never reached Gmail).
		const w = makeWorld();
		const job = await w.started();
		w.ready("LD-TEST-0192");
		w.appendBehaviors = ["LOST", "OK"];
		await job.tick();
		w.now += 16 * MIN;
		await job.tick();
		eq([w.state("LD-TEST-0192"), w.calls.append.length, w.gmail.length, w.sent.length], [["drafted", ""], 2, 1, 0], "§15 in neither mailbox: appended once more, one draft in Gmail");
	}

	// ---------------------------------------------------------------- §16
	section("§16 a refusal the engine throws instead of returning");
	{
		const w = makeWorld();
		const job = await w.started();
		const throws = (forId, code) => (id) => {
			if (id !== forId) return null;
			throw Object.assign(new Error(`made-up ${code} for ${BROKER}`), { code });
		};
		const prepares = (id) => w.calls.prepare.filter((p) => p.loadId === id).length;

		// A rate-con total that wasn't read: a person after one engine call.
		w.ready("LD-TEST-0200");
		w.prepareHook = throws("LD-TEST-0200", "RATECON_TOTAL_UNREAD");
		await job.tick();
		for (let i = 0; i < 4; i++) { w.now += 15 * MIN; await job.tick(); }
		eq([w.state("LD-TEST-0200"), prepares("LD-TEST-0200"), w.calls.mint.length], [["needs_attention", "RATECON_TOTAL_UNREAD"], 1, 0],
			"§16 a thrown RATECON_TOTAL_UNREAD: a person after one engine call, no number, never retried");

		// "Not ready" thrown: counted like a returned one, a person after three.
		w.ready("LD-TEST-0201");
		w.prepareHook = throws("LD-TEST-0201", "POD_NOT_FOUND");
		for (let i = 0; i < 6; i++) { await job.tick(); w.now += 5 * MIN; }
		const wait = w.claim("LD-TEST-0201");
		eq([wait.state, wait.reason_code, wait.attempts, prepares("LD-TEST-0201")], ["needs_attention", "POD_UNREADABLE", 3, 3],
			"§16 a thrown POD_NOT_FOUND: counted, a person after three engine calls");

		// No rate con thrown: the 2-hour re-check, not a retry every 5 minutes.
		w.ready("LD-TEST-0202");
		w.prepareHook = throws("LD-TEST-0202", "RATECON_MISSING");
		await job.tick();
		w.now += HOUR;
		await job.tick();
		const missing = w.claim("LD-TEST-0202");
		eq([missing.state, missing.reason_code, missing.ratecon_checks, prepares("LD-TEST-0202")], ["waiting", "RATECON_MISSING", 1, 1],
			"§16 a thrown RATECON_MISSING: waiting for the 2-hour re-check, one engine call in the hour");

		// Anything else thrown (an outage, a bug): a counted retry, as before.
		w.ready("LD-TEST-0203");
		w.prepareHook = throws("LD-TEST-0203", undefined);
		await job.tick();
		const other = w.claim("LD-TEST-0203");
		eq([other.state, other.reason_code, other.attempts, other.next_attempt_at], ["queued", "RETRY_LATER", 1, new Date(w.now + 15 * MIN).toISOString()],
			"§16 an error with no code: queued again in 15 minutes, the attempt counted");
		w.prepareHook = null;
		ok(!w.logs.some((l) => /@|made-up RATECON|made-up POD/.test(l)), "§16 no error message or address in the logs");
	}

	await renderShadowSections();
}

// ------------------------------------------------------------------ the render shadow
const SHADOW_ON = Object.freeze({ env: { AUTO_INVOICE_DRAFTS_SHADOW: "" }, shadowRenders: true });
const shadowRowOf = (w, id) => w.db.prepare("SELECT * FROM auto_invoice_shadow WHERE load_key = ?").get(rules.loadKey(id)) || null;
const recordOf = (w, id) => {
	const r = shadowRowOf(w, id);
	try {
		return r && r.render_digest_json ? JSON.parse(r.render_digest_json) : null;
	} catch {
		return null;
	}
};
const DIGEST_FIELDS = ["v", "recipient", "cc", "bcc", "subjectSha256", "bodyTextSha256", "invoiceTextSha256", "attachments"];
const digestPart = (d) => (d ? Object.fromEntries(DIGEST_FIELDS.map((k) => [k, d[k]])) : null);
// Counts every reserveNumber() the job makes, through the ledger module it shares.
function spyReserve() {
	const real = ledgerLib.reserveNumber;
	const spy = { n: 0, restore: () => { ledgerLib.reserveNumber = real; } };
	ledgerLib.reserveNumber = (...args) => { spy.n++; return real(...args); };
	return spy;
}
// A copy of a lib module with one edit, compiled beside the original so its own
// relative requires resolve; null when the edit doesn't match exactly once.
function mutantModule(file, from, to) {
	const src = fs.readFileSync(file, "utf8");
	if (src.split(from).length !== 2) return null;
	const m = new Module(file, module);
	m.filename = file;
	m.paths = Module._nodeModulePaths(path.dirname(file));
	m._compile(src.replace(from, () => to), file);
	return m.exports;
}

async function renderShadowSections() {
	// ---------------------------------------------------------------- §17
	section("§17 the render shadow: digests of what it would send, no number, no Gmail");
	{
		const w = makeWorld();
		w.richRender = true;
		const reserve = spyReserve();
		const smtp = [];
		try {
			const job = w.job({ ...SHADOW_ON, sendMail: (m) => smtp.push(m) });
			eq([job.mode, job.shadowRenders], ["shadow", true], "§17 shadow mode with the render shadow on");
			await job.tick();
			w.now += 5 * MIN;
			w.ready("LD-TEST-0300");
			const first = await job.tick();
			const row = shadowRowOf(w, "LD-TEST-0300");
			eq(row && [row.verdict, row.reason_code], ["WOULD_ATTEMPT", ""], "§17 the load is WOULD_ATTEMPT, as without the render shadow");
			const rec = recordOf(w, "LD-TEST-0300");
			ok(rec && rec.renderedAt, "§17 FAILS ON THE OLD CODE: a WOULD_ATTEMPT load gets a render digest (render_digest_json)");
			eq(rec && Object.keys(rec), ["v", "renderedAt", "recipient", "cc", "bcc", "subjectSha256", "bodyTextSha256", "invoiceTextSha256", "attachments", "fingerprintSha256"],
				"§17 the record: the digest's fields and the fingerprint's hash, nothing else");
			eq(rec && [rec.recipient, rec.attachments.map((a) => a.name), rec.renderedAt],
				["billing@example-broker.test", ["Example Broker Invoice Order #LD-TEST-0300.pdf", "LD-TEST-0300_POD.pdf", "LD-TEST-0300.pdf"], new Date(w.now).toISOString()],
				"§17 its plain values: the recipient, the attachment names and the render time");
			ok(rec && /^[0-9a-f]{64}$/.test(rec.invoiceTextSha256) && rec.attachments[0].sha256 === "" && rec.attachments.slice(1).every((a) => /^[0-9a-f]{64}$/.test(a.sha256)),
				"§17 the invoice by its masked text (read), the POD and the rate con by their bytes");
			ok(rec && !JSON.stringify(rec).includes("1,000.00") && !JSON.stringify(rec).includes("Hello"), "§17 no amount or body text stored");
			eq(w.calls.prepare[0], { loadId: "LD-TEST-0300", body: {}, dryRun: false, mode: "auto" }, "§17 built through the engine's auto mode, as the real draft is");
			eq(w.calls.render[0] && [w.calls.render[0].invoiceId, w.calls.render[0].invoiceDate], [rules.SHADOW_INVOICE_ID, "2026-10-20"], "§17 with the placeholder number and the render day");
			eq(first.sweep && first.sweep.renders, { rendered: 1, refused: 0 }, "§17 the sweep says what it rendered");
			const nothing = () => [w.calls.mint.length, reserve.n, w.calls.append.length, w.calls.search.length, w.calls.record.length, smtp.length,
				w.db.prepare("SELECT COUNT(*) n FROM auto_invoice_claims").get().n];
			eq(nothing(), [0, 0, 0, 0, 0, 0, 0], "§17 no nextInvoiceNumber, reserveNumber(), appendGmailDraft, Gmail search, engine.record() or SMTP call; no claim");

			await job.tick();
			eq(w.calls.render.length, 1, "§17 the load unchanged: not built again");
			w.now += 5 * MIN;
			w.setRow("LD-TEST-0300", { "  Payment  ": "$1,250.00" });
			await job.tick();
			const rec2 = recordOf(w, "LD-TEST-0300");
			eq(w.calls.render.length, 2, "§17 FAILS ON THE OLD CODE: its fingerprint changed (payment): built again");
			ok(rec2 && rec.invoiceTextSha256 !== rec2.invoiceTextSha256 && rec.fingerprintSha256 !== rec2.fingerprintSha256 && rec2.renderedAt > rec.renderedAt,
				"§17 ...so the latest render matches the load as it stands");

			w.now += 5 * MIN;
			w.handDraft("LD-TEST-0300", "10202026-60");
			await job.tick();
			const rec3 = recordOf(w, "LD-TEST-0300");
			ok(rec3 && rec3.draftSeenAt === new Date(w.now).toISOString() && rec3.fingerprintAtDraftSha256 === rec3.fingerprintSha256 && rec3.invoiceTextSha256 === rec2.invoiceTextSha256,
				"§17 a person drafts it: the render made before is kept, with the fingerprint at the draft");
			w.now += 5 * MIN;
			w.setRow("LD-TEST-0300", { "  Payment  ": "$1,300.00" });
			await job.tick();
			const rec4 = recordOf(w, "LD-TEST-0300");
			eq([w.calls.render.length, rec4 && rec4.invoiceTextSha256 === rec2.invoiceTextSha256, rec4 && rec4.fingerprintAtDraftSha256 === rec3.fingerprintAtDraftSha256], [2, true, true],
				"§17 ...and a change after the draft builds nothing more (the report compares the render made before it)");

			// A refusal keeps its code, with no digest, and waits for the load to change.
			w.now += 5 * MIN;
			w.ready("LD-TEST-0301");
			w.prepareHook = (id) => (id === "LD-TEST-0301" ? { ok: false, http: 422, code: "TOTAL_MISMATCH" } : null);
			await job.tick();
			const refused = recordOf(w, "LD-TEST-0301");
			eq(refused && [refused.code, Boolean(refused.refusedAt), "renderedAt" in refused, "invoiceTextSha256" in refused, "retryAt" in refused], ["TOTAL_MISMATCH", true, false, false, false],
				"§17 a load the builder refuses keeps its refusal code, with no digest");
			const prepares = () => w.calls.prepare.filter((p) => p.loadId === "LD-TEST-0301").length;
			w.now += 5 * MIN;
			await job.tick();
			eq(prepares(), 1, "§17 ...and is not tried again while the load is unchanged");
			w.prepareHook = null;
			w.setRow("LD-TEST-0301", { "  Payment  ": "$1,100.00" });
			w.now += 5 * MIN;
			await job.tick();
			ok((recordOf(w, "LD-TEST-0301") || {}).renderedAt, "§17 ...the load changes: built, and its digest replaces the refusal");

			// No rate con yet: looked at again every 2 hours, three times, as the job would.
			w.ready("LD-TEST-0302");
			w.prepareHook = (id) => (id === "LD-TEST-0302" ? { ok: false, http: 422, code: "RATECON_MISSING" } : null);
			const seen = [];
			for (let i = 0; i < 5; i++) {
				await job.tick();
				const r = recordOf(w, "LD-TEST-0302");
				seen.push(r ? [r.code, r.checks || 0, Boolean(r.retryAt)] : null);
				w.now += 2 * HOUR;
			}
			eq(seen, [["RATECON_MISSING", 1, true], ["RATECON_MISSING", 2, true], ["RATECON_MISSING", 3, true], ["RATECON_MISSING", 4, false], ["RATECON_MISSING", 4, false]],
				"§17 RATECON_MISSING: re-checked every 2 hours, three times, then left for a person");
			w.prepareHook = null;

			// A busy renderer stores nothing, and the load is built a few minutes later.
			w.ready("LD-TEST-0303");
			w.renderThrows = Object.assign(new Error("made-up: renderer busy"), { code: "RENDERER_BUSY" });
			await job.tick();
			eq(recordOf(w, "LD-TEST-0303"), null, "§17 a busy renderer: nothing stored");
			w.renderThrows = null;
			w.now += 6 * MIN;
			await job.tick();
			ok(recordOf(w, "LD-TEST-0303") && recordOf(w, "LD-TEST-0303").renderedAt, "§17 ...and built on a later sweep");
			eq(nothing(), [0, 0, 0, 0, 0, 0, 0], "§17 still no number, reservation, Gmail, record or SMTP call after all of it");
		} finally {
			reserve.restore();
		}
	}
	{
		// The job's caps, the Friday evening quiet window and Gemini's latch.
		const w = makeWorld();
		w.richRender = true;
		const job = w.job(SHADOW_ON);
		await job.tick();
		w.now += 5 * MIN;
		for (const id of ["LD-TEST-0310", "LD-TEST-0311", "LD-TEST-0312"]) w.ready(id);
		await job.tick();
		eq(w.calls.render.length, 2, "§17 two builds a sweep (the job's per-sweep cap)");
		w.now += 5 * MIN;
		await job.tick();
		eq(w.calls.render.length, 3, "§17 ...the third on the next sweep");
		const capped = makeWorld();
		capped.richRender = true;
		const capJob = capped.job({ ...SHADOW_ON, env: { AUTO_INVOICE_DRAFTS_SHADOW: "", AUTO_INVOICE_MAX_PER_HOUR: "1" } });
		await capJob.tick();
		capped.now += 5 * MIN;
		capped.ready("LD-TEST-0313");
		capped.ready("LD-TEST-0314");
		for (let i = 0; i < 3; i++) { await capJob.tick(); capped.now += 5 * MIN; }
		eq(capped.calls.render.length, 1, "§17 the hourly cap counts the builds");
		const friday = makeWorld();
		friday.richRender = true;
		friday.now = Date.parse("2026-10-23T22:30:00Z"); // Friday 6:30 PM Eastern
		const fJob = friday.job(SHADOW_ON);
		await fJob.tick();
		friday.now += 5 * MIN;
		friday.ready("LD-TEST-0315", { "Status Update Date": "10/23/2026 9:00:00", "Completion Date": "10/23/2026 9:00:00" });
		const quiet = await fJob.tick();
		eq([friday.calls.render.length, quiet.sweep && quiet.sweep.renders], [0, { rendered: 0, refused: 0, quiet: true }], "§17 Friday evening (Eastern): no build, the weekly batch keeps the renderer");
		friday.now = Date.parse("2026-10-24T04:05:00Z"); // Saturday, just after midnight
		await fJob.tick();
		eq(friday.calls.render.length, 1, "§17 ...built after midnight");
		const down = makeWorld();
		down.richRender = true;
		const dJob = down.job(SHADOW_ON);
		await dJob.tick();
		down.now += 5 * MIN;
		down.geminiDownAt = down.now - 5 * MIN;
		down.ready("LD-TEST-0316");
		await dJob.tick();
		eq(down.calls.prepare.length, 0, "§17 Gemini seen down: a non-Bison load is not built (no engine call)");
	}

	// ---------------------------------------------------------------- §17b
	section("§17b the render shadow off: the shadow is today's");
	for (const [label, extra] of [["no setting", { env: { AUTO_INVOICE_DRAFTS_SHADOW: "" } }],
		["the server setting given but the wiring's flag false", { env: { AUTO_INVOICE_DRAFTS_SHADOW: "", AUTO_INVOICE_SHADOW_RENDERS_ENABLED: "true" }, shadowRenders: false }],
		["the flag on in real-draft mode (read only in shadow)", { env: { AUTO_INVOICE_DRAFTS_SHADOW: "false" }, shadowRenders: true, onMode: true }]]) {
		const w = makeWorld();
		w.richRender = true;
		const job = w.job(extra);
		eq(job.shadowRenders, false, `§17b ${label}: the render shadow is off`);
		if (extra.onMode) continue;
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0320");
		w.setRow("LD-TEST-0321");
		const out = await job.tick();
		const rows = w.db.prepare("SELECT load_key, load_id, first_seen_at, ready_at, verdict, reason_code, facts_json, updated_at FROM auto_invoice_shadow ORDER BY load_key").all();
		const t1 = new Date(w.now).toISOString();
		const facts = (pods) => JSON.stringify({ bison: false, domain: "example-broker.test", optedOut: false, month: "open", deliveryDate: true, pods, podsUnreadable: 0,
			rateConRows: 0, advanceLines: 0, drafted: false, bisonRecipient: true, freemail: false, confirmed: true });
		eq(rows, [
			{ load_key: "ld-test-0320", load_id: "LD-TEST-0320", first_seen_at: t1, ready_at: t1, verdict: "WOULD_ATTEMPT", reason_code: "", facts_json: facts(1), updated_at: t1 },
			{ load_key: "ld-test-0321", load_id: "LD-TEST-0321", first_seen_at: t1, ready_at: "", verdict: "WOULD_WAIT", reason_code: "WAITING_POD", facts_json: facts(0), updated_at: t1 },
		], `§17b ${label}: the shadow rows, column for column, as the shadow writes them today`);
		eq(out.sweep, { mode: "shadow", logged: 2 }, `§17b ${label}: the sweep's answer as today`);
		eq(Object.keys(ledgerLib.getMeta(w.db)).sort(), ["last_sweep_at", "shadow_baseline_at"], `§17b ${label}: the meta rows as today`);
		eq([w.calls.prepare.length, w.calls.render.length, w.calls.mint.length, w.calls.append.length, w.calls.record.length], [0, 0, 0, 0, 0], `§17b ${label}: no engine, number or Gmail call`);
		let digests = null;
		try { digests = w.db.prepare("SELECT render_digest_json FROM auto_invoice_shadow").all().map((r) => r.render_digest_json); } catch { digests = null; }
		eq(digests, ["", ""], `§17b ${label}: render_digest_json stays empty`);
	}

	// ---------------------------------------------------------------- §18
	section("§18 the draft's digest, and the render shadow's parity with the real draft");
	// Two copies of one world: the render shadow builds load 123456789 on Oct 20;
	// real drafts draft it on Oct 21 (another number, another date).
	const world = () => {
		const w = makeWorld();
		w.richRender = true;
		w.captureMime = true;
		return w;
	};
	const shadowRender = async (mutate) => {
		const w = world();
		w.mutateShadow = mutate || null;
		w.keepShadowMessage = true;
		const job = w.job(SHADOW_ON);
		await job.tick();
		w.now += 5 * MIN;
		w.ready("123456789");
		await job.tick();
		return { w, rec: recordOf(w, "123456789") };
	};
	const realDraft = async () => {
		const w = world();
		w.now += 24 * HOUR;
		const job = await w.started();
		w.ready("123456789", { "Status Update Date": "10/21/2026 9:00:00", "Completion Date": "10/21/2026 9:00:00" });
		await job.tick();
		return w;
	};
	const real = await realDraft();
	const claim = real.claim("123456789");
	eq(claim && [claim.state, claim.invoice_id, claim.invoice_date], ["drafted", "10212026-1", "2026-10-21"], "§18 real drafts: drafted with number N and day D");
	const mime = real.mimes[0];
	ok(Buffer.isBuffer(mime) && mime.length > 0, "§18 the fake IMAP server kept the MIME it was handed");
	let stored = null;
	try {
		stored = claim && claim.draft_digest_json ? JSON.parse(claim.draft_digest_json) : null;
	} catch {
		stored = null;
	}
	ok(stored && stored.renderedAt, "§18 FAILS ON THE OLD CODE: the claim keeps the digest of what it handed to Gmail (draft_digest_json)");
	const sent = mimeRead && mime ? rules.messageDigest(mimeRead.parseMessage(mime), { renderedAt: stored ? stored.renderedAt : "" }) : null;
	ok(sent && stored && JSON.stringify(sent) === JSON.stringify(stored), "§18 the claim's digest equals messageDigest() of what the fake IMAP server received, field by field");
	ok(sent && /^[0-9a-f]{64}$/.test(sent.invoiceTextSha256), "§18 ...its invoice text read back from the MIME");

	const { rec } = await shadowRender();
	eq(digestPart(rec), digestPart(sent), "§18 parity: the render shadow's stored digest (placeholder number, Oct 20) equals the Sent copy's (N, Oct 21), number and date masked, field by field");
	const verdict = trialReport && mime && rec ? trialReport.judge({ expected: rec, candidates: [trialReport.sentCopy({ raw: mime })], nothingAfter: () => true }) : null;
	eq(verdict, { found: "one", failed: [] }, "§18 ...and the report's six conditions, run on that MIME as the Sent copy, all hold");

	// Item 3: a render shadow that differs from the real draft in any way fails.
	const judgeShadow = (r) => (trialReport && r && r.renderedAt ? trialReport.judge({ expected: r, candidates: [trialReport.sentCopy({ raw: mime })], nothingAfter: () => true }).failed : ["(no digest)"]);
	const swap = (xs, i, j) => { const ys = [...xs]; [ys[i], ys[j]] = [ys[j], ys[i]]; return ys; };
	for (const [label, mutate, want] of [
		["edits the body", (o) => ({ ...o, html: o.html.replace("Thank you,", "Thank you very much,") }), ["body"]],
		["drops an attachment (the POD)", (o) => ({ ...o, attachments: o.attachments.filter((a) => !/_POD\.pdf$/.test(a.filename)) }), ["attachments"]],
		["adds an attachment", (o) => ({ ...o, attachments: [...o.attachments, { filename: "extra.pdf", content: Buffer.from("made-up extra") }] }), ["attachments"]],
		["reorders the attachments", (o) => ({ ...o, attachments: swap(o.attachments, 1, 2) }), ["attachments"]],
		["swaps the rate con", (o) => ({ ...o, attachments: o.attachments.map((a) => (/^123456789\.pdf$/.test(a.filename) ? { ...a, content: Buffer.from("%PDF-1.4 made-up other rate con") } : a)) }), ["attachments"]],
		["changes the amount on the invoice", (o) => ({ ...o, attachments: o.attachments.map((a, i) => (i === 0 ? { ...a, content: textPdf(`INVOICE Invoice ID # : ${rules.SHADOW_INVOICE_ID} Date: 10/20/2026 Made-up Co. $1,000.01`) } : a)) }), ["attachments"]],
		["changes the subject", (o) => ({ ...o, subject: `${o.subject} ` }), ["subject"]],
	]) {
		const m = await shadowRender(mutate);
		eq(judgeShadow(m.rec), want, `§18 MUTANT a render shadow that ${label}: caught (${want.join(", ")})`);
	}
	{
		// A recipient changed in the build is refused by buildMessage() itself; one
		// changed after it (in the digest) fails the recipient condition.
		const m = await shadowRender((o) => ({ ...o, to: "other@example-broker.test" }));
		eq(m.rec && [m.rec.code, "renderedAt" in m.rec], ["DRAFT_REFUSED", false], "§18 MUTANT a render shadow that changes the recipient: refused by the builder, no digest to match");
		eq(judgeShadow(rec && { ...rec, recipient: "other@example-broker.test" }), ["recipient"], "§18 MUTANT a digest with another recipient: caught (recipient)");
	}
	{
		// Skipping the masking: the shadow's placeholder number and day stay in its
		// invoice text, so it can never equal a real invoice's.
		const RULES_FILE = path.join(ROOT, "lib", "auto-invoice-rules.js");
		const unmasked = mutantModule(RULES_FILE, "invoiceTextSha256 = masked ? sha256(masked) : \"\";", "invoiceTextSha256 = masked ? sha256(collapse(shownText(asBuffer(atts[inv].content)))) : \"\";");
		ok(unmasked, "§18 MUTANT skip the masking: applied to lib/auto-invoice-rules.js once");
		const { w: sw } = await shadowRender();
		const shadowMsg = sw.shadowMessages[0];
		if (unmasked && shadowMsg && mimeRead) {
			const a = unmasked.messageDigest(shadowMsg, { renderedAt: "x" });
			const b = unmasked.messageDigest(mimeRead.parseMessage(mime), { renderedAt: "x" });
			eq(rules.digestDifferences(a, b), ["attachments"], "§18 MUTANT skip the masking: caught (attachments: the invoice text differs)");
		} else {
			failures.push("§18 MUTANT skip the masking: not evaluated");
		}
	}
	{
		// Item 5 for the parity world: the shadow's spies stay at 0, and the fake
		// IMAP server receives nothing from it.
		const { w } = await shadowRender();
		eq([w.calls.mint.length, w.calls.append.length, w.calls.record.length, w.mimes.length], [0, 0, 0, 0], "§18 the render shadow's world: no number, no append, no record, nothing at the fake IMAP server");
	}

	// ---------------------------------------------------------------- §19
	section("§19 the render records' keeping time: the decision plus 30 days, 45 days at most");
	if (typeof ledgerLib.setRenderDigest !== "function") {
		failures.push("§19 FAILS ON THE OLD CODE: the ledger stores and prunes render records (setRenderDigest, pruneRenderDigests)");
	} else {
		const DAY = 24 * HOUR;
		const w = makeWorld();
		const put = (id, record) => {
			ledgerLib.upsertShadow(w.db, { key: rules.loadKey(id), loadId: id, verdict: "WOULD_ATTEMPT", nowIso: new Date(w.now).toISOString() });
			ledgerLib.setRenderDigest(w.db, rules.loadKey(id), JSON.stringify(record), new Date(w.now).toISOString());
		};
		const kept = (id) => Boolean(shadowRowOf(w, id) && shadowRowOf(w, id).render_digest_json);
		const first = w.job(SHADOW_ON);
		await first.tick();
		const ago = (days) => new Date(w.now - days * DAY).toISOString();
		put("LD-TEST-0340", { v: 1, renderedAt: ago(44), recipient: "billing@example-broker.test" });
		put("LD-TEST-0341", { v: 1, renderedAt: ago(45), recipient: "billing@example-broker.test" });
		put("LD-TEST-0342", { v: 1, refusedAt: ago(46), code: "TOTAL_MISMATCH" });
		await first.tick();
		eq([kept("LD-TEST-0340"), kept("LD-TEST-0341"), kept("LD-TEST-0342")], [true, true, true], "§19 the prune runs once a day: not again on the same day");
		w.now += 6 * HOUR;
		const next = w.job(SHADOW_ON);
		await next.tick();
		eq([kept("LD-TEST-0340"), kept("LD-TEST-0341"), kept("LD-TEST-0342")], [true, false, false], "§19 FAILS ON THE OLD CODE: no decision: cleared 45 days after the render (a refusal too), kept before");
		ok(shadowRowOf(w, "LD-TEST-0341") && shadowRowOf(w, "LD-TEST-0341").verdict === "WOULD_ATTEMPT", "§19 ...only the record is cleared; the shadow row stays");
		put("LD-TEST-0343", { v: 1, renderedAt: ago(10), recipient: "billing@example-broker.test" });
		ledgerLib.setMeta(w.db, "send_pass:example-broker.test", JSON.stringify({ source: "shadow", passedAt: ago(28), reportSha256: "a".repeat(64) }));
		w.now += DAY;
		await next.tick();
		eq([kept("LD-TEST-0340"), kept("LD-TEST-0343")], [false, true], "§19 a recorded pass: kept until 30 days after it");
		w.now += DAY;
		await next.tick();
		eq(kept("LD-TEST-0343"), false, "§19 ...cleared at the decision plus 30 days");
		const w2 = makeWorld();
		const j2 = w2.job(SHADOW_ON);
		await j2.tick();
		ledgerLib.upsertShadow(w2.db, { key: "ld-test-0344", loadId: "LD-TEST-0344", verdict: "WOULD_ATTEMPT", nowIso: new Date(w2.now).toISOString() });
		ledgerLib.setRenderDigest(w2.db, "ld-test-0344", JSON.stringify({ v: 1, renderedAt: new Date(w2.now - 2 * DAY).toISOString() }), new Date(w2.now).toISOString());
		ledgerLib.setMeta(w2.db, "draft_week:example-broker.test", JSON.stringify({ source: "shadow", decidedAt: new Date(w2.now - 31 * DAY).toISOString() }));
		const offJob = jobLib.create({ ...w2.deps(), env: {} });
		eq([offJob.mode, Boolean(w2.db.prepare("SELECT render_digest_json FROM auto_invoice_shadow WHERE load_key = 'ld-test-0344'").get().render_digest_json)], ["off", false],
			"§19 a recorded draft week counts as the decision too; with the job off, the prune runs at start");
	}

	// ---------------------------------------------------------------- §20
	section("§20 one builder, one digest: every path's message comes from buildMessage()");
	{
		const JOB_SRC = fs.readFileSync(path.join(ROOT, "lib", "auto-invoice-job.js"), "utf8");
		const REPORT_FILE = path.join(ROOT, "scripts", "auto-invoice-send-trial-report.js");
		const REPORT_SRC = fs.existsSync(REPORT_FILE) ? fs.readFileSync(REPORT_FILE, "utf8") : "";
		const parity = (src, report) => {
			const block = /\/\/ <build-message>([\s\S]*?)\/\/ <\/build-message>/.exec(src);
			if (!block) return ["no <build-message> block"];
			// Code only: comment lines name these functions too. The engine's own
			// timeout wrapper (d.engine.prepare) is the engine, not a caller.
			const strip = (s) => s.replace(/^[ \t]*\/\/.*$/gm, "");
			const inside = strip(block[1]);
			const outside = strip(src.replace(block[0], ""));
			const code = strip(src);
			const rep = strip(report);
			const count = (s, re) => (s.match(re) || []).length;
			const out = [];
			if (count(inside, /(?<![.\w])engine\.prepare\(/g) !== 1 || count(inside, /(?<![.\w])engine\.render\(/g) !== 1) out.push("the block calls engine.prepare and engine.render once each");
			if (/(?<![.\w])engine\.(prepare|render)\(/.test(outside)) out.push("no engine.prepare or engine.render outside the block");
			if (count(code, /\bbuildMessage\.prepare\(/g) !== 3 || count(code, /\bbuildMessage\.render\(/g) !== 3) out.push("the draft, the recovery and the render shadow build through buildMessage()");
			if (count(code, /\brules\.messageDigest\(/g) !== 1 || !/const digestOf = \(message, renderedAt\) => rules\.messageDigest\(message, \{ renderedAt \}\);/.test(code)) out.push("one digest helper, rules.messageDigest()");
			if (count(code, /\bdigestOf\(/g) !== 2) out.push("the draft and the render shadow store digestOf()");
			if (/createHash/.test(code)) out.push("no digest of its own");
			if (!/to: message\.to,\s+subject: message\.subject,\s+html: message\.html,\s+attachments: message\.attachments,/.test(code)) out.push("Gmail gets buildMessage()'s message");
			if (count(rep, /\brules\.messageDigest\(/g) !== 1 || !/rules\.messageDigest\(m, \{ renderedAt:/.test(rep)) out.push("the report digests a Sent copy with rules.messageDigest()");
			if (count(rep, /createHash/g) !== 1) out.push("the report hashes nothing but its own counts");
			return out;
		};
		eq(parity(JOB_SRC, REPORT_SRC), [], "§20 FAILS ON THE OLD CODE: one builder and one digest for the render shadow, the draft path and the report");
		for (const [label, src, report] of [
			["the render shadow calling engine.render itself", JOB_SRC.replace("msg = await buildMessage.render(built, facts, { invoiceId: rules.SHADOW_INVOICE_ID", "msg = await engine.render(built.ctx, { invoiceId: rules.SHADOW_INVOICE_ID"), REPORT_SRC],
			["a second digest in the job", JOB_SRC.replace("// Every digest the job keeps", "const otherDigest = (m) => require(\"crypto\").createHash(\"sha256\").update(String(m.html)).digest(\"hex\");\n\t// Every digest the job keeps"), REPORT_SRC],
			["Gmail handed the rendered fields directly", JOB_SRC.replace("subject: message.subject,", "subject: rendered.subject,"), REPORT_SRC],
			["a report with its own Sent digest", JOB_SRC, REPORT_SRC.replace("digest: rules.messageDigest(m, { renderedAt:", "digest: ownDigest(m, { renderedAt:")],
		]) {
			ok(parity(src, report).length > 0, `§20 MUTANT ${label}: caught`);
		}
	}

	// ---------------------------------------------------------------- §21
	section("§21 a load drafted before the render shadow built it");
	// Delivered Friday 6:35 PM Eastern (the quiet window, no build), drafted by a
	// person at 7 PM, and the next sweep after midnight.
	const draftedInQuiet = async (lib = jobLib) => {
		const w = makeWorld();
		w.richRender = true;
		w.now = Date.parse("2026-10-23T22:30:00Z");
		const job = lib.create(w.deps(SHADOW_ON));
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0350", { "Status Update Date": "10/23/2026 9:00:00", "Completion Date": "10/23/2026 9:00:00" });
		const quiet = await job.tick();
		w.now += 25 * MIN;
		w.handDraft("LD-TEST-0350", "10232026-7");
		await job.tick();
		w.now = Date.parse("2026-10-24T04:05:00Z");
		const sat = await job.tick();
		return { w, job, quiet, sat, rec: recordOf(w, "LD-TEST-0350") };
	};
	// A person drafts while the load is being built; `before`: a render made first,
	// then a change to the load, so the draft comes during the build again.
	const draftedWhileBuilt = async ({ before = false } = {}, lib = jobLib) => {
		const w = makeWorld();
		w.richRender = true;
		const job = lib.create(w.deps(SHADOW_ON));
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0351");
		let first = null;
		if (before) {
			await job.tick();
			first = recordOf(w, "LD-TEST-0351");
			w.now += 5 * MIN;
			w.setRow("LD-TEST-0351", { "  Payment  ": "$1,250.00" });
		}
		w.renderHook = (ctx) => { if (ctx.loadId === "LD-TEST-0351" && !w.draftRows("LD-TEST-0351").length) w.handDraft("LD-TEST-0351", "10202026-71"); };
		await job.tick();
		return { w, first, rec: recordOf(w, "LD-TEST-0351") };
	};
	{
		const { w, job, quiet, sat, rec } = await draftedInQuiet();
		eq([shadowRowOf(w, "LD-TEST-0350") && shadowRowOf(w, "LD-TEST-0350").verdict, quiet.sweep && quiet.sweep.renders], ["WOULD_ATTEMPT", { rendered: 0, refused: 0, quiet: true }],
			"§21 delivered in the Friday evening quiet window: WOULD_ATTEMPT, nothing built");
		eq([w.calls.prepare.length, w.calls.render.length, sat.sweep && sat.sweep.renders], [0, 0, { rendered: 0, refused: 1 }],
			"§21 FAILS ON THE OLD CODE: drafted by a person at 7 PM: nothing built after midnight, no engine call (no Drive or Gemini either)");
		eq(rec && Object.keys(rec), ["v", "refusedAt", "code", "domain", "fingerprintSha256"], "§21 ...its record: a code, the domain, the fingerprint, no digest");
		eq(rec && [rec.code, rec.domain, rec.refusedAt], ["DRAFTED_BEFORE_RENDER", "example-broker.test", new Date(w.now).toISOString()],
			"§21 ...DRAFTED_BEFORE_RENDER (the report counts the load unmatched), for the broker's domain");
		w.now += 10 * MIN;
		await job.tick();
		eq([w.calls.prepare.length, JSON.stringify(recordOf(w, "LD-TEST-0350")) === JSON.stringify(rec)], [0, true], "§21 ...and nothing more on the next sweep");
	}
	{
		const { w, rec } = await draftedWhileBuilt();
		eq(rec && [rec.code, "renderedAt" in rec, w.calls.render.length], ["DRAFTED_BEFORE_RENDER", false, 1],
			"§21 FAILS ON THE OLD CODE: a person drafts while the load is being built: nothing built is kept (it could carry that person's note)");
		const again = await draftedWhileBuilt({ before: true });
		const r = again.rec;
		ok(again.first && r && r.renderedAt === again.first.renderedAt && r.invoiceTextSha256 === again.first.invoiceTextSha256 && r.draftSeenAt
			&& r.fingerprintAtDraftSha256 !== r.fingerprintSha256 && again.w.calls.render.length === 2,
		"§21 FAILS ON THE OLD CODE: ...with a render made before: that one is kept, the change before the draft noted (the report counts a difference)");
	}
	{
		const JOB_FILE = path.join(ROOT, "lib", "auto-invoice-job.js");
		for (const [label, from, to, shows] of [
			["the draft rows not read around the build", "const draftedNow = () => ledger.draftRowsFor(db, key).length > 0;", "const draftedNow = () => false;",
				async (lib) => Boolean(((await draftedInQuiet(lib)).rec || {}).renderedAt)],
			["no read before the build (an engine call for a drafted load)", "if (draftedNow()) return draftSeen(key, facts, fp, prev);\n\t\tconst refuse = (code, retry) => {", "const refuse = (code, retry) => {",
				async (lib) => (await draftedInQuiet(lib)).w.calls.prepare.length > 0],
			["no read after the build", "if (!msg.ok) return refuse(msg.code, false);\n\t\tif (draftedNow()) return draftSeen(key, facts, fp, prev);", "if (!msg.ok) return refuse(msg.code, false);",
				async (lib) => Boolean(((await draftedWhileBuilt({}, lib)).rec || {}).renderedAt)],
		]) {
			const lib = mutantModule(JOB_FILE, from, to);
			ok(lib, `§21 MUTANT ${label}: applied to lib/auto-invoice-job.js once`);
			if (!lib) continue;
			ok(!(await shows(jobLib)) && (await shows(lib)), `§21 MUTANT ${label}: caught`);
		}
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

// A case awaiting something that never settles empties the event loop and would
// end the run as a silent pass.
let finished = false;
process.on("beforeExit", () => {
	if (finished) return;
	console.log("\n✗ the run stopped before its last case (a promise never settled)");
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length + 1} failed`);
	process.exit(1);
});

main()
	.catch((e) => failures.push(`the run threw: ${e && e.stack}`))
	.then(() => {
		finished = true;
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
