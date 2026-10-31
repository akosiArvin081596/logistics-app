#!/usr/bin/env node
// Read-only comparison before automatic invoice emails go out without review:
// what the job built against what people actually sent from Gmail, judged by six
// exact conditions, counts only.
//
// --shadow: the shadow week. Each load the render shadow built in the window
//   (auto_invoice_shadow.render_digest_json, lib/auto-invoice-job.js) whose
//   recipient domain is on --domains, against the Sent Mail message people sent
//   for it, matched by invoice or load number: the message whose subject carries
//   the load's order number and, when the app has the person's draft row for the
//   load, whose invoice prints that row's invoice number, sent to that row's
//   recipient after it (with no row, to the render's recipient), at most 7 days
//   after the render. A load matches when:
//     1. found: exactly one such message (none, or several: unmatched);
//     2. recipient: its To is the render's one recipient, no Cc, no Bcc as far
//        as the Sent copy shows;
//     3. subject: the same SHA-256;
//     4. attachments and amount: the same names in the same order, each POD's
//        and the rate con's bytes the same, and the invoice PDF's masked text the
//        same (it carries every billed figure);
//     5. body: the same text (lib/auto-invoice-rules.js htmlToText());
//     6. nothing after: at most one person-made draft row for the load in the
//        window, no number voided or typed over, its invoice number and date not
//        edited, the load unchanged between the render and the person's draft,
//        and no later message to the same To within 7 days carrying the order
//        number.
//   2-6 failing is a difference. Pass: at least 6 matched, 0 differences and 0
//   unmatched. Refused renders and other domains are counted, not judged. A
//   render with no message yet and less than 7 days old is pending: nothing
//   passes, and nothing is recorded, while one is.
// --trial: the draft week. Each automatic draft in the window (a drafted claim
//   with its auto-imap row, auto_invoice_claims.draft_digest_json) against its
//   Sent copy, found by its Message-ID, else by its exact subject, To and invoice
//   number, sent at most 7 days after the draft. The same conditions, with "nothing after": no
//   other draft row for the load after the automatic one, no voided number, the
//   load never changed after the draft (no changed fields now or when it was
//   marked checked), and no later message. Step 0: the first draft is judged
//   first, and if it isn't in Sent Mail, or wasn't sent unchanged, nothing else
//   is judged (Gmail may change what it sends; a written rule must say how before
//   the week counts).
//   The window is the first 7 days of drafts, longer by a day at a time while
//   fewer than 6 drafts were sent, up to 14. Pass: every draft sent unchanged,
//   at least 6.
// Both compare digests made by lib/auto-invoice-rules.js messageDigest(): the
// job's, stored when it built the message, and the Sent copy's, read in memory by
// lib/mime-read.js from what lib/imap-draft.js fetchMessages() returns. The
// mailbox is opened read-only (EXAMINE) and messages fetched with BODY.PEEK[];
// nothing in it changes, and nothing fetched is kept.
//
// Usage, on the server from the app directory, by the lead:
//   node scripts/auto-invoice-send-trial-report.js (--shadow | --trial) --domains=<domain>[,<domain>]
//     [--since=YYYY-MM-DD] [--db=app.db] [--json]
//   ... --record --expect=<report SHA-256> [--dry-run]
// --since: the window's first day in APP_TIMEZONE (US Eastern unless set); by
//   default the day the render shadow was first on (shadow) or the first
//   automatic draft's day (trial).
// --record, for one domain, only when this run's report SHA-256 is the one given
//   by --expect (a re-run that gives the report a person reviewed): a pass writes
//   'send_pass:<domain>' = { source, window, invoices | drafts, passedAt,
//   reportSha256 } in auto_invoice_meta, anything else 'draft_week:<domain>' (the
//   draft week runs), each with one system audit row. --dry-run says what it
//   would write and writes nothing. A row already there is never overwritten.
// The mailbox login is read inside this script from the app's own settings
// (scripts/lib/ledger-world.js envFor()) and never printed. Output: counts only,
// never an address, subject, body, amount or load ID.
// Exit 0 done; 2 refused; 1 any other failure (nothing written).
//
// Required as a module (by its runner) it runs nothing and exports its parts.

