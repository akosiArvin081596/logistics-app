// ELD provider selector — the single module server.js requires ("./lib/eld").
//
// Reads process.env.ELD_PROVIDER ("apollo" | "routemate") AT CALL TIME and
// dispatches each call in the provider-neutral interface to the active adapter.
// Default is "routemate" (unchanged behavior until the Apollo cutover flag flips,
// so this migration ships dormant). Both adapters return IDENTICAL neutral shapes
// (notably the `eld_vehicle_id` / `eld_driver_id` keys), so every downstream
// caller stays provider-agnostic — swapping providers is a one-env-var change.
//
// Reading the flag at call time (not at require time) means flipping ELD_PROVIDER
// takes effect on the next call without a require-cache reset, and lets tests
// toggle providers in-process.

const routemate = require("./routemate");
const apollo = require("./apollo");

const ADAPTERS = { routemate, apollo };
const DEFAULT_PROVIDER = "routemate";

// The active provider name, resolved from ELD_PROVIDER on every call. Falls back
// to the default for an unset/blank/unknown value (never throws).
function activeProvider() {
	const p = String(process.env.ELD_PROVIDER || "").trim().toLowerCase();
	return ADAPTERS[p] ? p : DEFAULT_PROVIDER;
}

// The active adapter module.
function adapter() {
	return ADAPTERS[activeProvider()];
}

module.exports = {
	// Introspection + direct adapter access (for tests / diagnostics).
	activeProvider,
	routemate,
	apollo,

	// Provider-neutral interface — each dispatches to the active adapter.
	getCompany: (...args) => adapter().getCompany(...args),
	listLiveLocations: (...args) => adapter().listLiveLocations(...args),
	getVehicleLocation: (...args) => adapter().getVehicleLocation(...args),
	listVehicles: (...args) => adapter().listVehicles(...args),
	listFaultCodes: (...args) => adapter().listFaultCodes(...args),
	listDvirs: (...args) => adapter().listDvirs(...args),
	listIftaMileage: (...args) => adapter().listIftaMileage(...args),
	listDrivers: (...args) => adapter().listDrivers(...args),
	listHosClocks: (...args) => adapter().listHosClocks(...args),
};
