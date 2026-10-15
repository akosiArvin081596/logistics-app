#!/usr/bin/env node
/**
 * The miles a rate confirmation states (lib/kpi-ratecon-miles.js), for the KPI
 * bot's loaded, paid and deadhead miles (R10).
 *
 * The three charge-table layouts, as the readers give them back (whitespace
 * collapsed):
 *   row     "Line Haul - PER MILE 268 $1.80 $482.40 ... Empty Movement - PER MILE 45 $2.55 $114.75"
 *   column  "Amount Rate Extended 624 624 379 $1.80 $0.89 $2.69 $1,123.20 $555.36 $1,019.51
 *            Line Haul - PER MILE Fuel Surcharge - PER MILE Empty Movement - PER MILE Total:"
 *           (main's extractPdfText(): every quantity, then every rate, then every
 *           amount, then every label)
 *   booked  "Rate Detail Amount Rate Extended Line Haul 168.00 $1.80 $302.40 ...
 *            Empty Movement 40.00 $2.55 $102.00 Missing Post-Trip DVIR Inspection 1.00 -$35.00 -$35.00"
 *
 *  1. the row layout gives loaded 268, empty 45;
 *  2. the column layout gives 624 and 379;
 *  3. the booked layout gives 168 and 40;
 *  4. a flat Line Haul (quantity 1.00, or "- FLAT RATE") is not miles;
 *  5. quantity x rate != amount: conflict;
 *  6. none_stated (a per-mile table with no Empty Movement line, or "Total
 *     Miles:") vs an unreadable document (no_text);
 *  7. two different empty figures: conflict (the same figure twice is fine);
 *  8. bounded regex timing on hostile text;
 *  9. label count != triple count: conflict, nothing assigned by position;
 * 10. the fuel-surcharge quantity never adds to the loaded miles.
 *
 * Every text here is made up: no real load number, broker, shipper or address.
 *
 * Run: node scripts/test-kpi-ratecon-miles.js    # exits 1 on failure
 */
"use strict";

const path = require("path");

let M;
try {
	M = require(path.join(__dirname, "..", "lib", "kpi-ratecon-miles.js"));
} catch (e) {
	console.error(`FAILED: lib/kpi-ratecon-miles.js did not load (${e.message})`);
	process.exit(1);
}

let pass = 0;
const failures = [];
function t(cond, name, detail) {
	if (cond) pass++;
	else failures.push(detail === undefined ? name : `${name} (${detail})`);
}
const P = (text) => M.parseStatedMiles(text);
const show = (r) => JSON.stringify(r);

const ROW = "Rate Details Service for Load #900000001 Amount Rate Extended Line Haul - PER MILE 268 $1.80 $482.40 Fuel Surcharge - PER MILE 268 $0.75 $201.00 Empty Movement - PER MILE 45 $2.55 $114.75 ______________ Total: $798.15";
const COLUMN = "Service for Load #900000002 Amount Rate Extended 624 624 379 $1.80 $0.89 $2.69 $1,123.20 $555.36 $1,019.51 Line Haul - PER MILE Fuel Surcharge - PER MILE Empty Movement - PER MILE Total: ______________ $2,698.07 SUBMIT FREIGHT BILL TO: billing@example.test";
const BOOKED = "Booked Load #900000003 Rate Detail Amount Rate Extended Line Haul 168.00 $1.80 $302.40 Fuel Surcharge 168.00 $0.75 $126.00 Empty Movement 40.00 $2.55 $102.00 Missing Post-Trip DVIR Inspection 1.00 -$35.00 -$35.00 Total: $495.40 SHIPPER: Zed Sentinel Mill";

// 1-3 the three layouts
{
	const r = P(ROW);
	t(r.status === "ok" && r.loadedMiles === 268 && r.emptyMiles === 45, "1 the row layout: loaded 268, empty 45", show(r));
	const c = P(COLUMN);
	t(c.status === "ok" && c.loadedMiles === 624 && c.emptyMiles === 379, "2 the column layout: loaded 624, empty 379", show(c));
	const b = P(BOOKED);
	t(b.status === "ok" && b.loadedMiles === 168 && b.emptyMiles === 40, "3 the booked layout: loaded 168, empty 40", show(b));
	const order = P("Amount Rate Extended 272 363 363 $2.69 $1.80 $0.89 $731.68 $653.40 $323.07 Empty Movement - PER MILE Line Haul - PER MILE Fuel Surcharge - PER MILE Total: $1,708.15");
	t(order.status === "ok" && order.loadedMiles === 363 && order.emptyMiles === 272, "2 the column layout assigns by position, whatever the label order", show(order));
	const spaced = P(ROW.replace(/ /g, "\n   "));
	t(spaced.status === "ok" && spaced.loadedMiles === 268 && spaced.emptyMiles === 45, "1 line breaks and runs of spaces read as one space", show(spaced));
}

