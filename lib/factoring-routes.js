// Factored loads (Triumph, per load): the routes, the dashboard annotation and
// the Draft Invoice button's steps around the marker. The rules and the writes
// are lib/factoring-store.js; this module adds who may act and the answers.
//
// Settings, read once at start (all off in a replica):
//   TRIUMPH_FACTORING_ENABLED  marking, on only when exactly "true". Off: the
//     marking route answers 404 FEATURE_OFF and the dialog has no switch. Marks
//     already made are honoured whatever it says.
//   TRIUMPH_FACTOR_MARK_IDS    the accounts that may mark, clear, record
//     "Handled in Triumph's process" and confirm a factored draft
//     (lib/listed-accounts.js). Unset or invalid: nobody. The shared login never
//     counts.
//
// Routes (Super Admin; writes also refuseCrossSite):
//   POST /api/factoring/loads/:loadKey                  mark or clear (switch)
//   POST /api/factoring/loads/:loadKey/handled-outside  no switch, listed only
//   POST /api/loads/:loadId/invoice-draft-inflight/resolve  "Check Gmail" on a
//     button draft that may be in Gmail: no switch, no list
//
// draftEarly() and draftHandoff() are the Draft Invoice button's steps: before
// prepare(), and from the render to the record.

"use strict";

const store = require("./factoring-store");
const rules = require("./auto-invoice-rules");
const listedAccounts = require("./listed-accounts");
const { isSharedLoginName } = require("./sign-in");

const LOAD_KEY_MAX = 100;
const ANSWERS = Object.freeze(["in_gmail", "not_in_gmail"]);

function readSettings(env = {}, { replica = false } = {}) {
	const markingOn = !replica && String((env && env.TRIUMPH_FACTORING_ENABLED) ?? "").trim() === "true";
	return { markingOn, markIds: listedAccounts.parseListedAccountIds(env ? env.TRIUMPH_FACTOR_MARK_IDS : undefined) };
}

