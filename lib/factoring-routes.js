// Factored loads (Triumph, per load): the routes, the dashboard annotation and
// the Draft Invoice button's steps around the marker. The rules and the writes
// are lib/factoring-store.js; this module adds who may act and the answers.
//
// Settings, read once at start (all off in a replica):
//   TRIUMPH_FACTORING_ENABLED  marking, on only when exactly "true". Off: the
//     marking route answers 404 FEATURE_OFF and the dialog has no switch. Marks
//     already made are honoured whatever it says.
//   TRIUMPH_FACTOR_MARK_IDS    the accounts that may mark, clear and record
//     "Handled in Triumph's process", and, once the two below allow it, confirm a
//     factored draft (lib/listed-accounts.js). Unset or invalid: nobody. The shared
//     login never counts.
//   TRIUMPH_NOA_LINES          the assignment lines a factored invoice prints instead of
//     the bank block, word for word (lib/triumph-rules.js parseNoaLines()). Unset or
//     invalid: a factored invoice is refused. Never in a replica.
//   The submit mode            lib/triumph-rules.js submitMode(). A factored draft can be
//     confirmed only once it reads live: before Triumph is live, the lines would send the
//     broker to a party holding nothing. Setting the lines alone opens nothing.
//
// `readJobTracking` (a dep): the sheet as the switch checks it, so a mark lands only
// on a key a row holds.
//
// Routes (Super Admin; writes also refuseCrossSite):
//   POST /api/factoring/loads/:loadKey                  mark or clear (switch)
//   POST /api/factoring/loads/:loadKey/handled-outside  no switch, listed only
//   POST /api/loads/:loadId/invoice-draft-inflight/resolve  "Check Gmail" on a
//     button draft that may be in Gmail: no switch, no list
//
// draftEarly() and draftHandoff() are the Draft Invoice button's steps: before
// prepare(), and from the render to the record. previewCheck() is the live preview's
// step, and assignmentFor() what the invoice engine prints for a load. loadIdSave() is
// the row saves' step around a Load ID write: a marked load keeps its ID.

"use strict";

const store = require("./factoring-store");
const rules = require("./auto-invoice-rules");
const listedAccounts = require("./listed-accounts");
const triumphRules = require("./triumph-rules");
const { withAssignment } = require("./triumph-invoice");
const { isSharedLoginName } = require("./sign-in");

const LOAD_KEY_MAX = 100;
const ANSWERS = Object.freeze(["in_gmail", "not_in_gmail"]);

