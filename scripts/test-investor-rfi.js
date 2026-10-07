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

	console.warn = realConsole.warn; console.error = realConsole.error;
	const typed = [VALID.fullName, VALID.email, VALID.phone, VALID.company, "Interested in the data room", "jane.sample"];
	ok("§3 nothing a visitor typed reached the console", captured.every((line) => typed.every((t) => !line.includes(t))));
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
