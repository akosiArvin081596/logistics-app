// "Send invoice to C.H. Robinson": a Super Admin sends one load's invoice from its dialog, a
// load no automatic invoice started and none was found for (old loads, and loads someone other
// than the driver marked Delivered).
//
// CHR_SEND_BUTTON_ENABLED is on only when exactly "true", with CHR_SEND_BUTTON_FROM (a day: unset
// or unreadable, no button), never in a replica, and it counts only with the driver's trigger and
// sending both on: nothing else could run a press at once, or send it. Off, the routes answer as
// if they weren't there, nothing is read, and nothing is paid for or written.
//
// IT CAN'T SEND A LOAD TWICE. A press only moves the load's one claim to the job's own line
// (lib/auto-invoice-ledger.js pressButton(): one conditional update, from no claim, baseline or
// OFF_GAP), and the run is the job's own attempt(), under its own lease, with beginSend() and its
// send-started rule. A claim's way out is a send, a person's closing draft or a factoring mark, or
// back where the press found it (the job's backToOrigin()). It never drafts, and a send that has
// started is only ever searched for.
//
// WHAT GOES IS WHAT WAS CONFIRMED. The preview renders in memory with the next number, peeked, not
// reserved, and hands out a token holding that render's digest (one use, 15 minutes, in memory, so a
// restart means preview again). The run compares its own render with it: any difference, and nothing
// is sent. The digest kept on the claim holds a hash of the recipient, not the address.
//
// THE LIVE LOOK COMES FIRST. Both the preview and the run read the load's Payments Table row and
// search Drafts, Sent Mail and Trash before any number or paid call. Saved evidence only ever
// refuses: the status has to read No invoice found for the button to show at all.
//
// THE SAVED PAID CHECK: the rate con found by name, the totals, the billing address need Drive and
// Gemini, which no dashboard read can pay for. After each mailbox pass run, at most 2 loads that pass
// everything else get one prepare() in auto mode (no number, nothing in Gmail). Its code is saved with
// a hash of the load's fingerprint, and it runs again only if the fingerprint changes, or a day later
// for RATECON_MISSING, which a Drive break reads as too.
//
// Logs and notices carry load IDs and codes only. Nothing here adds a driver's name or phone to
// anything that goes to C.H. Robinson: the message is the engine's own.

"use strict";

const crypto = require("crypto");
const appTime = require("./app-time");
const rules = require("./auto-invoice-rules");
const ledger = require("./auto-invoice-ledger");
const factoring = require("./factoring-store");
const sendRules = require("./auto-invoice-send");
const trigger = require("./auto-invoice-trigger");
const { STATUS } = require("./invoice-status");
const { CHR_DOMAIN, LOAD_NUMBER_RE } = require("./chr-events");

const CHECKS_TABLE = "invoice_send_button_checks";
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_MS = 15 * 60 * 1000;
const SEARCH_FRESH_MS = 7 * DAY_MS;
const MAX_PAID_PER_RUN = 2;
const LOAD_KEY_MAX = 100;
const PATHS = Object.freeze({
	state: "/api/auto-invoice/loads/:loadKey/send-now",
	preview: "/api/auto-invoice/loads/:loadKey/send-now/preview",
	send: "/api/auto-invoice/loads/:loadKey/send-now",
});

