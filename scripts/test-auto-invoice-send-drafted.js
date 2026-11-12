#!/usr/bin/env node
// scripts/auto-invoice-send-drafted.js: the one-time run that sends the invoices the
// automatic job drafted while sending was stopped for a load changed after its send.
// Made-up loads in a scratch database, drafted by the real job (lib/auto-invoice-job.js)
// and resumed by the real resume script, with a fake Gmail whose Drafts hold the very
// bytes lib/imap-draft.js would append, and a made-up SMTP sender. The cases:
//   §1  the stop's window, from the audit log only: none, a stop with no resume, two
//       stops (refused without --stop-at, picked exactly with it), other reasons; the
//       story's own window; a run refuses on an unreadable window and sends nothing
//   §2  the dry run: the mailbox account, the stop, every "Draft ready in Gmail" load
//       with its label, from the stop or why not, and its draft's visibility; nothing
//       written or sent
//   §3  --apply: each CLEAN load sent once through the sender, the draft's own To,
//       subject, body and attachments, From the mailbox, a fresh Message-ID; confirmed
//       in Sent Mail before it is recorded and before the next; recorded as the job
//       records a send with one audit row; the label reads "Sent to the broker" (the
//       server's answer and the client's chip); Draft Invoice refuses; the old drafts
//       untouched and listed; a second run sends nothing
//   §4  every check that holds a load: CHECK BY HAND with one word, nothing sent for it
//   §5  the gate and the mailbox: a closed month, the sheet unread, sending off or
//       stopped, the mailbox unread, no draft visible
//   §6  errors: a refused send (the claim back to its draft), a send with no answer, a
//       send Sent Mail doesn't show (left as the job leaves its own lost send: Try again
//       searches Sent Mail); the run stops there, never sends a load twice, and refuses
//       while a send is unconfirmed
//   §7  the cap (--max)
//   §8  through the job's real SMTP sender to a stand-in server: the wire message is
//       the draft's own
//   §9  the command line: arguments, exit codes, the dry run's read-only open, the
//       database it opened printed
//   §10 the source: the app's own mailbox code and sender only; nothing written to a
//       mailbox
//   §11 the mailbox again right before each send: a draft a person sent from Gmail
//       after the listing is CHECK BY HAND, never sent a second time
//   §12 a send under way holds the job's own send-start state on the claim: Draft
//       Invoice, a press, a factoring mark and the label see it; a run that dies mid-send
//       is taken over by the app's own recovery, which never sends it again
//   §13 mutants, each applied once and each caught
// Made-up data only. No network but an SMTP stand-in on 127.0.0.1 in this process;
// never reads app.db or a settings file.
//   node scripts/test-auto-invoice-send-drafted.js      # exits 1 on any failure
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const Module = require("module");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SCRIPT_FILE = path.join(ROOT, "scripts", "auto-invoice-send-drafted.js");
// Absent from a tree before the script: every section then fails by name.
const optional = (p) => {
	try {
		return require(p);
	} catch {
		return null;
	}
};
const sendDrafted = optional(SCRIPT_FILE);
const jobLib = require(path.join(ROOT, "lib", "auto-invoice-job.js"));
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const ledgerLib = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const sendLib = require(path.join(ROOT, "lib", "auto-invoice-send.js"));
const factoring = require(path.join(ROOT, "lib", "factoring-store.js"));
const imapDraft = require(path.join(ROOT, "lib", "imap-draft.js"));
const mimeRead = require(path.join(ROOT, "lib", "mime-read.js"));
const sheetIds = require(path.join(ROOT, "lib", "sheet-id.js"));
const resumeScript = require(path.join(ROOT, "scripts", "auto-invoice-send-resume.js"));
const { liftSheetHelpers } = require(path.join(ROOT, "scripts", "auto-invoice-shadow-report.js"));
const { textPdf } = require(path.join(ROOT, "scripts", "lib", "made-up-pdf.js"));
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const realMailer = require(path.join(ROOT, "node_modules", "nodemailer"));

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
const ET = "America/New_York";
const UPLOADS = path.join(path.sep, "made-up", "uploads");
const HEADERS = Object.freeze(["Load ID", "Trailer Number", "Driver", "Drop-off Appointment", "Job Status", "Broker Contact Name", "Email",
	"Status Update Date", "Completion Date", "  Payment  "]);
const SEND_DOMAIN = "example-broker.test";
const OTHER_DOMAIN = "example-other.test";
const BISON_AP = "ap@example-bison-ap.test";
const MAILBOX = Object.freeze({ user: "drafts@example.com", pass: "made-up" });
const DRAFTS_BOX = "[Gmail]/Drafts";
const SENT_BOX = "[Gmail]/Sent Mail";
const SCRIPT_ENV = Object.freeze({ AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_SEND_ENABLED: "true",
	AUTO_INVOICE_SEND_DOMAINS: SEND_DOMAIN, BISON_INVOICE_EMAIL: BISON_AP });
const AUDIT_SQL = "CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, user_id INTEGER, username TEXT, role TEXT, action TEXT, entity TEXT, entity_id TEXT, details TEXT)";
const { sheetDayKey } = liftSheetHelpers();
let client = null; // client/src/lib/autoInvoiceStatus.js, imported in main()

