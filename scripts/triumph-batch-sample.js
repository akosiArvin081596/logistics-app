#!/usr/bin/env node
// A Triumph batch written to a folder for a look. By default the made-up batch that shows
// Triumph the format (lib/triumph-batch.js buildSampleBatch()): it reads no load, takes no
// number, claim or lock, and opens no database, Drive or Gemini. It writes only the two
// files and sends nothing; its invoice page renders as every invoice does, with Chromium
// fetching the page's fonts.
//
//   node scripts/triumph-batch-sample.js --out=<folder> [--noa-lines-file=<file>]
//
// The assignment lines come from TRIUMPH_NOA_LINES, or from --noa-lines-file (one line
// each): both are refused when they aren't the four lines. The folder and the lines' file
// must be outside this repository, which is public. A file already there is never
// overwritten.
//
// One real load, on a replica, for a local look at what its batch would hold:
//
//   node scripts/triumph-batch-sample.js --out=<folder> --load=<Load ID> --debtor="<name>"
//     --noa-lines-file=<file> --db=<app.db> (--sheets-json=<file> | --values-json=<file>)
//     --uploads=<folder> [--ratecon-file=<file>]
//
// Both settings stay on production, so they come in here. The database opens read-only.
// The files carry the sample's number and stamp on each page, so they can't pass for a
// real invoice, and hold real documents, so they belong under ~/LogisX-replica/screens/.
// With no paid read here, the free scan supplies the rate con's fields and the whole
// number is checked on its text and file name, not on a read's Load Number. A replica
// holds no deny list, so that check has nothing to read.
//
// Exit 0 written; 2 refused, by an argument or by the batch's own rules, naming the code;
// 1 any other failure. Output: names, sizes and codes; never the lines, a debtor or an amount.
//
// Required as a module (by its runner) it runs nothing and exports run().

"use strict";

const fs = require("fs");
const path = require("path");
const triumphRules = require("../lib/triumph-rules");
const triumphBatch = require("../lib/triumph-batch");
const triumphInvoice = require("../lib/triumph-invoice");
const appTime = require("../lib/app-time");

const ROOT = fs.realpathSync(path.join(__dirname, ".."));
const VALUE_ARGS = new Set(["out", "load", "debtor", "noa-lines-file", "db", "sheets-json", "values-json", "uploads", "ratecon-file"]);
const FOR_A_LOAD = ["debtor", "db", "sheets-json", "values-json", "uploads", "ratecon-file"];

class Refusal extends Error {}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/s.exec(String(a));
		if (!m) throw new Refusal(`unknown argument: ${String(a).slice(0, 40)}`);
		if (m[1] === "dry-run" || m[1] === "upload") throw new Refusal(`--${m[1]} comes with the transport, which isn't built`);
		if (!VALUE_ARGS.has(m[1]) || m[2] === undefined || m[2] === "") throw new Refusal(`unknown or malformed argument: --${m[1]}`);
		out[m[1]] = m[2];
	}
	if (!out.out) throw new Refusal("--out=<folder> is required");
	if (out.load) {
		for (const k of ["debtor", "db", "uploads"]) if (!out[k]) throw new Refusal(`--load needs --${k}`);
		if (Boolean(out["sheets-json"]) === Boolean(out["values-json"])) throw new Refusal("--load needs one of --sheets-json and --values-json");
	} else {
		const given = FOR_A_LOAD.filter((k) => out[k]);
		if (given.length) throw new Refusal(`--${given[0]} goes with --load; the made-up batch reads nothing else`);
	}
	return out;
}

// The nearest part of the path that exists, resolved, so a link can't lead a file into
// the repository.
function realPathOf(p) {
	let at = path.resolve(p);
	const rest = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync(at), ...rest);
		} catch (e) {
			const up = path.dirname(at);
			if (e.code !== "ENOENT" || up === at) throw e;
			rest.unshift(path.basename(at));
			at = up;
		}
	}
}

function refuseInsideRepo(p, what) {
	const real = realPathOf(p);
	if (real === ROOT || real.startsWith(ROOT + path.sep)) throw new Refusal(`${what} must be outside this repository: it is public`);
}

