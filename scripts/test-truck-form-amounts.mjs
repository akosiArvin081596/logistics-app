#!/usr/bin/env node
// Deterministic check on what the two truck forms — Add Truck
// (AddTruckForm.vue) and the Edit Truck dialog (TruckTable.vue) — let through
// to a save:
//   client/src/lib/truckAmounts.js   AMOUNT_MAX, AMOUNT_FIELDS, amountError
//   client/src/lib/imageUtils.js     dataUrlHasImageBytes (beside isDecodedImage)
//
// WHY THIS EXISTS. Emitting the save clears the Add form and closes the Edit
// dialog at once, so a refusal from the server lands after everything typed is
// gone. Both forms therefore refuse, themselves and with the field named, an
// amount that is not blank and not a finite number in range. That rule was
// copied into both components, and a copied rule drifts, so it now lives in
// one module and this pins it: each field's range and label, blank staying
// allowed, driver pay checked only when the user may edit it, and which field
// a refusal names first on each form.
//
// The photo check is here for the same reason. compressImage's raw fallback
// labels a file it cannot decode by the file's name, so a PDF renamed scan.jpg
// arrives as data:image/jpeg;base64,JVBERi… and passes isDecodedImage, which
// reads the label alone; the server then refuses it (415) after the dialog has
// closed. The forms keep a photo only when dataUrlHasImageBytes also finds the
// signature of the labelled type in its first bytes.
//
// No network, no DOM, no Vue — pure input/output, safe anywhere. The half of
// the amount rule that reads input.validity.badInput (a number box the browser
// cannot parse) needs a real element and stays in the components.
//   node scripts/test-truck-form-amounts.mjs      # exits 1 on any failure

import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(__dirname, '..', 'client', 'src', 'lib')

