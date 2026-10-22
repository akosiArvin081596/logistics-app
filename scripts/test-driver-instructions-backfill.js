#!/usr/bin/env node
/**
 * scripts/driver-instructions-backfill.js (rate-con driver instructions, plan PR 5): the
 * one-off backfill of the open loads' driver instructions, run on the server before the
 * feature's first flag goes on.
 *
 * Written before the script (it failed on every case there: no script, and no
 * runtime.backfill or DENY_LIST_SETTING in lib/driver-instructions-runtime.js).
 * DI_BACKFILL_SCRIPT=<file> runs it against another copy of the script.
 *
 * Each case builds a database copy under the temp directory (rollback journal, so any
 * write changes the file itself), a settings file, an uploads folder, and stubs for
 * Google Sheets, Drive and Gemini that record what they are handed. The script runs
 * in-process through its exported main(argv, deps), with exactly the options an
 * operator types; only the three network clients are swapped for the stubs.
 *
 *   §1 the dry run (the default) writes nothing: read-only handle, the database file's
 *      hash and mtime unchanged; Gemini is called
 *   §2 exit 2 without the deny list or the uploader account (and the deny list's name is
 *      the runtime's own constant)
 *   §3 apply, then a replay that writes 0 rows
 *   §4 reviewed, staff-edited and published rows (and a waiting reading) never touched
 *   §5 only active and upcoming loads are in scope
 *   §6 each uncertain kind skipped and logged with its code, written nowhere
 *   §7 audit rows carry the system actor
 *   §8 --write-needs-review (decision 11's exception) writes needs_review unpublished,
 *      audited; without it those loads are skipped
 *   §9 the sweep's starting cursor is written on apply, and the sweep starts from it
 *   §10 no Gemini text in the output, the logs, the audit trail or any table
 *   §11 --preview prints only driver-safe content, and only for a dry run
 *   §12 the documents source: the uploads copy of a dropped rate con
 *
 * Every value is made up: the account number, amounts, phones, emails, names, places,
 * references and load numbers. No network: no real Gemini, Drive or Sheets.
 * Run: node scripts/test-driver-instructions-backfill.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function findRoot(start) {
	for (let d = start; ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "server.js")) && fs.existsSync(path.join(d, "package.json"))) return d;
		if (path.dirname(d) === d) throw new Error(`no repo root above ${start}`);
	}
}
const ROOT = findRoot(__dirname);
const SCRIPT = process.env.DI_BACKFILL_SCRIPT || path.join(ROOT, "scripts", "driver-instructions-backfill.js");
const RUNTIME_FILE = path.join(ROOT, "lib", "driver-instructions-runtime.js");
const runtime = require(RUNTIME_FILE);
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));

// ── harness ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const queue = [];
const cleanups = [];
function test(name, fn) { queue.push([name, fn]); }
async function runAll() {
	for (const [name, fn] of queue) {
		const checks = [];
		const eq = (label, actual, expected) => {
			const a = JSON.stringify(actual);
			const e = JSON.stringify(expected);
			checks.push({ ok: a === e, label, detail: `expected ${e}\n             actual   ${a}`.slice(0, 1500) });
		};
		const ok = (label, cond, detail = "") => checks.push({ ok: !!cond, label, detail: typeof detail === "string" ? detail.slice(0, 1500) : JSON.stringify(detail).slice(0, 1500) });
		try {
			await fn({ eq, ok });
		} catch (err) {
			checks.push({ ok: false, label: "threw", detail: String((err && err.stack) || err).split("\n").slice(0, 4).join(" | ") });
		} finally {
			for (const c of cleanups.splice(0)) c();
		}
		const good = checks.length > 0 && checks.every((c) => c.ok);
		if (good) passed++; else failed++;
		console.log(`  ${good ? "ok  " : "FAIL"}  ${name}`);
		if (!good) {
			for (const c of checks.filter((x) => !x.ok).slice(0, 6)) console.log(`        - ${c.label}${c.detail ? `\n             ${c.detail}` : ""}`);
			if (!checks.length) console.log("        - no check ran");
		}
	}
	console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
	process.exit(failed ? 1 : 0);
}
// Required per case, so a missing script fails each case rather than the file.
function backfill() { return require(SCRIPT); }

// ── made-up values ────────────────────────────────────────────────────────────
const DENY = "T8273641";
const DENY_DIGITS = "8273641";
const PHONE = "(555) 010-0199";
const EMAIL = "opsdesk.north@broker-example.test";
const UPLOADER = "n8n-uploader@example.test";
const FOLDER = "folder-under-test-05";
const GEMINI_MARKER = "QZXMARKERQZX";
const OTHER_TEXT = "Bring the purple ladder to dock nine.";
const REDIRECT_TEXT = "Delivery has been moved to the north yard instead of the dock.";
const HV_TEXT = "HIGH VALUE SHIPMENT: never leave the load unattended; secure it until delivered.";
const T0 = Date.parse("2026-10-22T15:00:00Z");
const ACTOR = "system: driver-instructions backfill";
const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const ENV_ON = Object.freeze({
	[runtime.DENY_LIST_SETTING]: DENY,
	RATECON_DRIVE_UPLOADER_EMAIL: UPLOADER,
	RATECON_DRIVE_FOLDER_ID: FOLDER,
	GEMINI_API_KEY: "gemini-key-under-test",
	GEMINI_OCR_MODEL: "gemini-model-under-test",
});

// A load on Job Tracking. Every load runs Springfield, IL -> Riverton, WY for $1,200.00.
function L(id, status = "Dispatched") {
	const tail = id.slice(-6);
	return { id, status, pu: `48${tail}01`, del: `77${tail}02`, last4: id.slice(-4) };
}
const A = L("771200345");
const B = L("771200400", "Assigned");
const C = L("771200511");
const D = L("771200622");
const E = L("771200733");
const E2 = L("771200734");
const F = L("771200844");
const G = L("771200955");
const H = L("771201066");
const U = L("771201177");
const V = L("771201288");
const N = L("771201399", "");
const CLOSED = [L("771202001", "Delivered"), L("771202002", "Completed"), L("771202003", "Cancel"), L("771202004", "Canceled"), L("771202005", "Cancelled"), L("771202006", "Invoiced")];
const SOFT_DELETED = L("771202007");
const R = L("771203001");
const S = L("771203002");
const P = L("771203003");
const W = L("771203004");

const HEADERS = ["Load ID", "Job Status", "Driver", "Pickup Info", "Pickup Address", "Drop-off Address", "  Payment  ", "Phone Number", "Email", "Broker Contact Name"];
const jtRow = (l) => [l.id, l.status, "Test Driver A", `Test Mill North REF/PU#: ${l.pu}, DEL#: ${l.del}`, "100 Test Park Dr, Springfield, IL 62701", "55 Depot Ln, Riverton, WY 82501", "$1,200.00", PHONE, EMAIL, "Pat Broker"];
const PT_HEADERS = ["Contract ID", " Job ID", "Invoice Number", "Payment Amount"];
const JD_HEADERS = ["", "Distance", "Rate Per Mile", "Details", "Driver", "Pickup Address", "Drop-off Address", "Payment"];
const LANE = "Springfield, IL 62701 - Riverton, WY 82501";

// ── PDFs and Gemini answers ───────────────────────────────────────────────────
function pdfWith(text) {
	const page = Buffer.from(`BT /F1 10 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET`, "latin1");
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${page.length} >>\nstream\n`, "latin1"),
		page,
		Buffer.from("\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n", "latin1"),
	]);
}
const readableText = (l, extra = "") => `Rate Confirmation Carrier Load Confirmation Load ${l.id} Shipper Test Mill North Springfield, IL Pickup Number ${l.pu} ` +
	`Consignee Test Foods DC Riverton, WY Delivery Number ${l.del} Total Rate $1,200.00 Trailer Dry Van Equipment Freight${extra}`;
const readable = (l, extra = "") => pdfWith(readableText(l, extra));
// Wrong facts: the Load ID only, another lane and total, no pickup number.
const wrongFacts = (l) => pdfWith(`Rate Confirmation Carrier Load ${l.id} Shipper Dover, DE Consignee Akron, OH Total Rate $3,333.00 Freight Trailer Equipment Pickup Reference 9990001111`);
// Text the built-in reader can't read (no text object), one per load.
const unreadable = (l) => Buffer.concat([Buffer.from(`%PDF-1.4\n%${l.id}\n1 0 obj\n<< /Length 12 >>\nstream\n`, "latin1"), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]);

function geminiAnswer(obj, finishReason = "STOP") {
	return { status: 200, body: { candidates: [{ content: { parts: [{ text: typeof obj === "string" ? obj : JSON.stringify(obj) }] }, finishReason }] } };
}
function clean(l, over = {}) {
	return {
		loadNumber: l.id,
		documentKind: "carrier_load_confirmation",
		contacts: [PHONE, EMAIL, GEMINI_MARKER],
		loadRequirements: [
			{ category: "high_value", text: HV_TEXT },
			{ category: "same_driver", text: "The same driver must stay with the load from pickup to delivery." },
		],
		stops: [
			{
				kind: "pickup", facility: "Test Mill North", place: "Springfield, IL", address: "100 Test Park Dr, Springfield, IL 62701",
				references: [{ type: "pickup_number", label: "Pickup#", value: l.pu }],
				requirements: [{ category: "ppe", text: "Hard hat and safety glasses are required at the dock." }],
				instructions: [{ kind: "hours", text: "Receiving hours 0700-1500, first come first served." }],
			},
			{
				kind: "delivery", facility: "Test Foods DC", place: "Riverton, WY", address: "55 Depot Ln, Riverton, WY 82501",
				references: [{ type: "delivery_number", label: "Delivery#", value: l.del }],
				requirements: [], instructions: [],
			},
		],
		...over,
	};
}
// Needs review: an item with no category a driver is shown (`other`).
function withOther(l) {
	const x = clean(l);
	x.loadRequirements.push({ category: "other", text: OTHER_TEXT });
	return x;
}
// The four withheld values, an `other` item and redirect wording, on items a driver
// could otherwise get.
function dirty(l) {
	const x = withOther(l);
	x.loadRequirements.push(
		{ category: "equipment", text: `Dry van only. Carrier code ${DENY} applies.` },
		{ category: "equipment", text: "Declared value 1200 must match the paperwork." },
		{ category: "check_in", text: `Questions to ${EMAIL} before arrival please.` },
	);
	x.stops[0].instructions.push({ kind: "shipper", text: "Call dispatch 555-010-0199 if you are running late." }, { kind: "receiver", text: REDIRECT_TEXT });
	x.stops[0].references.push({ type: "other_reference", label: "Ref", value: DENY });
	return x;
}
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// What must never appear in output, logs or tables (plan §3.4): the account number
// digits-only across separators, the amount, the phone, the email, Gemini's own text.
function leaksIn(text) {
	const s = String(text);
	const out = [];
	const runs = s.match(/\d(?:[^A-Za-z0-9]{0,8}\d){0,400}/g) || [];
	if (runs.some((r) => r.replace(/\D/g, "").includes(DENY_DIGITS))) out.push("deny");
	if (/(?<!\d)1[,.' ]?200(?:\.00)?(?!\d)/.test(s)) out.push("amount");
	if (/555\D{0,4}010\D{0,4}0199/.test(s)) out.push("phone");
	if (/opsdesk/i.test(s)) out.push("email");
	if (s.includes(GEMINI_MARKER)) out.push("gemini_text");
	return out;
}

// ── the world ─────────────────────────────────────────────────────────────────
let fileSeq = 0;
// A file in the rate-con folder, by default n8n's and named for the load.
function driveFile(l, bytes, over = {}) {
	fileSeq++;
	return {
		meta: {
			id: `file-${fileSeq}`, name: `Subject: Load ${l.id} Rate Con.pdf`, mimeType: "application/pdf", size: String(bytes.length),
			md5Checksum: `md5-${fileSeq}`, createdTime: new Date(T0 - (100 - fileSeq) * 60 * 1000).toISOString(),
			owners: [{ emailAddress: UPLOADER }], lastModifyingUser: { emailAddress: UPLOADER }, ...over,
		},
		bytes,
	};
}

const BASE_TABLES = `
	CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER, username TEXT, role TEXT, action TEXT NOT NULL,
		entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, driver TEXT NOT NULL, type TEXT NOT NULL, file_name TEXT NOT NULL,
		drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_at DATETIME DEFAULT NULL);
	CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_by TEXT DEFAULT '');
	CREATE TABLE ratecon_load_aliases (alias TEXT PRIMARY KEY, load_id TEXT NOT NULL, source TEXT DEFAULT '', drive_file_id TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`;

// An existing instructions row, as the sweep or a person left it.
function existingRow(l, over = {}) {
	return {
		load_key: l.id, load_id: l.id, payload: JSON.stringify({ v: 1, loadRequirements: [], stops: [], footnote: "From the rate con. Questions: contact dispatch." }),
		status: "auto", review_reasons: "[]", review_counts: "{}", source: "drive_sweep", source_ref: "", source_sha256: "", extractor: runtime.EXTRACTOR,
		pending_payload: "", pending_sha256: "", pending_reasons: "[]", reviewed_by: "", reviewed_at: "", published_at: "", driver_shown_at: "",
		created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z", ...over,
	};
}

function world({ loads = [], files = [], docs = [], rows = [], deleted = [], env = ENV_ON, answers = [], sweeps = [] } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rcpr5-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	const dbFile = path.join(dir, "app.db");
	const db = new Database(dbFile);
	db.pragma("journal_mode = DELETE");
	db.exec(BASE_TABLES);
	runtime.ensureSchema(db);
	for (const r of rows) {
		const cols = Object.keys(r);
		db.prepare(`INSERT INTO load_driver_instructions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => r[c]));
	}
	for (const l of deleted) db.prepare("INSERT INTO deleted_loads (load_id, deleted_by) VALUES (?, 'admin_test')").run(l.id);
	for (const s of sweeps) db.prepare("INSERT INTO ratecon_instruction_sweeps (started_at, listed, extracted, paused_until, note) VALUES (?, 3, 0, '', '')").run(s);
	const uploads = path.join(dir, "uploads");
	fs.mkdirSync(path.join(uploads, "rate-cons"), { recursive: true });
	for (const d of docs) {
		db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_url, deleted_at) VALUES (?, '', ?, ?, ?, ?)")
			.run(d.loadId, d.type || "RATECON", d.fileName, `/uploads/rate-cons/${d.fileName}`, d.deletedAt || null);
		if (d.bytes) fs.writeFileSync(path.join(uploads, "rate-cons", d.fileName), d.bytes);
	}
	db.close();
	const envFile = path.join(dir, "flags.env");
	fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");

	const w = { dir, dbFile, envFile, uploads, files: [...files], answers: new Map(answers.map(([bytes, a]) => [sha256(bytes), a])), loads,
		calls: { sheets: 0, list: 0, listQueries: [], media: [], meta: [], gemini: 0, geminiShas: [], drive: 0 } };
	const drive = {
		files: {
			list: async (params) => {
				w.calls.list++;
				w.calls.listQueries.push(params.q || "");
				return { data: { files: w.files.map((f) => ({ ...f.meta })) } };
			},
			get: async (params) => {
				const f = w.files.find((x) => x.meta.id === params.fileId);
				if (params.alt === "media") {
					w.calls.media.push(params.fileId);
					if (!f || !f.bytes) throw new Error("not found");
					return { data: f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.length) };
				}
				w.calls.meta.push(params.fileId);
				if (!f) throw new Error("not found");
				return { data: { ...f.meta } };
			},
		},
	};
	const fetch = async (url, opts) => {
		w.calls.gemini++;
		let sha = "";
		try {
			const body = JSON.parse(opts.body);
			sha = sha256(Buffer.from(body.contents[0].parts[0].inline_data.data, "base64"));
		} catch { /* not a Gemini body */ }
		w.calls.geminiShas.push(sha);
		const next = w.answers.get(sha) || { status: 500, body: { error: { message: `no answer under test ${GEMINI_MARKER}` } } };
		return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => JSON.stringify(next.body), json: async () => next.body };
	};
	const readSheets = async ({ sheetId }) => {
		w.calls.sheets++;
		w.calls.sheetId = sheetId;
		return {
			jobTracking: [HEADERS, ...w.loads.map(jtRow)],
			payments: [PT_HEADERS, ...w.loads.map((l) => ["Pat Broker", l.id, "", "$1,200.00"])],
			jobDetails: [JD_HEADERS, ["", "1,180 Miles", "$1.02", LANE, "", "", "", "1200"]],
		};
	};
	w.deps = { root: ROOT, now: () => w.clock, getDrive: async () => { w.calls.drive++; return drive; }, readSheets, fetch };
	w.clock = T0;
	// One run, as an operator types it (plus the copy's settings file and uploads folder).
	w.run = async (args = [], { sheet = true } = {}) => {
		const out = [];
		const logs = [];
		const saved = {};
		for (const k of ["log", "info", "warn", "error"]) {
			saved[k] = console[k];
			console[k] = (...a) => logs.push(`${k} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`);
		}
		let code;
		try {
			const argv = ["--db", w.dbFile, "--env-file", w.envFile, "--uploads-dir", w.uploads, ...(sheet ? ["--sheet-id", "sheet-under-test"] : []), ...args];
			code = await backfill().main(argv, { ...w.deps, out: (l) => out.push(String(l)), err: (l) => out.push(String(l)) });
		} finally {
			Object.assign(console, saved);
		}
		return { code, out: out.join("\n"), logs: logs.join("\n") };
	};
	w.open = () => {
		const h = new Database(w.dbFile, { readonly: true });
		cleanups.unshift(() => { try { h.close(); } catch { /* closed */ } });
		return h;
	};
	w.q = (sql, ...a) => {
		const h = new Database(w.dbFile, { readonly: true });
		try { return h.prepare(sql).all(...a); } finally { h.close(); }
	};
	w.row = (l) => w.q("SELECT * FROM load_driver_instructions WHERE load_key = ?", l.id)[0];
	w.count = (t) => w.q(`SELECT COUNT(*) AS n FROM ${t}`)[0].n;
	w.allRows = () => {
		const out = [];
		for (const t of w.q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
			out.push(...w.q(`SELECT * FROM "${t.name}"`).map((r) => `${t.name} ${JSON.stringify(r)}`));
		}
		return out;
	};
	w.fileState = () => {
		const st = fs.statSync(w.dbFile);
		return { sha: sha256(fs.readFileSync(w.dbFile)), mtimeMs: st.mtimeMs, size: st.size, journal: fs.existsSync(`${w.dbFile}-journal`) };
	};
	return w;
}
const TABLES = ["load_driver_instructions", "load_driver_instructions_versions", "ratecon_instruction_files", "ratecon_instruction_sweeps", "audit_trail"];
const counts = (w) => Object.fromEntries(TABLES.map((t) => [t, w.count(t)]));
// The line the script prints for a load.
const lineOf = (out, l) => (out.split("\n").find((x) => x.startsWith(`Load ...${l.last4}:`)) || "");

