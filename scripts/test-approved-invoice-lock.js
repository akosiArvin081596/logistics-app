#!/usr/bin/env node
// § Correction lines (the approved-invoice lock, PR A: the lines, inert while
// APPROVED_INVOICE_LOCK_ENABLED is off). server.js's own code, lifted onto an
// in-memory SQLite (scripts/lib/personal-world.js); every name, amount and date
// is made up.
//
// The world (clock Thu 2026-10-15 12:00 Eastern): "Test Driver A" at $300 a day.
//   W40 (Oct 3-9): L6 pays Tue Oct 6 and Wed Oct 7. The fixture takes Wed Oct 7
//     off its grid (a day it missed, $300) and approves it: the locked source.
//   W41 (Oct 10-16): L1 pays Oct 12-14, $900, a Draft: the next open invoice.
//
// Every "flag on" case fails on a base without the correction lines (no route,
// no table, no column). The flag-off cases pin today's behaviour, against a
// fixture captured on the base's own server.js (--capture=<file> writes it).
//
// Run: node scripts/test-approved-invoice-lock.js

"use strict";

const fs = require("fs");
const path = require("path");
const W = require("./lib/personal-world");

const { buildPersonalWorld, makeChecker, DRIVER_A, SRC } = W;
const { check, section, finish } = makeChecker();
const FIXTURE = path.join(__dirname, "fixtures", "approved-invoice-lock-flag-off.json");
const CAPTURE = (process.argv.find((a) => a.startsWith("--capture=")) || "").slice("--capture=".length);

// lib/invoice-corrections.js, when the base has it (a base without it fails those cases).
let IC = null;
try { IC = require("../lib/invoice-corrections"); } catch { IC = null; }
let MS = null;
try { MS = require("../lib/invoice-month-split"); } catch { MS = null; }

const ROUTES = {
	add: 'app.post("/api/invoices/:id/corrections", requireRole("Super Admin"), refuseCrossOrigin, correctionRouteLimiter, async (req, res) => {',
	void: 'app.delete("/api/invoices/corrections/:lineId", requireRole("Super Admin"), refuseCrossOrigin, correctionRouteLimiter, async (req, res) => {',
	waiting: 'app.get("/api/invoices/corrections/waiting", requireRole("Super Admin"), async (req, res) => {',
	invoices: 'app.get("/api/invoices", requireAuth, (req, res) => {',
};
const ROOTS = ["manualInvoiceDayCover", "weeklyManualInvoiceHolds", "deletedManualInvoiceDays", "lateDaysPaidElsewhere",
	"backfillInvoicePaidDays", "runCorrectionSweep", "correctionDayPaidBy", "correctionWaitingForClose", "personalRoomCents"];
const pass = (req, res, next) => next();

// The source a mutant's worlds lift (null: server.js as it is).
const worldSrc = { src: null };
function world(env = {}, opts = {}) {
	const src = opts.src === true ? worldSrc.src || undefined : undefined;
	return buildPersonalWorld({
		env: { APPROVED_INVOICE_LOCK_ENABLED: "true", ...env },
		extra: { routes: ROUTES, roots: ROOTS, provided: ["correctionRouteLimiter"], src, tag: src ? "mutant" : "" },
		extraDeps: { correctionRouteLimiter: pass },
		...(opts.render ? { render: opts.render } : {}),
	});
}
// A route call that answers { status: 0 } where the base has no such route.
async function call(w, method, url, opts = {}) {
	try { return await w.call(method, url, opts); } catch (err) { return { status: 0, body: { error: err.message } }; }
}
const fn = (w, name) => (typeof w.api[name] === "function" ? w.api[name] : () => { throw new Error(`${name} is not in this server.js`); });
const tryIt = (f, fallback = "THREW") => { try { return f(); } catch (err) { return `${fallback}: ${err.message.slice(0, 80)}`; } };
// The correction lines (none where the base has no table).
const lines = (w, where = "1=1", ...p) => { try { return w.db.prepare(`SELECT * FROM invoice_correction_lines WHERE ${where} ORDER BY id`).all(...p); } catch { return []; } };
const col = (w, id, c) => (w.invoice(id) || {})[c];
const lastRender = (w) => w.rendered[w.rendered.length - 1] || { data: {} };
const audits = (w, action) => w.audits(action);

// W40 locked with Wed Oct 7 missing from its grid; W41 a Draft. { w, w40, w41 }.
async function setup(env = {}, opts = {}) {
	const w = world(env, opts);
	const g40 = await w.generate(DRIVER_A, "2026-10-09");
	const w40 = g40.body.invoice;
	const snap = JSON.parse(w.invoice(w40.id).render_data);
	snap.days.Wednesday = { ...snap.days.Wednesday, completed: false, total: 0, rate: undefined, loadBol: "" };
	snap.totalDue = 300;
	w.db.prepare("UPDATE invoices SET render_data = ?, total_earnings = 300, loads_count = 1, status = 'Approved', approved_at = '2026-10-12T16:00:00.000Z', approved_by = 'super_admin' WHERE id = ?")
		.run(JSON.stringify(snap), w40.id);
	const g41 = await w.generate(DRIVER_A, "2026-10-16");
	return { w, w40: w.invoice(w40.id), w41: w.invoice(g41.body.invoice.id) };
}
const dayLine = (extra = {}) => ({ kind: "day", date: "2026-10-07", amount: "300.00", reason: "worked, missed on the grid", ...extra });

