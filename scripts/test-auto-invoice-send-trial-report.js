#!/usr/bin/env node
// scripts/auto-invoice-send-trial-report.js: the comparison before automatic
// invoice emails go out without review, on made-up messages.
//
//   §1 --shadow: six renders matched by six Sent copies pass; each of the six
//      conditions failing on its own (recipient, Cc, Bcc, subject, a dropped,
//      reordered or swapped attachment, another amount, the body, a re-draft, a
//      number typed over, the date edited, the load changed, a later message);
//      unmatched (none, several, another invoice number); pending; fewer than 6;
//      refused renders and other domains counted, not judged; matched by load
//      number when the app has no draft row; the window
//   §2 --trial: six drafts found by Message-ID, or by subject, To and invoice
//      number, pass; step 0 (the first draft differs, or isn't in Sent Mail:
//      nothing else judged); the window grows to 6 sent, up to 14 days; "nothing
//      after" (changed fields, a "checked (changed: ...)" audit row, a voided
//      number, a later person draft); other domains and digest-less claims
//   §3 counts only: no address, subject, body, amount or load ID in the output
//   §4 --record: only on the re-run reviewed (--expect), --dry-run writes
//      nothing, a pass writes 'send_pass:<domain>' (source shadow or trial), a
//      fail 'draft_week:<domain>', each with one system audit row; never over a
//      row already there; never while pending; the same data, the same SHA
//   §5 the arguments it refuses
//   §6 its IMAP: no socket or IMAP command of its own; Sent Mail through
//      lib/imap-draft.js fetchMessages(), whose commands are EXAMINE, SEARCH and
//      FETCH with BODY.PEEK[] only, end to end against a fake IMAP server
//   §7 lib/mime-read.js reads what nodemailer composes: To, Cc, Bcc, an encoded
//      subject, quoted-printable HTML, base64 attachments, a long encoded name
//   §8 mutants of the report, each caught: every found load counted a
//      difference (match), condition 2-5 dropped (difference), several Sent
//      copies accepted (unmatched), the minimum lowered (fewer than 6)
//
// Made-up data only, an in-memory database, no network beyond a loopback
// listener.
//   node scripts/test-auto-invoice-send-trial-report.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const tls = require("tls");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const REPORT_FILE = path.join(ROOT, "scripts", "auto-invoice-send-trial-report.js");
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
function finish() {
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
	process.exit(0);
}

if (!fs.existsSync(REPORT_FILE) || !fs.existsSync(path.join(ROOT, "lib", "mime-read.js"))) {
	failures.push("FAILS ON THE OLD CODE: scripts/auto-invoice-send-trial-report.js and lib/mime-read.js exist");
	finish();
}

const report = require(REPORT_FILE);
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const ledger = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const appTime = require(path.join(ROOT, "lib", "app-time.js"));
const mimeRead = require(path.join(ROOT, "lib", "mime-read.js"));
const imapDraft = require(path.join(ROOT, "lib", "imap-draft.js"));
const { textPdf } = require("./lib/made-up-pdf");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
// The specifier lib/imap-draft.js uses (nodemailer maps it through its exports).
const MailComposer = Module.createRequire(path.join(ROOT, "server.js"))("nodemailer/lib/mail-composer");

setTimeout(() => {
	console.log("\n✗ the run did not finish within 60 s");
	process.exit(1);
}, 60_000).unref();

// ------------------------------------------------------------------ made-up data
const ZONE = "America/New_York";
const DOMAIN = "example-broker.test";
const BILLING = "billing@example-broker.test";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ON_AT = "2026-11-02T14:00:00.000Z"; // the render shadow switched on, a Monday 9 AM Eastern
const T = (days, hours = 0) => new Date(Date.parse(ON_AT) + days * DAY + hours * HOUR);
const NOW = T(21).getTime(); // every message has had its 7 days, and 7 more
const FP = "f".repeat(64);

