<template>
  <div ref="formEl" class="card" @change.capture="keepUnreadableNumber">
    <div class="admin-section-title">
      <div class="section-dot" style="background: var(--accent);"></div>
      New Truck
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Unit Number</label>
        <input v-model="form.unitNumber" class="form-input" type="text" placeholder="e.g. TRK-1001" />
      </div>
      <div class="form-group">
        <label class="form-label">Status</label>
        <select v-model="form.status" class="form-select">
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
          <option value="Maintenance">Maintenance</option>
          <option value="OOS">OOS</option>
        </select>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Make</label>
        <select v-model="form.make" class="form-select">
          <option value="">-- Select make --</option>
          <option v-for="m in truckMakes" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Model</label>
        <select v-model="form.model" class="form-select" :disabled="!form.make">
          <option value="">{{ form.make ? '-- Select model --' : '-- Select make first --' }}</option>
          <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Year</label>
        <input v-model="form.year" class="form-input" type="number" placeholder="e.g. 2022" />
      </div>
      <div class="form-group">
        <label class="form-label">VIN</label>
        <input v-model="form.vin" class="form-input" type="text" placeholder="Vehicle Identification Number" />
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">License Plate</label>
        <input v-model="form.licensePlate" class="form-input" type="text" placeholder="e.g. ABC-1234" />
      </div>
    </div>

    <div class="form-row">
      <div v-if="showOwner" class="form-group">
        <label class="form-label">Owner (Investor)</label>
        <select v-model="form.ownerId" class="form-select">
          <option :value="0">-- Unassigned --</option>
          <option v-for="inv in investorUsers" :key="inv.id" :value="inv.id">{{ inv.username }}</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Assigned Driver</label>
        <select v-model="form.assignedDriver" class="form-select">
          <option value="">-- None --</option>
          <option v-for="name in driverNames" :key="name" :value="name">{{ name }}</option>
        </select>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Notes (optional)</label>
      <textarea v-model="form.notes" class="form-input form-textarea" rows="2" placeholder="Any additional notes..."></textarea>
    </div>

    <div class="form-group">
      <label class="form-label">Truck Photo (optional)</label>
      <!-- Was a bare <input type="file"> with no label or chrome of its own, so
           the dashed-box component is a clean swap rather than a re-skin.
           The extension tokens are not decoration: drag-and-drop bypasses the
           `accept` attribute entirely, and a blank-MIME iPhone HEIC is the
           commonest photo anyone drops here. -->
      <FileDropZone
        compact
        accept="image/*,.heic,.heif"
        :max-size-mb="10"
        :busy="photoBusy"
        label="Drop a truck photo"
        busy-label="Reading photo…"
        busy-hint="Resizing it before upload"
        @files="onPhoto"
      />
      <img v-if="form.photo" :src="form.photo" alt="Truck photo preview" style="max-height:80px;border-radius:6px;margin-top:0.4rem;" />
    </div>

    <details style="margin-bottom:0.75rem;" open>
      <!-- Named after the fields inside it, not the abstraction: the old
           "Business Configuration" gave no hint it held the fuel tank, so two
           trucks ran for months on the 200-gal default and their drivers were
           shown ~2.5x their real range. Tank + MPG lead the section for the
           same reason. -->
      <summary class="fixed-costs-label">Fuel Tank, MPG &amp; Business Configuration</summary>
      <div class="form-row" style="margin-top:0.5rem;">
        <div class="form-group">
          <label class="form-label">Fuel Tank (gallons)</label>
          <input v-model.number="form.fuelTankGallons" class="form-input" type="number" min="0" max="500" step="any" placeholder="200 (default)" />
          <div class="field-hint">Usable diesel capacity — powers the Live Tracking fuel-range estimate. Blank uses the 200 gal default.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Avg MPG (optional)</label>
          <input v-model.number="form.avgMpg" class="form-input" type="number" min="0" max="20" step="any" placeholder="6.5 (default)" />
          <div class="field-hint">Average miles per gallon. Leave blank to auto-derive from ELD fuel + odometer.</div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Purchase Price ($)</label>
          <input v-model.number="form.purchasePrice" class="form-input" type="number" min="0" placeholder="58000" />
        </div>
        <div class="form-group">
          <label class="form-label">Title Status</label>
          <select v-model="form.titleStatus" class="form-input">
            <option value="Clean">Clean</option>
            <option value="Lien">Lien</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Maintenance Fund ($/mo)</label>
          <input v-model.number="form.maintenanceFundMonthly" class="form-input" type="number" min="0" placeholder="800" />
        </div>
        <div class="form-group">
          <label class="form-label">Driver Pay ($/day)</label>
          <!-- Pay is Super Admin only (403 PAY_EDIT_ADMIN_ONLY otherwise): anyone
               else adds the truck on the $250/day default. -->
          <input v-model.number="form.driverPayDaily" class="form-input" type="number" min="0" max="10000" step="any" placeholder="250 (default)" :disabled="!canEditPay" />
          <div v-if="canEditPay" class="field-hint">Daily rate for this truck's driver. Leave blank to use the $250/day default.</div>
          <div v-else class="field-hint">Uses the $250/day default. Only a Super Admin can set driver pay.</div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="add-truck-in-service-date">In Service Since</label>
          <input id="add-truck-in-service-date" v-model="form.inServiceDate" class="form-input" type="date" />
          <div class="field-hint">Fixed costs below are billed from this month onward. Leave blank to fall back to the date the truck record was created.</div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Insurance ($/mo)</label>
          <input v-model.number="form.insuranceMonthly" class="form-input" type="number" min="0" placeholder="0" />
        </div>
        <div class="form-group">
          <label class="form-label">ELD ($/mo)</label>
          <input v-model.number="form.eldMonthly" class="form-input" type="number" min="0" placeholder="0" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">HVUT ($/yr)</label>
          <input v-model.number="form.hvutAnnual" class="form-input" type="number" min="0" placeholder="0" />
        </div>
        <div class="form-group">
          <label class="form-label">IRP ($/yr)</label>
          <input v-model.number="form.irpAnnual" class="form-input" type="number" min="0" placeholder="0" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Truck Payment ($/mo)</label>
          <input v-model.number="form.truckPaymentMonthly" class="form-input" type="number" min="0" placeholder="0" />
        </div>
        <div class="form-group">
          <label class="form-label">Admin Fee (%)</label>
          <input v-model.number="form.adminFeePct" class="form-input" type="number" min="0" max="100" placeholder="50" />
        </div>
      </div>
    </details>

    <button class="btn btn-primary btn-add" @click="handleSubmit">Add Truck</button>
    <div class="error-msg" role="alert">{{ errorMsg }}</div>
  </div>
