#!/usr/bin/env node
/**
 * The pure core of "Personal" receipts (lib/personal-expense.js): the amount
 * rule, the invoice line text, the owner-operator share, the never-negative
 * placement, the totals, and the two shared SQL sources the books and the
 * operational views read (run on an in-memory SQLite).
 *
 *   §1 parseAmountCents(): absent = the whole receipt; 0, negative, more than
 *      two decimals, text and more than the receipt are refused with their codes
 *   §2 line text: "Personal expense, Pilot #123, Oct 12, 2026: -$200.00", the
 *      reversal and the owner-operator share lines; merchant fallbacks; a date
 *      is a calendar date in every server zone
 *   §3 invoiceLines(): the lines of a set of rows in id order and their two
 *      signed totals (repayments; share returned)
 *   §4 shareCents(): 25% of $100.00 is $25.00, rounded to the cent
 *   §5 fitLines(): oldest first, a line that would take the total below $0 is
 *      left for the week's correction, a reversal always fits
 *   §6 totalDueCents(): earnings + adjustment + share returned - repayments
 *   §7 the sources: with no live row they give the receipts exactly (every
 *      column, the amount to the bit); an in-place line lowers its receipt, a
 *      fully personal receipt leaves both sources, a credit row (closed month)
 *      is a books-only row in the open month, a voided row changes nothing, a
 *      reversal cancels its line; an unknown column name is refused
 *   §8 the schema: one live mark per receipt and one reversal per mark (unique
 *      partial indexes), cents always positive
 *
 * Made-up data only. Pure: no server, no network.
 * Run: node scripts/test-personal-expense-lib.js    # exits 1 on failure
 */
"use strict";

const path = require("path");
const ROOT = path.join(__dirname, "..");
const { makeChecker } = require("./lib/personal-world");
const { check, section, finish } = makeChecker();

let pe;
try { pe = require(path.join(ROOT, "lib", "personal-expense.js")); } catch (e) {
	check(`lib/personal-expense.js loads (${e.message.split("\n")[0]})`, false, true);
	finish();
}
const Database = require("better-sqlite3");

section("§1 parseAmountCents()");
check("absent is the whole receipt", pe.parseAmountCents(undefined, 20000), { cents: 20000 });
check("null and '' are the whole receipt", [pe.parseAmountCents(null, 20000), pe.parseAmountCents("", 20000)], [{ cents: 20000 }, { cents: 20000 }]);
check("a number in dollars", pe.parseAmountCents(50, 30000), { cents: 5000 });
check("a string with two decimals", pe.parseAmountCents("45.50", 4550), { cents: 4550 });
check("one cent", pe.parseAmountCents("0.01", 4550), { cents: 1 });
for (const [label, v] of [["0", 0], ["-5", -5], ["12.345", 12.345], ["'abc'", "abc"], ["'1e2'", "1e2"], ["Infinity", Infinity], ["an object", {}]]) {
	check(`${label} is PERSONAL_AMOUNT_INVALID`, pe.parseAmountCents(v, 20000).code, "PERSONAL_AMOUNT_INVALID");
}
check("200.01 of a $200.00 receipt is PERSONAL_AMOUNT_TOO_LARGE", pe.parseAmountCents(200.01, 20000).code, "PERSONAL_AMOUNT_TOO_LARGE");
check("a $0.00 receipt cannot be marked", pe.parseAmountCents(undefined, 0).code, "PERSONAL_AMOUNT_INVALID");
check("every refusal carries a plain sentence", typeof pe.parseAmountCents(-1, 100).error === "string" && pe.parseAmountCents(-1, 100).error.length > 10, true);
check("receiptCents() rounds a stored REAL to the cent", [pe.receiptCents(61.2), pe.receiptCents(45.5), pe.receiptCents(0.1 + 0.2)], [6120, 4550, 30]);

