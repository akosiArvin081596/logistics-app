// "Actual miles driven" on the load-detail modal (LoadHaulSection.vue): the
// wording for GET /api/loads/:loadId/haul's `driven`, kept pure so
// scripts/test-load-detail-ratecon.mjs can pin it.
//
// ⚠️ Every reason is an ABSENCE, not a zero. The endpoint returns null miles
// with a reason precisely so nothing here prints "0 mi" for a haul nobody
// measured.

export const MILES_REASONS = Object.freeze({
  disabled: 'ELD mileage measurement is currently turned off.',
  no_coordinates: 'This load has no mapped pickup or drop-off, so the haul cannot be measured.',
  no_truck_assigned: 'No truck is assigned to this load yet.',
  load_not_on_sheet: 'This load is no longer on the Job Tracking sheet, so its truck cannot be identified.',
  no_eld_device: 'This truck has no ELD device linked, so its miles are not reported.',
  no_samples: 'No telemetry is retained for this period (the feed keeps 90 days).',
  no_pickup_zone: 'The truck was never recorded at the pickup, so the haul cannot be measured.',
  no_departure: 'The truck has not left the pickup yet.',
  no_arrival: 'The truck was never recorded arriving at the drop-off.',
})
export const NOT_AT_PICKUP_YET = "The truck hasn't reached the pickup yet."
const NO_MEASUREMENT = 'No ELD measurement is available for this load.'

export function milesDrivenUnavailable(driven) {
  return !driven || driven.basis === 'no-data' ||
    (driven.loadedMiles == null && driven.deadheadMiles == null)
}

// `loadInProgress` is the load's own status (not delivered, completed or
// cancelled). "Never recorded at the pickup" is a finding about a finished
// haul; on a load still running it only means the truck is not there yet.
export function milesDrivenReason(driven, { loadInProgress = false } = {}) {
  const reason = driven && driven.reason
  if (reason === 'no_pickup_zone' && loadInProgress) return NOT_AT_PICKUP_YET
  return MILES_REASONS[reason] || NO_MEASUREMENT
}

export function fmtMiles(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return (Math.round(Number(n) * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })
}

// "512.3 mi (480.1 loaded · 32.2 deadhead)", "so far" while the haul runs.
export function milesDrivenSummary(driven) {
  if (milesDrivenUnavailable(driven)) return ''
  const total = driven.totalMiles != null ? `${fmtMiles(driven.totalMiles)} mi` : '—'
  const parts = []
  if (driven.loadedMiles != null) parts.push(`${fmtMiles(driven.loadedMiles)} loaded`)
  if (driven.deadheadMiles != null) parts.push(`${fmtMiles(driven.deadheadMiles)} deadhead`)
  const detail = parts.length ? ` (${parts.join(' · ')})` : ''
  return `${total}${detail}${driven.inProgress ? ' so far' : ''}`
}
