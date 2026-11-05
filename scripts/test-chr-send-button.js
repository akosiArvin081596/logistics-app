#!/usr/bin/env node
// "Send invoice to C.H. Robinson" (CHR_SEND_BUTTON_ENABLED; lib/invoice-send-button.js and its steps in
// lib/auto-invoice-job.js), on made-up loads, with a made-up engine, mailbox and SMTP sender on an
// in-memory database. The job, the ledger, the status and the saved evidence are the real modules.
// §14 runs the three wiring blocks and the engine as shipped.
//
//   §1  the flag: exactly "true", with a start date, never in a replica, only with the driver's
//       trigger and sending on; off, the routes aren't there, and nothing is read or paid for
//   §2  who: a Super Admin only; cross-site refused; rate limited, each after the role check
//   §3  when it shows: every condition, one by one, and its one line
//   §4  the preview: the look before any paid call, nothing written, no number used, the confirm's
//       fields, every failure with its reason (R-H2 (c): the Payments Table read live)
//   §5  the press: the token (one use, 15 minutes, the account's own, gone with a restart), one
//       conditional update, one audit row naming the account, one send
//   §6  the run: the look before prepare and the number; what goes is what was confirmed
//   §7  "back where it came from", one case per exit, default-deny: no draft, no Needs attention,
//       its number given up, one notice (review M-5, R-L8)
//   §8  the three ways that aren't back: closed by a hand draft or a factoring mark, and a send
//       that started, then a lost answer, which only ever gets searched for
//   §9  NEVER TWICE: a double press, a restart at each point, a concurrent driver's tap in each
//       order, a sheet write that reports failure but landed (R-H1), a stuck run (R-M4)
//   §10 start-up and the flags off: a press goes back, a maybe-sent load stays (R-H2 (b), R-M5)
//   §11 Try again on a press: refused unless it can only search
//   §12 the saved paid check: 2 a run, only with the flag on, the fingerprint, RATECON_MISSING
//   §13 what's kept and what's said: no address on the claim, no driver's name or phone anywhere
//   §14 through server.js's blocks and the engine as shipped, on a real Express app
//
// No network beyond the loopback listener, never reads app.db.
//   node scripts/test-chr-send-button.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
// A tree without the module fails by name, not by a stack trace.
const optional = (p) => {
	try {
		return require(p);
	} catch {
		return null;
	}
};
const sendButton = optional(path.join(ROOT, "lib", "invoice-send-button.js"));
const jobLib = require(path.join(ROOT, "lib", "auto-invoice-job.js"));
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const ledger = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const factoring = require(path.join(ROOT, "lib", "factoring-store.js"));
const evidenceLib = require(path.join(ROOT, "lib", "invoice-evidence.js"));
const resume = require(path.join(ROOT, "scripts", "auto-invoice-send-resume.js"));
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
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-20T14:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const FROM = "2026-10-01";
const HEADERS = Object.freeze(["Load ID", "Trailer Number", "Driver", "Driver Phone", "Job Status", "Email", "Status Update Date", "Completion Date", "  Payment  "]);
const DRIVER_NAME = "Made-up Driver Name";
const DRIVER_PHONE = "555-0100";
const CHR_EMAIL = "made-up.ops@chrobinson.com";
const BILLING = "made-up.billing@chrobinson.com";
const MAILBOX = Object.freeze({ user: "drafts@example.com", pass: "made-up" });
const PAYMENTS_HEADERS = Object.freeze([" Job ID", "Contract ID", "Payment Amount", "Invoice Number", "Payment Date", "Payment Status"]);
const SENT = "[Gmail]/Sent Mail";
const SA = Object.freeze({ id: 7, username: "made-up-admin", role: "Super Admin" });
const SA2 = Object.freeze({ id: 8, username: "made-up-admin-2", role: "Super Admin" });
const box = (over = {}) => ({ hits: 0, invoice: 0, mention: 0, ignored: 0, ignoredNamed: 0, overCap: 0, firstInvoiceDate: null, ...over });
const CLEAN = Object.freeze({ verdict: "clean", mailboxes: { drafts: box(), sent: box(), trash: box() } });

const turn = () => new Promise((r) => setImmediate(r));
// By turns of the event loop, never the clock: a loaded box can't change an outcome here.
async function until(cond, label, turns = 3000) {
	for (let i = 0; i < turns; i++) {
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

// The guard and handler chain of each route, with next("route") as Express reads it.
function fakeApp() {
	const routes = {};
	const add = (method) => (p, ...handlers) => { routes[`${method} ${p}`] = handlers; };
	const app = { get: add("GET"), put: add("PUT"), post: add("POST"), delete: add("DELETE") };
	const call = async (method, p, { params = {}, body = {}, user = SA } = {}) => {
		const handlers = routes[`${method} ${p}`];
		const out = { status: 200, body: null, fell: false };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		const req = { params, body, session: user ? { user } : {} };
		for (const h of handlers) {
			let went = null;
			await h(req, res, (arg) => { went = arg === undefined ? "next" : arg; });
			if (went === "route") { out.fell = true; break; }
			if (went !== "next") break;
		}
		return out;
	};
	return { app, call, routes };
}
const requireRole = (...roles) => (req, res, next) => {
	const user = req.session && req.session.user;
	if (!user) return res.status(401).json({ error: "made-up: sign in" });
	if (!roles.includes(user.role)) return res.status(403).json({ error: "made-up: not allowed" });
	return next();
};

function makeWorld() {
	const w = {
		now: T0,
		rows: [],
		files: new Set(),
		rateCons: new Map(),
		gmail: [],
		sent: [],
		smtp: [],
		smtpBehaviors: [],
		appends: [],
		timeline: [],
		calls: { prepare: 0, render: 0, record: 0, mint: 0, peek: 0, search: 0, look: [], payments: 0, reads: 0, sleep: [], failedNotes: [] },
		audits: [],
		notices: [],
		logs: [],
		payments: [[...PAYMENTS_HEADERS]],
		lookAnswer: CLEAN,
		mailbox: MAILBOX,
		closed: () => [],
		ids: 0,
		invalidated: 0,
		runLimits: [],
		sendDomains: ["chrobinson.com"],
		env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false" },
		crossSiteRefuses: false,
		limitRefuses: false,
		limited: 0,
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
	`);
	w.confirmed = (domains, optOut = []) => w.db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ optOutDomains: optOut, confirmedBrokerDomains: domains }));
	w.confirmed(["chrobinson.com"]);

	w.row = (id) => w.rows.find((r) => rules.loadKey(r["Load ID"]) === rules.loadKey(id)) || null;
	w.setRow = (id, over = {}) => {
		const was = w.row(id);
		const row = Object.freeze({ ...(was || { "Load ID": id, "Trailer Number": "TR-1", Driver: DRIVER_NAME, "Driver Phone": DRIVER_PHONE, "Job Status": "Delivered", Email: CHR_EMAIL,
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
	// Evidence as the mailbox pass saves it, read now: nothing in either mailbox, the Payments Table read.
	w.searched = (id, { at = w.now, answer = CLEAN } = {}) => evidenceLib.saveAnswer(w.db, rules.loadKey(id), answer, { nowIso: iso(at), paymentsAt: iso(at) });
	// A delivered load nothing has invoiced: its POD, a rate con naming a chrobinson.com billing address, the mailbox clean.
	w.ready = (id, over = {}, docEmail = BILLING) => {
		w.setRow(id, over);
		w.addPod(id);
		w.rateCons.set(rules.loadKey(id), docEmail);
		w.searched(id);
	};
	w.handDraft = (id, invoiceId = "10202026-50") => w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', 'imap', 'made-up-admin')").run(id, invoiceId, BILLING);
	w.engine = {
		async prepare({ loadId }) {
			w.calls.prepare++;
			w.timeline.push("prepare");
			if (w.prepareHook) {
				const r = await w.prepareHook(loadId);
				if (r) return r;
			}
			const key = rules.loadKey(loadId);
			const row = w.row(key);
			if (!row) return { ok: false, http: 404, code: "LOAD_NOT_FOUND" };
			if (!w.rateCons.has(key)) return { ok: false, http: 422, code: "RATECON_MISSING" };
			const rule = rules.recipientRule({ brokerEmail: row.Email, bisonRecipient: "", documentsEmail: w.rateCons.get(key), confirmedDomains: ledger.readSettings(w.db).confirmedBrokerDomains });
			if (!rule.ok) return { ok: false, http: 422, code: rule.code };
			return { ok: true, ctx: { loadId: row["Load ID"], to: rule.to } };
		},
		async render(ctx, opts) {
			w.calls.render++;
			w.timeline.push("render");
			if (w.renderHook) await w.renderHook(ctx);
			const ref = String(ctx.loadId).replace(/^#/, "");
			const [y, m, d] = String(opts.invoiceDate).split("-");
			const printed = `INVOICE Invoice ID # : ${opts.invoiceId} Date: ${m}/${d}/${y} Made-up Co. Load ID# ${ref} Total $1,000.00`;
			const out = {
				to: ctx.to,
				subject: `C.H. Robinson Order #${ref}`,
				html: `<p>Please see the attached documents for load number ${ref}.</p>`,
				attachments: [
					{ filename: `C.H. Robinson Invoice Order #${ref}.pdf`, content: textPdf(printed), contentType: "application/pdf" },
					{ filename: `${ref}_POD.pdf`, content: Buffer.from(`%PDF-1.4 made-up POD for ${ref}`), contentType: "application/pdf" },
					{ filename: `${ref}.pdf`, content: Buffer.from(`%PDF-1.4 made-up rate con for ${ref}`), contentType: "application/pdf" },
				],
				total: "$1,000.00",
			};
			return w.renderOver ? w.renderOver(out) : out;
		},
		async record(ctx, rendered, opts) {
			w.calls.record++;
			w.timeline.push("record");
			if (w.recordHook) await w.recordHook();
			const r = w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', ?, ?)")
				.run(ctx.loadId, opts.invoiceId, rendered.to, opts.via, opts.actor.username);
			return { recorded: true, draftRowId: r.lastInsertRowid };
		},
	};
	w.deps = (extra = {}) => ({
		db: w.db,
		env: w.env,
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
			w.timeline.push("mint");
			return `10202026-${w.calls.mint}`;
		},
		async appendGmailDraft(o) {
			w.appends.push({ to: o.to, messageId: o.messageId });
			w.gmail.push(o.messageId);
			return { ok: true };
		},
		async findDraftByMessageId({ messageId, mailboxes }) {
			w.calls.search++;
			if (w.searchFails) throw new Error("made-up search failure");
			const boxes = mailboxes || ["[Gmail]/Drafts", SENT];
			const held = (b) => (b === SENT ? w.sent : w.gmail).filter((m) => m === messageId).length;
			const hit = boxes.find((b) => held(b) > 0);
			return { found: Boolean(hit), count: hit ? held(hit) : 0, mailbox: hit || "" };
		},
		newMessageId: () => `<made-up-${++w.ids}.auto-invoice@example.com>`,
		mailbox: () => w.mailbox,
		bisonRecipient: () => "",
		logAudit: (req, action, entity, id, details) => w.audits.push({ who: req.session.user.username, action, id, details }),
		notify: (n) => w.notices.push(n),
		geminiUnavailableAt: () => w.geminiDownAt || null,
		log: { warn: (m) => w.logs.push(m), error: (m) => w.logs.push(m) },
		timeZone: "America/New_York",
		workerId: `worker-${++w.ids}`,
		send: { enabled: true, domains: w.sendDomains, settleMinutes: 0 },
		async sendMail(o) {
			const b = w.smtpBehaviors.shift() || "OK";
			w.timeline.push("smtp");
			w.smtp.push({ to: o.to, subject: o.subject, messageId: o.messageId, attachments: o.attachments.map((a) => a.filename), html: o.html });
			if (w.smtpHook) await w.smtpHook();
			if (b === "OK") { w.sent.push(o.messageId); return { ok: true }; }
			if (b === "REFUSED") throw Object.assign(new Error("made-up refusal"), { code: "EENVELOPE", outcome: "refused" });
			if (b === "LOGIN") throw Object.assign(new Error("made-up login"), { code: "EAUTH", outcome: "login" });
			if (b === "LOST") throw Object.assign(new Error("made-up lost answer"), { code: "CONN", outcome: "unknown" });
			if (b === "LANDED_LOST") { w.sent.push(o.messageId); throw Object.assign(new Error("made-up lost answer"), { code: "CONN", outcome: "unknown" }); }
			throw new Error(`unknown SMTP behaviour ${b}`);
		},
		invalidateJobTracking: () => { w.invalidated++; },
		readPaymentsTable: async () => {
			w.calls.payments++;
			w.timeline.push("payments");
			if (w.paymentsFail) throw new Error("made-up Sheets failure");
			return w.payments;
		},
		lookInMailbox: async (o) => {
			w.calls.look.push(o);
			w.timeline.push("look");
			if (w.lookHook) await w.lookHook();
			if (w.lookFails) throw new Error("made-up IMAP failure");
			return w.lookAnswer;
		},
		noteSearchFailed: (key) => w.calls.failedNotes.push(key),
		sleep: async (ms) => { w.calls.sleep.push(ms); },
		setTimer: (fn, ms) => {
			const limit = { fn, ms, live: true };
			w.runLimits.push(limit);
			return limit;
		},
		clearTimer: (limit) => { limit.live = false; },
		...extra,
	});
	w.passRunLimit = () => {
		const limit = w.runLimits.find((x) => x.live);
		if (!limit) return false;
		limit.live = false;
		limit.fn();
		return true;
	};
	w.meta = (key, value) => {
		ledger.ensureSchema(w.db);
		ledger.setMeta(w.db, key, value);
	};
	// One process: the job, the status and the button, on this world's database. `on`: the
	// button's flag. `start`: whether this process may run jobs.
	w.boot = async ({ on = true, fromDay = FROM, start = true, job: jobExtra = {} } = {}) => {
		w.meta("baseline_at", iso(T0 - DAY));
		w.meta("trigger_on_at", iso(T0 - HOUR));
		const job = jobLib.create(w.deps({ env: { ...w.env, CHR_SEND_BUTTON_ENABLED: on ? "true" : "", CHR_SEND_BUTTON_FROM: fromDay }, ...jobExtra }));
		const evidence = evidenceLib.create({
			db: w.db,
			env: { INVOICE_MAILBOX_PASS_ENABLED: "true" },
			now: () => new Date(w.now),
			readCompletedLoads: async () => ({ headers: HEADERS, rows: [...w.rows] }),
			readPaymentsTable: async () => w.payments,
			closedMonthsOf: (headers, row) => w.closed(row),
			dayKeyOf: () => "",
			sweepOn: () => false,
			mailbox: () => w.mailbox,
			search: async () => CLEAN,
			notify: (n) => w.notices.push(n),
			gapMs: 0,
			setInterval: () => 0,
			timeZone: "America/New_York",
			log: { warn: (m) => w.logs.push(m), error: (m) => w.logs.push(m) },
		});
		// `afterPress`: what changes in the moment after the press commits, before its run.
		const pressNow = job.button.press;
		const refreshNow = job.button.refresh;
		const wrapped = { ...job.button, refresh: (load) => {
			if (w.beforeRefresh) {
				const f = w.beforeRefresh;
				w.beforeRefresh = null;
				f();
			}
			return refreshNow(load);
		}, press: (args) => {
			if (w.beforePress) {
				const f = w.beforePress;
				w.beforePress = null;
				f();
			}
			const out = pressNow(args);
			if (out.ok && w.afterPress) {
				const f = w.afterPress;
				w.afterPress = null;
				f();
			}
			return out;
		} };
		const btn = sendButton.create({
			job: { button: wrapped },
			evidence: w.statusStub ? { statusReader: () => () => {
				if (w.statusThrows) throw Object.assign(new Error("made-up"), { code: "MADE_UP" });
				return w.statusStub;
			} } : evidence,
			db: w.db,
			peekInvoiceNumber: () => {
				w.calls.peek++;
				return `10202026-${w.calls.mint + 1}`;
			},
			logAudit: (req, action, entity, id, details) => w.audits.push({ who: req.session.user.username, action, id, details }),
			now: () => new Date(w.now),
			timeZone: "America/New_York",
			log: { warn: (m) => w.logs.push(m), error: (m) => w.logs.push(m) },
		});
		const f = fakeApp();
		btn.mount(f.app, {
			requireRole,
			refuseCrossSite: (req, res, next) => (w.crossSiteRefuses ? res.status(403).json({ error: "made-up: cross-site" }) : next()),
			limiter: (req, res, next) => {
				w.limited++;
				return w.limitRefuses ? res.status(429).json({ error: "made-up: too many" }) : next();
			},
		});
		const jf = fakeApp();
		job.mount(jf.app, { requireRole });
		w.job = job;
		w.btn = btn;
		w.evidence = evidence;
		w.routes = f;
		w.jobRoutes = jf;
		if (start) {
			job.startTrigger();
			await job.finishStartUp();
		}
		return job;
	};
	w.restart = (opts = {}) => w.boot(opts);
	// A load past every condition: its saved paid check passes for what the load looks like now.
	w.armed = async (id, over = {}, docEmail = BILLING) => {
		w.ready(id, over, docEmail);
		await w.paidOk(id);
	};
	w.paidOk = async (id, code = "") => {
		const load = await w.job.button.read(rules.loadKey(id));
		sendButton.saveCheck(w.db, rules.loadKey(id), { code, fingerprint: rules.fingerprintSha256(load.facts), nowIso: iso(w.now) });
	};
	w.state = (id, opts) => w.routes.call("GET", sendButton.PATHS.state, { params: { loadKey: id }, ...opts });
	w.preview = (id, opts) => w.routes.call("POST", sendButton.PATHS.preview, { params: { loadKey: id }, ...opts });
	w.press = (id, token, opts = {}) => w.routes.call("POST", sendButton.PATHS.send, { params: { loadKey: id }, body: { token }, ...opts });
	w.retry = (id) => w.jobRoutes.call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: id } });
	w.claim = (id) => w.db.prepare("SELECT * FROM auto_invoice_claims WHERE load_key = ?").get(rules.loadKey(id)) || null;
	w.st = (id) => {
		const c = w.claim(id);
		return c ? [c.state, c.reason_code] : null;
	};
	w.open = () => w.db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims WHERE state IN ('queued', 'working')").get().n;
	w.draftRows = (id) => w.db.prepare("SELECT invoice_id, via FROM load_invoice_drafts WHERE LOWER(TRIM(load_id)) IN (?, ?) ORDER BY id").all(rules.loadKey(id), `#${rules.loadKey(id)}`);
	// Every row of every table, to show a step wrote nothing.
	w.dump = () => JSON.stringify(w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => [t.name, w.db.prepare(`SELECT * FROM ${t.name}`).all()]));
	w.actions = (action) => w.audits.filter((a) => a.action === action);
	w.seed = (id, fields) => {
		ledger.ensureSchema(w.db);
		ledger.insertClaim(w.db, { key: rules.loadKey(id), loadId: id, state: fields.state, code: fields.reason_code || "", nowIso: iso(w.now - MIN) });
		const { state: _s, ...rest } = fields;
		const cols = Object.keys(rest);
		if (cols.length) w.db.prepare(`UPDATE auto_invoice_claims SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE load_key = ?`).run(...cols.map((c) => rest[c]), rules.loadKey(id));
	};
	// The moment of a preview and a press with nothing in between, then the run to its end.
	w.send = async (id, label) => {
		const p = await w.preview(id);
		eq(p.status, 200, `${label}: the preview goes through`);
		const r = await w.press(id, p.body && p.body.token);
		eq(r.status, 200, `${label}: the press goes through`);
		await until(() => w.open() === 0, `${label}: the run ended`);
		return { preview: p, press: r };
	};
	return w;
}

function markFactored(w, id) {
	factoring.ensureSchema(w.db);
	w.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES (?, ?, 1, 'person', ?, ?)").run(rules.loadKey(id), id, iso(w.now), iso(w.now));
}
function pressInFlight(w, id) {
	factoring.ensureSchema(w.db);
	w.db.prepare("INSERT INTO invoice_draft_inflight (load_key, load_id, invoice_id, path, state, started_at, updated_at) VALUES (?, ?, '10202026-77', 'imap', 'in_flight', ?, ?)")
		.run(rules.loadKey(id), id, iso(w.now), iso(w.now));
}
function markerUnreadable(w) {
	w.db.exec("CREATE VIEW load_factoring AS SELECT * FROM a_table_that_does_not_exist");
}
// What PUT /api/driver/status does around its sheet write (the route's own lines run in
// scripts/test-auto-invoice-wiring.js). `landed`: a write that failed still reached the sheet.
function tap(w, job, id, { fails = false, landed = false, readBack = null, oldStatus = "At Receiver" } = {}) {
	const start = job.driverDelivered({
		role: "Driver", loadId: id, oldStatus, newStatus: "Delivered",
		readBack: readBack || (async () => {
			const r = w.row(id);
			return r ? r["Job Status"] : "";
		}),
	});
	if (fails) {
		if (landed) w.setRow(id, { "Job Status": "Delivered" });
		let thrown = null;
		try {
			start.writeFailed(new Error("made-up: no answer in 15 seconds"));
		} catch (e) {
			thrown = e;
		}
		return { thrown };
	}
	w.setRow(id, { "Job Status": "Delivered" });
	start.written();
	return {};
}

