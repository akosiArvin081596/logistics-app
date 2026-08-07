// Diesel truck-stop (POI) helpers — pure, no Vue, no network.
//
// Single source of truth for "what does this stop cost and which one is the
// cheapest", shared by the three surfaces that render the SAME
// `GET /api/poi/fuel-stops` payload:
//
//   • components/dashboard/FuelFinderPanel.vue  — dispatcher sidebar list
//   • components/dashboard/TrackingMap.vue      — the pins on the map
//   • components/driver/DriverFuelPanel.vue     — driver card strip
//
// They existed with three near-copies of the same price guard. Two of them
// already disagreed in a way that only shows up on a malformed payload
// (FuelFinderPanel trusted `effectivePrice` alone; DriverFuelPanel also required
// `priceSource === 'station'`), and putting a *number on the map pin* is exactly
// the change that turns a silent disagreement into two different prices for one
// station in front of a driver. So the rule lives here once.
//
// THE RULE: a stop has a price only when the server says the price came off that
// station's own pump (`priceSource === 'station'`) AND `effectivePrice` is a
// finite positive number. Everything else — including `dieselPrice` present but
// unsourced — is "price n/a". There is deliberately no regional-average
// fallback anywhere in the stack; a coarse estimate would sort and render as if
// it were a real quote, which is the one failure mode that sends a driver to the
// wrong pump.

/** The live pump price for a stop, or null. Never 0 — see the guard notes. */
export function stopPrice(s) {
  // priceSource is the server's assertion that this number came off this
  // station. Number(null) is 0, so null/undefined must be rejected explicitly
  // or a no-price station renders a confident "$0.00".
  if (!s || s.priceSource !== 'station') return null;
  const v = s.effectivePrice;
  if (v == null) return null;
  const p = Number(v);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/** "4.95" (no dollar sign — callers own the currency glyph), or null. */
export function priceText(s) {
  const p = stopPrice(s);
  return p == null ? null : p.toFixed(2);
}

/** True when this stop carries a real per-station pump price. */
export function hasPrice(s) {
  return stopPrice(s) !== null;
}

/**
 * Index of the cheapest stop, or -1 when nothing on the route is priced.
 *
 * Computed from the actual minimum rather than "the first stop with a price".
 * The backend already returns the list ranked cheapest-first, so in practice the
 * two agree — but the map, the sidebar and the driver strip all badge a winner,
 * and if the ordering ever regressed, "first priced" would put the badge on a
 * different station in each surface depending on how each one iterates. Min with
 * a first-index tie-break is order-independent, so all three land on the same
 * station by construction.
 */
export function cheapestIndex(stops) {
  if (!Array.isArray(stops)) return -1;
  let best = -1;
  let bestPrice = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const p = stopPrice(stops[i]);
    if (p == null) continue;
    if (p < bestPrice) {
      bestPrice = p;
      best = i;
    }
  }
  return best;
}

/** How many cents dearer than the cheapest stop, or null. 0 for a tie. */
export function centsAbove(s, cheapestPrice) {
  const p = stopPrice(s);
  if (p == null || !Number.isFinite(cheapestPrice)) return null;
  return Math.round((p - cheapestPrice) * 100);
}

/**
 * Truck lane vs auto lane. A driver pulling a 53' cannot use the car island, so
 * a price quoted from it is information about a pump they can't reach.
 */
export function dieselLane(s) {
  if (!hasPrice(s)) return '';
  const t = String((s && s.dieselType) || '').toUpperCase();
  if (t === 'TRUCK_DIESEL') return 'truck lane';
  if (t === 'DIESEL') return 'auto lane';
  return '';
}

// ---------------------------------------------------------------------------
// Map InfoWindow
// ---------------------------------------------------------------------------

/**
 * Escape untrusted Places text (name / address / brand) before it goes into an
 * InfoWindow's innerHTML. Google Maps InfoWindows take a raw HTML string, so
 * this sits next to the only thing that builds one.
 */
export function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]),
  );
}

/**
 * Popup for a plotted stop. Carries everything the sidebar row carries, plus
 * the gap to the cheapest — the number that actually decides whether a detour
 * is worth it, and the one thing a bare price on a pin can't say.
 *
 * Lives here rather than in TrackingMap.vue because it is pure string-building
 * over the same payload the price helpers above read, and because it has to
 * agree with them exactly: the pin, the sidebar row and this popup are three
 * renderings of one station.
 */
