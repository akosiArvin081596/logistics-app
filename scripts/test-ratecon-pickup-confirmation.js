#!/usr/bin/env node
/**
 * "NEEDS CONFIRMATION" PICKUPS (Arvin, 2026-10-21; plan Revision 3, decisions N1-N12): the pure
 * rules, lib/ratecon-pickup-confirmation.js and lib/load-review-flags.js, plus the first-pickup-tap
 * helper lib/trip-work-days.js exports and the modal line lib/ratecon-load.js adds when told.
 * Every value here is made up (load numbers, dates, rate-con text); none is copied from a real
 * rate con or from production.
 *
 *   §1 detection: the C.H. Robinson line (line-broken, spacing variants, "Pickup" without the
 *      hyphen) is true; "Pick Up Time: Contact CHR for scheduling" and the other shipper lines, a
 *      bare "TBD", empty and null notes are false; the generic pattern runs on the notes only; the
 *      answer holds no date (the "YYYYMMDD HHMM:" stamp is never returned); a 200,000-character run
 *      of spaces and newlines between every pair of words is false within 50 ms (both patterns).
 *   §2 two readings of one load within the TTL are OR-ed; an expired one is replaced; the store
 *      keeps at most `max` loads.
 *   §3 the record decisions: a new load with the phrase is inserted, without it nothing (review
 *      Low 2); a held Pickup Appointment or none sent leaves the record untouched; an existing
 *      record is updated with or without the phrase and never cleared (decision 12 (a)).
 *   §4 the review code: the all-open shape gives pickup_unconfirmed with stored and arrived; the
 *      straddling shape (stored in a closed month, other months open) gives
 *      pickup_unconfirmed_closed with closedMonth (decision 11 (a)); every month closed, a sheet
 *      edit, "Mark pickup confirmed" (a person row), a tap on the stored Eastern day, Cancelled, a
 *      blank or unplaceable date: no code; with the person hold off, a later email over a person's
 *      date brings the code back with `replaced`, read from load_cell_writes alone, and (#588's
 *      rule) the person's date put back in the sheet after that clears it again; an email that
 *      changes the date without the phrase keeps the load flagged on the new value.
 *   §5 firstPickupTap(): At Shipper after the last Cancelled, else Loading, else In Transit; a tap
 *      at 2026-10-18 03:30:00 UTC reads as 2026-10-17 (Eastern).
 *   §6 annotateLoadReview(): no `pickup` (the flag off) adds no `_review` key; with it, the codes
 *      land on the matching rows only; extractionWarnings() is unchanged unless told; the modal
 *      change test.
 *
 * Pure: no server, no network. Run: node scripts/test-ratecon-pickup-confirmation.js  # exits 1 on failure
 */
"use strict";

const path = require("path");