// The usual world: two loads the backfill writes (a Drive file, a dropped rate con).
function usual(extra = {}) {
	const fa = driveFile(A, readable(A));
	const bBytes = readable(B);
	return world({
		loads: [A, B, ...(extra.loads || [])],
		files: [fa, ...(extra.files || [])],
		docs: [{ loadId: B.id, fileName: `${B.id}.pdf`, bytes: bBytes }, ...(extra.docs || [])],
		answers: [[fa.bytes, geminiAnswer(clean(A))], [bBytes, geminiAnswer(clean(B))], ...(extra.answers || [])],
		rows: extra.rows || [],
		deleted: extra.deleted || [],
		sweeps: extra.sweeps || [],
		env: extra.env || ENV_ON,
	});
}

// ── §1 dry run ────────────────────────────────────────────────────────────────
test("§1 the dry run (the default) writes nothing: a read-only handle, the database file's hash and mtime unchanged; Gemini is called", async ({ eq, ok }) => {
	const w = usual();
	const before = w.fileState();
	const rowsBefore = w.allRows();
	const r = await w.run([]);
	eq("exit 0", r.code, 0);
	eq("the database file is byte-for-byte unchanged, same mtime, no journal left", w.fileState(), before);
	eq("every table holds what it held", w.allRows(), rowsBefore);
	ok("the output says a read-only handle and a dry run", /read-only handle/.test(r.out) && /DRY RUN/.test(r.out), r.out);
	ok("Gemini was called for each load (a dry run reads the rate cons)", w.calls.gemini === 2, w.calls);
	ok("both loads would be written", /WOULD WRITE insert as auto/.test(lineOf(r.out, A)) && /WOULD WRITE insert as auto/.test(lineOf(r.out, B)), r.out);
	const r2 = await w.run(["--dry-run"]);
	eq("--dry-run said explicitly: exit 0, still nothing written", [r2.code, w.fileState()], [0, before]);
	ok("the output gives the apply command", /--apply/.test(r.out), r.out);
});

