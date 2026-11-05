#!/usr/bin/env node
// A blank Email on a C.H. Robinson load (AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED, a kill switch):
// the job (lib/auto-invoice-job.js) over the Draft Invoice button's engine as shipped
// (lib/broker-invoice-draft.js), with made-up loads on an in-memory database. Only the
// outside world is made up: Sheets, Drive, Gemini, the PDF renderer, Gmail and SMTP. The route
// and the block run in scripts/test-auto-invoice-wiring.js §14.
//
//   §1  the flag: on unless it says off; only with the driver's trigger and sending on
//   §2  a blank Email on a CHR load goes out: one SMTP call, to the rate con's address
//   §3  every place that reads the Email cell, one case per row of the plan's table
//   §4  each clause of the rule refused alone: today's NO_BROKER_EMAIL, nothing paid past it
//   §5  every other check applies unchanged
//   §6  no contact name anywhere
//   §7  a later fill with the same domain raises no change, and adds no new stop
//   §8  Try again's look and its confirm on this path (R-H2 (a)), across a restart too; a
//       stale tap's re-armed claim and a claim re-queued at start-up get the same look, on a
//       filled Email too
//   §9  outside the driver's trigger the flag is ignored
//   §10 it can't send twice, across a restart during SMTP too
//
// Addresses on chrobinson.com use made-up local parts. No network, no files, never reads
// app.db.
//   node scripts/test-auto-invoice-blank-email.js      # exits 1 on any failure
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
const factoring = require(path.join(ROOT, "lib", "factoring-store.js"));
const { shownText } = require(path.join(ROOT, "lib", "pdf-shown-text.js"));
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
const CONTACT = "Madeup Q. Contactperson";
const HEADERS = Object.freeze(["Load ID", "Trailer Number", "Driver", "Job Status", "Email", "Broker Contact Name", "Completion Date", "  Payment  "]);
const PAYMENTS_HEADERS = Object.freeze([" Job ID", "Contract ID", "Payment Amount", "Invoice Number", "Payment Date", "Payment Status"]);
const ID = "LD-TEST-1401";
const NEEDS_EMAIL = Object.freeze(["needs_attention", "NO_BROKER_EMAIL"]);

