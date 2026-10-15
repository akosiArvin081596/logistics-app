#!/usr/bin/env node
/**
 * B12 runner C: the days-billed ledger, invoice_paid_days (plan section 4.1(5)
 * and (6), cases C1-C11). Written before the fix, which they failed: on main the
 * table, the claims, the backfill script and the floor marker do not exist.
 *
 * The contract (from the plan):
 *   - invoice_paid_days(driver_norm, day, invoice_id, UNIQUE(driver_norm, day));
 *     driver_norm is normalizeDriverName();
 *   - claims are re-checked and written inside commitInvoiceWithPdf()'s immediate
 *     transaction; a day another live invoice holds aborts with 409
 *     INVOICE_DAY_ALREADY_PAID naming that invoice, never a 500;
 *   - a regenerated Draft's rows go with the Draft row, in the same transaction;
 *   - only soft delete releases an invoice's rows; a Rejected invoice keeps them;
 *     restore answers 409 when a day was claimed since, else re-claims;
 *   - POST /api/invoices/manual claims the days it names in a new optional
 *     `days` list, none without it;
 *   - backfill: scripts/backfill-invoice-paid-days.js (this name is the runners'
 *     choice; the plan names no file) --db=<copy> --env-file=<file> [--dry-run]
 *     writes one row per paid day of the day grid of every live weekly invoice,
 *     Rejected included, soft-deleted skipped; idempotent;
 *   - a late day (payable after its week's invoice was made) is carried only when
 *     its load settles in FROM or later, the day is on or after the floor (the
 *     Saturday of FROM's first week, the owner's decision of 2026-10-15; the
 *     app_settings marker trip_work_days_started_at, written once in the first
 *     rule invoice's transaction, is a record only), no live invoice holds it,
 *     and its month is not closed; a refused day is named in
 *     `warnings`. A carried day goes on its own week's invoice, never a later
 *     one (the owner's rule, 2026-10-14): in place while that invoice is not
 *     approved, else on a correction invoice for that week.
 *
 * Shipping code lifted from server.js on an in-memory SQLite built from its DDL
 * (lib/work-days-world.js beside this runner). Flags: TRIP_WORK_DAYS_ENABLED on,
 * FROM=2026-09 unless a case says otherwise. Weeks: W39 9/26-10/2, W40 10/3-10/9.
 * [Qn] in a title: expected values follow the plan's recommended answer to open
 * question n. Made-up data only. Pure: no server, no app.db, no network.
 * Run: node scripts/test-invoice-paid-days.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const W = require("./lib/work-days-world");
const { loadRow, etMs } = W;

const TRIP = (from = "2026-09") => ({ TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: from });
const W38 = "2026-09-25";
const W39 = "2026-10-02";
const W40 = "2026-10-09";
const s = (lid, status, at, source = "manual", actor = "") => [lid, status, source, at, actor];
const norm = (x) => x.trim().toLowerCase().replace(/\s+/g, " ");

// Claim rows, or a clear error while the table does not exist.
function claims(world, where = "", ...args) {
	if (!W.hasTable(world.db, "invoice_paid_days")) throw new Error("table invoice_paid_days does not exist yet (the fix adds it)");
	return world.db.prepare(`SELECT driver_norm, day, invoice_id FROM invoice_paid_days ${where} ORDER BY day, invoice_id`).all(...args);
}
const claimDays = (world, invoiceId) => claims(world, "WHERE invoice_id = ?", invoiceId).map((r) => r.day);
const invoiceCount = (world) => world.db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n;
// The paid grid days of a stored invoice, and the work-day correction invoices
// (a late day goes on its own week's invoice or a correction for that week).
const storedGrid = (world, id, weekEnd) => W.gridDays(JSON.parse(world.db.prepare("SELECT render_data FROM invoices WHERE id = ?").get(id).render_data || "{}"), weekEnd);
const corrections = (world) => world.db.prepare("SELECT * FROM invoices WHERE is_manual = 1 AND correction_of IS NOT NULL AND deleted_at = '' ORDER BY id").all();
const marker = (world) => { const r = world.db.prepare("SELECT value FROM app_settings WHERE key = 'trip_work_days_started_at'").get(); return r ? r.value : null; };
const manual = (world, payee, days, period = ["2026-10-05", "2026-10-06"]) => W.route(world, "POST /api/invoices/manual", {
	body: { payee, periodStart: period[0], periodEnd: period[1], lineItems: [{ description: "Layover", amount: 260 }], ...(days ? { days } : {}) },
});

// One driver with one W39 load: At Shipper Tue 9/29, Delivered Thu 10/1.
const RAY = "Ray Vos";
function rayWorld(env = TRIP(), extra = {}) {
	return W.startWorld({
		env,
		drivers: [{ name: RAY }],
		rows: [loadRow({ id: "C101", driver: RAY, pickup: "2026-09-29 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-09-29", done: "2026-10-01", truck: "T1" })],
		status: [s("C101", "At Shipper", "2026-09-29 13:00:00"), s("C101", "Delivered", "2026-10-01 20:00:00")],
		...extra,
	});
}
const W39_DAYS = ["2026-09-29", "2026-09-30", "2026-10-01"];

const R = W.createRunner("B12 C: invoice_paid_days, the days each invoice pays");

(async () => {
	await R.test("C1 Claims are written in the same transaction as the invoice row: one row per paid day for the new invoice; when the write fails (the PDF rename), neither the invoice nor any claim is saved", async ({ eq }) => {
		const w = rayWorld();
		const g = await W.generate(w, RAY, W39);
		eq("invoice status", g.status, 200);
		eq("claims for the invoice", claims(w, "WHERE invoice_id = ?", g.invoice && g.invoice.id), W39_DAYS.map((day) => ({ driver_norm: "ray vos", day, invoice_id: g.invoice && g.invoice.id })));
		const w2 = rayWorld();
		w2.fsFail.rename = true;
		const bad = await W.generate(w2, RAY, W39);
		eq("failed write: not 200", bad.status === 200, false);
		eq("failed write: no invoice row and no claim", [invoiceCount(w2), claims(w2).length], [0, 0]);
	});

	await R.test("C2 A second invoice claiming a held day answers 409 INVOICE_DAY_ALREADY_PAID naming the holder and writes nothing: a manual invoice naming a day the weekly invoice holds, and a claim that lands while the weekly invoice renders (re-checked in its transaction, never a 500)", async ({ eq, ok }) => {
		const w = rayWorld();
		const g = await W.generate(w, RAY, W39);
		const before = [invoiceCount(w), claims(w).length];
		const m = await manual(w, RAY, ["2026-09-30"], ["2026-09-30", "2026-09-30"]);
		eq("manual: status and code", [m.status, m.body && m.body.code], [409, "INVOICE_DAY_ALREADY_PAID"]);
		ok("manual: the error names the holder", String(m.body && m.body.error).includes(g.invoice && g.invoice.invoice_number), JSON.stringify(m.body));
		eq("manual: nothing written", [invoiceCount(w), claims(w).length], before);

		const w2 = rayWorld();
		w2.renderHook = () => {
			if (!W.hasTable(w2.db, "invoice_paid_days")) throw new Error("table invoice_paid_days does not exist yet (the fix adds it)");
			const id = w2.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name, load_ids, expense_ids, render_data, is_manual, created_by)
				VALUES ('INV-M-RV-2026W40-01', 'ray vos', '2026-10-01', '2026-10-01', 1, 0, 260, 0, 'Draft', 'INV-M-RV-2026W40-01.pdf', '[]', '[]', '{}', 1, 'super_admin')`).run().lastInsertRowid;
			w2.db.prepare("INSERT INTO invoice_paid_days (driver_norm, day, invoice_id) VALUES ('ray vos', '2026-10-01', ?)").run(id);
			w2.renderHook = null;
		};
		const race = await W.generate(w2, RAY, W39);
		eq("race: status and code", [race.status, race.body && race.body.code], [409, "INVOICE_DAY_ALREADY_PAID"]);
		ok("race: the error names the holder", /INV-M-RV-2026W40-01/.test(String(race.body && race.body.error)), JSON.stringify(race.body));
		eq("race: no weekly invoice written; the racing claim stands", [w2.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE is_manual = 0").get().n, claims(w2).map((r) => r.day)], [0, ["2026-10-01"]]);
	});

	await R.test("C3 Draft regenerate: the old Draft's rows are deleted and the new rows written in one transaction; a failed render leaves the rows as they were", async ({ eq }) => {
		const w = rayWorld();
		const first = await W.generate(w, RAY, W39);
		eq("first Draft claims", claimDays(w, first.invoice && first.invoice.id), W39_DAYS);
		w.addOverrides([{ driver: RAY, day: "2026-09-30", action: "remove" }]);
		const second = await W.generate(w, RAY, W39);
		eq("regenerated: every row is the new Draft's", claims(w), ["2026-09-29", "2026-10-01"].map((day) => ({ driver_norm: "ray vos", day, invoice_id: second.invoice && second.invoice.id })));
		const snapshot = claims(w);
		w.renderHook = () => { throw new Error("render failed (test)"); };
		const failed = await W.generate(w, RAY, W39);
		eq("failed render: not 200", failed.status === 200, false);
		eq("failed render: rows unchanged", claims(w), snapshot);
	});

	await R.test("C4 Soft delete releases the invoice's rows; a Rejected invoice keeps them (N1)", async ({ eq }) => {
		const w = rayWorld();
		const g = await W.generate(w, RAY, W39);
		const id = g.invoice && g.invoice.id;
		w.db.prepare("UPDATE invoices SET status = 'Rejected', rejection_note = 'test' WHERE id = ?").run(id);
		eq("Rejected keeps its days", claimDays(w, id), W39_DAYS);
		const del = await W.route(w, "DELETE /api/invoices/:id", { params: { id: String(id) }, query: { reason: "test" } });
		eq("soft delete: 200", del.status, 200);
		eq("soft delete releases them", claimDays(w, id), []);
	});

	await R.test("C5 Restore re-claims the days when they are free, and answers 409 when one was claimed since (the invoice stays deleted, the newer claim stands)", async ({ eq }) => {
		const w = rayWorld();
		const g = await W.generate(w, RAY, W39);
		const id = String(g.invoice && g.invoice.id);
		await W.route(w, "DELETE /api/invoices/:id", { params: { id }, query: { reason: "test" } });
		const back = await W.route(w, "PUT /api/invoices/:id/restore", { params: { id } });
		eq("free: restored", back.status, 200);
		eq("free: re-claimed", claimDays(w, Number(id)), W39_DAYS);
		await W.route(w, "DELETE /api/invoices/:id", { params: { id }, query: { reason: "test" } });
		const m = await manual(w, RAY, ["2026-09-30"], ["2026-09-30", "2026-09-30"]);
		eq("a manual invoice claims 9/30 meanwhile", m.status, 200);
		const again = await W.route(w, "PUT /api/invoices/:id/restore", { params: { id } });
		eq("taken: 409", again.status, 409);
		eq("taken: still deleted, nothing re-claimed", [!!w.db.prepare("SELECT deleted_at FROM invoices WHERE id = ?").get(Number(id)).deleted_at, claimDays(w, Number(id))], [true, []]);
		eq("taken: the manual invoice keeps 9/30", claims(w).map((r) => [r.day, r.invoice_id]), [["2026-09-30", m.body && m.body.invoice && m.body.invoice.id]]);
	});

	await R.test("C6 A manual invoice with `days` claims them; without `days` it claims none, as today", async ({ eq }) => {
		const w = rayWorld();
		const withDays = await manual(w, RAY, ["2026-10-05", "2026-10-06"]);
		eq("with days: 200", withDays.status, 200);
		const id = withDays.body && withDays.body.invoice && withDays.body.invoice.id;
		eq("with days: claimed", claims(w, "WHERE invoice_id = ?", id), ["2026-10-05", "2026-10-06"].map((day) => ({ driver_norm: "ray vos", day, invoice_id: id })));
		const without = await manual(w, RAY, null, ["2026-10-12", "2026-10-13"]);
		eq("without days: 200 and no claim", [without.status, claimDays(w, without.body && without.body.invoice && without.body.invoice.id)], [200, []]);
	});

	await R.test("C7 \"Dana  Vale\" (double space) and \"dana vale\" are one key (normalizeDriverName()): the weekly invoice's rows carry \"dana vale\", and a manual invoice for \"dana vale\" naming a held day is refused", async ({ eq }) => {
		const D = "Dana Vale";
		const w = W.startWorld({
			env: TRIP(),
			drivers: [{ name: D }],
			rows: [loadRow({ id: "C701", driver: D, pickup: "2026-09-29 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-29", done: "2026-09-30", truck: "T1" })],
			status: [s("C701", "At Shipper", "2026-09-29 13:00:00"), s("C701", "Delivered", "2026-09-30 20:00:00")],
		});
		const g = await W.generate(w, "Dana  Vale", W39);
		eq("weekly rows keyed dana vale", claims(w).map((r) => [r.driver_norm, r.day]), [["dana vale", "2026-09-29"], ["dana vale", "2026-09-30"]]);
		const m = await manual(w, "dana vale", ["2026-09-30"], ["2026-09-30", "2026-09-30"]);
		eq("manual for the other spelling: refused", [m.status, m.body && m.body.code], [409, "INVOICE_DAY_ALREADY_PAID"]);
		eq("the holder is the weekly invoice", claims(w).every((r) => r.invoice_id === (g.invoice && g.invoice.id)), true);
	});

	await R.test("C8 Backfill (scripts/backfill-invoice-paid-days.js): one row per paid grid day of every live weekly invoice, Rejected included, soft-deleted and manual skipped; --dry-run prints the rows and writes nothing; a second run writes nothing more", async ({ eq, ok }) => {
		const A = "Abe Nolt";
		const B = "Bev Orr";
		const w = W.startWorld({
			env: {},
			drivers: [{ name: A }, { name: B }],
			rows: [
				loadRow({ id: "C801", driver: A, pickup: "2026-09-22 8:00", dropoff: "2026-09-23 18:00", assigned: "2026-09-22", done: "2026-09-23", truck: "T1" }),
				loadRow({ id: "C802", driver: A, pickup: "2026-09-29 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-29", done: "2026-09-30", truck: "T1" }),
				loadRow({ id: "C803", driver: B, pickup: "2026-10-01 8:00", dropoff: "2026-10-01 18:00", assigned: "2026-10-01", done: "2026-10-01", truck: "T2" }),
			],
		});
		const rejected = await W.generate(w, A, W38);
		const live = await W.generate(w, A, W39);
		const gone = await W.generate(w, B, W39);
		await manual(w, A, null, ["2026-10-05", "2026-10-05"]);
		w.db.prepare("UPDATE invoices SET status = 'Rejected' WHERE id = ?").run(rejected.invoice.id);
		w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(live.invoice.id);
		w.db.prepare("UPDATE invoices SET deleted_at = '2026-10-05T12:00:00.000Z', deleted_by = 'super_admin' WHERE id = ?").run(gone.invoice.id);
		const want = [
			["abe nolt", "2026-09-22", rejected.invoice.id], ["abe nolt", "2026-09-23", rejected.invoice.id],
			["abe nolt", "2026-09-29", live.invoice.id], ["abe nolt", "2026-09-30", live.invoice.id],
		];
		const copy = W.saveCopy(w, TRIP());
		const hashBefore = W.fileHash(copy.db);
		const dry = W.runScript("scripts/backfill-invoice-paid-days.js", [`--db=${copy.db}`, `--env-file=${copy.envFile}`, "--dry-run"]);
		eq("dry run: exit 0", dry.code, 0);
		ok("dry run: prints every row (day and invoice number)", [[rejected, "2026-09-22"], [rejected, "2026-09-23"], [live, "2026-09-29"], [live, "2026-09-30"]]
			.every(([g, day]) => dry.stdout.includes(day) && dry.stdout.includes(g.invoice.invoice_number)), (dry.stderr || dry.stdout).slice(0, 300));
		ok("dry run: names neither the soft-deleted nor the manual invoice", !dry.stdout.includes(gone.invoice.invoice_number) && !/INV-M-/.test(dry.stdout), dry.stdout.slice(0, 300));
		eq("dry run: the database file is unchanged", W.fileHash(copy.db), hashBefore);
		const real = W.runScript("scripts/backfill-invoice-paid-days.js", [`--db=${copy.db}`, `--env-file=${copy.envFile}`]);
		eq("backfill: exit 0", real.code, 0);
		const read = () => {
			const db = new W.Database(copy.db, { readonly: true });
			try { return W.hasTable(db, "invoice_paid_days") ? db.prepare("SELECT driver_norm, day, invoice_id FROM invoice_paid_days ORDER BY day").all().map((r) => [r.driver_norm, r.day, r.invoice_id]) : null; } finally { db.close(); }
		};
		eq("backfill: the rows", read(), want);
		const again = W.runScript("scripts/backfill-invoice-paid-days.js", [`--db=${copy.db}`, `--env-file=${copy.envFile}`]);
		eq("second run: exit 0 and the same rows", [again.code, read()], [0, want]);
	});

	await R.test("C9 [Q16, revised 2026-10-14 and 2026-10-15] Late-day limits, each refused day named in `warnings`: a load settling before FROM, a week with no invoice (the stored marker of the rule's first invoice no longer limits: late days start at FROM's first week), a day another live invoice holds, a day in a closed month (invoiceMonthLockBlockers()); a day within every limit goes on its own week's invoice (W39, a Draft) or, when that week touches a closed month, on a correction for it, never on W40", async ({ eq, ok }) => {
		const warned = (g, day) => (g.warnings || []).some((x) => String(x).includes(day));
		// (a) FROM=2026-10: a Sep-assigned load completed after W39 is refused; an Oct-assigned one is carried.
		{
			const D = "Sam Ure";
			const w = W.startWorld({
				env: TRIP("2026-10"),
				drivers: [{ name: D }],
				rows: [
					loadRow({ id: "C900", driver: D, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
					loadRow({ id: "C901", driver: D, pickup: "2026-09-30 8:00", dropoff: "2026-10-03 12:00", assigned: "2026-09-30", done: "", status: "In Transit", truck: "T1" }),
					loadRow({ id: "C902", driver: D, pickup: "2026-10-02 8:00", dropoff: "2026-10-02 18:00", assigned: "2026-10-02", done: "", status: "In Transit", truck: "T1" }),
				],
				status: [s("C900", "At Shipper", "2026-09-28 12:00:00"), s("C900", "Delivered", "2026-09-29 21:00:00"), s("C901", "At Shipper", "2026-09-30 13:00:00"), s("C902", "At Shipper", "2026-10-02 12:00:00")],
				now: etMs("2026-10-02 20:00"),
			});
			const g39 = await W.generate(w, D, W39);
			w.addStatus([s("C901", "Delivered", "2026-10-03 16:00:00"), s("C902", "Delivered", "2026-10-03 02:00:00")]);
			w.setRow("C901", { "Job Status": "Delivered", "Status Update Date": "10/3/2026", "Completion Date": "10/3/2026" });
			w.setRow("C902", { "Job Status": "Delivered", "Status Update Date": "10/2/2026", "Completion Date": "10/2/2026" });
			w.clock.ms = etMs("2026-10-09 20:00");
			const g = await W.generate(w, D, W40);
			eq("(a) W39 gains only the Oct-assigned load's 10/2; W40 carries no earlier day", [storedGrid(w, g39.invoice.id, W39).map((e) => [e.day, e.loads]), g.data && g.data.earlierDays],
				[[["2026-09-28", ["C900"]], ["2026-09-29", ["C900"]], ["2026-10-02", ["C902"]]], undefined]);
			ok("(a) the Sep-assigned load's 9/30 and 10/1 are named in warnings", warned(g, "2026-09-30") && warned(g, "2026-10-01"), JSON.stringify(g.warnings));
		}
		// (b) the stored marker of the rule's first invoice is 2026-10-03, and it no
		// longer limits (the floor is FROM's first week): 10/1 and 10/2 are named
		// because their week, W39, has no invoice; the marker is not rewritten.
		{
			const D = "Tia Voss";
			const w = W.startWorld({
				env: TRIP(),
				drivers: [{ name: D }],
				rows: [loadRow({ id: "C911", driver: D, pickup: "2026-10-01 8:00", dropoff: "2026-10-03 12:00", assigned: "2026-10-01", done: "2026-10-03", truck: "T1" })],
				status: [s("C911", "At Shipper", "2026-10-01 13:00:00"), s("C911", "Delivered", "2026-10-03 16:00:00")],
				now: etMs("2026-10-09 20:00"),
			});
			w.db.prepare("INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ('trip_work_days_started_at', '2026-10-03', '2026-10-03T00:00:00.000Z', 'system')").run();
			const g = await W.generate(w, D, W40);
			eq("(b) grid 10/3, no earlier day, no correction", [W.dayList(W.gridDays(g.data, W40)), g.data && g.data.earlierDays, corrections(w).length], [["2026-10-03"], undefined, 0]);
			ok("(b) 10/1 and 10/2 named in warnings: their week has no invoice", (g.warnings || []).some((x) => x.includes("2026-10-01") && x.includes("2026-10-02") && /has no invoice/.test(x)), JSON.stringify(g.warnings));
			eq("(b) the marker stays 2026-10-03", marker(w), "2026-10-03");
		}
		// (c) a day a live manual invoice holds is refused; the next day is carried.
		{
			const D = "Uma West";
			const w = W.startWorld({
				env: TRIP(),
				drivers: [{ name: D }],
				rows: [
					loadRow({ id: "C920", driver: D, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
					loadRow({ id: "C921", driver: D, pickup: "2026-10-01 8:00", dropoff: "2026-10-03 12:00", assigned: "2026-10-01", done: "", status: "In Transit", truck: "T1" }),
				],
				status: [s("C920", "At Shipper", "2026-09-28 12:00:00"), s("C920", "Delivered", "2026-09-29 21:00:00"), s("C921", "At Shipper", "2026-10-01 13:00:00")],
				now: etMs("2026-10-02 20:00"),
			});
			const g39 = await W.generate(w, D, W39);
			const m = await manual(w, D, ["2026-10-01"], ["2026-10-01", "2026-10-01"]);
			eq("(c) the manual invoice holds 10/1", m.status, 200);
			w.addStatus([s("C921", "Delivered", "2026-10-03 16:00:00")]);
			w.setRow("C921", { "Job Status": "Delivered", "Status Update Date": "10/3/2026", "Completion Date": "10/3/2026" });
			w.clock.ms = etMs("2026-10-09 20:00");
			const g = await W.generate(w, D, W40);
			eq("(c) W39 gains 10/2 only; W40 carries no earlier day", [W.dayList(storedGrid(w, g39.invoice.id, W39)), g.data && g.data.earlierDays], [["2026-09-28", "2026-09-29", "2026-10-02"], undefined]);
			ok("(c) the held 10/1 is named in warnings", warned(g, "2026-10-01"), JSON.stringify(g.warnings));
		}
		// (d) September closed: 9/30 is refused, 10/1 and 10/2 are carried.
		{
			const D = "Val Xu";
			const w = W.startWorld({
				env: TRIP(),
				drivers: [{ name: D }],
				rows: [
					loadRow({ id: "C930", driver: D, pickup: "2026-09-28 8:00", dropoff: "2026-09-29 18:00", assigned: "2026-09-28", done: "2026-09-29", truck: "T1" }),
					loadRow({ id: "C931", driver: D, pickup: "2026-09-30 8:00", dropoff: "2026-10-03 12:00", assigned: "2026-09-30", done: "", status: "In Transit", truck: "T1" }),
				],
				status: [s("C930", "At Shipper", "2026-09-28 12:00:00"), s("C930", "Delivered", "2026-09-29 21:00:00"), s("C931", "At Shipper", "2026-09-30 13:00:00")],
				now: etMs("2026-10-02 20:00"),
			});
			const g39 = await W.generate(w, D, W39);
			w.lock(["2026-09"]);
			w.addStatus([s("C931", "Delivered", "2026-10-03 16:00:00")]);
			w.setRow("C931", { "Job Status": "Delivered", "Status Update Date": "10/3/2026", "Completion Date": "10/3/2026" });
			w.clock.ms = etMs("2026-10-09 20:00");
			const g = await W.generate(w, D, W40);
			eq("(d) W39 (its week touches closed September) is left as made; 10/1 and 10/2 go on a correction dated 10/1-10/2; W40 carries no earlier day",
				[W.dayList(storedGrid(w, g39.invoice.id, W39)), corrections(w).map((c) => [c.week_start, c.week_end, JSON.parse(c.render_data).paidDays]), g.data && g.data.earlierDays],
				[["2026-09-28", "2026-09-29"], [["2026-10-01", "2026-10-02", ["2026-10-01", "2026-10-02"]]], undefined]);
			ok("(d) the closed-month 9/30 is named in warnings", warned(g, "2026-09-30"), JSON.stringify(g.warnings));
		}
	});

	await R.test("C10 (N1) Reject, revert, next week: W39 pays Thu and Fri and is Rejected; W40's run puts them on no invoice and makes no correction (the Rejected invoice still holds them); W39 reverted to Submitted still pays them; Thu and Fri are each paid once", async ({ eq }) => {
		const D = "Wes Yale";
		const w = W.startWorld({
			env: TRIP(),
			drivers: [{ name: D }],
			rows: [
				loadRow({ id: "C1001", driver: D, pickup: "2026-10-01 8:00", dropoff: "2026-10-02 12:00", assigned: "2026-10-01", done: "2026-10-02", truck: "T1" }),
				loadRow({ id: "C1002", driver: D, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T1" }),
			],
			status: [
				s("C1001", "At Shipper", "2026-10-01 13:00:00"), s("C1001", "Delivered", "2026-10-02 20:00:00"),
				s("C1002", "At Shipper", "2026-10-05 12:00:00"), s("C1002", "Delivered", "2026-10-06 21:00:00"),
			],
			now: etMs("2026-10-02 20:30"),
		});
		const g39 = await W.generate(w, D, W39);
		const id = g39.invoice && g39.invoice.id;
		w.db.prepare("UPDATE invoices SET status = 'Rejected', rejection_note = 'test' WHERE id = ?").run(id);
		eq("the Rejected W39 still holds Thu and Fri", claimDays(w, id), ["2026-10-01", "2026-10-02"]);
		w.clock.ms = etMs("2026-10-09 20:00");
		const g40 = await W.generate(w, D, W40);
		eq("W40 carries neither Thu nor Fri, and no correction is made", [W.dayList(W.earlierDays(g40.data)), corrections(w).length], [[], 0]);
		const rev = await W.route(w, "PUT /api/invoices/:id/revert", { params: { id: String(id) }, body: { reason: "test" } });
		eq("revert: Submitted", [rev.status, rev.body && rev.body.invoice && rev.body.invoice.status], [200, "Submitted"]);
		const w39data = JSON.parse(w.db.prepare("SELECT render_data FROM invoices WHERE id = ?").get(id).render_data);
		eq("the reverted W39 still pays Thu and Fri", W.dayList(W.gridDays(w39data, W39)), ["2026-10-01", "2026-10-02"]);
		const paid = [...W.gridDays(w39data, W39), ...W.gridDays(g40.data, W40), ...W.earlierDays(g40.data)].map((e) => e.day).filter((d) => d === "2026-10-01" || d === "2026-10-02");
		eq("Thu and Fri each paid once", paid.sort(), ["2026-10-01", "2026-10-02"]);
		eq("their claims stay with W39", claims(w, "WHERE day IN ('2026-10-01', '2026-10-02')").map((r) => r.invoice_id), [id, id]);
	});

	await R.test("C11 The floor marker trip_work_days_started_at is written once, in the first rule invoice's transaction (2026-09-26 for W39): not by a failed render before it; never changed by a Draft regenerate, a later invoice or a later failed render", async ({ eq }) => {
		const D = "Xia Zane";
		const w = W.startWorld({
			env: TRIP(),
			drivers: [{ name: D }],
			rows: [
				loadRow({ id: "C1101", driver: D, pickup: "2026-09-29 8:00", dropoff: "2026-09-30 18:00", assigned: "2026-09-29", done: "2026-09-30", truck: "T1" }),
				loadRow({ id: "C1102", driver: D, pickup: "2026-10-05 8:00", dropoff: "2026-10-06 18:00", assigned: "2026-10-05", done: "2026-10-06", truck: "T1" }),
			],
			status: [
				s("C1101", "At Shipper", "2026-09-29 13:00:00"), s("C1101", "Delivered", "2026-09-30 20:00:00"),
				s("C1102", "At Shipper", "2026-10-05 12:00:00"), s("C1102", "Delivered", "2026-10-06 21:00:00"),
			],
		});
		w.renderHook = () => { throw new Error("render failed (test)"); };
		await W.generate(w, D, W39);
		eq("after a failed first render: no marker", marker(w), null);
		w.renderHook = null;
		await W.generate(w, D, W39);
		eq("after the first rule invoice (W39)", marker(w), "2026-09-26");
		await W.generate(w, D, W39);
		eq("after a Draft regenerate", marker(w), "2026-09-26");
		await W.generate(w, D, W40);
		eq("after W40", marker(w), "2026-09-26");
		w.renderHook = () => { throw new Error("render failed (test)"); };
		await W.generate(w, D, "2026-10-16");
		eq("after a later failed render", marker(w), "2026-09-26");
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
