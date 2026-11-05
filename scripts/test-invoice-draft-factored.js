#!/usr/bin/env node
// The Draft Invoice button (POST /api/loads/:loadId/draft-invoice) and the
// factoring marker (Triumph T0): the route as it runs, lifted whole from
// server.js with its real engine (lib/broker-invoice-draft.js) over an
// in-memory database; Sheets, Drive, the renderer, Gmail and n8n are spies.
//
//   §1 a factored load: 409 LOAD_FACTORED before prepare(), nothing read,
//      minted, drafted or posted; the confirmation is refused whoever asks (409
//      NOA_UNCONFIGURED, nothing spent) until assignment lines exist; once they
//      do, it works only for a listed account (never the shared login) with a
//      reason, and is audited
//   §2 once assignment lines exist, the confirmation against a Triumph claim that
//      works or holds a number (TRIUMPH_IN_FLIGHT) and a locked row
//      (FACTORING_LOCKED); a locked row refuses the plain press too, even at 0; a
//      marker that can't be read
//   §3 the late re-check (after the render, before the hand-off): a mark, a
//      Triumph number or a lock that lands during the render; the minted number
//      voided with one invoice_number_void row
//   §4 the in-flight row: a second press, marking and clearing while a draft is
//      in flight; success deletes it with the draft row; record() failing
//      leaves it maybe drafted
//   §5 unanswered failures: IMAP with no answer, n8n timing out, failing on the
//      network or answering 502: maybe drafted, nothing voided, "may be in
//      Gmail" words; a refusal before n8n after an unanswered IMAP; a definite
//      failure deletes the row and voids the number
//   §6 "Check Gmail": found, absent, unknown; a person's answer for n8n
//   §7 nothing marked: today's answers, a Message-ID on the draft, and no row
//      left behind
//   Then §1b and §4-§7 again with every switch off (TRIUMPH_FACTORING_ENABLED and
//   TRIUMPH_FACTOR_MARK_IDS unset, as production ships): a load the lead's
//   scripts/factoring-mark.js marked is refused before prepare() and caught by the
//   late re-check, and the in-flight row works the same (plan §11.5).
//   §8 mutants, among them the button's checks made to follow the marking switch
//
// Made-up loads only (LD-TEST-*), domain example-broker.test. Pure: no server,
// port, app.db or network.
//   node scripts/test-invoice-draft-factored.js      # exits 1 on any failure
"use strict";

const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();
const draftLift = require("./lib/broker-invoice-draft-lift");
const { closure } = require("./lib/server-lift");
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
// Absent on a tree before the marker: the cases then run against that tree's
// route and fail by name.
const optional = (p) => {
	try {
		return require(p);
	} catch {
		return null;
	}
};
const store = optional(path.join(ROOT, "lib", "factoring-store.js"));
const routesLib = optional(path.join(ROOT, "lib", "factoring-routes.js"));
const markScript = optional(path.join(ROOT, "scripts", "factoring-mark.js"));

let pass = 0;
const failures = [];
// Where a failure goes: the run's list, or a mutant's own (§8).
let sink = failures;
let sectionLog = (t) => console.log(`\n${t}`);
// The settings a world is built with: "on" (marking on, accounts 7 and 9 listed)
// or "off" (both settings unset, as production ships), and the tag a case's label
// carries in the "off" run.
let MODE = "on";
const modeTag = () => (MODE === "off" ? " [every switch off]" : "");
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { if (sink === failures) pass++; return; }
	sink.push(`${label}${modeTag()}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { sectionLog(`${t}${modeTag()}`); }

const QUIET = { log() {}, warn() {}, error() {}, info() {} };
const SENDER = "drafts@example.test";
const TO = "billing@example-broker.test";
const NOW = "2026-11-03T15:00:00.000Z";
const LISTED = Object.freeze({ id: 7, username: "made-up-admin", role: "Super Admin" });
const UNLISTED = Object.freeze({ id: 8, username: "made-up-other", role: "Super Admin" });
const SHARED = Object.freeze({ id: 9, username: "super_admin", role: "Super Admin" });
const SHEET = [
	["Load ID", "Status", "Email", "Broker Contact Name", "Driver", "Trailer", "Delivery Date", "  Payment  "],
	...Array.from({ length: 40 }, (_, i) => [`LD-TEST-${String(i + 1).padStart(4, "0")}`, "Delivered", "dispatch@example-broker.test", "Made-up Agent", "Made-up Driver", "", "11/02/2026", "2150"]),
];
const id = (n) => `LD-TEST-${String(n).padStart(4, "0")}`;
const key = (n) => id(n).toLowerCase();

// The tables a tree before the marker lacks, so its runs can still mark loads.
const FALLBACK_DDL = `
	CREATE TABLE IF NOT EXISTS load_factoring (load_key TEXT PRIMARY KEY, load_id TEXT NOT NULL DEFAULT '', factored INTEGER NOT NULL, source TEXT NOT NULL,
		reason TEXT NOT NULL DEFAULT '', set_at TEXT NOT NULL, set_by TEXT NOT NULL DEFAULT '', set_by_id INTEGER NOT NULL DEFAULT 0,
		locked_at TEXT NOT NULL DEFAULT '', locked_via TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS triumph_submissions (load_key TEXT PRIMARY KEY, load_id TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, reason_code TEXT NOT NULL DEFAULT '',
		first_seen_at TEXT NOT NULL, lease_owner TEXT NOT NULL DEFAULT '', lease_until TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT '',
		invoice_id TEXT NOT NULL DEFAULT '', number_voided_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS invoice_draft_inflight (load_key TEXT NOT NULL, load_id TEXT NOT NULL DEFAULT '', invoice_id TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '',
		path TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', actor_id INTEGER NOT NULL DEFAULT 0, recipient TEXT NOT NULL DEFAULT '',
		total TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (load_key, invoice_id));`;

// ------------------------------------------------------------------ the route
const NEEDLE = '["/api/loads/:loadId/draft-invoice", "/api/loads/:loadId/draft-bison-invoice"],';
const LIFT = (() => {
	const lines = SRC.split("\n");
	let s = lines.findIndex((l) => l.includes(NEEDLE));
	while (s > 0 && !/^app\.post\(/.test(lines[s])) s--;
	let e = s;
	while (e < lines.length && lines[e] !== ");") e++;
	const createAt = SRC.indexOf("CREATE TABLE IF NOT EXISTS load_invoice_drafts (");
	return {
		route: lines.slice(s, e + 1).join("\n"),
		helpers: closure(SRC, {
			roots: ["parseInvoiceOverrides", "parseSheet", "deduplicateLoads", "findCol", "latestDraftNotes", "invoiceIdAlreadyUsed", "safeAttachmentName", "mdyToIso", "sanitizeEvidenceText"],
			provided: ["db", "brokerInvoice", "console"],
			denied: ["app", "server", "io", "getSheets", "getDrive"],
		}),
		engine: draftLift.readEngine(ROOT),
		createSql: SRC.slice(createAt, SRC.indexOf("`", createAt)),
		alters: [...SRC.matchAll(/db\.exec\("(ALTER TABLE load_invoice_drafts ADD COLUMN [^"]+)"\)/g)].map((m) => m[1]),
	};
})();
// What world() builds from: the shipped texts, or a mutant's (§8).
const CUR = { route: LIFT.route, routesLib };

const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((a, b) => { resolve = a; reject = b; });
	return { promise, resolve, reject };
};
const stagedError = (message, stage, answered) => Object.assign(new Error(message), { stage, ...(answered ? { answered: true } : {}) });

