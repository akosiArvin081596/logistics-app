#!/usr/bin/env node
// Deterministic check on client/src/lib/address.js → splitRoute() /
// resolveLoadRoute(), the discriminator that decides whether Job Tracking's
// `Details` column is holding a ROUTE or a COMMODITY.
//
// WHY THIS EXISTS. `Details` is the commodity column (the Gemini rate-con prompt
// defines it as "commodity / weight / units / pallets / temperature / equipment",
// and POST /api/loads/from-ratecon writes exactly that). The n8n email path's
// `Update Job Tracking (Distance)` node overwrote it with a route string on
// every ingest, so production carries BOTH shapes: 324 of 344 populated rows are
// route-shaped, the rest are real commodities, and the ~324 are unrecoverable.
// The overwrite is being stopped — which means the readers must, from today,
// tell the two apart rather than assuming a route.
//
// The old readers split on a bare hyphen with no test at all. Fed a commodity
// that yields "12x32 DAIRY PURE WholeMilk, 43,764 lbs" as an origin CITY, which
// rode into the driver's load-assigned notification via POST /api/dispatch.
//
// A test that only proves "routes parse" would pass on `() => true`. Every case
// below is therefore paired: the commodities MUST be rejected. Values are
// copied verbatim from production rows and from n8n execution 2457.
//
// No network, no sheet, no database — pure input/output, safe to run anywhere.
//
//   node scripts/test-details-route-vs-commodity.js     # exits 1 on any failure

const path = require("path");
const { pathToFileURL } = require("url");

const MODULE_PATH = path.join(__dirname, "..", "client", "src", "lib", "address.js");

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		pass++;
	} else {
		fail++;
		console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
	}
}

// Job Tracking's real 26-column header row, read off the live sheet schema
// cached in the n8n `Update Job Tracking (Distance)` node. Note what is NOT
// here: no "city" column of any kind. That is precisely why the dashboard
// store's /origin|pickup.*city|shipper.*city/ lookup matched nothing and its
// `Details` fallback fired on every dispatch.
const JT_HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver",
	"Pickup Info", "Pickup Appointment", "Pickup Address",
	"Drop-off Info", "Drop-off Appointment", "Drop-off Address",
	"Job Status", "Phase of Progress", "Carrier Stage", "  Payment  ",
	"Broker Contact Name", "Phone Number", "Email", "Location Link",
	"Documents", "Assigned Date", "Status Update Date", "Completion Date",
	"Truck", "Owner ID", "output",
];