const mdy = (day) => {
	const [y, m, d] = day.split("-");
	return `${m}/${d}/${y}`;
};
const dayOf = (date) => appTime.dayInZone(date, ZONE);
const numberOn = (date, n) => {
	const [y, m, d] = dayOf(date).split("-");
	return `${m}${d}${y}-${n}`;
};
const HTML = (ref) => `<div style="font-family:Arial"><p>Hello,</p><p>Please see the attached documents for load number ${ref}: the rate confirmation, the signed POD, and the invoice.</p><p>Thank you,</p></div>`;
// One invoice email as the engine builds it: the invoice PDF (number, date and
// total printed, read the way Chromium writes text), then the POD and the rate con.
function message(ref, { number, day, total = "$1,500.00", to = BILLING, cc, bcc } = {}) {
	const printed = `INVOICE Invoice ID # : ${number} Date: ${mdy(day)} Made-up Co. Invoice To Example Broker ${BILLING} Load ID# Delivery Date Total Example Broker Order: #${ref} 11/01/2026 ${total} SUB-TOTAL ${total} Total ${total}`;
	return {
		to, cc, bcc,
		subject: `Example Broker Order #${ref}`,
		html: HTML(ref),
		attachments: [
			{ filename: `Example Broker Invoice Order #${ref}.pdf`, content: textPdf(printed), contentType: "application/pdf" },
			{ filename: `${ref}_POD.pdf`, content: Buffer.from(`%PDF-1.4 made-up POD for ${ref}`), contentType: "application/pdf" },
			{ filename: `${ref}.pdf`, content: Buffer.from(`%PDF-1.4 made-up rate con for ${ref}`), contentType: "application/pdf" },
		],
	};
}
// What Sent Mail keeps of a message: nodemailer's MIME, with its Date, and its Bcc
// when it had one.
function compose(msg, { date, messageId } = {}) {
	return new Promise((resolve, reject) => {
		const built = new MailComposer({ from: "Made-up Co. <drafts@example.com>", ...msg, date, ...(messageId ? { messageId } : {}) }).compile();
		built.keepBcc = true;
		built.build((err, out) => (err ? reject(err) : resolve(out)));
	});
}
const swap = (xs, i, j) => { const ys = [...xs]; [ys[i], ys[j]] = [ys[j], ys[i]]; return ys; };

// The tables as server.js makes them.
const createSql = (name) => {
	const at = SRC.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
	if (at < 0) throw new Error(`server.js creates no ${name} table`);
	return SRC.slice(at, SRC.indexOf("`", at));
};
const ALTERS = [...SRC.matchAll(/db\.exec\("(ALTER TABLE load_invoice_drafts ADD COLUMN [^"]+)"\)/g)].map((m) => m[1]);
function newDb() {
	const db = new Database(":memory:");
	db.exec(createSql("load_invoice_drafts"));
	for (const a of ALTERS) db.exec(a);
	db.exec(createSql("audit_trail"));
	ledger.ensureSchema(db);
	return db;
}
const personRow = (db, { id, number, at, recipient = BILLING, editedFields = "", minted = "" }) =>
	db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_at, created_by, edited, edited_fields, invoice_id_minted) VALUES (?, ?, ?, 'ratecon', 'imap', ?, 'made-up-admin', ?, ?, ?)")
		.run(id, number, recipient, at.toISOString(), editedFields ? 1 : 0, editedFields, minted);
const fetcher = (sent) => async ({ subject, since, before }) =>
	sent.filter((m) => m.subject.includes(subject) && m.at >= since.getTime() && m.at < before.getTime()).map((m) => ({ raw: m.raw, internalDate: "" }));

// ------------------------------------------------------------------ --shadow worlds
// One load of the shadow week: the render (placeholder number, render day), the
// person's draft row hours later, and the Sent copy an hour after that, each
// part changeable.
async function shadowLoad(db, sent, n, o = {}) {
	const id = o.id || `LD-TEST-04${String(n).padStart(2, "0")}`;
	const renderAt = o.renderAt || T(o.day ?? 1, 2);
	const renderMsg = message(id, { number: rules.SHADOW_INVOICE_ID, day: dayOf(renderAt), ...(o.render || {}) });
	const draftAt = new Date(renderAt.getTime() + (o.draftAfterHours ?? 3) * HOUR);
	let record = o.refused
		? { v: 1, refusedAt: renderAt.toISOString(), code: "TOTAL_MISMATCH", fingerprintSha256: FP }
		: { ...rules.messageDigest(renderMsg, { renderedAt: renderAt.toISOString() }), fingerprintSha256: FP };
	if (!o.refused && !o.noDraftRow) record = { ...record, draftSeenAt: draftAt.toISOString(), fingerprintAtDraftSha256: o.fpChanged ? "e".repeat(64) : FP };
	ledger.upsertShadow(db, { key: rules.loadKey(id), loadId: id, verdict: "WOULD_ATTEMPT", readyAt: renderAt.toISOString(), nowIso: renderAt.toISOString() });
	ledger.setRenderDigest(db, rules.loadKey(id), JSON.stringify(record), renderAt.toISOString());
	const number = o.number || numberOn(draftAt, n);
	if (!o.noDraftRow) {
		personRow(db, { id, number, at: draftAt, recipient: o.rowRecipient || BILLING, editedFields: o.editedFields || "", minted: o.minted || "" });
		if (o.drafts === 2) personRow(db, { id, number: numberOn(draftAt, n + 50), at: new Date(draftAt.getTime() + HOUR) });
	}
	const sentAt = o.sentAt || new Date(draftAt.getTime() + HOUR);
	const base = message(id, { number: o.printedNumber || number, day: dayOf(draftAt), ...(o.sentMsg || {}) });
	const copy = o.mutateSent ? o.mutateSent(base) : base;
	for (let i = 0; i < (o.copies ?? 1); i++) {
		const at = new Date(sentAt.getTime() + i * HOUR);
		sent.push({ subject: copy.subject, at: at.getTime(), raw: await compose(copy, { date: at }) });
	}
	if (o.laterAt) sent.push({ subject: `Re: ${base.subject}`, at: o.laterAt.getTime(), raw: await compose({ ...base, subject: `Re: ${base.subject}` }, { date: o.laterAt }) });
	return { id, record };
}

