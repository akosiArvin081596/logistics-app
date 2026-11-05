#!/usr/bin/env node
// lib/invoice-evidence.js: what's behind each load's invoice status, and the mailbox pass
// that saves it, as server.js wires them.
//
//   §1 the table: its columns, no table until something is written, nothing written while
//      the pass is off
//   §2 the re-search rules: backfill, daily, weekly, never again, not while the job is on it
//   §3 the pass: 20 loads a run, one run every 10 minutes, newest first, one at a time, the
//      load's numbers as search terms, a run in progress isn't overlapped
//   §4 a failure: a refused answer or a throttle ends the run; a login refusal stops the pass
//      for 6 hours with one notice, across a restart; a refused term doesn't; what was
//      found is never lost
//   §5 the Payments Table: one read per run, keyed on " Job ID", only filled or blank saved
//   §6 no run: the pass off, the status off, a replica, no mailbox
//   §7 the row: a Super Admin only, a Dispatcher sees none, never fails the dashboard
//   §8 savedInvoice(), what Try again's 409 reads
//   §9 the real search against a made-up mailbox: the app's own mail doesn't bill a load,
//      a real invoice does, a Bison row by its order number, no address or subject saved,
//      one session at a time, a live answer refreshes the saved row
//  §10 the export: three columns on, byte-identical off, through the route as shipped
//  §11 server.js: the block as shipped, its flags, its timer, the dashboard's one line
//
// Made-up loads only, in memory, on 127.0.0.1. No Gmail, no sheet. Fails on a tree
// without the module.
//   node scripts/test-invoice-evidence.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const tls = require("tls");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const ledger = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const factoring = require(path.join(ROOT, "lib", "factoring-store.js"));
const { csvRows } = require(path.join(ROOT, "lib", "csv.js"));
const SRC = require("./lib/server-source").serverSource();
const { liftRoute } = require("./lib/server-lift.js");

let pass = 0;
const failures = [];
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
function eq(actual, expected, label) {
	const a = canon(actual);
	const e = canon(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { console.log(`\n${t}`); }
let finished = false;
function finish() {
	finished = true;
	for (const f of failures) console.log(`  FAIL ${f}`);
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(failures.length ? 1 : 0);
}
// A promise nothing will settle ends the process with exit 0, which must not read as a pass.
process.on("exit", () => {
	if (finished) return;
	console.log("  FAIL the runner ended before its last section: something it awaited never answered");
	process.exitCode = 1;
});

let E = null;
let S = null;
try {
	E = require(path.join(ROOT, "lib", "invoice-evidence.js"));
	S = require(path.join(ROOT, "lib", "invoice-status.js"));
} catch {
	// asserted next
}
section("§1  the table");
ok(E && S, "§1 FAILS ON THE OLD CODE: lib/invoice-evidence.js exists");
if (!E || !S) finish();
const { STATUS } = S;

// ------------------------------------------------------------------ made-up data
const HEADERS = ["Load ID", "Job Status", "Email", "Driver", "Status Update Date", "Completion Date", "  Payment  "];
const OWN = "info@example.test";
const BROKER = "billing@example-broker.test";
const PASS_ON = Object.freeze({ INVOICE_MAILBOX_PASS_ENABLED: "true" });
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const BOX = Object.freeze({ hits: 0, invoice: 0, mention: 0, ignored: 0, ignoredNamed: 0, overCap: 0, firstInvoiceDate: null });
const CLEAN = Object.freeze({ verdict: "clean", mailboxes: { drafts: BOX, sent: BOX } });
const INVOICE_IN_SENT = Object.freeze({ verdict: "invoice", mailboxes: { drafts: BOX, sent: { ...BOX, hits: 1, invoice: 1, firstInvoiceDate: "2026-11-02T18:30:00.000Z" } } });
const refused = (stage, more = {}) => Object.assign(new Error(`mailbox search stopped at ${stage}`), { stage, ...more });
const PAYMENTS_HEAD = [" Job ID", "Contract ID", "Payment Amount", "Invoice Number", "Payment Date", "Payment Status"];

const createSql = (name) => {
	const at = SRC.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
	if (at < 0) throw new Error(`server.js creates no ${name} table`);
	return SRC.slice(at, SRC.indexOf("`", at));
};
const load = (id, over = {}) => ({ "Load ID": id, "Job Status": "Delivered", Email: BROKER, Driver: "Made-up Driver", "Status Update Date": "", "Completion Date": "2026-11-01", "  Payment  ": "$1,500.00", ...over });

function world({ env = PASS_ON, replica = false, mailbox = { user: OWN, pass: "made-up-app-password" }, loads = [], payments = [PAYMENTS_HEAD], closedMonthsOf = () => [], jobTables = true, sweepOn = false } = {}) {
	const db = new Database(":memory:");
	db.exec(createSql("load_invoice_drafts"));
	db.exec(createSql("app_settings"));
	if (jobTables) {
		ledger.ensureSchema(db);
		factoring.ensureSchema(db);
	}
	const w = { db, loads, payments, clock: NOW, searches: [], answers: new Map(), notices: [], logs: [], intervals: [], sheetReads: 0, loadReads: 0, active: 0, most: 0 };
	w.search = async (opts) => {
		w.searches.push(opts);
		w.active++;
		w.most = Math.max(w.most, w.active);
		try {
			await Promise.resolve();
			const a = w.answers.get(opts.loadNumber);
			const answer = typeof a === "function" ? await a(opts) : a;
			if (answer instanceof Error) throw answer;
			return answer === undefined ? CLEAN : answer;
		} finally {
			w.active--;
		}
	};
	w.deps = {
		db,
		env,
		replica,
		mailbox: () => mailbox,
		readCompletedLoads: async () => { w.loadReads++; return { headers: HEADERS, rows: w.loads }; },
		readPaymentsTable: async () => { w.sheetReads++; if (w.payments instanceof Error) throw w.payments; return w.payments; },
		closedMonthsOf,
		dayKeyOf: (cell) => (/^\d{4}-\d{2}-\d{2}$/.test(String(cell || "")) ? cell : ""),
		sweepOn: () => sweepOn,
		notify: (n) => w.notices.push(n),
		now: () => new Date(w.clock),
		log: { log() {}, warn: (...a) => w.logs.push(a.join(" ")), error: (...a) => w.logs.push(a.join(" ")) },
		search: w.search,
		gapMs: 0,
		setInterval: (fn, ms) => { w.intervals.push({ fn, ms }); return 0; },
		timeZone: "America/New_York",
	};
	w.store = E.create(w.deps);
	w.row = (key) => E.savedRow(db, key);
	w.rowFor = (id) => {
		const rows = [{ ...w.loads.find((l) => l["Load ID"] === id) }];
		w.store.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: true });
		return rows[0]._invoiceStatus;
	};
	w.addRow = (id, over = {}) => db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, order_number, via, recipient, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.run(id, over.invoice_id || "11012026-1", over.order_number || "", over.via === undefined ? "imap" : over.via, over.recipient || BROKER, over.created_at || "2026-11-01T15:00:00Z");
	w.addClaim = (id, { state = "baseline", reason_code: code = "", ...patch } = {}) => {
		ledger.insertClaim(db, { key: id.toLowerCase(), loadId: id, state, code, nowIso: iso(NOW) });
		if (Object.keys(patch).length) ledger.transition(db, id.toLowerCase(), { from: [state], patch, nowIso: iso(NOW) });
	};
	return w;
}