// One world: the route over a fresh database. `gmail` and `n8n` say which
// hand-off targets are set; `ids` is TRIUMPH_FACTOR_MARK_IDS; `off` builds it
// with TRIUMPH_FACTORING_ENABLED and TRIUMPH_FACTOR_MARK_IDS both unset (the
// run's MODE by default). With every switch off, loads are marked the way the
// lead's scripts/factoring-mark.js marks them. `lines` builds it as if assignment
// lines existed, which keeps the confirmation's own rules pinned; the server never
// says so, and no other world does. `settings`: more of the server's settings.
function world({ gmail = true, n8n = false, ids = "7,9", unreadableMarker = false, off = MODE === "off", lines = false, settings = {} } = {}) {
	const db = new Database(":memory:");
	db.exec(LIFT.createSql);
	for (const a of LIFT.alters) db.exec(a);
	db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT, type TEXT, file_name TEXT, uploaded_at TEXT, deleted_at TEXT)");
	db.exec(`CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL,
		role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '')`);
	const addPod = db.prepare("INSERT INTO documents (load_id, type, file_name, uploaded_at) VALUES (?, 'POD', ?, '2026-11-02T15:00:00Z')");
	for (const row of SHEET.slice(1)) addPod.run(row[0], `${row[0]}_POD.pdf`);
	if (store) store.ensureSchema(db);
	else db.exec(FALLBACK_DDL);
	const w = {
		db,
		seen: { prepare: 0, render: 0, mint: 0, imap: [], n8n: [], search: [], audits: [], refusals: [] },
		imap: [], // behaviours, in turn: "OK", "NO", "LOST", "HOLD", "LOGIN"
		n8n: [], // "OK", "502", "ABORT", "NETWORK"
		holds: [],
		search: "absent", // "found", "absent", "fail"
		duringRender: null,
		duringImap: null,
	};
	const h = LIFT.helpers;
	const helpers = new Function("db", "brokerInvoice", "console", `${h.text}\nreturn { ${h.names.join(", ")} };`)(db, brokerInvoice, QUIET);
	const env = { DEFAULT_INVOICE_EMAIL: TO, ...(gmail ? { GMAIL_USER: SENDER, GMAIL_APP_PASSWORD: "made-up" } : {}),
		...(n8n ? { N8N_INVOICE_WEBHOOK_URL: "https://n8n.example.test/webhook", N8N_WEBHOOK_SECRET: "made-up" } : {}) };
	let mints = 0;
	const scope = {
		...helpers,
		requireRole: () => () => {},
		refuseCrossSite: () => {},
		draftInvoiceLimiter: () => {},
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: SHEET } }) } } }),
		SPREADSHEET_ID: "sheet-under-test-factored",
		brokerInvoice,
		db,
		fetchDocumentBytes: async () => Buffer.from("%PDF-1.4 made-up pod"),
		buildRateConLoadCtx: () => ({}),
		getRateConBytes: async () => ({ buffer: null, candidates: [] }),
		rateconViewGate: require(path.join(ROOT, "lib", "ratecon-pdf-route.js")).viewerGate(require(path.join(ROOT, "lib", "listed-accounts.js")).parseListedAccountIds(undefined)),
		GEMINI_API_KEY: "",
		runRateConGemini: async () => null,
		peekInvoiceNumber: () => `11032026-${mints + 1}`,
		nextInvoiceNumber: () => { w.seen.mint++; return `11032026-${++mints}`; },
		renderHtmlToPdf: async () => {
			w.seen.render++;
			if (w.duringRender) w.duringRender(db);
			return Buffer.from("%PDF-1.4 made-up invoice");
		},
		logAudit: (req, action, entity, entityId, details) => w.seen.audits.push({ action, entityId, details: String(details || "") }),
		appendGmailDraft: async (msg) => {
			w.seen.imap.push({ to: msg.to, messageId: msg.messageId });
			if (w.duringImap) w.duringImap(db);
			const b = w.imap.shift() || "OK";
			if (b === "HOLD") {
				const d = deferred();
				w.holds.push(d);
				return d.promise;
			}
			if (b === "NO") throw stagedError("IMAP APPEND failed: a2 NO made-up", "literal", true);
			if (b === "LOGIN") throw stagedError("IMAP LOGIN failed", "login", true);
			if (b === "LOST") throw stagedError("IMAP timeout at stage 3", "literal", false);
			return { ok: true };
		},
		sentIfRendererBusy: () => false,
		REPLICA: null,
		process: { env },
		fetch: async (url) => {
			w.seen.n8n.push(String(url));
			const b = w.n8n.shift() || "OK";
			if (b === "ABORT") throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
			if (b === "NETWORK") throw new TypeError("fetch failed");
			if (b === "502") return { ok: false, status: 502, text: async () => "{}" };
			return { ok: true, status: 200, text: async () => '{"draftId":"made-up-n8n-1"}' };
		},
		console: QUIET,
	};
	const engine = draftLift.loadEngine(LIFT.engine, { ...scope, env });
	scope.brokerInvoiceDraft = {
		prepare: (...a) => { w.seen.prepare++; return engine.prepare(...a); },
		render: (...a) => engine.render(...a),
		record: (...a) => engine.record(...a),
	};
	const routesDb = unreadableMarker ? (() => { const x = new Database(":memory:"); if (store) store.ensureSchema(x); x.close(); return x; })() : db;
	const routes = CUR.routesLib ? CUR.routesLib.create({
		db: routesDb,
		env: off ? { ...settings } : { TRIUMPH_FACTORING_ENABLED: "true", ...(ids === null ? {} : { TRIUMPH_FACTOR_MARK_IDS: ids }), ...settings },
		...(lines ? { hasAssignmentLines: true } : {}),
		now: () => new Date(w.now || NOW),
		logAudit: scope.logAudit,
		logAuditRefusal: (req, action, entity, entityId, details, code) => w.seen.refusals.push({ action, code }),
		findDraftByMessageId: async ({ messageId }) => {
			w.seen.search.push(messageId);
			if (w.search === "fail") throw stagedError("IMAP SEARCH failed: made-up", "search", true);
			return { found: w.search === "found" };
		},
		mailbox: () => (gmail ? { user: SENDER, pass: "made-up" } : { user: "", pass: "" }),
		newMessageId: () => `<made-up-${++w.ids}.auto-invoice@example.test>`,
	}) : null;
	w.ids = 0;
	scope.factoringRoutes = routes;
	// The automatic job's check for a load it sent (pinned in scripts/test-auto-invoice-job.js
	// §24): no claim here, so it lets every press through, as the job does.
	scope.autoInvoice = { draftButtonCheck: () => ({ ok: true }) };
	const registered = [];
	new Function("app", ...Object.keys(scope), CUR.route)({ post: (...args) => registered.push(args) }, ...Object.values(scope));
	const handler = registered[0][registered[0].length - 1];
	const respond = () => {
		const out = { status: 200, body: null };
		const res = { statusCode: 200, headersSent: false, status(c) { this.statusCode = c; out.status = c; return this; }, json(b) { out.status = this.statusCode; out.body = b; this.headersSent = true; return this; } };
		return { out, res };
	};
	// The button's press: ?dryRun=1 with `dry`.
	w.press = async (n, { user = LISTED, body = {}, dry = false } = {}) => {
		const { out, res } = respond();
		await handler({ params: { loadId: id(n) }, query: dry ? { dryRun: "1" } : {}, body, session: { user: { ...user } }, ip: "127.0.0.1" }, res);
		return out;
	};
	// The factoring routes, through their own guards (Super Admin, a stub cross-site check).
	const mounted = {};
	if (routes) {
		const app = { post: (p, ...chain) => { mounted[p] = chain; } };
		routes.mount(app, { requireRole: (role) => (req, res, next) => (req.session.user.role === role ? next() : res.status(403).json({ code: "FORBIDDEN" })), refuseCrossSite: (req, res, next) => next() });
	}
	w.route = async (p, { user = LISTED, params = {}, body = {} } = {}) => {
		const chain = mounted[p];
		if (!chain) return { status: 0, body: { code: "NO_ROUTE" } };
		const { out, res } = respond();
		const req = { params, body, session: { user: { ...user } } };
		for (const fn of chain) {
			let next = false;
			await fn(req, res, () => { next = true; });
			if (!next) break;
		}
		return out;
	};
	// Marking: the route (marking on), or the lead's script (every switch off),
	// answered in the route's shape.
	const byScript = (n, mode) => {
		if (!markScript) return { status: 0, body: { code: "NO_SCRIPT" } };
		const r = markScript.run({ db, ids: [id(n)], mode, dryRun: false, reason: "made-up reason", nowIso: NOW });
		const one = r.loads[0] || {};
		return { status: one.code ? 409 : 200, body: one.code ? { code: one.code } : { ok: true, changed: one.outcome === "changed" } };
	};
	w.mark = async (n, body = {}) => (off ? byScript(n, "mark")
		: w.route("/api/factoring/loads/:loadKey", { params: { loadKey: key(n) }, body: { factored: true, reason: "made-up reason", ...body } }));
	w.clear = async (n) => (off ? byScript(n, "clear")
		: w.route("/api/factoring/loads/:loadKey", { params: { loadKey: key(n) }, body: { factored: false, reason: "made-up reason" } }));
	w.resolve = (n, body = {}) => w.route("/api/loads/:loadId/invoice-draft-inflight/resolve", { params: { loadId: id(n) }, body });
	w.putMarker = (n, { factored = 1, locked = "" } = {}) => db.prepare(`INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, locked_at, locked_via, updated_at)
		VALUES (?, ?, ?, 'script', ?, ?, ?, ?) ON CONFLICT(load_key) DO UPDATE SET factored = excluded.factored, locked_at = excluded.locked_at, locked_via = excluded.locked_via`)
		.run(key(n), id(n), factored, NOW, locked, locked ? "outside" : "", NOW);
	w.putClaim = (n, { state, stage = "", invoiceId = "", leaseUntil = "" }) => db.prepare(`INSERT INTO triumph_submissions (load_key, load_id, state, first_seen_at, stage, invoice_id, lease_owner, lease_until, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(key(n), id(n), state, NOW, stage, invoiceId, leaseUntil ? "made-up-worker" : "", leaseUntil, NOW);
	w.inflight = (n) => db.prepare("SELECT state, path, reason, invoice_id, message_id FROM invoice_draft_inflight WHERE load_key = ?").all(key(n));
	w.drafts = (n) => db.prepare("SELECT invoice_id, via FROM load_invoice_drafts WHERE load_id = ?").all(id(n));
	w.actions = (action) => w.seen.audits.filter((a) => a.action === action);
	w.spies = () => [w.seen.prepare, w.seen.mint, w.seen.imap.length, w.seen.n8n.length];
	return w;
}
const CONFIRM = Object.freeze({ confirmFactored: true, factoredReason: "made-up: Triumph asked for a copy" });
const tick = () => new Promise((r) => setImmediate(r));
async function settle(w) { for (let i = 0; i < 50; i++) await tick(); return w; }

// ---------------------------------------------------------------- §1
async function s1() {
	section("§1  a factored load: refused before prepare(); the confirmation");
	{
		const w = world({ n8n: true });
		w.putMarker(1);
		for (const dry of [true, false]) {
			const r = await w.press(1, { dry });
			eq([r.status, r.body && r.body.code], [409, "LOAD_FACTORED"], `§1 FAILS ON THE OLD CODE: a factored load answers 409 LOAD_FACTORED${dry ? " (the preview too)" : ""}`);
		}
		eq(w.spies(), [0, 0, 0, 0], "§1 FAILS ON THE OLD CODE: prepare, nextInvoiceNumber, IMAP and n8n spies all at 0");
		eq(w.drafts(1), [], "§1 no draft row");
	}
	// As the server runs: no assignment lines. A draft would print the carrier's own
	// bank block, so nobody may confirm one, whatever else the press says.
	{
		const w = world({ n8n: true });
		w.putMarker(1);
		const yes = await w.press(1, { body: CONFIRM });
		eq([yes.status, yes.body && yes.body.code], [409, "NOA_UNCONFIGURED"], "§1 FAILS ON THE OLD CODE: a listed account's confirmation with a reason: 409 NOA_UNCONFIGURED, no draft");
		eq(w.spies(), [0, 0, 0, 0], "§1 FAILS ON THE OLD CODE: ...prepare, nextInvoiceNumber, IMAP and n8n spies all at 0");
		ok(store && store.WORDS.NOA_UNCONFIGURED && yes.body && yes.body.error === store.WORDS.NOA_UNCONFIGURED, "§1 FAILS ON THE OLD CODE: ...answered in its own words");
		for (const [label, opts] of [
			["the preview of that confirmation", { body: CONFIRM, dry: true }],
			["an account not listed", { user: UNLISTED, body: CONFIRM }],
			["the shared login", { user: SHARED, body: CONFIRM }],
			["a listed account with no reason", { body: { confirmFactored: true, factoredReason: "  " } }],
			["a body that says the lines exist", { body: { ...CONFIRM, hasAssignmentLines: true } }],
		]) {
			const r = await w.press(1, opts);
			eq([r.status, r.body && r.body.code], [409, "NOA_UNCONFIGURED"], `§1 FAILS ON THE OLD CODE: ${label}: 409 NOA_UNCONFIGURED`);
		}
		eq(w.spies(), [0, 0, 0, 0], "§1 FAILS ON THE OLD CODE: ...and none of them reached prepare()");
		eq([w.drafts(1), w.inflight(1), w.actions("invoice_draft_factored_confirmed"), w.actions("invoice_number_void")], [[], [], [], []],
			"§1 FAILS ON THE OLD CODE: no draft row, no in-flight row, nothing audited as confirmed, no number voided");
		const nobody = world({ ids: null });
		nobody.putMarker(1);
		eq((await nobody.press(1, { body: CONFIRM })).body.code, "NOA_UNCONFIGURED", "§1 FAILS ON THE OLD CODE: TRIUMPH_FACTOR_MARK_IDS unset: the same answer");
		const set = world({ settings: { TRIUMPH_NOA_LINES: "made-up line one" } });
		set.putMarker(1);
		eq((await set.press(1, { body: CONFIRM })).body.code, "NOA_UNCONFIGURED", "§1 FAILS ON THE OLD CODE: a setting named for the lines changes nothing: the invoice page can't print them yet");
		w.putMarker(2, { locked: NOW });
		eq((await w.press(2, { body: CONFIRM })).body.code, "FACTORING_LOCKED", "§1 a locked row answers with the lock first");
		const plain = world();
		const unmarked = await plain.press(3, { body: CONFIRM });
		eq([unmarked.status, unmarked.body && unmarked.body.via, plain.actions("invoice_draft_factored_confirmed")], [200, "imap", []], "§1 a load that isn't factored ignores the confirmation: a plain draft, nothing audited as confirmed");
		const wiring = SRC.slice(SRC.indexOf("// <factoring-wiring>"), SRC.indexOf("// </factoring-wiring>"));
		ok(wiring.includes('require("./lib/factoring-routes").create({') && !wiring.includes("hasAssignmentLines"), "§1 the server's wiring never says the lines exist");
	}
	// Once assignment lines exist, the confirmation's own rules.
	{
		const w = world({ n8n: true, lines: true });
		w.putMarker(1);
		eq((await w.press(1)).body.code, "LOAD_FACTORED", "§1 with the lines, a plain press is still refused");
		const unlisted = await w.press(1, { user: UNLISTED, body: CONFIRM });
		eq([unlisted.status, unlisted.body && unlisted.body.code], [403, "FACTORING_NOT_LISTED"], "§1 with the lines, the confirmation from an account not listed: 403");
		const shared = await w.press(1, { user: SHARED, body: CONFIRM });
		eq([shared.status, shared.body && shared.body.code], [403, "FACTORING_NOT_LISTED"], "§1 with the lines, the shared login never confirms, even with its id listed");
		const noReason = await w.press(1, { body: { confirmFactored: true, factoredReason: "  " } });
		eq([noReason.status, noReason.body && noReason.body.code], [400, "FACTORING_REASON_REQUIRED"], "§1 with the lines, the confirmation needs a reason");
		eq(w.spies(), [0, 0, 0, 0], "§1 ...and none of them reached prepare()");
		const yes = await w.press(1, { body: CONFIRM });
		eq([yes.status, yes.body && yes.body.via, w.drafts(1).length], [200, "imap", 1], "§1 with the lines, a listed account's confirmation with a reason drafts it");
		ok(w.actions("invoice_draft_factored_confirmed").length === 1 && w.actions("invoice_draft_factored_confirmed")[0].details.includes("Triumph asked for a copy"),
			"§1 ...audited once, with the reason");
		const notListedAtAll = world({ ids: null, lines: true });
		notListedAtAll.putMarker(1);
		eq((await notListedAtAll.press(1, { body: CONFIRM })).body.code, "FACTORING_NOT_LISTED", "§1 with the lines, TRIUMPH_FACTOR_MARK_IDS unset: nobody confirms");
	}

}

// ---------------------------------------------------------------- §1b
// As production ships: TRIUMPH_FACTORING_ENABLED and TRIUMPH_FACTOR_MARK_IDS unset.
// The first marks come from the lead's scripts/factoring-mark.js, and the button
// honours them all the same.
async function s1off() {
	section("§1b every switch off: a load the lead's script marked is refused all the same");
	{
		const w = world({ off: true, n8n: true });
		const marked = await w.mark(30);
		eq([marked.status, w.db.prepare("SELECT factored, source FROM load_factoring WHERE load_key = ?").get(key(30))], [200, { factored: 1, source: "script" }],
			"§1b scripts/factoring-mark.js --apply marks the load with every switch off");
		for (const dry of [true, false]) {
			const r = await w.press(30, { dry });
			eq([r.status, r.body && r.body.code], [409, "LOAD_FACTORED"], `§1b FAILS ON THE OLD CODE: every switch off, the marked load answers 409 LOAD_FACTORED${dry ? " (the preview too)" : ""}`);
		}
		eq(w.spies(), [0, 0, 0, 0], "§1b FAILS ON THE OLD CODE: prepare, nextInvoiceNumber, IMAP and n8n spies all at 0");
		eq([w.drafts(30), w.inflight(30)], [[], []], "§1b no draft row and no in-flight row");
		const confirm = await w.press(30, { body: CONFIRM });
		eq([confirm.status, confirm.body && confirm.body.code], [409, "NOA_UNCONFIGURED"], "§1b FAILS ON THE OLD CODE: nobody can confirm it");
		w.duringRender = () => { w.duringRender = null; w.mark(31); };
		const late = await w.press(31);
		eq([late.status, late.body && late.body.code, w.seen.imap.length, w.seen.n8n.length, w.actions("invoice_number_void").length], [409, "LOAD_FACTORED", 0, 0, 1],
			"§1b FAILS ON THE OLD CODE: every switch off, a mark that lands during the render is caught by the late re-check, its number voided");
	}
}

// ---------------------------------------------------------------- §2
async function s2() {
	section("§2  the confirmation against Triumph's claims and the lock, once assignment lines exist");
	{
		const w = world({ lines: true });
		const cases = [
			["working", { state: "working", leaseUntil: "2026-11-03T15:10:00.000Z" }],
			["waiting with a reserved number", { state: "waiting", stage: "reserved", invoiceId: "11032026-50" }],
			["staged", { state: "staged", stage: "built", invoiceId: "11032026-51" }],
			["in Needs attention with a number", { state: "needs_attention", stage: "built", invoiceId: "11032026-52" }],
		];
		let n = 2;
		for (const [label, claim] of cases) {
			w.putMarker(n);
			w.putClaim(n, claim);
			const r = await w.press(n, { body: CONFIRM });
			eq([r.status, r.body && r.body.code], [409, "TRIUMPH_IN_FLIGHT"], `§2 FAILS ON THE OLD CODE: the confirmation while a Triumph claim is ${label}: 409 TRIUMPH_IN_FLIGHT`);
			n++;
		}
		w.putMarker(6, { locked: NOW });
		eq((await w.press(6, { body: CONFIRM })).body.code, "FACTORING_LOCKED", "§2 FAILS ON THE OLD CODE: the confirmation on a load handled in Triumph's process: FACTORING_LOCKED");
		eq((await w.press(6)).body.code, "FACTORING_LOCKED", "§2 ...the plain press too");
		w.putMarker(7, { factored: 0, locked: NOW });
		eq((await w.press(7)).body.code, "FACTORING_LOCKED", "§2 a row locked at 0 is still refused");
		eq(w.spies(), [0, 0, 0, 0], "§2 prepare, mint, IMAP and n8n spies at 0 for all of them");
		const u = world({ unreadableMarker: true });
		const r = await u.press(8);
		eq([r.status, r.body && r.body.code, u.spies()], [503, "FACTORING_UNREADABLE", [0, 0, 0, 0]], "§2 FAILS ON THE OLD CODE: a marker that can't be read refuses (503), nothing spent");
	}

}

// ---------------------------------------------------------------- §3
async function s3() {
	section("§3  the late re-check, after the render and before the hand-off");
	{
		// No assignment lines: a confirmation sent while the load isn't factored yet
		// carries no weight when a mark lands during the render.
		const early = world({ n8n: true });
		early.duringRender = () => { early.duringRender = null; early.putMarker(9); };
		const sneaked = await early.press(9, { body: CONFIRM });
		eq([sneaked.status, sneaked.body && sneaked.body.code, early.seen.imap.length, early.seen.n8n.length, early.actions("invoice_number_void").length], [409, "LOAD_FACTORED", 0, 0, 1],
			"§3 a confirmation on a load not yet factored: marked during the render, refused at the late re-check, its number voided");

		const w = world({ n8n: true, lines: true });
		w.duringRender = (db) => { w.duringRender = null; w.putMarker(9); };
		let r = await w.press(9);
		eq([r.status, r.body && r.body.code], [409, "LOAD_FACTORED"], "§3 FAILS ON THE OLD CODE: marked during the render: 409 LOAD_FACTORED at the late re-check");
		eq([w.seen.mint, w.seen.imap.length, w.seen.n8n.length], [1, 0, 0], "§3 FAILS ON THE OLD CODE: ...the number was minted, and IMAP and n8n spies stay at 0");
		eq(w.actions("invoice_number_void").map((a) => a.details.startsWith("11032026-1 was minted")), [true], "§3 FAILS ON THE OLD CODE: ...one invoice_number_void row for it");
		eq([w.inflight(9), w.drafts(9)], [[], []], "§3 ...no in-flight row and no draft row");

		w.putMarker(10);
		w.duringRender = () => { w.duringRender = null; w.putClaim(10, { state: "waiting", stage: "reserved", invoiceId: "11032026-60" }); };
		r = await w.press(10, { body: CONFIRM });
		eq([r.status, r.body && r.body.code], [409, "TRIUMPH_IN_FLIGHT"], "§3 FAILS ON THE OLD CODE: the confirmation passes early; a Triumph number reserved during the render: TRIUMPH_IN_FLIGHT");
		w.putMarker(11);
		w.duringRender = () => { w.duringRender = null; w.putMarker(11, { locked: NOW }); };
		r = await w.press(11, { body: CONFIRM });
		eq([r.status, r.body && r.body.code], [409, "FACTORING_LOCKED"], "§3 FAILS ON THE OLD CODE: locked during the render (confirmed): FACTORING_LOCKED");
		w.duringRender = () => { w.duringRender = null; w.putMarker(12, { factored: 0, locked: NOW }); };
		r = await w.press(12);
		eq([r.status, r.body && r.body.code], [409, "FACTORING_LOCKED"], "§3 FAILS ON THE OLD CODE: locked during the render (plain press, a row at 0): FACTORING_LOCKED");
		eq([w.seen.imap.length, w.seen.n8n.length, w.actions("invoice_number_void").length], [0, 0, 4], "§3 none reached IMAP or n8n; each voided its number");
	}

}

// ---------------------------------------------------------------- §4
async function s4() {
	section("§4  the in-flight row");
	{
		const w = world();
		w.imap = ["HOLD"];
		const first = w.press(13);
		await settle(w);
		eq(w.inflight(13).map((r) => [r.state, r.path, Boolean(r.message_id)]), [["in_flight", "imap", true]], "§4 FAILS ON THE OLD CODE: while the append runs, the in-flight row is there (imap, with its Message-ID)");
		eq(w.seen.imap[0] && w.seen.imap[0].messageId, w.inflight(13)[0] && w.inflight(13)[0].message_id, "§4 FAILS ON THE OLD CODE: the button passes that Message-ID to the append");
		const before = [w.seen.prepare, w.seen.mint];
		const second = await w.press(13);
		eq([second.status, second.body && second.body.code], [409, "INVOICE_DRAFT_IN_FLIGHT"], "§4 FAILS ON THE OLD CODE: a second press while it is in flight: 409 INVOICE_DRAFT_IN_FLIGHT");
		eq([w.seen.prepare, w.seen.mint], before, "§4 FAILS ON THE OLD CODE: ...before prepare(): no second prepare, no second number");
		eq((await w.mark(13)).body.code, "INVOICE_DRAFT_IN_FLIGHT", "§4 FAILS ON THE OLD CODE: marking it while in flight: INVOICE_DRAFT_IN_FLIGHT");
		w.holds.shift().resolve({ ok: true });
		const done = await first;
		eq([done.status, w.inflight(13), w.drafts(13).map((d) => d.via)], [200, [], ["imap"]], "§4 success: the row is gone and the draft row written");

		// A second press that started before the first one's row existed: refused
		// at its own late re-check, its number voided.
		const w2 = world();
		w2.imap = ["HOLD"];
		let secondPress = null;
		// The second press starts while the first renders: its early check finds no row.
		w2.duringRender = () => { w2.duringRender = null; secondPress = w2.press(14); };
		const a = w2.press(14);
		await settle(w2);
		const b = await secondPress;
		eq([b.status, b.body && b.body.code], [409, "INVOICE_DRAFT_IN_FLIGHT"], "§4 FAILS ON THE OLD CODE: a second press that passed the early check before the first one's row existed: refused at its late re-check");
		eq([w2.seen.mint, w2.seen.imap.length, w2.actions("invoice_number_void").length], [2, 1, 1], "§4 FAILS ON THE OLD CODE: ...one append only, and the second press's own number voided");
		w2.holds.shift().resolve({ ok: true });
		await a;

		// Clearing a factored load's mark while its confirmed draft is in flight (the
		// confirmation needs assignment lines and a listed account, so both are on here
		// in both runs).
		const w3 = world({ off: false, lines: true });
		w3.putMarker(15);
		w3.imap = ["HOLD"];
		const c = w3.press(15, { body: CONFIRM });
		await settle(w3);
		eq((await w3.clear(15)).body.code, "INVOICE_DRAFT_IN_FLIGHT", "§4 FAILS ON THE OLD CODE: clearing a factored load's mark while its draft is in flight: refused");
		w3.holds.shift().resolve({ ok: true });
		await c;

		// The real INSERT fails (a made-up trigger on this runner's own table):
		// record() answers recorded:false, so the draft is in Gmail unrecorded.
		const w4 = world();
		w4.db.exec("CREATE TRIGGER made_up_refuse BEFORE INSERT ON load_invoice_drafts BEGIN SELECT RAISE(ABORT, 'made-up refusal'); END;");
		const r4 = await w4.press(16);
		eq([r4.status, w4.inflight(16).map((r) => [r.state, r.reason])], [200, [["maybe_drafted", "unrecorded"]]],
			"§4 FAILS ON THE OLD CODE: record() failing leaves the row maybe_drafted (reason unrecorded), in the draft row's own transaction");
		eq((await w4.mark(16)).body.code, "INVOICE_MAYBE_DRAFTED", "§4 FAILS ON THE OLD CODE: ...and marking answers 409 INVOICE_MAYBE_DRAFTED");
		const again = await w4.press(16);
		eq([again.status, again.body && again.body.code, again.body && again.body.invoiceId], [409, "INVOICE_MAYBE_DRAFTED", "11032026-1"],
			"§4 FAILS ON THE OLD CODE: a press while it may be in Gmail: 409 INVOICE_MAYBE_DRAFTED, naming the number");
		ok(String(again.body && again.body.error).includes("Use 'Check Gmail' on the load before drafting again"), "§4 ...with the words that say to use Check Gmail");
	}

}

// ---------------------------------------------------------------- §5
async function s5() {
	section("§5  unanswered and definite failures");
	{
		const w = world();
		w.imap = ["LOST"];
		const r = await w.press(17);
		eq([r.status, r.body && r.body.code], [502, "DRAFT_MAYBE_SAVED"], "§5 FAILS ON THE OLD CODE: IMAP with no answer after the message was sent: 502 DRAFT_MAYBE_SAVED");
		eq(r.body && r.body.error, "Invoice #11032026-1 may have been saved as a Gmail draft: Gmail didn't answer. Use 'Check Gmail' on the load before drafting again.",
			"§5 FAILS ON THE OLD CODE: ...in its own words, not \"No draft was created\"");
		eq([w.inflight(17).map((x) => [x.state, x.path]), w.actions("invoice_number_void").length], [[["maybe_drafted", "imap"]], 0], "§5 FAILS ON THE OLD CODE: ...maybe_drafted (imap), nothing voided");
		eq((await w.mark(17)).body.code, "INVOICE_MAYBE_DRAFTED", "§5 FAILS ON THE OLD CODE: marking it answers INVOICE_MAYBE_DRAFTED");
		const before = [w.seen.prepare, w.seen.mint];
		eq((await w.press(17)).body.code, "INVOICE_MAYBE_DRAFTED", "§5 FAILS ON THE OLD CODE: a second press: INVOICE_MAYBE_DRAFTED");
		eq([w.seen.prepare, w.seen.mint], before, "§5 FAILS ON THE OLD CODE: ...before prepare(), no number");

		const d = world();
		d.imap = ["NO"];
		const rd = await d.press(18);
		eq([rd.status, rd.body && rd.body.code], [502, "DRAFT_SAVE_FAILED"], "§5 a definite IMAP refusal and no n8n: today's 502 DRAFT_SAVE_FAILED");
		ok(String(rd.body && rd.body.error).includes("No draft was created — please retry."), "§5 ...with today's words");
		eq([d.inflight(18), d.actions("invoice_number_void").length], [[], 1], "§5 FAILS ON THE OLD CODE: ...the row deleted and one invoice_number_void row");

		for (const [label, behaviour] of [["aborting at its 30 s timer", "ABORT"], ["a network error", "NETWORK"], ["answering 502", "502"]]) {
			const n = world({ gmail: false, n8n: true });
			n.n8n = [behaviour];
			const rn = await n.press(19);
			eq([rn.status, rn.body && rn.body.code], [502, "DRAFT_MAYBE_SAVED"], `§5 FAILS ON THE OLD CODE: n8n ${label}: 502 DRAFT_MAYBE_SAVED`);
			ok(String(rn.body && rn.body.error).includes("may have been saved as a Gmail draft"), `§5 FAILS ON THE OLD CODE: n8n ${label}: the answer says it may be in Gmail`);
			eq([n.inflight(19).map((x) => [x.state, x.path]), n.actions("invoice_number_void").length], [[["maybe_drafted", "n8n"]], 0],
				`§5 FAILS ON THE OLD CODE: n8n ${label}: maybe_drafted (n8n), nothing voided`);
			eq((await n.mark(19)).body.code, "INVOICE_MAYBE_DRAFTED", `§5 FAILS ON THE OLD CODE: n8n ${label}: marking answers INVOICE_MAYBE_DRAFTED`);
		}

		// IMAP fails with no answer, then the n8n re-check refuses (the load marked
		// during the IMAP wait): the row stays maybe drafted and nothing is voided.
		const m = world({ n8n: true });
		m.imap = ["LOST"];
		m.duringImap = () => { m.duringImap = null; m.putMarker(20); };
		const rm = await m.press(20);
		eq([rm.status, rm.body && rm.body.code, m.seen.n8n.length], [502, "DRAFT_MAYBE_SAVED", 0], "§5 FAILS ON THE OLD CODE: the n8n re-check refuses after an unanswered IMAP: no POST, may-be-in-Gmail words");
		eq([m.inflight(20).map((x) => x.state), m.actions("invoice_number_void").length], [["maybe_drafted"], 0], "§5 FAILS ON THE OLD CODE: ...the row stays maybe_drafted and no number is voided");

		// A definite IMAP refusal, then the n8n re-check refuses: nothing can be in
		// Gmail, so the row goes and the number is voided.
		const m2 = world({ n8n: true });
		m2.imap = ["NO"];
		m2.duringImap = () => { m2.duringImap = null; m2.putMarker(21); };
		const rm2 = await m2.press(21);
		eq([rm2.status, rm2.body && rm2.body.code, m2.seen.n8n.length, m2.inflight(21), m2.actions("invoice_number_void").length], [409, "LOAD_FACTORED", 0, [], 1],
			"§5 FAILS ON THE OLD CODE: a definite IMAP refusal then the n8n re-check: 409, no POST, row deleted, number voided");
		const ok8 = world({ n8n: true });
		ok8.imap = ["NO"];
		const r8 = await ok8.press(22);
		eq([r8.status, r8.body && r8.body.via, ok8.inflight(22), ok8.drafts(22).map((x) => x.via)], [200, "n8n", [], ["n8n"]], "§5 IMAP refused then n8n drafts it: the row settles with the draft row");
	}

}

// ---------------------------------------------------------------- §6
async function s6() {
	section("§6  Check Gmail");
	{
		for (const [label, search, expect] of [["found", "found", { found: true, drafts: ["imap"] }], ["absent", "absent", { found: false, drafts: [] }]]) {
			const w = world();
			w.imap = ["LOST"];
			await w.press(23);
			w.search = search;
			const r = await w.resolve(23);
			eq([r.status, r.body && r.body.found, w.drafts(23).map((x) => x.via), w.inflight(23)], [200, expect.found, expect.drafts, []],
				`§6 FAILS ON THE OLD CODE: path imap, the search says ${label}: ${expect.found ? "the draft row written via imap" : "the row deleted"}`);
			eq(w.seen.search, [w.seen.imap[0].messageId], `§6 ...searched by the draft's own Message-ID (${label})`);
			eq(w.actions("invoice_number_void").length, expect.found ? 0 : 1, `§6 ...${expect.found ? "nothing voided" : "its number voided"}`);
			eq(w.actions("invoice_draft_inflight_resolved").length, 1, `§6 ...one invoice_draft_inflight_resolved row (${label})`);
		}
		const u = world();
		u.imap = ["LOST"];
		await u.press(24);
		u.search = "fail";
		const ru = await u.resolve(24);
		eq([ru.status, ru.body && ru.body.code, u.inflight(24).length], [503, "GMAIL_UNKNOWN", 1], "§6 FAILS ON THE OLD CODE: the search fails (unknown): 503, the row left as it is");
		for (const [label, answer, drafts] of [["It is in Gmail", "in_gmail", ["n8n"]], ["It is not in Gmail", "not_in_gmail", []]]) {
			const n = world({ gmail: false, n8n: true });
			n.n8n = ["502"];
			await n.press(25);
			eq((await n.resolve(25, { answer })).body.code, "ANSWER_REQUIRED", `§6 FAILS ON THE OLD CODE: path n8n needs a person's answer with a reason (${label})`);
			const r = await n.resolve(25, { answer, reason: "made-up: looked in Drafts and Sent Mail" });
			eq([r.status, n.drafts(25).map((x) => x.via), n.inflight(25)], [200, drafts, []], `§6 FAILS ON THE OLD CODE: path n8n, "${label}": ${drafts.length ? "the draft row via n8n" : "the row deleted"}`);
			eq(n.actions("invoice_number_void").length, drafts.length ? 0 : 1, `§6 ...${drafts.length ? "nothing voided" : "its number voided"}`);
		}
		const f = world();
		f.imap = ["HOLD"];
		const p = f.press(26);
		await settle(f);
		eq((await f.resolve(26)).body.code, "INVOICE_DRAFT_IN_FLIGHT", "§6 a draft still in flight can't be resolved yet");
		f.holds.shift().resolve({ ok: true });
		await p;
	}

}

