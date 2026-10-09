"use strict";
// THE KPI CATALOG: the one list of the company KPIs the KPI bot computes, what
// each one means, and what it assumes. lib/kpi-metrics.js computes them, the
// nightly job stores them, GET /api/admin/kpis and the weekly digest show them,
// and an admin approves each one for public use.
//
// WHY THE DEFINITIONS LIVE HERE AND CARRY A VERSION. An approval says "this
// number, measured this way, may be published". When the way it is measured
// changes, the old approval no longer covers the new number, so it must lapse on
// its own: approvalIsValid() checks the approval row against the catalog's
// definitionVersion and against the settings the metric reads (settingsHashFor).
// Bump a metric's definitionVersion whenever its formula, its sources or its
// assumptions change in a way a reader of the number would care about.
//
// WHY "kind" IS PART OF THE DEFINITION. The digest and the admin page must never
// let an estimate read as a measurement: "real" is counted from records,
// "estimate" fills a gap with a stated assumption, "proxy" stands in for a
// figure the records cannot give, and "not_tracked" has no source at all.
//
// Pure: no I/O, no requires, no environment reads.

// The first month of every KPI series: the month the company's load records
// begin (the Job Tracking sheet's first delivered loads).
const KPI_SERIES_START = "2025-04";

// US short ton. Freight is quoted to customers in pounds; tons here are the
// 2,000 lb ton, never the 2,204.6 lb metric tonne.
const LB_PER_TON = 2000;

// Tailpipe CO2 from burning one US gallon of diesel, in kg. The EPA fact sheet
// "Greenhouse Gas Emissions from a Typical Passenger Vehicle" (EPA-420-F-23-014)
// gives 10,180 grams CO2 per gallon of diesel (checked 2026-10-09). The EPA
// Emission Factors Hub gives a slightly different figure (10.21); the fact sheet
// is the cited source, so a change of factor is a change of source and of
// co2_tonnes's definitionVersion.
const CO2_KG_PER_GALLON_DIESEL = 10.18;
const CO2_SOURCE = Object.freeze({
	label: "U.S. EPA, \"Greenhouse Gas Emissions from a Typical Passenger Vehicle\" (EPA-420-F-23-014): 10,180 grams CO2 per gallon of diesel",
	url: "https://www.epa.gov/greenvehicles/greenhouse-gas-emissions-typical-passenger-vehicle",
});

const KINDS = Object.freeze(["real", "estimate", "proxy", "not_tracked"]);
const UNITS = Object.freeze(["count", "usd", "lb_tons", "miles", "pct", "trucks", "units", "mpg", "gallons", "t_co2"]);
// Display groups, in the order the admin page and the digest show them.
const GROUPS = Object.freeze(["volume", "revenue", "operations", "fleet", "fuel", "automation"]);

// The settings a metric may read. Each is an admin setting stored in
// app_settings 'kpi.settings'; a metric lists the ones its number depends on in
// settingsUsed, and its approval lapses when any of them changes.
const SETTING_KEYS = Object.freeze(["aiDispatchStart", "dedicatedStart", "baselineMpg"]);

function entry(key, label, kind, unit, group, definition, assumptions, settingsUsed, source) {
	return Object.freeze({
		key,
		label,
		unit,
		kind,
		group,
		definition,
		definitionVersion: 1,
		assumptions: Object.freeze(assumptions.slice()),
		source: source || null,
		settingsUsed: Object.freeze(settingsUsed.slice()),
	});
}