</template>

<script setup>
import { reactive, ref, computed, watch } from 'vue'
import FileDropZone from '../shared/FileDropZone.vue'
import { compressImage, DEFAULT_MAX_EDGE, isDecodedImage } from '../../lib/imageUtils'

const truckMakes = [
  'Freightliner', 'Kenworth', 'Peterbilt', 'Volvo', 'International',
  'Mack', 'Western Star', 'Hino', 'Isuzu', 'Ford', 'Chevrolet',
  'RAM', 'GMC', 'Tesla', 'Nikola', 'Other',
]

const truckModels = {
  Freightliner: ['Cascadia', 'Columbia', 'Coronado', 'M2 106', 'M2 112', '114SD', '122SD'],
  Kenworth: ['T680', 'T880', 'W900', 'W990', 'T270', 'T370', 'T440', 'T470'],
  Peterbilt: ['579', '389', '567', '520', '337', '348', '365', '367'],
  Volvo: ['VNL 760', 'VNL 860', 'VNL 300', 'VNR 300', 'VNR 400', 'VNR 600', 'VHD 300', 'VHD 400'],
  International: ['LT', 'RH', 'HV', 'HX', 'MV', 'CV'],
  Mack: ['Anthem', 'Pinnacle', 'Granite', 'LR', 'MD', 'TerraPro'],
  'Western Star': ['4900', '5700XE', '4700', '49X', '47X'],
  Hino: ['L6', 'L7', 'XL7', 'XL8', '268', '338'],
  Isuzu: ['NRR', 'NQR', 'NPR', 'NPR-HD', 'FTR', 'FVR'],
  Ford: ['F-650', 'F-750', 'F-59'],
  Chevrolet: ['Silverado 4500HD', 'Silverado 5500HD', 'Silverado 6500HD'],
  RAM: ['3500', '4500', '5500'],
  GMC: ['Sierra 3500HD', 'Sierra 4500HD', 'Sierra 5500HD'],
  Tesla: ['Semi'],
  Nikola: ['Tre BEV', 'Tre FCEV', 'Two'],
}