(async () => {
	if (CAPTURE) return capture();

	section("§1 Flag: only exactly \"true\" turns adding on; off answers 403 and writes nothing, not even an audit row");
	for (const v of [undefined, "TRUE", "1", "yes", " true"]) {
		const { w, w40 } = await setup({ APPROVED_INVOICE_LOCK_ENABLED: v });
		const r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() });
		check(`flag ${JSON.stringify(v)}: 403 CORRECTIONS_DISABLED`, [r.status, r.body.code], [403, "CORRECTIONS_DISABLED"]);
		check(`flag ${JSON.stringify(v)}: no line, no audit row`, [lines(w).length, w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action LIKE '%correction%'").get().n], [0, 0]);
		w.cleanup();
	}
	check("the start-up line names the flag and PERSONAL_RECEIPT_WEEK_ENABLED", /\[approved-invoice-lock\] APPROVED_INVOICE_LOCK_ENABLED .*PERSONAL_RECEIPT_WEEK_ENABLED/.test(SRC), true);

	section("§2 A day line (DRIVER_RATE_ONLY off: a typed figure) goes on the next open weekly invoice");
	{
		const { w, w40, w41 } = await setup();
		const before = w.rendered.length;
		const p = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine({ preview: true }) });
		check("preview: 200, the server's line, where it goes, the typed price and its reference", [p.status, p.body.line && p.body.line.amount, p.body.placed && p.body.placed.invoice_number, p.body.priced && p.body.priced.pricedBy, p.body.priced && p.body.priced.reference],
			[200, "+$300.00", w41.invoice_number, "typed", "$300.00"]);
		check("preview writes nothing and draws nothing", [lines(w).length, w.rendered.length], [0, before]);
		const r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() });
		check("201, placed on W41", [r.status, r.body.placed && r.body.placed.invoice_number], [201, w41.invoice_number]);
		check("W41: correction_lines_total 300, total due $1,200.00", [col(w, w41.id, "correction_lines_total"), r.body.placed && r.body.placed.total_due], [300, 1200]);
		const l = lines(w)[0] || {};
		check("the line: day, Oct 7, +30000 cents, on W41, source W40", [l.kind, l.line_date, l.cents, l.invoice_id, l.source_invoice_id], ["day", "2026-10-07", 30000, w41.id, w40.id]);
		check("its label names the source, its week and the day", l.label, `Correction to ${w40.invoice_number} (Oct 3-9, 2026), Wed Oct 7, 2026: day worked, not paid`);
		const d = lastRender(w).data;
		check("W41's PDF prints the line and its total", [Array.isArray(d.correctionLines) && d.correctionLines.map((x) => [x.label, x.amount]), d.correctionLinesTotal],
			[[[l.label, "+$300.00"]], 300]);
		const stored = JSON.parse(col(w, w41.id, "render_data") || "{}");
		check("W41's stored render data names the written line", (stored.correctionLines || []).map((x) => x.lineId), [l.id]);
		check("audit: add_invoice_correction on W40, invoice_correction_lines on W41", [audits(w, "add_invoice_correction").map((a) => String(a.entity_id)), audits(w, "invoice_correction_lines").map((a) => String(a.entity_id))],
			[[String(w40.id)], [String(w41.id)]]);
		check("the source W40 is unchanged", [col(w, w40.id, "total_earnings"), col(w, w40.id, "correction_lines_total"), col(w, w40.id, "status")], [300, 0, "Approved"]);
		const again = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() });
		check("the same request again: 200 alreadyAdded, no second line", [again.status, again.body.alreadyAdded, lines(w).length], [200, true, 1]);
		const other = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine({ amount: "250.00" }) });
		check("another figure for the same day: 409 CORRECTION_EXISTS", [other.status, other.body.code], [409, "CORRECTION_EXISTS"]);
		const list = await call(w, "GET", "/api/invoices");
		const row = (list.body.invoices || []).find((x) => x.id === w41.id) || {};
		check("GET /api/invoices: W41's total_due counts the line; correction_lines lists it", [row.total_due, (row.correction_lines || []).map((x) => [x.line_id, x.amount, x.reason])],
			[1200, [[l.id, "+$300.00", "worked, missed on the grid"]]]);
		const asDriver = await call(w, "GET", "/api/invoices", { as: "driverA" });
		const drow = (asDriver.body.invoices || []).find((x) => x.id === w41.id) || {};
		check("a Driver gets each line's label and amount only", drow.correction_lines, [{ label: l.label, amount: "+$300.00" }]);
		check("a row with no line has no correction_lines key", Object.prototype.hasOwnProperty.call((list.body.invoices || []).find((x) => x.id === w40.id) || { correction_lines: 1 }, "correction_lines"), false);
		check("the payment report's total due counts it", tryIt(() => w.api.buildPaymentReport(DRIVER_A, "2026-10-10", "2026-10-16").invoices.find((x) => x.id === w41.id).total_due), 1200);
		w.cleanup();
	}

	section("§3 The typed figure's checks, and the refusals");
	{
		const { w, w40, w41 } = await setup();
		for (const bad of ["0", "0.00", "-5", "210.001", "10000.01", "", "abc"]) {
			const r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine({ amount: bad }) });
			check(`typed day figure ${JSON.stringify(bad)}: 400`, [r.status, r.body.code], [400, "CORRECTION_DAY_FIGURE_INVALID"]);
		}
		const src = async (id, body) => call(w, "POST", `/api/invoices/${id}/corrections`, { body });
		let r = await src(w41.id, dayLine({ date: "2026-10-15" }));
		check("an open source (W41, a Draft): 409 CORRECTION_SOURCE_OPEN, change it directly", [r.status, r.body.code, /not approved yet; change it directly/.test(r.body.error || "")], [409, "CORRECTION_SOURCE_OPEN", true]);
		w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, status, render_data, pdf_file_name) VALUES ('INV-TDA-2026W39-01', 'test driver a', '2026-09-26', '2026-10-02', 'Submitted', '{}', 'INV-TDA-2026W39-01.pdf')`).run();
		const w39 = w.db.prepare("SELECT id FROM invoices WHERE invoice_number = 'INV-TDA-2026W39-01'").get().id;
		r = await src(w39, dayLine({ date: "2026-10-01" }));
		check("an open source in a closed-month week: the message names the manual-invoice path", [r.status, r.body.code, /closed September 2026: create a manual invoice \(New Manual Invoice\)/.test(r.body.error || "")], [409, "CORRECTION_SOURCE_OPEN", true]);
		r = await src(w40.id, dayLine({ date: "2026-10-10" }));
		check("a date outside the source's week: 400 CORRECTION_DATE_OUTSIDE_SOURCE", [r.status, r.body.code], [400, "CORRECTION_DATE_OUTSIDE_SOURCE"]);
		r = await src(w40.id, { kind: "amount", date: "2026-10-11", amount: "-45.00", description: "fuel advance", reason: "x" });
		check("an amount line dated outside the week: 400 CORRECTION_DATE_OUTSIDE_SOURCE", [r.status, r.body.code], [400, "CORRECTION_DATE_OUTSIDE_SOURCE"]);
		r = await src(w40.id, dayLine({ date: "2026-10-06" }));
		check("a day the source's grid pays: 409 CORRECTION_DAY_PAID", [r.status, r.body.code], [409, "CORRECTION_DAY_PAID"]);
		r = await src(w40.id, { kind: "rate", date: "2026-10-06", reason: "x" });
		check("a rate line while the daily-rate rule prices no month: 409 CORRECTION_KIND_NOT_PRICED", [r.status, r.body.code], [409, "CORRECTION_KIND_NOT_PRICED"]);
		r = await src(w40.id, { ...dayLine(), reason: "  " });
		check("no reason: 400 CORRECTION_REASON_REQUIRED", [r.status, r.body.code], [400, "CORRECTION_REASON_REQUIRED"]);
		r = await src(w40.id, { kind: "amount", date: "2026-10-08", amount: "-45.00", reason: "x" });
		check("an amount line with no description: 400", [r.status, r.body.code], [400, "CORRECTION_DESCRIPTION_INVALID"]);
		r = await src(w40.id, { kind: "amount", date: "2026-10-08", amount: "10000.01", description: "too much", reason: "x" });
		check("an amount over $10,000: 400", [r.status, r.body.code], [400, "CORRECTION_AMOUNT_INVALID"]);
		w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, status, is_manual, render_data, pdf_file_name) VALUES ('INV-M-TDA-2026W41-01', 'test driver a', '2026-10-10', '2026-10-16', 'Approved', 1, ?, 'INV-M-TDA-2026W41-01.pdf')`)
			.run(JSON.stringify({ __templateName: "service_invoice_manual", lineItems: [{ date: "2026-10-15", description: "bonus", amount: 50 }] }));
		const m1 = w.db.prepare("SELECT id FROM invoices WHERE invoice_number = 'INV-M-TDA-2026W41-01'").get().id;
		r = await src(m1, dayLine({ date: "2026-10-15" }));
		check("a day line on a manual source: 409 CORRECTION_KIND_NOT_ALLOWED", [r.status, r.body.code], [409, "CORRECTION_KIND_NOT_ALLOWED"]);
		w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, status, is_manual, render_data, pdf_file_name) VALUES ('INV-M-OP-2026W41-01', 'office helper', '2026-10-10', '2026-10-16', 'Approved', 1, '{}', 'INV-M-OP-2026W41-01.pdf')`).run();
		const m2 = w.db.prepare("SELECT id FROM invoices WHERE invoice_number = 'INV-M-OP-2026W41-01'").get().id;
		r = await src(m2, { kind: "amount", date: "2026-10-12", amount: "20.00", description: "missed hours", reason: "x" });
		check("a manual source whose payee is no driver: 409 CORRECTION_NO_DRIVER", [r.status, r.body.code], [409, "CORRECTION_NO_DRIVER"]);
		for (const as of ["dispatcher", "driverA", "investor"]) {
			r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { as, body: dayLine() });
			check(`${as}: 403`, r.status, 403);
		}
		r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine(), headers: { "x-requested-with": "XMLHttpRequest", "sec-fetch-site": "cross-site", host: "app.test", origin: "https://evil.example" } });
		check("a cross-site request: 403", r.status, 403);
		check("no refusal wrote a line", lines(w).length, 0);
		w.cleanup();
	}

	section("§4 Only day lines hold days: amount and rate lines hold none and free none (D26)");
	{
		const { w, w40, w41 } = await setup();
		let r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: { kind: "amount", date: "2026-10-07", amount: "500.00", description: "wrong total", reason: "x" } });
		check("a +$500 amount line dated Wed Oct 7 is placed", [r.status, !!(r.body.placed)], [201, true]);
		const norm = "test driver a";
		check("it holds no day: the cover readers don't see Oct 7", [tryIt(() => fn(w, "manualInvoiceDayCover")(norm).has("2026-10-07")), tryIt(() => fn(w, "correctionDayPaidBy")(norm, "2026-10-07", {}))], [false, ""]);
		r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() });
		check("a day line for Oct 7 is still accepted", r.status, 201);
		check("the day line holds Oct 7 in the late-day cover (manualInvoiceDayCover)", tryIt(() => /correction line/.test(fn(w, "manualInvoiceDayCover")(norm).get("2026-10-07"))), true);
		check("lateDaysPaidElsewhere() names it for Oct 7", tryIt(() => /correction line/.test(fn(w, "lateDaysPaidElsewhere")(norm, ["2026-10-07"], null, 300))), true);
		const holds = tryIt(() => fn(w, "weeklyManualInvoiceHolds")({ driverNorm: norm, days: new Set(["2026-10-06", "2026-10-07"]), weekStart: "2026-10-03", weekEnd: "2026-10-09", rateOf: () => 300 }));
		check("weeklyManualInvoiceHolds() holds Oct 7 only, for the day line", holds && holds.held ? [...holds.held.keys()] : holds, ["2026-10-07"]);
		r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: { kind: "amount", date: "2026-10-06", amount: "-200.00", description: "overpaid", reason: "x" } });
		check("a -$200 amount line dated on a grid day (Oct 6) is accepted", r.status, 201);
		const again = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine({ date: "2026-10-06" }) });
		check("no line frees a day: Oct 6 stays paid by W40's grid", [again.status, again.body.code], [409, "CORRECTION_DAY_PAID"]);
		// The source deleted directly in the fixture (the route refuses it, D28): its week regenerates without the held day.
		w.db.prepare("UPDATE invoices SET deleted_at = '2026-10-15T10:00:00.000Z' WHERE id = ?").run(w40.id);
		const g = await w.generate(DRIVER_A, "2026-10-09");
		const regen = g.body.invoice ? w.invoice(g.body.invoice.id) : {};
		const regenSnap = JSON.parse(regen.render_data || "{}");
		check("a regenerate of W40 bills Oct 6, leaves Oct 7 off (held by the day line) and names it", [
			!!(regenSnap.days && regenSnap.days.Tuesday.completed), !!(regenSnap.days && regenSnap.days.Wednesday.completed),
			(g.body.warnings || []).some((x) => /NOT BILLED: 2026-10-07 \(already paid by correction line/.test(x))], [true, false, true]);
		check("the +$500 amount line left Oct 7's billing alone: the warning names only the day line", (g.body.warnings || []).filter((x) => /NOT BILLED/.test(x)).length, 1);
		w.cleanup();
	}

	section("§5 Placement: the oldest open later invoice with room; else the line waits, listed");
	{
		const { w, w40, w41 } = await setup();
		let r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: { kind: "amount", date: "2026-10-08", amount: "-2000.00", description: "advance not deducted", reason: "x" } });
		check("-$2,000 with W41 at $900: 201 waiting, never split", [r.status, !!r.body.waiting, (lines(w)[0] || {}).invoice_id, col(w, w41.id, "correction_lines_total")], [201, true, null, 0]);
		const list = await call(w, "GET", "/api/invoices/corrections/waiting");
		check("the waiting list names it and why", [(list.body.lines || []).length, (list.body.lines || [])[0] && list.body.lines[0].why_code], [1, "CORRECTION_NO_ROOM"]);
		r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: { kind: "amount", date: "2026-10-08", amount: "-45.00", description: "fuel advance not deducted", reason: "x" } });
		check("-$45 fits W41: placed; total due $855.00", [r.status, r.body.placed && r.body.placed.total_due], [201, 855]);
		check("the -$2,000 line still waits", lines(w, "invoice_id IS NULL").length, 1);
		check("the month close lists the waiting line", tryIt(() => fn(w, "correctionWaitingForClose")().map((x) => x.amount_text)), ["-$2,000.00"]);
		// W41 approved: a new line waits; an earlier open week never takes it.
		w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(w41.id);
		r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() });
		check("W41 approved too: the day line waits (no Draft is made)", [r.status, !!r.body.waiting, w.db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n], [201, true, 2]);
		// The next week's generation takes waiting lines that fit.
		w.sheet.rows.push(W_LOAD("L7", "10/19/2026 8:00", "10/20/2026 10:00", "10/19/2026", "10/20/2026"));
		w.setNow(Date.UTC(2026, 9, 23, 16));
		const g = await w.generate(DRIVER_A, "2026-10-23");
		const w42 = g.body.invoice ? w.invoice(g.body.invoice.id) : {};
		check("W42's generation takes the day line (+$300), leaves the -$2,000 waiting", [g.status, w42.correction_lines_total, lines(w, "invoice_id IS NULL").map((x) => x.cents)], [200, 300, [-200000]]);
		check("W42's total due: its two days and the line", tryIt(() => w.api.invoiceTotalDue(w42)), 900);
		check("its generation wrote place_invoice_correction on the source", audits(w, "place_invoice_correction").map((a) => String(a.entity_id)), [String(w40.id)]);
		w.cleanup();
	}

	section("§6 Lifecycle: regenerate, delete, restore, void");
	{
		const { w, w40, w41 } = await setup();
		await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() });
		const g = await w.generate(DRIVER_A, "2026-10-16");
		const regen = g.body.invoice ? w.invoice(g.body.invoice.id) : {};
		check("regenerating W41 keeps the line and its total", [regen.correction_lines_total, (lines(w)[0] || {}).invoice_id === regen.id, tryIt(() => w.api.invoiceTotalDue(regen))], [300, true, 1200]);
		const del = await call(w, "DELETE", `/api/invoices/${regen.id}`);
		check("deleting the open carrier: 200, its line waits", [del.status, tryIt(() => fn(w, "correctionDayPaidBy")("test driver a", "2026-10-07", {}) !== "")], [200, true]);
		const back = await call(w, "PUT", `/api/invoices/${regen.id}/restore`);
		check("restoring it before the line moved: 200, the line on it again", [back.status, back.body.invoice && back.body.invoice.total_due], [200, 1200]);
		await call(w, "DELETE", `/api/invoices/${regen.id}`);
		w.sheet.rows.push(W_LOAD("L7", "10/19/2026 8:00", "10/20/2026 10:00", "10/19/2026", "10/20/2026"));
		w.setNow(Date.UTC(2026, 9, 23, 16));
		const g42 = await w.generate(DRIVER_A, "2026-10-23");
		check("the next generation takes the waiting line", (lines(w)[0] || {}).invoice_id, g42.body.invoice && g42.body.invoice.id);
		const moved = await call(w, "PUT", `/api/invoices/${regen.id}/restore`);
		check("restoring the deleted carrier after its line moved: 409 CORRECTION_LINES_MOVED", [moved.status, moved.body.code], [409, "CORRECTION_LINES_MOVED"]);
		const lineId = (lines(w)[0] || {}).id;
		const v = await call(w, "DELETE", `/api/invoices/corrections/${lineId}`, { body: { reason: "added by mistake" } });
		const w42 = w.invoice(g42.body.invoice.id);
		check("void while its invoice is open: unlinked, total restored, redrawn without it", [v.status, w42.correction_lines_total, tryIt(() => w.api.invoiceTotalDue(w42)), lastRender(w).data.correctionLines], [200, 0, 600, undefined]);
		check("a voided day line keeps its day out of the automatic carry", tryIt(() => /voided/.test(fn(w, "deletedManualInvoiceDays")("test driver a").get("2026-10-07"))), true);
		const r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: { kind: "amount", date: "2026-10-08", amount: "25.00", description: "lumper refund", reason: "x" } });
		w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(g42.body.invoice.id);
		const late = await call(w, "DELETE", `/api/invoices/corrections/${r.body.line && r.body.line.line_id}`, { body: { reason: "x" } });
		check("void once its invoice is approved: 409 INVOICE_LOCKED", [late.status, late.body.code], [409, "INVOICE_LOCKED"]);
		w.cleanup();
	}

	section("§7 D28: a source with live lines can't be deleted, flag on or off");
	{
		for (const flag of ["true", undefined]) {
			const { w, w40 } = await setup();
			await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() });
			if (!flag) w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(w40.id);
			const off = flag ? w : null;
			const r = await call(off || w, "DELETE", `/api/invoices/${w40.id}`);
			check(`flag ${flag ? "on" : "off (lines from before)"}: 409 CORRECTION_SOURCE_HAS_LINES, W40 stays`, [r.status, r.body.code, col(w, w40.id, "deleted_at")], [409, "CORRECTION_SOURCE_HAS_LINES", ""]);
			w.cleanup();
		}
		const { w, w40 } = await setup({ APPROVED_INVOICE_LOCK_ENABLED: undefined });
		const r = await call(w, "DELETE", `/api/invoices/${w40.id}`);
		check("a source with no line deletes as today (pin)", r.status, 200);
		w.cleanup();
	}

	section("§8 An approval during the render: nothing linked, the line waits");
	{
		let hook = null;
		const { w, w40, w41 } = await setup({}, { render: (t, d, def) => { if (hook) { const h = hook; hook = null; h(); } return def(t, d); } });
		hook = () => w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(w41.id);
		const r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() });
		check("201 waiting; W41 approved mid-render carries nothing", [r.status, !!r.body.waiting, col(w, w41.id, "correction_lines_total"), (lines(w)[0] || {}).invoice_id], [201, true, 0, null]);
		w.cleanup();
	}

	section("§9 The refit: a negative adjustment sends the newest negative lines back to waiting first (D11)");
	{
		const { w, w40, w41 } = await setup();
		await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: { kind: "amount", date: "2026-10-08", amount: "-400.00", description: "advance one", reason: "x" } });
		await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: { kind: "amount", date: "2026-10-09", amount: "-300.00", description: "advance two", reason: "x" } });
		check("both fit W41 ($900 - $700)", col(w, w41.id, "correction_lines_total"), -700);
		const a = await call(w, "PUT", `/api/invoices/${w41.id}/adjust`, { body: { adjustment: -400, adjustmentNote: "short week" } });
		check("-$400 adjustment ($900 - $400 - $700 < $0): the newest (-$300) waits; total due $100.00",
			[a.status, col(w, w41.id, "correction_lines_total"), lines(w, "invoice_id IS NULL").map((x) => x.cents), a.body.invoice && a.body.invoice.total_due], [200, -400, [-30000], 100]);
		check("the redraw prints the one line left", (lastRender(w).data.correctionLines || []).map((x) => x.amount), ["-$400.00"]);
		check("the Personal room counts the correction lines", tryIt(() => fn(w, "personalRoomCents")(w.invoice(w41.id))), 10000);
		w.cleanup();
	}

	section("§10 Totals: invoiceTotalDue() refuses a row without the column; the Financials split");
	{
		const { w } = await setup();
		check("invoiceTotalDue() throws on a row read without correction_lines_total",
			String(tryIt(() => w.api.invoiceTotalDue({ total_earnings: 1, adjustment: 0, personal_total: 0, personal_share_total: 0 }), "THREW")).startsWith("THREW"), true);
		check("and counts it when read", tryIt(() => w.api.invoiceTotalDue({ total_earnings: 900, adjustment: 0, personal_total: 0, personal_share_total: 0, correction_lines_total: 300 })), 1200);
		const split = MS ? MS.invoiceMonthShares({ driver: "a", week_start: "2026-10-03", week_end: "2026-10-09", total_earnings: 0, adjustment: 0, personal_share_total: 0, render_data: {} }, {
			paidDays: [], booksMonthOf: (d, day) => (day === "2026-09-30" ? "2026-09" : ""),
			correctionLines: [{ kind: "day", line_date: "2026-09-30", cents: 30000 }, { kind: "day", line_date: "2026-10-07", cents: 30000 }, { kind: "amount", line_date: "2026-10-06", cents: -4500 }],
		}) : null;
		check("a day line counts in the books' month, else its own; an amount line in week_end's month (C-D1, C-D2)", split ? [split.shares, split.invoicedCents, split.unsplit.correctionAmountCents] : null,
			[{ "2026-09": 30000, "2026-10": 25500 }, 55500, -4500]);
		w.cleanup();
	}

	section("§11 The pure rules (lib/invoice-corrections.js)");
	{
		const ok = !!IC;
		check("the module exists", ok, true);
		if (ok) {
			check("labels: rate and amount", [IC.lineLabel({ kind: "rate", source_invoice_number: "INV-X", source_week_start: "2026-10-10", source_week_end: "2026-10-16", line_date: "2026-10-16", rate_from_cents: 21000, rate_to_cents: 24000 }),
				IC.lineLabel({ kind: "amount", source_invoice_number: "INV-X", source_week_start: "2026-09-26", source_week_end: "2026-10-02", line_date: "2026-09-30", description: "fuel advance not deducted" })],
			["Correction to INV-X (Oct 10-16, 2026), Fri Oct 16, 2026: daily rate $210.00 → $240.00", "Correction to INV-X (Sep 26 - Oct 2, 2026), Wed Sep 30, 2026: fuel advance not deducted"]);
			check("fit: positives first, then negatives oldest first, never split", IC.fitLines(10000, [{ id: 1, cents: -8000 }, { id: 2, cents: 5000 }, { id: 3, cents: -9000 }]).fit.map((l) => l.id), [1, 2]);
			check("refit: the newest negatives go first", IC.refitNegatives(-5000, [{ id: 1, cents: -3000 }, { id: 2, cents: -4000 }, { id: 3, cents: 1000 }]).detach.map((l) => l.id), [2, 1].slice(0, 2));
			check("signed figures", [IC.parseFigure("-45.5", { signed: true }).cents, IC.parseFigure("+10", { signed: true }).cents, IC.parseFigure("0", { signed: true }).code], [-4550, 1000, "CORRECTION_AMOUNT_INVALID"]);
			check("the amount kind's note, in the server's words", IC.MESSAGES.AMOUNT_PAYS_NO_DAY, "An amount line pays no day. A day worked and not paid goes as a day line on that week's weekly invoice.");
		}
	}

	section("§12 The scripts' day-line read (scripts/lib/correction-day-lines.js)");
	{
		let helper = null;
		try { helper = require("./lib/correction-day-lines"); } catch { helper = null; }
		check("the helper exists", !!helper, true);
		if (helper) {
			const { w, w40 } = await setup();
			await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() });
			await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: { kind: "amount", date: "2026-10-08", amount: "500.00", description: "wrong total", reason: "x" } });
			check("reads live day lines only (not the amount line)", helper.correctionDayLines(w.db, "test driver a", w.api.normalizeDriverName || ((s) => String(s).toLowerCase().trim())).map((l) => l.day), ["2026-10-07"]);
			w.cleanup();
			const Database = require("module").createRequire(path.join(W.ROOT, "server.js"))("better-sqlite3");
			const bare = new Database(":memory:");
			bare.exec("CREATE TABLE invoices (id INTEGER PRIMARY KEY, driver TEXT)");
			check("a database without the table reads as no line", helper.correctionDayLines(bare, "test driver a", (s) => s).length, 0);
			bare.exec("CREATE TABLE invoice_correction_lines (id INTEGER PRIMARY KEY)");
			check("a table that exists but can't be read stops the script", String(tryIt(() => helper.correctionDayLines(bare, "test driver a", (s) => s), "THREW")).startsWith("THREW"), true);
		}
	}

	section("§13 Flag off is today: the same requests answer exactly as on the base (fixture), but for correction_lines_total");
	{
		const got = await flagOffScenario();
		let want = null;
		try { want = JSON.parse(fs.readFileSync(FIXTURE, "utf8")); } catch { want = null; }
		check("the fixture exists", !!want, true);
		if (want) {
			check("every key but correction_lines_total = 0 is the base's", stripAdditive(got.result), want.result);
			check("every invoice row carries correction_lines_total = 0", got.additive, true);
		}
	}

	section("§14 Mutants of the shipped source: each must fail a case above");
	await mutants();

	finish();
})().catch((err) => {
	console.error(err && err.stack);
	process.exit(1);
});

// A delivered Job Tracking row of Driver A on T-1, in personal-world's columns.
function W_LOAD(id, pickup, dropoff, assigned, done) {
	const H = ["Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info", "Pickup Appointment",
		"Pickup Address", "Drop-off Info", "Drop-off Appointment", "Drop-off Address", "Job Status",
		"Phase of Progress", "Carrier Stage", "  Payment  ", "Broker Contact Name", "Phone Number", "Email",
		"Location Link", "Documents", "Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output"];
	const r = Object.fromEntries(H.map((h) => [h, ""]));
	Object.assign(r, { "Load ID": id, Driver: DRIVER_A, "Pickup Appointment": pickup, "Drop-off Appointment": dropoff, "Job Status": "Delivered",
		"  Payment  ": "$1,500.00", "Assigned Date": assigned, "Status Update Date": done, "Completion Date": done, Truck: "T-1", "Owner ID": "7" });
	return H.map((h) => r[h]);
}

// The flag-off requests: generate, adjust, delete, restore, list; each route's
// status and body, the rows, the audit rows and every render's data, with the
// volatile stamps dropped.
async function flagOffScenario() {
	const w = world({ APPROVED_INVOICE_LOCK_ENABLED: undefined });
	const out = [];
	const clean = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === "created_at" || k === "timestamp" ? undefined : x)));
	const g = await w.generate(DRIVER_A, "2026-10-16");
	out.push(["generate", g.status, g.body]);
	const id = g.body.invoice.id;
	out.push(["adjust", ...Object.values(await w.call("PUT", `/api/invoices/${id}/adjust`, { body: { adjustment: 75, adjustmentNote: "bonus" } })).slice(0, 2)]);
	out.push(["delete", ...Object.values(await w.call("DELETE", `/api/invoices/${id}`)).slice(0, 2)]);
	out.push(["restore", ...Object.values(await w.call("PUT", `/api/invoices/${id}/restore`)).slice(0, 2)]);
	const list = await call(w, "GET", "/api/invoices");
	out.push(["list", list.status, list.body]);
	out.push(["rows", w.db.prepare("SELECT * FROM invoices ORDER BY id").all()]);
	out.push(["audit", w.db.prepare("SELECT action, entity_id, details FROM audit_trail ORDER BY id").all()]);
	out.push(["renders", w.rendered.map((r) => [r.templateName, r.data])]);
	const result = clean(out);
	const rows = w.db.prepare("SELECT * FROM invoices").all();
	const additive = rows.every((r) => r.correction_lines_total === 0);
	w.cleanup();
	return { result, additive };
}
function stripAdditive(v) {
	return JSON.parse(JSON.stringify(v, (k, x) => (k === "correction_lines_total" ? undefined : x)));
}
async function capture() {
	const got = await flagOffScenario();
	fs.writeFileSync(CAPTURE, `${JSON.stringify({ note: "Captured on the base's own server.js by scripts/test-approved-invoice-lock.js --capture; made-up data.", result: stripAdditive(got.result) }, null, 1)}\n`);
	console.log(`captured ${CAPTURE}`);
}

// Each mutant changes the shipped server.js text in one place; a case must then fail.
async function mutants() {
	const cases = [
		{
			name: "a cover reader that skips the day lines (D26)",
			from: "\tif (dayLines) for (const [d, h] of correctionDayLineHolds(driverNorm)) if (!cover.has(d)) cover.set(d, h.name);",
			to: "",
			probe: async () => { const { w, w40 } = await setup({}, { src: true }); await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() }); const v = tryIt(() => fn(w, "manualInvoiceDayCover")("test driver a").has("2026-10-07")); w.cleanup(); return v === true; },
		},
		{
			name: "a reader that also counts amount lines (Revision 2's wording)",
			from: "WHERE c.kind = 'day' AND c.voided_at = '' ORDER BY c.id`).all()) {\n\t\tif (r.id === exceptLineId",
			to: "WHERE c.voided_at = '' ORDER BY c.id`).all()) {\n\t\tif (r.id === exceptLineId",
			probe: async () => { const { w, w40 } = await setup({}, { src: true }); await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: { kind: "amount", date: "2026-10-07", amount: "500.00", description: "wrong total", reason: "x" } }); const v = tryIt(() => fn(w, "manualInvoiceDayCover")("test driver a").has("2026-10-07")); w.cleanup(); return v === false; },
		},
		{
			name: "D28's delete check removed",
			from: "\t\tif (sourceLines.length) {",
			to: "\t\tif (false && sourceLines.length) {",
			probe: async () => { const { w, w40 } = await setup({}, { src: true }); await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() }); const r = await call(w, "DELETE", `/api/invoices/${w40.id}`); w.cleanup(); return r.status === 409; },
		},
		{
			name: "the source-locked check removed (CORRECTION_SOURCE_OPEN)",
			from: "\tif (!CORRECTION_LOCKED_STATUSES.has(source.status)) {",
			to: "\tif (false) {",
			probe: async () => { const { w, w41 } = await setup({}, { src: true }); const r = await call(w, "POST", `/api/invoices/${w41.id}/corrections`, { body: dayLine({ date: "2026-10-15" }) }); w.cleanup(); return r.body.code === "CORRECTION_SOURCE_OPEN"; },
		},
		{
			name: "the flag read as any truthy value",
			from: 'const APPROVED_INVOICE_LOCK_ENABLED = process.env.APPROVED_INVOICE_LOCK_ENABLED === "true";',
			to: "const APPROVED_INVOICE_LOCK_ENABLED = !!process.env.APPROVED_INVOICE_LOCK_ENABLED;",
			probe: async () => { const { w, w40 } = await setup({ APPROVED_INVOICE_LOCK_ENABLED: "1" }, { src: true }); const r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() }); w.cleanup(); return r.status === 403; },
		},
		{
			name: "the link transaction's re-check removed (an approval mid-render)",
			from: "\t\t\tif (moved || !sameLines || !samePersonal || shared || weekLock.unreadable || weekLock.blockers.length) throw changed();",
			to: "",
			probe: async () => {
				let hook = null;
				const { w, w40, w41 } = await setup({}, { src: true, render: (t, d, def) => { if (hook) { const h = hook; hook = null; h(); } return def(t, d); } });
				hook = () => w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(w41.id);
				await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() });
				const v = col(w, w41.id, "correction_lines_total");
				w.cleanup();
				return v === 0;
			},
		},
		{
			name: "the room ignoring correction lines (a negative line placed with no room)",
			from: "\t\tif (Number(line.cents) > 0 || Math.round(invoiceTotalDue(inv) * 100) + Number(line.cents) >= 0) return inv;",
			to: "\t\treturn inv;",
			probe: async () => { const { w, w40 } = await setup({}, { src: true }); const r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: { kind: "amount", date: "2026-10-08", amount: "-2000.00", description: "advance", reason: "x" } }); w.cleanup(); return !!r.body.waiting; },
		},
		{
			name: "placement taking an earlier week",
			from: "\tfor (const inv of personalOpenInvoicesFrom(driver, dayKeyPlus(line.source_week_end, 1))) {",
			to: "\tfor (const inv of personalOpenInvoicesFrom(driver, \"2000-01-01\")) {",
			probe: async () => {
				const { w, w40 } = await setup({}, { src: true });
				// An open W39 Draft before the source's week: it must never take the line.
				w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, status, render_data, pdf_file_name, total_earnings) VALUES ('INV-TDA-2026W39-09', 'test driver a', '2026-09-26', '2026-10-02', 'Draft', ?, 'INV-TDA-2026W39-09.pdf', 300)`)
					.run(JSON.stringify({ __templateName: "service_invoice", days: {}, totalDue: 300 }));
				w.db.prepare("DELETE FROM period_locks WHERE period = '2026-09'").run();
				const r = await call(w, "POST", `/api/invoices/${w40.id}/corrections`, { body: dayLine() });
				w.cleanup();
				return r.body.placed && /W41/.test(r.body.placed.invoice_number);
			},
		},
	];
	for (const m of cases) {
		if (!SRC.includes(m.from)) { check(`mutant "${m.name}": its target is in server.js`, false, true); continue; }
		// The probe's worlds lift the mutated source; the real source passes the same probe.
		const run = async (src) => {
			worldSrc.src = src;
			try { return await m.probe(); } catch { return false; } finally { worldSrc.src = null; }
		};
		const held = await run(null);
		const killed = !(await run(SRC.replace(m.from, m.to)));
		check(`mutant "${m.name}": the real source passes its probe and the mutant fails it`, [held, killed], [true, true]);
	}
}
