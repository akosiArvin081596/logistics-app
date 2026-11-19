#!/usr/bin/env node
// scripts/triumph-process-rehearsal.js: Process with Triumph's practice run (plan
// reports/2026-11-17-process-with-triumph-plan.md §5 step 3). For one delivered C.H. Robinson
// load it runs the press's checks as a dry run (lib/triumph-process.js), then the Triumph job's
// own build (lib/triumph-job.js rehearse(): prepare() in mode "auto", the second look at the rate
// con, render(), the documents, the batch in memory, rule 7's and the printed-field checks), all
// on a read-only handle of app.db. It marks nothing, arms no claim, takes no number, uploads
// nothing, sends no notice and keeps no file. It prints verdicts and matches only, never a value.
// The job's build reads the batch's own three settings from the settings file, as the live press
// reads them: with the dedupe on the run counts the identical copies it left out, and with the photo
// re-compress on it prints the step and the bytes, or that the batch stopped at the floor.
//
// The engine and the job read through this checkout's own server.js code, lifted at run time
// (scripts/lib/server-lift.js) onto the read-only handle, as scripts/payout-rules-dry-run.js runs
// the ledger: the sheet from one read-only snapshot, the rate con and documents from the uploads
// folder or Drive on the read-only scope, the rate con's total from Gemini as the job reads it.
// The Sheets writer, the mailer, the sockets and the number are never lifted (a reach is an
// error), and the two writers the readers name (the audit row, the rate con's remembered match)
// are stand-ins that throw.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/triumph-process-rehearsal.js --db=app.db --sheet-id=<id> --load=<load id> [--key=service-account-key.json]
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      with a copy of the database under the temp directory only
// The database is this checkout's own app.db or a copy under the temp directory; anything else is
// refused. There is no default sheet. Exit codes: 0 the load would go, 1 an error, 2 refused or
// stopped (the verdict says by what).

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { indexDeclarations, codeIdentifiers } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");
const ledgerWorld = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");
// The readers the engine and the job take from server.js.
const ROOTS = Object.freeze(["parseSheet", "deduplicateLoads", "findCol", "integrityClosedMonthsOf", "sheetDayKey", "fetchDocumentBytes", "getRateConBytes",
	"buildRateConLoadCtx", "parseInvoiceOverrides", "latestDraftNotes", "safeAttachmentName", "sanitizeEvidenceText", "triumphLoadDocuments", "runRateConGemini"]);
// Supplied here, never lifted: the read-only handle and clients, and the writers as stand-ins.
const PROVIDED = Object.freeze(["db", "require", "console", "process", "__dirname", "fetch", "REPLICA", "DATA_DIR", "getDrive", "getSheets", "logAudit", "rememberRateConMatch"]);
// Never reached: a reach stops the run before anything is read.
const DENIED = Object.freeze(["sheets", "auth", "KEY_FILE", "server", "io", "jtCacheInvalidate", "sendEmail", "transporter", "appendGmailDraft", "nextInvoiceNumber",
	"insertDispatchNotification", "notifyChange", "getJobTrackingCached", "brokerInvoiceDraft", "factoringRoutes", "triumph", "autoInvoice"]);
const GEMINI_HOST = "generativelanguage.googleapis.com";
const LIFTED_REQUIRE_OK = (m) => ["crypto", "fs", "path", "zlib"].includes(m) || /^\.\/lib\/[\w.-]+$/.test(m);
// A declaration whose first lines don't parse alone (a template literal with lines at column 0)
// is read on, line by line, until it does, at most this many lines.
const EXTEND_MAX_LINES = 400;
// The only settings the job is handed, from the parsed settings file: what the live press's
// build reads (lib/triumph-job.js), and none of the submit mode's, so the job stays off.
const BATCH_SETTINGS = Object.freeze(["TRIUMPH_BATCH_DEDUPE_ENABLED", "TRIUMPH_BATCH_MAX_BYTES", "TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED"]);