const ROOT = path.join(__dirname, "..");
let passes = 0;
let failures = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function eq(name, actual, expected) {
	check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

let pc;
let lrf;
let twd;
let rateconLoad;
try {
	pc = require(path.join(ROOT, "lib", "ratecon-pickup-confirmation"));
	lrf = require(path.join(ROOT, "lib", "load-review-flags"));
} catch (e) {
	console.error(`FAIL the Needs Confirmation modules are missing (${e.message})`);
	console.error("\n0 passed, 1 failed");
	process.exit(1);
}
twd = require(path.join(ROOT, "lib", "trip-work-days"));
rateconLoad = require(path.join(ROOT, "lib", "ratecon-load"));

const ZONE = "America/New_York";
const CHR_LINE = "20261006 0700: Scheduled Pick-up Date, Needs Confirmation";

// ---------------------------------------------------------------- §1 detection
{
	const d = (t, n) => pc.detectNeedsConfirmation({ text: t, notes: n });
	eq("§1 the CHR line in the text", d(`SHIPPER INSTRUCTIONS ${CHR_LINE} DOCK 4`, ""), { needsConfirmation: true, by: "text" });
	eq("§1 the CHR line in the notes", d("", CHR_LINE), { needsConfirmation: true, by: "notes" });
	eq("§1 in both", d(CHR_LINE, CHR_LINE), { needsConfirmation: true, by: "text+notes" });
	check("§1 line-broken", d("Scheduled\nPick-up\r\nDate,\nNeeds\nConfirmation", "").needsConfirmation);
	check("§1 spacing variants", d("Scheduled   Pick - up  Date ,  Needs   Confirmation", "").needsConfirmation);
	check("§1 \"Pickup\" without the hyphen", d("Scheduled Pickup Date, Needs Confirmation", "").needsConfirmation);
	check("§1 \"Pick up\" and \"Need\"", d("scheduled pick up date need confirmation", "").needsConfirmation);
	for (const s of ["Pick Up Time: Contact CHR for scheduling", "Delivery Time: Contact CHR for scheduling", "APPTS NEEDED, ADVISE ETA",
		"DELIVERY APPT REQUIRED VIA", "TBD", "Pickup: TBD", "Scheduled Delivery Date, Needs Confirmation"]) {
		eq(`§1 false: ${s}`, d(s, s).needsConfirmation, false);
	}
	eq("§1 empty notes", d("", ""), { needsConfirmation: false, by: "" });
	eq("§1 null notes and text", d(null, null), { needsConfirmation: false, by: "" });
	eq("§1 nothing at all", pc.detectNeedsConfirmation(), { needsConfirmation: false, by: "" });
	check("§1 the generic pattern on the notes: to be confirmed", d("", "Pickup date to be confirmed by shipper").needsConfirmation);
	check("§1 the generic pattern on the notes: appt TBD", d("", "PICKUP APPT: TBD").needsConfirmation);
	check("§1 the generic pattern on the notes: pending", d("", "Pick-up time pending").needsConfirmation);
	eq("§1 the generic pattern never runs on the built-in text", d("Pickup date to be confirmed", "").needsConfirmation, false);
	eq("§1 a sentence break stops the generic pattern", d("", "Pickup date 10/06. Driver must be confirmed by dispatch").needsConfirmation, false);
	const ans = d(CHR_LINE, CHR_LINE);
	eq("§1 the answer holds two keys and no date (the stamp is never returned)", [Object.keys(ans), /\d/.test(JSON.stringify(ans))], [["needsConfirmation", "by"], false]);

	const run = " \n".repeat(100000);
	const words = ["Scheduled", "Pick-up", "Date,", "Needs", "Confirmation"];
	let worst = 0;
	for (let i = 0; i < words.length - 1; i++) {
		const t = [...words.slice(0, i + 1), run, ...words.slice(i + 1)].join(" ");
		const t0 = process.hrtime.bigint();
		const r = pc.CHR_PHRASE_RE.test(t) || pc.detectNeedsConfirmation({ text: t, notes: t }).needsConfirmation;
		worst = Math.max(worst, Number(process.hrtime.bigint() - t0) / 1e6);
		check(`§1 a 200,000-character whitespace run after "${words[i]}" is false`, !r);
	}
	const g = ["pick", run, "up", run, "date", run, "to", run, "be", run, "confirmed"].join("");
	const t1 = process.hrtime.bigint();
	const gr = pc.GENERIC_RE.test(g);
	worst = Math.max(worst, Number(process.hrtime.bigint() - t1) / 1e6);
	check("§1 the generic pattern over long whitespace runs is false", !gr);
	check("§1 both patterns answer a 200,000-character run within 50 ms", worst < 50, `${worst.toFixed(1)} ms`);
}

// ---------------------------------------------------------------- §2 the reading store
{
	eq("§2 merge: the phrase in either", pc.mergeReadings({ needsConfirmation: true, by: "text" }, { needsConfirmation: false, by: "" }), { needsConfirmation: true, by: "text" });
	eq("§2 merge: text + notes", pc.mergeReadings({ needsConfirmation: true, by: "notes" }, { needsConfirmation: true, by: "text" }), { needsConfirmation: true, by: "text+notes" });
	const s = pc.createPickupReadingStore({ ttlMs: 1000, max: 3 });
	s.note("900000101", { needsConfirmation: true, by: "text" }, 0);
	s.note("900000101", { needsConfirmation: false, by: "" }, 500);
	eq("§2 a confirmation then a Booked Load PDF within the TTL: OR-ed", s.get("900000101", 600), { needsConfirmation: true, by: "text" });
	s.note("900000101", { needsConfirmation: false, by: "" }, 2000);
	eq("§2 a reading after the TTL replaces the expired one", s.get("900000101", 2100), { needsConfirmation: false, by: "" });
	eq("§2 a reading older than the TTL is gone", s.get("900000101", 3500), null);
	for (let i = 0; i < 5; i++) s.note(`90000020${i}`, { needsConfirmation: true, by: "notes" }, 4000 + i);
	eq("§2 at most max loads, the oldest dropped first", [s.size, s.get("900000200", 4010), !!s.get("900000204", 4010)], [3, null, true]);
}

// ---------------------------------------------------------------- §3 record decisions
{
	const phrase = { needsConfirmation: true, by: "text" };
	const none = { needsConfirmation: false, by: "" };
	const flagged = { needs_confirmation: 1, detected_by: "notes" };
	eq("§3 a new load with the phrase is inserted", pc.recordDecision({ reading: phrase, pickupSent: "10/06/2026 07:00" }), { action: "insert", needsConfirmation: true, by: "text" });
	eq("§3 (review Low 2) a new load without the phrase gets no record", pc.recordDecision({ reading: none, pickupSent: "10/06/2026 07:00" }), { action: "none" });
	eq("§3 no reading at all: no record", pc.recordDecision({ reading: null, pickupSent: "10/06/2026 07:00" }), { action: "none" });
	eq("§3 a held Pickup Appointment leaves the record untouched (with the phrase)", pc.recordDecision({ existing: flagged, reading: phrase, pickupSent: "10/06/2026 07:00", held: true }), { action: "none" });
	eq("§3 a held Pickup Appointment on a new load: nothing", pc.recordDecision({ reading: phrase, pickupSent: "10/06/2026 07:00", held: true }), { action: "none" });
	eq("§3 no Pickup Appointment sent: nothing", pc.recordDecision({ existing: flagged, reading: phrase, pickupSent: "  " }), { action: "none" });
	eq("§3 a new written date with the phrase keeps it flagged, by merged", pc.recordDecision({ existing: flagged, reading: phrase, pickupSent: "10/08/2026 07:00" }), { action: "update", needsConfirmation: true, by: "text+notes" });
	eq("§3 (decision 12 (a)) without the phrase a flagged record is never cleared", pc.recordDecision({ existing: flagged, reading: none, pickupSent: "10/08/2026 07:00" }), { action: "update", needsConfirmation: true, by: "notes" });
	eq("§3 an unflagged record (B4's) gets the phrase", pc.recordDecision({ existing: { needs_confirmation: 0, detected_by: "" }, reading: phrase, pickupSent: "10/08/2026 07:00" }), { action: "update", needsConfirmation: true, by: "text" });
}

// ---------------------------------------------------------------- §4 review state
{
	const record = { needs_confirmation: 1 };
	const closedThrough = (last) => (m) => m <= last;
	const tap = (at) => twd.firstPickupTap([{ new_status: "Dispatched", changed_at: "2026-10-05 12:00:00" }, { new_status: "At Shipper", changed_at: at }], { zone: ZONE });
	const rc = (id, value, source = "ratecon") => ({ id, source, value, actor: "", at: "2026-10-05T12:00:00.000Z" });
	const base = { record, stored: "10/6/2026 7:00:00", cellRows: [rc(1, "10/06/2026 07:00")], status: "Dispatched", months: ["2026-10"], isClosed: closedThrough("2026-09") };

	eq("§4 the all-open shape: pickup_unconfirmed, stored and arrived (Eastern days)",
		pc.reviewCode({ ...base, firstTap: tap("2026-10-12 15:00:00") }), { code: "pickup_unconfirmed", stored: "2026-10-06", arrived: "2026-10-12" });
	eq("§4 no tap yet: the code without arrived", pc.reviewCode(base), { code: "pickup_unconfirmed", stored: "2026-10-06" });
	const straddle = { ...base, stored: "9/29/2026 8:00:00", cellRows: [rc(1, "09/29/2026 08:00")], months: ["2026-09", "2026-10"] };
	eq("§4 (decision 11 (a)) stored in a closed month, Assigned and drop-off open: pickup_unconfirmed_closed with closedMonth",
		pc.reviewCode({ ...straddle, firstTap: tap("2026-10-17 14:00:00") }), { code: "pickup_unconfirmed_closed", stored: "2026-09-29", arrived: "2026-10-17", closedMonth: "2026-09" });
	eq("§4 a closed month other than the pickup's: closedMonth names the first closed one",
		pc.reviewCode({ ...base, months: ["2026-08", "2026-10"], isClosed: closedThrough("2026-08") }).closedMonth, "2026-08");
	eq("§4 every month closed: no code", pc.reviewCode({ ...straddle, isClosed: closedThrough("2026-10") }), null);
	eq("§4 months can't be placed: no code", [pc.reviewCode({ ...base, months: null }), pc.reviewCode({ ...base, months: [] })], [null, null]);
	eq("§4 a sheet edit (a value matching no recorded row): no code", pc.reviewCode({ ...base, stored: "10/9/2026 7:00:00" }), null);
	eq("§4 \"Mark pickup confirmed\" (a person row of the current value): no code",
		pc.reviewCode({ ...base, cellRows: [rc(1, "10/06/2026 07:00"), rc(2, "10/6/2026 7:00:00", "person")] }), null);
	eq("§4 a LogisX edit (a person row of a new value): no code",
		pc.reviewCode({ ...base, stored: "10/9/2026 7:00:00", cellRows: [rc(1, "10/06/2026 07:00"), rc(2, "10/9/2026 7:00:00", "person")] }), null);
	eq("§4 the first pickup tap on the stored Eastern day confirms it", pc.reviewCode({ ...base, firstTap: tap("2026-10-06 23:30:00") }), null);
	eq("§4 (R2 L7) a tap at 03:30 UTC the next day is still the stored Eastern day", pc.reviewCode({ ...base, stored: "10/17/2026 8:00:00", cellRows: [rc(1, "10/17/2026 08:00")], firstTap: tap("2026-10-18 03:30:00") }), null);
	eq("§4 Cancelled: no code", pc.reviewCode({ ...base, status: "Cancelled" }), null);
	eq("§4 a blank Pickup Appointment: no code", pc.reviewCode({ ...base, stored: "" }), null);
	eq("§4 no record, or a record without the phrase: no code", [pc.reviewCode({ ...base, record: null }), pc.reviewCode({ ...base, record: { needs_confirmation: 0 } })], [null, null]);
	eq("§4 (review Low 1) an email that changed the date without the phrase keeps it flagged on the new value",
		pc.reviewCode({ ...base, stored: "10/8/2026 7:00:00", cellRows: [rc(1, "10/06/2026 07:00"), rc(2, "10/08/2026 07:00")] }), { code: "pickup_unconfirmed", stored: "2026-10-08" });
	eq("§4 (person hold off) a later email over a person's correction: the code again, replaced",
		pc.reviewCode({ ...base, cellRows: [rc(1, "10/06/2026 07:00"), rc(2, "10/9/2026 7:00:00", "person"), rc(3, "10/06/2026 07:00")] }),
		{ code: "pickup_unconfirmed", stored: "2026-10-06", replaced: true, replacedDay: "2026-10-09" });
	eq("§4 (person hold off) a later email over a confirmed date: replaced, naming the confirmed day",
		pc.reviewCode({ ...base, stored: "10/8/2026 7:00:00", cellRows: [rc(1, "10/06/2026 07:00"), rc(2, "10/6/2026 7:00:00", "person"), rc(3, "10/08/2026 07:00")] }),
		{ code: "pickup_unconfirmed", stored: "2026-10-08", replaced: true, replacedDay: "2026-10-06" });
	eq("§4 replaced: the person's day when it reads as one, left out when it doesn't",
		[
			pc.reviewCode({ ...base, cellRows: [rc(1, "10/06/2026 07:00"), rc(2, "10/11/2026 7:00:00", "person"), rc(3, "10/06/2026 07:00")] }),
			pc.reviewCode({ ...base, cellRows: [rc(1, "10/06/2026 07:00"), rc(2, "ASAP", "person"), rc(3, "10/06/2026 07:00")] }),
		],
		[
			{ code: "pickup_unconfirmed", stored: "2026-10-06", replaced: true, replacedDay: "2026-10-11" },
			{ code: "pickup_unconfirmed", stored: "2026-10-06", replaced: true },
		]);
	// #588's rule: only the app's own writes clear a stored date, so a person's date put back in
	// the sheet after an email replaced it is a person's date again (no code, no `replaced`).
	const restoredRows = [rc(1, "10/6/2026 08:00"), rc(2, "10/12/2026 14:00", "person"), rc(3, "10/6/2026 08:00")];
	eq("§4 (#588 rule) a person's date restored in the sheet after an email replaced it: no code",
		[pc.reviewCode({ ...base, stored: "10/12/2026 14:00:00", cellRows: restoredRows }), pc.reviewCode({ ...base, stored: "10/12/2026 14:00", cellRows: restoredRows })], [null, null]);
	eq("§4 (#588 rule) the email's date left in place still gets the code, replaced",
		pc.reviewCode({ ...base, stored: "10/6/2026 8:00:00", cellRows: restoredRows }), { code: "pickup_unconfirmed", stored: "2026-10-06", replaced: true, replacedDay: "2026-10-12" });
	eq("§4 the same date re-sent after a confirmation (no new rate-con row): stays confirmed",
		pc.reviewCode({ ...base, cellRows: [rc(1, "10/06/2026 07:00"), rc(2, "10/6/2026 7:00:00", "person")] }), null);
	eq("§4 cellDay reads a time window and refuses a yearless date", [pc.cellDay("10/7/2026 08:00-14:00 (FCFS)"), pc.cellDay("10/07"), pc.cellDay("2026-10-06")], ["2026-10-07", "", "2026-10-06"]);
	eq("§4 a time-window cell keeps its code with its day", pc.reviewCode({ ...base, stored: "10/7/2026 08:00-14:00", cellRows: [rc(1, "10/7/2026 08:00-14:00")] }), { code: "pickup_unconfirmed", stored: "2026-10-07" });
}

// ---------------------------------------------------------------- §5 firstPickupTap()
{
	const ev = (s, at) => ({ new_status: s, changed_at: at });
	eq("§5 (R2 L7) At Shipper at 2026-10-18 03:30:00 UTC is 2026-10-17 in Eastern",
		twd.firstPickupTap([ev("At Shipper", "2026-10-18 03:30:00")], { zone: ZONE }), { status: "at shipper", at: "2026-10-18 03:30:00", ms: Date.parse("2026-10-18T03:30:00Z"), day: "2026-10-17" });
	eq("§5 only the taps after the last Cancelled count",
		twd.firstPickupTap([ev("At Shipper", "2026-10-05 14:00:00"), ev("Cancelled", "2026-10-05 18:00:00"), ev("At Shipper", "2026-10-08 14:00:00")], { zone: ZONE }).day, "2026-10-08");
	eq("§5 no At Shipper: the first Loading, else the first In Transit",
		[twd.firstPickupTap([ev("In Transit", "2026-10-09 14:00:00"), ev("Loading", "2026-10-10 14:00:00")], { zone: ZONE }).status,
			twd.firstPickupTap([ev("In Transit", "2026-10-09 14:00:00")], { zone: ZONE }).status], ["loading", "in transit"]);
	eq("§5 no pickup tap: null", [twd.firstPickupTap([ev("Dispatched", "2026-10-09 14:00:00")], { zone: ZONE }), twd.firstPickupTap([], { zone: ZONE }), twd.firstPickupTap(null)], [null, null, null]);
}

// ---------------------------------------------------------------- §6 annotation, modal
{
	const headers = ["Load ID", "Job Status", "Pickup Appointment", "Drop-off Appointment", "Assigned Date"];
	const rows = () => [
		{ "Load ID": "900000301", "Job Status": "Dispatched", "Pickup Appointment": "10/6/2026 7:00:00", "Drop-off Appointment": "10/8/2026 9:00:00", "Assigned Date": "10/5/2026" },
		{ "Load ID": "#900000302", "Job Status": "Dispatched", "Pickup Appointment": "10/6/2026 7:00:00", "Drop-off Appointment": "10/8/2026 9:00:00", "Assigned Date": "10/5/2026" },
		{ "Load ID": "900000303", "Job Status": "Dispatched", "Pickup Appointment": "10/6/2026 7:00:00", "Drop-off Appointment": "10/8/2026 9:00:00", "Assigned Date": "10/5/2026" },
	];
	const keyOf = (id) => String(id || "").trim().toLowerCase().replace(/^#/, "").slice(0, 120);
	const pickup = {
		records: new Map([["900000301", { needs_confirmation: 1 }], ["900000302", { needs_confirmation: 1 }]]),
		cellRows: new Map([["900000301", [{ id: 1, source: "ratecon", value: "10/06/2026 07:00" }]], ["900000302", [{ id: 2, source: "ratecon", value: "10/06/2026 07:00" }, { id: 3, source: "person", value: "10/6/2026 7:00:00" }]]]),
		events: new Map(),
		accountingMonths: () => ["2026-10"],
		isClosed: () => false,
		zone: ZONE,
	};
	const off = rows();
	eq("§6 the flag off (no pickup source): no row gets a _review key", [lrf.annotateLoadReview({ headers, rows: off, loadIdHeader: "Load ID", keyOf }), off.some((r) => "_review" in r)], [0, false]);
	const on = rows();
	on[0]._review = [{ code: "other" }];
	const n = lrf.annotateLoadReview({ headers, rows: on, loadIdHeader: "Load ID", keyOf, pickup });
	eq("§6 the flagged unconfirmed row gets its code appended; a confirmed one and an unrecorded one get none",
		[n, on[0]._review, "_review" in on[1], "_review" in on[2]], [1, [{ code: "other" }, { code: "pickup_unconfirmed", stored: "2026-10-06" }], false, false]);

	const empty = rateconLoad.extractionWarnings({});
	eq("§6 extractionWarnings() unchanged by default", [empty.length, rateconLoad.extractionWarnings({}, {}).length], [4, 4]);
	eq("§6 extractionWarnings() adds the Needs Confirmation line last when told", rateconLoad.extractionWarnings({}, { pickupNeedsConfirmation: pc.MODAL_WARNING }).slice(-1), [pc.MODAL_WARNING]);
	eq("§6 the modal change test: same text, same moment, a different day",
		[pc.pickupChangedInModal("10/06/2026 07:00", " 10/06/2026  07:00 "), pc.pickupChangedInModal("10/06/2026 07:00", "10/6/2026 7:00"), pc.pickupChangedInModal("10/06/2026 07:00", "10/07/2026 07:00"), pc.pickupChangedInModal("", "10/07/2026 07:00")],
		[false, false, true, true]);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
