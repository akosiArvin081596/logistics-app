#!/usr/bin/env node
// Driver training videos (DRIVER_TRAINING_VIDEOS_ENABLED, default off): where the
// driver app shows them, decided on the server from the onboarding status alone.
//   §1 trainingVideoPlacement() (lib/driver-training-videos.js): no record → "kit";
//      documents_pending → null; documents_signed → "onboarding"; fully_onboarded →
//      "kit"; any other value (case, blanks, inherited names) → null
//   §2 GET /api/driver/:driverName, the shipped route lifted out of server.js
//      (scripts/lib/availability-world.js), as the driver himself: with the flag
//      unset, "", false, 0, off, no or another word, no trainingVideos key at any
//      status or with no record; with true, 1, yes, on, TRUE or " on ", the
//      placement for his status. Either way the onboarding object carries none of
//      the drug-test columns, and the planted drug-test values appear nowhere
//   §3 a Super Admin reading a driver's page gets "kit": the placement follows the
//      session's own onboarding record (he has none), as the onboarding block does;
//      a driver asking for another driver's page gets 403 and no key
//   §4 the flag is read once, in server.js, with the default-off shape, and the
//      payload names trainingVideos once
// Made-up drivers only (the world's own fixtures).
// Run: node scripts/test-driver-training-videos.js   # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");
const W = require("./lib/availability-world");

const R = W.createRunner("test-driver-training-videos");
const { ok, eq, section } = R;
const { USERS } = W;

const LIB = path.join(W.ROOT, "lib", "driver-training-videos.js");
const HIS = encodeURIComponent("Hollis Renner");
const STATUSES = [null, "documents_pending", "documents_signed", "fully_onboarded"];
const EXPECTED = { null: "kit", documents_pending: null, documents_signed: "onboarding", fully_onboarded: "kit" };
const DRUG_COLUMNS = ["drug_test_result", "drug_test_file_url", "drug_test_uploaded_at"];
// Made-up values planted in the drug-test columns; none may reach the payload.
const PLANTED_FILE = "/uploads/drug-tests/made-up-screen-90210.pdf";
const PLANTED_AT = "2026-10-12T09:30:00Z";

// His onboarding row at `status`, or none (null). Foreign keys are off for the
// plant only: the route reads no application row when application_id is 0.
function plantStatus(w, status) {
	w.db.pragma("foreign_keys = OFF");
	w.db.prepare("DELETE FROM driver_onboarding WHERE user_id = ?").run(USERS.driver.id);
	if (status !== null) {
		w.db.prepare(`INSERT INTO driver_onboarding (user_id, application_id, driver_name, status, drug_test_result, drug_test_file_url, drug_test_uploaded_at, onboarded_at)
			VALUES (?, 0, 'Hollis Renner', ?, 'pass', ?, ?, ?)`)
			.run(USERS.driver.id, status, PLANTED_FILE, PLANTED_AT, status === "fully_onboarded" ? "2026-08-01T12:00:00Z" : "");
	}
}
const page = (w, user = USERS.driver, name = HIS) => w.call("GET", `/api/driver/${name}`, { user });
const said = (r) => `${r.status} ${r.text.slice(0, 160)}`;
// The drug-test columns, or a planted value, anywhere in the answer.
function drugLeaks(r) {
	const leaks = [];
	const ob = r.body && r.body.onboarding;
	if (ob && typeof ob === "object") for (const k of DRUG_COLUMNS) if (k in ob) leaks.push(k);
	for (const v of [PLANTED_FILE, PLANTED_AT, "made-up-screen-90210"]) if (r.text.includes(v)) leaks.push(v);
	return leaks;
}

