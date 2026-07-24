// Apollo ELD / telematics adapter (provider "apollo").
//
// One of two ELD adapters behind lib/eld/index.js — the provider-neutral
// selector that server.js consumes. Emits the SAME neutral shapes as
// lib/eld/routemate.js (notably the `eld_vehicle_id` / `eld_driver_id` keys),
// so downstream code stays provider-agnostic; the whole migration is "produce
// the neutral shapes from Apollo instead of Routemate."
//
// Apollo is a reseller of the ATCompass / ELD Roadmap platform. JSON, .NET-style
// RPC. Auth is `HOSClientApiKey` — a query param on GETs (URL-encoded, since the
// key can contain reserved chars like `?`) and a body field on POSTs. Retry/
// backoff and the 15s timeout mirror the Gemini OCR / Routemate pattern.
//
// Response envelope: most endpoints return `{ code, data }` where code===1 is OK
// and code===7 is an invalid key (treated as an error carrying the code). BUT
// `GetDashboards` returns a BARE ARRAY — unwrapEnvelope() handles both.
//
// ⚠️ NO VALID KEY YET: the provided key returns code:7, so no real response body
// has been observed. Every Apollo field access below is therefore isolated in a
// defensive normalizer with optional-chaining + fallbacks, and each field whose
// exact name is inferred from the DTO docs (not a real response) is tagged
// `// LIVE-CAPTURE: ...`. When a valid key arrives, ONLY the normalizers in this
// file should need to change.
//
// Spec: https://content.eldroadmap.com:9103 (base). Reseller endpoints
// (HOSClient/GetHOSClientsForReseller, HOSProvisioning/*) use a ResellerApiKey
// and are intentionally NOT implemented here.

const DEFAULT_BASE_URL = "https://content.eldroadmap.com:9103";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;

// Speed unit conversions. Apollo reports speed in the company's UnitCode: mph
// for MILES_GALLONS(1), km/h for KM_LITERS(2). Downstream (driver_locations,
// /api/locations/latest, the geofence + driver-pay travel-day check) all expect
// METERS PER SECOND. MPH_TO_MPS is the SAME constant lib/eld/routemate.js uses.
const MPH_TO_MPS = 0.44704;
const KMH_TO_MPS = 1 / 3.6;

// --- Apollo enums (from the docs "General" section) ---

// TimeZone enum → used to decode a dashboard row's zone when no numeric offset
// is present. Downstream driver-pay derives the zone from longitude, so this is
// only a hint (the neutral `time_zone_offset` field is otherwise unused).
const APOLLO_TIMEZONE = Object.freeze({
	EASTERN: 0,
	CENTRAL: 1,
	MOUNTAIN: 2,
	PACIFIC: 3,
	ALASKAN: 4,
	HAWAIIAN: 5,
	ATLANTIC: 6,
});
// Standard-time (non-DST) UTC offset in hours per TimeZone enum. Best-effort
// only — DST is not applied here.
const APOLLO_TZ_OFFSET_HOURS = Object.freeze({
	[APOLLO_TIMEZONE.EASTERN]: -5,
	[APOLLO_TIMEZONE.CENTRAL]: -6,
	[APOLLO_TIMEZONE.MOUNTAIN]: -7,
	[APOLLO_TIMEZONE.PACIFIC]: -8,
	[APOLLO_TIMEZONE.ALASKAN]: -9,
	[APOLLO_TIMEZONE.HAWAIIAN]: -10,
	[APOLLO_TIMEZONE.ATLANTIC]: -4,
});

// Asset Type enum — GetHOSAssetForClient returns tractors AND trailers; we keep
// tractors (the vehicles that carry the ELD/GPS) to mirror Routemate's list.
const APOLLO_ASSET_TYPE = Object.freeze({ TRACTOR: 0, TRAILER: 1 });

// Units enum — the company's measurement system. Drives the speed conversion.
const APOLLO_UNITS = Object.freeze({ MILES_GALLONS: 1, KM_LITERS: 2 });

