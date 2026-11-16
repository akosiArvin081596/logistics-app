#!/usr/bin/env node
// Read-only switch-on report for RATECON_ADVANCE_READ_ENABLED: what the advance read
// (lib/ratecon-advance-read.js) recorded in ratecon_advance_reads since a date. For each
// C.H. Robinson load whose revised rate con it read: what it would fill (or filled), hand to a
// person (and why) or leave as it was, beside what is on the load now (its advance lines,
// whether an invoice was made, and whether that invoice billed the balance or the full figure);
// then the same in counts and cents. --pdf-dir replays the reader's figure gate over a folder of
// rate-con PDFs, in counts only (no file or load is named).
//
//   node scripts/ratecon-advance-read-report.js --db=<file> --since=2026-11-16 [--counts] [--json]
//   node scripts/ratecon-advance-read-report.js --pdf-dir=<folder> [--json]
//
// --db is required (no default): the database, opened read-only; a missing file is refused,
// never made. --since: a date (YYYY-MM-DD, from 00:00 APP_TIMEZONE) or an ISO time with a zone.
// The per-load list names each load: production data, kept out of the repo and the reports;
// --counts leaves it out. Reads no sheet, no settings file, nothing else, and writes nothing.
// Exit 0; 2 on a refused argument.

"use strict";

const fs = require("fs");
const path = require("path");
const appTime = require("../lib/app-time");
const read = require("../lib/ratecon-advance-read");
const { invoiceLines } = require("../lib/broker-invoice");
const { shownText } = require("../lib/pdf-shown-text");
const { sinceInstant } = require("./person-edit-hold-report");

const ROOT = path.join(__dirname, "..");
// The order every count is shown in.
const VERDICT_ORDER = ["filled", "would_fill", "person", "would_person", "same", "unread"];
const FILLS = new Set(["filled", "would_fill"]);
const PEOPLE = new Set(["person", "would_person"]);
const REPLAY_ORDER = ["sum_checks", "sum_off", "figure_missing", "not_chr_text", "no_labels", "unreadable"];
// A folder replay reads at most this many PDFs, and none past the server's own size cap.
const REPLAY_MAX_FILES = 5000;
const REPLAY_MAX_BYTES = require("../lib/ratecon-dvir").MAX_PDF_BYTES;
const NOT_COUNTED = [
	"loads whose revised rate con was never read: a restart within 10 minutes of the email, a PDF that isn't the email's attachment, a load not on Job Tracking yet, a closed month",
	"whether the advance arrived before or after the driver's Delivered (an invoice made first reads after_invoice)",
];
const money = (cents) => invoiceLines.formatCents(cents);
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const columnsOf = (db, name) => new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
const ordered = (counts, order) => Object.fromEntries(order.filter((k) => counts[k]).map((k) => [k, counts[k]]));
const sortedCounts = (counts) => Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]]));

// What is on the load now: its advance lines against `advanceCents`, and its latest invoice.
function loadNow(db, key, advanceCents, { linesTable, draftCols }) {
	let linesNow = "none";
	if (linesTable) {
		const rows = db.prepare(`SELECT amount_cents, voided_at FROM ${invoiceLines.TABLE} WHERE load_key = ? ORDER BY id`).all(key);
		const active = rows.filter((r) => r.voided_at === null);
		const sum = active.reduce((s, r) => s + Number(r.amount_cents), 0);
		linesNow = active.length ? (sum === advanceCents ? "same" : "differs") : rows.length ? "voided" : "none";
	}
	let invoicedNow = false;
	let billedNow = null;
	if (draftCols) {
		const cols = ["load_id", "total", ...(draftCols.has("gross_total") ? ["gross_total"] : [])];
		const drafts = db.prepare(`SELECT ${cols.join(", ")} FROM load_invoice_drafts ORDER BY id`).all().filter((d) => invoiceLines.loadKey(d.load_id) === key);
		if (drafts.length) {
			invoicedNow = true;
			const last = drafts[drafts.length - 1];
			// A draft that printed advance lines keeps its line haul beside the balance it billed.
			billedNow = String(last.gross_total || "").trim() !== "" ? "balance" : "full";
		}
	}
	return { linesNow, invoicedNow, billedNow };
}

