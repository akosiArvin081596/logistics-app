#!/usr/bin/env node
/**
 * B12 runner F: the trip-work-days dry run (plan section 4.1(9), L5, cases
 * F1-F4). FAILING TESTS WRITTEN BEFORE THE FIX: on main neither the route nor
 * the script exists.
 *
 * The contract (from the plan): GET /api/admin/work-days/dry-run?from=&to=
 * (Super Admin) and scripts/work-days-dry-run.js (--json, runnable on the server
 * over ssh: --db=<copy> --values-json=<file> --env-file=<file> --from= --to=, the
 * shape of scripts/payout-rules-dry-run.js). Read-only. It shows, current vs the
 * rule:
 *   - per driver-day: the load and timestamp behind the day, and its flags;
 *   - per invoice: days and $ difference;
 *   - per investor-month: driver pay and payout difference at the split;
 *   - the backfill rows and the refused late days (a late day goes on its own week's invoice or a correction, never on a later invoice: the owner's rule of 2026-10-14).
 * The plan names the parameters, not their form: these cases pass from=to=2026-10,
 * which reads the same as a month range or as a candidate FROM (TRIP_WORK_DAYS_FROM
 * is 2026-10 in the env, the flag off). The output's field names are the fix's
 * choice: the cases look for the values anywhere in the JSON.
 *
 * Fixture (investor 5, $260 a day, split 50%), made-up data only:
 *   F101  Ann Vey   no appointments, no Assigned Date; At Shipper Tue 10/6 09:00 ET,
 *                   Delivered Wed 10/7: today 0 days, the rule 10/6-10/7 (October)
 *   F105  Ann Vey   Assigned 9/30 (before FROM), appointments 10/1-10/3, completed
 *                   after W39: its 10/1 and 10/2 are refused late days
 *   F201  Bo Wyn    Assigned 10/5, $5,000 (October revenue); F202 Bo Wyn 9/15
 *   Invoices made today: Bo, week 9/12-9/18 (9/15); Ann W40 (10/3, $260); Bo W40 (10/5)
 *   Expected: Ann's W40 +2 days, +$520; October driver pay +$520, payout -$260;
 *   backfill rows include Bo 2026-09-15 on his 9/12-9/18 invoice.
 *
 * Shipping code lifted from server.js (lib/work-days-world.js beside this runner).
 * Pure: no server, no app.db, no network.
 * Run: node scripts/pending/test-work-days-dry-run.js    # exits 1 on failure (scripts/test-work-days-dry-run.js once enabled)
 */
"use strict";
process.env.TZ = "UTC";
const W = require("./lib/work-days-world");
const { loadRow, etMs } = W;

const ENV = { TRIP_WORK_DAYS_FROM: "2026-10" };
const s = (lid, status, at, source = "manual", actor = "") => [lid, status, source, at, actor];
const ANN = "Ann Vey";
const BO = "Bo Wyn";

