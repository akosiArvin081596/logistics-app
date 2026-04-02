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
            <label class="form-label">Rate / Amount ($)</label>
            <input v-model.number="form.rate" class="form-input" type="number" min="0" step="0.01" placeholder="0.00" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Broker / Customer</label>
            <input v-model="form.broker" class="form-input" type="text" placeholder="Broker or shipper name" />
          </div>
          <div class="form-group">
            <label class="form-label">Broker Contact</label>
            <input v-model="form.brokerContact" class="form-input" type="text" placeholder="Contact name" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Broker Phone</label>
            <input v-model="form.brokerPhone" class="form-input" type="text" placeholder="Phone number" />
          </div>
          <div class="form-group">
            <label class="form-label">Broker Email</label>
            <input v-model="form.brokerEmail" class="form-input" type="email" placeholder="Email" />
          </div>
        </div>
      </div>

      <!-- Pickup -->
      <div class="form-section">
        <div class="section-label">Pickup Details</div>
        <div class="form-row">
          <div class="form-group flex-2">
            <label class="form-label">Pickup Address / City</label>
            <input v-model="form.pickupAddress" class="form-input" type="text" placeholder="e.g. 123 Main St, Dallas, TX" />
          </div>
          <div class="form-group">
            <label class="form-label">Pickup Date</label>
            <input v-model="form.pickupDate" class="form-input" type="date" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Coordinates</label>
            <div class="coord-display">
              <span v-if="form.pickupLat" class="coord-text">{{ form.pickupLat.toFixed(5) }}, {{ form.pickupLng.toFixed(5) }}</span>
              <span v-else class="coord-text dim">Not set</span>
              <button class="btn-map" type="button" @click="openPicker('pickup')">&#128205; Pick on Map</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Drop-off -->
      <div class="form-section">
        <div class="section-label">Drop-off Details</div>
        <div class="form-row">
          <div class="form-group flex-2">
            <label class="form-label">Drop-off Address / City</label>
            <input v-model="form.dropoffAddress" class="form-input" type="text" placeholder="e.g. 456 Oak Ave, Houston, TX" />
          </div>
          <div class="form-group">
            <label class="form-label">Delivery Date</label>
            <input v-model="form.deliveryDate" class="form-input" type="date" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Coordinates</label>
            <div class="coord-display">
              <span v-if="form.dropoffLat" class="coord-text">{{ form.dropoffLat.toFixed(5) }}, {{ form.dropoffLng.toFixed(5) }}</span>
              <span v-else class="coord-text dim">Not set</span>
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

      <!-- Assignment -->
      <div class="form-section">
        <div class="section-label">Assignment</div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Driver</label>
            <select v-model="form.driver" class="form-select">
              <option value="">Unassigned</option>
              <option v-for="d in drivers" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>
          <div class="form-group flex-2">
            <label class="form-label">Details / Notes</label>
            <input v-model="form.details" class="form-input" type="text" placeholder="Additional load details" />
          </div>
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
import LocationPickerModal from '../components/data-manager/LocationPickerModal.vue'

const api = useApi()
const router = useRouter()
const { show: toast } = useToast()

const headers = ref([])
const drivers = ref([])
const submitting = ref(false)
const errorMsg = ref('')
const duplicateWarning = ref('')

const today = new Date().toISOString().split('T')[0]