function pdfWith(contentStream) {
	const z = zlib.deflateSync(Buffer.from(contentStream, "latin1"));
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n1 0 obj<</Length ${z.length}/Filter/FlateDecode>>stream\n`, "latin1"),
		z,
		Buffer.from("\nendstream endobj\n%%EOF", "latin1"),
	]);
}
// No billing block, as a C.H. Robinson rate con: the free scan finds nothing, so Gemini reads it.
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
async function until(cond, label, ms = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 1));
	}
	failures.push(`${label}: the condition was never met`);
	return false;
}

// `domains`: the send list. `confirmed`, `optOut`: the settings. `proofs`: rows a person made
// to ADDRESS. `headers`: the sheet's columns. `send`: false turns sending off.
function makeWorld({ domains = [DOMAIN], confirmed = [DOMAIN], optOut = [], proofs = 3, send = true, env = {}, headers = HEADERS } = {}) {
	const w = {
		now: T0,
		headers,
		rows: [],
		engineRows: new Map(),
		files: new Set(),
		candidates: new Map(),
		answers: new Map(),
		scans: new Map(),
		unreadable: new Set(),
		smtp: [],
		appends: [],
		gmail: [],
		sent: [],
		invoiceHtml: [],
		notices: [],
		logs: [],
		payments: [[...PAYMENTS_HEADERS]],
		lookAnswer: { verdict: "clean", mailboxes: {} },
		closed: () => [],
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
	w.saveSettings = (optOutDomains, confirmedBrokerDomains) => db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.run(JSON.stringify({ optOutDomains, confirmedBrokerDomains }));
	w.saveSettings(optOut, confirmed);

	const helpers = new Function("db", "brokerInvoice", "console", `${lifted.text}\nreturn { ${lifted.names.join(", ")} };`)(db, brokerInvoice, QUIET);
	w.helpers = helpers;
	// The free scan needs a listed local part, and these are made up, so an alternate file's
	// address is handed to the reader here. Everything else is read as shipped.
	const reader = Object.create(brokerInvoice);
	reader.extractRateConFields = async (buf, opts) => (w.scans.has(buf)
		? { orderNumber: "", poNumber: "", moveNumber: "", trailerNumber: "", totalRate: "", documentsEmail: w.scans.get(buf) }
		: brokerInvoice.extractRateConFields(buf, opts));
	w.values = (rows = w.rows) => [w.headers.slice(), ...rows.map((r) => w.headers.map((h) => r[h]))];
	w.engine = engineModule.create({
		...helpers,
		db,
		brokerInvoice: reader,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: w.values(w.rows.map((r) => ({ ...r, ...(w.engineRows.get(r["Load ID"]) || {}) }))) } }) } } }),
		SPREADSHEET_ID: "made-up-sheet",
		fetchDocumentBytes: async (d) => (w.unreadable.has(d.file_name) ? null : Buffer.from(`%PDF-1.4 ${d.file_name}`)),
		buildRateConLoadCtx: (row, h, loadId) => ({ loadId }),
		getRateConBytes: async (loadId) => {
			const list = w.candidates.get(rules.loadKey(loadId)) || [];
			return { buffer: list[0] ? list[0].buffer : null, candidates: list };
		},
		GEMINI_API_KEY: "made-up-key",
		runRateConGemini: async (b64) => {
			w.calls.gemini++;
			if (w.geminiDown) throw Object.assign(new Error("made-up outage"), { kind: "unavailable", status: 503 });
			return w.answers.get(b64) || { "Total Rate": null, Rate: null, "Order Number": null, "PO Number": null, "Documents Email": null };
		},
		renderHtmlToPdf: async (html) => {
			w.invoiceHtml.push(html);
			return textPdf(rules.htmlToText(html));
		},
		env: {},
		console: QUIET,
	});
	const counted = {
		prepare: async (args) => {
			w.calls.prepare.push(args);
			const r = await w.engine.prepare(args);
			return w.prepareHook ? w.prepareHook(r, args) : r;
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
		const row = { ...(was || { "Load ID": id, "Trailer Number": "TR-1", Driver: "Made-up Driver", "Job Status": "At Receiver", Email: "",
			"Broker Contact Name": CONTACT, "Completion Date": "10/20/2026", "  Payment  ": "$1,000.00" }), ...over };
		const at = w.rows.indexOf(was);
		if (at >= 0) w.rows[at] = row; else w.rows.push(row);
	};
	w.addPod = (id, { file = true } = {}) => {
		const name = `pod-${rules.loadKey(id)}-${db.prepare("SELECT COUNT(*) n FROM documents").get().n}.pdf`;
		db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'POD', ?, ?, '2026-10-20 13:00:00')").run(id, name, `/uploads/${name}`);
		if (file) w.files.add(name);
		return name;
	};
	// One rate con on file, named by `source`, whose Gemini read gives the address and the total.
	w.rateCon = (id, { address = ADDRESS, total = "$1,000.00", source = "documents", trailer = null, note = id, driveFileName = `Subject: Rate Confirmation ${id}.pdf`, number = id, printed = address } = {}) => {
		const bytes = plainPdf(note, printed);
		w.answers.set(bytes.toString("base64"), { "Total Rate": total, Rate: null, "Load Number": number, "Order Number": null, "PO Number": null, "Trailer Number": trailer, "Documents Email": address });
		const cand = { buffer: bytes, source, label: source, fileName: "rc.pdf", ...(source === "drive" ? { driveFileName } : {}) };
		w.candidates.set(rules.loadKey(id), [...(w.candidates.get(rules.loadKey(id)) || []), cand]);
		return cand;
	};
	// A load ready to be delivered: its POD on file, its rate con, and a blank Email.
	w.ready = (id, over = {}, rc = {}) => {
		w.setRow(id, over);
		w.addPod(id);
		w.rateCon(id, rc);
	};
	w.proof = (address, n, via = "imap") => {
		for (let i = 0; i < n; i++) {
			db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', ?, 'made-up-admin')")
				.run(`LD-PROOF-${++w.ids}`, `09012026-${w.ids}`, address, via);
		}
	};
	// Rows a person made on one load, whatever the spelling of its ID.
	w.proofOn = (loadIds, address, via = "imap") => {
		for (const loadId of loadIds) {
			db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', ?, 'made-up-admin')")
				.run(loadId, `09012026-${++w.ids}`, address, via);
		}
	};
	w.proof(ADDRESS, proofs);
	w.env0 = { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", ...env };
	w.deps = (extra = {}) => ({
		db,
		env: w.env0,
		now: () => new Date(w.now),
		readJobTracking: async () => Object.freeze({ headers: w.headers, data: Object.freeze(helpers.deduplicateLoads(w.rows.map((r) => ({ ...r })), [...w.headers])) }),
		closedMonthsOf: (h, row) => w.closed(row),
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
	w.draftRow = (id) => db.prepare("SELECT recipient, recipient_source, broker_name, via, created_by, total FROM load_invoice_drafts WHERE load_id = ?").all(id);
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
	return w;
}

// What PUT /api/driver/status does around its sheet write.
function tap(w, job, id, role = "Driver") {
	const start = job.driverDelivered({ role, loadId: id, oldStatus: w.row(id)["Job Status"], newStatus: "Delivered", readBack: async () => w.row(id)["Job Status"] });
	w.setRow(id, { "Job Status": "Delivered" });
	start.written();
}
const drained = (w, label) => until(() => w.open() === 0, `${label}: every claim settled`);
async function deliver(w, job, id, label = id) {
	tap(w, job, id);
	await drained(w, label);
	await turn();
}
function markFactored(w, id) {
	factoring.ensureSchema(w.db);
	w.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES (?, ?, 1, 'person', ?, ?)").run(rules.loadKey(id), id, iso(w.now), iso(w.now));
}
// The guard and handler chain of each route, on a tiny Express stand-in.
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
// A load's Try again as a Super Admin's row carries it.
function retryOf(w, job, id) {
	const rows = [{ ...w.row(id) }];
	job.annotateCompletedRows({ rows, headers: [...w.headers], isSuperAdmin: true });
	return rows[0]._autoInvoice && rows[0]._autoInvoice.retry;
}
const paidNothing = (w) => [w.smtp.length, w.appends.length, w.calls.mint];
const namesOf = (m) => ((m && m.attachments) || []).map((a) => a.filename);
// A tree without the path fails case by case, not by a stack trace.
const flagOf = (env) => (typeof rules.blankEmailEnabled === "function" ? rules.blankEmailEnabled(env) : null);
const loadsTo = (db, address) => (typeof ledger.invoiceLoadsTo === "function" ? ledger.invoiceLoadsTo(db, address) : null);
const jsonOf = (text) => {
	try {
		return JSON.parse(text) || {};
	} catch {
		return {};
	}
};

(async () => {
	// ===================================================================== §1
	section("§1 the flag: on unless it says off; only with the driver's trigger and sending on");
	{
		eq(typeof rules.blankEmailEnabled, "function", "§1 FAILS ON THE OLD CODE: the rules read the flag");
		for (const [v, want] of [[undefined, true], ["", true], ["true", true], ["1", true], ["maybe", true], ["false", false], ["FALSE", false], [" off ", false], ["0", false], ["no", false], ["Off", false]]) {
			eq(flagOf({ AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED: v }), want, `§1 FAILS ON THE OLD CODE: AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED=${JSON.stringify(v)}: ${want ? "on" : "off"} (a kill switch: only an explicit off)`);
		}
		eq(flagOf(undefined), true, "§1 FAILS ON THE OLD CODE: no settings at all: on");
		eq(rules.BLANK_EMAIL_DOMAIN, require(path.join(ROOT, "lib", "chr-events.js")).CHR_DOMAIN, "§1 FAILS ON THE OLD CODE: the one domain is the one the CHR code knows");
		eq(rules.BLANK_EMAIL_MIN_LOADS, 3, "§1 FAILS ON THE OLD CODE: at least 3 loads");
		ok(fs.readFileSync(path.join(ROOT, "lib", "chr-events.js"), "utf8").includes(`const LOAD_NUMBER_RE = ${String(rules.BLANK_EMAIL_LOAD_NUMBER_RE)};`), "§1 FAILS ON THE OLD CODE (N1): C.H. Robinson's load-number shape is the one the CHR code reads");
		const template = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
		ok(/^# AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED=$/m.test(template) && /AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED: a kill switch, ON unless set to false/.test(template), "§1 FAILS ON THE OLD CODE: the settings template names it, unset, a kill switch");
	}

	// ===================================================================== §2
	section("§2 a blank Email on a CHR load goes out");
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready(ID);
		await deliver(w, job, ID);
		eq(w.state(ID), ["drafted", ""], "§2 FAILS ON THE OLD CODE: a blank-Email load with a known CHR address is sent, not held");
		eq(w.smtp.map((m) => m.to), [ADDRESS], "§2 FAILS ON THE OLD CODE: one SMTP call, to the rate con's address");
		eq(w.appends.length, 0, "§2 no draft");
		eq(namesOf(w.smtp[0]).length, 3, "§2 FAILS ON THE OLD CODE: the invoice, the POD and the rate con");
		eq(namesOf(w.smtp[0])[2], `${ID}.pdf`, "§2 FAILS ON THE OLD CODE: ...the rate con last");
		const c = w.claim(ID);
		eq([c.delivery, c.stage, jsonOf(c.sent_json).to, jsonOf(c.fingerprint_json).brokerEmail], ["send", "recorded", ADDRESS, ""], "§2 FAILS ON THE OLD CODE: recorded as a send, its fingerprint showing the blank cell");
		eq(w.draftRow(ID).map((r) => [r.recipient, r.via, r.recipient_source]), [[ADDRESS, "auto-smtp", "ratecon"]], "§2 FAILS ON THE OLD CODE: one row, the job's send");
		eq(w.calls.prepare.map((a) => a.blankEmailDomain), [DOMAIN], "§2 FAILS ON THE OLD CODE: the job names the one domain to the engine");
		eq(w.notices.length, 0, "§2 no notice, no stop");
		eq(ledger.getSendStop(w.db), null, "§2 sending isn't stopped");
		eq([w.calls.look.length, w.calls.payments], [0, 0], "§2 a driver's first tap asks for no look");

		// Any spelling of a blank cell, and any way the address was proved.
		for (const [label, cell] of [["spaces", "   "], ["a tab", "\t"], ["a non-breaking space", " "]]) {
			const x = makeWorld();
			const j = await x.started();
			x.ready(ID, { Email: cell });
			await deliver(x, j, ID);
			eq(x.smtp.length, 1, `§2 FAILS ON THE OLD CODE: a cell holding only ${label} is blank`);
		}
		for (const [label, make] of [
			["3 of a person's rows by Gmail", (x) => x.proof(ADDRESS, 3)],
			["3 rows by the n8n fallback", (x) => x.proof(ADDRESS, 3, "n8n")],
			["a person's rows, whichever way they left", (x) => { x.proof(ADDRESS, 2); x.proof(ADDRESS, 1, "n8n"); }],
			["rows in another case", (x) => x.proof(ADDRESS.toUpperCase(), 3)],
			["rows with spaces around the address", (x) => x.proof(` ${ADDRESS} `, 3)],
		]) {
			const x = makeWorld({ proofs: 0 });
			make(x);
			const j = await x.started();
			x.ready(ID);
			await deliver(x, j, ID);
			eq([x.state(ID), x.smtp.length], [["drafted", ""], 1], `§2 FAILS ON THE OLD CODE: ${label} prove the address`);
		}
		// The rate con's own spelling of the address goes out as it is.
		const shout = makeWorld();
		const sj = await shout.started();
		shout.ready(ID, {}, { address: ADDRESS.toUpperCase() });
		await deliver(shout, sj, ID);
		eq(shout.smtp.map((m) => m.to), [ADDRESS.toUpperCase()], "§2 FAILS ON THE OLD CODE: an address in capitals is the same address, and its domain still exact");

		// A load with a filled Email is untouched: no rows asked for, nothing new passed.
		const filled = makeWorld({ proofs: 0 });
		const fj = await filled.started();
		filled.ready(ID, { Email: AGENT });
		await deliver(filled, fj, ID);
		eq([filled.smtp.map((m) => m.to), filled.calls.prepare.map((a) => Object.keys(a).sort())], [[ADDRESS], [["body", "dryRun", "loadId", "mode"]]], "§2 a filled Email: sent as before, the engine's arguments as before, and no rows asked for");
	}

	// ===================================================================== §3
	section("§3 every place that reads the Email cell");
	{
		const cols = rules.jobColumns([...HEADERS]);
		const facts = (over, more = {}) => rules.loadFacts({ row: { Email: "", "Job Status": "Delivered", ...over }, cols, confirmedDomains: [DOMAIN], blankEmailSendDomains: [DOMAIN], ...more });

		// loadFacts(): blank and malformed both read "" as an address, so the raw cell is kept.
		eq([facts({}).emailCellBlank, facts({ Email: "  " }).emailCellBlank, facts({ Email: "see rate con" }).emailCellBlank, facts({ Email: "N/A" }).emailCellBlank, facts({ Email: AGENT }).emailCellBlank],
			[true, true, false, false, false], "§3 rules.js loadFacts(): FAILS ON THE OLD CODE: the raw cell is kept, so a malformed cell isn't blank");
		eq(facts({ Email: "see rate con" }).brokerEmail, "", "§3 ...and reads no address, as before");
		eq(rules.loadFacts({ row: null, cols }).emailCellBlank, false, "§3 loadFacts(): no row isn't a blank cell");
		eq(rules.loadFacts({ row: { Email: "" }, cols: rules.jobColumns(["Load ID", "Job Status"]), confirmedDomains: [DOMAIN], blankEmailSendDomains: [DOMAIN] }).blankEmailPath, false, "§3 loadFacts(): no Email column isn't a blank cell");
		eq(facts({}).blankEmailPath, true, "§3 loadFacts(): FAILS ON THE OLD CODE: blank, with the domain open");
		eq(facts({}, { blankEmailSendDomains: null }).blankEmailPath, false, "§3 loadFacts(): a caller that doesn't name the send list (the sweep, the shadow, the reports): no path");
		eq(facts({ Email: "see rate con" }).blankEmailPath, false, "§3 loadFacts(): a malformed cell: no path");
		eq(Object.keys(rules.fingerprint(facts({}))).sort(), ["brokerEmail", "completed", "live", "paymentCents", "podIds", "rateConIds", "trailer"], "§3 the fingerprint keeps its fields, so no stored hash moves");

		// freeVerdict(): the first stop and the next one.
		const ready = { live: true, completed: true, drafts: 0, optedOut: false, brokerDomain: "", isBison: false, closedMonths: [], hasDeliveryDate: true, pods: 1, podsUnreadable: 0, activeAdvanceLines: 0, factored: false, brokerDomainConfirmed: false };
		eq(rules.freeVerdict({ ...ready, blankEmailPath: false }), { state: "needs_attention", code: "NO_BROKER_EMAIL" }, "§3 rules.js no broker domain: no path, today's NO_BROKER_EMAIL");
		eq(rules.freeVerdict({ ...ready, blankEmailPath: true }), { state: "queued", code: "" }, "§3 rules.js no broker domain: FAILS ON THE OLD CODE: the path goes on, past NO_BROKER_EMAIL and BROKER_DOMAIN_UNCONFIRMED");
		eq(rules.freeVerdict({ ...ready, brokerDomain: "example-broker.test", brokerDomainConfirmed: false }).code, "BROKER_DOMAIN_UNCONFIRMED", "§3 rules.js an unconfirmed sheet domain: still a person");

		// recipientRule(): the blank path's one domain and the checks.
		const allow = { confirmedDomains: [DOMAIN], blankEmail: { sendDomains: [DOMAIN], optOutDomains: [], primary: { primarySource: "documents", recipientFrom: -1, loadId: ID, rateConNumber: ID, addressPrinted: true }, loadsToAddress: 3 } };
		const rr = (over = {}, blank = {}) => rules.recipientRule({ brokerEmail: "", documentsEmail: ADDRESS, ...allow, ...over, blankEmail: { ...allow.blankEmail, ...blank } });
		eq(rr(), { ok: true, to: ADDRESS, source: "ratecon" }, "§3 rules.js recipientRule(): FAILS ON THE OLD CODE: every check holds: the rate con's address");
		eq(rules.recipientRule({ brokerEmail: "", documentsEmail: ADDRESS, confirmedDomains: [DOMAIN] }), { ok: false, code: "NO_BROKER_EMAIL" }, "§3 recipientRule(): no blank-path argument: as before");
		const REFUSED = { ok: false, code: "NO_BROKER_EMAIL" };
		eq(rr({ documentsEmail: "" }), REFUSED, "§3 recipientRule(): no address");
		eq(rr({ documentsEmail: "not-an-address" }), REFUSED, "§3 recipientRule(): not an address");
		eq(rr({ documentsEmail: `made-up.billing@mail.${DOMAIN}` }), REFUSED, "§3 recipientRule(): a subdomain");
		eq(rr({ documentsEmail: `made-up.billing@${DOMAIN}.example.test` }), REFUSED, "§3 recipientRule(): a domain that starts the same");
		eq(rr({ documentsEmail: `made-up.billing@not${DOMAIN}` }), REFUSED, "§3 recipientRule(): a domain that ends the same");
		eq(rr({ documentsEmail: "made-up.billing@example-broker.test", confirmedDomains: ["example-broker.test", DOMAIN] }, { sendDomains: ["example-broker.test", DOMAIN] }), REFUSED, "§3 recipientRule(): a confirmed, listed domain that isn't the one");
		const PRIMARY = allow.blankEmail.primary;
		eq(rr({}, { primary: { ...PRIMARY, recipientFrom: 1 } }), REFUSED, "§3 recipientRule(): an alternate file");
		for (const source of ["drive-content", "documents-bol", "upload", "", null, undefined]) {
			eq(rr({}, { primary: { ...PRIMARY, primarySource: source } }), REFUSED, `§3 recipientRule(): a primary whose source is ${JSON.stringify(source)}`);
		}
		const DRIVE = { primarySource: "drive", recipientFrom: -1, primaryFileName: "Subject: Rate Confirmation 900000015.pdf", loadId: "900000015", rateConNumber: "900000015", addressPrinted: true };
		eq(rr({}, { primary: DRIVE }).ok, true, "§3 recipientRule(): FAILS ON THE OLD CODE: found by file name");
		eq(rr({}, { primary: { ...DRIVE, loadId: "#900000015" } }).ok, true, "§3 recipientRule(): FAILS ON THE OLD CODE: ...either spelling of the load ID");
		eq(rr({}, { primary: { ...DRIVE, primaryFileName: "Subject: Rate Confirmation 90000001502.pdf" } }), REFUSED, "§3 recipientRule(): FAILS ON THE OLD CODE (L6): a file named for a longer number");
		eq(rr({}, { primary: { ...DRIVE, primaryFileName: undefined } }), REFUSED, "§3 recipientRule(): FAILS ON THE OLD CODE (L6): a Drive file with no name to test");
		eq(rr({}, { primary: { ...DRIVE, loadId: undefined } }), REFUSED, "§3 recipientRule(): FAILS ON THE OLD CODE (L6): no load ID to test it against");
		for (const id of ["9000015", "90000015", "9000000150", "LD900000015"]) {
			eq(rr({}, { primary: { ...DRIVE, loadId: id, rateConNumber: id, primaryFileName: `Subject: Rate Confirmation ${id}.pdf` } }), REFUSED, `§3 recipientRule(): FAILS ON THE OLD CODE (N1): a Drive primary, load ${id}: not C.H. Robinson's shape`);
		}
		eq(rr({}, { primary: { ...PRIMARY, loadId: "9000015", rateConNumber: "9000015" } }).ok, true, "§3 recipientRule(): FAILS ON THE OLD CODE: a rate-con row needs no file name and no shape: it is on the load");
		eq(rr({}, { primary: { ...DRIVE, rateConNumber: "900001502" } }), REFUSED, "§3 recipientRule(): FAILS ON THE OLD CODE (N1): the rate con says it's another load's");
		eq(rr({}, { primary: { ...PRIMARY, rateConNumber: "900001502" } }), REFUSED, "§3 recipientRule(): FAILS ON THE OLD CODE (N1): ...on a rate-con row too");
		for (const said of ["", null, undefined]) eq(rr({}, { primary: { ...DRIVE, rateConNumber: said } }), REFUSED, `§3 recipientRule(): FAILS ON THE OLD CODE (N1): the rate con's number wasn't read (${JSON.stringify(said)})`);
		eq(rr({}, { primary: { ...DRIVE, rateConNumber: "#900000015" } }).ok, true, "§3 recipientRule(): FAILS ON THE OLD CODE: ...its number in either spelling");
		for (const printed of [false, undefined, "true"]) eq(rr({}, { primary: { ...DRIVE, addressPrinted: printed } }), REFUSED, `§3 recipientRule(): FAILS ON THE OLD CODE (N6): the address isn't printed on the rate con (${JSON.stringify(printed)})`);
		eq(rr({ confirmedDomains: [] }), REFUSED, "§3 recipientRule(): not confirmed");
		eq(rr({}, { sendDomains: [] }), REFUSED, "§3 recipientRule(): not on the send list");
		eq(rr({}, { optOutDomains: [DOMAIN] }), REFUSED, "§3 recipientRule(): opted out");
		eq(rr({}, { loadsToAddress: 2 }), REFUSED, "§3 recipientRule(): 2 loads");
		eq(rr({}, { loadsToAddress: "not a count" }), REFUSED, "§3 recipientRule(): no count");
		eq(rr({ brokerEmail: AGENT, confirmedDomains: [] }).code, "BROKER_DOMAIN_UNCONFIRMED", "§3 recipientRule(): a sheet Email never takes the blank path");
		eq(rules.recipientRule({ brokerEmail: "made-up@bisontransport.com", bisonRecipient: "made-up-ap@example.test", documentsEmail: ADDRESS, ...allow }).source, "bison", "§3 recipientRule(): Bison stays Bison");

		// recipientRefusal(): the job reads the real confirmed list on this path.
		const many = makeWorld({ confirmed: ["example-broker.test", DOMAIN, "example-other.test"] });
		const mj = await many.started();
		many.ready(ID);
		await deliver(many, mj, ID);
		eq(many.smtp.length, 1, "§3 job.js recipientRefusal(): FAILS ON THE OLD CODE: the real confirmed list, with other brokers on it");

		// A person's opt-out or removal during the build stops it at the render's own check.
		for (const [label, change] of [["opts chrobinson.com out", (x) => x.saveSettings([DOMAIN], [DOMAIN])], ["removes it from Confirmed", (x) => x.saveSettings([], [])]]) {
			const x = makeWorld();
			const j = await x.started();
			x.ready(ID);
			x.renderHook = () => change(x);
			await deliver(x, j, ID);
			eq([x.state(ID), x.smtp.length, x.appends.length], [NEEDS_EMAIL, 0, 0], `§3 job.js recipientRefusal(): a person ${label} during the build: nothing goes`);
		}

		// The job and the engine read the cell apart: it stops.
		const apart = makeWorld();
		const aj = await apart.started();
		apart.ready(ID);
		apart.engineRows.set(ID, { Email: AGENT });
		await deliver(apart, aj, ID);
		eq([apart.state(ID), apart.smtp.length, apart.calls.mint], [NEEDS_EMAIL, 0, 0], "§3 job.js recipientRefusal(): the sheet filled between the two reads: the engine took the plain path, so the job refuses");
		const apart2 = makeWorld();
		const aj2 = await apart2.started();
		apart2.ready(ID, { Email: AGENT });
		apart2.engineRows.set(ID, { Email: "" });
		await deliver(apart2, aj2, ID);
		eq([apart2.state(ID), apart2.smtp.length, apart2.calls.prepare[0].blankEmailDomain], [NEEDS_EMAIL, 0, undefined], "§3 draft.js: the sheet emptied between the two reads: the job didn't ask, so the engine refuses");

		// The job's rule holds on its own, whatever the engine answers.
		for (const [label, change] of [["an alternate file", (ctx) => { ctx.blankEmailPrimary.recipientFrom = 1; }], ["a by-content rate con", (ctx) => { ctx.blankEmailPrimary.primarySource = "drive-content"; }], ["another load's rate con", (ctx) => { ctx.blankEmailPrimary.rateConNumber = "900001502"; }], ["an address it doesn't print", (ctx) => { ctx.blankEmailPrimary.addressPrinted = false; }], ["no blank path at all", (ctx) => { ctx.blankEmailPath = false; }]]) {
			const x = makeWorld();
			const j = await x.started();
			x.ready(ID);
			x.prepareHook = (r) => {
				if (r.ok) change(r.ctx);
				return r;
			};
			await deliver(x, j, ID);
			eq([x.state(ID), x.smtp.length, x.calls.mint], [NEEDS_EMAIL, 0, 0], `§3 job.js recipientRefusal(): the engine says ${label}: the job refuses too`);
		}

		// The engine's own gate: an argument from the job, never from a request.
		const e = makeWorld();
		e.ready(ID);
		e.setRow(ID, { "Job Status": "Delivered" });
		const auto = (extra = {}) => e.engine.prepare({ loadId: ID, body: {}, dryRun: false, mode: "auto", ...extra });
		eq((await auto()).code, "NO_BROKER_EMAIL", "§3 draft.js a blank cell, no argument: NO_BROKER_EMAIL, as before");
		const on = await auto({ blankEmailDomain: DOMAIN });
		const onCtx = on.ctx || { invoiceTo: {} };
		eq([on.ok, onCtx.blankEmailPath, onCtx.invoiceTo.email], [true, true, ADDRESS], "§3 draft.js FAILS ON THE OLD CODE: the job's argument: it goes on, to the rate con's address");
		eq(onCtx.blankEmailPrimary, { primarySource: "documents", recipientFrom: -1, loadId: ID, rateConNumber: ID, addressPrinted: true }, "§3 draft.js FAILS ON THE OLD CODE: where the address came from, and what the rate con says, are on the context");
		const manual = await e.engine.prepare({ loadId: ID, body: { blankEmailDomain: DOMAIN }, dryRun: false, mode: "manual", ov: e.helpers.parseInvoiceOverrides({}), req: { session: { user: { id: 1, username: "made-up-admin", role: "Super Admin" } } }, blankEmailDomain: DOMAIN });
		eq([manual.ok, manual.ctx.blankEmailPath, manual.ctx.effBrokerName], [true, false, CONTACT], "§3 draft.js the button: the argument means nothing there, and it reads as it always has");
		eq(SRC.split("blankEmailDomain").length - 1, 0, "§3 server.js never names the argument: no request can reach it");
		e.setRow(ID, { Email: "see rate con" });
		eq((await auto({ blankEmailDomain: DOMAIN })).code, "NO_BROKER_EMAIL", "§3 draft.js a malformed cell, with the argument: NO_BROKER_EMAIL");
		const noCol = makeWorld({ headers: HEADERS.filter((h) => h !== "Email") });
		noCol.ready(ID, { "Job Status": "Delivered" });
		eq((await noCol.engine.prepare({ loadId: ID, body: {}, dryRun: false, mode: "auto", blankEmailDomain: DOMAIN })).code, "NO_BROKER_EMAIL", "§3 draft.js no Email column, with the argument: NO_BROKER_EMAIL");
		// The engine's own rule, without the job's check behind it.
		const alt = makeWorld();
		alt.setRow(ID, { "Job Status": "Delivered" });
		alt.addPod(ID);
		alt.rateCon(ID, { address: null, note: "primary" });
		alt.scans.set(alt.rateCon(ID, { source: "drive", note: "alternate" }).buffer, ADDRESS);
		eq((await alt.engine.prepare({ loadId: ID, body: {}, dryRun: false, mode: "auto", blankEmailDomain: DOMAIN })).code, "NO_BROKER_EMAIL", "§3 draft.js an alternate file's address: the engine refuses it on its own");
		eq((await alt.engine.prepare({ loadId: ID, body: {}, dryRun: false, mode: "manual", ov: alt.helpers.parseInvoiceOverrides({}), req: { session: { user: { id: 1, username: "made-up-admin", role: "Super Admin" } } } })).ctx.blankEmailPath, false, "§3 draft.js the button's path reads as it did: this is the automatic path's alone");

		for (const [label, rc] of [["says it's another load's", { number: "900001502" }], ["doesn't print the address", { printed: null }], ["prints another address", { printed: AGENT }]]) {
			const own = makeWorld();
			own.ready(ID, { "Job Status": "Delivered" }, rc);
			eq((await own.engine.prepare({ loadId: ID, body: {}, dryRun: false, mode: "auto", blankEmailDomain: DOMAIN })).code, "NO_BROKER_EMAIL", `§3 draft.js FAILS ON THE OLD CODE (N1, N6): a rate con that ${label}: the engine refuses it on its own`);
		}

		// autoRecipientRefusal(): the blank path's own rule, and the pin for every other case.
		const norm = brokerInvoice.normalizeEmail;
		const refusal = (args) => (engineModule.autoRecipientRefusal(args, norm) || { code: null }).code;
		const blankArgs = { isBison: false, recipientEmail: ADDRESS, documentsEmail: ADDRESS, brokerEmail: "", blankEmailDomain: DOMAIN, fromPrimary: true };
		eq(refusal(blankArgs), null, "§3 draft.js autoRecipientRefusal(): FAILS ON THE OLD CODE: the blank path's own rule");
		eq(refusal({ ...blankArgs, fromPrimary: false }), "NO_BROKER_EMAIL", "§3 autoRecipientRefusal(): FAILS ON THE OLD CODE: not from the primary");
		const sub = `made-up.billing@mail.${DOMAIN}`;
		eq(refusal({ ...blankArgs, recipientEmail: sub, documentsEmail: sub }), "NO_BROKER_EMAIL", "§3 autoRecipientRefusal(): FAILS ON THE OLD CODE: a subdomain");
		eq(refusal({ ...blankArgs, documentsEmail: "" , recipientEmail: DEFAULT_INBOX }), "NO_BROKER_EMAIL", "§3 autoRecipientRefusal(): FAILS ON THE OLD CODE: no address: never the default inbox");
		eq(refusal({ ...blankArgs, recipientEmail: DEFAULT_INBOX }), "NO_BROKER_EMAIL", "§3 autoRecipientRefusal(): FAILS ON THE OLD CODE: a recipient other than the address");
		eq(refusal({ isBison: false, recipientEmail: ADDRESS, documentsEmail: ADDRESS, brokerEmail: "" }), "RECIPIENT_DOMAIN_MISMATCH", "§3 autoRecipientRefusal(): with no argument, the pin stays");
		eq(refusal({ isBison: false, recipientEmail: ADDRESS, documentsEmail: ADDRESS, brokerEmail: AGENT }), null, "§3 autoRecipientRefusal(): the plain path, as before");

		// ledger: the new query.
		const lw = makeWorld({ proofs: 0 });
		lw.proof(ADDRESS, 2);
		lw.proof(ADDRESS, 1, rules.VIA_SEND);
		lw.proof(ADDRESS, 4, rules.VIA_DRAFT);
		lw.proof(ADDRESS, 4, "triumph");
		lw.proof(AGENT, 5);
		lw.proof("", 5);
		eq(loadsTo(lw.db, ADDRESS), 2, "§3 ledger.js FAILS ON THE OLD CODE (L1): only a person's rows, on the exact address");
		eq(loadsTo(lw.db, ""), 0, "§3 ledger.js FAILS ON THE OLD CODE: no address: no rows, whatever is blank");
		const sameLoad = makeWorld({ proofs: 0 });
		sameLoad.proofOn(["LD-PROOF-A", "LD-PROOF-A", "ld-proof-a", "#LD-PROOF-A", " LD-PROOF-A "], ADDRESS);
		eq(loadsTo(sameLoad.db, ADDRESS), 1, "§3 ledger.js FAILS ON THE OLD CODE (N6): five rows on one load, in any spelling of its ID, are one load");
		const noTable = new Database(":memory:");
		eq(loadsTo(noTable, ADDRESS), 0, "§3 ledger.js FAILS ON THE OLD CODE: no table: none");
		noTable.close();

		// extractDocumentsEmail() has no agent to exclude here, and Gemini's address no anchor: the rows cover the harm.
		const misread = makeWorld();
		const mis = await misread.started();
		misread.ready(ID, {}, { address: AGENT });
		await deliver(misread, mis, ID);
		eq([misread.state(ID), paidNothing(misread)], [NEEDS_EMAIL, [0, 0, 0]], "§3 invoice.js extractDocumentsEmail(): a misread that names a booking agent at the right domain: no rows, nothing goes");
		eq(misread.calls.gemini, 1, "§3 ...at the cost of one read");
	}

	// ===================================================================== §4
	section("§4 each clause refused alone: today's NO_BROKER_EMAIL");
	{
		const refusedAlone = async (label, { opts = {}, setup = null, rc = {}, paid = true } = {}) => {
			const w = makeWorld(opts);
			const job = await w.started();
			w.ready(ID, {}, rc);
			if (setup) setup(w);
			await deliver(w, job, ID);
			eq([w.state(ID), paidNothing(w)], [NEEDS_EMAIL, [0, 0, 0]], `§4 ${label}: Needs attention, nothing sent, drafted or numbered`);
			if (paid === false) eq(w.calls.prepare.length, 0, `§4 ${label}: ...and no engine call: nothing is paid for`);
			return w;
		};
		// 1. The primary rate con, found by file name or from a rate-con row.
		await refusedAlone("clause 1, the address only on an alternate file", { setup: (w) => {
			w.candidates.delete(rules.loadKey(ID));
			w.rateCon(ID, { address: null, note: "primary" });
			const alt = w.rateCon(ID, { source: "drive", note: "alternate" });
			w.scans.set(alt.buffer, ADDRESS);
		} });
		await refusedAlone("clause 1, a rate con found only by reading Drive", { rc: { source: "drive-content" } });
		await refusedAlone("clause 1, an earlier by-content match on the load", { setup: (w) => {
			w.db.prepare("INSERT INTO documents (load_id, type, file_name, drive_file_id, drive_url) VALUES (?, 'RATECON', 'made-up-match.pdf', 'made-up-drive-id', '')").run(ID);
		} });
		await refusedAlone("clause 1, no rate con on file", { setup: (w) => { w.candidates.delete(rules.loadKey(ID)); } });
		await refusedAlone("clause 1, only a BOL on file", { rc: { source: "documents-bol" } });
		await refusedAlone("clause 1, a rate con that names no address", { rc: { address: null } });
		// A Drive file is found by a substring of its name, so a load's number inside a longer one
		// finds another load's rate con. With no sheet Email to anchor it, this path asks more.
		const CHR_SHAPED = "900000015";
		const named = async (driveFileName, over = {}, rc = {}, id = CHR_SHAPED) => {
			const w = makeWorld();
			const job = await w.started();
			w.ready(id, over, { source: "drive", driveFileName, ...rc });
			await deliver(w, job, id);
			return w;
		};
		for (const [label, name] of [
			["inside a longer number", `Subject: Rate Confirmation ${CHR_SHAPED}02.pdf`],
			["after another digit", `Subject: Rate Confirmation 1${CHR_SHAPED}.pdf`],
			["after letters", `Subject: Rate Confirmation LD${CHR_SHAPED}.pdf`],
			["continued by a joiner and a digit", `Subject: Rate Confirmation ${CHR_SHAPED}-2.pdf`],
			["after a digit and a joiner", `Subject: Rate Confirmation 2-${CHR_SHAPED}.pdf`],
			["continued by a dot and a digit", `Subject: Rate Confirmation ${CHR_SHAPED}.1.pdf`],
			["not there at all", ""],
		]) {
			const w = await named(name);
			eq([w.state(CHR_SHAPED), paidNothing(w)], [NEEDS_EMAIL, [0, 0, 0]], `§4 FAILS ON THE OLD CODE (L6): clause 1, a Drive file with the load's number ${label}: Needs attention, nothing sent, drafted or numbered`);
		}
		for (const name of [`Subject: Rate Confirmation ${CHR_SHAPED}.pdf`, `Subject: Order #${CHR_SHAPED}`, `${CHR_SHAPED}-ratecon.pdf`, `Load ${CHR_SHAPED} Rate Con.pdf`]) {
			const w = await named(name);
			eq(w.smtp.map((m) => m.to), [ADDRESS], `§4 FAILS ON THE OLD CODE: clause 1, a Drive file named ${JSON.stringify(name)}: this load's own, so it goes`);
		}
		// A load that isn't C.H. Robinson's shape, its number a whole token in a Drive file's name.
		for (const id of ["9000015", "90000015", "9000000150", "LD900000015"]) {
			const w = await named(`Subject: Rate Confirmation 900001502 PO ${id}.pdf`, {}, { number: id }, id);
			eq([w.state(id), paidNothing(w)], [NEEDS_EMAIL, [0, 0, 0]], `§4 FAILS ON THE OLD CODE (N1): load ${id} isn't C.H. Robinson's shape, its number a token in a Drive file's name: no mail`);
		}
		// The review's case: a C.H. Robinson file for another load, with this load's number in its name.
		{
			const w = await named(`Subject: Rate Confirmation 900001502 PO ${CHR_SHAPED}.pdf`, {}, { number: "900001502" });
			eq([w.state(CHR_SHAPED), paidNothing(w)], [NEEDS_EMAIL, [0, 0, 0]], "§4 FAILS ON THE OLD CODE (N1): another load's rate con, this load's number a token in its name: the rate con says whose it is: no mail");
		}
		await refusedAlone("clause 1 (N1): FAILS ON THE OLD CODE: a rate-con row that says it's another load's", { rc: { number: "900001502" } });
		await refusedAlone("clause 1 (N1): FAILS ON THE OLD CODE: a rate con whose number wasn't read", { rc: { number: null } });
		await refusedAlone("clause 1 (N6): FAILS ON THE OLD CODE: the read names an address the rate con doesn't print", { rc: { printed: null } });
		await refusedAlone("clause 1 (N6): FAILS ON THE OLD CODE: the read names one address and the rate con prints another", { rc: { printed: AGENT } });
		for (const [label, printed] of [["with a space in it, as text runs can", `made-up.billing@ ${DOMAIN}`], ["in capitals", ADDRESS.toUpperCase()]]) {
			const w = makeWorld();
			const job = await w.started();
			w.ready(ID, {}, { printed });
			await deliver(w, job, ID);
			eq(w.smtp.map((m) => m.to), [ADDRESS], `§4 FAILS ON THE OLD CODE: the address printed ${label}: it goes`);
		}
		// The plain path has the sheet's domain to anchor it, and keeps today's tests.
		const plainNamed = await named(`Subject: Rate Confirmation ${CHR_SHAPED}02.pdf`, { Email: AGENT }, { number: "900001502", printed: null });
		eq(plainNamed.smtp.map((m) => m.to), [ADDRESS], "§4 a filled Email keeps today's tests: a longer number in the file's name, another number on the rate con, an address it doesn't print: the plain path isn't changed");
		// 2. Exactly chrobinson.com, the only domain this path takes.
		for (const [label, address] of [
			["a subdomain", `made-up.billing@mail.${DOMAIN}`],
			["a domain that starts the same", `made-up.billing@${DOMAIN}.example.test`],
			["a domain that ends the same", `made-up.billing@made-up${DOMAIN}`],
			["another broker's domain", "made-up.billing@example-broker.test"],
			["free mail", "made-up.billing@gmail.com"],
		]) {
			await refusedAlone(`clause 2, ${label}`, { rc: { address }, setup: (w) => w.proof(address, 3) });
		}
		// A blank non-CHR load, on a listed and confirmed domain: the same answer, for one read.
		const nonChr = await refusedAlone("clause 2, a listed and confirmed domain that isn't the one", {
			opts: { domains: [DOMAIN, "example-broker.test"], confirmed: [DOMAIN, "example-broker.test"] }, rc: { address: "made-up.billing@example-broker.test" }, setup: (w) => w.proof("made-up.billing@example-broker.test", 3),
		});
		eq(nonChr.calls.gemini, 1, "§4 a blank non-CHR load costs one read");
		// 3. Confirmed, on the send list, not opted out: no engine call at all.
		await refusedAlone("clause 3, not on Confirmed broker domains", { opts: { confirmed: [] }, paid: false });
		await refusedAlone("clause 3, on the send list as another domain only", { opts: { domains: ["example-broker.test"] }, paid: false });
		await refusedAlone("clause 3, nothing on the send list", { opts: { domains: [] }, paid: false });
		await refusedAlone("clause 3, opted out", { opts: { optOut: [DOMAIN] }, paid: false });
		await refusedAlone("clause 3, sending off", { opts: { send: false }, paid: false });
		// 4. The exact address on invoices a person made for at least 3 loads.
		await refusedAlone("clause 4, no rows", { opts: { proofs: 0 } });
		await refusedAlone("clause 4 (N6): FAILS ON THE OLD CODE: five rows, all on one load", { opts: { proofs: 0 }, setup: (w) => w.proofOn(["LD-PROOF-A", "LD-PROOF-A", "ld-proof-a", "#LD-PROOF-A", "LD-PROOF-A"], ADDRESS) });
		await refusedAlone("clause 4 (N6): FAILS ON THE OLD CODE: four rows on two loads", { opts: { proofs: 0 }, setup: (w) => w.proofOn(["LD-PROOF-A", "LD-PROOF-A", "LD-PROOF-B", "LD-PROOF-B"], ADDRESS) });
		await refusedAlone("clause 4, only the job's sends: FAILS ON THE OLD CODE (L1)", { opts: { proofs: 0 }, setup: (w) => w.proof(ADDRESS, 5, rules.VIA_SEND) });
		await refusedAlone("clause 4, 2 of a person's loads and the job's send: FAILS ON THE OLD CODE (L1)", { opts: { proofs: 2 }, setup: (w) => w.proof(ADDRESS, 1, rules.VIA_SEND) });
		await refusedAlone("clause 4, 2 loads", { opts: { proofs: 2 } });
		await refusedAlone("clause 4, the rows on another address at the domain", { opts: { proofs: 0 }, setup: (w) => w.proof(AGENT, 5) });
		await refusedAlone("clause 4, only the job's own drafts", { opts: { proofs: 0 }, setup: (w) => w.proof(ADDRESS, 5, rules.VIA_DRAFT) });
		await refusedAlone("clause 4, only Triumph's rows", { opts: { proofs: 0 }, setup: (w) => w.proof(ADDRESS, 5, "triumph") });
		await refusedAlone("clause 4 (N6): FAILS ON THE OLD CODE: only rows with no via: nothing says a person made them", { opts: { proofs: 0 }, setup: (w) => w.proof(ADDRESS, 5, "") });
		await refusedAlone("clause 4, only rows with a via nothing writes", { opts: { proofs: 0 }, setup: (w) => w.proof(ADDRESS, 5, "made-up-script") });
		await refusedAlone("clause 4, 2 loads and one of the job's own drafts", { opts: { proofs: 2 }, setup: (w) => w.proof(ADDRESS, 1, rules.VIA_DRAFT) });
		// The plain path checks the domain only, so its sends can't vouch for an address: three
		// misreads there would otherwise earn the proof for a fourth on this path.
		{
			const w = makeWorld({ proofs: 0 });
			const job = await w.started();
			for (const id of ["LD-TEST-2001", "LD-TEST-2002", "LD-TEST-2003"]) {
				w.ready(id, { Email: `made-up.other@${DOMAIN}` }, { address: AGENT });
				await deliver(w, job, id);
			}
			eq(w.smtp.map((m) => m.to), [AGENT, AGENT, AGENT], "§4 three misreads on the plain path go out, on the domain's anchor alone, as they do today");
			eq(loadsTo(w.db, AGENT), 0, "§4 FAILS ON THE OLD CODE (L1): ...and earn no proof");
			w.ready("LD-TEST-2004", {}, { address: AGENT });
			await deliver(w, job, "LD-TEST-2004");
			eq([w.state("LD-TEST-2004"), w.smtp.length], [NEEDS_EMAIL, 3], "§4 FAILS ON THE OLD CODE (L1): a fourth misread on a blank load: Needs attention, nothing sent to the agent");
		}

		// A malformed cell isn't blank, whatever else holds.
		for (const cell of ["see rate con", "N/A", "-", "made-up.billing@", "@chrobinson.com", `Made Up <${ADDRESS}>`, `${ADDRESS}; ${AGENT}`]) {
			const w = makeWorld();
			const job = await w.started();
			w.ready(ID, { Email: cell });
			await deliver(w, job, ID);
			eq([w.state(ID), paidNothing(w), w.calls.prepare.length], [NEEDS_EMAIL, [0, 0, 0], 0], `§4 a malformed cell (${JSON.stringify(cell)}) isn't blank: NO_BROKER_EMAIL, no engine call`);
		}
	}

	// ===================================================================== §5
	section("§5 every other check applies unchanged");
	{
		const heldFor = async (label, wantState, { over = {}, rc = {}, setup = null, opts = {}, extra = {} } = {}) => {
			const w = makeWorld(opts);
			const job = await w.started(extra);
			w.ready(ID, over, rc);
			if (setup) setup(w);
			await deliver(w, job, ID);
			eq([w.state(ID), w.smtp.length], [wantState, 0], `§5 ${label}: ${wantState.join(" ")}, nothing sent`);
			return w;
		};
		await heldFor("the rate con's total and the sheet disagree", ["needs_attention", "TOTAL_MISMATCH"], { rc: { total: "$9,999.00" } });
		await heldFor("the strict sheet figure: a cell holding two amounts", ["needs_attention", "TOTAL_MISMATCH"], { over: { "  Payment  ": "1,000.00 / 1,100.00" } });
		await heldFor("no total read off the rate con", ["needs_attention", "RATECON_TOTAL_UNREAD"], { rc: { total: null } });
		await heldFor("a trailer that disagrees", ["needs_attention", "TRAILER_MISMATCH"], { rc: { trailer: "TR-999" } });
		await heldFor("a POD file that can't be read", ["needs_attention", "POD_UNREADABLE"], { setup: (w) => w.files.clear() });
		await heldFor("a POD with nothing the engine can read", ["needs_attention", "POD_UNREADABLE"], { setup: (w) => { for (const f of w.files) w.unreadable.add(f); } });
		await heldFor("one POD page the engine can't read", ["needs_attention", "POD_PAGE_UNREADABLE"], { setup: (w) => w.unreadable.add(w.addPod(ID)) });
		await heldFor("no POD", ["needs_attention", "WAITING_POD"], { setup: (w) => w.db.prepare("UPDATE documents SET deleted_at = '2026-10-20 13:30:00' WHERE type = 'POD'").run() });
		await heldFor("a closed month", ["needs_attention", "CLOSED_MONTH"], { setup: (w) => { w.closed = () => ["2026-10"]; } });
		await heldFor("no delivery date", ["needs_attention", "NO_DELIVERY_DATE"], { over: { "Completion Date": "" } });
		await heldFor("a factored load", ["skipped", "LOAD_FACTORED"], { setup: (w) => markFactored(w, ID) });
		await heldFor("a person's draft first", ["skipped", "DRAFTED_BY_HAND"], { setup: (w) => w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, via) VALUES (?, '10192026-7', ?, 'imap')").run(ID, ADDRESS) });
		await heldFor("over the hourly cap", ["needs_attention", "CAP_REACHED"], { opts: { env: { AUTO_INVOICE_MAX_PER_HOUR: "1" } }, setup: (w) => { ledger.insertClaim(w.db, { key: "ld-test-other", loadId: "LD-TEST-OTHER", state: "drafted", nowIso: iso(w.now) }); w.db.prepare("UPDATE auto_invoice_claims SET drafted_at = ? WHERE load_key = 'ld-test-other'").run(iso(w.now)); } });
		await heldFor("no mailbox", ["needs_attention", "NO_MAILBOX"], { extra: { mailbox: () => ({ user: "", pass: "" }) } });
		await heldFor("Gemini down: the outage's own code, not a broker's", ["needs_attention", "GEMINI_DOWN"], { setup: (w) => { w.geminiDown = true; } });
		await heldFor("Gemini seen down by ingestion", ["needs_attention", "GEMINI_DOWN"], { extra: { geminiUnavailableAt: () => T0 - MIN } });

		// Factoring is read last: marked during the build, the number given up.
		const late = await heldFor("factored during the build", ["skipped", "LOAD_FACTORED"], { setup: (w) => { w.renderHook = () => markFactored(w, ID); } });
		eq(late.claim(ID).number_voided_at !== "", true, "§5 ...its number given up");
		// A person's draft during the build wins.
		await heldFor("a person's draft during the build", ["skipped", "DRAFTED_BY_HAND"], { setup: (w) => { w.renderHook = () => w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, via) VALUES (?, '10192026-8', ?, 'imap')").run(ID, ADDRESS); } });

		// The Stop gives a draft, to the same one address, for a person to send.
		const stop = makeWorld();
		const sj = await stop.started();
		stop.ready(ID);
		ledger.setSendStop(stop.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(T0) });
		await deliver(stop, sj, ID);
		eq([stop.smtp.length, stop.appends.map((a) => a.to), stop.state(ID), stop.draftRow(ID).map((r) => r.via)], [0, [ADDRESS], ["drafted", ""], [rules.VIA_DRAFT]], "§5 the Stop: FAILS ON THE OLD CODE: a Gmail draft to the address, no SMTP call");
		// And that draft proves nothing: it doesn't add to the rows an address needs.
		eq(loadsTo(stop.db, ADDRESS), 3, "§5 FAILS ON THE OLD CODE: ...and that draft doesn't count as a row that proves the address");

		// Two loads tapped together run one at a time.
		const two = makeWorld();
		const tj = await two.started();
		two.ready("LD-TEST-1411");
		two.ready("LD-TEST-1412");
		let inFlight = 0;
		let most = 0;
		two.renderHook = async () => {
			inFlight++;
			most = Math.max(most, inFlight);
			await turn();
			inFlight--;
		};
		tap(two, tj, "LD-TEST-1411");
		tap(two, tj, "LD-TEST-1412");
		await drained(two, "§5 two loads");
		eq([two.smtp.length, most], [2, 1], "§5 FAILS ON THE OLD CODE: two blank-Email loads run in turn: one send each");
	}

	// ===================================================================== §6
	section("§6 no contact name anywhere");
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready(ID);
		await deliver(w, job, ID);
		const m = w.smtp[0] || {};
		eq(m.subject, `C.H. Robinson Order #${ID}`, "§6 FAILS ON THE OLD CODE: the subject names the broker from the address's domain");
		eq(namesOf(m)[0], `C.H. Robinson Invoice Order #${ID}.pdf`, "§6 FAILS ON THE OLD CODE: so does the invoice's file name");
		const pdf = m.attachments ? shownText(m.attachments[0].content) : "";
		ok(/C\.H\. Robinson/.test(pdf), "§6 FAILS ON THE OLD CODE: so does the invoice PDF");
		eq(w.draftRow(ID).map((r) => r.broker_name), ["C.H. Robinson"], "§6 FAILS ON THE OLD CODE: so does the row's broker_name");
		const claim = w.claim(ID);
		const audits = w.db.prepare("SELECT action, details FROM audit_trail").all();
		const everything = JSON.stringify([m.subject, m.html, namesOf(m), pdf, w.invoiceHtml, w.draftRow(ID), claim, audits, w.notices, w.logs]);
		eq(everything.includes(CONTACT), false, "§6 FAILS ON THE OLD CODE: the contact's name appears in no subject, body, file name, PDF, row, claim, audit line, notice or log");
		eq(everything.includes("Contactperson"), false, "§6 ...not even in part");
		ok(audits.some((a) => a.action === "auto_invoice_sent"), "§6 FAILS ON THE OLD CODE: and the audit rows are there to read");
		eq(everything.includes("Made-up Driver"), false, "§6 no driver's name either");

		// The same, on a draft under the Stop.
		const stop = makeWorld();
		const sj = await stop.started();
		stop.ready(ID);
		ledger.setSendStop(stop.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(T0) });
		await deliver(stop, sj, ID);
		eq(JSON.stringify([stop.appends, stop.invoiceHtml, stop.draftRow(ID)]).includes(CONTACT), false, "§6 FAILS ON THE OLD CODE: a draft under the Stop names no contact either");
		eq(stop.draftRow(ID).map((r) => r.broker_name), ["C.H. Robinson"], "§6 FAILS ON THE OLD CODE: ...and names the broker");
	}

	// ===================================================================== §7
	section("§7 a later fill with the same domain raises no change");
	{
		const sentWorld = async (over = {}) => {
			const w = makeWorld();
			const job = await w.started();
			w.ready(ID, over);
			await deliver(w, job, ID);
			eq(w.smtp.length, 1, "§7 FAILS ON THE OLD CODE: the invoice went");
			w.now += HOUR;
			return { w, job };
		};
		const changedAfter = async (w, job, email) => {
			w.setRow(ID, { Email: email });
			await job.checkClaims(rules.loadKey(ID));
			return [w.claim(ID).changed_fields, Boolean(ledger.getSendStop(w.db)), w.notices.length];
		};
		let s = await sentWorld();
		eq(await changedAfter(s.w, s.job, AGENT), ["", false, 0], "§7 FAILS ON THE OLD CODE: the Email filled in on the domain the invoice went to: no change, no notice, no stop");
		eq(await changedAfter(s.w, s.job, ADDRESS.toUpperCase()), ["", false, 0], "§7 FAILS ON THE OLD CODE: ...in any case");
		eq(await changedAfter(s.w, s.job, ""), ["", false, 0], "§7 FAILS ON THE OLD CODE: ...and blank again");
		s.w.setRow(ID, { Email: AGENT, "  Payment  ": "$1,100.00" });
		await s.job.checkClaims(rules.loadKey(ID));
		eq([s.w.claim(ID).changed_fields, Boolean(ledger.getSendStop(s.w.db))], ["payment", true], "§7 FAILS ON THE OLD CODE: a real change beside the fill still reads, without the fill: the stop, as today");

		s = await sentWorld();
		eq(await changedAfter(s.w, s.job, "ops@example-other.test"), ["brokerEmail", true, 2], "§7 FAILS ON THE OLD CODE: another domain: a change, the notice and the stop, as today");
		s = await sentWorld();
		eq((await changedAfter(s.w, s.job, `made-up.agent@mail.${DOMAIN}`)).slice(0, 2), ["brokerEmail", true], "§7 FAILS ON THE OLD CODE: a subdomain isn't the same domain");

		// Flag off afterward: the invoice already went, so the fill still isn't a change.
		s = await sentWorld();
		const later = s.w.job({ env: { ...s.w.env0, AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED: "false" } });
		later.startTrigger();
		await later.finishStartUp();
		eq(await changedAfter(s.w, later, AGENT), ["", false, 0], "§7 FAILS ON THE OLD CODE: with the flag off later: still no change");

		// A load sent with a filled Email keeps today's reading of every edit.
		const f = makeWorld();
		const fj = await f.started();
		f.ready(ID, { Email: AGENT });
		await deliver(f, fj, ID);
		f.now += HOUR;
		eq((await changedAfter(f, fj, `other.made-up@${DOMAIN}`)).slice(0, 2), ["brokerEmail", true], "§7 a filled Email changed on the same domain: a change, as today");
		const b = makeWorld();
		const bj = await b.started();
		b.ready(ID, { Email: AGENT });
		await deliver(b, bj, ID);
		b.now += HOUR;
		eq((await changedAfter(b, bj, "")).slice(0, 2), ["brokerEmail", true], "§7 a filled Email blanked: a change, as today");

		// Mark checked takes the fill in, so a later edit reads as any other.
		const mc = await sentWorld();
		mc.w.setRow(ID, { Email: AGENT });
		const f2 = fakeApp();
		mc.job.mount(f2.app, { requireRole: f2.requireRole });
		mc.w.setRow(ID, { "  Payment  ": "$1,100.00" });
		await mc.job.checkClaims(rules.loadKey(ID));
		eq((await f2.call("POST", "/api/auto-invoice/loads/:loadKey/checked", { params: { loadKey: rules.loadKey(ID) } })).status, 200, "§7 Mark checked");
		eq(jsonOf(mc.w.claim(ID).fingerprint_json).brokerEmail, AGENT, "§7 FAILS ON THE OLD CODE: ...takes the fill in");
		mc.w.now += HOUR;
		eq((await changedAfter(mc.w, mc.job, `other.made-up@${DOMAIN}`))[0], "brokerEmail", "§7 FAILS ON THE OLD CODE: ...and from then on an edit reads as any other");
	}

	// ===================================================================== §8
	section("§8 Try again's look and its confirm on this path (R-H2 (a))");
	{
		// Held on a total that disagrees; billed from Gmail with no press; the Payment corrected.
		const heldLoad = async (opts = {}) => {
			const w = makeWorld(opts);
			const job = await w.started();
			w.ready(ID, { "  Payment  ": "$900.00" });
			await deliver(w, job, ID);
			eq([w.state(ID), w.smtp.length], [["needs_attention", "TOTAL_MISMATCH"], 0], "§8 FAILS ON THE OLD CODE: held on the total, nothing sent");
			w.setRow(ID, { "  Payment  ": "$1,000.00" });
			w.now += MIN;
			return { w, job };
		};
		const pressed = async ({ w, job }) => {
			eq((await tryAgain(job, ID)).status, 200, "§8 Try again answers");
			await drained(w, "§8 Try again");
			await turn();
		};

		let t = await heldLoad();
		eq(retryOf(t.w, t.job, ID), "send", "§8 FAILS ON THE OLD CODE: the confirm says it can send, not that it makes a draft");
		t.w.lookAnswer = { verdict: "invoice", mailboxes: {} };
		await pressed(t);
		eq([t.w.state(ID), t.w.smtp.length, t.w.appends.length, t.w.calls.mint, t.w.calls.look.length], [["needs_attention", "MAILBOX_HIT"], 0, 0, 0, 1],
			"§8 FAILS ON THE OLD DESIGN (R-H2 (a)): billed from Gmail with no press: the look runs on a load with no sheet domain, and CHR gets no second invoice");
		const firstLook = t.w.calls.look[0] || {};
		eq([firstLook.loadNumber, firstLook.lastCheck], [ID, true], "§8 FAILS ON THE OLD CODE: ...searched by the load number, as the send's last look");
		t.w.lookAnswer = { verdict: "mention", mailboxes: {} };
		await pressed(t);
		eq([t.w.state(ID), t.w.smtp.length], [["needs_attention", "MAILBOX_HIT"], 0], "§8 FAILS ON THE OLD DESIGN: a mention is doubt: nothing sent");

		t = await heldLoad();
		t.w.lookFails = true;
		await pressed(t);
		eq([t.w.state(ID), t.w.smtp.length, t.w.calls.mint], [["needs_attention", "MAILBOX_UNREAD"], 0, 0], "§8 FAILS ON THE OLD DESIGN: a failed search: nothing sent, no number");

		t = await heldLoad();
		t.w.payments.push([ID, "Example", "1000", "", "", "Paid"]);
		await pressed(t);
		eq([t.w.state(ID), t.w.smtp.length, t.w.calls.mint], [["needs_attention", "PAYMENTS_TABLE_HIT"], 0, 0], "§8 FAILS ON THE OLD DESIGN: a filled Payments Table row: nothing sent, no number");

		t = await heldLoad();
		await pressed(t);
		eq([t.w.state(ID), t.w.smtp.map((m) => m.to), t.w.calls.look.length, t.w.calls.payments, t.w.claim(ID).look_first], [["drafted", ""], [ADDRESS], 1, 1, ""], "§8 FAILS ON THE OLD CODE: both clean: one send, to the address, the look cleared");

		// A restart between the press and the run: the claim still asks for the look.
		const r = makeWorld();
		await r.started();
		r.ready(ID, { "Job Status": "Delivered" });
		ledger.insertClaim(r.db, { key: rules.loadKey(ID), loadId: ID, state: "queued", nowIso: iso(r.now) });
		r.db.prepare("UPDATE auto_invoice_claims SET look_first = ? WHERE load_key = ?").run(iso(r.now), rules.loadKey(ID));
		r.lookAnswer = { verdict: "invoice", mailboxes: {} };
		const next = r.job();
		next.startTrigger();
		await next.finishStartUp();
		await drained(r, "§8 restart");
		await turn();
		eq([r.state(ID), r.smtp.length, r.calls.look.length], [["needs_attention", "MAILBOX_HIT"], 0, 1], "§8 FAILS ON THE OLD DESIGN: across a restart: the look still runs first");

		// An old NO_BROKER_EMAIL claim gets the same look.
		const old = makeWorld();
		const oj = await old.started();
		old.ready(ID, { "Job Status": "Delivered" });
		ledger.insertClaim(old.db, { key: rules.loadKey(ID), loadId: ID, state: "needs_attention", code: "NO_BROKER_EMAIL", nowIso: iso(old.now) });
		eq(retryOf(old, oj, ID), "send", "§8 FAILS ON THE OLD CODE: an old held load's confirm says it can send");
		old.lookAnswer = { verdict: "invoice", mailboxes: {} };
		await pressed({ w: old, job: oj });
		eq([old.state(ID), old.smtp.length], [["needs_attention", "MAILBOX_HIT"], 0], "§8 FAILS ON THE OLD DESIGN: ...and the same look first");

		// A stale tap on a row already Delivered: a person may have billed it from Gmail with no
		// press since the claim stopped. The re-armed claim gets the look a press would.
		const reArmed = async (over = {}, setup = null) => {
			const w = makeWorld();
			const job = await w.started();
			w.ready(ID, { "Job Status": "Delivered", ...over });
			ledger.insertClaim(w.db, { key: rules.loadKey(ID), loadId: ID, state: "waiting", code: "NOT_COMPLETED", nowIso: iso(w.now) });
			if (setup) setup(w);
			return { w, job };
		};
		for (const [label, over] of [["a blank Email", {}], ["a filled Email", { Email: AGENT }]]) {
			let s = await reArmed(over, (w) => { w.lookAnswer = { verdict: "invoice", mailboxes: {} }; });
			await deliver(s.w, s.job, ID);
			eq([s.w.state(ID), s.w.smtp.length, s.w.calls.mint, s.w.calls.look.length], [["needs_attention", "MAILBOX_HIT"], 0, 0, 1], `§8 FAILS ON THE OLD CODE (L3): ${label}, a stale tap re-arms the claim, the mailbox holds an invoice: no second invoice`);
			s = await reArmed(over, (w) => { w.lookFails = true; });
			await deliver(s.w, s.job, ID);
			eq([s.w.state(ID), s.w.smtp.length, s.w.calls.mint, Boolean(s.w.claim(ID).look_first)], [["needs_attention", "MAILBOX_UNREAD"], 0, 0, true], `§8 FAILS ON THE OLD CODE (L3): ${label}, the look fails: MAILBOX_UNREAD, no send, no number, the look still asked for`);
			s.w.lookFails = false;
			eq((await tryAgain(s.job, ID)).status, 200, `§8 ${label}: ...a person's Try again`);
			await drained(s.w, "§8 after a failed look");
			await turn();
			eq([s.w.state(ID), s.w.smtp.length], [["drafted", ""], 1], `§8 FAILS ON THE OLD CODE (L3): ${label}: ...looks again, and sends once it reads clean`);
			s = await reArmed(over, (w) => { w.paymentsFail = true; });
			await deliver(s.w, s.job, ID);
			eq([s.w.state(ID), s.w.smtp.length, s.w.calls.mint], [["needs_attention", "PAYMENTS_UNREAD"], 0, 0], `§8 FAILS ON THE OLD CODE (N5): ${label}, a re-armed claim, the Payments Table can't be read: no send, no number`);
			s = await reArmed(over, (w) => { w.payments.push([ID, "Example", "1000", "", "", "Paid"]); });
			await deliver(s.w, s.job, ID);
			eq([s.w.state(ID), s.w.smtp.length], [["needs_attention", "PAYMENTS_TABLE_HIT"], 0], `§8 FAILS ON THE OLD CODE (L3): ${label}, a filled Payments Table row: no send`);
			s = await reArmed(over);
			await deliver(s.w, s.job, ID);
			eq([s.w.state(ID), s.w.smtp.length, s.w.calls.look.length, s.w.claim(ID).look_first], [["drafted", ""], 1, 1, ""], `§8 FAILS ON THE OLD CODE (L3): ${label}, all clean: one look, one send, the look cleared`);
		}
		// The claim itself asks, so a restart between the tap and the run can't lose the look.
		{
			const { w, job } = await reArmed({}, (x) => { x.lookAnswer = { verdict: "invoice", mailboxes: {} }; });
			job.driverDelivered({ role: "Driver", loadId: ID, oldStatus: "Delivered", newStatus: "Delivered", readBack: async () => "Delivered" });
			ok(w.claim(ID).look_first, "§8 FAILS ON THE OLD CODE (L3): the re-armed claim itself asks for the look");
			eq(w.state(ID), ["waiting", "DRIVER_PENDING"], "§8 ...its write not yet answered");
			const next = w.job();
			next.startTrigger();
			await next.finishStartUp();
			await drained(w, "§8 re-armed, then a restart");
			await turn();
			eq([w.state(ID), w.smtp.length], [["needs_attention", "MAILBOX_HIT"], 0], "§8 FAILS ON THE OLD CODE (L3): ...across a restart: the look still runs first");
		}

		// A record that outlives a restart under an hour old is re-queued with no tap and no
		// press: a person may have billed it from Gmail meanwhile, so it gets the same look.
		const atRestart = async (over, fields, setup = null) => {
			const w = makeWorld();
			await w.started();
			w.ready(ID, { "Job Status": "Delivered", ...over });
			const { state, code = "", ...rest } = fields;
			ledger.insertClaim(w.db, { key: rules.loadKey(ID), loadId: ID, state, code, nowIso: iso(w.now) });
			const cols = Object.keys(rest);
			if (cols.length) w.db.prepare(`UPDATE auto_invoice_claims SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE load_key = ?`).run(...cols.map((c) => rest[c]), rules.loadKey(ID));
			if (setup) setup(w);
			const next = w.job();
			next.startTrigger();
			await next.finishStartUp();
			await drained(w, "§8 the restart");
			await turn();
			return { w, next };
		};
		const CAUGHT = { state: "working", lease_owner: "old-process", lease_until: iso(T0 + HOUR) };
		const NUMBER_HELD = { invoice_id: "10202026-77", invoice_date: "2026-10-20", reserved_at: iso(T0 - MIN), message_id: "<made-up-held.auto-invoice@example.com>" };
		for (const [email, over] of [["a blank Email", {}], ["a filled Email", { Email: AGENT }]]) {
			for (const [label, fields] of [
				["a queued claim", { state: "queued" }],
				["a DRIVER_PENDING record", { state: "waiting", code: "DRIVER_PENDING" }],
				["a claim caught building", CAUGHT],
				["a claim caught building, its number held", { ...CAUGHT, ...NUMBER_HELD, stage: "reserved" }],
				["a draft in flight, absent from Gmail", { ...CAUGHT, ...NUMBER_HELD, stage: "appending", sent_json: JSON.stringify({ to: ADDRESS, subject: "Made-up", total: "$1,000.00" }) }],
			]) {
				const named = `§8 FAILS ON THE OLD CODE: ${email}, ${label} at a restart`;
				let s = await atRestart(over, fields, (w) => { w.lookAnswer = { verdict: "invoice", mailboxes: {} }; });
				eq([s.w.state(ID), s.w.smtp.length, s.w.appends.length, s.w.calls.mint, s.w.calls.look.length], [["needs_attention", "MAILBOX_HIT"], 0, 0, 0, 1], `${named}, the mailbox holds an invoice: no second invoice, no number`);
				s = await atRestart(over, fields, (w) => { w.lookFails = true; });
				eq([s.w.state(ID), s.w.smtp.length, s.w.appends.length, s.w.calls.mint, Boolean(s.w.claim(ID).look_first)], [["needs_attention", "MAILBOX_UNREAD"], 0, 0, 0, true], `${named}, the look fails: MAILBOX_UNREAD, no send, no number, the look still asked for`);
				s = await atRestart(over, fields, (w) => { w.paymentsFail = true; });
				eq([s.w.state(ID), s.w.smtp.length, s.w.appends.length, s.w.calls.mint], [["needs_attention", "PAYMENTS_UNREAD"], 0, 0, 0], `${named}, the Payments Table can't be read (N5): no send, no number`);
				s = await atRestart(over, fields, (w) => { w.payments.push([ID, "Example", "1000", "", "", "Paid"]); });
				eq([s.w.state(ID), s.w.smtp.length], [["needs_attention", "PAYMENTS_TABLE_HIT"], 0], `${named}, a filled Payments Table row: no send`);
				s = await atRestart(over, fields);
				eq([s.w.state(ID), s.w.smtp.length, s.w.appends.length, s.w.calls.look.length, s.w.claim(ID).look_first], [["drafted", ""], 1, 0, 1, ""], `${named}, all clean: no load is lost: one look, one send, the look cleared`);
			}
		}

		// What the confirm says when this path isn't open.
		const confirm = async (over, opts = {}, setup = null) => {
			const w = makeWorld(opts);
			const job = await w.started();
			w.ready(ID, { "Job Status": "Delivered", ...over });
			ledger.insertClaim(w.db, { key: rules.loadKey(ID), loadId: ID, state: "needs_attention", code: "NO_BROKER_EMAIL", nowIso: iso(w.now) });
			if (setup) setup(w);
			return retryOf(w, job, ID);
		};
		eq(await confirm({ Email: "see rate con" }), "draft", "§8 a malformed cell: the confirm doesn't promise a send");
		eq(await confirm({}, { env: { AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED: "off" } }), "draft", "§8 the flag off: nor does a blank cell");
		eq(await confirm({}, { domains: [] }), "draft", "§8 not on the send list");
		eq(await confirm({}, { confirmed: [] }), "draft", "§8 not confirmed");
		eq(await confirm({}, { optOut: [DOMAIN] }), "draft", "§8 opted out");
		eq(await confirm({}, {}, (w) => ledger.setSendStop(w.db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(T0) })), "draft", "§8 the Stop: a draft");
		eq(await confirm({ Email: AGENT }), "send", "§8 a filled Email on the send list: as before");
		const noCol = makeWorld({ headers: HEADERS.filter((h) => h !== "Email") });
		const nc = await noCol.started();
		noCol.ready(ID, { "Job Status": "Delivered" });
		ledger.insertClaim(noCol.db, { key: rules.loadKey(ID), loadId: ID, state: "needs_attention", code: "NO_BROKER_EMAIL", nowIso: iso(noCol.now) });
		eq(retryOf(noCol, nc, ID), "draft", "§8 no Email column: no promise");
	}

	// ===================================================================== §9
	section("§9 outside the driver's trigger the flag is ignored");
	{
		// The sweep, the flag named nowhere: a blank Email is a person, with no engine call.
		const OFF = { AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false" };
		const w = makeWorld({ env: OFF });
		const job = w.job();
		eq(job.triggerMode, false, "§9 the sweep");
		await job.tick();
		w.ready(ID, { "Job Status": "Delivered" });
		w.now += 5 * MIN;
		await job.tick();
		eq([w.state(ID), w.calls.prepare.length, paidNothing(w)], [NEEDS_EMAIL, 0, [0, 0, 0]], "§9 the sweep: NO_BROKER_EMAIL, no engine call, the flag named nowhere");
		// Try again there, too.
		eq((await tryAgain(job, ID)).status, 200, "§9 the sweep's Try again");
		w.now += 5 * MIN;
		await job.tick();
		eq([w.state(ID), w.calls.prepare.length, w.smtp.length], [NEEDS_EMAIL, 0, 0], "§9 ...the same answer");
		// The flag set to on explicitly changes nothing there.
		const on = makeWorld({ env: { ...OFF, AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED: "true" } });
		const onJob = on.job();
		await onJob.tick();
		on.ready(ID, { "Job Status": "Delivered" });
		on.now += 5 * MIN;
		await onJob.tick();
		eq([on.state(ID), on.calls.prepare.length], [NEEDS_EMAIL, 0], "§9 the sweep, the flag set to true: ignored");

		// The sweep's own recovery stays as it was: the start-up look belongs to the driver's trigger.
		const swept = makeWorld({ env: OFF });
		const sweptJob = swept.job();
		await sweptJob.tick();
		swept.ready(ID, { Email: AGENT, "Job Status": "Delivered" });
		ledger.insertClaim(swept.db, { key: rules.loadKey(ID), loadId: ID, state: "working", nowIso: iso(swept.now) });
		swept.db.prepare("UPDATE auto_invoice_claims SET lease_owner = 'old-process', lease_until = ? WHERE load_key = ?").run(iso(T0 - HOUR), rules.loadKey(ID));
		swept.now += 5 * MIN;
		await sweptJob.tick();
		eq([swept.state(ID), swept.smtp.length, swept.calls.look.length, swept.calls.payments, swept.claim(ID).look_first], [["drafted", ""], 1, 0, 0, ""], "§9 the sweep's recovery of a claim caught building: no look asked for, one send, as before");

		// Shadow mode records what it always did.
		const shadow = makeWorld({ env: { AUTO_INVOICE_DRAFTS_SHADOW: "" } });
		const sj = shadow.job();
		eq(sj.mode, "shadow", "§9 shadow");
		await sj.tick();
		shadow.ready(ID, { "Job Status": "Delivered" });
		shadow.now += 5 * MIN;
		await sj.tick();
		const sh = ledger.getShadow(shadow.db, rules.loadKey(ID));
		eq([sh.verdict, sh.reason_code, shadow.calls.prepare.length], ["WOULD_NEED_ATTENTION", "NO_BROKER_EMAIL", 0], "§9 shadow: NO_BROKER_EMAIL, no engine call");

		// The kill switch, with the trigger on.
		for (const v of ["false", "0", "no", "OFF"]) {
			const x = makeWorld({ env: { AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED: v } });
			const j = await x.started();
			x.ready(ID);
			await deliver(x, j, ID);
			eq([x.state(ID), x.calls.prepare.length, paidNothing(x)], [NEEDS_EMAIL, 0, [0, 0, 0]], `§9 AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED=${v}: every blank Email is a person, as before, with no engine call`);
		}
		// Only the driver: an office role's Delivered still starts nothing.
		const office = makeWorld();
		const ofj = await office.started();
		office.ready(ID);
		tap(office, ofj, ID, "Dispatcher");
		await turn();
		await turn();
		eq([office.state(ID), office.smtp.length, office.calls.prepare.length], [null, 0, 0], "§9 a Dispatcher's Delivered on a blank load: no record, nothing sent");
	}

	// ===================================================================== §10
	section("§10 it can't send twice");
	{
		const w = makeWorld();
		const job = await w.started();
		w.ready(ID);
		await deliver(w, job, ID);
		eq(w.smtp.length, 1, "§10 FAILS ON THE OLD CODE: one send");
		tap(w, job, ID);
		await drained(w, "§10 repeat tap");
		await turn();
		eq(w.smtp.length, 1, "§10 a repeat tap: nothing more");
		const next = w.job();
		next.startTrigger();
		await next.finishStartUp();
		await drained(w, "§10 restart");
		await turn();
		eq(w.smtp.length, 1, "§10 a restart: nothing more");
		eq((await tryAgain(next, ID)).status, 409, "§10 Try again on a load sent: refused");
		const press = next.draftButtonCheck({ session: { user: { username: "made-up-admin" } }, body: {} }, ID);
		eq([press.ok, press.http, (press.json || {}).code], [false, 409, "INVOICE_ALREADY_SENT"], "§10 FAILS ON THE OLD CODE: a person's Draft Invoice: refused, as for any load the job sent");

		// A row that wasn't written: Try again records through the same path, never a second send.
		const lost = makeWorld();
		const lj = await lost.started();
		lost.ready(ID);
		lost.recordThrowsOnce = true;
		await deliver(lost, lj, ID);
		eq([lost.state(ID), lost.smtp.length, lost.draftRow(ID).length], [["needs_attention", "IN_GMAIL_UNRECORDED"], 1, 0], "§10 FAILS ON THE OLD CODE: sent, its row not written: a person, one SMTP call");
		eq((await tryAgain(lj, ID)).status, 200, "§10 Try again");
		await drained(lost, "§10 recording");
		await turn();
		eq([lost.state(ID), lost.smtp.length, lost.draftRow(ID).map((r) => r.via), lost.calls.look.length], [["drafted", ""], 1, ["auto-smtp"], 0], "§10 FAILS ON THE OLD CODE: ...rebuilt through the blank path and recorded: still one SMTP call");
		// The same with the flag turned off meanwhile: a person again, nothing sent.
		const lost2 = makeWorld();
		const l2 = await lost2.started();
		lost2.ready(ID);
		lost2.recordThrowsOnce = true;
		await deliver(lost2, l2, ID);
		const offNow = lost2.job({ env: { ...lost2.env0, AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED: "false" } });
		offNow.startTrigger();
		await offNow.finishStartUp();
		eq((await tryAgain(offNow, ID)).status, 200, "§10 Try again with the flag off");
		await drained(lost2, "§10 recording, flag off");
		await turn();
		eq([lost2.state(ID), lost2.smtp.length], [["needs_attention", "IN_GMAIL_UNRECORDED"], 1], "§10 FAILS ON THE OLD CODE: ...the rebuild is refused: a person, still one SMTP call");

		// A restart with the send in flight. The stand-in never answers, so the old process stays
		// inside its SMTP call and only the new one moves the claim.
		const inFlight = (w, { sent = false } = {}) => (o) => {
			w.smtp.push(o);
			if (sent) w.sent.push(o.messageId);
			return new Promise(() => {});
		};
		const pressed = (job) => {
			const p = job.draftButtonCheck({ session: { user: { username: "made-up-admin" } }, body: {} }, ID);
			return [p.ok, p.http, (p.json || {}).code];
		};
		const restartMidSend = async (w, env = null) => {
			await until(() => w.smtp.length === 1, "§10 the send started");
			const atCrash = w.claim(ID);
			const next = env ? w.job({ env }) : w.job();
			next.startTrigger();
			await next.finishStartUp();
			await drained(w, "§10 the restart");
			await turn();
			return { next, atCrash };
		};
		// The Sent copy found: recorded through the blank path's rebuild, and never sent again.
		{
			const x = makeWorld();
			const a = await x.started({ sendMail: inFlight(x, { sent: true }) });
			x.ready(ID);
			tap(x, a, ID);
			const { next: b, atCrash } = await restartMidSend(x);
			eq([atCrash.state, atCrash.stage, atCrash.delivery], ["working", "appending", "send"], "§10 FAILS ON THE OLD CODE: the send started, and the app restarts with it in flight");
			eq([x.state(ID), x.smtp.length, x.appends.length, x.draftRow(ID).map((r) => r.via), x.calls.mint], [["drafted", ""], 1, 0, ["auto-smtp"], 1], "§10 FAILS ON THE OLD CODE: the Sent copy is found: recorded through the blank path, one SMTP call, one number");
			eq(pressed(b), [false, 409, "INVOICE_ALREADY_SENT"], "§10 FAILS ON THE OLD CODE: ...a person's Draft Invoice: refused");
		}
		// No Sent copy: a person, the stop, and Try again only searches.
		{
			const x = makeWorld();
			const a = await x.started({ sendMail: inFlight(x) });
			x.ready(ID);
			tap(x, a, ID);
			const { next: b } = await restartMidSend(x);
			eq([x.state(ID), x.smtp.length, Boolean(ledger.getSendStop(x.db))], [["needs_attention", "MAYBE_SENT"], 1, true], "§10 FAILS ON THE OLD CODE: no Sent copy: MAYBE_SENT and the stop, one SMTP call");
			eq((await tryAgain(b, ID)).status, 200, "§10 FAILS ON THE OLD CODE: ...a person's Try again is taken");
			await drained(x, "§10 Try again on a send that started");
			await turn();
			eq([x.state(ID), x.smtp.length, x.appends.length, x.calls.look.length, pressed(b)], [["needs_attention", "MAYBE_SENT"], 1, 0, 0, [false, 409, "INVOICE_ALREADY_SENT"]], "§10 FAILS ON THE OLD CODE: ...it only searches again: still one SMTP call, no draft, the button refused");
		}
		// The kill switch set in the restart that catches the send: never a second one.
		{
			const x = makeWorld();
			const a = await x.started({ sendMail: inFlight(x, { sent: true }) });
			x.ready(ID);
			tap(x, a, ID);
			const { next: b } = await restartMidSend(x, { ...x.env0, AUTO_INVOICE_BLANK_EMAIL_CHR_ENABLED: "false" });
			eq([x.state(ID), x.smtp.length, x.appends.length, pressed(b)], [["needs_attention", "IN_GMAIL_UNRECORDED"], 1, 0, [false, 409, "INVOICE_ALREADY_SENT"]], "§10 FAILS ON THE OLD CODE: the flag off in that restart: the rebuild is refused, a person, still one SMTP call");
		}

		// The deploy itself sends nothing: a load already held stays held until a person presses.
		const old = makeWorld();
		await old.started();
		old.ready(ID, { "Job Status": "Delivered" });
		ledger.insertClaim(old.db, { key: rules.loadKey(ID), loadId: ID, state: "needs_attention", code: "NO_BROKER_EMAIL", nowIso: iso(old.now) });
		old.ready("LD-TEST-1421", { "Job Status": "Delivered" });
		const deployed = old.job();
		deployed.startTrigger();
		await deployed.finishStartUp();
		await drained(old, "§10 the deploy");
		await turn();
		eq([old.state(ID), old.claim("LD-TEST-1421"), paidNothing(old), old.calls.prepare.length], [NEEDS_EMAIL, null, [0, 0, 0], 0], "§10 a start-up with the flag on: a held blank load stays held, a completed one with no claim gets none: nothing built, numbered or sent");
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