// ── §2 preconditions ──────────────────────────────────────────────────────────
test("§2 exit 2 without the deny list or the uploader account: nothing read, called or written", async ({ eq, ok }) => {
	const cases = [
		["deny list unset", (e) => { delete e[runtime.DENY_LIST_SETTING]; }, runtime.DENY_LIST_SETTING],
		["deny list empty", (e) => { e[runtime.DENY_LIST_SETTING] = ""; }, runtime.DENY_LIST_SETTING],
		["deny list with no usable value", (e) => { e[runtime.DENY_LIST_SETTING] = "T12"; }, runtime.DENY_LIST_SETTING],
		["uploader account unset", (e) => { delete e.RATECON_DRIVE_UPLOADER_EMAIL; }, "RATECON_DRIVE_UPLOADER_EMAIL"],
		["uploader account not an address", (e) => { e.RATECON_DRIVE_UPLOADER_EMAIL = "n8n-uploader"; }, "RATECON_DRIVE_UPLOADER_EMAIL"],
	];
	for (const [label, change, name] of cases) {
		for (const mode of [[], ["--apply"]]) {
			const env = { ...ENV_ON };
			change(env);
			const w = usual({ env });
			const before = w.fileState();
			const r = await w.run(mode);
			eq(`${label}${mode.length ? " (--apply)" : ""}: exit 2`, r.code, 2);
			ok(`${label}: the refusal names ${name}`, r.out.includes(name), r.out);
			eq(`${label}: no sheet read, no Drive, no Gemini`, [w.calls.sheets, w.calls.drive, w.calls.gemini], [0, 0, 0]);
			eq(`${label}: nothing written`, w.fileState(), before);
			ok(`${label}: no setting's value printed`, !r.out.includes(DENY) && !r.out.includes(UPLOADER), r.out);
		}
	}
	const src = fs.readFileSync(SCRIPT, "utf8");
	ok("the script names the deny list only through the runtime's constant, never a second literal", !src.includes("CARRIER_ACCOUNT_NUMBERS_DENY") && /runtime\.DENY_LIST_SETTING/.test(src));
	const rt = fs.readFileSync(RUNTIME_FILE, "utf8");
	eq("the runtime spells the setting once, in DENY_LIST_SETTING", (rt.match(/"CARRIER_ACCOUNT_NUMBERS_DENY"/g) || []).length, 1);
	ok("...and reads it only through that constant", !/env\.CARRIER_ACCOUNT_NUMBERS_DENY|\.CARRIER_ACCOUNT_NUMBERS_DENY\b/.test(rt.replace(/\/\/[^\n]*/g, "")));
	const w = usual();
	const r = await w.run([], { sheet: false });
	eq("no --sheet-id: exit 2, no default sheet", [r.code, w.calls.sheets], [2, 0]);
	const r2 = await w.run(["--apply", "--dry-run"]);
	eq("--apply with --dry-run: exit 2", r2.code, 2);
	const r3 = await w.run(["--aply"]);
	eq("a mistyped option is refused, never read as an apply", [r3.code, w.calls.gemini], [2, 0]);
});

