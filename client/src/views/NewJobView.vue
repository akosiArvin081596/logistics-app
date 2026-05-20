<template>
  <div class="new-job-page admin-page">
    <div class="page-header">
      <h2>New Job</h2>
      <router-link to="/dashboard" class="btn-back">Back to Dashboard</router-link>
    </div>

    <div class="form-card">
      <!-- Load Info -->
      <div class="form-section">
        <div class="section-label">Load Information</div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Load ID *</label>
            <div class="input-with-btn">
              <input v-model="form.loadId" class="form-input" type="text" placeholder="e.g. LD-20260402" />
              <button class="btn-gen" @click="generateId" title="Auto-generate">&#8635;</button>
            </div>
            <div v-if="duplicateWarning" class="field-warning">{{ duplicateWarning }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">Contract ID</label>
            <input v-model="form.contractId" class="form-input" type="text" placeholder="Contract or reference ID" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Rate / Amount ($)</label>
            <input v-model.number="form.rate" class="form-input" type="number" min="0" step="0.01" placeholder="0.00" />
          </div>
          <div class="form-group">
            <label class="form-label">Trailer Number</label>
            <input v-model="form.trailerNumber" class="form-input" type="text" placeholder="e.g. TR-1234" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Broker Contact Name</label>
            <input v-model="form.brokerContact" class="form-input" type="text" placeholder="Contact name" />
          </div>
          <div class="form-group">
            <label class="form-label">Broker Phone</label>
            <input v-model="form.brokerPhone" class="form-input" type="text" placeholder="Phone number" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Broker Email</label>
            <input v-model="form.brokerEmail" class="form-input" type="email" placeholder="Email" />
          </div>
          <div class="form-group"></div>
        </div>
      </div>

      <!-- Pickup -->
      <div class="form-section">
        <div class="section-label">Pickup Details</div>
        <div class="location-card">
          <div class="location-card-header pickup">
            <span class="location-dot pickup"></span>
            <span class="location-card-title">Origin / Pickup</span>
          </div>
          <div class="location-card-body">
            <div class="form-row">
              <div class="form-group flex-2">
                <label class="form-label">Shipper / Facility Name</label>
                <input v-model="form.pickupInfo" class="form-input" type="text" placeholder="Company or facility name at pickup" />
              </div>
              <div class="form-group">
                <label class="form-label">Date</label>
                <input v-model="form.pickupDate" class="form-input" type="date" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group flex-2">
                <label class="form-label">Address</label>
                <div class="address-input-wrap">
                  <input v-model="form.pickupAddress" class="form-input" type="text" placeholder="Search or pick on map..." @input="onPickupSearch" />
                  <div v-if="pickupSuggestions.length" class="address-suggestions">
                    <div v-for="(s, i) in pickupSuggestions" :key="i" class="address-suggestion-item" @click="selectPickupSuggestion(s)">{{ s.displayName }}</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="coord-row">
              <div class="coord-info">
                <span v-if="form.pickupLat" class="coord-text">{{ form.pickupLat.toFixed(5) }}, {{ form.pickupLng.toFixed(5) }}</span>
                <span v-else class="coord-text dim">No coordinates set</span>
                <span v-if="pickupResolvedAddress" class="resolved-address">{{ pickupResolvedAddress }}</span>
              </div>
              <button class="btn-map" type="button" @click="openPicker('pickup')">&#128205; Pick on Map</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Drop-off -->
      <div class="form-section">
        <div class="section-label">Drop-off Details</div>
        <div class="location-card">
          <div class="location-card-header dropoff">
            <span class="location-dot dropoff"></span>
            <span class="location-card-title">Destination / Drop-off</span>
          </div>
          <div class="location-card-body">
            <div class="form-row">
              <div class="form-group flex-2">
                <label class="form-label">Receiver / Facility Name</label>
                <input v-model="form.dropoffInfo" class="form-input" type="text" placeholder="Company or facility name at drop-off" />
              </div>
              <div class="form-group">
                <label class="form-label">Date</label>
                <input v-model="form.deliveryDate" class="form-input" type="date" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group flex-2">
                <label class="form-label">Address</label>
                <div class="address-input-wrap">
                  <input v-model="form.dropoffAddress" class="form-input" type="text" placeholder="Search or pick on map..." @input="onDropoffSearch" />
                  <div v-if="dropoffSuggestions.length" class="address-suggestions">
                    <div v-for="(s, i) in dropoffSuggestions" :key="i" class="address-suggestion-item" @click="selectDropoffSuggestion(s)">{{ s.displayName }}</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="coord-row">
              <div class="coord-info">
                <span v-if="form.dropoffLat" class="coord-text">{{ form.dropoffLat.toFixed(5) }}, {{ form.dropoffLng.toFixed(5) }}</span>
                <span v-else class="coord-text dim">No coordinates set</span>
                <span v-if="dropoffResolvedAddress" class="resolved-address">{{ dropoffResolvedAddress }}</span>
              </div>
              <button class="btn-map" type="button" @click="openPicker('dropoff')">&#128205; Pick on Map</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Location Picker Modal -->
      <LocationPickerModal
        :open="pickerOpen"
        :label="pickerLabel"
        :initial-lat="pickerInitLat"
        :initial-lng="pickerInitLng"
        @confirm="onPickerConfirm"
        @close="pickerOpen = false"
      />

      <!-- Details -->
      <div class="form-section">
        <div class="section-label">Additional Info</div>
        <div class="form-group">
          <label class="form-label">Details / Notes</label>
          <input v-model="form.details" class="form-input" type="text" placeholder="Additional load details" />
        </div>
      </div>

      <!-- Actions -->
      <div class="form-actions">
        <router-link to="/dashboard" class="btn btn-secondary">Cancel</router-link>
        <button class="btn btn-primary" :disabled="submitting || !form.loadId.trim()" @click="submit">
          {{ submitting ? 'Creating...' : 'Create Job' }}
        </button>
      </div>

      <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useApi } from '../composables/useApi'
