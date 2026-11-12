#!/usr/bin/env node
// lib/triumph-job.js and lib/triumph-ledger.js: the Triumph submit job, on an in-memory
// database, a stand-in engine, made-up PDFs, and either a counting transport or the real one
// against an in-process ssh2 server (scripts/e2e/fake-triumph.cjs).
//
//   §1 how a claim starts: a driver's own Delivered on a factored load, or Start; a load
//      handled in Triumph's process is never claimed; off makes nothing
//   §2 the checks before any number: DTR_NAME's own rules (R-L3), the debtor map, the lines,
//      rule 7's list, the month, a draft row or mailbox evidence; a cleared mark gives up
//   §3 dry run: built and staged with a real number, nothing connects; "false" with no date is
//      dry; a staged batch never goes by itself once live is on
//   §4 the lock point: each change made during the last await refuses, voids the number and
//      sends nothing; another owner's call and a dry run's are refused
//   §5 live, end to end, over the real protocol: the PDF then the CSV, the record, the lock;
//      two workers make one submission
//   §6 failures: a PDF that fails goes again, a CSV cut off is never sent again
//      (MAYBE_SUBMITTED), a refused sign-in and a host key that doesn't match pause; the
//      retries; live with no connection settings runs nothing
//   §7 recovery after a restart at each stage
//   §8 "Submit now": live only, every check again before connecting, the lock point, and a stop
//      before the lock leaves the batch staged
//   §9 caps and the Friday-evening window
//   §10 voided numbers, a load changed after its submission, the daily notices
//   §11 rule 7 on what goes: the invoice page, and the list as it is when the batch is sent;
//       the CSV's values found printed in the PDF
//   §12 the sample's --dry-run and --upload: made up only, nothing of a load touched
//
// Made-up loads only (LD-TEST-*), in memory and under the system temp folder.
//   node scripts/test-triumph-job.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
for (const f of ["triumph-job.js", "triumph-ledger.js", "triumph-transfer.js"]) {
	if (!fs.existsSync(path.join(ROOT, "lib", f))) {
		console.log(`FAIL  lib/${f} is missing: there is no submit job, no ledger or no transport`);
		process.exit(1);
	}
}
const jobLib = require(path.join(ROOT, "lib", "triumph-job.js"));
const ledger = require(path.join(ROOT, "lib", "triumph-ledger.js"));
const transfer = require(path.join(ROOT, "lib", "triumph-transfer.js"));
const factoring = require(path.join(ROOT, "lib", "factoring-store.js"));
const triumphBatch = require(path.join(ROOT, "lib", "triumph-batch.js"));
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
const { createRedactor } = require(path.join(ROOT, "lib", "chr-events.js"));
const { startFakeTriumph, fingerprintOfKey } = require(path.join(ROOT, "scripts", "e2e", "fake-triumph.cjs"));
const { utils: { generateKeyPairSync } } = require(path.join(ROOT, "node_modules", "ssh2"));
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const { PDFDocument, StandardFonts } = require(path.join(ROOT, "node_modules", "pdf-lib"));

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

const TZ = "America/New_York";
// Thursday, 10:00 in New York.
const T0 = "2026-11-12T15:00:00.000Z";
const KEY = "ld-test-0001";
const LOAD = "LD-TEST-0001";
const NOA = ["MADE-UP FACTOR LINE ONE", "MADE-UP FACTOR LINE TWO", "MADE-UP FACTOR LLC", "MADE-UP REMIT LINE"];
const DENY = "998877665544";
const DRY = { TRIUMPH_SUBMIT_ENABLED: "true" };
const LIVE = { TRIUMPH_SUBMIT_ENABLED: "true", TRIUMPH_SUBMIT_DRY_RUN: "false", TRIUMPH_LIVE_CONFIRMED_ON: "2026-11-05" };
const HEADERS = ["Load ID", "Status", "Email", "Completion Date", "  Payment  "];

async function pdfOf(lines) {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const page = doc.addPage([612, 792]);
	lines.forEach((text, i) => page.drawText(`${text} `, { x: 54, y: 720 - i * 20, size: 12, font }));
	return Buffer.from(await doc.save({ useObjectStreams: false }));
}

let RATECON;
let POD;
const invoicePdfFor = (invoiceId, dayKey, { po = LOAD, extra = [] } = {}) => pdfOf(["INVOICE (MADE UP)", `Invoice ID #: ${invoiceId}`, `Date: ${brokerInvoice.formatDate(dayKey)}`, `Order #: ${po}`, "Total: $2,150.00", ...NOA, ...extra]);

const clock = (iso) => {
	const c = { ms: Date.parse(iso) };
	c.now = () => new Date(c.ms);
	c.add = (min) => { c.ms += min * 60000; };
	return c;
};