// 4 a flat Line Haul is not miles
{
	const flatBooked = P("Rate Detail Amount Rate Extended Line Haul 1.00 $580.00 $580.00 Total: $580.00 Please note a $86.00 fuel surcharge is included.");
	t(flatBooked.status === "no_miles" && flatBooked.loadedMiles === null && flatBooked.emptyMiles === null, "4 a booked Line Haul of 1.00 is a flat charge: no_miles", show(flatBooked));
	const flatColumn = P("Service for Load #900000004 Amount Rate Extended 1 $800.00 $800.00 Line Haul - FLAT RATE Total: ______________ $800.00");
	t(flatColumn.status === "no_miles" && flatColumn.loadedMiles === null, "4 a column Line Haul - FLAT RATE: no_miles", show(flatColumn));
	const bigRate = P("Rate Detail Amount Rate Extended Line Haul 2.00 $650.00 $1,300.00 Total: $1,300.00");
	t(bigRate.status === "no_miles", "4 a quantity at a rate of $10 or more a unit is not miles", show(bigRate));
}

// 5 quantity x rate != amount
{
	const badColumn = P(COLUMN.replace("$1,019.51", "$1,000.00"));
	t(badColumn.status === "conflict" && badColumn.loadedMiles === null && badColumn.emptyMiles === null, "5 a column triple whose amount is not quantity x rate: conflict", show(badColumn));
	const badRow = P(ROW.replace("$114.75", "$120.00"));
	t(badRow.status === "conflict" && badRow.emptyMiles === null, "5 a row whose amount is not quantity x rate: conflict", show(badRow));
	const badBooked = P(BOOKED.replace("$302.40", "$300.00"));
	t(badBooked.status === "conflict", "5 a booked line whose amount is not quantity x rate: conflict", show(badBooked));
	const cents = P("Amount Rate Extended 363 $0.89 $323.07 Fuel Surcharge - PER MILE 363 $1.80 $653.40 Line Haul - PER MILE");
	t(cents.status !== "conflict", "5 an exact product to the cent is not a conflict", show(cents));
}

// 6 none_stated vs unreadable
{
	const none = P("Service for Load #900000005 Amount Rate Extended 333 333 $1.80 $0.75 $599.40 $249.75 Line Haul - PER MILE Fuel Surcharge - PER MILE Total: ______________ $849.15");
	t(none.status === "none_stated" && none.loadedMiles === 333 && none.emptyMiles === 0, "6 a per-mile table with no Empty Movement line: none_stated, empty 0", show(none));
	const totalMiles = P("Total Weight : 41000 lbs Rates: Line Haul: $1,800.00 Total Miles: 744 Subtotal: $1,800.00 Total Rate: $1,800.00 Currency: USD");
	t(totalMiles.status === "none_stated" && totalMiles.loadedMiles === 744 && totalMiles.emptyMiles === 0, "6 \"Total Miles: 744\" with no Empty Movement line: none_stated", show(totalMiles));
	const loadMiles = P("Load Miles: 1,204 Rate: $2,900.00 flat");
	t(loadMiles.status === "none_stated" && loadMiles.loadedMiles === 1204, "6 \"Load Miles: 1,204\" is the loaded miles", show(loadMiles));
	const nothing = P("Carrier confirmation for a load. Pickup at the shipper, deliver to the consignee. Rate: $1,500.00 all in.");
	t(nothing.status === "no_miles", "6 a readable rate con that states no miles: no_miles", show(nothing));
	const garbage = "\u0004t ?\u001c\u000fzó}yY5Ûåe*|÷àýjÕïïnmá1 E\u0018m<ð1jÚgJínqâ0qÅN £´V¯»ò_çÓð:Ù|M\u000ep^c¿<}";
	const unreadable = M.milesFromPdfText(garbage, 2048);
	t(unreadable.status === "no_text" && unreadable.loadedMiles === null && unreadable.emptyMiles === null, "6 an unreadable document: no_text, never none_stated", show(unreadable));
	const big = M.milesFromPdfText(COLUMN, 4 * 1024 * 1024);
	t(big.status === "too_large", "6 a document over the size cap: too_large", show(big));
	const readable = M.milesFromPdfText(`Rate confirmation for the carrier. Pickup at the shipper; deliver to the consignee. Load reference and dispatch below. ${COLUMN}`, 2048);
	t(readable.status === "ok" && readable.loadedMiles === 624 && readable.emptyMiles === 379, "6 a readable document is parsed", show(readable));
}

