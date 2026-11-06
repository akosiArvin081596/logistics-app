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
//   §22 a load stays in the shadow week of its first record: rendered on day 6
//       and built again on day 8 (a second POD), drafted after, or refused when
//       built again, its record keeps the first time and domain and the report
//       still judges it in the week; refused on day 6 and rendered on day 8, it
//       joins the population in day 6's week; a load drafted before any render
//       is dated by the person's draft (in the week though recorded after it;
//       outside the week when drafted before the render shadow first ran); one
//       write path; mutants of each
//   §23 factored loads (lib/factoring-store.js): marked while queued, before
//       the number, or between the render and the hand-off, a load is never
//       appended; shadow says WOULD_SKIP LOAD_FACTORED; the render shadow never
//       builds one; a marker that can't be read fails the sweep; mutants of each
//   §24 sending without review (AUTO_INVOICE_SEND_ENABLED, lib/auto-invoice-send.js):
//       with the gate met, one message at the made-up SMTP sender and no APPEND,
//       recorded via auto-smtp with one auto_invoice_sent row; flag off, a domain
//       not listed (or a subdomain of one) and shadow mode draft as before; the
//       last check on the message (SEND_REFUSED); the factoring marker read last,
//       with no wait before the SMTP call, a mark or a throw there sends nothing
//       (LOAD_FACTORED, the number voided, one refusal row); one send per load
//       through a restart, a lost answer, Try again and two workers (Sent Mail is
//       searched at once, +15 and +60 minutes, then MAYBE_SENT; never a resend);
//       the Stop route, the automatic stops and the resume script; the Draft
//       Invoice button's two 409s; the shared via set; mutants of each
//   §25 the settle window before a send (AUTO_INVOICE_SEND_SETTLE_MINUTES, 60):
//       a load whose POD came 30 minutes ago waits (Waiting, SEND_SETTLING) with
//       no engine call or number, and is sent at 61; a second POD at minute 50
//       starts the wait again, and a deleted one doesn't count; a POD uploaded
//       during the build holds the send, its number kept; a queued retry waits
//       before the build; a POD time that can't be read (or from the future) is
//       drafted, never sent; drafts never wait (sending off, a domain not listed,
//       no sender, stopped, Bison's inbox not listed), nor take the sweep's slots;
//       the stored stamps as SQLite reads them; the setting's parse; mutants
//   §26 a change after a send holds that load alone (AUTO_INVOICE_HOLD_ONE_LOAD): the 11-05
//       shape (a POD row added) logged with no chip, stop or email, the next load sent; each
//       field both ways; the switch off is today's stop on every field; the breaker (a third
//       load in 24 hours: TOO_MANY_HELD; one load twice once; 25 hours; a resume; a count
//       that can't be read or written); a row gone from the sheet; an empty read; chips main
//       left; Mark checked, during the sweep's own read and on an empty read; a row removed in
//       the app (its only row, a duplicate, during a read, then Mark checked, the switch off);
//       the resume script's list; mutants
//   §27 the alert emails (AUTO_INVOICE_ALERT_TO): their words, each hold's once however many
//       (six in a sweep, two after a resume, six steps on two loads), the tick's try, the
//       doubling wait kept across a restart, the first false ends a try, emails waiting are
//       never dropped by a sweep, a full outbox keeps its stop, unset sends nothing and the
//       reads say so
//   §28 the dry run before the deploy: its counts equal the first check's, and it writes
//       nothing (the database's sha256 and the meta as they were)
//   §29 what these rules don't touch, by digest against main (ea4497a6)
//
// No network, no files outside a temp folder, never reads app.db.
//   node scripts/test-auto-invoice-job.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const net = require("net");
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
	// Dated by the world's clock, in the server's own format (ISO, whole seconds, Z).
	w.handDraft = (id, invoiceId = "10202026-50") =>
		w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by, created_at) VALUES (?, ?, ?, 'ratecon', 'imap', 'made-up-admin', ?)")
			.run(id, invoiceId, "billing@example-broker.test", new Date(w.now).toISOString().replace(/\.\d{3}Z$/, "Z"));
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
			// A render whose files differ from the engine's own (the send's last check).
			if (w.mutateRender) out = w.mutateRender(out);
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
		// The 5-minute sweep: the driver's trigger has its own runner, and off leaves this exact.
		env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false", ...(extra.env || {}) },
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
		...(extra.env ? { env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false", ...extra.env } } : {}),
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
		// This world sets no alert address, so the read also says alerts are off (item 118).
		eq((await call("GET", "/api/auto-invoice/settings")).body, { optOutDomains: ["example-factor.test"], confirmedBrokerDomains: ["example-broker.test"], unreadable: false, dropped: [], alerts: { on: false } },
			"§11 and read back (FAILS ON THE OLD CODE: with alerts off, item 118)");
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
		// No alert address in this world either, so the read also says alerts are off (item 118).
		eq((await call("GET", "/api/auto-invoice/settings")).body, { optOutDomains: [], confirmedBrokerDomains: [], unreadable: true, dropped: [], alerts: { on: false } }, "§12 L6: the settings route says so");
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
		// alerts: no alert address in this world (item 118).
		eq(got, { optOutDomains: ["example-optout.test"], confirmedBrokerDomains: ["example-broker.test"], unreadable: false,
			dropped: [{ list: "confirmedBrokerDomains", domain: "comcast.net", code: "CONFIRMED_DOMAIN_FREEMAIL" }], alerts: { on: false } }, "§14 GET: each list read on its own; only the refused entry is dropped, and reported");
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
	await factoredSections();
	await sendSections();
	await settleSections();
	await holdSections();
}

// ------------------------------------------------------------------ factored loads
// The marker as lib/factoring-store.js keeps it (a tree before it gets the same
// columns, so its job's run fails by name).
const factoringStore = optional(path.join(ROOT, "lib", "factoring-store.js"));
const markFactored = (w, id) => {
	if (factoringStore) factoringStore.ensureSchema(w.db);
	else w.db.exec("CREATE TABLE IF NOT EXISTS load_factoring (load_key TEXT PRIMARY KEY, load_id TEXT NOT NULL DEFAULT '', factored INTEGER NOT NULL, source TEXT NOT NULL, set_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
	w.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES (?, ?, 1, 'script', ?, ?)")
		.run(rules.loadKey(id), id, new Date(w.now).toISOString(), new Date(w.now).toISOString());
};
const enginePrepares = (w, id) => w.calls.prepare.filter((p) => rules.loadKey(p.loadId) === rules.loadKey(id)).length;

// Each case runs on a job library (the real one, or a mutant) and answers its
// observations, so a mutant's run can be compared with the real one's.
const FACTORED_CASES = {
	// Marked while its claim is queued: skipped by the sweep, never reaches the
	// engine, a number or Gmail.
	async queued(lib) {
		const w = makeWorld();
		const job = lib.create(w.deps());
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0400");
		await job.sweep();
		const before = w.state("LD-TEST-0400");
		markFactored(w, "LD-TEST-0400");
		await job.tick();
		w.now += 20 * MIN;
		await job.tick();
		return { before, after: w.state("LD-TEST-0400"), prepares: enginePrepares(w, "LD-TEST-0400"), mint: w.calls.mint.length, append: w.calls.append.length };
	},
	// Marked between the prepare and the number: reserveNumber() mints nothing.
	async atNumber(lib) {
		const w = makeWorld();
		const job = lib.create(w.deps());
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0401");
		w.prepareHook = (id) => { if (rules.loadKey(id) === "ld-test-0401") markFactored(w, id); return null; };
		await job.tick();
		w.prepareHook = null;
		const c = w.claim("LD-TEST-0401");
		return { state: [c.state, c.reason_code, c.lease_owner], mint: w.calls.mint.length, append: w.calls.append.length };
	},
	// Marked between the render and the hand-off: the re-check catches it and
	// voids the number, with one audit row. (The marking route refuses a working
	// claim, so the mark is written directly.)
	async afterRender(lib) {
		const w = makeWorld();
		const job = lib.create(w.deps());
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0402");
		w.renderHook = (ctx) => { if (rules.loadKey(ctx.loadId) === "ld-test-0402") markFactored(w, ctx.loadId); };
		await job.tick();
		w.renderHook = null;
		const c = w.claim("LD-TEST-0402");
		return { state: [c.state, c.reason_code], voided: Boolean(c.number_voided_at), number: c.invoice_id, mint: w.calls.mint.length, append: w.calls.append.length,
			voidRows: w.actions("auto_invoice_number_void").length, drafts: w.draftRows("LD-TEST-0402").length };
	},
	// Shadow: a load first seen factored, and a WOULD_WAIT row marked later.
	async shadow(lib) {
		const w = makeWorld();
		const job = lib.create(w.deps({ env: { AUTO_INVOICE_DRAFTS_SHADOW: "" } }));
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0403");
		markFactored(w, "LD-TEST-0403");
		w.setRow("LD-TEST-0404");
		await job.tick();
		const waited = shadowRowOf(w, "LD-TEST-0404");
		markFactored(w, "LD-TEST-0404");
		w.now += 5 * MIN;
		await job.tick();
		const a = shadowRowOf(w, "LD-TEST-0403");
		const b = shadowRowOf(w, "LD-TEST-0404");
		return { first: a && [a.verdict, a.reason_code], waitedBefore: waited && waited.verdict, waitedAfter: b && [b.verdict, b.reason_code], prepares: w.calls.prepare.length };
	},
	// The render shadow: a WOULD_ATTEMPT row marked factored before it was built
	// is never built, and its record says LOAD_FACTORED.
	async renderShadow(lib) {
		const w = makeWorld();
		w.richRender = true;
		const job = lib.create(w.deps(SHADOW_ON));
		await job.tick();
		w.now += 5 * MIN;
		w.geminiDownAt = w.now;
		w.ready("LD-TEST-0405");
		await job.tick();
		const before = shadowRowOf(w, "LD-TEST-0405");
		const builtBefore = w.calls.prepare.length;
		markFactored(w, "LD-TEST-0405");
		w.geminiDownAt = null;
		w.now += 5 * MIN;
		await job.tick();
		w.now += 5 * MIN;
		await job.tick();
		const rec = recordOf(w, "LD-TEST-0405");
		return { verdict: before && before.verdict, builtBefore, prepares: w.calls.prepare.length, renders: w.calls.render.length, code: rec && rec.code,
			refusedAt: Boolean(rec && rec.refusedAt), mint: w.calls.mint.length, append: w.calls.append.length };
	},
	// A marker that can't be read: the sweep fails and nothing is drafted.
	async unreadable(lib) {
		const w = makeWorld();
		const job = lib.create(w.deps());
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0406");
		w.db.exec("CREATE TABLE load_factoring (load_key TEXT PRIMARY KEY)");
		const out = await job.tick();
		return { sweep: out.sweep, mint: w.calls.mint.length, append: w.calls.append.length, prepares: w.calls.prepare.length };
	},
};

async function factoredSections() {
	// ---------------------------------------------------------------- §23
	section("§23 factored loads (Triumph): never drafted, whatever stage the mark lands at");
	const q = await FACTORED_CASES.queued(jobLib);
	eq(q.before, ["queued", ""], "§23 the load is queued before the mark");
	eq(q.after, ["skipped", "LOAD_FACTORED"], "§23 FAILS ON THE OLD CODE: marked while queued: skipped LOAD_FACTORED");
	eq([q.prepares, q.mint, q.append], [0, 0, 0], "§23 FAILS ON THE OLD CODE: ...no engine call, no number, appendGmailDraft never called");

	const n = await FACTORED_CASES.atNumber(jobLib);
	eq([n.state, n.mint, n.append], [["skipped", "LOAD_FACTORED", ""], 0, 0], "§23 FAILS ON THE OLD CODE: marked before the number: reserveNumber() mints nothing, the claim is skipped and released");

	const r = await FACTORED_CASES.afterRender(jobLib);
	eq([r.state, r.voided, r.mint, r.append, r.drafts], [["skipped", "LOAD_FACTORED"], true, 1, 0, 0],
		"§23 FAILS ON THE OLD CODE: marked between the render and the hand-off: caught before Gmail, its number voided");
	eq(r.voidRows, 1, "§23 ...with one auto_invoice_number_void audit row");

	const s = await FACTORED_CASES.shadow(jobLib);
	eq(s.first, ["WOULD_SKIP", "LOAD_FACTORED"], "§23 FAILS ON THE OLD CODE: shadow: a load first seen factored is WOULD_SKIP LOAD_FACTORED");
	eq([s.waitedBefore, s.waitedAfter], ["WOULD_WAIT", ["WOULD_SKIP", "LOAD_FACTORED"]], "§23 FAILS ON THE OLD CODE: shadow: a WOULD_WAIT row marked later turns WOULD_SKIP LOAD_FACTORED");
	eq(s.prepares, 0, "§23 ...and shadow calls no engine");

	const rs = await FACTORED_CASES.renderShadow(jobLib);
	eq([rs.verdict, rs.builtBefore], ["WOULD_ATTEMPT", 0], "§23 the render shadow: the load is WOULD_ATTEMPT and not yet built (Gemini's latch)");
	eq([rs.prepares, rs.renders, rs.mint, rs.append], [0, 0, 0, 0], "§23 FAILS ON THE OLD CODE: marked factored, it is never built (the engine spies stay at 0)");
	eq([rs.code, rs.refusedAt], ["LOAD_FACTORED", true], "§23 FAILS ON THE OLD CODE: ...and its record says LOAD_FACTORED");

	const u = await FACTORED_CASES.unreadable(jobLib);
	eq([u.sweep, u.mint, u.append, u.prepares], [{ mode: "on", error: "SWEEP_FAILED" }, 0, 0, 0], "§23 FAILS ON THE OLD CODE: a marker that can't be read: SWEEP_FAILED, nothing drafted");

	// Each decision removed in turn: the case that pins it must change.
	const JOB_FILE = path.join(ROOT, "lib", "auto-invoice-job.js");
	for (const [label, from, to, caseName, pinned] of [
		["the sweep's facts without the marker", "factored: snap.factored.has(key),", "factored: false,", "queued", (x) => x.prepares === 0 && x.after[1] === "LOAD_FACTORED"],
		["no release on reserveNumber()'s 'factored'", "if (r.reason === \"factored\") {", "if (false) {", "atNumber", (x) => x.state[0] === "skipped"],
		["no re-check after the render", "if (ledger.factoredOrUnreadable(db, key)) return release(rendering, \"skipped\", \"LOAD_FACTORED\");", "", "afterRender", (x) => x.append === 0],
		["the render shadow builds a factored row", "if (facts.factored) {\n\t\t\t\tif (!prev", "if (false) {\n\t\t\t\tif (!prev", "renderShadow", (x) => x.renders === 0 && x.code === "LOAD_FACTORED"],
		["an unreadable marker read as none", "factored: factoring.factoredKeys(db) };", "factored: (() => { try { return factoring.factoredKeys(db); } catch { return new Set(); } })() };", "unreadable", (x) => x.append === 0],
	]) {
		const lib = mutantModule(JOB_FILE, from, to);
		ok(lib, `§23 MUTANT ${label}: applied to lib/auto-invoice-job.js once`);
		if (!lib) continue;
		ok(pinned(await FACTORED_CASES[caseName](jobLib)) && !pinned(await FACTORED_CASES[caseName](lib)), `§23 MUTANT ${label}: caught`);
	}
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
			eq(rec && Object.keys(rec), ["v", "renderedAt", "recipient", "cc", "bcc", "subjectSha256", "bodyTextSha256", "invoiceTextSha256", "attachments", "fingerprintSha256", "firstAt", "firstDomain"],
				"§17 the record: the digest's fields, the fingerprint's hash, and when and for which domain the load got its first record; nothing else");
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
			if (count(code, /\bdigestOf\(/g) !== 3) out.push("the draft, the send and the render shadow store digestOf()");
			if (/createHash/.test(code)) out.push("no digest of its own");
			if (count(code, /to: message\.to,\s+subject: message\.subject,\s+html: message\.html,\s+attachments: message\.attachments,/g) !== 2) out.push("Gmail's draft and the SMTP send get buildMessage()'s message");
			if (count(rep, /\brules\.messageDigest\(/g) !== 1 || !/rules\.messageDigest\(m, \{ renderedAt:/.test(rep)) out.push("the report digests a Sent copy with rules.messageDigest()");
			if (count(rep, /createHash/g) !== 1) out.push("the report hashes nothing but its own counts");
			return out;
		};
		eq(parity(JOB_SRC, REPORT_SRC), [], "§20 FAILS ON THE OLD CODE: one builder and one digest for the render shadow, the draft path and the report");
		for (const [label, src, report] of [
			["the render shadow calling engine.render itself", JOB_SRC.replace("msg = await buildMessage.render(built, facts, { invoiceId: rules.SHADOW_INVOICE_ID", "msg = await engine.render(built.ctx, { invoiceId: rules.SHADOW_INVOICE_ID"), REPORT_SRC],
			["a second digest in the job", JOB_SRC.replace("// Every digest the job keeps", "const otherDigest = (m) => require(\"crypto\").createHash(\"sha256\").update(String(m.html)).digest(\"hex\");\n\t// Every digest the job keeps"), REPORT_SRC],
			["Gmail handed the rendered fields directly", JOB_SRC.replace("subject: message.subject,", "subject: rendered.subject,"), REPORT_SRC],
			["the SMTP send handed the rendered fields directly", (() => {
				const at = JOB_SRC.lastIndexOf("attachments: message.attachments,");
				return at < 0 ? JOB_SRC : `${JOB_SRC.slice(0, at)}attachments: rendered.attachments,${JOB_SRC.slice(at + "attachments: message.attachments,".length)}`;
			})(), REPORT_SRC],
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
		eq(rec && Object.keys(rec), ["v", "refusedAt", "code", "domain", "fingerprintSha256", "firstAt", "firstDomain"], "§21 ...its record: a code, the domain, the fingerprint, its first-record time and domain, no digest");
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

	// ---------------------------------------------------------------- §22
	section("§22 a load stays in the shadow week of its first record");
	// The report on the job's own database, long after every period closed, with
	// no Sent copy for anything.
	const weekOf = async (w) => {
		if (!trialReport) return null;
		const c = (await trialReport.report({ db: w.db, mode: "shadow", domains: ["example-broker.test"], fetchSent: async () => [], zone: ET, nowMs: Date.parse("2026-11-20T15:00:00Z") })).counts;
		return { since: c.window.since, population: c.population, unmatched: c.unmatched, outside: c.outside, complete: c.complete, reason: c.reason };
	};
	const unmatchedOf = (o) => ({ total: 0, none: 0, several: 0, late: 0, rebuildRefused: 0, ...o });
	// The render shadow goes on Tuesday 10-20 (its week: 10-20 to 10-26). A load is
	// rendered on Monday 10-26 (day 6); a second POD comes on Wednesday 10-28 (day 8)
	// before anyone drafted it, so it is built again after the week.
	const builtAgainAfter = async (lib = jobLib) => {
		const w = makeWorld();
		w.richRender = true;
		const job = lib.create(w.deps(SHADOW_ON));
		await job.tick();
		w.now += 5 * MIN;
		await job.tick();
		w.now = Date.parse("2026-10-26T14:00:00Z");
		w.ready("LD-TEST-0360", { "Status Update Date": "10/26/2026 9:00:00", "Completion Date": "10/26/2026 9:00:00" });
		await job.tick();
		const first = recordOf(w, "LD-TEST-0360");
		w.now = Date.parse("2026-10-28T14:00:00Z");
		w.addPod("LD-TEST-0360");
		await job.tick();
		return { w, job, first, rec: recordOf(w, "LD-TEST-0360") };
	};
	// The render shadow goes on Saturday 10-17 (its week: 10-17 to Friday 10-23). A
	// load delivered Friday 6:35 PM Eastern (the quiet window, nothing built) is
	// drafted by a person at 7 PM; the job sees it after midnight, after the week.
	const draftedLateFriday = async (lib = jobLib) => {
		const w = makeWorld();
		w.richRender = true;
		w.now = Date.parse("2026-10-17T14:00:00Z");
		const job = lib.create(w.deps(SHADOW_ON));
		await job.tick();
		w.now += 5 * MIN;
		await job.tick();
		w.now = Date.parse("2026-10-23T22:35:00Z");
		w.ready("LD-TEST-0361", { "Status Update Date": "10/23/2026 18:30:00", "Completion Date": "10/23/2026 18:30:00" });
		await job.tick();
		w.now = Date.parse("2026-10-23T23:00:00Z");
		w.handDraft("LD-TEST-0361", "10232026-8");
		await job.tick();
		w.now = Date.parse("2026-10-24T04:05:00Z");
		await job.tick();
		return { w, rec: recordOf(w, "LD-TEST-0361") };
	};
	{
		const { w, job, first, rec } = await builtAgainAfter();
		eq(first && [first.renderedAt, first.firstAt, first.firstDomain], ["2026-10-26T14:00:00.000Z", "2026-10-26T14:00:00.000Z", "example-broker.test"],
			"§22 FAILS ON THE OLD CODE: rendered on day 6: its record is its first, for the broker's domain");
		eq(rec && [w.calls.render.length, rec.renderedAt, rec.firstAt, rec.firstDomain], [2, "2026-10-28T14:00:00.000Z", "2026-10-26T14:00:00.000Z", "example-broker.test"],
			"§22 FAILS ON THE OLD CODE: a second POD on day 8, nobody drafted it: built again, and the record still says it was first made on day 6");
		eq(await weekOf(w), { since: "2026-10-20", population: 1, unmatched: unmatchedOf({ total: 1, none: 1 }), outside: { refused: 0, otherDomains: 0 }, complete: true, reason: "unmatched" },
			"§22 FAILS ON THE OLD CODE: the report still has it in the week's population, judged (never sent: unmatched, FAIL), not \"population 0, outside 0\"");
		w.now = Date.parse("2026-10-29T14:00:00Z");
		w.handDraft("LD-TEST-0360", "10292026-3");
		await job.tick();
		const drafted = recordOf(w, "LD-TEST-0360");
		eq(drafted && [drafted.draftSeenAt, drafted.renderedAt, drafted.firstAt], ["2026-10-29T14:00:00.000Z", "2026-10-28T14:00:00.000Z", "2026-10-26T14:00:00.000Z"],
			"§22 ...a person drafts it on day 9: the day-8 render kept with the draft noted, and its first time too");
		eq((await weekOf(w) || {}).population, 1, "§22 ...still in the week");
	}
	{
		const { w, job } = await builtAgainAfter();
		w.now = Date.parse("2026-10-30T14:00:00Z");
		w.setRow("LD-TEST-0360", { "  Payment  ": "$1,250.00", "Status Update Date": "10/26/2026 9:00:00", "Completion Date": "10/26/2026 9:00:00" });
		w.prepareHook = (id) => (id === "LD-TEST-0360" ? { ok: false, http: 422, code: "TOTAL_MISMATCH" } : null);
		await job.tick();
		const rec = recordOf(w, "LD-TEST-0360");
		eq(rec && [rec.code, "renderedAt" in rec, rec.firstAt, rec.firstDomain], ["TOTAL_MISMATCH", false, "2026-10-26T14:00:00.000Z", "example-broker.test"],
			"§22 FAILS ON THE OLD CODE: built again on day 10 and refused: the refusal replaces the render and keeps the first time and domain");
		eq(await weekOf(w), { since: "2026-10-20", population: 1, unmatched: unmatchedOf({ total: 1, rebuildRefused: 1 }), outside: { refused: 0, otherDomains: 0 }, complete: true, reason: "unmatched" },
			"§22 FAILS ON THE OLD CODE: ...the report keeps it in the population (built again and refused: unmatched), not counted outside as refused");
	}
	{
		// Refused on day 6, its first record; rendered on day 8 once the load changed.
		const w = makeWorld();
		w.richRender = true;
		const job = w.job(SHADOW_ON);
		await job.tick();
		w.now += 5 * MIN;
		await job.tick();
		w.now = Date.parse("2026-10-26T14:00:00Z");
		w.ready("LD-TEST-0362", { "Status Update Date": "10/26/2026 9:00:00", "Completion Date": "10/26/2026 9:00:00" });
		w.prepareHook = (id) => (id === "LD-TEST-0362" ? { ok: false, http: 422, code: "TOTAL_MISMATCH" } : null);
		await job.tick();
		const refused = recordOf(w, "LD-TEST-0362");
		const then = await weekOf(w);
		w.prepareHook = null;
		w.now = Date.parse("2026-10-28T14:00:00Z");
		w.setRow("LD-TEST-0362", { "  Payment  ": "$1,100.00", "Status Update Date": "10/26/2026 9:00:00", "Completion Date": "10/26/2026 9:00:00" });
		await job.tick();
		const rec = recordOf(w, "LD-TEST-0362");
		eq([refused && refused.firstAt, refused && "firstDomain" in refused, then && [then.population, then.outside.refused]], ["2026-10-26T14:00:00.000Z", false, [0, 1]],
			"§22 FAILS ON THE OLD CODE: refused on day 6: its first record, for no domain yet, counted outside as refused");
		eq(rec && [rec.renderedAt, rec.firstAt, rec.firstDomain], ["2026-10-28T14:00:00.000Z", "2026-10-26T14:00:00.000Z", "example-broker.test"],
			"§22 FAILS ON THE OLD CODE: ...rendered on day 8 once the load changed: still first recorded on day 6, now for the broker's domain");
		eq(((await weekOf(w)) || {}).population, 1, "§22 FAILS ON THE OLD CODE: ...so it is judged in day 6's week (its first record of any kind)");
	}
	{
		const { w, rec } = await draftedLateFriday();
		eq([w.calls.prepare.length, rec && rec.code, rec && rec.refusedAt], [0, "DRAFTED_BEFORE_RENDER", "2026-10-24T04:05:00.000Z"],
			"§22 drafted at 7 PM Friday in the quiet window: no engine call, its record written after midnight, after the week");
		eq(rec && [rec.firstAt, rec.firstDomain], ["2026-10-23T23:00:00.000Z", "example-broker.test"], "§22 FAILS ON THE OLD CODE: ...dated as a first record by the person's draft (7 PM, in the week)");
		eq(await weekOf(w), { since: "2026-10-17", population: 1, unmatched: unmatchedOf({ total: 1, late: 1 }), outside: { refused: 0, otherDomains: 0 }, complete: true, reason: "unmatched" },
			"§22 FAILS ON THE OLD CODE: ...so it is in the week's population (unmatched, FAIL) though its record came after the week");
		const before = await draftedInQuiet();
		eq([ledgerLib.getMeta(before.w.db).shadow_renders_on_at, before.rec && before.rec.firstAt, ((await weekOf(before.w)) || {}).population], ["2026-10-24T04:05:00.000Z", "2026-10-23T23:00:00.000Z", 0],
			"§22 FAILS ON THE OLD CODE: a load drafted before the render shadow first ran (§21's world) is outside its week, not unmatched in it");
	}
	{
		const JOB_FILE = path.join(ROOT, "lib", "auto-invoice-job.js");
		const code = fs.readFileSync(JOB_FILE, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
		const at = code.indexOf("function storeRecord(");
		const body = at < 0 ? "" : code.slice(at, code.indexOf("\n\t}\n", at));
		eq([(code.match(/ledger\.setRenderDigest\(/g) || []).length, /ledger\.setRenderDigest\(/.test(body)], [1, true],
			"§22 FAILS ON THE OLD CODE: every record the render shadow writes goes through storeRecord(), its one write");
		for (const [label, from, to, shows] of [
			["the first time not carried through a later build", "firstAt: was.firstAt || was.renderedAt || was.refusedAt || firstAt", "firstAt",
				async (lib) => ((await weekOf((await builtAgainAfter(lib)).w)) || {}).population === 1],
			["a load drafted before any render dated by when the sweep saw it", "fingerprintSha256: fp }, at, firstDraftAt(key, nowMs));", "fingerprintSha256: fp }, at);",
				async (lib) => ((await weekOf((await draftedLateFriday(lib)).w)) || {}).population === 1 && ((await weekOf((await draftedInQuiet(lib)).w)) || {}).population === 0],
		]) {
			const lib = mutantModule(JOB_FILE, from, to);
			ok(lib, `§22 MUTANT ${label}: applied to lib/auto-invoice-job.js once`);
			if (!lib) continue;
			ok((await shows(jobLib)) && !(await shows(lib)), `§22 MUTANT ${label}: caught`);
		}
		const bypass = code.replace("storeRecord(key, { ...digestOf(msg.message, at), fingerprintSha256: fp }, at);", "ledger.setRenderDigest(db, key, JSON.stringify({ ...digestOf(msg.message, at), fingerprintSha256: fp }), at);");
		ok(bypass !== code && (bypass.match(/ledger\.setRenderDigest\(/g) || []).length !== 1, "§22 MUTANT a render stored around storeRecord(): caught by the one-write check");
	}
}

// ------------------------------------------------------------------ sending (§24)
// Absent from a tree before sending: its cases fail by name instead of the run.
const sendLib = optional(path.join(ROOT, "lib", "auto-invoice-send.js"));
const resumeScript = optional(path.join(ROOT, "scripts", "auto-invoice-send-resume.js"));
const SEND_DOMAIN = "example-broker.test";
const SEND_ON = Object.freeze({ enabled: true, domains: [SEND_DOMAIN] });
const SENT_BOX = "[Gmail]/Sent Mail";
const smtpError = (outcome, code) => Object.assign(new Error(`made-up SMTP failure for ${BROKER}`), { code, outcome });

// A world whose job may send: the engine's rich render (the invoice, a POD and
// the rate con) and a made-up SMTP sender that keeps what it is handed. Sent
// messages land in the fake Gmail's Sent Mail (w.sent), as Gmail keeps an SMTP
// send's copy. Behaviours, one per send: OK, LOGIN, REFUSED, LOST (no answer, not
// delivered), SENT_NO_ANSWER (delivered, no answer), CRASH_AFTER (delivered, the
// process dies), CRASH_BEFORE (the process dies first).
function sendWorld({ send = SEND_ON, dbFile = null } = {}) {
	const w = makeWorld({ dbFile });
	w.richRender = true;
	w.smtp = [];
	w.smtpBehaviors = [];
	w.events = [];
	w.sendMail = async (o) => {
		w.events.push("send");
		if (w.onSend) w.onSend(o);
		w.smtp.push({ to: o.to, from: o.from, user: o.user, subject: o.subject, messageId: o.messageId, attachments: (o.attachments || []).map((a) => a.filename) });
		const b = w.smtpBehaviors.shift() || "OK";
		if (b === "OK") { w.sent.push(o.messageId); return { ok: true }; }
		if (b === "LOGIN") throw smtpError("login", "EAUTH");
		if (b === "REFUSED") throw smtpError("refused", "EENVELOPE");
		if (b === "LOST") throw smtpError("unknown", "ETIMEDOUT");
		if (b === "SENT_NO_ANSWER") { w.sent.push(o.messageId); throw smtpError("unknown", "ETIMEDOUT"); }
		if (b === "CRASH_AFTER") { w.sent.push(o.messageId); return never(); }
		if (b === "CRASH_BEFORE") return never();
		throw new Error(`unknown behaviour ${b}`);
	};
	w.sendDeps = (more = {}) => w.deps({ send, sendMail: w.sendMail, ...more });
	w.stop = () => {
		try {
			return ledgerLib.getSendStop ? ledgerLib.getSendStop(w.db) : null;
		} catch {
			return null;
		}
	};
	return w;
}
// A send-capable job past its first baseline, the clock moved on 5 minutes.
async function sendStarted(lib, w, more = {}) {
	const job = lib.create(w.sendDeps(more));
	await job.tick();
	w.now += 5 * MIN;
	return job;
}
// Runs `fn` with module exports replaced, then puts them back.
async function withPatched(patches, fn) {
	const saved = patches.map(([obj, name]) => [obj, name, obj[name]]);
	for (const [obj, name, value] of patches) obj[name] = value;
	try {
		return await fn();
	} finally {
		for (const [obj, name, value] of saved) obj[name] = value;
	}
}
const claimOf = (w, id) => w.claim(id) || {};

// An SMTP server stand-in on 127.0.0.1, inside this process (each case closes
// it): made-up addresses only. Modes: "ok"; "drop-after-data" (the whole message
// arrives, then the connection drops); "silent-after-data" (no reply to it);
// "554-after-data"; "rcpt-550"; "auth-535"; "drop-at-greeting"; "closed-port"
// (nothing listens).
function smtpStandIn(mode) {
	const st = { connections: 0, messages: 0, rcpt: [] };
	const socks = new Set();
	const srv = net.createServer((sock) => {
		socks.add(sock);
		sock.on("close", () => socks.delete(sock));
		sock.on("error", () => {});
		st.connections++;
		if (mode === "drop-at-greeting") return sock.destroy();
		let inData = false;
		let buf = "";
		sock.write("220 made-up.test ESMTP\r\n");
		sock.on("data", (chunk) => {
			buf += chunk.toString("latin1");
			for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (inData) {
					if (line !== ".") continue;
					inData = false;
					st.messages++;
					if (mode === "drop-after-data") sock.destroy();
					else if (mode === "554-after-data") sock.write("554 made-up refusal\r\n");
					else if (mode !== "silent-after-data") sock.write("250 queued\r\n");
					continue;
				}
				const cmd = line.slice(0, 4).toUpperCase();
				if (cmd === "EHLO") sock.write("250-made-up.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
				else if (cmd === "AUTH") sock.write(mode === "auth-535" ? "535 made-up refusal\r\n" : "235 ok\r\n");
				else if (cmd === "RCPT") { st.rcpt.push(line.slice(8)); sock.write(mode === "rcpt-550" ? "550 made-up refusal\r\n" : "250 ok\r\n"); }
				else if (cmd === "DATA") { inData = true; sock.write("354 go ahead\r\n"); }
				else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
				else sock.write("250 ok\r\n");
			}
		});
	});
	const close = () => new Promise((r) => { for (const s of socks) s.destroy(); srv.close(() => r()); });
	return new Promise((resolve) => srv.listen(0, "127.0.0.1", async () => {
		const port = srv.address().port;
		if (mode === "closed-port") await close();
		resolve({ st, port, close: mode === "closed-port" ? async () => {} : close });
	}));
}
// The real nodemailer, pointed at the stand-in instead of Gmail, with short timeouts.
const realMailer = require(path.join(ROOT, "node_modules", "nodemailer"));
const toStandIn = (port) => ({ createTransport: (opts) => realMailer.createTransport({
	host: "127.0.0.1", port, secure: false, ignoreTLS: true, auth: opts.auth, connectionTimeout: 1500, greetingTimeout: 1500, socketTimeout: 500,
}) });
// One message through lib/auto-invoice-send.js's sender (`lib`) to a stand-in in `mode`.
async function standInSend(mode, lib = sendLib) {
	if (!lib) return { outcome: "no sender", messages: -1, connections: -1, rcpt: [] };
	const s = await smtpStandIn(mode);
	const mail = { user: MAILBOX.user, pass: MAILBOX.pass, from: `LogisX Inc. <${MAILBOX.user}>`, to: "billing@example-broker.test", subject: "Made-up Order #123456789",
		html: "<p>made-up</p>", attachments: [], messageId: "<made-up-standin@example.com>" };
	let out;
	try {
		await lib.createSmtpSender({ nodemailer: toStandIn(s.port) })(mail);
		out = { outcome: "sent" };
	} catch (e) {
		out = { outcome: e && e.outcome, code: e && e.code };
	}
	await s.close();
	return { ...out, messages: s.st.messages, connections: s.st.connections, rcpt: s.st.rcpt };
}

const SEND_CASES = {
	// The whole gate met: one message by SMTP, no draft; recorded as the job's send.
	async sends(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0500");
		await job.tick();
		const first = { smtp: w.smtp.length, append: w.calls.append.length };
		w.now += 6 * MIN;
		await job.tick();
		w.now += 60 * MIN;
		await job.tick();
		const c = claimOf(w, "LD-TEST-0500");
		const rows = [{ ...w.rows[0] }];
		job.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: true });
		let digest = null;
		try { digest = JSON.parse(c.draft_digest_json || "null"); } catch { digest = null; }
		return {
			...first,
			smtpAfter: w.smtp.length,
			appendAfter: w.calls.append.length,
			state: [c.state, c.reason_code, c.delivery, c.stage, Boolean(c.sent_at)],
			rows: w.draftRows("LD-TEST-0500"),
			records: w.calls.record.map((r) => r.via),
			sentRows: w.actions("auto_invoice_sent").map((a) => [a.who, a.details]),
			other: c.load_key ? ledgerLib.otherDraftRows(w.db, c).length : -1,
			message: w.smtp[0] ? { ...w.smtp[0], idIsClaims: w.smtp[0].messageId === c.message_id, messageId: undefined } : null,
			digest: digest && [digest.recipient, digest.attachments.map((a) => a.name)],
			annotation: rows[0]._autoInvoice,
			logsClean: !w.logs.some((l) => /@/.test(l)),
		};
	},
	// Anything short of the whole gate drafts as before. `make(w)` sets the world up.
	async drafts(lib, { send = SEND_ON, extra = {}, setup = null } = {}) {
		const w = sendWorld({ send });
		const job = await sendStarted(lib, w, extra);
		if (setup) setup(w);
		else w.ready("LD-TEST-0501");
		await job.tick();
		const id = setup ? w.sendCaseId : "LD-TEST-0501";
		const c = claimOf(w, id);
		return { smtp: w.smtp.length, append: w.calls.append.length, state: [c.state, c.reason_code], delivery: c.delivery || "",
			refused: w.actions("auto_invoice_send_refused").map((a) => a.details) };
	},
	// The last check on the message: a render whose files aren't the engine's own.
	async lastCheck(lib, mutate) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0502");
		w.mutateRender = mutate;
		await job.tick();
		w.mutateRender = null;
		const c = claimOf(w, "LD-TEST-0502");
		return { smtp: w.smtp.length, append: w.calls.append.length, state: [c.state, c.reason_code], voided: Boolean(c.number_voided_at),
			refused: w.actions("auto_invoice_send_refused").map((a) => a.details), notices: w.notices.map((n) => n.title) };
	},
	// The marker read last: marked (or unreadable) right after the render's own
	// re-check, before the send. The marking route refuses a working claim, so the
	// mark is written directly.
	async factoredAtSend(lib, { throws = false } = {}) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0510");
		const check3 = ledgerLib.factoredOrUnreadable;
		const isFactored = factoringStore && factoringStore.isFactored;
		let armed = false;
		await withPatched([
			[ledgerLib, "factoredOrUnreadable", (db, key) => {
				const r = check3(db, key);
				if (throws) armed = true;
				else markFactored(w, "LD-TEST-0510");
				return r;
			}],
			...(factoringStore ? [[factoringStore, "isFactored", (db, key) => {
				if (armed) throw Object.assign(new Error("made-up: the marker can't be read"), { code: "SQLITE_CORRUPT" });
				return isFactored(db, key);
			}]] : []),
		], () => job.tick());
		const c = claimOf(w, "LD-TEST-0510");
		return { smtp: w.smtp.length, append: w.calls.append.length, state: [c.state, c.reason_code], voided: Boolean(c.number_voided_at), number: c.invoice_id,
			refused: w.actions("auto_invoice_send_refused").map((a) => a.details), voidRows: w.actions("auto_invoice_number_void").length, drafts: w.draftRows("LD-TEST-0510").length, w, job };
	},
	// The marker is the last thing read before the SMTP call, with no wait between:
	// a microtask queued by the read runs only after the call.
	async lastBeforeSend(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0512");
		const isFactored = factoringStore && factoringStore.isFactored;
		if (!factoringStore) return { before: "", after: "", smtp: 0 };
		await withPatched([[factoringStore, "isFactored", (db, key) => {
			w.events.push("marker");
			queueMicrotask(() => w.events.push("next microtask"));
			return isFactored(db, key);
		}]], () => job.tick());
		const at = w.events.indexOf("send");
		return { before: at > 0 ? w.events[at - 1] : "", after: at >= 0 ? w.events[at + 1] : "", smtp: w.smtp.length };
	},
	// A hand draft lands after the render's re-check, before the send.
	async handDraftAtSend(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0513");
		const check3 = ledgerLib.factoredOrUnreadable;
		await withPatched([[ledgerLib, "factoredOrUnreadable", (db, key) => { const r = check3(db, key); w.handDraft("LD-TEST-0513"); return r; }]], () => job.tick());
		const c = claimOf(w, "LD-TEST-0513");
		return { smtp: w.smtp.length, append: w.calls.append.length, state: [c.state, c.reason_code], voided: Boolean(c.number_voided_at) };
	},
	// Sending is stopped after the gate read it open, before the send: the stop is
	// set at the read made once the message is rendered (the job's earlier reads,
	// before the build, see it open).
	async stopAtSend(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0514");
		const read = ledgerLib.getSendStop;
		await withPatched([[ledgerLib, "getSendStop", (db) => {
			const r = read(db);
			if (claimOf(w, "LD-TEST-0514").stage === "rendered") ledgerLib.setSendStop(db, { reason: "STOPPED_BY_ADMIN", nowIso: new Date(w.now).toISOString() });
			return r;
		}]], () => job.tick());
		const c = claimOf(w, "LD-TEST-0514");
		return { smtp: w.smtp.length, append: w.calls.append.length, state: [c.state, c.reason_code], delivery: c.delivery || "", rows: w.draftRows("LD-TEST-0514") };
	},
	// A send with no answer: Sent Mail at once, at +15 and at +60 minutes, then a
	// person; never sent again. `landsAt`: the search after which the copy appears.
	async unanswered(lib, { behaviour = "LOST", landsAt = 0 } = {}) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0520");
		w.smtpBehaviors = [behaviour];
		const states = [];
		const step = async (ms) => {
			w.now += ms;
			await job.tick();
			if (landsAt && w.calls.search.length >= landsAt && !w.sent.length && w.smtp[0]) w.sent.push(w.smtp[0].messageId);
			states.push(w.state("LD-TEST-0520"));
		};
		await step(0);
		await step(5 * MIN);
		await step(10 * MIN);
		await step(45 * MIN);
		const stop = w.stop();
		const c = claimOf(w, "LD-TEST-0520");
		return { states, smtp: w.smtp.length, append: w.calls.append.length, searches: w.calls.search.length, boxes: w.calls.searchBoxes,
			stop: stop && stop.reason, notices: w.notices.map((n) => n.title), sentRows: w.actions("auto_invoice_sent").length,
			rows: w.draftRows("LD-TEST-0520"), checks: c.send_checks, w, job };
	},
	// A crash while sending, then a restart.
	async restart(lib, behaviour) {
		const w = sendWorld();
		const before = await sendStarted(lib, w, { workerId: "before-crash" });
		w.ready("LD-TEST-0521");
		w.smtpBehaviors = [behaviour];
		before.tick();
		const reached = await until(() => w.smtp.length === 1, `§24 crash (${behaviour}): the send is reached`);
		await tick();
		w.now += 16 * MIN;
		const after = lib.create(w.sendDeps({ workerId: "after-restart" }));
		for (let i = 0; i < 6; i++) {
			await after.tick();
			w.now += 15 * MIN;
		}
		const c = claimOf(w, "LD-TEST-0521");
		const stop = w.stop();
		return { reached, smtp: w.smtp.length, append: w.calls.append.length, state: [c.state, c.reason_code], searches: w.calls.search.length,
			boxes: [...new Set(w.calls.searchBoxes.map((b) => b.join("|")))], rows: w.draftRows("LD-TEST-0521"), stop: stop && stop.reason };
	},
	// Two workers on one database file: one send per load.
	async twoWorkers(lib) {
		const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "auto-invoice-send-"));
		try {
			const w = sendWorld({ dbFile: path.join(TMP, "app.db") });
			w.db.pragma("journal_mode = WAL");
			const jobA = await sendStarted(lib, w, { workerId: "worker-a" });
			const dbB = new Database(path.join(TMP, "app.db"));
			dbB.pragma("busy_timeout = 2000");
			const jobB = lib.create({ ...w.sendDeps({ workerId: "worker-b" }), db: dbB });
			w.ready("LD-TEST-0530");
			w.ready("LD-TEST-0531");
			await Promise.all([jobA.tick(), jobB.tick(), jobA.tick(), jobB.tick()]);
			w.now += 20 * MIN;
			await Promise.all([jobA.tick(), jobB.tick()]);
			const out = { smtp: w.smtp.map((m) => m.subject).sort(), append: w.calls.append.length, states: [w.state("LD-TEST-0530"), w.state("LD-TEST-0531")] };
			dbB.close();
			w.db.close();
			return out;
		} finally {
			fs.rmSync(TMP, { recursive: true, force: true });
		}
	},
	// An SMTP refusal (or a login refusal): nothing left, sending stops, the load is drafted.
	async smtpRefused(lib, behaviour) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0540");
		w.smtpBehaviors = [behaviour];
		await job.tick();
		const c = claimOf(w, "LD-TEST-0540");
		w.now += 5 * MIN;
		w.ready("LD-TEST-0541");
		await job.tick();
		const stop = w.stop();
		return { smtp: w.smtp.length, append: w.calls.append.length, state: [c.state, c.reason_code, c.delivery || ""], rows: w.draftRows("LD-TEST-0540"),
			next: w.state("LD-TEST-0541"), stop: stop && stop.reason, stopRows: w.actions("auto_invoice_send_stopped").length, notices: w.notices.map((n) => n.title) };
	},
	// A load's payment changed after its invoice was sent: a notice, and that load is flagged.
	async changedAfterSend(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0550");
		await job.tick();
		w.now += 5 * MIN;
		w.setRow("LD-TEST-0550", { "  Payment  ": "$1,250.00" });
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0551");
		await job.tick();
		const stop = w.stop();
		return { smtp: w.smtp.length, append: w.calls.append.length, stop: stop && stop.reason, notices: w.notices.map((n) => n.title), next: w.state("LD-TEST-0551"),
			chip: claimOf(w, "LD-TEST-0550").changed_fields };
	},
	// The Stop route, the settings route beside it, and the next tick.
	async stopRoute(lib, { send = SEND_ON } = {}) {
		const w = sendWorld({ send });
		const job = await sendStarted(lib, w);
		const f = fakeApp();
		const limited = [];
		job.mount(f.app, { requireRole: f.requireRole, refuseCrossSite: (req, res, next) => next(), stopLimiter: (req, res, next) => { limited.push(req.session.user.role); next(); } });
		const route = "POST /api/auto-invoice/send/stop";
		const disp = await f.call("POST", "/api/auto-invoice/send/stop", { role: "Dispatcher", body: {} });
		const r1 = await f.call("POST", "/api/auto-invoice/send/stop", { body: { note: "made-up: checking a broker" } });
		const r2 = await f.call("POST", "/api/auto-invoice/send/stop", { body: {} });
		const put = await f.call("PUT", "/api/auto-invoice/settings", { body: { confirmedBrokerDomains: [SEND_DOMAIN, "example-other.test"] } });
		const status = await f.call("GET", "/api/auto-invoice/status");
		const settings = await f.call("GET", "/api/auto-invoice/settings");
		w.ready("LD-TEST-0560");
		await job.tick();
		const stop = w.stop();
		return {
			registered: Boolean(f.routes[route]), chain: f.routes[route] ? f.routes[route].length : 0, limited,
			disp: disp.status, r1: [r1.status, r1.body && r1.body.already, r1.body && r1.body.stopped && r1.body.stopped.reason],
			r2: [r2.status, r2.body && r2.body.already], put: put.status, stop: stop && stop.reason,
			statusSend: status.body && status.body.send ? [status.body.send.domains, status.body.send.stopped && status.body.send.stopped.reason] : null,
			settingsSend: settings.body && settings.body.send ? settings.body.send.stopped && settings.body.send.stopped.reason : null,
			smtp: w.smtp.length, append: w.calls.append.length, next: w.state("LD-TEST-0560"),
			audits: w.actions("auto_invoice_send_stopped").map((a) => [a.who, a.details]),
			clears: Object.keys(f.routes).filter((r) => /resume|clear|unstop|send\/start/i.test(r)),
		};
	},
	// The Draft Invoice button's check.
	async button(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		if (typeof job.draftButtonCheck !== "function") return { missing: true };
		const req = (body = {}) => ({ body, session: { user: { id: 7, username: "made-up-admin", role: "Super Admin" } } });
		const answer = (r) => (r.ok ? "ok" : [r.http, r.json.code]);
		w.ready("LD-TEST-0570");
		w.renderHang = true;
		job.tick();
		await until(() => claimOf(w, "LD-TEST-0570").state === "working", "§24 the button: the claim is working");
		const working = answer(job.draftButtonCheck(req(), "LD-TEST-0570"));
		const workingPreview = answer(job.draftButtonCheck(req(), "LD-TEST-0570", { dryRun: true }));
		const offJob = lib.create(w.deps({ send: { enabled: false, domains: [SEND_DOMAIN] }, sendMail: w.sendMail }));
		const workingOff = answer(offJob.draftButtonCheck(req(), "LD-TEST-0570"));
		w.renderHang = false;
		w.ready("LD-TEST-0571");
		w.now += 20 * MIN;
		const job2 = lib.create(w.sendDeps({ workerId: "worker-2" }));
		await job2.tick();
		await job2.tick();
		const sentClaim = claimOf(w, "LD-TEST-0571");
		const sent = job2.draftButtonCheck(req(), "#LD-TEST-0571");
		const preview = answer(job2.draftButtonCheck(req(), "LD-TEST-0571", { dryRun: true }));
		const noReason = answer(job2.draftButtonCheck(req({ confirmReissue: true, reissueReason: "   " }), "LD-TEST-0571"));
		const notTrue = answer(job2.draftButtonCheck(req({ confirmReissue: "true", reissueReason: "made-up reason" }), "LD-TEST-0571"));
		const reissued = job2.draftButtonCheck(req({ confirmReissue: true, reissueReason: "made-up: corrected rate" }), "LD-TEST-0571");
		const sentOff = answer(offJob.draftButtonCheck(req(), "LD-TEST-0571"));
		const unknown = answer(job2.draftButtonCheck(req(), "LD-TEST-0999"));
		return {
			working, workingPreview, workingOff, sentState: [sentClaim.state, sentClaim.delivery],
			sent: sent.ok ? "ok" : [sent.http, sent.json.code, sent.json.invoiceId === sentClaim.invoice_id, /already been sent|already sent/.test(sent.json.error)],
			preview, noReason, notTrue, reissued: reissued.ok ? [true, reissued.reissue.reason] : answer(reissued),
			reissueRows: w.actions("auto_invoice_reissue_confirmed").map((a) => [a.who, a.details]), sentOff, unknown,
		};
	},
	// The job over the real sender and nodemailer: the stand-in takes the whole
	// message and drops the connection. Maybe delivered: Sent Mail is searched,
	// sending stops, and nothing is drafted.
	async standInJob(lib) {
		const w = sendWorld();
		const s = await smtpStandIn("drop-after-data");
		try {
			const job = await sendStarted(lib, w, { sendMail: sendLib ? sendLib.createSmtpSender({ nodemailer: toStandIn(s.port) }) : undefined });
			w.ready("LD-TEST-0610");
			await job.tick();
		} finally {
			await s.close();
		}
		const c = claimOf(w, "LD-TEST-0610");
		const stop = w.stop();
		return { messages: s.st.messages, state: [c.state, c.reason_code], delivery: c.delivery || "", append: w.calls.append.length, stop: stop && stop.reason, boxes: w.calls.searchBoxes };
	},
	// A Draft Invoice press whose draft is in flight when the job reaches its send
	// (the press's late check ran during the job's render). `pressEnds`: its draft
	// is recorded (the in-flight row swapped for a draft row) or dropped.
	async pressFirst(lib, { pressEnds = "recorded" } = {}) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0600");
		if (factoringStore) factoringStore.ensureSchema(w.db);
		const check3 = ledgerLib.factoredOrUnreadable;
		let press = null;
		await withPatched([[ledgerLib, "factoredOrUnreadable", (db, key) => {
			const r = check3(db, key);
			if (!press && factoringStore) {
				const p = factoringStore.draftBegin(db, { key, loadId: "LD-TEST-0600", invoiceId: "10202026-90", messageId: "<made-up-press@example.com>", path: "imap", nowIso: new Date(w.now).toISOString() });
				press = p.ok ? "ok" : p.code;
			}
			return r;
		}]], () => job.tick());
		const atSend = { smtp: w.smtp.length, append: w.calls.append.length, state: w.state("LD-TEST-0600") };
		if (factoringStore) w.db.prepare("DELETE FROM invoice_draft_inflight WHERE load_key = 'ld-test-0600'").run();
		if (pressEnds === "recorded") w.handDraft("LD-TEST-0600", "10202026-90");
		w.now += 6 * MIN;
		await job.tick();
		const c = claimOf(w, "LD-TEST-0600");
		return { press, atSend, after: { smtp: w.smtp.length, append: w.calls.append.length, state: [c.state, c.reason_code], voided: Boolean(c.number_voided_at) } };
	},
	// The job has committed its send when the press's late check runs (during the
	// SMTP call): through factoring-store's draftBegin(), or the route's own
	// draftHandoff() (`routesLib`), with or without a confirmed re-issue.
	async jobFirst(lib, { reissue = false, routesLib = null } = {}) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0601");
		if (!factoringStore) return { press: null };
		factoringStore.ensureSchema(w.db);
		const routes = routesLib ? routesLib.create({ db: w.db, env: {}, logAudit: (req, action, entity, id, details) => w.audits.push({ who: req.session.user.username, action, id, details }),
			logAuditRefusal: () => {}, newMessageId: () => "<made-up-press@example.com>" }) : null;
		const req = { body: {}, session: { user: { id: 7, username: "made-up-admin", role: "Super Admin" } } };
		let press = null;
		w.onSend = () => {
			if (press) return;
			const args = { loadId: "LD-TEST-0601", invoiceId: "10202026-91", path: "imap", reissue, recipient: "billing@example-broker.test", total: "$1,000.00" };
			if (routes) {
				const h = routes.draftHandoff(req, { ...args, mintedInvoiceId: "10202026-91", user: MAILBOX.user });
				press = h.ok ? "ok" : [h.http, h.json.code];
			} else {
				const r = factoringStore.draftBegin(w.db, { ...args, key: "ld-test-0601", messageId: "<made-up-press@example.com>", nowIso: new Date(w.now).toISOString() });
				press = r.ok ? "ok" : r.code;
			}
		};
		await job.tick();
		w.onSend = null;
		return { press, smtp: w.smtp.length, state: w.state("LD-TEST-0601"), inflight: w.db.prepare("SELECT invoice_id FROM invoice_draft_inflight").all().map((r) => r.invoice_id),
			voids: w.actions("invoice_number_void").map((a) => a.details) };
	},
	// A load whose send got no answer can't be marked factored: it may be with the broker.
	async markWhileUnconfirmed(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0580");
		w.smtpBehaviors = ["LOST"];
		await job.tick();
		const c = claimOf(w, "LD-TEST-0580");
		if (!factoringStore) return { state: [c.state, c.reason_code], mark: null };
		factoringStore.ensureSchema(w.db);
		const r = factoringStore.mark(w.db, { key: "ld-test-0580", loadId: "LD-TEST-0580", reason: "made-up", source: "script", actor: { id: 0, username: "made-up" }, nowIso: new Date(w.now).toISOString() });
		return { state: [c.state, c.reason_code], mark: r.ok ? "marked" : r.code };
	},
	// A send search goes on after a person drafts by hand; a person's draft closes
	// a MAYBE_SENT claim only once the search has handed it over.
	async handDraftWhileSearching(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0590");
		w.smtpBehaviors = ["LOST"];
		await job.tick();
		w.handDraft("LD-TEST-0590", "10202026-60");
		w.now += 15 * MIN;
		await job.tick();
		const searching = w.state("LD-TEST-0590");
		w.now += 45 * MIN;
		await job.tick();
		const handedOver = w.state("LD-TEST-0590");
		w.now += 5 * MIN;
		await job.tick();
		return { searching, handedOver, closed: w.state("LD-TEST-0590"), smtp: w.smtp.length, searches: w.calls.search.length };
	},
};

async function sendSections() {
	// ---------------------------------------------------------------- §24
	section("§24 sending without review (AUTO_INVOICE_SEND_ENABLED)");
	ok(sendLib, "§24 FAILS ON THE OLD CODE: lib/auto-invoice-send.js exists");

	// The gate met: a send, not a draft.
	const s = await SEND_CASES.sends(jobLib);
	eq([s.smtp, s.append], [1, 0], "§24 FAILS ON THE OLD CODE: the whole gate met: one message at the SMTP sender and no APPEND");
	eq([s.smtpAfter, s.appendAfter], [1, 0], "§24 FAILS ON THE OLD CODE: ...and later sweeps send nothing more (one send per load)");
	eq(s.state, ["drafted", "", "send", "recorded", true], "§24 FAILS ON THE OLD CODE: the claim is drafted with delivery 'send', recorded, its send time kept");
	eq(s.rows, [{ invoice_id: "10202026-1", via: "auto-smtp" }], "§24 FAILS ON THE OLD CODE: one draft row, via auto-smtp (the job's send)");
	eq(s.records, ["auto-smtp"], "§24 FAILS ON THE OLD CODE: engine.record() is told the send's via");
	eq(s.sentRows, [["auto-invoice", "10202026-1 → example-broker.test (sent by the automatic invoice job)"]],
		"§24 FAILS ON THE OLD CODE: one auto_invoice_sent row by the system actor: the invoice number and the recipient's domain only");
	eq(s.other, 0, "§24 otherDraftRows() is empty after the send (the sent row is the job's own; the via-set mutant below pins it)");
	eq(s.message, { to: "billing@example-broker.test", from: `LogisX Inc. <${MAILBOX.user}>`, user: MAILBOX.user, subject: "Example Broker Order #LD-TEST-0500",
		attachments: ["Example Broker Invoice Order #LD-TEST-0500.pdf", "LD-TEST-0500_POD.pdf", "LD-TEST-0500.pdf"], idIsClaims: true },
	"§24 FAILS ON THE OLD CODE: the message is the render's own: the one recipient, the subject, the invoice, the POD and the rate con, as they are, with the claim's Message-ID");
	eq(s.digest, ["billing@example-broker.test", ["Example Broker Invoice Order #LD-TEST-0500.pdf", "LD-TEST-0500_POD.pdf", "LD-TEST-0500.pdf"]],
		"§24 the claim keeps the digest of what was sent, as a draft keeps its own");
	eq(s.annotation && s.annotation.sent, true, "§24 FAILS ON THE OLD CODE: a Super Admin's row says the invoice was sent (`sent: true`)");
	ok(s.logsClean, "§24 no email address in the logs");

	// Short of the whole gate: drafts as before.
	const off = await SEND_CASES.drafts(jobLib, { send: { enabled: false, domains: [SEND_DOMAIN] } });
	eq([off.smtp, off.append, off.state, off.delivery], [0, 1, ["drafted", ""], ""], "§24 AUTO_INVOICE_SEND_ENABLED off: a draft, no SMTP call");
	const none = await SEND_CASES.drafts(jobLib, { send: null });
	eq([none.smtp, none.append], [0, 1], "§24 no send settings at all: a draft, no SMTP call");
	const noSender = await SEND_CASES.drafts(jobLib, { extra: { sendMail: undefined } });
	eq([noSender.smtp, noSender.append], [0, 1], "§24 sending on without a sender: a draft");
	eq([off.refused, none.refused], [[], []], "§24 ...and sending off writes no refusal row");
	const notListed = await SEND_CASES.drafts(jobLib, { send: { enabled: true, domains: ["example-other.test"] } });
	eq([notListed.smtp, notListed.append], [0, 1], "§24 a domain not on AUTO_INVOICE_SEND_DOMAINS: a draft");
	eq(notListed.refused, ["10202026-1: DOMAIN_NOT_LISTED (example-broker.test); drafted for a person instead"],
		"§24 FAILS ON THE OLD CODE: ...with one auto_invoice_send_refused row naming the domain (the allowlist's refusal)");
	const sub = await SEND_CASES.drafts(jobLib, { setup: (w) => {
		w.sendCaseId = "LD-TEST-0503";
		setSettings(w.db, { optOutDomains: [], confirmedBrokerDomains: [SEND_DOMAIN, "ap.example-broker.test"] });
		w.ready("LD-TEST-0503", { Email: "ops@ap.example-broker.test" }, "billing@ap.example-broker.test");
	} });
	eq([sub.smtp, sub.append, sub.state], [0, 1, ["drafted", ""]], "§24 a subdomain of a listed domain is not on the list: a draft");
	const shadow = await SEND_CASES.drafts(jobLib, { extra: { env: { AUTO_INVOICE_DRAFTS_SHADOW: "" } } });
	eq([shadow.smtp, shadow.append, shadow.state], [0, 0, [undefined, undefined]], "§24 shadow mode with sending on: nothing sent, nothing drafted");

	// The last check on the message (check 4).
	const renamed = await SEND_CASES.lastCheck(jobLib, (out) => ({ ...out, attachments: out.attachments.map((a, i) => (i === 2 ? { ...a, filename: "LD-TEST-9999.pdf" } : a)) }));
	eq([renamed.smtp, renamed.append, renamed.state, renamed.voided], [0, 0, ["needs_attention", "SEND_REFUSED"], false],
		"§24 FAILS ON THE OLD CODE: a rate con named for another load: SEND_REFUSED, nothing sent or drafted, the number kept");
	eq(renamed.refused, ["10202026-1: SEND_REFUSED (ATTACHMENTS); nothing sent"], "§24 FAILS ON THE OLD CODE: ...one auto_invoice_send_refused row with its reason");
	ok(renamed.notices.includes("Invoice not sent"), "§24 FAILS ON THE OLD CODE: ...and a Super Admin notice");
	const noRateCon = await SEND_CASES.lastCheck(jobLib, (out) => ({ ...out, attachments: out.attachments.slice(0, 2) }));
	eq([noRateCon.smtp, noRateCon.state], [0, ["needs_attention", "SEND_REFUSED"]], "§24 FAILS ON THE OLD CODE: no rate con among the files: SEND_REFUSED");
	const twoTo = mutantModule(path.join(ROOT, "lib", "auto-invoice-job.js"), "message: Object.freeze({ to, subject: rendered.subject,", "message: Object.freeze({ to: `${to}, other@example-broker.test`, subject: rendered.subject,");
	const twoToRun = twoTo ? await SEND_CASES.lastCheck(twoTo, null) : null;
	eq(twoToRun && [twoToRun.smtp, twoToRun.state, twoToRun.refused], [0, ["needs_attention", "SEND_REFUSED"], ["10202026-1: SEND_REFUSED (RECIPIENT); nothing sent"]],
		"§24 FAILS ON THE OLD CODE: a message whose To isn't the one planned recipient (the builder broken): SEND_REFUSED, nothing sent");
	const ccd = mutantModule(path.join(ROOT, "lib", "auto-invoice-job.js"), "message: Object.freeze({ to, subject: rendered.subject,", "message: Object.freeze({ to, cc: \"ap@example-broker.test\", subject: rendered.subject,");
	const ccRun = ccd ? await SEND_CASES.lastCheck(ccd, null) : null;
	eq(ccRun && [ccRun.smtp, ccRun.refused], [0, ["10202026-1: SEND_REFUSED (HEADERS); nothing sent"]], "§24 FAILS ON THE OLD CODE: a message with a Cc: SEND_REFUSED");

	// D5: the factoring marker, read last.
	const before = await SEND_CASES.drafts(jobLib, { setup: (w) => { w.sendCaseId = "LD-TEST-0511"; w.ready("LD-TEST-0511"); markFactored(w, "LD-TEST-0511"); } });
	eq([before.smtp, before.append, before.state], [0, 0, ["skipped", "LOAD_FACTORED"]], "§24 the whole gate met and the load marked factored: no SMTP call and no APPEND");
	const atSend = await SEND_CASES.factoredAtSend(jobLib);
	eq([atSend.smtp, atSend.append, atSend.state, atSend.voided, atSend.drafts], [0, 0, ["needs_attention", "LOAD_FACTORED"], true, 0],
		"§24 FAILS ON THE OLD CODE: marked between the render and the send: no SMTP call, Needs attention LOAD_FACTORED, the number voided");
	eq([atSend.refused, atSend.voidRows], [["10202026-1: LOAD_FACTORED; nothing sent"], 1], "§24 FAILS ON THE OLD CODE: ...one auto_invoice_send_refused row (LOAD_FACTORED) and the number's void row");
	const throwsAt = await SEND_CASES.factoredAtSend(jobLib, { throws: true });
	eq([throwsAt.smtp, throwsAt.append, throwsAt.state], [0, 0, ["needs_attention", "LOAD_FACTORED"]], "§24 FAILS ON THE OLD CODE: isFactored() throwing right before the send: no send (fails closed)");
	// The voided number is never used again: cleared and tried again, a fresh one.
	if (atSend.w && atSend.w.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'load_factoring'").get()) {
		atSend.w.db.prepare("DELETE FROM load_factoring").run();
		const f = fakeApp();
		atSend.job.mount(f.app, { requireRole: f.requireRole });
		await f.call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "ld-test-0510" } });
		atSend.w.now += 5 * MIN;
		await atSend.job.tick();
		const again = claimOf(atSend.w, "LD-TEST-0510");
		eq([again.state, again.delivery, again.invoice_id !== atSend.number, atSend.w.smtp.length], ["drafted", "send", true, 1],
			"§24 FAILS ON THE OLD CODE: the mark cleared and Try again: sent with a fresh number, never the voided one");
	}
	const order = await SEND_CASES.lastBeforeSend(jobLib);
	eq([order.before, order.after, order.smtp], ["marker", "next microtask", 1], "§24 FAILS ON THE OLD CODE: the factoring marker is the last read before the SMTP call, with no wait between them");
	const LEDGER_SRC = fs.readFileSync(path.join(ROOT, "lib", "auto-invoice-ledger.js"), "utf8");
	const JOB_SRC = fs.readFileSync(path.join(ROOT, "lib", "auto-invoice-job.js"), "utf8");
	const sendOrder = (ledgerSrc, jobSrc) => {
		const body = (/function beginSend\([\s\S]*?\n}\n/.exec(ledgerSrc) || [""])[0];
		const at = (s) => body.indexOf(s);
		const steps = ["otherDraftRows(db, claim)", "inflightRows(db, key, nowIso)", "getSendStop(db)", "factoredOrUnreadable(db, key)", "transition(db, key"].map(at);
		const code = jobSrc.replace(/^[ \t]*\/\/.*$/gm, "");
		const between = (/ledger\.beginSend\(([\s\S]*?)await d\.sendMail\(/.exec(code) || [null, null])[1];
		return { ordered: steps.every((n, i) => n > 0 && (i === 0 || n > steps[i - 1])), noWait: between !== null && !/\bawait\b/.test(between) };
	};
	eq(sendOrder(LEDGER_SRC, JOB_SRC), { ordered: true, noWait: true },
		"§24 FAILS ON THE OLD CODE: beginSend() reads the hand drafts, a press's draft in flight, then the stop, then the marker last, then commits; nothing awaited between it and the SMTP call");
	const hand = await SEND_CASES.handDraftAtSend(jobLib);
	eq([hand.smtp, hand.append, hand.state, hand.voided], [0, 0, ["skipped", "DRAFTED_BY_HAND"], true], "§24 FAILS ON THE OLD CODE: a hand draft right before the send wins: nothing sent, the number voided");

	// One send per load.
	const lost = await SEND_CASES.unanswered(jobLib);
	eq(lost.states, [["queued", "SEND_UNCONFIRMED"], ["queued", "SEND_UNCONFIRMED"], ["queued", "SEND_UNCONFIRMED"], ["needs_attention", "MAYBE_SENT"]],
		"§24 FAILS ON THE OLD CODE: an unanswered send: searched at once and at +15 minutes, MAYBE_SENT only after the third search (+60)");
	eq([lost.smtp, lost.append, lost.searches, lost.checks], [1, 0, 3, 3], "§24 FAILS ON THE OLD CODE: ...one SMTP call, never re-sent and never drafted, three searches");
	ok(lost.boxes.length === 3 && lost.boxes.every((b) => JSON.stringify(b) === JSON.stringify([SENT_BOX])), "§24 FAILS ON THE OLD CODE: ...each in Sent Mail only");
	eq(lost.stop, "SEND_UNANSWERED", "§24 FAILS ON THE OLD CODE: ...and sending stops at once (SEND_UNANSWERED), drafts carrying on");
	ok(lost.notices.includes("Invoice may have been sent") && lost.notices.filter((t) => t === "Automatic invoice sending stopped").length === 1,
		"§24 FAILS ON THE OLD CODE: ...a notice for the stop (once) and one for MAYBE_SENT");
	if (lost.job && lost.job.mount) {
		const f = fakeApp();
		lost.job.mount(f.app, { requireRole: f.requireRole });
		const retry = await f.call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "ld-test-0520" } });
		lost.w.now += 5 * MIN;
		await lost.job.tick();
		eq([retry.status, lost.w.state("LD-TEST-0520"), lost.w.smtp.length, lost.w.calls.append.length, lost.w.calls.search.length], [200, ["needs_attention", "MAYBE_SENT"], 1, 0, 4],
			"§24 FAILS ON THE OLD CODE: Try again on MAYBE_SENT searches Sent Mail once more and never sends");
	}
	const late = await SEND_CASES.unanswered(jobLib, { landsAt: 2 });
	eq([late.states[late.states.length - 1], late.smtp, late.append, late.sentRows, late.rows], [["drafted", ""], 1, 0, 1, [{ invoice_id: "10202026-1", via: "auto-smtp" }]],
		"§24 FAILS ON THE OLD CODE: a copy that turns up in Sent Mail later: recorded as sent, never sent twice");
	const delivered = await SEND_CASES.unanswered(jobLib, { behaviour: "SENT_NO_ANSWER" });
	eq([delivered.states[0], delivered.smtp, delivered.searches, delivered.sentRows], [["drafted", ""], 1, 1, 1], "§24 FAILS ON THE OLD CODE: delivered with no answer: found by the first search, recorded");
	const crashSent = await SEND_CASES.restart(jobLib, "CRASH_AFTER");
	eq([crashSent.smtp, crashSent.append, crashSent.state, crashSent.rows, crashSent.boxes], [1, 0, ["drafted", ""], [{ invoice_id: "10202026-1", via: "auto-smtp" }], [SENT_BOX]],
		"§24 FAILS ON THE OLD CODE: a crash after the send, then a restart: found in Sent Mail and recorded; one SMTP call");
	const crashLost = await SEND_CASES.restart(jobLib, "CRASH_BEFORE");
	eq([crashLost.smtp, crashLost.append, crashLost.state, crashLost.searches, crashLost.stop], [1, 0, ["needs_attention", "MAYBE_SENT"], 3, "MAYBE_SENT"],
		"§24 FAILS ON THE OLD CODE: a crash with the send's fate unknown, then a restart: three searches, then MAYBE_SENT; never sent again");
	const two = await SEND_CASES.twoWorkers(jobLib);
	eq(two, { smtp: ["Example Broker Order #LD-TEST-0530", "Example Broker Order #LD-TEST-0531"], append: 0, states: [["drafted", ""], ["drafted", ""]] },
		"§24 FAILS ON THE OLD CODE: two workers on one database: one send per load, no draft");
	const searching = await SEND_CASES.handDraftWhileSearching(jobLib);
	eq([searching.searching, searching.handedOver, searching.closed, searching.smtp], [["queued", "SEND_UNCONFIRMED"], ["needs_attention", "MAYBE_SENT"], ["skipped", "DRAFTED_BY_HAND"], 1],
		"§24 FAILS ON THE OLD CODE: a hand draft while the send is searched for doesn't stop the search; once a person has it (MAYBE_SENT), their draft closes it");
	const mark = await SEND_CASES.markWhileUnconfirmed(jobLib);
	eq(mark, { state: ["queued", "SEND_UNCONFIRMED"], mark: "INVOICE_ALREADY_SENT" }, "§24 FAILS ON THE OLD CODE: a load whose send got no answer can't be marked factored (INVOICE_ALREADY_SENT)");

	// H-1 through the job: nodemailer's own error after the whole message went.
	const dropped = await SEND_CASES.standInJob(jobLib);
	eq([dropped.messages, dropped.state, dropped.delivery, dropped.append, dropped.stop], [1, ["queued", "SEND_UNCONFIRMED"], "send", 0, "SEND_UNANSWERED"],
		"§24 FAILS ON THE OLD CODE: the stand-in took the whole message, then dropped: searched for in Sent Mail, never drafted again, the send kept, sending stopped");
	eq(dropped.boxes, [[SENT_BOX]], "§24 FAILS ON THE OLD CODE: ...searched in Sent Mail at once");

	// M-1: a Draft Invoice press and the job's send: one immediate transaction each, one winner.
	const pressFirst = await SEND_CASES.pressFirst(jobLib);
	eq([pressFirst.press, pressFirst.atSend], ["ok", { smtp: 0, append: 0, state: ["queued", "HAND_DRAFT_IN_FLIGHT"] }],
		"§24 FAILS ON THE OLD CODE: a press's draft in flight when the job reaches its send: nothing sent or drafted, the claim waits");
	eq(pressFirst.after, { smtp: 0, append: 0, state: ["skipped", "DRAFTED_BY_HAND"], voided: true }, "§24 FAILS ON THE OLD CODE: ...the press's draft recorded: the job's claim closes and its number is void");
	const pressDropped = await SEND_CASES.pressFirst(jobLib, { pressEnds: "dropped" });
	eq(pressDropped.after, { smtp: 1, append: 0, state: ["drafted", ""], voided: false }, "§24 ...the press's draft dropped (never made): the job sends on its next look");
	const jobFirstStore = await SEND_CASES.jobFirst(jobLib);
	eq([jobFirstStore.press, jobFirstStore.smtp, jobFirstStore.state, jobFirstStore.inflight], ["INVOICE_SENT_MEANWHILE", 1, ["drafted", ""], []],
		"§24 FAILS ON THE OLD CODE: the job's send committed first: the press's late check refuses it (INVOICE_SENT_MEANWHILE), no draft in flight");
	const routesLibReal = optional(path.join(ROOT, "lib", "factoring-routes.js"));
	const jobFirstRoute = routesLibReal ? await SEND_CASES.jobFirst(jobLib, { routesLib: routesLibReal }) : { press: null, voids: [] };
	eq([jobFirstRoute.press, jobFirstRoute.voids], [[409, "INVOICE_SENT_MEANWHILE"], ["10202026-91 was minted for this load and never used (INVOICE_SENT_MEANWHILE)"]],
		"§24 FAILS ON THE OLD CODE: ...through the route's hand-off: 409, and the press's number voided in the audit log");
	const reissueStore = await SEND_CASES.jobFirst(jobLib, { reissue: true });
	const reissueRoute = routesLibReal ? await SEND_CASES.jobFirst(jobLib, { reissue: true, routesLib: routesLibReal }) : { press: null };
	eq([reissueStore.press, reissueStore.inflight, reissueRoute.press], ["ok", ["10202026-91"], "ok"], "§24 a press that confirmed a re-issue goes on (its draft in flight)");

	// The stops.
	const refused = await SEND_CASES.smtpRefused(jobLib, "REFUSED");
	eq([refused.smtp, refused.append, refused.state, refused.rows, refused.next], [1, 2, ["drafted", "", ""], [{ invoice_id: "10202026-1", via: "auto-imap" }], ["drafted", ""]],
		"§24 FAILS ON THE OLD CODE: Gmail refuses the message: nothing left, the load is drafted with its number, and the next load is drafted too");
	eq([refused.stop, refused.stopRows], ["SMTP_REFUSED", 1], "§24 FAILS ON THE OLD CODE: ...sending stops (SMTP_REFUSED), one audit row");
	const login = await SEND_CASES.smtpRefused(jobLib, "LOGIN");
	eq([login.smtp, login.append, login.stop], [1, 2, "SMTP_LOGIN_REFUSED"], "§24 FAILS ON THE OLD CODE: Gmail refuses the login: drafts carry on, sending stops (SMTP_LOGIN_REFUSED)");
	// Hold one load, not all (AUTO_INVOICE_HOLD_ONE_LOAD, on by default): §26 has the rest.
	const changed = await SEND_CASES.changedAfterSend(jobLib);
	eq([changed.smtp, changed.append, changed.stop, changed.chip, changed.next], [2, 0, null, "payment", ["drafted", ""]],
		"§24 FAILS ON THE OLD CODE: a payment changed after its invoice was sent flags that load (payment) and stops nothing: the next load is sent");
	ok(changed.notices.includes("Sent invoice: load changed"), "§24 FAILS ON THE OLD CODE: ...with a notice that the invoice already went");
	const stopR = await SEND_CASES.stopRoute(jobLib);
	eq([stopR.registered, stopR.chain, stopR.disp, stopR.limited], [true, 4, 403, ["Super Admin", "Super Admin"]],
		"§24 FAILS ON THE OLD CODE: the Stop route: Super Admin, the cross-site check, then the limiter (a Dispatcher is refused before the limiter)");
	eq([stopR.r1, stopR.r2], [[200, false, "STOPPED_BY_ADMIN"], [200, true]], "§24 FAILS ON THE OLD CODE: Stop sets the stop; a second press finds it set");
	eq([stopR.put, stopR.stop, stopR.statusSend, stopR.settingsSend], [200, "STOPPED_BY_ADMIN", [[SEND_DOMAIN], "STOPPED_BY_ADMIN"], "STOPPED_BY_ADMIN"],
		"§24 FAILS ON THE OLD CODE: saving a domain through PUT /api/auto-invoice/settings keeps the stop; status and settings show it");
	eq([stopR.smtp, stopR.append, stopR.next], [0, 1, ["drafted", ""]], "§24 ...and the next tick only drafts");
	eq(stopR.audits, [["made-up-admin", "STOPPED_BY_ADMIN by made-up-admin: made-up: checking a broker"]], "§24 FAILS ON THE OLD CODE: one audit row, by the person who pressed it");
	eq(stopR.clears, [], "§24 no route clears the stop");
	const stopOff = await SEND_CASES.stopRoute(jobLib, { send: { enabled: false, domains: [SEND_DOMAIN] } });
	eq([stopOff.registered, stopOff.statusSend, stopOff.settingsSend], [false, null, null], "§24 sending off: no Stop route, and status and settings answer as before");
	const between = await SEND_CASES.stopAtSend(jobLib);
	eq([between.smtp, between.append, between.state, between.delivery, between.rows], [0, 1, ["drafted", ""], "", [{ invoice_id: "10202026-1", via: "auto-imap" }]],
		"§24 a stop set between the gate and the send: the load is drafted instead, nothing sent (the stop mutant below pins it)");

	// The Draft Invoice button.
	const b = await SEND_CASES.button(jobLib);
	// On a tree without the check every line below fails by name (b.missing).
	ok(!b.missing, "§24 FAILS ON THE OLD CODE: the job exports draftButtonCheck()");
	eq([b.working, b.workingPreview, b.workingOff], [[409, "AUTO_INVOICE_IN_FLIGHT"], "ok", "ok"], "§24 FAILS ON THE OLD CODE: a claim in flight: 409 AUTO_INVOICE_IN_FLIGHT while sending is on (a preview and sending off: as before)");
	eq([b.sentState, b.sent], [["drafted", "send"], [409, "INVOICE_ALREADY_SENT", true, true]], "§24 FAILS ON THE OLD CODE: a load whose invoice the job sent: 409 INVOICE_ALREADY_SENT, naming its invoice");
	eq([b.preview, b.noReason, b.notTrue], ["ok", [409, "INVOICE_ALREADY_SENT"], [409, "INVOICE_ALREADY_SENT"]], "§24 FAILS ON THE OLD CODE: ...a preview is never refused; a re-issue needs confirmReissue true and a reason");
	eq([b.reissued, b.reissueRows], [[true, "made-up: corrected rate"], [["made-up-admin", "re-issue after the automatic send of 10202026-2: made-up: corrected rate"]]],
		"§24 FAILS ON THE OLD CODE: a confirmed re-issue with a reason goes on, audited by the person");
	eq([b.sentOff, b.unknown], [[409, "INVOICE_ALREADY_SENT"], "ok"], "§24 FAILS ON THE OLD CODE: sending switched off later still guards what was sent; a load with no claim: as before");

	// The resume script: the one way the stop is cleared.
	ok(resumeScript, "§24 FAILS ON THE OLD CODE: scripts/auto-invoice-send-resume.js exists");
	if (resumeScript) {
		const w = sendWorld();
		const job = await sendStarted(jobLib, w);
		w.db.exec("CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, user_id INTEGER, username TEXT, role TEXT, action TEXT, entity TEXT, entity_id TEXT, details TEXT)");
		const audits = () => w.db.prepare("SELECT username, role, action, details FROM audit_trail").all();
		eq(resumeScript.run({ db: w.db, dryRun: true }), { dryRun: true, stopped: false, changed: false, unconfirmed: 0 }, "§24 resume, nothing stopped: nothing to do");
		ledgerLib.setSendStop(w.db, { reason: "SMTP_REFUSED", nowIso: "2026-10-20T14:05:00.000Z" });
		const dry = resumeScript.run({ db: w.db, dryRun: true });
		eq([dry.stopped, dry.changed, dry.reason, Boolean(w.stop()), audits().length], [true, true, "SMTP_REFUSED", true, 0], "§24 resume --dry-run: says what it would clear and writes nothing");
		const applied = resumeScript.run({ db: w.db, dryRun: false, nowIso: "2026-10-20T15:00:00.000Z" });
		eq([applied.changed, w.stop(), audits()], [true, null, [{ username: "auto-invoice-send-resume", role: "system", action: "auto_invoice_send_resumed", details: "cleared the stop of 2026-10-20T14:05:00.000Z (SMTP_REFUSED)" }]],
			"§24 resume --apply: the stop cleared, one audit row as a system change");
		eq([resumeScript.run({ db: w.db, dryRun: false }).changed, audits().length], [false, 1], "§24 ...a replay changes nothing");
		w.ready("LD-TEST-0595");
		await job.tick();
		eq(w.smtp.length, 1, "§24 ...and the next load is sent again");
		ledgerLib.setSendStop(w.db, { reason: "SEND_UNANSWERED", nowIso: "2026-10-20T16:00:00.000Z" });
		w.db.prepare("UPDATE auto_invoice_claims SET state = 'needs_attention', reason_code = 'MAYBE_SENT', stage = 'appending' WHERE load_key = 'ld-test-0595'").run();
		let refusedResume = "";
		try {
			resumeScript.run({ db: w.db, dryRun: false });
		} catch (e) {
			refusedResume = e instanceof resumeScript.Refusal ? e.message : `other: ${e && e.message}`;
		}
		ok(/1 send\(s\) not confirmed/.test(refusedResume) && w.stop() && audits().length === 1, "§24 resume refuses while a send is unconfirmed (MAYBE_SENT): nothing cleared");
		const argsRefused = [["--db=x"], ["--dry-run"], ["--db=x", "--dry-run", "--apply"], ["--db=x", "--apply", "--force"]].map((a) => {
			try { resumeScript.parseArgs(a); return "accepted"; } catch (e) { return e instanceof resumeScript.Refusal ? "refused" : "threw"; }
		});
		eq(argsRefused, ["refused", "refused", "refused", "refused"], "§24 resume: --db and exactly one of --dry-run and --apply, nothing else");
	}

	// The pure rules (lib/auto-invoice-send.js).
	const SEND_FILE = path.join(ROOT, "lib", "auto-invoice-send.js");
	const pure = (lib) => {
		if (!lib) return null;
		const ON = { AUTO_INVOICE_SEND_ENABLED: "true", AUTO_INVOICE_SEND_DOMAINS: "Example-Broker.test, example-other.test  gmail.com @example-x.test" };
		const att = (name) => ({ filename: name, content: Buffer.from(`%PDF-1.4 ${name}`) });
		const files = [att("Example Broker Invoice Order #123456789.pdf"), att("123456789_POD.pdf"), att("123456789.pdf")];
		const rendered = { attachments: files };
		const msg = (over = {}) => ({ to: "billing@example-broker.test", subject: "Example Broker Order #123456789", html: "<p>made-up</p>", attachments: files, ...over });
		const check = (over, r = rendered) => lib.outgoingCheck({ message: msg(over), rendered: r, planned: "billing@example-broker.test", domains: [SEND_DOMAIN] });
		// The render's own array, handed on as it is: only the rule under test differs.
		const same = (list) => check({ attachments: list }, { attachments: list });
		return {
			settings: lib.readSettings(ON),
			flags: ["true", " true ", "TRUE", "1", "yes", "", undefined].map((v) => lib.readSettings({ AUTO_INVOICE_SEND_ENABLED: v }).enabled),
			replica: lib.readSettings(ON, { replica: true }).enabled,
			noDomains: lib.readSettings({ AUTO_INVOICE_SEND_ENABLED: "true" }).domains,
			// The settle window: the setting's parse, the wait after the newest POD,
			// and the send decision around it (POD times are read only for a message
			// that would be sent).
			settle: (() => {
				if (typeof lib.settleMinutesOf !== "function" || typeof lib.settleState !== "function" || typeof lib.sendDecision !== "function") return null;
				const B = Date.parse("2026-10-20T13:00:00Z");
				const Z = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
				const view = (s) => [s.settled === true, s.unknown === true, Number.isFinite(s.untilMs) ? (s.untilMs - B) / MIN : null];
				const state = (podTimes, nowMs, settleMinutes = 60) => view(lib.settleState({ podTimes, nowMs, settleMinutes }));
				let reads = 0;
				const decide = (over, podTimes, nowMs) => {
					const g = lib.sendDecision({ settings: { enabled: true, domains: [SEND_DOMAIN], settleMinutes: 15 }, on: true, to: "billing@example-broker.test",
						podTimes: () => { reads++; return podTimes; }, nowMs, ...over });
					return [g.send === true, g.why || "", Number.isFinite(g.untilMs) ? (g.untilMs - B) / MIN : null];
				};
				const decisions = [
					decide({}, [Z(B)], B + 15 * MIN),
					decide({}, [Z(B)], B + 10 * MIN),
					decide({}, [null], B + 10 * MIN),
					decide({ to: "billing@example-other.test" }, [Z(B)], B + 10 * MIN),
					decide({ stopped: true }, [Z(B)], B + 10 * MIN),
					decide({ settings: { enabled: false, domains: [SEND_DOMAIN], settleMinutes: 15 } }, [Z(B)], B + 10 * MIN),
				];
				return {
					minutes: [undefined, "", "60", " 30 ", "0", "1440", "1441", "-5", "abc", "30.5", "1e3", "+30", "99999", 15].map((v) => lib.settleMinutesOf(v)),
					read: [lib.readSettings(ON).settleMinutes, lib.readSettings({ ...ON, AUTO_INVOICE_SEND_SETTLE_MINUTES: " 45 " }).settleMinutes,
						lib.readSettings({ ...ON, AUTO_INVOICE_SEND_SETTLE_MINUTES: "x" }).settleMinutes],
					state: [
						state([Z(B)], B + 60 * MIN - 1),
						state([Z(B)], B + 60 * MIN),
						state([Z(B), Z(B + 50 * MIN)], B + 61 * MIN),
						state([Z(B + 50 * MIN), Z(B)], B + 61 * MIN),
						state([], B),
						state([null], B),
						state([Z(B), null], B + 120 * MIN),
						state(["2026-10-20 13:00:00"], B + 120 * MIN),
						state([Z(B + 6 * MIN)], B),
						state([Z(B + 4 * MIN)], B),
						state([Z(B)], B, 0),
						state([Z(B)], NaN),
						state([Z(B)], B + 30 * MIN, "x"),
					],
					decisions,
					reads,
				};
			})(),
			gate: [
				lib.gate({ settings: { enabled: true, domains: [SEND_DOMAIN] }, on: true, to: "billing@example-broker.test" }).send,
				lib.gate({ settings: { enabled: false, domains: [SEND_DOMAIN] }, on: true, to: "billing@example-broker.test" }).why,
				lib.gate({ settings: { enabled: true, domains: [SEND_DOMAIN] }, on: false, to: "billing@example-broker.test" }).why,
				lib.gate({ settings: { enabled: true, domains: [SEND_DOMAIN] }, on: true, stopped: true, to: "billing@example-broker.test" }).why,
				lib.gate({ settings: { enabled: true, domains: [SEND_DOMAIN] }, on: true, to: "billing@ap.example-broker.test" }).why,
				lib.gate({ settings: { enabled: true, domains: [SEND_DOMAIN] }, on: true, to: "billing@notexample-broker.test" }).why,
			],
			check: [
				check({}), check({ to: "BILLING@example-broker.test" }), check({ to: "other@example-broker.test" }), check({ to: "billing@example-broker.test, x@example-broker.test" }),
				check({ to: "ap-billing@example-broker.test" }),
				check({ cc: "x@example-broker.test" }), check({ bcc: "x@example-broker.test" }), check({ subject: "" }),
				check({}, { attachments: [...files] }), same([files[0], files[1]]), same([files[1], files[0], files[2]]),
				same([files[0], files[1], att("987654321.pdf")]), same([files[0], files[1], { filename: "123456789.pdf", content: Buffer.alloc(0) }]),
				same([files[0], att("123456789.pdf"), files[2]]), same([files[0], att("POD_1_of_2_123456789.pdf"), att("POD_2_of_2_123456789.pdf"), files[2]]),
			],
			// The shapes nodemailer's smtp-connection (10.1.4, the lockfile's) gives
			// its errors: code, the command in flight, and a timeout's timeoutType.
			outcomes: [
				// Connect and log in (verify()): that connection carries no message.
				[{ code: "ECONNECTION", command: "CONN" }, "verify"],
				[{ code: "ESOCKET", command: "CONN", originalCode: "ECONNREFUSED" }, "verify"],
				[{ code: "ETIMEDOUT", command: "CONN", timeoutType: "SOCKET_TIMEOUT" }, "verify"],
				[{ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 }, "verify"],
				// The send: before the body.
				[{ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 }, "send"],
				[{ code: "EENVELOPE", command: "MAIL FROM", responseCode: 550 }, "send"],
				[{ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }, "send"],
				[{ code: "EENVELOPE", command: "DATA", responseCode: 554 }, "send"],
				[{ code: "EMESSAGE", command: "MAIL FROM" }, "send"],
				[{ code: "EREQUIRETLS", command: "MAIL FROM" }, "send"],
				[{ code: "EDNS", command: "CONN" }, "send"],
				[{ code: "ETIMEDOUT", command: "CONN", timeoutType: "CONNECT_TIMEOUT" }, "send"],
				[{ code: "ETIMEDOUT", command: "CONN", timeoutType: "GREETING_TIMEOUT" }, "send"],
				// The send: the body may have gone.
				[{ code: "EMESSAGE", command: "DATA", responseCode: 554 }, "send"],
				[{ code: "ECONNECTION", command: "CONN" }, "send"],
				[{ code: "ETIMEDOUT", command: "CONN", timeoutType: "SOCKET_TIMEOUT" }, "send"],
				[{ code: "ETIMEDOUT", command: "CONN" }, "send"],
				[{ code: "ESOCKET", command: "CONN" }, "send"],
				[{ code: "ETLS", command: "CONN" }, "send"],
				[{ code: "EPROTOCOL", command: "RSET" }, "send"],
				[{ code: "ESTREAM", command: "API" }, "send"],
				[{}, "send"], [null, "send"],
			].map(([e, phase]) => lib.smtpOutcome(e, phase)),
		};
	};
	const pureNow = pure(sendLib);
	const PURE_WANT = {
		settings: { enabled: true, domains: ["example-broker.test", "example-other.test", "example-x.test"], refused: 1, settleMinutes: 60 },
		flags: [true, true, false, false, false, false, false],
		replica: false,
		noDomains: [],
		// Unset or not a whole number from 0 to 1440: 60. The wait ends exactly N
		// minutes after the newest POD; no POD, one that can't be read, one that
		// isn't SQLite's own stamp, or one more than 5 minutes ahead: unknown.
		settle: {
			minutes: [60, 60, 60, 30, 0, 1440, 60, 60, 60, 60, 60, 60, 60, 15],
			read: [60, 45, 60],
			state: [[false, false, 60], [true, false, 60], [false, false, 110], [false, false, 110], [false, true, null], [false, true, null], [false, true, null],
				[false, true, null], [false, true, null], [false, false, 64], [true, false, 0], [false, true, null], [false, false, 60]],
			decisions: [[true, "", null], [false, "SETTLING", 15], [false, "POD_TIME_UNKNOWN", null], [false, "DOMAIN_NOT_LISTED", null], [false, "STOPPED", null], [false, "OFF", null]],
			reads: 3,
		},
		gate: [true, "OFF", "OFF", "STOPPED", "DOMAIN_NOT_LISTED", "DOMAIN_NOT_LISTED"],
		check: [null, null, "RECIPIENT", "RECIPIENT", "RECIPIENT", "HEADERS", "HEADERS", "HEADERS", "ATTACHMENTS", "ATTACHMENTS", "ATTACHMENTS", "ATTACHMENTS", "ATTACHMENTS", "ATTACHMENTS", null],
		outcomes: ["refused", "refused", "refused", "login",
			"login", "refused", "refused", "refused", "refused", "refused", "refused", "refused", "refused",
			"unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown"],
	};
	eq(pureNow, PURE_WANT, "§24 FAILS ON THE OLD CODE: the settings (exactly \"true\", never in a replica; exact domains, free mail refused, none by default; the settle window, 60 minutes unless set), the settle rule and the send decision, the gate, the last check and the SMTP outcomes");

	// The SMTP sender over a made-up nodemailer: one envelope recipient, no file or
	// URL access, the transport closed, and a failure without the server's text.
	if (sendLib) {
		const seen = [];
		const fakeMailer = (fail) => ({ createTransport: (opts) => ({
			verify: async () => true,
			sendMail: async (m) => { seen.push({ opts, m }); if (fail) throw Object.assign(new Error(`550 refused for ${BROKER}`), fail); return { accepted: [m.to] }; },
			close: () => seen.push("closed"),
		}) });
		const mail = { user: MAILBOX.user, pass: MAILBOX.pass, from: `LogisX Inc. <${MAILBOX.user}>`, to: "billing@example-broker.test", subject: "made-up", html: "<p>made-up</p>", attachments: [], messageId: "<made-up-1@example.com>" };
		await sendLib.createSmtpSender({ nodemailer: fakeMailer(null) })(mail);
		const sentWith = seen[0] && seen[0].m;
		eq(sentWith && [seen[0].opts.service, seen[0].opts.auth.user, sentWith.envelope, sentWith.messageId, sentWith.disableFileAccess, sentWith.disableUrlAccess, seen[1]],
			["gmail", MAILBOX.user, { from: MAILBOX.user, to: ["billing@example-broker.test"] }, "<made-up-1@example.com>", true, true, "closed"],
			"§24 the SMTP sender: the mailbox's own login, exactly one envelope recipient, the claim's Message-ID, no file or URL access, closed after");
		let failed = null;
		try {
			await sendLib.createSmtpSender({ nodemailer: fakeMailer({ code: "EENVELOPE", command: "RCPT TO" }) })(mail);
		} catch (e) {
			failed = e;
		}
		eq(failed && [failed.code, failed.outcome, /@/.test(failed.message)], ["EENVELOPE", "refused", false], "§24 ...a failure carries its code and outcome, never the server's text");
		let setup = null;
		try {
			await sendLib.createSmtpSender({ nodemailer: fakeMailer(null) })({ ...mail, pass: "" });
		} catch (e) {
			setup = e;
		}
		eq(setup && [setup.code, setup.outcome], ["SEND_SETUP", "refused"], "§24 ...no password: refused before any connection");
	}

	// The real nodemailer against an SMTP stand-in on 127.0.0.1 (in this process):
	// what the sender answers when the server took the whole message and then
	// dropped, went silent or refused it (H-1), and before the message.
	{
		const runs = {};
		for (const mode of ["ok", "drop-after-data", "silent-after-data", "554-after-data", "rcpt-550", "auth-535", "drop-at-greeting", "closed-port"]) {
			runs[mode] = await standInSend(mode);
		}
		const view = (r) => [r.outcome, r.messages];
		eq([view(runs.ok), runs.ok.connections], [["sent", 1], 2], "§24 FAILS ON THE OLD CODE: a send: one message, after a login on a connection of its own that carries none");
		eq(view(runs["drop-after-data"]), ["unknown", 1], "§24 FAILS ON THE OLD CODE: the whole message sent, then the connection dropped: it may be delivered (never 'refused')");
		eq(view(runs["silent-after-data"]), ["unknown", 1], "§24 FAILS ON THE OLD CODE: the whole message sent, then no reply until the socket timeout: it may be delivered");
		eq(view(runs["554-after-data"]), ["unknown", 1], "§24 FAILS ON THE OLD CODE: the whole message sent, then refused: counted as maybe delivered, never drafted again");
		eq([view(runs["rcpt-550"]), view(runs["auth-535"]), view(runs["drop-at-greeting"]), view(runs["closed-port"])],
			[["refused", 0], ["login", 0], ["refused", 0], ["refused", 0]], "§24 refused before the message (the recipient, the login, the greeting, the connection): nothing delivered");
		ok(Object.values(runs).every((r) => r.rcpt.every((a) => a === "<billing@example-broker.test>")), "§24 ...and the stand-in only ever saw the one made-up recipient");
	}

	// One shared via set: the job's literals live only in lib/auto-invoice-rules.js.
	// The server's text through the helper (scripts/lib/server-source.js), lib/ as is.
	const literalHits = [];
	const sources = [
		...fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js")).map((f) => [path.join("lib", f), fs.readFileSync(path.join(ROOT, "lib", f), "utf8")]),
		["the server's source", require("./lib/server-source").serverSource()],
	];
	for (const [label, text] of sources) {
		const n = (text.match(/["'`]auto-(?:imap|smtp)["'`]/g) || []).length;
		if (n) literalHits.push([label, n]);
	}
	eq(literalHits, [[path.join("lib", "auto-invoice-rules.js"), 2]], "§24 FAILS ON THE OLD CODE: the literals \"auto-imap\" and \"auto-smtp\" appear only in the shared set (rules.JOB_VIAS)");
	const sendSrc = sendLib ? fs.readFileSync(SEND_FILE, "utf8") : "";
	const resumeSrc = resumeScript ? fs.readFileSync(path.join(ROOT, "scripts", "auto-invoice-send-resume.js"), "utf8") : "";
	ok(sendLib && !/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]/.test(sendSrc + resumeSrc), "§24 no email address in lib/auto-invoice-send.js or the resume script (nothing to default to)");

	// Each decision removed in turn: the case that pins it must change.
	const JOB_FILE = path.join(ROOT, "lib", "auto-invoice-job.js");
	const LEDGER_FILE = path.join(ROOT, "lib", "auto-invoice-ledger.js");
	const FACTORING_FILE = path.join(ROOT, "lib", "factoring-store.js");
	const jobMutants = [
		["the send's last check skipped", "if (check) return refuseSend(c, \"SEND_REFUSED\", check);", "",
			() => SEND_CASES.lastCheck, (lib) => SEND_CASES.lastCheck(lib, (out) => ({ ...out, attachments: out.attachments.map((a, i) => (i === 2 ? { ...a, filename: "LD-TEST-9999.pdf" } : a)) })), (x) => x.smtp === 0],
		["a wait between the commit and the SMTP call", "\t\ttry {\n\t\t\tawait d.sendMail({", "\t\tawait Promise.resolve();\n\t\ttry {\n\t\t\tawait d.sendMail({",
			null, (lib) => SEND_CASES.lastBeforeSend(lib), (x) => x.before === "marker" && x.after === "next microtask"],
		["an unanswered send handled as a draft's lost append", "if (sendInFlight(fresh)) return searchSent(fresh, mb);", "",
			null, (lib) => SEND_CASES.unanswered(lib), (x) => x.smtp === 1 && x.append === 0],
		["MAYBE_SENT after the first search", "if (triggerMode || checks >= sendRules.SEARCH_AFTER_MS.length) {", "if (checks >= 1) {",
			null, (lib) => SEND_CASES.unanswered(lib), (x) => x.states[0][1] === "SEND_UNCONFIRMED"],
		["a refused send searched for instead of drafted", "if (outcome !== \"unknown\") {", "if (false) {",
			null, (lib) => SEND_CASES.smtpRefused(lib, "REFUSED"), (x) => x.append === 2],
		// Hold one load, not all: the rules mutant ("a logged field holds") runs in §26.
		["a hold stops everything", "\t\tif (trips) stopSending(\"TOO_MANY_HELD\", c);", "\t\tstopSending(\"TOO_MANY_HELD\", c);",
			null, (lib) => SEND_CASES.changedAfterSend(lib), (x) => x.stop === null && JSON.stringify(x.next) === JSON.stringify(["drafted", ""]) && x.smtp === 2],
		["no breaker", "\t\tif (trips) stopSending(\"TOO_MANY_HELD\", c);", "",
			null, (lib) => HOLD_CASES.breaker(lib, BREAKER_STEPS.three), (x) => JSON.stringify(x.stops) === JSON.stringify([null, null, "TOO_MANY_HELD"])],
		["the switch ignored", "if (holdOneLoad && sendRules.claimSent(c)) return checkSent(c, saved, facts, nowIso, beganAt);", "if (sendRules.claimSent(c)) return checkSent(c, saved, facts, nowIso, beganAt);",
			null, (lib) => HOLD_CASES.field(lib, FIELD_CHANGES.pods, { env: { AUTO_INVOICE_HOLD_ONE_LOAD: "false" } }), (x) => x.stop === "LOAD_CHANGED_AFTER_SEND" && x.chip === "pods"],
		["the switch off still holds one load", "\t\tif (n && sendRules.claimSent(c)) {\n\t\t\taudit(\"auto_invoice_load_changed\", c.load_id, `${c.invoice_id}: ${fields} (sent)`);",
			"\t\tif (n && false) {\n\t\t\taudit(\"auto_invoice_load_changed\", c.load_id, `${c.invoice_id}: ${fields} (sent)`);",
			null, (lib) => HOLD_CASES.field(lib, FIELD_CHANGES.payment, { env: { AUTO_INVOICE_HOLD_ONE_LOAD: "false" } }), (x) => x.stop === "LOAD_CHANGED_AFTER_SEND"],
		["a send recorded as a draft", "const via = c.delivery === \"send\" ? rules.VIA_SEND : rules.VIA_DRAFT;", "const via = rules.VIA_DRAFT;",
			null, (lib) => SEND_CASES.sends(lib), (x) => JSON.stringify(x.rows) === JSON.stringify([{ invoice_id: "10202026-1", via: "auto-smtp" }])],
		["no auto_invoice_sent row", "audit(\"auto_invoice_sent\", c.load_id, `${c.invoice_id} → ${sentDomain(c) || \"unknown domain\"} (sent by", "void (\"auto_invoice_sent\", c.load_id, `${c.invoice_id} → ${sentDomain(c) || \"unknown domain\"} (sent by",
			null, (lib) => SEND_CASES.sends(lib), (x) => x.sentRows.length === 1],
		["a sent row shown as a draft", "...(c.state === \"drafted\" && sendRules.claimSent(c) ? { sent: true } : {}),", "",
			null, (lib) => SEND_CASES.sends(lib), (x) => x.annotation && x.annotation.sent === true],
		["the sweep moves a send being searched for", "own draft closes it.\n\t\t\tif (sendInFlight(c) && c.state !== \"needs_attention\") continue;", "own draft closes it.",
			null, (lib) => SEND_CASES.handDraftWhileSearching(lib), (x) => x.searching && x.searching[1] === "SEND_UNCONFIRMED"],
		["the button refuses a preview", "if (dryRun === true) return { ok: true };", "",
			null, (lib) => SEND_CASES.button(lib), (x) => x.workingPreview === "ok" && x.preview === "ok"],
		["the stop route mounted with sending off", "\t\tif (sending) {\n\t\t\tconst limited", "\t\tif (true) {\n\t\t\tconst limited",
			null, (lib) => SEND_CASES.stopRoute(lib, { send: { enabled: false, domains: [SEND_DOMAIN] } }), (x) => x.registered === false],
		["no row for the allowlist's refusal", "} else if (g && g.why === \"DOMAIN_NOT_LISTED\") {", "} else if (false) {",
			null, (lib) => SEND_CASES.drafts(lib, { send: { enabled: true, domains: ["example-other.test"] } }), (x) => x.refused.length === 1],
		["a press's draft in flight answered with a draft", "if (begun.reason === \"press\") return temporary(ledger.getClaim(db, key), { code: \"HAND_DRAFT_IN_FLIGHT\", countsAttempt: false });",
			"if (begun.reason === \"press\") return DRAFT_INSTEAD;",
			null, (lib) => SEND_CASES.pressFirst(lib), (x) => x.atSend.append === 0 && x.atSend.state[1] === "HAND_DRAFT_IN_FLIGHT"],
	];
	for (const [label, from, to, , run, pinned] of jobMutants) {
		const lib = mutantModule(JOB_FILE, from, to);
		ok(lib, `§24 MUTANT ${label}: applied to lib/auto-invoice-job.js once`);
		if (!lib) continue;
		ok(pinned(await run(jobLib)) && !pinned(await run(lib)), `§24 MUTANT ${label}: caught`);
	}
	// The ledger's own decisions, put in place through its exports for the case.
	const ledgerMutants = [
		["beginSend() without the marker", "\t\tif (factoredOrUnreadable(db, key)) return { ok: false, reason: \"factored\" };\n\t\ttransition(", "\t\ttransition(", "beginSend",
			() => SEND_CASES.factoredAtSend(jobLib), (x) => x.smtp === 0],
		["beginSend() without the stop", "\t\tif (getSendStop(db)) return { ok: false, reason: \"stopped\" };\n", "", "beginSend",
			() => SEND_CASES.stopAtSend(jobLib), (x) => x.smtp === 0],
		["beginSend() without the hand-draft check", "\t\tif (otherDraftRows(db, claim).length) return { ok: false, reason: \"drafted\" };\n\t\tif (factoring.inflightRows", "\t\tif (factoring.inflightRows", "beginSend",
			() => SEND_CASES.handDraftAtSend(jobLib), (x) => x.smtp === 0],
		["beginSend() without a press's draft in flight", "\t\tif (factoring.inflightRows(db, key, nowIso).length) return { ok: false, reason: \"press\" };\n", "", "beginSend",
			() => SEND_CASES.pressFirst(jobLib), (x) => x.atSend.smtp === 0],
		["the sent row taken for somebody else's", "rules.isJobVia(r.via) && claim.invoice_id && r.invoice_id === claim.invoice_id", "r.via === \"auto-imap\" && claim.invoice_id && r.invoice_id === claim.invoice_id", "otherDraftRows",
			() => SEND_CASES.sends(jobLib), (x) => x.other === 0],
		["a voided number used again", "const usable = Boolean(claim.invoice_id) && !claim.number_voided_at;", "const usable = Boolean(claim.invoice_id);", "reserveNumber",
			async () => {
				const r = await SEND_CASES.factoredAtSend(jobLib);
				if (!r.w.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'load_factoring'").get()) return { fresh: false };
				r.w.db.prepare("DELETE FROM load_factoring").run();
				const f = fakeApp();
				r.job.mount(f.app, { requireRole: f.requireRole });
				await f.call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: "ld-test-0510" } });
				r.w.now += 5 * MIN;
				await r.job.tick();
				return { fresh: claimOf(r.w, "LD-TEST-0510").invoice_id !== r.number };
			}, (x) => x.fresh === true],
	];
	for (const [label, from, to, name, run, pinned] of ledgerMutants) {
		const lib = mutantModule(LEDGER_FILE, from, to);
		ok(lib, `§24 MUTANT ${label}: applied to lib/auto-invoice-ledger.js once`);
		if (!lib) continue;
		const real = pinned(await run());
		const mutated = pinned(await withPatched([[ledgerLib, name, lib[name]]], run));
		ok(real && !mutated, `§24 MUTANT ${label}: caught`);
	}
	const markMutant = mutantModule(FACTORING_FILE, "\t\tif (autoClaimSent(db, k)) return refusal(\"INVOICE_ALREADY_SENT\");\n", "");
	ok(markMutant, "§24 MUTANT mark() without the unconfirmed-send check: applied to lib/factoring-store.js once");
	if (markMutant && factoringStore) {
		const real = await SEND_CASES.markWhileUnconfirmed(jobLib);
		const mutated = await withPatched([[factoringStore, "mark", markMutant.mark]], () => SEND_CASES.markWhileUnconfirmed(jobLib));
		ok(real.mark === "INVOICE_ALREADY_SENT" && mutated.mark !== "INVOICE_ALREADY_SENT", "§24 MUTANT mark() without the unconfirmed-send check: caught");
	}
	// The press's side of M-1 (factoring-store's late check, and the route's hand-off).
	for (const [label, from, to, opts, pinned] of [
		["the press's late check blind to the job's send", "\tif (reissue !== true && autoClaimSent(db, k)) return refusal(\"INVOICE_SENT_MEANWHILE\");\n", "", {}, (x) => x.press === "INVOICE_SENT_MEANWHILE"],
		["a confirmed re-issue refused late", "if (reissue !== true && autoClaimSent(db, k))", "if (autoClaimSent(db, k))", { reissue: true }, (x) => x.press === "ok"],
		["draftBegin() dropping the re-issue", "const r = lateChecks(db, k, { confirmed, reissue, nowIso });", "const r = lateChecks(db, k, { confirmed, nowIso });", { reissue: true }, (x) => x.press === "ok"],
	]) {
		const lib = mutantModule(FACTORING_FILE, from, to);
		ok(lib, `§24 MUTANT ${label}: applied to lib/factoring-store.js once`);
		if (!lib || !factoringStore) continue;
		const real = pinned(await SEND_CASES.jobFirst(jobLib, opts));
		const mutated = pinned(await withPatched([[factoringStore, "draftBegin", lib.draftBegin]], () => SEND_CASES.jobFirst(jobLib, opts)));
		ok(real && !mutated, `§24 MUTANT ${label}: caught`);
	}
	const ROUTES_FILE = path.join(ROOT, "lib", "factoring-routes.js");
	const routesMutant = fs.existsSync(ROUTES_FILE) ? mutantModule(ROUTES_FILE, "path, confirmed, reissue, actorId", "path, confirmed, actorId") : null;
	ok(routesMutant, "§24 MUTANT the route's hand-off dropping the re-issue: applied to lib/factoring-routes.js once");
	if (routesMutant && routesLibReal) {
		const real = await SEND_CASES.jobFirst(jobLib, { reissue: true, routesLib: routesLibReal });
		const mutated = await SEND_CASES.jobFirst(jobLib, { reissue: true, routesLib: routesMutant });
		ok(real.press === "ok" && mutated.press !== "ok", "§24 MUTANT the route's hand-off dropping the re-issue: caught");
	}
	// The sender's login-first connection (H-1).
	if (sendLib) {
		for (const [label, from, to, mode, pinned] of [
			["no login-first connection", "\t\t\tawait transport.verify();\n", "", "ok", (x) => x.connections === 2],
			["the phase never moves on to the send", "\t\t\tphase = \"send\";\n", "", "drop-after-data", (x) => x.outcome === "unknown"],
		]) {
			const lib = mutantModule(SEND_FILE, from, to);
			ok(lib, `§24 MUTANT ${label}: applied to lib/auto-invoice-send.js once`);
			if (lib) ok(pinned(await standInSend(mode)) && !pinned(await standInSend(mode, lib)), `§24 MUTANT ${label}: caught`);
		}
	}
	for (const [label, from, to] of [
		["the marker read before the stop", "\t\tif (getSendStop(db)) return { ok: false, reason: \"stopped\" };\n\t\tif (factoredOrUnreadable(db, key)) return { ok: false, reason: \"factored\" };",
			"\t\tif (factoredOrUnreadable(db, key)) return { ok: false, reason: \"factored\" };\n\t\tif (getSendStop(db)) return { ok: false, reason: \"stopped\" };"],
	]) {
		const src = fs.readFileSync(LEDGER_FILE, "utf8");
		ok(src.split(from).length === 2 && !sendOrder(src.replace(from, to), JOB_SRC).ordered, `§24 MUTANT ${label}: caught by the order check`);
	}
	if (sendLib) {
		const RESUME_FILE = path.join(ROOT, "scripts", "auto-invoice-send-resume.js");
		const resumeMutant = mutantModule(RESUME_FILE, "\t\tif (unconfirmed > 0) throw new Refusal(", "\t\tif (false) throw new Refusal(");
		ok(resumeMutant, "§24 MUTANT resume without the unconfirmed-send refusal: applied once");
		if (resumeMutant) {
			const w = sendWorld();
			await sendStarted(jobLib, w);
			w.db.exec("CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, user_id INTEGER, username TEXT, role TEXT, action TEXT, entity TEXT, entity_id TEXT, details TEXT)");
			w.db.prepare("INSERT INTO auto_invoice_claims (load_key, load_id, state, reason_code, first_seen_at, stage, delivery, updated_at) VALUES ('ld-test-0596', 'LD-TEST-0596', 'needs_attention', 'MAYBE_SENT', ?, 'appending', 'send', ?)")
				.run(new Date(w.now).toISOString(), new Date(w.now).toISOString());
			ledgerLib.setSendStop(w.db, { reason: "MAYBE_SENT", nowIso: new Date(w.now).toISOString() });
			let caught = false;
			try { resumeMutant.run({ db: w.db, dryRun: true }); } catch { caught = true; }
			ok(!caught, "§24 MUTANT resume without the unconfirmed-send refusal: caught (the mutant resumes; the real script refuses, above)");
		}
		const pureMutants = [
			["the gate ignores the stop", "\tif (stopped) return { send: false, why: \"STOPPED\" };\n", ""],
			["a subdomain taken as listed", "if (!domain || !(settings.domains || []).includes(domain)) return { send: false, why: \"DOMAIN_NOT_LISTED\" };",
				"if (!domain || !(settings.domains || []).some((x) => domain === x || domain.endsWith(`.${x}`))) return { send: false, why: \"DOMAIN_NOT_LISTED\" };"],
			["the flag read loosely", "String(env?.AUTO_INVOICE_SEND_ENABLED ?? \"\").trim() === \"true\"", "/^(true|1|yes)$/i.test(String(env?.AUTO_INVOICE_SEND_ENABLED ?? \"\").trim())"],
			["on in a replica", "const enabled = replica !== true && ", "const enabled = "],
			["the To compared loosely", "if (!to || rules.normalizeEmail(to) !== to || to.toLowerCase() !== String(planned || \"\").toLowerCase()) return \"RECIPIENT\";",
				"if (!to || !to.toLowerCase().includes(String(planned || \"\").toLowerCase())) return \"RECIPIENT\";"],
			["a Cc or Bcc let through", "if (JSON.stringify(Object.keys(m).sort()) !== JSON.stringify(MESSAGE_KEYS)) return \"HEADERS\";", ""],
			["files not the render's own", "atts !== rendered.attachments || ", ""],
			["the rate con not matched to the invoice", "if (names[names.length - 1] !== rateCon || names.indexOf(rateCon) !== names.length - 1) return \"ATTACHMENTS\";", ""],
			["CONN taken as nothing sent", "\tconst command = String((e && e.command) || \"\");\n", "\tconst command = String((e && e.command) || \"\");\n\tif (command === \"CONN\") return \"refused\";\n"],
			["a refusal after the body taken as nothing sent", "if (code === \"EMESSAGE\" && (command === \"API\" || command === \"MAIL FROM\")) return \"refused\";", "if (code === \"EMESSAGE\") return \"refused\";"],
			["no login-first phase", "\tif (phase === \"verify\") return \"refused\";\n", ""],
			["a socket timeout taken as a setup timeout", "new Set([\"CONNECT_TIMEOUT\", \"GREETING_TIMEOUT\", \"UPGRADE_TIMEOUT\"])", "new Set([\"CONNECT_TIMEOUT\", \"GREETING_TIMEOUT\", \"UPGRADE_TIMEOUT\", \"SOCKET_TIMEOUT\"])"],
		];
		for (const [label, from, to] of pureMutants) {
			const lib = mutantModule(SEND_FILE, from, to);
			ok(lib, `§24 MUTANT ${label}: applied to lib/auto-invoice-send.js once`);
			if (lib) ok(JSON.stringify(pure(lib)) !== JSON.stringify(PURE_WANT), `§24 MUTANT ${label}: caught`);
		}
		// The settle window's pure rules (§25), caught by the same table.
		const settleMutants = [
			["the setting not read", "settleMinutes: settleMinutesOf(env?.AUTO_INVOICE_SEND_SETTLE_MINUTES)", "settleMinutes: SETTLE_MINUTES_DEFAULT"],
			["the default not 60", "const SETTLE_MINUTES_DEFAULT = 60;", "const SETTLE_MINUTES_DEFAULT = 0;"],
			["no ceiling on the setting", "return n <= SETTLE_MINUTES_MAX ? n : SETTLE_MINUTES_DEFAULT;", "return n;"],
			["a signed setting taken", "if (!/^\\d{1,4}$/.test(s)) return SETTLE_MINUTES_DEFAULT;", "if (!/^[+-]?\\d{1,4}$/.test(s)) return SETTLE_MINUTES_DEFAULT;"],
			["the oldest POD counted, not the newest", "Math.max(...times)", "Math.min(...times)"],
			["the wait ends a moment late", "settled: now >= untilMs", "settled: now > untilMs"],
			["no POD time taken as settled", "!Number.isFinite(now) || !times.length || ", "!Number.isFinite(now) || "],
			["a POD time that can't be read ignored", "times.some((t) => !Number.isFinite(t) || t > now + POD_TIME_AHEAD_MS)", "times.some((t) => t > now + POD_TIME_AHEAD_MS)"],
			["a POD time ahead of the clock trusted", "times.some((t) => !Number.isFinite(t) || t > now + POD_TIME_AHEAD_MS)", "times.some((t) => !Number.isFinite(t))"],
			["any text read as a time", "typeof t === \"string\" && POD_TIME_RE.test(t) ? Date.parse(t) : NaN", "Date.parse(t)"],
			["the decision without the gate", "\tif (!g.send) return g;\n\tconst s = settleState(", "\tconst s = settleState("],
			["the decision deaf to the setting", "settleMinutes: settings.settleMinutes });", "settleMinutes: undefined });"],
			["a POD time that can't be read sends", "\tif (s.settled) return g;\n", "\tif (s.settled || s.unknown) return g;\n"],
			["a POD time that can't be read waits", "return s.unknown ? { send: false, why: \"POD_TIME_UNKNOWN\" } : { send: false, why: \"SETTLING\", untilMs: s.untilMs };",
				"return { send: false, why: \"SETTLING\", untilMs: s.untilMs };"],
		];
		for (const [label, from, to] of settleMutants) {
			const lib = mutantModule(SEND_FILE, from, to);
			ok(lib, `§25 MUTANT ${label}: applied to lib/auto-invoice-send.js once`);
			if (lib) ok(JSON.stringify(pure(lib)) !== JSON.stringify(PURE_WANT), `§25 MUTANT ${label}: caught`);
		}
	}
}

