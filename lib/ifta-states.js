// IFTA US state lookup via approximate bounding boxes.
// Used by /api/locations/* routes to attribute GPS pings to a state for
// IFTA mileage reporting. Boxes overlap at borders — this is intentional;
// the first matching state wins, ordered by likely usage.

const US_STATE_BOUNDS = [
	{ name: "TX", minLat: 25.84, maxLat: 36.5, minLng: -106.65, maxLng: -93.51 },
	{ name: "OK", minLat: 33.62, maxLat: 37.0, minLng: -103.0, maxLng: -94.43 },
	{ name: "LA", minLat: 28.93, maxLat: 33.02, minLng: -94.04, maxLng: -88.82 },
	{ name: "AR", minLat: 33.0, maxLat: 36.5, minLng: -94.62, maxLng: -89.64 },
	{ name: "NM", minLat: 31.33, maxLat: 37.0, minLng: -109.05, maxLng: -103.0 },
	{ name: "MS", minLat: 30.17, maxLat: 35.0, minLng: -91.66, maxLng: -88.1 },
	{ name: "AL", minLat: 30.22, maxLat: 35.01, minLng: -88.47, maxLng: -84.89 },
	{ name: "TN", minLat: 34.98, maxLat: 36.68, minLng: -90.31, maxLng: -81.65 },
	{ name: "GA", minLat: 30.36, maxLat: 35.0, minLng: -85.61, maxLng: -80.84 },
	{ name: "FL", minLat: 24.52, maxLat: 31.0, minLng: -87.63, maxLng: -80.03 },
	{ name: "MO", minLat: 35.99, maxLat: 40.61, minLng: -95.77, maxLng: -89.1 },
	{ name: "KS", minLat: 36.99, maxLat: 40.0, minLng: -102.05, maxLng: -94.59 },
	{ name: "CO", minLat: 36.99, maxLat: 41.0, minLng: -109.05, maxLng: -102.04 },
	{ name: "AZ", minLat: 31.33, maxLat: 37.0, minLng: -114.82, maxLng: -109.04 },
	{ name: "CA", minLat: 32.53, maxLat: 42.01, minLng: -124.41, maxLng: -114.13 },
	{ name: "NV", minLat: 35.0, maxLat: 42.0, minLng: -120.01, maxLng: -114.04 },
	{ name: "IL", minLat: 36.97, maxLat: 42.51, minLng: -91.51, maxLng: -87.02 },
	{ name: "IN", minLat: 37.77, maxLat: 41.76, minLng: -88.1, maxLng: -84.78 },
	{ name: "OH", minLat: 38.4, maxLat: 42.33, minLng: -84.82, maxLng: -80.52 },
	{ name: "PA", minLat: 39.72, maxLat: 42.27, minLng: -80.52, maxLng: -74.69 },
	{ name: "NY", minLat: 40.5, maxLat: 45.01, minLng: -79.76, maxLng: -71.86 },
	{ name: "NC", minLat: 33.84, maxLat: 36.59, minLng: -84.32, maxLng: -75.46 },
	{ name: "SC", minLat: 32.03, maxLat: 35.22, minLng: -83.35, maxLng: -78.54 },
	{ name: "VA", minLat: 36.54, maxLat: 39.47, minLng: -83.68, maxLng: -75.24 },
	{ name: "WA", minLat: 45.54, maxLat: 49.0, minLng: -124.85, maxLng: -116.92 },
	{ name: "OR", minLat: 41.99, maxLat: 46.29, minLng: -124.57, maxLng: -116.46 },
	{ name: "ID", minLat: 41.99, maxLat: 49.0, minLng: -117.24, maxLng: -111.04 },
	{ name: "MT", minLat: 44.36, maxLat: 49.0, minLng: -116.05, maxLng: -104.04 },
	{ name: "WY", minLat: 40.99, maxLat: 45.01, minLng: -111.06, maxLng: -104.05 },
	{ name: "UT", minLat: 36.99, maxLat: 42.0, minLng: -114.05, maxLng: -109.04 },
	{ name: "ND", minLat: 45.94, maxLat: 49.0, minLng: -104.05, maxLng: -96.55 },
	{ name: "SD", minLat: 42.48, maxLat: 45.95, minLng: -104.06, maxLng: -96.44 },
	{ name: "NE", minLat: 39.99, maxLat: 43.0, minLng: -104.05, maxLng: -95.31 },
	{ name: "IA", minLat: 40.37, maxLat: 43.5, minLng: -96.64, maxLng: -90.14 },
	{ name: "MN", minLat: 43.5, maxLat: 49.38, minLng: -97.24, maxLng: -89.49 },
	{ name: "WI", minLat: 42.49, maxLat: 47.08, minLng: -92.89, maxLng: -86.25 },
	{ name: "MI", minLat: 41.7, maxLat: 48.31, minLng: -90.42, maxLng: -82.12 },
	{ name: "KY", minLat: 36.5, maxLat: 39.15, minLng: -89.57, maxLng: -81.96 },
	{ name: "WV", minLat: 37.2, maxLat: 40.64, minLng: -82.64, maxLng: -77.72 },
	{ name: "MD", minLat: 37.91, maxLat: 39.72, minLng: -79.49, maxLng: -75.05 },
	{ name: "DE", minLat: 38.45, maxLat: 39.84, minLng: -75.79, maxLng: -75.05 },
	{ name: "NJ", minLat: 38.93, maxLat: 41.36, minLng: -75.56, maxLng: -73.89 },
	{ name: "CT", minLat: 40.98, maxLat: 42.05, minLng: -73.73, maxLng: -71.79 },
	{ name: "RI", minLat: 41.15, maxLat: 42.02, minLng: -71.86, maxLng: -71.12 },
	{ name: "MA", minLat: 41.24, maxLat: 42.89, minLng: -73.51, maxLng: -69.93 },
	{ name: "VT", minLat: 42.73, maxLat: 45.02, minLng: -73.44, maxLng: -71.47 },
	{ name: "NH", minLat: 42.7, maxLat: 45.31, minLng: -72.56, maxLng: -70.7 },
	{ name: "ME", minLat: 43.06, maxLat: 47.46, minLng: -71.08, maxLng: -66.95 },
	{ name: "HI", minLat: 18.91, maxLat: 22.24, minLng: -160.25, maxLng: -154.81 },
	{ name: "AK", minLat: 51.21, maxLat: 71.39, minLng: -179.15, maxLng: -129.98 },
	{ name: "DC", minLat: 38.79, maxLat: 38.99, minLng: -77.12, maxLng: -76.91 },
];

function getStateFromCoords(lat, lng) {
	for (const s of US_STATE_BOUNDS) {
		if (lat >= s.minLat && lat <= s.maxLat && lng >= s.minLng && lng <= s.maxLng) {
			return s.name;
		}
	}
	return "Other";
}

module.exports = { US_STATE_BOUNDS, getStateFromCoords };