// Why a load gets no button, or a press went back, as a person reads it after "Handle by hand: ".
const WHY = Object.freeze({
	// The conditions, in the order they're asked.
	NOT_DELIVERED: "it isn't marked Delivered",
	CLAIM_NOT_OPEN: "an automatic invoice was already started or closed for it",
	DRAFT_ROW: "an invoice draft is on file",
	PRESS_ROW: "someone is drafting its invoice by hand",
	SEARCH_STALE: "the last mailbox search is over a week old",
	NO_DELIVERY_DATE: "no delivery date",
	BEFORE_START_DATE: "it's older than the button's start date",
	EMAIL_BLANK: "the Email cell is blank",
	NOT_CHR_EMAIL: "the broker isn't C.H. Robinson by its Email cell",
	CHR_NOT_CONFIRMED: "C.H. Robinson's domain isn't confirmed for automatic invoices",
	CHR_NOT_LISTED: "C.H. Robinson's domain isn't on the send list",
	CHR_OPTED_OUT: "C.H. Robinson's domain is opted out",
	LOAD_ID_SHAPE: "its Load ID isn't C.H. Robinson's shape",
	FACTORED: "marked factored",
	FACTORING_UNREADABLE: "the factoring marker can't be read",
	NO_POD: "no POD on file",
	POD_UNREADABLE: "a POD file can't be read",
	POD_TIME_UNKNOWN: "a POD's upload time can't be read",
	ADVANCE_LINES: "it has advance lines",
	PAYMENT_NOT_PLAIN: "Payment isn't one amount",
	CLOSED_MONTH: "its month is closed",
	MONTH_UNKNOWN: "its month can't be told",
	EVIDENCE_UNREADABLE: "its invoice records couldn't be read",
	// The saved paid check, and what prepare() can refuse.
	PAID_CHECK_PENDING: "its rate con hasn't been checked yet",
	RATECON_MISSING: "no rate con was found by name",
	RATECON_BY_CONTENT: "its rate con was found only by reading Drive files",
	RATECON_TOTAL_UNREAD: "the rate con's total couldn't be read",
	TOTAL_MISMATCH: "the rate con's total and the Payment don't agree",
	INVOICE_TOTAL_UNKNOWN: "no invoice total could be found",
	NO_BILLING_EMAIL: "the rate con names no billing address",
	RECIPIENT_DOMAIN_MISMATCH: "the rate con's billing address isn't on the broker's domain",
	TRAILER_MISMATCH: "the rate con's trailer and the sheet's don't agree",
	POD_PAGE_UNREADABLE: "a POD file can't be read",
	DRAFT_REFUSED: "the invoice couldn't be made",
	// What the job's own free checks can say at the run.
	NOT_COMPLETED: "it isn't marked Delivered any more",
	LOAD_DROPPED: "it was cancelled or deleted",
	WAITING_POD: "no POD on file",
	NO_BROKER_EMAIL: "the Email cell has no address",
	BROKER_EMAIL_FREEMAIL: "the Email cell is a free-mail address",
	BROKER_DOMAIN_UNCONFIRMED: "the broker's domain isn't confirmed for automatic invoices",
	BROKER_OPTED_OUT: "the broker's domain is opted out",
	// The live look.
	MAILBOX_HIT: "an email already names this load",
	MAILBOX_UNREAD: "the mailbox couldn't be searched",
	PAYMENTS_TABLE_HIT: "the Payments Table shows an invoice or a payment for it",
	PAYMENTS_UNREAD: "the Payments Table couldn't be read",
	// The press's own step.
	DIGEST_CHANGED: "the invoice came out different from the one confirmed; press again to see it",
	DIGEST_UNREADABLE: "the invoice's text couldn't be read back",
	SEND_REFUSED: "it failed the last check before sending",
	DOMAIN_NOT_LISTED: "its billing address isn't on the send list",
	HAND_DRAFT_IN_FLIGHT: "someone was drafting its invoice by hand",
	SMTP_REFUSED: "Gmail refused the email, and automatic sending stopped",
	SMTP_LOGIN_REFUSED: "Gmail refused the mailbox login, and automatic sending stopped",
	RESTARTED: "the app restarted before the send",
	BUTTON_TOO_OLD: "the press was over an hour old when the app restarted",
	BUTTON_OFF: "the button is off",
	SENDING_OFF: "automatic sending is off",
	// Something passing: pressing again may work.
	RETRY_LATER: "making the invoice failed; try again in a while",
	DRAFT_FAILED: "making the invoice failed; try again in a while",
	GEMINI_DOWN: "the rate-con reader is unavailable; try again in a while",
	RENDERER_BUSY: "the PDF renderer is busy; try again in a few minutes",
	// Not about this load: the load shows no line for these (NO_LINE).
	JOB_NOT_STARTED: "automatic invoices aren't running",
	STOPPED: "automatic sending is stopped",
	NO_MAILBOX: "no mailbox is set up",
	MAILBOX_PAUSED: "Gmail refused the mailbox login a while ago, so it's paused",
	SETTINGS_UNREADABLE: "the automatic invoice settings can't be read",
	CAP_REACHED: "the hourly or daily invoice limit is reached",
	NOT_NONE_FOUND: "the load's status isn't No invoice found",
});
// The status says why, or it isn't about this load.
const NO_LINE = new Set(["NOT_NONE_FOUND", "JOB_NOT_STARTED", "STOPPED", "NO_MAILBOX", "MAILBOX_PAUSED", "SETTINGS_UNREADABLE", "CAP_REACHED"]);
const CONFIRM_WORDS = "The company mailbox was searched just now: nothing found. This goes to C.H. Robinson now and can't be recalled.";