// ── §3 apply and replay ───────────────────────────────────────────────────────
test("§3 apply writes the open loads; a replay writes 0 rows and calls Gemini 0 times", async ({ eq, ok }) => {
	const w = usual();
	const r = await w.run(["--apply"]);
	eq("exit 0", r.code, 0);
	ok("the output says a writable handle", /writable handle/.test(r.out), r.out);
	const a = w.row(A);
	const b = w.row(B);
	eq("A written from the folder: auto, published, source backfill, the file's id and bytes", [a.status, !!a.published_at, a.source, a.source_ref, a.source_sha256, a.extractor],
		["auto", true, "backfill", w.files[0].meta.id, sha256(w.files[0].bytes), runtime.EXTRACTOR]);
	eq("B written from the dropped rate con: auto, published", [b.status, !!b.published_at, b.source], ["auto", true, "backfill"]);
	ok("the payloads hold the references", a.payload.includes(A.pu) && b.payload.includes(B.del), [a.payload.length, b.payload.length]);
	eq("one version per load", w.count("load_driver_instructions_versions"), 2);
	eq("the folder file is in the sweep's ledger as done", w.q("SELECT state, load_key, sha256 FROM ratecon_instruction_files")[0], { state: "done", load_key: A.id, sha256: sha256(w.files[0].bytes) });
	ok("WRITTEN lines", /WRITTEN insert as auto/.test(lineOf(r.out, A)) && /WRITTEN insert as auto/.test(lineOf(r.out, B)), r.out);
	const snap = w.allRows();
	const file = w.fileState();
	const calls = w.calls.gemini;
	w.clock = T0 + 60 * 60 * 1000;
	const replay = await w.run(["--apply"]);
	eq("replay: exit 0", replay.code, 0);
	eq("replay: every table unchanged (0 rows written)", w.allRows(), snap);
	eq("replay: the database file unchanged", w.fileState(), file);
	eq("replay: no Gemini call", w.calls.gemini - calls, 0);
	ok("replay: the output says 0 written", /0 load\(s\) written/.test(replay.out), replay.out);
});