function create(deps = {}) {
	const d = {
		env: {},
		replica: false,
		log: console,
		now: () => new Date(),
		logAudit: () => {},
		logAuditRefusal: () => {},
		newMessageId: (user) => require("./imap-draft").newMessageId(user),
		findDraftByMessageId: null,
		mailbox: () => ({ user: "", pass: "" }),
		...deps,
	};
	const db = d.db;
	const { markingOn, markIds } = readSettings(d.env, { replica: d.replica });
	const nowIso = () => d.now().toISOString();

	// A listed account, signed in as itself (never the shared login).
	function mayMark(user) {
		return Boolean(user) && markIds.verdict(user) === "listed" && !isSharedLoginName(user.username);
	}

	const userOf = (req) => (req && req.session && req.session.user) || {};
	const auditFor = (req, loadId) => (action, details) => d.logAudit(req, action, "load", loadId, details);
	const answer = (r) => ({ error: r.error, code: r.code, ...(r.invoiceId ? { invoiceId: r.invoiceId } : {}), ...(r.drafts ? { drafts: r.drafts } : {}) });

	// ── the Draft Invoice button ────────────────────────────────────────────

	// Before prepare(): a refusal answers { ok: false, http, json } and nothing is
	// read or minted. `body.confirmFactored` (true) with `body.factoredReason`
	// drafts a factored load; only a listed account may.
	function draftEarly(req, loadId) {
		const body = req && req.body && typeof req.body === "object" ? req.body : {};
		const r = store.draftEarlyCheck(db, {
			key: rules.loadKey(loadId),
			confirm: { confirmFactored: body.confirmFactored, reason: body.factoredReason },
			mayConfirm: mayMark(userOf(req)),
			nowIso: nowIso(),
		});
		if (!r.ok) return { ok: false, http: r.http, json: answer(r) };
		return r;
	}

	// From the render (the last await) to the record. Runs the checks again and
	// writes the in-flight row; a refusal voids the minted number and answers
	// { ok: false, http, json }. Otherwise the steps the route calls in turn.
	function draftHandoff(req, { loadId, invoiceId, mintedInvoiceId, confirmed = false, reason = "", path, user = "", recipient = "", total = "" }) {
		const key = rules.loadKey(loadId);
		const messageId = path === "imap" ? d.newMessageId(user) : "";
		const audit = auditFor(req, loadId);
		const voidNumber = (code) => audit("invoice_number_void",
			`${mintedInvoiceId} was minted for this load and never used${invoiceId !== mintedInvoiceId ? ` (printed as ${invoiceId})` : ""} (${code})`);
		const begun = store.draftBegin(db, { key, loadId, invoiceId, messageId, path, confirmed, actorId: userOf(req).id, recipient, total, nowIso: nowIso() });
		if (!begun.ok) {
			voidNumber(begun.code);
			return { ok: false, http: begun.http, json: answer(begun) };
		}
		if (confirmed) audit("invoice_draft_factored_confirmed", `${invoiceId}: drafted although factored: ${reason}`);
		const maybeWords = `Invoice #${invoiceId} may have been saved as a Gmail draft. Use 'Check Gmail' on the load before drafting again.`;
		let maybe = false;
		return {
			ok: true,
			messageId,
			maybeWords,
			get maybe() { return maybe; },
			// record()'s option: its own transaction deletes the row with the draft row.
			settle: { loadKey: key, invoiceId },
			// record() answered: a draft it couldn't record is in Gmail all the same.
			// Answers what it was given.
			recorded(result) {
				if (!(result && result.recorded)) {
					store.draftMaybe(db, { key, invoiceId, reason: "unrecorded", nowIso: nowIso() });
					maybe = true;
				}
				return result;
			},
			// The IMAP append failed. No answer after the message was sent: it may be
			// in Gmail. Anything else: it isn't, and n8n (if set) comes next.
			imapFailed(e) {
				if (e && e.stage === "literal" && !e.answered) {
					store.draftMaybe(db, { key, invoiceId, path: "imap", nowIso: nowIso() });
					maybe = true;
				}
				return maybe;
			},
			// Before the n8n POST: the checks again. A refusal after an unanswered IMAP
			// leaves the row maybe drafted and voids nothing.
			beforeN8n() {
				const r = store.draftBeforeN8n(db, { key, invoiceId, confirmed, nowIso: nowIso() });
				if (r.ok) return { ok: true };
				if (r.keep) return { ok: false, http: 502, json: { error: `${maybeWords} (${r.error})`, code: "DRAFT_MAYBE_SAVED", invoiceId } };
				store.draftDrop(db, { key, invoiceId });
				voidNumber(r.code);
				return { ok: false, http: r.http, json: answer(r) };
			},
			// n8n timed out, failed on the network or answered non-2xx: maybe drafted.
			n8nFailed() {
				store.draftMaybe(db, { key, invoiceId, path: "n8n", nowIso: nowIso() });
				maybe = true;
			},
			// A definite failure: no draft exists.
			noDraft(code) {
				store.draftDrop(db, { key, invoiceId });
				voidNumber(code);
			},
		};
	}

	// ── what Super Admins see ───────────────────────────────────────────────

	// `_factoring` and `_draftInflight` on a Super Admin's request-local rows.
	function annotateDashboard(req, { headers, active = [], completed = [] }) {
		const user = userOf(req);
		if (user.role !== "Super Admin") return;
		const idCol = rules.jobColumns(headers || []).loadIdCol;
		if (!idCol) return;
		const listed = mayMark(user);
		const opts = { idCol, all: markingOn && listed, canMark: markingOn && listed, canRecordOutside: listed, nowIso: nowIso() };
		store.annotateRows(db, { ...opts, rows: active });
		store.annotateRows(db, { ...opts, rows: completed, inflight: true });
	}

	// ── routes ──────────────────────────────────────────────────────────────

	function mount(app, { requireRole, refuseCrossSite = null } = {}) {
		if (typeof requireRole !== "function") throw new Error("factoring mount needs requireRole");
		const guard = [requireRole("Super Admin")];
		const writeGuard = refuseCrossSite ? [...guard, refuseCrossSite] : guard;
		// Express has already decoded the parameter.
		const keyOf = (v) => {
			const key = rules.loadKey(String(v || ""));
			return key && key.length <= LOAD_KEY_MAX ? key : "";
		};
		const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
		const refuse = (req, res, loadId, r) => {
			d.logAuditRefusal(req, "factoring_mark_blocked", "load", loadId, `${r.code}`, r.code);
			return res.status(r.http).json(answer(r));
		};
		const notListed = (res) => res.status(403).json({ error: store.WORDS.FACTORING_NOT_LISTED, code: "FACTORING_NOT_LISTED" });

		app.post("/api/factoring/loads/:loadKey", ...writeGuard, (req, res) => {
			if (!markingOn) return res.status(404).json({ error: "Factoring is off.", code: "FEATURE_OFF" });
			if (!mayMark(userOf(req))) return notListed(res);
			const key = keyOf(req.params && req.params.loadKey);
			if (!key) return res.status(400).json({ error: "Unknown load.", code: "LOAD_KEY_INVALID" });
			const body = bodyOf(req);
			if (typeof body.factored !== "boolean") return res.status(400).json({ error: "Send factored: true or false.", code: "FACTORED_INVALID" });
			const loadId = String(body.loadId || key).slice(0, LOAD_KEY_MAX);
			const args = { key, loadId, reason: body.reason, source: "person", actor: userOf(req), nowIso: nowIso(), audit: auditFor(req, loadId) };
			const r = body.factored ? store.mark(db, { ...args, confirmNotSent: body.confirmNotSent === true }) : store.clear(db, args);
			if (!r.ok) return refuse(req, res, loadId, r);
			res.json({ ok: true, changed: r.changed, factored: body.factored });
		});

		app.post("/api/factoring/loads/:loadKey/handled-outside", ...writeGuard, (req, res) => {
			if (!mayMark(userOf(req))) return notListed(res);
			const key = keyOf(req.params && req.params.loadKey);
			if (!key) return res.status(400).json({ error: "Unknown load.", code: "LOAD_KEY_INVALID" });
			const body = bodyOf(req);
			const loadId = String(body.loadId || key).slice(0, LOAD_KEY_MAX);
			const r = store.handledOutside(db, { key, reason: body.reason, actor: userOf(req), nowIso: nowIso(), audit: auditFor(req, loadId) });
			if (!r.ok) return refuse(req, res, loadId, r);
			res.json({ ok: true, locked: true });
		});

		app.post("/api/loads/:loadId/invoice-draft-inflight/resolve", ...writeGuard, async (req, res) => {
			const loadId = String((req.params && req.params.loadId) || "").trim();
			const key = keyOf(loadId);
			if (!key) return res.status(400).json({ error: "Unknown load.", code: "LOAD_KEY_INVALID" });
			const body = bodyOf(req);
			const rows = store.inflightRows(db, key, nowIso());
			const row = body.invoiceId ? rows.find((r) => r.invoice_id === String(body.invoiceId)) : rows.find((r) => r.effective === "maybe_drafted") || rows[0];
			if (!row) return res.status(404).json({ error: "There is no invoice draft waiting to be checked for this load.", code: "INFLIGHT_NOT_FOUND" });
			if (row.effective !== "maybe_drafted") return res.status(409).json({ error: store.WORDS.INVOICE_DRAFT_IN_FLIGHT, code: "INVOICE_DRAFT_IN_FLIGHT" });
			const mb = d.mailbox() || {};
			const canSearch = row.path === "imap" && row.message_id && mb.user && mb.pass && typeof d.findDraftByMessageId === "function";
			let found;
			let how;
			if (canSearch) {
				try {
					const hit = await d.findDraftByMessageId({ user: mb.user, pass: mb.pass, messageId: row.message_id });
					found = Boolean(hit && hit.found);
					how = "searched Gmail";
				} catch {
					return res.status(503).json({ error: "Gmail couldn't be searched just now, so nothing changed. Try again in a few minutes.", code: "GMAIL_UNKNOWN" });
				}
			} else {
				const reason = store.cleanReason(body.reason);
				if (!ANSWERS.includes(body.answer) || !reason) {
					return res.status(400).json({ error: "Look in Gmail Drafts and Sent Mail, then answer whether the draft is there, with a reason.", code: "ANSWER_REQUIRED" });
				}
				found = body.answer === "in_gmail";
				how = `a person's answer: ${reason}`;
			}
			// After the search's await: resolveInflight() reads the row again.
			const audit = auditFor(req, row.load_id || loadId);
			const r = store.resolveInflight(db, { key, invoiceId: row.invoice_id, found, actor: userOf(req), nowIso: nowIso(), audit });
			if (!r.ok) return res.status(r.http).json(answer(r));
			audit("invoice_draft_inflight_resolved", `${row.invoice_id}: ${found ? "in Gmail, recorded" : "not in Gmail"} (${how})`);
			if (!found) audit("invoice_number_void", `${row.invoice_id} was never saved as a draft (checked: not in Gmail)`);
			res.json({ ok: true, found, invoiceId: row.invoice_id });
		});
	}

	return { markingOn, markIds, mayMark, draftEarly, draftHandoff, annotateDashboard, mount };
}

module.exports = { create, readSettings, LOAD_KEY_MAX };
