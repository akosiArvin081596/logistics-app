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
async function request({ apiKey, baseUrl }, method, path, { query, body } = {}) {
	if (!apiKey) {
		const err = new Error("Routemate API key not configured");
		err.code = "ROUTEMATE_NO_KEY";
		throw err;
	}
	const url = `${baseUrl || DEFAULT_BASE_URL}${path}${buildQuery(query)}`;
	let lastErr = null;
	for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
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
async function listVehicles(creds, paging = {}) {
	const query = { ...DEFAULT_PAGE, ...paging };
	const raw = await request(creds, "GET", "/api/v0/assets/vehicles", { query });
	const data = (raw && (raw.data || raw.vehicles)) || [];
	return data.map(normalizeVehicle);
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

// GET /api/v0/drivers/hos — HOS clocks snapshot. Shape varies; return raw
// for now and let callers decide how to summarize.
async function getHosClocks(creds) {
	return request(creds, "GET", "/api/v0/drivers/hos");
}

// --- Normalizers ---

function normalizeTelemetry(v) {
	return {
		routemate_vehicle_id: v.id || "",
		vehicle_id: v.vehicleId || "",
		latitude: typeof v.latitude === "number" ? v.latitude : null,
		longitude: typeof v.longitude === "number" ? v.longitude : null,
		speed: typeof v.speed === "number" ? v.speed : 0,
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
	listFaultCodes,
	listDvirs,
	listIftaMileage,
	listDrivers,
	getHosClocks,
};
