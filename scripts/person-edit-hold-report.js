#!/usr/bin/env node
// Read-only shadow report for RATECON_PERSON_EDIT_HOLD_ENABLED (PERSON EDIT HOLD,
// 2026-10-22). With the flag off, POST /api/n8n/keep-stored-values records a
// "would_hold" row in load_cell_writes each time it would have kept a date a person
// set (and written the email's date instead, as today); with it on, a "held" row
// each time it kept one. A "format" row is a comparison that turned on a date form
// lib/cell-compare.js momentKey() can't read: never a hold.
//
// This lists those rows since a date, by Load ID suffix and column, with the stored
// (person's) date and the email's date, and marks a "would_hold" whose two dates are
// the same calendar day under a looser reading (personEditHold.formatOnly()) as
// "format only". Switch-on needs zero "format" rows and zero "format only" rows (the
// plan's R2 M2).
//
//   node scripts/person-edit-hold-report.js --since=2026-10-23 [--db=app.db] [--json]
//
// --since: a date (YYYY-MM-DD, from 00:00 APP_TIMEZONE, US Eastern unless set) or an
// ISO time. --db: the database (default DATABASE_PATH, else app.db beside server.js),
// opened read-only; a missing file is refused, never created. Load IDs are shown as
// their last four characters only. Reads no sheet, no .env, nothing else. Exit 0;
// 2 on a refused argument.

"use strict";

const path = require("path");
const personEditHold = require("../lib/person-edit-hold");
const appTime = require("../lib/app-time");

const ROOT = path.join(__dirname, "..");
const SHADOW = ["would_hold", "held", "format"];

// --since as an ISO instant.
function sinceInstant(since) {
	const s = String(since == null ? "" : since).trim();
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
	if (day) {
		const ms = appTime.wallClockToMs(appTime.appTimeZone(), Number(day[1]), Number(day[2]), Number(day[3]), 0, 0, 0);
		return new Date(ms).toISOString();
	}
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s))) {
		return new Date(Date.parse(s)).toISOString();
	}
	throw new Error(`--since must be a date (YYYY-MM-DD) or an ISO time with a zone, not ${JSON.stringify(s.slice(0, 40))}`);
}

function suffix(key) {
	const k = String(key == null ? "" : key);
	return k.length > 4 ? `...${k.slice(-4)}` : k;
}

function buildReport({ dbPath, since }) {
	const sinceIso = sinceInstant(since);
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		if (!db.readonly) throw new Error("the database did not open read-only");
		const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'load_cell_writes'").get();
		const raw = present
			? db.prepare(`SELECT load_key, column_name, source, value, stored_value, at FROM load_cell_writes
				WHERE source IN (${SHADOW.map(() => "?").join(", ")}) AND at >= ? ORDER BY at, id`).all(...SHADOW, sinceIso)
			: [];
		const rows = raw.map((r) => ({
			load: suffix(r.load_key),
			column: r.column_name,
			source: r.source,
			at: r.at,
			stored: r.stored_value,
			email: r.value,
			formatOnly: r.source === "would_hold" && personEditHold.formatOnly(r.value, r.stored_value),
		}));
		const counts = {
			would_hold: rows.filter((r) => r.source === "would_hold").length,
			held: rows.filter((r) => r.source === "held").length,
			format: rows.filter((r) => r.source === "format").length,
			formatOnly: rows.filter((r) => r.formatOnly).length,
		};
		const switchOnReady = counts.format === 0 && counts.formatOnly === 0;
		const zone = appTime.appTimeZone();
		const when = (iso) => appTime.dateTextInZone(new Date(iso), zone, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
		const lines = [
			`Person edit hold, shadow report since ${when(sinceIso)}${present ? "" : " (no load_cell_writes table yet)"}`,
			`would_hold ${counts.would_hold} (format only ${counts.formatOnly}), held ${counts.held}, format ${counts.format}`,
			...rows.map((r) => `${when(r.at)}  load ${r.load}  ${r.column}  ${r.source}${r.formatOnly ? " (format only)" : ""}: stored "${r.stored}", email "${r.email}"`),
			switchOnReady
				? "Switch-on condition met: no format rows and no format-only would_hold rows."
				: "Switch-on condition NOT met: format rows or format-only would_hold rows are listed above.",
		];
		return { since: sinceIso, rows, counts, switchOnReady, text: lines.join("\n") };
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

module.exports = { buildReport, sinceInstant };
