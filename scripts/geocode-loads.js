#!/usr/bin/env node
/**
 * Batch geocode load addresses and update Origin/Dest Lat/Lng columns.
 * Usage: node scripts/geocode-loads.js <session-cookie>
 *
 * Uses OpenStreetMap Nominatim (free, 1 req/sec limit).
 */

const BASE = "https://logistics-app.abedubas.dev";
const COOKIE = process.argv[2];
if (!COOKIE) {
  console.error("Usage: node scripts/geocode-loads.js <connect.sid cookie value>");
  process.exit(1);
}

const headers = { Cookie: `connect.sid=${COOKIE}`, "Content-Type": "application/json" };

// Cache to avoid re-geocoding the same address
const geocodeCache = new Map();

async function geocode(address) {
  if (!address || address.trim().length < 5) return null;
  const key = address.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  // Rate limit: 1 req/sec for Nominatim
  await new Promise(r => setTimeout(r, 1100));

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "LogisX-Geocoder/1.0" },
    });
    const data = await resp.json();
    if (data && data.length > 0) {
      const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      geocodeCache.set(key, result);
      return result;
    }
  } catch (err) {
    console.error(`  Geocode error for "${address}":`, err.message);
  }
  geocodeCache.set(key, null);
  return null;
}

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

async function updateLoad(loadId, updates) {
  const resp = await fetch(`${BASE}/api/load/${encodeURIComponent(loadId)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(updates),
  });
  return resp.json();
}

async function main() {
  console.log("Fetching all loads...");
  const loads = await fetchAllLoads();
  console.log(`Found ${loads.length} loads`);

  // Find loads needing geocoding
  const needsUpdate = loads.filter(l => {
    const loadId = l["Load ID"] || "";
    const hasOrigin = l["Origin Lat"] && l["Origin Lat"].trim();
    const hasDest = l["Dest Lat"] && l["Dest Lat"].trim();
    const hasPickupAddr = l["Pickup Address"] && l["Pickup Address"].trim();
    const hasDropoffAddr = l["Drop-off Address"] && l["Drop-off Address"].trim();
    return loadId && (!hasOrigin || !hasDest) && (hasPickupAddr || hasDropoffAddr);
  });

  console.log(`${needsUpdate.length} loads need geocoding\n`);

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < needsUpdate.length; i++) {
    const load = needsUpdate[i];
    const loadId = load["Load ID"];
    const pickupAddr = (load["Pickup Address"] || "").trim();
    const dropoffAddr = (load["Drop-off Address"] || "").trim();
    const hasOrigin = load["Origin Lat"] && load["Origin Lat"].trim();
    const hasDest = load["Dest Lat"] && load["Dest Lat"].trim();

    console.log(`[${i + 1}/${needsUpdate.length}] Load ${loadId}`);

    const updates = {};

    if (!hasOrigin && pickupAddr) {
      const origin = await geocode(pickupAddr);
      if (origin) {
        updates["Origin Lat"] = String(origin.lat);
        updates["Origin Lng"] = String(origin.lng);
        console.log(`  Origin: ${pickupAddr} → ${origin.lat}, ${origin.lng}`);
      } else {
        console.log(`  Origin: Could not geocode "${pickupAddr}"`);
      }
    }

    if (!hasDest && dropoffAddr) {
      const dest = await geocode(dropoffAddr);
      if (dest) {
        updates["Dest Lat"] = String(dest.lat);
        updates["Dest Lng"] = String(dest.lng);
        console.log(`  Dest: ${dropoffAddr} → ${dest.lat}, ${dest.lng}`);
      } else {
        console.log(`  Dest: Could not geocode "${dropoffAddr}"`);
      }
    }

    if (Object.keys(updates).length > 0) {
      try {
        await updateLoad(loadId, updates);
        updated++;
      } catch (err) {
        console.error(`  Update failed: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\nDone! Updated: ${updated}, Failed: ${failed}, Cache hits: ${geocodeCache.size} addresses`);
}

main().catch(console.error);
