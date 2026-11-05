#!/usr/bin/env node
/**
 * The automatic invoice drafts as server.js wires them: the <auto-invoice-wiring>
 * block, lifted from server.js's text, run with the job (lib/auto-invoice-job.js) and
 * the Draft Invoice button's engine (lib/broker-invoice-draft.js) as shipped. The
 * engine is built by server.js's own statement, and every server.js helper the block
 * and the engine use is lifted too (scripts/lib/server-lift.js), over an in-memory
 * database and a temp uploads folder. Only the outside world is made up: Job
 * Tracking (Sheets), the rate-con Drive folder, Gemini, the PDF renderer, and Gmail,
 * which keeps every draft it is handed, built into MIME by lib/imap-draft.js, and
 * answers a search by Message-ID, as scripts/e2e/fake-gmail.cjs does. The routes run
 * on a real Express app on 127.0.0.1 behind server.js's requireRole.
 *
 *   §1 off: no route, no timer (startsJob() never asked), no table (sqlite_master
 *      unchanged), a completed row left as it was
 *   §2 shadow: deliveries are logged with their verdicts and nothing is paid for: no
 *      engine, Drive, Gemini, renderer, invoice-number, Gmail or direct Sheets call
 *   §3 on, a draft end to end: the first sweep leaves what was already delivered to
 *      people; a load delivered after it gets one Gmail draft, to the rate con's
 *      billing email on the broker's confirmed domain, with one number, one draft row
 *      and the system's audit row, and its claim keeps the row record() answered; the
 *      next sweep drafts nothing more; Super Admins see it, Dispatchers don't; a load
 *      changed after its draft gives one Super Admin-only notice, then Mark checked
 *   §4 the recipient anchor: a broker domain nobody confirmed, and a billing email on
 *      another domain: Needs attention, no number, no Gmail; Try again
 *   §5 a rate-con total that wasn't read: Needs attention (RATECON_TOTAL_UNREAD), no
 *      number, no Gmail
 *   §6 the outside world busy or down: a busy renderer reaches the job as
 *      RENDERER_BUSY, its one name (no attempt used, nothing in Gmail); ingestion's
 *      Gemini latch holds a non-Bison load back (GEMINI_DOWN) with no engine call
 *   §7 the timer (every 5 minutes behind startsJob(), one tick at a time, a failed
 *      tick logged by its code), a replica's start, server.js around the block, and
 *      the settings template's entries for the job's four settings
 *   §8 three paths no case reached before: the claim keeps the row record() wrote
 *      even when an older automatic row has its number; a Bison load drafted through
 *      the block to BISON_INVOICE_EMAIL (a block reading a misnamed setting is
 *      caught); a draft in Gmail whose row wasn't written, recovered through the real
 *      engine's render and recorded only because it matches what went to Gmail
 *   §9 the render shadow (AUTO_INVOICE_SHADOW_RENDERS_ENABLED): on only when exactly
 *      "true", in shadow mode, never in a replica; with a renderer that writes the
 *      invoice's text as Chromium does, the shadow's stored digest of load
 *      123456789 equals the digest of the MIME real drafts handed Gmail for it (and
 *      the claim's own), the report's six conditions hold on that MIME, and the
 *      shadow paid for no number, Gmail call, record() or audit row
 *  §10 sending through the block (AUTO_INVOICE_SEND_ENABLED), the engine as shipped
 *  §11 the settle window through the block: a POD a minute old holds the send for
 *      60 minutes after its own stamp, with no engine call; the block's
 *      AUTO_INVOICE_SEND_SETTLE_MINUTES reaches the job (a whole number 0-1440, else 60)
 *  §12 the driver's Delivered through PUT /api/driver/status as shipped and the block,
 *      the engine as shipped (AUTO_INVOICE_DRIVER_TRIGGER_ENABLED, named nowhere): no
 *      timer; a Driver's tap: the record before the sheet write, one SMTP call after the
 *      answer; a Dispatcher's and a Super Admin's: none; a sheet write that reports failure
 *      but landed; a throw after the write; a repeat tap; a replica; Try again's look
 *  §13 only this route starts one, and server.js around it (text pins)
 *  §14 a blank Email through the route, the block and the engine as shipped
 *      (AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED, named nowhere): one SMTP call to the rate
 *      con's address, the contact's name nowhere in the MIME; a malformed cell; too few
 *      rows; Try again's look; the kill switch
 *
 * Made-up loads only (LD-TEST-…, example-broker.test). No network beyond the
 * loopback listener; never reads app.db. Fails on a tree without the block.
 * Run: node scripts/test-auto-invoice-wiring.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();
const START = "// <auto-invoice-wiring>";
const END = "// </auto-invoice-wiring>";
if (SRC.split(START).length !== 2 || SRC.split(END).length !== 2 || SRC.indexOf(END) < SRC.indexOf(START)) {
	console.log("FAIL  server.js has no single <auto-invoice-wiring> block");
	process.exit(1);
}
const BLOCK = SRC.slice(SRC.indexOf(START), SRC.indexOf(END) + END.length);

const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const express = require(path.join(ROOT, "node_modules", "express"));
const { closure, liftRoute, indexDeclarations } = require(path.join(__dirname, "lib", "server-lift.js"));
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
const realImap = require(path.join(ROOT, "lib", "imap-draft.js"));
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const appTime = require(path.join(ROOT, "lib", "app-time.js"));
const { textPdf } = require(path.join(__dirname, "lib", "made-up-pdf.js"));
const serverRequire = createRequire(path.join(ROOT, "server.js"));
// Absent from a tree before the render shadow: §9 fails by name instead.
const optional = (p) => {
	try {
		return require(p);
	} catch {
		return null;
	}
};
const mimeRead = optional(path.join(ROOT, "lib", "mime-read.js"));
const trialReport = optional(path.join(ROOT, "scripts", "auto-invoice-send-trial-report.js"));

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

// ------------------------------------------------------------------ made-up data
const HEADERS = ["Load ID", "Job Status", "Email", "Broker Contact Name", "Driver", "Trailer Number", "Completion Date", "  Payment  "];
const BROKER = "ops@example-broker.test";
const BILLING = "billing@example-broker.test";
const MAILBOX = Object.freeze({ GMAIL_USER: "drafts@example.com", GMAIL_APP_PASSWORD: "made-up-app-password" });
const SHADOW_ENV = Object.freeze({ AUTO_INVOICE_DRAFTS_ENABLED: "true", ...MAILBOX });
// The 5-minute sweep, §12 and §13 turn the driver's trigger on; off leaves every case here exact.
const ON_ENV = Object.freeze({ AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false", ...MAILBOX });
const SA = Object.freeze({ id: 1, username: "made_up_admin", role: "Super Admin" });
const DISP = Object.freeze({ id: 2, username: "made_up_dispatcher", role: "Dispatcher" });
const CONFIRMED = Object.freeze({ optOutDomains: [], confirmedBrokerDomains: ["example-broker.test"] });
// Delivered today on the app's clock: the first sweep's baseline holds a load
// delivered on an earlier day.
const TODAY = appTime.dayInZone(new Date(), appTime.appTimeZone());
const [TY, TM, TD] = TODAY.split("-");
const DELIVERED_ON = `${TM}/${TD}/${TY}`;
const TODAY_SEQ = `${TM}${TD}${TY}`;

function pdfWith(contentStream) {
	const z = zlib.deflateSync(Buffer.from(contentStream, "latin1"));
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n1 0 obj<</Length ${z.length}/Filter/FlateDecode>>stream\n`, "latin1"),
		z,
		Buffer.from("\nendstream endobj\n%%EOF", "latin1"),
	]);
}
// A billing block the free scan reads whole: Order #, total and the documents email.
const rateCon = ({ total = "$1,500.00", docs = BILLING } = {}) => pdfWith(
	`BT (Billing Information: Order #: 1001001 PO #: PO-77 Move #: 5501) Tj (Total Rate: ${total}) Tj ` +
	`(Email the signed POD and all billing documents to ${docs}) Tj ET`,
);
// No billing block: the free scan finds the documents email only, so the total is
// Gemini's to read.
const plainRateCon = (docs) => pdfWith(`BT (Load confirmation for a made-up shipment) Tj (Send billing documents to ${docs}) Tj ET`);

// ------------------------------------------------------------------ server.js, lifted
// The engine as server.js builds it, and the helpers the block hands the job.
const PROVIDED = ["db", "brokerInvoice", "console", "process", "require", "getSheets", "getDrive", "SPREADSHEET_ID", "GEMINI_API_KEY",
	"runRateConGemini", "renderHtmlToPdf", "DATA_DIR", "path", "fs", "RATECON_DRIVE_FOLDER_ID", "__dirname"];
const LIFT = closure(SRC, {
	roots: ["brokerInvoiceDraft", "nextInvoiceNumber", "sheetDayKey", "integrityClosedMonthsOf", "logAudit", "requireRole",
		"parseSheet", "deduplicateLoads", "insertDispatchNotification", "noticeTypeScope"],
	provided: PROVIDED,
	denied: ["app", "server", "io", "getJobTrackingCached", "REPLICA", "autoInvoice"],
});
const createSql = (name) => {
	const at = SRC.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
	if (at < 0) throw new Error(`server.js creates no ${name} table`);
	return SRC.slice(at, SRC.indexOf("`", at));
};
const TABLES = ["audit_trail", "documents", "deleted_loads", "load_invoice_drafts", "bison_invoice_seq", "dispatch_notifications", "app_settings", "period_locks"];
const ALTERS = [...SRC.matchAll(/db\.exec\("(ALTER TABLE (?:documents|load_invoice_drafts) ADD COLUMN [^"]+)"\)/g)].map((m) => m[1]);
const DASH_HEAD = 'app.get("/api/dashboard", requireRole("Super Admin", "Dispatcher"), async (req, res) => {';
const STATUS_HEAD = SRC.split("\n").find((l) => l.startsWith('app.put("/api/driver/status",'));
const STATUS_INDEX = indexDeclarations(SRC);

function deepFreeze(o) {
	if (o && typeof o === "object" && !Object.isFrozen(o)) {
		Object.freeze(o);
		for (const v of Object.values(o)) deepFreeze(v);
	}
	return o;
}
const schema = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// ------------------------------------------------------------------ a world
const openWorlds = [];
// `readablePdf`: the stub renderer writes the invoice HTML's text into a PDF the
// way Chromium writes text (lib/pdf-shown-text.js reads it); otherwise a
// constant made-up PDF. `replica`: server.js's REPLICA for the block.
async function world({ env = {}, startsJobAnswer = true, blockText = BLOCK, readablePdf = false, replica = null } = {}) {
	const w = {
		env: { ...env },
		sheet: [HEADERS.slice()],
		drive: [],
		calls: { sheetsGet: 0, cache: 0, driveList: 0, driveGet: 0, gemini: 0, renderer: 0, mint: 0, prepare: 0, render: 0, record: 0, append: 0, search: 0 },
		startsJob: [],
		intervals: [],
		recordAnswers: [],
		gmail: [],
		sockets: [],
		logs: [],
		required: [],
		registered: [],
		crossSite: 0,
		rendererBusy: false,
		geminiAt: 0,
		smtp: [],
		verifies: 0,
		smtpFails: null,
		transports: [],
		limiters: [],
		limited: 0,
		out: [],
		invalidated: 0,
		payments: [[" Job ID", "Contract ID", "Payment Amount", "Invoice Number", "Payment Date", "Payment Status"]],
		looks: [],
		lookAnswer: { verdict: "clean", mailboxes: {} },
		batchHook: null,
		dir: fs.mkdtempSync(path.join(os.tmpdir(), "auto-invoice-wiring-")),
	};
	fs.mkdirSync(path.join(w.dir, "uploads"));
	const db = new Database(":memory:");
	w.db = db;
	for (const t of TABLES) db.exec(createSql(t));
	for (const a of ALTERS) db.exec(a);

	const quiet = { log: (...a) => w.out.push(a.join(" ")), info() {}, warn: (...a) => w.logs.push(a.join(" ")), error: (...a) => w.logs.push(a.join(" ")) };
	const proc = { env: w.env };
	const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
	const sheets = {
		spreadsheets: { values: {
			get: async ({ range } = {}) => {
				w.calls.sheetsGet++;
				if (range === "Payments Table") {
					if (w.paymentsFail) throw new Error("made-up Sheets failure");
					return { data: { values: w.payments.map((r) => r.slice()) } };
				}
				return { data: { values: w.sheet.map((r) => r.slice()) } };
			},
			// The status route's write. `w.batchFails`: it rejects, having landed or not.
			batchUpdate: async ({ requestBody }) => {
				if (w.batchHook) w.batchHook();
				const write = () => {
					for (const d of requestBody.data || []) {
						const m = /!([A-Z]+)(\d+)$/.exec(d.range);
						if (m) w.sheet[Number(m[2]) - 1][colIndex(m[1])] = d.values[0][0];
					}
				};
				const fails = w.batchFails;
				w.batchFails = null;
				if (fails && !fails.landed) throw new Error("made-up: the sheet refused the write");
				write();
				if (fails) throw new Error("made-up: no answer in 15 seconds");
				return { data: {} };
			},
		} },
	};
	const drive = {
		files: {
			list: async ({ q } = {}) => {
				w.calls.driveList++;
				const m = /name contains '([^']*)'/.exec(String(q || ""));
				return { data: { files: w.drive.filter((f) => !m || f.name.includes(m[1])).map((f) => ({ id: f.id, name: f.name, createdTime: "2026-10-01T12:00:00Z" })) } };
			},
			get: async ({ fileId } = {}) => {
				w.calls.driveGet++;
				const f = w.drive.find((x) => x.id === fileId);
				if (!f) throw new Error("made-up Drive: no such file");
				return { data: f.bytes };
			},
		},
	};
	// runRateConGemini()'s own answer shape, with nothing found.
	const runRateConGemini = async () => {
		w.calls.gemini++;
		return w.geminiAnswer || { "Total Rate": null, Rate: null, "Order Number": null, "PO Number": null, "Documents Email": null };
	};
	// lib/pdf-browser.js's busy refusal carries this code.
	const renderHtmlToPdf = async (html) => {
		w.calls.renderer++;
		if (w.rendererBusy) throw Object.assign(new Error("made-up: every page is in use"), { code: "PDF_RENDERER_BUSY" });
		return readablePdf ? textPdf(rules.htmlToText(html)) : Buffer.from("%PDF-1.4 made-up invoice");
	};
	const H = new Function(...PROVIDED, `${LIFT.text}\nreturn { ${LIFT.names.join(", ")} };`)(
		db, brokerInvoice, quiet, proc, serverRequire, async () => sheets, async () => drive, "made-up-sheet", "made-up-gemini-key",
		runRateConGemini, renderHtmlToPdf, w.dir, path, fs, "made-up-ratecon-folder", ROOT,
	);
	w.H = H;
	const engine = H.brokerInvoiceDraft;
	const { prepare, render, record } = engine;
	engine.prepare = (args) => { w.calls.prepare++; return prepare(args); };
	engine.render = (ctx, opts) => { w.calls.render++; return render(ctx, opts); };
	engine.record = (ctx, rendered, opts) => {
		w.calls.record++;
		if (w.recordThrowsOnce) {
			w.recordThrowsOnce = false;
			throw Object.assign(new Error("made-up: the draft row could not be written"), { code: "SQLITE_BUSY" });
		}
		if (w.recordHook) w.recordHook(ctx, opts);
		const answer = record(ctx, rendered, opts);
		w.recordAnswers.push(answer);
		return answer;
	};

	// Gmail: each draft built by lib/imap-draft.js's own MIME builder, kept, and
	// found again by its Message-ID.
	const appendGmailDraft = async (opts) => {
		w.calls.append++;
		const mime = await realImap.buildMime(opts);
		w.gmail.push({
			user: opts.user, from: opts.from, to: opts.to, subject: opts.subject, messageId: opts.messageId,
			attachments: (opts.attachments || []).map((a) => a.filename), mime: mime.toString("latin1"),
		});
		return { ok: true, bytes: mime.length, mailbox: "[Gmail]/Drafts" };
	};
	const findDraftByMessageId = async ({ messageId }) => {
		w.calls.search++;
		const count = w.gmail.filter((g) => g.messageId === messageId).length;
		return { found: count > 0, count };
	};
	const imapModule = { ...realImap, findDraftByMessageId };
	// Try again's look: the search's own contract, with no mailbox behind it.
	const searchModule = {
		searchMailboxForLoad: async (opts) => {
			w.looks.push(opts);
			if (w.lookFails) throw Object.assign(new Error("made-up"), { stage: "search" });
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
	const app = {};
	for (const verb of ["get", "put", "post", "delete", "patch", "use", "all"]) {
		app[verb] = (p, ...handlers) => { w.registered.push(`${verb.toUpperCase()} ${p}`); return realApp[verb](p, ...handlers); };
	}
	const scope = {
		require: (p) => { w.required.push(p); return p === "./lib/imap-draft" ? imapModule : p === "./lib/invoice-mailbox-search" ? searchModule : serverRequire(p); },
		getSheets: async () => sheets,
		SPREADSHEET_ID: "made-up-sheet",
		jtCacheInvalidate: () => { w.invalidated++; },
		db,
		process: proc,
		console: quiet,
		getJobTrackingCached: async () => {
			w.calls.cache++;
			const parsed = H.parseSheet({ values: w.sheet.map((r) => r.slice()) });
			parsed.data = H.deduplicateLoads(parsed.data, parsed.headers);
			return deepFreeze(parsed);
		},
		integrityClosedMonthsOf: H.integrityClosedMonthsOf,
		sheetDayKey: H.sheetDayKey,
		path,
		DATA_DIR: w.dir,
		brokerInvoiceDraft: engine,
		nextInvoiceNumber: (date) => { w.calls.mint++; return H.nextInvoiceNumber(date); },
		appendGmailDraft,
		REPLICA: replica,
		logAudit: H.logAudit,
		insertDispatchNotification: H.insertDispatchNotification,
		io: { to: (room) => ({ emit: (event, payload) => w.sockets.push({ room, event, payload }) }) },
		app,
		requireRole: H.requireRole,
		refuseCrossSite: (req, res, next) => { w.crossSite++; next(); },
		startsJob: (name) => { w.startsJob.push(name); return startsJobAnswer; },
		setInterval: (fn, ms) => { w.intervals.push({ fn, ms }); return 0; },
		// SMTP, made up: each message nodemailer would send is built into MIME by
		// nodemailer's own composer and kept; nothing leaves the process.
		nodemailer: {
			createTransport: (opts) => {
				w.transports.push({ service: opts.service, user: opts.auth && opts.auth.user });
				return {
					verify: async () => { w.verifies++; return true; },
					sendMail: async (m) => {
						if (w.smtpFails) throw w.smtpFails;
						const mime = await realImap.buildMime(m);
						w.smtp.push({ from: m.from, to: m.to, envelope: m.envelope, subject: m.subject, messageId: m.messageId,
							attachments: (m.attachments || []).map((a) => a.filename), html: m.html, attachmentBytes: (m.attachments || []).map((a) => a.content), mime: mime.toString("latin1") });
						return { accepted: [m.to], rejected: [] };
					},
					close: () => {},
				};
			},
		},
		rateLimit: (opts) => { w.limiters.push(opts); return (req, res, next) => { w.limited++; next(); }; },
	};
	w.schemaBefore = schema(db);
	const names = Object.keys(scope);
	const block = blockText.replace(/\brateConGeminiUnavailableAt\b/g, "__geminiAt()");
	w.job = new Function(...names, "__geminiAt", `${block}\nreturn autoInvoice;`)(...names.map((n) => scope[n]), () => w.geminiAt);

	// PUT /api/driver/status as shipped: every name it reaches is server.js's own top-level
	// declaration, unless it's the outside world (stubbed here) or the job above.
	w.statusRoute = ({ notificationThrows = false } = {}) => {
		const stubs = {
			app: {}, db, getSheets: scope.getSheets, SPREADSHEET_ID: scope.SPREADSHEET_ID, require: serverRequire, console: quiet, process: proc,
			autoInvoice: w.job,
			requireRole: () => null, driverWriteLimiter: null, loadBelongsToDriver: async () => true,
			logAudit: () => {}, logAuditRefusal: () => {}, WITHHELD_LOAD_REFS_ENABLED: false,
			dispatchWriteBlocker: () => null, tripDayLockCover: () => null,
			sendDispatchRefusal: (req, res, blocked) => res.status(409).json({ code: blocked && blocked.code }),
			jtCacheInvalidate: scope.jtCacheInvalidate, notifyChange: () => {}, emitLoadEventToDispatch: () => {}, emitDispatchNotice: () => {},
			insertDispatchNotification: { run: () => { if (notificationThrows) throw new Error("made-up: the notification insert failed"); return {}; } },
			recordStatusChange: () => {}, arrivalRecorder: { positionFacts: () => ({}) }, arrivalRecorderReaders: {}, ARRIVAL_PICKUP_RECORDER_ENABLED: false,
			io: { to: () => ({ emit() {}, except() { return { emit() {} }; } }) },
			getJobTrackingCached: scope.getJobTrackingCached,
			REPLICA: replica,
		};
		const cache = Object.create(null);
		let proxy = null;
		proxy = new Proxy(Object.create(null), {
			has(_, key) {
				if (typeof key !== "string" || key === "__scope") return false;
				return Object.prototype.hasOwnProperty.call(stubs, key) || key in cache || STATUS_INDEX.decls.has(key) || !(key in globalThis);
			},
			get(_, key) {
				if (key === Symbol.unscopables) return undefined;
				if (Object.prototype.hasOwnProperty.call(stubs, key)) return stubs[key];
				if (key in cache) return cache[key];
				const decl = STATUS_INDEX.decls.get(key);
				if (decl) {
					cache[key] = new Function("__scope", `with (__scope) { ${decl.text}\nreturn ${key}; }`)(proxy);
					return cache[key];
				}
				if (key in globalThis) return globalThis[key];
				throw new ReferenceError(`unstubbed in the lifted route: ${String(key)}`);
			},
			set(_, key, value) { cache[key] = value; return true; },
		});
		let handler = null;
		stubs.app = { put: (...args) => { handler = args[args.length - 1]; } };
		new Function("__scope", `with (__scope) { ${liftRoute(SRC, STATUS_HEAD)} }`)(proxy);
		return async (user, id, newStatus = "Delivered") => {
			const out = { status: 200, json: null };
			const res = { status(c) { out.status = c; return res; }, json(b) { out.json = b; return res; } };
			const rowIndex = w.sheet.findIndex((r, i) => i > 0 && r[0] === id) + 1;
			await handler({ method: "PUT", query: {}, params: {}, headers: {}, session: { user }, body: { loadId: id, rowIndex, newStatus, driverName: "Made-up Driver" } }, res);
			return out;
		};
	};

	w.server = await new Promise((resolve) => { const s = realApp.listen(0, "127.0.0.1", () => resolve(s)); });
	const base = `http://127.0.0.1:${w.server.address().port}`;
	w.call = async (method, url, user, body) => {
		const headers = { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" };
		if (user) headers["x-test-user"] = JSON.stringify(user);
		const resp = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await resp.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* not JSON */ }
		return { status: resp.status, json };
	};
	w.close = async () => {
		await new Promise((r) => w.server.close(() => r()));
		fs.rmSync(w.dir, { recursive: true, force: true });
	};

	w.setLoad = (id, over = {}) => {
		const row = { "Load ID": id, "Job Status": "Delivered", Email: BROKER, "Broker Contact Name": "Made-up Agent", Driver: "Made-up Driver",
			"Trailer Number": "", "Completion Date": DELIVERED_ON, "  Payment  ": "1500", ...over };
		const cells = HEADERS.map((h) => row[h]);
		const at = w.sheet.findIndex((r, i) => i > 0 && r[0] === id);
		if (at > 0) w.sheet[at] = cells; else w.sheet.push(cells);
	};
	// Uploaded now, or `minutesAgo`, stamped by SQLite as CURRENT_TIMESTAMP stamps a row.
	w.addPod = (id, { minutesAgo = 0 } = {}) => {
		const name = `${id}_POD.pdf`;
		fs.writeFileSync(path.join(w.dir, "uploads", name), `%PDF-1.4 made-up POD for ${id}`);
		db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_url, uploaded_at) VALUES (?, 'Made-up Driver', 'POD', ?, ?, datetime('now', ?))")
			.run(id, name, `/uploads/${name}`, `-${Number(minutesAgo) || 0} minutes`);
	};
	// Named as the n8n workflow names a rate con it files: the load ID in the subject.
	w.fileRateCon = (id, bytes) => {
		w.drive.push({ id: `made-up-file-${w.drive.length + 1}`, name: `Subject: Rate Confirmation ${id.replace(/[^A-Za-z0-9]/g, "")}.pdf`, bytes });
	};
	w.deliver = (id, rc, over = {}, pod = {}) => { w.setLoad(id, over); w.addPod(id, pod); if (rc) w.fileRateCon(id, rc); };
	w.claim = (id) => db.prepare("SELECT * FROM auto_invoice_claims WHERE load_key = ?").get(rules.loadKey(id)) || null;
	w.state = (id) => { const c = w.claim(id); return c ? [c.state, c.reason_code] : null; };
	w.seq = () => db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM bison_invoice_seq").get().n;
	w.drafts = () => db.prepare("SELECT id, load_id, invoice_id, recipient, recipient_source, total, via, created_by FROM load_invoice_drafts ORDER BY id").all();
	w.audits = (action) => db.prepare("SELECT username, role, entity_id, details FROM audit_trail WHERE action = ? ORDER BY id").all(action);
	w.paid = () => {
		const c = w.calls;
		return { engine: c.prepare + c.render + c.record, drive: c.driveList + c.driveGet, gemini: c.gemini, renderer: c.renderer, numbers: c.mint, gmail: c.append + c.search, sheetsDirect: c.sheetsGet };
	};
	openWorlds.push(w);
	return w;
}
const NO_PAID = { engine: 0, drive: 0, gemini: 0, renderer: 0, numbers: 0, gmail: 0, sheetsDirect: 0 };

