#!/usr/bin/env node
// scripts/data-fix-auto-invoice-mark-sent.js: the one-time fix that records as sent the
// automatic invoice drafts a person sent by hand from Gmail. Made-up loads drafted (and one
// sent) by the real job (lib/auto-invoice-job.js) into a scratch database under the temp
// directory, with a made-up engine and Gmail. The cases:
//   §0  the story the cases start from, as the job left it
//   §1  the dry run (the default): per load its claim, what would change and the audit row it
//       would write, then the counts; the database file and every table as they were
//   §2  --apply moves exactly the named claims: delivery 'send', stage 'recorded', sent_at the
//       given time; every other column as it was (updated_at stamped); every other claim and
//       every other table byte for byte
//   §3  after it: claimSent() is true, Completed Loads reads "Sent to the broker" (the server's
//       answer through the client's chip; a load changed since its draft keeps its changed
//       fields and reads "Sent to the broker: load changed"), and Draft Invoice asks for a
//       re-issue reason before another invoice
//   §4  one audit row per changed claim, a system change; the rows already there as they were
//   §5  a replay writes nothing: each load "already done", no new row, every table as it was
//   §6  a claim not in exactly the job's recorded-draft shape is skipped and printed with its
//       state, nothing written for it, exit 3, and the other load named still moves
//   §7  refused before anything is written (exit 2): no --load, a bad or future time, no --db,
//       no note, a load named twice, both modes, an unknown argument, a database that isn't
//       there or sits outside the app directory and the temp directory, one with no claims
//   §8  --apply only with the rule that holds a sent load alone on a later change: refused when
//       the checkout has no such rule or the app's settings switch it off; the dry run says so
//   §9  the command line: the dry run is the default; exit codes; --apply follows this checkout
// Made-up data only, in a fresh temp folder; no network.
//   node scripts/test-data-fix-auto-invoice-mark-sent.js      # exits 1 on any failure
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SCRIPT_FILE = path.join(ROOT, "scripts", "data-fix-auto-invoice-mark-sent.js");
// Absent from a tree before the script: every section then fails by name.
let fix = null;
let loadError = "";
if (fs.existsSync(SCRIPT_FILE)) {
	try {
		fix = require(SCRIPT_FILE);
	} catch (e) {
		loadError = (e && e.message) || String(e);
	}
}
const jobLib = require(path.join(ROOT, "lib", "auto-invoice-job.js"));
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const ledgerLib = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const sendLib = require(path.join(ROOT, "lib", "auto-invoice-send.js"));
const factoring = require(path.join(ROOT, "lib", "factoring-store.js"));
const imapDraft = require(path.join(ROOT, "lib", "imap-draft.js"));
const { liftSheetHelpers } = require(path.join(ROOT, "scripts", "auto-invoice-shadow-report.js"));
const { textPdf } = require(path.join(ROOT, "scripts", "lib", "made-up-pdf.js"));
const SRC = require(path.join(ROOT, "scripts", "lib", "server-source.js")).serverSource();
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
// The script's clock: two days after the drafts.
const NOW = Date.parse("2026-10-22T06:00:00Z");
const ET = "America/New_York";
const UPLOADS = path.join(path.sep, "made-up", "uploads");
const HEADERS = Object.freeze(["Load ID", "Trailer Number", "Driver", "Drop-off Appointment", "Job Status", "Broker Contact Name", "Email",
	"Status Update Date", "Completion Date", "  Payment  "]);
const SEND_DOMAIN = "example-broker.test";
const BISON_AP = "ap@example-bison-ap.test";
const MAILBOX = Object.freeze({ user: "drafts@example.com", pass: "made-up" });
const NOTE = "made-up note: each one sent from Gmail Drafts by a person";
// The three loads a person sent from Gmail, with the times Sent Mail shows.
const SENT = Object.freeze({ "LD-TEST-0901": "2026-10-20T17:12:06Z", "LD-TEST-0902": "2026-10-20T17:40:12Z", "LD-TEST-0903": "2026-10-21T09:05:44Z" });
const TARGETS = Object.freeze(Object.entries(SENT).map(([id, at]) => `${id}@${at}`));
const { sheetDayKey } = liftSheetHelpers();
let client = null; // client/src/lib/autoInvoiceStatus.js, imported in main()

const iso = (ms) => new Date(ms).toISOString();
const key = (id) => rules.loadKey(id);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const mimeOf = (o) => imapDraft.buildMime({ from: o.from, to: o.to, subject: o.subject, html: o.html, attachments: o.attachments, messageId: o.messageId });
const normalized = (t) => new Date(Date.parse(t)).toISOString();

// A table as server.js creates it, with the columns it adds afterwards.
function table(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\t\\)`));
	if (!m) throw new Error(`no CREATE TABLE ${name} in server.js`);
	const added = [...SRC.matchAll(new RegExp(`db\\.exec\\("(ALTER TABLE ${name} ADD COLUMN [^"]+)"\\)`, "g"))].map((a) => a[1]);
	return [m[0], ...added].join(";\n");
}

