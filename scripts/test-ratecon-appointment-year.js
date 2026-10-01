#!/usr/bin/env node
/**
 * Rate-con appointment years: anchorAppointmentYear() and pdfDocumentDates() in
 * lib/ratecon-normalize.js, and their wiring into both ingestion paths.
 *
 * WHY THIS EXISTS. C.H. Robinson's Navisphere load confirmation prints each stop
 * as a month and day with no year anywhere in the document ("9/29 08:00 - 16:00").
 * The extraction prompt asks for "M/D/YYYY", so Gemini supplied a year, and in
 * September 2026 it supplied 2020, 2023 or 2024 for 13 of the 38 such rate cons.
 * The sheet write is USER_ENTERED, so Job Tracking stored real dates in those
 * years. Every string in §1 is one Gemini returned in production, with the time
 * the email arrived and the PDF's own /CreationDate.
 *
 * WHAT IS ASSERTED
 *   §1 the production strings, wrong year -> the year of the load
 *   §2 correct appointments come back byte for byte
 *   §3 2-digit and missing years get a 4-digit year
 *   §4 the year boundary, both directions
 *   §5 an invented year one off is still caught (why the window is half a year)
 *   §6 the PDF's own date keeps a genuine old year, and never anchors a missing one
 *   §7 shapes it must not touch, and inputs it must survive
 *   §8 pdfDocumentDates()
 *   §9 normalizeRateConFields() applies it to the two appointment fields only
 *   §10 both server.js ingestion routes pass the options on every normalize call
 *   §11 linear on long input
 *
 * Pure: no server, no network, no fixtures on disk.
 *
 * Run: node scripts/test-ratecon-appointment-year.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const lib = require(path.join(__dirname, "..", "lib", "ratecon-normalize.js"));
const { anchorAppointmentYear, pdfDocumentDates, normalizeRateConFields, mergeExtractions } = lib;

let failed = 0;
let passed = 0;
function ok(name, cond, extra) {
	if (cond) {
		passed++;
		console.log(`  ok    ${name}`);
	} else {
		failed++;
		console.log(`  FAIL  ${name}${extra ? "  -> " + extra : ""}`);
	}
}
function eq(name, got, want) {
	ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
const day = (s) => Date.parse(`${s}T00:00:00Z`);

// ------------------------------------------------------------------
console.log("§1 production strings (n8n executions, September 2026)");
// [execution, load, email time, PDF /CreationDate day, Gemini's string, expected]
const PRODUCTION = [
	["2598", "566053447", "2026-09-09T16:46:33Z", "2026-09-09", "9/8/2020 08:00", "9/8/2026 08:00"],
	["2598", "566053447", "2026-09-09T16:46:33Z", "2026-09-09", "9/10/2020 08:00", "9/10/2026 08:00"],
	["2600", "567518923", "2026-09-10T13:51:17Z", "2026-09-10", "9/11/2024 00:00", "9/11/2026 00:00"],
	["2608", "566053844", "2026-09-11T14:54:57Z", "2026-09-11", "9/3/2020 08:00", "9/3/2026 08:00"],
	["2618", "567484733", "2026-09-14T16:43:06Z", "2026-09-14", "9/13/2024 00:00", "9/13/2026 00:00"],
	["2618", "567484733", "2026-09-14T16:43:06Z", "2026-09-14", "9/4/2024 00:00", "9/4/2026 00:00"],
	["2651", "567652602", "2026-09-21T19:29:39Z", "2026-09-21", "9/21/2020 08:00", "9/21/2026 08:00"],
	["2651", "567652602", "2026-09-21T19:29:39Z", "2026-09-21", "9/21", "9/21/2026"],
	["2652", "568508325", "2026-09-21T19:30:30Z", "2026-09-21", "9/20/2020 08:00", "9/20/2026 08:00"],
	["2652", "568508325", "2026-09-21T19:30:30Z", "2026-09-21", "9/22/2020 08:00", "9/22/2026 08:00"],
	["2655", "566424564", "2026-09-21T21:24:14Z", "2026-09-21", "9/20/2020 07:00", "9/20/2026 07:00"],
	["2655", "566424564", "2026-09-21T21:24:14Z", "2026-09-21", "9/21/2020 00:00", "9/21/2026 00:00"],
	["2670", "569102162", "2026-09-23T19:40:48Z", null, "9/22/2023 05:00", "9/22/2026 05:00"],
	["2670", "569102162", "2026-09-23T19:40:48Z", null, "9/23/2023 00:00", "9/23/2026 00:00"],
	["2696", "568508467", "2026-09-28T20:42:48Z", "2026-09-28", "9/23/2020 08:00", "9/23/2026 08:00"],
	["2696", "568508467", "2026-09-28T20:42:48Z", "2026-09-28", "9/25/2020 08:00", "9/25/2026 08:00"],
	["2707", "569374250", "2026-09-29T15:47:08Z", "2026-09-29", "9/27/2020 08:00", "9/27/2026 08:00"],
	["2707", "569374250", "2026-09-29T15:47:08Z", "2026-09-29", "9/29/2020 08:00", "9/29/2026 08:00"],
	["2717", "569139441", "2026-09-29T20:58:10Z", "2026-09-29", "9/28/2023 05:00", "9/28/2026 05:00"],
	["2717", "569139441", "2026-09-29T20:58:10Z", "2026-09-29", "9/29/2023 00:00", "9/29/2026 00:00"],
	["2745", "569374317", "2026-09-30T19:09:17Z", "2026-09-30", "9/29/2020 08:00", "9/29/2026 08:00"],
	["2745", "569374317", "2026-09-30T19:09:17Z", "2026-09-30", "10/1/2020 08:00", "10/1/2026 08:00"],
];
for (const [exec, load, now, created, input, want] of PRODUCTION) {
	const documentDates = created ? [day(created)] : [];
	eq(`exec ${exec} load ${load}: ${JSON.stringify(input)}`, anchorAppointmentYear(input, { now, documentDates }), want);
}
// The same strings with no PDF dates at all (a PDF whose Info is compressed).
for (const [exec, load, now, , input, want] of PRODUCTION.slice(0, 4)) {
	eq(`exec ${exec} load ${load} without PDF dates: ${JSON.stringify(input)}`, anchorAppointmentYear(input, { now }), want);
}

// ------------------------------------------------------------------
console.log("\n§2 correct appointments are returned byte for byte");
[
	["2026-09-30T00:37:23Z", "9/30/2026 00:00"],
	["2026-09-30T00:37:23Z", "10/1/2026"],
	["2026-10-01T12:46:48Z", "10/1/2026 00:01"],
	["2026-09-21T22:13:32Z", "9/17/2026 07:00"],
	// Bison's cancelled duplicate, 49 days before its email: the widest real gap.
	["2026-09-29T12:23:58Z", "8/12/2026 16:00"],
	["2026-09-29T12:23:58Z", "8/17/2026 16:00"],
	["2026-09-30T19:09:17Z", "09/29/2026 08:00"],
	["2026-09-30T19:09:17Z", "9/29/2026 08:00 - 16:00"],
	["2026-09-30T19:09:17Z", "2026-09-29 08:00"],
	["2026-09-30T19:09:17Z", "2026-09-29T08:00:00"],
].forEach(([now, v]) => eq(`unchanged: ${JSON.stringify(v)}`, anchorAppointmentYear(v, { now }), v));

// ------------------------------------------------------------------
console.log("\n§3 2-digit and missing years get a 4-digit year");
[
	["2026-09-21T22:13:32Z", "9/16/26 09:45", "9/16/2026 09:45"], // exec 2657
	["2026-09-21T22:13:32Z", "9/14 00:00", "9/14/2026 00:00"], // exec 2657
	["2026-09-16T21:17:04Z", "9/21/26 07:00", "9/21/2026 07:00"], // exec 2640
	["2026-09-11T14:54:15Z", "9/8 00:00", "9/8/2026 00:00"], // exec 2606
	["2026-09-11T14:54:15Z", "9/10/26 00:00", "9/10/2026 00:00"], // exec 2606
	["2026-09-30T19:09:17Z", "9/29 08:00 - 16:00", "9/29/2026 08:00 - 16:00"], // the document's own shape
	["2026-09-30T19:09:17Z", "9/29/20 08:00", "9/29/2026 08:00"], // Sheets would read "20" as 2020
].forEach(([now, v, want]) => eq(`${JSON.stringify(v)} -> ${JSON.stringify(want)}`, anchorAppointmentYear(v, { now }), want));

// ------------------------------------------------------------------
console.log("\n§4 the year boundary");
eq("rate con of 12/30/2026, pickup \"1/2\" -> 2027", anchorAppointmentYear("1/2 08:00", { now: "2026-12-30T15:00:00Z" }), "1/2/2027 08:00");
eq("rate con of 12/28/2026, invented \"1/2/2026\" -> 2027", anchorAppointmentYear("1/2/2026 08:00", { now: "2026-12-28T15:00:00Z" }), "1/2/2027 08:00");
eq("rate con of 1/3/2027, delivery \"12/30\" -> 2026", anchorAppointmentYear("12/30", { now: "2027-01-03T15:00:00Z" }), "12/30/2026");
eq("rate con of 1/3/2027, correct \"12/30/2026\" kept", anchorAppointmentYear("12/30/2026 23:59", { now: "2027-01-03T15:00:00Z" }), "12/30/2026 23:59");
eq("rate con of 1/3/2027, invented \"12/30/2027\" -> 2026", anchorAppointmentYear("12/30/2027 23:59", { now: "2027-01-03T15:00:00Z" }), "12/30/2026 23:59");

// ------------------------------------------------------------------
console.log("\n§5 an invented year one off is caught");
eq("\"10/5/2025\" on a rate con of 9/30/2026 -> 2026 (a one-year window would keep it)",
	anchorAppointmentYear("10/5/2025 08:00", { now: "2026-09-30T15:00:00Z" }), "10/5/2026 08:00");
eq("\"9/29/2027\" on a rate con of 9/30/2026 -> 2026",
	anchorAppointmentYear("9/29/2027 08:00", { now: "2026-09-30T15:00:00Z" }), "9/29/2026 08:00");
eq("\"2020-09-29 08:00\" (ISO shape) -> 2026, shape kept",
	anchorAppointmentYear("2020-09-29 08:00", { now: "2026-09-30T15:00:00Z" }), "2026-09-29 08:00");
eq("\"2025/09/23 23:59\" on a rate con of 9/30/2026 -> 2026, shape kept",
	anchorAppointmentYear("2025/09/23 23:59", { now: "2026-09-30T15:00:00Z" }), "2026/09/23 23:59");
eq("\"2025/09/23 23:59\" on a rate con of 9/25/2025 is kept",
	anchorAppointmentYear("2025/09/23 23:59", { now: "2025-09-25T15:00:00Z" }), "2025/09/23 23:59");
eq("APPOINTMENT_PLAUSIBLE_DAYS is half a year", lib.APPOINTMENT_PLAUSIBLE_DAYS, 183);

// ------------------------------------------------------------------
console.log("\n§6 the PDF's own date");
// Job Tracking rows 295-303 (April 2026) carry genuine 2021-2022 appointments.
eq("an original 2021 rate con ingested in 2026 keeps 2021",
	anchorAppointmentYear("3/12/2021 8:00", { now: "2026-04-09T10:23:04Z", documentDates: [day("2021-03-10")] }), "3/12/2021 8:00");
eq("the same with a 2-digit year is kept and widened",
	anchorAppointmentYear("3/12/21 8:00", { now: "2026-04-09T10:23:04Z", documentDates: [day("2021-03-10")] }), "3/12/2021 8:00");
eq("its /ModDate counts the same as its /CreationDate",
	anchorAppointmentYear("3/12/2021 8:00", { now: "2026-04-09T10:23:04Z", documentDates: [day("2019-01-01"), day("2021-03-11")] }), "3/12/2021 8:00");
eq("without the PDF's dates it takes the year of ingestion (the trade, pinned)",
	anchorAppointmentYear("3/12/2021 8:00", { now: "2026-04-09T10:23:04Z" }), "3/12/2026 8:00");
eq("a template's old /CreationDate never anchors a missing year",
	anchorAppointmentYear("9/29 08:00", { now: "2026-09-30T19:09:17Z", documentDates: [day("2019-06-12")] }), "9/29/2026 08:00");
eq("a template's old /CreationDate does not keep an invented year far from it",
	anchorAppointmentYear("9/29/2020 08:00", { now: "2026-09-30T19:09:17Z", documentDates: [day("2019-06-12")] }), "9/29/2026 08:00");
eq("document dates as Date objects and ISO strings are read",
	anchorAppointmentYear("3/12/2021 8:00", { now: new Date("2026-04-09T10:23:04Z"), documentDates: [new Date("2021-03-10T00:00:00Z"), "junk"] }), "3/12/2021 8:00");

// ------------------------------------------------------------------
console.log("\n§7 shapes it must not touch, inputs it must survive");
const NOW = { now: "2026-09-30T19:09:17Z" };
["", "08:00", "FCFS", "First Come First Served", "Sep 29 08:00", "Tuesday 9/29",
	"9/29/202 08:00", "9/29/20201", "13/40", "0/12/2026", "9/0", "2/30/2026 08:00", "9/31",
	"12345", "9-29-2020", "29/9/2020"].forEach((v) => eq(`unchanged: ${JSON.stringify(v)}`, anchorAppointmentYear(v, NOW), v));
eq("2/29 with no leap year near enough is left as it came", anchorAppointmentYear("2/29 08:00", NOW), "2/29 08:00");
eq("2/29 with a leap year near enough takes it", anchorAppointmentYear("2/29", { now: "2028-02-20T12:00:00Z" }), "2/29/2028");
eq("2/29/2020 near 2028 -> 2028", anchorAppointmentYear("2/29/2020", { now: "2028-02-20T12:00:00Z" }), "2/29/2028");
[null, undefined, 42, { a: 1 }].forEach((v) => ok(`non-string ${JSON.stringify(v)} returned as is`, anchorAppointmentYear(v, NOW) === v));
let threw = false;
try {
	anchorAppointmentYear("9/29/2020 08:00");
	anchorAppointmentYear("9/29/2020 08:00", null);
	anchorAppointmentYear("9/29/2020 08:00", { now: "not a date", documentDates: "nope" });
	anchorAppointmentYear("9/29/2020 08:00", { now: NaN, documentDates: [null, {}, NaN] });
} catch (_e) {
	threw = true;
}
ok("never throws on missing or junk options", !threw);
const nowYear = new Date().getUTCFullYear();
const dflt = anchorAppointmentYear("1/1/1999", {});
ok("defaults to the moment of the call", /^1\/1\/\d{4}$/.test(dflt) && Math.abs(Number(dflt.slice(4)) - nowYear) <= 1, dflt);

// ------------------------------------------------------------------
console.log("\n§8 pdfDocumentDates()");
const pdf = (s) => Buffer.from(s, "latin1");
const info = "%PDF-1.4\n1 0 obj\n<< /Producer (x) /CreationDate (D:20260930140908) /ModDate (D:20261001090000-05'00') >>\nendobj\n%%EOF";
const got = pdfDocumentDates(pdf(info));
ok("reads /CreationDate and /ModDate as UTC days", got.length === 2 && got[0] === day("2026-09-30") && got[1] === day("2026-10-01"), JSON.stringify(got));
ok("a date without the D: prefix is read", pdfDocumentDates(pdf("/CreationDate(20260930)"))[0] === day("2026-09-30"));
ok("no Info dates -> []", pdfDocumentDates(pdf("%PDF-1.7\n%%EOF")).length === 0);
ok("a hex-string date is not read", pdfDocumentDates(pdf("/CreationDate <FEFF0044003A0032>")).length === 0);
ok("an impossible date is dropped", pdfDocumentDates(pdf("/CreationDate (D:20261341)")).length === 0);
ok("a date before 2000 is dropped", pdfDocumentDates(pdf("/CreationDate (D:19700101000000Z)")).length === 0);
ok("at most four of each key are read", pdfDocumentDates(pdf("/CreationDate (D:20260101) ".repeat(50))).length === 4);
ok("a key at the very end of the buffer is safe", pdfDocumentDates(pdf("xx/ModDate")).length === 0);
ok("non-buffers -> []", [null, undefined, "", "/CreationDate (D:20260930)", 42, {}].every((v) => Array.isArray(pdfDocumentDates(v)) && pdfDocumentDates(v).length === 0));

// ------------------------------------------------------------------
console.log("\n§9 normalizeRateConFields()");
const opts = { now: "2026-09-30T19:09:17Z", documentDates: [day("2026-09-30")] };
const raw = {
	"Load Number": "569374317",
	"Pickup Appointment Time": " 9/29/2020 08:00 ",
	"Delivery Appointment Time": "10/1/2020 08:00",
	"Details": "Pallets, picked up 9/29/2020",
	"Pickup Notes/Instructions": "Drop 9/29/2020",
	"_extra": "9/29/2020",
};
const frozen = JSON.stringify(raw);
const out = normalizeRateConFields(raw, opts);
eq("Pickup Appointment Time anchored", out["Pickup Appointment Time"], "9/29/2026 08:00");
eq("Delivery Appointment Time anchored", out["Delivery Appointment Time"], "10/1/2026 08:00");
eq("Details untouched", out["Details"], "Pallets, picked up 9/29/2020");
eq("Pickup Notes untouched", out["Pickup Notes/Instructions"], "Drop 9/29/2020");
eq("unknown key untouched", out["_extra"], "9/29/2020");
ok("input not mutated", JSON.stringify(raw) === frozen);
eq("blank appointment still -> null", normalizeRateConFields({ "Pickup Appointment Time": "  " }, opts)["Pickup Appointment Time"], null);
eq("'TBD' appointment still -> null", normalizeRateConFields({ "Pickup Appointment Time": "TBD" }, opts)["Pickup Appointment Time"], null);
const merged = mergeExtractions(
	normalizeRateConFields({ "Pickup Appointment Time": null }, opts),
	normalizeRateConFields({ "Pickup Appointment Time": "9/29/2020 08:00" }, opts),
);
eq("a retry's appointment is anchored before the merge", merged["Pickup Appointment Time"], "9/29/2026 08:00");
// The module's own fixtures carry no appointment, so they are unaffected.
const quiet = console.log;
let st;
console.log = () => {};
try { st = lib.selfTest(); } finally { console.log = quiet; }
ok(`selfTest(): ${st.passed}/${st.total}`, st.failed === 0 && st.total > 0);

// ------------------------------------------------------------------
console.log("\n§10 both ingestion routes anchor every pass");
const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const calls = src.match(/rateconNormalize\.normalizeRateConFields\(([^()]|\([^()]*\))*\)/g) || [];
ok("server.js normalizes in four places", calls.length === 4, `found ${calls.length}`);
ok("every normalize call passes normalizeOpts", calls.length > 0 && calls.every((c) => /,\s*normalizeOpts\)$/.test(c)), calls.join(" | "));
const routeBody = (marker) => {
	const at = src.indexOf(marker);
	return at === -1 ? "" : src.slice(at, src.indexOf("\napp.", at + marker.length));
};
for (const marker of ['app.post("/api/n8n/extract-pdf-via-gemini"', 'app.post("/api/loads/ratecon/extract"']) {
	const body = routeBody(marker);
	ok(`${marker.slice(10, -1)} builds the options once, from its own PDF`,
		(body.match(/const normalizeOpts = rateConNormalizeOptions\(base64\);/g) || []).length === 1);
}
ok("rateConNormalizeOptions() passes the PDF's own dates and the time of ingestion",
	/function rateConNormalizeOptions\(base64\) \{[\s\S]{0,400}pdfDocumentDates\(Buffer\.from\(base64, "base64"\)\)[\s\S]{0,200}now: Date\.now\(\), documentDates/.test(src));

// ------------------------------------------------------------------
console.log("\n§11 linear on long input");
const long = [
	"9/29" + " ".repeat(200000) + "x",
	"9/29/" + "2".repeat(200000),
	"2".repeat(200000),
	"2026-" + "9".repeat(200000),
	"9/29/2020" + "\t".repeat(200000) + "08:00",
];
const t0 = process.hrtime.bigint();
for (let i = 0; i < 20; i++) for (const s of long) anchorAppointmentYear(s, NOW);
const big = Buffer.alloc(8 * 1024 * 1024, 0x20);
pdfDocumentDates(big);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
ok(`100 long appointments + an 8 MiB PDF scan in ${ms.toFixed(1)} ms (budget 2000)`, ms < 2000);

console.log(`\n${passed}/${passed + failed} checks passed.`);
process.exit(failed === 0 ? 0 : 1);
