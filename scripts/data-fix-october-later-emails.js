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
// Rows are found as the app finds a load (trimmed, case-insensitive, a leading "#"
// dropped); a load on more than one row is skipped. With the app's own database the
// sheet must be that app's sheet (its .env SPREADSHEET_ID, or production's own for
// production's own folder). A rehearsal (--values-json) applies only with a copy of
// the database under the temp directory.
// After writing, each written cell is read back on its own: the row must still carry
// the load, the column its header, and the cell the restored value; anything else is
// named and the run exits 5. The audit rows are written as soon as the write call
// succeeds, and a re-run adds one for a cell it finds restored without one.
// Exit codes: 0 done (or nothing left to do), 1 error, 2 refused or every remaining
// fix skipped (nothing written), 4 the sheet moved between the plan and the write
// (nothing written), 5 written, but the read-back does not confirm every cell.
// Required as a module (by its test runner) it runs nothing and exports its parts.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createRequire } = require("module");
const { parseArgs, dbScope, envFor } = require("./lib/ledger-world");

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

// A Load ID as the app keys a load (deduplicateLoads()): trimmed, lower-case, no "#".
const loadKey = (v) => String(v == null ? "" : v).trim().toLowerCase().replace(/^#/, "");
const headerKey = (h) => String(h == null ? "" : h).trim().toLowerCase();
const cellOf = (row, i) => String(row && row[i] != null ? row[i] : "");
// "'Job Tracking'!F12" -> { col: 5, row: 12 }
function rangeAt(range) {
	const m = /!([A-Z]+)(\d+)$/.exec(range);
	const col = [...m[1]].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
	return { col, row: Number(m[2]) };
}

// The cells to write, from the sheet as it stands: { cells, done, skipped }.
// cells: [{ load, column, range, before, after, why, secret }]; done: [{ load,
// column, line }] (already restored); skipped: lines. `names` maps a load to the
// broker contact supplied on stdin (or is empty); `fixes` is FIXES unless a test
// passes its own. Throws Refusal on a sheet it can't read or a name that doesn't
// match.
function plan(values, names = {}, fixes = FIXES) {
	const rows = values || [];
	const header = (rows[0] || []).map((h) => String(h));
	const col = (name) => header.findIndex((h) => headerKey(h) === name.toLowerCase());
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
		rows.forEach((r, i) => { if (i > 0 && loadKey(r[iLoad]) === loadKey(f.load)) hits.push(i); });
		if (hits.length !== 1) { skipped.push(`${f.load}: ${hits.length} rows carry this load, not one`); continue; }
		const row = rows[hits[0]];
		const sheetRow = hits[0] + 1;
		const nowAssigned = cellOf(row, iAssigned);
		if (nowAssigned === f.original) done.push({ load: f.load, column: "Assigned Date", line: `${f.load}: Assigned Date is ${f.original} already` });
		else if (nowAssigned === f.wrote) cells.push({ load: f.load, column: "Assigned Date", range: `'Job Tracking'!${colLetter(iAssigned)}${sheetRow}`, before: f.wrote, after: f.original, why: `re-stamped by a later rate-con email on ${f.laterEmail}` });
		else skipped.push(`${f.load}: Assigned Date is ${JSON.stringify(nowAssigned)}, neither the later email's ${f.wrote} nor the first ${f.original}`);
		if (!f.broker) continue;
		const nowBroker = cellOf(row, iBroker);
		const name = names[f.load];
		if (!blank(nowBroker)) {
			if (sha(nowBroker) === f.broker) done.push({ load: f.load, column: "Broker Contact Name", line: `${f.load}: Broker Contact Name is restored already` });
			else skipped.push(`${f.load}: Broker Contact Name was filled in since (not the first email's), left as it is`);
		} else if (name === undefined) {
			skipped.push(`${f.load}: Broker Contact Name is blank; its value was not supplied (--names-stdin)`);
		} else if (sha(name) !== f.broker) {
			throw new Refusal(`the Broker Contact Name supplied for ${f.load} is not the one the first email named (its hash differs)`);
		} else {
			cells.push({ load: f.load, column: "Broker Contact Name", range: `'Job Tracking'!${colLetter(iBroker)}${sheetRow}`, before: nowBroker, after: name, why: `blanked by a later rate-con email on ${f.laterEmail}`, secret: true });
		}
	}
	return { cells, done, skipped };
}

