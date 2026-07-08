/**
 * Expense Intelligence — categorical palette for the 7 expense types.
 *
 * ONE color per entity, everywhere: the "Fuel" donut segment, the "Fuel" map
 * pin, and the "Fuel" legend dot are all the SAME hex. Never reassign colors
 * by rank or filter state — color follows the entity.
 *
 * Derivation (dataviz skill, 2026-07-08):
 * - Hues seeded from the app's existing design language: FinancialsView
 *   category bars (fuel #f59e0b, maintenance #3b82f6, repair #ef4444,
 *   food emerald, toll violet, other gray) + shared.css tokens, then snapped
 *   to validator-passing steps.
 * - Validated with dataviz scripts/validate_palette.js against the app's
 *   white card surface (--surface: #ffffff), light mode only — the admin SPA
 *   has no dark mode (no prefers-color-scheme / .dark styles anywhere).
 *
 *   Adjacent pairs (donut segment order below):  ALL CHECKS PASS
 *     worst adjacent ΔE 32.7 (deutan, Fuel↔Repair) — target is ≥12.
 *   All pairs (`--pairs all`, required for map pins where any two colors
 *   can sit side by side):                        ALL CHECKS PASS
 *     worst pair ΔE 13.6 (protan, Other↔Wear & Tear) — above the ≥12 target.
 *     (Toll was originally the app's #8b5cf6 violet; it collapsed into
 *      Maintenance blue under deuteranopia at ΔE 3.8, so it was snapped to
 *      the darker violet step #4a3aa7 — hue held, lightness moved.)
 *   Contrast vs surface: Fuel (2.15:1) and Other (2.69:1) sit in the sub-3:1
 *   relief band — legal ONLY with visible value labels or a table view.
 *   Every consumer of this palette ships that relief: bar lists print values
 *   in text ink, the donut has a spend+% legend, the map has a legend row and
 *   per-pin info windows, and the leaderboard is a table.
 *
 * The key order below is load-bearing: it is the fixed entity order used by
 * the donut (segment adjacency was validated in exactly this order) and by
 * every legend. Do not reorder without re-running the validator.
 */

export const TYPE_COLORS = {
  Fuel: '#f59e0b', // amber — matches FinancialsView fuel bar
  Repair: '#ef4444', // red — matches app --danger / Financials repair
  Maintenance: '#3b82f6', // blue — matches Financials maintenance
  'Wear & Tear': '#0d9488', // teal — app teal family (Financials driver-pay hue)
  Toll: '#4a3aa7', // violet — Financials toll hue, darkened for deutan safety
  Food: '#008300', // green — snapped from emerald for CVD distance to teal
  Other: '#e87ba4', // magenta — catch-all; reads recessive next to the others
}

/**
 * Single sequential hue for ranked single-series bar lists (Top Vendors,
 * Spend by State) and the monthly trend line. Nominal categories (vendors,
 * states) are NOT types, so they never wear TYPE_COLORS — every bar takes
 * this one hue and bar length does the comparing. Sky-600: the app accent
 * family (#0ea5e9 buttons), stepped down to clear 3:1 on white (4.10:1).
 */
export const SEQUENTIAL_HUE = '#0284c7'

const KEYS = Object.keys(TYPE_COLORS)
const LOWER_LOOKUP = Object.fromEntries(KEYS.map((k) => [k.toLowerCase(), k]))

/**
 * Resolve an arbitrary type string (OCR/user data — any casing, padding)
 * to its canonical TYPE_COLORS key. Unknown/missing types fall back to
 * 'Other' so no mark ever renders colorless.
 */
export function resolveTypeKey(type) {
  const key = LOWER_LOOKUP[String(type ?? '').trim().toLowerCase()]
  return key || 'Other'
}

/** Hex for an expense type, with the Other fallback. */
export function typeColor(type) {
  return TYPE_COLORS[resolveTypeKey(type)]
}
