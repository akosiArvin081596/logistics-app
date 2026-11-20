// Factored loads sent to Triumph by SFTP: the submit job (plan T, PR T2).
//
// One claim per load (lib/triumph-ledger.js). A claim starts only as the email invoice
// starts: a driver's own Delivered on a load marked factored (deliveredByDriver()), or a
// listed account's Start for a marked load nothing has started (start()). work() takes
// the queued claims one at a time, and each goes through, in order:
//   1. the free checks (lib/triumph-rules.js freeVerdict()), DTR_NAME's own rules among
//      them, so no number is reserved for a load that can't go;
//   2. the invoice engine's prepare(), mode "auto", the automatic job's gates as they are;
//   3. the invoice number, once per claim, in one immediate transaction;
//   4. the engine's render(), which prints Triumph's assignment block on a factored load;
//   5. the batch (lib/triumph-batch.js): one merged PDF and its CSV, rule 7's exact-value
//      check on every value the app composes (the invoice page's text too), the size rule,
//      and the CSV's values found printed in the merged PDF; with TRIUMPH_BATCH_DEDUPE_ENABLED
//      on, each identical BOL or POD goes in once, and with TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED
//      on, a batch over the limit has its BOL and POD photos re-compressed at the same size; the
//      record and audit rows say so, and a batch the photo steps leave over the limit gets an
//      audit row of its own;
//   6. the files under the batch folder (0700, files 0600): stage built.
// Dry mode stops there: the claim is staged and nothing connects. Live mode connects, takes
// the lock point (lockForUpload()), puts the PDF and then the CSV, each with its remote size
// checked, then records the submission: a load_invoice_drafts row via 'triumph' and the
// audit rows. A staged batch goes out only by a person's "Submit now" once the mode reads
// live, after every check again, through the same lock. A press that stops before the lock,
// by a refusal, an exception or a restart, leaves it staged; one that stops after goes to a
// person. Neither goes back in line, so nothing sends that batch by itself.
//
// Retries: 15 min, 1 h, 4 h, then Needs attention SUBMIT_FAILED. A refused login pauses
// submitting (1 h, doubling to 6 h); a host key that doesn't match, or a CSV whose upload
// broke after a byte may have gone (MAYBE_SUBMITTED, never sent again), pauses it until
// scripts/triumph-submit-resume.js runs. Each with one notice. No new render on a Friday
// evening (the weekly invoice batch's window). Caps: one in flight, 2 a run, 12 an hour,
// 60 a day (TRIUMPH_MAX_PER_HOUR, TRIUMPH_MAX_PER_DAY).
// Notices: a load changed after its submission; once a day, the factored loads delivered
// over 48 hours ago that haven't gone; once a day, 14 days live with no submission.
// With TRIUMPH_STOP_RECORD_ENABLED on (lib/triumph-rules.js stopRecordEnabled()), a run that
// moves a claim to Needs attention on a path that writes no row of its own writes one
// triumph_stopped row and one notice, and a batch over the size limit keeps its size and the
// limit on the claim until Try again. Every open pane follows by itself: a step that moves a
// claim's state, code, stage or attempts sends one dashboard:changed (`changed`).
//
// The mode is lib/triumph-rules.js submitMode(), its one reader: off (no claim, no table,
// no timer; the wiring starts nothing), dry or live. A replica reads off.
// Logs carry load IDs, states and codes only: never a host, user, key path, debtor name,
// amount or a file's contents.
//
// A Process with Triumph claim (lib/triumph-process.js; number_source "chr_invoice") goes the
// same way with the invoice the automatic job already sent the broker:
//   - after prepare() and before the number, a second look at the rate con that fails closed:
//     an advance read or DVIR decision recorded since the press, a DVIR line, a text that can't
//     be read whole, advance labels on it or on another candidate, or no C.H. Robinson name
//     stops it (RATECON_UNREAD, DVIR_LINES, ADVANCE_ON_RATECON);
//   - the number is that invoice's own (reserveNumber() never mints one for it);
//   - after render(), the page must be that invoice: the same total, no hold field changed
//     since the send, the same PO and recipient domain (else INVOICE_CHANGED);
//   - right before the lock point, its age and the payment date are read again;
//   - the record writes no second draft row: the broker invoice's row is the claim's own.
// Nothing on that path voids its number. build() is shared with the practice run (rehearse()).

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const rules = require("./triumph-rules");
const ledger = require("./triumph-ledger");
const triumphBatch = require("./triumph-batch");
const recompressLib = require("./triumph-batch-recompress");
const factoring = require("./factoring-store");
const autoRules = require("./auto-invoice-rules");
const autoLedger = require("./auto-invoice-ledger");
const brokerInvoice = require("./broker-invoice");
const appTime = require("./app-time");
const processRules = require("./triumph-process");
const rateconDvir = require("./ratecon-dvir");
const rateconAdvanceRead = require("./ratecon-advance-read");
const { shownText, shownTextRead } = require("./pdf-shown-text");

const TRIUMPH_ACTOR = Object.freeze({ id: 0, username: "triumph", role: "system" });
const TRIUMPH_REQ = Object.freeze({ session: Object.freeze({ user: TRIUMPH_ACTOR }) });
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Longer than an attempt takes: the sheet, Drive, Gemini, the render, the merge and the upload.
const LEASE_MS = 15 * MINUTE_MS;
const ENGINE_TIMEOUT_MS = 4 * MINUTE_MS;
const SHORT_WAIT_MS = 5 * MINUTE_MS;
const WAITING_TOO_LONG_MS = 48 * HOUR_MS;
const KEEP_ALIVE_MS = 14 * DAY_MS;
const KEEP_FILES_MS = 30 * DAY_MS;
const LOAD_KEY_MAX = 100;
const TICK_MS = 5 * MINUTE_MS;
const FIRST_TICK_MS = 30 * 1000;
const UPLOAD_STAGES = new Set(["pdf_uploading", "pdf_uploaded"]);
// A person's "Submit now" run: leaseStaged() marks its claim, and the mark stays until the run
// lets the claim go.
const pressed = (c) => Boolean(c) && c.reason_code === ledger.SUBMIT_NOW;
// The deny list's reader caps what it reads, so a long page is read in overlapping windows.
const DENY_WINDOW = 3500;
const DENY_OVERLAP = 500;
const INVOICE_PAGE = "invoice-page.pdf";
const NO_START = Object.freeze({ written() {}, writeFailed(e) { throw e; } });
// The rate con's text read within the extract route's own cap (server.js RATECON_DVIR_TEXT_MAX_BYTES).
const RATECON_TEXT_MAX_BYTES = 4 * 1024 * 1024;
// At most this many other rate-con candidates are read for advance labels.
const OTHER_CANDIDATES_MAX = 5;

const iso = (ms) => new Date(ms).toISOString();
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// An error as a log may show it: its code, never its message.
function codeOf(e) {
	const c = e && e.code;
	return (typeof c === "string" || typeof c === "number") && /^[A-Za-z0-9_]{1,40}$/.test(String(c)) ? String(c) : "ERROR";
}

function withTimeout(promise, ms) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(Object.assign(new Error("engine call timed out"), { code: "ENGINE_TIMEOUT" })), ms);
	});
	return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// The engine's refusals that are this job's own: the assignment block or the marker.
const ATTENTION_CODES = new Set(["NOA_UNCONFIGURED", "FACTORING_UNREADABLE", "ASSIGNMENT_NOT_PRINTABLE", "FACTORING_CHANGED", "RATECON_MISSING"]);

// What an audit row adds for the copies a batch left out (its files record's `dropped`):
// counts only, and nothing when none was.
function sentOnceWords(dropped) {
	const list = Array.isArray(dropped) ? dropped : [];
	if (!list.length) return "";
	const bytes = list.reduce((sum, x) => sum + (Number(x && x.bytes) || 0), 0);
	return `; ${list.length} identical document${list.length === 1 ? "" : "s"} sent once (${bytes} bytes)`;
}

// The photos a batch re-compressed, from its parts' records: the images, the step, and the sums of
// the touched parts' bytes before and after. Counts only; null when none was.
function photoCounts(records) {
	const done = (Array.isArray(records) ? records : []).filter((r) => r && Number(r.images) > 0);
	if (!done.length) return null;
	const sum = (k) => done.reduce((s, r) => s + (Number(r[k]) || 0), 0);
	return { images: sum("images"), quality: Number(done[0].quality), bytesBefore: sum("bytesBefore"), bytesAfter: sum("bytesAfter") };
}

// What an audit row adds for a batch whose photos were re-compressed (its files record's parts):
// counts only, and nothing when none was.
function recompressWords(parts) {
	const c = photoCounts((Array.isArray(parts) ? parts : []).map((p) => p && p.recompressed));
	if (!c) return "";
	return `; ${c.images} page image${c.images === 1 ? "" : "s"} re-compressed at quality ${c.quality}: ${c.bytesBefore} → ${c.bytesAfter} bytes`;
}