// ── §4 rows a person or a driver has seen ─────────────────────────────────────
test("§4 reviewed, staff-edited and published rows, and a waiting reading, are never touched; each listed as skipped", async ({ eq, ok }) => {
	const fr = driveFile(R, readable(R));
	const fs2 = driveFile(S, readable(S));
	const fp = driveFile(P, readable(P));
	const fw = driveFile(W, readable(W));
	const rows = [
		existingRow(R, { status: "reviewed", reviewed_by: "disp_test", reviewed_at: "2026-10-21T10:00:00Z", published_at: "2026-10-21T10:00:00Z" }),
		existingRow(S, { status: "reviewed", source: "staff", extractor: "", published_at: "2026-10-21T10:00:00Z" }),
		existingRow(P, { status: "auto", published_at: "2026-10-21T10:00:00Z", source_sha256: "0".repeat(64) }),
		existingRow(W, { status: "needs_review", pending_payload: "{}", pending_sha256: "1".repeat(64), pending_reasons: "[\"rate_con_changed\"]" }),
	];
	const w = usual({ loads: [R, S, P, W], files: [fr, fs2, fp, fw], rows, answers: [fr, fs2, fp, fw].map((f, i) => [f.bytes, geminiAnswer(clean([R, S, P, W][i]))]) });
	const before = Object.fromEntries([R, S, P, W].map((l) => [l.id, w.row(l)]));
	for (const mode of [[], ["--apply"], ["--apply", "--write-needs-review"]]) {
		const r = await w.run(mode);
		eq(`${mode.join(" ") || "dry run"}: exit 0`, r.code, 0);
		for (const [l, code] of [[R, "reviewed"], [S, "staff_edited"], [P, "published"], [W, "pending_waiting"]]) {
			eq(`${mode.join(" ") || "dry run"}: ${code} row byte-for-byte unchanged`, w.row(l), before[l.id]);
			ok(`${mode.join(" ") || "dry run"}: listed as SKIPPED ${code}`, lineOf(r.out, l).includes(`SKIPPED ${code}`), lineOf(r.out, l));
		}
	}
	eq("their files were never downloaded, and never sent to Gemini", [[fr, fs2, fp, fw].filter((f) => w.calls.media.includes(f.meta.id)).length, [fr, fs2, fp, fw].filter((f) => w.calls.geminiShas.includes(sha256(f.bytes))).length], [0, 0]);
	eq("no version, ledger or audit row for them", [w.count("load_driver_instructions_versions") - 2, w.q("SELECT COUNT(*) AS n FROM ratecon_instruction_files WHERE load_key IN (?, ?, ?, ?)", R.id, S.id, P.id, W.id)[0].n,
		w.q("SELECT COUNT(*) AS n FROM audit_trail WHERE entity_id IN (?, ?, ?, ?)", R.id, S.id, P.id, W.id)[0].n], [0, 0, 0]);
});

