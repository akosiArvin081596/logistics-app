#!/usr/bin/env node
// scripts/data-fix-auto-invoice-mark-sent.js — records as sent the automatic invoice drafts a
// person sent by hand from Gmail.
//
// Completed Loads reads "Draft ready in Gmail" for the job's draft until the job itself sends
// it (lib/auto-invoice-send.js claimSent()); nothing in the app records a draft a person sent
// from Gmail. This gives each named load's claim the shape the job's own recorded send has, so
// the label reads "Sent to the broker" and Draft Invoice asks for a reason before another one.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/data-fix-auto-invoice-mark-sent.js --db=app.db --load=<load>@<sent time> [--load=...] --note=<text> [--dry-run]
//   node scripts/data-fix-auto-invoice-mark-sent.js --db=app.db --load=<load>@<sent time> [--load=...] --note=<text> --apply
//   --db      the app's database: app.db in this app directory, or a copy under the temp
//             directory (scripts/lib/ledger-world.js dbScope()); there is no default
//   --load    a load and the time Gmail Sent Mail shows for it, in UTC, like
//             2026-01-02T03:04:05Z; repeat it for each load; a run naming none is refused
//   --note    one line written into each audit row: why it was recorded
// The dry run is the default: it opens the database read-only and prints, per load, its claim,
// what would change and the audit row it would write, then the counts.
//
// What --apply writes, per load, in one immediate transaction that reads the claim again:
// delivery '' -> 'send' and sent_at '' -> the given time, stage staying 'recorded', through
// lib/auto-invoice-ledger.js transition() (which stamps updated_at), and one audit row as a
// system change (user 0, this script, role "system"; auto_invoice_sent, the job's own action
// for a sent invoice). The invoice number, the draft's fields, the changed fields and every
// other column stay as they are; no other claim or table is written, nothing outside the
// database. Each changed claim is read back after the write.
// Only a claim in exactly the job's recorded-draft shape moves: state drafted, stage recorded,
// no delivery, no sent time, no lease, an invoice number and its draft's Message-ID, the job's
// own draft row and no other on record, no send by scripts/auto-invoice-send-drafted.js on
// record, and drafted before the given time. Anything else is skipped and printed with its
// state, never forced. A claim this script recorded at that time is "already done" and gets no
// new row, so a replay writes nothing.
// --apply is refused unless this checkout has the rule that holds a sent load alone on a later
// change (rules.holdOneLoadEnabled(), AUTO_INVOICE_HOLD_ONE_LOAD) and the app's settings leave
// it on: under the older rule, any later change to one of these loads stops all sending.
// Exit codes: 0 done (each load changed, or already done); 1 error; 2 refused, nothing written;
// 3 one or more loads skipped (each printed; with --apply the others are written).
// Required as a module (by its test runner) it runs nothing and exports its parts.

"use strict";

const fs = require("fs");
const path = require("path");
const ledger = require("../lib/auto-invoice-ledger");
const appRules = require("../lib/auto-invoice-rules");
const sendRules = require("../lib/auto-invoice-send");
const { MESSAGE_ID_RE } = require("../lib/imap-draft");
const { dbScope, envFor } = require("./lib/ledger-world");
// The meta row scripts/auto-invoice-send-drafted.js keeps for each load it started to send.
const { MARK_PREFIX: SEND_DRAFTED_MARK } = require("./auto-invoice-send-drafted");

const ROOT = path.join(__dirname, "..");
const ACTOR = "script:data-fix-auto-invoice-mark-sent";
const REF = "AUTO-INVOICE-SENT-BY-HAND";
const ACTION = "auto_invoice_sent";
const LOAD_RE = /^#?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TIME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{3})?Z$/;
const NOTE_MAX = 200;
const KNOWN = { flags: new Set(["dry-run", "apply"]), values: new Set(["db", "note"]), lists: new Set(["load"]) };
const HOLD_WORDS = Object.freeze({
	on: "on",
	missing: "not in this checkout: --apply is refused until it is deployed",
	off: "switched off in the app's settings: --apply is refused while it is off",
});

class Refusal extends Error {}

const clip = (s) => String(s).slice(0, 80);

// One --load: { load (as typed), key, sentAt (as the ledger stores times) }.
function parseTarget(value, { loadKey, nowMs }) {
	const at = value.indexOf("@");
	if (at <= 0 || at !== value.lastIndexOf("@")) throw new Refusal(`--load=${clip(value)}: give it as <load>@<sent time>`);
	const load = value.slice(0, at);
	const time = value.slice(at + 1);
	if (!LOAD_RE.test(load)) throw new Refusal(`--load=${clip(value)}: the load number can't be read`);
	const m = TIME_RE.exec(time);
	const ms = m ? Date.parse(time) : NaN;
	// A day or hour that doesn't exist parses to another time; only the time as given is taken.
	if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== m[1]) {
		throw new Refusal(`--load=${clip(value)}: the sent time must be the UTC time Sent Mail shows, like 2026-01-02T03:04:05Z`);
	}
	if (ms > nowMs) throw new Refusal(`--load=${clip(value)}: the sent time is in the future`);
	return { load, key: loadKey(load), sentAt: new Date(ms).toISOString() };
}