const form = reactive({
  loadId: '',
  rate: '',
  broker: '',
  brokerContact: '',
  brokerPhone: '',
  brokerEmail: '',
  pickupAddress: '',
  pickupDate: today,
  pickupLat: '',
  pickupLng: '',
  dropoffAddress: '',
  deliveryDate: '',
  dropoffLat: '',
  dropoffLng: '',
  driver: '',
  details: '',
})

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
    if (displayName) form.pickupAddress = displayName
  } else {
    form.dropoffLat = lat
    form.dropoffLng = lng
    if (displayName) form.dropoffAddress = displayName
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
    const data = await api.get(`/api/data?sheet=${encodeURIComponent('Carrier Database')}&page=1&limit=200`)
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
    const hl = h.toLowerCase()

    // Load ID
    if (/load.?id|job.?id/i.test(h)) return form.loadId.trim()

    // Status
    if (/^(job.?)?status$/i.test(h)) return form.driver ? 'Dispatched' : 'Unassigned'

    // Driver
    if (/^driver$/i.test(h)) return form.driver || ''

    // Rate
    if (/^(rate|amount|revenue|pay|charge)$/i.test(h)) return form.rate ? String(form.rate) : ''

    // Broker
    if (/^(broker|shipper|customer|client)$/i.test(h)) return form.broker
    if (/broker.*contact|contact.*name/i.test(h)) return form.brokerContact
    if (/phone/i.test(h)) return form.brokerPhone
    if (/email/i.test(h)) return form.brokerEmail

    // Pickup
    if (/pickup.*addr|origin.*addr|shipper.*addr|pickup.*info|origin.*info/i.test(h)) return form.pickupAddress
    if (/origin.*city|pickup.*city|shipper.*city/i.test(h)) return form.pickupAddress
    if (/(origin|pickup|shipper).*lat/i.test(h)) return form.pickupLat ? String(form.pickupLat) : ''
    if (/(origin|pickup|shipper).*l(on|ng)/i.test(h)) return form.pickupLng ? String(form.pickupLng) : ''
    if (/pickup.*date|pickup.*appoint/i.test(h)) return form.pickupDate || ''

    // Dropoff
    if (/drop.*addr|dest.*addr|receiver.*addr|delivery.*addr|drop.*info|dest.*info/i.test(h)) return form.dropoffAddress
    if (/dest.*city|drop.*city|receiver.*city|delivery.*city|consignee/i.test(h)) return form.dropoffAddress
    if (/(dest|drop|receiver|delivery).*lat/i.test(h)) return form.dropoffLat ? String(form.dropoffLat) : ''
    if (/(dest|drop|receiver|delivery).*l(on|ng)/i.test(h)) return form.dropoffLng ? String(form.dropoffLng) : ''
    if (/drop.*date|deliv.*date|drop.*appoint|deliv.*appoint/i.test(h)) return form.deliveryDate || ''

    // Details
    if (/^details$/i.test(h)) return form.details

    // Auto-fill defaults
    if (/phase.*progress/i.test(h)) return 'Heading to Pickup'
    if (/carrier.*stage/i.test(h)) return 'Waiting on Documents'
    if (/assigned.*date/i.test(h)) return today
    if (/status.*update.*date/i.test(h)) return today

    return ''
  })

  try {
    const res = await api.post('/api/data?sheet=Job%20Tracking', { values })
    if (res.warning) duplicateWarning.value = res.warning

    // If driver was assigned, dispatch
    if (form.driver) {
      try {
        const loadIdCol = findCol(hdrs, /load.?id|job.?id/i)
        const rowIndex = res.updatedRange
          ? parseInt(res.updatedRange.split('!')[1]?.match(/\d+/)?.[0] || '0')
          : 0
        await api.post('/api/dispatch', {
          rowIndex,
          driver: form.driver,
          loadId: form.loadId.trim(),
          origin: form.pickupAddress,
          destination: form.dropoffAddress,
        })
      } catch { /* dispatch notification failed but job was created */ }
    }

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
.form-input.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; }

.input-with-btn { display: flex; gap: 0.35rem; }
.input-with-btn .form-input { flex: 1; }
.btn-gen {
  padding: 0.5rem 0.65rem; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); cursor: pointer; font-size: 1rem;
  color: var(--text-dim); transition: all 0.15s;
}
.btn-gen:hover { border-color: var(--accent); color: var(--accent); }

.form-actions {
  display: flex; justify-content: flex-end; gap: 0.75rem;
  margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--bg);
}

.error-msg { color: var(--danger); font-size: 0.78rem; margin-top: 0.75rem; }
.field-warning { color: var(--amber); font-size: 0.72rem; margin-top: 0.25rem; }

.coord-display {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.5rem 0.65rem; background: var(--bg);
  border: 1px solid var(--border); border-radius: 6px;
}
.coord-text {
  font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--text);
}
.coord-text.dim { color: var(--text-dim); }
.btn-map {
  margin-left: auto; padding: 0.3rem 0.75rem;
  font-size: 0.75rem; font-weight: 600; font-family: inherit;
  border: 1px solid var(--accent); border-radius: 6px;
  background: var(--accent-dim); color: var(--accent);
  cursor: pointer; white-space: nowrap; transition: opacity 0.15s;
}
.btn-map:hover { opacity: 0.75; }

@media (max-width: 640px) {
  .form-row { flex-direction: column; gap: 0; }
}
</style>
