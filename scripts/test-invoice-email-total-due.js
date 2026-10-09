#!/usr/bin/env node
/**
 * A driver weekly invoice's emails print the total the invoice itself carries:
 * total_earnings plus the admin adjustment, worked out by the server through
 * invoiceTotalDue() (the PDF's TOTAL DUE). Before this, both emails that print
 * an invoice's amount printed total_earnings alone, so a week adjusted by
 * -$300.00 emailed $1500.00 while its PDF, the driver app and the payment
 * report said $1200.00.
 *
 * THE SWEEP — every email server.js sends about a driver weekly invoice:
 *   - PUT /api/invoices/:id/approve → invoiceStatusChangeEmail(), to the
 *     driver on every status change: one "Total:" line, no breakdown. FIXED.
 *   - PUT /api/invoices/:id/submit → "New Invoice" to the admin inbox, with
 *     the PDF attached: a summary box ending in "Total". FIXED, and the box
 *     shows the adjustment as its own line, as the PDF does, only when there is
 *     one.
 *   - the Friday batch's "Weekly Invoices" summary and its sheet-unreadable
 *     alert, and the undated-loads digest: counts and load ids, no amount.
 *   - every subject: invoice number, driver or status, no amount; the shared
 *     wrapper (invoiceEmailHtml()) has no preview text.
 *   Broker (load) invoice emails are lib/broker-invoice.js's and not in scope.
 *
 * WHAT IS ASSERTED — the shipping code, lifted out of server.js (it cannot be
 * required: it opens SQLite, reads a key and listens on import): both routes
 * run over an in-memory SQLite with mail captured, never sent.
 *   §1 THE STATUS EMAIL. Approve, processing, paid and reject each email the
 *      driver a Total equal to invoiceTotalDue() and to the PDF's TOTAL DUE
 *      (lib/policy-field-maps.js) for the same invoice: a negative, a positive
 *      and an adjustment larger than the earnings. No breakdown is added.
 *   §2 THE SUBMIT EMAIL. Its Total is the same figure; an adjusted invoice
 *      shows one "Admin adjustment" line just above the Total, signed and
 *      formatted as the PDF's adjustment line, with the reason escaped; an
 *      invoice with no adjustment shows none. Manual invoices too. The subject
 *      carries no amount.
 *   §3 NO ADJUSTMENT, NO CHANGE. With adjustment 0 or null, every email is
 *      byte-identical to the one origin/main sent (sha256 captured on main at
 *      e48f89c, before this change).
 *   §4 MUTANTS — each email reverting to total_earnings, the adjustment line
 *      dropped, and the line shown for a zero adjustment must each flip at
 *      least one assertion above.
 *
 * Pure: no server, no app.db, no network, no Sheets; mail is captured.
 * Run: node scripts/test-invoice-email-total-due.js     # exits 1 on failure
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const POLICY_FIELD_MAPS = require("../lib/policy-field-maps");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// ───────────────────────────────────────────────────────────────── lifting
// Anchored on a newline and counted, so a mention in a comment is never taken
// for the definition and a second copy fails the run. A top-level function ends
// at the first column-0 "}" line; a route at the first column-0 "});" line.
function liftBetween(src, needle, terminator, label) {
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 ${label} in server.js, found ${hits}`);
	const a = src.indexOf(needle) + 1;
	const end = src.indexOf(terminator, a);
	if (end < 0) throw new Error(`no terminator after ${label}`);
	return src.slice(a, end + terminator.length);
}
const liftFn = (src, name) => liftBetween(src, `\nfunction ${name}(`, "\n}\n", `function ${name}()`);
const liftRoute = (src, head) => liftBetween(src, `\n${head}`, "\n});\n", head);

const FNS = ["escHtml", "invoiceEmailHtml", "invoiceStatusChangeEmail", "invoiceTotalDue"];
const SUBMIT = 'app.put("/api/invoices/:id/submit", requireAuth, async (req, res) => {';
const APPROVE = 'app.put("/api/invoices/:id/approve", requireRole("Super Admin"), async (req, res) => {';

const DDL = `CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE,
	driver TEXT NOT NULL, week_start TEXT NOT NULL, week_end TEXT NOT NULL, loads_count INTEGER NOT NULL DEFAULT 0,
	rate_per_load REAL NOT NULL DEFAULT 250, total_earnings REAL NOT NULL DEFAULT 0, expenses_total REAL NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'Draft', rejection_note TEXT DEFAULT '', pdf_file_name TEXT DEFAULT '',
	submitted_at TEXT DEFAULT '', approved_at TEXT DEFAULT '', approved_by TEXT DEFAULT '',
	processed_at TEXT DEFAULT '', processed_by TEXT DEFAULT '', paid_at TEXT DEFAULT '', paid_by TEXT DEFAULT '',
	adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '',
	deleted_at TEXT DEFAULT '', is_manual INTEGER DEFAULT 0)`;

const ROOTS = [];
function buildWorld(src) {
	const db = new Database(":memory:");
	db.exec(DDL);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-invmail-"));
	ROOTS.push(root);
	const routes = {};
	const app = {};
	for (const verb of ["get", "post", "put", "delete"]) {
		app[verb] = (p, ...handlers) => { routes[`${verb.toUpperCase()} ${p}`] = handlers[handlers.length - 1]; };
	}
	const emails = [];
	const logs = [];
	const passthrough = () => (req, res, next) => next && next();
	const deps = {
		db, app, fs, path, DATA_DIR: root,
		requireAuth: passthrough(),
		requireRole: passthrough,
		driverOwnsInvoice: () => true,
		notifyChange: () => {},
		// One Driver account carries the invoice's name, so the status email has
		// its one recipient.
		driverAccountsNamed: () => [{ role: "Driver", email: "driver@example.test" }],
		invoiceMonthLockBlockers: () => ({ blockers: [] }),
		periodLockUnreadableResponse: () => { throw new Error("period locks are not under test here"); },
		periodBlockedResponse: () => { throw new Error("period locks are not under test here"); },
		INVOICE_LOCK_REMEDY: "",
		sendEmail: async (to, subject, html, attachments = []) => { emails.push({ to, subject, html, attachments }); return true; },
		console: {
			log: (...a) => logs.push(a.join(" ")),
			warn: (...a) => logs.push(a.join(" ")),
			error: (...a) => logs.push(a.join(" ")),
		},
	};
	const body = [...FNS.map((f) => liftFn(src, f)), liftRoute(src, SUBMIT), liftRoute(src, APPROVE),
		`return { ${FNS.join(", ")} };`].join("\n");
	const fns = new Function(...Object.keys(deps), body)(...Object.values(deps));
	return { db, routes, emails, logs, ...fns };
}

function mockRes() {
	return {
		statusCode: 200, body: null,
		status(c) { this.statusCode = c; return this; },
		json(o) { this.body = o; return this; },
	};
}
const SUPER = { id: 1, role: "Super Admin", username: "super_admin", driverName: "" };
async function callRoute(w, key, req) {
	const res = mockRes();
	await w.routes[key]({ params: {}, query: {}, body: {}, session: { user: SUPER }, ...req }, res);
	// Let the fire-and-forget email run to completion.
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	return res;
}
function insertInvoice(db, f) {
	return db.prepare(
		`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, total_earnings, status, pdf_file_name, adjustment, adjustment_note, is_manual)
		 VALUES (@invoice_number, @driver, @week_start, @week_end, @loads_count, @total_earnings, @status, @pdf_file_name, @adjustment, @adjustment_note, @is_manual)`
	).run({
		driver: "Soren King", week_start: "2026-10-03", week_end: "2026-10-09", loads_count: 5,
		total_earnings: 1500, status: "Draft", adjustment: 0, adjustment_note: "", is_manual: 0,
		pdf_file_name: `${f.invoice_number}.pdf`, ...f,
	}).lastInsertRowid;
}
const rowById = (w, id) => w.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);

// The status each action needs, and the one it leaves.
const TRANSITIONS = [
	["approve", "Submitted", "Approved"],
	["processing", "Approved", "Processing"],
	["paid", "Processing", "Paid"],
	["reject", "Submitted", "Rejected"],
];
// One emailed transition: a fresh invoice in the status the action needs.
async function statusEmail(w, invoice, action, from, extraBody = {}) {
	const before = w.emails.length;
	const id = insertInvoice(w.db, { ...invoice, invoice_number: `${invoice.invoice_number}-${action}`, status: from });
	const res = await callRoute(w, "PUT /api/invoices/:id/approve", { params: { id: String(id) }, body: { action, ...extraBody } });
	if (res.statusCode !== 200) throw new Error(`${action} answered ${res.statusCode}: ${JSON.stringify(res.body)}`);
	const sent = w.emails.slice(before);
	if (sent.length !== 1) throw new Error(`${action} sent ${sent.length} emails`);
	return { ...sent[0], row: rowById(w, id) };
}
async function submitEmail(w, invoice) {
	const before = w.emails.length;
	const id = insertInvoice(w.db, { ...invoice, status: "Draft" });
	const res = await callRoute(w, "PUT /api/invoices/:id/submit", { params: { id: String(id) } });
	if (res.statusCode !== 200) throw new Error(`submit answered ${res.statusCode}: ${JSON.stringify(res.body)}`);
	const sent = w.emails.slice(before);
	if (sent.length !== 1) throw new Error(`submit sent ${sent.length} emails`);
	return { ...sent[0], row: rowById(w, id) };
}

// What an email says the total is: the status email's "Total:" line, the
// submit email's "Total" row.
const statusTotal = (html) => { const m = html.match(/<b>Total:<\/b> \$(-?[\d.]+)<\/p>/); return m ? Number(m[1]) : null; };
const submitTotal = (html) => { const m = html.match(/font-weight:600">Total<\/span><b style="color:#0f172a">\$(-?[\d.]+)<\/b>/); return m ? Number(m[1]) : null; };
// The submit email's summary rows, label and value, in order.
const submitRows = (html) => [...html.matchAll(/<div style="display:flex;justify-content:space-between;[^"]*"><span style="color:#64748b[^"]*">([\s\S]*?)<\/span><b[^>]*>([\s\S]*?)<\/b><\/div>/g)]
	.map((m) => [m[1], m[2]]);
// The PDF's figures for the same invoice: the weekly day-rate template's map,
// the one the replica's adjusted weeks render through.
function pdfFigures(row) {
	const t = POLICY_FIELD_MAPS.service_invoice({ totalDue: row.total_earnings, adjustment: row.adjustment, adjustmentNote: row.adjustment_note }).text;
	return { totalDue: Number(t["Total due"]), adjustmentAmount: t["Adjustment amount"], adjustmentLabel: t["Adjustment label"] };
}

const ADJUSTED = [
	["a -$300.00 deduction", { invoice_number: "INV-SK-2026W41-01", total_earnings: 1500, adjustment: -300, adjustment_note: "Sunday 10/4 was not a pay day" }, 1200, "-$300.00"],
	["a +$75.50 bonus", { invoice_number: "INV-SK-2026W41-02", total_earnings: 600, adjustment: 75.5, adjustment_note: "Detention" }, 675.5, "+$75.50"],
	["a deduction larger than the earnings", { invoice_number: "INV-SK-2026W41-03", total_earnings: 200, adjustment: -300, adjustment_note: "" }, -100, "-$300.00"],
];

// ───────────────────────────────────────────────────────────────── batteries
async function batteryStatus(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const w = buildWorld(src);
	for (const [what, invoice, due] of ADJUSTED) {
		const totals = [];
		const checks = [];
		for (const [action, from, to] of TRANSITIONS) {
			const m = await statusEmail(w, invoice, action, from, action === "reject" ? { rejectionNote: "Check Sunday" } : {});
			totals.push([to, statusTotal(m.html)]);
			checks.push([to, statusTotal(m.html) === w.invoiceTotalDue(m.row), statusTotal(m.html) === pdfFigures(m.row).totalDue]);
		}
		t(`§1 ${what}: every status email's Total is the invoice's total due`, totals, TRANSITIONS.map(([, , to]) => [to, due]));
		t(`§1 ${what}: …equal to invoiceTotalDue() and to the PDF's TOTAL DUE`, checks, TRANSITIONS.map(([, , to]) => [to, true, true]));
	}
	const m = await statusEmail(w, { ...ADJUSTED[0][1], invoice_number: "INV-SK-2026W41-06" }, "approve", "Submitted");
	t("§1 the status email adds no breakdown: one money figure, no adjustment line",
		[(m.html.match(/\$-?\d/g) || []).length, /adjustment/i.test(m.html)], [1, false]);
	t("§1 the status email's subject carries no amount", [m.to, m.subject], ["driver@example.test", "Invoice INV-SK-2026W41-06-approve: Approved"]);
	t("§1 invoiceStatusChangeEmail() takes its Total from invoiceTotalDue() and never reads total_earnings",
		[/invoiceTotalDue\(invoice\)/.test(liftFn(src, "invoiceStatusChangeEmail")), /total_earnings/.test(liftFn(src, "invoiceStatusChangeEmail"))], [true, false]);
	return out;
}

async function batterySubmit(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const w = buildWorld(src);
	for (const [what, invoice, due, amountText] of ADJUSTED) {
		const m = await submitEmail(w, invoice);
		const pdf = pdfFigures(m.row);
		t(`§2 ${what}: the submit email's Total is the invoice's total due`, submitTotal(m.html), due);
		t(`§2 ${what}: …equal to invoiceTotalDue() and to the PDF's TOTAL DUE`,
			[submitTotal(m.html) === w.invoiceTotalDue(m.row), submitTotal(m.html) === pdf.totalDue], [true, true]);
		const rows = submitRows(m.html);
		const note = invoice.adjustment_note ? ` <em>${invoice.adjustment_note}</em>` : "";
		t(`§2 ${what}: one Admin adjustment line, just above the Total, signed as the PDF's (${pdf.adjustmentAmount})`,
			rows.slice(-2), [[`Admin adjustment${note}`, amountText], ["Total", `$${due.toFixed(2)}`]]);
		t(`§2 ${what}: the line's amount is the PDF's adjustment amount, character for character`, rows[rows.length - 2][1], pdf.adjustmentAmount);
	}
	const plain = await submitEmail(w, { invoice_number: "INV-SK-2026W41-04", total_earnings: 1500 });
	t("§2 no adjustment: no adjustment line, the Total is total_earnings",
		[submitRows(plain.html).map(([l]) => l), submitTotal(plain.html)], [["Invoice", "Driver", "Week", "Loads", "Total"], 1500]);
	const manual = await submitEmail(w, { invoice_number: "INV-MAN-2026W41-01", driver: "Ana Office", is_manual: 1, loads_count: 2, total_earnings: 980.25, adjustment: -80.25, adjustment_note: "Advance" });
	t("§2 a manual invoice: the adjustment line and the total due",
		submitRows(manual.html).slice(-2), [["Admin adjustment <em>Advance</em>", "-$80.25"], ["Total", "$900.00"]]);
	const hostile = await submitEmail(w, { invoice_number: "INV-SK-2026W41-05", total_earnings: 900, adjustment: -100, adjustment_note: `<img src=x onerror="alert(1)"> & 'more'` });
	t("§2 the adjustment reason is escaped",
		submitRows(hostile.html).slice(-2)[0][0], "Admin adjustment <em>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;more&#39;</em>");
	t("§2 the subject carries no amount and the recipient is the admin inbox's variable",
		[plain.subject, manual.subject], ["New Invoice: INV-SK-2026W41-04 - Soren King", "New Invoice: INV-MAN-2026W41-01 - Ana Office"]);
	t("§2 the submit email never reads total_earnings",
		/total_earnings/.test(liftRoute(src, SUBMIT)), false);
	return out;
}

// sha256 of each no-adjustment email as origin/main (e48f89c) built it. To
// re-capture after a deliberate template change, read the "got" line of a
// failure here — only once the change is meant to alter every invoice's email.
const MAIN_GOLDEN = {
	"status approve": "5ac559a4fd7d38758d300f8103d51faee124250e142bc93cc88de1dcc9d244df",
	"status processing": "2bf58b26762c934d303f2203d596ccd49fcce9b5a3ee048990084e1e1e24ccb4",
	"status paid": "c6bdfc345db9249bffcd48c8f0ff216be038e83b92ee6ea023a691743379ef13",
	"status reject": "506ed0077ebedb397dc6c53edd57347bc7504d4d0e878eae21ad5e8038e29f3c",
	"submit": "16c91fe7a33192d02ab4dfb5079468fd58861086c2785bd1a9b40b4587f06a1a",
	"submit manual": "2cde1faa17fbb2d5f0bd52fc3465155597178168f43e370220072c4126d45ca2",
};
// Each email's HTML with its (per-row unique) invoice number folded to "INV".
const shaOf = (html, invoiceNumber) => crypto.createHash("sha256").update(html.split(invoiceNumber).join("INV")).digest("hex");
async function batteryUnchanged(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const w = buildWorld(src);
	const byAdjustment = {};
	for (const adjustment of [0, null]) {
		const tag = adjustment === null ? "null" : "0";
		const got = {};
		for (const [action, from] of TRANSITIONS) {
			const no = `INV-SK-2026W41-${tag}`;
			const m = await statusEmail(w, { invoice_number: no, total_earnings: 1500, adjustment }, action, from, action === "reject" ? { rejectionNote: "Check Sunday" } : {});
			got[`status ${action}`] = shaOf(m.html, `${no}-${action}`);
		}
		const d = await submitEmail(w, { invoice_number: `INV-SK-2026W41-${tag}-submit`, total_earnings: 1500, adjustment });
		got["submit"] = shaOf(d.html, `INV-SK-2026W41-${tag}-submit`);
		const mm = await submitEmail(w, { invoice_number: `INV-MAN-2026W41-${tag}`, driver: "Ana Office", is_manual: 1, loads_count: 2, total_earnings: 980.25, adjustment });
		got["submit manual"] = shaOf(mm.html, `INV-MAN-2026W41-${tag}`);
		byAdjustment[tag] = got;
	}
	t("§3 adjustment 0: every email is byte-identical to origin/main's", byAdjustment["0"], MAIN_GOLDEN);
	t("§3 adjustment null: every email is byte-identical to origin/main's", byAdjustment["null"], MAIN_GOLDEN);
	return out;
}

const BATTERIES = [
	["status email", batteryStatus],
	["submit email", batterySubmit],
	["unchanged", batteryUnchanged],
];

// Each mutant rewrites the fix back to a narrower rule and must flip at least
// one assertion. A test that passes on both has not tested anything.
const MUTANTS = [
	["the status email prints total_earnings again",
		"<b>Total:</b> $${invoiceTotalDue(invoice).toFixed(2)}", "<b>Total:</b> $${Number(invoice.total_earnings || 0).toFixed(2)}"],
	["the submit email's Total prints total_earnings again",
		"<b style=\"color:#0f172a\">$${invoiceTotalDue(invoice).toFixed(2)}</b>", "<b style=\"color:#0f172a\">$${Number(invoice.total_earnings || 0).toFixed(2)}</b>"],
	["the submit email drops the adjustment line",
		"${adjustmentLine}", ""],
	["the submit email shows the adjustment line for a zero adjustment",
		"Number.isFinite(adjustment) && adjustment !== 0", "Number.isFinite(adjustment)"],
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
async function run(label, battery, src) {
	try { report(await battery(src)); }
	catch (err) {
		failures.push(`${label} threw: ${err.message}`);
		console.log(`FAIL  ${label} threw: ${err.message}`);
	}
}

(async () => {
	for (const [name, battery] of BATTERIES) await run(name, battery, SRC);

	console.log("\n§4 MUTANTS — each must flip at least one assertion above");
	for (const [label, find, replace] of MUTANTS) {
		const hits = SRC.split(find).length - 1;
		if (hits !== 1) { report([[`MUTANT ${label}: its target appears once in server.js`, hits, 1]]); continue; }
		const src = SRC.replace(find, replace);
		const flipped = [];
		const threw = [];
		for (const [name, battery] of BATTERIES) {
			try { flipped.push(...(await battery(src)).filter(([, a, e]) => !same(a, e)).map(([l]) => l)); }
			catch (err) { threw.push(`${name}: ${err.message}`); }
		}
		report([[`MUTANT ${label} → ${threw.length ? `a battery THREW (${threw[0]})` : flipped.length ? flipped[0] : "NOTHING fails"}`,
			threw.length === 0 && flipped.length > 0, true]]);
	}

	for (const root of ROOTS) fs.rmSync(root, { recursive: true, force: true });
	console.log("\n" + "-".repeat(60));
	if (failures.length) {
		console.log(`FAILED — ${failures.length} of ${pass + failures.length} assertions:\n  ${failures.join("\n  ")}`);
		process.exit(1);
	}
	console.log(`OK — ${pass} assertions passed`);
})();
