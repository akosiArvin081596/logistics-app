// What's behind each completed load's invoice status (lib/invoice-status.js): the app's own
// rows, read on each Super Admin dashboard read, and what the mailbox search saved.
//
// THE TABLE, invoice_status_evidence, holds counts, flags, times and a result, one row per
// load, and exists only once something writes it: with the mailbox pass off a deploy writes
// nothing. No address, subject, name or message text is stored, so scripts/refresh-env.js
// has nothing to scrub.
//
// THE MAILBOX PASS (INVOICE_MAILBOX_PASS_ENABLED, on only when exactly "true", never in a
// replica, and only with the status on): on its own timer behind startsJob(), so a Gmail
// stall can't touch the invoice path. At most 20 loads a run, one run every 10 minutes,
// never-searched loads first, newest first, then the ones due again (nextSearchAt()). One
// sheet read of the Payments Table per run. Read-only throughout. Any failure but a term
// that can't be searched ends the run; a login refusal or a throttle stops the pass for 6
// hours with one Super Admin notice, because this mailbox also sends invoices.
//
// SAVED EVIDENCE NEVER SENDS ANYTHING. Try again and the button search live, and a live
// answer refreshes the row (onAnswer below). A row can only refuse a send (savedInvoice()).
//
// Logs carry load IDs, stages and codes only.

"use strict";

const rules = require("./auto-invoice-rules");
const ledger = require("./auto-invoice-ledger");
const factoring = require("./factoring-store");
const appTime = require("./app-time");
const invoiceStatus = require("./invoice-status");
const mailboxSearch = require("./invoice-mailbox-search");

const TABLE = "invoice_status_evidence";
const PAUSE_KEY = "invoice_evidence.pause";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const RUN_EVERY_MS = 10 * MINUTE_MS;
const MAX_PER_RUN = 20;
const GAP_MS = 1000;
const PAUSE_MS = 6 * HOUR_MS;
// A load this recently delivered is looked at daily while it's in doubt, then weekly.
const RECENT_MS = 30 * DAY_MS;
const STAGES_BEFORE_APPEND = new Set(["", "reserved", "rendered"]);

// The Payments Table's three columns no code writes. Only filled or blank is ever kept.
const PAYMENTS_ID_HEADER = "job id";
const PAYMENTS_FLAGS = Object.freeze({
	payments_invoice_number: "invoice number",
	payments_payment_date: "payment date",
	payments_status: "payment status",
});
const PAYMENTS_FLAG_NAMES = Object.freeze(Object.keys(PAYMENTS_FLAGS));

function passEnabled(env = {}) {
	return String(env?.INVOICE_MAILBOX_PASS_ENABLED ?? "").trim() === "true";
}

const isoOf = (ms) => new Date(ms).toISOString();
const count = (v) => {
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : 0;
};
const codeOf = (e) => {
	const c = e && e.code;
	return (typeof c === "string" || typeof c === "number") && /^[A-Za-z0-9_]{1,40}$/.test(String(c)) ? String(c) : "ERROR";
};

// ── the table ────────────────────────────────────────────────────────────────