// ------------------------------------------------------------------ the settle window (§25)
// A POD row uploaded at `ms` on the world's clock, stored as SQLite's own
// CURRENT_TIMESTAMP stores it (UTC, "YYYY-MM-DD HH:MM:SS"); `raw` stores that value
// instead. Its file is on disk. Returns the row's id.
const sqliteStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
function podAt(w, id, ms, { raw } = {}) {
	const name = `pod-${rules.loadKey(id)}-${w.db.prepare("SELECT COUNT(*) n FROM documents").get().n}.pdf`;
	w.files.add(name);
	return Number(w.db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'POD', ?, ?, ?)")
		.run(id, name, `/uploads/${name}`, raw !== undefined ? raw : sqliteStamp(ms)).lastInsertRowid);
}
// Delivered with its rate con on file, no POD yet.
function deliveredNoPod(w, id, over = {}, docEmail = "billing@example-broker.test") {
	w.setRow(id, over);
	w.rateCons.set(rules.loadKey(id), docEmail);
}
const isoOf = (ms) => new Date(ms).toISOString();
// A second confirmed broker, not on the send list: its loads are drafted.
const OTHER_BROKER = Object.freeze({ Email: "ops@example-other.test" });
const OTHER_BILLING = "billing@example-other.test";
const confirmBoth = (w) => setSettings(w.db, { optOutDomains: [], confirmedBrokerDomains: [SEND_DOMAIN, "example-other.test"] });
// SEND_SETTLING among the server's reason codes (a tree before it fails by name).
const reasonsHaveSettling = () => rules.REASON_CODES.includes("SEND_SETTLING");

