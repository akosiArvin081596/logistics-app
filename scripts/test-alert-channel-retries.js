#!/usr/bin/env node
/**
 * Each channel of an alert is tracked on its own, so a failed email is retried after the in-app
 * notification went in (and the other way round), in the four alert ledgers that used to mark a
 * row alerted as soon as EITHER channel went out: eld_feed_alerts (alertEldFeedSilence()),
 * expense_duplicate_alerts (alertDuplicateReceipts()), ratecon_extract_alerts
 * (alertUnusableRateConExtraction()) and invoice_undated_alerts (runUndatedLoadAlerts()). The shape
 * is #505's for ratecon_reissue_holds, shared in lib/alert-channels.js. And the daily integrity
 * check reports re-issue alerts that were given up undelivered.
 *
 *   §1 lib/alert-channels.js: what a row owes (a row alerted before the channels were tracked owes
 *      nothing), the claim (one call at a time, a stale claim retaken), the backoff, mailbox() (mail
 *      needs GMAIL_USER and GMAIL_APP_PASSWORD), the give-up (only the second channel of an alert a
 *      person was told about, 48 h after; never while a live call holds the row; never a row nothing
 *      was delivered for); prepareLedger() adds the columns once, marks the rows alerted before them
 *      "before_tracking", and when the columns can't be added logs once and keeps the old rule.
 *   §2-§5, one alert each, lifted from server.js (scripts/lib/server-lift.js) over an in-memory
 *      SQLite with the ledger's own CREATE TABLE and stand-in email and notification channels:
 *      - email fails, in-app goes: the row owes the email; a later tick sends only the email;
 *      - in-app fails, email goes: a later tick sends only the in-app notification;
 *      - both go: nothing is owed and a later tick sends nothing;
 *      - rows alerted before the change owe nothing (no re-arm) and are marked before_tracking;
 *        a row nothing was delivered for is still retried, as before;
 *      - the email still undelivered 48 h after the in-app notice is given up (gave_up), nothing is
 *        sent, and one log line says so; a row nothing was delivered for, first tried 49 h ago, is
 *        not given up and is retried (the owner's decision, 2026-10-14);
 *      the later tick is the alert's own: the hourly ELD sweep and the six-hourly duplicate sweep
 *      call the alert again; a re-sighted rate con does too; the unusable-address alert and the
 *      undated-load digest are retried by the shared retry sweep (retryRateConExtractAlerts(),
 *      retryUndatedLoadAlerts()) at the row's next slot, and the retry says it is one. A resolved
 *      ELD feed or duplicate group that re-opens owes both channels again. With no GMAIL_USER, or
 *      no GMAIL_APP_PASSWORD, the email is skipped, not owed. ELD: the email's retry is not a second
 *      send against the daily cap, and when the columns can't be added the alert keeps its old
 *      rule. Undated: only the loads a channel that went out carried are told; the retry re-reads
 *      Job Tracking and leaves out (still owed) a load given a date since, and says when the loads
 *      were first listed (Eastern); a retry of a load already told is free under the daily cap.
 *   §6 the shared retry sweep: sweepAlertChannelRetries() runs both halves, one failing does not
 *      stop the other; startAlertChannelRetrySweep() starts an unref'd 15-minute timer, and none in
 *      a replica or with both kill switches off.
 *   §7 the daily integrity check (lib/integrity-check.js) reports re-issue alerts given up
 *      (ratecon_reissue_holds rows with email_skipped or notify_skipped "gave_up"): the load
 *      numbers and the count, once each, the first-seen date in Eastern (ISO and SQLite's UTC
 *      form alike); it never writes that ledger.
 *
 * Every value is made up: load numbers, units, names, amounts, addresses and mailboxes.
 * SERVER_JS=<file> runs against another copy of server.js, INTEGRITY_CHECK_JS=<file> another
 * lib/integrity-check.js (the base, to show the cases fail).
 * Pure: no server, no network, no app.db. Run: node scripts/test-alert-channel-retries.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const util = require("util");
const Module = require("module");
const { closure } = require("./lib/server-lift");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");
const rootRequire = Module.createRequire(path.join(ROOT, "server.js"));
let Database;
try {
	Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const alertChannels = require(path.join(ROOT, "lib", "alert-channels.js"));
// A lib module, or another copy of it loaded as if it sat in lib/ (its relative requires resolve there).
function loadLib(name, envName) {
	const file = path.join(ROOT, "lib", name);
	if (!process.env[envName]) return require(file);
	const m = new Module(file, module);
	m.filename = file;
	m.paths = Module._nodeModulePaths(path.dirname(file));
	m._compile(fs.readFileSync(process.env[envName], "utf8"), file);
	return m.exports;
}
const ic = loadLib("integrity-check.js", "INTEGRITY_CHECK_JS");

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
	if (cond) { pass++; return; }
	fail++;
	console.log(`FAIL ${label}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function eq(actual, expected, label) {
	ok(label, JSON.stringify(actual) === JSON.stringify(expected), { got: actual, want: expected });
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const hoursAgo = (h) => new Date(Date.now() - h * HOUR).toISOString();
// A statement that may not run on the base (a column it lacks): false instead of a throw.
function tryRun(db, sql, ...args) {
	try { db.prepare(sql).run(...args); return true; } catch { return false; }
}
const rowOf = (db, table, keyCol, key) => db.prepare(`SELECT * FROM ${table} WHERE ${keyCol} = ?`).get(key) || {};
// A CREATE TABLE as server.js writes it, up to its closing line.
function ddl(name) {
	const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\t*\\)`).exec(SRC);
	if (!m) throw new Error(`no CREATE TABLE ${name} in server.js`);
	return m[0];
}
const hasFn = (name) => new RegExp(`\\n(async )?function ${name}\\(`).test(SRC);

// The email and in-app channels, each switchable, recording what was sent.
function makeChannels() {
	const ch = { mailOk: true, inAppOk: true, sends: [], notes: [], logs: [] };
	ch.sendEmail = async (to, subject, html) => { ch.sends.push({ to, subject, html }); return ch.mailOk; };
	ch.insertDispatchNotification = { run: (type, title, body, meta) => {
		if (!ch.inAppOk) throw new Error("notifications down (test)");
		ch.notes.push({ type, title, body, meta });
	} };
	ch.io = { to: () => ({ emit() {} }) };
	const capture = (...a) => { ch.logs.push(util.format(...a)); };
	ch.console = { log: capture, warn: capture, error: capture, info: capture };
	return ch;
}
// A made-up mailbox: mail counts as configured only with both settings.
const PROCESS = { env: { GMAIL_USER: "ops@example.test", GMAIL_APP_PASSWORD: "app-password-under-test" } };

// `roots` lifted from server.js over `deps` (the names given, never lifted); a root the server.js
// under test lacks is left out, and its cases fail.
function lift(roots, deps) {
	const have = roots.filter(hasFn);
	const names = Object.keys(deps);
	const c = closure(SRC, { roots: have, provided: names, denied: ["server", "auth", "google", "transporter"] });
	const fns = new Function(...names, `"use strict";\n${c.text}\nreturn { ${have.join(", ")} };`)(...names.map((n) => deps[n]));
	return Object.fromEntries(roots.map((r) => [r, fns[r] || (async () => { throw new Error(`${r}() is not in this server.js`); })]));
}
async function attempt(fn) {
	try { return await fn(); } catch (e) { return { threw: e.message }; }
}

// ===========================================================================
function section1() {
	console.log("§1 lib/alert-channels.js");
	const ac = alertChannels;
	eq(ac.owes({}), { email: true, inApp: true }, "§1 a new row owes both channels");
	eq(ac.owes({ alerted_at: "t", notified_at: "t" }), { email: true, inApp: false }, "§1 told in-app: owes the email");
	eq(ac.owes({ alerted_at: "t", emailed_at: "t" }), { email: false, inApp: true }, "§1 told by email: owes the in-app notification");
	eq(ac.owes({ alerted_at: "t", emailed_at: "t", notified_at: "t" }), null, "§1 told by both: owes nothing");
	eq(ac.owes({ alerted_at: "t", notified_at: "t", email_skipped: "no_recipient" }), null, "§1 an email skipped: owes nothing");
	eq(ac.owes({ alerted_at: "t" }), null, "§1 alerted before the channels were tracked: owes nothing");
	eq(ac.owes({ email_skipped: "gave_up", notify_skipped: "gave_up" }), null, "§1 both given up: owes nothing");

	const now = Date.now();
	ok("§1 a row never tried is due", ac.retryDue({}, now));
	ok("§1 the first retry waits 15 minutes", !ac.retryDue({ attempts: 1, last_try: new Date(now - 14 * 60000).toISOString() }, now)
		&& ac.retryDue({ attempts: 1, last_try: new Date(now - 15 * 60000).toISOString() }, now));
	ok("§1 later ones wait 30 min, 1 h, 2 h, then 4 h", ac.retryDue({ attempts: 2, last_try: new Date(now - 30 * 60000).toISOString() }, now)
		&& !ac.retryDue({ attempts: 3, last_try: new Date(now - 59 * 60000).toISOString() }, now)
		&& !ac.retryDue({ attempts: 9, last_try: new Date(now - 3.9 * HOUR).toISOString() }, now)
		&& ac.retryDue({ attempts: 9, last_try: new Date(now - 4 * HOUR).toISOString() }, now));
	ok("§1 the second channel is given up 48 h after a person was told by the first",
		!ac.expired({ alerted_at: hoursAgo(47.9), first_try: hoursAgo(100) }, now) && ac.expired({ alerted_at: hoursAgo(48.1) }, now));
	ok("§1 a row nothing was delivered for is never given up, however old its first try", !ac.expired({ first_try: hoursAgo(500) }, now) && !ac.expired({}, now));
	eq([ac.mailbox({ GMAIL_USER: "ops@example.test", GMAIL_APP_PASSWORD: "p" }), ac.mailbox({ GMAIL_USER: "ops@example.test" }), ac.mailbox({ GMAIL_APP_PASSWORD: "p" }), ac.mailbox({})],
		["ops@example.test", "", "", ""], "§1 mailbox(): GMAIL_USER only when GMAIL_APP_PASSWORD is set too");

	const db = new Database(":memory:");
	db.exec("CREATE TABLE t_alerts (k TEXT PRIMARY KEY, first_seen TEXT, alerted_at TEXT, resolved_at TEXT)");
	db.prepare("INSERT INTO t_alerts (k, alerted_at) VALUES ('old', ?), ('unsent', NULL)").run(hoursAgo(100));
	eq(ac.prepareLedger(db, "t_alerts", [["payload", "TEXT"]]), true, "§1 prepareLedger(): the columns are added");
	const cols = db.prepare("PRAGMA table_info(t_alerts)").all().map((c) => c.name);
	ok("§1 ensureColumns() adds the channel columns and the extra one",
		["emailed_at", "notified_at", "email_skipped", "notify_skipped", "claimed_at", "attempts", "first_try", "last_try", "payload"].every((c) => cols.includes(c)), cols);
	eq([rowOf(db, "t_alerts", "k", "old").email_skipped, rowOf(db, "t_alerts", "k", "old").notify_skipped], ["before_tracking", "before_tracking"],
		"§1 a row alerted before the columns is marked before_tracking on both channels");
	eq(rowOf(db, "t_alerts", "k", "unsent").email_skipped, null, "§1 a row never delivered is left owing");
	const c1 = ac.claim(db, "t_alerts", "k", "unsent");
	ok("§1 claim(): the owed channels and the claim time", !!c1 && c1.email && c1.inApp && typeof c1.claimedAt === "string", c1);
	eq(ac.claim(db, "t_alerts", "k", "unsent"), null, "§1 a second claim while the first is live: none");
	eq(ac.claim(db, "t_alerts", "k", "unsent", new Date(Date.now() + 16 * 60000)) !== null, true, "§1 a claim older than 15 minutes is retaken");
	eq(ac.claim(db, "t_alerts", "k", "old"), null, "§1 a before_tracking row is never claimed");
	const r = rowOf(db, "t_alerts", "k", "unsent");
	ok("§1 each claim counts a try; first_try is kept from the first", r.attempts === 2 && !!r.first_try && r.last_try > r.first_try, r);
	eq(ac.giveUp(db, "t_alerts", "k", "unsent"), { email: false, inApp: false }, "§1 giveUp(): nothing on a row nothing was delivered for");
	db.prepare("UPDATE t_alerts SET alerted_at = ?, notified_at = ?, claimed_at = ? WHERE k = 'unsent'").run(hoursAgo(50), hoursAgo(50), new Date().toISOString());
	eq(ac.giveUp(db, "t_alerts", "k", "unsent"), { email: false, inApp: false }, "§1 giveUp(): not while a live call holds the row (its send may still land)");
	db.prepare("UPDATE t_alerts SET claimed_at = NULL WHERE k = 'unsent'").run();
	eq(ac.giveUp(db, "t_alerts", "k", "unsent"), { email: true, inApp: false }, "§1 giveUp(): the email still owed after a person was told in-app");
	eq(ac.giveUp(db, "t_alerts", "k", "unsent"), { email: false, inApp: false }, "§1 …and only once");
	let refused = false;
	try { ac.ensureColumns(db, "t_alerts; DROP TABLE t_alerts"); } catch { refused = true; }
	ok("§1 a table name that is not an identifier is refused", refused && !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 't_alerts'").get());

	// The columns can't be added: logged once, and the ledger keeps the old rule.
	const real = new Database(":memory:");
	real.exec("CREATE TABLE f_alerts (k TEXT PRIMARY KEY, alerted_at TEXT)");
	const broken = { prepare: (s) => { if (/^ALTER TABLE/.test(s)) throw new Error("database is locked (test)"); return real.prepare(s); } };
	const logs = [];
	const log = { error: (...a) => logs.push(a.join(" ")) };
	eq([ac.prepareLedger(broken, "f_alerts", [], log), ac.prepareLedger(broken, "f_alerts", [], log), logs.length], [false, false, 1],
		"§1 prepareLedger(): an ALTER that fails answers false, is not tried again, and is logged once");
	const c3 = ac.claim(broken, "f_alerts", "k", "x");
	ac.stampSent(broken, "f_alerts", "k", "x", "email");
	ok("§1 an untracked ledger keeps the old rule: claim() answers both channels, unclaimed", !!c3 && c3.email && c3.inApp && c3.claimedAt === null, c3);
	eq([ac.owesSql(broken, "f_alerts"), ac.retryCandidates(broken, "f_alerts"), ac.giveUp(broken, "f_alerts", "k", "x")],
		["alerted_at IS NULL", { expired: [], due: [] }, { email: false, inApp: false }], "§1 …its owed test is the old one, and nothing is retried or given up");
}

// ===========================================================================
async function section2() {
	console.log("§2 eld_feed_alerts: alertEldFeedSilence()");
	const world = (db) => {
		const ch = makeChannels();
		const f = lift(["alertEldFeedSilence"], {
			db, sendEmail: ch.sendEmail, insertDispatchNotification: ch.insertDispatchNotification, io: ch.io, console: ch.console,
			process: PROCESS, require: rootRequire, eldFeedAlertContext: () => null,
		});
		return { ...f, ch };
	};
	const freshDb = () => {
		const db = new Database(":memory:");
		db.exec(ddl("eld_feed_alerts"));
		db.exec(ddl("server_state"));
		return db;
	};
	const feed = (vid) => ({ kind: "truck", state: "stale", truckId: 7, unitNumber: `TEST-${vid}`, vehicleId: vid, lastFixMs: Date.now() - 3 * DAY, silentHours: 72, fixes24h: 0, reason: "no clean fix for 3 days" });
	const led = (db, vid) => rowOf(db, "eld_feed_alerts", "alert_key", `vid:${vid}`);
	await channelCases("§2 ELD feed", {
		freshDb, world, led, subject: (vid) => feed(vid),
		send: (w, vid) => w.alertEldFeedSilence(feed(vid)),
		tick: (w, vid) => w.alertEldFeedSilence(feed(vid)),
		legacyInsert: (db, vid) => db.prepare("INSERT INTO eld_feed_alerts (alert_key, truck_unit, alert_condition, first_seen, alerted_at) VALUES (?, ?, 'stale', ?, ?)")
			.run(`vid:${vid}`, `TEST-${vid}`, hoursAgo(80), hoursAgo(79)),
		table: "eld_feed_alerts", keyCol: "alert_key", key: (vid) => `vid:${vid}`, ids: ["vid9101", "vid9102", "vid9103", "vid9104", "vid9105", "vid9106", "vid9107"],
		reopen: (db, vid) => db.prepare("UPDATE eld_feed_alerts SET resolved_at = ?, alerted_at = ? WHERE alert_key = ?").run(hoursAgo(1), hoursAgo(25), `vid:${vid}`),
	});
	{
		// The daily cap counts sends, once per alert: the email's retry is not a second one.
		const db = freshDb();
		const w = world(db);
		const sendLog = () => {
			const r = db.prepare("SELECT value FROM server_state WHERE key = 'eld_feed_alert_sends'").get();
			return r ? JSON.parse(r.value).length : 0;
		};
		w.ch.mailOk = false;
		await attempt(() => w.alertEldFeedSilence(feed("vid9201")));
		const afterFirst = sendLog();
		w.ch.mailOk = true;
		await attempt(() => w.alertEldFeedSilence(feed("vid9201")));
		eq([afterFirst, sendLog(), w.ch.sends.length], [1, 1, 2], "§2 ELD feed: the email's retry goes out without counting a second send against the daily cap");
	}
	{
		// The columns can't be added: logged once, and the alert keeps its old rule.
		const real = freshDb();
		const db = { prepare: (s) => { if (/^ALTER TABLE/.test(s)) throw new Error("database is locked (test)"); return real.prepare(s); } };
		const w = world(db);
		const r1 = await attempt(() => w.alertEldFeedSilence(feed("vid9301")));
		const r2 = await attempt(() => w.alertEldFeedSilence(feed("vid9301")));
		ok("§2 ELD feed, the columns can't be added: the alert still goes out by both channels and is stamped",
			r1 && r1.alerted === true && w.ch.sends.length === 1 && w.ch.notes.length === 1 && !!rowOf(real, "eld_feed_alerts", "alert_key", "vid:vid9301").alerted_at, r1);
		ok("§2 …a second sweep dedupes it as before", r2 && r2.reason === "already_alerted" && w.ch.sends.length === 1, r2);
		eq(w.ch.logs.filter((l) => /per-channel columns could not be added/.test(l)).length, 1, "§2 …and the failure is logged once");
	}
}

async function section3() {
	console.log("§3 expense_duplicate_alerts: alertDuplicateReceipts()");
	const world = (db) => {
		const ch = makeChannels();
		const f = lift(["alertDuplicateReceipts"], {
			db, sendEmail: ch.sendEmail, insertDispatchNotification: ch.insertDispatchNotification, io: ch.io, console: ch.console,
			process: PROCESS, require: rootRequire,
		});
		return { ...f, ch };
	};
	const freshDb = () => {
		const db = new Database(":memory:");
		db.exec(ddl("expense_duplicate_alerts"));
		return db;
	};
	const key = (unit) => `t:${unit}|2026-10-01|12000`;
	const group = (unit) => ({
		key: key(unit), truckUnit: unit, driver: "Test Driver Ana", localDay: "2026-10-01", amount: 120, excessAmount: 120, confidence: "high",
		reasons: ["same truck, day and amount"], period: "2026-10", settlement: "none",
		rows: [{ id: 901, vendor: "Test Fuel Stop", type: "Fuel", amount: 120 }, { id: 902, vendor: "Test Fuel Stop", type: "Fuel", amount: 120 }],
	});
	await channelCases("§3 duplicate receipts", {
		freshDb, world, led: (db, unit) => rowOf(db, "expense_duplicate_alerts", "group_key", key(unit)),
		send: (w, unit) => w.alertDuplicateReceipts(group(unit)),
		tick: (w, unit) => w.alertDuplicateReceipts(group(unit)),
		legacyInsert: (db, unit) => db.prepare("INSERT INTO expense_duplicate_alerts (group_key, truck_unit, first_seen, alerted_at) VALUES (?, ?, ?, ?)")
			.run(key(unit), unit, hoursAgo(80), hoursAgo(79)),
		table: "expense_duplicate_alerts", keyCol: "group_key", key, ids: ["TU-31", "TU-32", "TU-33", "TU-34", "TU-35", "TU-36", "TU-37"],
		reopen: (db, unit) => db.prepare("UPDATE expense_duplicate_alerts SET resolved_at = ? WHERE group_key = ?").run(hoursAgo(1), key(unit)),
	});
}

// The cases every alert shares. `send` is the first sighting; `tick` the later one that retries.
async function channelCases(tag, o) {
	const [idA, idB, idC, idD, idE, idF, idG] = o.ids;
	{
		// Email fails, in-app goes.
		const db = o.freshDb();
		const w = o.world(db);
		w.ch.mailOk = false;
		const r1 = await attempt(() => o.send(w, idA));
		const after1 = o.led(db, idA);
		ok(`${tag}, email fails and in-app goes: a person was told (alerted)`, r1 && r1.alerted === true && !!after1.alerted_at, { r1, after1 });
		ok(`${tag}, email fails and in-app goes: the row owes the email (notified_at set, emailed_at not)`, !!after1.notified_at && !after1.emailed_at, after1);
		w.ch.mailOk = true;
		const sends = w.ch.sends.length;
		const notes = w.ch.notes.length;
		await attempt(() => o.tick(w, idA));
		eq([w.ch.sends.length - sends, w.ch.notes.length - notes], [1, 0], `${tag}, email fails and in-app goes: a later tick sends only the email`);
		ok(`${tag}, email fails and in-app goes: …and the email is stamped`, !!o.led(db, idA).emailed_at, o.led(db, idA));
		eq(o.led(db, idA).alerted_at, after1.alerted_at, `${tag}, email fails and in-app goes: alerted_at keeps when a person was first told`);
		const s2 = w.ch.sends.length;
		await attempt(() => o.tick(w, idA));
		eq([w.ch.sends.length - s2, w.ch.notes.length - notes], [0, 0], `${tag}, email fails and in-app goes: once both went, nothing more`);
		ok(`${tag}, the log line names each channel`, w.ch.logs.some((l) => /email FAILED/.test(l) && /in-app sent/.test(l)), w.ch.logs);
		if (o.reopen) {
			o.reopen(db, idA);
			const s3 = w.ch.sends.length;
			const n3 = w.ch.notes.length;
			await attempt(() => o.tick(w, idA));
			eq([w.ch.sends.length - s3, w.ch.notes.length - n3], [1, 1], `${tag}: a resolved row that re-opens owes both channels again`);
		}
	}
	{
		// In-app fails, email goes.
		const db = o.freshDb();
		const w = o.world(db);
		w.ch.inAppOk = false;
		await attempt(() => o.send(w, idB));
		ok(`${tag}, in-app fails and email goes: the row owes the in-app notification`, !!o.led(db, idB).emailed_at && !o.led(db, idB).notified_at, o.led(db, idB));
		w.ch.inAppOk = true;
		const sends = w.ch.sends.length;
		await attempt(() => o.tick(w, idB));
		eq([w.ch.sends.length - sends, w.ch.notes.length], [0, 1], `${tag}, in-app fails and email goes: a later tick sends only the in-app notification`);
	}
	{
		// Both go.
		const db = o.freshDb();
		const w = o.world(db);
		await attempt(() => o.send(w, idC));
		eq([w.ch.sends.length, w.ch.notes.length], [1, 1], `${tag}, both go: one email and one notification`);
		await attempt(() => o.tick(w, idC));
		eq([w.ch.sends.length, w.ch.notes.length], [1, 1], `${tag}, both go: nothing is owed, a later tick sends nothing`);
	}
	{
		// Rows alerted before the change owe nothing; one nothing was delivered for is still retried.
		const db = o.freshDb();
		o.legacyInsert(db, idD);
		db.prepare(`INSERT INTO ${o.table} (${o.keyCol}, first_seen) VALUES (?, ?)`).run(o.key(idF), hoursAgo(5));
		const w = o.world(db);
		await attempt(() => o.tick(w, idD));
		eq([w.ch.sends.length, w.ch.notes.length], [0, 0], `${tag}, a row alerted before the change: nothing is re-sent (no re-arm)`);
		eq([o.led(db, idD).email_skipped, o.led(db, idD).notify_skipped], ["before_tracking", "before_tracking"], `${tag}, …and it is marked before_tracking`);
		// The retry sweep retries only rows it has tried; a row never tried waits for its next sighting.
		if (o.retriesUntried !== false) {
			await attempt(() => o.tick(w, idF));
			eq([w.ch.sends.length, w.ch.notes.length], [1, 1], `${tag}, a row nothing was delivered for is still retried on both channels`);
		}
	}
	{
		// Told in-app, the email still undelivered 48 h later: the email is given up.
		const db = o.freshDb();
		const w = o.world(db);
		w.ch.mailOk = false;
		await attempt(() => o.send(w, idE));
		const aged = tryRun(db, `UPDATE ${o.table} SET alerted_at = ?, notified_at = ?, first_try = ? WHERE ${o.keyCol} = ?`, hoursAgo(49), hoursAgo(49), hoursAgo(49), o.key(idE));
		w.ch.mailOk = true;
		const sends = w.ch.sends.length;
		const r = await attempt(() => o.tick(w, idE));
		ok(`${tag}, the email still undelivered 48 h after the in-app notice: nothing is sent`, aged && w.ch.sends.length === sends && w.ch.notes.length === 1, { aged, r });
		eq(o.led(db, idE).email_skipped, "gave_up", `${tag}, the email still undelivered 48 h after the in-app notice: it is given up`);
		ok(`${tag}, …with one GAVE UP log line`, w.ch.logs.filter((l) => /GAVE UP/.test(l)).length === 1, w.ch.logs);
		await attempt(() => o.tick(w, idE));
		ok(`${tag}, given up: never retried or logged again`, w.ch.sends.length === sends && w.ch.logs.filter((l) => /GAVE UP/.test(l)).length === 1, w.ch.logs);
	}
	{
		// Nothing delivered, first tried 49 h ago: never given up, still retried (the owner's decision).
		const db = o.freshDb();
		const w = o.world(db);
		w.ch.mailOk = false;
		w.ch.inAppOk = false;
		await attempt(() => o.send(w, idG));
		const aged = tryRun(db, `UPDATE ${o.table} SET first_try = ? WHERE ${o.keyCol} = ?`, hoursAgo(49), o.key(idG));
		w.ch.mailOk = true;
		w.ch.inAppOk = true;
		const sends = w.ch.sends.length;
		await attempt(() => o.tick(w, idG));
		const row = o.led(db, idG);
		ok(`${tag}, nothing delivered and first tried 49 h ago: not given up, both channels retried and delivered`,
			aged && w.ch.sends.length === sends + 1 && w.ch.notes.length === 1 && !row.email_skipped && !row.notify_skipped && !!row.alerted_at, { aged, row });
	}
	for (const [label, env] of [["no GMAIL_USER", { GMAIL_APP_PASSWORD: "app-password-under-test" }], ["GMAIL_USER but no GMAIL_APP_PASSWORD", { GMAIL_USER: "ops@example.test" }]]) {
		// No mailbox configured: the email is skipped, not owed.
		const db = o.freshDb();
		const saved = PROCESS.env;
		PROCESS.env = env;
		let w;
		try { w = o.world(db); await attempt(() => o.send(w, idB)); } finally { PROCESS.env = saved; }
		eq([w.ch.sends.length, w.ch.notes.length, o.led(db, idB).email_skipped], [0, 1, "no_recipient"], `${tag}, ${label}: no email, the in-app notification, and the email skipped (no_recipient)`);
	}
}

// ===========================================================================
async function section4() {
	console.log("§4 ratecon_extract_alerts: alertUnusableRateConExtraction() and the retry sweep");
	const world = (db) => {
		const ch = makeChannels();
		const f = lift(["alertUnusableRateConExtraction", "retryRateConExtractAlerts"], {
			db, sendEmail: ch.sendEmail, insertDispatchNotification: ch.insertDispatchNotification, io: ch.io, console: ch.console,
			process: PROCESS, require: rootRequire,
		});
		return { ...f, ch };
	};
	const freshDb = () => {
		const db = new Database(":memory:");
		db.exec(ddl("ratecon_extract_alerts"));
		return db;
	};
	const sighting = (id) => ({ loadId: id, unusable: ["Drop-off Address"], fields: { "Load Number": id, Rate: "$1,100.00", "Pickup Address": "10 Test Way, Dallas, TX 75201", "Drop-off Address": "TEST DOCK 9" } });
	const led = (db, id) => rowOf(db, "ratecon_extract_alerts", "load_id", id);
	// The sweep reaches a row at its next slot: the last try is set back past it.
	const sweepLater = async (w, db, id) => {
		tryRun(db, "UPDATE ratecon_extract_alerts SET last_try = ? WHERE load_id = ?", new Date(Date.now() - 16 * 60000).toISOString(), id);
		return attempt(() => w.retryRateConExtractAlerts({}));
	};
	await channelCases("§4 unusable address (re-sighted)", {
		freshDb, world, led,
		send: (w, id) => w.alertUnusableRateConExtraction(sighting(id)),
		tick: (w, id) => w.alertUnusableRateConExtraction(sighting(id)),
		legacyInsert: (db, id) => db.prepare("INSERT INTO ratecon_extract_alerts (load_id, unusable, first_seen, alerted_at) VALUES (?, 'Drop-off Address', ?, ?)")
			.run(id, hoursAgo(80), hoursAgo(79)),
		table: "ratecon_extract_alerts", keyCol: "load_id", key: (id) => id, ids: ["RX-9101", "RX-9102", "RX-9103", "RX-9104", "RX-9105", "RX-9106", "RX-9107"],
	});
	await channelCases("§4 unusable address (retry sweep)", {
		freshDb, led,
		world: (db) => ({ ...world(db), db }),
		send: (w, id) => w.alertUnusableRateConExtraction(sighting(id)),
		tick: (w, id) => sweepLater(w, w.db, id),
		legacyInsert: (db, id) => db.prepare("INSERT INTO ratecon_extract_alerts (load_id, unusable, first_seen, alerted_at) VALUES (?, 'Drop-off Address', ?, ?)")
			.run(id, hoursAgo(80), hoursAgo(79)),
		table: "ratecon_extract_alerts", keyCol: "load_id", key: (id) => id, ids: ["RX-9201", "RX-9202", "RX-9203", "RX-9204", "RX-9205", "RX-9206", "RX-9207"],
		retriesUntried: false,
	});
	{
		const db = freshDb();
		const w = world(db);
		w.ch.mailOk = false;
		await attempt(() => w.alertUnusableRateConExtraction(sighting("RX-9301")));
		w.ch.mailOk = true;
		await attempt(() => w.retryRateConExtractAlerts({}));
		eq(w.ch.sends.length, 1, "§4 the retry sweep waits for the row's next slot (15 minutes after the first try)");
		await sweepLater(w, db, "RX-9301");
		const retry = w.ch.sends[w.ch.sends.length - 1] || { html: "" };
		ok("§4 the retried email says it is a retry, with the load, its unusable field and the fields as first extracted",
			/This is a retry/.test(retry.html) && /RX-9301/.test(retry.subject) && /Drop-off Address/.test(retry.html) && /TEST DOCK 9/.test(retry.html), retry.html.slice(0, 400));
		ok("§4 the retry sweep logs one summary line", w.ch.logs.some((l) => /retry sweep: 1 alert\(s\) retried, 1 delivered/.test(l)), w.ch.logs);
	}
}

// ===========================================================================
async function section5() {
	console.log("§5 invoice_undated_alerts: runUndatedLoadAlerts() and the retry sweep");
	const HEADERS = ["Load ID", "Driver", "Job Status", "Pickup Appointment", "Drop-off Appointment", "Status Update Date", "Completion Date"];
	const sheetRow = (id, dated = false) => [id, "Test Driver Una", "Delivered", "10/05/2026 08:00", "10/06/2026 09:00", dated ? "10/06/2026 10:00:00" : "", ""];
	const RANGE = { weekStart: "2026-10-03", weekEnd: "2026-10-09" };
	const freshDb = () => {
		const db = new Database(":memory:");
		db.exec(ddl("server_state"));
		db.exec(ddl("invoice_undated_alerts"));
		return db;
	};
	const world = (db) => {
		const ch = makeChannels();
		const sheet = { rows: [sheetRow("UL-9000", true)] };
		const f = lift(["runUndatedLoadAlerts", "retryUndatedLoadAlerts"], {
			db, sendEmail: ch.sendEmail, insertDispatchNotification: ch.insertDispatchNotification, io: ch.io, console: ch.console,
			process: PROCESS, require: rootRequire, SPREADSHEET_ID: "sheet-under-test-b9", getDeletedLoadIds: () => new Set(),
			getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: [HEADERS, ...sheet.rows] } }) } } }),
		});
		return { ...f, ch, sheet, db };
	};
	const led = (db, id) => rowOf(db, "invoice_undated_alerts", "load_key", id.toLowerCase());
	const digestNotes = (w) => w.ch.notes.filter((n) => n.type === "invoices-undated");
	const digestMails = (w) => w.ch.sends.filter((s) => / no weekly invoice will bill$/.test(s.subject));
	const sweepLater = async (w, id) => {
		tryRun(w.db, "UPDATE invoice_undated_alerts SET last_try = ? WHERE load_key = ?", new Date(Date.now() - 16 * 60000).toISOString(), id.toLowerCase());
		return attempt(() => w.retryUndatedLoadAlerts({}));
	};
	// The baseline (UL-9000 dated, history), then `id` completed with no date and the weekly run.
	const newLoad = async (w, id) => {
		await attempt(() => w.runUndatedLoadAlerts({ seedOnly: true }));
		w.sheet.rows.push(sheetRow(id));
		return attempt(() => w.runUndatedLoadAlerts({ range: RANGE }));
	};
	{
		const w = world(freshDb());
		w.ch.mailOk = false;
		const r = await newLoad(w, "UL-9101");
		ok("§5 email fails and in-app goes: the digest is delivered in-app", r && r.notified === true && digestNotes(w).length === 1, r);
		ok("§5 email fails and in-app goes: the load owes the email", !!led(w.db, "UL-9101").notified_at && !led(w.db, "UL-9101").emailed_at, led(w.db, "UL-9101"));
		w.ch.mailOk = true;
		const mails = digestMails(w).length;
		await attempt(() => w.retryUndatedLoadAlerts({}));
		eq(digestMails(w).length, mails, "§5 the retry sweep waits for the row's next slot");
		await sweepLater(w, "UL-9101");
		const mail = digestMails(w)[digestMails(w).length - 1] || { html: "" };
		eq([digestMails(w).length - mails, digestNotes(w).length], [1, 1], "§5 email fails and in-app goes: the retry sweep sends only the email");
		ok("§5 …naming the load, its driver and pickup, and saying it is a retry, listed as of its first try (Eastern)",
			/UL-9101/.test(mail.html) && /Test Driver Una/.test(mail.html) && /10\/05\/2026 08:00/.test(mail.html) && /This is a retry/.test(mail.html)
				&& /listed as of [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M E[DS]T/.test(mail.html), mail.html.slice(0, 600));
		ok("§5 …and the email is stamped", !!led(w.db, "UL-9101").emailed_at);
		await sweepLater(w, "UL-9101");
		const r2 = await attempt(() => w.runUndatedLoadAlerts({ range: RANGE }));
		eq([digestMails(w).length - mails, digestNotes(w).length, r2.digest], [1, 1, 0], "§5 once both went, neither the sweep nor the next weekly run sends again");
	}
	{
		const w = world(freshDb());
		w.ch.mailOk = false;
		await newLoad(w, "UL-9102");
		w.ch.mailOk = true;
		const r = await attempt(() => w.runUndatedLoadAlerts({ range: RANGE }));
		eq([r.digest, digestMails(w).length, digestNotes(w).length], [1, 2, 1], "§5 the next weekly run also retries the owed email, and only the email");
	}
	{
		const w = world(freshDb());
		w.ch.inAppOk = false;
		await newLoad(w, "UL-9103");
		ok("§5 in-app fails and email goes: the load owes the in-app notification", !!led(w.db, "UL-9103").emailed_at && !led(w.db, "UL-9103").notified_at, led(w.db, "UL-9103"));
		w.ch.inAppOk = true;
		await sweepLater(w, "UL-9103");
		const note = digestNotes(w)[0];
		eq([digestMails(w).length, digestNotes(w).length], [1, 1], "§5 in-app fails and email goes: the retry sweep sends only the in-app notification");
		ok("§5 …naming the load", !!note && JSON.parse(note.meta).loadIds.includes("UL-9103"), note);
	}
	{
		const w = world(freshDb());
		await newLoad(w, "UL-9104");
		await sweepLater(w, "UL-9104");
		const r = await attempt(() => w.runUndatedLoadAlerts({ range: RANGE }));
		eq([digestMails(w).length, digestNotes(w).length, r.digest], [1, 1, 0], "§5 both go: nothing is owed; the sweep and the next run send nothing");
	}
	{
		// Loads reported before the change owe nothing: a ledger as the base left it (its baseline
		// taken, UL-9105 reported), before this code first reads it.
		const db = freshDb();
		db.prepare("INSERT INTO server_state (key, value) VALUES ('invoice_undated_alerts_baseline', ?)").run(JSON.stringify({ seededAt: hoursAgo(400) }));
		db.prepare("INSERT INTO invoice_undated_alerts (load_key, driver, first_seen, seeded_at, resolved_at) VALUES ('ul-9000', 'Test Driver Una', ?, ?, ?)").run(hoursAgo(400), hoursAgo(400), hoursAgo(400));
		db.prepare("INSERT INTO invoice_undated_alerts (load_key, driver, first_seen, alerted_at) VALUES ('ul-9105', 'Test Driver Una', ?, ?)").run(hoursAgo(200), hoursAgo(199));
		const w2 = world(db);
		w2.sheet.rows.push(sheetRow("UL-9105"));
		const r = await attempt(() => w2.runUndatedLoadAlerts({ range: RANGE }));
		await attempt(() => w2.retryUndatedLoadAlerts({}));
		eq([r.digest, digestMails(w2).length, digestNotes(w2).length], [0, 0, 0], "§5 a load reported before the change: nothing is re-sent (no re-arm)");
		eq([led(db, "UL-9105").email_skipped, led(db, "UL-9105").notify_skipped], ["before_tracking", "before_tracking"], "§5 …and it is marked before_tracking");
	}
	{
		const w = world(freshDb());
		w.ch.mailOk = false;
		await newLoad(w, "UL-9106");
		const aged = tryRun(w.db, "UPDATE invoice_undated_alerts SET alerted_at = ?, notified_at = ?, first_try = ? WHERE load_key = 'ul-9106'", hoursAgo(49), hoursAgo(49), hoursAgo(49));
		w.ch.mailOk = true;
		await attempt(() => w.retryUndatedLoadAlerts({}));
		ok("§5 the email still undelivered 48 h after the in-app digest: the sweep sends nothing", aged && digestMails(w).length === 1, { aged, mails: digestMails(w).length });
		eq(led(w.db, "UL-9106").email_skipped, "gave_up", "§5 …and the email is given up");
		ok("§5 …with one GAVE UP log line naming the load", w.ch.logs.filter((l) => /GAVE UP/.test(l) && /ul-9106/i.test(l)).length === 1, w.ch.logs);
	}
	{
		// Nothing delivered, first tried 49 h ago: never given up, still retried (the owner's decision).
		const w = world(freshDb());
		w.ch.mailOk = false;
		w.ch.inAppOk = false;
		await newLoad(w, "UL-9109");
		const aged = tryRun(w.db, "UPDATE invoice_undated_alerts SET first_try = ? WHERE load_key = 'ul-9109'", hoursAgo(49));
		w.ch.mailOk = true;
		w.ch.inAppOk = true;
		await sweepLater(w, "UL-9109");
		const row = led(w.db, "UL-9109");
		ok("§5 nothing delivered and first tried 49 h ago: not given up; the sweep sends both channels",
			aged && digestMails(w).length === 2 && digestNotes(w).length === 1 && !row.email_skipped && !row.notify_skipped && !!row.alerted_at, { aged, row });
	}
	for (const [label, env] of [["no GMAIL_USER", { GMAIL_APP_PASSWORD: "app-password-under-test" }], ["GMAIL_USER but no GMAIL_APP_PASSWORD", { GMAIL_USER: "ops@example.test" }]]) {
		const db = freshDb();
		const saved = PROCESS.env;
		PROCESS.env = env;
		let w;
		try { w = world(db); await newLoad(w, "UL-9107"); } finally { PROCESS.env = saved; }
		eq([digestMails(w).length, digestNotes(w).length, led(db, "UL-9107").email_skipped], [0, 1, "no_recipient"], `§5 ${label}: no email, the in-app digest, the email skipped (no_recipient)`);
	}
	{
		// Only the loads a channel that went out carried are told. UL-9111 owes only the in-app
		// notification (its email was skipped: no mailbox then); UL-9112 is new. The email (UL-9112
		// only) goes out, the in-app digest (both) fails.
		const db = freshDb();
		const saved = PROCESS.env;
		PROCESS.env = { GMAIL_USER: "ops@example.test" };
		let w;
		try {
			w = world(db);
			w.ch.inAppOk = false;
			await newLoad(w, "UL-9111");
		} finally { PROCESS.env = saved; }
		const before = led(db, "UL-9111");
		w.sheet.rows.push(sheetRow("UL-9112"));
		const r = await attempt(() => w.runUndatedLoadAlerts({ range: RANGE }));
		const a = led(db, "UL-9111");
		ok("§5 set-up: UL-9111 owes only the in-app notification, told by nothing", before.email_skipped === "no_recipient" && !before.alerted_at, before);
		ok("§5 the email carried only UL-9112", r && r.emailed === true && digestMails(w).length === 1 && /UL-9112/.test(digestMails(w)[0].html) && !/UL-9111/.test(digestMails(w)[0].html), r);
		eq([a.alerted_at, a.notified_at, a.notify_skipped], [null, null, null], "§5 UL-9111, on the in-app list only, whose in-app digest failed: not told, still owes the in-app notification");
		ok("§5 UL-9112, carried by the email: told", !!led(db, "UL-9112").alerted_at && !!led(db, "UL-9112").emailed_at);
	}
	{
		// A load given a date on Job Tracking after the first try is left out of the retry, still owed.
		const w = world(freshDb());
		w.ch.mailOk = false;
		await newLoad(w, "UL-9113");
		w.ch.mailOk = true;
		w.sheet.rows[w.sheet.rows.length - 1] = sheetRow("UL-9113", true);
		await sweepLater(w, "UL-9113");
		const row = led(w.db, "UL-9113");
		eq([digestMails(w).length, row.emailed_at, row.email_skipped, row.resolved_at], [1, null, null, null],
			"§5 a load dated since the first try: the retry leaves it out, and it stays owed and open (only the weekly run resolves)");
		ok("§5 …and the sweep says so", w.ch.logs.some((l) => /1 load\(s\) no longer listed on Job Tracking, left owed/.test(l)), w.ch.logs);
		w.sheet.rows[w.sheet.rows.length - 1] = sheetRow("UL-9113");
		await sweepLater(w, "UL-9113");
		eq(digestMails(w).length, 2, "§5 listed again: the next retry sends its email");
	}
	{
		// The cap is full of loads told today; a retry of a load already told is free, a new one waits.
		const db = freshDb();
		const w = world(db);
		w.ch.mailOk = false;
		await newLoad(w, "UL-9114");
		const ins = db.prepare("INSERT INTO invoice_undated_alerts (load_key, driver, first_seen, alerted_at, resolved_at) VALUES (?, '', ?, ?, ?)");
		for (let i = 0; i < 25; i++) ins.run(`ul-cap-${i}`, hoursAgo(2), hoursAgo(1), hoursAgo(0.5));
		w.ch.mailOk = true;
		await sweepLater(w, "UL-9114");
		eq([digestMails(w).length, !!led(db, "UL-9114").emailed_at], [2, true], "§5 the daily cap is full: the retry of a load already told still goes out (it was counted once)");
		w.sheet.rows.push(sheetRow("UL-9115"));
		const r = await attempt(() => w.runUndatedLoadAlerts({ range: RANGE }));
		eq([r.digest, r.held], [0, 1], "§5 …while a new load waits for a slot");
	}
	{
		// A re-opened load owes both channels again.
		const w = world(freshDb());
		await newLoad(w, "UL-9108");
		w.sheet.rows[w.sheet.rows.length - 1] = sheetRow("UL-9108", true);
		await attempt(() => w.runUndatedLoadAlerts({ range: RANGE }));
		w.sheet.rows[w.sheet.rows.length - 1] = sheetRow("UL-9108");
		const r = await attempt(() => w.runUndatedLoadAlerts({ range: RANGE }));
		eq([r.digest, digestMails(w).length, digestNotes(w).length], [1, 2, 2], "§5 a load that gets a date and loses it again owes both channels again");
	}
}

// ===========================================================================
async function section6() {
	console.log("§6 the shared retry sweep");
	{
		const calls = [];
		const log = makeChannels();
		const f = lift(["sweepAlertChannelRetries"], {
			console: log.console,
			retryRateConExtractAlerts: async ({ now }) => { calls.push(["extract", now instanceof Date]); throw new Error("ledger unreadable (test)"); },
			retryUndatedLoadAlerts: async ({ now }) => { calls.push(["undated", now instanceof Date]); return { tried: 0 }; },
		});
		await attempt(() => f.sweepAlertChannelRetries());
		eq(calls, [["extract", true], ["undated", true]], "§6 the sweep runs both halves, the second after the first failed");
		ok("§6 …and logs the failure", log.logs.some((l) => /retry sweep failed: ledger unreadable/.test(l)), log.logs);
	}
	const start = (env, replica) => {
		const timers = [];
		const log = makeChannels();
		const f = lift(["startAlertChannelRetrySweep"], {
			console: log.console, process: { env }, require: rootRequire,
			REPLICA: replica ? { jobNotStarted: () => false } : null,
			setInterval: (fn, ms) => { const t = { ms, unref() { t.unrefd = true; } }; timers.push(t); return t; },
			sweepAlertChannelRetries: async () => ({}),
		});
		let started;
		try { started = f.startAlertChannelRetrySweep(); } catch (e) { started = e.message; }
		return { started, timers };
	};
	const on = start({}, false);
	ok("§6 started on an unref'd 15-minute timer", on.started === true && on.timers.length === 1 && on.timers[0].ms === 15 * 60000 && on.timers[0].unrefd === true, on);
	const replica = start({}, true);
	ok("§6 a replica starts no sweep", replica.started === false && replica.timers.length === 0, replica);
	const off = start({ RATECON_EXTRACT_ALERT_ENABLED: "false", INVOICE_UNDATED_ALERT_ENABLED: "off" }, false);
	ok("§6 both kill switches off: no sweep", off.started === false && off.timers.length === 0, off);
	const one = start({ RATECON_EXTRACT_ALERT_ENABLED: "false" }, false);
	ok("§6 one kill switch off: the sweep still runs for the other", one.started === true && one.timers.length === 1, one);
}

// ===========================================================================
async function section7() {
	console.log("§7 the daily integrity check: re-issue alerts given up");
	const holdsDdl = ddl("ratecon_reissue_holds");
	const makeDb = ({ holds = true } = {}) => {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE expenses (id INTEGER PRIMARY KEY, date TEXT NOT NULL, amount REAL DEFAULT 10, type TEXT DEFAULT 'Fuel', status TEXT DEFAULT 'Pending',
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP, posted_period TEXT DEFAULT '');
			CREATE TABLE invoices (id INTEGER PRIMARY KEY, invoice_number TEXT, expense_ids TEXT DEFAULT '[]', deleted_at TEXT DEFAULT '');
			CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked', finalized_at TEXT NOT NULL DEFAULT '');
		`);
		if (holds) {
			db.exec(holdsDdl);
			const ins = db.prepare(`INSERT INTO ratecon_reissue_holds (load_id, column_name, sent_value, stored_value, kind, reason, first_seen, alerted_at,
				emailed_at, notified_at, email_skipped, notify_skipped, load_label) VALUES (?, ?, ?, '', 'held', 'delivered', ?, ?, ?, ?, ?, ?, ?)`);
			const t = "2026-10-11T15:00:00.000Z";
			ins.run("rh-5101", "Payment", "$900.00", t, t, null, t, "gave_up", null, "RH-5101");
			ins.run("rh-5101", "Pickup Appointment", "10/02/2026 08:00", t, t, null, t, "gave_up", null, "RH-5101");
			// 10:30 PM Eastern on Oct 11, already Oct 12 in UTC and in Asia.
			const lateEvening = "2026-10-12T02:30:00.000Z";
			ins.run("rh-5102", "Payment", "$700.00", lateEvening, lateEvening, lateEvening, null, null, "gave_up", "RH-5102");
			ins.run("rh-5103", "Payment", "$650.00", t, t, t, t, null, null, "RH-5103");
			// SQLite's UTC "YYYY-MM-DD HH:MM:SS": 4:00 AM Eastern on Oct 12 (Oct 11 if read as local time east of UTC+4).
			ins.run("rh-5104", "Payment", "$640.00", "2026-10-12 08:00:00", t, null, t, "daily_cap", null, "RH-5104");
		}
		return db;
	};
	const jt = async () => ({ headers: ["Load ID", "Pickup Appointment", "Assigned Date"], data: [] });
	const quiet = { log() {}, error() {}, warn() {} };
	const run = (db, now, sent) => ic.runIntegrityCheck({
		db, now, write: true, readJobTracking: jt, to: "admin@example.test", log: quiet,
		sendEmail: async (to, subject, html) => { sent.push({ to, subject, html }); return true; },
		expensePeriodExpr: "COALESCE(NULLIF(posted_period, ''), substr(date, 1, 7))", closedMonthsOf: () => [],
	});
	const db = makeDb();
	const snapshot = () => JSON.stringify(db.prepare("SELECT * FROM ratecon_reissue_holds ORDER BY load_id, column_name").all());
	const before = snapshot();
	const sent = [];
	const r1 = await attempt(() => run(db, new Date("2026-10-14T12:30:00Z"), sent));
	const text = (r1 && r1.report && r1.report.text) || "";
	ok("§7 the report has a section for re-issue alerts given up, counting two loads", /Re-issued rate con alerts given up undelivered \(2\)/.test(text), text);
	ok("§7 it names RH-5101 with both columns and the email, and RH-5102 with the in-app notification",
		/Load RH-5101: .*\(Payment, Pickup Appointment\).*the email never delivered/.test(text) && /Load RH-5102: .*the in-app notification never delivered/.test(text), text);
	ok("§7 the first-seen date is the business day in APP_TIMEZONE (Eastern), whatever the server's zone",
		/Load RH-5102: [^\n]*first seen Oct 11, 2026\./.test(text), text);
	ok("§7 a delivered alert and one capped by the daily limit are not raised", !/RH-5103|RH-5104/.test(text), text);
	ok("§7 the email to ADMIN_NOTIFY_EMAIL carries it", sent.length === 1 && /RH-5101/.test(sent[0].html) && /RH-5102/.test(sent[0].html), sent.length);
	ok("§7 the log line names the loads", !!(r1 && r1.logLine && /re-issue alerts given up undelivered: load RH-5101, RH-5102/.test(r1.logLine)), r1 && r1.logLine);
	eq(snapshot(), before, "§7 it never writes ratecon_reissue_holds");
	const sent2 = [];
	const r2 = await attempt(() => run(db, new Date("2026-10-15T12:30:00Z"), sent2));
	ok("§7 the next day's run does not name them again", !!(r2 && r2.report) && !/RH-510/.test(r2.report.text), r2 && r2.report && r2.report.text);
	db.prepare("UPDATE ratecon_reissue_holds SET email_skipped = 'gave_up' WHERE load_id = 'rh-5104'").run();
	const r3 = await attempt(() => run(db, new Date("2026-10-16T12:30:00Z"), []));
	ok("§7 a row given up later is named on the next run, alone", !!(r3 && r3.report) && /RH-5104/.test(r3.report.text) && !/RH-5101|RH-5102/.test(r3.report.text), r3 && r3.report && r3.report.text);
	ok("§7 a first_seen in SQLite's UTC form is read as UTC (Oct 12 in Eastern), not as the server's local time",
		!!(r3 && r3.report) && /Load RH-5104: [^\n]*first seen Oct 12, 2026\./.test(r3.report.text), r3 && r3.report && r3.report.text);
	const none = await attempt(() => run(makeDb({ holds: false }), new Date("2026-10-14T12:30:00Z"), []));
	ok("§7 a database with no re-issue ledger: no error and no section", !!(none && none.ok) && !/Re-issued rate con/.test(none.report.text), none);
}

(async () => {
	section1();
	await section2();
	await section3();
	await section4();
	await section5();
	await section6();
	await section7();
	console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nPASS: ${pass} checks`);
	process.exit(fail ? 1 : 0);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