import { useToast } from '../composables/useToast'
import { useGeocode } from '../composables/useGeocode'
import LocationPickerModal from '../components/data-manager/LocationPickerModal.vue'

const api = useApi()
const router = useRouter()
const { show: toast } = useToast()
const geocode = useGeocode()

const headers = ref([])
const drivers = ref([])
const submitting = ref(false)
const errorMsg = ref('')
const duplicateWarning = ref('')

const today = new Date().toISOString().split('T')[0]

const form = reactive({
  loadId: '',
  contractId: '',
  rate: '',
  trailerNumber: '',
  brokerContact: '',
  brokerPhone: '',
  brokerEmail: '',
  pickupInfo: '',
  pickupAddress: '',
  pickupDate: today,
  pickupLat: '',
  pickupLng: '',
  dropoffInfo: '',
  dropoffAddress: '',
  deliveryDate: '',
  dropoffLat: '',
  dropoffLng: '',
  details: '',
})

// Inline address search
const pickupSuggestions = ref([])
const dropoffSuggestions = ref([])
const pickupResolvedAddress = ref('')
const dropoffResolvedAddress = ref('')
let pickupTimer = null
let dropoffTimer = null

function onPickupSearch() {
  clearTimeout(pickupTimer)
  pickupTimer = setTimeout(async () => {
    pickupSuggestions.value = await geocode.searchAddress(form.pickupAddress)
  }, 400)
}
function onDropoffSearch() {
  clearTimeout(dropoffTimer)
  dropoffTimer = setTimeout(async () => {
    dropoffSuggestions.value = await geocode.searchAddress(form.dropoffAddress)
  }, 400)
}
function selectPickupSuggestion(s) {
  form.pickupAddress = s.displayName
  form.pickupLat = s.lat
  form.pickupLng = s.lng
  pickupSuggestions.value = []
  pickupResolvedAddress.value = s.displayName
}
function selectDropoffSuggestion(s) {
  form.dropoffAddress = s.displayName
  form.dropoffLat = s.lat
  form.dropoffLng = s.lng
  dropoffSuggestions.value = []
  dropoffResolvedAddress.value = s.displayName
}

function generateId() {
  form.loadId = `LD-${Date.now().toString(36).toUpperCase()}`
}

// Map picker state
const pickerOpen = ref(false)
const pickerTarget = ref('')
const pickerLabel = ref('Pickup')
const pickerInitLat = ref(NaN)
const pickerInitLng = ref(NaN)

function openPicker(target) {
  pickerTarget.value = target
  if (target === 'pickup') {
    pickerLabel.value = 'Pickup'
    pickerInitLat.value = form.pickupLat || NaN
    pickerInitLng.value = form.pickupLng || NaN
  } else {
    pickerLabel.value = 'Drop-off'
    pickerInitLat.value = form.dropoffLat || NaN
    pickerInitLng.value = form.dropoffLng || NaN
  }
  pickerOpen.value = true
}