const whyOf = (code) => WHY[code] || WHY.DRAFT_REFUSED;
const lineOf = (code) => (NO_LINE.has(code) ? "" : `Handle by hand: ${whyOf(code)}`);
const errorOf = (code) => {
	const why = whyOf(code);
	return `${why[0].toUpperCase()}${why.slice(1)}.`;
};

// An error as a log may show it: its code, never its message, which can carry an address.
function codeOf(e) {
	const c = e && e.code;
	return (typeof c === "string" || typeof c === "number") && /^[A-Za-z0-9_]{1,40}$/.test(String(c)) ? String(c) : "ERROR";
}

// A calendar day that exists, as YYYY-MM-DD.
function isDay(s) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const at = new Date(`${s}T12:00:00Z`);
	return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === s;
}

function readSettings(env = {}, { replica = false } = {}) {
	const from = String(env?.CHR_SEND_BUTTON_FROM ?? "").trim();
	const fromDay = isDay(from) ? from : "";
	return { on: replica !== true && String(env?.CHR_SEND_BUTTON_ENABLED ?? "").trim() === "true" && Boolean(fromDay), fromDay };
}

// ── the conditions on one load ───────────────────────────────────────────────

// What the rows and the sheet say about this load: the code of the first condition it fails, or
// null. Asked at the dialog, at the preview, at the press and once more at the run. `load`: the
// job's button.read(), { facts, fromDay, deliveredDay, emailBlank, sendDomains, podTimes, nowMs }.
function loadRefusal(load) {
	const l = load || {};
	const f = l.facts || {};
	if (!f.onSheet || !f.completed || !f.live) return "NOT_DELIVERED";
	if (!l.deliveredDay || !f.hasDeliveryDate) return "NO_DELIVERY_DATE";
	if (!l.fromDay || l.deliveredDay < l.fromDay) return "BEFORE_START_DATE";
	if (l.emailBlank) return "EMAIL_BLANK";
	if (f.brokerDomain !== CHR_DOMAIN) return "NOT_CHR_EMAIL";
	if (!f.brokerDomainConfirmed) return "CHR_NOT_CONFIRMED";
	if (!(l.sendDomains || []).includes(CHR_DOMAIN)) return "CHR_NOT_LISTED";
	if (f.optedOut) return "CHR_OPTED_OUT";
	if (!LOAD_NUMBER_RE.test(rules.loadKey(f.loadId))) return "LOAD_ID_SHAPE";
	if (f.factored) return "FACTORED";
	if (!f.pods) return "NO_POD";
	if (f.podsUnreadable > 0) return "POD_UNREADABLE";
	// With no wait left, a POD time ahead of the clock counts as unreadable, as the job's own send does.
	if (!sendRules.settleState({ podTimes: l.podTimes, nowMs: l.nowMs, settleMinutes: 0 }).settled) return "POD_TIME_UNKNOWN";
	if (f.activeAdvanceLines > 0) return "ADVANCE_LINES";
	if (!(f.paymentCents > 0)) return "PAYMENT_NOT_PLAIN";
	if (!Array.isArray(f.closedMonths)) return "MONTH_UNKNOWN";
	if (f.closedMonths.length) return "CLOSED_MONTH";
	return null;
}

// Only these three: anything else was started, or closed, by something else.
function claimOpen(c) {
	if (!c) return true;
	if (c.button_send_json || sendRules.claimSent(c)) return false;
	return c.state === "baseline" || (c.state === "needs_attention" && c.reason_code === "OFF_GAP");
}