const iso = (ms) => new Date(ms).toISOString();
const sqliteStamp = (ms) => iso(ms).slice(0, 19).replace("T", " ");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const mimeOf = (o) => imapDraft.buildMime({ from: o.from, to: o.to, subject: o.subject, html: o.html, attachments: o.attachments, messageId: o.messageId });
const key = (id) => rules.loadKey(id);

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
		CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','reopened')), finalized_at TEXT NOT NULL,
			finalized_by TEXT NOT NULL DEFAULT 'system', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		${AUDIT_SQL};
	`);
	factoring.ensureSchema(db);
	// Both made-up broker domains confirmed by a person; only one is on the send list.
	db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?)")
		.run(JSON.stringify({ optOutDomains: [], confirmedBrokerDomains: [SEND_DOMAIN, OTHER_DOMAIN] }));
}

// Messages in a fake mailbox: Message-ID -> { raw, at }.
function findIn(w, messageId, boxes, { hide = false } = {}) {
	for (const box of boxes) {
		const held = box === DRAFTS_BOX ? w.drafts : box === SENT_BOX ? w.sentBox : null;
		if (held && held.has(messageId) && !(hide && box === DRAFTS_BOX && w.hidden.has(messageId))) return { found: true, count: 1, mailbox: box };
	}
	return { found: false, count: 0, mailbox: "" };
}

function world({ dbFile = null } = {}) {
	const w = {
		now: T0,
		rows: [],
		files: new Set(),
		rateCons: new Map(),
		drafts: new Map(), // Gmail Drafts
		sentBox: new Map(), // Gmail Sent Mail
		rendered: new Map(), // load key -> the message the engine built
		hidden: new Set(), // Message-IDs the header search misses in Drafts
		smtp: [],
		smtpBehaviors: [],
		events: [],
		sleeps: [],
		out: [],
		ids: 0,
		sendIds: 0,
		searchFails: false,
		sheetFails: false,
	};
	w.db = dbFile ? new Database(dbFile) : new Database(":memory:");
	serverTables(w.db);
	w.audit = (user, action, entity, id, details) => w.db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, ?, ?, ?, ?, ?)")
		.run(iso(w.now), user.username || "system", user.role || "system", action, entity, String(id || ""), details || "");
	w.setRow = (id, over = {}) => {
		const was = w.rows.find((r) => key(r["Load ID"]) === key(id));
		const row = Object.freeze({
			"Load ID": id, "Trailer Number": "TR-1", Driver: "Made-up Driver", "Drop-off Appointment": "10/20/2026 8:00", "Job Status": "Delivered",
			"Broker Contact Name": "Made-up Agent", Email: `ops@${SEND_DOMAIN}`, "Status Update Date": "10/20/2026 9:00:00", "Completion Date": "10/20/2026 9:00:00",
			"  Payment  ": "$1,000.00", ...(was || {}), ...over,
		});
		const i = w.rows.indexOf(was);
		if (i >= 0) w.rows[i] = row; else w.rows.push(row);
	};
	// A load ready to invoice: delivered, its POD on file, a rate con naming a billing
	// email on the broker's own domain.
	w.ready = (id, { domain = SEND_DOMAIN } = {}) => {
		w.setRow(id, { Email: `ops@${domain}` });
		const name = `pod-${key(id)}.pdf`;
		w.db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'POD', ?, ?, ?)").run(id, name, `/uploads/${name}`, "2026-10-20 13:00:00");
		w.files.add(name);
		w.rateCons.set(key(id), `billing@${domain}`);
	};
	w.handDraft = (id) => w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by, created_at) VALUES (?, '10202026-50', ?, 'ratecon', 'imap', 'made-up-admin', ?)")
		.run(id, `billing@${SEND_DOMAIN}`, iso(w.now).replace(/\.\d{3}Z$/, "Z"));
	w.mark = (id, factored) => w.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, reason, set_at, set_by, updated_at) VALUES (?, ?, ?, 'person', 'made-up', ?, 'made-up-admin', ?)")
		.run(key(id), id, factored, iso(w.now), iso(w.now));
	w.engine = {
		async prepare({ loadId }) {
			const row = w.rows.find((r) => key(r["Load ID"]) === key(loadId));
			if (!row) return { ok: false, http: 404, code: "LOAD_NOT_FOUND" };
			if (!w.rateCons.has(key(loadId))) return { ok: false, http: 422, code: "RATECON_MISSING" };
			const rule = rules.recipientRule({ brokerEmail: row.Email, bisonRecipient: BISON_AP, documentsEmail: w.rateCons.get(key(loadId)),
				confirmedDomains: ledgerLib.readSettings(w.db).confirmedBrokerDomains });
			if (!rule.ok) return { ok: false, http: 422, code: rule.code };
			return { ok: true, ctx: { loadId: row["Load ID"], to: rule.to } };
		},
		// The engine's shapes: the invoice PDF first (its number, date and total
		// printed), then the POD and the rate con.
		async render(ctx, opts) {
			const row = w.rows.find((r) => key(r["Load ID"]) === key(ctx.loadId)) || {};
			const ref = String(ctx.loadId).replace(/^#/, "");
			const total = row["  Payment  "] || "$1,000.00";
			const [y, m, d] = String(opts.invoiceDate).split("-");
			const printed = `INVOICE Invoice ID # : ${opts.invoiceId} Date: ${m}/${d}/${y} Made-up Co. Invoice To Example Broker ${ctx.to} Load ID# Delivery Date Total Example Broker Order: #${ref} 10/20/2026 ${total} SUB-TOTAL ${total} Total ${total}`;
			const out = {
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
			w.rendered.set(key(ctx.loadId), out);
			return out;
		},
		async record(ctx, rendered, opts) {
			const r = w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', ?, ?)")
				.run(ctx.loadId, opts.invoiceId, rendered.to, opts.via, opts.actor.username);
			return { recorded: true, draftRowId: Number(r.lastInsertRowid) };
		},
	};
	w.jobDeps = ({ sendOn = true, trigger = false } = {}) => ({
		db: w.db,
		env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: trigger ? "true" : "false",
			AUTO_INVOICE_MAX_PER_HOUR: "100", AUTO_INVOICE_MAX_PER_DAY: "1000" },
		now: () => new Date(w.now),
		readJobTracking: async () => ({ headers: HEADERS, data: [...w.rows] }),
		closedMonthsOf: () => [],
		dayKeyOf: sheetDayKey,
		uploadsRoot: UPLOADS,
		fileExists: (p) => w.files.has(path.basename(p)),
		engine: w.engine,
		nextInvoiceNumber: (date) => {
			const [y, m, d] = iso(date.getTime()).slice(0, 10).split("-");
			const day = `${m}${d}${y}`;
			return `${day}-${w.db.prepare("INSERT INTO bison_invoice_seq (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 RETURNING n").get(day).n}`;
		},
		appendGmailDraft: async (o) => {
			w.drafts.set(o.messageId, { raw: await mimeOf(o), at: w.now });
			return { ok: true };
		},
		findDraftByMessageId: async ({ messageId, mailboxes }) => findIn(w, messageId, mailboxes || imapDraft.SEARCH_MAILBOXES),
		newMessageId: () => `<made-up-${++w.ids}.auto-invoice@example.com>`,
		mailbox: () => MAILBOX,
		bisonRecipient: () => BISON_AP,
		logAudit: (req, action, entity, id, details) => w.audit(req.session.user, action, entity, id, details),
		notify: () => {},
		geminiUnavailableAt: () => null,
		log: { warn() {}, error() {} },
		timeZone: ET,
		workerId: "worker-1",
		send: { enabled: sendOn, domains: [SEND_DOMAIN] },
		// The job's own sends land in Sent Mail, as Gmail keeps an SMTP send's copy.
		sendMail: async (o) => {
			w.sentBox.set(o.messageId, { raw: await mimeOf(o), at: w.now });
			return { ok: true };
		},
	});
	w.claim = (id) => w.db.prepare("SELECT * FROM auto_invoice_claims WHERE load_key = ?").get(key(id)) || null;
	// The script's run options: the fake Gmail, the made-up sender and the sheet as the
	// world holds it. Sender behaviours, one per send: OK, NOT_FILED (taken, never in
	// Sent Mail), REFUSED (refused before the message), LOST (no answer), HANG (no answer
	// ever: the process dies inside the send).
	w.scriptOpts = (more = {}) => {
		const { env: envOver = {}, ...rest } = more;
		return {
			db: w.db,
			dryRun: true,
			env: { ...SCRIPT_ENV, ...envOver },
			mailbox: MAILBOX,
			now: () => w.now,
			readRange: async (range) => {
				if (w.sheetFails) throw new Error("made-up Sheets outage");
				return range === "Job Tracking" ? [[...HEADERS], ...w.rows.map((r) => HEADERS.map((h) => r[h]))] : [];
			},
			findDraftByMessageId: async ({ messageId, mailboxes }) => {
				w.events.push(`search ${mailboxes.join("+")} ${messageId}`);
				if (w.searchFails) throw Object.assign(new Error("IMAP SEARCH failed: made-up"), { stage: "search", answered: true });
				return findIn(w, messageId, mailboxes, { hide: true });
			},
			fetchMessages: async ({ mailbox, since, before, subject }) => {
				w.events.push(`fetch ${mailbox} ${subject || ""}`);
				const box = mailbox === DRAFTS_BOX ? w.drafts : mailbox === SENT_BOX ? w.sentBox : new Map();
				const messages = [];
				let seq = 0;
				for (const [, m] of box) {
					seq++;
					if (m.at < since.getTime() || m.at >= before.getTime()) continue;
					if (subject && !mimeRead.parseMessage(m.raw).subject.includes(subject)) continue;
					messages.push({ seq, internalDate: new Date(m.at).toUTCString(), raw: m.raw });
				}
				return { messages, count: messages.length };
			},
			newMessageId: () => `<made-up-send-${++w.sendIds}@example.com>`,
			sendMail: async (o) => {
				w.events.push(`send ${o.messageId}`);
				if (w.onSend) w.onSend(o);
				w.smtp.push({ ...o, attachments: (o.attachments || []).map((a) => ({ ...a })) });
				const b = w.smtpBehaviors.shift() || "OK";
				if (b === "HANG") return new Promise(() => {});
				if (b === "OK") w.sentBox.set(o.messageId, { raw: await mimeOf(o), at: w.now });
				if (b === "OK" || b === "NOT_FILED") return { ok: true };
				if (b === "REFUSED") throw Object.assign(new Error(`made-up refusal for ${o.to}`), { code: "EENVELOPE", outcome: "refused" });
				if (b === "LOST") throw Object.assign(new Error("made-up timeout"), { code: "ETIMEDOUT", outcome: "unknown" });
				throw new Error(`unknown behaviour ${b}`);
			},
			uploadsRoot: UPLOADS,
			fileExists: (p) => w.files.has(path.basename(p)),
			sleep: async (ms) => {
				w.sleeps.push(ms);
			},
			out: (line) => w.out.push(line),
			...rest,
		};
	};
	return w;
}

const pending = (w) => w.db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims WHERE state IN ('queued', 'waiting', 'working')").get().n;

// The story every case starts from, on the world's clock:
//   T0       the job's baseline; LD-TEST-0810 drafted by a job with sending off (before
//            any stop, no refusal on record)
//   T0+10m   LD-TEST-0800 sent by the job (its domain listed)
//   T0+15m   its trailer changes: the job stops sending (LOAD_CHANGED_AFTER_SEND)
//   T0+20m   loads delivered now are drafted, never sent (`during`, and `duringOther`
//            to a domain off the send list)
//   T0+2h    the resume script clears the stop; then LD-TEST-0820, to a domain off the
//            send list, is drafted with a refusal on record
//   T0+40h   the script runs
async function stopWorld({ during = ["LD-TEST-0801", "LD-TEST-0802"], duringOther = [], beforeDrafts = null, afterDrafts = null, resume = true, dbFile = null } = {}) {
	const w = world({ dbFile });
	let job = jobLib.create(w.jobDeps({ sendOn: false }));
	await job.tick();
	w.now += 5 * MIN;
	w.ready("LD-TEST-0810");
	await job.tick();
	w.now += 5 * MIN;
	job = jobLib.create(w.jobDeps({ sendOn: true }));
	w.ready("LD-TEST-0800");
	await job.tick();
	w.now += 5 * MIN;
	w.setRow("LD-TEST-0800", { "Trailer Number": "TR-9" });
	await job.tick();
	w.stopAt = iso(w.now);
	w.now += 5 * MIN;
	for (const id of during) w.ready(id);
	for (const id of duringOther) w.ready(id, { domain: OTHER_DOMAIN });
	if (beforeDrafts) await beforeDrafts(w);
	let ticks = 0;
	do {
		await job.tick();
		w.now += 5 * MIN;
	} while (pending(w) && ++ticks < 12);
	if (afterDrafts) await afterDrafts(w);
	if (resume) {
		w.now = T0 + 2 * HOUR;
		resumeScript.run({ db: w.db, dryRun: false, nowIso: iso(w.now) });
		w.resumedAt = iso(w.now);
		w.now += 5 * MIN;
		w.ready("LD-TEST-0820", { domain: OTHER_DOMAIN });
		await job.tick();
	}
	w.now = T0 + 40 * HOUR;
	return w;
}

