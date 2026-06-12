// Human-readable duration formatting for tracking surfaces.
//
// Mirrors the driver app's ETA convention (DriverRouteMap.vue etaFormatted):
// under an hour stays "47m", an hour or more becomes "3h 33m". Keeping the
// server returning raw minutes (etaMinutes) means other consumers are
// untouched — formatting happens at the display layer only.

// formatMinutes(213) → "3h 33m"; formatMinutes(45) → "45m"; null/NaN → null.
export function formatMinutes(min) {
  const n = Number(min)
  if (min == null || !Number.isFinite(n)) return null
  const m = Math.max(0, Math.round(n))
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// HOS countdown clocks arrive as milliseconds remaining (see
// lib/routemate-client.js listHosClocks). Negative values mean the driver is
// over the clock (in violation) — clamp to "0m" for display; the duty-status
// chip carries the violation context.
export function formatClockMs(ms) {
  const n = Number(ms)
  if (ms == null || !Number.isFinite(n)) return null
  return formatMinutes(n / 60000)
}