// ── §5 scope ──────────────────────────────────────────────────────────────────
test("§5 only active and upcoming loads are in scope: Delivered, Completed, Cancel(l)ed, Invoiced and soft-deleted loads are not read", async ({ eq, ok }) => {
	const out = [...CLOSED, SOFT_DELETED];
	const outFiles = out.map((l) => driveFile(l, readable(l)));
	const fn = driveFile(N, readable(N));
	const w = usual({ loads: [N, ...out], files: [fn, ...outFiles], deleted: [SOFT_DELETED], answers: [[fn.bytes, geminiAnswer(clean(N))], ...outFiles.map((f, i) => [f.bytes, geminiAnswer(clean(out[i]))])] });
	const r = await w.run(["--apply"]);
	eq("exit 0", r.code, 0);
	eq("rows for the active (Dispatched), upcoming (Assigned) and unassigned loads only", w.q("SELECT load_key FROM load_driver_instructions ORDER BY load_key").map((x) => x.load_key), [A.id, B.id, N.id].sort());
	eq("no out-of-scope file downloaded or sent to Gemini", [outFiles.filter((f) => w.calls.media.includes(f.meta.id)).length, outFiles.filter((f) => w.calls.geminiShas.includes(sha256(f.bytes))).length], [0, 0]);
	ok("no out-of-scope load printed", out.every((l) => !lineOf(r.out, l)), r.out);
	ok("the scope line counts them", /3 open load\(s\) in scope; 7 closed or deleted not read/.test(r.out), r.out);
});

// ── §6 uncertain loads ────────────────────────────────────────────────────────
test("§6 each uncertain kind is skipped and logged with its code, and written nowhere", async ({ eq, ok }) => {
	const fd = driveFile(D, wrongFacts(D));
	const fe = driveFile(E, readable(E), { owners: [{ emailAddress: "someone-else@example.test" }] });
	const fe2 = driveFile(E2, readable(E2), { lastModifyingUser: { emailAddress: "someone-else@example.test" } });
	const ff = driveFile(F, readable(F));
	const fg = driveFile(G, readable(G));
	const fgt = driveFile(G, readable(G, " Revised"));
	const fv = driveFile(V, unreadable(V));
	const fx = driveFile(C, readable(C), { mimeType: "image/png" });
	const uncertain = [[C, "no_source"], [D, "match_unconfirmed"], [E, "uploader_mismatch"], [E2, "uploader_mismatch"], [F, "extract_failed"], [G, "extract_invalid"], [V, "match_unconfirmed"]];
	const w = usual({
		loads: uncertain.map(([l]) => l),
		files: [fd, fe, fe2, ff, fg, fgt, fv, fx],
		docs: [{ loadId: C.id, fileName: `${C.id}.pdf`, bytes: null }, { loadId: C.id, fileName: `${C.id}-old.pdf`, bytes: readable(C), deletedAt: "2026-10-20 10:00:00" }],
		answers: [
			[fd.bytes, geminiAnswer(clean(D))], [fe.bytes, geminiAnswer(clean(E))], [fe2.bytes, geminiAnswer(clean(E2))],
			[ff.bytes, { status: 500, body: { error: { message: `server trouble ${GEMINI_MARKER}` } } }],
			[fg.bytes, geminiAnswer(`{"stops": [ ${GEMINI_MARKER}`)], [fgt.bytes, geminiAnswer(clean(G), "MAX_TOKENS")],
			[fv.bytes, geminiAnswer(clean(V, { loadNumber: "771209999" }))],
		],
	});
	for (const mode of [[], ["--apply"]]) {
		const r = await w.run(mode);
		eq(`${mode.join(" ") || "dry run"}: exit 0`, r.code, 0);
		for (const [l, code] of uncertain) {
			ok(`${mode.join(" ") || "dry run"}: ...${l.last4} SKIPPED ${code}, marked written nowhere`, new RegExp(`^Load \\.\\.\\.${l.last4}: SKIPPED ${code}\\b.*written nowhere`).test(lineOf(r.out, l)), lineOf(r.out, l));
		}
		ok(`${mode.join(" ") || "dry run"}: the extraction failure names its code only`, /SKIPPED extract_failed \(gemini_\w+\)/.test(lineOf(r.out, F)), lineOf(r.out, F));
	}
	for (const [l] of uncertain) {
		eq(`...${l.last4}: no instructions row, version, ledger or audit row`, [w.row(l) || null, w.q("SELECT COUNT(*) AS n FROM load_driver_instructions_versions WHERE load_key = ?", l.id)[0].n,
			w.q("SELECT COUNT(*) AS n FROM ratecon_instruction_files WHERE load_key = ?", l.id)[0].n, w.q("SELECT COUNT(*) AS n FROM audit_trail WHERE entity_id = ?", l.id)[0].n], [null, 0, 0, 0]);
	}
	eq("the two control loads were written", w.count("load_driver_instructions"), 2);
	eq("no ledger row for any file of an uncertain load", w.q("SELECT drive_file_id FROM ratecon_instruction_files").map((x) => x.drive_file_id), [w.files[0].meta.id]);
	eq("the wrong-owner and wrong-modifier files were never downloaded", [fe, fe2].filter((f) => w.calls.media.includes(f.meta.id)).length, 0);
	eq("the wrong-facts readable file was never sent to Gemini", w.calls.geminiShas.includes(sha256(fd.bytes)), false);
	ok("the unreadable file was matched from Gemini's answer (sent, then refused)", w.calls.geminiShas.includes(sha256(fv.bytes)));
});

// ── §7 the audit trail ────────────────────────────────────────────────────────
test("§7 every audit row the backfill writes carries the system actor; versions and the ledger name it too", async ({ eq, ok }) => {
	const w = usual();
	const r = await w.run(["--apply"]);
	eq("exit 0", r.code, 0);
	const rows = w.q("SELECT user_id, username, role, action, entity, entity_id, details FROM audit_trail ORDER BY id");
	ok("one row per load written, plus the cursor's", rows.length === 3, rows);
	for (const a of rows) eq(`audit ${a.action} ${a.entity_id}: the system actor`, [a.user_id, a.username, a.role, a.entity], [0, ACTOR, "system", "driver_instructions"]);
	const perLoad = rows.filter((x) => x.action === "backfill");
	eq("per-load rows name the loads", perLoad.map((x) => x.entity_id).sort(), [A.id, B.id].sort());
	const d = JSON.parse(perLoad.find((x) => x.entity_id === A.id).details);
	eq("details are codes and counts: source, result, status, reasons, payload summary", [d.source, d.result, d.status, d.reasons, d.stops, d.references], ["drive", "insert", "auto", [], 2, 2]);
	eq("the cursor's row", rows.filter((x) => x.action === "backfill_cursor").length, 1);
	eq("versions name the actor", [...new Set(w.q("SELECT actor FROM load_driver_instructions_versions").map((x) => x.actor))], [ACTOR]);
	eq("the ledger note is a code", w.q("SELECT note FROM ratecon_instruction_files")[0].note, "backfill");
});