// ---------------------------------------------------------------- §7
async function s7() {
	section("§7  nothing marked: today's answers");
	{
		const w = world();
		const r = await w.press(27);
		eq([r.status, Object.keys(r.body || {})], [200, ["success", "invoiceId", "via", "draftMailbox", "warnings"]], "§7 a draft answers exactly today's keys");
		eq([r.body.via, r.body.draftMailbox, r.body.warnings], ["imap", "[Gmail]/Drafts", []], "§7 ...with today's values");
		ok(/^<made-up-\d+\.auto-invoice@example\.test>$/.test(String(w.seen.imap[0] && w.seen.imap[0].messageId)), "§7 FAILS ON THE OLD CODE: the draft carries a Message-ID the app made");
		eq([w.inflight(27), w.drafts(27).length, w.actions("invoice_number_void").length], [[], 1, 0], "§7 no in-flight row left behind, one draft row, nothing voided");
		const dry = await w.press(28, { dry: true });
		eq([dry.status, dry.body && dry.body.dryRun, w.inflight(28)], [200, true, []], "§7 the preview (?dryRun=1) writes no row");
		const none = world({ gmail: false, n8n: false });
		const rn = await none.press(29);
		eq([rn.status, rn.body && rn.body.preview, none.inflight(29)], [200, true, []], "§7 nothing to hand off to: today's preview-only answer, and no row");
	}
}