function ensureSchema(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${TABLE} (
			load_key TEXT PRIMARY KEY,
			drafts_invoice INTEGER NOT NULL DEFAULT 0,
			drafts_mention INTEGER NOT NULL DEFAULT 0,
			sent_invoice INTEGER NOT NULL DEFAULT 0,
			sent_mention INTEGER NOT NULL DEFAULT 0,
			first_sent_at TEXT NOT NULL DEFAULT '',
			searched_at TEXT NOT NULL DEFAULT '',
			tried_at TEXT NOT NULL DEFAULT '',
			result TEXT NOT NULL DEFAULT '' CHECK (result IN ('', 'answered', 'failed')),
			payments_checked_at TEXT NOT NULL DEFAULT '',
			payments_invoice_number INTEGER NOT NULL DEFAULT 0,
			payments_payment_date INTEGER NOT NULL DEFAULT 0,
			payments_status INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		)
	`);
}

// factoring.hasTable() counts a view too, so one that can't be read throws rather than
// reading as no rows.
const has = (db, name) => factoring.hasTable(db, name);

function savedRow(db, key) {
	if (!has(db, TABLE)) return null;
	return db.prepare(`SELECT * FROM ${TABLE} WHERE load_key = ?`).get(key) || null;
}

function patchRow(db, key, patch, nowIso) {
	ensureSchema(db);
	const names = Object.keys(patch);
	db.transaction(() => {
		db.prepare(`INSERT OR IGNORE INTO ${TABLE} (load_key, updated_at) VALUES (?, ?)`).run(key, nowIso);
		db.prepare(`UPDATE ${TABLE} SET ${names.map((n) => `${n} = ?`).join(", ")}, updated_at = ? WHERE load_key = ?`)
			.run(...names.map((n) => patch[n]), nowIso, key);
	})();
}

// A search's answer as the table's counts, or null when it can't be read: doubt is never
// read as "nothing there". Hits past the cap were never read, and an invoice in Trash went
// somewhere, so both count as doubt. So does a verdict of doubt with no counts behind it.
function readAnswer(answer) {
	const verdict = answer && answer.verdict;
	const boxes = answer && answer.mailboxes;
	if (![mailboxSearch.KIND.INVOICE, mailboxSearch.KIND.MENTION, mailboxSearch.CLEAN].includes(verdict)) return null;
	if (!boxes || !boxes.drafts || !boxes.sent) return null;
	const doubt = (box) => count(box.mention) + count(box.overCap);
	const trash = boxes.trash ? count(boxes.trash.invoice) + doubt(boxes.trash) : 0;
	const read = {
		draftsInvoice: count(boxes.drafts.invoice),
		draftsMention: doubt(boxes.drafts),
		sentInvoice: count(boxes.sent.invoice),
		sentMention: doubt(boxes.sent) + trash,
	};
	if (verdict !== mailboxSearch.CLEAN && !read.draftsInvoice && !read.draftsMention && !read.sentInvoice && !read.sentMention) read.sentMention = 1;
	const first = Date.parse(String(boxes.sent.firstInvoiceDate || ""));
	read.firstSentAt = Number.isFinite(first) ? isoOf(first) : "";
	return read;
}

// An invoice once seen in Sent Mail stays seen: a copy deleted later doesn't unbill the load.
// Drafts and mentions are as of this search, since a draft can be sent or deleted.
function saveAnswer(db, key, answer, { nowIso, paymentsAt = "" } = {}) {
	const read = readAnswer(answer);
	if (!read) {
		saveFailure(db, key, { nowIso });
		return;
	}
	const before = savedRow(db, key) || {};
	const firsts = [before.first_sent_at, read.firstSentAt].filter(Boolean).sort();
	patchRow(db, key, {
		drafts_invoice: read.draftsInvoice,
		drafts_mention: read.draftsMention,
		sent_invoice: Math.max(count(before.sent_invoice), read.sentInvoice),
		sent_mention: read.sentMention,
		first_sent_at: firsts[0] || "",
		searched_at: nowIso,
		tried_at: nowIso,
		result: "answered",
		...(paymentsAt ? { payments_checked_at: paymentsAt } : {}),
	}, nowIso);
}

// What an earlier answer found stays: only this attempt failed.
function saveFailure(db, key, { nowIso } = {}) {
	patchRow(db, key, { result: "failed", tried_at: nowIso }, nowIso);
}

function savePayments(db, key, flags, { nowIso } = {}) {
	const patch = { payments_checked_at: nowIso };
	for (const name of PAYMENTS_FLAG_NAMES) patch[name] = flags && flags[name] ? 1 : 0;
	patchRow(db, key, patch, nowIso);
}

const holdsInvoice = (saved) => Boolean(saved) && (count(saved.sent_invoice) > 0 || count(saved.drafts_invoice) > 0 || PAYMENTS_FLAG_NAMES.some((n) => count(saved[n]) > 0));

// Does saved evidence show an invoice for this load, so a person's Try again must not send?
// A claim past the build can only be searched for, never sent, so it isn't refused. false
// when nothing can be read: the run's own live look still guards the send.
function savedInvoice(db, key) {
	try {
		if (!holdsInvoice(savedRow(db, key))) return false;
		const claim = has(db, ledger.CLAIMS) ? ledger.getClaim(db, key) : null;
		return !claim || STAGES_BEFORE_APPEND.has(claim.stage);
	} catch {
		return false;
	}
}

// ── the Payments Table ───────────────────────────────────────────────────────

// The tab, header row first, as a Map of load key to its three flags. A row names the load
// by " Job ID", and any row filled counts. Columns that can't be found throw: doubt is
// never read as "nothing there". The values go no further than this function.
function paymentsIndex(values) {
	const [headers, ...rows] = Array.isArray(values) ? values : [];
	const names = (headers || []).map((h) => String(h ?? "").trim().toLowerCase());
	const idCol = names.indexOf(PAYMENTS_ID_HEADER);
	const cols = PAYMENTS_FLAG_NAMES.map((name) => [name, names.indexOf(PAYMENTS_FLAGS[name])]);
	if (idCol < 0 || cols.some(([, at]) => at < 0)) throw Object.assign(new Error("the Payments Table's columns were not found"), { code: "PAYMENTS_TABLE_SHAPE" });
	const index = new Map();
	for (const row of rows) {
		const key = rules.loadKey((row || [])[idCol]);
		if (!key) continue;
		const flags = index.get(key) || Object.fromEntries(PAYMENTS_FLAG_NAMES.map((n) => [n, 0]));
		for (const [name, at] of cols) {
			if (String((row || [])[at] ?? "").trim() !== "") flags[name] = 1;
		}
		index.set(key, flags);
	}
	return index;
}

// ── the re-search rules ──────────────────────────────────────────────────────

// When the pass may search a load next: epoch ms (0: it never was), or null: never again,
// or not while the job is on it.
function nextSearchAt({ read, saved, deliveredDay = "", nowMs } = {}) {
	const { SENT, FACTORED, WAITING, NONE_FOUND, BY_HAND } = invoiceStatus.STATUS;
	const status = read && read.status;
	if (status === SENT || status === FACTORED || status === WAITING) return null;
	if (saved && count(saved.sent_invoice) > 0) return null;
	// Answered, yet read as not searched: a draft was made after that answer, which says nothing
	// about it. The person who made it is looking at this status now, not in a day or a week.
	if (read && read.sentUnchecked === true && saved && saved.result === "answered") return 0;
	const tried = Date.parse(String((saved && saved.tried_at) || ""));
	if (!Number.isFinite(tried)) return 0;
	if (status === NONE_FOUND || read.code === "BISON_ORDER_NUMBER" || (status === BY_HAND && read.found === invoiceStatus.FOUND.PAYMENTS)) return tried + WEEK_MS;
	const delivered = /^\d{4}-\d{2}-\d{2}$/.test(deliveredDay) ? Date.parse(`${deliveredDay}T12:00:00Z`) : NaN;
	return tried + (Number.isFinite(delivered) && nowMs - delivered <= RECENT_MS ? DAY_MS : WEEK_MS);
}

// ── the store ────────────────────────────────────────────────────────────────

// deps: db, env, replica, mailbox() { user, pass }, readCompletedLoads() { headers, rows }
// live rows from the cached Job Tracking, never mutated here; readPaymentsTable() the tab
// with its header row first; closedMonthsOf(headers, row); dayKeyOf(cell); sweepOn() the
// job's sweep is running; notify({ title, body }) the Super Admin-only notice; log.
// Optional: now(), search(opts), gapMs, setInterval, timeZone.
function create(deps = {}) {
	const d = {
		log: console,
		now: () => new Date(),
		timeZone: appTime.appTimeZone(),
		gapMs: GAP_MS,
		closedMonthsOf: () => null,
		dayKeyOf: () => "",
		sweepOn: () => false,
		notify: () => {},
		mailbox: () => ({ user: "", pass: "" }),
		setInterval: (fn, ms) => setInterval(fn, ms),
		...deps,
	};
	const db = d.db;
	const statusOn = invoiceStatus.statusEnabled(d.env || {});
	const passOn = statusOn && passEnabled(d.env || {}) && d.replica !== true;
	const search = d.search || mailboxSearch.searchMailboxForLoad;
	const nowMs = () => d.now().getTime();
	const said = new Set();
	const logOnce = (key, msg) => {
		if (said.has(key)) return;
		said.add(key);
		d.log.warn(`[invoice-status] ${msg}`);
	};
	const dayOf = (iso) => {
		const at = new Date(iso);
		return Number.isNaN(at.getTime()) ? "" : appTime.dayInZone(at, d.timeZone);
	};

	// A live answer (Try again, the button) refreshes the saved row. It can't fail the search.
	mailboxSearch.onAnswer(statusOn && d.replica !== true ? (loadNumber, answer) => {
		const key = rules.loadKey(loadNumber);
		if (!key) return;
		try {
			saveAnswer(db, key, answer, { nowIso: isoOf(nowMs()) });
		} catch (e) {
			d.log.error(`[invoice-status] load ${key}: a live answer wasn't saved: ${codeOf(e)}`);
		}
	} : null);

	// Everything the rule reads for free, once per call. Throws when any of it can't be read,
	// except the factoring marker, which is the rule's own first question.
	function readState() {
		let factored = null;
		try {
			factored = factoring.factoredKeys(db);
		} catch {
			factored = null;
		}
		const nowIso = isoOf(nowMs());
		const claims = new Map(has(db, ledger.CLAIMS) ? ledger.listClaims(db).map((c) => [c.load_key, c]) : []);
		const rows = new Map();
		if (has(db, "load_invoice_drafts")) {
			for (const r of db.prepare("SELECT id, load_id, invoice_id, order_number, via, created_at FROM load_invoice_drafts ORDER BY id").all()) {
				const key = rules.loadKey(r.load_id);
				if (!key) continue;
				if (!rows.has(key)) rows.set(key, []);
				rows.get(key).push(r);
			}
		}
		const presses = new Map();
		if (has(db, factoring.INFLIGHT)) {
			for (const { load_key: key } of db.prepare(`SELECT DISTINCT load_key FROM ${factoring.INFLIGHT}`).all()) presses.set(key, factoring.inflightRows(db, key, nowIso));
		}
		const triumphDone = new Set(has(db, factoring.TRIUMPH)
			? db.prepare(`SELECT load_key FROM ${factoring.TRIUMPH} WHERE state IN ('submitted', 'closed_outside')`).all().map((r) => r.load_key)
			: []);
		const saved = new Map(has(db, TABLE) ? db.prepare(`SELECT * FROM ${TABLE}`).all().map((r) => [r.load_key, r]) : []);
		return { factored, claims, rows, presses, triumphDone, saved };
	}

	function statusFrom(state, row, cols, headers) {
		const key = rules.loadKey(row[cols.loadIdCol]);
		return invoiceStatus.statusOf({
			claim: state.claims.get(key) || null,
			rows: state.rows.get(key) || [],
			presses: state.presses.get(key) || [],
			factored: state.factored === null ? null : state.factored.has(key),
			triumphDone: state.triumphDone.has(key),
			saved: state.saved.get(key) || null,
			isBison: rules.isBisonEmail(row[cols.emailCol]),
			closedMonth: () => {
				const months = d.closedMonthsOf(headers, row);
				return !Array.isArray(months) || months.length > 0;
			},
			sweepOn: d.sweepOn() === true,
			passOn,
			dayOf,
		});
	}

	const UNREADABLE = Object.freeze({ status: invoiceStatus.STATUS.UNKNOWN, code: "EVIDENCE_UNREADABLE" });

	function readStateOrNull() {
		try {
			return readState();
		} catch (e) {
			logOnce("read", `the invoice statuses could not be read: ${codeOf(e)}`);
			return null;
		}
	}

	// `_invoiceStatus` on completed rows as served to a Super Admin: codes, numbers and a
	// day; the client words them. Call it on request-local rows. Never throws.
	function annotateCompletedRows({ rows, headers, isSuperAdmin } = {}) {
		if (!statusOn || isSuperAdmin !== true || !Array.isArray(rows) || !rows.length) return rows;
		const state = readStateOrNull();
		const cols = rules.jobColumns(headers || []);
		for (const row of rows) {
			row._invoiceStatus = state ? statusFrom(state, row, cols, headers) : { ...UNREADABLE };
			// What Try again would do, as its route would answer: refused, while a load whose
			// Try again could send has saved evidence of an invoice.
			const chip = row._autoInvoice;
			if (state && chip && (chip.retry === "send" || chip.retry === "draft") && holdsInvoice(state.saved.get(rules.loadKey(row[cols.loadIdCol])))) chip.retry = "none";
		}
		return rows;
	}

	// The Completed Loads CSV's three more columns, or null with the status off. Rows are read,
	// never changed: they are the cached Job Tracking's own.
	function exportColumns({ headers } = {}) {
		if (!statusOn) return null;
		const state = readStateOrNull();
		const cols = rules.jobColumns(headers || []);
		return {
			headers: ["Invoice Status", "Invoice #", "Invoice Date"],
			cells: (row) => invoiceStatus.exportCells(state ? statusFrom(state, row, cols, headers) : UNREADABLE),
		};
	}

	// ── the stop ─────────────────────────────────────────────────────────────

	function readPause() {
		if (!has(db, "app_settings")) return null;
		const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(PAUSE_KEY);
		if (!row) return null;
		try {
			const pause = JSON.parse(row.value);
			return pause && typeof pause === "object" ? pause : null;
		} catch {
			return null;
		}
	}

	function writePause(pause, nowIso) {
		db.prepare(`INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
			.run(PAUSE_KEY, JSON.stringify(pause), nowIso, "invoice-evidence");
	}

	function clearPause() {
		if (has(db, "app_settings")) db.prepare("DELETE FROM app_settings WHERE key = ?").run(PAUSE_KEY);
	}

	// One notice for one spell of refusals: it comes again only after a search has worked.
	function stopPass(err) {
		const atMs = nowMs();
		const why = err.throttled ? "THROTTLED" : "LOGIN_REFUSED";
		const before = readPause();
		writePause({ until: isoOf(atMs + PAUSE_MS), why, noticed: true }, isoOf(atMs));
		d.log.warn(`[invoice-status] the mailbox pass stopped for 6 hours: ${why}`);
		if (before && before.noticed) return;
		try {
			d.notify({
				title: "Invoice statuses: mailbox search stopped",
				body: `${why === "THROTTLED" ? "Gmail asked this mailbox to slow down" : "Gmail refused the mailbox's login"}, so the search behind the invoice statuses stopped for 6 hours. Statuses keep what was already found. If it lasts, ask the mailbox owner to check it.`,
			});
		} catch (e) {
			d.log.error(`[invoice-status] notice failed: ${codeOf(e)}`);
		}
	}

	// ── the pass ─────────────────────────────────────────────────────────────

	// The loads to search this run: never searched, newest first; then the ones due again,
	// the longest waiting first.
	function dueLoads({ rows, headers, state, atMs }) {
		const cols = rules.jobColumns(headers || []);
		const seen = new Set();
		const never = [];
		const again = [];
		for (const row of rows || []) {
			if (!rules.isCompletedStatus(row[cols.statusCol])) continue;
			const key = rules.loadKey(row[cols.loadIdCol]);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			const saved = state.saved.get(key) || null;
			const deliveredDay = d.dayKeyOf(row[cols.completionCol]) || d.dayKeyOf(row[cols.deliveryDateCol]) || "";
			const at = nextSearchAt({ read: statusFrom(state, row, cols, headers), saved, deliveredDay, nowMs: atMs });
			if (at === null || at > atMs) continue;
			const load = { key, loadId: String(row[cols.loadIdCol]).trim(), deliveredDay, triedAt: saved ? saved.tried_at : "" };
			(at === 0 ? never : again).push(load);
		}
		never.sort((a, b) => (a.deliveredDay === b.deliveredDay ? (a.key < b.key ? -1 : 1) : a.deliveredDay < b.deliveredDay ? 1 : -1));
		again.sort((a, b) => (a.triedAt < b.triedAt ? -1 : a.triedAt > b.triedAt ? 1 : 0));
		return [...never, ...again].slice(0, MAX_PER_RUN);
	}

	// Any cell filled or cleared since the last read, on every completed load, and a row that
	// has never had the table read for it. A run that changes nothing writes nothing.
	function applyPayments({ index, rows, headers, nowIso }) {
		const cols = rules.jobColumns(headers || []);
		const blank = Object.fromEntries(PAYMENTS_FLAG_NAMES.map((n) => [n, 0]));
		const seen = new Set();
		for (const row of rows || []) {
			if (!rules.isCompletedStatus(row[cols.statusCol])) continue;
			const key = rules.loadKey(row[cols.loadIdCol]);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			const flags = index.get(key) || blank;
			const saved = savedRow(db, key);
			const differs = saved
				? !saved.payments_checked_at || PAYMENTS_FLAG_NAMES.some((n) => count(saved[n]) !== flags[n])
				: PAYMENTS_FLAG_NAMES.some((n) => flags[n]);
			if (differs) savePayments(db, key, flags, { nowIso });
		}
	}

	let running = false;

	async function runOnce() {
		if (!passOn) return { ran: false, why: "OFF" };
		if (running) return { ran: false, why: "RUNNING" };
		const mb = d.mailbox() || {};
		if (!mb.user || !mb.pass) {
			logOnce("mailbox", "the mailbox pass has no mailbox, so it doesn't run");
			return { ran: false, why: "NO_MAILBOX" };
		}
		const pause = readPause();
		if (pause && Date.parse(String(pause.until || "")) > nowMs()) return { ran: false, why: "PAUSED" };
		running = true;
		const out = { ran: true, searched: 0, failed: 0, stoppedAt: "", payments: false };
		try {
			const { headers, rows } = await d.readCompletedLoads();
			ensureSchema(db);
			let paymentsAt = "";
			try {
				const index = paymentsIndex(await d.readPaymentsTable());
				paymentsAt = isoOf(nowMs());
				out.payments = true;
				applyPayments({ index, rows, headers, nowIso: paymentsAt });
			} catch (e) {
				d.log.error(`[invoice-status] the Payments Table wasn't read: ${codeOf(e)}`);
			}
			const state = readState();
			const due = dueLoads({ rows, headers, state, atMs: nowMs() });
			for (let i = 0; i < due.length; i++) {
				const load = due[i];
				const refs = state.rows.get(load.key) || [];
				const claim = state.claims.get(load.key);
				const held = claim && claim.invoice_id && !claim.number_voided_at ? [claim.invoice_id] : [];
				try {
					const answer = await search({
						user: mb.user,
						pass: mb.pass,
						loadNumber: load.loadId,
						invoiceNumbers: [...new Set([...refs.map((r) => r.invoice_id).filter(Boolean), ...held])],
						orderNumbers: [...new Set(refs.map((r) => r.order_number).filter(Boolean))],
						quiet: true,
					});
					saveAnswer(db, load.key, answer, { nowIso: isoOf(nowMs()), paymentsAt });
					out.searched++;
					clearPause();
				} catch (e) {
					out.failed++;
					saveFailure(db, load.key, { nowIso: isoOf(nowMs()) });
					const stage = e && e.stage ? String(e.stage) : "";
					d.log.error(`[invoice-status] load ${load.key}: the mailbox search failed at ${/^[a-z]{1,20}$/.test(stage) ? stage : codeOf(e)}`);
					// A term that can't be searched touched no mailbox.
					if (stage === "terms") continue;
					out.stoppedAt = stage || "search";
					if ((stage === "login" && e.answered) || e.throttled) {
						stopPass(e);
						out.paused = true;
					}
					break;
				}
				if (d.gapMs > 0 && i < due.length - 1) await new Promise((resolve) => setTimeout(resolve, d.gapMs));
			}
		} catch (e) {
			out.stoppedAt = out.stoppedAt || "read";
			d.log.error(`[invoice-status] the mailbox pass stopped: ${codeOf(e)}`);
		} finally {
			running = false;
		}
		return out;
	}

	let timer = null;
	function start() {
		if (!passOn || timer !== null) return false;
		timer = d.setInterval(() => {
			runOnce().catch((e) => d.log.error(`[invoice-status] the mailbox pass stopped: ${codeOf(e)}`));
		}, RUN_EVERY_MS);
		return true;
	}

	return { statusOn, passOn, annotateCompletedRows, exportColumns, runOnce, start };
}

module.exports = {
	TABLE,
	RUN_EVERY_MS,
	MAX_PER_RUN,
	PAUSE_MS,
	passEnabled,
	ensureSchema,
	savedRow,
	saveAnswer,
	saveFailure,
	savePayments,
	savedInvoice,
	paymentsIndex,
	nextSearchAt,
	create,
};