const draftsShot = (w) => JSON.stringify([...w.drafts].map(([id, m]) => [id, sha(m.raw), m.at]));
function dbShot(db) {
	const all = (sql) => db.prepare(sql).all();
	return JSON.stringify([all("SELECT * FROM auto_invoice_claims ORDER BY load_key"), all("SELECT * FROM auto_invoice_meta ORDER BY key"),
		all("SELECT * FROM audit_trail ORDER BY id"), all("SELECT * FROM load_invoice_drafts ORDER BY id")]);
}
// The message sent is the engine's own, byte for byte.
function sameMessage(sent, built) {
	return Boolean(sent && built) && sent.to === built.to && sent.subject === built.subject && sent.html === built.html
		&& sent.attachments.length === built.attachments.length
		&& sent.attachments.every((a, i) => a.filename === built.attachments[i].filename && a.contentType === built.attachments[i].contentType
			&& Buffer.isBuffer(a.content) && a.content.equals(built.attachments[i].content));
}
const labels = (result) => (result ? result.loads.map((e) => [e.load, e.label === "CLEAN" ? "CLEAN" : e.word, e.fromStop, e.visible]) : null);
const sentLoads = (w) => w.smtp.map((s) => s.subject.replace(/^Example Broker Order #/, ""));
const markOf = (w, id) => (JSON.parse(ledgerLib.getMeta(w.db)[`send_drafted:${key(id)}`] || "{}").state) || "";
async function runSafe(lib, opts) {
	try {
		return { result: await lib.run(opts), threw: "" };
	} catch (e) {
		return { result: null, threw: e instanceof lib.Refusal ? `refused: ${e.message}` : `threw: ${(e && e.message) || e}` };
	}
}
// What Completed Loads shows for a load: the server's answer and the client's chip.
function labelOf(w, id) {
	const job = jobLib.create(w.jobDeps({ sendOn: true }));
	const row = { ...w.rows.find((r) => key(r["Load ID"]) === key(id)) };
	job.annotateCompletedRows({ rows: [row], headers: [...HEADERS], isSuperAdmin: true });
	const chip = client && row._autoInvoice ? client.autoInvoiceChip(row._autoInvoice) : null;
	return { sent: Boolean(row._autoInvoice && row._autoInvoice.sent), label: chip ? chip.label : "" };
}

// ------------------------------------------------------------------ the cases
// Each returns a plain summary: the sections assert it, and a mutant is caught when
// its summary differs from the script's own.

function windowCase(lib) {
	const make = () => {
		const db = new Database(":memory:");
		db.exec(AUDIT_SQL);
		return db;
	};
	const add = (db, ts, action, details) => db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, 'auto-invoice', 'system', ?, 'load', 'LD-TEST-0900', ?)")
		.run(ts, action, details);
	const read = (db, stopAt) => {
		try {
			const r = lib.readWindow(db, stopAt);
			return [r.stopAt, r.resumedAt, r.reason];
		} catch (e) {
			return e instanceof lib.Refusal ? `refused: ${e.message}` : `threw: ${(e && e.message) || e}`;
		}
	};
	const S1 = "2026-09-14T17:22:08.512Z";
	const S1_ROW = "2026-09-14T17:22:08.590Z";
	const R1 = "2026-09-15T08:41:00.000Z";
	const S2 = "2026-09-20T12:06:00.000Z";
	const R2 = "2026-09-20T15:30:00.000Z";
	const out = {};
	let db = make();
	out.none = read(db);
	add(db, S1_ROW, "auto_invoice_send_stopped", "LOAD_CHANGED_AFTER_SEND (09142026-7)");
	out.noResume = read(db);
	add(db, R1, "auto_invoice_send_resumed", `cleared the stop of ${S1} (LOAD_CHANGED_AFTER_SEND)`);
	out.one = read(db);
	add(db, "2026-09-20T12:06:00.070Z", "auto_invoice_send_stopped", "LOAD_CHANGED_AFTER_SEND (09202026-2)");
	add(db, R2, "auto_invoice_send_resumed", `cleared the stop of ${S2} (LOAD_CHANGED_AFTER_SEND)`);
	out.two = read(db);
	out.pickFirst = read(db, S1);
	out.pickSecond = read(db, S2);
	out.pickRowTime = read(db, S1_ROW);
	db = make();
	add(db, S1_ROW, "auto_invoice_send_stopped", "SMTP_REFUSED (09142026-7)");
	add(db, R1, "auto_invoice_send_resumed", `cleared the stop of ${S1} (SMTP_REFUSED)`);
	add(db, "2026-09-20T12:06:00.070Z", "auto_invoice_send_stopped", "STOPPED_BY_ADMIN by made-up-admin");
	out.otherReasons = read(db);
	db = make();
	add(db, S1_ROW, "auto_invoice_send_stopped", "LOAD_CHANGED_AFTER_SEND (09142026-7)");
	add(db, R1, "auto_invoice_send_resumed", `cleared the stop of ${S1} (LOAD_CHANGED_AFTER_SEND)`);
	add(db, R2, "auto_invoice_send_resumed", `cleared the stop of ${S1} (LOAD_CHANGED_AFTER_SEND)`);
	out.twoResumes = read(db);
	return out;
}

async function dryCase(lib) {
	const w = await stopWorld();
	const before = dbShot(w.db);
	const drafts = draftsShot(w);
	const { result, threw } = await runSafe(lib, w.scriptOpts({ dryRun: true }));
	return { w, summary: { threw, lines: w.out, window: result && result.window, smtp: w.smtp.length, unchanged: dbShot(w.db) === before && draftsShot(w) === drafts } };
}

async function applyCase(lib, { behaviors = [], more = {}, worldOpts = {}, setup = null } = {}) {
	const w = await stopWorld(worldOpts);
	w.smtpBehaviors.push(...behaviors);
	if (setup) setup(w);
	const ids = ["LD-TEST-0801", "LD-TEST-0802"];
	const old = ids.map((id) => w.claim(id).message_id);
	const drafts = draftsShot(w);
	const before = ids.map((id) => labelOf(w, id).label);
	const { result, threw } = await runSafe(lib, w.scriptOpts({ dryRun: false, ...more }));
	return { w, ids, old, drafts, before, result, threw };
}

async function applySummary(lib) {
	const r = await applyCase(lib);
	const { w, ids, old } = r;
	const confirmedInOrder = w.smtp.length > 0 && w.smtp.every((s, i) => {
		const sendAt = w.events.indexOf(`send ${s.messageId}`);
		const confirmAt = w.events.indexOf(`search ${SENT_BOX} ${s.messageId}`);
		const next = w.smtp[i + 1] ? w.events.indexOf(`send ${w.smtp[i + 1].messageId}`) : Infinity;
		return sendAt >= 0 && confirmAt > sendAt && confirmAt < next;
	});
	const job = jobLib.create(w.jobDeps({ sendOn: true }));
	const button = ids.map((id) => {
		const b = job.draftButtonCheck({ body: {} }, id);
		return [b.ok, b.http || 0, (b.json && b.json.code) || ""];
	});
	const firstSmtp = w.smtp.length;
	const firstOut = [...w.out];
	const again = await runSafe(lib, w.scriptOpts({ dryRun: false }));
	return {
		threw: r.threw,
		failed: r.result ? r.result.failed : "no result",
		sent: sentLoads(w).slice(0, firstSmtp),
		exact: ids.map((id, i) => sameMessage(w.smtp[i], w.rendered.get(key(id)))),
		from: w.smtp.slice(0, firstSmtp).map((s) => [s.user, s.from]),
		fresh: w.smtp.slice(0, firstSmtp).map((s, i) => /^<made-up-send-\d+@example\.com>$/.test(s.messageId) && s.messageId !== old[i]),
		confirmedInOrder,
		claims: ids.map((id, i) => {
			const c = w.claim(id);
			return [c.state, c.delivery, c.stage, c.message_id === (w.smtp[i] || {}).messageId, Boolean(c.sent_at)];
		}),
		audits: w.db.prepare("SELECT username, role, action, entity, entity_id FROM audit_trail WHERE action = 'auto_invoice_sent' AND username = 'auto-invoice-send-drafted' ORDER BY id").all().map((a) => Object.values(a)),
		marks: ids.map((id) => markOf(w, id)),
		draftsUntouched: draftsShot(w) === r.drafts,
		oldDrafts: firstOut.slice(firstOut.indexOf("Old drafts to delete by hand (load, Message-ID):")),
		oldIds: old,
		labels: [r.before, ids.map((id) => labelOf(w, id).label), ids.map((id) => labelOf(w, id).sent)],
		button,
		again: { threw: again.threw, smtp: w.smtp.length - firstSmtp, listed: labels(again.result) },
	};
}

const HOLDS = ["LD-TEST-0841", "LD-TEST-0842", "LD-TEST-0843", "LD-TEST-0844", "LD-TEST-0845", "LD-TEST-0847", "LD-TEST-0848", "LD-TEST-0850",
	"LD-TEST-0851", "LD-TEST-0852", "LD-TEST-0853", "LD-TEST-0854", "LD-TEST-0856", "LD-TEST-0857"];
async function holdsSummary(lib) {
	const w = await stopWorld({
		during: ["LD-TEST-0801", "LD-TEST-0802", ...HOLDS],
		duringOther: ["LD-TEST-0849"],
		// A rate con uploaded a minute after Delivered, on file before the draft.
		beforeDrafts: (x) => x.db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES ('LD-TEST-0843', 'RATECON', 'rc-0843.pdf', '/uploads/rc-0843.pdf', ?)")
			.run(sqliteStamp(x.now + MIN)),
		afterDrafts: async (x) => {
			const c = (id) => x.claim(id);
			x.setRow("LD-TEST-0841", { "Trailer Number": "TR-7" });
			x.db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, changed_at) VALUES ('LD-TEST-0842', 'In Transit', 'Delivered', ?)").run(sqliteStamp(T0 + 30 * HOUR));
			x.mark("LD-TEST-0844", 1);
			x.db.prepare("INSERT INTO invoice_draft_inflight (load_key, load_id, invoice_id, path, state, started_at, updated_at) VALUES ('ld-test-0845', 'LD-TEST-0845', '10202026-90', 'imap', 'in_flight', ?, ?)")
				.run(iso(x.now), iso(x.now));
			x.handDraft("LD-TEST-0847");
			x.audit({ username: "auto-invoice", role: "system" }, "auto_invoice_send_refused", "load", "LD-TEST-0848", `${c("LD-TEST-0848").invoice_id}: DOMAIN_NOT_LISTED (${OTHER_DOMAIN}); drafted for a person instead`);
			x.drafts.delete(c("LD-TEST-0850").message_id);
			x.sentBox.set(c("LD-TEST-0851").message_id, x.drafts.get(c("LD-TEST-0851").message_id));
			const built = x.rendered.get("ld-test-0852");
			const edited = { ...built, attachments: built.attachments.map((a, i) => (i === 1 ? { ...a, content: Buffer.from("%PDF-1.4 made-up POD, edited in Gmail") } : a)) };
			const id52 = c("LD-TEST-0852").message_id;
			x.drafts.set(id52, { raw: await mimeOf({ from: `LogisX Inc. <${MAILBOX.user}>`, ...edited, messageId: id52 }), at: x.drafts.get(id52).at });
			x.drafts.get(c("LD-TEST-0853").message_id).at = T0 - 5 * 24 * HOUR;
			x.hidden.add(c("LD-TEST-0854").message_id);
			x.mark("LD-TEST-0856", 0);
			x.setRow("LD-TEST-0857", { "Job Status": "In Transit" });
		},
	});
	// The dry run's labels first: what the listing says, before any re-check at a send.
	const dry = await runSafe(lib, w.scriptOpts({ dryRun: true }));
	const { result, threw } = await runSafe(lib, w.scriptOpts({ dryRun: false }));
	return { threw, failed: result ? result.failed : "no result", dryLabels: labels(dry.result), labels: labels(result), sent: sentLoads(w) };
}