// Every world made, so the last check can read every code a claim was left with.
const WORLDS = [];
// A world: the database as the app has it, the sheet, the engine and a transport.
function world({ env = DRY, factored = true, debtor = "Example Broker LLC", status = "Delivered", completion = "2026-11-11", noa = NOA, deny = DENY, transport = "stub", at = T0, extraInvoiceText = [], po = LOAD } = {}) {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, recipient_source TEXT, total TEXT,
		broker_name TEXT, order_number TEXT, via TEXT, created_by TEXT, edited INTEGER DEFAULT 0, edited_fields TEXT, overrides_json TEXT, total_source TEXT,
		sheet_total TEXT, ratecon_total TEXT, invoice_id_minted TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
	db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY, load_id TEXT, type TEXT, file_name TEXT, drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at TEXT, deleted_at TEXT)");
	db.exec("CREATE TABLE deleted_loads (load_id TEXT)");
	db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by TEXT)");
	db.exec("CREATE TABLE bison_invoice_seq (day TEXT PRIMARY KEY, n INTEGER)");
	factoring.ensureSchema(db);
	db.prepare("INSERT INTO documents (id, load_id, type, file_name, drive_url, uploaded_at) VALUES (1, ?, 'POD', 'pod.pdf', '/uploads/pod.pdf', '2026-11-10 14:00:00')").run(LOAD);
	db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?)").run(JSON.stringify({ optOutDomains: [], confirmedBrokerDomains: ["example-broker.test"] }));
	if (debtor !== null) db.prepare("INSERT INTO app_settings (key, value) VALUES ('factoring.settings', ?)").run(JSON.stringify({ debtorNames: { "example-broker.test": debtor } }));
	if (factored) db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES (?, ?, 1, 'script', ?, ?)").run(KEY, LOAD, T0, T0);
	const sheet = { status, completion, rows: [] };
	const w = { db, sheet, clock: clock(at), spies: { prepare: 0, render: 0, record: 0, mint: 0, connect: 0, puts: [] }, audits: [], notices: [], batchDir: fs.mkdtempSync(path.join(os.tmpdir(), "triumph-job-")), envBase: env };
	w.readJobTracking = async () => ({ headers: HEADERS, data: [{ "Load ID": LOAD, Status: sheet.status, Email: "ap@example-broker.test", "Completion Date": sheet.completion, "  Payment  ": "2150" }, ...sheet.rows] });
	let n = 0;
	w.engine = {
		async prepare() {
			w.spies.prepare++;
			if (w.onPrepare) w.onPrepare();
			return { ok: true, ctx: { loadId: LOAD, loadRef: LOAD, orderNumber: po, assignment: noa ? { lines: noa } : null, rateconBuffer: RATECON,
				rateconCandidates: [{ source: "documents" }], paidRead: { "Load Number": LOAD } } };
		},
		async render(ctx, { invoiceId, invoiceDate }) {
			w.spies.render++;
			return { invoicePdf: await invoicePdfFor(invoiceId, invoiceDate, { extra: extraInvoiceText }), total: "$2,150.00" };
		},
		async record(ctx, rendered, opts) {
			w.spies.record++;
			w.recordOpts = opts;
			const id = db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, total, via, created_by) VALUES (?, ?, 'ap@example-broker.test', ?, ?, 'triumph')").run(LOAD, opts.invoiceId, rendered.total, opts.via).lastInsertRowid;
			return { recorded: true, draftRowId: Number(id) };
		},
	};
	w.nextInvoiceNumber = () => `11122026-${++n}`;
	w.denyHits = deny ? createRedactor({ denyList: deny }).hits : null;
	w.stubTransport = {
		configured: true,
		missing: [],
		invalid: [],
		async openLive() {
			w.spies.connect++;
			if (w.onConnect) await w.onConnect();
			if (w.connectError) throw Object.assign(new Error(w.connectError), { code: w.connectError });
			return {
				async put(token, file) {
					// The real transport's own gate, so the job can't pass with an order the transport refuses.
					const checked = ledger.tokenCheck(db, token, { nowIso: w.clock.now().toISOString(), name: file.name, sha256: crypto.createHash("sha256").update(file.bytes).digest("hex") });
					if (!checked.ok) throw Object.assign(new Error(checked.code), { code: checked.code });
					// Every try is counted, a failed one too.
					w.spies.puts.push(file.name);
					const failure = w.putError ? w.putError(file.name) : null;
					if (failure) throw Object.assign(new Error("made-up"), failure);
					return { ok: true };
				},
				close() {},
			};
		},
	};
	w.make = (over = {}) => jobLib.create({
		db,
		env: w.envBase,
		readJobTracking: w.readJobTracking,
		closedMonthsOf: () => (w.closed === undefined ? [] : w.closed),
		dayKeyOf: (cell) => String(cell || "").slice(0, 10),
		engine: w.engine,
		nextInvoiceNumber: () => { w.spies.mint++; return w.nextInvoiceNumber(); },
		loadDocuments: async () => [{ id: 1, type: "POD", uploaded_at: "2026-11-10 14:00:00", buffer: POD }],
		transport: transport === "stub" ? w.stubTransport : transport,
		noaLines: noa,
		denyHits: w.denyHits,
		savedInvoiceEvidence: () => w.mailbox === true,
		batchDir: w.batchDir,
		logAudit: (req, action, entity, id, details) => w.audits.push({ who: req && req.session && req.session.user && req.session.user.username, action, id, details }),
		notify: (n0) => w.notices.push(n0),
		now: w.clock.now,
		timeZone: TZ,
		workerId: "made-up-worker",
		setImmediate: () => {},
		log: { info() {}, warn() {}, error() {} },
		...over,
	});
	w.claim = () => ledger.getClaim(db, KEY);
	w.marker = () => db.prepare("SELECT * FROM load_factoring WHERE load_key = ?").get(KEY);
	w.drafts = () => db.prepare("SELECT load_id, invoice_id, via FROM load_invoice_drafts ORDER BY id").all();
	w.actions = () => w.audits.map((a) => a.action);
	w.queue = (state = "queued", extra = {}) => {
		ledger.ensureSchema(db);
		ledger.insertClaim(db, { key: KEY, loadId: LOAD, state, nowIso: T0 });
		if (Object.keys(extra).length) ledger.transition(db, KEY, { from: [state], nowIso: T0, patch: extra });
	};
	WORLDS.push(w);
	return w;
}
const say = (c) => (c ? `${c.state}${c.reason_code ? ` ${c.reason_code}` : ""}` : "none");