const SETTLE_CASES = {
	// A POD uploaded at P, looked at on each minute of `at` after it.
	async waitThenSend(lib, { send = SEND_ON, at = [0, 30, 59, 61] } = {}) {
		const w = sendWorld({ send });
		const job = await sendStarted(lib, w);
		const id = "LD-TEST-0700";
		deliveredNoPod(w, id);
		const P = w.now;
		podAt(w, id, P);
		const seen = [];
		for (const min of at) {
			w.now = P + min * MIN;
			await job.tick();
			const c = claimOf(w, id);
			const rows = [{ ...w.rows[w.rows.length - 1] }];
			job.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: true });
			const shown = rows[0]._autoInvoice;
			seen.push({ min, state: [c.state, c.reason_code], until: c.state === "waiting" ? c.next_attempt_at : "", smtp: w.smtp.length, append: w.calls.append.length,
				prepares: enginePrepares(w, id), mint: w.calls.mint.length, shown: shown ? [shown.state, shown.code] : null });
		}
		const c = claimOf(w, id);
		return { P, seen, delivery: c.delivery || "", stage: c.stage };
	},
	// A second POD at minute 50.
	async secondPod(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		const id = "LD-TEST-0705";
		deliveredNoPod(w, id);
		const P = w.now;
		podAt(w, id, P);
		const seen = [];
		for (const min of [0, 30, 50, 61, 109, 110]) {
			w.now = P + min * MIN;
			if (min === 50) podAt(w, id, w.now);
			await job.tick();
			const c = claimOf(w, id);
			seen.push([min, c.state, c.reason_code, c.state === "waiting" ? c.next_attempt_at : "", w.smtp.length]);
		}
		return { P, seen };
	},
	// A second POD at minute 50, deleted at minute 55.
	async deletedPod(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		const id = "LD-TEST-0706";
		deliveredNoPod(w, id);
		const P = w.now;
		podAt(w, id, P);
		let second = 0;
		const seen = [];
		for (const min of [0, 50, 55, 61]) {
			w.now = P + min * MIN;
			if (min === 50) second = podAt(w, id, w.now);
			if (min === 55) w.db.prepare("UPDATE documents SET deleted_at = ? WHERE id = ?").run(sqliteStamp(w.now), second);
			await job.tick();
			const c = claimOf(w, id);
			seen.push([min, c.state, c.reason_code, c.state === "waiting" ? c.next_attempt_at : "", w.smtp.length]);
		}
		return { P, seen };
	},
	// A POD uploaded just now, in a world that drafts it (`setup` sets the load up).
	async draftsAtOnce(lib, { send = SEND_ON, extra = {}, setup = null } = {}) {
		const w = sendWorld({ send });
		const job = await sendStarted(lib, w, extra);
		const id = "LD-TEST-0760";
		if (setup) setup(w, id);
		else deliveredNoPod(w, id);
		podAt(w, id, w.now);
		await job.tick();
		const c = claimOf(w, id);
		return { state: [c.state, c.reason_code], smtp: w.smtp.length, append: w.calls.append.length, prepares: enginePrepares(w, id), delivery: c.delivery || "",
			to: w.calls.append.map((x) => x.to) };
	},
	// Two loads waiting to settle and other brokers' loads beside them: the sweep's
	// two attempts go to the loads that can be drafted.
	async slots(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		confirmBoth(w);
		const P = w.now;
		for (const id of ["LD-TEST-0701", "LD-TEST-0702"]) {
			deliveredNoPod(w, id);
			podAt(w, id, P);
		}
		deliveredNoPod(w, "LD-TEST-0703", OTHER_BROKER, OTHER_BILLING);
		podAt(w, "LD-TEST-0703", P);
		await job.tick();
		const first = ["LD-TEST-0701", "LD-TEST-0702", "LD-TEST-0703"].map((id) => w.state(id));
		w.now = P + 10 * MIN;
		deliveredNoPod(w, "LD-TEST-0704", OTHER_BROKER, OTHER_BILLING);
		podAt(w, "LD-TEST-0704", w.now);
		await job.tick();
		const second = ["LD-TEST-0701", "LD-TEST-0702", "LD-TEST-0704"].map((id) => w.state(id));
		return { first, second, smtp: w.smtp.length, append: w.calls.append.length, prepares: ["LD-TEST-0701", "LD-TEST-0702"].map((id) => enginePrepares(w, id)) };
	},
	// Settled when first looked at; a second POD lands during the build (the render).
	async podDuringBuild(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		const id = "LD-TEST-0710";
		deliveredNoPod(w, id);
		podAt(w, id, w.now - 61 * MIN);
		let added = false;
		w.renderHook = (ctx) => {
			if (added || rules.loadKey(ctx.loadId) !== "ld-test-0710") return;
			added = true;
			podAt(w, id, w.now);
		};
		await job.tick();
		w.renderHook = null;
		const c1 = claimOf(w, id);
		const first = { state: [c1.state, c1.reason_code], smtp: w.smtp.length, append: w.calls.append.length, number: c1.invoice_id, stage: c1.stage,
			until: c1.next_attempt_at, expected: isoOf(w.now + 60 * MIN) };
		w.now += 61 * MIN;
		await job.tick();
		const c2 = claimOf(w, id);
		return { first, after: { state: [c2.state, c2.reason_code], delivery: c2.delivery || "", smtp: w.smtp.length,
			sameNumber: Boolean(c2.invoice_id) && c2.invoice_id === first.number, mint: w.calls.mint.length } };
	},
	// Settled at its first attempt, which fails (a retry in 15 minutes); a new POD
	// meanwhile: the retry waits before the build.
	async retryHeld(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		const id = "LD-TEST-0720";
		deliveredNoPod(w, id);
		podAt(w, id, w.now - 61 * MIN);
		let fail = true;
		w.prepareHook = (loadId) => (fail && rules.loadKey(loadId) === "ld-test-0720" ? { ok: false, http: 503, code: "" } : null);
		await job.tick();
		const queued = w.state(id);
		fail = false;
		const P2 = w.now;
		podAt(w, id, P2);
		w.now += 15 * MIN;
		await job.tick();
		const c = claimOf(w, id);
		const held = { state: [c.state, c.reason_code], prepares: enginePrepares(w, id), mint: w.calls.mint.length, until: c.next_attempt_at, attempts: c.attempts };
		w.now = P2 + 60 * MIN;
		await job.tick();
		w.prepareHook = null;
		return { queued, held, expectedUntil: isoOf(P2 + 60 * MIN), sent: { state: w.state(id), smtp: w.smtp.length, prepares: enginePrepares(w, id) } };
	},
	// A POD whose stored time can't prove the wait is over (`raw`, or raw(w)).
	async unknownTime(lib, raw) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		const id = "LD-TEST-0730";
		deliveredNoPod(w, id);
		podAt(w, id, 0, { raw: typeof raw === "function" ? raw(w) : raw });
		await job.tick();
		const c = claimOf(w, id);
		return { state: [c.state, c.reason_code], smtp: w.smtp.length, append: w.calls.append.length, refused: w.actions("auto_invoice_send_refused").map((x) => x.details) };
	},
	// Sending stopped while a load waits to settle.
	async stoppedWhileWaiting(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		const id = "LD-TEST-0750";
		deliveredNoPod(w, id);
		const P = w.now;
		podAt(w, id, P);
		await job.tick();
		const waiting = w.state(id);
		w.now = P + 5 * MIN;
		ledgerLib.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: isoOf(w.now) });
		await job.tick();
		return { waiting, after: w.state(id), smtp: w.smtp.length, append: w.calls.append.length };
	},
	// The setting as handed to the job (`minutes`), looked at on each minute of `at`.
	async setting(lib, minutes, at) {
		const w = sendWorld({ send: { ...SEND_ON, settleMinutes: minutes } });
		const job = await sendStarted(lib, w);
		const id = "LD-TEST-0770";
		deliveredNoPod(w, id);
		const P = w.now;
		podAt(w, id, P);
		const seen = [];
		for (const min of at) {
			w.now = P + min * MIN;
			await job.tick();
			seen.push([min, ...(w.state(id) || ["", ""]), w.smtp.length]);
		}
		return seen;
	},
	// ledger.livePodTimes() on one database.
	livePods() {
		const w = makeWorld();
		const t = (s) => Date.parse(s);
		podAt(w, "LD-TEST-0740", t("2026-10-20T13:05:00Z"));
		podAt(w, " #ld-test-0740 ", t("2026-10-20T13:06:00Z"));
		const gone = podAt(w, "LD-TEST-0740", t("2026-10-20T13:07:00Z"));
		w.db.prepare("UPDATE documents SET deleted_at = '2026-10-20 13:08:00' WHERE id = ?").run(gone);
		podAt(w, "LD-TEST-0740", 0, { raw: "2026-10-20T09:11:00-04:00" });
		podAt(w, "LD-TEST-0740", 0, { raw: "not a time" });
		podAt(w, "LD-TEST-07400", t("2026-10-20T13:12:00Z"));
		w.db.prepare("INSERT INTO documents (load_id, type, file_name, uploaded_at) VALUES ('LD-TEST-0740', 'RATECON', 'made-up-rc.pdf', '2026-10-20 13:13:00')").run();
		return typeof ledgerLib.livePodTimes === "function" ? ledgerLib.livePodTimes(w.db, "ld-test-0740") : null;
	},
};

