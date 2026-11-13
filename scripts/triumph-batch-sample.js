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
// The made-up batch to Triumph's SFTP, on the box, by the lead, on Arvin's own yes (it sends
// to an outside party), --dry-run first:
//
//   node scripts/triumph-batch-sample.js --dry-run
//   node scripts/triumph-batch-sample.js --upload --audit-db=<app.db>
//
// Made up only: with either, --load, --debtor, --out or any file of a load's refuses before
// anything is read. The lines come from TRIUMPH_NOA_LINES alone. Neither opens a database for
// loads, Drive or Gemini, nor takes a number, claim or lock. --dry-run builds the batch, runs
// the transport's own content check on it and says what --upload would send; it writes nothing
// and connects nothing. --upload sends it in the transport's sample mode (lib/triumph-transfer.js),
// the PDF first, and writes one audit row, triumph_sample_uploaded, naming no load, into
// --audit-db. Both refuse once the go-live date holds any value or the mode reads live
// (lib/triumph-rules.js sampleShut()), in a replica, and on a Friday evening (the weekly
// invoice batch has the renderer). A PDF that went up while the CSV's answer never came needs
// Arvin's fresh yes before another run.
//
// Exit 0 written or sent; 2 refused, by an argument, a check or the batch's own rules, naming
// the code; 3 the PDF went and the CSV's answer didn't come; 1 any other failure. Output: names,
// sizes and codes; never the lines, a debtor or an amount.
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
const VALUE_ARGS = new Set(["out", "load", "debtor", "noa-lines-file", "db", "sheets-json", "values-json", "uploads", "ratecon-file", "audit-db"]);
const FOR_A_LOAD = ["debtor", "db", "sheets-json", "values-json", "uploads", "ratecon-file"];
const SENDS = ["dry-run", "upload"];
const SAMPLE_ACTOR = Object.freeze({ id: 0, username: "triumph-sample", role: "system" });

class Refusal extends Error {}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/s.exec(String(a));
		if (!m) throw new Refusal(`unknown argument: ${String(a).slice(0, 40)}`);
		if (SENDS.includes(m[1])) {
			if (m[2] !== undefined) throw new Refusal(`--${m[1]} takes no value`);
			out[m[1]] = true;
			continue;
		}
		if (!VALUE_ARGS.has(m[1]) || m[2] === undefined || m[2] === "") throw new Refusal(`unknown or malformed argument: --${m[1]}`);
		out[m[1]] = m[2];
	}
	const send = SENDS.filter((k) => out[k]);
	if (send.length > 1) throw new Refusal("give one of --dry-run and --upload");
	if (send.length) {
		// The sample goes made up, or not at all: nothing of a load, and no file but the audit's.
		const given = ["load", "out", "noa-lines-file", ...FOR_A_LOAD].filter((k) => out[k]);
		if (given.length) throw new Refusal(`--${send[0]} sends only the made-up batch, so --${given[0]} is refused`);
		if (out.upload && !out["audit-db"]) throw new Refusal("--upload needs --audit-db=<app.db>, where its audit row goes");
		if (out["dry-run"] && out["audit-db"]) throw new Refusal("--dry-run writes nothing, so --audit-db is refused");
		return out;
	}
	if (out["audit-db"]) throw new Refusal("--audit-db goes with --upload");
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