function readSettings(env = {}, { replica = false } = {}) {
	const markingOn = !replica && String((env && env.TRIUMPH_FACTORING_ENABLED) ?? "").trim() === "true";
	const noa = triumphRules.parseNoaLines(env ? env.TRIUMPH_NOA_LINES : undefined);
	return {
		markingOn,
		markIds: listedAccounts.parseListedAccountIds(env ? env.TRIUMPH_FACTOR_MARK_IDS : undefined),
		noaLines: !replica && noa.ok ? Object.freeze(noa.lines) : null,
		submitMode: triumphRules.submitMode(env, { replica }),
	};
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
	const { markingOn, markIds, noaLines, submitMode } = readSettings(d.env, { replica: d.replica });
	const nowIso = () => d.now().toISOString();

	// A listed account, signed in as itself (never the shared login).
	function mayMark(user) {
		return Boolean(user) && markIds.verdict(user) === "listed" && !isSharedLoginName(user.username);
	}

	const userOf = (req) => (req && req.session && req.session.user) || {};
	const auditFor = (req, loadId) => (action, details) => d.logAudit(req, action, "load", loadId, details);
	const answer = (r) => ({ error: r.error, code: r.code, ...(r.invoiceId ? { invoiceId: r.invoiceId } : {}), ...(r.drafts ? { drafts: r.drafts } : {}) });

	// ── the Draft Invoice button ────────────────────────────────────────────

	// The checks a press and a preview share. `body.confirmFactored` (true) with
	// `body.factoredReason` asks to draft a factored load: refused for everyone until
	// assignment lines exist and the submit mode reads live, and then only a listed
	// account may. Nothing in the request can say either holds.
	function pressGates(req, loadId) {
		const body = req && req.body && typeof req.body === "object" ? req.body : {};
		return {
			key: rules.loadKey(loadId),
			confirm: { confirmFactored: body.confirmFactored, reason: body.factoredReason },
			mayConfirm: mayMark(userOf(req)),
			hasAssignmentLines: noaLines !== null,
			live: submitMode === "live",
		};
	}

	// Before prepare(): a refusal answers { ok: false, http, json } and nothing is
	// read or minted.
	function draftEarly(req, loadId) {
		const r = store.draftEarlyCheck(db, { ...pressGates(req, loadId), nowIso: nowIso() });
		if (!r.ok) return { ok: false, http: r.http, json: answer(r) };
		return r;
	}

	// The live preview builds its page outside the engine, so it asks here what the page
	// prints: { ok: true, assignment } (null, or { lines }), or the press's own refusal.
	// Anything the database throws is a refusal too: the route calls this outside its try.
	function previewCheck(req, loadId) {
		let r;
		try {
			r = store.previewCheck(db, pressGates(req, loadId));
		} catch {
			r = store.refusal("FACTORING_UNREADABLE");
		}
		if (!r.ok) return { ok: false, http: r.http, json: answer(r) };
		return { ok: true, assignment: r.factored ? { lines: noaLines } : null };
	}

	// What the invoice engine prints in place of the bank block: null for a load that
	// isn't factored, or { lines }. Throws rather than answer null when that can't be
	// said, so a factored invoice can never fall back to the bank block.
	function assignmentFor(loadId) {
		const thrown = (code) => Object.assign(new Error(store.WORDS[code]), { code });
		let factored;
		try {
			factored = store.isFactored(db, rules.loadKey(loadId));
		} catch {
			throw thrown("FACTORING_UNREADABLE");
		}
		if (!factored) return null;
		if (noaLines === null) throw thrown("NOA_UNCONFIGURED");
		return { lines: noaLines };
	}

	// From the render (the last await) to the record. Runs the checks again and
	// writes the in-flight row; a refusal voids the minted number and answers
	// { ok: false, http, json }. Otherwise the steps the route calls in turn.
	// `reissue`: the press confirmed a re-issue of an invoice the auto job sent
	// (lib/auto-invoice-job.js draftButtonCheck()). `printedAssignment`: the rendered
	// invoice carries the factor's lines.
	function draftHandoff(req, { loadId, invoiceId, mintedInvoiceId, confirmed = false, reissue = false, printedAssignment = false, reason = "", path, user = "", recipient = "", total = "" }) {
		const key = rules.loadKey(loadId);
		const messageId = path === "imap" ? d.newMessageId(user) : "";
		const audit = auditFor(req, loadId);
		const voidNumber = (code) => audit("invoice_number_void",
			`${mintedInvoiceId} was minted for this load and never used${invoiceId !== mintedInvoiceId ? ` (printed as ${invoiceId})` : ""} (${code})`);
		const begun = store.draftBegin(db, { key, loadId, invoiceId, messageId, path, confirmed, reissue, printedAssignment, actorId: userOf(req).id, recipient, total, nowIso: nowIso() });
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
				const r = store.draftBeforeN8n(db, { key, invoiceId, confirmed, reissue, printedAssignment, nowIso: nowIso() });
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

	// ── the row edits ───────────────────────────────────────────────────────

	// The Load ID saves running now, by key, and the switch's reads of the sheet still waiting for
	// an answer. The app is one process, so a press and a save see each other here.
	const changing = new Map();
	const sheetLooks = new Set();

	// The row saves' step around a Load ID write, whoever asks and whatever the settings say. Called in
	// the tick that starts the write, so no mark lands unseen before it, and the switch is refused on
	// either key until done(). A refusal for the route to answer, or { ok: true, done }.
	function loadIdSave({ from, to }) {
		const r = store.loadIdChangeCheck(db, { from });
		if (r) return { ok: false, http: r.http, code: r.code, json: answer(r) };
		const keys = [rules.loadKey(from), rules.loadKey(to)].filter(Boolean);
		for (const k of keys) changing.set(k, (changing.get(k) || 0) + 1);
		for (const look of sheetLooks) if (keys.includes(look.key)) look.stale = true;
		const done = () => {
			for (const k of keys) {
				if (changing.get(k) > 1) changing.set(k, changing.get(k) - 1);
				else changing.delete(k);
			}
		};
		return { ok: true, done };
	}

	// Does a row hold this key now? A dialog can stay open on an ID a save has since changed, and a
	// mark on that key would guard nothing. A save that begins on the key during the read makes its
	// answer old; the caller has refused one already running. A refusal, or null.
	async function sheetRefusal(key) {
		const look = { key, stale: false };
		sheetLooks.add(look);
		let onSheet;
		try {
			const jt = await d.readJobTracking();
			const idCol = rules.jobColumns(jt.headers).loadIdCol;
			if (!idCol) return store.refusal("FACTORING_SHEET_UNREADABLE");
			onSheet = jt.data.some((row) => rules.loadKey(row[idCol]) === key);
		} catch {
			return store.refusal("FACTORING_SHEET_UNREADABLE");
		} finally {
			sheetLooks.delete(look);
		}
		if (look.stale) return store.refusal("LOAD_ID_CHANGING");
		return onSheet ? null : store.refusal("LOAD_NOT_ON_SHEET");
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
		// Every route opens with the role gate, then the cross-site guard.
		const crossSite = refuseCrossSite ? [refuseCrossSite] : [];
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

		const markOrClear = async (req, res) => {
			if (!markingOn) return res.status(404).json({ error: "Factoring is off.", code: "FEATURE_OFF" });
			if (!mayMark(userOf(req))) return notListed(res);
			const key = keyOf(req.params && req.params.loadKey);
			if (!key) return res.status(400).json({ error: "Unknown load.", code: "LOAD_KEY_INVALID" });
			const body = bodyOf(req);
			if (typeof body.factored !== "boolean") return res.status(400).json({ error: "Send factored: true or false.", code: "FACTORED_INVALID" });
			const loadId = String(body.loadId || key).slice(0, LOAD_KEY_MAX);
			if (changing.has(key)) return refuse(req, res, loadId, store.refusal("LOAD_ID_CHANGING"));
			if (d.readJobTracking) {
				const gone = await sheetRefusal(key);
				if (gone) return refuse(req, res, loadId, gone);
			}
			// No await from here to the write.
			const args = { key, loadId, reason: body.reason, source: "person", actor: userOf(req), nowIso: nowIso(), audit: auditFor(req, loadId) };
			const r = body.factored ? store.mark(db, { ...args, confirmNotSent: body.confirmNotSent === true }) : store.clear(db, args);
			if (!r.ok) return refuse(req, res, loadId, r);
			res.json({ ok: true, changed: r.changed, factored: body.factored });
		};
		// Express 4 doesn't catch an async handler's rejection, and this process has no handler for one.
		app.post("/api/factoring/loads/:loadKey", requireRole("Super Admin"), ...crossSite, (req, res, next) => markOrClear(req, res).catch(next));

		app.post("/api/factoring/loads/:loadKey/handled-outside", requireRole("Super Admin"), ...crossSite, (req, res) => {
			if (!mayMark(userOf(req))) return notListed(res);
			const key = keyOf(req.params && req.params.loadKey);
			if (!key) return res.status(400).json({ error: "Unknown load.", code: "LOAD_KEY_INVALID" });
			const body = bodyOf(req);
			const loadId = String(body.loadId || key).slice(0, LOAD_KEY_MAX);
			if (changing.has(key)) return refuse(req, res, loadId, store.refusal("LOAD_ID_CHANGING"));
			const r = store.handledOutside(db, { key, reason: body.reason, actor: userOf(req), nowIso: nowIso(), audit: auditFor(req, loadId) });
			if (!r.ok) return refuse(req, res, loadId, r);
			res.json({ ok: true, locked: true });
		});

		app.post("/api/loads/:loadId/invoice-draft-inflight/resolve", requireRole("Super Admin"), ...crossSite, async (req, res) => {
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

	return { markingOn, markIds, noaLinesSet: noaLines !== null, submitMode, mayMark, draftEarly, previewCheck, assignmentFor, withAssignment, draftHandoff, loadIdSave, annotateDashboard, mount };
}

module.exports = { create, readSettings, LOAD_KEY_MAX };