let pass = 0
let fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.error(`FAIL  ${label}`) }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else { fail++; console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`) }
}

const { AMOUNT_MAX, AMOUNT_FIELDS, amountError } = await import(pathToFileURL(path.join(LIB, 'truckAmounts.js')).href)
const { isDecodedImage, dataUrlHasImageBytes } = await import(pathToFileURL(path.join(LIB, 'imageUtils.js')).href)

const PAY = { canEditPay: true }
const EDIT_ORDER = { canEditPay: true, order: ['driverPayDaily'] }
const message = (label, max) => `${label} must be a number between 0 and ${max}.`

// ══ The table ═════════════════════════════════════════════════════════════════
eq('AMOUNT_MAX is 1,000,000', AMOUNT_MAX, 1000000)
eq('every amount the forms send, in Add Truck\'s on-screen order',
  AMOUNT_FIELDS.map((f) => f.key),
  ['fuelTankGallons', 'avgMpg', 'purchasePrice', 'maintenanceFundMonthly', 'driverPayDaily',
    'insuranceMonthly', 'eldMonthly', 'hvutAnnual', 'irpAnnual', 'truckPaymentMonthly', 'adminFeePct'])
eq('the label each refusal names',
  AMOUNT_FIELDS.map((f) => f.label),
  ['Fuel tank', 'Avg MPG', 'Purchase price', 'Maintenance fund', 'Driver pay',
    'Insurance', 'ELD', 'HVUT', 'IRP', 'Truck payment', 'Admin fee'])
eq('ceilings: fuel tank 500, avg MPG 20, driver pay 10,000, admin fee 100, every other amount 1,000,000',
  Object.fromEntries(AMOUNT_FIELDS.map((f) => [f.key, f.max])),
  {
    fuelTankGallons: 500, avgMpg: 20, purchasePrice: AMOUNT_MAX, maintenanceFundMonthly: AMOUNT_MAX,
    driverPayDaily: 10000, insuranceMonthly: AMOUNT_MAX, eldMonthly: AMOUNT_MAX, hvutAnnual: AMOUNT_MAX,
    irpAnnual: AMOUNT_MAX, truckPaymentMonthly: AMOUNT_MAX, adminFeePct: 100,
  })
eq('only driver pay waits on canEditPay', AMOUNT_FIELDS.filter((f) => f.pay).map((f) => f.key), ['driverPayDaily'])
ok('the shared table is frozen, rows included — one form cannot change the other\'s rule',
  Object.isFrozen(AMOUNT_FIELDS) && AMOUNT_FIELDS.every((f) => Object.isFrozen(f)))

// ══ Blank is "unset", and always allowed ══════════════════════════════════════
for (const [name, blank] of [["''", ''], ['null', null], ['undefined', undefined]]) {
  const all = Object.fromEntries(AMOUNT_FIELDS.map((f) => [f.key, blank]))
  eq(`${name} in every field (driver pay included) is allowed`, amountError(all, PAY), null)
}
eq('an empty form is allowed', amountError({}, PAY), null)
eq('the Add form\'s defaults are allowed',
  amountError({ insuranceMonthly: 0, eldMonthly: 0, truckPaymentMonthly: 0, hvutAnnual: 0, irpAnnual: 0,
    adminFeePct: 50, driverPayDaily: '', purchasePrice: 0, maintenanceFundMonthly: 0, fuelTankGallons: '', avgMpg: '' }, PAY),
  null)

// ══ Every field: its range allowed, anything else refused by name ═════════════
for (const f of AMOUNT_FIELDS) {
  const refusal = message(f.label, f.max.toLocaleString('en-US'))
  for (const v of [0, 0.5, 1, f.max / 2, f.max - 0.01, f.max]) {
    eq(`${f.label}: ${v} is allowed`, amountError({ [f.key]: v }, PAY), null)
  }
  for (const v of [Infinity, -Infinity, NaN, -1, -0.01, f.max + 0.01, 1e308]) {
    eq(`${f.label}: ${v} is refused, naming the field`, amountError({ [f.key]: v }, PAY), refusal)
  }
}

// ══ The ranges, verbatim ══════════════════════════════════════════════════════
eq('1,000,000 is allowed', amountError({ purchasePrice: 1000000 }), null)
eq('1,000,000.01 is refused', amountError({ purchasePrice: 1000000.01 }), 'Purchase price must be a number between 0 and 1,000,000.')
eq('Infinity is refused', amountError({ insuranceMonthly: Infinity }), 'Insurance must be a number between 0 and 1,000,000.')
eq('-Infinity is refused', amountError({ eldMonthly: -Infinity }), 'ELD must be a number between 0 and 1,000,000.')
eq('NaN is refused', amountError({ hvutAnnual: NaN }), 'HVUT must be a number between 0 and 1,000,000.')
eq('a negative is refused', amountError({ irpAnnual: -5 }), 'IRP must be a number between 0 and 1,000,000.')
eq('a number that arrives as text is read as a number', amountError({ truckPaymentMonthly: '1200' }), null)
eq('…and refused as one', amountError({ truckPaymentMonthly: '1e999' }), 'Truck payment must be a number between 0 and 1,000,000.')

eq('fuel tank: 500 gallons is allowed', amountError({ fuelTankGallons: 500 }), null)
eq('fuel tank: 500.01 is refused', amountError({ fuelTankGallons: 500.01 }), 'Fuel tank must be a number between 0 and 500.')
eq('fuel tank: 1,000 is refused although under 1,000,000', amountError({ fuelTankGallons: 1000 }), 'Fuel tank must be a number between 0 and 500.')
eq('avg MPG: 20 is allowed', amountError({ avgMpg: '20' }), null)
eq('avg MPG: 20.01 is refused', amountError({ avgMpg: 20.01 }), 'Avg MPG must be a number between 0 and 20.')
eq('avg MPG: 65 (a slipped decimal) is refused', amountError({ avgMpg: 65 }), 'Avg MPG must be a number between 0 and 20.')

eq('admin fee: 0 is allowed', amountError({ adminFeePct: 0 }), null)
eq('admin fee: 100 is allowed', amountError({ adminFeePct: 100 }), null)
eq('admin fee: 100.01 is refused — a percentage, not an amount', amountError({ adminFeePct: 100.01 }), 'Admin fee must be a number between 0 and 100.')
eq('admin fee: 5,000 is refused although under 1,000,000', amountError({ adminFeePct: 5000 }), 'Admin fee must be a number between 0 and 100.')

eq('driver pay, editable: 10,000 is allowed', amountError({ driverPayDaily: 10000 }, PAY), null)
eq('driver pay, editable: 10,000.01 is refused', amountError({ driverPayDaily: 10000.01 }, PAY), 'Driver pay must be a number between 0 and 10,000.')
eq('driver pay, editable: a negative is refused', amountError({ driverPayDaily: -250 }, PAY), 'Driver pay must be a number between 0 and 10,000.')
eq('driver pay, NOT editable: not checked — the box is disabled and never sent',
  amountError({ driverPayDaily: 10000.01 }, { canEditPay: false }), null)
eq('driver pay, NOT editable: not even Infinity', amountError({ driverPayDaily: Infinity }, { canEditPay: false }), null)
eq('driver pay is not checked unless canEditPay is said', amountError({ driverPayDaily: -1 }), null)
eq('driver pay, NOT editable: the next bad field is still named',
  amountError({ driverPayDaily: -1, eldMonthly: -1 }, { canEditPay: false }), 'ELD must be a number between 0 and 1,000,000.')

eq('a field that is not an amount is not checked (Year, unit number)', amountError({ year: -5, unitNumber: 'x' }, PAY), null)

// ══ Which field is named first ════════════════════════════════════════════════
const SEVERAL = { fuelTankGallons: -1, driverPayDaily: -1, adminFeePct: 101 }
eq('Add Truck: Fuel tank comes before Driver pay on screen, so it is named',
  amountError(SEVERAL, PAY), 'Fuel tank must be a number between 0 and 500.')
eq('Edit dialog: Driver pay is at the top of it, so it is named',
  amountError(SEVERAL, EDIT_ORDER), 'Driver pay must be a number between 0 and 10,000.')
eq('Edit dialog, pay not editable: falls through to Fuel tank',
  amountError(SEVERAL, { canEditPay: false, order: ['driverPayDaily'] }), 'Fuel tank must be a number between 0 and 500.')
eq('Edit dialog: after Driver pay, the rest keep the table\'s order',
  amountError({ adminFeePct: 101, maintenanceFundMonthly: -1 }, EDIT_ORDER), 'Maintenance fund must be a number between 0 and 1,000,000.')
eq('a field left out of `order` is still checked, only named later',
  amountError({ adminFeePct: 101 }, { order: ['fuelTankGallons'] }), 'Admin fee must be a number between 0 and 100.')
eq('a key in `order` that is not an amount is ignored', amountError({ nope: -1 }, { order: ['nope'] }), null)

{
  const values = { fuelTankGallons: 150, adminFeePct: 101 }
  const before = JSON.stringify(values)
  amountError(values, PAY)
  eq('the values are read, never written', JSON.stringify(values), before)
}

// ══ dataUrlHasImageBytes: the bytes behind the label ══════════════════════════
const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))))
const dataUrl = (type, buf) => `data:${type};base64,${buf.toString('base64')}`

// The first bytes of each type as its files begin on disk.
const JPEG_JFIF = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF\0', [0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xdb])
const JPEG_EXIF = bytes([0xff, 0xd8, 0xff, 0xe1, 0x2a, 0x3c], 'Exif\0\0', 'MM\0*\0\0\0\x08')
// A whole 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const WEBP = bytes('RIFF', [0x24, 0x00, 0x00, 0x00], 'WEBP', 'VP8 ', [0x18, 0x00, 0x00, 0x00, 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a])
const PDF = bytes('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\n')
const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')

ok('fixture sanity: the JPEG, PNG and WebP prefixes encode as the base64 each type is known by',
  dataUrl('image/jpeg', JPEG_JFIF).includes(',/9j/') && dataUrl('image/png', PNG).includes(',iVBORw0KGgo')
    && dataUrl('image/webp', WEBP).includes(',UklGR') && dataUrl('image/jpeg', PDF).includes(',JVBERi'))

ok('a JPEG (JFIF) passes', dataUrlHasImageBytes(dataUrl('image/jpeg', JPEG_JFIF)) === true)
ok('a JPEG straight off a phone camera (Exif) passes', dataUrlHasImageBytes(dataUrl('image/jpeg', JPEG_EXIF)) === true)
ok('the image/jpg label reads as JPEG, as isDecodedImage allows it', dataUrlHasImageBytes(dataUrl('image/jpg', JPEG_JFIF)) === true)
ok('an upper-case label passes, as isDecodedImage allows it', dataUrlHasImageBytes(dataUrl('image/JPEG', JPEG_JFIF)) === true)
ok('a PNG passes', dataUrlHasImageBytes(dataUrl('image/png', PNG)) === true)
ok('a WebP passes', dataUrlHasImageBytes(dataUrl('image/webp', WEBP)) === true)
ok('only the first bytes are read: a 2 MB photo passes on its header',
  dataUrlHasImageBytes(dataUrl('image/jpeg', Buffer.concat([JPEG_JFIF, Buffer.alloc(2_000_000, 0x5a)]))) === true)

// The case this exists for.
const RENAMED_PDF = dataUrl('image/jpeg', PDF)
ok('a PDF renamed scan.jpg still passes isDecodedImage, which reads the label alone (left as it is)', isDecodedImage(RENAMED_PDF) === true)
ok('a PDF renamed scan.jpg fails dataUrlHasImageBytes', dataUrlHasImageBytes(RENAMED_PDF) === false)
ok('PDF bytes under a png or webp label fail too',
  dataUrlHasImageBytes(dataUrl('image/png', PDF)) === false && dataUrlHasImageBytes(dataUrl('image/webp', PDF)) === false)
ok('a PDF under its own label fails', dataUrlHasImageBytes(dataUrl('application/pdf', PDF)) === false)
ok('an SVG fails', dataUrlHasImageBytes(dataUrl('image/svg+xml', SVG)) === false)
ok('SVG bytes under a png label fail', dataUrlHasImageBytes(dataUrl('image/png', SVG)) === false)

// The signature must be the LABELLED type's.
ok('PNG bytes under a jpeg label fail', dataUrlHasImageBytes(dataUrl('image/jpeg', PNG)) === false)
ok('JPEG bytes under a png label fail', dataUrlHasImageBytes(dataUrl('image/png', JPEG_JFIF)) === false)
ok('JPEG bytes under a webp label fail', dataUrlHasImageBytes(dataUrl('image/webp', JPEG_JFIF)) === false)
ok('a RIFF file that is not WebP (a WAV) fails', dataUrlHasImageBytes(dataUrl('image/webp', bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt '))) === false)
ok('FF D8 without the third FF fails — the server cannot read that JPEG\'s size',
  dataUrlHasImageBytes(dataUrl('image/jpeg', bytes([0xff, 0xd8, 0x00, 0xe0, 0x00, 0x10], 'JFIF\0'))) === false)
ok('a PNG cut off inside its 8-byte signature fails', dataUrlHasImageBytes(dataUrl('image/png', PNG.subarray(0, 6))) === false)
ok('bytes are decoded, not text matched: /9j/ is FF D8 FF and passes, /9i/ is FF D8 BF and fails',
  dataUrlHasImageBytes('data:image/jpeg;base64,/9j/') === true && dataUrlHasImageBytes('data:image/jpeg;base64,/9i/') === false)

// Empty and garbage: false, and never a throw.
for (const [name, value] of [
  ['an empty string', ''],
  ['null', null],
  ['undefined', undefined],
  ['a label with no payload', 'data:image/jpeg;base64,'],
  ['a payload that is not base64', 'data:image/jpeg;base64,@@@@****'],
  ['a payload of impossible base64 length', 'data:image/jpeg;base64,/9j/4'],
  ['a non-base64 data URL', 'data:image/jpeg,%FF%D8%FF'],
  ['base64 with no data: label', '/9j/4AAQSkZJRgABAQ'],
  ['plain text', 'not a photo'],
  ['a number', 42],
  ['an object', {}],
  ['an object that stringifies to a JPEG data URL', { toString: () => 'data:image/jpeg;base64,/9j/4AAQ' }],
]) {
  let result
  try { result = dataUrlHasImageBytes(value) } catch (err) { result = `threw: ${err.message}` }
  eq(`${name} fails, without throwing`, result, false)
}

// ══ The truck forms' photo rule: both checks ══════════════════════════════════
const keeps = (u) => isDecodedImage(u) && dataUrlHasImageBytes(u)
ok('the forms keep a JPEG, a PNG and a WebP',
  keeps(dataUrl('image/jpeg', JPEG_JFIF)) && keeps(dataUrl('image/png', PNG)) && keeps(dataUrl('image/webp', WEBP)))
ok('the forms keep neither a renamed PDF, an SVG, nor an unreadable file (\'\')',
  !keeps(RENAMED_PDF) && !keeps(dataUrl('image/svg+xml', SVG)) && !keeps(''))

console.log(`\ntruck-form-amounts: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