async function settleSections() {
	// ---------------------------------------------------------------- §25
	section("§25 the settle window before a send (AUTO_INVOICE_SEND_SETTLE_MINUTES)");
	ok(reasonsHaveSettling(), "§25 FAILS ON THE OLD CODE: SEND_SETTLING is a reason code");

	const a = await SETTLE_CASES.waitThenSend(jobLib);
	const waitRow = (min) => ({ min, state: ["waiting", "SEND_SETTLING"], until: isoOf(a.P + 60 * MIN), smtp: 0, append: 0, prepares: 0, mint: 0, shown: ["waiting", "SEND_SETTLING"] });
	eq(a.seen.slice(0, 3), [waitRow(0), waitRow(30), waitRow(59)],
		"§25 FAILS ON THE OLD CODE: a POD 0, 30 and 59 minutes ago: the send waits (Waiting, SEND_SETTLING, until 60 minutes after the POD), with no engine call, number or message, and a Super Admin sees why");
	const last = a.seen[3] || {};
	eq([last.state, last.smtp, last.append, last.prepares, last.mint, a.delivery, a.stage], [["drafted", ""], 1, 0, 1, 1, "send", "recorded"],
		"§25 ...and at 61 minutes it is sent, built once, with one number");

	const b = await SETTLE_CASES.secondPod(jobLib);
	const W = (min, until) => [min, "waiting", "SEND_SETTLING", isoOf(b.P + until * MIN), 0];
	eq(b.seen, [W(0, 60), W(30, 60), W(50, 110), W(61, 110), W(109, 110), [110, "drafted", "", "", 1]],
		"§25 FAILS ON THE OLD CODE: a second POD at minute 50 starts the wait again: still waiting at 61 and 109 minutes, sent at 110");

	const del = await SETTLE_CASES.deletedPod(jobLib);
	const D = (min, until) => [min, "waiting", "SEND_SETTLING", isoOf(del.P + until * MIN), 0];
	eq(del.seen, [D(0, 60), D(50, 110), D(55, 60), [61, "drafted", "", "", 1]],
		"§25 FAILS ON THE OLD CODE: a POD deleted at minute 55 doesn't count: the wait goes back to the first POD's, and the load is sent at 61");

	// Drafts never wait: anything that would be drafted is drafted at once.
	const DRAFTED_NOW = { state: ["drafted", ""], smtp: 0, append: 1, prepares: 1, delivery: "" };
	const pick = (x) => ({ state: x.state, smtp: x.smtp, append: x.append, prepares: x.prepares, delivery: x.delivery });
	eq(pick(await SETTLE_CASES.draftsAtOnce(jobLib, { send: { enabled: false, domains: [SEND_DOMAIN] } })), DRAFTED_NOW, "§25 sending off: a POD uploaded just now is drafted at once");
	eq(pick(await SETTLE_CASES.draftsAtOnce(jobLib, { send: { enabled: true, domains: ["example-other.test"] } })), DRAFTED_NOW, "§25 a domain not on the send list: drafted at once");
	eq(pick(await SETTLE_CASES.draftsAtOnce(jobLib, { extra: { sendMail: undefined } })), DRAFTED_NOW, "§25 sending on with no sender: drafted at once");
	eq(pick(await SETTLE_CASES.draftsAtOnce(jobLib, { setup: (w, id) => {
		ledgerLib.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: isoOf(w.now) });
		deliveredNoPod(w, id);
	} })), DRAFTED_NOW, "§25 sending stopped: drafted at once");
	const bisonDraft = await SETTLE_CASES.draftsAtOnce(jobLib, { setup: (w, id) => deliveredNoPod(w, id, { Email: BISON }, "billing@example-factor.test") });
	eq([pick(bisonDraft), bisonDraft.to], [DRAFTED_NOW, [BISON_AP]], "§25 a Bison load whose inbox's domain isn't listed: drafted at once, to the inbox");
	const bisonListed = await SETTLE_CASES.draftsAtOnce(jobLib, { send: { enabled: true, domains: [SEND_DOMAIN, "example-bison-ap.test"] },
		setup: (w, id) => deliveredNoPod(w, id, { Email: BISON }, "billing@example-factor.test") });
	eq([bisonListed.state, bisonListed.smtp, bisonListed.append, bisonListed.prepares], [["waiting", "SEND_SETTLING"], 0, 0, 0],
		"§25 FAILS ON THE OLD CODE: a Bison load whose inbox's domain is listed waits like any send (its domain judged by the inbox), with no engine call");

	const slots = await SETTLE_CASES.slots(jobLib);
	eq([slots.first, slots.second, slots.smtp, slots.append, slots.prepares],
		[[["waiting", "SEND_SETTLING"], ["waiting", "SEND_SETTLING"], ["drafted", ""]], [["waiting", "SEND_SETTLING"], ["waiting", "SEND_SETTLING"], ["drafted", ""]], 0, 2, [0, 0]],
		"§25 FAILS ON THE OLD CODE: loads waiting to settle take none of a sweep's two attempts: another broker's load is drafted in the same sweep, on the first sweep and the next");

	const build = await SETTLE_CASES.podDuringBuild(jobLib);
	eq([build.first.state, build.first.smtp, build.first.append, build.first.number, build.first.stage, build.first.until === build.first.expected],
		[["waiting", "SEND_SETTLING"], 0, 0, "10202026-1", "reserved", true],
		"§25 FAILS ON THE OLD CODE: a POD uploaded during the build: nothing sent or drafted, the number kept, waiting 60 minutes from that POD");
	eq(build.after, { state: ["drafted", ""], delivery: "send", smtp: 1, sameNumber: true, mint: 1 }, "§25 ...then sent with the same number");

	const retry = await SETTLE_CASES.retryHeld(jobLib);
	eq([retry.queued, retry.held, retry.sent], [["queued", "RETRY_LATER"], { state: ["waiting", "SEND_SETTLING"], prepares: 1, mint: 0, until: retry.expectedUntil, attempts: 1 },
		{ state: ["drafted", ""], smtp: 1, prepares: 2 }],
	"§25 FAILS ON THE OLD CODE: a queued retry whose load got a new POD waits before the build (no engine call, no number), its attempt count kept, and is sent once settled");

	for (const [label, raw] of [["that can't be read", "not a time"], ["missing", null], ["a day ahead of the clock", (w) => sqliteStamp(w.now + 24 * HOUR)]]) {
		const u = await SETTLE_CASES.unknownTime(jobLib, raw);
		eq(u, { state: ["drafted", ""], smtp: 0, append: 1, refused: ["10202026-1: POD_TIME_UNKNOWN; drafted for a person instead"] },
			`§25 FAILS ON THE OLD CODE: a POD time ${label}: never sent, never left waiting: drafted for a person, with one refusal row`);
	}

	const stopped = await SETTLE_CASES.stoppedWhileWaiting(jobLib);
	eq(stopped, { waiting: ["waiting", "SEND_SETTLING"], after: ["drafted", ""], smtp: 0, append: 1 },
		"§25 FAILS ON THE OLD CODE: sending stopped while a load waits to settle: drafted at the next sweep, not after the wait");

	eq(await SETTLE_CASES.setting(jobLib, 0, [0]), [[0, "drafted", "", 1]], "§25 the setting handed to the job, 0: sent at once");
	eq(await SETTLE_CASES.setting(jobLib, 15, [0, 14, 15]), [[0, "waiting", "SEND_SETTLING", 0], [14, "waiting", "SEND_SETTLING", 0], [15, "drafted", "", 1]],
		"§25 FAILS ON THE OLD CODE: ...15: waiting until 15 minutes after the POD, then sent");

	eq(SETTLE_CASES.livePods(), ["2026-10-20T13:05:00Z", "2026-10-20T13:06:00Z", "2026-10-20T13:11:00Z", null],
		"§25 FAILS ON THE OLD CODE: ledger.livePodTimes(): the load's live POD rows (either spelling of its ID; deleted rows, other types and other loads left out), each stamp as SQLite reads it (an offset converted, an unreadable one null)");

	// Each decision removed in turn: the case that pins it must change.
	const JOB_FILE = path.join(ROOT, "lib", "auto-invoice-job.js");
	const LEDGER_FILE = path.join(ROOT, "lib", "auto-invoice-ledger.js");
	const jobMutants = [
		["a new load not held by the sweep", "const hold = v.state === \"queued\" ? settleHold(key, facts, nowMs) : null;", "const hold = null;",
			(lib) => SETTLE_CASES.slots(lib), (x) => JSON.stringify(x.first[2]) === JSON.stringify(["drafted", ""])],
		["a waiting load let go before it settles", "const hold = settleHold(c.load_key, facts, nowMs);", "const hold = null;",
			(lib) => SETTLE_CASES.slots(lib), (x) => JSON.stringify(x.second[2]) === JSON.stringify(["drafted", ""])],
		["the end of the wait not moved by a newer POD", "if (c.reason_code !== \"SEND_SETTLING\" || c.next_attempt_at !== hold.untilIso) {", "if (c.reason_code !== \"SEND_SETTLING\") {",
			(lib) => SETTLE_CASES.secondPod(lib), (x) => x.seen[2][3] === isoOf(x.P + 110 * MIN)],
		["no wait before the build", "if (hold) return release(fresh, \"waiting\", \"SEND_SETTLING\", { next_attempt_at: hold.untilIso });", "",
			(lib) => SETTLE_CASES.retryHeld(lib), (x) => x.held.prepares === 1 && x.held.mint === 0],
		["no second look after the build", "const g = sending ? sendRules.sendDecision({", "const g = sending ? sendRules.gate({",
			(lib) => SETTLE_CASES.podDuringBuild(lib), (x) => x.first.smtp === 0 && x.first.state[1] === "SEND_SETTLING"],
		["a POD time that can't be read drafted with no row", "} else if (g && (g.why === \"POD_TIME_UNKNOWN\" || g.why === \"SETTLING\")) {", "} else if (false) {",
			(lib) => SETTLE_CASES.unknownTime(lib, "not a time"), (x) => x.refused.length === 1],
		["the job deaf to the setting", "settleMinutes: triggerMode ? 0 : sendRules.settleMinutesOf(d.send.settleMinutes) }", "settleMinutes: sendRules.SETTLE_MINUTES_DEFAULT }",
			(lib) => SETTLE_CASES.setting(lib, 0, [0]), (x) => x[0][1] === "drafted"],
		["the stop not read before a wait", "stopped: Boolean(ledger.getSendStop(db)),\n\t\t\tto: facts.isBison", "stopped: false,\n\t\t\tto: facts.isBison",
			(lib) => SETTLE_CASES.stoppedWhileWaiting(lib), (x) => JSON.stringify(x.after) === JSON.stringify(["drafted", ""])],
		["a load with no sender held", "\t\tif (!sending || triggerMode) return null;\n\t\tconst g = sendRules.sendDecision(", "\t\tconst g = sendRules.sendDecision(",
			(lib) => SETTLE_CASES.draftsAtOnce(lib, { extra: { sendMail: undefined } }), (x) => x.append === 1],
		["Bison judged by the broker Email, not its inbox", "to: facts.isBison ? d.bisonRecipient() : facts.brokerEmail,", "to: facts.brokerEmail,",
			(lib) => SETTLE_CASES.draftsAtOnce(lib, { send: { enabled: true, domains: [SEND_DOMAIN, "example-bison-ap.test"] },
				setup: (w, id) => deliveredNoPod(w, id, { Email: BISON }, "billing@example-factor.test") }), (x) => x.prepares === 0],
	];
	for (const [label, from, to, run, pinned] of jobMutants) {
		const lib = mutantModule(JOB_FILE, from, to);
		ok(lib, `§25 MUTANT ${label}: applied to lib/auto-invoice-job.js once`);
		if (!lib) continue;
		ok(pinned(await run(jobLib)) && !pinned(await run(lib)), `§25 MUTANT ${label}: caught`);
	}
	// The ledger's read, put in place through its export for the case.
	const ledgerMutants = [
		["deleted PODs counted", " AND deleted_at IS NULL ORDER BY id", " ORDER BY id",
			() => SETTLE_CASES.deletedPod(jobLib), (x) => x.seen[3][1] === "drafted"],
		["the stored stamp not read by SQLite", "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', uploaded_at) AS at FROM documents", "SELECT uploaded_at AS at FROM documents",
			() => SETTLE_CASES.waitThenSend(jobLib, { at: [0] }), (x) => x.seen[0].state[1] === "SEND_SETTLING"],
		["one spelling of the load ID only", "\t\t.all(key, `#${key}`)\n\t\t.map((r) => r.at);", "\t\t.all(key, key)\n\t\t.map((r) => r.at);",
			() => SETTLE_CASES.livePods(), (x) => Array.isArray(x) && x.includes("2026-10-20T13:06:00Z")],
	];
	for (const [label, from, to, run, pinned] of ledgerMutants) {
		const lib = mutantModule(LEDGER_FILE, from, to);
		ok(lib, `§25 MUTANT ${label}: applied to lib/auto-invoice-ledger.js once`);
		if (!lib) continue;
		const real = pinned(await run());
		const mutated = pinned(await withPatched([[ledgerLib, "livePodTimes", lib.livePodTimes]], run));
		ok(real && !mutated, `§25 MUTANT ${label}: caught`);
	}
}

