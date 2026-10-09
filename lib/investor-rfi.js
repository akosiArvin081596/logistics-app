// ============================================================
// POST /api/public/investor-rfi: the website's investor Request for Information
// ============================================================
// The "Invest in LogisX" page on logisx.com (and its staging copy) asks people
// interested in investing in LogisX itself for their details, so the team can
// follow up with a link to the data room. This module is that form's whole
// server side: the origin allowlist, the input checks, the notification email
// and the response, mounted by server.js as `bodyParsers` (above the 50 MB JSON
// parser) and `middleware` (the route).
//
// WHAT IT DOES NOT DO, on purpose:
//   - No database write. The submission exists only as the email to the admin
//     inbox (ADMIN_NOTIFY_EMAIL, which server.js passes in as `to`); a send that
//     fails, or no inbox to send to, is reported to the visitor so they can try
//     again, rather than accepted and lost.
//   - No submitter data in logs. The only lines it writes name an outcome
//     (refused origin, failed send), never a field.
//   - No CORS. The website reaches this route through a same-origin path on its
//     own nginx vhost (/api/investor-rfi, proxied to the app of the same
//     environment), so the browser never makes a cross-origin call and
//     DRIVER_MOBILE_ORIGINS stays empty. Do not add the website there.
//
// TWO FORMS, ONE ROUTE. The page carries two forms, told apart by the `kind`
// field:
//   - no `kind`, "" or "rfi": the Request for Information above
//     (checkInvestorRfi, buildInvestorRfiEmail);
//   - "call": "Schedule a call", a request for LogisX to phone the visitor on
//     a chosen day, time window and time zone about one topic
//     (checkCallRequest, buildCallRequestEmail).
// Any other `kind` is refused (400 INVALID_FIELD, field "kind"). Both kinds
// share the origin allowlist, the rate limiter, the daily send cap, the
// honeypot, the recipient and the email layout.
//
// HOW A VISITOR REACHES IT. Two shapes, one route:
//   - A plain HTML form POST (application/x-www-form-urlencoded; JavaScript off,
//     or the form submitted before the page's script loaded). Answered 303 to
//     the page on the submitting site: /invest-in-logisx?sent=1 or ?error=1
//     for the RFI; for a call request, the call form it was sent from,
//     /contact or /invest-in-logisx, with ?call=sent#schedule-a-call or
//     ?call=error#schedule-a-call (callReturnPath).
//   - fetch() with a JSON body, or any request that prefers JSON. Answered with
//     JSON: 200 { ok: true }, or 4xx/5xx { error, code, field? }.
//
// ⚠️ THE FORM-ENCODED PARSER IS MOUNTED ON THIS PATH ONLY. Everywhere else in
// server.js express.json() is the only body parser, and several cross-site
// guards there rely on a form-encoded body arriving empty. `bodyParsers` below
// is mounted with this route's path, so that invariant holds for every other
// route. Never mount it without the path.
//
// Pure apart from the factory at the bottom, which takes the mail sender and
// the clock as arguments so scripts/test-investor-rfi.js can drive the real
// middleware with a fake mailer.

"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");

const publicFormInput = require("./public-form-input");
const appTime = require("./app-time");

const INVESTOR_RFI_PATH = "/api/public/investor-rfi";

// The page that carries the form, on each website. The 303 goes back to it on
// the site the visitor came from (the validated Origin), never to a URL taken
// from the request.
const RFI_PAGE_PATH = "/invest-in-logisx";

// The call form's section: a call request's 303 lands on it.
const CALL_FORM_ANCHOR = "schedule-a-call";

// The pages that carry the call form, on each website: /contact, where every
// "Schedule a call" link lands without JavaScript, and /invest-in-logisx. A
// call request's 303 goes back to the one it was sent from (callReturnPath),
// and to /contact when that can't be told. These two constants are the only
// paths a call's 303 ever names.
const CALL_FORM_PATHS = Object.freeze(["/contact", RFI_PAGE_PATH]);
const CALL_FORM_DEFAULT_PATH = "/contact";

