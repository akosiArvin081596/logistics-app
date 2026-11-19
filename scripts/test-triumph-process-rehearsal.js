#!/usr/bin/env node
// scripts/triumph-process-rehearsal.js: Process with Triumph's practice run (plan §5 step 3, N-L5,
// recheck 2's N2-L3), on a made-up database under the system temp folder, with made-up clients for
// Drive, Gemini and the renderer. Nothing here reaches a network.
//
//   §1 a load the press would take: the press's dry run, then the job's own build; "whole read",
//      N, D and the total matched, the pages counted; it writes no row (each table's count and
//      content the same after), keeps no file, calls no writer
//   §2 it prints verdicts and matches only: no amount, address, name or invoice number
//   §3 it refuses a handle that isn't read-only, a database outside its own folder or the temp
//      folder, and a run with no load; a load the press refuses, and one the build stops
//      (an advance on the rate con), stop it with the code and nothing written
//   §4 it builds from the server's own code: every lifted declaration is server.js's text, the
//      script holds no copy, nothing it lifts is a writer, the sheet or the mailer, and a root
//      that is one is refused
//   §5 the batch as the live press would build it (batch-size plan M1, N2): the job gets
//      TRIUMPH_BATCH_DEDUPE_ENABLED and TRIUMPH_BATCH_MAX_BYTES from the settings file and
//      nothing else, so its mode stays off; the run counts the copies left out, when it stops
//      too; a lowered limit stops it; the process's own environment is never read
//   §6 way 1's photo re-compress: TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED from the settings file
//      reaches the build and the run prints the step and the bytes, or that it stopped at the
//      floor; set only in the process's environment it is off; the job still gets the batch's
//      settings alone, so its mode stays off
//   §7 Part A's look (scripts/triumph-batch-recompress-look.js): on the practice run's own build,
//      whatever the switch says, the batch as built today and the step it would fit at, or the
//      floor, in counts only; it writes nothing and keeps nothing
//
// Made-up data only (load 123456701, made-up.agent@chrobinson.com).
//   node scripts/test-triumph-process-rehearsal.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "triumph-process-rehearsal.js");
let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
const ok = (cond, label) => eq(Boolean(cond), true, label);
const section = (t) => console.log(`\n${t}`);
// On a tree without the script every case runs against this, so each rule fails by its own name.
const missing = () => { throw new Error("scripts/triumph-process-rehearsal.js is missing: there is no practice run"); };
const rehearsal = fs.existsSync(SCRIPT) ? require(SCRIPT)
	: { run: async () => missing(), liftReaders: missing, geminiOnlyFetch: missing, ROOTS: ["getRateConBytes"], DENIED: [] };
async function kase(label, fn) {
	try {
		await fn();
	} catch (e) {
		failures.push(`${label}\n      threw ${e && e.message}`);
	}
}
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const factoring = require(path.join(ROOT, "lib", "factoring-store.js"));
const autoLedger = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const autoRules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const rateconAdvanceRead = require(path.join(ROOT, "lib", "ratecon-advance-read.js"));
const { serverSource } = require(path.join(ROOT, "scripts", "lib", "server-source.js"));
const { textPdf } = require(path.join(ROOT, "scripts", "lib", "made-up-pdf.js"));
const { PDFDocument, StandardFonts } = require(path.join(ROOT, "node_modules", "pdf-lib"));

const T0 = "2026-11-12T15:00:00.000Z";
const LOAD = "123456701";
const OTHER_LOAD = "123456702";
const BROKER = "made-up.agent@chrobinson.com";
const BILLING = "made-up.billing@chrobinson.com";
const DEBTOR = "Made-up Robinson Debtor";
const N = "11102026-4";
const D = "2026-11-10";
const TOTAL = "$2,150.00";
const NOA = ["MADE-UP FACTOR LINE ONE", "MADE-UP FACTOR LINE TWO", "MADE-UP FACTOR LLC", "MADE-UP REMIT LINE"];
const HEADERS = ["Load ID", "Status", "Driver", "Email", "Payment", "Completion Date", "Delivery Date"];
const RATECON_TEXT = `C.H. Robinson Booked Load # ${LOAD} Carrier Rate Confirmation for a made-up test load. Debtor: ${DEBTOR}. Pickup at Test Shipper; delivery at Test Consignee. Equipment: van. Commodity weight 20,000 lbs. Total Rate: ${TOTAL}`;
const SECRETS = [TOTAL, "2,150", "2150", N, "11/10/2026", BROKER, BILLING, DEBTOR, "Made-up Driver", ...NOA];

