// How far along a driver's load is, read from its Job Status: one copy of each rule,
// for the driver's load page, its active load and the header's fuel chip.
// Runner: scripts/test-driver-header-fuel-range.mjs §9.

// The load the truck is physically moving with comes first, not the newest row.
const STATUS_PRIORITY = [
  /^in transit$/i,
  /^at receiver$/i,
  /^unloading$/i,
  /^at shipper$/i,
  /^loading$/i,
  /^heading to shipper$/i,
  /^assigned$/i,
]

export function statusPriorityScore(status) {
  const s = (status || '').trim()
  for (let i = 0; i < STATUS_PRIORITY.length; i++) {
    if (STATUS_PRIORITY[i].test(s)) return i
  }
  return STATUS_PRIORITY.length
}

// False once the load is delivered: nothing is left to drive on it, so a fuel check
// or a stop along its route would be for a road already driven.
export function hasRoadLeft(status) {
  return !/^(delivered|completed|pod received)$/i.test((status || '').trim())
}