function parseArgs(argv, { rules = appRules, nowMs = Date.now() } = {}) {
	const out = { load: [] };
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/s.exec(String(a));
		if (!m) throw new Refusal(`unknown argument: ${clip(a)}`);
		const [, name, value] = m;
		if (KNOWN.flags.has(name) && value === undefined) out[name] = true;
		else if (KNOWN.lists.has(name) && value !== undefined) out[name].push(value);
		else if (KNOWN.values.has(name) && value !== undefined) {
			if (name in out) throw new Refusal(`--${name} is given twice`);
			out[name] = value;
		} else throw new Refusal(`unknown or malformed argument: --${name}`);
	}
	if (out["dry-run"] && out.apply) throw new Refusal("give --dry-run or --apply, not both");
	if (typeof out.db !== "string" || !out.db.trim()) throw new Refusal("--db=<path> is required: the app's database (app.db in this app directory); there is no default");
	if (!out.load.length) throw new Refusal("name at least one --load=<load>@<sent time>; there is no default");
	const note = typeof out.note === "string" ? out.note.trim() : "";
	if (!note) throw new Refusal("--note=<text> is required: it is written into each audit row");
	if (note.length > NOTE_MAX || /[\u0000-\u001f\u007f]/.test(note)) throw new Refusal(`--note must be one line of at most ${NOTE_MAX} characters`);
	const targets = [];
	for (const value of out.load) {
		const t = parseTarget(value, { loadKey: rules.loadKey, nowMs });
		if (targets.some((x) => x.key === t.key)) throw new Refusal(`load ${t.key} is named twice`);
		targets.push(t);
	}
	return { db: out.db, note, apply: out.apply === true, targets };
}

// ── the claim ───────────────────────────────────────────────────────────────

const entityOf = (c) => String(c.load_id || c.load_key);
const labelOf = (t, c) => (c ? entityOf(c) : t.load);

function domainOf(rules, c) {
	try {
		return rules.emailDomain(JSON.parse(c.sent_json || "{}").to) || "";
	} catch {
		return "";
	}
}

function detailsOf(rules, c, sentAt, note) {
	return `${c.invoice_id} → ${domainOf(rules, c) || "unknown domain"} (recorded as sent by hand from Gmail at ${sentAt}: ${note}) [${REF}]`;
}

// This script's audit row for the load (either spelling of its ID), at `sentAt`, or at any
// time when it is omitted.
function audited(db, c, sentAt = "") {
	const pattern = sentAt ? `% (recorded as sent by hand from Gmail at ${sentAt}: %[${REF}]` : `%[${REF}]`;
	return Boolean(db.prepare("SELECT 1 FROM audit_trail WHERE user_id = 0 AND role = 'system' AND username = ? AND action = ? AND entity = 'load' AND LOWER(TRIM(entity_id)) IN (?, ?) AND details LIKE ? LIMIT 1")
		.get(ACTOR, ACTION, c.load_key, `#${c.load_key}`, pattern));
}

// A run of scripts/auto-invoice-send-drafted.js on the load, unless it was refused before its
// message left (the claim then went back to its draft): its state, or "".
function sendDraftedMark(db, key) {
	const raw = ledger.getMeta(db)[`${SEND_DRAFTED_MARK}${key}`];
	if (raw === undefined || raw === "") return "";
	try {
		const mark = JSON.parse(raw);
		return mark && mark.state === "refused" ? "" : String((mark && mark.state) || "unreadable");
	} catch {
		return "unreadable";
	}
}

// The shape a claim has once recorded as sent at `sentAt`.
const sentShape = (c, sentAt) => c.state === "drafted" && c.delivery === "send" && c.stage === "recorded" && c.sent_at === sentAt && !c.lease_owner && !c.lease_until;