const props = defineProps({
  driverNames: { type: Array, default: () => [] },
  investorUsers: { type: Array, default: () => [] },
  showOwner: { type: Boolean, default: false },
  // Driver pay is Super Admin only; everyone else adds on the default rate.
  canEditPay: { type: Boolean, default: false },
})

const emit = defineEmits(['submit'])

const form = reactive({
  unitNumber: '',
  make: '',
  model: '',
  year: '',
  vin: '',
  licensePlate: '',
  status: 'Active',
  assignedDriver: '',
  ownerId: 0,
  notes: '',
  photo: '',
  insuranceMonthly: 0,
  eldMonthly: 0,
  truckPaymentMonthly: 0,
  hvutAnnual: 0,
  irpAnnual: 0,
  adminFeePct: 50,
  // Month the truck entered service — scopes when its fixed costs start being
  // charged to the owner's payout. MUST default to '' (never today's date):
  // blank is what preserves the server's created_at fallback, and a wrong value
  // here silently restates historical payouts.
  inServiceDate: '',
  // '' (not 0) so the "250 (default)" placeholder is visible until a rate is typed
  driverPayDaily: '',
  purchasePrice: 0,
  titleStatus: 'Clean',
  maintenanceFundMonthly: 0,
  // '' so the default placeholders show until a value is entered; sent as
  // snake_case fuel_tank_gallons / avg_mpg (0 = unset → server uses its default)
  fuelTankGallons: '',
  avgMpg: '',
})

const modelOptions = computed(() => truckModels[form.make] || [])
watch(() => form.make, () => { form.model = '' })

const errorMsg = ref('')
const photoBusy = ref(false)
// The form's root element, for unreadableNumberError.
const formEl = ref(null)

// Receives File[] from FileDropZone — a drop and a click both land here.
//
// compressImage replaces a raw FileReader, and that is a payload fix rather
// than a style one: the old path base64'd a 12 MP phone photo at FULL SIZE into
// form.photo and POSTed it, ~8 MB of JSON for a thumbnail that renders at 80px.
// It also decodes iPhone HEIC (lazy heic2any), which the old reader stored as
// bytes no browser here could display.
async function onPhoto(files) {
  const file = files[0]
  if (!file) return
  errorMsg.value = ''
  photoBusy.value = true
  try {
    const dataUrl = await compressImage(file, DEFAULT_MAX_EDGE)
    // Only a real decode is kept. When compressImage cannot decode a file it
    // hands back the RAW bytes under the file's own media type (an SVG, a PDF,
    // …) or '' — and the server refuses any photo that is not a JPEG, PNG or
    // WebP (415 UNSUPPORTED_IMAGE_TYPE). Keep whatever photo was already
    // attached rather than swapping in one the save would be refused over.
    if (dataUrl && isDecodedImage(dataUrl)) form.photo = dataUrl
    else errorMsg.value = "Couldn't read that photo — use a JPEG, PNG or WebP image."
  } finally {
    photoBusy.value = false
  }
}

