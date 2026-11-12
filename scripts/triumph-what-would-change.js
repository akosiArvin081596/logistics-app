#!/usr/bin/env node
// The "what would change" report before Triumph goes on: for the loads delivered in a
// window that the owner's answer covers, what the button or the job drafted (those stop
// being emailed), what the free checks would say, and how big their batches would be.
// Read-only, counts and broker domains only: no load ID, name, address or amount, and no
// Drive or Gemini call.
//
//   node scripts/triumph-what-would-change.js --db=<app.db>
//     (--sheets-json=<sheets.json> | --values-json=<values.json>) (--domains=<d>[,<d>...] | --marked)
//     [--uploads=<uploads folder>] [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--json]
//
// --domains: every load on those broker email domains (exact, a subdomain isn't one).
// --marked: the loads marked factored now.
// The free checks run twice: as things stand, and as if the load had been factored from
// the start with its broker set up, which is the split that says what would stop a real
// load (no draft row counts, no month is closed, the domain is confirmed, a debtor name
// and the assignment lines exist).
// Windows and the sheet are read as scripts/auto-invoice-shadow-report.js --retro reads
// them; the default is the 60 days ending today. Without --uploads, a POD row counts as
// readable and the batch sizes aren't measured, and the report says so.
// Writes nothing, opens no connection, reads no settings. Exit 0; 2 on a refused
// argument; 1 on any other failure.

"use strict";

const fs = require("fs");
const path = require("path");
const rules = require("../lib/auto-invoice-rules");
const ledger = require("../lib/auto-invoice-ledger");
const factoring = require("../lib/factoring-store");
const triumphRules = require("../lib/triumph-rules");
const appTime = require("../lib/app-time");
const { readValues, liftSheetHelpers, windowOf } = require("./auto-invoice-shadow-report");
const sizeReport = require("./triumph-batch-size-report");

const { refused } = sizeReport;
const KNOWN_ARGS = new Set(["db", "sheets-json", "values-json", "uploads", "since", "until", "domains", "marked", "json"]);
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/.exec(String(a));
		if (!m || !KNOWN_ARGS.has(m[1])) throw refused(`unknown argument ${JSON.stringify(String(a).slice(0, 40))}`);
		out[m[1]] = m[2] === undefined ? true : m[2];
	}
	return out;
}

function coveredDomains(args) {
	if (Boolean(args.marked) === (args.domains !== undefined)) throw refused("give exactly one of --domains and --marked");
	if (args.marked) return null;
	const domains = String(args.domains === true ? "" : args.domains).split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
	if (!domains.length || !domains.every((d) => DOMAIN_RE.test(d))) throw refused("--domains takes broker email domains, separated by commas");
	return new Set(domains);
}

