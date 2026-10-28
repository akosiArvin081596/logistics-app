#!/usr/bin/env node
// scripts/data-fix-personal-corrections.js — the read-only report and the
// one-off fix for switching on the receipt's week rule for Personal lines
// (PERSONAL_RECEIPT_WEEK_ENABLED; server.js's PERSONAL RECEIPTS section). Under
// that rule no correction invoice is made: a line its week's invoice cannot take
// is carried to the driver's next weekly invoice.
//
//   --report    read-only, before the flag goes on: what it would change, in
//               counts and amounts, no names (a line and an invoice are named by
//               their ids):
//                 1. waiting lines keyed to another week than their receipt's
//                    (they keep it), by the state of their receipt week's invoice
//                 2. flagged lines (carried, once the flag is on), and the lines
//                    --apply re-queues, with the open invoice each would go on
//                    and its total due before and after
//                 3. live correction invoices by status
//                 4. lines with no receipt date, or one after today
//                 5. lines that offer Reverse today, by why; those on an approved
//                    invoice lose it
//               then what --apply would do.
//   --dry-run   read-only: what --apply would write, and what it would skip.
//   --apply --expect-lines=<n>
//               writes it, only when the run re-queues exactly n lines (the
//               count the dry run printed); any other count writes nothing.
//
// What --apply writes, in one transaction: each live correction invoice still
// open (Draft, Submitted, Rejected) gives its lines back to the carried queue,
// unlinked and stamped carried (needs_correction_since), each keeping its week;
// the empty correction is soft-deleted. An audit row for each line's receipt and
// for the invoice, as a system change (user 0, this script, role "system").
// Approved, Processing and Paid corrections are final: listed, untouched.
// Skipped and printed, untouched: a correction whose Personal totals do not
// match its lines, one holding a voided or reversed line or a reversal, one
// whose week touches a finalized month (or when no month can be confirmed open),
// one with no line. A second run finds nothing to re-queue.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with,
// APP_TIMEZONE as the server has it: Eastern unless set):
//   node scripts/data-fix-personal-corrections.js --db=app.db --report
//   node scripts/data-fix-personal-corrections.js --db=app.db --dry-run
//   node scripts/data-fix-personal-corrections.js --db=app.db --apply --expect-lines=<n>
//   --db   app.db in this app directory, or a copy under the temp directory
//          (scripts/lib/ledger-world.js dbScope()); no settings file is read
// An apply that writes first backs the database up next to it
// (<db>.pre-personal-corrections-<UTC time>, owner-only).
// Exit codes: 0 done (or nothing to do), 1 error (nothing written), 2 refused
// (nothing written).
//
// Required as a module (by its test runner) it runs nothing and exports its parts.

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { dbScope } = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");
const ACTOR = "script:data-fix-personal-corrections";
const OPEN = new Set(["Draft", "Submitted", "Rejected"]);
const FINAL = new Set(["Approved", "Processing", "Paid"]);
const DELETE_REASON = "Personal correction invoices are retired: its lines wait for the driver's next weekly invoice";
const ROOTS = ["invoiceMonthLockBlockers", "personalUndoBlocker", "personalWeekState", "personalOpenInvoicesFrom", "personalRoomCents",
	"getWeekRange", "appTodayKey", "invoiceTotalDue", "normalizeDriverName"];