// Every top-level declaration `roots` reach, closed over as scripts/lib/server-lift.js closure()
// walks it, in source order. A piece that doesn't parse alone is read on until it does.
function liftReaders(src, { roots = ROOTS, provided = PROVIDED, denied = DENIED } = {}) {
	const { decls, dupes } = indexDeclarations(src);
	const lines = src.split("\n");
	const offsets = [];
	let at = 0;
	for (const l of lines) { offsets.push(at); at += l.length + 1; }
	const lineOf = (offset) => {
		let lo = 0;
		let hi = offsets.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (offsets[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
	const parses = (text) => {
		try {
			new Function(text);
			return true;
		} catch {
			return false;
		}
	};
	const whole = (decl) => {
		if (parses(decl.text)) return decl;
		let line = lineOf(decl.end);
		for (let i = 0; i < EXTEND_MAX_LINES && line + 1 < lines.length; i++) {
			line++;
			const end = offsets[line] + lines[line].length;
			const text = src.slice(decl.start, end);
			if (parses(text)) return { ...decl, end, text };
		}
		throw new Error(`lifted ${decl.kind} ${decl.name} does not parse`);
	};
	const provide = new Set(provided);
	const deny = new Set(denied);
	const want = new Set();
	const queue = [];
	const pieces = new Map();
	const visit = (text) => {
		for (const id of codeIdentifiers(text)) {
			if (provide.has(id) || want.has(id) || !decls.has(id)) continue;
			if (deny.has(id)) throw new Error(`the practice run reaches ${id}, which it must never lift`);
			if (dupes.has(id)) throw new Error(`${id} is declared more than once at the top level of server.js`);
			want.add(id);
			queue.push(id);
		}
	};
	for (const r of roots) {
		if (!decls.has(r)) throw new Error(`no top-level declaration ${r} in server.js`);
		if (deny.has(r)) throw new Error(`the practice run reaches ${r}, which it must never lift`);
		want.add(r);
		queue.push(r);
	}
	while (queue.length) {
		const name = queue.shift();
		const decl = decls.get(name);
		if (!pieces.has(decl.start)) pieces.set(decl.start, whole(decl));
		visit(pieces.get(decl.start).text);
	}
	const sorted = [...pieces.values()].sort((x, y) => x.start - y.start);
	return { names: sorted.flatMap((p) => p.name.split(", ").filter((n) => want.has(n))), text: sorted.map((p) => p.text).join("\n") };
}

// A writer the readers name, which the practice run never calls.
const neverWrites = (name) => () => { throw Object.assign(new Error(`the practice run writes nothing (${name})`), { code: "PRACTICE_RUN_WRITE" }); };

// The readers, lifted onto `db` (read-only), with the clients given. `deps` lets a runner hand
// in made-up clients: getDrive, fetch, sheetData.
function readers({ db, env, dataDir, sheetData, getDrive, fetchImpl }) {
	const SRC = serverSource({ root: ROOT });
	const lifted = liftReaders(SRC);
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const liftedRequire = (m) => {
		if (!LIFTED_REQUIRE_OK(m)) throw new Error(`lifted code required ${m}, which the practice run does not load`);
		return appRequire(m);
	};
	const writes = { logAudit: 0, rememberRateConMatch: 0 };
	const counted = (name) => (...args) => { writes[name]++; return neverWrites(name)(...args); };
	const getSheets = async () => ({ spreadsheets: { values: { get: async () => ({ data: sheetData }) } } });
	const quiet = { log() {}, info() {}, warn() {}, error() {} };
	const scope = {
		db, require: liftedRequire, console: quiet, process: { env: { ...env }, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } },
		__dirname: ROOT, fetch: fetchImpl, REPLICA: null, DATA_DIR: dataDir, getDrive, getSheets,
		logAudit: counted("logAudit"), rememberRateConMatch: counted("rememberRateConMatch"),
	};
	const names = Object.keys(scope);
	const exported = ROOTS.join(", ");
	const api = new Function(...names, `"use strict";\n${lifted.text}\nreturn { ${exported} };`)(...names.map((n) => scope[n]));
	return { api, liftedNames: lifted.names, writes, getSheets };
}

// Only Gemini's own endpoint, for the rate con's read: anything else is refused.
function geminiOnlyFetch(realFetch) {
	return async (url, opts) => {
		let host = "";
		try {
			host = new URL(String(url)).host;
		} catch {
			host = "";
		}
		if (host !== GEMINI_HOST) throw new Error("the practice run reaches nothing but the rate con's read");
		return realFetch(url, opts);
	};
}

// A Drive client on the read-only scope.
function readOnlyDrive({ keyFile }) {
	let client = null;
	return async () => {
		if (!client) {
			const { google } = createRequire(path.join(ROOT, "server.js"))("googleapis");
			const auth = new google.auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
			client = google.drive({ version: "v3", auth: await auth.getClient() });
		}
		return client;
	};
}

const yesNo = (v) => (v === true ? "yes" : v === false ? "no" : "not read");

// The run itself, for the command line and the runner. Answers { code, lines }: lines to print,
// verdicts only.
async function run({ argv = [], deps = {} } = {}) {
	const args = ledgerWorld.parseArgs(argv);
	if (!args.db || args.db === true) return { code: 2, lines: ["REFUSED: --db is required"] };
	if (!args.load || args.load === true) return { code: 2, lines: ["REFUSED: --load is required (one delivered C.H. Robinson load)"] };
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let env;
	let dbFile;
	try {
		({ env, file: dbFile } = ledgerWorld.envFor({ root: deps.root || ROOT, dbPath: args.db, envFile }));
	} catch (err) {
		return { code: 2, lines: [`REFUSED: ${err.message}`] };
	}
	const db = deps.openDb ? deps.openDb(dbFile) : ledgerWorld.openDb({ root: ROOT, dbFile, readonly: true });
	if (!db.readonly) {
		db.close();
		return { code: 2, lines: ["REFUSED: the practice run opens the database read-only, and this handle isn't"] };
	}
	const lines = ["Process with Triumph, practice run: nothing is marked, armed, numbered, uploaded or kept."];
	try {
		const sheetData = deps.sheetData || await ledgerWorld.sheetFor(args, ROOT);
		const keyFile = args.key || path.join(ROOT, "service-account-key.json");
		const { api, writes } = readers({
			db, env, dataDir: deps.dataDir || ROOT, sheetData,
			getDrive: deps.getDrive || readOnlyDrive({ keyFile }),
			fetchImpl: geminiOnlyFetch(deps.fetch || globalThis.fetch),
		});
		const triumphRules = require(path.join(ROOT, "lib", "triumph-rules.js"));
		const routesLib = require(path.join(ROOT, "lib", "factoring-routes.js"));
		const processLib = require(path.join(ROOT, "lib", "triumph-process.js"));
		const jobLib = require(path.join(ROOT, "lib", "triumph-job.js"));
		const autoRules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
		const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
		const parsed = api.parseSheet(sheetData);
		parsed.data = api.deduplicateLoads(parsed.data, parsed.headers);
		const { byKey } = autoRules.keyedRows(parsed.headers, parsed.data);
		const key = autoRules.loadKey(args.load);
		const row = byKey.get(key) || null;
		if (!row) {
			lines.push("the load: not on Job Tracking");
			return { code: 2, lines };
		}
		let closedMonths = null;
		try {
			closedMonths = api.integrityClosedMonthsOf(parsed.headers, row);
		} catch {
			closedMonths = null;
		}
		const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
		const loadId = String(row[autoRules.jobColumns(parsed.headers).loadIdCol] || args.load).trim();
		const press = processLib.processWithTriumph(db, { key, loadId, row, headers: parsed.headers, closedMonths, nowIso, dryRun: true, audit: neverWrites("audit") });
		lines.push(`the press's checks: ${press.ok ? "would take it" : `would refuse it (${press.code})`}`);
		if (!press.ok) return { code: 2, lines };

		const settings = routesLib.readSettings(env);
		const noaLines = settings.noaLines || [];
		lines.push(`the assignment lines: ${noaLines.length === triumphRules.NOA_LINE_COUNT ? "set" : "not set"}`);
		const deny = require(path.join(ROOT, "lib", "chr-events.js")).createRedactor({ denyList: env[require(path.join(ROOT, "lib", "driver-instructions-runtime.js")).DENY_LIST_SETTING] || "" });
		const denyHits = deny.count > 0 ? deny.hits : null;
		const renderHtmlToPdf = deps.renderHtmlToPdf || require(path.join(ROOT, "lib", "pdf-browser.js")).renderHtmlToPdf;
		const engine = require(path.join(ROOT, "lib", "broker-invoice-draft.js")).create({
			db, brokerInvoice, getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: sheetData }) } } }), SPREADSHEET_ID: "practice-run-snapshot",
			parseSheet: api.parseSheet, deduplicateLoads: api.deduplicateLoads, findCol: api.findCol, parseInvoiceOverrides: api.parseInvoiceOverrides,
			fetchDocumentBytes: api.fetchDocumentBytes, buildRateConLoadCtx: api.buildRateConLoadCtx, getRateConBytes: api.getRateConBytes,
			GEMINI_API_KEY: String(env.GEMINI_API_KEY || ""), runRateConGemini: api.runRateConGemini, latestDraftNotes: api.latestDraftNotes,
			renderHtmlToPdf, safeAttachmentName: api.safeAttachmentName, logAudit: neverWrites("logAudit"), sanitizeEvidenceText: api.sanitizeEvidenceText,
			// The load read as the press would mark it: Triumph's lines in place of the bank block.
			assignmentFor: () => ({ lines: noaLines }),
			denyHits, env,
		});
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "triumph-practice-"));
		try {
			const job = jobLib.create({
				db, env: Object.fromEntries(BATCH_SETTINGS.filter((k) => Object.hasOwn(env, k)).map((k) => [k, env[k]])),
				readJobTracking: async () => parsed, closedMonthsOf: api.integrityClosedMonthsOf, dayKeyOf: api.sheetDayKey,
				uploadsRoot: path.join(deps.dataDir || ROOT, "uploads"),
				engine: { prepare: (a) => engine.prepare(a), render: (c, o) => engine.render(c, o), record: neverWrites("record") },
				nextInvoiceNumber: neverWrites("nextInvoiceNumber"), loadDocuments: api.triumphLoadDocuments, noaLines, denyHits, batchDir: scratch,
				savedInvoiceEvidence: () => false, logAudit: neverWrites("logAudit"), notify: neverWrites("notify"), now: deps.now || (() => new Date()),
				log: { info() {}, warn() {}, error() {} },
			});
			const r = await job.rehearse(loadId, press.reuse);
			lines.push(`the rate con: whole read: ${yesNo(r.wholeRead)}`);
			// A count only where the dedupe ran: the switch on, and the batch built or stopped after it.
			const sentOnce = Number.isInteger(r.copiesLeftOut) ? `identical documents sent once: ${r.copiesLeftOut}` : "";
			if (!r.ok) {
				lines.push(`the build: would stop at ${r.step} (${r.code || r.state})${sentOnce ? `; ${sentOnce}` : ""}${r.floorReached === true ? "; page images: stopped at the floor" : ""}`);
				if (Array.isArray(r.changed) && r.changed.length) lines.push(`what differs from the broker's invoice: ${r.changed.join(", ")}`);
				return { code: 2, lines };
			}
			lines.push(`the invoice's number matches the broker's: ${yesNo(r.numberMatches)}`);
			lines.push(`its date matches: ${yesNo(r.dateMatches)}`);
			lines.push(`its total matches: ${yesNo(r.totalMatches)}`);
			lines.push(`the hold fields since the send: ${r.holdFieldsUnchanged ? "unchanged" : "changed"}`);
			lines.push(`the batch: ${r.pages} page${r.pages === 1 ? "" : "s"} (${r.parts.join(", ")})`);
			if (sentOnce) lines.push(sentOnce);
			if (r.recompressed) lines.push(`page images re-compressed: ${r.recompressed.images} at quality ${r.recompressed.quality} (${r.recompressed.bytesBefore} → ${r.recompressed.bytesAfter} bytes)`);
			lines.push(`writes attempted: ${writes.logAudit + writes.rememberRateConMatch}`);
			lines.push("verdict: it would go");
			return { code: 0, lines };
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	} finally {
		db.close();
	}
}

module.exports = { run, liftReaders, readers, ROOTS, PROVIDED, DENIED, geminiOnlyFetch };

if (require.main === module) {
	run({ argv: process.argv.slice(2) })
		.then(({ code, lines }) => {
			for (const l of lines) console.log(l);
			process.exit(code);
		})
		.catch((err) => {
			console.error(`ERROR: ${err && err.code ? err.code : "the practice run failed"}`);
			process.exit(1);
		});
}
