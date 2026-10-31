#!/usr/bin/env node
// lib/auto-invoice-job.js in shadow mode (AUTO_INVOICE_DRAFTS_ENABLED=true and
// AUTO_INVOICE_DRAFTS_SHADOW not "false"): it only logs what it would do.
//
//   §1 nothing is spent: spies on the engine (Drive, Gemini and the PDF live
//      behind it), the invoice-number sequence, Gmail, fetch and the audit log
//      stay at 0; the only sheet read is the cached Job Tracking; no claim rows
//   §2 the shadow log: a baseline on the first sweep, then one verdict per load
//      first seen completed, with its reason and local facts (no address)
//   §3 verdicts move like the job's states: WOULD_WAIT becomes WOULD_ATTEMPT when
//      the POD arrives (ready time set, first seen kept), or WOULD_SKIP when drafted
//      by hand; WOULD_ATTEMPT stays, so the report can compare it with the hand draft
//   §4 the shadow-week report reads that log
//   §5 the job module reaches no network or Google client itself
//   §6 the one thing shadow does besides its log: a settings problem stores and
//      sends one in-app Super Admin notice (and a meta row), worded for shadow:
//      it makes no Gmail drafts, it only records what it would draft; still no
//      engine, number, Gmail or audit call, and once per problem
//
// Made-up loads only, an in-memory database.
//   node scripts/test-auto-invoice-shadow.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const jobLib = require(path.join(ROOT, "lib", "auto-invoice-job.js"));
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const report = require(path.join(ROOT, "scripts", "auto-invoice-shadow-report.js"));
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

const ET = "America/New_York";
const MIN = 60 * 1000;
const T0 = Date.parse("2026-10-20T14:00:00Z");
const HEADERS = Object.freeze(["Load ID", "Job Status", "Email", "Status Update Date", "Completion Date", "  Payment  ", "Trailer Number"]);
const { sheetDayKey } = report.liftSheetHelpers();