const PROVIDED = ["db", "require", "console", "process", "Date"];
const DENIED = ["getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "transporter", "getDrive", "sendEmail", "fetch", "io", "app"];
const appRequire = createRequire(path.join(ROOT, "server.js"));
const personalExpense = appRequire("./lib/personal-expense");

class Refusal extends Error {}

// --db=<file> and exactly one of --report, --dry-run, --apply; --expect-lines
// only with --apply, which needs it.
function parseCli(argv) {
	const out = { db: "", modes: [], expectLines: null };
	for (const a of argv) {
		const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
		if (!m) throw new Refusal(`unknown argument ${JSON.stringify(a)}`);
		const [, name, value] = m;
		if (name === "db" && value) out.db = value;
		else if (["report", "dry-run", "apply"].includes(name) && value === undefined) out.modes.push(name);
		else if (name === "expect-lines" && /^\d{1,6}$/.test(value || "")) out.expectLines = Number(value);
		else throw new Refusal(`unknown option ${JSON.stringify(a)}`);
	}
	if (!out.db) throw new Refusal("--db is required");
	if (out.modes.length !== 1) throw new Refusal("give exactly one of --report, --dry-run, --apply");
	if (out.modes[0] === "apply" && out.expectLines === null) throw new Refusal("--apply needs --expect-lines=<n>, the count the dry run printed");
	if (out.modes[0] !== "apply" && out.expectLines !== null) throw new Refusal("--expect-lines goes with --apply only");
	return { db: out.db, mode: out.modes[0], expectLines: out.expectLines };
}

// The server's own rules, lifted from this checkout's server.js onto `db`.
function liftServer(db) {
	const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	const lifted = closure(src, { roots: ROOTS, provided: PROVIDED, denied: DENIED });
	const liftedRequire = (m) => {
		if (m === "crypto" || /^\.\/lib\/[\w.-]+$/.test(m)) return appRequire(m);
		throw new Error(`lifted code required ${m}, which this script does not load`);
	};
	const quiet = { log() {}, info() {}, warn() {}, error: (...a) => console.error(...a) };
	const scriptProcess = { env: {}, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } };
	const body = ['"use strict";', lifted.text, `return { ${ROOTS.join(", ")} };`].join("\n");
	return new Function(...PROVIDED, body)(db, liftedRequire, quiet, scriptProcess, Date);
}

const money = (cents) => personalExpense.formatMoney(cents);
const signed = (cents) => personalExpense.signedMoney(cents);
const sumNet = (rows) => rows.reduce((s, r) => s + personalExpense.netCents(r), 0);

function hasLedger(db) {
	const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'expense_personal'").get();
	const cols = new Set(db.prepare("PRAGMA table_info(invoices)").all().map((c) => c.name));
	return !!table && cols.has("is_correction") && cols.has("personal_total") && cols.has("personal_share_total");
}

// Each live correction invoice and what the fix does with it.
function planFix(db, api) {
	const plan = { requeue: [], final: [], skipped: [] };
	if (!hasLedger(db)) return plan;
	const linesOf = db.prepare("SELECT * FROM expense_personal WHERE invoice_id = ? ORDER BY id");
	for (const inv of db.prepare("SELECT * FROM invoices WHERE is_correction = 1 AND deleted_at = '' ORDER BY id").all()) {
		const rows = linesOf.all(inv.id);
		const entry = { invoiceId: inv.id, invoiceNumber: inv.invoice_number, status: inv.status, weekStart: inv.week_start, rows, netCents: sumNet(rows) };
		const skip = (why) => plan.skipped.push({ ...entry, why });
		if (FINAL.has(inv.status)) { plan.final.push(entry); continue; }
		if (!OPEN.has(inv.status)) { skip(`its status is ${inv.status}`); continue; }
		if (!rows.length) { skip("it carries no Personal line"); continue; }
		if (rows.some((r) => r.voided_at !== "" || r.kind !== "deduct" || r.reversed_by_id != null)) { skip("it holds a voided or reversed line, or a reversal"); continue; }
		const totals = personalExpense.invoiceLines(rows, () => "");
		if (totals.personalTotalCents !== Math.round((Number(inv.personal_total) || 0) * 100)
			|| totals.shareTotalCents !== Math.round((Number(inv.personal_share_total) || 0) * 100)) {
			skip("its Personal totals do not match its lines");
			continue;
		}
		const lock = api.invoiceMonthLockBlockers(inv);
		if (lock.unreadable) { skip("no month can be confirmed open (the period lock table could not be read)"); continue; }
		if (lock.blockers.length) { skip("its week touches a finalized month"); continue; }
		plan.requeue.push(entry);
	}
	return plan;
}
const planLines = (plan) => plan.requeue.reduce((n, c) => n + c.rows.length, 0);