// One real load's parts, read from a replica's copies. A load with advance lines stops as the submit job
// stops it (ADVANCE_LINES) unless the run's own settings switch both on (lib/triumph-rules.js
// advanceLinesEnabled()); then its invoice prints them as the engine's automatic invoice does, with
// that invoice's checks, and INVAMT is the balance due it prints.
async function buildLoadBatch(args, { lines, day, render, at, env = {} }) {
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
	let hasLines = false;
	try {
		docs = db.prepare("SELECT id, type, file_name, drive_url, uploaded_at FROM documents WHERE LOWER(TRIM(load_id)) IN (?, ?) AND deleted_at IS NULL").all(key, `#${key}`);
		hasLines = require("../lib/auto-invoice-ledger").activeAdvanceLines(db, key) > 0;
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
	const rcTotal = brokerInvoice.parseMoney(fields.totalRate);
	const total = rcTotal > 0 ? rcTotal : brokerInvoice.parseMoney(cell(cols.paymentCol));
	if (!(total > 0)) return { ok: false, code: "INVOICE_TOTAL_UNKNOWN" };
	const loadRef = cell(cols.loadIdCol).replace(/^#/, "").trim();
	let summary = null;
	if (hasLines) {
		if (!triumphRules.advanceLinesEnabled(env)) return { ok: false, code: "ADVANCE_LINES" };
		const linesDb = openReadOnly(path.resolve(args.db));
		let resolved;
		try {
			resolved = brokerInvoice.invoiceLines.resolveInvoiceLines(linesDb, { loadId: loadRef, selection: null, derivedLineHaul: total, lineHaulSource: rcTotal > 0 ? "ratecon" : "sheet", typedTotal: null });
		} finally {
			linesDb.close();
		}
		if (!resolved.ok) return { ok: false, code: "ADVANCE_LINES_INVALID" };
		const typed = autoRules.advanceLineTextRefusal(resolved.summary && resolved.summary.items);
		if (typed) return { ok: false, code: typed };
		summary = resolved.summary;
	}
	const billedTotal = summary ? brokerInvoice.invoiceLines.formatCents(summary.balanceCents) : brokerInvoice.formatMoney(total);
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
		invoiceLines: summary,
		total: brokerInvoice.formatMoney(total),
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

// --dry-run and --upload. `createTransport` is lib/triumph-transfer.js create(); `writeAudit`
// writes the one audit row. Answers what went, or would.
async function runSend(args, { render, env, now, replica, createTransport, writeAudit }) {
	const shut = triumphRules.sampleShut(env, { replica });
	if (shut) throw new Refusal(`${shut}: the sample goes only before Triumph is live`);
	const at = now();
	// The weekly invoice batch renders on Friday evenings: the sample starts no render then.
	if (require("../lib/auto-invoice-rules").shadowRenderQuiet(at, appTime.businessZoneAt(at))) throw new Refusal("QUIET_WINDOW: no render on a Friday evening, the weekly invoice batch's time");
	const lines = linesFrom({}, env);
	const batch = await triumphBatch.buildSampleBatch({ lines, day: appTime.businessDayOf(at), render, at });
	if (!batch.ok) throw new Refusal(`${batch.code}${batch.field ? ` (${batch.field})` : ""}`);
	const files = { pdfName: batch.pdfName, pdf: batch.pdf, csvName: batch.csvName, csv: batch.csv };
	const refused = triumphBatch.sampleRefusal(files);
	if (refused) throw new Refusal(`SAMPLE_REFUSED (${refused})`);
	const transport = createTransport({ env, replica });
	if (!transport.configured) throw new Refusal(`TRANSPORT_UNCONFIGURED: ${[...transport.missing, ...transport.invalid].join(", ")}`);
	const said = { pdfName: batch.pdfName, csvName: batch.csvName, batchBytes: batch.batchBytes, sent: false };
	if (args["dry-run"]) return said;

	const session = await transport.openSample().catch((e) => {
		throw new Refusal(`${(e && e.code) || "CONNECT_FAILED"}: nothing was sent`);
	});
	try {
		await session.putSample(files);
	} catch (e) {
		const code = (e && e.code) || "PUT_FAILED";
		if (e && e.part === "csv") {
			writeAudit("triumph_sample_uploaded", `${batch.pdfName} sent; ${batch.csvName} had no answer (${code}); another run needs a fresh yes`);
			throw Object.assign(new Error(`${code}: the PDF went up and the CSV's answer didn't come. Don't run --upload again without Arvin's fresh yes.`), { exitCode: 3 });
		}
		throw new Refusal(`${code}${e && e.why ? ` (${e.why})` : ""}: nothing was sent`);
	} finally {
		try {
			session.close();
		} catch {
			// already closed
		}
	}
	writeAudit("triumph_sample_uploaded", `${batch.pdfName} and ${batch.csvName}, ${batch.batchBytes} bytes; the made-up sample, no load`);
	return { ...said, sent: true };
}

// The audit row's writer for --upload, on the app's database.
function auditWriter(dbPath) {
	const file = path.resolve(dbPath);
	if (!fs.existsSync(file)) throw new Refusal("--audit-db names no file");
	return (action, details) => {
		const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
		const db = new Database(file, { fileMustExist: true });
		try {
			db.pragma("busy_timeout = 5000");
			db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
				.run(new Date().toISOString(), SAMPLE_ACTOR.id, SAMPLE_ACTOR.username, SAMPLE_ACTOR.role, action, "triumph", "", details);
		} finally {
			db.close();
		}
	};
}

// `render` is the invoice page's renderer: the app's own Chromium when run by hand.
async function run(argv, { render, env = process.env, now = () => new Date(), replica = false, createTransport = (o) => require("../lib/triumph-transfer").create(o), writeAudit = null } = {}) {
	const args = parseArgs(argv);
	if (args["dry-run"] || args.upload) {
		const audit = args.upload ? writeAudit || auditWriter(args["audit-db"]) : () => {
			throw new Error("a dry run writes nothing");
		};
		return runSend(args, { render, env, now, replica, createTransport, writeAudit: audit });
	}
	refuseInsideRepo(args.out, "--out");
	const lines = linesFrom(args, env);
	const at = now();
	const day = appTime.dayInZone(at, appTime.appTimeZone());
	const batch = args.load
		? await buildLoadBatch(args, { lines, day, render, at, env })
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
	const argv = process.argv.slice(2);
	const pdfBrowser = require("../lib/pdf-browser");
	const sends = argv.some((a) => a === "--dry-run" || a === "--upload");
	let code = 0;
	try {
		// On the box the transport's settings are the app's own, read only once the arguments
		// pass: a refused command line reads no settings file.
		const args = parseArgs(argv);
		if (args["dry-run"] || args.upload) require("dotenv").config({ quiet: true });
		const r = await run(argv, { render: pdfBrowser.renderHtmlToPdf, replica: require("../lib/replica-mode").active() });
		if (r.parts) {
			console.log(`Wrote ${r.pdfName} and ${r.csvName}: ${r.batchBytes} bytes of ${r.maxBytes}`);
			for (const p of r.parts) console.log(`  ${p.kind}: ${p.pages} page(s), ${p.bytes} bytes`);
		} else {
			console.log(`${r.sent ? "SENT" : "DRY RUN (nothing sent, nothing written)"}: ${r.pdfName}, then ${r.csvName}, ${r.batchBytes} bytes`);
		}
	} catch (e) {
		if (e instanceof Refusal) console.error(`REFUSED: ${e.message}`);
		else if (e && e.exitCode === 3) console.error(`STOPPED: ${e.message}`);
		// A send names its failure by its code alone; a local look keeps the whole trace.
		else console.error(`FAILED: ${sends ? (e && e.code) || "ERROR" : e.stack || e.message}`);
		code = e instanceof Refusal ? 2 : (e && e.exitCode) || 1;
	}
	await pdfBrowser.shutdownBrowser().catch(() => {});
	process.exit(code);
}

if (require.main === module) main();

module.exports = { run, parseArgs, Refusal };
