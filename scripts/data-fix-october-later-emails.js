#!/usr/bin/env node
// scripts/data-fix-october-later-emails.js — restores what a later rate-con email
// overwrote on six October loads in Job Tracking.
//
// n8n's JOB DETAILS ENTRY wrote each rate-con email's values over the load's row
// (appendOrUpdate on Load ID), so a later email for a load already on file ("Booked
// Load #" after the confirmation) re-stamped Assigned Date with its own date and
// wrote a blank over the Broker Contact Name it left out. #458 stops it; this puts
// back what n8n's stored executions show the first email wrote (client rule,
// 2026-10-09: a later email never overwrites a stored value with a blank, and
// Assigned Date is set once, when the load is first assigned).
//
// Only October loads whose first and later Assigned Date are both in October: the
// month a load's revenue and pay count in does not move, so no figure does. Loads
// first assigned in a finalized month are not touched (the report proposes those).
//
// Each cell is restored only when the sheet still holds exactly what the later email
// wrote; a cell already restored is skipped as done, anything else is skipped and
// said, never guessed. Broker Contact Name values are people's names, so this
// public file holds only their SHA-256: --names-stdin reads {"<load id>": "<name>"}
// from stdin and a value whose hash differs is refused.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/data-fix-october-later-emails.js --db=app.db --sheet-id=<id> --dry-run [--names-stdin]
//   node scripts/data-fix-october-later-emails.js --db=app.db --sheet-id=<id> --apply --expect-cells=<n> [--names-stdin]
//   --sheet-id=<id>        the Job Tracking sheet; there is no default
//   --values-json=<file>   rehearsal: a saved values.get of Job Tracking in place of
//                          the sheet; an apply writes the result to --values-out
//   --db                   app.db in this app directory, or a copy under the temp
//                          directory (scripts/lib/ledger-world.js dbScope()); the
//                          audit rows go there, and October must not be finalized
//   --key=<file>           the service account key (default service-account-key.json)
//   --expect-cells=<n>     required to apply: the number of cells the dry run would
//                          write; any other number writes nothing
// The dry run reads with the read-only scope and opens the database read-only. An
// apply re-reads the sheet right before writing and writes nothing if any planned
// cell or row moved; it writes explicit A1 cells (USER_ENTERED, as n8n and the app
// write), reads them back, and logs each change in audit_trail as a system change.
// Idempotent: a second apply finds every cell restored and writes nothing.
// Exit codes: 0 done, 1 error, 2 refused (nothing written), 4 the sheet moved
// between the plan and the write (nothing written).
// Required as a module (by its test runner) it runs nothing and exports its parts.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createRequire } = require("module");
const { parseArgs, dbScope } = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");
const ACTOR = "script:data-fix-october-later-emails";
const REF = "N8N-LATER-2026-10";
const MONTH = "2026-10";
const OPTIONS = ["db", "sheet-id", "values-json", "values-out", "key", "dry-run", "apply", "expect-cells", "names-stdin"];
// sha256 of the broker contact the first email named (n8n's stored executions).
const BROKER = "ef81b7a2d7e46b6fcd29388425694808b67847037f4f3472d09c7bc09ba99e2d";

// From n8n's stored executions of "Dispatch v2 (Fixed)": the Assigned Date the first
// email wrote (`original`) and the one the later email wrote (`wrote`, its date), and
// whether the later email blanked the Broker Contact Name.
const FIXES = Object.freeze([
	{ load: "570187357", original: "10/6/2026, 9:21:43 AM", wrote: "10/8/2026, 7:48:18 AM", broker: BROKER, laterEmail: "2026-10-08 (execution 2812)" },
	{ load: "570256702", original: "10/5/2026, 10:50:50 AM", wrote: "10/7/2026, 7:49:43 AM", broker: BROKER, laterEmail: "2026-10-07 (execution 2795)" },
	{ load: "570341066", original: "10/1/2026, 2:50:16 PM", wrote: "10/6/2026, 7:50:09 AM", broker: BROKER, laterEmail: "2026-10-06 (execution 2780)" },
	{ load: "570617086", original: "10/5/2026, 10:04:23 AM", wrote: "10/7/2026, 3:51:39 PM", broker: null, laterEmail: "2026-10-07 (execution 2802)" },
	{ load: "570627321", original: "10/5/2026, 9:58:32 AM", wrote: "10/7/2026, 7:46:59 AM", broker: BROKER, laterEmail: "2026-10-07 (execution 2792)" },
	{ load: "570926462", original: "10/7/2026, 3:58:28 PM", wrote: "10/7/2026, 3:59:21 PM", broker: null, laterEmail: "2026-10-07 (execution 2808)" },
].map(Object.freeze));

class Refusal extends Error {}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const blank = (v) => v === undefined || v === null || String(v).trim() === "";
// "10/6/2026, 9:21:43 AM" -> "2026-10"
const monthOf = (stamp) => {
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(String(stamp || "").trim());
	return m ? `${m[3]}-${m[1].padStart(2, "0")}` : "";
};
// 0-based column index -> A1 letters.
const colLetter = (i) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

