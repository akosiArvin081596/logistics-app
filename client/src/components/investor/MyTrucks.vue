<template>
  <div class="section-card">
    <div class="section-header-row">
      <h3 class="section-title">My Trucks</h3>
      <span class="section-count">{{ trucks.length }}</span>
    </div>

    <!-- Add Truck Accordion — hidden in admin "view as investor" preview mode -->
    <details v-if="!isPreview" class="form-accordion" style="margin-bottom:1rem;">
      <summary class="form-toggle">+ Add Truck</summary>
      <div style="padding:1rem;">
        <div class="form-grid">
          <div class="form-group"><label>Unit Number *</label><input v-model="form.unitNumber" required /></div>
          <div class="form-group"><label>Year</label><input v-model="form.year" type="number" /></div>
          <div class="form-group"><label>Make</label><input v-model="form.make" /></div>
          <div class="form-group"><label>Model</label><input v-model="form.model" /></div>
          <div class="form-group"><label>VIN</label><input v-model="form.vin" /></div>
          <div class="form-group"><label>License Plate</label><input v-model="form.licensePlate" /></div>
        </div>
        <button class="btn-add" :disabled="!form.unitNumber?.trim() || adding" @click="addTruck">
          {{ adding ? 'Adding...' : 'Add Truck' }}
        </button>
      </div>
    </details>

    <!-- Trucks Table -->
    <div v-if="trucks.length === 0" class="empty-msg">No trucks added yet.</div>
    <table v-else class="trucks-table">
      <thead>
        <tr>
          <th></th>
          <th>Unit #</th>
          <th>Year</th>
          <th>Make</th>
          <th>Model</th>
          <th>VIN</th>
          <th>Status</th>
          <th>Current Driver</th>
          <th
            class="clickable-header"
            role="button" tabindex="0"
            title="Click for explanation of how Loads is counted"
            @click="openDetail('loads')"
            @keyup.enter="openDetail('loads')"
            @keyup.space.prevent="openDetail('loads')"
          >Loads <span class="info-marker" aria-hidden="true">i</span></th>
          <th
            class="clickable-header"
            role="button" tabindex="0"
            title="7-day average miles per gallon, derived from ELD telemetry. Click for full explanation."
            @click="openDetail('mpg')"
            @keyup.enter="openDetail('mpg')"
            @keyup.space.prevent="openDetail('mpg')"
          >MPG (7d) <span class="info-marker" aria-hidden="true">i</span></th>
          <th
            class="clickable-header"
            role="button" tabindex="0"
            title="Open ELD fault codes (DTCs). Click for full explanation."
            @click="openDetail('faults')"
            @keyup.enter="openDetail('faults')"
            @keyup.space.prevent="openDetail('faults')"
          >Faults <span class="info-marker" aria-hidden="true">i</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in trucks" :key="t.id">
          <td class="photo-cell">
            <img v-if="t.Photo" :src="t.Photo" class="truck-thumb" :alt="t.UnitNumber" />
            <div v-else class="truck-thumb-placeholder">&#128665;</div>
          </td>
          <td class="mono bold">{{ t.UnitNumber }}</td>
          <td>{{ t.Year || '-' }}</td>
          <td>{{ t.Make || '-' }}</td>
          <td>{{ t.Model || '-' }}</td>
          <td class="mono">{{ t.VIN ? t.VIN.slice(-6) : '-' }}</td>
          <td><span :class="['status-pill', statusClass(t.Status)]">{{ t.Status }}</span></td>
          <td>{{ t.AssignedDriver || '-' }}</td>
          <td class="mono">{{ loadCountFor(t) }}</td>
          <td class="mono">{{ mpgFor(t) }}</td>
          <td>
            <span v-if="faultCountFor(t) > 0" class="my-fault-pill" :title="`${faultCountFor(t)} open fault code${faultCountFor(t) === 1 ? '' : 's'}`">{{ faultCountFor(t) }}</span>
            <span v-else class="mono" style="color:var(--text-dim);" title="No open faults">—</span>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- Detail modal -->
    <MetricInfoDialog
      :open="!!detailType"
      :title="modalTitle"
      :subtitle="modalSubtitle"
      @update:open="v => { if (!v) detailType = '' }"
    >
      <!-- Loads -->
      <template v-if="detailType === 'loads'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            The number of completed loads each truck has hauled since being added to your fleet. A load counts here once it reaches a delivered/completed status.
          </div>
          <div class="step-label">What Counts</div>
          <div class="modal-explain-sm">
            Only loads that <strong>completed delivery</strong>. Cancelled, deleted, or in-progress loads are not counted.
          </div>
          <div class="step-label">Where the Number Comes From</div>
          <div class="modal-explain-sm">
            The Job Tracking sheet, filtered to rows whose assigned driver matches one of your truck's assignment history. Excludes loads soft-deleted or with a Cancelled status (per the standard load-exclusion filter).
          </div>
        </div>
      </template>

      <!-- MPG -->
      <template v-if="detailType === 'mpg'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            Trailing 7-day fuel efficiency for each truck, expressed in miles per gallon. This is a directional figure &mdash; useful for spotting trends, but not a precise measurement.
          </div>
          <div class="step-label">How It's Computed</div>
          <div class="modal-explain-sm">
            We pull odometer readings and fuel-tank level estimates from Routemate ELD telemetry over the last 7 days. Tank capacity is assumed at 200 gallons. The result is miles driven divided by gallons inferred consumed.
          </div>
          <div class="step-label">Why It's Approximate</div>
          <div class="modal-explain-sm">
            Tank-level sensors drift, refuelling resets the baseline, and 200 gal is an industry-average assumption (actual tanks vary). For exact fuel economy, cross-check with the Fuel Analytics report which uses receipt-level data.
          </div>
          <div class="modal-callout info">
            Use this as a trend indicator: a sudden drop in MPG can flag a maintenance issue (e.g., a clogged air filter or dragging brake) before it becomes a fault code.
          </div>
        </div>
      </template>

      <!-- Faults -->
      <template v-if="detailType === 'faults'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            The count of open Diagnostic Trouble Codes (DTCs) reported by each truck's ELD. These are fault codes the engine ECM has logged but a fleet admin has not yet acknowledged.
          </div>
          <div class="step-label">Where They Come From</div>
          <div class="modal-explain-sm">
            Routemate ELD reads the truck's OBD-II / J1939 bus continuously and forwards any active fault codes to us. We store them in <code>routemate_fault_codes</code> and surface a count here.
          </div>
          <div class="step-label">How To Clear A Fault</div>
          <div class="modal-explain-sm">
            A Super Admin opens the Fleet Health page, reviews the fault, takes whatever action is needed (often: replace a part, schedule maintenance), then marks the code acknowledged. Acknowledged faults stop counting here.
          </div>
          <div class="modal-callout warning">
            A non-zero count doesn't necessarily mean the truck is down &mdash; many DTCs are advisory. But a code that stays open for more than a week deserves attention.
          </div>
        </div>
      </template>
    </MetricInfoDialog>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted } from 'vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'
