#!/usr/bin/env node
// Who an automatic C.H. Robinson invoice may go to (AUTO_INVOICE_KNOWN_ADDRESS_ENABLED, a kill
// switch that fails safe): the job (lib/auto-invoice-job.js) over the Draft Invoice button's
// engine as shipped (lib/broker-invoice-draft.js), with made-up loads on an in-memory database.
// Only the outside world is made up: Sheets, Drive, Gemini, the PDF renderer, Gmail and SMTP. The
// route, the block and the Drive lookup run in scripts/test-auto-invoice-wiring.js §14.
//
//   §1  the flag: on unless it says off, and a typo leaves it on
//   §2  whose rows prove an address: a person's, on distinct loads, to that exact address
//   §3  the rule on its own
//   §4  an address that passes: one send, to that address
//   §5  an address that doesn't: Needs attention, nothing sent, no number, no fallback
//   §6  a Drive rate con whose name doesn't carry the load's whole number: the same
//   §7  a claim that runs with no fresh decision looks first, and a first tap doesn't
//   §8  the kill switch fails safe: with the check off, a person, never the unchecked send
//   §9  other brokers, the sweep, shadow mode and a person's press
//   §10 it can't send twice
//   §11 deploying sends nothing and moves nothing already held
//   §12 the rate con must say it's this load's: its read's Load Number, and its text prints it
//   §13 a hold on the address or the file tells a person: one notice per reason a day, an audit row
//       and a log line, and the settings count it; another broker's on the same code doesn't
//
// Addresses on chrobinson.com use made-up local parts. No network, no files, never reads app.db.
//   node scripts/test-auto-invoice-known-address.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const DEFAULT_INBOX = "made-up-default-inbox@example.test";
process.env.DEFAULT_INVOICE_EMAIL = DEFAULT_INBOX;
process.env.BISON_INVOICE_EMAIL = "made-up-bison-inbox@example.test";

const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
const engineModule = require(path.join(ROOT, "lib", "broker-invoice-draft.js"));
const jobLib = require(path.join(ROOT, "lib", "auto-invoice-job.js"));
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const ledger = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const chrEvents = require(path.join(ROOT, "lib", "chr-events.js"));
const { closure } = require(path.join(__dirname, "lib", "server-lift.js"));
const { textPdf } = require(path.join(__dirname, "lib", "made-up-pdf.js"));
const SRC = require("./lib/server-source").serverSource();

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

const DOMAIN = "chrobinson.com";
const ADDRESS = `made-up.billing@${DOMAIN}`;
const AGENT = `made-up.agent@${DOMAIN}`;
const OTHER = `made-up.other@${DOMAIN}`;
const HEADERS = Object.freeze(["Load ID", "Trailer Number", "Driver", "Job Status", "Email", "Broker Contact Name", "Completion Date", "  Payment  "]);
const PAYMENTS_HEADERS = Object.freeze([" Job ID", "Contract ID", "Payment Amount", "Invoice Number", "Payment Date", "Payment Status"]);
const ID = "900000101";
const NOT_KNOWN = Object.freeze(["needs_attention", "RECIPIENT_NOT_KNOWN"]);
const NAME = Object.freeze(["needs_attention", "RATECON_NAME_MISMATCH"]);
const CHECK_OFF = Object.freeze(["needs_attention", "RECIPIENT_CHECK_OFF"]);
const NUMBER = Object.freeze(["needs_attention", "RATECON_NUMBER_MISMATCH"]);
const SENT = Object.freeze(["drafted", ""]);
// No SMTP call, no Gmail draft, no number.
const NOTHING = Object.freeze([0, 0, 0]);
const HIT = Object.freeze({ verdict: "invoice", mailboxes: {} });

function pdfWith(contentStream) {
	const z = zlib.deflateSync(Buffer.from(contentStream, "latin1"));
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n1 0 obj<</Length ${z.length}/Filter/FlateDecode>>stream\n`, "latin1"),
		z,
		Buffer.from("\nendstream endobj\n%%EOF", "latin1"),
	]);
}
// No billing block, as a C.H. Robinson rate con: the free scan finds the address at most, so the
// total is Gemini's to read.
const plainPdf = (note, printed) => pdfWith(`BT (Load confirmation for a made-up shipment ${note}) Tj ${printed ? `(Send billing documents to ${printed}) Tj ` : ""}ET`);

const lifted = closure(SRC, {
	roots: ["parseSheet", "deduplicateLoads", "findCol", "parseInvoiceOverrides", "latestDraftNotes", "safeAttachmentName", "sanitizeEvidenceText", "logAudit"],
	provided: ["db", "brokerInvoice", "console"],
	denied: ["app", "server", "io", "getSheets", "getDrive"],
});
const createSql = (name) => {
	const at = SRC.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
	return SRC.slice(at, SRC.indexOf("`", at));
};
const DRAFTS_ALTERS = [...SRC.matchAll(/db\.exec\("(ALTER TABLE load_invoice_drafts ADD COLUMN [^"]+)"\)/g)].map((m) => m[1]);
const QUIET = { log() {}, warn() {}, error() {} };

const turn = () => new Promise((r) => setImmediate(r));
// By the clock: the engine does real work. Only a failure ever waits this long.
async function until(cond, label, ms = 30000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 1));
	}
	failures.push(`${label}: the condition was never met`);
	return false;
}

// `domains`: the send list. `confirmed`, `optOut`: the settings. `proofs`: loads a person invoiced
// at ADDRESS. `send`: false turns sending off.
function makeWorld({ domains = [DOMAIN], confirmed = [DOMAIN], optOut = [], proofs = 3, send = true, env = {} } = {}) {
	const w = {
		now: T0,
		headers: HEADERS,
		rows: [],
		files: new Set(),
		candidates: new Map(),
		answers: new Map(),
		scans: new Map(),
		smtp: [],
		appends: [],
		gmail: [],
		sent: [],
		notices: [],
		logs: [],
		payments: [[...PAYMENTS_HEADERS]],
		lookAnswer: { verdict: "clean", mailboxes: {} },
		calls: { prepare: [], render: 0, mint: 0, gemini: 0, look: [], payments: 0 },
		ids: 0,
		env,
	};
	const db = new Database(":memory:");
	w.db = db;
	db.exec(createSql("load_invoice_drafts"));
	for (const a of DRAFTS_ALTERS) db.exec(a);
	db.exec(createSql("audit_trail"));
	db.exec(`
		CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, driver TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
			file_name TEXT NOT NULL, drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_at DATETIME DEFAULT NULL);
		CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME, deleted_by TEXT DEFAULT '');
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
	`);
	db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?)").run(JSON.stringify({ optOutDomains: optOut, confirmedBrokerDomains: confirmed }));

	const helpers = new Function("db", "brokerInvoice", "console", `${lifted.text}\nreturn { ${lifted.names.join(", ")} };`)(db, brokerInvoice, QUIET);
	w.helpers = helpers;
	// The free scan needs a listed local part, and these are made up, so an alternate file's
	// address is handed to the reader here. Everything else is read as shipped.
	const reader = Object.create(brokerInvoice);
	reader.extractRateConFields = async (buf, opts) => (w.scans.has(buf)
		? { orderNumber: "", poNumber: "", moveNumber: "", trailerNumber: "", totalRate: "", documentsEmail: w.scans.get(buf) }
		: brokerInvoice.extractRateConFields(buf, opts));
	w.values = () => [w.headers.slice(), ...w.rows.map((r) => w.headers.map((h) => r[h]))];
	w.engine = engineModule.create({
		...helpers,
		db,
		brokerInvoice: reader,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: w.values() } }) } } }),
		SPREADSHEET_ID: "made-up-sheet",
		fetchDocumentBytes: async (d) => Buffer.from(`%PDF-1.4 ${d.file_name}`),
		buildRateConLoadCtx: (row, h, loadId) => ({ loadId }),
		getRateConBytes: async (loadId) => {
			const list = w.candidates.get(rules.loadKey(loadId)) || [];
			return { buffer: list[0] ? list[0].buffer : null, candidates: list };
		},
		GEMINI_API_KEY: "made-up-key",
		runRateConGemini: async (b64) => {
			w.calls.gemini++;
			return w.answers.get(b64) || { "Total Rate": null, Rate: null, "Order Number": null, "PO Number": null, "Documents Email": null };
		},
		renderHtmlToPdf: async (html) => textPdf(rules.htmlToText(html)),
		env: {},
		console: QUIET,
	});
	const counted = {
		prepare: async (args) => {
			w.calls.prepare.push(args);
			return w.engine.prepare(args);
		},
		render: async (ctx, opts) => {
			w.calls.render++;
			if (w.renderHook) await w.renderHook(ctx);
			return w.engine.render(ctx, opts);
		},
		record: async (ctx, rendered, opts) => {
			if (w.recordThrowsOnce) {
				w.recordThrowsOnce = false;
				throw Object.assign(new Error("made-up: the row could not be written"), { code: "SQLITE_BUSY" });
			}
			return w.engine.record(ctx, rendered, opts);
		},
	};
	w.row = (id) => w.rows.find((r) => r["Load ID"] === id) || null;
	w.setRow = (id, over = {}) => {
		const was = w.row(id);
		const row = { ...(was || { "Load ID": id, "Trailer Number": "TR-1", Driver: "Made-up Driver", "Job Status": "At Receiver", Email: AGENT,
			"Broker Contact Name": "Made-up Agent", "Completion Date": "10/20/2026", "  Payment  ": "$1,000.00" }), ...over };
		const at = w.rows.indexOf(was);
		if (at >= 0) w.rows[at] = row; else w.rows.push(row);
	};
	w.addPod = (id) => {
		const name = `pod-${rules.loadKey(id)}-${db.prepare("SELECT COUNT(*) n FROM documents").get().n}.pdf`;
		db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'POD', ?, ?, '2026-10-20 13:00:00')").run(id, name, `/uploads/${name}`);
		w.files.add(name);
	};
	// One rate con on file, named by `source`, whose Gemini read gives the address, the total and
	// `number`, and whose text prints `note` and the address.
	w.rateCon = (id, { address = ADDRESS, total = "$1,000.00", source = "drive", driveFileName = `Subject: Rate Confirmation ${String(id).replace(/^#/, "")}.pdf`, printed = address, read = address, number = id, note = id, orderNumber = null } = {}) => {
		const bytes = plainPdf(note, printed);
		w.answers.set(bytes.toString("base64"), { "Total Rate": total, Rate: null, "Load Number": number, "Order Number": orderNumber, "PO Number": null, "Documents Email": read });
		const cand = { buffer: bytes, source, label: source, fileName: "rc.pdf", ...(source === "drive" ? { driveFileName } : {}) };
		w.candidates.set(rules.loadKey(id), [...(w.candidates.get(rules.loadKey(id)) || []), cand]);
		return cand;
	};
	// A load ready to be delivered: its POD on file, its rate con, a filled Email, At Receiver.
	w.ready = (id, over = {}, rc = {}) => {
		w.setRow(id, over);
		w.addPod(id);
		if (rc) w.rateCon(id, rc);
	};
	w.rowFor = (loadId, address, via = "imap") => db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', ?, 'made-up-admin')")
		.run(loadId, `09012026-${++w.ids}`, address, via);
	// `n` loads a person invoiced at this address, each with its own row.
	w.proof = (address, n, via = "imap") => {
		for (let i = 0; i < n; i++) w.rowFor(`LD-PROOF-${++w.ids}`, address, via);
	};
	w.proof(ADDRESS, proofs);
	w.env0 = { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", ...env };
	w.deps = (extra = {}) => ({
		db,
		env: w.env0,
		now: () => new Date(w.now),
		readJobTracking: async () => Object.freeze({ headers: w.headers, data: Object.freeze(helpers.deduplicateLoads(w.rows.map((r) => ({ ...r })), [...w.headers])) }),
		closedMonthsOf: () => [],
		dayKeyOf: (cell) => {
			const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(cell || ""));
			return m ? `${m[3]}-${m[1]}-${m[2]}` : "";
		},
		uploadsRoot: path.join(path.sep, "made-up", "uploads"),
		fileExists: (p) => w.files.has(path.basename(p)),
		engine: counted,
		nextInvoiceNumber: () => {
			w.calls.mint++;
			return `10202026-${w.calls.mint}`;
		},
		async appendGmailDraft(o) {
			w.appends.push({ to: o.to, subject: o.subject, messageId: o.messageId });
			w.gmail.push(o.messageId);
			return { ok: true };
		},
		async findDraftByMessageId({ messageId, mailboxes }) {
			const boxes = mailboxes || ["[Gmail]/Drafts", "[Gmail]/Sent Mail"];
			const held = (box) => (box === "[Gmail]/Drafts" ? w.gmail : w.sent).filter((id) => id === messageId).length;
			const hit = boxes.find((b) => held(b) > 0);
			return { found: Boolean(hit), count: hit ? held(hit) : 0, mailbox: hit || "" };
		},
		newMessageId: () => `<made-up-${++w.ids}.auto-invoice@example.com>`,
		mailbox: () => ({ user: "drafts@example.com", pass: "made-up" }),
		bisonRecipient: () => process.env.BISON_INVOICE_EMAIL,
		logAudit: helpers.logAudit,
		notify: (n) => w.notices.push(n),
		log: { warn: (m) => w.logs.push(m), error: (m) => w.logs.push(m) },
		timeZone: "America/New_York",
		workerId: "worker-1",
		send: { enabled: send, domains, settleMinutes: 0 },
		async sendMail(o) {
			w.smtp.push(o);
			w.sent.push(o.messageId);
			return { ok: true };
		},
		invalidateJobTracking: () => {},
		rateConTextOf: (bytes) => brokerInvoice.extractPdfText(bytes),
		readPaymentsTable: async () => {
			w.calls.payments++;
			if (w.paymentsFail) throw new Error("made-up Sheets failure");
			return w.payments;
		},
		lookInMailbox: async (o) => {
			w.calls.look.push(o);
			if (w.lookFails) throw new Error("made-up IMAP failure");
			return w.lookAnswer;
		},
		sleep: async () => {},
		...extra,
	});
	w.job = (extra = {}) => jobLib.create(w.deps(extra));
	w.claim = (id) => db.prepare("SELECT * FROM auto_invoice_claims WHERE load_key = ?").get(rules.loadKey(id)) || null;
	w.state = (id) => {
		const c = w.claim(id);
		return c ? [c.state, c.reason_code] : null;
	};
	w.open = () => db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims WHERE state IN ('queued', 'working')").get().n;
	w.draftRow = (id) => db.prepare("SELECT recipient, via FROM load_invoice_drafts WHERE load_id = ?").all(id);
	w.meta = (key, value) => {
		ledger.ensureSchema(db);
		ledger.setMeta(db, key, value);
	};
	w.started = async (extra = {}) => {
		w.meta("baseline_at", iso(T0 - 24 * HOUR));
		w.meta("trigger_on_at", iso(T0 - HOUR));
		const job = w.job(extra);
		job.startTrigger();
		await job.finishStartUp();
		return job;
	};
	w.seed = (id, { state, code = "", ...rest }) => {
		ledger.insertClaim(db, { key: rules.loadKey(id), loadId: id, state, code, nowIso: iso(w.now) });
		const cols = Object.keys(rest);
		if (cols.length) db.prepare(`UPDATE auto_invoice_claims SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE load_key = ?`).run(...cols.map((c) => rest[c]), rules.loadKey(id));
	};
	return w;
}