// 7 two different empty figures
{
	const two = P("Amount Rate Extended 909 909 179 350 $1.80 $0.89 $2.69 $2.67 $1,636.20 $809.01 $481.51 $934.50 Line Haul - PER MILE Fuel Surcharge - PER MILE Empty Movement - PER MILE Empty Movement - PER MILE Total: $3,861.22");
	t(two.status === "conflict" && two.emptyMiles === null && two.loadedMiles === null, "7 two Empty Movement lines with different miles: conflict", show(two));
	const twice = P(`${ROW} page 2 ${ROW}`);
	t(twice.status === "ok" && twice.loadedMiles === 268 && twice.emptyMiles === 45, "7 the same table printed twice is one figure", show(twice));
	const twoLoaded = P("Amount Rate Extended 300 310 $1.80 $1.80 $540.00 $558.00 Line Haul - PER MILE Line Haul - PER MILE Total: $1,098.00");
	t(twoLoaded.status === "conflict", "7 two Line Haul lines with different miles: conflict", show(twoLoaded));
	const disagree = P(`${ROW} ${BOOKED}`);
	t(disagree.status === "conflict", "7 two layouts that disagree: conflict", show(disagree));
}

// 8 bounded regex timing
{
	const hostile = [
		`Line Haul - PER MILE ${"9 ".repeat(150000)}`,
		`Amount Rate Extended ${"1".repeat(250000)}`,
		`Amount Rate Extended ${"12 ".repeat(60000)}${"$1.00 ".repeat(30000)}Total:`,
		`Amount Rate Extended 5 $1.00 $5.00 ${"Line Haul - ".repeat(40000)}Total:`,
		`Load Miles:${" ".repeat(200000)}5`,
		`Rate Detail Amount Rate Extended ${"Line Haul 1".repeat(40000)}`,
		" ".repeat(400000),
	];
	for (const [i, text] of hostile.entries()) {
		const started = process.hrtime.bigint();
		const r = P(text);
		const ms = Number(process.hrtime.bigint() - started) / 1e6;
		t(ms < 750 && typeof r.status === "string", `8 hostile text ${i + 1} is read in bounded time`, `${ms.toFixed(0)} ms, ${r.status}`);
	}
	const capped = P(`${"x".repeat(M.MAX_TEXT_CHARS)} ${ROW}`);
	t(capped.status === "no_miles", "8 text past the cap is never read", show(capped));
}

// 9 label count != triple count
{
	const fewer = P("Amount Rate Extended 624 624 379 $1.80 $0.89 $2.69 $1,123.20 $555.36 $1,019.51 Line Haul - PER MILE Empty Movement - PER MILE Total: $2,698.07");
	t(fewer.status === "conflict" && fewer.loadedMiles === null && fewer.emptyMiles === null, "9 three triples and two labels: conflict, nothing assigned", show(fewer));
	const more = P("Amount Rate Extended 624 379 $1.80 $2.69 $1,123.20 $1,019.51 Line Haul - PER MILE Fuel Surcharge - PER MILE Empty Movement - PER MILE Total: $2,142.71");
	t(more.status === "conflict" && more.loadedMiles === null, "9 two triples and three labels: conflict", show(more));
	const ragged = P("Amount Rate Extended 624 624 $1.80 $0.89 $2.69 $1,123.20 $555.36 Line Haul - PER MILE Fuel Surcharge - PER MILE Total:");
	t(ragged.status === "conflict", "9 quantities, rates and amounts of different counts: conflict", show(ragged));
	const unknownLabel = P("Amount Rate Extended 624 1 $1.80 -$35.00 $1,123.20 -$35.00 Line Haul - PER MILE Missing DVIR Inspection Total:");
	t(unknownLabel.status === "conflict", "9 a label the table cannot be split on: conflict", show(unknownLabel));
}

// 10 the fuel surcharge never adds to the loaded miles
{
	const fuelOnly = P("Rate Detail Amount Rate Extended Line Haul 1.00 $1,200.00 $1,200.00 Fuel Surcharge 500.00 $0.75 $375.00 Total: $1,575.00");
	t(fuelOnly.status === "no_miles" && fuelOnly.loadedMiles === null, "10 a per-mile fuel surcharge alone states no loaded miles", show(fuelOnly));
	const both = P(COLUMN);
	t(both.loadedMiles === 624, "10 a line haul and a fuel surcharge of 624 each are 624 loaded miles, not 1,248", show(both));
	const emptyOnly = P("Amount Rate Extended 1 120 $900.00 $2.55 $900.00 $306.00 Line Haul - FLAT RATE Empty Movement - PER MILE Total: $1,206.00");
	t(emptyOnly.status === "ok" && emptyOnly.loadedMiles === null && emptyOnly.emptyMiles === 120, "10 a flat line haul with a stated empty leg: empty 120, loaded unknown", show(emptyOnly));
}

// the result never carries text from the document
{
	const r = P(BOOKED);
	t(Object.keys(r).sort().join(",") === "emptyMiles,loadedMiles,status", "the result carries the two figures and a status only", Object.keys(r).join(","));
	t(!JSON.stringify(M.milesFromPdfText(BOOKED, 1000)).includes("Sentinel"), "nothing from the document's text comes back");
}

if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