// ------------------------------------------------------------------ one load held, not all (§26-§29)
// Absent from a tree before it: its cases fail by name instead of the run.
const dryRunScript = optional(path.join(ROOT, "scripts", "auto-invoice-hold-dry-run.js"));
const ALERT_TO = "alerts@example.test";
const HELD_SUBJECT = (id) => `Load ${id}: changed after sending, needs a check`;
const STOP_SUBJECT = "Automatic invoice sending stopped";
const sha256Of = (data) => require("crypto").createHash("sha256").update(data).digest("hex");

// A send world whose alert emails land in w.alerts ({ to, subject, html }); each send answers the
// next of w.alertAnswers (true once none is left). `alertTo` "" is the setting unset.
function alertWorld({ alertTo = ALERT_TO, send = SEND_ON, dbFile = null } = {}) {
	const w = sendWorld({ send, dbFile });
	w.alerts = [];
	w.alertAnswers = [];
	w.invalidated = 0;
	w.sendAlertMail = async (to, subject, html) => {
		w.alerts.push({ to, subject, html });
		return w.alertAnswers.length ? w.alertAnswers.shift() : true;
	};
	w.holdDeps = (more = {}) => w.sendDeps({
		alertTo,
		sendAlertMail: w.sendAlertMail,
		invalidateJobTracking: () => { w.invalidated++; },
		readJobTracking: async () => (w.readOverride ? w.readOverride() : w.jt()),
		...more,
	});
	w.meta = () => ledgerLib.getMeta(w.db);
	return w;
}
async function holdStarted(lib, w, more = {}) {
	const job = lib.create(w.holdDeps(more));
	await job.tick();
	w.now += 5 * MIN;
	return job;
}
// Each load delivered and sent (two a sweep), the clock moved on after each sweep.
async function sendAll(w, job, ids) {
	for (const id of ids) w.ready(id);
	for (let i = 0; i <= ids.length && ids.some((id) => claimOf(w, id).state !== "drafted"); i++) {
		await job.tick();
		w.now += 6 * MIN;
	}
}
// The alerts waiting, sent now (a tree without them: nothing).
const alertsSent = async (job) => {
	if (job && typeof job.drainAlerts === "function") await job.drainAlerts();
};
const outbox = (w) => {
	try {
		return JSON.parse(w.meta().alert_outbox || "[]");
	} catch {
		return [];
	}
};
// The outbox's bound: only a mailbox that keeps refusing fills it.
const OUTBOX_MAX = 500;
const heldEntry = (w, i) => ({ id: `made-up-${i}`, kind: "held", subject: HELD_SUBJECT(`LD-TEST-${1000 + i}`), html: "<p>made-up</p>", at: isoOf(w.now) });
const turns = async (n = 4) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
// A sheet read that waits until opened, then answers what the sheet was when it began; reads after it
// answer the sheet as it is.
function slowFirstRead(w) {
	const was = w.jt();
	let open = null;
	const opened = new Promise((r) => { open = r; });
	let first = true;
	w.readOverride = () => {
		if (!first) return w.jt();
		first = false;
		return opened.then(() => was);
	};
	return () => open();
}
// The load's row as the Data Manager or the duplicate scanner hands it over: the header row and the
// row's cells, in the sheet's order.
const removedRows = (w, ids) => ({ headers: [...HEADERS], rows: ids.map((id) => HEADERS.map((h) => w.rows.find((r) => r["Load ID"] === id)[h] ?? "")) });
const noteRemoved = (job, removed) => (typeof job.rowsRemoved === "function" ? job.rowsRemoved(removed) : undefined);
const dropRow = (w, id) => w.rows.splice(w.rows.findIndex((r) => r["Load ID"] === id), 1);