// The only browser origins this route accepts, and whether each is staging.
// A request with any other Origin, or none, is refused 403 before it reaches
// the rate limiter or the checks. Staging submissions are marked "[STAGING]"
// in the subject: the staging website proxies to the staging app only, so the
// staging origin is exactly "sent from staging".
const RFI_ORIGINS = new Map([
	["https://logisx.com", { staging: false }],
	["https://staging-logisx.logisx.com", { staging: true }],
]);

// Same window and cap as publicFormLimiter in server.js (10 per 15 minutes per
// client address). Its own counter, so a visitor over the limit with no
// JavaScript gets the page's error state rather than a bare JSON body.
const RFI_RATE_WINDOW_MS = 15 * 60 * 1000;
const RFI_RATE_LIMIT = 10;

// At most this many RFI emails per rolling 24 hours, per process, whoever sends
// them. Every email here goes through the one Gmail account that also sends
// onboarding, acceptances, invoices and alerts, and Origin can be forged by a
// non-browser client, so a few addresses at the per-client limit could
// otherwise use up that account's daily quota for every caller. Over the cap a
// submission is answered like a failed send (the visitor is told to email
// info@logisx.com instead) and nothing is sent.
const RFI_DAILY_SEND_CAP = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

// A form-encoded or JSON body larger than this is refused 413 before it is
// read. The longest legitimate body is the message cap plus a few short
// fields; 32 KB leaves room for a 2,000-character message in a non-Latin
// script, which form encoding roughly triples.
const RFI_BODY_LIMIT = "32kb";

// Longest value each text field may carry, checked before any pattern runs.
// The email cap is public-form-input's (RFC 5321).
const RFI_FIELD_MAX = {
	fullName: 120,
	phone: 40,
	company: 160,
	message: 2000,
};

// Every text field the route reads. Each must arrive as ONE scalar
// (checkPublicScalars); a repeated form key arrives as an array and is refused.
// `website` is the honeypot: a field people never see. `consent` is not listed:
// fetch sends it as a boolean, which checkPublicScalars refuses, so it has its
// own check below, which passes only the values in CONSENT_VALUES.
const RFI_SCALAR_FIELDS = ["fullName", "email", "phone", "company", "message", "website"];
const RFI_HONEYPOT_FIELD = "website";

// Every field a call request reads, each ONE scalar like the RFI's. `company`
// is checked for shape only and otherwise ignored (the call email has no
// Company row). `kind` is listed for completeness; formKind() has already
// passed only "call" by the time this list is checked.
const CALL_SCALAR_FIELDS = ["kind", "fullName", "email", "phone", "company", "message", "website", "preferredDate", "timeWindow", "timeZone", "topic"];

// The call form's three choices: the value the form sends, and the label the
// email shows. Maps, so a value such as "constructor" finds nothing.
const CALL_TIME_WINDOWS = new Map([
	["morning", "Morning (8 am–12 pm)"],
	["afternoon", "Afternoon (12–5 pm)"],
	["evening", "Evening (5–7 pm)"],
]);
const CALL_TIME_ZONES = new Map([
	["eastern", "Eastern"],
	["central", "Central"],
	["mountain", "Mountain"],
	["pacific", "Pacific"],
]);
const CALL_TOPICS = new Map([
	["truck-fund", "Truck Fund"],
	["owning-logisx", "Owning part of LogisX"],
	["broker-free-platform", "Broker-free platform"],
	["other", "Other"],
]);

// A call's preferred date is a calendar date from today to this many days
// after it, both counted on the business clock (APP_TIMEZONE, US Eastern).
// "Today" comes from the factory's `now`, so the tests fix it.
const CALL_MAX_DAYS_AHEAD = 120;

// What a ticked consent box arrives as: true from fetch, "true" from the
// website's checkbox (value="true"), "on" from a checkbox with no value.
const CONSENT_VALUES = new Set([true, "true", "on"]);

