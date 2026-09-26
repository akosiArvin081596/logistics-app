// What a truck amount may be — the one copy of the rule behind both truck
// forms: Add Truck (components/trucks/AddTruckForm.vue) and the Edit Truck
// dialog (components/trucks/TruckTable.vue). Each refuses to save while an
// amount is not blank and not a finite number in range, and names the field.
//
// Pure: no Vue, no DOM, so it runs under plain Node. Telling a number box the
// browser cannot parse from a cleared one (input.validity.badInput) needs the
// element, so that half stays in each component; only what a VALUE may be
// lives here. Runner: scripts/test-truck-form-amounts.mjs.

// The most the server stores in a truck amount. Above it, below 0 or not a
// finite number, the save is answered 400 INVALID_AMOUNT.
export const AMOUNT_MAX = 1000000

// Every amount the forms send, in Add Truck's on-screen order (a form laid out
// differently passes amountError an `order`). The floor is always 0 and `max`
// is inclusive, and each is the server's own ceiling for that field: a 500 gal
// fuel tank and 20 MPG (TRUCK_AMOUNT_FIELDS), driver pay 0–10,000
// (DRIVER_PAY_DAILY_MAX, and `pay`: checked only when the user may edit it), and
// the admin fee a percentage (ADMIN_FEE_PCT_MAX). A ceiling changed on one side
// only fails scripts/test-truck-amount-caps-parity.mjs.
export const AMOUNT_FIELDS = Object.freeze(
  [
    { key: 'fuelTankGallons', label: 'Fuel tank', max: 500 },
    { key: 'avgMpg', label: 'Avg MPG', max: 20 },
    { key: 'purchasePrice', label: 'Purchase price' },
    { key: 'maintenanceFundMonthly', label: 'Maintenance fund' },
    { key: 'driverPayDaily', label: 'Driver pay', max: 10000, pay: true },
    { key: 'insuranceMonthly', label: 'Insurance' },
    { key: 'eldMonthly', label: 'ELD' },
    { key: 'hvutAnnual', label: 'HVUT' },
    { key: 'irpAnnual', label: 'IRP' },
    { key: 'truckPaymentMonthly', label: 'Truck payment' },
    { key: 'adminFeePct', label: 'Admin fee', max: 100 },
  ].map(({ key, label, max = AMOUNT_MAX, pay = false }) => Object.freeze({ key, label, max, pay })),
)

const FIELD_BY_KEY = new Map(AMOUNT_FIELDS.map((field) => [field.key, field]))

// Each amount's ceiling by key, for the number boxes' `max` attribute in both
// forms (`:max="AMOUNT_CAPS.fuelTankGallons"`), so the browser's range hint and
// amountError below read the same number.
export const AMOUNT_CAPS = Object.freeze(Object.fromEntries(AMOUNT_FIELDS.map((field) => [field.key, field.max])))

// null when every amount in `values` is blank or a finite number in range;
// otherwise one sentence naming the first field that is not.
//
// Blank ('' / null / undefined) stays allowed — it is how a field says "unset".
// v-model.number parseFloat()s whatever the input reports, so a huge entry
// (1e308) arrives as a number, and a non-finite one, should a browser report
// it, as Infinity — which JSON.stringify would send as null. Chrome reports ''
// for that case instead; the components' unreadableNumberError catches it.
//
//   canEditPay  whether this user may set driver pay. When not, its box is
//               disabled and never sent, so it is not checked.
//   order       field keys in the order the form shows them, so a refusal names
//               the first bad field on screen. Fields it leaves out follow in
//               AMOUNT_FIELDS order: still checked, only named later.
export function amountError(values, { canEditPay = false, order = [] } = {}) {
  for (const key of new Set([...order, ...FIELD_BY_KEY.keys()])) {
    const field = FIELD_BY_KEY.get(key)
    if (!field || (field.pay && !canEditPay)) continue
    const v = values?.[key]
    if (v === '' || v === null || v === undefined) continue
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0 || n > field.max) {
      return `${field.label} must be a number between 0 and ${field.max.toLocaleString('en-US')}.`
    }
  }
  return null
}