let serial = 0;
const newId = () => `9000${String(10000 + ++serial).slice(-5)}`;

// Refused at the dialog: the status or the line says why, and nothing is read for it.
async function noButton(w, id, code, line, label) {
	const r = await w.state(id);
	eq([r.status, r.body && r.body.show, r.body && r.body.code, r.body && r.body.line], [200, false, code, line], `§3 ${label}`);
}

// §7's one shape: a press that won't be sent. `setup(w, id)` runs before the press; `afterPress`
// right after it commits. It ends where it began, its number given up, one notice, no mail.
async function backCase(label, { code, setup = null, afterPress = null, origin = null, number = false, smtp = 0, stopped = false, detail = null }) {
	const w = makeWorld();
	await w.boot();
	const id = newId();
	if (origin) w.seed(id, origin);
	await w.armed(id);
	const p = await w.preview(id);
	eq(p.status, 200, `§7 ${label}: the preview goes through (${JSON.stringify(p.body)})`);
	if (setup) setup(w, id);
	if (afterPress) w.afterPress = () => afterPress(w, id);
	const r = await w.press(id, p.body && p.body.token);
	eq(r.status, 200, `§7 ${label}: the press goes through (${JSON.stringify(r.body)})`);
	await until(() => w.open() === 0, `§7 ${label}: the run ended`);
	await turn();
	const c = w.claim(id);
	eq([c.state, c.reason_code], origin ? [origin.state, origin.reason_code] : ["baseline", ""], `§7 ${label}: back where it came from, never Needs attention with a new code`);
	eq([w.smtp.length, w.appends.length, w.gmail.length], [smtp, 0, 0], `§7 ${label}: ${smtp ? "one SMTP try, refused" : "no SMTP call"}, and never a Gmail draft`);
	eq([c.button_send_json, c.look_first, c.lease_owner, c.stage, c.delivery], ["", "", "", "", ""], `§7 ${label}: the press is gone from the claim`);
	const backs = w.actions("auto_invoice_button_back");
	eq(backs.map((a) => [a.who, a.id, a.details.split(/[ :]/)[0]]), [["auto-invoice", id, code]], `§7 ${label}: one audit row with the reason`);
	if (detail) ok(backs[0] && backs[0].details.includes(detail), `§7 ${label}: the audit row says what differed`);
	const notices = w.notices.filter((n) => n.title === "Invoice not sent");
	eq(notices.length, 1, `§7 ${label}: one notice`);
	ok(notices[0] && notices[0].body.includes(id) && notices[0].body.includes(sendButton.errorOf(code)), `§7 ${label}: the notice gives the load and the reason`);
	ok(sendButton.WHY[code], `§7 ${label}: ${code} has its own words`);
	eq(w.calls.mint, number ? 1 : 0, `§7 ${label}: ${number ? "a number was reserved" : "no number used"}`);
	eq([Boolean(c.number_voided_at), w.actions("auto_invoice_number_void").length], number ? [true, 1] : [false, 0], `§7 ${label}: ${number ? "its number given up, with an audit row" : "no number to give up"}`);
	eq(Boolean(ledger.getSendStop(w.db)), stopped, `§7 ${label}: ${stopped ? "the stop stays set" : "sending isn't stopped"}`);
	const retried = await w.retry(id);
	eq(retried.status, 409, `§7 ${label}: no Try again on it`);
	return w;
}