// ------------------------------------------------------------------ a mailbox
// LOGIN, CAPABILITY, EXAMINE, SEARCH X-GM-RAW and FETCH, as Gmail answers them; anything
// else is BAD. Finds a term in the subject, an attachment name or the text.
function fakeMailbox() {
	const boxes = { "[Gmail]/Drafts": [], "[Gmail]/Sent Mail": [], "[Gmail]/Trash": [] };
	const f = { boxes, sessions: 0, commands: [], trace: [], refuse: {} };
	f.server = net.createServer((sock) => {
		const session = ++f.sessions;
		sock.on("error", () => {});
		let buf = "";
		let box = null;
		const reply = (line) => sock.write(`${line}\r\n`);
		reply("* OK Gimap ready");
		sock.on("data", (chunk) => {
			buf += chunk.toString("latin1");
			let eol;
			while ((eol = buf.indexOf("\r\n")) >= 0) {
				const line = buf.slice(0, eol);
				buf = buf.slice(eol + 2);
				const [tag, word = ""] = line.split(" ", 2);
				const verb = word.toUpperCase();
				const args = line.slice(tag.length + word.length + 2);
				f.commands.push(verb);
				f.trace.push([session, verb]);
				if (f.refuse[verb]) { reply(`${tag} ${f.refuse[verb]}`); continue; }
				if (verb === "LOGIN") reply(`${tag} OK authenticated (Success)`);
				else if (verb === "CAPABILITY") { reply("* CAPABILITY IMAP4rev1 X-GM-EXT-1"); reply(`${tag} OK Success`); }
				else if (verb === "EXAMINE") {
					box = args.slice(1, -1);
					reply(`* ${(boxes[box] || []).length} EXISTS`);
					reply(`${tag} OK [READ-ONLY] selected. (Success)`);
				} else if (verb === "SEARCH") {
					const m = /^X-GM-RAW "(?:in:trash )?\\"([^"\\]{1,80})\\""$/.exec(args);
					if (!m) { reply(`${tag} BAD Could not parse command`); continue; }
					const term = m[1].toLowerCase();
					const hits = (boxes[box] || []).map((x, i) => ([x.subject, ...(x.names || []), x.text].some((t) => String(t || "").toLowerCase().includes(term)) ? i + 1 : 0)).filter(Boolean);
					reply(`* SEARCH${hits.map((n) => ` ${n}`).join("")}`);
					reply(`${tag} OK SEARCH completed (Success)`);
				} else if (verb === "FETCH") {
					const ask = /^([\d,]{1,200}) \(BODY\.PEEK\[HEADER\.FIELDS \(([A-Z ]{1,40})\)\] BODYSTRUCTURE\)$/.exec(args);
					if (!ask) { reply(`${tag} BAD Could not parse command`); continue; }
					const pieces = ask[1].split(",").map(Number).map((n) => {
						const m = boxes[box][n - 1];
						const block = `${ask[2].split(" ").map((h) => {
							const v = { SUBJECT: m.subject, DATE: m.date, TO: m.to, CC: m.cc, BCC: m.bcc }[h];
							return v ? `${h[0]}${h.slice(1).toLowerCase()}: ${v}\r\n` : "";
						}).join("")}\r\n`;
						const parts = (m.names || []).map((x) => `("APPLICATION" "PDF" ("NAME" "${x}") NIL NIL "BASE64" 10 NIL ("ATTACHMENT" ("FILENAME" "${x}")) NIL)`).join("");
						const structure = parts ? `(("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1 NIL NIL NIL)${parts} "MIXED")` : '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1 NIL NIL NIL)';
						return `* ${n} FETCH (BODYSTRUCTURE ${structure} BODY[HEADER.FIELDS (${ask[2]})] {${Buffer.byteLength(block, "latin1")}}\r\n${block})\r\n`;
					});
					sock.write(Buffer.from(`${pieces.join("")}${tag} OK Success\r\n`, "latin1"));
				} else if (verb === "LOGOUT") {
					reply("* BYE LOGOUT Requested");
					reply(`${tag} OK 73 good day (Success)`);
					sock.end();
					return;
				} else reply(`${tag} BAD Could not parse command`);
			}
		});
	});
	return f;
}

async function main() {
	{
		const w = world({ env: {}, loads: [load("900000001")] });
		const rows = [{ ...w.loads[0] }];
		w.store.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin: true });
		w.store.exportColumns({ headers: HEADERS }).cells(w.loads[0]);
		eq(w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(E.TABLE).length, 0, "§1 the status on, the pass off: reading statuses makes no table, so the deploy writes nothing");
		eq(rows[0]._invoiceStatus, { status: STATUS.UNKNOWN, code: "NOT_SEARCHED" }, "§1 ...and a load with no record reads not looked at, never No invoice found");
	}
	{
		const w = world({ loads: [load("900000001")] });
		await w.store.runOnce();
		eq(w.db.prepare(`PRAGMA table_info(${E.TABLE})`).all().map((c) => c.name).sort(), [
			"drafts_invoice", "drafts_mention", "first_sent_at", "load_key", "payments_checked_at", "payments_invoice_number", "payments_payment_date", "payments_status",
			"result", "searched_at", "sent_invoice", "sent_mention", "tried_at", "updated_at",
		], "§1 the table's columns, each a count, a flag, a time or a result: nothing that could hold an address or a subject");
		eq(E.TABLE, "invoice_status_evidence", "§1 its name");
		let threw = "";
		try {
			w.db.prepare(`UPDATE ${E.TABLE} SET result = 'an address' WHERE load_key = ?`).run("900000001");
		} catch (e) { threw = e.code; }
		eq(threw, "SQLITE_CONSTRAINT_CHECK", "§1 `result` takes only its own values");
	}

	// ================================================================= §2
	section("§2  the re-search rules");
	const next = (read, saved, deliveredDay = "2026-11-01") => E.nextSearchAt({ read, saved, deliveredDay, nowMs: NOW });
	const NONE = { status: STATUS.NONE_FOUND };
	const triedAgo = (days, over = {}) => ({ tried_at: iso(NOW - days * DAY), result: "answered", sent_invoice: 0, ...over });
	eq(next(NONE, null), 0, "§2 never searched: now");
	eq(next({ status: STATUS.UNKNOWN, code: "NOT_SEARCHED" }, { tried_at: "" }), 0, "§2 a row with no search yet (the Payments Table's own): now");
	eq(next(NONE, triedAgo(1)), NOW - DAY + 7 * DAY, "§2 No invoice found: weekly");
	eq(next({ status: STATUS.DRAFT, whose: "job" }, triedAgo(1)), NOW, "§2 a draft not yet seen in Sent Mail, delivered lately: daily");
	eq(next({ status: STATUS.DRAFT, whose: "job" }, triedAgo(1), "2026-09-01"), NOW - DAY + 7 * DAY, "§2 ...over 30 days after delivery: weekly, so it doesn't go stale for good");
	eq(next({ status: STATUS.ATTENTION, code: "TOTAL_MISMATCH" }, triedAgo(1)), NOW, "§2 Needs attention: daily");
	eq(next({ status: STATUS.UNKNOWN, code: "MENTIONED" }, triedAgo(1)), NOW, "§2 a mention: daily");
	eq(next({ status: STATUS.UNKNOWN, code: "SEARCH_FAILED" }, triedAgo(1, { result: "failed" })), NOW, "§2 a failed search: daily");
	eq(next({ status: STATUS.UNKNOWN, code: "SEARCH_FAILED" }, triedAgo(1, { result: "failed" }), "2026-08-01"), NOW - DAY + 7 * DAY, "§2 ...old: weekly");
	eq(next({ status: STATUS.UNKNOWN, code: "MENTIONED" }, triedAgo(1), ""), NOW - DAY + 7 * DAY, "§2 a load with no delivery date counts as old");
	eq(next({ status: STATUS.BY_HAND, found: "sent_mail" }, triedAgo(1, { sent_invoice: 1 })), null, "§2 found in Sent Mail: never again");
	eq(next({ status: STATUS.SENT }, null), null, "§2 sent by LogisX: never");
	eq(next({ status: STATUS.FACTORED }, null), null, "§2 factored: never");
	eq(next({ status: STATUS.WAITING }, null), null, "§2 the job is on it: not now");
	eq(next({ status: STATUS.BY_HAND, found: "payments_table" }, triedAgo(1)), NOW - DAY + 7 * DAY, "§2 billed on the Payments Table: weekly");
	eq(next({ status: STATUS.UNKNOWN, code: "BISON_ORDER_NUMBER" }, triedAgo(1)), NOW - DAY + 7 * DAY, "§2 a Bison load no search can clear: weekly");

	// ================================================================= §3
	section("§3  the pass: 20 loads a run, one run every 10 minutes, newest first");
	eq([E.MAX_PER_RUN, E.RUN_EVERY_MS], [20, 10 * 60 * 1000], "§3 at most 20 loads a run, one run every 10 minutes: 120 an hour");
	{
		const days = Array.from({ length: 25 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
		const loads = days.map((day, i) => load(`9000001${String(i).padStart(2, "0")}`, { "Completion Date": day }));
		loads.push(load("900000199", { "Completion Date": "" }));
		const w = world({ loads });
		const first = await w.store.runOnce();
		eq(first, { ran: true, searched: 20, failed: 0, stoppedAt: "", payments: true }, "§3 the first run: 20 searched");
		eq(w.searches.map((s) => s.loadNumber).slice(0, 3), ["900000124", "900000123", "900000122"], "§3 backfill: newest first");
		eq(w.searches.length, 20, "§3 ...and no more than 20");
		eq(w.most, 1, "§3 one session at a time");
		ok(w.searches.every((s) => s.quiet === true && s.user === OWN && !s.lastCheck && !s.includeTrash), "§3 the mailbox's login, Drafts and Sent Mail only, and quiet: the pass saves its own answers");
		await w.store.runOnce();
		eq(w.searches.length, 26, "§3 the next run takes the rest");
		eq(w.searches[25].loadNumber, "900000199", "§3 a load with no date comes last");
		await w.store.runOnce();
		eq(w.searches.length, 26, "§3 nothing due: a run with nothing to do searches nothing");
		w.clock = NOW + 8 * DAY;
		await w.store.runOnce();
		eq(w.searches.length, 46, "§3 a week on, No invoice found comes round again, 20 at a time");
		eq(w.row("900000100").searched_at, iso(NOW + 8 * DAY), "§3 ...oldest first, the saved row updated");
	}
	{
		const w = world({ loads: [load("900000201"), load("900000202", { "Job Status": "In Transit" })] });
		w.addRow("900000201", { invoice_id: "11012026-5", order_number: "#7000001" });
		w.addRow("#900000201", { invoice_id: "11012026-6", order_number: "", via: "n8n" });
		await w.store.runOnce();
		eq(w.searches.map((s) => s.loadNumber), ["900000201"], "§3 only a completed load is searched");
		eq([w.searches[0].invoiceNumbers, w.searches[0].orderNumbers], [["11012026-5", "11012026-6"], ["#7000001"]], "§3 each row's invoice and order number are search terms, either spelling of the load");
	}
	{
		const w = world({ loads: [load("900000211"), load("900000212"), load("900000213"), load("900000214"), load("900000215")] });
		w.addClaim("900000211", { state: "drafted", delivery: "send", stage: "recorded", invoice_id: "11012026-1" });
		w.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES (?, ?, 1, 'person', ?, ?)").run("900000212", "900000212", iso(NOW), iso(NOW));
		w.addClaim("900000213", { state: "queued" });
		w.addClaim("900000214", { state: "needs_attention", reason_code: "TOTAL_MISMATCH", invoice_id: "11012026-9", number_voided_at: iso(NOW) });
		await w.store.runOnce();
		eq(w.searches.map((s) => s.loadNumber), ["900000214", "900000215"], "§3 sent by LogisX, factored and a load the job is on aren't searched");
		eq(w.searches[0].invoiceNumbers, [], "§3 a number given up isn't a search term");
		w.addClaim("900000215", { state: "needs_attention", reason_code: "TOTAL_MISMATCH", invoice_id: "11012026-8" });
		w.clock = NOW + 2 * DAY;
		await w.store.runOnce();
		ok(w.searches.at(-1).invoiceNumbers.includes("11012026-8"), "§3 a number the job holds is one");
	}
	{
		const w = world({ loads: [load("900000221")] });
		let release;
		w.answers.set("900000221", () => new Promise((r) => { release = r; }));
		const running = w.store.runOnce();
		await new Promise((r) => setImmediate(r));
		eq(await w.store.runOnce(), { ran: false, why: "RUNNING" }, "§3 a run still going isn't overlapped");
		release(CLEAN);
		await running;
		eq(w.searches.length, 1, "§3 ...one search");
		w.store.start();
		w.store.start();
		eq(w.intervals.map((i) => i.ms), [10 * 60 * 1000], "§3 start(): one timer, every 10 minutes");
	}
	{
		const w = world({ loads: [load("900000231")] });
		const broken = E.create({ ...w.deps, readCompletedLoads: async () => { throw Object.assign(new Error("made up: Sheets said 500 about billing@example-broker.test"), { code: 500 }); } });
		eq((await broken.runOnce()).ran, true, "§3 the sheet can't be read: the run ends, it doesn't throw");
		eq(w.searches.length, 0, "§3 ...and searches nothing");
		ok(!w.logs.join(" ").includes("example-broker"), "§3 ...logging a code, never the error's text");
	}

	{
		const w = world({ loads: [load("900000241"), load("900000242")] });
		const at = [];
		const { gapMs, ...deps } = w.deps;
		const store = E.create({ ...deps, search: async () => { at.push(Date.now()); return CLEAN; } });
		await store.runOnce();
		eq(gapMs, 0, "§3 (fixture) the other cases run with no gap");
		ok(at.length === 2 && at[1] - at[0] >= 900, "§3 a second between one load's session and the next, by default");
		eq(w.intervals.length, 0, "§3 ...and a run starts no timer of its own");
	}

	// ================================================================= §4
	section("§4  a failure ends the run, and what was found stays found");
	{
		for (const [name, err] of [
			["a NO", refused("search", { answered: true })],
			["a BAD", refused("fetch", { answered: true })],
			["a dropped connection", refused("search")],
			["an unreadable answer", refused("fetch")],
		]) {
			const w = world({ loads: [load("900000301", { "Completion Date": "2026-11-03" }), load("900000302", { "Completion Date": "2026-11-02" })] });
			w.answers.set("900000301", err);
			const run = await w.store.runOnce();
			eq([run.searched, run.failed, run.stoppedAt, w.searches.length], [0, 1, err.stage, 1], `§4 ${name} ends the run: the next load isn't searched`);
			eq(w.row("900000301").result, "failed", `§4 ...and that load reads failed`);
			eq(w.rowFor("900000301"), { status: STATUS.UNKNOWN, code: "SEARCH_FAILED" }, "§4 ...Couldn't check, never No invoice found");
			eq(w.notices.length, 0, "§4 ...with no notice: it's tried again next run");
			eq(w.row("900000302"), null, "§4 ...and the next load has no row");
		}
		const w = world({ loads: [load("900000311", { "Completion Date": "2026-11-03" }), load("900000312", { "Completion Date": "2026-11-02" })] });
		w.answers.set("900000311", refused("terms"));
		const run = await w.store.runOnce();
		eq([run.searched, run.failed, w.searches.length], [1, 1, 2], "§4 a term that fails the shape touches no mailbox: the run goes on");
		eq(w.rowFor("900000311"), { status: STATUS.UNKNOWN, code: "SEARCH_FAILED" }, "§4 ...and that load reads Couldn't check");

		const lost = world({ loads: [load("900000321")] });
		lost.answers.set("900000321", INVOICE_IN_SENT);
		await lost.store.runOnce();
		eq(lost.rowFor("900000321"), { status: STATUS.BY_HAND, found: "sent_mail", date: "2026-11-02" }, "§4 an invoice in Sent Mail");
		E.saveFailure(lost.db, "900000321", { nowIso: iso(NOW + DAY) });
		eq(lost.rowFor("900000321"), { status: STATUS.BY_HAND, found: "sent_mail", date: "2026-11-02" }, "§4 a later failure doesn't lose it");
		E.saveAnswer(lost.db, "900000321", CLEAN, { nowIso: iso(NOW + 2 * DAY) });
		eq(lost.rowFor("900000321"), { status: STATUS.BY_HAND, found: "sent_mail", date: "2026-11-02" }, "§4 nor does a later clean answer: a copy deleted from Sent Mail doesn't unbill the load");
		E.saveAnswer(lost.db, "900000321", { verdict: "invoice", mailboxes: { drafts: BOX, sent: { ...BOX, invoice: 1, firstInvoiceDate: "2026-11-01T10:00:00.000Z" } } }, { nowIso: iso(NOW + 3 * DAY) });
		eq(lost.row("900000321").first_sent_at, "2026-11-01T10:00:00.000Z", "§4 the first date seen is kept");

		const moved = world({ loads: [load("900000322")] });
		moved.answers.set("900000322", { verdict: "invoice", mailboxes: { drafts: { ...BOX, invoice: 1 }, sent: BOX } });
		await moved.store.runOnce();
		eq(moved.row("900000322").drafts_invoice, 1, "§4 an invoice in Drafts");
		E.saveAnswer(moved.db, "900000322", CLEAN, { nowIso: iso(NOW + DAY) });
		eq(moved.row("900000322").drafts_invoice, 0, "§4 Drafts is as of the last search: a draft can go");

		const odd = world({ loads: [load("900000323")] });
		E.saveAnswer(odd.db, "900000323", { verdict: "made up" }, { nowIso: iso(NOW) });
		eq(odd.row("900000323").result, "failed", "§4 an answer it can't read is a failure, never clean");
		E.saveAnswer(odd.db, "900000323", { verdict: "mention", mailboxes: { drafts: BOX, sent: BOX } }, { nowIso: iso(NOW) });
		eq(odd.row("900000323").sent_mention, 1, "§4 doubt with no counts behind it is still doubt");
		E.saveAnswer(odd.db, "900000323", { verdict: "mention", mailboxes: { drafts: { ...BOX, overCap: 3 }, sent: BOX } }, { nowIso: iso(NOW) });
		eq([odd.row("900000323").drafts_mention, odd.row("900000323").sent_mention], [3, 0], "§4 hits never read count as doubt");
		E.saveAnswer(odd.db, "900000323", { verdict: "invoice", mailboxes: { drafts: BOX, sent: BOX, trash: { ...BOX, invoice: 1 } } }, { nowIso: iso(NOW) });
		eq([odd.row("900000323").sent_invoice, odd.row("900000323").sent_mention], [0, 1], "§4 an invoice in Trash is doubt, not an invoice sent");
		E.saveAnswer(odd.db, "900000323", { verdict: "mention", mailboxes: { drafts: { ...BOX, mention: 1 }, sent: BOX, trash: { ...BOX, invoice: 1 } } }, { nowIso: iso(NOW) });
		eq([odd.row("900000323").drafts_mention, odd.row("900000323").sent_mention], [1, 1], "§4 ...beside a mention in Drafts too");
	}
	{
		const w = world({ loads: [load("900000331", { "Completion Date": "2026-11-03" }), load("900000332", { "Completion Date": "2026-11-02" })] });
		w.answers.set("900000331", refused("login", { answered: true }));
		const run = await w.store.runOnce();
		eq([run.failed, run.stoppedAt, run.paused], [1, "login", true], "§4 a login refusal ends the run");
		eq(w.notices.length, 1, "§4 ...with one Super Admin notice");
		ok(!/@/.test(JSON.stringify(w.notices)), "§4 ...naming no address");
		eq(await w.store.runOnce(), { ran: false, why: "PAUSED" }, "§4 no run for 6 hours");
		w.clock = NOW + 6 * 60 * 60 * 1000 - 1000;
		eq(await w.store.runOnce(), { ran: false, why: "PAUSED" }, "§4 ...to the second");
		eq(w.searches.length, 1, "§4 ...and no login tried");

		const restarted = E.create({ ...w.deps });
		eq(await restarted.runOnce(), { ran: false, why: "PAUSED" }, "§4 the stop outlives a restart");

		w.clock = NOW + 6 * 60 * 60 * 1000 + 1000;
		w.answers.set("900000332", refused("login", { answered: true }));
		const again = await w.store.runOnce();
		eq([again.stoppedAt, w.notices.length], ["login", 1], "§4 refused again after 6 hours: stopped again, and no second notice");
		eq(await w.store.runOnce(), { ran: false, why: "PAUSED" }, "§4 ...for another 6 hours");

		w.clock += 2 * DAY;
		w.answers.clear();
		const fine = await w.store.runOnce();
		eq(fine.searched, 2, "§4 the login works again: the pass goes on");
		w.answers.set("900000331", refused("login", { answered: true }));
		w.answers.set("900000332", refused("login", { answered: true }));
		w.clock += 8 * DAY;
		await w.store.runOnce();
		eq(w.notices.length, 2, "§4 a new stop after it worked again gets its one notice");

		const dropped = world({ loads: [load("900000333")] });
		dropped.answers.set("900000333", refused("login"));
		await dropped.store.runOnce();
		eq([dropped.notices.length, (await dropped.store.runOnce()).ran], [0, true], "§4 a connection lost at login isn't a refusal: no stop");

		const slow = world({ loads: [load("900000334"), load("900000335")] });
		slow.answers.set("900000334", refused("search", { answered: true, throttled: true }));
		const run2 = await slow.store.runOnce();
		eq([run2.paused, slow.notices.length, slow.searches.length], [true, 1, 1], "§4 a throttle stops the pass the same way: this mailbox also sends invoices");
		eq(await slow.store.runOnce(), { ran: false, why: "PAUSED" }, "§4 ...for 6 hours");
	}

	// ================================================================= §5
	section("§5  the Payments Table: one read per run, only filled or blank saved");
	{
		const w = world({ loads: [load("900000401"), load("900000402"), load("900000403"), load("900000404"), load("900000405")], payments: [
			PAYMENTS_HEAD,
			[" #900000401 ", "C-1", "1500", "INV-MADE-UP-1", "", ""],
			["900000402", "C-2", "1500", "", "2026-11-02", ""],
			["900000403", "C-3", "1500", "", "", "Paid in made-up full"],
			["900000404", "C-4", "1500", "", "", "   "],
			["900000404", "C-4", "1500", "", "", ""],
			["900000499", "C-9", "1500", "INV-MADE-UP-9", "", ""],
		] });
		await w.store.runOnce();
		eq(w.sheetReads, 1, "§5 one sheet read per run");
		eq([w.row("900000401").payments_invoice_number, w.row("900000401").payments_payment_date, w.row("900000401").payments_status], [1, 0, 0], "§5 Invoice Number filled, by its key, whatever the # and spaces");
		eq([w.row("900000402").payments_invoice_number, w.row("900000402").payments_payment_date, w.row("900000402").payments_status], [0, 1, 0], "§5 Payment Date filled");
		eq([w.row("900000403").payments_invoice_number, w.row("900000403").payments_payment_date, w.row("900000403").payments_status], [0, 0, 1], "§5 Payment Status filled");
		eq([w.row("900000404").payments_status, Boolean(w.row("900000404").payments_checked_at)], [0, true], "§5 a blank or spaces-only cell is blank, and the load counts as checked");
		eq([w.row("900000405").payments_invoice_number, Boolean(w.row("900000405").payments_checked_at)], [0, true], "§5 no row at all: blank, checked");
		eq(w.row("900000499"), null, "§5 a Payments Table row with no completed load saves nothing");
		const dump = JSON.stringify(w.db.prepare(`SELECT * FROM ${E.TABLE}`).all());
		ok(!dump.includes("INV-MADE-UP") && !dump.includes("Paid in made-up") && !dump.includes("C-1") && !dump.includes("1500"), "§5 never the values");
		eq(w.rowFor("900000401"), { status: STATUS.BY_HAND, found: "payments_table" }, "§5 a filled cell reads Invoiced by hand (Payments Table)");
		eq(w.rowFor("900000404"), { status: STATUS.NONE_FOUND, searchedAt: iso(NOW) }, "§5 ...a blank one reads by the mailbox");

		// Filled later: seen on the next run, with no new search; cleared later, the same.
		w.payments = [PAYMENTS_HEAD, ["900000404", "C-4", "1500", "INV-MADE-UP-4", "", ""], ["900000401", "C-1", "1500", "", "", ""]];
		const before = w.searches.length;
		w.clock = NOW + 10 * 60 * 1000;
		await w.store.runOnce();
		eq([w.searches.length - before, w.sheetReads], [0, 2], "§5 the next run reads the table again, with no search due");
		eq(w.rowFor("900000404"), { status: STATUS.BY_HAND, found: "payments_table" }, "§5 a cell filled since reads billed within one run, on an old load too");
		eq(w.rowFor("900000401"), { status: STATUS.NONE_FOUND, searchedAt: iso(NOW) }, "§5 a cell cleared since reads by the mailbox again");
		const updated = w.row("900000404").updated_at;
		w.clock = NOW + 20 * 60 * 1000;
		await w.store.runOnce();
		eq(w.row("900000404").updated_at, updated, "§5 a run that changes nothing writes nothing");
	}
	{
		for (const [name, payments] of [
			["the sheet read fails", Object.assign(new Error("made up: quota for billing@example-broker.test"), { code: 429 })],
			["a column is missing", [[" Job ID", "Invoice Number", "Payment Date"]]],
			["the tab is empty", []],
		]) {
			const w = world({ loads: [load("900000411")], payments });
			await w.store.runOnce();
			eq(w.rowFor("900000411"), { status: STATUS.UNKNOWN, code: "PAYMENTS_NOT_READ" }, `§5 ${name}: a clean mailbox isn't enough for No invoice found`);
			ok(w.logs.some((l) => /Payments Table/.test(l)) && !w.logs.join(" ").includes("example-broker"), `§5 ${name}: logged by its code alone`);
			w.payments = [PAYMENTS_HEAD];
			await w.store.runOnce();
			eq(w.rowFor("900000411"), { status: STATUS.NONE_FOUND, searchedAt: iso(NOW) }, `§5 ${name}: read on the next run, it clears with no new search`);
			eq(w.searches.length, 1, `§5 ${name}: ...one search`);
		}
	}

	// ================================================================= §6
	section("§6  no run: the pass off, the status off, a replica, no mailbox");
	eq(E.passEnabled({}), false, "§6 INVOICE_MAILBOX_PASS_ENABLED unset: off");
	for (const v of ["", "false", "1", "yes", "on", "TRUE"]) eq(E.passEnabled({ INVOICE_MAILBOX_PASS_ENABLED: v }), false, `§6 ${JSON.stringify(v)}: off, only exactly "true" turns it on`);
	eq(E.passEnabled({ INVOICE_MAILBOX_PASS_ENABLED: "true" }), true, "§6 exactly \"true\": on");
	for (const [name, opts, why] of [
		["the default settings", { env: {} }, "OFF"],
		["the status switched off", { env: { ...PASS_ON, INVOICE_STATUS_ENABLED: "false" } }, "OFF"],
		["a replica, the flag set", { replica: true }, "OFF"],
		["no mailbox set", { mailbox: { user: "", pass: "" } }, "NO_MAILBOX"],
		["a mailbox with no password (a replica's)", { mailbox: { user: OWN, pass: "" } }, "NO_MAILBOX"],
	]) {
		const w = world({ ...opts, loads: [load("900000501")] });
		eq(await w.store.runOnce(), { ran: false, why }, `§6 ${name}: no run`);
		eq([w.searches.length, w.sheetReads, w.loadReads, w.row("900000501")], [0, 0, 0, null], `§6 ${name}: no mailbox, no sheet, nothing saved`);
		eq(w.rowFor("900000501") && w.rowFor("900000501").status, opts.env && opts.env.INVOICE_STATUS_ENABLED === "false" ? undefined : STATUS.UNKNOWN, `§6 ${name}: the load reads Couldn't check (or no status at all)`);
		if (why === "OFF") {
			w.store.start();
			eq(w.intervals.length, 0, `§6 ${name}: start() starts no timer`);
		}
	}

	// ================================================================= §7
	section("§7  the row: a Super Admin only");
	{
		const w = world({ env: {}, loads: [load("900000601")] });
		const annotate = (isSuperAdmin, rows = [{ ...w.loads[0] }]) => { w.store.annotateCompletedRows({ rows, headers: HEADERS, isSuperAdmin }); return rows[0]; };
		eq(annotate(true)._invoiceStatus, { status: STATUS.UNKNOWN, code: "NOT_SEARCHED" }, "§7 a Super Admin's row gets its status");
		ok(!("_invoiceStatus" in annotate(false)), "§7 a Dispatcher's row gets none");
		ok(!("_invoiceStatus" in annotate(undefined)), "§7 no role given: none");
		ok(!("_invoiceStatus" in annotate("Super Admin")), "§7 only exactly true counts");
		const off = world({ env: { INVOICE_STATUS_ENABLED: "off" }, loads: [load("900000601")] });
		const offRow = { ...off.loads[0] };
		off.store.annotateCompletedRows({ rows: [offRow], headers: HEADERS, isSuperAdmin: true });
		ok(!("_invoiceStatus" in offRow), "§7 the kill switch: no status");
		eq(off.store.exportColumns({ headers: HEADERS }), null, "§7 ...and no CSV columns");
		eq(off.store.statusOn, false, "§7 ...the store says so");
		eq(w.store.annotateCompletedRows({ rows: [], headers: HEADERS, isSuperAdmin: true }), [], "§7 no rows: nothing to do");

		const factored = world({ env: {}, loads: [load("900000602")] });
		factored.db.exec("DROP TABLE load_factoring; CREATE VIEW load_factoring AS SELECT * FROM a_table_that_is_not_there");
		const fr = { ...factored.loads[0] };
		factored.store.annotateCompletedRows({ rows: [fr], headers: HEADERS, isSuperAdmin: true });
		eq(fr._invoiceStatus, { status: STATUS.UNKNOWN, code: "FACTORING_UNREADABLE" }, "§7 rule 1 through the store: a marker that can't be read");

		const broken = world({ env: {}, loads: [load("900000603")] });
		broken.db.exec("DROP TABLE auto_invoice_claims; CREATE VIEW auto_invoice_claims AS SELECT * FROM a_table_that_is_not_there");
		const br = { ...broken.loads[0] };
		let threw = false;
		try {
			broken.store.annotateCompletedRows({ rows: [br], headers: HEADERS, isSuperAdmin: true });
		} catch {
			threw = true;
		}
		eq([threw, br._invoiceStatus], [false, { status: STATUS.UNKNOWN, code: "EVIDENCE_UNREADABLE" }], "§7 anything else that can't be read: Couldn't check, and the dashboard still answers");
		eq(broken.store.exportColumns({ headers: HEADERS }).cells(broken.loads[0]), ["Couldn't check", "", ""], "§7 ...and the CSV too");

		const bare = world({ env: {}, jobTables: false, loads: [load("900000604")] });
		eq(bare.rowFor("900000604"), { status: STATUS.UNKNOWN, code: "NOT_SEARCHED" }, "§7 the job never on (no claim, factoring or evidence tables): not looked at");

		const closedAsked = [];
		const shut = world({ loads: [load("900000605")], closedMonthsOf: (h, row) => { closedAsked.push(row["Load ID"]); return ["2026-09"]; } });
		shut.addRow("900000605");
		await shut.store.runOnce();
		eq(shut.rowFor("900000605"), { status: STATUS.UNKNOWN, code: "DRAFT_NOT_IN_GMAIL", invoiceId: "11012026-1" }, "§7 a closed month's row, in neither mailbox: Couldn't check");
		ok(closedAsked.includes("900000605"), "§7 ...read through closedMonthsOf()");

		const bison = world({ loads: [load("900000606", { Email: "ops@bisontransport.com" })] });
		await bison.store.runOnce();
		eq(bison.rowFor("900000606"), { status: STATUS.UNKNOWN, code: "BISON_ORDER_NUMBER" }, "§7 a Bison load by its Email cell");

		const swept = world({ env: {}, sweepOn: true, loads: [load("900000607")] });
		swept.addClaim("900000607", { state: "waiting", reason_code: "WAITING_POD" });
		eq(swept.rowFor("900000607"), { status: STATUS.WAITING, code: "WAITING_POD" }, "§7 the sweep on: a waiting claim reads Waiting");
		const trigger = world({ env: {}, sweepOn: false, loads: [load("900000607")] });
		trigger.addClaim("900000607", { state: "waiting", reason_code: "WAITING_POD" });
		eq(trigger.rowFor("900000607"), { status: STATUS.UNKNOWN, code: "NOT_SEARCHED" }, "§7 the sweep off: it doesn't");

		const pressed = world({ env: {}, loads: [load("900000611"), load("900000612"), load("900000613")] });
		const press = pressed.db.prepare("INSERT INTO invoice_draft_inflight (load_key, load_id, invoice_id, path, state, started_at, updated_at) VALUES (?, ?, ?, 'imap', ?, ?, ?)");
		press.run("900000611", "900000611", "11052026-1", "in_flight", iso(NOW - 60 * 1000), iso(NOW));
		press.run("900000612", "900000612", "11052026-2", "in_flight", iso(NOW - 20 * 60 * 1000), iso(NOW));
		press.run("900000613", "900000613", "11052026-3", "maybe_drafted", iso(NOW - 60 * 1000), iso(NOW));
		eq(pressed.rowFor("900000611"), { status: STATUS.WAITING, code: "HAND_DRAFT_IN_FLIGHT" }, "§7 a press row in flight, through the store");
		eq(pressed.rowFor("900000612"), { status: STATUS.ATTENTION, code: "INVOICE_MAYBE_DRAFTED" }, "§7 ...one in flight too long reads maybe drafted");
		eq(pressed.rowFor("900000613"), { status: STATUS.ATTENTION, code: "INVOICE_MAYBE_DRAFTED" }, "§7 ...and one marked so");

		const handed = world({ env: {}, loads: [load("900000621"), load("900000622"), load("900000623")] });
		const submit = handed.db.prepare("INSERT INTO triumph_submissions (load_key, load_id, state, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)");
		submit.run("900000621", "900000621", "submitted", iso(NOW), iso(NOW));
		submit.run("900000622", "900000622", "closed_outside", iso(NOW), iso(NOW));
		submit.run("900000623", "900000623", "waiting", iso(NOW), iso(NOW));
		eq(handed.rowFor("900000621"), { status: STATUS.FACTORED }, "§7 a Triumph submission that went reads Factored, through the store");
		eq(handed.rowFor("900000622"), { status: STATUS.FACTORED }, "§7 ...one handled outside the app too");
		eq(handed.rowFor("900000623"), { status: STATUS.UNKNOWN, code: "NOT_SEARCHED" }, "§7 ...one still waiting doesn't");

		const hashed = world({ env: {}, loads: [load("#900000631", { Email: "ops@example-broker.test" })] });
		hashed.addRow("900000631");
		eq(hashed.rowFor("#900000631").invoiceId, "11012026-1", "§7 either spelling of a load finds its rows");

		const dated = world({ env: {}, loads: [load("900000608")] });
		E.saveAnswer(dated.db, "900000608", { verdict: "invoice", mailboxes: { drafts: BOX, sent: { ...BOX, invoice: 1, firstInvoiceDate: "2026-11-02T02:30:00.000Z" } } }, { nowIso: iso(NOW) });
		eq(dated.rowFor("900000608").date, "2026-11-01", "§7 a date is the day in the app's zone: 02:30 UTC is the evening before in the East");

		const again = world({ env: {}, loads: [load("900000609"), load("900000610")] });
		E.saveAnswer(again.db, "900000609", INVOICE_IN_SENT, { nowIso: iso(NOW) });
		const tryRows = [
			{ ...again.loads[0], _autoInvoice: { state: "needs_attention", retry: "send" } },
			{ ...again.loads[1], _autoInvoice: { state: "needs_attention", retry: "send" } },
		];
		again.store.annotateCompletedRows({ rows: tryRows, headers: HEADERS, isSuperAdmin: true });
		eq([tryRows[0]._autoInvoice.retry, tryRows[1]._autoInvoice.retry], ["none", "send"], "§7 saved evidence of an invoice: Try again reads none, as its 409 will");
		const search = [{ ...again.loads[0], _autoInvoice: { state: "needs_attention", retry: "search" } }, { ...again.loads[0], _autoInvoice: { state: "drafted" } }];
		again.store.annotateCompletedRows({ rows: search, headers: HEADERS, isSuperAdmin: true });
		eq([search[0]._autoInvoice.retry, search[1]._autoInvoice.retry], ["search", undefined], "§7 ...a Try again that can only search is left alone, and a chip with no Try again gets none");
	}

	// ================================================================= §8
	section("§8  savedInvoice(): what Try again's 409 reads");
	{
		const w = world({ env: {}, loads: [] });
		const key = "900000701";
		const saved = () => E.savedInvoice(w.db, key);
		eq(saved(), false, "§8 no row");
		E.saveAnswer(w.db, key, CLEAN, { nowIso: iso(NOW) });
		eq(saved(), false, "§8 clean");
		E.saveAnswer(w.db, key, { verdict: "mention", mailboxes: { drafts: BOX, sent: { ...BOX, mention: 1 } } }, { nowIso: iso(NOW) });
		eq(saved(), false, "§8 a mention isn't an invoice: Try again's run refuses it live, and Draft Invoice stays");
		E.saveAnswer(w.db, key, { verdict: "invoice", mailboxes: { drafts: { ...BOX, invoice: 1 }, sent: BOX } }, { nowIso: iso(NOW) });
		eq(saved(), true, "§8 an invoice in Drafts");
		E.saveAnswer(w.db, key, INVOICE_IN_SENT, { nowIso: iso(NOW) });
		eq(saved(), true, "§8 an invoice in Sent Mail");
		const filled = "900000702";
		E.savePayments(w.db, filled, { payments_invoice_number: 0, payments_payment_date: 0, payments_status: 1 }, { nowIso: iso(NOW) });
		eq(E.savedInvoice(w.db, filled), true, "§8 a filled Payments Table row");
		w.addClaim(key, { state: "needs_attention", reason_code: "MAYBE_IN_GMAIL", stage: "appending" });
		eq(saved(), false, "§8 a claim past the build: Try again only searches for it, so it isn't refused");
		w.addClaim(filled, { state: "needs_attention", reason_code: "TOTAL_MISMATCH", stage: "reserved", invoice_id: "11012026-1" });
		eq(E.savedInvoice(w.db, filled), true, "§8 a claim still building is");
		const empty = new Database(":memory:");
		eq(E.savedInvoice(empty, key), false, "§8 no table: false, and it doesn't throw");
		empty.exec(`CREATE VIEW ${E.TABLE} AS SELECT * FROM a_table_that_is_not_there`);
		eq(E.savedInvoice(empty, key), false, "§8 a table that can't be read: false; the run's own look still guards a send");
	}

	// ================================================================= §9
	section("§9  the real search against a made-up mailbox");
	const lib = require(path.join(ROOT, "lib", "invoice-mailbox-search.js"));
	const fake = fakeMailbox();
	await new Promise((r) => fake.server.listen(0, "127.0.0.1", r));
	const port = fake.server.address().port;
	const realConnect = tls.connect;
	tls.connect = () => net.connect(port, "127.0.0.1");
	const SENT = fake.boxes["[Gmail]/Sent Mail"];
	const DRAFTS = fake.boxes["[Gmail]/Drafts"];
	const clearBoxes = () => { SENT.length = 0; DRAFTS.length = 0; };
	const DATE = "Mon, 02 Nov 2026 18:30:00 +0000";
	const real = (over = {}) => {
		const w = world({ loads: [load("900000801")], ...over });
		w.store = E.create({ ...w.deps, search: undefined, gapMs: 0 });
		return w;
	};
	try {
		// The app's own mail names the load in its body, and sits in Sent Mail.
		SENT.push({ subject: "=?UTF-8?Q?Weekly_Invoices_=E2=80=94_ACTION_NEEDED_=E2=80=94_2026-10-24_to_2026-10-30?=", date: DATE, to: OWN, text: "Undated loads: 900000801" });
		SENT.push({ subject: "New Invoice: 11012026-3 - Made-up Driver", date: DATE, to: OWN, names: ["Made-up Driver Invoice.pdf"], text: "day grid 900000801" });
		SENT.push({ subject: "Load 900000801: a re-issued rate con was held", date: DATE, to: "alerts@example-other.test", text: "900000801" });
		let w = real();
		await w.store.runOnce();
		eq(w.rowFor("900000801"), { status: STATUS.NONE_FOUND, searchedAt: iso(NOW) }, "§9 an unbilled load named only by the app's own mail doesn't read billed");
		eq(w.row("900000801").sent_invoice, 0, "§9 ...no invoice hit saved");
		ok(fake.commands.every((c) => ["LOGIN", "CAPABILITY", "EXAMINE", "SEARCH", "FETCH", "LOGOUT"].includes(c)), "§9 only the read-only commands reach the mailbox");
		ok(!fake.commands.includes("STORE") && !fake.commands.includes("APPEND") && !fake.commands.includes("SELECT"), "§9 ...nothing that could set a flag");

		w = real();
		w.addClaim("900000801", { state: "needs_attention", reason_code: "TOTAL_MISMATCH" });
		await w.store.runOnce();
		eq(w.rowFor("900000801"), { status: STATUS.ATTENTION, code: "TOTAL_MISMATCH" }, "§9 a held load the weekly batch names stays held, not Invoiced by hand");
		w = real();
		w.addRow("900000801");
		await w.store.runOnce();
		eq(w.rowFor("900000801").code, "DRAFT_NOT_IN_GMAIL", "§9 a person's unsent draft the batch names isn't made Invoiced by hand");

		SENT.push({ subject: "Re: Load 900000801 tracking", date: DATE, to: "ops@example-broker.test", text: "900000801" });
		w = real();
		await w.store.runOnce();
		eq(w.rowFor("900000801"), { status: STATUS.UNKNOWN, code: "MENTIONED" }, "§9 a reply naming the load is a mention: Couldn't check");

		SENT.push({ subject: "Example Broker Order #900000801", date: DATE, to: BROKER, cc: "copies@example-other.test", names: ["Example Broker Invoice Order #900000801.pdf"], text: "Attached." });
		w = real();
		await w.store.runOnce();
		eq(w.rowFor("900000801"), { status: STATUS.BY_HAND, found: "sent_mail", date: "2026-11-02" }, "§9 a real invoice reads Invoiced by hand, with its date");
		const stored = JSON.stringify(w.db.prepare(`SELECT * FROM ${E.TABLE}`).all());
		for (const secret of ["example-broker", "example-other", OWN, "Example Broker", "Order #", "Weekly Invoices", "Made-up Driver", "tracking", ".pdf"]) {
			ok(!stored.includes(secret), `§9 no address, subject or file name is saved: ${secret}`);
		}
		ok(!w.logs.join(" ").includes("example-broker"), "§9 ...or logged");

		clearBoxes();
		SENT.push({ subject: "Example Bison Order #7000001", date: DATE, to: "ap@made-up-factoring.test", names: ["Bison Invoice Order #7000001.pdf"], text: "No load number in here." });
		w = real({ loads: [load("900000802", { Email: "ops@bisontransport.com" })] });
		w.addRow("900000802", { order_number: "7000001" });
		await w.store.runOnce();
		eq(w.rowFor("900000802"), { status: STATUS.BY_HAND, invoiceId: "11012026-1", found: "sent_mail", date: "2026-11-02" }, "§9 a Bison row found by its order number, which the load number can't find");

		clearBoxes();
		DRAFTS.push({ subject: "Example Broker Order #900000803", date: DATE, to: "", names: ["Example Broker Invoice Order #900000803.pdf"], text: "" });
		w = real({ loads: [load("900000803")] });
		await w.store.runOnce();
		eq(w.rowFor("900000803"), { status: STATUS.UNKNOWN, code: "MENTIONED" }, "§9 a blank-To draft with an invoice file is doubt, so the load can't read clean");

		clearBoxes();
		fake.refuse.LOGIN = "NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)";
		w = real({ loads: [load("900000804"), load("900000805")] });
		const refusedRun = await w.store.runOnce();
		eq([refusedRun.stoppedAt, refusedRun.paused, w.notices.length], ["login", true, 1], "§9 a real login refusal stops the pass, with one notice");
		delete fake.refuse.LOGIN;
		ok(!JSON.stringify(w.logs).includes("AUTHENTICATIONFAILED"), "§9 ...no server text in the log");

		fake.refuse.SEARCH = "BAD Could not parse command";
		w = real({ loads: [load("900000806"), load("900000807")] });
		const badRun = await w.store.runOnce();
		eq([badRun.stoppedAt, badRun.searched, badRun.paused], ["search", 0, undefined], "§9 a real BAD ends the run with no stop");
		delete fake.refuse.SEARCH;

		// One session at a time, whoever asks.
		clearBoxes();
		fake.trace.length = 0;
		const three = await Promise.all([
			lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "900000811" }),
			lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "900000812" }),
			lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "900000813" }),
		]);
		const order = fake.trace.filter(([, verb]) => verb !== "LOGOUT").map(([session]) => session);
		eq(three.map((a) => a.verdict), ["clean", "clean", "clean"], "§9 three callers at once: each answered");
		ok(order.length >= 15 && order.every((s, i) => i === 0 || s >= order[i - 1]) && new Set(order).size === 3, "§9 ...one session at a time: one session's commands never fall between another's");
		fake.refuse.LOGIN = "NO made up";
		const results = await Promise.allSettled([
			lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "900000814" }),
			lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "900000815" }),
		]);
		delete fake.refuse.LOGIN;
		eq(results.map((r) => r.status), ["rejected", "rejected"], "§9 a failed session doesn't hold up the next one");
		const after = await lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "900000816" });
		eq(after.verdict, "clean", "§9 ...and the line carries on");
		const refusedTerm = await Promise.allSettled([lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "not a term" })]);
		eq(refusedTerm[0].reason.stage, "terms", "§9 a bad term still rejects at terms");

		// A live answer (Try again, the button) refreshes the saved row.
		SENT.push({ subject: "Example Broker Order #900000821", date: DATE, to: BROKER, names: ["Example Broker Invoice Order #900000821.pdf"], text: "" });
		const live = real({ env: {}, loads: [load("900000821"), load("900000822")] });
		eq(live.rowFor("900000821"), { status: STATUS.UNKNOWN, code: "NOT_SEARCHED" }, "§9 the pass off, a load not looked at");
		await lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "#900000821", lastCheck: false });
		eq(live.rowFor("900000821"), { status: STATUS.BY_HAND, found: "sent_mail", date: "2026-11-02" }, "§9 a live hit from Try again refreshes the saved row, the pass off or on");
		eq(E.savedInvoice(live.db, "900000821"), true, "§9 ...so Try again is refused from then on");
		await lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "900000822" });
		eq(live.rowFor("900000822"), { status: STATUS.UNKNOWN, code: "NOT_SEARCHED" }, "§9 a clean live answer claims nothing with the pass off");
		eq(live.row("900000822").result, "answered", "§9 ...though it's saved");
		await lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "900000823", quiet: true });
		eq(live.row("900000823"), null, "§9 a quiet search (the pass's own) isn't told twice");

		const offStore = real({ env: { INVOICE_STATUS_ENABLED: "false" }, loads: [load("900000824")] });
		await lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "900000824" });
		eq([offStore.row("900000824"), live.row("900000824"), offStore.store.statusOn], [null, null, false], "§9 the status switched off: a live answer saves nothing, anywhere");
		const replicaStore = real({ replica: true, loads: [load("900000825")] });
		await lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "900000825" });
		eq(replicaStore.row("900000825"), null, "§9 a replica: nor there");

		const noisy = real({ env: {}, loads: [] });
		noisy.db.exec(`CREATE VIEW ${E.TABLE} AS SELECT * FROM a_table_that_is_not_there`);
		const stillAnswered = await lib.searchMailboxForLoad({ user: OWN, pass: "made-up-app-password", loadNumber: "900000826" });
		eq(stillAnswered.verdict, "clean", "§9 saving a live answer can't fail the caller's search");
		ok(noisy.logs.some((l) => /live answer/.test(l)), "§9 ...it logs");
	} finally {
		tls.connect = realConnect;
		await new Promise((r) => fake.server.close(() => r()));
	}

	// ================================================================= §10
	section("§10  the export: three columns on, byte-identical off");
	const EXPORT_HEAD = 'app.get("/api/loads/completed/export", requireRole("Super Admin"), exportLimiter, async (req, res) => {';
	const route = liftRoute(SRC, EXPORT_HEAD);
	const findCol = (headers, re) => (headers || []).find((h) => re.test(h)) || null;
	const runExport = async (store, rows) => {
		let handler;
		const app = { get: (p, ...hs) => { handler = hs[hs.length - 1]; } };
		const names = ["app", "requireRole", "exportLimiter", "getJobTrackingCached", "excludeDroppedLoads", "findCol", "brokerInvoice", "pickAddressColumn", "normalizeDriverName", "sheetDayKey", "resolveAddressParts", "csvRows", "console", "invoiceEvidence"];
		new Function(...names, route)(app, () => {}, () => {}, async () => ({ headers: HEADERS, data: rows }), (r) => r, findCol,
			{ findPaymentColumn: (h) => h.find((x) => x.trim() === "Payment") || null }, () => null, (s) => String(s || "").trim(), (c) => String(c || "").slice(0, 10), () => ({ cityStateZip: "" }), csvRows, { log() {}, error() {} }, store);
		const res = { headers: {}, body: null, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
		await handler({ query: {} }, res);
		return res;
	};
	{
		const rows = [load("900000901", { "Completion Date": "2026-11-02" }), load("900000902", { "Completion Date": "2026-11-01" })];
		const BASE = [
			["Load ID", "Job Status", "Driver", "Truck", "Pickup", "Drop-off", "Assigned Date", "Delivery Date", "Payment"],
			["900000901", "Delivered", "Made-up Driver", "", "", "", "", "2026-11-02", "$1,500.00"],
			["900000902", "Delivered", "Made-up Driver", "", "", "", "", "2026-11-01", "$1,500.00"],
		];
		for (const v of ["false", "0", "no", "off"]) {
			const off = world({ env: { INVOICE_STATUS_ENABLED: v }, loads: rows });
			const r = await runExport(off.store, rows);
			eq(r.body, csvRows(BASE), `§10 INVOICE_STATUS_ENABLED=${v}: byte for byte as before`);
		}
		const on = world({ env: {}, loads: rows });
		on.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via, created_at) VALUES ('900000901', '11022026-1', 'auto-smtp', '2026-11-02T15:00:00Z')").run();
		const r = await runExport(on.store, rows);
		eq(r.body, csvRows([
			[...BASE[0], "Invoice Status", "Invoice #", "Invoice Date"],
			[...BASE[1], "Sent by LogisX", "11022026-1", "2026-11-02"],
			[...BASE[2], "Couldn't check", "", ""],
		]), "§10 the flag on: three columns after Payment");
		const drafted = world({ env: {}, loads: [rows[1]] });
		drafted.addRow("900000902", { invoice_id: "11012026-2" });
		eq((await runExport(drafted.store, [rows[1]])).body, csvRows([
			[...BASE[0], "Invoice Status", "Invoice #", "Invoice Date"],
			[...BASE[2], "Invoiced by hand (Sent Mail not checked yet)", "11012026-2", ""],
		]), "§10 a person's draft row with the pass off: the file says Sent Mail wasn't checked");
		ok(!("_invoiceStatus" in rows[0]), "§10 the cached rows aren't touched");
		ok(/requireRole\("Super Admin"\)/.test(EXPORT_HEAD), "§10 the route stays Super Admin only");
	}

	// ================================================================= §11
	section("§11  server.js: the block as shipped, its flags, its timer");
	const START = "// <invoice-status-wiring>";
	const END = "// </invoice-status-wiring>";
	ok(SRC.split(START).length === 2 && SRC.split(END).length === 2, "§11 one <invoice-status-wiring> block");
	const BLOCK = SRC.slice(SRC.indexOf(START), SRC.indexOf(END) + END.length);
	const serverRequire = createRequire(path.join(ROOT, "server.js"));
	const boot = ({ env = {}, replica = null, startsJobAnswer = true } = {}) => {
		const db = new Database(":memory:");
		db.exec(createSql("load_invoice_drafts"));
		db.exec(createSql("app_settings"));
		const t = { db, startsJob: [], intervals: [], sheetAsks: [], rooms: [], notices: [], logs: [] };
		const scope = {
			db,
			process: { env },
			console: { log: (...a) => t.logs.push(a.join(" ")), warn() {}, error() {} },
			require: (p) => serverRequire(p),
			getJobTrackingCached: async () => ({ headers: HEADERS, data: [load("900000951"), load("900000952", { "Job Status": "Cancelled" })] }),
			excludeDroppedLoads: (rows) => rows.filter((r) => r["Job Status"] !== "Cancelled"),
			getSheets: async () => ({ spreadsheets: { values: { get: async (q) => { t.sheetAsks.push(q); return { data: { values: [PAYMENTS_HEAD] } }; } } } }),
			SPREADSHEET_ID: "made-up-sheet",
			integrityClosedMonthsOf: () => [],
			sheetDayKey: (c) => String(c || ""),
			autoInvoice: { mode: "on", triggerMode: true },
			REPLICA: replica,
			AUTO_INVOICE_NOTICE_TYPE: "auto-invoice",
			insertDispatchNotification: { run: (...a) => t.notices.push(a) },
			io: { to: (room) => ({ emit: (event, payload) => t.rooms.push({ room, event, payload }) }) },
			startsJob: (name) => { t.startsJob.push(name); return startsJobAnswer; },
			setInterval: (fn, ms) => { t.intervals.push({ fn, ms }); return 0; },
		};
		const names = Object.keys(scope);
		t.store = new Function(...names, `${BLOCK}\nreturn invoiceEvidence;`)(...names.map((n) => scope[n]));
		return t;
	};
	const schemaOf = (db) => db.prepare("SELECT name FROM sqlite_master ORDER BY name").all().map((r) => r.name);
	{
		const live = boot();
		eq([live.store.statusOn, live.store.passOn], [true, false], "§11 no settings: the status on, the pass off");
		eq([live.startsJob, live.intervals.length, live.sheetAsks.length], [[], 0, 0], "§11 ...startsJob() never asked, no timer, no sheet read");
		ok(!schemaOf(live.db).includes(E.TABLE), "§11 ...and no table: the deploy writes nothing");
		ok(live.logs.some((l) => /invoice-status.*status on.*mailbox pass off/.test(l)), "§11 ...and the start-up line says so");

		const passing = boot({ env: { INVOICE_MAILBOX_PASS_ENABLED: "true", GMAIL_USER: OWN, GMAIL_APP_PASSWORD: "made-up-app-password" } });
		eq([passing.store.passOn, passing.startsJob, passing.intervals.map((i) => i.ms)], [true, ["invoice mailbox pass"], [10 * 60 * 1000]], "§11 the pass on: behind startsJob(), every 10 minutes");

		const blocked = boot({ env: { INVOICE_MAILBOX_PASS_ENABLED: "true", GMAIL_USER: OWN, GMAIL_APP_PASSWORD: "made-up-app-password" }, startsJobAnswer: false });
		eq(blocked.intervals.length, 0, "§11 startsJob() says no (an import, a replica): no timer");

		const copy = boot({ env: { INVOICE_MAILBOX_PASS_ENABLED: "true", GMAIL_USER: OWN, GMAIL_APP_PASSWORD: "made-up-app-password" }, replica: { listening() {} } });
		eq([copy.store.passOn, copy.startsJob, copy.intervals.length], [false, [], 0], "§11 a replica: no pass, whatever the setting");
		eq(await copy.store.runOnce(), { ran: false, why: "OFF" }, "§11 ...no run");

		const killed = boot({ env: { INVOICE_STATUS_ENABLED: "false", INVOICE_MAILBOX_PASS_ENABLED: "true" } });
		eq([killed.store.statusOn, killed.store.passOn, killed.startsJob], [false, false, []], "§11 the kill switch stops the pass too");

		const reads = boot({ env: { INVOICE_MAILBOX_PASS_ENABLED: "true", GMAIL_USER: "", GMAIL_APP_PASSWORD: "" } });
		eq(await reads.store.runOnce(), { ran: false, why: "NO_MAILBOX" }, "§11 no GMAIL_USER: no run");
	}
	{
		ok(/values\.get\(\{ spreadsheetId: SPREADSHEET_ID, range: "Payments Table" \}\)/.test(BLOCK), "§11 the Payments Table is read by values.get, nothing else");
		ok(!/values\.(update|batchUpdate|append|clear)|sendMail|sendEmail|appendGmailDraft/.test(BLOCK), "§11 nothing in the block writes a sheet or sends mail");
		ok(/mailbox: \(\) => \(\{ user: process\.env\.GMAIL_USER \|\| "", pass: REPLICA \? "" : process\.env\.GMAIL_APP_PASSWORD \|\| "" \}\)/.test(BLOCK), "§11 a replica has no mailbox password, as the job's block");

		const dash = liftRoute(SRC, 'app.get("/api/dashboard", requireRole("Super Admin", "Dispatcher"), async (req, res) => {');
		const LINE = 'invoiceEvidence.annotateCompletedRows({ rows: respCompleted, headers: jobTracking.headers, isSuperAdmin: req.session.user.role === "Super Admin" });';
		const at = dash.indexOf(LINE);
		ok(dash.split(LINE).length === 2 && at > dash.indexOf("const respCompleted =") && at > dash.indexOf("autoInvoice.annotateCompletedRows(") && at < dash.indexOf("res.json({"),
			"§11 /api/dashboard annotates the completed rows it serves, once, after the job's chip and before its answer");
		for (const [role, want] of [["Super Admin", true], ["Dispatcher", false]]) {
			const w = world({ env: {}, loads: [load("900000961")] });
			const respCompleted = [{ ...w.loads[0] }];
			new Function("invoiceEvidence", "respCompleted", "jobTracking", "req", LINE)(w.store, respCompleted, { headers: HEADERS }, { session: { user: { role } } });
			eq("_invoiceStatus" in respCompleted[0], want, `§11 that line as shipped: a ${role} ${want ? "gets a status" : "sees none"}`);
		}
		// The filter offers "No invoice found" only while the pass could say it, on the server's word.
		const TOLD = '...(invoiceEvidence.statusOn && req.session.user.role === "Super Admin" ? { invoiceStatus: { mailboxPass: invoiceEvidence.passOn } } : {}),';
		ok(dash.split(TOLD).length === 2 && dash.indexOf(TOLD) > dash.indexOf("res.json({"), "§11 FAILS ON THE OLD CODE: /api/dashboard's answer says whether the mailbox pass is on, once");
		for (const [role, env, want] of [
			["Super Admin", {}, { invoiceStatus: { mailboxPass: false } }],
			["Super Admin", { INVOICE_MAILBOX_PASS_ENABLED: "true" }, { invoiceStatus: { mailboxPass: true } }],
			["Super Admin", { INVOICE_STATUS_ENABLED: "false" }, {}],
			["Dispatcher", { INVOICE_MAILBOX_PASS_ENABLED: "true" }, {}],
		]) {
			const w = world({ env, loads: [load("900000962")] });
			eq(new Function("invoiceEvidence", "req", `return { ${TOLD} };`)(w.store, { session: { user: { role } } }), want, `§11 that line as shipped: a ${role} with ${JSON.stringify(env)} is told ${JSON.stringify(want)}`);
		}
		ok(/savedInvoiceEvidence: \(key\) => require\("\.\/lib\/invoice-evidence"\)\.savedInvoice\(db, key\),/.test(SRC.slice(SRC.indexOf("// <auto-invoice-wiring>"), SRC.indexOf("// </auto-invoice-wiring>"))),
			"§11 the job's block hands Try again its saved evidence");

		const TEMPLATE = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
		ok(/^# INVOICE_STATUS_ENABLED=$/m.test(TEMPLATE) && /^# INVOICE_MAILBOX_PASS_ENABLED=$/m.test(TEMPLATE), "§11 the settings template names both, each unset");
		const rules = require(path.join(ROOT, "lib", "replica-rules.js"));
		eq(rules.enableRefusal("INVOICE_MAILBOX_PASS_ENABLED"), "not a business setting (secret: name contains PASS)", "§11 --enable refuses the pass: its name holds PASS, so a replica never copies it");
		ok(/kill switch/.test(String(rules.enableRefusal("INVOICE_STATUS_ENABLED"))), "§11 --enable refuses the kill switch");
		eq(rules.classifySetting("INVOICE_MAILBOX_PASS_ENABLED", "true").copy, false, "§11 the settings export never copies the pass's flag");
	}

	finish();
}

main().catch((e) => {
	console.log(`  FAIL the runner stopped: ${e && e.stack}`);
	process.exit(1);
});
