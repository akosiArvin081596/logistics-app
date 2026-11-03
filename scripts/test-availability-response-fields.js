#!/usr/bin/env node
// The availability fields the dispatch screens read (R11), with
// DRIVER_AVAILABILITY_ENABLED on:
//
//   GET /api/dashboard        `offUntil` per fleet entry (the Fleet & Drivers
//                             pill) and an `offUntil` map by driver name (the
//                             Job Board and reassign dropdowns): the last day off
//                             of a driver off today, back-to-back rows joined
//   GET /api/trucks           `DriverOffUntil` per truck for a Super Admin or a
//                             Dispatcher; for an Investor, and for a Super Admin
//                             previewing an investor's portal, the key is NOT
//                             PRESENT (the owner's rule: investors see nothing
//                             of a driver's time off)
//   GET /api/drivers-directory `OffFrom` / `OffTo` per driver: the row covering
//                             today, else the next one (the directory chip)
//
// A driver's request (plan B Revision 2, PR 4) shows in none of them until it is
// approved: a waiting or declined one sets no offUntil, DriverOffUntil or chip.
//
// "Today" is 2026-10-15 on the business clock. The routes are the shipped ones,
// lifted out of server.js (scripts/lib/availability-world.js). With the flag
// off none of these keys is sent at all: scripts/test-driver-availability-flag-off.js.
// Run: node scripts/test-availability-response-fields.js

"use strict";

const W = require("./lib/availability-world");

const R = W.createRunner("test-availability-response-fields");
const { ok, eq, section } = R;
const { USERS, DIR } = W;

const off = (w, dirId, from, to) => w.call("POST", `/api/drivers-directory/${dirId}/availability`, { body: { kind: "vacation", from, to } });
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