// Why a claim isn't the job's recorded draft a hand send can be recorded on: phrases, none
// when it is. Another state, or a delivery set, says all there is to say.
function notReady(db, rules, c, sentAt) {
	if (c.state !== "drafted") return [`state ${c.state}${c.reason_code ? ` (${c.reason_code})` : ""}`];
	if (c.delivery !== "") {
		return [`delivery already '${c.delivery}'`, ...(c.sent_at && c.sent_at !== sentAt ? [`a different sent time (${c.sent_at})`] : []),
			...(audited(db, c) ? ["recorded as sent by hand by this script before"] : [])];
	}
	const why = [];
	if (c.sent_at) why.push(c.sent_at === sentAt ? "a sent time already on record" : `a different sent time (${c.sent_at})`);
	if (c.stage !== "recorded") why.push(`stage '${c.stage}'`);
	if (c.lease_owner || c.lease_until) why.push(`a lease held (${c.lease_owner || "no owner"} until ${c.lease_until || "no time"})`);
	if (!c.invoice_id) why.push("no invoice number");
	if (!MESSAGE_ID_RE.test(String(c.message_id || ""))) why.push("no draft Message-ID");
	const mark = sendDraftedMark(db, c.load_key);
	if (mark) why.push(`a send by scripts/auto-invoice-send-drafted.js on record (${mark})`);
	const own = ledger.ownDraftRow(db, c);
	if (!own || own.via !== rules.VIA_DRAFT || Number(own.id) !== Number(c.draft_row_id)) why.push("the job's own draft row for its invoice is not on record");
	const others = ledger.otherDraftRows(db, c).length;
	if (others) why.push(`${others} other invoice draft${others === 1 ? "" : "s"} on record for this load, so which invoice went can't be told`);
	if (!c.drafted_at || sentAt < c.drafted_at) why.push(`the sent time is before its draft was made (${c.drafted_at || "no draft time"})`);
	return why;
}

// What one load would do: { kind: "change" | "done" | "skip", claim, why }.
function judge(db, rules, t) {
	const c = ledger.getClaim(db, t.key);
	if (!c) return { kind: "skip", claim: null, why: ["missing: the load has no automatic-invoice claim"] };
	if (sentShape(c, t.sentAt)) {
		return audited(db, c, t.sentAt) ? { kind: "done", claim: c, why: [] }
			: { kind: "skip", claim: c, why: ["recorded as sent at that time, but not by this script (no audit row of its own)"] };
	}
	const why = notReady(db, rules, c, t.sentAt);
	return { kind: why.length ? "skip" : "change", claim: c, why };
}

function claimWords(rules, c) {
	return `state ${c.state}, stage ${c.stage || "''"}, delivery ${c.delivery || "''"}, sent_at ${c.sent_at || "''"}, invoice ${c.invoice_id || "none"} to ${domainOf(rules, c) || "unknown domain"}, `
		+ `drafted ${c.drafted_at || "never"}, changed since the draft: ${c.changed_fields ? c.changed_fields.split(",").join(", ") : "none"}`;
}

const moveWords = (t) => `delivery '' -> 'send', sent_at '' -> ${t.sentAt} (stage recorded)`;

// The move and its audit row, in one immediate transaction that judges the claim again: nothing
// else writes between that read and the write.
function applyOne(db, rules, t, { note, nowIso }) {
	return db.transaction(() => {
		const j = judge(db, rules, t);
		if (j.kind !== "change") return j;
		const moved = ledger.transition(db, t.key, { from: ["drafted"], nowIso, patch: { delivery: "send", stage: "recorded", sent_at: t.sentAt } });
		if (moved !== 1) throw new Error(`the claim of ${t.key} did not move`);
		db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'system', ?, 'load', ?, ?)")
			.run(nowIso, ACTOR, ACTION, entityOf(j.claim), detailsOf(rules, j.claim, t.sentAt, note));
		return { ...j, kind: "changed" };
	}).immediate();
}

// ── the run ─────────────────────────────────────────────────────────────────

// One run on a database the caller opened (read-only for a dry run). Returns the counts and
// the problems the read-back found.
function run({ db, rules = appRules, targets, note, apply = false, nowIso, out = () => {} }) {
	const counts = { change: 0, changed: 0, skip: 0, done: 0 };
	const changed = [];
	for (const t of targets) {
		const r = apply ? applyOne(db, rules, t, { note, nowIso }) : judge(db, rules, t);
		counts[r.kind]++;
		const label = labelOf(t, r.claim);
		if (r.kind === "change") {
			out(`  ${label}: would change: ${moveWords(t)}. Claim now: ${claimWords(rules, r.claim)}`);
			out(`    audit row: ${ACTION} load ${entityOf(r.claim)}: ${detailsOf(rules, r.claim, t.sentAt, note)}`);
		} else if (r.kind === "changed") {
			out(`  ${label}: changed: ${moveWords(t)}; one audit row. Claim was: ${claimWords(rules, r.claim)}`);
			changed.push({ t, label });
		} else if (r.kind === "done") {
			out(`  ${label}: already done: recorded as sent by hand at ${t.sentAt}; nothing to write`);
		} else {
			out(`  ${label}: skipped: ${r.why.join("; ")}${r.claim ? `. Claim: ${claimWords(rules, r.claim)}` : ""}`);
		}
	}
	const problems = [];
	for (const { t, label } of changed) {
		const c = ledger.getClaim(db, t.key);
		const good = Boolean(c) && sentShape(c, t.sentAt) && sendRules.claimSent(c);
		const row = Boolean(c) && audited(db, c, t.sentAt);
		out(`  read back: ${label}: delivery ${(c && c.delivery) || "''"}, stage ${(c && c.stage) || "''"}, sent_at ${(c && c.sent_at) || "''"}, sent: ${good ? "yes" : "no"}, its audit row: ${row ? "yes" : "no"}`);
		if (!good || !row) problems.push(label);
	}
	const n = targets.length;
	out(apply
		? `${n} named: ${counts.changed} changed, ${counts.skip} skipped, ${counts.done} already done.`
		: `${n} named: ${counts.change} would change, ${counts.skip} skipped, ${counts.done} already done. Nothing written.`);
	return { counts, problems };
}