// The most the server stores in a truck amount. Above it, below 0 or not a
// finite number, the save is answered 400 INVALID_AMOUNT.
const AMOUNT_MAX = 1000000

// Every amount input, in form order, so a refusal names the first bad field on
// screen. Driver pay keeps the server's own tighter 0–10,000 range and is only
// checked when this user may edit it; admin fee is a percentage.
const AMOUNT_FIELDS = [
  { key: 'fuelTankGallons', label: 'Fuel tank' },
  { key: 'avgMpg', label: 'Avg MPG' },
  { key: 'purchasePrice', label: 'Purchase price' },
  { key: 'maintenanceFundMonthly', label: 'Maintenance fund' },
  { key: 'driverPayDaily', label: 'Driver pay', max: 10000, pay: true },
  { key: 'insuranceMonthly', label: 'Insurance' },
  { key: 'eldMonthly', label: 'ELD' },
  { key: 'hvutAnnual', label: 'HVUT' },
  { key: 'irpAnnual', label: 'IRP' },
  { key: 'truckPaymentMonthly', label: 'Truck payment' },
  { key: 'adminFeePct', label: 'Admin fee', max: 100 },
]

// '' when every amount is blank or a finite number in range; otherwise one
// sentence naming the first field that is not. Blank ('' / null / undefined)
// stays allowed — it is how a field says "unset". v-model.number parseFloat()s
// whatever the input reports, so a huge entry (1e308) arrives as a number, and
// a non-finite one, should a browser report it, as Infinity — which
// JSON.stringify would send as null. Chrome reports '' for that case instead;
// see unreadableNumberError. Same rule as TruckTable.vue's copy.
function amountError(values, canEditPay) {
  for (const { key, label, max = AMOUNT_MAX, pay } of AMOUNT_FIELDS) {
    if (pay && !canEditPay) continue
    const v = values[key]
    if (v === '' || v === null || v === undefined) continue
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0 || n > max) {
      return `${label} must be a number between 0 and ${max.toLocaleString('en-US')}.`
    }
  }
  return ''
}

// A number box the browser cannot parse keeps its text on screen but reports
// value '' — in Chrome "1e999", "15-00" and "5e" all do — and v-model reads
// that '' as a deliberate blank, so the field would save as unset (0) without
// a word. Only input.validity.badInput tells "cleared" from "unreadable", which
// is why this reads the DOM. Names the first such box by its label; a disabled
// box (driver pay for a non-Super Admin) is never sent, so it is skipped. Same
// rule as TruckTable.vue's copy.
//
// ⚠️ Depends on keepUnreadableNumber below: without it the evidence is gone
// before this runs.
function unreadableNumberError(root) {
  if (!root) return ''
  for (const el of root.querySelectorAll('input[type="number"]')) {
    if (el.disabled || !el.validity?.badInput) continue
    const label = el.closest('.form-group, .edit-field')?.querySelector('label')?.textContent.trim()
    return `${label || 'A number field'} can't be read as a number — correct it or clear the box.`
  }
  return ''
}

// v-model on a number box (with or without .number) adds its own 'change'
// listener that rewrites the box with the cast model value — '' for an
// unreadable entry — so without this the typo, and badInput with it, would
// vanish the moment the box loses focus: exactly when Add Truck is pressed,
// before its click handler runs. Stopping that one event here, in the capture
// phase on the form, keeps the typo on screen for unreadableNumberError to find
// and for the person to fix. Readable entries pass through untouched. Same as
// TruckTable.vue's copy.
function keepUnreadableNumber(e) {
  const el = e.target
  if (el?.tagName === 'INPUT' && el.type === 'number' && el.validity?.badInput) e.stopPropagation()
}