// One change to a sent load, as a person or the sheet makes it.
const pay = (amount) => (w, id) => w.setRow(id, { "  Payment  ": amount });
const FIELD_CHANGES = Object.freeze({
	payment: pay("$1,250.00"),
	status: (w, id) => w.setRow(id, { "Job Status": "In Transit" }),
	cancelled: (w, id) => w.setRow(id, { "Job Status": "Cancelled" }),
	deletedInApp: (w, id) => w.db.prepare("INSERT INTO deleted_loads (load_id, deleted_by) VALUES (?, 'made-up-admin')").run(id),
	brokerDomain: (w, id) => w.setRow(id, { Email: "ops@example-other.test" }),
	brokerSameDomain: (w, id) => w.setRow(id, { Email: "ap@example-broker.test" }),
	brokerBlank: (w, id) => w.setRow(id, { Email: "" }),
	brokerTwo: (w, id) => w.setRow(id, { Email: "ops@example-broker.test, ap@example-broker.test" }),
	trailer: (w, id) => w.setRow(id, { "Trailer Number": "TR-2" }),
	pods: (w, id) => w.addPod(id),
	rateCons: (w, id) => w.db.prepare("INSERT INTO documents (load_id, type, file_name) VALUES (?, 'RATECON', 'made-up-rc-2.pdf')").run(id),
});
const rateConAtSend = (w, id) => w.db.prepare("INSERT INTO documents (load_id, type, file_name) VALUES (?, 'RATECON', 'made-up-rc-1.pdf')").run(id);
// Holds on sent loads, one step at a time: [load, hours after the step before, the change].
const BREAKER_STEPS = Object.freeze({
	three: [["LD-TEST-0830", 0, pay("$1,101.00")], ["LD-TEST-0831", 1, pay("$1,102.00")], ["LD-TEST-0832", 1, pay("$1,103.00")]],
	sameLoadTwice: [["LD-TEST-0830", 0, pay("$1,101.00")], ["LD-TEST-0830", 1, FIELD_CHANGES.status], ["LD-TEST-0831", 1, pay("$1,102.00")], ["LD-TEST-0832", 1, pay("$1,103.00")]],
	over25Hours: [["LD-TEST-0830", 0, pay("$1,101.00")], ["LD-TEST-0831", 12, pay("$1,102.00")], ["LD-TEST-0832", 13, pay("$1,103.00")]],
	resumed: [["LD-TEST-0830", 0, pay("$1,101.00")], ["LD-TEST-0831", 1, pay("$1,102.00")], ["LD-TEST-0832", 1, pay("$1,103.00")], ["LD-TEST-0833", 1, pay("$1,104.00")]],
	one: [["LD-TEST-0830", 0, pay("$1,101.00")]],
});
const AUDIT_TRAIL_SQL = "CREATE TABLE IF NOT EXISTS audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, user_id INTEGER, username TEXT, role TEXT, action TEXT, entity TEXT, entity_id TEXT, details TEXT)";

const HOLD_CASES = {
	// The 11-05 shape, made up: a sent invoice with one POD, a POD row added after it, the
	// next driver's load after that.
	async podAfterSend(lib, more = {}) {
		const w = alertWorld();
		const job = await holdStarted(lib, w, more);
		await sendAll(w, job, ["LD-TEST-0800"]);
		const sentFirst = [w.smtp.length, w.state("LD-TEST-0800"), claimOf(w, "LD-TEST-0800").delivery || ""];
		w.addPod("LD-TEST-0800");
		await job.tick();
		w.now += 5 * MIN;
		await job.tick();
		w.ready("LD-TEST-0801");
		await job.tick();
		await alertsSent(job);
		const c = claimOf(w, "LD-TEST-0800");
		const stop = w.stop();
		return { sentFirst, smtp: w.smtp.length, append: w.calls.append.length, stop: stop && stop.reason, chip: c.changed_fields, changedAt: c.changed_at,
			logged: w.actions("auto_invoice_load_change_logged").map((a) => [a.id, a.details]), changedRows: w.actions("auto_invoice_load_changed").length,
			notices: w.notices.map((n) => n.title), alerts: w.alerts.map((a) => a.subject), next: [w.state("LD-TEST-0801"), claimOf(w, "LD-TEST-0801").delivery || ""],
			held: w.meta().held_loads || "" };
	},
	// One change to a sent load, then the next driver's load.
	async field(lib, change, { env = {}, before = null } = {}) {
		const w = alertWorld();
		const job = await holdStarted(lib, w, { env });
		if (before) before(w, "LD-TEST-0820");
		await sendAll(w, job, ["LD-TEST-0820"]);
		change(w, "LD-TEST-0820");
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0821");
		await job.tick();
		await alertsSent(job);
		const c = claimOf(w, "LD-TEST-0820");
		const stop = w.stop();
		return { chip: c.changed_fields, stop: stop && stop.reason, next: [w.state("LD-TEST-0821"), claimOf(w, "LD-TEST-0821").delivery || ""],
			logged: w.actions("auto_invoice_load_change_logged").map((a) => a.details), alerts: w.alerts.map((a) => a.subject), notices: w.notices.map((n) => n.title),
			texts: w.alerts.map((a) => a.html) };
	},
	// BREAKER_STEPS, with the stop's reason after each step. `resumeBefore`: the resume script runs
	// before that step; `setup(w)`: before the first.
	async breaker(lib, steps, { resumeBefore = -1, setup = null } = {}) {
		const w = alertWorld();
		const job = await holdStarted(lib, w);
		await sendAll(w, job, [...new Set(steps.map(([id]) => id))]);
		w.db.exec(AUDIT_TRAIL_SQL);
		if (setup) setup(w);
		const stops = [];
		for (const [i, [id, hours, change]] of steps.entries()) {
			if (i === resumeBefore && resumeScript) resumeScript.run({ db: w.db, dryRun: false, nowIso: isoOf(w.now) });
			w.now += hours * HOUR;
			change(w, id);
			await job.tick();
			const stop = w.stop();
			stops.push(stop ? stop.reason : null);
		}
		await alertsSent(job);
		return { stops, held: w.meta().held_loads || "", alerts: w.alerts.map((a) => a.subject), w, job };
	},
	// Six loads' payments changed in one sweep, then a seventh's a while later.
	async sixHeld(lib) {
		const w = alertWorld();
		const job = await holdStarted(lib, w);
		const ids = ["LD-TEST-0840", "LD-TEST-0841", "LD-TEST-0842", "LD-TEST-0843", "LD-TEST-0844", "LD-TEST-0845", "LD-TEST-0846"];
		await sendAll(w, job, ids);
		for (const id of ids.slice(0, 6)) FIELD_CHANGES.payment(w, id);
		await job.tick();
		await alertsSent(job);
		const first = w.alerts.map((a) => a.subject);
		const firstTexts = w.alerts.map((a) => a.html);
		const sixth = claimOf(w, ids[5]);
		const sixthTold = [sixth.changed_fields, w.actions("auto_invoice_load_changed").filter((a) => a.id === ids[5]).length,
			w.notices.filter((n) => n.title === "Sent invoice: load changed" && n.body.includes(ids[5])).length];
		w.now += 10 * MIN;
		FIELD_CHANGES.payment(w, ids[6]);
		await job.tick();
		await alertsSent(job);
		return { first, firstTexts, sixthTold, later: w.alerts.slice(first.length).map((a) => a.subject), every: w.alerts, logs: w.logs };
	},
	// Five loads held in one sweep (the breaker stops sending at the third), the resume script 20
	// minutes later, then two more loads held: sending is on again.
	async resumedSoon(lib) {
		const w = alertWorld();
		const job = await holdStarted(lib, w);
		const ids = ["LD-TEST-0880", "LD-TEST-0881", "LD-TEST-0882", "LD-TEST-0883", "LD-TEST-0884", "LD-TEST-0885", "LD-TEST-0886"];
		await sendAll(w, job, ids);
		w.db.exec(AUDIT_TRAIL_SQL);
		for (const id of ids.slice(0, 5)) FIELD_CHANGES.payment(w, id);
		await job.tick();
		await alertsSent(job);
		const before = w.alerts.map((a) => a.subject);
		const stoppedBy = (w.stop() || {}).reason || null;
		w.now += 20 * MIN;
		if (resumeScript) resumeScript.run({ db: w.db, dryRun: false, nowIso: isoOf(w.now) });
		const resumed = w.stop();
		FIELD_CHANGES.payment(w, ids[5]);
		FIELD_CHANGES.payment(w, ids[6]);
		w.now += 5 * MIN;
		await job.tick();
		await alertsSent(job);
		return { before, stoppedBy, resumed, after: w.alerts.slice(before.length).map((a) => a.subject), chips: [claimOf(w, ids[5]).changed_fields, claimOf(w, ids[6]).changed_fields],
			stop: (w.stop() || {}).reason || null, texts: w.alerts.slice(before.length).map((a) => /Other loads keep sending/.test(a.html)) };
	},
	// Two sent loads corrected step by step, a sweep after each step, within the hour: six holds on
	// two loads, the last load A cancelled after its invoice went.
	async stepByStep(lib) {
		const w = alertWorld();
		const job = await holdStarted(lib, w);
		const [A, B] = ["LD-TEST-0890", "LD-TEST-0891"];
		await sendAll(w, job, [A, B]);
		const steps = [
			() => FIELD_CHANGES.payment(w, A),
			() => FIELD_CHANGES.brokerDomain(w, A),
			() => w.setRow(A, { "  Payment  ": "$1,250.00", Email: "ops@example-other.test", "Job Status": "In Transit" }),
			() => FIELD_CHANGES.payment(w, B),
			() => FIELD_CHANGES.brokerDomain(w, B),
			() => w.setRow(A, { "  Payment  ": "$1,250.00", Email: "ops@example-other.test", "Job Status": "Cancelled" }),
		];
		for (const step of steps) {
			step();
			w.now += 5 * MIN;
			await job.tick();
			await alertsSent(job);
		}
		return { chip: claimOf(w, A).changed_fields, stop: (w.stop() || {}).reason || null, alerts: w.alerts.map((a) => a.subject), held: w.actions("auto_invoice_load_changed").length,
			last: w.alerts.length ? w.alerts[w.alerts.length - 1].html : "" };
	},
	// 49 emails already waiting on a mailbox that refused (its next try a day away), then three loads
	// held in one sweep: the third trips the breaker.
	async crowded(lib) {
		const w = alertWorld();
		const job = await holdStarted(lib, w);
		const ids = ["LD-TEST-0895", "LD-TEST-0896", "LD-TEST-0897"];
		await sendAll(w, job, ids);
		ledgerLib.setMeta(w.db, "alert_outbox", JSON.stringify(Array.from({ length: 49 }, (_, i) => heldEntry(w, i))));
		ledgerLib.setMeta(w.db, "alert_retry_at", isoOf(w.now + 24 * HOUR));
		for (const id of ids) FIELD_CHANGES.payment(w, id);
		await job.tick();
		const box = outbox(w);
		return { length: box.length, first: box[0] && box[0].id, last: box.slice(-4).map((a) => a.subject), stop: (w.stop() || {}).reason || null };
	},
	// The driver's trigger off: Mark checked pressed on a sent load while the sweep's own sheet read is
	// out, a person having changed the payment just before.
	async checkedDuringRead(lib) {
		const w = alertWorld();
		const job = await holdStarted(lib, w);
		await sendAll(w, job, ["LD-TEST-0875"]);
		const open = slowFirstRead(w);
		FIELD_CHANGES.payment(w, "LD-TEST-0875");
		w.now += 5 * MIN;
		const ticking = job.tick();
		await turns();
		const f = fakeApp();
		job.mount(f.app, { requireRole: f.requireRole, refuseCrossSite: (req, res, next) => next() });
		w.now += 1000;
		const r = await f.call("POST", "/api/auto-invoice/loads/:loadKey/checked", { params: { loadKey: "LD-TEST-0875" } });
		const atPress = [r.status, claimOf(w, "LD-TEST-0875").changed_fields, Boolean(claimOf(w, "LD-TEST-0875").checked_at)];
		open();
		await ticking;
		await alertsSent(job);
		w.now += 5 * MIN;
		await job.tick();
		await alertsSent(job);
		return { atPress, chip: claimOf(w, "LD-TEST-0875").changed_fields, stop: (w.stop() || {}).reason || null, alerts: w.alerts.length, held: w.meta().held_loads || "",
			changedRows: w.actions("auto_invoice_load_changed").length };
	},
	// Mark checked pressed while the sheet reads back no load rows, then a sweep with the sheet back.
	async checkedOnEmptyRead(lib) {
		const w = alertWorld();
		const job = await holdStarted(lib, w);
		await sendAll(w, job, ["LD-TEST-0877"]);
		const kept = claimOf(w, "LD-TEST-0877").fingerprint_json;
		w.readOverride = () => Object.freeze({ headers: HEADERS, data: Object.freeze([]) });
		const f = fakeApp();
		job.mount(f.app, { requireRole: f.requireRole, refuseCrossSite: (req, res, next) => next() });
		w.now += MIN;
		const r = await f.call("POST", "/api/auto-invoice/loads/:loadKey/checked", { params: { loadKey: "LD-TEST-0877" } });
		const c = claimOf(w, "LD-TEST-0877");
		w.readOverride = null;
		w.now += 5 * MIN;
		await job.tick();
		await alertsSent(job);
		return { press: [r.status, r.body && r.body.code, c.fingerprint_json === kept, c.checked_at], chip: claimOf(w, "LD-TEST-0877").changed_fields, alerts: w.alerts.length,
			held: w.meta().held_loads || "" };
	},
	// A sent load's row removed in the app (the Data Manager or the duplicate scanner), then the next
	// driver's load. `how`: "only row" (the load's one row goes), "duplicate" (another row of the load
	// stays; the month moved to the archive later), "during a read" (a sweep read the sheet before the
	// removal), "checked" (the only row, then Mark checked), "cancelled first" (flagged as cancelled,
	// then its row removed), "off" (AUTO_INVOICE_HOLD_ONE_LOAD=false).
	async removedInApp(lib, how) {
		const w = alertWorld();
		const job = await holdStarted(lib, w, how === "off" ? { env: { AUTO_INVOICE_HOLD_ONE_LOAD: "false" } } : {});
		await sendAll(w, job, ["LD-TEST-0910"]);
		const out = {};
		if (how === "during a read") {
			const removed = removedRows(w, ["LD-TEST-0910"]);
			const open = slowFirstRead(w);
			w.now += 5 * MIN;
			const ticking = job.tick();
			await turns();
			w.now += 1000;
			noteRemoved(job, removed);
			dropRow(w, "LD-TEST-0910");
			open();
			await ticking;
			out.afterStaleRead = [claimOf(w, "LD-TEST-0910").changed_fields, Boolean(claimOf(w, "LD-TEST-0910").removed_in_app_at)];
		} else {
			if (how === "cancelled first") {
				FIELD_CHANGES.cancelled(w, "LD-TEST-0910");
				w.now += 5 * MIN;
				await job.tick();
				await alertsSent(job);
				out.cancelled = [claimOf(w, "LD-TEST-0910").changed_fields, w.alerts.length];
			}
			noteRemoved(job, removedRows(w, ["LD-TEST-0910"]));
			out.noted = Boolean(claimOf(w, "LD-TEST-0910").removed_in_app_at);
			if (how !== "duplicate") dropRow(w, "LD-TEST-0910");
		}
		w.now += 5 * MIN;
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0911");
		await job.tick();
		await alertsSent(job);
		const c = claimOf(w, "LD-TEST-0910");
		Object.assign(out, { chip: c.changed_fields, note: c.removed_in_app_at || "", stop: (w.stop() || {}).reason || null, alerts: w.alerts.map((a) => a.subject),
			texts: w.alerts.map((a) => a.html), changed: w.actions("auto_invoice_load_changed").map((a) => a.details), notices: w.notices.map((n) => n.title),
			held: w.meta().held_loads ? JSON.parse(w.meta().held_loads).length : 0, next: [w.state("LD-TEST-0911"), claimOf(w, "LD-TEST-0911").delivery || ""],
			logged: w.actions("auto_invoice_load_change_logged").map((a) => a.details) });
		if (how === "duplicate") {
			dropRow(w, "LD-TEST-0910");
			w.now += 5 * MIN;
			await job.tick();
			await alertsSent(job);
			out.archived = { chip: claimOf(w, "LD-TEST-0910").changed_fields, alerts: w.alerts.length, logged: w.actions("auto_invoice_load_change_logged").map((a) => a.details) };
		}
		if (how === "checked") {
			const f = fakeApp();
			job.mount(f.app, { requireRole: f.requireRole, refuseCrossSite: (req, res, next) => next() });
			const r = await f.call("POST", "/api/auto-invoice/loads/:loadKey/checked", { params: { loadKey: "LD-TEST-0910" } });
			const after = claimOf(w, "LD-TEST-0910");
			w.now += 5 * MIN;
			await job.tick();
			await alertsSent(job);
			out.checked = { status: r.status, cleared: [after.changed_fields, after.removed_in_app_at || ""], chip: claimOf(w, "LD-TEST-0910").changed_fields, alerts: w.alerts.length,
				logged: w.actions("auto_invoice_load_change_logged").map((a) => a.details) };
		}
		return out;
	},
	// The driver's trigger off: an email that answered false goes out at a later tick, with no other call.
	async tickDrains(lib) {
		const w = alertWorld();
		const job = await holdStarted(lib, w);
		await sendAll(w, job, ["LD-TEST-0878"]);
		w.alertAnswers = [false];
		FIELD_CHANGES.payment(w, "LD-TEST-0878");
		w.now += 5 * MIN;
		await job.tick();
		await turns();
		const tries = w.alerts.length;
		w.now += 6 * MIN;
		await job.tick();
		await turns();
		return [tries, w.alerts.length, outbox(w).length];
	},
	// The switch off, a read with no load rows.
	async offEmptyRead(lib) {
		const w = alertWorld();
		const job = await holdStarted(lib, w, { env: { AUTO_INVOICE_HOLD_ONE_LOAD: "false" } });
		await sendAll(w, job, ["LD-TEST-0879"]);
		w.readOverride = () => Object.freeze({ headers: HEADERS, data: Object.freeze([]) });
		w.now += 5 * MIN;
		await job.tick();
		return [claimOf(w, "LD-TEST-0879").changed_fields.split(",").includes("removed"), (w.stop() || {}).reason || null];
	},
	// A load held while a Super Admin's Stop is set.
	async heldWhileStopped(lib) {
		const w = alertWorld();
		const job = await holdStarted(lib, w);
		await sendAll(w, job, ["LD-TEST-0876"]);
		ledgerLib.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: isoOf(w.now) });
		FIELD_CHANGES.payment(w, "LD-TEST-0876");
		w.now += 5 * MIN;
		await job.tick();
		await alertsSent(job);
		return [claimOf(w, "LD-TEST-0876").changed_fields, w.alerts.map((a) => a.subject), w.alerts.some((a) => /Other loads keep sending/.test(a.html))];
	},
	// A row gone from the sheet: three loads (a month moved to the archive), with another row left on it.
	async archived(lib) {
		const w = alertWorld();
		let archiveReads = 0;
		const job = await holdStarted(lib, w, { readArchive: () => { archiveReads++; return []; } });
		const ids = ["LD-TEST-0860", "LD-TEST-0861", "LD-TEST-0862"];
		await sendAll(w, job, ids);
		w.setRow("LD-TEST-0869", { "Job Status": "In Transit" });
		for (const id of ids) w.rows.splice(w.rows.findIndex((r) => r["Load ID"] === id), 1);
		await job.tick();
		w.now += 5 * MIN;
		await job.tick();
		await alertsSent(job);
		const stop = w.stop();
		return { logged: w.actions("auto_invoice_load_change_logged").map((a) => [a.id, a.details]), chips: ids.map((id) => claimOf(w, id).changed_fields),
			held: w.meta().held_loads || "", alerts: w.alerts.length, stop: stop && stop.reason, archiveReads, notices: w.notices.map((n) => n.title) };
	},
	// A read of the sheet with no load rows, or no Load ID column.
	async unreadable(lib, how) {
		const w = alertWorld();
		const job = await holdStarted(lib, w);
		await sendAll(w, job, ["LD-TEST-0865"]);
		w.readOverride = how === "no rows"
			? () => Object.freeze({ headers: HEADERS, data: Object.freeze([]) })
			: () => Object.freeze({ headers: HEADERS.filter((h) => h !== "Load ID"), data: Object.freeze(w.rows.map(({ "Load ID": _id, ...rest }) => rest)) });
		await job.tick();
		w.now += 5 * MIN;
		await job.tick();
		await alertsSent(job);
		const c = claimOf(w, "LD-TEST-0865");
		const stop = w.stop();
		return { chip: c.changed_fields, logged: w.actions("auto_invoice_load_change_logged").length, stop: stop && stop.reason, alerts: w.alerts.length,
			said: w.logs.filter((l) => /no load rows/.test(l)).length };
	},
	// A send that answers false ten times: the waits, any try made before a wait was over (a restart
	// on the way), then the send that goes.
	async backoff(lib) {
		const w = alertWorld();
		let job = await holdStarted(lib, w);
		await sendAll(w, job, ["LD-TEST-0850"]);
		w.alertAnswers = Array(10).fill(false);
		FIELD_CHANGES.payment(w, "LD-TEST-0850");
		await job.tick();
		await alertsSent(job);
		const waits = [];
		let early = 0;
		for (let i = 0; i < 9; i++) {
			const wait = Number(w.meta().alert_wait_ms || 0);
			waits.push(wait / MIN);
			if (!wait) break;
			const tries = w.alerts.length;
			w.now += wait - MIN;
			if (i === 1) job = lib.create(w.holdDeps());
			await alertsSent(job);
			if (w.alerts.length !== tries) early++;
			w.now += MIN;
			await alertsSent(job);
		}
		const left = outbox(w).length;
		w.now += 6 * HOUR;
		await alertsSent(job);
		return { waits, early, final: [left, outbox(w).length, w.meta().alert_wait_ms || "", w.alerts.length] };
	},
	// A full outbox: OUTBOX_MAX held-load emails waiting, then a Super Admin's Stop and a load held; and
	// one whose oldest entry is a stop, then a load held.
	async fullOutbox(lib) {
		const w = alertWorld();
		const job = await holdStarted(lib, w);
		await sendAll(w, job, ["LD-TEST-0857", "LD-TEST-0858"]);
		ledgerLib.setMeta(w.db, "alert_outbox", JSON.stringify(Array.from({ length: OUTBOX_MAX }, (_, i) => heldEntry(w, i))));
		ledgerLib.setMeta(w.db, "alert_retry_at", isoOf(w.now + 24 * HOUR));
		const f = fakeApp();
		job.mount(f.app, { requireRole: f.requireRole, refuseCrossSite: (req, res, next) => next() });
		await f.call("POST", "/api/auto-invoice/send/stop", { body: {} });
		const afterStop = outbox(w);
		FIELD_CHANGES.payment(w, "LD-TEST-0857");
		await job.tick();
		const afterHold = outbox(w);
		const stopFirst = [{ id: "made-up-stop", kind: "stop", subject: STOP_SUBJECT, html: "<p>made-up</p>", at: isoOf(w.now) }, ...Array.from({ length: OUTBOX_MAX - 1 }, (_, i) => heldEntry(w, 1000 + i))];
		ledgerLib.setMeta(w.db, "alert_outbox", JSON.stringify(stopFirst));
		w.now += 2 * HOUR;
		FIELD_CHANGES.payment(w, "LD-TEST-0858");
		await job.tick();
		const oldestStop = outbox(w);
		return {
			afterStop: [afterStop.length, afterStop.filter((a) => a.kind === "stop").length, afterStop[0] && afterStop[0].id],
			afterHold: [afterHold.length, afterHold.filter((a) => a.kind === "stop").length, afterHold[afterHold.length - 1] && afterHold[afterHold.length - 1].subject],
			oldestStop: [oldestStop.length, oldestStop.filter((a) => a.kind === "stop").length, oldestStop[0] && oldestStop[0].id, oldestStop[oldestStop.length - 1] && oldestStop[oldestStop.length - 1].subject],
		};
	},
	// The status and settings reads, with or without an alert address.
	async reads(lib, alertTo) {
		const w = alertWorld({ alertTo });
		const job = await holdStarted(lib, w);
		const f = fakeApp();
		job.mount(f.app, { requireRole: f.requireRole, refuseCrossSite: (req, res, next) => next() });
		return { status: (await f.call("GET", "/api/auto-invoice/status")).body, settings: (await f.call("GET", "/api/auto-invoice/settings")).body, logs: w.logs };
	},
	// Chips as main left them, then Mark checked.
	async oldChips(lib) {
		const w = alertWorld();
		const job = await holdStarted(lib, w);
		await sendAll(w, job, ["LD-TEST-0870", "LD-TEST-0871"]);
		const at = isoOf(w.now);
		w.addPod("LD-TEST-0870");
		w.db.prepare("UPDATE auto_invoice_claims SET changed_at = ?, changed_fields = 'pods' WHERE load_key = 'ld-test-0870'").run(at);
		w.addPod("LD-TEST-0871");
		FIELD_CHANGES.payment(w, "LD-TEST-0871");
		w.db.prepare("UPDATE auto_invoice_claims SET changed_at = ?, changed_fields = 'payment,pods' WHERE load_key = 'ld-test-0871'").run(at);
		w.now += 5 * MIN;
		await job.tick();
		w.now += 5 * MIN;
		await job.tick();
		await alertsSent(job);
		const view = (id) => {
			const c = claimOf(w, id);
			return [c.changed_fields, c.changed_at === at];
		};
		const before = { a: view("LD-TEST-0870"), b: view("LD-TEST-0871"), held: w.actions("auto_invoice_load_changed").length, alerts: w.alerts.length,
			logged: w.actions("auto_invoice_load_change_logged").map((a) => [a.id, a.details]), stop: (w.stop() || {}).reason || null };
		const f = fakeApp();
		job.mount(f.app, { requireRole: f.requireRole, refuseCrossSite: (req, res, next) => next() });
		const r = await f.call("POST", "/api/auto-invoice/loads/:loadKey/checked", { params: { loadKey: "LD-TEST-0870" } });
		const c = claimOf(w, "LD-TEST-0870");
		w.now += 5 * MIN;
		await job.tick();
		return { before, checked: [r.status, c.changed_fields, c.change_logged_json, c.change_logged_at, w.invalidated], afterTick: [claimOf(w, "LD-TEST-0870").changed_fields, w.actions("auto_invoice_load_change_logged").length] };
	},
};

