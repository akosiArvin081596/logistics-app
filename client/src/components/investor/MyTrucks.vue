<template>
  <div class="section-card">
    <div class="section-header-row">
      <h3 class="section-title">My Trucks</h3>
      <span class="section-count">{{ trucks.length }}</span>
    </div>

    <!-- Add Truck Accordion -->
    <details class="form-accordion" style="margin-bottom:1rem;">
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
          <th>Unit #</th>
          <th>Year</th>
          <th>Make</th>
          <th>Model</th>
          <th>VIN</th>
          <th>Status</th>
          <th>Driver</th>
          <th>Loads</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in trucks" :key="t.id">
          <td class="mono bold">{{ t.UnitNumber }}</td>
          <td>{{ t.Year || '-' }}</td>
          <td>{{ t.Make || '-' }}</td>
          <td>{{ t.Model || '-' }}</td>
          <td class="mono">{{ t.VIN ? t.VIN.slice(-6) : '-' }}</td>
          <td><span :class="['status-pill', statusClass(t.Status)]">{{ t.Status }}</span></td>
          <td>{{ t.AssignedDriver || '-' }}</td>
          <td class="mono">{{ loadCountFor(t) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useApi } from '../../composables/useApi'
import { useToast } from '../../composables/useToast'

const props = defineProps({
  trucks: { type: Array, default: () => [] },
  production: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['reload'])

function loadCountFor(t) {
  const unitKey = t.UnitNumber || t.unit_number || ''
  return (props.production?.perTruckData || {})[unitKey]?.loadCount ?? 0
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
.trucks-table td { padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--bg); }
.mono { font-family: 'JetBrains Mono', monospace; }
.bold { font-weight: 700; }
.status-pill {
  font-size: 0.68rem; font-weight: 600; padding: 0.15rem 0.5rem; border-radius: 99px;
}
.pill-green { background: #d1fae5; color: #065f46; }
.pill-amber { background: #fef3c7; color: #92400e; }
.pill-red { background: #fee2e2; color: #991b1b; }
.pill-gray { background: #f3f4f6; color: #6b7280; }
@media (max-width: 640px) { .form-grid { grid-template-columns: 1fr; } }
</style>