// The writes, in one immediate transaction that plans again first: the count
// must still be the one expected.
function applyFix(db, api, expectLines) {
	return db.transaction(() => {
		const plan = planFix(db, api);
		const lines = planLines(plan);
		if (lines !== expectLines) throw new Refusal(`the run would re-queue ${lines} line(s), not the ${expectLines} expected; nothing was written`);
		const stamp = new Date().toISOString();
		const unlink = db.prepare("UPDATE expense_personal SET invoice_id = NULL, needs_correction_since = ? WHERE id = ? AND invoice_id = ? AND voided_at = ''");
		const softDelete = db.prepare("UPDATE invoices SET deleted_at = ?, deleted_by = ?, delete_reason = ? WHERE id = ? AND deleted_at = ''");
		const audit = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'system', ?, ?, ?, ?)");
		for (const c of plan.requeue) {
			for (const r of c.rows) {
				if (unlink.run(stamp, r.id, c.invoiceId).changes !== 1) throw new Error(`line ${r.id} changed during the run; nothing was written`);
				audit.run(stamp, ACTOR, "requeue_personal_line", "expense", String(r.expense_id),
					`line ${r.id} (${money(r.cents)}) taken off ${c.invoiceNumber} (${c.status}): carried, it goes on the driver's next weekly invoice; week ${r.week_start} kept`);
			}
			if (softDelete.run(stamp, ACTOR, DELETE_REASON, c.invoiceId).changes !== 1) throw new Error(`${c.invoiceNumber} changed during the run; nothing was written`);
			audit.run(stamp, ACTOR, "delete_invoice", "invoice", String(c.invoiceId),
				`${c.invoiceNumber} (${c.status}) soft-deleted: Personal correction invoices are retired; its ${c.rows.length} line(s), ${signed(c.netCents)}, wait for the driver's next weekly invoice`);
		}
		return { plan, lines };
	}).immediate();
}

// The plan in print, ids and amounts only.
function planText(plan) {
	const out = [];
	const ids = (rows) => rows.map((r) => r.id).join(", ");
	out.push(`Correction invoices to re-queue: ${plan.requeue.length}, ${planLines(plan)} line(s), ${signed(plan.requeue.reduce((s, c) => s + c.netCents, 0))}`);
	for (const c of plan.requeue) out.push(`  invoice ${c.invoiceId} (${c.status}, week ${c.weekStart}): line(s) ${ids(c.rows)} carried, ${signed(c.netCents)}; the invoice soft-deleted`);
	out.push(`Final (Approved, Processing, Paid), untouched: ${plan.final.length}`);
	for (const c of plan.final) out.push(`  invoice ${c.invoiceId} (${c.status}, week ${c.weekStart}): ${c.rows.length} line(s), ${signed(c.netCents)}`);
	out.push(`Skipped, untouched: ${plan.skipped.length}`);
	for (const c of plan.skipped) out.push(`  skipped invoice ${c.invoiceId} (${c.status}, week ${c.weekStart}): ${c.why}`);
	return out;
}