// ── §8 decision 11's exception ────────────────────────────────────────────────
test("§8 --write-needs-review writes a confirmed match with review reasons as needs_review, unpublished, audited; without it the load is skipped", async ({ eq, ok }) => {
	const fh = driveFile(H, readable(H));
	const fu = driveFile(U, unreadable(U));
	const w = usual({ loads: [H, U], files: [fh, fu], answers: [[fh.bytes, geminiAnswer(withOther(H))], [fu.bytes, geminiAnswer(clean(U))]] });
	const r0 = await w.run(["--apply"]);
	eq("without the flag: exit 0", r0.code, 0);
	ok("without the flag: both listed SKIPPED needs_review with their reasons", /SKIPPED needs_review.*written nowhere/.test(lineOf(r0.out, H)) && /SKIPPED needs_review/.test(lineOf(r0.out, U)) && /unusual_content/.test(r0.out) && /not_cross_checked/.test(r0.out), r0.out);
	eq("without the flag: no row, ledger or audit row for them", [w.row(H) || null, w.row(U) || null, w.q("SELECT COUNT(*) AS n FROM audit_trail WHERE entity_id IN (?, ?)", H.id, U.id)[0].n], [null, null, 0]);
	ok("without the flag: the run says the exception is off", /exception \(decision 11\): off/.test(r0.out), r0.out);
	const dry = await w.run(["--write-needs-review"]);
	ok("dry run with the flag: would write needs_review, unpublished, under the exception", /WOULD WRITE insert as needs_review \(unpublished\) \[decision 11 exception\]/.test(lineOf(dry.out, H)), lineOf(dry.out, H));
	ok("dry run with the flag: the run prints the exception is on", /exception \(decision 11\): ON/.test(dry.out), dry.out);
	eq("dry run with the flag: nothing written", [w.row(H) || null, w.row(U) || null], [null, null]);
	const r1 = await w.run(["--apply", "--write-needs-review"]);
	eq("with the flag: exit 0", r1.code, 0);
	for (const [l, reason] of [[H, "unusual_content"], [U, "not_cross_checked"]]) {
		const row = w.row(l);
		eq(`...${l.last4}: needs_review, unpublished, never shown`, [row.status, row.published_at, row.driver_shown_at, JSON.parse(row.review_reasons).includes(reason)], ["needs_review", "", "", true]);
		const a = w.q("SELECT username, details FROM audit_trail WHERE entity_id = ? AND action = 'backfill'", l.id);
		ok(`...${l.last4}: audited as the exception`, a.length === 1 && a[0].username === ACTOR && JSON.parse(a[0].details).exception === "decision_11", a);
	}
	eq("the clean load needs no exception", JSON.parse(w.q("SELECT details FROM audit_trail WHERE entity_id = ? AND action = 'backfill'", A.id)[0].details).exception, undefined);
	const snap = w.allRows();
	const calls = w.calls.gemini;
	const r2 = await w.run(["--apply", "--write-needs-review"]);
	eq("replay with the flag: 0 rows written, no Gemini call", [r2.code, w.allRows(), w.calls.gemini - calls], [0, snap, 0]);
	ok("replay: the needs_review rows are unchanged (same bytes, same extractor)", /SKIPPED unchanged/.test(lineOf(r2.out, H)) && /SKIPPED unchanged/.test(lineOf(r2.out, U)), r2.out);
});

// ── §9 the sweep's cursor ─────────────────────────────────────────────────────
test("§9 apply records the backfill time as the sweep's starting cursor; the sweep then lists from it; a sweep already run keeps its own", async ({ eq, ok }) => {
	const w = usual();
	await w.run([]);
	eq("a dry run writes no cursor", w.count("ratecon_instruction_sweeps"), 0);
	const r = await w.run(["--apply"]);
	eq("exit 0", r.code, 0);
	const sw = w.q("SELECT started_at, listed, note FROM ratecon_instruction_sweeps");
	eq("one cursor row at the run's start, counted as a complete sweep", sw, [{ started_at: isoOf(T0), listed: 1, note: "backfill" }]);
	ok("the output names the cursor", r.out.includes(`sweep starts at ${isoOf(T0)}`), r.out);
	// The shipped sweep, on this database, an hour later.
	const db = new Database(w.dbFile);
	cleanups.unshift(() => db.close());
	const queries = [];
	const svc = runtime.create({
		db, env: { ...ENV_ON, RATECON_DRIVER_INSTRUCTIONS_ENABLED: "true" }, log: { log() {}, warn() {}, error() {} }, now: () => T0 + 60 * 60 * 1000,
		getDrive: async () => ({ files: { list: async (p) => { queries.push(p.q); return { data: { files: [] } }; }, get: async () => { throw new Error("none"); } } }),
		getJobTracking: async () => ({ headers: HEADERS, data: [] }), getSideSheets: async () => ({ payments: [], jobDetails: [] }),
		brokerWithheldRe: /broker|phone|e-?mail|contact/i, logAudit: () => {}, logAuditRefusal: () => {}, fetch: async () => { throw new Error("no"); },
	});
	const s = await svc.sweep();
	ok("the first sweep lists files created since the backfill time minus its 10-minute overlap", s.ran && queries.length === 1 && queries[0].includes(`createdTime >= '${isoOf(T0 - 10 * 60 * 1000)}'`), queries);
	const w2 = usual({ sweeps: ["2026-10-22T14:30:00Z"] });
	const r2 = await w2.run(["--apply"]);
	eq("with a sweep already run: exit 0, its row kept, no cursor added", [r2.code, w2.q("SELECT started_at FROM ratecon_instruction_sweeps").map((x) => x.started_at)], [0, ["2026-10-22T14:30:00Z"]]);
	ok("...and the output says it is kept", /cursor: kept/.test(r2.out), r2.out);
});