// ---------------------------------------------------------------- §8
// Each rule removed in turn (a copy of the module, or of the route's text): the
// section that pins it must fail.
function moduleFrom(file, src) {
	const mod = { exports: {} };
	new Function("module", "exports", "require", src)(mod, mod.exports, require("module").createRequire(file));
	return mod.exports;
}
async function mutants() {
	section("§8  mutants: each rule removed, and a case catches it");
	const fs = require("fs");
	const ROUTES_FILE = path.join(ROOT, "lib", "factoring-routes.js");
	const ROUTES_SRC = fs.readFileSync(ROUTES_FILE, "utf8");
	const list = [
		["no check before prepare()", "route", "if (!factoringCheck.ok) return res.status(factoringCheck.http).json(factoringCheck.json);", "", s1],
		["no late re-check or in-flight row (no hand-off step)", "route", "const handoff = (gmailUser && gmailPass) || (webhookUrl && webhookSecret)", "const handoff = false", s3],
		["no in-flight row", "route", "const handoff = (gmailUser && gmailPass) || (webhookUrl && webhookSecret)", "const handoff = false", s4],
		["no Message-ID on the button's draft", "route", "messageId: handoff.messageId,", "", s7],
		["record() not told to settle the row", "route", "settleInflight: handoff ? handoff.settle : null,", "settleInflight: null,", s4],
		["an outer delete after record() answers, whatever it answered", "routes", "if (!(result && result.recorded)) {\n\t\t\t\t\tstore.draftMaybe(db, { key, invoiceId, reason: \"unrecorded\", nowIso: nowIso() });\n\t\t\t\t\tmaybe = true;\n\t\t\t\t}",
			"store.draftDrop(db, { key, invoiceId });", s4],
		["an unanswered IMAP read as a definite failure", "routes", "if (e && e.stage === \"literal\" && !e.answered) {", "if (false) {", s5],
		["an n8n failure deletes the row and voids the number", "routes", "store.draftMaybe(db, { key, invoiceId, path: \"n8n\", nowIso: nowIso() });\n\t\t\t\tmaybe = true;",
			"store.draftDrop(db, { key, invoiceId });\n\t\t\t\tvoidNumber(\"N8N_FAILED\");", s5],
		["a refusal before n8n voids and deletes after an unanswered IMAP", "routes", "if (r.keep) return", "if (false) return", s5],
		["settling on 'no throw' (record() answering recorded:false ignored)", "routes", "if (!(result && result.recorded)) {", "if (false) {", s4],
		["the confirmation with no assignment lines", "routes", "hasAssignmentLines: d.hasAssignmentLines === true,", "hasAssignmentLines: true,", s1],
		["a body that says the lines exist is believed", "routes", "hasAssignmentLines: d.hasAssignmentLines === true,", "hasAssignmentLines: body.hasAssignmentLines === true,", s1],
		["a setting says the lines exist", "routes", "hasAssignmentLines: d.hasAssignmentLines === true,", "hasAssignmentLines: Boolean(d.env && d.env.TRIUMPH_NOA_LINES),", s1],
		["the confirmation from any Super Admin", "routes", "mayConfirm: mayMark(userOf(req)),", "mayConfirm: true,", s1],
		["the shared login counts as listed", "routes", "&& !isSharedLoginName(user.username)", "", s1],
		["Check Gmail without the search", "routes", "const canSearch = row.path === \"imap\"", "const canSearch = false && row.path === \"imap\"", s6],
		// The review's two: the button's checks, or its in-flight row and late
		// re-check, made to follow the marking switch. Caught with every switch off.
		["the button's checks run only while marking is on", "routes", [
			["function draftEarly(req, loadId) {\n", "function draftEarly(req, loadId) {\n\t\tif (!markingOn) return { ok: true, factored: false, confirmed: false, reason: \"\" };\n"],
			["const begun = store.draftBegin(db, {", "const begun = !markingOn ? { ok: true } : store.draftBegin(db, {"],
		], null, s1off, "off"],
		["the in-flight row and the late re-check skipped while marking is off", "routes",
			"const begun = store.draftBegin(db, {", "const begun = !markingOn ? { ok: true } : store.draftBegin(db, {", s4, "off"],
		["the same, caught by the late mark with every switch off", "routes",
			"const begun = store.draftBegin(db, {", "const begun = !markingOn ? { ok: true } : store.draftBegin(db, {", s1off, "off"],
	];
	let caught = 0;
	for (const [label, where, from, to, sec, mode = "on"] of list) {
		const text = where === "route" ? LIFT.route : ROUTES_SRC;
		// One edit, or several ([from, to] pairs), each anchored exactly once.
		const edits = Array.isArray(from) ? from : [[from, to]];
		if (edits.some(([f]) => text.split(f).length - 1 !== 1)) { failures.push(`§8 mutant anchor not found once: ${label}`); continue; }
		const mutated = edits.reduce((t, [f, r]) => t.replace(f, r), text);
		const saved = { ...CUR };
		if (where === "route") CUR.route = mutated;
		else CUR.routesLib = moduleFrom(ROUTES_FILE, mutated);
		const before = sink;
		sink = [];
		const quietSection = sectionLog;
		sectionLog = () => {};
		const savedMode = MODE;
		MODE = mode;
		try {
			await sec();
		} catch (e) {
			sink.push(`threw: ${e && e.message}`);
		}
		MODE = savedMode;
		const hit = sink.length > 0;
		sink = before;
		sectionLog = quietSection;
		Object.assign(CUR, saved);
		if (hit) { caught++; pass++; console.log(`  MUTANT ${label}${mode === "off" ? " [every switch off]" : ""}: caught`); }
		else failures.push(`§8 MUTANT ${label}: NOT caught`);
	}
	console.log(`  ${caught}/${list.length} mutants caught`);
}

async function main() {
	// lib/broker-invoice.js reads the default recipient from this process's own
	// settings: a made-up one, for this run only.
	process.env.DEFAULT_INVOICE_EMAIL = TO;
	delete process.env.BISON_INVOICE_EMAIL;
	for (const s of [s1, s2, s3, s4, s5, s6, s7]) await s();
	// Again as production ships: both factoring settings unset (plan §11.5).
	MODE = "off";
	for (const s of [s1off, s4, s5, s6, s7]) await s();
	MODE = "on";
	if (routesLib) await mutants();
	else failures.push("§8 lib/factoring-routes.js is missing: no mutant can run");
}

main()
	.catch((e) => failures.push(`the run threw: ${e && e.stack}`))
	.then(() => {
		console.log(`\n${pass} passed, ${failures.length} failed`);
		for (const f of failures) console.log(`FAIL  ${f}`);
		process.exit(failures.length ? 1 : 0);
	});