// ------------------------------------------------------------------ the world
function serverTables(db) {
	db.exec(`
		CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, driver TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
			file_name TEXT NOT NULL, drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_at DATETIME DEFAULT NULL);
		${table("load_invoice_drafts")};
		CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME, deleted_by TEXT DEFAULT '');
		CREATE TABLE broker_invoice_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, load_key TEXT NOT NULL, voided_at TEXT);
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
		CREATE TABLE bison_invoice_seq (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
		CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','reopened')), finalized_at TEXT NOT NULL,
			finalized_by TEXT NOT NULL DEFAULT 'system', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		${table("audit_trail")};
	`);
	factoring.ensureSchema(db);
	db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?)")
		.run(JSON.stringify({ optOutDomains: [], confirmedBrokerDomains: [SEND_DOMAIN] }));
}

// Messages in a made-up mailbox: Message-ID -> { raw, at }.
function findIn(w, messageId, boxes) {
	for (const box of boxes) {
		const held = box === "[Gmail]/Drafts" ? w.drafts : box === sendLib.SENT_MAILBOX ? w.sentBox : null;
		if (held && held.has(messageId)) return { found: true, count: 1, mailbox: box };
	}
	return { found: false, count: 0, mailbox: "" };
}

function world(file) {
	const w = { now: T0, rows: [], files: new Set(), rateCons: new Map(), drafts: new Map(), sentBox: new Map(), ids: 0 };
	w.db = new Database(file);
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
	w.pod = (id, uploadedAt) => {
		const name = `pod-${key(id)}-${w.files.size}.pdf`;
		w.db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'POD', ?, ?, ?)").run(id, name, `/uploads/${name}`, uploadedAt);
		w.files.add(name);
	};
	// A load ready to invoice: delivered, its POD on file, a rate con naming a billing email on
	// the broker's own domain.
	w.ready = (id) => {
		w.setRow(id);
		w.pod(id, "2026-10-20 13:00:00");
		w.rateCons.set(key(id), `billing@${SEND_DOMAIN}`);
	};
	w.handDraft = (id) => w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by, created_at) VALUES (?, '10202026-50', ?, 'ratecon', 'imap', 'made-up-admin', ?)")
		.run(id, `billing@${SEND_DOMAIN}`, iso(w.now).replace(/\.\d{3}Z$/, "Z"));
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
		// The engine's shapes: the invoice PDF first (its number, date and total printed),
		// then the POD and the rate con.
		async render(ctx, opts) {
			const row = w.rows.find((r) => key(r["Load ID"]) === key(ctx.loadId)) || {};
			const ref = String(ctx.loadId).replace(/^#/, "");
			const total = row["  Payment  "] || "$1,000.00";
			const [y, m, d] = String(opts.invoiceDate).split("-");
			const printed = `INVOICE Invoice ID # : ${opts.invoiceId} Date: ${m}/${d}/${y} Made-up Co. Invoice To Example Broker ${ctx.to} Load ID# Delivery Date Total Example Broker Order: #${ref} 10/20/2026 ${total} SUB-TOTAL ${total} Total ${total}`;
			return {
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
		},
		async record(ctx, rendered, opts) {
			const r = w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', ?, ?)")
				.run(ctx.loadId, opts.invoiceId, rendered.to, opts.via, opts.actor.username);
			return { recorded: true, draftRowId: Number(r.lastInsertRowid) };
		},
	};
	w.jobDeps = ({ db = w.db, sendOn = false } = {}) => ({
		db,
		env: { AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false", AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: "false",
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
			return `${day}-${db.prepare("INSERT INTO bison_invoice_seq (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 RETURNING n").get(day).n}`;
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
	return w;
}

const pending = (db) => db.prepare("SELECT COUNT(*) AS n FROM auto_invoice_claims WHERE state IN ('queued', 'waiting', 'working')").get().n;
async function settle(w, job) {
	let ticks = 0;
	do {
		await job.tick();
		w.now += 5 * MIN;
	} while (pending(w.db) && ++ticks < 12);
}

// The story, on the job's clock:
//   T0      the job's baseline: LD-TEST-0900, delivered before it, is left to people
//   T0+5m   LD-TEST-0901..0904, 0907, 0908 delivered and drafted by the job, sending off
//   then    a person drafts LD-TEST-0907 by hand too; a POD added to LD-TEST-0903 after its
//           draft is seen by the job (changed: pods)
//   then    LD-TEST-0905 delivered and sent by the job itself (sending on, its domain listed)
//   last    LD-TEST-0906 delivered with no POD: waiting
let STORY = null;
async function buildStory() {
	const dir = fs.mkdtempSync(path.join(BASE, "story-"));
	const file = path.join(dir, "app.db");
	const w = world(file);
	w.setRow("LD-TEST-0900");
	let job = jobLib.create(w.jobDeps());
	await job.tick();
	w.now += 5 * MIN;
	for (const id of ["LD-TEST-0901", "LD-TEST-0902", "LD-TEST-0903", "LD-TEST-0904", "LD-TEST-0907", "LD-TEST-0908"]) w.ready(id);
	await settle(w, job);
	w.handDraft("LD-TEST-0907");
	w.pod("LD-TEST-0903", "2026-10-20 15:10:00");
	await job.tick();
	w.now += 5 * MIN;
	job = jobLib.create(w.jobDeps({ sendOn: true }));
	w.ready("LD-TEST-0905");
	await settle(w, job);
	w.setRow("LD-TEST-0906");
	await job.tick();
	w.db.close();
	return { file, w };
}

// A fresh copy of the story's database, in its own folder under the temp directory.
function copyStory() {
	const file = path.join(fs.mkdtempSync(path.join(BASE, "case-")), "app.db");
	fs.copyFileSync(STORY.file, file);
	return file;
}
// A change to a case's own copy before the script runs.
function onCopy(file, fn) {
	const db = new Database(file);
	try {
		fn(db);
	} finally {
		db.close();
	}
}
const tablesOf = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
// Every table, row by row, as the file holds it.
function snapshot(file) {
	const db = new Database(file, { readonly: true, fileMustExist: true });
	try {
		const out = {};
		for (const t of tablesOf(db)) out[t] = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
		return out;
	} finally {
		db.close();
	}
}
const claimOf = (snap, id) => snap.auto_invoice_claims.find((c) => c.load_key === key(id)) || null;
const others = (snap, ids) => snap.auto_invoice_claims.filter((c) => !ids.map(key).includes(c.load_key));
const without = (snap, names) => Object.fromEntries(Object.entries(snap).filter(([t]) => !names.includes(t)));
const newAudit = (before, after) => after.audit_trail.filter((r) => !before.audit_trail.some((b) => b.id === r.id));
const fileSha = (file) => sha(fs.readFileSync(file));

async function runFix(argv, opts = {}) {
	const lines = [];
	const errs = [];
	let code;
	try {
		code = await fix.main(argv, { now: () => NOW, rules: RULES_ON, env: {}, log: (s) => lines.push(s), err: (s) => errs.push(s), ...opts });
	} catch (e) {
		code = `threw ${(e && e.message) || e}`;
	}
	return { code, out: lines.join("\n"), err: errs.join("\n") };
}
const argsFor = (file, targets, mode = []) => [`--db=${file}`, ...targets.map((t) => `--load=${t}`), `--note=${NOTE}`, ...mode];

// The checkout's rule that holds a sent load alone on a later change, on, off or absent.
const RULES_ON = { ...rules, holdOneLoadEnabled: () => true };
const RULES_OFF = { ...rules, holdOneLoadEnabled: () => false };
const RULES_ABSENT = { ...rules, holdOneLoadEnabled: undefined };

// What Completed Loads shows for a load: the server's answer and the client's chip, on a copy.
async function labelOf(file, id) {
	const copy = path.join(fs.mkdtempSync(path.join(BASE, "label-")), "app.db");
	fs.copyFileSync(file, copy);
	const db = new Database(copy);
	try {
		const job = jobLib.create(STORY.w.jobDeps({ db }));
		const row = { ...STORY.w.rows.find((r) => key(r["Load ID"]) === key(id)) };
		job.annotateCompletedRows({ rows: [row], headers: [...HEADERS], isSuperAdmin: true });
		const chip = client && row._autoInvoice ? client.autoInvoiceChip(row._autoInvoice) : null;
		const claim = ledgerLib.getClaim(db, key(id));
		const press = sendLib.buttonRefusal({ claim, sendEnabled: false, body: {} });
		return { claimSent: sendLib.claimSent(claim), sent: Boolean(row._autoInvoice && row._autoInvoice.sent), label: chip ? chip.label : "",
			press: press ? [press.ok, press.http, press.code] : null };
	} finally {
		db.close();
	}
}

const BASE = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mark-sent-"));

// ------------------------------------------------------------------ main
async function main() {
	client = await import(pathToFileURL(path.join(ROOT, "client", "src", "lib", "autoInvoiceStatus.js")).href);
	STORY = await buildStory();
	const missing = (n) => ok(fix && typeof fix.main === "function",
		`§${n} FAILS ON THE OLD CODE: scripts/data-fix-auto-invoice-mark-sent.js exists and exports main()${loadError ? ` (it threw: ${loadError})` : ""}`);

	// ---------------------------------------------------------------- §0
	section("§0  the story, as the job left it");
	{
		const s = snapshot(STORY.file);
		const shape = (id) => {
			const c = claimOf(s, id);
			return c ? [c.state, c.stage, c.delivery, c.sent_at === "" ? "" : "set", c.changed_fields, Boolean(c.invoice_id), imapDraft.MESSAGE_ID_RE.test(c.message_id)] : null;
		};
		eq(["LD-TEST-0901", "LD-TEST-0902", "LD-TEST-0904", "LD-TEST-0907", "LD-TEST-0908"].map(shape), Array(5).fill(["drafted", "recorded", "", "", "", true, true]),
			"§0 the job's drafts: drafted, stage recorded, no delivery, no sent time, an invoice number and the draft's Message-ID");
		eq(shape("LD-TEST-0903"), ["drafted", "recorded", "", "", "pods", true, true], "§0 LD-TEST-0903's POD added after its draft is on its claim (changed: pods)");
		eq(shape("LD-TEST-0905"), ["drafted", "recorded", "send", "set", "", true, true], "§0 LD-TEST-0905 was sent by the job itself");
		eq([claimOf(s, "LD-TEST-0906").state, claimOf(s, "LD-TEST-0906").reason_code, claimOf(s, "LD-TEST-0900").state], ["waiting", "WAITING_POD", "baseline"],
			"§0 LD-TEST-0906 waits for its POD; LD-TEST-0900 is the baseline's");
		eq(s.load_invoice_drafts.filter((r) => key(r.load_id) === key("LD-TEST-0907")).map((r) => r.via), ["auto-imap", "imap"], "§0 LD-TEST-0907 has a person's draft beside the job's");
		const labels = [];
		for (const id of ["LD-TEST-0901", "LD-TEST-0902", "LD-TEST-0903"]) labels.push((await labelOf(STORY.file, id)).label);
		eq(labels, ["Draft ready in Gmail", "Draft ready in Gmail", "Draft ready in Gmail: load changed"], "§0 Completed Loads reads the three as drafts in Gmail");
	}

	// ---------------------------------------------------------------- §1
	section("§1  the dry run (the default)");
	missing(1);
	if (fix) {
		const file = copyStory();
		const before = snapshot(file);
		const bytes = fileSha(file);
		const r = await runFix(argsFor(file, TARGETS));
		eq(r.code, 0, "§1 the dry run runs (exit 0)");
		ok(/^Data fix AUTO-INVOICE-SENT-BY-HAND: .*Mode: dry run \(nothing is written\)\.$/m.test(r.out), "§1 it says it is a dry run");
		ok(r.out.includes(`  database: ${file} (opened read-only)`), "§1 it names the database it opened, read-only");
		for (const [id, at] of Object.entries(SENT)) {
			const c = claimOf(before, id);
			const line = r.out.split("\n").find((l) => l.startsWith(`  ${c.load_id}: would change: `)) || "";
			ok(line.includes(`delivery '' -> 'send', sent_at '' -> ${normalized(at)} (stage recorded)`), `§1 ${id}: what would change, the given time as the ledger stores it`);
			ok(line.includes(`invoice ${c.invoice_id} to ${SEND_DOMAIN}`) && line.includes(`drafted ${c.drafted_at}`), `§1 ${id}: ...its invoice number, recipient domain and draft time`);
			ok(r.out.includes(`    audit row: auto_invoice_sent load ${c.load_id}: ${c.invoice_id} → ${SEND_DOMAIN} (recorded as sent by hand from Gmail at ${normalized(at)}: ${NOTE}) [AUTO-INVOICE-SENT-BY-HAND]`),
				`§1 ${id}: ...and the audit row it would write`);
		}
		ok((r.out.split("\n").find((l) => l.startsWith("  LD-TEST-0903: would change: ")) || "").includes("changed since the draft: pods"), "§1 a load changed since its draft says which fields");
		ok(r.out.endsWith("3 named: 3 would change, 0 skipped, 0 already done. Nothing written."), "§1 the counts");
		eq([fileSha(file) === bytes, JSON.stringify(snapshot(file)) === JSON.stringify(before)], [true, true], "§1 nothing written: the file and every table as they were");
		const explicit = await runFix(argsFor(file, TARGETS, ["--dry-run"]));
		eq([explicit.code, explicit.out === r.out, fileSha(file) === bytes], [0, true, true], "§1 --dry-run says the same and writes nothing");
	}

	// ---------------------------------------------------------------- §2-§5
	section("§2  --apply moves exactly the named claims");
	missing(2);
	let applied = null;
	if (fix) {
		const file = copyStory();
		const before = snapshot(file);
		const r = await runFix(argsFor(file, TARGETS, ["--apply"]));
		const after = snapshot(file);
		applied = { file, before, after, r };
		eq(r.code, 0, "§2 the apply runs (exit 0)");
		ok(r.out.includes(`  database: ${file} (opened for writing)`), "§2 it names the database it opened");
		for (const [id, at] of Object.entries(SENT)) {
			const was = claimOf(before, id);
			const now = claimOf(after, id);
			eq([now.state, now.stage, now.delivery, now.sent_at], ["drafted", "recorded", "send", normalized(at)], `§2 ${id}: drafted, stage recorded, delivery 'send', sent_at the given time`);
			eq({ ...now, delivery: was.delivery, sent_at: was.sent_at, updated_at: was.updated_at }, was, `§2 ${id}: every other column as it was (invoice number, Message-ID, draft row, fingerprint, changed fields)`);
			eq(now.updated_at, iso(NOW), `§2 ${id}: updated_at stamped by the ledger's move`);
			ok(r.out.includes(`  ${was.load_id}: changed: delivery '' -> 'send', sent_at '' -> ${normalized(at)} (stage recorded); one audit row.`), `§2 ${id}: the line says what changed`);
		}
		eq(others(after, Object.keys(SENT)), others(before, Object.keys(SENT)), "§2 every other claim byte for byte (the baseline's, a draft never named, the job's own send, a waiting load, a person's draft)");
		eq(without(after, ["auto_invoice_claims", "audit_trail"]), without(before, ["auto_invoice_claims", "audit_trail"]), "§2 every other table byte for byte (meta, shadow, drafts, documents, factoring, settings)");
		ok(r.out.endsWith("3 named: 3 changed, 0 skipped, 0 already done."), "§2 the counts");
		ok(Object.keys(SENT).every((id) => r.out.includes(`  read back: ${claimOf(before, id).load_id}: delivery send, stage recorded, sent_at ${normalized(SENT[id])}, sent: yes, its audit row: yes`)),
			"§2 each changed claim read back after the write");
	}

	section("§3  after it: sent, as Completed Loads and Draft Invoice read it");
	missing(3);
	if (applied) {
		const got = [];
		for (const id of Object.keys(SENT)) got.push(await labelOf(applied.file, id));
		eq(got.map((g) => g.claimSent), [true, true, true], "§3 claimSent() is true for each");
		eq(got.map((g) => [g.sent, g.label]), [[true, "Sent to the broker"], [true, "Sent to the broker"], [true, "Sent to the broker: load changed"]],
			"§3 Completed Loads reads \"Sent to the broker\" (the server's answer through the client's chip); the load changed since its draft keeps its changed fields");
		eq(got.map((g) => g.press), [[false, 409, "INVOICE_ALREADY_SENT"], [false, 409, "INVOICE_ALREADY_SENT"], [false, 409, "INVOICE_ALREADY_SENT"]],
			"§3 Draft Invoice asks for a re-issue reason before another invoice (409 INVOICE_ALREADY_SENT)");
		eq((await labelOf(applied.file, "LD-TEST-0904")).label, "Draft ready in Gmail", "§3 a draft not named still reads as a draft in Gmail");
	}

	section("§4  one audit row per changed claim, a system change");
	missing(4);
	if (applied) {
		const { before, after } = applied;
		const rows = newAudit(before, after);
		eq(rows.map((a) => [a.timestamp, a.user_id, a.username, a.role, a.action, a.entity, a.entity_id]),
			Object.keys(SENT).map((id) => [iso(NOW), 0, "script:data-fix-auto-invoice-mark-sent", "system", "auto_invoice_sent", "load", claimOf(before, id).load_id]),
			"§4 three rows, one per load: user 0, this script, role system, the job's own action for a sent invoice");
		eq(rows.map((a) => a.details), Object.entries(SENT).map(([id, at]) => `${claimOf(before, id).invoice_id} → ${SEND_DOMAIN} (recorded as sent by hand from Gmail at ${normalized(at)}: ${NOTE}) [AUTO-INVOICE-SENT-BY-HAND]`),
			"§4 each says it was recorded as sent by hand from Gmail, when, and the note");
		eq(after.audit_trail.filter((a) => before.audit_trail.some((b) => b.id === a.id)), before.audit_trail, "§4 the rows already there as they were");
	}

	section("§5  a replay writes nothing");
	missing(5);
	if (applied) {
		const { file, after } = applied;
		const again = await runFix(argsFor(file, TARGETS, ["--apply"]));
		eq(again.code, 0, "§5 a second --apply runs (exit 0)");
		ok(Object.entries(SENT).every(([id, at]) => again.out.includes(`  ${claimOf(after, id).load_id}: already done: recorded as sent by hand at ${normalized(at)}; nothing to write`)), "§5 each load: already done");
		ok(again.out.endsWith("3 named: 0 changed, 0 skipped, 3 already done."), "§5 the counts");
		eq(JSON.stringify(snapshot(file)) === JSON.stringify(after), true, "§5 every table as it was: no new audit row, no claim stamped again");
		const dry = await runFix(argsFor(file, TARGETS));
		eq([dry.code, dry.out.endsWith("3 named: 0 would change, 0 skipped, 3 already done. Nothing written.")], [0, true], "§5 a dry run after it says the same");
		// The job may spell a claim's load ID another way later (a leading #, another case).
		onCopy(file, (db) => ledgerLib.transition(db, key("LD-TEST-0901"), { from: ["drafted"], patch: { load_id: "#ld-test-0901" }, nowIso: iso(NOW) }));
		const respelled = snapshot(file);
		const third = await runFix(argsFor(file, TARGETS, ["--apply"]));
		eq([third.code, third.out.includes(`  #ld-test-0901: already done: recorded as sent by hand at ${normalized(SENT["LD-TEST-0901"])}; nothing to write`),
			JSON.stringify(snapshot(file)) === JSON.stringify(respelled)], [0, true, true], "§5 ...also once the claim's load ID is spelled another way: already done, nothing written");
	}

	// ---------------------------------------------------------------- §6
	section("§6  a claim not in exactly the job's recorded-draft shape is skipped, never forced");
	missing(6);
	if (fix) {
		const GOOD = "LD-TEST-0901@2026-10-20T17:12:06Z";
		const at = (min) => iso(T0 + min * MIN);
		const patch = (id, p) => (db) => ledgerLib.transition(db, key(id), { from: ["drafted"], patch: p, nowIso: at(400) });
		const CASES = [
			["missing: no claim for the load", "LD-TEST-0999@2026-10-20T17:00:00Z", null, /LD-TEST-0999: skipped: missing: the load has no automatic-invoice claim$/m],
			["another state: the baseline's", "LD-TEST-0900@2026-10-20T17:00:00Z", null, /LD-TEST-0900: skipped: state baseline\./],
			["another state: waiting for its POD", "LD-TEST-0906@2026-10-21T08:00:00Z", null, /LD-TEST-0906: skipped: state waiting \(WAITING_POD\)/],
			["a delivery already set: the job's own send", "LD-TEST-0905@2026-10-21T08:00:00Z", null, /LD-TEST-0905: skipped: delivery already 'send'; a different sent time \(\S+Z\)/],
			["a sent time already on record, with no delivery", "LD-TEST-0908@2026-10-21T08:00:00Z", patch("LD-TEST-0908", { sent_at: at(90) }), /LD-TEST-0908: skipped: a different sent time \(/],
			["...the same time as given, with no delivery", "LD-TEST-0908@2026-10-20T15:30:00Z", patch("LD-TEST-0908", { sent_at: at(90) }), /LD-TEST-0908: skipped: a sent time already on record/],
			["another stage", "LD-TEST-0908@2026-10-21T08:00:00Z", patch("LD-TEST-0908", { stage: "appended" }), /LD-TEST-0908: skipped: stage 'appended'/],
			["a lease held", "LD-TEST-0908@2026-10-21T08:00:00Z", patch("LD-TEST-0908", { lease_owner: "made-up-worker", lease_until: iso(NOW + HOUR) }), /LD-TEST-0908: skipped: a lease held \(made-up-worker until /],
			["no invoice number", "LD-TEST-0908@2026-10-21T08:00:00Z", patch("LD-TEST-0908", { invoice_id: "" }), /LD-TEST-0908: skipped: .*no invoice number/],
			["no draft Message-ID", "LD-TEST-0908@2026-10-21T08:00:00Z", patch("LD-TEST-0908", { message_id: "" }), /LD-TEST-0908: skipped: no draft Message-ID\./],
			["a send started by scripts/auto-invoice-send-drafted.js", "LD-TEST-0908@2026-10-21T08:00:00Z",
				(db) => ledgerLib.setMeta(db, "send_drafted:ld-test-0908", JSON.stringify({ v: 1, state: "started", at: at(300) })), /LD-TEST-0908: skipped: a send by scripts\/auto-invoice-send-drafted\.js on record \(started\)/],
			["the job's own draft row gone", "LD-TEST-0908@2026-10-21T08:00:00Z",
				(db) => db.prepare("DELETE FROM load_invoice_drafts WHERE id = (SELECT draft_row_id FROM auto_invoice_claims WHERE load_key = 'ld-test-0908')").run(),
				/LD-TEST-0908: skipped: the job's own draft row for its invoice is not on record/],
			["a person's draft on record too", "LD-TEST-0907@2026-10-21T08:00:00Z", null, /LD-TEST-0907: skipped: 1 other invoice draft on record for this load, so which invoice went can't be told/],
			["a sent time before its draft was made", "LD-TEST-0902@2026-10-20T13:30:00Z", null, /LD-TEST-0902: skipped: the sent time is before its draft was made \(2026-10-20T/],
			["sent at that time already, but not by this script", "LD-TEST-0908@2026-10-21T08:00:00Z", patch("LD-TEST-0908", { delivery: "send", sent_at: "2026-10-21T08:00:00.000Z" }),
				/LD-TEST-0908: skipped: recorded as sent at that time, but not by this script \(no audit row of its own\)/],
		];
		for (const [label, target, prepare, re] of CASES) {
			const file = copyStory();
			if (prepare) onCopy(file, prepare);
			const before = snapshot(file);
			const skipKey = key(target.split("@")[0]);
			const r = await runFix(argsFor(file, [target, GOOD], ["--apply"]));
			const after = snapshot(file);
			eq(r.code, 3, `§6 ${label}: exit 3`);
			ok(re.test(r.out), `§6 ${label}: printed with its state`);
			eq(after.auto_invoice_claims.find((c) => c.load_key === skipKey) || null, before.auto_invoice_claims.find((c) => c.load_key === skipKey) || null, `§6 ${label}: its claim as it was`);
			eq([claimOf(after, "LD-TEST-0901").delivery, newAudit(before, after).map((a) => a.entity_id)], ["send", ["LD-TEST-0901"]], `§6 ${label}: the other load named still moves, with its one audit row`);
			ok(r.out.endsWith("2 named: 1 changed, 1 skipped, 0 already done."), `§6 ${label}: the counts`);
		}
		// Recorded by this script at one time, then named with another.
		const file = copyStory();
		await runFix(argsFor(file, [GOOD], ["--apply"]));
		const before = snapshot(file);
		const r = await runFix(argsFor(file, ["LD-TEST-0901@2026-10-20T18:00:00Z"], ["--apply"]));
		eq(r.code, 3, "§6 recorded by this script, then named with another time: exit 3");
		ok(/LD-TEST-0901: skipped: delivery already 'send'; a different sent time \(2026-10-20T17:12:06\.000Z\); recorded as sent by hand by this script before/.test(r.out), "§6 ...printed with the time it holds");
		eq(JSON.stringify(snapshot(file)) === JSON.stringify(before), true, "§6 ...nothing written");
		// The dry run skips the same way.
		const dryFile = copyStory();
		const dry = await runFix(argsFor(dryFile, ["LD-TEST-0905@2026-10-21T08:00:00Z", GOOD]));
		eq([dry.code, /LD-TEST-0905: skipped: delivery already 'send'/.test(dry.out), dry.out.endsWith("2 named: 1 would change, 1 skipped, 0 already done. Nothing written.")], [3, true, true],
			"§6 the dry run prints the same skip and counts (exit 3)");
	}

	// ---------------------------------------------------------------- §7
	section("§7  refused before anything is written (exit 2)");
	missing(7);
	if (fix) {
		const file = copyStory();
		const before = JSON.stringify(snapshot(file));
		const good = (extra = []) => [`--db=${file}`, "--load=LD-TEST-0901@2026-10-20T17:12:06Z", `--note=${NOTE}`, ...extra];
		const REFUSALS = [
			["no --load", [`--db=${file}`, `--note=${NOTE}`, "--apply"], /--load=<load>@<sent time>/],
			["a --load with no time", [`--db=${file}`, "--load=LD-TEST-0901", `--note=${NOTE}`, "--apply"], /give it as <load>@<sent time>/],
			["a --load with no load", [`--db=${file}`, "--load=@2026-10-20T17:12:06Z", `--note=${NOTE}`, "--apply"], /give it as <load>@<sent time>/],
			["a load number that can't be read", [`--db=${file}`, "--load=LD TEST@2026-10-20T17:12:06Z", `--note=${NOTE}`, "--apply"], /the load number can't be read/],
			["a time with a space", [`--db=${file}`, "--load=LD-TEST-0901@2026-10-20 17:12:06", `--note=${NOTE}`, "--apply"], /the sent time must be/],
			["a time with no Z", [`--db=${file}`, "--load=LD-TEST-0901@2026-10-20T17:12:06", `--note=${NOTE}`, "--apply"], /the sent time must be/],
			["a time with no seconds", [`--db=${file}`, "--load=LD-TEST-0901@2026-10-20T17:12Z", `--note=${NOTE}`, "--apply"], /the sent time must be/],
			["a day that doesn't exist", [`--db=${file}`, "--load=LD-TEST-0901@2026-02-30T10:00:00Z", `--note=${NOTE}`, "--apply"], /the sent time must be/],
			["an hour that doesn't exist", [`--db=${file}`, "--load=LD-TEST-0901@2026-10-20T24:00:00Z", `--note=${NOTE}`, "--apply"], /the sent time must be/],
			["a time that isn't one", [`--db=${file}`, "--load=LD-TEST-0901@yesterday", `--note=${NOTE}`, "--apply"], /the sent time must be/],
			["a time in the future", [`--db=${file}`, "--load=LD-TEST-0901@2026-10-23T00:00:00Z", `--note=${NOTE}`, "--apply"], /the sent time is in the future/],
			["no --db", ["--load=LD-TEST-0901@2026-10-20T17:12:06Z", `--note=${NOTE}`, "--apply"], /--db=<path> is required/],
			["an empty --db", ["--db=", "--load=LD-TEST-0901@2026-10-20T17:12:06Z", `--note=${NOTE}`, "--apply"], /--db=<path> is required/],
			["no --note", [`--db=${file}`, "--load=LD-TEST-0901@2026-10-20T17:12:06Z", "--apply"], /--note=<text> is required/],
			["a blank --note", [...good(["--apply"]).slice(0, 2), "--note=   ", "--apply"], /--note=<text> is required/],
			["a --note with a line break", [...good().slice(0, 2), "--note=made-up\nsecond line", "--apply"], /--note must be one line/],
			["a --note too long", [...good().slice(0, 2), `--note=${"x".repeat(201)}`, "--apply"], /--note must be one line of at most 200 characters/],
			["a load named twice", [`--db=${file}`, "--load=LD-TEST-0901@2026-10-20T17:12:06Z", "--load=#ld-test-0901@2026-10-20T18:00:00Z", `--note=${NOTE}`, "--apply"], /ld-test-0901 is named twice/],
			["both modes", good(["--apply", "--dry-run"]), /--dry-run or --apply, not both/],
			["an unknown option", good(["--apply", "--force"]), /unknown or malformed argument: --force/],
			["a word that isn't an option", good(["--apply", "now"]), /unknown argument: now/],
			["--db given twice", [...good(["--apply"]), `--db=${file}`], /--db is given twice/],
			["a database that isn't there", [`--db=${path.join(path.dirname(file), "nowhere.db")}`, "--load=LD-TEST-0901@2026-10-20T17:12:06Z", `--note=${NOTE}`, "--apply"], /--db names no file/],
			["a database outside the app directory and the temp directory", [`--db=${path.join(ROOT, "scripts", "lib", "nowhere.db")}`, "--load=LD-TEST-0901@2026-10-20T17:12:06Z", `--note=${NOTE}`, "--apply"], /refusing .*nowhere\.db/],
		];
		for (const [label, argv, re] of REFUSALS) {
			const r = await runFix(argv);
			eq(r.code, 2, `§7 ${label}: exit 2`);
			ok(re.test(r.err) && r.err.startsWith("REFUSED: "), `§7 ${label}: says why (${r.err.slice(0, 120)})`);
			ok(r.out === "", `§7 ${label}: refused before anything is read`);
		}
		eq(JSON.stringify(snapshot(file)) === before, true, "§7 nothing written by any of them");
		// A database with no claims table: refused, nothing written.
		const bare = path.join(fs.mkdtempSync(path.join(BASE, "bare-")), "app.db");
		onCopy(bare, (db) => db.exec(table("audit_trail")));
		const bareBytes = fileSha(bare);
		const b = await runFix([`--db=${bare}`, "--load=LD-TEST-0901@2026-10-20T17:12:06Z", `--note=${NOTE}`, "--apply"]);
		eq([b.code, /the database has no automatic-invoice claims, invoice-draft or audit_trail tables/.test(b.err), fileSha(bare) === bareBytes], [2, true, true],
			"§7 a database without the automatic-invoice tables: refused, nothing written");
	}

	// ---------------------------------------------------------------- §8
	section("§8  --apply only with the rule that holds a sent load alone on a later change");
	missing(8);
	if (fix) {
		for (const [label, rulesLib, re] of [["the checkout has no such rule", RULES_ABSENT, /not in this checkout/], ["the app's settings switch it off", RULES_OFF, /switched off/]]) {
			const file = copyStory();
			const before = fileSha(file);
			const r = await runFix(argsFor(file, TARGETS, ["--apply"]), { rules: rulesLib });
			eq([r.code, re.test(r.err), r.err.includes("any later change to one of these loads would stop all automatic sending"), fileSha(file) === before], [2, true, true, true],
				`§8 ${label}: --apply refused, saying why, nothing written`);
			const dry = await runFix(argsFor(file, TARGETS), { rules: rulesLib });
			eq([dry.code, re.test(dry.out), /--apply is refused/.test(dry.out), dry.out.endsWith("3 named: 3 would change, 0 skipped, 0 already done. Nothing written."), fileSha(file) === before],
				[0, true, true, true, true], `§8 ${label}: the dry run still prints the plan and says --apply is refused`);
		}
		const seen = [];
		const spy = { ...rules, holdOneLoadEnabled: (env) => { seen.push(env); return true; } };
		const r = await runFix(argsFor(copyStory(), TARGETS, ["--apply"]), { rules: spy, env: { AUTO_INVOICE_HOLD_ONE_LOAD: "made-up" } });
		eq([r.code, seen.length, seen[0] && seen[0].AUTO_INVOICE_HOLD_ONE_LOAD], [0, 1, "made-up"], "§8 the rule reads the app's settings it was given, once");
		ok(/rule that holds a sent load alone on a later change \(AUTO_INVOICE_HOLD_ONE_LOAD\): on$/m.test(r.out), "§8 ...and the run says it is on");
	}

	// ---------------------------------------------------------------- §9
	section("§9  the command line");
	missing(9);
	if (fix) {
		const cwd = fs.mkdtempSync(path.join(BASE, "cwd-"));
		const env = { ...process.env };
		delete env.AUTO_INVOICE_HOLD_ONE_LOAD;
		const cli = (args) => {
			const r = spawnSync(process.execPath, [SCRIPT_FILE, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
			return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
		};
		const none = cli([]);
		eq([none.code, /^REFUSED: --db=<path> is required/.test(none.err), none.out], [2, true, ""], "§9 no arguments: exit 2, refused, nothing read");
		const file = copyStory();
		const bytes = fileSha(file);
		const dry = cli(argsFor(file, TARGETS));
		eq([dry.code, /Mode: dry run \(nothing is written\)\./.test(dry.out), dry.out.includes(`database: ${file} (opened read-only)`), /3 named: 3 would change, 0 skipped, 0 already done\. Nothing written\.\n$/.test(dry.out), fileSha(file) === bytes],
			[0, true, true, true, true], "§9 no mode: the dry run, read-only, exit 0, nothing written");
		const skipped = cli(argsFor(file, ["LD-TEST-0999@2026-10-20T17:00:00Z"]));
		eq(skipped.code, 3, "§9 a load skipped: exit 3");
		// --apply follows this checkout's own rule: refused without it, applied with it.
		const ruleHere = typeof rules.holdOneLoadEnabled === "function" && rules.holdOneLoadEnabled({});
		const apply = cli(argsFor(file, TARGETS, ["--apply"]));
		if (ruleHere) eq([apply.code, /3 named: 3 changed, 0 skipped, 0 already done\.\n$/.test(apply.out)], [0, true], "§9 --apply in this checkout (it has the rule): exit 0, three changed");
		else eq([apply.code, /^REFUSED: .*not in this checkout/.test(apply.err), fileSha(file) === bytes], [2, true, true], "§9 --apply in this checkout (it has no such rule yet): exit 2, nothing written");
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
		fs.rmSync(BASE, { recursive: true, force: true });
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
