#!/usr/bin/env node
// Sends the broker invoices the automatic job drafted while automatic sending was
// stopped for a load changed after its send (LOAD_CHANGED_AFTER_SEND). The job
// leaves a drafted load alone, so this run, by hand on the server after an approved
// go-ahead, is how those drafts go out.
//
//   node scripts/auto-invoice-send-drafted.js --db=<app.db> --sheet-id=<id|production>
//     (--dry-run | --apply) [--max=<1-10>] [--stop-at=<the stop's ISO time>]
//
// It lists every load whose label reads "Draft ready in Gmail" (drafted by the job,
// not sent). Only the job's own draft, handed to Gmail inside the stop's window, with
// no send refusal on record and its recipient's domain still on the send list, is
// "from the stop"; any other is CHECK BY HAND, with one word for why not. The window
// comes from the audit log alone: from the stop's time, as the resume's row names
// it, to that resume. No such stop, a stop with no resume, or several stops and no
// --stop-at: refused, nothing sent. --sheet-id=production names production's own
// sheet (lib/sheet-id.js); nothing defaults to it.
//
// A load from the stop is CLEAN only when all of these hold now, else CHECK BY HAND
// with one word; anything that can't be checked is CHECK BY HAND:
//   - the job's own send decision (real drafts on, sending on, not stopped, the
//     domain listed, the POD settle window) and its free checks on a fresh read of
//     Job Tracking, whose parse and closed-month rule are server.js's own, lifted at
//     run time (scripts/lib/server-lift.js);
//   - nothing the job watches has changed since the draft; not factored (a marker
//     that can't be read counts), no mark cleared since the draft, no Draft Invoice
//     press in flight, no other draft row; the recipient rule on the draft's To;
//   - Delivered 36 hours ago or more, and no rate con uploaded after that;
//   - the mailbox login sees the draft in Drafts by its Message-ID, that Message-ID
//     isn't in Sent Mail, and the draft, fetched, is one message whose digest and
//     invoice number are the claim's own and which passes the job's last check on an
//     outgoing message.
// --dry-run opens the database read-only and writes nothing. It prints the mailbox
//   account (the address only), the stop it matched, and per load its label, from
//   the stop or why not, and whether the login sees its draft.
// --apply prints the same, then sends the CLEAN loads, at most --max (3) a run, one at
//   a time: a meta row first, so no later run sends that load again; then the draft's
//   own To, subject, body and attachments through the job's SMTP sender
//   (lib/auto-invoice-send.js createSmtpSender()), From the mailbox, with a fresh
//   Message-ID. Once Sent Mail shows it, one transaction records the send as the job
//   records one (the claim's delivery 'send', so Completed Loads reads "Sent to the
//   broker"), with one audit row as the system actor. The first error stops the run.
//   A draft is never edited, sent again or deleted: each sent load's old draft
//   Message-ID is printed for a person to delete.
// Exit 0 done; 2 refused (an argument, the database, the window, no mailbox login, a
// replica); 1 any other failure (a send, its confirmation, its record).
//
// Required as a module (by its runner) it runs nothing and exports run().

"use strict";

const fs = require("fs");
const path = require("path");
const rules = require("../lib/auto-invoice-rules");
const ledger = require("../lib/auto-invoice-ledger");
const sendRules = require("../lib/auto-invoice-send");
const factoring = require("../lib/factoring-store");
const imapDraft = require("../lib/imap-draft");
const mimeRead = require("../lib/mime-read");
const sheetIds = require("../lib/sheet-id");