async function runShadow(specs, { since, now = NOW, mod = report } = {}) {
	const db = newDb();
	ledger.setMeta(db, "shadow_renders_on_at", ON_AT);
	const sent = [];
	for (const [i, spec] of specs.entries()) await shadowLoad(db, sent, i + 1, spec);
	const result = await mod.report({ db, mode: "shadow", since, domains: [DOMAIN], fetchSent: fetcher(sent), zone: ZONE, nowMs: now });
	return { db, sent, result, counts: result.counts };
}
const matching = (n) => Array.from({ length: n }, () => ({}));
const withFirst = (o, n = 6) => [o, ...matching(n - 1)];
const brief = (c) => ({ population: c.population, matched: c.matched, differences: c.differences.total, unmatched: c.unmatched.total, pending: c.pending, pass: c.pass });

// ------------------------------------------------------------------ --trial worlds
async function trialLoad(db, sent, n, o = {}) {
	const id = o.id || `LD-TEST-05${String(n).padStart(2, "0")}`;
	const key = rules.loadKey(id);
	const draftedAt = o.draftedAt || T(o.day ?? 1, 2);
	const number = numberOn(draftedAt, n);
	const msg = message(id, { number, day: dayOf(draftedAt), ...(o.draftMsg || {}) });
	const messageId = `<made-up-${n}.auto-invoice@example.com>`;
	ledger.insertClaim(db, { key, loadId: id, state: "drafted", nowIso: draftedAt.toISOString() });
	ledger.transition(db, key, { from: ["drafted"], nowIso: draftedAt.toISOString(), patch: {
		invoice_id: number, invoice_date: dayOf(draftedAt), message_id: messageId, drafted_at: draftedAt.toISOString(), stage: "recorded",
		draft_digest_json: o.noDigest ? "" : JSON.stringify(rules.messageDigest(msg, { renderedAt: draftedAt.toISOString() })),
		changed_fields: o.changedFields || "", number_voided_at: o.voided ? draftedAt.toISOString() : "",
	} });
	db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_at, created_by) VALUES (?, ?, ?, 'ratecon', 'auto-imap', ?, 'auto-invoice')")
		.run(id, number, msg.to, draftedAt.toISOString());
	if (o.laterRow) personRow(db, { id, number: numberOn(draftedAt, n + 50), at: new Date(draftedAt.getTime() + 5 * HOUR) });
	if (o.checkedChanged) {
		db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 7, 'made-up-admin', 'Super Admin', 'auto_invoice_checked', 'load', ?, ?)")
			.run(draftedAt.toISOString(), id, `${number}: checked (changed: payment)`);
	}
	if (o.notSent) return;
	const at = new Date(draftedAt.getTime() + 2 * HOUR);
	const copy = o.mutateSent ? o.mutateSent(msg) : msg;
	sent.push({ subject: copy.subject, at: at.getTime(), raw: await compose(copy, { date: at, messageId: o.gmailNewId ? `<made-up-gmail-${n}@example.com>` : messageId }) });
}

async function runTrial(specs, { since, now = NOW } = {}) {
	const db = newDb();
	const sent = [];
	for (const [i, spec] of specs.entries()) await trialLoad(db, sent, i + 1, spec);
	const result = await report.report({ db, mode: "trial", since, domains: [DOMAIN], fetchSent: fetcher(sent), zone: ZONE, nowMs: now });
	return { db, result, counts: result.counts };
}