// What PUT /api/driver/status does around its sheet write.
function tap(w, job, id, role = "Driver") {
	const start = job.driverDelivered({ role, loadId: id, oldStatus: w.row(id)["Job Status"], newStatus: "Delivered", readBack: async () => w.row(id)["Job Status"] });
	w.setRow(id, { "Job Status": "Delivered" });
	start.written();
}
const drained = (w, label) => until(() => w.open() === 0, `${label}: every claim settled`);
async function settled(w, label) {
	await turn();
	await drained(w, label);
	await turn();
	await turn();
}
async function deliver(w, job, id, label = id) {
	tap(w, job, id);
	await settled(w, label);
}
function fakeApp() {
	const routes = {};
	const add = (method) => (p, ...handlers) => { routes[`${method} ${p}`] = handlers; };
	const app = { get: add("GET"), put: add("PUT"), post: add("POST"), delete: add("DELETE") };
	const call = async (method, p, { params = {}, body = {} } = {}) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		const req = { params, body, session: { user: { id: 7, username: "made-up-admin", role: "Super Admin" } } };
		for (const h of routes[`${method} ${p}`]) {
			let next = false;
			await h(req, res, () => { next = true; });
			if (!next) break;
		}
		return out;
	};
	return { app, requireRole: () => (req, res, next) => next(), call };
}
function tryAgain(job, id) {
	const f = fakeApp();
	job.mount(f.app, { requireRole: f.requireRole });
	return f.call("POST", "/api/auto-invoice/loads/:loadKey/retry", { params: { loadKey: id } });
}
const settingsOf = async (job) => {
	const f = fakeApp();
	job.mount(f.app, { requireRole: f.requireRole });
	return (await f.call("GET", "/api/auto-invoice/settings")).body;
};
const retryOf = (w, job, id) => {
	const rows = [{ ...w.row(id) }];
	job.annotateCompletedRows({ rows, headers: [...w.headers], isSuperAdmin: true });
	return rows[0]._autoInvoice && rows[0]._autoInvoice.retry;
};
const paidNothing = (w) => [w.smtp.length, w.appends.length, w.calls.mint];
const namesOf = (m) => ((m && m.attachments) || []).map((a) => a.filename);
const pressed = (job, id = ID) => {
	const p = job.draftButtonCheck({ session: { user: { username: "made-up-admin" } }, body: {} }, id);
	return [p.ok, p.http, (p.json || {}).code];
};
// A tree without the check fails case by case, not by a stack trace.
const flagOf = (env) => (typeof rules.knownAddressEnabled === "function" ? rules.knownAddressEnabled(env) : null);
const loadsTo = (db, address) => (typeof ledger.invoiceLoadsTo === "function" ? ledger.invoiceLoadsTo(db, address) : null);
const refusalOf = (args) => (typeof rules.knownAddressRefusal === "function" ? rules.knownAddressRefusal(args) : "NO_SUCH_RULE");