// The cells to write, from the sheet as it stands: [{ load, column, range, before,
// after, why }], plus { done, skipped } lines. `names` maps a load to the broker
// contact supplied on stdin (or is empty); `fixes` is FIXES unless a test passes
// its own. Throws Refusal on a sheet it can't read.
function plan(values, names = {}, fixes = FIXES) {
	const rows = values || [];
	const header = (rows[0] || []).map((h) => String(h));
	const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
	const iLoad = col("Load ID");
	const iAssigned = col("Assigned Date");
	const iBroker = col("Broker Contact Name");
	if (iLoad === -1 || iAssigned === -1 || iBroker === -1) throw new Refusal("Job Tracking has no Load ID, Assigned Date or Broker Contact Name column");
	const cells = [];
	const done = [];
	const skipped = [];
	for (const f of fixes) {
		if (monthOf(f.original) !== MONTH || monthOf(f.wrote) !== MONTH) { skipped.push(`${f.load}: its Assigned Dates are not both in ${MONTH}`); continue; }
		const hits = [];
		rows.forEach((r, i) => { if (i > 0 && String(r[iLoad] == null ? "" : r[iLoad]).trim() === f.load) hits.push(i); });
		if (hits.length !== 1) { skipped.push(`${f.load}: ${hits.length} rows carry this Load ID, not one`); continue; }
		const i = hits[0];
		const row = rows[i];
		const sheetRow = i + 1;
		const nowAssigned = String(row[iAssigned] == null ? "" : row[iAssigned]);
		if (nowAssigned === f.original) done.push(`${f.load}: Assigned Date is ${f.original} already`);
		else if (nowAssigned === f.wrote) cells.push({ load: f.load, column: "Assigned Date", range: `'Job Tracking'!${colLetter(iAssigned)}${sheetRow}`, before: f.wrote, after: f.original, why: `re-stamped by a later rate-con email on ${f.laterEmail}` });
		else skipped.push(`${f.load}: Assigned Date is ${JSON.stringify(nowAssigned)}, neither the later email's ${f.wrote} nor the first ${f.original}`);
		if (!f.broker) continue;
		const nowBroker = String(row[iBroker] == null ? "" : row[iBroker]);
		const name = names[f.load];
		if (!blank(nowBroker)) {
			if (sha(nowBroker) === f.broker) done.push(`${f.load}: Broker Contact Name is restored already`);
			else skipped.push(`${f.load}: Broker Contact Name was filled in since (not the first email's), left as it is`);
		} else if (name === undefined) {
			skipped.push(`${f.load}: Broker Contact Name is blank; its value was not supplied (--names-stdin)`);
		} else if (sha(name) !== f.broker) {
			throw new Refusal(`the Broker Contact Name supplied for ${f.load} is not the one the first email named (its hash differs)`);
		} else {
			cells.push({ load: f.load, column: "Broker Contact Name", range: `'Job Tracking'!${colLetter(iBroker)}${sheetRow}`, before: nowBroker, after: name, why: `blanked by a later rate-con email on ${f.laterEmail}`, secret: true });
		}
	}
	return { cells, done, skipped, iLoad, header };
}

// Whether `values` still holds every planned cell's `before` on the same load's row.
function unchanged(values, p) {
	const rows = values || [];
	const header = (rows[0] || []).map((h) => String(h));
	const problems = [];
	for (const c of p.cells) {
		const m = /!([A-Z]+)(\d+)$/.exec(c.range);
		const sheetRow = Number(m[2]);
		const row = rows[sheetRow - 1] || [];
		const iLoad = header.findIndex((h) => h.trim().toLowerCase() === "load id");
		const iCol = header.findIndex((h) => h.trim().toLowerCase() === c.column.toLowerCase());
		if (String(row[iLoad] == null ? "" : row[iLoad]).trim() !== c.load) problems.push(`row ${sheetRow} no longer carries load ${c.load}`);
		else if (String(row[iCol] == null ? "" : row[iCol]) !== c.before) problems.push(`${c.load}'s ${c.column} changed since the plan`);
	}
	return problems;
}