export function fuelStopPopupHtml(s, cheapestPrice) {
  let html = '<div style="font-family:DM Sans,sans-serif;font-size:0.85rem;max-width:230px">';
  html += `<strong>${escHtml((s && (s.name || s.brand)) || 'Truck stop')}</strong>`;
  if (s && s.brand && s.name && !String(s.name).toLowerCase().includes(String(s.brand).toLowerCase())) {
    html += `<div style="color:#0f766e;font-size:0.72rem;font-weight:600">${escHtml(s.brand)}</div>`;
  }
  if (s && s.address) html += `<div style="color:#555;font-size:0.78rem;margin-top:2px">${escHtml(s.address)}</div>`;

  // Live per-station pump price only — no regional-average fallback (a coarse
  // regional number would look misleadingly like the cheapest stop).
  const p = priceText(s);
  html += '<div style="margin-top:5px;display:flex;align-items:baseline;gap:4px">';
  if (p != null) {
    html += `<span style="font-size:1.05rem;font-weight:800;color:#0f766e;font-variant-numeric:tabular-nums">$${p}</span>`;
    html += '<span style="font-size:0.68rem;color:#94a3b8;font-weight:600">/gal</span>';
    html += '<span style="font-size:0.55rem;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;padding:0 0.24rem;border-radius:3px;background:#dcfce7;color:#166534;border:1px solid #bbf7d0">live</span>';
  } else {
    // Same words as the list. Two vocabularies for one condition is how a
    // driver ends up thinking they mean different things.
    html += '<span style="font-size:0.8rem;font-style:italic;color:#b0b8c4;font-weight:600">price n/a</span>';
  }
  html += '</div>';

  const delta = centsAbove(s, cheapestPrice);
  if (delta === 0) {
    html += '<div style="font-size:0.72rem;font-weight:700;color:#166534;margin-top:2px">Cheapest on this route</div>';
  } else if (delta != null && delta > 0) {
    html += `<div style="font-size:0.72rem;color:#b45309;margin-top:2px">+${delta}&cent;/gal vs the cheapest stop</div>`;
  }

  const bits = [];
  const lane = dieselLane(s);
  if (lane) bits.push(lane);
  const off = Number(s && s.aboutMilesFromRoute);
  if (Number.isFinite(off)) bits.push(`~${Math.round(off * 10) / 10} mi off route`);
  if (bits.length) html += `<div style="color:#555;font-size:0.75rem;margin-top:3px">${escHtml(bits.join(' · '))}</div>`;
  html += '</div>';
  return html;
}

// ---------------------------------------------------------------------------
// Map-label decluttering
// ---------------------------------------------------------------------------

// Rendered footprint of each pin variant, in CSS pixels, kept beside the pin
// factory's own sizing (composables/useGoogleMaps.js → createFuelPricePin).
//
// Constants rather than a measured `offsetWidth`: the allocator runs on every
// zoom change, and reading layout for a dozen markers mid-zoom would thrash.
// These are the *measured* footprints (cheapest 70x46, priced 67x29 rising to
// 76 at a four-digit price like $10.49, unpriced 45x25) rounded up with a few
// px of slack. Worth keeping honest — an over-generous box silently thins a
// neighbour that would in fact have fitted, and the first draft's 104px
// "cheapest" box was blanking a label either side of the winner for no reason.
export const LABEL_SIZE = {
  cheapest: { w: 80, h: 48 }, // ribbon + pill + tail
  priced: { w: 76, h: 30 },
  unpriced: { w: 46, h: 26 },
};

const TILE = 256;

/** Web Mercator world coordinates (Google's own projection, zoom 0). */
function worldXY(lat, lng) {
  const sin = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: TILE * (0.5 + lng / 360),
    y: TILE * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
  };
}

/**
 * Decide which stops may show a price label at the current zoom.
 *
 * WHY THIS EXISTS: price labels are ~5x wider than the old pump dot, and a
 * zoomed-out lane routinely puts eight stops inside a few hundred pixels. Left
 * alone they overlap into an unreadable pile — which is strictly worse than the
 * five identical dots this change set out to fix. So labels are a scarce
 * resource handed out by priority.
 *
 * Priority: the cheapest stop first and unconditionally (it is the entire point
 * of the feature and must survive any zoom), then the remaining priced stops
 * ascending by price, then the unpriced ones. A stop that loses gets rendered as
 * the compact pump dot — i.e. the layer degrades to exactly its old appearance,
 * never to nothing.
 *
 * Overlap is computed in screen pixels from the Mercator projection, which is
 * pan-invariant: only zoom changes the answer, so callers only need to re-run
 * this on `zoom_changed`.
 *
 * Returns a boolean per input index, aligned with `stops`.
 */
export function allocateStopLabels(stops, zoom, opts = {}) {
  const list = Array.isArray(stops) ? stops : [];
  const out = new Array(list.length).fill(false);
  if (!list.length) return out;

  const z = Number(zoom);
  const scale = Number.isFinite(z) ? Math.pow(2, z) : 1;
  const gap = Number.isFinite(opts.gap) ? opts.gap : 4;
  const cheapest = Number.isFinite(opts.cheapestIndex) ? opts.cheapestIndex : cheapestIndex(list);

  const entries = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const lat = Number(s && s.lat);
    const lng = Number(s && s.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const w = worldXY(lat, lng);
    const price = stopPrice(s);
    const kind = i === cheapest ? 'cheapest' : price != null ? 'priced' : 'unpriced';
    entries.push({
      i,
      kind,
      px: w.x * scale,
      py: w.y * scale,
      // Cheapest sorts first, then priced ascending, then unpriced. Index is the
      // final tie-break so the result is stable across renders.
      rank: i === cheapest ? -1 : price != null ? price : Infinity,
    });
  }

  entries.sort((a, b) => a.rank - b.rank || a.i - b.i);

  const placed = [];
  for (const e of entries) {
    const size = LABEL_SIZE[e.kind] || LABEL_SIZE.priced;
    // The pin is anchored bottom-center on its coordinate, so its box sits
    // above and centred on the point.
    const box = {
      left: e.px - size.w / 2 - gap,
      right: e.px + size.w / 2 + gap,
      top: e.py - size.h - gap,
      bottom: e.py + gap,
    };
    // The cheapest label is never surrendered — later, dearer labels yield to it
    // instead.
    const forced = e.kind === 'cheapest';
    const clash =
      !forced &&
      placed.some((p) => !(box.right < p.left || box.left > p.right || box.bottom < p.top || box.top > p.bottom));
    if (clash) continue;
    placed.push(box);
    out[e.i] = true;
  }
  return out;
}
