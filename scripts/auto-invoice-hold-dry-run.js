#!/usr/bin/env node
// What the first change check after the hold-one-load deploy would do (AUTO_INVOICE_HOLD_ONE_LOAD),
// read only: every load whose invoice the job sent, compared with today's Job Tracking by the
// job's own rule (rules.sentChange(), as its check runs it), so the loads the first check would
// flag are known beforehand. Run it before the deploy.
//
//   SPREADSHEET_ID=<sheet> node scripts/auto-invoice-hold-dry-run.js --dry-run --db=<app.db> --key=<the service account's key file> [--json]
//   node scripts/auto-invoice-hold-dry-run.js --dry-run --db=<app.db> --values-json=<file> [--json]
//
// --dry-run: required; there is no other mode. --db: opened read-only (readonly: true, then
// query_only), and a missing file is refused. The sheet: Job Tracking read once through the Sheets
// API with the read-only scope, as scripts/lookup-load.js reads it, the sheet named by SPREADSHEET_ID
// (lib/sheet-id.js) and the key file by --key, neither with a default; or a saved values.get
// (--values-json: { values } or { data: { values } }). Parsed by server.js's own parseSheet() and
// deduplicateLoads() (scripts/auto-invoice-shadow-report.js liftSheetHelpers()), keyed as the job
// keys it (rules.keyedRows()).
//
// Prints counts only: sent loads checked; would hold, by field (a row removed in the app holds as
// removed); would log, by field; rows gone from the sheet; the stop now.
// Never a load, an address or an amount. Writes nothing and sends nothing.
// Exit 0 done; 2 refused (an argument, a database without the tables, no sheet named); 1 any other
// failure. Required as a module (by its runner) it runs nothing and exports run().

"use strict";

const fs = require("fs");
const path = require("path");
const rules = require("../lib/auto-invoice-rules");
const ledger = require("../lib/auto-invoice-ledger");
const sendRules = require("../lib/auto-invoice-send");

const KNOWN = { flags: new Set(["dry-run", "json"]), values: new Set(["db", "key", "values-json"]) };
const ARG_RE = /^--([a-z-]{1,20})(?:=(.*))?$/s;

class Refusal extends Error {}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = String(a).match(ARG_RE);
		if (!m) throw new Refusal(`unknown argument: ${String(a).slice(0, 40)}`);
		const [, name, value] = m;
		if (KNOWN.flags.has(name) && value === undefined) out[name] = true;
		else if (KNOWN.values.has(name) && value) out[name] = value;
		else throw new Refusal(`unknown or malformed argument: --${name}`);
	}
	if (!out["dry-run"]) throw new Refusal("give --dry-run: this script only reads");
	if (!out.db) throw new Refusal("--db=<app.db> is required");
	if (out.key && out["values-json"]) throw new Refusal("give --key or --values-json, not both");
	return out;
}

// One dry run on a database the caller opened read-only, against Job Tracking's values (its
// header row first), as the first check would see them. Counts only.
function run({ db, values, helpers = null }) {
	if (!ledger.hasSchema(db)) throw new Refusal("the database has no automatic-invoice tables");
	const lifted = helpers || require("./auto-invoice-shadow-report").liftSheetHelpers();
	const parsed = lifted.parseSheet({ values: Array.isArray(values) ? values : [] });
	const { cols, byKey } = rules.keyedRows(parsed.headers, lifted.deduplicateLoads(parsed.data, parsed.headers));
	const stop = ledger.getSendStop(db);
	const out = {
		dryRun: true,
		sheetRows: byKey.size,
		skipped: byKey.size === 0,
		sentLoads: 0,
		wouldHold: { loads: 0, byField: {} },
		wouldLog: { loads: 0, byField: {} },
		rowsGone: 0,
		stopped: stop ? stop.reason || "unknown" : null,
	};
	// The check skips a read with no load rows, so the dry run says so and counts nothing.
	if (out.skipped) return out;
	const records = rules.indexRecords(ledger.readRecords(db));
	const tally = (box, fields) => {
		for (const f of fields) box.byField[f] = (box.byField[f] || 0) + 1;
	};
	for (const c of ledger.listClaims(db)) {
		if (c.state !== "drafted" || !sendRules.claimSent(c)) continue;
		out.sentLoads++;
		let saved = null;
		try {
			saved = c.fingerprint_json ? JSON.parse(c.fingerprint_json) : null;
		} catch {
			saved = null;
		}
		// The fingerprint reads only the row, the load's documents and its tombstone; a row removed in the
		// app is noted on the claim, as the check reads it.
		const facts = rules.loadFacts({ row: byKey.get(c.load_key) || null, cols, records: records.get(c.load_key) });
		const s = rules.sentChange({ saved, facts, changedFields: c.changed_fields, loggedJson: c.change_logged_json, removedInApp: Boolean(c.removed_in_app_at) });
		if (s.newHold) {
			out.wouldHold.loads++;
			tally(out.wouldHold, s.hold);
		}
		if (s.logged.length) {
			out.wouldLog.loads++;
			tally(out.wouldLog, s.logged);
		}
		if (s.gone) out.rowsGone++;
	}
	return out;
}

