#!/usr/bin/env node
// How big one load's Triumph batch would be, against the 921,600-byte limit: the
// measurement that says whether image compaction is worth building. Read-only, aggregates
// only: no load ID, file name, name or amount.
//
//   node scripts/triumph-batch-size-report.js --db=<app.db> --uploads=<uploads folder> [--json]
//
// Per load with a live POD or BOL: the bytes on disk of its POD, BOL, lumper, scale and
// pallet files, plus its rate con's bytes (kpi_load_ratecon_miles; the median, counted on
// its own line, when it has none), plus an estimate for the invoice page and the CSV,
// which nothing has rendered here. A file missing on disk is counted and adds nothing.
//
// --db: opened read-only; a missing file is refused, never created. Writes nothing, opens
// no connection, reads no settings. Exit 0; 2 on a refused argument; 1 on any other failure.

"use strict";

const fs = require("fs");
const path = require("path");
const rules = require("../lib/auto-invoice-rules");
const triumphRules = require("../lib/triumph-rules");
const factoring = require("../lib/factoring-store");

const ROOT = path.join(__dirname, "..");
// Estimates, and the median rate con measured on the clean copy: the batch itself is what
// measures them once real batches are built.
const INVOICE_BYTES = 150000;
const CSV_BYTES = 300;
const RATECON_MEDIAN_BYTES = 89242;
const NEAR_LIMIT_BYTES = 800000;
const LIMIT_BYTES = triumphRules.BATCH_MAX_BYTES + 1;
const KNOWN_ARGS = new Set(["db", "uploads", "json"]);

function refused(msg) {
	return Object.assign(new Error(msg), { refused: true });
}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/.exec(String(a));
		if (!m || !KNOWN_ARGS.has(m[1])) throw refused(`unknown argument ${JSON.stringify(String(a).slice(0, 40))}`);
		out[m[1]] = m[2] === undefined ? true : m[2];
	}
	return out;
}

function openReadOnly(dbPath) {
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	let db;
	try {
		db = new Database(dbPath, { readonly: true, fileMustExist: true });
	} catch (e) {
		throw refused(`cannot open the database read-only: ${e.message.slice(0, 120)}`);
	}
	if (!db.readonly) {
		db.close();
		throw refused("the database did not open read-only");
	}
	return db;
}

// The live documents that would go in a batch, each with its load key and bytes on disk
// (null when missing), and every rate con's measured bytes by load key.
function readDocuments(db, uploadsDir) {
	const kinds = Object.keys(triumphRules.DOCUMENT_KINDS);
	const rows = db.prepare(`SELECT load_id, type, file_name, drive_url FROM documents WHERE deleted_at IS NULL AND UPPER(TRIM(type)) IN (${kinds.map(() => "?").join(",")})`).all(...kinds);
	const files = rows.map((doc) => {
		const file = rules.documentLocalPath(uploadsDir, doc);
		let bytes = null;
		try {
			if (file) bytes = fs.statSync(file).size;
		} catch {
			bytes = null;
		}
		return { key: rules.loadKey(doc.load_id), kind: triumphRules.documentKind(doc.type), bytes };
	}).filter((f) => f.key);
	const rateCons = new Map();
	if (factoring.hasTable(db, "kpi_load_ratecon_miles")) {
		for (const r of db.prepare("SELECT load_id, file_size FROM kpi_load_ratecon_miles").all()) {
			const key = rules.loadKey(r.load_id);
			if (key && Number(r.file_size) > 0) rateCons.set(key, Number(r.file_size));
		}
	}
	return { files, rateCons };
}

// { key -> estimated batch bytes } for the loads that have a POD or BOL, and what stood in.
function batchSizes({ files, rateCons }) {
	const sizes = new Map();
	const loads = new Set(files.filter((f) => f.kind === "pod" || f.kind === "bol").map((f) => f.key));
	let missingFiles = 0;
	let rateConsStoodIn = 0;
	for (const key of loads) {
		const rateCon = rateCons.get(key);
		if (!rateCon) rateConsStoodIn++;
		sizes.set(key, (rateCon || RATECON_MEDIAN_BYTES) + INVOICE_BYTES + CSV_BYTES);
	}
	for (const f of files) {
		if (!loads.has(f.key)) continue;
		if (f.bytes === null) missingFiles++;
		else sizes.set(f.key, sizes.get(f.key) + f.bytes);
	}
	return { sizes, missingFiles, rateConsStoodIn };
}

// The nearest-rank percentile, as the report states it.
function percentile(sorted, p) {
	if (!sorted.length) return null;
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function distribution(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		loads: sorted.length,
		p50: percentile(sorted, 0.5),
		p90: percentile(sorted, 0.9),
		p95: percentile(sorted, 0.95),
		max: sorted.length ? sorted[sorted.length - 1] : null,
		atOrOverLimit: sorted.filter((v) => v >= LIMIT_BYTES).length,
		atOrOverNearLimit: sorted.filter((v) => v >= NEAR_LIMIT_BYTES).length,
	};
}

function build({ db, uploadsDir }) {
	const { sizes, missingFiles, rateConsStoodIn } = batchSizes(readDocuments(db, uploadsDir));
	const d = distribution(sizes.values());
	return {
		...d,
		missingFiles,
		rateConsStoodIn,
		estimates: { invoiceBytes: INVOICE_BYTES, csvBytes: CSV_BYTES, rateConMedianBytes: RATECON_MEDIAN_BYTES },
		text: [
			`Loads with a POD or BOL: ${d.loads}`,
			`Estimated batch bytes: p50 ${d.p50} p90 ${d.p90} p95 ${d.p95} max ${d.max}`,
			`At or over the ${LIMIT_BYTES} limit: ${d.atOrOverLimit}; at or over ${NEAR_LIMIT_BYTES}: ${d.atOrOverNearLimit}`,
			`Files missing on disk: ${missingFiles}; rate cons stood in at ${RATECON_MEDIAN_BYTES}: ${rateConsStoodIn}`,
			`Estimates: invoice ${INVOICE_BYTES}, CSV ${CSV_BYTES}. Nothing was rendered.`,
		].join("\n"),
	};
}

function run(argv) {
	const args = parseArgs(argv);
	if (typeof args.db !== "string" || !args.db) throw refused("--db=<app.db> is required");
	if (typeof args.uploads !== "string" || !args.uploads) throw refused("--uploads=<uploads folder> is required");
	const uploadsDir = path.resolve(args.uploads);
	if (!(fs.existsSync(uploadsDir) && fs.statSync(uploadsDir).isDirectory())) throw refused("--uploads is not a folder");
	const db = openReadOnly(path.resolve(args.db));
	try {
		return { args, out: build({ db, uploadsDir }) };
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

module.exports = { run, build, readDocuments, batchSizes, distribution, openReadOnly, refused, LIMIT_BYTES, NEAR_LIMIT_BYTES };