// Each §7 and §8 path, by what a person would see.
async function main() {
	section("§1  the flag");
	ok(sendButton, "§1 FAILS ON THE OLD CODE: lib/invoice-send-button.js exists");
	if (!sendButton) return;
	for (const [enabled, from, replica, want, label] of [
		[undefined, FROM, false, false, "the flag unset"],
		["", FROM, false, false, "the flag blank"],
		["false", FROM, false, false, "false"],
		["TRUE", FROM, false, false, "TRUE"],
		["1", FROM, false, false, "1"],
		["yes", FROM, false, false, "yes"],
		["true", undefined, false, false, "CHR_SEND_BUTTON_FROM unset gives no button"],
		["true", "", false, false, "CHR_SEND_BUTTON_FROM blank"],
		["true", "10/01/2026", false, false, "CHR_SEND_BUTTON_FROM not a day"],
		["true", "2026-02-30", false, false, "CHR_SEND_BUTTON_FROM a day that doesn't exist"],
		["true", FROM, true, false, "a replica"],
		["true", FROM, false, true, "exactly \"true\", with a day"],
		[" true ", FROM, false, true, "spaces around it read as the app's other flags read them"],
	]) {
		eq(sendButton.readSettings({ CHR_SEND_BUTTON_ENABLED: enabled, CHR_SEND_BUTTON_FROM: from }, { replica }).on, want, `§1 ${label}: ${want ? "on" : "off"}`);
	}
	{
		const flag = { CHR_SEND_BUTTON_ENABLED: "true", CHR_SEND_BUTTON_FROM: FROM };
		const real = { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false" };
		const on = { env: { ...real, ...flag } };
		const w = makeWorld();
		eq(jobLib.create(w.deps(on)).button.on, true, "§1 the job: the trigger, sending and the flag on");
		eq(jobLib.create(w.deps({ env: { ...real, ...flag, AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" } })).button.on, false, "§1 ...the driver's trigger off: off");
		eq(jobLib.create(w.deps({ env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", ...flag } })).button.on, false, "§1 ...shadow mode: off");
		eq(jobLib.create(w.deps({ env: { ...flag } })).button.on, false, "§1 ...the job off: off");
		eq(jobLib.create(w.deps({ ...on, send: { enabled: false, domains: [] } })).button.on, false, "§1 ...sending off: off");
		eq(jobLib.create(w.deps({ ...on, sendMail: undefined })).button.on, false, "§1 ...no sender: off");
		eq(jobLib.create(w.deps({ ...on, replica: true })).button.on, false, "§1 ...a replica: off");
		eq(jobLib.create(w.deps({ env: { ...real, CHR_SEND_BUTTON_FROM: FROM } })).button.on, false, "§1 ...the flag off: off");
		eq(jobLib.create(w.deps({ env: { ...real, CHR_SEND_BUTTON_ENABLED: "true" } })).button.on, false, "§1 ...CHR_SEND_BUTTON_FROM unset: off");
		eq(jobLib.create(w.deps({})).button.on, false, "§1 ...no setting at all: off");
	}
	{
		const w = makeWorld();
		await w.boot({ on: false });
		const id = newId();
		w.ready(id);
		await w.paidOk(id);
		const before = JSON.stringify(w.calls);
		const dumpBefore = w.dump();
		const tables = () => w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
		const had = tables();
		for (const user of [SA, { id: 2, username: "made-up-dispatcher", role: "Dispatcher" }, null]) {
			const state = await w.state(id, { user });
			const prev = await w.preview(id, { user });
			const send = await w.press(id, "made-up", { user });
			eq([state.fell, prev.fell, send.fell, state.body, prev.body, send.body], [true, true, true, null, null, null], `§1 flag off, ${user ? user.role : "no session"}: all three routes go on as if they weren't there, before the role check`);
		}
		eq(w.limited, 0, "§1 flag off: nothing reaches the rate limiter");
		eq([w.claim(id), JSON.stringify(w.calls) === before, w.audits.length, w.smtp.length, w.appends.length], [null, true, 0, 0, 0], "§1 flag off: no claim, no read, no search, no paid call, no audit row, no mail");
		const readsBefore = w.calls.reads;
		eq(await w.btn.runPaidChecks(), { checked: 0, temporary: 0 }, "§1 flag off: the paid check does nothing");
		eq([w.calls.prepare, w.calls.reads - readsBefore, tables(), w.dump() === dumpBefore], [0, 0, had, true], "§1 ...no paid call, not even a read of the sheet, no table made, and no row of any table changed");
		ok(!w.btn.on, "§1 ...and the store says off");
		eq(w.job.status().button, undefined, "§1 ...and the job's status doesn't mention it");
	}
	{
		// The paid check's table waits for its first write, so a deploy with the flag off leaves none.
		const w = makeWorld();
		await w.boot({ on: false });
		const has = w.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(sendButton.CHECKS_TABLE);
		ok(!has, "§1 no paid-check table until something writes it");
		eq(ledger.getClaim(w.db, "900000001"), null, "§1 and a start-up makes no claim");
	}

	section("§2  who");
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		for (const user of [{ id: 2, username: "made-up-dispatcher", role: "Dispatcher" }, { id: 3, username: "made-up-driver", role: "Driver" }, { id: 4, username: "made-up-investor", role: "Investor" }]) {
			const answers = [await w.state(id, { user }), await w.preview(id, { user }), await w.press(id, "made-up", { user })];
			eq(answers.map((a) => a.status), [403, 403, 403], `§2 ${user.role}: refused on every route`);
		}
		eq((await w.state(id, { user: null })).status, 401, "§2 no session: refused");
		eq([w.limited, w.claim(id), w.calls.look.length, w.calls.prepare], [0, null, 0, 0], "§2 ...before the rate limiter, with nothing read");
		w.crossSiteRefuses = true;
		eq([(await w.preview(id)).status, (await w.press(id, "made-up")).status, w.limited, w.calls.look.length], [403, 403, 0, 0], "§2 a cross-site write: refused before anything runs");
		w.crossSiteRefuses = false;
		w.limitRefuses = true;
		eq([(await w.preview(id)).status, (await w.press(id, "made-up")).status, w.calls.look.length, w.calls.prepare], [429, 429, 0, 0], "§2 over the rate limit: refused before anything runs");
		eq((await w.state(id)).status, 200, "§2 the free read isn't rate limited");
	}

	section("§3  when it shows");
	{
		const w = makeWorld();
		await w.boot();
		let id = newId();
		await w.armed(id);
		eq((await w.state(id)).body, { show: true }, "§3 FAILS ON THE OLD CODE: a load past every condition shows the button");
		const free = [w.calls.look.length, w.calls.prepare, w.calls.mint, w.claim(id)];
		eq(free, [0, 0, 0, null], "§3 the read is free: no mailbox, no paid call, no number, no claim");

		const line = (code) => `Handle by hand: ${sendButton.WHY[code]}`;
		const armed = async (over, opts = {}) => {
			const x = newId();
			await w.armed(x, over, opts.docEmail);
			return x;
		};
		// The row's own claim, each of the three that may show it.
		id = await armed();
		w.seed(id, { state: "baseline" });
		eq((await w.state(id)).body, { show: true }, "§3 a baseline claim shows it");
		id = await armed();
		w.seed(id, { state: "needs_attention", reason_code: "OFF_GAP" });
		eq((await w.state(id)).body, { show: true }, "§3 an OFF_GAP claim shows it");
		id = await armed();
		w.seed(id, { state: "waiting", reason_code: "NOT_COMPLETED" });
		await noButton(w, id, "CLAIM_NOT_OPEN", line("CLAIM_NOT_OPEN"), "a claim left waiting (a tap's failed write): no button, one line");
		id = await armed();
		w.seed(id, { state: "skipped", reason_code: "BROKER_OPTED_OUT" });
		await noButton(w, id, "CLAIM_NOT_OPEN", line("CLAIM_NOT_OPEN"), "a skipped claim: no button, one line");
		id = await armed();
		w.seed(id, { state: "needs_attention", reason_code: "TOTAL_MISMATCH" });
		await noButton(w, id, "NOT_NONE_FOUND", "", "a load in Needs attention: its status says why, and Try again is its way on");
		id = await armed();
		w.seed(id, { state: "queued" });
		await noButton(w, id, "NOT_NONE_FOUND", "", "a load in line: its status says why");
		id = await armed();
		w.seed(id, { state: "drafted", delivery: "send", stage: "recorded", invoice_id: "10202026-40" });
		await noButton(w, id, "NOT_NONE_FOUND", "", "a load LogisX sent: its status says why");

		// What the status reads, from the rows and the evidence.
		id = await armed();
		w.handDraft(id);
		await noButton(w, id, "NOT_NONE_FOUND", "", "a draft row on file");
		id = await armed();
		pressInFlight(w, id);
		await noButton(w, id, "NOT_NONE_FOUND", "", "a press row in flight");
		id = await armed();
		evidenceLib.savePayments(w.db, rules.loadKey(id), { payments_invoice_number: 1 }, { nowIso: iso(w.now) });
		await noButton(w, id, "NOT_NONE_FOUND", "", "R-H2 (c): the saved Payments Table row is filled");
		id = await armed();
		w.searched(id, { answer: { verdict: "invoice", mailboxes: { drafts: box(), sent: box({ invoice: 1 }) } } });
		await noButton(w, id, "NOT_NONE_FOUND", "", "an invoice saved from Sent Mail");
		id = await armed();
		w.searched(id, { answer: { verdict: "invoice", mailboxes: { drafts: box({ invoice: 1 }), sent: box() } } });
		await noButton(w, id, "NOT_NONE_FOUND", "", "an invoice saved from Drafts");
		id = await armed();
		w.searched(id, { answer: { verdict: "mention", mailboxes: { drafts: box(), sent: box({ mention: 1 }) } } });
		await noButton(w, id, "NOT_NONE_FOUND", "", "a mention: doubt");
		id = newId();
		w.setRow(id);
		w.addPod(id);
		await noButton(w, id, "NOT_NONE_FOUND", "", "never searched");
		id = await armed();
		evidenceLib.saveFailure(w.db, rules.loadKey(id), { nowIso: iso(w.now) });
		await noButton(w, id, "NOT_NONE_FOUND", "", "the last search failed");
		id = await armed();
		w.searched(id, { at: w.now - 7 * DAY });
		await w.paidOk(id);
		await noButton(w, id, "SEARCH_STALE", line("SEARCH_STALE"), "searched 7 days ago: not within 7 days");
		id = await armed();
		w.searched(id, { at: w.now - 7 * DAY + MIN });
		await w.paidOk(id);
		eq((await w.state(id)).body, { show: true }, "§3 ...a minute inside 7 days: shows");
		id = await armed({ "Job Status": "At Receiver" });
		await noButton(w, id, "NOT_DELIVERED", line("NOT_DELIVERED"), "not Delivered");
		await noButton(w, newId(), "NOT_DELIVERED", line("NOT_DELIVERED"), "a load not on the sheet");
		id = await armed({ "Job Status": "Cancelled" });
		await noButton(w, id, "NOT_DELIVERED", line("NOT_DELIVERED"), "cancelled");
		id = await armed();
		w.db.prepare("INSERT INTO deleted_loads (load_id) VALUES (?)").run(id);
		await noButton(w, id, "NOT_DELIVERED", line("NOT_DELIVERED"), "soft-deleted");

		// The status can't stand in for its own second check.
		{
			const s = makeWorld();
			s.statusStub = { status: "none_found", searchedAt: iso(s.now) };
			await s.boot();
			let x = newId();
			await s.armed(x);
			s.handDraft(x);
			await noButton(s, x, "DRAFT_ROW", line("DRAFT_ROW"), "a draft row, with a status that missed it");
			x = newId();
			await s.armed(x);
			pressInFlight(s, x);
			await noButton(s, x, "PRESS_ROW", line("PRESS_ROW"), "a press row, with a status that missed it");
			x = newId();
			await s.armed(x);
			s.seed(x, { state: "baseline", button_send_json: "{}" });
			await noButton(s, x, "CLAIM_NOT_OPEN", line("CLAIM_NOT_OPEN"), "a baseline claim already holding a press");
			x = newId();
			await s.armed(x);
			s.seed(x, { state: "baseline", delivery: "send", stage: "appending" });
			await noButton(s, x, "CLAIM_NOT_OPEN", line("CLAIM_NOT_OPEN"), "a claim whose send started, whatever its state says");
			s.statusStub.status = "by_hand";
			x = newId();
			await s.armed(x);
			await noButton(s, x, "NOT_NONE_FOUND", "", "any other status");
			s.statusStub.status = "none_found";
			s.statusStub.searchedAt = "";
			await noButton(s, x, "SEARCH_STALE", line("SEARCH_STALE"), "no search time, with a status that says none found");
		}

		// The date.
		id = await armed({ "Status Update Date": "10/01/2026 9:00:00", "Completion Date": "10/01/2026 9:00:00" });
		eq((await w.state(id)).body, { show: true }, "§3 delivered on the start date: shows");
		id = await armed({ "Status Update Date": "09/30/2026 9:00:00", "Completion Date": "09/30/2026 9:00:00" });
		await noButton(w, id, "BEFORE_START_DATE", line("BEFORE_START_DATE"), "delivered the day before it");
		id = await armed({ "Status Update Date": "10/20/2026 9:00:00", "Completion Date": "09/20/2026 9:00:00" });
		await noButton(w, id, "BEFORE_START_DATE", line("BEFORE_START_DATE"), "a status touched later doesn't make an old load new");
		id = await armed({ "Status Update Date": "", "Completion Date": "" });
		await noButton(w, id, "NO_DELIVERY_DATE", line("NO_DELIVERY_DATE"), "no date: no button");
		id = await armed({ "Status Update Date": "10/20/2026 9:00:00", "Completion Date": "soon" });
		await noButton(w, id, "NO_DELIVERY_DATE", line("NO_DELIVERY_DATE"), "a date that can't be read isn't left out: no button");
		id = await armed({ "Status Update Date": "", "Completion Date": "10/20/2026 9:00:00" });
		await noButton(w, id, "NO_DELIVERY_DATE", line("NO_DELIVERY_DATE"), "the delivery-date column blank: no button, as the job's own check");

		// The broker.
		id = await armed({ Email: "" });
		await noButton(w, id, "EMAIL_BLANK", line("EMAIL_BLANK"), "R-H2 (a): a blank Email cell");
		id = await armed({ Email: "ops@example-broker.test" }, { docEmail: "billing@example-broker.test" });
		await noButton(w, id, "NOT_CHR_EMAIL", line("NOT_CHR_EMAIL"), "another broker");
		id = await armed({ Email: "made-up.ops@loads.chrobinson.com" }, { docEmail: "made-up.billing@loads.chrobinson.com" });
		await noButton(w, id, "NOT_CHR_EMAIL", line("NOT_CHR_EMAIL"), "a subdomain isn't chrobinson.com");
		id = await armed({ Email: "made-up.ops@notchrobinson.com" });
		await noButton(w, id, "NOT_CHR_EMAIL", line("NOT_CHR_EMAIL"), "a lookalike isn't chrobinson.com");
		id = await armed({ Email: "not an address" });
		await noButton(w, id, "NOT_CHR_EMAIL", line("NOT_CHR_EMAIL"), "a malformed cell isn't blank");

		// The load's own number.
		for (const [shape, label] of [["90000001", "8 digits"], ["9000000011", "10 digits"], ["LD-TEST-0001", "not digits"], ["90000000A", "a letter in it"]]) {
			await w.armed(shape);
			await noButton(w, shape, "LOAD_ID_SHAPE", line("LOAD_ID_SHAPE"), `a Load ID of ${label}`);
		}
		const hashed = `#${newId()}`;
		await w.armed(hashed);
		eq((await w.state(hashed)).body, { show: true }, "§3 a leading # is still CHR's shape");
		await w.send(hashed, "§3 a leading #");
		eq([w.st(hashed), w.smtp.filter((m) => m.subject.endsWith(hashed.slice(1))).length], [["drafted", ""], 1], "§3 ...and it goes, under the one key");

		// The PODs.
		id = newId();
		w.setRow(id);
		w.rateCons.set(rules.loadKey(id), BILLING);
		w.searched(id);
		await w.paidOk(id);
		await noButton(w, id, "NO_POD", line("NO_POD"), "no POD");
		id = newId();
		w.setRow(id);
		w.addPod(id, { file: false });
		w.rateCons.set(rules.loadKey(id), BILLING);
		w.searched(id);
		await w.paidOk(id);
		await noButton(w, id, "POD_UNREADABLE", line("POD_UNREADABLE"), "a POD file missing from disk");
		id = await armed();
		w.addPod(id, { at: "not a time" });
		await w.paidOk(id);
		await noButton(w, id, "POD_TIME_UNKNOWN", line("POD_TIME_UNKNOWN"), "a POD time that can't be read");
		id = await armed();
		w.addPod(id, { at: "2026-10-20 14:30:00" });
		await w.paidOk(id);
		await noButton(w, id, "POD_TIME_UNKNOWN", line("POD_TIME_UNKNOWN"), "a POD time ahead of the clock");

		// The rest of the sheet and the lines.
		id = await armed({ "  Payment  ": "$1,000 + $50" });
		await noButton(w, id, "PAYMENT_NOT_PLAIN", line("PAYMENT_NOT_PLAIN"), "Payment isn't one amount");
		id = await armed({ "  Payment  ": "" });
		await noButton(w, id, "PAYMENT_NOT_PLAIN", line("PAYMENT_NOT_PLAIN"), "Payment blank");
		id = await armed({ "  Payment  ": "$0.00" });
		await noButton(w, id, "PAYMENT_NOT_PLAIN", line("PAYMENT_NOT_PLAIN"), "Payment nothing");
		id = await armed();
		w.db.prepare("INSERT INTO broker_invoice_lines (load_id, load_key) VALUES (?, ?)").run(id, rules.loadKey(id));
		await w.paidOk(id);
		await noButton(w, id, "ADVANCE_LINES", line("ADVANCE_LINES"), "advance lines");
		id = await armed();
		w.closed = (row) => (row["Load ID"] === id ? ["2026-09"] : []);
		await noButton(w, id, "CLOSED_MONTH", line("CLOSED_MONTH"), "a closed month");
		w.closed = (row) => (row["Load ID"] === id ? null : []);
		await noButton(w, id, "MONTH_UNKNOWN", line("MONTH_UNKNOWN"), "a month that can't be told");
		w.closed = () => [];

		// The saved paid check.
		id = newId();
		w.ready(id);
		await noButton(w, id, "PAID_CHECK_PENDING", line("PAID_CHECK_PENDING"), "the paid check hasn't run");
		await w.paidOk(id, "TOTAL_MISMATCH");
		await noButton(w, id, "TOTAL_MISMATCH", line("TOTAL_MISMATCH"), "the paid check's own refusal, in its own words");
		await w.paidOk(id, "");
		w.setRow(id, { "  Payment  ": "$1,100.00" });
		await noButton(w, id, "PAID_CHECK_PENDING", line("PAID_CHECK_PENDING"), "a load changed since its paid check: not checked yet");

		// The marker.
		id = await armed();
		markFactored(w, id);
		await noButton(w, id, "FACTORED", line("FACTORED"), "marked factored");
		{
			const m = makeWorld();
			await m.boot();
			const x = newId();
			await m.armed(x);
			markerUnreadable(m);
			await noButton(m, x, "FACTORING_UNREADABLE", line("FACTORING_UNREADABLE"), "a marker that can't be read");
			eq([(await m.preview(x)).status, m.calls.look.length, m.calls.prepare], [409, 0, 0], "§3 ...and the preview stops there");
		}

		// Not about this load: no button, no line.
		{
			const x = makeWorld();
			await x.boot();
			const a = newId();
			await x.armed(a);
			const quiet = async (code, label) => {
				await noButton(x, a, code, "", label);
				const p = await x.preview(a);
				eq([p.status, p.body.code, x.calls.look.length, x.calls.prepare], [409, code, 0, 0], `§3 ${label}: the preview stops there too, with its reason`);
				ok(typeof p.body.error === "string" && p.body.error.length > 3, `§3 ${label}: ...in one line`);
			};
			ledger.setSendStop(x.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(x.now) });
			await quiet("STOPPED", "the Stop");
			ledger.clearSendStop(x.db);
			x.mailbox = { user: "", pass: "" };
			await quiet("NO_MAILBOX", "no mailbox");
			x.mailbox = MAILBOX;
			x.meta("paused_until", iso(x.now + HOUR));
			await quiet("MAILBOX_PAUSED", "the login pause");
			x.meta("paused_until", "");
			x.db.prepare("UPDATE app_settings SET value = 'not json' WHERE key = 'auto_invoice.settings'").run();
			await quiet("SETTINGS_UNREADABLE", "unreadable settings");
			x.confirmed(["chrobinson.com"]);
			x.env.AUTO_INVOICE_MAX_PER_HOUR = "1";
			await x.restart();
			x.seed(newId(), { state: "drafted", drafted_at: iso(x.now - MIN) });
			await quiet("CAP_REACHED", "the hourly cap");
		}
		{
			const x = makeWorld();
			await x.boot({ start: false });
			const a = newId();
			await x.armed(a);
			await noButton(x, a, "JOB_NOT_STARTED", "", "a process that may not run jobs");
		}
		{
			const x = makeWorld();
			await x.boot();
			const a = newId();
			await x.armed(a);
			x.confirmed([]);
			await noButton(x, a, "CHR_NOT_CONFIRMED", line("CHR_NOT_CONFIRMED"), "chrobinson.com not confirmed");
			x.confirmed(["chrobinson.com"], ["chrobinson.com"]);
			await noButton(x, a, "CHR_OPTED_OUT", line("CHR_OPTED_OUT"), "chrobinson.com opted out");
			x.confirmed(["chrobinson.com"]);
			x.sendDomains = ["example-broker.test"];
			await x.restart();
			await noButton(x, a, "CHR_NOT_LISTED", line("CHR_NOT_LISTED"), "chrobinson.com not on the send list");
		}
		// The status itself can't be read.
		{
			const x = makeWorld();
			x.statusStub = { status: "none_found", searchedAt: iso(x.now) };
			await x.boot();
			const a = newId();
			await x.armed(a);
			x.statusThrows = true;
			await noButton(x, a, "EVIDENCE_UNREADABLE", line("EVIDENCE_UNREADABLE"), "a status that can't be read: no button");
			eq([(await x.preview(a)).body.code, x.calls.look.length, x.calls.prepare], ["EVIDENCE_UNREADABLE", 0, 0], "§3 ...and the preview stops there");
		}
		{
			const x = makeWorld();
			await x.boot();
			const a = newId();
			await x.armed(a);
			const y = sendButton.create({ job: x.job, evidence: { statusReader: () => { throw Object.assign(new Error("made-up"), { code: "MADE_UP" }); } }, db: x.db, log: { warn() {}, error() {} } });
			const f = fakeApp();
			y.mount(f.app, { requireRole });
			const r = await f.call("GET", sendButton.PATHS.state, { params: { loadKey: a } });
			eq([r.body.show, r.body.code], [false, "EVIDENCE_UNREADABLE"], "§3 the app's own rows that can't be read: no button");
		}
		{
			const x = makeWorld();
			await x.boot({ job: { dayKeyOf: () => { throw new Error("made-up"); } } });
			const a = newId();
			x.ready(a);
			await noButton(x, a, "NO_DELIVERY_DATE", line("NO_DELIVERY_DATE"), "a date reader that throws: no date");
		}
		// The load's own conditions on their own, as the run asks them too: each one alone says no.
		{
			const good = {
				facts: { onSheet: true, completed: true, live: true, hasDeliveryDate: true, brokerDomain: "chrobinson.com", brokerDomainConfirmed: true, optedOut: false, loadId: "#900000001", factored: false, pods: 1, podsUnreadable: 0, activeAdvanceLines: 0, paymentCents: 100000, closedMonths: [] },
				fromDay: FROM, deliveredDay: "2026-10-20", emailBlank: false, sendDomains: ["chrobinson.com"], podTimes: ["2026-10-20T13:00:00Z"], nowMs: T0,
			};
			eq(sendButton.loadRefusal(good), null, "§3 loadRefusal: a load with nothing against it");
			const withFacts = (over) => ({ ...good, facts: { ...good.facts, ...over } });
			for (const [label, load, code] of [
				["nothing known", {}, "NOT_DELIVERED"],
				["off the sheet", withFacts({ onSheet: false }), "NOT_DELIVERED"],
				["not completed", withFacts({ completed: false }), "NOT_DELIVERED"],
				["not live", withFacts({ live: false }), "NOT_DELIVERED"],
				["no day", { ...good, deliveredDay: "" }, "NO_DELIVERY_DATE"],
				["no delivery cell", withFacts({ hasDeliveryDate: false }), "NO_DELIVERY_DATE"],
				["no start date", { ...good, fromDay: "" }, "BEFORE_START_DATE"],
				["before it", { ...good, deliveredDay: "2026-09-30" }, "BEFORE_START_DATE"],
				["a blank Email", { ...good, emailBlank: true }, "EMAIL_BLANK"],
				["another domain", withFacts({ brokerDomain: "example-broker.test" }), "NOT_CHR_EMAIL"],
				["a subdomain", withFacts({ brokerDomain: "loads.chrobinson.com" }), "NOT_CHR_EMAIL"],
				["unconfirmed", withFacts({ brokerDomainConfirmed: false }), "CHR_NOT_CONFIRMED"],
				["not listed", { ...good, sendDomains: ["example-broker.test"] }, "CHR_NOT_LISTED"],
				["opted out", withFacts({ optedOut: true }), "CHR_OPTED_OUT"],
				["the wrong shape", withFacts({ loadId: "LD-TEST-0001" }), "LOAD_ID_SHAPE"],
				["factored", withFacts({ factored: true }), "FACTORED"],
				["no POD", withFacts({ pods: 0 }), "NO_POD"],
				["a POD unreadable", withFacts({ podsUnreadable: 1 }), "POD_UNREADABLE"],
				["no POD time", { ...good, podTimes: [] }, "POD_TIME_UNKNOWN"],
				["a POD time ahead", { ...good, podTimes: ["2026-10-20T14:01:00Z"] }, "POD_TIME_UNKNOWN"],
				["advance lines", withFacts({ activeAdvanceLines: 1 }), "ADVANCE_LINES"],
				["Payment not plain", withFacts({ paymentCents: null }), "PAYMENT_NOT_PLAIN"],
				["Payment negative", withFacts({ paymentCents: -100 }), "PAYMENT_NOT_PLAIN"],
				["a month unknown", withFacts({ closedMonths: null }), "MONTH_UNKNOWN"],
				["a month closed", withFacts({ closedMonths: ["2026-09"] }), "CLOSED_MONTH"],
			]) {
				eq(sendButton.loadRefusal(load), code, `§3 loadRefusal: ${label}`);
			}
		}
		// The answers around the conditions.
		{
			const x = makeWorld();
			await x.boot();
			const a = newId();
			await x.armed(a);
			x.readFails = true;
			const down = [await x.state(a), await x.preview(a)];
			eq(down.map((r) => [r.status, r.body.code]), [[503, "SHEET_UNAVAILABLE"], [503, "SHEET_UNAVAILABLE"]], "§3 the sheet down: 503, no button, nothing done");
			x.readFails = false;
			eq([(await x.state("  ")).status, (await x.preview("  ")).status, (await x.press("  ", "t")).status], [400, 400, 400], "§3 a blank load key: 400");
			eq((await x.state("x".repeat(101))).status, 400, "§3 a load key too long: 400");
		}
	}

	section("§4  the preview");
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const invalidatedBefore = w.invalidated;
		const dumpBefore = w.dump();
		const p = await w.preview(id);
		eq(p.status, 200, "§4 FAILS ON THE OLD CODE: the preview answers");
		ok(w.dump() === dumpBefore, "§4 no table's row changed (the real search's own answer may refresh the saved row, and nothing else may)");
		eq({ ...p.body, token: typeof p.body.token }, {
			ok: true,
			token: "string",
			expiresAt: iso(w.now + sendButton.TOKEN_MS),
			loadId: id,
			amount: "$1,000.00",
			to: BILLING,
			nextInvoiceId: "10202026-1",
			attachments: [`C.H. Robinson Invoice Order #${id}.pdf`, `${id}_POD.pdf`, `${id}.pdf`],
			words: "The company mailbox was searched just now: nothing found. This goes to C.H. Robinson now and can't be recalled.",
		}, "§4 the confirm: load, the server's amount, the recipient, each attachment, the next number, the words");
		eq(w.timeline, ["payments", "look", "prepare", "render"], "§4 the Payments Table and the mailbox before any paid call, and no number minted");
		eq(w.calls.look[0], { user: MAILBOX.user, pass: MAILBOX.pass, loadNumber: id, invoiceNumbers: [], orderNumbers: [], lastCheck: true, includeTrash: true }, "§4 Drafts, Sent Mail and Trash, by subject too, and not `quiet`, so a live answer refreshes the saved row");
		eq([w.calls.mint, w.calls.peek], [0, 1], "§4 the number is peeked, never reserved");
		eq([w.claim(id), w.draftRows(id), w.audits.length, w.notices.length, w.smtp.length, w.appends.length], [null, [], 0, 0, 0, 0], "§4 it writes nothing: no claim, no row, no audit row, no notice, no mail");
		ok(w.invalidated > invalidatedBefore, "§4 it reads the sheet fresh");
		const again = await w.preview(id);
		eq([again.status, again.body.nextInvoiceId], [200, "10202026-1"], "§4 a second preview burns no number");
		ok(again.body.token !== p.body.token, "§4 ...and has its own token");
		const stale = await w.press(id, p.body.token);
		eq([stale.status, stale.body.code, w.claim(id)], [409, "BUTTON_PREVIEW_AGAIN", null], "§4 ...the newer confirm is the one that counts");
	}
	for (const [label, setup, code] of [
		["R-H2 (c): a filled Payments Table row", (w, id) => w.payments.push([id, "", "", "INV-MADE-UP", "", ""]), "PAYMENTS_TABLE_HIT"],
		["R-H2 (c): a Payments Table that can't be read", (w) => { w.paymentsFail = true; }, "PAYMENTS_UNREAD"],
		["a Payments Table missing its columns", (w) => { w.payments = [["Job", "Other"]]; }, "PAYMENTS_UNREAD"],
		["an invoice in the mailbox", (w) => { w.lookAnswer = { verdict: "invoice", mailboxes: { drafts: box(), sent: box({ invoice: 1 }) } }; }, "MAILBOX_HIT"],
		["a mention in the mailbox", (w) => { w.lookAnswer = { verdict: "mention", mailboxes: { drafts: box(), sent: box({ mention: 1 }) } }; }, "MAILBOX_HIT"],
		["a failed search", (w) => { w.lookFails = true; }, "MAILBOX_UNREAD"],
		["an answer that can't be read", (w) => { w.lookAnswer = { verdict: "what" }; }, "MAILBOX_UNREAD"],
	]) {
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		setup(w, id);
		const p = await w.preview(id);
		eq([p.status, p.body.code, p.body.error, p.body.token], [409, code, sendButton.errorOf(code), undefined], `§4 FAILS ON THE OLD CODE: ${label}: no confirm, the reason in one line`);
		eq([w.calls.prepare, w.calls.render, w.calls.peek, w.calls.mint], [0, 0, 0, 0], `§4 ${label}: stopped before any paid call or number`);
		eq([w.claim(id), w.audits.length], [null, 0], `§4 ${label}: nothing written`);
	}
	for (const [label, setup, code, paid] of [
		["the rate con's total differs", (w) => { w.prepareHook = async () => ({ ok: false, http: 422, code: "TOTAL_MISMATCH" }); }, "TOTAL_MISMATCH", [1, 0]],
		["no rate con by name", (w) => { w.prepareHook = async () => ({ ok: false, http: 422, code: "RATECON_MISSING" }); }, "RATECON_MISSING", [1, 0]],
		["the billing address off the domain", (w, id) => w.rateCons.set(rules.loadKey(id), "billing@example-other.test"), "RECIPIENT_DOMAIN_MISMATCH", [1, 0]],
		["the engine throws", (w) => { w.prepareHook = async () => { throw new Error("made-up"); }; }, "RETRY_LATER", [1, 0]],
		["the renderer busy", (w) => { w.renderHook = async () => { throw Object.assign(new Error("made-up"), { code: "RENDERER_BUSY" }); }; }, "RENDERER_BUSY", [1, 1]],
		["the render throws", (w) => { w.renderHook = async () => { throw new Error("made-up"); }; }, "RETRY_LATER", [1, 1]],
		["the render's own recipient", (w) => { w.renderOver = (out) => ({ ...out, to: "billing@example-other.test" }); }, "RECIPIENT_DOMAIN_MISMATCH", [1, 1]],
		["the outgoing check", (w) => { w.renderOver = (out) => ({ ...out, attachments: out.attachments.slice(0, 2) }); }, "SEND_REFUSED", [1, 1]],
		["an invoice whose text can't be read back", (w) => { w.renderOver = (out) => ({ ...out, attachments: [{ ...out.attachments[0], content: Buffer.from("%PDF-1.4 no text") }, ...out.attachments.slice(1)] }); }, "DIGEST_UNREADABLE", [1, 1]],
	]) {
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		setup(w, id);
		const p = await w.preview(id);
		eq([p.status, p.body.code, p.body.token], [409, code, undefined], `§4 ${label}: no confirm, the reason in one line`);
		eq([w.calls.prepare, w.calls.render], paid, `§4 ${label}: where it stopped`);
		eq([w.calls.mint, w.claim(id), w.smtp.length], [0, null, 0], `§4 ${label}: no number, no claim, no mail`);
	}
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		w.geminiDownAt = w.now - MIN;
		const p = await w.preview(id);
		eq([p.status, p.body.code, w.calls.look.length, w.calls.prepare], [409, "GEMINI_DOWN", 0, 0], "§4 the rate-con reader down: no search and no paid call for nothing");
		w.geminiDownAt = null;

		// One preview of a load at a time, and it checks again after its last wait.
		const hold = gate();
		w.lookHook = () => hold.p;
		const first = w.preview(id);
		await until(() => w.calls.look.length === 1, "§4 the first preview is searching");
		const second = await w.preview(id);
		eq([second.status, second.body.code], [409, "BUTTON_PREVIEW_BUSY"], "§4 a second preview of the same load while one runs: refused");
		w.handDraft(id);
		hold.open();
		const done = await first;
		eq([done.status, done.body.code, done.body.token], [409, "NOT_NONE_FOUND", undefined], "§4 a hand draft during the preview: no confirm, read after the last wait");
		w.lookHook = null;
	}

	section("§5  the press");
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		const invalidatedBefore = w.invalidated;
		w.timeline = [];
		const r = await w.press(id, p.body.token);
		eq([r.status, r.body], [200, { ok: true, loadId: id }], "§5 FAILS ON THE OLD CODE: the press is taken");
		eq(w.timeline, [], "§5 nothing happens before the answer: the run starts after it");
		const queued = w.claim(id);
		eq([queued.state, queued.reason_code, queued.look_first !== ""], ["queued", "", true], "§5 one conditional update: queued, with the look asked for on the claim");
		const record = JSON.parse(queued.button_send_json);
		eq([record.by, record.byId, record.at, record.from], ["made-up-admin", 7, iso(w.now), { state: "baseline", code: "" }], "§5 who, when, where it came from");
		eq(w.actions("auto_invoice_button_press").map((a) => [a.who, a.id]), [["made-up-admin", id]], "§5 one audit row naming the account");
		ok(w.invalidated > invalidatedBefore, "§5 the run reads the sheet fresh");
		await until(() => w.open() === 0, "§5 the run");
		const c = w.claim(id);
		eq([c.state, c.reason_code, c.stage, c.delivery, c.look_first], ["drafted", "", "recorded", "send", ""], "§5 FAILS ON THE OLD CODE: sent");
		eq(w.timeline, ["payments", "look", "prepare", "mint", "render", "smtp", "record"], "§5 the run's order: the look, the paid read, the number, the render, SMTP, the row");
		eq(w.smtp.map((m) => [m.to, m.attachments]), [[BILLING, [`C.H. Robinson Invoice Order #${id}.pdf`, `${id}_POD.pdf`, `${id}.pdf`]]], "§5 one SMTP call: the invoice, every POD, the rate con, to the one recipient");
		eq([w.appends.length, w.draftRows(id).map((x) => x.via), w.actions("auto_invoice_sent").length], [0, ["auto-smtp"], 1], "§5 no Gmail draft; the job's own row and audit trail");
		eq(c.invoice_id, "10202026-1", "§5 it carries the number the confirm showed, when nothing else took it");
		eq([w.calls.look[1].includeTrash, w.calls.look[1].lastCheck, w.calls.look[1].quiet], [true, true, undefined], "§5 the run's own look: Trash and by subject too, and a live answer refreshes the saved row");
		eq([w.calls.failedNotes.length, w.notices.filter((n) => n.title === "Invoice not sent").length], [0, 0], "§5 no failure to note");
	}
	{
		// Another invoice took the peeked number: it carries the next one, as the confirm says it may.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		w.calls.mint = 4;
		await w.press(id, p.body.token);
		await until(() => w.open() === 0, "§5 the run");
		eq([p.body.nextInvoiceId, w.claim(id).invoice_id, w.smtp.length], ["10202026-1", "10202026-5", 1], "§5 the number is the next in sequence, not reserved, and the digest masks it");
	}
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		let p = await w.preview(id);
		for (const [label, token] of [["no token", undefined], ["a wrong token", "made-up"], ["a token of the wrong type", { a: 1 }]]) {
			const r = await w.press(id, token);
			eq([r.status, r.body.code, w.claim(id), w.actions("auto_invoice_button_press").length], [409, "BUTTON_PREVIEW_AGAIN", null, 0], `§5 ${label}: refused, nothing moves`);
		}
		const other = await w.press(id, p.body.token, { user: SA2 });
		eq([other.status, other.body.code, w.claim(id)], [409, "BUTTON_PREVIEW_AGAIN", null], "§5 another account's press on this confirm: refused");
		const otherLoad = newId();
		await w.armed(otherLoad);
		const crossLoad = await w.press(otherLoad, p.body.token);
		eq([crossLoad.status, w.claim(otherLoad)], [409, null], "§5 a token is for its own load");
		w.now += sendButton.TOKEN_MS - 1;
		w.searched(id);
		await w.paidOk(id);
		const inTime = await w.press(id, p.body.token);
		eq(inTime.status, 200, "§5 just inside 15 minutes: taken");
		await until(() => w.open() === 0, "§5 the run");
		const late = newId();
		await w.armed(late);
		p = await w.preview(late);
		w.now += sendButton.TOKEN_MS;
		w.searched(late);
		const expired = await w.press(late, p.body.token);
		eq([expired.status, expired.body.code, w.claim(late)], [409, "BUTTON_PREVIEW_AGAIN", null], "§5 at 15 minutes: expired, nothing moves");
	}
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		await w.restart();
		const after = await w.press(id, p.body.token);
		eq([after.status, after.body.code, w.claim(id), w.smtp.length], [409, "BUTTON_PREVIEW_AGAIN", null, 0], "§5 tokens are held in memory: a restart means preview again");
	}
	for (const [label, setup, code] of [
		["a hand draft since the preview", (w, id) => w.handDraft(id), "NOT_NONE_FOUND"],
		["the Stop since the preview", (w) => ledger.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(w.now) }), "STOPPED"],
		["factored since the preview", (w, id) => markFactored(w, id), "FACTORED"],
		["a closed month since the preview", (w) => { w.closed = () => ["2026-10"]; }, "CLOSED_MONTH"],
		["the sheet changed since the preview", (w, id) => w.setRow(id, { "  Payment  ": "$1,100.00" }), "PAID_CHECK_PENDING"],
	]) {
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		setup(w, id);
		const r = await w.press(id, p.body.token);
		eq([r.status, r.body.code, w.st(id), w.actions("auto_invoice_button_press").length, w.smtp.length], [409, code, null, 0, 0], `§5 ${label}: refused at the press, with its reason`);
	}
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		w.readFails = true;
		const r = await w.press(id, p.body.token);
		eq([r.status, r.body.code, w.claim(id)], [503, "SHEET_UNAVAILABLE", null], "§5 the sheet down at the press: nothing moves");
	}
	{
		// The press's audit row fails: the claim has already moved, so the run must still happen.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		const pressAudit = w.audits;
		w.audits = { push(row) { if (row.action === "auto_invoice_button_press") throw Object.assign(new Error("made-up: the audit table is locked for made-up.billing@chrobinson.com"), { code: "SQLITE_BUSY" }); pressAudit.push(row); }, filter: (f) => pressAudit.filter(f) };
		const r = await w.press(id, p.body.token);
		eq(r.status, 200, "§5 the press's audit row fails: the press stands");
		await until(() => w.open() === 0, "§5 the run");
		eq([w.st(id), w.smtp.length], [["drafted", ""], 1], "§5 ...and its run goes, once");
		ok(w.logs.some((l) => /the press's audit row failed: SQLITE_BUSY/.test(l)), "§5 ...the failure is logged by its code");
		ok(!w.logs.some((l) => l.includes("@")), "§5 ...never its message");
	}
	{
		// The press's own write fails: nothing moved, and the answer says so rather than hanging.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		w.beforePress = () => {
			const real = ledger.pressButton;
			ledger.pressButton = () => {
				ledger.pressButton = real;
				throw Object.assign(new Error("made-up: locked"), { code: "SQLITE_BUSY" });
			};
		};
		const r = await w.press(id, p.body.token);
		eq([r.status, r.body.code, w.claim(id), w.actions("auto_invoice_button_press").length, w.smtp.length], [503, "SHEET_UNAVAILABLE", null, 0, 0], "§5 the press's write fails: 503, no audit row, nothing runs");
	}
	{
		// After the press's last wait, the rows are read once more, with nothing awaited before the write.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		w.beforeRefresh = () => w.handDraft(id);
		const r = await w.press(id, p.body.token);
		eq([r.status, r.body.code, w.claim(id), w.actions("auto_invoice_button_press").length], [409, "NOT_NONE_FOUND", null, 0], "§5 a hand draft in the last moment before the press: refused, nothing moves");
	}

	section("§6  the run");
	for (const [label, change, code] of [
		["R-H2 (c): the Payments Table filled since the preview", (w, id) => w.payments.push([id, "", "", "INV-MADE-UP", "", ""]), "PAYMENTS_TABLE_HIT"],
		["R-H2 (c): the Payments Table unreadable", (w) => { w.paymentsFail = true; }, "PAYMENTS_UNREAD"],
		["billed from Gmail since the preview", (w) => { w.lookAnswer = { verdict: "invoice", mailboxes: { drafts: box(), sent: box({ invoice: 1 }) } }; }, "MAILBOX_HIT"],
		["a mention since the preview", (w) => { w.lookAnswer = { verdict: "mention", mailboxes: { drafts: box(), sent: box({ mention: 1 }) } }; }, "MAILBOX_HIT"],
		["the search fails", (w) => { w.lookFails = true; }, "MAILBOX_UNREAD"],
	]) {
		const w = await backCase(`the run's look: ${label}`, { code, afterPress: change });
		eq(w.timeline.filter((t) => t === "prepare").length, 1, `§6 ${label}: only the preview's paid call: the run stopped before its own`);
		eq(w.calls.failedNotes.length, code === "MAILBOX_UNREAD" ? 1 : 0, `§6 ${label}: ${code === "MAILBOX_UNREAD" ? "a failed search is noted on the saved row" : "no failure to note"}`);
	}
	{
		// A hit found by the run reads back through the real status once the search saves it.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		const hit = { verdict: "invoice", mailboxes: { drafts: box(), sent: box({ invoice: 1 }) } };
		w.lookAnswer = hit;
		w.lookHook = async () => { evidenceLib.saveAnswer(w.db, rules.loadKey(id), hit, { nowIso: iso(w.now) }); };
		await w.press(id, p.body.token);
		await until(() => w.open() === 0, "§6 the run");
		const r = await w.state(id);
		eq([w.smtp.length, r.body.show, r.body.code], [0, false, "NOT_NONE_FOUND"], "§6 a hit refreshes the saved row, so the button doesn't return");
	}
	for (const [label, renderOver, detail] of [
		["the billed total", (out) => ({ ...out, attachments: [{ ...out.attachments[0], content: textPdf("INVOICE Invoice ID # : 10202026-1 Date: 10/20/2026 Made-up Co. Total $1,100.00") }, ...out.attachments.slice(1)] }), "attachments"],
		["the subject", (out) => ({ ...out, subject: `${out.subject} again` }), "subject"],
		["the body", (out) => ({ ...out, html: `${out.html}<p>More.</p>` }), "body"],
		["a POD's bytes", (out) => ({ ...out, attachments: [out.attachments[0], { ...out.attachments[1], content: Buffer.from("%PDF-1.4 another POD") }, out.attachments[2]] }), "attachments"],
		["an attachment's name", (out) => ({ ...out, attachments: [out.attachments[0], { ...out.attachments[1], filename: "another.pdf" }, out.attachments[2]] }), "attachments"],
	]) {
		await backCase(`what goes is what was confirmed: ${label} differs`, { code: "DIGEST_CHANGED", number: true, detail, afterPress: (w) => { w.renderOver = renderOver; } });
	}
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		await w.send(id, "§6 the date");
		const c = w.claim(id);
		eq([c.state, w.smtp.length], ["drafted", 1], "§6 a digest with its number and date masked matches");
		// A day later the number and the date on the invoice differ, and the digest still matches.
		const later = newId();
		await w.armed(later);
		const p = await w.preview(later);
		w.now += 14 * MIN;
		w.afterPress = () => { w.calls.mint = 41; };
		w.searched(later);
		await w.paidOk(later);
		await w.press(later, p.body.token);
		await until(() => w.open() === 0, "§6 the second run");
		eq([w.st(later), w.claim(later).invoice_id, w.smtp.length], [["drafted", ""], "10202026-42", 2], "§6 another number on the invoice isn't a difference");
	}
	{
		// A digest that was lost off the claim can't match anything: nothing goes.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		w.afterPress = () => {
			const c = w.claim(id);
			const record = JSON.parse(c.button_send_json);
			delete record.digest;
			w.db.prepare("UPDATE auto_invoice_claims SET button_send_json = ? WHERE load_key = ?").run(JSON.stringify(record), c.load_key);
		};
		await w.press(id, p.body.token);
		await until(() => w.open() === 0, "§6 the run");
		eq([w.smtp.length, w.appends.length, w.st(id)], [0, 0, ["baseline", ""]], "§6 no confirmed digest: nothing sent");
	}

	section("§7  back where it came from");
	// Each exit in review M-5's table and in R-L8's list, by the code it reports.
	await backCase("a free check: the load off Delivered", { code: "NOT_COMPLETED", afterPress: (w, id) => w.setRow(id, { "Job Status": "At Receiver" }) });
	await backCase("a free check: cancelled", { code: "LOAD_DROPPED", afterPress: (w, id) => w.setRow(id, { "Job Status": "Cancelled" }) });
	await backCase("a free check: the row gone", { code: "LOAD_DROPPED", afterPress: (w, id) => { w.rows = w.rows.filter((r) => r["Load ID"] !== id); } });
	await backCase("a free check: its POD deleted (a `waiting` re-queue, no longer one)", { code: "WAITING_POD", afterPress: (w) => w.db.prepare("UPDATE documents SET deleted_at = CURRENT_TIMESTAMP").run() });
	await backCase("a free check: a closed month", { code: "CLOSED_MONTH", afterPress: (w) => { w.closed = () => ["2026-10"]; } });
	await backCase("a free check: a month that can't be told", { code: "MONTH_UNKNOWN", afterPress: (w) => { w.closed = () => null; } });
	await backCase("a free check: opted out", { code: "BROKER_OPTED_OUT", afterPress: (w) => w.confirmed(["chrobinson.com"], ["chrobinson.com"]) });
	await backCase("a free check: the domain unconfirmed", { code: "BROKER_DOMAIN_UNCONFIRMED", afterPress: (w) => w.confirmed([]) });
	await backCase("a free check: the Email cell blanked", { code: "NO_BROKER_EMAIL", afterPress: (w, id) => w.setRow(id, { Email: "" }) });
	await backCase("the button's own check: another broker's Email", { code: "NOT_CHR_EMAIL", afterPress: (w, id) => { w.confirmed(["chrobinson.com", "example-broker.test"]); w.setRow(id, { Email: "ops@example-broker.test" }); } });
	await backCase("the button's own check: Payment no longer one amount", { code: "PAYMENT_NOT_PLAIN", afterPress: (w, id) => w.setRow(id, { "  Payment  ": "$1,000 + $50" }) });
	await backCase("the button's own check: older than the start date", { code: "BEFORE_START_DATE", afterPress: (w, id) => w.setRow(id, { "Completion Date": "09/30/2026 9:00:00" }) });
	await backCase("the engine refuses: totals", { code: "TOTAL_MISMATCH", afterPress: (w) => { w.prepareHook = async () => ({ ok: false, http: 422, code: "TOTAL_MISMATCH" }); } });
	await backCase("the engine refuses: no rate con", { code: "RATECON_MISSING", afterPress: (w) => { w.prepareHook = async () => ({ ok: false, http: 422, code: "RATECON_MISSING" }); } });
	await backCase("the engine refuses: not ready", { code: "NOT_COMPLETED", afterPress: (w) => { w.prepareHook = async () => ({ ok: false, http: 400, code: "NOT_COMPLETED" }); } });
	await backCase("the engine refuses: no POD it can read", { code: "POD_UNREADABLE", afterPress: (w) => { w.prepareHook = async () => ({ ok: false, http: 400, code: "POD_NOT_FOUND" }); } });
	await backCase("the job's recipient rule on the engine's address", { code: "RECIPIENT_DOMAIN_MISMATCH", afterPress: (w) => { w.prepareHook = async (loadId) => ({ ok: true, ctx: { loadId, to: "billing@example-other.test" } }); } });
	await backCase("a temporary failure: the engine throws", { code: "RETRY_LATER", afterPress: (w) => { w.prepareHook = async () => { throw new Error("made-up"); }; } });
	await backCase("a temporary failure: Gemini down while preparing", { code: "GEMINI_DOWN", afterPress: (w) => { w.prepareHook = async () => ({ ok: false, http: 422, code: "RATECON_MISSING", geminiUnavailable: true }); } });
	await backCase("a temporary failure: Gemini seen down", { code: "GEMINI_DOWN", afterPress: (w) => { w.geminiDownAt = w.now - MIN; } });
	await backCase("a temporary failure: the sheet down", { code: "RETRY_LATER", afterPress: (w) => { w.readFails = true; } });
	await backCase("the settings unreadable, at the line", { code: "SETTINGS_UNREADABLE", afterPress: (w) => w.db.prepare("UPDATE app_settings SET value = 'not json' WHERE key = 'auto_invoice.settings'").run() });
	await backCase("no mailbox, at the line", { code: "NO_MAILBOX", afterPress: (w) => { w.mailbox = { user: "", pass: "" }; } });
	await backCase("the login pause, at the line", { code: "MAILBOX_PAUSED", afterPress: (w) => ledger.setMeta(w.db, "paused_until", iso(w.now + HOUR)) });
	await backCase("the cap, at the line", { code: "CAP_REACHED", afterPress: (w) => { for (let i = 0; i < 12; i++) w.seed(`9099000${String(i).padStart(2, "0")}`, { state: "drafted", drafted_at: iso(w.now - MIN) }); } });
	await backCase("the Stop since the press, before anything is paid for", { code: "STOPPED", stopped: true, afterPress: (w) => ledger.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(w.now) }) });
	await backCase("a build that throws: its number voided", { code: "RETRY_LATER", number: true, afterPress: (w) => { w.renderHook = async () => { throw new Error("made-up"); }; } });
	await backCase("the renderer busy, its number voided", { code: "RENDERER_BUSY", number: true, afterPress: (w) => { w.renderHook = async () => { throw Object.assign(new Error("made-up"), { code: "RENDERER_BUSY" }); }; } });
	await backCase("the render's own recipient refusal, a number held", { code: "RECIPIENT_DOMAIN_MISMATCH", number: true, afterPress: (w) => { w.renderOver = (out) => ({ ...out, to: "billing@example-other.test" }); } });
	await backCase("the render changes the recipient on the domain", { code: "DRAFT_REFUSED", number: true, afterPress: (w) => { w.renderOver = (out) => ({ ...out, to: "made-up.other@chrobinson.com" }); } });
	await backCase("the Stop during the build: a draft would follow, and doesn't", { code: "STOPPED", number: true, stopped: true, afterPress: (w) => { w.renderHook = async () => { ledger.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(w.now) }); }; } });
	await backCase("a POD time ahead of the clock, added during the build: a draft would follow, and doesn't", { code: "POD_TIME_UNKNOWN", number: true, afterPress: (w, id) => { w.renderHook = async () => { w.addPod(id, { at: "2026-10-20 14:30:00" }); }; } });
	await backCase("the last check on the message", { code: "SEND_REFUSED", number: true, afterPress: (w) => { w.renderOver = (out) => ({ ...out, attachments: [out.attachments[0], { ...out.attachments[1], content: new Uint8Array(out.attachments[1].content) }, out.attachments[2]] }); } });
	{
		const wrapBegin = (fn) => {
			const real = ledger.beginSend;
			ledger.beginSend = (...args) => {
				fn();
				return real(...args);
			};
			return () => { ledger.beginSend = real; };
		};
		let undo = null;
		await backCase("the Stop inside the send's commit", { code: "STOPPED", number: true, stopped: true, afterPress: (w) => { undo = wrapBegin(() => ledger.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(w.now) })); } });
		undo();
		await backCase("a press in flight inside the send's commit", { code: "HAND_DRAFT_IN_FLIGHT", number: true, afterPress: (w, id) => { undo = wrapBegin(() => pressInFlight(w, id)); } });
		undo();
	}
	{
		// Only chrobinson.com, whatever the recipient rule lets through: another domain on the send list,
		// with the rule itself gone loose, still stops at the button's own check, at each step.
		const realRule = rules.recipientRule;
		const looseRule = (o) => ({ ok: true, to: o.documentsEmail, source: "ratecon" });
		const OTHER = "billing@example-other.test";
		try {
			const w = makeWorld();
			w.sendDomains = ["chrobinson.com", "example-other.test"];
			await w.boot();
			let id = newId();
			await w.armed(id);
			const p = await w.preview(id);
			w.afterPress = () => {
				rules.recipientRule = looseRule;
				w.rateCons.set(rules.loadKey(id), OTHER);
			};
			await w.press(id, p.body.token);
			await until(() => w.open() === 0, "§7 the loose rule: the run");
			eq([w.st(id), w.smtp.length, w.appends.length, w.calls.mint, w.actions("auto_invoice_button_back").map((a) => a.details.split(":")[0])], [["baseline", ""], 0, 0, 0, ["DOMAIN_NOT_LISTED"]], "§7 the recipient off chrobinson.com at the run: back, before any number");
			id = newId();
			w.ready(id, {}, OTHER);
			await w.paidOk(id);
			const refused = await w.preview(id);
			eq([refused.status, refused.body.code, refused.body.token], [409, "DOMAIN_NOT_LISTED", undefined], "§7 ...at the preview: no confirm");
			id = newId();
			w.ready(id, {}, OTHER);
			await w.btn.runPaidChecks();
			eq((await w.state(id)).body.code, "DOMAIN_NOT_LISTED", "§7 ...at the paid check: saved, and its one line");
		} finally {
			rules.recipientRule = realRule;
		}
	}
	{
		const w = await backCase("SMTP refused before the body", { code: "SMTP_REFUSED", number: true, smtp: 1, stopped: true, setup: (x) => { x.smtpBehaviors = ["REFUSED"]; } });
		eq(ledger.getSendStop(w.db).reason, "SMTP_REFUSED", "§7 ...the stop stays set, for its own reason");
		eq(w.actions("auto_invoice_send_stopped").length, 1, "§7 ...with its own audit row");
		const x = await backCase("the SMTP login refused", { code: "SMTP_LOGIN_REFUSED", number: true, smtp: 1, stopped: true, setup: (y) => { y.smtpBehaviors = ["LOGIN"]; } });
		eq(ledger.getSendStop(x.db).reason, "SMTP_LOGIN_REFUSED", "§7 ...the login's own stop");
	}
	{
		const stuck = gate();
		const w = await (async () => {
			const x = makeWorld();
			await x.boot();
			return x;
		})();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		w.renderHook = () => stuck.p;
		await w.press(id, p.body.token);
		await until(() => w.calls.render === 2, "§7 the run is stuck in its render");
		ok(w.passRunLimit(), "§7 a stuck run passes its limit");
		await until(() => w.open() === 0, "§7 the line goes on");
		const c = w.claim(id);
		eq([c.state, c.button_send_json, Boolean(c.number_voided_at), w.smtp.length, w.appends.length], ["baseline", "", true, 0, 0], "§7 R-M3: a run past its limit, before its send: back, its number given up");
		eq(w.actions("auto_invoice_button_back").map((a) => a.details.split(":")[0]), ["DRAFT_FAILED"], "§7 ...with one audit row");
		stuck.open();
	}
	{
		// An OFF_GAP load goes back to OFF_GAP, and it keeps its own refusal of Try again.
		const w = await backCase("an OFF_GAP press", { code: "TOTAL_MISMATCH", origin: { state: "needs_attention", reason_code: "OFF_GAP" }, afterPress: (x) => { x.prepareHook = async () => ({ ok: false, http: 422, code: "TOTAL_MISMATCH" }); } });
		const id = w.rows[0]["Load ID"];
		eq(w.st(id), ["needs_attention", "OFF_GAP"], "§7 ...OFF_GAP as it was");
		eq((await w.state(id)).body.show, true, "§7 ...and the button can return");
	}
	{
		// A press after going back makes a fresh number; the old one is never used again.
		const w = await backCase("a press, back, then pressed again", { code: "RETRY_LATER", number: true, afterPress: (x) => { x.renderHook = async () => { x.renderHook = null; throw new Error("made-up"); }; } });
		const id = w.rows[0]["Load ID"];
		const voided = w.claim(id).invoice_id;
		await w.send(id, "§7 the second press");
		const c = w.claim(id);
		eq([c.state, w.smtp.length, c.number_voided_at], ["drafted", 1, ""], "§7 the second press sends, once");
		ok(c.invoice_id !== voided, "§7 ...under a fresh number");
	}

	section("§8  the ways that aren't back");
	const closes = async (label, { code, afterPress, number = false, smtp = 0 }) => {
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		w.afterPress = () => afterPress(w, id);
		await w.press(id, p.body.token);
		await until(() => w.open() === 0, `§8 ${label}: the run`);
		await turn();
		eq([w.st(id), w.smtp.length, w.appends.length], [["skipped", code], smtp, 0], `§8 ${label}: closed, no mail, no draft`);
		eq(w.actions("auto_invoice_button_back").length, 0, `§8 ${label}: it doesn't go back`);
		eq(w.notices.filter((n) => n.title === "Invoice not sent").length, 1, `§8 ${label}: one notice`);
		eq([Boolean(w.claim(id).number_voided_at), w.actions("auto_invoice_number_void").length], number ? [true, 1] : [false, 0], `§8 ${label}: ${number ? "its number given up" : "no number used"}`);
		const r = await w.state(id);
		eq(r.body.show, false, `§8 ${label}: no button`);
	};
	await closes("a hand draft at the run's start", { code: "DRAFTED_BY_HAND", afterPress: (w, id) => w.handDraft(id) });
	await closes("a hand draft before the number", { code: "DRAFTED_BY_HAND", afterPress: (w, id) => { w.prepareHook = async () => { w.prepareHook = null; w.handDraft(id); return null; }; } });
	await closes("a hand draft during the build", { code: "DRAFTED_BY_HAND", number: true, afterPress: (w, id) => { w.renderHook = async () => { w.handDraft(id); }; } });
	await closes("a factoring mark at the run's start", { code: "LOAD_FACTORED", afterPress: (w, id) => markFactored(w, id) });
	await closes("a factoring mark before the number", { code: "LOAD_FACTORED", afterPress: (w, id) => { w.prepareHook = async () => { w.prepareHook = null; markFactored(w, id); return null; }; } });
	await closes("a factoring mark during the build", { code: "LOAD_FACTORED", number: true, afterPress: (w, id) => { w.renderHook = async () => { markFactored(w, id); }; } });
	{
		const real = ledger.beginSend;
		await closes("factoring last, inside the send's commit", { code: "LOAD_FACTORED", number: true, afterPress: (w, id) => { ledger.beginSend = (...args) => { markFactored(w, id); return real(...args); }; } });
		ledger.beginSend = real;
		await closes("a hand draft inside the send's commit", { code: "DRAFTED_BY_HAND", number: true, afterPress: (w, id) => { ledger.beginSend = (...args) => { w.handDraft(id); return real(...args); }; } });
		ledger.beginSend = real;
	}
	{
		// Factoring is read after every other check in the commit: a stop and a mark together read as the stop.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		w.seed(id, { state: "working", lease_owner: "me", lease_until: iso(w.now + HOUR), stage: "rendered", button_send_json: "{}" });
		markFactored(w, id);
		eq(ledger.beginSend(w.db, rules.loadKey(id), "me", { nowIso: iso(w.now) }), { ok: false, reason: "factored" }, "§8 the commit reads the marker");
		ledger.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(w.now) });
		eq(ledger.beginSend(w.db, rules.loadKey(id), "me", { nowIso: iso(w.now) }), { ok: false, reason: "stopped" }, "§8 ...last of them");
	}
	{
		// A send that started, then a lost answer: never back. Searched only, then MAYBE_SENT.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		w.smtpBehaviors = ["LOST"];
		await w.send(id, "§8 the lost answer");
		const c = w.claim(id);
		eq([c.state, c.reason_code, c.stage, c.delivery], ["needs_attention", "MAYBE_SENT", "appending", "send"], "§8 FAILS ON THE OLD DESIGN (M-5): a lost answer: MAYBE_SENT, never back");
		ok(c.button_send_json, "§8 ...it keeps its press");
		eq([w.smtp.length, w.appends.length, w.actions("auto_invoice_button_back").length, w.actions("auto_invoice_number_void").length], [1, 0, 0, 0], "§8 ...one SMTP call, no draft, no back, the number kept");
		eq(ledger.getSendStop(w.db).reason, "SEND_UNANSWERED", "§8 ...and the stop");
		eq(w.calls.search, 2, "§8 ...Sent Mail was searched, and once more two minutes later in the same run");
		const r = await w.state(id);
		eq([r.body.show, r.body.code], [false, "STOPPED"], "§8 ...no button while the stop is set");
		ledger.clearSendStop(w.db);
		const q = await w.state(id);
		eq([q.body.show, q.body.code], [false, "NOT_NONE_FOUND"], "§8 ...and none once it's cleared: the status reads Needs attention");
		const p = await w.preview(id);
		eq([p.status, w.calls.prepare, w.calls.mint, w.smtp.length], [409, 2, 1, 1], "§8 ...a preview stops there too, with no paid call of its own");
		eq(ledger.returnToOrigin(w.db, rules.loadKey(id), { from: ["needs_attention", "working", "queued"], state: "baseline", nowIso: iso(w.now) }), 0, "§8 ...and the ledger itself refuses to put it back");
	}
	{
		// A person closes a maybe-sent press with a re-issue: closed, and no word that nothing went.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		w.smtpBehaviors = ["LOST"];
		await w.send(id, "§8 the lost answer");
		w.handDraft(id);
		await w.job.checkClaims(rules.loadKey(id));
		eq([w.st(id), w.smtp.length, w.notices.filter((n) => /sent nothing/.test(n.body)).length], [["skipped", "DRAFTED_BY_HAND"], 1, 0], "§8 a person's draft closes a MAYBE_SENT press, and no notice says nothing went");
	}
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		w.smtpBehaviors = ["LANDED_LOST"];
		await w.send(id, "§8 the answer lost, the mail found");
		const c = w.claim(id);
		eq([c.state, c.stage, c.delivery, w.smtp.length, w.actions("auto_invoice_sent").length, w.draftRows(id).map((x) => x.via)], ["drafted", "recorded", "send", 1, 1, ["auto-smtp"]], "§8 a lost answer, found in Sent Mail: recorded as sent, once");
	}
	{
		// Past its limit inside SMTP: MAYBE_SENT, never back, whatever the send does after.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const hold = gate();
		w.smtpHook = () => hold.p;
		const p = await w.preview(id);
		await w.press(id, p.body.token);
		await until(() => w.smtp.length === 1, "§8 inside SMTP");
		w.passRunLimit();
		await until(() => w.st(id) && w.st(id)[1] === "MAYBE_SENT", "§8 the limit passes");
		hold.open();
		await turn();
		await turn();
		const c = w.claim(id);
		eq([c.state, c.reason_code, c.delivery, w.smtp.length, w.actions("auto_invoice_button_back").length], ["needs_attention", "MAYBE_SENT", "send", 1, 0], "§8 a run past its limit inside SMTP: MAYBE_SENT, one call, never back");
	}
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		w.recordHook = async () => { throw new Error("made-up: the row could not be written"); };
		await w.send(id, "§8 the row not written");
		const c = w.claim(id);
		eq([c.state, c.reason_code, c.stage, c.delivery, w.smtp.length, w.actions("auto_invoice_button_back").length], ["needs_attention", "IN_GMAIL_UNRECORDED", "appended", "send", 1, 0], "§8 sent, not recorded: IN_GMAIL_UNRECORDED, never back");
	}

	section("§9  never twice");
	{
		// A double press, one after the other and at once.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		let p = await w.preview(id);
		const first = await w.press(id, p.body.token);
		const second = await w.press(id, p.body.token);
		eq([first.status, second.status, second.body.code], [200, 409, "BUTTON_PREVIEW_AGAIN"], "§9 FAILS ON THE OLD CODE: the same confirm twice: the second is refused");
		await until(() => w.open() === 0, "§9 the run");
		eq([w.smtp.length, w.actions("auto_invoice_button_press").length], [1, 1], "§9 ...one SMTP call, one audit row");
		const late = await w.preview(id);
		eq([late.status, late.body.code, w.smtp.length], [409, "NOT_NONE_FOUND", 1], "§9 a preview after the send: refused, its status says why");

		const both = newId();
		await w.armed(both);
		p = await w.preview(both);
		const at = await Promise.all([w.press(both, p.body.token), w.press(both, p.body.token), w.press(both, p.body.token)]);
		eq(at.map((r) => r.status).sort(), [200, 409, 409], "§9 three presses at once: one is taken");
		await until(() => w.open() === 0, "§9 the run");
		eq([w.smtp.length, w.st(both)], [2, ["drafted", ""]], "§9 ...one more SMTP call, for that load");
	}
	{
		// The claim's own guard, past the token: a press whose claim has moved does nothing.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		w.seed(id, { state: "baseline" });
		const first = ledger.pressButton(w.db, rules.loadKey(id), { loadId: id, record: { by: "a" }, nowIso: iso(w.now) });
		const second = ledger.pressButton(w.db, rules.loadKey(id), { loadId: id, record: { by: "b" }, nowIso: iso(w.now) });
		eq([first.ok, second.ok, JSON.parse(w.claim(id).button_send_json).by], [true, false, "a"], "§9 FAILS ON THE OLD DESIGN: one conditional update: the second finds the state moved");
		for (const [state, extra] of [["waiting", {}], ["queued", {}], ["working", {}], ["drafted", {}], ["skipped", {}], ["needs_attention", { reason_code: "TOTAL_MISMATCH" }], ["needs_attention", { reason_code: "MAYBE_SENT" }]]) {
			const x = newId();
			w.seed(x, { state, ...extra });
			const before = JSON.stringify(w.claim(x));
			eq([ledger.pressButton(w.db, rules.loadKey(x), { loadId: x, record: {}, nowIso: iso(w.now + MIN) }).ok, JSON.stringify(w.claim(x)) === before], [false, true], `§9 a press finds ${state} ${extra.reason_code || ""}: nothing moves`);
		}
		for (const [label, fields] of [
			["a baseline claim whose send started", { state: "baseline", delivery: "send", stage: "appending" }],
			["a baseline claim past its send", { state: "baseline", stage: "recorded" }],
			["an OFF_GAP claim whose send started", { state: "needs_attention", reason_code: "OFF_GAP", delivery: "send", stage: "appending" }],
			["a claim already holding a press", { state: "baseline", button_send_json: "{}" }],
		]) {
			const x = newId();
			w.seed(x, fields);
			eq(ledger.pressButton(w.db, rules.loadKey(x), { loadId: x, record: {}, nowIso: iso(w.now) }).ok, false, `§9 ${label}: refused`);
		}
	}
	{
		// The claim moves in the last instant, past every check in the route: the one conditional update decides.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		w.beforePress = () => {
			w.setRow(id, { "Job Status": "At Receiver" });
			tap(w, w.job, id);
		};
		const r = await w.press(id, p.body.token);
		eq([r.status, r.body.code, w.actions("auto_invoice_button_press").length], [409, "BUTTON_CLAIM_MOVED", 0], "§9 FAILS ON THE OLD DESIGN: a driver's tap in the press's last instant: the press finds the state moved, and says so");
		await until(() => w.open() === 0 && w.smtp.length === 1, "§9 the tap's run");
		eq([w.st(id), w.smtp.length, JSON.parse(JSON.stringify(w.claim(id).button_send_json))], [["drafted", ""], 1, ""], "§9 ...one SMTP call, from the tap, with no press on the claim");
	}
	{
		// A change after a press's send behaves as after any send: the mark, the notice and the stop.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		await w.send(id, "§9 sent");
		w.setRow(id, { "  Payment  ": "$1,100.00" });
		w.now += 1000;
		await w.job.checkClaims(rules.loadKey(id));
		const c = w.claim(id);
		eq([c.state, c.changed_fields, ledger.getSendStop(w.db).reason, w.smtp.length, w.actions("auto_invoice_button_back").length], ["drafted", "payment", "LOAD_CHANGED_AFTER_SEND", 1, 0], "§9 a change after a press's send: as after any send, one SMTP call, never back");
	}
	{
		// A driver's tap and a press, each order.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id, { "Job Status": "At Receiver" });
		tap(w, w.job, id);
		await until(() => w.open() === 0 && w.smtp.length === 1, "§9 the tap's run");
		const r = await w.state(id);
		eq([r.body.show, w.st(id), w.smtp.length], [false, ["drafted", ""], 1], "§9 a tap first: sent once, and no button after it");

		// The confirm is out, then the driver taps.
		const a = newId();
		await w.armed(a, { "Job Status": "Delivered" });
		const p = await w.preview(a);
		w.setRow(a, { "Job Status": "At Receiver" });
		const hold = gate();
		w.lookHook = () => hold.p;
		tap(w, w.job, a);
		const pressed = await w.press(a, p.body.token);
		eq([pressed.status, pressed.body.code], [409, "NOT_NONE_FOUND"], "§9 a confirm out, then a driver's tap: the press finds the load in line");
		hold.open();
		w.lookHook = null;
		await until(() => w.open() === 0 && w.smtp.length === 2, "§9 that tap's run");
		eq(w.smtp.filter((m) => m.subject.includes(a)).length, 1, "§9 ...one SMTP call for that load");

		// The press first, then the driver taps during its run.
		const b = newId();
		await w.armed(b);
		const q = await w.preview(b);
		const running = gate();
		w.lookHook = () => running.p;
		await w.press(b, q.body.token);
		await until(() => w.calls.look.length >= 1 && w.st(b)[0] === "working", "§9 the press's run");
		w.setRow(b, { "Job Status": "At Receiver" });
		const tapped = tap(w, w.job, b);
		eq(tapped, {}, "§9 ...a tap during it");
		eq(w.st(b)[0], "working", "§9 ...leaves the claim alone");
		running.open();
		w.lookHook = null;
		await until(() => w.open() === 0, "§9 the press's run ends");
		eq(w.smtp.filter((m) => m.subject.includes(b)).length, 1, "§9 a press, then a driver's tap: one SMTP call");

		// A tap on a load whose press went back: left alone, so the person who pressed decides.
		const c = newId();
		await w.armed(c);
		const u = await w.preview(c);
		w.afterPress = () => { w.prepareHook = async () => ({ ok: false, http: 422, code: "TOTAL_MISMATCH" }); };
		await w.press(c, u.body.token);
		await until(() => w.open() === 0, "§9 back");
		w.prepareHook = null;
		w.setRow(c, { "Job Status": "At Receiver" });
		tap(w, w.job, c);
		await until(() => w.open() === 0, "§9 no run");
		eq([w.st(c), w.smtp.filter((m) => m.subject.includes(c)).length], [["baseline", ""], 0], "§9 a tap on a claim the press sent back to baseline: nothing starts");
	}
	{
		// R-H1: a sheet write that reports failure but landed, with a press in reach.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id, { "Job Status": "At Receiver" });
		const { thrown } = tap(w, w.job, id, { fails: true, landed: true });
		ok(thrown, "§9 R-H1: the write reports failure, and the driver gets the error he gets today");
		eq(w.st(id), ["waiting", "DRIVER_PENDING"], "§9 ...the record stands, right after it");
		const during = await w.state(id);
		eq([during.body.show, during.body.code], [false, "NOT_NONE_FOUND"], "§9 FAILS ON THE OLD DESIGN: ...while the row reads Delivered and the tap is unsettled: its status says Waiting, and no button");
		await until(() => w.smtp.length === 1 && w.open() === 0, "§9 the row read back: it landed");
		eq([w.st(id), w.smtp.length], [["drafted", ""], 1], "§9 ...it goes once, from the tap");
		const after = await w.preview(id);
		eq([after.status, w.smtp.length], [409, 1], "§9 ...and a preview after it is refused");

		// A confirm already out when the failed write lands.
		const a = newId();
		await w.armed(a);
		const p = await w.preview(a);
		w.setRow(a, { "Job Status": "At Receiver" });
		tap(w, w.job, a, { fails: true, landed: true });
		const pressed = await w.press(a, p.body.token);
		eq(pressed.status, 409, "§9 R-H1: a confirm out, then a write that reports failure but landed: the press finds the claim taken");
		await until(() => w.smtp.filter((m) => m.subject.includes(a)).length === 1 && w.open() === 0, "§9 that tap's send");
		eq(w.smtp.filter((m) => m.subject.includes(a)).length, 1, "§9 ...one SMTP call on that load");

		// The press went first: the driver's failed write finds nothing to arm.
		const b = newId();
		await w.armed(b);
		const q = await w.preview(b);
		const running = gate();
		w.lookHook = () => running.p;
		await w.press(b, q.body.token);
		await until(() => w.st(b)[0] === "working", "§9 the press's run");
		w.setRow(b, { "Job Status": "At Receiver" });
		const failed = tap(w, w.job, b, { fails: true, landed: true });
		ok(failed.thrown, "§9 ...the driver gets his error");
		running.open();
		w.lookHook = null;
		await until(() => w.open() === 0, "§9 the press's run ends");
		await turn();
		await turn();
		eq(w.smtp.filter((m) => m.subject.includes(b)).length, 1, "§9 R-H1: a press, then a write that reports failure but landed: one SMTP call");

		// A failed write that didn't land: waiting, NOT_COMPLETED. The office marks it Delivered: no button, by its own line.
		const c = newId();
		await w.armed(c, { "Job Status": "At Receiver" });
		tap(w, w.job, c, { fails: true, landed: false });
		await until(() => w.st(c)[1] === "NOT_COMPLETED", "§9 read back: it didn't land");
		w.setRow(c, { "Job Status": "Delivered" });
		await w.paidOk(c);
		const left = await w.state(c);
		eq([left.body.show, left.body.code, w.smtp.filter((m) => m.subject.includes(c)).length], [false, "CLAIM_NOT_OPEN", 0], "§9 a tap's write that failed, then the office's Delivered: no button on a claim still armed for a later tap");

		// The read back fails: the record stays, and the button stays away until start-up settles it.
		const d = newId();
		await w.armed(d, { "Job Status": "At Receiver" });
		const res = tap(w, w.job, d, { fails: true, landed: true, readBack: async () => { throw new Error("made-up: the sheet is down"); } });
		ok(res.thrown, "§9 a read back that fails too");
		await turn();
		await turn();
		eq(w.st(d), ["waiting", "DRIVER_PENDING"], "§9 ...the record stays");
		await w.paidOk(d);
		eq((await w.state(d)).body.code, "NOT_NONE_FOUND", "§9 ...its status says Waiting, and no button");
	}
	{
		// A restart mid-send: the answer lost with the process. Found: recorded. Not found: MAYBE_SENT.
		for (const found of [true, false]) {
			const w = makeWorld();
			await w.boot();
			const id = newId();
			await w.armed(id);
			const hold = gate();
			w.smtpHook = () => hold.p;
			const p = await w.preview(id);
			await w.press(id, p.body.token);
			await until(() => w.smtp.length === 1, "§9 mid-send");
			const before = w.claim(id);
			eq([before.state, before.stage, before.delivery], ["working", "appending", "send"], "§9 the send has its commit, before SMTP");
			w.smtpHook = null;
			if (found) w.sent.push(before.message_id);
			await w.restart();
			await until(() => w.open() === 0, "§9 start-up");
			const c = w.claim(id);
			if (found) eq([c.state, c.stage, c.delivery], ["drafted", "recorded", "send"], "§9 FAILS ON THE OLD DESIGN: a restart mid-send, found in Sent Mail: recorded");
			else eq([c.state, c.reason_code, c.delivery, Boolean(ledger.getSendStop(w.db))], ["needs_attention", "MAYBE_SENT", "send", true], "§9 FAILS ON THE OLD DESIGN: a restart mid-send, not found: MAYBE_SENT and the stop");
			eq([w.smtp.length, w.appends.length, w.actions("auto_invoice_button_back").length], [1, 0, 0], `§9 a restart mid-send (${found ? "found" : "not found"}): one SMTP call, never back`);
			// The old process wakes: its token is dead, whatever SMTP says.
			hold.open();
			await turn();
			await turn();
			eq([w.smtp.length, w.st(id)[0]], [1, found ? "drafted" : "needs_attention"], "§9 ...the old process finishing changes nothing");
			const again = await w.preview(id);
			eq([again.status, w.smtp.length], [409, 1], "§9 ...and no second press");
		}
	}
	{
		// A restart after the SMTP answer, before the row.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const hold = gate();
		w.recordHook = () => hold.p;
		const p = await w.preview(id);
		await w.press(id, p.body.token);
		await until(() => w.calls.record === 1, "§9 the row is being written");
		eq(w.claim(id).stage, "appended", "§9 SMTP answered");
		w.recordHook = null;
		await w.restart();
		await until(() => w.open() === 0, "§9 start-up");
		eq([w.st(id), w.smtp.length, w.draftRows(id).length], [["drafted", ""], 1, 1], "§9 a restart past the SMTP answer: recorded, one SMTP call, one row");
		hold.open();
	}
	{
		// A restart between the press and the run: it runs once, and the look is still asked for.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		w.timeline = [];
		const oldLine = w.job.runLine;
		const pressNow = await w.press(id, p.body.token);
		eq(pressNow.status, 200, "§9 pressed");
		// Taken before the line's next turn, as a process killed right there leaves it.
		const c = w.claim(id);
		eq([c.state, c.look_first !== ""], ["queued", true], "§9 R-H2 (b): the look is on the claim, so it outlives a restart");
		await w.restart();
		const line = oldLine();
		await until(() => w.open() === 0, "§9 start-up runs it");
		await line;
		eq([w.st(id), w.smtp.length, w.timeline.filter((t) => t === "look").length], [["drafted", ""], 1, 1], "§9 FAILS ON THE OLD DESIGN: two presses' worth of lines and a restart: one SMTP call, after one look");
	}
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		await w.press(id, p.body.token);
		w.lookAnswer = { verdict: "invoice", mailboxes: { drafts: box(), sent: box({ invoice: 1 }) } };
		await w.restart();
		await until(() => w.open() === 0, "§9 start-up runs it");
		eq([w.st(id), w.smtp.length], [["baseline", ""], 0], "§9 FAILS ON THE OLD DESIGN (R-H2 (b)): billed from Gmail, a restart between the press and the run: the look still stops it");
	}
	{
		// A stuck run past its limit, then a second press: the abandoned attempt can't send.
		for (const [label, stuckAt] of [["in the look", "look"], ["in prepare", "prepare"], ["in the render", "render"]]) {
			const w = makeWorld();
			await w.boot();
			const id = newId();
			await w.armed(id);
			const p = await w.preview(id);
			const stuck = gate();
			const hook = stuckAt === "look" ? "lookHook" : stuckAt === "prepare" ? "prepareHook" : "renderHook";
			w.afterPress = () => {
				w[hook] = async () => {
					w[hook] = null;
					await stuck.p;
					return null;
				};
			};
			await w.press(id, p.body.token);
			await until(() => w[hook] === null && w.st(id)[0] === "working", `§9 stuck ${label}`);
			ok(w.passRunLimit(), `§9 stuck ${label}: past its limit`);
			await until(() => w.open() === 0, `§9 stuck ${label}: the claim closes`);
			eq(w.st(id), ["baseline", ""], `§9 stuck ${label}: back`);
			const second = await w.preview(id);
			eq(second.status, 200, `§9 stuck ${label}: a second preview`);
			await w.press(id, second.body.token);
			await until(() => w.open() === 0 && w.smtp.length === 1, `§9 stuck ${label}: the second press`);
			stuck.open();
			for (let i = 0; i < 30; i++) await turn();
			eq([w.smtp.length, w.st(id), w.appends.length], [1, ["drafted", ""], 0], `§9 R-M4: stuck ${label}, past its limit, then a second press, then the first attempt wakes: one SMTP call`);
		}
	}
	{
		// R-M4, its exact shape: the abandoned attempt wakes while the second press's run is mid-way.
		// Under one owner name the two would each commit a send.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		const first = gate();
		const second = gate();
		let renders = 0;
		w.renderHook = () => {
			renders++;
			return renders === 1 ? first.p : renders === 3 ? second.p : null;
		};
		await w.press(id, p.body.token);
		await until(() => renders === 1, "§9 R-M4: the first run is in its render");
		ok(w.passRunLimit(), "§9 R-M4: past its limit");
		await until(() => w.open() === 0, "§9 R-M4: the claim closes");
		eq(w.st(id), ["baseline", ""], "§9 R-M4: back");
		const again = await w.preview(id);
		eq(again.status, 200, "§9 R-M4: a second preview");
		await w.press(id, again.body.token);
		await until(() => renders === 3, "§9 R-M4: the second run is in its render");
		first.open();
		for (let i = 0; i < 30; i++) await turn();
		eq(w.smtp.length, 0, "§9 R-M4: the abandoned attempt wakes: its writes name a dead owner, and nothing goes");
		second.open();
		await until(() => w.open() === 0, "§9 R-M4: the second run ends");
		for (let i = 0; i < 30; i++) await turn();
		eq([w.smtp.length, w.st(id), w.appends.length], [1, ["drafted", ""], 0], "§9 FAILS ON THE OLD DESIGN (R-M4): an abandoned attempt, a second press, both awake: one SMTP call");
	}
	{
		// Two processes on one claim: the lease lets one through.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const first = w.job;
		const second = jobLib.create(w.deps({ env: { ...w.env, CHR_SEND_BUTTON_ENABLED: "true", CHR_SEND_BUTTON_FROM: FROM } }));
		second.startTrigger();
		await second.finishStartUp();
		const p = await w.preview(id);
		await w.press(id, p.body.token);
		await Promise.all([first.runLine(), second.runLine()]);
		await until(() => w.open() === 0, "§9 both lines");
		eq(w.smtp.length, 1, "§9 two lines at one queued press: one SMTP call");
	}

	section("§10 start-up and the flags off");
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		// Queued, as a process killed right after the press leaves it.
		const c = await w.press(id, p.body.token);
		eq(c.status, 200, "§10 pressed");
		await w.restart({ on: false });
		await until(() => w.open() === 0, "§10 start-up");
		eq([w.st(id), w.smtp.length, w.appends.length, w.claim(id).button_send_json], [["baseline", ""], 0, 0, ""], "§10 FAILS ON THE OLD DESIGN (M-5): the flag off at a restart, a press still queued: back, nothing sent");
		eq(w.actions("auto_invoice_button_back").map((a) => a.details.split(":")[0]), ["BUTTON_OFF"], "§10 ...one audit row");
		eq(w.notices.filter((n) => n.title === "Invoice not sent").length, 1, "§10 ...one notice, once the app listens");
		await w.restart();
		await until(() => w.open() === 0, "§10 the next start-up");
		eq(w.notices.filter((n) => n.title === "Invoice not sent").length, 1, "§10 ...and the next start-up says nothing more");
	}
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		await w.press(id, p.body.token);
		w.now += HOUR + 1;
		await w.restart();
		await until(() => w.open() === 0, "§10 start-up");
		eq([w.st(id), w.smtp.length, w.actions("auto_invoice_button_back").map((a) => a.details.split(":")[0])], [["baseline", ""], 0, ["BUTTON_TOO_OLD"]], "§10 FAILS ON THE OLD DESIGN (L-10): a press over an hour old at start-up: back; its confirm said now");
	}
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		await w.press(id, p.body.token);
		w.now += HOUR;
		await w.restart();
		await until(() => w.open() === 0, "§10 start-up");
		eq([w.st(id), w.smtp.length], [["drafted", ""], 1], "§10 a press an hour old exactly: it runs once");
	}
	{
		// A restart mid-build: a recovery before the send goes back.
		for (const [label, setHook, number] of [
			["building, no number", "lookHook", false],
			["building, a number held", "renderHook", true],
		]) {
			const w = makeWorld();
			await w.boot();
			const id = newId();
			await w.armed(id);
			const p = await w.preview(id);
			const hold = gate();
			w[setHook] = () => hold.p;
			const calls = setHook === "renderHook" ? 2 : 1;
			await w.press(id, p.body.token);
			await until(() => w.st(id)[0] === "working" && (setHook === "lookHook" ? w.calls.look.length === 2 : w.calls.render === calls), `§10 ${label}`);
			w[setHook] = null;
			await w.restart();
			await until(() => w.open() === 0, `§10 ${label}: start-up`);
			eq([w.st(id), w.smtp.length, w.appends.length, Boolean(w.claim(id).number_voided_at), w.actions("auto_invoice_button_back").map((a) => a.details.split(":")[0])],
				[["baseline", ""], 0, 0, number, ["RESTARTED"]], `§10 FAILS ON THE OLD DESIGN (M-5): a restart ${label}: back, never built again`);
			hold.open();
			for (let i = 0; i < 20; i++) await turn();
			eq([w.st(id), w.smtp.length], [["baseline", ""], 0], `§10 ${label}: the old process waking changes nothing`);
		}
	}
	{
		// A restart mid-build with the flag now off: the same, by its own reason.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		const hold = gate();
		w.renderHook = () => hold.p;
		await w.press(id, p.body.token);
		await until(() => w.calls.render === 2, "§10 building");
		w.renderHook = null;
		await w.restart({ on: false });
		await until(() => w.open() === 0, "§10 start-up");
		eq([w.st(id), w.smtp.length, w.appends.length, w.actions("auto_invoice_button_back").map((a) => a.details.split(":")[0])], [["baseline", ""], 0, 0, ["BUTTON_OFF"]], "§10 a restart mid-build, the flag off: back, never built again, never a draft");
		hold.open();
	}
	{
		// A commit lost with the box's power: the Sent copy is found by its Message-ID, and it's recorded.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const record = { by: "made-up-admin", from: { state: "baseline", code: "" }, digest: { recipient: "x" } };
		w.seed(id, { state: "working", stage: "rendered", invoice_id: "10202026-9", invoice_date: "2026-10-20", message_id: "<lost@example.com>", lease_owner: "gone", lease_until: iso(w.now + HOUR), sent_json: JSON.stringify({ to: BILLING, subject: `C.H. Robinson Order #${id}`, total: "$1,000.00" }), button_send_json: JSON.stringify(record) });
		w.sent.push("<lost@example.com>");
		await w.restart();
		await until(() => w.open() === 0, "§10 start-up");
		const c = w.claim(id);
		eq([c.state, c.delivery, c.stage, w.smtp.length, w.draftRows(id).length], ["drafted", "send", "recorded", 0, 1], "§10 a message in Sent Mail for a commit the power took: recorded, never built again");

		const a = newId();
		await w.armed(a);
		w.seed(a, { state: "working", stage: "rendered", invoice_id: "10202026-8", message_id: "<unknown@example.com>", lease_owner: "gone", lease_until: iso(w.now + HOUR), button_send_json: JSON.stringify(record) });
		w.searchFails = true;
		await w.restart();
		await until(() => w.open() === 0, "§10 start-up");
		w.searchFails = false;
		eq([w.st(a), w.smtp.filter((m) => m.subject.includes(a)).length, w.actions("auto_invoice_button_back").map((x) => x.details.split(":")[0]).pop()], [["baseline", ""], 0, "MAILBOX_UNREAD"], "§10 ...Sent Mail can't be searched: back, nothing sent; the next press searches again");
	}
	for (const [label, fields, want] of [
		["a send in flight at start-up, not found", { state: "working", stage: "appending", delivery: "send", lease_owner: "gone", lease_until: iso(T0 + HOUR), reason_code: "" }, ["needs_attention", "MAYBE_SENT"]],
		["SEND_UNCONFIRMED", { state: "queued", stage: "appending", delivery: "send", reason_code: "SEND_UNCONFIRMED" }, ["needs_attention", "MAYBE_SENT"]],
		["MAYBE_SENT", { state: "needs_attention", stage: "appending", delivery: "send", reason_code: "MAYBE_SENT" }, ["needs_attention", "MAYBE_SENT"]],
		["IN_GMAIL_UNRECORDED", { state: "needs_attention", stage: "appended", delivery: "send", reason_code: "IN_GMAIL_UNRECORDED" }, ["needs_attention", "IN_GMAIL_UNRECORDED"]],
	]) {
		for (const on of [false, true]) {
			for (const age of [0, 2 * HOUR]) {
				const w = makeWorld();
				await w.boot();
				const id = newId();
				await w.armed(id);
				w.seed(id, { ...fields, invoice_id: "10202026-3", invoice_date: "2026-10-20", message_id: "<sent@example.com>", sent_json: "{}", sent_at: iso(w.now), updated_at: iso(w.now - age), button_send_json: JSON.stringify({ by: "made-up-admin", from: { state: "baseline", code: "" } }) });
				await w.restart({ on });
				await until(() => w.open() === 0, `§10 ${label}: start-up`);
				const c = w.claim(id);
				eq([c.state, c.reason_code, c.delivery, Boolean(c.button_send_json), w.smtp.length, w.appends.length, w.actions("auto_invoice_button_back").length], [...want, "send", true, 0, 0, 0],
					`§10 FAILS ON THE OLD DESIGN (M-5): ${label}, the flag ${on ? "on" : "off"}, ${age ? "over an hour old" : "fresh"}: stays searched, never back, never sent`);
			}
		}
	}
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		w.seed(id, { state: "queued", stage: "appending", delivery: "send", reason_code: "SEND_UNCONFIRMED", invoice_id: "10202026-3", invoice_date: "2026-10-20", message_id: "<sent@example.com>", sent_at: iso(w.now), next_attempt_at: iso(w.now), sent_json: JSON.stringify({ to: BILLING, subject: `C.H. Robinson Order #${id}`, total: "$1,000.00" }), button_send_json: JSON.stringify({ by: "made-up-admin", from: { state: "baseline", code: "" } }) });
		w.sent.push("<sent@example.com>");
		await w.restart({ on: false });
		await until(() => w.open() === 0, "§10 start-up");
		eq([w.st(id), w.smtp.length, w.claim(id).delivery], [["drafted", ""], 0, "send"], "§10 the flag off, a lost answer found in Sent Mail: recorded, no new mail");
	}
	{
		// Going back to the sweep (R-M5): a press never reaches work().
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		await w.press(id, p.body.token);
		const unconfirmed = newId();
		await w.armed(unconfirmed);
		w.seed(unconfirmed, { state: "queued", stage: "appending", delivery: "send", reason_code: "SEND_UNCONFIRMED", invoice_id: "10202026-3", invoice_date: "2026-10-20", message_id: "<kept@example.com>", sent_at: iso(w.now), next_attempt_at: iso(w.now), sent_json: JSON.stringify({ to: BILLING, subject: `C.H. Robinson Order #${unconfirmed}`, total: "$1,000.00" }), button_send_json: JSON.stringify({ by: "made-up-admin", from: { state: "baseline", code: "" } }) });
		const stale = newId();
		await w.armed(stale);
		w.seed(stale, { state: "working", stage: "reserved", invoice_id: "10202026-4", lease_owner: "gone", lease_until: iso(w.now - MIN), button_send_json: JSON.stringify({ by: "made-up-admin", from: { state: "baseline", code: "" } }) });
		w.env = { ...w.env, AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" };
		const sweep = jobLib.create(w.deps({ env: { ...w.env, CHR_SEND_BUTTON_ENABLED: "true", CHR_SEND_BUTTON_FROM: FROM } }));
		eq([sweep.triggerMode, sweep.button.on], [false, false], "§10 the trigger off: the button is off with it");
		const smtpBefore = w.smtp.length;
		await sweep.tick();
		eq([w.st(id), w.smtp.length - smtpBefore, w.appends.length], [["baseline", ""], 0, 0], "§10 FAILS ON THE OLD DESIGN (R-M5): the sweep's first tick: a queued press goes back, nothing sent");
		eq([w.claim(stale).state, w.claim(stale).button_send_json, w.appends.length, w.smtp.length - smtpBefore], ["baseline", "", 0, 0], "§10 ...a press left working goes back too, never rebuilt");
		eq(w.claim(unconfirmed).delivery, "send", "§10 ...a lost answer stays a send");
		ok(["queued", "needs_attention", "drafted"].includes(w.claim(unconfirmed).state), "§10 ...still searched for");
		eq([w.actions("auto_invoice_button_back").filter((a) => a.id === unconfirmed).length, w.smtp.length - smtpBefore], [0, 0], "§10 ...never back, never sent");
		const fresh = newId();
		w.setRow(fresh);
		await sweep.tick();
		eq(w.smtp.length - smtpBefore, 0, "§10 ...and a later tick sends none of them");
	}
	{
		// The sweep's own verdict can't reach a queued press first: that would land it in Needs attention.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		await w.press(id, p.body.token);
		w.closed = () => ["2026-10"];
		w.env = { ...w.env, AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" };
		const sweep = jobLib.create(w.deps({ env: { ...w.env } }));
		await sweep.tick();
		eq([w.st(id), w.claim(id).button_send_json, w.smtp.length, w.appends.length], [["baseline", ""], "", 0, 0], "§10 a queued press whose month has closed, at the sweep's first tick: back, not Needs attention");
	}
	{
		// A press left working with a Message-ID, under the sweep: Sent Mail decides, and it's never rebuilt.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const record = JSON.stringify({ by: "made-up-admin", from: { state: "baseline", code: "" } });
		w.seed(id, { state: "working", stage: "rendered", invoice_id: "10202026-6", invoice_date: "2026-10-20", message_id: "<kept-2@example.com>", lease_owner: "gone", lease_until: iso(w.now - MIN), sent_json: JSON.stringify({ to: BILLING, subject: `C.H. Robinson Order #${id}`, total: "$1,000.00" }), button_send_json: record });
		w.sent.push("<kept-2@example.com>");
		w.env = { ...w.env, AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" };
		const sweep = jobLib.create(w.deps({ env: { ...w.env } }));
		await sweep.recover();
		const c = w.claim(id);
		eq([c.state, c.delivery, c.stage, w.smtp.length, w.actions("auto_invoice_button_back").length], ["drafted", "send", "recorded", 0, 0], "§10 under the sweep too: a press whose message is in Sent Mail is recorded, not sent back");
	}
	{
		// The sheet down at a press's run, under the sweep: back, never queued for a later try.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		w.seed(id, { state: "queued", next_attempt_at: iso(w.now), button_send_json: JSON.stringify({ by: "made-up-admin", from: { state: "baseline", code: "" } }) });
		w.env = { ...w.env, AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" };
		const sweep = jobLib.create(w.deps({ env: { ...w.env } }));
		w.readFails = true;
		await sweep.work();
		w.readFails = false;
		eq([w.st(id), w.smtp.length, w.appends.length], [["baseline", ""], 0, 0], "§10 a temporary failure under the sweep: back, not a retry");
	}
	{
		// A run that ends with its press queued for later: no timer would come back to it.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		w.afterPress = () => {
			w.prepareHook = async () => {
				w.db.prepare("UPDATE auto_invoice_claims SET state = 'queued', next_attempt_at = ?, lease_owner = '' WHERE load_key = ?").run(iso(w.now + HOUR), rules.loadKey(id));
				return null;
			};
		};
		await w.press(id, p.body.token);
		await until(() => w.open() === 0, "§10 the run's end closes it");
		eq([w.st(id), w.smtp.length, w.appends.length], [["baseline", ""], 0, 0], "§10 R-M3: a press left queued at a run's end: back, not Needs attention");
	}
	{
		// The rule on its own.
		const at = (fields) => ({ updated_at: iso(T0), stage: "", delivery: "", ...fields });
		const plan = (c, opts = {}) => sendButton.startUpAction(c, { on: true, first: false, nowMs: T0, ...opts });
		eq(plan(at({ state: "queued" })), { action: "queue" }, "§10 startUpAction: a fresh press: it runs");
		eq(plan(at({ state: "queued" }), { on: false }), { action: "back", code: "BUTTON_OFF" }, "§10 startUpAction: the flag off: back");
		eq(plan(at({ state: "queued" }), { first: true }), { action: "back", code: "BUTTON_TOO_OLD" }, "§10 startUpAction: the trigger's first start: back");
		eq(plan(at({ state: "queued" }), { nowMs: T0 + HOUR }), { action: "queue" }, "§10 startUpAction: an hour old: it runs");
		eq(plan(at({ state: "queued" }), { nowMs: T0 + HOUR + 1 }), { action: "back", code: "BUTTON_TOO_OLD" }, "§10 startUpAction: over an hour: back");
		eq(plan({ state: "queued", stage: "", delivery: "", updated_at: "not a time" }), { action: "back", code: "BUTTON_TOO_OLD" }, "§10 startUpAction: a time it can't read: back");
		eq(plan(at({ state: "waiting" })), { action: "back", code: "BUTTON_TOO_OLD" }, "§10 startUpAction: a press left waiting: back");
		for (const opts of [{ on: false }, { first: true }, { nowMs: T0 + 2 * HOUR }, {}]) {
			eq(plan(at({ state: "working" }), opts), { action: "recover" }, `§10 startUpAction: working (${JSON.stringify(opts)}): recovered, which looks in Sent Mail, then back`);
			eq(plan(at({ state: "queued", delivery: "send", stage: "appending" }), opts), { action: "recover" }, `§10 startUpAction: SEND_UNCONFIRMED (${JSON.stringify(opts)}): only searched`);
			eq(plan(at({ state: "queued", stage: "appended", delivery: "send" }), opts), { action: "recover" }, `§10 startUpAction: past the send (${JSON.stringify(opts)}): only recorded`);
		}
	}
	{
		// A press that reaches attempt() in a process with the button off, by any way: back.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		w.seed(id, { state: "queued", button_send_json: JSON.stringify({ by: "made-up-admin", from: { state: "baseline", code: "" } }), next_attempt_at: iso(w.now) });
		w.env = { ...w.env, AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" };
		// The start date stays set: only the flag says no.
		const sweep = jobLib.create(w.deps({ env: { ...w.env, CHR_SEND_BUTTON_FROM: FROM } }));
		await sweep.work();
		eq([w.st(id), w.smtp.length, w.appends.length, w.calls.prepare, w.calls.look.length, w.actions("auto_invoice_button_back").map((a) => a.details.split(":")[0])],
			[["baseline", ""], 0, 0, 0, 0, ["BUTTON_OFF"]], "§10 work() on a press with the button off: back, default-deny, nothing read or paid for");
	}

	section("§11 Try again on a press");
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const record = JSON.stringify({ by: "made-up-admin", from: { state: "baseline", code: "" } });
		w.seed(id, { state: "needs_attention", reason_code: "DRAFT_FAILED", stage: "reserved", invoice_id: "10202026-3", button_send_json: record });
		const r = await w.retry(id);
		eq([r.status, r.body.code, w.st(id), w.smtp.length], [409, "AUTO_INVOICE_RETRY_REFUSED", ["needs_attention", "DRAFT_FAILED"], 0], "§11 FAILS ON THE OLD DESIGN (§7.5): a press before its send: Try again answers 409, nothing runs");
		const rows = [{ "Load ID": id, "Job Status": "Delivered", Email: CHR_EMAIL, "Completion Date": "10/20/2026 9:00:00" }];
		w.job.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: true });
		eq(rows[0]._autoInvoice.retry, "none", "§11 ...and the row says so, so the screen offers none");
	}
	{
		// A maybe-sent press: Try again only searches. Resume refuses until it's settled, so refusing
		// the search too would leave all sending stopped for good.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		w.smtpBehaviors = ["LOST"];
		await w.send(id, "§11 the lost answer");
		eq(w.st(id), ["needs_attention", "MAYBE_SENT"], "§11 MAYBE_SENT");
		w.db.exec("CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, user_id INTEGER, username TEXT, role TEXT, action TEXT, entity TEXT, entity_id TEXT, details TEXT)");
		let refused = null;
		try {
			resume.run({ db: w.db, dryRun: true });
		} catch (e) {
			refused = e instanceof resume.Refusal;
		}
		eq(refused, true, "§11 the resume script refuses while it's unconfirmed");
		const rows = [{ "Load ID": id, "Job Status": "Delivered", Email: CHR_EMAIL, "Completion Date": "10/20/2026 9:00:00" }];
		w.job.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: true });
		eq(rows[0]._autoInvoice.retry, "search", "§11 the row says Try again only searches");
		const messageId = w.claim(id).message_id;
		const first = await w.retry(id);
		eq(first.status, 200, "§11 Try again is taken");
		await until(() => w.open() === 0, "§11 the search");
		eq([w.st(id), w.smtp.length, w.appends.length, w.calls.prepare, w.calls.mint], [["needs_attention", "MAYBE_SENT"], 1, 0, 2, 1], "§11 not found: MAYBE_SENT again, no second SMTP call, no new paid call, no new number");
		w.sent.push(messageId);
		await w.retry(id);
		await until(() => w.open() === 0, "§11 the second search");
		const c = w.claim(id);
		eq([c.state, c.stage, c.delivery, w.smtp.length, w.appends.length], ["drafted", "recorded", "send", 1, 0], "§11 found: recorded as sent, one SMTP call");
		eq(resume.run({ db: w.db, dryRun: true }).changed, true, "§11 ...and the resume script can go on");
		eq((await w.retry(id)).status, 409, "§11 ...and a sent load has no Try again");
	}
	{
		const trigger = require(path.join(ROOT, "lib", "auto-invoice-trigger.js"));
		const press = { button_send_json: "{}" };
		eq(trigger.retryKind({ ...press, stage: "reserved", reason_code: "X" }, { couldSend: true }), "none", "§11 the rule: a press before its send: none");
		eq(trigger.retryKind({ ...press, stage: "appending", delivery: "send", reason_code: "MAYBE_SENT" }, { couldSend: true }), "search", "§11 ...one whose send started: search");
		eq(trigger.retryKind({ stage: "reserved", reason_code: "X" }, { couldSend: true }), "send", "§11 ...no press: as before");
		ok(trigger.retryRefusal({ ...press, stage: "" }), "§11 ...refused before its send");
		eq(trigger.retryRefusal({ ...press, stage: "appending", delivery: "send" }), null, "§11 ...not once it started");
		eq(trigger.retryRefusal({ stage: "" }), null, "§11 ...no press: as before");
	}

	section("§12 the saved paid check");
	{
		const w = makeWorld();
		await w.boot();
		const newest = newId();
		const middle = newId();
		const oldest = newId();
		w.ready(oldest, { "Status Update Date": "10/10/2026 9:00:00", "Completion Date": "10/10/2026 9:00:00" });
		w.ready(newest, { "Status Update Date": "10/19/2026 9:00:00", "Completion Date": "10/19/2026 9:00:00" });
		w.ready(middle, { "Status Update Date": "10/15/2026 9:00:00", "Completion Date": "10/15/2026 9:00:00" });
		const doubt = newId();
		w.ready(doubt, { "  Payment  ": "$1 + $2" });
		const other = newId();
		w.ready(other, { Email: "ops@example-broker.test" }, "billing@example-broker.test");
		const notSearched = newId();
		w.setRow(notSearched);
		w.addPod(notSearched);
		w.rateCons.set(rules.loadKey(notSearched), BILLING);
		const prepared = [];
		w.prepareHook = async (loadId) => { prepared.push(loadId); return null; };
		const one = await w.btn.runPaidChecks();
		eq([one, prepared], [{ checked: 2, temporary: 0 }, [newest, middle]], "§12 FAILS ON THE OLD CODE: at most 2 a run, newest first");
		eq([w.calls.prepare, w.calls.render, w.calls.mint, w.appends.length, w.smtp.length, w.calls.look.length], [2, 0, 0, 0, 0, 0], "§12 prepare() only: no render, no number, nothing in Gmail, no mail");
		eq(sendButton.readCheck(w.db, rules.loadKey(newest)).code, "", "§12 a pass is saved");
		eq((await w.state(newest)).body, { show: true }, "§12 ...so the button shows");
		eq((await w.state(oldest)).body.code, "PAID_CHECK_PENDING", "§12 ...not yet on the one waiting its turn");
		prepared.length = 0;
		eq(await w.btn.runPaidChecks(), { checked: 1, temporary: 0 }, "§12 the next run takes the rest");
		eq(prepared, [oldest], "§12 ...the load in doubt, another broker and a load never searched get none");
		prepared.length = 0;
		eq(await w.btn.runPaidChecks(), { checked: 0, temporary: 0 }, "§12 a passed load isn't asked again");
		eq(prepared, [], "§12 ...no paid call");

		w.setRow(newest, { "  Payment  ": "$1,100.00" });
		eq((await w.state(newest)).body.code, "PAID_CHECK_PENDING", "§12 its fingerprint changes: no button until it's checked again");
		await w.btn.runPaidChecks();
		eq(prepared, [newest], "§12 ...one more paid call");
		eq((await w.state(newest)).body, { show: true }, "§12 ...and the button returns");
		const saved = w.db.prepare(`SELECT * FROM ${sendButton.CHECKS_TABLE}`).all();
		eq(Object.keys(saved[0]), ["load_key", "code", "fingerprint_sha256", "checked_at"], "§12 the table: a load, a code, a hash and a time");
		ok(!JSON.stringify(saved).includes("@"), "§12 no address in it");
	}
	for (const [label, setup, code] of [
		["totals", (w) => { w.prepareHook = async () => ({ ok: false, http: 422, code: "TOTAL_MISMATCH" }); }, "TOTAL_MISMATCH"],
		["found only by reading Drive", (w) => { w.prepareHook = async () => ({ ok: false, http: 422, code: "RATECON_BY_CONTENT" }); }, "RATECON_BY_CONTENT"],
		["the billing address off the domain", (w, id) => w.rateCons.set(rules.loadKey(id), "billing@example-other.test"), "RECIPIENT_DOMAIN_MISMATCH"],
		["no billing address", (w) => { w.prepareHook = async () => ({ ok: false, http: 422, code: "NO_BILLING_EMAIL" }); }, "NO_BILLING_EMAIL"],
		["trailer", (w) => { w.prepareHook = async () => ({ ok: false, http: 409, code: "TRAILER_MISMATCH" }); }, "TRAILER_MISMATCH"],
		["a refusal it has no name for", (w) => { w.prepareHook = async () => ({ ok: false, http: 422, code: "SOMETHING_NEW" }); }, "DRAFT_REFUSED"],
	]) {
		const w = makeWorld();
		await w.boot();
		const id = newId();
		w.ready(id);
		setup(w, id);
		await w.btn.runPaidChecks();
		const r = await w.state(id);
		eq([r.body.show, r.body.code, r.body.line], [false, code, `Handle by hand: ${sendButton.whyOf(code)}`], `§12 ${label}: saved, and its one line`);
		const paid = w.calls.prepare;
		await w.btn.runPaidChecks();
		eq(w.calls.prepare, paid, `§12 ${label}: not asked again while the load stays the same`);
	}
	{
		// RATECON_MISSING reads the same as a Drive break: asked again after a day.
		const w = makeWorld();
		await w.boot();
		const id = newId();
		w.ready(id);
		w.rateCons.delete(rules.loadKey(id));
		await w.btn.runPaidChecks();
		eq((await w.state(id)).body.code, "RATECON_MISSING", "§12 RATECON_MISSING is saved");
		await w.btn.runPaidChecks();
		eq(w.calls.prepare, 1, "§12 ...not asked again that day");
		w.now += DAY - MIN;
		w.searched(id);
		await w.btn.runPaidChecks();
		eq(w.calls.prepare, 1, "§12 ...nor a minute short of a day");
		w.now += MIN;
		w.rateCons.set(rules.loadKey(id), BILLING);
		eq((await w.state(id)).body.code, "PAID_CHECK_PENDING", "§12 a day on, it isn't kept as final");
		await w.btn.runPaidChecks();
		eq([w.calls.prepare, (await w.state(id)).body], [2, { show: true }], "§12 ...it's asked again, and the rate con that turned up shows the button");
	}
	for (const [label, setup] of [
		["the engine throws", (w) => { w.prepareHook = async () => { throw new Error("made-up"); }; }],
		["a 500", (w) => { w.prepareHook = async () => ({ ok: false, http: 500, code: "" }); }],
		["Gemini down mid-read", (w) => { w.prepareHook = async () => ({ ok: false, http: 422, code: "RATECON_MISSING", geminiUnavailable: true }); }],
	]) {
		const w = makeWorld();
		await w.boot();
		const id = newId();
		w.ready(id);
		setup(w, id);
		eq(await w.btn.runPaidChecks(), { checked: 0, temporary: 1 }, `§12 ${label}: temporary: nothing saved`);
		eq([sendButton.readCheck(w.db, rules.loadKey(id)), (await w.state(id)).body.code], [null, "PAID_CHECK_PENDING"], `§12 ${label}: and asked again next run`);
	}
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		w.ready(id);
		w.geminiDownAt = w.now - MIN;
		eq([await w.btn.runPaidChecks(), w.calls.prepare], [{ checked: 0, temporary: 0 }, 0], "§12 the reader seen down: no paid call");
		w.geminiDownAt = null;
		ledger.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(w.now) });
		eq([await w.btn.runPaidChecks(), w.calls.prepare], [{ checked: 0, temporary: 0 }, 0], "§12 sending stopped: no paid call");
		ledger.clearSendStop(w.db);
		w.readFails = true;
		eq([await w.btn.runPaidChecks(), w.calls.prepare], [{ checked: 0, temporary: 0 }, 0], "§12 the sheet down: nothing, and no throw");
		w.readFails = false;

		// Through the pass: a step after a run that went well, and never after one that stopped.
		let ran = 0;
		w.evidence.afterRun(async () => { ran++; });
		const clean = await w.evidence.runOnce();
		eq([clean.ran, clean.stoppedAt, ran], [true, "", 1], "§12 the pass runs the step after a good run");
		const failingStep = await (async () => {
			w.evidence.afterRun(async () => { throw Object.assign(new Error("made-up"), { code: "MADE_UP" }); });
			return w.evidence.runOnce();
		})();
		eq([failingStep.ran, failingStep.stoppedAt], [true, ""], "§12 ...and its failure isn't the pass's");
		ok(w.logs.some((l) => /the step after the pass failed: MADE_UP/.test(l)), "§12 ...it's logged by code");
	}
	{
		// A pass that stopped on a refused login pays for nothing more.
		const w = makeWorld();
		await w.boot();
		const never1 = newId();
		w.setRow(never1);
		let ran = 0;
		const refusing = evidenceLib.create({
			db: w.db,
			env: { INVOICE_MAILBOX_PASS_ENABLED: "true" },
			now: () => new Date(w.now),
			readCompletedLoads: async () => ({ headers: HEADERS, rows: [...w.rows] }),
			readPaymentsTable: async () => w.payments,
			mailbox: () => w.mailbox,
			search: async () => { throw Object.assign(new Error("made-up"), { stage: "search" }); },
			gapMs: 0,
			setInterval: () => 0,
			timeZone: "America/New_York",
			log: { warn() {}, error() {} },
		});
		refusing.afterRun(async () => { ran++; });
		const out = await refusing.runOnce();
		eq([out.stoppedAt, ran], ["search", 0], "§12 a run that stopped on the mailbox: no paid step after it");
	}

	section("§13 what's kept and what's said");
	{
		const w = makeWorld();
		await w.boot();
		const id = newId();
		await w.armed(id);
		const p = await w.preview(id);
		const hold = gate();
		w.lookHook = () => hold.p;
		await w.press(id, p.body.token);
		const c = w.claim(id);
		ok(!c.button_send_json.includes("@"), "§13 no address on the claim's press: the digest holds a hash of it");
		const record = JSON.parse(c.button_send_json);
		eq(Object.keys(record).sort(), ["at", "by", "byId", "digest", "from", "v"], "§13 ...who, when, where from, the digest");
		eq(record.digest.recipient.length, 64, "§13 ...the recipient as a SHA-256");
		ok(sendButton.maskDigest({ recipient: BILLING }).recipient !== BILLING, "§13 ...masked");
		eq(rules.digestDifferences(sendButton.maskDigest({ recipient: BILLING }), sendButton.maskDigest({ recipient: "made-up.other@chrobinson.com" })).includes("recipient"), true, "§13 ...and another recipient still reads as a difference");
		hold.open();
		w.lookHook = null;
		await until(() => w.open() === 0, "§13 the run");
		const everything = JSON.stringify([p.body, w.audits, w.notices, w.claim(id).button_send_json, w.logs, w.smtp[0]]);
		for (const word of [DRIVER_NAME, DRIVER_PHONE]) ok(!everything.includes(word), `§13 "${word}" appears in no answer, audit row, notice, log or message`);
		eq(w.smtp.length, 1, "§13 sent");
		ok(!/chrobinson\.com/.test(JSON.stringify(w.logs)), "§13 no recipient in a log line");
	}
	{
		// A refusal says why in one line, and one line only.
		for (const code of Object.keys(sendButton.WHY)) {
			const words = sendButton.errorOf(code);
			ok(/^[A-Z].*\.$/.test(words) && !words.includes("\n"), `§13 ${code} reads as one sentence`);
		}
		eq(sendButton.lineOf("STOPPED"), "", "§13 the Stop has no line on a load");
		eq(sendButton.lineOf("NOT_NONE_FOUND"), "", "§13 ...nor a load whose status says why");
		eq(sendButton.lineOf("CLOSED_MONTH"), "Handle by hand: its month is closed", "§13 ...a closed month does");
		eq(sendButton.whyOf("NOT_A_CODE"), sendButton.WHY.DRAFT_REFUSED, "§13 ...and a code it has no words for still says something true");
	}
	{
		const w = makeWorld();
		await w.boot();
		const status = w.job.status();
		eq(status.button, { on: true, from: FROM }, "§13 the status route can read it back");
		w.sendDomains = ["chrobinson.com", "example-broker.test"];
		await w.restart();
		const ok1 = w.job.button.recipientOk;
		eq([ok1(BILLING), ok1("billing@example-broker.test"), ok1("billing@loads.chrobinson.com"), ok1("")], [true, false, false, false], "§13 only chrobinson.com, even with another domain on the send list");
		w.sendDomains = ["example-broker.test"];
		await w.restart();
		eq(w.job.button.recipientOk(BILLING), false, "§13 ...and only while it's on the send list");
	}

	await throughTheBlocks();
}

