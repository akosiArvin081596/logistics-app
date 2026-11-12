// Automatic broker invoice drafts (AUTO_INVOICE_DRAFTS_ENABLED): the job.
//
// A sweep of the cached Job Tracking finds loads that became Delivered (every
// route that writes a status, and edits made straight in the sheet, end up
// there) and keeps one claim per load in lib/auto-invoice-ledger.js. work()
// drafts the queued ones through the same engine as the Super Admin's Draft
// Invoice button (prepare / render / record), into Gmail Drafts. Anything a
// person would have fixed in the review becomes "needs attention" with its
// reason (lib/auto-invoice-rules.js).
//
// Sending (AUTO_INVOICE_SEND_ENABLED, lib/auto-invoice-send.js): in on mode, a
// load whose recipient's domain is on AUTO_INVOICE_SEND_DOMAINS, while sending
// isn't stopped, gets the same message sent by SMTP instead of a draft. The last
// checks run right before the SMTP call, the factoring marker last of them, with
// no wait between it and the call. One send per load: once a send has started,
// the claim is only ever searched for in Sent Mail, never sent or drafted again.
// An SMTP failure, an unanswered send or a load changed after its send stops
// sending (drafts carry on); only scripts/auto-invoice-send-resume.js resumes.
// A load to be sent waits AUTO_INVOICE_SEND_SETTLE_MINUTES (60) after its newest
// live POD row, so a later POD page goes with it (SEND_SETTLING): looked at each
// sweep, before anything is paid for, and once more right before the send.
//
// Modes (rules.readMode()):
//   off: nothing and no tables. server.js mounts no route then, so a GET under
//     /api/auto-invoice/ reaches the app page and a write gets Express's own 404
//     (mount() itself would answer 404 FEATURE_OFF).
//   shadow: the sweep records what it would do in auto_invoice_shadow, with no
//     engine, number, Drive, Gemini or Gmail call: it makes no Gmail drafts. Its
//     one other write: a settings problem stores and sends one in-app Super
//     Admin notice (noticeSettings()), worded for shadow.
//     With the render shadow on (deps.shadowRenders, AUTO_INVOICE_SHADOW_RENDERS_ENABLED),
//     each WOULD_ATTEMPT load's email and invoice are also built in memory by
//     buildMessage(), the real draft's own builder, with a placeholder number,
//     and only their digest (rules.messageDigest()) is stored, in the row's
//     render_digest_json; a load the builder refuses keeps its refusal code. Still
//     no number, Gmail or record() call. Built again when the load's fingerprint
//     changes, until a person drafts it; a load a person drafted before any build
//     is never built (the engine would print that person's own note), and its
//     record says so. Every record keeps when the load got its first one, and
//     the domain it was for, through every later build and rewrite: the
//     comparison places the load by those, never by its latest record.
//   on: drafts. Each claim keeps the digest of what it handed to Gmail
//     (draft_digest_json).
// The render records are kept until the comparison's decision plus 30 days (45
// days after the render at most), pruned daily, and at start while off.
// The caller (server.js) runs tick() on a timer behind startsJob(), so a replica
// runs nothing.
//
// The driver's Delivered (AUTO_INVOICE_DRIVER_TRIGGER_ENABLED, a kill switch, counted
// in on mode only; lib/auto-invoice-trigger.js): no sweep and no timer. Only a Driver's
// own PUT /api/driver/status into a completed status starts an invoice, through the same
// attempt() and every check in it: driverDelivered() writes a `waiting` DRIVER_PENDING
// claim before the sheet write, written() queues it, and the run line takes queued
// claims one at a time. Every run holds its claim under its own owner token, so a run
// past its limit can't write again. Nothing retries by itself: every run ends with no
// claim left queued or working, and a person's Try again is the retry, looking in the
// mailbox and the Payments Table first (look_first) on a load that could be sent. A tap that
// re-arms a stopped claim, and a restart that queues one again, ask for the same look.
// startTrigger() runs before the app listens and finishStartUp() once it does. Their
// first run hands the sweep's claims to a person, with nothing built, appended or sent.
// checkClaims() does the sweep's watching: a POD event checks that load, and a Super
// Admin's dashboard read checks the rest, at most once a minute.
//
// The known-address check (AUTO_INVOICE_KNOWN_ADDRESS_ENABLED, a kill switch that fails
// safe; rules.knownAddressRefusal()): a message to chrobinson.com, whether it would be sent or
// drafted, goes only to an address a person has already invoiced on 3 loads, off a rate con
// that says it's this load's: a Drive file's name carries the load's whole number, the read's
// Load Number is that number and the text prints it. Anything short of that stops at a person
// with nothing sent, and with the check off every such load does. A C.H. Robinson load stopped
// on its address or its file tells a person (tellHeld()), and the settings read counts those
// (recipientCheckState()). Other brokers' drafts and a person's Draft Invoice press are not
// this check's. A rebuild that only records what already went isn't either: it sends nothing.
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
//   shadowRenders           true for the render shadow (read only in shadow mode)
//   send                    lib/auto-invoice-send.js readSettings(): { enabled, domains, settleMinutes }
//   sendMail(opts)          its createSmtpSender(): one message by SMTP
//   now(), log, workerId, fileExists, timeZone (optional)
//   invalidateJobTracking() jtCacheInvalidate(), for a sheet write that may have landed
//   lookInMailbox(opts)     the live search (lib/invoice-mailbox-search.js searchMailboxForLoad())
//   readPaymentsTable()     the Payments Table's rows as Sheets answers them, header first
//   rateConTextOf(bytes)    a rate con's text (lib/broker-invoice.js extractPdfText()), for the
//                           known-address check; with none, the text prints nothing and the load holds
//   savedInvoiceEvidence(key) saved evidence shows an invoice (optional)
//   runLimitMs, searchAgainMs, readCheckMs, sleep(ms), setTimer(fn, ms), clearTimer(t) (optional)
//
// The engine contract this job relies on:
//   prepare({ loadId, body: {}, dryRun: false, mode: "auto" })
//     -> { ok: true, ctx } | { ok: false, http, code, json, geminiUnavailable? }
//     ctx.to (or ctx.invoiceTo.email) is the resolved recipient: no number is
//     reserved without one. ctx.rateconCandidates[0] is the primary rate con, with its
//     source and, from Drive, its whole file name (driveFileName); ctx.rateconBuffer its
//     bytes; ctx.rcFields what its read gave, and ctx.paidRead the paid read's own answer.
//   render(ctx, { invoiceId, invoiceDate, emailBody: null })
//     -> { to, subject, html, attachments, total }   (to: the resolved recipient;
//        total: the billed total as printed)
//   record(ctx, rendered, { via, actor, invoiceId, mintedInvoiceId, editDiffs: [] })
//     (via: rules.VIA_DRAFT for a draft, rules.VIA_SEND for a send)
//     writes the load_invoice_drafts row and the invoice_draft_created audit row,
//     and answers { recorded, draftRowId } (the claim keeps that row's id).
//   Each call is given engineTimeoutMs (4 min) before it counts as failed.
// A message whose APPEND got no answer after it was streamed may be in Gmail: the
// claim keeps stage "appending" and Gmail is searched for its Message-ID, in Drafts
// and in Sent Mail (a person may have sent it meanwhile), before anything is
// appended again, so a late landing is recorded, never doubled.
// A load marked factored (lib/factoring-store.js) is never drafted: the free
// checks skip it (LOAD_FACTORED), reserveNumber() mints nothing for it, and the
// marker is read again after the render, before Gmail. A marker that can't be
// read counts as factored there, and fails the sweep.
// Logs carry load IDs, states and codes only: never a recipient, an error's
// message, rate-con text or extractor output.

"use strict";