const bump = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };
const verdictKey = (v) => (v.code ? `${v.state} ${v.code}` : v.state);
const stampDay = (stamp, zone) => {
	const s = String(stamp || "");
	const ms = Date.parse(/[zZ]$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
	return Number.isFinite(ms) ? appTime.dayInZone(new Date(ms), zone) : "";
};

function build({ values, db, uploadsDir = "", domains, since, until, zone = appTime.appTimeZone(), helpers = liftSheetHelpers(), today = appTime.dayInZone(new Date(), zone) }) {
	const win = windowOf({ since, until, today });
	const parsed = helpers.parseSheet({ values });
	const rows = helpers.deduplicateLoads(parsed.data, parsed.headers);
	const cols = rules.jobColumns(parsed.headers);
	if (!cols.loadIdCol || !cols.statusCol) throw refused("the Job Tracking copy has no Load ID or status column");
	const records = rules.indexRecords(ledger.readRecords(db));
	const settings = ledger.readSettings(db);
	const marked = factoring.factoredKeys(db);
	const sizing = uploadsDir ? sizeReport.batchSizes(sizeReport.readDocuments(db, uploadsDir)) : null;
	const podReadable = uploadsDir
		? (doc) => {
			if (String(doc.drive_file_id || "")) return true;
			const file = rules.documentLocalPath(uploadsDir, doc);
			return Boolean(file) && fs.existsSync(file);
		}
		: null;

	const out = { window: win, covered: 0, dateUnknown: 0, drafted: { button: 0, job: 0, none: 0 }, perDomain: {}, asItStands: {}, ifSetUp: {} };
	const sizes = [];
	for (const row of rows) {
		const key = rules.loadKey(row[cols.loadIdCol]);
		if (!key) continue;
		const rec = records.get(key);
		const facts = rules.loadFacts({ row, cols, records: rec, podReadable, confirmedDomains: settings.confirmedBrokerDomains,
			activeAdvanceLines: rules.isCompletedStatus(row[cols.statusCol]) ? ledger.activeAdvanceLines(db, key) : 0, factored: marked.has(key) });
		if (!facts.completed || !facts.live) continue;
		if (domains ? !domains.has(facts.brokerDomain) : !marked.has(key)) continue;
		let day = helpers.sheetDayKey(cols.completionCol ? row[cols.completionCol] : "");
		if (!day && rec && rec.pods.length) day = stampDay(rec.pods[0].uploaded_at, zone);
		if (!day) {
			out.dateUnknown++;
			continue;
		}
		if (day < win.since || day > win.until) continue;
		out.covered++;
		bump(out.perDomain, facts.brokerDomain || "(no broker email)");
		const draftVias = rec ? rec.drafts.map((d) => String(d.via || "")) : [];
		if (draftVias.some((via) => rules.isJobVia(via))) out.drafted.job++;
		else if (draftVias.length) out.drafted.button++;
		else out.drafted.none++;
		bump(out.asItStands, verdictKey(triumphRules.freeVerdict(facts, { checkMonth: false })));
		bump(out.ifSetUp, verdictKey(triumphRules.freeVerdict({ ...facts, brokerDomainConfirmed: true }, { debtorName: "(set up)", hasLines: true, ownDrafts: facts.drafts, checkMonth: false })));
		if (sizing && sizing.sizes.has(key)) sizes.push(sizing.sizes.get(key));
	}
	out.sizes = sizing ? { ...sizeReport.distribution(sizes), missingFilesAllLoads: sizing.missingFiles, rateConsStoodInAllLoads: sizing.rateConsStoodIn } : null;
	const lines = (counts) => Object.keys(counts).sort().map((k) => `  ${k}: ${counts[k]}`);
	out.text = [
		`Window: ${win.since} to ${win.until}`,
		`Loads covered: ${out.covered}; delivered on a date nothing states: ${out.dateUnknown}`,
		`Drafted already, which would stop being emailed: by the button ${out.drafted.button}, by the job ${out.drafted.job}; not drafted ${out.drafted.none}`,
		"Per broker domain:",
		...lines(out.perDomain),
		"The free checks as things stand:",
		...lines(out.asItStands),
		"The free checks as if factored from the start and set up:",
		...lines(out.ifSetUp),
		out.sizes
			? `Estimated batch bytes: p50 ${out.sizes.p50} p90 ${out.sizes.p90} p95 ${out.sizes.p95} max ${out.sizes.max}; at or over the limit ${out.sizes.atOrOverLimit}; at or over ${sizeReport.NEAR_LIMIT_BYTES} ${out.sizes.atOrOverNearLimit}`
			: "Batch sizes: not measured (no --uploads), and a POD row counted as readable.",
	].join("\n");
	return out;
}

function run(argv) {
	const args = parseArgs(argv);
	if (typeof args.db !== "string" || !args.db) throw refused("--db=<app.db> is required");
	for (const k of ["sheets-json", "values-json", "uploads", "since", "until"]) {
		if (args[k] === true) throw refused(`--${k} needs a value`);
	}
	const domains = coveredDomains(args);
	const values = readValues({ valuesJson: args["values-json"], sheetsJson: args["sheets-json"] });
	const uploadsDir = args.uploads ? path.resolve(args.uploads) : "";
	if (uploadsDir && !(fs.existsSync(uploadsDir) && fs.statSync(uploadsDir).isDirectory())) throw refused("--uploads is not a folder");
	const db = sizeReport.openReadOnly(path.resolve(args.db));
	try {
		return { args, out: build({ values, db, uploadsDir, domains, since: args.since, until: args.until }) };
	} finally {
		db.close();
	}
}

function main() {
	let result;
	try {
		result = run(process.argv.slice(2));
	} catch (e) {
		if (!e.refused) {
			console.error(`FAILED: ${e.stack || e.message}`);
			process.exit(1);
		}
		console.error(`REFUSED: ${e.message}`);
		process.exit(2);
	}
	const { args, out } = result;
	if (args.json) {
		const { text: _text, ...json } = out;
		console.log(JSON.stringify(json, null, 2));
	} else {
		console.log(out.text);
	}
}

if (require.main === module) main();

module.exports = { run, build };
