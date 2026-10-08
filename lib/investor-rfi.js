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
// HOW A VISITOR REACHES IT. Two shapes, one route:
//   - A plain HTML form POST (application/x-www-form-urlencoded; JavaScript off,
//     or the form submitted before the page's script loaded). Answered 303 to
//     the page on the submitting site: /invest-in-logisx?sent=1 or ?error=1.
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

const INVESTOR_RFI_PATH = "/api/public/investor-rfi";

// The page that carries the form, on each website. The 303 goes back to it on
// the site the visitor came from (the validated Origin), never to a URL taken
// from the request.
const RFI_PAGE_PATH = "/invest-in-logisx";

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

// What a ticked consent box arrives as: true from fetch, "true" from the
// website's checkbox (value="true"), "on" from a checkbox with no value.
const CONSENT_VALUES = new Set([true, "true", "on"]);

// One-line fields refuse every control character (CR and LF included, since
// the name goes into the subject), and the invisible and direction-changing
// characters that could make a subject or name display as something else: C1
// controls, zero-width marks, the line and paragraph separators, bidi
// embeddings, overrides and isolates, and the byte-order mark. The message
// keeps tab, LF and CR, and refuses the rest. Single character classes: linear
// on any input.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/;
const MESSAGE_CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/;

const MESSAGES = {
	required: "Please fill in all required fields.",
	invalid: "Some of the submitted details are invalid. Please review the form and try again.",
	too_long: "One of your answers is too long. Please shorten it and try again.",
	consent: "Please agree to be contacted about investment opportunities.",
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

// One optional or required line of text: trimmed, length-capped, then checked
// for control characters. Returns { ok, value } with "" for an absent field.
function checkText(raw, field, { required = false, multiline = false } = {}) {
	if (raw === undefined || raw === null) raw = "";
	if (typeof raw !== "string") return refusal("INVALID_FIELD", field, MESSAGES.invalid);
	if (raw.length > RFI_FIELD_MAX[field] * 2) return refusal("FIELD_TOO_LONG", field, MESSAGES.too_long);
	const value = raw.trim();
	if (required && !value) return refusal("FIELD_REQUIRED", field, MESSAGES.required);
	if (value.length > RFI_FIELD_MAX[field]) return refusal("FIELD_TOO_LONG", field, MESSAGES.too_long);
	if ((multiline ? MESSAGE_CONTROL_CHARS_RE : CONTROL_CHARS_RE).test(value)) {
		return refusal("INVALID_FIELD", field, MESSAGES.invalid);
	}
	return { ok: true, value };
}

// The whole body, or the first refusal. A filled honeypot is not a refusal: it
// answers { ok: true, honeypot: true }, and the route treats it as sent
// without sending anything, so a bot learns nothing.
function checkInvestorRfi(body) {
	const shape = publicFormInput.checkPublicScalars(body, RFI_SCALAR_FIELDS);
	if (!shape.ok) return refusal("INVALID_FIELD", shape.field, MESSAGES.invalid);
	const src = shape.value;

	const trap = src[RFI_HONEYPOT_FIELD];
	if (trap !== undefined && trap !== null && String(trap) !== "") return { ok: true, honeypot: true };

	const fullName = checkText(src.fullName, "fullName", { required: true });
	if (!fullName.ok) return fullName;

	if (src.email === undefined || src.email === null || src.email === "") {
		return refusal("FIELD_REQUIRED", "email", MESSAGES.required);
	}
	if (typeof src.email !== "string") return refusal("INVALID_EMAIL", "email", MESSAGES.invalid);
	// Trimmed first (a pasted address often carries a space), then checked
	// exactly as it will be mailed: the string that passes is the Reply-To.
	const email = publicFormInput.checkPublicEmail(src.email.trim());
	if (!email.ok) return refusal("INVALID_EMAIL", "email", email.message);

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

function escapeHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// The submission time twice: Central (LogisX keeps Texas hours) and UTC.
function formatSubmittedAt(date) {
	const central = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Chicago",
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(date);
	return `${central} (${date.toISOString().replace(/\.\d{3}Z$/, "Z")})`;
}

// The one email a submission sends: to `to` (the admin inbox), Reply-To the
// submitter, so answering it reaches them. Every value is escaped; an empty
// optional field shows as "Not given".
function buildInvestorRfiEmail(rfi, { staging, submittedAt, to }) {
	const row = (label, html) =>
		`<tr><td style="padding:6px 12px 6px 0;color:#64748b;width:130px;vertical-align:top">${label}</td><td style="padding:6px 0;vertical-align:top">${html}</td></tr>`;
	const optional = (v) => (v ? escapeHtml(v) : '<span style="color:#94a3b8">Not given</span>');
	const message = rfi.message
		? `<div style="white-space:pre-wrap;line-height:1.5">${escapeHtml(rfi.message)}</div>`
		: optional("");
	const html = `
	<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
		<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
			<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
		</div>
		<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
			<h2 style="margin:0 0 16px;font-size:20px;color:#0f172a">${staging ? "[STAGING] " : ""}Investor Request for Information</h2>
			<p style="margin:0 0 20px;line-height:1.6;color:#334155">Someone asked for access to the LogisX data room through the "Invest in LogisX" page${staging ? " on the staging site" : ""}. Reply to this email to reach them, and share the data room link once the team has reviewed the request.</p>
			<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px">
				<table style="width:100%;border-collapse:collapse;font-size:14px">
					${row("Name", `<b>${escapeHtml(rfi.fullName)}</b>`)}
					${row("Email", `<a href="mailto:${escapeHtml(rfi.email)}">${escapeHtml(rfi.email)}</a>`)}
					${row("Phone", optional(rfi.phone))}
					${row("Company", optional(rfi.company))}
					${row("Message", message)}
					${row("Consent", "Agreed to be contacted by LogisX about investment opportunities and has read the Privacy Policy")}
					${row("Submitted", escapeHtml(formatSubmittedAt(submittedAt)))}
				</table>
			</div>
		</div>
		<div style="padding:16px 32px;text-align:center">
			<div style="font-size:11px;color:#94a3b8;line-height:1.6">LogisX Inc. | 4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381 | USDOT# 4302683</div>
		</div>
	</div>`;
	return {
		to,
		subject: `${staging ? "[STAGING] " : ""}Investor RFI: ${rfi.fullName}`,
		html,
		replyTo: rfi.email,
	};
}

// The allowlisted origin a request came from, or null.
function rfiOrigin(req) {
	const origin = req.get("Origin");
	return origin && RFI_ORIGINS.has(origin) ? origin : null;
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
// only when Gmail accepted the message (server.js's sendEmail). `to` is the
// inbox the email goes to (server.js passes ADMIN_NOTIFY_EMAIL), with no
// default: without one, a valid submission is answered like a failed send
// (503 SEND_FAILED, the same text) and nothing is sent.
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
			const check = checkInvestorRfi(req.body);
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
			const mail = buildInvestorRfiEmail(check.value, { staging: res.locals.rfiStaging, submittedAt: now(), to: rfiTo });
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
	RFI_ORIGINS,
	RFI_FIELD_MAX,
	RFI_SCALAR_FIELDS,
	RFI_HONEYPOT_FIELD,
	RFI_RATE_LIMIT,
	RFI_RATE_WINDOW_MS,
	RFI_DAILY_SEND_CAP,
	checkInvestorRfi,
	buildInvestorRfiEmail,
	createBodyParsers,
	createInvestorRfiMiddleware,
};
