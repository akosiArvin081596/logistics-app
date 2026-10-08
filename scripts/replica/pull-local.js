#!/usr/bin/env node
// replica:pull's local steps (scripts/replica/pull.sh):
//   node pull-local.js verify <incoming>   the download is whole: the database
//                                          passes SQLite's quick_check, the
//                                          Sheets copy and settings are there
//   node pull-local.js finish <incoming>   records the copied files' counts and
//                                          sizes in the manifest, then prints
//                                          the summary (names and counts only)
"use strict";

const fs = require("fs");
const path = require("path");
const { paths, DATA_FOLDERS, readJson, writePrivate, dirStats, mib, fail } = require("./common");

const [cmd, incoming] = process.argv.slice(2);
if (!cmd || !incoming) fail("usage: pull-local.js verify|finish <incoming folder>");

function verify() {
	const Database = require(path.join(__dirname, "..", "..", "node_modules", "better-sqlite3"));
	for (const f of ["app.db", "sheets.json", "settings.env", "manifest.json"]) {
		if (!fs.existsSync(path.join(incoming, f))) fail(`the download has no ${f}`);
	}
	const db = new Database(path.join(incoming, "app.db"), { readonly: true, fileMustExist: true });
	const check = db.pragma("quick_check", { simple: true });
	db.close();
	if (check !== "ok") fail(`the downloaded database failed quick_check: ${String(check).slice(0, 200)}`);
	const sheets = readJson(path.join(incoming, "sheets.json"));
	if (sheets.format !== 1 || !Object.keys(sheets.spreadsheets || {}).length) fail("the downloaded Sheets copy is not a replica working copy");
	console.log("download verified: database quick_check ok; Sheets copy and settings present");
}

function finish() {
	const manifestFile = path.join(incoming, "manifest.json");
	const m = readJson(manifestFile);
	m.pulledAt = new Date().toISOString();
	m.files = {};
	for (const d of DATA_FOLDERS) m.files[d] = dirStats(paths.data(d));
	writePrivate(manifestFile, JSON.stringify(m, null, 2));

	const rows = m.database.rows;
	console.log(`production commit ${m.production.commit}; Node ${m.production.node}; time zone ${m.production.timeZone} (${m.production.timeZoneSource})`);
	console.log(`database: ${Object.keys(rows).length} tables, ${Object.values(rows).reduce((a, b) => a + b, 0)} rows`);
	for (const s of (m.sheets && m.sheets.spreadsheets) || []) {
		console.log(s.error ? `sheets (${s.role}): not copied (${s.error})` : `sheets (${s.role}): ${s.tabs} tabs, ${s.rows} rows`);
	}
	for (const c of (m.scrub && m.scrub.cleared) || []) console.log(`cleared ${c.table}.${c.column}: ${c.rows} row(s), ${c.how}`);
	if (m.settings) {
		console.log(`settings copied (${m.settings.copied.length}): ${m.settings.copied.join(", ") || "none"}`);
		for (const s of m.settings.skipped) console.log(`settings skipped: ${s.name} (${s.rule})`);
	}
	for (const d of DATA_FOLDERS) console.log(`files ${d}/: ${m.files[d].files} files, ${mib(m.files[d].bytes)}`);
}

if (cmd === "verify") verify();
else if (cmd === "finish") finish();
else fail(`unknown command ${cmd}`);