// ── §14: server.js's blocks and the engine as shipped ──────────────────────────────────────────

async function throughTheBlocks() {
	section("§14 through server.js's blocks, the engine as shipped");
	const SRC = require("./lib/server-source").serverSource();
	const blockOf = (name) => {
		const start = `// <${name}>`;
		const end = `// </${name}>`;
		ok(SRC.split(start).length === 2 && SRC.split(end).length === 2 && SRC.indexOf(end) > SRC.indexOf(start), `§14 one <${name}> block`);
		return SRC.slice(SRC.indexOf(start), SRC.indexOf(end) + end.length);
	};
	const JOB_BLOCK = blockOf("auto-invoice-wiring");
	const STATUS_BLOCK = blockOf("invoice-status-wiring");
	const BUTTON_BLOCK = blockOf("invoice-send-button-wiring");
	ok(SRC.indexOf("// <auto-invoice-wiring>") < SRC.indexOf("// <invoice-status-wiring>") && SRC.indexOf("// <invoice-status-wiring>") < SRC.indexOf("// <invoice-send-button-wiring>"), "§14 the button's block comes after the job's and the status's");
	ok(!/\bapp\.(get|post|put|delete)\(/.test(BUTTON_BLOCK), "§14 no route is written in server.js: the block only mounts them");
	ok(!/sendMail|sendEmail|appendGmailDraft|values\.(update|batchUpdate|append|clear)/.test(BUTTON_BLOCK), "§14 nothing in the block sends mail or writes a sheet");
	ok(/\breplica: Boolean\(REPLICA\),/.test(JOB_BLOCK), "§14 the job knows it's a replica, and keeps the button off there");
	ok(/lookInMailbox: autoInvoiceLook\.searchMailboxForLoad/.test(JOB_BLOCK), "§14 the live look is the real search, whose answer refreshes the saved row");

	const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "route-snapshot.txt"), "utf8");
	for (const route of ["GET /api/auto-invoice/loads/:loadKey/send-now ·", "POST /api/auto-invoice/loads/:loadKey/send-now ·", "POST /api/auto-invoice/loads/:loadKey/send-now/preview ·"]) {
		ok(fixture.includes(route), `§14 the route snapshot lists ${route.slice(0, -2)}`);
	}
	const template = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
	for (const name of ["CHR_SEND_BUTTON_ENABLED", "CHR_SEND_BUTTON_FROM"]) ok(new RegExp(`^# ${name}=$`, "m").test(template), `§14 the settings template names ${name}, commented out`);
	const replicaRules = require(path.join(ROOT, "lib", "replica-rules.js"));
	ok(/SMTP/.test(replicaRules.ENABLE_REFUSED.CHR_SEND_BUTTON_ENABLED || ""), "§14 --enable refuses the flag on a replica, saying why");

	const { closure } = require("./lib/server-lift.js");
	const express = require(path.join(ROOT, "node_modules", "express"));
	const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
	const realImap = require(path.join(ROOT, "lib", "imap-draft.js"));
	const appTime = require(path.join(ROOT, "lib", "app-time.js"));
	const serverRequire = createRequire(path.join(ROOT, "server.js"));

	const TODAY = appTime.dayInZone(new Date(), appTime.appTimeZone());
	const [TY, TM, TD] = TODAY.split("-");
	const DELIVERED_ON = `${TM}/${TD}/${TY}`;
	const COLS = ["Load ID", "Job Status", "Email", "Broker Contact Name", "Driver", "Driver Phone", "Trailer Number", "Completion Date", "  Payment  "];
	const MAIL = Object.freeze({ GMAIL_USER: "drafts@example.com", GMAIL_APP_PASSWORD: "made-up-app-password" });
	const ON = Object.freeze({ AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_SEND_ENABLED: "true", AUTO_INVOICE_SEND_DOMAINS: "chrobinson.com", INVOICE_MAILBOX_PASS_ENABLED: "true", ...MAIL });
	const BUTTON = Object.freeze({ CHR_SEND_BUTTON_ENABLED: "true", CHR_SEND_BUTTON_FROM: "2000-01-01" });
	const ADMIN = Object.freeze({ id: 1, username: "made_up_admin", role: "Super Admin" });
	const DISPATCHER = Object.freeze({ id: 2, username: "made_up_dispatcher", role: "Dispatcher" });
	const pdfWith = (contentStream) => {
		const z = zlib.deflateSync(Buffer.from(contentStream, "latin1"));
		return Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj<</Length ${z.length}/Filter/FlateDecode>>stream\n`, "latin1"), z, Buffer.from("\nendstream endobj\n%%EOF", "latin1")]);
	};
	const rateCon = () => pdfWith(`BT (Billing Information: Order #: 1001001 PO #: PO-77 Move #: 5501) Tj (Total Rate: $1,500.00) Tj (Email the signed POD and all billing documents to ${BILLING}) Tj ET`);

	const PROVIDED = ["db", "brokerInvoice", "console", "process", "require", "getSheets", "getDrive", "SPREADSHEET_ID", "GEMINI_API_KEY",
		"runRateConGemini", "renderHtmlToPdf", "DATA_DIR", "path", "fs", "RATECON_DRIVE_FOLDER_ID", "__dirname"];
	const LIFT = closure(SRC, {
		roots: ["brokerInvoiceDraft", "nextInvoiceNumber", "peekInvoiceNumber", "sheetDayKey", "integrityClosedMonthsOf", "logAudit", "requireRole", "parseSheet", "deduplicateLoads", "insertDispatchNotification"],
		provided: PROVIDED,
		denied: ["app", "server", "io", "getJobTrackingCached", "REPLICA", "autoInvoice", "invoiceEvidence", "invoiceSendButton"],
	});
	const createSql = (name) => {
		const at = SRC.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
		if (at < 0) throw new Error(`server.js creates no ${name} table`);
		return SRC.slice(at, SRC.indexOf("`", at));
	};
	const TABLES = ["audit_trail", "documents", "deleted_loads", "load_invoice_drafts", "bison_invoice_seq", "dispatch_notifications", "app_settings", "period_locks"];
	const ALTERS = [...SRC.matchAll(/db\.exec\("(ALTER TABLE (?:documents|load_invoice_drafts) ADD COLUMN [^"]+)"\)/g)].map((m) => m[1]);
	const open = [];

	const world = async ({ env, replica = null } = {}) => {
		const w = {
			env: { ...env },
			sheet: [COLS.slice()],
			drive: [],
			calls: { gemini: 0, mint: 0, prepare: 0, look: 0, smtp: 0 },
			smtp: [],
			looks: [],
			lookAnswer: { verdict: "clean", mailboxes: { drafts: box(), sent: box(), trash: box() } },
			payments: [[...PAYMENTS_HEADERS]],
			limited: 0,
			crossSite: 0,
			out: [],
			dir: fs.mkdtempSync(path.join(os.tmpdir(), "chr-send-button-")),
		};
		fs.mkdirSync(path.join(w.dir, "uploads"));
		const db = new Database(":memory:");
		w.db = db;
		for (const t of TABLES) db.exec(createSql(t));
		for (const a of ALTERS) db.exec(a);
		const quiet = { log: (...a) => w.out.push(a.join(" ")), info() {}, warn() {}, error() {} };
		const proc = { env: w.env };
		const sheets = { spreadsheets: { values: {
			get: async ({ range } = {}) => ({ data: { values: (range === "Payments Table" ? w.payments : w.sheet).map((r) => r.slice()) } }),
		} } };
		const drive = { files: {
			list: async ({ q } = {}) => {
				const m = /name contains '([^']*)'/.exec(String(q || ""));
				return { data: { files: w.drive.filter((f) => !m || f.name.includes(m[1])).map((f) => ({ id: f.id, name: f.name, createdTime: "2026-10-01T12:00:00Z" })) } };
			},
			get: async ({ fileId } = {}) => ({ data: w.drive.find((x) => x.id === fileId).bytes }),
		} };
		const runRateConGemini = async () => {
			w.calls.gemini++;
			return { "Total Rate": null, Rate: null, "Order Number": null, "PO Number": null, "Documents Email": null };
		};
		const renderHtmlToPdf = async (html) => textPdf(rules.htmlToText(html));
		const H = new Function(...PROVIDED, `${LIFT.text}\nreturn { ${LIFT.names.join(", ")} };`)(
			db, brokerInvoice, quiet, proc, serverRequire, async () => sheets, async () => drive, "made-up-sheet", "made-up-gemini-key",
			runRateConGemini, renderHtmlToPdf, w.dir, path, fs, "made-up-ratecon-folder", ROOT,
		);
		const engine = H.brokerInvoiceDraft;
		const prepare = engine.prepare;
		engine.prepare = (args) => { w.calls.prepare++; return prepare(args); };
		const searchModule = {
			searchMailboxForLoad: async (opts) => {
				w.calls.look++;
				w.looks.push(opts);
				return w.lookAnswer;
			},
		};
		const realApp = express();
		realApp.use(express.json());
		realApp.use((req, res, next) => {
			const u = req.headers["x-test-user"];
			req.session = u ? { user: JSON.parse(u) } : {};
			next();
		});
		const scope = {
			require: (p) => (p === "./lib/invoice-mailbox-search" ? searchModule : serverRequire(p)),
			getSheets: async () => sheets,
			SPREADSHEET_ID: "made-up-sheet",
			jtCacheInvalidate: () => {},
			db,
			process: proc,
			console: quiet,
			getJobTrackingCached: async () => {
				const parsed = H.parseSheet({ values: w.sheet.map((r) => r.slice()) });
				parsed.data = H.deduplicateLoads(parsed.data, parsed.headers);
				return parsed;
			},
			excludeDroppedLoads: (rows) => rows,
			integrityClosedMonthsOf: H.integrityClosedMonthsOf,
			sheetDayKey: H.sheetDayKey,
			path,
			DATA_DIR: w.dir,
			brokerInvoiceDraft: engine,
			nextInvoiceNumber: (date) => { w.calls.mint++; return H.nextInvoiceNumber(date); },
			peekInvoiceNumber: H.peekInvoiceNumber,
			appendGmailDraft: async () => { throw new Error("made-up: a press must never make a draft"); },
			REPLICA: replica,
			logAudit: H.logAudit,
			insertDispatchNotification: H.insertDispatchNotification,
			io: { to: () => ({ emit() {} }) },
			app: realApp,
			requireRole: H.requireRole,
			refuseCrossSite: (req, res, next) => { w.crossSite++; next(); },
			startsJob: () => true,
			setInterval: () => 0,
			nodemailer: { createTransport: () => ({
				verify: async () => true,
				sendMail: async (m) => {
					w.calls.smtp++;
					const mime = await realImap.buildMime(m);
					w.smtp.push({ to: m.to, envelope: m.envelope, subject: m.subject, html: m.html, attachments: (m.attachments || []).map((a) => a.filename), bytes: (m.attachments || []).map((a) => a.content), mime: mime.toString("latin1") });
					return { accepted: [m.to], rejected: [] };
				},
				close: () => {},
			}) },
			rateLimit: () => (req, res, next) => { w.limited++; next(); },
		};
		const names = Object.keys(scope);
		const blocks = `${JOB_BLOCK}\n${STATUS_BLOCK}\n${BUTTON_BLOCK}`.replace(/\brateConGeminiUnavailableAt\b/g, "0");
		Object.assign(w, new Function(...names, `${blocks}\nreturn { job: autoInvoice, evidence: invoiceEvidence, button: invoiceSendButton };`)(...names.map((n) => scope[n])));
		// What's left after every route: what a request meets when no route is there.
		realApp.get("/api/*", (req, res) => res.status(200).type("html").send("the app page"));
		w.server = await new Promise((resolve) => { const s = realApp.listen(0, "127.0.0.1", () => resolve(s)); });
		const base = `http://127.0.0.1:${w.server.address().port}`;
		w.call = async (method, url, user, body) => {
			const headers = { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" };
			if (user) headers["x-test-user"] = JSON.stringify(user);
			const resp = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
			const text = await resp.text();
			let json = null;
			try { json = JSON.parse(text); } catch { /* not JSON */ }
			return { status: resp.status, json, text };
		};
		w.close = async () => {
			await new Promise((r) => w.server.close(() => r()));
			fs.rmSync(w.dir, { recursive: true, force: true });
		};
		w.setLoad = (id, over = {}) => {
			const row = { "Load ID": id, "Job Status": "Delivered", Email: CHR_EMAIL, "Broker Contact Name": "Made-up Agent", Driver: DRIVER_NAME, "Driver Phone": DRIVER_PHONE, "Trailer Number": "", "Completion Date": DELIVERED_ON, "  Payment  ": "1500", ...over };
			w.sheet.push(COLS.map((h) => row[h]));
		};
		w.deliver = (id) => {
			w.setLoad(id);
			const name = `${id}_POD.pdf`;
			fs.writeFileSync(path.join(w.dir, "uploads", name), `%PDF-1.4 made-up POD for ${id}`);
			db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_url, uploaded_at) VALUES (?, 'Made-up Driver Name', 'POD', ?, ?, datetime('now', '-5 minutes'))").run(id, name, `/uploads/${name}`);
			w.drive.push({ id: `made-up-file-${w.drive.length + 1}`, name: `Subject: Rate Confirmation ${id}.pdf`, bytes: rateCon() });
			evidenceLib.saveAnswer(db, rules.loadKey(id), { verdict: "clean", mailboxes: { drafts: box(), sent: box(), trash: box() } }, { nowIso: new Date().toISOString(), paymentsAt: new Date().toISOString() });
		};
		w.st = (id) => {
			const c = db.prepare("SELECT state, reason_code FROM auto_invoice_claims WHERE load_key = ?").get(rules.loadKey(id));
			return c ? [c.state, c.reason_code] : null;
		};
		w.audits = (action) => db.prepare("SELECT username, role, entity_id, details FROM audit_trail WHERE action = ? ORDER BY id").all(action);
		w.drafts = () => db.prepare("SELECT load_id, invoice_id, recipient, via FROM load_invoice_drafts ORDER BY id").all();
		w.tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
		open.push(w);
		return w;
	};
	const URL_OF = (id, tail = "") => `/api/auto-invoice/loads/${id}/send-now${tail}`;
	const waitFor = async (cond, label) => {
		const end = Date.now() + 30000;
		while (Date.now() < end) {
			if (cond()) return true;
			await new Promise((r) => setTimeout(r, 2));
		}
		failures.push(`${label}: the condition was never met`);
		return false;
	};

	try {
		{
			const w = await world({ env: ON });
			eq([w.button.on, w.job.button.on], [false, false], "§14 the flag named nowhere: off");
			ok(w.out.includes("[invoice-send-button] off"), "§14 ...the start-up line says so");
			await w.job.finishStartUp();
			w.deliver("900000701");
			const before = w.tables();
			const state = await w.call("GET", URL_OF("900000701"), ADMIN);
			const preview = await w.call("POST", URL_OF("900000701", "/preview"), ADMIN, {});
			const send = await w.call("POST", URL_OF("900000701"), ADMIN, { token: "made-up" });
			const absent = await w.call("POST", URL_OF("900000701", "/not-a-route"), ADMIN, {});
			eq([state.status, state.text], [200, "the app page"], "§14 flag off: a GET reaches the app page, as an unknown path does");
			eq([preview.status, send.status, preview.text === absent.text, send.text.replace(/send-now\b/, "x") === absent.text.replace(/send-now\/not-a-route/, "x")], [404, 404, false, true], "§14 flag off: a POST gets Express's own 404, as an unknown path does");
			ok(/Cannot POST/.test(preview.text), "§14 ...its own page, not a JSON answer");
			const anon = await w.call("POST", URL_OF("900000701", "/preview"), null, {});
			eq(anon.status, 404, "§14 ...and with no session too, so the routes can't be told from absent");
			eq([w.limited, w.crossSite, w.calls.prepare, w.calls.look, w.calls.mint, w.calls.smtp, w.st("900000701"), w.tables()], [0, 0, 0, 0, 0, 0, null, before], "§14 flag off: no rate limit used, no paid call, no mail, no claim, no table");
		}
		{
			const w = await world({ env: { ...ON, ...BUTTON }, replica: { fetch: async () => null } });
			eq([w.button.on, w.job.button.on], [false, false], "§14 a replica: off, whatever its settings say");
		}
		{
			const w = await world({ env: { ...ON, CHR_SEND_BUTTON_ENABLED: "true" } });
			eq([w.button.on, (await w.call("POST", URL_OF("900000701", "/preview"), ADMIN, {})).status], [false, 404], "§14 CHR_SEND_BUTTON_FROM unset gives no button");
		}
		{
			const w = await world({ env: { ...ON, ...BUTTON } });
			eq([w.button.on, w.job.button.on, w.job.triggerMode], [true, true, true], "§14 FAILS ON THE OLD CODE: the flag on, a start date, the trigger and sending: on");
			ok(w.out.includes("[invoice-send-button] on"), "§14 ...the start-up line says so");
			await w.job.finishStartUp();
			eq((await w.call("PUT", "/api/auto-invoice/settings", ADMIN, { optOutDomains: [], confirmedBrokerDomains: ["chrobinson.com"] })).status, 200, "§14 chrobinson.com confirmed");
			const id = "900000702";
			w.deliver(id);

			const pending = await w.call("GET", URL_OF(id), ADMIN);
			eq([pending.status, pending.json], [200, { show: false, code: "PAID_CHECK_PENDING", line: `Handle by hand: ${sendButton.WHY.PAID_CHECK_PENDING}` }], "§14 before its paid check: no button, one line");
			eq((await w.evidence.runOnce()).ran, true, "§14 the pass runs");
			eq(w.calls.mint, 0, "§14 ...its step after the run: the paid check: no number");
			eq(sendButton.readCheck(w.db, id).code, "", "§14 ...the engine as shipped passes the rate con");
			eq([w.calls.smtp, w.st(id)], [0, null], "§14 ...no mail, no claim");
			const shows = await w.call("GET", URL_OF(id), ADMIN);
			eq([shows.status, shows.json], [200, { show: true }], "§14 FAILS ON THE OLD CODE: the button shows");
			eq((await w.call("GET", URL_OF(id), DISPATCHER)).status, 403, "§14 a Dispatcher: refused");
			eq((await w.call("POST", URL_OF(id, "/preview"), DISPATCHER, {})).status, 403, "§14 ...on the preview too");
			eq((await w.call("POST", URL_OF(id), DISPATCHER, { token: "made-up" })).status, 403, "§14 ...and the press");
			eq((await w.call("GET", URL_OF(id), null)).status, 401, "§14 no session: refused");

			const preparedBefore = w.calls.prepare;
			const preview = await w.call("POST", URL_OF(id, "/preview"), ADMIN, {});
			eq(preview.status, 200, `§14 FAILS ON THE OLD CODE: the preview, through the engine as shipped (${JSON.stringify(preview.json)})`);
			eq([preview.json.loadId, preview.json.amount, preview.json.to, preview.json.attachments.length], [id, "$1,500.00", BILLING, 3], "§14 the confirm: the rate con's billing address and the invoice total, from the server");
			eq([w.calls.prepare - preparedBefore, w.calls.mint, w.calls.smtp, w.st(id)], [1, 0, 0, null], "§14 one paid read, no number, no mail, no claim");
			eq([w.looks[0].includeTrash, w.looks[0].lastCheck, w.looks[0].quiet], [true, true, undefined], "§14 the real search's options: Trash, by subject, and it reports its answer for the saved row");
			ok(w.limited >= 1 && w.crossSite >= 1, "§14 through the cross-site guard and the limiter");

			const press = await w.call("POST", URL_OF(id), ADMIN, { token: preview.json.token });
			eq([press.status, press.json], [200, { ok: true, loadId: id }], "§14 FAILS ON THE OLD CODE: the press");
			await waitFor(() => w.calls.smtp === 1 && w.db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims WHERE state IN ('queued', 'working')").get().n === 0, "§14 the send");
			eq(w.st(id), ["drafted", ""], "§14 FAILS ON THE OLD CODE: sent, and recorded");
			const again = await w.call("POST", URL_OF(id), ADMIN, { token: preview.json.token });
			eq([again.status, w.calls.smtp], [409, 1], "§14 the same token again: refused, one SMTP call");
			const mail = w.smtp[0];
			eq([mail.to, mail.envelope.to], [BILLING, [BILLING]], "§14 one recipient, on chrobinson.com");
			ok(/Invoice Order #900000702\.pdf$/.test(mail.attachments[0]) && mail.attachments[2] === "900000702.pdf" && mail.attachments.length === 3, "§14 the invoice, the POD and the rate con");
			const shownInvoice = require(path.join(ROOT, "lib", "pdf-shown-text.js")).shownText(mail.bytes[0]);
			ok(/Invoice ?ID ?#/.test(shownInvoice) && /1,500\.00/.test(shownInvoice), "§14 the invoice as the renderer printed it");
			for (const word of [DRIVER_NAME, DRIVER_PHONE, "Made-up Agent"]) {
				ok(![mail.subject, mail.html, shownInvoice, mail.mime, ...mail.attachments].some((t) => String(t).includes(word)), `§14 "${word}" appears in no subject, body, invoice or file name LogisX composed`);
			}
			eq(w.drafts().map((r) => [r.load_id, r.recipient, r.via]), [[id, BILLING, "auto-smtp"]], "§14 one row: the job's own");
			eq(w.audits("auto_invoice_button_press").map((a) => [a.username, a.role, a.entity_id]), [["made_up_admin", "Super Admin", id]], "§14 the press's audit row names the account");
			eq(w.audits("auto_invoice_sent").length, 1, "§14 the same audit trail: auto_invoice_sent");
			eq(w.audits("invoice_draft_created").length, 1, "§14 ...and invoice_draft_created");
			eq([w.audits("auto_invoice_button_back").length, w.calls.mint], [0, 1], "§14 nothing went back, one number");
			const status = await w.call("GET", "/api/auto-invoice/status", ADMIN);
			eq(status.json.button, { on: true, from: "2000-01-01" }, "§14 the status route reads it back");
		}
		{
			// A failed live search in the run, through the block's own note on the saved row.
			const w = await world({ env: { ...ON, ...BUTTON } });
			await w.job.finishStartUp();
			await w.call("PUT", "/api/auto-invoice/settings", ADMIN, { optOutDomains: [], confirmedBrokerDomains: ["chrobinson.com"] });
			const id = "900000703";
			w.deliver(id);
			await w.evidence.runOnce();
			const preview = await w.call("POST", URL_OF(id, "/preview"), ADMIN, {});
			eq(preview.status, 200, "§14 the preview");
			w.lookAnswer = null;
			await w.call("POST", URL_OF(id), ADMIN, { token: preview.json.token });
			await waitFor(() => w.st(id) && w.st(id)[0] === "baseline", "§14 back");
			eq([w.calls.smtp, w.calls.mint, evidenceLib.savedRow(w.db, id).result], [0, 0, "failed"], "§14 a live search that can't be read: nothing sent, no number, and the saved row says it failed");
			const after = await w.call("GET", URL_OF(id), ADMIN);
			eq([after.json.show, after.json.code], [false, "NOT_NONE_FOUND"], "§14 ...so the button doesn't return on old evidence");
		}
	} finally {
		for (const w of open) await w.close();
	}
}

let finished = false;
process.on("exit", (code) => {
	if (!finished && code === 0) {
		console.log("  FAIL the runner stopped before its end: a run nothing answers can't read as a pass");
		process.exitCode = 1;
	}
});
main().then(() => {
	finished = true;
	for (const f of failures) console.log(`  FAIL ${f}`);
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(failures.length ? 1 : 0);
}).catch((e) => {
	finished = true;
	console.log(`  FAIL threw: ${(e && e.stack) || e}`);
	for (const f of failures) console.log(`  FAIL ${f}`);
	process.exit(1);
});
