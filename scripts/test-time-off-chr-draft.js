#!/usr/bin/env node
// The note to CHR's contact about a driver's approved days off (plan B PR 5): lib/time-off-chr-draft.js and its
// server.js wiring, behind DRIVER_TIME_OFF_CHR_DRAFT_ENABLED (which folds in DRIVER_TIME_OFF_REQUESTS_ENABLED). The
// note names the driver, the truck and the days; a person sends it from the company Gmail's Drafts.
//
// No test reaches Gmail or a real contact: the two Gmail calls are the availability world's fakes (world.mail, on its
// PROVIDED list), §0 proves the lifted server text holds no require of lib/imap-draft.js, every world's app password
// is "" (a missed fake would stop at "credentials" before any socket), and the recipient is a made-up local part at
// CHR's domain; example.invalid is used only where it must be refused.
//
//   §0 the seam: the routes are served, the lifted text requires no Gmail module, the password is empty
//   §1 the text: subject and body exactly, one day, across a year end, full weekday names; the name once in each
//   §2 the builder's input is exactly { driverName, unit, from, to, todayKey }: any other key, or one missing, throws
//   §3 never in the note: the neighbours' phone, the account, the home time, the kind, the reason, a deny value, the
//      VIN, the plate, the device, the recipient (through the approve route, every one of them set)
//   §4 header safety: a name holding CR/LF and a Bcc gives one Subject and no Bcc header; a non-ASCII name is encoded,
//      not cut; format characters are dropped; a name over 80 characters is refused, never cut
//   §5 each check refuses, with no line: phones, the person shapes, the deny list, load-shaped numbers, an empty name
//   §6 the order: past, then no_truck, then refused, whatever the switch; a line only after the checks
//   §7 the draft switch off (requests on): "off" with the line, no Gmail call, no draft row, the Retry route unknown,
//      the table dropped under the running server and every route still answering; the CREATE runs only when on
//   §8 no recipient (unset, two, gmail.com, example.invalid, a display name, a subdomain): one start-up warning
//      naming the setting, never the value; a good one: the start-up line says set, never what
//   §9 no truck, or a unit CHR's rule refuses: no_truck, no row, no line
//   §10 days already over: past, no row; days started but not over: a draft with the full range
//   §11 timing: the answer comes first with "pending" while the append is held; then "made", or "failed" with its stage
//   §12 the Message-ID is stored, with its own marker, before the first append
//   §13 Retry: found in Drafts or Sent Mail is "made" with no second append; not found, one append with the same
//       Message-ID; 409 on a made row and while in flight; roles; the CSRF header; the limiter; unknown while off
//   §14 one draft row per approval; none for a decline, a driver's cancel or a staff-recorded row
//   §15 a stored home time is in neither the note, the stored row, any answer's line nor any log line
//   §16 later changes on a made draft: cancel and shorten tell staff to tell CHR, with no second append
//   §16b the re-read: with the first append held, a cancel and a move stop both queued drafts (failed, row_changed);
//        Retry answers 409 CHR_DRAFT_ROW_CHANGED; the lines for pending and failed, and the Drivers-page delete's
//   §16c Retry's search failing (or answering in another shape) is failed/search, never "absent", with no append
//   §16d where the state shows: the notice, the panel (only while the switch is on; off, byte for byte today's),
//        canRetry by the server's clock, the staff create's answer (only while requests are on)
//   §17 nothing is ever sent: no send or SMTP name in the module or the wiring; Gmail calls are the two only
//   §18 rule 7's boundary: no lib/chr-*.js requires the note's module
//   §19 the module's own rules: the recipient, the Message-ID, the unit rule (CHR's own), Retry's offer and refusals,
//       the later-change lines, one attempt's order
//
// Made-up data only: driver "Hollis Renner" (the world's) and "A. Example", truck "T-101", home time "Riverton, WY",
// recipient "made-up.agent@chrobinson.com".
// Run: node scripts/test-time-off-chr-draft.js

"use strict";

const fs = require("fs");
const path = require("path");
const W = require("./lib/availability-world");

const R = W.createRunner("test-time-off-chr-draft");
const { ok, eq, section } = R;
const { USERS, DIR, TRUCK } = W;

const libPath = path.join(W.ROOT, "lib", "time-off-chr-draft.js");
const HAS_LIB = fs.existsSync(libPath);
const draft = HAS_LIB ? require(libPath) : null;
const imap = require("../lib/imap-draft");

const TO = "made-up.agent@chrobinson.com";
const DENY = "55501";
const VIN = "1MADEUP0VIN000001";
const PLATE = "MADEUP-01";
const PHONE = "(555) 010-0147";
const ON = {
	DRIVER_TIME_OFF_SCREEN_ENABLED: "true", DRIVER_TIME_OFF_REQUESTS_ENABLED: "true", DRIVER_TIME_OFF_CHR_DRAFT_ENABLED: "true",
	TIME_OFF_CHR_DRAFT_TO: TO, GMAIL_APP_PASSWORD: "", CARRIER_ACCOUNT_NUMBERS_DENY_SECRET: DENY,
};
const LINE = "Driver Hollis Renner, LogisX truck T-101, unavailable Nov 9 – Nov 13";
const NO_DENY = () => false;
const CTX = { draftOn: true, recipientOk: true, staffRecorded: false, denyHits: NO_DENY };
const input = (o = {}) => ({ driverName: "A. Example", unit: "T-101", from: "2026-11-09", to: "2026-11-13", todayKey: "2026-11-04", ...o });
const decide = (o = {}, c = {}) => draft.chrDraftDecision(input(o), { ...CTX, ...c });

// A world with the draft switch on, Hollis's truck T-101 (with a VIN, plate and device), and his Drivers page row
// holding a phone, an email and carrier-style numbers: every neighbour the note must never carry.
async function world(env = {}, opts = {}) {
	const w = await W.startWorld({ ...opts, env: { ...ON, ...env } });
	w.db.prepare("UPDATE trucks SET unit_number = 'T-101', vin = ?, license_plate = ? WHERE id = ?").run(VIN, PLATE, TRUCK.t91);
	w.db.prepare("UPDATE drivers_directory SET phone = ?, cell = '555-010-0148', email = 'hollis.renner@example.invalid', dot = 'DOT-MADE-UP-1', mc = 'MC-MADE-UP-2' WHERE id = ?").run(PHONE, DIR.hollis);
	return w;
}
const ask = (w, from, to, extra = {}) => w.call("POST", "/api/driver/me/availability", { user: USERS.driver, body: { from, to, homeCity: "Riverton", homeState: "WY", ...extra } });
const reqId = (r) => (r.body && r.body.request ? r.body.request.id : null);
const approve = (w, id, user = USERS.disp, opts = {}) => w.call("POST", `/api/driver-availability/${id}/approve`, { user, body: {}, ...opts });
const retry = (w, id, user = USERS.disp, opts = {}) => w.call("POST", `/api/driver-availability/${id}/chr-draft`, { user, body: {}, ...opts });
const draftRow = (w, id) => w.db.prepare("SELECT * FROM time_off_chr_drafts WHERE availability_id = ?").get(id);
const draftCount = (w) => w.db.prepare("SELECT COUNT(*) AS n FROM time_off_chr_drafts").get().n;
const notice = (w, id) => {
	const n = w.db.prepare("SELECT metadata FROM dispatch_notifications WHERE type = 'time-off-request' AND json_extract(metadata, '$.availabilityId') = ?").get(id);
	return n ? JSON.parse(n.metadata) : null;
};
const code = (r) => [r.status, r.body && r.body.code];
const panel = (w, user = USERS.disp) => w.call("GET", `/api/drivers-directory/${DIR.hollis}/availability`, { user });
const panelRow = (p, id) => (p.body && p.body.rows ? p.body.rows.find((x) => x.id === id) : undefined);
// A requested driver row planted as an earlier request left it.
const plant = (w, from, to, { name = "Hollis Renner", dir = DIR.hollis } = {}) => Number(w.db.prepare(`INSERT INTO driver_availability (directory_id, driver_name, kind, from_date,
	to_date, reason, created_by, created_by_user_id, created_at, request_status, source, home_city, home_state) VALUES (?, ?, 'vacation', ?, ?, '', 'drv_hollis', ?, '2026-10-10T12:00:00Z',
	'requested', 'driver', 'Riverton', 'WY')`).run(dir, name, from, to, USERS.driver.id).lastInsertRowid);
