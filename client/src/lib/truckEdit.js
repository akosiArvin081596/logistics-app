// The Edit Truck dialog (components/trucks/TruckTable.vue): the form it opens
// with, and the save body it sends — only the fields changed since it opened.
//
// WHY ONLY THE CHANGED FIELDS. The dialog stays open while the list reloads (a
// live update, a colleague's save). A save that resent every field would put
// back each value the dialog opened with, so a driver reassignment, an owner
// change, a date or a cost someone else saved in the meantime would be undone
// without anyone seeing it. PUT /api/trucks/:id leaves every field it does not
// receive as it is, so a body of only the changed fields keeps theirs.
//
// Pure: no Vue, no DOM, so it runs under plain Node. Runner:
// scripts/test-trucks-store.mjs.

// When the truck's fixed costs start and stop. GET /api/trucks sends
// InServiceDate / RetiredAt ('YYYY-MM-DD', or '' when unset); the snake_case
// spellings are read too, so a raw row (or an older cached payload) still works.
// Kept as bare strings, never through `new Date()`, which reads a bare date as
// UTC midnight and shows the day before in US time zones.
export function inServiceDate(truck) {
  return (truck?.InServiceDate ?? truck?.in_service_date ?? '') || ''
}
export function retiredAt(truck) {
  return (truck?.RetiredAt ?? truck?.retired_at ?? '') || ''
}

// The dialog's values for a row of GET /api/trucks: what each input shows when
// the dialog opens. Called again on the refreshed row to see what changed on the
// server while the dialog was open (changedUnderneath).
export function formFromTruck(truck) {
  const t = truck || {}
  return {
    id: t.id ?? null,
    unitNumber: t.UnitNumber ?? '',
    make: t.Make || '',
    model: t.Model || '',
    year: t.Year || '',
    vin: t.VIN || '',
    licensePlate: t.LicensePlate || '',
    status: t.Status ?? '',
    assignedDriver: t.AssignedDriver || '',
    ownerId: t.OwnerId || 0,
    notes: t.Notes || '',
    photo: t.Photo || '',
    insuranceMonthly: t.InsuranceMonthly || 0,
    eldMonthly: t.EldMonthly || 0,
    truckPaymentMonthly: t.TruckPaymentMonthly || 0,
    hvutAnnual: t.HvutAnnual || 0,
    irpAnnual: t.IrpAnnual || 0,
    adminFeePct: t.AdminFeePct ?? 50,
    // '' (not 0) when unset, so the box shows its "(default)" placeholder rather
    // than a literal 0. The same for the fuel pair below.
    driverPayDaily: t.DriverPayDaily || '',
    purchasePrice: t.PurchasePrice || 0,
    titleStatus: t.TitleStatus || 'Clean',
    maintenanceFundMonthly: t.MaintenanceFundMonthly || 0,
    fuelTankGallons: t.FuelTankGallons || '',
    avgMpg: t.AvgMpg || '',
    // '' when unset: an empty date box is what keeps the server's fallback.
    inServiceDate: inServiceDate(t),
    retiredAt: retiredAt(t),
  }
}

const blankAsZero = (v) => (v === '' ? 0 : v)
const blankAsEmpty = (v) => v || ''