async function main() {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, type TEXT NOT NULL, file_name TEXT NOT NULL,
			drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at TEXT, deleted_at TEXT DEFAULT NULL);
		CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, recipient_source TEXT,
			via TEXT, created_at TEXT, created_by TEXT, edited INTEGER DEFAULT 0, edited_fields TEXT DEFAULT '');
		CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL);
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
	`);
	let now = T0;
	const rows = [];
	const files = new Set();
	const spent = { prepare: 0, render: 0, record: 0, mint: 0, append: 0, search: 0, audit: 0, notify: 0, fetch: 0, reads: 0 };
	const realFetch = globalThis.fetch;
	globalThis.fetch = () => { spent.fetch++; return Promise.reject(new Error("no network in shadow mode")); };
	const setRow = (id, over = {}) => {
		const row = Object.freeze({ "Load ID": id, "Job Status": "Delivered", Email: "ops@example-broker.test", "Status Update Date": "10/20/2026 9:00:00",
			"Completion Date": "10/20/2026 9:00:00", "  Payment  ": "$1,000.00", "Trailer Number": "TR-1", ...over });
		const i = rows.findIndex((r) => r["Load ID"] === id);
		if (i >= 0) rows[i] = row; else rows.push(row);
	};
	const addPod = (id) => {
		const name = `pod-${id}.pdf`;
		db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'POD', ?, ?, '2026-10-20 13:00:00')").run(id, name, `/uploads/${name}`);
		files.add(name);
	};
	const handDraft = (id, at) => db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_at) VALUES (?, ?, 'billing@example-broker.test', 'ratecon', 'imap', ?)")
		.run(id, `made-up-${id}`, new Date(at).toISOString());
	const count = (key) => () => { spent[key]++; throw new Error(`${key} called in shadow mode`); };
	const job = jobLib.create({
		db,
		env: { AUTO_INVOICE_DRAFTS_ENABLED: "true" },
		now: () => new Date(now),
		readJobTracking: async () => { spent.reads++; return Object.freeze({ headers: HEADERS, data: Object.freeze([...rows]) }); },
		closedMonthsOf: (headers, row) => (row["Load ID"] === "LD-TEST-0303" ? ["2026-09"] : []),
		dayKeyOf: sheetDayKey,
		uploadsRoot: "/made-up/uploads",
		fileExists: (p) => files.has(path.basename(p)),
		engine: { prepare: count("prepare"), render: count("render"), record: count("record") },
		nextInvoiceNumber: count("mint"),
		appendGmailDraft: count("append"),
		findDraftByMessageId: count("search"),
		newMessageId: () => "<made-up@example.com>",
		mailbox: () => ({ user: "drafts@example.com", pass: "made-up" }),
		bisonRecipient: () => "",
		logAudit: () => { spent.audit++; },
		notify: () => { spent.notify++; },
		geminiUnavailableAt: () => null,
		log: { warn: () => {}, error: () => {} },
		timeZone: ET,
	});
	const shadowRow = (id) => db.prepare("SELECT * FROM auto_invoice_shadow WHERE load_key = ?").get(rules.loadKey(id)) || null;
	const verdict = (id) => {
		const r = shadowRow(id);
		return r ? [r.verdict, r.reason_code] : null;
	};

	try {
		// ---------------------------------------------------------------- §2
		section("§2  the shadow log");
		eq(job.mode, "shadow", "§2 ENABLED alone is shadow");
		setRow("LD-TEST-0300");
		await job.tick();
		eq(verdict("LD-TEST-0300"), ["BASELINE", ""], "§2 the first sweep baselines what is already delivered");
		now += 5 * MIN;
		setRow("LD-TEST-0301"); addPod("LD-TEST-0301");
		setRow("LD-TEST-0302");
		setRow("LD-TEST-0303"); addPod("LD-TEST-0303");
		setRow("LD-TEST-0304", { Email: "ops@example-optout.test" }); addPod("LD-TEST-0304");
		db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?)")
			.run(JSON.stringify({ optOutDomains: ["example-optout.test"], confirmedBrokerDomains: ["example-broker.test"] }));
		setRow("LD-TEST-0310", { Email: "ops@example-other.test" }); addPod("LD-TEST-0310");
		setRow("LD-TEST-0311", { Email: "made-up-dispatch@yahoo.com" }); addPod("LD-TEST-0311");
		setRow("LD-TEST-0305"); addPod("LD-TEST-0305"); handDraft("LD-TEST-0305", now - MIN);
		setRow("LD-TEST-0306", { Email: "ops-test@bisontransport.com" }); addPod("LD-TEST-0306");
		setRow("LD-TEST-0307", { "Completion Date": "10/01/2026 9:00:00" });
		setRow("LD-TEST-0308");
		setRow("LD-TEST-0309", { "Job Status": "In Transit", "Completion Date": "" });
		await job.tick();
		eq(verdict("LD-TEST-0301"), ["WOULD_ATTEMPT", ""], "§2 ready: WOULD_ATTEMPT");
		eq(verdict("LD-TEST-0302"), ["WOULD_WAIT", "WAITING_POD"], "§2 no POD: WOULD_WAIT");
		eq(verdict("LD-TEST-0303"), ["WOULD_NEED_ATTENTION", "CLOSED_MONTH"], "§2 a closed month: WOULD_NEED_ATTENTION");
		eq(verdict("LD-TEST-0304"), ["WOULD_SKIP", "BROKER_OPTED_OUT"], "§2 opted out: WOULD_SKIP");
		eq(verdict("LD-TEST-0305"), ["WOULD_SKIP", "ALREADY_DRAFTED"], "§2 drafted by hand first: WOULD_SKIP");
		eq(verdict("LD-TEST-0306"), ["WOULD_NEED_ATTENTION", "RECIPIENT_UNCONFIGURED"], "§2 Bison with no recipient setting: WOULD_NEED_ATTENTION");
		eq(verdict("LD-TEST-0307"), ["BASELINE", ""], "§2 completed before the shadow baseline: BASELINE");
		eq(verdict("LD-TEST-0309"), null, "§2 a load not completed is not logged");
		eq(verdict("LD-TEST-0310"), ["WOULD_NEED_ATTENTION", "BROKER_DOMAIN_UNCONFIRMED"], "§2 a broker domain nobody confirmed: WOULD_NEED_ATTENTION");
		eq(verdict("LD-TEST-0311"), ["WOULD_NEED_ATTENTION", "BROKER_EMAIL_FREEMAIL"], "§2 a free-mail broker Email: WOULD_NEED_ATTENTION");
		const r301 = shadowRow("LD-TEST-0301");
		eq([r301.first_seen_at, r301.ready_at], [new Date(now).toISOString(), new Date(now).toISOString()], "§2 first seen and ready at this sweep");
		eq(JSON.parse(r301.facts_json), { bison: false, domain: "example-broker.test", optedOut: false, month: "open", deliveryDate: true, pods: 1, podsUnreadable: 0,
			rateConRows: 0, advanceLines: 0, drafted: false, bisonRecipient: false, freemail: false, confirmed: true }, "§2 the local facts logged");
		eq([JSON.parse(shadowRow("LD-TEST-0310").facts_json).confirmed, JSON.parse(shadowRow("LD-TEST-0311").facts_json).freemail], [false, true], "§2 confirmed and free mail are logged");
		ok(!db.prepare("SELECT group_concat(load_id || facts_json || reason_code, '|') AS t FROM auto_invoice_shadow").get().t.includes("@"), "§2 no email address in the shadow log");

		// ---------------------------------------------------------------- §3
		section("§3  verdicts move");
		const firstSeen302 = shadowRow("LD-TEST-0302").first_seen_at;
		now += 30 * MIN;
		addPod("LD-TEST-0302");
		handDraft("LD-TEST-0301", now);
		handDraft("LD-TEST-0308", now);
		await job.tick();
		const r302 = shadowRow("LD-TEST-0302");
		eq([r302.verdict, r302.first_seen_at, r302.ready_at], ["WOULD_ATTEMPT", firstSeen302, new Date(now).toISOString()], "§3 the POD arrives: WOULD_ATTEMPT, ready now, first seen kept");
		eq(verdict("LD-TEST-0301"), ["WOULD_ATTEMPT", ""], "§3 a WOULD_ATTEMPT load drafted by hand stays WOULD_ATTEMPT");
		eq(verdict("LD-TEST-0308"), ["WOULD_SKIP", "DRAFTED_BY_HAND"], "§3 a waiting load drafted by hand: WOULD_SKIP");
		setRow("LD-TEST-0303", { "Job Status": "In Transit" });
		now += 5 * MIN;
		await job.tick();
		eq(verdict("LD-TEST-0303"), ["WOULD_NEED_ATTENTION", "CLOSED_MONTH"], "§3 a person's verdict stays");
		const st = job.status();
		eq([st.mode, st.counts, st.shadow.WOULD_ATTEMPT, st.shadow.BASELINE], ["shadow", null, 2, 2], "§3 status in shadow mode: the log's counts");

		// ---------------------------------------------------------------- §1
		section("§1  nothing is spent");
		eq({ ...spent, reads: undefined }, { prepare: 0, render: 0, record: 0, mint: 0, append: 0, search: 0, audit: 0, notify: 0, fetch: 0 }, "§1 no engine, number, Gmail, network, audit row or notice");
		eq(spent.reads, 4, "§1 one cached Job Tracking read a sweep (four sweeps), nothing else");
		eq(db.prepare("SELECT COUNT(*) n FROM auto_invoice_claims").get().n, 0, "§1 no claim rows");
		const meta = Object.fromEntries(db.prepare("SELECT key, value FROM auto_invoice_meta").all().map((r) => [r.key, r.value]));
		eq(Object.keys(meta).sort(), ["last_sweep_at", "shadow_baseline_at"], "§1 the real baseline and the on-mode heartbeat are untouched");
		const rowsOut = rows.map((r) => ({ ...r }));
		job.annotateCompletedRows({ rows: rowsOut, headers: HEADERS, isSuperAdmin: true });
		ok(rowsOut.every((r) => !("_autoInvoice" in r)), "§1 Completed Loads shows nothing in shadow mode");

		// ---------------------------------------------------------------- §4
		section("§4  the shadow-week report reads the log");
		const s = report.buildShadow({ db, since: "2026-10-20", until: "2026-10-20", zone: ET, today: "2026-10-20" });
		eq([s.firstSeen, s.verdicts.WOULD_ATTEMPT.count, s.verdicts.WOULD_SKIP.reasons], [9, 2, { BROKER_OPTED_OUT: 1, ALREADY_DRAFTED: 1, DRAFTED_BY_HAND: 1 }], "§4 the verdicts");
		eq([s.handDraftCompare.A, s.handDraftCompare.D], [1, 1], "§4 0301 drafted by hand where the job would have (A); 0302 not drafted (D)");
		eq([s.verdicts.WOULD_NEED_ATTENTION.reasons.BROKER_DOMAIN_UNCONFIRMED, s.verdicts.WOULD_NEED_ATTENTION.reasons.BROKER_EMAIL_FREEMAIL], [1, 1], "§4 the report counts the anchor's codes");
	} finally {
		globalThis.fetch = realFetch;
		db.close();
	}

	// ---------------------------------------------------------------- §5
	section("§5  the job module reaches nothing itself");
	const SRC = fs.readFileSync(path.join(ROOT, "lib", "auto-invoice-job.js"), "utf8");
	const requires = [...SRC.matchAll(/require\(\s*"([^"]{1,60})"\s*\)/g)].map((m) => m[1]).sort();
	eq(requires, ["./app-time", "./auto-invoice-ledger", "./auto-invoice-rules", "./imap-draft", "crypto", "fs", "os"], "§5 it loads only its own lib modules and built-ins");
	ok(!/\bfetch\s*\(|googleapis|getSheets|getDrive|https?:\/\//.test(SRC), "§5 no fetch, Google client or URL: every outside call is a dependency it is given");
	ok(/newMessageId: \(user\) => require\("\.\/imap-draft"\)\.newMessageId\(user\)/.test(SRC), "§5 lib/imap-draft.js is loaded only for a Message-ID default");

	// ---------------------------------------------------------------- §6
	section("§6  the shadow notice: a settings problem, worded for shadow");
	{
		const db2 = new Database(":memory:");
		db2.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '')");
		const setSettings = (value) => db2.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
		const notices = [];
		const paid = { prepare: 0, render: 0, record: 0, mint: 0, append: 0, search: 0, audit: 0 };
		const spy = (key) => () => { paid[key]++; throw new Error(`${key} called in shadow mode`); };
		let t = T0;
		const shadowJob = jobLib.create({
			db: db2,
			env: { AUTO_INVOICE_DRAFTS_ENABLED: "true" },
			now: () => new Date(t),
			readJobTracking: async () => Object.freeze({ headers: HEADERS, data: Object.freeze([]) }),
			engine: { prepare: spy("prepare"), render: spy("render"), record: spy("record") },
			nextInvoiceNumber: spy("mint"),
			appendGmailDraft: spy("append"),
			findDraftByMessageId: spy("search"),
			newMessageId: () => "<made-up@example.com>",
			logAudit: spy("audit"),
			notify: (n) => notices.push(n),
			log: { warn: () => {}, error: () => {} },
			timeZone: ET,
		});
		const SHADOW_WORDS = "Shadow mode makes no Gmail drafts: it only records what it would draft.";
		setSettings(JSON.stringify({ optOutDomains: [], confirmedBrokerDomains: ["example-broker.test", "comcast.net"] }));
		for (let i = 0; i < 3; i++) { await shadowJob.tick(); t += 5 * MIN; }
		eq(notices.map((n) => n.title), ["Automatic invoice drafts (shadow mode): settings"], "§6 an entry the rules now refuse: one notice, however many sweeps");
		eq(notices[0] && notices[0].body,
			`Some automatic-draft settings no longer pass the rules and are ignored: comcast.net (confirmed, CONFIRMED_DOMAIN_FREEMAIL). Save the lists again to remove them. ${SHADOW_WORDS}`,
			"§6 ...naming the entry, and saying shadow makes no Gmail drafts and only records what it would draft");
		ok(db2.prepare("SELECT value FROM auto_invoice_meta WHERE key = 'settings_notice'").get(), "§6 ...remembered in its meta row, so it isn't sent again");
		setSettings("{broken");
		for (let i = 0; i < 3; i++) { await shadowJob.tick(); t += 5 * MIN; }
		eq(notices.length, 2, "§6 an unreadable row is a new problem: one more notice");
		eq(notices[1] && notices[1].body,
			`The automatic-draft settings can't be read, so shadow mode records nothing until both the opt-out list and the confirmed broker domains are saved again. ${SHADOW_WORDS}`,
			"§6 ...saying what stops in shadow (its record), not that drafting stops");
		eq(paid, { prepare: 0, render: 0, record: 0, mint: 0, append: 0, search: 0, audit: 0 }, "§6 and still no engine, number, Gmail or audit call");
		ok(!notices.some((n) => /@/.test(n.body)), "§6 no address in a notice");
		db2.close();
	}
}

main()
	.catch((e) => failures.push(`the run threw: ${e && e.stack}`))
	.then(() => {
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