section("§2 line text");
check("merchant: vendor first", pe.merchantOf({ vendor: " Pilot  #123 ", vendor_normalized: "Pilot", description: "fuel", type: "Fuel" }), "Pilot #123");
check("merchant: then vendor_normalized, description, type",
	[pe.merchantOf({ vendor_normalized: "Pilot" }), pe.merchantOf({ description: "Snacks" }), pe.merchantOf({ type: "Food" }), pe.merchantOf({})],
	["Pilot", "Snacks", "Food", "Receipt"]);
check("a date is a calendar date (Oct 12, 2026)", pe.formatDay("2026-10-12"), "Oct 12, 2026");
check("not a date prints nothing", [pe.formatDay("2026-13-01"), pe.formatDay(""), pe.formatDay("10/12/2026")], ["", "", ""]);
const deduct = { id: 11, kind: "deduct", cents: 20000, share_cents: 0, merchant: "Pilot #123", receipt_date: "2026-10-12" };
check("a deduction line", pe.lineEntries(deduct, "Fuel").map((l) => l.text), ["Personal expense, Pilot #123, Oct 12, 2026: -$200.00"]);
check("…its cents are negative (the driver repays)", pe.lineEntries(deduct, "Fuel").map((l) => l.cents), [-20000]);
const withShare = { ...deduct, cents: 10000, share_cents: 2500, merchant: "Shell #9", receipt_date: "2026-10-13" };
check("an owner-operator line carries its share returned first",
	pe.lineEntries(withShare, "Fuel").map((l) => [l.kind, l.text, l.cents]),
	[["share", "Fuel share returned, Shell #9, Oct 13, 2026: +$25.00", 2500], ["personal", "Personal expense, Shell #9, Oct 13, 2026: -$100.00", -10000]]);
const reverse = { id: 12, kind: "reverse", cents: 10000, share_cents: 2500, merchant: "Shell #9", receipt_date: "2026-10-13" };
check("a reversal credits the amount and takes the share back",
	pe.lineEntries(reverse, "Maintenance").map((l) => [l.kind, l.text, l.cents]),
	[["share_back", "Maintenance share taken back, Shell #9, Oct 13, 2026: -$25.00", -2500], ["personal_reversed", "Personal expense reversed, Shell #9, Oct 13, 2026: +$100.00", 10000]]);
check("thousands are grouped", pe.lineEntries({ ...deduct, cents: 123456 }, "Fuel")[0].text, "Personal expense, Pilot #123, Oct 12, 2026: -$1,234.56");

section("§3 invoiceLines()");
{
	const rows = [{ ...withShare, id: 20 }, { ...deduct, id: 3 }, { ...reverse, id: 30 }];
	const out = pe.invoiceLines(rows, (r) => "Fuel");
	check("lines in row id order", out.lines.map((l) => l.rowId), [3, 20, 20, 30, 30]);
	check("repayments net of reversal credits", out.personalTotalCents, 20000 + 10000 - 10000);
	check("share returned net of shares taken back", out.shareTotalCents, 2500 - 2500);
	check("no rows: no lines, zero totals", pe.invoiceLines([], () => "Fuel"), { lines: [], personalTotalCents: 0, shareTotalCents: 0 });
}

section("§4 shareCents()");
check("25% of $100.00 is $25.00", pe.shareCents(25, 10000), 2500);
check("rounded to the cent", [pe.shareCents(30, 3333), pe.shareCents(12.5, 101)], [1000, 13]);
check("0% or a bad percentage is no share", [pe.shareCents(0, 10000), pe.shareCents("x", 10000), pe.shareCents(-5, 10000)], [0, 0, 0]);