const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const rules = require("./auto-invoice-rules");
const ledger = require("./auto-invoice-ledger");
const factoring = require("./factoring-store");
const sendRules = require("./auto-invoice-send");
const trigger = require("./auto-invoice-trigger");
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
// sendOne()'s answer when sending was stopped after the gate: draft the load.
const DRAFT_INSTEAD = Symbol("draft instead");
// The driver's trigger: a lost answer is searched for again once, this long after, in
// the same run; a Super Admin's dashboard read checks the claims at most this often.
const SEARCH_AGAIN_MS = 2 * MINUTE_MS;
const READ_CHECK_MS = MINUTE_MS;
// How often the run line takes one load before a person looks: a load queued again in
// its own run (an SMTP refusal, which makes the draft) goes once more, never in a loop.
const RUNS_PER_LINE = 2;
const NO_START = Object.freeze({
	written() {},
	writeFailed(e) {
		throw e;
	},
});

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
		invalidateJobTracking: () => {},
		rateConTextOf: () => "",
		runLimitMs: LEASE_MS,
		searchAgainMs: SEARCH_AGAIN_MS,
		readCheckMs: READ_CHECK_MS,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (timer) => clearTimeout(timer),
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
	const shadowRenders = mode === "shadow" && d.shadowRenders === true;
	// Real drafts only: with the job off or in shadow there is nothing to start.
	const triggerMode = mode === "on" && trigger.enabled(d.env || {});
	const sendSettings = d.send && typeof d.send === "object"
		// No timer could wake a load after a wait, so the driver's trigger never settles.
		? { enabled: d.send.enabled === true, domains: [...(d.send.domains || [])], settleMinutes: triggerMode ? 0 : sendRules.settleMinutesOf(d.send.settleMinutes) }
		: { enabled: false, domains: [], settleMinutes: sendRules.SETTLE_MINUTES_DEFAULT };
	// Sending happens only in real-draft mode, with a sender to send through.
	const sending = mode === "on" && sendSettings.enabled && typeof d.sendMail === "function";
	const knownAddressOn = rules.knownAddressEnabled(d.env || {});
	const workerId = d.workerId;
	// Whose lease a write names. The sweep runs one tick at a time under the worker's own
	// name. Each of the driver's trigger's runs holds its claim under its own token, kept
	// here for everything that run awaits, so a run past its limit can't write again.
	const runOwner = new AsyncLocalStorage();
	const me = () => runOwner.getStore() || workerId;
	let runNumber = 0;
	const newRunToken = () => `${workerId}#${++runNumber}`;
	if (mode !== "off") ledger.ensureSchema(db);
	else {
		// Off, the job runs no tick, so render records left from a shadow week are
		// pruned here, at start.
		try {
			ledger.pruneRenderDigests(db, { nowMs: d.now().getTime() });
		} catch (e) {
			d.log.error(`[auto-invoice] render prune failed: ${codeOf(e)}`);
		}
	}

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

	// The factored loads are read once per snapshot; a marker that can't be read
	// throws, so the sweep fails and nothing is drafted (SWEEP_FAILED).
	async function snapshot() {
		const jt = await d.readJobTracking();
		const headers = (jt && jt.headers) || [];
		const cols = rules.jobColumns(headers);
		const byKey = new Map();
		for (const row of (jt && jt.data) || []) {
			const key = cols.loadIdCol ? rules.loadKey(row[cols.loadIdCol]) : "";
			if (key) byKey.set(key, row);
		}
		return { headers, cols, byKey, records: rules.indexRecords(ledger.readRecords(db)), settings: ledger.readSettings(db), factored: factoring.factoredKeys(db) };
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
			factored: snap.factored.has(key),
			knownAddressOn,
		});
	}

	const dayOf = (isoText) => (isoText ? appTime.dayInZone(new Date(isoText), d.timeZone) : "");

	// ── the settings' own health ────────────────────────────────────────────

	const listName = (list) => (list === "optOutDomains" ? "opt-out" : "confirmed");
	// In shadow mode a Super Admin reading the notice gets no drafts at all, so it
	// says what shadow is and what stops, not that drafting stops.
	const SHADOW_WORDS = "Shadow mode makes no Gmail drafts: it only records what it would draft.";
	function settingsProblem(s) {
		const shadow = mode === "shadow";
		if (s.unreadable) {
			return { code: "SETTINGS_UNREADABLE", text: shadow
				? `The automatic-draft settings can't be read, so shadow mode records nothing until both the opt-out list and the confirmed broker domains are saved again. ${SHADOW_WORDS}`
				: "The automatic-draft settings can't be read, so nothing is drafted. Save both the opt-out list and the confirmed broker domains again." };
		}
		if (s.dropped.length) {
			const which = s.dropped.map((x) => `${x.domain} (${listName(x.list)}, ${x.code})`).join(", ");
			const text = `Some automatic-draft settings no longer pass the rules and are ignored: ${which}. Save the lists again to remove them.`;
			return { code: "SETTINGS_ENTRIES_DROPPED", text: shadow ? `${text} ${SHADOW_WORDS}` : text };
		}
		return null;
	}

	// One Super Admin notice per settings problem, and again only when it (or the
	// mode, whose words it carries) changes.
	function noticeSettings(s) {
		const problem = settingsProblem(s);
		const signature = problem ? JSON.stringify([mode, problem.code, s.dropped]) : "";
		if ((ledger.getMeta(db).settings_notice || "") === signature) return;
		ledger.setMeta(db, "settings_notice", signature);
		if (!problem) return;
		d.log.warn(`[auto-invoice] settings: ${problem.code}`);
		notify(mode === "shadow" ? "Automatic invoice drafts (shadow mode): settings" : "Automatic invoice drafts: settings", problem.text);
	}

	// ── the sweep ────────────────────────────────────────────────────────────

	async function sweep() {
		if (mode === "off") return { mode };
		if (triggerMode) return { mode, trigger: true };
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
		const nowMs = nowDate().getTime();
		const nowIso = iso(nowMs);
		const meta = ledger.getMeta(db);
		if (!meta.baseline_at) return { mode, baseline: writeBaseline(snap, nowIso) };
		const baselineDay = dayOf(meta.baseline_at);
		const offGap = Boolean(meta.off_gap_since);
		// The first sweep after the driver's trigger ran: a load the trigger left waiting
		// may have been billed by hand meanwhile, so it goes to a person, never a send.
		const backFromTrigger = Boolean(meta.back_from_trigger_at);
		const out = { mode, moved: 0, created: 0, offGap: 0, changed: 0 };
		const claims = new Map(ledger.listClaims(db).map((c) => [c.load_key, c]));

		for (const c of claims.values()) {
			if (c.state === "baseline" || c.state === "skipped" || c.state === "working") continue;
			const facts = factsOf(snap, c.load_key);
			if (c.state === "drafted") {
				out.changed += checkChanged(c, facts, nowIso);
				continue;
			}
			// A send that may have gone out moves on only by its Sent Mail search: a
			// verdict or a hand draft never takes it off that search. Once the search
			// has given it to a person (MAYBE_SENT), that person's own draft closes it.
			if (sendInFlight(c) && c.state !== "needs_attention") continue;
			if (ledger.otherDraftRows(db, c).length) {
				out.moved += skipDraftedByHand(c, nowIso);
				continue;
			}
			if (c.state === "needs_attention") continue;
			const v = rules.freeVerdict(facts);
			if (backFromTrigger && c.state === "waiting" && facts.completed && facts.live && v.state !== "skipped") {
				const n = ledger.transition(db, c.load_key, { from: ["waiting"], patch: { state: "needs_attention", reason_code: "OFF_GAP" }, nowIso });
				out.moved += n;
				out.offGap += n;
				continue;
			}
			if (c.state === "waiting" && v.state === "queued") {
				if (c.reason_code === "RATECON_MISSING" && c.next_attempt_at > nowIso) continue;
				// A send still settling stays waiting, its end of wait read again each sweep.
				const hold = settleHold(c.load_key, facts, nowMs);
				if (hold) {
					if (c.reason_code !== "SEND_SETTLING" || c.next_attempt_at !== hold.untilIso) {
						out.moved += ledger.transition(db, c.load_key, { from: ["waiting"], patch: { reason_code: "SEND_SETTLING", next_attempt_at: hold.untilIso }, nowIso });
					}
					continue;
				}
				const code = c.reason_code === "RATECON_MISSING" ? "RATECON_MISSING" : "";
				out.moved += ledger.transition(db, c.load_key, { from: ["waiting"], patch: { state: "queued", reason_code: code, next_attempt_at: nowIso }, nowIso });
			} else if (v.state !== c.state || (c.state === "waiting" && v.code !== c.reason_code && c.reason_code !== "RATECON_MISSING")) {
				const held = v.state === "needs_attention" && rules.isKnownAddressHold(v.code, facts.brokerDomain);
				const n = ledger.transition(db, c.load_key, { from: [c.state], patch: { state: v.state, reason_code: v.code, check_held_at: held ? nowIso : "", ...voidPatch(c, v.state, nowIso) }, nowIso });
				out.moved += n;
				auditVoid(c, v.state, v.code);
				if (n && held) tellHeld(c.load_id, v.code);
			}
		}

		for (const [key, row] of snap.byKey) {
			if (claims.has(key) || !rules.isCompletedStatus(row[snap.cols.statusCol])) continue;
			const facts = factsOf(snap, key);
			if (!facts.completed || !facts.live) continue;
			const v = rules.newClaimVerdict(facts, { baselineDone: true, baselineDay, offGap });
			// A send waits from the start, taking none of the sweep's attempts.
			const hold = v.state === "queued" ? settleHold(key, facts, nowMs) : null;
			const held = v.state === "needs_attention" && rules.isKnownAddressHold(v.code, facts.brokerDomain);
			const added = hold
				? ledger.insertClaim(db, { key, loadId: facts.loadId, state: "waiting", code: "SEND_SETTLING", nowIso, nextAttemptAt: hold.untilIso })
				: ledger.insertClaim(db, { key, loadId: facts.loadId, state: v.state, code: v.code, nowIso, checkHeldAt: held ? nowIso : "" });
			out.created += added;
			if (added && v.code === "OFF_GAP") out.offGap++;
			if (added && held) tellHeld(facts.loadId, v.code);
		}
		if (offGap) {
			if (out.offGap) {
				audit("auto_invoice_off_gap", "", `${out.offGap} load${out.offGap === 1 ? "" : "s"} completed while automatic drafts were off (${meta.off_gap_since} to ${nowIso}): draft by hand`);
				notify("Automatic invoice drafts: draft by hand", `${out.offGap} load${out.offGap === 1 ? " was" : "s were"} completed while automatic drafts were off. They are marked Needs attention on Completed Loads.`);
			}
			ledger.setMeta(db, "off_gap_since", "");
		}
		if (backFromTrigger) ledger.setMeta(db, "back_from_trigger_at", "");
		ledger.setMeta(db, "last_sweep_at", nowIso);
		return out;
	}

	// Every completed row in the cache, cancelled and soft-deleted ones too (a restore
	// must not make an old load new), is left to people. How many.
	function writeBaseline(snap, nowIso) {
		let n = 0;
		for (const [key, row] of snap.byKey) {
			if (!rules.isCompletedStatus(row[snap.cols.statusCol])) continue;
			n += ledger.insertClaim(db, { key, loadId: row[snap.cols.loadIdCol], state: "baseline", nowIso });
		}
		ledger.setMeta(db, "baseline_at", nowIso);
		audit("auto_invoice_baseline", "", `${n} completed load${n === 1 ? "" : "s"} left to people (baseline)`);
		return n;
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
		if (n && sendRules.claimSent(c)) {
			audit("auto_invoice_load_changed", c.load_id, `${c.invoice_id}: ${fields} (sent)`);
			notify("Sent invoice: load changed", `Load ${c.load_id} changed after its invoice ${c.invoice_id} was sent to the broker (${fields.split(",").join(", ")}). Check with the broker whether a corrected invoice is needed.`);
			stopSending("LOAD_CHANGED_AFTER_SEND", c);
		} else if (n) {
			audit("auto_invoice_load_changed", c.load_id, `${c.invoice_id}: ${fields}`);
			notify("Invoice draft: load changed", `Load ${c.load_id} changed after its automatic invoice draft ${c.invoice_id} (${fields.split(",").join(", ")}). Check the draft in Gmail.`);
		}
		return n;
	}

	// ── the send stop ────────────────────────────────────────────────────────

	// A claim whose send started and isn't confirmed yet.
	const sendInFlight = (c) => Boolean(c && c.delivery === "send" && c.stage === "appending");

	// Stops automatic sending (set-only: a stop already set keeps its reason). One
	// audit row and one Super Admin notice when this call set it.
	function stopSending(reason, c = null) {
		let set = false;
		try {
			set = ledger.setSendStop(db, { reason, nowIso: iso(nowDate().getTime()) });
		} catch (e) {
			d.log.error(`[auto-invoice] the send stop could not be written: ${codeOf(e)}`);
			return false;
		}
		if (!set) return false;
		d.log.warn(`[auto-invoice] automatic sending stopped: ${reason}`);
		audit("auto_invoice_send_stopped", c ? c.load_id : "", `${reason}${c && c.invoice_id ? ` (${c.invoice_id})` : ""}`);
		notify("Automatic invoice sending stopped", `${sendRules.STOP_WORDS[reason] || reason} Invoices are drafted in Gmail for a person to send until sending is resumed on the server.`);
		return true;
	}

	// ── the settle window ───────────────────────────────────────────────────

	// { untilIso } while a load whose invoice would be sent waits for its PODs to
	// settle, else null (a draft never waits). The recipient rule holds the recipient
	// to the broker Email's domain or the Bison inbox, so it is known before a build.
	function settleHold(key, facts, nowMs) {
		if (!sending || triggerMode) return null;
		const g = sendRules.sendDecision({ settings: sendSettings, on: true, stopped: Boolean(ledger.getSendStop(db)),
			to: facts.isBison ? d.bisonRecipient() : facts.brokerEmail, podTimes: () => ledger.livePodTimes(db, key), nowMs });
		return g.why === "SETTLING" ? { untilIso: iso(g.untilMs) } : null;
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

	async function sweepShadow(snap) {
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
		if (!shadowRenders) {
			ledger.setMeta(db, "last_sweep_at", nowIso);
			return { mode, logged };
		}
		const renders = await renderShadow(snap);
		ledger.setMeta(db, "last_sweep_at", nowIso);
		return { mode, logged, renders };
	}

	// ── the render shadow ────────────────────────────────────────────────────

	const recordOf = (json) => {
		try {
			const r = json ? JSON.parse(json) : null;
			return r && typeof r === "object" ? r : null;
		} catch {
			return null;
		}
	};
	const recordAt = (r) => Date.parse(String((r && (r.renderedAt || r.refusedAt)) || "")) || 0;
	// Temporary failures, per load, for this process: when to try again and how
	// many counted failures so far (the job's own backoff, rules.retryDelayMs()).
	const renderWaits = new Map();

	// Each WOULD_ATTEMPT load is built once, and again when its fingerprint
	// changes; once a person has drafted it, the render made before is kept (the
	// report compares that one) and only the fingerprint at the draft is noted. A
	// load drafted before any render is never built (the engine would print that
	// person's own note): it gets a record that says so, and the report counts it
	// as unmatched. The job's caps and the renderer's own busy refusal apply.
	async function renderShadow(snap) {
		const out = { rendered: 0, refused: 0 };
		const startMs = nowDate().getTime();
		if (rules.shadowRenderQuiet(new Date(startMs), d.timeZone)) return { ...out, quiet: true };
		if (!ledger.getMeta(db).shadow_renders_on_at) ledger.setMeta(db, "shadow_renders_on_at", iso(startMs));
		const rows = ledger.listShadow(db);
		const times = rows.map((r) => recordAt(recordOf(r.render_digest_json)));
		let lastHour = times.filter((t) => t >= startMs - HOUR_MS).length;
		let lastDay = times.filter((t) => t >= startMs - DAY_MS).length;
		let started = 0;
		for (const row of rows) {
			if (row.verdict !== "WOULD_ATTEMPT") continue;
			const key = row.load_key;
			const facts = factsOf(snap, key);
			const fp = rules.fingerprintSha256(facts);
			const prev = recordOf(row.render_digest_json);
			const nowIso = iso(nowDate().getTime());
			// A load marked factored after it was judged WOULD_ATTEMPT is never
			// built: its record says so, once.
			if (facts.factored) {
				if (!prev || prev.code !== "LOAD_FACTORED") {
					storeRecord(key, { v: rules.DIGEST_VERSION, refusedAt: nowIso, code: "LOAD_FACTORED", fingerprintSha256: fp }, nowIso);
					renderWaits.delete(key);
					out.refused++;
				}
				continue;
			}
			if (prev && facts.drafts > 0) {
				draftSeen(key, facts, fp, prev);
				continue;
			}
			const retryDue = prev && prev.refusedAt && prev.retryAt && prev.retryAt <= nowIso;
			if (prev && prev.fingerprintSha256 === fp && !retryDue) continue;
			if (!facts.completed || !facts.live) continue;
			const wait = renderWaits.get(key);
			if (wait && wait.until > nowDate().getTime()) continue;
			if (!rules.capsAllow({ inFlight: 0, startedThisSweep: started, draftedLastHour: lastHour, draftedLastDay: lastDay, caps })) break;
			if (!facts.isBison && geminiRecentlyDown()) continue;
			started++;
			const result = await renderOne(row, facts, fp, prev);
			if (result !== "later") {
				if (result !== "kept") out[result]++;
				lastHour++;
				lastDay++;
			}
		}
		return out;
	}

	// Somebody drafted the load: a render made before stays (the fingerprint at the
	// draft noted), a refusal stays, and a load with neither gets a code-only record
	// with the domain its recipient would have had (for the report's --domains).
	function draftSeen(key, facts, fp, prev) {
		const nowMs = nowDate().getTime();
		const at = iso(nowMs);
		renderWaits.delete(key);
		if (prev) {
			if (prev.renderedAt && !prev.draftSeenAt) storeRecord(key, { ...prev, draftSeenAt: at, fingerprintAtDraftSha256: fp }, at);
			return "kept";
		}
		const domain = facts.isBison ? rules.emailDomain(d.bisonRecipient()) : facts.brokerDomain;
		storeRecord(key, { v: rules.DIGEST_VERSION, refusedAt: at, code: rules.SHADOW_DRAFTED_FIRST, domain, fingerprintSha256: fp }, at, firstDraftAt(key, nowMs));
		return "refused";
	}

	// A load drafted before any build joins the comparison at the person's first
	// draft (never later than now), not when a sweep saw it: the Friday quiet
	// window or a cap can put that after the shadow week.
	function firstDraftAt(key, nowMs) {
		const times = ledger.draftRowsFor(db, key).map((r) => Date.parse(String(r.created_at || ""))).filter(Number.isFinite);
		return iso(Math.min(nowMs, ...times));
	}

	// Every record keeps its load's firstAt (when its first record was made) and,
	// once rendered or found drafted first, firstDomain: the comparison places the
	// load by those alone, so a later build, refusal or rewrite can't move it out.
	function storeRecord(key, record, at, firstAt = at) {
		const was = recordOf((ledger.getShadow(db, key) || {}).render_digest_json) || {};
		const joinedFor = record.renderedAt ? rules.emailDomain(record.recipient) : record.code === rules.SHADOW_DRAFTED_FIRST ? String(record.domain || "") : undefined;
		const first = { firstAt: was.firstAt || was.renderedAt || was.refusedAt || firstAt, firstDomain: was.firstDomain ?? joinedFor };
		ledger.setRenderDigest(db, key, JSON.stringify({ ...record, ...first }), at);
	}

	// One load through buildMessage() with the placeholder number and today's
	// date: "rendered" (digest stored), "refused" (code stored), "kept" (drafted
	// meanwhile: draftSeen()) or "later" (a temporary failure; nothing stored).
	async function renderOne(row, facts, fp, prev) {
		const key = row.load_key;
		const nowMs = () => nowDate().getTime();
		// The draft rows are read again before the build (no engine call for a load
		// somebody drafted since the sweep's snapshot) and after it, the last await:
		// a build made while a person drafted could carry that person's own note.
		const draftedNow = () => ledger.draftRowsFor(db, key).length > 0;
		if (draftedNow()) return draftSeen(key, facts, fp, prev);
		const refuse = (code, retry) => {
			const at = iso(nowMs());
			const checks = retry ? ((prev && prev.refusedAt && prev.code === code ? prev.checks : 0) || 0) + 1 : 0;
			const again = retry ? { checks, ...(checks <= rules.RATECON_MAX_CHECKS ? { retryAt: iso(nowMs() + rules.RATECON_RECHECK_MS) } : {}) } : {};
			storeRecord(key, { v: rules.DIGEST_VERSION, refusedAt: at, code, fingerprintSha256: fp, ...again }, at);
			renderWaits.delete(key);
			return "refused";
		};
		const later = ({ code, counts }) => {
			const w = renderWaits.get(key) || { failures: 0 };
			if (!counts) {
				renderWaits.set(key, { failures: w.failures, until: nowMs() + (code === "GEMINI_DOWN" ? rules.GEMINI_WAIT_MS : SHORT_WAIT_MS) });
				return "later";
			}
			const delay = rules.retryDelayMs(w.failures + 1);
			if (delay === null) return refuse("DRAFT_FAILED", false);
			renderWaits.set(key, { failures: w.failures + 1, until: nowMs() + delay });
			return "later";
		};
		const built = await buildMessage.prepare(facts, facts.loadId || row.load_id);
		if (!built.ok) {
			if (!built.prep) return refuse(built.code, false);
			const cls = rules.classifyRefusal(built.prep);
			if (cls.kind === "temporary") return later({ code: cls.code, counts: cls.countsAttempt });
			// "Not ready yet" and "no rate con yet" are looked at again later, as the
			// job would; anything else waits for the load to change.
			return refuse(cls.code, cls.kind === "wait" || cls.kind === "ratecon_missing");
		}
		let msg;
		try {
			msg = await buildMessage.render(built, facts, { invoiceId: rules.SHADOW_INVOICE_ID, invoiceDate: appTime.dayInZone(nowDate(), d.timeZone) });
		} catch (e) {
			return later(e && e.code === "RENDERER_BUSY" ? { code: "RENDERER_BUSY", counts: false } : { code: "RETRY_LATER", counts: true });
		}
		if (!msg.ok) return refuse(msg.code, false);
		if (draftedNow()) return draftSeen(key, facts, fp, prev);
		const at = iso(nowMs());
		storeRecord(key, { ...digestOf(msg.message, at), fingerprintSha256: fp }, at);
		renderWaits.delete(key);
		return "rendered";
	}

	// Every digest the job keeps, of a render or of a draft, is this one.
	const digestOf = (message, renderedAt) => rules.messageDigest(message, { renderedAt });

	// Render records past their keeping time, cleared once a day.
	let prunedDay = "";
	function pruneDaily() {
		const day = appTime.dayInZone(nowDate(), d.timeZone);
		if (day === prunedDay) return 0;
		prunedDay = day;
		try {
			return ledger.pruneRenderDigests(db, { nowMs: nowDate().getTime() });
		} catch (e) {
			d.log.error(`[auto-invoice] render prune failed: ${codeOf(e)}`);
			return 0;
		}
	}

	// ── drafting ─────────────────────────────────────────────────────────────

	function paused(nowIso) {
		const meta = ledger.getMeta(db);
		return meta.paused_until && meta.paused_until > nowIso ? meta : null;
	}

	async function work() {
		if (mode !== "on") return { mode, started: 0 };
		if (triggerMode) return { mode, started: 0, trigger: true };
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
			if (!ledger.lease(db, next.load_key, me(), { nowIso: tIso, untilIso: iso(t + LEASE_MS) })) continue;
			started++;
			inFlightHere = true;
			try {
				await attempt(ledger.getClaim(db, next.load_key), mb);
			} catch (e) {
				d.log.error(`[auto-invoice] load ${next.load_id}: attempt failed: ${codeOf(e)}`);
				const c = ledger.getClaim(db, next.load_key);
				if (c && c.state === "working" && c.lease_owner === me() && STAGES_BEFORE_APPEND.has(c.stage)) temporary(c, { code: "RETRY_LATER", countsAttempt: true });
			} finally {
				inFlightHere = false;
			}
		}
		return { mode, started };
	}

	// Back to the queue after a temporary failure, the number kept; the attempt
	// after the last backoff goes to a person (DRAFT_FAILED).
	function temporary(c, { code, countsAttempt }) {
		// No timer would come back to a queued retry: a person's Try again is the retry.
		if (triggerMode) return toPerson(c, code);
		const t = nowDate().getTime();
		const nowIso = iso(t);
		const stage = keptStage(c);
		const attempts = c.attempts + (countsAttempt ? 1 : 0);
		if (countsAttempt) {
			const delay = rules.retryDelayMs(attempts);
			if (delay === null) {
				return ledger.transition(db, c.load_key, { from: ["working"], owner: me(), nowIso,
					patch: { state: "needs_attention", reason_code: "DRAFT_FAILED", attempts, stage, lease_owner: "", lease_until: "" } });
			}
			return ledger.transition(db, c.load_key, { from: ["working"], owner: me(), nowIso,
				patch: { state: "queued", reason_code: code, attempts, stage, next_attempt_at: iso(t + delay), lease_owner: "", lease_until: "" } });
		}
		const wait = code === "GEMINI_DOWN" ? rules.GEMINI_WAIT_MS : SHORT_WAIT_MS;
		return ledger.transition(db, c.load_key, { from: ["working"], owner: me(), nowIso,
			patch: { state: "queued", reason_code: code, stage, next_attempt_at: iso(t + wait), lease_owner: "", lease_until: "" } });
	}

	// `facts`: the load as this run read it, given where the stop may be on its address or its file.
	function release(c, state, code, extra = {}, facts = null) {
		const nowIso = iso(nowDate().getTime());
		const held = state === "needs_attention" && Boolean(facts) && rules.isKnownAddressHold(code, facts.brokerDomain);
		const n = ledger.transition(db, c.load_key, { from: ["working"], owner: me(), nowIso,
			patch: { state, reason_code: code, stage: keptStage(c), lease_owner: "", lease_until: "", check_held_at: held ? nowIso : "", ...voidPatch(c, state, nowIso), ...extra } });
		if (n) auditVoid(c, state, code);
		if (n && held) tellHeld(c.load_id, code);
		return n;
	}

	// A C.H. Robinson load stopped on one of the codes in rules.KNOWN_ADDRESS_HOLD_CODES tells a
	// person: an audit row and a log line each time, and one Super Admin notice per reason a day, so
	// a run of holds can't flood. Load IDs and codes only, never an address or a name. A stop on
	// anything else, such as the load's total against the sheet, stays a chip. A notice's mark that
	// can't be read or written sends the notice anyway: told twice beats not told.
	function tellHeld(loadId, code) {
		audit("auto_invoice_recipient_held", loadId, `${code}: nothing sent`);
		d.log.warn(`[auto-invoice] load ${loadId}: held, nothing sent: ${code}`);
		const nowMs = nowDate().getTime();
		const mark = `held_notice:${code}`;
		try {
			if (!rules.heldNoticeDue(ledger.getMeta(db)[mark], nowMs)) return;
			ledger.setMeta(db, mark, iso(nowMs));
		} catch (e) {
			d.log.error(`[auto-invoice] the hold's notice mark: ${codeOf(e)}`);
		}
		notify("Automatic invoice held", `Load ${loadId} was held (${code}): ${rules.HELD_NOTICE_WORDS[code]} More held for this reason today get no notice of their own: the automatic-draft settings count them.`);
	}

	// The driver's trigger: this run is over and a person takes the claim, with `code`
	// while nothing has reached Gmail, else by how far it got. A send that started goes
	// to MAYBE_SENT with the stop, as its last search would have.
	function toPerson(c, code) {
		if (!c) return 0;
		const final = STAGES_BEFORE_APPEND.has(c.stage) ? code : trigger.codeByStage(c);
		const n = release(c, "needs_attention", final);
		if (n && final === "MAYBE_SENT") maybeSentNotice(c);
		return n;
	}

	function maybeSentNotice(c) {
		notify("Invoice may have been sent", `Load ${c.load_id}: invoice ${c.invoice_id} may have been sent to the broker, but it wasn't found in Gmail Sent Mail. Check Sent Mail before drafting it again.`);
		stopSending("MAYBE_SENT", c);
	}

	function refused(c, prep, facts) {
		const cls = rules.classifyRefusal({
			code: prep.code,
			http: prep.http,
			geminiUnavailable: Boolean(prep.geminiUnavailable || (prep.ctx && prep.ctx.geminiUnavailable)),
		});
		if (cls.kind === "temporary") return temporary(c, cls);
		if (triggerMode) {
			// Nothing comes back to a wait, so a person looks at once. The load off
			// Delivered, or gone, stays waiting: a later tap arms it.
			if (cls.kind === "ratecon_missing") return release(c, "needs_attention", "RATECON_MISSING", {}, facts);
			if (cls.kind === "wait" && cls.code === "WAITING_POD") return release(c, "needs_attention", rules.waitAttentionCode(cls.code));
			if (cls.kind === "wait") return release(c, "waiting", cls.code);
		}
		if (cls.kind === "wait") {
			// The free checks said ready and the engine said not yet: counted, so the
			// two can't disagree for ever.
			const attempts = c.attempts + 1;
			if (attempts >= rules.ENGINE_WAIT_MAX) return release(c, "needs_attention", rules.waitAttentionCode(cls.code), { attempts });
			return release(c, "waiting", cls.code, { attempts });
		}
		if (cls.kind === "ratecon_missing") {
			const checks = c.ratecon_checks + 1;
			if (checks > rules.RATECON_MAX_CHECKS) return release(c, "needs_attention", "RATECON_MISSING", { ratecon_checks: checks }, facts);
			return release(c, "waiting", "RATECON_MISSING", { ratecon_checks: checks, next_attempt_at: iso(nowDate().getTime() + rules.RATECON_RECHECK_MS) }, facts);
		}
		return release(c, "needs_attention", cls.code, {}, facts);
	}

	const recipientOf = (ctx, rendered) =>
		String((rendered ? rendered.to : ctx && (ctx.to || (ctx.invoiceTo && ctx.invoiceTo.email))) || "");

	// The recipient rule, checked here as well as in the engine: a recipient the
	// rule doesn't allow is a person's call, whatever the engine resolved. Then the
	// known-address check, unless this is a rebuild that only records what already went.
	function recipientRefusal(facts, to, ctx, { recording = false } = {}) {
		if (!to) return null;
		const r = rules.recipientRule({ brokerEmail: facts.brokerEmail, bisonRecipient: d.bisonRecipient(), documentsEmail: to,
			confirmedDomains: facts.brokerDomainConfirmed ? [facts.brokerDomain] : [] });
		if (!r.ok) return r.code;
		if (r.to.toLowerCase() !== to.toLowerCase()) return "RECIPIENT_DOMAIN_MISMATCH";
		if (recording) return null;
		return rules.knownAddressRefusal({ to, checkOn: knownAddressOn, primary: ((ctx && ctx.rateconCandidates) || [])[0], loadId: ctx && ctx.loadId,
			rateConNumber: rules.loadNumberRead(ctx && ctx.paidRead), rateConText: () => d.rateConTextOf(ctx.rateconBuffer),
			loadsToAddress: () => ledger.invoiceLoadsTo(db, to) });
	}

	function geminiRecentlyDown() {
		const at = Number(d.geminiUnavailableAt());
		return Number.isFinite(at) && at > 0 && nowDate().getTime() - at < rules.GEMINI_WAIT_MS;
	}

	// <build-message>
	// The one way the job makes an invoice email, for the real draft, a recovery's
	// rebuild and the render shadow alike, in two halves around the invoice number.
	const buildMessage = Object.freeze({
		// engine.prepare in mode "auto", then the recipient rule on the planned
		// recipient: { ok: true, ctx, planned }, or { ok: false, prep } (the
		// engine refused or threw) or { ok: false, code } (the job's own rule).
		// `recording`: the message already went, and this rebuild only records it.
		async prepare(facts, loadId, { recording = false } = {}) {
			let prep;
			try {
				prep = await engine.prepare({ loadId, body: {}, dryRun: false, mode: "auto" });
			} catch (e) {
				return { ok: false, prep: { code: e && e.code, http: 0, geminiUnavailable: Boolean(e && e.geminiUnavailable) } };
			}
			if (!prep || !prep.ok) {
				const p = prep || {};
				return { ok: false, prep: { ...p, geminiUnavailable: Boolean(p.geminiUnavailable || (p.ctx && p.ctx.geminiUnavailable)) } };
			}
			const planned = recipientOf(prep.ctx, null);
			const code = planned ? recipientRefusal(facts, planned, prep.ctx, { recording }) : "NO_BILLING_EMAIL";
			return code ? { ok: false, code } : { ok: true, ctx: prep.ctx, planned };
		},
		// engine.render with the number given, then the recipient checked again and
		// held to the planned one: { ok: true, rendered, to, message } or { ok:
		// false, code }. A render that throws, throws.
		async render(built, facts, { invoiceId, invoiceDate, recording = false }) {
			const rendered = await engine.render(built.ctx, { invoiceId, invoiceDate, emailBody: null });
			const to = recipientOf(built.ctx, rendered);
			const code = !to ? "NO_BILLING_EMAIL" : recipientRefusal(facts, to, built.ctx, { recording }) || (to.toLowerCase() === built.planned.toLowerCase() ? null : "DRAFT_REFUSED");
			if (code) return { ok: false, code };
			return { ok: true, rendered, to, message: Object.freeze({ to, subject: rendered.subject, html: rendered.html, attachments: rendered.attachments || [] }) };
		},
	});
	// </build-message>

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
		if (!fresh || fresh.state !== "working" || fresh.lease_owner !== me()) return;
		// A send that got no answer: only Sent Mail is searched, never a resend.
		if (sendInFlight(fresh)) return searchSent(fresh, mb);
		// Past the hand-off there is nothing left to make, only to record.
		if (fresh.stage === "appended" || fresh.stage === "recorded") return recordFromGmail(key);
		if (ledger.otherDraftRows(db, fresh).length) return skipDraftedByHand(fresh, iso(nowDate().getTime()), me());
		if (snap.settings.unreadable) return temporary(fresh, { code: "SETTINGS_UNREADABLE", countsAttempt: false });
		const fv = rules.freeVerdict(facts);
		// Nothing comes back to a wait: a load that reads completed needs a person, who
		// has Try again. One off Delivered, or gone, stays waiting for a later tap.
		if (triggerMode && fv.state === "waiting" && facts.completed && facts.live) return release(fresh, "needs_attention", fv.code);
		if (fv.state !== "queued") return release(fresh, fv.state, fv.code, {}, facts);
		if (!facts.isBison && geminiRecentlyDown()) return temporary(fresh, { code: "GEMINI_DOWN", countsAttempt: false });

		// The last append may have landed after its answer was lost: look first.
		if (fresh.stage === "appending") {
			const seen = await lookInGmail(fresh, mb);
			if (seen === "unknown") return release(fresh, "needs_attention", "MAYBE_IN_GMAIL");
			if (seen === "found") {
				if (!ledger.setStage(db, key, me(), "appended", iso(nowDate().getTime()))) return;
				return recordFromGmail(key);
			}
			// Proven absent: the number never reached Gmail and may be used again.
			if (!ledger.setStage(db, key, me(), "reserved", iso(nowDate().getTime()))) return;
			fresh = ledger.getClaim(db, key);
		}

		// A send that hasn't settled waits before anything is paid for or minted.
		const hold = settleHold(key, facts, nowDate().getTime());
		if (hold) return release(fresh, "waiting", "SEND_SETTLING", { next_attempt_at: hold.untilIso });

		// A refusal thrown, not returned, is classed the same way: a person, a
		// counted wait or the rate-con re-check, never an uncounted paid retry. No
		// number before the recipient rule has passed on a recipient.
		const built = await buildMessage.prepare(facts, facts.loadId || fresh.load_id);
		if (!built.ok) return built.prep ? refused(fresh, built.prep, facts) : release(fresh, "needs_attention", built.code, {}, facts);

		// A person's Try again on a load that could be sent looks before the number, however
		// the claim got here: straight from the press, or across a restart.
		if (fresh.look_first && sendRules.gate({ settings: sendSettings, on: sending, stopped: false, to: built.planned }).send) {
			const found = await lookBeforeSend(fresh, facts, mb);
			fresh = ledger.getClaim(db, key);
			if (!fresh || fresh.state !== "working" || fresh.lease_owner !== me()) return;
			if (found) return release(fresh, "needs_attention", found);
			if (!ledger.transition(db, key, { from: ["working"], owner: me(), nowIso: iso(nowDate().getTime()), patch: { look_first: "" } })) return;
		}

		// After the last await: the claim is still ours and nobody drafted the
		// load by hand; the number is minted here, once (a fresh one when the one
		// reserved is over a day old and never reached Gmail).
		const now = nowDate();
		const r = ledger.reserveNumber(db, key, me(), {
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
				if (cur) skipDraftedByHand(cur, iso(nowDate().getTime()), me());
			}
			if (r.reason === "factored") {
				const cur = ledger.getClaim(db, key);
				if (cur) release(cur, "skipped", "LOAD_FACTORED");
			}
			return;
		}
		if (r.voided) audit("auto_invoice_number_void", fresh.load_id, `${r.voided.invoiceId} was reserved on ${r.voided.invoiceDate} and never used (a fresh number replaces it)`);
		const held = ledger.getClaim(db, key);

		let msg;
		try {
			msg = await buildMessage.render(built, facts, { invoiceId: r.invoiceId, invoiceDate: r.invoiceDate });
		} catch (e) {
			const busy = e && e.code === "RENDERER_BUSY";
			return temporary(held, busy ? { code: "RENDERER_BUSY", countsAttempt: false } : { code: "RETRY_LATER", countsAttempt: true });
		}
		if (!msg.ok) return release(held, "needs_attention", msg.code, {}, facts);
		const { rendered, to, message } = msg;
		if (!ledger.setStage(db, key, me(), "rendered", iso(nowDate().getTime()))) return;
		// After the render's await: a hand draft made meanwhile wins, before Gmail,
		// and so does a mark (factored, or a marker that can't be read): the
		// number, never handed to Gmail, is voided.
		const rendering = ledger.getClaim(db, key);
		if (ledger.otherDraftRows(db, rendering).length) return skipDraftedByHand(rendering, iso(nowDate().getTime()), me());
		if (ledger.factoredOrUnreadable(db, key)) return release(rendering, "skipped", "LOAD_FACTORED");
		const g = sending ? sendRules.sendDecision({ settings: sendSettings, on: true, stopped: Boolean(ledger.getSendStop(db)), to,
			podTimes: () => ledger.livePodTimes(db, key), nowMs: nowDate().getTime() }) : null;
		// The PODs read again after the build: one uploaded meanwhile holds the send,
		// its number kept, until the wait after that POD is over.
		if (g && g.why === "SETTLING" && !triggerMode) return release(rendering, "waiting", "SEND_SETTLING", { next_attempt_at: iso(g.untilMs) });
		if (g && g.send) {
			// No await here: stopped meanwhile, the load is drafted below with no wait
			// after the checks above, as before.
			const sent = sendOne(rendering, { built, rendered, to, message, messageId: r.messageId, facts, mb });
			if (sent !== DRAFT_INSTEAD) return sent;
		} else if (g && g.why === "DOMAIN_NOT_LISTED") {
			audit("auto_invoice_send_refused", rendering.load_id, `${rendering.invoice_id}: DOMAIN_NOT_LISTED (${rules.emailDomain(to) || "unknown domain"}); drafted for a person instead`);
		} else if (g && (g.why === "POD_TIME_UNKNOWN" || g.why === "SETTLING")) {
			// With no wait to hold it, a POD time ahead of the clock counts as unreadable.
			audit("auto_invoice_send_refused", rendering.load_id, `${rendering.invoice_id}: POD_TIME_UNKNOWN; drafted for a person instead`);
		}
		const handedAt = iso(nowDate().getTime());
		if (!ledger.transition(db, key, { from: ["working"], owner: me(), nowIso: handedAt,
			patch: { stage: "appending", delivery: "", sent_json: JSON.stringify(sentOf(to, rendered)), draft_digest_json: JSON.stringify(digestOf(message, handedAt)) } })) return;

		try {
			await d.appendGmailDraft({
				user: mb.user,
				pass: mb.pass,
				from: `LogisX Inc. <${mb.user}>`,
				to: message.to,
				subject: message.subject,
				html: message.html,
				attachments: message.attachments,
				messageId: r.messageId,
			});
		} catch (e) {
			return appendFailed(ledger.getClaim(db, key), e, mb, () => finishRecorded(key, built.ctx, rendered, facts));
		}
		if (!ledger.setStage(db, key, me(), "appended", iso(nowDate().getTime()))) return;
		ledger.setMeta(db, "pause_ms", "");
		return finishRecorded(key, built.ctx, rendered, facts);
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
			notify("Automatic invoice drafts paused", triggerMode
				? `Gmail refused the mailbox login. LogisX logs in again after ${Math.round(ms / HOUR_MS)} h. A load delivered meanwhile needs Try again after that.`
				: `Gmail refused the mailbox login. Automatic drafts are paused for ${Math.round(ms / HOUR_MS)} h and will try again then.`);
			if (triggerMode) return release({ ...c, stage: "reserved" }, "needs_attention", "MAILBOX_PAUSED");
			return ledger.transition(db, c.load_key, { from: ["working"], owner: me(), nowIso: iso(nowMs),
				patch: { state: "queued", reason_code: "MAILBOX_PAUSED", stage: "reserved", next_attempt_at: iso(nowMs + ms), lease_owner: "", lease_until: "" } });
		}
		if (stage === "literal" && !e.answered) {
			// The message was streamed and no answer came: it may land later.
			let seen = await lookInGmail(c, mb);
			if (triggerMode && seen === "absent") {
				await d.sleep(d.searchAgainMs);
				seen = await lookInGmail(c, mb);
			}
			if (seen === "unknown") return release(c, "needs_attention", "MAYBE_IN_GMAIL");
			if (seen === "found") {
				if (!ledger.setStage(db, c.load_key, me(), "appended", iso(nowDate().getTime()))) return 0;
				return record();
			}
			// It may still land, and no timer would look again: a person, with Try again.
			if (triggerMode) return release(c, "needs_attention", "MAYBE_IN_GMAIL");
			// Not there yet: the claim stays "appending", so the retry searches again
			// before appending, and its number is never taken for unused.
			return temporary(ledger.getClaim(db, c.load_key), { code: "RETRY_LATER", countsAttempt: true });
		}
		// Refused, or stopped before the message was sent: it isn't in Gmail.
		const cur = ledger.getClaim(db, c.load_key);
		return temporary({ ...cur, stage: "reserved" }, { code: "RETRY_LATER", countsAttempt: true });
	}

	// Is the claim's message in Gmail: in Drafts, or in Sent Mail once a person has
	// sent it (findDraftByMessageId() searches both)? "found", "absent" (in
	// neither), or "unknown" (no mailbox, or a search or mailbox failed).
	async function lookInGmail(c, mb) {
		if (!mb.user || !mb.pass || !c.message_id) return "unknown";
		try {
			const found = await d.findDraftByMessageId({ user: mb.user, pass: mb.pass, messageId: c.message_id });
			return found && found.found ? "found" : "absent";
		} catch {
			return "unknown";
		}
	}

	// ── sending ──────────────────────────────────────────────────────────────

	// One load's send, synchronous up to the SMTP call. The last check on the
	// message, then the claim commits to the send (ledger.beginSend(): the
	// hand-draft check, the stop and, last, the factoring marker, in one
	// transaction), then smtpSend() starts the SMTP call in the same run, with no
	// wait in between. DRAFT_INSTEAD when sending was stopped meanwhile.
	function sendOne(c, { built, rendered, to, message, messageId, facts, mb }) {
		const key = c.load_key;
		const check = sendRules.outgoingCheck({ message, rendered, planned: built.planned, domains: sendSettings.domains });
		if (check) return refuseSend(c, "SEND_REFUSED", check);
		const handedAt = iso(nowDate().getTime());
		const sentJson = JSON.stringify(sentOf(to, rendered));
		const digestJson = JSON.stringify(digestOf(message, handedAt));
		const begun = ledger.beginSend(db, key, me(), { nowIso: handedAt, sentJson, digestJson });
		if (!begun.ok) {
			if (begun.reason === "stopped") return DRAFT_INSTEAD;
			// A Try again's look that never came back clean: nothing is sent.
			if (begun.reason === "look") return release(ledger.getClaim(db, key), "needs_attention", "MAILBOX_UNREAD");
			if (begun.reason === "drafted") return skipDraftedByHand(ledger.getClaim(db, key), iso(nowDate().getTime()), me());
			// A person's draft is being handed to Gmail: neither sent nor drafted now;
			// looked at again once that draft is recorded or dropped.
			if (begun.reason === "press") return temporary(ledger.getClaim(db, key), { code: "HAND_DRAFT_IN_FLIGHT", countsAttempt: false });
			if (begun.reason === "factored") return refuseSend(ledger.getClaim(db, key), "LOAD_FACTORED", "LOAD_FACTORED");
			return 0;
		}
		return smtpSend(key, { built, rendered, message, messageId, facts, mb });
	}

	async function smtpSend(key, { built, rendered, message, messageId, facts, mb }) {
		try {
			await d.sendMail({
				user: mb.user,
				pass: mb.pass,
				from: `LogisX Inc. <${mb.user}>`,
				to: message.to,
				subject: message.subject,
				html: message.html,
				attachments: message.attachments,
				messageId,
			});
		} catch (e) {
			return sendFailed(ledger.getClaim(db, key), e, mb, () => finishRecorded(key, built.ctx, rendered, facts));
		}
		if (!markSent(key)) return 0;
		return finishRecorded(key, built.ctx, rendered, facts);
	}

	// The recipient's domain a claim was sent to, for the audit rows.
	function sentDomain(c) {
		try {
			return rules.emailDomain(JSON.parse(c.sent_json || "{}").to) || "";
		} catch {
			return "";
		}
	}

	// The send is confirmed (the server took it, or Sent Mail holds it): the claim
	// moves on from appending once, with one auto_invoice_sent audit row.
	function markSent(key) {
		const c = ledger.getClaim(db, key);
		if (!sendInFlight(c) || c.lease_owner !== me()) return false;
		if (!ledger.setStage(db, key, me(), "appended", iso(nowDate().getTime()))) return false;
		audit("auto_invoice_sent", c.load_id, `${c.invoice_id} → ${sentDomain(c) || "unknown domain"} (sent by the automatic invoice job)`);
		return true;
	}

	// Nothing is sent and a person looks: the last check on the message failed
	// (SEND_REFUSED), or the load is factored (LOAD_FACTORED), whose number is given
	// up because it can never be this load's emailed invoice.
	function refuseSend(c, code, check) {
		if (!c) return 0;
		const nowIso = iso(nowDate().getTime());
		const voidIt = code === "LOAD_FACTORED" && Boolean(c.invoice_id) && !c.number_voided_at && STAGES_BEFORE_APPEND.has(c.stage);
		const n = ledger.transition(db, c.load_key, { from: ["working"], owner: me(), nowIso, patch: {
			state: "needs_attention", reason_code: code, stage: keptStage(c), lease_owner: "", lease_until: "", ...(voidIt ? { number_voided_at: nowIso } : {}),
		} });
		if (!n) return 0;
		audit("auto_invoice_send_refused", c.load_id, `${c.invoice_id}: ${code}${check !== code ? ` (${check})` : ""}; nothing sent`);
		if (voidIt) audit("auto_invoice_number_void", c.load_id, `${c.invoice_id} was reserved for this load and never used (${code})`);
		notify("Invoice not sent", code === "LOAD_FACTORED"
			? `Load ${c.load_id} is marked factored, so its invoice was not sent. Its invoice goes through Triumph.`
			: `Load ${c.load_id}'s invoice email failed its last check before sending, so nothing was sent. Draft it by hand.`);
		return n;
	}

	// The SMTP call failed. Refused (or the login was): nothing left the mailbox,
	// so sending stops and the load goes back to be drafted. Anything else may have
	// been delivered: sending stops and Sent Mail is searched, never a resend.
	async function sendFailed(c, e, mb, record) {
		if (!c) return 0;
		const outcome = e && (e.outcome === "login" || e.outcome === "refused") ? e.outcome : "unknown";
		d.log.error(`[auto-invoice] load ${c.load_id}: send failed: ${codeOf(e)} (${outcome})`);
		if (outcome !== "unknown") {
			stopSending(outcome === "login" ? "SMTP_LOGIN_REFUSED" : "SMTP_REFUSED", c);
			const nowIso = iso(nowDate().getTime());
			return ledger.transition(db, c.load_key, { from: ["working"], owner: me(), nowIso, patch: {
				state: "queued", reason_code: "RETRY_LATER", stage: "reserved", delivery: "", sent_at: "", sent_json: "", draft_digest_json: "",
				next_attempt_at: nowIso, lease_owner: "", lease_until: "",
			} });
		}
		stopSending("SEND_UNANSWERED", c);
		return searchSent(ledger.getClaim(db, c.load_key), mb, record, { searchAgain: triggerMode });
	}

	// A send with no answer: is it in Sent Mail? Found: recorded as sent. Not found,
	// or the search failed: searched again 15 and 60 minutes after the send; then a
	// person checks Sent Mail (MAYBE_SENT). It is never sent again. The driver's trigger
	// has no timer: its own run searches once more (`searchAgain`), then a person.
	async function searchSent(c, mb, record = null, { searchAgain = false } = {}) {
		if (!c) return 0;
		const key = c.load_key;
		const checks = (Number(c.send_checks) || 0) + 1;
		let seen = await lookInSent(c, mb);
		if (searchAgain && seen !== "found") {
			await d.sleep(d.searchAgainMs);
			seen = await lookInSent(c, mb);
		}
		const cur = ledger.getClaim(db, key);
		if (!sendInFlight(cur) || cur.state !== "working" || cur.lease_owner !== me()) return 0;
		if (seen === "found") {
			if (!markSent(key)) return 0;
			return record ? record() : recordFromGmail(key);
		}
		const nowMs = nowDate().getTime();
		const nowIso = iso(nowMs);
		if (triggerMode || checks >= sendRules.SEARCH_AFTER_MS.length) {
			const n = ledger.transition(db, key, { from: ["working"], owner: me(), nowIso, patch: {
				state: "needs_attention", reason_code: "MAYBE_SENT", send_checks: checks, lease_owner: "", lease_until: "",
			} });
			if (n) maybeSentNotice(cur);
			return n;
		}
		const sentAtMs = Date.parse(cur.sent_at) || nowMs;
		return ledger.transition(db, key, { from: ["working"], owner: me(), nowIso, patch: {
			state: "queued", reason_code: "SEND_UNCONFIRMED", send_checks: checks,
			next_attempt_at: iso(Math.max(nowMs, sentAtMs + sendRules.SEARCH_AFTER_MS[checks])), lease_owner: "", lease_until: "",
		} });
	}

	// Sent Mail only: a send never lands in Drafts.
	async function lookInSent(c, mb) {
		if (!mb.user || !mb.pass || !c.message_id) return "unknown";
		try {
			const found = await d.findDraftByMessageId({ user: mb.user, pass: mb.pass, messageId: c.message_id, mailboxes: [sendRules.SENT_MAILBOX] });
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
		const built = await buildMessage.prepare(facts, facts.loadId || c.load_id, { recording: true });
		if (!built.ok) return unrecorded();
		let msg;
		try {
			msg = await buildMessage.render(built, facts, { invoiceId: c.invoice_id, invoiceDate: c.invoice_date, recording: true });
		} catch {
			return unrecorded();
		}
		if (!msg.ok || JSON.stringify(sentOf(msg.to, msg.rendered)) !== JSON.stringify(sentOf(sent.to, sent))) return unrecorded();
		return finishRecorded(key, built.ctx, msg.rendered, facts);
	}

	// The draft is in Gmail: record it once (a row already there is reused), then
	// the claim is drafted with what the load looked like.
	async function finishRecorded(key, ctx, rendered, facts) {
		let c = ledger.getClaim(db, key);
		if (!c || c.state !== "working" || c.lease_owner !== me()) return 0;
		let row = ledger.ownDraftRow(db, c);
		if (!row) {
			// A sent invoice is recorded as the job's send, a draft as its draft.
			const via = c.delivery === "send" ? rules.VIA_SEND : rules.VIA_DRAFT;
			let answer = null;
			try {
				answer = await engine.record(ctx, rendered, { via, actor: AUTO_ACTOR, invoiceId: c.invoice_id, mintedInvoiceId: c.invoice_id, editDiffs: [] });
			} catch (e) {
				d.log.error(`[auto-invoice] load ${c.load_id}: recording the draft failed: ${codeOf(e)}`);
			}
			c = ledger.getClaim(db, key);
			// The row record() answers it wrote, when it is this claim's own draft;
			// otherwise the claim's own row looked up by its invoice number.
			const answered = answer && answer.recorded ? Number(answer.draftRowId) : NaN;
			const byId = c ? ledger.draftRowsFor(db, c.load_key).find((r) => r.id === answered && r.via === via && r.invoice_id === c.invoice_id) : null;
			row = byId || (c ? ledger.ownDraftRow(db, c) : null);
		}
		const nowIso = iso(nowDate().getTime());
		if (!row) return release(c, "needs_attention", "IN_GMAIL_UNRECORDED", { stage: "appended" });
		return ledger.transition(db, key, { from: ["working"], owner: me(), nowIso, patch: {
			state: "drafted", reason_code: "", stage: "recorded", draft_row_id: row.id, drafted_at: nowIso,
			fingerprint_json: JSON.stringify(rules.fingerprint(facts)), lease_owner: "", lease_until: "",
		} });
	}

	// ── recovery after a crash or restart ───────────────────────────────────

	async function recover() {
		if (mode !== "on") return { mode, recovered: 0 };
		if (triggerMode) return { mode, recovered: 0, trigger: true };
		// Recording needs the confirmed domains: an expired claim waits for them.
		if (ledger.readSettings(db).unreadable) return { mode, recovered: 0, paused: "SETTINGS_UNREADABLE" };
		const mb = d.mailbox() || {};
		let recovered = 0;
		for (const c of ledger.expiredWorking(db, iso(nowDate().getTime()))) {
			const t = nowDate().getTime();
			if (!ledger.takeOver(db, c.load_key, me(), { nowIso: iso(t), untilIso: iso(t + LEASE_MS) })) continue;
			recovered++;
			const held = ledger.getClaim(db, c.load_key);
			try {
				await recoverOne(held, mb);
			} catch (e) {
				d.log.error(`[auto-invoice] load ${held.load_id}: recovery failed: ${codeOf(e)}`);
				const cur = ledger.getClaim(db, held.load_key) || held;
				release(cur, "needs_attention", STAGES_BEFORE_APPEND.has(cur.stage) ? "DRAFT_FAILED" : cur.delivery === "send" ? "MAYBE_SENT" : "MAYBE_IN_GMAIL");
			}
		}
		return { mode, recovered };
	}

	async function recoverOne(c, mb) {
		// With the driver's trigger only a restart or a press brings a claim here, and a press has
		// already asked for the look: one a restart caught gets it too, before any send.
		const requeue = (stage) => ledger.transition(db, c.load_key, { from: ["working"], owner: me(), nowIso: iso(nowDate().getTime()),
			patch: { state: "queued", stage, next_attempt_at: iso(nowDate().getTime()), lease_owner: "", lease_until: "", ...(triggerMode ? { look_first: iso(nowDate().getTime()) } : {}) } });
		if (sendInFlight(c)) return searchSent(c, mb);
		if (STAGES_BEFORE_APPEND.has(c.stage)) {
			if (triggerMode && c.message_id) {
				const seen = await lookInSent(c, mb);
				if (seen === "unknown") return release(c, "needs_attention", "MAILBOX_UNREAD");
				if (seen === "found") return recordLostSend(c);
			}
			return requeue(keptStage(c));
		}
		if (c.stage === "appending") {
			const seen = await lookInGmail(c, mb);
			if (seen === "unknown") return release(c, "needs_attention", "MAYBE_IN_GMAIL");
			if (seen === "absent") return requeue("reserved");
			ledger.setStage(db, c.load_key, me(), "appended", iso(nowDate().getTime()));
		}
		return recordFromGmail(c.load_key);
	}

	// A claim that never reached its send's commit, yet whose message is in Sent Mail: the
	// commit was lost with the box's power. It went, so it's recorded, and never built again.
	function recordLostSend(c) {
		const nowIso = iso(nowDate().getTime());
		if (!ledger.transition(db, c.load_key, { from: ["working"], owner: me(), nowIso, patch: { delivery: "send", sent_at: nowIso, stage: "appended" } })) return 0;
		audit("auto_invoice_sent", c.load_id, `${c.invoice_id} → ${sentDomain(c) || "unknown domain"} (found in Sent Mail after a restart)`);
		return recordFromGmail(c.load_key);
	}

	// One timer tick: leases left by a crash, then the sweep, then drafting.
	async function tick() {
		if (mode === "off") return { mode };
		if (triggerMode) return { mode, trigger: true };
		pruneDaily();
		const out = { mode };
		if (mode === "on") {
			const nowMs = nowDate().getTime();
			const meta = ledger.getMeta(db);
			// The first tick after the driver's trigger ran, however long it ran: the loads
			// completed meanwhile with no claim go to a person, as after any time off.
			if (meta.trigger_on_at) {
				ledger.setMeta(db, "off_gap_since", meta.off_gap_since || meta.trigger_on_at);
				ledger.setMeta(db, "back_from_trigger_at", iso(nowMs));
				ledger.setMeta(db, "trigger_on_at", "");
			// The heartbeat is written before the sheet is read, so a sheet outage
			// is never mistaken for the job being off.
			} else if (meta.baseline_at && !meta.off_gap_since && rules.isOffGap(meta.last_on_tick_at, nowMs)) {
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
					// Only on an invoice the job sent: it is in Sent Mail, not Drafts.
					...(c.state === "drafted" && sendRules.claimSent(c) ? { sent: true } : {}),
				};
			}
			// A marker that can't be read says no mark was cleared: the chips below stay as they were.
			let cleared = new Map();
			try {
				cleared = factoring.clearedMarks(db);
			} catch (e) {
				logOnce("annotate-marks", `the cleared factoring marks could not be read: ${codeOf(e)}`);
			}
			if (triggerMode) {
				markTriggerRows(rows, headers, claims, cleared);
				// A Super Admin's read is when the claims get looked at, at most once a minute.
				readCheck();
			} else {
				markTriggerRows(rows, headers, claims, cleared, { clearedOnly: true });
			}
			flagClearedDrafts(rows, idCol, claims, cleared);
		} catch (e) {
			logOnce("annotate", `the Completed Loads status could not be read: ${codeOf(e)}`);
		}
		return rows;
	}

	// The rows' extras while the driver's Delivered starts the invoice: what Try again
	// would do, and the "No automatic invoice" chip on a completed load nothing will
	// invoice: no claim, one left waiting, or one that stopped on a mark since cleared. It
	// travels as a Needs attention status with its own code, so the toggle counts it; the
	// client offers no Try again on it. `clearedOnly`: with the timer sweeping, it finds the rest
	// itself, but a load that stopped on a mark stays closed whichever starts the invoice.
	function markTriggerRows(rows, headers, open, cleared, { clearedOnly = false } = {}) {
		if (clearedOnly && !cleared.size) return;
		const cols = rules.jobColumns(headers || []);
		const known = new Map(ledger.listClaims(db).map((c) => [c.load_key, c]));
		const stopped = Boolean(ledger.getSendStop(db));
		const settings = ledger.readSettings(db);
		const baselineAt = ledger.getMeta(db).baseline_at;
		// Read once, and only for a row that needs them: most rows hold a claim.
		let looked = null;
		const lookup = () => looked || (looked = { records: rules.indexRecords(ledger.readRecords(db)), factored: factoring.factoredKeys(db) });
		for (const row of rows) {
			const key = rules.loadKey(row[cols.loadIdCol]);
			if (!key) continue;
			const c = open.get(key);
			if (c && c.state !== "waiting") {
				if (clearedOnly) continue;
				row._autoInvoice.trigger = true;
				if (c.state === "needs_attention") {
					const email = String(row[cols.emailCol] == null ? "" : row[cols.emailCol]);
					const to = rules.isBisonEmail(email) ? d.bisonRecipient() : email;
					const couldSend = sendRules.gate({ settings: sendSettings, on: sending, stopped: false, to }).send;
					const held = !knownAddressOn && rules.isKnownAddressDomain(rules.emailDomain(email));
					row._autoInvoice.retry = trigger.retryKind(c, { couldSend, stopped, held });
				}
				continue;
			}
			// The claim stays closed, so nothing comes back on its own: a person drafts the load.
			const closed = c ? null : known.get(key);
			const markCleared = Boolean(closed) && closed.state === "skipped" && closed.reason_code === "LOAD_FACTORED" && cleared.has(key);
			if (clearedOnly && !markCleared) continue;
			if ((closed && !markCleared) || !baselineAt || !rules.isCompletedStatus(row[cols.statusCol])) continue;
			let closedMonths = null;
			try {
				closedMonths = d.closedMonthsOf(headers, row);
			} catch {
				closedMonths = null;
			}
			const rec = lookup().records.get(key);
			const showing = trigger.showsNotStarted({
				live: !(rec && rec.deleted) && !rules.isCancelledStatus(row[cols.statusCol]),
				drafts: rec ? rec.drafts.length : 0,
				factored: lookup().factored.has(key),
				optedOut: rules.domainOptedOut(rules.emailDomain(row[cols.emailCol]), settings.optOutDomains),
				completionDay: cols.completionCol ? d.dayKeyOf(row[cols.completionCol]) || "" : "",
				baselineDay: dayOf(baselineAt),
				closedMonths,
			});
			if (showing) row._autoInvoice = { state: "needs_attention", code: markCleared ? "FACTORED_MARK_CLEARED" : "NOT_BY_DRIVER", invoiceId: "", changed: [], trigger: true, retry: "none" };
			else if (c) delete row._autoInvoice;
		}
	}

	// The job's unsent draft, then a mark, then the mark cleared. A person was told to delete it
	// while marked, so "Draft ready" may point at nothing, and the job won't make another. A draft
	// made after the clear is the load's invoice, and the job's old number says nothing about it.
	function flagClearedDrafts(rows, idCol, claims, cleared) {
		for (const row of rows) {
			const key = rules.loadKey(row[idCol]);
			const c = claims.get(key);
			if (!c || c.state !== "drafted" || sendRules.claimSent(c) || !c.drafted_at) continue;
			const clearedAt = cleared.get(key);
			if (!(clearedAt > c.drafted_at)) continue;
			if (ledger.otherDraftRows(db, c).some((d) => Date.parse(d.created_at) > Date.parse(clearedAt))) delete row._autoInvoice;
			else row._autoInvoice.markCleared = true;
		}
	}

	function status() {
		const meta = mode === "off" ? {} : ledger.getMeta(db);
		const nowIso = iso(nowDate().getTime());
		const settings = mode === "off" ? null : ledger.readSettings(db);
		const problem = settings ? settingsProblem(settings) : null;
		const loginPause = meta.paused_until && meta.paused_until > nowIso ? { until: meta.paused_until, reason: meta.pause_reason || "" } : null;
		const check = recipientCheckState();
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
			shadowRenders,
			caps: { maxPerHour: caps.maxPerHour, maxPerDay: caps.maxPerDay },
			...(sending ? { send: sendState() } : {}),
			...(check ? { recipientCheck: check } : {}),
			...(triggerMode ? { trigger: { on: true, timer: false, since: meta.trigger_on_at || "" } } : {}),
		};
	}

	// Sending as a Super Admin reads it (only while sending is on): the domains it
	// sends to and the stop, if set.
	function sendState() {
		const stop = ledger.getSendStop(db);
		return { domains: [...sendSettings.domains], stopped: stop ? { at: stop.at, reason: stop.reason } : null };
	}

	// The known-address check as a Super Admin reads it, only when it has something to say: it
	// is off, or C.H. Robinson loads have been stopped on their address or their file lately.
	// Real-draft mode only: shadow holds nothing. Sending or not, since the check holds a draft
	// too. { on, domain, days, held: { count, byCode } } or null.
	function recipientCheckState() {
		if (mode !== "on") return null;
		const held = ledger.recentHolds(db, rules.KNOWN_ADDRESS_HOLD_CODES, iso(nowDate().getTime() - rules.HELD_RECENT_DAYS * DAY_MS));
		if (knownAddressOn && !held.count) return null;
		return { on: knownAddressOn, domain: rules.KNOWN_ADDRESS_DOMAIN, days: rules.HELD_RECENT_DAYS, held };
	}

	// The Draft Invoice button's check, before anything is read or minted: a load
	// whose invoice the job sent (or may have) answers 409 INVOICE_ALREADY_SENT
	// unless the press confirms a re-issue with a reason (audited); while sending
	// is on, a load the job is working on answers 409 AUTO_INVOICE_IN_FLIGHT.
	// { ok: true } or { ok: false, http, json }.
	// The job switched off later still guards what it sent, while its tables exist.
	// A preview (dry run) makes no draft and no number, so it is never refused here.
	function draftButtonCheck(req, loadId, { dryRun = false } = {}) {
		if (dryRun === true) return { ok: true };
		if (mode === "off" && !ledger.hasSchema(db)) return { ok: true };
		const key = rules.loadKey(loadId);
		const r = key ? sendRules.buttonRefusal({ claim: ledger.getClaim(db, key), sendEnabled: sending, body: req && req.body }) : null;
		if (!r) return { ok: true };
		if (r.ok) {
			d.logAudit(req, "auto_invoice_reissue_confirmed", "load", String(loadId || ""), `re-issue after the automatic send of ${r.reissue.invoiceId}: ${r.reissue.reason}`);
			return { ok: true, reissue: r.reissue };
		}
		return { ok: false, http: r.http, json: { error: r.error, code: r.code, ...(r.invoiceId ? { invoiceId: r.invoiceId } : {}) } };
	}

	// ── the driver's Delivered ───────────────────────────────────────────────

	const OPEN_STATES = Object.freeze(["working", "queued", "waiting"]);
	let allowed = false;
	let started = false;
	let handOverNote = null;
	let lineBusy = false;
	let readChecking = false;
	let lastReadCheckMs = -Infinity;

	// The first half of start-up, before the app listens, so no record it finds belongs to
	// a request of this process. One transaction, the ledger only. Every `working` claim is
	// taken whatever its lease says, so a process outliving the restart can't commit a send.
	function startTrigger() {
		if (!triggerMode || started) return false;
		allowed = true;
		try {
			const nowMs = nowDate().getTime();
			const nowIso = iso(nowMs);
			handOverNote = db.transaction(() => {
				const first = !ledger.getMeta(db).trigger_on_at;
				const people = {};
				for (const c of ledger.listClaims(db, OPEN_STATES)) {
					const plan = trigger.startUpAction(c, { first, nowMs });
					if (plan.action === "none") continue;
					// Queued again with no tap and no press, so it looks first, as a press does:
					// the load may have been billed from Gmail since.
					const patch = plan.action === "person"
						? { state: "needs_attention", reason_code: plan.code, stage: keptStage(c), lease_owner: "", lease_until: "" }
						: plan.action === "recover"
							? { state: "working", lease_owner: "", lease_until: iso(0) }
							: { state: "queued", reason_code: "", next_attempt_at: nowIso, look_first: nowIso, lease_owner: "", lease_until: "" };
					const n = ledger.transition(db, c.load_key, { from: [c.state], nowIso, patch });
					if (n && plan.action === "person") people[plan.code] = (people[plan.code] || 0) + 1;
				}
				if (first) ledger.setMeta(db, "trigger_on_at", nowIso);
				return first ? { people } : null;
			}).immediate();
			started = true;
			return true;
		} catch (e) {
			d.log.error(`[auto-invoice] the driver's trigger did not start: ${codeOf(e)}`);
			return false;
		}
	}

	// The second half, once the app listens: what's left of the first start's notice, the
	// watching the sweep did at each tick, then every open record, finished once. A first
	// half that failed gets one more go here: its transaction left nothing behind.
	async function finishStartUp() {
		if (allowed && !started) startTrigger();
		if (!started) return;
		try {
			if (handOverNote) {
				const byCode = Object.entries(handOverNote.people);
				const people = byCode.reduce((sum, [, n]) => sum + n, 0);
				handOverNote = null;
				audit("auto_invoice_trigger_on", "", `only the driver's Delivered starts an invoice now; ${people} load${people === 1 ? "" : "s"} in line went to a person${people ? ` (${byCode.map(([code, n]) => `${code} ${n}`).join(", ")})` : ""}`);
				if (people) notify("Automatic invoices: loads to check", `Automatic invoices now start only from the driver's Delivered. ${people} load${people === 1 ? " was" : "s were"} in line, so ${people === 1 ? "it is" : "they are"} marked Needs attention on Completed Loads.`);
			}
			pruneDaily();
			await ensureBaseline();
		} catch (e) {
			d.log.error(`[auto-invoice] start-up: ${codeOf(e)}`);
		}
		await runLine();
	}

	// A database with no baseline yet (never production's): the old completed loads are
	// left to people, so none of them reads "No automatic invoice".
	async function ensureBaseline() {
		if (ledger.getMeta(db).baseline_at) return;
		const snap = await snapshot();
		if (!ledger.getMeta(db).baseline_at) writeBaseline(snap, iso(nowDate().getTime()));
	}

	// Right before a status write goes to the sheet: { written(), writeFailed(e) } for the
	// route, inert unless this tap arms the invoice. The record comes first: the run's own
	// check refuses a record with no Delivered, while a Delivered with no record is lost.
	function driverDelivered({ role, loadId, oldStatus, newStatus, readBack = null } = {}) {
		if (!started) return NO_START;
		try {
			const key = rules.loadKey(loadId);
			if (!key || key.length > LOAD_KEY_MAX) return NO_START;
			const claim = ledger.getClaim(db, key);
			if (!trigger.arms({ role, oldStatus, newStatus, claim })) return NO_START;
			const nowIso = iso(nowDate().getTime());
			// A tap on a claim that had stopped looks first, as a press does: the load may have
			// been billed from Gmail since. A first tap has no such past, and asks for none.
			const armed = claim
				? ledger.transition(db, key, { from: ["waiting"], nowIso, patch: { reason_code: "DRIVER_PENDING", look_first: nowIso } })
				: ledger.insertClaim(db, { key, loadId, state: "waiting", code: "DRIVER_PENDING", nowIso });
			if (!armed) return NO_START;
			return {
				written: () => queueTapped(key),
				// A write that reports failure may still have landed (no retry, and its
				// answer can be lost), so the route answers as it always did and the row is
				// read back after that.
				writeFailed: (e) => {
					setImmediate(() => { settleFailedWrite(key, readBack); });
					throw e;
				},
			};
		} catch (e) {
			d.log.error(`[auto-invoice] the driver's Delivered wasn't recorded: ${codeOf(e)}`);
			return NO_START;
		}
	}

	// The status is on the sheet: the record moves to the line, whatever code it holds,
	// and the run starts after the route has answered. Nothing here may throw into the route.
	function queueTapped(key) {
		try {
			const nowIso = iso(nowDate().getTime());
			ledger.transition(db, key, { from: ["waiting"], nowIso, patch: { state: "queued", reason_code: "", next_attempt_at: nowIso } });
		} catch (e) {
			d.log.error(`[auto-invoice] load ${key}: the run wasn't queued: ${codeOf(e)}`);
		}
		wake();
	}

	// Reads Delivered: it landed, so the invoice goes on. Reads anything else: the tap
	// didn't take, and a later tap arms it. Can't be read: the record stays for a later tap
	// or the next start-up, and the row shows "No automatic invoice" meanwhile.
	async function settleFailedWrite(key, readBack) {
		try {
			const read = typeof readBack === "function" ? await readBack() : null;
			if (read === null || read === undefined) return;
			if (rules.isCompletedStatus(read)) {
				d.invalidateJobTracking();
				queueTapped(key);
				return;
			}
			ledger.transition(db, key, { from: ["waiting"], nowIso: iso(nowDate().getTime()), patch: { reason_code: "NOT_COMPLETED" } });
		} catch (e) {
			d.log.error(`[auto-invoice] load ${key}: the read after a failed write: ${codeOf(e)}`);
		}
	}

	const wake = () => {
		if (started) setImmediate(() => { runLine(); });
	};

	// The one line: one run at a time, until no claim is due. Never rejects. A wake during
	// a run is picked up by this loop, which reads the ledger again after every run.
	async function runLine() {
		if (!started || lineBusy) return;
		lineBusy = true;
		try {
			noticeSettings(ledger.readSettings(db));
			const runs = new Map();
			while (await runNext(runs));
		} catch (e) {
			d.log.error(`[auto-invoice] the run line stopped: ${codeOf(e)}`);
		} finally {
			lineBusy = false;
		}
	}

	// Why a queued claim can't run now: with nothing to come back to it, a person takes it.
	function lineRefusal(mb, nowMs) {
		if (!mb.user || !mb.pass) return "NO_MAILBOX";
		if (paused(iso(nowMs))) return "MAILBOX_PAUSED";
		if (ledger.readSettings(db).unreadable) return "SETTINGS_UNREADABLE";
		return trigger.overCap({ lastHour: ledger.draftedSince(db, iso(nowMs - HOUR_MS)), lastDay: ledger.draftedSince(db, iso(nowMs - DAY_MS)), caps }) ? "CAP_REACHED" : null;
	}

	// One step of the line: a claim to search for or record (a person's Try again on one
	// that may be in Gmail, or a start-up's), else the next one due. false when none is.
	async function runNext(runs) {
		const nowMs = nowDate().getTime();
		const nowIso = iso(nowMs);
		const untilIso = iso(nowMs + LEASE_MS);
		const mb = d.mailbox() || {};
		const held = ledger.expiredWorking(db, nowIso)[0];
		if (held) {
			const token = newRunToken();
			if (!ledger.takeOver(db, held.load_key, token, { nowIso, untilIso })) return true;
			await inRun(held.load_key, token, () => {
				const c = ledger.getClaim(db, held.load_key);
				// Recording needs the confirmed domains, and saving the settings wakes nothing up.
				return ledger.readSettings(db).unreadable ? toPerson(c, "SETTINGS_UNREADABLE") : recoverOne(c, mb);
			});
			return true;
		}
		const next = ledger.nextQueued(db, nowIso);
		if (!next) return false;
		const count = (runs.get(next.load_key) || 0) + 1;
		runs.set(next.load_key, count);
		const refusal = count > RUNS_PER_LINE ? "RETRY_LATER" : lineRefusal(mb, nowMs);
		if (refusal) {
			ledger.transition(db, next.load_key, { from: ["queued"], nowIso, patch: { state: "needs_attention", reason_code: refusal, stage: keptStage(next), lease_owner: "", lease_until: "" } });
			return true;
		}
		const token = newRunToken();
		if (!ledger.lease(db, next.load_key, token, { nowIso, untilIso })) return true;
		await inRun(next.load_key, token, () => attempt(ledger.getClaim(db, next.load_key), mb));
		return true;
	}

	// One run under its own token, up to its limit, so a stuck run can't hold the line.
	// Past the limit its claim is closed and the token is dead: every later write of that
	// run names an owner the claim no longer has, so nothing it does can reach a send.
	function inRun(key, token, work) {
		return runOwner.run(token, async () => {
			let timer = null;
			const limit = new Promise((resolve) => { timer = d.setTimer(resolve, d.runLimitMs); });
			const running = Promise.resolve().then(work).catch((e) => {
				d.log.error(`[auto-invoice] load ${key}: the run failed: ${codeOf(e)}`);
			});
			try {
				await Promise.race([running, limit]);
			} finally {
				d.clearTimer(timer);
			}
			closeRun(key, token);
		});
	}

	// When a run ends, no claim it touched is left for a timer that doesn't exist. A claim
	// queued for now is the one exception: this line takes it next (RUNS_PER_LINE).
	function closeRun(key, token) {
		const c = ledger.getClaim(db, key);
		if (!c) return;
		const nowIso = iso(nowDate().getTime());
		if (c.state === "working" && c.lease_owner === token) toPerson(c, "DRAFT_FAILED");
		else if (c.state === "queued" && c.next_attempt_at > nowIso) {
			ledger.transition(db, key, { from: ["queued"], nowIso, patch: { state: "needs_attention", reason_code: c.reason_code || "DRAFT_FAILED", stage: keptStage(c), lease_owner: "", lease_until: "" } });
		}
	}

	// Before a person's Try again can send: this load's Payments Table row, then a live
	// search of the mailbox. The code that stops it, or null when both come back clean.
	async function lookBeforeSend(c, facts, mb) {
		const key = c.load_key;
		try {
			if (typeof d.readPaymentsTable !== "function") return "PAYMENTS_UNREAD";
			if (trigger.paymentsRowFilled(await d.readPaymentsTable(), key)) return "PAYMENTS_TABLE_HIT";
		} catch (e) {
			d.log.error(`[auto-invoice] load ${c.load_id}: the Payments Table wasn't read: ${codeOf(e)}`);
			return "PAYMENTS_UNREAD";
		}
		if (typeof d.lookInMailbox !== "function" || !mb.user || !mb.pass) return "MAILBOX_UNREAD";
		try {
			const refs = ledger.draftRefsFor(db, key);
			return trigger.mailboxVerdict(await d.lookInMailbox({
				user: mb.user,
				pass: mb.pass,
				loadNumber: facts.loadId || c.load_id,
				invoiceNumbers: [...new Set([...refs.invoiceNumbers, ...(c.invoice_id ? [c.invoice_id] : [])])],
				orderNumbers: refs.orderNumbers,
				// The send's last look: also by subject, for a message the web search hasn't indexed.
				lastCheck: true,
			}));
		} catch (e) {
			d.log.error(`[auto-invoice] load ${c.load_id}: the mailbox search failed at ${/^[a-z]{1,20}$/.test(String(e && e.stage)) ? e.stage : codeOf(e)}`);
			return "MAILBOX_UNREAD";
		}
	}

	// What the sweep watched, looked at when something asks: a change after a send or draft
	// (the stop included), and a person's draft closing an open claim. A claim drafted since
	// this check began is skipped: its snapshot can predate that tap. Never rejects.
	async function checkClaims(onlyKey = "") {
		try {
			const beganAt = iso(nowDate().getTime());
			const snap = await snapshot();
			const nowIso = iso(nowDate().getTime());
			const list = onlyKey ? [ledger.getClaim(db, onlyKey)].filter(Boolean) : ledger.listClaims(db);
			for (const c of list) {
				if (c.state === "baseline" || c.state === "skipped" || c.state === "working") continue;
				if (c.state === "drafted") {
					if (c.drafted_at < beganAt) checkChanged(c, factsOf(snap, c.load_key), nowIso);
					continue;
				}
				if (sendInFlight(c) && c.state !== "needs_attention") continue;
				if (ledger.otherDraftRows(db, c).length) skipDraftedByHand(c, nowIso);
			}
			if (!onlyKey) await ensureBaseline();
		} catch (e) {
			d.log.error(`[auto-invoice] the check of the claims failed: ${codeOf(e)}`);
		}
	}

	// Started by a Super Admin's dashboard read and not waited for: at most once a minute.
	// A claim still queued (the line stopped on a database error) gets its run here too.
	function readCheck() {
		const nowMs = nowDate().getTime();
		if (!started || readChecking || nowMs - lastReadCheckMs < d.readCheckMs) return;
		lastReadCheckMs = nowMs;
		readChecking = true;
		checkClaims().finally(() => {
			readChecking = false;
			wake();
		});
	}

	// A POD row added or deleted: that load is checked at once, after the route answers.
	function podChanged(loadId) {
		const key = rules.loadKey(loadId);
		if (started && key) setImmediate(() => { checkClaims(key); });
	}

	// ── routes (Super Admin only) ────────────────────────────────────────────

	function mount(app, { requireRole, refuseCrossSite = null, stopLimiter = null } = {}) {
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
			const check = recipientCheckState();
			res.json({ ...ledger.readSettings(db), ...(sending ? { send: sendState() } : {}), ...(check ? { recipientCheck: check } : {}) });
		});

		// Stop automatic sending: any Super Admin, set-only. Nothing here or in the
		// settings route clears it (writeSettings() writes app_settings, never the
		// stop); scripts/auto-invoice-send-resume.js does, on the server. Mounted
		// only while sending is on.
		if (sending) {
			const limited = typeof stopLimiter === "function" ? [stopLimiter] : [];
			app.post("/api/auto-invoice/send/stop", ...writeGuard, ...limited, (req, res) => {
				const user = (req.session && req.session.user) || {};
				const note = factoring.cleanReason(req.body && req.body.note);
				let set;
				try {
					set = ledger.setSendStop(db, { reason: "STOPPED_BY_ADMIN", nowIso: iso(nowDate().getTime()) });
				} catch {
					return res.status(503).json({ error: "The stop could not be saved; try again.", code: "SEND_STOP_FAILED" });
				}
				const stop = ledger.getSendStop(db);
				if (set) {
					d.logAudit(req, "auto_invoice_send_stopped", "auto_invoice", "send", `STOPPED_BY_ADMIN by ${user.username || "unknown"}${note ? `: ${note}` : ""}`);
					notify("Automatic invoice sending stopped", `${sendRules.STOP_WORDS.STOPPED_BY_ADMIN} Invoices are drafted in Gmail for a person to send until sending is resumed on the server.`);
				}
				res.json({ ok: true, already: !set, stopped: stop ? { at: stop.at, reason: stop.reason } : null });
			});
		}

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
			wake();
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
			if (triggerMode) {
				const refusal = trigger.retryRefusal(c, { savedInvoice: typeof d.savedInvoiceEvidence === "function" && d.savedInvoiceEvidence(key) === true });
				if (refusal) return res.status(409).json(refusal);
			}
			const nowIso = iso(nowDate().getTime());
			// With the driver's trigger, Try again is the only retry: it asks for the look
			// first, on the claim itself, so a restart between this press and the run can't
			// skip it.
			const look = triggerMode ? { look_first: nowIso } : {};
			// A draft that may already be in Gmail is looked for first (recovery),
			// never appended again blind. A number reserved over a day ago is
			// replaced on the next attempt (reserveNumber's staleBeforeIso).
			const patch = STAGES_BEFORE_APPEND.has(c.stage)
				? { state: "queued", reason_code: "", attempts: 0, ratecon_checks: 0, next_attempt_at: nowIso, ...look }
				: { state: "working", reason_code: "", attempts: 0, ratecon_checks: 0, lease_owner: "", lease_until: iso(0), ...look };
			const n = ledger.transition(db, key, { from: ["needs_attention"], nowIso, patch });
			if (!n) return res.status(409).json({ error: "The load changed; reload and try again.", code: "AUTO_INVOICE_NOT_ATTENTION" });
			d.logAudit(req, "auto_invoice_retry", "load", c.load_id, `try again (was: ${c.reason_code || "needs attention"})`);
			// The run starts now, likely seconds after a person's fix to the sheet: reading the
			// cached copy, it would save a fingerprint from before the fix and read a false change.
			if (triggerMode) d.invalidateJobTracking();
			res.json({ ok: true });
			wake();
		});
	}

	return { mode, shadowRenders, sending, triggerMode, workerId, sweep, work, recover, tick, annotateCompletedRows, status, mount, draftButtonCheck,
		startTrigger, finishStartUp, driverDelivered, podChanged, runLine, checkClaims };
}

module.exports = { create, AUTO_ACTOR, LEASE_MS };