// ── the saved paid check ─────────────────────────────────────────────────────

function ensureChecks(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${CHECKS_TABLE} (
			load_key TEXT PRIMARY KEY,
			code TEXT NOT NULL DEFAULT '',
			fingerprint_sha256 TEXT NOT NULL,
			checked_at TEXT NOT NULL
		)
	`);
}

function readCheck(db, key) {
	if (!ledger.hasTable(db, CHECKS_TABLE)) return null;
	return db.prepare(`SELECT * FROM ${CHECKS_TABLE} WHERE load_key = ?`).get(key) || null;
}

function saveCheck(db, key, { code = "", fingerprint, nowIso }) {
	ensureChecks(db);
	db.prepare(`INSERT INTO ${CHECKS_TABLE} (load_key, code, fingerprint_sha256, checked_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(load_key) DO UPDATE SET code = excluded.code, fingerprint_sha256 = excluded.fingerprint_sha256, checked_at = excluded.checked_at`)
		.run(key, String(code || ""), fingerprint, nowIso);
}

// A Drive break reads as RATECON_MISSING too, so that answer isn't final.
function paidCheckDue(saved, fingerprint, nowMs) {
	if (!saved || saved.fingerprint_sha256 !== fingerprint) return true;
	return saved.code === "RATECON_MISSING" && nowMs - (Date.parse(saved.checked_at) || 0) >= DAY_MS;
}

function paidRefusal(saved, fingerprint, nowMs) {
	if (paidCheckDue(saved, fingerprint, nowMs)) return "PAID_CHECK_PENDING";
	return saved.code || null;
}

// ── a press on the claim ─────────────────────────────────────────────────────

function recordOf(claim) {
	try {
		const record = JSON.parse((claim && claim.button_send_json) || "{}");
		return record && typeof record === "object" ? record : {};
	} catch {
		return {};
	}
}

// Where a press found the claim. Only OFF_GAP goes back to anything but baseline.
function originOf(claim) {
	const from = recordOf(claim).from;
	return from && from.state === "needs_attention" && from.code === "OFF_GAP" ? { state: "needs_attention", code: "OFF_GAP" } : { state: "baseline", code: "" };
}

// What the claim keeps of a digest: the recipient as a hash, so a billing address waits on no claim
// that never sent. digestDifferences() reads it the same way, as long as both sides are masked.
function maskDigest(digest) {
	const d = digest || {};
	return { ...d, renderedAt: "", recipient: crypto.createHash("sha256").update(String(d.recipient || "")).digest("hex") };
}

const confirmedDigest = (claim) => recordOf(claim).digest || {};

// What a start-up does with a claim holding a press: recover (search or record it, or look for a
// send whose commit was lost, then back), queue (it runs once) or back with `code`. A press is a
// confirm "now": over an hour old, a person presses again.
function startUpAction(c, { on = false, first = false, nowMs = 0, staleMs = trigger.STALE_RECORD_MS } = {}) {
	const updated = Date.parse(String(c.updated_at || ""));
	const stale = !Number.isFinite(updated) || nowMs - updated > staleMs;
	if (c.state === "working") return { action: "recover" };
	if (c.delivery === "send" || !["", "reserved", "rendered"].includes(c.stage)) return { action: "recover" };
	if (!on) return { action: "back", code: "BUTTON_OFF" };
	if (first || stale || c.state !== "queued") return { action: "back", code: "BUTTON_TOO_OLD" };
	return { action: "queue" };
}

// ── the routes and the paid check ────────────────────────────────────────────

// deps: job (lib/auto-invoice-job.js create()), evidence (lib/invoice-evidence.js create()), db,
// peekInvoiceNumber(date), logAudit(req, action, entity, entityId, details), now(), timeZone, log.
function create(deps = {}) {
	const d = { log: console, now: () => new Date(), logAudit: () => {}, timeZone: appTime.appTimeZone(), ...deps };
	const button = (d.job && d.job.button) || null;
	const on = Boolean(button && button.on === true);
	const db = d.db;
	// The latest confirm per load: a second preview replaces the first.
	const tokens = new Map();
	const previewing = new Set();
	const nowMs = () => d.now().getTime();

	const statusReaderFor = (headers) => d.evidence.statusReader({ headers });

	// Every condition but the saved paid check, first that fails. Reads no mailbox, pays for nothing.
	function freeRefusal(load, statusOf) {
		const system = button.systemRefusal();
		if (system) return system;
		const f = load.facts;
		if (!f.onSheet || !f.completed || !f.live) return "NOT_DELIVERED";
		let read;
		try {
			read = statusOf(load.row);
		} catch (e) {
			d.log.error(`[invoice-send-button] load ${load.key}: the status couldn't be read: ${codeOf(e)}`);
			return "EVIDENCE_UNREADABLE";
		}
		if (read.status !== STATUS.NONE_FOUND) return "NOT_NONE_FOUND";
		if (!claimOpen(load.claim)) return "CLAIM_NOT_OPEN";
		if (load.rows > 0) return "DRAFT_ROW";
		if (load.presses > 0) return "PRESS_ROW";
		const searched = Date.parse(String(read.searchedAt || ""));
		if (!Number.isFinite(searched) || load.nowMs - searched >= SEARCH_FRESH_MS) return "SEARCH_STALE";
		return loadRefusal(load);
	}

	function refusalOf(load) {
		let statusOf;
		try {
			statusOf = statusReaderFor(load.headers);
		} catch (e) {
			d.log.error(`[invoice-send-button] load ${load.key}: the statuses couldn't be read: ${codeOf(e)}`);
			return "EVIDENCE_UNREADABLE";
		}
		return freeRefusal(load, statusOf) || paidRefusal(readCheck(db, load.key), rules.fingerprintSha256(load.facts), load.nowMs);
	}

	// The whole of §7.2, or why not. The sheet down throws; everything else is an answer. The
	// marker is read here because the job's snapshot throws on one it can't read.
	async function check(key) {
		const system = button.systemRefusal();
		if (system) return { refusal: system };
		try {
			if (factoring.isFactored(db, key)) return { refusal: "FACTORED" };
		} catch {
			return { refusal: "FACTORING_UNREADABLE" };
		}
		const load = await button.read(key);
		return { load, refusal: refusalOf(load) };
	}

	// The saved paid check: prepare() once, in auto mode, with no number and nothing in Gmail.
	// { code } ("" when it passes) or { temporary: true }: nothing to save, and it's asked again.
	async function paidCheck(load) {
		const built = await button.buildMessage.prepare(load.facts, load.facts.loadId);
		if (built.ok) return { code: button.recipientOk(built.planned) ? "" : "DOMAIN_NOT_LISTED" };
		if (!built.prep) return { code: built.code };
		const cls = rules.classifyRefusal(built.prep);
		return cls.kind === "temporary" ? { temporary: true } : { code: cls.code };
	}

	// The confirm's message: what a send would be, built in memory with the next number peeked, not
	// reserved, then the same outgoing check. Writes nothing.
	async function buildConfirm(load) {
		const built = await button.buildMessage.prepare(load.facts, load.facts.loadId);
		if (!built.ok) return { ok: false, code: built.prep ? rules.classifyRefusal(built.prep).code : built.code };
		if (!button.recipientOk(built.planned)) return { ok: false, code: "DOMAIN_NOT_LISTED" };
		const now = d.now();
		const invoiceId = String(d.peekInvoiceNumber(now));
		let msg;
		try {
			msg = await button.buildMessage.render(built, load.facts, { invoiceId, invoiceDate: appTime.dayInZone(now, d.timeZone) });
		} catch (e) {
			return { ok: false, code: e && e.code === "RENDERER_BUSY" ? "RENDERER_BUSY" : "RETRY_LATER" };
		}
		if (!msg.ok) return { ok: false, code: msg.code };
		if (sendRules.outgoingCheck({ message: msg.message, rendered: msg.rendered, planned: built.planned, domains: load.sendDomains })) return { ok: false, code: "SEND_REFUSED" };
		const digest = maskDigest(rules.messageDigest(msg.message));
		// A digest that can't be compared would send every run back.
		if (rules.digestDifferences(digest, digest).length) return { ok: false, code: "DIGEST_UNREADABLE" };
		return { ok: true, to: msg.to, total: msg.rendered.total, invoiceId, attachments: msg.message.attachments.map((a) => a.filename), digest };
	}

	const keyOf = (req) => {
		const key = rules.loadKey(String((req.params && req.params.loadKey) || ""));
		return key && key.length <= LOAD_KEY_MAX ? key : "";
	};
	const refuse = (res, code, http = 409) => res.status(http).json({ error: errorOf(code), code });
	const sheetDown = (res) => res.status(503).json({ error: "Job Tracking could not be read; try again.", code: "SHEET_UNAVAILABLE" });
	const badKey = (res) => res.status(400).json({ error: "Unknown load.", code: "LOAD_KEY_INVALID" });

	function dropOldTokens(atMs) {
		for (const [key, t] of tokens) {
			if (atMs - t.atMs >= TOKEN_MS) tokens.delete(key);
		}
	}

	// One use: a token presented by the account that previewed is gone, whatever happens next.
	function takeToken(key, token, user) {
		const atMs = nowMs();
		const held = tokens.get(key);
		if (!held || typeof token !== "string" || held.token !== token) {
			dropOldTokens(atMs);
			return { code: "BUTTON_PREVIEW_AGAIN" };
		}
		if (held.byId !== user.id || held.by !== user.username) return { code: "BUTTON_PREVIEW_AGAIN" };
		tokens.delete(key);
		if (atMs - held.atMs >= TOKEN_MS) return { code: "BUTTON_PREVIEW_AGAIN" };
		return { held };
	}

	// Whether this load shows the button, and the one line if not. Free: no mailbox, no paid call.
	async function stateRoute(req, res) {
		const key = keyOf(req);
		if (!key) return badKey(res);
		try {
			const { refusal } = await check(key);
			if (refusal) return res.json({ show: false, code: refusal, line: lineOf(refusal) });
			return res.json({ show: true });
		} catch (e) {
			d.log.error(`[invoice-send-button] load ${key}: the check failed: ${codeOf(e)}`);
			return sheetDown(res);
		}
	}

	// The confirm: every condition, then the live look, then the paid read and a render in memory,
	// then the outgoing check. It writes nothing but the mailbox's refreshed evidence.
	async function previewRoute(req, res) {
		const key = keyOf(req);
		if (!key) return badKey(res);
		if (previewing.has(key)) return res.status(409).json({ error: "This load's invoice is being prepared already.", code: "BUTTON_PREVIEW_BUSY" });
		previewing.add(key);
		try {
			button.invalidate();
			const { load, refusal } = await check(key);
			if (refusal) return refuse(res, refusal);
			if (button.geminiDown()) return refuse(res, "GEMINI_DOWN");
			const found = await button.look(load);
			if (found) return refuse(res, found);
			const built = await buildConfirm(load);
			if (!built.ok) return refuse(res, built.code);
			// After the last await: the rows again, then the token.
			const again = refusalOf(button.refresh(load));
			if (again) return refuse(res, again);
			const user = (req.session && req.session.user) || {};
			const atMs = nowMs();
			const token = crypto.randomBytes(24).toString("hex");
			dropOldTokens(atMs);
			tokens.set(key, { token, atMs, by: user.username, byId: user.id, loadId: load.facts.loadId, digest: built.digest });
			return res.json({
				ok: true,
				token,
				expiresAt: new Date(atMs + TOKEN_MS).toISOString(),
				loadId: load.facts.loadId,
				amount: built.total,
				to: built.to,
				nextInvoiceId: built.invoiceId,
				attachments: built.attachments,
				words: CONFIRM_WORDS,
			});
		} catch (e) {
			d.log.error(`[invoice-send-button] load ${key}: the preview failed: ${codeOf(e)}`);
			return sheetDown(res);
		} finally {
			previewing.delete(key);
		}
	}

	// The press: the token, every condition again, then the claim moves in one conditional update,
	// with nothing awaited between its check and its write. The run starts after the answer.
	async function sendRoute(req, res) {
		const key = keyOf(req);
		if (!key) return badKey(res);
		const user = (req.session && req.session.user) || {};
		const taken = takeToken(key, req.body && req.body.token, user);
		if (!taken.held) return res.status(409).json({ error: "Preview this invoice again before sending it.", code: taken.code });
		let pressed;
		try {
			const checked = await check(key);
			if (checked.refusal) return refuse(res, checked.refusal);
			const again = refusalOf(button.refresh(checked.load));
			if (again) return refuse(res, again);
			pressed = button.press({ key, loadId: taken.held.loadId, by: user.username, byId: user.id, digest: taken.held.digest });
		} catch (e) {
			d.log.error(`[invoice-send-button] load ${key}: the press failed: ${codeOf(e)}`);
			return sheetDown(res);
		}
		if (!pressed.ok) return res.status(409).json({ error: "This load's invoice was started another way. Reload the load.", code: "BUTTON_CLAIM_MOVED" });
		// The claim has moved, so the run goes on whatever becomes of this row.
		try {
			d.logAudit(req, "auto_invoice_button_press", "load", taken.held.loadId, `send to C.H. Robinson pressed by ${user.username || "unknown"} (was: ${pressed.from.code || pressed.from.state})`);
		} catch (e) {
			d.log.error(`[invoice-send-button] load ${key}: the press's audit row failed: ${codeOf(e)}`);
		}
		res.json({ ok: true, loadId: taken.held.loadId });
		button.wake();
	}

	// Flag off, the request goes on as if the route weren't there, before the role check, so even
	// an anonymous request can't tell. Each route's guards come after this.
	function mount(app, { requireRole, refuseCrossSite = null, limiter = null } = {}) {
		if (typeof requireRole !== "function") throw new Error("invoice-send-button mount needs requireRole");
		const absentWhenOff = (req, res, next) => (on ? next() : next("route"));
		const role = requireRole("Super Admin");
		const writes = [absentWhenOff, role, ...(refuseCrossSite ? [refuseCrossSite] : []), ...(limiter ? [limiter] : [])];
		app.get(PATHS.state, absentWhenOff, role, stateRoute);
		app.post(PATHS.preview, ...writes, previewRoute);
		app.post(PATHS.send, ...writes, sendRoute);
	}

	// One step of the mailbox pass: at most 2 loads that pass everything else, newest first.
	// Never rejects.
	async function runPaidChecks() {
		const out = { checked: 0, temporary: 0 };
		if (!on) return out;
		try {
			if (button.geminiDown()) return out;
			const { headers, loads } = await button.candidates();
			const statusOf = statusReaderFor(headers);
			const due = [];
			for (const load of loads) {
				if (freeRefusal(load, statusOf)) continue;
				const fingerprint = rules.fingerprintSha256(load.facts);
				if (paidCheckDue(readCheck(db, load.key), fingerprint, load.nowMs)) due.push({ load, fingerprint });
			}
			due.sort((a, b) => (a.load.deliveredDay === b.load.deliveredDay ? (a.load.key < b.load.key ? -1 : 1) : a.load.deliveredDay < b.load.deliveredDay ? 1 : -1));
			for (const { load, fingerprint } of due.slice(0, MAX_PAID_PER_RUN)) {
				const answer = await paidCheck(load);
				if (answer.temporary) {
					out.temporary++;
					continue;
				}
				saveCheck(db, load.key, { code: answer.code, fingerprint, nowIso: new Date(nowMs()).toISOString() });
				out.checked++;
			}
		} catch (e) {
			d.log.error(`[invoice-send-button] the paid check stopped: ${codeOf(e)}`);
		}
		return out;
	}

	return { on, mount, runPaidChecks };
}

module.exports = {
	CHECKS_TABLE,
	CHR_DOMAIN,
	CONFIRM_WORDS,
	MAX_PAID_PER_RUN,
	PATHS,
	SEARCH_FRESH_MS,
	TOKEN_MS,
	WHY,
	readSettings,
	loadRefusal,
	claimOpen,
	readCheck,
	saveCheck,
	paidCheckDue,
	paidRefusal,
	originOf,
	maskDigest,
	confirmedDigest,
	startUpAction,
	whyOf,
	lineOf,
	errorOf,
	create,
};
