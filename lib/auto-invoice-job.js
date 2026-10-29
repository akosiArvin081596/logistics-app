// Automatic broker invoice drafts (AUTO_INVOICE_DRAFTS_ENABLED): the job.
//
// A sweep of the cached Job Tracking finds loads that became Delivered (every
// route that writes a status, and edits made straight in the sheet, end up
// there) and keeps one claim per load in lib/auto-invoice-ledger.js. work()
// drafts the queued ones through the same engine as the Super Admin's Draft
// Invoice button (prepare / render / record), into Gmail Drafts; nothing is
// ever sent. Anything a person would have fixed in the review becomes "needs
// attention" with its reason (lib/auto-invoice-rules.js).
//
// Modes (rules.readMode()): off: nothing, no tables, the routes answer 404
// FEATURE_OFF; shadow: the sweep only logs what it would do in
// auto_invoice_shadow, with no engine, number, Drive, Gemini or Gmail call;
// on: drafts. The caller (server.js) runs tick() on a timer behind startsJob(),
// so a replica runs nothing.
//
// create(deps) is given everything it touches:
//   db                      better-sqlite3 handle (the server's own)
//   env                     the settings (process.env)
//   readJobTracking()       getJobTrackingCached(): never mutated here
//   closedMonthsOf(h, row)  integrityClosedMonthsOf(): [] open, [..] closed, null unknown
//   dayKeyOf(cell)          sheetDayKey(): a sheet date as "YYYY-MM-DD", or ""
//   uploadsRoot             the folder POD files are read from
//   engine                  { prepare, render, record } (lib/broker-invoice-draft.js)
//   nextInvoiceNumber(date) the invoice-number sequence, on the same db
//   appendGmailDraft, findDraftByMessageId, newMessageId   (lib/imap-draft.js)
//   mailbox()               { user, pass } for Gmail ("" when unset)
//   bisonRecipient()        BISON_INVOICE_EMAIL
//   logAudit(req, action, entity, entityId, details)
//   notify({ title, body }) the Super Admin-only "auto-invoice" notice
//   geminiUnavailableAt()   epoch ms the extractor was last seen down, or null
//   now(), log, workerId, fileExists, timeZone (optional)
//
// The engine contract this job relies on:
//   prepare({ loadId, body: {}, dryRun: false, mode: "auto" })
//     -> { ok: true, ctx } | { ok: false, http, code, json, geminiUnavailable? }
//     ctx.to (or ctx.invoiceTo.email) is the resolved recipient: no number is
//     reserved without one.
//   render(ctx, { invoiceId, invoiceDate, emailBody: null })
//     -> { to, subject, html, attachments, total }   (to: the resolved recipient;
//        total: the billed total as printed)
//   record(ctx, rendered, { via: "auto-imap", actor, invoiceId, mintedInvoiceId, editDiffs: [] })
//     writes the load_invoice_drafts row and the invoice_draft_created audit row,
//     and answers { recorded, draftRowId } (the claim keeps that row's id).
//   Each call is given engineTimeoutMs (4 min) before it counts as failed.
// A message whose APPEND got no answer after it was streamed may be in Gmail: the
// claim keeps stage "appending" and Drafts is searched for its Message-ID before
// anything is appended again, so a late landing is recorded, never doubled.
// Logs carry load IDs, states and codes only: never a recipient, an error's
// message, rate-con text or extractor output.

"use strict";

const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const rules = require("./auto-invoice-rules");
const ledger = require("./auto-invoice-ledger");
const appTime = require("./app-time");

const AUTO_ACTOR = Object.freeze({ id: 0, username: "auto-invoice", role: "system" });
const AUTO_REQ = Object.freeze({ session: Object.freeze({ user: AUTO_ACTOR }) });
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Longer than a draft can take (sheet, Drive, up to 90 s of Gemini, the render,
// a 60 s IMAP session), so a live attempt never loses its lease.
const LEASE_MS = 15 * MINUTE_MS;
// A temporary wait that uses no attempt (the renderer was busy).
const SHORT_WAIT_MS = 5 * MINUTE_MS;
// Each engine call: prepare, render and record together stay under LEASE_MS.
const ENGINE_TIMEOUT_MS = 4 * MINUTE_MS;
const LOAD_KEY_MAX = 100;
const STAGES_BEFORE_APPEND = new Set(["", "reserved", "rendered"]);

const iso = (ms) => new Date(ms).toISOString();

// An error as a log may show it: its code, never its message (which can carry an
// address or rate-con text).
function codeOf(e) {
	const c = e && e.code;
	return (typeof c === "string" || typeof c === "number") && /^[A-Za-z0-9_]{1,40}$/.test(String(c)) ? String(c) : "ERROR";
}

// The stage a claim keeps when it goes back to the queue or to a person: once a
// message may be in Gmail, only a search moves it back before "appending".
function keptStage(c) {
	return STAGES_BEFORE_APPEND.has(c.stage) ? (c.invoice_id ? "reserved" : "") : c.stage;
}

// A promise that rejects with code ENGINE_TIMEOUT after `ms`.
function withTimeout(promise, ms) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(Object.assign(new Error("engine call timed out"), { code: "ENGINE_TIMEOUT" })), ms);
	});
	return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// What was handed to Gmail, kept on the claim so a recovery records only a
// rebuilt draft that matches it.
function sentOf(to, rendered) {
	return { to: String(to || "").toLowerCase(), subject: String((rendered && rendered.subject) || ""), total: String((rendered && rendered.total) ?? "") };
}