// The rule that holds a sent load alone on a later change: "on", "off" or "missing".
function holdRule(rules, env) {
	if (typeof rules.holdOneLoadEnabled !== "function") return "missing";
	return rules.holdOneLoadEnabled(env || {}) ? "on" : "off";
}

function openDatabase(file, readonly) {
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	const db = new Database(file, { readonly, fileMustExist: true });
	if (readonly && !db.readonly) {
		db.close();
		throw new Refusal("the dry run's handle on the database is not read-only");
	}
	db.pragma("busy_timeout = 10000");
	return db;
}

function hasColumns(db, table, names) {
	const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
	return names.every((n) => have.has(n));
}

// `opts` (tests): now() (epoch ms), rules (the checkout's lib/auto-invoice-rules.js), env (the
// app's settings, for a copy under the temp directory), log / err (output). Returns the exit code.
async function main(argv = process.argv.slice(2), opts = {}) {
	const say = opts.log || ((s) => console.log(s));
	const warn = opts.err || ((s) => console.error(s));
	const rules = opts.rules || appRules;
	const nowMs = typeof opts.now === "function" ? opts.now() : Date.now();
	try {
		const args = parseArgs(argv, { rules, nowMs });
		let scope;
		let file;
		try {
			({ scope, file } = dbScope(args.db, ROOT));
		} catch (e) {
			throw new Refusal(e.message);
		}
		if (!fs.existsSync(file)) throw new Refusal(`--db names no file: ${clip(args.db)}`);
		// The app's own database runs with the app's settings; a copy, with the defaults.
		const env = opts.env !== undefined ? opts.env : scope === "app" ? envFor({ root: ROOT, dbPath: args.db }).env : {};
		const hold = holdRule(rules, env);
		if (args.apply && hold !== "on") {
			throw new Refusal(`the rule that holds a sent load alone on a later change (AUTO_INVOICE_HOLD_ONE_LOAD) is ${hold === "missing" ? "not in this checkout" : "switched off in the app's settings"}: `
				+ "without it, any later change to one of these loads would stop all automatic sending. Deploy it, or switch it on, first; nothing written");
		}
		const db = openDatabase(file, !args.apply);
		try {
			if (!ledger.hasSchema(db) || !ledger.hasTable(db, "audit_trail") || !ledger.hasTable(db, "load_invoice_drafts") || !hasColumns(db, ledger.CLAIMS, ["delivery", "sent_at"])) {
				throw new Refusal("the database has no automatic-invoice claims, invoice-draft or audit_trail tables (or no sending columns); nothing written");
			}
			say(`Data fix ${REF}: record as sent the automatic invoice drafts a person sent by hand from Gmail. Mode: ${args.apply ? "apply" : "dry run (nothing is written)"}.`);
			say(`  database: ${file} (${db.readonly ? "opened read-only" : "opened for writing"})`);
			say(`  the rule that holds a sent load alone on a later change (AUTO_INVOICE_HOLD_ONE_LOAD): ${HOLD_WORDS[hold]}`);
			const r = run({ db, rules, targets: args.targets, note: args.note, apply: args.apply, nowIso: new Date(nowMs).toISOString(), out: say });
			if (r.problems.length) {
				warn(`READ BACK does not confirm ${r.problems.join(", ")}: check each claim before anything else`);
				return 1;
			}
			return r.counts.skip ? 3 : 0;
		} finally {
			db.close();
		}
	} catch (e) {
		if (e instanceof Refusal) {
			warn(`REFUSED: ${e.message}`);
			return 2;
		}
		warn(`ERROR: ${(e && (e.stack || e.message)) || e}`);
		return 1;
	}
}

if (require.main === module) {
	main().then((code) => {
		process.exitCode = code;
	});
}

module.exports = { ACTOR, REF, ACTION, parseArgs, judge, run, holdRule, main, Refusal };