// One case per hold the gate or the mailbox makes: each from-the-stop load's word.
async function gateSummary(lib) {
	const one = async (worldOpts, setWorld, more = {}) => {
		const w = await stopWorld(worldOpts);
		if (setWorld) setWorld(w);
		const { result, threw } = await runSafe(lib, w.scriptOpts({ dryRun: false, ...more }));
		return { threw, words: result ? result.loads.filter((e) => e.fromStop === "yes").map((e) => [e.label === "CLEAN" ? "CLEAN" : e.word, e.visible]) : null,
			smtp: w.smtp.length, none: w.out.includes("  the mailbox login sees none of the drafts: nothing is sent") };
	};
	return {
		month: await one({}, (w) => w.db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-10', 'locked', ?)").run(iso(T0 + 3 * HOUR))),
		sheet: await one({}, (w) => { w.sheetFails = true; }),
		off: await one({}, null, { env: { AUTO_INVOICE_SEND_ENABLED: "false" } }),
		draftsOff: await one({}, null, { env: { AUTO_INVOICE_DRAFTS_SHADOW: "" } }),
		stopped: await one({}, (w) => ledgerLib.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(T0 + 39 * HOUR) })),
		mailbox: await one({}, (w) => { w.searchFails = true; }),
		noneVisible: await one({}, (w) => w.drafts.clear()),
		recent: await one({}, null, { now: () => T0 + 30 * HOUR }),
	};
}

const claimShot = (w, id) => {
	const c = w.claim(id);
	return [c.state, c.reason_code, c.stage, c.delivery];
};
const buttonOf = (w, id) => {
	const b = jobLib.create(w.jobDeps({ sendOn: true })).draftButtonCheck({ body: {} }, id);
	return [b.ok, b.http || 0, (b.json && b.json.code) || ""];
};

// A person's Try again on Completed Loads (the job's own route), then the job's next look.
async function tryAgainOn(w, id) {
	const job = jobLib.create(w.jobDeps({ sendOn: true }));
	const routes = {};
	const add = (method) => (p, ...handlers) => { routes[`${method} ${p}`] = handlers; };
	job.mount({ get: add("GET"), put: add("PUT"), post: add("POST") }, { requireRole: () => (req, res, next) => next() });
	const out = { status: 0 };
	const res = { status(code) { out.status = code; return res; }, json() { if (!out.status) out.status = 200; return res; } };
	const req = { params: { loadKey: id }, body: {}, session: { user: { id: 7, username: "made-up-admin", role: "Super Admin" } } };
	for (const h of routes["POST /api/auto-invoice/loads/:loadKey/retry"] || []) {
		let next = false;
		await h(req, res, () => { next = true; });
		if (!next) break;
	}
	await job.tick();
	return out.status;
}

async function refusedSummary(lib) {
	const r = await applyCase(lib, { behaviors: ["REFUSED"] });
	const c = r.w.claim("LD-TEST-0801");
	const first = { failed: r.result && r.result.failed, smtp: r.w.smtp.length, claim: [c.state, c.stage, c.delivery, c.message_id === r.old[0], c.lease_owner],
		next: r.w.claim("LD-TEST-0802").delivery, marks: r.ids.map((id) => markOf(r.w, id)) };
	const retry = await runSafe(lib, r.w.scriptOpts({ dryRun: false }));
	return { threw: r.threw, first, retry: { threw: retry.threw, failed: retry.result && retry.result.failed, sent: sentLoads(r.w), delivery: r.ids.map((id) => r.w.claim(id).delivery) } };
}

async function lostSummary(lib) {
	const r = await applyCase(lib, { behaviors: ["LOST"] });
	const { w } = r;
	const first = { failed: r.result && r.result.failed, smtp: w.smtp.length, claim: claimShot(w, "LD-TEST-0801"),
		newId: w.claim("LD-TEST-0801").message_id === (w.smtp[0] || {}).messageId, next: w.claim("LD-TEST-0802").delivery,
		label: labelOf(w, "LD-TEST-0801").label, button: buttonOf(w, "LD-TEST-0801") };
	const dry = await runSafe(lib, w.scriptOpts({ dryRun: true }));
	const dryLines = w.out.filter((l) => /not confirmed in Sent Mail/.test(l));
	const again = await runSafe(lib, w.scriptOpts({ dryRun: false }));
	const smtpAfterAgain = w.smtp.length;
	// It did go: Gmail files it, and a person's Try again finds it in Sent Mail.
	if (w.smtp[0]) w.sentBox.set(w.smtp[0].messageId, { raw: await mimeOf(w.smtp[0]), at: w.now });
	const status = await tryAgainOn(w, "LD-TEST-0801");
	return { threw: r.threw, first, dryListed: labels(dry.result), dryLines, again: again.threw, smtpAfterAgain,
		tryAgain: [status, ...claimShot(w, "LD-TEST-0801"), w.smtp.length, labelOf(w, "LD-TEST-0801").label] };
}

async function notFiledSummary(lib) {
	const r = await applyCase(lib, { behaviors: ["NOT_FILED"] });
	const { w, ids } = r;
	const first = { failed: r.result && r.result.failed, smtp: w.smtp.length, sleeps: [...w.sleeps], claim: claimShot(w, "LD-TEST-0801"),
		checks: Number(w.claim("LD-TEST-0801").send_checks), next: w.claim("LD-TEST-0802").delivery, label: labelOf(w, "LD-TEST-0801").label,
		audits: w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE username = 'auto-invoice-send-drafted'").get().n };
	// Gmail files it late: Try again records it without sending it again, then the next run sends the next load.
	if (w.smtp[0]) w.sentBox.set(w.smtp[0].messageId, { raw: await mimeOf(w.smtp[0]), at: w.now });
	const status = await tryAgainOn(w, "LD-TEST-0801");
	const later = await runSafe(lib, w.scriptOpts({ dryRun: false }));
	return { threw: r.threw, first, tryAgain: [status, ...claimShot(w, "LD-TEST-0801")],
		later: { threw: later.threw, failed: later.result && later.result.failed, sent: sentLoads(w), labels: ids.map((id) => labelOf(w, id).label) } };
}

// A person sends the second load's draft from Gmail while the run sends the first.
async function recheckSummary(lib) {
	const moveOut = (sentOnly) => (w) => {
		w.onSend = () => {
			w.onSend = null;
			const id = w.claim("LD-TEST-0802").message_id;
			w.sentBox.set(id, w.drafts.get(id));
			if (!sentOnly) w.drafts.delete(id);
		};
	};
	const one = async (setup) => {
		const r = await applyCase(lib, { setup });
		return { threw: r.threw, failed: r.result && r.result.failed, sent: sentLoads(r.w), delivery: r.ids.map((id) => r.w.claim(id).delivery),
			label: (labels(r.result) || []).find((x) => x[0] === "LD-TEST-0802") || null, lines: r.w.out.filter((l) => /at its send/.test(l)) };
	};
	return { fromGmail: await one(moveOut(false)), sentKeptInDrafts: await one(moveOut(true)) };
}

// While a send is under way: what Draft Invoice, a press, a factoring mark, the label and
// the resume script's own count see.
async function flightSummary(lib) {
	const r = await applyCase(lib, { setup: (w) => {
		w.onSend = (o) => {
			w.onSend = null;
			const c = w.claim("LD-TEST-0801");
			const mark = factoring.mark(w.db, { key: "LD-TEST-0801", loadId: "LD-TEST-0801", reason: "made-up: the draft was not sent", confirmNotSent: true,
				actor: { id: 7, username: "made-up-admin" }, nowIso: iso(w.now) });
			const press = factoring.draftBegin(w.db, { key: "LD-TEST-0801", loadId: "LD-TEST-0801", invoiceId: "10202026-77", path: "imap", nowIso: iso(w.now) });
			w.during = {
				claim: [c.state, c.stage, c.delivery, c.message_id === o.messageId],
				button: buttonOf(w, "LD-TEST-0801"),
				mark: mark.ok ? "marked" : mark.code,
				press: press.ok ? "began" : press.code,
				label: labelOf(w, "LD-TEST-0801").label,
				resumeCounts: resumeScript.run({ db: w.db, dryRun: true }).unconfirmed,
			};
		};
	} });
	return { threw: r.threw, failed: r.result && r.result.failed, during: r.w.during || null, after: claimShot(r.w, "LD-TEST-0801"),
		factored: factoring.isFactored(r.w.db, "LD-TEST-0801"), sent: sentLoads(r.w) };
}

// The process dies inside the send; the app then restarts (the driver's trigger takes
// every working claim over at start-up) and its own recovery searches Sent Mail.
async function crashSummary(lib) {
	const one = async (delivered) => {
		const w = await stopWorld({ during: ["LD-TEST-0801"] });
		w.smtpBehaviors.push("HANG");
		lib.run(w.scriptOpts({ dryRun: false })).catch(() => {});
		for (let i = 0; i < 5000 && !w.smtp.length; i++) await new Promise((resolve) => setImmediate(resolve));
		const msg = w.smtp[0] || {};
		if (msg.messageId && delivered) w.sentBox.set(msg.messageId, { raw: await mimeOf(msg), at: w.now });
		const c = w.claim("LD-TEST-0801");
		const during = [c.state, c.stage, c.delivery, c.message_id === msg.messageId, Date.parse(c.lease_until) > w.now];
		w.now += 16 * MIN;
		const job = jobLib.create(w.jobDeps({ sendOn: true, trigger: true }));
		job.startTrigger();
		await job.finishStartUp();
		return { during, after: claimShot(w, "LD-TEST-0801"), smtp: w.smtp.length, label: labelOf(w, "LD-TEST-0801").label };
	};
	return { delivered: await one(true), neverLeft: await one(false) };
}

async function capSummary(lib) {
	const r = await applyCase(lib, { more: { max: 1 } });
	return { threw: r.threw, failed: r.result && r.result.failed, sent: sentLoads(r.w), left: r.w.out.filter((l) => /left for the next run/.test(l)) };
}

// ------------------------------------------------------------------ SMTP stand-in
// An SMTP server on 127.0.0.1 inside this process, closed after its case: every
// message it takes is kept, and handed to `onMessage` (Gmail filing its Sent copy).
function smtpStandIn(onMessage) {
	const st = { messages: [], rcpt: [], mailFrom: [] };
	const socks = new Set();
	const srv = net.createServer((sock) => {
		socks.add(sock);
		sock.on("close", () => socks.delete(sock));
		sock.on("error", () => {});
		let inData = false;
		let buf = "";
		let lines = [];
		sock.write("220 made-up.test ESMTP\r\n");
		sock.on("data", (chunk) => {
			buf += chunk.toString("latin1");
			for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (inData) {
					if (line === ".") {
						inData = false;
						const raw = Buffer.from(`${lines.join("\r\n")}\r\n`, "latin1");
						lines = [];
						st.messages.push(raw);
						onMessage(raw);
						sock.write("250 queued\r\n");
					} else lines.push(line.startsWith("..") ? line.slice(1) : line);
					continue;
				}
				const cmd = line.slice(0, 4).toUpperCase();
				if (cmd === "EHLO") sock.write("250-made-up.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
				else if (cmd === "AUTH") sock.write("235 ok\r\n");
				else if (cmd === "MAIL") { st.mailFrom.push(line.slice(10)); sock.write("250 ok\r\n"); }
				else if (cmd === "RCPT") { st.rcpt.push(line.slice(8)); sock.write("250 ok\r\n"); }
				else if (cmd === "DATA") { inData = true; sock.write("354 go ahead\r\n"); }
				else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
				else sock.write("250 ok\r\n");
			}
		});
	});
	const close = () => new Promise((r) => { for (const s of socks) s.destroy(); srv.close(() => r()); });
	return new Promise((resolve, reject) => {
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => resolve({ st, port: srv.address().port, close }));
	});
}
// The real nodemailer, pointed at the stand-in instead of Gmail.
const toStandIn = (port) => ({ createTransport: (opts) => realMailer.createTransport({
	host: "127.0.0.1", port, secure: false, ignoreTLS: true, auth: opts.auth, connectionTimeout: 1500, greetingTimeout: 1500, socketTimeout: 1500,
}) });