// What a world did, as main's code can see it: the claims' own columns, the job's meta, the audit
// rows, the notices, every message handed to SMTP or Gmail, the draft rows and the logs (but the
// one line this PR adds when no alert address is set).
const MAIN_CLAIM_COLUMNS = ["load_key", "load_id", "state", "reason_code", "first_seen_at", "attempts", "ratecon_checks", "next_attempt_at", "lease_owner", "lease_until",
	"stage", "invoice_id", "invoice_date", "reserved_at", "message_id", "sent_json", "draft_row_id", "drafted_at", "fingerprint_json", "changed_at", "changed_fields",
	"checked_at", "checked_by", "number_voided_at", "updated_at", "draft_digest_json", "delivery", "sent_at", "send_checks", "look_first", "check_held_at"];
function mainDigest(w) {
	return sha256Of(JSON.stringify({
		claims: w.db.prepare(`SELECT ${MAIN_CLAIM_COLUMNS.join(", ")} FROM auto_invoice_claims ORDER BY load_key`).all(),
		meta: w.db.prepare("SELECT key, value FROM auto_invoice_meta ORDER BY key").all(),
		audits: w.audits,
		notices: w.notices,
		smtp: w.smtp || [],
		appends: w.calls.append,
		drafts: w.db.prepare("SELECT load_id, invoice_id, recipient, via FROM load_invoice_drafts ORDER BY id").all(),
		logs: w.logs.filter((l) => !/alert emails off/.test(l)),
	}));
}
// Paths these rules don't change, run the same way on main (ea4497a6) and here.
const MAIN_CASES = {
	// A filled load sent and never changed: more sweeps, and a Super Admin's rows.
	async unchanged(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0900");
		await job.tick();
		for (let i = 0; i < 3; i++) {
			w.now += 5 * MIN;
			await job.tick();
		}
		job.annotateCompletedRows({ rows: w.rows.map((r) => ({ ...r })), headers: HEADERS, isSuperAdmin: true });
		return mainDigest(w);
	},
	// A draft nobody sent (its domain isn't on the send list), changed field by field: every field, a
	// chip and a notice each time, as on main. The last step takes its row off the sheet.
	async draftChanged(lib) {
		const w = sendWorld({ send: { enabled: true, domains: ["example-other.test"] } });
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0901");
		await job.tick();
		const steps = [
			FIELD_CHANGES.payment, FIELD_CHANGES.trailer, FIELD_CHANGES.pods, FIELD_CHANGES.brokerSameDomain, FIELD_CHANGES.rateCons, FIELD_CHANGES.status, FIELD_CHANGES.deletedInApp,
			(x, id) => { x.rows.splice(x.rows.findIndex((r) => r["Load ID"] === id), 1); x.setRow("LD-TEST-0999", { "Job Status": "In Transit" }); },
		];
		for (const step of steps) {
			step(w, "LD-TEST-0901");
			w.now += 5 * MIN;
			await job.tick();
		}
		return mainDigest(w);
	},
	// The switch off: a payment changed after a send stops all sending, and the next load is drafted.
	async switchOff(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w, { env: { AUTO_INVOICE_HOLD_ONE_LOAD: "false" } });
		w.ready("LD-TEST-0902");
		await job.tick();
		w.now += 5 * MIN;
		FIELD_CHANGES.payment(w, "LD-TEST-0902");
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0903");
		await job.tick();
		return mainDigest(w);
	},
	// Gmail refuses an invoice: the stop, the draft and the next load's draft.
	async refused(lib) {
		const w = sendWorld();
		const job = await sendStarted(lib, w);
		w.ready("LD-TEST-0904");
		w.smtpBehaviors = ["REFUSED"];
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0905");
		await job.tick();
		return mainDigest(w);
	},
};
// Each case's digest on main (ea4497a6), recorded by running the case there.
const MAIN_DIGESTS = Object.freeze({
	unchanged: "7b98d14aa1f49d413387e64cd47d20ae7ebaf53a5a9805d9393c313a06d0127e",
	draftChanged: "7eb5cce96c1097e0444b8b15388fe89244c3800a6cc6133577df732d486b4e3a",
	switchOff: "265cf7e8edb72f029ceb32bf13bd63fa35e71a144b3d459870cb9ceefd85837e",
	refused: "20b8087aedd71d9752c7acee209dcd86f03c36e2f4771c36788a0db3d5a4621d",
});

// The dry run's world: eight loads sent; one already flagged on payment, and held an hour before; then
// the changes the first check after the deploy finds. `trip`: one more hold, enough for the breaker;
// `removed`: one more, a row removed in the app.
async function dryRunWorld({ trip, removed = false }) {
	const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "auto-invoice-hold-dry-run-"));
	const file = path.join(TMP, "app.db");
	const w = alertWorld({ dbFile: file });
	const job = await holdStarted(jobLib, w);
	const ids = ["LD-TEST-0960", "LD-TEST-0961", "LD-TEST-0962", "LD-TEST-0963", "LD-TEST-0964", "LD-TEST-0965", "LD-TEST-0966", "LD-TEST-0967"];
	await sendAll(w, job, ids);
	FIELD_CHANGES.payment(w, ids[7]);
	w.db.prepare("UPDATE auto_invoice_claims SET changed_at = ?, changed_fields = 'payment' WHERE load_key = ?").run(isoOf(w.now - HOUR), rules.loadKey(ids[7]));
	ledgerLib.setMeta(w.db, "held_loads", JSON.stringify([{ load: rules.loadKey(ids[7]), at: isoOf(w.now - HOUR) }]));
	FIELD_CHANGES.payment(w, ids[0]);
	FIELD_CHANGES.pods(w, ids[1]);
	FIELD_CHANGES.trailer(w, ids[2]);
	w.rows.splice(w.rows.findIndex((r) => r["Load ID"] === ids[3]), 1);
	FIELD_CHANGES.brokerSameDomain(w, ids[4]);
	if (trip) FIELD_CHANGES.cancelled(w, ids[5]);
	if (removed) {
		noteRemoved(job, removedRows(w, [ids[6]]));
		dropRow(w, ids[6]);
	}
	return { w, job, ids, file, TMP, values: () => [HEADERS, ...w.rows.map((r) => HEADERS.map((h) => r[h]))] };
}
// What the check did to each claim: new holds by field, new logged fields, rows gone, the breaker.
function checkDid(before, after, stop) {
	const did = { hold: {}, holdLoads: 0, log: {}, logLoads: 0, gone: 0, trips: Boolean(stop && stop.reason === "TOO_MANY_HELD") };
	for (const c of after) {
		const was = before.find((x) => x.load_key === c.load_key) || {};
		if (c.changed_at !== was.changed_at) {
			did.holdLoads++;
			for (const f of c.changed_fields.split(",")) did.hold[f] = (did.hold[f] || 0) + 1;
		}
		const mem = (json) => {
			try {
				return JSON.parse(json || "{}");
			} catch {
				return {};
			}
		};
		const [m0, m1] = [mem(was.change_logged_json), mem(c.change_logged_json)];
		const fields = Object.keys(m1).filter((f) => f !== "gone" && m1[f] !== m0[f]);
		if (fields.length) did.logLoads++;
		for (const f of fields) did.log[f] = (did.log[f] || 0) + 1;
		if (m1.gone && !m0.gone) did.gone++;
	}
	return did;
}