const show = (c) => `${c.load}: ${c.column} ${c.secret ? "(blank) -> (the first email's contact)" : `${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`} (${c.why})`;

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const unknown = Object.keys(args).filter((k) => !OPTIONS.includes(k));
	if (unknown.length) throw new Refusal(`unknown option(s): ${unknown.map((k) => `--${k}`).join(", ")}`);
	const dryRun = args["dry-run"] === true;
	const apply = args.apply === true;
	if (dryRun === apply) throw new Refusal("say --dry-run or --apply (one of them)");
	if (typeof args.db !== "string") throw new Refusal("--db is required (the audit rows go there)");
	const rehearsal = typeof args["values-json"] === "string";
	if (!rehearsal && typeof args["sheet-id"] !== "string") throw new Refusal("--sheet-id (or --values-json) is required; there is no default sheet");
	if (rehearsal && apply && typeof args["values-out"] !== "string") throw new Refusal("a rehearsal apply needs --values-out=<file> for the result");
	let expect = null;
	if (args["expect-cells"] !== undefined) {
		if (typeof args["expect-cells"] !== "string" || !/^\d+$/.test(args["expect-cells"])) throw new Refusal("--expect-cells=<n> takes the dry run's cell count");
		expect = Number(args["expect-cells"]);
	}
	if (apply && expect === null) throw new Refusal("--apply needs --expect-cells=<the number of cells the dry run would write>");
	let scope;
	try { scope = dbScope(args.db, ROOT); } catch (err) { throw new Refusal(err.message); }
	let names = {};
	if (args["names-stdin"] === true) {
		try { names = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { throw new Refusal("--names-stdin: stdin is not a JSON object"); }
		if (!names || typeof names !== "object" || Array.isArray(names)) throw new Refusal("--names-stdin: stdin is not a JSON object");
	}
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const Database = appRequire("better-sqlite3");
	const db = new Database(scope.file, { readonly: !apply, fileMustExist: true });
	db.pragma("busy_timeout = 10000");
	const say = (s) => console.log(s);
	try {
		const lock = db.prepare("SELECT status FROM period_locks WHERE period = ?").get(MONTH);
		if (lock && lock.status === "locked") throw new Refusal(`${MONTH} is finalized; its loads are corrected through its reopen, not by this script`);
		let sheets = null;
		const read = async () => {
			if (rehearsal) return JSON.parse(fs.readFileSync(args["values-json"], "utf8")).values || [];
			const r = await sheets.spreadsheets.values.get({ spreadsheetId: args["sheet-id"], range: "Job Tracking" });
			return r.data.values || [];
		};
		if (!rehearsal) {
			const { google } = appRequire("googleapis");
			const keyFile = typeof args.key === "string" ? args.key : path.join(ROOT, "service-account-key.json");
			const scopes = [apply ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly"];
			sheets = google.sheets({ version: "v4", auth: await new google.auth.GoogleAuth({ keyFile, scopes }).getClient() });
		}
		say(`Data fix ${REF}: restore what later rate-con emails overwrote on October loads. Mode: ${dryRun ? "dry run (nothing is written)" : "apply"}.`);
		const p = plan(await read(), names);
		p.done.forEach((l) => say(`done:    ${l}`));
		p.skipped.forEach((l) => say(`skipped: ${l}`));
		p.cells.forEach((c) => say(`${dryRun ? "would write" : "write"}: ${show(c)}`));
		say(`${p.cells.length} cell(s) ${dryRun ? "would be written" : "to write"}. Assigned Date stays in ${MONTH} for every load, so no load's revenue or pay month moves.`);
		if (dryRun || !p.cells.length) {
			if (apply) say("Nothing to write.");
			return 0;
		}
		if (p.cells.length !== expect) throw new Refusal(`${p.cells.length} cell(s) would be written, not the ${expect} --expect-cells names; nothing written`);
		const fresh = await read();
		const moved = unchanged(fresh, p);
		if (moved.length) { console.error(`SHEET MOVED, nothing written:\n  - ${moved.join("\n  - ")}`); return 4; }
		const data = p.cells.map((c) => ({ range: c.range, values: [[c.after]] }));
		if (rehearsal) {
			const out = fresh.map((r) => [...r]);
			for (const c of p.cells) {
				const m = /!([A-Z]+)(\d+)$/.exec(c.range);
				const iCol = p.header.findIndex((h) => h.trim().toLowerCase() === c.column.toLowerCase());
				const row = out[Number(m[2]) - 1];
				while (row.length <= iCol) row.push("");
				row[iCol] = c.after;
			}
			fs.writeFileSync(args["values-out"], JSON.stringify({ values: out }), { mode: 0o600 });
		} else {
			const resp = await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: args["sheet-id"], requestBody: { valueInputOption: "USER_ENTERED", data } });
			say(`updated cells: ${resp.data.totalUpdatedCells}`);
		}
		const after = rehearsal ? JSON.parse(fs.readFileSync(args["values-out"], "utf8")).values : await read();
		const back = plan(after, names);
		const insert = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'system', 'restore_load_field', 'load', ?, ?)");
		const now = new Date().toISOString();
		db.transaction(() => {
			for (const c of p.cells) {
				insert.run(now, ACTOR, c.load, `${c.column} ${c.secret ? "restored to the first email's contact (it was blank)" : `${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`}: ${c.why}. A later email never overwrites a stored value with a blank, and Assigned Date is set once (client, 2026-10-09) [${REF}]`);
			}
		})();
		if (back.cells.length) { console.error(`READ BACK: ${back.cells.length} cell(s) still not restored: ${back.cells.map((c) => `${c.load} ${c.column}`).join(", ")}`); return 1; }
		say(`Read back: every planned cell holds its restored value. ${p.cells.length} audit row(s) written.`);
		return 0;
	} finally {
		db.close();
	}
}

if (require.main === module) {
	main().then((code) => process.exit(code)).catch((err) => {
		if (err instanceof Refusal) { console.error(`REFUSED: ${err.message}`); process.exit(2); }
		console.error(`ERROR: ${err.stack || err.message}`);
		process.exit(1);
	});
}

module.exports = { FIXES, ACTOR, REF, MONTH, BROKER, plan, unchanged, monthOf, colLetter, Refusal };