(async () => {
	const mod = await import(pathToFileURL(MODULE_PATH).href);
	const { splitRoute, looksLikeRoute, pickAddressColumn, resolveLoadRoute, formatLoadRoute } = mod;

	// ---------------------------------------------------------------
	// 1. ROUTE-SHAPED values must be recognised (the 324 historical rows)
	// ---------------------------------------------------------------
	// Two writers produced these and their formats differ. lib/ratecon-load.js
	// cityStateZip() emits "City, ST 12345"; the retired n8n LLM emitted
	// "City, ST, 12345". Both are in the sheet, so both must parse.
	check("route: app format",
		splitRoute("Tulsa, OK 74134 - JOPLIN, MO 64803"),
		{ origin: "Tulsa, OK 74134", destination: "JOPLIN, MO 64803" });
	check("route: LLM format (comma before ZIP) — n8n exec 2457",
		splitRoute("Tulsa, OK, 74134 - Joplin, MO, 64803"),
		{ origin: "Tulsa, OK, 74134", destination: "Joplin, MO, 64803" });
	check("route: no ZIP",
		splitRoute("Laredo, TX - Tomball, TX"),
		{ origin: "Laredo, TX", destination: "Tomball, TX" });
	check("route: ZIP+4",
		splitRoute("HUTCHINS, TX 75141-3714 - Kansas City, MO 64116"),
		{ origin: "HUTCHINS, TX 75141-3714", destination: "Kansas City, MO 64116" });
	check("route: en-dash separator",
		splitRoute("Ames, IA 50010 – Chicago, IL 60607"),
		{ origin: "Ames, IA 50010", destination: "Chicago, IL 60607" });
	check("route: arrow separator (already-formatted value)",
		splitRoute("Ames, IA 50010 → Chicago, IL 60607"),
		{ origin: "Ames, IA 50010", destination: "Chicago, IL 60607" });
	check("route: Canadian province (Bison runs cross-border)",
		splitRoute("Winnipeg, MB - Fargo, ND 58102"),
		{ origin: "Winnipeg, MB", destination: "Fargo, ND 58102" });

	// ⚠️ The hyphenated city. Every old reader split on /\s*-\s*/, which cuts
	// "Winston-Salem" in half. Requiring whitespace on BOTH sides is what makes
	// this a two-part split instead of a three-part one.
	check("route: hyphenated city name survives",
		splitRoute("Winston-Salem, NC 27101 - Dallas, TX 75201"),
		{ origin: "Winston-Salem, NC 27101", destination: "Dallas, TX 75201" });

	// ---------------------------------------------------------------
	// 2. COMMODITY values must be REJECTED — the half that discriminates
	// ---------------------------------------------------------------
	// Each of these is what `Details` is FOR, and each would have been parsed as
	// a lane by the old readers.
	check("commodity: dairy (the brief's example)",
		splitRoute("12x32 DAIRY PURE WholeMilk, 43,764 lbs, 1,575 Case(s)"), null);
	check("commodity: CHEP pallets — the value n8n exec 2457 destroyed",
		splitRoute("Empty CHEP Pallets, 33,556.15 lbs, 540 Units, 53' Dry Van Trailer Required"), null);
	check("commodity: hyphen inside prose",
		splitRoute("Frozen Foods - Keep at -10F"), null);
	check("commodity: temperature-controlled with spaced hyphen",
		splitRoute("Produce, 40,000 lbs - Reefer 34F Continuous"), null);

	// ⚠️ The nastiest false-positive shape: a real two-letter STATE CODE inside
	// commodity prose. "IN" is Indiana and "OR" is Oregon. Only the end-anchor
	// rejects these — a bare /[A-Z]{2}/ scan would call both a route.
	check("commodity: 'IN' mid-string is not Indiana",
		splitRoute("Steel Coils, 44,000 lbs - Tarps, IN transit"), null);
	check("commodity: 'OR' mid-string is not Oregon",
		splitRoute("Dry Goods - Palletized OR floor loaded"), null);

	check("commodity: trailing 'lbs' is not a state",
		splitRoute("Machine Parts - 12,000 lbs"), null);
	check("commodity: trailing 'Units' is not a state",
		splitRoute("Beverages, 22 Pallets - 540 Units"), null);
	check("commodity: trailing '(s)' is not a state",
		splitRoute("Assorted Freight - 1,575 Case(s)"), null);

	// ⚠️ THE CASES THAT MAKE REGION_CODES LOAD-BEARING. Everything above is
	// rejected by the end-anchor alone, so without these a mutant that accepted
	// ANY two letters would pass the whole suite (verified — it did).
	//
	// Freight units are overwhelmingly two-letter codes — LB, FT, EA, PC, CS,
	// PL, BX, KG — and they sit exactly where a state code sits: at the end of a
	// segment, after a space or comma. Matching a real region set is the only
	// thing separating them from a lane.
	check("commodity: 'LB' / 'FT' unit codes are not states",
		splitRoute("Steel Coils, 44,000 LB - Flatbed, 48 FT"), null);
	check("commodity: 'PC' / 'EA' unit codes are not states",
		splitRoute("Assorted Freight, 12 PC - Repack, 500 EA"), null);
	check("commodity: unit code with a numeric tail still rejected",
		splitRoute("Paper Rolls, 20 CS 40000 - Dry Van, 53 FT"), null);

	// ⚠️ And the case that makes "BOTH sides must be a place" load-bearing.
	// "CT" genuinely IS Connecticut, so side one passes on its own; only the
	// requirement that side two also resolve rejects this. A mutant using || in
	// place of && reads this as a lane from "Frozen Goods, 40 CT".
	check("commodity: a real state code on ONE side is not enough",
		splitRoute("Frozen Goods, 40 CT - Reefer, 53 FT"), null);

	// ⚠️ THE CASE THAT MAKES THE `(?:^|[\s,])` BOUNDARY LOAD-BEARING. Freight
	// abbreviations routinely END in a real state code without containing one:
	// "CTN" (cartons) ends in TN = Tennessee, "PAL" (pallets) ends in AL =
	// Alabama. Only the requirement that the code be preceded by a space or a
	// comma rejects these; a set-membership test alone reads them as a lane.
	check("commodity: 'CTN' / 'PAL' end in real state codes but are not places",
		splitRoute("Frozen Goods, 40 CTN - Dry Van, 20 PAL"), null);

	// Positive control for the same code path — lowercase must still resolve, or
	// the set-membership test would be doing its job by accident.
	check("route: lowercase state codes still parse",
		splitRoute("tulsa, ok 74134 - joplin, mo 64803"),
		{ origin: "tulsa, ok 74134", destination: "joplin, mo 64803" });

	// Sentinels the pipeline itself writes. calculateRatePerMile() returns
	// "Distance unavailable" whenever the Distance Matrix call fails, and the
	// retired LLM wrote the N/A placeholder when handed no addresses. Neither is
	// a route, and neither must be presented to a driver as one.
	check("sentinel: Distance unavailable", splitRoute("Distance unavailable"), null);
	check("sentinel: N/A placeholder (both sides)",
		splitRoute("N/A, N/A, N/A - N/A, N/A, N/A"), null);
	check("sentinel: half-N/A — load 550303758, whose Drop-off Address is empty",
		splitRoute("Hawkins, TX, 75765 - N/A, N/A, N/A"), null);

	// Degenerate inputs.
	check("empty string", splitRoute(""), null);
	check("null", splitRoute(null), null);
	check("undefined", splitRoute(undefined), null);
	check("no separator at all", splitRoute("Dallas, TX 75201"), null);
	check("three parts", splitRoute("A, TX 1 - B, TX 2 - C, TX 3"), null);
	check("looksLikeRoute agrees with splitRoute (route)",
		looksLikeRoute("Tulsa, OK 74134 - JOPLIN, MO 64803"), true);
	check("looksLikeRoute agrees with splitRoute (commodity)",
		looksLikeRoute("12x32 DAIRY PURE WholeMilk, 43,764 lbs"), false);

	// ---------------------------------------------------------------
	// 3. pickAddressColumn — must prefer *Address over *Info
	// ---------------------------------------------------------------
	// "Pickup Info" carries broker references ("Brothers WMS RDC - MPS REF/PU#:
	// 29284990"), NOT an address — and note it contains a spaced hyphen, so
	// picking it would feed junk straight into the route line.
	check("pickAddressColumn: pickup prefers Address over Info",
		pickAddressColumn(JT_HEADERS, /origin|pickup|shipper/i), "Pickup Address");
	check("pickAddressColumn: drop prefers Address over Info/Appointment",
		pickAddressColumn(JT_HEADERS, /dest|drop|receiver|delivery|consignee/i), "Drop-off Address");
	check("pickAddressColumn: no match -> null",
		pickAddressColumn(["Load ID", "Driver"], /origin|pickup|shipper/i), null);

	// ---------------------------------------------------------------
	// 4. resolveLoadRoute — the order of trust, on the real header row
	// ---------------------------------------------------------------
	// (a) Server enrichment wins. This is the /api/dashboard case.
	check("resolve: _pickupLocation/_dropLocation win over everything",
		resolveLoadRoute({
			_pickupLocation: "Tulsa, OK 74134",
			_dropLocation: "Joplin, MO 64803",
			"Pickup Address": "1234 Wrong St, Nowhere, ZZ 00000",
			Details: "12x32 DAIRY PURE WholeMilk, 43,764 lbs",
		}, JT_HEADERS),
		{ origin: "Tulsa, OK 74134", destination: "Joplin, MO 64803" });

	// ⚠️ THE CASE THAT MAKES THE ORDER OF TRUST LOAD-BEARING, and the one that
	// describes 324 production rows: the address columns AND a route-shaped
	// `Details` are both populated. The columns must win. `Details` is the
	// retired LLM's rendering of the lane — it is the value that read
	// "Tulsa, OK, 74134" where the app's own parser reads "Tulsa, OK 74134" —
	// so treating it as authoritative re-creates the bug in a quieter form.
	check("resolve: address columns beat a route-shaped Details",
		resolveLoadRoute({
			"Pickup Address": "500 Bell Avenue, Ames, IA 50010",
			"Drop-off Address": "1000 W Fulton Market, Chicago, IL 60607",
			Details: "Tulsa, OK 74134 - JOPLIN, MO 64803",
		}, JT_HEADERS),
		{ origin: "Ames, IA 50010", destination: "Chicago, IL 60607" });
	check("resolve: _pickupLocation beats a route-shaped Details",
		resolveLoadRoute({
			_pickupLocation: "Irving, TX 75063",
			_dropLocation: "Laredo, TX 78045",
			Details: "Tulsa, OK 74134 - JOPLIN, MO 64803",
		}, JT_HEADERS),
		{ origin: "Irving, TX 75063", destination: "Laredo, TX 78045" });

	// (b) Address columns, reduced to their city line. This is the driver case —
	// /api/driver/:driverName ships raw sheet rows with no _pickupLocation.
	check("resolve: falls back to the address columns, city line only",
		resolveLoadRoute({
			"Pickup Address": "4528 W Royal Ln\nIrving, TX 75063",
			"Drop-off Address": "818 Hallmark Dr\nLAREDO, TX 78045",
			Details: "Empty CHEP Pallets, 33,556.15 lbs, 540 Units",
		}, JT_HEADERS),
		{ origin: "Irving, TX 75063", destination: "LAREDO, TX 78045" });

	// ⚠️ THE REGRESSION THIS WHOLE CHANGE EXISTS TO PREVENT. A commodity in
	// `Details` must contribute NOTHING, even with no addresses to fall back on.
	check("resolve: a commodity never becomes a route",
		resolveLoadRoute({ Details: "12x32 DAIRY PURE WholeMilk, 43,764 lbs, 1,575 Case(s)" }, JT_HEADERS),
		{ origin: "", destination: "" });
	check("resolve: a commodity yields no route line at all",
		formatLoadRoute({ Details: "Empty CHEP Pallets, 33,556.15 lbs, 540 Units" }, JT_HEADERS), "");

	// (c) A route-shaped `Details` is still honoured as a last resort — this is
	// what keeps the ~324 historical rows rendering after the fix.
	check("resolve: route-shaped Details still used when addresses are blank",
		resolveLoadRoute({ Details: "Tulsa, OK 74134 - JOPLIN, MO 64803" }, JT_HEADERS),
		{ origin: "Tulsa, OK 74134", destination: "JOPLIN, MO 64803" });

	// (d) Per-side fill. Load 550303758 really does have an empty Drop-off
	// Address in production; a one-sided answer is the honest one.
	check("resolve: one blank side stays blank rather than inventing a city",
		resolveLoadRoute({
			"Pickup Address": "3265 South FM 2869, Hawkins, TX 75765",
			"Drop-off Address": "",
			Details: "Hawkins, TX, 75765 - N/A, N/A, N/A",
		}, JT_HEADERS),
		{ origin: "Hawkins, TX 75765", destination: "" });

	// (e) Never pick up the broker-reference column. "Pickup Info" contains a
	// spaced hyphen, so if it were ever chosen the route line would read
	// "Brothers WMS RDC" -> "MPS REF/PU#: 29284990".
	check("resolve: ignores Pickup Info entirely",
		resolveLoadRoute({
			"Pickup Info": "Brothers WMS RDC - MPS REF/PU#: 29284990",
			"Pickup Address": "500 Bell Avenue, Ames, IA 50010",
			"Drop-off Address": "1000 W Fulton Market, Chicago, IL 60607",
		}, JT_HEADERS),
		{ origin: "Ames, IA 50010", destination: "Chicago, IL 60607" });

	// (f) Empty / missing everything.
	check("resolve: empty load", resolveLoadRoute({}, JT_HEADERS), { origin: "", destination: "" });
	check("resolve: null load", resolveLoadRoute(null, JT_HEADERS), { origin: "", destination: "" });
	check("resolve: null headers", resolveLoadRoute({ _pickupLocation: "Tulsa, OK" }, null),
		{ origin: "Tulsa, OK", destination: "" });
	check("format: one-sided renders an em-dash for the unknown half",
		formatLoadRoute({ _pickupLocation: "Tulsa, OK 74134" }, JT_HEADERS), "Tulsa, OK 74134 → —");

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
	console.error("harness error:", err);
	process.exit(1);
});