// The problems with `values` against the planned cells: each cell's row must carry
// its load and its column the planned header, and the cell must hold `want(c)`
// (`c.before` before the write, `c.after` after it). A name cell is compared by hash
// and never printed.
function cellProblems(values, p, want) {
	const rows = values || [];
	const header = (rows[0] || []).map((h) => String(h));
	const iLoad = header.findIndex((h) => headerKey(h) === "load id");
	const problems = [];
	for (const c of p.cells) {
		const at = rangeAt(c.range);
		const row = rows[at.row - 1] || [];
		if (loadKey(cellOf(row, iLoad)) !== loadKey(c.load)) problems.push(`${c.range}: row ${at.row} carries load ${JSON.stringify(cellOf(row, iLoad))}, not ${c.load}`);
		else if (headerKey(header[at.col]) !== c.column.toLowerCase()) problems.push(`${c.range}: column ${colLetter(at.col)} is now ${JSON.stringify(header[at.col] || "")}, not ${c.column}`);
		else {
			const have = cellOf(row, at.col);
			const ok = c.secret ? (want(c) === "" ? blank(have) : sha(have) === sha(want(c))) : have === want(c);
			if (!ok) problems.push(`${c.range}: ${c.load}'s ${c.column} is ${c.secret ? "not the expected value" : JSON.stringify(have)}${c.secret ? "" : `, not ${JSON.stringify(want(c))}`}`);
		}
	}
	return problems;
}
const unchanged = (values, p) => cellProblems(values, p, (c) => c.before);
const confirmed = (values, p) => cellProblems(values, p, (c) => c.after);