// ── §10 Gemini's text ─────────────────────────────────────────────────────────
test("§10 no Gemini text in the output, the logs, the audit trail or any table", async ({ eq, ok }) => {
	const fh = driveFile(H, readable(H));
	const ff = driveFile(F, readable(F));
	const fg = driveFile(G, readable(G));
	const w = usual({ loads: [H, F, G], files: [fh, ff, fg], answers: [[fh.bytes, geminiAnswer(dirty(H))], [ff.bytes, { status: 503, body: { error: { message: `overloaded ${GEMINI_MARKER}` } } }], [fg.bytes, geminiAnswer(`{"x": "${GEMINI_MARKER}`)]] });
	const runs = [await w.run([]), await w.run(["--apply", "--write-needs-review"]), await w.run(["--preview", H.id])];
	for (const [i, r] of runs.entries()) {
		eq(`run ${i + 1}: exit 0`, r.code, 0);
		eq(`run ${i + 1}: nothing withheld or Gemini's own text in the output or the logs`, leaksIn(`${r.out}\n${r.logs}`), []);
	}
	eq("no table holds a withheld value or Gemini's own text", leaksIn(w.allRows().join("\n")), []);
	ok("H was written (so its payload was checked above)", w.row(H) && w.row(H).status === "needs_review");
	ok("a Gemini call failed and was refused during the runs", w.calls.geminiShas.includes(sha256(ff.bytes)) && w.calls.geminiShas.includes(sha256(fg.bytes)));
});

// ── §11 --preview ─────────────────────────────────────────────────────────────
test("§11 --preview prints only the driver-safe payload, for one load, and only in a dry run", async ({ eq, ok }) => {
	const fa = driveFile(A, readable(A));
	const w = world({ loads: [A, B], files: [fa], answers: [[fa.bytes, geminiAnswer(dirty(A))]] });
	const before = w.fileState();
	const r = await w.run(["--preview", A.id]);
	eq("exit 0", r.code, 0);
	ok("the driver view is printed: the references and the high-value requirement", r.out.includes(A.pu) && r.out.includes(A.del) && r.out.includes(HV_TEXT), r.out);
	eq("nothing withheld is printed", leaksIn(r.out), []);
	ok("items a driver isn't shown are not printed (no category, redirect wording)", !r.out.includes(OTHER_TEXT) && !r.out.includes("north yard"), r.out);
	ok("only that load is read", !lineOf(r.out, B) && w.calls.gemini === 1, r.out);
	eq("nothing written", w.fileState(), before);
	const plain = await w.run([]);
	ok("without --preview no payload text is printed", !plain.out.includes(HV_TEXT) && !plain.out.includes(A.pu), plain.out);
	const ap = await w.run(["--apply", "--preview", A.id]);
	eq("--preview with --apply: exit 2, nothing written", [ap.code, w.fileState()], [2, before]);
	const closed = CLOSED[0];
	const nc = await w.run(["--preview", closed.id]);
	eq("--preview of a load that isn't open: exit 2", nc.code, 2);
	// A published row whose stored payload is dirty: the preview re-filters it, as every
	// read does, and hides the flagged item.
	const stored = {
		v: 1,
		loadRequirements: [{ category: "high_value", text: HV_TEXT, critical: true }, { category: "other", text: OTHER_TEXT }, { category: "equipment", text: `Carrier code ${DENY} applies.` }],
		stops: [{
			seq: 1, kind: "pickup", facility: "Test Mill North", place: "Springfield, IL",
			references: [{ type: "pickup_number", label: "Pickup#", value: P.pu }, { type: "other_reference", label: "Ref", value: DENY }],
			requirements: [], instructions: [{ kind: "shipper", text: "Call 555-010-0199 before arrival." }],
		}],
		footnote: "From the rate con. Questions: contact dispatch.",
	};
	const w2 = world({ loads: [P], rows: [existingRow(P, { published_at: "2026-10-21T10:00:00Z", payload: JSON.stringify(stored) })] });
	const before2 = w2.fileState();
	const rp = await w2.run(["--preview", P.id]);
	eq("a published row: exit 0, skipped, no Gemini call, nothing written", [rp.code, /SKIPPED published/.test(lineOf(rp.out, P)), w2.calls.gemini, w2.fileState()], [0, true, 0, before2]);
	ok("its stored driver view is printed", rp.out.includes(HV_TEXT) && rp.out.includes(P.pu), rp.out);
	eq("re-filtered: nothing withheld is printed", leaksIn(rp.out), []);
	ok("...and the flagged item is hidden", !rp.out.includes(OTHER_TEXT), rp.out);
});

// ── §12 the documents source ──────────────────────────────────────────────────
test("§12 a dropped rate con (documents RATECON, uploads/rate-cons/) is the source when the folder has none; a removed document is not", async ({ eq, ok }) => {
	const w = world({
		loads: [B, C],
		docs: [{ loadId: B.id, fileName: `${B.id}.pdf`, bytes: readable(B) }, { loadId: C.id, fileName: `${C.id}.pdf`, bytes: readable(C), deletedAt: "2026-10-21 09:00:00" },
			{ loadId: B.id, type: "BOL", fileName: `${B.id}-bol.pdf`, bytes: readable(B, " Bill") }],
		answers: [[readable(B), geminiAnswer(clean(B))], [readable(C), geminiAnswer(clean(C))]],
	});
	const r = await w.run(["--apply"]);
	eq("exit 0", r.code, 0);
	const b = w.row(B);
	eq("B written from its documents row", [b.status, b.source, b.source_ref], ["auto", "backfill", String(w.q("SELECT id FROM documents WHERE load_id = ? AND type = 'RATECON'", B.id)[0].id)]);
	ok("its source is printed as documents", /source: documents/.test(r.out), r.out);
	ok("C's removed document is no source", /SKIPPED no_source/.test(lineOf(r.out, C)) && !w.row(C), lineOf(r.out, C));
	eq("no ledger row for a documents source", w.count("ratecon_instruction_files"), 0);
});

runAll();