// What switching the flag on would change (the --report sections).
function reportText(db, api) {
	const out = [];
	if (!hasLedger(db)) return ["No Personal ledger in this database: nothing would change."];
	const today = api.appTodayKey();
	const validDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) && !!personalExpense.formatDay(d);
	const offInvoice = `SELECT ep.*, e.driver AS receipt_driver FROM expense_personal ep LEFT JOIN expenses e ON e.id = ep.expense_id
		LEFT JOIN invoices i ON i.id = ep.invoice_id WHERE ep.voided_at = '' AND (ep.invoice_id IS NULL OR i.id IS NULL OR i.deleted_at != '')`;
	const histogram = (rows, keyOf) => {
		const m = new Map();
		for (const r of rows) {
			const k = keyOf(r);
			const v = m.get(k) || { n: 0, cents: 0 };
			v.n += 1;
			v.cents += r.cents;
			m.set(k, v);
		}
		return [...m].map(([k, v]) => `${k} ${v.n} (${money(v.cents)})`).join(", ") || "none";
	};

	const waiting = db.prepare(`${offInvoice} AND ep.needs_correction_since = '' AND ep.kind = 'deduct' AND ep.reversed_by_id IS NULL ORDER BY ep.id`).all();
	const moved = waiting.filter((r) => validDay(r.receipt_date) && r.receipt_date <= today && api.getWeekRange(r.receipt_date).weekStart !== r.week_start);
	out.push(`1. Waiting lines keyed to another week than their receipt's: ${moved.length} (${money(moved.reduce((s, r) => s + r.cents, 0))}); they keep their week`);
	out.push(`   their receipt week's invoice: ${histogram(moved, (r) => {
		const own = api.personalWeekState(String(r.receipt_driver || ""), api.getWeekRange(r.receipt_date).weekStart);
		return own.invoice ? `${own.kind} (${own.invoice.status})` : own.kind;
	})}`);

	const flagged = db.prepare(`${offInvoice} AND ep.needs_correction_since != '' AND ep.kind = 'deduct' AND ep.reversed_by_id IS NULL ORDER BY ep.id`).all();
	// The lines --apply re-queues go the same way as the flagged ones.
	const driverOf = db.prepare("SELECT driver FROM expenses WHERE id = ?");
	const requeued = planFix(db, api).requeue.flatMap((c) => c.rows.map((r) => ({ ...r, receipt_driver: (driverOf.get(r.expense_id) || {}).driver || "", from: c.invoiceId })));
	out.push(`2. Flagged lines, carried once the flag is on: ${flagged.length} (${money(flagged.reduce((s, r) => s + r.cents, 0))}); with the ${requeued.length} line(s) --apply re-queues:`);
	const byDriver = new Map();
	for (const r of [...flagged, ...requeued].sort((a, b) => a.id - b.id)) {
		const k = api.normalizeDriverName(String(r.receipt_driver || ""));
		if (!byDriver.has(k)) byDriver.set(k, []);
		byDriver.get(k).push(r);
	}
	for (const [key, lines] of byDriver) {
		if (!key) { for (const l of lines) out.push(`   line ${l.id} ${signed(personalExpense.netCents(l))}: its receipt names no driver; it stays carried`); continue; }
		const earliest = lines.reduce((m, l) => (l.week_start < m ? l.week_start : m), lines[0].week_start);
		const invoices = api.personalOpenInvoicesFrom(String(lines[0].receipt_driver || ""), earliest)
			.map((inv) => ({ inv, room: api.personalRoomCents(inv), before: api.invoiceTotalDue(inv), takes: 0 }));
		for (const l of lines) {
			const net = personalExpense.netCents(l);
			const from = l.from ? `, from correction invoice ${l.from}` : "";
			const t = invoices.find((x) => x.inv.week_start >= l.week_start && x.room + net >= 0);
			if (!t) { out.push(`   line ${l.id} ${signed(net)} (week ${l.week_start}${from}): no open invoice with room yet; it goes on the next weekly invoice generated`); continue; }
			t.room += net;
			t.takes += net;
			out.push(`   line ${l.id} ${signed(net)} (week ${l.week_start}${from}) -> invoice ${t.inv.id} (week ${t.inv.week_start}, ${t.inv.status})`);
		}
		for (const t of invoices.filter((x) => x.takes)) {
			out.push(`   invoice ${t.inv.id}: total due ${money(Math.round(t.before * 100))} -> ${money(Math.round(t.before * 100) + t.takes)}`);
		}
	}

	const corrections = db.prepare("SELECT * FROM invoices WHERE is_correction = 1 AND deleted_at = '' ORDER BY id").all();
	const corrLines = db.prepare("SELECT * FROM expense_personal WHERE invoice_id = ?");
	const byStatus = new Map();
	for (const c of corrections) {
		const v = byStatus.get(c.status) || { n: 0, lines: 0, cents: 0 };
		const rows = corrLines.all(c.id);
		v.n += 1;
		v.lines += rows.length;
		v.cents += sumNet(rows);
		byStatus.set(c.status, v);
	}
	out.push(`3. Live correction invoices: ${[...byStatus].map(([s, v]) => `${s} ${v.n} (${v.lines} line(s), ${signed(v.cents)})`).join(", ") || "none"}`);

	const liveLines = db.prepare("SELECT * FROM expense_personal WHERE kind = 'deduct' AND voided_at = '' AND reversed_by_id IS NULL ORDER BY id").all();
	const dateless = liveLines.filter((r) => !validDay(r.receipt_date));
	const future = liveLines.filter((r) => validDay(r.receipt_date) && r.receipt_date > today);
	out.push(`4. Lines with no receipt date: ${dateless.length} (${money(dateless.reduce((s, r) => s + r.cents, 0))}); dated after today: ${future.length} (${money(future.reduce((s, r) => s + r.cents, 0))})`);

	const reversible = liveLines.map((r) => ({ r, block: api.personalUndoBlocker(r) })).filter((x) => x.block);
	const lose = reversible.filter((x) => x.block.code === "PERSONAL_INVOICE_APPROVED");
	out.push(`5. Lines offering Reverse today: ${reversible.length} (${money(reversible.reduce((s, x) => s + x.r.cents, 0))}), by why: ${histogram(reversible.map((x) => ({ ...x.r, why: x.block.code })), (r) => r.why)}`);
	out.push(`   on an approved invoice, final with the flag on (no Reverse): ${lose.length} (${money(lose.reduce((s, x) => s + x.r.cents, 0))})`);
	return out;
}

