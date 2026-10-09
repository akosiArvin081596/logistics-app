#!/usr/bin/env node
/**
 * POST /api/public/investor-rfi, the website's investor Request for Information
 * (lib/investor-rfi.js).
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 checkInvestorRfi(): required fields, the email check, length caps,
 *      control and invisible characters stripped from every text field, one
 *      scalar per field, consent, the honeypot, and the phone's shape (digits,
 *      spaces, dots, + - and parentheses, 7–20 characters, at least 7 digits;
 *      optional here)
 *   §2 buildInvestorRfiEmail(): to the inbox it is given (ADMIN_NOTIFY_EMAIL in
 *      server.js; admin@example.test here), Reply-To the submitter,
 *      "[STAGING] " only for the staging site, every value escaped
 *   §3 the real middleware on a real Express app over loopback, with a fake
 *      mail sender: a valid submit sends one email (JSON and form shapes);
 *      missing or invalid fields are refused and send nothing; a filled
 *      honeypot answers as sent and sends nothing; a wrong, missing or null
 *      Origin is refused 403; the 11th request inside the window is refused
 *      429; past the daily cap nothing is sent; a failed send is reported; an
 *      oversized body is refused 413; a sub-path is never body-parsed; and
 *      nothing a visitor typed reaches the console
 *   §4 wiring in server.js: the body parsers are mounted on this path only,
 *      above the 50 MB JSON parser; the route mounts the middleware with the
 *      shared sendEmail; no other route gains a form-encoded parser; the lib
 *      touches no database
 *   §5 DISCRIMINATION — defang a guard, require the assertion to flip
 *   §6 call requests (kind "call", the website's "Schedule a call" form):
 *      kind absent / "" / "rfi" answers exactly as the RFI, any other kind is
 *      refused; phone, preferredDate (a real date, today to 120 days ahead on
 *      the business clock, APP_TIMEZONE, with `now` fixed), timeWindow, timeZone and topic are required
 *      and checked; the email's subject, heading, rows, labels and escaping;
 *      over HTTP: one email per valid call (JSON and form), the call
 *      redirects (sent, refusals, honeypot, rate limit, daily cap, failed
 *      send, body-parser refusal), and the limiter and daily cap shared with
 *      the RFI. Its submissions also feed §3's console check.
 *   §7 a call's return page: the Referer chooses /contact or /invest-in-logisx
 *      on the validated origin (one trailing slash ignored, its query
 *      dropped), for sent and error answers alike; no Referer, any other page,
 *      another origin or a Referer that is not a URL lands on /contact; the
 *      RFI's redirect never reads it
 *   §8 the hourly limits per client address, with the app's `trust proxy` and
 *      X-Forwarded-For as nginx sends it: 5 an hour for submissions that pass
 *      the checks (RFI_HOURLY_LIMIT), 30 for ones they refuse
 *      (RFI_REFUSED_HOURLY_LIMIT), each one counter for both forms and blind to
 *      the other kind; over either, 429 (JSON) or the form's error page, and
 *      nothing over the limit is sent; another address keeps its own counts;
 *      the RateLimit-Policy header names each. The other sections run with the
 *      hourly limits raised (buildApp), so they test what they name.
 *
 * Hermetic: an in-process server on 127.0.0.1, no app.db, no Gmail, no
 * network beyond loopback, no fixtures.
 *
 * Run: node scripts/test-investor-rfi.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");

const ROOT = path.join(__dirname, "..");
const LIB_PATH = path.join(ROOT, "lib", "investor-rfi.js");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const LIB_SRC = fs.readFileSync(LIB_PATH, "utf8");
const rfi = require(LIB_PATH);

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}

// The admin inbox the middleware is given, as server.js passes ADMIN_NOTIFY_EMAIL.
const ADMIN = "admin@example.test";
const STAGING = "https://staging-logisx.logisx.com";
const PROD = "https://logisx.com";
const VALID = Object.freeze({
	fullName: "Jane Q. Sample",
	email: "jane.sample@example.com",
	phone: "+1 (555) 010-0199",
	company: "Sample Holdings LLC",
	message: "Interested in the data room.\nThanks!",
	consent: true,
});

// --- a real Express app around the real middleware --------------------------
// `hourlyLimit` is raised for every section but §8, which tests the real one.
function buildApp({ sendResult = true, hourlyLimit = 1000, refusedHourlyLimit = 1000 } = {}) {
	const sent = [];
	const sendEmail = async (to, subject, html, attachments, opts) => {
		sent.push({ to, subject, html, attachments, opts });
		return typeof sendResult === "function" ? sendResult() : sendResult;
	};
	const app = express();
	app.use(rfi.INVESTOR_RFI_PATH, ...rfi.createBodyParsers());
	app.use(express.json({ limit: "50mb" }));
	app.post(rfi.INVESTOR_RFI_PATH, ...rfi.createInvestorRfiMiddleware({
		sendEmail,
		to: ADMIN,
		now: () => new Date("2026-10-07T15:04:05.000Z"),
		hourlyLimit,
		refusedHourlyLimit,
	}));
	// A neighbour route, to prove the form parser stays on its own path.
	app.post("/api/other", (req, res) => res.json({ body: req.body ?? null }));
	return { app, sent };
}

function listen(app) {
	return new Promise((resolve) => {
		const server = app.listen(0, "127.0.0.1", () => resolve(server));
	});
}

function request(server, { method = "POST", urlPath = rfi.INVESTOR_RFI_PATH, headers = {}, body = "" }) {
	return new Promise((resolve, reject) => {
		const { port } = server.address();
		const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: { ...headers, "Content-Length": Buffer.byteLength(body) } }, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (c) => { data += c; });
			res.on("end", () => {
				let json = null;
				try { json = JSON.parse(data); } catch { /* not JSON */ }
				resolve({ status: res.statusCode, headers: res.headers, text: data, json });
			});
		});
		req.on("error", reject);
		req.end(body);
	});
}

const asJson = (origin, payload, extra = {}) => ({
	headers: { "Content-Type": "application/json", Accept: "application/json", ...(origin ? { Origin: origin } : {}), ...extra },
	body: JSON.stringify(payload),
});
const asForm = (origin, payload, { referer } = {}) => ({
	headers: {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		...(origin ? { Origin: origin } : {}),
		...(referer ? { Referer: referer } : {}),
	},
	body: typeof payload === "string" ? payload : new URLSearchParams(payload).toString(),
});

