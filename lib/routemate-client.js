// Routemate AI ELD/telematics API client.
//
// Single point of contact with cloud.routemate.ai. Every other module in the
// app talks to Routemate through this adapter so a future API change ripples
// through one file. Auth is X-Api-Key header; retry/backoff and 15s timeout
// mirror the Gemini OCR pattern in server.js.
//
// Spec reference: https://cloud.routemate.ai/v3/api-docs (OpenAPI 3.0.1).
// All list endpoints require pagination params (page, elements, asc, orderBy),
// even when we want the whole set — defaults below are safe.

const DEFAULT_BASE_URL = "https://cloud.routemate.ai";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;

// Pagination defaults. The spec marks these as required — we always send them.
const DEFAULT_PAGE = { page: 0, elements: 200, asc: true, orderBy: "id" };

function buildQuery(params) {
	const usp = new URLSearchParams();
	for (const [k, v] of Object.entries(params || {})) {
		if (v === undefined || v === null) continue;
		usp.append(k, String(v));
	}
	const s = usp.toString();
	return s ? `?${s}` : "";
}

// Internal: HTTP wrapper with X-Api-Key, retry, timeout, JSON parse.
// Returns the parsed response body. Throws on non-2xx after retries exhausted.
async function request({ apiKey, baseUrl }, method, path, { query, body, retries } = {}) {
	if (!apiKey) {
		const err = new Error("Routemate API key not configured");
		err.code = "ROUTEMATE_NO_KEY";
		throw err;
	}
	const url = `${baseUrl || DEFAULT_BASE_URL}${path}${buildQuery(query)}`;
	let lastErr = null;
	// ⚠️ A caller may pass retries:0 for an endpoint whose failure is KNOWN to be
	// permanent. Retrying a deterministic 500 three times buys nothing and costs
	// three requests plus 3.5 s of backoff on every boot — see listVehicles().
	const maxRetries = Number.isInteger(retries) ? Math.max(0, retries) : DEFAULT_RETRIES;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const isLastAttempt = attempt === maxRetries;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		try {
			const resp = await fetch(url, {
				method,
				headers: {
					"X-Api-Key": apiKey,
					"Accept": "application/json",
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
			if (!resp.ok) {
				const text = await resp.text().catch(() => "");
				const err = new Error(`Routemate ${resp.status}: ${text.slice(0, 200)}`);
				err.status = resp.status;
				// Don't retry 4xx (auth/validation) — fail fast.
				if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw err;
				lastErr = err;
				// ⚠️ NO BACKOFF AFTER THE FINAL ATTEMPT. The loop is about to exit and
				// throw, so sleeping here delays the caller by up to 2 s and buys
				// nothing. This fires on every exhausted call, not just the known-bad
				// vehicles list — the telemetry 408/503 flapping paid it too.
				if (isLastAttempt) break;
				// Exponential backoff for 5xx and 429.
				await sleep(500 * Math.pow(2, attempt));
				continue;
			}
			// Some endpoints return JSON, some return empty — guard parse.
			const text = await resp.text();
			if (!text) return null;
			try { return JSON.parse(text); }
			catch { return text; }
		} catch (err) {
			lastErr = err;
			if (err.code === "ROUTEMATE_NO_KEY") throw err;
			if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
			if (isLastAttempt) break;
			await sleep(500 * Math.pow(2, attempt));
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr || new Error("Routemate request failed");
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// --- Normalized accessors ---
// Each function returns an object whose keys map cleanly onto our SQLite
// schema. If Routemate adds/renames a field, change it here only.

// GET /api/v0/company — lightest call, used as a smoke test.
async function getCompany(creds) {
	return request(creds, "GET", "/api/v0/company");
}

// GET /api/v0/vehicles/locations — all live vehicle GPS rows.
// Returns an array of normalized telemetry objects.
async function listLiveLocations(creds) {
	const raw = await request(creds, "GET", "/api/v0/vehicles/locations");
	const vehicles = (raw && raw.vehicles) || [];
	return vehicles.map(normalizeTelemetry);
}

// GET /api/v0/vehicle/location/{id} — single vehicle live GPS.
async function getVehicleLocation(creds, routemateVehicleId) {
	const raw = await request(creds, "GET", `/api/v0/vehicle/location/${encodeURIComponent(routemateVehicleId)}`);
	return raw ? normalizeTelemetry(raw) : null;
}

// GET /api/v0/assets/vehicles — paginated list of vehicles in the company.
// Returns an array of normalized vehicle objects (one page).
//
// ⚠️ retries: 0 IS DELIBERATE. This endpoint has returned a deterministic 500
// for this account since at least 2026-05-06 (see the singular sibling below),
// so the default 3 attempts cost three requests and 3.5 s of backoff to reach
// the same failure every time — on every boot and every daily tick. One attempt
// is enough to learn what we already know.
//
// The call is kept rather than removed so it self-heals the day Routemate fixes
// the endpoint. Nothing depends on it succeeding: routemateSyncVehicles() treats
// a 5xx from here as "list unavailable" — the known outage, NOT a failed sync —
// seeds ids from telemetry, refreshes each known vehicle through getVehicle()
// below, and reports success. Vehicle discovery is also covered by
// listLiveLocations() (polled every 60 s). A 4xx (bad key) or a network failure
// thrown from here is still a failed sync.
async function listVehicles(creds, paging = {}) {
	const query = { ...DEFAULT_PAGE, ...paging };
	const raw = await request(creds, "GET", "/api/v0/assets/vehicles", { query, retries: 0 });
	const data = (raw && (raw.data || raw.vehicles)) || [];
	return data.map(normalizeVehicle);
}

// GET /api/v0/assets/vehicle/{id} — SINGULAR, and deliberately so.
//
// The paginated sibling above (/assets/vehicles, plural) returns HTTP 500 for
// this account and has done since at least 2026-05-06. Re-probed 2026-08-12:
// still 500 on EVERY parameter combination — elements 1/10/200, asc both ways,
// orderBy id/vin/vehicleId — and /assets/trailers 500s identically, so it is a
// Routemate-side bug in their pagination, not a bad request from us.
//
// This per-vehicle GET works and returns the complete record including the VIN,
// which is the field the /trucks link modal auto-matches on. It is therefore the
// ONLY working source of vehicle inventory detail for this account — see
// routemateHydrateVehicleDetails() in server.js, which walks known vehicle IDs
// through here precisely because the list endpoint cannot be relied on.
//
// Response is VehicleGetOneA: {data: VehicleA, extras: {company: ...}}. One
// unwrap and the payload is the same VehicleA shape the list returns, so
// normalizeVehicle is reused untouched.
//
// NOTE: IDs that are not Routemate vehicle IDs (e.g. Linxup device IDs, which
// share the routemate_vehicles mirror table) come back 400 "The given id must
// not be null" rather than 404. Callers treat a 4xx as "not a Routemate vehicle"
// and stop asking — EXCEPT 401/403 (our key refused) and 429 (throttled), which
// say nothing about the id. request() already fails fast on 4xx without retry.
async function getVehicle(creds, routemateVehicleId) {
	const raw = await request(creds, "GET", `/api/v0/assets/vehicle/${encodeURIComponent(routemateVehicleId)}`);
	const data = raw && raw.data;
	return data ? normalizeVehicle(data) : null;
}

// GET /api/v0/dtc/{vehicleId} — fault codes for a vehicle.
async function listFaultCodes(creds, routemateVehicleId, paging = {}) {
	const query = { ...DEFAULT_PAGE, ...paging };
	const raw = await request(creds, "GET", `/api/v0/dtc/${encodeURIComponent(routemateVehicleId)}`, { query });
	const data = (raw && raw.data) || [];
	return data.map((f) => ({ code: f.code || "", status: f.status || "" }));
}

// GET /api/v0/dvir/{vehicleId} — DVIR inspection reports for a vehicle.
async function listDvirs(creds, routemateVehicleId, paging = {}) {
	const query = { ...DEFAULT_PAGE, ...paging };
	const raw = await request(creds, "GET", `/api/v0/dvir/${encodeURIComponent(routemateVehicleId)}`, { query });
	const data = (raw && raw.data) || [];
	return data.map(normalizeDvir);
}

// GET /api/v0/ifta — vehicle mileage rollup. NOTE: spec returns mileage only,
// no fuel gallons. MPG must be derived from telemetry fuel% deltas (Phase 4).
async function listIftaMileage(creds, paging = {}) {
	const query = { ...DEFAULT_PAGE, ...paging };
	const raw = await request(creds, "GET", "/api/v0/ifta", { query });
	const data = (raw && raw.data) || [];
	return data.map((r) => ({
		routemate_vehicle_id: r.vehicleId || r.id || "",
		distance: typeof r.distance === "number" ? r.distance : 0,
	}));
}

// GET /api/v0/drivers — paginated driver list.
async function listDrivers(creds, paging = {}) {
	const query = { ...DEFAULT_PAGE, ...paging };
	const raw = await request(creds, "GET", "/api/v0/drivers", { query });
	const data = (raw && raw.data) || [];
	return data.map((d) => ({
		routemate_driver_id: d.driverId || d.id || "",
		driver_name: d.driverName || `${d.firstName || ""} ${d.lastName || ""}`.trim(),
		email: d.email || "",
		phone: d.phoneNum || "",
		duty_status: d.dutyStatus || "",
		last_sync: d.lastSync || "",
		status: d.status || "",
	}));
}

// GET /api/v0/drivers/hos — current HOS clocks for all drivers (the only
// HOS endpoint in the Routemate spec). Response is DriverProfileGetOneA:
// { data: [DriverProfilesSimpleViewA...], meta: { totalElements } } where each
// row carries breakTime/driveTime/shiftTime/cycleTime/cycleTomorrowTime as
// int64 countdowns. Units are undocumented in the spec; every other time
// field in the Routemate API (locationDate, log start/end, DOB) is epoch
// milliseconds, so these are normalized as milliseconds-remaining. If live
// data ever proves them to be seconds, fix the conversion in normalizeHos()
// only — every downstream consumer reads the *_ms fields.
// Pagination params are REQUIRED by the spec; defaults are always sent.
async function listHosClocks(creds, paging = {}) {
	const query = { ...DEFAULT_PAGE, orderBy: "driverName", ...paging };
	const raw = await request(creds, "GET", "/api/v0/drivers/hos", { query });
	const data = (raw && raw.data) || [];
	const total = raw && raw.meta && typeof raw.meta.totalElements === "number"
		? raw.meta.totalElements
		: data.length;
	return { total, rows: data.map(normalizeHos) };
}

// --- Normalizers ---

// Routemate's `speed` field on ApiVehicleW is reported in MPH (US ELD provider,
// undocumented in the spec but verified empirically: odometer delta over a 30-min
// window matches the integral of `speed` only when interpreted as mph — 73 mph
// average = 37 miles in 30 min, m/s would imply 134 mph which is impossible).
// LogisX's existing tracking stack — driver_locations, /api/locations/latest,
// the Socket.IO location-update event, and the frontend Math.round(speed*2.237)
// renderer — all expect speed in METERS PER SECOND (browser geolocation native).
// Converting at the adapter boundary keeps every downstream consumer unchanged.
const MPH_TO_MPS = 0.44704;

function normalizeTelemetry(v) {
	return {
		routemate_vehicle_id: v.id || "",
		vehicle_id: v.vehicleId || "",
		latitude: typeof v.latitude === "number" ? v.latitude : null,
		longitude: typeof v.longitude === "number" ? v.longitude : null,
		// Convert mph → m/s so this matches phone-GPS-shaped speed everywhere.
		speed: typeof v.speed === "number" ? v.speed * MPH_TO_MPS : 0,
		bearing: v.bearing || "",
		odometer: typeof v.odometer === "number" ? v.odometer : 0,
		engine_hours: typeof v.engineHours === "number" ? v.engineHours : 0,
		fuel_pct: typeof v.fuel === "number" ? v.fuel : null,
		geocoded_location: v.geoCodedLocation || "",
		// Routemate locationDate is epoch milliseconds.
		location_date_ms: typeof v.locationDate === "number" ? v.locationDate : 0,
		time_zone_offset: typeof v.timeZoneOffset === "number" ? v.timeZoneOffset : 0,
	};
}

function normalizeVehicle(v) {
	return {
		routemate_vehicle_id: v.id || "",
		vehicle_id: v.vehicleId || "",
		vin: v.vin || "",
		make: v.make || "",
		model: v.model || "",
		year: typeof v.year === "number" ? v.year : 0,
		fuel_type: v.fuelType || "",
		license_num: v.licenseNum || "",
		eld_id: v.eldId || "",
		gps_ids: Array.isArray(v.gpsIds) ? v.gpsIds : [],
		state: v.state || "",
		active: v.active !== false,
		raw: v,
	};
}

// DriverProfilesSimpleViewA → normalized HOS row. Clock fields are
// milliseconds remaining on each FMCSA clock (see listHosClocks note);
// null when Routemate omits the field. Negative values (driver in
// violation) are passed through — display layers clamp/flag them.
function clockMs(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function normalizeHos(d) {
	return {
		routemate_driver_id: d.driverId || d.id || "",
		driver_name: d.driverName || "",
		vehicle_id: d.vehicleId || "",
		duty_status: d.dutyStatus || "",
		break_ms: clockMs(d.breakTime),
		drive_ms: clockMs(d.driveTime),
		shift_ms: clockMs(d.shiftTime),
		cycle_ms: clockMs(d.cycleTime),
		cycle_tomorrow_ms: clockMs(d.cycleTomorrowTime),
	};
}

function normalizeDvir(d) {
	return {
		dvir_id: d.id || "",
		date_ms: typeof d.date === "number" ? d.date : 0,
		driver_name: d.driverName || "",
		report_type: d.reportType || "",
		status: d.status || "",
		unresolved_defects: Array.isArray(d.unresolvedDefects) ? d.unresolvedDefects : [],
		corrected_defects: Array.isArray(d.correctedDefects) ? d.correctedDefects : [],
	};
}

module.exports = {
	getCompany,
	listLiveLocations,
	getVehicleLocation,
	listVehicles,
	getVehicle,
	listFaultCodes,
	listDvirs,
	listIftaMileage,
	listDrivers,
	listHosClocks,
};
