#!/usr/bin/env node
/**
 * The admin Invoices screen shows the money the server computes; the browser
 * only displays it. Before this, the screen worked its own figures out: the
 * detail's "Total due", the row tooltip's "New total" and the adjust form's
 * preview each added total_earnings and the adjustment in the browser, the
 * New Manual Invoice dialog summed its rows, and the Submitted, Approved,
 * Processing and Paid cards added total_earnings alone, so a card holding an
 * adjusted invoice disagreed with that invoice's PDF ("Total Due").
 *
 * WHAT IS ASSERTED — the shipping code, lifted out of server.js (it cannot be
 * required: it opens SQLite, reads a key and listens on import) and run against
 * an in-memory SQLite, and the shipping client files, read as text and, where a
 * figure is formatted, run over stand-ins:
 *   §1 THE LIST (GET /api/invoices). Every row carries total_due, equal to
 *      invoiceTotalDue() of the stored invoice (a negative, a positive and no
 *      adjustment; a negative total; a sum rounded to the cent), for the Super
 *      Admin, the "show deleted" view and a Driver's own list; total_earnings and
 *      the adjustment are still served unchanged.
 *   §2 THE CARDS (the response's `summary`). Per status, the count and the total
 *      due of the listed invoices that are not deleted: the set the cards always
 *      covered (every live invoice; the screen's card, payee and week filters
 *      never narrowed them), now with each adjustment included. A deleted row is
 *      listed in the "show deleted" view and never counted. Each status's figure
 *      is the sum of its rows' total_due and agrees with the payment report.
 *   §3 THE MANUAL INVOICE'S TOTALS (POST /api/invoices/manual/totals). The New
 *      Manual Invoice dialog's totals strip, from the server: the subtotal,
 *      deductions and total due the create stores for the same rows (one
 *      definition, manualInvoiceTotals(), used by both), each row rounded as the
 *      create rounds it. Rows the create would refuse answer complete: false.
 *      It writes nothing. The create, adjust, revert and restore answers carry
 *      the invoice's total_due.
 *   §4 THE SCREEN DISPLAYS THE SERVER'S FIGURES. The store keeps the summary and
 *      adds no money; the cards show the summary's counts and totals (a dash
 *      before it arrives); the row, the detail and the tooltip show total_due
 *      (run on a row whose total_due is not total_earnings + adjustment); the
 *      adjust form shows the current total due and the typed adjustment with no
 *      sum; the manual dialog shows the server's totals; no file of the screen
 *      adds money.
 *   §5 MUTANTS — the list dropping the adjustment, the cards counting deleted
 *      rows or summing total_earnings, the manual totals ignoring deductions, the
 *      tooltip adding in the browser and the store dropping the summary must each
 *      flip at least one assertion above.
 *
 * Pure: no server, no app.db, no network, no Sheets.
 * Run: node scripts/test-invoices-screen-totals.js     # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const appTime = require("../lib/app-time");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const CLIENT_FILES = {
	view: "client/src/views/InvoicesView.vue",
	store: "client/src/stores/invoices.js",
	manual: "client/src/components/invoices/ManualInvoiceDialog.vue",
	report: "client/src/components/invoices/PaymentReportDialog.vue",
};
const CLIENT = Object.fromEntries(Object.entries(CLIENT_FILES).map(([k, rel]) => [k, fs.readFileSync(path.join(ROOT, rel), "utf8")]));

// ───────────────────────────────────────────────────────────────── lifting
// Anchored on a newline and counted, so a mention in a comment is never taken
// for the definition and a second copy fails the run. A top-level function ends
// at the first column-0 "}" line, a route at the first column-0 "});". An
// optional lift answers null when the piece is absent (the tree before the fix).
function liftBetween(src, needle, terminator, label, optional) {
	const hits = src.split(needle).length - 1;
	if (hits === 0 && optional) return null;
	if (hits !== 1) throw new Error(`expected exactly 1 ${label}, found ${hits}`);
	const a = src.indexOf(needle) + 1;
	const end = src.indexOf(terminator, a);
	if (end < 0) throw new Error(`no end after ${label}`);
	return src.slice(a, end + terminator.length);
}
const liftFn = (src, name, optional) => liftBetween(src, `\nfunction ${name}(`, "\n}\n", `function ${name}()`, optional);
const liftRoute = (src, head, optional) => liftBetween(src, `\n${head}`, "\n});\n", head, optional);

const LIST_ROUTE = 'app.get("/api/invoices", requireAuth, (req, res) => {';
const MANUAL_ROUTE = 'app.post("/api/invoices/manual", requireRole("Super Admin"), async (req, res) => {';
const TOTALS_ROUTE = 'app.post("/api/invoices/manual/totals", requireRole("Super Admin"), (req, res) => {';
const ADJUST_ROUTE = 'app.put("/api/invoices/:id/adjust", requireRole("Super Admin"), refuseCrossOrigin, async (req, res) => {';
const REVERT_ROUTE = 'app.put("/api/invoices/:id/revert", requireRole("Super Admin"), (req, res) => {';
const RESTORE_ROUTE = 'app.put("/api/invoices/:id/restore", requireRole("Super Admin"), (req, res) => {';

const DDL = `CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE,
	driver TEXT NOT NULL, week_start TEXT NOT NULL, week_end TEXT NOT NULL, loads_count INTEGER NOT NULL DEFAULT 0,
	rate_per_load REAL NOT NULL DEFAULT 250, total_earnings REAL NOT NULL DEFAULT 0, expenses_total REAL NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'Draft', rejection_note TEXT DEFAULT '', pdf_file_name TEXT DEFAULT '', load_ids TEXT DEFAULT '[]',
	expense_ids TEXT DEFAULT '[]', submitted_at TEXT DEFAULT '', approved_at TEXT DEFAULT '', approved_by TEXT DEFAULT '',
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at TEXT DEFAULT '', processed_by TEXT DEFAULT '', paid_at TEXT DEFAULT '',
	paid_by TEXT DEFAULT '', adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '',
	adjusted_at TEXT DEFAULT '', render_data TEXT DEFAULT '{}', deleted_at TEXT DEFAULT '', deleted_by TEXT DEFAULT '',
	delete_reason TEXT DEFAULT '', is_manual INTEGER DEFAULT 0, created_by TEXT DEFAULT '')`;

function harness(src) {
	const db = new Database(":memory:");
	db.exec(DDL);
	const fns = new Function("db", [
		liftFn(src, "normalizeDriverName"), liftFn(src, "driverOwnsInvoice"), liftFn(src, "invoiceTotalDue"),
		liftFn(src, "buildPaymentReport"), liftFn(src, "sanitizeManualInvoiceRows"),
		liftFn(src, "invoiceListSummary", true) || "const invoiceListSummary = undefined;",
		liftFn(src, "manualInvoiceTotals", true) || "const manualInvoiceTotals = undefined;",
		"return { normalizeDriverName, driverOwnsInvoice, invoiceTotalDue, buildPaymentReport, sanitizeManualInvoiceRows, invoiceListSummary, manualInvoiceTotals };",
	].join("\n"))(db);
	const routes = {};
	const app = {};
	for (const verb of ["get", "post", "put", "delete"]) {
		app[verb] = (p, ...handlers) => { routes[`${verb.toUpperCase()} ${p}`] = handlers[handlers.length - 1]; };
	}
	const passthrough = () => (req, res, next) => next && next();
	const rendered = [];
	const deps = {
		db, app, ...fns,
		requireAuth: passthrough(), requireRole: passthrough,
		appTime, APP_TIMEZONE: appTime.resolveAppTimeZone(undefined),
		reservedDriverNameRefusal: () => null,
		findInvoicePayee: () => null,
		generateInvoiceNumber: (payee, start) => `INV-M-TEST-${start}-${rendered.length + 1}`,
		invoicePdfFileName: (n) => `${n}.pdf`,
		renderPolicy: async (templateName, data) => { rendered.push({ templateName, data }); return Buffer.from("%PDF"); },
		// The create writes its row through commitInvoiceWithPdf(); the PDF file is
		// not under test here, the row is.
		commitInvoiceWithPdf: ({ insert }) => insert(),
		logAudit: () => {},
		notifyChange: () => {},
		console: { log() {}, warn() {}, error() {} },
	};
	const routeTexts = [liftRoute(src, LIST_ROUTE), liftRoute(src, MANUAL_ROUTE), liftRoute(src, TOTALS_ROUTE, true)].filter(Boolean);
	new Function(...Object.keys(deps), routeTexts.join("\n"))(...Object.values(deps));
	return { db, routes, rendered, ...fns };
}

function mockRes() {
	return {
		statusCode: 200, body: null,
		status(c) { this.statusCode = c; return this; },
		json(o) { this.body = o; return this; },
	};
}
async function callRoute(w, key, req) {
	if (!w.routes[key]) throw new Error(`${key} is not registered`);
	const res = mockRes();
	await w.routes[key]({ params: {}, query: {}, body: {}, ...req }, res);
	return res;
}

const SUPER = { id: 1, role: "Super Admin", username: "super_admin", driverName: "" };
const SOREN = { id: 2, role: "Driver", username: "sking", driverName: "Soren King" };

function insertInvoice(db, row) {
	const r = {
		week_end: "", loads_count: 3, total_earnings: 0, expenses_total: 0, status: "Submitted",
		adjustment: 0, adjustment_note: "", deleted_at: "", is_manual: 0, ...row,
	};
	db.prepare(
		`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, total_earnings, expenses_total, status, adjustment, adjustment_note, deleted_at, is_manual)
		 VALUES (@invoice_number, @driver, @week_start, @week_end, @loads_count, @total_earnings, @expenses_total, @status, @adjustment, @adjustment_note, @deleted_at, @is_manual)`
	).run(r);
}

const W37 = { start: "2026-09-05", end: "2026-09-11" };
const W38 = { start: "2026-09-12", end: "2026-09-18" };
const W39 = { start: "2026-09-19", end: "2026-09-25" };
const W40 = { start: "2026-09-26", end: "2026-10-02" };
const W41 = { start: "2026-10-03", end: "2026-10-09" };
function seed(db) {
	insertInvoice(db, { invoice_number: "INV-SK-2026W40-01", driver: "Soren King", week_start: W40.start, week_end: W40.end, total_earnings: 1500, adjustment: -300, adjustment_note: "Advance recoupment" });
	insertInvoice(db, { invoice_number: "INV-SK-2026W39-01", driver: "soren  king", week_start: W39.start, week_end: W39.end, total_earnings: 1200, adjustment: 150.25, status: "Approved" });
	insertInvoice(db, { invoice_number: "INV-SK-2026W38-01", driver: "SOREN KING", week_start: W38.start, week_end: W38.end, total_earnings: 1050, status: "Paid" });
	insertInvoice(db, { invoice_number: "INV-SK-2026W41-01", driver: "Soren King", week_start: W41.start, week_end: W41.end, total_earnings: 200, adjustment: -300, status: "Draft" });
	insertInvoice(db, { invoice_number: "INV-SK-2026W37-01", driver: "Soren King", week_start: W37.start, week_end: W37.end, total_earnings: 0.1, adjustment: 0.2, status: "Processing" });
	insertInvoice(db, { invoice_number: "INV-HR-2026W40-01", driver: "Hal Rowe", week_start: W40.start, week_end: W40.end, total_earnings: 800, adjustment: 50 });
	insertInvoice(db, { invoice_number: "INV-HR-2026W39-01", driver: "Hal Rowe", week_start: W39.start, week_end: W39.end, total_earnings: 700, adjustment: -20, status: "Rejected" });
	insertInvoice(db, { invoice_number: "INV-HR-2026W38-01", driver: "Hal Rowe", week_start: W38.start, week_end: W38.end, total_earnings: 999, adjustment: 1, status: "Paid", deleted_at: "2026-10-01T12:00:00.000Z" });
	insertInvoice(db, { invoice_number: "INV-M-OH-2026W39-01", driver: "office help llc", week_start: W39.start, week_end: W39.end, total_earnings: 300, status: "Paid", is_manual: 1 });
}
// Every live invoice above at its total due (total_earnings + adjustment):
// the cards' figures. The deleted Paid invoice is never counted.
const WANT_SUMMARY = {
	Draft: { count: 1, total_due: -100 },
	Submitted: { count: 2, total_due: 2050 },
	Approved: { count: 1, total_due: 1350.25 },
	Processing: { count: 1, total_due: 0.3 },
	Paid: { count: 2, total_due: 1350 },
	Rejected: { count: 1, total_due: 680 },
};
const STATUSES = Object.keys(WANT_SUMMARY);
const round2 = (n) => Math.round(n * 100) / 100;

// ───────────────────────────────────────────────────────────────── batteries
async function batteryList(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const w = harness(src);
	seed(w.db);
	const stored = (id) => w.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
	const byNo = (rows) => Object.fromEntries(rows.map((r) => [r.invoice_number, r]));

	const all = (await callRoute(w, "GET /api/invoices", { session: { user: SUPER } })).body.invoices;
	const rows = byNo(all);
	t("§1 the Super Admin's list: every live invoice, no deleted one", all.length, 8);
	t("§1 a negative adjustment: total_due is the invoice's Total Due ($1,500.00 - $300.00)", rows["INV-SK-2026W40-01"]?.total_due, 1200);
	t("§1 a positive adjustment: total_due includes it", rows["INV-SK-2026W39-01"]?.total_due, 1350.25);
	t("§1 no adjustment: total_due is total_earnings", rows["INV-SK-2026W38-01"]?.total_due, 1050);
	t("§1 an adjustment larger than the earnings: the negative total, as computed", rows["INV-SK-2026W41-01"]?.total_due, -100);
	t("§1 total_due is rounded to the cent ($0.10 + $0.20)", rows["INV-SK-2026W37-01"]?.total_due, 0.3);
	t("§1 every row's total_due is invoiceTotalDue() of the stored invoice",
		all.every((r) => r.total_due === w.invoiceTotalDue(stored(r.id))), true);
	t("§1 total_earnings and the adjustment are still served unchanged",
		[rows["INV-SK-2026W40-01"]?.total_earnings, rows["INV-SK-2026W40-01"]?.adjustment], [1500, -300]);

	const withDeleted = (await callRoute(w, "GET /api/invoices", { session: { user: SUPER }, query: { include_deleted: "true" } })).body.invoices;
	const deleted = withDeleted.find((r) => r.invoice_number === "INV-HR-2026W38-01");
	t("§1 the \"show deleted\" view lists the deleted invoice with its total_due", deleted?.total_due, 1000);

	const mine = (await callRoute(w, "GET /api/invoices", { session: { user: SOREN } })).body.invoices;
	t("§1 a Driver's own list carries total_due too",
		mine.map((r) => [r.invoice_number, r.total_due]).sort(),
		[["INV-SK-2026W37-01", 0.3], ["INV-SK-2026W38-01", 1050], ["INV-SK-2026W39-01", 1350.25], ["INV-SK-2026W40-01", 1200], ["INV-SK-2026W41-01", -100]]);
	return out;
}

async function batterySummary(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const w = harness(src);
	seed(w.db);
	const list = async (query) => (await callRoute(w, "GET /api/invoices", { session: { user: SUPER }, query })).body;

	const body = await list({});
	t("§2 the list answers the cards' figures: per status, the count and total due of the live invoices", body.summary, WANT_SUMMARY);
	const shown = await list({ include_deleted: "true" });
	t("§2 the \"show deleted\" view lists the deleted invoice but never counts it (the cards stay the same)",
		[shown.invoices.length, shown.summary], [9, WANT_SUMMARY]);
	t("§2 each status's figure is the sum of its listed live rows' total_due",
		STATUSES.map((s) => {
			const live = (shown.invoices || []).filter((r) => !r.deleted_at && r.status === s);
			return [s, live.length, round2(live.reduce((n, r) => n + r.total_due, 0))];
		}),
		STATUSES.map((s) => [s, WANT_SUMMARY[s].count, WANT_SUMMARY[s].total_due]));
	t("§2 the adjustments are included (Submitted $2,050.00 and Approved $1,350.25, not total_earnings' $2,300.00 and $1,200.00)",
		[body.summary?.Submitted?.total_due, body.summary?.Approved?.total_due], [2050, 1350.25]);
	t("§2 invoiceListSummary() counts only rows that are not deleted, at invoiceTotalDue()",
		typeof w.invoiceListSummary === "function"
			? w.invoiceListSummary([
				{ status: "Paid", total_earnings: 10, adjustment: 5, deleted_at: "" },
				{ status: "Paid", total_earnings: 7, adjustment: 0, deleted_at: "2026-10-01T00:00:00.000Z" },
				{ status: "Unknown", total_earnings: 3, adjustment: 0, deleted_at: "" },
			]).Paid
			: "no invoiceListSummary()", { count: 1, total_due: 15 });

	// The cards follow the list the route answers: the screen sends no filter, so
	// they cover every live invoice; a filtered call (the route's own ?driver=)
	// summarizes the rows it lists, and agrees with the payment report for them.
	const soren = await list({ driver: "Soren  King" });
	const report = w.buildPaymentReport("Soren King", "2026-09-01", "2026-10-31");
	const s = soren.summary || {};
	t("§2 a payee's cards agree with the payment report for the same invoices (paid, pending, draft)",
		[s.Paid?.total_due, round2((s.Submitted?.total_due || 0) + (s.Approved?.total_due || 0) + (s.Processing?.total_due || 0)), s.Draft?.total_due],
		[report.summary.totalPaid, report.summary.totalPending, report.summary.totalDraft]);
	return out;
}

const MANUAL_BODY = {
	payee: "Office Help LLC", payeeRole: "", payeeAddress: "", payeePhone: "",
	periodStart: "2026-10-03", periodEnd: "2026-10-09",
	lineItems: [{ date: "", description: "Weekly office support", amount: 100.25 }, { date: "", description: "Filing", amount: 50.104 }],
	deductions: [{ date: "", description: "Advance recoupment", amount: 20.35 }],
	notes: "",
};
async function batteryManual(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const w = harness(src);
	seed(w.db);
	const count = () => w.db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n;
	const before = count();
	const totals = (body) => callRoute(w, "POST /api/invoices/manual/totals", { session: { user: SUPER }, body });

	const ok = await totals({ lineItems: MANUAL_BODY.lineItems, deductions: MANUAL_BODY.deductions });
	t("§3 the totals strip's figures come from the server, each row rounded as the create rounds it",
		[ok.statusCode, ok.body], [200, { complete: true, subtotal: 150.35, deductionsTotal: 20.35, totalDue: 130 }]);
	const none = await totals({ lineItems: [{ description: "Bonus", amount: 75 }] });
	t("§3 no deductions: the total due is the subtotal", none.body, { complete: true, subtotal: 75, deductionsTotal: 0, totalDue: 75 });
	const blank = await totals({ lineItems: [{ description: "", amount: 5 }], deductions: [] });
	t("§3 a row the create would refuse: complete false with the create's message, not a failed request",
		[blank.statusCode, blank.body], [200, { complete: false, error: "lineItems: every row needs a description" }]);
	const empty = await totals({ lineItems: [], deductions: [] });
	t("§3 no line item: complete false", empty.body, { complete: false, error: "At least one line item is required" });
	const big = await totals({ lineItems: [{ description: "Too much", amount: 1000001 }] });
	t("§3 an amount over the cap: complete false", big.body?.complete, false);
	t("§3 the totals route writes nothing and renders nothing", [count() - before, w.rendered.length], [0, 0]);
	const text = liftRoute(src, TOTALS_ROUTE, true) || "";
	t("§3 the totals route's source writes nothing (no INSERT/UPDATE/DELETE, no audit, no render, no number)",
		/\b(INSERT INTO|UPDATE |DELETE FROM)\b|logAudit|renderPolicy|generateInvoiceNumber|notifyChange/.test(text), false);

	// The create, run on the same rows: it stores the totals the strip showed.
	const created = await callRoute(w, "POST /api/invoices/manual", { session: { user: SUPER }, body: MANUAL_BODY });
	const inv = created.body?.invoice || {};
	const row = inv.id ? w.db.prepare("SELECT * FROM invoices WHERE id = ?").get(inv.id) : {};
	t("§3 the create stores the strip's total due and deductions, and renders its subtotal",
		[row.total_earnings, row.expenses_total, w.rendered[0]?.data?.subtotal, w.rendered[0]?.data?.deductionsTotal, w.rendered[0]?.data?.totalDue],
		[ok.body?.totalDue, ok.body?.deductionsTotal, ok.body?.subtotal, ok.body?.deductionsTotal, ok.body?.totalDue]);
	t("§3 the create answers the invoice with its total_due (the detail it opens shows the server's figure)", inv.total_due, 130);
	t("§3 manualInvoiceTotals() is the one definition: the create and the totals route both call it, and nothing else sums the rows",
		[(liftRoute(src, MANUAL_ROUTE).match(/manualInvoiceTotals\(itemsRes\.items, dedRes\.items\)/g) || []).length,
			(text.match(/manualInvoiceTotals\(itemsRes\.items, dedRes\.items\)/g) || []).length,
			/\.reduce\(/.test(liftRoute(src, MANUAL_ROUTE)) || /\.reduce\(/.test(text)],
		[1, 1, false]);

	// The other answers that hand the screen an invoice row carry its total_due.
	const carries = (head, v) => new RegExp(`invoice: \\{ \\.\\.\\.${v}, total_due: invoiceTotalDue\\(${v}\\) \\}`).test(liftRoute(src, head));
	t("§3 the adjust, revert and restore answers carry the invoice's total_due",
		[carries(ADJUST_ROUTE, "final"), carries(REVERT_ROUTE, "fresh"), carries(RESTORE_ROUTE, "fresh")], [true, true, true]);
	return out;
}

// ── the client: the shipping files, read as text; formatters run on stand-ins
function liftClient(text, needle, label) {
	const at = text.indexOf(needle);
	if (at < 0) return null;
	if (text.indexOf(needle, at + 1) >= 0) throw new Error(`more than one ${label}`);
	const ends = ["\n}\n", "\n})\n", "\n])\n"].map((e) => text.indexOf(e, at)).filter((i) => i >= 0);
	if (!ends.length) throw new Error(`no end after ${label}`);
	return text.slice(at + 1, Math.min(...ends) + 3);
}
const clientFn = (text, name) => liftClient(text, `\nfunction ${name}(`, `function ${name}()`);
function viewHelpers(view) {
	const names = ["fmtMoney", "formatAdj", "dueText", "adjTooltip"];
	const body = names.map((n) => clientFn(view, n) || `const ${n} = undefined;`).join("\n");
	return new Function(`${body}\nreturn { ${names.join(", ")} };`)();
}
// A row whose total_due is deliberately NOT total_earnings + adjustment: a
// figure the browser worked out shows $1,200.00, the server's shows $1,199.99.
const POISONED = { total_earnings: 1500, adjustment: -300, adjustment_note: "Advance recoupment", total_due: 1199.99 };
// Server card figures no browser sum over an empty list could produce.
const STAND_IN_SUMMARY = {
	Draft: { count: 4, total_due: 10 },
	Submitted: { count: 3, total_due: 4321.5 },
	Approved: { count: 2, total_due: 1200 },
	Processing: { count: 1, total_due: 99.99 },
	Paid: { count: 7, total_due: 12345.67 },
	Rejected: { count: 5, total_due: 50 },
};
// Money arithmetic a screen file must not do: summing rows, or adding or
// subtracting a money field (or a typed amount) in an expression.
const MONEY_ARITHMETIC = [
	/\.reduce\(/,
	/total_earnings[^\n]{0,40}?\)\s*[+-]\s*[(\w]/,
	/[+-]\s*\(?\s*(?:Number\()?\s*(?:inv|selectedInvoice|r|i)\.(?:adjustment|total_earnings|amount)\b/,
	/[+-]\s*\(?\s*Number\(adjustAmount\)/,
	/\b(?:subtotal|deductionsTotal)(?:\.value)?\s*-\s*\w/,
];
function batteryClient(files) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const { view, store, manual, report } = files;

	t("§4 no Invoices screen file does money arithmetic (no row sums, no adding or subtracting money fields)",
		Object.entries({ view, store, manual, report })
			.flatMap(([k, src]) => MONEY_ARITHMETIC.filter((re) => re.test(src)).map((re) => `${CLIENT_FILES[k]} ${re}`)), []);

	t("§4 the store keeps the server's summary from GET /api/invoices", /this\.summary\s*=\s*res\.summary\b/.test(store), true);
	t("§4 the store reads no total_earnings (it adds no money)", /total_earnings/.test(store), false);

	const kpiText = liftClient(view, "\nconst kpiCards = computed(", "kpiCards");
	const h = viewHelpers(view);
	const cards = (summary) => new Function("computed", "store", "fmtMoney", "dueText", `${kpiText}\nreturn kpiCards.value;`)(
		(fn) => ({ value: fn() }), { summary, invoices: [] }, h.fmtMoney, h.dueText);
	const shown = cards(STAND_IN_SUMMARY);
	const byLabel = Object.fromEntries(shown.map((c) => [c.label, [c.value, c.sub]]));
	t("§4 the cards show the server's count and total due per status",
		[byLabel.Submitted, byLabel.Approved, byLabel.Processing, byLabel.Paid, byLabel.Rejected?.[0]],
		[[3, "$4,321.50 pending review"], [2, "$1,200.00 ready to pay"], [1, "$99.99 payment in flight"], [7, "$12,345.67 settled"], 5]);
	const before = cards(null);
	t("§4 before the summary arrives a card shows a dash, never 0 or $0.00",
		before.filter((c) => c.label !== "Rejected").map((c) => [c.value, c.sub.split(" ")[0]]),
		[["—", "—"], ["—", "—"], ["—", "—"], ["—", "—"]]);

	t("§4 a total due is shown as the server sent it, or a dash", typeof h.dueText === "function"
		? [h.dueText(1199.99), h.dueText(-100), h.dueText(undefined), h.dueText(null)] : "no dueText()",
		["$1,199.99", "$-100.00", "—", "—"]);
	const tip = typeof h.adjTooltip === "function" ? h.adjTooltip(POISONED) : "";
	t("§4 the tooltip's total is the server's total_due ($1,199.99 on a stand-in row), never total_earnings + adjustment ($1,200.00)",
		[tip.includes("$1,199.99"), tip.includes("1,200.00")], [true, false]);
	t("§4 the row's Total shows total_due", /\{\{\s*dueText\(inv\.total_due\)\s*\}\}/.test(view), true);
	t("§4 the detail's Total due shows total_due", /<span class="meta-label font-bold">Total due<\/span>\s*<span[^>]*>\{\{\s*dueText\(selectedInvoice\.total_due\)\s*\}\}<\/span>/.test(view), true);
	const preview = (view.match(/<div class="adjust-preview"[\s\S]*?\n {14}<\/div>/) || [""])[0];
	t("§4 the adjust form shows the current total due from the server and the typed adjustment, with no sum",
		[/dueText\(selectedInvoice\.total_due\)/.test(preview), /formatAdj\(adjustAmount\)/.test(preview), /=\s*&nbsp;|&nbsp;=|\s=\s/.test(preview)],
		[true, true, false]);

	t("§4 the manual dialog asks the server for its totals", /api\.post\('\/api\/invoices\/manual\/totals'/.test(manual), true);
	t("§4 the manual dialog's totals strip shows the server's subtotal, deductions and total due",
		["subtotal", "deductionsTotal", "totalDue"].map((k) => new RegExp(`totalText\\('${k}'`).test(manual)), [true, true, true]);
	const totalText = clientFn(manual, "totalText");
	const fmt = clientFn(manual, "fmtMoney");
	const strip = totalText && fmt
		? new Function("totals", `${fmt}\n${totalText}\nreturn totalText;`)({ value: { subtotal: 150.35, deductionsTotal: 20.35, totalDue: 130 } })
		: null;
	const stripEmpty = totalText && fmt ? new Function("totals", `${fmt}\n${totalText}\nreturn totalText;`)({ value: null }) : null;
	t("§4 the strip shows each server figure as sent, and a dash while there is none",
		strip ? [strip("subtotal"), strip("deductionsTotal", "-"), strip("totalDue"), stripEmpty("totalDue")] : "no totalText()",
		["$150.35", "-$20.35", "$130.00", "—"]);

	t("§4 the payment report shows the server's total_due and summary (unchanged)",
		[/fmtMoney\(inv\.total_due\)/.test(report), /report\.summary\.totalPayable/.test(report)], [true, true]);
	return out;
}

const SERVER_BATTERIES = [
	["list", batteryList],
	["summary", batterySummary],
	["manual totals", batteryManual],
];

// Each mutant rewrites the fix back to a narrower rule and must flip at least
// one assertion. A test that passes on both has not tested anything.
const SERVER_MUTANTS = [
	["the list drops the adjustment", "invoices = invoices.map((r) => ({ ...r, total_due: invoiceTotalDue(r) }));",
		"invoices = invoices.map((r) => ({ ...r, total_due: r.total_earnings }));"],
	["the cards count deleted rows", "rows.filter((r) => !r.deleted_at && r.status === status)", "rows.filter((r) => r.status === status)"],
	["the cards sum total_earnings", "live.reduce((s, r) => s + invoiceTotalDue(r), 0)", "live.reduce((s, r) => s + (r.total_earnings || 0), 0)"],
	["the manual totals ignore the deductions", "totalDue: round2(subtotal - deductionsTotal)", "totalDue: round2(subtotal)"],
];
const CLIENT_MUTANTS = [
	["the tooltip adds total_earnings and the adjustment in the browser", "view",
		"Total due: ${dueText(inv.total_due)}", "Total due: ${dueText((inv.total_earnings || 0) + (inv.adjustment || 0))}"],
	["the store drops the server's summary", "store", "this.summary = res.summary || null", "this.summary = null"],
	["the manual dialog's strip subtracts its own figures", "manual",
		"{{ totalText('totalDue') }}", "${{ fmtMoney(subtotal - deductionsTotal) }}"],
];

// ───────────────────────────────────────────────────────────────── runner
let pass = 0;
const failures = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function report(checks) {
	for (const [label, actual, expected] of checks) {
		if (same(actual, expected)) { pass++; console.log(`ok    ${label}`); }
		else {
			failures.push(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
			console.log(`FAIL  ${label}\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`);
		}
	}
}
async function run(label, fn) {
	try { report(await fn()); }
	catch (err) {
		failures.push(`${label} threw: ${err.message}`);
		console.log(`FAIL  ${label} threw: ${err.message}`);
	}
}
async function flips(fn) {
	try { return { flipped: (await fn()).filter(([, a, e]) => !same(a, e)).map(([l]) => l), threw: "" }; }
	catch (err) { return { flipped: [], threw: err.message }; }
}

(async () => {
	for (const [name, battery] of SERVER_BATTERIES) await run(name, () => battery(SRC));
	await run("client", () => batteryClient(CLIENT));

	console.log("\n§5 MUTANTS — each must flip at least one assertion above");
	for (const [label, find, replace] of SERVER_MUTANTS) {
		const hits = SRC.split(find).length - 1;
		if (hits !== 1) { report([[`MUTANT ${label}: its target appears once in server.js`, hits, 1]]); continue; }
		const src = SRC.replace(find, replace);
		const flipped = [];
		const threw = [];
		for (const [name, battery] of SERVER_BATTERIES) {
			const r = await flips(() => battery(src));
			flipped.push(...r.flipped);
			if (r.threw) threw.push(`${name}: ${r.threw}`);
		}
		report([[`MUTANT ${label} → ${threw.length ? `a battery THREW (${threw[0]})` : flipped.length ? flipped[0] : "NOTHING fails"}`,
			threw.length === 0 && flipped.length > 0, true]]);
	}
	for (const [label, file, find, replace] of CLIENT_MUTANTS) {
		const hits = CLIENT[file].split(find).length - 1;
		if (hits !== 1) { report([[`MUTANT ${label}: its target appears once in ${CLIENT_FILES[file]}`, hits, 1]]); continue; }
		const r = await flips(() => batteryClient({ ...CLIENT, [file]: CLIENT[file].replace(find, replace) }));
		report([[`MUTANT ${label} → ${r.threw ? `the battery THREW (${r.threw})` : r.flipped.length ? r.flipped[0] : "NOTHING fails"}`,
			!r.threw && r.flipped.length > 0, true]]);
	}

	console.log("\n" + "-".repeat(60));
	if (failures.length) {
		console.log(`FAILED — ${failures.length} of ${pass + failures.length} assertions:\n  ${failures.join("\n  ")}`);
		process.exit(1);
	}
	console.log(`OK — ${pass} assertions passed`);
})();
