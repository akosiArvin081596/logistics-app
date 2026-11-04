#!/usr/bin/env node
// scripts/passenger-authorization-report.js — what switching PASSENGER_AUTHORIZATION_ENABLED
// on would change, read-only, for the report the switch-on waits for. Counts only:
// never a name, a trip, a signature or a file name.
//
//   1. passenger_authorizations: absent, or its rows by stored status and by what
//      each reads as on today's business day (lib/passenger-authorization.js statusOf())
//   2. driver_onboarding rows by status, and onboarding_documents rows (all, signed,
//      and per document key): the onboarding the feature must never move
//
// Usage: node scripts/passenger-authorization-report.js --db=<path> [--json]
// The database is opened read-only (checked); --db is required, so the script
// never guesses which database it reads.
// Exit codes: 0 done, 1 error, 2 refused.

"use strict";

const fs = require("fs");
const path = require("path");
const { parseArgs, openDb } = require("./lib/ledger-world");
const pa = require("../lib/passenger-authorization");
const appTime = require("../lib/app-time");

const ROOT = path.join(__dirname, "..");
const STORED = ["awaiting_company", "authorized", "declined", "revoked"];
const READS_AS = ["awaiting_company", "scheduled", "active", "expired", "declined", "revoked"];

class Refusal extends Error {}

const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

function countBy(keys, rows, keyOf) {
	const out = Object.fromEntries(keys.map((k) => [k, 0]));
	for (const r of rows) {
		const k = keyOf(r);
		out[k] = (out[k] || 0) + 1;
	}
	return out;
}

function buildReport(db, todayKey) {
	const report = { today: todayKey, passengerAuthorizations: { present: false }, driverOnboarding: { present: false }, onboardingDocuments: { present: false } };
	if (tableExists(db, "passenger_authorizations")) {
		const rows = db.prepare("SELECT status, valid_from, expires_on FROM passenger_authorizations").all();
		report.passengerAuthorizations = {
			present: true,
			rows: rows.length,
			byStatus: countBy(STORED, rows, (r) => r.status),
			readsAs: countBy(READS_AS, rows, (r) => pa.statusOf(r, todayKey)),
		};
	}
	if (tableExists(db, "driver_onboarding")) {
		const rows = db.prepare("SELECT status FROM driver_onboarding").all();
		report.driverOnboarding = { present: true, rows: rows.length, byStatus: countBy([], rows, (r) => String(r.status)) };
	}
	if (tableExists(db, "onboarding_documents")) {
		const rows = db.prepare("SELECT doc_key, signed FROM onboarding_documents").all();
		const byKey = {};
		for (const r of rows) {
			const k = String(r.doc_key);
			byKey[k] = byKey[k] || { rows: 0, signed: 0 };
			byKey[k].rows++;
			if (r.signed === 1) byKey[k].signed++;
		}
		report.onboardingDocuments = { present: true, rows: rows.length, signed: rows.filter((r) => r.signed === 1).length, byDocKey: byKey };
	}
	return report;
}

function text(r) {
	const pairs = (o) => Object.entries(o).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
	const p = r.passengerAuthorizations;
	const ob = r.driverOnboarding;
	const docs = r.onboardingDocuments;
	return [
		"Passenger authorizations: what switching PASSENGER_AUTHORIZATION_ENABLED on would change (read-only; counts only)",
		`business day: ${r.today}`,
		"",
		p.present
			? `1. passenger_authorizations: present, ${p.rows} row(s); stored: ${pairs(p.byStatus)}; reads today as: ${pairs(p.readsAs)}`
			: "1. passenger_authorizations: absent (switching on creates it, empty)",
		ob.present ? `2. driver_onboarding: ${ob.rows} row(s); ${pairs(ob.byStatus)}` : "2. driver_onboarding: absent",
		docs.present
			? `   onboarding_documents: ${docs.rows} row(s), ${docs.signed} signed; ${Object.entries(docs.byDocKey).map(([k, v]) => `${k} ${v.signed}/${v.rows}`).join(", ") || "none"}`
			: "   onboarding_documents: absent",
	].join("\n");
}

// The read-only handle the report uses, refused unless SQLite says it is read-only.
function openReadOnly(file) {
	if (typeof file !== "string" || !file.trim()) throw new Refusal("--db=<path> is required");
	const resolved = path.resolve(file.trim());
	if (!fs.existsSync(resolved)) throw new Refusal(`--db ${resolved} does not exist`);
	return openDb({ root: ROOT, dbFile: resolved, readonly: true });
}

function main(argv) {
	const args = parseArgs(argv);
	const db = openReadOnly(typeof args.db === "string" ? args.db : "");
	try {
		const report = buildReport(db, appTime.appDay());
		console.log(args.json === true ? JSON.stringify(report, null, 2) : text(report));
	} finally {
		db.close();
	}
}

if (require.main === module) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		if (err instanceof Refusal) {
			console.error(`REFUSED: ${err.message}`);
			process.exit(2);
		}
		console.error(`ERROR: ${err.message}`);
		process.exit(1);
	}
}

module.exports = { buildReport, openReadOnly, text, Refusal };