import { useInvestorStore } from '../../stores/investor'
import MetricInfoDialog from './MetricInfoDialog.vue'

const props = defineProps({
  trucks: { type: Array, default: () => [] },
  production: { type: Object, default: () => ({}) },
  // When true the admin is previewing this investor's portal — hide
  // the Add Truck affordance so it can't be triggered by accident.
  isPreview: { type: Boolean, default: false },
})
const emit = defineEmits(['reload'])

// Read preview userId off the investor store so Routemate fuel/fault calls
// can be scoped to the previewed investor's trucks — true replica.
const investorStore = useInvestorStore()
function previewQs(prefix) {
  if (!investorStore.isPreview) return ''
  return `${prefix}as_user_id=${investorStore.previewUserId}`
}

function loadCountFor(t) {
  const unitKey = t.UnitNumber || t.unit_number || ''
  return (props.production?.perTruckData || {})[unitKey]?.loadCount ?? 0
}

// Per-truck 7-day MPG (telemetry-derived). The server scopes this endpoint
// to the investor's own trucks via trucks.owner_id, so we can safely fetch
// from this component without extra filtering.
const fuelByTruck = ref({})
const faultCountByTruck = ref({})
async function loadFuel() {
  try {
    const r = await useApi().get(`/api/routemate/fuel/summary?days=7${previewQs('&')}`)
    const map = {}
    for (const f of (r.trucks || [])) map[f.truckId] = f
    fuelByTruck.value = map
  } catch {
    // Silent — MPG column simply renders '—' when fuel data is unavailable.
  }
}
async function loadFaults() {
  try {
    const r = await useApi().get(`/api/routemate/fault-codes/summary${previewQs('?')}`)
    const map = {}
    for (const t of (r.trucks || [])) map[t.truckId] = t.openFaults || 0
    faultCountByTruck.value = map
  } catch {
    // Silent
  }
}
onMounted(() => { loadFuel(); loadFaults() })

function mpgFor(t) {
  const f = fuelByTruck.value[t.id]
  if (!f || f.mpgAvg == null) return '—'
  return f.mpgAvg.toFixed(1)
}
function faultCountFor(t) {
  return faultCountByTruck.value[t.id] || 0
}