(async () => {
	RATECON = await pdfOf(["RATE CONFIRMATION (MADE UP)", "Broker: Example Broker LLC", `Load Number: ${LOAD}`, "Total Rate: $2,150.00"]);
	POD = await pdfOf(["PROOF OF DELIVERY (MADE UP)", `Load Number: ${LOAD}`]);

	// ---------------------------------------------------------------- §1
	section("§1 how a claim starts");
	{
		const w = world();
		const job = w.make();
		eq(job.mode, "dry", "§1 (fixture) the submit mode reads dry");
		job.deliveredByDriver({ role: "Dispatcher", loadId: LOAD, oldStatus: "At Receiver", newStatus: "Delivered" }).written();
		job.deliveredByDriver({ role: "Driver", loadId: LOAD, oldStatus: "Delivered", newStatus: "Completed" }).written();
		job.deliveredByDriver({ role: "Driver", loadId: LOAD, oldStatus: "At Receiver", newStatus: "In Transit" }).written();
		eq(w.claim(), null, "§1 a dispatcher's Delivered, a tap from one completed status to another, or a status short of Delivered: no claim");
		job.deliveredByDriver({ role: "Driver", loadId: LOAD, oldStatus: "At Receiver", newStatus: "Delivered" }).written();
		eq(say(w.claim()), "queued", "§1 the driver's own Delivered on a factored load: in line");
		eq(w.actions(), ["triumph_started"], "§1 ...with one audit row");

		// The wake: only in a process whose timers run (server.js starts them behind startsJob()).
		for (const [label, starts, want] of [["timers never started (an import, a replica)", false, 0], ["timers started", true, 1]]) {
			const woke = [];
			const ww = world();
			const wj = ww.make({ setImmediate: (fn) => woke.push(fn) });
			if (starts) wj.startTimers({ setTimeout: () => {}, setInterval: () => {} });
			wj.deliveredByDriver({ role: "Driver", loadId: LOAD, oldStatus: "At Receiver", newStatus: "Delivered" }).written();
			eq([say(ww.claim()), woke.length], ["queued", want], `§1 the driver's Delivered, ${label}: in line, and ${want ? "the run woken" : "no run woken"}`);
		}

		const plain = world({ factored: false });
		plain.make().deliveredByDriver({ role: "Driver", loadId: LOAD, oldStatus: "At Receiver", newStatus: "Delivered" }).written();
		eq(plain.claim(), null, "§1 a load not marked factored: no claim (the email invoice is its)");

		const outside = world();
		outside.db.prepare("UPDATE load_factoring SET locked_at = ?, locked_via = 'outside' WHERE load_key = ?").run(T0, KEY);
		const oj = outside.make();
		oj.deliveredByDriver({ role: "Driver", loadId: LOAD, oldStatus: "At Receiver", newStatus: "Delivered" }).written();
		eq(outside.claim(), null, "§1 FAILS WITHOUT THE LOCK CHECK: a load handled in Triumph's process is never claimed by a tap");
		eq(oj.start({}, LOAD), { ok: false, code: "FACTORING_LOCKED", http: 409 }, "§1 ...nor by Start");
		await oj.tick();
		eq([outside.claim(), outside.spies.connect, outside.spies.prepare], [null, 0, 0], "§1 ...and a tick builds and sends nothing for it");

		// Handled in Triumph's process while it had a claim: the claim is closed, and stays so.
		const closed = world({ env: LIVE });
		closed.queue("queued");
		const hr = factoring.handledOutside(closed.db, { key: KEY, reason: "made-up: sent by hand in Triumph's process", nowIso: T0, audit: () => {} });
		const cj = closed.make();
		cj.deliveredByDriver({ role: "Driver", loadId: LOAD, oldStatus: "At Receiver", newStatus: "Delivered" }).written();
		await cj.tick();
		eq([hr.ok, say(closed.claim()), closed.spies.prepare, closed.spies.connect, closed.spies.puts.length], [true, "closed_outside", 0, 0, 0],
			"§1 FAILS WITHOUT THE LOCK CHECK: with submit live, a claim closed in Triumph's process is never worked, re-armed or uploaded");

		const s = world();
		const sj = s.make();
		eq(sj.start({ session: { user: { username: "made-up-admin" } } }, LOAD), { ok: true }, "§1 Start on a marked load nothing started: in line");
		eq([say(s.claim()), s.audits[0].who], ["queued", "made-up-admin"], "§1 ...audited as the person");
		eq(sj.start({}, LOAD), { ok: false, code: "TRIUMPH_ALREADY_STARTED", http: 409 }, "§1 Start on one already in line: refused");
		eq(world({ factored: false }).make().start({}, LOAD), { ok: false, code: "NOT_FACTORED", http: 409 }, "§1 Start on a load not marked: refused");

		const off = world({ env: {} });
		const offJob = off.make();
		eq(offJob.mode, "off", "§1 nothing set: off");
		offJob.deliveredByDriver({ role: "Driver", loadId: LOAD, oldStatus: "At Receiver", newStatus: "Delivered" }).written();
		eq([ledger.hasSchema(off.db), offJob.start({}, LOAD).code, (await offJob.tick()).mode], [false, "FEATURE_OFF", "off"], "§1 off: no table of its own, no claim, Start answers FEATURE_OFF, a tick does nothing");
		eq(world({ env: LIVE }).make({ replica: true }).mode, "off", "§1 a replica reads off, whatever its settings say");
	}

	// ---------------------------------------------------------------- §2
	section("§2 the checks before any number");
	{
		const stops = async (label, opts, setup, want) => {
			const w = world(opts);
			if (setup) setup(w);
			w.queue();
			await w.make().tick();
			eq([say(w.claim()), w.spies.mint, w.spies.prepare, w.spies.connect], [want, 0, 0, 0], `§2 ${label}: ${want}, with no number, no engine, no connection`);
			return w;
		};
		await stops("FAILS ON A BUILD THAT CHECKS THE NAME ONLY WHEN IT BUILDS (R-L3): a debtor name holding a comma", { debtor: "Example Broker, LLC" }, null, "needs_attention DEBTOR_NAME_COMMA");
		await stops("a debtor name with a double quote", { debtor: "Example \"Broker\" LLC" }, null, "needs_attention FIELD_UNUSABLE");
		await stops("no debtor name for the broker's domain", { debtor: null }, null, "needs_attention DEBTOR_UNMAPPED");
		await stops("a debtor map that can't be read", {}, (w) => w.db.prepare("UPDATE app_settings SET value = 'not json' WHERE key = 'factoring.settings'").run(), "needs_attention SETTINGS_UNREADABLE");
		await stops("no assignment lines", { noa: null }, null, "needs_attention NOA_UNCONFIGURED");
		await stops("no carrier deny list", { deny: "" }, null, "needs_attention DENY_LIST_UNSET");
		await stops("a draft row of another kind", {}, (w) => w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via) VALUES (?, '11112026-3', 'imap')").run(LOAD), "needs_attention ALREADY_INVOICED");
		await stops("saved mailbox evidence of an invoice", {}, (w) => { w.mailbox = true; }, "needs_attention ALREADY_INVOICED");
		await stops("a closed month", {}, (w) => { w.closed = ["2026-10"]; }, "needs_attention CLOSED_MONTH");
		await stops("a month that can't be told", {}, (w) => { w.closed = null; }, "needs_attention MONTH_UNKNOWN");
		await stops("a button draft in flight", {}, (w) => w.db.prepare("INSERT INTO invoice_draft_inflight (load_key, load_id, invoice_id, path, state, started_at, updated_at) VALUES (?, ?, '11122026-9', 'imap', 'in_flight', ?, ?)").run(KEY, LOAD, T0, T0), "waiting INVOICE_DRAFT_IN_FLIGHT");
		await stops("not delivered yet", { status: "In Transit" }, null, "waiting NOT_COMPLETED");
		const cleared = await stops("the mark cleared", {}, (w) => w.db.prepare("UPDATE load_factoring SET factored = 0 WHERE load_key = ?").run(KEY), "skipped NOT_FACTORED");
		ok(!cleared.audits.some((a) => a.action === "triumph_number_void"), "§2 ...a load that never had a number voids none");
		const outside = await stops("a claim whose load was then handled in Triumph's process", {}, (w) => w.db.prepare("UPDATE load_factoring SET locked_at = ?, locked_via = 'outside' WHERE load_key = ?").run(T0, KEY), "skipped FACTORING_LOCKED");
		eq(outside.spies.puts, [], "§2 FAILS WITHOUT THE JOB'S LOCK CHECK: ...never uploaded");
		// The number's own transaction reads the marker again: a mark cleared while the engine read the load.
		const during = world();
		during.queue();
		during.onPrepare = () => during.db.prepare("UPDATE load_factoring SET factored = 0 WHERE load_key = ?").run(KEY);
		await during.make().tick();
		eq([say(during.claim()), during.spies.mint, during.spies.render], ["skipped NOT_FACTORED", 0, 0], "§2 FAILS ON A NUMBER THAT DOESN'T READ THE MARKER: a mark cleared during the engine's read: no number, no render");
	}

	// ---------------------------------------------------------------- §3
	section("§3 dry run");
	{
		const w = world({ env: DRY });
		w.queue();
		await w.make().tick();
		const c = w.claim();
		eq([say(c), c.stage, c.invoice_id], ["staged", "built", "11122026-1"], "§3 dry: built and staged, with a real number");
		eq([w.spies.connect, w.spies.puts.length, w.drafts().length], [0, 0, 0], "§3 FAILS ON A BUILD THAT CONNECTS IN DRY RUN: nothing connects, nothing is put, no draft row");
		eq(w.marker().locked_at, "", "§3 ...and the marker isn't locked");
		const dir = jobLib.create({ db: w.db, env: {}, batchDir: w.batchDir }).folderOf(KEY);
		eq(fs.readdirSync(dir).sort(), ["11122026-1.pdf", "invoice-page.pdf", c.csv_name].sort(), "§3 the batch's files, and the invoice page kept for the last check");
		eq([fs.statSync(dir).mode & 0o777, fs.statSync(path.join(dir, "11122026-1.pdf")).mode & 0o777], [0o700, 0o600], "§3 the folder 0700, the files 0600");
		ok(w.actions().includes("triumph_batch_staged"), "§3 audited as staged");
		ok(/^logisx_\d{8}T\d{6}Z_11122026-1\.csv$/.test(c.csv_name), "§3 the CSV named for the second and the number");

		// Live goes on: the staged batch waits for a person.
		const live = w.make({ env: LIVE });
		await live.tick();
		eq([say(w.claim()), w.spies.connect], ["staged", 0], "§3 FAILS ON A BUILD THAT SENDS STAGED BATCHES: once live is on, a staged batch stays staged and nothing connects");

		const nodate = world({ env: { TRIUMPH_SUBMIT_ENABLED: "true", TRIUMPH_SUBMIT_DRY_RUN: "false" } });
		nodate.queue();
		const nj = nodate.make();
		eq(nj.mode, "dry", "§3 \"false\" with no go-live date: dry");
		await nj.tick();
		eq([say(nodate.claim()), nodate.spies.connect], ["staged", 0], "§3 FAILS ON A DATE-BLIND MODE: ...staged, and nothing connects");
	}

	// ---------------------------------------------------------------- §4
	section("§4 the lock point");
	{
		for (const [label, change, want] of [
			["another kind's draft row", (w) => w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via) VALUES (?, '11112026-3', 'n8n')").run(LOAD), "needs_attention ALREADY_INVOICED"],
			["the mark cleared", (w) => w.db.prepare("UPDATE load_factoring SET factored = 0 WHERE load_key = ?").run(KEY), "skipped NOT_FACTORED"],
			["the number voided", (w) => w.db.prepare("UPDATE triumph_submissions SET number_voided_at = ? WHERE load_key = ?").run(T0, KEY), "needs_attention NUMBER_VOIDED"],
			["a button draft in flight", (w) => w.db.prepare("INSERT INTO invoice_draft_inflight (load_key, load_id, invoice_id, path, state, started_at, updated_at) VALUES (?, ?, '11122026-9', 'imap', 'in_flight', ?, ?)").run(KEY, LOAD, T0, T0), "waiting INVOICE_DRAFT_IN_FLIGHT"],
			["a button draft that may be in Gmail", (w) => w.db.prepare("INSERT INTO invoice_draft_inflight (load_key, load_id, invoice_id, path, state, started_at, updated_at) VALUES (?, ?, '11122026-9', 'imap', 'maybe_drafted', ?, ?)").run(KEY, LOAD, T0, T0), "needs_attention INVOICE_MAYBE_DRAFTED"],
			["the load handled in Triumph's process", (w) => w.db.prepare("UPDATE load_factoring SET locked_at = ?, locked_via = 'outside' WHERE load_key = ?").run(T0, KEY), "skipped FACTORING_LOCKED"],
		]) {
			const w = world({ env: LIVE });
			w.queue();
			w.onConnect = () => change(w);
			await w.make().tick();
			const c = w.claim();
			eq([say(c), w.spies.puts.length, w.spies.connect], [want, 0, 1], `§4 FAILS ON A BUILD THAT CHECKS ONLY AT THE FREE CHECKS AND THE NUMBER: ${label} during the connection: ${want}, nothing put`);
			ok(Boolean(c.number_voided_at), `§4 ...its number voided (${label})`);
			eq(w.audits.filter((a) => a.action === "triumph_submit_refused").length, 1, `§4 ...one triumph_submit_refused row (${label})`);
			eq(w.marker() ? w.marker().locked_via : "", label.includes("Triumph's process") ? "outside" : "", `§4 ...and the lock is not taken (${label})`);
		}
		const w = world({ env: LIVE });
		w.queue("working", { lease_owner: "made-up-run#1", lease_until: "2099-01-01T00:00:00.000Z", stage: "built", invoice_id: "11122026-1" });
		eq(ledger.lockForUpload(w.db, KEY, "another-run#2", { nowIso: T0, mode: "live" }).code, "CLAIM_LOST", "§4 FAILS ON A LOCK THAT IGNORES THE OWNER: another owner's call is refused");
		eq(ledger.lockForUpload(w.db, KEY, "made-up-run#1", { nowIso: T0, mode: "dry" }).code, "NOT_LIVE", "§4 FAILS ON A LOCK GATED ON ENABLED ALONE: a dry run's call: NOT_LIVE");
		eq(w.marker().locked_at, "", "§4 ...and locked_at stays empty");
		w.db.prepare("UPDATE load_factoring SET locked_at = ?, locked_via = 'upload' WHERE load_key = ?").run(T0, KEY);
		eq(ledger.lockForUpload(w.db, KEY, "made-up-run#1", { nowIso: T0, mode: "live" }).code, "FACTORING_LOCKED", "§4 a marker already locked by an upload that isn't this claim's: refused");
	}

	// ---------------------------------------------------------------- §5
	section("§5 live, end to end, over the real protocol");
	const HOST = generateKeyPairSync("ed25519");
	const CLIENT = generateKeyPairSync("ed25519");
	const SUBMIT = "/made-up/submit";
	const fakeEnv = (fake) => ({ ...LIVE, TRIUMPH_HOST: fake.host, TRIUMPH_PORT: String(fake.port), TRIUMPH_USER: "made-up-user", TRIUMPH_KEY_FILE: "/made-up/not-a-real-key-file",
		TRIUMPH_HOST_FINGERPRINT: fingerprintOfKey(HOST.private), TRIUMPH_HOST_KEY_TYPE: "ED25519", TRIUMPH_SUBMIT_DIR: SUBMIT });
	{
		const fake = await startFakeTriumph({ hostKey: HOST.private, clientKey: CLIENT.private, folders: [SUBMIT] });
		try {
			const w = world({ env: fakeEnv(fake) });
			const real = transfer.create({ db: w.db, env: fakeEnv(fake), readKeyFile: () => CLIENT.private, now: w.clock.now });
			w.queue();
			await w.make({ transport: real }).tick();
			const c = w.claim();
			eq([say(c), c.stage, c.via], ["submitted", "recorded", "triumph"], "§5 submitted: the claim recorded, via 'triumph'");
			eq(fake.ops.filter((o) => o.op === "OPEN").map((o) => path.posix.basename(o.path)), ["11122026-1.pdf", c.csv_name], "§5 the PDF first, then the CSV, in the submissions folder");
			ok(fake.files.get(`${SUBMIT}/${c.csv_name}`).toString().startsWith("DTR_NAME,INVOICE#,INV_DATE,PO,INVAMT\r\nExample Broker LLC,11122026-1,11/12/2026,LD-TEST-0001,2150.00\r\n"), "§5 the CSV, byte for byte");
			eq(w.drafts(), [{ load_id: LOAD, invoice_id: "11122026-1", via: "triumph" }], "§5 one draft row via 'triumph', so every reader treats the load as invoiced");
			eq([w.recordOpts.via, w.recordOpts.auditTarget], ["triumph", "Triumph"], "§5 ...the engine's own record(), its audit line naming Triumph");
			eq([w.marker().locked_via, Boolean(w.marker().locked_at)], ["upload", true], "§5 the marker locked by the upload, for good");
			eq(w.actions().filter((a) => a.startsWith("triumph_")), ["triumph_submitted"], "§5 audited as triumph_submitted by the system actor");
			eq(w.audits.find((a) => a.action === "triumph_submitted").who, "triumph", "§5 ...whose name is triumph");
			ok(!fake.writeOps().some((o) => ["REMOVE", "RENAME", "MKDIR", "RMDIR", "SETSTAT", "FSETSTAT"].includes(o.op)), "§5 nothing on Triumph's side was removed, renamed or changed");

		} finally {
			await fake.close();
		}
		// Two workers, one load: one submission.
		const fake2 = await startFakeTriumph({ hostKey: HOST.private, clientKey: CLIENT.private, folders: [SUBMIT] });
		try {
			const w2 = world({ env: fakeEnv(fake2) });
			const real2 = transfer.create({ db: w2.db, env: fakeEnv(fake2), readKeyFile: () => CLIENT.private, now: w2.clock.now });
			w2.queue();
			await Promise.all([w2.make({ transport: real2, workerId: "worker-a" }).tick(), w2.make({ transport: real2, workerId: "worker-b" }).tick()]);
			eq([say(w2.claim()), fake2.ops.filter((o) => o.op === "OPEN").length, w2.spies.mint], ["submitted", 2, 1], "§5 two workers on one load: one number, one PDF and one CSV");
		} finally {
			await fake2.close();
		}
	}

	// ---------------------------------------------------------------- §6
	section("§6 failures");
	{
		// A PDF that fails goes again under its own name; nothing is rebuilt once locked.
		const w = world({ env: LIVE });
		w.queue();
		let fails = 1;
		w.putError = (name) => (name.endsWith(".pdf") && fails-- > 0 ? { code: "PUT_FAILED" } : null);
		const job = w.make();
		await job.tick();
		eq([say(w.claim()), w.claim().stage, w.claim().attempts], ["queued RETRY_LATER", "pdf_uploading", 1], "§6 a PDF that fails: back in line, locked, one try counted");
		w.clock.add(16);
		const renders = w.spies.render;
		await job.tick();
		eq([say(w.claim()), w.spies.render - renders, w.spies.puts.filter((p) => p.endsWith(".pdf")).length], ["submitted", 0, 2], "§6 ...the next go sends it again (a second try), never rebuilt, then the CSV");

		// A CSV cut off after its bytes went: never sent again, and submitting stops.
		const m = world({ env: LIVE });
		m.queue();
		m.putError = (name) => (name.endsWith(".csv") ? { code: "PUT_FAILED", nothingSent: false } : null);
		const mj = m.make();
		await mj.tick();
		eq([say(m.claim()), m.claim().stage], ["needs_attention MAYBE_SUBMITTED", "csv_uploading"], "§6 FAILS ON A BUILD THAT SENDS IT AGAIN: a CSV cut off: MAYBE_SUBMITTED");
		ok(ledger.getPause(m.db, T0) && ledger.getPause(m.db, T0).reason === "MAYBE_SUBMITTED", "§6 ...submitting paused until the resume script");
		eq(m.notices.length, 1, "§6 ...one notice");
		eq(ledger.retryClaim(m.db, { key: KEY, nowIso: T0 }).code, "MAYBE_SUBMITTED", "§6 ...and Try again refuses it");
		m.clock.add(300);
		const putsBefore = m.spies.puts.length;
		await mj.tick();
		eq(m.spies.puts.length, putsBefore, "§6 ...a later tick puts nothing");

		// The server refused the CSV's open: nothing made there, so it goes again.
		const r = world({ env: LIVE });
		r.queue();
		let refuse = 1;
		r.putError = (name) => (name.endsWith(".csv") && refuse-- > 0 ? { code: "PUT_FAILED", nothingSent: true } : null);
		const rj = r.make();
		await rj.tick();
		eq([say(r.claim()), r.claim().stage], ["queued RETRY_LATER", "pdf_uploaded"], "§6 a CSV whose open the server refused: back to pdf_uploaded, in line");
		r.clock.add(16);
		await rj.tick();
		eq([say(r.claim()), r.spies.puts.filter((p) => p.endsWith(".pdf")).length], ["submitted", 1], "§6 ...then the CSV alone, and submitted");

		// A refused sign-in pauses, doubling; a host key that doesn't match pauses for good.
		const l = world({ env: LIVE });
		l.queue();
		l.connectError = "LOGIN_REFUSED";
		const lj = l.make();
		await lj.tick();
		eq([say(l.claim()), l.claim().attempts], ["queued LOGIN_REFUSED", 0], "§6 a refused sign-in: back in line, no try counted");
		eq([ledger.getPause(l.db, l.clock.now().toISOString()).ms, l.notices.length], [60 * 60000, 1], "§6 ...submitting paused an hour, one notice");
		l.clock.add(61);
		await lj.tick();
		eq([ledger.getPause(l.db, l.clock.now().toISOString()).ms, l.notices.length], [120 * 60000, 1], "§6 ...refused again: two hours, and no second notice");
		const h = world({ env: LIVE });
		h.queue();
		h.connectError = "HOST_KEY_MISMATCH";
		await h.make().tick();
		eq([say(h.claim()), ledger.getPause(h.db, "2099-01-01T00:00:00.000Z") && ledger.getPause(h.db, "2099-01-01T00:00:00.000Z").reason], ["queued HOST_KEY_MISMATCH", "HOST_KEY_MISMATCH"], "§6 a host key that doesn't match: paused until the resume script");
		// Paused, live builds nothing new: each would wait for the same connection.
		const hj = h.make();
		h.clock.add(61);
		const preparesPaused = h.spies.prepare;
		await hj.tick();
		eq([h.spies.prepare - preparesPaused, h.spies.connect], [0, 1], "§6 FAILS ON A PAUSE THAT BUILDS ANYWAY: an hour on, still paused: nothing built, nothing connected");
		const resume = require(path.join(ROOT, "scripts", "triumph-submit-resume.js"));
		h.db.exec("CREATE TABLE audit_trail (id INTEGER PRIMARY KEY, timestamp TEXT, user_id INTEGER, username TEXT, role TEXT, action TEXT, entity TEXT, entity_id TEXT, details TEXT)");
		const dry = resume.run({ db: h.db, dryRun: true, nowIso: T0 });
		eq([dry.pause.reason, dry.cleared, h.db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n], ["HOST_KEY_MISMATCH", false, 0], "§6 the resume script's dry run: names the pause, writes nothing");
		const applied = resume.run({ db: h.db, dryRun: false, reason: "made-up: fingerprint checked", nowIso: T0 });
		eq([applied.cleared, ledger.getPause(h.db, T0), h.db.prepare("SELECT action FROM audit_trail").all().map((x) => x.action)], [true, null, ["triumph_resumed"]], "§6 ...--apply clears it with one audit row");
		eq(resume.run({ db: h.db, dryRun: false, reason: "made-up: again", nowIso: T0 }).cleared, false, "§6 ...and a replay changes nothing");

		// The retries: 15 min, 1 h, 4 h, then a person.
		const f = world({ env: LIVE });
		f.queue();
		f.connectError = "CONNECT_FAILED";
		const fj = f.make();
		const seen = [];
		for (const wait of [0, 16, 61, 241]) {
			f.clock.add(wait);
			await fj.tick();
			seen.push(say(f.claim()));
		}
		eq(seen, ["queued RETRY_LATER", "queued RETRY_LATER", "queued RETRY_LATER", "needs_attention SUBMIT_FAILED"], "§6 a connection that keeps failing: 15 min, 1 h, 4 h, then SUBMIT_FAILED");
		ok(Boolean(f.claim().invoice_id) && !f.claim().number_voided_at, "§6 ...its number kept for Try again, never used twice");

		const u = world({ env: LIVE });
		u.queue();
		const unconfigured = { configured: false, missing: ["TRIUMPH_HOST"], invalid: [], openLive: async () => { u.spies.connect++; throw new Error("x"); } };
		const out = await u.make({ transport: unconfigured }).tick();
		eq([out.work.paused, say(u.claim()), u.spies.prepare, u.spies.connect], ["TRANSPORT_UNCONFIGURED", "queued", 0, 0], "§6 live with no connection settings: nothing built, nothing connected");
	}

	// ---------------------------------------------------------------- §7
	section("§7 recovery after a restart");
	{
		const stuck = (stage, extra = {}) => {
			const w = world({ env: LIVE });
			w.queue("working", { lease_owner: "dead-worker#1", lease_until: "2026-11-12T14:00:00.000Z", stage, invoice_id: stage ? "11122026-1" : "", ...extra });
			return w;
		};
		for (const stage of ["", "reserved", "rendered", "built"]) {
			const w = stuck(stage);
			const job = w.make();
			await job.recover();
			eq([say(w.claim()), w.claim().invoice_id], ["queued RETRY_LATER", stage ? "11122026-1" : ""], `§7 a restart at ${stage || "the start"}: back in line, its number kept`);
		}
		// A locked claim resumes its upload, from the files as built.
		const built = world({ env: LIVE });
		built.queue();
		built.putError = (name) => (name.endsWith(".pdf") ? { code: "PUT_FAILED" } : null);
		await built.make().tick();
		built.db.prepare("UPDATE triumph_submissions SET state = 'working', lease_owner = 'dead-worker#1', lease_until = '2026-11-12T14:00:00.000Z' WHERE load_key = ?").run(KEY);
		built.putError = null;
		const bj = built.make();
		await bj.recover();
		eq([say(built.claim()), built.claim().stage], ["queued RETRY_LATER", "pdf_uploading"], "§7 a restart at pdf_uploading: back in line, still locked");
		built.clock.add(1);
		const renders = built.spies.render;
		await bj.tick();
		eq([say(built.claim()), built.spies.render - renders], ["submitted", 0], "§7 ...and the upload resumes with the files as built");

		const cu = stuck("csv_uploading");
		await cu.make().recover();
		eq(say(cu.claim()), "needs_attention MAYBE_SUBMITTED", "§7 FAILS ON A RECOVERY THAT SENDS AGAIN: a restart at csv_uploading: MAYBE_SUBMITTED, never sent again");
		const done = stuck("csv_uploaded", { files_json: JSON.stringify({ pdf: { name: "a.pdf" }, csv: { name: "b.csv" }, row: { po: LOAD, total: "2150.00" } }) });
		await done.make().recover();
		eq([say(done.claim()), done.drafts()], ["submitted", [{ load_id: LOAD, invoice_id: "11122026-1", via: "triumph" }]], "§7 a restart at csv_uploaded: recorded, with its draft row");
		const sn = stuck("built", { reason_code: ledger.SUBMIT_NOW });
		await sn.make().recover();
		eq(say(sn.claim()), "staged RETRY_LATER", "§7 FAILS ON A RECOVERY THAT REQUEUES IT: a restart during \"Submit now\", before the lock: back to staged, never sent by itself");
	}

	// ---------------------------------------------------------------- §8
	section("§8 \"Submit now\"");
	{
		const staged = async (env = LIVE) => {
			const w = world({ env: DRY });
			w.queue();
			await w.make().tick();
			w.envBase = env;
			return w;
		};
		const dryNow = await staged(DRY);
		eq(await dryNow.make().submitNow({}, LOAD), { ok: false, code: "NOT_LIVE", http: 404 }, "§8 FAILS ON A ROUTE GATED ON ENABLED ALONE: in a dry run, \"Submit now\" answers NOT_LIVE");
		eq(dryNow.spies.connect, 0, "§8 ...and connects nothing");

		for (const [label, change, want] of [
			["the mark cleared", (w) => w.db.prepare("UPDATE load_factoring SET factored = 0 WHERE load_key = ?").run(KEY), "skipped NOT_FACTORED"],
			["another draft row", (w) => w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via) VALUES (?, '11112026-3', 'imap')").run(LOAD), "needs_attention ALREADY_INVOICED"],
			["a button draft in flight", (w) => w.db.prepare("INSERT INTO invoice_draft_inflight (load_key, load_id, invoice_id, path, state, started_at, updated_at) VALUES (?, ?, '11122026-9', 'imap', 'in_flight', ?, ?)").run(KEY, LOAD, T0, T0), "staged INVOICE_DRAFT_IN_FLIGHT"],
			["a file's bytes changed", (w) => { const dir = jobLib.create({ db: w.db, env: {}, batchDir: w.batchDir }).folderOf(KEY); fs.appendFileSync(path.join(dir, "11122026-1.pdf"), " "); }, "needs_attention BATCH_FILES_CHANGED"],
			["the load changed since it was built", (w) => { w.sheet.status = "Delivered"; w.db.prepare("INSERT INTO documents (id, load_id, type, file_name, drive_url, uploaded_at) VALUES (2, ?, 'POD', 'pod2.pdf', '/uploads/pod2.pdf', '2026-11-11 09:00:00')").run(LOAD); }, "needs_attention LOAD_CHANGED"],
		]) {
			const w = await staged();
			change(w);
			const r = await w.make().submitNow({}, LOAD);
			eq([say(w.claim()), w.spies.connect, r.ok], [want, 0, false], `§8 FAILS ON A BUILD THAT SKIPS THE CHECKS ON "SUBMIT NOW": ${label}: ${want}, before any connection`);
		}
		const happy = await staged();
		const prepares = happy.spies.prepare;
		const r = await happy.make().submitNow({ session: { user: { username: "made-up-admin" } } }, LOAD);
		eq([r.ok, say(happy.claim()), happy.spies.prepare - prepares, happy.spies.puts.length], [true, "submitted", 0, 2], "§8 the happy path: staged, then working, through the lock point, sent as built (no rebuild)");
		ok(happy.actions().includes("triumph_submit_now") && happy.actions().includes("invoice_draft_created"), "§8 ...audited, and recorded with its draft row");
		eq(happy.marker().locked_via, "upload", "§8 ...the lock taken at the lock point");

		const bounce = await staged();
		bounce.connectError = "CONNECT_FAILED";
		await bounce.make().submitNow({}, LOAD);
		await bounce.make().tick();
		eq([say(bounce.claim()), bounce.spies.connect], ["staged RETRY_LATER", 1], "§8 FAILS ON A BUILD THAT REQUEUES IT: a connection that fails leaves the batch staged; a tick doesn't send it");
		eq(await (await staged()).make().submitNow({}, "LD-TEST-0002"), { ok: false, code: "NOT_STAGED", http: 409 }, "§8 a load with no staged batch: refused");
	}

	// ---------------------------------------------------------------- §9
	section("§9 caps and the Friday-evening window");
	{
		const w = world({ env: DRY });
		ledger.ensureSchema(w.db);
		for (let i = 1; i <= 4; i++) {
			const id = `LD-TEST-000${i}`;
			w.sheet.rows.push({ "Load ID": id, Status: "Delivered", Email: "ap@example-broker.test", "Completion Date": "2026-11-10", "  Payment  ": "2150" });
			if (i > 1) {
				w.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES (?, ?, 1, 'script', ?, ?)").run(id.toLowerCase(), id, T0, T0);
				w.db.prepare("INSERT INTO documents (id, load_id, type, file_name, drive_url, uploaded_at) VALUES (?, ?, 'POD', 'p.pdf', '/uploads/p.pdf', '2026-11-10 14:00:00')").run(10 + i, id);
			}
			ledger.insertClaim(w.db, { key: id.toLowerCase(), loadId: id, state: "queued", nowIso: T0 });
		}
		const job = w.make();
		const out = await job.tick();
		eq(out.work.started, 2, "§9 two a run");
		w.db.prepare("UPDATE triumph_submissions SET reserved_at = ? WHERE reserved_at = ''").run(T0);
		const capped = world({ env: { ...DRY, TRIUMPH_MAX_PER_HOUR: "4" } });
		capped.queue();
		ledger.ensureSchema(capped.db);
		for (let i = 0; i < 4; i++) capped.db.prepare("INSERT INTO triumph_submissions (load_key, load_id, state, first_seen_at, reserved_at, updated_at) VALUES (?, 'x', 'staged', ?, ?, ?)").run(`ld-made-up-${i}`, T0, "2026-11-12T14:30:00.000Z", T0);
		const co = await capped.make().tick();
		eq([co.work.started, say(capped.claim())], [0, "queued"], "§9 TRIUMPH_MAX_PER_HOUR reached: nothing new starts");

		const fri = world({ env: DRY, at: "2026-11-13T23:30:00.000Z" });
		fri.queue();
		await fri.make().tick();
		eq([say(fri.claim()), fri.spies.prepare, fri.spies.mint], ["queued QUIET_WINDOW", 0, 0], "§9 a Friday evening: no render, no number, back in line in an hour");
	}

	// ---------------------------------------------------------------- §10
	section("§10 voided numbers, a change after submission, the daily notices");
	{
		// A staged batch whose mark is cleared gives its number up, once, and a restart takes a new one.
		const w = world({ env: DRY });
		w.queue();
		const job = w.make();
		await job.tick();
		const r = factoring.clear(w.db, { key: KEY, reason: "made-up", nowIso: T0, audit: (a, dt) => w.audits.push({ action: a, details: dt }) });
		eq([r.ok, r.voided], [true, "11122026-1"], "§10 clearing a staged load's mark gives its number up");
		await job.tick();
		eq(say(w.claim()), "skipped NOT_FACTORED", "§10 ...the staged claim gives up at the next tick");
		eq(w.audits.filter((a) => a.action === "triumph_number_void").length, 1, "§10 ...with one triumph_number_void row");
		ok(!fs.existsSync(job.folderOf(KEY)), "§10 ...and its built files go");
		factoring.mark(w.db, { key: KEY, loadId: LOAD, reason: "made-up again", source: "script", nowIso: T0 });
		eq(job.start({}, LOAD).ok, true, "§10 marked again and started: in line");
		await job.tick();
		eq([say(w.claim()), w.claim().invoice_id], ["staged", "11122026-2"], "§10 FAILS ON A BUILD THAT REUSES A VOIDED NUMBER: a fresh number");

		// A claim that gives up at its own free checks gives up its number too.
		const g = world({ env: DRY });
		g.queue("queued", { stage: "reserved", invoice_id: "11122026-7", invoice_date: "2026-11-12", reserved_at: T0 });
		g.db.prepare("UPDATE load_factoring SET factored = 0 WHERE load_key = ?").run(KEY);
		await g.make().tick();
		eq([say(g.claim()), Boolean(g.claim().number_voided_at), g.audits.filter((a) => a.action === "triumph_number_void").length], ["skipped NOT_FACTORED", true, 1],
			"§10 FAILS ON A GIVE-UP THAT KEEPS ITS NUMBER: a claim holding a number whose mark went: skipped, the number voided once");

		// A load changed after its submission: one notice, nothing sent again.
		const s = world({ env: LIVE });
		s.queue();
		const sj = s.make();
		await sj.tick();
		eq(say(s.claim()), "submitted", "§10 (fixture) submitted");
		s.sheet.status = "Completed";
		s.db.prepare("INSERT INTO documents (id, load_id, type, file_name, drive_url, uploaded_at) VALUES (2, ?, 'POD', 'pod2.pdf', '/uploads/pod2.pdf', '2026-11-11 09:00:00')").run(LOAD);
		const notices = s.notices.length;
		await sj.tick();
		await sj.tick();
		eq([s.notices.length - notices, Boolean(s.claim().changed_at), s.claim().changed_fields], [1, true, "pods"], "§10 a load changed after its submission: one notice, its fields named");
		ok(s.actions().includes("triumph_load_changed") && s.spies.puts.length === 2, "§10 ...audited, and nothing sent again");

		// Once a day: factored, completed, unlocked, over 48 hours.
		const late = world({ env: DRY, completion: "2026-11-09" });
		const lj = late.make();
		await lj.tick();
		eq(late.notices.map((n) => n.title), ["Factored loads not sent to Triumph"], "§10 a factored load delivered over 48 hours ago with nothing started: one notice");
		await lj.tick();
		eq(late.notices.length, 1, "§10 ...once a day");
		const fresh = world({ env: DRY, completion: "2026-11-12" });
		await fresh.make().tick();
		eq(fresh.notices, [], "§10 one delivered today: no notice");
		const locked = world({ env: DRY, completion: "2026-11-01" });
		locked.db.prepare("UPDATE load_factoring SET locked_at = ?, locked_via = 'outside' WHERE load_key = ?").run(T0, KEY);
		await locked.make().tick();
		eq(locked.notices, [], "§10 one handled in Triumph's process: no notice");

		// Live with no submission for 14 days.
		const quiet = world({ env: LIVE, factored: false });
		const qj = quiet.make();
		await qj.tick();
		eq(quiet.notices, [], "§10 live, nothing sent yet, day one: no keep-alive notice");
		quiet.clock.add(15 * 24 * 60);
		await qj.tick();
		eq(quiet.notices.map((n) => n.title), ["Triumph: no submission in 14 days"], "§10 ...14 days live with no submission: one notice");
	}

	// ---------------------------------------------------------------- §11
	section("§11 rule 7 on what goes");
	{
		const page = world({ env: DRY, extraInvoiceText: [`Ref ${DENY}`] });
		page.queue();
		await page.make().tick();
		eq(say(page.claim()), "needs_attention PROTECTED_VALUE", "§11 FAILS WITHOUT THE PAGE'S CHECK: the invoice page holding a protected value: stopped before anything is staged");
		const far = world({ env: DRY, extraInvoiceText: [`${"made-up filler ".repeat(300)}Ref ${DENY}`] });
		far.queue();
		await far.make().tick();
		eq(say(far.claim()), "needs_attention PROTECTED_VALUE", "§11 FAILS ON A CHECK THAT READS ONLY THE FIRST 4,000 CHARACTERS: a protected value far down the page: stopped");
		const name = world({ env: DRY, debtor: `Example Broker ${DENY}` });
		name.queue();
		await name.make().tick();
		eq(say(name.claim()), "needs_attention PROTECTED_VALUE", "§11 a composed CSV value holding one: stopped");

		// The list grows after a batch was staged: "Submit now" checks it as it is now.
		const grown = world({ env: DRY });
		grown.queue();
		await grown.make().tick();
		grown.envBase = LIVE;
		grown.denyHits = createRedactor({ denyList: `${DENY},11122026` }).hits;
		await grown.make().submitNow({}, LOAD);
		eq([say(grown.claim()), grown.spies.connect], ["needs_attention PROTECTED_VALUE", 0], "§11 FAILS WITHOUT THE CHECK AT SENDING: a value the list holds now: stopped before connecting");

		const parity = world({ env: DRY, po: "LD-TEST-0099" });
		parity.queue();
		parity.engine.render = async (ctx, { invoiceId, invoiceDate }) => ({ invoicePdf: await invoicePdfFor(invoiceId, invoiceDate, { po: LOAD }), total: "$2,150.00" });
		parity.db.prepare("UPDATE documents SET load_id = ? WHERE id = 1").run(LOAD);
		await parity.make().tick();
		eq(say(parity.claim()), "needs_attention FIELD_NOT_PRINTED", "§11 a CSV value the merged PDF doesn't print (the PO): stopped");
	}

	// ---------------------------------------------------------------- §12
	section("§12 the sample's --dry-run and --upload");
	{
		const script = require(path.join(ROOT, "scripts", "triumph-batch-sample.js"));
		const render = async () => pdfOf(["INVOICE (MADE UP) SAMPLE-0001", "SAMPLE - NOT A REAL INVOICE - DO NOT PAY", ...NOA]);
		const env0 = { TRIUMPH_NOA_LINES: NOA.join("\n") };
		let created = 0;
		const counting = (o) => { created++; return transfer.create(o); };
		const refusedWith = async (argv, opts) => {
			try {
				await script.run(argv, { render, now: () => new Date(T0), createTransport: counting, ...opts });
				return "no refusal";
			} catch (e) {
				return e instanceof script.Refusal ? e.message : `threw ${e.message}`;
			}
		};
		ok(/so --load is refused/.test(await refusedWith(["--upload", "--load=LD-TEST-0001", "--audit-db=/made-up/x"], { env: env0 })), "§12 --upload --load: refused");
		eq(created, 0, "§12 ...before any transport was made");
		ok(/SAMPLE_AFTER_LIVE/.test(await refusedWith(["--dry-run"], { env: { ...env0, TRIUMPH_LIVE_CONFIRMED_ON: "2026-11-20" } })), "§12 the go-live date set: refused");
		ok(/SAMPLE_AFTER_LIVE/.test(await refusedWith(["--dry-run"], { env: { ...env0, ...LIVE } })), "§12 the mode live: refused");
		ok(/SAMPLE_REPLICA/.test(await refusedWith(["--dry-run"], { env: env0, replica: true })), "§12 a replica: refused");
		ok(/QUIET_WINDOW/.test(await refusedWith(["--dry-run"], { env: env0, now: () => new Date("2026-11-13T23:30:00.000Z") })), "§12 a Friday evening: refused, no render");
		ok(/NOA_UNCONFIGURED/.test(await refusedWith(["--dry-run"], { env: {} })), "§12 (L5) no assignment lines: refused, the block being the sample's point");
		// (L5) The sample's page prints the factor's block in place of the bank block's.
		let html = "";
		const capture = async (h) => { html = h; return render(); };
		await script.run(["--dry-run"], { render: capture, env: { ...env0, TRIUMPH_HOST: "made-up.example.test", TRIUMPH_USER: "made-up-user", TRIUMPH_KEY_FILE: "/made-up/not-a-real-key-file",
			TRIUMPH_HOST_FINGERPRINT: `SHA256:${"A".repeat(43)}`, TRIUMPH_HOST_KEY_TYPE: "ED25519", TRIUMPH_SUBMIT_DIR: "/made-up/submit" }, now: () => new Date(T0), createTransport: counting });
		ok(html && !/Payment Method/.test(html) && !/Bank (Routing|Account) #/.test(html) && NOA.every((l) => html.includes(l)) && html.includes(triumphBatch.SAMPLE.stamp),
			"§12 (L5) the sample's page: no \"Payment Method\", no bank slot, every assignment line and the stamp beside them");

		const fake = await startFakeTriumph({ hostKey: HOST.private, clientKey: CLIENT.private, folders: [SUBMIT] });
		try {
			const env = { ...env0, TRIUMPH_HOST: fake.host, TRIUMPH_PORT: String(fake.port), TRIUMPH_USER: "made-up-user", TRIUMPH_KEY_FILE: "/made-up/not-a-real-key-file",
				TRIUMPH_HOST_FINGERPRINT: fingerprintOfKey(HOST.private), TRIUMPH_HOST_KEY_TYPE: "ED25519", TRIUMPH_SUBMIT_DIR: SUBMIT };
			const create = (o) => transfer.create({ ...o, readKeyFile: () => CLIENT.private });
			const dry = await script.run(["--dry-run"], { render, env, now: () => new Date(T0), createTransport: create });
			eq([dry.sent, dry.pdfName, fake.ops.length], [false, "SAMPLE-0001.pdf", 0], "§12 --dry-run: built and checked, nothing connected");

			const w = world({ env: DRY });
			w.queue("staged", { invoice_id: "11122026-1" });
			w.db.exec("CREATE TABLE audit_trail (id INTEGER PRIMARY KEY, timestamp TEXT, user_id INTEGER, username TEXT, role TEXT, action TEXT, entity TEXT, entity_id TEXT, details TEXT)");
			w.db.prepare("INSERT INTO bison_invoice_seq (day, n) VALUES ('2026-11-12', 4)").run();
			const tables = ["triumph_submissions", "load_factoring", "load_invoice_drafts", "invoice_draft_inflight", "bison_invoice_seq"];
			const dump = () => tables.map((t) => JSON.stringify(w.db.prepare(`SELECT * FROM ${t}`).all()));
			const before = dump();
			const writeAudit = (action, details) => w.db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, 'triumph-sample', 'system', ?, 'triumph', '', ?)").run(T0, action, details);
			const up = await script.run(["--upload", "--audit-db=/made-up/not-used"], { render, env, now: () => new Date(T0), createTransport: create, writeAudit });
			eq(up.sent, true, "§12 --upload: sent");
			eq(fake.ops.filter((o) => o.op === "OPEN").map((o) => path.posix.basename(o.path)), ["SAMPLE-0001.pdf", up.csvName], "§12 ...the PDF first, then the CSV");
			eq(dump(), before, "§12 FAILS ON A SAMPLE THAT TOUCHES A LOAD: the claims, the marker, the draft rows, the in-flight rows and the number sequence: unchanged");
			eq(w.spies.mint, 0, "§12 ...and no number was taken");
			eq(w.db.prepare("SELECT action, entity_id FROM audit_trail").all(), [{ action: "triumph_sample_uploaded", entity_id: "" }], "§12 one audit row, naming no load");
		} finally {
			await fake.close();
		}
		// (L6) The PDF went and the CSV's answer didn't come: stop, and a fresh yes before another run.
		const cut = await startFakeTriumph({ hostKey: HOST.private, clientKey: CLIENT.private, folders: [SUBMIT], faults: { dropOnWrite: (p) => p.endsWith(".csv") } });
		try {
			const env = { ...env0, TRIUMPH_HOST: cut.host, TRIUMPH_PORT: String(cut.port), TRIUMPH_USER: "made-up-user", TRIUMPH_KEY_FILE: "/made-up/not-a-real-key-file",
				TRIUMPH_HOST_FINGERPRINT: fingerprintOfKey(HOST.private), TRIUMPH_HOST_KEY_TYPE: "ED25519", TRIUMPH_SUBMIT_DIR: SUBMIT };
			const audits = [];
			let stopped = null;
			try {
				await script.run(["--upload", "--audit-db=/made-up/not-used"], { render, env, now: () => new Date(T0), writeAudit: (a, details) => audits.push({ a, details }),
					createTransport: (o) => transfer.create({ ...o, readKeyFile: () => CLIENT.private, opTimeoutMs: 3000 }) });
			} catch (e) {
				stopped = e;
			}
			eq([stopped && stopped.exitCode, /fresh yes/.test(stopped && stopped.message)], [3, true], "§12 (L6) a CSV with no answer after the PDF went: exit 3, and the words ask for a fresh yes");
			ok(audits.length === 1 && /had no answer/.test(audits[0].details) && /fresh yes/.test(audits[0].details), "§12 (L6) ...and the audit row says so");
		} finally {
			await cut.close();
		}
	}

	section("§13 every code a claim was left with is on the list the page words");
	{
		const triumphRules = require(path.join(ROOT, "lib", "triumph-rules.js"));
		const seen = new Set();
		for (const w of WORLDS) {
			if (!ledger.hasTable(w.db, "triumph_submissions")) continue;
			for (const r of w.db.prepare("SELECT DISTINCT reason_code FROM triumph_submissions WHERE reason_code <> ''").all()) seen.add(r.reason_code);
		}
		ok(seen.size >= 20, `§13 (fixture) the runs left many codes (${seen.size})`);
		eq([...seen].filter((code) => !triumphRules.REASON_CODES.includes(code)).sort(), [], "§13 none missing from lib/triumph-rules.js REASON_CODES");
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	for (const f of failures) console.log(`FAIL  ${f}`);
	process.exit(failures.length ? 1 : 0);
})().catch((e) => {
	console.log(`FAIL  the runner itself: ${e && e.stack}`);
	process.exit(1);
});
