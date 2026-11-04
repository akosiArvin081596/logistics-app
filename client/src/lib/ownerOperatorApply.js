// The owner-operator branch of /apply (plan C PR 3): which steps the form shows,
// the "Your truck" step's fields and checks, and the section the server reads.
// The server judges every value (lib/public-form-input.js
// checkPublicOwnerOperatorTruck()); these checks only catch a mistake before the
// applicant submits. scripts/test-owner-operator-apply-client.mjs pins the two
// field lists equal.

export const OO_TRUCK_FIELDS = Object.freeze([
  'truck_year', 'truck_make', 'truck_model', 'truck_vin', 'truck_plate', 'truck_plate_state', 'truck_unit',
  'truck_ownership', 'registered_owner', 'business_name',
])

export const BASE_PAGES = Object.freeze(['personal', 'experience', 'history', 'certifications', 'references'])

export function emptyOwnerOperatorTruck() {
  return Object.fromEntries(OO_TRUCK_FIELDS.map((f) => [f, '']))
}

// The server's category rule: "Owner Operator", trimmed and case-folded.
export function isOwnerOperatorPosition(position) {
  return typeof position === 'string' && position.trim().toLowerCase() === 'owner operator'
}

// The "Your truck" step follows Personal Info only while the server offers it
// (GET /api/config/apply-options) and the applicant chose Owner Operator.
export function applyPages({ ownerOperatorEnabled, position } = {}) {
  if (ownerOperatorEnabled === true && isOwnerOperatorPosition(position)) return ['personal', 'truck', ...BASE_PAGES.slice(1)]
  return [...BASE_PAGES]
}

const text = (v) => (v === undefined || v === null ? '' : String(v)).trim()

// '' when the step can go on; otherwise the first thing to fix, in the step's order.
export function validateOwnerOperatorTruck(truck) {
  const t = truck || {}
  const year = text(t.truck_year)
  if (!year || !text(t.truck_make) || !text(t.truck_model) || !text(t.truck_vin) || !text(t.truck_plate) ||
    !text(t.truck_plate_state) || !text(t.truck_ownership) || !text(t.registered_owner)) {
    return 'Please fill in every required truck detail.'
  }
  if (!/^\d{4}$/.test(year) || Number(year) < 1950 || Number(year) > 2100) return 'Enter the truck year as four digits.'
  if (!/^[A-Za-z0-9]{1,17}$/.test(text(t.truck_vin))) return 'Enter the VIN as it is printed: letters and digits, at most 17.'
  if (!/^[A-Za-z0-9 -]{1,12}$/.test(text(t.truck_plate))) return 'Enter the license plate as it is printed.'
  if (!/^[A-Za-z]{2}$/.test(text(t.truck_plate_state))) return 'Enter the plate state as two letters, for example TX.'
  if (!['own', 'lease'].includes(text(t.truck_ownership))) return 'Tell us whether you own or lease the truck.'
  return ''
}

// The section POST /api/public/apply reads, with the referral code from the link.
export function ownerOperatorSection(truck, referralCode = '') {
  const t = truck || {}
  const out = Object.fromEntries(OO_TRUCK_FIELDS.map((f) => [f, text(t[f])]))
  out.referral_code = text(referralCode).slice(0, 64)
  return out
}

// The partner's apply link carries ?ref=<code>; any other page has none.
export function referralCodeFrom(search) {
  try {
    return text(new URLSearchParams(search || '').get('ref')).slice(0, 64)
  } catch {
    return ''
  }
}