// Every text field is STRIPPED of control and invisible characters before it is
// checked (Arvin, 2026-10-08: "strip invisible and control characters from
// every text field"; until then a few were refused and a few others, such as
// U+00AD, U+061C and U+3164, got through). What goes:
//   - every control character (\p{Cc}: C0 and C1, so CR and LF too, since the
//     name went into a subject until the same date);
//   - every default-ignorable code point (\p{Default_Ignorable_Code_Point}):
//     zero-width marks and joiners, bidi embeddings, overrides and isolates,
//     the soft hyphen, the Arabic letter mark, Hangul fillers, variation
//     selectors, tag characters, the byte-order mark;
//   - the line and paragraph separators (\p{Zl}, \p{Zp}).
// The message keeps tab, LF and CR. A value that is only such characters
// strips to "" and is then answered as missing. Single character classes, so
// linear on any input.
const INVISIBLE_CHARS_RE = /[\p{Cc}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu;
const MESSAGE_INVISIBLE_CHARS_RE = /(?![\t\n\r])[\p{Cc}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu;
function stripInvisible(text, { multiline = false } = {}) {
	return text.replace(multiline ? MESSAGE_INVISIBLE_CHARS_RE : INVISIBLE_CHARS_RE, "");
}

const MESSAGES = {
	required: "Please fill in all required fields.",
	invalid: "Some of the submitted details are invalid. Please review the form and try again.",
	too_long: "One of your answers is too long. Please shorten it and try again.",
	consent: "Please agree to be contacted about investment opportunities.",
	call_consent: "Please agree to be contacted about your request.",
	origin: "This form can only be sent from logisx.com.",
	rate_limited: "Too many submissions. Try again later.",
	send_failed: "We couldn't send your request. Please try again, or email info@logisx.com.",
	body_too_large: "Too much was sent. Please shorten your message and try again.",
	body_invalid: "Invalid request. Please try again.",
};

function refusal(code, field, message, status = 400) {
	const out = { ok: false, status, code, message };
	if (field) out.field = field;
	return out;
}

// One optional or required line of text: stripped of control and invisible
// characters (stripInvisible), trimmed, then length-capped. Returns
// { ok, value } with "" for an absent field.
function checkText(raw, field, { required = false, multiline = false } = {}) {
	if (raw === undefined || raw === null) raw = "";
	if (typeof raw !== "string") return refusal("INVALID_FIELD", field, MESSAGES.invalid);
	if (raw.length > RFI_FIELD_MAX[field] * 2) return refusal("FIELD_TOO_LONG", field, MESSAGES.too_long);
	const value = stripInvisible(raw, { multiline }).trim();
	if (required && !value) return refusal("FIELD_REQUIRED", field, MESSAGES.required);
	if (value.length > RFI_FIELD_MAX[field]) return refusal("FIELD_TOO_LONG", field, MESSAGES.too_long);
	return { ok: true, value };
}

// True when the honeypot field carries anything at all.
function honeypotFilled(src) {
	const trap = src[RFI_HONEYPOT_FIELD];
	return trap !== undefined && trap !== null && String(trap) !== "";
}

// The submitter's address: required, then stripped of control and invisible
// characters like every text field, trimmed (a pasted address often carries a
// space) and checked exactly as it will be mailed, so the string that passes
// is the Reply-To.
function checkSubmitterEmail(raw) {
	if (raw === undefined || raw === null || raw === "") {
		return refusal("FIELD_REQUIRED", "email", MESSAGES.required);
	}
	if (typeof raw !== "string") return refusal("INVALID_EMAIL", "email", MESSAGES.invalid);
	if (raw.length > 1000) return refusal("INVALID_EMAIL", "email", MESSAGES.invalid);
	const stripped = stripInvisible(raw).trim();
	if (!stripped) return refusal("FIELD_REQUIRED", "email", MESSAGES.required);
	const email = publicFormInput.checkPublicEmail(stripped);
	if (!email.ok) return refusal("INVALID_EMAIL", "email", email.message);
	return { ok: true, value: email.value };
}

// The whole body, or the first refusal. A filled honeypot is not a refusal: it
// answers { ok: true, honeypot: true }, and the route treats it as sent
// without sending anything, so a bot learns nothing.
function checkInvestorRfi(body) {
	const shape = publicFormInput.checkPublicScalars(body, RFI_SCALAR_FIELDS);
	if (!shape.ok) return refusal("INVALID_FIELD", shape.field, MESSAGES.invalid);
	const src = shape.value;

	if (honeypotFilled(src)) return { ok: true, honeypot: true };

	const fullName = checkText(src.fullName, "fullName", { required: true });
	if (!fullName.ok) return fullName;

	const email = checkSubmitterEmail(src.email);
	if (!email.ok) return email;

	const phone = checkText(src.phone, "phone");
	if (!phone.ok) return phone;
	const company = checkText(src.company, "company");
	if (!company.ok) return company;
	const message = checkText(src.message, "message", { multiline: true });
	if (!message.ok) return message;

	if (!CONSENT_VALUES.has(src.consent)) return refusal("CONSENT_REQUIRED", "consent", MESSAGES.consent);

	return {
		ok: true,
		honeypot: false,
		value: {
			fullName: fullName.value,
			email: email.value,
			phone: phone.value,
			company: company.value,
			message: message.value,
		},
	};
}

// A real calendar date "YYYY-MM-DD" as a day count since 1970-01-01, or null
// for anything else (wrong shape, or a day the month doesn't have, such as
// 2026-02-30). The round trip also refuses years 0000-0099, which Date.UTC
// would read as 19xx.
const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function calendarDayNumber(text) {
	const m = CALENDAR_DATE_RE.exec(text);
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const at = new Date(Date.UTC(year, month - 1, day));
	if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
	return at.getTime() / DAY_MS;
}

// The calendar date of `date` on the business clock, "YYYY-MM-DD". Production
// runs in UTC, so the server's own clock date is a day ahead every evening.
function businessDate(date) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: appTime.appTimeZone(),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const part = (type) => parts.find((p) => p.type === type).value;
	return `${part("year")}-${part("month")}-${part("day")}`;
}

// The preferred date: required, a real calendar date, from today to
// CALL_MAX_DAYS_AHEAD days after it (both on the business clock).
function checkPreferredDate(raw, now) {
	const field = "preferredDate";
	if (raw === undefined || raw === null) raw = "";
	// "YYYY-MM-DD" is 10 characters; anything far longer is refused before
	// the pattern runs.
	if (typeof raw !== "string" || raw.length > 32) return refusal("INVALID_FIELD", field, MESSAGES.invalid);
	const value = raw.trim();
	if (!value) return refusal("FIELD_REQUIRED", field, MESSAGES.required);
	const day = calendarDayNumber(value);
	if (day === null) return refusal("INVALID_FIELD", field, MESSAGES.invalid);
	const today = calendarDayNumber(businessDate(now));
	if (day < today || day > today + CALL_MAX_DAYS_AHEAD) return refusal("INVALID_FIELD", field, MESSAGES.invalid);
	return { ok: true, value };
}

// One of a fixed set of values: a key of `choices` (value → label), exactly
// as sent.
function checkChoice(raw, field, choices) {
	if (raw === undefined || raw === null || raw === "") return refusal("FIELD_REQUIRED", field, MESSAGES.required);
	if (typeof raw !== "string" || !choices.has(raw)) return refusal("INVALID_FIELD", field, MESSAGES.invalid);
	return { ok: true, value: raw };
}

// A "Schedule a call" body (kind "call"), or the first refusal. Same rules as
// the RFI for the fields they share, except that the phone is required here.
// The honeypot answers exactly as it does for the RFI. `now` decides "today"
// for the preferred date.
function checkCallRequest(body, { now = new Date() } = {}) {
	const shape = publicFormInput.checkPublicScalars(body, CALL_SCALAR_FIELDS);
	if (!shape.ok) return refusal("INVALID_FIELD", shape.field, MESSAGES.invalid);
	const src = shape.value;

	if (honeypotFilled(src)) return { ok: true, honeypot: true };

	const fullName = checkText(src.fullName, "fullName", { required: true });
	if (!fullName.ok) return fullName;
	const email = checkSubmitterEmail(src.email);
	if (!email.ok) return email;
	const phone = checkText(src.phone, "phone", { required: true });
	if (!phone.ok) return phone;
	const preferredDate = checkPreferredDate(src.preferredDate, now);
	if (!preferredDate.ok) return preferredDate;
	const timeWindow = checkChoice(src.timeWindow, "timeWindow", CALL_TIME_WINDOWS);
	if (!timeWindow.ok) return timeWindow;
	const timeZone = checkChoice(src.timeZone, "timeZone", CALL_TIME_ZONES);
	if (!timeZone.ok) return timeZone;
	const topic = checkChoice(src.topic, "topic", CALL_TOPICS);
	if (!topic.ok) return topic;
	const message = checkText(src.message, "message", { multiline: true });
	if (!message.ok) return message;

	if (!CONSENT_VALUES.has(src.consent)) {
		return refusal("CONSENT_REQUIRED", "consent", MESSAGES.call_consent);
	}

	return {
		ok: true,
		honeypot: false,
		value: {
			fullName: fullName.value,
			email: email.value,
			phone: phone.value,
			preferredDate: preferredDate.value,
			timeWindow: timeWindow.value,
			timeZone: timeZone.value,
			topic: topic.value,
			message: message.value,
		},
	};
}

// Which of the page's forms a body comes from: "rfi" (no `kind`, "" or
// "rfi"), "call", or null for any other value, a repeated key included.
function formKind(body) {
	const kind = body !== null && typeof body === "object" ? body.kind : undefined;
	if (kind === undefined || kind === null || kind === "" || kind === "rfi") return "rfi";
	if (kind === "call") return "call";
	return null;
}

// What the route checks: the form's kind first, then that form's own check.
// The RFI path is checkInvestorRfi unchanged; a passing result carries `kind`.
function checkWebsiteForm(body, { now = new Date() } = {}) {
	const kind = formKind(body);
	if (!kind) return refusal("INVALID_FIELD", "kind", MESSAGES.invalid);
	const check = kind === "call" ? checkCallRequest(body, { now }) : checkInvestorRfi(body);
	return check.ok ? { ...check, kind } : check;
}

function escapeHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// The submission time twice: on the business clock (APP_TIMEZONE, US Eastern)
// and in UTC.
function formatSubmittedAt(date) {
	const business = new Intl.DateTimeFormat("en-US", {
		timeZone: appTime.appTimeZone(),
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(date);
	return `${business} (${date.toISOString().replace(/\.\d{3}Z$/, "Z")})`;
}

// One row of an email's details table. `html` is already escaped.
function emailRow(label, html) {
	return `<tr><td style="padding:6px 12px 6px 0;color:#64748b;width:130px;vertical-align:top">${label}</td><td style="padding:6px 0;vertical-align:top">${html}</td></tr>`;
}

// An optional value, escaped, or "Not given" when empty.
function emailOptional(v) {
	return v ? escapeHtml(v) : '<span style="color:#94a3b8">Not given</span>';
}

// The free-text message, escaped, keeping its line breaks; "Not given" when empty.
function emailMessage(text) {
	return text ? `<div style="white-space:pre-wrap;line-height:1.5">${escapeHtml(text)}</div>` : emailOptional("");
}

// The layout both emails share: logo bar, heading, intro, details table and
// footer. `heading` and `intro` are fixed text; each row's value is escaped
// by its caller.
function renderEmail({ heading, intro, rows }) {
	return `
	<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
		<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
			<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
		</div>
		<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
			<h2 style="margin:0 0 16px;font-size:20px;color:#0f172a">${heading}</h2>
			<p style="margin:0 0 20px;line-height:1.6;color:#334155">${intro}</p>
			<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px">
				<table style="width:100%;border-collapse:collapse;font-size:14px">
					${rows.join("\n\t\t\t\t\t")}
				</table>
			</div>
		</div>
		<div style="padding:16px 32px;text-align:center">
			<div style="font-size:11px;color:#94a3b8;line-height:1.6">LogisX Inc. | 4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381 | USDOT# 4302683</div>
		</div>
	</div>`;
}

// The one email an RFI sends: to `to` (the admin inbox), Reply-To the
// submitter, so answering it reaches them. Every value is escaped; an empty
// optional field shows as "Not given".
function buildInvestorRfiEmail(rfi, { staging, submittedAt, to }) {
	const html = renderEmail({
		heading: `${staging ? "[STAGING] " : ""}Investor Request for Information`,
		intro: `Someone asked for access to the LogisX data room through the "Invest in LogisX" page${staging ? " on the staging site" : ""}. Reply to this email to reach them, and share the data room link once the team has reviewed the request.`,
		rows: [
			emailRow("Name", `<b>${escapeHtml(rfi.fullName)}</b>`),
			emailRow("Email", `<a href="mailto:${escapeHtml(rfi.email)}">${escapeHtml(rfi.email)}</a>`),
			emailRow("Phone", emailOptional(rfi.phone)),
			emailRow("Company", emailOptional(rfi.company)),
			emailRow("Message", emailMessage(rfi.message)),
			emailRow("Consent", "Agreed to be contacted by LogisX about investment opportunities and has read the Privacy Policy"),
			emailRow("Submitted", escapeHtml(formatSubmittedAt(submittedAt))),
		],
	});
	return {
		to,
		subject: `${staging ? "[STAGING] " : ""}Investor RFI: ${rfi.fullName}`,
		html,
		replyTo: rfi.email,
	};
}

// A preferred date "YYYY-MM-DD" as the email shows it: "Thu, Oct 15, 2026".
// Anchored at 12:00 UTC and formatted in UTC, so it names the same day
// wherever the server runs.
function formatPreferredDate(text) {
	const [year, month, day] = text.split("-").map(Number);
	return new Intl.DateTimeFormat("en-US", {
		timeZone: "UTC",
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
	}).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

// The one email a call request sends: same recipient, Reply-To, escaping and
// layout as the RFI's, with the visitor's chosen day, window, time zone and
// topic. Takes checkCallRequest()'s value; choices show as their labels.
// THE SUBJECT IS BUILT FROM THE VALIDATED TOPIC ONLY, never from the name
// (Arvin, 2026-10-08): a name such as "Bob (Truck Fund)" could otherwise show a
// topic that wasn't chosen. The name is in the body's first row.
function buildCallRequestEmail(call, { staging, submittedAt, to }) {
	const topicLabel = CALL_TOPICS.get(call.topic);
	const html = renderEmail({
		heading: `${staging ? "[STAGING] " : ""}Call request`,
		intro: `Someone asked LogisX to call them through the website's "Schedule a call" form${staging ? " on the staging site" : ""}. Reply to this email or call them back at the time they chose.`,
		rows: [
			emailRow("Name", `<b>${escapeHtml(call.fullName)}</b>`),
			emailRow("Email", `<a href="mailto:${escapeHtml(call.email)}">${escapeHtml(call.email)}</a>`),
			emailRow("Phone", escapeHtml(call.phone)),
			emailRow("Topic", escapeHtml(topicLabel)),
			emailRow("Preferred date", escapeHtml(formatPreferredDate(call.preferredDate))),
			emailRow("Time window", escapeHtml(CALL_TIME_WINDOWS.get(call.timeWindow))),
			emailRow("Time zone", escapeHtml(CALL_TIME_ZONES.get(call.timeZone))),
			emailRow("Message", emailMessage(call.message)),
			emailRow("Consent", "Agreed to be contacted by LogisX about this request and has read the Privacy Policy"),
			emailRow("Submitted", escapeHtml(formatSubmittedAt(submittedAt))),
		],
	});
	return {
		to,
		subject: `${staging ? "[STAGING] " : ""}Call request: ${topicLabel}`,
		html,
		replyTo: call.email,
	};
}

// The allowlisted origin a request came from, or null.
function rfiOrigin(req) {
	const origin = req.get("Origin");
	return origin && RFI_ORIGINS.has(origin) ? origin : null;
}

// Whether a request comes from the call form. The body's `kind` decides it; a
// body the parser refused (too large, malformed) has none, so the call form
// also says it in its action's query string (`?kind=call`, logisx-hub's
// ScheduleCallForm), read ONLY when there is no parsed body, and only to choose
// where the refusal's 303 goes. Validation never reads the query string.
function isCallForm(req) {
	const parsed = req.body !== null && typeof req.body === "object" && Object.keys(req.body).length > 0;
	if (parsed) return formKind(req.body) === "call";
	return req.query && req.query.kind === "call";
}

// Which call form a call request came from: the Referer's path when the
// Referer is on the same validated website origin and its path is one of
// CALL_FORM_PATHS (one trailing slash ignored; its query and anything else
// dropped), else CALL_FORM_DEFAULT_PATH. The Referer only chooses between the
// constants; the 303 never carries text from it. The websites send it: their
// Referrer-Policy is strict-origin-when-cross-origin, and the form posts to
// the same origin.
function callReturnPath(req, origin) {
	const referer = req.get("referer");
	if (typeof referer !== "string" || !referer) return CALL_FORM_DEFAULT_PATH;
	let url;
	try {
		url = new URL(referer);
	} catch {
		return CALL_FORM_DEFAULT_PATH;
	}
	if (url.origin !== origin) return CALL_FORM_DEFAULT_PATH;
	const pathname = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
	return CALL_FORM_PATHS.find((page) => page === pathname) || CALL_FORM_DEFAULT_PATH;
}

// JSON for fetch (a JSON body, or Accept preferring JSON); a 303 for a form.
function wantsJson(req) {
	return Boolean(req.is("application/json")) || req.accepts(["html", "json"]) === "json";
}

// The one way this route answers. `outcome` is "sent" or a refusal object.
function respond(req, res, outcome) {
	if (wantsJson(req)) {
		if (outcome === "sent") return res.status(200).json({ ok: true });
		const body = { error: outcome.message, code: outcome.code };
		if (outcome.field) body.field = outcome.field;
		return res.status(outcome.status).json(body);
	}
	const origin = res.locals.rfiOrigin;
	if (!origin) {
		// Only the origin refusal gets here without one: there is no site of
		// ours to send the visitor back to.
		return res.status(outcome.status).type("text/plain").send(outcome.message);
	}
	// A call request goes back to the call form's section, on the page it was
	// sent from (callReturnPath). The body is parsed before the limiter and the
	// checks run, so their refusals see `kind` too; a body the parser refused
	// has none, and the action's `?kind=call` says it (isCallForm).
	if (isCallForm(req)) {
		const call = outcome === "sent" ? "sent" : "error";
		return res.redirect(303, `${origin}${callReturnPath(req, origin)}?call=${call}#${CALL_FORM_ANCHOR}`);
	}
	const query = outcome === "sent" ? "sent=1" : "error=1";
	return res.redirect(303, `${origin}${RFI_PAGE_PATH}?${query}`);
}

// Origin refusals are logged, but coalesced to one line a minute with a
// running total: a scanner posting here would otherwise write a line per
// request. The line names the outcome only, never the request.
let originRefusals = 0;
let originRefusalLoggedAt = 0;
function logOriginRefusal() {
	originRefusals += 1;
	if (Date.now() - originRefusalLoggedAt < 60_000) return;
	originRefusalLoggedAt = Date.now();
	console.warn(`investor-rfi: ${originRefusals} request(s) refused for an Origin outside the allowlist`);
}

function originGuard(req, res, next) {
	const origin = rfiOrigin(req);
	if (!origin) {
		logOriginRefusal();
		return respond(req, res, refusal("ORIGIN_NOT_ALLOWED", null, MESSAGES.origin, 403));
	}
	res.locals.rfiOrigin = origin;
	res.locals.rfiStaging = RFI_ORIGINS.get(origin).staging;
	next();
}

// Mounted with INVESTOR_RFI_PATH, above server.js's 50 MB JSON parser:
// body-parser skips a body that is already parsed, so that parser never reads
// this one. Parse failures answer here, in the route's own two shapes.
//
// `app.use` matches the path as a prefix (any method, any sub-path), so each
// parser runs only for a POST to the path itself; everything else passes
// through unparsed, exactly as it would without this mount.
function createBodyParsers() {
	const onlyThisRoute = (parser) => (req, res, next) =>
		(req.method === "POST" && req.path === "/" ? parser(req, res, next) : next());
	const json = onlyThisRoute(express.json({ limit: RFI_BODY_LIMIT }));
	// extended: false keeps the form decoder flat (no nested objects); a key
	// sent twice still arrives as an array, which checkPublicScalars refuses.
	const form = onlyThisRoute(express.urlencoded({ extended: false, limit: RFI_BODY_LIMIT, parameterLimit: 20 }));
	// Four arguments, so Express treats it as error middleware.
	const onError = (err, req, res, _next) => {
		res.locals.rfiOrigin = rfiOrigin(req);
		if (err.type === "entity.too.large") {
			return respond(req, res, refusal("BODY_TOO_LARGE", null, MESSAGES.body_too_large, 413));
		}
		return respond(req, res, refusal("INVALID_BODY", null, MESSAGES.body_invalid));
	};
	return [json, form, onError];
}

// The route itself: origin, then the rate limit, then the checks, then one
// email. `sendEmail(to, subject, html, attachments, { replyTo })` resolves true
// only when Gmail accepted the message (server.js's sendEmail). Both kinds of
// submission share the limiter's counter, the daily cap and the inbox. `to` is
// the inbox the email goes to (server.js passes ADMIN_NOTIFY_EMAIL), with no
// default: without one, a valid submission of either kind is answered like a
// failed send (503 SEND_FAILED, the same text) and nothing is sent. `now` is
// the clock for the submission time, the daily cap and a call's "today".
function createInvestorRfiMiddleware({ sendEmail, to = "", now = () => new Date(), dailySendCap = RFI_DAILY_SEND_CAP }) {
	const rfiTo = String(to ?? "").trim();
	// When each email of the last 24 hours was handed to the sender, sent or not
	// (RFI_DAILY_SEND_CAP): a failing account is not retried past the cap either.
	const sentAt = [];
	let capLoggedAt = 0;
	const underDailyCap = () => {
		const cutoff = now().getTime() - DAY_MS;
		while (sentAt.length && sentAt[0] <= cutoff) sentAt.shift();
		return sentAt.length < dailySendCap;
	};

	const limiter = rateLimit({
		windowMs: RFI_RATE_WINDOW_MS,
		limit: RFI_RATE_LIMIT,
		standardHeaders: true,
		legacyHeaders: false,
		handler: (req, res) => respond(req, res, refusal("RATE_LIMITED", null, MESSAGES.rate_limited, 429)),
	});

	async function handle(req, res) {
		try {
			const check = checkWebsiteForm(req.body, { now: now() });
			if (!check.ok) return respond(req, res, check);
			if (check.honeypot) return respond(req, res, "sent");

			// No inbox to send to: nothing is sent, and the visitor gets the
			// failed-send answer. server.js logs the missing setting once per start.
			if (!rfiTo) return respond(req, res, refusal("SEND_FAILED", null, MESSAGES.send_failed, 503));

			if (!underDailyCap()) {
				if (Date.now() - capLoggedAt > 60_000) {
					capLoggedAt = Date.now();
					console.error(`investor-rfi: daily cap of ${dailySendCap} emails reached; submissions are refused until it frees`);
				}
				return respond(req, res, refusal("SEND_FAILED", null, MESSAGES.send_failed, 503));
			}
			const build = check.kind === "call" ? buildCallRequestEmail : buildInvestorRfiEmail;
			const mail = build(check.value, { staging: res.locals.rfiStaging, submittedAt: now(), to: rfiTo });
			sentAt.push(now().getTime());
			const sent = await sendEmail(mail.to, mail.subject, mail.html, [], { replyTo: mail.replyTo });
			if (!sent) {
				console.error("investor-rfi: the notification email was not sent");
				return respond(req, res, refusal("SEND_FAILED", null, MESSAGES.send_failed, 502));
			}
			return respond(req, res, "sent");
		} catch {
			// Never the error itself: it could carry what was submitted.
			console.error("investor-rfi: submission failed");
			if (res.headersSent) return;
			return respond(req, res, refusal("SEND_FAILED", null, MESSAGES.send_failed, 500));
		}
	}

	return [originGuard, limiter, handle];
}

module.exports = {
	INVESTOR_RFI_PATH,
	RFI_PAGE_PATH,
	CALL_FORM_ANCHOR,
	CALL_FORM_PATHS,
	CALL_FORM_DEFAULT_PATH,
	RFI_ORIGINS,
	RFI_FIELD_MAX,
	RFI_SCALAR_FIELDS,
	RFI_HONEYPOT_FIELD,
	RFI_RATE_LIMIT,
	RFI_RATE_WINDOW_MS,
	RFI_DAILY_SEND_CAP,
	CALL_SCALAR_FIELDS,
	CALL_TIME_WINDOWS,
	CALL_TIME_ZONES,
	CALL_TOPICS,
	CALL_MAX_DAYS_AHEAD,
	checkInvestorRfi,
	checkCallRequest,
	checkWebsiteForm,
	buildInvestorRfiEmail,
	buildCallRequestEmail,
	createBodyParsers,
	createInvestorRfiMiddleware,
};