const ROOT = path.join(__dirname, "..");
const ACTOR = Object.freeze({ id: 0, username: "auto-invoice-send-drafted", role: "system" });
const KNOWN = { flags: new Set(["dry-run", "apply"]), values: new Set(["db", "sheet-id", "max", "stop-at"]) };
const STOP_REASON = "LOAD_CHANGED_AFTER_SEND";
const DRAFTS = "[Gmail]/Drafts";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DELIVERED_AGO_MS = 36 * HOUR_MS;
const MAX_DEFAULT = 3;
const MAX_LIMIT = 10;
// The stop's audit row is written right after the stop it names.
const STOP_ROW_LAG_MS = 60 * 1000;
// Sent Mail is searched at once, then after each wait, before a send counts as unconfirmed.
const CONFIRM_WAITS_MS = Object.freeze([0, 10 * 1000, 30 * 1000, 60 * 1000]);
// One meta row per load a run started to send. Only a send refused before the
// message left (state "refused") lets a later run try that load again.
const MARK_PREFIX = "send_drafted:";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const RESUMED_RE = /^cleared the stop of (\S{1,40}) \(([A-Z_]{1,40})\)$/;
const STOPPED_RE = /^([A-Z_]{1,40})(?: |$)/;
const SUBJECT_WORD_RE = /^[A-Za-z0-9#._-]{1,80}$/;
const VERDICT_WORDS = Object.freeze({
	LOAD_DROPPED: "dropped", NOT_COMPLETED: "status", LOAD_FACTORED: "factored", BROKER_OPTED_OUT: "optout",
	NO_BROKER_EMAIL: "recipient", BROKER_EMAIL_FREEMAIL: "recipient", BROKER_DOMAIN_UNCONFIRMED: "recipient",
	RECIPIENT_CHECK_OFF: "recipient", RECIPIENT_UNCONFIGURED: "recipient", MONTH_UNKNOWN: "month", CLOSED_MONTH: "month",
	NO_DELIVERY_DATE: "date", ADVANCE_LINES: "advance", WAITING_POD: "pod", POD_UNREADABLE: "pod",
});
const DECISION_WORDS = Object.freeze({ OFF: "off", STOPPED: "stopped", DOMAIN_NOT_LISTED: "domain", POD_TIME_UNKNOWN: "pod", SETTLING: "pod" });
// What the lift may bring along from server.js: the sheet's parse and the closed-month
// rule, never anything that reaches Google, the mailer or the HTTP server.
const LIFT_ROOTS = Object.freeze(["parseSheet", "deduplicateLoads", "integrityClosedMonthsOf"]);
const LIFT_DENIED = Object.freeze(["getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "app", "sendEmail", "transporter", "getDrive"]);

class Refusal extends Error {}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/s.exec(String(a));
		if (!m) throw new Refusal(`unknown argument: ${String(a).slice(0, 40)}`);
		const [, name, value] = m;
		if (KNOWN.flags.has(name) && value === undefined) out[name] = true;
		else if (KNOWN.values.has(name) && value !== undefined) out[name] = value;
		else throw new Refusal(`unknown or malformed argument: --${name}`);
	}
	if (Boolean(out["dry-run"]) === Boolean(out.apply)) throw new Refusal("give exactly one of --dry-run and --apply");
	if (!out.db || !out.db.trim()) throw new Refusal("--db=<app.db> is required");
	if (!out["sheet-id"] || !out["sheet-id"].trim()) throw new Refusal("--sheet-id=<id> is required (production's own sheet: --sheet-id=production)");
	if (out.max === undefined) out.max = MAX_DEFAULT;
	else if (/^\d{1,2}$/.test(out.max) && Number(out.max) >= 1 && Number(out.max) <= MAX_LIMIT) out.max = Number(out.max);
	else throw new Refusal(`--max must be a whole number from 1 to ${MAX_LIMIT}`);
	if (out["stop-at"] !== undefined && !ISO_RE.test(out["stop-at"])) throw new Refusal("--stop-at must be the stop's time as the audit log prints it (an ISO time ending in Z)");
	return out;
}

// The sheet named on the command line: an ID, or production's own by name.
function sheetTarget(value) {
	const v = String(value).trim();
	return v === "production" ? { id: sheetIds.PRODUCTION_SPREADSHEET_ID, label: "production" } : { id: v, label: v };
}

const jsonOf = (text) => {
	try {
		const v = JSON.parse(String(text || ""));
		return v && typeof v === "object" ? v : null;
	} catch {
		return null;
	}
};
const isoOf = (ms) => new Date(ms).toISOString();
const codeOf = (e) => (e && typeof e.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? e.code : "ERROR");
const markKey = (key) => `${MARK_PREFIX}${key}`;

// What the job handed to Gmail (lib/auto-invoice-job.js sentOf()): { to, subject }, or null.
function sentOf(c) {
	const s = jsonOf(c && c.sent_json);
	const to = s ? String(s.to || "").toLowerCase() : "";
	return to ? { to, subject: String(s.subject || "") } : null;
}

// A run's mark on a load, or null when there is none, or only a refused one.
function markOf(db, key) {
	const raw = ledger.getMeta(db)[markKey(key)];
	if (raw === undefined || raw === "") return null;
	const mark = jsonOf(raw);
	if (mark && mark.state === "refused") return null;
	return mark || { state: "unreadable" };
}

// ── the stop's window ────────────────────────────────────────────────────────

// From the audit log alone: the resume's row names the stop's own time and reason,
// and the stop's own row, written right after the stop, agrees.
function readWindow(db, stopAt) {
	const rows = (action) => db.prepare("SELECT timestamp, details FROM audit_trail WHERE action = ? ORDER BY id").all(action);
	const stops = rows("auto_invoice_send_stopped")
		.map((r) => ({ iso: String(r.timestamp || ""), ms: Date.parse(String(r.timestamp || "")), reason: (STOPPED_RE.exec(String(r.details || "")) || [])[1] || "" }))
		.filter((s) => s.reason === STOP_REASON);
	const resumes = rows("auto_invoice_send_resumed")
		.map((r) => {
			const m = RESUMED_RE.exec(String(r.details || ""));
			return m && ISO_RE.test(m[1]) ? { stopIso: m[1], stopMs: Date.parse(m[1]), reason: m[2], resumedIso: String(r.timestamp || ""), resumedMs: Date.parse(String(r.timestamp || "")) } : null;
		})
		.filter((r) => r && r.reason === STOP_REASON);
	if (!stops.length) throw new Refusal(`no ${STOP_REASON} stop in the audit log: nothing to send`);
	const pairs = [];
	for (const s of stops) {
		const matches = resumes.filter((r) => Number.isFinite(s.ms) && s.ms >= r.stopMs && s.ms - r.stopMs <= STOP_ROW_LAG_MS);
		if (matches.length !== 1) throw new Refusal(matches.length ? `the stop of ${s.iso} matches more than one resume in the audit log` : `the stop of ${s.iso} has no resume in the audit log (it may still stand)`);
		pairs.push({ stop: s, resume: matches[0] });
	}
	for (const r of resumes) {
		if (pairs.filter((p) => p.resume === r).length !== 1) throw new Refusal(`the resume of the stop of ${r.stopIso} matches no one stop row in the audit log`);
	}
	const chosen = stopAt === undefined ? pairs : pairs.filter((p) => p.resume.stopIso === stopAt);
	if (!chosen.length) throw new Refusal(`no ${STOP_REASON} stop at ${stopAt} in the audit log`);
	if (chosen.length > 1) throw new Refusal(`${chosen.length} ${STOP_REASON} stops in the audit log: name one with --stop-at (${chosen.map((p) => p.resume.stopIso).join(", ")})`);
	const { resume } = chosen[0];
	if (!Number.isFinite(resume.resumedMs) || resume.resumedMs <= resume.stopMs) throw new Refusal("the stop's window can't be read from the audit log");
	return { stopAt: resume.stopIso, resumedAt: resume.resumedIso, reason: STOP_REASON, fromMs: resume.stopMs, toMs: resume.resumedMs };
}

// ── which drafted loads the stop held back ──────────────────────────────────

function refusalRows(db, c) {
	return db.prepare("SELECT details FROM audit_trail WHERE action = 'auto_invoice_send_refused' AND entity_id = ?").all(String(c.load_id || ""))
		.filter((r) => String(r.details || "").startsWith(`${c.invoice_id}:`)).length;
}

// "" when the job drafted this load because sending was stopped, else one word for why not.
function notFromStop(db, c, win, sendSettings) {
	const sent = sentOf(c);
	if (!sent) return "unrecorded";
	if (ledger.otherDraftRows(db, c).length) return "person";
	const own = ledger.ownDraftRow(db, c);
	if (c.delivery !== "" || c.stage !== "recorded" || !own || own.via !== rules.VIA_DRAFT || Number(own.id) !== Number(c.draft_row_id)) return "unrecorded";
	const handedMs = Date.parse(String((jsonOf(c.draft_digest_json) || {}).renderedAt || ""));
	if (!Number.isFinite(handedMs)) return "unrecorded";
	if (handedMs < win.fromMs || handedMs > win.toMs) return "outside";
	if (refusalRows(db, c)) return "refused";
	if (!sendSettings.domains.includes(rules.emailDomain(sent.to))) return "domain";
	return "";
}

// ── what the job reads, read the same way ───────────────────────────────────

// server.js's own sheet parse and closed-month rule, on this database.
let liftedText = null;
function serverRules(db) {
	if (liftedText === null) {
		const { closure } = require("./lib/server-lift");
		const src = require("./lib/server-source").serverSource({ root: ROOT });
		liftedText = closure(src, { roots: [...LIFT_ROOTS], provided: ["require", "console", "db"], denied: [...LIFT_DENIED] }).text;
	}
	const noRequire = (m) => {
		throw new Error(`lifted code required ${m}`);
	};
	return new Function("require", "console", "db", `"use strict";\n${liftedText}\nreturn { ${LIFT_ROOTS.join(", ")} };`)(noRequire, console, db);
}

// Job Tracking as the job's snapshot reads it: each load's last row.
async function readSheet(readRange, server) {
	try {
		const parsed = server.parseSheet({ values: await readRange("Job Tracking") });
		const rows = server.deduplicateLoads(parsed.data, parsed.headers);
		const cols = rules.jobColumns(parsed.headers);
		if (!cols.loadIdCol || !cols.statusCol) return { ok: false };
		const byKey = new Map();
		for (const row of rows) {
			const key = rules.loadKey(row[cols.loadIdCol]);
			if (key) byKey.set(key, row);
		}
		return { ok: true, headers: parsed.headers, cols, byKey };
	} catch {
		return { ok: false };
	}
}

async function sharedReads(ctx) {
	const { db } = ctx;
	let server = null;
	try {
		server = serverRules(db);
	} catch {
		server = null;
	}
	const sheet = server ? await readSheet(ctx.opts.readRange, server) : { ok: false };
	let factored = new Set();
	let factoredUnreadable = false;
	try {
		factored = factoring.factoredKeys(db);
	} catch {
		factoredUnreadable = true;
	}
	let cleared = new Map();
	let clearedUnreadable = false;
	try {
		cleared = factoring.clearedMarks(db);
	} catch {
		clearedUnreadable = true;
	}
	return { server, sheet, factored, factoredUnreadable, cleared, clearedUnreadable, settings: ledger.readSettings(db), records: rules.indexRecords(ledger.readRecords(db)) };
}

// The load's facts as the job's factsOf() assembles them (lib/auto-invoice-job.js).
function factsOf(ctx, shared, key) {
	const { db, env, opts } = ctx;
	const row = shared.sheet.byKey.get(key) || null;
	let closedMonths = null;
	if (row) {
		try {
			closedMonths = shared.server.integrityClosedMonthsOf(shared.sheet.headers, row);
		} catch {
			closedMonths = null;
		}
	}
	const podReadable = (doc) => {
		if (String(doc.drive_file_id || "")) return true;
		if (!opts.uploadsRoot) return null;
		const file = rules.documentLocalPath(opts.uploadsRoot, doc);
		return Boolean(file) && typeof opts.fileExists === "function" && opts.fileExists(file);
	};
	return rules.loadFacts({
		row,
		cols: shared.sheet.cols,
		records: shared.records.get(key),
		optOutDomains: shared.settings.optOutDomains,
		confirmedDomains: shared.settings.confirmedBrokerDomains,
		bisonRecipientConfigured: Boolean(rules.normalizeEmail(env.BISON_INVOICE_EMAIL || "")),
		closedMonths,
		completionDay: "",
		podReadable,
		activeAdvanceLines: row ? ledger.activeAdvanceLines(db, key) : 0,
		factored: shared.factored.has(key),
		knownAddressOn: rules.knownAddressEnabled(env),
	});
}

function hasColumn(db, table, column) {
	return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

// The load's latest Delivered: its claim's first sight of it, or a later Delivered on
// record. NaN when any of them can't be read.
function deliveredAt(db, c) {
	const times = [Date.parse(String(c.first_seen_at || ""))];
	if (ledger.hasTable(db, "load_status_history")) {
		const rows = db.prepare("SELECT new_status, strftime('%Y-%m-%dT%H:%M:%SZ', changed_at) AS at FROM load_status_history WHERE LOWER(TRIM(load_id)) IN (?, ?)").all(c.load_key, `#${c.load_key}`);
		for (const r of rows) if (rules.isCompletedStatus(r.new_status)) times.push(Date.parse(String(r.at || "")));
	}
	return times.every(Number.isFinite) ? Math.max(...times) : NaN;
}

// A live rate-con row uploaded after `sinceMs`, or one whose time can't be read.
function rateConAfter(db, key, sinceMs) {
	if (!ledger.hasTable(db, "documents")) return false;
	const live = hasColumn(db, "documents", "deleted_at") ? " AND deleted_at IS NULL" : "";
	const rows = db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%SZ', uploaded_at) AS at FROM documents WHERE LOWER(TRIM(load_id)) IN (?, ?) AND UPPER(type) IN (${rules.RATECON_TYPES.map(() => "?").join(", ")})${live}`)
		.all(key, `#${key}`, ...rules.RATECON_TYPES);
	return rows.some((r) => {
		const t = Date.parse(String(r.at || ""));
		return !Number.isFinite(t) || t > sinceMs;
	});
}

// The recipient rule on the draft's To, and for C.H. Robinson the parts of the
// known-address check a script can read: the check on, and the address proven.
function recipientRefused(ctx, facts, to) {
	const r = rules.recipientRule({ brokerEmail: facts.brokerEmail, bisonRecipient: ctx.env.BISON_INVOICE_EMAIL || "", documentsEmail: to,
		confirmedDomains: facts.brokerDomainConfirmed ? [facts.brokerDomain] : [] });
	if (!r.ok || r.to.toLowerCase() !== to) return true;
	if (!rules.isKnownAddressDomain(rules.emailDomain(to))) return false;
	return !rules.knownAddressEnabled(ctx.env) || ledger.invoiceLoadsTo(ctx.db, to) < rules.KNOWN_ADDRESS_MIN_LOADS;
}

// ── the mailbox, read only ──────────────────────────────────────────────────

// "found", "absent", or "unknown" when the search can't be made or fails.
async function lookFor(ctx, messageId, box) {
	try {
		const r = await ctx.opts.findDraftByMessageId({ user: ctx.mb.user, pass: ctx.mb.pass, messageId, mailboxes: [box] });
		return r && r.found ? "found" : "absent";
	} catch {
		return "unknown";
	}
}

// The longest word of the subject that holds a digit, for the Drafts search.
function subjectWord(subject) {
	return String(subject || "").split(/\s+/).filter((w) => SUBJECT_WORD_RE.test(w) && /\d/.test(w)).sort((a, b) => b.length - a.length)[0] || "";
}

// The draft's own bytes from Drafts, read by its subject word around the day the job
// handed it over: exactly one message with the claim's Message-ID, read whole.
async function fetchDraft(ctx, c, sent) {
	const handed = new Date(Date.parse(String((jsonOf(c.draft_digest_json) || {}).renderedAt || "")));
	const day = Date.UTC(handed.getUTCFullYear(), handed.getUTCMonth(), handed.getUTCDate());
	const word = subjectWord(sent.subject);
	let answer;
	try {
		answer = await ctx.opts.fetchMessages({ user: ctx.mb.user, pass: ctx.mb.pass, mailbox: DRAFTS, since: new Date(day - DAY_MS), before: new Date(day + 2 * DAY_MS), ...(word ? { subject: word } : {}) });
	} catch {
		return { word: "fetch" };
	}
	const mine = ((answer && answer.messages) || []).map((m) => mimeRead.parseMessage(m && m.raw)).filter((p) => p.messageId === c.message_id);
	return mine.length === 1 ? { word: "", parsed: mine[0] } : { word: "fetch" };
}

// The fetched draft is the job's own message: the claim's digest of what it handed to
// Gmail, its invoice number and recipient, and the job's last check before a send.
function proofOf(ctx, c, sent, parsed) {
	if (parsed.to.length !== 1 || parsed.cc.length || parsed.bcc.length || typeof parsed.html !== "string") return { word: "mismatch" };
	const message = {
		to: parsed.to[0],
		subject: parsed.subject,
		html: parsed.html,
		attachments: parsed.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
	};
	if (message.to !== sent.to || message.subject !== sent.subject) return { word: "mismatch" };
	if (rules.digestDifferences(jsonOf(c.draft_digest_json), rules.messageDigest(parsed)).length) return { word: "mismatch" };
	if (rules.invoiceNumberIn(message) !== c.invoice_id) return { word: "mismatch" };
	if (sendRules.outgoingCheck({ message, rendered: { attachments: message.attachments }, planned: sent.to, domains: ctx.sendSettings.domains })) return { word: "mismatch" };
	return { word: "", message };
}

// ── one load from the stop: CLEAN, or the word that holds it ────────────────

async function judge(ctx, shared, c, visible) {
	const { db } = ctx;
	const key = c.load_key;
	const nowMs = ctx.now();
	const mark = markOf(db, key);
	if (mark) return { word: "started", mark };
	const sent = sentOf(c);
	const decision = sendRules.sendDecision({ settings: ctx.sendSettings, on: ctx.mode === "on", stopped: Boolean(ledger.getSendStop(db)), to: sent.to,
		podTimes: () => ledger.livePodTimes(db, key), nowMs });
	if (!decision.send) return { word: DECISION_WORDS[decision.why] || "off" };
	if (shared.settings.unreadable) return { word: "settings" };
	if (!shared.sheet.ok) return { word: "sheet" };
	const facts = factsOf(ctx, shared, key);
	const verdict = rules.freeVerdict(facts, { checkDrafted: false });
	if (verdict.state !== "queued") return { word: VERDICT_WORDS[verdict.code] || "check" };
	const saved = jsonOf(c.fingerprint_json);
	if (!saved || c.changed_fields || rules.fingerprintDiff(saved, rules.fingerprint(facts)).length) return { word: "changed" };
	if (shared.factoredUnreadable || ledger.factoredOrUnreadable(db, key)) return { word: "factored" };
	if (shared.clearedUnreadable || String(shared.cleared.get(key) || "") > String(c.drafted_at || "")) return { word: "mark" };
	if (factoring.inflightRows(db, key, isoOf(nowMs)).length) return { word: "press" };
	const deliveredMs = deliveredAt(db, c);
	if (!Number.isFinite(deliveredMs)) return { word: "delivered" };
	if (nowMs - deliveredMs < DELIVERED_AGO_MS) return { word: "recent" };
	if (rateConAfter(db, key, deliveredMs)) return { word: "ratecon" };
	if (recipientRefused(ctx, facts, sent.to)) return { word: "recipient" };
	if (visible === "unknown") return { word: "mailbox" };
	if (visible !== "found") return { word: "invisible" };
	const inSent = await lookFor(ctx, c.message_id, sendRules.SENT_MAILBOX);
	if (inSent === "unknown") return { word: "mailbox" };
	if (inSent === "found") return { word: "sent" };
	const fetched = await fetchDraft(ctx, c, sent);
	if (fetched.word) return fetched;
	return proofOf(ctx, c, sent, fetched.parsed);
}

// ── sending one load ────────────────────────────────────────────────────────

// The last checks and the mark, in one transaction: the claim is still the draft that
// was judged (`c`), no run has marked it, no person's draft or press, not stopped and,
// read last as the job's own commit reads it, not factored. "" when marked, else the word.
function markStarted(db, c, newId, nowIso) {
	return db.transaction(() => {
		const cur = ledger.getClaim(db, c.load_key);
		if (!cur || cur.state !== "drafted" || cur.delivery !== "" || cur.stage !== "recorded" || cur.message_id !== c.message_id
			|| cur.invoice_id !== c.invoice_id || cur.changed_fields !== c.changed_fields || cur.fingerprint_json !== c.fingerprint_json) return "changed";
		if (markOf(db, cur.load_key)) return "started";
		if (ledger.otherDraftRows(db, cur).length) return "person";
		if (factoring.inflightRows(db, cur.load_key, nowIso).length) return "press";
		if (ledger.getSendStop(db)) return "stopped";
		if (ledger.factoredOrUnreadable(db, cur.load_key)) return "factored";
		ledger.setMeta(db, markKey(cur.load_key), JSON.stringify({ v: 1, state: "started", invoiceId: cur.invoice_id, oldMessageId: cur.message_id, newMessageId: newId, at: nowIso }));
		return "";
	}).immediate();
}

// A send refused before its message left: a later run may try the load again.
function markRefused(db, key, mark, nowIso) {
	try {
		ledger.setMeta(db, markKey(key), JSON.stringify({ ...mark, state: "refused", refusedAt: nowIso }));
	} catch {
		// the mark stays "started": no later run sends the load
	}
}

// The send, recorded as the job records its own: the claim's delivery 'send' and its
// new Message-ID, one audit row, the mark closed; one transaction.
function recordSend(db, key, mark, nowIso) {
	db.transaction(() => {
		const cur = ledger.getClaim(db, key);
		if (!cur || cur.state !== "drafted" || cur.delivery !== "" || cur.message_id !== mark.oldMessageId) throw new Error("the claim is no longer this draft");
		if (ledger.transition(db, key, { from: ["drafted"], nowIso, patch: { delivery: "send", sent_at: nowIso, message_id: mark.newMessageId } }) !== 1) throw new Error("the claim did not move");
		const sent = sentOf(cur) || {};
		db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.run(nowIso, ACTOR.id, ACTOR.username, ACTOR.role, "auto_invoice_sent", "load", String(cur.load_id || key),
				`${cur.invoice_id} → ${rules.emailDomain(sent.to) || "unknown domain"} (sent from its Gmail draft by scripts/auto-invoice-send-drafted.js; old draft ${mark.oldMessageId})`);
		ledger.setMeta(db, markKey(key), JSON.stringify({ ...mark, state: "recorded", recordedAt: nowIso }));
	}).immediate();
}

async function confirmSent(ctx, messageId) {
	for (const wait of ctx.confirmWaits) {
		if (wait > 0) await ctx.sleep(wait);
		if ((await lookFor(ctx, messageId, sendRules.SENT_MAILBOX)) === "found") return true;
	}
	return false;
}

// null when sent, confirmed and recorded; else { load, what }.
async function sendOne(ctx, result, e) {
	const { db, mb, out } = ctx;
	const c = e.claim;
	const newId = String(ctx.opts.newMessageId(mb.user) || "");
	if (!imapDraft.MESSAGE_ID_RE.test(newId) || newId === c.message_id) return { load: e.load, what: "no fresh Message-ID; nothing sent" };
	const held = markStarted(db, c, newId, isoOf(ctx.now()));
	if (held) return { load: e.load, what: `changed before the send (${held}); nothing sent` };
	const mark = markOf(db, e.key);
	out(`  sending ${e.load}`);
	try {
		await ctx.opts.sendMail({ user: mb.user, pass: mb.pass, from: `LogisX Inc. <${mb.user}>`, to: e.message.to, subject: e.message.subject, html: e.message.html,
			attachments: e.message.attachments, messageId: newId });
	} catch (err) {
		if (err && (err.outcome === "login" || err.outcome === "refused")) {
			markRefused(db, e.key, mark, isoOf(ctx.now()));
			return { load: e.load, what: `the send was refused (${codeOf(err)}); nothing went out` };
		}
		return { load: e.load, what: `the send got no answer (${codeOf(err)}), so it may have gone out: check Sent Mail for ${newId}; no run sends this load again` };
	}
	if (!(await confirmSent(ctx, newId))) {
		return { load: e.load, what: `the mail server took it, but Sent Mail doesn't show ${newId} yet: nothing recorded; the next run records it once Sent Mail shows it` };
	}
	try {
		recordSend(db, e.key, mark, isoOf(ctx.now()));
	} catch (err) {
		return { load: e.load, what: `sent and in Sent Mail as ${newId}, but the record failed (${codeOf(err)}): record it by hand` };
	}
	result.sent.push({ load: e.load, oldMessageId: c.message_id, newMessageId: newId });
	out(`  sent ${e.load}: in Sent Mail, recorded`);
	return null;
}

// A load an earlier run sent without seeing it in Sent Mail: recorded now if Sent Mail
// shows it, never sent again. true when it is recorded.
async function finishStarted(ctx, result, e) {
	if (!e.mark || e.mark.state !== "started" || !imapDraft.MESSAGE_ID_RE.test(String(e.mark.newMessageId || ""))) return false;
	if ((await lookFor(ctx, e.mark.newMessageId, sendRules.SENT_MAILBOX)) !== "found") return false;
	try {
		recordSend(ctx.db, e.key, e.mark, isoOf(ctx.now()));
	} catch {
		return false;
	}
	result.recorded.push({ load: e.load, oldMessageId: e.mark.oldMessageId, newMessageId: e.mark.newMessageId });
	ctx.out(`  recorded ${e.load}: an earlier run's send is in Sent Mail`);
	return true;
}

function lineOf(e) {
	const label = e.label === "CLEAN" ? "CLEAN" : `CHECK BY HAND (${e.word})`;
	const visible = e.visible === "found" ? "yes" : e.visible === "absent" ? "no" : "unknown";
	return `  ${e.load}  ${label}  from the stop: ${e.fromStop}  draft visible: ${visible}`;
}

// ── the run ─────────────────────────────────────────────────────────────────

// One run on a database the caller opened (read-only for a dry run). opts: db,
// dryRun, max, stopAt, env (the app's settings), mailbox { user, pass }, readRange(range),
// findDraftByMessageId, fetchMessages, newMessageId, sendMail, uploadsRoot,
// fileExists, now(), sleep(ms), out(line), sheetLabel.
async function run(opts = {}) {
	const { db, dryRun = true, max = MAX_DEFAULT, stopAt, sheetLabel = "" } = opts;
	const env = opts.env || {};
	const out = typeof opts.out === "function" ? opts.out : () => {};
	if (!ledger.hasSchema(db) || !ledger.hasTable(db, "audit_trail") || !ledger.hasTable(db, "load_invoice_drafts")) {
		throw new Refusal("the database has no automatic-invoice, invoice-draft or audit_trail tables");
	}
	const win = readWindow(db, stopAt);
	const user = rules.normalizeEmail(opts.mailbox && opts.mailbox.user);
	const pass = String((opts.mailbox && opts.mailbox.pass) || "");
	if (!user || !pass) throw new Refusal("no mailbox login: the app's settings name no GMAIL_USER and app password");
	const ctx = {
		db, env, opts, out,
		mb: { user, pass },
		mode: rules.readMode(env),
		sendSettings: sendRules.readSettings(env),
		now: typeof opts.now === "function" ? opts.now : () => Date.now(),
		sleep: typeof opts.sleep === "function" ? opts.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		confirmWaits: Array.isArray(opts.confirmWaitsMs) ? opts.confirmWaitsMs : CONFIRM_WAITS_MS,
	};
	const result = { dryRun, mailbox: user, window: { stopAt: win.stopAt, resumedAt: win.resumedAt, reason: win.reason }, loads: [], sent: [], recorded: [], failed: null };

	out(dryRun ? "DRY RUN (nothing written)" : "APPLY");
	out(`  mailbox: ${user}`);
	if (sheetLabel) out(`  sheet: ${sheetLabel}`);
	out(`  stop: ${win.stopAt} ${win.reason}, resumed ${win.resumedAt}`);
	const listed = ledger.listClaims(db, ["drafted"]).filter((c) => !sendRules.claimSent(c));
	out(`  Draft ready in Gmail: ${listed.length} load${listed.length === 1 ? "" : "s"}`);
	const why = new Map(listed.map((c) => [c.load_key, notFromStop(db, c, win, ctx.sendSettings)]));
	const shared = [...why.values()].some((w) => w === "") ? await sharedReads(ctx) : null;
	for (const c of listed) {
		const load = String(c.load_id || c.load_key);
		const visible = await lookFor(ctx, c.message_id, DRAFTS);
		const notFrom = why.get(c.load_key);
		let e;
		if (notFrom) e = { load, key: c.load_key, fromStop: notFrom, visible, label: "CHECK BY HAND", word: "not from the stop" };
		else {
			const v = await judge(ctx, shared, c, visible);
			e = { load, key: c.load_key, fromStop: "yes", visible, label: v.word ? "CHECK BY HAND" : "CLEAN", word: v.word || "", message: v.message || null, mark: v.mark || null, claim: c };
		}
		result.loads.push(e);
		out(lineOf(e));
	}

	const fromStop = result.loads.filter((e) => e.fromStop === "yes");
	const nothingVisible = fromStop.length > 0 && !fromStop.some((e) => e.visible === "found");
	if (nothingVisible) out("  the mailbox login sees none of the drafts: nothing is sent");
	const clean = result.loads.filter((e) => e.label === "CLEAN");
	if (dryRun) {
		out(`  would send: ${Math.min(clean.length, max)} of ${clean.length} CLEAN (at most ${max} a run)`);
		return result;
	}

	// An earlier run's send not yet seen in Sent Mail holds every other send, as an
	// unanswered send stops the job's.
	let unconfirmed = 0;
	for (const e of result.loads.filter((x) => x.word === "started")) {
		if (!(await finishStarted(ctx, result, e))) unconfirmed++;
	}
	if (unconfirmed) out(`  ${unconfirmed} earlier send${unconfirmed === 1 ? " isn't" : "s aren't"} in Sent Mail yet: nothing else is sent; check Sent Mail first`);
	const toSend = unconfirmed || nothingVisible ? [] : clean.slice(0, max);
	for (const e of toSend) {
		const failed = await sendOne(ctx, result, e);
		if (failed) {
			result.failed = failed;
			out(`  stopped at ${failed.load}: ${failed.what}`);
			break;
		}
	}
	const later = clean.length - toSend.length;
	if (!unconfirmed && !nothingVisible && later > 0) out(`  ${later} CLEAN load${later === 1 ? "" : "s"} left for the next run (at most ${max} a run)`);
	const gone = [...result.sent, ...result.recorded];
	if (gone.length) {
		out("Old drafts to delete by hand (load, Message-ID):");
		for (const g of gone) out(`  ${g.load}  ${g.oldMessageId}`);
	}
	return result;
}

// ── the command line ────────────────────────────────────────────────────────

// The app's own settings, read as server.js reads them, from the folder it runs in.
function loadAppSettings(env) {
	if (env === process.env) require("dotenv").config({ quiet: true });
}

function openDatabase(dbPath, dryRun) {
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	const db = new Database(dbPath, dryRun ? { readonly: true, fileMustExist: true } : { fileMustExist: true });
	if (dryRun && !db.readonly) {
		db.close();
		throw new Refusal("the database did not open read-only");
	}
	if (!dryRun) {
		db.pragma("busy_timeout = 5000");
		// A send's mark reaches the disk before the SMTP call, as the job's own commit does.
		db.pragma("synchronous = FULL");
	}
	return db;
}

// Job Tracking through the app's own service account, read-only.
function sheetReader(sheetId) {
	let sheets = null;
	return async (range) => {
		if (!sheets) {
			const { google } = require("googleapis");
			const auth = new google.auth.GoogleAuth({ keyFile: path.resolve("service-account-key.json"), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
			sheets = google.sheets({ version: "v4", auth });
		}
		const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
		return (res && res.data && res.data.values) || [];
	};
}

// The app's own mailbox code (lib/imap-draft.js) and the job's own SMTP sender.
function defaultDeps({ env, sheetId }) {
	return {
		mailbox: { user: env.GMAIL_USER || "", pass: env.GMAIL_APP_PASSWORD || "" },
		readRange: sheetReader(sheetId),
		findDraftByMessageId: imapDraft.findDraftByMessageId,
		fetchMessages: imapDraft.fetchMessages,
		newMessageId: imapDraft.newMessageId,
		sendMail: sendRules.createSmtpSender({ nodemailer: require("nodemailer") }),
		uploadsRoot: path.join(ROOT, "uploads"),
		fileExists: (p) => fs.existsSync(p),
	};
}

async function main(argv, { env = process.env, loadSettings = loadAppSettings, openDb = openDatabase, deps = defaultDeps,
	stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {}) {
	try {
		const args = parseArgs(argv);
		if (String(env.LOCAL_REPLICA ?? "").trim() === "1") throw new Refusal("a replica never sends: run it in the app's folder on the server");
		const dbPath = path.resolve(args.db);
		if (!fs.existsSync(dbPath)) throw new Refusal("--db names no file");
		loadSettings(env);
		const dryRun = Boolean(args["dry-run"]);
		const db = openDb(dbPath, dryRun);
		try {
			const sheet = sheetTarget(args["sheet-id"]);
			const result = await run({ ...deps({ env, sheetId: sheet.id }), db, dryRun, max: args.max, stopAt: args["stop-at"], env, sheetLabel: sheet.label,
				out: (line) => stdout(`${line}\n`) });
			if (result.failed) {
				stderr(`failed: ${result.failed.load}: ${result.failed.what}\n`);
				return 1;
			}
			return 0;
		} finally {
			db.close();
		}
	} catch (e) {
		if (e instanceof Refusal) {
			stderr(`refused: ${e.message}\n`);
			return 2;
		}
		stderr(`failed: ${codeOf(e)}\n`);
		return 1;
	}
}

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}

module.exports = { run, main, parseArgs, readWindow, Refusal, ACTOR, STOP_REASON, MAX_DEFAULT, CONFIRM_WAITS_MS, MARK_PREFIX };
