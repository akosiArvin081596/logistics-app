#!/usr/bin/env node
// scripts/driver-instructions-backfill.js — rate-con driver instructions, plan PR 5: reads
// the driver instructions of every open load once, before the feature's first flag goes
// on, so staff start from a reading instead of an empty panel. Run on the server, from the
// app directory, over ssh (production admin actions are server-side scripts).
//
// The shipped code does the work: lib/driver-instructions-runtime.js (create().backfill:
// the sweep's open-load rule, the sheet facts, the provenance and match checks, the
// context the filter reads, the write with its publish rule, the ledger and the audit
// helper) and lib/driver-instructions.js (the allowlist, the deny pass, the review
// heuristic). From server.js, lifted at run time (scripts/lib/server-lift.js): logAudit(),
// parseSheet(), deduplicateLoads(), BROKER_WITHHELD_RE and the Gemini settings.
//
// Which loads: the Job Tracking loads the runtime calls open (its closed-status rule:
// Delivered, POD Received, Completed, Cancel / Canceled / Cancelled, Invoiced, Paid) and
// that are not in deleted_loads. A load whose row a person reviewed or edited, that was
// published (or shown to a driver), or that has a newer reading waiting for a person, is
// never touched: it is listed as skipped (reviewed, staff_edited, published,
// pending_waiting), with no download and no Gemini call.
//
// Which rate con, per load:
//   1. the rate-con folder (RATECON_DRIVE_FOLDER_ID), listed once: the files whose name
//      carries exactly one open load's Load ID (or alias), as the sweep reads names; per
//      load, newest first, at most 5: a PDF of 15 MB or less, owned AND last modified by
//      n8n's account (RATECON_DRIVE_UPLOADER_EMAIL). The newest one the built-in reader
//      can read and that matches the load (two load facts and one the public tracker
//      doesn't show) wins, with no Gemini call before the match; else the newest
//      unreadable one whose Gemini answer matches (its load number, a stop city, and the
//      sheet's pickup number among its references);
//   2. else the load's dropped rate con: its documents RATECON row (not removed) and the
//      copy in uploads/rate-cons/, written when a signed-in Super Admin or Dispatcher
//      dropped it (no link followed).
// A load whose current row already holds those bytes from the same extractor is skipped as
// unchanged, with no Gemini call.
//
// Uncertain loads are skipped and printed with the last 4 of the Load ID and a code, and
// written nowhere: no_source, match_unconfirmed, uploader_mismatch, extract_failed (a
// Gemini error, its code in brackets), extract_invalid (an answer that isn't usable, or
// holds no stop), sheet_unverified (the sheet row the filter needs can't be read), and
// needs_review: a confirmed match whose reading carries review reasons. With
// --write-needs-review (decision 11's exception) those are written unpublished as
// needs_review, which no driver sees; the run prints that the exception is on, and each
// such audit row says so.
//
// --dry-run (the default): a read-only database handle (checked); nothing is written
// anywhere. Gemini is called: one call per load read, at most 30 a run, none after a 429
// or an unavailable answer. Per load it prints the last 4 of the Load ID, the source kind,
// the reference counts by type, the requirement categories and the review reasons, never
// Gemini's text. --preview=<Load ID> reads that one load and also prints its driver view
// (re-filtered, flagged items hidden: what a driver would be served once published).
//
// --apply writes only: load_driver_instructions and its versions, through the runtime's
// writeExtraction() (so the publish rule is the sweep's: a clean first reading is
// published, one with review reasons is not); the sweep's ledger
// (ratecon_instruction_files) for a folder file; the sweep's starting cursor
// (ratecon_instruction_sweeps: the run's start, so the first sweep lists the files created
// since then less its 10-minute overlap; written only while no sweep has run, never
// moved); and audit_trail rows as the system actor "system: driver-instructions backfill"
// (action backfill per load, backfill_cursor for the cursor; details are codes and
// counts). Each load is one transaction, its row re-read after the last await, and rolled
// back if its audit row isn't written. A replay writes 0 rows.
//
// Refused (exit 2, nothing read or written): the deny list (the runtime's
// DENY_LIST_SETTING) or RATECON_DRIVE_UPLOADER_EMAIL not set to a usable value,
// RATECON_DRIVE_FOLDER_ID or GEMINI_API_KEY not set, no --sheet-id, an unknown option,
// --apply with --dry-run or --preview, a --preview load that isn't open, a database
// without the driver-instructions tables or the audit trail.
//
// Usage (on the server, from the app directory, with the Node pm2 runs the app with):
//   node scripts/driver-instructions-backfill.js --db=app.db --sheet-id=<sheet> [--write-needs-review] [--preview=<Load ID>]
//   node scripts/driver-instructions-backfill.js --db=app.db --sheet-id=<sheet> --apply [--write-needs-review]
//   --db=<file>          default app.db in the app directory; else a copy under the temp
//                        directory (scripts/lib/ledger-world.js dbScope())
//   --env-file=<file>    the settings to read, for such a copy only (default: the app's .env)
//   --sheet-id=<id>      Job Tracking, Payments Table and Job Details, read with the
//                        spreadsheets.readonly scope; =env takes SPREADSHEET_ID from the
//                        settings. There is no default sheet.
//   --key=<file>         the service-account key (default: the app's
//                        service-account-key.json); the folder is read with the
//                        drive.readonly scope
//   --uploads-dir=<dir>  where dropped rate cons live, for a copy only (default: the
//                        app's uploads/)
// The output names loads by the last 4 of their Load ID; --preview prints one load's
// driver view (real reference numbers and facility text): keep it out of the repo.
// On a WAL database whose -wal and -shm files are absent, SQLite's read-only open creates
// them, empty, beside it (as for every read-only script here); the database file itself
// is never written by a dry run.
// Exit codes: 0 done (a dry run, an apply, or a replay with nothing to write), 1 error
// (loads already written stay written; a rerun continues), 2 refused.
//
// Required as a module (by its test runner) it runs nothing and exports main(argv, deps).

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { envFor, dbScope, openDb } = require("./lib/ledger-world");
const runtime = require("../lib/driver-instructions-runtime");
const di = require("../lib/driver-instructions");