// Order matters: the API, the admin page and the digest list metrics in this order.
const METRICS = Object.freeze([
	entry("freight_tons_stated", "Freight moved (stated weights)", "real", "lb_tons", "volume",
		"Total weight of delivered loads whose load details or rate confirmation state a weight, in US tons of 2,000 lb.",
		[
			"Only loads that state a weight are counted; the coverage line shows how many do.",
			"A weight written in the load details is used first, then the weight on the load's rate confirmation.",
			"A document that states two different weights is left out rather than guessed.",
		], []),
	entry("freight_tons_estimated", "Freight moved (estimated, all loads)", "estimate", "lb_tons", "volume",
		"Stated freight weight plus an estimate for the delivered loads that state none, in US tons of 2,000 lb.",
		[
			"Loads with no stated weight are assumed to weigh the average of loads that state one.",
			"Shown only once at least 20 delivered loads state a weight.",
		], []),
	entry("loads_delivered", "Loads delivered", "real", "count", "volume",
		"Number of loads marked Delivered, Completed or POD Received, counted on their completion date, else their drop-off appointment, else their pickup appointment.",
		[
			"Cancelled and deleted loads are left out.",
			"Loads with no usable date are counted in the coverage line but left out of the months.",
			"Each Load ID counts once, as everywhere in the app. Before April 2026 the same Load ID sometimes appears on several delivered rows (often with different appointments), so 2025 may be undercounted.",
		], []),
	entry("revenue", "Gross load revenue", "real", "usd", "revenue",
		"Total of the Payment figure on each delivered load, before driver pay, fuel and other costs, counted in the month Loads delivered dates the load.",
		[
			"This is gross load revenue, not the Financials P&L: Financials dates revenue by the load's assigned date and keeps closed months as settled, so a month can differ.",
			"Invoice adjustments are not included; they change the invoice only.",
			"Each Load ID counts once. In 2025, rows that share a Load ID keep one row's Payment, and many 2025 rows have none, so 2025 revenue is incomplete.",
		], []),
	entry("miles_driven", "Miles driven (ELD)", "real", "miles", "operations",
		"Miles driven by the fleet's trucks, summed from their ELD odometer readings.",
		[
			"Covers only the days since ELD records began; earlier months show no data.",
		], []),
	entry("on_time_rate", "On-time deliveries", "real", "pct", "operations",
		"Share of delivered loads that reached the receiver by the appointment time, judged in the receiver's local time.",
		[
			"Arrival is the ELD arrival at the receiver, else the first geofence arrival; a status a driver sets by hand is not an arrival.",
			"A time window is judged against its end. Date-only and first-come appointments are judged by day only and are left out of the on-time rate.",
			"An appointment more than 3 days from the arrival is treated as misread and left out.",
		], []),
	entry("fleet_trucks", "Trucks in fleet", "real", "trucks", "fleet",
		"Trucks in the fleet on the day: in service by their service dates and not marked Inactive.",
		[
			"Past months count every truck whose service dates cover the month's last day, whatever its status is today.",
		], []),
	entry("active_units", "Active units (drivers with a delivered load)", "proxy", "units", "fleet",
		"Number of different drivers who delivered at least one load in the period.",
		[
			"Stands in for fleet size in the months before truck records began.",
			"Some 2025 driver entries may be partner carriers rather than LogisX drivers.",
		], []),
	entry("fuel_mpg", "Fleet fuel economy", "real", "mpg", "fuel",
		"ELD miles divided by the gallons on fuel receipts, over the months that have both.",
		[
			"Rejected receipts are left out, and only receipts that show gallons are counted; the coverage line shows how many do.",
			"Receipts dated before ELD records began are left out, so miles and gallons cover the same days.",
			"Fuel bought without a receipt, or on a receipt that shows no gallons, is missing from the gallons, which makes this figure read high.",
		], []),
	entry("fuel_savings", "Diesel dollars saved vs baseline", "estimate", "usd", "fuel",
		"Diesel spend saved compared with a truck at the baseline fuel economy driving the same miles.",
		[
			"Compared with a truck at the baseline MPG set on this page driving the same ELD miles, priced at the average $/gal actually paid.",
		], ["baselineMpg"]),
	entry("co2_tonnes", "Carbon output (tailpipe CO2)", "real", "t_co2", "fuel",
		"Tailpipe carbon dioxide from the diesel on fuel receipts, in metric tonnes.",
		[
			"Tailpipe CO2 only, from receipt gallons; gallons for trailer refrigeration units on the same receipts are included.",
			"Fuel bought without a receipt, or on a receipt that shows no gallons, is missing, which makes this figure read low.",
		], [], CO2_SOURCE),
	entry("ai_tasks", "Tasks handled by AI", "real", "count", "automation",
		"Tasks an AI model handled: rate confirmations read from email into new loads, receipts read by AI, and AI expense insights and questions.",
		[
			"A load counts as read by AI when it came in through the email path, which leaves its Contract ID blank.",
		], []),
	entry("automated_tasks", "Tasks handled by automation (rules, not AI)", "real", "count", "automation",
		"Tasks handled by fixed rules without AI: load status updates from the geofence and automatic invoice runs.",
		[], []),
	entry("dispatch_calls", "Dispatch calls handled by AI", "not_tracked", "count", "automation",
		"Dispatch phone calls answered by an AI agent.",
		[
			"No call or voice system records dispatch calls, so this cannot be measured yet.",
		], []),
	entry("truck_utilization", "Truck utilization (active days)", "real", "pct", "operations",
		"Share of the days each truck with an ELD was in the fleet on which it drove more than 1 mile.",
		[
			"Counted from each truck's first ELD day, within its service dates.",
			"Before and after compares equal-length windows on each side of the date; the date itself counts as after.",
		], ["aiDispatchStart", "dedicatedStart"]),
	entry("paid_mile_share", "Paid-mile share (loaded ÷ total ELD miles)", "real", "pct", "operations",
		"Loaded miles divided by loaded plus empty (deadhead) miles, for loads whose legs the ELD measured in full.",
		[
			"Loads still in progress, loads that overlap another load, and loads with an unmeasured leg are left out.",
			"Before and after compares equal-length windows on each side of the date; the date itself counts as after.",
		], ["dedicatedStart"]),
]);