async function fixture() {
	const w = W.startWorld({
		env: ENV,
		drivers: [{ name: ANN }, { name: BO }],
		rows: [
			loadRow({ id: "F101", driver: ANN, done: "2026-10-07", truck: "T1" }),
			loadRow({ id: "F105", driver: ANN, pickup: "2026-10-01 8:00", dropoff: "2026-10-03 12:00", assigned: "2026-09-30", done: "", status: "In Transit", truck: "T1" }),
			loadRow({ id: "F201", driver: BO, pickup: "2026-10-05 8:00", dropoff: "2026-10-05 18:00", assigned: "2026-10-05", done: "2026-10-05", truck: "T2", payment: "$5,000.00" }),
			loadRow({ id: "F202", driver: BO, pickup: "2026-09-15 8:00", dropoff: "2026-09-15 18:00", assigned: "2026-09-15", done: "2026-09-15", truck: "T2" }),
		],
		status: [s("F101", "At Shipper", "2026-10-06 13:00:00"), s("F101", "Delivered", "2026-10-07 20:00:00"), s("F105", "At Shipper", "2026-10-01 13:00:00")],
		now: etMs("2026-10-02 20:00"),
	});
	const boEarly = await W.generate(w, BO, "2026-09-18");
	w.addStatus([s("F105", "Delivered", "2026-10-03 16:00:00")]);
	w.setRow("F105", { "Job Status": "Delivered", "Status Update Date": "10/3/2026", "Completion Date": "10/3/2026" });
	w.clock.ms = etMs("2026-10-09 20:00");
	const ann40 = await W.generate(w, ANN, "2026-10-09");
	const bo40 = await W.generate(w, BO, "2026-10-09");
	return { w, boEarly, ann40, bo40 };
}
// The route's body and the script's JSON, each with what it read and left.
async function outputs() {
	const f = await fixture();
	const before = W.tableHashes(f.w.db);
	const route = await W.route(f.w, "GET /api/admin/work-days/dry-run", { query: { from: "2026-10", to: "2026-10" } });
	const after = W.tableHashes(f.w.db);
	const copy = W.saveCopy(f.w, ENV);
	const fileBefore = W.fileHash(copy.db);
	const script = W.runScript("scripts/work-days-dry-run.js", [`--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, "--from=2026-10", "--to=2026-10", "--json"]);
	return { f, route, routeTables: [before, after], script, scriptFile: [fileBefore, W.fileHash(copy.db)] };
}
const numbers = (o) => Object.values(o).filter((x) => typeof x === "number").map((x) => Math.abs(x));
const hasAmount = (o, dollars) => numbers(o).some((n) => n === dollars || n === dollars * 100);
function sources(o) {
	const out = [];
	if (o.route.status === 200 && o.route.body) out.push(["route", o.route.body]);
	if (o.script.code === 0 && o.script.json) out.push(["script", o.script.json]);
	return out;
}
function requireBoth(ok, o) {
	ok("route answers 200 with a body", o.route.status === 200 && !!o.route.body, JSON.stringify(o.route.body).slice(0, 200));
	ok("script exits 0 with JSON", o.script.code === 0 && !!o.script.json, (o.script.stderr || o.script.stdout).slice(0, 200));
}

const R = W.createRunner("B12 F: the work-days dry run (route and script)");

(async () => {
	let shared = null;
	const get = async () => (shared || (shared = await outputs()));

	await R.test("F1 Read-only: the route changes no row in any table; the script leaves its database file byte for byte", async ({ eq, ok }) => {
		const o = await get();
		requireBoth(ok, o);
		eq("route: every table as before", o.routeTables[1], o.routeTables[0]);
		eq("script: the database file unchanged", o.scriptFile[1], o.scriptFile[0]);
	});

	await R.test("F2 Per-day lines carry the load, the timestamp behind the day and its flags (Ann Vey 2026-10-06: load F101, At Shipper 2026-10-06 13:00:00 UTC)", async ({ ok }) => {
		const o = await get();
		requireBoth(ok, o);
		for (const [name, json] of sources(o)) {
			const line = W.objects(json).find((x) => W.scalars(x).includes("2026-10-06") && W.scalars(x).includes("F101"));
			ok(`${name}: a line for 2026-10-06 naming F101`, !!line, JSON.stringify(json).slice(0, 200));
			ok(`${name}: …with the At Shipper timestamp`, !!line && Object.values(line).some((v) => W.sameInstant(v, "2026-10-06 13:00:00")), JSON.stringify(line));
			ok(`${name}: …and its flags`, !!line && Object.keys(line).some((k) => /flag/i.test(k)), JSON.stringify(line));
		}
	});

	await R.test("F3 $ per invoice (Ann's W40: +2 days, +$520) and per investor-month (owner 5, 2026-10: driver pay +$520, payout -$260 at the 50% split)", async ({ ok }) => {
		const o = await get();
		requireBoth(ok, o);
		const number = o.f.ann40.invoice && o.f.ann40.invoice.invoice_number;
		for (const [name, json] of sources(o)) {
			const inv = W.objects(json).find((x) => W.scalars(x).includes(number));
			ok(`${name}: ${number} with its $520 difference`, !!inv && hasAmount(inv, 520), JSON.stringify(inv));
			const month = W.objects(json).find((x) => W.scalars(x).includes("2026-10") && hasAmount(x, 520) && hasAmount(x, 260));
			ok(`${name}: 2026-10 with driver pay $520 and payout $260 differences`, !!month, JSON.stringify(json).slice(0, 200));
		}
	});

	await R.test("F4 The backfill rows (Bo Wyn 2026-09-15 on his 9/12-9/18 invoice) and the refused late days (Ann Vey 2026-10-01 and 2026-10-02 of F105, a load settling before FROM) are listed", async ({ ok }) => {
		const o = await get();
		requireBoth(ok, o);
		const early = o.f.boEarly.invoice && o.f.boEarly.invoice.invoice_number;
		for (const [name, json] of sources(o)) {
			ok(`${name}: backfill row Bo Wyn 2026-09-15 ${early}`, W.objects(json).some((x) => W.scalars(x).includes("2026-09-15") && W.scalars(x).includes(early)), JSON.stringify(json).slice(0, 200));
			for (const day of ["2026-10-01", "2026-10-02"]) {
				ok(`${name}: refused late day ${day}`, W.objects(json).some((x) => W.scalars(x).includes(day) && /F105|ann vey/i.test(JSON.stringify(x)) && Object.keys(x).some((k) => /reason|refus/i.test(k))), JSON.stringify(json).slice(0, 200));
			}
		}
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
