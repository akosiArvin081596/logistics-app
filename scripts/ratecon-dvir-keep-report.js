#!/usr/bin/env node
// Read-only switch-on report for RATECON_DVIR_KEEP_ENABLED: what POST
// /api/n8n/keep-stored-values recorded in ratecon_dvir_decisions since a date, in counts
// and cents only (no load number), by business month and verdict. Open loads are counted
// apart from protected ones (delivered, invoiced or status unknown), whose Payment the
// re-issue hold already keeps, so the switch changes only their alert.
//
//   node scripts/ratecon-dvir-keep-report.js --since=2026-11-16 [--db=app.db] [--json]
//
// --since: a date (YYYY-MM-DD, from 00:00 APP_TIMEZONE) or an ISO time with a zone. --db:
// the database (default DATABASE_PATH, else app.db beside server.js), opened read-only; a
// missing file is refused, never created. Reads no sheet, no settings file, nothing else.
// Exit 0; 2 on a refused argument.

"use strict";

const path = require("path");
const appTime = require("../lib/app-time");
const { money } = require("../lib/ratecon-dvir");
const { sinceInstant } = require("./person-edit-hold-report");

const ROOT = path.join(__dirname, "..");
const VERDICTS = ["would_keep", "would_hold", "kept", "held"];
const HOLDS = new Set(["would_hold", "held"]);
// What it can't count, reading no sheet: the lead counts these read-only on production.
const NOT_COUNTED = [
	"which of these loads have a percentage-paid driver (Job Tracking's Driver, then the driver's pay type)",
	"how many of these loads are in a closed month (must be 0: the rule skips a load a hold of every column covers)",
];

// One group's figures. A change (load, stored and sent cents) seen in several emails is
// counted once in loads and cents.
function tally(rows) {
	const changes = new Map();
	for (const r of rows) changes.set(`${r.load_key}|${r.stored_cents}|${r.sent_cents}`, r);
	let dropCents = 0;
	let dvirCents = 0;
	for (const r of changes.values()) {
		dropCents += r.stored_cents - r.sent_cents;
		dvirCents += r.dvir_cents;
	}
	return { emails: rows.length, loads: new Set(rows.map((r) => r.load_key)).size, changes: changes.size, dropCents, dvirCents };
}

const countBy = (rows, key) => rows.reduce((m, r) => ({ ...m, [r[key]]: (m[r[key]] || 0) + 1 }), {});

function buildReport({ dbPath, since }) {
	const sinceIso = sinceInstant(since);
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		if (!db.readonly) throw new Error("the database did not open read-only");
		const present = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ratecon_dvir_decisions'").get());
		const rows = present
			? db.prepare(`SELECT load_key, at, stored_cents, sent_cents, dvir_cents, dvir_count, reading, verdict, reason, switch_on, protected_load
				FROM ratecon_dvir_decisions WHERE at >= ? ORDER BY at, id`).all(sinceIso)
			: [];
		const monthOf = (iso) => appTime.businessDayOf(new Date(iso)).slice(0, 7);
		const months = [...new Set(rows.map((r) => monthOf(r.at)))].sort();
		const byMonth = months.map((month) => {
			const inMonth = rows.filter((r) => monthOf(r.at) === month);
			const verdicts = {};
			for (const v of VERDICTS) {
				const of = inMonth.filter((r) => r.verdict === v);
				if (!of.length) continue;
				verdicts[v] = { open: tally(of.filter((r) => !r.protected_load)), protected: tally(of.filter((r) => r.protected_load)) };
			}
			return { month, verdicts };
		});
		const holds = rows.filter((r) => HOLDS.has(r.verdict));
		const unread = holds.filter((r) => r.reading !== "readable").length;
		const openWould = rows.filter((r) => !r.protected_load && (r.verdict === "would_keep" || r.verdict === "would_hold"));
		const summary = {
			rows: rows.length,
			loads: new Set(rows.map((r) => r.load_key)).size,
			verdicts: countBy(rows, "verdict"),
			holdReadings: countBy(holds, "reading"),
			holdReasons: countBy(holds, "reason"),
			unreadShareOfHolds: holds.length ? unread / holds.length : null,
			switchOnWouldKeep: tally(openWould),
		};
		const zone = appTime.appTimeZone();
		const when = (iso) => appTime.dateTextInZone(new Date(iso), appTime.businessZoneAt(new Date(iso), zone), { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
		const fig = (t) => `${t.emails} email(s), ${t.loads} load(s), ${t.changes} change(s), Payment drop ${money(t.dropCents)}, DVIR ${money(t.dvirCents)}`;
		const lines = [
			`DVIR keep decisions since ${when(sinceIso)}${present ? "" : " (no ratecon_dvir_decisions table: nothing recorded)"}`,
			`${summary.rows} decision(s) on ${summary.loads} load(s): ${VERDICTS.map((v) => `${v} ${summary.verdicts[v] || 0}`).join(", ")}`,
			...byMonth.flatMap((m) => [
				`${m.month}:`,
				...Object.entries(m.verdicts).flatMap(([v, t]) => [`  ${v}, open loads: ${fig(t.open)}`, `  ${v}, protected loads: ${fig(t.protected)}`]),
			]),
			`On switch-on, Payment would keep on open loads: ${fig(summary.switchOnWouldKeep)}`,
			`Holds by reading: ${["none", "unreadable", "readable"].map((s) => `${s} ${summary.holdReadings[s] || 0}`).join(", ")}`
				+ (summary.unreadShareOfHolds === null ? "" : ` (no readable text: ${Math.round(summary.unreadShareOfHolds * 100)}% of holds)`),
			`Holds by reason: ${["unread", "no_dvir_line", "disagrees", "other_money"].map((s) => `${s} ${summary.holdReasons[s] || 0}`).join(", ")}`,
			"Not counted here (no sheet is read):",
			...NOT_COUNTED.map((n) => `  - ${n}`),
		];
		return { since: sinceIso, present, summary, byMonth, notCounted: NOT_COUNTED, text: lines.join("\n") };
	} finally {
		db.close();
	}
}

function main() {
	const args = Object.fromEntries(process.argv.slice(2).map((a) => {
		const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
		return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
	}));
	const known = new Set(["since", "db", "json"]);
	const unknown = Object.keys(args).filter((k) => !known.has(k));
	if (unknown.length) { console.error(`REFUSED: unknown argument(s) ${unknown.join(", ")}`); process.exit(2); }
	if (!args.since || args.since === true) { console.error("REFUSED: --since=<YYYY-MM-DD or ISO time> is required"); process.exit(2); }
	const dbPath = typeof args.db === "string" ? path.resolve(args.db) : (process.env.DATABASE_PATH || path.join(ROOT, "app.db"));
	let out;
	try {
		out = buildReport({ dbPath, since: args.since });
	} catch (e) {
		console.error(`REFUSED: ${e.message}`);
		process.exit(2);
	}
	console.log(args.json ? JSON.stringify(out, null, 2) : out.text);
}

if (require.main === module) main();

module.exports = { buildReport };