const METRIC_KEYS = Object.freeze(METRICS.map((m) => m.key));
const BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

function metricByKey(key) {
	return BY_KEY.get(String(key)) || null;
}

// One setting value as text, the same however it arrived: a date stays its
// 'YYYY-MM-DD', a number its shortest decimal form, anything unset is "".
function settingText(value) {
	if (value == null || value === "") return "";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
	return String(value).trim();
}

// The settings a metric's number depends on, as one stable string; "" for a
// metric that reads none. `settings` is the SAVED admin settings object
// (app_settings 'kpi.settings': null = not set), never a derived value, so the
// approval route and the response builder hash the same thing. Unknown keys and
// key order in `settings` do not matter: only settingsUsed is read, in its order.
function settingsHashFor(key, settings) {
	const def = metricByKey(key);
	if (!def || def.settingsUsed.length === 0) return "";
	const s = settings && typeof settings === "object" ? settings : {};
	return def.settingsUsed
		.map((k) => `${k}=${settingText(Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null)}`)
		.join("&");
}

// Is a kpi_metric_approvals row a CURRENT approval of `key`? Only when it is
// approved, for the catalog's current definition, and under the settings the
// metric reads now. Anything else (no row, an unknown key, an old definition, a
// changed setting) reads as not approved, so a changed metric is never published
// on an approval given to the old one.
function approvalIsValid(row, key, settings) {
	const def = metricByKey(key);
	if (!def || !row || typeof row !== "object") return false;
	return row.approved === 1
		&& row.definition_version === def.definitionVersion
		&& row.settings_hash === settingsHashFor(key, settings);
}

module.exports = {
	KPI_SERIES_START,
	LB_PER_TON,
	CO2_KG_PER_GALLON_DIESEL,
	CO2_SOURCE,
	KINDS,
	UNITS,
	GROUPS,
	SETTING_KEYS,
	METRICS,
	METRIC_KEYS,
	metricByKey,
	settingsHashFor,
	approvalIsValid,
};