function create(deps = {}) {
	const d = {
		log: console,
		now: () => new Date(),
		fileExists: (p) => fs.existsSync(p),
		workerId: `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`,
		timeZone: appTime.appTimeZone(),
		mailbox: () => ({ user: "", pass: "" }),
		bisonRecipient: () => "",
		geminiUnavailableAt: () => null,
		closedMonthsOf: () => null,
		dayKeyOf: () => "",
		notify: () => {},
		logAudit: () => {},
		newMessageId: (user) => require("./imap-draft").newMessageId(user),
		engineTimeoutMs: ENGINE_TIMEOUT_MS,
		...deps,
	};
	const engine = {
		prepare: (args) => withTimeout(d.engine.prepare(args), d.engineTimeoutMs),
		render: (ctx, opts) => withTimeout(d.engine.render(ctx, opts), d.engineTimeoutMs),
		record: (ctx, rendered, opts) => withTimeout(d.engine.record(ctx, rendered, opts), d.engineTimeoutMs),
	};
	const db = d.db;
	const mode = rules.readMode(d.env || {});
	const caps = rules.readCaps(d.env || {});
	const me = d.workerId;
	if (mode !== "off") ledger.ensureSchema(db);

	const said = new Set();
	const logOnce = (key, msg) => {
		if (said.has(key)) return;
		said.add(key);
		d.log.warn(`[auto-invoice] ${msg}`);
	};
	const nowDate = () => d.now();
	const audit = (action, entityId, details) => {
		try {
			d.logAudit(AUTO_REQ, action, "load", entityId, details);
		} catch (e) {
			d.log.error(`[auto-invoice] audit ${action} failed: ${codeOf(e)}`);
		}
	};
	const notify = (title, body) => {
		try {
			d.notify({ title, body });
		} catch (e) {
			d.log.error(`[auto-invoice] notice failed: ${codeOf(e)}`);
		}
	};
	let inFlightHere = false;

	// ── what the sweep can see for free ─────────────────────────────────────

	async function snapshot() {
		const jt = await d.readJobTracking();
		const headers = (jt && jt.headers) || [];
		const cols = rules.jobColumns(headers);
		const byKey = new Map();
		for (const row of (jt && jt.data) || []) {
			const key = cols.loadIdCol ? rules.loadKey(row[cols.loadIdCol]) : "";
			if (key) byKey.set(key, row);
		}
		return { headers, cols, byKey, records: rules.indexRecords(ledger.readRecords(db)), settings: ledger.readSettings(db) };
	}

	function podReadable(doc) {
		if (String(doc.drive_file_id || "")) return true;
		if (!d.uploadsRoot) return null;
		const file = rules.documentLocalPath(d.uploadsRoot, doc);
		return Boolean(file) && d.fileExists(file);
	}

	function factsOf(snap, key) {
		const row = snap.byKey.get(key) || null;
		let closedMonths = null;
		if (row) {
			try {
				closedMonths = d.closedMonthsOf(snap.headers, row);
			} catch {
				closedMonths = null;
			}
		}
		let completionDay = "";
		if (row && snap.cols.completionCol) {
			try {
				completionDay = d.dayKeyOf(row[snap.cols.completionCol]) || "";
			} catch {
				completionDay = "";
			}
		}
		return rules.loadFacts({
			row,
			cols: snap.cols,
			records: snap.records.get(key),
			optOutDomains: snap.settings.optOutDomains,
			confirmedDomains: snap.settings.confirmedBrokerDomains,
			bisonRecipientConfigured: Boolean(rules.normalizeEmail(d.bisonRecipient())),
			closedMonths,
			completionDay,
			podReadable,
			activeAdvanceLines: row ? ledger.activeAdvanceLines(db, key) : 0,
		});
	}

	const dayOf = (isoText) => (isoText ? appTime.dayInZone(new Date(isoText), d.timeZone) : "");

	// ── the settings' own health ────────────────────────────────────────────

	const listName = (list) => (list === "optOutDomains" ? "opt-out" : "confirmed");
	function settingsProblem(s) {
		if (s.unreadable) {
			return { code: "SETTINGS_UNREADABLE", text: "The automatic-draft settings can't be read, so nothing is drafted. Save both the opt-out list and the confirmed broker domains again." };
		}
		if (s.dropped.length) {
			const which = s.dropped.map((x) => `${x.domain} (${listName(x.list)}, ${x.code})`).join(", ");
			return { code: "SETTINGS_ENTRIES_DROPPED", text: `Some automatic-draft settings no longer pass the rules and are ignored: ${which}. Save the lists again to remove them.` };
		}
		return null;
	}

	// One Super Admin notice per settings problem, and again only when it changes.
	function noticeSettings(s) {
		const problem = settingsProblem(s);
		const signature = problem ? JSON.stringify([problem.code, s.dropped]) : "";
		if ((ledger.getMeta(db).settings_notice || "") === signature) return;
		ledger.setMeta(db, "settings_notice", signature);
		if (!problem) return;
		d.log.warn(`[auto-invoice] settings: ${problem.code}`);
		notify("Automatic invoice drafts: settings", problem.text);
	}

	// ── the sweep ────────────────────────────────────────────────────────────

	async function sweep() {
		if (mode === "off") return { mode };
		const snap = await snapshot();
		noticeSettings(snap.settings);
		// Unreadable settings: no verdict can be trusted (opt-outs, confirmed
		// domains), so nothing moves until the settings route saves them again.
		if (snap.settings.unreadable) {
			logOnce("settings", "paused: the automatic-draft settings can't be read, so nothing moves until they are saved again");
			return { mode, paused: "SETTINGS_UNREADABLE" };
		}
		return mode === "shadow" ? sweepShadow(snap) : sweepOn(snap);
	}

	function sweepOn(snap) {
		const nowIso = iso(nowDate().getTime());
		const meta = ledger.getMeta(db);
		if (!meta.baseline_at) {
			let n = 0;
			// Every completed row in the cache, cancelled and soft-deleted ones too
			// (a restore must not make an old load new).
			for (const [key, row] of snap.byKey) {
				if (!rules.isCompletedStatus(row[snap.cols.statusCol])) continue;
				n += ledger.insertClaim(db, { key, loadId: row[snap.cols.loadIdCol], state: "baseline", nowIso });
			}
			ledger.setMeta(db, "baseline_at", nowIso);
			audit("auto_invoice_baseline", "", `${n} completed load${n === 1 ? "" : "s"} left to people (baseline)`);
			return { mode, baseline: n };
		}
		const baselineDay = dayOf(meta.baseline_at);
		const offGap = Boolean(meta.off_gap_since);
		const out = { mode, moved: 0, created: 0, offGap: 0, changed: 0 };
		const claims = new Map(ledger.listClaims(db).map((c) => [c.load_key, c]));

		for (const c of claims.values()) {
			if (c.state === "baseline" || c.state === "skipped" || c.state === "working") continue;
			const facts = factsOf(snap, c.load_key);
			if (c.state === "drafted") {
				out.changed += checkChanged(c, facts, nowIso);
				continue;
			}
			if (ledger.otherDraftRows(db, c).length) {
				out.moved += skipDraftedByHand(c, nowIso);
				continue;
			}
			if (c.state === "needs_attention") continue;
			const v = rules.freeVerdict(facts);
			if (c.state === "waiting" && v.state === "queued") {
				if (c.reason_code === "RATECON_MISSING" && c.next_attempt_at > nowIso) continue;
				const code = c.reason_code === "RATECON_MISSING" ? "RATECON_MISSING" : "";
				out.moved += ledger.transition(db, c.load_key, { from: ["waiting"], patch: { state: "queued", reason_code: code, next_attempt_at: nowIso }, nowIso });
			} else if (v.state !== c.state || (c.state === "waiting" && v.code !== c.reason_code && c.reason_code !== "RATECON_MISSING")) {
				out.moved += ledger.transition(db, c.load_key, { from: [c.state], patch: { state: v.state, reason_code: v.code, ...voidPatch(c, v.state, nowIso) }, nowIso });
				auditVoid(c, v.state, v.code);
			}
		}

		for (const [key, row] of snap.byKey) {
			if (claims.has(key) || !rules.isCompletedStatus(row[snap.cols.statusCol])) continue;
			const facts = factsOf(snap, key);
			if (!facts.completed || !facts.live) continue;
			const v = rules.newClaimVerdict(facts, { baselineDone: true, baselineDay, offGap });
			const added = ledger.insertClaim(db, { key, loadId: facts.loadId, state: v.state, code: v.code, nowIso });
			out.created += added;
			if (added && v.code === "OFF_GAP") out.offGap++;
		}
		if (offGap) {
			if (out.offGap) {
				audit("auto_invoice_off_gap", "", `${out.offGap} load${out.offGap === 1 ? "" : "s"} completed while automatic drafts were off (${meta.off_gap_since} to ${nowIso}): draft by hand`);
				notify("Automatic invoice drafts: draft by hand", `${out.offGap} load${out.offGap === 1 ? " was" : "s were"} completed while automatic drafts were off. They are marked Needs attention on Completed Loads.`);
			}
			ledger.setMeta(db, "off_gap_since", "");
		}
		ledger.setMeta(db, "last_sweep_at", nowIso);
		return out;
	}

	// A drafted load whose sheet or files changed since its draft: one notice per
	// new set of changes; nothing is voided.
	function checkChanged(c, facts, nowIso) {
		let saved = null;
		try {
			saved = c.fingerprint_json ? JSON.parse(c.fingerprint_json) : null;
		} catch {
			saved = null;
		}
		const diff = rules.fingerprintDiff(saved, rules.fingerprint(facts));
		if (!diff.length) return 0;
		const fields = diff.join(",");
		if (fields === c.changed_fields) return 0;
		const n = ledger.transition(db, c.load_key, { from: ["drafted"], patch: { changed_at: nowIso, changed_fields: fields }, nowIso });
		if (n) {
			audit("auto_invoice_load_changed", c.load_id, `${c.invoice_id}: ${fields}`);
			notify("Invoice draft: load changed", `Load ${c.load_id} changed after its automatic invoice draft ${c.invoice_id} (${fields.split(",").join(", ")}). Check the draft in Gmail.`);
		}
		return n;
	}

	// A claim that ends skipped with a number reserved and never handed to Gmail
	// gives the number up, on the claim row and in the audit log.
	const voids = (c, state) => state === "skipped" && Boolean(c.invoice_id) && !c.number_voided_at && STAGES_BEFORE_APPEND.has(c.stage);
	const voidPatch = (c, state, nowIso) => (voids(c, state) ? { number_voided_at: nowIso } : {});
	function auditVoid(c, state, code) {
		if (voids(c, state)) audit("auto_invoice_number_void", c.load_id, `${c.invoice_id} was reserved for this load and never used (${code})`);
	}

	// Somebody drafted the load by hand: the claim is done.
	function skipDraftedByHand(c, nowIso, owner = null) {
		const patch = { state: "skipped", reason_code: "DRAFTED_BY_HAND", lease_owner: "", lease_until: "", ...voidPatch(c, "skipped", nowIso) };
		const n = ledger.transition(db, c.load_key, { from: [c.state], owner, patch, nowIso });
		if (n) auditVoid(c, "skipped", "DRAFTED_BY_HAND");
		return n;
	}

	// ── shadow ───────────────────────────────────────────────────────────────

	function shadowFacts(facts) {
		const month = !Array.isArray(facts.closedMonths) ? "unknown" : facts.closedMonths.length ? "closed" : "open";
		return JSON.stringify({
			bison: facts.isBison, domain: facts.brokerDomain, optedOut: facts.optedOut, month,
			deliveryDate: facts.hasDeliveryDate, pods: facts.pods, podsUnreadable: facts.podsUnreadable,
			rateConRows: facts.rateConIds.length, advanceLines: facts.activeAdvanceLines, drafted: facts.drafts > 0,
			bisonRecipient: facts.bisonRecipientConfigured, freemail: facts.brokerEmailFreemail, confirmed: facts.brokerDomainConfirmed,
		});
	}

	function sweepShadow(snap) {
		const nowIso = iso(nowDate().getTime());
		const meta = ledger.getMeta(db);
		if (!meta.shadow_baseline_at) {
			let n = 0;
			for (const [key, row] of snap.byKey) {
				if (!rules.isCompletedStatus(row[snap.cols.statusCol])) continue;
				ledger.upsertShadow(db, { key, loadId: row[snap.cols.loadIdCol], verdict: "BASELINE", nowIso });
				n++;
			}
			ledger.setMeta(db, "shadow_baseline_at", nowIso);
			return { mode, baseline: n };
		}
		const baselineDay = dayOf(meta.shadow_baseline_at);
		const rows = new Map(ledger.listShadow(db).map((r) => [r.load_key, r]));
		let logged = 0;
		const keys = new Set([...snap.byKey.keys(), ...rows.keys()]);
		for (const key of keys) {
			const prev = rows.get(key);
			// What the job would hold on to: a draft, a person, a skip, a baseline.
			if (prev && prev.verdict !== "WOULD_WAIT") continue;
			const row = snap.byKey.get(key);
			if (!prev && !(row && rules.isCompletedStatus(row[snap.cols.statusCol]))) continue;
			const facts = factsOf(snap, key);
			if (!prev && !(facts.completed && facts.live)) continue;
			const v = prev ? rules.freeVerdict(facts) : rules.newClaimVerdict(facts, { baselineDone: true, baselineDay, offGap: false });
			const verdict = rules.shadowVerdictOf(v.state);
			const code = prev && v.code === "ALREADY_DRAFTED" ? "DRAFTED_BY_HAND" : v.code;
			if (prev && prev.verdict === verdict && prev.reason_code === code) continue;
			ledger.upsertShadow(db, {
				key,
				loadId: facts.loadId || (prev && prev.load_id) || "",
				verdict,
				code,
				factsJson: shadowFacts(facts),
				readyAt: verdict === "WOULD_ATTEMPT" ? nowIso : "",
				nowIso,
			});
			logged++;
		}
		ledger.setMeta(db, "last_sweep_at", nowIso);
		return { mode, logged };
	}

	// ── drafting ─────────────────────────────────────────────────────────────

	function paused(nowIso) {
		const meta = ledger.getMeta(db);
		return meta.paused_until && meta.paused_until > nowIso ? meta : null;
	}

	async function work() {
		if (mode !== "on") return { mode, started: 0 };
		const mb = d.mailbox() || {};
		if (!mb.user || !mb.pass) {
			logOnce("no-mailbox", "paused: no mailbox (GMAIL_USER and its app password are not set)");
			return { mode, started: 0, paused: "NO_MAILBOX" };
		}
		const p = paused(iso(nowDate().getTime()));
		if (p) return { mode, started: 0, paused: p.pause_reason || "PAUSED" };
		if (ledger.readSettings(db).unreadable) {
			logOnce("settings", "paused: the opt-out list can't be read, so nothing is drafted until it is saved again");
			return { mode, started: 0, paused: "SETTINGS_UNREADABLE" };
		}
		let started = 0;
		for (;;) {
			const t = nowDate().getTime();
			const tIso = iso(t);
			const allow = rules.capsAllow({
				inFlight: inFlightHere ? 1 : ledger.inFlight(db, tIso),
				startedThisSweep: started,
				draftedLastHour: ledger.draftedSince(db, iso(t - HOUR_MS)),
				draftedLastDay: ledger.draftedSince(db, iso(t - DAY_MS)),
				caps,
			});
			if (!allow || paused(tIso)) break;
			const next = ledger.nextQueued(db, tIso);
			if (!next) break;
			if (!ledger.lease(db, next.load_key, me, { nowIso: tIso, untilIso: iso(t + LEASE_MS) })) continue;
			started++;
			inFlightHere = true;
			try {
				await attempt(ledger.getClaim(db, next.load_key), mb);
			} catch (e) {
				d.log.error(`[auto-invoice] load ${next.load_id}: attempt failed: ${codeOf(e)}`);
				const c = ledger.getClaim(db, next.load_key);
				if (c && c.state === "working" && c.lease_owner === me && STAGES_BEFORE_APPEND.has(c.stage)) temporary(c, { code: "RETRY_LATER", countsAttempt: true });
			} finally {
				inFlightHere = false;
			}
		}
		return { mode, started };
	}

	// Back to the queue after a temporary failure, the number kept; the attempt
	// after the last backoff goes to a person (DRAFT_FAILED).
	function temporary(c, { code, countsAttempt }) {
		const t = nowDate().getTime();
		const nowIso = iso(t);
		const stage = keptStage(c);
		const attempts = c.attempts + (countsAttempt ? 1 : 0);
		if (countsAttempt) {
			const delay = rules.retryDelayMs(attempts);
			if (delay === null) {
				return ledger.transition(db, c.load_key, { from: ["working"], owner: me, nowIso,
					patch: { state: "needs_attention", reason_code: "DRAFT_FAILED", attempts, stage, lease_owner: "", lease_until: "" } });
			}
			return ledger.transition(db, c.load_key, { from: ["working"], owner: me, nowIso,
				patch: { state: "queued", reason_code: code, attempts, stage, next_attempt_at: iso(t + delay), lease_owner: "", lease_until: "" } });
		}
		const wait = code === "GEMINI_DOWN" ? rules.GEMINI_WAIT_MS : SHORT_WAIT_MS;
		return ledger.transition(db, c.load_key, { from: ["working"], owner: me, nowIso,
			patch: { state: "queued", reason_code: code, stage, next_attempt_at: iso(t + wait), lease_owner: "", lease_until: "" } });
	}

	function release(c, state, code, extra = {}) {
		const nowIso = iso(nowDate().getTime());
		const n = ledger.transition(db, c.load_key, { from: ["working"], owner: me, nowIso,
			patch: { state, reason_code: code, stage: keptStage(c), lease_owner: "", lease_until: "", ...voidPatch(c, state, nowIso), ...extra } });
		if (n) auditVoid(c, state, code);
		return n;
	}

	function refused(c, prep) {
		const cls = rules.classifyRefusal({
			code: prep.code,
			http: prep.http,
			geminiUnavailable: Boolean(prep.geminiUnavailable || (prep.ctx && prep.ctx.geminiUnavailable)),
		});
		if (cls.kind === "temporary") return temporary(c, cls);
		if (cls.kind === "wait") {
			// The free checks said ready and the engine said not yet: counted, so the
			// two can't disagree for ever.
			const attempts = c.attempts + 1;
			if (attempts >= rules.ENGINE_WAIT_MAX) return release(c, "needs_attention", rules.waitAttentionCode(cls.code), { attempts });
			return release(c, "waiting", cls.code, { attempts });
		}
		if (cls.kind === "ratecon_missing") {
			const checks = c.ratecon_checks + 1;
			if (checks > rules.RATECON_MAX_CHECKS) return release(c, "needs_attention", "RATECON_MISSING", { ratecon_checks: checks });
			return release(c, "waiting", "RATECON_MISSING", { ratecon_checks: checks, next_attempt_at: iso(nowDate().getTime() + rules.RATECON_RECHECK_MS) });
		}
		return release(c, "needs_attention", cls.code);
	}

	const recipientOf = (ctx, rendered) =>
		String((rendered ? rendered.to : ctx && (ctx.to || (ctx.invoiceTo && ctx.invoiceTo.email))) || "");

	// The recipient rule, checked here as well as in the engine: a recipient the
	// rule doesn't allow is a person's call, whatever the engine resolved.
	function recipientRefusal(facts, to) {
		if (!to) return null;
		const r = rules.recipientRule({ brokerEmail: facts.brokerEmail, bisonRecipient: d.bisonRecipient(), documentsEmail: to,
			confirmedDomains: facts.brokerDomainConfirmed ? [facts.brokerDomain] : [] });
		if (!r.ok) return r.code;
		return r.to.toLowerCase() === to.toLowerCase() ? null : "RECIPIENT_DOMAIN_MISMATCH";
	}

	function geminiRecentlyDown() {
		const at = Number(d.geminiUnavailableAt());
		return Number.isFinite(at) && at > 0 && nowDate().getTime() - at < rules.GEMINI_WAIT_MS;
	}

	async function attempt(c, mb) {
		const key = c.load_key;
		let snap;
		try {
			snap = await snapshot();
		} catch {
			// The sheet is down: nothing was spent, so no attempt is used.
			return temporary(c, { code: "RETRY_LATER", countsAttempt: false });
		}
		const facts = factsOf(snap, key);
		let fresh = ledger.getClaim(db, key);
		if (!fresh || fresh.state !== "working" || fresh.lease_owner !== me) return;
		if (ledger.otherDraftRows(db, fresh).length) return skipDraftedByHand(fresh, iso(nowDate().getTime()), me);
		if (snap.settings.unreadable) return temporary(fresh, { code: "SETTINGS_UNREADABLE", countsAttempt: false });
		const fv = rules.freeVerdict(facts);
		if (fv.state !== "queued") return release(fresh, fv.state, fv.code);
		if (!facts.isBison && geminiRecentlyDown()) return temporary(fresh, { code: "GEMINI_DOWN", countsAttempt: false });

		// The last append may have landed after its answer was lost: look first.
		if (fresh.stage === "appending") {
			const seen = await lookInGmail(fresh, mb);
			if (seen === "unknown") return release(fresh, "needs_attention", "MAYBE_IN_GMAIL");
			if (seen === "found") {
				if (!ledger.setStage(db, key, me, "appended", iso(nowDate().getTime()))) return;
				return recordFromGmail(key);
			}
			// Proven absent: the number never reached Gmail and may be used again.
			if (!ledger.setStage(db, key, me, "reserved", iso(nowDate().getTime()))) return;
			fresh = ledger.getClaim(db, key);
		}

		let prep;
		try {
			prep = await engine.prepare({ loadId: facts.loadId || fresh.load_id, body: {}, dryRun: false, mode: "auto" });
		} catch (e) {
			return temporary(fresh, rules.classifyRefusal({ code: e && e.code, http: 0 }));
		}
		if (!prep || !prep.ok) return refused(fresh, prep || {});
		const ctx = prep.ctx;
		// No number before the recipient rule has passed on a recipient.
		const planned = recipientOf(ctx, null);
		const early = planned ? recipientRefusal(facts, planned) : "NO_BILLING_EMAIL";
		if (early) return release(fresh, "needs_attention", early);

		// After the last await: the claim is still ours and nobody drafted the
		// load by hand; the number is minted here, once (a fresh one when the one
		// reserved is over a day old and never reached Gmail).
		const now = nowDate();
		const r = ledger.reserveNumber(db, key, me, {
			mint: (date) => d.nextInvoiceNumber(date),
			now,
			dayKey: appTime.dayInZone(now, d.timeZone),
			messageId: d.newMessageId(mb.user),
			nowIso: iso(now.getTime()),
			staleBeforeIso: iso(now.getTime() - rules.STALE_RESERVATION_MS),
		});
		if (!r.ok) {
			if (r.reason === "drafted") {
				const cur = ledger.getClaim(db, key);
				if (cur) skipDraftedByHand(cur, iso(nowDate().getTime()), me);
			}
			return;
		}
		if (r.voided) audit("auto_invoice_number_void", fresh.load_id, `${r.voided.invoiceId} was reserved on ${r.voided.invoiceDate} and never used (a fresh number replaces it)`);
		const held = ledger.getClaim(db, key);

		let rendered;
		try {
			rendered = await engine.render(ctx, { invoiceId: r.invoiceId, invoiceDate: r.invoiceDate, emailBody: null });
		} catch (e) {
			const busy = e && e.code === "RENDERER_BUSY";
			return temporary(held, busy ? { code: "RENDERER_BUSY", countsAttempt: false } : { code: "RETRY_LATER", countsAttempt: true });
		}
		const to = recipientOf(ctx, rendered);
		const late = !to ? "NO_BILLING_EMAIL" : recipientRefusal(facts, to) || (to.toLowerCase() === planned.toLowerCase() ? null : "DRAFT_REFUSED");
		if (late) return release(held, "needs_attention", late);
		if (!ledger.setStage(db, key, me, "rendered", iso(nowDate().getTime()))) return;
		// After the render's await: a hand draft made meanwhile wins, before Gmail.
		const rendering = ledger.getClaim(db, key);
		if (ledger.otherDraftRows(db, rendering).length) return skipDraftedByHand(rendering, iso(nowDate().getTime()), me);
		if (!ledger.transition(db, key, { from: ["working"], owner: me, nowIso: iso(nowDate().getTime()),
			patch: { stage: "appending", sent_json: JSON.stringify(sentOf(to, rendered)) } })) return;

		try {
			await d.appendGmailDraft({
				user: mb.user,
				pass: mb.pass,
				from: `LogisX Inc. <${mb.user}>`,
				to,
				subject: rendered.subject,
				html: rendered.html,
				attachments: rendered.attachments || [],
				messageId: r.messageId,
			});
		} catch (e) {
			return appendFailed(ledger.getClaim(db, key), e, mb, () => finishRecorded(key, ctx, rendered, facts));
		}
		if (!ledger.setStage(db, key, me, "appended", iso(nowDate().getTime()))) return;
		ledger.setMeta(db, "pause_ms", "");
		return finishRecorded(key, ctx, rendered, facts);
	}

	async function appendFailed(c, e, mb, record) {
		const stage = e && e.stage;
		const nowMs = nowDate().getTime();
		if (stage === "login" && e.answered) {
			const meta = ledger.getMeta(db);
			const ms = rules.loginPauseMs(Number(meta.pause_ms) || 0);
			ledger.setMeta(db, "paused_until", iso(nowMs + ms));
			ledger.setMeta(db, "pause_reason", "IMAP_LOGIN_REFUSED");
			ledger.setMeta(db, "pause_ms", String(ms));
			d.log.error(`[auto-invoice] Gmail refused the login: paused for ${Math.round(ms / MINUTE_MS)} min`);
			notify("Automatic invoice drafts paused", `Gmail refused the mailbox login. Automatic drafts are paused for ${Math.round(ms / HOUR_MS)} h and will try again then.`);
			return ledger.transition(db, c.load_key, { from: ["working"], owner: me, nowIso: iso(nowMs),
				patch: { state: "queued", reason_code: "MAILBOX_PAUSED", stage: "reserved", next_attempt_at: iso(nowMs + ms), lease_owner: "", lease_until: "" } });
		}
		if (stage === "literal" && !e.answered) {
			// The message was streamed and no answer came: it may land later.
			const seen = await lookInGmail(c, mb);
			if (seen === "unknown") return release(c, "needs_attention", "MAYBE_IN_GMAIL");
			if (seen === "found") {
				if (!ledger.setStage(db, c.load_key, me, "appended", iso(nowDate().getTime()))) return 0;
				return record();
			}
			// Not there yet: the claim stays "appending", so the retry searches again
			// before appending, and its number is never taken for unused.
			return temporary(ledger.getClaim(db, c.load_key), { code: "RETRY_LATER", countsAttempt: true });
		}
		// Refused, or stopped before the message was sent: it isn't in Gmail.
		const cur = ledger.getClaim(db, c.load_key);
		return temporary({ ...cur, stage: "reserved" }, { code: "RETRY_LATER", countsAttempt: true });
	}

	// Is the claim's message in Gmail Drafts? "found", "absent", or "unknown" (no
	// mailbox, or the search failed).
	async function lookInGmail(c, mb) {
		if (!mb.user || !mb.pass || !c.message_id) return "unknown";
		try {
			const found = await d.findDraftByMessageId({ user: mb.user, pass: mb.pass, messageId: c.message_id });
			return found && found.found ? "found" : "absent";
		} catch {
			return "unknown";
		}
	}

	// The claim's draft is in Gmail but not recorded (a crash, or a late landing):
	// the engine rebuilds the record, which is written only when the recipient rule
	// passes and the rebuilt recipient, subject and total are what went to Gmail.
	async function recordFromGmail(key) {
		const c = ledger.getClaim(db, key);
		const snap = await snapshot();
		const facts = factsOf(snap, key);
		if (ledger.ownDraftRow(db, c)) return finishRecorded(key, null, null, facts);
		const unrecorded = () => release(ledger.getClaim(db, key), "needs_attention", "IN_GMAIL_UNRECORDED", { stage: "appended" });
		let sent = null;
		try {
			sent = c.sent_json ? JSON.parse(c.sent_json) : null;
		} catch {
			sent = null;
		}
		if (!sent) return unrecorded();
		let prep;
		try {
			prep = await engine.prepare({ loadId: facts.loadId || c.load_id, body: {}, dryRun: false, mode: "auto" });
		} catch {
			prep = null;
		}
		if (!prep || !prep.ok) return unrecorded();
		let rendered;
		try {
			rendered = await engine.render(prep.ctx, { invoiceId: c.invoice_id, invoiceDate: c.invoice_date, emailBody: null });
		} catch {
			return unrecorded();
		}
		const to = recipientOf(prep.ctx, rendered);
		const rebuilt = sentOf(to, rendered);
		if (!to || recipientRefusal(facts, to) || JSON.stringify(rebuilt) !== JSON.stringify(sentOf(sent.to, sent))) return unrecorded();
		return finishRecorded(key, prep.ctx, rendered, facts);
	}

	// The draft is in Gmail: record it once (a row already there is reused), then
	// the claim is drafted with what the load looked like.
	async function finishRecorded(key, ctx, rendered, facts) {
		let c = ledger.getClaim(db, key);
		if (!c || c.state !== "working" || c.lease_owner !== me) return 0;
		let row = ledger.ownDraftRow(db, c);
		if (!row) {
			let answer = null;
			try {
				answer = await engine.record(ctx, rendered, { via: "auto-imap", actor: AUTO_ACTOR, invoiceId: c.invoice_id, mintedInvoiceId: c.invoice_id, editDiffs: [] });
			} catch (e) {
				d.log.error(`[auto-invoice] load ${c.load_id}: recording the draft failed: ${codeOf(e)}`);
			}
			c = ledger.getClaim(db, key);
			// The row record() answers it wrote, when it is this claim's own draft;
			// otherwise the claim's own row looked up by its invoice number.
			const answered = answer && answer.recorded ? Number(answer.draftRowId) : NaN;
			const byId = c ? ledger.draftRowsFor(db, c.load_key).find((r) => r.id === answered && r.via === "auto-imap" && r.invoice_id === c.invoice_id) : null;
			row = byId || (c ? ledger.ownDraftRow(db, c) : null);
		}
		const nowIso = iso(nowDate().getTime());
		if (!row) return release(c, "needs_attention", "IN_GMAIL_UNRECORDED", { stage: "appended" });
		return ledger.transition(db, key, { from: ["working"], owner: me, nowIso, patch: {
			state: "drafted", reason_code: "", stage: "recorded", draft_row_id: row.id, drafted_at: nowIso,
			fingerprint_json: JSON.stringify(rules.fingerprint(facts)), lease_owner: "", lease_until: "",
		} });
	}

	// ── recovery after a crash or restart ───────────────────────────────────

	async function recover() {
		if (mode !== "on") return { mode, recovered: 0 };
		// Recording needs the confirmed domains: an expired claim waits for them.
		if (ledger.readSettings(db).unreadable) return { mode, recovered: 0, paused: "SETTINGS_UNREADABLE" };
		const mb = d.mailbox() || {};
		let recovered = 0;
		for (const c of ledger.expiredWorking(db, iso(nowDate().getTime()))) {
			const t = nowDate().getTime();
			if (!ledger.takeOver(db, c.load_key, me, { nowIso: iso(t), untilIso: iso(t + LEASE_MS) })) continue;
			recovered++;
			const held = ledger.getClaim(db, c.load_key);
			try {
				await recoverOne(held, mb);
			} catch (e) {
				d.log.error(`[auto-invoice] load ${held.load_id}: recovery failed: ${codeOf(e)}`);
				const cur = ledger.getClaim(db, held.load_key) || held;
				release(cur, "needs_attention", STAGES_BEFORE_APPEND.has(cur.stage) ? "DRAFT_FAILED" : "MAYBE_IN_GMAIL");
			}
		}
		return { mode, recovered };
	}

	async function recoverOne(c, mb) {
		const requeue = (stage) => ledger.transition(db, c.load_key, { from: ["working"], owner: me, nowIso: iso(nowDate().getTime()),
			patch: { state: "queued", stage, next_attempt_at: iso(nowDate().getTime()), lease_owner: "", lease_until: "" } });
		if (STAGES_BEFORE_APPEND.has(c.stage)) return requeue(keptStage(c));
		if (c.stage === "appending") {
			const seen = await lookInGmail(c, mb);
			if (seen === "unknown") return release(c, "needs_attention", "MAYBE_IN_GMAIL");
			if (seen === "absent") return requeue("reserved");
			ledger.setStage(db, c.load_key, me, "appended", iso(nowDate().getTime()));
		}
		return recordFromGmail(c.load_key);
	}

	// One timer tick: leases left by a crash, then the sweep, then drafting.
	async function tick() {
		if (mode === "off") return { mode };
		const out = { mode };
		if (mode === "on") {
			const nowMs = nowDate().getTime();
			const meta = ledger.getMeta(db);
			// The heartbeat is written before the sheet is read, so a sheet outage
			// is never mistaken for the job being off.
			if (meta.baseline_at && !meta.off_gap_since && rules.isOffGap(meta.last_on_tick_at, nowMs)) {
				ledger.setMeta(db, "off_gap_since", meta.last_on_tick_at || meta.baseline_at);
			}
			ledger.setMeta(db, "last_on_tick_at", iso(nowMs));
			out.recover = await recover();
		}
		try {
			out.sweep = await sweep();
		} catch (e) {
			// No sweep (the sheet couldn't be read): no drafting either this tick.
			d.log.error(`[auto-invoice] sweep failed: ${codeOf(e)}`);
			out.sweep = { mode, error: "SWEEP_FAILED" };
			return out;
		}
		if (mode === "on") out.work = await work();
		return out;
	}

	// ── what Super Admins see ────────────────────────────────────────────────

	// `_autoInvoice` on completed rows as served to a Super Admin, in on mode only:
	// { state, code, invoiceId, changed }. Codes only; the client words them
	// (client/src/lib/autoInvoiceStatus.js). Call it on request-local rows, never
	// on the cached Job Tracking. Never throws.
	function annotateCompletedRows({ rows, headers, isSuperAdmin } = {}) {
		if (mode !== "on" || isSuperAdmin !== true || !Array.isArray(rows) || !rows.length) return rows;
		try {
			const idCol = rules.jobColumns(headers || []).loadIdCol;
			if (!idCol) return rows;
			const claims = new Map(ledger.listClaims(db, ["waiting", "queued", "working", "drafted", "needs_attention"]).map((c) => [c.load_key, c]));
			for (const row of rows) {
				const c = claims.get(rules.loadKey(row[idCol]));
				if (!c) continue;
				row._autoInvoice = {
					state: c.state,
					code: c.reason_code,
					invoiceId: c.state === "drafted" ? c.invoice_id : "",
					changed: c.state === "drafted" && c.changed_fields ? c.changed_fields.split(",") : [],
				};
			}
		} catch (e) {
			logOnce("annotate", `the Completed Loads status could not be read: ${codeOf(e)}`);
		}
		return rows;
	}

	function status() {
		const meta = mode === "off" ? {} : ledger.getMeta(db);
		const nowIso = iso(nowDate().getTime());
		const settings = mode === "off" ? null : ledger.readSettings(db);
		const problem = settings ? settingsProblem(settings) : null;
		const loginPause = meta.paused_until && meta.paused_until > nowIso ? { until: meta.paused_until, reason: meta.pause_reason || "" } : null;
		return {
			mode,
			baselineAt: meta.baseline_at || "",
			lastSweepAt: meta.last_sweep_at || "",
			paused: loginPause || (settings && settings.unreadable ? { until: "", reason: "SETTINGS_UNREADABLE" } : null),
			settings: settings ? { problem: problem ? problem.code : "", unreadable: settings.unreadable, dropped: settings.dropped } : null,
			mailbox: Boolean((d.mailbox() || {}).user && (d.mailbox() || {}).pass),
			counts: mode === "on" ? ledger.countsByState(db) : null,
			changed: mode === "on" ? ledger.changedCount(db) : 0,
			shadow: mode === "shadow" ? ledger.shadowCounts(db) : null,
			caps: { maxPerHour: caps.maxPerHour, maxPerDay: caps.maxPerDay },
		};
	}

	// ── routes (Super Admin only) ────────────────────────────────────────────

	function mount(app, { requireRole, refuseCrossSite = null } = {}) {
		if (typeof requireRole !== "function") throw new Error("auto-invoice mount needs requireRole");
		const guard = [requireRole("Super Admin")];
		const writeGuard = refuseCrossSite ? [...guard, refuseCrossSite] : guard;
		const featureOff = (res) => res.status(404).json({ error: "Automatic invoice drafts are off.", code: "FEATURE_OFF" });
		// Express has already decoded the parameter: decoding again would misread a
		// Load ID that holds "%".
		const keyOf = (req) => {
			const key = rules.loadKey(String((req.params && req.params.loadKey) || ""));
			return key && key.length <= LOAD_KEY_MAX ? key : "";
		};

		app.get("/api/auto-invoice/status", ...guard, (req, res) => {
			if (mode === "off") return featureOff(res);
			res.json(status());
		});

		app.get("/api/auto-invoice/settings", ...guard, (req, res) => {
			if (mode === "off") return featureOff(res);
			res.json(ledger.readSettings(db));
		});

		app.put("/api/auto-invoice/settings", ...writeGuard, (req, res) => {
			if (mode === "off") return featureOff(res);
			const body = req.body;
			if (!body || typeof body !== "object" || Array.isArray(body)) {
				return res.status(400).json({ error: "Send the settings as a JSON object.", code: "SETTINGS_INVALID" });
			}
			// Each list is optional; one left out keeps what is stored. While the
			// stored row can't be read, there is nothing to keep: both are needed, or
			// the one left out (the opt-outs, say) would be saved as empty.
			if (body.optOutDomains === undefined && body.confirmedBrokerDomains === undefined) {
				return res.status(400).json({ error: "Send optOutDomains, confirmedBrokerDomains or both.", code: "SETTINGS_INVALID" });
			}
			const before = ledger.readSettings(db);
			if (before.unreadable && (body.optOutDomains === undefined || body.confirmedBrokerDomains === undefined)) {
				return res.status(409).json({ error: "The stored settings can't be read. Send both optOutDomains and confirmedBrokerDomains.", code: "SETTINGS_UNREADABLE" });
			}
			const optOut = body.optOutDomains === undefined ? { ok: true, domains: before.optOutDomains } : rules.normalizeOptOutDomains(body.optOutDomains);
			if (!optOut.ok) return res.status(400).json({ error: optOut.error, code: optOut.code });
			const confirmed = body.confirmedBrokerDomains === undefined
				? { ok: true, domains: before.confirmedBrokerDomains }
				: rules.normalizeConfirmedDomains(body.confirmedBrokerDomains);
			if (!confirmed.ok) return res.status(400).json({ error: confirmed.error, code: confirmed.code });
			const user = (req.session && req.session.user) || {};
			ledger.writeSettings(db, { optOutDomains: optOut.domains, confirmedBrokerDomains: confirmed.domains }, { by: user.username || "", nowIso: iso(nowDate().getTime()) });
			const list = (xs) => xs.join(", ") || "none";
			const was = (xs) => (before.unreadable ? "unreadable" : list(xs));
			const ignored = before.dropped.length ? `; ignored before: ${before.dropped.map((x) => `${x.domain} (${listName(x.list)})`).join(", ")}` : "";
			d.logAudit(req, "update_auto_invoice_settings", "auto_invoice", "settings",
				`opted out: ${list(optOut.domains)} (was: ${was(before.optOutDomains)}); confirmed: ${list(confirmed.domains)} (was: ${was(before.confirmedBrokerDomains)})${ignored}`);
			res.json({ optOutDomains: optOut.domains, confirmedBrokerDomains: confirmed.domains });
		});

		app.post("/api/auto-invoice/loads/:loadKey/checked", ...writeGuard, async (req, res) => {
			if (mode !== "on") return featureOff(res);
			const key = keyOf(req);
			if (!key) return res.status(400).json({ error: "Unknown load.", code: "LOAD_KEY_INVALID" });
			let snap;
			try {
				snap = await snapshot();
			} catch {
				return res.status(503).json({ error: "Job Tracking could not be read; try again.", code: "SHEET_UNAVAILABLE" });
			}
			// After the last await: read the claim, then write.
			const c = ledger.getClaim(db, key);
			if (!c) return res.status(404).json({ error: "This load has no automatic draft.", code: "AUTO_INVOICE_NOT_FOUND" });
			if (c.state !== "drafted") return res.status(409).json({ error: "Only an automatic draft can be marked checked.", code: "AUTO_INVOICE_NOT_DRAFTED" });
			const user = (req.session && req.session.user) || {};
			const nowIso = iso(nowDate().getTime());
			ledger.transition(db, key, { from: ["drafted"], nowIso, patch: {
				fingerprint_json: JSON.stringify(rules.fingerprint(factsOf(snap, key))),
				changed_at: "", changed_fields: "", checked_at: nowIso, checked_by: String(user.username || ""),
			} });
			d.logAudit(req, "auto_invoice_checked", "load", c.load_id, `${c.invoice_id}: checked${c.changed_fields ? ` (changed: ${c.changed_fields})` : ""}`);
			res.json({ ok: true });
		});

		app.post("/api/auto-invoice/loads/:loadKey/retry", ...writeGuard, (req, res) => {
			if (mode !== "on") return featureOff(res);
			const key = keyOf(req);
			if (!key) return res.status(400).json({ error: "Unknown load.", code: "LOAD_KEY_INVALID" });
			const c = ledger.getClaim(db, key);
			if (!c) return res.status(404).json({ error: "This load has no automatic draft.", code: "AUTO_INVOICE_NOT_FOUND" });
			if (c.state !== "needs_attention") return res.status(409).json({ error: "Only a load that needs attention can be tried again.", code: "AUTO_INVOICE_NOT_ATTENTION" });
			const nowIso = iso(nowDate().getTime());
			// A draft that may already be in Gmail is looked for first (recovery),
			// never appended again blind. A number reserved over a day ago is
			// replaced on the next attempt (reserveNumber's staleBeforeIso).
			const patch = STAGES_BEFORE_APPEND.has(c.stage)
				? { state: "queued", reason_code: "", attempts: 0, ratecon_checks: 0, next_attempt_at: nowIso }
				: { state: "working", reason_code: "", attempts: 0, ratecon_checks: 0, lease_owner: "", lease_until: iso(0) };
			const n = ledger.transition(db, key, { from: ["needs_attention"], nowIso, patch });
			if (!n) return res.status(409).json({ error: "The load changed; reload and try again.", code: "AUTO_INVOICE_NOT_ATTENTION" });
			d.logAudit(req, "auto_invoice_retry", "load", c.load_id, `try again (was: ${c.reason_code || "needs attention"})`);
			res.json({ ok: true });
		});
	}

	return { mode, workerId: me, sweep, work, recover, tick, annotateCompletedRows, status, mount };
}

module.exports = { create, AUTO_ACTOR, LEASE_MS };