section("§5 fitLines()");
{
	const a = { id: 1, kind: "deduct", cents: 20000, share_cents: 0 };
	const b = { id: 2, kind: "deduct", cents: 15000, share_cents: 0 };
	const r = pe.fitLines(30000, [b, a]);
	check("$200 (older) and $150 on $300 of pay: the $200 line fits, the $150 one waits", [r.fit.map((x) => x.id), r.flagged.map((x) => x.id)], [[1], [2]]);
	check("a share returned counts toward the fit", pe.fitLines(7500, [{ id: 5, kind: "deduct", cents: 10000, share_cents: 2500 }]).fit.map((x) => x.id), [5]);
	check("a reversal always fits", pe.fitLines(0, [{ id: 9, kind: "reverse", cents: 5000, share_cents: 1000 }]).fit.map((x) => x.id), [9]);
	check("exactly $0 left fits", pe.fitLines(20000, [a]).fit.map((x) => x.id), [1]);
	check("a negative base fits nothing that costs", pe.fitLines(-100, [a]).flagged.map((x) => x.id), [1]);
}

section("§6 totalDueCents()");
check("$900 + $0 + $0 - $200 = $700", pe.totalDueCents({ total_earnings: 900, adjustment: 0, personal_total: 200, personal_share_total: 0 }), 70000);
check("$800 + $25 - $100 = $725", pe.totalDueCents({ total_earnings: 800, adjustment: 0, personal_total: 100, personal_share_total: 25 }), 72500);
check("a correction: $0 + $25 - $100 = -$75", pe.totalDueCents({ total_earnings: 0, adjustment: 0, personal_total: 100, personal_share_total: 25 }), -7500);