function linesFrom(args, env) {
	let raw = env.TRIUMPH_NOA_LINES;
	if (args["noa-lines-file"]) {
		refuseInsideRepo(args["noa-lines-file"], "--noa-lines-file");
		try {
			raw = fs.readFileSync(args["noa-lines-file"], "utf8");
		} catch {
			throw new Refusal("--noa-lines-file can't be read");
		}
	}
	const parsed = triumphRules.parseNoaLines(raw);
	if (!parsed.ok) throw new Refusal(`${parsed.code}: the assignment lines are unset, or aren't ${triumphRules.NOA_LINE_COUNT} lines`);
	return parsed.lines;
}

// One real load's parts, read from a replica's copies.
async function buildLoadBatch(args, { lines, day, render, at }) {
	const brokerInvoice = require("../lib/broker-invoice");
	const autoRules = require("../lib/auto-invoice-rules");
	const { readValues, liftSheetHelpers } = require("./auto-invoice-shadow-report");
	const { openReadOnly } = require("./triumph-batch-size-report");
	const helpers = liftSheetHelpers();
	const parsed = helpers.parseSheet({ values: readValues({ valuesJson: args["values-json"], sheetsJson: args["sheets-json"] }) });
	const rows = helpers.deduplicateLoads(parsed.data, parsed.headers);
	const cols = autoRules.jobColumns(parsed.headers);
	const key = autoRules.loadKey(args.load);
	const row = cols.loadIdCol ? rows.find((r) => autoRules.loadKey(r[cols.loadIdCol]) === key) : null;
	if (!row) return { ok: false, code: "LOAD_NOT_ON_SHEET" };
	const cell = (col) => (col ? String(row[col] == null ? "" : row[col]).trim() : "");

	const db = openReadOnly(path.resolve(args.db));
	let docs;
	try {
		docs = db.prepare("SELECT id, type, file_name, drive_url, uploaded_at FROM documents WHERE LOWER(TRIM(load_id)) IN (?, ?) AND deleted_at IS NULL").all(key, `#${key}`);
	} finally {
		db.close();
	}
	const uploads = path.resolve(args.uploads);
	const bytesOf = (doc) => {
		const file = autoRules.documentLocalPath(uploads, doc);
		try {
			return file ? fs.readFileSync(file) : null;
		} catch {
			return null;
		}
	};
	const isRateCon = (doc) => ["RATECON", "RATE CON", "RATE_CON"].includes(String(doc.type || "").trim().toUpperCase());
	const stored = docs.filter(isRateCon).sort((a, b) => String(b.uploaded_at || "").localeCompare(String(a.uploaded_at || "")) || Number(b.id) - Number(a.id))[0];
	let rateCon = null;
	if (args["ratecon-file"]) {
		let buffer = null;
		try {
			buffer = fs.readFileSync(args["ratecon-file"]);
		} catch {
			return { ok: false, code: "DOCUMENT_UNREADABLE", kinds: ["ratecon"] };
		}
		rateCon = { buffer, source: "drive", driveFileName: path.basename(args["ratecon-file"]) };
	} else if (stored) {
		rateCon = { buffer: bytesOf(stored), source: "documents" };
	}
	const brokerEmail = cell(cols.emailCol);
	const brokerContactName = cell(parsed.headers.find((h) => /broker.*(contact|name)/i.test(h)));
	const fields = rateCon && rateCon.buffer && rateCon.buffer.length ? await brokerInvoice.extractRateConFields(rateCon.buffer, { brokerEmail }) : {};
	const total = brokerInvoice.parseMoney(fields.totalRate) > 0 ? brokerInvoice.parseMoney(fields.totalRate) : brokerInvoice.parseMoney(cell(cols.paymentCol));
	if (!(total > 0)) return { ok: false, code: "INVOICE_TOTAL_UNKNOWN" };
	const billedTotal = brokerInvoice.formatMoney(total);
	const loadRef = cell(cols.loadIdCol).replace(/^#/, "").trim();
	const po = brokerInvoice.isBisonLoad({ email: brokerEmail }) ? fields.orderNumber || loadRef : loadRef;
	const invoiceDate = brokerInvoice.formatDate(day);
	const invoicePdf = await render(triumphInvoice.withAssignment(brokerInvoice.buildInvoiceHtml({
		invoiceId: triumphBatch.SAMPLE.invoiceId,
		invoiceDate,
		brokerName: brokerInvoice.resolveBrokerName({ brokerEmail, brokerContactName }),
		invoiceTo: brokerInvoice.resolveInvoiceTo({ brokerEmail, brokerContactName, documentsEmail: fields.documentsEmail }),
		orderNumber: po,
		poNumber: fields.poNumber || "",
		deliveryDate: brokerInvoice.formatDate(cell(cols.deliveryDateCol)),
		total: billedTotal,
	}), { lines: [...lines, triumphBatch.SAMPLE.stamp] }));
	return triumphBatch.buildBatch({
		invoicePdf,
		rateCon,
		rateConNumber: loadRef,
		documents: docs.map((d) => ({ ...d, buffer: triumphRules.documentKind(d.type) ? bytesOf(d) : null })),
		loadId: loadRef,
		debtorName: args.debtor,
		invoiceId: triumphBatch.SAMPLE.invoiceId,
		invoiceDate,
		po,
		billedTotal,
		at,
		denyHits: () => false,
		stamp: triumphBatch.SAMPLE.stamp,
	});
}

// Writes the two files. Anything already there stays and stops the run, before either goes.
function writeBatch(folder, batch) {
	fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
	const targets = [[batch.pdfName, batch.pdf], [batch.csvName, batch.csv]];
	for (const [name] of targets) {
		if (fs.existsSync(path.join(folder, name))) throw new Refusal(`${name} is already in --out, and is never overwritten`);
	}
	for (const [name, bytes] of targets) fs.writeFileSync(path.join(folder, name), bytes, { flag: "wx", mode: 0o600 });
}

// `render` is the invoice page's renderer: the app's own Chromium when run by hand.
async function run(argv, { render, env = process.env, now = () => new Date() } = {}) {
	const args = parseArgs(argv);
	refuseInsideRepo(args.out, "--out");
	const lines = linesFrom(args, env);
	const at = now();
	const day = appTime.dayInZone(at, appTime.appTimeZone());
	const batch = args.load
		? await buildLoadBatch(args, { lines, day, render, at })
		: await triumphBatch.buildSampleBatch({ lines, day, render, at });
	if (!batch.ok) throw new Refusal(`${batch.code}${batch.kinds ? ` (${batch.kinds.join(", ")})` : ""}${batch.kind ? ` (${batch.kind})` : ""}${batch.field ? ` (${batch.field})` : ""}${batch.error ? `: ${batch.error}` : ""}`);
	writeBatch(path.resolve(args.out), batch);
	return {
		pdfName: batch.pdfName,
		csvName: batch.csvName,
		batchBytes: batch.batchBytes,
		maxBytes: triumphRules.batchMaxBytes(env),
		parts: batch.parts.map((p) => ({ kind: p.kind, pages: p.pages, bytes: p.bytes })),
	};
}

async function main() {
	const pdfBrowser = require("../lib/pdf-browser");
	let code = 0;
	try {
		const r = await run(process.argv.slice(2), { render: pdfBrowser.renderHtmlToPdf });
		console.log(`Wrote ${r.pdfName} and ${r.csvName}: ${r.batchBytes} bytes of ${r.maxBytes}`);
		for (const p of r.parts) console.log(`  ${p.kind}: ${p.pages} page(s), ${p.bytes} bytes`);
	} catch (e) {
		if (e instanceof Refusal) console.error(`REFUSED: ${e.message}`);
		else console.error(`FAILED: ${e.stack || e.message}`);
		code = e instanceof Refusal ? 2 : 1;
	}
	await pdfBrowser.shutdownBrowser().catch(() => {});
	process.exit(code);
}

if (require.main === module) main();

module.exports = { run, parseArgs, Refusal };
