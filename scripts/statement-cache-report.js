#!/usr/bin/env node
// Read-only: how many stored investor statements are served from their file
// now, under the running template hash, and how many would be after a change,
// under the hash the change will serve with. Counts only: no name, id, month or
// file name is printed.
//
//   node scripts/statement-cache-report.js --db <the app's database> \
//     --statements-dir <its storage/payout-statements folder> \
//     --now-hash <12 hex> --after-hash <12 hex>
//
// Every argument is required; there is no default target. The database is
// opened read-only (a missing file is refused, never created), and nothing is
// written anywhere. "now" is the hash the running app serves with, the value
// lib/statement-template-hash.js's effectiveStatementTemplateHash() gives in
// its tree; "after" is the one the change gives in its own.
//
// A stored statement counts as served from its file when the route's cache
// test holds (GET /api/investor/payouts/:period/statement in server.js): the
// stored name is the name the row's fingerprint gives under that hash, of the
// expected shape, for the row's own owner and month, and the file reads back
// non-empty. statementFingerprint() below is server.js's, copied;
// scripts/test-statement-bytes.js pins the two equal.
//
// Exit 0 when nothing served now stops being served after; 1 when some would
// (each re-renders and re-issues on its next download); 2 on a usage error.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const HEX12 = /^[0-9a-f]{12}$/;
const STATEMENT_FILE_RE = /^payout-\d+-\d{4}-\d{2}-[0-9a-f]{10}\.pdf$/;
// server.js's STATEMENT_TEMPLATE_VERSION, part of every fingerprint.
const STATEMENT_TEMPLATE_VERSION = 1;
const USAGE = "usage: node scripts/statement-cache-report.js --db <database> --statements-dir <folder> --now-hash <12 hex> --after-hash <12 hex>";

function statementFingerprint(row, who, hash) {
	return crypto.createHash("sha256").update(JSON.stringify([
		STATEMENT_TEMPLATE_VERSION,
		hash,
		row.owner_id, row.period, row.status,
		row.paid_at || "", row.paid_by || "",
		row.amount, row.adjustment, row.adjustment_note || "", row.adjusted_at || "",
		row.finalized_at || "", row.finalized_amount, row.finalized_breakdown || "",
		(who && who.name) || "", (who && who.company) || "",
	])).digest("hex").slice(0, 10);
}

const statementFilePrefix = (row) => `payout-${row.owner_id}-${row.period}-`;
const statementFileName = (row, who, hash) => `${statementFilePrefix(row)}${statementFingerprint(row, who, hash)}.pdf`;

function parseArgs(argv) {
	const out = {};
	const names = { "--db": "db", "--statements-dir": "dir", "--now-hash": "now", "--after-hash": "after" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const eqAt = a.indexOf("=");
		const flag = eqAt > 0 ? a.slice(0, eqAt) : a;
		if (!Object.hasOwn(names, flag)) return { error: `unknown argument ${JSON.stringify(a.slice(0, 40))}` };
		const value = eqAt > 0 ? a.slice(eqAt + 1) : argv[++i];
		out[names[flag]] = String(value ?? "").trim();
	}
	const missing = Object.entries(names).filter(([, k]) => !out[k]).map(([f]) => f);
	if (missing.length) return { error: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required (no default target)` };
	for (const k of ["now", "after"]) if (!HEX12.test(out[k])) return { error: `--${k}-hash must be 12 lower-case hex characters` };
	return out;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.error) {
		console.error(`statement-cache-report: ${args.error}`);
		console.error(USAGE);
		return 2;
	}
	let dirOk = false;
	try { dirOk = fs.statSync(args.dir).isDirectory(); } catch { dirOk = false; }
	if (!dirOk) {
		console.error("statement-cache-report: --statements-dir is not a folder");
		return 2;
	}
	const Database = require("better-sqlite3");
	let db;
	try {
		db = new Database(args.db, { readonly: true, fileMustExist: true });
	} catch (e) {
		console.error(`statement-cache-report: the database could not be opened read-only (${e.code || "error"})`);
		return 2;
	}
	try {
		let rows;
		try {
			rows = db.prepare("SELECT * FROM investor_payouts WHERE COALESCE(statement_pdf_file_name, '') != ''").all();
		} catch {
			console.error("statement-cache-report: no investor_payouts table with statement_pdf_file_name in that database");
			return 2;
		}
		// The route's own query for the names the fingerprint carries.
		const whoOf = db.prepare(
			`SELECT COALESCE(NULLIF(TRIM(i.full_name),''), NULLIF(TRIM(u.company_name),''), u.username) AS name,
			        COALESCE(NULLIF(TRIM(u.company_name),''), NULLIF(TRIM(i.carrier_name),''), '') AS company
			   FROM users u LEFT JOIN investors i ON i.user_id = u.id WHERE u.id = ?`,
		);
		const counts = { stored: rows.length, now: 0, after: 0, nowNotAfter: 0, afterNotNow: 0, unreadable: 0, staleNow: 0 };
		for (const row of rows) {
			const who = whoOf.get(row.owner_id) || { name: "Investor", company: "" };
			const stored = String(row.statement_pdf_file_name || "");
			let readable = false;
			if (STATEMENT_FILE_RE.test(stored)) {
				try { readable = fs.readFileSync(path.join(args.dir, stored)).length > 0; } catch { readable = false; }
			}
			if (!readable) counts.unreadable++;
			const served = (hash) => readable && stored.startsWith(statementFilePrefix(row)) && stored === statementFileName(row, who, hash);
			const now = served(args.now);
			const after = served(args.after);
			if (stored !== statementFileName(row, who, args.now)) counts.staleNow++;
			if (now) counts.now++;
			if (after) counts.after++;
			if (now && !after) counts.nowNotAfter++;
			if (after && !now) counts.afterNotNow++;
		}
		const lines = [
			["stored statements", counts.stored],
			["served from file now", counts.now],
			["served from file after", counts.after],
			["served now but not after (must be 0)", counts.nowNotAfter],
			["served after but not now", counts.afterNotNow],
			["stored files missing, empty or unreadable", counts.unreadable],
			["stored names that already miss now", counts.staleNow],
		];
		console.log("statement cache report (read-only; counts only)");
		console.log(`  hash now:   ${args.now}`);
		console.log(`  hash after: ${args.after}`);
		for (const [label, n] of lines) console.log(`  ${`${label}:`.padEnd(44)}${n}`);
		console.log(counts.nowNotAfter === 0
			? "OK: every statement served from its file now is still served after."
			: `ATTENTION: ${counts.nowNotAfter} statement(s) served from file now would re-render and re-issue after.`);
		return counts.nowNotAfter === 0 ? 0 : 1;
	} finally {
		db.close();
	}
}

process.exitCode = main();