// A copy of the script with its edits ([from, to] pairs), compiled beside it so its
// relative requires resolve; null when an edit doesn't match exactly once.
function mutantModule(file, edits) {
	let src = fs.readFileSync(file, "utf8");
	for (const [from, to] of edits) {
		if (src.split(from).length !== 2) return null;
		src = src.replace(from, () => to);
	}
	const m = new Module(file, module);
	m.filename = file;
	m.paths = Module._nodeModulePaths(path.dirname(file));
	m._compile(src, file);
	return m.exports;
}

// ------------------------------------------------------------------ main
async function main() {
	client = await import(pathToFileURL(path.join(ROOT, "client", "src", "lib", "autoInvoiceStatus.js")).href);
	const lib = sendDrafted;
	const missing = (n) => ok(lib && typeof lib.run === "function", `§${n} FAILS ON THE OLD CODE: scripts/auto-invoice-send-drafted.js exists and exports run()`);

	// ---------------------------------------------------------------- §1
	section("§1  the stop's window, from the audit log only");
	missing(1);
	if (lib) {
		const s = windowCase(lib);
		const R = "LOAD_CHANGED_AFTER_SEND";
		eq(s.none, `refused: no ${R} stop in the audit log: nothing to send`, "§1 no stop for a changed load: refused");
		eq(s.noResume, "refused: the stop of 2026-09-14T17:22:08.590Z has no resume in the audit log (it may still stand)", "§1 a stop with no resume: refused");
		eq(s.one, ["2026-09-14T17:22:08.512Z", "2026-09-15T08:41:00.000Z", R], "§1 one stop: from the stop's own time, as the resume's row names it, to the resume");
		eq(s.two, `refused: 2 ${R} stops in the audit log: name one with --stop-at (2026-09-14T17:22:08.512Z, 2026-09-20T12:06:00.000Z)`, "§1 two stops and no --stop-at: refused, naming both");
		eq([s.pickFirst, s.pickSecond], [["2026-09-14T17:22:08.512Z", "2026-09-15T08:41:00.000Z", R], ["2026-09-20T12:06:00.000Z", "2026-09-20T15:30:00.000Z", R]],
			"§1 --stop-at picks one stop, matched exactly");
		eq(s.pickRowTime, `refused: no ${R} stop at 2026-09-14T17:22:08.590Z in the audit log`, "§1 ...the stop row's own time is not the stop's: refused");
		eq(s.otherReasons, `refused: no ${R} stop in the audit log: nothing to send`, "§1 stops for other reasons only (an SMTP refusal, a Super Admin's Stop): refused");
		eq(s.twoResumes, "refused: the stop of 2026-09-14T17:22:08.590Z matches more than one resume in the audit log", "§1 one stop, two resumes naming it: refused");
		const w = await stopWorld({ resume: false });
		const r = await runSafe(lib, w.scriptOpts({ dryRun: false }));
		eq([r.threw, w.smtp.length], [`refused: the stop of ${w.stopAt} has no resume in the audit log (it may still stand)`, 0], "§1 the story with the stop still standing: --apply refuses and sends nothing");
	}

	// ---------------------------------------------------------------- §2
	section("§2  the dry run");
	missing(2);
	if (lib) {
		const { w, summary } = await dryCase(lib);
		eq(summary.threw, "", "§2 the dry run runs");
		eq(summary.window, { stopAt: w.stopAt, resumedAt: w.resumedAt, reason: "LOAD_CHANGED_AFTER_SEND" }, "§2 the window is the job's own stop row and the resume script's row");
		eq(summary.lines, [
			"DRY RUN (nothing written)",
			`  mailbox: ${MAILBOX.user}`,
			`  stop: ${w.stopAt} LOAD_CHANGED_AFTER_SEND, resumed ${w.resumedAt}`,
			"  Draft ready in Gmail: 4 loads",
			"  LD-TEST-0810  CHECK BY HAND (not from the stop)  from the stop: outside  draft visible: yes",
			"  LD-TEST-0801  CLEAN  from the stop: yes  draft visible: yes",
			"  LD-TEST-0802  CLEAN  from the stop: yes  draft visible: yes",
			"  LD-TEST-0820  CHECK BY HAND (not from the stop)  from the stop: outside  draft visible: yes",
			"  would send: 2 of 2 CLEAN (at most 3 a run)",
		], "§2 it prints the mailbox account, the stop, and every Draft ready in Gmail load: its label, from the stop or why not, its draft's visibility (the load sent before the stop isn't one)");
		eq([summary.smtp, summary.unchanged], [0, true], "§2 nothing sent, nothing written: claims, meta, audit rows, draft rows and Gmail Drafts as they were");
	}

	// ---------------------------------------------------------------- §3
	section("§3  --apply: each CLEAN load sent once, the draft as built, confirmed, recorded");
	missing(3);
	if (lib) {
		const s = await applySummary(lib);
		eq([s.threw, s.failed], ["", null], "§3 the run completes");
		eq(s.sent, ["LD-TEST-0801", "LD-TEST-0802"], "§3 the two CLEAN loads, one send each, in order");
		eq(s.exact, [true, true], "§3 each message is the draft as the engine built it: same To, subject, body and attachments, byte for byte (not a re-render)");
		eq(s.from, [[MAILBOX.user, `LogisX Inc. <${MAILBOX.user}>`], [MAILBOX.user, `LogisX Inc. <${MAILBOX.user}>`]], "§3 ...through the mailbox's own login, From the mailbox");
		eq(s.fresh, [true, true], "§3 ...each with a fresh Message-ID, never the old draft's");
		eq(s.confirmedInOrder, true, "§3 each send is found in Sent Mail before the next send");
		eq(s.claims, [["drafted", "send", "recorded", true, true], ["drafted", "send", "recorded", true, true]], "§3 recorded as the job records a send: delivery 'send', the new Message-ID, sent_at");
		eq(s.audits, [["auto-invoice-send-drafted", "system", "auto_invoice_sent", "load", "LD-TEST-0801"], ["auto-invoice-send-drafted", "system", "auto_invoice_sent", "load", "LD-TEST-0802"]],
			"§3 ...with one audit row each, as the system actor");
		eq(s.marks, ["recorded", "recorded"], "§3 ...and each load's mark closed");
		eq(s.labels, [["Draft ready in Gmail", "Draft ready in Gmail"], ["Sent to the broker", "Sent to the broker"], [true, true]],
			"§3 Completed Loads: \"Draft ready in Gmail\" before, \"Sent to the broker\" after (the server's answer and the client's chip, no new label)");
		eq(s.button, [[false, 409, "INVOICE_ALREADY_SENT"], [false, 409, "INVOICE_ALREADY_SENT"]], "§3 Draft Invoice then refuses: the invoice was sent");
		eq(s.draftsUntouched, true, "§3 the old drafts are never edited or deleted");
		eq(s.oldDrafts, ["Old drafts to delete by hand (load, Message-ID):", `  LD-TEST-0801  ${s.oldIds[0]}`, `  LD-TEST-0802  ${s.oldIds[1]}`], "§3 ...each sent load's old draft is listed: load and Message-ID");
		eq([s.again.threw, s.again.smtp, s.again.listed], ["", 0, [["LD-TEST-0810", "not from the stop", "outside", "found"], ["LD-TEST-0820", "not from the stop", "outside", "found"]]],
			"§3 a second run sends nothing: the sent loads aren't Draft ready any more");
	}

	// ---------------------------------------------------------------- §4
	section("§4  every check that holds a load");
	missing(4);
	if (lib) {
		const s = await holdsSummary(lib);
		eq([s.threw, s.failed], ["", null], "§4 the run completes");
		const want = {
			"LD-TEST-0810": ["not from the stop", "outside", "found"],
			"LD-TEST-0801": ["CLEAN", "yes", "found"],
			"LD-TEST-0802": ["CLEAN", "yes", "found"],
			"LD-TEST-0841": ["changed", "yes", "found"],
			"LD-TEST-0842": ["recent", "yes", "found"],
			"LD-TEST-0843": ["ratecon", "yes", "found"],
			"LD-TEST-0844": ["factored", "yes", "found"],
			"LD-TEST-0845": ["press", "yes", "found"],
			"LD-TEST-0847": ["not from the stop", "person", "found"],
			"LD-TEST-0848": ["not from the stop", "refused", "found"],
			"LD-TEST-0849": ["not from the stop", "domain", "found"],
			"LD-TEST-0850": ["invisible", "yes", "absent"],
			"LD-TEST-0851": ["sent", "yes", "found"],
			"LD-TEST-0852": ["mismatch", "yes", "found"],
			"LD-TEST-0853": ["fetch", "yes", "found"],
			"LD-TEST-0854": ["invisible", "yes", "absent"],
			"LD-TEST-0856": ["mark", "yes", "found"],
			"LD-TEST-0857": ["status", "yes", "found"],
			"LD-TEST-0820": ["not from the stop", "outside", "found"],
		};
		const got = Object.fromEntries((s.labels || []).map(([load, ...rest]) => [load, rest]));
		const explain = {
			"LD-TEST-0810": "drafted before the stop (sending off)", "LD-TEST-0841": "its trailer changed since the draft", "LD-TEST-0842": "Delivered again 10 hours ago",
			"LD-TEST-0843": "a rate con uploaded after Delivered", "LD-TEST-0844": "marked factored", "LD-TEST-0845": "a Draft Invoice press in flight",
			"LD-TEST-0847": "a person's draft too", "LD-TEST-0848": "a send refusal on record", "LD-TEST-0849": "its domain off the send list",
			"LD-TEST-0850": "its draft gone from Drafts", "LD-TEST-0851": "its Message-ID in Sent Mail", "LD-TEST-0852": "its draft edited in Gmail",
			"LD-TEST-0853": "its draft not where the fetch looks", "LD-TEST-0854": "the Message-ID search doesn't see its draft", "LD-TEST-0856": "a mark set and cleared since the draft",
			"LD-TEST-0857": "set back from Delivered", "LD-TEST-0820": "drafted after the resume", "LD-TEST-0801": "clean", "LD-TEST-0802": "clean",
		};
		for (const [load, expected] of Object.entries(want)) eq(got[load], expected, `§4 ${load} (${explain[load]}): ${expected[0] === "CLEAN" ? "CLEAN" : `CHECK BY HAND (${expected[0]})`}`);
		eq(Object.keys(got).sort(), Object.keys(want).sort(), "§4 every Draft ready in Gmail load listed, and only those (a load drafted by hand has no automatic draft to list)");
		eq(s.dryLabels, s.labels, "§4 the dry run lists every load with the same label");
		eq(s.sent, ["LD-TEST-0801", "LD-TEST-0802"], "§4 only the CLEAN loads are sent");
	}

	// ---------------------------------------------------------------- §5
	section("§5  the gate and the mailbox");
	missing(5);
	if (lib) {
		const s = await gateSummary(lib);
		const both = (word, visible = "found") => [[word, visible], [word, visible]];
		eq(s.month, { threw: "", words: both("month"), smtp: 0, none: false }, "§5 a month closed since the draft (server.js's own closed-month rule, lifted): CHECK BY HAND (month)");
		eq(s.sheet, { threw: "", words: both("sheet"), smtp: 0, none: false }, "§5 Job Tracking can't be read: CHECK BY HAND (sheet)");
		eq(s.off, { threw: "", words: both("off"), smtp: 0, none: false }, "§5 sending off in the settings: CHECK BY HAND (off)");
		eq(s.draftsOff, { threw: "", words: both("off"), smtp: 0, none: false }, "§5 real drafts off (shadow): CHECK BY HAND (off)");
		eq(s.stopped, { threw: "", words: both("stopped"), smtp: 0, none: false }, "§5 sending stopped again: CHECK BY HAND (stopped)");
		eq(s.mailbox, { threw: "", words: both("mailbox", "unknown"), smtp: 0, none: true }, "§5 the mailbox can't be searched: CHECK BY HAND (mailbox), visibility unknown, nothing sent");
		eq(s.noneVisible, { threw: "", words: both("invisible", "absent"), smtp: 0, none: true }, "§5 the login sees none of the drafts: each CHECK BY HAND (invisible), and the run says so and sends nothing");
		eq(s.recent, { threw: "", words: both("recent"), smtp: 0, none: false }, "§5 Delivered less than 36 hours ago: CHECK BY HAND (recent)");
	}

	// ---------------------------------------------------------------- §6
	section("§6  errors: stop at the first, never send twice, record only what Sent Mail shows");
	missing(6);
	if (lib) {
		const ref = await refusedSummary(lib);
		eq([ref.threw, ref.first], ["", { failed: { load: "LD-TEST-0801", what: "the send was refused (EENVELOPE); nothing went out" }, smtp: 1,
			claim: ["drafted", "recorded", "", true, ""], next: "", marks: ["refused", ""] }],
		"§6 a send refused before its message: the run stops there, the claim back to the draft it was, the next load untouched");
		eq(ref.retry, { threw: "", failed: null, sent: ["LD-TEST-0801", "LD-TEST-0801", "LD-TEST-0802"], delivery: ["send", "send"] }, "§6 ...nothing went out, so a later run sends it");
		const lost = await lostSummary(lib);
		const MAYBE = "it may have gone out. The load is Needs attention (may already be sent) on Completed Loads; Try again there searches Sent Mail again and never sends";
		eq([lost.threw, lost.first], ["", { failed: { load: "LD-TEST-0801", what: `the send got no answer (ETIMEDOUT), but Sent Mail doesn't show <made-up-send-1@example.com>: ${MAYBE}` },
			smtp: 1, claim: ["needs_attention", "MAYBE_SENT", "appending", "send"], newId: true, next: "", label: "Needs attention: may already be sent", button: [false, 409, "INVOICE_ALREADY_SENT"] }],
		"§6 a send with no answer that Sent Mail doesn't show: the run stops; the load is left as the job leaves its own lost send (Needs attention, may already be sent), Draft Invoice refuses");
		eq([lost.dryListed, lost.dryLines], [[["LD-TEST-0810", "not from the stop", "outside", "found"], ["LD-TEST-0802", "CLEAN", "yes", "found"], ["LD-TEST-0820", "not from the stop", "outside", "found"]],
			["  1 send not confirmed in Sent Mail: --apply refuses until each is settled"]], "§6 ...a dry run says so");
		eq([lost.again, lost.smtpAfterAgain], ["refused: 1 send not confirmed in Sent Mail: settle each one first (Try again on Completed Loads searches Sent Mail again)", 1],
			"§6 ...and --apply refuses (exit 2) while it is unconfirmed: nothing sent");
		eq(lost.tryAgain, [200, "drafted", "", "recorded", "send", 1, "Sent to the broker"], "§6 ...a person's Try again searches Sent Mail, finds it and records it; nothing sends it again");
		const nf = await notFiledSummary(lib);
		eq([nf.threw, nf.first], ["", { failed: { load: "LD-TEST-0801", what: `the mail server took it, but Sent Mail doesn't show <made-up-send-1@example.com>: ${MAYBE}` },
			smtp: 1, sleeps: [10000, 30000, 60000], claim: ["needs_attention", "MAYBE_SENT", "appending", "send"], checks: 4, next: "", label: "Needs attention: may already be sent", audits: 0 }],
		"§6 a send Sent Mail doesn't show (searched at once, then after 10 s, 30 s and 60 s): stops, records nothing, the next load not sent, the load Needs attention (may already be sent)");
		eq([nf.tryAgain, nf.later], [[200, "drafted", "", "recorded", "send"], { threw: "", failed: null, sent: ["LD-TEST-0801", "LD-TEST-0802"], labels: ["Sent to the broker", "Sent to the broker"] }],
			"§6 ...once Sent Mail shows it, Try again records it without sending it again, and the next run sends the next load");
		// The app records a change on the second load while the first is being sent.
		const moved = await applyCase(lib, { setup: (w) => {
			w.onSend = () => {
				w.onSend = null;
				ledgerLib.transition(w.db, "ld-test-0802", { from: ["drafted"], patch: { changed_at: iso(w.now), changed_fields: "pods" }, nowIso: iso(w.now) });
			};
		} });
		eq([moved.threw, moved.result && moved.result.failed, sentLoads(moved.w), moved.ids.map((id) => moved.w.claim(id).delivery), markOf(moved.w, "LD-TEST-0802")],
			["", { load: "LD-TEST-0802", what: "changed before the send (changed); nothing sent" }, ["LD-TEST-0801"], ["send", ""], ""],
			"§6 a load that changes after it was judged CLEAN is checked again before its send: nothing sent, the run stops");
	}

	// ---------------------------------------------------------------- §7
	section("§7  the cap");
	missing(7);
	if (lib) {
		eq(lib.MAX_DEFAULT, 3, "§7 at most 3 loads a run unless --max says fewer or more (1 to 10)");
		const s = await capSummary(lib);
		eq(s, { threw: "", failed: null, sent: ["LD-TEST-0801"], left: ["  1 CLEAN load left for the next run (at most 1 a run)"] }, "§7 --max=1: one load sent, the other left for the next run");
	}

	// ---------------------------------------------------------------- §8
	section("§8  through the job's real SMTP sender: the wire message is the draft's own");
	missing(8);
	if (lib) {
		const w = await stopWorld({ during: ["LD-TEST-0801"] });
		const oldId = w.claim("LD-TEST-0801").message_id;
		let stand = null;
		try {
			stand = await smtpStandIn((raw) => w.sentBox.set(mimeRead.parseMessage(raw).messageId, { raw, at: w.now }));
		} catch (e) {
			failures.push(`§8 the SMTP stand-in could not listen on 127.0.0.1: ${e && e.code}`);
		}
		if (stand) {
			let r;
			try {
				r = await runSafe(lib, w.scriptOpts({ dryRun: false, sendMail: sendLib.createSmtpSender({ nodemailer: toStandIn(stand.port) }) }));
			} finally {
				await stand.close();
			}
			const raw = stand.st.messages[0];
			const p = raw ? mimeRead.parseMessage(raw) : null;
			const built = w.rendered.get("ld-test-0801");
			eq([r.threw, r.result && r.result.failed, stand.st.messages.length], ["", null, 1], "§8 one message reaches the server");
			eq(stand.st.rcpt.map((x) => x.replace(/\s.*$/, "")), [`<${built.to}>`], "§8 ...to the one recipient on the envelope");
			ok(raw && /^From: .*LogisX Inc\..*<drafts@example\.com>/m.test(raw.toString("latin1")), "§8 ...From the mailbox");
			eq(p && [p.to, p.cc, p.bcc, p.subject], [[built.to], [], [], built.subject], "§8 ...its To and subject the draft's");
			eq(p && p.html, built.html, "§8 ...its body the draft's, character for character");
			eq(p && p.attachments.map((a) => [a.filename, a.contentType, sha(a.content)]), built.attachments.map((a) => [a.filename, a.contentType, sha(a.content)]),
				"§8 ...its attachments the draft's, byte for byte, in order");
			ok(p && p.messageId !== oldId && r.result && p.messageId === r.result.sent[0].newMessageId, "§8 ...under a fresh Message-ID");
			eq([w.claim("LD-TEST-0801").delivery, w.claim("LD-TEST-0801").message_id === (p && p.messageId)], ["send", true], "§8 ...confirmed in Sent Mail and recorded");
		}
	}

	// ---------------------------------------------------------------- §9
	section("§9  the command line");
	missing(9);
	if (lib) {
		for (const [label, argv, says] of [
			["no arguments", [], "give exactly one of --dry-run and --apply"],
			["both modes", ["--dry-run", "--apply", "--db=x", "--sheet-id=s"], "give exactly one of --dry-run and --apply"],
			["no --db", ["--dry-run", "--sheet-id=s"], "--db=<app.db> is required"],
			["a blank --db", ["--dry-run", "--db= ", "--sheet-id=s"], "--db=<app.db> is required"],
			["no --sheet-id", ["--dry-run", "--db=x"], "--sheet-id=<id> is required (production's own sheet: --sheet-id=production)"],
			["--max=0", ["--dry-run", "--db=x", "--sheet-id=s", "--max=0"], "--max must be a whole number from 1 to 10"],
			["--max=11", ["--dry-run", "--db=x", "--sheet-id=s", "--max=11"], "--max must be a whole number from 1 to 10"],
			["--stop-at not a time", ["--dry-run", "--db=x", "--sheet-id=s", "--stop-at=yesterday"], "--stop-at must be the stop's time as the audit log prints it (an ISO time ending in Z)"],
			["an unknown argument", ["--dry-run", "--db=x", "--sheet-id=s", "--trash-sent-drafts"], "unknown or malformed argument: --trash-sent-drafts"],
		]) {
			let said = "";
			try {
				lib.parseArgs(argv);
			} catch (e) {
				said = e instanceof lib.Refusal ? e.message : `threw ${e && e.message}`;
			}
			eq(said, says, `§9 ${label}: refused`);
		}
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-send-drafted-"));
		try {
			const call = async (argv, { env = SCRIPT_ENV, w = null, depsMore = {} } = {}) => {
				const io = { out: "", err: "", loaded: 0, sheetId: null };
				const code = await lib.main(argv, {
					env,
					loadSettings: () => { io.loaded++; },
					deps: ({ sheetId }) => {
						io.sheetId = sheetId;
						return w ? { ...w.scriptOpts(), ...depsMore } : {};
					},
					stdout: (s) => { io.out += s; },
					stderr: (s) => { io.err += s; },
				});
				return { code, ...io };
			};
			const none = path.join(tmp, "none.db");
			const r1 = await call(["--dry-run", `--db=${none}`, "--sheet-id=sheet-under-test"]);
			eq([r1.code, r1.err, fs.existsSync(none), r1.loaded], [2, "refused: --db names no file\n", false, 0], "§9 --db naming no file: exit 2, no file made, no settings read");
			const r2 = await call(["--dry-run", `--db=${none}`, "--sheet-id=sheet-under-test"], { env: { ...SCRIPT_ENV, LOCAL_REPLICA: "1" } });
			eq([r2.code, r2.err, r2.loaded], [2, "refused: a replica never sends: run it in the app's folder on the server\n", 0], "§9 in a replica: exit 2 before anything is read");
			const empty = path.join(tmp, "empty.db");
			new Database(empty).close();
			const r3 = await call(["--dry-run", `--db=${empty}`, "--sheet-id=sheet-under-test"]);
			eq([r3.code, r3.err], [2, "refused: the database has no automatic-invoice, invoice-draft or audit_trail tables\n"], "§9 a database without the tables: exit 2");
			// The story in a database file.
			const file = path.join(tmp, "story.db");
			const w = await stopWorld({ dbFile: file });
			w.db.close();
			const bytes = sha(fs.readFileSync(file));
			const dry = await call(["--dry-run", `--db=${file}`, "--sheet-id=sheet-under-test"], { w });
			eq([dry.code, dry.err, sha(fs.readFileSync(file)) === bytes, w.smtp.length], [0, "", true, 0], "§9 --dry-run: exit 0; the database file, opened read-only, unchanged byte for byte; nothing sent");
			ok(dry.out.startsWith(`DRY RUN (nothing written)\n  database: ${file}\n  mailbox: ${MAILBOX.user}\n  sheet: sheet-under-test\n`),
				"§9 ...it names the database it opened (its absolute path), the mailbox account and the sheet it read");
			const relative = await call(["--dry-run", `--db=${path.relative(process.cwd(), file)}`, "--sheet-id=sheet-under-test"], { w });
			ok(relative.code === 0 && relative.out.includes(`\n  database: ${file}\n`), "§9 a relative --db is printed as the absolute path it opened");
			const prod = await call(["--dry-run", `--db=${file}`, "--sheet-id=production"], { w });
			eq([prod.code, prod.sheetId === sheetIds.PRODUCTION_SPREADSHEET_ID, /\n {2}sheet: production\n/.test(prod.out)], [0, true, true], "§9 --sheet-id=production names production's own sheet (lib/sheet-id.js), never a default");
			const noMailbox = await call(["--dry-run", `--db=${file}`, "--sheet-id=sheet-under-test"], { w, depsMore: { mailbox: { user: "", pass: "" } } });
			eq([noMailbox.code, noMailbox.err], [2, "refused: no mailbox login: the app's settings name no GMAIL_USER and app password\n"], "§9 no mailbox login: exit 2");
			const stopAt = await call(["--dry-run", `--db=${file}`, "--sheet-id=sheet-under-test", "--stop-at=2026-09-14T17:22:08.512Z"], { w });
			eq([stopAt.code, stopAt.err], [2, "refused: no LOAD_CHANGED_AFTER_SEND stop at 2026-09-14T17:22:08.512Z in the audit log\n"], "§9 a window that can't be read: exit 2");
			w.smtpBehaviors.push("REFUSED");
			const failed = await call(["--apply", `--db=${file}`, "--sheet-id=sheet-under-test"], { w });
			eq([failed.code, failed.err], [1, "failed: LD-TEST-0801: the send was refused (EENVELOPE); nothing went out\n"], "§9 --apply, a send refused: exit 1, naming the load and what happened");
			const applied = await call(["--apply", `--db=${file}`, "--sheet-id=sheet-under-test"], { w });
			eq([applied.code, applied.err, sentLoads(w)], [0, "", ["LD-TEST-0801", "LD-TEST-0801", "LD-TEST-0802"]], "§9 --apply: exit 0");
			ok(applied.out.startsWith(`APPLY\n  database: ${file}\n  mailbox: ${MAILBOX.user}\n`), "§9 ...it prints the database and the mailbox account before it sends");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}

	// ---------------------------------------------------------------- §10
	section("§10 the source: the app's own mailbox code and sender, nothing written to a mailbox");
	missing(10);
	if (lib) {
		const src = fs.readFileSync(SCRIPT_FILE, "utf8");
		const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
		const required = [...code.matchAll(/require\(\s*(["'`])([^"'`]+)\1\s*\)/g)].map((m) => m[2]);
		eq([...new Set(required)].sort(), ["../lib/auto-invoice-job", "../lib/auto-invoice-ledger", "../lib/auto-invoice-rules", "../lib/auto-invoice-send", "../lib/factoring-store",
			"../lib/imap-draft", "../lib/mime-read", "../lib/sheet-id", "./lib/server-lift", "./lib/server-source", "crypto", "dotenv", "fs", "googleapis", "nodemailer", "path"],
		"§10 it loads the app's own modules only: no n8n, no other mailbox client");
		eq(code.match(/\b(STORE|APPEND|COPY|MOVE|EXPUNGE|UID)\b|SELECT\s+"/g) || [], [], "§10 no IMAP command of its own; nothing that could change a mailbox");
		eq([/appendGmailDraft/.test(code), /createTransport/.test(code), /n8n/i.test(code)], [false, false, false], "§10 it never appends a draft, opens a transport of its own or calls n8n");
		eq([...new Set(code.match(/imapDraft\.\w+/g) || [])].sort(), ["imapDraft.MESSAGE_ID_RE", "imapDraft.fetchMessages", "imapDraft.findDraftByMessageId", "imapDraft.newMessageId"],
			"§10 from lib/imap-draft.js only its read-only search and fetch, and its Message-ID");
		eq([(code.match(/\.sendMail\(/g) || []).length, (code.match(/sendRules\.createSmtpSender\(/g) || []).length], [1, 1], "§10 one send, through the job's own SMTP sender");
		eq([(code.match(/INSERT INTO/g) || []).length, /\b(UPDATE|DELETE)\b/.test(code)], [1, false], "§10 its writes: the ledger's transition and meta, and one audit insert");
	}

	// ---------------------------------------------------------------- §11
	section("§11 the mailbox again right before each send");
	missing(11);
	if (lib) {
		const s = await recheckSummary(lib);
		eq(s.fromGmail, { threw: "", failed: null, sent: ["LD-TEST-0801"], delivery: ["send", ""], label: ["LD-TEST-0802", "invisible", "yes", "found"],
			lines: ["  LD-TEST-0802: CHECK BY HAND (invisible) at its send: its draft moved since the listing; nothing sent"] },
		"§11 a person sends a load's draft from Gmail after the listing: at its own send it is no longer in Drafts, so it is CHECK BY HAND and nothing is sent (no second invoice)");
		eq(s.sentKeptInDrafts, { threw: "", failed: null, sent: ["LD-TEST-0801"], delivery: ["send", ""], label: ["LD-TEST-0802", "sent", "yes", "found"],
			lines: ["  LD-TEST-0802: CHECK BY HAND (sent) at its send: its draft moved since the listing; nothing sent"] },
		"§11 ...its Message-ID in Sent Mail at its own send: CHECK BY HAND (sent), nothing sent");
	}

	// ---------------------------------------------------------------- §12
	section("§12 a send under way: what the app sees, and a run that dies mid-send");
	missing(12);
	if (lib) {
		const f = await flightSummary(lib);
		eq([f.threw, f.failed], ["", null], "§12 the run completes");
		eq(f.during, { claim: ["working", "appending", "send", true], button: [false, 409, "INVOICE_ALREADY_SENT"], mark: "AUTO_INVOICE_IN_FLIGHT", press: "INVOICE_SENT_MEANWHILE",
			label: "Making the invoice now", resumeCounts: 1 },
		"§12 during the send the claim holds the job's own send-start state: Draft Invoice refuses, a factoring mark and a press are refused, the label isn't \"Draft ready in Gmail\", the resume script counts it");
		eq([f.after, f.factored, f.sent], [["drafted", "", "recorded", "send"], false, ["LD-TEST-0801", "LD-TEST-0802"]], "§12 ...and once Sent Mail shows it, it is recorded as sent");
		const crash = await crashSummary(lib);
		eq(crash.delivered, { during: ["working", "appending", "send", true, true], after: ["drafted", "", "recorded", "send"], smtp: 1, label: "Sent to the broker" },
			"§12 the run dies after its message left: the app's own recovery finds it in Sent Mail and records it; nothing sends it again");
		eq(crash.neverLeft, { during: ["working", "appending", "send", true, true], after: ["needs_attention", "MAYBE_SENT", "appending", "send"], smtp: 1, label: "Needs attention: may already be sent" },
			"§12 the run dies before its message left: the app's own recovery doesn't find it and leaves it as its own lost send (Needs attention, may already be sent); nothing sends it again");
	}

	// ---------------------------------------------------------------- §13
	section("§13 mutants, each applied once and each caught");
	missing(13);
	if (lib) {
		const CASES = {
			window: async (l) => windowCase(l),
			dry: async (l) => (await dryCase(l)).summary,
			apply: applySummary,
			holds: holdsSummary,
			gate: gateSummary,
			refused: refusedSummary,
			lost: lostSummary,
			notFiled: notFiledSummary,
			cap: capSummary,
			recheck: recheckSummary,
			flight: flightSummary,
			crash: crashSummary,
		};
		const IN_FLIGHT = "const moved = ledger.transition(db, cur.load_key, { from: [\"drafted\"], nowIso, patch: {";
		const MUTANTS = [
			["send twice (an unanswered send read as refused, so the claim goes back to a draft)", "if (err && (err.outcome === \"login\" || err.outcome === \"refused\")) {", "if (err) {", "lost"],
			["re-render the body instead of the stored message", "\t\thtml: parsed.html,\n", "\t\thtml: `<p>Invoice ${c.invoice_id} for load ${c.load_id}.</p>`,\n", "apply"],
			["skip the Sent Mail check", "if (inSent === \"found\") return { word: \"sent\" };", "if (inSent === \"found\" && false) return { word: \"sent\" };", "holds"],
			["send a CHECK BY HAND load", "const clean = result.loads.filter((e) => e.label === \"CLEAN\");", "const clean = result.loads.filter((e) => e.label === \"CLEAN\" || e.fromStop === \"yes\");", "holds"],
			["skip the Drafts check", "if (visible !== \"found\") return { word: \"invisible\" };", "if (visible !== \"found\" && false) return { word: \"invisible\" };", "holds"],
			["record before confirming", "\tconst seen = await confirmSent(ctx, newId);", "\trecordSend(db, e.key, { owner, mark, checks: 0, nowIso: isoOf(ctx.now()) });\n\tconst seen = await confirmSent(ctx, newId);", "notFiled"],
			["no re-check of the mailbox before the send", "\tconst inDrafts = await lookFor(ctx, c.message_id, DRAFTS);\n\tif (inDrafts !== \"found\") return { skip: inDrafts === \"unknown\" ? \"mailbox\" : \"invisible\" };\n\tconst inSent = await lookFor(ctx, c.message_id, sendRules.SENT_MAILBOX);\n\tif (inSent !== \"absent\") return { skip: inSent === \"unknown\" ? \"mailbox\" : \"sent\" };\n", "", "recheck"],
			["no in-flight mark on the claim", IN_FLIGHT, IN_FLIGHT.replace("const moved = ", "const moved = 1 || "), "flight"],
			["the in-flight mark after the send", [[IN_FLIGHT, IN_FLIGHT.replace("const moved = ", "const moved = 1 || ")],
				["\tconst seen = await confirmSent(ctx, newId);", "\tledger.transition(db, e.key, { from: [\"drafted\"], nowIso: isoOf(ctx.now()), patch: { state: \"working\", stage: \"appending\", delivery: \"send\", sent_at: isoOf(ctx.now()), send_checks: 0, message_id: newId, lease_owner: owner, lease_until: isoOf(ctx.now() + LEASE_MS) } });\n\tconst seen = await confirmSent(ctx, newId);"]], null, "crash"],
			["carry on after an error", "\t\t\tout(`  stopped at ${failed.load}: ${failed.what}`);\n\t\t\tbreak;", "\t\t\tout(`  stopped at ${failed.load}: ${failed.what}`);\n\t\t\tcontinue;", "refused"],
			["ignore the cap", "clean.slice(0, max)", "clean.slice(0)", "cap"],
			["write on the dry run", "\tif (dryRun) {\n\t\tout(`  would send:", "\tif (dryRun && false) {\n\t\tout(`  would send:", "dry"],
			["a send carrying the old Message-ID", "attachments: e.message.attachments, messageId: newId });", "attachments: e.message.attachments, messageId: c.message_id });", "apply"],
			["a load outside the window", "if (handedMs < win.fromMs || handedMs > win.toMs) return \"outside\";", "if (false) return \"outside\";", "holds"],
			["a person's draft", "if (ledger.otherDraftRows(db, c).length) return \"person\";", "if (false) return \"person\";", "holds"],
			["a load drafted in the window for another reason", "if (refusalRows(db, c)) return \"refused\";", "if (false) return \"refused\";", "holds"],
			["two stops read as one", "if (chosen.length > 1) throw new Refusal(", "if (chosen.length > 1 && false) throw new Refusal(", "window"],
			["a stop with no resume read as a window", "if (matches.length !== 1) throw new Refusal(", "if (matches.length > 1) throw new Refusal(", "window"],
			["Delivered under 36 hours ago", "if (nowMs - deliveredMs < DELIVERED_AGO_MS) return { word: \"recent\" };", "if (false) return { word: \"recent\" };", "holds"],
			["a rate con after Delivered", "if (rateConAfter(db, key, deliveredMs)) return { word: \"ratecon\" };", "if (false) return { word: \"ratecon\" };", "holds"],
			["a change since the draft", "if (!saved || c.changed_fields || rules.fingerprintDiff(saved, rules.fingerprint(facts)).length) return { word: \"changed\" };", "if (!saved) return { word: \"changed\" };", "holds"],
			["the digest proof skipped", "if (rules.digestDifferences(jsonOf(c.draft_digest_json), rules.messageDigest(parsed)).length) return { word: \"mismatch\" };", "if (false) return { word: \"mismatch\" };", "holds"],
			["the closed-month rule not read", "closedMonths = shared.server.integrityClosedMonthsOf(shared.sheet.headers, row);", "closedMonths = [];", "gate"],
		];
		const real = {};
		for (const [label, from, to, caseName] of MUTANTS) {
			const m = mutantModule(SCRIPT_FILE, Array.isArray(from) ? from : [[from, to]]);
			ok(m, `§13 MUTANT ${label}: applied once`);
			if (!m) continue;
			if (!(caseName in real)) real[caseName] = JSON.stringify(await CASES[caseName](lib));
			let got;
			try {
				got = JSON.stringify(await CASES[caseName](m));
			} catch (e) {
				got = `threw ${(e && e.message) || e}`;
			}
			ok(got !== real[caseName], `§13 MUTANT ${label}: caught (${caseName})`);
			console.log(`  ${got !== real[caseName] ? "caught" : "NOT CAUGHT"}: ${label} (${caseName})`);
		}
	}
}

let finished = false;
process.on("exit", () => {
	if (finished) return;
	console.log("\n✗ the run stopped before its last case (a promise never settled)");
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length + 1} failed`);
	process.exitCode = 1;
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
