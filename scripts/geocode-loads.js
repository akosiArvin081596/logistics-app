#!/usr/bin/env node
/**
 * Backfill origin/destination coordinates for rows in "Job Tracking".
 *
 * Usage: node scripts/geocode-loads.js <connect.sid cookie value>
 *        LOGISX_BASE_URL=http://localhost:3000 node scripts/geocode-loads.js <cookie>
 *
 * ⚠️ THIS SCRIPT NO LONGER WRITES TO THE SHEET, AND MUST NOT GO BACK TO DOING SO.
 *
 * It used to PUT "Origin Lat" / "Origin Lng" / "Dest Lat" / "Dest Lng" to
 * `PUT /api/load/:loadId`. Job Tracking has 26 columns and none of them are
 * coordinates, so all four were UNKNOWN keys — and that route's old new-column
 * branch turned an unknown key into a column by rewriting `Job Tracking!A1`, the
 * header row. Every column in this app is resolved by matching header text, so a
 * single run would have:
 *
 *   1. re-pointed the dashboard, driver app, /api/financials, /api/investor and
 *      the invoice batch at a rewritten header array;
 *   2. taken the sheet from 26 to 30 columns, which is where the app's
 *      `String.fromCharCode(65 + colIdx)` A1 helpers started emitting "[" and
 *      writing to garbage ranges;
 *   3. made resolveGeofencePoints() PREFER these new sheet columns over the
 *      `load_coordinates` table (it matches /origin.*lat/i and /dest.*lat/i
 *      first), silently moving geofencing onto a second, unmaintained copy of
 *      the coordinates.
 *
 * `PUT /api/load/:loadId` now refuses unknown columns outright (400
 * UNKNOWN_COLUMN), so the old script would simply fail — but the fix is not to
 * find another way to add the columns. Coordinates live in the `load_coordinates`
 * SQLite table, which is what geofencing, the tracking map and the public tracker
 * actually read.
 *
 * `GET /api/geocode/load/:loadId` is the supported way in: on a miss it reads the
 * addresses off the sheet, geocodes them with the SERVER's Maps key, caches the
 * result in `load_coordinates`, and returns it. So this script is now a loop over
 * that endpoint — it needs no Maps key of its own, and it writes nothing to the
 * spreadsheet.
 */

const BASE = process.env.LOGISX_BASE_URL || "https://logistics-app.abedubas.dev";
const COOKIE = process.argv[2];
if (!COOKIE) {
  console.error("Usage: node scripts/geocode-loads.js <connect.sid cookie value>");
  console.error("       LOGISX_BASE_URL=<url> to target staging/local instead of production.");
  process.exit(1);
}

const headers = { Cookie: `connect.sid=${COOKIE}`, "Content-Type": "application/json" };

async function fetchAllLoads() {
  const loads = [];
  let page = 1;
  const limit = 200;
  while (true) {
    const resp = await fetch(`${BASE}/api/data?sheet=Job+Tracking&page=${page}&limit=${limit}`, { headers });
    const data = await resp.json();
    if (!data.data || data.data.length === 0) break;
    loads.push(...data.data);
    if (loads.length >= data.total) break;
    page++;
  }
  return loads;
}

// Ask the server to resolve (and cache) this load's coordinates. Returns the
// coordinate payload, or null when the server could not geocode it.
async function ensureCoords(loadId) {
  const resp = await fetch(`${BASE}/api/geocode/load/${encodeURIComponent(loadId)}`, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data && data.originLat != null && data.destLat != null ? data : null;
}

async function main() {
  console.log(`Target: ${BASE}`);
  console.log("Fetching all loads...");
  const loads = await fetchAllLoads();
  console.log(`Found ${loads.length} loads`);

  // Only rows that actually carry an address are worth asking about — the
  // endpoint reads the same two columns to geocode from.
  const candidates = loads.filter((l) => {
    const loadId = l["Load ID"] || "";
    const hasPickupAddr = (l["Pickup Address"] || "").trim();
    const hasDropoffAddr = (l["Drop-off Address"] || "").trim();
    return loadId && (hasPickupAddr || hasDropoffAddr);
  });

  console.log(`${candidates.length} loads have an address to geocode\n`);

  let resolved = 0;
  let incomplete = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const loadId = candidates[i]["Load ID"];
    process.stdout.write(`[${i + 1}/${candidates.length}] Load ${loadId} ... `);
    try {
      const coords = await ensureCoords(loadId);
      if (coords) {
        console.log(`ok (${coords.originLat}, ${coords.originLng}) → (${coords.destLat}, ${coords.destLng})`);
        resolved++;
      } else {
        console.log("no coordinates resolved (address missing or not geocodable)");
        incomplete++;
      }
    } catch (err) {
      console.log(`failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone! Resolved: ${resolved}, Incomplete: ${incomplete}, Failed: ${failed}`);
  console.log("Coordinates are cached in the load_coordinates table; the sheet was not modified.");
}

main().catch(console.error);