section("§7 the sources");
{
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, driver TEXT NOT NULL, load_id TEXT DEFAULT '',
		type TEXT NOT NULL, amount REAL NOT NULL, description TEXT DEFAULT '', date TEXT NOT NULL, photo_data TEXT DEFAULT '',
		status TEXT DEFAULT 'Pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, gallons REAL DEFAULT 0, owner_id INTEGER DEFAULT 0,
		truck_unit TEXT DEFAULT '', posted_period TEXT DEFAULT '', receipt_hash TEXT DEFAULT '')`);
	db.exec(pe.SCHEMA_SQL);
	const ins = db.prepare("INSERT INTO expenses (id, timestamp, driver, type, amount, date, status, gallons, owner_id, truck_unit, posted_period) VALUES (?, 't', 'A', ?, ?, ?, ?, ?, 7, 'T-1', ?)");
	ins.run(1, "Fuel", 200.0, "2026-10-12", "Approved", 50, "");
	ins.run(2, "Other", 61.2, "2026-10-13", "Pending", 0, "");
	ins.run(3, "Fuel", 300.0, "2026-08-30", "Pending", 0, "");
	ins.run(4, "Fuel", 300.0, "2026-10-11", "Approved", 100, "");
	ins.run(5, "Fuel", 0.1, "2026-10-11", "Approved", 1, "");
	const cols = db.prepare("PRAGMA table_info(expenses)").all().map((c) => c.name);
	const from = (kind) => `(${pe.expenseSourceSql(kind, cols)}) AS expenses`;
	const all = (sql) => db.prepare(sql).all();
	const plain = all("SELECT * FROM expenses ORDER BY id");
	const strip = (rows) => rows.map(({ is_credit, personal_id, ...r }) => r);
	check("no rows: the books give the receipts exactly, every column", strip(all(`SELECT * FROM ${from("book")} ORDER BY id`)), plain);
	check("no rows: so does the world view", strip(all(`SELECT * FROM ${from("world")} ORDER BY id`)), plain);
	check("…and the amount is bit-identical (61.2 stays 61.2)", all(`SELECT amount FROM ${from("book")} WHERE id = 2`)[0].amount === 61.2, true);
	const add = db.prepare(`INSERT INTO expense_personal (expense_id, kind, reverses_id, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role, share_cents, voided_at)
		VALUES (?, ?, ?, ?, ?, 'M', ?, ?, ?, ?, '2026-10-10', 't', 'super_admin', 1, 'Super Admin', 0, ?)`);
	add.run(4, "deduct", null, 5000, 30000, "2026-10-11", "2026-10", 1, "2026-10-11", "");
	add.run(1, "deduct", null, 20000, 20000, "2026-10-12", "2026-10", 1, "2026-10-12", "");
	add.run(3, "deduct", null, 30000, 30000, "2026-08-30", "2026-10", 0, "2026-10-15", "");
	add.run(2, "deduct", null, 6120, 6120, "2026-10-13", "2026-10", 1, "2026-10-13", "2026-10-14T00:00:00Z");
	const book = all(`SELECT id, amount, gallons, posted_period, date, is_credit FROM ${from("book")} ORDER BY id, is_credit`);
	check("partial $50 of $300: the receipt counts $250 and keeps its gallons", book.filter((r) => r.id === 4).map((r) => [r.amount, r.gallons]), [[250, 100]]);
	check("fully personal: the receipt leaves the books", book.some((r) => r.id === 1), false);
	check("voided: the receipt is unchanged", book.filter((r) => r.id === 2).map((r) => r.amount), [61.2]);
	check("closed-month receipt: kept in full in August, a -$300.00 credit row in October dated the marking day",
		book.filter((r) => r.id === 3).map((r) => [r.amount, r.posted_period, r.date, r.is_credit]),
		[[300, "", "2026-08-30", 0], [-300, "2026-10", "2026-10-15", 1]]);
	check("…a credit row carries no gallons", book.filter((r) => r.id === 3 && r.is_credit).map((r) => r.gallons), [0]);
	const world = all(`SELECT id, amount, gallons FROM ${from("world")} ORDER BY id`);
	check("the world view: partial lowered, fully personal gone, no credit rows",
		world.map((r) => [r.id, r.amount]), [[2, 61.2], [3, 300], [4, 250], [5, 0.1]]);
	add.run(4, "reverse", 1, 5000, 30000, "2026-10-11", "2026-10", 1, "2026-10-11", "");
	check("a reversal in place cancels its line", all(`SELECT amount FROM ${from("book")} WHERE id = 4`).map((r) => r.amount), [300]);
	let refused = false;
	try { pe.expenseSourceSql("book", [...cols, "bad name"]); } catch { refused = true; }
	check("a column name that is not a plain identifier is refused", refused, true);
	refused = false;
	try { pe.expenseSourceSql("both", cols); } catch { refused = true; }
	check("an unknown source kind is refused", refused, true);
}

section("§8 the schema");
{
	const db = new Database(":memory:");
	db.exec(pe.SCHEMA_SQL);
	const add = (expenseId, kind, reversesId, cents, voided = "", reversedBy = null) => db.prepare(`INSERT INTO expense_personal (expense_id, kind, reverses_id, cents, receipt_cents, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role, voided_at, reversed_by_id)
		VALUES (?, ?, ?, ?, 1000, '2026-10', 1, '2026-10-12', '2026-10-10', 't', 'a', 1, 'Super Admin', ?, ?)`).run(expenseId, kind, reversesId, cents, voided, reversedBy);
	const throws = (fn) => { try { fn(); return false; } catch (e) { return /UNIQUE|CHECK/.test(e.message); } };
	add(1, "deduct", null, 100);
	check("a second live mark on one receipt is refused by the index", throws(() => add(1, "deduct", null, 100)), true);
	check("a voided mark does not block a new one", throws(() => add(1, "deduct", null, 100, "2026-10-14T00:00:00Z")), false);
	check("cents must be positive", throws(() => add(2, "deduct", null, 0)), true);
	check("kind is deduct or reverse", throws(() => add(2, "credit", null, 100)), true);
	add(3, "reverse", 77, 100);
	check("one reversal per mark", throws(() => add(3, "reverse", 77, 100)), true);
	check("the sweep keeps its own marker table", db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'personal_sweep_runs'").get()?.name, "personal_sweep_runs");
}

finish();