function buildReport({ dbPath, since, counts = false }) {
	const sinceIso = sinceInstant(since);
	if (!dbPath) throw new Error("--db=<file> is required");
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		if (!db.readonly) throw new Error("the database did not open read-only");
		const present = hasTable(db, read.TABLE);
		const rows = present
			? db.prepare(`SELECT id, load_key, at, verdict, reason, total_cents, advance_cents, new_total_cents, payment_cents, line_id, switch_on
				FROM ${read.TABLE} WHERE at >= ? ORDER BY at, id`).all(sinceIso)
			: [];
		const ctx = { linesTable: hasTable(db, invoiceLines.TABLE), draftCols: hasTable(db, "load_invoice_drafts") ? columnsOf(db, "load_invoice_drafts") : null };
		const byLoad = new Map();
		for (const r of rows) {
			const had = byLoad.get(r.load_key);
			byLoad.set(r.load_key, { latest: r, emails: (had ? had.emails : 0) + 1 });
		}
		const loads = [...byLoad.entries()].map(([loadKey, { latest, emails }]) => ({
			loadKey, verdict: latest.verdict, reason: latest.reason, totalCents: latest.total_cents, advanceCents: latest.advance_cents, newTotalCents: latest.new_total_cents,
			paymentCents: latest.payment_cents, at: latest.at, emails, ...loadNow(db, loadKey, latest.advance_cents, ctx),
		}));
		const tally = (pick) => loads.reduce((m, l) => { const k = pick(l); if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
		const fills = loads.filter((l) => FILLS.has(l.verdict));
		const summary = {
			rows: rows.length,
			loads: loads.length,
			loadsByVerdict: ordered(tally((l) => l.verdict), VERDICT_ORDER),
			wouldFillCents: fills.filter((l) => l.verdict === "would_fill").reduce((s, l) => s + l.advanceCents, 0),
			filledCents: fills.filter((l) => l.verdict === "filled").reduce((s, l) => s + l.advanceCents, 0),
			personReasons: sortedCounts(tally((l) => (PEOPLE.has(l.verdict) ? l.reason : ""))),
			sameReasons: sortedCounts(tally((l) => (l.verdict === "same" ? l.reason : ""))),
			fillsNow: {
				lines: sortedCounts(tally((l) => (FILLS.has(l.verdict) ? l.linesNow : ""))),
				invoiced: fills.filter((l) => l.invoicedNow).length,
				billed: sortedCounts(tally((l) => (FILLS.has(l.verdict) && l.billedNow ? l.billedNow : ""))),
			},
		};
		const zone = appTime.appTimeZone();
		const when = (iso) => appTime.dateTextInZone(new Date(iso), appTime.businessZoneAt(new Date(iso), zone), { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
		const list = (o) => (Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") : "none");
		const lines = [
			`Advance read decisions since ${when(sinceIso)}${present ? "" : " (no ratecon_advance_reads table: nothing recorded)"}`,
			`${summary.rows} email(s) on ${summary.loads} load(s). Each load's latest: ${list(summary.loadsByVerdict)}`,
			`Would fill with the switch on: ${fills.filter((l) => l.verdict === "would_fill").length} load(s), advances ${money(summary.wouldFillCents)}; filled: ${fills.filter((l) => l.verdict === "filled").length} load(s), ${money(summary.filledCents)}`,
			`To a person, by reason: ${list(summary.personReasons)}`,
			`Already holding the advance: ${list(summary.sameReasons)}`,
			`The loads it would fill or filled, now: lines ${list(summary.fillsNow.lines)}; an invoice made on ${summary.fillsNow.invoiced} (billed: ${list(summary.fillsNow.billed)})`,
		];
		if (!counts) {
			lines.push("Per load (latest decision):");
			for (const l of loads) {
				lines.push(`  ${l.loadKey}  ${l.verdict} ${l.reason}  advance ${money(l.advanceCents)} (Total ${money(l.totalCents)}, New Total ${money(l.newTotalCents)}; Payment ${l.paymentCents === null ? "not one amount" : money(l.paymentCents)})`
					+ `  ${l.emails} email(s); lines now ${l.linesNow}; invoice made ${l.invoicedNow ? `yes, billed ${l.billedNow}` : "no"}`);
			}
		}
		lines.push("Not counted here:", ...NOT_COUNTED.map((n) => `  - ${n}`));
		return { since: sinceIso, present, summary, loads: counts ? [] : loads, notCounted: NOT_COUNTED, text: lines.join("\n") };
	} finally {
		db.close();
	}
}

// The reader's figure gate over every PDF in `dir` (not its subfolders): what the read would
// make of each rate con's figures alone, before any load is looked at. Counts only.
function replayPdfDir({ dir }) {
	const names = fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f)).sort().slice(0, REPLAY_MAX_FILES);
	const counts = Object.fromEntries(REPLAY_ORDER.map((k) => [k, 0]));
	let tooLarge = 0;
	for (const name of names) {
		const file = path.join(dir, name);
		const stat = fs.statSync(file);
		if (!stat.isFile()) continue;
		if (stat.size > REPLAY_MAX_BYTES) { tooLarge++; counts.unreadable++; continue; }
		const reading = read.readAdvanceFigures(shownText(fs.readFileSync(file)));
		const d = read.decide({ reading, paymentCents: reading.totalCents, invoiced: false, lines: { activeCount: 0, activeCents: 0, voidedCount: 0, ownOnly: true } });
		const key = d.verdict === "fill" ? "sum_checks" : d.verdict === "unread" ? "unreadable" : d.verdict === "none" ? "no_labels" : d.reason;
		counts[key] = (counts[key] || 0) + 1;
	}
	const text = [
		`Rate-con PDFs read: ${names.length}${tooLarge ? ` (${tooLarge} over the size the server reads, counted unreadable)` : ""}`,
		`The figure gate: ${REPLAY_ORDER.map((k) => `${k} ${counts[k]}`).join(", ")}`,
		"sum_checks is what the read would fill on a load whose Payment is the Total, with no line and no invoice yet.",
	].join("\n");
	return { files: names.length, counts, text };
}

function main() {
	const args = Object.fromEntries(process.argv.slice(2).map((a) => {
		const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
		return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
	}));
	const known = new Set(["since", "db", "counts", "json", "pdf-dir"]);
	const unknown = Object.keys(args).filter((k) => !known.has(k));
	const refuse = (why) => { console.error(`REFUSED: ${why}`); process.exit(2); };
	if (unknown.length) refuse(`unknown argument(s) ${unknown.join(", ")}`);
	let out;
	try {
		if (typeof args["pdf-dir"] === "string") {
			if (args.db || args.since) refuse("--pdf-dir takes no --db or --since");
			out = replayPdfDir({ dir: path.resolve(args["pdf-dir"]) });
		} else {
			if (typeof args.db !== "string" || !args.db) refuse("--db=<file> is required (no default: name the database to read)");
			if (typeof args.since !== "string" || !args.since) refuse("--since=<YYYY-MM-DD or ISO time> is required");
			out = buildReport({ dbPath: path.resolve(args.db), since: args.since, counts: args.counts === true });
		}
	} catch (e) {
		refuse(e.message);
	}
	console.log(args.json ? JSON.stringify(out, null, 2) : out.text);
}

if (require.main === module) main();

module.exports = { buildReport, replayPdfDir };