// Response envelope `code` enum. Only 1 (OK) and 7 (invalid key) are CONFIRMED
// from live probing; the rest of the enum lives in the Apollo "General" docs.
// describeCode() names known codes and falls back to a numeric label so error
// messages are always meaningful.
const APOLLO_CODE = Object.freeze({
	OK: 1,
	HOSCLIENT_API_KEY_INVALID: 7,
	// LIVE-CAPTURE: fill remaining codes (2-6, 8+) from the "General" enum docs.
});
const APOLLO_CODE_NAME = Object.freeze({
	1: "OK",
	7: "HOSCLIENT_API_KEY_INVALID",
});

// --- Apollo endpoint paths (base + these; HOSClientApiKey added by request()) ---
const PATH_GET_HOS_CLIENT = "/HOSClient/GetHOSClient";            // POST only (GET → 405); BasicHOSClientDTO2
const PATH_GET_ASSETS = "/HOSAsset/GetHOSAssetForClient";        // GET; HOSAssetDTO[] — also the smoke-test call
const PATH_GET_DASHBOARDS = "/HOSDashboard/GetDashboards";       // GET; BARE ARRAY of status-board rows
const PATH_GET_DRIVERS = "/HOSDriver/GetHOSDrivers";             // GET; BasicHOSDriverDTO[]
const PATH_GET_DVIR = "/DVIR/GetDVIRReports";                    // POST; DVIR reports
const PATH_GET_IFTA = "/IFTA/GetIFTAReport";                     // POST; IFTAReportDTO (client-wide)
const PATH_GET_RECAP = "/HOSDriver/GetRecap";                    // POST; per-driver HOS clocks
const PATH_GET_DRIVER_RECORDS = "/HOSRecord/GetDriverRecords";   // GET; per-driver daily records (alt HOS source)
// ECM group. Confirmed method is GetECMConnections — it reports ECM *connection*
// status, NOT necessarily classic DTC fault codes; the normalizer only surfaces
// codes if the payload actually carries a per-code list (else []).
const PATH_GET_ECM = "/ECM/GetECMConnections";                  // GET; ECM connection status

// --- Small helpers ---