"use strict";

const crypto = require("crypto");
const path = require("path");
const rules = require("../lib/auto-invoice-rules");
const ledger = require("../lib/auto-invoice-ledger");
const appTime = require("../lib/app-time");
const { parseMessage } = require("../lib/mime-read");

const ROOT = path.join(__dirname, "..");
const PASS_MINIMUM = 6;
const WINDOW_DAYS = 7;
const TRIAL_MAX_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const MATCH_MS = 7 * DAY_MS;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// The job's own rows; every other draft row was made by a person.
const JOB_VIA = Object.freeze(["auto-imap"]);
const CONDITIONS = Object.freeze(["recipient", "subject", "attachments", "body", "nothingAfter"]);
const KNOWN = { flags: new Set(["shadow", "trial", "json", "record", "dry-run"]), values: new Set(["since", "db", "domains", "expect"]) };

class Refusal extends Error {}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/.exec(String(a));
		if (!m) throw new Refusal(`unknown argument ${JSON.stringify(String(a).slice(0, 40))}`);
		if (KNOWN.flags.has(m[1])) {
			if (m[2] !== undefined) throw new Refusal(`--${m[1]} takes no value`);
			out[m[1]] = true;
		} else if (KNOWN.values.has(m[1])) {
			if (!m[2]) throw new Refusal(`--${m[1]} needs a value`);
			out[m[1]] = m[2];
		} else {
			throw new Refusal(`unknown argument --${m[1]}`);
		}
	}
	if (Boolean(out.shadow) === Boolean(out.trial)) throw new Refusal("give exactly one of --shadow and --trial");
	const domains = String(out.domains || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
	if (!domains.length || !domains.every((x) => DOMAIN_RE.test(x))) throw new Refusal("--domains=<domain>[,<domain>] is required: the broker email domains to judge");
	if (out.since !== undefined && !realDay(out.since)) throw new Refusal("--since must be a calendar day (YYYY-MM-DD)");
	if (out.record && domains.length !== 1) throw new Refusal("--record takes exactly one domain");
	if (out.record && !/^[0-9a-f]{64}$/.test(String(out.expect || ""))) throw new Refusal("--record needs --expect=<the report SHA-256 that was reviewed>");
	if (out["dry-run"] && !out.record) throw new Refusal("--dry-run goes with --record");
	return { mode: out.shadow ? "shadow" : "trial", domains, since: out.since || "", db: out.db || "", json: Boolean(out.json), record: Boolean(out.record), expect: out.expect || "", dryRun: Boolean(out["dry-run"]) };
}

