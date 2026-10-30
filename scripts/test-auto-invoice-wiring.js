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
 *      tick logged by its code), a replica's start, and server.js around the block
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
const { closure, liftRoute } = require(path.join(__dirname, "lib", "server-lift.js"));
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
const realImap = require(path.join(ROOT, "lib", "imap-draft.js"));
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const appTime = require(path.join(ROOT, "lib", "app-time.js"));
const serverRequire = createRequire(path.join(ROOT, "server.js"));

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
const ON_ENV = Object.freeze({ AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", ...MAILBOX });
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
async function world({ env = {}, startsJobAnswer = true } = {}) {
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
		dir: fs.mkdtempSync(path.join(os.tmpdir(), "auto-invoice-wiring-")),
	};
	fs.mkdirSync(path.join(w.dir, "uploads"));
	const db = new Database(":memory:");
	w.db = db;
	for (const t of TABLES) db.exec(createSql(t));
	for (const a of ALTERS) db.exec(a);

	const quiet = { log() {}, info() {}, warn: (...a) => w.logs.push(a.join(" ")), error: (...a) => w.logs.push(a.join(" ")) };
	const proc = { env: w.env };
	const sheets = {
		spreadsheets: { values: { get: async () => { w.calls.sheetsGet++; return { data: { values: w.sheet.map((r) => r.slice()) } }; } } },
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
		return { "Total Rate": null, Rate: null, "Order Number": null, "PO Number": null, "Documents Email": null };
	};
	// lib/pdf-browser.js's busy refusal carries this code.
	const renderHtmlToPdf = async () => {
		w.calls.renderer++;
		if (w.rendererBusy) throw Object.assign(new Error("made-up: every page is in use"), { code: "PDF_RENDERER_BUSY" });
		return Buffer.from("%PDF-1.4 made-up invoice");
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
		require: (p) => { w.required.push(p); return p === "./lib/imap-draft" ? imapModule : serverRequire(p); },
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
		REPLICA: null,
		logAudit: H.logAudit,
		insertDispatchNotification: H.insertDispatchNotification,
		io: { to: (room) => ({ emit: (event, payload) => w.sockets.push({ room, event, payload }) }) },
		app,
		requireRole: H.requireRole,
		refuseCrossSite: (req, res, next) => { w.crossSite++; next(); },
		startsJob: (name) => { w.startsJob.push(name); return startsJobAnswer; },
		setInterval: (fn, ms) => { w.intervals.push({ fn, ms }); return 0; },
	};
	w.schemaBefore = schema(db);
	const names = Object.keys(scope);
	const block = BLOCK.replace(/\brateConGeminiUnavailableAt\b/g, "__geminiAt()");
	w.job = new Function(...names, "__geminiAt", `${block}\nreturn autoInvoice;`)(...names.map((n) => scope[n]), () => w.geminiAt);

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
	w.addPod = (id) => {
		const name = `${id}_POD.pdf`;
		fs.writeFileSync(path.join(w.dir, "uploads", name), `%PDF-1.4 made-up POD for ${id}`);
		db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_url) VALUES (?, 'Made-up Driver', 'POD', ?, ?)").run(id, name, `/uploads/${name}`);
	};
	// Named as the n8n workflow names a rate con it files: the load ID in the subject.
	w.fileRateCon = (id, bytes) => {
		w.drive.push({ id: `made-up-file-${w.drive.length + 1}`, name: `Subject: Rate Confirmation ${id.replace(/[^A-Za-z0-9]/g, "")}.pdf`, bytes });
	};
	w.deliver = (id, rc, over = {}) => { w.setLoad(id, over); w.addPod(id); if (rc) w.fileRateCon(id, rc); };
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
		eq(w.required.filter((p) => p.startsWith("./lib/")), ["./lib/imap-draft", "./lib/auto-invoice-job"], "§3 the block loads the job and lib/imap-draft.js as shipped");
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
		ok(/if \(autoInvoice\.mode !== "off"\) autoInvoice\.mount\(app, \{ requireRole, refuseCrossSite \}\);/.test(BLOCK) &&
			/if \(autoInvoice\.mode !== "off" && startsJob\("automatic invoice drafts"\)\) \{/.test(BLOCK),
		"§7 the block mounts the routes and starts the timer only when the mode isn't off");
		ok(SRC.indexOf(START) < SRC.indexOf("const brokerInvoiceDraft = require(\"./lib/broker-invoice-draft\")") &&
			/prepare: \(args\) => brokerInvoiceDraft\.prepare\(args\)/.test(BLOCK),
		"§7 the engine is server.js's own, created below the block and read at each call");
		eq([w.H.noticeTypeScope(SA).sql, w.H.noticeTypeScope(DISP).params.includes("auto-invoice")], ["1 = 1", true],
			"§7 noticeTypeScope(): the auto-invoice notices are left out for everyone but Super Admins");
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