(async () => {
	// ===================================================================== §1
	section("§1  --shadow: the render shadow's digests against what people sent");
	{
		const { counts } = await runShadow(matching(6));
		eq(brief(counts), { population: 6, matched: 6, differences: 0, unmatched: 0, pending: 0, pass: true }, "§1 six renders, six Sent copies the same (number and date masked): PASS");
		eq(counts.window, { since: "2026-11-02", until: "2026-11-08", zone: ZONE }, "§1 the window: 7 days from the day the render shadow went on");
		eq([counts.reason, counts.minimum], ["", 6], "§1 no reason to fail; the minimum is 6");
	}
	for (const [label, spec, condition] of [
		["the Sent copy went to another address (the person's row says so too)", { rowRecipient: "ap@example-broker.test", sentMsg: { to: "ap@example-broker.test" } }, "recipient"],
		["the Sent copy has a Cc", { sentMsg: { cc: "copy@example-broker.test" } }, "recipient"],
		["the Sent copy has a Bcc", { sentMsg: { bcc: "hidden@example-broker.test" } }, "recipient"],
		["the subject was changed", { mutateSent: (m) => ({ ...m, subject: `${m.subject} (corrected)` }) }, "subject"],
		["the POD was dropped", { mutateSent: (m) => ({ ...m, attachments: m.attachments.filter((a) => !/_POD\.pdf$/.test(a.filename)) }) }, "attachments"],
		["the attachments were reordered", { mutateSent: (m) => ({ ...m, attachments: swap(m.attachments, 1, 2) }) }, "attachments"],
		["another rate con was attached", { mutateSent: (m) => ({ ...m, attachments: m.attachments.map((a, i) => (i === 2 ? { ...a, content: Buffer.from("%PDF-1.4 made-up other rate con") } : a)) }) }, "attachments"],
		["the invoice billed another amount", { sentMsg: { total: "$1,550.00" } }, "attachments"],
		["the body was edited", { mutateSent: (m) => ({ ...m, html: m.html.replace("Thank you,", "Thanks,") }) }, "body"],
		["the load was drafted twice", { drafts: 2 }, "nothingAfter"],
		["the invoice number was typed over (the minted one voided)", { minted: "11032026-9" }, "nothingAfter"],
		["the invoice date was edited", { editedFields: "invoiceDate" }, "nothingAfter"],
		["the load changed between the render and the draft", { fpChanged: true }, "nothingAfter"],
		["a later message went to the same To with the order number", { sentAt: T(7, 1), laterAt: T(10, 1) }, "nothingAfter"],
	]) {
		const { counts } = await runShadow(withFirst(spec));
		eq([brief(counts), counts.differences[condition], counts.reason], [{ population: 6, matched: 5, differences: 1, unmatched: 0, pending: 0, pass: false }, 1, "differences"],
			`§1 a difference (${condition}): ${label}; FAIL`);
	}
	{
		const none = await runShadow(withFirst({ copies: 0 }));
		eq([brief(none.counts), none.counts.unmatched, none.counts.reason], [{ population: 6, matched: 5, differences: 0, unmatched: 1, pending: 0, pass: false }, { total: 1, none: 1, several: 0 }, "unmatched"],
			"§1 unmatched: no Sent copy within 7 days of the render; FAIL");
		const several = await runShadow(withFirst({ copies: 2 }));
		eq([several.counts.unmatched, several.counts.pass], [{ total: 1, none: 0, several: 1 }, false], "§1 unmatched: two Sent copies for the load; FAIL");
		const other = await runShadow(withFirst({ printedNumber: "10302026-4" }));
		eq([other.counts.unmatched, other.counts.pass], [{ total: 1, none: 1, several: 0 }, false], "§1 matched by invoice number: a Sent copy printing another invoice than the person's draft row is not its copy");
		const noRow = await runShadow(withFirst({ noDraftRow: true }));
		eq(brief(noRow.counts), { population: 6, matched: 6, differences: 0, unmatched: 0, pending: 0, pass: true }, "§1 no draft row in the app: matched by the load number in the subject and the To alone");
		const pending = await runShadow([{ renderAt: T(6, 2), copies: 0 }, ...matching(6)], { now: T(8).getTime() });
		eq([brief(pending.counts), pending.counts.reason.startsWith("pending")], [{ population: 7, matched: 6, differences: 0, unmatched: 0, pending: 1, pass: false }, true],
			"§1 pending: a render with less than 7 days behind it and no Sent copy yet; not a pass, not a fail to record");
		const five = await runShadow(matching(5));
		eq([brief(five.counts), five.counts.reason], [{ population: 5, matched: 5, differences: 0, unmatched: 0, pending: 0, pass: false }, "fewer than 6 matched"], "§1 fewer than 6: five matched, nothing else wrong; FAIL");
		const outside = await runShadow([{ refused: true }, { render: { to: "billing@example-other.test" } }, { renderAt: T(-1, 2) }, { renderAt: T(7, 2) }, ...matching(6)]);
		eq([brief(outside.counts), outside.counts.outside], [{ population: 6, matched: 6, differences: 0, unmatched: 0, pending: 0, pass: true }, { refused: 1, otherDomains: 1 }],
			"§1 a refused render and another domain are counted, not judged; renders outside the window are not counted");
		const since = await runShadow(matching(6), { since: "2026-11-04" });
		eq([since.counts.window.since, since.counts.population], ["2026-11-04", 0], "§1 --since moves the window");
	}

	// ===================================================================== §2
	section("§2  --trial: the draft week");
	{
		const six = await runTrial(matching(6));
		eq([brief(six.counts), six.counts.step0], [{ population: 6, matched: 6, differences: 0, unmatched: 0, pending: 0, pass: true }, "unchanged"], "§2 six drafts sent unchanged, found by their Message-ID: PASS");
		const reId = await runTrial(Array.from({ length: 6 }, () => ({ gmailNewId: true })));
		eq(brief(reId.counts), { population: 6, matched: 6, differences: 0, unmatched: 0, pending: 0, pass: true }, "§2 Gmail gave each a new Message-ID: found by subject, To and invoice number");
		const step0 = await runTrial(withFirst({ mutateSent: (m) => ({ ...m, html: m.html.replace("Hello,", "Hello there,") }) }));
		eq([step0.counts.step0, step0.counts.matched, step0.counts.differences.body, step0.counts.pass, /^step 0/.test(step0.counts.reason)], ["differs", 0, 1, false, true],
			"§2 step 0: the first draft was not sent unchanged; nothing else is judged; FAIL");
		const notFound = await runTrial(withFirst({ notSent: true }));
		eq([notFound.counts.step0, notFound.counts.matched, notFound.counts.unmatched.none, notFound.counts.pass], ["not found", 0, 1, false], "§2 step 0: the first draft is not in Sent Mail; FAIL");
		const grows = await runTrial([{ day: 1 }, { day: 2 }, { day: 3 }, { day: 9 }, { day: 10 }, { day: 11 }]);
		eq([grows.counts.window.until, brief(grows.counts)], ["2026-11-13", { population: 6, matched: 6, differences: 0, unmatched: 0, pending: 0, pass: true }],
			"§2 three drafts sent in the first 7 days: the window grows a day at a time to the sixth (day 11)");
		const short = await runTrial([{ day: 1 }, { day: 2 }, { day: 16 }]);
		eq([short.counts.window.until, short.counts.matched, short.counts.reason], ["2026-11-16", 2, "fewer than 6 matched"], "§2 ...14 days at most; fewer than 6: FAIL");
		for (const [label, spec] of [["its fields changed after the draft", { changedFields: "payment" }], ["marked checked with changed fields", { checkedChanged: true }],
			["its number voided", { voided: true }], ["drafted again by a person afterwards", { laterRow: true }]]) {
			const r = await runTrial([...matching(1), spec, ...matching(4)]);
			eq([r.counts.differences.nothingAfter, r.counts.pass], [1, false], `§2 nothing after: a draft ${label}; FAIL`);
		}
		const outside = await runTrial([{ draftMsg: { to: "billing@example-other.test" } }, { noDigest: true }, ...matching(6)]);
		eq([outside.counts.outside, outside.counts.population, outside.counts.pass], [{ otherDomains: 1, noDigest: 1 }, 6, true], "§2 another domain and a claim with no digest: counted, not judged");
	}

	// ===================================================================== §3
	section("§3  counts only");
	{
		const r = (await runShadow(withFirst({ sentMsg: { cc: "copy@example-broker.test" } }))).result;
		const json = JSON.stringify(r.counts);
		for (const [what, re] of [["an address", /@/], ["a load ID", /LD-TEST|123456789/], ["a subject", /Order #/], ["an amount", /\$\d/], ["body text", /Hello|Thank you/]]) {
			ok(!re.test(r.text) && !re.test(json), `§3 no ${what} in the output or its JSON`);
		}
		ok(/Result: FAIL \(differences\): the draft week runs/.test(r.text) && /Report SHA-256: [0-9a-f]{64}$/.test(r.text), "§3 the result and the report's SHA-256");
	}

	// ===================================================================== §4
	section("§4  --record");
	{
		const nowIso = "2026-11-24T15:00:00.000Z";
		const meta = (db, key) => db.prepare("SELECT value FROM auto_invoice_meta WHERE key = ?").get(key) || null;
		const audits = (db) => db.prepare("SELECT username, role, action, entity, entity_id, details FROM audit_trail ORDER BY id").all();
		const { db, sent, result } = await runShadow(matching(6));
		const refusal = (fn) => { try { fn(); return null; } catch (e) { return e instanceof report.Refusal ? e.message : `threw ${e.message}`; } };
		ok(/not the one given by --expect/.test(refusal(() => report.record({ db, result, domain: DOMAIN, expect: "0".repeat(64), dryRun: false, nowIso })) || ""),
			"§4 another SHA-256 than the reviewed one: refused");
		eq([meta(db, `send_pass:${DOMAIN}`), audits(db)], [null, []], "§4 ...nothing written");
		const dry = report.record({ db, result, domain: DOMAIN, expect: result.reportSha256, dryRun: true, nowIso });
		eq([dry.wrote, /^DRY RUN: would write send_pass:example-broker\.test and one audit row/.test(dry.message), meta(db, `send_pass:${DOMAIN}`), audits(db)], [false, true, null, []], "§4 --dry-run says what it would write and writes nothing");
		const again = await report.report({ db, mode: "shadow", domains: [DOMAIN], fetchSent: fetcher(sent), zone: ZONE, nowMs: NOW });
		eq(again.reportSha256, result.reportSha256, "§4 the same data gives the same report SHA-256 (a matching re-run)");
		const wrote = report.record({ db, result: again, domain: DOMAIN, expect: result.reportSha256, dryRun: false, nowIso });
		eq([wrote.wrote, JSON.parse(meta(db, `send_pass:${DOMAIN}`).value)],
			[true, { source: "shadow", window: { since: "2026-11-02", until: "2026-11-08" }, invoices: 6, passedAt: nowIso, reportSha256: result.reportSha256 }], "§4 a pass on the matching re-run: send_pass:<domain>, source shadow");
		eq(audits(db), [{ username: "system: auto-invoice-send-trial-report", role: "system", action: "auto_invoice_send_pass", entity: "auto_invoice", entity_id: `send_pass:${DOMAIN}`,
			details: `source shadow: 6 matched of 6, window 2026-11-02 to 2026-11-08, report ${result.reportSha256.slice(0, 12)}` }], "§4 ...with one system audit row");
		const twice = report.record({ db, result: again, domain: DOMAIN, expect: result.reportSha256, dryRun: false, nowIso });
		eq([twice.wrote, /already recorded for this report/.test(twice.message), audits(db).length], [false, true, 1], "§4 recorded already for this report: nothing more");
		const changed = await runShadow([...matching(6), {}]);
		const other = { ...changed.result };
		ok(/already recorded for another report/.test(refusal(() => report.record({ db, result: other, domain: DOMAIN, expect: other.reportSha256, dryRun: false, nowIso })) || ""),
			"§4 a decision already there for another report: refused, never overwritten");
		eq(JSON.parse(meta(db, `send_pass:${DOMAIN}`).value).reportSha256, result.reportSha256, "§4 ...the first one stands");
		const failed = await runShadow(matching(5));
		const fw = report.record({ db: failed.db, result: failed.result, domain: DOMAIN, expect: failed.result.reportSha256, dryRun: false, nowIso });
		eq([fw.key, JSON.parse(meta(failed.db, `draft_week:${DOMAIN}`).value).source, audits(failed.db).map((a) => a.action), meta(failed.db, `send_pass:${DOMAIN}`)],
			[`draft_week:${DOMAIN}`, "shadow", ["auto_invoice_draft_week"], null], "§4 a failed comparison records draft_week:<domain> (the draft week runs), never a pass");
		const pend = await runShadow([{ renderAt: T(6, 2), copies: 0 }, ...matching(6)], { now: T(8).getTime() });
		ok(/pending/.test(refusal(() => report.record({ db: pend.db, result: pend.result, domain: DOMAIN, expect: pend.result.reportSha256, dryRun: false, nowIso })) || ""),
			"§4 pending: no decision recorded yet");
		const trial = await runTrial(matching(6));
		report.record({ db: trial.db, result: trial.result, domain: DOMAIN, expect: trial.result.reportSha256, dryRun: false, nowIso });
		const tv = JSON.parse(meta(trial.db, `send_pass:${DOMAIN}`).value);
		eq([tv.source, tv.drafts], ["trial", 6], "§4 a trial pass: source trial, with its drafts");
	}

	// ===================================================================== §5
	section("§5  the arguments");
	{
		const refusalOf = (argv) => { try { report.parseArgs(argv); return null; } catch (e) { return e instanceof report.Refusal ? e.message : `threw ${e.message}`; } };
		const sha = "a".repeat(64);
		for (const [argv, re] of [
			[["--domains=example-broker.test"], /exactly one of --shadow and --trial/],
			[["--shadow", "--trial", "--domains=example-broker.test"], /exactly one of --shadow and --trial/],
			[["--shadow"], /--domains=/],
			[["--shadow", "--domains=not a domain"], /--domains=/],
			[["--shadow", "--domains=example-broker.test", "--since=2026-02-31"], /calendar day/],
			[["--shadow", "--domains=a.test,b.test", "--record", `--expect=${sha}`], /exactly one domain/],
			[["--shadow", "--domains=example-broker.test", "--record"], /--expect/],
			[["--shadow", "--domains=example-broker.test", "--dry-run"], /goes with --record/],
			[["--shadow", "--domains=example-broker.test", "--apply"], /unknown argument/],
			[["--shadow=yes", "--domains=example-broker.test"], /takes no value/],
		]) {
			ok(re.test(refusalOf(argv) || ""), `§5 refused: ${argv.join(" ")}`);
		}
		eq(report.parseArgs(["--shadow", "--domains=Example-Broker.test", "--record", `--expect=${sha}`, "--dry-run"]),
			{ mode: "shadow", domains: ["example-broker.test"], since: "", db: "", json: false, record: true, expect: sha, dryRun: true }, "§5 a record dry run's arguments");
	}

	// ===================================================================== §6
	section("§6  its IMAP: read-only, through lib/imap-draft.js");
	{
		const code = fs.readFileSync(REPORT_FILE, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
		ok(!/require\(\s*["'](tls|net)["']\s*\)/.test(code), "§6 the report opens no socket of its own");
		eq(code.match(/\b(EXAMINE|SEARCH|FETCH|LOGIN|STORE|APPEND|COPY|MOVE|EXPUNGE|UID)\b|SELECT\s+"/g) || [], [], "§6 ...and holds no IMAP command (its SQL is SELECT-only, never an IMAP SELECT)");
		ok(/fetchMessages\(\{ user, pass, mailbox: "\[Gmail\]\/Sent Mail", subject, since, before \}\)/.test(code), "§6 it reads Sent Mail through fetchMessages() only");
		const LIB = fs.readFileSync(path.join(ROOT, "lib", "imap-draft.js"), "utf8");
		const at = LIB.indexOf("const FETCH_STAGES");
		const fetchSrc = at < 0 ? "" : LIB.slice(at, LIB.indexOf("module.exports", at));
		ok(/"EXAMINE "/.test(fetchSrc) && /BODY\.PEEK\[\]/.test(fetchSrc), "§6 fetchMessages() sends EXAMINE and BODY.PEEK[]");
		eq(fetchSrc.match(/\b(SELECT|STORE|APPEND|COPY|MOVE|EXPUNGE)\b/g) || [], [], "§6 ...and no SELECT, STORE, APPEND, COPY, MOVE or EXPUNGE");

		// End to end: the report's own IMAP reader against a fake Gmail.
		const db = newDb();
		ledger.setMeta(db, "shadow_renders_on_at", ON_AT);
		const sent = [];
		for (let i = 0; i < 6; i++) await shadowLoad(db, sent, i + 1, {});
		const sessions = [];
		const server = net.createServer((sock) => {
			const s = { commands: [], fetchArgs: [] };
			sessions.push(s);
			let buf = "";
			let examined = "";
			const reply = (l) => sock.write(`${l}\r\n`);
			sock.on("error", () => {});
			reply("* OK fake Gmail");
			sock.on("data", (d) => {
				buf += d.toString("latin1");
				let eol;
				while ((eol = buf.indexOf("\r\n")) >= 0) {
					const line = buf.slice(0, eol);
					buf = buf.slice(eol + 2);
					const [tag, verb = ""] = line.split(" ", 2);
					const args = line.slice(tag.length + verb.length + 2);
					s.commands.push(verb.toUpperCase());
					if (verb === "LOGIN") reply(`${tag} OK`);
					else if (verb === "EXAMINE") { examined = args; reply(`* ${sent.length} EXISTS`); reply(`${tag} OK [READ-ONLY]`); }
					else if (verb === "SEARCH") {
						const word = (/SUBJECT "([^"]*)"$/.exec(args) || [])[1] || "";
						const hits = examined === "\"[Gmail]/Sent Mail\"" ? sent.map((m, i) => (m.subject.includes(word) ? i + 1 : 0)).filter(Boolean) : [];
						reply(`* SEARCH${hits.map((n) => ` ${n}`).join("")}`);
						reply(`${tag} OK`);
					} else if (verb === "FETCH") {
						s.fetchArgs.push(args);
						for (const n of args.split(" ")[0].split(",").map(Number)) {
							sock.write(`* ${n} FETCH (INTERNALDATE "02-Nov-2026 14:00:00 +0000" BODY[] {${sent[n - 1].raw.length}}\r\n`);
							sock.write(sent[n - 1].raw);
							sock.write(")\r\n");
						}
						reply(`${tag} OK`);
					} else if (verb === "LOGOUT") { reply(`${tag} OK`); sock.end(); }
					else reply(`${tag} BAD`);
				}
			});
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		const realConnect = tls.connect;
		tls.connect = () => net.connect(server.address().port, "127.0.0.1");
		try {
			const viaImap = await report.report({ db, mode: "shadow", domains: [DOMAIN], fetchSent: report.imapFetcher({ user: "drafts@example.com", pass: "made-up" }), zone: ZONE, nowMs: NOW });
			eq(brief(viaImap.counts), { population: 6, matched: 6, differences: 0, unmatched: 0, pending: 0, pass: true }, "§6 end to end over IMAP: six matched, PASS");
			eq([...new Set(sessions.flatMap((s) => s.commands))].sort(), ["EXAMINE", "FETCH", "LOGIN", "LOGOUT", "SEARCH"], "§6 the sessions sent LOGIN, EXAMINE, SEARCH, FETCH and LOGOUT only");
			ok(sessions.flatMap((s) => s.fetchArgs).every((a) => /\(INTERNALDATE BODY\.PEEK\[\]\)$/.test(a)), "§6 every FETCH asked for BODY.PEEK[]");
		} finally {
			tls.connect = realConnect;
			server.close();
		}
	}

	// ===================================================================== §7
	section("§7  lib/mime-read.js reads what nodemailer composes");
	{
		const longName = `Example Broker Invoice Order #${"9".repeat(60)} été.pdf`;
		const raw = await compose({ to: "Billing Desk <Billing@Example-Broker.test>, second@example-broker.test", cc: "\"Desk, AP\" <ap@example-broker.test>", bcc: "hidden@example-broker.test",
			subject: "Example Broker Order #123456789 — café", html: `<p>${"long line ".repeat(30)}é</p>`,
			attachments: [{ filename: longName, content: Buffer.from([0, 1, 2, 255]) }, { filename: "plain.pdf", content: "made-up" }] }, { date: T(1), messageId: "<made-up-1@example.com>" });
		const m = mimeRead.parseMessage(raw);
		eq([m.to, m.cc, m.bcc], [["billing@example-broker.test", "second@example-broker.test"], ["ap@example-broker.test"], ["hidden@example-broker.test"]], "§7 To, Cc (a quoted name with a comma) and Bcc, lower case");
		eq([m.subject, m.date, m.messageId], ["Example Broker Order #123456789 — café", T(1).getTime(), "<made-up-1@example.com>"], "§7 an encoded subject, the Date and the Message-ID");
		eq(m.html, `<p>${"long line ".repeat(30)}é</p>`, "§7 quoted-printable HTML, decoded");
		eq(m.attachments.map((a) => [a.filename, a.content.toString("hex")]), [[longName, "000102ff"], ["plain.pdf", Buffer.from("made-up").toString("hex")]], "§7 base64 attachments with a long encoded name");
		eq(mimeRead.parseMessage(Buffer.from("garbage")).attachments, [], "§7 a message it can't read gives nothing, never a throw");
	}

	// ===================================================================== §8
	section("§8  mutants of the report");
	function mutant(from, to) {
		const src = fs.readFileSync(REPORT_FILE, "utf8");
		if (src.split(from).length !== 2) return null;
		const m = new Module(REPORT_FILE, module);
		m.filename = REPORT_FILE;
		m.paths = Module._nodeModulePaths(path.dirname(REPORT_FILE));
		m._compile(src.replace(from, () => to), REPORT_FILE);
		return m.exports;
	}
	for (const [label, from, to, specs, still] of [
		["match: every found load counted a difference", "if (!nothingAfter(candidates[0])) failed.push(\"nothingAfter\");", "failed.push(\"nothingAfter\");",
			matching(6), (c) => c.matched === 6 && c.pass],
		["difference: conditions 2-5 never checked", "const failed = rules.digestDifferences(expected, candidates[0].digest);", "const failed = [];",
			withFirst({ mutateSent: (m) => ({ ...m, html: m.html.replace("Thank you,", "Thanks,") }) }), (c) => c.differences.body === 1 && !c.pass],
		["unmatched: several Sent copies accepted", "if (candidates.length !== 1) return { found: candidates.length ? \"several\" : \"none\", failed: [] };", "if (!candidates.length) return { found: \"none\", failed: [] };",
			withFirst({ copies: 2 }), (c) => c.unmatched.several === 1 && !c.pass],
		["fewer than 6: the minimum lowered", "counts.matched < PASS_MINIMUM", "counts.matched < 1",
			matching(5), (c) => c.reason === "fewer than 6 matched" && !c.pass],
	]) {
		const mod = mutant(from, to);
		ok(mod, `§8 MUTANT ${label}: applied to the shipped source once`);
		if (!mod) continue;
		const real = await runShadow(specs);
		const mutated = await runShadow(specs, { mod });
		ok(still(real.counts) && !still(mutated.counts), `§8 MUTANT ${label}: the shipped report passes the case, the mutant fails it (caught)`);
	}
})().catch((e) => failures.push(`the run threw: ${e && e.stack}`)).then(finish);