function handleSubmit() {
  errorMsg.value = ''
  if (!form.unitNumber.trim()) {
    errorMsg.value = 'Unit number is required.'
    return
  }
  // Refused here rather than left to the server: emitting `submit` clears this
  // form at once, so a server refusal would land after everything typed was gone.
  const badAmount = unreadableNumberError(formEl.value) || amountError(form, props.canEditPay)
  if (badAmount) {
    errorMsg.value = badAmount
    return
  }

  emit('submit', {
    unitNumber: form.unitNumber.trim(),
    make: form.make.trim(),
    model: form.model.trim(),
    year: form.year || 0,
    vin: form.vin.trim(),
    licensePlate: form.licensePlate.trim(),
    status: form.status,
    assignedDriver: form.assignedDriver,
    ownerId: form.ownerId,
    notes: form.notes.trim(),
    photo: form.photo,
    insuranceMonthly: form.insuranceMonthly,
    eldMonthly: form.eldMonthly,
    truckPaymentMonthly: form.truckPaymentMonthly,
    hvutAnnual: form.hvutAnnual,
    irpAnnual: form.irpAnnual,
    adminFeePct: form.adminFeePct,
    // Blank stays blank ('' — never null, never today) so the server keeps its
    // created_at fallback. Sent under both key styles because the trucks API
    // mixes conventions (camelCase driverPayDaily vs snake_case
    // fuel_tank_gallons); identical value, so whichever the server reads wins.
    in_service_date: form.inServiceDate || '',
    inServiceDate: form.inServiceDate || '',
    // Blank input = no custom rate (server stores 0 = use $250 default). Only a
    // Super Admin sends a rate; anyone else's truck starts on the default.
    driverPayDaily: !props.canEditPay || form.driverPayDaily === '' ? 0 : form.driverPayDaily,
    purchasePrice: form.purchasePrice,
    titleStatus: form.titleStatus,
    maintenanceFundMonthly: form.maintenanceFundMonthly,
    // Fuel-model inputs (snake_case per the wave contract). Blank → 0 = unset,
    // server falls back to its DEFAULT_TANK_GALLONS / DEFAULT_MPG.
    fuel_tank_gallons: form.fuelTankGallons === '' ? 0 : form.fuelTankGallons,
    avg_mpg: form.avgMpg === '' ? 0 : form.avgMpg,
  })

  form.unitNumber = ''
  form.make = ''
  form.model = ''
  form.year = ''
  form.vin = ''
  form.licensePlate = ''
  form.status = 'Active'
  form.assignedDriver = ''
  form.ownerId = 0
  form.notes = ''
  form.photo = ''
  form.insuranceMonthly = 0
  form.eldMonthly = 0
  form.truckPaymentMonthly = 0
  form.hvutAnnual = 0
  form.irpAnnual = 0
  form.adminFeePct = 50
  form.inServiceDate = ''
  form.driverPayDaily = ''
  form.purchasePrice = 0
  form.titleStatus = 'Clean'
  form.maintenanceFundMonthly = 0
  form.fuelTankGallons = ''
  form.avgMpg = ''
}
</script>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}
.admin-section-title {
  display: flex; align-items: center; gap: 0.5rem;
  font-weight: 700; font-size: 0.88rem; margin-bottom: 1rem;
}
.section-dot { width: 8px; height: 8px; border-radius: 50%; }
.form-row { display: flex; gap: 1rem; margin-bottom: 0.75rem; }
.form-row .form-group { flex: 1; }
.form-group { margin-bottom: 0.75rem; }
.form-textarea { resize: vertical; }
.btn-add { width: auto; padding: 0.5rem 1.5rem; }
.error-msg { color: var(--danger); font-size: 0.78rem; margin-top: 0.5rem; min-height: 1.1em; }
.field-hint { font-size: 0.7rem; color: var(--text-dim); margin-top: 0.25rem; }
/* Read-only for this role (driver pay is Super Admin only): still legible. */
.form-input:disabled { opacity: 0.6; cursor: not-allowed; }
.fixed-costs-label {
  font-size: 0.72rem; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer;
}
</style>