function onPickerConfirm({ lat, lng, displayName }) {
  if (pickerTarget.value === 'pickup') {
    form.pickupLat = lat
    form.pickupLng = lng
    if (displayName) { form.pickupAddress = displayName; pickupResolvedAddress.value = displayName }
  } else {
    form.dropoffLat = lat
    form.dropoffLng = lng
    if (displayName) { form.dropoffAddress = displayName; dropoffResolvedAddress.value = displayName }
  }
  pickerOpen.value = false
}

// Column matchers — same regex patterns used by server.js
function findCol(hdrs, re) {
  return hdrs.find(h => re.test(h)) || ''
}

async function loadHeaders() {
  try {
    const data = await api.get('/api/data?sheet=Job%20Tracking&page=1&limit=1')
    headers.value = data.headers || []
  } catch { /* empty */ }
}

async function loadDrivers() {
  try {
    const data = await api.get('/api/drivers-directory')
    const driverCol = (data.headers || []).find(h => /driver/i.test(h))
    if (driverCol) {
      const names = (data.data || []).map(r => (r[driverCol] || '').trim()).filter(Boolean)
      drivers.value = [...new Set(names)].sort()
    }
  } catch { /* empty */ }
}

async function submit() {
  errorMsg.value = ''
  duplicateWarning.value = ''

  if (!form.loadId.trim()) {
    errorMsg.value = 'Load ID is required.'
    return
  }

  submitting.value = true
  const hdrs = headers.value
  if (hdrs.length === 0) {
    errorMsg.value = 'Could not load sheet headers. Try refreshing.'
    submitting.value = false
    return
  }

  // Build values array matching header order
  const values = hdrs.map(h => {
    const hl = h.trim().toLowerCase()

    // Contract ID
    if (/^contract.?id$/i.test(hl)) return form.contractId

    // Load ID
    if (/load.?id|job.?id/i.test(hl)) return form.loadId.trim()

    // Trailer Number
    if (/trailer.*num|trailer.?#/i.test(hl)) return form.trailerNumber

    // Status — always Unassigned on creation
    if (/^(job.?)?status$/i.test(hl)) return 'Unassigned'

    // Driver — always empty on creation (assigned later from dashboard)
    if (/^driver$/i.test(hl)) return ''

    // Rate / Payment
    if (/^(rate|amount|revenue|pay|payment|charge)$/i.test(hl)) return form.rate ? String(form.rate) : ''

    // Broker
    if (/broker.*contact|contact.*name/i.test(hl)) return form.brokerContact
    if (/phone/i.test(hl)) return form.brokerPhone
    if (/email/i.test(hl)) return form.brokerEmail

    // Pickup Info (shipper/facility name) — must be before address regex
    if (/pickup.*info|origin.*info/i.test(hl)) return form.pickupInfo

    // Pickup Address
    if (/pickup.*addr|origin.*addr|shipper.*addr/i.test(hl)) return form.pickupAddress
    if (/origin.*city|pickup.*city|shipper.*city/i.test(hl)) return form.pickupAddress
    if (/(origin|pickup|shipper).*lat/i.test(hl)) return form.pickupLat ? String(form.pickupLat) : ''
    if (/(origin|pickup|shipper).*l(on|ng)/i.test(hl)) return form.pickupLng ? String(form.pickupLng) : ''
    if (/pickup.*date|pickup.*appoint/i.test(hl)) return form.pickupDate || ''

    // Drop-off Info (receiver/facility name) — must be before address regex
    if (/drop.*info|dest.*info/i.test(hl)) return form.dropoffInfo

    // Drop-off Address
    if (/drop.*addr|dest.*addr|receiver.*addr|delivery.*addr/i.test(hl)) return form.dropoffAddress
    if (/dest.*city|drop.*city|receiver.*city|delivery.*city|consignee/i.test(hl)) return form.dropoffAddress
    if (/(dest|drop|receiver|delivery).*lat/i.test(hl)) return form.dropoffLat ? String(form.dropoffLat) : ''
    if (/(dest|drop|receiver|delivery).*l(on|ng)/i.test(hl)) return form.dropoffLng ? String(form.dropoffLng) : ''
    if (/drop.*date|deliv.*date|drop.*appoint|deliv.*appoint/i.test(hl)) return form.deliveryDate || ''

    // Details
    if (/^details$/i.test(hl)) return form.details

    // Auto-fill defaults
    if (/phase.*progress/i.test(hl)) return 'Heading to Pickup'
    if (/carrier.*stage/i.test(hl)) return 'Waiting on Documents'
    if (/assigned.*date/i.test(hl)) return today
    if (/status.*update.*date/i.test(hl)) return today

    return ''
  })

  try {
    const coordinates = (form.pickupLat || form.dropoffLat) ? {
      loadId: form.loadId.trim(),
      originLat: form.pickupLat || null,
      originLng: form.pickupLng || null,
      destLat: form.dropoffLat || null,
      destLng: form.dropoffLng || null,
      pickupAddress: form.pickupAddress || '',
      dropoffAddress: form.dropoffAddress || '',
    } : undefined
    const res = await api.post('/api/data?sheet=Job%20Tracking', { values, coordinates })
    if (res.warning) duplicateWarning.value = res.warning

    toast('Job created successfully', 'success')
    router.push('/dashboard')
  } catch (err) {
    errorMsg.value = err.message || 'Failed to create job.'
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  loadHeaders()
  loadDrivers()
  generateId()
})
</script>

<style scoped>
.page-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;
}
.btn-back {
  font-size: 0.78rem; color: var(--text-dim); text-decoration: none;
  padding: 0.35rem 0.85rem; border: 1px solid var(--border); border-radius: 6px;
  transition: all 0.15s;
}
.btn-back:hover { background: var(--surface); color: var(--text); }