// Waits for the queued Gmail step (it runs after the answer), at most two seconds.
async function until(cond) {
	const end = Date.now() + 2000;
	while (!cond()) {
		if (Date.now() > end) return false;
		await new Promise((r) => setTimeout(r, 2));
	}
	return true;
}
const staged = (stage, answered = false) => Object.assign(new Error(`made-up failure at ${stage}`), { stage, ...(answered ? { answered: true } : {}) });
// A fake append that waits until released: { fn, release(value), fail(err), calledWith }.
function held() {
	const h = { calls: 0 };
	h.promise = new Promise((resolve, reject) => { h.release = resolve; h.fail = reject; });
	h.fn = () => { h.calls++; return h.promise; };
	return h;
}
// The answer of an HTTP call, or "timeout" when none came within `ms`.
const within = (p, ms = 3000) => Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), ms))]);
const everything = (w) => [JSON.stringify(w.db.prepare("SELECT * FROM time_off_chr_drafts").all()), JSON.stringify(w.db.prepare("SELECT metadata FROM dispatch_notifications").all()),
	JSON.stringify(w.db.prepare("SELECT details FROM audit_trail").all()), w.logs.join("\n"), w.out.join("\n"), JSON.stringify(w.emits)].join("\n");

// The Subject header of a MIME message, unfolded and with its encoded words decoded.
function subjectOf(mime) {
	const head = mime.toString("latin1").split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
	const lines = head.split("\r\n");
	const subjects = lines.filter((l) => /^subject:/i.test(l));
	const raw = subjects.length ? subjects[0].replace(/^subject:\s*/i, "") : "";
	const words = raw.replace(/\?=\s+=\?/g, "?==?");
	const decoded = words.replace(/=\?utf-8\?([qb])\?([^?]*)\?=/gi, (m, enc, text) => {
		const bytes = enc.toUpperCase() === "B" ? Buffer.from(text, "base64")
			: Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (x, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1");
		return bytes.toString("latin1");
	});
	return { lines, subjects, value: Buffer.from(decoded, "latin1").toString("utf8") };
}

(async () => {
	section("§0 the seam");
	await R.guard("§0", async () => {
		ok("§0.1 lib/time-off-chr-draft.js exists", HAS_LIB);
		const w = await world();
		eq("§0.2 the world serves the Retry route beside the approve route", ["requestApprove", "chrDraftRetry"].filter((k) => w.found.includes(k)), ["requestApprove", "chrDraftRetry"]);
		const { closure } = require("./lib/server-lift");
		const heads = ["requestApprove", "chrDraftRetry", "availabilityCreate", "availabilityEdit", "availabilityCancel", "availabilityList", "directoryDelete"]
			.map((k) => W.routeHead(...W.ROUTES[k])).filter(Boolean);
		const PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "notifyChange", "getJobTrackingCached", "getSheets",
			"SPREADSHEET_ID", "io", "sendEmail", "fs", "DATA_DIR", "fetch", "REPLICA", "driverInstructions", "autoInvoice", "factoringRoutes", "appendGmailDraft", "findDraftByMessageId"];
		const text = closure(W.SRC, { roots: [], routes: heads, provided: PROVIDED, denied: [] }).text;
		ok("§0.3 the lifted server text holds no require of lib/imap-draft.js, so a missed fake can't bind the real Gmail calls", !/require\(["']\.\/lib\/imap-draft["']\)/.test(text));
		ok("§0.4 ...and it does call both Gmail functions by name (the fakes stand in for them)", /\bappendGmailDraft\(/.test(text) && /\bfindDraftByMessageId\(/.test(text));
		ok("§0.5 server.js itself requires them at the top, from lib/imap-draft.js (which the world never runs)", /\nconst \{ appendGmailDraft, findDraftByMessageId \} = require\("\.\/lib\/imap-draft"\);\n/.test(W.SRC));
		eq("§0.6 this runner's worlds hold an empty app password", ON.GMAIL_APP_PASSWORD, "");
	});

	if (!HAS_LIB) {
		ok("the note's module is required for every case below", false);
		await R.finish();
		return;
	}

	section("§1 the text");
	await R.guard("§1", async () => {
		const d = decide();
		eq("§1.1 the subject, the line staff copy", [d.state, d.subject, d.line], ["pending", "Driver A. Example, LogisX truck T-101, unavailable Nov 9 – Nov 13", "Driver A. Example, LogisX truck T-101, unavailable Nov 9 – Nov 13"]);
		eq("§1.2 the body, plain text, greeting nobody", d.text, [
			"Hello,", "",
			"Driver A. Example, LogisX truck T-101, will be unavailable from Monday, Nov 9 through Friday, Nov 13 (planned time off). Available again from Saturday, Nov 14.",
			"", "Thank you,", "LogisX Dispatch"].join("\n"));
		const one = decide({ from: "2026-11-09", to: "2026-11-09" });
		eq("§1.3 one day", [one.subject, one.text.split("\n")[2]], ["Driver A. Example, LogisX truck T-101, unavailable Nov 9",
			"Driver A. Example, LogisX truck T-101, will be unavailable on Monday, Nov 9 (planned time off). Available again from Tuesday, Nov 10."]);
		const year = decide({ from: "2026-12-28", to: "2027-01-03", todayKey: "2026-12-01" });
		eq("§1.4 across a year end", [year.subject, year.text.split("\n")[2]], ["Driver A. Example, LogisX truck T-101, unavailable Dec 28, 2026 – Jan 3, 2027",
			"Driver A. Example, LogisX truck T-101, will be unavailable from Monday, Dec 28, 2026 through Sunday, Jan 3, 2027 (planned time off). Available again from Monday, Jan 4, 2027."]);
		const last = decide({ from: "2026-12-28", to: "2026-12-31", todayKey: "2026-12-01" });
		eq("§1.5 a last day on Dec 31: the years are written, since the day back is in the next year", last.text.split("\n")[2],
			"Driver A. Example, LogisX truck T-101, will be unavailable from Monday, Dec 28, 2026 through Thursday, Dec 31, 2026 (planned time off). Available again from Friday, Jan 1, 2027.");
		const zone = process.env.TZ;
		process.env.TZ = "Pacific/Kiritimati";
		const far = decide();
		process.env.TZ = "America/Los_Angeles";
		const west = decide();
		if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
		eq("§1.6 weekdays in full, from the UTC calendar: the same text under any server zone", [far.text, west.text], [d.text, d.text]);
		const count = (s, part) => s.split(part).length - 1;
		eq("§1.7 the name appears once in the subject and once in the body", [count(d.subject, "A. Example"), count(d.text, "A. Example")], [1, 1]);
	});

	section("§2 the builder's input is exactly five keys");
	await R.guard("§2", async () => {
		eq("§2.0 the keys", draft.INPUT_KEYS, ["driverName", "unit", "from", "to", "todayKey"]);
		const throws = (fn) => { try { fn(); return false; } catch (err) { return err instanceof TypeError; } };
		for (const extra of ["homeCity", "homeState", "city", "kind", "reason", "phone", "row", "username", "email", "vin"]) {
			ok(`§2.1 a "${extra}" key throws`, throws(() => draft.chrDraftDecision({ ...input(), [extra]: "x" }, CTX)));
		}
		ok("§2.2 a missing key throws", throws(() => draft.chrDraftDecision({ driverName: "A. Example", unit: "T-101", from: "2026-11-09", to: "2026-11-13" }, CTX)));
		ok("§2.3 a whole time-off row throws", throws(() => draft.chrDraftDecision({ id: 1, directory_name: "A. Example", from_date: "2026-11-09", to_date: "2026-11-13", kind: "vacation" }, CTX)));
		ok("§2.4 an unknown context key throws too", throws(() => draft.chrDraftDecision(input(), { ...CTX, extra: "x" })));
		ok("§2.5 a context without the deny-list check throws", throws(() => draft.chrDraftDecision(input(), { draftOn: true, recipientOk: true, staffRecorded: false })));
	});

	section("§3 never in the note: the neighbours, through the approve route");
	await R.guard("§3", async () => {
		const w = await world();
		w.db.prepare("UPDATE users SET email = 'drv.hollis@example.invalid' WHERE id = ?").run(USERS.driver.id);
		const id = reqId(await ask(w, "2026-11-09", "2026-11-13", { kind: "vacation" }));
		w.db.prepare("UPDATE driver_availability SET reason = 'Family wedding' WHERE id = ?").run(id);
		const a = await approve(w, id);
		eq("§3.1 approved: pending, then one draft appended", [a.status, a.body && a.body.chrDraft, await until(() => draftRow(w, id).state === "made"), w.mail.appends.length], [200, { state: "pending" }, true, 1]);
		const m = w.mail.appends[0];
		const note = `${m.subject}\n${m.text}`;
		eq("§3.2 the note: the subject and body of §1 for Hollis, to the one recipient, from the default sender, no html, no attachments, no cc or bcc",
			[m.subject, m.to, m.from, m.html, m.attachments, m.cc, m.bcc], [LINE, TO, undefined, undefined, undefined, undefined, undefined]);
		const never = [["his phone", /555|010-0147|0100147/], ["his email", /hollis\.renner@|drv\.hollis@/], ["his account", /drv_hollis/], ["the home time", /Riverton|\bWY\b/],
			["the kind", /vacation/i], ["the reason", /wedding/i], ["a carrier number", /DOT-MADE-UP|MC-MADE-UP|55501/], ["the VIN", /1MADEUP0VIN/], ["the plate", /MADEUP-01/],
			["the device", /vid-91/], ["the recipient", /made-up\.agent|chrobinson/]];
		eq("§3.3 the subject and body carry none of: his phone, email or account, the home time, the kind, the reason, a carrier number, the VIN, the plate, the device, the recipient",
			never.filter(([, re]) => re.test(note)).map(([what]) => what), []);
		ok("§3.4 the recipient is in the To only: never in an answer, the notice, the stored row, an audit row, a log line or a live event",
			!(`${a.text}\n${(await panel(w)).text}\n${everything(w)}`).includes(TO), "the address was found");
	});

	section("§4 header safety");
	await R.guard("§4", async () => {
		const evil = decide({ driverName: "A. Example\r\nBcc: x@example.invalid" });
		eq("§4.1 a name holding CR LF and a Bcc: one subject line, the text kept as text", [evil.state, evil.subject], ["pending", "Driver A. Example Bcc: x@example.invalid, LogisX truck T-101, unavailable Nov 9 – Nov 13"]);
		const mime = await imap.buildMime({ from: "LogisX Inc. <ops@example.invalid>", to: TO, subject: evil.subject, text: evil.text, messageId: "<made-up.time-off-chr@example.invalid>" });
		const s = subjectOf(mime);
		eq("§4.2 ...so the message has one Subject header and no Bcc header", [s.subjects.length, s.lines.filter((l) => /^bcc:/i.test(l)).length, s.value], [1, 0, evil.subject]);
		const accents = decide({ driverName: "Zoë Ångström-Ñúñez" });
		const sm = subjectOf(await imap.buildMime({ from: "LogisX Inc. <ops@example.invalid>", to: TO, subject: accents.subject, text: accents.text, messageId: "<made-up.time-off-chr@example.invalid>" }));
		eq("§4.3 a non-ASCII name is encoded, and decodes to the whole subject (not cut)", [accents.subject, /=\?utf-8\?/i.test(sm.lines.join("\n")), sm.value],
			["Driver Zoë Ångström-Ñúñez, LogisX truck T-101, unavailable Nov 9 – Nov 13", true, "Driver Zoë Ångström-Ñúñez, LogisX truck T-101, unavailable Nov 9 – Nov 13"]);
		eq("§4.4 format characters (bidi, zero width) are dropped; line and paragraph separators, tabs and runs of spaces are one space",
			draft.cleanDriverName("  A.‮ Exa​mple Second Part\tEnd  "), "A. Example Second Part End");
		eq("§4.5 a name over 80 characters is refused, never cut; 80 is kept", [decide({ driverName: "A".repeat(81) }).state, decide({ driverName: "A".repeat(80) }).state], ["refused", "pending"]);
		eq("§4.6 an empty name, or one of spaces and controls only, is refused", [decide({ driverName: "" }).state, decide({ driverName: " \r\n\t​ " }).state, decide({ driverName: null }).state],
			["refused", "refused", "refused"]);
	});

	section("§5 each check refuses, with no line");
	await R.guard("§5", async () => {
		const deny = draft.createDenyCheck(DENY);
		const cases = [
			["a 10-digit phone in the name", { driverName: `A. Example ${PHONE}` }],
			["a 10-digit phone without separators", { driverName: "A. Example 5550100147" }],
			["a phone with dots", { driverName: "A. Example 555.010.0147" }],
			["a + before digits", { driverName: "A. Example +1 555" }],
			["a 7-digit phone in the name", { driverName: "A. Example 555-0100" }],
			["a 7-digit phone split by a space", { driverName: "A. Example 555 0100" }],
			["an SSN shape in the name", { driverName: "A. Example 900-12-3456" }],
			["a date shape in the name", { driverName: "A. Example 11-09-2026" }],
			["a 10-digit unit", { unit: "5550100147" }],
			["a deny-list value as the unit", { unit: "T-55501" }],
			["a 6-digit unit the reconcile sweep reads as a load", { unit: "456789" }],
			["a load-shaped number in the name", { driverName: "A. Example 7891234" }],
			["an empty name after cleaning", { driverName: "​‮" }],
		];
		for (const [label, o] of cases) {
			const d = draft.chrDraftDecision(input(o), { ...CTX, denyHits: deny });
			eq(`§5.1 ${label}: refused, no line`, [d.state, "line" in d, draft.chrDraftAnswer(d)], ["refused", false, { state: "refused" }]);
		}
		eq("§5.1b a person-shaped unit (a 7-digit phone, an SSN or a date inside it) fails CHR's unit rule: no_truck, no line",
			[decide({ unit: "T-555-0100" }), decide({ unit: "900-12-3456" }), decide({ unit: "11-09-2026" })], [{ state: "no_truck" }, { state: "no_truck" }, { state: "no_truck" }]);
		eq("§5.2 a unit the sweep does not read (a 6-digit run it takes for a date) is kept: \"123456\"", decide({ unit: "123456" }).state, "pending");
		const { extractLoadNumbers } = require("../lib/ratecon-reconcile");
		eq("§5.3 the sweep's own extractor finds nothing in a passing note's subject or body", [extractLoadNumbers(decide().subject), extractLoadNumbers(decide().text)], [[], []]);
		const w = await world();
		const before = w.mail.appends.length;
		w.db.prepare("UPDATE trucks SET unit_number = 'T-55501' WHERE id = ?").run(TRUCK.t91);
		const denied = await approve(w, reqId(await ask(w, "2026-11-09", "2026-11-13")));
		w.db.prepare("UPDATE trucks SET unit_number = '456789' WHERE id = ?").run(TRUCK.t91);
		const loadish = await approve(w, reqId(await ask(w, "2026-11-16", "2026-11-17")));
		eq("§5.4 through the approve route, a deny-list unit and a load-shaped unit: refused, no line, no draft row, no Gmail call",
			[denied.body.chrDraft, loadish.body.chrDraft, draftCount(w), w.mail.appends.length - before], [{ state: "refused" }, { state: "refused" }, 0, 0]);
	});

	section("§6 the order");
	await R.guard("§6", async () => {
		const off = { draftOn: false };
		eq("§6.1 the switch off: no truck is no_truck, days over are past, a refused value is refused; never \"off\" with a line",
			[decide({ unit: "" }, off), decide({ to: "2026-11-03", from: "2026-11-01" }, off), decide({ driverName: "A. Example 555-0100" }, off)],
			[{ state: "no_truck" }, { state: "past" }, { state: "refused" }]);
		eq("§6.2 past before no_truck before refused", [decide({ to: "2026-11-03", from: "2026-11-01", unit: "", driverName: "" }).state, decide({ unit: "", driverName: "" }).state], ["past", "no_truck"]);
		eq("§6.3 then by_hand for a staff row, off, no_recipient, pending: each with the line", [
			draft.chrDraftAnswer(decide({}, { staffRecorded: true })), draft.chrDraftAnswer(decide({}, off)), draft.chrDraftAnswer(decide({}, { recipientOk: false })), draft.chrDraftAnswer(decide()),
		], [
			{ state: "by_hand", line: "Driver A. Example, LogisX truck T-101, unavailable Nov 9 – Nov 13" }, { state: "off", line: "Driver A. Example, LogisX truck T-101, unavailable Nov 9 – Nov 13" },
			{ state: "no_recipient", line: "Driver A. Example, LogisX truck T-101, unavailable Nov 9 – Nov 13" }, { state: "pending" },
		]);
		eq("§6.4 a staff row's checks run first: a staff row over a refused name is refused, over days already over is past",
			[decide({ driverName: "A. Example 555-0100" }, { staffRecorded: true }).state, decide({ from: "2026-11-01", to: "2026-11-03" }, { staffRecorded: true }).state], ["refused", "past"]);
		eq("§6.5 days that have started but not ended: the full range", decide({ from: "2026-11-02", to: "2026-11-06" }).subject, "Driver A. Example, LogisX truck T-101, unavailable Nov 2 – Nov 6");
		eq("§6.6 unreadable days are refused", [decide({ from: "2026-13-01" }).state, decide({ todayKey: "" }).state, decide({ from: "2026-11-14" }).state], ["refused", "refused", "refused"]);
	});

	section("§7 the draft switch off, requests on");
	await R.guard("§7", async () => {
		const w = await world({ DRIVER_TIME_OFF_CHR_DRAFT_ENABLED: "" });
		const id = reqId(await ask(w, "2026-11-09", "2026-11-13"));
		const a = await approve(w, id);
		await new Promise((r) => setTimeout(r, 20));
		eq("§7.1 approved: \"off\" with the line, no Gmail call, no draft row", [a.status, a.body.chrDraft, w.mail.appends.length, w.mail.searches.length, draftCount(w)],
			[200, { state: "off", line: LINE }, 0, 0, 0]);
		eq("§7.2 ...the notice carries the same", notice(w, id).chrDraft, { state: "off", line: LINE });
		const base = await w.call("POST", "/api/no-such-route-pr5", { body: {} });
		const r = await retry(w, id);
		ok("§7.3 the Retry route answers like an unknown path", r.status === base.status && r.text === base.text.replace("/api/no-such-route-pr5", `/api/driver-availability/${id}/chr-draft`), `${r.status} ${r.text.slice(0, 80)}`);
		w.db.exec("DROP TABLE time_off_chr_drafts");
		const second = reqId(await ask(w, "2026-11-16", "2026-11-17"));
		const after = [
			(await approve(w, second)).status, (await panel(w)).status,
			(await w.call("PUT", `/api/driver-availability/${id}`, { user: USERS.disp, body: { to: "2026-11-11" } })).status,
			(await w.call("POST", `/api/driver-availability/${id}/cancel`, { user: USERS.disp, body: {} })).status,
			(await w.call("POST", `/api/drivers-directory/${DIR.soren}/availability`, { user: USERS.sa, body: { kind: "vacation", from: "2026-12-01", to: "2026-12-02" } })).status,
			(await w.call("DELETE", `/api/drivers-directory/${DIR.hollis}`, { user: USERS.sa })).status,
		];
		eq("§7.4 the table dropped under the running server: approve, the panel, an edit, a cancel, a staff create and the directory delete all still answer",
			after, [200, 200, 200, 200, 201, 200]);
		ok("§7.5 ...and nothing logged a missing table", !w.logs.some((l) => /time_off_chr_drafts|no such table/i.test(l)), w.logs.join(" | ").slice(0, 200));
		const created = /\nif \(DRIVER_TIME_OFF_CHR_DRAFT_ENABLED\) \{\n(?:\t[^\n]*\n|\n)*?\tdb\.exec\(`\n\t\tCREATE TABLE IF NOT EXISTS time_off_chr_drafts \(/.test(W.SRC);
		eq("§7.6 the table is created only inside if (DRIVER_TIME_OFF_CHR_DRAFT_ENABLED) {, and nowhere else", [created, W.SRC.split("CREATE TABLE IF NOT EXISTS time_off_chr_drafts").length - 1], [true, 1]);
		eq("§7.7 the start-up line says OFF", w.out.filter((l) => l.includes("CHR day-off drafts")), ["[availability] CHR day-off drafts OFF (DRIVER_TIME_OFF_CHR_DRAFT_ENABLED)"]);
	});

	section("§8 no recipient");
	await R.guard("§8", async () => {
		for (const [label, to] of [["unset", undefined], ["two addresses", "made-up.agent@chrobinson.com, other.agent@chrobinson.com"], ["a gmail.com address", "made-up.agent@gmail.com"],
			["the example.invalid one", "dayoff@example.invalid"], ["a display name", "CHR Agent <made-up.agent@chrobinson.com>"], ["a subdomain", "made-up.agent@mail.chrobinson.com"],
			["a lookalike domain", "made-up.agent@notchrobinson.com"]]) {
			const w = await world({ TIME_OFF_CHR_DRAFT_TO: to });
			const id = reqId(await ask(w, "2026-11-09", "2026-11-13"));
			const a = await approve(w, id);
			await new Promise((r) => setTimeout(r, 10));
			const warnings = w.logs.filter((l) => l.includes("TIME_OFF_CHR_DRAFT_TO"));
			eq(`§8.1 ${label}: no_recipient with the line, no Gmail call, no draft row; one start-up warning naming the setting, never the value`,
				[a.body.chrDraft, w.mail.appends.length, draftCount(w), warnings.length, !!to && w.logs.concat(w.out).some((l) => l.includes(to))],
				[{ state: "no_recipient", line: LINE }, 0, 0, 1, false]);
			eq(`§8.2 ${label}: the start-up line says ON and not set`, w.out.filter((l) => l.includes("CHR day-off drafts")), ["[availability] CHR day-off drafts ON (DRIVER_TIME_OFF_CHR_DRAFT_ENABLED), address: not set"]);
		}
		const good = await world();
		eq("§8.3 a good address: the start-up line says set, chrobinson.com (never the address), and no warning",
			[good.out.filter((l) => l.includes("CHR day-off drafts")), good.logs.filter((l) => l.includes("TIME_OFF_CHR_DRAFT_TO")).length],
			[["[availability] CHR day-off drafts ON (DRIVER_TIME_OFF_CHR_DRAFT_ENABLED), address: set, chrobinson.com"], 0]);
	});

	section("§9 no truck");
	await R.guard("§9", async () => {
		const w = await world();
		w.db.prepare("UPDATE trucks SET unit_number = 'LogisX-#91' WHERE id = ?").run(TRUCK.t91);
		const a = await approve(w, reqId(await ask(w, "2026-11-09", "2026-11-13")));
		w.db.prepare("DELETE FROM truck_assignments").run();
		w.db.prepare("UPDATE trucks SET assigned_driver = '' ").run();
		const b = await approve(w, reqId(await ask(w, "2026-11-16", "2026-11-17")));
		await new Promise((r) => setTimeout(r, 10));
		eq("§9.1 a unit CHR's rule refuses (\"LogisX-#91\"), and no truck at all: no_truck, no line, no draft row, no Gmail call",
			[a.body.chrDraft, b.body.chrDraft, draftCount(w), w.mail.appends.length], [{ state: "no_truck" }, { state: "no_truck" }, 0, 0]);
		const n = await world();
		n.db.prepare("DELETE FROM truck_assignments").run();
		const c = await approve(n, reqId(await ask(n, "2026-11-09", "2026-11-13")));
		await until(() => n.mail.appends.length === 1);
		eq("§9.2 no active assignment: the truck that names him (T-101)", [c.body.chrDraft, n.mail.appends.map((m) => m.subject)], [{ state: "pending" }, [LINE]]);
		eq("§9.3 the first truck found decides: an assignment's bad unit is no truck, never another truck's", draft.chooseTruckUnit([{ unit_number: "LogisX-#9" }, { unit_number: "T-101" }]), "LogisX-#9");
	});

	section("§10 days already over");
	await R.guard("§10", async () => {
		const w = await world();
		const over = plant(w, "2026-10-01", "2026-10-03");
		const a = await approve(w, over);
		const started = plant(w, "2026-10-14", "2026-10-16");
		const b = await approve(w, started);
		await until(() => w.mail.appends.length === 1);
		eq("§10.1 a request whose days are over: past, no row; one that started yesterday: a draft with its full range",
			[a.body.chrDraft, draftRow(w, over), b.body.chrDraft, w.mail.appends.map((m) => m.subject)],
			[{ state: "past" }, undefined, { state: "pending" }, ["Driver Hollis Renner, LogisX truck T-101, unavailable Oct 14 – Oct 16"]]);
	});

	section("§11 timing");
	await R.guard("§11", async () => {
		const w = await world();
		const h = held();
		w.mail.onAppend = h.fn;
		const id = reqId(await ask(w, "2026-11-09", "2026-11-13"));
		const a = await within(approve(w, id));
		if (a === "timeout") h.release({ ok: true });
		const reached = await until(() => h.calls === 1);
		const stored = w.db.prepare("SELECT request_status FROM driver_availability WHERE id = ?").get(id).request_status;
		eq("§11.1 the answer arrives while the append is held: pending; the approval is committed; the append was reached after it",
			[a === "timeout" ? "timeout" : a.body.chrDraft, stored, reached, draftRow(w, id).state], [{ state: "pending" }, "approved", true, "pending"]);
		h.release({ ok: true, bytes: 10, mailbox: "[Gmail]/Drafts" });
		await until(() => draftRow(w, id).state !== "pending");
		const row = draftRow(w, id);
		eq("§11.2 released: made, one attempt, its day; the live event to the dispatch room only; the notice says made",
			[row.state, row.attempts, row.last_stage, !!row.drafted_at, w.emits.filter((e) => e.event === "time-off-chr-draft").map((e) => [e.room, e.payload]), notice(w, id).chrDraft],
			["made", 1, "", true, [["dispatch", { availabilityId: id, state: "made" }]], { state: "made" }]);
		const f = await world();
		const fh = held();
		f.mail.onAppend = fh.fn;
		const fid = reqId(await ask(f, "2026-11-09", "2026-11-13"));
		const fa = await within(approve(f, fid));
		fh.fail(staged("login", true));
		await until(() => draftRow(f, fid).state !== "pending");
		eq("§11.3 a failure after the answer: the approval stands, the draft reads failed at its stage, the event and the notice say so (with the line)",
			[fa === "timeout" ? "timeout" : fa.body.chrDraft, f.db.prepare("SELECT request_status FROM driver_availability WHERE id = ?").get(fid).request_status,
				[draftRow(f, fid).state, draftRow(f, fid).last_stage, draftRow(f, fid).attempts], f.emits.filter((e) => e.event === "time-off-chr-draft").map((e) => e.payload), notice(f, fid).chrDraft],
			[{ state: "pending" }, "approved", ["failed", "login", 1], [{ availabilityId: fid, state: "failed" }], { state: "failed", line: LINE }]);
		ok("§11.4 ...its log line names the stage, never the error's text or the address", f.logs.some((l) => /not drafted \(stage login\)/.test(l)) && !f.logs.some((l) => /made-up failure|chrobinson/.test(l)), f.logs.join(" | "));
		const t = await world();
		t.mail.onAppend = () => { throw staged("greeting"); };
		const tid = reqId(await ask(t, "2026-11-09", "2026-11-13"));
		await approve(t, tid);
		await until(() => draftRow(t, tid).state !== "pending");
		eq("§11.5 an append that throws at once is caught too: failed at its stage", [draftRow(t, tid).state, draftRow(t, tid).last_stage], ["failed", "greeting"]);
	});

	section("§12 the Message-ID first");
	await R.guard("§12", async () => {
		const w = await world();
		const seen = [];
		w.mail.onAppend = (opts) => { seen.push([opts.messageId, draftRow(w, id) && draftRow(w, id).message_id]); return { ok: true }; };
		const id = reqId(await ask(w, "2026-11-09", "2026-11-13"));
		await approve(w, id);
		await until(() => seen.length === 1);
		const [given, storedBefore] = seen[0] || [];
		eq("§12.1 the draft row held the Message-ID before the first append, and the append used it", [!!given, given === storedBefore], [true, true]);
		ok("§12.2 ...in the shape lib/imap-draft.js takes, with its own marker (never .auto-invoice), on the mailbox's domain",
			imap.MESSAGE_ID_RE.test(given) && /\.time-off-chr@example\.invalid>$/.test(given) && !/auto-invoice/.test(given), given);
	});

	section("§13 Retry");
	await R.guard("§13", async () => {
		const literal = async (onSearch) => {
			const w = await world();
			w.mail.onAppend = () => { throw staged("literal"); };
			const id = reqId(await ask(w, "2026-11-09", "2026-11-13"));
			await approve(w, id);
			await until(() => draftRow(w, id).state === "failed");
			w.mail.onAppend = null;
			w.mail.onSearch = onSearch;
			return { w, id, r: await retry(w, id) };
		};
		const inDrafts = await literal(() => ({ found: true, count: 1, mailbox: "[Gmail]/Drafts" }));
		eq("§13.1 after a \"literal\" failure with no answer, the draft found in Drafts: made, no second append, searched by the stored Message-ID",
			[inDrafts.r.status, inDrafts.r.body.chrDraft.state, draftRow(inDrafts.w, inDrafts.id).state, inDrafts.w.mail.appends.length, inDrafts.w.mail.searches.map((s) => s.messageId)],
			[200, "made", "made", 1, [draftRow(inDrafts.w, inDrafts.id).message_id]]);
		const sent = await literal(() => ({ found: true, count: 1, mailbox: "[Gmail]/Sent Mail" }));
		eq("§13.2 found in Sent Mail: made, no second append", [sent.r.body.chrDraft.state, sent.w.mail.appends.length], ["made", 1]);
		ok("§13.2b ...audited as found, never with the address", sent.w.audits("time_off_chr_draft_retry").some((a) => /retried: made \(found in \[Gmail\]\/Sent Mail\)/.test(a.details) && !a.details.includes(TO)));
		const none = await literal(() => ({ found: false, count: 0, mailbox: "" }));
		eq("§13.3 not found: exactly one more append, with the same Message-ID; made",
			[none.r.body.chrDraft.state, none.w.mail.appends.length, none.w.mail.appends[1] && none.w.mail.appends[1].messageId === none.w.mail.appends[0].messageId, draftRow(none.w, none.id).attempts],
			["made", 2, true, 2]);
		eq("§13.4 a made row: 409 CHR_DRAFT_MADE, no search, no append", [code(await retry(none.w, none.id)), none.w.mail.searches.length, none.w.mail.appends.length],
			[[409, "CHR_DRAFT_MADE"], 1, 2]);
		const fly = await world();
		fly.mail.onAppend = () => { throw staged("append", true); };
		const fid = reqId(await ask(fly, "2026-11-09", "2026-11-13"));
		await approve(fly, fid);
		await until(() => draftRow(fly, fid).state === "failed");
		const h = held();
		fly.mail.onAppend = h.fn;
		const first = retry(fly, fid);
		await until(() => h.calls === 1);
		const second = await retry(fly, fid);
		eq("§13.5 while a Retry runs, another: 409 CHR_DRAFT_IN_FLIGHT", code(second), [409, "CHR_DRAFT_IN_FLIGHT"]);
		h.release({ ok: true });
		eq("§13.6 ...the first ends made", (await first).body.chrDraft.state, "made");
		const roleRefused = (r) => r.status === 403 && r.text === JSON.stringify({ error: "Forbidden" });
		eq("§13.7 Driver and Investor: 403 from the role check; signed out 401; no CSRF header 403",
			[roleRefused(await retry(fly, fid, USERS.driver)), roleRefused(await retry(fly, fid, USERS.inv)), (await retry(fly, fid, null)).status, code(await retry(fly, fid, USERS.disp, { csrf: false }))],
			[true, true, 401, [403, "CSRF_HEADER_REQUIRED"]]);
		eq("§13.8 a Super Admin may retry too; an unknown id or a row with no draft is 404",
			[code(await retry(fly, fid, USERS.sa)), code(await retry(fly, 9999)), code(await retry(fly, reqId(await ask(fly, "2026-12-07", "2026-12-08"))))],
			[[409, "CHR_DRAFT_MADE"], [404, "CHR_DRAFT_NOT_FOUND"], [404, "CHR_DRAFT_NOT_FOUND"]]);
		const lim = await world();
		const statuses = [];
		for (let i = 0; i < 21; i++) statuses.push((await retry(lim, 9999)).status);
		eq("§13.9 the limiter: 20 tries in the window answer, the 21st is 429; per account", [statuses.slice(0, 20).every((s) => s === 404), statuses[20], (await retry(lim, 9999, USERS.sa)).status],
			[true, 429, 404]);
		const off = await world({ DRIVER_TIME_OFF_CHR_DRAFT_ENABLED: "" });
		const base = await off.call("POST", "/api/no-such-route-pr5", { body: {} });
		const offAnswers = [];
		for (const user of [USERS.sa, USERS.disp, USERS.driver, null]) offAnswers.push(await retry(off, 1, user));
		ok("§13.10 the switch off: the Retry route answers like an unknown path, for every role and signed out",
			offAnswers.every((r) => r.status === base.status && r.text === base.text.replace("/api/no-such-route-pr5", "/api/driver-availability/1/chr-draft")));
	});

	section("§14 one draft row per approval, and none otherwise");
	await R.guard("§14", async () => {
		const w = await world();
		const id = reqId(await ask(w, "2026-11-09", "2026-11-13"));
		await approve(w, id);
		const again = await approve(w, id, USERS.sa);
		await until(() => w.mail.appends.length === 1);
		eq("§14.1 a second approve: 409 TIME_OFF_REQUEST_DECIDED, still one draft row and one append", [code(again), draftCount(w), w.mail.appends.length], [[409, "TIME_OFF_REQUEST_DECIDED"], 1, 1]);
		const d = reqId(await ask(w, "2026-11-16", "2026-11-17"));
		await w.call("POST", `/api/driver-availability/${d}/decline`, { user: USERS.disp, body: {} });
		const c = reqId(await ask(w, "2026-11-23", "2026-11-24"));
		await w.call("POST", `/api/driver/me/availability/${c}/cancel`, { user: USERS.driver, body: {} });
		const s = await w.call("POST", `/api/drivers-directory/${DIR.hollis}/availability`, { user: USERS.sa, body: { kind: "vacation", from: "2026-12-01", to: "2026-12-02" } });
		await new Promise((r) => setTimeout(r, 10));
		eq("§14.2 a decline, a driver's cancel and a staff-recorded row: no draft row, no Gmail call; the staff row's answer is by_hand",
			[draftRow(w, d), draftRow(w, c), draftRow(w, s.body.row.id), w.mail.appends.length, s.body.chrDraft],
			[undefined, undefined, undefined, 1, { state: "by_hand", line: "Driver Hollis Renner, LogisX truck T-101, unavailable Dec 1 – Dec 2" }]);
	});

	section("§15 the home time never reaches the note");
	await R.guard("§15", async () => {
		const w = await world();
		const id = reqId(await ask(w, "2026-11-09", "2026-11-13"));
		eq("§15.0 the request holds a home time", [w.db.prepare("SELECT home_city, home_state FROM driver_availability WHERE id = ?").get(id)], [{ home_city: "Riverton", home_state: "WY" }]);
		const a = await approve(w, id);
		await until(() => draftRow(w, id).state === "made");
		const m = w.mail.appends[0] || {};
		const place = /Riverton|\bWY\b/;
		eq("§15.1 the city and the state are in neither the note, the stored draft row, the answer, the notice's chrDraft, nor any log line",
			[place.test(`${m.subject}${m.text}`), place.test(JSON.stringify(draftRow(w, id))), place.test(JSON.stringify(a.body.chrDraft)), place.test(JSON.stringify(notice(w, id).chrDraft)),
				w.logs.concat(w.out).some((l) => place.test(l))], [false, false, false, false, false]);
		eq("§15.2 (the staff notice's own body still says where he needs to be, as H1 built it)", /Home time: Riverton, WY\./.test(w.db.prepare("SELECT body FROM dispatch_notifications WHERE type = 'time-off-request'").get().body), true);
		const off = await world({ DRIVER_TIME_OFF_CHR_DRAFT_ENABLED: "" });
		const oid = reqId(await ask(off, "2026-11-09", "2026-11-13"));
		eq("§15.3 the switch off: the line to copy carries no home time either", place.test((await approve(off, oid)).body.chrDraft.line), false);
	});

	section("§16 later changes on a made draft");
	await R.guard("§16", async () => {
		const w = await world();
		const a = reqId(await ask(w, "2026-11-09", "2026-11-13"));
		const b = reqId(await ask(w, "2026-11-16", "2026-11-20"));
		await approve(w, a);
		await approve(w, b);
		await until(() => draftRow(w, a).state === "made" && draftRow(w, b).state === "made");
		const cancel = await w.call("POST", `/api/driver-availability/${a}/cancel`, { user: USERS.disp, body: {} });
		eq("§16.1 staff cancel a row whose draft is made: the answer tells them to tell CHR, naming the day it was drafted",
			[cancel.status, cancel.body.chrDraftChange], [200, { state: "made", note: "CHR's contact was drafted about these days on Oct 15: tell them about this change." }]);
		const shorten = await w.call("PUT", `/api/driver-availability/${b}`, { user: USERS.disp, body: { to: "2026-11-18" } });
		eq("§16.2 staff shorten one: the same line, and the new days' line to send by hand",
			shorten.body.chrDraftChange, { state: "made", note: "CHR's contact was drafted about these days on Oct 15: tell them about this change.", newDays: { state: "by_hand", line: "Driver Hollis Renner, LogisX truck T-101, unavailable Nov 16 – Nov 18" } });
		const reason = await w.call("PUT", `/api/driver-availability/${b}`, { user: USERS.sa, body: { reason: "Family" } });
		eq("§16.3 a reason-only edit says nothing to CHR; no second append anywhere", ["chrDraftChange" in reason.body, w.mail.appends.length], [false, 2]);
	});

	section("§16b the re-read before every append");
	await R.guard("§16b", async () => {
		const w = await world();
		const h = held();
		w.mail.onAppend = h.fn;
		const x = reqId(await ask(w, "2026-11-02", "2026-11-03"));
		const a = reqId(await ask(w, "2026-11-09", "2026-11-10"));
		const b = reqId(await ask(w, "2026-11-16", "2026-11-17"));
		await approve(w, x);
		await until(() => h.calls === 1);
		await approve(w, a);
		await approve(w, b);
		const cancel = await w.call("POST", `/api/driver-availability/${a}/cancel`, { user: USERS.disp, body: {} });
		const move = await w.call("PUT", `/api/driver-availability/${b}`, { user: USERS.disp, body: { from: "2026-11-18", to: "2026-11-19" } });
		const pendingNote = "A note to CHR's contact about the old days may be in Gmail Drafts: check it before sending anything, and tell them about this change if it went out.";
		eq("§16b.1 a cancel and a move while their drafts wait: the \"may be in Gmail Drafts\" line; the move also gives the new days' line",
			[cancel.body.chrDraftChange, move.body.chrDraftChange],
			[{ state: "pending", note: pendingNote }, { state: "pending", note: pendingNote, newDays: { state: "by_hand", line: "Driver Hollis Renner, LogisX truck T-101, unavailable Nov 18 – Nov 19" } }]);
		w.mail.onAppend = null;
		h.release({ ok: true });
		await until(() => draftRow(w, a).state !== "pending" && draftRow(w, b).state !== "pending");
		eq("§16b.2 released: the held one made; neither changed row appended; each failed at row_changed",
			[draftRow(w, x).state, w.mail.appends.length, [draftRow(w, a).state, draftRow(w, a).last_stage, draftRow(w, a).attempts], [draftRow(w, b).state, draftRow(w, b).last_stage]],
			["made", 1, ["failed", "row_changed", 0], ["failed", "row_changed"]]);
		eq("§16b.3 Retry on them: 409 CHR_DRAFT_ROW_CHANGED, with no search and no append", [code(await retry(w, a)), code(await retry(w, b)), w.mail.searches.length, w.mail.appends.length],
			[[409, "CHR_DRAFT_ROW_CHANGED"], [409, "CHR_DRAFT_ROW_CHANGED"], 0, 1]);
		eq("§16b.4 the panel offers no Retry on them, and no line to copy", [panelRow(await panel(w), a).chrDraft, panelRow(await panel(w), b).chrDraft],
			[{ state: "failed", canRetry: false }, { state: "failed", canRetry: false }]);
		const f = await world();
		f.mail.onAppend = () => { throw staged("literal"); };
		const c = reqId(await ask(f, "2026-11-09", "2026-11-10"));
		await approve(f, c);
		await until(() => draftRow(f, c).state === "failed");
		eq("§16b.5 a cancel while the draft is failed: the \"may be in Gmail Drafts\" line", (await f.call("POST", `/api/driver-availability/${c}/cancel`, { user: USERS.disp, body: {} })).body.chrDraftChange,
			{ state: "failed", note: pendingNote });
		const d = await world();
		const keep = reqId(await ask(d, "2026-11-09", "2026-11-10"));
		await approve(d, keep);
		await until(() => draftRow(d, keep).state === "made");
		d.mail.onAppend = () => { throw staged("literal"); };
		const lost = reqId(await ask(d, "2026-11-16", "2026-11-17"));
		await approve(d, lost);
		await until(() => draftRow(d, lost).state === "failed");
		const del = await d.call("DELETE", `/api/drivers-directory/${DIR.hollis}`, { user: USERS.sa });
		eq("§16b.6 the Drivers-page delete: each live row with a draft gets its line",
			[del.status, del.body.chrDraftChanges], [200, [{ availabilityId: keep, state: "made", note: "CHR's contact was drafted about these days on Oct 15: tell them about this change." },
				{ availabilityId: lost, state: "failed", note: pendingNote }]]);
		eq("§16b.7 ...and no draft is appended for them afterwards", [d.mail.appends.length, code(await retry(d, lost))], [2, [404, "CHR_DRAFT_NOT_FOUND"]]);
	});

	section("§16c Retry's search failing");
	await R.guard("§16c", async () => {
		for (const [label, onSearch] of [["a search that fails at \"search\"", () => { throw staged("search", true); }], ["one that fails at \"login\"", () => { throw staged("login", true); }],
			["an answer without found", () => ({ count: 0 })], ["no answer", () => null]]) {
			const w = await world();
			w.mail.onAppend = () => { throw staged("literal"); };
			const id = reqId(await ask(w, "2026-11-09", "2026-11-13"));
			await approve(w, id);
			await until(() => draftRow(w, id).state === "failed");
			w.mail.onAppend = null;
			w.mail.onSearch = onSearch;
			const r = await retry(w, id);
			eq(`§16c.1 ${label}: failed at "search", never read as absent: no append; Retry still offered`,
				[r.status, r.body.chrDraft && r.body.chrDraft.state, draftRow(w, id).last_stage, w.mail.appends.length, r.body.chrDraft && r.body.chrDraft.canRetry], [200, "failed", "search", 1, true]);
		}
	});

	section("§16d where the state shows");
	await R.guard("§16d", async () => {
		const w = await world();
		const h = held();
		w.mail.onAppend = h.fn;
		const id = reqId(await ask(w, "2026-11-09", "2026-11-13"));
		await approve(w, id);
		eq("§16d.1 the notice after the approval: pending", notice(w, id).chrDraft, { state: "pending" });
		h.fail(staged("literal"));
		await until(() => draftRow(w, id).state === "failed");
		eq("§16d.2 ...after the Gmail step: failed, with the line", notice(w, id).chrDraft, { state: "failed", line: LINE });
		eq("§16d.3 the panel row: failed, the line, Retry offered", panelRow(await panel(w), id).chrDraft, { state: "failed", line: LINE, canRetry: true });
		w.mail.onAppend = null;
		await retry(w, id);
		eq("§16d.4 retried: made, the day it was drafted, no Retry", [panelRow(await panel(w), id).chrDraft, notice(w, id).chrDraft], [{ state: "made", canRetry: false, draftedOn: "2026-10-15" }, { state: "made" }]);
		const p = await world();
		const ph = held();
		p.mail.onAppend = ph.fn;
		const pid = reqId(await ask(p, "2026-11-09", "2026-11-13"));
		await approve(p, pid);
		p.db.prepare("UPDATE time_off_chr_drafts SET created_at = ? WHERE availability_id = ?").run(new Date(p.clock.ms - 9 * 60000).toISOString(), pid);
		const young = panelRow(await panel(p), pid).chrDraft;
		p.db.prepare("UPDATE time_off_chr_drafts SET created_at = ? WHERE availability_id = ?").run(new Date(p.clock.ms - 11 * 60000).toISOString(), pid);
		const old = panelRow(await panel(p), pid).chrDraft;
		eq("§16d.5 canRetry by the server's clock: a pending row 9 minutes old offers none, 11 minutes old offers it", [young, old], [{ state: "pending", canRetry: false }, { state: "pending", canRetry: true }]);
		eq("§16d.6 ...but its own step still runs: a Retry meanwhile is 409 CHR_DRAFT_IN_FLIGHT", code(await retry(p, pid)), [409, "CHR_DRAFT_IN_FLIGHT"]);
		ph.release({ ok: true });
		await until(() => draftRow(p, pid).state === "made");
		const k = await world();
		const kid = reqId(await ask(k, "2026-11-09", "2026-11-13"));
		k.db.prepare("UPDATE driver_availability SET request_status = 'approved', decided_by = 'dispatch_t', decided_at = '2026-10-15T12:00:00Z' WHERE id = ?").run(kid);
		k.db.prepare("INSERT INTO time_off_chr_drafts (availability_id, message_id, unit, from_day, to_day, state, created_at) VALUES (?, '<made-up.time-off-chr@example.invalid>', 'T-101', '2026-11-09', '2026-11-13', 'pending', ?)")
			.run(kid, new Date(k.clock.ms - 30 * 60000).toISOString());
		eq("§16d.7 a pending row left by a restart (none in flight), 30 minutes old: Retry offered and it drafts", [panelRow(await panel(k), kid).chrDraft.canRetry, (await retry(k, kid)).body.chrDraft.state, k.mail.searches.length, k.mail.appends.length],
			[true, "made", 1, 1]);
		const on = await panel(w);
		const off = await W.startWorld({ env: { ...ON, DRIVER_TIME_OFF_CHR_DRAFT_ENABLED: "" } });
		for (const sql of w.db.prepare("SELECT * FROM driver_availability ORDER BY id").all().map((r) => r)) {
			off.db.prepare(`INSERT INTO driver_availability (${Object.keys(sql).join(", ")}) VALUES (${Object.keys(sql).map(() => "?").join(", ")})`).run(...Object.values(sql));
		}
		off.db.prepare("INSERT INTO time_off_chr_drafts (availability_id, message_id, unit, from_day, to_day, state, created_at, drafted_at) VALUES (?, '<made-up.time-off-chr@example.invalid>', 'T-101', '2026-11-09', '2026-11-13', 'made', '2026-10-15T16:00:00.000Z', '2026-10-15T16:00:00.000Z')").run(id);
		const offPanel = await panel(off);
		const offTwin = await W.startWorld({ env: { ...ON, DRIVER_TIME_OFF_CHR_DRAFT_ENABLED: "" } });
		for (const sql of w.db.prepare("SELECT * FROM driver_availability ORDER BY id").all().map((r) => r)) {
			offTwin.db.prepare(`INSERT INTO driver_availability (${Object.keys(sql).join(", ")}) VALUES (${Object.keys(sql).map(() => "?").join(", ")})`).run(...Object.values(sql));
		}
		const twinPanel = await panel(offTwin);
		eq("§16d.8 the panel carries chrDraft only while the switch is on; off, a draft row changes the answer by not one byte",
			[panelRow(on, id).chrDraft.state, offPanel.body.rows.some((r) => "chrDraft" in r), offPanel.text === twinPanel.text], ["made", false, true]);
		const create = (ww) => ww.call("POST", `/api/drivers-directory/${DIR.hollis}/availability`, { user: USERS.sa, body: { kind: "vacation", from: "2026-12-07", to: "2026-12-08" } });
		const reqOff = await W.startWorld({ env: { DRIVER_TIME_OFF_SCREEN_ENABLED: "true", GMAIL_APP_PASSWORD: "" } });
		reqOff.db.prepare("UPDATE trucks SET unit_number = 'T-101' WHERE id = ?").run(TRUCK.t91);
		const pastRow = await w.call("POST", `/api/drivers-directory/${DIR.hollis}/availability`, { user: USERS.sa, body: { kind: "off_duty", from: "2026-10-12", to: "2026-10-13" } });
		eq("§16d.9 the staff create's answer: by_hand (or past) while requests are on; no chrDraft key while they're off",
			[(await create(w)).body.chrDraft, pastRow.body.chrDraft, Object.keys((await create(reqOff)).body).sort()],
			[{ state: "by_hand", line: "Driver Hollis Renner, LogisX truck T-101, unavailable Dec 7 – Dec 8" }, { state: "past" }, ["row", "success"]]);
	});

	section("§17 nothing is ever sent");
	await R.guard("§17", async () => {
		const lib = fs.readFileSync(libPath, "utf8");
		const SEND_RE = /\b(?:sendMail|sendEmail|createTransport|transporter|nodemailer)\b|smtp/i;
		const isHead = (l) => /^[^\s}\])`/]/.test(l);
		const statements = [];
		for (const l of W.SRC.split("\n")) {
			if (isHead(l)) statements.push({ head: l, lines: [l] });
			else if (statements.length) statements[statements.length - 1].lines.push(l);
		}
		const wiring = statements.filter((s) => /ChrDraft|CHR_DRAFT|chr-draft/.test(s.head)).map((s) => s.lines.join("\n").replace(/^\s*\/\/[^\n]*$/gm, ""));
		ok("§17.1 the wiring is found (the switch, the helpers, the Retry route)", wiring.length >= 10, String(wiring.length));
		eq("§17.2 neither the module nor the wiring names a send, a transport or SMTP", [SEND_RE.test(lib.replace(/^\s*\/\/[^\n]*$/gm, "")), wiring.filter((t) => SEND_RE.test(t)).length], [false, 0]);
		const calls = new Set();
		for (const t of wiring) for (const m of t.matchAll(/\b(appendGmailDraft|findDraftByMessageId|fetchMessages|buildMime|tls\.connect|sendEmail|sendMail)\(/g)) calls.add(m[1]);
		eq("§17.3 the only mail calls are appendGmailDraft and findDraftByMessageId", [...calls].sort(), ["appendGmailDraft", "findDraftByMessageId"]);
		ok("§17.4 the module itself opens nothing: no network, file or database module, no process", !/require\(["'](?:https?|net|tls|fs|better-sqlite3|child_process|\.\/imap-draft)["']\)|\bprocess\b/.test(lib));
	});

	section("§18 rule 7's boundary");
	await R.guard("§18", async () => {
		const libDir = path.join(W.ROOT, "lib");
		const chr = fs.readdirSync(libDir).filter((f) => /^chr-.*\.js$/.test(f));
		ok("§18.1 the CHR modules are found", chr.length >= 5, chr.join());
		eq("§18.2 no lib/chr-*.js requires the note's module, so no automatic CHR payload can carry the driver's name",
			chr.filter((f) => /time-off-chr-draft/.test(fs.readFileSync(path.join(libDir, f), "utf8"))), []);
	});

	section("§19 the module's own rules");
	await R.guard("§19", async () => {
		eq("§19.1 the recipient: exactly one bare address on chrobinson.com", [
			draft.chrRecipient(TO), draft.chrRecipient(` ${TO} `), draft.chrRecipient("Made-Up.Agent@ChRobinson.com"), draft.chrRecipient(""), draft.chrRecipient(undefined),
			draft.chrRecipient(`${TO},${TO}`), draft.chrRecipient(`${TO}; x@chrobinson.com`), draft.chrRecipient("CHR <made-up.agent@chrobinson.com>"), draft.chrRecipient("made-up.agent@chrobinson.com.example.invalid"),
			draft.chrRecipient("made-up.agent@mail.chrobinson.com"), draft.chrRecipient("dayoff@example.invalid"), draft.chrRecipient("made-up.agent@chrobinson.co"),
		], [TO, TO, "Made-Up.Agent@ChRobinson.com", "", "", "", "", "", "", "", "", ""]);
		const id = draft.newChrDraftMessageId("ops@example.invalid");
		eq("§19.2 the Message-ID: the shape lib/imap-draft.js takes, its own marker, the mailbox's domain (logisx.invalid without one)",
			[imap.MESSAGE_ID_RE.test(id), /^<[0-9a-f-]{36}\.time-off-chr@example\.invalid>$/.test(id), /\.time-off-chr@logisx\.invalid>$/.test(draft.newChrDraftMessageId("")), id === draft.newChrDraftMessageId("ops@example.invalid")],
			[true, true, true, false]);
		const chrSrc = fs.readFileSync(path.join(W.ROOT, "lib", "chr-events.js"), "utf8");
		const m = /\nconst UNIT_RE = (\/[^\n]+\/);\n/.exec(chrSrc);
		eq("§19.3 the unit rule is CHR's own (lib/chr-events.js UNIT_RE), and units are held to it", [m && m[1], String(draft.UNIT_RE), draft.cleanUnit(" T-101 "), draft.cleanUnit("T 101"), draft.cleanUnit("T-12345678901"), draft.cleanUnit("#91"), draft.cleanUnit(91)],
			[String(draft.UNIT_RE), "/^[A-Za-z0-9-]{1,12}$/", "T-101", "", "", "", "91"]);
		const t0 = Date.parse("2026-11-04T12:00:00Z");
		const failed = (stage, to = "2026-11-13") => ({ state: "failed", last_stage: stage, to_day: to, created_at: "2026-11-04T11:00:00Z" });
		eq("§19.4 Retry is offered on a failed draft whose row holds and whose days aren't over, and on a pending one older than 10 minutes", [
			draft.canRetry(failed("literal"), { nowMs: t0, todayKey: "2026-11-04" }), draft.canRetry(failed("row_changed"), { nowMs: t0, todayKey: "2026-11-04" }),
			draft.canRetry(failed("refused"), { nowMs: t0, todayKey: "2026-11-04" }), draft.canRetry(failed("search", "2026-11-03"), { nowMs: t0, todayKey: "2026-11-04" }),
			draft.canRetry({ state: "pending", to_day: "2026-11-13", created_at: "2026-11-04T11:50:00Z" }, { nowMs: t0, todayKey: "2026-11-04" }),
			draft.canRetry({ state: "pending", to_day: "2026-11-13", created_at: "2026-11-04T11:49:00Z" }, { nowMs: t0, todayKey: "2026-11-04" }),
			draft.canRetry({ state: "pending", to_day: "2026-11-13", created_at: "" }, { nowMs: t0, todayKey: "2026-11-04" }),
			draft.canRetry({ state: "made", to_day: "2026-11-13" }, { nowMs: t0, todayKey: "2026-11-04" }),
		], [true, false, false, false, false, true, false, false]);
		const why = (d, inFlight = false) => { const r = draft.retryRefusal(d, { nowMs: t0, todayKey: "2026-11-04", inFlight }); return r ? [r.status, r.code] : null; };
		eq("§19.5 Retry's refusals", [why(undefined), why({ state: "made" }), why(failed("literal"), true), why(failed("row_changed")), why(failed("search", "2026-11-03")),
			why({ state: "pending", to_day: "2026-11-13", created_at: "2026-11-04T11:55:00Z" }), why(failed("literal"))],
		[[404, "CHR_DRAFT_NOT_FOUND"], [409, "CHR_DRAFT_MADE"], [409, "CHR_DRAFT_IN_FLIGHT"], [409, "CHR_DRAFT_ROW_CHANGED"], [409, "CHR_DRAFT_ROW_CHANGED"], [409, "CHR_DRAFT_IN_FLIGHT"], null]);
		eq("§19.6 the later-change lines", [draft.laterChangeNote({ state: "made", draftedOn: "2026-11-04" }), draft.laterChangeNote({ state: "made" }), draft.laterChangeNote({ state: "failed" }) === draft.laterChangeNote({ state: "pending" }), draft.laterChangeNote({ state: "past" })],
			["CHR's contact was drafted about these days on Nov 4: tell them about this change.", "CHR's contact was drafted about these days: tell them about this change.", true, ""]);
		const order = [];
		const checks = [{ ok: true, subject: "s", text: "t" }, { ok: true, subject: "s", text: "t" }];
		const made = await draft.attemptChrDraft({
			check: () => { order.push("check"); return checks.shift(); },
			search: async () => { order.push("search"); return { found: false, count: 0, mailbox: "" }; },
			append: async (note) => { order.push(`append ${note.subject}`); },
		});
		eq("§19.7 a Retry's attempt: check, search, check again right before the append, then made", [order, made], [["check", "search", "check", "append s"], { state: "made", stage: "", tried: true, found: "" }]);
		const late = await draft.attemptChrDraft({
			check: (() => { const seq = [{ ok: true, subject: "s", text: "t" }, { ok: false, stage: "row_changed" }]; return () => seq.shift(); })(),
			search: async () => ({ found: false }), append: async () => { throw new Error("never"); },
		});
		eq("§19.8 a row that changed during the search: failed at row_changed, nothing appended", late, { state: "failed", stage: "row_changed", tried: false, found: "" });
		eq("§19.9 an append failing without a stage, or a check that throws: failed at \"error\", never rejected", [
			(await draft.attemptChrDraft({ check: () => ({ ok: true, subject: "s", text: "t" }), append: async () => { throw new Error("x"); } })).stage,
			(await draft.attemptChrDraft({ check: () => { throw new Error("x"); }, append: async () => {} })).stage,
		], ["error", "error"]);
		const viewOf = (d, draftedOn = "") => draft.draftView({ unit: "T-101", from_day: "2026-11-09", to_day: "2026-11-13", created_at: "2026-11-04T11:00:00Z", ...d },
			{ driverName: "A. Example", todayKey: "2026-11-04", nowMs: t0, draftedOn, denyHits: NO_DENY });
		eq("§19.11 draftView(): a failed draft Retry can help carries the line; one whose row changed, none; made says the day; pending offers Retry by the clock", [
			viewOf({ state: "failed", last_stage: "literal" }), viewOf({ state: "failed", last_stage: "row_changed" }), viewOf({ state: "made" }, "2026-11-04"), viewOf({ state: "made" }, "x"),
			viewOf({ state: "pending", created_at: "2026-11-04T11:55:00Z" }),
		], [
			{ state: "failed", line: "Driver A. Example, LogisX truck T-101, unavailable Nov 9 – Nov 13", canRetry: true }, { state: "failed", canRetry: false },
			{ state: "made", canRetry: false, draftedOn: "2026-11-04" }, { state: "made", canRetry: false }, { state: "pending", canRetry: false },
		]);
		eq("§19.10 the longest digit run counts spaces, dots, dashes and brackets between digits, and nothing else",
			[draft.longestDigitRun("(555) 010-0147"), draft.longestDigitRun("555.010.0147"), draft.longestDigitRun("Nov 9 – Nov 13"), draft.longestDigitRun("Dec 28, 2026 – Jan 3, 2027"), draft.longestDigitRun("12a34")],
			[10, 10, 2, 4, 2]);
	});

	await R.finish();
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