(async () => {
	// --- §1 checkInvestorRfi ----------------------------------------------------
	const good = rfi.checkInvestorRfi({ ...VALID });
	ok("§1 a complete submission passes", good.ok === true && good.honeypot === false);
	ok("§1 values are trimmed and returned", rfi.checkInvestorRfi({ ...VALID, fullName: "  Jane  " }).value.fullName === "Jane");
	ok("§1 optional fields may be absent", rfi.checkInvestorRfi({ fullName: "Jane", email: "j@example.com", consent: true }).ok === true);
	ok("§1 absent optional fields come back empty",
		(() => { const r = rfi.checkInvestorRfi({ fullName: "Jane", email: "j@example.com", consent: "true" }); return r.value.phone === "" && r.value.company === "" && r.value.message === ""; })());
	for (const field of ["fullName", "email"]) {
		const r = rfi.checkInvestorRfi({ ...VALID, [field]: "" });
		ok(`§1 ${field} is required`, r.ok === false && r.code === "FIELD_REQUIRED" && r.field === field && r.status === 400);
	}
	ok("§1 a blank name (spaces only) is refused", rfi.checkInvestorRfi({ ...VALID, fullName: "   " }).code === "FIELD_REQUIRED");
	ok("§1 consent is required", rfi.checkInvestorRfi({ ...VALID, consent: undefined }).code === "CONSENT_REQUIRED");
	ok("§1 consent=false is refused", rfi.checkInvestorRfi({ ...VALID, consent: false }).code === "CONSENT_REQUIRED");
	ok("§1 consent='false' is refused", rfi.checkInvestorRfi({ ...VALID, consent: "false" }).code === "CONSENT_REQUIRED");
	ok("§1 consent from a checkbox ('true' / 'on') passes",
		rfi.checkInvestorRfi({ ...VALID, consent: "true" }).ok && rfi.checkInvestorRfi({ ...VALID, consent: "on" }).ok);
	for (const bad of ["not-an-email", "a@b", "two@example.com,three@example.com", "x@example.com\r\nBcc: y@example.com"]) {
		const r = rfi.checkInvestorRfi({ ...VALID, email: bad });
		ok(`§1 email ${JSON.stringify(bad).slice(0, 40)} is refused`, r.ok === false && r.code === "INVALID_EMAIL" && r.field === "email");
	}
	ok("§1 an email with surrounding spaces is trimmed, then accepted",
		rfi.checkInvestorRfi({ ...VALID, email: "  jane@example.com " }).value.email === "jane@example.com");
	for (const [field, max] of Object.entries(rfi.RFI_FIELD_MAX)) {
		const fill = field === "phone" ? "1" : "x"; // a phone must also look like one
		const r = rfi.checkInvestorRfi({ ...VALID, [field]: fill.repeat(max + 1) });
		ok(`§1 ${field} over ${max} characters is refused`, r.ok === false && r.code === "FIELD_TOO_LONG" && r.field === field);
		ok(`§1 ${field} at exactly ${max} characters passes`, rfi.checkInvestorRfi({ ...VALID, [field]: fill.repeat(max) }).ok === true);
	}
	ok("§1 the phone's cap is 20 characters", rfi.RFI_FIELD_MAX.phone === 20);
	// Control and invisible characters are STRIPPED from every text field (2026-10-08).
	ok("§1 a CR/LF in the name is stripped",
		rfi.checkInvestorRfi({ ...VALID, fullName: "Jane\r\nDoe" }).value.fullName === "JaneDoe");
	const INVISIBLES = [
		["a right-to-left override", "\u202E"], ["a zero-width space", "\u200B"], ["a zero-width joiner", "\u200D"],
		["a line separator", "\u2028"], ["a paragraph separator", "\u2029"], ["a C1 control", "\u0085"],
		["a byte-order mark", "\uFEFF"], ["a soft hyphen", "\u00AD"], ["an Arabic letter mark", "\u061C"],
		["a Hangul filler", "\u3164"], ["a Hangul choseong filler", "\u115F"], ["a halfwidth Hangul filler", "\uFFA0"],
		["a combining grapheme joiner", "\u034F"], ["a Mongolian vowel separator", "\u180E"], ["a variation selector", "\uFE0F"],
		["a tag character", "\u{E0041}"], ["a first-strong isolate", "\u2068"], ["a NUL", "\u0000"], ["a BEL", "\u0007"],
	];
	for (const [label, ch] of INVISIBLES) {
		const r = rfi.checkInvestorRfi({ ...VALID, fullName: `Jane${ch}Doe`, phone: `555${ch}0100`, company: `A${ch}B`, message: `a${ch}b` });
		ok(`§1 ${label} is stripped from the name, phone, company and message`,
			r.ok === true && r.value.fullName === "JaneDoe" && r.value.phone === "5550100" && r.value.company === "AB" && r.value.message === "ab");
	}
	ok("§1 a name made only of invisible characters is answered as missing",
		(() => { const r = rfi.checkInvestorRfi({ ...VALID, fullName: "\u200B\u3164\u00AD " }); return r.code === "FIELD_REQUIRED" && r.field === "fullName"; })());
	ok("§1 a zero-width space pasted into the email is stripped",
		rfi.checkInvestorRfi({ ...VALID, email: "jane.sample\u200B@example.com" }).value.email === "jane.sample@example.com");
	ok("§1 an email made only of invisible characters is answered as missing",
		rfi.checkInvestorRfi({ ...VALID, email: "\u200B\uFEFF" }).code === "FIELD_REQUIRED");
	ok("§1 stripping a CR/LF out of the email cannot smuggle in a header",
		rfi.checkInvestorRfi({ ...VALID, email: "a@example.com\r\nBcc: x@example.com" }).code === "INVALID_EMAIL");
	ok("§1 accented and non-Latin names pass unchanged", rfi.checkInvestorRfi({ ...VALID, fullName: "José Ñúñez 李雷" }).value.fullName === "José Ñúñez 李雷");
	ok("§1 line breaks and tabs are kept in the message", rfi.checkInvestorRfi({ ...VALID, message: "a\r\nb\tc" }).value.message === "a\r\nb\tc");
	ok("§1 tabs are stripped from one-line fields", rfi.checkInvestorRfi({ ...VALID, fullName: "Jane\tDoe" }).value.fullName === "JaneDoe");
	for (const field of rfi.RFI_SCALAR_FIELDS) {
		const r = rfi.checkInvestorRfi({ ...VALID, [field]: ["a", "b"] });
		ok(`§1 ${field} sent twice (an array) is refused`, r.ok === false && r.code === "INVALID_FIELD");
	}
	ok("§1 consent sent twice (an array) is refused", rfi.checkInvestorRfi({ ...VALID, consent: ["true", "true"] }).code === "CONSENT_REQUIRED");
	ok("§1 an object for a field is refused", rfi.checkInvestorRfi({ ...VALID, company: { a: 1 } }).code === "INVALID_FIELD");
	ok("§1 a number for a text field is refused", rfi.checkInvestorRfi({ ...VALID, phone: 5550100 }).code === "INVALID_FIELD");
	// The phone's shape (2026-10-09): digits, spaces, dots, + - and parentheses;
	// 7–20 characters; at least 7 digits. Optional on the RFI.
	const GOOD_PHONES = ["+1 (555) 010-0199", "555-0100", "5550100", "(555) 010 0199", "+44 20 7946 0958", "+1-555-010-0199",
		"555.010.0199", "+1 555.010.0199", "(555) 010.0199"];
	const BAD_PHONES = [
		["letters", "call 555-0100"], ["underscores", "555_010_0199"], ["an en dash", "555\u20130100"], ["a URL", "http://x.co/1234567"],
		["an extension", "555-0100 x12"], ["a slash", "555/010/0199"], ["only symbols", "+(-) (-)"],
		["6 digits", "555-010"], ["6 characters", "123456"], ["full-width digits", "５５５０１００"],
		["an email", "jane@example.com"], ["a plus inside a word", "555+0100+abc"],
	];
	for (const phone of GOOD_PHONES) ok(`§1 phone ${JSON.stringify(phone)} passes`, rfi.checkInvestorRfi({ ...VALID, phone }).value?.phone === phone);
	for (const [label, phone] of BAD_PHONES) {
		const r = rfi.checkInvestorRfi({ ...VALID, phone });
		ok(`§1 a phone with ${label} is refused INVALID_FIELD phone`, r.ok === false && r.status === 400 && r.code === "INVALID_FIELD" && r.field === "phone" && /digits, spaces/.test(r.message));
	}
	ok("§1 no phone is still fine on an RFI", rfi.checkInvestorRfi({ ...VALID, phone: "" }).ok === true && rfi.checkInvestorRfi({ ...VALID, phone: undefined }).ok === true);
	ok("§1 a phone is trimmed before its shape is checked", rfi.checkInvestorRfi({ ...VALID, phone: "  555-0100  " }).value?.phone === "555-0100");
	ok("§1 a missing body is refused, not thrown", rfi.checkInvestorRfi(undefined).code === "FIELD_REQUIRED");
	const trapped = rfi.checkInvestorRfi({ ...VALID, [rfi.RFI_HONEYPOT_FIELD]: "https://spam.example" });
	ok("§1 a filled honeypot is answered as a silent drop", trapped.ok === true && trapped.honeypot === true && !trapped.value);
	ok("§1 a filled honeypot wins even over invalid fields",
		rfi.checkInvestorRfi({ [rfi.RFI_HONEYPOT_FIELD]: "x" }).honeypot === true);
	ok("§1 an empty honeypot passes", rfi.checkInvestorRfi({ ...VALID, [rfi.RFI_HONEYPOT_FIELD]: "" }).honeypot === false);

	// --- §2 buildInvestorRfiEmail --------------------------------------------------
	const at = new Date("2026-10-07T15:04:05.000Z");
	const prodMail = rfi.buildInvestorRfiEmail(good.value, { staging: false, submittedAt: at, to: ADMIN });
	const stgMail = rfi.buildInvestorRfiEmail(good.value, { staging: true, submittedAt: at, to: ADMIN });
	ok("§2 the email goes to the inbox it is given", prodMail.to === ADMIN && stgMail.to === ADMIN);
	ok("§2 production subject: 'Investor RFI: <name>'", prodMail.subject === "Investor RFI: Jane Q. Sample");
	ok("§2 staging subject is prefixed '[STAGING] '", stgMail.subject === "[STAGING] Investor RFI: Jane Q. Sample");
	ok("§2 Reply-To is the submitter", prodMail.replyTo === "jane.sample@example.com");
	ok("§2 the body carries every field and the submission time",
		["Jane Q. Sample", "jane.sample@example.com", "+1 (555) 010-0199", "Sample Holdings LLC", "Interested in the data room.", "2026-10-07T15:04:05Z", "Oct 7, 2026"]
			.every((s) => prodMail.html.includes(s)));
	const hostile = rfi.buildInvestorRfiEmail({ fullName: "<img src=x onerror=alert(1)>", email: "a@example.com", phone: "", company: "\"><b>", message: "<script>x</script>" }, { staging: false, submittedAt: at });
	ok("§2 every value is HTML-escaped",
		!hostile.html.includes("<img src=x") && !hostile.html.includes("<script>") && hostile.html.includes("&quot;&gt;&lt;b&gt;") &&
		hostile.html.includes("&lt;img src=x onerror=alert(1)&gt;") && hostile.html.includes("&lt;script&gt;"));
	ok("§2 an empty optional field shows 'Not given'", hostile.html.includes("Not given"));

	// --- §3 HTTP --------------------------------------------------------------------
	const captured = [];
	const realConsole = { log: console.log, warn: console.warn, error: console.error };
	const tap = (kind) => (...args) => { captured.push(args.map(String).join(" ")); if (kind === "log") realConsole.log(...args); };
	console.warn = tap("warn"); console.error = tap("error");

	{
		const { app, sent } = buildApp();
		const server = await listen(app);

		let r = await request(server, asJson(STAGING, VALID));
		ok("§3 valid JSON submit from staging → 200 { ok: true }", r.status === 200 && r.json && r.json.ok === true);
		ok("§3 ... sends exactly one email", sent.length === 1);
		ok("§3 ... to the admin inbox, '[STAGING] Investor RFI: <name>', Reply-To the submitter",
			sent[0] && sent[0].to === ADMIN && sent[0].subject === "[STAGING] Investor RFI: Jane Q. Sample" && sent[0].opts && sent[0].opts.replyTo === VALID.email);

		r = await request(server, asForm(PROD, { ...VALID, consent: "true" }));
		ok("§3 valid form POST from logisx.com → 303 to https://logisx.com/invest-in-logisx?sent=1",
			r.status === 303 && r.headers.location === "https://logisx.com/invest-in-logisx?sent=1");
		ok("§3 ... sends one email, no [STAGING] prefix", sent.length === 2 && sent[1].subject === "Investor RFI: Jane Q. Sample");

		r = await request(server, asForm(STAGING, { ...VALID, consent: "true" }));
		ok("§3 a form POST from staging is sent back to staging", r.status === 303 && r.headers.location === `${STAGING}/invest-in-logisx?sent=1`);

		const before = sent.length;
		r = await request(server, asJson(STAGING, { ...VALID, fullName: "" }));
		ok("§3 missing name (JSON) → 400 FIELD_REQUIRED fullName", r.status === 400 && r.json.code === "FIELD_REQUIRED" && r.json.field === "fullName");
		r = await request(server, asJson(STAGING, { ...VALID, email: "nope" }));
		ok("§3 invalid email (JSON) → 400 INVALID_EMAIL", r.status === 400 && r.json.code === "INVALID_EMAIL" && r.json.field === "email");
		r = await request(server, asJson(STAGING, { ...VALID, consent: false }));
		ok("§3 no consent (JSON) → 400 CONSENT_REQUIRED", r.status === 400 && r.json.code === "CONSENT_REQUIRED");
		r = await request(server, asForm(PROD, { fullName: "Jane", email: "jane@example.com" }));
		ok("§3 no consent (form) → 303 ?error=1", r.status === 303 && r.headers.location === "https://logisx.com/invest-in-logisx?error=1");
		r = await request(server, asForm(PROD, "fullName=A&fullName=B&email=jane%40example.com&consent=true"));
		ok("§3 a form key sent twice → 303 ?error=1", r.status === 303 && r.headers.location.endsWith("?error=1"));
		ok("§3 ... and no refused submission sent an email", sent.length === before);

		r = await request(server, asJson(STAGING, { ...VALID, website: "http://bot.example" }));
		ok("§3 honeypot filled (JSON) → 200 { ok: true }", r.status === 200 && r.json.ok === true);
		r = await request(server, asForm(PROD, { ...VALID, consent: "true", website: "x" }));
		ok("§3 honeypot filled (form) → 303 ?sent=1", r.status === 303 && r.headers.location.endsWith("?sent=1"));
		ok("§3 ... and the honeypot sent nothing", sent.length === before);

		for (const [label, origin] of [["a foreign Origin", "https://evil.example"], ["no Origin", null], ["Origin: null", "null"], ["the app's own origin", "https://app.logisx.com"], ["a lookalike", "https://logisx.com.evil.example"]]) {
			r = await request(server, asJson(origin, VALID));
			ok(`§3 ${label} → 403 ORIGIN_NOT_ALLOWED (JSON)`, r.status === 403 && r.json && r.json.code === "ORIGIN_NOT_ALLOWED");
		}
		r = await request(server, asForm("https://evil.example", { ...VALID, consent: "true" }));
		ok("§3 a foreign Origin (form) → 403, never a redirect", r.status === 403 && !r.headers.location);
		ok("§3 ... and no refused origin sent an email", sent.length === before);

		r = await request(server, asJson(STAGING, { ...VALID, message: "x".repeat(40_000) }));
		ok("§3 a body over 32 KB → 413 BODY_TOO_LARGE", r.status === 413 && r.json && r.json.code === "BODY_TOO_LARGE");
		r = await request(server, { urlPath: `${rfi.INVESTOR_RFI_PATH}/sub`, ...asForm(PROD, { a: "1" }) });
		ok("§3 a sub-path of the route is not body-parsed (no route there: 404)", r.status === 404);
		r = await request(server, { headers: { "Content-Type": "application/json", Accept: "application/json", Origin: STAGING }, body: "{not json" });
		ok("§3 malformed JSON → 400 INVALID_BODY", r.status === 400 && r.json && r.json.code === "INVALID_BODY");

		r = await request(server, { urlPath: "/api/other", ...asForm(PROD, { a: "1" }) });
		ok("§3 a neighbour route still gets no form-encoded body", r.status === 200 && r.json && r.json.body !== null && Object.keys(r.json.body).length === 0);

		server.close();
	}

	{
		const { app, sent } = buildApp({ sendResult: false });
		const server = await listen(app);
		let r = await request(server, asJson(PROD, VALID));
		ok("§3 a failed send (JSON) → 502 SEND_FAILED", r.status === 502 && r.json.code === "SEND_FAILED");
		r = await request(server, asForm(PROD, { ...VALID, consent: "true" }));
		ok("§3 a failed send (form) → 303 ?error=1", r.status === 303 && r.headers.location === "https://logisx.com/invest-in-logisx?error=1");
		ok("§3 ... the sender was asked both times", sent.length === 2);
		server.close();
	}

	{
		const { app } = buildApp({ sendResult: () => { throw new Error(`smtp said no to ${VALID.email}`); } });
		const server = await listen(app);
		const r = await request(server, asJson(PROD, VALID));
		ok("§3 a sender that throws → 500 SEND_FAILED, handled", r.status === 500 && r.json.code === "SEND_FAILED");
		server.close();
	}

	{
		const { app, sent } = buildApp();
		const server = await listen(app);
		const statuses = [];
		for (let i = 0; i < rfi.RFI_RATE_LIMIT; i++) statuses.push((await request(server, asJson(PROD, VALID))).status);
		ok(`§3 the first ${rfi.RFI_RATE_LIMIT} requests in the window are served`, statuses.every((s) => s === 200));
		let r = await request(server, asJson(PROD, VALID));
		ok(`§3 request ${rfi.RFI_RATE_LIMIT + 1} → 429 RATE_LIMITED (JSON)`, r.status === 429 && r.json.code === "RATE_LIMITED");
		r = await request(server, asForm(PROD, { ...VALID, consent: "true" }));
		ok("§3 over the limit (form) → 303 ?error=1", r.status === 303 && r.headers.location.endsWith("?error=1"));
		ok("§3 ... and nothing over the limit was sent", sent.length === rfi.RFI_RATE_LIMIT);
		r = await request(server, asJson("https://evil.example", VALID));
		ok("§3 a refused origin is answered 403 before the limiter", r.status === 403);
		server.close();
	}

	{
		// A fresh app (and so a fresh rate-limit window) for the size check.
		const { app } = buildApp();
		const server = await listen(app);
		const r = await request(server, asForm(STAGING, { ...VALID, consent: "true", message: "ж".repeat(2000) }));
		ok("§3 a 2,000-character non-Latin message (form-encoded) is accepted", r.status === 303 && r.headers.location.endsWith("?sent=1"));
		server.close();
	}

	{
		// The daily cap: past it nothing is sent, whoever asks.
		const sent = [];
		const app = express();
		app.use(rfi.INVESTOR_RFI_PATH, ...rfi.createBodyParsers());
		app.post(rfi.INVESTOR_RFI_PATH, ...rfi.createInvestorRfiMiddleware({ sendEmail: async (...a) => { sent.push(a); return true; }, to: ADMIN, dailySendCap: 2 }));
		const server = await listen(app);
		const first = [await request(server, asJson(PROD, VALID)), await request(server, asJson(PROD, VALID))];
		ok("§3 under the daily cap, submissions are sent", first.every((r) => r.status === 200) && sent.length === 2);
		let r = await request(server, asJson(PROD, VALID));
		ok("§3 over the daily cap (JSON) → 503 SEND_FAILED", r.status === 503 && r.json.code === "SEND_FAILED");
		r = await request(server, asForm(PROD, { ...VALID, consent: "true" }));
		ok("§3 over the daily cap (form) → 303 ?error=1", r.status === 303 && r.headers.location.endsWith("?error=1"));
		ok("§3 ... and nothing over the cap was sent", sent.length === 2);
		ok("§3 the default daily cap is 50", rfi.RFI_DAILY_SEND_CAP === 50);
		server.close();
	}

	{
		// Refused origins must not use up a real visitor's allowance.
		const { app } = buildApp();
		const server = await listen(app);
		for (let i = 0; i < rfi.RFI_RATE_LIMIT + 5; i++) await request(server, asJson("https://evil.example", VALID));
		const r = await request(server, asJson(PROD, VALID));
		ok("§3 refused-origin requests do not count against the limit", r.status === 200);
		server.close();
	}

	// --- §6 call requests (kind "call") ---------------------------------------------
	// "Today" is fixed by `now`: 2026-10-07T15:04:05Z is 11:04 EDT on Wed Oct 7 on
	// the business clock (APP_TIMEZONE, US Eastern), the same instant buildApp()
	// gives the route.
	const NOW = new Date("2026-10-07T15:04:05.000Z");
	const LATE_EVENING = new Date("2026-10-08T03:00:00.000Z"); // 23:00 EDT, still Oct 7 on the business clock
	const AFTER_MIDNIGHT = new Date("2026-10-08T06:00:00.000Z"); // 02:00 EDT, Oct 8 on the business clock
	const LATE_CENTRAL = new Date("2026-10-08T04:30:00.000Z"); // 23:30 CDT Oct 7, already 00:30 EDT Oct 8
	const CALL = Object.freeze({
		kind: "call",
		fullName: "Carl O. Callback",
		email: "carl.callback@example.com",
		phone: "+1 (555) 010-0142",
		preferredDate: "2026-10-15",
		timeWindow: "afternoon",
		timeZone: "mountain",
		topic: "owning-logisx",
		message: "Afternoons suit me best.\nThanks.",
		consent: true,
	});
	const CALL_FORM = Object.freeze({ ...CALL, consent: "true" });
	// A call's 303 names the call form it came from (§7); with no Referer, /contact.
	const CALL_SENT = (origin, page = "/contact") => `${origin}${page}?call=sent#schedule-a-call`;
	const CALL_ERROR = (origin, page = "/contact") => `${origin}${page}?call=error#schedule-a-call`;
	const checkCall = (body, now = NOW) => rfi.checkWebsiteForm(body, { now });
	const refusedAs = (r, code, field) => r.ok === false && r.status === 400 && r.code === code && r.field === field;

	const goodCall = checkCall({ ...CALL });
	ok("§6 a complete call request passes as kind 'call'", goodCall.ok === true && goodCall.kind === "call" && goodCall.honeypot === false);
	ok("§6 ... with every field it reads",
		JSON.stringify(goodCall.value) === JSON.stringify({ fullName: CALL.fullName, email: CALL.email, phone: CALL.phone, preferredDate: "2026-10-15", timeWindow: "afternoon", timeZone: "mountain", topic: "owning-logisx", message: CALL.message }));
	for (const kind of [undefined, null, "", "rfi"]) {
		ok(`§6 kind ${JSON.stringify(kind)} is the RFI, answered exactly as checkInvestorRfi`,
			JSON.stringify(checkCall({ ...VALID, kind })) === JSON.stringify({ ...rfi.checkInvestorRfi({ ...VALID }), kind: "rfi" }) &&
			JSON.stringify(checkCall({ ...VALID, kind, fullName: "" })) === JSON.stringify(rfi.checkInvestorRfi({ ...VALID, fullName: "" })));
	}
	ok("§6 an RFI never reads the call fields", checkCall({ ...VALID, kind: "rfi", preferredDate: ["a", "b"], topic: "nope" }).ok === true);
	ok("§6 the RFI keeps its own consent message",
		checkCall({ ...VALID, consent: false }).message === "Please agree to be contacted about investment opportunities.");
	for (const kind of ["Call", " call", "meeting", "RFI", 1, ["call", "call"], { a: 1 }]) {
		ok(`§6 kind ${JSON.stringify(kind)} is refused INVALID_FIELD kind`, refusedAs(checkCall({ ...CALL, kind }), "INVALID_FIELD", "kind"));
	}
	ok("§6 fullName is required", refusedAs(checkCall({ ...CALL, fullName: "  " }), "FIELD_REQUIRED", "fullName"));
	ok("§6 email is required", refusedAs(checkCall({ ...CALL, email: "" }), "FIELD_REQUIRED", "email"));
	ok("§6 a bad email is refused as for the RFI", (() => { const r = checkCall({ ...CALL, email: "two@example.com,three@example.com" }); return r.code === "INVALID_EMAIL" && r.field === "email"; })());
	ok("§6 an email with surrounding spaces is trimmed", checkCall({ ...CALL, email: " carl@example.com " }).value.email === "carl@example.com");
	for (const phone of [undefined, "", "   "]) {
		ok(`§6 phone ${JSON.stringify(phone)} is refused FIELD_REQUIRED (required for a call)`, refusedAs(checkCall({ ...CALL, phone }), "FIELD_REQUIRED", "phone"));
	}
	ok("§6 a phone over 20 characters is refused", checkCall({ ...CALL, phone: "1".repeat(21) }).code === "FIELD_TOO_LONG");
	ok("§6 a phone at exactly 20 characters passes", checkCall({ ...CALL, phone: "1".repeat(20) }).ok === true);
	for (const phone of GOOD_PHONES) ok(`§6 call phone ${JSON.stringify(phone)} passes`, checkCall({ ...CALL, phone }).value?.phone === phone);
	for (const [label, phone] of BAD_PHONES) {
		ok(`§6 a call phone with ${label} is refused INVALID_FIELD phone`, refusedAs(checkCall({ ...CALL, phone }), "INVALID_FIELD", "phone"));
	}
	ok("§6 a CR/LF in the phone is stripped", checkCall({ ...CALL, phone: "555\r\n0100" }).value.phone === "5550100");
	ok("§6 a CR/LF in the name is stripped", checkCall({ ...CALL, fullName: "Carl\r\nCallback" }).value.fullName === "CarlCallback");
	ok("§6 an invisible Hangul filler and an Arabic letter mark are stripped from the name",
		checkCall({ ...CALL, fullName: "Carl\u3164\u061C O. Callback" }).value.fullName === "Carl O. Callback");
	ok("§6 the message is optional", (() => { const r = checkCall({ ...CALL, message: undefined }); return r.ok === true && r.value.message === ""; })());
	ok("§6 a message over 2,000 characters is refused", checkCall({ ...CALL, message: "x".repeat(2001) }).code === "FIELD_TOO_LONG");
	ok("§6 line breaks are kept in the message, other controls are stripped",
		checkCall({ ...CALL, message: "a\r\nb\tc" }).value.message === "a\r\nb\tc" && checkCall({ ...CALL, message: "a\u202Eb\u0007c" }).value.message === "abc");
	ok("§6 a company is ignored", (() => { const r = checkCall({ ...CALL, company: "Acme Freight" }); return r.ok === true && !("company" in r.value); })());
	for (const field of rfi.CALL_SCALAR_FIELDS) {
		ok(`§6 ${field} sent twice (an array) is refused`, (() => { const r = checkCall({ ...CALL, [field]: ["a", "b"] }); return r.ok === false && r.code === "INVALID_FIELD"; })());
	}
	ok("§6 consent is required, with the call's own message",
		(() => { const r = checkCall({ ...CALL, consent: undefined }); return r.code === "CONSENT_REQUIRED" && r.field === "consent" && r.message === "Please agree to be contacted about your request."; })());
	ok("§6 consent=false / 'false' is refused", checkCall({ ...CALL, consent: false }).code === "CONSENT_REQUIRED" && checkCall({ ...CALL, consent: "false" }).code === "CONSENT_REQUIRED");
	ok("§6 consent from a checkbox ('true' / 'on') passes", checkCall({ ...CALL, consent: "true" }).ok && checkCall({ ...CALL, consent: "on" }).ok);
	const callTrap = checkCall({ ...CALL, website: "https://spam.example" });
	ok("§6 a filled honeypot on a call is a silent drop", callTrap.ok === true && callTrap.honeypot === true && !callTrap.value);
	ok("§6 ... and wins over invalid call fields", checkCall({ kind: "call", website: "x" }).honeypot === true);

	for (const preferredDate of [undefined, null, "", "   "]) {
		ok(`§6 preferredDate ${JSON.stringify(preferredDate)} → FIELD_REQUIRED`, refusedAs(checkCall({ ...CALL, preferredDate }), "FIELD_REQUIRED", "preferredDate"));
	}
	for (const preferredDate of ["15/10/2026", "2026-10-5", "20261015", "2026-10-15T00:00", "Oct 15, 2026", "2026-1O-15", "x".repeat(100), 20261015]) {
		ok(`§6 malformed preferredDate ${JSON.stringify(preferredDate).slice(0, 24)} → INVALID_FIELD`, refusedAs(checkCall({ ...CALL, preferredDate }), "INVALID_FIELD", "preferredDate"));
	}
	for (const preferredDate of ["2026-02-30", "2026-13-01", "2026-10-00", "2026-11-31", "2027-02-29", "0026-10-15"]) {
		ok(`§6 impossible date ${preferredDate} → INVALID_FIELD`, refusedAs(checkCall({ ...CALL, preferredDate }), "INVALID_FIELD", "preferredDate"));
	}
	ok("§6 yesterday (2026-10-06) → INVALID_FIELD", refusedAs(checkCall({ ...CALL, preferredDate: "2026-10-06" }), "INVALID_FIELD", "preferredDate"));
	ok("§6 today (2026-10-07) passes", checkCall({ ...CALL, preferredDate: "2026-10-07" }).ok === true);
	ok(`§6 ${rfi.CALL_MAX_DAYS_AHEAD} days out (2027-02-04) passes`, checkCall({ ...CALL, preferredDate: "2027-02-04" }).ok === true);
	ok(`§6 ${rfi.CALL_MAX_DAYS_AHEAD + 1} days out (2027-02-05) → INVALID_FIELD`, refusedAs(checkCall({ ...CALL, preferredDate: "2027-02-05" }), "INVALID_FIELD", "preferredDate"));
	ok("§6 a date with surrounding spaces is trimmed", checkCall({ ...CALL, preferredDate: " 2026-10-15 " }).value.preferredDate === "2026-10-15");
	ok("§6 'today' is the business clock: at 11:00 PM EDT (already Oct 8 in UTC) Oct 7 still passes",
		checkCall({ ...CALL, preferredDate: "2026-10-07" }, LATE_EVENING).ok === true);
	ok("§6 ... and the 121st day is still refused then",
		refusedAs(checkCall({ ...CALL, preferredDate: "2027-02-05" }, LATE_EVENING), "INVALID_FIELD", "preferredDate"));
	ok("§6 after midnight Eastern, the day before is refused",
		refusedAs(checkCall({ ...CALL, preferredDate: "2026-10-07" }, AFTER_MIDNIGHT), "INVALID_FIELD", "preferredDate"));
	ok("§6 11:30 PM Central is already the next day on the business clock: Oct 7 is refused",
		refusedAs(checkCall({ ...CALL, preferredDate: "2026-10-07" }, LATE_CENTRAL), "INVALID_FIELD", "preferredDate"));
	ok("§6 checkCallRequest takes `now` too", rfi.checkCallRequest({ ...CALL, preferredDate: "2026-10-07" }, { now: AFTER_MIDNIGHT }).field === "preferredDate");

	const CHOICES = { timeWindow: rfi.CALL_TIME_WINDOWS, timeZone: rfi.CALL_TIME_ZONES, topic: rfi.CALL_TOPICS };
	ok("§6 the choices are exactly the contract's values",
		[...rfi.CALL_TIME_WINDOWS.keys()].join() === "morning,afternoon,evening" &&
		[...rfi.CALL_TIME_ZONES.keys()].join() === "eastern,central,mountain,pacific" &&
		[...rfi.CALL_TOPICS.keys()].join() === "truck-fund,owning-logisx,broker-free-platform,other");
	for (const [field, choices] of Object.entries(CHOICES)) {
		ok(`§6 every ${field} value passes`, [...choices.keys()].every((v) => checkCall({ ...CALL, [field]: v }).ok === true));
		for (const missing of [undefined, null, ""]) {
			ok(`§6 ${field} ${JSON.stringify(missing)} → FIELD_REQUIRED`, refusedAs(checkCall({ ...CALL, [field]: missing }), "FIELD_REQUIRED", field));
		}
		for (const bad of ["noon", "MORNING", " other", "constructor", "__proto__", 3]) {
			ok(`§6 ${field} ${JSON.stringify(bad)} → INVALID_FIELD`, refusedAs(checkCall({ ...CALL, [field]: bad }), "INVALID_FIELD", field));
		}
	}

	const hasRow = (html, label, value) => html.includes(`>${label}</td><td style="padding:6px 0;vertical-align:top">${value}</td></tr>`);
	const callProd = rfi.buildCallRequestEmail(goodCall.value, { staging: false, submittedAt: at, to: ADMIN });
	const callStg = rfi.buildCallRequestEmail(goodCall.value, { staging: true, submittedAt: at, to: ADMIN });
	ok("§6 the call email goes to the inbox it is given, Reply-To the submitter",
		callProd.to === ADMIN && callStg.to === ADMIN && callProd.replyTo === CALL.email);
	ok("§6 production subject: 'Call request: <topic label>', from the validated topic only", callProd.subject === "Call request: Owning part of LogisX");
	ok("§6 staging subject is prefixed '[STAGING] '", callStg.subject === "[STAGING] Call request: Owning part of LogisX");
	{
		const spoof = checkCall({ ...CALL, fullName: "Bob (Truck Fund)", topic: "other" });
		const spoofMail = rfi.buildCallRequestEmail(spoof.value, { staging: false, submittedAt: at });
		ok("§6 a name that looks like a topic never reaches the subject",
			spoof.ok === true && spoofMail.subject === "Call request: Other" && !spoofMail.subject.includes("Bob") && hasRow(spoofMail.html, "Name", "<b>Bob (Truck Fund)</b>"));
	}
	ok("§6 heading 'Call request', '[STAGING] ' only on staging",
		callProd.html.includes(">Call request</h2>") && !callProd.html.includes("[STAGING]") && callStg.html.includes(">[STAGING] Call request</h2>"));
	ok("§6 the intro names the form, and the staging site only on staging",
		callProd.html.includes("Someone asked LogisX to call them through the website's \"Schedule a call\" form. Reply to this email or call them back at the time they chose.") &&
		callStg.html.includes("\"Schedule a call\" form on the staging site. Reply to this email"));
	ok("§6 every row, with labels for the choices",
		hasRow(callProd.html, "Name", "<b>Carl O. Callback</b>") &&
		hasRow(callProd.html, "Email", '<a href="mailto:carl.callback@example.com">carl.callback@example.com</a>') &&
		hasRow(callProd.html, "Phone", "+1 (555) 010-0142") &&
		hasRow(callProd.html, "Topic", "Owning part of LogisX") &&
		hasRow(callProd.html, "Preferred date", "Thu, Oct 15, 2026") &&
		hasRow(callProd.html, "Time window", "Afternoon (12–5 pm)") &&
		hasRow(callProd.html, "Time zone", "Mountain") &&
		hasRow(callProd.html, "Message", '<div style="white-space:pre-wrap;line-height:1.5">Afternoons suit me best.\nThanks.</div>') &&
		hasRow(callProd.html, "Consent", "Agreed to be contacted by LogisX about this request and has read the Privacy Policy") &&
		hasRow(callProd.html, "Submitted", "Oct 7, 2026, 11:04 AM EDT (2026-10-07T15:04:05Z)"));
	ok("§6 ... in the contract's order, with no Company row",
		(() => { const at2 = ["Name", "Email", "Phone", "Topic", "Preferred date", "Time window", "Time zone", "Message", "Consent", "Submitted"].map((l) => callProd.html.indexOf(`>${l}</td>`)); return at2.every((v, i) => v > 0 && (i === 0 || v > at2[i - 1])) && !callProd.html.includes(">Company</td>"); })());
	ok("§6 the call email keeps the RFI's layout and footer",
		callProd.html.startsWith(prodMail.html.slice(0, prodMail.html.indexOf("<h2"))) && callProd.html.endsWith(prodMail.html.slice(prodMail.html.indexOf("</table>"))));
	const labelled = (field, value) => rfi.buildCallRequestEmail(checkCall({ ...CALL, [field]: value }).value, { staging: false, submittedAt: at }).html;
	ok("§6 every time window shows its label",
		hasRow(labelled("timeWindow", "morning"), "Time window", "Morning (8 am–12 pm)") && hasRow(labelled("timeWindow", "evening"), "Time window", "Evening (5–7 pm)"));
	ok("§6 every time zone shows its label",
		["Eastern", "Central", "Mountain", "Pacific"].every((label) => hasRow(labelled("timeZone", label.toLowerCase()), "Time zone", label)));
	ok("§6 every topic shows its label, in the subject too",
		[["truck-fund", "Truck Fund"], ["owning-logisx", "Owning part of LogisX"], ["broker-free-platform", "Broker-free platform"], ["other", "Other"]].every(([v, label]) =>
			hasRow(labelled("topic", v), "Topic", label) &&
			rfi.buildCallRequestEmail(checkCall({ ...CALL, topic: v }).value, { staging: false, submittedAt: at }).subject === `Call request: ${label}`));
	ok("§6 the preferred date is formatted as the day it names",
		hasRow(labelled("preferredDate", "2027-01-01"), "Preferred date", "Fri, Jan 1, 2027") && hasRow(labelled("preferredDate", "2026-10-07"), "Preferred date", "Wed, Oct 7, 2026"));
	// The phone check refuses markup now (§6 above), so the email builder is
	// handed a hostile phone directly: escaping must not depend on validation.
	const hostileCall = checkCall({ ...CALL, fullName: "<img src=x onerror=alert(1)>", email: "o'brien&co@example.com", message: "<script>x</script>" });
	ok("§6 markup in the phone is refused before any email is built", refusedAs(checkCall({ ...CALL, phone: "\"><b>" }), "INVALID_FIELD", "phone"));
	const hostileCallMail = rfi.buildCallRequestEmail({ ...hostileCall.value, phone: "\"><b>" }, { staging: false, submittedAt: at });
	ok("§6 every call value is HTML-escaped",
		hostileCall.ok === true && !hostileCallMail.html.includes("<img src=x") && !hostileCallMail.html.includes("<script>") &&
		hostileCallMail.html.includes("&lt;img src=x onerror=alert(1)&gt;") && hostileCallMail.html.includes("&quot;&gt;&lt;b&gt;") &&
		hostileCallMail.html.includes("&lt;script&gt;x&lt;/script&gt;") &&
		hostileCallMail.html.includes('href="mailto:o&#39;brien&amp;co@example.com">o&#39;brien&amp;co@example.com</a>'));
	ok("§6 an empty message shows 'Not given'", hasRow(labelled("message", ""), "Message", '<span style="color:#94a3b8">Not given</span>'));

	const capturedBeforeCalls = captured.length;
	{
		const { app, sent } = buildApp();
		const server = await listen(app);
		let r = await request(server, asJson(STAGING, CALL));
		ok("§6 valid call (JSON) from staging → 200 { ok: true }", r.status === 200 && r.json && r.json.ok === true);
		ok("§6 ... sends exactly one email: '[STAGING] Call request: …', Reply-To the submitter",
			sent.length === 1 && sent[0].to === ADMIN && sent[0].subject === "[STAGING] Call request: Owning part of LogisX" &&
			sent[0].opts && sent[0].opts.replyTo === CALL.email && sent[0].html.includes(">[STAGING] Call request</h2>"));
		r = await request(server, asForm(PROD, CALL_FORM));
		ok("§6 valid call (form) from logisx.com → 303 to the call form, ?call=sent#schedule-a-call",
			r.status === 303 && r.headers.location === CALL_SENT(PROD));
		ok("§6 ... sends one email, no [STAGING] prefix, with the form's values",
			sent.length === 2 && sent[1].subject === "Call request: Owning part of LogisX" && !sent[1].html.includes("[STAGING]") &&
			hasRow(sent[1].html, "Preferred date", "Thu, Oct 15, 2026") && hasRow(sent[1].html, "Time zone", "Mountain"));
		r = await request(server, asForm(STAGING, CALL_FORM));
		ok("§6 a call form from staging is sent back to staging", r.status === 303 && r.headers.location === CALL_SENT(STAGING));
		const before = sent.length;
		r = await request(server, asJson(PROD, { ...CALL, phone: "" }));
		ok("§6 phone missing (JSON) → 400 FIELD_REQUIRED phone", r.status === 400 && r.json.code === "FIELD_REQUIRED" && r.json.field === "phone");
		r = await request(server, asJson(PROD, { ...CALL, preferredDate: "2026-02-30" }));
		ok("§6 impossible date (JSON) → 400 INVALID_FIELD preferredDate", r.status === 400 && r.json.code === "INVALID_FIELD" && r.json.field === "preferredDate");
		r = await request(server, asJson(PROD, { ...CALL, kind: "meeting" }));
		ok("§6 an unknown kind (JSON) → 400 INVALID_FIELD kind", r.status === 400 && r.json.code === "INVALID_FIELD" && r.json.field === "kind");
		r = await request(server, asJson(PROD, { ...CALL, consent: false }));
		ok("§6 no consent (JSON) → 400 CONSENT_REQUIRED, the call's message",
			r.status === 400 && r.json.code === "CONSENT_REQUIRED" && r.json.error === "Please agree to be contacted about your request.");
		r = await request(server, asForm(PROD, { ...CALL_FORM, phone: "" }));
		ok("§6 phone missing (form) → 303 ?call=error#schedule-a-call", r.status === 303 && r.headers.location === CALL_ERROR(PROD));
		r = await request(server, asForm(PROD, { ...CALL_FORM, kind: "meeting" }));
		ok("§6 an unknown kind (form) → 303 to the RFI's ?error=1", r.status === 303 && r.headers.location === "https://logisx.com/invest-in-logisx?error=1");
		r = await request(server, asForm(PROD, `${new URLSearchParams(CALL_FORM).toString()}&topic=other`));
		ok("§6 a call form key sent twice → 303 ?call=error#schedule-a-call", r.status === 303 && r.headers.location === CALL_ERROR(PROD));
		ok("§6 ... and no refused call sent an email", sent.length === before);
		server.close();
	}

	{
		const { app, sent } = buildApp();
		const server = await listen(app);
		const answers = [];
		for (const [field, value] of [["preferredDate", undefined], ["preferredDate", "2026-10-06"], ["preferredDate", "2027-02-05"], ["timeWindow", undefined], ["timeWindow", "noon"], ["timeZone", ""], ["timeZone", "hawaii"], ["topic", undefined], ["topic", "pricing"]]) {
			const payload = { ...CALL };
			if (value === undefined) delete payload[field]; else payload[field] = value;
			const r = await request(server, asJson(PROD, payload));
			answers.push(r.status === 400 && r.json.field === field && r.json.code === (value === undefined || value === "" ? "FIELD_REQUIRED" : "INVALID_FIELD"));
		}
		ok("§6 over HTTP: date missing / yesterday / 121 days, and each choice missing or unknown → 400 with its field and code", answers.length === 9 && answers.every(Boolean));
		const r = await request(server, asForm(PROD, { ...CALL_FORM, preferredDate: "2027-02-05" }));
		ok("§6 a date out of range (form) → 303 ?call=error#schedule-a-call", r.status === 303 && r.headers.location === CALL_ERROR(PROD));
		ok("§6 ... and none of them sent an email", sent.length === 0);
		server.close();
	}

	{
		const { app, sent } = buildApp();
		const server = await listen(app);
		let r = await request(server, asJson(PROD, { ...CALL, website: "http://bot.example" }));
		ok("§6 honeypot on a call (JSON) → 200 { ok: true }", r.status === 200 && r.json.ok === true);
		r = await request(server, asForm(PROD, { ...CALL_FORM, website: "x" }));
		ok("§6 honeypot on a call (form) → 303 ?call=sent#schedule-a-call", r.status === 303 && r.headers.location === CALL_SENT(PROD));
		ok("§6 ... and the call honeypot sent nothing", sent.length === 0);
		r = await request(server, asForm("https://evil.example", CALL_FORM));
		ok("§6 a call form from a foreign Origin → 403 plain text, never a redirect",
			r.status === 403 && !r.headers.location && r.text === "This form can only be sent from logisx.com.");
		server.close();
	}

	{
		// One limiter for both kinds: 5 RFIs and 5 calls use up the window.
		const { app, sent } = buildApp();
		const server = await listen(app);
		const statuses = [];
		for (let i = 0; i < rfi.RFI_RATE_LIMIT; i++) statuses.push((await request(server, asJson(PROD, i % 2 ? CALL : VALID))).status);
		ok("§6 RFIs and calls share the rate-limit window", statuses.every((s) => s === 200) && sent.length === rfi.RFI_RATE_LIMIT);
		let r = await request(server, asJson(PROD, CALL));
		ok(`§6 a call as request ${rfi.RFI_RATE_LIMIT + 1} → 429 RATE_LIMITED (JSON)`, r.status === 429 && r.json.code === "RATE_LIMITED");
		r = await request(server, asForm(PROD, CALL_FORM));
		ok("§6 a call over the limit (form) → 303 ?call=error#schedule-a-call", r.status === 303 && r.headers.location === CALL_ERROR(PROD));
		r = await request(server, asForm(PROD, { ...VALID, consent: "true" }));
		ok("§6 an RFI over the same limit (form) → 303 ?error=1", r.status === 303 && r.headers.location === "https://logisx.com/invest-in-logisx?error=1");
		ok("§6 ... and nothing over the limit was sent", sent.length === rfi.RFI_RATE_LIMIT);
		server.close();
	}

	{
		// One daily cap for both kinds.
		const sent = [];
		const app = express();
		app.use(rfi.INVESTOR_RFI_PATH, ...rfi.createBodyParsers());
		app.post(rfi.INVESTOR_RFI_PATH, ...rfi.createInvestorRfiMiddleware({ sendEmail: async (...a) => { sent.push(a); return true; }, to: ADMIN, now: () => NOW, dailySendCap: 2 }));
		const server = await listen(app);
		const first = [await request(server, asJson(PROD, VALID)), await request(server, asJson(PROD, CALL))];
		ok("§6 an RFI and a call both count toward the daily cap", first.every((r) => r.status === 200) && sent.length === 2);
		let r = await request(server, asJson(PROD, CALL));
		ok("§6 a call over the shared daily cap (JSON) → 503 SEND_FAILED", r.status === 503 && r.json.code === "SEND_FAILED");
		r = await request(server, asForm(PROD, CALL_FORM));
		ok("§6 a call over the cap (form) → 303 ?call=error#schedule-a-call", r.status === 303 && r.headers.location === CALL_ERROR(PROD));
		r = await request(server, asJson(PROD, VALID));
		ok("§6 an RFI over the same cap → 503", r.status === 503);
		ok("§6 ... and nothing over the cap was sent", sent.length === 2);
		server.close();
	}

	{
		const { app, sent } = buildApp({ sendResult: false });
		const server = await listen(app);
		let r = await request(server, asJson(PROD, CALL));
		ok("§6 a failed call send (JSON) → 502 SEND_FAILED", r.status === 502 && r.json.code === "SEND_FAILED");
		r = await request(server, asForm(PROD, CALL_FORM));
		ok("§6 a failed call send (form) → 303 ?call=error#schedule-a-call", r.status === 303 && r.headers.location === CALL_ERROR(PROD));
		ok("§6 ... the sender was asked both times", sent.length === 2);
		server.close();
	}

	{
		// No inbox (server.js without ADMIN_NOTIFY_EMAIL): a call is answered like
		// a failed send and nothing is sent, the same as an RFI.
		const sent = [];
		const app = express();
		app.use(rfi.INVESTOR_RFI_PATH, ...rfi.createBodyParsers());
		app.post(rfi.INVESTOR_RFI_PATH, ...rfi.createInvestorRfiMiddleware({ sendEmail: async (...a) => { sent.push(a); return true; }, now: () => NOW }));
		const server = await listen(app);
		let r = await request(server, asJson(PROD, CALL));
		ok("§6 a call with no inbox (JSON) → 503 SEND_FAILED", r.status === 503 && r.json.code === "SEND_FAILED");
		r = await request(server, asForm(PROD, CALL_FORM));
		ok("§6 a call with no inbox (form) → 303 ?call=error#schedule-a-call", r.status === 303 && r.headers.location === CALL_ERROR(PROD));
		ok("§6 ... and nothing is sent", sent.length === 0);
		server.close();
	}

	{
		const { app } = buildApp({ sendResult: () => { throw new Error(`smtp said no to ${CALL.email} at ${CALL.phone}`); } });
		const server = await listen(app);
		const r = await request(server, asForm(PROD, CALL_FORM));
		ok("§6 a sender that throws on a call (form) → 303 ?call=error#schedule-a-call", r.status === 303 && r.headers.location === CALL_ERROR(PROD));
		server.close();
	}

	{
		// The body parsers' error answer reads `kind` from a parsed body. Express
		// skips the parsers once an error is passed, so this reaches onError with
		// a body already in place.
		const app = express();
		const preParsed = (req, _res, next) => { req.body = { kind: "call" }; next(Object.assign(new Error("too large"), { type: "entity.too.large" })); };
		app.use(rfi.INVESTOR_RFI_PATH, preParsed, ...rfi.createBodyParsers());
		const server = await listen(app);
		let r = await request(server, asForm(PROD, CALL_FORM));
		ok("§6 a body-parser refusal of a call (form) → 303 ?call=error#schedule-a-call", r.status === 303 && r.headers.location === CALL_ERROR(PROD));
		r = await request(server, asJson(PROD, CALL));
		ok("§6 ... and as JSON it stays 413 BODY_TOO_LARGE", r.status === 413 && r.json && r.json.code === "BODY_TOO_LARGE");
		server.close();
	}

	{
		// A REAL oversized no-JavaScript call (2026-10-08): the parser refuses the
		// body before reading it, so only the action's `?kind=call` can say it was
		// a call. Without the query it stays the RFI's answer.
		const { app, sent } = buildApp();
		const server = await listen(app);
		const huge = { ...CALL_FORM, message: "x".repeat(40_000) };
		let r = await request(server, { urlPath: `${rfi.INVESTOR_RFI_PATH}?kind=call`, ...asForm(PROD, huge) });
		ok("§6 an oversized call (form, ?kind=call) → 303 ?call=error#schedule-a-call", r.status === 303 && r.headers.location === CALL_ERROR(PROD));
		r = await request(server, asForm(PROD, huge));
		ok("§6 ... the same body without ?kind=call → the RFI's ?error=1", r.status === 303 && r.headers.location === "https://logisx.com/invest-in-logisx?error=1");
		r = await request(server, { urlPath: `${rfi.INVESTOR_RFI_PATH}?kind=call`, ...asJson(PROD, huge) });
		ok("§6 ... and as JSON it stays 413 BODY_TOO_LARGE", r.status === 413 && r.json && r.json.code === "BODY_TOO_LARGE");
		r = await request(server, { urlPath: `${rfi.INVESTOR_RFI_PATH}?kind=call`, ...asForm(PROD, CALL_FORM) });
		ok("§6 a valid call posted to ?kind=call is sent as usual", r.status === 303 && r.headers.location === CALL_SENT(PROD) && sent.length === 1);
		r = await request(server, { urlPath: `${rfi.INVESTOR_RFI_PATH}?kind=call`, ...asForm(PROD, { ...VALID, consent: "true" }) });
		ok("§6 ?kind=call never turns a parsed RFI body into a call (validated and answered as the RFI)",
			r.status === 303 && r.headers.location === "https://logisx.com/invest-in-logisx?sent=1" && sent.length === 2 && sent[1].subject === "Investor RFI: Jane Q. Sample");
		server.close();
	}

	// --- §7 a call's return page ------------------------------------------------------
	{
		const INVEST = "/invest-in-logisx";
		const cases = [
			[PROD, `${PROD}/contact`, "/contact", "the Referer /contact → /contact"],
			[PROD, `${PROD}${INVEST}`, INVEST, "the Referer /invest-in-logisx → /invest-in-logisx"],
			[STAGING, `${STAGING}/contact`, "/contact", "from staging, the Referer /contact → staging's /contact"],
			[STAGING, `${STAGING}${INVEST}`, INVEST, "from staging, the Referer /invest-in-logisx → staging's /invest-in-logisx"],
			[PROD, `${PROD}/contact/`, "/contact", "a trailing slash is ignored"],
			[PROD, `${PROD}${INVEST}?call=error&x=1`, INVEST, "the Referer's query is dropped (a second try after an error)"],
			[PROD, undefined, "/contact", "no Referer → /contact"],
			[PROD, `${PROD}/truck-fund`, "/contact", "any other page → /contact"],
			[PROD, `${PROD}${INVEST}/more`, "/contact", "a longer path → /contact (exact match only)"],
			[PROD, `${PROD}/Contact`, "/contact", "another casing → /contact (exact match only)"],
			[PROD, `${STAGING}${INVEST}`, "/contact", "a Referer on another of our origins → /contact on the validated origin"],
			[PROD, `https://other.example${INVEST}`, "/contact", "a Referer on another site → /contact on the validated origin"],
			[PROD, "not a url", "/contact", "a Referer that is not a URL → /contact"],
		];
		for (const [origin, referer, page, label] of cases) {
			const { app, sent } = buildApp();
			const server = await listen(app);
			const r = await request(server, asForm(origin, CALL_FORM, { referer }));
			ok(`§7 ${label}`, r.status === 303 && r.headers.location === CALL_SENT(origin, page) && sent.length === 1);
			server.close();
		}
		{
			const { app } = buildApp({ sendResult: false });
			const server = await listen(app);
			const r = await request(server, asForm(PROD, CALL_FORM, { referer: `${PROD}${INVEST}` }));
			ok("§7 a failed send goes back to the page it came from (?call=error)", r.status === 303 && r.headers.location === CALL_ERROR(PROD, INVEST));
			server.close();
		}
		{
			const { app, sent } = buildApp();
			const server = await listen(app);
			let r = await request(server, asForm(PROD, { ...CALL_FORM, phone: "" }, { referer: `${PROD}${INVEST}` }));
			ok("§7 a refused call goes back to the page it came from (?call=error)", r.status === 303 && r.headers.location === CALL_ERROR(PROD, INVEST));
			r = await request(server, { urlPath: `${rfi.INVESTOR_RFI_PATH}?kind=call`, ...asForm(PROD, { ...CALL_FORM, message: "x".repeat(40_000) }, { referer: `${PROD}${INVEST}` }) });
			ok("§7 a body-parser refusal (?kind=call) goes back to the page it came from", r.status === 303 && r.headers.location === CALL_ERROR(PROD, INVEST));
			r = await request(server, asForm(PROD, { ...VALID, consent: "true" }, { referer: `${PROD}/contact` }));
			ok("§7 the RFI's redirect never reads the Referer", r.status === 303 && r.headers.location === `${PROD}${INVEST}?sent=1`);
			r = await request(server, asJson(PROD, CALL, { Referer: `${PROD}/contact` }));
			ok("§7 a call as JSON is still answered with JSON, no redirect", r.status === 200 && r.json && r.json.ok === true && !r.headers.location);
			ok("§7 ... and only the RFI and the JSON call were sent", sent.length === 2);
			server.close();
		}
		ok("§7 the call's return pages are exactly /contact and /invest-in-logisx, /contact by default",
			JSON.stringify(rfi.CALL_FORM_PATHS) === JSON.stringify(["/contact", INVEST]) && rfi.CALL_FORM_DEFAULT_PATH === "/contact");
	}

	console.warn = realConsole.warn; console.error = realConsole.error;
	const typed = [VALID.fullName, VALID.email, VALID.phone, VALID.company, "Interested in the data room", "jane.sample",
		CALL.fullName, CALL.email, CALL.phone, "Afternoons suit me best", "carl.callback", "2026-10-15"];
	ok("§3 nothing a visitor typed reached the console", captured.every((line) => typed.every((t) => !line.includes(t))));
	ok("§6 the call failures above logged their outcome lines",
		["daily cap of 2 emails reached", "the notification email was not sent", "submission failed"].every((t) => captured.slice(capturedBeforeCalls).some((line) => line.startsWith("investor-rfi:") && line.includes(t))));
	ok("§3 the failures above did log an outcome line", captured.some((line) => line.includes("investor-rfi:")));

	// --- §8 the hourly limits per client address ------------------------------------------
	ok("§8 the hourly limits: 5 that pass the checks, 30 they refuse, per address per hour",
		rfi.RFI_HOURLY_LIMIT === 5 && rfi.RFI_REFUSED_HOURLY_LIMIT === 30 && rfi.RFI_HOURLY_WINDOW_MS === 60 * 60 * 1000);
	// One run against a lib (the real one here, mutants in §5), with both hourly
	// limits at their defaults and the 15-minute limit raised out of the way (§3
	// and §6 test that one). The app trusts one proxy hop and every request
	// carries X-Forwarded-For, as server.js (`trust proxy`, 1) and the website
	// vhosts ($remote_addr) do. Addresses from the documentation range.
	const hourlyScenario = async (lib) => {
		const sent = [];
		const app = express();
		app.set("trust proxy", 1);
		app.use(lib.INVESTOR_RFI_PATH, ...lib.createBodyParsers());
		app.post(lib.INVESTOR_RFI_PATH, ...lib.createInvestorRfiMiddleware({ sendEmail: async (...a) => { sent.push(a); return true; }, to: ADMIN, now: () => NOW, windowLimit: 1000 }));
		const server = await listen(app);
		const from = (ip, shape) => ({ ...shape, headers: { ...shape.headers, "X-Forwarded-For": ip } });
		const send = (ip, shape) => request(server, from(ip, shape));
		const REFUSED = { ...CALL, fullName: "" };
		const out = {};
		// A: five sent, RFIs and calls mixed; then a call, an RFI form and a call form over the limit.
		out.aServed = [];
		for (let i = 0; i < 5; i++) {
			const r = await send("203.0.113.10", asJson(PROD, i % 2 ? CALL : VALID));
			if (i === 0) out.aFirst = r;
			out.aServed.push(r.status);
		}
		out.aSentAtLimit = sent.length;
		out.aCallJson = await send("203.0.113.10", asJson(PROD, CALL));
		out.aRfiForm = await send("203.0.113.10", asForm(PROD, { ...VALID, consent: "true" }));
		out.aCallForm = await send("203.0.113.10", asForm(PROD, CALL_FORM));
		out.aSentAfter = sent.length;
		// B: five refused tries, then five that pass.
		out.bRefused = [];
		for (let i = 0; i < 5; i++) out.bRefused.push((await send("203.0.113.20", asJson(PROD, REFUSED))).status);
		const sentBeforeB = sent.length;
		out.bValid = [];
		for (let i = 0; i < 5; i++) out.bValid.push((await send("203.0.113.20", asJson(PROD, i % 2 ? CALL : VALID))).status);
		out.bSent = sent.length - sentBeforeB;
		// D: thirty refused, then one more (over), then one that passes.
		out.dRefused = [];
		for (let i = 0; i < 30; i++) {
			const r = await send("203.0.113.40", asJson(PROD, REFUSED));
			if (i === 0) out.dFirst = r;
			out.dRefused.push(r.status);
		}
		out.dOver = await send("203.0.113.40", asJson(PROD, REFUSED));
		out.dOverForm = await send("203.0.113.40", asForm(PROD, { ...CALL_FORM, fullName: "" }));
		out.dValid = await send("203.0.113.40", asJson(PROD, CALL));
		// E: five that pass, then thirty refused, then one more (over).
		out.eValid = [];
		for (let i = 0; i < 5; i++) out.eValid.push((await send("203.0.113.50", asJson(PROD, VALID))).status);
		out.eRefused = [];
		for (let i = 0; i < 30; i++) out.eRefused.push((await send("203.0.113.50", asJson(PROD, REFUSED))).status);
		out.eOver = await send("203.0.113.50", asJson(PROD, REFUSED));
		// F: five honeypot hits (answered as sent, nothing sent), then a real submission.
		out.fHoney = [];
		for (let i = 0; i < 5; i++) {
			const r = await send("203.0.113.60", asJson(PROD, { ...VALID, [lib.RFI_HONEYPOT_FIELD]: "https://spam.example" }));
			if (i === 0) out.fFirst = r;
			out.fHoney.push(r.status);
		}
		const sentBeforeF = sent.length;
		out.fValid = await send("203.0.113.60", asJson(PROD, VALID));
		out.fSent = sent.length - sentBeforeF;
		// C: a third address, its own counts.
		out.cValid = await send("203.0.113.30", asJson(PROD, CALL));
		server.close();
		return out;
	};
	{
		const s = await hourlyScenario(rfi);
		ok("§8 one address: its first 5 submissions (RFIs and calls mixed) are served and sent", s.aServed.every((x) => x === 200) && s.aSentAtLimit === 5);
		ok("§8 ... its 6th, a call (JSON) → 429 RATE_LIMITED", s.aCallJson.status === 429 && s.aCallJson.json && s.aCallJson.json.code === "RATE_LIMITED");
		ok("§8 ... an RFI form over the limit → 303 ?error=1", s.aRfiForm.status === 303 && s.aRfiForm.headers.location === `${PROD}/invest-in-logisx?error=1`);
		ok("§8 ... a call form over the limit → 303 ?call=error#schedule-a-call", s.aCallForm.status === 303 && s.aCallForm.headers.location === CALL_ERROR(PROD));
		ok("§8 ... and nothing over the limit was sent", s.aSentAfter === 5);
		ok("§8 refused tries don't count toward the 5: 5 refused (400), then 5 that pass are all served and sent",
			s.bRefused.every((x) => x === 400) && s.bValid.every((x) => x === 200) && s.bSent === 5);
		ok("§8 refused tries have their own limit: 30 refused (400), the 31st → 429 RATE_LIMITED",
			s.dRefused.length === 30 && s.dRefused.every((x) => x === 400) && s.dOver.status === 429 && s.dOver.json && s.dOver.json.code === "RATE_LIMITED");
		ok("§8 ... a refused form over that limit → 303 ?call=error#schedule-a-call", s.dOverForm.status === 303 && s.dOverForm.headers.location === CALL_ERROR(PROD));
		ok("§8 ... and a submission that passes is still served", s.dValid.status === 200);
		ok("§8 submissions that pass don't count toward the 30: 5 sent, then 30 refused (400), the 31st → 429",
			s.eValid.every((x) => x === 200) && s.eRefused.every((x) => x === 400) && s.eOver.status === 429);
		ok("§8 another address keeps its own counts", s.cValid.status === 200);
		ok("§8 the RateLimit-Policy header names 5 an hour on a submission that passes", s.aFirst.headers["ratelimit-policy"] === "5;w=3600");
		ok("§8 ... and 30 an hour on a refused one", s.dFirst.headers["ratelimit-policy"] === "30;w=3600");
		ok("§8 a honeypot hit counts like a submission that passes: 5 answered as sent, the next try → 429, nothing sent",
			s.fHoney.every((x) => x === 200) && s.fValid.status === 429 && s.fSent === 0);
		ok("§8 ... with a real submission's RateLimit-Policy (5 an hour), so the trap looks like the real thing", s.fFirst.headers["ratelimit-policy"] === "5;w=3600");
	}
	// (b) A check that throws (here the clock) is a refusal like any other: answered as
	// a failed send, counted toward the refused tries' limit, logged as one fixed line.
	const throwScenario = async (lib) => {
		const sent = [];
		const app = express();
		app.set("trust proxy", 1);
		app.use(lib.INVESTOR_RFI_PATH, ...lib.createBodyParsers());
		const boom = () => { throw new Error("clock failed for jane.sample@example.com"); };
		app.post(lib.INVESTOR_RFI_PATH, ...lib.createInvestorRfiMiddleware({ sendEmail: async (...a) => { sent.push(a); return true; }, to: ADMIN, now: boom, windowLimit: 1000 }));
		const server = await listen(app);
		const lines = [];
		const realError = console.error;
		console.error = (...a) => { lines.push(a.map(String).join(" ")); };
		const from = (shape) => ({ ...shape, headers: { ...shape.headers, "X-Forwarded-For": "203.0.113.70" } });
		try {
			const json = await request(server, from(asJson(PROD, CALL)));
			const form = await request(server, from(asForm(PROD, CALL_FORM)));
			return { json, form, sent: sent.length, lines };
		} finally {
			console.error = realError;
			server.close();
		}
	};
	{
		const t = await throwScenario(rfi);
		ok("§8 a check that throws → 500 SEND_FAILED (JSON) and the call form's error page; nothing sent",
			t.json.status === 500 && t.json.json && t.json.json.code === "SEND_FAILED" && t.form.status === 303 && t.form.headers.location === CALL_ERROR(PROD) && t.sent === 0);
		ok("§8 ... counted toward the refused tries' limit (30 an hour)", t.json.headers["ratelimit-policy"] === "30;w=3600");
		ok("§8 ... logged as one fixed outcome line each, never the error",
			t.lines.filter((l) => l === "investor-rfi: submission failed").length === 2 && !t.lines.some((l) => l.includes("jane.sample")));
	}

	// --- §4 wiring ------------------------------------------------------------------
	const parsersAt = SRC.indexOf("app.use(investorRfi.INVESTOR_RFI_PATH, ...investorRfi.createBodyParsers());");
	const bigJsonAt = SRC.indexOf('app.use(express.json({ limit: "50mb" }));');
	ok("§4 the RFI body parsers are mounted on the RFI path", parsersAt > 0);
	ok("§4 ... above the 50 MB JSON parser", parsersAt > 0 && bigJsonAt > parsersAt);
	ok("§4 the route mounts the middleware with the shared sendEmail, to ADMIN_NOTIFY_EMAIL",
		SRC.includes("app.post(investorRfi.INVESTOR_RFI_PATH, ...investorRfi.createInvestorRfiMiddleware({ sendEmail, to: ADMIN_NOTIFY_EMAIL }));"));
	// Code lines only: server.js's comments name express.urlencoded() in their warnings.
	const CODE = SRC.split("\n").filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join("\n");
	ok("§4 server.js mounts no form-encoded parser of its own", !/express\.urlencoded\s*\(/.test(CODE));
	ok("§4 createBodyParsers is mounted exactly once, with the path", (SRC.match(/createBodyParsers\(\)/g) || []).length === 1);
	ok("§4 sendEmail passes Reply-To only when given",
		/async function sendEmail\(to, subject, htmlBody, attachments = \[\], \{ replyTo \} = \{\}\)/.test(SRC) && SRC.includes("...(replyTo ? { replyTo } : {})"));
	ok("§4 the lib touches no database", !/better-sqlite3|\bdb\.(prepare|exec|transaction)\b|logAudit/.test(LIB_SRC));
	ok("§4 the allowlist is exactly logisx.com and its staging site",
		[...rfi.RFI_ORIGINS.keys()].sort().join(" ") === `${PROD} ${STAGING}` && rfi.RFI_ORIGINS.get(STAGING).staging === true && rfi.RFI_ORIGINS.get(PROD).staging === false);
	ok("§4 the website is not added to DRIVER_MOBILE_ORIGINS", !/DRIVER_MOBILE_ORIGINS[^\n]*logisx\.com/.test(SRC));

	// --- §5 discrimination ------------------------------------------------------------
	const loadLib = (src) => {
		const m = { exports: {} };
		new Function("module", "exports", "require", src)(m, m.exports, (id) => require(id.startsWith(".") ? path.join(ROOT, "lib", id) : id));
		return m.exports;
	};
	const noConsent = loadLib(LIB_SRC.replace("if (!CONSENT_VALUES.has(src.consent)) return", "if (false) return"));
	ok("MUTANT: dropping the consent check is caught by §1", noConsent.checkInvestorRfi({ ...VALID, consent: undefined }).ok === true);
	const noTrap = loadLib(LIB_SRC.replace('String(trap) !== ""', "false"));
	ok("MUTANT: an unchecked honeypot is caught by §1", noTrap.checkInvestorRfi({ ...VALID, website: "x" }).honeypot === false);
	const optionalPhone = loadLib(LIB_SRC.replace("checkPhone(src.phone, { required: true })", "checkPhone(src.phone)"));
	ok("MUTANT: a call without the phone requirement is caught by §6",
		optionalPhone.checkWebsiteForm({ ...CALL, phone: "" }, { now: NOW }).ok === true);
	// The phone's shape (§1, §6). Each mutant must change the source, and the
	// check named must then pass a phone the real code refuses.
	for (const [label, src, slips] of [
		["a phone of any characters", LIB_SRC.replace("!PHONE_RE.test(text.value) || ", ""),
			(lib) => lib.checkWebsiteForm({ ...CALL, phone: "call 555-0100" }, { now: NOW }).ok === true],
		["dots refused in a phone", LIB_SRC.replace("const PHONE_RE = /^[0-9 .+()-]{7,20}$/;", "const PHONE_RE = /^[0-9 +()-]{7,20}$/;"),
			(lib) => lib.checkWebsiteForm({ ...CALL, phone: "555.010.0199" }, { now: NOW }).ok === false],
		["underscores allowed in a phone", LIB_SRC.replace("const PHONE_RE = /^[0-9 .+()-]{7,20}$/;", "const PHONE_RE = /^[0-9 ._+()-]{7,20}$/;"),
			(lib) => lib.checkWebsiteForm({ ...CALL, phone: "555_010_0199" }, { now: NOW }).ok === true],
		["a phone with no digit minimum", LIB_SRC.replace("digits < PHONE_MIN_DIGITS", "false"),
			(lib) => lib.checkWebsiteForm({ ...CALL, phone: "+(-) (-)" }, { now: NOW }).ok === true],
		["the RFI's phone left unchecked", LIB_SRC.replace("const phone = checkPhone(src.phone);", 'const phone = checkText(src.phone, "phone");'),
			(lib) => lib.checkInvestorRfi({ ...VALID, phone: "call 555-0100" }).ok === true],
		["the old 40-character phone cap", LIB_SRC.replace("phone: 20,", "phone: 40,"),
			(lib) => lib.checkWebsiteForm({ ...CALL, phone: "1".repeat(21) }, { now: NOW }).code !== "FIELD_TOO_LONG"],
	]) {
		ok(`MUTANT: ${label} is caught by §1/§6`, src !== LIB_SRC && slips(loadLib(src)));
	}
	// The hourly limits (§8): run the same scenario on each mutant; what it lets
	// through, or wrongly refuses, is what §8 checks.
	for (const [label, src, slips] of [
		["no hourly limit on submissions that pass", LIB_SRC.replace("return [originGuard, limiter, validate, refusedLimiter, hourlyLimiter, handle];", "return [originGuard, limiter, validate, refusedLimiter, handle];"),
			(s) => s.aCallJson.status !== 429 && s.aSentAfter > 5],
		["no limit on refused tries", LIB_SRC.replace("return [originGuard, limiter, validate, refusedLimiter, hourlyLimiter, handle];", "return [originGuard, limiter, validate, hourlyLimiter, handle];"),
			(s) => s.dOver.status !== 429],
		["refused tries counted toward the 5", LIB_SRC.replace("skip: (req, res) => !passedChecks(res),", ""),
			(s) => !s.bValid.every((x) => x === 200)],
		["submissions that pass counted toward the 30", LIB_SRC.replace("skip: (req, res) => passedChecks(res),", ""),
			(s) => !s.eRefused.every((x) => x === 400)],
		["one hourly count for every address", LIB_SRC.replace("const hourlyLimiter = rateLimit({", 'const hourlyLimiter = rateLimit({ keyGenerator: () => "everyone",'),
			(s) => s.cValid.status !== 200],
		["a 15-minute window", LIB_SRC.replace("const RFI_HOURLY_WINDOW_MS = 60 * 60 * 1000;", "const RFI_HOURLY_WINDOW_MS = 15 * 60 * 1000;"),
			(s) => s.aFirst.headers["ratelimit-policy"] !== "5;w=3600"],
		["a limit of 10 an hour", LIB_SRC.replace("const RFI_HOURLY_LIMIT = 5;", "const RFI_HOURLY_LIMIT = 10;"),
			(s) => s.aCallJson.status !== 429],
		["a refused limit of 100 an hour", LIB_SRC.replace("const RFI_REFUSED_HOURLY_LIMIT = 30;", "const RFI_REFUSED_HOURLY_LIMIT = 100;"),
			(s) => s.dOver.status !== 429],
		["honeypot hits counted as refused tries", LIB_SRC.replace("const passedChecks = (res) => res.locals.rfiCheck.ok === true;", "const passedChecks = (res) => res.locals.rfiCheck.ok === true && !res.locals.rfiCheck.honeypot;"),
			(s) => s.fValid.status !== 429],
	]) {
		ok(`MUTANT: ${label} is caught by §8`, src !== LIB_SRC && slips(await hourlyScenario(loadLib(src))));
	}
	{
		const src = LIB_SRC.replace('res.locals.rfiCheck = refusal("SEND_FAILED", null, MESSAGES.send_failed, 500);', 'return respond(req, res, refusal("SEND_FAILED", null, MESSAGES.send_failed, 500));');
		const t = src !== LIB_SRC ? await throwScenario(loadLib(src)) : null;
		ok("MUTANT: a check that throws skipping the hourly limits is caught by §8", !!t && t.json.headers["ratelimit-policy"] !== "30;w=3600");
	}
	const anyKind = loadLib(LIB_SRC.replace('if (!kind) return refusal("INVALID_FIELD", "kind", MESSAGES.invalid);', ""));
	ok("MUTANT: an unchecked kind is caught by §6", anyKind.checkWebsiteForm({ ...VALID, kind: "meeting" }).ok === true);
	const utcToday = loadLib(LIB_SRC.replace("calendarDayNumber(businessDate(now))", "calendarDayNumber(now.toISOString().slice(0, 10))"));
	ok("MUTANT: a UTC 'today' is caught by §6",
		utcToday.checkWebsiteForm({ ...CALL, preferredDate: "2026-10-07" }, { now: LATE_EVENING }).ok === false);
	const noUpperBound = loadLib(LIB_SRC.replace(" || day > today + CALL_MAX_DAYS_AHEAD", ""));
	ok("MUTANT: a date with no upper bound is caught by §6",
		noUpperBound.checkWebsiteForm({ ...CALL, preferredDate: "2027-02-05" }, { now: NOW }).ok === true);
	for (const [label, src] of [
		["a call answered with the RFI's redirect", LIB_SRC.replace("if (isCallForm(req)) {", "if (false) {")],
		["a call mailed as an RFI", LIB_SRC.replace('check.kind === "call" ? buildCallRequestEmail : buildInvestorRfiEmail', "buildInvestorRfiEmail")],
	]) {
		const mutant = loadLib(src);
		const sent = [];
		const app = express();
		app.use(mutant.INVESTOR_RFI_PATH, ...mutant.createBodyParsers());
		app.post(mutant.INVESTOR_RFI_PATH, ...mutant.createInvestorRfiMiddleware({ sendEmail: async (to, subject) => { sent.push(subject); return true; }, to: ADMIN, now: () => NOW }));
		const server = await listen(app);
		const r = await request(server, asForm(PROD, CALL_FORM));
		ok(`MUTANT: ${label} is caught by §6`, r.headers.location !== CALL_SENT(PROD) || sent[0] !== "Call request: Owning part of LogisX");
		server.close();
	}
	const noStrip = loadLib(LIB_SRC.replace('const value = stripInvisible(raw, { multiline }).trim();', "const value = raw.trim();"));
	ok("MUTANT: text fields that are not stripped are caught by §1",
		noStrip.checkInvestorRfi({ ...VALID, fullName: "Jane\u061CDoe" }).value.fullName !== "JaneDoe");
	const nameInSubject = loadLib(LIB_SRC.replace('subject: `${staging ? "[STAGING] " : ""}Call request: ${topicLabel}`', 'subject: `${staging ? "[STAGING] " : ""}Call request: ${call.fullName} (${topicLabel})`'));
	ok("MUTANT: the name back in the call subject is caught by §6",
		nameInSubject.buildCallRequestEmail(checkCall({ ...CALL, fullName: "Bob (Truck Fund)", topic: "other" }).value, { staging: false, submittedAt: at }).subject !== "Call request: Other");
	{
		const noQuery = loadLib(LIB_SRC.replace('return req.query && req.query.kind === "call";', "return false;"));
		const app = express();
		app.use(noQuery.INVESTOR_RFI_PATH, ...noQuery.createBodyParsers());
		const server = await listen(app);
		const r = await request(server, { urlPath: `${noQuery.INVESTOR_RFI_PATH}?kind=call`, ...asForm(PROD, { ...CALL_FORM, message: "x".repeat(40_000) }) });
		ok("MUTANT: ignoring ?kind=call on a parser refusal is caught by §6", r.headers.location !== CALL_ERROR(PROD));
		server.close();
	}
	for (const [label, src, referer] of [
		["a return page taken from the Referer without the allowlist", LIB_SRC.replace("return CALL_FORM_PATHS.find((page) => page === pathname) || CALL_FORM_DEFAULT_PATH;", "return pathname;"), `${PROD}/truck-fund`],
		["a Referer on another origin choosing the page", LIB_SRC.replace("if (url.origin !== origin) return CALL_FORM_DEFAULT_PATH;", ""), `${STAGING}/invest-in-logisx`],
		["a call sent back to /invest-in-logisx whatever its Referer", LIB_SRC.replace("${callReturnPath(req, origin)}?call=", "${RFI_PAGE_PATH}?call="), `${PROD}/contact`],
	]) {
		const mutant = loadLib(src);
		const app = express();
		app.use(mutant.INVESTOR_RFI_PATH, ...mutant.createBodyParsers());
		app.post(mutant.INVESTOR_RFI_PATH, ...mutant.createInvestorRfiMiddleware({ sendEmail: async () => true, to: ADMIN, now: () => NOW }));
		const server = await listen(app);
		const r = await request(server, asForm(PROD, CALL_FORM, { referer }));
		ok(`MUTANT: ${label} is caught by §7`, r.headers.location !== CALL_SENT(PROD, "/contact"));
		server.close();
	}
	const openOrigin = loadLib(LIB_SRC.replace("return origin && RFI_ORIGINS.has(origin) ? origin : null;", "return origin || null;"));
	{
		const sent = [];
		const app = express();
		app.use(openOrigin.INVESTOR_RFI_PATH, ...openOrigin.createBodyParsers());
		app.post(openOrigin.INVESTOR_RFI_PATH, ...openOrigin.createInvestorRfiMiddleware({ sendEmail: async (...a) => { sent.push(a); return true; }, to: ADMIN }));
		// The mutant has no allowlist entry to read `staging` from; it throws, and the route answers 500.
		const server = await listen(app);
		const r = await request(server, asJson("https://evil.example", VALID));
		ok("MUTANT: an origin guard without the allowlist is caught by §3", r.status !== 403);
		server.close();
	}
	console.warn = realConsole.warn;

	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((e) => {
	console.error("FAIL  runner crashed:", e);
	process.exit(1);
});