.form-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.5rem;
}

.form-section {
  margin-bottom: 1.5rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--bg);
}
.form-section:last-of-type { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }

.section-label {
  font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-dim); margin-bottom: 0.75rem;
}

.form-row { display: flex; gap: 1rem; margin-bottom: 0.75rem; }
.form-row .form-group { flex: 1; }
.form-row .form-group.flex-2 { flex: 2; }

.form-group { margin-bottom: 0.5rem; }

.form-label {
  display: block; font-size: 0.72rem; font-weight: 600;
  color: var(--text-dim); margin-bottom: 0.25rem;
}

.form-input, .form-select {
  width: 100%; padding: 0.5rem 0.65rem; border: 1px solid var(--border);
  border-radius: 6px; font-family: inherit; font-size: 0.85rem;
  background: var(--bg); color: var(--text);
}
.form-input:focus, .form-select:focus {
  outline: none; border-color: var(--accent);
}

.input-with-btn { display: flex; gap: 0.35rem; }
.input-with-btn .form-input { flex: 1; }
.btn-gen {
  padding: 0.5rem 0.65rem; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); cursor: pointer; font-size: 1rem;
  color: var(--text-dim); transition: all 0.15s;
}
.btn-gen:hover { border-color: var(--accent); color: var(--accent); }

/* Location cards */
.location-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface);
}
.location-card-header {
  display: flex; align-items: center; gap: 0.625rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
}
.location-card-header.pickup { background: #eff6ff; }
.location-card-header.dropoff { background: #fef2f2; }
.location-dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
}
.location-dot.pickup { background: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.2); }
.location-dot.dropoff { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,0.2); }
.location-card-title {
  font-size: 0.75rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.05em; color: #374151;
}
.location-card-body {
  padding: 1rem;
}

/* Address search inline */
.address-input-wrap { position: relative; }
.address-suggestions {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 50;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; margin-top: 2px; max-height: 180px; overflow-y: auto;
  box-shadow: 0 4px 16px rgba(0,0,0,0.1);
}
.address-suggestion-item {
  padding: 0.5rem 0.75rem; font-size: 0.82rem; cursor: pointer;
  border-bottom: 1px solid var(--bg); color: var(--text);
}
.address-suggestion-item:last-child { border-bottom: none; }
.address-suggestion-item:hover { background: var(--surface-hover); }

/* Coordinate row */
.coord-row {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.625rem 0.75rem; background: var(--bg);
  border: 1px solid var(--border); border-radius: 8px;
  margin-top: 0.5rem;
}
.coord-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.coord-text {
  font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: var(--text);
}
.coord-text.dim { color: var(--text-dim); font-family: inherit; }
.resolved-address {
  font-size: 0.72rem; color: #6b7280; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.btn-map {
  padding: 0.4rem 0.85rem;
  font-size: 0.75rem; font-weight: 600; font-family: inherit;
  border: 1px solid var(--accent); border-radius: 8px;
  background: var(--accent-dim); color: var(--accent);
  cursor: pointer; white-space: nowrap; transition: all 0.15s;
  flex-shrink: 0;
}
.btn-map:hover { background: var(--accent); color: #fff; }

.form-actions {
  display: flex; justify-content: flex-end; gap: 0.75rem;
  margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--bg);
}

.error-msg { color: var(--danger); font-size: 0.78rem; margin-top: 0.75rem; }
.field-warning { color: var(--amber); font-size: 0.72rem; margin-top: 0.25rem; }

@media (max-width: 640px) {
  .form-row { flex-direction: column; gap: 0; }
}
</style>