const ROOT = path.join(__dirname, "..");
const ACTOR = Object.freeze({ id: 0, username: "system: driver-instructions backfill", role: "system" });
const SOURCE = "backfill";
const UPLOADER_SETTING = "RATECON_DRIVE_UPLOADER_EMAIL";
const FOLDER_SETTING = "RATECON_DRIVE_FOLDER_ID";
const MAX_FILES_PER_LOAD = 5;
const MAX_DOCS_PER_LOAD = 5;
const MAX_LISTED_FILES = 5000;
const MAX_GEMINI_CALLS = 30;
const TABLES = ["load_driver_instructions", "load_driver_instructions_versions", "ratecon_instruction_files", "ratecon_instruction_sweeps", "audit_trail"];
const UNCERTAIN = new Set(["no_source", "match_unconfirmed", "uploader_mismatch", "extract_failed", "extract_invalid", "needs_review", "sheet_unverified"]);
// Gemini answered, but not with something usable.
const INVALID_CODES = new Set(["invalid_json", "truncated", "blocked", "empty", "too_long"]);
// Gemini's "not now": no further call this run.
const STOP_CODES = new Set(["gemini_429", "gemini_unavailable"]);
const LIFT_ROOTS = ["logAudit", "parseSheet", "deduplicateLoads", "BROKER_WITHHELD_RE", "GEMINI_API_KEY", "GEMINI_OCR_MODEL"];
const LIFT_DENIED = ["getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "app", "jtCacheInvalidate", "sendEmail", "transporter", "getDrive", "fetch"];
const SHEET_RANGES = ["Job Tracking", "Payments Table", "Job Details"];
const USAGE = [
	"Usage: node scripts/driver-instructions-backfill.js --db=app.db --sheet-id=<sheet> [--dry-run] [--write-needs-review] [--preview=<Load ID>]",
	"       node scripts/driver-instructions-backfill.js --db=app.db --sheet-id=<sheet> --apply [--write-needs-review]",
	"       [--env-file=<file>] [--uploads-dir=<dir>] (a database copy only) [--key=<service-account key>]",
].join("\n");

// A refusal: nothing was written, exit 2.
class Refusal extends Error {}

// ---------------------------------------------------------------- helpers

function codeError(code) {
	const err = new Error(code);
	err.code = code;
	return err;
}
const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const sha256Of = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const normKey = (id) => String(id == null ? "" : id).trim().toLowerCase().replace(/^#/, "");
const last4 = (id) => String(id == null ? "" : id).replace(/[^A-Za-z0-9]/g, "").slice(-4);

// --flag=value / --flag value for the options that take one; --dry-run, --apply,
// --write-needs-review and --help take none. Anything else is refused, so a mistyped
// --dry-run never falls through to an apply.
function parseCli(argv) {
	const VALUE = new Set(["db", "env-file", "sheet-id", "key", "uploads-dir", "preview"]);
	const BOOL = new Set(["dry-run", "apply", "write-needs-review", "help"]);
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(a)}`);
		const eq = a.indexOf("=");
		const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
		if (BOOL.has(name)) {
			if (eq !== -1) throw new Error(`--${name} takes no value`);
			out[name] = true;
		} else if (VALUE.has(name)) {
			const value = eq !== -1 ? a.slice(eq + 1) : argv[++i];
			if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`--${name} needs a value`);
			out[name] = value;
		} else {
			throw new Error(`unknown option --${name}`);
		}
	}
	return out;
}

// What the backfill must not touch: a row a person reviewed or edited, one a driver may
// have been served, or one with a newer reading waiting for a person.
function handledCode(row) {
	if (!row) return "";
	if (row.source === "staff") return "staff_edited";
	if (row.status === "reviewed" || row.reviewed_at || row.reviewed_by) return "reviewed";
	if (row.published_at || row.driver_shown_at) return "published";
	if (row.pending_payload) return "pending_waiting";
	return "";
}
// The row already holds these bytes, read by this extractor (a failed reading holds
// nothing: the sweep retries it too).
function holds(row, sha) {
	return !!row && row.extractor === runtime.EXTRACTOR && row.status !== "failed" && (row.source_sha256 === sha || row.pending_sha256 === sha);
}
function failureOf(code) {
	return { code: INVALID_CODES.has(code) ? "extract_invalid" : "extract_failed", detail: code };
}
function referenceCounts(payload) {
	const n = {};
	for (const s of payload.stops) for (const r of s.references) n[r.type] = (n[r.type] || 0) + 1;
	return Object.keys(n).sort().map((t) => `${t} ${n[t]}`).join(", ");
}

// The server's own audit writer, sheet parser and Gemini settings, lifted from this
// checkout's server.js. `env`: the app's settings, as the server reads them.
function liftServer(root, db, env) {
	const src = fs.readFileSync(path.join(root, "server.js"), "utf8");
	const lifted = closure(src, { roots: LIFT_ROOTS, provided: ["db", "console", "process"], denied: LIFT_DENIED });
	return new Function("db", "console", "process", `"use strict";\n${lifted.text}\nreturn { ${LIFT_ROOTS.join(", ")} };`)(db, console, { env: { ...env } });
}

// A change and its audit row in one transaction: no audit row, no change.
function writeAudited(db, fn) {
	const maxId = () => db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM audit_trail").get().n;
	return db.transaction(() => {
		const before = maxId();
		const result = fn();
		if (result && result.skip) return result;
		if (maxId() <= before) throw new Error("an audit row was not written, so its change was rolled back");
		return result;
	})();
}

// Every file in the folder, newest first, metadata only.
async function listFolder(drive, folderId) {
	const list = [];
	let capped = false;
	let pageToken;
	do {
		const resp = await drive.files.list({
			q: `'${folderId}' in parents and trashed = false`,
			fields: "nextPageToken, files(id, name, mimeType, size, md5Checksum, createdTime, owners(emailAddress), lastModifyingUser(emailAddress))",
			orderBy: "createdTime desc",
			pageSize: 1000,
			pageToken,
			supportsAllDrives: true,
			includeItemsFromAllDrives: true,
		});
		const data = resp && resp.data ? resp.data : {};
		for (const f of Array.isArray(data.files) ? data.files : []) {
			if (!f || typeof f.id !== "string") continue;
			if (list.length >= MAX_LISTED_FILES) { capped = true; break; }
			list.push(f);
		}
		pageToken = !capped && typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
	} while (pageToken);
	return { list, capped };
}

function describe(rec) {
	const lines = [];
	const id = `Load ...${rec.last4}`;
	if (rec.code) {
		lines.push(`${id}: SKIPPED ${rec.code}${rec.detail ? ` (${rec.detail})` : ""}${UNCERTAIN.has(rec.code) ? ": uncertain, written nowhere" : ""}`);
	} else {
		const d = rec.decision;
		const what = d.action === "pending" ? "a reading waiting for a person" : d.status;
		lines.push(`${id}: ${rec.written ? "WRITTEN" : "WOULD WRITE"} ${d.action} as ${what} (${d.publish ? "published" : "unpublished"})${rec.exception ? " [decision 11 exception]" : ""}`);
	}
	if (rec.kind) lines.push(`  source: ${rec.kind}`);
	if (rec.extracted) {
		lines.push(`  references: ${rec.extracted.references || "none"}`);
		lines.push(`  requirement categories: ${rec.extracted.categories.join(", ") || "none"}`);
		lines.push(`  review reasons: ${rec.extracted.reasons.join(", ") || "none"}`);
	}
	if (rec.preview) {
		lines.push(`  driver view (${rec.preview.label}):`);
		for (const l of JSON.stringify(rec.preview.payload, null, 2).split("\n")) lines.push(`    ${l}`);
	}
	return lines;
}

// ---------------------------------------------------------------- the run

async function run(o) {
	const { db, env, cfg, apply, args, deps, lifted, out } = o;
	const now = typeof deps.now === "function" ? deps.now : () => Date.now();
	const started = now();
	const needsReviewOk = args["write-needs-review"] === true;
	const preview = args.preview !== undefined;
	const notes = [];
	const note = (m) => notes.push(String(m));
	const runtimeLog = { log: note, info: note, warn: note, error: note };

	const sheets = await deps.readSheets({ sheetId: o.sheetId, keyFile: o.keyFile });
	if (!sheets || !Array.isArray(sheets.jobTracking) || !Array.isArray(sheets.payments) || !Array.isArray(sheets.jobDetails)) throw new Error("the sheets could not be read");
	const jt = lifted.parseSheet({ values: sheets.jobTracking });
	jt.data = lifted.deduplicateLoads(jt.data, jt.headers);
	const side = { payments: sheets.payments, jobDetails: sheets.jobDetails };
	const drive = await deps.getDrive({ keyFile: o.keyFile });
	const rt = runtime.create({
		db,
		env,
		log: runtimeLog,
		now,
		fetch: deps.fetch,
		geminiApiKey: lifted.GEMINI_API_KEY,
		geminiModel: lifted.GEMINI_OCR_MODEL,
		getDrive: async () => drive,
		getJobTracking: async () => jt,
		getSideSheets: async () => side,
		brokerWithheldRe: lifted.BROKER_WITHHELD_RE,
		logAudit: lifted.logAudit,
		logAuditRefusal: () => {},
		uploadsDir: o.uploadsDir,
	});
	const bf = rt.backfill;
	const deleted = bf.deletedKeys();
	const loads = bf.openLoadsOf(jt, deleted);
	if (!loads.known.length) throw new Refusal("Job Tracking holds no load with a Load ID");
	let scope = loads.open;
	if (preview) {
		scope = loads.open.filter((l) => l.key === normKey(args.preview));
		if (!scope.length) throw new Refusal("--preview names no open load on Job Tracking");
	}

	// The folder, listed once; each file under the one open load its name carries.
	const folder = await listFolder(drive, cfg.folderId);
	const byLoad = new Map();
	const ambiguous = new Set();
	for (const f of folder.list) {
		const cands = bf.candidatesFor(typeof f.name === "string" ? f.name.slice(0, 300) : "", loads);
		if (cands.length === 1) {
			if (!byLoad.has(cands[0].key)) byLoad.set(cands[0].key, []);
			byLoad.get(cands[0].key).push(f);
		} else {
			for (const c of cands) ambiguous.add(c.key);
		}
	}
	for (const list of byLoad.values()) list.sort((x, y) => (Date.parse(y.createdTime) || 0) - (Date.parse(x.createdTime) || 0));

	// The sweep's starting cursor: this run's start, while no sweep has run.
	const cursor = { at: isoOf(started), written: false, kept: !!db.prepare("SELECT 1 FROM ratecon_instruction_sweeps LIMIT 1").get() };
	if (apply && !cursor.kept) {
		writeAudited(db, () => {
			db.prepare("INSERT INTO ratecon_instruction_sweeps (started_at, listed, extracted, paused_until, note) VALUES (?, ?, 0, '', ?)").run(cursor.at, folder.list.length, SOURCE);
			bf.audit(bf.actorReq(ACTOR), "backfill_cursor", "", { cursor: cursor.at, listed: folder.list.length });
		});
		cursor.written = true;
	}

	const gem = { calls: 0, stopped: "" };
	async function readPdf(buffer) {
		if (gem.stopped) throw codeError(gem.stopped);
		if (gem.calls >= MAX_GEMINI_CALLS) throw codeError("gemini_cap");
		gem.calls++;
		try {
			return await runtime.runDriverInstructionsGemini(buffer.toString("base64"), { fetch: deps.fetch, apiKey: lifted.GEMINI_API_KEY, model: lifted.GEMINI_OCR_MODEL });
		} catch (e) {
			const code = e && typeof e.code === "string" ? e.code : "error";
			if (STOP_CODES.has(code)) gem.stopped = code;
			throw codeError(code);
		}
	}

	// The load's dropped rate con: its newest documents RATECON row that isn't removed,
	// and its copy in uploads/rate-cons/ (a plain file, no link followed).
	function readDocument(facts, seen) {
		let rows;
		try {
			rows = db.prepare("SELECT id, file_name FROM documents WHERE load_id IN (?, ?) AND UPPER(type) = 'RATECON' AND deleted_at IS NULL ORDER BY uploaded_at DESC, id DESC LIMIT ?")
				.all(facts.loadId, `#${facts.loadId}`, MAX_DOCS_PER_LOAD);
		} catch {
			seen.add("documents_unreadable");
			return null;
		}
		const dir = path.resolve(o.uploadsDir, "rate-cons");
		for (const row of rows) {
			const file = path.resolve(dir, path.basename(String(row.file_name || "")));
			try {
				const st = file.startsWith(dir + path.sep) ? fs.lstatSync(file) : null;
				if (!st || !st.isFile()) { seen.add("document_missing"); continue; }
				if (st.size <= 0 || st.size > runtime.MAX_PDF_BYTES) { seen.add("not_pdf"); continue; }
				const buffer = fs.readFileSync(file);
				if (!bf.isPdfBytes(buffer)) { seen.add("not_pdf"); continue; }
				return { ok: true, kind: "documents", doc: row, buffer, sha: sha256Of(buffer), text: bf.pdfText(buffer) };
			} catch {
				seen.add("document_missing");
			}
		}
		return null;
	}

	async function findSource(facts, current) {
		const seen = new Set();
		if (ambiguous.has(facts.key)) seen.add("match_unconfirmed");
		const unreadable = [];
		for (const file of (byLoad.get(facts.key) || []).slice(0, MAX_FILES_PER_LOAD)) {
			const size = Number(file.size);
			if (file.mimeType !== "application/pdf" || !Number.isFinite(size) || size <= 0) { seen.add("not_pdf"); continue; }
			if (size > runtime.MAX_PDF_BYTES) { seen.add("too_large"); continue; }
			if (!bf.uploaderOk(file, cfg.uploaderEmail)) { seen.add("uploader_mismatch"); continue; }
			let buffer;
			try {
				buffer = await bf.download(drive, file.id);
			} catch {
				seen.add("download_failed");
				continue;
			}
			if (!bf.isPdfBytes(buffer) || buffer.length > runtime.MAX_PDF_BYTES) { seen.add("not_pdf"); continue; }
			const got = { ok: true, kind: "drive", file, buffer, sha: sha256Of(buffer), text: bf.pdfText(buffer) };
			if (!bf.pdfReadable(got.text, buffer.length)) { unreadable.push(got); continue; }
			if (bf.textMatches(facts, got.text, typeof file.name === "string" ? file.name.slice(0, 300) : "")) return got;
			seen.add("match_unconfirmed");
		}
		for (const got of unreadable) {
			if (holds(current, got.sha)) return got;
			let extraction;
			try {
				extraction = await readPdf(got.buffer);
			} catch (e) {
				return { ok: false, kind: "drive", ...failureOf(e.code) };
			}
			if (bf.extractionMatches(facts, extraction)) return { ...got, extraction };
			seen.add("match_unconfirmed");
		}
		const doc = readDocument(facts, seen);
		if (doc) return doc;
		const code = seen.has("match_unconfirmed") ? "match_unconfirmed" : seen.has("uploader_mismatch") ? "uploader_mismatch" : "no_source";
		return { ok: false, code, detail: [...seen].filter((c) => c !== code).sort().join(",") };
	}

	// What a driver would be served from a payload: re-filtered, flagged items hidden.
	const driverView = (payload, facts) => di.driverView(payload, bf.contextFor(facts)).payload;

	async function backfillLoad(lf) {
		const rec = { last4: last4(lf.loadId), code: "", detail: "", kind: "", extracted: null, decision: null, written: false, exception: false, preview: null };
		const current = bf.rowOf(lf.key);
		let facts;
		try {
			facts = await bf.loadFacts(lf.loadId, { jt, deleted, side });
		} catch {
			facts = null;
		}
		const handled = handledCode(current);
		if (handled) {
			rec.code = handled;
			if (preview && facts) rec.preview = { label: "stored, as a driver would be served it", payload: driverView(current.payload, facts) };
			return rec;
		}
		if (!facts || !facts.open) {
			rec.code = "sheet_unverified";
			return rec;
		}
		const src = await findSource(facts, current);
		rec.kind = src.kind || "";
		if (!src.ok) {
			rec.code = src.code;
			rec.detail = src.detail || "";
			return rec;
		}
		if (holds(current, src.sha)) {
			rec.code = "unchanged";
			if (preview) rec.preview = { label: "stored, as a driver would be served it", payload: driverView(current.payload, facts) };
			return rec;
		}
		let extraction = src.extraction;
		if (!extraction) {
			try {
				extraction = await readPdf(src.buffer);
			} catch (e) {
				Object.assign(rec, failureOf(e.code));
				return rec;
			}
		}
		const ctx = bf.contextFor(facts);
		const filtered = di.filterInstructions(extraction, ctx);
		const r = di.reviewReasons({ ctx, extraction, filtered, visibleText: src.text, byteLength: src.buffer.length, source: src.kind === "documents" ? "dropzone" : "drive_sweep", loadId: facts.loadId });
		rec.extracted = { references: referenceCounts(filtered.payload), categories: bf.payloadSummary(filtered.payload).categories, reasons: r.codes };
		if (preview) rec.preview = { label: r.codes.length ? "held for review: no driver sees it until a person reviews it" : "what a driver would be served once published", payload: driverView(filtered.payload, facts) };
		if (!filtered.payload.stops.length) {
			rec.code = "extract_invalid";
			rec.detail = "no_stops";
			return rec;
		}
		if (r.codes.length && !needsReviewOk) {
			rec.code = "needs_review";
			return rec;
		}
		const exception = r.codes.length > 0;
		if (!apply) {
			const d = di.decideExtractionWrite(current, { payload: filtered.payload, reasons: r.codes });
			if (d.action === "unchanged") rec.code = "unchanged";
			else Object.assign(rec, { decision: d, exception });
			return rec;
		}
		const sourceRef = src.kind === "drive" ? src.file.id : String(src.doc.id);
		// One transaction, the row re-read after the last await.
		const res = writeAudited(db, () => {
			const now2 = bf.rowOf(facts.key);
			const h = handledCode(now2);
			if (h) return { skip: h };
			if (holds(now2, src.sha)) return { skip: "unchanged" };
			const d = bf.writeExtraction({ facts, filtered, codes: r.codes, counts: r.counts, source: SOURCE, sourceRef, sha: src.sha, actor: ACTOR });
			if (d.action === "unchanged") return { skip: "unchanged" };
			if (src.kind === "drive") bf.ledger(src.file, d.action === "pending" ? "pending" : "done", SOURCE, { loadKey: facts.key, sha256: src.sha, tried: true });
			bf.audit(bf.actorReq(ACTOR), "backfill", facts.loadId, {
				source: src.kind,
				result: d.action,
				status: d.status,
				published: !!d.publish,
				reasons: d.action === "pending" ? d.pendingReasons : r.codes,
				...(exception ? { exception: "decision_11" } : {}),
				...bf.payloadSummary(filtered.payload),
			});
			return { decision: d };
		});
		if (res.skip) {
			rec.code = res.skip;
			return rec;
		}
		Object.assign(rec, { decision: res.decision, exception, written: true });
		return rec;
	}

	const records = [];
	for (const lf of scope) records.push(await backfillLoad(lf));
	const writtenLoads = records.filter((r) => r.written).length;

	// ------------------------------------------------------------ the report
	out("Rate-con driver instructions backfill (scripts/driver-instructions-backfill.js)");
	out(`Mode: ${apply ? "APPLY" : "DRY RUN, nothing is written anywhere"}`);
	out(`Database: ${o.dbFile} (${db.readonly ? "read-only handle" : "writable handle"})`);
	out(`Run started: ${cursor.at}`);
	out(`Needs-review exception (decision 11): ${needsReviewOk ? "ON: a confirmed match whose reading has review reasons is written unpublished as needs_review" : "off: such loads are skipped as needs_review"}`);
	out(`Loads: ${loads.open.length} open load(s) in scope; ${loads.known.length - loads.open.length} closed or deleted not read${preview ? "; --preview reads one" : ""}`);
	out(`Rate-con folder: ${folder.list.length} file(s) listed${folder.capped ? ` (the newest ${MAX_LISTED_FILES})` : ""}`);
	out("");
	for (const rec of records) for (const line of describe(rec)) out(line);
	out("");
	for (const n of notes) out(`Note: ${n}`);
	out(`Gemini calls: ${gem.calls}${gem.stopped ? ` (no more after ${gem.stopped}; rerun later)` : ""}${gem.calls >= MAX_GEMINI_CALLS ? ` (the run's limit of ${MAX_GEMINI_CALLS}; rerun for the rest)` : ""}`);
	if (cursor.kept) out("Sweep cursor: kept (a sweep or an earlier backfill set it)");
	else if (cursor.written) out(`Sweep cursor: written; the first sweep starts at ${cursor.at} less its 10-minute overlap`);
	else out("Sweep cursor: none yet; an apply writes its own start as the first sweep's start");
	const uncertain = records.filter((r) => UNCERTAIN.has(r.code)).length;
	const handled = records.filter((r) => r.code && !UNCERTAIN.has(r.code)).length;
	if (apply) {
		out(`Result: ${writtenLoads} load(s) written; ${uncertain} skipped as uncertain (written nowhere); ${handled} skipped as already handled.`);
	} else {
		const would = records.filter((r) => !r.code).length;
		out(`Result: dry run: ${would} load(s) would be written; ${uncertain} skipped as uncertain; ${handled} skipped as already handled. Nothing was written.`);
		const extra = [args["env-file"] ? ` --env-file=${path.resolve(args["env-file"])}` : "", args["uploads-dir"] ? ` --uploads-dir=${path.resolve(args["uploads-dir"])}` : "", args.key ? ` --key=${path.resolve(args.key)}` : ""].join("");
		out(`Apply with: cd ${o.root} && ${process.execPath} scripts/driver-instructions-backfill.js --db=${o.dbFile} --sheet-id=${args["sheet-id"]}${extra} --apply${needsReviewOk ? " --write-needs-review" : ""}`);
	}
	return { records, writtenLoads };
}

// ---------------------------------------------------------------- main

// `deps`: { root, now, readSheets({ sheetId, keyFile }), getDrive({ keyFile }), fetch,
// out(line), err(line) }; the command line passes the real Google clients and fetch.
// Answers the exit code.
async function main(argv, deps = {}) {
	const out = typeof deps.out === "function" ? deps.out : (l) => console.log(l);
	const err = typeof deps.err === "function" ? deps.err : (l) => console.error(l);
	const refuse = (msg) => {
		err(`REFUSED: ${msg}. Nothing was written.`);
		return 2;
	};
	let args;
	try {
		args = parseCli(argv);
	} catch (e) {
		return refuse(e.message);
	}
	if (args.help) {
		out(USAGE);
		return 0;
	}
	const apply = args.apply === true;
	if (apply && args["dry-run"]) return refuse("--apply and --dry-run together");
	if (apply && args.preview !== undefined) return refuse("--preview is for a dry run; it never writes");
	const root = deps.root || ROOT;
	const dbPath = args.db || path.join(root, "app.db");
	let env;
	let dbFile;
	let scope;
	try {
		({ env, file: dbFile } = envFor({ root, dbPath, envFile: args["env-file"] || null }));
		({ scope } = dbScope(dbPath, root));
	} catch (e) {
		return refuse(e.message);
	}
	const cfg = runtime.readConfig(env);
	if (!cfg.denyConfigured) return refuse(`${runtime.DENY_LIST_SETTING} is not set to a usable value in the app's settings; nothing is filtered without it`);
	if (!cfg.uploaderEmail) return refuse(`${UPLOADER_SETTING} is not set to an address in the app's settings; a folder file's uploader can't be checked without it`);
	if (!cfg.folderId) return refuse(`${FOLDER_SETTING} is not set in the app's settings; the backfill reads the rate-con folder`);
	if (!args["sheet-id"]) return refuse("--sheet-id is required; there is no default sheet");
	const sheetId = args["sheet-id"] === "env" ? String(env.SPREADSHEET_ID || "").trim() : args["sheet-id"];
	if (!sheetId) return refuse("--sheet-id=env: the settings name no SPREADSHEET_ID; name the sheet");
	if (args["uploads-dir"] && scope !== "copy") return refuse("--uploads-dir is for a copy of the database under the temp directory; the app's own database reads the app's uploads/");
	if (!fs.existsSync(dbFile)) return refuse(`no database at ${dbFile}`);
	const uploadsDir = args["uploads-dir"] ? path.resolve(args["uploads-dir"]) : path.join(root, "uploads");
	const keyFile = args.key ? path.resolve(args.key) : path.join(root, "service-account-key.json");
	let db;
	try {
		db = openDb({ root, dbFile, readonly: !apply });
	} catch (e) {
		return refuse(e.message);
	}
	try {
		const missing = TABLES.filter((t) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
		if (missing.length) return refuse(`the database has no ${missing.join(", ")} (the server creates the driver-instructions tables when it starts)`);
		const lifted = liftServer(root, db, env);
		if (!lifted.GEMINI_API_KEY) return refuse("GEMINI_API_KEY is not set in the app's settings");
		await run({ db, dbFile, env, cfg, apply, args, deps, lifted, sheetId, keyFile, uploadsDir, root, out });
		return 0;
	} catch (e) {
		if (e instanceof Refusal) return refuse(e.message);
		err(`ERROR: ${e && e.message ? e.message : "error"}. Loads already written stay written; a rerun continues.`);
		return 1;
	} finally {
		db.close();
	}
}

// The real Google clients (read-only scopes) and fetch, for the command line.
function commandLineDeps(root) {
	const appRequire = createRequire(path.join(root, "server.js"));
	const client = async (keyFile, scope) => {
		const { google } = appRequire("googleapis");
		const auth = new google.auth.GoogleAuth({ keyFile, scopes: [scope] });
		return { google, auth: await auth.getClient() };
	};
	return {
		root,
		fetch: globalThis.fetch,
		readSheets: async ({ sheetId, keyFile }) => {
			const { google, auth } = await client(keyFile, "https://www.googleapis.com/auth/spreadsheets.readonly");
			const resp = await google.sheets({ version: "v4", auth }).spreadsheets.values.batchGet({ spreadsheetId: sheetId, ranges: SHEET_RANGES });
			const vr = (resp && resp.data && resp.data.valueRanges) || [];
			return { jobTracking: (vr[0] && vr[0].values) || [], payments: (vr[1] && vr[1].values) || [], jobDetails: (vr[2] && vr[2].values) || [] };
		},
		getDrive: async ({ keyFile }) => {
			const { google, auth } = await client(keyFile, "https://www.googleapis.com/auth/drive.readonly");
			return google.drive({ version: "v3", auth });
		},
	};
}

if (require.main === module) {
	main(process.argv.slice(2), commandLineDeps(ROOT)).then((code) => process.exit(code), (e) => {
		console.error(`ERROR: ${e && e.message ? e.message : "error"}. Loads already written stay written; a rerun continues.`);
		process.exit(1);
	});
}

module.exports = { ACTOR, SOURCE, UNCERTAIN, parseCli, handledCode, holds, main };