(async () => {
	const w = await W.startWorld();
	await off(w, DIR.hollis, "2026-10-14", "2026-10-20");
	await off(w, DIR.hollis, "2026-10-21", "2026-10-23");
	await off(w, DIR.tamsin, "2026-11-01", "2026-11-03");

	section("GET /api/dashboard");
	await R.guard("dashboard", async () => {
		for (const user of [USERS.sa, USERS.disp]) {
			const r = await w.call("GET", "/api/dashboard", { user });
			eq(`${user.role}: 200`, r.status, 200);
			const fleet = (r.body && r.body.fleet) || [];
			const entry = (name) => fleet.find((f) => f.Driver === name);
			eq(`${user.role}: Hollis's fleet entry is off until Oct 23 (Oct 14-20 and Oct 21-23 joined)`, entry("Hollis Renner") && entry("Hollis Renner").offUntil, "2026-10-23");
			eq(`${user.role}: Soren's is not off (offUntil null, key present)`, [has(entry("Soren King"), "offUntil"), entry("Soren King") && entry("Soren King").offUntil], [true, null]);
			eq(`${user.role}: Tamsin, off only from Nov 1, is not off today`, entry("Tamsin Vale") && entry("Tamsin Vale").offUntil, null);
			eq(`${user.role}: the dropdowns' map names only the drivers off today`, r.body && r.body.offUntil, { "Hollis Renner": "2026-10-23" });
			eq(`${user.role}: the fleet pill's status is left as it was`, entry("Hollis Renner") && entry("Hollis Renner").Status, "Queued");
		}
	});

	section("GET /api/trucks");
	await R.guard("trucks", async () => {
		for (const user of [USERS.sa, USERS.disp]) {
			const r = await w.call("GET", "/api/trucks", { user });
			const t = (unit) => ((r.body && r.body.trucks) || []).find((x) => x.UnitNumber === unit);
			eq(`${user.role}: #91 (Hollis's) DriverOffUntil Oct 23; #33 null`, [r.status, t("LogisX-#91") && t("LogisX-#91").DriverOffUntil, has(t("LogisX-#33"), "DriverOffUntil"), t("LogisX-#33") && t("LogisX-#33").DriverOffUntil], [200, "2026-10-23", true, null]);
		}
		const inv = await w.call("GET", "/api/trucks", { user: USERS.inv });
		const invTrucks = (inv.body && inv.body.trucks) || [];
		eq("Investor: 200 with both of his trucks", [inv.status, invTrucks.length], [200, 2]);
		ok("Investor: no truck carries a DriverOffUntil key", invTrucks.every((t) => !has(t, "DriverOffUntil")));
		ok("Investor: no off date anywhere in the response", !/2026-10-2[0-3]/.test(inv.text));
		const preview = await w.call("GET", "/api/trucks?as_user_id=5", { user: USERS.sa });
		ok("Super Admin previewing the investor's portal: 200 and no DriverOffUntil key",
			preview.status === 200 && ((preview.body && preview.body.trucks) || []).length === 2 && preview.body.trucks.every((t) => !has(t, "DriverOffUntil")));
	});

	section("GET /api/drivers-directory");
	await R.guard("directory", async () => {
		const r = await w.call("GET", "/api/drivers-directory", { user: USERS.disp });
		const d = (name) => ((r.body && r.body.data) || []).find((x) => x.Driver === name);
		eq("Hollis: off now, Oct 14 through Oct 23", d("Hollis Renner") && [d("Hollis Renner").OffFrom, d("Hollis Renner").OffTo], ["2026-10-14", "2026-10-23"]);
		eq("Tamsin: the next row, Nov 1-3", d("Tamsin Vale") && [d("Tamsin Vale").OffFrom, d("Tamsin Vale").OffTo], ["2026-11-01", "2026-11-03"]);
		eq("Soren: none (keys present, null)", d("Soren King") && [has(d("Soren King"), "OffFrom"), d("Soren King").OffFrom, d("Soren King").OffTo], [true, null, null]);
	});

	// PR 4: a driver's request shows nowhere until it is approved (the requests
	// flag off here: the filter is not behind it). Hollis's own request for
	// Oct 14-20 is approved; Soren's for Oct 14-16 waits; Tamsin's for Oct 15 was
	// declined. Each written as the request routes leave it.
	section("A driver's request: only an approved one shows (PR 4)");
	await R.guard("requests", async () => {
		const q = await W.startWorld();
		const asked = (dir, name, from, to, status) => q.db.prepare(`INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, reason, created_by, created_by_user_id, created_at,
			request_status, source, decided_by, decided_at) VALUES (?, ?, 'off_duty', ?, ?, '', 'driver', 0, '2026-10-05T12:00:00Z', ?, 'driver', ?, ?)`)
			.run(dir, name, from, to, status, status === "requested" ? null : "dispatch_t", status === "requested" ? null : "2026-10-06T12:00:00Z");
		asked(DIR.hollis, "Hollis Renner", "2026-10-14", "2026-10-20", "approved");
		asked(DIR.soren, "Soren King", "2026-10-14", "2026-10-16", "requested");
		asked(DIR.tamsin, "Tamsin Vale", "2026-10-15", "2026-10-15", "declined");
		const dash = await q.call("GET", "/api/dashboard", { user: USERS.disp });
		const entry = (name) => ((dash.body && dash.body.fleet) || []).find((f) => f.Driver === name) || {};
		eq("dashboard: the dropdowns' map names only Hollis; Soren's and Tamsin's pills are not off",
			[dash.body && dash.body.offUntil, entry("Soren King").offUntil, entry("Tamsin Vale").offUntil], [{ "Hollis Renner": "2026-10-20" }, null, null]);
		const trucks = await q.call("GET", "/api/trucks", { user: USERS.disp });
		const t = (unit) => ((trucks.body && trucks.body.trucks) || []).find((x) => x.UnitNumber === unit) || {};
		eq("trucks: #91 (Hollis, approved) off until Oct 20; #33 (Soren, waiting) not off", [t("LogisX-#91").DriverOffUntil, t("LogisX-#33").DriverOffUntil], ["2026-10-20", null]);
		const dir = await q.call("GET", "/api/drivers-directory", { user: USERS.disp });
		const d = (name) => ((dir.body && dir.body.data) || []).find((x) => x.Driver === name) || {};
		eq("directory: Hollis's chip Oct 14-20; none for Soren or Tamsin", [[d("Hollis Renner").OffFrom, d("Hollis Renner").OffTo], [d("Soren King").OffFrom, d("Soren King").OffTo], [d("Tamsin Vale").OffFrom, d("Tamsin Vale").OffTo]],
			[["2026-10-14", "2026-10-20"], [null, null], [null, null]]);
		const inv = await q.call("GET", "/api/trucks", { user: USERS.inv });
		ok("Investor: still no DriverOffUntil key, and no request key, on any truck", ((inv.body && inv.body.trucks) || []).every((x) => !has(x, "DriverOffUntil") && !has(x, "request")) && inv.status === 200);
	});

	await R.finish();
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