(async () => {
	section("§1 trainingVideoPlacement()");
	let lib = null;
	try {
		lib = require(LIB);
	} catch (err) {
		ok("§1.0 lib/driver-training-videos.js loads", false, err.message);
	}
	if (lib) {
		const p = lib.trainingVideoPlacement;
		eq("§1.1 no record (null or undefined): kit, the normal app", [p(null), p(undefined)], ["kit", "kit"]);
		eq("§1.2 still signing (documents_pending): nothing", p("documents_pending"), null);
		eq("§1.3 the signing step accepted, waiting on screening (documents_signed): onboarding", p("documents_signed"), "onboarding");
		eq("§1.4 fully onboarded: kit", p("fully_onboarded"), "kit");
		eq("§1.5 anything else: nothing",
			["", " documents_signed", "DOCUMENTS_SIGNED", "Fully_Onboarded", "__proto__", "constructor", "toString", "hasOwnProperty", "approved", 0, 1, true, false, {}, [], NaN].map(p),
			[null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null]);
		eq("§1.6 the map holds exactly the two placements and cannot be changed", [Object.keys(lib.PLACEMENT_BY_STATUS).sort(), Object.isFrozen(lib.PLACEMENT_BY_STATUS)], [["documents_signed", "fully_onboarded"], true]);
	}

	section("§2 the payload: the key only with the flag on, the placement by his status");
	const OFF = [["unset", undefined], ["empty", ""], ["false", "false"], ["0", "0"], ["off", "off"], ["no", "no"], ["another word", "enabled"]];
	const ON = [["true", "true"], ["1", "1"], ["yes", "yes"], ["on", "on"], ["TRUE", "TRUE"], ["\" on \"", " on "]];
	for (const [label, value, on] of [...OFF.map((x) => [...x, false]), ...ON.map((x) => [...x, true])]) {
		await R.guard(`§2 flag ${label}`, async () => {
			const env = value === undefined ? {} : { DRIVER_TRAINING_VIDEOS_ENABLED: value };
			const w = await W.startWorld({ flag: false, routes: ["driverPage"], env });
			try {
				eq(`§2 flag ${label}: the world serves the payload route`, w.found.includes("driverPage"), true);
				for (const status of STATUSES) {
					plantStatus(w, status);
					const r = await page(w);
					const shown = status === null ? "no record" : status;
					if (!ok(`§2 flag ${label}, ${shown}: 200`, r.status === 200, said(r))) continue;
					if (on) {
						eq(`§2 flag ${label}, ${shown}: trainingVideos ${JSON.stringify(EXPECTED[status])}`,
							[Object.prototype.hasOwnProperty.call(r.body, "trainingVideos"), r.body.trainingVideos], [true, EXPECTED[status]]);
					} else {
						eq(`§2 flag ${label}, ${shown}: no trainingVideos key`, Object.prototype.hasOwnProperty.call(r.body, "trainingVideos"), false);
					}
					eq(`§2 flag ${label}, ${shown}: the onboarding record is his own status, or none`, r.body.onboarding ? r.body.onboarding.status : null, status);
					eq(`§2 flag ${label}, ${shown}: no drug-test column or value in the answer`, drugLeaks(r), []);
				}
			} finally {
				await w.close();
			}
		});
	}

	section("§3 whose record decides");
	await R.guard("§3", async () => {
		const w = await W.startWorld({ flag: false, routes: ["driverPage"], env: { DRIVER_TRAINING_VIDEOS_ENABLED: "true" } });
		try {
			plantStatus(w, "documents_signed");
			const admin = await page(w, USERS.sa);
			eq("§3.1 a Super Admin reading his page: 200, kit (the Super Admin has no record), no onboarding",
				[admin.status, admin.body && admin.body.trainingVideos, admin.body && admin.body.onboarding], [200, "kit", null]);
			eq("§3.2 ...and nothing of the driver's drug-test columns", drugLeaks(admin), []);
			const mine = await page(w);
			eq("§3.3 the driver himself, same world: onboarding", [mine.status, mine.body && mine.body.trainingVideos], [200, "onboarding"]);
			const other = await page(w, USERS.otherDriver);
			eq("§3.4 another driver asking for his page: 403, no trainingVideos key",
				[other.status, !!other.body && "trainingVideos" in other.body], [403, false]);
		} finally {
			await w.close();
		}
	});

	section("§4 the flag and the key in the source");
	const src = W.SRC.split("\n");
	const flagLine = 'const DRIVER_TRAINING_VIDEOS_ENABLED = /^(true|1|yes|on)$/i.test(String(process.env.DRIVER_TRAINING_VIDEOS_ENABLED ?? "").trim());';
	eq("§4.1 server.js reads the flag once, default off (true/1/yes/on)",
		[src.filter((l) => l === flagLine).length, src.filter((l) => /process\.env\.DRIVER_TRAINING_VIDEOS_ENABLED\b/.test(l)).length], [1, 1]);
	const libReads = fs.readdirSync(path.join(W.ROOT, "lib")).filter((f) => f.endsWith(".js"))
		.filter((f) => /\benv\.DRIVER_TRAINING_VIDEOS_ENABLED\b/.test(fs.readFileSync(path.join(W.ROOT, "lib", f), "utf8")));
	eq("§4.2 no lib/ file reads it", libReads, []);
	eq("§4.3 the payload writes trainingVideos once, behind the flag, from the onboarding row it already read",
		src.map((l) => l.trim()).filter((l) => !l.startsWith("//") && /\btrainingVideos\b/.test(l)),
		["...(DRIVER_TRAINING_VIDEOS_ENABLED ? { trainingVideos: driverTrainingVideos.trainingVideoPlacement(onboarding ? onboarding.status : null) } : {}),"]);

	await R.finish();
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
