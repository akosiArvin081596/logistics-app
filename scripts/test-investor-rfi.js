#!/usr/bin/env node
/**
 * POST /api/public/investor-rfi, the website's investor Request for Information
 * (lib/investor-rfi.js).
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 checkInvestorRfi(): required fields, the email check, length caps,
 *      control characters, one scalar per field, consent, and the honeypot
 *   §2 buildInvestorRfiEmail(): to info@logisx.com, Reply-To the submitter,
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
 *      refused; phone, preferredDate (a real date, today to 120 days ahead in
 *      Central, with `now` fixed), timeWindow, timeZone and topic are required
 *      and checked; the email's subject, heading, rows, labels and escaping;
 *      over HTTP: one email per valid call (JSON and form), the call
 *      redirects (sent, refusals, honeypot, rate limit, daily cap, failed
 *      send, body-parser refusal), and the limiter and daily cap shared with
 *      the RFI. Its submissions also feed §3's console check.
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
function buildApp({ sendResult = true } = {}) {
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
		now: () => new Date("2026-10-07T15:04:05.000Z"),
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
const asForm = (origin, payload) => ({
	headers: {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		...(origin ? { Origin: origin } : {}),
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
		const r = rfi.checkInvestorRfi({ ...VALID, [field]: "x".repeat(max + 1) });
		ok(`§1 ${field} over ${max} characters is refused`, r.ok === false && r.code === "FIELD_TOO_LONG" && r.field === field);
		ok(`§1 ${field} at exactly ${max} characters passes`, rfi.checkInvestorRfi({ ...VALID, [field]: "x".repeat(max) }).ok === true);
	}
	ok("§1 a CR/LF in the name (it goes into the subject) is refused",
		rfi.checkInvestorRfi({ ...VALID, fullName: "Jane\r\nBcc: x@example.com" }).code === "INVALID_FIELD");
	for (const [label, ch] of [["a right-to-left override", "\u202E"], ["a zero-width space", "\u200B"], ["a line separator", "\u2028"], ["a C1 control", "\u0085"], ["a byte-order mark", "\uFEFF"]]) {
		ok(`§1 ${label} in the name is refused`, rfi.checkInvestorRfi({ ...VALID, fullName: `Jane${ch}Doe` }).code === "INVALID_FIELD");
		ok(`§1 ${label} in the message is refused`, rfi.checkInvestorRfi({ ...VALID, message: `a${ch}b` }).code === "INVALID_FIELD");
	}
	ok("§1 accented and non-Latin names pass", rfi.checkInvestorRfi({ ...VALID, fullName: "José Ñúñez 李雷" }).ok === true);
	ok("§1 a NUL in the company is refused", rfi.checkInvestorRfi({ ...VALID, company: "A\u0000B" }).code === "INVALID_FIELD");
	ok("§1 line breaks and tabs are allowed in the message", rfi.checkInvestorRfi({ ...VALID, message: "a\r\nb\tc" }).ok === true);
	ok("§1 other control characters in the message are refused",
		rfi.checkInvestorRfi({ ...VALID, message: "a\u0007b" }).code === "INVALID_FIELD");
	for (const field of rfi.RFI_SCALAR_FIELDS) {
		const r = rfi.checkInvestorRfi({ ...VALID, [field]: ["a", "b"] });
		ok(`§1 ${field} sent twice (an array) is refused`, r.ok === false && r.code === "INVALID_FIELD");
	}
	ok("§1 consent sent twice (an array) is refused", rfi.checkInvestorRfi({ ...VALID, consent: ["true", "true"] }).code === "CONSENT_REQUIRED");
	ok("§1 an object for a field is refused", rfi.checkInvestorRfi({ ...VALID, company: { a: 1 } }).code === "INVALID_FIELD");
	ok("§1 a number for a text field is refused", rfi.checkInvestorRfi({ ...VALID, phone: 5550100 }).code === "INVALID_FIELD");
	ok("§1 a missing body is refused, not thrown", rfi.checkInvestorRfi(undefined).code === "FIELD_REQUIRED");
	const trapped = rfi.checkInvestorRfi({ ...VALID, [rfi.RFI_HONEYPOT_FIELD]: "https://spam.example" });
	ok("§1 a filled honeypot is answered as a silent drop", trapped.ok === true && trapped.honeypot === true && !trapped.value);
	ok("§1 a filled honeypot wins even over invalid fields",
		rfi.checkInvestorRfi({ [rfi.RFI_HONEYPOT_FIELD]: "x" }).honeypot === true);
	ok("§1 an empty honeypot passes", rfi.checkInvestorRfi({ ...VALID, [rfi.RFI_HONEYPOT_FIELD]: "" }).honeypot === false);

	// --- §2 buildInvestorRfiEmail --------------------------------------------------
	const at = new Date("2026-10-07T15:04:05.000Z");
	const prodMail = rfi.buildInvestorRfiEmail(good.value, { staging: false, submittedAt: at });
	const stgMail = rfi.buildInvestorRfiEmail(good.value, { staging: true, submittedAt: at });
	ok("§2 the email goes to info@logisx.com", prodMail.to === "info@logisx.com" && stgMail.to === "info@logisx.com");
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
		ok("§3 ... to info@logisx.com, '[STAGING] Investor RFI: <name>', Reply-To the submitter",
			sent[0] && sent[0].to === "info@logisx.com" && sent[0].subject === "[STAGING] Investor RFI: Jane Q. Sample" && sent[0].opts && sent[0].opts.replyTo === VALID.email);

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
		app.post(rfi.INVESTOR_RFI_PATH, ...rfi.createInvestorRfiMiddleware({ sendEmail: async (...a) => { sent.push(a); return true; }, dailySendCap: 2 }));
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
	// "Today" is fixed by `now`: 2026-10-07T15:04:05Z is 10:04 CDT on Wed Oct 7 in
	// Central, the same instant buildApp() gives the route.
	const NOW = new Date("2026-10-07T15:04:05.000Z");
	const LATE_EVENING = new Date("2026-10-08T03:00:00.000Z"); // 22:00 CDT, still Oct 7 in Central
	const AFTER_MIDNIGHT = new Date("2026-10-08T06:00:00.000Z"); // 01:00 CDT, Oct 8 in Central
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
	const CALL_SENT = (origin) => `${origin}/invest-in-logisx?call=sent#schedule-a-call`;
	const CALL_ERROR = (origin) => `${origin}/invest-in-logisx?call=error#schedule-a-call`;
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
	ok("§6 a phone over 40 characters is refused", checkCall({ ...CALL, phone: "1".repeat(41) }).code === "FIELD_TOO_LONG");
	ok("§6 a phone at exactly 40 characters passes", checkCall({ ...CALL, phone: "1".repeat(40) }).ok === true);
	ok("§6 a CR/LF in the phone is refused", refusedAs(checkCall({ ...CALL, phone: "555\r\n0100" }), "INVALID_FIELD", "phone"));
	ok("§6 a CR/LF in the name is refused", refusedAs(checkCall({ ...CALL, fullName: "Carl\r\nBcc: x@example.com" }), "INVALID_FIELD", "fullName"));
	ok("§6 the message is optional", (() => { const r = checkCall({ ...CALL, message: undefined }); return r.ok === true && r.value.message === ""; })());
	ok("§6 a message over 2,000 characters is refused", checkCall({ ...CALL, message: "x".repeat(2001) }).code === "FIELD_TOO_LONG");
	ok("§6 line breaks are allowed in the message, other controls are not",
		checkCall({ ...CALL, message: "a\r\nb\tc" }).ok === true && refusedAs(checkCall({ ...CALL, message: "a‮b" }), "INVALID_FIELD", "message"));
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
	ok("§6 'today' is Central: at 22:00 CDT (already Oct 8 in UTC) Oct 7 still passes",
		checkCall({ ...CALL, preferredDate: "2026-10-07" }, LATE_EVENING).ok === true);
	ok("§6 ... and the 121st day is still refused then",
		refusedAs(checkCall({ ...CALL, preferredDate: "2027-02-05" }, LATE_EVENING), "INVALID_FIELD", "preferredDate"));
	ok("§6 after midnight Central, the day before is refused",
		refusedAs(checkCall({ ...CALL, preferredDate: "2026-10-07" }, AFTER_MIDNIGHT), "INVALID_FIELD", "preferredDate"));
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
	const callProd = rfi.buildCallRequestEmail(goodCall.value, { staging: false, submittedAt: at });
	const callStg = rfi.buildCallRequestEmail(goodCall.value, { staging: true, submittedAt: at });
	ok("§6 the call email goes to info@logisx.com, Reply-To the submitter",
		callProd.to === "info@logisx.com" && callStg.to === "info@logisx.com" && callProd.replyTo === CALL.email);
	ok("§6 production subject: 'Call request: <name> (<topic label>)'", callProd.subject === "Call request: Carl O. Callback (Owning part of LogisX)");
	ok("§6 staging subject is prefixed '[STAGING] '", callStg.subject === "[STAGING] Call request: Carl O. Callback (Owning part of LogisX)");
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
		hasRow(callProd.html, "Submitted", "Oct 7, 2026, 10:04 AM CDT (2026-10-07T15:04:05Z)"));
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
			rfi.buildCallRequestEmail(checkCall({ ...CALL, topic: v }).value, { staging: false, submittedAt: at }).subject === `Call request: Carl O. Callback (${label})`));
	ok("§6 the preferred date is formatted as the day it names",
		hasRow(labelled("preferredDate", "2027-01-01"), "Preferred date", "Fri, Jan 1, 2027") && hasRow(labelled("preferredDate", "2026-10-07"), "Preferred date", "Wed, Oct 7, 2026"));
	const hostileCall = checkCall({ ...CALL, fullName: "<img src=x onerror=alert(1)>", email: "o'brien&co@example.com", phone: "\"><b>", message: "<script>x</script>" });
	const hostileCallMail = rfi.buildCallRequestEmail(hostileCall.value, { staging: false, submittedAt: at });
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
			sent.length === 1 && sent[0].to === "info@logisx.com" && sent[0].subject === "[STAGING] Call request: Carl O. Callback (Owning part of LogisX)" &&
			sent[0].opts && sent[0].opts.replyTo === CALL.email && sent[0].html.includes(">[STAGING] Call request</h2>"));
		r = await request(server, asForm(PROD, CALL_FORM));
		ok("§6 valid call (form) from logisx.com → 303 to /invest-in-logisx?call=sent#schedule-a-call",
			r.status === 303 && r.headers.location === CALL_SENT(PROD));
		ok("§6 ... sends one email, no [STAGING] prefix, with the form's values",
			sent.length === 2 && sent[1].subject === "Call request: Carl O. Callback (Owning part of LogisX)" && !sent[1].html.includes("[STAGING]") &&
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
		app.post(rfi.INVESTOR_RFI_PATH, ...rfi.createInvestorRfiMiddleware({ sendEmail: async (...a) => { sent.push(a); return true; }, now: () => NOW, dailySendCap: 2 }));
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

	console.warn = realConsole.warn; console.error = realConsole.error;
	const typed = [VALID.fullName, VALID.email, VALID.phone, VALID.company, "Interested in the data room", "jane.sample",
		CALL.fullName, CALL.email, CALL.phone, "Afternoons suit me best", "carl.callback", "2026-10-15"];
	ok("§3 nothing a visitor typed reached the console", captured.every((line) => typed.every((t) => !line.includes(t))));
	ok("§6 the call failures above logged their outcome lines",
		["daily cap of 2 emails reached", "the notification email was not sent", "submission failed"].every((t) => captured.slice(capturedBeforeCalls).some((line) => line.startsWith("investor-rfi:") && line.includes(t))));
	ok("§3 the failures above did log an outcome line", captured.some((line) => line.includes("investor-rfi:")));

	// --- §4 wiring ------------------------------------------------------------------
	const parsersAt = SRC.indexOf("app.use(investorRfi.INVESTOR_RFI_PATH, ...investorRfi.createBodyParsers());");
	const bigJsonAt = SRC.indexOf('app.use(express.json({ limit: "50mb" }));');
	ok("§4 the RFI body parsers are mounted on the RFI path", parsersAt > 0);
	ok("§4 ... above the 50 MB JSON parser", parsersAt > 0 && bigJsonAt > parsersAt);
	ok("§4 the route mounts the middleware with the shared sendEmail",
		SRC.includes("app.post(investorRfi.INVESTOR_RFI_PATH, ...investorRfi.createInvestorRfiMiddleware({ sendEmail }));"));
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
	const optionalPhone = loadLib(LIB_SRC.replace('checkText(src.phone, "phone", { required: true })', 'checkText(src.phone, "phone")'));
	ok("MUTANT: a call without the phone requirement is caught by §6",
		optionalPhone.checkWebsiteForm({ ...CALL, phone: "" }, { now: NOW }).ok === true);
	const anyKind = loadLib(LIB_SRC.replace('if (!kind) return refusal("INVALID_FIELD", "kind", MESSAGES.invalid);', ""));
	ok("MUTANT: an unchecked kind is caught by §6", anyKind.checkWebsiteForm({ ...VALID, kind: "meeting" }).ok === true);
	const utcToday = loadLib(LIB_SRC.replace("calendarDayNumber(centralDate(now))", "calendarDayNumber(now.toISOString().slice(0, 10))"));
	ok("MUTANT: a UTC 'today' is caught by §6",
		utcToday.checkWebsiteForm({ ...CALL, preferredDate: "2026-10-07" }, { now: LATE_EVENING }).ok === false);
	const noUpperBound = loadLib(LIB_SRC.replace(" || day > today + CALL_MAX_DAYS_AHEAD", ""));
	ok("MUTANT: a date with no upper bound is caught by §6",
		noUpperBound.checkWebsiteForm({ ...CALL, preferredDate: "2027-02-05" }, { now: NOW }).ok === true);
	for (const [label, src] of [
		["a call answered with the RFI's redirect", LIB_SRC.replace('if (formKind(req.body) === "call") {', "if (false) {")],
		["a call mailed as an RFI", LIB_SRC.replace('check.kind === "call" ? buildCallRequestEmail : buildInvestorRfiEmail', "buildInvestorRfiEmail")],
	]) {
		const mutant = loadLib(src);
		const sent = [];
		const app = express();
		app.use(mutant.INVESTOR_RFI_PATH, ...mutant.createBodyParsers());
		app.post(mutant.INVESTOR_RFI_PATH, ...mutant.createInvestorRfiMiddleware({ sendEmail: async (to, subject) => { sent.push(subject); return true; }, now: () => NOW }));
		const server = await listen(app);
		const r = await request(server, asForm(PROD, CALL_FORM));
		ok(`MUTANT: ${label} is caught by §6`, r.headers.location !== CALL_SENT(PROD) || sent[0] !== "Call request: Carl O. Callback (Owning part of LogisX)");
		server.close();
	}
	const openOrigin = loadLib(LIB_SRC.replace("return origin && RFI_ORIGINS.has(origin) ? origin : null;", "return origin || null;"));
	{
		const sent = [];
		const app = express();
		app.use(openOrigin.INVESTOR_RFI_PATH, ...openOrigin.createBodyParsers());
		app.post(openOrigin.INVESTOR_RFI_PATH, ...openOrigin.createInvestorRfiMiddleware({ sendEmail: async (...a) => { sent.push(a); return true; } }));
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