(async () => {
	// ===================================================================== §1
	section("§1  off: no route, no timer, no table");
	{
		const w = await world({ env: { ...MAILBOX } });
		eq(w.job.mode, "off", "§1 no AUTO_INVOICE_DRAFTS_ENABLED: off");
		eq(w.registered, [], "§1 no route is registered");
		eq([w.startsJob, w.intervals.length], [[], 0], "§1 no timer, and startsJob() is never asked");
		eq(schema(w.db), w.schemaBefore, "§1 sqlite_master unchanged: no table or index made");
		const status = await w.call("GET", "/api/auto-invoice/status", SA);
		eq([status.status, status.json], [404, null], "§1 GET /api/auto-invoice/status reaches no route (Express's own 404, not a JSON answer)");
		w.deliver("LD-TEST-0001", rateCon());
		const rows = [{ "Load ID": "LD-TEST-0001", "Job Status": "Delivered" }];
		w.job.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: true });
		eq(rows, [{ "Load ID": "LD-TEST-0001", "Job Status": "Delivered" }], "§1 a Super Admin's completed row is left as it was");
		eq([await w.job.tick(), w.paid(), schema(w.db)], [{ mode: "off" }, NO_PAID, w.schemaBefore], "§1 even a direct tick does nothing and makes nothing");
		for (const v of ["false", "TRUE", "1", "yes", "on"]) {
			const x = await world({ env: { ...MAILBOX, AUTO_INVOICE_DRAFTS_ENABLED: v } });
			eq([x.job.mode, x.registered.length, x.intervals.length, x.startsJob.length, JSON.stringify(schema(x.db)) === JSON.stringify(x.schemaBefore)],
				["off", 0, 0, 0, true], `§1 AUTO_INVOICE_DRAFTS_ENABLED=${v}: off (only exactly "true" turns it on)`);
		}
	}

	// ===================================================================== §2
	section("§2  shadow: verdicts logged, nothing paid for");
	{
		const w = await world({ env: SHADOW_ENV });
		eq(w.job.mode, "shadow", "§2 ENABLED=true with no SHADOW setting: shadow, never real drafts");
		eq([w.startsJob, w.intervals.map((i) => i.ms)], [["automatic invoice drafts"], [5 * 60 * 1000]], "§2 one timer, every 5 minutes, behind startsJob()");
		const put = await w.call("PUT", "/api/auto-invoice/settings", SA, CONFIRMED);
		eq([put.status, put.json], [200, CONFIRMED], "§2 the settings can be saved before switch-on (Super Admin)");
		w.deliver("LD-TEST-0009", rateCon());
		await w.job.tick();
		w.deliver("LD-TEST-0001", rateCon());
		w.deliver("LD-TEST-0003", rateCon({ docs: "billing@example-other.test" }), { Email: "ops@example-other.test" });
		w.setLoad("LD-TEST-0007", { "Job Status": "In Transit" });
		await w.job.tick();
		await w.job.tick();
		const shadow = w.db.prepare("SELECT load_id, verdict, reason_code FROM auto_invoice_shadow ORDER BY load_id").all();
		eq(shadow, [
			{ load_id: "LD-TEST-0001", verdict: "WOULD_ATTEMPT", reason_code: "" },
			{ load_id: "LD-TEST-0003", verdict: "WOULD_NEED_ATTENTION", reason_code: "BROKER_DOMAIN_UNCONFIRMED" },
			{ load_id: "LD-TEST-0009", verdict: "BASELINE", reason_code: "" },
		], "§2 the shadow log: the load delivered before the first sweep is the baseline, the two after it each get a verdict, the one in transit none");
		eq(w.paid(), NO_PAID, "§2 zero engine, Drive, Gemini, renderer, invoice-number, Gmail and direct Sheets calls");
		ok(w.calls.cache > 0, "§2 ...the sweep reads the cached Job Tracking only");
		eq([w.db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims").get().n, w.drafts().length, w.seq(),
			w.db.prepare("SELECT COUNT(*) AS n FROM dispatch_notifications").get().n, w.sockets.length],
		[0, 0, 0, 0, 0], "§2 no claim, no draft row, no number, no notice");
		eq(w.db.prepare("SELECT action FROM audit_trail ORDER BY id").all().map((r) => r.action), ["update_auto_invoice_settings"],
			"§2 the only audit row is the Super Admin's settings change (shadow writes none)");
		const rows = [{ "Load ID": "LD-TEST-0001", "Job Status": "Delivered" }];
		w.job.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: true });
		eq(rows[0]._autoInvoice, undefined, "§2 no chip on Completed Loads while shadowing");
		const status = await w.call("GET", "/api/auto-invoice/status", SA);
		eq([status.status, status.json && status.json.mode, status.json && status.json.shadow && status.json.shadow.WOULD_ATTEMPT], [200, "shadow", 1],
			"§2 GET /api/auto-invoice/status answers a Super Admin, with the shadow counts");
		eq((await w.call("GET", "/api/auto-invoice/status", DISP)).status, 403, "§2 ...and refuses a Dispatcher");
		for (const action of ["checked", "retry"]) {
			const r = await w.call("POST", `/api/auto-invoice/loads/LD-TEST-0001/${action}`, SA, {});
			eq([r.status, r.json && r.json.code], [404, "FEATURE_OFF"], `§2 POST …/${action} is real-draft mode only (404 FEATURE_OFF)`);
		}
	}

	// ===================================================================== §3
	section("§3  on: a draft end to end");
	const on = await world({ env: ON_ENV });
	{
		const w = on;
		eq(w.job.mode, "on", "§3 ENABLED=true and SHADOW=false: real drafts");
		eq(w.registered.sort(), [
			"GET /api/auto-invoice/settings", "GET /api/auto-invoice/status", "POST /api/auto-invoice/loads/:loadKey/checked",
			"POST /api/auto-invoice/loads/:loadKey/retry", "PUT /api/auto-invoice/settings",
		], "§3 the five routes are registered");
		eq(w.required.filter((p) => p.startsWith("./lib/")), ["./lib/imap-draft", "./lib/auto-invoice-send", "./lib/invoice-mailbox-search", "./lib/auto-invoice-job"], "§3 the block loads the job, lib/imap-draft.js, lib/auto-invoice-send.js and the mailbox search as shipped");
		eq((await w.call("PUT", "/api/auto-invoice/settings", DISP, CONFIRMED)).status, 403, "§3 a Dispatcher can't change the settings");
		const crossBefore = w.crossSite;
		eq((await w.call("PUT", "/api/auto-invoice/settings", SA, CONFIRMED)).status, 200, "§3 a Super Admin confirms example-broker.test");
		eq(w.crossSite - crossBefore, 1, "§3 ...through the cross-site guard (the Dispatcher's refusal never reached it)");

		w.deliver("LD-TEST-0009", rateCon());
		w.setLoad("LD-TEST-0001", { "Job Status": "In Transit" });
		const first = await w.job.tick();
		eq([first.sweep && first.sweep.baseline, w.state("LD-TEST-0009"), w.claim("LD-TEST-0001")], [1, ["baseline", ""], null],
			"§3 the first sweep leaves the load already delivered to people (baseline) and the one in transit alone");
		eq(w.audits("auto_invoice_baseline").map((a) => [a.username, a.role, a.details]), [["auto-invoice", "system", "1 completed load left to people (baseline)"]],
			"§3 ...with one baseline audit row, the system's");
		eq(w.paid(), NO_PAID, "§3 ...and nothing paid for yet");

		w.deliver("LD-TEST-0001", rateCon());
		const second = await w.job.tick();
		const c = w.claim("LD-TEST-0001");
		eq([second.work && second.work.started, c.state, c.stage, c.reason_code], [1, "drafted", "recorded", ""], "§3 the load delivered after switch-on is drafted");
		eq(w.gmail.map((g) => ({ user: g.user, to: g.to, subject: g.subject, attachments: g.attachments })), [{
			user: MAILBOX.GMAIL_USER, to: BILLING, subject: "Example Broker Order #LD-TEST-0001",
			attachments: ["Example Broker Invoice Order #LD-TEST-0001.pdf", "LD-TEST-0001_POD.pdf", "LD-TEST-0001.pdf"],
		}], "§3 one Gmail draft, from the mailbox, to the rate con's billing email on the confirmed domain: invoice, POD, rate con");
		ok(w.gmail[0].messageId === c.message_id && w.gmail[0].mime.includes(`Message-ID: ${c.message_id}`),
			"§3 ...carrying the claim's own Message-ID, so a lost answer can be looked for");
		eq([c.invoice_id, w.seq(), w.calls.mint], [`${TODAY_SEQ}-1`, 1, 1], "§3 one invoice number, from the server's own sequence");
		const rows = w.drafts();
		eq(rows.map(({ id, ...r }) => r), [{
			load_id: "LD-TEST-0001", invoice_id: c.invoice_id, recipient: BILLING, recipient_source: "ratecon", total: "$1,500.00", via: "auto-imap", created_by: "auto-invoice",
		}], "§3 one draft row: auto-imap, by the system, at the rate con's total");
		eq([w.recordAnswers, c.draft_row_id], [[{ recorded: true, draftRowId: rows[0].id }], rows[0].id], "§3 the claim keeps the row record() answered");
		eq(w.audits("invoice_draft_created").map((a) => [a.username, a.role, a.entity_id, a.details]),
			[["auto-invoice", "system", "LD-TEST-0001", `${c.invoice_id} → ${BILLING} (auto-imap)`]], "§3 the draft's audit row, in the button's shape, as the system");
		ok(w.calls.sheetsGet >= 1 && w.calls.driveList >= 1 && w.calls.driveGet >= 1 && w.calls.renderer === 1, "§3 the engine read the sheet and the Drive folder and rendered once");

		const before = JSON.stringify(w.paid());
		await w.job.tick();
		await w.job.tick();
		eq([JSON.stringify(w.paid()) === before, w.gmail.length, w.drafts().length, w.seq()], [true, 1, 1, 1], "§3 later sweeps: nothing more is paid for, drafted or numbered");

		const served = [{ "Load ID": "LD-TEST-0001", "Job Status": "Delivered" }, { "Load ID": "LD-TEST-0009", "Job Status": "Delivered" }];
		w.job.annotateCompletedRows({ rows: served, headers: HEADERS, isSuperAdmin: true });
		eq(served.map((r) => r._autoInvoice || null), [{ state: "drafted", code: "", invoiceId: c.invoice_id, changed: [] }, null],
			"§3 a Super Admin's Completed Loads: the drafted load's status (codes only); the baseline load none");
		const dispRows = [{ "Load ID": "LD-TEST-0001", "Job Status": "Delivered" }];
		w.job.annotateCompletedRows({ rows: dispRows, headers: HEADERS, isSuperAdmin: false });
		eq(dispRows[0]._autoInvoice, undefined, "§3 a Dispatcher's: none");
		const status = await w.call("GET", "/api/auto-invoice/status", SA);
		eq([status.status, status.json.mode, status.json.counts.drafted, status.json.counts.baseline, status.json.mailbox], [200, "on", 1, 1, true], "§3 the status route's counts");

		// The load changes after its draft: one notice, to Super Admins only.
		w.setLoad("LD-TEST-0001", { "  Payment  ": "1600" });
		await w.job.tick();
		eq(w.claim("LD-TEST-0001").changed_fields, "payment", "§3 a Payment changed after the draft is flagged");
		const notices = w.db.prepare("SELECT type, title FROM dispatch_notifications").all();
		eq([notices, w.sockets.map((s) => [s.room, s.event, s.payload.type])],
			[[{ type: "auto-invoice", title: "Invoice draft: load changed" }], [["super-admin", "dispatch-notification", "auto-invoice"]]],
			"§3 one stored notice, sent live to the super-admin room only");
		const seen = (user) => {
			const s = w.H.noticeTypeScope(user);
			return w.db.prepare(`SELECT type FROM dispatch_notifications WHERE ${s.sql}`).all(...s.params).map((r) => r.type);
		};
		eq([seen(SA), seen(DISP)], [["auto-invoice"], []], "§3 GET /api/dispatch-notifications' scope: a Super Admin sees it, a Dispatcher doesn't");
		eq((await w.call("POST", "/api/auto-invoice/loads/LD-TEST-0001/checked", DISP, {})).status, 403, "§3 a Dispatcher can't mark it checked");
		const checked = await w.call("POST", "/api/auto-invoice/loads/LD-TEST-0001/checked", SA, {});
		const after = w.claim("LD-TEST-0001");
		eq([checked.status, after.changed_fields, after.checked_by, w.audits("auto_invoice_checked").length], [200, "", SA.username, 1],
			"§3 a Super Admin's Mark checked clears it, audited");
		ok(!w.logs.some((l) => l.includes("@")), "§3 nothing logged names an email address");
	}

	// ===================================================================== §4
	section("§4  the recipient anchor");
	{
		const w = on;
		const before = { prepare: w.calls.prepare, mint: w.calls.mint, gmail: w.gmail.length, seq: w.seq() };
		w.deliver("LD-TEST-0002", rateCon({ docs: "billing@example-factor.test" }));
		w.deliver("LD-TEST-0003", rateCon({ docs: "billing@example-other.test" }), { Email: "ops@example-other.test" });
		await w.job.tick();
		eq([w.state("LD-TEST-0002"), w.state("LD-TEST-0003")], [["needs_attention", "RECIPIENT_DOMAIN_MISMATCH"], ["needs_attention", "BROKER_DOMAIN_UNCONFIRMED"]],
			"§4 a billing email on another domain, and a broker domain nobody confirmed: Needs attention");
		eq([w.calls.prepare - before.prepare, w.calls.mint - before.mint, w.gmail.length - before.gmail, w.seq()], [1, 0, 0, before.seq],
			"§4 the engine refused the first before any number; the second never reached the engine; nothing in Gmail");
		const served = [{ "Load ID": "LD-TEST-0002", "Job Status": "Delivered" }];
		w.job.annotateCompletedRows({ rows: served, headers: HEADERS, isSuperAdmin: true });
		eq(served[0]._autoInvoice, { state: "needs_attention", code: "RECIPIENT_DOMAIN_MISMATCH", invoiceId: "", changed: [] }, "§4 the chip's status for a Super Admin");
		eq((await w.call("POST", "/api/auto-invoice/loads/LD-TEST-0002/retry", DISP, {})).status, 403, "§4 a Dispatcher can't Try again");
		const retry = await w.call("POST", "/api/auto-invoice/loads/LD-TEST-0002/retry", SA, {});
		eq([retry.status, w.state("LD-TEST-0002"), w.audits("auto_invoice_retry").length], [200, ["queued", ""], 1], "§4 a Super Admin's Try again queues it, audited");
	}

	// ===================================================================== §5
	section("§5  a rate-con total that wasn't read");
	{
		const w = on;
		const before = { prepare: w.calls.prepare, mint: w.calls.mint, gmail: w.gmail.length, seq: w.seq() };
		w.deliver("LD-TEST-0004", plainRateCon(BILLING));
		await w.job.tick();
		eq(w.state("LD-TEST-0004"), ["needs_attention", "RATECON_TOTAL_UNREAD"], "§5 no total on the rate con (Gemini read none): Needs attention, RATECON_TOTAL_UNREAD");
		eq(w.state("LD-TEST-0002"), ["needs_attention", "RECIPIENT_DOMAIN_MISMATCH"], "§5 ...and the load tried again is refused again, for its own reason");
		eq([w.calls.prepare - before.prepare, w.calls.mint - before.mint, w.gmail.length - before.gmail, w.seq()], [2, 0, 0, before.seq],
			"§5 no number and nothing in Gmail for either");
	}

	// ===================================================================== §6
	section("§6  the outside world busy or down");
	{
		const w = on;
		const before = { gmail: w.gmail.length, drafts: w.drafts().length, seq: w.seq() };
		w.rendererBusy = true;
		w.deliver("LD-TEST-0005", rateCon());
		await w.job.tick();
		const busy = w.claim("LD-TEST-0005");
		eq([busy.state, busy.reason_code, busy.attempts, busy.stage], ["queued", "RENDERER_BUSY", 0, "reserved"],
			"§6 a busy renderer: back in the queue as RENDERER_BUSY, no attempt used, its number kept for the retry");
		ok(busy.next_attempt_at > new Date().toISOString(), "§6 ...tried again later, not at once");
		eq([w.gmail.length - before.gmail, w.drafts().length - before.drafts, w.seq() - before.seq], [0, 0, 1], "§6 ...nothing in Gmail, no draft row");
		eq(w.db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims WHERE reason_code = 'PDF_RENDERER_BUSY'").get().n, 0, "§6 the renderer's own code never reaches a claim");

		w.rendererBusy = false;
		w.geminiAt = Date.now();
		const prepares = w.calls.prepare;
		w.deliver("LD-TEST-0006", rateCon());
		await w.job.tick();
		eq([w.state("LD-TEST-0006"), w.calls.prepare - prepares], [["queued", "GEMINI_DOWN"], 0],
			"§6 ingestion saw Gemini down a moment ago (rateConGeminiUnavailableAt): the non-Bison load waits, no engine call");
	}

	// ===================================================================== §7
	section("§7  the timer, a replica, and server.js around the block");
	{
		const w = on;
		eq([w.startsJob, w.intervals.map((i) => i.ms)], [["automatic invoice drafts"], [300000]], "§7 one timer, every 5 minutes, behind startsJob(\"automatic invoice drafts\")");
		const fire = w.intervals[0].fn;
		let ticks = 0;
		let finish = null;
		w.job.tick = () => { ticks++; return new Promise((resolve) => { finish = resolve; }); };
		fire();
		fire();
		eq(ticks, 1, "§7 a tick still running: the next interval skips");
		finish({});
		await settle();
		fire();
		eq(ticks, 2, "§7 ...and the one after it finished runs");
		finish({});
		await settle();
		w.job.tick = () => { ticks++; return Promise.reject(Object.assign(new Error(`made-up failure for ${BILLING}`), { code: "SQLITE_BUSY" })); };
		const logged = w.logs.length;
		fire();
		await settle();
		eq(w.logs.slice(logged), ["[auto-invoice] tick failed: SQLITE_BUSY"], "§7 a failed tick is logged by its code alone, never its message");
		fire();
		await settle();
		eq(ticks, 4, "§7 ...and the next interval runs again");

		const replica = await world({ env: ON_ENV, startsJobAnswer: false });
		eq([replica.startsJob, replica.intervals.length, replica.registered.length], [["automatic invoice drafts"], 0, 5],
			"§7 a replica (startsJob() says no): no timer, the routes still answer");

		const dash = liftRoute(SRC, DASH_HEAD);
		const ann = dash.indexOf("autoInvoice.annotateCompletedRows(");
		ok(dash.split("autoInvoice.annotateCompletedRows(").length === 2 &&
			dash.includes("autoInvoice.annotateCompletedRows({ rows: respCompleted, headers: jobTracking.headers, isSuperAdmin: req.session.user.role === \"Super Admin\" });") &&
			ann > dash.indexOf("const respCompleted =") && ann < dash.indexOf("res.json({"),
		"§7 /api/dashboard annotates the completed rows it serves, once, after they are built (request-local copies) and before its answer");
		ok(dash.includes("...(autoInvoice.mode !== \"off\" && req.session.user.role === \"Super Admin\" ? { autoInvoice: { mode: autoInvoice.mode } } : {}),") &&
			dash.indexOf("autoInvoice: { mode: autoInvoice.mode }") > dash.indexOf("res.json({"),
		"§7 ...and names the mode to a Super Admin only, and only while it isn't off (its answer as before)");
		ok(/^const \{ appendGmailDraft \} = require\("\.\/lib\/imap-draft"\);$/m.test(SRC), "§7 the block's appendGmailDraft is server.js's own, from lib/imap-draft.js");
		ok(/if \(autoInvoice\.mode !== "off"\) \{\n\tautoInvoice\.mount\(app, \{\n\t\trequireRole,\n\t\trefuseCrossSite,\n\t\tstopLimiter: rateLimit\(/.test(BLOCK) &&
			/if \(autoInvoice\.mode !== "off" && startsJob\("automatic invoice drafts"\)\) \{/.test(BLOCK),
		"§7 the block mounts the routes and starts the timer only when the mode isn't off");
		ok(SRC.indexOf(START) < SRC.indexOf("const brokerInvoiceDraft = require(\"./lib/broker-invoice-draft\")") &&
			/prepare: \(args\) => brokerInvoiceDraft\.prepare\(args\)/.test(BLOCK),
		"§7 the engine is server.js's own, created below the block and read at each call");
		eq([w.H.noticeTypeScope(SA).sql, w.H.noticeTypeScope(DISP).params.includes("auto-invoice")], ["1 = 1", true],
			"§7 noticeTypeScope(): the auto-invoice notices are left out for everyone but Super Admins");

		// The settings template carries the four settings, each unset, with what turns it on.
		const TEMPLATE = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
		const at = TEMPLATE.indexOf("# --- Automatic broker invoice drafts");
		const section = at >= 0 ? TEMPLATE.slice(at, TEMPLATE.indexOf("\n# ---", at + 1)) : "";
		ok(section, "§7 the settings template has an \"Automatic broker invoice drafts\" section");
		for (const name of ["AUTO_INVOICE_DRAFTS_ENABLED", "AUTO_INVOICE_DRAFTS_SHADOW", "AUTO_INVOICE_MAX_PER_HOUR", "AUTO_INVOICE_MAX_PER_DAY"]) {
			ok(new RegExp(`^# ${name}=$`, "m").test(section), `§7 ...${name}, commented out (unset)`);
		}
		// Its words as one line, wherever the comment wraps.
		const words = section.replace(/\n#\s?/g, " ");
		ok(/ENABLED: on only when exactly "true"/.test(words) && /SHADOW exactly "false"/.test(words), "§7 ...on only with ENABLED exactly \"true\"; real drafts only with SHADOW exactly \"false\"");
		const caps = rules.readCaps({});
		ok(words.includes(`default ${caps.maxPerHour}`) && words.includes(`default ${caps.maxPerDay}`), `§7 ...the caps' defaults (${caps.maxPerHour} an hour, ${caps.maxPerDay} a day) as the rules read them`);
		ok(/Shadow makes no Gmail drafts: it only records what it would draft/.test(words) && /in-app Super Admin notice/.test(words), "§7 ...shadow makes no Gmail drafts; its one other write is the settings notice");
		ok(/a GET under \/api\/auto-invoice\/ reaches the app page/.test(words), "§7 ...off: a GET under /api/auto-invoice/ reaches the app page (no route is mounted)");
	}

	// ===================================================================== §8
	section("§8  #628 review L4: paths no case reached");
	{
		// L4a: an older automatic row with the claim's number exists when record() writes
		// its own. The claim keeps the row record() answered, not the first one found.
		const w = await world({ env: ON_ENV });
		eq((await w.call("PUT", "/api/auto-invoice/settings", SA, CONFIRMED)).status, 200, "§8 L4a the broker domain confirmed");
		await w.job.tick();
		w.deliver("LD-TEST-0011", rateCon());
		let twinId = 0;
		w.recordHook = (ctx, opts) => {
			twinId = Number(w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', 'auto-imap', 'made-up-twin')")
				.run(ctx.loadId, opts.invoiceId, BILLING).lastInsertRowid);
		};
		await w.job.tick();
		w.recordHook = null;
		const c = w.claim("LD-TEST-0011");
		const answered = w.recordAnswers[w.recordAnswers.length - 1] || {};
		eq([c.state, answered.recorded], ["drafted", true], "§8 L4a drafted, and record() answered the row it wrote");
		ok(twinId > 0 && answered.draftRowId > twinId, "§8 L4a ...an older automatic row on the same number was there first");
		eq(c.draft_row_id, answered.draftRowId, "§8 L4a the claim keeps the row record() wrote, not the older one a lookup by number finds first");
	}
	{
		// L4b: a Bison load through the block, to the inbox the block reads. The engine
		// reads the setting from the process's own environment (lib/broker-invoice.js),
		// as production does, so the case sets it there as well as in the block's.
		const BISON_AP = "ap@example-bison-ap.test";
		const BISON_ENV = { ...ON_ENV, BISON_INVOICE_EMAIL: BISON_AP };
		const had = Object.prototype.hasOwnProperty.call(process.env, "BISON_INVOICE_EMAIL");
		const was = process.env.BISON_INVOICE_EMAIL;
		process.env.BISON_INVOICE_EMAIL = BISON_AP;
		try {
			const w = await world({ env: BISON_ENV });
			await w.job.tick();
			w.deliver("LD-TEST-0012", rateCon(), { Email: "ops-test@bisontransport.com" });
			await w.job.tick();
			eq(w.state("LD-TEST-0012"), ["drafted", ""], "§8 L4b a Bison load is drafted through the block (no confirmed domain needed)");
			eq(w.gmail.map((g) => g.to), [BISON_AP], "§8 L4b ...to BISON_INVOICE_EMAIL as the block hands it over, never the rate con's address");
			eq(w.drafts().map((r) => [r.load_id, r.recipient, r.via]), [["LD-TEST-0012", BISON_AP, "auto-imap"]], "§8 L4b ...one draft row, to Bison's inbox");
			const READ = "process.env.BISON_INVOICE_EMAIL";
			ok(BLOCK.split(READ).length === 2, "§8 L4b the block reads BISON_INVOICE_EMAIL once (the mutant's anchor)");
			const m = await world({ env: BISON_ENV, blockText: BLOCK.replace(READ, "process.env.BISON_INVOICE_MAIL") });
			await m.job.tick();
			m.deliver("LD-TEST-0012", rateCon(), { Email: "ops-test@bisontransport.com" });
			await m.job.tick();
			eq([m.state("LD-TEST-0012"), m.calls.prepare, m.gmail.length], [["needs_attention", "RECIPIENT_UNCONFIGURED"], 0, 0],
				"§8 L4b MUTANT: a block reading a misnamed setting is caught (every Bison load would go to a person)");
		} finally {
			if (had) process.env.BISON_INVOICE_EMAIL = was;
			else delete process.env.BISON_INVOICE_EMAIL;
		}
	}
	{
		// L4c: the draft reached Gmail but its row wasn't written; Try again recovers it
		// through the real engine, which must rebuild what went to Gmail.
		const w = await world({ env: ON_ENV });
		eq((await w.call("PUT", "/api/auto-invoice/settings", SA, CONFIRMED)).status, 200, "§8 L4c the broker domain confirmed");
		await w.job.tick();
		w.deliver("LD-TEST-0013", rateCon());
		w.recordThrowsOnce = true;
		await w.job.tick();
		const stuck = w.claim("LD-TEST-0013");
		eq([stuck.state, stuck.reason_code, stuck.stage, w.gmail.length, w.drafts().length], ["needs_attention", "IN_GMAIL_UNRECORDED", "appended", 1, 0],
			"§8 L4c the draft is in Gmail and its row wasn't written: a person, at stage appended");
		eq(JSON.parse(stuck.sent_json), { to: BILLING, subject: "Example Broker Order #LD-TEST-0013", total: "$1,500.00" }, "§8 L4c ...what went to Gmail is kept on the claim");
		const before = { prepare: w.calls.prepare, render: w.calls.render, renderer: w.calls.renderer, append: w.calls.append };
		eq((await w.call("POST", "/api/auto-invoice/loads/LD-TEST-0013/retry", SA, {})).status, 200, "§8 L4c Try again");
		await w.job.tick();
		const c = w.claim("LD-TEST-0013");
		eq([c.state, c.stage, c.reason_code], ["drafted", "recorded", ""], "§8 L4c the recovery rebuilt the draft with the real engine, matched the recipient, subject and total, and recorded it");
		eq([w.calls.prepare - before.prepare, w.calls.render - before.render, w.calls.renderer - before.renderer, w.calls.append - before.append, w.gmail.length],
			[1, 1, 1, 0, 1], "§8 L4c ...one prepare and one render more, never a second append");
		eq(w.drafts().map((r) => [r.invoice_id, r.recipient, r.total, r.via]), [[stuck.invoice_id, BILLING, "$1,500.00", "auto-imap"]], "§8 L4c ...one draft row, with the claim's number and the billed total");
	}

	// ===================================================================== §9
	section("§9  the render shadow through the block, against a real draft of the same load");
	{
		const RENDERS = "AUTO_INVOICE_SHADOW_RENDERS_ENABLED";
		for (const [value, want] of [["true", true], [" true ", true], ["TRUE", false], ["1", false], ["yes", false], ["on", false], ["false", false], ["", false]]) {
			const x = await world({ env: { ...SHADOW_ENV, [RENDERS]: value } });
			eq(x.job.shadowRenders, want, `§9 ${RENDERS}=${JSON.stringify(value)}: render shadow ${want ? "on" : "off"} (on only when exactly "true")`);
		}
		eq((await world({ env: { ...SHADOW_ENV, [RENDERS]: "true" }, replica: { stamp: "made-up" } })).job.shadowRenders, false, "§9 ...never in a replica (REPLICA set)");
		eq((await world({ env: { ...ON_ENV, [RENDERS]: "true" } })).job.shadowRenders, false, "§9 ...read only in shadow mode (real drafts ignore it)");
		ok(BLOCK.split(`process.env.${RENDERS}`).length === 2, "§9 the block reads the setting once");

		// Load 123456789: the render shadow builds it, real drafts draft it; the
		// renderer writes the invoice's text as Chromium does.
		const shadow = await world({ env: { ...SHADOW_ENV, [RENDERS]: "true" }, readablePdf: true });
		eq((await shadow.call("PUT", "/api/auto-invoice/settings", SA, CONFIRMED)).status, 200, "§9 shadow world: the broker domain confirmed");
		await shadow.job.tick();
		shadow.deliver("123456789", rateCon());
		await shadow.job.tick();
		let row = {};
		try { row = shadow.db.prepare("SELECT verdict, render_digest_json FROM auto_invoice_shadow WHERE load_key = '123456789'").get() || {}; } catch { row = {}; }
		let rec = null;
		try { rec = row.render_digest_json ? JSON.parse(row.render_digest_json) : null; } catch { rec = null; }
		ok(row.verdict === "WOULD_ATTEMPT" && rec && rec.renderedAt, "§9 FAILS ON THE OLD CODE: the shadow stores a render digest for the ready load");
		eq([shadow.calls.prepare, shadow.calls.render, shadow.calls.renderer], [1, 1, 1], "§9 built once, through the engine and the PDF renderer");
		eq([shadow.calls.mint, shadow.calls.append, shadow.calls.search, shadow.calls.record, shadow.seq(), shadow.gmail.length,
			shadow.db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims").get().n, shadow.drafts().length], [0, 0, 0, 0, 0, 0, 0, 0],
		"§9 no invoice number, no Gmail append or search, no record(), no claim and no draft row: nothing reached the fake Gmail");
		eq(shadow.db.prepare("SELECT action FROM audit_trail ORDER BY id").all().map((r) => r.action), ["update_auto_invoice_settings"], "§9 ...and no audit row of its own");

		const real = await world({ env: ON_ENV, readablePdf: true });
		eq((await real.call("PUT", "/api/auto-invoice/settings", SA, CONFIRMED)).status, 200, "§9 real-draft world: the broker domain confirmed");
		await real.job.tick();
		real.deliver("123456789", rateCon());
		await real.job.tick();
		const claim = real.claim("123456789") || {};
		const mime = real.gmail[0] ? Buffer.from(real.gmail[0].mime, "latin1") : null;
		eq([claim.state, Boolean(mime), claim.invoice_id], ["drafted", true, `${TODAY_SEQ}-1`], "§9 drafted with the next number, its MIME kept by the fake Gmail");
		const sent = mimeRead && mime ? rules.messageDigest(mimeRead.parseMessage(mime), { renderedAt: "" }) : null;
		const part = (d) => (d ? { ...d, renderedAt: undefined, fingerprintSha256: undefined, firstAt: undefined, firstDomain: undefined } : null);
		ok(sent && /^[0-9a-f]{64}$/.test(sent.invoiceTextSha256), "§9 the invoice PDF in the MIME is read (its masked text has a digest)");
		eq(part(rec), part(sent), "§9 parity: the render shadow's digest equals the real draft's MIME's, field by field (the number masked)");
		let stored = null;
		try { stored = claim.draft_digest_json ? JSON.parse(claim.draft_digest_json) : null; } catch { stored = null; }
		eq(part(stored), part(sent), "§9 ...and the claim's own draft digest equals it too");
		const verdict = trialReport && mime && rec ? trialReport.judge({ expected: rec, candidates: [trialReport.sentCopy({ raw: mime })], nothingAfter: () => true }) : null;
		eq(verdict, { found: "one", failed: [] }, "§9 the report's six conditions, run on that MIME as the Sent copy, all hold");

		const TEMPLATE = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
		const at = TEMPLATE.indexOf("# --- Automatic broker invoice drafts");
		const words = (at >= 0 ? TEMPLATE.slice(at, TEMPLATE.indexOf("\n# ---", at + 1)) : "").replace(/\n#\s?/g, " ");
		ok(new RegExp(`(^|\\s)# ${RENDERS}=(\\s|$)|\\s${RENDERS}=\\s`).test(words) && /exactly "true", read only in shadow mode, and never in a replica/.test(words),
			"§9 the settings template's section names it, unset: on only when exactly \"true\", shadow mode only, never in a replica");
	}

	// ===================================================================== §10
	section("§10 sending through the block (AUTO_INVOICE_SEND_ENABLED), the engine as shipped");
	{
		const SEND_ENV = Object.freeze({ ...ON_ENV, AUTO_INVOICE_SEND_ENABLED: "true", AUTO_INVOICE_SEND_DOMAINS: "example-broker.test" });
		for (const [v, want] of [["true", true], ["TRUE", false], ["1", false], ["yes", false], ["", false]]) {
			eq((await world({ env: { ...SEND_ENV, AUTO_INVOICE_SEND_ENABLED: v } })).job.sending, want, `§10 FAILS ON THE OLD CODE: AUTO_INVOICE_SEND_ENABLED=${JSON.stringify(v)}: ${want ? "on" : "off"} (only exactly "true")`);
		}
		eq((await world({ env: SEND_ENV, replica: { stamp: "made-up" } })).job.sending, false, "§10 ...never in a replica (REPLICA set)");
		eq((await world({ env: { ...SEND_ENV, AUTO_INVOICE_DRAFTS_SHADOW: "" } })).job.sending, false, "§10 ...nor in shadow mode");
		eq((await world({ env: { ...SEND_ENV, AUTO_INVOICE_SEND_DOMAINS: "" } })).job.status().send, { domains: [], stopped: null }, "§10 ...and with no domain listed, it sends to none");
		const off = await world({ env: ON_ENV });
		eq([off.job.sending, off.registered.length, off.transports.length, off.job.status().send], [false, 5, 0, undefined], "§10 sending off: the five routes and the status as before, no SMTP transport");

		const w = await world({ env: SEND_ENV, readablePdf: true });
		eq([w.job.sending, w.registered.includes("POST /api/auto-invoice/send/stop"), w.registered.length], [true, true, 6], "§10 FAILS ON THE OLD CODE: sending on: the Stop route too");
		eq((await w.call("PUT", "/api/auto-invoice/settings", SA, CONFIRMED)).status, 200, "§10 the broker domain confirmed");
		await w.job.tick();
		// Hard rule 7's canary: a driver name and phone on the load must reach nothing LogisX composes.
		// Its POD came 61 minutes ago, past the settle window (below).
		const CANARY = "Canary Q. Driverson 321-555-0147";
		w.deliver("LD-TEST-0101", rateCon(), { Driver: CANARY }, { minutesAgo: 61 });
		await w.job.tick();
		const c = w.claim("LD-TEST-0101") || {};
		eq([c.state, c.delivery, c.stage, w.gmail.length], ["drafted", "send", "recorded", 0], "§10 FAILS ON THE OLD CODE: a load delivered after switch-on is sent, not drafted");
		eq(w.smtp.map((m) => ({ from: m.from, to: m.to, envelope: m.envelope, subject: m.subject, attachments: m.attachments })), [{
			from: `LogisX Inc. <${MAILBOX.GMAIL_USER}>`, to: BILLING, envelope: { from: MAILBOX.GMAIL_USER, to: [BILLING] }, subject: "Example Broker Order #LD-TEST-0101",
			attachments: ["Example Broker Invoice Order #LD-TEST-0101.pdf", "LD-TEST-0101_POD.pdf", "LD-TEST-0101.pdf"],
		}], "§10 FAILS ON THE OLD CODE: one message: from the mailbox, to the rate con's billing email alone, the invoice, the POD and the rate con");
		eq(w.transports, [{ service: "gmail", user: MAILBOX.GMAIL_USER }], "§10 FAILS ON THE OLD CODE: through Gmail's SMTP with the mailbox's own login");
		eq(w.verifies, 1, "§10 FAILS ON THE OLD CODE: it connects and logs in first, on a connection that carries no message");
		ok(w.smtp[0] && w.smtp[0].messageId === c.message_id && w.smtp[0].mime.includes(`Message-ID: ${c.message_id}`), "§10 FAILS ON THE OLD CODE: ...carrying the claim's own Message-ID, so a lost answer is looked for in Sent Mail");
		const files = w.smtp[0] ? w.smtp[0].attachmentBytes : [];
		ok(files[1] && files[1].toString("latin1") === "%PDF-1.4 made-up POD for LD-TEST-0101", "§10 FAILS ON THE OLD CODE: the POD goes as it is, byte for byte");
		eq(w.drafts().map(({ id, ...r }) => [r.invoice_id === c.invoice_id, r.recipient, r.via, r.created_by]), [[true, BILLING, "auto-smtp", "auto-invoice"]],
			"§10 FAILS ON THE OLD CODE: one draft row, via auto-smtp, by the system");
		eq([w.audits("invoice_draft_created").map((a) => a.details), w.audits("auto_invoice_sent").map((a) => [a.username, a.role, a.details])],
			[[`${c.invoice_id} → ${BILLING} (auto-smtp)`], [["auto-invoice", "system", `${c.invoice_id} → example-broker.test (sent by the automatic invoice job)`]]],
			"§10 FAILS ON THE OLD CODE: the engine's audit row names auto-smtp; one auto_invoice_sent row names the domain only");
		const invoiceText = files[0] ? require(path.join(ROOT, "lib", "pdf-shown-text.js")).shownText(files[0]) : "";
		const composed = [w.smtp[0] ? w.smtp[0].subject : "", w.smtp[0] ? rules.htmlToText(w.smtp[0].html) : "", invoiceText, w.smtp[0] ? w.smtp[0].attachments.join(" ") : ""].join(" ");
		ok(invoiceText && /Invoice ?ID/.test(invoiceText) && !/Canary|Driverson|555-0147/.test(composed),
			"§10 hard rule 7: the subject, the body, the invoice PDF and the file names LogisX composes carry no driver name or phone");

		// Stop, through the real Express app.
		eq((await w.call("POST", "/api/auto-invoice/send/stop", DISP, {})).status, 403, "§10 a Dispatcher can't stop sending");
		const limitedBefore = w.limited;
		const stop = await w.call("POST", "/api/auto-invoice/send/stop", SA, {});
		eq([stop.status, stop.json && stop.json.stopped && stop.json.stopped.reason, w.limited - limitedBefore], [200, "STOPPED_BY_ADMIN", 1], "§10 FAILS ON THE OLD CODE: a Super Admin stops it, through the limiter");
		eq(w.audits("auto_invoice_send_stopped").map((a) => [a.username, a.details]), [[SA.username, `STOPPED_BY_ADMIN by ${SA.username}`]], "§10 FAILS ON THE OLD CODE: ...audited by the person");
		const settings = await w.call("GET", "/api/auto-invoice/settings", SA);
		const stoppedAt = stop.json && stop.json.stopped ? stop.json.stopped.at : "(no stop on this tree)";
		eq(settings.json && settings.json.send, { domains: ["example-broker.test"], stopped: { at: stoppedAt, reason: "STOPPED_BY_ADMIN" } }, "§10 FAILS ON THE OLD CODE: the settings read shows the dialog the stop");
		w.deliver("LD-TEST-0102", rateCon());
		await w.job.tick();
		eq([w.smtp.length, w.gmail.length, w.state("LD-TEST-0102")], [1, 1, ["drafted", ""]], "§10 FAILS ON THE OLD CODE: stopped: the next load is a Gmail draft, nothing sent");

		// The Draft Invoice button: server.js asks the job right after the factoring check.
		const route = SRC.slice(SRC.indexOf('["/api/loads/:loadId/draft-invoice", "/api/loads/:loadId/draft-bison-invoice"],'));
		const early = route.indexOf("const factoringCheck = factoringRoutes.draftEarly(req, loadId);");
		const sentCheck = route.indexOf("const sentCheck = autoInvoice.draftButtonCheck(req, loadId, { dryRun });");
		ok(early > 0 && sentCheck > early && sentCheck < route.indexOf("// 1)") && route.includes("if (!sentCheck.ok) return res.status(sentCheck.http).json(sentCheck.json);"),
			"§10 FAILS ON THE OLD CODE: the Draft Invoice route asks draftButtonCheck() (with its dry-run flag) after the factoring check, before anything is read or minted");
		const handoff = route.indexOf("factoringRoutes.draftHandoff(req, {");
		ok(handoff > sentCheck && route.slice(handoff, route.indexOf("})", handoff)).includes("reissue: Boolean(sentCheck.reissue),"),
			"§10 FAILS ON THE OLD CODE: its late hand-off check is told whether the press confirmed a re-issue (else a send the job began meanwhile refuses it)");

		const TEMPLATE = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
		const at = TEMPLATE.indexOf("# --- Automatic broker invoice sending");
		const sectionText = at >= 0 ? TEMPLATE.slice(at, TEMPLATE.indexOf("\n# ---", at + 1)) : "";
		const words = sectionText.replace(/\n#\s?/g, " ");
		ok(/^# AUTO_INVOICE_SEND_ENABLED=$/m.test(sectionText) && /^# AUTO_INVOICE_SEND_DOMAINS=$/m.test(sectionText) && /exactly "true", and never in a replica/.test(words) && /Unset: nothing is sent/.test(words),
			"§10 FAILS ON THE OLD CODE: the settings template's section names both settings, unset: on only when exactly \"true\", never in a replica, no domain no send");
	}

	// ===================================================================== §11
	section("§11 the settle window through the block (AUTO_INVOICE_SEND_SETTLE_MINUTES)");
	{
		const SEND_ENV = Object.freeze({ ...ON_ENV, AUTO_INVOICE_SEND_ENABLED: "true", AUTO_INVOICE_SEND_DOMAINS: "example-broker.test" });
		// A load whose POD was uploaded `minutesAgo`, through the block with `env`.
		const fresh = async (env, minutesAgo) => {
			const x = await world({ env });
			eq((await x.call("PUT", "/api/auto-invoice/settings", SA, CONFIRMED)).status, 200, "§11 the broker domain confirmed");
			await x.job.tick();
			x.deliver("LD-TEST-0111", rateCon(), {}, { minutesAgo });
			const before = Date.now();
			await x.job.tick();
			const c = x.claim("LD-TEST-0111") || {};
			const outcome = c.state === "drafted" && c.delivery === "send" && x.smtp.length === 1 ? "sent"
				: c.state === "waiting" && c.reason_code === "SEND_SETTLING" && x.smtp.length === 0 ? "waiting" : `${c.state}/${c.reason_code}`;
			return { x, c, before, outcome };
		};
		const held = await fresh(SEND_ENV, 1);
		eq([held.c.state, held.c.reason_code, held.x.smtp.length, held.x.gmail.length, held.x.calls.prepare, held.x.calls.mint], ["waiting", "SEND_SETTLING", 0, 0, 0, 0],
			"§11 FAILS ON THE OLD CODE: the setting unset: a POD uploaded a minute ago holds the send (Waiting, SEND_SETTLING), with no engine call, number or message");
		const untilMs = Date.parse(held.c.next_attempt_at || "");
		ok(Number.isFinite(untilMs) && Math.abs(untilMs - (held.before + 59 * 60 * 1000)) < 2 * 60 * 1000,
			"§11 FAILS ON THE OLD CODE: ...until 60 minutes after the POD's own stamp (SQLite's CURRENT_TIMESTAMP, read as the UTC instant it is)");
		// What the block's environment gives the job: a whole number from 0 to 1440, else 60.
		for (const [value, minutesAgo, want, red] of [["0", 1, "sent", false], [" 2 ", 1, "waiting", true], ["90", 61, "waiting", true],
			["", 61, "sent", false], ["abc", 61, "sent", false], ["-1", 61, "sent", false], ["5000", 61, "sent", false]]) {
			const r = await fresh({ ...SEND_ENV, AUTO_INVOICE_SEND_SETTLE_MINUTES: value }, minutesAgo);
			eq(r.outcome, want, `§11 ${red ? "FAILS ON THE OLD CODE: " : ""}AUTO_INVOICE_SEND_SETTLE_MINUTES=${JSON.stringify(value)} through the block: a POD ${minutesAgo} minute(s) old is ${want}`);
		}
	}

	// ===================================================================== §12
	section("§12 the driver's Delivered, through the route and the block");
	{
		const SEND_ON = Object.freeze({ AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_SEND_ENABLED: "true", AUTO_INVOICE_SEND_DOMAINS: "example-broker.test", ...MAILBOX });
		const DRIVER = Object.freeze({ id: 3, username: "made_up_driver", role: "Driver", driverName: "Made-up Driver" });
		// By the clock, not by turns: the engine and the MIME builder do real work here. Only a
		// failure ever waits this long, so the budget is generous for a loaded box.
		const until = async (cond, label) => {
			const end = Date.now() + 30000;
			while (Date.now() < end) {
				if (cond()) return true;
				await new Promise((r) => setTimeout(r, 2));
			}
			failures.push(`${label}: the condition was never met`);
			return false;
		};
		const startedWorld = async (extra = {}) => {
			const x = await world({ env: SEND_ON, ...extra });
			eq((await x.call("PUT", "/api/auto-invoice/settings", SA, CONFIRMED)).status, 200, "§12 the broker domain confirmed");
			await x.job.finishStartUp();
			return x;
		};
		const atReceiver = (x, id) => {
			x.setLoad(id, { "Job Status": "At Receiver" });
			x.addPod(id);
			x.fileRateCon(id, rateCon());
		};
		const open = (x) => x.db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims WHERE state IN ('queued', 'working')").get().n;

		const w = await startedWorld();
		eq(w.job.triggerMode, true, "§12 FAILS ON THE OLD CODE: real drafts, the setting named nowhere: the driver's Delivered starts the invoice");
		eq([w.startsJob, w.intervals.length], [["automatic invoice drafts"], 0], "§12 FAILS ON THE OLD CODE: behind startsJob(), and no timer");
		ok(w.out.includes("[auto-invoice] trigger on, no timer"), "§12 FAILS ON THE OLD CODE: the start-up line says so");
		eq((await w.call("GET", "/api/auto-invoice/status", SA)).json.trigger && (await w.call("GET", "/api/auto-invoice/status", SA)).json.trigger.timer, false, "§12 FAILS ON THE OLD CODE: and the status route");

		const tap = w.statusRoute();
		atReceiver(w, "LD-TEST-1201");
		let atWrite = null;
		w.batchHook = () => { atWrite = w.state("LD-TEST-1201"); };
		const answered = await tap(DRIVER, "LD-TEST-1201");
		w.batchHook = null;
		eq([answered.status, answered.json], [200, { success: true }], "§12 the driver's tap answers as before");
		eq(atWrite, ["waiting", "DRIVER_PENDING"], "§12 FAILS ON THE OLD CODE: the record is there when the sheet write starts");
		eq(w.smtp.length, 0, "§12 ...and nothing has left when the route answers");
		await until(() => w.smtp.length === 1 && open(w) === 0, "§12 the send");
		const c = w.claim("LD-TEST-1201");
		eq([c.state, c.delivery, c.stage], ["drafted", "send", "recorded"], "§12 FAILS ON THE OLD CODE: with no tick: sent and recorded");
		eq(w.smtp.map((m) => [m.to, m.envelope.to, m.attachments]), [[BILLING, [BILLING], ["Example Broker Invoice Order #LD-TEST-1201.pdf", "LD-TEST-1201_POD.pdf", "LD-TEST-1201.pdf"]]],
			"§12 FAILS ON THE OLD CODE: one message, through the engine as shipped: the invoice, the POD and the rate con, to the one recipient");
		eq([w.gmail.length, w.drafts().map((r) => r.via), w.audits("auto_invoice_sent").length], [0, ["auto-smtp"], 1], "§12 no draft; one row, one audit row");
		await tap(DRIVER, "LD-TEST-1201");
		await settle();
		await settle();
		eq(w.smtp.length, 1, "§12 a repeat tap on the load sent: nothing more");

		// Only the driver: the same route, the same load shape, the office's roles.
		for (const [user, id] of [[DISP, "LD-TEST-1202"], [SA, "LD-TEST-1203"]]) {
			atReceiver(w, id);
			const r = await tap(user, id);
			await settle();
			await settle();
			eq([r.status, w.claim(id), w.smtp.length], [200, null, 1], `§12 ${user.role} marks it Delivered: the status is written, no record, no send`);
		}
		const rows = [{ "Load ID": "LD-TEST-1202", "Job Status": "Delivered", Email: BROKER, "Completion Date": DELIVERED_ON }];
		w.job.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: true });
		eq([rows[0]._autoInvoice.code, rows[0]._autoInvoice.retry], ["NOT_BY_DRIVER", "none"], "§12 FAILS ON THE OLD CODE: ...and a Super Admin's row reads \"No automatic invoice\"");

		// The driver's other statuses.
		atReceiver(w, "LD-TEST-1204");
		await tap(DRIVER, "LD-TEST-1204", "At Receiver");
		eq(w.claim("LD-TEST-1204"), null, "§12 a driver's other status: no record");

		// A write that reports failure but landed (R-H1).
		atReceiver(w, "LD-TEST-1205");
		w.batchFails = { landed: true };
		const lost = await tap(DRIVER, "LD-TEST-1205");
		eq([lost.status, lost.json && lost.json.error], [500, "made-up: no answer in 15 seconds"], "§12 a write whose answer is lost: the driver gets the error he gets today");
		await until(() => w.smtp.length === 2 && open(w) === 0, "§12 the landed write's send");
		eq([w.state("LD-TEST-1205"), w.smtp.length], [["drafted", ""], 2], "§12 FAILS ON THE OLD DESIGN (R-H1): it landed: the row is read back and the invoice goes, once");
		await tap(DRIVER, "LD-TEST-1205");
		await settle();
		await settle();
		eq(w.smtp.length, 2, "§12 ...his second tap sends nothing more");

		// A write that failed and didn't land.
		atReceiver(w, "LD-TEST-1206");
		w.batchFails = { landed: false };
		eq((await tap(DRIVER, "LD-TEST-1206")).status, 500, "§12 a write refused");
		await until(() => (w.claim("LD-TEST-1206") || {}).reason_code === "NOT_COMPLETED", "§12 read back");
		eq([w.state("LD-TEST-1206"), w.smtp.length], [["waiting", "NOT_COMPLETED"], 2], "§12 FAILS ON THE OLD CODE: no send, the record says so");
		eq((await tap(DRIVER, "LD-TEST-1206")).status, 200, "§12 ...his next tap");
		await until(() => w.smtp.length === 3 && open(w) === 0, "§12 the later tap's send");
		eq(w.state("LD-TEST-1206"), ["drafted", ""], "§12 FAILS ON THE OLD CODE: ...arms it: one send");
		eq(w.looks.map((l) => l.loadNumber), ["LD-TEST-1206"], "§12 FAILS ON THE OLD CODE (L3): ...after the look a press would get, by the search as the block hands it over");
		w.looks.length = 0;

		// A throw after the write (R-M1): the notification insert, with no try around it.
		atReceiver(w, "LD-TEST-1207");
		const noisy = w.statusRoute({ notificationThrows: true });
		const thrown = await noisy(DRIVER, "LD-TEST-1207");
		eq([thrown.status, thrown.json && thrown.json.error], [500, "made-up: the notification insert failed"], "§12 a throw after the write answers 500, as today");
		await until(() => w.smtp.length === 4 && open(w) === 0, "§12 the send after a throw");
		eq(w.state("LD-TEST-1207"), ["drafted", ""], "§12 FAILS ON THE OLD DESIGN (R-M1): ...and the invoice still goes, once");

		// The cache comes first: the run must not read the row from before the write.
		ok(w.invalidated >= 4, "§12 the route drops the cached sheet");

		// Try again through the route and the block's own readers.
		w.setLoad("LD-TEST-1208", { "Job Status": "At Receiver" });
		w.addPod("LD-TEST-1208");
		w.fileRateCon("LD-TEST-1208", rateCon({ total: "$9,999.00" }));
		await tap(DRIVER, "LD-TEST-1208");
		await until(() => w.state("LD-TEST-1208") && w.state("LD-TEST-1208")[0] === "needs_attention", "§12 held");
		eq(w.state("LD-TEST-1208"), ["needs_attention", "TOTAL_MISMATCH"], "§12 a total that disagrees: a person, nothing sent");
		w.setLoad("LD-TEST-1208", { "  Payment  ": "9999" });
		w.lookAnswer = { verdict: "invoice", mailboxes: {} };
		const droppedBefore = w.invalidated;
		eq((await w.call("POST", "/api/auto-invoice/loads/LD-TEST-1208/retry", SA, {})).status, 200, "§12 Try again");
		eq(w.invalidated, droppedBefore + 1, "§12 FAILS ON THE OLD DESIGN: Try again drops the cached sheet through the block, so the run reads the fix a person just made");
		await until(() => w.looks.length === 1 && open(w) === 0, "§12 the look");
		eq([w.state("LD-TEST-1208"), w.smtp.length, w.looks[0].loadNumber, w.looks[0].lastCheck, w.looks[0].user], [["needs_attention", "MAILBOX_HIT"], 4, "LD-TEST-1208", true, MAILBOX.GMAIL_USER],
			"§12 FAILS ON THE OLD CODE: an invoice in the mailbox: nothing sent, by the search as the block hands it over");
		w.lookAnswer = { verdict: "clean", mailboxes: {} };
		w.payments.push(["LD-TEST-1208", "Example", "9999", "", "", "Paid"]);
		await w.call("POST", "/api/auto-invoice/loads/LD-TEST-1208/retry", SA, {});
		await settle();
		await until(() => open(w) === 0 && w.state("LD-TEST-1208")[1] === "PAYMENTS_TABLE_HIT", "§12 the Payments Table");
		eq(w.smtp.length, 4, "§12 FAILS ON THE OLD CODE: a filled Payments Table row, read through the block: nothing sent");
		w.payments.pop();
		// Saved evidence, through the block's own dep: refused before anything runs, and free again once it's gone.
		const evidence = require(path.join(ROOT, "lib", "invoice-evidence.js"));
		evidence.saveAnswer(w.db, "ld-test-1208", { verdict: "invoice", mailboxes: { drafts: { invoice: 1 }, sent: {} } }, { nowIso: new Date().toISOString() });
		const refused = await w.call("POST", "/api/auto-invoice/loads/LD-TEST-1208/retry", SA, {});
		eq([refused.status, refused.json && refused.json.code, w.state("LD-TEST-1208"), w.smtp.length], [409, "AUTO_INVOICE_RETRY_REFUSED", ["needs_attention", "PAYMENTS_TABLE_HIT"], 4],
			"§12 saved evidence of an invoice: Try again is refused by the block's own dep, with nothing run");
		evidence.saveAnswer(w.db, "ld-test-1208", { verdict: "clean", mailboxes: { drafts: {}, sent: {} } }, { nowIso: new Date().toISOString() });
		await w.call("POST", "/api/auto-invoice/loads/LD-TEST-1208/retry", SA, {});
		await until(() => w.smtp.length === 5 && open(w) === 0, "§12 the clean look");
		eq(w.state("LD-TEST-1208"), ["drafted", ""], "§12 FAILS ON THE OLD CODE: both clean: one send");

		// A replica or an import: no record, whatever the role.
		const replica = await world({ env: SEND_ON, startsJobAnswer: false });
		await replica.job.finishStartUp();
		const replicaTap = replica.statusRoute();
		replica.setLoad("LD-TEST-1209", { "Job Status": "At Receiver" });
		replica.addPod("LD-TEST-1209");
		eq((await replicaTap(DRIVER, "LD-TEST-1209")).status, 200, "§12 a process that may not run jobs: the status route answers");
		eq([replica.claim("LD-TEST-1209"), replica.smtp.length, replica.intervals.length], [null, 0, 0], "§12 ...no record, no send, no timer");
		eq((await world({ env: SEND_ON, replica: { stamp: "made-up" } })).job.sending, false, "§12 a replica never sends, whatever the trigger says");

		// The kill switch: the sweep, its timer and today's route.
		const off = await world({ env: { ...SEND_ON, AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" } });
		eq([off.job.triggerMode, off.intervals.map((i) => i.ms)], [false, [300000]], "§12 AUTO_INVOICE_DRIVER_TRIGGER_ENABLED=false: the sweep's timer, as before");
		const offTap = off.statusRoute();
		off.setLoad("LD-TEST-1210", { "Job Status": "At Receiver" });
		off.addPod("LD-TEST-1210");
		eq((await offTap(DRIVER, "LD-TEST-1210")).status, 200, "§12 ...the status route as before");
		eq(off.db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims").get().n, 0, "§12 ...and no record until the sweep finds it");
		// The job off: nothing at all.
		const jobOff = await world({ env: { ...MAILBOX } });
		const jobOffTap = jobOff.statusRoute();
		jobOff.setLoad("LD-TEST-1211", { "Job Status": "At Receiver" });
		jobOff.addPod("LD-TEST-1211");
		await jobOff.job.finishStartUp();
		eq([(await jobOffTap(DRIVER, "LD-TEST-1211")).status, jobOff.job.triggerMode, jobOff.intervals.length, JSON.stringify(schema(jobOff.db)) === JSON.stringify(jobOff.schemaBefore)], [200, false, 0, true], "§12 the job off: the route as before, no table, no timer");
	}

	// ===================================================================== §13
	section("§13 only this route starts one, and server.js around it");
	{
		const STATUS = liftRoute(SRC, STATUS_HEAD);
		eq(SRC.split("autoInvoiceDriverStart(").length - 1, 2, "§13 FAILS ON THE OLD CODE: one definition, one call");
		ok(STATUS.includes("const invoiceStart = autoInvoiceDriverStart(req, {"), "§13 FAILS ON THE OLD CODE: the call is PUT /api/driver/status's");
		eq(SRC.split(".driverDelivered(").length - 1, 1, "§13 nothing else reaches the job's record");
		for (const head of [
			SRC.split("\n").find((l) => l.startsWith('app.put("/api/loads/:loadId/status-override",')),
			SRC.split("\n").find((l) => l.startsWith('app.put("/api/data/:rowIndex",')),
			SRC.split("\n").find((l) => l.startsWith('app.put("/api/load/:loadId",')),
			SRC.split("\n").find((l) => l.startsWith('app.post("/api/data",')),
		]) {
			ok(head && !/autoInvoiceDriverStart|driverDelivered|invoiceStart/.test(liftRoute(SRC, head)), `§13 ${head && head.slice(0, 50)}: starts nothing`);
		}
		const at = (needle) => STATUS.indexOf(needle);
		ok(at("if (!podRow || podRow.n === 0)") < at("autoInvoiceDriverStart(") && at("dispatchWriteBlocker(") < at("autoInvoiceDriverStart(") && at("sentIfDriverWriteOnOthersRow(") < at("autoInvoiceDriverStart("),
			"§13 FAILS ON THE OLD CODE: the record comes after every refusal: the POD gate, the month guard, the row's checks");
		ok(at("autoInvoiceDriverStart(") < at("spreadsheets.values.batchUpdate(") && /\}\)\.catch\(invoiceStart\.writeFailed\);/.test(STATUS), "§13 FAILS ON THE OLD CODE: ...and before the sheet write, whose failure it hears");
		ok(/jtCacheInvalidate\(\);\n\t\tinvoiceStart\.written\(\);\n\t\temitLoadEventToDispatch\(/.test(STATUS), "§13 FAILS ON THE OLD CODE: the record moves right after the cache is dropped, before anything that can throw");
		const listen = SRC.slice(SRC.indexOf("server.listen(PORT, BIND_HOST"));
		ok(listen.indexOf("autoInvoice.finishStartUp();") > 0 && listen.indexOf("autoInvoice.finishStartUp();") < listen.indexOf("process.umask(BOOT_UMASK)"), "§13 FAILS ON THE OLD CODE: start-up's second half runs when the app is listening");
		ok(BLOCK.indexOf("autoInvoice.startTrigger()") > BLOCK.indexOf('startsJob("automatic invoice drafts")') && BLOCK.indexOf("autoInvoice.startTrigger()") < BLOCK.indexOf("setInterval("), "§13 FAILS ON THE OLD CODE: the first half runs behind startsJob(), before the app listens");
		ok(/if \(autoInvoice\.triggerMode\) \{[\s\S]*?\} else \{[\s\S]*?setInterval\(/.test(BLOCK), "§13 FAILS ON THE OLD CODE: the sweep's timer only when the trigger is off");
		const upload = liftRoute(SRC, SRC.split("\n").find((l) => l.startsWith('app.post("/api/documents/upload",')));
		ok(upload.indexOf('if (docType === "POD") autoInvoicePodChanged(loadId);') > upload.indexOf("res.json({ success: true, driveUrl });"), "§13 FAILS ON THE OLD CODE: a POD upload checks its load, after the answer");
		const del = liftRoute(SRC, SRC.split("\n").find((l) => l.startsWith('app.delete("/api/documents/:id",')));
		ok(del.indexOf("if (isPod) autoInvoicePodChanged(loadId);") > del.indexOf("res.json({ success: true, id, loadId"), "§13 FAILS ON THE OLD CODE: a POD delete too");

		const TEMPLATE = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
		ok(/^# AUTO_INVOICE_DRIVER_TRIGGER_ENABLED=$/m.test(TEMPLATE) && /a kill switch, ON unless set to false/.test(TEMPLATE), "§13 FAILS ON THE OLD CODE: the settings template names it, unset, a kill switch");
	}

	// ===================================================================== §14
	section("§14 a blank Email, through the route, the block and the engine as shipped");
	{
		const CHR = "chrobinson.com";
		const CHR_ADDRESS = `made-up.billing@${CHR}`;
		const CHR_ON = Object.freeze({ AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_SEND_ENABLED: "true", AUTO_INVOICE_SEND_DOMAINS: CHR, ...MAILBOX });
		const DRIVER = Object.freeze({ id: 3, username: "made_up_driver", role: "Driver", driverName: "Made-up Driver" });
		const until = async (cond, label) => {
			const end = Date.now() + 10000;
			while (Date.now() < end) {
				if (cond()) return true;
				await new Promise((r) => setTimeout(r, 2));
			}
			failures.push(`${label}: the condition was never met`);
			return false;
		};
		const open = (x) => x.db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims WHERE state IN ('queued', 'working')").get().n;
		const proofs = (x, n) => {
			for (let i = 0; i < n; i++) {
				x.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', 'imap', 'made_up_admin')")
					.run(`LD-PROOF-${i}`, `09012026-${i}`, CHR_ADDRESS);
			}
		};
		const started = async ({ env = CHR_ON, rows = 3 } = {}) => {
			const x = await world({ env });
			eq((await x.call("PUT", "/api/auto-invoice/settings", SA, { optOutDomains: [], confirmedBrokerDomains: [CHR] })).status, 200, "§14 chrobinson.com confirmed");
			proofs(x, rows);
			x.geminiAnswer = { "Total Rate": "$1,500.00", Rate: null, "Order Number": null, "PO Number": null, "Documents Email": CHR_ADDRESS };
			await x.job.finishStartUp();
			return x;
		};
		const atReceiver = (x, id, over = {}) => {
			x.setLoad(id, { "Job Status": "At Receiver", Email: "", "Broker Contact Name": "Madeup Q. Contactperson", ...over });
			x.addPod(id);
			x.fileRateCon(id, plainRateCon(CHR_ADDRESS));
		};

		const w = await started();
		const tap = w.statusRoute();
		atReceiver(w, "900001401");
		eq((await tap(DRIVER, "900001401")).status, 200, "§14 the driver's tap answers as before");
		await until(() => w.smtp.length === 1 && open(w) === 0, "§14 the send");
		eq(w.state("900001401"), ["drafted", ""], "§14 FAILS ON THE OLD CODE: the setting named nowhere: a blank Email on a CHR load is sent");
		const sent = w.smtp[0] || { envelope: {}, mime: "" };
		eq([sent.to, sent.envelope.to, sent.subject], [CHR_ADDRESS, [CHR_ADDRESS], "C.H. Robinson Order #900001401"], "§14 FAILS ON THE OLD CODE: one message to the one address, the subject from its domain");
		eq(sent.attachments, ["C.H. Robinson Invoice Order #900001401.pdf", "900001401_POD.pdf", "900001401.pdf"], "§14 FAILS ON THE OLD CODE: the invoice, the POD and the rate con, through the engine as shipped");
		eq(w.drafts().filter((r) => r.load_id === "900001401").map((r) => [r.recipient, r.via]), [[CHR_ADDRESS, "auto-smtp"]], "§14 FAILS ON THE OLD CODE: one row, the job's send");
		ok(!/Contactperson/.test(sent.mime) && !/Contactperson/.test(JSON.stringify(w.db.prepare("SELECT * FROM load_invoice_drafts WHERE load_id = '900001401'").all())), "§14 the contact's name isn't in the MIME or the row");
		eq(w.gmail.length, 0, "§14 no draft");

		atReceiver(w, "900001402", { Email: "see rate con" });
		await tap(DRIVER, "900001402");
		await until(() => open(w) === 0 && Boolean(w.state("900001402")), "§14 a malformed cell");
		await settle();
		eq([w.state("900001402"), w.smtp.length], [["needs_attention", "NO_BROKER_EMAIL"], 1], "§14 a malformed cell isn't blank: a person, nothing sent");

		// The confirm, read as a Super Admin's row reads it, and Try again's look through the block.
		const few = await started({ rows: 2 });
		const fewTap = few.statusRoute();
		atReceiver(few, "900001403");
		await fewTap(DRIVER, "900001403");
		await until(() => open(few) === 0 && Boolean(few.state("900001403")), "§14 too few rows");
		await settle();
		eq([few.state("900001403"), few.smtp.length, few.calls.mint], [["needs_attention", "NO_BROKER_EMAIL"], 0, 0], "§14 2 rows: a person, nothing sent, no number");

		const held = await started();
		const heldTap = held.statusRoute();
		atReceiver(held, "900001404", { "  Payment  ": "900" });
		await heldTap(DRIVER, "900001404");
		await until(() => open(held) === 0 && Boolean(held.state("900001404")), "§14 held");
		await settle();
		eq([held.state("900001404"), held.smtp.length], [["needs_attention", "TOTAL_MISMATCH"], 0], "§14 FAILS ON THE OLD CODE: a total that disagrees: a person");
		held.setLoad("900001404", { "Job Status": "Delivered", Email: "", "  Payment  ": "1500" });
		const rows = [{ "Load ID": "900001404", "Job Status": "Delivered", Email: "", "Completion Date": DELIVERED_ON }];
		held.job.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: true });
		eq(rows[0]._autoInvoice.retry, "send", "§14 FAILS ON THE OLD CODE: the confirm says Try again can send");
		held.lookAnswer = { verdict: "invoice", mailboxes: {} };
		eq((await held.call("POST", "/api/auto-invoice/loads/900001404/retry", SA, {})).status, 200, "§14 Try again");
		await until(() => held.looks.length === 1 && open(held) === 0, "§14 the look");
		eq([held.state("900001404"), held.smtp.length], [["needs_attention", "MAILBOX_HIT"], 0], "§14 FAILS ON THE OLD DESIGN (R-H2 (a)): billed from Gmail: the look runs, and no second invoice");
		held.lookAnswer = { verdict: "clean", mailboxes: {} };
		await held.call("POST", "/api/auto-invoice/loads/900001404/retry", SA, {});
		await until(() => held.smtp.length === 1 && open(held) === 0, "§14 the clean look");
		eq([held.state("900001404"), held.smtp[0].to], [["drafted", ""], CHR_ADDRESS], "§14 FAILS ON THE OLD CODE: both clean: one send");

		for (const v of ["false", "off"]) {
			const off = await started({ env: { ...CHR_ON, AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED: v } });
			const offTap = off.statusRoute();
			atReceiver(off, "900001405");
			await offTap(DRIVER, "900001405");
			await until(() => open(off) === 0 && Boolean(off.state("900001405")), "§14 the kill switch");
			await settle();
			eq([off.state("900001405"), off.smtp.length, off.calls.prepare], [["needs_attention", "NO_BROKER_EMAIL"], 0, 0], `§14 AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED=${v}: a person, no engine call`);
		}
		const sweep = await started({ env: { ...CHR_ON, AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" } });
		sweep.deliver("900001406", plainRateCon(CHR_ADDRESS), { Email: "" });
		await sweep.job.tick();
		sweep.setLoad("900001407", { Email: "" });
		await sweep.job.tick();
		eq([sweep.state("900001407"), sweep.smtp.length, sweep.calls.prepare], [["needs_attention", "NO_BROKER_EMAIL"], 0, 0], "§14 the sweep: the flag ignored");
		const replica = await world({ env: CHR_ON, replica: { stamp: "made-up" } });
		eq(replica.job.sending, false, "§14 a replica never sends, so this path can't run there");

		// getRateConBytes() as shipped finds a Drive file by a substring of its name, so load
		// 9000015 finds the rate con of load 900001502.
		const named = await started();
		const namedTap = named.statusRoute();
		const inLonger = (x, id, over = {}) => {
			x.setLoad(id, { "Job Status": "At Receiver", Email: "", "Broker Contact Name": "Madeup Q. Contactperson", ...over });
			x.addPod(id);
			x.drive.push({ id: `made-up-file-${x.drive.length + 1}`, name: "Subject: Rate Confirmation 900001502.pdf", bytes: plainRateCon(CHR_ADDRESS) });
		};
		inLonger(named, "9000015");
		await namedTap(DRIVER, "9000015");
		await until(() => open(named) === 0 && Boolean(named.state("9000015")), "§14 another load's Drive file");
		await settle();
		ok(named.calls.driveGet >= 1, "§14 ...the file was found, and read");
		eq([named.state("9000015"), named.smtp.length, named.calls.mint], [["needs_attention", "NO_BROKER_EMAIL"], 0, 0], "§14 FAILS ON THE OLD CODE (L6): a blank Email: a Drive file named for a longer number names no recipient: a person, nothing sent, no number");
		const plain = await started();
		const plainTap = plain.statusRoute();
		inLonger(plain, "9000015", { Email: `made-up.agent@${CHR}` });
		await plainTap(DRIVER, "9000015");
		await until(() => plain.smtp.length === 1 && open(plain) === 0, "§14 the plain path's send");
		eq(plain.smtp.map((m) => m.to), [CHR_ADDRESS], "§14 a filled Email keeps today's file-name test: the plain path isn't changed");
	}
})().catch((e) => failures.push(`threw: ${e && e.stack}`)).then(async () => {
	for (const w of openWorlds) await w.close().catch(() => {});
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
