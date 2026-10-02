// (lat, lng) → US state, by the real state borders. Pure: no network, no
// database, no fs beyond loading the bundled border data at require time.
//
// WHY THIS EXISTS, AND WHY IT IS NOT lib/ifta-states.js. That module checks
// overlapping bounding boxes in a fixed order and takes the first match, with
// Texas first. Texas's box (lat 25.84-36.5, lng -106.65 to -93.51) covers most
// of Oklahoma, eastern New Mexico and western Louisiana/Arkansas, so Oklahoma
// City comes back "TX". That is tolerable for a screen computed on demand,
// but eld_state_miles_daily STORES its answer, and the telemetry behind it is
// purged at 90 days. A wrong state written there can never be recomputed.
//
// THE BORDERS. us-atlas states-10m (US Census cartographic boundaries,
// 1:10,000,000, ISC), unprojected lon/lat, decoded with topojson-client.
// Neighbouring states share arcs in the topology, so there is no gap and no
// overlap between them, only along a coast or the national border.
//
// THE COAST. At this scale a coastline is simplified by up to a few km, so a
// truck on a causeway or a bay bridge (Galveston, Lake Pontchartrain, the
// Chesapeake) can sit just "offshore". A point inside no state snaps to the
// nearest border within SNAP_DEG (~25 km); beyond that it is OTHER (Mexico,
// Canada, open water). The snap also pulls a point just across the national
// border (Ciudad Juárez) onto the US side; this fleet does not run there.
// OTHER is a real answer, never a dropped one: its miles are still stored,
// under OTHER.

const topojson = require("topojson-client");
const topology = require("us-atlas/states-10m.json");

const OTHER = "OTHER";

// Census FIPS state code → USPS code. us-atlas keys every feature by FIPS.
const FIPS_TO_USPS = {
	"01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT",
	"10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL",
	"18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD",
	"25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE",
	"32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
	"39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
	"47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV",
	"55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI",
};

const SNAP_DEG = 0.25;

function ringBox(ring) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of ring) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

// One entry per polygon (a MultiPolygon state contributes several), each with
// its outer ring, its holes and the outer ring's bounding box.
const POLYGONS = [];
for (const f of topojson.feature(topology, topology.objects.states).features) {
	const code = FIPS_TO_USPS[String(f.id)];
	if (!code || !f.geometry) continue;
	const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
	for (const rings of polys) {
		if (!rings.length) continue;
		POLYGONS.push({ code, outer: rings[0], holes: rings.slice(1), box: ringBox(rings[0]) });
	}
}

function inRing(x, y, ring) {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i][0], yi = ring[i][1];
		const xj = ring[j][0], yj = ring[j][1];
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

function containing(x, y) {
	for (const p of POLYGONS) {
		const b = p.box;
		if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
		if (!inRing(x, y, p.outer)) continue;
		if (p.holes.some((h) => inRing(x, y, h))) continue;
		return p.code;
	}
	return null;
}

// Nearest border within SNAP_DEG, measured on a local flat projection
// (longitude scaled by cos(lat)), which is exact enough at 25 km.
function nearest(x, y) {
	const k = Math.cos((y * Math.PI) / 180);
	let best = null;
	let bestD2 = (SNAP_DEG * SNAP_DEG);
	for (const p of POLYGONS) {
		const b = p.box;
		if (x < b.minX - SNAP_DEG || x > b.maxX + SNAP_DEG || y < b.minY - SNAP_DEG || y > b.maxY + SNAP_DEG) continue;
		const ring = p.outer;
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const ax = ring[j][0] * k, ay = ring[j][1];
			const bx = ring[i][0] * k, by = ring[i][1];
			const px = x * k, py = y;
			const dx = bx - ax, dy = by - ay;
			const len2 = dx * dx + dy * dy;
			const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
			const ex = ax + t * dx - px, ey = ay + t * dy - py;
			const d2 = ex * ex + ey * ey;
			if (d2 < bestD2) { bestD2 = d2; best = p.code; }
		}
	}
	return best;
}

// Memo on ~110 m cells. A parked truck pings the same spot for hours, and a
// rollup re-reads the same three days four times a day. Bounded so a long
// backfill cannot grow it without limit.
const CACHE_MAX = 200000;
const cache = new Map();

/**
 * The USPS code of the state containing (lat, lng), or OTHER.
 */
function stateAt(lat, lng) {
	const y = Number(lat);
	const x = Number(lng);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return OTHER;
	const key = `${y.toFixed(3)},${x.toFixed(3)}`;
	const hit = cache.get(key);
	if (hit) return hit;
	const code = containing(x, y) || nearest(x, y) || OTHER;
	if (cache.size >= CACHE_MAX) cache.clear();
	cache.set(key, code);
	return code;
}

module.exports = { OTHER, stateAt };