const api = useApi()
const { show: toast } = useToast()
const adding = ref(false)
const form = reactive({ unitNumber: '', year: '', make: '', model: '', vin: '', licensePlate: '' })

function statusClass(s) {
  if (s === 'Active') return 'pill-green'
  if (s === 'Maintenance') return 'pill-amber'
  if (s === 'OOS') return 'pill-red'
  return 'pill-gray'
}

// --- Detail modal ---
const detailType = ref('')
function openDetail(type) { detailType.value = type }

const MODAL_CONFIG = {
  loads: { title: 'Loads', subtitle: 'How completed loads are counted per truck' },
  mpg: { title: 'MPG (7d)', subtitle: 'Trailing 7-day fuel efficiency, derived from ELD telemetry' },
  faults: { title: 'Faults', subtitle: 'Open ELD diagnostic codes per truck' },
}

const modalTitle = computed(() => MODAL_CONFIG[detailType.value]?.title || '')
const modalSubtitle = computed(() => MODAL_CONFIG[detailType.value]?.subtitle || '')

async function addTruck() {
  if (adding.value || !form.unitNumber?.trim()) return
  adding.value = true
  try {
    await api.post('/api/trucks', {
      unitNumber: form.unitNumber,
      year: form.year,
      make: form.make,
      model: form.model,
      vin: form.vin,
      licensePlate: form.licensePlate,
      status: 'Active',
    })
    toast('Truck added')
    form.unitNumber = ''; form.year = ''; form.make = ''; form.model = ''; form.vin = ''; form.licensePlate = ''
    emit('reload')
  } catch (err) {
    toast(err.message || 'Failed to add truck', 'error')
  } finally {
    adding.value = false
  }
}
</script>

<style scoped>
.section-card {
  background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border);
  padding: 1.25rem; margin-bottom: 1.25rem;
}
.section-header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
.section-title { font-size: 1rem; font-weight: 700; }
.section-count {
  font-size: 0.72rem; font-weight: 700; background: var(--accent-dim); color: var(--accent);
  padding: 0.15rem 0.5rem; border-radius: 99px;
}
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; margin-bottom: 0.75rem; }
.form-group { display: flex; flex-direction: column; gap: 0.15rem; }
.form-group label { font-size: 0.72rem; font-weight: 600; color: var(--text-dim); }
.form-group input { padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.85rem; }
.btn-add {
  padding: 0.5rem 1.25rem; background: var(--accent); color: white; border: none;
  border-radius: 8px; font-weight: 700; font-size: 0.85rem; cursor: pointer;
}
.btn-add:disabled { opacity: 0.5; }
.empty-msg { text-align: center; padding: 2rem; color: var(--text-dim); font-size: 0.88rem; }
.trucks-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
.trucks-table th {
  text-align: left; padding: 0.5rem 0.6rem; font-size: 0.68rem; font-weight: 700;
  text-transform: uppercase; color: var(--text-dim); border-bottom: 1px solid var(--border);
}
.trucks-table th.clickable-header {
  cursor: pointer; user-select: none; transition: color 0.15s ease;
}
.trucks-table th.clickable-header:hover { color: var(--accent); }
.trucks-table th.clickable-header:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px; color: var(--accent);
}
.info-marker {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--accent-dim); color: var(--accent);
  font-size: 0.6rem; font-weight: 800; font-style: normal;
  margin-left: 0.25rem; text-transform: lowercase;
}
.trucks-table td { padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--bg); }
.photo-cell { width: 52px; padding: 0.3rem 0.25rem; }
.truck-thumb {
  width: 48px; height: 36px; object-fit: cover;
  border-radius: 4px; display: block;
}
.truck-thumb-placeholder {
  width: 48px; height: 36px; border-radius: 4px;
  background: var(--bg); display: flex; align-items: center;
  justify-content: center; font-size: 1.1rem; color: var(--text-dim);
}
.mono { font-family: 'JetBrains Mono', monospace; }
.bold { font-weight: 700; }
.status-pill {
  font-size: 0.68rem; font-weight: 600; padding: 0.15rem 0.5rem; border-radius: 99px;
}
.pill-green { background: #d1fae5; color: #065f46; }
.pill-amber { background: #fef3c7; color: #92400e; }
.pill-red { background: #fee2e2; color: #991b1b; }
.pill-gray { background: #f3f4f6; color: #6b7280; }
.my-fault-pill {
  display: inline-block;
  font-size: 0.68rem; font-weight: 700;
  padding: 0.15rem 0.5rem; border-radius: 10px;
  background: #fef2f2; color: #991b1b; border: 1px solid #fecaca;
}
@media (max-width: 640px) { .form-grid { grid-template-columns: 1fr; } }
</style>
