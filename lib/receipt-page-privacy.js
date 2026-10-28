"use strict";
// Driver privacy PR B: the tables, the roster's sources and the pages-only
// path's text check. server.js wires them (its "DRIVER PRIVACY: PDF RECEIPT
// PAGES" section); scripts/receipt-pdf-pages-report.js reads the same sources
// from a read-only database. The verdicts themselves are lib/receipt-page-verdict.js.
//
// receipt_pdf_pages: one row per page of a PDF receipt file (expense, file
// sha256, page): its verdict code, every code that applied, the roster hash it
// was made under, and the Super Admin's mark (released / office, the OTHER_*
// codes a "Release anyway" acknowledged, a reason code, a staff-only note, who
// and when; mark_lapsed_at when a later verdict found a code the mark had not
// acknowledged). Codes only: no names, numbers or excerpts. A changed file
// (new sha256) starts with no rows and no marks.
//
// invoice_pdf_renders: one row per invoice PDF written with copied receipt
// pages: the file's name and sha256, its page count and how many of them are
// the invoice's own, and per receipt the expense, the receipt file's sha256,
// the source pages copied, how many were kept by the office, its sheet and the
// pages it occupies. The stored file's sha256 says which row describes it; the
// pages-only path works from these rows, never from the live Personal lines.

const { cardLast4sFromDetails } = require("./receipt-page-verdict");

const SCHEMA_SQL = `
	CREATE TABLE IF NOT EXISTS receipt_pdf_pages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		expense_id INTEGER NOT NULL,
		file_sha256 TEXT NOT NULL,
		page INTEGER NOT NULL,
		page_count INTEGER NOT NULL,
		verdict_code TEXT NOT NULL,
		reason_codes TEXT NOT NULL DEFAULT '',
		roster_hash TEXT NOT NULL,
		decided_at TEXT NOT NULL,
		mark TEXT NOT NULL DEFAULT '',
		mark_codes TEXT NOT NULL DEFAULT '',
		mark_reason TEXT NOT NULL DEFAULT '',
		mark_note TEXT NOT NULL DEFAULT '',
		marked_by TEXT NOT NULL DEFAULT '',
		marked_by_id INTEGER NOT NULL DEFAULT 0,
		marked_at TEXT NOT NULL DEFAULT '',
		mark_lapsed_at TEXT NOT NULL DEFAULT '',
		UNIQUE (expense_id, file_sha256, page)
	);
	CREATE INDEX IF NOT EXISTS idx_receipt_pdf_pages_expense ON receipt_pdf_pages(expense_id);
	CREATE TABLE IF NOT EXISTS invoice_pdf_renders (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		pdf_file_name TEXT NOT NULL,
		pdf_sha256 TEXT NOT NULL,
		invoice_id INTEGER,
		driver_key TEXT NOT NULL DEFAULT '',
		total_pages INTEGER NOT NULL,
		invoice_pages INTEGER NOT NULL,
		receipts TEXT NOT NULL,
		roster_hash TEXT NOT NULL DEFAULT '',
		cause TEXT NOT NULL DEFAULT 'render',
		original_file TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_invoice_pdf_renders_file ON invoice_pdf_renders(pdf_file_name, pdf_sha256);
`;

// Every driver name the app holds (accounts, the directory, expense and
// document rows, truck assignments and carrier history), every truck's unit,
// plate and VIN, and the card last-4s on receipts' stored OCR fields with
// their drivers. A table this database does not have adds nothing.
function rosterSources(db) {
	const rows = (sql) => {
		try { return db.prepare(sql).all(); } catch { return []; }
	};
	const people = [];
	for (const r of rows("SELECT driver_name, full_name FROM users WHERE role = 'Driver'")) people.push(r.driver_name, r.full_name);
	for (const r of rows("SELECT driver_name FROM drivers_directory")) people.push(r.driver_name);
	for (const r of rows("SELECT DISTINCT driver FROM expenses")) people.push(r.driver);
	for (const r of rows("SELECT DISTINCT driver FROM documents")) people.push(r.driver);
	for (const r of rows("SELECT DISTINCT driver_name FROM truck_assignments")) people.push(r.driver_name);
	for (const r of rows("SELECT DISTINCT driver_name FROM carrier_driver_history")) people.push(r.driver_name);
	const trucks = rows("SELECT unit_number, license_plate, vin, assigned_driver FROM trucks");
	for (const t of trucks) people.push(t.assigned_driver);
	const cards = [];
	for (const r of rows("SELECT driver, receipt_details FROM expenses WHERE COALESCE(receipt_details, '') != ''")) {
		for (const last4 of cardLast4sFromDetails(r.receipt_details)) cards.push({ last4, driver: r.driver });
	}
	return {
		people: people.filter((p) => typeof p === "string" && p.trim()),
		trucks: trucks.map((t) => ({ unit: t.unit_number, plate: t.license_plate, vin: t.vin })),
		cards,
	};
}

// The pages-only path's check (approved invoices are locked): every page that
// is not a copied receipt page must read exactly the same, page for page,
// before and after the rebuild. before / after: { texts: [{ text, unmapped,
// truncated }], receipt: [indexes of the receipt pages] }. { ok } or
// { ok: false, code, page }.
function invoicePagesUnchanged(before, after) {
	const own = (side) => {
		const skip = new Set(side && Array.isArray(side.receipt) ? side.receipt : []);
		return (side && Array.isArray(side.texts) ? side.texts : []).filter((_, i) => !skip.has(i));
	};
	const a = own(before);
	const b = own(after);
	if (!a.length) return { ok: false, code: "NO_INVOICE_PAGES" };
	if (a.length !== b.length) return { ok: false, code: "PAGE_COUNT" };
	for (let i = 0; i < a.length; i++) {
		if (!a[i] || !b[i] || a[i].truncated || b[i].truncated) return { ok: false, code: "TEXT_UNREADABLE", page: i + 1 };
		if (a[i].text !== b[i].text || !!a[i].unmapped !== !!b[i].unmapped) return { ok: false, code: "TEXT_MISMATCH", page: i + 1 };
	}
	return { ok: true };
}

// A render row's receipts, checked (the column is our own JSON).
function renderReceipts(row) {
	let list;
	try { list = JSON.parse((row && row.receipts) || "[]"); } catch { return []; }
	if (!Array.isArray(list)) return [];
	const ints = (v) => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n >= 0) : []);
	return list.filter((r) => r && Number.isInteger(r.expense_id)).map((r) => ({
		expense_id: r.expense_id,
		file_sha256: typeof r.file_sha256 === "string" ? r.file_sha256 : "",
		pages: ints(r.pages),
		withheld: Number.isInteger(r.withheld) && r.withheld >= 0 ? r.withheld : 0,
		anchor: typeof r.anchor === "string" ? r.anchor : "",
		index: Number(r.index),
		total: Number(r.total),
		sheet: Number.isInteger(r.sheet) ? r.sheet : -1,
		at: ints(r.at),
	}));
}

module.exports = { SCHEMA_SQL, rosterSources, invoicePagesUnchanged, renderReceipts };