// Every field the dialog can change, in its on-screen order.
//   kind   how the input holds its value, and so how "changed" is decided:
//          text    a text box, a select or a date box: compared trimmed
//                  (a date is '' or 'YYYY-MM-DD');
//          number  a number box (v-model gives a number, or '' when blank) or
//                  the owner select: compared as numbers, a blank counting as
//                  `blank`, the value the server stores for it — 0, or 50 for
//                  the admin fee — so clearing a box that already held that
//                  value changes nothing;
//          photo   a data URL: compared exactly.
//   body   the key(s) the save sends it under, as the dialog always has: both
//          spellings of the two dates, snake_case alone for the fuel pair.
//          Default: the field's own key.
//   send   what is sent for the current value (default: the value as it is).
//   pay    driver pay: changed, and sent, only for a user who may set it (a
//          Super Admin). Anyone else's save never carries it.
export const EDIT_FIELDS = Object.freeze(
  [
    { key: 'unitNumber', kind: 'text' },
    { key: 'make', kind: 'text' },
    { key: 'model', kind: 'text' },
    { key: 'year', kind: 'number', blank: 0 },
    { key: 'licensePlate', kind: 'text' },
    { key: 'vin', kind: 'text' },
    { key: 'status', kind: 'text' },
    { key: 'assignedDriver', kind: 'text' },
    { key: 'driverPayDaily', kind: 'number', blank: 0, pay: true, send: blankAsZero },
    { key: 'ownerId', kind: 'number', blank: 0 },
    { key: 'notes', kind: 'text' },
    { key: 'photo', kind: 'photo' },
    { key: 'fuelTankGallons', kind: 'number', blank: 0, body: ['fuel_tank_gallons'], send: blankAsZero },
    { key: 'avgMpg', kind: 'number', blank: 0, body: ['avg_mpg'], send: blankAsZero },
    { key: 'purchasePrice', kind: 'number', blank: 0 },
    { key: 'titleStatus', kind: 'text' },
    { key: 'maintenanceFundMonthly', kind: 'number', blank: 0 },
    { key: 'inServiceDate', kind: 'text', body: ['in_service_date', 'inServiceDate'], send: blankAsEmpty },
    { key: 'retiredAt', kind: 'text', body: ['retired_at', 'retiredAt'], send: blankAsEmpty },
    { key: 'insuranceMonthly', kind: 'number', blank: 0 },
    { key: 'eldMonthly', kind: 'number', blank: 0 },
    { key: 'hvutAnnual', kind: 'number', blank: 0 },
    { key: 'irpAnnual', kind: 'number', blank: 0 },
    { key: 'truckPaymentMonthly', kind: 'number', blank: 0 },
    { key: 'adminFeePct', kind: 'number', blank: 50 },
  ].map(({ body, ...field }) => Object.freeze({ ...field, pay: !!field.pay, body: Object.freeze(body || [field.key]) })),
)

const FIELD_BY_KEY = new Map(EDIT_FIELDS.map((field) => [field.key, field]))

function comparable(field, v) {
  if (field.kind === 'photo') return v == null ? '' : String(v)
  if (field.kind === 'number') {
    if (v == null || String(v).trim() === '') return field.blank
    const n = Number(v)
    // Not a number at all: compared as its text, so it reads as a change and
    // the dialog's amount check names it before anything is sent.
    return Number.isNaN(n) ? String(v) : n
  }
  return v == null ? '' : String(v).trim()
}

function same(field, a, b) {
  return comparable(field, a) === comparable(field, b)
}

// The keys of the fields whose value in `form` differs from `baseline` (the
// values the dialog opened with), in EDIT_FIELDS order. Driver pay only when
// `canEditPay`.
export function changedFields(baseline, form, { canEditPay = false } = {}) {
  return EDIT_FIELDS
    .filter((field) => (!field.pay || canEditPay) && !same(field, form?.[field.key], baseline?.[field.key]))
    .map((field) => field.key)
}

// The save body for `keys` (changedFields()): each field under its body key(s),
// with the value the dialog has always sent for it. Unknown keys are skipped.
export function bodyForFields(form, keys) {
  const body = {}
  for (const key of keys) {
    const field = FIELD_BY_KEY.get(key)
    if (!field) continue
    const value = field.send ? field.send(form?.[key]) : form?.[key]
    for (const bodyKey of field.body) body[bodyKey] = value
  }
  return body
}

// What Save sends: {} when nothing changed, and the dialog then closes without
// sending anything (the server answers an empty body 400 "No valid fields to
// update").
export function truckEditBody(baseline, form, options) {
  return bodyForFields(form, changedFields(baseline, form, options))
}

// The fields the server's copy of the truck (`latest`, formFromTruck() of the
// refreshed row) has moved away from what the dialog opened with (`baseline`)
// and from what is in the dialog now (`form`): someone else changed them while
// it was open. A field whose stored value already equals the dialog's is left
// out, so the person's own save coming back through a reload (one whose answer
// was lost, say) is never taken for somebody else's. Every field counts, driver
// pay included: the dialog shows them all.
export function changedUnderneath(baseline, latest, form) {
  if (!baseline || !latest) return []
  return EDIT_FIELDS
    .filter((field) => !same(field, latest[field.key], baseline[field.key]) && !same(field, latest[field.key], form?.[field.key]))
    .map((field) => field.key)
}