function realDay(s) {
	const m = DAY_RE.exec(String(s || ""));
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function addDays(day, n) {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

// The instant a calendar day starts in the app's zone.
function dayStartMs(day, zone) {
	const [y, m, d] = day.split("-").map(Number);
	return appTime.wallClockToMs(zone, y, m, d, 0, 0, 0);
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const parseJson = (s) => {
	try {
		const v = s ? JSON.parse(s) : null;
		return v && typeof v === "object" ? v : null;
	} catch {
		return null;
	}
};
const domainOf = (addr) => String(addr || "").slice(String(addr || "").lastIndexOf("@") + 1).toLowerCase();
const orderNumberOf = (loadId) => String(loadId || "").trim().replace(/^#/, "");
const loadKey = rules.loadKey;

// The person-made draft rows for a load (the app's own Draft Invoice button),
// oldest first.
function personDrafts(db, key) {
	if (!ledger.hasTable(db, "load_invoice_drafts")) return [];
	const cols = new Set(db.prepare("PRAGMA table_info(load_invoice_drafts)").all().map((c) => c.name));
	const pick = ["id", "invoice_id", "via", "created_at", "recipient"].concat(["edited_fields", "invoice_id_minted"].filter((c) => cols.has(c)));
	return db.prepare(`SELECT ${pick.join(", ")} FROM load_invoice_drafts WHERE LOWER(TRIM(load_id)) IN (?, ?) ORDER BY id`).all(key, `#${key}`)
		.filter((r) => !JOB_VIA.includes(String(r.via || "")));
}

// A Sent copy read and digested, or null when it can't be read.
function sentCopy({ raw, internalDate }) {
	const m = parseMessage(raw);
	const at = Number.isFinite(m.date) ? m.date : Date.parse(String(internalDate || "").replace(/^(\d{1,2})-(\w{3})-(\d{4}) /, "$1 $2 $3 "));
	if (!Number.isFinite(at)) return null;
	return { at, to: m.to, subject: m.subject, messageId: m.messageId, invoiceNumber: rules.invoiceNumberIn(m), digest: rules.messageDigest(m, { renderedAt: new Date(at).toISOString() }) };
}

// The messages that carry `word` in their subject, read from Sent Mail between
// two instants, digested. `fetchSent` is the IMAP read (or a runner's made-up one).
async function sentFor(fetchSent, word, fromMs, toMs) {
	const raw = await fetchSent({ subject: word, since: new Date(fromMs - DAY_MS), before: new Date(toMs + DAY_MS) });
	return (raw || []).map(sentCopy).filter((x) => x && x.at >= fromMs && x.at <= toMs && x.subject.includes(word));
}

// Found means To carries the address looked for; condition 2 then asks that the
// render's recipient be the only one, with no Cc or Bcc.
const carries = (copy, recipient) => copy.to.includes(String(recipient || "").toLowerCase());
const laterMessage = (copies, matched, recipient) =>
	copies.some((x) => x !== matched && x.at > matched.at && x.at <= matched.at + MATCH_MS && carries(x, recipient));

// One judgement: found ("one", "none", "several", or "pending" while the 7 days
// to send it have not passed) and, when found, the conditions 2-6 that failed.
function judge({ expected, candidates, nothingAfter, waitingUntilMs = 0, nowMs = Infinity }) {
	if (!candidates.length && nowMs < waitingUntilMs) return { found: "pending", failed: [] };
	if (candidates.length !== 1) return { found: candidates.length ? "several" : "none", failed: [] };
	const failed = rules.digestDifferences(expected, candidates[0].digest);
	if (!nothingAfter(candidates[0])) failed.push("nothingAfter");
	return { found: "one", failed };
}

function emptyCounts(mode, window, domains) {
	return {
		mode,
		window,
		domains,
		population: 0,
		matched: 0,
		differences: { total: 0, ...Object.fromEntries(CONDITIONS.map((c) => [c, 0])) },
		unmatched: { total: 0, none: 0, several: 0 },
		pending: 0,
		outside: {},
		minimum: PASS_MINIMUM,
		pass: false,
		reason: "",
	};
}

function tally(counts, verdict) {
	if (verdict.found === "pending") {
		counts.pending++;
	} else if (verdict.found !== "one") {
		counts.unmatched.total++;
		counts.unmatched[verdict.found]++;
	} else if (verdict.failed.length) {
		counts.differences.total++;
		for (const c of verdict.failed) counts.differences[c]++;
	} else {
		counts.matched++;
	}
}

// Arvin's rule: at least 6 matched, 0 differences, 0 unmatched; anything else
// fails, and nothing is final while a message may still be sent.
function decide(counts) {
	if (counts.unmatched.total) counts.reason = "unmatched";
	else if (counts.differences.total) counts.reason = "differences";
	else if (counts.pending) counts.reason = "pending: some have had less than 7 days to be sent; run it again later";
	else if (counts.matched < PASS_MINIMUM) counts.reason = `fewer than ${PASS_MINIMUM} matched`;
	counts.pass = !counts.reason;
	return counts;
}

// ── --shadow ─────────────────────────────────────────────────────────────────

async function compareShadow({ db, since, domains, zone, fetchSent, nowMs }) {
	const meta = ledger.getMeta(db);
	const first = since || (meta.shadow_renders_on_at ? appTime.dayInZone(new Date(meta.shadow_renders_on_at), zone) : "");
	if (!first) throw new Refusal("the render shadow has never been on: give --since");
	const until = addDays(first, WINDOW_DAYS - 1);
	const fromMs = dayStartMs(first, zone);
	const toMs = dayStartMs(addDays(first, WINDOW_DAYS), zone);
	const counts = emptyCounts("shadow", { since: first, until, zone }, domains);
	counts.outside = { refused: 0, otherDomains: 0 };
	const rows = ledger.hasTable(db, ledger.SHADOW) && ledger.hasRenderColumn(db) ? ledger.listShadow(db) : [];
	for (const row of rows) {
		const rec = parseJson(row.render_digest_json);
		const at = Date.parse(String((rec && (rec.renderedAt || rec.refusedAt)) || ""));
		if (!rec || !(at >= fromMs && at < toMs)) continue;
		if (rec.refusedAt) {
			counts.outside.refused++;
			continue;
		}
		if (!domains.includes(domainOf(rec.recipient))) {
			counts.outside.otherDomains++;
			continue;
		}
		counts.population++;
		const word = orderNumberOf(row.load_id);
		const drafts = personDrafts(db, row.load_key).filter((r) => {
			const t = Date.parse(r.created_at);
			return t >= fromMs && t < toMs;
		});
		// Matched by invoice or load number: the person's draft row gives the
		// invoice number its Sent copy prints, where it went and from when; with no
		// row, the load number in the subject, the render's recipient and the
		// window's start.
		const lowMs = drafts.length ? Date.parse(drafts[0].created_at) : fromMs;
		const lookFor = drafts.length && drafts[0].recipient ? drafts[0].recipient : rec.recipient;
		const invoiceId = drafts.length ? String(drafts[0].invoice_id || "") : "";
		const copies = await sentFor(fetchSent, word, Math.min(lowMs, at), at + 2 * MATCH_MS);
		const candidates = copies.filter((x) => carries(x, lookFor) && x.at >= lowMs && x.at <= at + MATCH_MS && (!invoiceId || x.invoiceNumber === invoiceId));
		tally(counts, judge({
			expected: rec,
			candidates,
			waitingUntilMs: at + MATCH_MS,
			nowMs,
			nothingAfter: (matched) => {
				if (drafts.length > 1) return false;
				const d = drafts[0];
				if (d && (String(d.invoice_id_minted || "") || /(^|,)(invoiceId|invoiceDate)(,|$)/.test(String(d.edited_fields || "")))) return false;
				if (rec.draftSeenAt && rec.fingerprintAtDraftSha256 !== rec.fingerprintSha256) return false;
				return !laterMessage(copies, matched, lookFor);
			},
		}));
	}
	return decide(counts);
}

// ── --trial ──────────────────────────────────────────────────────────────────

async function compareTrial({ db, since, domains, zone, fetchSent, nowMs }) {
	const drafted = ledger.hasTable(db, ledger.CLAIMS) ? ledger.listClaims(db, ["drafted"]) : [];
	const own = drafted
		.map((c) => ({ c, digest: parseJson(c.draft_digest_json), row: ledger.ownDraftRow(db, c) }))
		.filter((x) => x.row && x.c.drafted_at)
		.sort((a, b) => (a.c.drafted_at < b.c.drafted_at ? -1 : a.c.drafted_at > b.c.drafted_at ? 1 : 0));
	const firstDay = since || (own.length ? appTime.dayInZone(new Date(own[0].c.drafted_at), zone) : "");
	if (!firstDay) throw new Refusal("no automatic draft yet: give --since");
	const fromMs = dayStartMs(firstDay, zone);
	const changedAudits = ledger.hasTable(db, "audit_trail")
		? new Set(db.prepare("SELECT entity_id FROM audit_trail WHERE action = 'auto_invoice_checked' AND details LIKE '%(changed:%'").all().map((r) => loadKey(r.entity_id)))
		: new Set();

	const judged = [];
	for (const x of own) {
		const at = Date.parse(x.c.drafted_at);
		if (!(at >= fromMs) || !x.digest || !domains.includes(domainOf(x.digest.recipient))) continue;
		const word = orderNumberOf(x.c.load_id);
		const copies = await sentFor(fetchSent, word, at, Math.min(at + 2 * MATCH_MS, nowMs));
		const inWindow = copies.filter((y) => y.at >= at && y.at <= at + MATCH_MS);
		const byId = inWindow.filter((y) => x.c.message_id && y.messageId === x.c.message_id);
		const candidates = byId.length ? byId
			: inWindow.filter((y) => y.digest.subjectSha256 === x.digest.subjectSha256 && carries(y, x.digest.recipient) && y.invoiceNumber === x.c.invoice_id);
		const verdict = judge({
			expected: x.digest,
			candidates,
			waitingUntilMs: at + MATCH_MS,
			nowMs,
			nothingAfter: (matched) => {
				if (personDrafts(db, x.c.load_key).some((r) => Date.parse(r.created_at) > at)) return false;
				if (x.c.number_voided_at) return false;
				if (x.c.changed_fields || changedAudits.has(loadKey(x.c.load_id))) return false;
				return !laterMessage(copies, matched, x.digest.recipient);
			},
		});
		judged.push({ at, day: appTime.dayInZone(new Date(at), zone), verdict });
	}

	// The window: 7 days, then a day more at a time while fewer than the minimum
	// were sent, up to 14.
	let days = WINDOW_DAYS;
	const sentWithin = (n) => judged.filter((j) => j.day <= addDays(firstDay, n - 1) && j.verdict.found === "one").length;
	while (days < TRIAL_MAX_DAYS && sentWithin(days) < PASS_MINIMUM) days++;
	const until = addDays(firstDay, days - 1);
	const counts = emptyCounts("trial", { since: firstDay, until, zone }, domains);
	counts.outside = { otherDomains: own.filter((x) => x.digest && !domains.includes(domainOf(x.digest.recipient))).length, noDigest: own.filter((x) => !x.digest).length };
	const inW = judged.filter((j) => j.day <= until);
	counts.population = inW.length;
	const v0 = inW.length ? inW[0].verdict : null;
	counts.step0 = !v0 ? "none" : v0.found === "pending" ? "pending" : v0.found !== "one" ? "not found" : v0.failed.length ? "differs" : "unchanged";
	if (counts.step0 === "differs" || counts.step0 === "not found") {
		tally(counts, v0);
		counts.reason = counts.step0 === "differs"
			? "step 0: the first draft was not sent unchanged; write the normalization rule before judging the week"
			: "step 0: the first draft is not in Sent Mail; nothing else is judged";
		counts.pass = false;
		return counts;
	}
	for (const j of inW) tally(counts, j.verdict);
	return decide(counts);
}

// ── output ───────────────────────────────────────────────────────────────────

// The counts in a fixed key order, so a re-run on the same data hashes the same.
function stable(v) {
	if (Array.isArray(v)) return v.map(stable);
	if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
	return v;
}
const reportSha256 = (counts) => sha256(JSON.stringify(stable(counts)));

function textOf(counts, sha) {
	const d = counts.differences;
	const lines = [
		`Automatic invoice comparison (--${counts.mode}), ${counts.window.since} to ${counts.window.until} (${counts.window.zone}), domains: ${counts.domains.join(", ")}`,
		`Population (${counts.mode === "shadow" ? "rendered" : "drafted"}, recipient on the list): ${counts.population}`,
	];
	if (counts.mode === "trial") lines.push(`Step 0 (the first draft): ${counts.step0}`);
	lines.push(
		`Matched (all six conditions): ${counts.matched}`,
		`Differences: ${d.total} (recipient ${d.recipient}, subject ${d.subject}, attachments and amount ${d.attachments}, body ${d.body}, nothing after ${d.nothingAfter})`,
		`Unmatched: ${counts.unmatched.total} (no Sent message ${counts.unmatched.none}, several ${counts.unmatched.several})`,
		`Pending (less than 7 days to be sent): ${counts.pending}`,
		`Outside the population (counted, not judged): ${Object.entries(counts.outside).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
		`Pass rule: at least ${counts.minimum} matched, 0 differences, 0 unmatched`,
		`Result: ${counts.pass ? "PASS" : `FAIL (${counts.reason}): the draft week runs`}`,
		`Report SHA-256: ${sha}`,
	);
	return lines.join("\n");
}

async function report({ db, mode, since = "", domains, fetchSent, zone = appTime.appTimeZone(), nowMs = Date.now() }) {
	const counts = mode === "shadow"
		? await compareShadow({ db, since, domains, zone, fetchSent, nowMs })
		: await compareTrial({ db, since, domains, zone, fetchSent, nowMs });
	const sha = reportSha256(counts);
	return { counts, reportSha256: sha, text: textOf(counts, sha) };
}

// --record: one decision row and its audit row, only on the re-run reviewed.
function record({ db, result, domain, expect, dryRun, nowIso }) {
	if (result.reportSha256 !== expect) {
		throw new Refusal("this run's report SHA-256 is not the one given by --expect: nothing recorded (re-run on the data that was reviewed)");
	}
	const c = result.counts;
	if (c.pending) throw new Refusal("some messages may still be sent (pending): no decision is recorded yet");
	const key = `${c.pass ? "send_pass" : "draft_week"}:${domain}`;
	const value = c.pass
		? { source: c.mode, window: { since: c.window.since, until: c.window.until }, [c.mode === "shadow" ? "invoices" : "drafts"]: c.matched, passedAt: nowIso, reportSha256: result.reportSha256 }
		: { source: c.mode, window: { since: c.window.since, until: c.window.until }, decidedAt: nowIso, reportSha256: result.reportSha256 };
	const existing = db.prepare(`SELECT value FROM ${ledger.META} WHERE key = ?`).get(key);
	if (existing) {
		const was = parseJson(existing.value);
		if (was && was.reportSha256 === result.reportSha256) return { wrote: false, key, message: `${key} is already recorded for this report: nothing written` };
		throw new Refusal(`${key} is already recorded for another report: nothing written (a recorded decision is never overwritten)`);
	}
	const detail = `source ${c.mode}: ${c.matched} matched of ${c.population}, window ${c.window.since} to ${c.window.until}, report ${result.reportSha256.slice(0, 12)}`;
	if (dryRun) return { wrote: false, key, value, message: `DRY RUN: would write ${key} and one audit row (${detail})` };
	db.transaction(() => {
		db.prepare(`INSERT INTO ${ledger.META} (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
		db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'system', ?, 'auto_invoice', ?, ?)")
			.run(nowIso, "system: auto-invoice-send-trial-report", c.pass ? "auto_invoice_send_pass" : "auto_invoice_draft_week", key, detail);
	})();
	return { wrote: true, key, value, message: `wrote ${key} and one audit row (${detail})` };
}

// The IMAP read for one subject word, with the login from the app's settings.
function imapFetcher({ user, pass }) {
	const { fetchMessages } = require("../lib/imap-draft");
	return async ({ subject, since, before }) => (await fetchMessages({ user, pass, mailbox: "[Gmail]/Sent Mail", subject, since, before })).messages;
}

async function main() {
	let args;
	let db;
	try {
		args = parseArgs(process.argv.slice(2));
		const { envFor, openDb } = require("./lib/ledger-world");
		const { env, file } = envFor({ root: ROOT, dbPath: args.db || path.join(ROOT, "app.db") });
		const writes = args.record && !args.dryRun;
		db = openDb({ root: ROOT, dbFile: file, readonly: !writes });
		if (!ledger.hasTable(db, ledger.META)) throw new Refusal("this database has no automatic-invoice tables");
		if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) throw new Refusal("the app's settings name no mailbox login");
		const result = await report({ db, mode: args.mode, since: args.since, domains: args.domains, fetchSent: imapFetcher({ user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD }) });
		console.log(args.json ? JSON.stringify({ ...result.counts, reportSha256: result.reportSha256 }, null, 2) : result.text);
		if (args.record) {
			const r = record({ db, result, domain: args.domains[0], expect: args.expect, dryRun: args.dryRun, nowIso: new Date().toISOString() });
			console.log(r.message);
		}
	} catch (e) {
		if (e instanceof Refusal) {
			console.error(`REFUSED: ${e.message}`);
			process.exitCode = 2;
		} else {
			console.error(`FAILED: ${(e && e.code) || "ERROR"}${e && e.stage ? ` at ${e.stage}` : ""}`);
			process.exitCode = 1;
		}
	} finally {
		if (db) db.close();
	}
}

if (require.main === module) main();

module.exports = { parseArgs, report, record, judge, sentCopy, compareShadow, compareTrial, reportSha256, textOf, imapFetcher, Refusal, PASS_MINIMUM, CONDITIONS };