// A made-up PDF of an HTML page's words: the renderer's stand-in.
async function renderStandIn(html) {
	const text = autoRules.htmlToText(html).replace(/[^\x20-\x7e\n]/g, " ");
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const page = doc.addPage([612, 792]);
	text.split("\n").filter((l) => l.trim()).slice(0, 60).forEach((l, i) => page.drawText(l.slice(0, 95), { x: 30, y: 760 - i * 12, size: 9, font }));
	return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// The made-up world: a database under the temp folder (a copy, as the script allows), the uploads
// beside it, the settings file, the sheet and the stand-in clients. `settings`: more lines for the
// settings file; `podCopies`: the POD stored that many more times, byte for byte; `podPdf`: the
// POD's own bytes in place of a page of text.
function world({ ratecon = RATECON_TEXT, settings: more = [], podCopies = 0, podPdf = null } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "triumph-practice-test-"));
	fs.mkdirSync(path.join(dir, "uploads"));
	fs.writeFileSync(path.join(dir, "uploads", "ratecon-made-up.pdf"), textPdf(ratecon, { mode: "literal" }));
	const pod = podPdf || textPdf(`PROOF OF DELIVERY (MADE UP) Load ${LOAD}`, { mode: "literal" });
	fs.writeFileSync(path.join(dir, "uploads", "pod-made-up.pdf"), pod);
	for (let i = 1; i <= podCopies; i++) fs.writeFileSync(path.join(dir, "uploads", `pod-made-up-again-${i}.pdf`), pod);
	const settings = path.join(dir, "practice-settings.conf");
	const denySetting = require(path.join(ROOT, "lib", "driver-instructions-runtime.js")).DENY_LIST_SETTING;
	fs.writeFileSync(settings, [`TRIUMPH_NOA_LINES="${NOA.join("\\n")}"`, "GEMINI_API_KEY=made-up-key", `${denySetting}=998877665544`, ...more].join("\n"));
	const file = path.join(dir, "app.db");
	const db = new Database(file);
	db.exec(`CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, recipient_source TEXT, total TEXT,
		broker_name TEXT, order_number TEXT, via TEXT, created_by TEXT, edited INTEGER DEFAULT 0, edited_fields TEXT DEFAULT '', overrides_json TEXT DEFAULT '', total_source TEXT DEFAULT '',
		sheet_total TEXT DEFAULT '', ratecon_total TEXT DEFAULT '', invoice_id_minted TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);
	db.exec(`CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, driver TEXT DEFAULT '', type TEXT NOT NULL, file_name TEXT NOT NULL,
		drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at TEXT, deleted_at TEXT DEFAULT NULL)`);
	db.exec("CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL)");
	db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by TEXT)");
	db.exec("CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT)");
	db.exec("CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, user_id INTEGER, username TEXT, role TEXT, action TEXT, entity TEXT, entity_id TEXT, details TEXT)");
	factoring.ensureSchema(db);
	autoLedger.ensureSchema(db);
	db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'RATECON', 'ratecon-made-up.pdf', '/uploads/ratecon-made-up.pdf', '2026-11-08 12:00:00')").run(LOAD);
	db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'POD', 'pod-made-up.pdf', '/uploads/pod-made-up.pdf', '2026-11-10 14:00:00')").run(LOAD);
	for (let i = 1; i <= podCopies; i++) {
		db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'POD', ?, ?, ?)").run(LOAD, `pod-made-up-again-${i}.pdf`, `/uploads/pod-made-up-again-${i}.pdf`, `2026-11-10 15:0${i}:00`);
	}
	db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?)").run(JSON.stringify({ optOutDomains: [], confirmedBrokerDomains: ["chrobinson.com"] }));
	db.prepare("INSERT INTO app_settings (key, value) VALUES ('factoring.settings', ?)").run(JSON.stringify({ debtorNames: { "chrobinson.com": DEBTOR } }));
	const rowId = Number(db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, total, broker_name, order_number, via, created_by) VALUES (?, ?, ?, ?, 'Made-up Agent', ?, 'auto-smtp', 'auto-invoice')")
		.run(LOAD, N, BILLING, TOTAL, LOAD).lastInsertRowid);
	autoLedger.insertClaim(db, { key: LOAD, loadId: LOAD, state: "drafted", nowIso: "2026-11-10T16:00:00.000Z" });
	const fingerprint = autoRules.fingerprint({ completed: true, live: true, paymentCents: 215000, brokerEmail: BROKER, trailer: "", podIds: [2], rateConIds: [1] });
	autoLedger.transition(db, LOAD, { from: ["drafted"], nowIso: "2026-11-10T16:00:00.000Z", patch: { delivery: "send", stage: "recorded", invoice_id: N, invoice_date: D,
		sent_at: "2026-11-10T16:00:00.000Z", draft_row_id: rowId, sent_json: JSON.stringify({ to: BILLING, subject: `Order #${LOAD}`, total: TOTAL }), fingerprint_json: JSON.stringify(fingerprint) } });
	db.close();
	const row = (id, email) => [id, "Delivered", "Made-up Driver", email, "2150", "11/10/2026 09:15", "11/10/2026"];
	const sheetData = { values: [HEADERS, row(LOAD, BROKER), row(OTHER_LOAD, "ap@example-broker.test")] };
	const calls = { drive: 0, gemini: 0, render: 0, otherFetch: 0 };
	const deps = {
		root: ROOT, dataDir: dir, sheetData, now: () => new Date(T0),
		getDrive: async () => { calls.drive++; return { files: { list: async () => ({ data: { files: [] } }), get: async () => { throw new Error("no Drive in this check"); } } }; },
		fetch: async (url) => {
			// Gemini's own host, by its exact name; anything else is refused.
			let host = "";
			try {
				host = new URL(String(url)).hostname;
			} catch {
				host = "";
			}
			if (host !== "generativelanguage.googleapis.com") { calls.otherFetch++; throw new Error("no network in this check"); }
			calls.gemini++;
			const answer = { "Load Number": LOAD, Rate: TOTAL, "Total Rate": TOTAL, "Documents Email": BILLING, "Order Number": null, "PO Number": null, "Trailer Number": null };
			return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), text: async () => "" };
		},
		renderHtmlToPdf: async (html) => { calls.render++; return renderStandIn(html); },
	};
	const hashOf = () => {
		const db2 = new Database(file, { readonly: true });
		try {
			return Object.fromEntries(db2.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => {
				const rows = db2.prepare(`SELECT * FROM ${name}`).all();
				return [name, `${rows.length}:${crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16)}`];
			}));
		} finally {
			db2.close();
		}
	};
	const files = () => fs.readdirSync(dir).sort();
	const argv = (load = LOAD) => [`--db=${file}`, `--load=${load}`, `--env-file=${settings}`];
	return { dir, file, settings, deps, calls, hashOf, files, argv };
}