// What the audit row says of a build the photo steps left over the limit, or whose steps never
// ran (lib/triumph-batch.js `recompressSkipped`): counts and codes only, or "" for any other stop.
const SKIPPED_STEPS = Object.freeze({
	UNREACHABLE: "did not run: the batch is over by at least its photos' bytes",
	TOO_MANY: "did not run: more photos than the steps take",
	OUT_OF_TIME: "stopped: the batch's time budget ran out",
	MERGE_FAILED: "stopped: a step's merge failed",
});
function photoStepWords(out) {
	if (out.floorReached === true) {
		const c = photoCounts(out.recompressed);
		const kept = c ? `${c.images} page image${c.images === 1 ? "" : "s"} re-compressed at quality ${c.quality}: ${c.bytesBefore} → ${c.bytesAfter} bytes` : "no copy was smaller at any step";
		return `BATCH_TOO_LARGE after the photo steps (quality ${recompressLib.STEPS.join(", ")}): still over the limit at the floor; ${kept}`;
	}
	const code = String(out.recompressSkipped || "");
	return Object.hasOwn(SKIPPED_STEPS, code) ? `BATCH_TOO_LARGE; the photo steps ${SKIPPED_STEPS[code]} (${code})` : "";
}

function create(deps = {}) {
	const d = {
		log: console,
		now: () => new Date(),
		fs,
		workerId: `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`,
		timeZone: appTime.appTimeZone(),
		closedMonthsOf: () => null,
		dayKeyOf: () => "",
		notify: () => {},
		// server.js: notifyChange("dashboard"), the event every open dashboard reads again on.
		changed: () => {},
		logAudit: () => {},
		savedInvoiceEvidence: () => false,
		engineTimeoutMs: ENGINE_TIMEOUT_MS,
		noaLines: null,
		denyHits: null,
		transport: null,
		// Process with Triumph's switch (lib/triumph-rules.js processButtonEnabled()): the daily
		// notice names the actions the button's loads have.
		processButtonOn: false,
		setImmediate: (fn) => setImmediate(fn),
		...deps,
	};
	const db = d.db;
	const mode = rules.submitMode(d.env || {}, { replica: Boolean(d.replica) });
	const caps = rules.readCaps(d.env || {});
	const stopRecordOn = rules.stopRecordEnabled(d.env || {});
	const hasLines = Array.isArray(d.noaLines) && d.noaLines.length === rules.NOA_LINE_COUNT;
	const denyHits = typeof d.denyHits === "function" ? d.denyHits : null;
	const transportReady = Boolean(d.transport && d.transport.configured);
	const engine = {
		prepare: (args) => withTimeout(d.engine.prepare(args), d.engineTimeoutMs),
		render: (ctx, opts) => withTimeout(d.engine.render(ctx, opts), d.engineTimeoutMs),
		record: (ctx, rendered, opts) => withTimeout(d.engine.record(ctx, rendered, opts), d.engineTimeoutMs),
	};
	if (mode !== "off") ledger.ensureSchema(db);
	if (mode !== "off" && stopRecordOn) ledger.ensureRefusedSize(db);

	let runNumber = 0;
	const newRunToken = () => `${d.workerId}#${++runNumber}`;
	const nowMs = () => d.now().getTime();
	const nowIso = () => iso(nowMs());
	// The business clock in force at an instant (lib/app-time.js), so a switch of zone is read
	// the day it happens.
	const zoneAt = (date) => appTime.businessZoneAt(date, d.timeZone);
	const dayAt = (date) => appTime.dayInZone(date, zoneAt(date));
	const said = new Set();
	const logOnce = (key, msg) => {
		if (said.has(key)) return;
		said.add(key);
		d.log.warn(`[triumph] ${msg}`);
	};
	const audit = (action, loadId, details) => {
		try {
			d.logAudit(TRIUMPH_REQ, action, "load", loadId, details);
		} catch (e) {
			d.log.error(`[triumph] audit ${action} failed: ${codeOf(e)}`);
		}
	};
	const notify = (title, body) => {
		try {
			d.notify({ title, body });
		} catch (e) {
			d.log.error(`[triumph] notice failed: ${codeOf(e)}`);
		}
	};

	// ── the open panes ───────────────────────────────────────────────────────

	// Every claim as a pane reads it (ledger.claimsShown()), or null when it can't be read.
	const shownNow = () => {
		try {
			return ledger.claimsShown(db);
		} catch (e) {
			d.log.error(`[triumph] the claims couldn't be read for the open panes: ${codeOf(e)}`);
			return null;
		}
	};
	// After a step that may move claims: one dashboard:changed when a claim's state, code, stage or
	// attempts read differently from `before` (a claim is never deleted, so one new reads differently
	// too), and none otherwise. Answers the claims as they are now.
	function panesFollow(before) {
		const now = shownNow();
		if (!now || !before) return now || before;
		if ([...now].some(([key, seen]) => before.get(key) !== seen)) {
			try {
				d.changed();
			} catch (e) {
				d.log.error(`[triumph] the open panes weren't told: ${codeOf(e)}`);
			}
		}
		return now;
	}

	// ── what the job reads for free ─────────────────────────────────────────

	async function snapshot() {
		const jt = await d.readJobTracking();
		const headers = (jt && jt.headers) || [];
		const cols = autoRules.jobColumns(headers);
		const byKey = new Map();
		for (const row of (jt && jt.data) || []) {
			const key = cols.loadIdCol ? autoRules.loadKey(row[cols.loadIdCol]) : "";
			if (key) byKey.set(key, row);
		}
		return {
			headers,
			cols,
			byKey,
			records: autoRules.indexRecords(autoLedger.readRecords(db)),
			brokerSettings: autoLedger.readSettings(db),
			settings: ledger.readSettings(db),
		};
	}

	function podReadable(doc) {
		if (String(doc.drive_file_id || "")) return true;
		if (!d.uploadsRoot) return null;
		const file = autoRules.documentLocalPath(d.uploadsRoot, doc);
		return Boolean(file) && d.fs.existsSync(file);
	}

	function factsOf(snap, key) {
		const row = snap.byKey.get(key) || null;
		let closedMonths = null;
		let completionDay = "";
		if (row) {
			try {
				closedMonths = d.closedMonthsOf(snap.headers, row);
			} catch {
				closedMonths = null;
			}
			try {
				completionDay = snap.cols.completionCol ? d.dayKeyOf(row[snap.cols.completionCol]) || "" : "";
			} catch {
				completionDay = "";
			}
		}
		return autoRules.loadFacts({
			row,
			cols: snap.cols,
			records: snap.records.get(key),
			confirmedDomains: snap.brokerSettings.confirmedBrokerDomains,
			closedMonths,
			completionDay,
			podReadable,
			activeAdvanceLines: row ? autoLedger.activeAdvanceLines(db, key) : 0,
			factored: true,
		});
	}

	function inflightOf(key) {
		const rows = factoring.inflightRows(db, key, nowIso());
		if (rows.some((r) => r.effective === "maybe_drafted")) return "maybe_drafted";
		return rows.length ? "in_flight" : "";
	}

	function mailboxInvoice(key) {
		try {
			return d.savedInvoiceEvidence(key) === true;
		} catch {
			return false;
		}
	}

	// The free checks on one claim, with everything only this job reads. `marked`: the practice
	// run's load, read as the press would leave it (marked, not locked).
	function verdictFor(c, facts, snap, { marked = false } = {}) {
		const m = marked ? { state: "factored" } : ledger.markerState(db, c.load_key);
		if (m.state === "unreadable") return { state: "temporary", code: "FACTORING_UNREADABLE" };
		const debtor = rules.debtorFor(facts.brokerDomain, snap.settings.debtorNames);
		return rules.freeVerdict(facts, {
			debtorName: debtor.ok ? debtor.name : "",
			hasLines,
			ownDrafts: ledger.ownDraftRow(db, c) ? 1 : 0,
			inflight: inflightOf(c.load_key),
			lockedOutside: m.state === "locked_outside",
			factored: m.state !== "not_factored",
			mailboxInvoice: mailboxInvoice(c.load_key),
			settingsReadable: !snap.settings.unreadable && !snap.brokerSettings.unreadable,
			denyListSet: Boolean(denyHits),
		});
	}

	// Rule 7 on a text of any length.
	function denyIn(text) {
		const s = String(text == null ? "" : text);
		for (let at = 0; at === 0 || at < s.length; at += DENY_WINDOW - DENY_OVERLAP) {
			if (denyHits(s.slice(at, at + DENY_WINDOW))) return true;
		}
		return false;
	}

	// ── a Process with Triumph claim's own checks ───────────────────────────

	// The second look at the rate con, after prepare() and before the number, the render or any
	// byte to Triumph. It goes on only when nothing was recorded since the press, the DVIR reader
	// reads it with no DVIR line, the advance reader reads it whole and names C.H. Robinson with
	// neither advance label, and no other candidate shows one. Anything else stops it, a throw
	// included. { code: "" to go on, or the stop's code; whole: the advance read's, or null }.
	function secondNet(c, ctx) {
		try {
			if (processRules.advanceDoubt(db, c.load_key)) return { code: "ADVANCE_ON_RATECON", whole: null };
			if (processRules.dvirDoubt(db, c.load_key)) return { code: "DVIR_LINES", whole: null };
			const buf = ctx && ctx.rateconBuffer;
			if (!Buffer.isBuffer(buf) || !buf.length || buf.length > rateconDvir.MAX_PDF_BYTES) return { code: "RATECON_UNREAD", whole: false };
			const shown = shownTextRead(buf, { maxInflatedBytes: RATECON_TEXT_MAX_BYTES });
			const dvir = rateconDvir.readRateConDvir(rateconDvir.pdfText(buf, { maxInflatedBytes: RATECON_TEXT_MAX_BYTES }), buf.length);
			if (!dvir.readable) return { code: "RATECON_UNREAD", whole: shown.whole };
			if (dvir.count > 0) return { code: "DVIR_LINES", whole: shown.whole };
			if (!shown.whole) return { code: "RATECON_UNREAD", whole: false };
			const reading = rateconAdvanceRead.readAdvanceFigures(shown.text);
			if (reading.state === "labels") return { code: "ADVANCE_ON_RATECON", whole: true };
			if (reading.state !== "no_labels" || reading.namesChr !== true) return { code: "RATECON_UNREAD", whole: true };
			for (const other of (ctx.rateconCandidates || []).slice(0, OTHER_CANDIDATES_MAX)) {
				const b = other && other.buffer;
				if (!Buffer.isBuffer(b) || !b.length || b === buf || b.length > rateconDvir.MAX_PDF_BYTES) continue;
				if (rateconAdvanceRead.readAdvanceFigures(shownText(b, { maxInflatedBytes: RATECON_TEXT_MAX_BYTES })).state === "labels") return { code: "ADVANCE_ON_RATECON", whole: true };
			}
			return { code: "", whole: true };
		} catch {
			return { code: "RATECON_UNREAD", whole: false };
		}
	}

	// After the render: the page must be the invoice the broker got. The fields that differ, or []:
	// the total; the automatic claim's record (its number, a change it flagged); the number and date
	// the page was rendered with (`r`, the number step's answer: the broker's own N and D, or it
	// stops, whatever that step handed back); the load's hold fields since the send
	// (lib/auto-invoice-rules.js HOLD_FIELDS: a POD added since holds nothing); the PO; the
	// recipient's domain.
	function invoiceChanged(c, { ctx, rendered, facts, r }) {
		const out = [];
		if (String(rendered.total ?? "") !== String(c.expected_total || "")) out.push("total");
		const auto = autoLedger.hasTable(db, autoLedger.CLAIMS) ? autoLedger.getClaim(db, c.load_key) : null;
		if (!auto || auto.changed_fields || auto.number_voided_at || String(auto.invoice_id) !== String(c.invoice_id)) out.push("record");
		if (!auto || !r || String(r.invoiceId) !== String(auto.invoice_id) || String(r.invoiceDate) !== String(auto.invoice_date)) out.push("number");
		const parse = (json) => {
			try {
				return JSON.parse(json || "");
			} catch {
				return null;
			}
		};
		const saved = parse(auto && auto.fingerprint_json);
		if (!saved) out.push("fingerprint");
		else out.push(...autoRules.fingerprintDiff(saved, autoRules.fingerprint(facts)).filter((name) => autoRules.HOLD_FIELDS.includes(name)));
		const row = db.prepare("SELECT order_number FROM load_invoice_drafts WHERE id = ?").get(Number(c.reused_draft_id));
		if (!row || String(row.order_number ?? "") !== String(ctx.orderNumber ?? "")) out.push("po");
		const sent = parse(auto && auto.sent_json);
		const was = autoRules.emailDomain(sent && sent.to);
		if (!was || was !== autoRules.emailDomain(rendered.to)) out.push("recipient");
		return out;
	}

	// ── moving a claim ───────────────────────────────────────────────────────

	// A path that writes its own row and notice when it stops a claim (MAYBE_SUBMITTED, a late stop, a
	// refusal at the lock point, a host key or a sign-in refused): no triumph_stopped row beside it.
	const OWN_ROW = Object.freeze({ ownRow: true });

	// A run lets its claim go. With TRIUMPH_STOP_RECORD_ENABLED on, a move to Needs attention is
	// recorded, unless its path wrote its own row (`ownRow`). A run releases once, so it records once.
	function release(c, owner, state, code, extra = {}, { ownRow = false } = {}) {
		const n = ledger.transition(db, c.load_key, { from: ["working"], owner, nowIso: nowIso(),
			patch: { state, reason_code: code, lease_owner: "", lease_until: "", ...extra } });
		if (n) d.log.info(`[triumph] load ${c.load_id}: ${state}${code ? ` ${code}` : ""}`);
		if (n && stopRecordOn && state === "needs_attention" && !ownRow) recordStop(c.load_key, code);
		return n;
	}

	// The stop as a person reads it: one triumph_stopped row by the system actor and one Super Admin
	// notice, by how far the claim got. Before the lock nothing went to Triumph. After it, the PDF may
	// be on Triumph's server with nothing triggered there, and the daily notice skips a locked mark.
	// Once the CSV started, the load may have reached Triumph, and the app never sends it again. Only a
	// button claim's pane has a Triumph line, so any other load's notice says why in that line's words.
	function recordStop(key, code) {
		const c = ledger.getClaim(db, key);
		if (!c) return;
		const size = ledger.refusedSize(c);
		const chr = ledger.isChrInvoice(c);
		if (ledger.BEFORE_UPLOAD.has(c.stage)) {
			audit("triumph_stopped", c.load_id, `${code}: stopped before anything went to Triumph${size ? `; ${size.bytes} bytes, over the limit of ${size.limit}` : ""}`);
			const count = (n) => n.toLocaleString("en-US");
			const why = size ? `its documents came to ${count(size.bytes)} bytes, and the app sends at most ${count(size.limit)}` : factoring.stopWords(code);
			notify("Triumph: a load was not sent", `Load ${c.load_id} stopped before anything went to Triumph: ${why}.${chr ? " The broker's invoice already went out as usual. Open the load to see what to do." : ""}`);
			return;
		}
		if (UPLOAD_STAGES.has(c.stage)) {
			audit("triumph_stopped", c.load_id, `${code}: stopped after the lock, before the CSV; its PDF may be on Triumph's server, and nothing was triggered there`);
			notify("Triumph: a load stopped after its PDF went up. Nothing was triggered there; check Triumph's side.",
				`Load ${c.load_id}: invoice ${c.invoice_id}'s PDF may be on Triumph's server, but it stopped before the CSV that asks Triumph to process it (${factoring.stopWords(code)}), so nothing was triggered there. The mark stays locked.${chr ? " Open the load to see what to do." : ""}`);
			return;
		}
		audit("triumph_stopped", c.load_id, `${code}: stopped after its CSV started; it may have reached Triumph, and the app won't send it again`);
		notify("Triumph: a load may have reached Triumph. Check Triumph's side; the app won't send it again.",
			`Load ${c.load_id}: invoice ${c.invoice_id}'s files may have reached Triumph's server: it stopped after the CSV that asks Triumph to process it began. Check Triumph's side for it. The app won't send it again, and the mark stays locked.`);
	}

	// The load is no longer this job's: the claim gives up, and a number no byte used goes.
	function giveUp(c, owner, code) {
		const voided = ledger.voidNumber(db, c.load_key, { nowIso: nowIso() });
		if (voided) audit("triumph_number_void", c.load_id, `${voided} was reserved for this load and never sent (${code})`);
		const n = release(c, owner, "skipped", code);
		removeFiles(c.load_key);
		return n;
	}

	// A wait that costs no try, or a failure that counts one; after the last of those, a person.
	function temporary(c, owner, { code, counts, waitMs = SHORT_WAIT_MS }) {
		const attempts = (Number(c.attempts) || 0) + (counts ? 1 : 0);
		if (counts) {
			const delay = autoRules.retryDelayMs(attempts);
			if (delay === null) return release(c, owner, "needs_attention", "SUBMIT_FAILED", { attempts });
			return release(c, owner, "queued", code, { attempts, next_attempt_at: iso(nowMs() + delay) });
		}
		return release(c, owner, "queued", code, { next_attempt_at: iso(nowMs() + waitMs) });
	}

	// A run that can't go on now. A person's "Submit now" never goes back in line, so nothing
	// sends its batch by itself: before the lock it goes back to staged, for the next press;
	// after it, to a person, whose Try again resumes the upload. Any other run waits, or counts
	// a try. Once the CSV is up only the record is left, which goes in line as any run's does.
	function notNow(c, owner, run, opts) {
		if ((run && run.fromStaged) || pressed(c)) {
			if (ledger.BEFORE_UPLOAD.has(c.stage)) return release(c, owner, "staged", opts.code);
			if (UPLOAD_STAGES.has(c.stage)) return release(c, owner, "needs_attention", "SUBMIT_FAILED", {}, { ownRow: opts.ownRow === true });
		}
		return temporary(c, owner, opts);
	}

	// A CSV whose upload broke after a byte may have gone: never sent again, a person
	// checks Triumph's side, and submitting stops until the resume script runs.
	function maybeSubmitted(c, owner) {
		release(c, owner, "needs_attention", "MAYBE_SUBMITTED", {}, OWN_ROW);
		ledger.setPause(db, { reason: "MAYBE_SUBMITTED" });
		audit("triumph_paused", c.load_id, `MAYBE_SUBMITTED: invoice ${c.invoice_id}'s CSV may have reached Triumph; nothing is sent again until the resume script runs`);
		notify("Triumph: check one submission", `Load ${c.load_id}: invoice ${c.invoice_id}'s upload to Triumph broke after its file may have arrived. It won't be sent again. Check Triumph's side for it. Submitting is paused until the lead's resume script runs.`);
	}

	// ── the batch folder ─────────────────────────────────────────────────────

	const folderOf = (key) => path.join(d.batchDir, crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 32));

	function writeFiles(key, files) {
		const dir = folderOf(key);
		d.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		d.fs.chmodSync(dir, 0o700);
		for (const [name, bytes] of files) {
			const file = path.join(dir, name);
			d.fs.writeFileSync(file, bytes, { mode: 0o600 });
			d.fs.chmodSync(file, 0o600);
		}
	}

	// The batch as built, each file checked against its hash. null when any is gone or changed.
	function readFiles(c) {
		const f = ledger.builtFiles(c);
		if (!f || !f.invoicePage) return null;
		try {
			const dir = folderOf(c.load_key);
			const out = {};
			for (const part of ["pdf", "csv", "invoicePage"]) {
				const bytes = d.fs.readFileSync(path.join(dir, f[part].name));
				if (sha256(bytes) !== f[part].sha256 || bytes.length !== f[part].bytes) return null;
				out[part] = { name: f[part].name, bytes };
			}
			return { ...out, row: f.row || {} };
		} catch {
			return null;
		}
	}

	function removeFiles(key) {
		try {
			d.fs.rmSync(folderOf(key), { recursive: true, force: true });
		} catch (e) {
			d.log.error(`[triumph] the batch folder wasn't removed: ${codeOf(e)}`);
		}
	}

	// ── one attempt ──────────────────────────────────────────────────────────

	// One claim this run holds (`owner`). `fromStaged`: a person's "Submit now" on a batch
	// built in dry mode, which goes as it was built, never rebuilt.
	async function attempt(key, owner, { fromStaged = false } = {}) {
		const run = { fromStaged };
		let c = ledger.getClaim(db, key);
		if (!c || c.state !== "working" || c.lease_owner !== owner) return;
		if (c.stage === "csv_uploading") return maybeSubmitted(c, owner);
		if (c.stage === "csv_uploaded" || c.stage === "recorded") return record(c, owner, null);
		if (UPLOAD_STAGES.has(c.stage)) {
			// Locked: only the upload is left, with the files as built. Dry mode never connects.
			if (mode !== "live") return release(c, owner, "needs_attention", "NOT_LIVE");
			return send(c, owner, null, run);
		}
		let snap;
		try {
			snap = await snapshot();
		} catch {
			return notNow(c, owner, run, { code: "RETRY_LATER", counts: false });
		}
		c = ledger.getClaim(db, key);
		if (!c || c.state !== "working" || c.lease_owner !== owner) return;
		const facts = factsOf(snap, key);
		const v = verdictFor(c, facts, snap);
		if (v.state === "temporary") return notNow(c, owner, run, { code: v.code, counts: true });
		if (v.state === "skipped") return giveUp(c, owner, v.code);
		if (v.state === "waiting" && fromStaged) return release(c, owner, "staged", v.code);
		if (v.state !== "queued") return release(c, owner, v.state, v.code);

		if (fromStaged) {
			// The batch goes as a person checked it: the load as it was when built, the files
			// unchanged, and each composed value through rule 7's list as it is now.
			let saved = null;
			try {
				saved = JSON.parse(String(c.fingerprint_json || ""));
			} catch {
				saved = null;
			}
			if (!saved || autoRules.fingerprintDiff(saved, autoRules.fingerprint(facts)).length) return release(c, owner, "needs_attention", "LOAD_CHANGED");
			if (mode !== "live") return release(c, owner, "staged", "NOT_LIVE");
			return send(c, owner, null, run);
		}

		// No new render on a Friday evening: the weekly invoice batch has the renderer.
		if (autoRules.shadowRenderQuiet(d.now(), zoneAt(d.now()))) return temporary(c, owner, { code: "QUIET_WINDOW", counts: false, waitMs: HOUR_MS });

		const out = await build(c, { facts, snap, hooks: {
			alive: () => {
				const now = ledger.getClaim(db, key);
				return Boolean(now && now.state === "working" && now.lease_owner === owner);
			},
			number: () => {
				const now = d.now();
				return ledger.reserveNumber(db, key, owner, { mint: (date) => d.nextInvoiceNumber(date), now, dayKey: dayAt(now), nowIso: iso(now.getTime()) });
			},
			rendered: () => Boolean(ledger.setStage(db, key, owner, "rendered", nowIso())),
		} });
		if (out.lost) return undefined;
		c = ledger.getClaim(db, key) || c;
		if (out.stop) {
			// One counts-only row says the photo steps ran, or why they didn't: the stop's own code reads
			// the same with the switch off.
			const tried = photoStepWords(out);
			if (tried) audit("triumph_batch_photo_steps", c.load_id, tried);
			return stopped(c, owner, out.stop);
		}
		const { ctx, rendered, r, batch, invoicePdf, debtor } = out.built;

		const files = {
			pdf: { name: batch.pdfName, sha256: batch.pdfSha256, bytes: batch.pdf.length },
			csv: { name: batch.csvName, sha256: batch.csvSha256, bytes: batch.csv.length },
			invoicePage: { name: INVOICE_PAGE, sha256: sha256(invoicePdf), bytes: invoicePdf.length },
			// A part whose photos were re-compressed carries its record; with the switch off none has one.
			parts: batch.parts.map((p) => ({ kind: p.kind, sha256: p.sha256, bytes: p.bytes, pages: p.pages, ...(p.recompressed ? { recompressed: {
				quality: p.recompressed.quality, images: p.recompressed.images, left: p.recompressed.left,
				bytesBefore: p.recompressed.bytesBefore, bytesAfter: p.recompressed.bytesAfter, sourceSha256: p.recompressed.sourceSha256,
			} } : {}) })),
			// Only a batch built with the dedupe has it, so with the switch off the record is as it was.
			...(Array.isArray(batch.dropped) ? { dropped: batch.dropped.map((x) => ({ kind: x.kind, sha256: x.sha256, bytes: x.bytes, keptAs: x.keptAs })) } : {}),
			row: { po: batch.row.PO, total: batch.row.INVAMT },
		};
		try {
			writeFiles(key, [[batch.pdfName, batch.pdf], [batch.csvName, batch.csv], [INVOICE_PAGE, invoicePdf]]);
		} catch {
			return temporary(c, owner, { code: "RETRY_LATER", counts: true });
		}
		const built = ledger.transition(db, key, { from: ["working"], owner, nowIso: nowIso(), patch: {
			stage: "built", pdf_name: batch.pdfName, csv_name: batch.csvName, batch_bytes: batch.batchBytes,
			files_json: JSON.stringify(files), fingerprint_json: JSON.stringify(autoRules.fingerprint(facts)),
		} });
		if (!built) return;
		c = ledger.getClaim(db, key);
		if (mode !== "live") {
			// Dry: staged with a real number, and nothing connects.
			if (release(c, owner, "staged", "")) audit("triumph_batch_staged", c.load_id, `${r.invoiceId}: ${batch.pdfName} and ${batch.csvName}, ${batch.batchBytes} bytes${sentOnceWords(files.dropped)}${recompressWords(files.parts)}; nothing was sent`);
			return undefined;
		}
		return send(c, owner, { ctx, rendered, facts, debtorName: debtor.name }, run);
	}

	// One build, from the engine's prepare() to the checked batch, for attempt() and the practice
	// run alike. `hooks` are the claim's steps: alive() (the run still holds it), number() (the
	// reserveNumber() answer) and rendered() (the stage moved on). Answers { lost }, { stop } in
	// the claim's terms (refused, number, temporary, or state and code), or { built }; `net` is
	// the second look's answer on a Process with Triumph claim, `changed` the fields its page
	// didn't match, `dropped` the copies a stopped batch left out (when it got that far), and
	// `floorReached` with `recompressed` a batch still over at the photo steps' floor, or
	// `recompressSkipped` one whose steps didn't run.
	async function build(c, { facts, snap, hooks }) {
		const loadId = facts.loadId || c.load_id;
		let prep;
		try {
			prep = await engine.prepare({ loadId, body: {}, dryRun: false, mode: "auto" });
		} catch (e) {
			prep = { ok: false, code: e && e.code, http: 0, geminiUnavailable: Boolean(e && e.geminiUnavailable) };
		}
		if (!hooks.alive()) return { lost: true };
		if (!prep || !prep.ok) return { stop: { refused: prep || {} } };
		const ctx = prep.ctx;
		// The engine prints Triumph's block only for a load it read as factored: anything else
		// would tell Triumph the broker pays the carrier.
		if (!ctx || !ctx.assignment) return { stop: { state: "needs_attention", code: "FACTORING_CHANGED" } };
		const reuse = ledger.isChrInvoice(c);
		const net = reuse ? secondNet(c, ctx) : null;
		if (net && net.code) return { stop: { state: "needs_attention", code: net.code }, net };

		const r = hooks.number();
		if (!r.ok) return { stop: { number: r.reason }, net };

		let rendered;
		try {
			rendered = await engine.render(ctx, { invoiceId: r.invoiceId, invoiceDate: r.invoiceDate, emailBody: null });
		} catch (e) {
			const busy = e && e.code === "RENDERER_BUSY";
			return { stop: { temporary: busy ? { code: "RENDERER_BUSY", counts: false } : { code: "RETRY_LATER", counts: true } }, net };
		}
		if (!rendered || !rendered.invoicePdf || !rendered.invoicePdf.length) return { stop: { temporary: { code: "RETRY_LATER", counts: true } }, net };
		const changed = reuse ? invoiceChanged(c, { ctx, rendered, facts, r }) : [];
		if (changed.length) return { stop: { state: "needs_attention", code: "INVOICE_CHANGED" }, net, changed };
		if (!hooks.rendered()) return { lost: true };

		let documents;
		try {
			documents = await d.loadDocuments(loadId);
		} catch {
			return { stop: { temporary: { code: "RETRY_LATER", counts: true } }, net };
		}
		if (!hooks.alive()) return { lost: true };
		const debtor = rules.debtorFor(facts.brokerDomain, snap.settings.debtorNames);
		const invoicePdf = Buffer.from(rendered.invoicePdf);
		const candidate = ((ctx.rateconCandidates || [])[0]) || {};
		let batch;
		try {
			batch = await triumphBatch.buildBatch({
				invoicePdf,
				rateCon: ctx.rateconBuffer ? { ...candidate, buffer: ctx.rateconBuffer } : null,
				rateConNumber: autoRules.loadNumberRead(ctx.paidRead),
				documents,
				loadId: ctx.loadRef || loadId,
				debtorName: debtor.ok ? debtor.name : "",
				invoiceId: r.invoiceId,
				invoiceDate: brokerInvoice.formatDate(r.invoiceDate),
				po: ctx.orderNumber,
				billedTotal: rendered.total,
				at: d.now(),
				denyHits,
				maxBytes: rules.batchMaxBytes(d.env || {}),
				dedupe: rules.batchDedupeEnabled(d.env || {}),
				recompress: rules.batchRecompressEnabled(d.env || {}),
			});
		} catch {
			batch = { ok: false, code: "MERGE_FAILED" };
		}
		const dropped = batch.dropped;
		// A stop after the photo steps passes on what they did: the floor's records, or why they didn't run.
		const steps = batch.floorReached === true ? { floorReached: true, recompressed: batch.recompressed }
			: batch.recompressSkipped ? { recompressSkipped: batch.recompressSkipped } : {};
		if (!batch.ok) return { stop: { state: "needs_attention", code: batch.code || "MERGE_FAILED", ...sizeOf(batch) }, net, dropped, ...steps };
		// The invoice page is the app's own text too, and goes through the same list.
		if (denyIn(shownText(invoicePdf))) return { stop: { state: "needs_attention", code: "PROTECTED_VALUE" }, net, dropped };
		if (triumphBatch.unprintedFields(batch.pdf, batch.row).length) return { stop: { state: "needs_attention", code: "FIELD_NOT_PRINTED" }, net, dropped };
		return { built: { ctx, rendered, r, batch, invoicePdf, debtor }, net };
	}

	// A build's stop, applied to the claim this run holds.
	function stopped(c, owner, stop) {
		if (stop.refused !== undefined) return refused(c, owner, stop.refused);
		if (stop.number !== undefined) return numberRefused(c, owner, stop.number);
		if (stop.temporary !== undefined) return temporary(c, owner, stop.temporary);
		return release(c, owner, stop.state, stop.code, keptSize(stop));
	}

	// A batch over the size limit: sizeRefusal()'s own numbers, the batch's bytes and the limit it was
	// checked against, for its stop. { size: { bytes, limit } }, or {} for any other answer.
	function sizeOf(batch) {
		if (!batch || batch.code !== "BATCH_TOO_LARGE") return {};
		const bytes = Number(batch.pdfBytes) + Number(batch.csvBytes);
		const limit = Number(batch.maxBytes);
		return Number.isSafeInteger(bytes) && bytes > 0 && Number.isSafeInteger(limit) && limit > 0 ? { size: { bytes, limit } } : {};
	}

	// What the claim keeps of a size stop (only it carries `size`, sizeOf()), with TRIUMPH_STOP_RECORD_ENABLED
	// on: the size and the limit, so its line can name them. Try again clears it (ledger.retryClaim()).
	function keptSize(stop) {
		if (!stopRecordOn || !stop.size) return {};
		return { [ledger.REFUSED_SIZE]: JSON.stringify({ bytes: stop.size.bytes, limit: stop.size.limit }) };
	}

	function refused(c, owner, prep) {
		const code = String(prep.code || "");
		if (ATTENTION_CODES.has(code)) return release(c, owner, "needs_attention", code);
		const cls = autoRules.classifyRefusal({ code, http: prep.http, geminiUnavailable: Boolean(prep.geminiUnavailable || (prep.ctx && prep.ctx.geminiUnavailable)) });
		if (cls.kind === "temporary") {
			const waitMs = cls.code === "GEMINI_DOWN" ? autoRules.GEMINI_WAIT_MS : SHORT_WAIT_MS;
			return temporary(c, owner, { code: cls.code, counts: cls.countsAttempt, waitMs });
		}
		if (cls.kind === "wait") return release(c, owner, "waiting", cls.code);
		if (cls.kind === "ratecon_missing") return release(c, owner, "needs_attention", "RATECON_MISSING");
		return release(c, owner, "needs_attention", cls.code);
	}

	function numberRefused(c, owner, reason) {
		if (reason === "CLAIM_LOST") return 0;
		if (reason === "NOT_FACTORED" || reason === "FACTORING_LOCKED") return giveUp(c, owner, reason);
		if (reason === "FACTORING_UNREADABLE") return temporary(c, owner, { code: "FACTORING_UNREADABLE", counts: true });
		if (reason === "INVOICE_DRAFT_IN_FLIGHT") return release(c, owner, "waiting", reason);
		return release(c, owner, "needs_attention", reason);
	}

	// ── sending (live only) ──────────────────────────────────────────────────

	// The batch as built goes up, through the lock point. `fresh` holds the engine's context
	// when this same attempt built it, so the record is the engine's own; null when resuming
	// or sending a staged batch.
	async function send(c, owner, fresh, run) {
		const pause = ledger.getPause(db, nowIso());
		if (pause) return notNow(c, owner, run, { code: pause.reason || "RETRY_LATER", counts: false, waitMs: HOUR_MS });
		const files = readFiles(c);
		if (!files) return release(c, owner, "needs_attention", "BATCH_FILES_CHANGED");
		// Rule 7 at the moment of sending, on everything the app composed: the list may have
		// grown since the build.
		if (!denyHits) return release(c, owner, "needs_attention", "DENY_LIST_UNSET");
		if ([files.pdf.name, files.csv.name, files.csv.bytes.toString("latin1")].some((v) => denyIn(v)) || denyIn(shownText(files.invoicePage.bytes))) {
			return release(c, owner, "needs_attention", "PROTECTED_VALUE");
		}
		let session;
		try {
			session = await d.transport.openLive();
		} catch (e) {
			return connectFailed(ledger.getClaim(db, c.load_key), owner, codeOf(e), run);
		}
		try {
			return await upload(c, owner, session, files, fresh, run);
		} finally {
			try {
				session.close();
			} catch {
				// already closed
			}
		}
	}

	function connectFailed(c, owner, code, run) {
		if (!c) return 0;
		if (code === "HOST_KEY_MISMATCH") {
			ledger.setPause(db, { reason: code });
			audit("triumph_paused", c.load_id, "HOST_KEY_MISMATCH: Triumph's host key didn't match the pinned fingerprint; nothing was sent");
			notify("Triumph: submitting stopped", "Triumph's server didn't show the host key the app has pinned, so nothing was sent. Submitting is paused until the lead's resume script runs, after Arvin checks the fingerprint.");
			return notNow(c, owner, run, { code, counts: false, waitMs: HOUR_MS, ownRow: true });
		}
		if (code === "LOGIN_REFUSED") {
			const before = ledger.getPause(db, "") || { ms: 0 };
			const ms = autoRules.loginPauseMs(before.ms);
			ledger.setPause(db, { reason: code, untilIso: iso(nowMs() + ms), ms });
			if (!before.ms) {
				audit("triumph_paused", c.load_id, `LOGIN_REFUSED: Triumph refused the sign-in; submitting waits ${Math.round(ms / MINUTE_MS)} minutes`);
				notify("Triumph: sign-in refused", "Triumph refused the app's sign-in, so nothing was sent. Submitting tries again later, waiting longer each time, up to 6 hours.");
			}
			return notNow(c, owner, run, { code, counts: false, waitMs: ms, ownRow: true });
		}
		return notNow(c, owner, run, { code: "RETRY_LATER", counts: true });
	}

	// A Process with Triumph claim's late stop: its invoice aged past the limit, or the Payments
	// Table shows a payment date. Before the lock nothing went. At or after it (a resumed upload)
	// the PDF may be on Triumph's server with nothing triggered there and the mark stays locked,
	// so a person is told once: the daily notice skips locked marks.
	function lateStopped(c, owner, code) {
		if (!c) return 0;
		const afterLock = UPLOAD_STAGES.has(c.stage);
		const n = release(c, owner, "needs_attention", code, {}, OWN_ROW);
		if (!n) return 0;
		audit("triumph_submit_refused", c.load_id, `${code}: nothing was triggered at Triumph${afterLock ? "; its PDF may be on Triumph's server" : ", and nothing was sent"}`);
		if (afterLock) {
			const why = code === "PAID_ALREADY" ? "the Payments Table shows a payment date for it" : `its invoice went to the broker more than ${processRules.MAX_AGE_DAYS} days ago`;
			notify("Triumph: check one load", `Load ${c.load_id}: invoice ${c.invoice_id} stopped before Triumph was asked to process it, because ${why}. Its PDF may be on Triumph's server, but nothing was triggered there. The mark stays locked; check Triumph's side.`);
		}
		return n;
	}

	async function upload(c, owner, session, files, fresh, run) {
		// After the last await before the lock point: the age and the payment date again, so a claim
		// held through a pause or a retry can't go once either says no.
		if (ledger.isChrInvoice(c)) {
			const late = processRules.lateStop(db, c.load_key, { nowIso: nowIso() });
			if (late) return lateStopped(ledger.getClaim(db, c.load_key), owner, late);
		}
		const lock = ledger.lockForUpload(db, c.load_key, owner, { nowIso: nowIso(), mode });
		if (!lock.ok) return lockRefused(ledger.getClaim(db, c.load_key), owner, lock.code);
		ledger.setMeta(db, "pause_ms", "");
		let cur = ledger.getClaim(db, c.load_key);
		if (cur.stage === "pdf_uploading") {
			try {
				await session.put(lock.token, { name: files.pdf.name, bytes: files.pdf.bytes });
			} catch {
				// Only the CSV triggers: the PDF goes again under its own name.
				return notNow(ledger.getClaim(db, c.load_key), owner, run, { code: "RETRY_LATER", counts: true });
			}
			if (!ledger.setStage(db, c.load_key, owner, "pdf_uploaded", nowIso())) return 0;
		}
		if (!ledger.setStage(db, c.load_key, owner, "csv_uploading", nowIso())) return 0;
		try {
			await session.put(lock.token, { name: files.csv.name, bytes: files.csv.bytes });
		} catch (e) {
			cur = ledger.getClaim(db, c.load_key);
			// Refused before anything was made there: the CSV can go again later.
			if ((e && e.nothingSent === true) || codeOf(e) === "UNLOCKED_PUT" || codeOf(e) === "NOT_LIVE") {
				ledger.setStage(db, c.load_key, owner, "pdf_uploaded", nowIso());
				return notNow(ledger.getClaim(db, c.load_key), owner, run, { code: "RETRY_LATER", counts: true });
			}
			return maybeSubmitted(cur, owner);
		}
		if (!ledger.setStage(db, c.load_key, owner, "csv_uploaded", nowIso())) return 0;
		return record(ledger.getClaim(db, c.load_key), owner, fresh);
	}

	// A refusal at the lock point: nothing went up, and the number goes where it hadn't.
	function lockRefused(c, owner, code) {
		if (!c || code === "CLAIM_LOST") return 0;
		const voided = ledger.voidNumber(db, c.load_key, { nowIso: nowIso() });
		audit("triumph_submit_refused", c.load_id, `${code}: nothing was sent${voided ? `; number ${voided} voided` : ""}`);
		if (voided) audit("triumph_number_void", c.load_id, `${voided} was reserved for this load and never sent (${code})`);
		if (code === "NOT_FACTORED" || code === "FACTORING_LOCKED") {
			const n = release(c, owner, "skipped", code);
			removeFiles(c.load_key);
			return n;
		}
		// Waiting would put a press back in line once the draft ends: it goes back to staged.
		if (code === "INVOICE_DRAFT_IN_FLIGHT") return release(c, owner, pressed(c) ? "staged" : "waiting", code);
		if (code === "NOT_LIVE") return release(c, owner, "staged", code);
		return release(c, owner, "needs_attention", code, {}, OWN_ROW);
	}

	async function record(c, owner, fresh) {
		if (!c || c.state !== "working" || c.lease_owner !== owner) return 0;
		// The broker invoice's own row is a chr_invoice claim's: no second row for its number.
		const reuse = ledger.isChrInvoice(c);
		let fingerprintJson = c.fingerprint_json || "";
		if (fresh) {
			if (!reuse) {
				try {
					const answer = await engine.record(fresh.ctx, fresh.rendered, {
						via: ledger.VIA, actor: TRIUMPH_ACTOR, invoiceId: c.invoice_id, mintedInvoiceId: c.invoice_id, editDiffs: [], auditTarget: "Triumph",
					});
					if (!(answer && answer.recorded)) d.log.error(`[triumph] load ${c.load_id}: the engine couldn't record the submission; the job writes its row`);
				} catch (e) {
					d.log.error(`[triumph] load ${c.load_id}: recording failed: ${codeOf(e)}`);
				}
			}
			fingerprintJson = JSON.stringify(autoRules.fingerprint(fresh.facts));
		}
		c = ledger.getClaim(db, c.load_key);
		const files = ledger.builtFiles(c) || {};
		const ownBefore = Boolean(ledger.ownDraftRow(db, c));
		const n = ledger.finishSubmitted(db, c.load_key, owner, {
			nowIso: nowIso(),
			fingerprintJson,
			fallback: { total: files.row ? files.row.total : "", brokerName: fresh ? fresh.debtorName : "", orderNumber: files.row ? files.row.po : "" },
		});
		if (!n) return 0;
		if (!ownBefore) audit("invoice_draft_created", c.load_id, `${c.invoice_id} → Triumph (${ledger.VIA})`);
		// From the batch's own record, so a batch staged before the switch changed says what it holds.
		audit("triumph_submitted", c.load_id, `${c.invoice_id}: ${c.pdf_name} and ${c.csv_name}, ${c.batch_bytes} bytes${sentOnceWords(files.dropped)}${recompressWords(files.parts)}${reuse ? `; invoice ${c.invoice_id} of ${c.invoice_date}, the one the app sent the broker` : ""}`);
		d.log.info(`[triumph] load ${c.load_id}: submitted`);
		return n;
	}

	// ── the run ──────────────────────────────────────────────────────────────

	// One run holds its claim under its own token, so a run past its lease can't write again.
	async function runClaim(key, token, opts) {
		try {
			await attempt(key, token, opts);
		} catch (e) {
			d.log.error(`[triumph] load ${key}: the attempt failed: ${codeOf(e)}`);
			const c = ledger.getClaim(db, key);
			if (c && c.state === "working" && c.lease_owner === token) {
				if (c.stage === "csv_uploading") maybeSubmitted(c, token);
				else notNow(c, token, opts, { code: "RETRY_LATER", counts: true });
			}
		}
	}

	async function work() {
		if (mode === "off") return { mode, started: 0 };
		if (mode === "live" && !transportReady) {
			logOnce("transport", "live, but the connection's settings are missing or invalid, so nothing is submitted");
			return { mode, started: 0, paused: "TRANSPORT_UNCONFIGURED" };
		}
		// Paused, live builds nothing new either: each would wait for the same connection.
		const pause = mode === "live" ? ledger.getPause(db, nowIso()) : null;
		if (pause) return { mode, started: 0, paused: pause.reason || "PAUSED" };
		let started = 0;
		let shown = shownNow();
		for (;;) {
			const t = nowMs();
			const tIso = iso(t);
			if (ledger.inFlight(db, tIso) > 0 || started >= caps.perSweep) break;
			if (ledger.batchesSince(db, iso(t - HOUR_MS)) >= caps.maxPerHour || ledger.batchesSince(db, iso(t - DAY_MS)) >= caps.maxPerDay) break;
			const next = ledger.nextQueued(db, tIso);
			if (!next) break;
			const token = newRunToken();
			if (!ledger.lease(db, next.load_key, token, { nowIso: tIso, untilIso: iso(t + LEASE_MS) })) continue;
			started++;
			await runClaim(next.load_key, token);
			// Each run's end, not the pass's: a pane needn't wait for the next claim's run.
			shown = panesFollow(shown);
		}
		return { mode, started };
	}

	// A claim whose lease ran out: by how far it got. Before the CSV, back in line with its
	// number and stage (a locked one resumes its upload); once the CSV started, a person.
	async function recover() {
		if (mode === "off") return 0;
		let n = 0;
		for (const c of ledger.expiredWorking(db, nowIso())) {
			const t = nowMs();
			const token = newRunToken();
			if (!ledger.takeOver(db, c.load_key, token, { nowIso: iso(t), untilIso: iso(t + LEASE_MS) })) continue;
			n++;
			const held = ledger.getClaim(db, c.load_key);
			try {
				if (held.stage === "csv_uploading") maybeSubmitted(held, token);
				else if (held.stage === "csv_uploaded" || held.stage === "recorded") await record(held, token, null);
				else if (pressed(held)) notNow(held, token, null, { code: "RETRY_LATER", counts: false });
				else release(held, token, "queued", "RETRY_LATER", { next_attempt_at: iso(t) });
			} catch (e) {
				d.log.error(`[triumph] load ${held.load_id}: recovery failed: ${codeOf(e)}`);
			}
		}
		return n;
	}

	// What the tick re-reads for free: a waiting claim whose load is ready goes in line; a
	// staged one whose mark was cleared, or whose number went, gives up; a submitted load that
	// changed since tells a person once.
	function reviewClaims(snap) {
		const out = { queued: 0, changed: 0, gaveUp: 0 };
		const tIso = nowIso();
		for (const c of ledger.listClaims(db, ["waiting", "staged", "submitted"])) {
			if (c.state === "submitted") {
				if (c.changed_at || !c.fingerprint_json || !snap.byKey.has(c.load_key)) continue;
				let saved = null;
				try {
					saved = JSON.parse(c.fingerprint_json);
				} catch {
					continue;
				}
				const fields = autoRules.fingerprintDiff(saved, autoRules.fingerprint(factsOf(snap, c.load_key)));
				if (!fields.length) continue;
				if (ledger.transition(db, c.load_key, { from: ["submitted"], nowIso: tIso, patch: { changed_at: tIso, changed_fields: fields.join(",") } })) {
					out.changed++;
					audit("triumph_load_changed", c.load_id, `${c.invoice_id}: ${fields.join(", ")} changed after the submission; nothing was sent again`);
					notify("Triumph: a load changed after its submission", `Load ${c.load_id} changed after invoice ${c.invoice_id} went to Triumph (${fields.join(", ")}). Nothing was sent again. A correction goes through Triumph's own process.`);
				}
				continue;
			}
			const m = ledger.markerState(db, c.load_key);
			if (c.state === "staged") {
				if (m.state === "not_factored" || c.number_voided_at) {
					if (ledger.transition(db, c.load_key, { from: ["staged"], nowIso: tIso, patch: { state: "skipped", reason_code: "NOT_FACTORED" } })) {
						out.gaveUp++;
						const voided = ledger.voidNumber(db, c.load_key, { nowIso: tIso });
						if (voided) audit("triumph_number_void", c.load_id, `${voided} was reserved for this load and never sent (NOT_FACTORED)`);
						removeFiles(c.load_key);
					}
				}
				continue;
			}
			if (m.state === "unreadable") continue;
			const v = verdictFor(c, factsOf(snap, c.load_key), snap);
			if (v.state === "waiting" || v.state === "temporary") {
				if (v.state === "waiting" && v.code !== c.reason_code) ledger.transition(db, c.load_key, { from: ["waiting"], nowIso: tIso, patch: { reason_code: v.code } });
				continue;
			}
			const patch = v.state === "queued" ? { state: "queued", reason_code: "", next_attempt_at: tIso } : { state: v.state, reason_code: v.code };
			if (ledger.transition(db, c.load_key, { from: ["waiting"], nowIso: tIso, patch })) {
				if (v.state === "queued") out.queued++;
				if (v.state === "skipped") {
					const voided = ledger.voidNumber(db, c.load_key, { nowIso: tIso });
					if (voided) audit("triumph_number_void", c.load_id, `${voided} was reserved for this load and never sent (${v.code})`);
				}
			}
		}
		return out;
	}

	// Once a day: the factored loads delivered over 48 hours ago that haven't gone (staged,
	// waiting, needing a person, or never started), and, with the mode live, 14 days with no
	// submission. A notice's mark that can't be written sends it anyway: told twice beats not told.
	function dailyNotices(snap) {
		const today = dayAt(d.now());
		const meta = ledger.getMeta(db);
		const out = { waiting: 0, keepAlive: false };
		if (meta.waiting_notice_day !== today) {
			const cutoff = dayAt(new Date(nowMs() - WAITING_TOO_LONG_MS));
			let n = 0;
			for (const key of factoring.factoredKeys(db)) {
				const row = snap.byKey.get(key);
				const m = ledger.markerState(db, key);
				if (!row || m.state !== "factored") continue;
				const facts = factsOf(snap, key);
				const claim = ledger.getClaim(db, key);
				if (!facts.completed || !facts.live || (claim && ["submitted", "closed_outside", "skipped"].includes(claim.state))) continue;
				if (facts.completionDay && facts.completionDay <= cutoff) n++;
			}
			out.waiting = n;
			if (n) {
				try {
					ledger.setMeta(db, "waiting_notice_day", today);
				} catch (e) {
					d.log.error(`[triumph] the notice's mark: ${codeOf(e)}`);
				}
				// The actions that exist: with Process with Triumph on, the button's own.
				const actions = d.processButtonOn === true
					? "Try again, Clear factored to keep it with its invoice to the broker, or \"Handled in Triumph's process\" if it went to Triumph another way."
					: "Start, Submit now, Try again, or \"Handled in Triumph's process\".";
				notify("Factored loads not sent to Triumph", `${n} factored load${n === 1 ? " was" : "s were"} delivered over 48 hours ago and ${n === 1 ? "hasn't" : "haven't"} gone to Triumph. Each needs a person: ${actions}`);
			}
		}
		if (mode === "live" && meta.keep_alive_notice_day !== today) {
			if (!meta.live_since) ledger.setMeta(db, "live_since", nowIso());
			const last = ledger.lastSubmittedAt(db) || meta.live_since || nowIso();
			if (nowMs() - Date.parse(last) >= KEEP_ALIVE_MS) {
				out.keepAlive = true;
				ledger.setMeta(db, "keep_alive_notice_day", today);
				notify("Triumph: no submission in 14 days", "Nothing has gone to Triumph in 14 days. Triumph may turn off a connection left unused for a long time.");
			}
		}
		return out;
	}

	// Built files are kept 30 days after the submission, and not at all once a claim gives up.
	function pruneFiles() {
		const cutoff = iso(nowMs() - KEEP_FILES_MS);
		for (const c of ledger.listClaims(db, ["submitted", "skipped", "closed_outside"])) {
			if (c.state !== "submitted" || (c.submitted_at && c.submitted_at < cutoff)) {
				if (d.fs.existsSync(folderOf(c.load_key))) removeFiles(c.load_key);
			}
		}
	}

	let ticking = false;
	let again = false;
	// One tick: leases left by a restart, then what the claims read for free, then the work.
	async function tick() {
		if (mode === "off") return { mode };
		if (ticking) {
			again = true;
			return { mode, busy: true };
		}
		ticking = true;
		const out = { mode };
		try {
			do {
				again = false;
				const shown = shownNow();
				out.recovered = await recover();
				let snap = null;
				try {
					snap = await snapshot();
				} catch (e) {
					d.log.error(`[triumph] the sheet couldn't be read: ${codeOf(e)}`);
				}
				if (snap) {
					out.review = reviewClaims(snap);
					out.notices = dailyNotices(snap);
				}
				pruneFiles();
				panesFollow(shown);
				out.work = await work();
			} while (again);
		} catch (e) {
			d.log.error(`[triumph] tick failed: ${codeOf(e)}`);
			out.error = codeOf(e);
		} finally {
			ticking = false;
		}
		return out;
	}

	let started = false;
	// The timers, once: a tick every TICK_MS, the first soon after start. Only a process that
	// runs the job starts them (server.js asks startsJob() first), and only then does a
	// driver's Delivered wake it.
	function startTimers({ setTimeout: later, setInterval: every } = {}) {
		if (mode === "off" || started || typeof later !== "function" || typeof every !== "function") return false;
		started = true;
		later(() => { tick().catch(() => {}); }, FIRST_TICK_MS);
		every(() => { tick().catch(() => {}); }, TICK_MS);
		return true;
	}

	const wake = () => {
		if (started) d.setImmediate(() => { tick().catch(() => {}); });
	};

	// ── how a claim starts ───────────────────────────────────────────────────

	// The status route's call, before its sheet write: inert unless a Driver's own write
	// takes a load into a completed status. Once the write landed, a factored, unlocked load
	// goes in line. Nothing here may fail the route.
	function deliveredByDriver({ role, loadId, oldStatus, newStatus } = {}) {
		if (mode === "off") return NO_START;
		try {
			if (role !== "Driver" || !autoRules.isCompletedStatus(newStatus) || autoRules.isCompletedStatus(oldStatus)) return NO_START;
			const key = autoRules.loadKey(loadId);
			if (!key || key.length > LOAD_KEY_MAX) return NO_START;
			return {
				written() {
					try {
						const r = ledger.armClaim(db, { key, loadId, by: "driver", nowIso: nowIso() });
						if (r.ok) {
							audit("triumph_started", loadId, "the driver's Delivered");
							wake();
						} else if (r.code === "FACTORING_UNREADABLE") {
							d.log.error(`[triumph] load ${loadId}: the marker couldn't be read at the driver's Delivered`);
						}
					} catch (e) {
						d.log.error(`[triumph] load ${loadId}: the driver's Delivered wasn't recorded: ${codeOf(e)}`);
					}
				},
				writeFailed(e) {
					throw e;
				},
			};
		} catch {
			return NO_START;
		}
	}

	const refusal = (code, http = 409) => ({ ok: false, code, http });
	const userAudit = (req, action, loadId, details) => {
		try {
			d.logAudit(req, action, "load", loadId, details);
		} catch (e) {
			d.log.error(`[triumph] audit ${action} failed: ${codeOf(e)}`);
		}
	};

	// Start: a marked load nothing has started goes in line, as a driver's Delivered would
	// put it; the job's checks then run. For the Factoring page's listed accounts.
	function start(req, loadId) {
		if (mode === "off") return refusal("FEATURE_OFF", 404);
		const key = autoRules.loadKey(loadId);
		if (!key || key.length > LOAD_KEY_MAX) return refusal("LOAD_KEY_INVALID", 400);
		const r = ledger.armClaim(db, { key, loadId, by: "person", nowIso: nowIso() });
		if (!r.ok) return refusal(r.code);
		userAudit(req, "triumph_started", loadId, `Start${r.was ? ` (it was ${r.was})` : ""}`);
		wake();
		return { ok: true };
	}

	// Try again on a claim a person has looked at. `note`: what the audit row adds (the shared
	// login's words, lib/factoring-routes.js sharedLoginNote()).
	function retry(req, loadId, { note = "" } = {}) {
		if (mode === "off") return refusal("FEATURE_OFF", 404);
		const key = autoRules.loadKey(loadId);
		if (!key || key.length > LOAD_KEY_MAX) return refusal("LOAD_KEY_INVALID", 400);
		const r = ledger.retryClaim(db, { key, nowIso: nowIso() });
		if (!r.ok) return refusal(r.code);
		userAudit(req, "triumph_retry", loadId, `Try again${note}`);
		wake();
		return { ok: true };
	}

	// The practice run (scripts/triumph-process-rehearsal.js), for one load the press's dry run
	// took: the free checks with the load read as the press would mark it, then build() with the
	// broker invoice's number and date (`reuse`, lib/triumph-process.js), no stage moved and no
	// file kept. Verdicts and matches only, never a value. `copiesLeftOut` is a number only when
	// the batch was built with the dedupe, or stopped after it. `recompressed` (photoCounts()) is on a
	// batch built with photos re-compressed, and with `floorReached` on a stop at the floor;
	// `recompressSkipped` on a stop whose photo steps didn't run.
	async function rehearse(loadId, reuse) {
		const leftOut = (list) => (Array.isArray(list) ? list.length : undefined);
		const key = autoRules.loadKey(loadId);
		const c = Object.freeze({ load_key: key, load_id: String(loadId), state: "working", stage: "", attempts: 0, number_source: ledger.CHR_INVOICE,
			invoice_id: String(reuse.invoiceId), invoice_date: String(reuse.invoiceDate), reused_draft_id: Number(reuse.draftRowId), expected_total: String(reuse.total) });
		const snap = await snapshot();
		const facts = factsOf(snap, key);
		const v = verdictFor(c, facts, snap, { marked: true });
		if (v.state !== "queued") return { ok: false, step: "free checks", state: v.state, code: v.code };
		const out = await build(c, { facts, snap, hooks: {
			alive: () => true,
			number: () => ({ ok: true, invoiceId: c.invoice_id, invoiceDate: c.invoice_date }),
			rendered: () => true,
		} });
		const wholeRead = out.net ? out.net.whole : null;
		if (!out.built) {
			const stop = out.stop || {};
			const code = stop.refused !== undefined ? String((stop.refused && stop.refused.code) || "REFUSED") : stop.number || (stop.temporary && stop.temporary.code) || stop.code || "STOPPED";
			return { ok: false, step: "build", code, wholeRead, changed: out.changed || [], copiesLeftOut: leftOut(out.dropped),
				...(out.floorReached === true ? { floorReached: true, recompressed: photoCounts(out.recompressed) }
					: out.recompressSkipped ? { recompressSkipped: out.recompressSkipped } : {}) };
		}
		const { batch } = out.built;
		const photos = photoCounts(batch.parts.map((p) => p.recompressed));
		return {
			ok: true,
			wholeRead,
			numberMatches: batch.row["INVOICE#"] === c.invoice_id,
			dateMatches: batch.row.INV_DATE === brokerInvoice.formatDate(c.invoice_date),
			totalMatches: true,
			holdFieldsUnchanged: true,
			pages: batch.parts.reduce((sum, p) => sum + (Number(p.pages) || 0), 0),
			parts: batch.parts.map((p) => p.kind),
			copiesLeftOut: leftOut(batch.dropped),
			...(photos ? { recompressed: photos } : {}),
		};
	}

	// "Submit now" on a staged batch: only while the mode reads live, through every check
	// again and the lock point. Answers once the run has ended.
	async function submitNow(req, loadId) {
		if (mode !== "live") return refusal("NOT_LIVE", 404);
		if (!transportReady) return refusal("TRANSPORT_UNCONFIGURED", 503);
		const key = autoRules.loadKey(loadId);
		if (!key || key.length > LOAD_KEY_MAX) return refusal("LOAD_KEY_INVALID", 400);
		if (ledger.getPause(db, nowIso())) return refusal("SUBMIT_PAUSED", 503);
		const token = newRunToken();
		const t = nowMs();
		const shown = shownNow();
		if (!ledger.leaseStaged(db, key, token, { nowIso: iso(t), untilIso: iso(t + LEASE_MS) })) return refusal("NOT_STAGED");
		userAudit(req, "triumph_submit_now", loadId, "Submit now");
		await runClaim(key, token, { fromStaged: true });
		panesFollow(shown);
		const c = ledger.getClaim(db, key);
		return { ok: Boolean(c && c.state === "submitted"), state: c ? c.state : "", code: c ? c.reason_code : "" };
	}

	function status() {
		if (mode === "off") return { mode };
		return { mode, transport: transportReady ? "set" : "unset", paused: ledger.getPause(db, nowIso()), counts: ledger.countsByState(db) };
	}

	return Object.freeze({
		mode,
		transportReady,
		startTimers,
		tick,
		work,
		recover,
		attempt,
		deliveredByDriver,
		start,
		retry,
		submitNow,
		status,
		folderOf,
		rehearse,
		// Process with Triumph's press takes its claim on the next turn, not the next timer.
		wake,
	});
}

module.exports = { create, TRIUMPH_ACTOR, LEASE_MS, INVOICE_PAGE, photoStepWords };