async function main(argv) {
	let cli;
	let file;
	try {
		cli = parseCli(argv);
		({ file } = dbScope(cli.db, ROOT));
		if (!fs.existsSync(file)) throw new Refusal(`no database at ${cli.db}`);
	} catch (err) {
		console.error(`REFUSED: ${err.message}`);
		return 2;
	}
	const Database = appRequire("better-sqlite3");
	const readonly = cli.mode !== "apply";
	const db = new Database(file, { readonly, fileMustExist: true });
	try {
		if (readonly && !db.readonly) throw new Error("refusing: the read-only handle is not read-only");
		db.pragma("busy_timeout = 10000");
		const api = liftServer(db);
		if (cli.mode === "report") {
			console.log(["Personal lines and the receipt's week: what switching PERSONAL_RECEIPT_WEEK_ENABLED on would change (read-only, ids only)",
				...reportText(db, api), "", "What --apply would do:", ...planText(planFix(db, api))].join("\n"));
			return 0;
		}
		const plan = planFix(db, api);
		const lines = planLines(plan);
		if (cli.mode === "dry-run") {
			console.log([...planText(plan), "", `To write it: --apply --expect-lines=${lines}`].join("\n"));
			return 0;
		}
		if (lines !== cli.expectLines) throw new Refusal(`the run would re-queue ${lines} line(s), not the ${cli.expectLines} expected; nothing was written`);
		if (lines === 0) {
			console.log([...planText(plan), "", "Nothing to re-queue; nothing was written."].join("\n"));
			return 0;
		}
		const backup = `${file}.pre-personal-corrections-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
		await db.backup(backup);
		fs.chmodSync(backup, 0o600);
		const done = applyFix(db, api, cli.expectLines);
		console.log([...planText(done.plan), "", `Written: ${done.lines} line(s) re-queued, ${done.plan.requeue.length} correction(s) soft-deleted. Backup: ${path.basename(backup)}`].join("\n"));
		return 0;
	} catch (err) {
		if (err instanceof Refusal) { console.error(`REFUSED: ${err.message}`); return 2; }
		console.error(`ERROR: ${err && err.stack ? err.stack : err}`);
		return 1;
	} finally {
		db.close();
	}
}

module.exports = { parseCli, planFix, applyFix, reportText, Refusal };

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`ERROR: ${err && err.stack ? err.stack : err}`); process.exit(1); });
}
