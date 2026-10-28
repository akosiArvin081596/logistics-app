#!/usr/bin/env node
/**
 * scripts/data-fix-personal-corrections.js, the one-off fix for the receipt's
 * week rule (PERSONAL_RECEIPT_WEEK_ENABLED): a Personal correction invoice still
 * open (Draft, Submitted, Rejected) gives its lines back to the carried queue,
 * so the driver's next weekly invoice repays them, and is soft-deleted; an
 * Approved, Processing or Paid one is final and stays. Run through its command
 * line on file databases the flag-off code builds in the Personal world
 * (scripts/lib/personal-world.js, made-up data):
 *   node scripts/data-fix-personal-corrections.js --db=<file> --report | --dry-run | --apply --expect-lines=<n>
 *
 *   §1 it exists and refuses (exit 2, nothing written): no mode or two, an
 *      apply without --expect-lines or expecting another count than the run
 *      makes, a database outside the app and temp directories
 *   §2 --report and --dry-run write nothing
 *   §3 --apply: each Draft, Submitted and Rejected correction's lines unlinked
 *      and stamped carried (their week kept), the correction soft-deleted, an
 *      audit row for it and for each line's receipt as a system change; the
 *      Approved, Processing and Paid ones and their lines untouched
 *   §4 a second run changes nothing
 *   §5 skipped and logged, untouched: a correction whose total does not match
 *      its lines, one holding a reversed line, one in a week touching a closed
 *      month; the run still re-queues the plain one beside them
 *
 * Pure: a temp directory and child processes of the script itself; no server,
 * no app.db, no network.
 * Run: node scripts/test-data-fix-personal-corrections.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildPersonalWorld, makeChecker, edt, DRIVER_A, DRIVER_B, OWNER_OP, ROOT } = require("./lib/personal-world");
const { check, section, finish } = makeChecker();
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));

const SCRIPT = path.join(__dirname, "data-fix-personal-corrections.js");
const ON = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" };
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "personal-corrections-"));

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
	cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || "" },
});
// The line of a run's output that says what went wrong, for a failing check's label.
function said(r) {
	const lines = `${r.stderr || ""}\n${r.stdout || ""}`.split("\n").map((s) => s.trim().split(`${ROOT}${path.sep}`).join("")).filter(Boolean);
	return (lines.find((l) => /error|refus/i.test(l)) || lines[0] || "").slice(0, 160);
}
const hint = (r, ok) => (ok ? "" : ` [exit ${r.status}: ${said(r)}]`);

// Everything the fix may touch, as stored.
function read(file) {
	const db = new Database(file, { readonly: true, fileMustExist: true });
	try {
		const all = (sql) => db.prepare(sql).all();
		return {
			invoices: new Map(all("SELECT * FROM invoices ORDER BY id").map((r) => [r.id, r])),
			lines: all("SELECT * FROM expense_personal ORDER BY id"),
			audits: all("SELECT * FROM audit_trail ORDER BY id"),
			dump: ["invoices", "expense_personal", "audit_trail", "expenses", "period_locks"].map((t) => JSON.stringify(all(`SELECT * FROM ${t} ORDER BY rowid`))).join("\n"),
		};
	} finally {
		db.close();
	}
}
const linesOn = (state, invoiceId) => state.lines.filter((l) => l.invoice_id === invoiceId);
const sameLines = (state, was) => was.map((l) => state.lines.find((x) => x.id === l.id) || null);

const mark = (w, id) => w.call("POST", `/api/expenses/${id}/personal`, { body: {} });
const approve = (w, id) => w.db.prepare("UPDATE invoices SET status = 'Approved', approved_at = 't', approved_by = 'super_admin' WHERE id = ?").run(id);
const setStatus = (w, id, status) => w.db.prepare("UPDATE invoices SET status = ? WHERE id = ?").run(status, id);
const correctionOf = (w, weeklyId) => (w.db.prepare("SELECT id FROM invoices WHERE is_correction = 1 AND correction_of = ? AND deleted_at = ''").get(weeklyId) || {}).id || null;
// A load delivered in W42, copied from Driver A's row.
const addW42Load = (w, loadId) => w.sheet.rows.push(w.sheet.rows[1].map((v, i) =>
	({ 1: loadId, 6: "10/19/2026 8:00", 9: "10/20/2026 10:00", 20: "10/19/2026", 21: "10/20/2026", 22: "10/20/2026" })[i] ?? v));
// An approved weekly invoice, marked: the flag-off code makes that week's correction.
async function correctionFor(w, driver, weekEnd, expenseIds) {
	const g = await w.generate(driver, weekEnd);
	const weekly = g.body && g.body.invoice ? g.body.invoice.id : null;
	if (weekly) approve(w, weekly);
	for (const id of expenseIds) await mark(w, id);
	return weekly ? correctionOf(w, weekly) : null;
}
function save(w, name) {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, w.db.serialize());
	w.cleanup();
	return file;
}

// Six corrections, one per status: Draft (two lines), Submitted, Rejected
// re-queued (four lines in all); Approved, Processing, Paid final.
async function mainFixture() {
	const w = buildPersonalWorld({ env: ON });
	const ids = {};
	w.setNow(edt("2026-10-08", 12));
	ids.approved = await correctionFor(w, DRIVER_A, "2026-10-09", [6]);
	ids.processing = await correctionFor(w, OWNER_OP, "2026-10-09", [10]);
	w.setNow(edt("2026-10-15", 12));
	ids.draft = await correctionFor(w, DRIVER_A, "2026-10-16", [1, 5]);
	ids.submitted = await correctionFor(w, DRIVER_B, "2026-10-16", [11]);
	ids.rejected = await correctionFor(w, OWNER_OP, "2026-10-16", [8]);
	w.setNow(edt("2026-10-22", 12));
	addW42Load(w, "L7");
	ids.paid = await correctionFor(w, DRIVER_A, "2026-10-23", [2]);
	for (const [key, status] of [["submitted", "Submitted"], ["rejected", "Rejected"], ["approved", "Approved"], ["processing", "Processing"], ["paid", "Paid"]]) {
		if (ids[key]) setStatus(w, ids[key], status);
	}
	return { file: save(w, "main.db"), ids };
}

// Three Draft corrections the fix cannot be sure of, and a plain one.
async function skipFixture() {
	const w = buildPersonalWorld({ env: ON });
	const ids = {};
	// Made while September was open, for the week of Sep 26 - Oct 2; September
	// was finalized after it.
	w.db.prepare("DELETE FROM period_locks WHERE period = '2026-09'").run();
	w.setNow(edt("2026-10-01", 12));
	const w39 = Number(w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data)
		VALUES ('INV-TOO-2026W39-01', 'test owner op', '2026-09-26', '2026-10-02', 1, 25, 500, 'Approved', 'INV-TOO-2026W39-01.pdf', ?)`)
		.run(JSON.stringify({ __templateName: "service_invoice_owner_op", totalEarnings: 500 })).lastInsertRowid);
	await mark(w, 9);
	ids.closedWeek = correctionOf(w, w39);
	w.db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-09', 'locked', '2026-10-08T04:00:00.000Z', 'test')").run();
	w.setNow(edt("2026-10-15", 12));
	ids.mismatch = await correctionFor(w, DRIVER_A, "2026-10-16", [1]);
	if (ids.mismatch) w.db.prepare("UPDATE invoices SET personal_total = 201 WHERE id = ?").run(ids.mismatch);
	ids.reversed = await correctionFor(w, DRIVER_B, "2026-10-16", [11]);
	const deduct = w.lines("expense_id = 11 AND kind = 'deduct'")[0];
	if (deduct) {
		const rev = w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, reverses_id, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
			VALUES (11, 'reverse', ?, 3000, 3000, 'Diner #2', '2026-10-13', '2026-10', 1, '2026-10-13', '2026-10-10', 't', 'super_admin', 1, 'Super Admin')`).run(deduct.id).lastInsertRowid;
		w.db.prepare("UPDATE expense_personal SET reversed_by_id = ? WHERE id = ?").run(rev, deduct.id);
	}
	w.setNow(edt("2026-10-22", 12));
	addW42Load(w, "L7");
	ids.plain = await correctionFor(w, DRIVER_A, "2026-10-23", [2]);
	return { file: save(w, "skips.db"), ids };
}

(async () => {
	section("§1 the command line");
	check("the script exists: scripts/data-fix-personal-corrections.js", fs.existsSync(SCRIPT), true);
	const { file, ids } = await mainFixture();
	const before = read(file);
	check("setup: the flag-off code made the six corrections, four lines on the open three",
		[Object.values(ids).every((id) => before.invoices.has(id)), [ids.draft, ids.submitted, ids.rejected].reduce((n, id) => n + linesOn(before, id).length, 0)], [true, 4]);
	const outside = path.join(ROOT, "scripts", "app.db");
	for (const [name, args] of [
		["no mode", [`--db=${file}`]],
		["two modes", [`--db=${file}`, "--report", "--apply", "--expect-lines=4"]],
		["an apply without --expect-lines", [`--db=${file}`, "--apply"]],
		["an apply expecting another count than the run makes", [`--db=${file}`, "--apply", "--expect-lines=3"]],
		["a database outside the app directory and the temp directory", [`--db=${outside}`, "--dry-run"]],
	]) {
		const r = run(...args);
		check(`refuses ${name}: exit 2, nothing written${hint(r, r.status === 2)}`, [r.status, read(file).dump === before.dump], [2, true]);
	}
	check("…and no database was made outside the temp directory", fs.existsSync(outside), false);

	section("§2 --report and --dry-run write nothing");
	for (const mode of ["--report", "--dry-run"]) {
		const r = run(`--db=${file}`, mode);
		check(`${mode}: exit 0, the database unchanged${hint(r, r.status === 0)}`, [r.status, read(file).dump === before.dump], [0, true]);
	}

	section("§3 --apply re-queues the open corrections' lines and soft-deletes them");
	const applied = run(`--db=${file}`, "--apply", "--expect-lines=4");
	check(`--apply --expect-lines=4: exit 0${hint(applied, applied.status === 0)}`, applied.status, 0);
	const after = read(file);
	const lastAudit = before.audits.reduce((m, a) => Math.max(m, a.id), 0);
	const systemRows = (entity, entityId) => after.audits.filter((a) => a.id > lastAudit && a.entity === entity && String(a.entity_id) === String(entityId)
		&& a.role === "system" && Number(a.user_id) === 0).length;
	for (const [status, id] of [["Draft", ids.draft], ["Submitted", ids.submitted], ["Rejected", ids.rejected]]) {
		const was = linesOn(before, id);
		check(`the ${status} correction is soft-deleted`, !!(after.invoices.get(id) || {}).deleted_at, true);
		check(`…its ${was.length} line(s) on no invoice, stamped carried, each keeping its week`,
			sameLines(after, was).map((l) => l && [l.invoice_id, !!l.needs_correction_since, l.week_start, l.voided_at]),
			was.map((l) => [null, true, l.week_start, ""]));
		check("…an audit row for the invoice and for each line's receipt, as a system change",
			[systemRows("invoice", id) > 0, was.every((l) => systemRows("expense", l.expense_id) > 0)], [true, true]);
	}
	for (const [status, id] of [["Approved", ids.approved], ["Processing", ids.processing], ["Paid", ids.paid]]) {
		const was = linesOn(before, id);
		check(`the ${status} correction and its line untouched`, [after.invoices.get(id), sameLines(after, was)], [before.invoices.get(id), was]);
	}

	section("§4 a second run changes nothing");
	{
		const same = run(`--db=${file}`, "--apply", "--expect-lines=4");
		check(`the same apply again: refused or done, nothing written${hint(same, [0, 2].includes(same.status))}`,
			[[0, 2].includes(same.status), read(file).dump === after.dump], [true, true]);
		const none = run(`--db=${file}`, "--apply", "--expect-lines=0");
		check(`--apply --expect-lines=0: exit 0, nothing written${hint(none, none.status === 0)}`, [none.status, read(file).dump === after.dump], [0, true]);
	}

	section("§5 skipped and logged: what the run cannot be sure of stays as it is");
	{
		const s = await skipFixture();
		const sBefore = read(s.file);
		check("setup: four Draft corrections", Object.values(s.ids).map((id) => (sBefore.invoices.get(id) || {}).status), ["Draft", "Draft", "Draft", "Draft"]);
		const r = run(`--db=${s.file}`, "--apply", "--expect-lines=1");
		const sAfter = read(s.file);
		check(`--apply --expect-lines=1: exit 0, and it says what it skipped${hint(r, r.status === 0)}`, [r.status, /skip/i.test(`${r.stdout}\n${r.stderr}`)], [0, true]);
		for (const [why, id] of [["a total that does not match its line", s.ids.mismatch], ["a reversed line", s.ids.reversed], ["a week touching closed September", s.ids.closedWeek]]) {
			const was = linesOn(sBefore, id);
			check(`skipped, untouched: the correction with ${why}`, [sAfter.invoices.get(id), sameLines(sAfter, was)], [sBefore.invoices.get(id), was]);
		}
		check("…the reversal row stays as it was", sAfter.lines.filter((l) => l.kind === "reverse"), sBefore.lines.filter((l) => l.kind === "reverse"));
		const plain = linesOn(sBefore, s.ids.plain);
		check("…while the plain correction beside them is re-queued and soft-deleted",
			[!!(sAfter.invoices.get(s.ids.plain) || {}).deleted_at, sameLines(sAfter, plain).map((l) => l && [l.invoice_id, !!l.needs_correction_since])],
			[true, plain.map(() => [null, true])]);
	}

	fs.rmSync(tmp, { recursive: true, force: true });
	finish();
})().catch((e) => {
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ }
	console.error(e && e.stack || e);
	process.exit(1);
});