// The practice run's answer, or a stand-in answer when it throws, so each case still reads by name.
const runIt = (opts) => rehearsal.run(opts).catch((e) => ({ code: "threw", lines: [String(e && e.message)] }));

(async () => {
	section("§1 a load the press would take");
	{
		const w = world();
		const before = w.hashOf();
		const filesBefore = w.files();
		const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("triumph-practice-")).length;
		const r = await runIt({ argv: w.argv(), deps: w.deps });
		eq([r.code, r.lines[r.lines.length - 1]], [0, "verdict: it would go"], "§1 FAILS ON THE OLD CODE (N-L5): the practice run: the press's checks and the job's own build pass");
		for (const line of ["the press's checks: would take it", "the rate con: whole read: yes", "the invoice's number matches the broker's: yes", "its date matches: yes", "its total matches: yes", "the hold fields since the send: unchanged", "writes attempted: 0"]) {
			ok(r.lines.includes(line), `§1 it says "${line}"`);
		}
		ok(r.lines.some((l) => /^the batch: \d+ pages \(invoice, ratecon, pod\)$/.test(l)), "§1 ...and the batch's pages and parts (counts only)");
		eq([r.code, w.hashOf()], [0, before], "§1 FAILS ON THE OLD CODE (N-L5): a whole practice run, and no row written: every table's count and content the same");
		eq([r.code, w.files()], [0, filesBefore], "§1 ...no file kept beside the database");
		eq([r.code, fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("triumph-practice-")).length], [0, tmpBefore], "§1 ...nor in the temp folder");
		eq([w.calls.gemini > 0, w.calls.render > 0, w.calls.otherFetch], [true, true, 0], "§1 it read the rate con and rendered the page, and reached nothing else");

		section("§2 verdicts only");
		const said = r.lines.join("\n");
		eq([r.code, SECRETS.filter((s) => said.includes(s))], [0, []], "§2 FAILS ON THE OLD CODE (N-L5): a whole run prints no amount, address, name, assignment line or invoice number");
		ok(!/\$\d/.test(said) && !/@/.test(said), "§2 ...no figure and no address at all");
	}

	section("§3 what it refuses, and where it stops");
	{
		const w = world();
		const writable = await runIt({ argv: w.argv(), deps: { ...w.deps, openDb: (f) => new Database(f) } });
		eq([writable.code, /read-only/.test(writable.lines.join(" "))], [2, true], "§3 FAILS ON THE OLD CODE (N-L5): a handle that isn't read-only: refused before anything is read");
		const before = w.hashOf();
		const noLoad = await runIt({ argv: [`--db=${w.file}`, `--env-file=${w.settings}`], deps: w.deps });
		eq(noLoad.code, 2, "§3 no load named: refused");
		// Beside the checkout, neither its own folder nor the temp folder: refused before any settings are read.
		const elsewhere = path.join(path.dirname(ROOT), "made-up-practice.db");
		const out = await runIt({ argv: [`--db=${elsewhere}`, `--load=${LOAD}`], deps: w.deps });
		eq([out.code, fs.existsSync(elsewhere)], [2, false], "§3 a database outside the app's own folder or the temp folder: refused, and nothing made there");
		const other = await runIt({ argv: w.argv(OTHER_LOAD), deps: w.deps });
		eq([other.code, other.lines[other.lines.length - 1]], [2, "the press's checks: would refuse it (NOT_CHR)"], "§3 a load the press refuses (another broker's): stopped with the press's own code");
		eq([other.code, w.hashOf()], [2, before], "§3 ...and nothing written by any of them");
		const advance = world({ ratecon: `${RATECON_TEXT} Advanced Total: $500.00 New Total: $1,650.00` });
		const adv = await runIt({ argv: advance.argv(), deps: advance.deps });
		eq([adv.code, adv.lines.includes("the build: would stop at build (ADVANCE_ON_RATECON)")], [2, true], "§3 FAILS ON THE OLD CODE: an advance on the rate con: the build stops where the job would, with its code");
		const advRead = world();
		{
			const db = new Database(advRead.file);
			rateconAdvanceRead.ensureTable(db);
			db.prepare(`INSERT INTO ${rateconAdvanceRead.TABLE} (load_key, at, verdict, reason, switch_on) VALUES (?, ?, 'unread', 'unreadable', 0)`).run(LOAD, T0);
			db.close();
		}
		const ar = await runIt({ argv: advRead.argv(), deps: advRead.deps });
		eq([ar.code, ar.lines[ar.lines.length - 1]], [2, "the press's checks: would refuse it (ADVANCE_ON_RATECON)"], "§3 an advance read on file: the press's dry run refuses it first");
	}

	section("§4 the server's own code, and no writer");
	{
		const SRC = serverSource({ root: ROOT });
		let lifted = { names: [], text: "" };
		try {
			lifted = rehearsal.liftReaders(SRC);
		} catch (e) {
			failures.push(`§4 FAILS ON THE OLD CODE (N2-L3): the readers lift from server.js\n      threw ${e && e.message}`);
		}
		eq(rehearsal.ROOTS.filter((n) => !lifted.names.includes(n)), [], "§4 FAILS ON THE OLD CODE (N2-L3): every reader the engine and the job take is lifted from server.js");
		const { decls } = require(path.join(ROOT, "scripts", "lib", "server-lift.js")).indexDeclarations(SRC);
		eq(lifted.names.filter((n) => !decls.has(n) || !SRC.includes(decls.get(n).text)), [], "§4 FAILS ON THE OLD CODE (N2-L3): each lifted declaration is server.js's own text, read at run time");
		const own = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, "utf8") : "";
		ok(own.includes("liftReaders(SRC)") || own.includes("const lifted = liftReaders("), "§4 FAILS ON THE OLD CODE (N2-L3): the script lifts its readers from server.js at run time");
		eq(rehearsal.ROOTS.filter((n) => new RegExp(`(?:async )?function ${n}\\(|const ${n} =`).test(own)), [], "§4 FAILS ON THE OLD CODE (N2-L3): the script holds no copy of any reader");
		eq(lifted.names.filter((n) => rehearsal.DENIED.includes(n)), [], "§4 FAILS ON THE OLD CODE (N2-L3): nothing lifted is the Sheets writer, the mailer, the sockets, the number or a job");
		eq(["logAudit", "rememberRateConMatch", "getSheets", "getDrive"].filter((n) => lifted.names.includes(n)), [], "§4 ...the writers the readers name, and the clients, are the script's own stand-ins, never lifted");
		for (const writer of ["sendEmail", "jtCacheInvalidate", "nextInvoiceNumber", "appendGmailDraft"]) {
			let threw = "";
			try { rehearsal.liftReaders(SRC, { roots: [writer] }); } catch (e) { threw = String(e.message); }
			ok(/must never lift/.test(threw), `§4 a root that is ${writer}: refused`);
		}
		let reach = "";
		try { rehearsal.liftReaders(SRC, { roots: ["getRateConBytes"], denied: ["fetchDocumentBytes"] }); } catch (e) { reach = String(e.message); }
		ok(/reaches fetchDocumentBytes/.test(reach), "§4 a reader that reaches a denied name: refused before anything runs");
		let hosts = "";
		try { await rehearsal.geminiOnlyFetch(async () => ({ ok: true }))("https://example.test/upload", {}); } catch (e) { hosts = String(e.message); }
		ok(/nothing but the rate con's read/.test(hosts), "§4 the practice run's fetch reaches Gemini's endpoint only");
	}

	section("§5 the batch as the live press would build it");
	{
		const ON = "TRIUMPH_BATCH_DEDUPE_ENABLED=true";
		const counts = (r) => r.lines.filter((l) => /identical documents sent once/.test(l));
		const w = world({ podCopies: 1, settings: [ON] });
		const before = w.hashOf();
		const r = await runIt({ argv: w.argv(), deps: w.deps });
		eq([r.code, r.lines[r.lines.length - 1]], [0, "verdict: it would go"], "§5 (fixture) the POD stored twice, the switch on in the settings file: it would go");
		ok(r.lines.includes("the batch: 3 pages (invoice, ratecon, pod)"), "§5 FAILS ON THE OLD CODE (M1): the switch in the settings file reaches the practice run's build: the POD goes in once");
		eq(counts(r), ["identical documents sent once: 1"], "§5 FAILS ON THE OLD CODE (M1): ...and the run prints how many copies it left out, a count and nothing else");
		eq([w.hashOf(), w.calls.otherFetch], [before, 0], "§5 ...writing no row and reaching nothing else");

		// The switch set in this process's environment and not in the settings file: off.
		const p = world({ podCopies: 1 });
		const had = Object.hasOwn(process.env, "TRIUMPH_BATCH_DEDUPE_ENABLED");
		const was = process.env.TRIUMPH_BATCH_DEDUPE_ENABLED;
		process.env.TRIUMPH_BATCH_DEDUPE_ENABLED = "true";
		let pr;
		try {
			pr = await runIt({ argv: p.argv(), deps: p.deps });
		} finally {
			if (had) process.env.TRIUMPH_BATCH_DEDUPE_ENABLED = was;
			else delete process.env.TRIUMPH_BATCH_DEDUPE_ENABLED;
		}
		eq([pr.code, pr.lines.includes("the batch: 4 pages (invoice, ratecon, pod, pod)"), counts(pr)], [0, true, []],
			"§5 the switch set only in this process's environment: off, every row goes in and no count (mutant: the switch read from the process's environment)");

		// A lowered limit in the settings file reaches the build, as the live press reads it.
		const small = world({ settings: ["TRIUMPH_BATCH_MAX_BYTES=2000"] });
		const sr = await runIt({ argv: small.argv(), deps: small.deps });
		eq([sr.code, sr.lines[sr.lines.length - 1]], [2, "the build: would stop at build (BATCH_TOO_LARGE)"],
			"§5 FAILS ON THE OLD CODE (N2): a lowered TRIUMPH_BATCH_MAX_BYTES in the settings file stops the practice run at BATCH_TOO_LARGE, as it stops the live press");
		const both = world({ podCopies: 1, settings: [ON, "TRIUMPH_BATCH_MAX_BYTES=2000"] });
		const br = await runIt({ argv: both.argv(), deps: both.deps });
		eq([br.code, br.lines[br.lines.length - 1]], [2, "the build: would stop at build (BATCH_TOO_LARGE); identical documents sent once: 1"],
			"§5 FAILS ON THE OLD CODE (N2): ...and with the switch on too, the stop says how many copies were left out");

		// The job gets the batch's two settings and nothing else, so its submit mode stays off.
		const live = world({ podCopies: 1, settings: [ON, "TRIUMPH_BATCH_MAX_BYTES=900000", "TRIUMPH_SUBMIT_ENABLED=true", "TRIUMPH_SUBMIT_DRY_RUN=false", "TRIUMPH_LIVE_CONFIRMED_ON=2026-11-05"] });
		const jobLib = require(path.join(ROOT, "lib", "triumph-job.js"));
		const create = jobLib.create;
		const made = [];
		jobLib.create = (deps) => {
			const job = create(deps);
			made.push({ env: { ...deps.env }, mode: job.mode });
			return job;
		};
		let lr;
		try {
			lr = await runIt({ argv: live.argv(), deps: live.deps });
		} finally {
			jobLib.create = create;
		}
		eq(made, [{ env: { TRIUMPH_BATCH_DEDUPE_ENABLED: "true", TRIUMPH_BATCH_MAX_BYTES: "900000" }, mode: "off" }],
			"§5 FAILS ON THE OLD CODE (M1): the job gets only the batch's two settings from the file, so its submit mode reads off whatever the file says");
		eq([lr.code, lr.lines[lr.lines.length - 1], counts(lr)], [0, "verdict: it would go", ["identical documents sent once: 1"]], "§5 FAILS ON THE OLD CODE: ...and the run goes on to its verdict, counting the copy left out");
	}

	// A POD of one made-up camera photo (scripts/lib/made-up-jpeg.js): about 388 KB, and the rest of
	// the batch a few KB. Over a limit of its photo's bytes less 1,000 by a few KB, it fits at 70;
	// over a limit of 60,000 by less than the photo's bytes, it is still over at 50.
	const jpegs = require(path.join(ROOT, "scripts", "lib", "made-up-jpeg.js"));
	const PHOTO = jpegs.jpeg({ seed: 1 });
	const PHOTO_POD = await jpegs.imagePdf([{ text: [`PROOF OF DELIVERY (MADE UP) Load ${LOAD}`], images: [{ bytes: PHOTO, width: 820, height: 620 }] }]);
	const FITS = `TRIUMPH_BATCH_MAX_BYTES=${PHOTO.length - 1000}`;
	const FLOOR = "TRIUMPH_BATCH_MAX_BYTES=60000";
	const SWITCH = "TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED=true";
	const photoLines = (r) => r.lines.filter((l) => /page images?/.test(l));

	section("§6 way 1's photo re-compress in the practice run");
	{
		const w = world({ podPdf: PHOTO_POD, settings: [SWITCH, FITS] });
		const before = w.hashOf();
		const r = await runIt({ argv: w.argv(), deps: w.deps });
		eq([r.code, r.lines[r.lines.length - 1]], [0, "verdict: it would go"], "§6 FAILS ON THE OLD CODE: the switch in the settings file reaches the practice run's build: over the lowered limit, the photo POD fits once re-compressed");
		const said = photoLines(r);
		ok(said.length === 1 && new RegExp(`^page images re-compressed: 1 at quality 70 \\(${PHOTO_POD.length} → \\d+ bytes\\)$`).test(said[0]) && Number(/→ (\d+) bytes/.exec(said[0])[1]) < PHOTO_POD.length,
			`§6 FAILS ON THE OLD CODE: ...and the run prints how many page images, at what quality, and the POD's bytes before and after (${said.join(" | ")})`);
		eq([w.hashOf(), w.calls.otherFetch], [before, 0], "§6 ...writing no row and reaching nothing else");

		const f = world({ podPdf: PHOTO_POD, settings: [SWITCH, FLOOR] });
		const fr = await runIt({ argv: f.argv(), deps: f.deps });
		eq([fr.code, fr.lines[fr.lines.length - 1]], [2, "the build: would stop at build (BATCH_TOO_LARGE); page images: stopped at the floor"],
			"§6 FAILS ON THE OLD CODE: still over at 50: the stop line says the floor was reached");

		// Set only in this process's environment, and not in the settings file: off.
		const p = world({ podPdf: PHOTO_POD, settings: [FITS] });
		const had = Object.hasOwn(process.env, "TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED");
		const was = process.env.TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED;
		process.env.TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED = "true";
		let pr;
		try {
			pr = await runIt({ argv: p.argv(), deps: p.deps });
		} finally {
			if (had) process.env.TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED = was;
			else delete process.env.TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED;
		}
		eq([pr.code, pr.lines[pr.lines.length - 1], photoLines(pr)], [2, "the build: would stop at build (BATCH_TOO_LARGE)", []],
			"§6 the switch set only in this process's environment: off, the stop as it always was (mutant: the switch read from the process's environment)");

		// The job gets the batch's three settings from the file and nothing else: its mode reads off.
		const live = world({ podPdf: PHOTO_POD, settings: [SWITCH, FITS, "TRIUMPH_BATCH_DEDUPE_ENABLED=true", "TRIUMPH_SUBMIT_ENABLED=true", "TRIUMPH_SUBMIT_DRY_RUN=false", "TRIUMPH_LIVE_CONFIRMED_ON=2026-11-05"] });
		const jobLib = require(path.join(ROOT, "lib", "triumph-job.js"));
		const create = jobLib.create;
		const made = [];
		jobLib.create = (deps) => {
			const job = create(deps);
			made.push({ env: { ...deps.env }, mode: job.mode });
			return job;
		};
		let lr;
		try {
			lr = await runIt({ argv: live.argv(), deps: live.deps });
		} finally {
			jobLib.create = create;
		}
		eq(made, [{ env: { TRIUMPH_BATCH_DEDUPE_ENABLED: "true", TRIUMPH_BATCH_MAX_BYTES: String(PHOTO.length - 1000), TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED: "true" }, mode: "off" }],
			"§6 FAILS ON THE OLD CODE: the job gets the batch's three settings from the file and nothing else, so its submit mode reads off whatever the file says");
		eq([lr.code, lr.lines[lr.lines.length - 1], photoLines(lr).length], [0, "verdict: it would go", 1], "§6 FAILS ON THE OLD CODE: ...and the run goes on to its verdict, the photo re-compressed");
	}

	section("§7 Part A's look (scripts/triumph-batch-recompress-look.js)");
	{
		const LOOK = path.join(ROOT, "scripts", "triumph-batch-recompress-look.js");
		const look = fs.existsSync(LOOK) ? require(LOOK) : { run: async () => { throw new Error("scripts/triumph-batch-recompress-look.js is missing: Part A has no tool"); } };
		const lookIt = (opts) => look.run(opts).catch((e) => ({ code: "threw", lines: [String(e && e.message)] }));
		const line = (r, head) => r.lines.find((l) => l.startsWith(head)) || "";
		// The switch is not in the settings file: Part A measures whatever it says.
		const w = world({ podPdf: PHOTO_POD, settings: [FITS] });
		const before = w.hashOf();
		const filesBefore = w.files();
		const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("triumph-practice-")).length;
		const r = await lookIt({ argv: w.argv(), deps: w.deps });
		eq(r.code, 0, `§7 FAILS ON THE OLD CODE (L4): Part A measures a load through the practice run's own build (${r.lines.join(" | ").slice(0, 300)})`);
		ok(/^the base: the job's own build in the practice run, measured by the batch builder itself: the batch as built today with the switch off, then each step merged again with it on$/.test(line(r, "the base:")),
			"§7 FAILS ON THE OLD CODE (N4): it says its source: the real parts the job's build handed the builder, merged by the builder at each step, never an estimate");
		ok(/^the batch as built today: \d+ bytes, over the limit of \d+ by \d+ bytes$/.test(line(r, "the batch as built today:")), "§7 FAILS ON THE OLD CODE: ...the batch as built today, in bytes, against the limit");
		eq(line(r, "the photos the steps would take:"), `the photos the steps would take: 1 of 1 page image on the BOL and POD pages (${PHOTO.length} bytes)`, "§7 FAILS ON THE OLD CODE: ...how many photos the whitelist takes, and their bytes");
		ok(/^re-compressed: fits at quality 70: \d+ → \d+ bytes, within the limit \(\d+ to spare\); 1 page image re-compressed, 0 left; the BOL and POD parts \d+ → \d+ bytes$/.test(line(r, "re-compressed:")),
			`§7 FAILS ON THE OLD CODE: ...and the step it would fit at, with the bytes before and after (${line(r, "re-compressed:")})`);
		eq(line(r, "the practice run:"), "the practice run: the build: would stop at build (BATCH_TOO_LARGE) (code 2)", "§7 FAILS ON THE OLD CODE: ...beside the practice run's own verdict, the switch off in its settings file");
		const said = r.lines.join("\n");
		eq([SECRETS.filter((s) => said.includes(s)), /\$\d/.test(said), /@/.test(said), said.includes(LOAD)], [[], false, false, false], "§7 counts only: no amount, address, name, invoice number or load number");
		eq([w.hashOf(), w.files(), fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("triumph-practice-")).length], [before, filesBefore, tmpBefore], "§7 ...no row written, no file kept beside the database or in the temp folder");

		const f = world({ podPdf: PHOTO_POD, settings: [FLOOR] });
		const fr = await lookIt({ argv: f.argv(), deps: f.deps });
		ok(fr.code === 0 && /^re-compressed: stops at the floor \(quality 50\): \d+ → \d+ bytes, over the limit by \d+ bytes; 1 page image re-compressed, 0 left; the BOL and POD parts \d+ → \d+ bytes$/.test(line(fr, "re-compressed:")),
			`§7 FAILS ON THE OLD CODE: still over at 50: "stops at the floor", with the floor's bytes (${line(fr, "re-compressed:")})`);
		const t = world({ settings: ["TRIUMPH_BATCH_MAX_BYTES=2000"] });
		const tr = await lookIt({ argv: t.argv(), deps: t.deps });
		ok(tr.code === 0 && line(tr, "the photos the steps would take:") === "the photos the steps would take: 0 of 0 page images on the BOL and POD pages (0 bytes)"
			&& line(tr, "re-compressed:") === "re-compressed: not tried: the batch is over by at least its photos' bytes, so no step can fit", "§7 FAILS ON THE OLD CODE: a POD of text over the limit: no photo, so no step is tried, and it says so");
		const u = world({ podPdf: PHOTO_POD });
		const ur = await lookIt({ argv: u.argv(), deps: u.deps });
		ok(ur.code === 0 && /^the batch as built today: \d+ bytes, within the limit of \d+ \(\d+ to spare\)$/.test(line(ur, "the batch as built today:")) && line(ur, "re-compressed:") === "re-compressed: not needed: the batch is within the limit as built today",
			"§7 FAILS ON THE OLD CODE: a batch within the limit: nothing to re-compress, and it says so");
		const a = world({ ratecon: `${RATECON_TEXT} Advanced Total: $500.00 New Total: $1,650.00` });
		const ar = await lookIt({ argv: a.argv(), deps: a.deps });
		eq([ar.code, line(ar, "not measured:")], [2, "not measured: the build stopped before the batch was put together (ADVANCE_ON_RATECON)"], "§7 FAILS ON THE OLD CODE: a load the build stops first: not measured, with the code");
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	for (const f of failures) console.log(`FAIL  ${f}`);
	process.exit(failures.length ? 1 : 0);
})().catch((e) => {
	console.log(`FAIL  the runner itself: ${e && e.stack}`);
	process.exit(1);
});