function buildQuery(params) {
	const usp = new URLSearchParams();
	for (const [k, v] of Object.entries(params || {})) {
		if (v === undefined || v === null) continue;
		usp.append(k, String(v));
	}
	// URLSearchParams percent-encodes reserved chars, incl. a literal '?' in the
	// API key (→ %3F), which is exactly the encodeURIComponent behavior required.
	const s = usp.toString();
	return s ? `?${s}` : "";
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// First value that is neither undefined nor null (so 0 / "" are preserved).
function firstDefined(...vals) {
	for (const v of vals) if (v !== undefined && v !== null) return v;
	return undefined;
}

// First value that is a finite number; else null (matches Routemate's
// `typeof x === "number" ? x : null` guard for lat/lng/fuel).
function firstNum(...vals) {
	for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
	return null;
}

// Coerce an unknown value into an array. Some .NET envelopes wrap rows in
// `.data` (already unwrapped by the caller) or a `.items`/`.Items` collection.
function safeArray(v) {
	if (Array.isArray(v)) return v;
	if (v && Array.isArray(v.items)) return v.items;
	if (v && Array.isArray(v.Items)) return v.Items;
	return [];
}

// FMCSA clock value → milliseconds-remaining or null (mirrors routemate.js).
function clockMs(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Normalize an Apollo timestamp to epoch milliseconds. Apollo is .NET-style, so
// a timestamp may arrive as epoch ms, epoch seconds, an ISO 8601 string, or the
// legacy `/Date(1610000000000)/` form. Defaults to 0 when unparseable.
// LIVE-CAPTURE: confirm the actual timestamp representation + zone on capture.
function toEpochMs(v) {
	if (typeof v === "number" && Number.isFinite(v)) {
		// Heuristic: values below ~1e11 are almost certainly epoch SECONDS
		// (1e11 ms ≈ year 5138; 1e11 s is far future), so scale seconds → ms.
		return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
	}
	if (typeof v === "string" && v) {
		const dotnet = /\/Date\((-?\d+)/.exec(v);
		if (dotnet) return parseInt(dotnet[1], 10);
		const t = Date.parse(v);
		return Number.isFinite(t) ? t : 0;
	}
	return 0;
}

// Convert an Apollo speed value to m/s using the company UnitCode (default mph).
function speedToMps(value, unitCode) {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return unitCode === APOLLO_UNITS.KM_LITERS ? value * KMH_TO_MPS : value * MPH_TO_MPS;
}

// TimeZone enum (or a raw numeric offset) → UTC offset hours. Best-effort.
function tzOffsetHours(tz) {
	if (typeof tz === "number" && APOLLO_TZ_OFFSET_HOURS[tz] !== undefined) return APOLLO_TZ_OFFSET_HOURS[tz];
	return 0;
}

// TRACTOR filter for the asset list. Reads Type defensively; a missing/other
// type is dropped (we only want ELD-carrying tractors), matching the spec.
function isTractor(a) {
	const t = firstDefined((a || {}).Type, (a || {}).AssetType); // LIVE-CAPTURE: verify asset-type field name
	return Number(t) === APOLLO_ASSET_TYPE.TRACTOR;
}

function describeCode(code) {
	return APOLLO_CODE_NAME[code] ? `${APOLLO_CODE_NAME[code]} (code ${code})` : `code ${code}`;
}

// --- HTTP layer ---

// Internal: HTTP wrapper with HOSClientApiKey auth, retry, timeout, JSON parse.
// Auth placement depends on method: GET → query param, POST → body field.
// Returns the parsed response body (envelope OR bare array). Throws on non-2xx
// after retries. Application-level `{code:!=1}` errors are surfaced later by
// unwrapEnvelope(), not here (Apollo returns those with HTTP 200).
async function request({ apiKey, baseUrl }, method, path, { query, body } = {}) {
	if (!apiKey) {
		const err = new Error("Apollo ELD API key not configured");
		err.code = "APOLLO_NO_KEY";
		throw err;
	}
	const isGet = method === "GET";
	// Inject the key: query for GET, body for POST. Never logged (see below).
	const q = isGet ? { ...(query || {}), HOSClientApiKey: apiKey } : query;
	const payload = !isGet ? { ...(body || {}), HOSClientApiKey: apiKey } : undefined;
	const url = `${baseUrl || DEFAULT_BASE_URL}${path}${buildQuery(q)}`;
	let lastErr = null;
	for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		try {
			const resp = await fetch(url, {
				method,
				headers: {
					"Accept": "application/json",
					...(payload ? { "Content-Type": "application/json" } : {}),
				},
				body: payload ? JSON.stringify(payload) : undefined,
				signal: controller.signal,
			});
			if (!resp.ok) {
				const text = await resp.text().catch(() => "");
				// Response text only (never the URL) so the key in the query
				// string can't leak into logs/messages.
				const err = new Error(`Apollo ${resp.status}: ${text.slice(0, 200)}`);
				err.status = resp.status;
				// Don't retry 4xx (auth/validation) — fail fast.
				if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw err;
				lastErr = err;
				// Exponential backoff for 5xx and 429.
				await sleep(500 * Math.pow(2, attempt));
				continue;
			}
			const text = await resp.text();
			if (!text) return null;
			try { return JSON.parse(text); }
			catch { return text; }
		} catch (err) {
			lastErr = err;
			if (err.code === "APOLLO_NO_KEY") throw err;
			if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
			await sleep(500 * Math.pow(2, attempt));
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr || new Error("Apollo request failed");
}

// Unwrap the Apollo response envelope. Handles BOTH shapes:
//   • bare array (GetDashboards, and defensively any other array body) → returned as-is
//   • `{ code, data }` → code===1 returns `data`; anything else throws an error
//     carrying the code name (this is how an invalid key / code:7 surfaces).
// A null/empty body returns null; an unexpected object is returned as-is for the
// normalizer's optional-chaining to handle.
function unwrapEnvelope(raw) {
	if (Array.isArray(raw)) return raw;
	if (raw && typeof raw === "object" && "code" in raw) {
		if (raw.code !== APOLLO_CODE.OK) {
			const err = new Error(`Apollo error: ${describeCode(raw.code)}`);
			err.apolloCode = raw.code;
			err.code = raw.code === APOLLO_CODE.HOSCLIENT_API_KEY_INVALID ? "APOLLO_KEY_INVALID" : "APOLLO_ERROR";
			throw err;
		}
		return raw.data;
	}
	return raw;
}

// --- Normalized accessors (identical names + return shapes to routemate.js) ---

// Smoke test / key validation. Per the confirmed docs, the lightest client-
// scoped GET that validates the key is GetHOSAssetForClient (returns {code:1|7}).
// (POST /HOSClient/GetHOSClient {HOSClientApiKey} also works and returns the
// lighter BasicHOSClientDTO2, but GET /HOSClient/GetHOSClient is 405.) The return
// value is not consumed by server.js — this exists to throw cleanly on code:7.
async function getCompany(creds) {
	const raw = await request(creds, "GET", PATH_GET_ASSETS);
	return unwrapEnvelope(raw);
}

// GetDashboards → all live vehicle/driver status rows. BARE ARRAY response.
// Returns an array of normalized telemetry objects.
async function listLiveLocations(creds) {
	// TODO(driver-pay speed signal): whether GetDashboards rows carry `speed` is
	// UNVERIFIED (no valid key). getEldTravelDaysByVehicle pays a travel day only
	// when a clean ping has speed > 2.235 m/s. If live rows lack speed, synthesize
	// the motion signal from HOSEvents (DrivenMiles>0 / duty "Driving") or
	// successive-position deltas — do NOT invent a value here. normalizeTelemetry
	// defaults speed to 0 when absent (see below).
	const raw = await request(creds, "GET", PATH_GET_DASHBOARDS);
	const rows = unwrapEnvelope(raw);
	return safeArray(rows).map(normalizeTelemetry);
}

// Apollo has no documented single-vehicle live endpoint, so resolve one vehicle
// by filtering the dashboard feed. Returns one telemetry object or null.
async function getVehicleLocation(creds, eldVehicleId) {
	const rows = await listLiveLocations(creds);
	const idStr = String(eldVehicleId);
	return rows.find((t) => String(t.eld_vehicle_id) === idStr) || null;
}

// GetHOSAssetForClient → company assets. Keep tractors (Type===0). Apollo is NOT
// paginated (whole fleet in one call); we honor the Routemate paging contract by
// returning the full set on page 0 and an empty page for page>0, so the caller's
// "break when empty" pagination loop terminates.
async function listVehicles(creds, paging = {}) {
	if (Number(paging.page) > 0) return [];
	const raw = await request(creds, "GET", PATH_GET_ASSETS);
	const data = unwrapEnvelope(raw);
	return safeArray(data).filter(isTractor).map(normalizeVehicle);
}

// GetECMConnections → ECM connection status for the client. This is NOT a classic
// DTC fault-code feed: Apollo's fault-code richness is thinner than Routemate's.
// We only emit `{code,status}` rows if the payload actually carries a per-code
// list; otherwise we return [] rather than inventing codes. Never throws on an
// unknown/empty shape (fleet-health must not break).
async function listFaultCodes(creds, eldVehicleId, paging = {}) {
	let data;
	try {
		const raw = await request(creds, "GET", PATH_GET_ECM, { query: paging });
		data = unwrapEnvelope(raw);
	} catch (err) {
		if (err.code === "APOLLO_NO_KEY") throw err;
		// ECM endpoint shape unconfirmed — degrade to "no codes", not a crash.
		return [];
	}
	const out = [];
	for (const conn of safeArray(data)) {
		const c = conn || {};
		// Optionally scope to one asset when an id is supplied.
		if (eldVehicleId !== undefined && eldVehicleId !== null && eldVehicleId !== ""
			&& c.AssetId !== undefined && String(c.AssetId) !== String(eldVehicleId)) continue; // LIVE-CAPTURE: verify AssetId field
		// Only map an explicit per-code list — a bare connection record is not a
		// fault code, so we do NOT synthesize one from connection status.
		const codes = safeArray(firstDefined(c.FaultCodes, c.Dtcs, c.Codes)); // LIVE-CAPTURE: confirm ECM carries a code list at all
		for (const code of codes) out.push(normalizeFaultCode(code));
	}
	return out;
}

// GetDVIRReports (POST) → DVIR inspection reports. Optionally scoped to one asset.
async function listDvirs(creds, eldVehicleId, paging = {}) {
	const body = { ...paging };
	if (eldVehicleId !== undefined && eldVehicleId !== null && eldVehicleId !== "") {
		body.AssetId = eldVehicleId; // LIVE-CAPTURE: confirm the DVIR asset-filter field name
	}
	const raw = await request(creds, "POST", PATH_GET_DVIR, { body });
	const data = unwrapEnvelope(raw);
	return safeArray(data).map(normalizeDvir);
}

// GetIFTAReport (POST) → IFTAReportDTO. NOTE: Apollo's IFTA is CLIENT-WIDE, not
// per-vehicle (items[] are per-STATE: {State, TotalMiles}; plus top-level
// TotalMiles/MPG/TaxPaidGallons). So a per-vehicle distance is generally NOT
// available; we return `eld_vehicle_id: ""` with the report's total distance
// unless a live payload turns out to be per-asset. Never throws on unknown shape.
async function listIftaMileage(creds, paging = {}) {
	let data;
	try {
		const raw = await request(creds, "POST", PATH_GET_IFTA, { body: { ...paging } }); // LIVE-CAPTURE: confirm date/quarter params
		data = unwrapEnvelope(raw);
	} catch (err) {
		if (err.code === "APOLLO_NO_KEY") throw err;
		return [];
	}
	// A single IFTAReportDTO or (defensively) a list of per-asset reports.
	const reports = Array.isArray(data) ? data : (data ? [data] : []);
	return reports.map(normalizeIfta).filter((r) => r.eld_vehicle_id !== "" || r.distance > 0);
}

// GetHOSDrivers → the company's drivers. Not paginated (page>0 → empty).
async function listDrivers(creds, paging = {}) {
	if (Number(paging.page) > 0) return [];
	const raw = await request(creds, "GET", PATH_GET_DRIVERS);
	const data = unwrapEnvelope(raw);
	return safeArray(data).map(normalizeDriver);
}

// HOS clocks. Two modes:
//   • per-driver — when paging.HOSDriverId is set, POST GetRecap for that one
//     driver's FMCSA clocks (the only Apollo endpoint that carries them) and
//     return a single mapped row.
//   • bulk — no id: list drivers and return one row each with NULL clocks.
//     GetRecap is per-driver-only, so a bulk clock pull would be an N+1; the
//     neutral contract allows absent clocks (null), and server.js caches this.
// Returns { total, rows }. Never throws on an unknown recap shape — clocks fall
// back to null. Bulk page>0 returns an empty page so the caller's loop ends.
async function listHosClocks(creds, paging = {}) {
	const driverId = firstDefined(paging.HOSDriverId, paging.hosDriverId, paging.eld_driver_id);
	if (driverId !== undefined && driverId !== null && driverId !== "") {
		let recap = null;
		try {
			const raw = await request(creds, "POST", PATH_GET_RECAP, {
				// LIVE-CAPTURE: confirm GetRecap body — HOSRuleSetId source is unknown
				// (may come from the driver record); an absent/invalid one → null clocks.
				body: { HOSDriverId: driverId, HOSRuleSetId: firstDefined(paging.HOSRuleSetId, paging.hosRuleSetId) },
			});
			recap = unwrapEnvelope(raw);
		} catch (err) {
			if (err.code === "APOLLO_NO_KEY") throw err;
			recap = null;
		}
		return { total: 1, rows: [normalizeHos({ ...(recap || {}), HOSDriverId: driverId })] };
	}
	if (Number(paging.page) > 0) return { total: 0, rows: [] };
	const drivers = await listDrivers(creds);
	const rows = drivers.map((d) => ({
		eld_driver_id: d.eld_driver_id,
		driver_name: d.driver_name,
		vehicle_id: "", // LIVE-CAPTURE: GetHOSDrivers has no active-vehicle link — fill from GetRecap/dashboard
		duty_status: d.duty_status || "",
		// Clocks require a per-driver GetRecap call — absent in the bulk list.
		break_ms: null,
		drive_ms: null,
		shift_ms: null,
		cycle_ms: null,
		cycle_tomorrow_ms: null,
	}));
	return { total: rows.length, rows };
}

// --- Normalizers (the ONLY things that should change once a live key lets us
//     see real response bodies) ---

// GetDashboards row → neutral telemetry. Speed is converted to m/s (see
// speedToMps); when absent it is 0 (never invented — see the driver-pay TODO in
// listLiveLocations). Every field here is inferred from the dashboard DTO docs.
function normalizeTelemetry(row) {
	const r = row || {};
	const speedRaw = firstNum(r.Speed, r.CurrentSpeed, r.GpsSpeed); // LIVE-CAPTURE: verify speed field name + presence
	const unitCode = firstNum(r.UnitCode, r.Units); // LIVE-CAPTURE: verify unit field (defaults to mph when absent)
	return {
		eld_vehicle_id: firstDefined(r.AssetId, r.VehicleId, ""),            // LIVE-CAPTURE: verify field name
		vehicle_id: firstDefined(r.Number, r.AssetNumber, r.VehicleName, ""), // LIVE-CAPTURE: verify field name
		latitude: firstNum(r.Latitude, r.Lat),                              // LIVE-CAPTURE: verify field name
		longitude: firstNum(r.Longitude, r.Lng, r.Lon),                     // LIVE-CAPTURE: verify field name
		speed: speedToMps(speedRaw == null ? undefined : speedRaw, unitCode),
		bearing: firstDefined(r.Heading, r.Bearing, r.Direction, ""),       // LIVE-CAPTURE: verify field name
		odometer: firstNum(r.Odometer, r.EcmOdometer, r.Miles) || 0,        // LIVE-CAPTURE: verify field name
		engine_hours: firstNum(r.EngineHours, r.ElapsedEngineHours) || 0,   // LIVE-CAPTURE: verify field name
		fuel_pct: firstNum(r.FuelLevel, r.FuelPercent, r.Fuel),             // LIVE-CAPTURE: verify field name
		geocoded_location: firstDefined(r.Location, r.LocationDescription, r.Address, ""), // LIVE-CAPTURE: verify field name
		location_date_ms: toEpochMs(firstDefined(r.LocationDate, r.GpsTime, r.LastUpdate)), // LIVE-CAPTURE: verify field name + unit
		time_zone_offset: tzOffsetHours(firstDefined(r.TimeZone, r.TimeZoneId)), // LIVE-CAPTURE: verify field name (enum → offset)
	};
}

// HOSAssetDTO → neutral vehicle. AssetId/Number/VIN/Plate/RegistrationState/
// Type/ECMId are documented; make/model/year/fuel_type/gps_ids/active are NOT in
// the documented DTO and default empty/true until captured live.
function normalizeVehicle(asset) {
	const r = asset || {};
	return {
		eld_vehicle_id: firstDefined(r.AssetId, r.Id, ""),   // AssetId (documented)
		vehicle_id: firstDefined(r.Number, r.AssetNumber, ""), // Number = unit number (documented)
		vin: firstDefined(r.VIN, r.Vin, ""),                 // VIN (documented)
		make: firstDefined(r.Make, ""),                      // LIVE-CAPTURE: not in HOSAssetDTO (may be in Description)
		model: firstDefined(r.Model, ""),                    // LIVE-CAPTURE: not in HOSAssetDTO
		year: firstNum(r.Year) || 0,                         // LIVE-CAPTURE: not in HOSAssetDTO
		fuel_type: firstDefined(r.FuelType, ""),             // LIVE-CAPTURE: not in HOSAssetDTO
		license_num: firstDefined(r.Plate, r.LicensePlate, ""), // Plate (documented)
		eld_id: firstDefined(r.ECMId, r.EcmId, ""),          // ECMId = onboard ELD/ECM device // LIVE-CAPTURE: confirm ECMId is the ELD id
		gps_ids: Array.isArray(r.GpsIds) ? r.GpsIds : [],    // LIVE-CAPTURE: not in HOSAssetDTO
		state: firstDefined(r.RegistrationState, ""),        // RegistrationState (documented)
		active: r.IsActive !== false && r.Active !== false,  // LIVE-CAPTURE: HOSAssetDTO has no active flag — default true
		raw: r,
	};
}

// BasicHOSDriverDTO → neutral driver. HOSDriverId/Name/LastName/IsActive/
// LicenseState/LicenseNumber are documented; email/phone/duty_status/last_sync
// are not, and default empty until captured live.
function normalizeDriver(driver) {
	const r = driver || {};
	const first = firstDefined(r.Name, r.FirstName, "");
	const last = firstDefined(r.LastName, "");
	const fullName = [first, last].map((s) => String(s || "").trim()).filter(Boolean).join(" ");
	return {
		eld_driver_id: firstDefined(r.HOSDriverId, r.DriverId, r.Id, ""), // HOSDriverId (documented)
		driver_name: fullName || firstDefined(r.HOSUserName, ""),          // LIVE-CAPTURE: verify Name/LastName split
		email: firstDefined(r.Email, r.EmailAddress, ""),                  // LIVE-CAPTURE: not in BasicHOSDriverDTO
		phone: firstDefined(r.Phone, r.PhoneNumber, ""),                   // LIVE-CAPTURE: not in BasicHOSDriverDTO
		duty_status: firstDefined(r.DutyStatus, r.CurrentDutyStatus, ""),  // LIVE-CAPTURE: verify field name
		last_sync: firstDefined(r.LastSync, r.LastActivity, ""),           // LIVE-CAPTURE: verify field name
		status: r.IsActive === false ? "inactive" : (r.IsActive === true ? "active" : firstDefined(r.Status, "")), // IsActive → status
	};
}

// DVIR report → neutral DVIR. All field names inferred from the DTO docs.
function normalizeDvir(d) {
	const r = d || {};
	return {
		dvir_id: firstDefined(r.DVIRReportId, r.DvirId, r.Id, ""),          // LIVE-CAPTURE: verify field name
		date_ms: toEpochMs(firstDefined(r.InspectionDate, r.Date, r.CreatedDate)), // LIVE-CAPTURE: verify field name + unit
		driver_name: firstDefined(r.DriverName, r.Driver, ""),             // LIVE-CAPTURE: verify field name
		report_type: firstDefined(r.ReportType, r.InspectionType, ""),     // LIVE-CAPTURE: verify field name
		status: firstDefined(r.Status, r.Condition, ""),                   // LIVE-CAPTURE: verify field name
		unresolved_defects: safeArray(firstDefined(r.UnresolvedDefects, r.Defects)), // LIVE-CAPTURE: verify field name
		corrected_defects: safeArray(r.CorrectedDefects),                  // LIVE-CAPTURE: verify field name
	};
}

// IFTAReportDTO → neutral { eld_vehicle_id, distance }. IFTA is client-wide, so
// eld_vehicle_id is typically "" and distance is the report's total miles (or the
// sum of per-state IFTAStateDTO.TotalMiles when no top-level total is present).
function normalizeIfta(report) {
	const r = report || {};
	let distance = firstNum(r.TotalMiles, r.Distance, r.Miles); // LIVE-CAPTURE: verify field name
	if (distance == null) {
		const states = safeArray(firstDefined(r.Items, r.States)); // IFTAStateDTO[] // LIVE-CAPTURE: verify field name
		distance = states.reduce((sum, s) => sum + (firstNum((s || {}).TotalMiles, (s || {}).Miles) || 0), 0);
	}
	return {
		eld_vehicle_id: firstDefined(r.AssetId, r.VehicleId, ""), // LIVE-CAPTURE: usually absent (client-wide report)
		distance: distance || 0,
	};
}

// One ECM/DTC code entry → neutral { code, status }. Only reached when the ECM
// payload actually carries a per-code list (see listFaultCodes).
function normalizeFaultCode(code) {
	const c = code || {};
	return {
		code: String(firstDefined(c.Code, c.Spn, c.FaultCode, "") || ""),   // LIVE-CAPTURE: verify field name
		status: String(firstDefined(c.Status, c.State, c.Active, "") || ""), // LIVE-CAPTURE: verify field name
	};
}

// GetRecap row → neutral HOS clock. Clock fields are milliseconds-remaining or
// null when absent; Apollo's unit is UNCONFIRMED (may be minutes/seconds) — fix
// the conversion here on live capture and every downstream *_ms consumer follows.
function normalizeHos(d) {
	const r = d || {};
	return {
		eld_driver_id: firstDefined(r.HOSDriverId, r.DriverId, r.Id, ""),  // LIVE-CAPTURE: verify field name
		driver_name: firstDefined(r.DriverName, r.Name, ""),               // LIVE-CAPTURE: verify field name
		vehicle_id: firstDefined(r.AssetNumber, r.VehicleId, r.Number, ""), // LIVE-CAPTURE: verify field name
		duty_status: firstDefined(r.DutyStatus, r.CurrentDutyStatus, ""),  // LIVE-CAPTURE: verify field name
		break_ms: clockMs(firstDefined(r.BreakRemainingMs, r.BreakTime)),  // LIVE-CAPTURE: verify field name + unit
		drive_ms: clockMs(firstDefined(r.DriveRemainingMs, r.DriveTime)),  // LIVE-CAPTURE: verify field name + unit
		shift_ms: clockMs(firstDefined(r.ShiftRemainingMs, r.ShiftTime)),  // LIVE-CAPTURE: verify field name + unit
		cycle_ms: clockMs(firstDefined(r.CycleRemainingMs, r.CycleTime)),  // LIVE-CAPTURE: verify field name + unit
		cycle_tomorrow_ms: clockMs(firstDefined(r.CycleTomorrowMs, r.CycleTomorrowTime)), // LIVE-CAPTURE: verify field name + unit
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
	listHosClocks,
	// Exposed for unit tests (envelope handling, enums) — not part of the
	// provider interface the selector dispatches.
	_internals: {
		unwrapEnvelope,
		normalizeTelemetry,
		normalizeVehicle,
		normalizeDriver,
		normalizeDvir,
		normalizeIfta,
		normalizeFaultCode,
		normalizeHos,
		toEpochMs,
		speedToMps,
		buildQuery,
		APOLLO_CODE,
		APOLLO_ASSET_TYPE,
		APOLLO_UNITS,
		APOLLO_TIMEZONE,
		MPH_TO_MPS,
	},
};