async function holdSections() {
	// ---------------------------------------------------------------- §26
	section("§26 a change after a send holds that load alone (AUTO_INVOICE_HOLD_ONE_LOAD)");

	// The main case: the 11-05 shape. Logged, no chip, no stop, no other load touched, the next one sent.
	const pod = await HOLD_CASES.podAfterSend(jobLib);
	eq(pod.sentFirst, [1, ["drafted", ""], "send"], "§26 a load sent by SMTP");
	eq([pod.stop, pod.chip, pod.changedAt, pod.changedRows, pod.held], [null, "", "", 0, ""],
		"§26 FAILS ON THE OLD CODE: a POD row added after the send: no stop, no chip, nothing counted toward the breaker");
	eq(pod.logged, [["LD-TEST-0800", "10202026-1: pods: +1 -0"]], "§26 FAILS ON THE OLD CODE: ...one audit row says what changed, once, however many sweeps see it");
	eq([pod.notices, pod.alerts], [[], []], "§26 FAILS ON THE OLD CODE: ...no notice and no email");
	eq([pod.next, pod.smtp, pod.append], [[["drafted", ""], "send"], 2, 0], "§26 FAILS ON THE OLD CODE: ...and the next driver's load is sent, not drafted");

	// Each field, both sides of each rule (plan §2.2), with the switch on (by default).
	const ON_CASES = [
		["payment", FIELD_CHANGES.payment, "payment", []],
		["Delivered undone", FIELD_CHANGES.status, "status", []],
		["a cancelled row", FIELD_CHANGES.cancelled, "status,removed", []],
		["deleted in the app (the row stays, with its tombstone)", FIELD_CHANGES.deletedInApp, "removed", []],
		["the broker email's domain", FIELD_CHANGES.brokerDomain, "brokerEmail", []],
		["the broker email, the same domain", FIELD_CHANGES.brokerSameDomain, "", ["10202026-1: brokerEmail: same domain"]],
		["the broker email blanked", FIELD_CHANGES.brokerBlank, "", ["10202026-1: brokerEmail: blank"]],
		["two addresses in the Email cell (read as blank)", FIELD_CHANGES.brokerTwo, "", ["10202026-1: brokerEmail: blank"]],
		["the trailer", FIELD_CHANGES.trailer, "", ["10202026-1: trailer"]],
		["a POD row added", FIELD_CHANGES.pods, "", ["10202026-1: pods: +1 -0"]],
		["a first rate-con row (none at the send)", FIELD_CHANGES.rateCons, "", ["10202026-1: rateCons: +1 -0"]],
	];
	for (const [label, change, chip, logged] of ON_CASES) {
		const r = await HOLD_CASES.field(jobLib, change);
		eq([r.chip, r.stop, r.next, r.logged, r.alerts], [chip, null, [["drafted", ""], "send"], logged, chip ? [HELD_SUBJECT("LD-TEST-0820")] : []],
			`§26 FAILS ON THE OLD CODE: ${label}: ${chip ? `that load is flagged (${chip}) and emailed` : "logged once"}, no stop, the next load sent`);
	}
	const replaced = await HOLD_CASES.field(jobLib, FIELD_CHANGES.rateCons, { before: rateConAtSend });
	eq([replaced.chip, replaced.stop, replaced.next], ["rateCons", null, [["drafted", ""], "send"]], "§26 FAILS ON THE OLD CODE: a rate con replaced (one existed at the send): flagged, no stop");
	const payText = await HOLD_CASES.field(jobLib, FIELD_CHANGES.payment);
	ok(payText.notices.includes("Sent invoice: load changed") && !payText.notices.includes("Automatic invoice sending stopped"), "§26 FAILS ON THE OLD CODE: ...a flagged load has today's notice, and no stop's");

	// The kill switch "false": today's stop on every field, the next load drafted (plan: keeps it reachable).
	const OFF = { env: { AUTO_INVOICE_HOLD_ONE_LOAD: "false" } };
	for (const name of ["payment", "status", "deletedInApp", "brokerDomain", "trailer", "pods", "rateCons"]) {
		const r = await HOLD_CASES.field(jobLib, FIELD_CHANGES[name], OFF);
		const field = { deletedInApp: "removed", brokerDomain: "brokerEmail" }[name] || name;
		eq([r.chip, r.stop, r.next], [field, "LOAD_CHANGED_AFTER_SEND", [["drafted", ""], ""]], `§26 AUTO_INVOICE_HOLD_ONE_LOAD=false, ${field}: all sending stops, as before, and the next load is drafted`);
	}
	const offMail = await HOLD_CASES.field(jobLib, FIELD_CHANGES.pods, OFF);
	eq(offMail.alerts, [HELD_SUBJECT("LD-TEST-0820"), STOP_SUBJECT], "§26 FAILS ON THE OLD CODE: ...and the emails stay on with it: the load's, then the stop's");
	ok(offMail.texts[0] && /its PODs changed/.test(offMail.texts[0]) && !/Other loads keep sending/.test(offMail.texts[0]), "§26 FAILS ON THE OLD CODE: ...the load's never says other loads keep sending");

	// The breaker: a third different load held within 24 hours stops all sending.
	eq((await HOLD_CASES.breaker(jobLib, BREAKER_STEPS.three)).stops, [null, null, "TOO_MANY_HELD"], "§26 FAILS ON THE OLD CODE: two loads held: sending goes on; a third: TOO_MANY_HELD");
	eq((await HOLD_CASES.breaker(jobLib, BREAKER_STEPS.sameLoadTwice)).stops, [null, null, null, "TOO_MANY_HELD"], "§26 FAILS ON THE OLD CODE: one load held twice counts once");
	eq((await HOLD_CASES.breaker(jobLib, BREAKER_STEPS.over25Hours)).stops, [null, null, null], "§26 FAILS ON THE OLD CODE: three loads over 25 hours: no stop");
	const resumed = await HOLD_CASES.breaker(jobLib, BREAKER_STEPS.resumed, { resumeBefore: 3 });
	eq(resumed.stops, [null, null, "TOO_MANY_HELD", null], "§26 FAILS ON THE OLD CODE: after a resume, the count starts again");
	eq((await HOLD_CASES.breaker(jobLib, BREAKER_STEPS.one, { setup: (w) => ledgerLib.setMeta(w.db, "held_loads", "not a list") })).stops, ["TOO_MANY_HELD"],
		"§26 FAILS ON THE OLD CODE: a count that can't be read stops sending, by TOO_MANY_HELD");
	const unwritable = await withPatched([[ledgerLib, "noteHold", () => { throw Object.assign(new Error("made-up: the disk is full"), { code: "SQLITE_FULL" }); }]],
		() => HOLD_CASES.breaker(jobLib, BREAKER_STEPS.one));
	eq(unwritable.stops, ["TOO_MANY_HELD"], "§26 FAILS ON THE OLD CODE: a count that can't be written stops sending, by TOO_MANY_HELD");
	ok(sendLib && sendLib.STOP_REASONS.includes("LOAD_CHANGED_AFTER_SEND") && sendLib.STOP_REASONS.includes("TOO_MANY_HELD"), "§26 FAILS ON THE OLD CODE: TOO_MANY_HELD is a stop reason; LOAD_CHANGED_AFTER_SEND stays one (old rows, the switch off)");

	// A row gone from the sheet: an audit row only. A cancelled row and an app delete still hold (above).
	const gone = await HOLD_CASES.archived(jobLib);
	eq(gone.logged, [["LD-TEST-0860", "10202026-1: row gone from the sheet"], ["LD-TEST-0861", "10202026-2: row gone from the sheet"], ["LD-TEST-0862", "10202026-3: row gone from the sheet"]],
		"§26 FAILS ON THE OLD CODE: a month moved to the archive: one audit row a load, once");
	eq([gone.chips, gone.held, gone.alerts, gone.stop, gone.notices], [["", "", ""], "", 0, null, []], "§26 FAILS ON THE OLD CODE: ...no chip, no count, no email, no stop, no notice");
	eq(gone.archiveReads, 0, "§26 ...and nothing asks the archive");
	for (const how of ["no rows", "no Load ID column"]) {
		const r = await HOLD_CASES.unreadable(jobLib, how);
		eq([r.chip, r.logged, r.stop, r.alerts, r.said], ["", 0, null, 0, 1], `§26 FAILS ON THE OLD CODE: a read with ${how}: the check is skipped, logged once`);
	}

	// Chips main left: an old "pods" stays until Mark checked; an old "payment,pods" doesn't re-fire.
	const old = await HOLD_CASES.oldChips(jobLib);
	eq([old.before.a, old.before.b, old.before.held, old.before.alerts, old.before.stop], [["pods", true], ["payment,pods", true], 0, 0, null],
		"§26 the chips main left stay as they were: no hold again, no email, no stop");
	eq(old.before.logged, [["LD-TEST-0870", "10202026-1: pods: +1 -0"], ["LD-TEST-0871", "10202026-2: pods: +1 -0"]], "§26 FAILS ON THE OLD CODE: ...their POD changes are logged, once");
	eq(old.checked, [200, "", "", "", 1], "§26 FAILS ON THE OLD CODE: Mark checked clears the chip and what was logged, from a fresh read of the sheet (the cache dropped first)");
	eq(old.afterTick, ["", 2], "§26 FAILS ON THE OLD CODE: ...and that point is the new reference: nothing more is logged");

	// The driver's trigger off: a sweep whose read began before a Mark checked leaves that load alone.
	const during = await HOLD_CASES.checkedDuringRead(jobLib);
	eq(during.atPress, [200, "", true], "§26 Mark checked pressed while the sweep's own read is out");
	eq([during.chip, during.stop, during.alerts, during.held, during.changedRows], ["", null, 0, "", 0],
		"§26 FAILS ON THE OLD CODE: the driver's trigger off: a sweep whose read began before a Mark checked leaves that load alone: no false flag, email or count");
	// Mark checked while the sheet reads back no load rows: refused, the reference kept.
	const emptyPress = await HOLD_CASES.checkedOnEmptyRead(jobLib);
	eq([emptyPress.press, emptyPress.chip, emptyPress.alerts, emptyPress.held], [[503, "SHEET_UNAVAILABLE", true, ""], "", 0, ""],
		"§26 FAILS ON THE OLD CODE: Mark checked on a read with no load rows: 503, nothing kept, and no false flag, email or count at the next sweep");

	// A sent load's row removed in the app (the Data Manager, the duplicate scanner) holds as removed; a
	// row gone otherwise (a month moved to the archive) still only logs.
	const only = await HOLD_CASES.removedInApp(jobLib, "only row");
	eq([only.noted, only.chip, only.stop, only.alerts, only.held, only.next], [true, "removed", null, [HELD_SUBJECT("LD-TEST-0910")], 1, [["drafted", ""], "send"]],
		"§26 FAILS ON THE OLD CODE: a sent load's only row removed in the app: flagged as removed and emailed, counted toward the breaker, no stop, the next load sent");
	eq([only.changed, only.notices.includes("Sent invoice: load changed"), only.logged], [["10202026-1: removed (sent)"], true, []],
		"§26 FAILS ON THE OLD CODE: ...today's audit row and notice, and no \"row gone\" row");
	ok(only.texts.length === 1 && /the load was cancelled or removed\.<\/p>\s*<p>Other loads keep sending\.<\/p>$/.test(only.texts[0]) && !/Mark checked/.test(only.texts[0]),
		"§26 FAILS ON THE OLD CODE: ...its email: cancelled or removed, other loads keep sending, no Mark checked line");
	const dup = await HOLD_CASES.removedInApp(jobLib, "duplicate");
	eq([dup.noted, dup.chip, dup.note, dup.alerts, dup.logged], [true, "", "", [], []],
		"§26 FAILS ON THE OLD CODE: a row removed while the load keeps another row: nothing held, and the note goes at the next check");
	eq(dup.archived, { chip: "", alerts: 0, logged: ["10202026-1: row gone from the sheet"] }, "§26 FAILS ON THE OLD CODE: ...its month moved to the archive later: logged only, as any row gone");
	const staleRead = await HOLD_CASES.removedInApp(jobLib, "during a read");
	eq(staleRead.afterStaleRead, ["", true], "§26 FAILS ON THE OLD CODE: a sweep whose read began before the removal still sees the row: nothing held, the note kept");
	eq([staleRead.chip, staleRead.alerts], ["removed", [HELD_SUBJECT("LD-TEST-0910")]], "§26 FAILS ON THE OLD CODE: ...and the next sweep holds it as removed");
	const removedChecked = await HOLD_CASES.removedInApp(jobLib, "checked");
	eq(removedChecked.checked, { status: 200, cleared: ["", ""], chip: "", alerts: 1, logged: ["10202026-1: row gone from the sheet"] },
		"§26 FAILS ON THE OLD CODE: Mark checked on it clears the flag and the note: the next sweep logs the row gone once, with no new flag or email");
	const cancelledFirst = await HOLD_CASES.removedInApp(jobLib, "cancelled first");
	eq([cancelledFirst.cancelled, cancelledFirst.noted, cancelledFirst.chip, cancelledFirst.alerts.length, cancelledFirst.changed.length], [["status,removed", 1], true, "status,removed", 1, 1],
		"§26 FAILS ON THE OLD CODE: a load flagged as cancelled, then its row removed in the app: already flagged as removed, so no second flag or email");
	const removedOff = await HOLD_CASES.removedInApp(jobLib, "off");
	eq([removedOff.noted, removedOff.stop], [false, "LOAD_CHANGED_AFTER_SEND"], "§26 AUTO_INVOICE_HOLD_ONE_LOAD=false: nothing noted, and the row gone stops all sending, as before");
	// The switch off, a read with no load rows: the stop, as before (the skip is the switch's).
	eq(await HOLD_CASES.offEmptyRead(jobLib), [true, "LOAD_CHANGED_AFTER_SEND"], "§26 AUTO_INVOICE_HOLD_ONE_LOAD=false: a read with no load rows stops all sending, as before");

	// The rules' own decisions, removed in turn: the case that pins each must change.
	const RULES_FILE = path.join(ROOT, "lib", "auto-invoice-rules.js");
	for (const [label, from, to, run, pinned] of [
		["a logged field holds", "\t\tdefault: return false;\n\t}\n}", "\t\tdefault: return true;\n\t}\n}", () => HOLD_CASES.podAfterSend(jobLib), (x) => x.chip === "" && x.stop === null],
		["any broker email change holds", "return Boolean(domain) && domain !== emailDomain(saved.brokerEmail);", "return true;",
			() => HOLD_CASES.field(jobLib, FIELD_CHANGES.brokerSameDomain), (x) => x.chip === ""],
		["a first rate-con row holds", "case \"rateCons\": return (saved.rateConIds || []).length > 0;", "case \"rateCons\": return true;",
			() => HOLD_CASES.field(jobLib, FIELD_CHANGES.rateCons), (x) => x.chip === ""],
		["a row gone compared field by field", "\tif (!facts.onSheet) return removedInApp ? { ...out, hold: [\"removed\"] } : { ...out, gone: true };\n", "",
			() => HOLD_CASES.archived(jobLib), (x) => x.stop === null && x.chips.every((c) => c === "")],
		["a row the app removed reads as gone", "return removedInApp ? { ...out, hold: [\"removed\"] } : { ...out, gone: true };", "return { ...out, gone: true };",
			() => HOLD_CASES.removedInApp(jobLib, "only row"), (x) => x.chip === "removed"],
		["a removal in the app replaces the flag", "if (facts && !facts.onSheet && split.hold.length) split.hold =", "if (false) split.hold =",
			() => HOLD_CASES.removedInApp(jobLib, "cancelled first"), (x) => x.alerts.length === 1 && x.chip === "status,removed"],
		["a logged value logged again at each check", "const logged = split.logged.filter((name) => memory[name] !== fieldValue(name, now));", "const logged = split.logged;",
			() => HOLD_CASES.podAfterSend(jobLib), (x) => x.logged.length === 1],
		["an older chip's hold part ignored", "split.hold.join(\",\") !== heldPart(changedFields)", "true",
			() => HOLD_CASES.oldChips(jobLib), (x) => x.before.held === 0],
	]) {
		const lib = mutantModule(RULES_FILE, from, to);
		ok(lib, `§26 MUTANT ${label}: applied to lib/auto-invoice-rules.js once`);
		if (!lib) continue;
		const real = pinned(await run());
		const mutated = pinned(await withPatched([[rules, "sentChange", lib.sentChange]], run));
		ok(real && !mutated, `§26 MUTANT ${label}: caught`);
	}
	const LEDGER_FILE = path.join(ROOT, "lib", "auto-invoice-ledger.js");
	for (const [label, from, to, steps, want] of [
		["one load counted twice", "e && e.load !== key && nowMs", "e && nowMs", BREAKER_STEPS.sameLoadTwice, [null, null, null, "TOO_MANY_HELD"]],
		["old holds never dropped", " && nowMs - Date.parse(e.at) <= windowMs);", ");", BREAKER_STEPS.over25Hours, [null, null, null]],
	]) {
		const lib = mutantModule(LEDGER_FILE, from, to);
		ok(lib, `§26 MUTANT ${label}: applied to lib/auto-invoice-ledger.js once`);
		if (!lib) continue;
		const real = (await HOLD_CASES.breaker(jobLib, steps)).stops;
		const mutated = (await withPatched([[ledgerLib, "noteHold", lib.noteHold]], () => HOLD_CASES.breaker(jobLib, steps))).stops;
		ok(JSON.stringify(real) === JSON.stringify(want) && JSON.stringify(mutated) !== JSON.stringify(want), `§26 MUTANT ${label}: caught`);
	}

	// The resume script: the breaker's list goes with the stop, in the same transaction, only on --apply.
	ok(resumeScript, "§26 scripts/auto-invoice-send-resume.js exists");
	if (resumeScript) {
		const resumeRun = async (script) => {
			const w = alertWorld();
			await holdStarted(jobLib, w);
			w.db.exec(AUDIT_TRAIL_SQL);
			const list = JSON.stringify([{ load: "ld-test-0980", at: isoOf(w.now) }, { load: "ld-test-0981", at: isoOf(w.now) }]);
			ledgerLib.setMeta(w.db, "held_loads", list);
			const out = {};
			out.nothingStopped = [script.run({ db: w.db, dryRun: false }).changed, w.meta().held_loads === list];
			ledgerLib.setSendStop(w.db, { reason: "TOO_MANY_HELD", nowIso: "2026-10-20T14:05:00.000Z" });
			script.run({ db: w.db, dryRun: true });
			out.dry = w.meta().held_loads === list;
			const applied = script.run({ db: w.db, dryRun: false, nowIso: "2026-10-20T15:00:00.000Z" });
			out.applied = [applied.changed, w.stop(), w.meta().held_loads || "",
				w.db.prepare("SELECT username, role, action, details FROM audit_trail").all()];
			// A resume whose audit row can't be written clears neither.
			ledgerLib.setMeta(w.db, "held_loads", list);
			ledgerLib.setSendStop(w.db, { reason: "TOO_MANY_HELD", nowIso: "2026-10-20T16:00:00.000Z" });
			w.db.exec("CREATE TRIGGER made_up_no_audit BEFORE INSERT ON audit_trail BEGIN SELECT RAISE(ABORT, 'made-up: no audit row'); END");
			let threw = false;
			try {
				script.run({ db: w.db, dryRun: false });
			} catch {
				threw = true;
			}
			out.rolledBack = [threw, Boolean(w.stop()), w.meta().held_loads === list];
			return out;
		};
		const r = await resumeRun(resumeScript);
		eq(r.nothingStopped, [false, true], "§26 resume --apply with nothing stopped: nothing written, the list kept");
		eq(r.dry, true, "§26 resume --dry-run: the list kept");
		eq(r.applied, [true, null, "", [{ username: "auto-invoice-send-resume", role: "system", action: "auto_invoice_send_resumed", details: "cleared the stop of 2026-10-20T14:05:00.000Z (TOO_MANY_HELD)" }]],
			"§26 FAILS ON THE OLD CODE: resume --apply: the stop and the breaker's list cleared together, one audit row as today");
		eq(r.rolledBack, [true, true, true], "§26 ...in one transaction: an audit row that can't be written clears neither");
		const RESUME_FILE = path.join(ROOT, "scripts", "auto-invoice-send-resume.js");
		const keptList = mutantModule(RESUME_FILE, "\t\t\tledger.clearHeldLoads(db);\n", "");
		ok(keptList, "§26 MUTANT the list kept on a resume: applied to the resume script once");
		if (keptList) ok((await resumeRun(keptList)).applied[2] !== "", "§26 MUTANT the list kept on a resume: caught");
	}

	// ---------------------------------------------------------------- §27
	section("§27 the alert emails (AUTO_INVOICE_ALERT_TO): which load, what changed, and a stop");
	ok(sendLib && typeof sendLib.heldAlert === "function" && typeof sendLib.stopAlert === "function", "§27 FAILS ON THE OLD CODE: lib/auto-invoice-send.js words both emails");
	if (sendLib && typeof sendLib.heldAlert === "function" && typeof sendLib.stopAlert === "function") {
		const held = (over) => sendLib.heldAlert({ loadId: "LD-TEST-0550", invoiceId: "11062026-1", fields: ["payment"], continues: true, ...over });
		const p = held({});
		eq([p.subject, p.text], ["Load LD-TEST-0550: changed after sending, needs a check",
			"Invoice 11062026-1 already went to the broker. After that, its payment changed. Other loads keep sending. Check whether the broker needs a corrected invoice, then press Mark checked on the load."],
		"§27 a load held: plan §2.4's subject and words");
		eq(held({ continues: false }).text, "Invoice 11062026-1 already went to the broker. After that, its payment changed. Check whether the broker needs a corrected invoice, then press Mark checked on the load.",
			"§27 ...with sending stopped, no word that other loads keep sending");
		eq(held({ fields: ["status"] }).text, "Invoice 11062026-1 already went to the broker. After that, the load was set back from Delivered. Other loads keep sending.",
			"§27 Delivered undone: the load's own words, and no Mark checked sentence");
		eq(held({ fields: ["status", "removed"] }).text, "Invoice 11062026-1 already went to the broker. After that, the load was cancelled or removed. Other loads keep sending.",
			"§27 cancelled or deleted: the same");
		eq(held({ fields: ["status", "payment"], continues: false }).text, "Invoice 11062026-1 already went to the broker. After that, the load was set back from Delivered and its payment changed.",
			"§27 Delivered undone with a payment change: both, no Mark checked sentence");
		eq(held({ fields: ["payment", "brokerEmail", "rateCons"] }).text.split(". ")[1], "After that, its payment, broker email and rate con changed",
			"§27 several fields: named in a list");
		eq(held({ fields: ["trailer", "pods"], continues: false }).text.split(". ")[1], "After that, its trailer and PODs changed", "§27 the switch off can name a trailer or PODs");
		const odd = held({ loadId: "LD-<b>&\"0551", invoiceId: "1102<i>2026-1" });
		ok(odd.html.includes("1102&lt;i&gt;2026-1") && !/<i>|<b>/.test(odd.html), "§27 the HTML escapes what it prints");
		eq(odd.subject, "Load LD-<b>&\"0551: changed after sending, needs a check", "§27 ...the subject is plain text");
		ok(!/<p>|&lt;/.test(odd.text), "§27 ...and the text form carries no markup");
		const s = sendLib.stopAlert("TOO_MANY_HELD");
		eq([s.subject, s.text], [STOP_SUBJECT,
			"3 loads changed after their invoices were sent within a day, or that count couldn't be read, so sending stopped in case something bigger is wrong. New invoices become Gmail drafts for a person to send until sending is resumed on the server. Drafts made during the stop stay drafts afterwards."],
		"§27 the stop: plan §2.4's subject and words, the breaker's own reason first");
		for (const reason of sendLib.STOP_REASONS) ok(sendLib.stopAlert(reason).text.startsWith(`${sendLib.STOP_WORDS[reason]} New invoices become Gmail drafts`), `§27 the stop's email for ${reason} starts with its reason's words`);
	}

	// Each hold's email once, however many: six loads in one sweep, the breaker's stop among them.
	const six = await HOLD_CASES.sixHeld(jobLib);
	eq(six.first, [HELD_SUBJECT("LD-TEST-0840"), HELD_SUBJECT("LD-TEST-0841"), HELD_SUBJECT("LD-TEST-0842"), STOP_SUBJECT, HELD_SUBJECT("LD-TEST-0843"), HELD_SUBJECT("LD-TEST-0844"), HELD_SUBJECT("LD-TEST-0845")],
		"§27 FAILS ON THE OLD CODE: six loads held in one sweep: six held-load emails and the breaker's stop email once, in the order they happened");
	eq(six.firstTexts.map((t) => /Other loads keep sending/.test(t)), [true, true, false, false, false, false, false], "§27 FAILS ON THE OLD CODE: ...each says other loads keep sending only while they do");
	eq(six.sixthTold, ["payment", 1, 1], "§27 ...the sixth load has its chip, its audit row and its notice too");
	eq(six.later, [HELD_SUBJECT("LD-TEST-0846")], "§27 FAILS ON THE OLD CODE: ten minutes later, the next held load is mailed");
	ok(six.every.length && six.every.every((m) => m.to === ALERT_TO), "§27 FAILS ON THE OLD CODE: every one to AUTO_INVOICE_ALERT_TO, from the mailbox (the job's own send function)");
	ok(six.every.every((m) => !/\$|1,10|@|example-broker|Made-up Driver/.test(m.subject + m.html)), "§27 ...no amount, address or name in any of them");
	ok(!six.logs.some((l) => /not mailed/.test(l)), "§27 FAILS ON THE OLD CODE: no hold goes unmailed, so nothing is logged as not mailed");
	// A resume within the hour, then two more loads held while sending is on: each emailed.
	const soon = await HOLD_CASES.resumedSoon(jobLib);
	eq([soon.before.length, soon.stoppedBy, soon.resumed], [6, "TOO_MANY_HELD", null], "§27 five loads held: five emails and the breaker's stop email; then the resume script clears the stop");
	eq([soon.after, soon.chips, soon.stop, soon.texts], [[HELD_SUBJECT("LD-TEST-0885"), HELD_SUBJECT("LD-TEST-0886")], ["payment", "payment"], null, [true, true]],
		"§27 FAILS ON THE OLD CODE: two loads held 25 minutes after the first five, sending on again: each emailed, saying other loads keep sending");
	// Two loads corrected step by step within the hour: six holds, each emailed, the last a cancellation.
	const steps = await HOLD_CASES.stepByStep(jobLib);
	eq([steps.chip, steps.stop, steps.alerts.length, steps.held, steps.alerts.every((s) => /^Load LD-TEST-089[01]: changed after sending/.test(s))],
		["status,removed,payment,brokerEmail", null, 6, 6, true], "§27 FAILS ON THE OLD CODE: two loads corrected in six steps within the hour: six holds, six emails, no stop (two loads)");
	ok(/the load was cancelled or removed/.test(steps.last) && /Other loads keep sending/.test(steps.last), "§27 FAILS ON THE OLD CODE: ...the last, load A cancelled after its invoice went, says so");
	// The driver's trigger off: the tick's own try sends an email that waited.
	eq(await HOLD_CASES.tickDrains(jobLib), [1, 2, 0], "§27 the driver's trigger off: an email that answered false goes out at the next tick past its wait, with no other call");
	// A hold while sending is stopped: its email never says other loads keep sending.
	eq(await HOLD_CASES.heldWhileStopped(jobLib), ["payment", [HELD_SUBJECT("LD-TEST-0876")], false], "§27 a load held while a Super Admin's Stop is set: emailed, never saying other loads keep sending");

	// A send that answers false: it waits, doubling from 5 minutes to 6 hours, kept across a restart.
	const backoff = await HOLD_CASES.backoff(jobLib);
	eq(backoff.waits, [5, 10, 20, 40, 80, 160, 320, 360, 360], "§27 FAILS ON THE OLD CODE: a send that answers false waits 5 minutes, doubling to 6 hours");
	eq(backoff.early, 0, "§27 ...nothing is tried before the wait is over, across a restart too");
	eq(backoff.final, [1, 0, "", 11], "§27 FAILS ON THE OLD CODE: ...then sent once it goes, and the wait starts over");
	{
		const w = alertWorld();
		const job = await holdStarted(jobLib, w);
		await sendAll(w, job, ["LD-TEST-0855", "LD-TEST-0856"]);
		w.alertAnswers = [false];
		FIELD_CHANGES.payment(w, "LD-TEST-0855");
		FIELD_CHANGES.payment(w, "LD-TEST-0856");
		await job.tick();
		await alertsSent(job);
		eq([w.alerts.map((a) => a.subject), outbox(w).map((a) => a.subject)], [[HELD_SUBJECT("LD-TEST-0855")], [HELD_SUBJECT("LD-TEST-0855"), HELD_SUBJECT("LD-TEST-0856")]],
			"§27 FAILS ON THE OLD CODE: the oldest is tried first, and nothing after it once it answers false");
	}
	// A full outbox: its oldest held-load email goes, never a stop.
	const full = await HOLD_CASES.fullOutbox(jobLib);
	eq(full.afterStop, [OUTBOX_MAX, 1, "made-up-1"], "§27 FAILS ON THE OLD CODE: a full outbox (500 waiting) makes room for a stop by its oldest held-load email");
	eq(full.afterHold, [OUTBOX_MAX, 1, HELD_SUBJECT("LD-TEST-0857")], "§27 FAILS ON THE OLD CODE: ...and a held load after it never pushes the stop out");
	eq(full.oldestStop, [OUTBOX_MAX, 1, "made-up-stop", HELD_SUBJECT("LD-TEST-0858")], "§27 FAILS ON THE OLD CODE: ...even when the stop is the oldest email waiting");
	// Emails waiting, then a sweep that holds three loads and stops sending: nothing waiting is dropped.
	const crowded = await HOLD_CASES.crowded(jobLib);
	eq([crowded.length, crowded.first, crowded.last, crowded.stop], [53, "made-up-0", [HELD_SUBJECT("LD-TEST-0895"), HELD_SUBJECT("LD-TEST-0896"), HELD_SUBJECT("LD-TEST-0897"), STOP_SUBJECT], "TOO_MANY_HELD"],
		"§27 FAILS ON THE OLD CODE: 49 emails waiting, then three loads held and the stop: all 53 wait, none dropped");
	// No address set: nothing queued or sent, one log line, and the reads say alerts are off.
	{
		const w = alertWorld({ alertTo: "" });
		const job = await holdStarted(jobLib, w);
		await sendAll(w, job, ["LD-TEST-0858"]);
		FIELD_CHANGES.payment(w, "LD-TEST-0858");
		await job.tick();
		await alertsSent(job);
		eq([claimOf(w, "LD-TEST-0858").changed_fields, w.alerts.length, "alert_outbox" in w.meta(), w.logs.filter((l) => /alert emails off/.test(l)).length], ["payment", 0, false, 1],
			"§27 FAILS ON THE OLD CODE: AUTO_INVOICE_ALERT_TO unset: the load is flagged, nothing is queued or sent, and one log line says so");
		const f = fakeApp();
		job.mount(f.app, { requireRole: f.requireRole, refuseCrossSite: (req, res, next) => next() });
		const st = (await f.call("GET", "/api/auto-invoice/status")).body;
		const se = (await f.call("GET", "/api/auto-invoice/settings")).body;
		eq([st.alerts, se.alerts, Boolean(se.send) && "alerts" in se.send], [{ on: false }, { on: false }, false],
			"§27 FAILS ON THE OLD CODE (item 118): the status and the settings read say alerts are off, outside `send`");
		const on = alertWorld();
		const onJob = await holdStarted(jobLib, on);
		const g = fakeApp();
		onJob.mount(g.app, { requireRole: g.requireRole, refuseCrossSite: (req, res, next) => next() });
		const reads = [(await g.call("GET", "/api/auto-invoice/status")).body, (await g.call("GET", "/api/auto-invoice/settings")).body];
		eq(reads.map((b) => "alerts" in b), [false, false], "§27 an address set: neither read carries the line");
		ok(reads.every((b) => !JSON.stringify(b).includes("@")), "§27 ...and neither ever carries the address");
		ok(on.logs.every((l) => !/alert emails off/.test(l)), "§27 ...and nothing is logged about it");
		const replicaRules = require(path.join(ROOT, "lib", "replica-rules.js"));
		eq(replicaRules.classifySetting("AUTO_INVOICE_ALERT_TO", ALERT_TO, { readByApp: new Set(["AUTO_INVOICE_ALERT_TO"]) }).rule, "production only: names a production target",
			"§27 FAILS ON THE OLD CODE: AUTO_INVOICE_ALERT_TO is never copied to a replica");
	}
	// The emails' own decisions, removed in turn: the case that pins each must change.
	const JOB_SRC_FILE = path.join(ROOT, "lib", "auto-invoice-job.js");
	for (const [label, from, to, run, pinned] of [
		["a smaller outbox", "const ALERT_OUTBOX_MAX = 500;", "const ALERT_OUTBOX_MAX = 50;", (lib) => HOLD_CASES.crowded(lib), (x) => x.length === 53],
		["a full outbox drops a stop", "while (box.length >= ALERT_OUTBOX_MAX && box.some(isHeldAlert)) box.splice(box.findIndex(isHeldAlert), 1);", "while (box.length >= ALERT_OUTBOX_MAX) box.shift();",
			(lib) => HOLD_CASES.fullOutbox(lib), (x) => x.oldestStop[1] === 1],
		["the wait never grows", "rules.alertWaitMs(Number(meta.alert_wait_ms) || 0)", "rules.alertWaitMs(0)", (lib) => HOLD_CASES.backoff(lib), (x) => x.waits[1] === 10],
		["a try before the wait is over", "\t\t\t\t\tif (meta.alert_retry_at && meta.alert_retry_at > iso(nowDate().getTime())) return sent;\n", "",
			(lib) => HOLD_CASES.backoff(lib), (x) => x.early === 0],
		["no email when sending stops", "\t\tqueueAlert(\"stop\", sendRules.stopAlert(reason));\n", "", (lib) => HOLD_CASES.sixHeld(lib), (x) => x.first.includes(STOP_SUBJECT)],
		["no email for a Super Admin's Stop", "\t\t\t\t\tqueueAlert(\"stop\", sendRules.stopAlert(\"STOPPED_BY_ADMIN\"));\n", "", (lib) => HOLD_CASES.fullOutbox(lib), (x) => x.afterStop[1] === 1],
		["the settings read never says alerts are off", ", ...(alertsOff() ? { alerts: { on: false } } : {}) });", " });",
			(lib) => HOLD_CASES.reads(lib, ""), (x) => Boolean(x.settings.alerts) && x.settings.alerts.on === false],
		["the status never says alerts are off", "\t\t\t...(alertsOff() ? { alerts: { on: false } } : {}),\n", "",
			(lib) => HOLD_CASES.reads(lib, ""), (x) => Boolean(x.status.alerts) && x.status.alerts.on === false],
		// An empty read checked would log every sent load as gone (and mark it so): no stop, but false rows.
		["an empty read checked anyway", "const empty = snap.byKey.size === 0;", "const empty = false;", (lib) => HOLD_CASES.unreadable(lib, "no rows"), (x) => x.logged === 0 && x.said === 1],
		["Mark checked keeps the cached sheet", "\t\t\td.invalidateJobTracking();\n\t\t\tlet snap;", "\t\t\tlet snap;", (lib) => HOLD_CASES.oldChips(lib), (x) => x.checked[4] === 1],
		["Mark checked keeps what was logged", ", change_logged_json: \"\", change_logged_at: \"\",", ",", (lib) => HOLD_CASES.oldChips(lib), (x) => x.checked[2] === ""],
		["the tick never tries the emails waiting", "\t\tif (mode === \"on\") drainAlerts();\n", "", (lib) => HOLD_CASES.tickDrains(lib), (x) => x[1] === 2],
		["the empty-read skip with the switch off", "\t\tif (!holdOneLoad) return false;\n", "", (lib) => HOLD_CASES.offEmptyRead(lib), (x) => x[1] === "LOAD_CHANGED_AFTER_SEND"],
		["a hold while stopped says other loads keep sending", "alertHeld(c, s.hold, !trips && sending && !sendStopped());", "alertHeld(c, s.hold, !trips && sending);",
			(lib) => HOLD_CASES.heldWhileStopped(lib), (x) => x[2] === false],
		["the sweep checks a load marked checked during its read", " && !(c.checked_at >= beganAt)) out.changed +=", ") out.changed +=",
			(lib) => HOLD_CASES.checkedDuringRead(lib), (x) => x.chip === "" && x.alerts === 0],
		["Mark checked on an empty read", "\t\t\tif (!snap.byKey.size) return res.status(503)", "\t\t\tif (false) return res.status(503)",
			(lib) => HOLD_CASES.checkedOnEmptyRead(lib), (x) => x.press[0] === 503 && x.chip === ""],
		["a removal in the app never noted", "if (c && c.state === \"drafted\" && sendRules.claimSent(c)) noted.push", "if (false) noted.push",
			(lib) => HOLD_CASES.removedInApp(lib, "only row"), (x) => x.chip === "removed"],
		["the note cleared by a read from before the removal", "if (removedAt && facts.onSheet && removedAt < beganAt)", "if (removedAt && facts.onSheet)",
			(lib) => HOLD_CASES.removedInApp(lib, "during a read"), (x) => x.chip === "removed"],
		["the note kept when the load's row stays", "if (removedAt && facts.onSheet && removedAt < beganAt)", "if (false)",
			(lib) => HOLD_CASES.removedInApp(lib, "duplicate"), (x) => x.archived.chip === ""],
		["Mark checked keeps the note", ", removed_in_app_at: \"\",", ",", (lib) => HOLD_CASES.removedInApp(lib, "checked"), (x) => x.checked.chip === "" && x.checked.alerts === 1],
		["the switch off notes a removal", "\t\tif (mode !== \"on\" || !holdOneLoad) return;\n", "\t\tif (mode !== \"on\") return;\n",
			(lib) => HOLD_CASES.removedInApp(lib, "off"), (x) => x.noted === false],
	]) {
		const lib = mutantModule(JOB_SRC_FILE, from, to);
		ok(lib, `§27 MUTANT ${label}: applied to lib/auto-invoice-job.js once`);
		if (!lib) continue;
		ok(pinned(await run(jobLib)) && !pinned(await run(lib)), `§27 MUTANT ${label}: caught`);
	}
	const SEND_SRC_FILE = path.join(ROOT, "lib", "auto-invoice-send.js");
	for (const [label, from, to, run, pinned] of [
		["other loads always keep sending", "\tif (continues) sentences.push(\"Other loads keep sending.\");\n", "\tsentences.push(\"Other loads keep sending.\");\n",
			() => HOLD_CASES.sixHeld(jobLib), (x) => JSON.stringify(x.firstTexts.map((t) => /Other loads keep sending/.test(t))) === JSON.stringify([true, true, false, false, false, false, false])],
		["a load set back from Delivered told to press Mark checked", "\tif (!undone) sentences.push(", "\tsentences.push(",
			() => HOLD_CASES.field(jobLib, FIELD_CHANGES.status), (x) => x.texts.length === 1 && !/Mark checked/.test(x.texts[0])],
	]) {
		const lib = mutantModule(SEND_SRC_FILE, from, to);
		ok(lib, `§27 MUTANT ${label}: applied to lib/auto-invoice-send.js once`);
		if (!lib) continue;
		const real = pinned(await run());
		const mutated = pinned(await withPatched([[sendLib, "heldAlert", lib.heldAlert]], run));
		ok(real && !mutated, `§27 MUTANT ${label}: caught`);
	}
	const replicaCopies = mutantModule(path.join(ROOT, "lib", "replica-rules.js"), "\t\"AUTO_INVOICE_ALERT_TO\",\n", "");
	ok(replicaCopies, "§27 MUTANT AUTO_INVOICE_ALERT_TO copied to a replica: applied to lib/replica-rules.js once");
	if (replicaCopies) {
		ok(replicaCopies.classifySetting("AUTO_INVOICE_ALERT_TO", ALERT_TO, { readByApp: new Set(["AUTO_INVOICE_ALERT_TO"]) }).copy === true,
			"§27 MUTANT AUTO_INVOICE_ALERT_TO copied to a replica: caught (the real rule refuses it, above)");
	}

	// Shadow mode sends none: nothing is held or stopped there.
	{
		const w = alertWorld();
		const job = jobLib.create(w.holdDeps({ env: { AUTO_INVOICE_DRAFTS_SHADOW: "" } }));
		await job.tick();
		w.now += 5 * MIN;
		w.ready("LD-TEST-0859");
		await job.tick();
		await alertsSent(job);
		eq([w.alerts.length, "alert_outbox" in w.meta()], [0, false], "§27 shadow mode: no email, nothing queued");
	}

	// ---------------------------------------------------------------- §28
	section("§28 the dry run before the deploy (scripts/auto-invoice-hold-dry-run.js): the first check's counts, nothing written");
	ok(dryRunScript && typeof dryRunScript.run === "function", "§28 FAILS ON THE OLD CODE: scripts/auto-invoice-hold-dry-run.js exists");
	if (dryRunScript && typeof dryRunScript.run === "function") {
		const helpers = liftSheetHelpers();
		for (const [trip, removed] of [[false, false], [true, false], [false, true]]) {
			const x = await dryRunWorld({ trip, removed });
			try {
				const metaBefore = JSON.stringify(x.w.meta());
				const shaBefore = sha256Of(fs.readFileSync(x.file));
				const ro = new Database(x.file, { readonly: true, fileMustExist: true });
				let dry = null;
				try {
					dry = dryRunScript.run({ db: ro, values: x.values(), nowIso: isoOf(x.w.now), helpers });
				} finally {
					ro.close();
				}
				const shaAfter = sha256Of(fs.readFileSync(x.file));
				const sends = [x.w.smtp.length, x.w.calls.append.length, x.w.alerts.length];
				const name = `trip=${trip}${removed ? ", a row removed in the app" : ""}`;
				eq([shaAfter === shaBefore, JSON.stringify(x.w.meta()) === metaBefore, fs.readdirSync(x.TMP).sort()], [true, true, ["app.db"]],
					`§28 ${name}: the dry run writes nothing: the database's sha256 and the job's meta as they were, no side file`);
				const before = x.w.db.prepare("SELECT * FROM auto_invoice_claims").all();
				await x.job.tick();
				await alertsSent(x.job);
				const after = x.w.db.prepare("SELECT * FROM auto_invoice_claims").all();
				const did = checkDid(before, after, x.w.stop());
				eq([dry.wouldHold.byField, dry.wouldHold.loads, dry.wouldLog.byField, dry.wouldLog.loads, dry.rowsGone, dry.breaker.wouldTrip],
					[did.hold, did.holdLoads, did.log, did.logLoads, did.gone, did.trips], `§28 ${name}: its counts equal what the first check did`);
				eq([dry.sentLoads, dry.heldAlready, dry.breaker.stopAt, dry.breaker.wouldTrip, dry.skipped], [8, 1, 3, trip || removed, false], `§28 ${name}: eight sent loads, one held already, the breaker at 3`);
				if (removed) eq([dry.wouldHold.byField.removed, dry.rowsGone], [1, 1], "§28 FAILS ON THE OLD CODE: a row removed in the app would hold as removed, and only the other row gone counts as gone");
				eq(sends, [8, 0, 0], `§28 ${name}: no message is sent by the dry run (only the eight invoices before it)`);
				const text = dryRunScript.textOf(dry);
				ok(/^DRY RUN/.test(text) && !/LD-TEST|ld-test|@|\$/.test(text + JSON.stringify(dry)), `§28 ${name}: counts only: no load, address or amount`);
			} finally {
				x.w.db.close();
				fs.rmSync(x.TMP, { recursive: true, force: true });
			}
		}
		// A read with no load rows: the dry run says the check would be skipped.
		const y = await dryRunWorld({ trip: true });
		try {
			const ro = new Database(y.file, { readonly: true, fileMustExist: true });
			const dry = dryRunScript.run({ db: ro, values: [HEADERS], nowIso: isoOf(y.w.now), helpers });
			ro.close();
			eq([dry.skipped, dry.wouldHold.loads, dry.wouldLog.loads, dry.rowsGone, dry.breaker.wouldTrip], [true, 0, 0, 0, false], "§28 a read with no load rows: skipped, as the check skips it");
		} finally {
			y.w.db.close();
			fs.rmSync(y.TMP, { recursive: true, force: true });
		}
		eq(["--db=x", "--db=x --dry-run --apply", "--dry-run", "--db=x --dry-run --force"].map((a) => {
			try {
				dryRunScript.parseArgs(a.split(" "));
				return "accepted";
			} catch (e) {
				return e instanceof dryRunScript.Refusal ? "refused" : "threw";
			}
		}), ["refused", "refused", "refused", "refused"], "§28 --db and --dry-run, both required, nothing else");
		const SCRIPT = path.join(ROOT, "scripts", "auto-invoice-hold-dry-run.js");
		const src = fs.readFileSync(SCRIPT, "utf8");
		ok(/readonly: true/.test(src) && /query_only = ON/.test(src) && /spreadsheets\.readonly/.test(src) && !/\.(?:run|exec)\(/.test(src.replace(/^\s*\/\/.*$/gm, "")),
			"§28 it opens the database read-only, query_only, and Sheets with the read-only scope; it runs no statement");
		const counted = mutantModule(SCRIPT, "if (s.newHold) {", "if (s.hold.length) {");
		ok(counted, "§28 MUTANT the dry run counts a load already flagged: applied once");
		if (counted) {
			const x = await dryRunWorld({ trip: false });
			try {
				const ro = new Database(x.file, { readonly: true, fileMustExist: true });
				const [real, mutated] = [dryRunScript, counted].map((lib) => lib.run({ db: ro, values: x.values(), nowIso: isoOf(x.w.now), helpers }).wouldHold.loads);
				ro.close();
				ok(real === 1 && mutated === 2, "§28 MUTANT the dry run counts a load already flagged: caught");
			} finally {
				x.w.db.close();
				fs.rmSync(x.TMP, { recursive: true, force: true });
			}
		}
		const unheld = mutantModule(SCRIPT, "\t\tfor (const e of ledger.readHeldLoads(db)) if (e && nowMs - Date.parse(e.at) <= rules.HELD_LOADS_WINDOW_MS) heldKeys.add(e.load);\n", "\t\tledger.readHeldLoads(db);\n");
		ok(unheld, "§28 MUTANT the dry run blind to the loads held already: applied once");
		if (unheld) {
			const x = await dryRunWorld({ trip: true });
			try {
				const ro = new Database(x.file, { readonly: true, fileMustExist: true });
				const [real, mutated] = [dryRunScript, unheld].map((lib) => lib.run({ db: ro, values: x.values(), nowIso: isoOf(x.w.now), helpers }).breaker.wouldTrip);
				ro.close();
				ok(real === true && mutated === false, "§28 MUTANT the dry run blind to the loads held already: caught");
			} finally {
				x.w.db.close();
				fs.rmSync(x.TMP, { recursive: true, force: true });
			}
		}
		const blind = mutantModule(SCRIPT, "removedInApp: Boolean(c.removed_in_app_at)", "removedInApp: false");
		ok(blind, "§28 MUTANT the dry run blind to rows removed in the app: applied once");
		if (blind) {
			const x = await dryRunWorld({ trip: false, removed: true });
			try {
				const ro = new Database(x.file, { readonly: true, fileMustExist: true });
				const [real, mutated] = [dryRunScript, blind].map((lib) => lib.run({ db: ro, values: x.values(), nowIso: isoOf(x.w.now), helpers }).wouldHold.byField.removed || 0);
				ro.close();
				ok(real === 1 && mutated === 0, "§28 MUTANT the dry run blind to rows removed in the app: caught");
			} finally {
				x.w.db.close();
				fs.rmSync(x.TMP, { recursive: true, force: true });
			}
		}
	}

	// ---------------------------------------------------------------- §29
	section("§29 what these rules don't touch behaves as on main (ea4497a6)");
	for (const [name, want] of Object.entries(MAIN_DIGESTS)) {
		eq(await MAIN_CASES[name](jobLib), want, `§29 ${name}: the claims, meta, audit rows, notices, messages and logs, as on main`);
	}
	const onCols = alertWorld();
	await holdStarted(jobLib, onCols);
	await sendAll(onCols, jobLib.create(onCols.holdDeps()), ["LD-TEST-0906"]);
	const cols = onCols.db.prepare("PRAGMA table_info(auto_invoice_claims)").all().map((c) => c.name);
	eq(cols.filter((c) => !MAIN_CLAIM_COLUMNS.includes(c)), ["change_logged_json", "change_logged_at", "removed_in_app_at"],
		"§29 FAILS ON THE OLD CODE: the claims table gains three columns, the logged memory and a row's removal in the app, and nothing else");
	eq(["change_logged_json", "change_logged_at", "removed_in_app_at"].every((c) => cols.includes(c))
		? onCols.db.prepare("SELECT change_logged_json, change_logged_at, removed_in_app_at FROM auto_invoice_claims").all() : "(no such columns)",
	[{ change_logged_json: "", change_logged_at: "", removed_in_app_at: "" }], "§29 FAILS ON THE OLD CODE: ...empty on a load nothing changed");
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