const show = (c) => `${c.load}: ${c.column} ${c.secret ? "(blank) -> (the first email's contact)" : `${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`} (${c.why})`;

// The sheet an app directory's own database belongs to: its .env SPREADSHEET_ID,
// or production's own sheet for production's own folder (lib/sheet-id.js).
function appSheetId(env, root) {
	const sheetIds = require(path.join(root, "lib", "sheet-id"));
	const named = String((env && env.SPREADSHEET_ID) || "").trim();
	if (named) return named;
	return path.resolve(root) === sheetIds.PRODUCTION_DIR ? sheetIds.PRODUCTION_SPREADSHEET_ID : "";
}

// `opts` (tests): fixes, stdin (the --names-stdin text), sheets (a Sheets client),
// root (the app directory), log / err (output).
async function main(argv = process.argv.slice(2), opts = {}) {
	const fixes = opts.fixes || FIXES;
	const root = opts.root || ROOT;
	const say = opts.log || ((s) => console.log(s));
	const warn = opts.err || ((s) => console.error(s));
	const args = parseArgs(argv);
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
	let env;
	let dbFile;
	let scope;
	try { ({ scope } = dbScope(args.db, root)); ({ env, file: dbFile } = envFor({ root, dbPath: args.db })); } catch (err) { throw new Refusal(err.message); }
	if (rehearsal && apply && scope !== "copy") throw new Refusal("a rehearsal (--values-json) applies only with a copy of the database under the temp directory; the app's own audit log records changes to the sheet, not to a file");
	let production = false;
	if (!rehearsal && scope === "app") {
		const own = appSheetId(env, root);
		if (!own || own !== args["sheet-id"]) throw new Refusal("--sheet-id is not this app's own sheet; run it from the app directory whose sheet it is, so the October lock and the audit rows are that app's");
		production = own === require(path.join(root, "lib", "sheet-id")).PRODUCTION_SPREADSHEET_ID;
	}
	let names = {};
	if (args["names-stdin"] === true) {
		const text = opts.stdin !== undefined ? opts.stdin : fs.readFileSync(0, "utf8");
		try { names = JSON.parse(text || "{}"); } catch { throw new Refusal("--names-stdin: stdin is not a JSON object"); }
		if (!names || typeof names !== "object" || Array.isArray(names)) throw new Refusal("--names-stdin: stdin is not a JSON object");
	}
	const appRequire = createRequire(path.join(root, "server.js"));
	const Database = appRequire("better-sqlite3");
	const db = new Database(dbFile, { readonly: !apply, fileMustExist: true });
	db.pragma("busy_timeout = 10000");
	try {
		const lock = db.prepare("SELECT status FROM period_locks WHERE period = ?").get(MONTH);
		if (lock && lock.status === "locked") throw new Refusal(`${MONTH} is finalized; its loads are corrected through its reopen, not by this script`);
		let sheets = opts.sheets || null;
		if (!rehearsal && !sheets) {
			const { google } = appRequire("googleapis");
			const keyFile = typeof args.key === "string" ? args.key : path.join(root, "service-account-key.json");
			const scopes = [apply ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly"];
			sheets = google.sheets({ version: "v4", auth: await new google.auth.GoogleAuth({ keyFile, scopes }).getClient() });
		}
		const read = async () => {
			if (rehearsal) return JSON.parse(fs.readFileSync(args["values-json"], "utf8")).values || [];
			const r = await sheets.spreadsheets.values.get({ spreadsheetId: args["sheet-id"], range: "Job Tracking" });
			return r.data.values || [];
		};
		say(`Data fix ${REF}: restore what later rate-con emails overwrote on October loads${production ? " (PRODUCTION sheet)" : ""}. Mode: ${dryRun ? "dry run (nothing is written)" : "apply"}.`);
		const p = plan(await read(), names, fixes);
		p.done.forEach((d) => say(`done:    ${d.line}`));
		p.skipped.forEach((l) => say(`skipped: ${l}`));
		p.cells.forEach((c) => say(`${dryRun ? "would write" : "write"}: ${show(c)}`));
		say(`${p.cells.length} cell(s) ${dryRun ? "would be written" : "to write"}. Assigned Date stays in ${MONTH} for every load, so no load's revenue or pay month moves.`);
		if (dryRun) return 0;
		const insert = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'system', 'restore_load_field', 'load', ?, ?)");
		const rule = "A later email never overwrites a stored value with a blank, and Assigned Date is set once (client, 2026-10-09)";
		// A cell found restored with no audit row of this script's gets one.
		const audited = (d) => !!db.prepare("SELECT 1 FROM audit_trail WHERE username = ? AND entity = 'load' AND entity_id = ? AND details LIKE ? AND details LIKE ? LIMIT 1")
			.get(ACTOR, d.load, `${d.column} %`, `%[${REF}]%`);
		const missing = p.done.filter((d) => !audited(d));
		if (missing.length) {
			const now = new Date().toISOString();
			db.transaction(() => { for (const d of missing) insert.run(now, ACTOR, d.load, `${d.column} found restored with no audit row of this script's; recorded now. ${rule} [${REF}]`); })();
			say(`${missing.length} audit row(s) added for cells found restored without one.`);
		}
		if (!p.cells.length) {
			if (p.skipped.length) { warn(`NOTHING WRITTEN: ${p.skipped.length} fix(es) skipped (above) and none left to write.`); return 2; }
			say("Nothing to write: every fix is done.");
			return 0;
		}
		if (p.cells.length !== expect) throw new Refusal(`${p.cells.length} cell(s) would be written, not the ${expect} --expect-cells names; nothing written`);
		const moved = unchanged(await read(), p);
		if (moved.length) { warn(`SHEET MOVED, nothing written:\n  - ${moved.join("\n  - ")}`); return 4; }
		const data = p.cells.map((c) => ({ range: c.range, values: [[c.after]] }));
		let updated = data.length;
		if (rehearsal) {
			const out = JSON.parse(fs.readFileSync(args["values-json"], "utf8")).values.map((r) => [...r]);
			for (const c of p.cells) {
				const at = rangeAt(c.range);
				const row = out[at.row - 1];
				while (row.length <= at.col) row.push("");
				row[at.col] = c.after;
			}
			fs.writeFileSync(args["values-out"], JSON.stringify({ values: out }), { mode: 0o600 });
		} else {
			const resp = await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: args["sheet-id"], requestBody: { valueInputOption: "USER_ENTERED", data } });
			updated = Number(resp && resp.data && resp.data.totalUpdatedCells);
		}
		// The write call succeeded: the audit rows record what was sent, before
		// anything else can fail.
		const now = new Date().toISOString();
		db.transaction(() => {
			for (const c of p.cells) {
				insert.run(now, ACTOR, c.load, `${c.column} ${c.secret ? "restored to the first email's contact (it was blank)" : `${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`}: ${c.why}. ${rule} [${REF}]`);
			}
		})();
		say(`Written: ${updated} cell(s) updated; ${p.cells.length} audit row(s) written.`);
		const after = rehearsal ? JSON.parse(fs.readFileSync(args["values-out"], "utf8")).values : await read();
		const problems = confirmed(after, p);
		if (updated !== p.cells.length) problems.unshift(`the sheet reported ${updated} updated cell(s), not ${p.cells.length}`);
		if (problems.length) { warn(`READ BACK does not confirm the write:\n  - ${problems.join("\n  - ")}`); return 5; }
		say(`Read back: each of the ${p.cells.length} cell(s) is on its load's row and column and holds its restored value.`);
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

module.exports = { FIXES, ACTOR, REF, MONTH, BROKER, plan, unchanged, confirmed, monthOf, colLetter, main, Refusal };
