#!/usr/bin/env node
/**
 * scripts/test-invoice-lines-isolation.js — B20 Phase 1: advance lines are
 * INVOICE-ONLY.
 *
 * Written before the B20 build (it failed on every case there). SERVER_JS=<file>
 * runs it against another copy of server.js (scripts/lib/work-days-world.js
 * reads the same variable).
 *
 * The owner's rule (product-decisions.md, "B20 broker invoice lines"): a Super
 * Admin adds advance lines on the broker invoice; Job Tracking, revenue, driver
 * pay, investor payouts and the P&L keep reading the original figures, and no
 * closed month changes.
 *
 *   §1 a line on a load in a closed (frozen, locked) month and one in an open
 *      month, written through the module and printed on a draft: the payout
 *      ledger, the investor view, every Financials view and every settlement
 *      table are byte-identical before and after; the weekly driver invoice is
 *      the same as in a twin world with no lines; the automatic invoice of a load
 *      with a line (AUTO_INVOICE_ADVANCE_LINES_ENABLED, PR A1), drafted end to end by
 *      the engine on the same world, moves no figure, table or Payment either
 *   §2 the same through the lifted POST …/invoice-lines route, as the server
 *      runs it: one audit row, nothing else moves
 *   §3 where server.js may name the lines at all: the draft routes, the
 *      preview, the three invoice-lines routes, their gate and the boot line
 *
 * Every fixture is made up. Pure: no server, no network.
 * Run: node scripts/test-invoice-lines-isolation.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

function findRoot(start) {
	let dir = start;
	for (;;) {
		if (fs.existsSync(path.join(dir, "server.js")) && fs.existsSync(path.join(dir, "package.json"))) return dir;
		const up = path.dirname(dir);
		if (up === dir) throw new Error(`no repo root above ${start}`);
		dir = up;
	}
}
const ROOT = findRoot(__dirname);
const M = require(path.join(ROOT, "scripts", "lib", "money-plans-world.js"));
const { closure } = require(path.join(ROOT, "scripts", "lib", "server-lift.js"));
const { createRequire } = require("module");
const { loadRow } = M;
const SRC = M.SRC;

const ON = { BROKER_INVOICE_LINES_ENABLED: "true" };
const AMY = "Amy Birch";
const NOW = Date.parse("2026-10-16T16:00:00Z");
const SEP_LOCKED_AT = "2026-10-15T04:00:00.000Z";
const ROWS = [
	loadRow({ id: "B201", driver: AMY, pickup: "2026-09-21 8:00", dropoff: "2026-09-23 18:00", assigned: "2026-09-21", done: "2026-09-23", truck: "T1", payment: "$2,400.00" }),
	loadRow({ id: "B202", driver: AMY, pickup: "2026-10-12 8:00", dropoff: "2026-10-13 18:00", assigned: "2026-10-12", done: "2026-10-13", truck: "T1", payment: "$3,000.00" }),
];
const linesLib = () => M.requireLib("broker-invoice-lines");

async function world({ lines }) {
	const w = M.startWorld({ env: ON, drivers: [{ name: AMY, payDaily: 300 }], rows: ROWS, now: NOW });
	// The boot, with the flag on.
	if (lines) linesLib().ensureSchema(w.db);
	await M.freezeAndLock(w, "2026-09", SEP_LOCKED_AT);
	return w;
}
// Every money figure a line could reach: the payout ledger, the investor view
// and the Financials page (all months, closed September, open October).
async function figures(w) {
	const led = await M.ledger(w);
	const inv = await M.investorDays(w);
	const fin = await M.route(w, "GET /api/financials", {});
	const sep = await M.route(w, "GET /api/financials", { query: { month: "2026-09" } });
	const oct = await M.route(w, "GET /api/financials", { query: { month: "2026-10" } });
	return JSON.stringify({ ledgerMonths: led.monthlyEarnings, ledgerItems: led.items, investor: inv.body, fin: fin.body, sep: sep.body, oct: oct.body });
}
// Every table but the ones a line is allowed to write.
const ALLOWED = new Set(["broker_invoice_lines", "load_invoice_drafts", "audit_trail", "sqlite_sequence"]);
const settlementTables = (db) => Object.fromEntries(Object.entries(M.tableHashes(db)).filter(([t]) => !ALLOWED.has(t)));
const ADVANCE = { kind: "advance", label: "Fuel advance", amountCents: 65000, receivedOn: "2026-09-21", reference: "EFS-55501", note: "" };

// The engine (lib/broker-invoice-draft.js) in mode "auto" on a world's database and sheet, with the
// server's own helpers lifted, a made-up rate con and stubs for Drive, Gemini and Chromium.
const zlib = require("zlib");
const pdfWith = (stream) => {
	const z = zlib.deflateSync(Buffer.from(stream, "latin1"));
	return Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj<</Length ${z.length}/Filter/FlateDecode>>stream\n`, "latin1"), z, Buffer.from("\nendstream endobj\n%%EOF", "latin1")]);
};
const RATE_CON = pdfWith("BT (Billing Information: Order #: 1001001 PO #: PO-77 Move #: 5501) Tj (Total Rate: $3,000.00) Tj (Email the signed POD and all billing documents to billing@example-broker.test) Tj ET");
const QUIET = { log() {}, info() {}, warn() {}, error() {} };
let HELPERS = null;
function autoEngine(w) {
	const brokerInvoice = M.requireLib("broker-invoice");
	HELPERS = HELPERS || closure(SRC, {
		roots: ["parseSheet", "deduplicateLoads", "findCol", "parseInvoiceOverrides", "latestDraftNotes", "safeAttachmentName", "sanitizeEvidenceText", "logAudit"],
		provided: ["db", "brokerInvoice", "console"],
		denied: ["app", "server", "io", "getSheets", "getDrive"],
	});
	const helpers = new Function("db", "brokerInvoice", "console", `${HELPERS.text}\nreturn { ${HELPERS.names.join(", ")} };`)(w.db, brokerInvoice, QUIET);
	return M.requireLib("broker-invoice-draft").create({
		...helpers,
		db: w.db,
		brokerInvoice,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: M.sheetValues(w.rows) } }) } } }),
		SPREADSHEET_ID: "made-up-sheet",
		fetchDocumentBytes: async (d) => Buffer.from(`%PDF-1.4 ${d.file_name}`),
		buildRateConLoadCtx: () => ({}),
		getRateConBytes: async () => ({ buffer: RATE_CON, candidates: [{ buffer: RATE_CON, source: "documents", label: "documents", fileName: "rc.pdf" }] }),
		GEMINI_API_KEY: "made-up-key",
		runRateConGemini: async () => ({ "Total Rate": null, Rate: null, "Order Number": null, "PO Number": null, "Documents Email": null }),
		renderHtmlToPdf: async () => Buffer.from("%PDF-1.4 invoice"),
		denyHits: M.requireLib("chr-events").createRedactor({ denyList: "99887766" }).hits,
		env: { ...ON, AUTO_INVOICE_ADVANCE_LINES_ENABLED: "true" },
		console: QUIET,
	});
}

const R = M.createRunner("B20: advance lines on a broker invoice are invoice-only (BROKER_INVOICE_LINES_ENABLED)");

(async () => {
	// ══════════════════════════════════════════════════════════════════════════
	await R.test("§1 a line in a closed month and one in an open month, recorded and printed: every figure and settlement table unchanged", async ({ eq }) => {
		const w = await world({ lines: true });
		const before = await figures(w);
		const tables = settlementTables(w.db);
		const L = linesLib();
		for (const loadId of ["B201", "B202"]) {
			const r = L.addLine(w.db, { loadId, values: ADVANCE, actor: "super_admin", closedMonths: loadId === "B201" ? ["2026-09"] : [] }, { audit: () => {} });
			eq(`${loadId}: accepted`, r.ok, true);
			const sel = L.parseLineSelection({});
			const res = L.resolveInvoiceLines(w.db, { loadId, selection: sel, derivedLineHaul: loadId === "B201" ? 2400 : 3000, lineHaulSource: "sheet", typedTotal: null });
			const draftId = w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, total) VALUES (?, ?, ?)").run(loadId, `INV-${loadId}`, L.formatCents(res.summary.balanceCents)).lastInsertRowid;
			L.recordDraftLines(w.db, { draftId, summary: res.summary, invoiceId: `INV-${loadId}` });
		}
		eq("the payout ledger, the investor view and Financials are byte-identical", await figures(w), before);
		eq("every settlement table is as it was (frozen ledger, payouts, locks, receipts, invoices, Job Tracking caches)", settlementTables(w.db), tables);
		eq("September is still locked", w.db.prepare("SELECT status FROM period_locks WHERE period = '2026-09'").get().status, "locked");
	});

	await R.test("§1 the weekly driver invoice for the open week is the same as in a twin world with no lines", async ({ eq }) => {
		const withLines = await world({ lines: true });
		linesLib().addLine(withLines.db, { loadId: "B202", values: ADVANCE, actor: "super_admin", closedMonths: [] }, { audit: () => {} });
		const without = await world({ lines: false });
		const a = await M.generate(withLines, AMY, "2026-10-16");
		const b = await M.generate(without, AMY, "2026-10-16");
		eq("status", a.status, b.status);
		eq("the invoice's render data (days, loads, totals)", JSON.stringify(a.data), JSON.stringify(b.data));
		eq("its total", a.invoice && a.invoice.total_earnings, b.invoice && b.invoice.total_earnings);
	});

	await R.test("§1 PR A1: the automatic invoice of a load with an advance line, drafted end to end on the same world: every figure, settlement table and Payment unchanged", async ({ eq }) => {
		const w = await world({ lines: true });
		// The made-up broker on the open month's load, its POD and its line, before anything is measured.
		const at = w.rows.findIndex((r) => r["Load ID"] === "B202");
		w.rows[at] = { ...w.rows[at], Email: "ops@example-broker.test" };
		w.db.prepare("INSERT INTO documents (load_id, driver, type, file_name, uploaded_at) VALUES ('B202', ?, 'POD', 'B202_POD.pdf', '2026-10-13T20:00:00Z')").run(AMY);
		linesLib().addLine(w.db, { loadId: "B202", values: { ...ADVANCE, receivedOn: "2026-10-12", reference: "" }, actor: "super_admin", closedMonths: [] }, { audit: () => {} });
		const before = await figures(w);
		const tables = settlementTables(w.db);
		const sheet = JSON.stringify(M.sheetValues(w.rows));
		const engine = autoEngine(w);
		const prep = await engine.prepare({ loadId: "B202", mode: "auto" });
		eq("FAILS ON THE OLD CODE: prepared, the balance due billed: $3,000.00 less the $650.00 advance", prep.ok ? [prep.ctx.total, prep.ctx.billedTotal] : prep.code, ["$3,000.00", "$2,350.00"]);
		if (prep.ok) {
			const rendered = await engine.render(prep.ctx, { invoiceId: "10162026-9", invoiceDate: "10/16/2026" });
			engine.record(prep.ctx, rendered, { via: "auto-smtp", actor: { id: 0, username: "auto-invoice", role: "system" }, invoiceId: "10162026-9", mintedInvoiceId: "10162026-9", editDiffs: [] });
		}
		eq("FAILS ON THE OLD CODE: the job's draft row bills the balance and keeps the line haul", w.db.prepare("SELECT total, gross_total FROM load_invoice_drafts WHERE via = 'auto-smtp'").get() || null,
			{ total: "$2,350.00", gross_total: "$3,000.00" });
		eq("the payout ledger, the investor view and Financials are byte-identical", await figures(w), before);
		eq("every settlement table is as it was", settlementTables(w.db), tables);
		eq("Job Tracking, its Payment included, is as it was", JSON.stringify(M.sheetValues(w.rows)), sheet);
	});

	// ══════════════════════════════════════════════════════════════════════════
	await R.test("§2 POST …/invoice-lines, lifted and run on the same world: 201, one audit row naming the closed month, nothing else moves", async ({ eq, ok }) => {
		const w = await world({ lines: true });
		const head = SRC.split("\n").filter((l) => l.startsWith('app.post("/api/loads/:loadId/invoice-lines",'));
		if (head.length !== 1) throw new Error(`expected one registration of POST /api/loads/:loadId/invoice-lines in server.js, found ${head.length} (the server.js half of B20 adds it)`);
		const routes = {};
		const lifted = closure(SRC, {
			routes: head,
			provided: ["db", "require", "console", "process", "app", "requireRole", "getJobTrackingCached", "Date"],
			denied: ["server", "transporter", "getDrive", "KEY_FILE", "getSheets"],
		});
		const deps = {
			db: w.db,
			require: createRequire(path.join(ROOT, "server.js")),
			console: { log() {}, info() {}, warn() {}, error() {} },
			process: { env: { ...ON } },
			app: { post: (p, ...h) => { routes[p] = h; } },
			requireRole: () => (req, res, next) => next(),
			getJobTrackingCached: async () => {
				const values = M.sheetValues(w.rows);
				const headers = values[0];
				return { headers, data: values.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]]))) };
			},
			Date,
		};
		new Function(...Object.keys(deps), `"use strict";\n${lifted.text}`)(...Object.values(deps));
		const chain = routes["/api/loads/:loadId/invoice-lines"];
		ok("registered", Array.isArray(chain));
		const before = await figures(w);
		const tables = settlementTables(w.db);
		const auditsBefore = w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n;
		let out = null;
		const req = { params: { loadId: "B201" }, query: {}, body: { amount: "650", receivedOn: "2026-09-21", reference: "EFS-55501" },
			session: { user: { id: 1, role: "Super Admin", username: "super_admin" } }, headers: { "x-requested-with": "XMLHttpRequest" } };
		const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { out = { status: this.statusCode, body: b }; return this; } };
		for (const mw of chain.slice(0, -1)) { let go = false; await mw(req, res, () => { go = true; }); if (!go) throw new Error("a middleware stopped the request"); }
		await chain[chain.length - 1](req, res);
		eq("201", out && out.status, 201);
		const audits = w.db.prepare("SELECT action, entity, entity_id, details FROM audit_trail ORDER BY id").all().slice(auditsBefore);
		eq("one audit row, the real logAudit, naming the closed month", audits.map((a) => [a.action, a.entity, a.entity_id, a.details]),
			[["invoice_line_added", "load", "B201", "#1 advance $650.00 \"Fuel advance\" received 2026-09-21 ref EFS-55501 — load in closed month 2026-09, invoice-only, no settlement change"]]);
		eq("figures unchanged", await figures(w), before);
		eq("settlement tables unchanged", settlementTables(w.db), tables);
	});

	// ══════════════════════════════════════════════════════════════════════════
	await R.test("§3 server.js names the lines only in the invoice routes, their gate and the boot line", async ({ eq, ok }) => {
		const lines = SRC.split("\n");
		const regionOf = (needle, what) => {
			const s0 = lines.findIndex((l) => l.includes(needle));
			if (s0 < 0) throw new Error(`no ${what} in server.js (the server.js half of B20 adds it)`);
			let s = s0;
			while (s > 0 && !/^(app\.(post|get)\(|function )/.test(lines[s])) s--;
			let e = s;
			while (e < lines.length && lines[e] !== ");" && lines[e] !== "});" && lines[e] !== "}") e++;
			return [s, e];
		};
		const regions = [
			regionOf('["/api/loads/:loadId/draft-invoice", "/api/loads/:loadId/draft-bison-invoice"],', "draft-invoice route"),
			regionOf('"/api/loads/:loadId/invoice-preview",', "invoice-preview route"),
			regionOf('app.get("/api/loads/:loadId/invoice-lines",', "GET invoice-lines"),
			regionOf('app.post("/api/loads/:loadId/invoice-lines",', "POST invoice-lines"),
			regionOf('app.post("/api/loads/:loadId/invoice-lines/:id/void",', "POST void"),
			regionOf("function brokerInvoiceLinesGate(", "the flag gate"),
		];
		const BOOT = "if (brokerInvoice.invoiceLines.linesEnabled(process.env)) brokerInvoice.invoiceLines.ensureSchema(db);";
		// This module's names: the table, its columns, the flag, the gate, and
		// `invoiceLines` as brokerInvoice's property or the routes' local for it,
		// never another object's method of that name (R3's
		// personalExpense.invoiceLines() is the weekly driver invoice's own).
		const NAMES = /broker_invoice_lines|brokerInvoice\.invoiceLines|(?<![\w.])invoiceLines\b|brokerInvoiceLinesGate|lines_json|gross_total|BROKER_INVOICE_LINES_ENABLED/;
		ok("(control) the pattern skips another object's invoiceLines()", !NAMES.test("const { lines } = personalExpense.invoiceLines(rows);"));
		ok("(control) …and catches this module's", NAMES.test("const invoiceLines = brokerInvoice.invoiceLines;") && NAMES.test("invoiceLines.resolveInvoiceLines(db, {"));
		// The ROUTE_CONTEXT block only lists the names route modules receive.
		const rc = require("./lib/server-source").routeContextLines(SRC);
		const stray = lines.map((l, i) => [i, l]).filter(([i, l]) => NAMES.test(l))
			.filter(([i, l]) => !/^\s*\/\//.test(l) && l !== BOOT && !regions.some(([s, e]) => i >= s && i <= e) && !(rc && i + 1 >= rc.first && i + 1 <= rc.last))
			.map(([i, l]) => `${i + 1}: ${l.trim().slice(0, 100)}`);
		eq("no reference outside them", stray, []);
		eq("the boot line, once", lines.filter((l) => l === BOOT).length, 1);
		// The settlement paths by name: none of them may reach the module.
		for (const fn of ["computeInvestorMonthlyEarnings", "buildFinancialsLedger", "generateInvoiceHandler", "writeLedgerFreeze", "integrityClosedMonthsOf"]) {
			const at = SRC.indexOf(`\nfunction ${fn}(`) >= 0 ? SRC.indexOf(`\nfunction ${fn}(`) : SRC.indexOf(`\nasync function ${fn}(`);
			ok(`${fn} is in server.js`, at >= 0);
			const end = SRC.indexOf("\n}\n", at);
			ok(`${fn} never names the lines`, !NAMES.test(SRC.slice(at, end)));
		}
		ok("no SQL in server.js sums a draft's billed figure", !/SUM\([^)]*\b(total|gross_total)\b[^)]*\)[^;]*load_invoice_drafts/.test(SRC));
	});

	R.finish();
})();