function textOf(r) {
	const loads = (n) => `${n} load${n === 1 ? "" : "s"}`;
	const fields = (box) => (box.loads ? `: ${Object.entries(box.byField).map(([f, n]) => `${f} ${n}`).join(", ")}` : "");
	const head = "DRY RUN (nothing written, nothing sent): the first change check under AUTO_INVOICE_HOLD_ONE_LOAD, against today's sheet";
	const tail = [`  sending stopped now: ${r.stopped ? `yes (${r.stopped})` : "no"}`];
	if (r.skipped) return [head, "  the sheet read has no load rows: the first check would skip the change check", ...tail].join("\n");
	return [
		head,
		`  load rows on the sheet: ${r.sheetRows}`,
		`  sent loads checked: ${r.sentLoads}`,
		`  would hold (flagged for a person, an email each): ${loads(r.wouldHold.loads)}${fields(r.wouldHold)}`,
		`  would log (an audit row only): ${loads(r.wouldLog.loads)}${fields(r.wouldLog)}`,
		`  rows gone from the sheet (an audit row only): ${r.rowsGone}`,
		...tail,
	].join("\n");
}

// Job Tracking's values, once, with the read-only scope.
async function readJobTracking({ sheetId, keyFile }) {
	const { google } = require("googleapis");
	const auth = new google.auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
	const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
	const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Job Tracking" });
	return (res.data && res.data.values) || [];
}

function readValuesFile(file) {
	let doc = null;
	try {
		doc = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
	} catch {
		throw new Refusal("--values-json can't be read as JSON");
	}
	const values = (doc && doc.values) || (doc && doc.data && doc.data.values);
	if (!Array.isArray(values)) throw new Refusal("--values-json holds no values.get answer ({ values: [...] })");
	return values;
}

function openReadOnly(dbPath) {
	const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	if (!db.readonly) {
		db.close();
		throw new Refusal("the database did not open read-only");
	}
	db.pragma("query_only = ON");
	return db;
}

async function main(argv) {
	try {
		const args = parseArgs(argv);
		const dbPath = path.resolve(args.db);
		if (!fs.existsSync(dbPath)) throw new Refusal("--db names no file");
		let values;
		if (args["values-json"]) {
			values = readValuesFile(args["values-json"]);
		} else {
			const target = require("../lib/sheet-id").scriptSpreadsheetId(process.env, { script: "auto-invoice-hold-dry-run.js" });
			if (!target.id) throw new Refusal(target.error);
			if (!args.key) throw new Refusal("--key=<the service account's key file> is required to read the sheet; it has no default");
			values = await readJobTracking({ sheetId: target.id, keyFile: path.resolve(args.key) });
		}
		const db = openReadOnly(dbPath);
		try {
			const result = run({ db, values });
			process.stdout.write(`${args.json ? JSON.stringify(result) : textOf(result)}\n`);
		} finally {
			db.close();
		}
		return 0;
	} catch (e) {
		if (e instanceof Refusal) {
			process.stderr.write(`refused: ${e.message}\n`);
			return 2;
		}
		process.stderr.write(`failed: ${(e && e.code) || "ERROR"}\n`);
		return 1;
	}
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { run, parseArgs, textOf, main, Refusal };
