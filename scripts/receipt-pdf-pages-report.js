#!/usr/bin/env node
/**
 * Driver privacy PR B: what switching RECEIPT_PDF_PAGES_ENABLED on would change
 * (the read-only "what would change" report, hard rule 3). Read-only: the
 * database is opened with { readonly, fileMustExist }, the receipt files are
 * only read (each PDF by the locked-down child, lib/receipt-pdf.js), and
 * nothing is written anywhere. It prints ids and counts only: expense ids,
 * invoice ids and statuses, page counts and verdict codes; never a name, an
 * amount, a file name or any text of a page.
 *
 * Per PDF receipt it makes the same verdicts the server makes
 * (lib/receipt-page-verdict.js on the roster from lib/receipt-page-privacy.js).
 * With the flag off no stored invoice PDF holds a copied receipt page, so the
 * switch rewrites no stored file; the pages that reach a driver after it are
 * the AUTO_RELEASED ones, on each invoice's next render, until a Super Admin
 * marks more.
 *
 *   node scripts/receipt-pdf-pages-report.js --db <path to app.db> --receipts-dir <uploads/expense-receipts folder> [--json] [--all]
 *
 * --all adds every PDF receipt's codes, page by page (expense id and codes
 * only): the pre-merge census compares them with another reader's findings.
 * Both paths are required (no default: a script never defaults to production's
 * files). Exits 2 on a usage error, 1 on a failure, 0 otherwise.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const receiptPdfLib = require("../lib/receipt-pdf");
const { buildRoster, pageVerdict, releasedPages, CODES } = require("../lib/receipt-page-verdict");
const { rosterSources } = require("../lib/receipt-page-privacy");
const { isPdfReceiptRef } = require("../lib/receipt-files");
const { receiptCents } = require("../lib/personal-expense");

const OPEN_STATUSES = new Set(["Draft", "Submitted", "Rejected"]);

function args(argv) {
	const out = { db: "", receiptsDir: "", json: false, all: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--db") out.db = argv[++i] || "";
		else if (argv[i] === "--receipts-dir") out.receiptsDir = argv[++i] || "";
		else if (argv[i] === "--json") out.json = true;
		else if (argv[i] === "--all") out.all = true;
		else return null;
	}
	return out.db && out.receiptsDir ? out : null;
}

const rowsOf = (db, sql, ...params) => {
	try { return db.prepare(sql).all(...params); } catch { return []; }
};
const tally = (list) => list.reduce((m, k) => { m[k] = (m[k] || 0) + 1; return m; }, {});
const tallyText = (t) => Object.entries(t).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ") || "none";

async function main() {
	const opts = args(process.argv.slice(2));
	if (!opts) {
		console.error("usage: node scripts/receipt-pdf-pages-report.js --db <app.db> --receipts-dir <expense-receipts folder> [--json]");
		process.exit(2);
	}
	const dbPath = path.resolve(opts.db);
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	const roster = buildRoster(rosterSources(db));
	// The child's self-test needs two paths it must not be able to read; the
	// database serves as both. The cache folder is never created: nothing here prepares pages.
	const service = receiptPdfLib.createReceiptPdfService({
		receiptsDir: path.resolve(opts.receiptsDir),
		cacheDir: path.join(os.tmpdir(), `receipt-pdf-report-${process.pid}-never-written`),
		probes: { env: dbPath, db: dbPath },
	});
	const self = await service.selfTest();
	if (!self || !self.passed) {
		console.error(`the PDF reader's self-test did not pass (${(self && self.problems || []).join(" ") || "unknown"}); no verdict made`);
		process.exit(1);
	}

	const personal = new Map();
	for (const r of rowsOf(db, `SELECT ep.expense_id, ep.invoice_id, i.status, COALESCE(i.deleted_at, '') AS deleted_at FROM expense_personal ep
		LEFT JOIN invoices i ON i.id = ep.invoice_id WHERE ep.voided_at = '' ORDER BY ep.expense_id, ep.invoice_id`)) {
		if (!personal.has(r.expense_id)) personal.set(r.expense_id, new Map());
		if (r.invoice_id != null && !r.deleted_at) personal.get(r.expense_id).set(r.invoice_id, r.status || "");
	}

	const receipts = rowsOf(db, "SELECT id, driver, amount, date, vendor, truck_unit, photo_data FROM expenses ORDER BY id").filter((e) => isPdfReceiptRef(e.photo_data));
	const report = {
		roster: { people: roster.people.length, trucks: roster.trucks.length, cards: roster.cards.size, hash: roster.hash.slice(0, 12) },
		pdfReceipts: receipts.length,
		unreadable: {},
		pages: {},
		personal: [],
		openInvoicesWithReleasedPages: [],
		pagesNeedingAMark: 0,
		renderRecords: rowsOf(db, "SELECT COUNT(*) AS n FROM invoice_pdf_renders").map((r) => r.n)[0] ?? null,
		marks: rowsOf(db, "SELECT COUNT(*) AS n FROM receipt_pdf_pages WHERE mark != ''").map((r) => r.n)[0] ?? null,
		...(opts.all ? { receipts: [] } : {}),
	};
	for (const e of receipts) {
		const texts = await service.pageTexts({ expenseId: e.id, photoData: e.photo_data });
		const isPersonal = personal.has(e.id);
		if (texts.status !== "text") {
			const reason = texts.reason || texts.status;
			report.unreadable[reason] = (report.unreadable[reason] || 0) + 1;
			if (opts.all) report.receipts.push({ expense: e.id, unreadable: reason });
			if (isPersonal) report.personal.push({ expense: e.id, pages: 0, unreadable: reason, codes: {}, autoReleased: 0, invoices: [...personal.get(e.id)].map(([id, status]) => ({ id, status })) });
			continue;
		}
		const receipt = { driver: e.driver, truck: e.truck_unit, amountCents: receiptCents(e.amount), date: e.date, vendor: e.vendor, pageCount: texts.pageCount };
		const verdicts = texts.pages.map((p) => pageVerdict(p, roster, receipt));
		for (const v of verdicts) report.pages[v.code] = (report.pages[v.code] || 0) + 1;
		if (opts.all) report.receipts.push({ expense: e.id, codes: verdicts.map((v) => v.code), reasons: verdicts.map((v) => v.reasons) });
		if (!isPersonal) continue;
		// No mark exists before the switch: what reaches the driver is AUTO_RELEASED.
		const rows = verdicts.map((v, i) => ({ page: i + 1, file_sha256: texts.sha256, roster_hash: roster.hash, verdict_code: v.code, reason_codes: v.reasons.join(","), mark: "", mark_codes: "", mark_lapsed_at: "" }));
		const released = releasedPages(rows, { sha256: texts.sha256, rosterHash: roster.hash });
		const invoices = [...personal.get(e.id)].map(([id, status]) => ({ id, status }));
		report.pagesNeedingAMark += verdicts.length - released.length;
		if (released.length) for (const inv of invoices) if (OPEN_STATUSES.has(inv.status) && !report.openInvoicesWithReleasedPages.includes(inv.id)) report.openInvoicesWithReleasedPages.push(inv.id);
		report.personal.push({ expense: e.id, pages: verdicts.length, codes: tally(verdicts.map((v) => v.code)), autoReleased: released.length, invoices });
	}
	db.close();

	if (opts.json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	const lines = [
		"receipt PDF pages: what RECEIPT_PDF_PAGES_ENABLED would change (read-only; ids and counts only)",
		`roster: ${report.roster.people} people, ${report.roster.trucks} trucks, ${report.roster.cards} card last-4s (hash ${report.roster.hash})`,
		`PDF receipts on file: ${report.pdfReceipts}; refused by the reader: ${tallyText(report.unreadable)}`,
		`their pages by verdict: ${tallyText(report.pages)}`,
		`Personal PDF receipts (live lines): ${report.personal.length}`,
		...report.personal.map((p) => `  expense ${p.expense}: ${p.unreadable ? `unreadable (${p.unreadable})` : `${p.pages} pages, ${tallyText(p.codes)}; auto-released ${p.autoReleased}`}`
			+ `; invoices ${p.invoices.map((i) => `${i.id} (${i.status || "unknown"})`).join(", ") || "none yet"}`),
		`pages a Super Admin must mark before they can reach a driver: ${report.pagesNeedingAMark}`,
		`open invoices whose next render would carry released PDF pages: ${report.openInvoicesWithReleasedPages.join(", ") || "none"}`,
		`stored invoice PDFs rewritten at the switch: 0 (render records now: ${report.renderRecords === null ? "table not there yet" : report.renderRecords}; page marks now: ${report.marks === null ? "table not there yet" : report.marks})`,
		...(opts.all ? report.receipts.map((r) => `  receipt ${r.expense}: ${r.unreadable ? `unreadable (${r.unreadable})` : r.codes.map((c, i) => `p${i + 1} ${c}`).join(", ")}`) : []),
		`codes: ${Object.values(CODES).join(", ")}`,
	];
	console.log(lines.join("\n"));
}

main().catch((err) => {
	console.error(`receipt PDF pages report failed: ${err && err.message}`);
	process.exit(1);
});