(async () => {
	// ===================================================================== §1
	section("§1 the flag: on unless it says off, and a typo leaves it on");
	{
		for (const [v, want] of [
			[undefined, true], ["", true], ["true", true], ["1", true], ["yes", true], ["on", true],
			["flase", true], ["fasle", true], ["offf", true], ["of", true], ["n0", true], ["disabled", true], ["none", true], ["false,", true],
			["false", false], ["FALSE", false], [" false ", false], ["0", false], ["no", false], ["NO", false], ["off", false], ["Off", false], [" OFF ", false],
		]) {
			eq(flagOf({ AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: v }), want, `§1 AUTO_INVOICE_KNOWN_ADDRESS_ENABLED=${JSON.stringify(v)}: the check is ${want ? "on" : "off"}`);
		}
		eq(flagOf(undefined), true, "§1 no settings at all: on");
		eq(rules.KNOWN_ADDRESS_DOMAIN, chrEvents.CHR_DOMAIN, "§1 the domain is the one the CHR code knows");
		eq(rules.KNOWN_ADDRESS_MIN_LOADS, 3, "§1 at least 3 loads");
		for (const code of ["RECIPIENT_NOT_KNOWN", "RATECON_NAME_MISMATCH", "RECIPIENT_CHECK_OFF"]) ok(rules.REASON_CODES.includes(code), `§1 ${code} is a reason code`);
		const template = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
		ok(/^# AUTO_INVOICE_KNOWN_ADDRESS_ENABLED=$/m.test(template) && /AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: a kill switch that fails safe, ON unless set to false/.test(template), "§1 the settings template names it, unset, a kill switch that fails safe");
	}

	// ===================================================================== §2
	section("§2 whose rows prove an address");
	{
		const w = makeWorld({ proofs: 0 });
		eq(loadsTo(w.db, ADDRESS), 0, "§2 no rows: none");
		w.proof(ADDRESS, 3);
		eq(loadsTo(w.db, ADDRESS), 3, "§2 a person's press on three loads: three");
		eq(loadsTo(w.db, ADDRESS.toUpperCase()), 3, "§2 asked in capitals: the same");
		eq(loadsTo(w.db, `  ${ADDRESS}  `), 3, "§2 asked with spaces around it: the same");
		eq(loadsTo(w.db, OTHER), 0, "§2 another address on the domain: none");
		eq([loadsTo(w.db, ""), loadsTo(w.db, null), loadsTo(w.db, undefined)], [0, 0, 0], "§2 no address: none");
		const via = makeWorld({ proofs: 0 });
		via.proof(ADDRESS, 1, "imap");
		via.proof(ADDRESS, 1, "n8n");
		eq(loadsTo(via.db, ADDRESS), 2, "§2 Gmail and the n8n fallback both count");
		for (const other of ["auto-smtp", "auto-imap", "", "IMAP", "manual", "made-up"]) via.proof(ADDRESS, 4, other);
		via.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES ('LD-NO-VIA', '1', ?, 'ratecon', NULL, 'x')").run(ADDRESS);
		eq(loadsTo(via.db, ADDRESS), 2, "§2 the job's sends and drafts, a blank via, no via and any other via: not counted");
		const spelled = makeWorld({ proofs: 0 });
		for (const id of ["900000201", "#900000201", " 900000201 ", "# 900000201"]) spelled.rowFor(id, ADDRESS);
		eq(loadsTo(spelled.db, ADDRESS), 1, "§2 one load counts once, in any spelling of its ID");
		spelled.rowFor("900000202", ADDRESS);
		spelled.rowFor("900000202", ADDRESS);
		eq(loadsTo(spelled.db, ADDRESS), 2, "§2 a second row on a load adds nothing, a second load adds one");
		spelled.rowFor("LD-MIXED", ADDRESS);
		spelled.rowFor("ld-mixed", ADDRESS);
		eq(loadsTo(spelled.db, ADDRESS), 3, "§2 ...in any case of its ID");
		const stored = makeWorld({ proofs: 0 });
		stored.rowFor("LD-A", ADDRESS.toUpperCase());
		stored.rowFor("LD-B", `  ${ADDRESS} `);
		stored.rowFor("LD-C", "Made-Up.Billing@ChRobinson.com");
		eq(loadsTo(stored.db, ADDRESS), 3, "§2 rows stored in any case, with spaces around them, count as that address");
		stored.rowFor("", ADDRESS);
		stored.rowFor(" # ", ADDRESS);
		eq(loadsTo(stored.db, ADDRESS), 3, "§2 a row with no load is no load");
		for (const near of [`x${ADDRESS}`, `${ADDRESS}.example.test`, `made-up.billing@sub.${DOMAIN}`, "made-up.billing@example.test"]) {
			const n = makeWorld({ proofs: 0 });
			n.proof(near, 4);
			eq(loadsTo(n.db, ADDRESS), 0, `§2 rows to ${near} prove nothing about ${ADDRESS}`);
		}
		eq(loadsTo(new Database(":memory:"), ADDRESS), 0, "§2 no table: none");
	}

	// ===================================================================== §3
	section("§3 the rule on its own");
	{
		const row = { source: "documents" };
		const known = () => 3;
		const base = { to: ADDRESS, checkOn: true, primary: row, loadId: ID, rateConNumber: ID, rateConText: () => `Load confirmation ${ID}`, loadsToAddress: known };
		eq(refusalOf(base), null, "§3 a known address, a rate-con row: nothing stops it");
		for (const [loads, want] of [[0, "RECIPIENT_NOT_KNOWN"], [1, "RECIPIENT_NOT_KNOWN"], [2, "RECIPIENT_NOT_KNOWN"], [3, null], [4, null], [NaN, "RECIPIENT_NOT_KNOWN"], [undefined, "RECIPIENT_NOT_KNOWN"]]) {
			eq(refusalOf({ ...base, loadsToAddress: () => loads }), want, `§3 ${loads} loads: ${want || "passes"}`);
		}
		eq(refusalOf({ ...base, loadsToAddress: null }), "RECIPIENT_NOT_KNOWN", "§3 no count to ask: not known");
		eq(refusalOf({ ...base, checkOn: false }), "RECIPIENT_CHECK_OFF", "§3 the check off: a person, a known address included");
		eq(refusalOf({ ...base, checkOn: undefined }), null, "§3 not told otherwise: the check is on");
		for (const bad of [null, 0, "true", "false", 1]) eq(refusalOf({ ...base, checkOn: bad }), "RECIPIENT_CHECK_OFF", `§3 checkOn ${JSON.stringify(bad)}: only true passes, so anything else is a person`);
		eq(refusalOf({ to: ADDRESS }), "RATECON_NAME_MISMATCH", "§3 told nothing about the rate con: a person");
		eq(refusalOf({ ...base, to: ADDRESS.toUpperCase() }), null, "§3 the domain in capitals: the same check");
		eq(refusalOf({ ...base, to: `made-up.billing@billing.${DOMAIN}`, loadsToAddress: () => 0 }), "RECIPIENT_NOT_KNOWN", "§3 a subdomain is held to the same check");
		eq(refusalOf({ ...base, to: ADDRESS, loadsToAddress: () => 0, checkOn: true }), "RECIPIENT_NOT_KNOWN", "§3 the count is the one asked of this address");
		for (const to of ["billing@example-broker.test", `billing@not${DOMAIN}`, `billing@${DOMAIN}.example.test`, "", null, "not an address"]) {
			eq(refusalOf({ to, checkOn: false, primary: null, loadId: ID, loadsToAddress: () => 0 }), null, `§3 ${JSON.stringify(to)} isn't this check's, whatever the flag`);
		}
		for (const [name, want] of [
			[`Subject: Rate Confirmation ${ID}.pdf`, null], [`${ID}.pdf`, null], [`#${ID}`, null], [`Load ${ID} Rate Con`, null], [`${ID}-ratecon`, null], [`Re: Fwd: ${ID}`, null],
			[`Subject: Rate Confirmation ${ID}02.pdf`, "RATECON_NAME_MISMATCH"], [`Subject: Rate Confirmation 7${ID}.pdf`, "RATECON_NAME_MISMATCH"], [`${ID}-2.pdf`, "RATECON_NAME_MISMATCH"], [`2-${ID}.pdf`, "RATECON_NAME_MISMATCH"],
			[`${ID}.1.pdf`, "RATECON_NAME_MISMATCH"], [`${ID}_2.pdf`, "RATECON_NAME_MISMATCH"], [`LD${ID}.pdf`, "RATECON_NAME_MISMATCH"], [`${ID}A.pdf`, "RATECON_NAME_MISMATCH"], ["", "RATECON_NAME_MISMATCH"], [undefined, "RATECON_NAME_MISMATCH"], [null, "RATECON_NAME_MISMATCH"],
		]) {
			eq(refusalOf({ ...base, primary: { source: "drive", driveFileName: name } }), want, `§3 a Drive file named ${JSON.stringify(name)}: ${want || "passes"}`);
		}
		eq(refusalOf({ ...base, loadId: `#${ID}`, primary: { source: "drive", driveFileName: `${ID}.pdf` } }), null, "§3 the load spelled with a #: the same number");
		eq(refusalOf({ ...base, loadId: "", primary: { source: "drive", driveFileName: `${ID}.pdf` } }), "RATECON_NAME_MISMATCH", "§3 no load number: no match");
		for (const source of ["upload", "drive-content", "documents-bol", "", undefined, "made-up"]) {
			eq(refusalOf({ ...base, primary: { source, driveFileName: `${ID}.pdf` } }), "RATECON_NAME_MISMATCH", `§3 a primary from ${JSON.stringify(source)} can't stand behind a send`);
		}
		eq(refusalOf({ ...base, primary: null }), "RATECON_NAME_MISMATCH", "§3 no primary: a person");
		eq(refusalOf({ ...base, primary: { source: "drive", driveFileName: `${ID}02.pdf` }, loadsToAddress: () => 0 }), "RATECON_NAME_MISMATCH", "§3 failing both: the name's sentence first");
		eq(refusalOf({ ...base, checkOn: false, primary: null, loadsToAddress: () => 0 }), "RECIPIENT_CHECK_OFF", "§3 the check off comes before everything");

		// The free check, with the check off: a load nobody bills by email stays what it was.
		const open = { live: true, completed: true, brokerDomain: DOMAIN, brokerDomainConfirmed: true, closedMonths: [], hasDeliveryDate: true, pods: 1, recipientCheckOff: true };
		eq(rules.freeVerdict(open), { state: "needs_attention", code: "RECIPIENT_CHECK_OFF" }, "§3 the check off: the free check holds a C.H. Robinson load");
		for (const [label, over, want] of [
			["factored", { factored: true }, { state: "skipped", code: "LOAD_FACTORED" }],
			["drafted already", { drafts: 1 }, { state: "skipped", code: "ALREADY_DRAFTED" }],
			["opted out", { optedOut: true }, { state: "skipped", code: "BROKER_OPTED_OUT" }],
			["off Delivered", { completed: false }, { state: "waiting", code: "NOT_COMPLETED" }],
			["cancelled", { live: false }, { state: "waiting", code: "LOAD_DROPPED" }],
		]) {
			eq(rules.freeVerdict({ ...open, ...over }), want, `§3 the check off, ${label}: it stays what it was`);
		}
		eq(rules.freeVerdict({ ...open, recipientCheckOff: false }), { state: "queued", code: "" }, "§3 the check on: the free check lets it on to the rule");
		const facts = (knownAddressOn, email) => rules.loadFacts({ row: { "Load ID": ID, Email: email }, cols: rules.jobColumns(["Load ID", "Email"]), knownAddressOn }).recipientCheckOff;
		eq([facts(false, AGENT), facts(true, AGENT), facts(undefined, AGENT), facts(false, "ops@example-broker.test"), facts(false, "")], [true, false, false, false, false], "§3 only the check switched off, and only on this broker's loads, holds a load; a reader that doesn't say is unchanged");
	}

	// ===================================================================== §4
	section("§4 an address that passes: one send, to that address");
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready(ID);
		await deliver(w, job, ID);
		eq(w.state(ID), SENT, "§4 three loads a person invoiced at the address: the load goes");
		eq(w.smtp.map((m) => m.to), [ADDRESS], "§4 one SMTP call, to the rate con's address");
		eq([w.smtp[0] && w.smtp[0].subject, namesOf(w.smtp[0])[0], namesOf(w.smtp[0]).slice(-1)[0]], [`C.H. Robinson Order #${ID}`, `C.H. Robinson Invoice Order #${ID}.pdf`, `${ID}.pdf`], "§4 the invoice first, the rate con last, as the engine builds them");
		eq([w.appends.length, w.draftRow(ID), w.claim(ID).delivery, w.claim(ID).look_first], [0, [{ recipient: ADDRESS, via: "auto-smtp" }], "send", ""], "§4 no draft; one row, the job's send");
		eq(w.calls.look.length, 0, "§4 a driver's first tap asks for no look");

		for (const [label, setup, rc] of [
			["exactly 3 loads, by the n8n fallback", (x) => x.proof(ADDRESS, 3, "n8n"), {}],
			["Gmail and n8n together", (x) => { x.proof(ADDRESS, 2); x.proof(ADDRESS, 1, "n8n"); }, {}],
			["more than 3", (x) => x.proof(ADDRESS, 9), {}],
			["rows stored in capitals", (x) => x.proof(ADDRESS.toUpperCase(), 3), {}],
			["the read's address in another case", (x) => x.proof(ADDRESS, 3), { printed: "", read: "Made-Up.Billing@ChRobinson.com", address: "Made-Up.Billing@ChRobinson.com" }],
			["named only by the paid read", (x) => x.proof(ADDRESS, 3), { printed: "" }],
			["a rate-con row, whatever its name", (x) => x.proof(ADDRESS, 3), { source: "documents" }],
			["a Drive name with the number among other words", (x) => x.proof(ADDRESS, 3), { driveFileName: `Re: Fwd: Load ${ID} - AMES IA 50010 - Rate Con.pdf` }],
		]) {
			const x = makeWorld({ proofs: 0 });
			setup(x);
			const j = await x.started();
			x.ready(ID, {}, rc);
			await deliver(x, j, ID, `§4 ${label}`);
			eq([x.state(ID), x.smtp.length, x.appends.length], [SENT, 1, 0], `§4 ${label}: one send`);
			eq(String(x.smtp[0] && x.smtp[0].to).toLowerCase(), ADDRESS, `§4 ${label}: to that address`);
		}

		// The address on an alternate file, the primary this load's: known is known.
		const alt = makeWorld();
		const aj = await alt.started();
		alt.ready(ID, {}, { printed: "", read: null });
		const second = alt.rateCon(ID, { source: "drive", driveFileName: `Re: ${ID}.pdf`, printed: ADDRESS });
		alt.scans.set(second.buffer, ADDRESS);
		await deliver(alt, aj, ID, "§4 alternate");
		eq([alt.state(ID), alt.smtp.map((m) => m.to)], [SENT, [ADDRESS]], "§4 a known address off an alternate file: one send");
	}

	// ===================================================================== §5
	section("§5 an address that doesn't pass: a person, nothing sent, no number, no fallback");
	{
		const refused = async (label, setup, { over = {}, rc = {}, world = {} } = {}) => {
			const w = makeWorld({ proofs: 0, ...world });
			if (setup) setup(w);
			const job = await w.started();
			w.ready(ID, over, rc);
			await deliver(w, job, ID, `§5 ${label}`);
			eq([w.state(ID), paidNothing(w), w.draftRow(ID)], [NOT_KNOWN, NOTHING, []], `§5 ${label}: Needs attention, nothing sent, no draft, no number`);
			return { w, job };
		};
		await refused("no row names the address");
		await refused("rows for 2 loads", (w) => w.proof(ADDRESS, 2));
		await refused("three rows on one load", (w) => { for (let i = 0; i < 3; i++) w.rowFor("LD-ONE", ADDRESS); });
		await refused("one load in three spellings", (w) => { for (const id of ["900000201", "#900000201", " 900000201 "]) w.rowFor(id, ADDRESS); });
		await refused("the job's own sends only", (w) => w.proof(ADDRESS, 5, "auto-smtp"));
		await refused("the job's own drafts only", (w) => w.proof(ADDRESS, 5, "auto-imap"));
		await refused("2 loads by a person and the job's rows besides", (w) => { w.proof(ADDRESS, 2); w.proof(ADDRESS, 5, "auto-smtp"); w.proof(ADDRESS, 5, "auto-imap"); });
		await refused("rows with a blank via", (w) => w.proof(ADDRESS, 5, ""));
		await refused("rows with a via nothing writes", (w) => w.proof(ADDRESS, 5, "made-up"));
		await refused("rows to another address on the domain", (w) => w.proof(OTHER, 5));
		await refused("rows to a longer address holding this one", (w) => w.proof(`x${ADDRESS}`, 5));
		await refused("the sheet's Email is the known one, and the read names another", (w) => w.proof(AGENT, 5));
		await refused("the sheet's Email is the known one, and only the paid read names another", (w) => w.proof(AGENT, 5), { rc: { printed: "", read: OTHER, address: OTHER } });

		// The job's own send earns nothing: a load sent adds no proof for the next.
		const earned = makeWorld();
		const ej = await earned.started();
		earned.ready(ID);
		await deliver(earned, ej, ID, "§5 earned");
		eq(loadsTo(earned.db, ADDRESS), 3, "§5 a send of the job's own adds nothing to the count");

		// Off the default inbox and off a fallback, whatever else is going on.
		const none = makeWorld();
		none.proof(DEFAULT_INBOX, 5);
		const nj = await none.started();
		none.ready(ID, {}, { printed: "", read: null });
		await deliver(none, nj, ID, "§5 no address");
		eq([none.state(ID), paidNothing(none)], [["needs_attention", "NO_BILLING_EMAIL"], NOTHING], "§5 a rate con with no address: a person, never the default inbox, however well known it is");
		const defaulted = makeWorld();
		defaulted.proof(DEFAULT_INBOX, 5);
		const dj = await defaulted.started();
		defaulted.ready(ID, {}, { printed: "", read: DEFAULT_INBOX, address: DEFAULT_INBOX });
		await deliver(defaulted, dj, ID, "§5 the default inbox named");
		eq([defaulted.state(ID), paidNothing(defaulted)], [["needs_attention", "RECIPIENT_DOMAIN_MISMATCH"], NOTHING], "§5 a read that names the default inbox: a person, nothing sent");

		const stopped = await (async () => {
			const w = makeWorld({ proofs: 0 });
			ledger.ensureSchema(w.db);
			ledger.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(T0) });
			const job = await w.started();
			w.ready(ID);
			await deliver(w, job, ID, "§5 the Stop");
			return w;
		})();
		eq([stopped.state(ID), paidNothing(stopped)], [NOT_KNOWN, NOTHING], "§5 under the Stop: no Gmail draft to an address that doesn't pass");
		await refused("sending off", null, { world: { send: false } });
		await refused("the domain not on the send list", null, { world: { domains: [] } });

		// One that passes still goes the way it went: a draft, for a person to send.
		for (const [label, world, stop] of [["under the Stop", {}, true], ["sending off", { send: false }, false], ["not on the send list", { domains: [] }, false]]) {
			const w = makeWorld(world);
			ledger.ensureSchema(w.db);
			if (stop) ledger.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(T0) });
			const job = await w.started();
			w.ready(ID);
			await deliver(w, job, ID, `§5 ${label}`);
			eq([w.state(ID), w.smtp.length, w.appends.map((a) => a.to)], [SENT, 0, [ADDRESS]], `§5 ${label}, an address that passes: a Gmail draft, as before`);
		}

		// A subdomain, on the send list here only to show the check still holds it.
		const sub = `billing.${DOMAIN}`;
		const onSub = await refused("a subdomain's address no person has invoiced", null, {
			world: { domains: [sub], confirmed: [sub] }, over: { Email: `made-up.agent@${sub}` }, rc: { address: `made-up.billing@${sub}` },
		});
		eq(onSub.w.smtp.length, 0, "§5 ...a subdomain is held to the same check");

		// Rows gone between the read and the render: the last check before the send stops it.
		const late = makeWorld();
		const lj = await late.started();
		late.ready(ID);
		late.renderHook = () => { late.db.prepare("DELETE FROM load_invoice_drafts").run(); };
		await deliver(late, lj, ID, "§5 late");
		eq([late.state(ID), late.smtp.length, late.appends.length], [NOT_KNOWN, 0, 0], "§5 the rows gone by the render: the check after it stops the load, nothing sent or drafted");
		eq(late.notices.length, 1, "§5 ...and a person is told, as at any hold");

		// A count that can't be read sends nothing.
		const broken = makeWorld();
		const bj = await broken.started();
		broken.ready(ID);
		const real = ledger.invoiceLoadsTo;
		ledger.invoiceLoadsTo = () => { throw Object.assign(new Error("made-up: the database is locked"), { code: "SQLITE_BUSY" }); };
		await deliver(broken, bj, ID, "§5 broken");
		ledger.invoiceLoadsTo = real;
		eq([broken.state(ID)[0], paidNothing(broken)], ["needs_attention", NOTHING], "§5 a count that can't be read: a person, nothing sent, no number");

		// Try again: the same answer until a person has invoiced the address, then one send.
		const { w, job } = await refused("before Try again", (x) => x.proof(ADDRESS, 2));
		eq(retryOf(w, job, ID), "send", "§5 the confirm says Try again can send");
		eq((await tryAgain(job, ID)).status, 200, "§5 Try again");
		await settled(w, "§5 Try again");
		eq([w.state(ID), paidNothing(w), w.calls.look.length], [NOT_KNOWN, NOTHING, 0], "§5 Try again: the same answer, and the check spends no look");
		ok(w.claim(ID).look_first, "§5 ...the look stays asked for");
		w.proof(ADDRESS, 1);
		eq((await tryAgain(job, ID)).status, 200, "§5 Try again once a person has invoiced a third load");
		await settled(w, "§5 Try again, known");
		eq([w.state(ID), w.smtp.map((m) => m.to), w.calls.look.length, w.claim(ID).look_first], [SENT, [ADDRESS], 1, ""], "§5 one look, one send");

		// What reaches the logs and the notices.
		const quiet = await refused("the logs", null, { rc: { printed: "", read: OTHER, address: OTHER } });
		ok(!/@/.test(JSON.stringify(quiet.w.logs)) && !/@/.test(JSON.stringify(quiet.w.notices)), "§5 no log line or notice names an address");
	}

	// ===================================================================== §6
	section("§6 a Drive rate con whose name doesn't carry the load's whole number");
	{
		for (const [label, name] of [
			["a longer number", `Subject: Rate Confirmation ${ID}02.pdf`],
			["a number before it", `Subject: Rate Confirmation 7${ID}.pdf`],
			["a suffix", `Subject: Rate Confirmation ${ID}-2.pdf`],
			["a prefix", `Subject: Rate Confirmation 2-${ID}.pdf`],
			["a dotted suffix", `Subject: Rate Confirmation ${ID}.1.pdf`],
			["an underscored suffix", `Subject: Rate Confirmation ${ID}_2.pdf`],
			["letters on it", `Subject: Rate Confirmation LD${ID}.pdf`],
			["no name at all", ""],
		]) {
			const w = makeWorld();
			const job = await w.started();
			w.ready(ID, {}, { driveFileName: name });
			await deliver(w, job, ID, `§6 ${label}`);
			eq([w.state(ID), paidNothing(w), w.draftRow(ID)], [NAME, NOTHING, []], `§6 ${label}: Needs attention, nothing sent, no draft, no number, the address known`);
		}
		const both = makeWorld({ proofs: 0 });
		const bj = await both.started();
		both.ready(ID, {}, { driveFileName: `${ID}02.pdf` });
		await deliver(both, bj, ID, "§6 both");
		eq([both.state(ID), paidNothing(both)], [NAME, NOTHING], "§6 failing both: the name's sentence, nothing sent");
		const spelled = makeWorld();
		const sj = await spelled.started();
		spelled.ready(`#${ID}`, {}, { driveFileName: `Load ${ID}.pdf` });
		await deliver(spelled, sj, `#${ID}`, "§6 a # on the sheet");
		eq([spelled.state(`#${ID}`), spelled.smtp.map((m) => m.to)], [SENT, [ADDRESS]], "§6 a load spelled with a # on the sheet: the same number, one send");
		const content = makeWorld();
		const cj = await content.started();
		content.ready(ID, {}, { source: "drive-content" });
		await deliver(content, cj, ID, "§6 by content");
		eq([content.state(ID), paidNothing(content)], [["needs_attention", "RATECON_BY_CONTENT"], NOTHING], "§6 found by reading Drive: a person, as before");
		const bol = makeWorld();
		const bolj = await bol.started();
		bol.ready(ID, {}, { source: "documents-bol" });
		await deliver(bol, bolj, ID, "§6 a BOL");
		eq([bol.state(ID), paidNothing(bol)], [["needs_attention", "RATECON_MISSING"], NOTHING], "§6 only a BOL on file: a person, as before");
		const missing = makeWorld();
		const mj = await missing.started();
		missing.ready(ID, {}, null);
		await deliver(missing, mj, ID, "§6 no rate con");
		eq([missing.state(ID), paidNothing(missing)], [["needs_attention", "RATECON_MISSING"], NOTHING], "§6 no rate con on file: a person, as before");
		// The engine names a source no automatic path uses: refused all the same.
		const upload = makeWorld();
		const uj = await upload.started();
		upload.ready(ID, {}, { source: "upload" });
		await deliver(upload, uj, ID, "§6 an upload");
		eq([upload.state(ID), paidNothing(upload)], [NAME, NOTHING], "§6 a primary from a source that can't stand behind a send: a person");
		// A file named for a longer number, its address known and its total equal.
		const longer = makeWorld();
		const lj = await longer.started();
		longer.ready("900000015", {}, { driveFileName: "Subject: Rate Confirmation 90000001502.pdf" });
		await deliver(longer, lj, "900000015", "§6 a longer number");
		eq([longer.state("900000015"), paidNothing(longer)], [NAME, NOTHING], "§6 a file for a longer number: a person, nothing sent");
	}

	// ===================================================================== §7
	section("§7 a claim that runs with no fresh decision looks first, and a first tap doesn't");
	{
		const first = makeWorld();
		const fj = await first.started();
		first.ready(ID);
		first.lookFails = true;
		await deliver(first, fj, ID, "§7 first tap");
		eq([first.state(ID), first.smtp.length, first.calls.look.length, first.calls.payments], [SENT, 1, 0, 0], "§7 a driver's first tap: no look, one send");
		const armedFirst = makeWorld();
		const afj = await armedFirst.started();
		armedFirst.ready(ID);
		afj.driverDelivered({ role: "Driver", loadId: ID, oldStatus: "At Receiver", newStatus: "Delivered", readBack: async () => "Delivered" });
		eq(armedFirst.claim(ID).look_first, "", "§7 ...its record asks for none");

		// A stale tap on a stopped claim, its row already Delivered.
		const reArmed = async (setup = null) => {
			const w = makeWorld();
			const job = await w.started();
			w.ready(ID, { "Job Status": "Delivered" });
			w.seed(ID, { state: "waiting", code: "NOT_COMPLETED" });
			if (setup) setup(w);
			return { w, job };
		};
		let s = await reArmed((w) => { w.lookAnswer = HIT; });
		await deliver(s.w, s.job, ID, "§7 re-armed, a hit");
		eq([s.w.state(ID), paidNothing(s.w), s.w.calls.look.length], [["needs_attention", "MAILBOX_HIT"], NOTHING, 1], "§7 a stale tap re-arms the claim, the mailbox holds an invoice: nothing sent, no number");
		s = await reArmed((w) => { w.lookFails = true; });
		await deliver(s.w, s.job, ID, "§7 re-armed, a failed look");
		eq([s.w.state(ID), paidNothing(s.w), Boolean(s.w.claim(ID).look_first)], [["needs_attention", "MAILBOX_UNREAD"], NOTHING, true], "§7 ...the look fails: MAILBOX_UNREAD, nothing sent, no number, the look still asked for");
		s.w.lookFails = false;
		eq((await tryAgain(s.job, ID)).status, 200, "§7 ...a person's Try again");
		await settled(s.w, "§7 after a failed look");
		eq([s.w.state(ID), s.w.smtp.length], [SENT, 1], "§7 ...looks again, and sends once it reads clean");
		s = await reArmed((w) => { w.paymentsFail = true; });
		await deliver(s.w, s.job, ID, "§7 re-armed, Payments");
		eq([s.w.state(ID), paidNothing(s.w)], [["needs_attention", "PAYMENTS_UNREAD"], NOTHING], "§7 ...the Payments Table can't be read: nothing sent, no number");
		s = await reArmed((w) => { w.payments.push([ID, "Example", "1000", "", "", "Paid"]); });
		await deliver(s.w, s.job, ID, "§7 re-armed, filled");
		eq([s.w.state(ID), s.w.smtp.length], [["needs_attention", "PAYMENTS_TABLE_HIT"], 0], "§7 ...a filled Payments Table row: nothing sent");
		s = await reArmed();
		await deliver(s.w, s.job, ID, "§7 re-armed, clean");
		eq([s.w.state(ID), s.w.smtp.map((m) => m.to), s.w.calls.look.length, s.w.claim(ID).look_first], [SENT, [ADDRESS], 1, ""], "§7 ...all clean: one look, one send, the look cleared");
		// The claim itself asks, so a restart between the tap and the run can't lose the look.
		s = await reArmed((w) => { w.lookAnswer = HIT; });
		s.job.driverDelivered({ role: "Driver", loadId: ID, oldStatus: "Delivered", newStatus: "Delivered", readBack: async () => "Delivered" });
		ok(s.w.claim(ID).look_first, "§7 the re-armed claim itself asks for the look");
		eq(s.w.state(ID), ["waiting", "DRIVER_PENDING"], "§7 ...its write not yet answered");
		const next = s.w.job();
		next.startTrigger();
		await next.finishStartUp();
		await settled(s.w, "§7 re-armed, then a restart");
		eq([s.w.state(ID), s.w.smtp.length], [["needs_attention", "MAILBOX_HIT"], 0], "§7 ...across a restart: the look still runs first");

		// Each claim a restart queues again, or finds caught building.
		const atRestart = async (fields, setup = null) => {
			const w = makeWorld();
			await w.started();
			w.ready(ID, { "Job Status": "Delivered" });
			w.seed(ID, fields);
			if (setup) setup(w);
			const j = w.job();
			j.startTrigger();
			await j.finishStartUp();
			await settled(w, "§7 the restart");
			return w;
		};
		const CAUGHT = { state: "working", lease_owner: "old-process", lease_until: iso(T0 + HOUR) };
		const HELD = { invoice_id: "10202026-77", invoice_date: "2026-10-20", reserved_at: iso(T0 - MIN), message_id: "<made-up-held.auto-invoice@example.com>" };
		for (const [label, fields] of [
			["a queued claim", { state: "queued" }],
			["a DRIVER_PENDING record", { state: "waiting", code: "DRIVER_PENDING" }],
			["a claim caught building", CAUGHT],
			["a claim caught building, its number held", { ...CAUGHT, ...HELD, stage: "reserved" }],
			["a draft in flight, absent from Gmail", { ...CAUGHT, ...HELD, stage: "appending", sent_json: JSON.stringify({ to: ADDRESS, subject: "Made-up", total: "$1,000.00" }) }],
		]) {
			const mints = (w) => [w.smtp.length, w.appends.length, w.calls.mint];
			let w = await atRestart(fields, (x) => { x.lookAnswer = HIT; });
			eq([w.state(ID), mints(w), w.calls.look.length], [["needs_attention", "MAILBOX_HIT"], NOTHING, 1], `§7 ${label} at a restart, the mailbox holds an invoice: nothing sent, no number`);
			w = await atRestart(fields, (x) => { x.lookFails = true; });
			eq([w.state(ID), mints(w), Boolean(w.claim(ID).look_first)], [["needs_attention", "MAILBOX_UNREAD"], NOTHING, true], `§7 ${label} at a restart, the look fails: MAILBOX_UNREAD, nothing sent, no number, the look still asked for`);
			w = await atRestart(fields, (x) => { x.paymentsFail = true; });
			eq([w.state(ID), mints(w)], [["needs_attention", "PAYMENTS_UNREAD"], NOTHING], `§7 ${label} at a restart, the Payments Table can't be read: nothing sent, no number`);
			w = await atRestart(fields, (x) => { x.payments.push([ID, "Example", "1000", "", "", "Paid"]); });
			eq([w.state(ID), w.smtp.length], [["needs_attention", "PAYMENTS_TABLE_HIT"], 0], `§7 ${label} at a restart, a filled Payments Table row: nothing sent`);
			w = await atRestart(fields);
			eq([w.state(ID), w.smtp.map((m) => m.to), w.appends.length, w.calls.look.length, w.claim(ID).look_first], [SENT, [ADDRESS], 0, 1, ""], `§7 ${label} at a restart, all clean: one look, one send, the look cleared`);
		}
		// The check holds across a restart too.
		const unknown = await atRestart({ state: "queued" }, (x) => { x.db.prepare("DELETE FROM load_invoice_drafts").run(); });
		eq([unknown.state(ID), paidNothing(unknown), unknown.calls.look.length], [NOT_KNOWN, NOTHING, 0], "§7 a queued claim at a restart whose address isn't known: a person, nothing sent, no look spent");

		// The sweep's own recovery stays as it was: the start-up look belongs to the driver's trigger.
		const swept = makeWorld({ env: { AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" } });
		const sweptJob = swept.job();
		await sweptJob.tick();
		swept.ready(ID, { "Job Status": "Delivered" });
		swept.seed(ID, { state: "working", lease_owner: "old-process", lease_until: iso(T0 - HOUR) });
		swept.now += 5 * MIN;
		await sweptJob.tick();
		eq([swept.state(ID), swept.smtp.length, swept.calls.look.length, swept.calls.payments, swept.claim(ID).look_first], [SENT, 1, 0, 0, ""], "§7 the sweep's recovery of a claim caught building: no look asked for, one send");
	}

	// ===================================================================== §8
	section("§8 the kill switch fails safe");
	{
		for (const v of ["false", "FALSE", "0", "no", "off", " OFF "]) {
			const w = makeWorld({ env: { AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: v } });
			const job = await w.started();
			w.ready(ID);
			await deliver(w, job, ID, `§8 ${v}`);
			eq([w.state(ID), paidNothing(w), w.draftRow(ID), w.calls.prepare.length, w.calls.gemini], [CHECK_OFF, NOTHING, [], 0, 0], `§8 the check off (${JSON.stringify(v)}), the address known: Needs attention, nothing sent or drafted, nothing read or paid for`);
		}
		for (const v of ["flase", "offf", "of", "disabled", "true", "", "1"]) {
			const known = makeWorld({ env: { AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: v } });
			const kj = await known.started();
			known.ready(ID);
			await deliver(known, kj, ID, `§8 ${v} known`);
			eq([known.state(ID), known.smtp.map((m) => m.to)], [SENT, [ADDRESS]], `§8 ${JSON.stringify(v)} leaves the check on: a known address goes`);
			const unknown = makeWorld({ env: { AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: v }, proofs: 0 });
			const uj = await unknown.started();
			unknown.ready(ID);
			await deliver(unknown, uj, ID, `§8 ${v} unknown`);
			eq([unknown.state(ID), paidNothing(unknown)], [NOT_KNOWN, NOTHING], `§8 ${JSON.stringify(v)} leaves the check on: an unknown one doesn't`);
		}
		const OFF = { AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: "false" };
		// However the load gets there, however the send list reads.
		for (const [label, world, stop] of [["the Stop set", {}, true], ["sending off", { send: false }, false], ["not on the send list", { domains: [] }, false]]) {
			const w = makeWorld({ env: OFF, ...world });
			ledger.ensureSchema(w.db);
			if (stop) ledger.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(T0) });
			const job = await w.started();
			w.ready(ID);
			await deliver(w, job, ID, `§8 ${label}`);
			eq([w.state(ID), paidNothing(w)], [CHECK_OFF, NOTHING], `§8 the check off, ${label}: Needs attention, no Gmail draft either`);
		}
		const held = makeWorld({ env: OFF });
		const hj = await held.started();
		held.ready(ID);
		await deliver(held, hj, ID, "§8 Try again");
		eq(retryOf(held, hj, ID), "none", "§8 no Try again on the row: a run could only stop here again");
		eq((await tryAgain(hj, ID)).status, 200, "§8 ...and the route, pressed anyway");
		await settled(held, "§8 Try again");
		eq([held.state(ID), paidNothing(held), held.calls.prepare.length], [CHECK_OFF, NOTHING, 0], "§8 ...stops at the same place, nothing sent, nothing read");
		// The switch back on: it needs a person's press, and the check runs.
		const on = held.job({ env: { ...held.env0, AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: "true" } });
		on.startTrigger();
		await on.finishStartUp();
		await settled(held, "§8 back on");
		eq([held.state(ID), paidNothing(held)], [CHECK_OFF, NOTHING], "§8 the check back on: a held load stays held until a person presses");
		eq(retryOf(held, on, ID), "send", "§8 ...and the confirm says Try again can send");
		eq((await tryAgain(on, ID)).status, 200, "§8 ...Try again");
		await settled(held, "§8 back on, Try again");
		eq([held.state(ID), held.smtp.map((m) => m.to), held.calls.look.length], [SENT, [ADDRESS], 1], "§8 ...one look, one send");
		// A claim a restart queues again, with the check off.
		const queued = makeWorld({ env: OFF });
		await queued.started();
		queued.ready(ID, { "Job Status": "Delivered" });
		queued.seed(ID, { state: "queued" });
		const qj = queued.job();
		qj.startTrigger();
		await qj.finishStartUp();
		await settled(queued, "§8 queued");
		eq([queued.state(ID), paidNothing(queued), queued.calls.look.length], [CHECK_OFF, NOTHING, 0], "§8 a queued claim at a restart with the check off: Needs attention, nothing sent");
		// The sweep and shadow mode read the same switch.
		const sweep = makeWorld({ env: { ...OFF, AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" } });
		const sj = sweep.job();
		await sj.tick();
		sweep.ready(ID, { "Job Status": "Delivered" });
		sweep.now += 5 * MIN;
		await sj.tick();
		eq([sweep.state(ID), paidNothing(sweep), sweep.calls.prepare.length], [CHECK_OFF, NOTHING, 0], "§8 the sweep, the check off: Needs attention, nothing sent or drafted");
		const shadow = makeWorld({ env: { ...OFF, AUTO_INVOICE_DRAFTS_SHADOW: "" } });
		const shj = shadow.job();
		eq(shj.mode, "shadow", "§8 shadow");
		await shj.tick();
		shadow.ready(ID, { "Job Status": "Delivered" });
		shadow.now += 5 * MIN;
		await shj.tick();
		const sh = ledger.getShadow(shadow.db, rules.loadKey(ID));
		eq([sh.verdict, sh.reason_code, shadow.calls.prepare.length], ["WOULD_NEED_ATTENTION", "RECIPIENT_CHECK_OFF", 0], "§8 shadow records the same, with no engine call");
		// With the check off the row's confirm stays right for what has already gone.
		const searching = makeWorld({ env: OFF });
		const sj2 = await searching.started();
		searching.ready(ID, { "Job Status": "Delivered" });
		searching.seed(ID, { state: "needs_attention", code: "MAYBE_SENT", stage: "appending", delivery: "send" });
		eq(retryOf(searching, sj2, ID), "search", "§8 a send that may have gone: Try again still searches");
		// A subdomain is covered too, before anything is read.
		const sub = `billing.${DOMAIN}`;
		const onSub = makeWorld({ env: OFF, domains: [sub], confirmed: [sub] });
		const osj = await onSub.started();
		onSub.ready(ID, { Email: `made-up.agent@${sub}` }, { address: `made-up.billing@${sub}` });
		await deliver(onSub, osj, ID, "§8 a subdomain");
		eq([onSub.state(ID), paidNothing(onSub), onSub.calls.prepare.length], [CHECK_OFF, NOTHING, 0], "§8 the check off, a subdomain's load: Needs attention, nothing read or paid for");
	}

	// ===================================================================== §9
	section("§9 other brokers, and a person's press");
	{
		const BROKER_DOMAIN = "example-broker.test";
		const OPS = `ops@${BROKER_DOMAIN}`;
		const BILLING = `billing@${BROKER_DOMAIN}`;
		for (const [label, env] of [["the check on", {}], ["the check off", { AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: "false" }]]) {
			const w = makeWorld({ env, proofs: 0, confirmed: [DOMAIN, BROKER_DOMAIN] });
			const job = await w.started();
			w.ready(ID, { Email: OPS }, { address: BILLING });
			await deliver(w, job, ID, `§9 ${label}`);
			eq([w.state(ID), w.smtp.length, w.appends.map((a) => a.to), w.draftRow(ID).map((r) => r.via)], [SENT, 0, [BILLING], ["auto-imap"]], `§9 ${label}: another broker's draft is unchanged, with no rows behind its address`);
			// On a list that names it (only a test's): the check is C.H. Robinson's alone.
			const listed = makeWorld({ env, proofs: 0, domains: [BROKER_DOMAIN], confirmed: [BROKER_DOMAIN] });
			const lj = await listed.started();
			listed.ready(ID, { Email: OPS }, { address: BILLING, driveFileName: `${ID}02.pdf` });
			await deliver(listed, lj, ID, `§9 ${label}, listed`);
			eq([listed.state(ID), listed.smtp.map((m) => m.to)], [SENT, [BILLING]], `§9 ${label}: another listed broker's send is unchanged`);
			// Bison: its own inbox.
			const bison = makeWorld({ env, proofs: 0 });
			const bj = await bison.started();
			bison.ready(ID, { Email: "ops@bisontransport.com" }, { address: "" , read: null, printed: "" });
			bison.answers.forEach((a) => { a["Order Number"] = "7001234"; a["PO Number"] = "12345"; });
			await deliver(bison, bj, ID, `§9 ${label}, Bison`);
			eq([bison.state(ID), bison.smtp.length, bison.appends.map((a) => a.to)], [SENT, 0, [process.env.BISON_INVOICE_EMAIL]], `§9 ${label}: a Bison load's draft is unchanged`);
			// What Try again offers on another broker's held load.
			const heldOther = makeWorld({ env, proofs: 0, confirmed: [DOMAIN, BROKER_DOMAIN] });
			const hj = await heldOther.started();
			heldOther.ready(ID, { Email: OPS, "Job Status": "Delivered" }, { address: BILLING });
			heldOther.seed(ID, { state: "needs_attention", code: "TOTAL_MISMATCH" });
			eq(retryOf(heldOther, hj, ID), "draft", `§9 ${label}: Try again on another broker's held load still makes a draft`);
			// An Email cell with no address in it stays as it is: a person, with no engine call.
			for (const cell of ["", "see rate con"]) {
				const blank = makeWorld({ env });
				const blj = await blank.started();
				blank.ready(ID, { Email: cell });
				await deliver(blank, blj, ID, `§9 ${label}, a cell reading ${JSON.stringify(cell)}`);
				eq([blank.state(ID), paidNothing(blank), blank.calls.prepare.length], [["needs_attention", "NO_BROKER_EMAIL"], NOTHING, 0], `§9 ${label}: an Email cell reading ${JSON.stringify(cell)} stays NO_BROKER_EMAIL, the rate con's address known or not`);
			}
		}

		// A person's press: refused only when the job already sent; the engine in manual mode is as it was.
		const w = makeWorld({ proofs: 0, env: { AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: "false" } });
		const job = await w.started();
		w.ready(ID, { "Job Status": "Delivered" }, { printed: "", read: OTHER, address: OTHER, driveFileName: `${ID}02.pdf` });
		w.seed(ID, { state: "needs_attention", code: "RECIPIENT_CHECK_OFF" });
		eq(job.draftButtonCheck({ session: { user: { username: "made-up-admin" } }, body: {} }, ID), { ok: true }, "§9 a person's Draft Invoice on a held load: not refused");
		const prep = await w.engine.prepare({ loadId: ID, body: {}, dryRun: true, mode: "manual", ov: w.helpers.parseInvoiceOverrides({}) });
		eq([prep.ok, prep.ctx && prep.ctx.invoiceTo.email], [true, OTHER], "§9 ...the engine in manual mode answers as it did, whatever the address or the file's name");
		// That press's row closes the claim, and counts.
		w.rowFor(ID, OTHER);
		await job.checkClaims(rules.loadKey(ID));
		eq(w.state(ID), ["skipped", "DRAFTED_BY_HAND"], "§9 ...and the row it writes closes the claim");
		eq(loadsTo(w.db, OTHER), 1, "§9 ...and counts toward that address");
		ok(!/knownAddress|invoiceLoadsTo|RECIPIENT_NOT_KNOWN/.test(fs.readFileSync(path.join(ROOT, "lib", "broker-invoice-draft.js"), "utf8")), "§9 the Draft Invoice engine has no part in the check");
	}

	// ===================================================================== §10
	section("§10 it can't send twice");
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready(ID);
		await deliver(w, job, ID, "§10 first");
		eq(w.smtp.length, 1, "§10 one send");
		tap(w, job, ID);
		await settled(w, "§10 repeat tap");
		eq(w.smtp.length, 1, "§10 a repeat tap: nothing more");
		const next = w.job();
		next.startTrigger();
		await next.finishStartUp();
		await settled(w, "§10 restart");
		eq(w.smtp.length, 1, "§10 a restart: nothing more");
		eq((await tryAgain(next, ID)).status, 409, "§10 Try again on a load sent: refused");
		eq(pressed(next), [false, 409, "INVOICE_ALREADY_SENT"], "§10 a person's Draft Invoice: refused, as for any load the job sent");
		eq(ledger.getSendStop(w.db), null, "§10 ...and nothing stopped sending");

		// A row that wasn't written: Try again records it, never a second send.
		const lost = makeWorld();
		const lj = await lost.started();
		lost.ready(ID);
		lost.recordThrowsOnce = true;
		await deliver(lost, lj, ID, "§10 lost row");
		eq([lost.state(ID), lost.smtp.length, lost.draftRow(ID).length], [["needs_attention", "IN_GMAIL_UNRECORDED"], 1, 0], "§10 sent, its row not written: a person, one SMTP call");
		eq((await tryAgain(lj, ID)).status, 200, "§10 Try again");
		await settled(lost, "§10 recording");
		eq([lost.state(ID), lost.smtp.length, lost.draftRow(ID).map((r) => r.via), lost.calls.look.length], [SENT, 1, ["auto-smtp"], 0], "§10 ...rebuilt and recorded: still one SMTP call");

		// The record of what went doesn't depend on the check.
		for (const [label, change] of [
			["the rows gone since", (x) => x.db.prepare("DELETE FROM load_invoice_drafts").run()],
			["the check off since", null],
		]) {
			const x = makeWorld();
			const a = await x.started();
			x.ready(ID);
			x.recordThrowsOnce = true;
			await deliver(x, a, ID, `§10 ${label}`);
			if (change) change(x);
			const b = change ? a : x.job({ env: { ...x.env0, AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: "false" } });
			if (!change) {
				b.startTrigger();
				await b.finishStartUp();
			}
			eq((await tryAgain(b, ID)).status, 200, `§10 ${label}: Try again`);
			await settled(x, `§10 ${label}: recording`);
			eq([x.state(ID), x.smtp.length, x.appends.length, x.draftRow(ID).map((r) => r.via)], [SENT, 1, 0, ["auto-smtp"]], `§10 ${label}: what already went is recorded, still one SMTP call`);
			eq(pressed(b), [false, 409, "INVOICE_ALREADY_SENT"], `§10 ${label}: a person's Draft Invoice stays refused`);
		}

		// A restart with the send in flight. The stand-in never answers, so the old process stays
		// inside its SMTP call and only the new one moves the claim.
		const inFlight = (x, { sent = false } = {}) => (o) => {
			x.smtp.push(o);
			if (sent) x.sent.push(o.messageId);
			return new Promise(() => {});
		};
		const restartMidSend = async (x, env = null) => {
			await until(() => x.smtp.length === 1, "§10 the send started");
			const atCrash = x.claim(ID);
			const b = env ? x.job({ env }) : x.job();
			b.startTrigger();
			await b.finishStartUp();
			await settled(x, "§10 the restart");
			return { b, atCrash };
		};
		{
			const x = makeWorld();
			const a = await x.started({ sendMail: inFlight(x, { sent: true }) });
			x.ready(ID);
			tap(x, a, ID);
			const { b, atCrash } = await restartMidSend(x);
			eq([atCrash.state, atCrash.stage, atCrash.delivery], ["working", "appending", "send"], "§10 the send started, and the app restarts with it in flight");
			eq([x.state(ID), x.smtp.length, x.appends.length, x.draftRow(ID).map((r) => r.via), x.calls.mint], [SENT, 1, 0, ["auto-smtp"], 1], "§10 the Sent copy is found: recorded, one SMTP call, one number");
			eq(pressed(b), [false, 409, "INVOICE_ALREADY_SENT"], "§10 ...a person's Draft Invoice: refused");
		}
		{
			const x = makeWorld();
			const a = await x.started({ sendMail: inFlight(x) });
			x.ready(ID);
			tap(x, a, ID);
			const { b } = await restartMidSend(x);
			eq([x.state(ID), x.smtp.length, Boolean(ledger.getSendStop(x.db))], [["needs_attention", "MAYBE_SENT"], 1, true], "§10 no Sent copy: MAYBE_SENT and the stop, one SMTP call");
			eq((await tryAgain(b, ID)).status, 200, "§10 ...a person's Try again is taken");
			await settled(x, "§10 Try again on a send that started");
			eq([x.state(ID), x.smtp.length, x.appends.length, x.calls.look.length, pressed(b)], [["needs_attention", "MAYBE_SENT"], 1, 0, 0, [false, 409, "INVOICE_ALREADY_SENT"]], "§10 ...it only searches again: still one SMTP call, no draft, the button refused");
		}
		// The kill switch set in the restart that catches the send: searched and recorded, never a second one.
		{
			const x = makeWorld();
			const a = await x.started({ sendMail: inFlight(x, { sent: true }) });
			x.ready(ID);
			tap(x, a, ID);
			const { b } = await restartMidSend(x, { ...x.env0, AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: "false" });
			eq([x.state(ID), x.smtp.length, x.appends.length, x.draftRow(ID).map((r) => r.via), pressed(b)], [SENT, 1, 0, ["auto-smtp"], [false, 409, "INVOICE_ALREADY_SENT"]], "§10 the check off in that restart: the Sent copy is recorded, still one SMTP call");
		}
		{
			const x = makeWorld();
			const a = await x.started({ sendMail: inFlight(x) });
			x.ready(ID);
			tap(x, a, ID);
			const { b } = await restartMidSend(x, { ...x.env0, AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: "false" });
			eq([x.state(ID), x.smtp.length, x.appends.length, pressed(b)], [["needs_attention", "MAYBE_SENT"], 1, 0, [false, 409, "INVOICE_ALREADY_SENT"]], "§10 ...no Sent copy: MAYBE_SENT, still one SMTP call, no draft");
		}
		// Two taps at once: one run, one send, whichever wins.
		{
			const x = makeWorld();
			const j = await x.started();
			x.ready(ID);
			const one = j.driverDelivered({ role: "Driver", loadId: ID, oldStatus: "At Receiver", newStatus: "Delivered", readBack: async () => "Delivered" });
			const two = j.driverDelivered({ role: "Driver", loadId: ID, oldStatus: "At Receiver", newStatus: "Delivered", readBack: async () => "Delivered" });
			x.setRow(ID, { "Job Status": "Delivered" });
			one.written();
			two.written();
			await settled(x, "§10 two taps");
			eq([x.state(ID), x.smtp.length, x.draftRow(ID).length], [SENT, 1, 1], "§10 two taps at once: one send, one row");
		}
	}

	// ===================================================================== §11
	section("§11 deploying sends nothing and moves nothing already held");
	{
		for (const [label, env] of [["the check on", {}], ["the check off", { AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: "false" }]]) {
			const w = makeWorld({ env, proofs: 0 });
			await w.started();
			const HELD_CODES = ["NO_BROKER_EMAIL", "TOTAL_MISMATCH", "MAILBOX_HIT", "MAILBOX_UNREAD", "RECIPIENT_NOT_KNOWN", "RATECON_NAME_MISMATCH", "RATECON_NUMBER_MISMATCH", "RECIPIENT_CHECK_OFF",
				"BROKER_DOMAIN_UNCONFIRMED", "NO_BILLING_EMAIL", "RECIPIENT_DOMAIN_MISMATCH", "RATECON_MISSING", "RATECON_BY_CONTENT", "RATECON_TOTAL_UNREAD", "OFF_GAP", "MAYBE_SENT"];
			const ids = [];
			HELD_CODES.forEach((code, i) => {
				const id = `9000002${String(i).padStart(2, "0")}`;
				ids.push(id);
				w.ready(id, { "Job Status": "Delivered" });
				w.seed(id, { state: "needs_attention", code, ...(code === "MAYBE_SENT" ? { stage: "appending", delivery: "send", invoice_id: "10202026-5", message_id: "<made-up-5@example.com>" } : {}) });
			});
			// One the job already sent, whose address no longer passes.
			const sentId = "900000301";
			w.ready(sentId, { "Job Status": "Delivered" });
			w.seed(sentId, { state: "drafted", delivery: "send", stage: "recorded", invoice_id: "10202026-9", sent_at: iso(T0 - HOUR), drafted_at: iso(T0 - HOUR), message_id: "<made-up-9@example.com>" });
			const sentFacts = w.job();
			await sentFacts.checkClaims();
			w.db.prepare("UPDATE auto_invoice_claims SET fingerprint_json = ? WHERE load_key = ?").run(JSON.stringify({
				completed: true, live: true, paymentCents: 100000, brokerEmail: AGENT, trailer: "TR1",
				podIds: w.db.prepare("SELECT id FROM documents WHERE load_id = ? AND type = 'POD' ORDER BY id").all(sentId).map((r) => r.id),
				rateConIds: [],
			}), rules.loadKey(sentId));
			w.rowFor(sentId, ADDRESS, "auto-smtp");
			w.db.prepare("UPDATE load_invoice_drafts SET invoice_id = '10202026-9' WHERE load_id = ?").run(sentId);
			const draftId = "900000302";
			w.ready(draftId, { "Job Status": "Delivered" });
			w.seed(draftId, { state: "drafted", stage: "recorded", invoice_id: "10202026-10", drafted_at: iso(T0 - HOUR) });
			const baseId = "900000303";
			w.ready(baseId, { "Job Status": "Delivered" });
			w.seed(baseId, { state: "baseline" });
			const skipId = "900000304";
			w.ready(skipId, { "Job Status": "Delivered" });
			w.seed(skipId, { state: "skipped", code: "DRAFTED_BY_HAND" });
			const noClaim = "900000305";
			w.ready(noClaim, { "Job Status": "Delivered" });
			const waitingId = "900000306";
			w.ready(waitingId, { "Job Status": "At Receiver" });
			w.seed(waitingId, { state: "waiting", code: "NOT_COMPLETED" });
			const snap = () => w.db.prepare("SELECT load_key, state, reason_code, stage, delivery, invoice_id, look_first, changed_fields FROM auto_invoice_claims ORDER BY load_key").all();
			const before = snap();
			const columns = () => w.db.prepare("PRAGMA table_info(auto_invoice_claims)").all().map((c) => c.name);
			const colsBefore = columns();
			const prepares = w.calls.prepare.length;
			const deployed = w.job();
			deployed.startTrigger();
			await deployed.finishStartUp();
			await settled(w, `§11 ${label}`);
			eq(snap(), before, `§11 ${label}: every claim stays as it was: held stays held, sent stays sent, drafted stays drafted`);
			eq([paidNothing(w), w.calls.prepare.length - prepares, w.calls.look.length, w.calls.payments], [NOTHING, 0, 0, 0], `§11 ${label}: nothing built, numbered, looked for or sent`);
			eq(w.claim(noClaim), null, `§11 ${label}: a completed load with no claim gets none`);
			eq(columns(), colsBefore, `§11 ${label}: a restart adds no column`);
			eq(((await settingsOf(deployed)).recipientCheck || { held: { count: 0 } }).held.count, 0, `§11 ${label}: what was already held isn't counted as this check's hold`);
			await deployed.checkClaims();
			eq(w.claim(sentId).state, "drafted", `§11 ${label}: a claim already sent stays sent after the claims are watched`);
			eq([w.claim(sentId).changed_fields, ledger.getSendStop(w.db)], ["", null], `§11 ${label}: no change is read on it, and sending isn't stopped`);
			eq(pressed(deployed, sentId), [false, 409, "INVOICE_ALREADY_SENT"], `§11 ${label}: a person's Draft Invoice on it stays refused`);
			eq([w.notices, w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'auto_invoice_recipient_held'").get().n], [[], 0], `§11 ${label}: nothing already held raises a notice or an audit row at the deploy`);
			eq(Object.keys(ledger.getMeta(w.db)).filter((k) => k.startsWith("held_notice")), [], `§11 ${label}: no meta row is written at the deploy`);
		}
		eq(Object.keys(rules.fingerprint(rules.loadFacts({ row: { "Load ID": ID, Email: AGENT }, cols: rules.jobColumns(["Load ID", "Email"]), knownAddressOn: false }))), ["completed", "live", "paymentCents", "brokerEmail", "trailer", "podIds", "rateConIds"], "§11 a sent claim's fingerprint reads no new field, so no load reads as changed");
		// A table from before the deploy gets the one column the settings' count reads, empty, on every
		// claim: no claim moves, and what it already holds isn't counted.
		const old = makeWorld();
		ledger.ensureSchema(old.db);
		old.ready(ID, { "Job Status": "Delivered" });
		old.seed(ID, { state: "needs_attention", code: "NO_BILLING_EMAIL" });
		const heldColumn = () => old.db.prepare("PRAGMA table_info(auto_invoice_claims)").all().filter((c) => c.name === "check_held_at");
		if (heldColumn().length) old.db.exec("ALTER TABLE auto_invoice_claims DROP COLUMN check_held_at");
		const oldBefore = old.db.prepare("SELECT state, reason_code, updated_at FROM auto_invoice_claims").all();
		const oldJob = old.job();
		eq(heldColumn().map((c) => [c.type, c.notnull, c.dflt_value]), [["TEXT", 1, "''"]], "§11 a table from before the deploy gets the column, empty");
		eq(old.db.prepare("SELECT state, reason_code, updated_at FROM auto_invoice_claims").all(), oldBefore, "§11 ...and no claim moves");
		eq("recipientCheck" in (await settingsOf(oldJob)), false, "§11 ...and what it holds isn't counted");
		eq([old.notices, paidNothing(old)], [[], NOTHING], "§11 ...and nothing is told or sent");
	}

	// ===================================================================== §12
	section("§12 the rate con must say it's this load's");
	{
		const B = "900001502";
		const heldAtNumber = async (label, rc, { id = ID, over = {}, world = {} } = {}) => {
			const w = makeWorld(world);
			const job = await w.started();
			w.ready(id, over, rc);
			await deliver(w, job, id, `§12 ${label}`);
			eq([w.state(id), paidNothing(w), w.draftRow(id)], [NUMBER, NOTHING, []], `§12 ${label}: Needs attention, nothing sent, no draft, no number used, the address known and the total equal`);
			return { w, job };
		};
		// Another load's rate con whose file name carries this load's number whole.
		for (const [label, driveFileName] of [
			["a space between the two numbers in its name", `Subject: Rate Confirmation ${B} ${ID}.pdf`],
			["a slash between them", `Subject: Rate Confirmation ${B}/${ID}.pdf`],
			["this load's number as a PO in its name", `Subject: Rate Confirmation ${B} PO ${ID}.pdf`],
		]) {
			await heldAtNumber(`another load's rate con, ${label}`, { driveFileName, number: B, note: B });
		}
		// What the read gives.
		for (const [label, rc] of [
			["the read gives another number, the text printing both", { number: B, note: `${B} ${ID}` }],
			["the read gives another number, the text printing this one", { number: B }],
			["the read gives no number", { number: null }],
			["the read answers None", { number: "None" }],
			["the read gives a blank", { number: "  " }],
			["the read gives a suffix on the number", { number: `${ID}-2` }],
			["the read gives a second number beside it", { number: `${ID} / ${B}` }],
			["the read gives a longer number", { number: `${ID}02` }],
			["the read gives letters on it", { number: `LD${ID}` }],
			["the read's Order Number answers None, its Load Number has a suffix", { orderNumber: "None", number: `${ID}-2` }],
			// An Order Number is never taken in the Load Number's place, whichever number it gives.
			["the read's Order Number is this number, its Load Number another", { orderNumber: ID, number: B, note: `${B} ${ID}` }],
			["the read's Order Number is this number, its Load Number blank", { orderNumber: ID, number: null }],
			["the read's Order Number is this number, its Load Number None", { orderNumber: ID, number: "None" }],
		]) {
			await heldAtNumber(label, rc);
		}
		// What the text prints: a reader miss holds.
		for (const [label, note] of [
			["the text prints another number", B],
			["the text prints no number", "with nothing to read"],
			["the text prints it inside a longer one", `${ID}02`],
			["the text prints a number before it", `7${ID}`],
			["the text prints it with a suffix", `${ID}-2`],
		]) {
			await heldAtNumber(`the read gives this number, ${label}`, { note });
		}
		// A file with no text layer: the paid read gives the number, and the reader sees none.
		const scanned = makeWorld();
		const sjob = await scanned.started();
		scanned.setRow(ID);
		scanned.addPod(ID);
		const scan = Buffer.from("%PDF-1.4 a made-up page with no text layer");
		scanned.answers.set(scan.toString("base64"), { "Total Rate": "$1,000.00", Rate: null, "Load Number": ID, "Order Number": null, "PO Number": null, "Documents Email": ADDRESS });
		scanned.candidates.set(rules.loadKey(ID), [{ buffer: scan, source: "drive", label: "drive", fileName: "rc.pdf", driveFileName: `${ID}.pdf` }]);
		await deliver(scanned, sjob, ID, "§12 no text layer");
		eq([scanned.state(ID), paidNothing(scanned)], [NUMBER, NOTHING], "§12 a rate con with no text layer: a reader miss holds, nothing sent");
		// A job given no reader holds too, and one that throws sends nothing.
		const noReader = makeWorld();
		const withReader = noReader.deps;
		noReader.deps = (extra) => {
			const { rateConTextOf: _reader, ...rest } = withReader(extra);
			return rest;
		};
		const nrj = await noReader.started();
		noReader.ready(ID);
		await deliver(noReader, nrj, ID, "§12 no reader");
		eq([noReader.state(ID), paidNothing(noReader)], [NUMBER, NOTHING], "§12 a job given no reader: a person, nothing sent, no number");
		const thrower = makeWorld();
		const tj = await thrower.started({ rateConTextOf: () => { throw new Error("made-up: the reader failed"); } });
		thrower.ready(ID);
		await deliver(thrower, tj, ID, "§12 a reader that throws");
		eq([thrower.state(ID), paidNothing(thrower)], [["needs_attention", "DRAFT_FAILED"], NOTHING], "§12 a reader that throws: a person, nothing sent, no number");
		// A rate-con row is read the same way.
		await heldAtNumber("a rate-con row whose read gives another number", { source: "documents", number: B, note: B });
		await heldAtNumber("a rate-con row whose read gives none", { source: "documents", number: null });
		// Failing more than one: its own line, nothing sent. The name's comes first, then this one.
		await heldAtNumber("another number on an address no person has invoiced", { number: B }, { world: { proofs: 0 } });
		const both = makeWorld();
		const bothJob = await both.started();
		both.ready(ID, {}, { driveFileName: `${ID}02.pdf`, number: B });
		await deliver(both, bothJob, ID, "§12 a name and a number");
		eq([both.state(ID), paidNothing(both)], [NAME, NOTHING], "§12 failing the name and the number: the name's line, nothing sent");

		// What passes.
		for (const [label, id, rc] of [
			["the read and the text give this number", ID, {}],
			["the text prints another number beside it", ID, { note: `${ID} and ${B}` }],
			["the number after a # in the text", ID, { note: `#${ID}` }],
			["the read gives it after a #", ID, { number: `#${ID}` }],
			["the read gives it after a # and a space", ID, { number: `# ${ID}` }],
			["the read's Order Number answers None, its Load Number this number", ID, { orderNumber: "None" }],
			["the read gives it with spaces around it", ID, { number: `  ${ID}  ` }],
			["a load spelled with a # on the sheet", `#${ID}`, { number: ID, note: ID, driveFileName: `Load ${ID}.pdf` }],
			["a rate-con row, its read and its text giving this number", ID, { source: "documents" }],
			["letters in the number, in another case on the read", "LD-TEST-1401", { number: "ld-test-1401", note: "LD-TEST-1401", driveFileName: "Subject: Rate Confirmation LD-TEST-1401.pdf" }],
			// The Load Number is what's compared, whatever an Order Number beside it says.
			["the read's Order Number is another, its Load Number this one", ID, { orderNumber: B }],
			["the read's Order Number has a suffix, its Load Number doesn't", ID, { orderNumber: `${ID}-2` }],
			["the read's Order Number and Load Number are both this one", ID, { orderNumber: ID }],
		]) {
			const w = makeWorld();
			const job = await w.started();
			w.ready(id, {}, rc);
			await deliver(w, job, id, `§12 ${label}`);
			eq([w.state(id), w.smtp.map((m) => m.to), w.appends.length], [SENT, [ADDRESS], 0], `§12 ${label}: one send`);
		}
		// A billing block the free scan reads whole has no paid read, so no Load Number: its Order #
		// isn't taken in its place, whichever number it gives.
		const blockPdf = (order) => pdfWith(`BT (Billing Information: Order #: ${order} PO #: 1234567 Move #: 5501) Tj (Total Rate: $1,000.00) Tj (Email the signed POD and all billing documents to ${ADDRESS}) Tj ET`);
		const onBlock = async (order) => {
			const w = makeWorld();
			const job = await w.started();
			w.setRow(ID);
			w.addPod(ID);
			w.candidates.set(rules.loadKey(ID), [{ buffer: blockPdf(order), source: "drive", label: "drive", fileName: "rc.pdf", driveFileName: `${ID}.pdf` }]);
			await deliver(w, job, ID, `§12 a block with Order # ${order}`);
			return w;
		};
		const blockSame = await onBlock(ID);
		eq([blockSame.state(ID), paidNothing(blockSame), blockSame.calls.gemini], [NUMBER, NOTHING, 0], "§12 a billing block's Order # is this number, with no paid read: Needs attention, nothing sent");
		const blockOther = await onBlock(B);
		eq([blockOther.state(ID), paidNothing(blockOther), blockOther.calls.gemini], [NUMBER, NOTHING, 0], "§12 a billing block's Order # is another: the same");

		// Only the primary's read counts: the address can come off an alternate, which the automatic
		// path reads with the free scan only.
		const withAlternate = async (primaryNumber, alternateNumber) => {
			const x = makeWorld();
			const xj = await x.started();
			x.setRow(ID);
			x.addPod(ID);
			x.rateCon(ID, { number: primaryNumber, read: null, printed: "", note: `${B} ${ID}`, driveFileName: `Rate Confirmation ${ID}.pdf` });
			const alternate = x.rateCon(ID, { number: alternateNumber, note: `${B} ${ID}`, driveFileName: `Re Rate Confirmation ${ID}.pdf` });
			x.scans.set(alternate.buffer, ADDRESS);
			await deliver(x, xj, ID, `§12 a primary's ${primaryNumber}, an alternate's ${alternateNumber}`);
			return x;
		};
		const altThis = await withAlternate(B, ID);
		eq([altThis.state(ID), paidNothing(altThis), altThis.calls.gemini], [NUMBER, NOTHING, 1], "§12 the primary's read gives another number, an alternate's this one: held, and the alternate isn't paid for");
		const primThis = await withAlternate(ID, B);
		eq([primThis.state(ID), primThis.smtp.map((m) => m.to), primThis.calls.gemini], [SENT, [ADDRESS], 1], "§12 the primary's read gives this number, an alternate's another: one send");

		// Other brokers, and Bison, aren't read for it.
		const BROKER_DOMAIN = "example-broker.test";
		const other = makeWorld({ proofs: 0, confirmed: [DOMAIN, BROKER_DOMAIN] });
		const oj = await other.started();
		other.ready(ID, { Email: `ops@${BROKER_DOMAIN}` }, { address: `billing@${BROKER_DOMAIN}`, number: B, note: B });
		await deliver(other, oj, ID, "§12 another broker");
		eq([other.state(ID), other.smtp.length, other.appends.map((a) => a.to)], [SENT, 0, [`billing@${BROKER_DOMAIN}`]], "§12 another broker's draft is unchanged, whatever its rate con's number");
		const bison = makeWorld({ proofs: 0 });
		const bj = await bison.started();
		bison.ready(ID, { Email: "ops@bisontransport.com" }, { address: "", read: null, printed: "", orderNumber: "7001234", number: B, note: B });
		bison.answers.forEach((a) => { a["PO Number"] = "12345"; });
		await deliver(bison, bj, ID, "§12 Bison");
		eq([bison.state(ID), bison.appends.map((a) => a.to)], [SENT, [process.env.BISON_INVOICE_EMAIL]], "§12 a Bison load's draft is unchanged: its Order # is its own");

		// Try again reads it again; a person's press is untouched.
		const { w, job } = await heldAtNumber("before Try again", { number: B });
		eq(retryOf(w, job, ID), "send", "§12 the confirm says Try again can send");
		eq((await tryAgain(job, ID)).status, 200, "§12 Try again");
		await settled(w, "§12 Try again");
		eq([w.state(ID), paidNothing(w), w.calls.look.length], [NUMBER, NOTHING, 0], "§12 Try again on the same read: the same line, and no look spent");
		w.answers.forEach((a) => { a["Load Number"] = ID; });
		eq((await tryAgain(job, ID)).status, 200, "§12 Try again once the read gives this number");
		await settled(w, "§12 Try again, the number read");
		eq([w.state(ID), w.smtp.map((m) => m.to), w.calls.look.length], [SENT, [ADDRESS], 1], "§12 one look, one send");
		const press = await heldAtNumber("before a press", { number: B });
		eq(press.job.draftButtonCheck({ session: { user: { username: "made-up-admin" } }, body: {} }, ID), { ok: true }, "§12 a person's Draft Invoice on a held load isn't refused");
		const manual = await press.w.engine.prepare({ loadId: ID, body: {}, dryRun: true, mode: "manual", ov: press.w.helpers.parseInvoiceOverrides({}) });
		eq([manual.ok, manual.ctx && manual.ctx.invoiceTo.email, manual.ctx && manual.ctx.rcFields.orderNumber], [true, ADDRESS, B], "§12 ...and the engine in manual mode answers as it did, whatever the number");
		eq(manual.ctx && manual.ctx.paidRead, null, "§12 ...and keeps no answer for the job: a press reads as it did");
		const auto = await press.w.engine.prepare({ loadId: ID, body: {}, dryRun: false, mode: "auto" });
		eq(auto.ctx && auto.ctx.paidRead && auto.ctx.paidRead["Load Number"], B, "§12 in mode auto the engine keeps the paid read's own answer");
		// The Load Number as the read gave it, and nothing in its place.
		const asRead = (answer) => (typeof rules.loadNumberRead === "function" ? rules.loadNumberRead(answer) : "NO_SUCH_RULE");
		for (const [label, answer, want] of [
			["the Load Number", { "Load Number": ID }, ID],
			["a suffix stays on", { "Load Number": `${ID}-2` }, `${ID}-2`],
			["a second number stays on", { "Load Number": `${ID} / ${B}` }, `${ID} / ${B}`],
			["an Order Number beside it changes nothing", { "Order Number": B, "Load Number": ID }, ID],
			["an Order Number isn't taken in its place", { "Order Number": ID }, ""],
			["nor beside a blank one", { "Order Number": ID, "Load Number": "  " }, ""],
			["nor beside no answer", { "Order Number": ID, "Load Number": null }, ""],
			["nor an Order # field", { "Order #": ID }, ""],
			["nor a PO or a move number", { "PO Number": ID, "Move Number": ID }, ""],
			["a not-found answer is what it says", { "Load Number": "None" }, "None"],
			["spaces come off", { "Load Number": `  ${ID}  ` }, ID],
			["a # comes off", { "Load Number": `#${ID}` }, ID],
			["a # and a space come off", { "Load Number": `# ${ID}` }, ID],
			["a number given as a number", { "Load Number": 900000101 }, ID],
			["no paid read", null, ""],
			["no answer given", undefined, ""],
			["a thing that isn't an answer", "made-up", ""],
		]) {
			eq(asRead(answer), want, `§12 as read: ${label}`);
		}

		// What already went is recorded, whatever the read says now.
		const lost = makeWorld();
		const lj = await lost.started();
		lost.ready(ID);
		lost.recordThrowsOnce = true;
		await deliver(lost, lj, ID, "§12 a row not written");
		eq([lost.state(ID), lost.smtp.length], [["needs_attention", "IN_GMAIL_UNRECORDED"], 1], "§12 sent, its row not written: a person, one SMTP call");
		lost.answers.forEach((a) => { a["Load Number"] = B; });
		eq((await tryAgain(lj, ID)).status, 200, "§12 Try again");
		await settled(lost, "§12 recording");
		eq([lost.state(ID), lost.smtp.length, lost.appends.length, lost.draftRow(ID).map((r) => r.via)], [SENT, 1, 0, ["auto-smtp"]], "§12 ...the read now giving another number: what already went is recorded, still one SMTP call");

		// Across a restart, and on the sweep.
		const queued = makeWorld();
		await queued.started();
		queued.ready(ID, { "Job Status": "Delivered" }, { number: B });
		queued.seed(ID, { state: "queued" });
		const qj = queued.job();
		qj.startTrigger();
		await qj.finishStartUp();
		await settled(queued, "§12 a restart");
		eq([queued.state(ID), paidNothing(queued), queued.calls.look.length], [NUMBER, NOTHING, 0], "§12 a claim queued at a restart: the same line, nothing sent, no look spent");
		const sweep = makeWorld({ env: { AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" } });
		const sj = sweep.job();
		await sj.tick();
		sweep.ready(ID, { "Job Status": "Delivered" }, { number: B });
		sweep.now += 5 * MIN;
		await sj.tick();
		eq([sweep.state(ID), paidNothing(sweep)], [NUMBER, NOTHING], "§12 the sweep: the same line, nothing sent");

		// The rule on its own.
		const named = { to: ADDRESS, checkOn: true, primary: { source: "drive", driveFileName: `${ID}.pdf` }, loadId: ID, loadsToAddress: () => 3 };
		const text = `Load confirmation ${ID}`;
		eq(refusalOf({ ...named, rateConNumber: ID, rateConText: () => text }), null, "§12 rule: this number, read and printed: nothing stops it");
		for (const [label, over, want] of [
			["no number given", { rateConNumber: undefined, rateConText: () => text }, "RATECON_NUMBER_MISMATCH"],
			["another number", { rateConNumber: B, rateConText: () => text }, "RATECON_NUMBER_MISMATCH"],
			["no text given", { rateConNumber: ID, rateConText: undefined }, "RATECON_NUMBER_MISMATCH"],
			["text that doesn't print it", { rateConNumber: ID, rateConText: () => `Load confirmation ${B}` }, "RATECON_NUMBER_MISMATCH"],
			["a number that isn't this load's, on a known address", { rateConNumber: `${ID}-2`, rateConText: () => text }, "RATECON_NUMBER_MISMATCH"],
			["no load number", { loadId: "", rateConNumber: "", rateConText: () => "" }, "RATECON_NAME_MISMATCH"],
		]) {
			eq(refusalOf({ ...named, ...over }), want, `§12 rule: ${label}: ${want}`);
		}
		let asked = 0;
		eq(refusalOf({ ...named, rateConNumber: B, rateConText: () => { asked++; return text; } }), "RATECON_NUMBER_MISMATCH", "§12 rule: a number that fails");
		eq(asked, 0, "§12 ...reads no text");
		eq(refusalOf({ ...named, to: "billing@example-broker.test", rateConNumber: B, rateConText: () => "" }), null, "§12 rule: another broker's domain isn't this check's");
		eq(refusalOf({ ...named, rateConNumber: ID, rateConText: () => text, loadsToAddress: () => 0 }), "RECIPIENT_NOT_KNOWN", "§12 rule: the number passing, the count still asked");
	}

	// ===================================================================== §13
	section("§13 a hold tells a person");
	{
		const heldRows = (w) => w.db.prepare("SELECT username, entity_id, details FROM audit_trail WHERE action = 'auto_invoice_recipient_held' ORDER BY id").all();
		const heldLogs = (w) => w.logs.filter((l) => /held, nothing sent/.test(l));
		const noSecrets = (w, label) => {
			const told = JSON.stringify([w.notices, heldLogs(w), heldRows(w)]);
			ok(!/@/.test(told), `§13 ${label}: no address in the notice, the log or the audit row`);
			ok(!/Made-up Driver|Made-up Agent/.test(told), `§13 ${label}: no driver's or contact's name there either`);
		};
		const ids = ["900000401", "900000402", "900000403", "900000404", "900000405"];

		// A run of holds.
		const w = makeWorld({ proofs: 0 });
		const job = await w.started();
		for (const id of ids) {
			w.ready(id);
			await deliver(w, job, id, `§13 ${id}`);
			eq(w.state(id), NOT_KNOWN, `§13 ${id}: held`);
		}
		eq(paidNothing(w), NOTHING, "§13 a run of holds: nothing sent");
		eq(w.notices.length, 1, "§13 a run of 5 holds: one notice");
		eq(w.notices[0] && w.notices[0].title, "Automatic invoice held", "§13 ...its title");
		eq(w.notices[0] && w.notices[0].body, `Load ${ids[0]} was held (RECIPIENT_NOT_KNOWN): its rate con's billing email isn't one a person has already used on invoices for 3 loads, so its invoice wasn't sent. If C.H. Robinson's billing address changed or its rate cons now read differently, every load will stop here. Check it on Completed Loads. More held for this reason today get no notice of their own: the automatic-draft settings count them.`, "§13 ...its words: the load's ID and the code, and what to do");
		eq(heldRows(w), ids.map((id) => ({ username: "auto-invoice", entity_id: id, details: "RECIPIENT_NOT_KNOWN: nothing sent" })), "§13 an audit row on each hold, as the system, the load's ID and the code");
		eq(heldLogs(w), ids.map((id) => `[auto-invoice] load ${id}: held, nothing sent: RECIPIENT_NOT_KNOWN`), "§13 a log line on each hold");
		noSecrets(w, "a run of holds");

		// A later day, a restart, another reason.
		w.now += 23 * HOUR;
		w.ready("900000406");
		await deliver(w, job, "900000406", "§13 23 hours on");
		eq(w.notices.length, 1, "§13 23 hours on: no second notice");
		const restarted = w.job();
		restarted.startTrigger();
		await restarted.finishStartUp();
		w.ready("900000407");
		await deliver(w, restarted, "900000407", "§13 after a restart");
		eq(w.notices.length, 1, "§13 after a restart: still no second notice");
		w.ready("900000408", {}, { driveFileName: "900000408-2.pdf" });
		await deliver(w, restarted, "900000408", "§13 another reason");
		eq(w.notices.length, 2, "§13 another reason the same day: its own notice");
		eq(w.notices[1] && w.notices[1].body, "Load 900000408 was held (RATECON_NAME_MISMATCH): its rate con's file name doesn't carry the load's whole number, so its invoice wasn't sent. If rate cons are now filed under other names, every load will stop here. Check it on Completed Loads. More held for this reason today get no notice of their own: the automatic-draft settings count them.", "§13 ...in its own words");
		w.ready("900000409", {}, { number: "900001502" });
		await deliver(w, restarted, "900000409", "§13 a third reason");
		eq(w.notices.length, 3, "§13 a third reason: its own notice");
		eq(w.notices[2] && w.notices[2].body, "Load 900000409 was held (RATECON_NUMBER_MISMATCH): its rate con doesn't give the load's number, or gives another one, so its invoice wasn't sent. If C.H. Robinson's rate cons now read differently, every load will stop here. Check it on Completed Loads. More held for this reason today get no notice of their own: the automatic-draft settings count them.", "§13 ...in its own words");
		w.now += 1 * HOUR;
		w.ready("900000410");
		await deliver(w, restarted, "900000410", "§13 a day on");
		eq(w.notices.length, 4, "§13 a day after the first: a new notice");
		eq((await tryAgain(restarted, "900000410")).status, 200, "§13 Try again on it");
		await settled(w, "§13 Try again");
		eq([w.state("900000410"), w.notices.length, heldRows(w).filter((r) => r.entity_id === "900000410").length], [NOT_KNOWN, 4, 2], "§13 ...held again: an audit row, and no second notice");
		noSecrets(w, "every reason");

		// What can stop every C.H. Robinson load as this check's own codes can: a read with no address
		// or none on its domain, a read with no total, files named so that no lookup finds them by
		// their number. Each tells, by reason, with what the settings count.
		const OTHER_DOMAIN = "example-other.test";
		const BROKER_DOMAIN = "example-broker.test";
		const SHARED = [
			["NO_BILLING_EMAIL", { printed: "", read: null }, "its rate con names no billing email, so its invoice wasn't sent. If C.H. Robinson's rate cons now read differently, every load will stop here. Check it on Completed Loads."],
			["RECIPIENT_DOMAIN_MISMATCH", { address: `billing@${OTHER_DOMAIN}` }, "its rate con's billing email isn't on the broker's own domain, so its invoice wasn't sent. If C.H. Robinson's billing address changed or its rate cons now read differently, every load will stop here. Check it on Completed Loads."],
			["RATECON_MISSING", null, "no rate con was found for it by its number, so its invoice wasn't sent. If rate cons are now filed under other names, every load will stop here. Check it on Completed Loads."],
			["RATECON_BY_CONTENT", { source: "drive-content" }, "its rate con was found only by reading Drive files, so its invoice wasn't sent. If rate cons are now filed under other names, every load will stop like this one. Check it on Completed Loads."],
			["RATECON_TOTAL_UNREAD", { total: null }, "its rate con's total couldn't be read, so its invoice wasn't sent. If the rate-con reader is down or C.H. Robinson's rate cons now read differently, every load will stop here. Check it on Completed Loads."],
		];
		for (const [code, rc, words] of SHARED) {
			const chr = makeWorld();
			const cj = await chr.started();
			for (const id of ["900000431", "900000432"]) {
				chr.ready(id, {}, rc);
				await deliver(chr, cj, id, `§13 ${code} ${id}`);
				eq([chr.state(id), paidNothing(chr)], [["needs_attention", code], NOTHING], `§13 ${code} on a C.H. Robinson load ${id}: held, nothing sent`);
			}
			eq(chr.notices.map((n) => [n.title, n.body]), [["Automatic invoice held", `Load 900000431 was held (${code}): ${words} More held for this reason today get no notice of their own: the automatic-draft settings count them.`]], `§13 ${code}: one notice for the two, in its own words`);
			eq(heldRows(chr).map((r) => [r.entity_id, r.details]), ["900000431", "900000432"].map((id) => [id, `${code}: nothing sent`]), `§13 ${code}: an audit row on each`);
			eq(heldLogs(chr).length, 2, `§13 ${code}: a log line on each`);
			noSecrets(chr, code);
			eq((await settingsOf(cj)).recipientCheck, { on: true, domain: DOMAIN, days: 7, held: { count: 2, byCode: { [code]: 2 } } }, `§13 ${code}: the settings count them, by reason`);
			chr.ready("900000433", {}, { driveFileName: "900000433-2.pdf" });
			await deliver(chr, cj, "900000433", `§13 ${code}, then another reason`);
			eq(chr.notices.length, 2, `§13 ${code}: another reason the same day has its own notice`);
			chr.now += 24 * HOUR;
			chr.ready("900000434", {}, rc);
			await deliver(chr, cj, "900000434", `§13 ${code}, a day on`);
			eq(chr.notices.length, 3, `§13 ${code}: a day on, its reason tells again`);

			// The same code on another broker's load, or on Bison's, isn't this check's to tell or count.
			const other = makeWorld({ proofs: 0, confirmed: [DOMAIN, BROKER_DOMAIN] });
			const oj = await other.started();
			other.ready("900000435", { Email: `ops@${BROKER_DOMAIN}` }, rc && { address: `billing@${BROKER_DOMAIN}`, ...rc });
			await deliver(other, oj, "900000435", `§13 ${code} on another broker`);
			eq(other.state("900000435"), ["needs_attention", code], `§13 ${code} on another broker's load: held, as it was`);
			eq([other.notices, heldRows(other), heldLogs(other)], [[], [], []], `§13 ${code} on another broker's load: nothing told`);
			eq("recipientCheck" in (await settingsOf(oj)), false, `§13 ${code} on another broker's load: not counted`);
		}
		// The domain off the confirmed list stops every such load before anything is read.
		const unlisted = makeWorld({ confirmed: [] });
		const uj = await unlisted.started();
		for (const id of ["900000441", "900000442"]) {
			unlisted.ready(id);
			await deliver(unlisted, uj, id, `§13 off the confirmed list ${id}`);
			eq([unlisted.state(id), paidNothing(unlisted)], [["needs_attention", "BROKER_DOMAIN_UNCONFIRMED"], NOTHING], `§13 off the confirmed list ${id}: held, nothing sent`);
		}
		eq(unlisted.notices.filter((n) => n.title === "Automatic invoice held").map((n) => n.body), ["Load 900000441 was held (BROKER_DOMAIN_UNCONFIRMED): its broker's domain isn't on the confirmed list in the automatic-draft settings, so its invoice wasn't sent. If C.H. Robinson's domain was taken off that list, every load will stop here. Check the automatic-draft settings. More held for this reason today get no notice of their own: the automatic-draft settings count them."], "§13 off the confirmed list: one notice for the two, in its own words");
		eq(heldRows(unlisted).map((r) => r.details), ["BROKER_DOMAIN_UNCONFIRMED: nothing sent", "BROKER_DOMAIN_UNCONFIRMED: nothing sent"], "§13 off the confirmed list: an audit row on each");
		eq(((await settingsOf(uj)).recipientCheck || { held: {} }).held.byCode, { BROKER_DOMAIN_UNCONFIRMED: 2 }, "§13 off the confirmed list: the settings count them");
		const unlistedOther = makeWorld({ proofs: 0, confirmed: [] });
		const uoj = await unlistedOther.started();
		unlistedOther.ready("900000443", { Email: `ops@${BROKER_DOMAIN}` });
		await deliver(unlistedOther, uoj, "900000443", "§13 another broker off the confirmed list");
		eq([unlistedOther.state("900000443"), unlistedOther.notices.filter((n) => n.title === "Automatic invoice held"), heldRows(unlistedOther), "recipientCheck" in (await settingsOf(uoj))], [["needs_attention", "BROKER_DOMAIN_UNCONFIRMED"], [], [], false], "§13 another broker off the confirmed list: its chip, as it was");

		// A subdomain is held to the same check, and tells the same.
		const sub = makeWorld({ confirmed: [`billing.${DOMAIN}`] });
		const subJob = await sub.started();
		sub.ready("900000436", { Email: `ops@billing.${DOMAIN}` }, null);
		await deliver(sub, subJob, "900000436", "§13 a subdomain");
		eq([sub.state("900000436"), sub.notices.length, heldRows(sub).length, ((await settingsOf(subJob)).recipientCheck || { held: {} }).held.count], [["needs_attention", "RATECON_MISSING"], 1, 1, 1], "§13 a load on a subdomain: told and counted");
		const bison = makeWorld({ proofs: 0 });
		const bisonJob = await bison.started();
		bison.ready("900000437", { Email: "ops@bisontransport.com" }, null);
		await deliver(bison, bisonJob, "900000437", "§13 Bison");
		eq([bison.state("900000437"), bison.notices, heldRows(bison), "recipientCheck" in (await settingsOf(bisonJob))], [["needs_attention", "RATECON_MISSING"], [], [], false], "§13 a Bison load with no rate con: its chip, as it was");

		// The sweep looks for a rate con again before a person is asked: it tells only then.
		const sweepy = makeWorld({ env: { AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" } });
		const swj = sweepy.job();
		await swj.tick();
		sweepy.ready("900000438", { "Job Status": "Delivered" }, null);
		sweepy.now += 5 * MIN;
		await swj.tick();
		eq([sweepy.state("900000438"), sweepy.notices.length, heldRows(sweepy).length], [["waiting", "RATECON_MISSING"], 0, 0], "§13 the sweep, no rate con yet: it looks again, and tells nothing");
		for (let i = 0; i < 6 && sweepy.state("900000438")[0] !== "needs_attention"; i++) {
			sweepy.now += 2 * HOUR + MIN;
			await swj.tick();
		}
		eq([sweepy.state("900000438"), sweepy.notices.length, heldRows(sweepy).length, ((await settingsOf(swj)).recipientCheck || { held: {} }).held.count], [["needs_attention", "RATECON_MISSING"], 1, 1, 1], "§13 the sweep, still none after its looks: a person, told and counted");

		// A load no longer C.H. Robinson's, stopped again on the same code, no longer counts.
		const moved = makeWorld({ confirmed: [DOMAIN, BROKER_DOMAIN] });
		const mvj = await moved.started();
		moved.ready("900000439", {}, { printed: "", read: null });
		await deliver(moved, mvj, "900000439", "§13 before the Email moved");
		eq(((await settingsOf(mvj)).recipientCheck || { held: {} }).held.count, 1, "§13 held on a C.H. Robinson Email: counted");
		moved.setRow("900000439", { Email: `ops@${BROKER_DOMAIN}` });
		eq((await tryAgain(mvj, "900000439")).status, 200, "§13 Try again on it, its Email now another broker's");
		await settled(moved, "§13 after the Email moved");
		eq([moved.state("900000439"), moved.notices.length, heldRows(moved).length, "recipientCheck" in (await settingsOf(mvj))], [["needs_attention", "NO_BILLING_EMAIL"], 1, 1, false], "§13 ...stopped again on the same code: nothing more told, and no longer counted");

		// The list, its words, and the rule: what the worlds above don't each reach.
		const holdCodes = rules.KNOWN_ADDRESS_HOLD_CODES || [];
		const noticeWords = rules.HELD_NOTICE_WORDS || {};
		eq(holdCodes, ["BROKER_DOMAIN_UNCONFIRMED", "NO_BILLING_EMAIL", "RECIPIENT_DOMAIN_MISMATCH", "RECIPIENT_NOT_KNOWN", "RATECON_MISSING", "RATECON_BY_CONTENT", "RATECON_NAME_MISMATCH", "RATECON_NUMBER_MISMATCH", "RATECON_TOTAL_UNREAD", "RECIPIENT_CHECK_OFF"], "§13 the codes that tell");
		eq(Object.keys(noticeWords).sort(), [...holdCodes].sort(), "§13 ...each with its words");
		ok(holdCodes.every((c) => rules.REASON_CODES.includes(c)), "§13 ...each a server code");
		ok(!/@/.test(Object.values(noticeWords).join(" ")), "§13 ...and no address in any of the words");
		for (const [code, domain, want] of [
			["NO_BILLING_EMAIL", DOMAIN, true],
			["RATECON_MISSING", `billing.${DOMAIN}`, true],
			["RECIPIENT_NOT_KNOWN", DOMAIN, true],
			["NO_BILLING_EMAIL", BROKER_DOMAIN, false],
			["NO_BILLING_EMAIL", `not${DOMAIN}`, false],
			["NO_BILLING_EMAIL", "", false],
			["NO_BILLING_EMAIL", undefined, false],
			["TOTAL_MISMATCH", DOMAIN, false],
			["TRAILER_MISMATCH", DOMAIN, false],
			["", DOMAIN, false],
		]) {
			eq(typeof rules.isKnownAddressHold === "function" ? rules.isKnownAddressHold(code, domain) : null, want, `§13 rule: ${code || "no code"} on ${domain}: ${want}`);
		}

		// What isn't this check's: the rate con was read, and a person's question is about this load.
		const none = makeWorld();
		const nj = await none.started();
		none.ready("900000411");
		await deliver(none, nj, "900000411", "§13 a send");
		none.ready("900000412", { "  Payment  ": "$9,000.00" });
		await deliver(none, nj, "900000412", "§13 a total that differs");
		eq([none.state("900000411"), none.state("900000412")], [SENT, ["needs_attention", "TOTAL_MISMATCH"]], "§13 a send, and a hold on the load's own total");
		eq([none.notices, heldRows(none), heldLogs(none), "recipientCheck" in (await settingsOf(nj))], [[], [], [], false], "§13 ...tell nothing and aren't counted: its line stands as it did");

		// The check off.
		const OFF = { AUTO_INVOICE_KNOWN_ADDRESS_ENABLED: "false" };
		const off = makeWorld({ env: OFF });
		const oj = await off.started();
		for (const id of ids.slice(0, 3)) {
			off.ready(id);
			await deliver(off, oj, id, `§13 off ${id}`);
		}
		eq([off.notices.length, off.notices[0] && off.notices[0].body], [1, `Load ${ids[0]} was held (RECIPIENT_CHECK_OFF): the billing email check is switched off on the server, so C.H. Robinson invoices aren't made or sent. Every such load stops here for a person to draft by hand. More held for this reason today get no notice of their own: the automatic-draft settings count them.`], "§13 the check off: one notice, in its own words");
		eq(heldRows(off).map((r) => r.details), ["RECIPIENT_CHECK_OFF: nothing sent", "RECIPIENT_CHECK_OFF: nothing sent", "RECIPIENT_CHECK_OFF: nothing sent"], "§13 ...an audit row on each");
		noSecrets(off, "the check off");

		// The sweep: a claim it finds new, and one it was holding.
		const sweep = makeWorld({ env: { ...OFF, AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" } });
		const sj = sweep.job();
		await sj.tick();
		sweep.ready("900000414", { "Job Status": "Delivered" });
		sweep.ready("900000415", { "Job Status": "Delivered" });
		sweep.seed("900000415", { state: "waiting", code: "WAITING_POD" });
		sweep.now += 5 * MIN;
		await sj.tick();
		eq([sweep.state("900000414"), sweep.state("900000415"), sweep.notices.length, heldRows(sweep).map((r) => r.entity_id).sort(), heldLogs(sweep).length], [CHECK_OFF, CHECK_OFF, 1, ["900000414", "900000415"], 2], "§13 the sweep, the check off: each load tells, one notice");
		await sj.tick();
		eq(heldRows(sweep).length, 2, "§13 ...and the next sweep tells nothing more");
		eq((await settingsOf(sj)).recipientCheck, { on: false, domain: DOMAIN, days: 7, held: { count: 2, byCode: { RECIPIENT_CHECK_OFF: 2 } } }, "§13 ...and the settings count both, the one it found new and the one it was holding");

		// Shadow mode only records.
		const shadow = makeWorld({ env: { ...OFF, AUTO_INVOICE_DRAFTS_SHADOW: "" } });
		const shj = shadow.job();
		await shj.tick();
		shadow.ready(ID, { "Job Status": "Delivered" });
		shadow.now += 5 * MIN;
		await shj.tick();
		eq([shadow.notices, heldRows(shadow), heldLogs(shadow)], [[], [], []], "§13 shadow: no notice, no audit row, no log line");
		const shadowOn = makeWorld({ env: { AUTO_INVOICE_DRAFTS_SHADOW: "" } });
		const shon = shadowOn.job();
		await shon.tick();
		shadowOn.ready(ID, { "Job Status": "Delivered" }, null);
		shadowOn.now += 5 * MIN;
		await shon.tick();
		eq([shadowOn.notices, heldRows(shadowOn), heldLogs(shadowOn)], [[], [], []], "§13 shadow, no rate con on the load: the same");

		// A notice or an audit row that fails leaves the hold as it is.
		for (const [label, extra, want] of [
			["the notice fails", { notify: () => { throw new Error("made-up"); } }, 1],
			["the audit row fails", { logAudit: () => { throw new Error("made-up"); } }, 0],
		]) {
			const x = makeWorld({ proofs: 0 });
			const xj = await x.started(extra);
			x.ready(ID);
			await deliver(x, xj, ID, `§13 ${label}`);
			eq([x.state(ID), paidNothing(x)], [NOT_KNOWN, NOTHING], `§13 ${label}: still held, nothing sent`);
			eq(heldRows(x).length, want, `§13 ${label}: the rest still goes`);
		}
		const noMeta = makeWorld({ proofs: 0 });
		const mj = await noMeta.started();
		noMeta.ready(ID);
		const realSet = ledger.setMeta;
		ledger.setMeta = (db, key, value) => {
			if (String(key).startsWith("held_notice")) throw Object.assign(new Error("made-up: the database is locked"), { code: "SQLITE_BUSY" });
			return realSet(db, key, value);
		};
		await deliver(noMeta, mj, ID, "§13 the mark can't be written");
		ledger.setMeta = realSet;
		eq([noMeta.state(ID), noMeta.notices.length, heldRows(noMeta).length], [NOT_KNOWN, 1, 1], "§13 the notice's mark can't be written: still held, and a person is still told");

		// What the settings read says.
		const read = makeWorld();
		const rj = await read.started();
		let body = await settingsOf(rj);
		eq(Object.keys(body), ["optOutDomains", "confirmedBrokerDomains", "unreadable", "dropped", "send"], "§13 the check on, nothing held: the settings read as before");
		ok(!("recipientCheck" in rj.status()), "§13 ...and the status");
		read.ready("900000421");
		await deliver(read, rj, "900000421", "§13 a send");
		eq("recipientCheck" in (await settingsOf(rj)), false, "§13 a send changes nothing there");
		read.db.prepare("DELETE FROM load_invoice_drafts WHERE load_id LIKE 'LD-PROOF-%'").run();
		for (const id of ["900000422", "900000423"]) {
			read.ready(id);
			await deliver(read, rj, id, `§13 ${id}`);
		}
		read.ready("900000424", {}, { number: "900001502" });
		await deliver(read, rj, "900000424", "§13 another reason");
		read.ready("900000425", { "  Payment  ": "$9,000.00" });
		await deliver(read, rj, "900000425", "§13 a total that differs");
		const heldNow = { on: true, domain: DOMAIN, days: 7, held: { count: 3, byCode: { RATECON_NUMBER_MISMATCH: 1, RECIPIENT_NOT_KNOWN: 2 } } };
		body = await settingsOf(rj);
		eq(body.recipientCheck, heldNow, "§13 3 loads held: the settings read says so, by reason, with another hold left out");
		eq(body.send, { domains: [DOMAIN], stopped: null }, "§13 ...beside what it said of sending");
		eq(rj.status().recipientCheck, heldNow, "§13 ...and the status");
		ok(!/@/.test(JSON.stringify(body.recipientCheck)), "§13 ...with no address");
		read.rowFor("900000422", ADDRESS);
		await rj.checkClaims("900000422");
		eq(((await settingsOf(rj)).recipientCheck || { held: {} }).held.count, 2, "§13 a person drafts one by hand: it no longer counts");
		// Only a load held now counts, whatever code a claim in another state still carries.
		const markedOnce = read.db.prepare("PRAGMA table_info(auto_invoice_claims)").all().some((c) => c.name === "check_held_at") ? { check_held_at: iso(read.now) } : {};
		read.seed("900000426", { state: "queued", code: "RECIPIENT_NOT_KNOWN", ...markedOnce });
		eq(((await settingsOf(rj)).recipientCheck || { held: {} }).held.count, 2, "§13 a claim back in the line doesn't count as held");
		read.db.prepare("DELETE FROM auto_invoice_claims WHERE load_key = '900000426'").run();
		read.now += 7 * 24 * HOUR + MIN;
		eq("recipientCheck" in (await settingsOf(rj)), false, "§13 more than 7 days on, nothing more held: the settings read as before");
		const offRead = makeWorld({ env: OFF });
		const orj = await offRead.started();
		eq((await settingsOf(orj)).recipientCheck, { on: false, domain: DOMAIN, days: 7, held: { count: 0, byCode: {} } }, "§13 the check off: the settings read says so, nothing held yet");
		offRead.ready(ID);
		await deliver(offRead, orj, ID, "§13 off, held");
		eq((await settingsOf(orj)).recipientCheck, { on: false, domain: DOMAIN, days: 7, held: { count: 1, byCode: { RECIPIENT_CHECK_OFF: 1 } } }, "§13 ...and counts what it holds");
		const noSend = makeWorld({ env: OFF, send: false });
		const nsj = await noSend.started();
		body = await settingsOf(nsj);
		eq([Object.keys(body), (body.recipientCheck || {}).on], [["optOutDomains", "confirmedBrokerDomains", "unreadable", "dropped", "recipientCheck"], false], "§13 sending off too: the settings read still says the check is off");
		const shadowRead = makeWorld({ env: { ...OFF, AUTO_INVOICE_DRAFTS_SHADOW: "" } });
		const srj = shadowRead.job();
		eq("recipientCheck" in (await settingsOf(srj)), false, "§13 shadow: nothing there");
		eq("recipientCheck" in srj.status(), false, "§13 ...in the status either");
	}
})().catch((e) => failures.push(`threw: ${e && e.stack}`)).then(() => {
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
